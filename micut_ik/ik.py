"""Engine-independent IK math on plain 3-tuples. No Blender import, so it can be unit tested and ported.

All functions work in any right- or left-handed frame because they only use dot/cross products
consistently within one call.
"""
import math


def add(a, b):
    return (a[0]+b[0], a[1]+b[1], a[2]+b[2])


def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def mul(a, k):
    return (a[0]*k, a[1]*k, a[2]*k)


def dot(a, b):
    return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def length(a):
    return math.sqrt(dot(a, a))


def normalize(a):
    n = length(a)
    if n < 1e-12:
        raise ValueError('cannot normalize a zero vector')
    return mul(a, 1/n)


def two_bone_ik(root, target, upper_len, lower_len, pole, slack=1e-4):
    """Solve a two-segment chain (hip-knee-ankle, shoulder-elbow-wrist).

    pole: direction the middle joint should bend toward (need not be orthogonal).
    Returns (middle_joint, end_joint, reached). When the target is out of reach the chain is
    straightened toward it (too far) or folded to the minimum (too close) and reached=False.
    """
    if upper_len <= 0 or lower_len <= 0:
        raise ValueError('segment lengths must be positive')
    to_target = sub(target, root)
    distance = length(to_target)
    if distance < 1e-9:
        raise ValueError('target coincides with chain root')
    axis = mul(to_target, 1/distance)
    lo, hi = abs(upper_len-lower_len)+slack, upper_len+lower_len-slack
    reached = lo <= distance <= hi
    d = min(max(distance, lo), hi)
    # Component of the pole hint orthogonal to the chain axis decides the bend plane.
    bend = sub(pole, mul(axis, dot(pole, axis)))
    if length(bend) < 1e-9:
        raise ValueError('pole is parallel to the chain axis; bend plane undefined')
    bend = normalize(bend)
    along = (upper_len**2-lower_len**2+d**2)/(2*d)
    height = math.sqrt(max(upper_len**2-along**2, 0.))
    middle = add(add(root, mul(axis, along)), mul(bend, height))
    end = add(root, mul(axis, d))
    return middle, end, reached


def seated_ankle_target(hip, forward, up, upper_len, lower_len, ankle_floor_height,
                        max_thigh_drop_deg=20.):
    """Ankle target for sitting with the hip fixed above a seat.

    Prefers a vertical shin. If the floor is too close the shin leans forward with a level thigh;
    if it is too far the thigh tilts down up to max_thigh_drop_deg, then the feet hang.
    Heights are measured along `up`; `forward` must be orthogonal to `up`.
    Returns (ankle_target, thigh_drop_deg, feet_on_floor).
    """
    forward, up = normalize(forward), normalize(up)
    drop_needed = dot(hip, up)-ankle_floor_height-lower_len  # knee height above ankle-on-floor for vertical shin
    sin_t = drop_needed/upper_len
    max_sin = math.sin(math.radians(max_thigh_drop_deg))
    if sin_t <= 0:
        # Low seat: level thigh, shin leans forward to reach the floor.
        knee = add(hip, mul(forward, upper_len))
        vertical = dot(knee, up)-ankle_floor_height
        horizontal = math.sqrt(max(lower_len**2-vertical**2, 0.))
        ankle = add(add(knee, mul(forward, horizontal)), mul(up, -vertical))
        return ankle, 0., True
    feet_on_floor = sin_t <= max_sin
    sin_t = min(sin_t, max_sin)
    cos_t = math.sqrt(1-sin_t**2)
    knee = add(hip, add(mul(forward, upper_len*cos_t), mul(up, -upper_len*sin_t)))
    ankle = add(knee, mul(up, -lower_len))
    return ankle, math.degrees(math.asin(sin_t)), feet_on_floor


def clamp_direction(base, desired, max_deg):
    """Rotate `base` toward `desired` by at most max_deg degrees (both unit vectors)."""
    base, desired = normalize(base), normalize(desired)
    angle = math.acos(max(-1., min(1., dot(base, desired))))
    if angle <= math.radians(max_deg) or angle < 1e-9:
        return desired
    axis = cross(base, desired)
    if length(axis) < 1e-9:
        return base
    return rotate(base, normalize(axis), math.radians(max_deg))


def rotate(v, axis, angle):
    """Rodrigues rotation of v about unit axis by angle (radians)."""
    c, s = math.cos(angle), math.sin(angle)
    return add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v)*(1-c)))
