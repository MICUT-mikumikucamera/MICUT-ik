"""Pose presets + IK on a humanoid rig inside Blender. Read-only for the source .blend.

Model specifics (bone and vertex-group names, axes) come only from the model profile, so another
humanoid model needs a new profile, not new code. Pose files describe intent in character space
([right, up, forward]); the code converts that to armature space.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

from . import ik
from .contracts import ContractError

AXES = {'+X': (1, 0, 0), '-X': (-1, 0, 0), '+Y': (0, 1, 0), '-Y': (0, -1, 0), '+Z': (0, 0, 1), '-Z': (0, 0, -1)}
# Joint whose head ends a segment. None means the bone's own tail.
SEGMENT_END = {
    'spine': 'chest', 'chest': 'neck', 'neck': 'head', 'head': None, 'hips': None,
    'left_upper_leg': 'left_lower_leg', 'left_lower_leg': 'left_foot', 'left_foot': 'left_toes',
    'right_upper_leg': 'right_lower_leg', 'right_lower_leg': 'right_foot', 'right_foot': 'right_toes',
    'left_upper_arm': 'left_lower_arm', 'left_lower_arm': 'left_hand', 'left_hand': None,
    'right_upper_arm': 'right_lower_arm', 'right_lower_arm': 'right_hand', 'right_hand': None,
}
SIDES = ('left', 'right')
FINGERS = ('thumb', 'index', 'middle', 'ring', 'little')  # order of profile['fingers'][side]


def semantic_bones(profile):
    """Model-independent bone keys -> bone names: the humanoid map plus left_index_1 style finger keys."""
    names = dict(profile.get('humanoid') or {})
    for side, chains in profile.get('fingers', {}).items():
        for finger, chain in zip(FINGERS, chains):
            names.update({f'{side}_{finger}_{i+1}': bone for i, bone in enumerate(chain)})
    return names


def tup(v):
    return (v[0], v[1], v[2])


def evaluated_vertices(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    result = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            if len(mesh.vertices) != len(obj.data.vertices):
                raise ContractError('topology-changing modifiers require a different foot-group adapter')
            result.extend((obj, v.index, evaluated.matrix_world @ v.co) for v in mesh.vertices)
        finally:
            evaluated.to_mesh_clear()
    return result


class Rig:
    def __init__(self, armature, meshes, profile):
        self.arm, self.meshes, self.profile = armature, meshes, profile
        self.map = semantic_bones(profile)
        self.forward = Vector(AXES[profile['source_forward_axis']])
        self.up = Vector(AXES[profile['source_up_axis']])
        self.right = self.forward.cross(self.up)
        self.to_arm = armature.matrix_world.inverted()
        self.weights = []  # per evaluated vertex, {group name: weight}; same order as evaluated_vertices
        for obj in meshes:
            names = {g.index: g.name for g in obj.vertex_groups}
            self.weights.extend({names[g.group]: g.weight for g in v.groups if g.group in names}
                                for v in obj.data.vertices)
        self.rest_rot = {}
        self.palm_local = {}

    # --- bones -------------------------------------------------------------------------------
    def bone_name(self, key):
        name = self.map.get(key, key)
        if name not in self.arm.pose.bones:
            raise ContractError(f'model profile maps {key!r} to missing bone {name!r}')
        return name

    def pb(self, key):
        return self.arm.pose.bones[self.bone_name(key)]

    def has(self, key):
        return self.map.get(key, key) in self.arm.pose.bones

    def joint(self, key):
        return self.pb(key).head.copy()

    def segment_end(self, key):
        end = SEGMENT_END.get(key)
        return self.joint(end) if end and self.has(end) else self.pb(key).tail.copy()

    def char(self, v):
        """Character-space [right, up, forward] -> armature-space vector."""
        return self.right*v[0]+self.up*v[1]+self.forward*v[2]

    def update(self):
        bpy.context.view_layer.update()

    def rotate_about(self, key, quat, pivot=None):
        pb = self.pb(key)
        pivot = pb.head.copy() if pivot is None else pivot
        pb.matrix = Matrix.Translation(pivot) @ quat.to_matrix().to_4x4() @ Matrix.Translation(-pivot) @ pb.matrix
        self.update()

    def aim(self, key, direction, end=None):
        head = self.joint(key)
        current = (self.segment_end(key) if end is None else end)-head
        if current.length < 1e-9 or Vector(direction).length < 1e-9:
            raise ContractError(f'cannot aim zero-length segment {key!r}')
        self.rotate_about(key, current.rotation_difference(Vector(direction).normalized()))

    def char_matrix(self):
        """Columns = character right, up, forward in armature space."""
        return Matrix((self.right, self.up, self.forward)).transposed()

    def orient(self, key, quat_char):
        """Set a bone's absolute rotation: rest rotation followed by quat_char (character space)."""
        pb = self.pb(key)
        c = self.char_matrix()
        target = c @ Quaternion(quat_char).to_matrix() @ c.inverted() @ pb.bone.matrix_local.to_3x3()
        m = target.to_4x4()
        m.translation = pb.head
        pb.matrix = m
        self.update()

    def translate(self, key, offset):
        pb = self.pb(key)
        if pb.bone.use_connect:
            raise ContractError(f'cannot translate connected bone {pb.name!r}; map {key!r} to an unconnected bone')
        pb.matrix = Matrix.Translation(Vector(offset)) @ pb.matrix
        self.update()

    def capture_rest(self):
        for key in [f'{s}_foot' for s in SIDES]+[f'{s}_hand' for s in SIDES]+['head', 'neck']:
            if self.has(key):
                self.rest_rot[key] = self.pb(key).matrix.to_3x3()
        # Rest palms face the profile's palm normal (T-pose models: down).
        palm = self.char(self.profile.get('rest_palm_normal', [0, -1, 0]))
        for side in SIDES:
            if self.has(f'{side}_hand'):
                self.palm_local[side] = self.pb(f'{side}_hand').matrix.to_3x3().inverted() @ palm

    def restore_rotation(self, key):
        pb = self.pb(key)
        m = self.rest_rot[key].to_4x4()
        m.translation = pb.head
        pb.matrix = m
        self.update()

    def palm_normal(self, side):
        return (self.pb(f'{side}_hand').matrix.to_3x3() @ self.palm_local[side]).normalized()

    def facing_of(self, key):
        """Current direction of the rest-pose character forward, carried by this bone."""
        local = self.rest_rot[key].inverted() @ self.forward
        return (self.pb(key).matrix.to_3x3() @ local).normalized()

    # --- vertices ----------------------------------------------------------------------------
    def vertices(self):
        return [self.to_arm @ co for _, _, co in evaluated_vertices(self.meshes)]

    def select(self, verts, groups, threshold=.3):
        groups = set(groups)
        return [v for v, w in zip(verts, self.weights) if sum(x for g, x in w.items() if g in groups) >= threshold]

    def height(self, v):
        return v.dot(self.up)


