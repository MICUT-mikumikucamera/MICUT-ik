// Photo scene as an obstacle field for the pose clean-up, from the geometry step's own outputs
// (geometry.v5): depth.npy (planar camera z, metres), depth_validity.png and masks.png (object ids).
// The depth map only shows the surfaces the camera sees, so "inside an object" is approximated as
// "behind a visible object surface, by no more than that object's assumed thickness": 0.30 m for the
// object Miku sits on (her chair: backrest, seat), 0.06 m (a contact zone) for every other object.
// Farther behind is a legitimate occlusion, not a penetration. Floor pixels and points under 5 cm are
// skipped (the support plane handles the floor).
import { project } from "./vrm_math.js";

async function decodePng(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = rgba[4 * i];
  return { width: bmp.width, height: bmp.height, data: out };
}

function parseNpyFloat32(buf) {
  const bytes = new Uint8Array(buf);
  if (String.fromCharCode(...bytes.slice(1, 6)) !== "NUMPY") throw Error("depth.npy: not a .npy file");
  const major = bytes[6];
  const hlen = major === 1 ? bytes[8] | (bytes[9] << 8) : new DataView(buf).getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.slice(start, start + hlen));
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw Error(`depth.npy: need C-order <f4, got ${header}`);
  const shape = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/);
  const [h, w] = [Number(shape[1]), Number(shape[2])];
  return { width: w, height: h, data: new Float32Array(buf.slice(start + hlen, start + hlen + 4 * w * h)) };
}

// spec (from render_vrm.mjs): {floor_ids, support_object_id, near_m, support_m}. k: geometry camera.
export async function loadScene(spec, k) {
  const depth = parseNpyFloat32(await (await fetch("/scene/depth.npy")).arrayBuffer());
  const valid = await decodePng("/scene/validity.png");
  const masks = await decodePng("/scene/masks.png");
  for (const m of [depth, valid, masks])
    if (m.width !== k.width || m.height !== k.height) throw Error(`scene map ${m.width}x${m.height} differs from the image ${k.width}x${k.height}`);
  const floor = new Set(spec.floor_ids);
  // Returns how far a geometry-world point is inside an object (m, > 0), or 0, plus the object id.
  return (p) => {
    if (p[1] <= 0.05) return { gap: 0, id: null };
    const q = project(p, k);
    if (!q) return { gap: 0, id: null };
    const u = Math.floor(q[0]), v = Math.floor(q[1]);
    if (u < 0 || v < 0 || u >= k.width || v >= k.height) return { gap: 0, id: null };
    const i = v * k.width + u;
    if (valid.data[i] !== 255) return { gap: 0, id: null };
    const id = masks.data[i];
    if (floor.has(id)) return { gap: 0, id };
    const gap = q[2] - depth.data[i];
    const band = id !== 0 && id === spec.support_object_id ? spec.support_m : spec.near_m;
    return gap > 0 && gap <= band ? { gap, id } : { gap: 0, id };
  };
}
