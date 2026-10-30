import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cameraFromSpatial,
  validatePlacement,
  facing,
  project,
  projectionReport,
} from "../web/vrm_math.js";
const spatial = JSON.parse(
  fs.readFileSync(
    new URL("../examples/spatial.synthetic.json", import.meta.url),
  ),
);
const placement = JSON.parse(
  fs.readFileSync(new URL("../examples/placement.stand.json", import.meta.url)),
);
test("accept Sungyoon standing example, reject other units and support heights", () => {
  validatePlacement(placement);
  assert.throws(() => validatePlacement({ ...placement, unit: "cm" }));
  assert.throws(() =>
    validatePlacement({ ...placement, anchor_position: [0, 0.4, 1] }),
  );
});
test("unknown intrinsics and right-handed geometry are rejected", () => {
  assert.throws(() =>
    cameraFromSpatial({ ...spatial, camera: { ...spatial.camera, fx: null } }),
  );
  assert.throws(() =>
    cameraFromSpatial({
      ...spatial,
      ground_plane: {
        cam_to_world: {
          R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          t: [0, 1, 0],
        },
      },
    }),
  );
});
test("camera facing is horizontal and independent of camera height", () => {
  assert.deepEqual(
    facing(placement, [0, 1.7, 0]),
    facing(placement, [0, 10, 0]),
  );
  assert.equal(facing(placement, [0, 1.7, 0])[1], 0);
});
test("optical axis reaches principal point and points behind camera are excluded", () => {
  const k = cameraFromSpatial(spatial);
  const w = k.t.map((v, i) => v + 3 * k.R[i][2]);
  const p = project(w, k);
  assert.ok(Math.abs(p[0] - k.cx) < 1e-9 && Math.abs(p[1] - k.cy) < 1e-9);
  assert.equal(
    project(
      k.t.map((v, i) => v - k.R[i][2]),
      k,
    ),
    null,
  );
});
test("out-of-frame geometry reports clipping without automatic resizing", () => {
  const k = cameraFromSpatial(spatial);
  const p = k.t.map((v, i) => v + 10 * k.R[i][0] + k.R[i][2]);
  const report = projectionReport([p], k);
  assert.equal(report.fully_in_frame, false);
  assert.equal(report.automatic_rescale, false);
});
