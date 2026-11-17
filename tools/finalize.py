"""Final composite: photo + Miku + shadow, with depth occlusion -> final.jpg + result.json.

  uv run --no-project --with numpy --with pillow --with OpenEXR python tools/finalize.py \
      --render-dir outputs/case --geometry-dir local/geometry/sample1 --out outputs/results/case/1

Inputs: render_stand.py --photo output (passes.exr, character.png, manifest, report) and the geometry folder.
All blending is in linear light. Occlusion uses the same rule as micut_place.compose (photo depth closer
than Miku's camera depth by more than --depth-margin hides Miku) but takes Miku's depth from the render's
Z pass, so it works at any render scale. Pass --placement-repo to also run micut_place.compose at 1x and
record how well the two occlusion masks agree. Result layout follows docs/OUTPUT_CONTRACT.md (draft).
"""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import time

import numpy as np
import OpenEXR
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def to_linear(x):
    return np.where(x <= .04045, x/12.92, ((x+.055)/1.055)**2.4)


def to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= .0031308, x*12.92, 1.055*x**(1/2.4)-.055)


def resize_bilinear(a, w, h, box=None):
    """Pixel-centre aligned bilinear resize of an (H, W[, C]) float array to (h, w); with box=(x, y, bw, bh)
    only that part of the resized image is computed."""
    sh, sw = a.shape[:2]
    bx, by, bw, bh = box or (0, 0, w, h)
    if (sw, sh) == (w, h):
        return a[by:by+bh, bx:bx+bw]
    x = np.clip((np.arange(bx, bx+bw)+.5)*sw/w-.5, 0, sw-1)
    y = np.clip((np.arange(by, by+bh)+.5)*sh/h-.5, 0, sh-1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0+1, sw-1), np.minimum(y0+1, sh-1)
    fx, fy = x-x0, y-y0
    if a.ndim == 3:
        fx, fy = fx[None, :, None], fy[:, None, None]
    else:
        fx, fy = fx[None, :], fy[:, None]
    top = a[y0][:, x0]*(1-fx)+a[y0][:, x1]*fx
    bottom = a[y1][:, x0]*(1-fx)+a[y1][:, x1]*fx
    return top*(1-fy)+bottom*fy


def min_filter(a, r):
    """Square (2r+1)^2 minimum filter, edges padded with inf."""
    padded = np.pad(a, r, mode='constant', constant_values=np.inf)
    out = np.full_like(a, np.inf)
    h, w = a.shape
    for dy in range(2*r+1):
        for dx in range(2*r+1):
            np.minimum(out, padded[dy:dy+h, dx:dx+w], out=out)
    return out


