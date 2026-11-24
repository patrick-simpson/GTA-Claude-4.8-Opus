# Port Calamity's train (fun queue item 18), modelled in Blender by script and exported as .glb, in the manner of boats.py.
#
#   blender --factory-startup --python tools/blender/train.py --python-expr "import bpy; bpy.ops.wm.quit_blender()"
#   (with its window showing, never --background: the owner watches the screen)
#
# Writes public/models/train.glb: loco, boxcar, tank, flat, caboose, coach (each _LOD0.._LOD2), the truck (bogie,
# _LOD0.._LOD1) that every car rides on, and two loads for the flats (logs, lumber; _LOD0.._LOD1). src/world/train.ts
# loads it; its CARS table (length over couplers, truck centres) matches the numbers here. TRAIN_OUT sends a trial run
# elsewhere.
#
# Game frame as in boats.py: x = the car's left, y = up, z = forward; y 0 is the top of the rail. Each body's origin is
# its middle at rail height; each truck's origin is its pivot at rail height, so the game turns them on their own.
#
# The railroad is invented: the Tepid Falls & Budget Gap ("TF&BG", "the Budget Line"), maroon and cream locomotives in
# an old Maine road-switcher style, boxcar red, a black tank car, pulpwood and lumber on the flats, a red caboose, and
# a green coach for the now-and-then passenger run. Colours ride in the vertex colours (a handful of materials), with
# ray-cast occlusion multiplied in, as boats.py does.

import bpy, bmesh, os, json
from math import sin, cos, pi, radians, sqrt
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MODELS = os.environ.get('TRAIN_OUT') or os.path.join(ROOT, 'public', 'models')

MATS = ['paint', 'dark', 'metal', 'glass', 'lamp', 'wood']
MI = {n: i for i, n in enumerate(MATS)}
MAROON = (0.36, 0.07, 0.07); CREAM = (0.86, 0.8, 0.62); BLACK = (0.06, 0.06, 0.065); GREY = (0.32, 0.33, 0.34)
BOXRED = (0.42, 0.15, 0.09); CABOOSE = (0.6, 0.1, 0.06); GREEN = (0.13, 0.27, 0.17); RUST = (0.33, 0.2, 0.12)
TINT = {'paint': MAROON, 'dark': BLACK, 'metal': (0.55, 0.56, 0.58), 'glass': (0.25, 0.3, 0.33), 'lamp': (1, 0.96, 0.85), 'wood': (0.45, 0.32, 0.2)}


def B(x, y, z):
    return Vector((x, -z, y))


