# Port Calamity's cars, modelled in Blender by script and exported as .glb.
#
#   blender --background --factory-startup --python tools/blender/cars.py -- sedan [--no-render] [--no-export]
#
# Writes public/models/<kind>.glb and preview stills in shots/blender/<kind>_*.png.
#
# Everything is authored in the GAME's frame (x = the car's left, y = up, z =
# forward, y 0 = road, origin midway between the axles) and passed through B()
# into Blender's Z-up frame; the glTF exporter's Y-up conversion then lands it
# back exactly where it started. No assets are loaded: a car is a table of
# numbers in VEHICLES plus the recipe below.
#
# The recipe (see build()):
#   * shell(): a coarse quad cage, 9 rows round the half section by ~31
#     stations nose to tail, mirrored and subdivided once. Row 0 is the open
#     lower edge and follows the wheel arches; rows 4-8 are hood / glass /
#     roof / deck. Cage faces carry materials (glass, lamps, grille), cage
#     edges carry seams (shut-lines) and creases. After subdivision the glass
#     is inset behind a rubber seal (chrome first on the side windows), lamps
#     and grille get chrome bezels, and every seam is bevelled into a groove.
#   * bumper(): a C section swept round the plan-view superellipse of the nose
#     or tail.  underbody(), interior(), fittings(): boxes and lathes.
#   * wheel(): lathed tire and rim barrel, five twin spokes, hub, brake disc.
#     Hub at the origin, axle along X, outer face toward +X.
#   * bake(): ambient occlusion by ray casting (wheels and road included),
#     multiplied by a per-material tint and written to the vertex colours.
#     Paint and glass carry occlusion only: the game supplies their colour.
#   * LOD1 is the same recipe with the detail passes skipped and the shell
#     decimated.
# The file holds four meshes: LOD0, LOD1, WHEEL0, WHEEL1. Material names are
# the contract with src/ent/vehicleGlb.ts.

import bpy, bmesh, sys, os, json
from math import sin, cos, pi, radians, sqrt, hypot, asin, exp
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MATS = ['paint', 'trim', 'chrome', 'glass', 'lamp_head', 'lamp_tail', 'interior', 'tire', 'rim']
TMP = ['tmp_grille', 'tmp_sideglass', 'tmp_amber']
REMAP = {'tmp_grille': 'trim', 'tmp_sideglass': 'glass', 'tmp_amber': 'lamp_head'}
MI = {n: i for i, n in enumerate(MATS + TMP)}
# Linear albedo baked into the vertex colours (times occlusion).
TINT = {'paint': 1.0, 'trim': 0.022, 'chrome': 0.9, 'glass': 1.0, 'lamp_head': (0.95, 0.95, 0.9),
        'lamp_tail': (0.6, 0.015, 0.012), 'interior': 0.03, 'tire': 0.014, 'rim': 0.72,
        'tmp_grille': 0.022, 'tmp_sideglass': 1.0, 'tmp_amber': (1.0, 0.42, 0.04)}

VEHICLES = {
    # Marlin Brougham: a three-box saloon. Lengths in meters; z stations are measured from mid-wheelbase.
    'sedan': dict(
        W=1.85, H=1.45, wb=2.8, track=1.58, R=0.33, tw=0.22,
        nose=2.30, tail=2.40, sill=0.17, arch_gap=0.055, zs=1.5, n_front=4.5, n_rear=5.0,
        cowl=0.84, header=0.22, b1=-0.10, b2=-0.17, mid=-0.55, rhead=-0.90, deckf=-1.52,
        hood_cowl=0.955, hood_nose=0.785, belt=0.935, deck=1.0, deck_tail=0.975,
        xr=(0.585, 0.61, 0.59), roof=(1.425, 1.452, 1.45, 1.415), bow=(0.13, 0.09, -0.09, -0.11),
        bumper_top=(0.565, 0.62), bumper_bot=(0.19, 0.25), lift=(0.2, 0.28), paint=(0.045, 0.11, 0.24)),
}


def B(x, y, z):
    """Game frame to Blender frame (a proper rotation, so winding survives)."""
    return Vector((x, -z, y))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


# ── Scene plumbing ───────────────────────────────────────────────────────────