def read_passes(render_dir, report, w, h):
    """Linear premultiplied RGBA, planar camera depth, shadow ratio (H, W, 3) and the pixel box (x, y, w, h)
    of the frame they cover. Blender writes full-frame passes.exr. The VRM renderer (tools/render_vrm.mjs)
    writes pass_*.npy for the boxes in report.pass_regions only (colour/depth: Miku, shadow: catcher planes);
    they are placed in their union box, and every pixel outside a pass box is colour 0, depth inf, shadow 1."""
    if not (render_dir/'passes.exr').exists() and (render_dir/'pass_combined.npy').exists():
        full = {'x': 0, 'y': 0, 'width': w, 'height': h}
        regions = report.get('pass_regions') or {}
        rc = regions.get('colour') or full
        rs = regions.get('shadow') or rc
        x0, y0 = min(rc['x'], rs['x']), min(rc['y'], rs['y'])
        x1 = max(rc['x']+rc['width'], rs['x']+rs['width'])
        y1 = max(rc['y']+rc['height'], rs['y']+rs['height'])
        box = (x0, y0, x1-x0, y1-y0)
        if x0 < 0 or y0 < 0 or x1 > w or y1 > h:
            raise SystemExit(f'pass regions {regions} exceed the {w}x{h} frame')
        comb = np.zeros((box[3], box[2], 4))
        z = np.full((box[3], box[2]), np.inf)
        shadow = np.ones((box[3], box[2]))

        def put(dst, name, r):
            a = np.load(render_dir/name).astype(np.float64)
            if a.shape[:2] != (r['height'], r['width']):
                raise SystemExit(f'{name} is {a.shape[1]}x{a.shape[0]}, its region is {r["width"]}x{r["height"]}')
            dst[r['y']-y0:r['y']-y0+r['height'], r['x']-x0:r['x']-x0+r['width']] = a
        put(comb, 'pass_combined.npy', rc)
        put(z, 'pass_depth.npy', rc)
        z = np.where(z > 1e9, np.inf, z)
        if (render_dir/'pass_shadow.npy').exists():
            put(shadow, 'pass_shadow.npy', rs)
        return comb, z, np.repeat(shadow[..., None], 3, -1), box
    with OpenEXR.File(str(render_dir/'passes.exr')) as f:
        parts = {p.name(): p for p in f.parts}
        get = lambda part, ch: np.array(parts[part].channels[ch].pixels, dtype=np.float64)  # noqa: E731
        comb = get('ViewLayer.Combined', 'ViewLayer.Combined')
        if comb.shape[:2] != (h, w):
            raise SystemExit(f'render passes are {comb.shape[1]}x{comb.shape[0]}, report says {w}x{h}')
        return (comb, get('ViewLayer.Depth', 'ViewLayer.Depth.Z'),
                get('ViewLayer.Shadow Catcher', 'ViewLayer.Shadow Catcher'), (0, 0, w, h))


def plane_depth(camera, w, h, height=0., footprint=None, points=False):
    """Camera z where each pixel ray meets the horizontal plane Y=height (inf if it misses)."""
    R, t = np.array(camera['R']), np.array(camera['t'])
    u, v = np.meshgrid(np.arange(w)+.5, np.arange(h)+.5)
    d = np.stack([(u-camera['cx'])/camera['fx'], (v-camera['cy'])/camera['fy'], np.ones_like(u)], -1) @ R.T
    with np.errstate(divide='ignore', invalid='ignore'):
        s = (height-t[1])/d[..., 1]  # ray z component is 1, so s is camera z
    s = np.where((s > 0) & np.isfinite(s), s, np.inf)
    if footprint is not None:
        centre, facing, half = footprint
        p = t+d*s[..., None]
        f = np.array([facing[0], 0, facing[2]])
        r = np.array([f[2], 0, -f[0]])
        rel = p-np.array(centre)
        inside = (np.abs(rel @ r) <= half) & (np.abs(rel @ f) <= half)
        s = np.where(inside, s, np.inf)
    if points:
        return s, t+d*np.where(np.isfinite(s), s, 0)[..., None]
    return s


