"""Depth-aware composite using the placement repo's compositor (micut_place.compose), for any pose.

  python tools/compose_depth.py --placement-repo ../MICUT-placement-decision \
      --input-dir local/geometry/sample1 --render-dir outputs/case --out outputs/case/compose

The render dir must come from render_stand.py --export-shape (character.png, model_manifest.json, shape.npz).
The placement repo's manifest loader accepts only stand_default, so this builds the mesh shape directly
from shape.npz and calls its compose() unchanged. Requires numpy and pillow.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--placement-repo', required=True, type=Path)
    p.add_argument('--input-dir', required=True, type=Path)
    p.add_argument('--render-dir', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--depth-margin', type=float, default=0.03)
    p.add_argument('--front-label', action='append', default=[])
    args = p.parse_args()
    sys.path.insert(0, str(args.placement_repo.resolve()))
    from micut_inspect.scene import load_scene
    from micut_place.compose import compose
    from micut_place.shape import StandShape

    path = args.render_dir/'shape.npz'
    with np.load(path) as d:
        vertices, faces = d['local_vertices'].astype(float), d['faces']
    shape = StandShape(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(), vertices=vertices,
                       faces=faces, samples=vertices, sole_xz=np.zeros((0, 2)), band_h=.05)
    report = compose(load_scene(args.input_dir), shape, args.render_dir, args.out, args.depth_margin,
                     tuple(args.front_label))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
