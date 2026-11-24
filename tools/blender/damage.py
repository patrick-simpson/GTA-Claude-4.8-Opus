# Car damage sheet: one small picture every car kind shares for its dents, scrapes and broken glass.
#
#   blender --factory-startup --python tools/blender/damage.py --python-expr "import bpy; bpy.ops.wm.quit_blender()"
#
# (With the window showing: the owner watches. No car is re-exported, so cars_far.glb and the shared texture
# sheets are untouched.) Writes public/models/car_damage.webp, 512 x 512, four channels, read by src/ent/carDamage.ts:
#   R  dent relief: crumpled sheet metal, a height field (fine creases over broad buckles)
#   G  scrapes: long thin streaks along the panel, for the bare-metal scratch where a side was dragged on a wall
#   B  glass cracks: a spider web of rings and crazed cells, white on black
#   A  shatter cells: a random value per glass fragment, so a shattered pane can lose its pieces cell by cell
# Each channel is a node set baked from a plane as emission (Cycles, one sample: the nodes are exact).

import os
import bpy
import numpy as np

SIZE = 512
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'public', 'models', 'car_damage.webp'))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 1
scene.cycles.device = 'CPU'

me = bpy.data.meshes.new('plane')
me.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
uvl = me.uv_layers.new(name='UVMap')
for i, uv in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
    uvl.data[i].uv = uv
plane = bpy.data.objects.new('plane', me)
scene.collection.objects.link(plane)
mat = bpy.data.materials.new('dmg')
mat.use_nodes = True
plane.data.materials.append(mat)
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
out = nt.nodes.new('ShaderNodeOutputMaterial')
emit = nt.nodes.new('ShaderNodeEmission')
nt.links.new(emit.outputs[0], out.inputs[0])
coord = nt.nodes.new('ShaderNodeTexCoord')
target = nt.nodes.new('ShaderNodeTexImage')
img = bpy.data.images.new('bake', SIZE, SIZE, alpha=False, float_buffer=True)
img.colorspace_settings.name = 'Non-Color'
target.image = img
nt.nodes.active = target


def node(kind, **props):
    n = nt.nodes.new(kind)
    for k, v in props.items():
        if k.startswith('in_'):
            n.inputs[k[3:]].default_value = v
        else:
            setattr(n, k, v)
    return n


def mapped(sx, sy, sz=1.0):
    m = node('ShaderNodeMapping')
    m.inputs['Scale'].default_value = (sx, sy, sz)
    nt.links.new(coord.outputs['UV'], m.inputs['Vector'])
    return m


def ramp(sock, a, b, lo=0.0, hi=1.0):
    r = node('ShaderNodeMapRange', clamp=True)
    r.inputs['From Min'].default_value = a
    r.inputs['From Max'].default_value = b
    r.inputs['To Min'].default_value = lo
    r.inputs['To Max'].default_value = hi
    nt.links.new(sock, r.inputs['Value'])
    return r.outputs['Result']


def maths(op, a, b):
    m = node('ShaderNodeMath', operation=op)
    for i, s in enumerate((a, b)):
        if isinstance(s, (int, float)):
            m.inputs[i].default_value = s
        else:
            nt.links.new(s, m.inputs[i])
    return m.outputs[0]


