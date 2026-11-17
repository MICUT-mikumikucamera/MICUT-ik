// Placement / camera contract for the VRM renderer. Mirrors micut_ik/contracts.py (no three.js here,
// so Node tests and tools/render_vrm.mjs can use it directly).

export class ContractError extends Error {
  constructor(message, code = "INVALID_PLACEMENT") {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

const finiteVector = (v, n) =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

// poses: {pose_id: pose definition} from poses/*.json. Only registered pose_ids are accepted.
export function validatePlacement(p, poses) {
  if (!poses) throw Error("validatePlacement needs the pose registry");
  for (const [k, v] of Object.entries({ coordinate_frame: "geometry_world", unit: "m" }))
    if (p[k] !== v) throw new ContractError(`${k}: this adapter supports only ${JSON.stringify(v)}`);
  const pose = poses[p.pose_id];
  if (!pose)
    throw new ContractError(
      `pose_id: unknown ${JSON.stringify(p.pose_id)}; registered: ${Object.keys(poses).sort().join(", ")}`,
    );
  for (const k of ["action", "anchor_type"])
    if (p[k] !== pose[k]) throw new ContractError(`${k}: pose ${pose.pose_id} requires ${JSON.stringify(pose[k])}`);
  if (!finiteVector(p.anchor_position, 3)) throw new ContractError("anchor_position: expected 3 finite numbers");
  const y = p.anchor_position[1];
  if (pose.anchor_type === "feet_center_on_ground") {
    if (Math.abs(y) > 1e-5)
      throw new ContractError("standing ground anchor must have Y=0; use a sit pose for elevated supports");
  } else {
    const [lo, hi] = pose.support_height_m;
    if (!(lo <= y && y <= hi))
      throw new ContractError(
        `support height Y=${y.toFixed(3)} m outside ${pose.pose_id} range [${lo}, ${hi}]`,
        "SUPPORT_OUT_OF_RANGE",
      );
  }
  const sid = p.support_candidate_id;
  if (sid !== undefined && sid !== null && !(Number.isInteger(sid) && sid >= 0))
    throw new ContractError("support_candidate_id must be a non-negative integer when provided");
  if (!["look_at_camera", "world_direction"].includes(p.facing_rule))
    throw new ContractError("facing_rule: use look_at_camera or world_direction");
  if (p.facing_rule === "world_direction") {
    const d = p.facing_direction;
    if (!finiteVector(d, 3) || Math.abs(d[1]) > 1e-5 || Math.hypot(d[0], d[2]) < 1e-8)
      throw new ContractError("facing_direction must be nonzero and horizontal (Y=0)");
  }
  if (p.selection !== undefined && p.selection !== null && (typeof p.selection !== "string" || !p.selection))
    throw new ContractError("selection must be a nonempty string when provided");
  if (p.model_id !== undefined && p.model_id !== null && (typeof p.model_id !== "string" || !p.model_id))
    throw new ContractError("model_id must be a nonempty string when provided");
  return {
    anchor_position: [...p.anchor_position],
    facing_rule: p.facing_rule,
    facing_direction: p.facing_direction ?? null,
    model_id: p.model_id ?? null,
    action: pose.action,
    pose_id: pose.pose_id,
    anchor_type: pose.anchor_type,
    support_candidate_id: sid ?? null,
    selection: p.selection ?? null,
  };
}

export function facing(p, t) {
  const v =
    p.facing_rule === "world_direction"
      ? p.facing_direction
      : [t[0] - p.anchor_position[0], 0, t[2] - p.anchor_position[2]];
  if (!finiteVector(v, 3) || Math.abs(v[1]) > 1e-5 || Math.hypot(v[0], v[2]) < 1e-8)
    throw new ContractError("camera directly above anchor or invalid direction: horizontal facing is undefined");
  const n = Math.hypot(v[0], v[2]);
  return [v[0] / n, 0, v[2] / n];
}

export function cameraFromSpatial(s) {
  const { width, height } = s.image,
    k = s.camera,
    { R, t } = s.ground_plane.cam_to_world;
  if (
    ![width, height].every((v) => Number.isInteger(v) && v > 0) ||
    ![k.fx, k.fy, k.cx, k.cy].every(Number.isFinite) ||
    k.fx <= 0 ||
    k.fy <= 0
  )
    throw new ContractError("Camera intrinsics required; no guessed fallback", "INVALID_GEOMETRY");
  if (!Array.isArray(R) || R.length !== 3 || R.some((r) => !finiteVector(r, 3)) || !finiteVector(t, 3))
    throw new ContractError("Invalid R/t", "INVALID_GEOMETRY");
  const det =
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
  if (Math.abs(det + 1) > 0.001) throw new ContractError("Expected left-handed geometry R", "INVALID_GEOMETRY");
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (Math.abs(R[i].reduce((a, b, n) => a + b * R[j][n], 0) - (i === j ? 1 : 0)) > 0.001)
        throw new ContractError("R must be orthogonal", "INVALID_GEOMETRY");
  if (Math.abs(t[0]) > 0.001 || Math.abs(t[2]) > 0.001 || t[1] <= 0)
    throw new ContractError("Expected ground camera origin", "INVALID_GEOMETRY");
  return { width, height, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, R, t };
}

// Same lens at a higher pixel count. Continuous pixel coordinates scale linearly (origin at the corner).
export function scaledCamera(k, scale) {
  const width = Math.round(k.width * scale),
    height = Math.round(k.height * scale);
  const sx = width / k.width,
    sy = height / k.height;
  return { ...k, width, height, fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy };
}

export function project(p, k) {
  const delta = p.map((v, i) => v - k.t[i]);
  const cv = [0, 1, 2].map((i) => k.R.reduce((a, row, j) => a + row[i] * delta[j], 0));
  return cv[2] > 0 ? [(k.fx * cv[0]) / cv[2] + k.cx, (k.fy * cv[1]) / cv[2] + k.cy, cv[2]] : null;
}

export function projectionReport(points, k) {
  const all = points.map((p) => project(p, k)),
    good = all.filter(Boolean);
  if (!good.length) return { fully_in_frame: false, all_behind_camera: true, visible_vertex_fraction: 0 };
  const lo = [0, 1].map((i) => Math.min(...good.map((p) => p[i]))),
    hi = [0, 1].map((i) => Math.max(...good.map((p) => p[i])));
  const inside = good.filter((p) => p[0] >= 0 && p[0] <= k.width && p[1] >= 0 && p[1] <= k.height).length;
  return {
    bbox_px: { min: lo, max: hi },
    fully_in_frame:
      good.length === all.length && lo[0] >= 0 && lo[1] >= 0 && hi[0] <= k.width && hi[1] <= k.height,
    visible_vertex_fraction: inside / all.length,
    vertices_behind_camera: all.length - good.length,
    automatic_rescale: false,
    note: "image framing only; does not validate collision, floor occupancy or occlusion",
  };
}

// Local frame shared with micut_place.shape: x = character right (r = [f_z, 0, -f_x]), y up, z = facing.
export function toLocal(point, anchor, f) {
  const r = [f[2], 0, -f[0]];
  const d = point.map((v, i) => v - anchor[i]);
  return [d[0] * r[0] + d[2] * r[2], d[1], d[0] * f[0] + d[2] * f[2]];
}

export const LOCAL_FRAME_NOTE =
  "model-local metres: x = character right r=[f_z,0,-f_x], y = up, z = facing f; " +
  "origin = anchor_position (the anchor_type point). Same frame as the placement shape export.";