# --- pose steps ------------------------------------------------------------------------------
def apply_steps(rig, steps):
    for step in steps:
        op, key = step['op'], step.get('bone')
        if op == 'rotate':
            axis = rig.char(AXIS_NAMES[step['axis']]) if isinstance(step['axis'], str) else rig.char(step['axis'])
            rig.rotate_about(key, Quaternion(axis.normalized(), math.radians(step['deg'])))
        elif op == 'aim':
            rig.aim(key, rig.char(step['dir']))
        elif op == 'translate':
            rig.translate(key, rig.char(step['offset'])/rig.unit_scale)
        elif op == 'orient':
            rig.orient(key, step['quat'])
        else:
            raise ContractError(f'unknown pose op {op!r}')


AXIS_NAMES = {'right': (1, 0, 0), 'up': (0, 1, 0), 'forward': (0, 0, 1)}


def solve_leg(rig, side, target, pole):
    hip, knee, ankle = rig.joint(f'{side}_upper_leg'), rig.joint(f'{side}_lower_leg'), rig.joint(f'{side}_foot')
    mid, end, reached = ik.two_bone_ik(tup(hip), tup(target), (knee-hip).length, (ankle-knee).length, tup(pole))
    rig.aim(f'{side}_upper_leg', Vector(mid)-hip)
    rig.aim(f'{side}_lower_leg', Vector(end)-rig.joint(f'{side}_lower_leg'))
    rig.restore_rotation(f'{side}_foot')
    error = (rig.joint(f'{side}_foot')-Vector(target)).length
    return {'reached': reached, 'ankle_error_m': error*rig.unit_scale}


def solve_arm(rig, side, wrist_target, pole, hand_dir):
    sh, el, wr = rig.joint(f'{side}_upper_arm'), rig.joint(f'{side}_lower_arm'), rig.joint(f'{side}_hand')
    mid, end, reached = ik.two_bone_ik(tup(sh), tup(wrist_target), (el-sh).length, (wr-el).length, tup(pole))
    rig.aim(f'{side}_upper_arm', Vector(mid)-sh)
    rig.aim(f'{side}_lower_arm', Vector(end)-rig.joint(f'{side}_lower_arm'))
    rig.aim(f'{side}_hand', hand_dir)
    return {'reached': reached, 'wrist_error_m': (rig.joint(f'{side}_hand')-Vector(wrist_target)).length*rig.unit_scale}


