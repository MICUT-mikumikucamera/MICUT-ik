"""Blender implementation of the placement contract. No source .blend writes."""
import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from .contracts import (ContractError, geometry_to_blender, blender_to_geometry,
                        horizontal_facing, project_world)


def evaluated_vertices(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    result = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            if len(mesh.vertices) != len(obj.data.vertices):
                raise ContractError('topology-changing modifiers require a different foot-group adapter')
            result.extend((obj, v.index, evaluated.matrix_world @ v.co) for v in mesh.vertices)
        finally:
            evaluated.to_mesh_clear()
    return result


def bounds(points):
    if not points:
        raise ContractError('no evaluated mesh vertices')
    lo = [min(v[i] for v in points) for i in range(3)]
    hi = [max(v[i] for v in points) for i in range(3)]
    return {'min': lo, 'max': hi, 'size': [hi[i]-lo[i] for i in range(3)]}


def apply_stand(armature, profile):
    # This is a fixed integration preset, not a contact/obstacle IK solver.
    changes = []
    for side, sign in [('left', 1), ('right', -1)]:
        name = profile['arm_bones'][side]
        bone = armature.pose.bones.get(name)
        if bone is None:
            raise ContractError(f'missing stand preset bone: {name}')
        angle = math.radians(profile['arm_lowering_degrees'])*sign
        head = bone.head.copy()
        bone.matrix = (Matrix.Translation(head) @ Matrix.Rotation(angle, 4, 'Y')
                       @ Matrix.Translation(-head) @ bone.matrix)
        bpy.context.view_layer.update()
        changes.append({'bone': name, 'armature_space_y_rotation_deg': math.degrees(angle)})
    return changes


def sole_anchor(vertices, profile):
    feet = {}
    for side, names in profile['foot_groups'].items():
        points = []
        for obj, index, point in vertices:
            wanted = {obj.vertex_groups[n].index for n in names if n in obj.vertex_groups}
            weight = sum(g.weight for g in obj.data.vertices[index].groups if g.group in wanted)
            if weight >= profile['feet_weight_threshold']:
                points.append(point)
        if not points:
            raise ContractError(f'{side} sole has no weighted vertices; configure foot groups')
        floor = min(p.z for p in points)
        near = [p for p in points if p.z <= floor+0.012]
        extent = bounds(near)
        feet[side] = {'point': [(extent['min'][i]+extent['max'][i])/2 for i in range(2)]+[floor],
                      'selected_vertices': len(points), 'sole_vertices': len(near)}
    anchor = Vector(((feet['left']['point'][0]+feet['right']['point'][0])/2,
                     (feet['left']['point'][1]+feet['right']['point'][1])/2,
                     min(feet['left']['point'][2], feet['right']['point'][2])))
    return anchor, feet


def prepare_model(profile, placement, camera):
    if profile.get('source_up_axis') != '+Z' or profile.get('source_forward_axis') != '-Y':
        raise ContractError('this Blender source adapter expects Z up, -Y front')
    if profile.get('pose_id') != 'stand_default':
        raise ContractError('only stand_default is implemented')
    if placement.model_id is not None and placement.model_id != profile['model_id']:
        raise ContractError('request model_id differs from loaded model profile')
    height = profile.get('target_height_m')
    if isinstance(height, bool) or not isinstance(height, (float, int)) or not math.isfinite(height) or height <= 0:
        raise ContractError('target_height_m must be a positive finite explicit setting')
    armature = bpy.data.objects.get(profile['armature_name'])
    meshes = [bpy.data.objects.get(name) for name in profile['mesh_names']]
    if armature is None or armature.type != 'ARMATURE' or any(o is None or o.type != 'MESH' for o in meshes):
        raise ContractError('profile mesh/armature names do not match source model')
    for obj in bpy.data.objects:
        if obj.type in ('MESH', 'LIGHT'):
            obj.hide_render = obj not in meshes
    changes = apply_stand(armature, profile)
    vertices = evaluated_vertices(meshes)
    raw = bounds([v for _, _, v in vertices])
    anchor, feet = sole_anchor(vertices, profile)
    source_height = raw['max'][2]-anchor.z
    if source_height <= 0:
        raise ContractError('invalid model height above soles')
    scale = height/source_height
    direction = horizontal_facing(placement, camera['t'])
    target_direction = geometry_to_blender(direction)
    yaw = math.atan2(target_direction[1], target_direction[0])+math.pi/2
    normalizer = bpy.data.objects.new('MiCut_Placement_Root', None)
    bpy.context.scene.collection.objects.link(normalizer)
    # Preserve internal rig hierarchy and original transforms under one placement root.
    roots = set()
    for obj in [armature]+meshes:
        while obj.parent:
            obj = obj.parent
        roots.add(obj)
    for obj in roots:
        world = obj.matrix_world.copy()
        obj.parent = normalizer
        obj.matrix_world = world
    normalizer.matrix_world = (Matrix.Translation(Vector(geometry_to_blender(placement.anchor_position)))
                               @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(scale, 4)
                               @ Matrix.Translation(-anchor))
    bpy.context.view_layer.update()
    placed = evaluated_vertices(meshes)
    world_points = [blender_to_geometry(point) for _, _, point in placed]
    bbox = bounds(world_points)
    # Local physical size, before yaw, suitable as a conservative appearance envelope.
    local_points = [((point.x-anchor.x)*scale, (point.z-anchor.z)*scale,
                     -(point.y-anchor.y)*scale) for _, _, point in vertices]
    local_bounds = bounds(local_points)
    foot_world = {side: list(blender_to_geometry(normalizer.matrix_world @ Vector(data['point'])))
                  for side, data in feet.items()}
    return {
        'model_id': profile['model_id'], 'unit': 'm', 'pose_id': 'stand_default',
        'source_dimensions_blender_units': raw['size'], 'source_height_above_soles_units': source_height,
        'target_height_m': height, 'target_height_note': profile.get('target_height_note'),
        'applied_uniform_scale': scale, 'source_anchor_blender_units': list(anchor),
        'anchor_type': 'feet_center_on_ground', 'anchor_position': list(placement.anchor_position),
        'facing_direction_geometry': list(direction), 'blender_yaw_rad': yaw,
        'normalized_local_bounds_m': local_bounds,
        'normalized_size_m': {'width': local_bounds['size'][0], 'height': local_bounds['size'][1],
                              'depth': local_bounds['size'][2]},
        'world_bounds_geometry_m': bbox, 'foot_contact_points_geometry_m': foot_world,
        'foot_height_difference_m': abs(foot_world['left'][1]-foot_world['right'][1]),
        'foot_anchor_method': 'midpoint of weighted left/right near-sole bounds; lower sole is ground',
        'includes': 'all selected evaluated mesh vertices, including hair, costume and hands',
        'body_collision_proxy': None,
        'preset_bone_changes': changes,
        'blender_root_matrix': [list(row) for row in normalizer.matrix_world],
    }, world_points


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


def projection_report(points, camera):
    samples = [project_world(point, camera) for point in points]
    valid = [p for p in samples if p is not None]
    if not valid:
        return {'fully_in_frame': False, 'all_behind_camera': True}
    lo = [min(p[i] for p in valid) for i in range(2)]
    hi = [max(p[i] for p in valid) for i in range(2)]
    return {'bbox_px': {'min': lo, 'max': hi},
            'fully_in_frame': len(valid) == len(points) and lo[0] >= 0 and lo[1] >= 0
                              and hi[0] <= camera['width'] and hi[1] <= camera['height'],
            'vertices_behind_camera': len(points)-len(valid),
            'automatic_rescale': False,
            'note': 'image framing only; does not validate collision, floor occupancy or occlusion'}


def render(output_dir, samples=16):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.use_compositing = False
    scene.render.filepath = str(Path(output_dir)/'character.png')
    bpy.ops.render.render(write_still=True)


def run(profile, placement, camera, output_dir, samples=16, render_enabled=True):
    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    manifest, points = prepare_model(profile, placement, camera)
    make_camera(camera)
    lighting(placement.anchor_position)
    source = Path(bpy.data.filepath)
    manifest['source_file_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    manifest['source_file_name'] = source.name
    manifest['render_environment'] = {'engine': 'Blender Cycles CPU', 'blender': bpy.app.version_string}
    report = {'schema_version': '0.1', 'status': 'rendered' if render_enabled else 'inspected',
              'projection': projection_report(points, camera),
              'camera': camera,
              'limitations': ['fixed standing preset, no new contact IK solver',
                              'no scene depth occlusion, collision solving or light estimation',
                              'source metric accuracy is inherited, not validated by rendering']}
    if manifest['foot_height_difference_m'] > .003:
        report['foot_warning'] = 'both soles are not coplanar; no corrective foot IK applied'
    if not report['projection']['fully_in_frame']:
        report['status'] = 'rendered_with_framing_warning' if render_enabled else 'framing_warning'
    if render_enabled:
        render(out, samples)
    (out/'model_manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'placement_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'error.json').unlink(missing_ok=True)
    return report
