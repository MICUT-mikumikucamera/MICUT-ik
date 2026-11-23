// Preset-workshop export entry (micut-presets baked/poses.json item, or a runtime pose_ref file) ->
// registered pose (micut.pose/0.1 with `baked`). Shared by tools/import_presets.mjs (repo sync) and
// tools/render_vrm.mjs (pose_ref), so both read the workshop format the same way. No three.js here.
import { ContractError } from "./vrm_math.js";

// Workshop base -> placement contract. Jumps (air) keep the standing contract: floor below the feet.
// Chair bases sit on the seat; legs are re-solved to the real floor at render time (feet_on_floor) or
// only lifted out of it (dangling legs on a high seat). Seat ranges are what the leg IK can cover.
const BASES = {
  B01: { family: "stand" }, B02: { family: "stand" }, B03: { family: "stand" }, B04: { family: "stand" },
  B13: { family: "air" },
  B05: { family: "chair", seat_range_m: [0.3, 0.6], feet_on_floor: true },
  B06: { family: "chair", seat_range_m: [0.3, 0.6], feet_on_floor: true },
  B07: { family: "chair", seat_range_m: [0.55, 0.9], feet_on_floor: false },
};
export const POSE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

const finite = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
const r = (v, n = 7) => v.map((x) => Number(x.toFixed(n)));

export function presetFromWorkshop(poseId, e, extraSource = {}) {
  const bad = (msg) => new ContractError(`pose ${poseId}: ${msg}`);
  if (!POSE_ID.test(poseId)) throw bad("pose_id must be 1-64 letters, digits, _ . -");
  if (!e || typeof e !== "object") throw bad("expected a workshop pose object");
  const combo = e.combo;
  if (!combo || typeof combo !== "object") throw bad("missing combo");
  if (typeof combo.modelSha256 !== "string") throw bad("combo.modelSha256 missing");
  const baseId = combo.base?.id;
  const base = BASES[baseId];
  if (!base) throw bad(`base ${baseId} has no placement contract yet (stand B01-B04, chair B05-B07, air B13)`);
  const rt = e.root_transform;
  if (!rt || !finite(rt.position, 3) || !finite(rt.rotation, 4) || !finite(rt.scale, 3)) throw bad("root_transform invalid");
  if (!Array.isArray(e.raw_bone_transforms) || !e.raw_bone_transforms.length) throw bad("raw_bone_transforms missing");
  const names = new Set();
  const bones = e.raw_bone_transforms.map((t, i) => {
    if (!t || typeof t.name !== "string" || !t.name) throw bad(`raw_bone_transforms[${i}] has no name`);
    if (names.has(t.name)) throw bad(`bone ${t.name} appears twice`);
    names.add(t.name);
    if (!finite(t.position, 3) || !finite(t.rotation, 4) || !finite(t.scale, 3)) throw bad(`bone ${t.name}: non-finite transform`);
    const q = Math.hypot(...t.rotation);
    if (Math.abs(q - 1) > 1e-3) throw bad(`bone ${t.name}: rotation is not a unit quaternion (|q| = ${q.toFixed(4)})`);
    if (t.scale.some((s) => s <= 0)) throw bad(`bone ${t.name}: scale must be positive`);
    return [t.name, r(t.position), r(t.rotation), r(t.scale, 6)];
  });
  const morphs = {};
  for (const mesh of e.mesh_morphs || []) {
    for (const [name, w] of Object.entries(mesh?.weights || {})) {
      if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 1) throw bad(`morph ${name}: weight must be in [0, 1]`);
      if (!w) continue;
      if (name in morphs && morphs[name] !== w) throw bad(`morph ${name} differs between meshes`);
      morphs[name] = Number(w.toFixed(6));
    }
  }
  const gaze = combo.gaze ?? null;
  if (gaze?.point !== undefined && !finite(gaze.point, 3)) throw bad("combo.gaze.point invalid");
  const sit = base.family === "chair";
  const pose = {
    schema: "micut.pose/0.1",
    pose_id: poseId,
    action: sit ? "sit" : "stand",
    anchor_type: sit ? "pelvis_seat_contact" : "feet_center_on_ground",
    ...(sit ? { support_height_m: base.seat_range_m } : {}),
    description: `${e.name ?? poseId} (preset workshop v${combo.version ?? "?"}, base ${baseId})`,
    source: {
      from: "preset workshop export",
      model_sha256: combo.modelSha256,
      status: e.status ?? null,
      notices: (e.notices || []).map((n) => (typeof n === "string" ? n : n.text)),
      gaze,
      body_yaw_deg: combo.bodyYaw ?? 0,
      base: baseId,
      airborne: base.family === "air",
      ...(sit
        ? { seat: { workshop_seat_height_m: combo.base.params?.seatHeight ?? null, feet_on_floor: base.feet_on_floor } }
        : {}),
      ...extraSource,
    },
    baked: {
      frame: "workshop: metres, +Y up, character faces +Z, floor y=0 (same as the VRM scene)",
      root_transform: { position: r(rt.position), rotation: r(rt.rotation), scale: r(rt.scale) },
      raw_bones: bones,
      morphs,
    },
  };
  return pose;
}
