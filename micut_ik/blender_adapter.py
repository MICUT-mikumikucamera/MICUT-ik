"""Blender implementation of the placement contract. No source .blend writes."""
import hashlib
import json
import math
from pathlib import Path
import time

import bpy
from mathutils import Matrix, Vector

from . import posing
from .contracts import (ContractError, LOCAL_FRAME_NOTE, blender_to_geometry, geometry_to_blender,
                        horizontal_facing, project_world, to_local)
from .posing import SIDES, evaluated_vertices  # noqa: F401  (evaluated_vertices is used by external tools)


def bounds(points):
    if not points:
        raise ContractError('no evaluated mesh vertices')
    lo = [min(v[i] for v in points) for i in range(3)]
    hi = [max(v[i] for v in points) for i in range(3)]
    return {'min': lo, 'max': hi, 'size': [hi[i]-lo[i] for i in range(3)]}


def rest_measure(rig):
    """Measure the unposed model once. Scale comes from here, so it never depends on the pose."""
    verts = rig.vertices()
    feet = posing.foot_points(rig, verts)
    sole = min(rig.height(p) for p in feet.values())
    ankles = {s: rig.joint(f'{s}_foot') for s in SIDES}
    return {'height': max(rig.height(v) for v in verts)-sole, 'sole_height': sole, 'ankles': ankles,
            'ankle_height': {s: rig.height(ankles[s])-rig.height(feet[s]) for s in SIDES},
            'dimensions': bounds(verts)['size']}


def penetration(rig, verts, support, tol):
    """Vertices sinking below the support under them, split by hair / skirt / body."""
    cats = rig.profile.get('secondary_categories', {})
    counts = {'hair': 0, 'skirt': 0, 'body': 0}
    by_group = {}
    deepest = 0.
    for v, w in zip(verts, rig.weights):
        depth = support(v)-rig.height(v)
        if depth <= tol:
            continue
        group = max(w, key=w.get) if w else ''
        cat = next((c for c, prefixes in cats.items() if any(group.startswith(p) for p in prefixes)), 'body')
        counts[cat] += 1
        by_group[group] = by_group.get(group, 0)+1
        deepest = max(deepest, depth)
    top = dict(sorted(by_group.items(), key=lambda kv: -kv[1])[:6])
    return counts, deepest, top


