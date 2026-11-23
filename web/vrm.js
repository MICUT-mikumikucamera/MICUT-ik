// VRM renderer page: pose + IK (vrm_pose.js), placement, calibrated camera, photo lighting and the
// three passes tools/finalize.py composites (linear premultiplied colour, planar camera depth, shadow).
// Driven headless by tools/render_vrm.mjs, which serves /job.json and receives /upload/* files.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { cameraFromSpatial, scaledCamera, facing, project, projectionReport, toLocal, LOCAL_FRAME_NOTE } from "./vrm_math.js";
import { Rig, SIDES, applyPose, bodyPenetration, footPoints, capsules, penetration, preserveCheck, restMeasure, vertexClass } from "./vrm_pose.js";
import { loadScene } from "./scene_field.js";

const arr = (v) => [v.x, v.y, v.z];
const NEAR = 0.05,
  FAR = 200;

function bounds(points) {
  const lo = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
  return { min: lo, max: hi, size: hi.map((h, i) => h - lo[i]) };
}

// Progress marks, printed by tools/render_vrm.mjs with --verbose 1, so a stalled stage is visible.
const T0 = performance.now();
function mark(what) {
  console.info(`[mark +${((performance.now() - T0) / 1000).toFixed(1)}s] ${what}`);
}

// Large files go in 16 MB parts (see the upload handler in tools/render_vrm.mjs).
const UPLOAD_PART = 16 << 20;
async function upload(name, data, shape) {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const parts = Math.max(1, Math.ceil(bytes.length / UPLOAD_PART));
  mark(`upload ${name} (${bytes.length} bytes, ${parts} parts)`);
  for (let part = 0; part < parts; part++) {
    const q = new URLSearchParams({ part, parts });
    if (shape) q.set("shape", shape.join(","));
    const body = bytes.subarray(part * UPLOAD_PART, (part + 1) * UPLOAD_PART);
    const r = await fetch(`/upload/${name}?${q}`, { method: "POST", body });
    if (!r.ok) throw Error(`upload ${name} part ${part} failed: ${r.status} ${await r.text()}`);
  }
}

// --- camera ----------------------------------------------------------------------------------------
function makeCamera(k) {
  const camera = new THREE.PerspectiveCamera();
  const n = NEAR,
    f = FAR;
  camera.projectionMatrix.set(
    (2 * k.fx) / k.width, 0, 1 - (2 * k.cx) / k.width, 0,
    0, (2 * k.fy) / k.height, (2 * k.cy) / k.height - 1, 0,
    0, 0, -(f + n) / (f - n), (-2 * f * n) / (f - n),
    0, 0, -1, 0,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  // Geometry (left-handed, Y up) -> three (right-handed): flip Z. CV camera -> three camera: flip Y, Z.
  const flip = new THREE.Matrix4().makeScale(1, 1, -1),
    cv = new THREE.Matrix4().makeScale(1, -1, -1);
  const r = new THREE.Matrix4().set(...k.R[0], 0, ...k.R[1], 0, ...k.R[2], 0, 0, 0, 0, 1);
  camera.quaternion.setFromRotationMatrix(flip.clone().multiply(r).multiply(cv)).normalize();
  camera.position.set(k.t[0], k.t[1], -k.t[2]);
  camera.updateMatrixWorld(true);
  return camera;
}

function projectionError(camera, k) {
  let err = 0;
  for (const p of [[0, 0, 3], [0.4, 0.2, 2], [-0.6, -0.5, 4]]) {
    const w = k.t.map((v, i) => v + k.R[i].reduce((a, b, j) => a + b * p[j], 0));
    const q = new THREE.Vector3(w[0], w[1], -w[2]).project(camera);
    err = Math.max(
      err,
      Math.abs(((q.x + 1) * k.width) / 2 - ((k.fx * p[0]) / p[2] + k.cx)),
      Math.abs(((1 - q.y) * k.height) / 2 - ((k.fy * p[1]) / p[2] + k.cy)),
    );
  }
  return err;
}

// --- photo lighting --------------------------------------------------------------------------------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function boxBlur(a, w, h, r, axis, wrap = false) {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0,
          n = 0;
        for (let d = -r; d <= r; d++) {
          let xx = x,
            yy = y;
          if (axis === 1) {
            xx = x + d;
            if (wrap) xx = (xx + w) % w;
            else if (xx < 0 || xx >= w) continue;
          } else {
            yy = y + d;
            if (yy < 0 || yy >= h) continue;
          }
          s += a[(yy * w + xx) * 3 + c];
          n++;
        }
        out[(y * w + x) * 3 + c] = s / n;
      }
  return out;
}

async function loadPhotoSmall(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const sw = 64,
    sh = Math.max(1, Math.round((img.height * sw) / img.width));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, sw, sh);
  const px = g.getImageData(0, 0, sw, sh).data;
  let a = new Float32Array(sw * sh * 3);
  for (let i = 0; i < sw * sh; i++) for (let ch = 0; ch < 3; ch++) a[i * 3 + ch] = toLinear(px[i * 4 + ch] / 255);
  a = boxBlur(boxBlur(a, sw, sh, 2, 0), sw, sh, 2, 1);
  return { a, sw, sh };
}