def make_materials(paint):
    look = {'paint': (paint, 0.6, 0.28, 1), 'trim': ((1, 1, 1), 0.0, 0.6, 1), 'chrome': ((1, 1, 1), 1.0, 0.08, 1),
            'glass': ((0.02, 0.03, 0.035), 0.0, 0.03, 0.45), 'lamp_head': ((1, 1, 1), 0.0, 0.08, 1),
            'lamp_tail': ((1, 1, 1), 0.0, 0.1, 1), 'interior': ((1, 1, 1), 0.0, 0.8, 1),
            'tire': ((1, 1, 1), 0.0, 0.85, 1), 'rim': ((1, 1, 1), 0.9, 0.25, 1)}
    for n in MATS + TMP:
        m = bpy.data.materials.new(n)
        try:
            m.use_nodes = True
        except Exception:
            pass
        col, metal, rough, alpha = look.get(n, ((1, 1, 1), 0, 0.5, 1))
        nt = m.node_tree
        bsdf = next((x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        # Preview only: vertex colour (occlusion x tint) times the material colour.
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'Col'
        mul = nt.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = col
        nt.links.new(at.outputs['Color'], mul.inputs[0])
        nt.links.new(mul.outputs[0], bsdf.inputs['Base Color'])
        bsdf.inputs['Metallic'].default_value = metal
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Alpha'].default_value = alpha
        if n == 'paint':
            for k, v in (('Coat Weight', 1.0), ('Coat Roughness', 0.04)):
                if k in bsdf.inputs: bsdf.inputs[k].default_value = v
        if alpha < 1:
            for k, v in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
                try: setattr(m, k, v)
                except Exception: pass
        m.use_backface_culling = True


def new_bm(verts, faces, mat='paint', mats=None):
    bm = bmesh.new()
    vs = [bm.verts.new(B(*v)) for v in verts]
    for i, f in enumerate(faces):
        try:
            face = bm.faces.new([vs[k] for k in f])
        except ValueError:
            continue
        face.material_index = MI[mats[i] if mats else mat]
    return bm


def orient(bm, hint=None, flip=False):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    bad = False
    if hint:
        if hint[0] == 'up':
            f = max(bm.faces, key=lambda f: f.calc_center_median().z); bad = f.normal.z < 0
        elif hint[0] == 'out':
            c = B(*hint[1])
            bad = sum((f.calc_center_median() - c).dot(f.normal) * f.calc_area() for f in bm.faces) < 0
        elif hint[0] == 'dir':
            bm.faces.ensure_lookup_table()
            bad = bm.faces[hint[2]].normal.dot(B(*hint[1])) < 0
    if bad != flip:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.normal_update()


def stamp(me, tint=None):
    """Per-corner albedo and a per-vertex 'dark' factor, both consumed by bake()."""
    a = me.attributes.new('tint', 'FLOAT_COLOR', 'CORNER')
    flat = []
    for p in me.polygons:
        t = tint if tint is not None else TINT[(MATS + TMP)[p.material_index]]
        t = (t, t, t) if isinstance(t, (int, float)) else t
        flat += [t[0], t[1], t[2], 1.0] * p.loop_total
    a.data.foreach_set('color', flat)
    if 'dark' not in me.attributes:
        me.attributes.new('dark', 'FLOAT', 'POINT')


def to_obj(bm, name, tint=None, me=None):
    if me is None:
        me = bpy.data.meshes.new(name)
        for n in MATS: me.materials.append(bpy.data.materials[n])
    bm.to_mesh(me); bm.free()
    ob = me.users and next((o for o in bpy.data.objects if o.data is me), None)
    if not ob:
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
    stamp(me, tint)
    return ob


def apply_mods(ob):
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_apply(modifier=m.name)


def join(parts, name):
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = parts[0]; ob.name = name; ob.data.name = name
    return ob


def boxv(c, s, pitch=0.0):
    vs = []
    for dx in (-.5, .5):
        for dy in (-.5, .5):
            for dz in (-.5, .5):
                y, z = dy * s[1], dz * s[2]
                if pitch: y, z = y * cos(pitch) - z * sin(pitch), y * sin(pitch) + z * cos(pitch)
                vs.append((c[0] + dx * s[0], c[1] + y, c[2] + z))
    return vs, [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


def box(name, c, s, mat, tint=None, bevel=0.0, pitch=0.0, drop=None, flip=False):
    v, f = boxv(c, s, pitch)
    if drop is not None: f = [q for i, q in enumerate(f) if i != drop]
    bm = new_bm(v, f, mat=mat)
    if bevel: bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=1, affect='EDGES', profile=0.5)
    orient(bm, ('out', c), flip)
    return to_obj(bm, name, tint)


def lathe(profile, segs, a0=0.0, a1=2 * pi, c=(0, 0, 0)):
    """Revolve (x, r) points about the X axis through c. Returns verts, faces and each face's band."""
    closed = abs(a1 - a0 - 2 * pi) < 1e-6
    n = segs if closed else segs + 1
    verts, rings, faces, band = [], [], [], []
    for x, r in profile:
        if r < 1e-6:
            verts.append((c[0] + x, c[1], c[2])); rings.append([len(verts) - 1] * n)
        else:
            ring = []
            for i in range(n):
                a = a0 + (a1 - a0) * i / segs
                verts.append((c[0] + x, c[1] + r * sin(a), c[2] + r * cos(a))); ring.append(len(verts) - 1)
            rings.append(ring)
    for p in range(len(profile) - 1):
        for i in range(segs):
            j = (i + 1) % n if closed else i + 1
            q = []
            for k in (rings[p][i], rings[p][j], rings[p + 1][j], rings[p + 1][i]):
                if k not in q: q.append(k)
            if len(q) >= 3: faces.append(q); band.append(p)
    return verts, faces, band


# ── The body shell ───────────────────────────────────────────────────────────

class Car:
    def __init__(s, P):
        s.P = P
        s.hw = P['W'] / 2 - 0.008
        s.zF, s.zR = P['wb'] / 2, -P['wb'] / 2
        s.arch_r = P['R'] + P['arch_gap']
        # One subdivision pulls a 30-degree control polygon in by this factor.
        s.Rc = s.arch_r / 0.9665
        s.zNf, s.zNr = P['nose'] - 0.05, P['tail'] - 0.05

    def plan(s, z):
        """Half width of the body in plan: straight sides, superellipse ends."""
        P = s.P
        zN, n = (s.zNf, P['n_front']) if z > 0 else (s.zNr, P['n_rear'])
        u = (abs(z) - P['zs']) / (zN - P['zs'])
        return s.hw if u <= 0 else s.hw * max(0.0, 1 - min(1.0, u) ** n) ** (1 / n)

    def zplan(s, x, end, zN=None, W=None):
        """How far forward (end=1) or back (end=-1) the body reaches at half width x."""
        P = s.P
        zN = zN or (s.zNf if end > 0 else s.zNr); n = P['n_front'] if end > 0 else P['n_rear']
        return end * (P['zs'] + (zN - P['zs']) * max(0.0, 1 - min(1.0, abs(x) / (W or s.hw)) ** n) ** (1 / n))

    def corner_z(s, end):
        P = s.P
        zN, n = (s.zNf, P['n_front']) if end > 0 else (s.zNr, P['n_rear'])
        return end * (P['zs'] + (zN - P['zs']) * 0.5 ** (1 / n))

    def arch_floor(s, z):
        for zc in (s.zF, s.zR):
            d = abs(z - zc)
            if d <= s.Rc + 1e-6: return s.P['R'] + sqrt(max(0.0, s.Rc ** 2 - d * d))
        return s.P['sill']

    @staticmethod
    def hood(w, y, crown=0.03):
        return [(w - 0.04, y - 0.014), (w - 0.12, y), (w - 0.23, y + 0.010), (0.40 * w, y + crown * 0.8), (0.0, y + crown)]

    @staticmethod
    def cabin(w, belt, xr, roof):
        return [(w - 0.055, belt), (xr + 0.055, roof - 0.07), (xr, roof - 0.022), (0.34, roof - 0.005), (0.0, roof)]

    def top(s, z):
        """Rows 4-8 of the section at z, and how far its centre bows along z (screens are curved in plan)."""
        P = s.P; zc0 = s.corner_z(1); zc1 = s.corner_z(-1)
        if z >= P['cowl']:
            u = (z - P['cowl']) / (zc0 - P['cowl'])
            y = P['hood_cowl'] - (P['hood_cowl'] - P['hood_nose']) * min(1.0, u) ** 1.8
            return s.hood(s.plan(z), y), P['bow'][0] * max(0.0, 1 - (z - P['cowl']) / 0.3)
        if z <= P['deckf']:
            u = (P['deckf'] - z) / (P['deckf'] - zc1)
            y = lerp(P['deck'], P['deck_tail'], min(1.0, u) ** 1.4)
            return s.hood(s.plan(z), y, 0.02), P['bow'][3] * max(0.0, 1 - (P['deckf'] - z) / 0.3)
        xr, rf, bw, belt = P['xr'], P['roof'], P['bow'], P['belt']
        keys = [(P['cowl'], s.hood(s.hw, P['hood_cowl']), bw[0]),
                (P['header'], s.cabin(s.hw, belt, xr[0], rf[0]), bw[1]),
                (P['b1'], s.cabin(s.hw, belt + 0.002, xr[1], rf[1]), 0.0),
                (P['b2'], s.cabin(s.hw, belt + 0.002, xr[1], rf[1]), 0.0),
                (P['mid'], s.cabin(s.hw, belt + 0.005, xr[1], rf[2]), 0.0),
                (P['rhead'], s.cabin(s.hw, belt + 0.01, xr[2], rf[3]), bw[2]),
                (P['deckf'], s.hood(s.hw, P['deck'], 0.02), bw[3])]
        for a, b in zip(keys, keys[1:]):
            if b[0] <= z <= a[0]:
                t = (a[0] - z) / (a[0] - b[0])
                return [(lerp(p[0], q[0], t), lerp(p[1], q[1], t)) for p, q in zip(a[1], b[1])], lerp(a[2], b[2], t)
        raise ValueError(z)

    def stations(s):
        P = s.P; out = []
        keys = [s.corner_z(1), s.zF + s.Rc + 0.035 + 0.17, P['cowl'], (P['cowl'] + P['header']) / 2, P['header'], P['b1'], P['b2'],
                P['mid'], P['rhead'], (P['rhead'] + P['deckf']) / 2, P['deckf'], s.zR - s.Rc - 0.035 - 0.2, s.corner_z(-1)]
        arch = []
        for zc in (s.zF, s.zR):
            arch += [zc + s.Rc + 0.035, zc - s.Rc - 0.035] + [zc + s.Rc * cos(radians(a)) for a in range(0, 181, 30)]
        for z in sorted(keys, reverse=True): out.append(z)
        for z in arch:
            if all(abs(z - k) > 0.025 for k in keys): out.append(z)
        return sorted(out, reverse=True)

    def side(s, z, sh):
        """Rows 0-3: the open lower edge (sill or arch) up to the shoulder."""
        P = s.P; a = s.arch_floor(z); w = s.plan(z)
        # The lower edge sweeps up toward both ends, under the bumpers.
        if z < s.zR - s.Rc - 0.03: a = lerp(P['sill'], P['lift'][1], smooth((s.zR - s.Rc - 0.03 - z) / 0.35))
        if z > s.zF + s.Rc + 0.03: a = lerp(P['sill'], P['lift'][0], smooth((z - s.zF - s.Rc - 0.03) / 0.3))
        tn = smooth((z - (s.zF + s.Rc + 0.04)) / 0.15); tt = smooth(((s.zR - s.Rc - 0.04) - z) / 0.2)
        ts = [0, lerp(lerp(0.18, 0.30, tn), 0.35, tt), lerp(lerp(0.55, 0.68, tn), 0.72, tt), 1]
        rows = []
        for t in ts:
            y = a + (sh - a) * t
            q = (y - P['sill']) / (sh - P['sill'])
            m = 1 - 0.03 * ((q - 0.6) / 0.6) ** 2 if q < 0.6 else 1 - 0.012 * ((q - 0.6) / 0.4) ** 2
            fl = 0.0
            for zc in (s.zF, s.zR):
                if abs(z - zc) < s.Rc + 0.1:
                    fl = 0.009 * exp(-max(0.0, hypot(z - zc, y - P['R']) - s.Rc) / 0.05)
            rows.append((w * m + fl, y))
        return rows

    def shell(s, lod):
        P = s.P; st = s.stations(); NS = len(st)
        verts, faces, fm = [], [], []
        idx = [[0] * 9 for _ in st]
        CW = [0, 0, 0.35, 0.85, 1]
        rake = lambda y: 0.035 * (y - 0.2) / 0.5
        info = []
        for j, z in enumerate(st):
            rows, bow = s.top(z)
            sd = s.side(z, rows[0][1] - 0.045)
            info.append((sd, rows))
            end = 1 if j == 0 else -1 if j == NS - 1 else 0
            for k in range(9):
                x, y = sd[k] if k < 4 else rows[k - 4]
                zz = z + bow * CW[k - 4] if k >= 4 else z
                if end and k >= 4: zz = s.zplan(x, end) - end * rake(y)
                idx[j][k] = len(verts); verts.append((x, y, zz))
        zmid = lambda j: (st[j] + st[j + 1]) / 2
        mscr = (P['cowl'] + P['header']) / 2

        def fmat(j, k):
            z = zmid(j)
            if k == 4:
                if P['cowl'] > z > mscr: return 'trim'
                if P['b1'] > z > P['b2']: return 'trim'
                if mscr > z > P['rhead']: return 'tmp_sideglass'
            if k in (6, 7) and (P['cowl'] > z > P['header'] or P['rhead'] > z > P['deckf']): return 'glass'
            return 'paint'
        for j in range(NS - 1):
            for k in range(8):
                faces.append((idx[j][k], idx[j + 1][k], idx[j + 1][k + 1], idx[j][k + 1])); fm.append(fmat(j, k))
        plates = {}
        for j, end in ((0, 1), (NS - 1, -1)):
            sd, rows = info[j]
            G = {}
            for b in range(4):
                G[0, b] = idx[j][b]
                for a in range(1, 6):
                    x = rows[a - 1][0]; y = sd[b][1]
                    G[a, b] = len(verts); verts.append((x, y, s.zplan(x, end) - end * rake(y)))
            for b in range(3):
                for a in range(5):
                    faces.append((G[a, b], G[a + 1, b], G[a + 1, b + 1], G[a, b + 1]))
                    lamp = 'lamp_head' if end > 0 else 'lamp_tail'
                    fm.append('paint' if b < 2 else 'tmp_amber' if a == 0 and end > 0 else lamp if a < 4 else 'tmp_grille' if end > 0 else 'paint')
            faces.append((G[0, 3], G[1, 3], idx[j][4])); fm.append('paint')
            for a in range(1, 5):
                faces.append((G[a, 3], G[a + 1, 3], idx[j][4 + a], idx[j][3 + a])); fm.append('paint')
            plates[end] = (sd[2][1], sd[3][1], s.zplan(0, end) - end * rake((sd[2][1] + sd[3][1]) / 2), rows[3][0])
        s.face = plates

        bm = new_bm(verts, faces, mats=fm)
        bm.verts.ensure_lookup_table()
        cr = bm.edges.layers.float.new('crease_edge')
        E = lambda a, b: bm.edges.get((bm.verts[a], bm.verts[b]))
        J = lambda z: min(range(NS), key=lambda j: abs(st[j] - z))
        jc, jh, jb, jr, jd = J(P['cowl']), J(P['header']), J(P['b2']), J(P['rhead']), J(P['deckf'])
        for j in range(jc, jr): E(idx[j][4], idx[j + 1][4])[cr] = 0.5
        for j, c in ((jc, 0.8), (jd, 0.8), (jh, 0.4), (jr, 0.4)):
            for k in range(5, 8): E(idx[j][k], idx[j][k + 1])[cr] = c
        for j in range(NS - 1): E(idx[j][3], idx[j + 1][3])[cr] = 0.25
        if lod == 0:
            for j in (jc, jb, jr):
                for k in range(4): E(idx[j][k], idx[j][k + 1]).seam = True
            for j in range(jc, jr): E(idx[j][1], idx[j + 1][1]).seam = True
            for j in range(0, jc): E(idx[j][5], idx[j + 1][5]).seam = True
            for j in range(jd, NS - 1): E(idx[j][5], idx[j + 1][5]).seam = True
        me = bpy.data.meshes.new('shell')
        for n in MATS + TMP: me.materials.append(bpy.data.materials[n])
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new('shell', me); bpy.context.scene.collection.objects.link(ob)
        m = ob.modifiers.new('mirror', 'MIRROR'); m.use_axis = (True, False, False); m.use_clip = True; m.merge_threshold = 0.0005
        m = ob.modifiers.new('sub', 'SUBSURF'); m.levels = 1
        if lod: m = ob.modifiers.new('dec', 'DECIMATE'); m.ratio = 0.3
        apply_mods(ob)

        bm = bmesh.new(); bm.from_mesh(me)
        dark = bm.verts.layers.float.new('dark')
        orient(bm, ('up',))

        def inset(mi, thick, ring, push=0.0):
            fs = [f for f in bm.faces if f.material_index == MI[mi]]
            if not fs: return
            r = bmesh.ops.inset_region(bm, faces=fs, thickness=thick, depth=0.0, use_boundary=True, use_even_offset=True)
            for f in r['faces']: f.material_index = MI[ring]
            if push:
                bm.normal_update()
                for v in {v for f in bm.faces if f.material_index == MI[mi] for v in f.verts}: v.co -= v.normal * push
        if lod == 0:
            inset('tmp_sideglass', 0.011, 'chrome')
            inset('tmp_sideglass', 0.016, 'trim', 0.006)
            inset('glass', 0.024, 'trim', 0.006)
            inset('lamp_head', 0.012, 'chrome')
            inset('lamp_head', 0.026, 'chrome', 0.012)
            inset('lamp_tail', 0.010, 'chrome')
            inset('tmp_grille', 0.014, 'chrome', 0.02)
            seams = [e for e in bm.edges if e.seam]
            r = bmesh.ops.bevel(bm, geom=seams, offset=0.006, offset_type='OFFSET', segments=2, profile=0.5,
                                affect='EDGES', clamp_overlap=True)
            newf = set(r['faces']); bm.normal_update()
            for v in r['verts']:
                if v.is_valid and all(f in newf for f in v.link_faces):
                    v.co -= v.normal * 0.008; v[dark] = 1.0
            # A returned flange round the sills and arches, so the skin has an edge instead of ending in nothing.
            r = bmesh.ops.extrude_edge_only(bm, edges=[e for e in bm.edges if e.is_boundary])
            for v in r['geom']:
                if isinstance(v, bmesh.types.BMVert):
                    if abs(v.co.x) > 0.3: v.co.x -= 0.024 if v.co.x > 0 else -0.024
                    else: v.co.y -= 0.02 if v.co.y > 0 else -0.02
        for e in bm.edges: e.seam = False
        orient(bm, ('up',))
        bm.to_mesh(me); bm.free()
        stamp(me)
        # The temporary materials have done their job (regions for the detail passes, tints for the bake).
        mi = [0] * len(me.polygons); me.polygons.foreach_get('material_index', mi)
        names = MATS + TMP
        me.polygons.foreach_set('material_index', [MI[REMAP.get(names[i], names[i])] for i in mi])
        for i in range(len(names) - 1, len(MATS) - 1, -1): me.materials.pop(index=i)
        return ob

    # ── Bumpers ──────────────────────────────────────────────────────────────

    def bumper(s, end, lod):
        P = s.P
        Wb = s.hw + 0.004; zN = (P['nose'] if end > 0 else P['tail']) - 0.014
        n = P['n_front'] if end > 0 else P['n_rear']; zs = P['zs']
        T = P['bumper_top'][0 if end > 0 else 1]; Bt = P['bumper_bot'][0 if end > 0 else 1]
        u0 = (abs(s.zF) + s.arch_r + 0.012 - zs) / (zN - zs)
        th0 = asin(u0 ** (n / 2))
        ths = [th0 + (pi / 2 - th0) * f for f in (0, 0.2, 0.38, 0.52, 0.66, 0.82, 1)]
        prof = [(-0.05, T - 0.005), (-0.002, T), (0.010, T - 0.028), (0.014, T - 0.115), (0.014, T - 0.165),
                (0.006, T - 0.27), (-0.03, Bt + 0.03), (-0.09, Bt)]
        pm = ['paint', 'chrome', 'paint', 'paint', 'paint', 'trim', 'trim']
        path = [(th, 1) for th in ths] + [(th, -1) for th in reversed(ths[:-1])]
        verts, faces, fm = [], [], []
        for th, sx in path:
            cx, sn = cos(th) ** (2 / n), sin(th) ** (2 / n)
            x, z = Wb * cx, zs + (zN - zs) * sn
            nx, nz = cx ** (n - 1) / Wb, sn ** (n - 1) / (zN - zs)
            l = hypot(nx, nz); nx /= l; nz /= l
            k = 0.3 + 0.7 * smooth((th - th0) / radians(35))
            for o, y in prof:
                o = o * k if o > 0 else o
                verts.append((sx * (x + nx * o), y, end * (z + nz * o)))
        np_ = len(prof)
        for i in range(len(path) - 1):
            for p in range(np_ - 1):
                faces.append((i * np_ + p, (i + 1) * np_ + p, (i + 1) * np_ + p + 1, i * np_ + p + 1)); fm.append(pm[p])
        bm = new_bm(verts, faces, mats=fm)
        bm.verts.ensure_lookup_table()
        cr = bm.edges.layers.float.new('crease_edge')
        for i in range(len(path) - 1):
            for p in range(1, np_ - 2):
                e = bm.edges.get((bm.verts[i * np_ + p], bm.verts[(i + 1) * np_ + p]))
                if e: e[cr] = 0.7
        orient(bm, ('out', (0, 0.35, 0)))
        ob = to_obj(bm, 'bumper')
        if lod == 0:
            m = ob.modifiers.new('sub', 'SUBSURF'); m.levels = 1
            ob.data.attributes.remove(ob.data.attributes['tint'])
            apply_mods(ob); stamp(ob.data)
        return ob

    # ── Underbody, interior, fittings ────────────────────────────────────────

    def underbody(s, lod):
        P = s.P; out = []; y = P['sill'] + 0.012
        quads = [((-0.55, 0.55), (-(P['tail'] - 0.45), P['nose'] - 0.3))]
        if lod == 0:
            a = s.arch_r + 0.02
            for sx in (1, -1):
                xs = (0.55, s.hw - 0.03) if sx > 0 else (-(s.hw - 0.03), -0.55)
                quads += [(xs, (s.zR + a, s.zF - a)), (xs, (s.zF + a, P['nose'] - 0.3)), (xs, (-(P['tail'] - 0.45), s.zR - a))]
        v, f = [], []
        for (x0, x1), (z0, z1) in quads:
            n = len(v); v += [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]; f.append((n, n + 1, n + 2, n + 3))
        bm = new_bm(v, f, mat='trim'); orient(bm, ('dir', (0, -1, 0), 0))
        out.append(to_obj(bm, 'floor', 0.012))
        segs = 14 if lod == 0 else 5
        for zc in (s.zF, s.zR):
            for sx in (1, -1):
                r = s.arch_r + 0.03
                prof = [(0.5, 0.0), (0.5, r), (s.hw - 0.05, r)]
                v, f, _ = lathe(prof, segs, radians(-12), radians(192), (0, P['R'], zc))
                v = [(sx * x, yy, zz) for x, yy, zz in v]
                bm = new_bm(v, f, mat='trim'); orient(bm, ('out', (sx * 0.75, P['R'], zc)), flip=True)
                out.append(to_obj(bm, 'liner', 0.01))
        return out

    def interior(s):
        P = s.P; out = []; belt = P['belt']; roof = max(P['roof'])
        I = lambda *a, **k: out.append(box(*a, **k))
        I('tub', (0, 0.61, -0.08), (1.62, 0.66, 1.80), 'interior', 0.02, drop=3, flip=True)
        I('dash', (0, 0.80, P['cowl'] - 0.10), (1.58, 0.34, 0.52), 'interior', 0.028, bevel=0.04)
        I('binnacle', (0.37, 0.985, P['cowl'] - 0.30), (0.36, 0.07, 0.18), 'interior', 0.02, bevel=0.02)
        I('shelf', (0, belt - 0.03, (P['rhead'] + P['deckf']) / 2 - 0.05), (1.5, 0.05, P['rhead'] - P['deckf'] + 0.1), 'interior', 0.03)
        I('headliner', (0, roof - 0.06, (P['header'] + P['rhead']) / 2), (1.12, 0.02, P['header'] - P['rhead'] - 0.05), 'interior', 0.12)
        I('console', (0, 0.48, 0.15), (0.2, 0.3, 0.9), 'interior', 0.025, bevel=0.02)
        seat = (0.075, 0.062, 0.05)
        for x in (0.37, -0.37):
            I('cushion', (x, 0.44, 0.12), (0.5, 0.16, 0.5), 'interior', seat, bevel=0.04)
            I('back', (x, 0.78, -0.2), (0.48, 0.62, 0.13), 'interior', seat, bevel=0.04, pitch=radians(14))
            I('headrest', (x, 1.15, -0.29), (0.24, 0.17, 0.09), 'interior', seat, bevel=0.03, pitch=radians(10))
        I('bench', (0, 0.44, P['rhead'] + 0.33), (1.36, 0.16, 0.5), 'interior', seat, bevel=0.04)
        I('benchback', (0, 0.76, P['rhead'] + 0.03), (1.36, 0.58, 0.13), 'interior', seat, bevel=0.04, pitch=radians(18))
        for x in (0.4, -0.4):
            I('headrest', (x, 1.10, P['rhead'] - 0.07), (0.24, 0.15, 0.09), 'interior', seat, bevel=0.03, pitch=radians(14))
        # Steering wheel: a rim lathed about X, then stood up in front of the driver.
        v, f, _ = lathe([(0.0, 0.19), (0.016, 0.175), (0.0, 0.16), (-0.016, 0.175), (0.0, 0.19)], 14)
        t = radians(68); c = (0.37, 0.98, P['cowl'] - 0.44)
        v = [(c[0] + yy, c[1] + zz * sin(t) - x * cos(t), c[2] + zz * cos(t) + x * sin(t)) for x, yy, zz in v]
        bm = new_bm(v, f, mat='interior'); orient(bm, ('out', c))
        out.append(to_obj(bm, 'steering', 0.012))
        I('spoke', (0.37, 0.98, P['cowl'] - 0.44), (0.34, 0.035, 0.03), 'interior', 0.012, pitch=radians(22))
        I('column', (0.37, 0.95, P['cowl'] - 0.36), (0.07, 0.07, 0.2), 'interior', 0.012, pitch=radians(-22))
        return out

    def fittings(s, lod):
        P = s.P; out = []; hw = s.hw
        I = lambda *a, **k: out.append(box(*a, **k))
        bv = 0.0 if lod else 1.0
        for sx in (1, -1):
            zm = lerp(P['cowl'], P['header'], 0.25)
            I('mirror', (sx * (hw + 0.085), P['belt'] + 0.075, zm), (0.18, 0.115, 0.085), 'paint', bevel=0.03 * bv)
            I('mirror_arm', (sx * (hw - 0.01), P['belt'] + 0.035, zm + 0.01), (0.12, 0.035, 0.06), 'trim', bevel=0.008 * bv)
            if lod: continue
            I('mirror_glass', (sx * (hw + 0.085), P['belt'] + 0.075, zm - 0.0435), (0.145, 0.085, 0.004), 'chrome', 0.55)
            hx = sx * (hw * 0.991 + 0.006)
            for zh in (P['b1'] + 0.11, P['rhead'] + 0.13):
                I('handle', (hx, 0.865, zh), (0.022, 0.024, 0.15), 'chrome', bevel=0.007)
            for z0, z1 in ((P['cowl'] - 0.03, P['b2'] + 0.02), (P['b2'] - 0.02, P['rhead'] + 0.03)):
                I('rub', (sx * (hw * 0.999 + 0.002), 0.575, (z0 + z1) / 2), (0.016, 0.045, z0 - z1), 'trim', 0.03, bevel=0.005)
        if lod: return out
        y0, y1, zf, gw = s.face[1]
        for i in range(4):
            I('slat', (0, lerp(y0, y1, (i + 1) / 5), zf - 0.012), (gw * 2 - 0.05, 0.012, 0.014), 'chrome')
        I('badge', (0, y1 + 0.022, zf - 0.03), (0.07, 0.03, 0.01), 'chrome', bevel=0.004)
        T = P['bumper_top'][0]
        I('plate_f', (0, T - 0.175, P['nose'] - 0.006), (0.305, 0.152, 0.008), 'trim', (0.75, 0.75, 0.7))
        y0, y1, zr, gw = s.face[-1]
        I('plate_r', (0, (y0 + y1) / 2 - 0.02, zr - 0.004), (0.305, 0.152, 0.008), 'trim', (0.75, 0.75, 0.7))
        I('plate_frame', (0, (y0 + y1) / 2 - 0.02, zr - 0.001), (0.34, 0.185, 0.006), 'chrome')
        v, f, _ = lathe([(0, 0.0), (0, 0.022), (0.2, 0.022), (0.2, 0.028), (-0.02, 0.028)], 10)
        v = [(-0.5 + yy, 0.215 + zz, -(P['tail'] - 0.215) - x) for x, yy, zz in v]
        bm = new_bm(v, f, mat='chrome'); orient(bm, None); out.append(to_obj(bm, 'exhaust', 0.6))
        for sx, zb, pit in ((1, 0.02, 0.0), (-0.15, 0.03, 0.0)):
            I('wiper', (sx * 0.36, P['hood_cowl'] + 0.035, P['cowl'] + 0.075 + zb), (0.5, 0.012, 0.018), 'trim', 0.01)
        return out

    # ── Wheels ───────────────────────────────────────────────────────────────

    def wheel(s, lod):
        P = s.P; R = P['R']; h = P['tw'] / 2; rr = R * 0.67; out = []
        if lod:
            prof = [(-h, R * 0.8), (-h * 0.8, R), (h * 0.8, R), (h, R * 0.8), (h * 0.92, rr), (h * 0.55, rr * 0.9), (h * 0.55, 0)]
            v, f, band = lathe(prof, 12)
            bm = new_bm(v, f, mats=['tire' if b < 4 else 'rim' for b in band]); orient(bm, ('dir', (1, 0, 0), len(f) - 1))
            return to_obj(bm, 'wheel1')
        prof = [(-h * 0.9, rr), (-h, R * 0.8), (-h * 0.86, R * 0.982), (-h * 0.42, R), (h * 0.42, R), (h * 0.86, R * 0.982),
                (h, R * 0.9), (h, R * 0.77), (h * 0.9, rr)]
        v, f, band = lathe(prof, 32)
        bm = new_bm(v, f, mat='tire')
        dk = bm.verts.layers.float.new('dark')
        # Tread hint: every other vertex round the two tread edges is darker, which reads as blocks at a glance.
        bm.verts.ensure_lookup_table()
        for ring in (3, 4):
            for i in range(0, 32, 2): bm.verts[ring * 32 + i][dk] = 0.6
        orient(bm, ('out', (0, 0, 0))); out.append(to_obj(bm, 'tire'))
        v, f, _ = lathe([(-h * 0.9, rr), (-h * 0.9, 0)], 16)
        bm = new_bm(v, f, mat='tire'); orient(bm, ('dir', (-1, 0, 0), 0)); out.append(to_obj(bm, 'inner', 0.008))
        prof = [(h * 0.9, rr), (h * 0.97, rr * 0.955), (h * 0.8, rr * 0.9), (h * 0.05, rr * 0.86), (h * 0.05, 0)]
        v, f, _ = lathe(prof, 32)
        bm = new_bm(v, f, mat='rim'); orient(bm, ('dir', (1, 0, 0), len(f) - 1)); out.append(to_obj(bm, 'barrel'))
        v, f, _ = lathe([(h * 0.12, R * 0.53), (h * 0.3, R * 0.53), (h * 0.3, R * 0.2)], 20)
        bm = new_bm(v, f, mat='rim'); orient(bm, ('dir', (1, 0, 0), len(f) - 1)); out.append(to_obj(bm, 'disc', 0.2))
        v, f, _ = lathe([(h * 0.3, R * 0.19), (h * 0.8, R * 0.16), (h * 0.84, R * 0.12), (h * 0.84, 0)], 12)
        bm = new_bm(v, f, mat='rim'); orient(bm, ('dir', (1, 0, 0), len(f) - 1)); out.append(to_obj(bm, 'hub'))
        v, f = [], []
        for i in range(5):
            for sg in (-1, 1):
                a0 = radians(i * 72 + sg * 15); a1 = radians(i * 72 + sg * 5.5)
                n = len(v)
                for r, t, xf, a in ((R * 0.12, 0.012, h * 0.8, a0), (rr * 0.9, 0.013, h * 0.78, a1)):
                    for q in (-1, 1):
                        y = r * sin(a) + q * t * cos(a); z = r * cos(a) - q * t * sin(a)
                        v += [(xf, y, z), (xf - 0.035, y, z)]
                f += [(n, n + 2, n + 6, n + 4), (n, n + 4, n + 5, n + 1), (n + 2, n + 3, n + 7, n + 6)]
        bm = new_bm(v, f, mat='rim')
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.normal_update()
        # Open-backed spokes: make each front face look outward and its two flanks follow.
        bm.faces.ensure_lookup_table()
        for i in range(0, len(bm.faces), 3):
            if bm.faces[i].normal.x < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[i:i + 3])
        out.append(to_obj(bm, 'spokes'))
        return join(out, 'wheel0')


# ── Occlusion bake ───────────────────────────────────────────────────────────

DIRS = []
for _i in range(24):
    _r = sqrt((_i + 0.5) / 24); _p = _i * 2.399963
    DIRS.append((_r * cos(_p), _r * sin(_p), sqrt(1 - _r * _r)))


def bake(ob, occluders=(), ground=True, reach=0.5, floor=0.12):
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me); bm.normal_update()
    gi = MI['glass']
    V = [v.co.copy() for v in bm.verts]; F = [[v.index for v in f.verts] for f in bm.faces if f.material_index != gi]
    for ome, M in occluders:
        n = len(V); V += [M @ v.co for v in ome.vertices]; F += [[n + i for i in p.vertices] for p in ome.polygons]
    if ground:
        n = len(V); V += [Vector((-30, -30, 0)), Vector((30, -30, 0)), Vector((30, 30, 0)), Vector((-30, 30, 0))]; F.append([n, n + 1, n + 2, n + 3])
    tree = BVHTree.FromPolygons(V, F)
    tint = [0.0] * (len(me.loops) * 4); me.attributes['tint'].data.foreach_get('color', tint)
    dark = [0.0] * len(me.vertices); me.attributes['dark'].data.foreach_get('value', dark)
    out = [1.0] * (len(me.loops) * 4); cache = {}
    for f in bm.faces:
        for l in f.loops:
            v = l.vert; ao = 1.0
            if f.material_index != gi:
                # Per vertex and material, not per corner: a corner-by-corner bake splits every vertex in the file.
                n = v.normal
                key = (v.index, f.material_index)
                ao = cache.get(key)
                if ao is None:
                    t = n.orthogonal().normalized(); b = n.cross(t); o = v.co + n * 0.004; occ = 0.0
                    for dx, dy, dz in DIRS:
                        hit = tree.ray_cast(o, t * dx + b * dy + n * dz, reach)
                        if hit[0] is not None: occ += 1 - hit[3] / reach
                    ao = floor + (1 - floor) * max(0.0, 1 - occ / len(DIRS) * 1.25) ** 1.2
                    if f.material_index == 0: ao = 0.3 + 0.7 * ao
                    ao *= 1 - 0.88 * dark[v.index]
                    cache[key] = ao
            i = l.index * 4
            out[i] = tint[i] * ao; out[i + 1] = tint[i + 1] * ao; out[i + 2] = tint[i + 2] * ao
    bm.free()
    for nme in ('tint', 'dark'): me.attributes.remove(me.attributes[nme])
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    col.data.foreach_set('color', out)
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def shade(ob, angle=50):
    me = ob.data
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=radians(angle))
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 50
    apply_mods(ob)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# ── Preview stills ───────────────────────────────────────────────────────────

