"""Entry point: blender --background MODEL.blend --python tools/render_stand.py -- ...

Handles every registered pose (poses/*.json), not only standing; the file name is kept for existing callers.
"""
import argparse
import json
from pathlib import Path
import sys
import traceback

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from micut_ik.contracts import Placement, camera_contract, pose_registry
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
    parser.add_argument('--export-shape', action='store_true', help='write shape.npz (placement-repo layout) for depth compositing')
    parser.add_argument('--debug-supports', action='store_true', help='render a grey floor/seat for preview; not for compositing')
    parser.add_argument('--photo', help='background photo: enables photo lighting, shadow catchers and passes.exr')
    parser.add_argument('--render-scale', type=float, default=1., help='render at this multiple of the spatial_info resolution')
    parser.add_argument('--exposure', type=float, default=2., help='photo lighting exposure (compensates scene albedo)')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    load = lambda file: json.loads(Path(file).read_text(encoding='utf-8-sig'))
    try:
        if args.samples < 1:
            raise ValueError('samples must be positive')
        if not 1 <= args.render_scale <= 8:
            raise ValueError('render-scale must be between 1 and 8')
        poses = pose_registry()
        placement = Placement.parse(load(args.placement), poses)
        report = run(load(args.profile), placement, camera_contract(load(args.spatial)), args.out, args.samples,
                     not args.inspect_only, poses[placement.pose_id], args.export_shape, args.debug_supports,
                     str(Path(args.photo).resolve()) if args.photo else None, args.render_scale, args.exposure)
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
        code = getattr(error, 'code', 'RENDER_FAILED')
        (out/'error.json').write_text(json.dumps({'status': 'failed', 'code': code, 'error_type': type(error).__name__,
                                                'message': str(error)}, ensure_ascii=False, indent=2), encoding='utf-8')
        (out/'placement_report.json').write_text(json.dumps({'status': 'failed', 'code': code, 'error': str(error)},
                                                          ensure_ascii=False, indent=2), encoding='utf-8')
        traceback.print_exc()
        # Use --python-exit-code 1 so Blender propagates Python failures to the shell.
        raise


if __name__ == '__main__':
    main()