class Mesh:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new('Col')

    def tag(self, f, mat, tint=None):
        f.material_index = MI[mat]
        c = tint or TINT[mat]
        for l in f.loops: l[self.col] = (c[0], c[1], c[2], 1.0)

    def face(self, pts, mat, tint=None):
        vs = [self.bm.verts.new(B(*p)) for p in pts]
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        self.tag(f, mat, tint); return f

    def box(self, c, s, mat, tint=None, bevel=0.0, yaw=0.0):
        M = Matrix.Translation(B(*c)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Diagonal((s[0], s[2], s[1], 1))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=M)
        vs = r['verts']; fs = list({f for v in vs for f in v.link_faces})
        if bevel:
            es = list({e for v in vs for e in v.link_edges})
            out = bmesh.ops.bevel(self.bm, geom=vs + es, offset=bevel, segments=2, affect='EDGES', profile=0.5)
            fs = list({f for v in list(vs) + out['verts'] if v.is_valid for f in v.link_faces})
        for f in fs: self.tag(f, mat, tint)

    def tube(self, a, b, r, mat, seg=8, tint=None, r2=None):
        A, Bv = B(*a), B(*b)
        d = Bv - A; L = d.length
        M = Matrix.Translation((A + Bv) / 2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        r_ = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=L, matrix=M)
        for f in {f for v in r_['verts'] for f in v.link_faces}: self.tag(f, mat, tint)

    def loft(self, rows, mat, tint=None):
        V = [[self.bm.verts.new(B(*p)) for p in r] for r in rows]
        n = len(rows[0])
        for i in range(len(rows) - 1):
            for j in range(n - 1):
                q = [V[i][j], V[i][j + 1], V[i + 1][j + 1], V[i + 1][j]]
                if len({v.co.to_tuple(5) for v in q}) < 3: continue
                try:
                    f = self.bm.faces.new(q)
                except ValueError:
                    continue
                self.tag(f, mat, tint)
        return V

    def text(self, s, c, size, side, tint, along=1.0):
        """Raised lettering on a side of the car: side +1 is the +x (left) face, read left to right from outside."""
        cu = bpy.data.curves.new('t', type='FONT'); cu.body = s; cu.size = size; cu.align_x = 'CENTER'; cu.align_y = 'CENTER'
        cu.resolution_u = 2
        ob = bpy.data.objects.new('t', cu); bpy.context.scene.collection.objects.link(ob)
        dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh()
        ux = (0, 0, -side * along); nn = (side, 0, 0)
        vs = []
        for v in me.vertices:
            X, Y, Z = v.co
            vs.append(self.bm.verts.new(B(c[0] + nn[0] * 0.012, c[1] + Y, c[2] + ux[2] * X)))
        for p in me.polygons:
            try:
                f = self.bm.faces.new([vs[i] for i in p.vertices])
                self.tag(f, 'paint', tint)
            except ValueError:
                pass
        ev.to_mesh_clear(); bpy.data.objects.remove(ob, do_unlink=True); bpy.data.curves.remove(cu)

    def finish(self, name, ao=True):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.normal_update(); bm.verts.index_update()
        if ao: occlude(bm, self.col)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me); bm.free()
        for n in MATS: me.materials.append(material(n))
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        me.set_sharp_from_angle(angle=radians(36))
        used = sorted({p.material_index for p in me.polygons})
        remap = {o: i for i, o in enumerate(used)}
        me.polygons.foreach_set('material_index', [remap[p.material_index] for p in me.polygons])
        keep = [me.materials[i] for i in used]
        me.materials.clear()
        for m in keep: me.materials.append(m)
        ca = me.color_attributes.get('Col')
        if ca:
            me.color_attributes.active_color = ca
            me.color_attributes.render_color_index = me.color_attributes.find('Col')
        return ob


def material(n):
    m = bpy.data.materials.get(n)
    if m: return m
    m = bpy.data.materials.new(n)
    m.use_nodes = True
    nt = m.node_tree; bsdf = nt.nodes.get('Principled BSDF')
    vc = nt.nodes.new('ShaderNodeVertexColor'); vc.layer_name = 'Col'
    nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = {'glass': 0.08, 'metal': 0.35, 'paint': 0.42, 'lamp': 0.2}.get(n, 0.8)
    bsdf.inputs['Metallic'].default_value = 1.0 if n == 'metal' else 0.0
    return m


DIRS = []
for i in range(14):
    a = i * 2.39996; z = 0.15 + 0.85 * (i + 0.5) / 14; r = sqrt(1 - z * z)
    DIRS.append((cos(a) * r, sin(a) * r, z))


def occlude(bm, col, reach=0.9, floor=0.3):
    tree = BVHTree.FromBMesh(bm)
    cache = {}
    for f in bm.faces:
        if f.material_index in (MI['glass'], MI['lamp']): continue
        for l in f.loops:
            v = l.vert
            ao = cache.get(v.index)
            if ao is None:
                n = v.normal
                if n.length < 0.5: n = f.normal
                t = n.orthogonal().normalized(); b = n.cross(t); o = v.co + n * 0.006; occ = 0.0
                for dx, dy, dz in DIRS:
                    hit = tree.ray_cast(o, t * dx + b * dy + n * dz, reach)
                    if hit[0] is not None: occ += 1 - hit[3] / reach
                ao = floor + (1 - floor) * max(0.0, 1 - occ / len(DIRS) * 1.3)
                cache[v.index] = ao
            c = l[col]
            l[col] = (c[0] * ao, c[1] * ao, c[2] * ao, 1.0)


# ── Shared pieces ─────────────────────────────────────────────────────────────