def render(kind, P, sets):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    try:
        sc.eevee.taa_render_samples = 32; sc.eevee.use_raytracing = True
    except Exception:
        pass
    w = bpy.data.worlds.new('w'); sc.world = w
    try: w.use_nodes = True
    except Exception: pass
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == 'BACKGROUND')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sx = nt.nodes.new('ShaderNodeSeparateXYZ'); mp = nt.nodes.new('ShaderNodeMapRange')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    mp.inputs[1].default_value = -1; mp.inputs[2].default_value = 1
    nt.links.new(tc.outputs['Generated'], sx.inputs[0]); nt.links.new(sx.outputs['Z'], mp.inputs[0])
    nt.links.new(mp.outputs[0], ramp.inputs[0]); nt.links.new(ramp.outputs[0], bg.inputs['Color'])
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (0.12, 0.12, 0.12, 1); e[1].position = 1.0; e[1].color = (0.18, 0.38, 0.8, 1)
    for pos, c in ((0.49, (0.25, 0.25, 0.25, 1)), (0.51, (0.9, 0.92, 0.95, 1)), (0.62, (0.45, 0.65, 0.9, 1))):
        el = e.new(pos); el.color = c
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0; sun.angle = radians(2)
    so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so); so.rotation_euler = (radians(50), 0, radians(35))
    gm = bpy.data.materials.new('ground')
    try: gm.use_nodes = True
    except Exception: pass
    gb = next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    gb.inputs['Base Color'].default_value = (0.09, 0.09, 0.095, 1); gb.inputs['Roughness'].default_value = 0.8
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=40)
    gme = bpy.data.meshes.new('ground'); bm.to_mesh(gme); bm.free(); gme.materials.append(gm)
    sc.collection.objects.link(bpy.data.objects.new('ground', gme))
    tgt = bpy.data.objects.new('tgt', None); sc.collection.objects.link(tgt); tgt.location = B(0, 0.62, 0)
    cam = bpy.data.cameras.new('cam'); cam.lens = 45
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    c = co.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    views = {'front34': (3.4, 1.35, 5.2), 'side': (7.6, 1.0, 0.0), 'rear34': (-3.3, 1.5, -5.4), 'top': (2.2, 5.5, 2.5), 'low': (2.2, 0.5, 4.2)}
    os.makedirs(os.path.join(ROOT, 'shots', 'blender'), exist_ok=True)
    for lod, (body, wheel) in enumerate(sets):
        insts = []
        for sxn in (1, -1):
            for z in (P['wb'] / 2, -P['wb'] / 2):
                o = bpy.data.objects.new('pv', wheel.data); sc.collection.objects.link(o)
                o.location = B(sxn * P['track'] / 2, P['R'], z)
                if sxn < 0: o.rotation_euler = (0, 0, pi)
                insts.append(o)
        for b2, w2 in sets:
            b2.hide_render = b2 is not body; w2.hide_render = True
        for name, pos in views.items():
            if lod and name != 'front34': continue
            co.location = B(*pos)
            sc.render.filepath = os.path.join(ROOT, 'shots', 'blender', f'{kind}_{name}{"_lod1" if lod else ""}.png')
            bpy.ops.render.render(write_still=True)
        for o in insts: bpy.data.objects.remove(o)


