import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  cameraFromSpatial,
  validatePlacement,
  facing,
  projectionReport,
} from "./vrm_math.js";

async function main() {
  const [input, spatial, settings] = await Promise.all(
    ["/placement.json", "/spatial.json", "/settings.json"].map((u) =>
      fetch(u).then((r) => r.json()),
    ),
  );
  validatePlacement(input);
  const k = cameraFromSpatial(spatial);
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(k.width, k.height);
  renderer.setClearColor(0xffffff, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa2b5, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(2, 3, 4);
  scene.add(key);
  const loader = new GLTFLoader();
  loader.register(
    (parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }),
  );
  const gltf = await loader.loadAsync("/model.vrm");
  const vrm = gltf.userData.vrm;
  if (!vrm) throw Error("No VRM humanoid was loaded");
  VRMUtils.rotateVRM0(vrm);
  const root = new THREE.Group();
  scene.add(root);
  root.add(vrm.scene);
  vrm.humanoid.resetNormalizedPose();
  // VRM normalized bones have standardized axes. Fixed stand preset, not IK.
  const a = THREE.MathUtils.degToRad(75);
  const quat = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  vrm.humanoid.setNormalizedPose({
    leftUpperArm: { rotation: quat(-a) },
    rightUpperArm: { rotation: quat(a) },
  });
  vrm.update(0);
  scene.updateMatrixWorld(true);
  const meshes = [];
  vrm.scene.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  for (const m of meshes) if (m.isSkinnedMesh) m.skeleton.update();
  function collect() {
    const rows = [];
    for (const m of meshes) {
      const p = m.geometry.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const v = new THREE.Vector3();
        m.getVertexPosition(i, v);
        v.applyMatrix4(m.matrixWorld);
        rows.push({ mesh: m, index: i, v });
      }
    }
    return rows;
  }
  const raw = collect();
  if (raw.length < 100)
    throw Error("Too few vertices for a character appearance");
  const feet = {};
  for (const side of ["left", "right"]) {
    const nodes = new Set(
      [
        vrm.humanoid.getRawBoneNode(side + "Foot"),
        vrm.humanoid.getRawBoneNode(side + "Toes"),
      ].filter(Boolean),
    );
    const verts = [];
    for (const row of raw) {
      const m = row.mesh;
      if (!m.isSkinnedMesh) continue;
      const indices = m.geometry.getAttribute("skinIndex"),
        weights = m.geometry.getAttribute("skinWeight");
      if (!indices || !weights) continue;
      let weight = 0;
      for (let j = 0; j < 4; j++) {
        if (nodes.has(m.skeleton.bones[indices.getComponent(row.index, j)]))
          weight += weights.getComponent(row.index, j);
      }
      if (weight >= 0.25) verts.push(row.v);
    }
    if (!verts.length)
      throw Error("Missing weighted " + side + " foot vertices");
    const minY = Math.min(...verts.map((v) => v.y));
    const near = verts.filter((v) => v.y <= minY + 0.012);
    const box = new THREE.Box3().setFromPoints(near);
    feet[side] = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      minY,
      (box.min.z + box.max.z) / 2,
    );
  }
  const anchor = feet.left.clone().add(feet.right).multiplyScalar(0.5);
  anchor.y = Math.min(feet.left.y, feet.right.y);
  const sourceBox = new THREE.Box3().setFromPoints(raw.map((r) => r.v));
  const sourceHeight = sourceBox.max.y - anchor.y;
  const scale = settings.height / sourceHeight;
  const dir = facing(input, k.t);
  const yaw = Math.atan2(dir[0], -dir[2]);
  root.scale.setScalar(scale);
  root.rotation.y = yaw;
  const offset = anchor
    .clone()
    .multiplyScalar(scale)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  root.position
    .set(
      input.anchor_position[0],
      input.anchor_position[1],
      -input.anchor_position[2],
    )
    .sub(offset);
  scene.updateMatrixWorld(true);
  for (const m of meshes) if (m.isSkinnedMesh) m.skeleton.update();
  const placed = collect();
  const worldPoints = placed.map((r) => [r.v.x, r.v.y, -r.v.z]);
  const localBox = new THREE.Box3().setFromPoints(
    raw.map((r) => r.v.clone().sub(anchor).multiplyScalar(scale)),
  );
  const size = localBox.getSize(new THREE.Vector3());
  const footWorld = {};
  for (const side of ["left", "right"]) {
    const v = feet[side].clone().applyMatrix4(root.matrixWorld);
    footWorld[side] = [v.x, v.y, -v.z];
  }
  const camera = new THREE.PerspectiveCamera();
  const near = 0.01,
    far = 1000;
  camera.projectionMatrix.set(
    (2 * k.fx) / k.width,
    0,
    1 - (2 * k.cx) / k.width,
    0,
    0,
    (2 * k.fy) / k.height,
    (2 * k.cy) / k.height - 1,
    0,
    0,
    0,
    -(far + near) / (far - near),
    (-2 * far * near) / (far - near),
    0,
    0,
    -1,
    0,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  const f = new THREE.Matrix4().makeScale(1, 1, -1),
    d = new THREE.Matrix4().makeScale(1, -1, -1);
  const r = new THREE.Matrix4().set(
    ...k.R[0],
    0,
    ...k.R[1],
    0,
    ...k.R[2],
    0,
    0,
    0,
    0,
    1,
  );
  const rot = f.clone().multiply(r).multiply(d);
  camera.quaternion.setFromRotationMatrix(rot).normalize();
  camera.position.set(k.t[0], k.t[1], -k.t[2]);
  camera.updateMatrixWorld(true);
  const projection = projectionReport(worldPoints, k);
  let projectionError = 0;
  for (const p of [
    [0, 0, 3],
    [0.4, 0.2, 2],
    [-0.6, -0.5, 4],
  ]) {
    const w = k.t.map(
      (v, i) => v + k.R[i].reduce((a, b, j) => a + b * p[j], 0),
    );
    const q = new THREE.Vector3(w[0], w[1], -w[2]).project(camera);
    projectionError = Math.max(
      projectionError,
      Math.abs(((q.x + 1) * k.width) / 2 - ((k.fx * p[0]) / p[2] + k.cx)),
      Math.abs(((1 - q.y) * k.height) / 2 - ((k.fy * p[1]) / p[2] + k.cy)),
    );
  }
  renderer.render(scene, camera);
  window.renderResult = {
    status: projection.fully_in_frame
      ? "rendered"
      : "rendered_with_framing_warning",
    model_id: "appearance-miku-vrm1-local-v1",
    pose_id: "stand_default",
    unit: "m",
    environment: {
      engine: "three.js WebGL",
      three_revision: THREE.REVISION,
      vrm_version: vrm.meta?.metaVersion,
    },
    target_height_m: settings.height,
    target_height_note:
      "Explicit integration setting, not finalized character design height",
    source_height_above_soles_units: sourceHeight,
    applied_uniform_scale: scale,
    source_anchor: [anchor.x, anchor.y, anchor.z],
    source_dimensions: sourceBox.getSize(new THREE.Vector3()).toArray(),
    normalized_size_m: { width: size.x, height: size.y, depth: size.z },
    normalized_local_bounds_m: {
      min: localBox.min.toArray(),
      max: localBox.max.toArray(),
    },
    local_bounds_axes:
      "model-local: +X horizontal, +Y up, +Z character front; apply placement yaw before world use",
    foot_contact_points_geometry_m: footWorld,
    anchor_position: input.anchor_position,
    anchor_type: "feet_center_on_ground",
    foot_height_difference_m: Math.abs(footWorld.left[1] - footWorld.right[1]),
    facing_direction_geometry: dir,
    projection,
    camera_projection_error_px: projectionError,
    mesh_count: meshes.length,
    vertices: raw.length,
    limitations: [
      "fixed stand preset, no new contact IK",
      "no scene occlusion, collision or light estimation",
      "appearance bounds include hair and costume",
    ],
  };
  if (projectionError > 0.01)
    throw Error("Camera projection error " + projectionError);
  window.renderReady = true;
}
main().catch((e) => {
  window.renderError = e.stack || String(e);
  console.error(e);
});