def underframe(m, L, deck, lod, w=2.9):
    """Sill and deck plate, coupler boxes and knuckles at both ends, air reservoir, end ladders and grab irons."""
    m.box((0, deck - 0.2, 0), (w, 0.4, L - 0.6), 'dark', bevel=0.03 if lod == 0 else 0)
    m.box((0, deck - 0.62, 0), (0.6, 0.5, L - 3.6), 'dark')
    for e in (-1, 1):
        z = e * (L / 2 - 0.2)
        m.box((0, 0.88, z), (0.32, 0.26, 0.9), 'dark')
        m.box((0, 0.88, e * (L / 2 + 0.25)), (0.42, 0.3, 0.22), 'metal', GREY)
        if lod == 0:
            for s in (-1, 1):
                m.tube((s * 0.8, deck - 0.45, z), (s * 0.8, deck - 0.45, z + e * 0.25), 0.05, 'metal', 6, GREY)
    if lod == 0:
        m.tube((0.7, deck - 0.75, -1.8), (0.7, deck - 0.75, 1.8), 0.28, 'dark', 12)


def truck(lod):
    """A two-axle freight truck: side frames, bolster, four wheels on two axles, springs. Pivot at the origin."""
    m = Mesh(); R = 0.46; base = 1.3; g = 0.75
    for s in (-1, 1):
        x = s * g
        m.box((x * 1.1, 0.55, 0), (0.16, 0.36, 3.1), 'dark', bevel=0.03 if lod == 0 else 0)
        m.box((x * 1.1, 0.32, 0), (0.18, 0.16, 1.2), 'dark')
        if lod == 0:
            for k in (-0.25, 0, 0.25): m.tube((x * 1.1, 0.42, k), (x * 1.1, 0.68, k), 0.07, 'metal', 6, GREY)
        for e in (-1, 1):
            z = e * base
            m.tube((x - 0.07 * s, R, z), (x + 0.07 * s, R, z), R, 'dark', 16 if lod == 0 else 8, (0.12, 0.11, 0.1))
            if lod == 0: m.tube((x - 0.08 * s, R, z), (x - 0.1 * s, R, z), R + 0.03, 'metal', 16, RUST)
            m.box((x * 1.1, R, z), (0.22, 0.22, 0.3), 'dark')
    for e in (-1, 1): m.tube((-g, R, e * base), (g, R, e * base), 0.07, 'metal', 8, GREY)
    m.box((0, 0.72, 0), (2.2, 0.28, 0.5), 'dark')
    return m.finish(f'truck_LOD{lod}')


def handrail(m, a, b, lod):
    if lod == 0: m.tube(a, b, 0.025, 'paint', 5, (0.85, 0.75, 0.15))


# ── Locomotive: the Budget Line's road switcher ───────────────────────────────

LOCO_L = 19.6