// Same idea as blender_adapter.photo_lighting (seen directions = blurred photo, unseen = band means),
// plus a split into one directional key light (casts the shadow) and the remaining environment.
async function photoLighting(k, settings) {
  const { a: small, sw, sh } = await loadPhotoSmall("/photo.jpg");
  const band = Math.max(1, Math.floor(sh / 6));
  const meanOf = (r0, r1) => {
    const m = [0, 0, 0];
    for (let y = r0; y < r1; y++) for (let x = 0; x < sw; x++) for (let c = 0; c < 3; c++) m[c] += small[(y * sw + x) * 3 + c];
    return m.map((v) => v / ((r1 - r0) * sw));
  };
  const top = meanOf(0, band),
    bottom = meanOf(sh - band, sh),
    mean = meanOf(0, sh);
  const W = 256,
    H = 128,
    gain = settings.ceiling_gain,
    exposure = settings.exposure;
  let env = new Float32Array(W * H * 3);
  const R = k.R;
  let seenCount = 0;
  // three.js equirect: u = atan2(d.z, d.x)/2pi + 0.5, v = asin(d.y)/pi + 0.5, row 0 = v 0 (straight down).
  const dirOf = (i, j) => {
    const az = ((i + 0.5) / W - 0.5) * 2 * Math.PI,
      el = ((j + 0.5) / H - 0.5) * Math.PI;
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az), el];
  };
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const [x, y, z, el] = dirOf(i, j);
      const g = [x, y, -z]; // three -> geometry
      const c = [0, 1, 2].map((col) => R[0][col] * g[0] + R[1][col] * g[1] + R[2][col] * g[2]); // R^T g
      let rgb = el > (25 * Math.PI) / 180 ? top.map((v) => v * gain) : el < (-15 * Math.PI) / 180 ? bottom : mean;
      if (c[2] > 0) {
        const u = (k.fx * c[0]) / c[2] + k.cx,
          v = (k.fy * c[1]) / c[2] + k.cy;
        if (u >= 0 && u < k.width && v >= 0 && v < k.height) {
          const ui = Math.min(sw - 1, Math.floor((u / k.width) * sw)),
            vi = Math.min(sh - 1, Math.floor((v / k.height) * sh));
          rgb = [0, 1, 2].map((ch) => small[(vi * sw + ui) * 3 + ch]);
          seenCount++;
        }
      }
      for (let ch = 0; ch < 3; ch++) env[(j * W + i) * 3 + ch] = rgb[ch];
    }
  for (let it = 0; it < 3; it++) env = boxBlur(boxBlur(env, W, H, 6, 1, true), W, H, 4, 0);
  for (let i = 0; i < env.length; i++) env[i] *= exposure;

  // Irradiance on the floor (up-facing) from the upper hemisphere, and the brightest upper direction.
  const dOmega = (j) => Math.cos(((j + 0.5) / H - 0.5) * Math.PI) * ((2 * Math.PI) / W) * (Math.PI / H);
  let floorE = 0,
    peak = -1,
    peakL = -1;
  const upperL = [];
  for (let j = H / 2; j < H; j++)
    for (let i = 0; i < W; i++) {
      const p = (j * W + i) * 3;
      const L = lum(env[p], env[p + 1], env[p + 2]);
      const el = dirOf(i, j)[3];
      floorE += L * Math.sin(el) * dOmega(j);
      upperL.push(L);
      if (el > (10 * Math.PI) / 180 && L > peakL) [peakL, peak] = [L, p / 3];
    }
  upperL.sort((x, y) => x - y);
  const median = upperL[Math.floor(upperL.length / 2)];
  // Key from the photo: radiance above the upper-hemisphere median within 35 degrees of the peak.
  const pd = dirOf(peak % W, Math.floor(peak / W));
  const peakDir = new THREE.Vector3(pd[0], pd[1], pd[2]);
  const cos35 = Math.cos((35 * Math.PI) / 180);
  let keyE = 0;
  const keyRGB = [0, 0, 0];
  const keyEnv = new Float32Array(env);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const d = dirOf(i, j);
      if (new THREE.Vector3(d[0], d[1], d[2]).dot(peakDir) < cos35) continue;
      const p = (j * W + i) * 3;
      const L = lum(env[p], env[p + 1], env[p + 2]);
      const excess = L - median;
      if (excess <= 0) continue;
      const f = excess / L;
      for (let ch = 0; ch < 3; ch++) {
        keyRGB[ch] += env[p + ch] * f * dOmega(j);
        keyEnv[p + ch] = env[p + ch] * (1 - f);
      }
      keyE += excess * dOmega(j);
    }
  let key = { source: "photo_peak", dir: peakDir, irradiance: keyE, rgb: keyRGB };
  let keyFloorShare = (keyE * Math.max(peakDir.y, 0)) / floorE;
  let finalEnv = keyEnv;
  if (keyFloorShare < settings.key_share_min) {
    // No usable bright spot seen (typical indoors: the lamps are above the frame). Use an overhead key,
    // slightly toward the camera so the shadow falls behind the character, taking energy evenly from env.
    const share = settings.key_share_min;
    const el = (60 * Math.PI) / 180;
    const toCam = new THREE.Vector3(k.t[0] - settings.anchor[0], 0, -(k.t[2] - settings.anchor[2])).normalize();
    const dir = toCam.applyAxisAngle(new THREE.Vector3(0, 1, 0), (25 * Math.PI) / 180).multiplyScalar(Math.cos(el));
    dir.y = Math.sin(el);
    finalEnv = new Float32Array(env);
    for (let i = 0; i < finalEnv.length; i++) finalEnv[i] *= 1 - share;
    const E = (share * floorE) / Math.sin(el);
    const m = lum(...top) || 1;
    key = { source: "default_overhead", dir: dir.normalize(), irradiance: E, rgb: top.map((c) => (c / m) * E) };
    keyFloorShare = share;
  }
  // Remaining environment irradiance on the floor, split into sky cells for the soft (occlusion) shadow.
  const rings = [[10, 30, 8], [30, 60, 8], [60, 90, 4]];
  const cells = [];
  let envFloorE = 0;
  for (const [lo, hi, n] of rings)
    for (let c = 0; c < n; c++) cells.push({ lo, hi, a0: (c / n) * 2 * Math.PI - Math.PI, a1: ((c + 1) / n) * 2 * Math.PI - Math.PI, E: 0, d: new THREE.Vector3(), texels: [] });
  for (let j = H / 2; j < H; j++)
    for (let i = 0; i < W; i++) {
      const d = dirOf(i, j);
      const p = (j * W + i) * 3;
      const e = lum(finalEnv[p], finalEnv[p + 1], finalEnv[p + 2]) * Math.sin(d[3]) * dOmega(j);
      envFloorE += e;
      const elDeg = (d[3] * 180) / Math.PI,
        az = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      const cell = cells.find((c) => elDeg >= c.lo && elDeg < c.hi && az >= c.a0 && az < c.a1);
      if (!cell) continue;
      cell.E += e;
      cell.d.add(new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(e));
      cell.texels.push([d, e]);
    }
  const totalFloor = envFloorE + key.irradiance * Math.max(key.dir.y, 0);
  // A few energy-weighted directions per cell (fixed seed): one direction per cell gives a star of
  // hard-edged copies; several jittered ones blur into a soft occlusion shadow.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sky = [];
  for (const c of cells.filter((c) => c.E > 0)) {
    const n = settings.sky_samples;
    for (let s = 0; s < n; s++) {
      let r = ((s + rand()) / n) * c.E;
      const t = c.texels.find(([, e]) => (r -= e) <= 0) || c.texels[c.texels.length - 1];
      sky.push({ dir: new THREE.Vector3(t[0][0], t[0][1], t[0][2]), share: c.E / n / totalFloor });
    }
  }
  keyFloorShare = (key.irradiance * Math.max(key.dir.y, 0)) / totalFloor;

  const half = new Uint16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let ch = 0; ch < 3; ch++) half[i * 4 + ch] = THREE.DataUtils.toHalfFloat(finalEnv[i * 3 + ch]);
    half[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return {
    envTexture: tex,
    key,
    keyFloorShare,
    sky,
    floorRGB: bottom,
    report: {
      method: "photo environment (seen directions = blurred photo, unseen = band means) split into a key light and environment",
      exposure,
      ceiling_gain: gain,
      mean_linear_rgb: mean.map(r4),
      top_linear_rgb: top.map(r4),
      bottom_linear_rgb: bottom.map(r4),
      seen_fraction_of_sphere: r4(seenCount / (W * H)),
      key_light: {
        source: key.source,
        direction_geometry: [key.dir.x, key.dir.y, -key.dir.z].map(r4),
        elevation_deg: r4((Math.asin(key.dir.y) * 180) / Math.PI),
        floor_irradiance_share: r4(keyFloorShare),
      },
      sky_shadow_cells: cells.filter((c) => c.E > 0).length,
      sky_shadow_directions: sky.length,
      sky_floor_irradiance_share: r4(sky.reduce((a, s) => a + s.share, 0)),
    },
  };
}

