import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { presetFromWorkshop } from "../web/preset_pose.js";
import { loadPoseRef } from "../tools/pose_ref.mjs";
import { validatePlacement } from "../web/vrm_math.js";

const SHA = "d82699d2a913397d9761614c917a6305a6121f8654623c1197dcf3a13381a789";
const entry = (base = "B01", params = {}) => ({
  name: "test pose",
  root_transform: { position: [0, 0.001, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  raw_bone_transforms: [
    { name: "Head", position: [0, 0.1, 0], rotation: [0, 0, 0.7071068, 0.7071068], scale: [1, 1, 1] },
    { name: "Neck", position: [0, 0.05, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  ],
  mesh_morphs: [{ weights: { smile: 0.5, blink: 0 } }, { weights: { smile: 0.5 } }],
  combo: { modelSha256: SHA, version: "0.6.5", base: { id: base, params }, gaze: { target: "camera", point: [0, 1.3, 1.5] } },
  status: "ok",
  notices: [{ type: "limited", text: "note" }],
});
const stand = {
  coordinate_frame: "geometry_world", unit: "m", action: "stand", anchor_type: "feet_center_on_ground",
  anchor_position: [0.3, 0, 0.8], facing_rule: "look_at_camera",
};

test("workshop entries convert like the registered presets", () => {
  const p = presetFromWorkshop("gen_c0", entry());
  assert.equal(p.action, "stand");
  assert.equal(p.anchor_type, "feet_center_on_ground");
  assert.deepEqual(p.baked.raw_bones[0], ["Head", [0, 0.1, 0], [0, 0, 0.7071068, 0.7071068], [1, 1, 1]]);
  assert.deepEqual(p.baked.morphs, { smile: 0.5 });
  assert.deepEqual(p.source.notices, ["note"]);
  assert.equal(p.source.model_sha256, SHA);
});

test("chair bases become seated poses with a seat range", () => {
  const p = presetFromWorkshop("gen_sit", entry("B05", { seatHeight: 0.45 }));
  assert.equal(p.action, "sit");
  assert.equal(p.anchor_type, "pelvis_seat_contact");
  assert.deepEqual(p.support_height_m, [0.3, 0.6]);
  assert.deepEqual(p.source.seat, { workshop_seat_height_m: 0.45, feet_on_floor: true });
  assert.equal(presetFromWorkshop("gen_high", entry("B07")).source.seat.feet_on_floor, false);
});

test("bad workshop entries are rejected", () => {
  const cases = [
    ["unknown base", (e) => (e.combo.base.id = "B09")],
    ["non-unit quaternion", (e) => (e.raw_bone_transforms[0].rotation = [0, 0, 0, 2])],
    ["non-finite position", (e) => (e.raw_bone_transforms[0].position = [0, NaN, 0])],
    ["duplicate bone", (e) => e.raw_bone_transforms.push({ ...e.raw_bone_transforms[0] })],
    ["morph differs between meshes", (e) => (e.mesh_morphs[1].weights.smile = 0.2)],
    ["morph out of range", (e) => (e.mesh_morphs[0].weights.smile = 3)],
    ["no model hash", (e) => delete e.combo.modelSha256],
  ];
  for (const [name, mutate] of cases) {
    const e = entry();
    mutate(e);
    assert.throws(() => presetFromWorkshop("gen_c0", e), { name: "ContractError" }, name);
  }
  assert.throws(() => presetFromWorkshop("../evil", entry()), { name: "ContractError" });
});

test("pose_ref loads only a JSON file inside the placement folder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "poseref-"));
  await mkdir(path.join(dir, "poses_runtime"));
  await writeFile(path.join(dir, "poses_runtime", "gen_c0.json"), JSON.stringify(entry()));
  await writeFile(path.join(dir, "outside.json"), JSON.stringify(entry()));
  const placementPath = path.join(dir, "req", "placement.json");
  await mkdir(path.dirname(placementPath));
  const ok = { ...stand, pose_id: "gen_c0", pose_ref: "../poses_runtime/gen_c0.json" };
  await assert.rejects(loadPoseRef(ok, placementPath, {}), /inside the placement.json folder/);

  const placement2 = path.join(dir, "placement.json");
  const r = await loadPoseRef({ ...ok, pose_ref: "poses_runtime/gen_c0.json" }, placement2, {});
  assert.equal(r.pose.pose_id, "gen_c0");
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.pose.source.pose_ref_sha256, r.sha256);
  const poses = { [r.pose.pose_id]: r.pose };
  assert.equal(validatePlacement({ ...ok, pose_ref: "poses_runtime/gen_c0.json" }, poses).pose_ref, "poses_runtime/gen_c0.json");

  for (const ref of [path.join(dir, "outside.json"), "C:/x.json", "poses_runtime/missing.json", "poses_runtime", 5]) {
    await assert.rejects(loadPoseRef({ ...ok, pose_ref: ref }, placement2, {}), { name: "ContractError" }, String(ref));
  }
  await assert.rejects(loadPoseRef({ ...ok, pose_id: "MV05", pose_ref: "poses_runtime/gen_c0.json" }, placement2, { MV05: {} }),
    /registered pose/);
  assert.equal(await loadPoseRef(stand, placement2, {}), null);
});

test("registered presets match presets.lock.json", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const lock = JSON.parse(await readFile(path.join(root, "presets.lock.json"), "utf8"));
  const baked = [];
  for (const f of await readdir(path.join(root, "poses"))) {
    const p = JSON.parse(await readFile(path.join(root, "poses", f), "utf8"));
    if (p.baked) {
      baked.push(p.pose_id);
      assert.equal(p.source.preset_version, lock.version, p.pose_id);
      assert.equal(p.source.model_sha256, lock.model_sha256, p.pose_id);
    }
  }
  assert.deepEqual(baked.sort(), lock.poses);
});
