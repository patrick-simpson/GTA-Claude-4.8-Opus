# Dithers College's two hero buildings, modelled in Blender by script and exported as .glb: the library (a Georgian brick block
# under a low copper roof, two forward end pavilions, a white-columned portico on a flight of granite steps, and the stepped
# brick-then-white clock tower with four clock faces, a balustrade, a belfry, a lantern and a dark spire) and the chapel (a brick
# nave with tall arched windows, a four-column portico under a pediment, a fieldstone base with steps, a brick tower, a white
# belfry and a white-trimmed dark spire). Both follow what the owner asked for ("just like Colby") from freely licensed photographs
# of the real buildings viewed for proportions; nothing from a photograph is in the file, and no real name is anywhere.
#
#   "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" --factory-startup --python tools/blender/campus.py
#   (with its window showing, never --background; `--stay` keeps the window open afterwards)
#
# Writes, in public/models (CAMPUS_OUT overrides the folder for a trial):
#   campus_hero.glb      library_0 library_1 library_2 chapel_0 chapel_1 chapel_2 (near, street, far levels of detail)
#   campus_hero_far.glb  the _1 and _2 meshes only: what phones and the low preset fetch.
# Frame (as buildings.py): x along the frontage, y up (0 = the first-floor level the game puts at the highest ground under the
# building; the footings run 3 m below), z out of the front. The origin is the middle of the plan's first rectangle: the game
# places each model at that rectangle's centre and turns it (the chapel's front looks along the plan's -x).
# Vertex colour (linear) is the albedo. Its ALPHA: 1.0 brick (the game lays a tiled brick map over it from position and normal),
# 0.0 anything else that is not glass, 0.20-0.35 dark glass, 0.55-0.65 a lit window or clock face (the game lamps these at night).

import bpy, bmesh, sys, os, json, random
from math import sin, cos, pi, sqrt
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.environ.get('CAMPUS_OUT') or os.path.join(ROOT, 'public', 'models')
FLAGS = {a for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv) if a == '--stay'}


def lin(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def B(x, y, z): return (x, -z, y)


BRICK, WHITE, GRANITE, STONE = 0xb4553f, 0xf1ede2, 0x9d9a92, 0x77746e
GLASS, DARK, GOLD, GREEN, SLATE, SPIRE = 0x4d6072, 0x26303c, 0xc9a24a, 0x7aa595, 0x3a3f46, 0x3b343a


class Mesh:
    def __init__(self, seed=1):
        self.v, self.f, self.c = [], [], []
        self.rnd = random.Random(seed)

    def face(self, pts, hex_, a=0.0, n=None, inside=None):
        p0, p1, p2 = (Vector(p) for p in pts[:3])
        cr = (p1 - p0).cross(p2 - p0)
        if cr.length < 1e-12 and len(pts) > 3: cr = (p2 - p0).cross(Vector(pts[3]) - p0)
        if inside is not None:
            cen = sum((Vector(p) for p in pts), Vector()) / len(pts)
            if cr.dot(cen - Vector(inside)) < 0: pts = pts[::-1]
        elif n is not None and cr.dot(Vector(n)) < 0: pts = pts[::-1]
        i = len(self.v)
        self.v.extend(pts)
        self.f.append(list(range(i, i + len(pts))))
        col = lin(hex_) if isinstance(hex_, int) else hex_
        if a == 1.0:
            j = 0.93 + 0.14 * self.rnd.random()
            col = tuple(c * j for c in col)
        self.c.append(tuple(col) + (a,))

    def box(self, x0, x1, y0, y1, z0, z1, hex_, a=0.0, skip=''):
        if x1 < x0: x0, x1 = x1, x0
        if y1 < y0: y0, y1 = y1, y0
        if z1 < z0: z0, z1 = z1, z0
        F = {
            'f': ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1)),
            'k': ([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)], (0, 0, -1)),
            'l': ([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)], (-1, 0, 0)),
            'r': ([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], (1, 0, 0)),
            't': ([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], (0, 1, 0)),
            'b': ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0)),
        }
        for k, (p, n) in F.items():
            if k not in skip: self.face(p, hex_, a, n)

    def prism(self, cx, cz, y0, y1, r, n, hex_, skip_ends=False):
        """An n-sided column."""
        ring = [(cx + r * cos(2 * pi * i / n + pi / n), cz + r * sin(2 * pi * i / n + pi / n)) for i in range(n)]
        ins = (cx, (y0 + y1) / 2, cz)
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            self.face([(a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1])], hex_, 0.0, inside=ins)
        if not skip_ends: self.face([(p[0], y1, p[1]) for p in ring], hex_, 0.0, inside=ins)

    def cone(self, cx, cz, y0, y1, r0, r1, n, hex_, rot=0.0):
        """A tapering n-sided stack from radius r0 at y0 to r1 at y1 (r1 = 0 is a point)."""
        a = [(cx + r0 * cos(2 * pi * i / n + rot), cz + r0 * sin(2 * pi * i / n + rot)) for i in range(n)]
        b = [(cx + r1 * cos(2 * pi * i / n + rot), cz + r1 * sin(2 * pi * i / n + rot)) for i in range(n)]
        ins = (cx, (y0 + y1) / 2, cz)
        for i in range(n):
            j = (i + 1) % n
            if r1 < 0.001: self.face([(a[i][0], y0, a[i][1]), (a[j][0], y0, a[j][1]), (cx, y1, cz)], hex_, 0.0, inside=ins)
            else: self.face([(a[i][0], y0, a[i][1]), (a[j][0], y0, a[j][1]), (b[j][0], y1, b[j][1]), (b[i][0], y1, b[i][1])], hex_, 0.0, inside=ins)

    def to_object(self, name, coll):
        me = bpy.data.meshes.new(name)
        me.from_pydata([B(*p) for p in self.v], [], self.f)
        me.update()
        att = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        flat = []
        for poly, col in zip(me.polygons, self.c):
            for _ in range(poly.loop_total): flat.extend(col)
        att.data.foreach_set('color', flat)
        me.color_attributes.active_color = att
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        return ob