def prepare_model(profile, placement, camera, pose):
    if profile.get('source_up_axis') != '+Z' or profile.get('source_forward_axis') != '-Y':
        raise ContractError('this Blender source adapter expects Z up, -Y front')
    if placement.model_id is not None and placement.model_id != profile['model_id']:
        raise ContractError('request model_id differs from loaded model profile', 'MODEL_MISMATCH')
    height = profile.get('target_height_m')
    if isinstance(height, bool) or not isinstance(height, (float, int)) or not math.isfinite(height) or height <= 0:
        raise ContractError('target_height_m must be a positive finite explicit setting')
    armature = bpy.data.objects.get(profile['armature_name'])
    meshes = [bpy.data.objects.get(name) for name in profile['mesh_names']]
    if armature is None or armature.type != 'ARMATURE' or any(o is None or o.type != 'MESH' for o in meshes):
        raise ContractError('profile mesh/armature names do not match source model', 'MODEL_MISMATCH')
    for obj in bpy.data.objects:
        if obj.type in ('MESH', 'LIGHT'):
            obj.hide_render = obj not in meshes

    started = time.perf_counter()
    rig = posing.Rig(armature, meshes, profile)
    rig.capture_rest()
    rest = rest_measure(rig)
    scale = height/rest['height']
    direction = horizontal_facing(placement, camera['t'])
    target_direction = geometry_to_blender(direction)
    yaw = math.atan2(target_direction[1], target_direction[0])+math.pi/2
    arm_world = armature.matrix_world.copy()
    anchor_world = Vector(geometry_to_blender(placement.anchor_position))

    def root_matrix(anchor_src):
        return (Matrix.Translation(anchor_world) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(scale, 4)
                @ Matrix.Translation(-(arm_world @ anchor_src)))

    def camera_src_of(anchor_src):
        return arm_world.inverted() @ root_matrix(anchor_src).inverted() @ Vector(geometry_to_blender(camera['t']))

    anchor_src, ik_report, support, planes = posing.apply_pose(
        rig, pose, scale, rest, placement.anchor_position[1], camera_src_of)
    verts_src = rig.vertices()
    feet_src = posing.foot_points(rig, verts_src)
    proxies = posing.capsules(rig, verts_src)
    pen_counts, pen_depth, pen_groups = penetration(rig, verts_src, support, .005/scale)

    # Preserve internal rig hierarchy and original transforms under one placement root.
    normalizer = bpy.data.objects.new('MiCut_Placement_Root', None)
    bpy.context.scene.collection.objects.link(normalizer)
    roots = set()
    for obj in [armature]+meshes:
        while obj.parent:
            obj = obj.parent
        roots.add(obj)
    for obj in roots:
        world = obj.matrix_world.copy()
        obj.parent = normalizer
        obj.matrix_world = world
    total = root_matrix(anchor_src)
    normalizer.matrix_world = total
    bpy.context.view_layer.update()
    pose_seconds = time.perf_counter()-started

    to_geo = lambda p_src: blender_to_geometry(total @ (arm_world @ p_src))  # noqa: E731
    placed = evaluated_vertices(meshes)
    world_points = [blender_to_geometry(point) for _, _, point in placed]
    anchor = placement.anchor_position
    local_points = [to_local(p, anchor, direction) for p in world_points]
    local_bounds = bounds(local_points)
    foot_world = {side: list(to_geo(p)) for side, p in feet_src.items()}
    floor_gap = {side: foot_world[side][1] for side in SIDES}
    proxy_out = {}
    for name, c in proxies.items():
        a, b = to_geo(c['a']), to_geo(c['b'])
        proxy_out[name] = {'a_local': list(to_local(a, anchor, direction)), 'b_local': list(to_local(b, anchor, direction)),
                           'radius_m': c['radius']*scale, 'a_world': list(a), 'b_world': list(b),
                           'source_vertices': c['vertices']}
    seated = placement.anchor_type == 'pelvis_seat_contact'
    manifest = {
        'model_id': profile['model_id'], 'unit': 'm', 'pose_id': placement.pose_id, 'action': placement.action,
        'source_dimensions_blender_units': rest['dimensions'], 'source_height_above_soles_units': rest['height'],
        'target_height_m': height, 'target_height_note': profile.get('target_height_note'),
        'applied_uniform_scale': scale, 'source_anchor_blender_units': list(anchor_src),
        'anchor_type': placement.anchor_type, 'anchor_position': list(anchor),
        'facing_direction_geometry': list(direction), 'blender_yaw_rad': yaw,
        'local_frame': LOCAL_FRAME_NOTE,
        'normalized_local_bounds_m': local_bounds,
        'normalized_size_m': {'width': local_bounds['size'][0], 'height': local_bounds['size'][1],
                              'depth': local_bounds['size'][2]},
        'world_bounds_geometry_m': bounds(world_points), 'foot_contact_points_geometry_m': foot_world,
        'foot_height_difference_m': abs(foot_world['left'][1]-foot_world['right'][1]),
        'foot_anchor_method': 'midpoint of weighted left/right near-sole bounds; lower sole is ground',
        'support': {'type': 'seat' if seated else 'floor', 'height_m': anchor[1],
                    'support_candidate_id': placement.support_candidate_id},
        'selection': placement.selection,
        'contacts': {
            'anchor': {'type': placement.anchor_type, 'local': [0., 0., 0.], 'world': list(anchor)},
            'feet': {side: {'world': foot_world[side], 'local': list(to_local(foot_world[side], anchor, direction)),
                            'floor_gap_m': floor_gap[side]} for side in SIDES},
        },
        'includes': 'all selected evaluated mesh vertices, including hair, costume and hands',
        'body_collision_proxy': {'type': 'capsules', 'frame': 'local and geometry world',
                                 'radius_rule': '85th percentile distance of segment-weighted vertices',
                                 'excludes': 'hair, skirt, sleeves and accessories (not in proxy vertex groups)',
                                 'segments': proxy_out},
        'pose_report': ik_report,
        'penetration_below_support': {'vertices': pen_counts, 'deepest_m': pen_depth*scale, 'by_group': pen_groups,
                                      'note': 'support = floor, plus the seat plane inside +-seat_half_extent_m '
                                              'of the anchor for seated poses'},
        'blender_root_matrix': [list(row) for row in total],
    }
    return manifest, world_points, pose_seconds, {'seated': seated, 'scale': scale, 'direction': direction}