# ── Build one vehicle ────────────────────────────────────────────────────────

def build(kind, do_render=True, do_export=True):
    P = VEHICLES[kind]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials(P['paint'])
    car = Car(P); sets = []; stats = {}
    for lod in (0, 1):
        parts = [car.shell(lod), car.bumper(1, lod), car.bumper(-1, lod)] + car.underbody(lod) + car.fittings(lod)
        if lod == 0: parts += car.interior()
        body = join(parts, f'LOD{lod}')
        wheel = car.wheel(lod); wheel.name = wheel.data.name = f'WHEEL{lod}'
        M = []
        for sx in (1, -1):
            for z in (P['wb'] / 2, -P['wb'] / 2):
                M.append((wheel.data, Matrix.Translation(B(sx * P['track'] / 2, P['R'], z)) @ (Matrix.Rotation(pi, 4, 'Z') if sx < 0 else Matrix.Identity(4))))
        bake(body, M)
        bake(wheel, ground=False, reach=0.25, floor=0.2)
        shade(body); shade(wheel, 40)
        sets.append((body, wheel))
        stats[f'LOD{lod}'] = tris(body); stats[f'WHEEL{lod}'] = tris(wheel)
    lo = [min(v.co[i] for v in sets[0][0].data.vertices) for i in range(3)]
    hi = [max(v.co[i] for v in sets[0][0].data.vertices) for i in range(3)]
    stats['size'] = {'width': round(hi[0] - lo[0], 3), 'length': round(hi[1] - lo[1], 3), 'height': round(hi[2], 3),
                     'front': round(-lo[1], 3), 'rear': round(hi[1], 3)}
    if do_export:
        out = os.path.join(ROOT, 'public', 'models'); os.makedirs(out, exist_ok=True)
        path = os.path.join(out, kind + '.glb')
        bpy.ops.object.select_all(action='DESELECT')
        for b, w in sets: b.select_set(True); w.select_set(True)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                                  export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
                                  export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                                  export_active_vertex_color_when_no_material=True, export_animations=False,
                                  export_skins=False, export_morph=False, export_extras=False)
        stats['bytes'] = os.path.getsize(path)
        import struct
        with open(path, 'rb') as fh:
            fh.seek(12); n, _ = struct.unpack('<II', fh.read(8)); g = json.loads(fh.read(n))
        stats['accessors'] = sorted({(a['componentType'], a['type']) for a in g['accessors']})
        stats['verts'] = sum(g['accessors'][p['attributes']['POSITION']]['count'] for m in g['meshes'] for p in m['primitives'])
        stats['attrs'] = sorted({k for m in g['meshes'] for p in m['primitives'] for k in p['attributes']})
    print('STATS ' + json.dumps({kind: stats}))
    if do_render: render(kind, P, sets)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    kinds = [a for a in argv if not a.startswith('--')] or list(VEHICLES)
    for k in kinds:
        build(k, '--no-render' not in argv, '--no-export' not in argv)