def twist_palm(rig, side, desired_normal):
    """Twist the hand about its own axis so the palm faces desired_normal as closely as possible."""
    pb = rig.pb(f'{side}_hand')
    axis = (pb.tail-pb.head).normalized()
    cur = rig.palm_normal(side)
    cur_p, want_p = cur-axis*cur.dot(axis), desired_normal-axis*desired_normal.dot(axis)
    if cur_p.length < 1e-6 or want_p.length < 1e-6:
        return
    rig.rotate_about(f'{side}_hand', cur_p.normalized().rotation_difference(want_p.normalized()))


def curl_fingers(rig, deg):
    if not deg:
        return
    for side in SIDES:
        if side not in rig.palm_local:
            continue
        for chain in rig.profile.get('fingers', {}).get(side, []):
            factor = .5 if 'humb' in chain[0] else 1.
            for name in chain:
                if name not in rig.arm.pose.bones:
                    continue
                pb = rig.arm.pose.bones[name]
                axis = (pb.tail-pb.head).normalized().cross(rig.palm_normal(side))
                if axis.length < 1e-6:
                    continue
                rig.rotate_about(name, Quaternion(axis.normalized(), math.radians(deg*factor)))


def look_at(rig, target, limits):
    """Turn neck+head (and eyes) toward target point, all in armature space."""
    eyes = [rig.joint(k) for k in ('left_eye', 'right_eye') if rig.has(k)]
    origin = sum(eyes, Vector())/len(eyes) if eyes else rig.pb('head').tail.copy()
    desired = (target-origin).normalized()
    face = rig.facing_of('head')
    clamped = Vector(ik.clamp_direction(tup(face), tup(desired), limits.get('head_deg', 35)))
    total = face.rotation_difference(clamped)
    share = limits.get('neck_share', .4)
    if rig.has('neck'):
        rig.rotate_about('neck', Quaternion().slerp(total, share))
    face = rig.facing_of('head')
    rig.rotate_about('head', face.rotation_difference(clamped))
    residual = math.degrees(rig.facing_of('head').angle(desired))
    for key in ('left_eye', 'right_eye'):
        if not rig.has(key):
            continue
        pb = rig.pb(key)
        gaze = rig.facing_of('head')
        want = (target-pb.head).normalized()
        turn = Vector(ik.clamp_direction(tup(gaze), tup(want), limits.get('eye_deg', 15)))
        rig.rotate_about(key, gaze.rotation_difference(turn))
    return {'head_residual_deg': residual, 'head_limit_deg': limits.get('head_deg', 35)}


def set_expressions(rig, values):
    names = rig.profile.get('expressions', {})
    applied = {}
    for semantic, value in (values or {}).items():
        shape = names.get(semantic, semantic)  # unmapped keys are raw (model-specific) shape key names
        for obj in rig.meshes:
            keys = obj.data.shape_keys
            if shape and keys and shape in keys.key_blocks:
                keys.key_blocks[shape].value = float(value)
                applied[semantic] = {'shape_key': shape, 'value': float(value)}
    rig.update()
    return applied


def chain_bones(rig, roots):
    order, queue = [], [rig.arm.data.bones[r] for r in roots if r in rig.arm.data.bones]
    while queue:
        b = queue.pop(0)
        order.append(b.name)
        queue.extend(b.children)
    return order


def settle_chains(rig, bones, support_height, margin, passes=2):
    """Lift secondary bones (hair, skirt) so their own vertices stay above the support under them.

    Works on the mesh, not the bone tails: hair tips often run well past the last bone. Each bone is
    swung up about its head, in the vertical plane, just enough to lift its deepest vertex.
    """
    owned = {name: [] for name in bones}
    for i, w in enumerate(rig.weights):
        if w:
            group = max(w, key=w.get)
            if group in owned:
                owned[group].append(i)
    moved, verts = 0, rig.vertices()
    for _ in range(passes):
        changed = False
        for name in bones:
            if not owned[name]:
                continue
            need, worst = max(((support_height(verts[i])+margin-rig.height(verts[i]), i) for i in owned[name]))
            if need <= 0:
                continue
            head = rig.arm.pose.bones[name].head.copy()
            d = verts[worst]-head
            horizontal = d-rig.up*d.dot(rig.up)
            if horizontal.length < 1e-6:
                horizontal = -rig.forward
            r = d.length
            now = math.asin(max(-1., min(1., d.dot(rig.up)/r)))
            goal = math.asin(max(-.98, min(.98, (rig.height(verts[worst])+need-rig.height(head))/r)))
            if goal <= now:
                continue
            axis = horizontal.normalized().cross(rig.up).normalized()
            rig.rotate_about(name, Quaternion(axis, goal-now))
            verts = rig.vertices()
            moved += 1
            changed = True
        if not changed:
            break
    return moved


