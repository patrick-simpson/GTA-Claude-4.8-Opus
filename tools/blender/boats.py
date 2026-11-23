# Port Calamity's boats, modelled in Blender by script and exported as .glb, in the manner of cars.py.
#
#   blender --factory-startup --python tools/blender/boats.py --python-expr "import bpy; bpy.ops.wm.quit_blender()"
#   (with its window showing, never --background: the owner watches the screen)
#
# Writes public/models/boats.glb (speedboat_LOD0..2, jetski_LOD0..2, ramp_LOD0..1) and boats_far.glb (the LOD2s and
# ramp_LOD1 alone, for phones). src/ent/boat.ts loads them; its HULLS table (buoyancy points, seats) matches the
# shapes here. Set BOATS_OUT to send a trial run's files elsewhere.
#
# As in cars.py everything is authored in the GAME's frame (x = the boat's left, y = up, z = forward) and passed
# through B() into Blender's Z-up frame. y 0 is the design waterline: the keel is at -draft (0.34 m for the
# runabout, 0.24 m for the jet ski), as ent/boat.ts expects.
#
# The recipe:
#   * hull(): a loft of cross-sections from transom to stem. Each section runs gunwale - boot stripe - spray chine -
#     chine - keel - and back up the other side, with deadrise growing toward the bow and a forefoot that sweeps up
#     to the stem. Faces take their material by row: paint above the stripe, trim (the stripe), hull below.
#   * deck(): the foredeck's crowned loft, the gunwale caps and cockpit walls, the sole, the transom cap.
#   * fittings: windscreen (raked, wrapped, glass in a chrome frame), helm console and wheel, two bucket seats and
#     the stern bench (vinyl), the outboard (cowling, leg, cavitation plate, propeller), cleats, bow rails, a stern
#     light. The jet ski: hull, sponsons, deck with footwells, the hood and handlebar pod, bars and grips, a long
#     saddle, the pump nozzle, mirrors.
#   * Occlusion is ray cast per vertex and multiplied into the vertex colours (the colour of each material's faces
#     is the tint; 'paint' carries occlusion only, the game supplies its colour per boat).
#   * LOD1 lofts fewer sections and drops the small fittings; LOD2 (the far level, and all a phone draws) is the
#     coarse hull, deck and a block or two.

import bpy, bmesh, os, sys, json
from math import sin, cos, pi, radians, sqrt, tan
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MODELS = os.environ.get('BOATS_OUT') or os.path.join(ROOT, 'public', 'models')

MATS = ['paint', 'trim', 'hull', 'deck', 'glass', 'chrome', 'vinyl', 'rubber', 'metal', 'wood', 'float']
MI = {n: i for i, n in enumerate(MATS)}
TINT = {'paint': (1, 1, 1), 'trim': (0.07, 0.12, 0.26), 'hull': (0.16, 0.2, 0.27), 'deck': (0.86, 0.85, 0.8),
        'glass': (0.6, 0.7, 0.72), 'chrome': (0.85, 0.86, 0.88), 'vinyl': (0.9, 0.86, 0.76), 'rubber': (0.06, 0.06, 0.07),
        'metal': (0.5, 0.52, 0.55), 'wood': (0.62, 0.45, 0.3), 'float': (0.12, 0.13, 0.15)}


def B(x, y, z):
    """Game frame to Blender frame (a proper rotation, so winding survives)."""
    return Vector((x, -z, y))


