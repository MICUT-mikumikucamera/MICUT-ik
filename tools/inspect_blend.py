"""Read-only source inspection. Run with Blender --background FILE --python this.py."""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
report = {
    'blender_version': bpy.app.version_string,
    'unit_system': bpy.context.scene.unit_settings.system,
    'scale_length': bpy.context.scene.unit_settings.scale_length,
    'objects': [],
    'images': [],
}
for o in bpy.data.objects:
    row = {'name': o.name, 'type': o.type, 'parent': o.parent.name if o.parent else None,
           'hide_render': o.hide_render, 'location': list(o.location),
           'rotation': list(o.rotation_euler), 'scale': list(o.scale),
           'dimensions': list(o.dimensions)}
    if o.type == 'MESH':
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        row.update(vertices=len(o.data.vertices), polygons=len(o.data.polygons),
                   bounds_min=[min(p[i] for p in pts) for i in range(3)],
                   bounds_max=[max(p[i] for p in pts) for i in range(3)],
                   modifiers=[{'type': m.type, 'object': getattr(getattr(m, 'object', None), 'name', None)} for m in o.modifiers],
                   vertex_groups=len(o.vertex_groups))
    if o.type == 'ARMATURE':
        row['bones'] = [{'name': b.name, 'head': list(o.matrix_world @ b.head_local),
                         'tail': list(o.matrix_world @ b.tail_local)} for b in o.data.bones]
    report['objects'].append(row)
for im in bpy.data.images:
    report['images'].append({'name': im.name, 'size': list(im.size), 'packed': bool(im.packed_file),
                             'filepath': im.filepath})
target = Path(args[0] if args else 'blend_inspection.json')
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('INSPECTION_WRITTEN', target)