def vertex_ao(ob, rays=8, reach=3.0):
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=80, matrix=__import__('mathutils').Matrix.Translation((0, 0, -0.005)))
    tree = BVHTree.FromBMesh(bm); bm.free()
    rnd = random.Random(5)
    dirs = []
    for i in range(rays):
        u, v = (i + 0.5) / rays, rnd.random()
        r = sqrt(u); a = 2 * pi * v
        dirs.append((r * cos(a), r * sin(a), sqrt(max(0, 1 - u))))
    att = me.color_attributes['Col']
    for p in me.polygons:
        n = p.normal
        t = n.orthogonal().normalized(); b = n.cross(t)
        o = p.center + n * 0.02
        hit = 0.0
        for dx, dy, dz in dirs:
            d = t * dx + b * dy + n * dz
            loc, nn, idx, dist = tree.ray_cast(o, d, reach)
            if loc is not None: hit += 1 - dist / reach
        k = max(0.5, 1 - 0.75 * hit / rays)
        for li in p.loop_indices:
            c = att.data[li].color
            att.data[li].color = (c[0] * k, c[1] * k, c[2] * k, c[3])


class Wall:
    """Wall space: u along the wall, y up, o out of it. kind 'z' walls face +-z (u runs along x), kind 'x' walls face +-x."""
    def __init__(self, m, kind, plane, n):
        self.m, self.kind, self.plane, self.n = m, kind, plane, n

    def P(self, u, y, o):
        return (u, y, self.plane + o * self.n) if self.kind == 'z' else (self.plane + o * self.n, y, u)

    def N(self): return (0, 0, self.n) if self.kind == 'z' else (self.n, 0, 0)

    def quad(self, u0, u1, y0, y1, o, hex_, a=0.0):
        self.m.face([self.P(u0, y0, o), self.P(u1, y0, o), self.P(u1, y1, o), self.P(u0, y1, o)], hex_, a, self.N())

    def box(self, u0, u1, y0, y1, o0, o1, hex_, a=0.0, skip=''):
        if self.kind == 'z': self.m.box(u0, u1, y0, y1, self.plane + o0 * self.n, self.plane + o1 * self.n, hex_, a, skip)
        else: self.m.box(self.plane + o0 * self.n, self.plane + o1 * self.n, y0, y1, u0, u1, hex_, a, skip)

    def poly(self, pts, hex_, a=0.0):
        """pts of (u, y, o)."""
        self.m.face([self.P(*p) for p in pts], hex_, a, self.N())


def glass_alpha(m, lit):
    return m.rnd.uniform(0.55, 0.65) if lit else m.rnd.uniform(0.2, 0.33)


def window(W, lod, uc, y0, w, h, rows=3, lit=None):
    m = W.m
    if lit is None: lit = m.rnd.random() < 0.34
    ga = glass_alpha(m, lit)
    W.quad(uc - w / 2, uc + w / 2, y0, y0 + h, 0.03, GLASS, ga)
    if lod == 2: return
    W.box(uc - w / 2 - 0.2, uc + w / 2 + 0.2, y0 + h, y0 + h + 0.3, 0, 0.13, WHITE, skip='b')       # lintel
    W.box(uc - w / 2 - 0.25, uc + w / 2 + 0.25, y0 - 0.16, y0, 0, 0.2, WHITE, skip='b')               # sill
    if lod == 1: return
    for s in (-1, 1): W.box(uc + s * (w / 2 + 0.1) - 0.1, uc + s * (w / 2 + 0.1) + 0.1, y0, y0 + h, 0, 0.1, WHITE)  # casing
    W.box(uc - 0.04, uc + 0.04, y0, y0 + h, 0.03, 0.07, WHITE)
    for r in range(1, rows): yy = y0 + h * r / rows; W.box(uc - w / 2, uc + w / 2, yy - 0.04, yy + 0.04, 0.03, 0.07, WHITE)