// --- passes --------------------------------------------------------------------------------------
function readRT(renderer, rt) {
  const n = rt.width * rt.height * 4;
  if (rt.texture.type === THREE.HalfFloatType) {
    const half = new Uint16Array(n);
    renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, half);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = THREE.DataUtils.fromHalfFloat(half[i]);
    return out;
  }
  const out = new Float32Array(n);
  renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, out);
  return out;
}

// GL rows are bottom-up; output rows top-down. mode: mean (colour, shadow) or min (depth).
function downsample(src, W, H, C, ss, mode, channels = C) {
  const w = W / ss,
    h = H / ss;
  const out = new Float32Array(w * h * channels);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < channels; c++) {
        let v = mode === "min" ? Infinity : 0;
        for (let dy = 0; dy < ss; dy++)
          for (let dx = 0; dx < ss; dx++) {
            const s = src[((y * ss + dy) * W + x * ss + dx) * C + c];
            v = mode === "min" ? Math.min(v, s) : v + s;
          }
        if (mode !== "min") v /= ss * ss;
        out[((h - 1 - y) * w + x) * channels + c] = v;
      }
  return out;
}

const depthMaterial = (tDepth) =>
  new THREE.ShaderMaterial({
    uniforms: { tDepth: { value: tDepth } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `uniform sampler2D tDepth; varying vec2 vUv;
      void main(){
        float d = texture2D(tDepth, vUv).x;
        float n = ${NEAR.toFixed(4)}, f = ${FAR.toFixed(1)};
        float z = d >= 1.0 ? 1e10 : 2.0*n*f/((f+n) - (d*2.0-1.0)*(f-n));
        gl_FragColor = vec4(z, z, z, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });

// --- regions and tiles -----------------------------------------------------------------------------
// Passes cover only the pixels the character (colour, depth) or its catcher planes (shadow) can touch,
// rendered in tiles of at most `tileLimit` render pixels a side. Memory and GPU limits then depend on how
// big Miku is on screen, not on the photo resolution, and the supersampling factor never has to drop.
const TILE = 2048; // fits every WebGL2 device, phones included
const SKY_MAX = 512; // soft sky shadows: region long side at most this, upsampled bilinearly (same look at any photo size)
let tileLimit = TILE;

const cropCamera = (k, r) => ({ ...k, cx: k.cx - r.x, cy: k.cy - r.y, width: r.width, height: r.height });
const EMPTY = { x: 0, y: 0, width: 1, height: 1 }; // nothing visible: one transparent pixel

function clampRegion(x0, y0, x1, y1, k, pad) {
  const r = {
    x: Math.max(0, Math.floor(x0 - pad)), y: Math.max(0, Math.floor(y0 - pad)),
    x1: Math.min(k.width, Math.ceil(x1 + pad)), y1: Math.min(k.height, Math.ceil(y1 + pad)),
  };
  return r.x1 > r.x && r.y1 > r.y ? { x: r.x, y: r.y, width: r.x1 - r.x, height: r.y1 - r.y } : { ...EMPTY };
}

// Pixel box of geometry-world points; the whole frame if any point is behind the camera.
function pixelRegion(points, k, pad, padFraction) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    const q = project(p, k);
    if (!q || q[2] <= NEAR) return { x: 0, y: 0, width: k.width, height: k.height };
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
  }
  return clampRegion(x0, y0, x1, y1, k, pad + padFraction * Math.max(x1 - x0, y1 - y0));
}

// Pixel box of a convex planar polygon (geometry world), clipped to the part in front of the camera.
function polygonRegion(poly, k, pad) {
  const zmin = NEAR * 2;
  const camZ = (p) => k.R.reduce((a, row, j) => a + row[2] * (p[j] - k.t[j]), 0);
  const kept = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const za = camZ(a), zb = camZ(b);
    if (za >= zmin) kept.push(a);
    if ((za >= zmin) !== (zb >= zmin)) {
      const s = (zmin - za) / (zb - za);
      kept.push(a.map((v, j) => v + s * (b[j] - v)));
    }
  }
  if (!kept.length) return { ...EMPTY };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of kept) {
    const q = project(p, k);
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
  }
  return clampRegion(x0, y0, x1, y1, k, pad);
}

function unionRegion(rs) {
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width)), y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Render `region` of camera k in tiles. renderTile(camera, W, H) returns one bottom-up RGBA Float32Array
// per entry of `outputs` ({channels, mode}); each is box-downsampled by ss and stitched top-down.
function tiled(k, region, ss, outputs, renderTile) {
  const bufs = outputs.map((o) => new Float32Array(region.width * region.height * o.channels));
  const step = Math.max(1, Math.floor(tileLimit / ss));
  for (let ty = 0; ty < region.height; ty += step)
    for (let tx = 0; tx < region.width; tx += step) {
      const tile = { x: region.x + tx, y: region.y + ty, width: Math.min(step, region.width - tx), height: Math.min(step, region.height - ty) };
      const W = tile.width * ss,
        H = tile.height * ss;
      const raw = renderTile(makeCamera(cropCamera(k, tile)), W, H);
      outputs.forEach((o, i) => {
        const small = downsample(raw[i], W, H, 4, ss, o.mode, o.channels);
        const row = tile.width * o.channels;
        for (let y = 0; y < tile.height; y++)
          bufs[i].set(small.subarray(y * row, (y + 1) * row), ((ty + y) * region.width + tx) * o.channels);
      });
    }
  return bufs;
}

// Pixel-centre aligned bilinear resize of a one-channel image (same rule as finalize.resize_bilinear).
function upsample(src, sw, sh, w, h) {
  if (sw === w && sh === h) return src;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max(((y + 0.5) * sh) / h - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max(((x + 0.5) * sw) / w - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, sw - 1), wx = fx - x0;
      const top = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx;
      const bottom = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx;
      out[y * w + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

// Largest alpha on the colour region's border, ignoring sides on the frame edge. Non-zero means the
// region missed part of the character (it must be 0).
function regionEdgeAlpha(colour, r, k) {
  let m = 0;
  const a = (x, y) => colour[(y * r.width + x) * 4 + 3];
  for (let x = 0; x < r.width; x++) {
    if (r.y > 0) m = Math.max(m, a(x, 0));
    if (r.y + r.height < k.height) m = Math.max(m, a(x, r.height - 1));
  }
  for (let y = 0; y < r.height; y++) {
    if (r.x > 0) m = Math.max(m, a(0, y));
    if (r.x + r.width < k.width) m = Math.max(m, a(r.width - 1, y));
  }
  return m;
}

function scenePenetration(rig, verts, inside, tol, scale) {
  const counts = {}, objects = {};
  let deepest = 0;
  verts.forEach((v, i) => {
    const { gap, id } = inside(v);
    if (gap <= tol) return;
    const c = vertexClass(rig, i);
    const cls = c === "hair" || c === "head_hair" || c === "skirt" ? c : "body";
    counts[cls] = (counts[cls] || 0) + 1;
    objects[id] = (objects[id] || 0) + 1;
    deepest = Math.max(deepest, gap);
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { status: total >= 50 ? "fail" : "pass", vertices: counts, deepest_m: deepest * scale, by_object_id: objects };
}

function workshopDump(rig, meshes, planes, pose) {
  const bones = [];
  rig.root.traverse((o) => {
    if (o.isBone) bones.push({ name: o.name, position: o.position.toArray(), rotation: o.quaternion.toArray(), scale: o.scale.toArray() });
  });
  const lift = new THREE.Vector3(0, -planes.floor_src, 0).applyQuaternion(rig.root.quaternion);
  return {
    name: `${pose.pose_id} (dumped from the IK renderer)`,
    root_transform: {
      position: rig.root.position.clone().add(lift).toArray(),
      rotation: rig.root.quaternion.toArray(),
      scale: rig.root.scale.toArray(),
    },
    raw_bone_transforms: bones,
    mesh_morphs: meshes.map((m) => ({
      mesh: m.name,
      weights: Object.fromEntries(Object.entries(m.morphTargetDictionary || {}).map(([k, i]) => [k, m.morphTargetInfluences[i]])),
    })),
    status: "dumped",
    notices: [],
    seat_height_in_dump_m: planes.seat_src !== undefined ? (planes.seat_src - planes.floor_src) * rig.unitScale : null,
  };
}

async function main() {
  const started = performance.now();
  const job = await (await fetch("/job.json")).json();
  const { placement, spatial, profile, pose, settings } = job;
  const k = cameraFromSpatial(spatial);
  const rk = scaledCamera(k, settings.render_scale);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(64, 64); // every pass renders into tile render targets
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const gl = renderer.getContext();
  tileLimit = Math.min(TILE, renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const ss = Math.min(settings.supersample, tileLimit);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false }));
  const gltf = await loader.loadAsync("/model.vrm");
  const vrm = gltf.userData.vrm;
  if (!vrm) throw Error("No VRM humanoid was loaded");
  VRMUtils.rotateVRM0(vrm);
  // vrm.update() is never called: spring bones, the expression manager and normalized bones would
  // overwrite the raw-bone pose and morph weights set below.
  const placementRoot = new THREE.Group();
  placementRoot.matrixAutoUpdate = false;
  scene.add(placementRoot);
  placementRoot.add(vrm.scene);
  const meshes = [];
  vrm.scene.traverse((o) => {
    if (o.isMesh) {
      meshes.push(o);
      o.frustumCulled = false; // bounds are from the bind pose, not the posed mesh
      o.castShadow = o.receiveShadow = true;
    }
  });

  // three-vrm freezes spring-bone joints (twin tails, necktie: matrixAutoUpdate = false) for its own
  // physics. vrm.update() never runs here, so unfreeze them: otherwise pose steps, preset raw-bone
  // transforms and the hair clean-up below silently leave those bones at rest.
  vrm.scene.traverse((o) => {
    if (o.isBone) o.matrixAutoUpdate = true;
  });
  const rig = new Rig(vrm.scene, meshes, profile);
  rig.captureRest();
  const rest = restMeasure(rig);
  const scale = settings.height / rest.height;
  const direction = facing(placement, k.t);
  const yaw = Math.atan2(direction[0], -direction[2]);
  const anchor = placement.anchor_position;
  const anchor3 = new THREE.Vector3(anchor[0], anchor[1], -anchor[2]);
  const rootMatrix = (src) =>
    new THREE.Matrix4()
      .makeTranslation(anchor3.x, anchor3.y, anchor3.z)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
      .multiply(new THREE.Matrix4().makeTranslation(-src.x, -src.y, -src.z));
  const cam3 = new THREE.Vector3(k.t[0], k.t[1], -k.t[2]);
  const cameraSrcOf = (src) => cam3.clone().applyMatrix4(rootMatrix(src).invert());
  // Photo obstacles (geometry.v5 depth + object masks): sceneOf(anchorSrc)(rig point) -> {gap, id}, gap
  // in rig units (> 0: inside a nearby object), for the hair clean-up and the scene penetration report.
  const sceneAt = settings.scene ? await loadScene(settings.scene, k) : null;
  const sceneOf = sceneAt
    ? (src) => {
        const m = rootMatrix(src);
        return (v) => {
          const w = v.clone().applyMatrix4(m);
          const r = sceneAt([w.x, w.y, -w.z]);
          return { gap: r.gap / scale, id: r.id };
        };
      }
    : null;
  if (sceneAt) mark("scene obstacles loaded");

  const { anchorSrc, report: poseReport, support, planes } = applyPose(rig, pose, scale, rest, anchor[1], cameraSrcOf, sceneOf, placement.preserve || []);
  // Check/dev option (--dump-pose 1): the posed rig in the preset-workshop export format (raw bones in the
  // workshop frame, floor y=0), so an own-engine pose can be fed back as a pose_ref or a preset.
  const poseDump = settings.dump_pose ? workshopDump(rig, meshes, planes, pose) : null;
  const vertsSrc = rig.vertices();
  const feetSrc = footPoints(rig, vertsSrc);
  const proxies = capsules(rig, vertsSrc);
  const [penCounts, penDepth, penGroups] = penetration(rig, vertsSrc, support, 0.005 / scale);
  const bodyPen = bodyPenetration(rig, vertsSrc, 0.01 / scale, 0.04 / scale);
  const scenePen = sceneOf
    ? scenePenetration(rig, vertsSrc, sceneOf(anchorSrc), 0.01 / scale, scale)
    : { status: "not_run", reason: settings.scene_reason || "no scene obstacles" };
  const preserveResult = preserveCheck(rig, placement.preserve);
  for (const v of Object.values(bodyPen)) v.deepest_m = v.deepest * scale, delete v.deepest;
  mark("contacts measured");
  const total = rootMatrix(anchorSrc);
  placementRoot.matrix.copy(total);
  scene.updateMatrixWorld(true);
  const poseSeconds = (performance.now() - started) / 1000;

  const toGeo = (v) => {
    const w = v.clone().applyMatrix4(total);
    return [w.x, w.y, -w.z];
  };
  const worldPoints = vertsSrc.map(toGeo);
  const localBounds = bounds(worldPoints.map((p) => toLocal(p, anchor, direction)));
  const footWorld = Object.fromEntries(SIDES.map((s) => [s, toGeo(feetSrc[s])]));
  const seated = placement.anchor_type === "pelvis_seat_contact";
  const proxyOut = {};
  for (const [name, c] of Object.entries(proxies)) {
    const a = toGeo(c.a),
      b = toGeo(c.b);
    proxyOut[name] = {
      a_local: toLocal(a, anchor, direction), b_local: toLocal(b, anchor, direction), radius_m: c.radius * scale,
      a_world: a, b_world: b, source_vertices: c.vertices,
    };
  }
  const manifest = {
    model_id: settings.model_id, unit: "m", pose_id: placement.pose_id, action: placement.action,
    source_dimensions_units: rest.dimensions, source_height_above_soles_units: rest.height,
    target_height_m: settings.height, target_height_note: profile.target_height_note,
    applied_uniform_scale: scale, source_anchor_units: arr(anchorSrc),
    anchor_type: placement.anchor_type, anchor_position: anchor,
    facing_direction_geometry: direction, three_yaw_rad: yaw,
    local_frame: LOCAL_FRAME_NOTE,
    normalized_local_bounds_m: localBounds,
    normalized_size_m: { width: localBounds.size[0], height: localBounds.size[1], depth: localBounds.size[2] },
    world_bounds_geometry_m: bounds(worldPoints),
    foot_contact_points_geometry_m: footWorld,
    foot_height_difference_m: Math.abs(footWorld.left[1] - footWorld.right[1]),
    foot_anchor_method: "midpoint of weighted left/right near-sole bounds; lower sole is ground",
    support: { type: seated ? "seat" : "floor", height_m: anchor[1], support_candidate_id: placement.support_candidate_id },
    selection: placement.selection,
    contacts: {
      anchor: { type: placement.anchor_type, local: [0, 0, 0], world: anchor },
      feet: Object.fromEntries(SIDES.map((s) => [s, {
        world: footWorld[s], local: toLocal(footWorld[s], anchor, direction), floor_gap_m: footWorld[s][1],
      }])),
    },
    includes: "all mesh vertices, including hair, costume and hands",
    body_collision_proxy: {
      type: "capsules", frame: "local and geometry world",
      radius_rule: "85th percentile distance of segment-weighted vertices",
      excludes: "hair, skirt, sleeves and accessories (not in proxy vertex groups)",
      segments: proxyOut,
    },
    pose_report: poseReport,
    penetration_below_support: {
      vertices: penCounts, deepest_m: penDepth * scale, by_group: penGroups,
      note: "support = floor, plus the seat plane inside +-seat_half_extent_m of the anchor for seated poses",
    },
    penetration_scene: scenePen.status === "not_run"
      ? scenePen
      : { ...scenePen, note: "vertices behind a visible photo surface (geometry depth) by 1 cm..thickness: 0.30 m for the " +
          "supporting object, 0.06 m for others; floor excluded. status fail = 50 vertices or more" },
    checks: {
      preserve: preserveResult,
      penetration_scene: { status: scenePen.status, ...(scenePen.reason ? { reason: scenePen.reason } : {}) },
    },
    penetration_body: {
      ...bodyPen,
      note: "intruder vertices more than 1 cm inside the nearest host vertex (posed normal side, within 4 cm); " +
        "twin-tail hair vs body/skirt/arms, forearm+hand vs body/skirt/other arm, arms+hands vs face and bangs/side locks, " +
        "left shin+foot vs right leg",
    },
    three_root_matrix: total.elements,
  };

  // --- camera, lights ---
  const camera = makeCamera(rk);
  const camErr = projectionError(camera, rk);
  if (camErr > 0.01) throw Error("Camera projection error " + camErr);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(4096, 4096);
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.normalBias = 0.02;
  const sc = keyLight.shadow.camera;
  [sc.left, sc.right, sc.bottom, sc.top, sc.near, sc.far] = [-1.1, 1.1, -1.1, 1.1, 0.1, 20];
  sc.updateProjectionMatrix();
  keyLight.shadow.radius = 3;
  const centre = anchor3.clone().add(new THREE.Vector3(0, seated ? 0.3 : 0.8, 0));
  keyLight.target.position.copy(centre);
  scene.add(keyLight, keyLight.target);
  const pointLight = (dir) => {
    keyLight.position.copy(centre).addScaledVector(dir, 8);
    keyLight.updateMatrixWorld(true);
    keyLight.target.updateMatrixWorld(true);
  };
  let light = null;
  if (settings.photo) {
    light = await photoLighting(k, { ...settings, anchor });
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(light.envTexture).texture;
    const kr = light.key.rgb;
    const kl = Math.max(...kr, 1e-6);
    keyLight.color.setRGB(kr[0] / kl, kr[1] / kl, kr[2] / kl, THREE.LinearSRGBColorSpace);
    keyLight.intensity = light.key.irradiance * (kl / Math.max(lum(...kr), 1e-6));
    pointLight(light.key.dir);
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa2b5, 2.2));
    keyLight.intensity = 2.5;
    pointLight(new THREE.Vector3(2, 3, 4).normalize());
  }

  // --- regions: passes cover only the pixels the character or its catcher planes can touch ---
  const longSide = (r) => Math.max(r.width, r.height);
  const frame = { x: 0, y: 0, width: rk.width, height: rk.height };
  const charRegion = settings.full_frame_regions ? frame : pixelRegion(worldPoints, rk, 4, 0.02);
  const floorHalf = 1.5;
  // Axis-aligned bound of each catcher square (the seat square turns with the body: use its circumscribed box).
  const square = (c, half, y) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c[0] + a * half, y, c[2] + b * half]);
  const catcherPolys = [square(anchor, floorHalf, 0)];
  if (seated) catcherPolys.push(square(anchor, (profile.seat_half_extent_m ?? 0.25) * Math.SQRT2, anchor[1] + 0.001));
  const shadowRegion = !settings.photo ? null
    : settings.full_frame_regions ? frame : unionRegion(catcherPolys.map((p) => polygonRegion(p, rk, 2)));
  mark(`regions colour ${JSON.stringify(charRegion)} shadow ${JSON.stringify(shadowRegion)}`);

  // --- colour + depth pass (character only, layer 0), tiled ---
  const t0 = performance.now();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const [colour, depth] = tiled(rk, charRegion, ss, [{ channels: 4, mode: "mean" }, { channels: 1, mode: "min" }], (cam, W, H) => {
    const depthTex = new THREE.DepthTexture(W, H, THREE.FloatType);
    // Half float: blending into 32-bit float targets needs EXT_float_blend, which phones may lack.
    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture: depthTex, depthBuffer: true });
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    const c = readRT(renderer, rt);
    const zrt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
    quad.material = depthMaterial(depthTex);
    renderer.setRenderTarget(zrt);
    renderer.render(quadScene, new THREE.OrthographicCamera());
    const z = readRT(renderer, zrt);
    quad.material.dispose();
    rt.dispose();
    depthTex.dispose();
    zrt.dispose();
    return [c, z];
  });
  mark("colour + depth done");
  const edgeAlpha = regionEdgeAlpha(colour, charRegion, rk);

  // --- shadow pass: catcher planes (layer 2), one shadow map per light direction, accumulated ---
  let shadow = null,
    catchers = [],
    skyCamera = null;
  if (light) {
    const mat = new THREE.ShadowMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: true });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * floorHalf, 2 * floorHalf), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(anchor3.x, 0, anchor3.z);
    floor.receiveShadow = true;
    floor.layers.set(2);
    scene.add(floor);
    catchers.push("floor");
    if (seated) {
      const half = profile.seat_half_extent_m ?? 0.25;
      const seat = new THREE.Mesh(new THREE.PlaneGeometry(2 * half, 2 * half), mat);
      seat.rotation.set(-Math.PI / 2, yaw, 0, "YXZ");
      seat.position.set(anchor3.x, anchor[1] + 0.001, anchor3.z);
      seat.receiveShadow = true;
      seat.layers.set(2);
      scene.add(seat);
      catchers.push("seat");
    }
    scene.updateMatrixWorld(true);
    // three.js culls shadow casters by the *main* camera's layers, so the character stays visible to the
    // camera but writes neither colour nor depth in this pass; only the catcher planes (layer 2) draw.
    const charMaterials = new Set(meshes.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material])));
    // The pose is fixed, so skin once: static copies (CPU-skinned positions, morphs applied, same materials,
    // so alpha-tested hair casts the same shadow) replace the skinned meshes for the ~80 shadow-map renders.
    const casters = meshes.map((m) => {
      const src = m.geometry;
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(src.attributes)) if (!["skinIndex", "skinWeight"].includes(name)) g.setAttribute(name, attr);
      if (src.index) g.setIndex(src.index);
      for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
      const pos = new Float32Array(src.getAttribute("position").count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.length / 3; i++) {
        m.getVertexPosition(i, v); // morphed and skinned, in mesh space (three applies bindMatrixInverse)
        pos.set([v.x, v.y, v.z], i * 3);
      }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const c = new THREE.Mesh(g, m.material);
      c.matrixAutoUpdate = false;
      c.matrix.copy(m.matrixWorld);
      c.matrixWorld.copy(m.matrixWorld);
      c.castShadow = true;
      c.frustumCulled = false;
      c.renderOrder = m.renderOrder;
      return c;
    });
    const casterRoot = new THREE.Group();
    casterRoot.matrixAutoUpdate = false;
    casterRoot.matrixWorldAutoUpdate = false;
    casterRoot.add(...casters);
    scene.add(casterRoot);
    for (const m of meshes) m.visible = false;
    const saved = [...charMaterials].map((m) => [m, m.colorWrite, m.depthWrite]);
    for (const m of charMaterials) [m.colorWrite, m.depthWrite] = [false, false];
    const accumulate = (lights, lamp) => (cam, W, H) => {
      cam.layers.enable(2);
      const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.autoClear = false;
      for (const { dir, share } of lights) {
        if (share < 1e-4) continue;
        lamp(dir);
        mat.opacity = share;
        renderer.clearDepth();
        renderer.render(scene, cam);
      }
      renderer.autoClear = true;
      const acc = readRT(renderer, target);
      target.dispose();
      return [acc];
    };
    // Key: sharp, full resolution with supersampling. Sky: many soft directions, so a small shadow map and
    // a region of at most SKY_MAX pixels, upsampled bilinearly.
    const [keyAcc] = tiled(rk, shadowRegion, ss, [{ channels: 1, mode: "mean" }],
      accumulate([{ dir: light.key.dir, share: light.keyFloorShare }], pointLight));
    mark("key shadow done");
    const skyLight = new THREE.DirectionalLight(0xffffff, 0);
    skyLight.castShadow = true;
    skyLight.shadow.mapSize.set(1024, 1024);
    skyLight.shadow.radius = 2;
    skyLight.shadow.bias = -0.001;
    Object.assign(skyLight.shadow.camera, { left: -1.1, right: 1.1, bottom: -1.1, top: 1.1, near: 0.1, far: 20 });
    skyLight.shadow.camera.updateProjectionMatrix();
    skyLight.target.position.copy(centre);
    scene.add(skyLight, skyLight.target);
    keyLight.castShadow = false;
    skyCamera = scaledCamera(cropCamera(rk, shadowRegion), Math.min(1, SKY_MAX / longSide(shadowRegion)));
    const [skyLow] = tiled(skyCamera, { x: 0, y: 0, width: skyCamera.width, height: skyCamera.height }, 1, [{ channels: 1, mode: "mean" }],
      accumulate(light.sky, (dir) => {
        skyLight.position.copy(centre).addScaledVector(dir, 8);
        skyLight.updateMatrixWorld(true);
        skyLight.target.updateMatrixWorld(true);
      }));
    const skyAcc = upsample(skyLow, skyCamera.width, skyCamera.height, shadowRegion.width, shadowRegion.height);
    mark("sky shadow done");
    scene.remove(skyLight, skyLight.target);
    keyLight.castShadow = true;
    for (const [m, c, d] of saved) [m.colorWrite, m.depthWrite] = [c, d];
    for (const m of meshes) m.visible = true;
    scene.remove(casterRoot);
    for (const c of casters) c.geometry.dispose();
    pointLight(light.key.dir);
    shadow = keyAcc.map((v, i) => Math.min(1, Math.max(0, 1 - v - skyAcc[i])));
  }
  const renderSeconds = (performance.now() - t0) / 1000;

  // --- outputs (region crops; tools/finalize.py places them with report.pass_regions) ---
  const w = charRegion.width,
    h = charRegion.height;
  await upload("pass_combined.npy", colour, [h, w, 4]);
  await upload("pass_depth.npy", depth, [h, w]);
  if (shadow) await upload("pass_shadow.npy", shadow, [shadowRegion.height, shadowRegion.width]);
  const png = document.createElement("canvas");
  png.width = w;
  png.height = h;
  const g = png.getContext("2d");
  const img = g.createImageData(w, h);
  const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, colour[i * 4 + 3]);
    for (let c = 0; c < 3; c++)
      img.data[i * 4 + c] = a > 1e-6 ? Math.round(255 * Math.min(1, enc(Math.max(0, colour[i * 4 + c] / a)))) : 0;
    img.data[i * 4 + 3] = Math.round(255 * a);
  }
  g.putImageData(img, 0, 0);
  await upload("character.png", await new Promise((r) => png.toBlob(r, "image/png")));

  const projection = projectionReport(worldPoints, k);
  const report = {
    schema_version: "0.3",
    renderer: "vrm-threejs",
    status: projection.fully_in_frame ? "rendered" : "rendered_with_framing_warning",
    pose_id: placement.pose_id,
    projection,
    camera: k,
    render_camera: rk,
    render_scale: settings.render_scale,
    supersample: ss,
    camera_projection_error_px: camErr,
    lighting: light ? light.report : { method: "fixed studio lights (no photo given)" },
    shadow_catchers: catchers,
    floor_catcher_half_m: catchers.length ? floorHalf : null,
    pass_regions: {
      note: "pass_*.npy cover only these pixel boxes of render_camera; outside them colour is 0, depth inf, shadow 1",
      frame: { width: rk.width, height: rk.height },
      colour: charRegion,
      shadow: shadowRegion,
      sky_shadow_render: skyCamera && { width: skyCamera.width, height: skyCamera.height },
      tile_px: tileLimit,
    },
    colour_region_edge_alpha: edgeAlpha,
    outputs: ["character.png", "pass_combined.npy", "pass_depth.npy", ...(shadow ? ["pass_shadow.npy"] : [])],
    environment: { engine: "three.js WebGL", three_revision: THREE.REVISION, vrm_version: vrm.meta?.metaVersion, gl: renderer.getContext().getParameter(renderer.getContext().VERSION) },
    limitations: [
      "pose presets + analytic two-bone IK; no physics for hair or skirt (bone-level settling only)",
      "lighting estimated from the photo only (no light probe); rasterized, no global illumination",
      "source metric accuracy is inherited, not validated by rendering",
    ],
    timing_s: {
      pose_and_measure: +poseSeconds.toFixed(3),
      render: +renderSeconds.toFixed(3),
      total_in_browser: +((performance.now() - started) / 1000).toFixed(3),
    },
  };
  const legs = poseReport.legs || {};
  if (!seated && manifest.foot_height_difference_m > 0.003)
    report.foot_warning = "both soles are not coplanar; no corrective foot IK applied";
  if (seated && !Object.values(legs).every((v) => v.feet_on_floor ?? true))
    report.foot_warning = "seat too high for both feet to reach the floor; feet hang";
  report.gl_extensions = ['EXT_float_blend', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float'].filter((e) => renderer.extensions.has(e));
  window.renderResult = { manifest, report, poseDump };
  window.renderReady = true;
}

main().catch((e) => {
  window.renderError = { message: e.stack || String(e), code: e.code || "RENDER_FAILED" };
  console.error(e);
});
