import copy
import json
from pathlib import Path
import unittest

from micut_ik.contracts import (Placement, ContractError, camera_contract, pose_registry, to_local,
    geometry_to_blender, blender_to_geometry, project_world, horizontal_facing)

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.request = json.loads((ROOT/'examples/placement.stand.json').read_text())
        self.spatial = json.loads((ROOT/'examples/spatial.synthetic.json').read_text())

    def test_request_accepts_sungyoon_example(self):
        self.assertEqual(Placement.parse(self.request).anchor_position, (.3, 0, .8))

    def test_selection_is_passed_through(self):
        self.assertIsNone(Placement.parse(self.request).selection)
        self.assertEqual(Placement.parse({**self.request, 'selection': 'jev'}).selection, 'jev')
        for bad in ('', 3):
            with self.subTest(bad=bad), self.assertRaises(ContractError):
                Placement.parse({**self.request, 'selection': bad})

    def test_unit_and_pose_are_not_silently_coerced(self):
        for key, value in [('unit', 'cm'), ('action', 'sit'), ('pose_id', 'unknown'),
                           ('coordinate_frame', 'camera')]:
            with self.subTest(key=key), self.assertRaises(ContractError):
                Placement.parse({**self.request, key: value})

    def test_anchor_rejects_nonfinite_and_elevated(self):
        for value in [[0, float('nan'), 1], [0, .4, 1], [True, 0, 1], [0, 1]]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                Placement.parse({**self.request, 'anchor_position': value})

    def test_sit_request_from_seating_prep_contract(self):
        sit = json.loads((ROOT/'examples/placement.sit.preview.json').read_text())
        placement = Placement.parse(sit)
        self.assertEqual((placement.action, placement.pose_id, placement.anchor_type),
                         ('sit', 'sit_default', 'pelvis_seat_contact'))
        self.assertEqual(placement.anchor_position[1], .45)
        self.assertEqual(placement.support_candidate_id, 2)

    def test_sit_rejects_out_of_range_seat_and_mixed_fields(self):
        sit = json.loads((ROOT/'examples/placement.sit.preview.json').read_text())
        for y in (0, .2, .9):
            with self.subTest(y=y), self.assertRaises(ContractError) as ctx:
                Placement.parse({**sit, 'anchor_position': [0, y, 3]})
            self.assertEqual(ctx.exception.code, 'SUPPORT_OUT_OF_RANGE')
        for key, value in [('anchor_type', 'feet_center_on_ground'), ('action', 'stand'),
                           ('support_candidate_id', -1), ('support_candidate_id', True)]:
            with self.subTest(key=key), self.assertRaises(ContractError):
                Placement.parse({**sit, key: value})

    def test_every_registered_pose_declares_contract_fields(self):
        poses = pose_registry()
        self.assertTrue({'stand_default', 'stand_natural', 'sit_default'} <= set(poses))
        for pose in poses.values():
            self.assertIn(pose['anchor_type'], ('feet_center_on_ground', 'pelvis_seat_contact'))
            self.assertIn(pose['action'], ('stand', 'sit'))

    def test_preset_workshop_poses_are_registered(self):
        import json
        from pathlib import Path
        lock = json.loads((Path(__file__).resolve().parents[1]/'presets.lock.json').read_text(encoding='utf-8'))
        poses = pose_registry()
        presets = {k: p for k, p in poses.items() if p.get('baked')}
        self.assertEqual(sorted(presets), lock['poses'])
        for pose in presets.values():
            self.assertIn((pose['action'], pose['anchor_type']),
                          [('stand', 'feet_center_on_ground'), ('sit', 'pelvis_seat_contact')])
            self.assertEqual(len(pose['baked']['raw_bones']), 138)
        self.assertEqual(Placement.parse({**self.request, 'pose_id': 'MV05'}).pose_id, 'MV05')

    def test_coordinate_contract_checked_when_present(self):
        contract = {'frame': 'geometry_world', 'unit': 'm', 'axes': ['right', 'up', 'forward'], 'handedness': 'left',
                    'image_size': [self.spatial['image']['width'], self.spatial['image']['height']]}
        camera_contract({**self.spatial, 'coordinate_contract': contract})
        for bad in ({'handedness': 'right'}, {'unit': 'cm'}, {'axes': ['right', 'up', 'back']}, {'image_size': [1, 1]}):
            with self.subTest(bad=bad), self.assertRaises(ContractError):
                camera_contract({**self.spatial, 'coordinate_contract': {**contract, **bad}})

    def test_pose_ref_is_vrm_only(self):
        with self.assertRaises(ContractError):
            Placement.parse({**self.request, 'pose_id': 'gen_c0', 'pose_ref': 'poses_runtime/gen_c0.json'})
        with self.assertRaises(ContractError):
            Placement.parse({**self.request, 'pose_id': 'COL_V', 'combo': {'base': {'id': 'B01'}}})

    def test_local_frame_matches_placement_repo(self):
        # x = character right r=[f_z,0,-f_x]; facing the camera (-Z) puts character right on world -X.
        for point, expected in [((.5, 1, 3), (-.5, 1, 0)), ((0, 0, 2.8), (0, 0, .2))]:
            for got, want in zip(to_local(point, (0, 0, 3), (0, 0, -1)), expected):
                self.assertAlmostEqual(got, want)

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