def loco(lod):
    m = Mesh(); L = LOCO_L; deck = 1.62; bev = 0.05 if lod == 0 else 0
    underframe(m, L, deck, lod, 3.0)
    # Fuel tank between the trucks.
    m.box((0, 0.95, -0.4), (2.4, 0.8, 4.4), 'dark', bevel=0.12 if lod == 0 else 0)
    # Long hood (rear), cab, short hood (front, +z).
    hood_w, hood_h = 2.5, 2.75
    m.box((0, deck + hood_h / 2, -3.2), (hood_w, hood_h, 11.6), 'paint', MAROON, bevel=bev * 2)
    m.box((0, deck + 0.35, -3.2), (hood_w + 0.02, 0.3, 11.6), 'paint', CREAM)
    cab_z0, cab_z1 = 2.65, 5.65
    m.box((0, deck + 1.55, (cab_z0 + cab_z1) / 2), (3.0, 3.1, cab_z1 - cab_z0), 'paint', MAROON, bevel=bev)
    m.box((0, deck + 3.18, (cab_z0 + cab_z1) / 2), (3.1, 0.16, cab_z1 - cab_z0 + 0.2), 'paint', (0.18, 0.04, 0.04), bevel=bev)
    m.box((0, deck + 0.35, (cab_z0 + cab_z1) / 2), (3.02, 0.3, cab_z1 - cab_z0), 'paint', CREAM)
    m.box((0, deck + 1.15, 7.4), (2.3, 2.1, 3.5), 'paint', MAROON, bevel=bev * 2)
    m.box((0, deck + 0.35, 7.4), (2.32, 0.3, 3.5), 'paint', CREAM)
    # Cab windows: front pair, side pair, rear pair.
    if lod < 2:
        for s in (-1, 1):
            m.box((s * 0.72, deck + 2.25, cab_z1 + 0.005), (1.05, 0.95, 0.02), 'glass')
            m.box((s * 0.72, deck + 2.25, cab_z0 - 0.005), (1.05, 0.95, 0.02), 'glass')
            m.box((s * 1.505, deck + 2.2, cab_z0 + 1.0), (0.02, 0.9, 1.3), 'glass')
            m.box((s * 1.505, deck + 2.2, cab_z0 + 2.3), (0.02, 0.9, 0.8), 'glass')
    # Headlights (twin, on the short hood's nose and high on the long hood's end) and ditch lights low on the pilot.
    for z, y in ((9.16, deck + 1.9), (-9.01, deck + 2.5)):
        e = 1 if z > 0 else -1
        m.box((0, y, z - e * 0.05), (0.7, 0.42, 0.12), 'dark')
        for s in (-1, 1): m.tube((s * 0.17, y, z), (s * 0.17, y, z + e * 0.04), 0.13, 'lamp', 10)
        for s in (-1, 1):
            m.box((s * 1.25, deck - 0.05, e * (L / 2 - 0.15)), (0.28, 0.28, 0.12), 'dark')
            m.tube((s * 1.25, deck - 0.05, e * (L / 2 - 0.1)), (s * 1.25, deck - 0.05, e * (L / 2 - 0.05)), 0.1, 'lamp', 8)
    if lod < 2:
        # Pilots (snowplow at the front: this is Maine), number boards, horn, bell, exhaust stack, dynamic brake fans.
        m.face([(-1.5, 0.35, L / 2 + 0.05), (1.5, 0.35, L / 2 + 0.05), (1.5, deck - 0.4, L / 2 - 0.25), (-1.5, deck - 0.4, L / 2 - 0.25)], 'paint', (0.85, 0.75, 0.15))
        m.face([(0, 0.25, L / 2 + 0.55), (1.5, 0.3, L / 2 + 0.05), (-1.5, 0.3, L / 2 + 0.05)], 'paint', (0.85, 0.75, 0.15))
        m.box((0, deck + hood_h + 0.25, -1.5), (0.5, 0.5, 0.7), 'dark')
        m.tube((0, deck + 3.4, 4.0), (0, deck + 3.85, 4.0), 0.06, 'metal', 6, GREY)
        for k in (-0.25, 0, 0.25): m.tube((k, deck + 3.85, 4.0), (k, deck + 3.95, 4.0 + 0.45), 0.07, 'metal', 8, GREY, 0.11)
        m.tube((0.0, deck + hood_h, 0.9), (0.0, deck + hood_h + 0.3, 0.9), 0.18, 'metal', 10, (0.6, 0.48, 0.2))
        for z in (-7.0, -5.2):
            m.tube((0, deck + hood_h - 0.02, z), (0, deck + hood_h + 0.06, z), 0.6, 'dark', 16 if lod == 0 else 8)
        for s in (-1, 1):
            m.box((s * 0.55, deck + 2.45, 9.17), (0.5, 0.22, 0.05), 'lamp', (0.95, 0.95, 0.9))
    if lod == 0:
        # Hood doors (panel seams), louvres, handrails and steps.
        for k in range(8):
            z = -8.4 + k * 1.45
            for s in (-1, 1):
                m.box((s * (hood_w / 2 + 0.005), deck + 1.4, z), (0.01, 2.2, 0.05), 'paint', (0.22, 0.05, 0.05))
                if k in (1, 2, 5): m.box((s * (hood_w / 2 + 0.008), deck + 2.25, z + 0.7), (0.01, 0.5, 0.9), 'dark')
        for s in (-1, 1):
            x = s * 1.42
            for a, b in ((-9.3, 2.6), (5.7, 9.3)):
                handrail(m, (x, deck + 1.0, a), (x, deck + 1.0, b), lod)
                for z in (a, (a + b) / 2, b): handrail(m, (x, deck, z), (x, deck + 1.0, z), lod)
            for e in (-1, 1):
                for k in range(3): m.box((x, deck - 0.4 - k * 0.38, e * (L / 2 - 0.65)), (0.2, 0.04, 0.5), 'metal', GREY)
        for s in (-1, 1):
            m.text('TF&BG', (s * hood_w / 2, deck + 1.55, -3.0), 0.75, s, CREAM)
            m.text('207', (s * 1.5, deck + 2.15, 4.85), 0.32, s, CREAM)
    elif lod == 1:
        for s in (-1, 1): m.box((s * (hood_w / 2 + 0.01), deck + 1.55, -3.0), (0.01, 0.55, 3.6), 'paint', CREAM)
    return m.finish(f'loco_LOD{lod}', ao=lod < 2)


