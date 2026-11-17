"""Turn the PM's preset export (poses.json from the preset workshop) into registered pose files.

  python tools/import_preset_poses.py C:/path/MiCut_27poses/poses.json

Each saved combination becomes poses/<ID>.json with a `baked` block: the final raw-bone transforms
(after the workshop engine's IK, coop sets, fingers and costume fixes), the workshop root transform
(body yaw + sole offset) and the non-zero face morphs. Only the VRM renderer can apply baked poses,
and only to the same model (SHA-256 checked at render time). Rerun this after a new export; it
overwrites the generated files and never touches the hand-written poses.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_SHA256 = 'd82699d2a913397d9761614c917a6305a6121f8654623c1197dcf3a13381a789'
# Workshop base family -> contract action. Jumps need floor below, like standing, so they keep the
# standing contract (anchor = floor point under the feet); the feet are simply above it.
FAMILY_ACTION = {'stand': 'stand', 'air': 'stand'}
BASE_FAMILY = {f'B0{i}': 'stand' for i in range(1, 5)} | {'B13': 'air'}


def r(v, n=7):
    return [round(float(x), n) for x in v]


def convert(pid, e):
    combo = e['combo']
    if combo.get('modelSha256') != MODEL_SHA256:
        raise SystemExit(f'{pid}: exported for model {combo.get("modelSha256")}, not miku.vrm')
    base = combo['base']['id']
    family = BASE_FAMILY.get(base)
    if family is None:
        raise SystemExit(f'{pid}: base {base} has no placement contract yet (only standing and air bases do)')
    morphs = {}
    for mesh in e['mesh_morphs']:
        for name, w in mesh['weights'].items():
            if w:
                if morphs.get(name, w) != w:
                    raise SystemExit(f'{pid}: morph {name} differs between meshes')
                morphs[name] = round(float(w), 6)
    return {
        'schema': 'micut.pose/0.1',
        'pose_id': pid,
        'action': FAMILY_ACTION[family],
        'anchor_type': 'feet_center_on_ground',
        'description': f"{e['name']} (preset workshop v{combo.get('version')}, base {base})",
        'source': {
            'from': 'preset workshop export poses.json (PM, 2026-11-16)',
            'model_sha256': combo['modelSha256'],
            'status': e.get('status'),
            'notices': [n['text'] for n in e.get('notices', [])],
            'gaze': combo.get('gaze'),
            'body_yaw_deg': combo.get('bodyYaw', 0),
            'base': base,
            'airborne': family == 'air',
        },
        'baked': {
            'frame': 'workshop: metres, +Y up, character faces +Z, floor y=0 (same as the VRM scene)',
            'root_transform': {k: r(v) for k, v in e['root_transform'].items()},
            'raw_bones': [[t['name'], r(t['position']), r(t['rotation']), r(t['scale'], 6)]
                          for t in e['raw_bone_transforms']],
            'morphs': morphs,
        },
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('export', type=Path, help='poses.json from the preset workshop export')
    p.add_argument('--out', type=Path, default=ROOT/'poses')
    args = p.parse_args()
    data = json.loads(args.export.read_text(encoding='utf-8'))
    for pid, e in data.items():
        pose = convert(pid, e)
        path = args.out/f'{pid}.json'
        path.write_text(json.dumps(pose, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        print(pid, pose['action'], len(pose['baked']['raw_bones']), 'bones', pose['baked']['morphs'], path.stat().st_size)


if __name__ == '__main__':
    main()
