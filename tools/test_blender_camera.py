"""Projection regression: Blender camera pixels must agree with the geometry K/R/t."""
import json
from pathlib import Path
import sys
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from micut_ik.contracts import camera_contract, project_world, geometry_to_blender
from micut_ik.blender_adapter import make_camera

spatial = json.loads((ROOT/'examples/spatial.synthetic.json').read_text())
max_error = 0
for width, height, fx, fy, cx, cy in [(768,1024,900,900,384,512),
                                    (1280,720,1100,900,610,390),
                                    (500,800,400,530,234,375)]:
    spatial['image'].update(width=width, height=height)
    spatial['camera'].update(fx=fx, fy=fy, cx=cx, cy=cy)
    camera = camera_contract(spatial)
    obj = make_camera(camera)
    assert abs(obj.matrix_world.to_3x3().determinant()-1) < 1e-5
    for cv in [(0,0,3),(.4,.2,2),(-.6,-.5,4),(0,1,5)]:
        point = [camera['t'][i]+sum(camera['R'][i][j]*cv[j] for j in range(3)) for i in range(3)]
        expected = project_world(point, camera)
        ndc = world_to_camera_view(bpy.context.scene, obj, Vector(geometry_to_blender(point)))
        actual = (ndc.x*width, (1-ndc.y)*height)
        err = max(abs(actual[i]-expected[i]) for i in range(2))
        max_error = max(max_error, err)
        assert err < .01, (expected, actual, err)
print('CAMERA_PROJECTION_PASS max_error_px=', max_error)

if '--' in sys.argv:
    spatial = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8-sig'))
    camera = camera_contract(spatial)
    obj = make_camera(camera)
    for cv in [(0,0,3),(.4,.2,2),(-.6,-.5,4),(0,1,5)]:
        point = [camera['t'][i]+sum(camera['R'][i][j]*cv[j] for j in range(3)) for i in range(3)]
        expected = project_world(point, camera)
        ndc = world_to_camera_view(bpy.context.scene, obj, Vector(geometry_to_blender(point)))
        err = max(abs(ndc.x*camera['width']-expected[0]), abs((1-ndc.y)*camera['height']-expected[1]))
        assert err < .01, ('provided spatial camera mismatch', err)
        max_error = max(max_error, err)
    print('PROVIDED_SPATIAL_CAMERA_PASS max_error_px=', max_error)