def make_camera(camera):
    scene = bpy.context.scene
    scene.render.resolution_x = camera['width']
    scene.render.resolution_y = camera['height']
    scene.render.resolution_percentage = 100
    # Blender clamps pixel aspects to >=1; distribute the ratio across both axes.
    scene.render.pixel_aspect_x = max(1., camera['fy']/camera['fx'])
    scene.render.pixel_aspect_y = max(1., camera['fx']/camera['fy'])
    data = bpy.data.cameras.new('MiCut_Calibrated_Camera')
    data.type = 'PERSP'
    data.sensor_fit = 'HORIZONTAL'
    data.sensor_width = 36.
    data.lens = camera['fx']*data.sensor_width/camera['width']
    data.shift_x = (camera['width']/2-camera['cx'])/camera['width']
    data.shift_y = ((camera['cy']-camera['height']/2)/camera['width']
                    *scene.render.pixel_aspect_y/scene.render.pixel_aspect_x)
    data.clip_start, data.clip_end = .01, 1000.
    obj = bpy.data.objects.new('MiCut_Calibrated_Camera', data)
    scene.collection.objects.link(obj)
    # Geometry Y-up LH -> Blender Z-up RH: F swaps Y/Z (det=-1).
    # CV camera (x right,y down,z forward) -> Blender camera: D=diag(1,-1,-1).
    f = Matrix(((1, 0, 0), (0, 0, 1), (0, 1, 0)))
    d = Matrix.Diagonal(Vector((1, -1, -1)))
    rotation = f @ Matrix(camera['R']) @ d
    # Input R is rounded in spatial_info.json. Remove only tiny orthogonality drift.
    matrix = rotation.to_quaternion().to_matrix().to_4x4()
    matrix.translation = Vector(geometry_to_blender(camera['t']))
    obj.matrix_world = matrix
    scene.camera = obj
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.
    bpy.context.view_layer.update()
    return obj


def lighting(anchor):
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new('MiCut_Studio_World')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.65, .7, .75, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .7
    base = Vector(geometry_to_blender(anchor))
    for name, pos, power, size in [('Key', (2,-3,4), 500, 4), ('Fill', (-2,-1,2), 250, 3)]:
        data = bpy.data.lights.new('MiCut_'+name, 'AREA')
        data.energy, data.shape, data.size = power, 'DISK', size
        obj = bpy.data.objects.new('MiCut_'+name, data)
        scene.collection.objects.link(obj)
        obj.location = base+Vector(pos)
        obj.rotation_euler = (base+Vector((0,0,.8))-obj.location).to_track_quat('-Z', 'Y').to_euler()


def _srgb_to_linear(x):
    import numpy as np
    return np.where(x <= .04045, x/12.92, ((x+.055)/1.055)**2.4)


def _box_blur(a, r, axis, wrap=False):
    import numpy as np
    if r < 1:
        return a
    n = 2*r+1
    pad = [(0, 0)]*a.ndim
    pad[axis] = (r, r)
    padded = np.pad(a, pad, mode='wrap' if wrap else 'edge')
    c = np.cumsum(padded, axis=axis)
    c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
    return (np.take(c, range(n, c.shape[axis]), axis=axis)-np.take(c, range(0, c.shape[axis]-n), axis=axis))/n