def bake(sock):
    nt.links.new(sock, emit.inputs['Color'])
    bpy.ops.object.bake(type='EMIT', margin=0)
    px = np.empty(SIZE * SIZE * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(SIZE, SIZE, 4)[:, :, 0].copy()


bpy.context.view_layer.objects.active = plane
plane.select_set(True)
_bake_raw = bake


def bake(sock):  # noqa: F811  (an error inside a bake must still close the window)
    try:
        return _bake_raw(sock)
    except Exception as e:
        print('bake failed:', e)
        bpy.ops.wm.quit_blender()
        raise

# R: dents. Broad buckles (low noise), creases where folds meet (voronoi edges), and fine ripple.
broad = node('ShaderNodeTexNoise', in_Scale=3.0, in_Detail=3.0, in_Roughness=0.5)
nt.links.new(mapped(1, 1).outputs[0], broad.inputs['Vector'])
fold = node('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', in_Scale=5.0)
nt.links.new(mapped(1, 1).outputs[0], fold.inputs['Vector'])
fine = node('ShaderNodeTexNoise', in_Scale=18.0, in_Detail=6.0, in_Roughness=0.65)
nt.links.new(mapped(1, 1).outputs[0], fine.inputs['Vector'])
crease = ramp(fold.outputs['Distance'], 0.0, 0.18, 0.0, 1.0)
h = maths('ADD', maths('MULTIPLY', broad.outputs['Fac'], 0.55), maths('MULTIPLY', crease, 0.3))
h = maths('ADD', h, maths('MULTIPLY', fine.outputs['Fac'], 0.15))
R = bake(h)

# G: scrapes. Noise stretched sixty times along the panel gives long scratches; a second, broad noise thins them out.
streak = node('ShaderNodeTexNoise', in_Scale=2.0, in_Detail=8.0, in_Roughness=0.7)
nt.links.new(mapped(1.5, 90).outputs[0], streak.inputs['Vector'])
patch = node('ShaderNodeTexNoise', in_Scale=4.0, in_Detail=2.0)
nt.links.new(mapped(1, 1).outputs[0], patch.inputs['Vector'])
g = maths('MULTIPLY', ramp(streak.outputs['Fac'], 0.56, 0.68), ramp(patch.outputs['Fac'], 0.35, 0.6, 0.25, 1.0))
G = bake(g)

# B: cracks. Rings round the strike point, crazed cells, and finer cells between them.
rings = node('ShaderNodeTexWave', wave_type='RINGS', wave_profile='SAW', in_Scale=2.2, in_Distortion=3.0, in_Detail=2.0)
nt.links.new(mapped(1, 1).outputs[0], rings.inputs['Vector'])
big = node('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', in_Scale=6.0)
nt.links.new(mapped(1, 1).outputs[0], big.inputs['Vector'])
small = node('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', in_Scale=19.0)
nt.links.new(mapped(1, 1).outputs[0], small.inputs['Vector'])
l1 = ramp(big.outputs['Distance'], 0.0, 0.025, 1.0, 0.0)
l2 = maths('MULTIPLY', ramp(small.outputs['Distance'], 0.0, 0.02, 1.0, 0.0), 0.55)
l3 = maths('MULTIPLY', ramp(rings.outputs['Fac'], 0.0, 0.04, 1.0, 0.0), 0.8)
B = bake(maths('MAXIMUM', maths('MAXIMUM', l1, l2), l3))

# A: one random number per fragment, the same cells as the big cracks.
cells = node('ShaderNodeTexVoronoi', feature='F1', in_Scale=6.0)
nt.links.new(mapped(1, 1).outputs[0], cells.inputs['Vector'])
sep = node('ShaderNodeSeparateColor')
nt.links.new(cells.outputs['Color'], sep.inputs[0])
A = bake(sep.outputs[0])


def norm(a):
    lo, hi = float(a.min()), float(a.max())
    return (a - lo) / max(hi - lo, 1e-6)


rgba = np.stack([norm(R), np.clip(G, 0, 1), np.clip(B, 0, 1), np.clip(A, 0, 1)], axis=2).astype(np.float32)
final = bpy.data.images.new('car_damage', SIZE, SIZE, alpha=True, float_buffer=False)
final.colorspace_settings.name = 'Non-Color'
final.alpha_mode = 'CHANNEL_PACKED'
final.pixels.foreach_set(rgba.ravel())
final.file_format = 'WEBP'
final.filepath_raw = OUT
final.save()
print('car damage sheet ->', OUT, os.path.getsize(OUT), 'bytes')
for i, n in enumerate('RGBA'):
    print(n, 'mean %.3f' % float(rgba[:, :, i].mean()))
