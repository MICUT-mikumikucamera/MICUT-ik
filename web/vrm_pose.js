// Pose presets + IK on the VRM raw bones (three.js). A port of micut_ik/posing.py.
//
// The VRM is the same rig as the Blender model (same bone names, vertex groups, units), so
// examples/model_profile.json and poses/*.json are used unchanged. Only the axes differ: VRM 1.0 is
// +Y up, +Z forward, so character right = forward x up = -X. "Rig space" is vrm.scene space before
// placement (the placement root is applied afterwards), in source units (metres for this model).
import * as THREE from "three";
import * as ik from "./ik.js";
import { ContractError } from "./vrm_math.js";

export const SIDES = ["left", "right"];
const FINGERS = ["thumb", "index", "middle", "ring", "little"];
const SEGMENT_END = {
  spine: "chest", chest: "neck", neck: "head", head: null, hips: null,
  left_upper_leg: "left_lower_leg", left_lower_leg: "left_foot", left_foot: "left_toes",
  right_upper_leg: "right_lower_leg", right_lower_leg: "right_foot", right_foot: "right_toes",
  left_upper_arm: "left_lower_arm", left_lower_arm: "left_hand", left_hand: null,
  right_upper_arm: "right_lower_arm", right_lower_arm: "right_hand", right_hand: null,
};
const AXIS_NAMES = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1] };
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const arr = (v) => [v.x, v.y, v.z];
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

export function semanticBones(profile) {
  const names = { ...(profile.humanoid || {}) };
  for (const [side, chains] of Object.entries(profile.fingers || {}))
    chains.forEach((chain, f) => chain.forEach((bone, i) => (names[`${side}_${FINGERS[f]}_${i + 1}`] = bone)));
  return names;
}

export class Rig {
  constructor(root, meshes, profile) {
    this.root = root;
    this.meshes = meshes;
    this.profile = profile;
    this.map = semanticBones(profile);
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = this.forward.clone().cross(this.up);
    this.unitScale = 1;
    this.bones = new Map();
    root.traverse((o) => {
      if (o.isBone && !this.bones.has(o.name)) this.bones.set(o.name, o);
    });
    // Per vertex {group: weight}, in vertices() order. Groups are bone names (Blender vertex groups).
    this.weights = [];
    for (const m of meshes) {
      const si = m.geometry.getAttribute("skinIndex"),
        sw = m.geometry.getAttribute("skinWeight");
      const n = m.geometry.getAttribute("position").count;
      for (let i = 0; i < n; i++) {
        const w = {};
        if (m.isSkinnedMesh && si && sw)
          for (let j = 0; j < 4; j++) {
            const x = sw.getComponent(i, j);
            if (x > 0) {
              const name = m.skeleton.bones[si.getComponent(i, j)].name;
              w[name] = (w[name] || 0) + x;
            }
          }
        this.weights.push(w);
      }
    }
    this.restRot = {};
    this.palmLocal = {};
    this.update();
    this.tailLocal = new Map(); // bone name -> rest tail offset in the bone's own frame
    for (const [name, b] of this.bones) this.tailLocal.set(name, this.restTail(name, b));
  }

  // Blender bones have tails, glTF joints do not. Rebuild a rest tail once: hands point at the finger
  // roots, the head points up, other bones at their first child bone (or continue their parent).
  restTail(name, b) {
    const head = b.getWorldPosition(new THREE.Vector3());
    let tail;
    const key = Object.keys(this.map).find((k) => this.map[k] === name);
    if (key === "left_hand" || key === "right_hand") {
      const side = key.split("_")[0];
      const roots = ["index", "middle", "ring", "little"]
        .map((f) => this.bones.get(this.map[`${side}_${f}_1`]))
        .filter(Boolean);
      if (roots.length) {
        tail = new THREE.Vector3();
        for (const r of roots) tail.add(r.getWorldPosition(new THREE.Vector3()));
        tail.multiplyScalar(1 / roots.length);
      }
    } else if (key === "head") tail = head.clone().addScaledVector(this.up, 0.12);
    else if (key === "hips") tail = head.clone().addScaledVector(this.up, -0.1);
    if (!tail) {
      const child = b.children.find((c) => c.isBone);
      if (child) tail = child.getWorldPosition(new THREE.Vector3());
      else if (b.parent?.isBone) {
        const d = head.clone().sub(b.parent.getWorldPosition(new THREE.Vector3()));
        tail = head.clone().addScaledVector(d.lengthSq() > 1e-12 ? d.normalize() : this.up, 0.03);
      } else tail = head.clone().addScaledVector(this.up, 0.05);
    }
    const q = b.getWorldQuaternion(new THREE.Quaternion()).invert();
    return tail.sub(head).applyQuaternion(q);
  }

  // --- bones ---------------------------------------------------------------------------------
  boneName(key) {
    const name = this.map[key] ?? key;
    if (!this.bones.has(name)) throw new ContractError(`model profile maps ${key} to missing bone ${name}`, "MODEL_MISMATCH");
    return name;
  }
  pb(key) {
    return this.bones.get(this.boneName(key));
  }
  has(key) {
    return this.bones.has(this.map[key] ?? key);
  }
  joint(key) {
    return this.pb(key).getWorldPosition(new THREE.Vector3());
  }
  tail(key) {
    const b = this.pb(key);
    const off = this.tailLocal.get(b.name).clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()));
    return b.getWorldPosition(new THREE.Vector3()).add(off);
  }
  segmentEnd(key) {
    const end = SEGMENT_END[key];
    return end && this.has(end) ? this.joint(end) : this.tail(key);
  }
  char(v) {
    return this.right.clone().multiplyScalar(v[0]).addScaledVector(this.up, v[1]).addScaledVector(this.forward, v[2]);
  }
  update() {
    this.root.updateMatrixWorld(true);
  }
  worldQuat(key) {
    return this.pb(key).getWorldQuaternion(new THREE.Quaternion());
  }
  setWorldQuat(key, q) {
    const b = this.pb(key);
    const parent = b.parent.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(parent.invert().multiply(q)).normalize();
    this.update();
  }
  // Rotate a bone (and its children) about its own head by a world-space quaternion.
  rotateAbout(key, q) {
    this.setWorldQuat(key, q.clone().multiply(this.worldQuat(key)));
  }
  aim(key, direction, end = null) {
    const head = this.joint(key);
    const current = (end ?? this.segmentEnd(key)).sub(head);
    if (current.length() < 1e-9 || direction.length() < 1e-9) throw new ContractError(`cannot aim zero-length segment ${key}`);
    this.rotateAbout(key, new THREE.Quaternion().setFromUnitVectors(current.normalize(), direction.clone().normalize()));
  }
  charMatrix() {
    return new THREE.Matrix4().makeBasis(this.right, this.up, this.forward);
  }
  // Absolute rotation: rest rotation followed by quatChar ([w, x, y, z], character space).
  orient(key, quatChar) {
    const c = this.charMatrix();
    const [w, x, y, z] = quatChar;
    const m = c.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(x, y, z, w)));
    m.multiply(c.clone().invert());
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    this.setWorldQuat(key, q.multiply(this.restAll.get(this.boneName(key)).clone()));
  }
  translate(key, offset) {
    const b = this.pb(key);
    const target = b.getWorldPosition(new THREE.Vector3()).add(offset);
    b.position.copy(b.parent.worldToLocal(target));
    this.update();
  }
  captureRest() {
    this.restAll = new Map([...this.bones].map(([n, b]) => [n, b.getWorldQuaternion(new THREE.Quaternion())]));
    for (const key of [...SIDES.map((s) => `${s}_foot`), ...SIDES.map((s) => `${s}_hand`), "head", "neck"])
      if (this.has(key)) this.restRot[key] = this.worldQuat(key);
    const palm = this.char(this.profile.rest_palm_normal || [0, -1, 0]);
    for (const side of SIDES)
      if (this.has(`${side}_hand`))
        this.palmLocal[side] = palm.clone().applyQuaternion(this.worldQuat(`${side}_hand`).invert());
  }
  restoreRotation(key) {
    this.setWorldQuat(key, this.restRot[key].clone());
  }
  palmNormal(side) {
    return this.palmLocal[side].clone().applyQuaternion(this.worldQuat(`${side}_hand`)).normalize();
  }
  facingOf(key) {
    const local = this.forward.clone().applyQuaternion(this.restRot[key].clone().invert());
    return local.applyQuaternion(this.worldQuat(key)).normalize();
  }

  // --- vertices ------------------------------------------------------------------------------
  vertices() {
    this.update();
    const out = [];
    for (const m of this.meshes) {
      const n = m.geometry.getAttribute("position").count;
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3();
        m.getVertexPosition(i, v);
        out.push(v.applyMatrix4(m.matrixWorld));
      }
    }
    return out;
  }
  select(verts, groups, threshold = 0.3) {
    const g = new Set(groups);
    return verts.filter((v, i) => {
      let s = 0;
      for (const [name, x] of Object.entries(this.weights[i])) if (g.has(name)) s += x;
      return s >= threshold;
    });
  }
  height(v) {
    return v.dot(this.up);
  }
}

