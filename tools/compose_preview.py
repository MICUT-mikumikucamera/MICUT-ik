"""Optional flat overlay for inspection. NOT a depth-aware final compositor. Requires Pillow."""
import argparse
from pathlib import Path
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument('--background', required=True)
p.add_argument('--character', required=True)
p.add_argument('--out', required=True)
args = p.parse_args()
with Image.open(args.background) as bg, Image.open(args.character) as char:
    if bg.size != char.size:
        raise ValueError('image sizes differ; do not silently crop or resize camera-aligned outputs')
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.alpha_composite(bg.convert('RGBA'), char.convert('RGBA')).save(target)