def arch_window(W, lod, uc, y0, w, h, lit=None, surround=0.22):
    """A tall round-headed window."""
    m = W.m
    if lit is None: lit = m.rnd.random() < 0.3
    ga = glass_alpha(m, lit)
    r = w / 2; ys = y0 + h - r
    seg = 8 if lod == 0 else 5
    arc = [(uc - r * cos(pi * i / seg), ys + r * sin(pi * i / seg)) for i in range(seg + 1)]
    pts = [(uc - r, y0, 0.03), (uc + r, y0, 0.03)] + [(u, y, 0.03) for u, y in reversed(arc)]
    W.poly(pts, GLASS, ga)
    if lod == 2: return
    for s in (-1, 1): W.box(uc + s * (r + surround / 2) - surround / 2, uc + s * (r + surround / 2) + surround / 2, y0 - 0.1, ys, 0, 0.12, WHITE)
    W.box(uc - r - surround - 0.1, uc + r + surround + 0.1, y0 - 0.2, y0, 0, 0.2, WHITE, skip='b')
    for i in range(seg):
        a0, a1 = pi * i / seg, pi * (i + 1) / seg
        o0 = (uc - r * cos(a0), ys + r * sin(a0)); o1 = (uc - r * cos(a1), ys + r * sin(a1))
        q0 = (uc - (r + surround) * cos(a0), ys + (r + surround) * sin(a0)); q1 = (uc - (r + surround) * cos(a1), ys + (r + surround) * sin(a1))
        W.poly([(o0[0], o0[1], 0.1), (o1[0], o1[1], 0.1), (q1[0], q1[1], 0.1), (q0[0], q0[1], 0.1)], WHITE)
    if lod == 1: return
    W.box(uc - 0.04, uc + 0.04, y0, ys + r - 0.05, 0.03, 0.08, WHITE)
    for k in range(1, 5):
        yy = y0 + (ys - y0) * k / 5; W.box(uc - r, uc + r, yy - 0.035, yy + 0.035, 0.03, 0.08, WHITE)
    W.box(uc - r, uc + r, ys - 0.04, ys + 0.04, 0.03, 0.09, WHITE)


def disc(W, lod, uc, yc, r, hex_, a, o=0.05):
    n = 14 if lod == 0 else 8
    W.poly([(uc + r * cos(2 * pi * i / n), yc + r * sin(2 * pi * i / n), o) for i in range(n)], hex_, a)


def clock(W, lod, uc, yc, r, m):
    disc(W, lod, uc, yc, r, 0xf4f0e0, 0.6 if lod < 2 else 0.58, 0.08)
    if lod == 2: return
    disc(W, lod, uc, yc, r + 0.2, GOLD, 0.0, 0.05)
    disc(W, lod, uc, yc, r, 0xf4f0e0, 0.6, 0.08)
    if lod == 0:
        W.box(uc - 0.04, uc + 0.04, yc, yc + r * 0.85, 0.08, 0.12, 0x1c1c1c)
        W.box(uc - 0.04, uc + r * 0.6, yc - 0.04, yc + 0.04, 0.08, 0.13, 0x1c1c1c)
        for i in range(12):
            a = 2 * pi * i / 12
            W.box(uc + (r * 0.88) * sin(a) - 0.04, uc + (r * 0.88) * sin(a) + 0.04, yc + r * 0.88 * cos(a) - 0.04, yc + r * 0.88 * cos(a) + 0.04, 0.08, 0.12, 0x1c1c1c)


def facade(m, lod, kind, plane, n, u0, u1, y0, fh, floors, bays, skip=(), door=None, ww=1.3, wh=2.5, string=True):
    """A brick wall of `floors` storeys with a window per bay; the ground floor sits `y0` up."""
    W = Wall(m, kind, plane, n)
    W.quad(u0, u1, y0, y0 + fh * floors, 0, BRICK, 1.0)
    bw = (u1 - u0) / bays
    for f in range(floors):
        for b in range(bays):
            if (f, b) in skip: continue
            uc = u0 + (b + 0.5) * bw
            if door is not None and f == 0 and b == door: continue
            window(W, lod, uc, y0 + f * fh + 0.9 + (0.3 if f < floors - 1 else 0), ww, wh - (0.3 if f == floors - 1 else 0))
        if string and lod < 2 and f > 0: W.box(u0, u1, y0 + f * fh - 0.07, y0 + f * fh + 0.09, 0, 0.07, WHITE)
    return W


