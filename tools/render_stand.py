"""Entry point: blender --background MODEL.blend --python tools/render_stand.py -- ..."""
import argparse
import json
from pathlib import Path
import sys
import traceback

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from micut_ik.contracts import Placement, camera_contract
from micut_ik.blender_adapter import run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--placement', required=True)
    parser.add_argument('--spatial', required=True)
    parser.add_argument('--profile', default=str(ROOT/'examples/model_profile.json'))
    parser.add_argument('--out', required=True)
    parser.add_argument('--samples', type=int, default=16)
    parser.add_argument('--inspect-only', action='store_true')
    parser.add_argument('--save-scene', action='store_true', help='save a NEW placed_scene.blend in output, never the input')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    load = lambda file: json.loads(Path(file).read_text(encoding='utf-8-sig'))
    try:
        if args.samples < 1:
            raise ValueError('samples must be positive')
        report = run(load(args.profile), Placement.parse(load(args.placement)),
                     camera_contract(load(args.spatial)), args.out, args.samples, not args.inspect_only)
        if args.save_scene:
            import bpy
            target = (Path(args.out)/'placed_scene.blend').resolve()
            if target == Path(bpy.data.filepath).resolve():
                raise ValueError('output scene must differ from source .blend')
            bpy.ops.wm.save_as_mainfile(filepath=str(target), check_existing=False)
        print('MICUT_RESULT', json.dumps({'status': report['status'], 'out': args.out}))
    except Exception as error:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out/'error.json').write_text(json.dumps({'status': 'failed', 'error_type': type(error).__name__,
                                                'message': str(error)}, ensure_ascii=False, indent=2), encoding='utf-8')
        (out/'placement_report.json').write_text(json.dumps({'status': 'failed', 'error': str(error)},
                                                          ensure_ascii=False, indent=2), encoding='utf-8')
        traceback.print_exc()
        # Use --python-exit-code 1 so Blender propagates Python failures to the shell.
        raise


if __name__ == '__main__':
    main()