# ── Freight cars ──────────────────────────────────────────────────────────────

def boxcar(lod):
    m = Mesh(); L = 15.6; deck = 1.25; H = 3.25; bev = 0.04 if lod == 0 else 0
    underframe(m, L, deck, lod)
    m.box((0, deck + H / 2, 0), (3.0, H, L - 0.5), 'paint', BOXRED, bevel=bev)
    m.box((0, deck + H + 0.1, 0), (2.9, 0.2, L - 0.4), 'paint', (0.3, 0.11, 0.07), bevel=bev)
    if lod < 2:
        for s in (-1, 1):
            m.box((s * 1.52, deck + 1.5, 0.4), (0.06, 2.95, 2.9), 'paint', (0.36, 0.13, 0.08))
            m.box((s * 1.56, deck + 3.05, 0.4), (0.06, 0.12, 3.6), 'metal', GREY)
            m.box((s * 1.56, deck + 0.05, 0.4), (0.06, 0.12, 3.6), 'metal', GREY)
    if lod == 0:
        m.box((0, deck + H + 0.24, 0), (0.55, 0.06, L - 0.5), 'wood', (0.3, 0.27, 0.24))
        for k in range(14):
            z = -L / 2 + 0.6 + k * (L - 1.2) / 13
            if abs(z - 0.4) < 1.6: continue
            for s in (-1, 1): m.box((s * 1.51, deck + H / 2, z), (0.03, H - 0.1, 0.09), 'paint', (0.34, 0.12, 0.07))
        for s in (-1, 1):
            m.text('TF&BG', (s * 1.5, deck + 2.4, -4.0), 0.55, s, (0.9, 0.88, 0.82))
            m.text('BUDGET LINE  40122', (s * 1.5, deck + 1.6, -4.0), 0.22, s, (0.9, 0.88, 0.82))
            for e in (-1, 1):
                for k in range(6): m.box((s * 1.55, deck + 0.4 + k * 0.45, e * (L / 2 - 0.55)), (0.04, 0.03, 0.45), 'metal', GREY)
    return m.finish(f'boxcar_LOD{lod}', ao=lod < 2)


def tank(lod):
    m = Mesh(); L = 14.2; deck = 1.2; R = 1.35; seg = 20 if lod == 0 else 10 if lod == 1 else 6
    underframe(m, L, deck, lod, 2.6)
    rows = []
    for k in range(9):
        t = k / 8
        z = -L / 2 + 0.3 + t * (L - 0.6)
        end = min(t, 1 - t) * (L - 0.6)
        rr = R * (sqrt(max(0.0, 1 - (1 - min(end, 0.55) / 0.55) ** 2)) if end < 0.55 else 1.0)
        rows.append([(cos(2 * pi * j / seg) * max(rr, 0.02), deck + R + 0.1 + sin(2 * pi * j / seg) * max(rr, 0.02), z) for j in range(seg + 1)])
    m.loft(rows, 'paint', (0.07, 0.07, 0.075))
    if lod < 2:
        m.tube((0, deck + 2 * R + 0.05, 0), (0, deck + 2 * R + 0.45, 0), 0.5, 'paint', 14 if lod == 0 else 8, (0.08, 0.08, 0.085))
        m.box((0, deck + 2 * R + 0.12, 0), (1.6, 0.06, 1.6), 'wood', (0.32, 0.3, 0.28))
    if lod == 0:
        for s in (-1, 1):
            m.text('TF&BG', (s * (R + 0.02), deck + R + 0.45, -3.2), 0.5, s, (0.92, 0.92, 0.9))
            m.text('CORN SYRUP (PROBABLY)', (s * (R + 0.02), deck + R - 0.15, -3.2), 0.2, s, (0.92, 0.92, 0.9))
            m.tube((s * 1.45, deck + 0.4, -L / 2 + 0.4), (s * 1.45, deck + 0.4, L / 2 - 0.4), 0.03, 'metal', 5, GREY)
    return m.finish(f'tank_LOD{lod}', ao=lod < 2)