def cornice(m, x0, x1, z0, z1, y, lod, h=0.55, ov=0.4, col=WHITE):
    if lod == 2: ov = 0.3; h = 0.4
    m.box(x0 - ov, x1 + ov, y - h, y, z0 - ov, z1 + ov, col, skip='b')


def hip_roof(m, x0, x1, z0, z1, y, rise, col, ov=0.5):
    x0, x1, z0, z1 = x0 - ov, x1 + ov, z0 - ov, z1 + ov
    hd = min(x1 - x0, z1 - z0) / 2
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if (x1 - x0) >= (z1 - z0): rl, rr = (x0 + hd, cz), (x1 - hd, cz)
    else: rl, rr = (cx, z0 + hd), (cx, z1 - hd)
    ins = (cx, y + rise * 0.3, cz)
    c = [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]
    top = [(rl[0], y + rise, rl[1]), (rr[0], y + rise, rr[1])]
    if (x1 - x0) >= (z1 - z0):
        m.face([c[0], c[1], top[1], top[0]], col, inside=ins); m.face([c[2], c[3], top[0], top[1]], col, inside=ins)
        m.face([c[3], c[0], top[0]], col, inside=ins); m.face([c[1], c[2], top[1]], col, inside=ins)
    else:
        m.face([c[0], c[3], top[1], top[0]], col, inside=ins); m.face([c[1], c[2], top[1], top[0]], col, inside=ins)
        m.face([c[0], c[1], top[0]], col, inside=ins); m.face([c[2], c[3], top[1]], col, inside=ins)
    m.face(c, col, inside=(cx, y + 5, cz))


def gable_roof_z(m, x0, x1, z0, z1, y, rise, col, trim=True, ov=0.5, lod=0, front_brick=True):
    """A gable roof with its ridge along z and brick/white gable ends facing +z and -z."""
    xm = (x0 + x1) / 2
    a0, a1, b0, b1 = x0 - ov, x1 + ov, z0 - ov, z1 + ov
    ins = (xm, y + rise * 0.3, (z0 + z1) / 2)
    m.face([(a0, y - 0.25, b0), (a0, y - 0.25, b1), (xm, y + rise, b1), (xm, y + rise, b0)], col, inside=ins)
    m.face([(a1, y - 0.25, b0), (a1, y - 0.25, b1), (xm, y + rise, b1), (xm, y + rise, b0)], col, inside=ins)
    for z, s in ((z1, 1), (z0, -1)):
        m.face([(x0, y, z), (x1, y, z), (xm, y + rise * 0.96, z)], BRICK, 1.0, n=(0, 0, s))
        if trim and lod < 2:
            for sx in (-1, 1):
                ex = x0 - ov if sx < 0 else x1 + ov
                m.face([(ex, y - 0.25, z + s * 0.1), (ex + (0.35 if sx < 0 else -0.35), y - 0.25, z + s * 0.1), (xm, y + rise + 0.2, z + s * 0.1), (xm, y + rise - 0.15, z + s * 0.1)], WHITE, n=(0, 0, s))
            m.box(x0 - ov, x1 + ov, y - 0.45, y - 0.15, z + (0.0 if s > 0 else -0.5), z + (0.5 if s > 0 else 0.0), WHITE, skip='b')


def gable_roof_x(m, x0, x1, z0, z1, y, rise, col, ov=0.5):
    """Ridge along x, gable ends at x0 and x1."""
    zm = (z0 + z1) / 2
    a0, a1, b0, b1 = z0 - ov, z1 + ov, x0 - ov, x1 + ov
    ins = (b0 / 2 + b1 / 2, y + rise * 0.3, zm)
    m.face([(b0, y - 0.25, a0), (b1, y - 0.25, a0), (b1, y + rise, zm), (b0, y + rise, zm)], col, inside=ins)
    m.face([(b0, y - 0.25, a1), (b1, y - 0.25, a1), (b1, y + rise, zm), (b0, y + rise, zm)], col, inside=ins)
    for x, s in ((x0, -1), (x1, 1)):
        m.face([(x, y, z0), (x, y, z1), (x, y + rise * 0.96, zm)], BRICK, 1.0, n=(s, 0, 0))


def balustrade(m, lod, hs, y, post=0.18, step=0.55):
    m.box(-hs, hs, y + 0.8, y + 0.95, -hs, hs, WHITE, skip='b')
    m.box(-hs, hs, y, y + 0.12, -hs, hs, WHITE, skip='b')
    if lod == 2: return
    if lod == 1:
        for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)): m.box(sx * hs - 0.12, sx * hs + 0.12, y, y + 0.95, sz * hs - 0.12, sz * hs + 0.12, WHITE)
        return
    k = int(2 * hs / step)
    for i in range(k + 1):
        t = -hs + 2 * hs * i / k
        for (px, pz) in ((t, -hs), (t, hs), (-hs, t), (hs, t)):
            m.box(px - post / 2, px + post / 2, y + 0.12, y + 0.8, pz - post / 2, pz + post / 2, WHITE, skip='tb')


