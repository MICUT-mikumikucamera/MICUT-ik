import copy
import json
from pathlib import Path
import unittest

from micut_ik.contracts import (Placement, ContractError, camera_contract,
    geometry_to_blender, blender_to_geometry, project_world, horizontal_facing)

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.request = json.loads((ROOT/'examples/placement.stand.json').read_text())
        self.spatial = json.loads((ROOT/'examples/spatial.synthetic.json').read_text())

    def test_request_accepts_sungyoon_example(self):
        self.assertEqual(Placement.parse(self.request).anchor_position, (.3, 0, .8))

    def test_unit_and_pose_are_not_silently_coerced(self):
        for key, value in [('unit', 'cm'), ('action', 'sit'), ('pose_id', 'unknown'),
                           ('coordinate_frame', 'camera')]:
            with self.subTest(key=key), self.assertRaises(ContractError):
                Placement.parse({**self.request, key: value})

    def test_anchor_rejects_nonfinite_and_elevated(self):
        for value in [[0, float('nan'), 1], [0, .4, 1], [True, 0, 1], [0, 1]]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                Placement.parse({**self.request, 'anchor_position': value})

    def test_horizontal_camera_facing_ignores_height(self):
        a = horizontal_facing(Placement.parse(self.request), (0, 1.7, 0))
        b = horizontal_facing(Placement.parse(self.request), (0, 10, 0))
        self.assertEqual(a, b)
        self.assertEqual(a[1], 0)
        self.assertLess(a[2], 0)

    def test_direction_vector_supported_and_yaw_only(self):
        request = {**self.request, 'facing_rule': 'world_direction', 'facing_direction': [2, 0, 0]}
        self.assertEqual(horizontal_facing(Placement.parse(request), (0, 1, 0)), (1, 0, 0))
        for value in [[0, 0, 0], [1, 1, 0]]:
            with self.assertRaises(ContractError):
                Placement.parse({**request, 'facing_direction': value})

    def test_coordinate_roundtrip(self):
        point = (.3, 1.2, .8)
        self.assertEqual(geometry_to_blender(point), (.3, .8, 1.2))
        self.assertEqual(blender_to_geometry(geometry_to_blender(point)), point)

    def test_intrinsics_required_no_fallback(self):
        for key in ['fx', 'fy', 'cx', 'cy']:
            spatial = copy.deepcopy(self.spatial)
            spatial['camera'][key] = None
            with self.subTest(key=key), self.assertRaises(ContractError):
                camera_contract(spatial)

    def test_unknown_handedness_rejected(self):
        spatial = copy.deepcopy(self.spatial)
        spatial['ground_plane']['cam_to_world']['R'] = [[1,0,0],[0,1,0],[0,0,1]]
        with self.assertRaises(ContractError):
            camera_contract(spatial)

    def test_optical_axis_projects_to_principal_point(self):
        camera = camera_contract(self.spatial)
        point = [camera['t'][i]+camera['R'][i][2]*3 for i in range(3)]
        x, y, z = project_world(point, camera)
        self.assertAlmostEqual(x, camera['cx'])
        self.assertAlmostEqual(y, camera['cy'])
        self.assertAlmostEqual(z, 3)

    def test_behind_camera_has_no_pixel(self):
        camera = camera_contract(self.spatial)
        point = [camera['t'][i]-camera['R'][i][2] for i in range(3)]
        self.assertIsNone(project_world(point, camera))


if __name__ == '__main__':
    unittest.main()