def git_commit(path):
    try:
        return subprocess.run(['git', '-C', str(path), 'rev-parse', '--short', 'HEAD'], capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def micut_place_mask(placement_repo, geometry_dir, render_dir, scratch):
    """Run the placement repo's compositor and decode its occluded pixels (exact colour in occlusion_mask.png)."""
    subprocess.run([sys.executable, str(ROOT/'tools/compose_depth.py'), '--placement-repo', str(placement_repo),
                    '--input-dir', str(geometry_dir), '--render-dir', str(render_dir), '--out', str(scratch)],
                   check=True, capture_output=True)
    vis = np.array(Image.open(scratch/'occlusion_mask.png').convert('RGB'))
    return np.all(vis == [255, 60, 200], -1) | np.all(vis == [255, 150, 0], -1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--render-dir', required=True, type=Path)
    p.add_argument('--geometry-dir', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--photo', type=Path, help='full-resolution upright photo; default = geometry image.jpg')
    p.add_argument('--job-id', default=None)
    p.add_argument('--attempt', type=int, default=1)
    p.add_argument('--depth-margin', type=float, default=.03)
    p.add_argument('--shadow-margin', type=float, default=.05)
    p.add_argument('--jpeg-quality', type=int, default=92)
    p.add_argument('--placement-repo', type=Path, help='cross-check occlusion against micut_place.compose (1x only)')
    args = p.parse_args()
    started = time.perf_counter()
    args.out.mkdir(parents=True, exist_ok=True)
    rendered_error = args.render_dir/'error.json'
    if rendered_error.exists():
        err = json.loads(rendered_error.read_text(encoding='utf-8'))
        write_failed(args, err.get('code') or 'RENDER_FAILED', None, err.get('message', ''), started)
        raise SystemExit(1)
    try:
        compose(args, started)
    except Exception as error:  # noqa: BLE001 - every failure must still produce result.json
        write_failed(args, getattr(error, 'code', None) or 'RENDER_FAILED', 'compose',
                     f'{type(error).__name__}: {error}', started)
        raise


# BE error codes -> (stage, user message, retryable). Unknown codes are treated as render failures.
ERRORS = {
    'INVALID_PLACEMENT': ('validate', '배치 정보를 처리하지 못했어요.', False),
    'SUPPORT_OUT_OF_RANGE': ('validate', '선택한 자리에는 앉힐 수 없어요.', False),
    'INVALID_GEOMETRY': ('validate', '사진의 공간 정보를 처리하지 못했어요.', False),
    'MODEL_MISMATCH': ('render', '캐릭터 모델을 불러오지 못했어요.', False),
    'MODEL_MISSING': ('render', '캐릭터 모델을 불러오지 못했어요.', False),
    'INVALID_ARGUMENT': ('render', '합성 설정이 잘못됐어요.', False),
    'RENDER_FAILED': ('render', '합성 사진을 만들지 못했어요. 다시 시도해 주세요.', True),
    'NO_VALID_CANDIDATE': ('placement', '캐릭터를 배치할 자리가 없어요. 다른 장면을 찍어주세요.', False),
    'INVALID_REQUEST': ('geometry', '사진에 초점거리 정보가 없어요. 촬영 원본을 보내주세요.', False),
}


def write_failed(args, code, stage, detail, started):
    if code not in ERRORS:  # e.g. SystemExit status or an OS errno: not a BE code
        detail = f'[{code}] {detail}'
        code = 'RENDER_FAILED'
    default_stage, message, retryable = ERRORS[code]
    width = height = None
    try:
        image = json.loads((args.geometry_dir/'spatial_info.json').read_text(encoding='utf-8'))['image']
        width, height = image['width'], image['height']
    except (OSError, KeyError, ValueError):
        pass
    result = {
        'schema': 'micut.result/0.1',
        'job_id': args.job_id or f'local_{args.render_dir.name}',
        'attempt': args.attempt,
        'status': 'failed',
        'image': {'file': None, 'width': width, 'height': height, 'format': 'jpeg', 'color_space': 'sRGB',
                  'orientation': 'upright'},
        'tags': [],
        'placement': None,
        'quality': None,
        'timing_s': {'render': None, 'finalize': round(time.perf_counter()-started, 2)},
        'versions': {'renderer': None, 'model_id': None, 'model_sha256': None,
                     'commits': {'ik': git_commit(ROOT), 'placement': None}},
        'created_at': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
        'error': {'code': code, 'stage': stage or default_stage, 'message': message, 'retryable': retryable,
                  'detail': detail},
    }
    (args.out/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'out': str(args.out), 'status': 'failed', 'error': result['error']}, ensure_ascii=False))


def compose(args, started):
    rd, gd = args.render_dir, args.geometry_dir
    manifest = json.loads((rd/'model_manifest.json').read_text(encoding='utf-8'))
    report = json.loads((rd/'placement_report.json').read_text(encoding='utf-8'))
    spatial = json.loads((gd/'spatial_info.json').read_text(encoding='utf-8'))
    cam = report['render_camera']
    w, h = cam['width'], cam['height']
    warnings = []

    # Everything below works inside `box`, the part of the frame the passes cover; the rest of the frame
    # is the photo, untouched.
    comb, z, shadow, box = read_passes(rd, report, w, h)
    bx, by, bw, bh = box
    full_frame = box == (0, 0, w, h)
    bcam = {**cam, 'cx': cam['cx']-bx, 'cy': cam['cy']-by, 'width': bw, 'height': bh}
    alpha, char_rgb = np.clip(comb[..., 3], 0, 1), comb[..., :3]  # both renderers store premultiplied linear colour
    shadow = np.clip(shadow, 0, 1)

    photo_path = args.photo or gd/'image.jpg'
    with Image.open(photo_path) as im:
        im = im.convert('RGB')
        if im.size != (w, h):
            if abs(im.size[0]/im.size[1]-w/h) > .01:
                raise SystemExit(f'photo aspect {im.size} does not match render {w}x{h}')
            if im.size[0] < w:
                warnings.append(f'BACKGROUND_UPSCALED: photo {im.size[0]}x{im.size[1]} enlarged to {w}x{h}; '
                                'pass the full-resolution photo with --photo')
            im = im.resize((w, h), Image.LANCZOS)
        photo = np.asarray(im, dtype=np.uint8)
    bg = to_linear(photo[by:by+bh, bx:bx+bw]/255)

    depth = np.load(gd/'depth.npy').astype(np.float64)
    valid = np.isfinite(depth) & (depth > 0)
    depth_r = resize_bilinear(np.where(valid, depth, np.nan), w, h, box)
    photo_depth = np.where(np.isfinite(depth_r), depth_r, np.inf)

    # Soft edges and alpha-textured hair let the Z pass see the floor plane behind them; give those
    # pixels the nearest solid character depth instead, or the edges get falsely occluded.
    solid = np.where(alpha > .5, z, np.inf)
    near = min_filter(solid, 3)
    char_z = np.where(alpha > .5, z, np.where(alpha > .02, near, np.inf))
    occluded = (alpha > .02) & np.isfinite(char_z) & (photo_depth < char_z-args.depth_margin)

    seated = manifest['anchor_type'] == 'pelvis_seat_contact'
    planes, floor_pts = plane_depth(bcam, bw, bh, points=True)
    # The floor catcher is a square of half size floor_catcher_half_m; fade the shadow out before its edge.
    half = report.get('floor_catcher_half_m') or 1.5
    anchor = np.array(manifest['anchor_position'])
    r = np.max(np.abs((floor_pts-anchor)[..., [0, 2]]), -1)
    fade = np.clip((half*.97-r)/(half*.25), 0, 1)
    if seated:
        planes = np.minimum(planes, plane_depth(bcam, bw, bh, manifest['anchor_position'][1],
                                                (manifest['anchor_position'], manifest['facing_direction_geometry'],
                                                 0.25)))
    shadow_ok = np.isfinite(planes) & (photo_depth >= planes-args.shadow_margin)
    if seated:
        fade = np.where(planes < plane_depth(bcam, bw, bh)-1e-6, 1., fade)  # seat plane pixels: no fade
    shadow_eff = np.where(shadow_ok[..., None], 1-fade[..., None]*(1-shadow), 1.)

    keep = (1-occluded)[..., None]
    a = alpha[..., None]*keep
    out = char_rgb*keep+(1-a)*bg*shadow_eff
    final_px = photo.copy()  # 8-bit sRGB -> linear -> sRGB is exact, so outside the box nothing changes
    final_px[by:by+bh, bx:bx+bw] = (to_srgb(out)*255+.5).astype(np.uint8)
    final = Image.fromarray(final_px)

    agreement = None
    if args.placement_repo and full_frame and report.get('render_scale', 1) == 1 and (rd/'shape.npz').exists():
        theirs = micut_place_mask(args.placement_repo, gd, rd, args.out/'debug'/'micut_place_compose')
        union = (theirs | occluded).sum()
        agreement = {'iou': round(float((theirs & occluded).sum()/union), 4) if union else 1.,
                     'zpass_occluded_px': int(occluded.sum()), 'micut_place_occluded_px': int(theirs.sum())}

    out_dir = args.out
    debug = out_dir/'debug'
    debug.mkdir(parents=True, exist_ok=True)
    final.save(out_dir/'final.jpg', quality=args.jpeg_quality, subsampling=0)
    vis_full = (photo.astype(np.uint16)*127//255).astype(np.uint8)
    vis = vis_full[by:by+bh, bx:bx+bw]  # view: the marks below land in vis_full
    vis[(alpha > .5) & ~occluded] = [60, 220, 255]
    vis[occluded] = [255, 60, 200]
    dark = shadow_ok & (shadow.mean(-1) < .97) & (alpha < .5)
    vis[dark] = (vis[dark]*.4+np.array([255, 230, 0])*.6).astype(np.uint8)
    Image.fromarray(vis_full).save(debug/'occlusion_shadow_mask.png')
    for name in ('character.png', 'model_manifest.json', 'placement_report.json'):
        shutil.copy2(rd/name, debug/name)

    legs = manifest.get('pose_report', {}).get('legs', {})
    proj = report['projection']
    n_char = int((alpha > .02).sum())
    if not proj['fully_in_frame']:
        warnings.append(f"CROPPED: {math.floor(proj.get('visible_vertex_fraction', 0)*1000)/10}% of model vertices inside the frame")
    if report.get('colour_region_edge_alpha', 0) > .01:
        warnings.append(f"PASS_REGION_CLIPPED: Miku reaches the colour pass box edge "
                        f"(alpha {report['colour_region_edge_alpha']:.2f})")
    if not all(v.get('reached', True) for v in legs.values()):
        warnings.append('LEG_IK_NOT_REACHED')
    if not all(v.get('feet_on_floor', True) for v in legs.values()):
        warnings.append('FEET_NOT_ON_FLOOR')
    pen = manifest.get('penetration_below_support', {}).get('vertices', {})
    if sum(pen.values()):
        warnings.append(f'PENETRATION: {pen}')
    pr = manifest.get('pose_report', {})
    result = {
        'schema': 'micut.result/0.1',
        'job_id': args.job_id or f'local_{rd.name}',
        'attempt': args.attempt,
        'status': 'done',
        'image': {'file': 'final.jpg', 'width': w, 'height': h, 'format': 'jpeg', 'color_space': 'sRGB',
                  'orientation': 'upright'},
        'tags': [],
        'placement': {'action': manifest['action'], 'pose_id': manifest['pose_id'], 'anchor_type': manifest['anchor_type'],
                      'anchor_position': manifest['anchor_position'],
                      'facing_direction': manifest['facing_direction_geometry'],
                      'support_candidate_id': manifest.get('support', {}).get('support_candidate_id'),
                      'selection': manifest.get('selection') or 'unknown'},
        'quality': {'fully_in_frame': proj['fully_in_frame'], 'visible_vertex_fraction': proj.get('visible_vertex_fraction'),
                    'occluded_fraction': round(float(occluded.sum()/max(n_char, 1)), 4),
                    'feet_on_floor': all(v.get('feet_on_floor', True) for v in legs.values()),
                    'legs_reached': all(v.get('reached', True) for v in legs.values()),
                    'shadow_pixels': int(dark.sum()), 'warnings': warnings,
                    'failure_policy': 'undecided: no automatic failure yet, warnings only',
                    'occlusion_cross_check': agreement},
        'timing_s': {'render': report.get('timing_s', {}).get('total', report.get('timing_s', {}).get('total_in_blender')),
                     'finalize': round(time.perf_counter()-started, 2)},
        'versions': {'renderer': report.get('renderer', 'blender-cycles'), 'model_id': manifest['model_id'], 'model_sha256': manifest.get('source_file_sha256'),
                     'commits': {'ik': git_commit(ROOT),
                                 'placement': git_commit(args.placement_repo) if args.placement_repo else None}},
        'render': {'scale': report.get('render_scale', 1), 'lighting': report.get('lighting'),
                   'look_at_residual_deg': pr.get('look_at', {}).get('head_residual_deg')},
        'created_at': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
        'error': None,
    }
    (out_dir/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'out': str(out_dir), 'size': [w, h], 'occluded_fraction': result['quality']['occluded_fraction'],
                      'shadow_pixels': int(dark.sum()), 'cross_check': agreement, 'warnings': warnings}, ensure_ascii=False))


if __name__ == '__main__':
    main()