def column(m, lod, cx, cz, y0, y1, r):
    n = (14, 8, 4)[lod]
    m.box(cx - r * 1.4, cx + r * 1.4, y0, y0 + 0.35, cz - r * 1.4, cz + r * 1.4, WHITE)
    m.prism(cx, cz, y0 + 0.35, y1 - 0.4, r, n, WHITE, skip_ends=True)
    m.box(cx - r * 1.5, cx + r * 1.5, y1 - 0.4, y1, cz - r * 1.5, cz + r * 1.5, WHITE)


def pediment(m, lod, xc, hw, y, rise, z_front, depth, lit_round=True):
    """A white triangular pediment on a cornice, facing +z, with a round window in the tympanum."""
    m.box(xc - hw - 0.3, xc + hw + 0.3, y, y + 0.35, z_front - depth - 0.3, z_front + 0.3, WHITE, skip='b')
    ins = (xc, y + rise / 2, z_front - depth / 2)
    for z, s in ((z_front + 0.2, 1), (z_front - depth, -1)):
        m.face([(xc - hw, y + 0.35, z), (xc + hw, y + 0.35, z), (xc, y + 0.35 + rise, z)], WHITE, n=(0, 0, s))
    for s in (-1, 1):
        m.face([(xc + s * hw, y + 0.35, z_front + 0.3), (xc, y + 0.35 + rise, z_front + 0.3), (xc, y + 0.35 + rise, z_front - depth), (xc + s * hw, y + 0.35, z_front - depth)], 0xe9e5d8, inside=ins)
    if lod < 2:
        Wl = Wall(m, 'z', z_front + 0.2, 1)
        disc(Wl, lod, xc, y + 0.35 + rise * 0.38, min(0.8, rise * 0.28), DARK if not lit_round else GLASS, 0.6 if lit_round else 0.25, 0.04)
        disc(Wl, lod, xc, y + 0.35 + rise * 0.38, min(0.8, rise * 0.28) + 0.18, WHITE, 0.0, 0.02)


def portico(m, lod, xc, hw, zw, depth, y, h, ncol, cr, rise):
    """Columns across the front of a wall at z = zw, standing `depth` out, floor at y, columns h tall."""
    zf = zw + depth - cr * 1.6
    m.box(xc - hw - 0.4, xc + hw + 0.4, y - 0.12, y, zw, zw + depth + 0.5, GRANITE)
    for i in range(ncol):
        column(m, lod, xc - hw + 0.6 + i * (2 * hw - 1.2) / (ncol - 1), zf, y, y + h, cr)
    m.box(xc - hw - 0.2, xc + hw + 0.2, y + h, y + h + 0.9, zw, zw + depth + 0.1, WHITE, skip='b')
    pediment(m, lod, xc, hw + 0.2, y + h + 0.9, rise, zw + depth + 0.1, depth)
    if lod < 2:
        m.box(xc - hw, xc + hw, y + h - 0.02, y + h, zw, zw + depth, 0xd9d3c4)   # soffit


def steps(m, lod, xc, hw, y, z0, n, tread, riser, col=GRANITE):
    for i in range(n):
        zz = z0 + i * tread
        m.box(xc - hw - 0.1 * i, xc + hw + 0.1 * i, -9.0, y - i * riser - riser, zz, zz + tread + 0.02, col, skip='b')