const shortestArc = (a, b) => new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());

// --- pose steps ----------------------------------------------------------------------------------
export function applySteps(rig, steps) {
  for (const step of steps) {
    const key = step.bone;
    if (step.op === "rotate") {
      const axis = rig.char(typeof step.axis === "string" ? AXIS_NAMES[step.axis] : step.axis).normalize();
      rig.rotateAbout(key, new THREE.Quaternion().setFromAxisAngle(axis, rad(step.deg)));
    } else if (step.op === "aim") rig.aim(key, rig.char(step.dir));
    else if (step.op === "translate") rig.translate(key, rig.char(step.offset).multiplyScalar(1 / rig.unitScale));
    else if (step.op === "orient") rig.orient(key, step.quat);
    else throw new ContractError(`unknown pose op ${step.op}`);
  }
}

export function solveLeg(rig, side, target, pole) {
  const hip = rig.joint(`${side}_upper_leg`),
    knee = rig.joint(`${side}_lower_leg`),
    ankle = rig.joint(`${side}_foot`);
  const r = ik.twoBoneIK(arr(hip), arr(target), knee.distanceTo(hip), ankle.distanceTo(knee), arr(pole));
  rig.aim(`${side}_upper_leg`, V(r.middle).sub(hip));
  rig.aim(`${side}_lower_leg`, V(r.end).sub(rig.joint(`${side}_lower_leg`)));
  rig.restoreRotation(`${side}_foot`);
  return { reached: r.reached, ankle_error_m: rig.joint(`${side}_foot`).distanceTo(target) * rig.unitScale };
}

export function solveArm(rig, side, wristTarget, pole, handDir) {
  const sh = rig.joint(`${side}_upper_arm`),
    el = rig.joint(`${side}_lower_arm`),
    wr = rig.joint(`${side}_hand`);
  const r = ik.twoBoneIK(arr(sh), arr(wristTarget), el.distanceTo(sh), wr.distanceTo(el), arr(pole));
  rig.aim(`${side}_upper_arm`, V(r.middle).sub(sh));
  rig.aim(`${side}_lower_arm`, V(r.end).sub(rig.joint(`${side}_lower_arm`)));
  rig.aim(`${side}_hand`, handDir);
  return { reached: r.reached, wrist_error_m: rig.joint(`${side}_hand`).distanceTo(wristTarget) * rig.unitScale };
}

export function twistPalm(rig, side, desired) {
  const key = `${side}_hand`;
  const axis = rig.tail(key).sub(rig.joint(key)).normalize();
  const cur = rig.palmNormal(side);
  const curP = cur.clone().addScaledVector(axis, -cur.dot(axis));
  const wantP = desired.clone().addScaledVector(axis, -desired.dot(axis));
  if (curP.length() < 1e-6 || wantP.length() < 1e-6) return;
  rig.rotateAbout(key, shortestArc(curP, wantP));
}

export function curlFingers(rig, degrees) {
  if (!degrees) return;
  for (const side of SIDES) {
    if (!rig.palmLocal[side]) continue;
    for (const chain of rig.profile.fingers?.[side] || []) {
      const factor = chain[0].includes("humb") ? 0.5 : 1;
      for (const name of chain) {
        if (!rig.bones.has(name)) continue;
        const axis = rig.tail(name).sub(rig.joint(name)).normalize().cross(rig.palmNormal(side));
        if (axis.length() < 1e-6) continue;
        rig.rotateAbout(name, new THREE.Quaternion().setFromAxisAngle(axis.normalize(), rad(degrees * factor)));
      }
    }
  }
}

export function lookAt(rig, target, limits) {
  const origin = eyeOrigin(rig);
  const desired = target.clone().sub(origin).normalize();
  let face = rig.facingOf("head");
  const clamped = V(ik.clampDirection(arr(face), arr(desired), limits.head_deg ?? 35));
  const total = shortestArc(face, clamped);
  const share = limits.neck_share ?? 0.4;
  if (rig.has("neck")) rig.rotateAbout("neck", new THREE.Quaternion().slerp(total, share));
  face = rig.facingOf("head");
  rig.rotateAbout("head", shortestArc(face, clamped));
  const residual = deg(rig.facingOf("head").angleTo(desired));
  aimEyes(rig, target, limits.eye_deg ?? 15);
  return { head_residual_deg: residual, head_limit_deg: limits.head_deg ?? 35 };
}

// Preset heads were posed to look at the workshop camera (`from`). Turn neck + head by the rotation that
// carries the workshop camera direction onto the real camera direction, both seen from the eyes, so the
// authored tilt and any deliberate offset from the camera stay; the turn is clamped to head_deg. Then
// the eyes look at the real camera within eye_deg of the head facing (same as lookAt).
export function reaimGaze(rig, from, target, limits, clearance = null) {
  const head = limits.head_deg ?? 30;
  const origin = eyeOrigin(rig);
  const a = from.clone().sub(origin).normalize();
  const b = target.clone().sub(origin).normalize();
  const requested = deg(a.angleTo(b));
  const total = shortestArc(a, V(ik.clampDirection(arr(a), arr(b), head)));
  const share = rig.has("neck") ? limits.neck_share ?? 0.4 : 0;
  const keys = share ? ["neck", "head"] : ["head"];
  const start = keys.map((k) => rig.pb(k).quaternion.clone());
  const turn = (f) => {
    keys.forEach((k, i) => rig.pb(k).quaternion.copy(start[i]));
    rig.update();
    if (share) rig.rotateAbout("neck", new THREE.Quaternion().slerp(total, f * share));
    rig.rotateAbout("head", new THREE.Quaternion().slerp(total, f * (1 - share)));
  };
  // Hands held at the face (cheeks, mouth) and arms raised beside it are authored against the workshop
  // head: turn less rather than push the face or bangs through them. clearance() -> deepest arm or hand
  // vertex inside the head or its bangs/side locks.
  // Allowed: the authored overlap or the contact tolerance, whichever is larger, plus a small slack
  // (millimetre grazes of shoulders against the back of the head are invisible).
  let f = 1;
  const allowed = clearance ? Math.max(clearance(), limits.contact_tol ?? 0) + (limits.hand_tol ?? 0) : Infinity;
  turn(1);
  if (clearance && clearance() > allowed) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      turn(mid);
      if (clearance() > allowed) hi = mid;
      else lo = mid;
    }
    f = lo;
    turn(f);
  }
  aimEyes(rig, target, limits.eye_deg ?? 12);
  return {
    mode: "preset_reaim",
    requested_turn_deg: requested,
    applied_turn_deg: f * Math.min(requested, head),
    head_limit_deg: head,
    reduced_for_hands: f < 1,
  };
}

function eyeOrigin(rig) {
  const eyes = ["left_eye", "right_eye"].filter((k) => rig.has(k)).map((k) => rig.joint(k));
  return eyes.length ? eyes.reduce((s, e) => s.add(e), new THREE.Vector3()).multiplyScalar(1 / eyes.length) : rig.tail("head");
}

