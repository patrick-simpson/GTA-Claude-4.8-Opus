# Port Calamity's Christmas kit (fun queue item 17), modelled in Blender by script and exported as one .glb.
#
#   blender --factory-startup --python tools/blender/christmas.py --python-expr "import bpy; bpy.ops.wm.quit_blender()"
#
# Writes public/models/christmas.glb. THE CONTRACT with src/world/christmas.ts: six meshes, one material 'xmas' whose
# colour is COLOR_0, origin at the foot, forward = +Z in the game (authored along Blender -Y):
#   tree      12 m fir in six tiers on a wrapped base; tiers between y 1.2 and 11.4, base radius 4.3 (bulbs and the
#             star are the game's: TREE_H, TREE_R there)
#   sleigh    3.4 m long, red body, gold runners and scrollwork, a sack in the back
#   reindeer  in a flying gallop, 2.1 m nose to tail
#   snowman   inflatable, 2.7 m, top hat, scarf, carrot
#   penguin   inflatable, 2.1 m, in a red knit hat
#   present   0.5 m box, ribbon both ways and a bow

import bpy, bmesh, math, os, random, json
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'models', 'christmas.glb')
random.seed(1225)


def srgb(h):
    c = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


class Kit:
    """Collects primitive parts into one bmesh with per-corner colours."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new('Col')

    def add(self, make, color, mat=Matrix(), jitter=0.0):
        tmp = bmesh.new()
        make(tmp)
        bmesh.ops.transform(tmp, matrix=mat, verts=tmp.verts)
        if jitter:
            for v in tmp.verts:
                v.co += Vector((random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-1, 1))) * jitter
        me = bpy.data.meshes.new('tmp')
        tmp.to_mesh(me)
        tmp.free()
        n0 = len(self.bm.faces)
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        self.bm.faces.ensure_lookup_table()
        c = srgb(color) if isinstance(color, int) else color
        for f in self.bm.faces[n0:]:
            for l in f.loops:
                l[self.col] = c

    def obj(self, name, mat):
        me = bpy.data.meshes.new(name)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        self.bm.to_mesh(me)
        self.bm.free()
        for p in me.polygons:
            p.use_smooth = True
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def cone(r1, r2, d, seg=24):
    return lambda b: bmesh.ops.create_cone(b, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=d)


def sphere(r, u=16, v=10):
    return lambda b: bmesh.ops.create_uvsphere(b, u_segments=u, v_segments=v, radius=r)


def box(sx, sy, sz):
    def f(b):
        bmesh.ops.create_cube(b, size=1.0)
        bmesh.ops.scale(b, vec=(sx, sy, sz), verts=b.verts)
    return f


def torus(R, r, seg=24, rs=8, arc=1.0):
    def f(b):
        rings = []
        n = seg if arc >= 1 else seg + 1
        for i in range(n):
            a = 2 * math.pi * arc * i / seg
            ring = []
            for j in range(rs):
                t = 2 * math.pi * j / rs
                ring.append(b.verts.new(((R + r * math.cos(t)) * math.cos(a), (R + r * math.cos(t)) * math.sin(a), r * math.sin(t))))
            rings.append(ring)
        m = seg if arc >= 1 else seg
        for i in range(m):
            A, Bq = rings[i], rings[(i + 1) % n]
            for j in range(rs):
                b.faces.new((A[j], A[(j + 1) % rs], Bq[(j + 1) % rs], Bq[j]))
    return f


def T(x=0, y=0, z=0):
    return Matrix.Translation((x, y, z))


def R(axis, deg):
    return Matrix.Rotation(math.radians(deg), 4, axis)


def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1))


GREEN, DGREEN = 0x1f5a2c, 0x173f22
RED, DRED, GOLD, WHITE, BLACK, BROWN = 0xb3121b, 0x7e0d14, 0xd4a72c, 0xf2f2ee, 0x161616, 0x5a3a22


def tree(mat):
    k = Kit()
    k.add(cone(0.45, 0.32, 1.6, 12), BROWN, T(0, 0, 0.8))
    k.add(cone(1.3, 1.1, 0.8, 16), RED, T(0, 0, 0.4))
    k.add(box(2.62, 0.18, 0.82), GOLD, T(0, 0, 0.4))
    k.add(box(0.18, 2.62, 0.82), GOLD, T(0, 0, 0.4))
    tiers = [(1.2, 4.3, 3.1), (2.9, 3.7, 2.8), (4.5, 3.05, 2.6), (6.0, 2.4, 2.4), (7.5, 1.75, 2.2), (8.9, 1.1, 2.5)]
    for i, (z0, r, h) in enumerate(tiers):
        c = GREEN if i % 2 == 0 else DGREEN
        # The skirt of each tier droops: a cone of many sides, its rim pulled up and down in a wave of boughs.
        def make(b, r=r, h=h):
            bmesh.ops.create_cone(b, cap_ends=True, segments=40, radius1=r, radius2=0.05, depth=h)
            for v in b.verts:
                if v.co.z < -h / 2 + 0.01 and v.co.xy.length > 0.1:
                    a = math.atan2(v.co.y, v.co.x)
                    v.co.z += 0.22 * math.sin(a * 9) + 0.12
                    v.co.x *= 1 + 0.07 * math.sin(a * 9 + 1)
                    v.co.y *= 1 + 0.07 * math.sin(a * 9 + 1)
        k.add(make, c, T(0, 0, z0 + h / 2), jitter=0.04)
    return k.obj('tree', mat)


def sleigh(mat):
    k = Kit()
    # Runners along -Y (forward), curling up at the front.
    for s in (-0.62, 0.62):
        k.add(box(0.08, 3.0, 0.08), GOLD, T(s, 0.1, 0.06))
        k.add(torus(0.42, 0.045, 20, 6, 0.55), GOLD, T(s, -1.4, 0.48) @ R('Y', 90) @ R('Z', 160))
        for y in (-0.8, 0.0, 0.8):
            k.add(box(0.06, 0.06, 0.42), GOLD, T(s, y, 0.3))
    # The body: a tub, a high scrolled back and a curled dash.
    k.add(box(1.5, 2.4, 0.55), RED, T(0, 0.15, 0.78))
    k.add(box(1.56, 2.46, 0.1), GOLD, T(0, 0.15, 1.06))
    k.add(box(1.5, 0.3, 1.0), RED, T(0, 1.3, 1.1))
    k.add(torus(0.35, 0.12, 20, 8, 0.5), RED, T(0, -1.05, 1.0) @ R('Y', 90) @ R('Z', 90))
    k.add(torus(0.36, 0.035, 20, 6, 0.5), GOLD, T(0.76, -1.05, 1.0) @ R('Y', 90) @ R('Z', 90))
    k.add(torus(0.36, 0.035, 20, 6, 0.5), GOLD, T(-0.76, -1.05, 1.0) @ R('Y', 90) @ R('Z', 90))
    k.add(box(1.3, 0.7, 0.22), DRED, T(0, 0.6, 1.12))  # seat cushion
    k.add(sphere(0.7), BROWN, T(0, 0.85, 1.6) @ S(1.0, 0.8, 0.9), jitter=0.05)  # the sack
    for i, c in enumerate((RED, GOLD, 0x2c6db3, GREEN)):
        k.add(box(0.32, 0.32, 0.32), c, T(-0.4 + 0.28 * i, 1.2 - 0.12 * i, 2.05 + 0.05 * (i % 2)) @ R('Z', 20 * i))
    return k.obj('sleigh', mat)


def reindeer(mat):
    k = Kit()
    FUR, PALE, HOOF, ANT = 0x7a5232, 0xcdb79a, 0x2a211b, 0x8f7a5c
    k.add(sphere(0.5, 16, 10), FUR, T(0, 0, 1.15) @ S(0.62, 1.55, 0.72))
    k.add(sphere(0.3, 12, 8), PALE, T(0, -0.35, 0.95) @ S(0.8, 1.3, 0.6))
    k.add(cone(0.2, 0.15, 0.7, 10), FUR, T(0, -0.75, 1.55) @ R('X', -35))
    k.add(sphere(0.2, 12, 8), FUR, T(0, -0.98, 1.88) @ S(0.9, 1.5, 0.9))
    k.add(sphere(0.09, 8, 6), BLACK, T(0, -1.24, 1.84))
    for s in (-1, 1):
        k.add(cone(0.06, 0.02, 0.2, 6), FUR, T(0.15 * s, -0.86, 2.02) @ R('Y', 50 * s))
        # antlers: a beam up and back with two tines
        k.add(cone(0.035, 0.02, 0.55, 6), ANT, T(0.12 * s, -0.9, 2.25) @ R('Y', 25 * s) @ R('X', 20))
        k.add(cone(0.025, 0.01, 0.3, 6), ANT, T(0.22 * s, -0.86, 2.42) @ R('Y', 70 * s))
        k.add(cone(0.025, 0.01, 0.26, 6), ANT, T(0.2 * s, -0.98, 2.32) @ R('X', -50))
        k.add(sphere(0.035, 6, 4), BLACK, T(0.12 * s, -1.07, 1.95))
        # legs in a flying gallop: fore legs reaching forward, hind legs back
        k.add(cone(0.08, 0.05, 0.8, 8), FUR, T(0.17 * s, -0.75, 0.85) @ R('X', -60))
        k.add(cone(0.06, 0.06, 0.1, 8), HOOF, T(0.17 * s, -1.1, 0.65) @ R('X', -60))
        k.add(cone(0.09, 0.05, 0.85, 8), FUR, T(0.17 * s, 0.75, 0.85) @ R('X', 60))
        k.add(cone(0.06, 0.06, 0.1, 8), HOOF, T(0.17 * s, 1.12, 0.62) @ R('X', 60))
    k.add(sphere(0.1, 8, 6), PALE, T(0, 0.8, 1.35))
    # the harness: a red collar with gold bells
    k.add(torus(0.21, 0.04, 16, 6), RED, T(0, -0.62, 1.42) @ R('X', 55))
    for a in range(5):
        t = math.radians(-60 + 30 * a)
        k.add(sphere(0.045, 8, 6), GOLD, T(0.22 * math.sin(t), -0.7 - 0.05 * math.cos(t), 1.30 - 0.1 * math.cos(t)))
    return k.obj('reindeer', mat)


def snowman(mat):
    k = Kit()
    for z, r in ((0.55, 0.62), (1.42, 0.46), (2.08, 0.34)):
        k.add(sphere(r, 20, 12), WHITE, T(0, 0, z))
    k.add(cone(0.36, 0.36, 0.05, 20), BLACK, T(0, 0, 2.36))
    k.add(cone(0.22, 0.22, 0.36, 20), BLACK, T(0, 0, 2.55))
    k.add(cone(0.225, 0.225, 0.07, 20), RED, T(0, 0, 2.43))
    k.add(cone(0.06, 0.0, 0.3, 10), 0xe07a1f, T(0, -0.46, 2.08) @ R('X', 90))
    k.add(torus(0.36, 0.08, 20, 8), RED, T(0, 0, 1.78))
    k.add(box(0.16, 0.06, 0.6), RED, T(0.18, -0.36, 1.5) @ R('Y', 12))
    for s in (-1, 1):
        k.add(sphere(0.045, 8, 6), BLACK, T(0.12 * s, -0.3, 2.18))
        k.add(cone(0.035, 0.02, 0.8, 6), BROWN, T(0.65 * s, 0, 1.6) @ R('Y', 65 * s))
    for z in (1.25, 1.45, 1.65):
        k.add(sphere(0.05, 8, 6), BLACK, T(0, -0.45, z))
    k.add(cone(0.7, 0.7, 0.04, 20), 0x2f6b2f, T(0, 0, 0.02))  # the tether mat
    return k.obj('snowman', mat)


def penguin(mat):
    k = Kit()
    k.add(sphere(0.6, 20, 12), BLACK, T(0, 0, 0.85) @ S(1.0, 0.9, 1.45))
    k.add(sphere(0.52, 20, 12), WHITE, T(0, -0.12, 0.8) @ S(0.9, 0.85, 1.3))
    k.add(sphere(0.38, 16, 10), BLACK, T(0, 0, 1.75))
    k.add(sphere(0.3, 16, 10), WHITE, T(0, -0.1, 1.72) @ S(0.9, 0.9, 0.85))
    k.add(cone(0.1, 0.0, 0.25, 8), 0xf09a1a, T(0, -0.42, 1.7) @ R('X', 90))
    for s in (-1, 1):
        k.add(sphere(0.05, 8, 6), BLACK, T(0.11 * s, -0.33, 1.82))
        k.add(sphere(0.2, 10, 8), BLACK, T(0.6 * s, 0, 0.95) @ S(0.3, 0.6, 1.0) @ R('Y', 15 * s))
        k.add(sphere(0.16, 10, 8), 0xf09a1a, T(0.22 * s, -0.2, 0.06) @ S(0.8, 1.3, 0.35))
    k.add(cone(0.36, 0.05, 0.6, 16), RED, T(0, 0.08, 2.2) @ R('X', 18))
    k.add(torus(0.34, 0.07, 18, 8), WHITE, T(0, 0, 1.98))
    k.add(sphere(0.1, 8, 6), WHITE, T(0, 0.2, 2.5))
    k.add(cone(0.7, 0.7, 0.04, 20), 0x2f6b2f, T(0, 0, 0.02))
    return k.obj('penguin', mat)


def present(mat):
    k = Kit()
    k.add(box(0.5, 0.5, 0.4), 0x1f7a3a, T(0, 0, 0.2))
    k.add(box(0.52, 0.09, 0.42), GOLD, T(0, 0, 0.2))
    k.add(box(0.09, 0.52, 0.42), GOLD, T(0, 0, 0.2))
    for a in (45, -45):
        k.add(torus(0.07, 0.025, 12, 6), GOLD, T(0, 0, 0.44) @ R('Z', a) @ R('X', 90) @ T(0.07, 0, 0))
        k.add(torus(0.07, 0.025, 12, 6), GOLD, T(0, 0, 0.44) @ R('Z', a) @ R('X', 90) @ T(-0.07, 0, 0))
    return k.obj('present', mat)


def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    mat = bpy.data.materials.new('xmas')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.7
    obs = [f(mat) for f in (tree, sleigh, reindeer, snowman, penguin, present)]
    for i, ob in enumerate(obs):
        ob.location.x = i * 7  # laid out in a row for the viewport; the exporter keeps object origins
    stats = {ob.name: len(ob.data.polygons) for ob in obs}
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False, export_extras=False)
    stats['kB'] = round(os.path.getsize(OUT) / 1000)
    print('STATS ' + json.dumps(stats))
    # Frame the row for whoever is watching the screen.
    for area in bpy.context.screen.areas if bpy.context.screen else []:
        if area.type == 'VIEW_3D':
            for sp in area.spaces:
                if sp.type == 'VIEW_3D':
                    sp.shading.type = 'SOLID'
                    sp.shading.color_type = 'VERTEX'


main()
