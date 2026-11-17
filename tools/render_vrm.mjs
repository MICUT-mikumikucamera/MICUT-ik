// VRM render entry point (no Blender): headless Chrome + three.js + three-vrm.
//
//   node tools/render_vrm.mjs --spatial local/geometry/sample1/spatial_info.json \
//     --placement examples/placement.sample1.stand.json --photo local/geometry/sample1/image.jpg --out outputs/x
//
// Same inputs as tools/render_stand.py; same pose files (poses/*.json) and model profile. Outputs
// character.png, model_manifest.json, placement_report.json and, with --photo, the passes that
// tools/finalize.py composites (pass_combined.npy, pass_depth.npy, pass_shadow.npy).
import fs from "node:fs/promises";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { ContractError, cameraFromSpatial, validatePlacement } from "../web/vrm_math.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "appearance-miku-vrm1-local-v1";
const DEFAULTS = {
  model: "local/models/miku.vrm",
  profile: "examples/model_profile.json",
  "render-scale": "1",
  supersample: "2",
  exposure: "2",
  "ceiling-gain": "1.3",
  "key-share-min": "0.3",
  "sky-samples": "4",
  timeout: "600", // seconds for the whole render (watchdog)
};
const args = { ...DEFAULTS };
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || process.argv[i + 1] === undefined) throw Error("Use --option value");
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.spatial || !args.placement || !args.out)
  throw Error("Required: --spatial JSON --placement JSON --out DIR [--photo JPG] [--model VRM]");
const out = path.resolve(args.out);
await fs.mkdir(out, { recursive: true });
const readJson = async (p) => JSON.parse((await fs.readFile(path.resolve(p), "utf8")).replace(/^\uFEFF/, ""));
const num = (name, min) => {
  const v = Number(args[name]);
  if (!Number.isFinite(v) || v < min) throw new ContractError(`--${name} must be a number >= ${min}`, "INVALID_ARGUMENT");
  return v;
};

function npy(data, shape) {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += " ".repeat(pad % 64) + "\n";
  const pre = Buffer.alloc(10);
  pre.write("\x93NUMPY", 0, "latin1");
  pre[6] = 1;
  pre[7] = 0;
  pre.writeUInt16LE(header.length, 8);
  return Buffer.concat([pre, Buffer.from(header, "latin1"), data]);
}

