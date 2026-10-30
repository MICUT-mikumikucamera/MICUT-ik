"""Small validated contract for a standing placement, without a rendering dependency."""
from dataclasses import dataclass
import math


class ContractError(ValueError):
    pass


def vector(value, n, name):
    if not isinstance(value, (list, tuple)) or len(value) != n:
        raise ContractError(f'{name}: expected {n} numbers')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value):
        raise ContractError(f'{name}: all values must be finite numbers')
    return tuple(float(x) for x in value)


@dataclass(frozen=True)
class Placement:
    anchor_position: tuple
    facing_rule: str
    facing_direction: tuple | None
    model_id: str | None

    @classmethod
    def parse(cls, data):
        required = {'coordinate_frame': 'geometry_world', 'unit': 'm',
                    'anchor_type': 'feet_center_on_ground', 'action': 'stand',
                    'pose_id': 'stand_default'}
        for key, expected in required.items():
            if data.get(key) != expected:
                raise ContractError(f'{key}: this adapter supports only {expected!r}')
        anchor = vector(data.get('anchor_position'), 3, 'anchor_position')
        if abs(anchor[1]) > 1e-5:
            raise ContractError('standing ground anchor must have Y=0; elevated supports are not implemented')
        rule = data.get('facing_rule')
        if rule not in ('look_at_camera', 'world_direction'):
            raise ContractError('facing_rule: use look_at_camera or world_direction')
        direction = None
        if rule == 'world_direction':
            direction = vector(data.get('facing_direction'), 3, 'facing_direction')
            if abs(direction[1]) > 1e-5 or math.hypot(direction[0], direction[2]) < 1e-8:
                raise ContractError('facing_direction must be nonzero and horizontal (Y=0)')
        model_id = data.get('model_id')
        if model_id is not None and (not isinstance(model_id, str) or not model_id):
            raise ContractError('model_id must be a nonempty string when provided')
        return cls(anchor, rule, direction, model_id)


def camera_contract(spatial):
    im, k = spatial['image'], spatial['camera']
    w, h = im['width'], im['height']
    if any(isinstance(x, bool) or not isinstance(x, int) or x <= 0 for x in (w, h)):
        raise ContractError('image width/height must be positive integers')
    fx, fy, cx, cy = vector([k.get(n) for n in ('fx', 'fy', 'cx', 'cy')], 4, 'intrinsics')
    if fx <= 0 or fy <= 0:
        raise ContractError('fx/fy must be positive, known values; no guessed fallback')
    transform = spatial['ground_plane']['cam_to_world']
    r = tuple(vector(row, 3, 'R row') for row in transform['R'])
    if len(r) != 3:
        raise ContractError('R must have three rows')
    t = vector(transform['t'], 3, 't')
    # The supplied geometry frame is left handed, camera CV is right handed.
    det = (r[0][0]*(r[1][1]*r[2][2]-r[1][2]*r[2][1])
           -r[0][1]*(r[1][0]*r[2][2]-r[1][2]*r[2][0])
           +r[0][2]*(r[1][0]*r[2][1]-r[1][1]*r[2][0]))
    err = max(abs(sum(r[i][k]*r[j][k] for k in range(3))-(i == j)) for i in range(3) for j in range(3))
    if abs(det + 1) > 1e-3 or err > 1e-3:
        raise ContractError('R must match documented left-handed geometry frame (orthogonal, det=-1)')
    if abs(t[0]) > 1e-3 or abs(t[2]) > 1e-3 or t[1] <= 0:
        raise ContractError('camera t must be [0, positive height, 0] for this ground-origin frame')
    return {'width': w, 'height': h, 'fx': fx, 'fy': fy, 'cx': cx, 'cy': cy, 'R': r, 't': t}


def geometry_to_blender(point):
    x, y, z = vector(tuple(point), 3, 'point')
    return (x, z, y)


def blender_to_geometry(point):
    x, y, z = vector(tuple(point), 3, 'point')
    return (x, z, y)


def project_world(point, camera):
    delta = [point[i]-camera['t'][i] for i in range(3)]
    cv = [sum(camera['R'][j][i]*delta[j] for j in range(3)) for i in range(3)]
    if cv[2] <= 0:
        return None
    return (camera['fx']*cv[0]/cv[2]+camera['cx'],
            camera['fy']*cv[1]/cv[2]+camera['cy'], cv[2])


def horizontal_facing(placement, camera_position):
    if placement.facing_rule == 'world_direction':
        direction = placement.facing_direction
    else:
        direction = (camera_position[0]-placement.anchor_position[0], 0,
                     camera_position[2]-placement.anchor_position[2])
    length = math.hypot(direction[0], direction[2])
    if length < 1e-8:
        raise ContractError('camera directly above anchor: horizontal facing is undefined')
    return (direction[0]/length, 0., direction[2]/length)