def flat(lod):
    m = Mesh(); L = 15.6; deck = 1.2
    underframe(m, L, deck, lod)
    m.box((0, deck + 0.04, 0), (2.85, 0.1, L - 0.6), 'wood', (0.42, 0.32, 0.22))
    for e in (-1, 1):
        m.box((0, deck + 1.4, e * (L / 2 - 0.45)), (2.9, 2.6, 0.18), 'paint', (0.25, 0.27, 0.28), bevel=0.02 if lod == 0 else 0)
        if lod == 0:
            for s in (-1, 0, 1): m.box((s * 1.2, deck + 1.4, e * (L / 2 - 0.62)), (0.12, 2.6, 0.2), 'dark')
    if lod == 0:
        for k in range(12):
            z = -L / 2 + 1.2 + k * (L - 2.4) / 11
            m.box((0, deck + 0.1, z), (2.86, 0.02, 0.04), 'wood', (0.3, 0.22, 0.15))
        for s in (-1, 1): m.text('TF&BG 6031', (s * 1.46, deck - 0.2, 0), 0.24, s, (0.9, 0.88, 0.82))
    return m.finish(f'flat_LOD{lod}', ao=lod < 2)


def logs(lod):
    """Pulpwood: three tiers of logs lengthwise between the bulkheads, top of the deck at y 0."""
    m = Mesh(); n = 7 if lod == 0 else 3; seg = 10 if lod == 0 else 6
    import random
    rnd = random.Random(7)
    if lod == 0:
        for tier in range(3):
            k = n - tier
            for i in range(k):
                r = 0.2 + rnd.random() * 0.06
                x = (i - (k - 1) / 2) * 0.42
                y = 0.22 + tier * 0.37
                for z0, z1 in ((-6.9, -0.1), (0.1, 6.9)):
                    a = (x, y, z0 + rnd.random() * 0.3); b = (x, y, z1 - rnd.random() * 0.3)
                    m.tube(a, b, r, 'wood', seg, (0.46 + rnd.random() * 0.1, 0.36, 0.25))
                    for p in (a, b): m.tube((p[0], p[1], p[2] - 0.01 if p is a else p[2]), (p[0], p[1], p[2] if p is a else p[2] + 0.01), r * 0.92, 'wood', seg, (0.78, 0.64, 0.45))
    else:
        m.box((0, 0.6, 0), (2.7, 1.2, 13.8), 'wood', (0.48, 0.37, 0.26))
    for s in (-1, 1):
        for z in (-4.5, 0, 4.5): m.box((s * 1.38, 0.75, z), (0.1, 1.5, 0.12), 'dark')
    return m.finish(f'logs_LOD{lod}', ao=lod == 0)


def lumber(lod):
    """Bundles of sawn lumber in white wrap, two by two by three, banded."""
    m = Mesh()
    for i in (-1, 1):
        for t in range(2):
            for k in (-1, 0, 1):
                c = (i * 0.66, 0.08 + 0.55 + t * 1.12, k * 4.5)
                m.box((c[0], c[1] - 0.6, c[2]), (1.24, 0.1, 4.2), 'wood', (0.3, 0.25, 0.2))
                m.box(c, (1.25, 1.0, 4.3), 'paint', (0.86, 0.85, 0.8), bevel=0.03 if lod == 0 else 0)
                if lod == 0:
                    for e in (-1, 1): m.box((c[0], c[1], c[2] + e * 2.152), (1.18, 0.94, 0.01), 'wood', (0.72, 0.58, 0.4))
                    for z in (-1.4, 1.4): m.box((c[0], c[1], c[2] + z), (1.27, 1.02, 0.04), 'dark', (0.15, 0.25, 0.5))
    return m.finish(f'lumber_LOD{lod}', ao=lod == 0)


