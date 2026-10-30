import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { cameraFromSpatial, validatePlacement } from "../web/vrm_math.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1])
    throw Error("Use --option value");
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.model || !args.spatial || !args.placement || !args.out)
  throw Error(
    "Required: --model FILE --spatial JSON --placement JSON --out DIR",
  );
const model = path.resolve(args.model),
  out = path.resolve(args.out);
await fs.mkdir(out, { recursive: true });
const json = async (p) =>
  JSON.parse(
    (await fs.readFile(path.resolve(p), "utf8")).replace(/^\uFEFF/, ""),
  );
const placement = await json(args.placement),
  spatial = await json(args.spatial);
validatePlacement(placement);
const k = cameraFromSpatial(spatial);
const height = Number(args.height ?? 1.58);
if (!Number.isFinite(height) || height <= 0)
  throw Error("height must be positive");
if (
  placement.model_id &&
  placement.model_id !== "appearance-miku-vrm1-local-v1"
)
  throw Error("model_id differs from loaded VRM adapter profile");
const data = await fs.readFile(model);
const hash = createHash("sha256").update(data).digest("hex");
const endpoints = {
  "/placement.json": placement,
  "/spatial.json": spatial,
  "/settings.json": { height },
};
let browser;
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (endpoints[pathname]) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(endpoints[pathname]));
      return;
    }
    let file;
    if (pathname === "/model.vrm") file = model;
    else if (pathname === "/") file = path.join(root, "web/vrm.html");
    else if (pathname.startsWith("/web/")) {
      file = path.resolve(root, "." + pathname);
      if (!file.startsWith(path.join(root, "web") + path.sep))
        throw Error("Invalid path");
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
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".html")
          ? "text/html"
          : file.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
    );
    createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(404);
    res.end(String(e));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const executablePath =
    args.browser ||
    process.env.BROWSER_BIN ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: k.width, height: k.height },
    deviceScaleFactor: 1,
  });
  const messages = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") messages.push(msg.text());
  });
  page.on("pageerror", (e) => messages.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`, {
    waitUntil: "load",
  });
  await page.waitForFunction(
    () => window.renderReady || window.renderError,
    {},
    { timeout: 90000 },
  );
  const error = await page.evaluate(() => window.renderError);
  if (error) throw Error(error);
  const result = await page.evaluate(() => window.renderResult);
  result.source_file_name = path.basename(model);
  result.source_file_sha256 = hash;
  result.browser_errors = messages;
  await page
    .locator("canvas")
    .screenshot({
      path: path.join(out, "character.png"),
      omitBackground: true,
    });
  await fs.writeFile(
    path.join(out, "vrm_render_report.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  const manifest = Object.fromEntries(
    [
      "model_id",
      "pose_id",
      "unit",
      "source_file_name",
      "source_file_sha256",
      "target_height_m",
      "target_height_note",
      "applied_uniform_scale",
      "source_height_above_soles_units",
      "normalized_size_m",
      "normalized_local_bounds_m",
      "local_bounds_axes",
      "anchor_type",
      "anchor_position",
      "foot_contact_points_geometry_m",
      "foot_height_difference_m",
      "facing_direction_geometry",
      "environment",
      "limitations",
    ].map((k) => [k, result[k]]),
  );
  await fs.writeFile(
    path.join(out, "model_manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await fs.rm(path.join(out, "error.json"), { force: true });
  console.log(
    JSON.stringify({
      status: result.status,
      size: result.normalized_size_m,
      camera_error_px: result.camera_projection_error_px,
      out,
    }),
  );
} catch (error) {
  await fs.writeFile(
    path.join(out, "error.json"),
    JSON.stringify({ status: "failed", message: String(error) }, null, 2),
  );
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
