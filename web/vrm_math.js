export function validatePlacement(p) {
  for (const [k, v] of Object.entries({
    coordinate_frame: "geometry_world",
    unit: "m",
    anchor_type: "feet_center_on_ground",
    action: "stand",
    pose_id: "stand_default",
  }))
    if (p[k] !== v) throw Error("Unsupported " + k);
  if (
    !Array.isArray(p.anchor_position) ||
    p.anchor_position.length !== 3 ||
    !p.anchor_position.every(Number.isFinite) ||
    Math.abs(p.anchor_position[1]) > 1e-5
  )
    throw Error("Invalid ground anchor");
  if (!["look_at_camera", "world_direction"].includes(p.facing_rule))
    throw Error("Invalid facing_rule");
}
export function facing(p, t) {
  const v =
    p.facing_rule === "world_direction"
      ? p.facing_direction
      : [t[0] - p.anchor_position[0], 0, t[2] - p.anchor_position[2]];
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    !v.every(Number.isFinite) ||
    Math.abs(v[1]) > 1e-5 ||
    Math.hypot(v[0], v[2]) < 1e-8
  )
    throw Error("Invalid horizontal direction");
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
    throw Error("Camera intrinsics required");
  if (
    !Array.isArray(R) ||
    R.length !== 3 ||
    R.some(
      (r) => !Array.isArray(r) || r.length !== 3 || !r.every(Number.isFinite),
    ) ||
    !Array.isArray(t) ||
    t.length !== 3 ||
    !t.every(Number.isFinite)
  )
    throw Error("Invalid R/t");
  const det =
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
  if (Math.abs(det + 1) > 0.001) throw Error("Expected left-handed geometry R");
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (
        Math.abs(
          R[i].reduce((a, b, n) => a + b * R[j][n], 0) - (i === j ? 1 : 0),
        ) > 0.001
      )
        throw Error("R must be orthogonal");
  if (Math.abs(t[0]) > 0.001 || Math.abs(t[2]) > 0.001 || t[1] <= 0)
    throw Error("Expected ground camera origin");
  return { width, height, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, R, t };
}
export function project(p, k) {
  const delta = p.map((v, i) => v - k.t[i]);
  const cv = [0, 1, 2].map((i) =>
    k.R.reduce((a, row, j) => a + row[i] * delta[j], 0),
  );
  return cv[2] > 0
    ? [(k.fx * cv[0]) / cv[2] + k.cx, (k.fy * cv[1]) / cv[2] + k.cy, cv[2]]
    : null;
}
export function projectionReport(points, k) {
  const all = points.map((p) => project(p, k)),
    good = all.filter(Boolean);
  if (!good.length) return { fully_in_frame: false, all_behind_camera: true };
  const lo = [0, 1].map((i) => Math.min(...good.map((p) => p[i]))),
    hi = [0, 1].map((i) => Math.max(...good.map((p) => p[i])));
  return {
    bbox_px: { min: lo, max: hi },
    fully_in_frame:
      good.length === all.length &&
      lo[0] >= 0 &&
      lo[1] >= 0 &&
      hi[0] <= k.width &&
      hi[1] <= k.height,
    vertices_behind_camera: all.length - good.length,
    automatic_rescale: false,
  };
}