def caboose(lod):
    m = Mesh(); L = 11.4; deck = 1.25; bodyL = 8.0; bev = 0.04 if lod == 0 else 0
    underframe(m, L, deck, lod)
    m.box((0, deck + 1.35, 0), (2.9, 2.7, bodyL), 'paint', CABOOSE, bevel=bev)
    m.box((0, deck + 2.78, 0), (3.1, 0.16, bodyL + 0.3), 'paint', (0.25, 0.06, 0.04), bevel=bev)
    m.box((0, deck + 3.45, 0.2), (2.2, 1.2, 2.6), 'paint', CABOOSE, bevel=bev)
    m.box((0, deck + 4.1, 0.2), (2.4, 0.12, 2.8), 'paint', (0.25, 0.06, 0.04))
    if lod < 2:
        for s in (-1, 1):
            for z in (-2.4, 2.6): m.box((s * 1.455, deck + 1.75, z), (0.02, 0.75, 0.75), 'glass')
            m.box((s * 1.105, deck + 3.5, 0.2), (0.02, 0.55, 1.8), 'glass')
        for e in (-1, 1):
            m.box((0, deck + 1.2, e * (bodyL / 2 + 0.005)), (0.85, 2.0, 0.02), 'dark', (0.2, 0.1, 0.08))
            m.box((0.9 * 0, deck + 0.05, e * (bodyL / 2 + 0.85)), (2.8, 0.1, 1.6), 'wood', (0.3, 0.27, 0.24))
    if lod == 0:
        # End platforms with railings (the player rides out here), steps, a stovepipe, marker lamps.
        for e in (-1, 1):
            zc = e * (bodyL / 2 + 0.85)
            for s in (-1, 1):
                m.tube((s * 1.35, deck + 0.1, zc - 0.8), (s * 1.35, deck + 1.05, zc - 0.8), 0.03, 'paint', 5, (0.85, 0.75, 0.15))
                m.tube((s * 1.35, deck + 0.1, zc + 0.75 * e), (s * 1.35, deck + 1.05, zc + 0.75 * e), 0.03, 'paint', 5, (0.85, 0.75, 0.15))
                m.tube((s * 1.35, deck + 1.05, zc - 0.8), (s * 1.35, deck + 1.05, zc + 0.75 * e), 0.03, 'paint', 5, (0.85, 0.75, 0.15))
                for k in range(2): m.box((s * 1.45, deck - 0.45 - k * 0.38, zc), (0.2, 0.04, 0.55), 'metal', GREY)
            m.tube((-1.35, deck + 1.05, e * (bodyL / 2 + 1.6)), (-0.5, deck + 1.05, e * (bodyL / 2 + 1.6)), 0.03, 'paint', 5, (0.85, 0.75, 0.15))
            m.tube((0.5, deck + 1.05, e * (bodyL / 2 + 1.6)), (1.35, deck + 1.05, e * (bodyL / 2 + 1.6)), 0.03, 'paint', 5, (0.85, 0.75, 0.15))
            for s in (-1, 1): m.tube((s * 1.5, deck + 2.3, e * (bodyL / 2 - 0.1)), (s * 1.5, deck + 2.3, e * (bodyL / 2 + 0.05)), 0.09, 'lamp', 8, (1, 0.25, 0.15))
        m.tube((0.8, deck + 2.85, -2.6), (0.8, deck + 3.6, -2.6), 0.09, 'dark', 8)
        for s in (-1, 1):
            m.text('TF&BG', (s * 1.45, deck + 1.0, 0.2), 0.42, s, (0.95, 0.9, 0.75))
            m.text('C-12', (s * 1.1, deck + 3.85, 0.2), 0.22, s, (0.95, 0.9, 0.75))
    return m.finish(f'caboose_LOD{lod}', ao=lod < 2)


