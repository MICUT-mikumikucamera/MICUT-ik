"""Render every registered pose in one scene with the VRM renderer, composite, and build a contact sheet.

  uv run --no-project --with numpy --with pillow --with OpenEXR python tools/pose_sheet.py \
      --geometry-dir local/geometry/sample1 --out outputs/pose_sheet [--photo PHOTO --render-scale S] [--poses MV01,MV05]

Standing poses use --stand placement, seated poses --sit placement (pose_id replaced per pose). Writes
<out>/<pose>/{render,final}/..., <out>/summary.json (timing, status, warnings, pass regions, penetration,
foot data, body overlaps, gaze per pose) and <out>/sheet.jpg. Use it after any renderer change: every pose must render, with
the same settings, in comparable time.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
CELL = (300, 400)


def run(cmd, timeout):
    t = time.perf_counter()
    try:
        p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding='utf-8', errors='replace',
                           timeout=timeout)
        code, log = p.returncode, p.stdout[-1500:]+p.stderr[-1500:]
    except subprocess.TimeoutExpired:
        code, log = 'timeout', f'killed after {timeout} s'
    return code, round(time.perf_counter()-t, 2), log


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--geometry-dir', type=Path, default=ROOT/'local/geometry/sample1')
    p.add_argument('--photo', type=Path, help='default: <geometry-dir>/image.jpg')
    p.add_argument('--render-scale', default='1')
    p.add_argument('--stand', type=Path, default=ROOT/'examples/placement.sample1.stand.json')
    p.add_argument('--sit', type=Path, default=ROOT/'examples/placement.sample1.sit.json')
    p.add_argument('--poses', help='comma-separated pose_ids (default: all registered)')
    p.add_argument('--timeout', type=int, default=900, help='seconds per render (the renderer has its own watchdog)')
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    poses = {}
    for f in sorted((ROOT/'poses').glob('*.json')):
        d = json.loads(f.read_text(encoding='utf-8'))
        poses[d['pose_id']] = d
    ids = args.poses.split(',') if args.poses else list(poses)
    photo = args.photo or args.geometry_dir/'image.jpg'
    args.out.mkdir(parents=True, exist_ok=True)
    summary = []
    for pid in ids:
        pose = poses[pid]
        base = json.loads((args.sit if pose['action'] == 'sit' else args.stand).read_text(encoding='utf-8'))
        base['pose_id'] = pid
        case = args.out/pid
        case.mkdir(exist_ok=True)
        (case/'placement.json').write_text(json.dumps(base, indent=2), encoding='utf-8')
        rd, fd = case/'render', case/'final'
        code, wall, log = run(['node', ROOT/'tools/render_vrm.mjs', '--spatial', args.geometry_dir/'spatial_info.json',
                               '--placement', case/'placement.json', '--photo', photo, '--render-scale', args.render_scale,
                               '--out', rd], args.timeout)
        row = {'pose_id': pid, 'action': pose['action'], 'baked': 'baked' in pose, 'render_exit': code, 'render_wall_s': wall}
        if code == 0:
            fcode, fwall, flog = run([sys.executable, ROOT/'tools/finalize.py', '--render-dir', rd, '--geometry-dir',
                                      args.geometry_dir, '--photo', photo, '--out', fd], args.timeout)
            row.update(finalize_exit=fcode, finalize_wall_s=fwall)
            rep = json.loads((rd/'placement_report.json').read_text(encoding='utf-8'))
            man = json.loads((rd/'model_manifest.json').read_text(encoding='utf-8'))
            row.update(timing_s=rep['timing_s'], supersample=rep['supersample'], regions=rep.get('pass_regions'),
                       edge_alpha=rep.get('colour_region_edge_alpha'),
                       penetration=man['penetration_below_support'], penetration_body=man.get('penetration_body'),
                       penetration_scene=man.get('penetration_scene'),
                       look_at=man['pose_report'].get('look_at'), notices=man['pose_report'].get('notices'),
                       legs=man['pose_report'].get('legs'), airborne=man['pose_report'].get('airborne'))
            if fcode == 0:
                res = json.loads((fd/'result.json').read_text(encoding='utf-8'))
                row['warnings'] = res['quality']['warnings']
            else:
                row['finalize_log'] = flog
        else:
            row['render_log'] = log
        summary.append(row)
        print(json.dumps({k: row.get(k) for k in ('pose_id', 'render_exit', 'render_wall_s', 'finalize_wall_s', 'edge_alpha', 'warnings')},
                         ensure_ascii=False), flush=True)
    (args.out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

    cols = 6
    rows = (len(summary)+cols-1)//cols
    sheet = Image.new('RGB', (cols*CELL[0], rows*(CELL[1]+20)), 'white')
    draw = ImageDraw.Draw(sheet)
    for i, row in enumerate(summary):
        x, y = (i % cols)*CELL[0], (i//cols)*(CELL[1]+20)
        img = args.out/row['pose_id']/'final/final.jpg'
        if img.exists():
            with Image.open(img) as im:
                im.thumbnail(CELL)
                sheet.paste(im, (x, y+20))
        label = f"{row['pose_id']}  {row['render_wall_s']}s" + ('' if row['render_exit'] == 0 else f" FAIL {row['render_exit']}")
        draw.text((x+4, y+4), label, fill='black')
    sheet.save(args.out/'sheet.jpg', quality=90)
    print(args.out/'sheet.jpg')


if __name__ == '__main__':
    main()
