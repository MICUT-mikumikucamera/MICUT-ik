"""Inspect GLB/VRM content without Blender or downloading external resources."""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def inspect(path):
    raw = Path(path).read_bytes()
    if len(raw) < 20:
        raise ValueError('truncated GLB')
    magic, version, length = struct.unpack_from('<4sII', raw)
    if magic != b'glTF' or version != 2 or length != len(raw):
        raise ValueError('not a complete GLB v2 file')
    size, kind = struct.unpack_from('<II', raw, 12)
    if kind != 0x4E4F534A or 20+size > len(raw):
        raise ValueError('invalid JSON chunk')
    d = json.loads(raw[20:20+size])
    meshes = []
    for mesh in d.get('meshes', []):
        count = sum(d['accessors'][prim['attributes']['POSITION']]['count'] for prim in mesh['primitives'])
        meshes.append({'name': mesh.get('name'), 'position_accessor_vertex_count': count})
    ext = d.get('extensions', {})
    vrm = ext.get('VRM', {})
    vrm1 = ext.get('VRMC_vrm', {})
    placeholder = bool(meshes) and all(m['name'] == 'Cube' and m['position_accessor_vertex_count'] <= 24 for m in meshes)
    return {'file_name': Path(path).name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
            'vrm_spec': vrm.get('specVersion', vrm1.get('specVersion')), 'meshes': meshes,
            'images': len(d.get('images', [])), 'skins': len(d.get('skins', [])),
            'humanoid_bone_count': len(vrm.get('humanoid', {}).get('humanBones', [])) or len(vrm1.get('humanoid', {}).get('humanBones', {})),
            'meta_as_stored': vrm.get('meta', vrm1.get('meta', {})),
            'placeholder_cube_detected': placeholder,
            'warning': 'Cube geometry is not the supplied character appearance; do not use its bounds as character size.' if placeholder else None}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('file')
    p.add_argument('--out')
    args = p.parse_args()
    result = json.dumps(inspect(args.file), ensure_ascii=False, indent=2)
    if args.out:
        target = Path(args.out)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(result, encoding='utf-8')
    else:
        print(result)
