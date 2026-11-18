// Sync poses/ with the preset repository (github.com/MICUT-mikumikucamera/micut-presets).
//
//   node tools/import_presets.mjs [--presets-repo ../micut-presets] [--check]
//
// Reads <repo>/baked/poses.json, checks its SHA-256 against <repo>/manifest.json, converts every entry
// with web/preset_pose.js (the same converter render_vrm.mjs uses for pose_ref) and writes
// poses/<ID>.json. Preset files no longer in the repo are removed; own poses (no `baked`) are never
// touched. presets.lock.json records the version, commit and file hash the poses came from.
// --check writes nothing and exits 1 when poses/ or the lock differ from the repo.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { presetFromWorkshop } from "../web/preset_pose.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { "presets-repo": path.join(root, "..", "micut-presets") };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--check") args.check = true;
  else if (a.startsWith("--") && process.argv[i + 1] !== undefined) args[a.slice(2)] = process.argv[++i];
  else throw Error(`unknown argument ${a}`);
}
const repo = path.resolve(args["presets-repo"]);
const bakedPath = path.join(repo, "baked", "poses.json");
if (!existsSync(bakedPath)) throw Error(`${bakedPath} not found; clone micut-presets next to this repo or pass --presets-repo`);

// Git on Windows (core.autocrlf=true) checks the JSON out with CRLF; the manifest hashes the LF file.
const raw = readFileSync(bakedPath);
const bytes = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const sha = createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync(path.join(repo, "manifest.json"), "utf8"));
const listed = manifest.files?.["baked/poses.json"]?.sha256;
if (listed !== sha) throw Error(`baked/poses.json SHA-256 ${sha} (LF) does not match manifest.json (${listed})`);
const version = readFileSync(path.join(repo, "VERSION"), "utf8").trim();
if (manifest.version !== version) throw Error(`VERSION ${version} differs from manifest.json ${manifest.version}`);
let commit = null;
try {
  commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // not a git checkout (e.g. a release archive): the version and file hash still identify it
}

const data = JSON.parse(bytes.toString("utf8"));
const wanted = new Map();
for (const [id, entry] of Object.entries(data)) {
  if (entry.combo?.modelSha256 !== manifest.modelSha256) throw Error(`${id}: exported for another model`);
  const pose = presetFromWorkshop(id, entry, { from: `micut-presets ${version}`, preset_version: version });
  wanted.set(`${id}.json`, JSON.stringify(pose) + "\n");
}
const lock = {
  repository: "https://github.com/MICUT-mikumikucamera/micut-presets",
  version,
  commit,
  baked_poses_sha256: sha,
  model_sha256: manifest.modelSha256,
  poses: [...wanted.keys()].map((f) => f.slice(0, -5)).sort(),
};
const lockText = JSON.stringify(lock, null, 2) + "\n";

const poseDir = path.join(root, "poses");
const stale = readdirSync(poseDir).filter((f) => {
  if (!f.endsWith(".json") || wanted.has(f)) return false;
  return Boolean(JSON.parse(readFileSync(path.join(poseDir, f), "utf8")).baked);
});
const changed = [...wanted].filter(([f, text]) => {
  const p = path.join(poseDir, f);
  return !existsSync(p) || readFileSync(p, "utf8").replace(/\r\n/g, "\n") !== text;
});
const lockPath = path.join(root, "presets.lock.json");
const lockChanged = !existsSync(lockPath) || readFileSync(lockPath, "utf8").replace(/\r\n/g, "\n") !== lockText;

console.log(`micut-presets ${version} (${commit?.slice(0, 7) ?? "no git"}): ${wanted.size} presets, ` +
  `${changed.length} new or changed, ${stale.length} removed${lockChanged ? ", lock updated" : ""}`);
for (const [f] of changed) console.log(`  ~ ${f}`);
for (const f of stale) console.log(`  - ${f}`);
if (args.check) process.exit(changed.length || stale.length || lockChanged ? 1 : 0);
for (const [f, text] of changed) writeFileSync(path.join(poseDir, f), text);
for (const f of stale) unlinkSync(path.join(poseDir, f));
writeFileSync(lockPath, lockText);
