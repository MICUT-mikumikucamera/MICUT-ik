"""Render every case in a test set, depth-composite the photo cases, and build one comparison sheet.

  uv run --no-project --with numpy --with pillow python tools/run_testset.py \
      --testset examples/testset.json --placement-repo ../MICUT-placement-decision --out outputs/testset

Blender comes from --blender or BLENDER_BIN. Writes <out>/<case>/..., <out>/summary.json and <out>/sheet.png.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TILE = (384, 512)


def render_case(blender, model, case, out):
    cmd = [blender, '--background', str(model), '--disable-autoexec', '--python-exit-code', '1',
           '--python', str(ROOT/'tools/render_stand.py'), '--',
           '--spatial', str(ROOT/case['spatial']), '--placement', str(ROOT/case['placement']), '--out', str(out)]
    if case.get('compose_input'):
        cmd.append('--export-shape')
    if case.get('debug_supports'):
        cmd.append('--debug-supports')
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    return proc.returncode, time.perf_counter()-started, proc.stdout[-2000:]+proc.stderr[-2000:]


def summarize(name, out, wall):
    if (out/'error.json').exists():
        return {'case': name, 'status': 'failed', 'error': json.loads((out/'error.json').read_text(encoding='utf-8'))}
    m = json.loads((out/'model_manifest.json').read_text(encoding='utf-8'))
    r = json.loads((out/'placement_report.json').read_text(encoding='utf-8'))
    pose = m.get('pose_report', {})
    legs, arms = pose.get('legs', {}), pose.get('arms', {})
    row = {'case': name, 'status': r['status'], 'pose_id': m['pose_id'], 'wall_s': round(wall, 1),
           'render_s': r['timing_s']['render'],
           'feet_floor_gap_mm': {s: round(v['floor_gap_m']*1000, 2) for s, v in m['contacts']['feet'].items()},
           'legs_reached': all(v.get('reached', True) for v in legs.values()),
           'feet_on_floor': all(v.get('feet_on_floor', True) for v in legs.values()),
           'arms_reached': all(v.get('reached', True) for v in arms.values()),
           'penetration_vertices': m['penetration_below_support']['vertices'],
           'visible_vertex_fraction': round(r['projection'].get('visible_vertex_fraction', 0), 3),
           'fully_in_frame': r['projection']['fully_in_frame']}
    comp = out/'compose'/'compose_report.json'
    if comp.exists():
        c = json.loads(comp.read_text(encoding='utf-8'))
        row['occluded_fraction'] = c['occluded_fraction']
        row['occluded_by'] = c['occluded_by']
    return row


def tile(out, row):
    for name in ('compose/composite_depth.png', 'character.png'):
        if (out/name).exists():
            im = Image.open(out/name).convert('RGBA')
            break
    else:
        im = Image.new('RGBA', TILE, (255, 200, 200, 255))
    bg = Image.new('RGBA', im.size, (225, 225, 225, 255))
    im = Image.alpha_composite(bg, im).convert('RGB')
    im.thumbnail(TILE)
    canvas = Image.new('RGB', TILE, (255, 255, 255))
    canvas.paste(im, ((TILE[0]-im.width)//2, 0))
    d = ImageDraw.Draw(canvas)
    lines = [row['case'], f"{row['status']}"]
    if row['status'] != 'failed':
        lines.append(f"pen {row['penetration_vertices']} vis {row['visible_vertex_fraction']}")
        if 'occluded_fraction' in row:
            lines.append(f"occluded {row['occluded_fraction']}")
    d.rectangle((0, TILE[1]-16*len(lines)-6, TILE[0], TILE[1]), fill=(0, 0, 0))
    for i, text in enumerate(lines):
        d.text((6, TILE[1]-16*len(lines)-2+16*i), text, fill=(255, 255, 255))
    return canvas


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--testset', default=str(ROOT/'examples/testset.json'))
    p.add_argument('--placement-repo', type=Path)
    p.add_argument('--blender', default=os.environ.get('BLENDER_BIN'))
    p.add_argument('--out', type=Path, default=ROOT/'outputs/testset')
    p.add_argument('--only', nargs='*', help='case names to run')
    args = p.parse_args()
    if not args.blender:
        p.error('set BLENDER_BIN or pass --blender')
    testset = json.loads(Path(args.testset).read_text(encoding='utf-8'))
    rows, tiles = [], []
    for case in testset['cases']:
        if args.only and case['name'] not in args.only:
            continue
        out = args.out/case['name']
        code, wall, log = render_case(args.blender, ROOT/testset['model'], case, out)
        if code == 0 and case.get('compose_input') and args.placement_repo:
            subprocess.run([sys.executable, str(ROOT/'tools/compose_depth.py'), '--placement-repo', str(args.placement_repo),
                            '--input-dir', str(ROOT/case['compose_input']), '--render-dir', str(out),
                            '--out', str(out/'compose')], check=True, capture_output=True)
        row = summarize(case['name'], out, wall)
        if code != 0 and row['status'] != 'failed':
            row = {'case': case['name'], 'status': 'failed', 'log': log}
        rows.append(row)
        tiles.append(tile(out, row))
        print(json.dumps(row, ensure_ascii=False))
    cols = 4
    sheet = Image.new('RGB', (TILE[0]*cols, TILE[1]*((len(tiles)+cols-1)//cols)), (255, 255, 255))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols)*TILE[0], (i//cols)*TILE[1]))
    args.out.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out/'sheet.png')
    (args.out/'summary.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
    print('SHEET', args.out/'sheet.png')
    return 0 if all(r['status'] != 'failed' for r in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