def coach(lod):
    m = Mesh(); L = 21.0; deck = 1.25; bev = 0.05 if lod == 0 else 0
    underframe(m, L, deck, lod)
    m.box((0, deck + 1.55, 0), (3.0, 3.1, L - 0.4), 'paint', GREEN, bevel=bev)
    # A clerestory roof: lower deck, raised centre with its own little windows.
    m.box((0, deck + 3.2, 0), (3.05, 0.22, L - 0.2), 'paint', (0.1, 0.1, 0.1), bevel=bev)
    m.box((0, deck + 3.55, 0), (1.7, 0.5, L - 2.4), 'paint', (0.1, 0.1, 0.1), bevel=bev)
    m.box((0, deck + 2.75, 0), (3.02, 0.12, L - 0.4), 'paint', CREAM)
    m.box((0, deck + 1.0, 0), (3.02, 0.08, L - 0.4), 'paint', CREAM)
    if lod < 2:
        n = 11 if lod == 0 else 1
        for s in (-1, 1):
            if lod == 0:
                for k in range(n):
                    z = -L / 2 + 2.6 + k * (L - 5.2) / (n - 1)
                    m.box((s * 1.505, deck + 2.0, z), (0.02, 1.0, 1.15), 'glass')
            else:
                m.box((s * 1.505, deck + 2.0, 0), (0.02, 1.0, L - 4.4), 'glass')
            for e in (-1, 1): m.box((s * 1.505, deck + 1.45, e * (L / 2 - 0.85)), (0.02, 2.1, 0.8), 'dark', (0.09, 0.15, 0.1))
    if lod == 0:
        for s in (-1, 1):
            m.text('TEPID FALLS & BUDGET GAP', (s * 1.5, deck + 3.0, 0), 0.24, s, CREAM)
            m.text('NO. 4  ALMOST EXPRESS', (s * 1.5, deck + 0.7, 0), 0.2, s, CREAM)
        for e in (-1, 1): m.box((0, deck + 1.6, e * (L / 2 - 0.15)), (2.2, 2.9, 0.3), 'dark', (0.08, 0.08, 0.08))
    return m.finish(f'coach_LOD{lod}', ao=lod < 2)


def export(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False,
                              export_skins=False, export_morph=False, export_extras=False)
    return round(os.path.getsize(path) / 1000)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def _ctx():
    kw = {}; wm = bpy.context.window_manager
    win = wm.windows[0] if wm and len(wm.windows) else None
    if win:
        kw['window'] = win; kw['screen'] = win.screen
        area = next((a for a in win.screen.areas if a.type == 'VIEW_3D'), None)
        if area:
            kw['area'] = area
            reg = next((r for r in area.regions if r.type == 'WINDOW'), None)
            if reg: kw['region'] = reg
    return bpy.context.temp_override(**kw)


def main():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    stats = {}; obs = {}
    kinds = (('loco', loco, 3), ('boxcar', boxcar, 3), ('tank', tank, 3), ('flat', flat, 3), ('caboose', caboose, 3),
             ('coach', coach, 3), ('truck', truck, 2), ('logs', logs, 2), ('lumber', lumber, 2))
    for name, fn, n in kinds:
        for lod in range(n):
            ob = fn(lod); obs[ob.name] = ob; stats[ob.name] = tris(ob)
    os.makedirs(MODELS, exist_ok=True)
    for ob in obs.values(): ob.location = Vector((0, 0, 0))
    stats['train.glb kB'] = export(list(obs.values()), os.path.join(MODELS, 'train.glb'))
    # Spread out in the window so the owner can see what was made.
    for i, (nm, ob) in enumerate(obs.items()):
        lod = int(nm[-1]); kind = nm.split('_')[0]
        ob.location = Vector(([k[0] for k in kinds].index(kind) * 5, lod * 24, 0))
    print('STATS ' + json.dumps(stats))


if __name__ == '__main__':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with _ctx():
        try:
            main()
        except Exception:
            import traceback
            traceback.print_exc()
            print('FAILED')