let browser, server;
const started = performance.now();
// Hard limit for the whole render. It does not rely on the browser or Playwright answering (a stalled
// page or a dead DevTools pipe never rejects their promises): it writes error.json and exits, and
// Playwright kills the browser on exit.
const limitS = num("timeout", 1);
let lastMark = "start";
const failSync = (code, message) => {
  const body = { status: "failed", code, error_type: "Timeout", message };
  writeFileSync(path.join(out, "error.json"), JSON.stringify(body, null, 2));
  writeFileSync(path.join(out, "placement_report.json"), JSON.stringify({ status: "failed", code, error: message }, null, 2));
};
const watchdog = setTimeout(() => {
  const message = `render did not finish within ${limitS} s (last stage: ${lastMark})`;
  failSync("RENDER_FAILED", message);
  console.error(message);
  process.exit(1);
}, limitS * 1000);
try {
  const model = path.resolve(args.model);
  if (!existsSync(model)) throw new ContractError(`VRM model not found: ${model}`, "MODEL_MISSING");
  const photo = args.photo ? path.resolve(args.photo) : null;
  if (photo && !existsSync(photo)) throw new ContractError(`photo not found: ${photo}`, "INVALID_ARGUMENT");
  const poses = {};
  for (const f of (await fs.readdir(path.join(root, "poses"))).filter((f) => f.endsWith(".json")).sort()) {
    const p = await readJson(path.join(root, "poses", f));
    poses[p.pose_id] = p;
  }
  const rawPlacement = await readJson(args.placement);
  const placement = validatePlacement(rawPlacement, poses);
  const spatial = await readJson(args.spatial);
  const k = cameraFromSpatial(spatial);
  const profile = await readJson(args.profile);
  if (placement.model_id && placement.model_id !== MODEL_ID)
    throw new ContractError(`request model_id ${placement.model_id} differs from loaded VRM ${MODEL_ID}`, "MODEL_MISMATCH");
  const height = args.height !== undefined ? num("height", 0.01) : profile.target_height_m;
  const job = {
    placement,
    spatial,
    profile,
    pose: poses[placement.pose_id],
    settings: {
      height,
      model_id: MODEL_ID,
      photo: Boolean(photo),
      render_scale: num("render-scale", 0.1),
      supersample: Math.round(num("supersample", 1)),
      exposure: num("exposure", 0),
      ceiling_gain: num("ceiling-gain", 0),
      key_share_min: num("key-share-min", 0),
      sky_samples: Math.round(num("sky-samples", 1)),
      full_frame_regions: args.regions === "full", // check only: passes cover the whole frame
    },
  };
  const data = await fs.readFile(model);
  const hash = createHash("sha256").update(data).digest("hex");
  const pose = poses[placement.pose_id];
  if (pose.baked && pose.source?.model_sha256 !== hash)
    throw new ContractError(`preset ${pose.pose_id} was exported for model ${pose.source?.model_sha256}, loaded ${hash}`, "MODEL_MISMATCH");

  const pending = new Map(); // upload name -> parts received so far
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      if (req.method === "POST" && pathname.startsWith("/upload/")) {
        const name = path.basename(pathname);
        if (!/^[\w.]+$/.test(name)) throw Error("Invalid upload name");
        // The page sends large files in parts: Playwright copies every request body into a DevTools
        // message, and a body over ~90 MB overflows its pipe (ERR_STRING_TOO_LONG), silently stalling it.
        const part = Number(url.searchParams.get("part") ?? 0),
          parts = Number(url.searchParams.get("parts") ?? 1);
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (part === 0) pending.set(name, []);
        const got = pending.get(name);
        if (!got || got.length !== part || part >= parts) throw Error(`upload ${name}: part ${part}/${parts} out of order`);
        got.push(Buffer.concat(chunks));
        if (part < parts - 1) {
          res.end("ok");
          return;
        }
        pending.delete(name);
        let body = Buffer.concat(got);
        const shape = url.searchParams.get("shape");
        if (shape) {
          const dims = shape.split(",").map(Number);
          if (dims.reduce((a, b) => a * b, 4) !== body.length) throw Error(`upload ${name}: size does not match ${shape}`);
          body = npy(body, dims);
        }
        await fs.writeFile(path.join(out, name), body);
        res.end("ok");
        return;
      }
      if (pathname === "/job.json") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(job));
        return;
      }
      let file;
      if (pathname === "/model.vrm") file = model;
      else if (pathname === "/photo.jpg" && photo) file = photo;
      else if (pathname === "/") file = path.join(root, "web/vrm.html");
      else if (pathname.startsWith("/web/")) {
        file = path.resolve(root, "." + pathname);
        if (!file.startsWith(path.join(root, "web") + path.sep)) throw Error("Invalid path");
      } else if (pathname.startsWith("/vendor/")) {
        const base = path.join(root, "node_modules");
        file = path.resolve(base, pathname.slice("/vendor/".length));
        if (!file.startsWith(base + path.sep)) throw Error("Invalid vendor path");
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      const stat = await fs.stat(file);
      res.setHeader("Content-Length", stat.size);
      const type = { ".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".jpg": "image/jpeg" };
      res.setHeader("Content-Type", type[path.extname(file).toLowerCase()] || "application/octet-stream");
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const executablePath =
    args.browser ||
    process.env.BROWSER_BIN ||
    ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
  const messages = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") messages.push(`${msg.type()}: ${msg.text()}`);
    if (msg.text().startsWith("[mark")) {
      lastMark = msg.text();
      if (args.verbose === "1") console.error(msg.text());
    }
  });
  page.on("pageerror", (e) => messages.push(String(e)));
  const crashed = new Promise((_, reject) => page.on("crash", () => reject(Error(`browser page crashed (last stage: ${lastMark})`))));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load" });
  await Promise.race([page.waitForFunction(() => window.renderReady || window.renderError, {}, { timeout: limitS * 1000 }), crashed]);
  const error = await page.evaluate(() => window.renderError);
  if (error) throw new ContractError(error.message, error.code);
  const { manifest, report } = await page.evaluate(() => window.renderResult);
  manifest.source_file_name = path.basename(model);
  manifest.source_file_sha256 = hash;
  manifest.render_environment = report.environment;
  report.browser_messages = messages;
  report.photo = photo ? path.basename(photo) : null;
  report.timing_s.total = +((performance.now() - started) / 1000).toFixed(3);
  await fs.writeFile(path.join(out, "model_manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(path.join(out, "placement_report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.rm(path.join(out, "error.json"), { force: true });
  console.log(JSON.stringify({
    status: report.status, pose_id: report.pose_id, size: manifest.normalized_size_m,
    legs: manifest.pose_report.legs, penetration: manifest.penetration_below_support.vertices,
    timing_s: report.timing_s, out,
  }));
} catch (error) {
  // Only contract errors carry a BE error code; system errors (ENOENT, browser crashes) are render failures.
  const code = error instanceof ContractError ? error.code : "RENDER_FAILED";
  await fs.writeFile(path.join(out, "error.json"),
    JSON.stringify({ status: "failed", code, error_type: error.name, message: String(error.message || error) }, null, 2));
  await fs.writeFile(path.join(out, "placement_report.json"),
    JSON.stringify({ status: "failed", code, error: String(error.message || error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