function aimEyes(rig, target, limitDeg) {
  for (const key of ["left_eye", "right_eye"]) {
    if (!rig.has(key)) continue;
    const gaze = rig.facingOf("head");
    const want = target.clone().sub(rig.joint(key)).normalize();
    const turn = V(ik.clampDirection(arr(gaze), arr(want), limitDeg));
    rig.rotateAbout(key, shortestArc(gaze, turn));
  }
}

// Expressions by morph target name (profile maps semantic -> MMD morph, e.g. smile -> にこり).
// Set directly on the meshes: the VRM expression manager is never updated, so nothing resets them.
export function setExpressions(rig, values) {
  const names = rig.profile.expressions || {};
  const applied = {};
  for (const [semantic, value] of Object.entries(values || {})) {
    const shape = names[semantic] ?? semantic;
    for (const m of rig.meshes) {
      const i = m.morphTargetDictionary?.[shape];
      if (i === undefined) continue;
      m.morphTargetInfluences[i] = Number(value);
      applied[semantic] = { morph_target: shape, value: Number(value) };
    }
  }
  rig.update();
  return applied;
}

function chainBones(rig, roots) {
  const order = [],
    queue = roots.filter((r) => rig.bones.has(r)).map((r) => rig.bones.get(r));
  while (queue.length) {
    const b = queue.shift();
    order.push(b.name);
    queue.push(...b.children.filter((c) => c.isBone));
  }
  return order;
}

// Lift secondary bones (hair, skirt) so their own vertices stay above the support under them.
export function settleChains(rig, bones, supportHeight, margin, passes = 2) {
  const owned = Object.fromEntries(bones.map((n) => [n, []]));
  rig.weights.forEach((w, i) => {
    const names = Object.keys(w);
    if (!names.length) return;
    const group = names.reduce((a, b) => (w[b] > w[a] ? b : a));
    if (owned[group]) owned[group].push(i);
  });
  let moved = 0,
    verts = rig.vertices();
  for (let p = 0; p < passes; p++) {
    let changed = false;
    for (const name of bones) {
      if (!owned[name].length) continue;
      let need = -Infinity,
        worst = -1;
      for (const i of owned[name]) {
        const n = supportHeight(verts[i]) + margin - rig.height(verts[i]);
        if (n > need) [need, worst] = [n, i];
      }
      if (need <= 0) continue;
      const head = rig.bones.get(name).getWorldPosition(new THREE.Vector3());
      const d = verts[worst].clone().sub(head);
      let horizontal = d.clone().addScaledVector(rig.up, -d.dot(rig.up));
      if (horizontal.length() < 1e-6) horizontal = rig.forward.clone().negate();
      const r = d.length();
      const now = Math.asin(Math.max(-1, Math.min(1, d.dot(rig.up) / r)));
      const goal = Math.asin(Math.max(-0.98, Math.min(0.98, (rig.height(verts[worst]) + need - rig.height(head)) / r)));
      if (goal <= now) continue;
      const axis = horizontal.normalize().cross(rig.up).normalize();
      rig.rotateAbout(name, new THREE.Quaternion().setFromAxisAngle(axis, goal - now));
      verts = rig.vertices();
      moved++;
      changed = true;
    }
    if (!changed) break;
  }
  return moved;
}

// --- contacts ----------------------------------------------------------------------------------
export function pelvisContact(rig, verts) {
  const hips = SIDES.map((s) => rig.joint(`${s}_upper_leg`));
  const centre = hips[0].clone().add(hips[1]).multiplyScalar(0.5);
  const band = rig.profile.seat_contact_band || [-0.14, 0.05];
  const pts = rig.select(verts, rig.profile.seat_contact_groups).filter((v) => {
    const f = v.clone().sub(centre).dot(rig.forward);
    return band[0] <= f && f <= band[1];
  });
  if (!pts.length) throw new ContractError("no seat-contact vertices found; check seat_contact_groups", "MODEL_MISMATCH");
  const low = Math.min(...pts.map((v) => rig.height(v)));
  const near = pts.filter((v) => rig.height(v) <= low + 0.015);
  const mean = near.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / near.length);
  const contact = rig.right
    .clone()
    .multiplyScalar(centre.dot(rig.right))
    .addScaledVector(rig.forward, mean.dot(rig.forward))
    .addScaledVector(rig.up, low);
  return [contact, near.length];
}

function thighTop(rig, verts, side, t = 0.6) {
  const hip = rig.joint(`${side}_upper_leg`),
    knee = rig.joint(`${side}_lower_leg`);
  const axis = knee.clone().sub(hip);
  const p = hip.clone().addScaledVector(axis, t);
  const a = axis.clone().normalize();
  const near = rig.select(verts, rig.profile.proxy_groups[`${side}_upper_leg`]).filter((v) => Math.abs(v.clone().sub(p).dot(a)) < 0.03);
  const top = near.length ? Math.max(...near.map((v) => v.clone().sub(p).dot(rig.up))) : 0.06;
  return p.addScaledVector(rig.up, top);
}

export function capsules(rig, verts) {
  const out = {};
  const mean = (keys) => keys.reduce((a, k) => a.add(rig.joint(k)), new THREE.Vector3()).multiplyScalar(1 / keys.length);
  for (const [name, spec] of Object.entries(rig.profile.proxy_segments || {})) {
    const a = mean(spec.from);
    const b = spec.to === "@tail" ? rig.tail(spec.from[0]) : mean(spec.to);
    const pts = rig.select(verts, rig.profile.proxy_groups[name], 0.5);
    const ab = b.clone().sub(a);
    const l2 = Math.max(ab.lengthSq(), 1e-12);
    const dists = pts
      .map((v) => {
        const s = Math.max(0, Math.min(1, v.clone().sub(a).dot(ab) / l2));
        return v.distanceTo(a.clone().addScaledVector(ab, s));
      })
      .sort((x, y) => x - y);
    const radius = dists.length ? dists[Math.floor(0.85 * (dists.length - 1))] : 0.03;
    out[name] = { a, b, radius, vertices: pts.length };
  }
  return out;
}

export function footPoints(rig, verts) {
  const feet = {};
  for (const side of SIDES) {
    const pts = rig.select(verts, rig.profile.foot_groups[side], rig.profile.feet_weight_threshold);
    if (!pts.length) throw new ContractError(`${side} sole has no weighted vertices; configure foot groups`, "MODEL_MISMATCH");
    const low = Math.min(...pts.map((v) => rig.height(v)));
    const near = pts.filter((v) => rig.height(v) <= low + 0.012);
    const box = new THREE.Box3().setFromPoints(near);
    const p = box.getCenter(new THREE.Vector3());
    feet[side] = p.addScaledVector(rig.up, low - rig.height(p));
  }
  return feet;
}

export function restSoleAnchor(rig, verts) {
  const feet = footPoints(rig, verts);
  const a = feet.left.clone().add(feet.right).multiplyScalar(0.5);
  return a.addScaledVector(rig.up, Math.min(...SIDES.map((s) => rig.height(feet[s]))) - rig.height(a));
}

export function restMeasure(rig) {
  const verts = rig.vertices();
  const feet = footPoints(rig, verts);
  const sole = Math.min(...SIDES.map((s) => rig.height(feet[s])));
  const ankles = Object.fromEntries(SIDES.map((s) => [s, rig.joint(`${s}_foot`)]));
  const box = new THREE.Box3().setFromPoints(verts);
  return {
    height: Math.max(...verts.map((v) => rig.height(v))) - sole,
    sole_height: sole,
    ankles,
    ankle_height: Object.fromEntries(SIDES.map((s) => [s, rig.height(ankles[s]) - rig.height(feet[s])])),
    dimensions: arr(box.getSize(new THREE.Vector3())),
  };
}

export function penetration(rig, verts, support, tol) {
  const cats = rig.profile.secondary_categories || {};
  const counts = { hair: 0, skirt: 0, body: 0 };
  const byGroup = {};
  let deepest = 0;
  verts.forEach((v, i) => {
    const depth = support(v) - rig.height(v);
    if (depth <= tol) return;
    const w = rig.weights[i];
    const names = Object.keys(w);
    const group = names.length ? names.reduce((a, b) => (w[b] > w[a] ? b : a)) : "";
    const cat = Object.entries(cats).find(([, prefixes]) => prefixes.some((p) => group.startsWith(p)))?.[0] ?? "body";
    counts[cat]++;
    byGroup[group] = (byGroup[group] || 0) + 1;
    deepest = Math.max(deepest, depth);
  });
  const top = Object.fromEntries(Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 6));
  return [counts, deepest, top];
}