# --- contacts ---------------------------------------------------------------------------------
def pelvis_contact(rig, verts):
    """Lowest buttock/upper-thigh surface near the hip joints: the seat contact point (armature space)."""
    groups = rig.profile['seat_contact_groups']
    hips = [rig.joint(f'{s}_upper_leg') for s in SIDES]
    centre = (hips[0]+hips[1])/2
    band = rig.profile.get('seat_contact_band', [-0.14, 0.05])  # along forward, source units
    pts = [v for v in rig.select(verts, groups)
           if band[0] <= (v-centre).dot(rig.forward) <= band[1]]
    if not pts:
        raise ContractError('no seat-contact vertices found; check seat_contact_groups in the model profile')
    low = min(rig.height(v) for v in pts)
    near = [v for v in pts if rig.height(v) <= low+.015]
    mean = sum(near, Vector())/len(near)
    # Lateral centre from the hip joints (left/right symmetric), depth from the contact patch.
    lateral = centre.dot(rig.right)
    depth = mean.dot(rig.forward)
    return rig.right*lateral+rig.forward*depth+rig.up*low, len(near)


def thigh_top(rig, verts, side, t=.6):
    hip, knee = rig.joint(f'{side}_upper_leg'), rig.joint(f'{side}_lower_leg')
    axis = knee-hip
    p = hip+axis*t
    near = [v for v in rig.select(verts, rig.profile['proxy_groups'][f'{side}_upper_leg'])
            if abs((v-p).dot(axis.normalized())) < .03]
    top = max(((v-p).dot(rig.up) for v in near), default=.06)
    return p+rig.up*top


def capsules(rig, verts):
    out = {}
    for name, spec in rig.profile.get('proxy_segments', {}).items():
        a = sum((rig.joint(k) for k in spec['from']), Vector())/len(spec['from'])
        b = (sum((rig.joint(k) for k in spec['to']), Vector())/len(spec['to'])
             if spec['to'] != '@tail' else rig.pb(spec['from'][0]).tail.copy())
        pts = rig.select(verts, rig.profile['proxy_groups'][name], .5)
        ab = b-a
        dists = sorted(((v-(a+ab*max(0., min(1., (v-a).dot(ab)/max(ab.length_squared, 1e-12))))).length
                        for v in pts))
        radius = dists[int(.85*(len(dists)-1))] if dists else .03
        out[name] = {'a': a, 'b': b, 'radius': radius, 'vertices': len(pts)}
    return out


