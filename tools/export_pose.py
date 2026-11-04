"""Turn a pose made by hand in Blender into poses/<pose_id>.json.

  blender --background POSED_COPY.blend --disable-autoexec --python-exit-code 1 --python tools/export_pose.py -- \
      --pose-id stand_peace --base poses/stand_natural.json --out poses/stand_peace.json

Pose the model in Pose Mode (rotate bones; move only the root bone), set shape keys for the face,
save a COPY of the .blend, then run this. The file is read only and never saved.

How it works: it records every bone you changed, resets the rig to rest, and replays the changes through
the same code the renderer uses (micut_ik.posing.apply_steps), one op per changed bone in hierarchy order.
The replay is compared with your pose, so the JSON reproduces it exactly or the export fails.
Rotations are stored relative to the model's rest pose in character space ([right, up, forward]), and
bones are named by humanoid/finger keys from the model profile, so poses carry over to a new model
with a similar rest pose. Bones outside the profile are exported by raw name and marked model_specific.
"""
import argparse
from datetime import date
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from micut_ik import posing  # noqa: E402
from micut_ik.contracts import ContractError  # noqa: E402

ROT_TOL_DEG, POS_TOL_M = .05, .0005


def hierarchy(arm):
    order, queue = [], [b for b in arm.data.bones if b.parent is None]
    while queue:
        b = queue.pop(0)
        order.append(b.name)
        queue.extend(b.children)
    return order


def rest_scale(rig, target_height):
    rig.arm.data.pose_position = 'REST'
    rig.update()
    verts = rig.vertices()
    sole = min(rig.height(p) for p in posing.foot_points(rig, verts).values())
    height = max(rig.height(v) for v in verts)-sole
    rig.arm.data.pose_position = 'POSE'
    rig.update()
    return target_height/height


def rot_angle_deg(a, b):
    return math.degrees((a.to_quaternion().rotation_difference(b.to_quaternion())).angle)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--pose-id', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--base', help='pose JSON to inherit action, anchor_type, IK modes, look_at from')
    p.add_argument('--action', choices=['stand', 'sit'])
    p.add_argument('--description', default='')
    p.add_argument('--profile', default=str(ROOT/'examples/model_profile.json'))
    p.add_argument('--threshold-deg', type=float, default=.1, help='ignore bone rotations smaller than this')
    args = p.parse_args(sys.argv[sys.argv.index('--')+1:])
    profile = json.loads(Path(args.profile).read_text(encoding='utf-8'))
    base = json.loads(Path(args.base).read_text(encoding='utf-8')) if args.base else {}
    action = args.action or base.get('action') or 'stand'
    anchor_type = {'stand': 'feet_center_on_ground', 'sit': 'pelvis_seat_contact'}[action]
    if base and base.get('action') != action:
        raise ContractError(f"--action {action} conflicts with base action {base.get('action')}")

    arm = bpy.data.objects.get(profile['armature_name'])
    meshes = [bpy.data.objects.get(n) for n in profile['mesh_names']]
    if arm is None or any(m is None for m in meshes):
        raise ContractError('profile armature/mesh names do not match this .blend', 'MODEL_MISMATCH')
    rig = posing.Rig(arm, meshes, profile)
    rig.unit_scale = rest_scale(rig, profile['target_height_m'])
    semantic = {bone: key for key, bone in posing.semantic_bones(profile).items()}

    # 1. Record the hand-made pose.
    order = hierarchy(arm)
    posed = {n: arm.pose.bones[n].matrix.copy() for n in order}
    changed_rot = {n for n in order
                   if math.degrees(arm.pose.bones[n].matrix_basis.to_quaternion().angle) > args.threshold_deg}
    moved = {n for n in order if arm.pose.bones[n].matrix_basis.translation.length*rig.unit_scale > POS_TOL_M}
    blocked = [n for n in moved if arm.pose.bones[n].bone.use_connect]
    shape_values = {}
    for obj in meshes:
        keys = obj.data.shape_keys
        for kb in (keys.key_blocks[1:] if keys else []):
            if kb.value > .01 and not kb.name.startswith('mmd_sdef'):
                shape_values[kb.name] = round(kb.value, 3)

    # 2. Reset to rest and replay through the renderer's own code path, generating ops as we go.
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    rig.update()
    steps, model_specific = [], []
    for name in order:
        key = semantic.get(name, name)
        if name in moved and name not in blocked:
            offset = posed[name].translation-arm.pose.bones[name].head
            char = rig.char_matrix().inverted() @ offset*rig.unit_scale
            steps.append({'op': 'translate', 'bone': key, 'offset': [round(x, 5) for x in char]})
            posing.apply_steps(rig, steps[-1:])
        if name in changed_rot:
            c = rig.char_matrix()
            delta = c.inverted() @ posed[name].to_3x3().normalized() @ arm.pose.bones[name].bone.matrix_local.to_3x3().inverted() @ c
            q = delta.to_quaternion()
            steps.append({'op': 'orient', 'bone': key, 'quat': [round(x, 6) for x in q]})
            posing.apply_steps(rig, steps[-1:])
        if name in changed_rot | moved and key == name:
            model_specific.append(name)
            steps[-1]['model_specific'] = True

    # 3. Verify the replay against the hand-made pose.
    worst_rot = max((rot_angle_deg(arm.pose.bones[n].matrix.to_3x3(), posed[n].to_3x3()) for n in order), default=0.)
    worst_pos = max(((arm.pose.bones[n].head-posed[n].translation).length*rig.unit_scale for n in order), default=0.)
    if worst_rot > ROT_TOL_DEG or worst_pos > POS_TOL_M:
        raise ContractError(f'replay differs from the posed rig: {worst_rot:.3f} deg, {worst_pos*1000:.2f} mm')

    names = {v: k for k, v in profile.get('expressions', {}).items()}
    expressions = {names.get(k, k): v for k, v in shape_values.items()}
    pose = {k: v for k, v in base.items() if k not in ('steps', 'description', 'pose_id', 'expressions', 'source')}
    pose.update({'schema': 'micut.pose/0.1', 'pose_id': args.pose_id, 'action': action, 'anchor_type': anchor_type})
    if action == 'sit':
        pose.setdefault('support_height_m', [0.30, 0.60])
    pose['description'] = args.description or f'Exported from {Path(bpy.data.filepath).name}'
    pose['steps'] = steps
    if expressions:
        pose['expressions'] = expressions
    overridden = []
    if pose.get('legs', {}).get('mode'):
        overridden.append('legs (leg IK re-solves thighs, shins and feet)')
    if pose.get('arms', {}).get('mode'):
        overridden.append('arms and hands (arm IK)')
    if pose.get('look_at'):
        overridden.append('neck, head and eyes (look_at)')
    pose['source'] = {'tool': 'tools/export_pose.py', 'blend': Path(bpy.data.filepath).name, 'date': date.today().isoformat(),
                      'base': Path(args.base).name if args.base else None,
                      'replay_max_error': {'deg': round(worst_rot, 4), 'mm': round(worst_pos*1000, 3)},
                      'model_specific_bones': model_specific, 'ignored_connected_bone_moves': blocked,
                      'overridden_at_render': overridden}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pose, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print('MICUT_POSE_EXPORT', json.dumps({'out': str(out), 'steps': len(steps), 'replay_max_error': pose['source']['replay_max_error'],
                                           'model_specific': model_specific, 'ignored_connected_bone_moves': blocked,
                                           'overridden_at_render': overridden}, ensure_ascii=False))


if __name__ == '__main__':
    main()
