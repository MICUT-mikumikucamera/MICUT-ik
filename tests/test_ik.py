import math
import unittest

from micut_ik import ik

UP, FWD = (0, 1, 0), (0, 0, 1)


def dist(a, b):
    return ik.length(ik.sub(a, b))


class TwoBoneTests(unittest.TestCase):
    def test_reachable_target_keeps_segment_lengths(self):
        root, target = (0, 1, 0), (0, .3, .3)
        mid, end, reached = ik.two_bone_ik(root, target, .45, .4, FWD)
        self.assertTrue(reached)
        self.assertAlmostEqual(dist(root, mid), .45)
        self.assertAlmostEqual(dist(mid, end), .4)
        self.assertAlmostEqual(dist(end, target), 0)

    def test_pole_chooses_bend_side(self):
        root, target = (0, 1, 0), (0, .3, 0)
        front, _, _ = ik.two_bone_ik(root, target, .45, .4, FWD)
        back, _, _ = ik.two_bone_ik(root, target, .45, .4, (0, 0, -1))
        self.assertGreater(front[2], 0)
        self.assertLess(back[2], 0)

    def test_out_of_reach_is_reported_and_straightened(self):
        mid, end, reached = ik.two_bone_ik((0, 0, 0), (0, 0, 2), .45, .4, UP)
        self.assertFalse(reached)
        self.assertAlmostEqual(end[2], .85, places=3)

    def test_degenerate_inputs_raise(self):
        with self.assertRaises(ValueError):
            ik.two_bone_ik((0, 0, 0), (0, 0, 0), .4, .4, UP)
        with self.assertRaises(ValueError):
            ik.two_bone_ik((0, 0, 0), (0, 0, .5), .4, .4, FWD)


class SeatedTargetTests(unittest.TestCase):
    L1, L2, ANKLE = .38, .37, .09

    def solve(self, hip_height):
        return ik.seated_ankle_target((0, hip_height, 0), FWD, UP, self.L1, self.L2, self.ANKLE, 15)

    def test_low_seat_level_thigh_shin_leans_forward(self):
        target, drop, on_floor = self.solve(.40)
        self.assertEqual(drop, 0)
        self.assertTrue(on_floor)
        self.assertAlmostEqual(target[1], self.ANKLE)
        self.assertGreater(target[2], self.L1)

    def test_mid_seat_tilts_thigh_with_vertical_shin(self):
        target, drop, on_floor = self.solve(.52)
        self.assertTrue(on_floor)
        self.assertTrue(0 < drop <= 15)
        self.assertAlmostEqual(target[1], self.ANKLE)
        knee_z = self.L1*math.cos(math.radians(drop))
        self.assertAlmostEqual(target[2], knee_z)

    def test_high_seat_feet_hang(self):
        target, drop, on_floor = self.solve(.75)
        self.assertFalse(on_floor)
        self.assertAlmostEqual(drop, 15)
        self.assertGreater(target[1], self.ANKLE)

    def test_target_is_reachable_by_the_chain(self):
        for h in (.4, .5, .6, .75):
            target, _, _ = self.solve(h)
            _, end, reached = ik.two_bone_ik((0, h, 0), target, self.L1, self.L2, (0, .3, 1))
            self.assertTrue(reached, h)
            self.assertAlmostEqual(dist(end, target), 0, places=6)


class FixtureTests(unittest.TestCase):
    def test_committed_fixture_matches_python(self):
        """web/ik.js is tested against this fixture; regenerate with tools/gen_ik_fixtures.py after changing ik.py."""
        import json
        from pathlib import Path
        import sys
        root = Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(root/'tools'))
        from gen_ik_fixtures import FIXTURE, cases
        stored = json.loads(FIXTURE.read_text(encoding='utf-8'))
        fresh = json.loads(json.dumps(cases()))

        # libm differs in the last bit between platforms (Windows vs Linux CI): compare to 1e-9 like
        # tests/ik.test.mjs, structure and non-float values exactly.
        def check(a, b, path='$'):
            if isinstance(a, float) or isinstance(b, float):
                self.assertAlmostEqual(a, b, delta=1e-9, msg=path)
            elif isinstance(a, dict):
                self.assertEqual(a.keys(), b.keys(), path)
                for k in a:
                    check(a[k], b[k], f'{path}.{k}')
            elif isinstance(a, list):
                self.assertEqual(len(a), len(b), path)
                for i, (x, y) in enumerate(zip(a, b)):
                    check(x, y, f'{path}[{i}]')
            else:
                self.assertEqual(a, b, path)
        check(fresh, stored)


class ClampTests(unittest.TestCase):
    def test_clamp_limits_angle(self):
        out = ik.clamp_direction((0, 0, 1), (1, 0, 0), 30)
        self.assertAlmostEqual(math.degrees(math.acos(ik.dot(out, (0, 0, 1)))), 30)

    def test_small_turn_passes_through(self):
        desired = ik.normalize((.1, 0, 1))
        self.assertEqual(ik.clamp_direction((0, 0, 1), desired, 30), desired)


if __name__ == '__main__':
    unittest.main()
