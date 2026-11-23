import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cameraFromSpatial,
  validatePlacement,
  facing,
  project,
  projectionReport,
} from "../web/vrm_math.js";
const spatial = JSON.parse(
  fs.readFileSync(
    new URL("../examples/spatial.synthetic.json", import.meta.url),
  ),
);
const poses = Object.fromEntries(
  fs
    .readdirSync(new URL("../poses/", import.meta.url))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(new URL(`../poses/${f}`, import.meta.url), "utf8")))
    .map((p) => [p.pose_id, p]),
);
const placement = JSON.parse(
  fs.readFileSync(new URL("../examples/placement.stand.json", import.meta.url)),
);
test("accept Sungyoon standing example, reject other units and support heights", () => {
  validatePlacement(placement, poses);
  assert.throws(() => validatePlacement({ ...placement, unit: "cm" }, poses));
  assert.throws(() => validatePlacement({ ...placement, anchor_position: [0, 0.4, 1] }, poses));
});
test("only registered pose_ids are accepted (same rule as contracts.py)", () => {
  assert.throws(
    () => validatePlacement({ ...placement, pose_id: "dance" }, poses),
    (e) => e.code === "INVALID_PLACEMENT",
  );
  assert.throws(() => validatePlacement({ ...placement, pose_id: "sit_default" }, poses));
});
test("selection is passed through like contracts.py", () => {
  assert.equal(validatePlacement(placement, poses).selection, null);
  assert.equal(validatePlacement({ ...placement, selection: "rule" }, poses).selection, "rule");
  assert.throws(() => validatePlacement({ ...placement, selection: "" }, poses));
});
test("seated placement needs a seat height inside the pose range", () => {
  const sit = JSON.parse(fs.readFileSync(new URL("../examples/placement.sample1.sit.json", import.meta.url)));
  const ok = validatePlacement(sit, poses);
  assert.equal(ok.anchor_type, "pelvis_seat_contact");
  assert.equal(ok.support_candidate_id, 2);
  assert.throws(
    () => validatePlacement({ ...sit, anchor_position: [0, 0.9, 1] }, poses),
    (e) => e.code === "SUPPORT_OUT_OF_RANGE",
  );
});
test("unknown intrinsics and right-handed geometry are rejected", () => {
  assert.throws(() =>
    cameraFromSpatial({ ...spatial, camera: { ...spatial.camera, fx: null } }),
  );
  assert.throws(() =>
    cameraFromSpatial({
      ...spatial,
      ground_plane: {
        cam_to_world: {
          R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          t: [0, 1, 0],
        },
      },
    }),
  );
});
test("camera facing is horizontal and independent of camera height", () => {
  assert.deepEqual(
    facing(placement, [0, 1.7, 0]),
    facing(placement, [0, 10, 0]),
  );
  assert.equal(facing(placement, [0, 1.7, 0])[1], 0);
});
test("optical axis reaches principal point and points behind camera are excluded", () => {
  const k = cameraFromSpatial(spatial);
  const w = k.t.map((v, i) => v + 3 * k.R[i][2]);
  const p = project(w, k);
  assert.ok(Math.abs(p[0] - k.cx) < 1e-9 && Math.abs(p[1] - k.cy) < 1e-9);
  assert.equal(
    project(
      k.t.map((v, i) => v - k.R[i][2]),
      k,
    ),
    null,
  );
});
test("out-of-frame geometry reports clipping without automatic resizing", () => {
  const k = cameraFromSpatial(spatial);
  const p = k.t.map((v, i) => v + 10 * k.R[i][0] + k.R[i][2]);
  const report = projectionReport([p], k);
  assert.equal(report.fully_in_frame, false);
  assert.equal(report.automatic_rescale, false);
});

test("geometry.v5 coordinate_contract is checked when present", async () => {
  const { originalScale } = await import("../web/vrm_math.js");
  const contract = { frame: "geometry_world", unit: "m", axes: ["right", "up", "forward"], handedness: "left",
    image_size: [spatial.image.width, spatial.image.height] };
  assert.doesNotThrow(() => cameraFromSpatial({ ...spatial, coordinate_contract: contract }));
  for (const bad of [{ handedness: "right" }, { unit: "cm" }, { axes: ["right", "up", "back"] }, { image_size: [1, 1] }])
    assert.throws(() => cameraFromSpatial({ ...spatial, coordinate_contract: { ...contract, ...bad } }), { code: "INVALID_GEOMETRY" });
  const w = spatial.image.width, h = spatial.image.height;
  assert.equal(originalScale({ ...spatial, image: { ...spatial.image, original_size: [w * 4, h * 4] } }), 4);
  assert.equal(originalScale({ ...spatial, image: { ...spatial.image, original_size: [w * 9, h * 9] },
    camera_source: { crop_xywh: [10, 20, w * 2, h * 2] } }), 2);
  assert.throws(() => originalScale(spatial), { code: "INVALID_ARGUMENT" });
  assert.throws(() => originalScale({ ...spatial, image: { ...spatial.image, original_size: [w * 2, h * 3] } }), { code: "INVALID_GEOMETRY" });
});