def tower_stack(m, lod, tx, tz, y_base, s_brick, y_brick_top, big):
    """The clock tower: brick shaft, white clock stage, balustrade, belfry, lantern, spire."""
    H = lambda s: s / 2
    hb = H(s_brick)
    m.box(tx - hb, tx + hb, y_base, y_brick_top, tz - hb, tz + hb, BRICK, 1.0, skip='b')
    # brick shaft windows and a white doorcase window on the front
    if lod < 2:
        for kind, plane, n, ucen in (('z', tz + hb, 1, tx), ('z', tz - hb, -1, tx), ('x', tx + hb, 1, tz), ('x', tx - hb, -1, tz)):
            Wt = Wall(m, kind, plane, n)
            window(Wt, lod, ucen, y_brick_top - 6.4, 1.4, 2.6, rows=3, lit=True)
    m.box(tx - hb - 0.4, tx + hb + 0.4, y_brick_top, y_brick_top + 0.7, tz - hb - 0.4, tz + hb + 0.4, WHITE, skip='b')
    y = y_brick_top + 0.7
    s1 = s_brick * 0.78; h1 = s1 / 2; y1 = y + (7.0 if big else 5.5)
    m.box(tx - h1, tx + h1, y, y1, tz - h1, tz + h1, WHITE, skip='b')
    for kind, plane, n, ucen in (('z', tz + h1, 1, tx), ('z', tz - h1, -1, tx), ('x', tx + h1, 1, tz), ('x', tx - h1, -1, tz)):
        Wt = Wall(m, kind, plane, n)
        if big: clock(Wt, lod, ucen, y + 3.7, 1.45, m)
        else: arch_window(Wt, lod, ucen, y + 1.0, 1.4, 3.2, lit=True, surround=0.18)
        if lod < 2:
            for s in (-1, 1): Wt.box(ucen + s * (h1 - 0.15) - 0.15, ucen + s * (h1 - 0.15) + 0.15, y, y1, 0, 0.12, WHITE)
    m.box(tx - h1 - 0.45, tx + h1 + 0.45, y1, y1 + 0.6, tz - h1 - 0.45, tz + h1 + 0.45, WHITE, skip='b')
    y = y1 + 0.6
    if big:
        balustrade(m, lod, h1 + 0.35, y, 0.18, 0.5) if False else None
    # belfry
    s2 = s1 * 0.72; h2 = s2 / 2; y2 = y + (5.0 if big else 4.2)
    m.box(tx - h2, tx + h2, y, y2, tz - h2, tz + h2, WHITE, skip='b')
    for kind, plane, n, ucen in (('z', tz + h2, 1, tx), ('z', tz - h2, -1, tx), ('x', tx + h2, 1, tz), ('x', tx - h2, -1, tz)):
        Wt = Wall(m, kind, plane, n)
        arch_window(Wt, lod, ucen, y + 0.9, 1.15, 3.2 if big else 2.6, lit=False, surround=0.16)
    m.box(tx - h2 - 0.35, tx + h2 + 0.35, y2, y2 + 0.5, tz - h2 - 0.35, tz + h2 + 0.35, WHITE, skip='b')
    y = y2 + 0.5
    # lantern
    s3 = s2 * 0.66; h3 = s3 / 2; y3 = y + 2.6
    if lod == 2: m.box(tx - h3, tx + h3, y, y3, tz - h3, tz + h3, WHITE, skip='b')
    else:
        for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)): m.box(tx + sx * h3 - 0.14, tx + sx * h3 + 0.14, y, y3, tz + sz * h3 - 0.14, tz + sz * h3 + 0.14, WHITE)
        m.box(tx - h3, tx + h3, y + 0.5, y3 - 0.4, tz - h3, tz + h3, DARK, 0.58)
    m.box(tx - h3 - 0.3, tx + h3 + 0.3, y3, y3 + 0.4, tz - h3 - 0.3, tz + h3 + 0.3, WHITE, skip='b')
    y = y3 + 0.4
    n = 8 if lod < 2 else 4
    top = y + (9.0 if big else 14.0)
    if big:
        m.cone(tx, tz, y, y + 1.6, h3 * 1.35, h3 * 1.0, n, SPIRE, pi / n)
        m.cone(tx, tz, y + 1.6, y + 3.6, h3 * 1.0, h3 * 0.55, n, SPIRE, pi / n)
        m.cone(tx, tz, y + 3.6, top, h3 * 0.55, 0.0, n, SPIRE, pi / n)
    else:
        m.cone(tx, tz, y, top, h3 * 1.3, 0.0, n, SPIRE, pi / n)
    m.box(tx - 0.05, tx + 0.05, top - 0.6, top + 2.2, tz - 0.05, tz + 0.05, GOLD)
    if lod < 2 and big: m.box(tx - 0.7, tx + 0.7, top + 1.4, top + 1.5, tz - 0.03, tz + 0.03, GOLD)
    return top + 2.2