class Mesh:
    """One level of detail being built: a bmesh with a colour layer, faces tagged by material."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new('Col')

    def face(self, pts, mat, tint=None):
        vs = [self.bm.verts.new(B(*p)) for p in pts]
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        self.tag(f, mat, tint)
        return f

    def tag(self, f, mat, tint=None):
        f.material_index = MI[mat]
        c = tint or TINT[mat]
        for l in f.loops: l[self.col] = (c[0], c[1], c[2], 1.0)

    def loft(self, rows, mat_of, tint_of=None, close=False):
        """rows: sections (lists of game-frame points, all the same length). mat_of(i, j) names the material of the
        face between point j and j+1 from section i to i+1. Shared vertices, so it smooths."""
        V = [[self.bm.verts.new(B(*p)) for p in r] for r in rows]
        n = len(rows[0])
        for i in range(len(rows) - 1):
            for j in range(n - (0 if close else 1)):
                k = (j + 1) % n
                q = [V[i][j], V[i][k], V[i + 1][k], V[i + 1][j]]
                if len({v.co.to_tuple(5) for v in q}) < 3: continue
                try:
                    f = self.bm.faces.new(q)
                except ValueError:
                    continue
                self.tag(f, mat_of(i, j), tint_of(i, j) if tint_of else None)
        return V

    def cap(self, verts, mat, tint=None):
        """Close a ring of vertices already in the mesh."""
        vs = []
        for v in verts:
            if not vs or (v.co - vs[-1].co).length > 1e-5: vs.append(v)
        if len(vs) < 3: return None
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        self.tag(f, mat, tint)
        return f

    def box(self, c, s, mat, tint=None, rot=(0, 0, 0), bevel=0.0):
        """Centre and size in the game frame; rot = (pitch about x, yaw about y, roll about z) in radians."""
        M = Matrix.Translation(B(*c)) @ Matrix.Rotation(rot[1], 4, 'Z') @ Matrix.Rotation(-rot[0], 4, 'X') @ Matrix.Rotation(rot[2], 4, 'Y') \
            @ Matrix.Diagonal((s[0], s[2], s[1], 1))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=M)
        vs = r['verts']; fs = list({f for v in vs for f in v.link_faces})
        if bevel:
            es = list({e for v in vs for e in v.link_edges})
            out = bmesh.ops.bevel(self.bm, geom=vs + es, offset=bevel, segments=2, affect='EDGES', profile=0.5)
            fs = list({f for v in list(vs) + out['verts'] if v.is_valid for f in v.link_faces})
        for f in fs: self.tag(f, mat, tint)

    def tube(self, a, b, r, mat, seg=8, tint=None):
        """A cylinder from point a to point b (game frame)."""
        A, Bv = B(*a), B(*b)
        d = Bv - A; L = d.length
        M = Matrix.Translation((A + Bv) / 2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        r_ = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=L, matrix=M)
        for f in {f for v in r_['verts'] for f in v.link_faces}: self.tag(f, mat, tint)

    def lathe(self, c, prof, mat, seg=16, tint=None, axis='z'):
        """A solid of revolution round a game-frame axis through c: prof = [(radius, offset along the axis)]."""
        rows = []
        for k in range(seg):
            a = 2 * pi * k / seg
            row = []
            for rad, off in prof:
                u, v = cos(a) * rad, sin(a) * rad
                p = (c[0] + u, c[1] + v, c[2] + off) if axis == 'z' else (c[0] + off, c[1] + v, c[2] + u)
                row.append(p)
            rows.append(row)
        rows.append(rows[0])
        self.loft(rows, lambda i, j: mat, (lambda i, j: tint) if tint else None)

    def finish(self, name, ao=True):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.normal_update()
        bm.verts.index_update()
        if ao: occlude(bm, self.col)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me); bm.free()
        for n in MATS: me.materials.append(material(n))
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        me.set_sharp_from_angle(angle=radians(38))
        # Drop the material slots nobody uses, so the file carries no empty primitives.
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
    rough = {'glass': 0.05, 'chrome': 0.15, 'paint': 0.2, 'hull': 0.3, 'vinyl': 0.55}.get(n, 0.7)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 1.0 if n in ('chrome', 'metal') else 0.0
    return m


DIRS = []
for i in range(14):
    a = i * 2.39996; z = 0.15 + 0.85 * (i + 0.5) / 14; r = sqrt(1 - z * z)
    DIRS.append((cos(a) * r, sin(a) * r, z))


def occlude(bm, col, reach=0.6, floor=0.25):
    tree = BVHTree.FromBMesh(bm)
    cache = {}
    for f in bm.faces:
        glass = f.material_index == MI['glass']
        for l in f.loops:
            v = l.vert
            if glass: continue
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


def smooth01(t):
    t = max(0.0, min(1.0, t)); return t * t * (3 - 2 * t)


# ── The runabout: Riptide 21 ─────────────────────────────────────────────────

SB = dict(L=6.4, hb=1.15, keel=-0.34, sheer=0.62)


def sb_station(t):
    """Half beam at the gunwale, gunwale height, keel height and deadrise at t (0 transom .. 1 stem)."""
    L, hb = SB['L'], SB['hb']
    z = -L / 2 + t * L
    if t < 0.32: w = hb * (0.95 + 0.05 * t / 0.32)
    else:
        u = (t - 0.32) / 0.68; w = hb * max(0.0, 1 - u ** 2.1) ** 0.62
    ys = SB['sheer'] + 0.22 * t ** 2.2
    yk = SB['keel'] + 0.95 * smooth01((t - 0.62) / 0.38) ** 1.6
    dead = radians(19 + 30 * t ** 2)
    return z, max(w, 0.004), ys, yk, dead


def sb_hull(m, n):
    rows = []; ts = [i / (n - 1) for i in range(n)]
    ts = [t if t < 0.98 else 0.98 + (t - 0.98) for t in ts]
    for t in ts:
        z, w, ys, yk, dead = sb_station(t)
        hc = w * 0.8
        yc = yk + hc * tan(dead)
        yc = min(yc, ys - 0.05)
        sb_bot = max(yc + 0.12, 0.06); st_top = sb_bot + 0.1
        half = [(w, ys), (w * 0.995, min(st_top, ys - 0.01)), (w * 0.99, min(sb_bot, ys - 0.02)), (hc + 0.05 * w / 1.15, yc + 0.03), (hc, yc), (0.0, yk)]
        sec = [(x, y, z) for x, y in half] + [(-x, y, z) for x, y in reversed(half[:-1])]
        rows.append(sec)
    # Rows by point index: 0-1 paint, 1-2 stripe, 2-5 bottom (mirrored after the keel).
    def mat(i, j):
        jj = j if j < 5 else 9 - j
        return 'paint' if jj == 0 else 'trim' if jj == 1 else 'hull'
    def tint(i, j):
        jj = j if j < 5 else 9 - j
        if jj == 2: return (0.92, 0.92, 0.9)
        return None
    V = m.loft(rows, mat, tint)
    # The transom: a flat face over the first section, and its top edge closed by the aft deck.
    m.cap(list(reversed(V[0])), 'paint')
    return rows


def sb_deck(m, n, lod):
    L = SB['L']
    t0, t1 = 0.035, 0.6      # the cockpit, transom to windscreen
    sole = 0.12
    # Gunwale caps and the cockpit's inner walls, both sides.
    ts = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    for side in (1, -1):
        rows = []
        for t in ts:
            z, w, ys, yk, dead = sb_station(t)
            rows.append([(side * w, ys, z), (side * (w - 0.13), ys + 0.015, z), (side * (w - 0.15), ys - 0.04, z), (side * (w - 0.17), sole, z)])
        m.loft(rows if side > 0 else [list(r) for r in rows], lambda i, j: 'deck' if j == 0 else 'paint' if j == 1 else 'deck',
               lambda i, j: (0.93, 0.93, 0.9) if j == 0 else (0.82, 0.8, 0.74) if j == 2 else None)
    # The sole: non-skid between the walls.
    rows = []
    for t in ts:
        z, w, ys, yk, dead = sb_station(t)
        rows.append([(w - 0.17, sole, z), (0, sole, z), (-(w - 0.17), sole, z)])
    m.loft(rows, lambda i, j: 'deck', lambda i, j: (0.72, 0.72, 0.7))
    # Aft deck over the transom, and the cockpit's back wall.
    z0, w0, ys0, _, _ = sb_station(0.0); z1, w1, ys1, _, _ = sb_station(t0)
    m.face([(w0, ys0, z0), (w1, ys1, z1), (-w1, ys1, z1), (-w0, ys0, z0)], 'deck', (0.93, 0.93, 0.9))
    m.face([(w1 - 0.17, sole, z1), (-(w1 - 0.17), sole, z1), (-(w1 - 0.13), ys1 + 0.015, z1), (w1 - 0.13, ys1 + 0.015, z1)], 'paint')
    # The foredeck: crowned, from the windscreen to the stem.
    nf = max(4, n // 2 + 2)
    rows = []
    for i in range(nf):
        t = t1 + (0.985 - t1) * i / (nf - 1)
        z, w, ys, yk, dead = sb_station(t)
        crown = 0.1 * (1 - t) / (1 - t1) + 0.02
        rows.append([(w, ys, z), (w * 0.5, ys + crown * 0.8, z), (0, ys + crown, z), (-w * 0.5, ys + crown * 0.8, z), (-w, ys, z)])
    m.loft(rows, lambda i, j: 'paint')
    # The front wall of the cockpit under the windscreen (the console's back is against it).
    z, w, ys, _, _ = sb_station(t1)
    m.face([(w - 0.17, sole, z), (w - 0.13, ys + 0.015, z), (-(w - 0.13), ys + 0.015, z), (-(w - 0.17), sole, z)], 'paint', (0.9, 0.9, 0.88))
    return t1


def sb_fittings(m, lod):
    L = SB['L']
    zt = -L / 2 + 0.6 * L
    # Windscreen: a raked, wrapped band from gunwale to gunwale.
    k = 9 if lod == 0 else 5
    bot, top = [], []
    for i in range(k):
        u = -1 + 2 * i / (k - 1)
        tt = 0.6 - 0.07 * u * u
        z, w, ys, _, _ = sb_station(tt)
        x = u * (w - 0.08)
        bot.append((x, ys + 0.03, z))
        top.append((x * 0.96, ys + 0.48, z - 0.3 - 0.05 * (1 - u * u)))
    m.loft([bot, top], lambda i, j: 'glass')
    if lod < 2:
        m.loft([top, [(x, y + 0.03, z - 0.02) for x, y, z in top]], lambda i, j: 'chrome')
    # Helm console on the left (the driver sits on the left, as in the cars), passenger's grab box on the right.
    m.box((0.5, 0.42, zt - 0.38), (0.62, 0.62, 0.5), 'paint', (0.92, 0.92, 0.9), bevel=0.04 if lod == 0 else 0)
    m.box((-0.5, 0.36, zt - 0.36), (0.6, 0.5, 0.45), 'paint', (0.92, 0.92, 0.9), bevel=0.04 if lod == 0 else 0)
    if lod < 2:
        m.box((0.5, 0.74, zt - 0.5), (0.5, 0.06, 0.3), 'trim', (0.08, 0.08, 0.09), rot=(radians(-25), 0, 0))   # dash
        # The wheel, on a short column.
        c = (0.5, 0.86, zt - 0.72)
        m.tube((0.5, 0.74, zt - 0.6), c, 0.025, 'chrome', 6)
        if lod == 0:
            ring = []
            for i in range(17):
                a = 2 * pi * i / 16
                ring.append([(c[0] + cos(a) * (0.17 + 0.022 * cos(b)), c[1] + sin(a) * (0.17 + 0.022 * cos(b)) * 0.8, c[2] + sin(a) * 0.1 + 0.022 * sin(b)) for b in [2 * pi * q / 6 for q in range(7)]])
            m.loft(ring, lambda i, j: 'rubber')
            m.tube((c[0] - 0.17, c[1], c[2]), (c[0] + 0.17, c[1], c[2]), 0.012, 'chrome', 5)
            m.box((0.38, 0.79, zt - 0.47), (0.08, 0.02, 0.08), 'glass', (0.2, 0.3, 0.32))   # gauges
            m.box((0.62, 0.79, zt - 0.47), (0.08, 0.02, 0.08), 'glass', (0.2, 0.3, 0.32))
    # Two bucket seats and the stern bench.
    for x in (0.48, -0.48):
        z0 = -0.3
        m.box((x, 0.36, z0), (0.5, 0.18, 0.5), 'vinyl', bevel=0.05 if lod == 0 else 0)
        m.box((x, 0.68, z0 - 0.27), (0.5, 0.58, 0.13), 'vinyl', rot=(radians(-12), 0, 0), bevel=0.05 if lod == 0 else 0)
        if lod < 2: m.tube((x, 0.12, z0), (x, 0.28, z0), 0.05, 'chrome', 8)
    m.box((0, 0.32, -1.85), (1.75, 0.4, 0.55), 'vinyl', bevel=0.05 if lod == 0 else 0)
    m.box((0, 0.66, -2.2), (1.75, 0.5, 0.14), 'vinyl', rot=(radians(-10), 0, 0), bevel=0.05 if lod == 0 else 0)
    if lod == 0:
        for x in (-0.6, 0, 0.6):    # piping lines on the bench
            m.box((x, 0.53, -1.85), (0.02, 0.01, 0.52), 'trim', (0.6, 0.55, 0.45))
    # The outboard: cowling, leg, plate, propeller.
    zt0 = -L / 2
    m.box((0, 0.8, zt0 - 0.32), (0.5, 0.62, 0.66), 'trim', (0.05, 0.05, 0.06), bevel=0.1 if lod == 0 else 0.04 if lod == 1 else 0)
    m.box((0, 1.12, zt0 - 0.3), (0.4, 0.08, 0.5), 'paint', bevel=0.03 if lod == 0 else 0)
    m.box((0, 0.2, zt0 - 0.3), (0.16, 0.9, 0.3), 'trim', (0.08, 0.08, 0.09), bevel=0.04 if lod == 0 else 0)
    m.box((0, -0.18, zt0 - 0.28), (0.36, 0.03, 0.45), 'metal')
    if lod < 2:
        m.box((0, -0.32, zt0 - 0.3), (0.12, 0.12, 0.42), 'metal', bevel=0.03 if lod == 0 else 0)
        for i in range(3):
            a = 2 * pi * i / 3
            m.box((cos(a) * 0.14, -0.32 + sin(a) * 0.14, zt0 - 0.5), (0.2, 0.05, 0.02), 'metal', rot=(0, 0, a))
    if lod == 0:
        # Bow rails along the foredeck edges, on stanchions.
        for side in (1, -1):
            pts = []
            for i in range(7):
                t = 0.66 + 0.29 * i / 6
                z, w, ys, _, _ = sb_station(t)
                pts.append((side * (w - 0.07), ys + 0.32, z))
                if i % 2 == 0: m.tube((side * (w - 0.07), ys, z), (side * (w - 0.07), ys + 0.32, z), 0.014, 'chrome', 6)
            for a, b in zip(pts, pts[1:]): m.tube(a, b, 0.016, 'chrome', 6)
        # Cleats at the four corners, a stern light, a bow light and a ski pylon.
        for t, side in ((0.06, 1), (0.06, -1), (0.62, 1), (0.62, -1)):
            z, w, ys, _, _ = sb_station(t)
            m.box((side * (w - 0.07), ys + 0.05, z), (0.04, 0.05, 0.18), 'chrome')
        z, w, ys, _, _ = sb_station(0.985)
        m.box((0, ys + 0.08, z - 0.1), (0.1, 0.06, 0.08), 'glass', (0.9, 0.3, 0.2))
        m.tube((-0.85, 0.65, -2.95), (-0.85, 1.55, -2.95), 0.018, 'chrome', 6)
        m.box((-0.85, 1.58, -2.95), (0.06, 0.06, 0.06), 'glass', (0.95, 0.95, 0.9))
        m.tube((0, 0.12, -1.3), (0, 1.25, -1.3), 0.035, 'chrome', 8)


def speedboat(lod):
    m = Mesh()
    n = [26, 13, 8][lod]
    sb_hull(m, n)
    sb_deck(m, max(4, n // 2), lod)
    sb_fittings(m, lod)
    return m.finish(f'speedboat_LOD{lod}', ao=lod < 2)


# ── The jet ski: Skeeter ─────────────────────────────────────────────────────

JS = dict(L=3.2, hb=0.6, keel=-0.24, sheer=0.3)


def js_station(t):
    L, hb = JS['L'], JS['hb']
    z = -L / 2 + t * L
    if t < 0.4: w = hb * (0.93 + 0.07 * t / 0.4)
    else:
        u = (t - 0.4) / 0.6; w = hb * max(0.0, 1 - u ** 2.3) ** 0.55
    ys = JS['sheer'] + 0.12 * t ** 1.5
    yk = JS['keel'] + 0.55 * smooth01((t - 0.65) / 0.35) ** 1.5
    dead = radians(22 + 25 * t ** 2)
    return z, max(w, 0.004), ys, yk, dead


def jetski(lod):
    m = Mesh()
    n = [22, 11, 7][lod]
    rows = []
    for i in range(n):
        t = min(0.985, i / (n - 1))
        z, w, ys, yk, dead = js_station(t)
        hc = w * 0.72; yc = min(yk + hc * tan(dead), ys - 0.06)
        half = [(w, ys), (w * 1.02, ys - 0.07), (w * 0.98, max(yc + 0.08, 0.0)), (hc, yc), (0.0, yk)]
        rows.append([(x, y, z) for x, y in half] + [(-x, y, z) for x, y in reversed(half[:-1])])
    def mat(i, j):
        jj = j if j < 4 else 7 - j
        return 'trim' if jj == 1 else 'paint' if jj == 0 else 'hull'
    def tint(i, j):
        jj = j if j < 4 else 7 - j
        return (0.08, 0.08, 0.09) if jj == 1 else (0.93, 0.93, 0.9) if jj >= 2 else None
    V = m.loft(rows, mat, tint)
    m.cap(list(reversed(V[0])), 'trim', (0.1, 0.1, 0.11))
    # The deck: footwells either side of a raised spine, the spine swelling into the hood up front.
    rows = []
    nd = n
    for i in range(nd):
        t = min(0.985, i / (nd - 1))
        z, w, ys, yk, dead = js_station(t)
        well = smooth01((t - 0.05) / 0.1) * (1 - smooth01((t - 0.55) / 0.1))
        spine = 0.2 + 0.08 * well
        hood = smooth01((t - 0.5) / 0.15) * (1 - smooth01((t - 0.92) / 0.08))
        sh = ys + 0.04 + 0.32 * hood * (1 - t * 0.4)
        sw = min(w * 0.98, spine + 0.12 * hood)
        fy = ys + 0.02 - 0.18 * well
        rows.append([(w, ys, z), (w - 0.06, ys + 0.03, z), (w - 0.08, fy, z), (sw + 0.03, fy, z), (sw, sh, z), (0, sh + 0.04, z),
                     (-sw, sh, z), (-(sw + 0.03), fy, z), (-(w - 0.08), fy, z), (-(w - 0.06), ys + 0.03, z), (-w, ys, z)])
    DV = m.loft(rows, lambda i, j: 'trim' if j in (2, 7) else 'paint' if j in (3, 4, 5, 6) else 'deck',
                lambda i, j: (0.12, 0.12, 0.13) if j in (2, 7) else (0.2, 0.2, 0.22) if j in (0, 1, 8, 9) else None)
    m.cap(list(DV[0]), 'trim', (0.1, 0.1, 0.11))
    # The saddle: a long rounded loaf down the spine.
    seg = 9 if lod == 0 else 5
    srows = []
    for i in range(seg):
        u = i / (seg - 1)
        z = -1.12 + u * 1.0
        hgt = 0.62 + 0.06 * sin(u * pi) + 0.04 * u
        wid = 0.2 + 0.03 * sin(u * pi)
        prof = [(wid, 0.42), (wid * 1.05, hgt - 0.08), (wid * 0.7, hgt - 0.01), (0, hgt), (-wid * 0.7, hgt - 0.01), (-wid * 1.05, hgt - 0.08), (-wid, 0.42)]
        srows.append([(x, y, z) for x, y in prof])
    sv = m.loft(srows, lambda i, j: 'vinyl', lambda i, j: (0.1, 0.1, 0.11) if j not in (2, 3) else (0.18, 0.17, 0.16))
    m.cap(list(sv[0]), 'vinyl', (0.1, 0.1, 0.11)); m.cap(list(reversed(sv[-1])), 'vinyl', (0.1, 0.1, 0.11))
    # Handlebar pod and bars.
    m.box((0, 0.86, 0.28), (0.34, 0.2, 0.36), 'paint', rot=(radians(18), 0, 0), bevel=0.06 if lod == 0 else 0)
    m.tube((0.36, 0.98, 0.18), (-0.36, 0.98, 0.18), 0.018, 'chrome', 6)
    if lod < 2:
        m.tube((0, 0.88, 0.25), (0, 0.98, 0.18), 0.03, 'trim', 6)
        for x in (0.3, -0.3): m.tube((x, 0.98, 0.18), (x * 1.3, 0.98, 0.18), 0.03, 'rubber', 8)
        m.box((0, 0.94, 0.4), (0.14, 0.03, 0.08), 'glass', (0.2, 0.28, 0.3))     # display
        m.box((0, 0.66, 1.18), (0.22, 0.06, 0.06), 'glass', (0.95, 0.95, 0.9))   # headlight
        # The pump's nozzle under the transom, and a grab handle behind the seat.
        m.lathe((0, -0.08, -1.6), [(0.0, 0.0), (0.09, 0.0), (0.075, -0.18), (0.0, -0.18)], 'metal', seg=10)
        m.tube((0.14, 0.5, -1.25), (-0.14, 0.5, -1.25), 0.02, 'trim', 6)
    if lod == 0:
        for x in (0.24, -0.24):
            m.tube((x, 0.9, 0.42), (x * 1.5, 1.08, 0.38), 0.008, 'trim', 5)
            m.box((x * 1.5, 1.1, 0.38), (0.1, 0.06, 0.02), 'chrome')
        # Sponsons on the chines aft, and the name stripe.
        for side in (1, -1):
            m.box((side * 0.6, -0.02, -1.0), (0.05, 0.06, 0.7), 'trim', (0.1, 0.1, 0.1))
            z, w, ys, _, _ = js_station(0.45)
            m.box((side * (w + 0.005), ys - 0.03, 0.0), (0.01, 0.05, 1.3), 'trim', (0.85, 0.2, 0.12))
    return m.finish(f'jetski_LOD{lod}', ao=lod < 2)


# ── The ramp: a plank wedge on two floats ────────────────────────────────────

def ramp(lod):
    m = Mesh()
    L, W, H = 9.0, 5.2, 1.9
    z0, z1 = -L / 2, L / 2
    planks = 18 if lod == 0 else 1
    for i in range(planks):
        a = i / planks; b = (i + 1) / planks - (0.006 if lod == 0 else 0)
        tint = (0.66, 0.5, 0.34) if i % 3 else (0.58, 0.43, 0.29)
        m.face([(W / 2, a * H, z0 + a * L), (-W / 2, a * H, z0 + a * L), (-W / 2, b * H, z0 + b * L), (W / 2, b * H, z0 + b * L)], 'wood', tint)
    # Sides and back, painted, and the chevrons that say which way.
    for s in (1, -1):
        m.face([(s * W / 2, 0, z0), (s * W / 2, H, z1), (s * W / 2, -0.35, z1), (s * W / 2, -0.35, z0)] if s > 0 else
               [(s * W / 2, -0.35, z0), (s * W / 2, -0.35, z1), (s * W / 2, H, z1), (s * W / 2, 0, z0)], 'paint', (0.89, 0.34, 0.18))
    m.face([(W / 2, H, z1), (-W / 2, H, z1), (-W / 2, -0.35, z1), (W / 2, -0.35, z1)], 'paint', (0.89, 0.34, 0.18))
    if lod == 0:
        for k in range(3):
            a = 0.2 + 0.25 * k
            y, z = a * H + 0.012, z0 + a * L
            for s in (1, -1):
                m.face([(0, y, z + 0.5), (s * 1.6, y - 0.3 * 0.21, z - 0.3 + 0.0), (s * 1.6, y - 0.3 * 0.21 + 0.08, z - 0.3 + 0.35), (0, y + 0.08, z + 0.85)] if s > 0 else
                       [(0, y + 0.08, z + 0.85), (s * 1.6, y - 0.3 * 0.21 + 0.08, z - 0.3 + 0.35), (s * 1.6, y - 0.3 * 0.21, z - 0.3), (0, y, z + 0.5)], 'paint', (0.95, 0.93, 0.85))
        # Edge stripes along the top of each side.
        for s in (1, -1):
            m.box((s * (W / 2 - 0.08), H / 2 + 0.03, 0), (0.16, 0.04, sqrt(L * L + H * H)), 'paint', (0.95, 0.85, 0.2), rot=(-0.2078, 0, 0))
    # Two floats underneath.
    seg = 12 if lod == 0 else 6
    for s in (1, -1):
        m.lathe((s * 1.6, -0.35, 0), [(0.0, -L / 2 + 0.1), (0.42, -L / 2 + 0.6), (0.45, 0), (0.42, L / 2 - 0.6), (0.0, L / 2 - 0.1)], 'float', seg=seg)
    return m.finish(f'ramp_LOD{lod}', ao=lod == 0)


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
    stats = {}
    obs = {}
    for name, fn, n in (('speedboat', speedboat, 3), ('jetski', jetski, 3), ('ramp', ramp, 2)):
        for lod in range(n):
            ob = fn(lod); obs[ob.name] = ob; stats[ob.name] = tris(ob)
    # Spread them out in the window so the owner can see what was made.
    for i, (nm, ob) in enumerate(obs.items()):
        lod = int(nm[-1]); kind = nm.split('_')[0]
        ob.location = Vector(({'speedboat': 0, 'jetski': 4, 'ramp': 10}[kind], lod * 9, 0))
    os.makedirs(MODELS, exist_ok=True)
    for ob in obs.values(): ob.location = Vector((0, 0, 0))
    stats['boats.glb kB'] = export(list(obs.values()), os.path.join(MODELS, 'boats.glb'))
    far = [obs['speedboat_LOD2'], obs['jetski_LOD2'], obs['ramp_LOD1']]
    stats['boats_far.glb kB'] = export(far, os.path.join(MODELS, 'boats_far.glb'))
    for i, (nm, ob) in enumerate(obs.items()):
        lod = int(nm[-1]); kind = nm.split('_')[0]
        ob.location = Vector(({'speedboat': 0, 'jetski': 4, 'ramp': 10}[kind], lod * 9, 0))
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
