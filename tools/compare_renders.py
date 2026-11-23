"""Compare two VRM render folders pixel by pixel (passes placed in the full frame) and their final.jpg.

  uv run --no-project --with numpy --with pillow --with OpenEXR python tools/compare_renders.py A B [--final-sub final]

Used to check that a renderer change keeps the output: prints the largest colour, alpha, depth and shadow
differences, the number of pixels that differ, and the final.jpg difference.
"""
import argparse
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from finalize import read_passes  # noqa: E402


def full(rd):
    report = json.loads((rd/'placement_report.json').read_text(encoding='utf-8'))
    w, h = report['render_camera']['width'], report['render_camera']['height']
    comb, z, shadow, (bx, by, bw, bh) = read_passes(rd, report, w, h)
    C = np.zeros((h, w, 4))
    Z = np.full((h, w), np.inf)
    S = np.ones((h, w))
    C[by:by+bh, bx:bx+bw], Z[by:by+bh, bx:bx+bw], S[by:by+bh, bx:bx+bw] = comb, z, shadow[..., 0]
    return C, Z, S, report


def main():
    p = argparse.ArgumentParser()
    p.add_argument('a', type=Path)
    p.add_argument('b', type=Path)
    p.add_argument('--final-sub', default='final')
    args = p.parse_args()
    ca, za, sa, ra = full(args.a)
    cb, zb, sb, rb = full(args.b)
    if ca.shape != cb.shape:
        raise SystemExit(f'frames differ: {ca.shape} vs {cb.shape}')
    fin = np.isfinite(za) & np.isfinite(zb)
    out = {
        'colour_max': float(np.abs(ca[..., :3]-cb[..., :3]).max()),
        'alpha_max': float(np.abs(ca[..., 3]-cb[..., 3]).max()),
        'alpha_px_over_1pct': int((np.abs(ca[..., 3]-cb[..., 3]) > .01).sum()),
        'depth_inf_mismatch_px': int((np.isfinite(za) != np.isfinite(zb)).sum()),
        'depth_max_m': float(np.abs(za-zb)[fin].max()) if fin.any() else 0.,
        'shadow_max': float(np.abs(sa-sb).max()),
        'shadow_px_over_1pct': int((np.abs(sa-sb) > .01).sum()),
        'character_px': int((ca[..., 3] > .02).sum()),
    }
    fa, fb = args.a/args.final_sub/'final.jpg', args.b/args.final_sub/'final.jpg'
    if fa.exists() and fb.exists():
        ia = np.asarray(Image.open(fa), dtype=np.int16)
        ib = np.asarray(Image.open(fb), dtype=np.int16)
        d = np.abs(ia-ib)
        out['final_max'] = int(d.max())
        out['final_px_over_2'] = int((d.max(-1) > 2).sum())
    out['timing_a'] = ra.get('timing_s')
    out['timing_b'] = rb.get('timing_s')
    print(json.dumps(out))


if __name__ == '__main__':
    main()