// --- checks.preserve ----------------------------------------------------------------------------------
// The Pose step marks features the clean-up must not change (placement.preserve, e.g. {side: "left",
// part: "fingers", gesture: "peace"} or {side: "both", part: "coop", gesture: "heart"}). Each part maps to
// bones; their transforms relative to the chest are captured right after a workshop pose is applied and
// compared once every clean-up (gaze, hair, seated legs, scene) has run. pass: every bone within
// PRESERVE_DEG and PRESERVE_M; fail otherwise; not_run: unknown part, or not a workshop pose (no
// authored reference). A head/face/gaze part also stops the preset gaze re-aim.
const PRESERVE_DEG = 0.5, PRESERVE_M = 0.002;
const HEAD_PARTS = new Set(["head", "face", "gaze", "neck"]);
const FINGER_NAMES = ["thumb", "index", "middle", "ring", "little"];
function partKeys(rig, side, part) {
  const sides = side === "both" ? SIDES : [side];
  const fingers = (s) => FINGER_NAMES.flatMap((f) => [1, 2, 3].map((i) => `${s}_${f}_${i}`));
  const hand = (s) => [`${s}_hand`, ...fingers(s)];
  const arm = (s) => [`${s}_upper_arm`, `${s}_lower_arm`, ...hand(s)];
  const leg = (s) => [`${s}_upper_leg`, `${s}_lower_leg`, `${s}_foot`];
  const by = {
    fingers: (s) => fingers(s), finger: (s) => fingers(s), hand: hand, hands: hand, wrist: hand,
    arm: arm, arms: arm, coop: arm, leg: leg, legs: leg, feet: leg, foot: leg,
  };
  if (HEAD_PARTS.has(part)) return ["neck", "head", "left_eye", "right_eye"].filter((k) => rig.has(k));
  if (!by[part]) return null;
  return sides.flatMap(by[part]).filter((k) => rig.has(k));
}

function relativeToChest(rig, key) {
  const chest = rig.pb(rig.has("chest") ? "chest" : "hips").matrixWorld;
  return new THREE.Matrix4().copy(chest).invert().multiply(rig.pb(key).matrixWorld);
}

export function captureParts(rig) {
  const keys = new Set();
  for (const part of ["arm", "head", "leg"]) for (const k of partKeys(rig, "both", part) || []) keys.add(k);
  return new Map([...keys].map((k) => [k, relativeToChest(rig, k)]));
}

export function preserveCheck(rig, items) {
  if (!items?.length) return { status: "not_run", reason: "placement has no preserve items", items: [] };
  const out = items.map((item) => {
    const base = { side: item.side, part: item.part, gesture: item.gesture ?? null };
    const keys = partKeys(rig, item.side, item.part);
    if (!keys) return { ...base, status: "not_run", reason: `unknown part ${item.part}` };
    if (!rig.authored) return { ...base, status: "not_run", reason: "not a workshop pose: no authored reference" };
    let deg = 0, move = 0;
    for (const k of keys) {
      const a = rig.authored.get(k), b = relativeToChest(rig, k);
      if (!a) continue;
      const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), pb = new THREE.Vector3(), qb = new THREE.Quaternion(), s = new THREE.Vector3();
      a.decompose(pa, qa, s);
      b.decompose(pb, qb, s);
      deg = Math.max(deg, (qa.angleTo(qb) * 180) / Math.PI);
      move = Math.max(move, pa.distanceTo(pb) * rig.unitScale);
    }
    const ok = deg <= PRESERVE_DEG && move <= PRESERVE_M;
    return { ...base, status: ok ? "pass" : "fail", bones: keys.length, max_turn_deg: deg, max_move_m: move };
  });
  const status = out.some((x) => x.status === "fail") ? "fail" : out.some((x) => x.status === "pass") ? "pass" : "not_run";
  return { status, tolerance: { turn_deg: PRESERVE_DEG, move_m: PRESERVE_M, frame: "relative to the chest" }, items: out };
}

// --- body self-penetration -----------------------------------------------------------------------
// Each vertex gets a class from its dominant vertex group: "hair"/"skirt" (secondary_categories; hair
// outside the secondary chains is "head_hair"), "neck", "shoulder", a proxy segment ("torso",
// "left_lower_arm", ...), or "other". A vertex of an intruder class is inside a host class when its
// nearest host vertex (within `radius`) has the vertex on its inner side:
// (p - q) . n_q < -tol, with n_q the posed vertex normal. Pairs below skip neighbouring segments that
// always touch (shoulder vs torso, thigh vs hip).
function vertexTable(rig) {
  if (rig._table) return rig._table;
  const cats = Object.entries(rig.profile.secondary_categories || {});
  const segOf = {};
  for (const [seg, groups] of Object.entries(rig.profile.proxy_groups || {})) for (const g of groups) segOf[g] = seg;
  const group = [], cls = [], mesh = [], local = [];
  rig.meshes.forEach((m, mi) => {
    const n = m.geometry.getAttribute("position").count;
    for (let i = 0; i < n; i++) mesh.push(mi), local.push(i);
  });
  const chains = new Set(chainBones(rig, rig.profile.secondary_roots || []));
  const neck = rig.has("neck") ? rig.boneName("neck") : null;
  const shoulders = new Set(SIDES.filter((x) => rig.has(`${x}_shoulder`)).map((x) => rig.boneName(`${x}_shoulder`)));
  rig.weights.forEach((w) => {
    const names = Object.keys(w);
    const g = names.length ? names.reduce((a, b) => (w[b] > w[a] ? b : a)) : "";
    group.push(g);
    let c = cats.find(([, prefixes]) => prefixes.some((p) => g.startsWith(p)))?.[0] ?? segOf[g] ?? "other";
    if (c === "hair" && !chains.has(g)) c = "head_hair"; // bangs and side locks: rigid with the head
    if (g === neck) c = "neck"; // joins the shoulders: never a contact host
    if (shoulders.has(g)) c = "shoulder"; // always touches neck and torso: never an intruder
    cls.push(c);
  });
  return (rig._table = { group, cls, mesh, local });
}

export const vertexClass = (rig, i) => vertexTable(rig).cls[i];

function contactPairs() {
  const legs = (s) => [`${s}_upper_leg`, `${s}_lower_leg`, `${s}_foot`];
  const arms = (s) => [`${s}_upper_arm`, `${s}_lower_arm`, `${s}_hand`];
  const hostArms = (s) => [...arms(s), "shoulder"];
  const body = ["torso", "skirt", ...legs("left"), ...legs("right")];
  return [
    ["hair", ["hair"], [...body, ...hostArms("left"), ...hostArms("right")]],
    ["left_arm", ["left_lower_arm", "left_hand"], [...body, ...hostArms("right")]],
    ["right_arm", ["right_lower_arm", "right_hand"], [...body, ...hostArms("left")]],
    ["arms_head", [...arms("left"), ...arms("right")], ["head", "head_hair"]],
    ["legs", ["left_lower_leg", "left_foot"], legs("right")],
  ];
}

function vertexNormals(rig, verts) {
  const normals = verts.map(() => new THREE.Vector3());
  let base = 0;
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const m of rig.meshes) {
    const n = m.geometry.getAttribute("position").count;
    const index = m.geometry.index;
    const tri = index ? index.count / 3 : n / 3;
    for (let f = 0; f < tri; f++) {
      const [a, b, c] = [0, 1, 2].map((k) => base + (index ? index.getX(3 * f + k) : 3 * f + k));
      e1.subVectors(verts[b], verts[a]);
      e2.subVectors(verts[c], verts[a]);
      const fn = e1.cross(e2); // area-weighted
      normals[a].add(fn), normals[b].add(fn), normals[c].add(fn);
    }
    base += n;
  }
  return normals.map((v) => v.normalize());
}