def load_photo_linear(path):
    """Photo as (H, W, 3) linear float, row 0 = top. Uses Blender's loader (no PIL inside Blender)."""
    import numpy as np
    img = bpy.data.images.load(str(path), check_existing=False)
    img.colorspace_settings.name = 'Non-Color'  # read the stored sRGB code values unchanged
    w, h = img.size
    px = np.empty(w*h*4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return _srgb_to_linear(px.reshape(h, w, 4)[::-1, :, :3].astype(np.float64))


def photo_lighting(camera, photo_path, exposure=2., ceiling_gain=1.3, env_size=(256, 128)):
    """World lighting estimated from the photo itself, with no light probe.

    Directions the camera saw take the blurred photo colour (parallax ignored). Unseen directions
    take the photo's top-band mean (ceiling, times ceiling_gain), bottom-band mean (floor) or the
    global mean. Exposure compensates for the scene albedo baked into photo pixels (~0.5).
    """
    import numpy as np
    photo = load_photo_linear(photo_path)
    h, w = photo.shape[:2]
    f = max(1, w//64)
    small = photo[:h//f*f, :w//f*f].reshape(h//f, f, w//f, f, 3).mean((1, 3))
    for axis in (0, 1):
        small = _box_blur(small, 2, axis)
    sh, sw = small.shape[:2]
    band = max(1, sh//6)
    top, bottom, mean = small[:band].reshape(-1, 3).mean(0), small[-band:].reshape(-1, 3).mean(0), small.reshape(-1, 3).mean(0)
    W, H = env_size
    az = ((np.arange(W)+.5)/W-.5)*2*math.pi
    el = ((np.arange(H)+.5)/H-.5)*math.pi
    az, el = np.meshgrid(az, el)  # row 0 = bottom (Blender image rows), el from -90 to 90
    d_bl = np.stack([np.cos(el)*np.cos(az), np.cos(el)*np.sin(az), np.sin(el)], -1)
    d_geo = d_bl[..., [0, 2, 1]]
    R = np.array(camera['R'])
    d_cam = d_geo @ R  # = R.T @ d for each row vector
    env = np.where((el > math.radians(25))[..., None], top*ceiling_gain,
                   np.where((el < math.radians(-15))[..., None], bottom, mean))
    with np.errstate(divide='ignore', invalid='ignore'):
        u = camera['fx']*d_cam[..., 0]/d_cam[..., 2]+camera['cx']
        v = camera['fy']*d_cam[..., 1]/d_cam[..., 2]+camera['cy']
    seen = (d_cam[..., 2] > 0) & (u >= 0) & (u < camera['width']) & (v >= 0) & (v < camera['height'])
    ui = np.clip((u/camera['width']*sw).astype(int), 0, sw-1)
    vi = np.clip((v/camera['height']*sh).astype(int), 0, sh-1)
    env = np.where(seen[..., None], small[vi, ui], env)
    for _ in range(3):
        env = _box_blur(env, 6, 1, wrap=True)
        env = _box_blur(env, 4, 0)
    env = env*exposure
    image = bpy.data.images.new('MiCut_Photo_Environment', W, H, float_buffer=True, alpha=False)
    try:
        image.colorspace_settings.name = 'Linear Rec.709'
    except TypeError:
        image.colorspace_settings.name = 'Non-Color'
    image.pixels.foreach_set(np.concatenate([env, np.ones((H, W, 1))], -1).astype(np.float32).ravel())
    image.pack()

    scene = bpy.context.scene
    world = bpy.data.worlds.new('MiCut_Photo_World')
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    coord, norm = nt.nodes.new('ShaderNodeTexCoord'), nt.nodes.new('ShaderNodeVectorMath')
    norm.operation = 'NORMALIZE'
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(coord.outputs['Generated'], norm.inputs[0])
    nt.links.new(norm.outputs['Vector'], sep.inputs[0])

    def math_node(op, a, b=None, value=None):
        n = nt.nodes.new('ShaderNodeMath')
        n.operation = op
        nt.links.new(a, n.inputs[0])
        if b is not None:
            nt.links.new(b, n.inputs[1])
        elif value is not None:
            n.inputs[1].default_value = value
        return n.outputs[0]
    # Our own equirect convention, matching the image built above: u = az/2pi + 0.5, v = el/pi + 0.5.
    uu = math_node('ADD', math_node('DIVIDE', math_node('ARCTAN2', sep.outputs['Y'], sep.outputs['X']), value=2*math.pi), value=.5)
    vv = math_node('ADD', math_node('DIVIDE', math_node('ARCSINE', sep.outputs['Z']), value=math.pi), value=.5)
    comb = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(uu, comb.inputs['X'])
    nt.links.new(vv, comb.inputs['Y'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image, tex.extension, tex.interpolation = image, 'EXTEND', 'Linear'
    nt.links.new(comb.outputs['Vector'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 1.
    scene.world = world
    return {'method': 'photo environment (seen directions = blurred photo, unseen = band means)',
            'exposure': exposure, 'ceiling_gain': ceiling_gain,
            'mean_linear_rgb': [round(float(x), 4) for x in mean],
            'top_linear_rgb': [round(float(x), 4) for x in top], 'bottom_linear_rgb': [round(float(x), 4) for x in bottom],
            'seen_fraction_of_sphere': round(float(seen.mean()), 3)}, bottom


def shadow_catchers(anchor, direction, seated, floor_rgb, seat_half=.25, floor_half=1.5):
    """Invisible planes that only receive Miku's shadow: the floor, plus the seat top when sitting."""
    mat = bpy.data.materials.new('MiCut_Catcher')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*[float(min(1., c*2)) for c in floor_rgb], 1)  # albedo ~ pixel/0.5
        bsdf.inputs['Roughness'].default_value = 1.
    made = []
    base = Vector(geometry_to_blender((anchor[0], 0, anchor[2])))
    # Kept small: every floor pixel the plane covers is path traced. Shadow 1.5 m away is ~1% and is faded out.
    bpy.ops.mesh.primitive_plane_add(size=floor_half*2, location=base)
    made.append(bpy.context.object)
    if seated:
        f = Vector(geometry_to_blender(direction))
        bpy.ops.mesh.primitive_plane_add(size=seat_half*2, location=Vector(geometry_to_blender(anchor))+Vector((0, 0, .001)))
        seat = bpy.context.object
        seat.rotation_euler = (0, 0, math.atan2(f.y, f.x))
        made.append(seat)
    for obj in made:
        obj.data.materials.append(mat)
        obj.is_shadow_catcher = True
        obj.name = 'MiCut_Shadow_Catcher'
    return [o.name for o in made]


def scaled_camera(camera, scale):
    """Same lens at a higher pixel count. Continuous pixel coordinates scale linearly (origin at the corner)."""
    w, h = round(camera['width']*scale), round(camera['height']*scale)
    sx, sy = w/camera['width'], h/camera['height']
    return {**camera, 'width': w, 'height': h, 'fx': camera['fx']*sx, 'fy': camera['fy']*sy,
            'cx': camera['cx']*sx, 'cy': camera['cy']*sy}


def debug_supports(anchor, direction, seated):
    """Preview-only floor plane and seat block. Never use these renders for photo compositing."""
    mat = bpy.data.materials.new('MiCut_Debug_Support')
    mat.diffuse_color = (.55, .55, .55, 1)
    if mat.node_tree:
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = (.55, .55, .55, 1)
    base = Vector(geometry_to_blender((anchor[0], 0, anchor[2])))
    bpy.ops.mesh.primitive_plane_add(size=4, location=base)
    bpy.context.object.data.materials.append(mat)
    if seated:
        f = Vector(geometry_to_blender(direction))
        size, h = .45, anchor[1]
        centre = base-f*(size/2-.12)+Vector((0, 0, h/2))
        bpy.ops.mesh.primitive_cube_add(size=1, location=centre)
        seat = bpy.context.object
        seat.scale = (size, size, h)
        seat.rotation_euler = (0, 0, math.atan2(f.y, f.x))
        seat.data.materials.append(mat)


def projection_report(points, camera):
    samples = [project_world(point, camera) for point in points]
    valid = [p for p in samples if p is not None]
    if not valid:
        return {'fully_in_frame': False, 'all_behind_camera': True}
    lo = [min(p[i] for p in valid) for i in range(2)]
    hi = [max(p[i] for p in valid) for i in range(2)]
    inside = sum(1 for p in valid if 0 <= p[0] <= camera['width'] and 0 <= p[1] <= camera['height'])
    return {'bbox_px': {'min': lo, 'max': hi},
            'fully_in_frame': len(valid) == len(points) and lo[0] >= 0 and lo[1] >= 0
                              and hi[0] <= camera['width'] and hi[1] <= camera['height'],
            'visible_vertex_fraction': inside/len(points),
            'vertices_behind_camera': len(points)-len(valid),
            'automatic_rescale': False,
            'note': 'image framing only; does not validate collision, floor occupancy or occlusion'}


def _set_format(settings, fmt):
    if fmt == 'EXR':
        if hasattr(settings, 'media_type'):  # Blender 5.x: pick the media type first
            settings.media_type = 'MULTI_LAYER_IMAGE'
        settings.file_format = 'OPEN_EXR_MULTILAYER'
        settings.color_depth = '32'
        settings.exr_codec = 'ZIP'
    else:
        if hasattr(settings, 'media_type'):
            settings.media_type = 'IMAGE'
        settings.file_format = 'PNG'
        settings.color_mode = 'RGBA'
        settings.color_depth = '8'


def render(output_dir, samples=16, passes=False):
    """character.png always; with passes=True also passes.exr (linear Combined, Depth, Shadow Catcher)."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.use_compositing = False
    # Diffuse character in a soft environment: deep bounces add time, not visible light.
    c = scene.cycles
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces = 4, 2, 2, 2
    c.volume_bounces, c.transparent_max_bounces = 0, 8
    if passes:
        # Plain sRGB display transform so the PNG and the linear EXR agree with the photo's encoding.
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
        scene.view_settings.exposure, scene.view_settings.gamma = 0., 1.
        layer = bpy.context.view_layer
        layer.use_pass_z = True
        layer.cycles.use_pass_shadow_catcher = True
        _set_format(scene.render.image_settings, 'EXR')
        scene.render.filepath = str(Path(output_dir)/'passes.exr')
        bpy.ops.render.render(write_still=True)
        _set_format(scene.render.image_settings, 'PNG')
        bpy.data.images['Render Result'].save_render(filepath=str(Path(output_dir)/'character.png'), scene=scene)
        return
    _set_format(scene.render.image_settings, 'PNG')
    scene.render.filepath = str(Path(output_dir)/'character.png')
    bpy.ops.render.render(write_still=True)


def export_shape(path, profile, meshes, world_points, anchor, direction):
    """Same npz layout as the placement repo's tools/export_stand_shape.py, for any pose."""
    import numpy as np
    world = np.array(world_points)
    local = np.array([to_local(p, anchor, direction) for p in world_points])
    weights, faces, offset = [], [], 0
    for obj in meshes:
        wanted = {obj.vertex_groups[n].index for names in profile['foot_groups'].values()
                  for n in names if n in obj.vertex_groups}
        weights.extend(sum(g.weight for g in v.groups if g.group in wanted) for v in obj.data.vertices)
        for poly in obj.data.polygons:
            vs = list(poly.vertices)
            faces.extend([offset+vs[0], offset+vs[i], offset+vs[i+1]] for i in range(1, len(vs)-1))
        offset += len(obj.data.vertices)
    np.savez_compressed(path, local_vertices=local, faces=np.array(faces, np.int32),
                        foot_weight=np.array(weights, np.float32), world_vertices=world,
                        anchor=np.array(anchor), facing=np.array(direction))
    return {'file': Path(path).name, 'vertices': len(world_points), 'triangles': len(faces)}


def run(profile, placement, camera, output_dir, samples=16, render_enabled=True, pose=None,
        shape=False, debug=False, photo=None, render_scale=1., exposure=2.):
    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    manifest, points, pose_seconds, info = prepare_model(profile, placement, camera, pose)
    render_camera = scaled_camera(camera, render_scale)
    make_camera(render_camera)
    light_report, catchers = {'method': 'fixed studio lights'}, []
    if photo:
        light_report, floor_rgb = photo_lighting(camera, photo, exposure)
        catchers = shadow_catchers(placement.anchor_position, info['direction'], info['seated'], floor_rgb,
                                   profile.get('seat_half_extent_m', .25))
    else:
        lighting(placement.anchor_position)
    if debug:
        debug_supports(placement.anchor_position, info['direction'], info['seated'])
    source = Path(bpy.data.filepath)
    manifest['source_file_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    manifest['source_file_name'] = source.name
    manifest['render_environment'] = {'engine': 'Blender Cycles CPU', 'blender': bpy.app.version_string}
    if shape:
        meshes = [bpy.data.objects[n] for n in profile['mesh_names']]
        manifest['shape_export'] = export_shape(out/'shape.npz', profile, meshes, points,
                                                placement.anchor_position, info['direction'])
    report = {'schema_version': '0.3', 'status': 'rendered' if render_enabled else 'inspected',
              'pose_id': placement.pose_id, 'projection': projection_report(points, camera),
              'camera': camera, 'render_camera': render_camera, 'render_scale': render_scale,
              'lighting': light_report, 'shadow_catchers': catchers, 'floor_catcher_half_m': 1.5 if catchers else None,
              'outputs': ['character.png']+(['passes.exr'] if photo else []),
              'debug_supports_rendered': bool(debug),
              'limitations': ['pose presets + analytic two-bone IK; no physics for hair or skirt (bone-level settling only)',
                              'lighting estimated from the photo only (no light probe); directional key light not estimated',
                              'source metric accuracy is inherited, not validated by rendering']}
    if not info['seated'] and manifest['foot_height_difference_m'] > .003:
        report['foot_warning'] = 'both soles are not coplanar; no corrective foot IK applied'
    legs = manifest['pose_report'].get('legs', {})
    if info['seated'] and not all(v.get('feet_on_floor', True) for v in legs.values()):
        report['foot_warning'] = 'seat too high for both feet to reach the floor; feet hang'
    if not report['projection']['fully_in_frame']:
        report['status'] = 'rendered_with_framing_warning' if render_enabled else 'framing_warning'
    render_seconds = 0.
    if render_enabled:
        t = time.perf_counter()
        render(out, samples, passes=bool(photo))
        render_seconds = time.perf_counter()-t
    report['timing_s'] = {'pose_and_measure': round(pose_seconds, 3), 'render': round(render_seconds, 3),
                          'total_in_blender': round(time.perf_counter()-started, 3)}
    (out/'model_manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'placement_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'error.json').unlink(missing_ok=True)
    return report
