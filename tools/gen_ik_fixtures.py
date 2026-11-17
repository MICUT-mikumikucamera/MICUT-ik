"""Write tests/fixtures/ik_cases.json from micut_ik/ik.py so web/ik.js can be checked against it.

  python tools/gen_ik_fixtures.py

tests/test_ik.py fails if the committed fixture no longer matches the Python results, and
tests/ik.test.mjs fails if web/ik.js disagrees with the fixture, so the two engines cannot drift apart.
"""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from micut_ik import ik  # noqa: E402

FIXTURE = ROOT/'tests/fixtures/ik_cases.json'


def cases():
    out = {'two_bone': [], 'seated': [], 'clamp': []}
    for root, target, l1, l2, pole in [
        ((0, 1, 0), (0, .3, .3), .45, .4, (0, 0, 1)),
        ((0, 1, 0), (0, .3, 0), .45, .4, (0, 0, -1)),
        ((0, 0, 0), (0, 0, 2), .45, .4, (0, 1, 0)),
        ((.1, .9, .2), (.3, .1, .7), .38, .37, (0, .3, 1)),
        ((0, 1.2, 0), (.05, 1.15, .02), .27, .25, (-1, 0, -.6)),
    ]:
        mid, end, reached = ik.two_bone_ik(root, target, l1, l2, pole)
        out['two_bone'].append({'args': [root, target, l1, l2, pole], 'middle': mid, 'end': end, 'reached': reached})
    for h in (.40, .52, .60, .75):
        ankle, drop, on_floor = ik.seated_ankle_target((0, h, 0), (0, 0, 1), (0, 1, 0), .38, .37, .09, 15)
        out['seated'].append({'args': [[0, h, 0], [0, 0, 1], [0, 1, 0], .38, .37, .09, 15],
                              'ankle': ankle, 'thigh_drop_deg': drop, 'feet_on_floor': on_floor})
    for base, desired, deg in [((0, 0, 1), (1, 0, 0), 30), ((0, 0, 1), (.1, 0, 1), 30), ((0, 1, 0), (.3, -.2, .9), 45)]:
        out['clamp'].append({'args': [base, desired, deg], 'out': ik.clamp_direction(base, desired, deg)})
    return out


if __name__ == '__main__':
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(cases(), indent=1)+'\n', encoding='utf-8')
    print('wrote', FIXTURE)
