import json
from pathlib import Path
import struct
import tempfile
import unittest
from tools.inspect_vrm import inspect


class VrmInspectionTests(unittest.TestCase):
    def test_cube_with_bones_is_not_mistaken_for_character_geometry(self):
        data = {'accessors': [{'count': 24}], 'meshes': [{'name': 'Cube', 'primitives': [{'attributes': {'POSITION': 0}}]}],
                'extensions': {'VRM': {'humanoid': {'humanBones': [{'bone': 'hips'}]}}}}
        blob = json.dumps(data).encode()
        blob += b' '*((-len(blob)) % 4)
        raw = struct.pack('<4sIIII', b'glTF', 2, 20+len(blob), len(blob), 0x4E4F534A)+blob
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'sample.vrm'
            p.write_bytes(raw)
            report = inspect(p)
            self.assertTrue(report['placeholder_cube_detected'])
            self.assertEqual(report['humanoid_bone_count'], 1)

    def test_truncated_glb_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'bad.vrm'
            p.write_bytes(b'glTF')
            with self.assertRaises(ValueError):
                inspect(p)


if __name__ == '__main__':
    unittest.main()
