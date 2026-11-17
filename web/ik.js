// Engine-independent IK math, a line-for-line port of micut_ik/ik.py for the three-vrm renderer.
// Plain [x, y, z] arrays; tests/fixtures/ik_cases.json keeps the two implementations identical.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.sqrt(dot(a, a));

export function normalize(a) {
  const n = length(a);
  if (n < 1e-12) throw Error("cannot normalize a zero vector");
  return mul(a, 1 / n);
}

// Two-segment chain (hip-knee-ankle, shoulder-elbow-wrist). pole: side the middle joint bends toward.
// Out of reach: the chain is straightened (too far) or folded to the minimum (too close), reached=false.
export function twoBoneIK(root, target, upperLen, lowerLen, pole, slack = 1e-4) {
  if (upperLen <= 0 || lowerLen <= 0) throw Error("segment lengths must be positive");
  const toTarget = sub(target, root);
  const distance = length(toTarget);
  if (distance < 1e-9) throw Error("target coincides with chain root");
  const axis = mul(toTarget, 1 / distance);
  const lo = Math.abs(upperLen - lowerLen) + slack;
  const hi = upperLen + lowerLen - slack;
  const reached = lo <= distance && distance <= hi;
  const d = Math.min(Math.max(distance, lo), hi);
  let bend = sub(pole, mul(axis, dot(pole, axis)));
  if (length(bend) < 1e-9) throw Error("pole is parallel to the chain axis; bend plane undefined");
  bend = normalize(bend);
  const along = (upperLen ** 2 - lowerLen ** 2 + d ** 2) / (2 * d);
  const height = Math.sqrt(Math.max(upperLen ** 2 - along ** 2, 0));
  const middle = add(add(root, mul(axis, along)), mul(bend, height));
  const end = add(root, mul(axis, d));
  return { middle, end, reached };
}

// Ankle target for sitting with the hip fixed above a seat. Prefers a vertical shin; a close floor
// makes the shin lean forward with a level thigh, a far floor tilts the thigh down up to
// maxThighDropDeg and then lets the feet hang. `forward` must be orthogonal to `up`.
export function seatedAnkleTarget(hip, forward, up, upperLen, lowerLen, ankleFloorHeight, maxThighDropDeg = 20) {
  forward = normalize(forward);
  up = normalize(up);
  const dropNeeded = dot(hip, up) - ankleFloorHeight - lowerLen;
  let sinT = dropNeeded / upperLen;
  const maxSin = Math.sin((maxThighDropDeg * Math.PI) / 180);
  if (sinT <= 0) {
    const knee = add(hip, mul(forward, upperLen));
    const vertical = dot(knee, up) - ankleFloorHeight;
    const horizontal = Math.sqrt(Math.max(lowerLen ** 2 - vertical ** 2, 0));
    const ankle = add(add(knee, mul(forward, horizontal)), mul(up, -vertical));
    return { ankle, thighDropDeg: 0, feetOnFloor: true };
  }
  const feetOnFloor = sinT <= maxSin;
  sinT = Math.min(sinT, maxSin);
  const cosT = Math.sqrt(1 - sinT ** 2);
  const knee = add(hip, add(mul(forward, upperLen * cosT), mul(up, -upperLen * sinT)));
  const ankle = add(knee, mul(up, -lowerLen));
  return { ankle, thighDropDeg: (Math.asin(sinT) * 180) / Math.PI, feetOnFloor };
}

// Rodrigues rotation of v about a unit axis by angle (radians).
export function rotate(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)));
}

// Rotate unit `base` toward unit `desired` by at most maxDeg degrees.
export function clampDirection(base, desired, maxDeg) {
  base = normalize(base);
  desired = normalize(desired);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(base, desired))));
  if (angle <= (maxDeg * Math.PI) / 180 || angle < 1e-9) return desired;
  const axis = cross(base, desired);
  if (length(axis) < 1e-9) return base;
  return rotate(base, normalize(axis), (maxDeg * Math.PI) / 180);
}
