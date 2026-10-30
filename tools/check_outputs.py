"""Assert render handoff invariants. Uses only Python's standard library."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

p = argparse.ArgumentParser()
p.add_argument('directory')
p.add_argument('--expected-anchor', type=float, nargs=3, required=True)
p.add_argument('--require-in-frame', action='store_true')
p.add_argument('--source-model', help='verify that the input model bytes remain unchanged')
args = p.parse_args()
out = Path(args.directory)
manifest = json.loads((out/'model_manifest.json').read_text(encoding='utf-8'))
report = json.loads((out/'placement_report.json').read_text(encoding='utf-8'))
assert report['status'] in ('rendered', 'rendered_with_framing_warning'), report
assert not (out/'error.json').exists(), 'stale error.json'
assert abs(manifest['normalized_size_m']['height']-manifest['target_height_m']) < 1e-5
feet = manifest['foot_contact_points_geometry_m']
assert all(abs(point[1]) < .0001 for point in feet.values()), feet
mid = [(feet['left'][i]+feet['right'][i])/2 for i in range(3)]
assert max(abs(mid[i]-args.expected_anchor[i]) for i in range(3)) < .0001, (mid, args.expected_anchor)
assert abs(manifest['world_bounds_geometry_m']['min'][1]) < .001
raw = (out/'character.png').read_bytes()
assert raw[:8] == b'\x89PNG\r\n\x1a\n'
assert struct.unpack_from('>II', raw, 16) == (report['camera']['width'], report['camera']['height'])
if args.require_in_frame:
    assert report['projection']['fully_in_frame'], report['projection']
if args.source_model:
    assert hashlib.sha256(Path(args.source_model).read_bytes()).hexdigest() == manifest['source_file_sha256']
print(json.dumps({'status': 'pass', 'sole_midpoint': mid, 'size_m': manifest['normalized_size_m'],
                  'fully_in_frame': report['projection']['fully_in_frame']}, indent=2))