class PointGrid {
  constructor(verts, indices, cell) {
    this.cell = cell;
    this.verts = verts;
    this.map = new Map();
    for (const i of indices) {
      const k = this.key(verts[i]);
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(i);
    }
  }
  key(p, dx = 0, dy = 0, dz = 0) {
    return `${Math.floor(p.x / this.cell) + dx},${Math.floor(p.y / this.cell) + dy},${Math.floor(p.z / this.cell) + dz}`;
  }
  nearest(p, radius) {
    let best = -1, bd = radius * radius;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const i of this.map.get(this.key(p, dx, dy, dz)) || []) {
            const d = p.distanceToSquared(this.verts[i]);
            if (d < bd) [bd, best] = [d, i];
          }
    return best;
  }
}

// Host side of the contact pairs: grid + normals of the host vertices at the current pose (hosts do not
// move while only hair bones turn). hit(pair, p) -> {depth (> 0 inside), host index, host normal} or null.
function contactField(rig, verts, radius, labels = null) {
  const t = vertexTable(rig);
  const normals = vertexNormals(rig, verts);
  const pairs = contactPairs().filter(([label]) => !labels || labels.includes(label)).map(([label, intruders, hosts]) => {
    const hostSet = new Set(hosts);
    const idx = [];
    t.cls.forEach((c, i) => hostSet.has(c) && idx.push(i));
    return { label, intruders: new Set(intruders), grid: new PointGrid(verts, idx, radius) };
  });
  const field = {
    pairs,
    hit(pair, p) {
      const q = pair.grid.nearest(p, radius);
      if (q < 0) return null;
      const depth = -p.clone().sub(verts[q]).dot(normals[q]);
      return { depth, host: q, normal: normals[q] };
    },
  };
  return field;
}

// Deepest intruder vertex of one contact pair (0 when clear).
function deepestInside(rig, label, radius) {
  const verts = rig.vertices();
  const t = vertexTable(rig);
  const field = contactField(rig, verts, radius, [label]);
  const pair = field.pairs[0];
  let deepest = 0;
  verts.forEach((p, i) => {
    if (!pair.intruders.has(t.cls[i])) return;
    const h = field.hit(pair, p);
    if (h) deepest = Math.max(deepest, h.depth);
  });
  return deepest;
}

export function bodyPenetration(rig, verts, tol, radius) {
  const t = vertexTable(rig);
  const field = contactField(rig, verts, radius);
  const out = {};
  for (const pair of field.pairs) {
    const byGroup = {}, hosts = {};
    let count = 0, deepest = 0;
    verts.forEach((p, i) => {
      if (!pair.intruders.has(t.cls[i])) return;
      const h = field.hit(pair, p);
      if (!h || h.depth <= tol) return;
      count++;
      deepest = Math.max(deepest, h.depth);
      byGroup[t.group[i]] = (byGroup[t.group[i]] || 0) + 1;
      hosts[t.cls[h.host]] = (hosts[t.cls[h.host]] || 0) + 1;
    });
    const top = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6));
    out[pair.label] = { vertices: count, deepest, by_group: top(byGroup), into: top(hosts) };
  }
  return out;
}