# --- top level --------------------------------------------------------------------------------
def apply_pose(rig, pose, scale, rest, support_height_m, camera_src_of):
    """Apply a pose file. Returns (anchor_src, report). camera_src_of(anchor_src) -> camera in armature space."""
    rig.unit_scale = scale
    report = {'pose_id': pose['pose_id'], 'steps': len(pose.get('steps', []))}
    apply_steps(rig, pose.get('steps', []))
    legs = pose.get('legs', {}).get('mode')
    verts = rig.vertices()
    planes = {'floor_src': rest['sole_height']}
    if legs == 'plant_feet':
        pole = rig.forward
        report['legs'] = {s: solve_leg(rig, s, rest['ankles'][s], pole) for s in SIDES}
        verts = rig.vertices()
    elif legs == 'seated':
        cfg = pose['legs']
        for _ in range(3):  # contact depends on thigh pitch, pitch depends on floor depth below contact
            verts = rig.vertices()
            contact, n_contact = pelvis_contact(rig, verts)
            floor = rig.height(contact)-support_height_m/scale
            leg_report = {}
            for side in SIDES:
                hip, knee = rig.joint(f'{side}_upper_leg'), rig.joint(f'{side}_lower_leg')
                ankle = rig.joint(f'{side}_foot')
                fwd = (knee-hip)-rig.up*(knee-hip).dot(rig.up)
                fwd = fwd.normalized() if fwd.length > 1e-6 else rig.forward
                target, drop, on_floor = ik.seated_ankle_target(
                    tup(hip-rig.up*floor), tup(fwd), tup(rig.up), (knee-hip).length, (ankle-knee).length,
                    rest['ankle_height'][side], cfg.get('max_thigh_drop_deg', 15))
                target = Vector(target)+rig.up*floor
                leg_report[side] = {**solve_leg(rig, side, target, rig.forward+rig.up*.3),
                                    'thigh_drop_deg': drop, 'feet_on_floor': on_floor}
        verts = rig.vertices()
        contact, n_contact = pelvis_contact(rig, verts)
        floor = rig.height(contact)-support_height_m/scale
        planes = {'floor_src': floor, 'seat_src': rig.height(contact)}
        report['legs'] = leg_report
        report['seat_contact_vertices'] = n_contact
    anchor_src = (contact if legs == 'seated' else rest_sole_anchor(rig, verts, rest))

    skirt = pose.get('skirt', {}).get('mode')
    if skirt == 'follow_thighs':
        # Front panels drape onto the top of the thighs, side panels fall beside them.
        cfg = pose['skirt']
        for side in SIDES:
            hip, knee = rig.joint(f'{side}_upper_leg'), rig.joint(f'{side}_lower_leg')
            thigh = (knee-hip).normalized()
            out_dir = rig.right*(1 if side == 'right' else -1)
            front = rig.profile['skirt']['front'][side]
            rest_top = thigh_top(rig, verts, side, cfg.get('front_touch_t', .3))+rig.up*cfg.get('cloth_gap', .015)/scale
            rig.aim(front[0], rest_top-rig.joint(front[0]))
            for name in front[1:]:
                rig.aim(name, thigh-rig.up*cfg.get('front_tip_drop', .25))
            side_dirs = cfg.get('side_dirs', [[.45, -1., .25], [.3, -1., .2]])
            for i, name in enumerate(rig.profile['skirt']['side'][side]):
                d = side_dirs[min(i, len(side_dirs)-1)]
                rig.aim(name, out_dir*d[0]+rig.up*d[1]+thigh*d[2])
        verts = rig.vertices()

    arms = pose.get('arms', {}).get('mode')
    if arms == 'hands_on_thighs':
        report['arms'] = {}
        for side in SIDES:
            top = thigh_top(rig, verts, side, pose['arms'].get('thigh_t', .55))
            hip, knee = rig.joint(f'{side}_upper_leg'), rig.joint(f'{side}_lower_leg')
            inward = rig.right*(-1 if side == 'right' else 1)*pose['arms'].get('inward', .015)/scale
            along = (knee-hip).normalized()
            hand_dir = (along-rig.up*.15).normalized()
            wrist = top+inward-hand_dir*pose['arms'].get('wrist_back', .05)/scale+rig.up*pose['arms'].get('lift', .025)/scale
            out_dir = rig.right*(1 if side == 'right' else -1)
            report['arms'][side] = solve_arm(rig, side, wrist, out_dir-rig.forward*.6, hand_dir)
            twist_palm(rig, side, -rig.up)
    curl_fingers(rig, pose.get('finger_curl_deg', 0))

    if pose.get('look_at') == 'camera':
        report['look_at'] = look_at(rig, camera_src_of(anchor_src), pose.get('look_limits', {}))
    report['expressions'] = set_expressions(rig, pose.get('expressions'))

    seat_h = planes.get('seat_src')
    centre = anchor_src
    half = rig.profile.get('seat_half_extent_m', .25)/scale

    def support(point):
        h = planes['floor_src']
        if seat_h is not None:
            d = point-centre
            if abs(d.dot(rig.right)) <= half and abs(d.dot(rig.forward)) <= half:
                h = max(h, seat_h)
        return h
    secondary = chain_bones(rig, rig.profile.get('secondary_roots', []))
    report['settled_secondary_bones'] = settle_chains(rig, secondary, support, rig.profile.get('settle_margin_m', .01)/scale)
    return anchor_src, report, support, planes


def foot_points(rig, verts):
    """Per side: centre of the near-sole vertex bounds, at the lowest sole height (armature space)."""
    feet = {}
    for side in SIDES:
        pts = rig.select(verts, rig.profile['foot_groups'][side], rig.profile['feet_weight_threshold'])
        if not pts:
            raise ContractError(f'{side} sole has no weighted vertices; configure foot groups')
        low = min(rig.height(v) for v in pts)
        near = [v for v in pts if rig.height(v) <= low+.012]
        lo = [min(v[i] for v in near) for i in range(3)]
        hi = [max(v[i] for v in near) for i in range(3)]
        p = Vector([(lo[i]+hi[i])/2 for i in range(3)])
        feet[side] = p-rig.up*rig.height(p)+rig.up*low
    return feet


def rest_sole_anchor(rig, verts, rest=None):
    feet = foot_points(rig, verts)
    a = (feet['left']+feet['right'])/2
    return a-rig.up*rig.height(a)+rig.up*min(rig.height(f) for f in feet.values())