def library(lod):
    m = Mesh(11)
    FH, Y0, FL = 4.2, 0.5, 3
    ey = Y0 + FH * FL                   # eaves
    mx0, mx1, mz0, mz1 = -10.8, 8.45, -7.9, 7.9
    # footings and plinth
    m.box(mx0 - 0.3, mx1 + 0.3, -9.0, Y0, mz0 - 0.3, mz1 + 0.3, GRANITE)
    for (x0, x1, z0, z1) in ((8.45, 13.35, -0.1, 13.2), (-15.16, -10.76, 0.09, 13.39)): m.box(x0 - 0.3, x1 + 0.3, -9.0, Y0, z0 - 0.3, z1 + 0.3, GRANITE)
    # main block (front +z, back -z, ends)
    facade(m, lod, 'z', mz1, 1, mx0, mx1, Y0, FH, FL, 8, skip={(0, 5), (1, 5), (0, 4), (0, 3)} if False else set(), door=None)
    facade(m, lod, 'z', mz0, -1, mx0, mx1, Y0, FH, FL, 8)
    m.face([(mx0, Y0, mz0), (mx0, Y0, mz1), (mx0, ey, mz1), (mx0, ey, mz0)], BRICK, 1.0, n=(-1, 0, 0))
    cornice(m, mx0, mx1, mz0, mz1, ey, lod)
    hip_roof(m, mx0, mx1, mz0, mz1, ey, 3.0, GREEN)
    # the entrance: pilastered doorway under the portico
    Wd = Wall(m, 'z', mz1, 1)
    Wd.quad(-1.3, 1.3, Y0, Y0 + 3.4, 0.04, 0x243a30)
    Wd.box(-1.6, 1.6, Y0 + 3.4, Y0 + 3.8, 0, 0.2, WHITE)
    if lod < 2:
        for s in (-1, 1): Wd.box(s * 1.45 - 0.15, s * 1.45 + 0.15, Y0, Y0 + 3.4, 0, 0.14, WHITE)
    Wd.quad(-1.1, 1.1, Y0 + 3.9, Y0 + 5.2, 0.05, GLASS, 0.6)
    # the portico: four columns two storeys tall, a pediment, granite steps
    portico(m, lod, 0.0, 4.6, mz1, 3.4, Y0, 8.6, 4, 0.5, 2.6)
    steps(m, lod, 0.0, 5.0, Y0, mz1 + 3.5, 22, 0.55, 0.16)
    # end pavilions that project to the front, gable ends to us
    for (x0, x1, z0, z1, inner) in ((8.45, 13.35, -0.1, 13.2, -1), (-15.16, -10.76, 0.09, 13.39, 1)):
        outer = 1 if inner < 0 else -1
        xm = (x0 + x1) / 2
        facade(m, lod, 'z', z1, 1, x0, x1, Y0, FH, FL, 3 if (x1 - x0) > 4.6 else 3, ww=1.1, wh=2.4)
        facade(m, lod, 'z', z0, -1, x0, x1, Y0, FH, FL, 3, ww=1.1, wh=2.4)
        if outer > 0: facade(m, lod, 'x', x1, 1, z0, z1, Y0, FH, FL, 4)
        else: facade(m, lod, 'x', x0, -1, z0, z1, Y0, FH, FL, 4)
        # the courtyard side
        if outer > 0: facade(m, lod, 'x', x0, -1, mz1, z1, Y0, FH, FL, 2)
        else: facade(m, lod, 'x', x1, 1, mz1, z1, Y0, FH, FL, 2)
        cornice(m, x0, x1, z0, z1, ey, lod, ov=0.3)
        gable_roof_z(m, x0, x1, z0, z1, ey, 3.6, GREEN, True, 0.5, lod)
        Wg = Wall(m, 'z', z1, 1)
        disc(Wg, lod, xm, ey + 1.6, 0.55, GLASS, 0.6, 0.04)
        if lod < 2: disc(Wg, lod, xm, ey + 1.6, 0.74, WHITE, 0.0, 0.02)
        # chimney
        m.box(xm - 0.5, xm + 0.5, ey, ey + 6.4, z0 + 0.8, z0 + 1.9, 0x9a4033, 1.0)
    # the tower
    top = tower_stack(m, lod, 0.0, 1.0, ey - 2.0, 6.2, ey + 10.0, True)
    return m, {'top': top, 'eaves': ey}


