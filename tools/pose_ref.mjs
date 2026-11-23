// pose_ref loader for tools/render_vrm.mjs (Node only; kept apart so tests can call it without a browser).
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ContractError } from "../web/vrm_math.js";
import { presetFromWorkshop } from "../web/preset_pose.js";

// pose_ref: a pose made outside this repo (a new combo from the preset workshop engine), given as a JSON
// file next to placement.json: one workshop export entry, the same format as an item of micut-presets
// baked/poses.json. It is converted exactly like the registered presets (web/preset_pose.js) and is
// only accepted under a pose_id that is not registered.
const POSE_REF_MAX_BYTES = 8 << 20;
export async function loadPoseRef(p, placementPath, poses) {
  const ref = p?.pose_ref;
  if (ref === undefined || ref === null) return null;
  const fail = (msg) => new ContractError(`pose_ref: ${msg}`);
  if (typeof ref !== "string" || !ref || path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref))
    throw fail("expected a relative path to a .json file next to placement.json");
  const base = path.dirname(path.resolve(placementPath));
  const file = path.resolve(base, ref);
  const rel = path.relative(base, file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || path.extname(file).toLowerCase() !== ".json")
    throw fail(`${ref} must be a .json file inside the placement.json folder`);
  if (typeof p.pose_id !== "string") throw fail("needs a pose_id");
  if (poses[p.pose_id]) throw fail(`pose_id ${p.pose_id} is a registered pose; give the generated pose its own id`);
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch {
    throw fail(`${ref} not found`);
  }
  if (bytes.length > POSE_REF_MAX_BYTES) throw fail(`${ref} is larger than ${POSE_REF_MAX_BYTES} bytes`);
  let entry;
  try {
    entry = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw fail(`${ref} is not valid JSON (${e.message})`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pose = presetFromWorkshop(p.pose_id, entry, { from: "pose_ref", pose_ref: ref, pose_ref_sha256: sha256 });
  return { pose, ref, sha256 };
}


// Combo hash: SHA-256 of the pose-defining part of a micut-pose-combo object. The production-only
// keys (camera, reference) that the Pose step drops and the free-text meta are left out; the rest is
// serialised as JSON with sorted keys and no whitespace. Registered presets carry the hash of their
// micut-presets combos/<ID>.json (source.combo_sha256); a placement that sends a combo without a
// pose_ref must match one of them.
const COMBO_IGNORED = new Set(["camera", "reference", "meta"]);
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export function comboSha256(combo) {
  if (!combo || typeof combo !== "object" || Array.isArray(combo)) throw new ContractError("combo must be an object");
  const kept = Object.fromEntries(Object.entries(combo).filter(([k]) => !COMBO_IGNORED.has(k)));
  return createHash("sha256").update(canonical(kept), "utf8").digest("hex");
}

// placement.combo (the Pose candidate the placement step chose) against the pose that will be rendered.
// With a pose_ref the baked file is the source of truth and the combo is only recorded. Without one the
// pose_id must be a registered preset whose combo hash equals it; otherwise the registered pose is not
// what Pose meant (e.g. a v0.6.0 combo under a v0.6.5 id), so it is an error.
export function checkCombo(p, poses, poseRef) {
  if (p?.combo === undefined || p.combo === null) return null;
  const sha = comboSha256(p.combo);
  if (poseRef) return { combo_sha256: sha, checked_against: "pose_ref" };
  const pose = poses[p.pose_id];
  const registered = pose?.source?.combo_sha256;
  if (!registered)
    throw new ContractError(`combo given without pose_ref and ${p.pose_id} is not a registered preset; ` +
      "bake the combo with micut-presets tools/combo-to-pose and send its file as pose_ref");
  if (registered !== sha)
    throw new ContractError(`combo given without pose_ref does not match registered preset ${p.pose_id} ` +
      `(combo ${sha.slice(0, 12)}, registered ${registered.slice(0, 12)}); send the baked combo as pose_ref`);
  return { combo_sha256: sha, checked_against: "registered", match: true };
}
