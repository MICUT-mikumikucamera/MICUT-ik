import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { twoBoneIK, seatedAnkleTarget, clampDirection, length, sub } from "../web/ik.js";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/ik_cases.json", import.meta.url), "utf8"));
const close = (a, b, tol = 1e-9) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= tol, `${a} vs ${b}`));

test("two-bone IK matches the Python implementation", () => {
  for (const c of cases.two_bone) {
    const r = twoBoneIK(...c.args);
    close(r.middle, c.middle);
    close(r.end, c.end);
    assert.equal(r.reached, c.reached);
  }
});

test("seated ankle target matches the Python implementation", () => {
  for (const c of cases.seated) {
    const r = seatedAnkleTarget(...c.args);
    close(r.ankle, c.ankle);
    assert.ok(Math.abs(r.thighDropDeg - c.thigh_drop_deg) <= 1e-9);
    assert.equal(r.feetOnFloor, c.feet_on_floor);
  }
});

test("direction clamp matches the Python implementation", () => {
  for (const c of cases.clamp) close(clampDirection(...c.args), c.out);
});

test("reachable chain keeps segment lengths", () => {
  const r = twoBoneIK([0, 1, 0], [0, 0.3, 0.3], 0.45, 0.4, [0, 0, 1]);
  assert.ok(Math.abs(length(sub(r.middle, [0, 1, 0])) - 0.45) < 1e-12);
  assert.ok(Math.abs(length(sub(r.end, r.middle)) - 0.4) < 1e-12);
});

test("degenerate inputs throw", () => {
  assert.throws(() => twoBoneIK([0, 0, 0], [0, 0, 0], 0.4, 0.4, [0, 1, 0]));
  assert.throws(() => twoBoneIK([0, 0, 0], [0, 0, 0.5], 0.4, 0.4, [0, 0, 1]));
});