def chapel(lod):
    m = Mesh(23)
    NX, NZ0, NZ1 = 3.85, -10.45, 10.45
    BASE, EY = 2.2, 11.7
    # fieldstone base the nave stands on, with steps down the front
    m.box(-NX - 1.0, NX + 1.0, -9.0, BASE, NZ0 - 0.5, NZ1 + 3.6, STONE)
    steps(m, lod, 0.0, 4.4, BASE, NZ1 + 3.6, 20, 0.55, 0.3, STONE)
    # nave walls
    W = [Wall(m, 'x', NX, 1), Wall(m, 'x', -NX, -1)]
    for w in W:
        w.quad(NZ0, NZ1, BASE, EY, 0, BRICK, 1.0)
        for i in range(5):
            zc = NZ0 + 2.8 + i * (NZ1 - NZ0 - 5.6) / 4
            arch_window(w, lod, zc, BASE + 1.7, 1.55, 6.0)
            if lod < 2: w.box(zc - 0.15 - 0.55, zc + 0.15 + 0.55, 0, 0, 0, 0, WHITE) if False else None
        if lod < 2: w.box(NZ0, NZ1, EY - 0.2, EY, 0, 0.12, WHITE)
        if lod < 2:
            for zb in (NZ0 + 0.0, NZ1 - 0.0): pass
    Wb = Wall(m, 'z', NZ0, -1)
    Wb.quad(-NX, NX, BASE, EY, 0, BRICK, 1.0)
    arch_window(Wb, lod, 0.0, BASE + 2.2, 2.4, 7.2, surround=0.28)
    Wf = Wall(m, 'z', NZ1, 1)
    Wf.quad(-NX, NX, BASE, EY, 0, BRICK, 1.0)
    cornice(m, -NX, NX, NZ0, NZ1, EY, lod, ov=0.45)
    gable_roof_z(m, -NX, NX, NZ0, NZ1, EY, 3.4, SLATE, True, 0.5, lod)
    # the front doorway under the portico, flanked by two small windows and a lit window above
    Wf.quad(-1.0, 1.0, BASE, BASE + 3.3, 0.05, 0x2a2a2e)
    Wf.box(-1.25, 1.25, BASE + 3.3, BASE + 3.8, 0, 0.2, WHITE)
    if lod < 2:
        for s in (-1, 1): Wf.box(s * 1.2 - 0.12, s * 1.2 + 0.12, BASE, BASE + 3.3, 0, 0.14, WHITE)
    window(Wf, lod, 0.0, BASE + 4.6, 1.2, 2.3, rows=3, lit=True)
    for s in (-1, 1):
        window(Wf, lod, s * 2.7, BASE + 0.9, 0.9, 2.0, rows=3)
        window(Wf, lod, s * 2.7, BASE + 5.2, 0.9, 2.0, rows=3)
    portico(m, lod, 0.0, 3.55, NZ1, 3.0, BASE, 8.4, 4, 0.52, 2.4)
    # the vestry wing on the south side, west end
    vx0, vx1, vz0, vz1, vy = NX, NX + 7.6, 5.3, 9.9, BASE + 6.2
    m.box(vx0 - 0.2, vx1 + 0.2, -9.0, BASE, vz0 - 0.2, vz1 + 0.2, STONE)
    Wvx = Wall(m, 'x', vx1, 1); Wvx.quad(vz0, vz1, BASE, vy, 0, BRICK, 1.0)
    Wvf = Wall(m, 'z', vz1, 1); Wvf.quad(vx0, vx1, BASE, vy, 0, BRICK, 1.0)
    Wvb = Wall(m, 'z', vz0, -1); Wvb.quad(vx0, vx1, BASE, vy, 0, BRICK, 1.0)
    for uc in (vx0 + 2.0, vx0 + 5.6):
        window(Wvf, lod, uc, BASE + 1.4, 1.1, 2.6, rows=3); window(Wvb, lod, uc, BASE + 1.4, 1.1, 2.6, rows=3)
    window(Wvx, lod, (vz0 + vz1) / 2, BASE + 1.4, 1.1, 2.6, rows=3)
    cornice(m, vx0, vx1, vz0, vz1, vy, lod, h=0.4, ov=0.3)
    gable_roof_x(m, vx0, vx1, vz0, vz1, vy, 2.2, SLATE, 0.4)
    m.box(vx1 - 1.2, vx1 - 0.2, vy, vy + 4.4, vz0 + 0.5, vz0 + 1.5, 0x9a4033, 1.0)
    # the tower rising behind the pediment
    top = tower_stack(m, lod, 0.0, 4.6, EY - 2.0, 4.8, EY + 8.0, False)
    return m, {'top': top, 'eaves': EY}


def export(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs: ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=True, export_tangents=False, export_materials='NONE',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False,
                              export_skins=False, export_morph=False, export_extras=False, export_image_format='NONE')
    return round(os.path.getsize(path) / 1000)


def main():
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True)
    allo, far, stats, meta = [], [], {}, {}
    for ci, (name, fn) in enumerate((('library', library), ('chapel', chapel))):
        for lod in (0, 1, 2):
            m, mt = fn(lod)
            ob = m.to_object(f'{name}_{lod}', coll)
            ob.location = (ci * 60 - 15, -lod * 50, 0)
            vertex_ao(ob, rays=10 if lod == 0 else 6, reach=3.0)
            allo.append(ob)
            if lod > 0: far.append(ob)
            stats[f'{name}_{lod}'] = len(m.f)
            meta[name] = mt
            try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
            except Exception: pass
    out = {'faces': stats, 'meta': meta}
    out['hero_kB'] = export(allo, os.path.join(OUT, 'campus_hero.glb'))
    out['far_kB'] = export(far, os.path.join(OUT, 'campus_hero_far.glb'))
    print('CAMPUS_STATS ' + json.dumps(out))
    os.makedirs(os.path.join(ROOT, 'scratch', 'campus2'), exist_ok=True)
    with open(os.path.join(ROOT, 'scratch', 'campus2', 'hero_meta.json'), 'w') as fh: json.dump(out, fh, indent=1)


main()
if '--stay' not in FLAGS:
    sys.stdout.flush()
    os._exit(0)
