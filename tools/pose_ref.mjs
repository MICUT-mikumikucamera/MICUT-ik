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