// Scene pass of the hair clean-up (photo obstacles, web/scene_field.js): a twin tail that hangs into the
// chair back or another object is turned out of it. The depth map has no surface normals, so each
// offending bone (root to tip) tries turns about its head (+-5..50 deg about the character's forward,
// up and right axes) and scores every hair vertex it moves by its summed overlap: inside the photo
// objects, inside the body (same test as clearHair) and below the support. It keeps the smallest turn
// that clears at least 90% (sideways swings first, outward before inward, so tails go over the sides of
// a chair back rather than up toward the camera or behind the back), else the best improvement.
// Returns {turns, overlap_before_m, overlap_after_m} (summed overlap, metres).
export function clearHairScene(rig, bones, support, scene, { radius, margin, tol, scale, passes = 3 }) {
  const t = vertexTable(rig);
  const field = contactField(rig, rig.vertices(), radius, ["hair"]);
  const pair = field.pairs[0];
  const pos = (i) => {
    const m = rig.meshes[t.mesh[i]];
    return m.getVertexPosition(t.local[i], new THREE.Vector3()).applyMatrix4(m.matrixWorld);
  };
  const overlap = (v) => {
    const h = field.hit(pair, v);
    return Math.max(scene(v).gap, h && h.depth > tol ? h.depth : 0, support(v) + margin - rig.height(v), 0);
  };
  const subtree = new Map(), own = new Map();
  for (const name of bones) {
    const names = new Set(chainBones(rig, [name]));
    const idx = [], mine = [];
    t.group.forEach((g, i) => {
      if (t.cls[i] !== "hair") return;
      if (names.has(g)) idx.push(i);
      if (g === name) mine.push(i);
    });
    subtree.set(name, idx);
    own.set(name, mine);
  }
  const cost = (idx) => idx.reduce((s, i) => {
    const o = overlap(pos(i));
    return o > tol ? s + o : s;
  }, 0);
  const all = [...new Set([...subtree.values()].flat())];
  const before = cost(all);
  const objects = {}; // which photo objects the hair started in (vertex counts)
  for (const i of all) {
    const r = scene(pos(i));
    if (r.gap > tol) objects[r.id] = (objects[r.id] || 0) + 1;
  }
  let turns = 0;
  const log = [];
  // forward axis = sideways swing in the body plane (tails over the sides of a chair back), then
  // twist about up, then pitch about right (toward or away from the camera).
  const axes = [rig.forward, rig.up, rig.right];
  const angles = [5, 10, 20, 35, 50].flatMap((a) => [rad(a), -rad(a)]);
  // Lateral distance of a vertex set from the body's centre line: a turn that folds a tail inward (behind
  // the back, out of sight) counts as 90 deg larger, so tails go over the sides of a chair back instead.
  const hips = SIDES.map((sd) => rig.joint(`${sd}_upper_leg`));
  const mid = hips[0].clone().add(hips[1]).multiplyScalar(0.5);
  const lateral = (idx) => idx.reduce((sum, i) => sum + Math.abs(pos(i).sub(mid).dot(rig.right)), 0) / idx.length;
  for (let p = 0; p < passes; p++) {
    let changed = false;
    for (const name of bones) {
      // Bend where the tail meets the object: only a bone whose own vertices are inside turns (with
      // everything below it), so the tail kinks at the contact instead of swinging from the root.
      const idx = subtree.get(name);
      if (!idx.length || cost(own.get(name)) <= tol) continue;
      const now = cost(idx);
      const bone = rig.bones.get(name);
      const start = bone.quaternion.clone();
      const tried = [];
      const lat0 = lateral(idx);
      axes.forEach((axis, rank) => {
        for (const a of angles) {
          bone.quaternion.copy(start);
          rig.update();
          const q = new THREE.Quaternion().setFromAxisAngle(axis, a);
          rig.rotateAbout(name, q);
          tried.push({ c: cost(idx), q, size: Math.abs(a) + (lateral(idx) < lat0 - 0.02 / scale ? rad(90) : 0), rank, a });
        }
      });
      bone.quaternion.copy(start);
      rig.update();
      // Smallest turn that (nearly) clears the bone, sideways swings first; else the best improvement.
      const enough = tried.filter((x) => x.c <= Math.max(now * 0.1, tol)).sort((x, y) => x.size - y.size || x.rank - y.rank);
      const best = enough[0] ?? tried.reduce((x, y) => (y.c < x.c ? y : x), { c: now, q: null });
      if (best.q && best.c < now * 0.9) {
        rig.rotateAbout(name, best.q);
        log.push({ bone: name, axis: ["forward", "up", "right"][best.rank], deg: Math.round(deg(best.a)), overlap_m: now * scale, after_m: best.c * scale });
        turns++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { turns, overlap_before_m: before * scale, overlap_after_m: cost(all) * scale, scene_objects_before: objects, turns_log: log };
}

const hairClearOptions = (rig, scale) => ({
  radius: (rig.profile.hair_clear_radius_m ?? 0.06) / scale,
  margin: (rig.profile.settle_margin_m ?? 0.01) / scale,
  tol: 0.005 / scale,
});

// Turn hair bones (root to tip) just enough that their vertices leave the body and stay above the
// support. Only bones whose own vertices penetrate move, and only by the smallest rotation about their
// head that lifts the deepest vertex out along the host normal (or up, for the support): the authored
// hair direction is kept everywhere else, there is no gravity. Returns the number of bone turns.
export function clearHair(rig, bones, support, { radius, margin, tol, passes = 4, maxTurnDeg = 30 }) {
  const t = vertexTable(rig);
  const field = contactField(rig, rig.vertices(), radius, ["hair"]);
  const pair = field.pairs[0];
  const owned = new Map(bones.map((n) => [n, []]));
  t.group.forEach((g, i) => t.cls[i] === "hair" && owned.has(g) && owned.get(g).push(i));
  const pos = (i) => {
    const m = rig.meshes[t.mesh[i]];
    return m.getVertexPosition(t.local[i], new THREE.Vector3()).applyMatrix4(m.matrixWorld);
  };
  let turns = 0;
  for (let p = 0; p < passes; p++) {
    let changed = false;
    for (const name of bones) {
      const idx = owned.get(name);
      if (!idx.length) continue;
      let worst = null;
      for (const i of idx) {
        const v = pos(i);
        const h = field.hit(pair, v);
        if (h && h.depth > tol && (!worst || h.depth > worst.depth)) worst = { v, depth: h.depth, dir: h.normal };
        const below = support(v) + margin - rig.height(v);
        if (below > tol && (!worst || below > worst.depth)) worst = { v, depth: below, dir: rig.up };
      }
      if (!worst) continue;
      const head = rig.bones.get(name).getWorldPosition(new THREE.Vector3());
      const from = worst.v.clone().sub(head);
      const to = worst.v.clone().addScaledVector(worst.dir, worst.depth + margin).sub(head);
      if (from.length() < 1e-6) continue;
      let q = shortestArc(from, to);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (angle > rad(maxTurnDeg)) q = new THREE.Quaternion().slerp(q, rad(maxTurnDeg) / angle);
      rig.rotateAbout(name, q);
      turns++;
      changed = true;
    }
    if (!changed) break;
  }
  return turns;
}

// --- top level ---------------------------------------------------------------------------------
// Returns {anchorSrc, report, support, planes}. cameraSrcOf(anchorSrc) -> camera position in rig space.
export function applyPose(rig, pose, scale, rest, supportHeightM, cameraSrcOf, sceneOf = null, preserve = []) {
  if (pose.baked) return applyBaked(rig, pose, scale, supportHeightM, cameraSrcOf, sceneOf, preserve);
  rig.unitScale = scale;
  const report = { pose_id: pose.pose_id, steps: (pose.steps || []).length };
  applySteps(rig, pose.steps || []);
  const legs = pose.legs?.mode;
  let verts = rig.vertices();
  let planes = { floor_src: rest.sole_height };
  let anchorSrc;
  if (legs === "plant_feet") {
    report.legs = Object.fromEntries(SIDES.map((s) => [s, solveLeg(rig, s, rest.ankles[s], rig.forward)]));
    verts = rig.vertices();
  } else if (legs === "seated") {
    const cfg = pose.legs;
    let legReport = {};
    for (let it = 0; it < 3; it++) {
      // contact depends on thigh pitch, pitch depends on floor depth below contact
      verts = rig.vertices();
      const [contact] = pelvisContact(rig, verts);
      const floor = rig.height(contact) - supportHeightM / scale;
      legReport = {};
      for (const side of SIDES) {
        const hip = rig.joint(`${side}_upper_leg`),
          knee = rig.joint(`${side}_lower_leg`),
          ankle = rig.joint(`${side}_foot`);
        let fwd = knee.clone().sub(hip);
        fwd.addScaledVector(rig.up, -fwd.dot(rig.up));
        fwd = fwd.length() > 1e-6 ? fwd.normalize() : rig.forward.clone();
        const r = ik.seatedAnkleTarget(
          arr(hip.clone().addScaledVector(rig.up, -floor)), arr(fwd), arr(rig.up),
          knee.distanceTo(hip), ankle.distanceTo(knee), rest.ankle_height[side], cfg.max_thigh_drop_deg ?? 15);
        const target = V(r.ankle).addScaledVector(rig.up, floor);
        legReport[side] = {
          ...solveLeg(rig, side, target, rig.forward.clone().addScaledVector(rig.up, 0.3)),
          thigh_drop_deg: r.thighDropDeg,
          feet_on_floor: r.feetOnFloor,
        };
      }
    }
    verts = rig.vertices();
    const [contact, nContact] = pelvisContact(rig, verts);
    const floor = rig.height(contact) - supportHeightM / scale;
    planes = { floor_src: floor, seat_src: rig.height(contact) };
    report.legs = legReport;
    report.seat_contact_vertices = nContact;
    anchorSrc = contact;
  }
  if (!anchorSrc) anchorSrc = restSoleAnchor(rig, verts);

  if (pose.skirt?.mode === "follow_thighs") {
    // Front panels drape onto the top of the thighs, side panels fall beside them.
    const cfg = pose.skirt;
    for (const side of SIDES) {
      const hip = rig.joint(`${side}_upper_leg`),
        knee = rig.joint(`${side}_lower_leg`);
      const thigh = knee.clone().sub(hip).normalize();
      const outDir = rig.right.clone().multiplyScalar(side === "right" ? 1 : -1);
      const front = rig.profile.skirt.front[side];
      const restTop = thighTop(rig, verts, side, cfg.front_touch_t ?? 0.3).addScaledVector(rig.up, (cfg.cloth_gap ?? 0.015) / scale);
      rig.aim(front[0], restTop.sub(rig.joint(front[0])));
      for (const name of front.slice(1)) rig.aim(name, thigh.clone().addScaledVector(rig.up, -(cfg.front_tip_drop ?? 0.25)));
      const sideDirs = cfg.side_dirs || [[0.45, -1, 0.25], [0.3, -1, 0.2]];
      rig.profile.skirt.side[side].forEach((name, i) => {
        const d = sideDirs[Math.min(i, sideDirs.length - 1)];
        rig.aim(name, outDir.clone().multiplyScalar(d[0]).addScaledVector(rig.up, d[1]).addScaledVector(thigh, d[2]));
      });
    }
    verts = rig.vertices();
  }

  if (pose.arms?.mode === "hands_on_thighs") {
    report.arms = {};
    const cfg = pose.arms;
    for (const side of SIDES) {
      const top = thighTop(rig, verts, side, cfg.thigh_t ?? 0.55);
      const hip = rig.joint(`${side}_upper_leg`),
        knee = rig.joint(`${side}_lower_leg`);
      const inward = rig.right.clone().multiplyScalar(((side === "right" ? -1 : 1) * (cfg.inward ?? 0.015)) / scale);
      const along = knee.clone().sub(hip).normalize();
      const handDir = along.clone().addScaledVector(rig.up, -0.15).normalize();
      const wrist = top
        .add(inward)
        .addScaledVector(handDir, -(cfg.wrist_back ?? 0.05) / scale)
        .addScaledVector(rig.up, (cfg.lift ?? 0.025) / scale);
      const outDir = rig.right.clone().multiplyScalar(side === "right" ? 1 : -1);
      report.arms[side] = solveArm(rig, side, wrist, outDir.addScaledVector(rig.forward, -0.6), handDir);
      twistPalm(rig, side, rig.up.clone().negate());
    }
  }
  curlFingers(rig, pose.finger_curl_deg || 0);

  if (pose.look_at === "camera") report.look_at = lookAt(rig, cameraSrcOf(anchorSrc), pose.look_limits || {});
  report.expressions = setExpressions(rig, pose.expressions);

  const seatH = planes.seat_src;
  const centre = anchorSrc.clone();
  const half = (rig.profile.seat_half_extent_m ?? 0.25) / scale;
  const support = (point) => {
    let h = planes.floor_src;
    if (seatH !== undefined) {
      const d = point.clone().sub(centre);
      if (Math.abs(d.dot(rig.right)) <= half && Math.abs(d.dot(rig.forward)) <= half) h = Math.max(h, seatH);
    }
    return h;
  };
  const secondary = chainBones(rig, rig.profile.secondary_roots || []);
  report.settled_secondary_bones = settleChains(rig, secondary, support, (rig.profile.settle_margin_m ?? 0.01) / scale);
  report.hair_clear_turns = clearHair(rig, secondary, support, hairClearOptions(rig, scale));
  if (sceneOf) report.hair_scene_clear = clearHairScene(rig, secondary, support, sceneOf(anchorSrc), { ...hairClearOptions(rig, scale), scale });
  return { anchorSrc, report, support, planes };
}

// Preset-workshop poses (poses/<ID>.json from tools/import_presets.mjs, or a pose_ref converted by
// web/preset_pose.js): the workshop engine already solved IK, coop sets, fingers and costume, so its
// final raw-bone transforms are applied as they are. The workshop root transform (body yaw + sole
// offset) goes on vrm.scene, so rig space becomes the workshop frame: floor y=0, character facing +Z.
// The placement root then turns +Z to the requested facing, and body yaw stays relative to it.
// Anchor: standing, below the feet centre on that floor; seated, the pelvis seat contact, with the legs
// re-fitted to the real seat height (seatBakedLegs).
function applyBaked(rig, pose, scale, supportHeightM, cameraSrcOf, sceneOf = null, preserve = []) {
  rig.unitScale = scale;
  const { root_transform: rt, raw_bones: bones, morphs } = pose.baked;
  for (const [name, p, q, s] of bones) {
    const b = rig.bones.get(name);
    if (!b) throw new ContractError(`preset ${pose.pose_id}: model has no bone ${name}`, "MODEL_MISMATCH");
    b.position.fromArray(p);
    b.quaternion.fromArray(q);
    b.scale.fromArray(s);
  }
  rig.root.position.fromArray(rt.position);
  rig.root.quaternion.fromArray(rt.rotation);
  rig.root.scale.fromArray(rt.scale);
  const applied = {};
  for (const m of rig.meshes) {
    if (!m.morphTargetInfluences) continue;
    m.morphTargetInfluences.fill(0);
    for (const [name, w] of Object.entries(morphs)) {
      const i = m.morphTargetDictionary?.[name];
      if (i === undefined) continue;
      m.morphTargetInfluences[i] = w;
      applied[name] = { morph_target: name, value: w };
    }
  }
  const missing = Object.keys(morphs).filter((n) => !applied[n]);
  if (missing.length) throw new ContractError(`preset ${pose.pose_id}: model lacks morphs ${missing}`, "MODEL_MISMATCH");
  rig.update();
  rig.authored = captureParts(rig); // the pose as authored, before any clean-up (checks.preserve)
  const seated = pose.action === "sit";
  let anchorSrc, seat, support, planes;
  if (seated) {
    seat = seatBakedLegs(rig, pose, scale, supportHeightM, sceneOf);
    anchorSrc = seat.contact;
    support = seatSupport(rig, anchorSrc, seat.floor, rig.height(anchorSrc), scale);
    planes = { floor_src: seat.floor, seat_src: rig.height(anchorSrc) };
  } else {
    const standing = footPoints(rig, rig.vertices());
    anchorSrc = standing.left.clone().add(standing.right).multiplyScalar(0.5);
    anchorSrc.y = 0; // workshop floor
    support = () => 0;
    planes = { floor_src: 0 };
  }
  const feet = footPoints(rig, rig.vertices());
  // Head and neck only: the feet (and so the anchor) do not move.
  const gaze = pose.source?.gaze;
  const keepHead = preserve.some((x) => HEAD_PARTS.has(x.part));
  const lookAtReport = keepHead
    ? { mode: "preset_as_authored", reason: "placement preserve keeps the head" }
    : gaze?.target === "camera" && gaze.point
      ? reaimGaze(rig, V(gaze.point), cameraSrcOf(anchorSrc), { contact_tol: 0.01 / scale, hand_tol: 0.002 / scale, ...rig.profile.preset_look_limits },
          () => deepestInside(rig, "arms_head", 0.04 / scale))
      : { mode: "preset_as_authored", target: gaze?.target ?? null };
  // The workshop leaves the twin tails at rest: keep that look, only turn them out of the body.
  const hairBones = chainBones(rig, rig.profile.secondary_roots || []);
  const hairTurns = clearHair(rig, hairBones, support, hairClearOptions(rig, scale));
  const hairScene = sceneOf ? clearHairScene(rig, hairBones, support, sceneOf(anchorSrc), { ...hairClearOptions(rig, scale), scale }) : null;
  const soles = Object.fromEntries(SIDES.map((s) => [s, (feet[s].y - planes.floor_src) * scale]));
  const report = {
    pose_id: pose.pose_id,
    baked: true,
    source_status: pose.source?.status,
    notices: pose.source?.notices || [],
    body_yaw_deg: pose.source?.body_yaw_deg ?? 0,
    sole_height_above_floor_m: soles,
    expressions: applied,
    look_at: lookAtReport,
    hair_clear_turns: hairTurns,
    ...(hairScene ? { hair_scene_clear: hairScene } : {}),
  };
  report.airborne = Boolean(pose.source?.airborne);
  if (seated) {
    report.legs = seat.legs;
    report.seat_contact_vertices = seat.contactVertices;
    report.seat = {
      workshop_seat_height_m: pose.source?.seat?.workshop_seat_height_m ?? null,
      seat_height_m: supportHeightM,
      feet_on_floor_requested: seat.feetOnFloor,
    };
  } else if (!report.airborne) {
    // Standing presets must already stand on the workshop floor; report rather than move anything.
    report.legs = Object.fromEntries(SIDES.map((s) => [s, { reached: true, feet_on_floor: Math.abs(soles[s]) < 0.02 }]));
  }
  return { anchorSrc, report, support, planes };
}

// Floor everywhere, plus the seat plane inside +-seat_half_extent_m of the seat contact.
function seatSupport(rig, centre, floor, seatH, scale) {
  const half = (rig.profile.seat_half_extent_m ?? 0.25) / scale;
  return (point) => {
    const d = point.clone().sub(centre);
    return Math.abs(d.dot(rig.right)) <= half && Math.abs(d.dot(rig.forward)) <= half ? Math.max(floor, seatH) : floor;
  };
}

// Seated presets (chair bases) were posed on the workshop chair. The pelvis contact goes on the real
// seat and the upper body, arms and authored foot orientation stay; only the legs move, in this order:
//  1. the shin turns about the knee (in the leg plane) until the sole reaches the real floor: a lower
//     seat swings the feet forward, the thighs (and hands resting on them) stay put;
//  2. if a vertical shin is still too short (higher seat), the thigh tilts down about the hip, at most
//     preset_max_thigh_drop_deg (15) and never deeper into the seat plane than authored (or 1.5 cm);
//  3. what is left hangs: feet_on_floor=false.
// Dangling-leg bases (source.seat.feet_on_floor false, e.g. a high seat) are only lifted out of the floor.
function seatBakedLegs(rig, pose, scale, seatHeightM, sceneOf = null) {
  const feetOnFloor = pose.source?.seat?.feet_on_floor ?? true;
  const maxDrop = rad(rig.profile.preset_max_thigh_drop_deg ?? 15);
  const tol = 0.002 / scale;
  const t = vertexTable(rig);
  const pos = (i) => {
    const m = rig.meshes[t.mesh[i]];
    return m.getVertexPosition(t.local[i], new THREE.Vector3()).applyMatrix4(m.matrixWorld);
  };
  const weighted = (groups, threshold) => {
    const g = new Set(groups);
    const out = [];
    rig.weights.forEach((w, i) => {
      let x = 0;
      for (const [name, v] of Object.entries(w)) if (g.has(name)) x += v;
      if (x >= threshold) out.push(i);
    });
    return out;
  };
  const soleIdx = Object.fromEntries(SIDES.map((s) => [s, weighted(rig.profile.foot_groups[s], rig.profile.feet_weight_threshold ?? 0.3)]));
  const thighIdx = Object.fromEntries(SIDES.map((s) => [s, weighted(rig.profile.proxy_groups[`${s}_upper_leg`], 0.5)]));
  const sole = (side) => Math.min(...soleIdx[side].map((i) => rig.height(pos(i))));
  const pitch = (side) => {
    const d = rig.joint(`${side}_lower_leg`).sub(rig.joint(`${side}_upper_leg`)).normalize();
    return Math.asin(Math.max(-1, Math.min(1, -d.dot(rig.up))));
  };

  const verts = rig.vertices();
  const [contact, contactVertices] = pelvisContact(rig, verts);
  const seatH = rig.height(contact);
  const floor = seatH - seatHeightM / scale;
  const inSeat = seatSupport(rig, contact, -Infinity, seatH, scale);
  const seatDepth = (side) => Math.max(0, ...thighIdx[side].map((i) => pos(i)).map((v) => inSeat(v) - rig.height(v)));

  const legs = {};
  for (const side of SIDES) {
    const footQuat = rig.worldQuat(`${side}_foot`);
    const pitch0 = pitch(side);
    const allowedSeat = Math.max(seatDepth(side), 0.015 / scale);
    const fwd0 = rig.joint(`${side}_foot`).dot(rig.forward);
    const start = sole(side);
    const need = start - floor; // + : sole above the real floor, - : inside it
    const report = { reached: true, moved_m: 0, shin_turn_deg: 0, thigh_drop_deg: 0 };
    legs[side] = report;
    if ((feetOnFloor ? Math.abs(need) : -need) <= tol) continue;
    const upper = rig.pb(`${side}_upper_leg`), lower = rig.pb(`${side}_lower_leg`);
    const q0 = [upper.quaternion.clone(), lower.quaternion.clone()];
    const legAxis = () => {
      const hip = rig.joint(`${side}_upper_leg`), knee = rig.joint(`${side}_lower_leg`), ankle = rig.joint(`${side}_foot`);
      const a = knee.clone().sub(hip).cross(ankle.clone().sub(knee));
      return a.length() > 1e-6 ? a.normalize() : rig.right.clone();
    };
    const setLeg = (drop, turn) => {
      upper.quaternion.copy(q0[0]);
      lower.quaternion.copy(q0[1]);
      rig.update();
      const axis = legAxis();
      if (drop) {
        const knee = rig.joint(`${side}_lower_leg`).sub(rig.joint(`${side}_upper_leg`));
        const pitchAxis = rig.up.clone().cross(knee); // positive angle tilts the thigh down
        rig.rotateAbout(`${side}_upper_leg`, new THREE.Quaternion().setFromAxisAngle(
          pitchAxis.length() > 1e-6 ? pitchAxis.normalize() : rig.right.clone(), drop));
      }
      if (turn) rig.rotateAbout(`${side}_lower_leg`, new THREE.Quaternion().setFromAxisAngle(axis, turn));
      rig.setWorldQuat(`${side}_foot`, footQuat.clone());
      return sole(side);
    };
    // Shin turn that puts the sole on the floor with the thigh at `drop`: scan, then bisect the crossing
    // nearest to the authored shin. Raising a foot (lower seat) never tucks it back under the seat.
    const shin = (drop) => {
      const step = rad(3), samples = [];
      for (let a = -rad(90); a <= rad(90) + 1e-9; a += step) samples.push([a, setLeg(drop, a) - floor]);
      let best = null, lowest = samples[0];
      for (let i = 0; i + 1 < samples.length; i++) {
        if (samples[i][1] < lowest[1]) lowest = samples[i];
        const [a0, h0] = samples[i], [a1, h1] = samples[i + 1];
        if ((h0 > 0) === (h1 > 0)) continue;
        let lo = a0, hi = a1;
        for (let k = 0; k < 14; k++) {
          const mid = (lo + hi) / 2;
          if ((setLeg(drop, mid) - floor > 0) === (h0 > 0)) lo = mid;
          else hi = mid;
        }
        const a = (lo + hi) / 2;
        setLeg(drop, a);
        const fwd = rig.joint(`${side}_foot`).dot(rig.forward);
        if (need < 0 && fwd < fwd0 - 0.01 / scale) continue;
        if (!best || Math.abs(a) < Math.abs(best.a)) best = { a, fwd };
      }
      if (samples[samples.length - 1][1] < lowest[1]) lowest = samples[samples.length - 1];
      return best ? { turn: best.a, reached: true } : { turn: lowest[0], reached: false };
    };
    let drop = 0;
    let r = feetOnFloor || need < 0 ? shin(0) : { turn: 0, reached: true };
    if (!r.reached && need > 0) {
      // Higher seat: tilt the thigh down while the seat plane allows, then hang.
      const ok = (d) => {
        const s = shin(d);
        setLeg(d, s.turn);
        return { s, fits: seatDepth(side) <= allowedSeat && pitch(side) - pitch0 <= maxDrop + 1e-6 };
      };
      let lo = 0, hi = maxDrop;
      let best = { d: 0, s: r };
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        const { s, fits } = ok(mid);
        if (!fits) hi = mid;
        else if (s.reached) {
          best = { d: mid, s }; // reaches: look for a smaller drop
          hi = mid;
        } else {
          if (!best.s.reached) best = { d: mid, s }; // deepest drop that still fits
          lo = mid;
        }
      }
      drop = best.d;
      r = best.s;
    }
    setLeg(drop, r.turn);
    report.reached = r.reached;
    report.shin_turn_deg = deg(r.turn);
    report.thigh_drop_deg = deg(pitch(side) - pitch0);
    report.moved_m = Math.abs(sole(side) - start) * scale;
  }
  // Photo obstacles (chair legs, the seat front): a shin or foot inside one swings forward about the knee,
  // by the smallest turn (3..30 deg) that clears 90% of it without pushing the sole into the floor.
  if (sceneOf) {
    const scene = sceneOf(contact);
    for (const side of SIDES) {
      const idx = weighted([...rig.profile.proxy_groups[`${side}_lower_leg`], ...rig.profile.foot_groups[side]], 0.5);
      const over = () => idx.reduce((sum, i) => {
        const g = scene(pos(i)).gap;
        return g > tol ? sum + g : sum;
      }, 0);
      const now = over();
      legs[side].scene_overlap_before_m = now * scale;
      if (now <= tol) continue;
      const lower = rig.pb(`${side}_lower_leg`);
      const q0 = lower.quaternion.clone();
      const footQuat = rig.worldQuat(`${side}_foot`);
      const hip = rig.joint(`${side}_upper_leg`), knee = rig.joint(`${side}_lower_leg`), ankle = rig.joint(`${side}_foot`);
      let axis = knee.clone().sub(hip).cross(ankle.clone().sub(knee));
      axis = axis.length() > 1e-6 ? axis.normalize() : rig.right.clone();
      const fwd0 = ankle.dot(rig.forward);
      const turn = (a) => {
        lower.quaternion.copy(q0);
        rig.update();
        rig.rotateAbout(`${side}_lower_leg`, new THREE.Quaternion().setFromAxisAngle(axis, a));
        rig.setWorldQuat(`${side}_foot`, footQuat.clone());
      };
      turn(rad(3));
      const sign = rig.joint(`${side}_foot`).dot(rig.forward) >= fwd0 ? 1 : -1; // swing the foot forward
      let best = { a: 0, c: now };
      for (let d = 3; d <= 30; d += 3) {
        turn(sign * rad(d));
        if (sole(side) < floor - tol) break;
        const c = over();
        if (c < best.c) best = { a: sign * rad(d), c };
        if (c <= Math.max(now * 0.1, tol)) break;
      }
      turn(best.a);
      legs[side].scene_shin_turn_deg = deg(best.a);
      legs[side].scene_overlap_after_m = best.c * scale;
    }
  }
  for (const side of SIDES) {
    legs[side].sole_gap_m = (sole(side) - floor) * scale;
    legs[side].feet_on_floor = Math.abs(legs[side].sole_gap_m) < 0.02;
  }
  return { contact, contactVertices, floor, legs, feetOnFloor };
}
