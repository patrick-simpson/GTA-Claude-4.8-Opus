# Tepid Falls' houses, modelled in Blender by script and exported as .glb: the neighbourhood kit
# (the brief: tools/briefs/tepid-waterville.md; the types follow Waterville, Maine's housing: the South End and North End
# triple-deckers with stacked porches, capes, gable-fronts in clapboard or vinyl, Victorians with turrets near downtown,
# corner stores, detached garages and sheds. No real names anywhere.)
#
#   "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" --factory-startup --python tools/blender/houses.py
#   (with its window showing, never --background: the owner watches the screen; `--stay` keeps the window open afterwards)
#
# Writes, in public/models (BLD_OUT overrides the folder for a trial):
#   houses.glb      every design at three levels of detail, and both hands: <name>_<lod> and <name>m_<lod> (the mirror image, since
#                   an instanced mesh cannot take a negative scale). lod 0 near (window casings and muntins, porch balusters,
#                   brackets, storm doors, dishes, chimneys with caps), lod 1 street (casings, rails as bars), lod 2 far (the
#                   box, roof, porch slabs and window quads). Props: car0, car1, car2 (white body: the game tints it), mailbox.
#   houses_far.glb  the lod 2 meshes and the props: the whole file phones and the low preset fetch.
#   clap_bc.webp / clap_bn.webp   clapboard siding: colour (grey: the paint is the vertex colour) and normals, one tile of
#                   TILE m by TILE m with 8 boards, made here by numpy; nothing is taken from a photograph.
#
# Frame (the game's, as buildings.py): x along the frontage, left to right seen from the street; y up (0 = the top of the
# footing: the game sinks it 1 m); z out of the front wall toward the street. Front wall on z = 0, body back to z = -D.
# Vertex colour (linear) is the albedo. Its ALPHA says what the face is:
#   1.0          clapboard / siding: the game lays clap_bc / clap_bn over it in meters from position and normal
#   0.0          anything else that is not glass (trim, roofing, concrete, metal)
#   0.20 - 0.35  window glass by day, dark; 0.55 - 0.65 a lit window: the game turns these into lamps at night.

import bpy, bmesh, sys, os, json, random
from math import sin, cos, pi, atan2, sqrt, radians
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.environ.get('BLD_OUT') or os.path.join(ROOT, 'public', 'models')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FLAGS = {a for a in ARGS if a.startswith('--')}
TILE = 1.12


def lin(hex_):
    c = [((hex_ >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def B(x, y, z): return (x, -z, y)


def shade(hex_, k):
    r, g, b = [min(255, int(((hex_ >> s) & 255) * k)) for s in (16, 8, 0)]
    return (r << 16) | (g << 8) | b


class Mesh:
    def __init__(self, seed=1):
        self.v, self.f, self.c = [], [], []
        self.rnd = random.Random(seed)

    def face(self, pts, hex_, a=0.0, n=None):
        if n is not None and len(pts) >= 3:
            p0, p1, p2 = (Vector(p) for p in pts[:3])
            cr = (p1 - p0).cross(p2 - p0)
            if cr.length < 1e-12 and len(pts) > 3: cr = (p2 - p0).cross(Vector(pts[3]) - p0)
            if cr.dot(Vector(n)) < 0: pts = pts[::-1]
        i = len(self.v)
        self.v.extend(pts)
        self.f.append(list(range(i, i + len(pts))))
        col = lin(hex_) if isinstance(hex_, int) else hex_
        if a == 1.0:
            j = 0.94 + 0.12 * self.rnd.random()
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

    def mirrored(self, w):
        o = Mesh()
        o.v = [(w - x, y, z) for x, y, z in self.v]
        o.f = [f[::-1] for f in self.f]
        o.c = list(self.c)
        return o

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


def vertex_ao(ob, rays=10, reach=2.5):
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60, matrix=__import__('mathutils').Matrix.Translation((0, 0, -0.005)))
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
        k = max(0.45, 1 - 0.8 * hit / rays)
        for li in p.loop_indices:
            c = att.data[li].color
            att.data[li].color = (c[0] * k, c[1] * k, c[2] * k, c[3])


# ── Wall space: u along the wall, y up, o out of it ──────────────────────────

class Wall:
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


GLASS_D, GLASS_L = 0x4d6072, 0x4d6072   # the day colour of glass (the sky in it); a lit window differs by its alpha alone


def window(W, lod, uc, y0, w, h, trim, rnd, rows=2, cols=1, lit=None, shutters=None, sill=True):
    """A double-hung (or fixed) window centred on uc, its sill at y0."""
    if lit is None: lit = rnd.random() < 0.38
    ga = rnd.uniform(0.55, 0.65) if lit else rnd.uniform(0.2, 0.33)
    gh = GLASS_L if lit else GLASS_D
    u0, u1 = uc - w / 2, uc + w / 2
    if lod == 2:
        W.quad(u0, u1, y0, y0 + h, 0.03, gh, ga); return
    W.quad(u0, u1, y0, y0 + h, 0.02, gh, ga)
    c = 0.09
    if lod == 1:
        for (a, b, c0, c1) in ((u0 - c, u0, y0 - c, y0 + h + c), (u1, u1 + c, y0 - c, y0 + h + c), (u0, u1, y0 + h, y0 + h + c)):
            W.quad(a, b, c0, c1, 0.05, trim)
        if sill: W.quad(u0 - c, u1 + c, y0 - c, y0, 0.07, trim)
    else:
        W.box(u0 - c, u0, y0 - c, y0 + h + c, 0, 0.07, trim, skip='k')
        W.box(u1, u1 + c, y0 - c, y0 + h + c, 0, 0.07, trim, skip='k')
        W.box(u0 - c, u1 + c, y0 + h, y0 + h + c, 0, 0.09, trim, skip='k')
        if sill: W.box(u0 - c - 0.03, u1 + c + 0.03, y0 - c - 0.03, y0, 0, 0.14, trim, skip='k')
        # sash rails and muntins
        mt = 0.035
        W.box(u0, u1, y0 + h / 2 - 0.04, y0 + h / 2 + 0.04, 0.02, 0.06, trim, skip='k')
        for i in range(1, cols):
            uu = u0 + w * i / cols
            W.box(uu - mt / 2, uu + mt / 2, y0, y0 + h, 0.02, 0.05, trim, skip='k')
        for i in range(1, rows):
            yy = y0 + h * i / rows
            if abs(yy - (y0 + h / 2)) > 0.05: W.box(u0, u1, yy - mt / 2, yy + mt / 2, 0.02, 0.05, trim, skip='k')
    if shutters and lod < 2:
        sw = w * 0.42
        for s0, s1 in ((u0 - 0.1 - sw, u0 - 0.1), (u1 + 0.1, u1 + 0.1 + sw)):
            if lod == 0:
                W.box(s0, s1, y0 - 0.05, y0 + h + 0.05, 0, 0.05, shutters, skip='k')
                for k in range(1, 6): W.quad(s0 + 0.04, s1 - 0.04, y0 + (h + 0.1) * k / 6 - 0.05, y0 + (h + 0.1) * k / 6 - 0.01, 0.06, shade(shutters, 0.65))
            else: W.box(s0, s1, y0 - 0.05, y0 + h + 0.05, 0, 0.05, shutters, skip='k')


def door(W, lod, uc, y0, trim, hex_, storm=True, w=0.95, h=2.05, lit_glass=False):
    u0, u1 = uc - w / 2, uc + w / 2
    if lod == 2:
        W.quad(u0, u1, y0, y0 + h, 0.03, hex_); return
    W.box(u0, u1, y0, y0 + h, 0, 0.06, hex_, skip='k')
    c = 0.1
    if lod == 0:
        W.box(u0 - c, u0, y0, y0 + h + c, 0, 0.09, trim, skip='k'); W.box(u1, u1 + c, y0, y0 + h + c, 0, 0.09, trim, skip='k')
        W.box(u0 - c, u1 + c, y0 + h, y0 + h + c, 0, 0.1, trim, skip='k')
        W.quad(u0 + 0.14, u1 - 0.14, y0 + 1.15, y0 + 1.85, 0.075, GLASS_L if lit_glass else GLASS_D, 0.6 if lit_glass else 0.28)
        W.box(u0 + 0.12, u1 - 0.12, y0 + 0.2, y0 + 0.95, 0.065, 0.08, shade(hex_, 0.8), skip='k')
        W.box(u1 - 0.16, u1 - 0.1, y0 + 0.95, y0 + 1.05, 0.06, 0.13, 0xb7a56b, skip='k')   # knob
        if storm:
            W.box(u0 - 0.03, u1 + 0.03, y0, y0 + h, 0.11, 0.14, 0xe6e6e1, skip='k')
            W.quad(u0 + 0.06, u1 - 0.06, y0 + 0.75, y0 + 1.95, 0.145, 0x1a2630, 0.26)
    else:
        W.box(u0 - c, u1 + c, y0, y0 + h + c, 0, 0.04, trim, skip='k')
        W.quad(u0, u1, y0, y0 + h, 0.065, hex_)


# ── Roofs, porches, bits ─────────────────────────────────────────────────────

def clapboard_tri(m, pts, hex_):
    m.face(pts, hex_, 1.0, None)


def roof_x(m, lod, x0, x1, zb, zf, y, rise, ov, roof, wall, fascia, gable_ends=True):
    """Ridge along x. Eaves at height y on the z = zb and z = zf sides."""
    zc = (zb + zf) / 2
    half = (zf - zb) / 2
    drop = ov * rise / half
    ya, yb = y - drop, y + rise
    xa, xb = x0 - ov, x1 + ov
    m.face([(xa, ya, zf + ov), (xb, ya, zf + ov), (xb, yb, zc), (xa, yb, zc)], roof, 0.0, (0, 1, 0.8))
    m.face([(xb, ya, zb - ov), (xa, ya, zb - ov), (xa, yb, zc), (xb, yb, zc)], roof, 0.0, (0, 1, -0.8))
    if gable_ends:
        for x, nx in ((x0, -1), (x1, 1)):
            m.face([(x, y, zb), (x, y, zf), (x, yb, zc)], wall, 1.0, (nx, 0, 0))
            if lod < 2:
                m.face([(x + nx * ov, ya, zb - ov), (x + nx * ov, ya, zf + ov), (x + nx * ov, yb, zc)], fascia, 0.0, (nx, 0, 0)) if False else None
        if lod < 2:
            # rake boards and soffit
            for z, sg in ((zf, 1), (zb, -1)):
                m.box(xa, xb, ya - 0.14, ya + 0.02, z + sg * ov - 0.04 * sg, z + sg * ov + 0.02 * sg, fascia, skip='')
    if lod == 0:
        m.box(x0 - 0.05, x1 + 0.05, yb - 0.02, yb + 0.1, zc - 0.12, zc + 0.12, shade(roof, 0.8))
        for k in range(1, 7):                               # shingle courses as dark lines
            f = k / 7
            for z, sg in ((zf, 1), (zb, -1)):
                zz = zc + (z + sg * ov - zc) * f
                yy = yb + (ya - yb) * f
                m.face([(xa, yy + 0.01, zz), (xb, yy + 0.01, zz), (xb, yy + 0.02, zz - sg * 0.04), (xa, yy + 0.02, zz - sg * 0.04)], shade(roof, 0.72), 0.0, (0, 1, 0.3 * sg))


def roof_z(m, lod, x0, x1, zb, zf, y, rise, ov, roof, wall, fascia):
    """Ridge along z (the gable faces the street)."""
    xc = (x0 + x1) / 2
    half = (x1 - x0) / 2
    drop = ov * rise / half
    ya, yb = y - drop, y + rise
    za, zz = zb - ov, zf + ov
    m.face([(x0 - ov, ya, za), (x0 - ov, ya, zz), (xc, yb, zz), (xc, yb, za)], roof, 0.0, (-0.8, 1, 0))
    m.face([(x1 + ov, ya, zz), (x1 + ov, ya, za), (xc, yb, za), (xc, yb, zz)], roof, 0.0, (0.8, 1, 0))
    m.face([(x0, y, zf), (x1, y, zf), (xc, yb, zf)], wall, 1.0, (0, 0, 1))
    m.face([(x1, y, zb), (x0, y, zb), (xc, yb, zb)], wall, 1.0, (0, 0, -1))
    if lod < 2:
        for x, sg in ((x0, -1), (x1, 1)):
            m.box(x + sg * ov - 0.04 * sg - 0.04, x + sg * ov + 0.04 * sg + 0.0, ya - 0.14, ya + 0.02, za, zz, fascia)
        # bargeboards on the gable face
        m.face([(x0 - ov, ya, zz), (xc, yb, zz), (xc, yb - 0.14, zz), (x0 - ov, ya - 0.14, zz)], fascia, 0.0, (0, 0, 1))
        m.face([(xc, yb, zz), (x1 + ov, ya, zz), (x1 + ov, ya - 0.14, zz), (xc, yb - 0.14, zz)], fascia, 0.0, (0, 0, 1))
    if lod == 0:
        m.box(xc - 0.12, xc + 0.12, yb - 0.02, yb + 0.1, za, zz, shade(roof, 0.8))


def hip_roof(m, lod, x0, x1, zb, zf, y, rise, ov, roof, fascia):
    xa, xb, za, zz = x0 - ov, x1 + ov, zb - ov, zf + ov
    zc = (zb + zf) / 2
    s = (zf - zb) / 2
    r0, r1 = x0 + s, x1 - s
    if r1 < r0: r0 = r1 = (x0 + x1) / 2
    yb = y + rise
    ya = y - ov * rise / s
    m.face([(xa, ya, zz), (xb, ya, zz), (r1, yb, zc), (r0, yb, zc)], roof, 0.0, (0, 1, 0.8))
    m.face([(xb, ya, za), (xa, ya, za), (r0, yb, zc), (r1, yb, zc)], roof, 0.0, (0, 1, -0.8))
    m.face([(xa, ya, za), (xa, ya, zz), (r0, yb, zc)], roof, 0.0, (-0.8, 1, 0))
    m.face([(xb, ya, zz), (xb, ya, za), (r1, yb, zc)], roof, 0.0, (0.8, 1, 0))
    if lod < 2:
        m.box(xa, xb, ya - 0.13, ya + 0.02, za, za + 0.05, fascia); m.box(xa, xb, ya - 0.13, ya + 0.02, zz - 0.05, zz, fascia)
        m.box(xa, xa + 0.05, ya - 0.13, ya + 0.02, za, zz, fascia); m.box(xb - 0.05, xb, ya - 0.13, ya + 0.02, za, zz, fascia)


def shed_roof(m, x0, x1, z0, z1, y0, y1, roof, fascia, lod):
    """A single slope from y0 at z1 (the low edge, front) up to y1 at z0."""
    m.face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z0), (x0, y1, z0)], roof, 0.0, (0, 1, 0.3))
    if lod < 2:
        m.box(x0, x1, y0 - 0.12, y0 + 0.02, z1 - 0.03, z1 + 0.02, fascia)
        m.box(x0, x1, y0 - 0.02, y0 + 0.0, z0, z1, shade(roof, 0.5)) if False else None


def chimney(m, lod, x, z, y0, y1, w=0.75, d=0.95, hex_=0x8a4a3a):
    m.box(x - w / 2, x + w / 2, y0, y1, z - d / 2, z + d / 2, hex_)
    if lod < 2:
        m.box(x - w / 2 - 0.06, x + w / 2 + 0.06, y1, y1 + 0.1, z - d / 2 - 0.06, z + d / 2 + 0.06, 0xb9b5ab)
        if lod == 0: m.box(x - 0.15, x + 0.15, y1 + 0.1, y1 + 0.22, z - 0.2, z + 0.2, 0x2a2a2a)


def porch(m, lod, x0, x1, depth, y, h, trim, deck_hex, rails=True, roof_hex=None, stairs=None, post=0.13, rail_h=0.95, closed_roof=True, spindles=False):
    """A porch deck at height y with posts to y + h, in front of the wall (z = 0): from x0 to x1, depth out. A roof slab on top."""
    m.box(x0, x1, y - 0.14, y, 0, depth, deck_hex, skip='b')
    if lod < 2:
        m.box(x0, x1, y - 0.5, y - 0.14, depth - 0.05, depth, shade(trim, 0.85))        # skirt/fascia
    n = max(2, int((x1 - x0) / 2.6) + 1)
    for i in range(n + 1):
        x = x0 + 0.08 + (x1 - x0 - 0.16 - post) * i / n
        if lod == 2 and 0 < i < n: continue
        m.box(x, x + post, y, y + h, depth - post - 0.04, depth - 0.04, trim)
    if rails and lod < 2:
        m.box(x0, x1, y + rail_h - 0.06, y + rail_h, depth - 0.12, depth - 0.02, trim)
        m.box(x0, x1, y + 0.1, y + 0.18, depth - 0.12, depth - 0.02, trim)
        for sx in (x0, x1 - 0.12):
            m.box(sx, sx + 0.12, y, y + rail_h, 0.0, depth, trim, skip='') if False else None
        if lod == 0:
            k = int((x1 - x0) / 0.15)
            for i in range(1, k):
                x = x0 + (x1 - x0) * i / k
                m.box(x - 0.025, x + 0.025, y + 0.18, y + rail_h - 0.06, depth - 0.09, depth - 0.05, trim)
            for z in (0.3, depth - 0.3):
                pass
            # side rails
            for sx in (x0, x1 - 0.04):
                m.box(sx, sx + 0.04, y + rail_h - 0.06, y + rail_h, 0.1, depth - 0.1, trim)
        else:
            m.box(x0, x1, y + 0.18, y + rail_h - 0.06, depth - 0.1, depth - 0.07, shade(trim, 0.9))
    if closed_roof:
        m.box(x0 - 0.1, x1 + 0.1, y + h, y + h + 0.16, 0, depth + 0.15, trim if roof_hex is None else roof_hex)
    if stairs:
        sx0, sx1, side = stairs               # steps rise from the ground to the deck, running along z toward the street... here along x at the end
        nst = max(2, int(y / 0.2))
        for i in range(nst):
            yy = y * (i + 1) / nst
            if lod == 2 and i < nst - 1: continue
            m.box(sx0, sx1, 0 if i == nst - 1 and False else -0.3, yy, depth - 0.0 + 0.0 - (nst - i) * 0.28 + 0.28, depth + 0.28 * 0 + 0.0 + 0.28 * 0 + 0.28 - (nst - i - 1) * 0.28 + (nst - 1) * 0.0 - 0.28 + 0.28 * 0, 0xb3ada0)


def front_steps(m, lod, x0, x1, z, y, hex_=0xb3ada0):
    """Steps rising toward the building: tread i is at z + (n - i) * 0.28, up to height y at z."""
    n = max(2, int(round(y / 0.19)))
    for i in range(n):
        top = y * (n - i) / n
        if lod == 2 and i: continue
        m.box(x0, x1, -0.6, top, z + i * 0.28, z + (i + 1) * 0.28, hex_, skip='b')


def dish(m, x, y, z, nx=0, nz=1, hex_=0xdcdcd6):
    r = 0.3
    pts = []
    for i in range(8):
        a = 2 * pi * i / 8
        pts.append((x + cos(a) * r * (1 if nz else 0.0) + (nx * 0.0), y + sin(a) * r, z + (cos(a) * r if nx else 0) + 0.15 * nz))
    m.face(pts if nz else pts[::-1], hex_, 0.0, (nx, 0.3, nz))
    m.box(x - 0.02, x + 0.02, y - 0.02, y + 0.02, z, z + 0.15, 0x555555)


def dormer(m, lod, cx, y_base, z_front, wid, wallh, roof, wall, trim, fascia, rnd, depth=1.6):
    """A gable dormer on a front slope: its face at z_front, running back `depth`, base at y_base."""
    x0, x1 = cx - wid / 2, cx + wid / 2
    m.box(x0, x1, y_base, y_base + wallh, z_front - depth, z_front, wall, 1.0, skip='b')
    roof_z(m, lod, x0, x1, z_front - depth, z_front, y_base + wallh, wid * 0.4, 0.25, roof, wall, fascia)
    W = Wall(m, 'z', z_front, 1)
    window(W, lod, cx, y_base + 0.25, wid * 0.55, wallh - 0.4, trim, rnd, rows=2)


def foot(m, x0, x1, z0, z1, h=0.55, hex_=0x908c84):
    m.box(x0 - 0.04, x1 + 0.04, -1.2, h, z0 - 0.04, z1 + 0.04, hex_, skip='b')


def gutter(m, x0, x1, z, y, hex_=0xe8e8e2):
    m.box(x0, x1, y - 0.08, y + 0.06, z, z + 0.1, hex_)


def downspout(m, x, z, y1, hex_=0xe8e8e2):
    m.box(x - 0.04, x + 0.04, 0.2, y1, z, z + 0.08, hex_)


# ── Palettes: (wall, trim, accent/door, roof, deck) ─────────────────────────

PAL = {
    'cream':   (0xd9d3bf, 0xf3f0e6, 0x4a6a54, 0x3d3f42, 0x8a6a4a),
    'sage':    (0x8fa291, 0xeeeadf, 0x7a2a22, 0x4a4f52, 0x6d5a45),
    'slate':   (0x7f93a8, 0xf1f0ea, 0x2c4a3a, 0x3b3b3d, 0x75604a),
    'yellow':  (0xcbb36a, 0xf3efe0, 0x25395c, 0x5b4d45, 0x7a5f45),
    'red':     (0xa4513f, 0xe9e5d6, 0x2c4a3a, 0x3d3f42, 0x6d5a45),
    'white':   (0xe6e2d8, 0xe6e2d8, 0x25395c, 0x4b4e53, 0xa59f92),
    'taupe':   (0xb3a891, 0xf0ece0, 0x6a2620, 0x4b4e53, 0x8a7a65),
    'green':   (0x6f8268, 0xe8e4d4, 0x7a2a22, 0x3f4744, 0x6d5a45),
    'rose':    (0xc4a199, 0xf1ede2, 0x2c4a3a, 0x4a3f3a, 0x6d5a45),
    'blue':    (0x6c829c, 0xeeeee8, 0xb8892e, 0x35383a, 0x7a6a55),
}


# ── Designs ──────────────────────────────────────────────────────────────────
# Each returns (mesh, meta); meta = dict(w, D, top, ridge, front) in the design's frame.

FH = 2.95
BASE = 0.55


def triple(lod, seed, style, pal):
    """Three-flat house: three storeys of FH, stacked front porches on all three levels, a flat roof with bracketed cornice (style
    'flat'), a gable to the street ('gable'), or a full-height bay on the left and porches on the right ('bay')."""
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = (8.4, 13.4) if style != 'bay' else (9.2, 13.4)
    H = BASE + 3 * FH
    foot(m, 0, w, -D, 0)
    m.box(0, w, BASE, H, -D, 0, wall, 1.0, skip='b')
    # corner boards
    if lod < 2:
        for x in (0, w - 0.1):
            m.box(x, x + 0.1, BASE, H, -D, 0.05, trim, skip='') if lod == 0 else None
    Wf = Wall(m, 'z', 0, 1)
    px0, px1 = (0.4, w - 0.4) if style != 'bay' else (3.6, w - 0.3)
    for fl in range(3):
        y = BASE + fl * FH
        ds = [(px0 + 0.9) if fl % 2 == 0 else px1 - 0.9]
        # windows: two bays on the front above each porch; one door per floor
        if style == 'bay' and fl >= 0:
            pass
        door(Wf, lod, px0 + 0.9 if True else 0, y, trim, acc if fl == 0 else shade(acc, 1.1), storm=(fl == 0), lit_glass=rnd.random() < 0.3)
        wx = [px1 - 1.4]
        if px1 - px0 > 5.2: wx = [px0 + 2.6, px1 - 1.1]
        for x in wx:
            window(Wf, lod, x, y + 0.75, 1.0, 1.65, trim, rnd, rows=2, shutters=None)
        porch(m, lod, px0, px1, 2.3 if lod < 2 else 2.2, y + 0.1 if fl else y + 0.12, FH - 0.28 if fl < 2 else FH - 0.28, trim, deck, rails=True, roof_hex=trim,
              stairs=None)
    # porch ceiling beadboard is implied by the deck box above; porch roofs are the decks of the next level.
    if style == 'bay':
        # full-height bay with a window per floor
        bx0, bx1, bd = 0.5, 3.1, 0.9
        m.box(bx0, bx1, BASE, H, 0, bd, wall, 1.0, skip='b')
        for fl in range(3):
            y = BASE + fl * FH
            for x in (bx0 + 0.75, bx1 - 0.75):
                window(Wall(m, 'z', bd, 1), lod, x, y + 0.7, 0.8, 1.55, trim, rnd, rows=2)
            m.box(bx0 - 0.08, bx1 + 0.08, y + FH - 0.2, y + FH - 0.05, -0.02, bd + 0.08, trim) if lod < 2 else None
        m.box(bx0 - 0.15, bx1 + 0.15, H, H + 0.14, -0.1, bd + 0.15, trim)
        if lod == 0:
            for i in range(5):
                x = bx0 + (bx1 - bx0) * (i + 0.5) / 5
                m.box(x - 0.06, x + 0.06, H - 0.4, H, bd + 0.02, bd + 0.15, trim)
        front_steps_x = (px0 + 0.1, px0 + 1.8)
    else:
        front_steps_x = (px0 + 0.1, px0 + 1.7)
    front_steps(m, lod, front_steps_x[0], front_steps_x[1], 2.3, BASE + 0.12)
    # side windows (two columns per floor, left and right walls), back wall windows
    for sd, (plane, n) in enumerate(((0, -1), (w, 1))):
        Ws = Wall(m, 'x', plane, n)
        for fl in range(3):
            y = BASE + fl * FH + 0.75
            for u in (-3.0, -6.4, -9.8, -12.2 + (0.6 if sd else 0)):
                if (fl + int(u) + sd) % 4 == 0 and lod: continue
                window(Ws, lod, u, y, 0.95, 1.6, trim, rnd, rows=2)
    Wb = Wall(m, 'z', -D, -1)
    for fl in range(3):
        for u in (1.6, 4.2, 6.8):
            window(Wb, lod, u, BASE + fl * FH + 0.75, 0.95, 1.6, trim, rnd, rows=2)
    # roof
    if style == 'gable':
        roof_z(m, lod, 0, w, -D, 0, H, 2.6, 0.45, roof, wall, trim)
        window(Wf, lod, w / 2, H + 0.35, 0.9, 1.05, trim, rnd, rows=2) if False else None
        W2 = Wall(m, 'z', 0, 1)
        window(W2, lod, w / 2, H + 0.4, 0.8, 0.95, trim, rnd, rows=1)
        top = H + 2.6
    else:
        m.box(-0.2, w + 0.2, H, H + 0.55, -D - 0.2, 0.3, shade(trim, 0.96))
        m.box(-0.1, w + 0.1, H + 0.55, H + 0.62, -D - 0.1, 0.2, roof)
        if lod == 0:
            for i in range(int(w / 0.8)):
                x = 0.3 + i * 0.8
                m.box(x, x + 0.18, H - 0.35, H, 0.0, 0.3, trim)
            m.box(-0.2, w + 0.2, H - 0.12, H, 0, 0.3, shade(trim, 0.85))
        top = H + 0.62
    chimney(m, lod, w * 0.7, -D * 0.55, H - 1.5, top + 1.6)
    if lod < 2:
        gutter(m, -0.1, w + 0.1, 0.3, H + 0.1, trim) if False else None
        downspout(m, w + 0.04 if False else w - 0.2, 0.06, H, 0xe8e8e2) if lod == 0 else None
    if lod == 0 and rnd.random() < 0.6:
        dish(m, w * 0.55, BASE + 2 * FH + 1.2 + rnd.random() * 0.5, 0.05) if style != 'bay' else dish(m, 4.5, BASE + 2 * FH + 2.0, bd + 0.05 if False else 0.05)
    # back stairs, a fire-escape-ish exterior stair on the back wall (lod 0/1)
    if lod < 2:
        for fl in range(3):
            y = BASE + fl * FH
            m.box(w - 2.6, w - 0.4, y - 0.12, y, -D - 1.4, -D, 0x7a6a55)
            if lod == 0: m.box(w - 2.6, w - 0.4, y, y + 0.95, -D - 1.4, -D - 1.34, trim)
    return m, dict(w=w, D=D, top=top, front=2.3)


def cape(lod, seed, style, pal):
    """A cape: one and a half storeys, ridge parallel to the street, centre door, chimney, two dormers ('plain' or 'bay' with a front bay)."""
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = 10.2, 8.4
    eave = BASE + 3.0
    foot(m, 0, w, -D, 0)
    m.box(0, w, BASE, eave, -D, 0, wall, 1.0, skip='b')
    rise = D / 2 * 0.95
    roof_x(m, lod, 0, w, -D, 0, eave, rise, 0.45, roof, wall, trim)
    Wf = Wall(m, 'z', 0, 1)
    dc = w / 2 - 0.4 if style == 'plain' else w / 2
    door(Wf, lod, dc, BASE, trim, acc, storm=True, lit_glass=rnd.random() < 0.4)
    wxs = [1.5, 3.4, w - 3.4, w - 1.5] if style == 'plain' else [1.5, w - 1.5]
    for x in wxs:
        window(Wf, lod, x, BASE + 0.65, 0.95, 1.5, trim, rnd, rows=3, shutters=acc if style == 'plain' else None)
    if style == 'bay':
        # a front bay to the left of the door
        m.box(2.7, 5.0, BASE + 0.4, BASE + 2.7, 0, 0.7, wall, 1.0, skip='b')
        window(Wall(m, 'z', 0.7, 1), lod, 3.85, BASE + 0.65, 1.7, 1.5, trim, rnd, rows=2, cols=3)
        m.box(2.6, 5.1, BASE + 2.7, BASE + 2.85, -0.05, 0.8, roof)
    # a porch roof / portico over the door
    m.box(dc - 1.4, dc + 1.4, BASE + 2.45, BASE + 2.58, 0, 1.2, trim)
    for x in (dc - 1.3, dc + 1.2): m.box(x, x + 0.12, BASE, BASE + 2.45, 1.0, 1.12, trim)
    front_steps(m, lod, dc - 1.0, dc + 1.0, 1.12, BASE)
    # dormers
    for cx in ([2.7, w - 2.7] if style == 'plain' else [2.5, w - 2.5]):
        dormer(m, lod, cx, eave + 0.55, -D / 2 + 0.55 + (D * 0.5 - 0.55) * 0.0 + 0.0 + 0.0 + (0.0), 1.6, 1.5, roof, wall, trim, trim, rnd, 1.4) if False else None
    # dormer faces sit on the slope: at height y the slope is at z = -(rise - (y - eave)) * (D/2)/rise + ...
    for cx in [2.7, w - 2.7]:
        yb = eave + 0.9
        zs = -((yb - eave) * (D / 2) / rise)       # slope z at y = yb
        dormer(m, lod, cx, yb, zs + 1.2, 1.7, 1.4, roof, wall, trim, trim, rnd, 1.2 + 0.0)
    for sd, (plane, n) in enumerate(((0, -1), (w, 1))):
        Ws = Wall(m, 'x', plane, n)
        for u in (-2.3, -D + 2.3):
            window(Ws, lod, u, BASE + 0.65, 0.95, 1.5, trim, rnd, rows=3)
        # gable window
        window(Ws, lod, -D / 2, eave + 0.7, 0.7, 1.0, trim, rnd, rows=2)
    Wb = Wall(m, 'z', -D, -1)
    for u in (1.8, 4.2, 6.6, 8.8):
        window(Wb, lod, u, BASE + 0.65, 0.95, 1.5, trim, rnd, rows=3)
    chimney(m, lod, w * 0.52, -D / 2, eave + 1.0, eave + rise + 1.0, 1.1, 1.2)
    if lod == 0 and rnd.random() < 0.5: dish(m, w - 1.0, eave - 0.6, 0.05)
    if lod == 0: downspout(m, 0.1, 0.06, eave)
    return m, dict(w=w, D=D, top=eave + rise, front=1.2)


def gable_front(lod, seed, style, pal):
    """A gable-front house: two storeys, the gable to the street, a one-storey porch across the front. Clapboard or vinyl."""
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = 7.4, 11.0
    eave = BASE + 5.0
    foot(m, 0, w, -D, 0)
    m.box(0, w, BASE, eave, -D, 0, wall, 1.0, skip='b')
    rise = w / 2 * 0.78
    roof_z(m, lod, 0, w, -D, 0, eave, rise, 0.4, roof, wall, trim)
    Wf = Wall(m, 'z', 0, 1)
    px0, px1, pd = (0.0, w, 1.9)
    left = style == 'left'
    dx = 1.1 if left else w - 1.1
    door(Wf, lod, dx, BASE, trim, acc, storm=True, lit_glass=rnd.random() < 0.4)
    window(Wf, lod, w - 2.2 if left else 2.2, BASE + 0.75, 1.05, 1.5, trim, rnd, rows=2, cols=1)
    for x in ([1.6, w - 1.6]):
        window(Wf, lod, x, BASE + 2.95, 1.0, 1.55, trim, rnd, rows=2)
    window(Wf, lod, w / 2, eave + 0.45, 0.85, 1.0, trim, rnd, rows=1)
    # porch: a deck, posts, a shed roof sloping down to the front
    m.box(px0 - 0.1, px1 + 0.1, BASE - 0.3, BASE + 0.1, 0, pd, deck, skip='b')
    for x in (0.1, w - 0.22):
        m.box(x, x + 0.14, BASE + 0.1, BASE + 2.55, pd - 0.2, pd - 0.06, trim)
    if lod < 2:
        m.box(px0, px1, BASE + 0.1 + 0.9, BASE + 0.1 + 0.96, pd - 0.12, pd - 0.04, trim) if lod == 0 else None
    shed_roof(m, px0 - 0.25, px1 + 0.25, 0, pd + 0.25, BASE + 2.55, BASE + 3.1, roof, trim, lod)
    m.box(px0 - 0.25, px1 + 0.25, BASE + 2.4, BASE + 2.55, pd + 0.1, pd + 0.25, trim)
    front_steps(m, lod, (dx - 0.9), (dx + 0.9), pd, BASE + 0.1)
    for sd, (plane, n) in enumerate(((0, -1), (w, 1))):
        Ws = Wall(m, 'x', plane, n)
        for fl in range(2):
            for u in (-2.0, -5.3, -8.6):
                if (fl + int(u) + sd) % 3 == 0 and lod: continue
                window(Ws, lod, u, BASE + fl * 2.5 + 0.8, 0.95, 1.5, trim, rnd, rows=2)
    Wb = Wall(m, 'z', -D, -1)
    for fl in range(2):
        for u in (1.8, w - 1.8):
            window(Wb, lod, u, BASE + fl * 2.5 + 0.8, 0.95, 1.5, trim, rnd, rows=2)
    chimney(m, lod, w * 0.25, -D * 0.6, eave + 0.8, eave + rise + 0.9, 0.7, 0.9)
    if lod == 0 and style == 'left':
        dish(m, w - 0.8, eave - 0.4, 0.05)
    return m, dict(w=w, D=D, top=eave + rise, front=pd)


def victorian(lod, seed, style, pal):
    """A Queen Anne: octagonal corner turret with a conical roof, a front cross-gable, a wraparound porch with spindles, a hipped main roof."""
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = 11.2, 11.0
    eave = BASE + 6.1
    foot(m, 0, w, -D, 0)
    m.box(0, w, BASE, eave, -D, 0, wall, 1.0, skip='b')
    hip_roof(m, lod, 0, w, -D, 0, eave, 3.0, 0.5, roof, trim)
    # front cross-gable on the left, projecting 1.8 m
    gx0, gx1, gz = 0.6, 5.2, 1.8
    m.box(gx0, gx1, BASE, eave, 0, gz, wall, 1.0, skip='b')
    roof_z(m, lod, gx0, gx1, -4.5, gz, eave, 2.7, 0.35, roof, wall, trim)
    Wg = Wall(m, 'z', gz, 1)
    for fl, y in enumerate((BASE + 0.8, BASE + 3.3)):
        window(Wg, lod, 2.9, y, 1.1, 1.7 if fl == 0 else 1.5, trim, rnd, rows=2, cols=2 if fl == 0 else 1)
    window(Wg, lod, 2.9, eave + 0.5, 0.8, 0.95, trim, rnd, rows=1)
    m.box(gx0 - 0.05, gx1 + 0.05, BASE + 2.95, BASE + 3.1, 0, gz + 0.08, trim) if lod < 2 else None   # belt band
    # turret at the right front corner: octagon r = 1.9 to eave + 1.2, cone above
    cx, cz, r = w - 2.4, -0.4, 1.9
    pts = [(cx + cos(pi / 8 + 2 * pi * i / 8) * r, cz + sin(pi / 8 + 2 * pi * i / 8) * r) for i in range(8)]
    ty1 = eave + 1.2
    for i in range(8):
        a, b = pts[i], pts[(i + 1) % 8]
        nxm, nzm = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
        m.face([(a[0], BASE, a[1]), (b[0], BASE, b[1]), (b[0], ty1, b[1]), (a[0], ty1, a[1])], wall, 1.0, (nxm, 0, nzm))
        if lod < 2 and nzm > -0.3:
            # a window on each front-facing facet, in a little local wall
            mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            ln = sqrt(nxm * nxm + nzm * nzm)
            nx_, nz_ = nxm / ln * 0.03, nzm / ln * 0.03
            ux, uz = (b[0] - a[0]), (b[1] - a[1])
            ul = sqrt(ux * ux + uz * uz)
            ux, uz = ux / ul, uz / ul
            for y0 in (BASE + 1.0, BASE + 3.7):
                lit = rnd.random() < 0.4
                g = [(mx - ux * 0.38 + nx_, y0, mz - uz * 0.38 + nz_), (mx + ux * 0.38 + nx_, y0, mz + uz * 0.38 + nz_),
                     (mx + ux * 0.38 + nx_, y0 + 1.35, mz + uz * 0.38 + nz_), (mx - ux * 0.38 + nx_, y0 + 1.35, mz - uz * 0.38 + nz_)]
                m.face(g, GLASS_L if lit else GLASS_D, rnd.uniform(0.55, 0.65) if lit else rnd.uniform(0.2, 0.3), (nxm, 0, nzm))
                if lod == 0:
                    g2 = [(p[0] + nx_ * 1.0, p[1], p[2] + nz_ * 1.0) for p in g]
    # a band at the turret waist and the cone
    if lod < 2:
        m.box(cx - r - 0.08, cx + r + 0.08, BASE + 3.0, BASE + 3.12, cz - r - 0.08, cz + r + 0.08, trim) if lod == 0 else None
    cone_y = ty1 + 3.2
    for i in range(8):
        a, b = pts[i], pts[(i + 1) % 8]
        o = 0.25
        a2 = (cx + (a[0] - cx) * (1 + o / r), cz + (a[1] - cz) * (1 + o / r)); b2 = (cx + (b[0] - cx) * (1 + o / r), cz + (b[1] - cz) * (1 + o / r))
        m.face([(a2[0], ty1 - 0.15, a2[1]), (b2[0], ty1 - 0.15, b2[1]), (cx, cone_y, cz)], roof, 0.0, ((a[0] + b[0]) / 2 - cx, 0.7, (a[1] + b[1]) / 2 - cz))
    if lod < 2: m.box(cx - 0.05, cx + 0.05, cone_y, cone_y + 0.8, cz - 0.05, cz + 0.05, 0x2a2a2a)
    # the porch wraps the front (right of the gable) and the right side
    pd = 2.0
    py = BASE + 0.1
    m.box(gx1, w + pd, py - 0.14, py, 0, pd, deck, skip='b') if False else None
    m.box(gx1 + 0.0, w, py - 0.14, py, 0, pd, deck, skip='b')
    for i, x in enumerate([gx1 + 0.2, (gx1 + w) / 2]):
        m.box(x, x + 0.16, py, py + 2.7, pd - 0.2, pd - 0.04, trim)
    m.box(gx1, w, py + 2.5, py + 2.7, pd - 0.25, pd + 0.05, trim)
    m.box(gx1 - 0.1, w + 0.1, py + 2.7, py + 2.82, 0, pd + 0.15, roof)
    if lod < 2:
        m.box(gx1, w, py + 0.9, py + 0.96, pd - 0.12, pd - 0.04, trim)
        if lod == 0:
            k = int((w - gx1) / 0.12)
            for i in range(1, k):
                x = gx1 + (w - gx1) * i / k
                m.box(x - 0.02, x + 0.02, py + 0.12, py + 0.9, pd - 0.09, pd - 0.06, trim)
            for i in range(int((w - gx1) / 0.45)):          # frieze brackets
                x = gx1 + 0.2 + i * 0.45
                m.box(x, x + 0.06, py + 2.2, py + 2.5, pd - 0.05, pd, trim)
    Wf = Wall(m, 'z', 0, 1)
    door(Wf, lod, gx1 + 1.3, BASE, trim, acc, storm=True, lit_glass=True)
    window(Wf, lod, (gx1 + cx - r) / 2 + 0.9, BASE + 0.8, 1.0, 1.7, trim, rnd, rows=2)
    window(Wf, lod, gx1 + 1.6, BASE + 3.3, 1.0, 1.5, trim, rnd, rows=2)
    front_steps(m, lod, gx1 + 0.5, gx1 + 2.2, pd, py)
    for sd, (plane, n) in enumerate(((0, -1), (w, 1))):
        Ws = Wall(m, 'x', plane, n)
        for fl in range(2):
            for u in (-3.5, -6.5, -9.5):
                window(Ws, lod, u, BASE + 0.8 + fl * 2.9, 1.0, 1.6, trim, rnd, rows=2)
    Wb = Wall(m, 'z', -D, -1)
    for fl in range(2):
        for u in (2.0, 5.6, 9.2):
            window(Wb, lod, u, BASE + 0.8 + fl * 2.9, 1.0, 1.6, trim, rnd, rows=2)
    chimney(m, lod, 3.0, -7.0, eave + 0.5, eave + 4.3, 0.9, 1.1)
    return m, dict(w=w, D=D, top=cone_y + 0.8, front=pd)


def corner_store(lod, seed, style, pal):
    """A corner store with rooms above: a flat roof, a stepped parapet, a big shop window and a side door, a striped awning."""
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = 9.2, 13.0
    H = BASE + 3.4 + 3.0
    foot(m, 0, w, -D, 0)
    m.box(0, w, BASE, H, -D, 0, wall, 1.0, skip='b')
    Wf = Wall(m, 'z', 0, 1)
    # shop front: glass, a door at the right, a sign board above
    m.box(0.35, w - 0.35, BASE + 0.0, BASE + 0.75, 0, 0.1, shade(wall, 0.75)) if lod < 2 else None
    Wf.quad(0.6, w - 2.4, BASE + 0.75, BASE + 2.75, 0.03, 0x55697a, 0.58 if style == 'lit' else 0.3)
    if lod < 2:
        for u in (0.6, w - 2.4, (0.6 + w - 2.4) / 2):
            Wf.box(u - 0.05, u + 0.05, BASE + 0.7, BASE + 2.8, 0, 0.1, trim, skip='k')
        Wf.box(0.5, w - 2.3, BASE + 2.75, BASE + 2.85, 0, 0.1, trim, skip='k')
    door(Wf, lod, w - 1.25, BASE, trim, acc, storm=True, lit_glass=True)
    Wf.quad(0.4, w - 0.4, BASE + 3.0, BASE + 3.65, 0.06, 0xe9e2cf)             # blank sign board
    if lod < 2:
        Wf.box(0.3, w - 0.3, BASE + 2.95, BASE + 3.7, 0, 0.06, trim, skip='k')
        # awning: a slanted striped quad
        n = 6
        for i in range(n):
            u0 = 0.4 + (w - 0.8) * i / n; u1 = 0.4 + (w - 0.8) * (i + 1) / n
            c = acc if i % 2 == 0 else 0xe8e2d0
            m.face([(u0, BASE + 2.85, 0.05), (u1, BASE + 2.85, 0.05), (u1, BASE + 2.4, 1.1), (u0, BASE + 2.4, 1.1)], c, 0.0, (0, 0.7, 0.7))
            if lod == 0: m.face([(u0, BASE + 2.4, 1.1), (u1, BASE + 2.4, 1.1), (u1, BASE + 2.28, 1.1), (u0, BASE + 2.28, 1.1)], c, 0.0, (0, 0, 1))
    for x in (1.7, w / 2, w - 1.7):
        window(Wf, lod, x, BASE + 4.15, 1.0, 1.55, trim, rnd, rows=2)
    # side (right) shop window and the upstairs door stair
    Ws = Wall(m, 'x', w, 1)
    Ws.quad(-1.2, -5.6, BASE + 0.75, BASE + 2.55, 0.03, 0x55697a, 0.58 if style == 'lit' else 0.3)
    for u in (-2.2, -5.0, -8.0, -11.0):
        window(Ws, lod, u, BASE + 4.15, 0.95, 1.5, trim, rnd, rows=2)
    for u in (-8.0, -11.0): window(Ws, lod, u, BASE + 1.0, 0.95, 1.5, trim, rnd, rows=2)
    Wl = Wall(m, 'x', 0, -1)
    for fl in range(2):
        for u in (-2.5, -6.0, -9.5):
            window(Wl, lod, u, BASE + 1.0 + fl * 3.15, 0.95, 1.5, trim, rnd, rows=2)
    Wb = Wall(m, 'z', -D, -1)
    for u in (2.0, 4.6, 7.2): window(Wb, lod, u, BASE + 4.15, 0.95, 1.5, trim, rnd, rows=2)
    # parapet and cornice
    m.box(-0.12, w + 0.12, H, H + 0.8, -D - 0.12, 0.2, shade(wall, 0.98), 1.0, skip='b') if lod else m.box(-0.12, w + 0.12, H, H + 0.8, -D - 0.12, 0.2, trim)
    m.box(-0.2, w + 0.2, H + 0.8, H + 0.92, -D - 0.2, 0.3, trim)
    m.box(-0.1, w + 0.1, H + 0.92, H + 0.96, -D - 0.1, 0.2, roof)
    if lod == 0:
        for i in range(int(w / 0.7)):
            m.box(0.25 + i * 0.7, 0.43 + i * 0.7, H - 0.3, H, 0.0, 0.2, trim)
        dish(m, w * 0.3, H + 0.96, -2.0, 0, 1) if False else None
        m.box(w - 2.2, w - 0.8, H + 0.96, H + 1.5, -D + 1.2, -D + 2.5, 0x9ea2a3)              # a roof unit
    chimney(m, lod, 2.2, -D * 0.6, H, H + 1.9, 0.7, 0.8)
    return m, dict(w=w, D=D, top=H + 1.0, front=1.1)


def garage(lod, seed, style, pal):
    """A detached one-car garage: the door at the +z end (toward the street), the ridge along z."""
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = 3.8, 6.2
    eave = 2.55
    m.box(-0.0, w, 0, eave, -D, 0, wall, 1.0, skip='b')
    m.box(-0.05, w + 0.05, -0.8, 0.12, -D - 0.05, 0.05, 0xa8a49c, skip='b')
    roof_z(m, lod, 0, w, -D, 0, eave, 1.3, 0.3, roof, wall, trim)
    Wf = Wall(m, 'z', 0, 1)
    dh = 2.1
    Wf.quad(0.3, w - 0.3, 0.1, dh, 0.04, 0xe3e0d6)
    if lod < 2:
        for k in range(1, 4): Wf.quad(0.3, w - 0.3, 0.1 + (dh - 0.1) * k / 4 - 0.01, 0.1 + (dh - 0.1) * k / 4 + 0.01, 0.05, 0x9a978d)
        Wf.box(0.2, w - 0.2, dh, dh + 0.12, 0, 0.07, trim, skip='k')
    if lod == 0:
        for u in (0.9, 1.9, 2.9): Wf.quad(u - 0.2, u + 0.2, 1.5, 1.8, 0.055, GLASS_D, 0.26)
    Ws = Wall(m, 'x', w, 1)
    window(Ws, lod, -3.2, 1.0, 0.8, 0.8, trim, rnd, rows=2, lit=False)
    door(Wall(m, 'x', 0, -1), lod, -3.8, 0.0, trim, acc, storm=False, w=0.85, h=2.0)
    return m, dict(w=w, D=D, top=eave + 1.3, front=0.0)


def shed(lod, seed, style, pal):
    rnd = random.Random(seed)
    m = Mesh(seed)
    wall, trim, acc, roof, deck = PAL[pal]
    w, D = 2.7, 2.3
    m.box(0, w, 0, 2.1, -D, 0, wall, 1.0, skip='b')
    m.box(-0.05, w + 0.05, -0.4, 0.1, -D - 0.05, 0.05, 0x8a867e, skip='b')
    shed_roof(m, -0.15, w + 0.15, -D - 0.15, 0.2, 2.1, 2.5, roof, trim, lod)
    m.face([(0, 2.1, -D), (0, 2.1, 0), (0, 2.43, -D)], wall, 1.0, (-1, 0, 0)) if False else None
    Wf = Wall(m, 'z', 0, 1)
    if lod < 2: Wf.box(0.45, w - 0.45, 0, 1.9, 0, 0.05, acc, skip='k')
    else: Wf.quad(0.45, w - 0.45, 0, 1.9, 0.03, acc)
    return m, dict(w=w, D=D, top=2.5, front=0.0)


def car(lod, seed, style, pal):
    """A parked car: length along z (nose toward +z), centred on the origin, white body for the game to tint. style: sedan, hatch, suv."""
    m = Mesh(seed)
    L, Wd = {'sedan': (4.7, 1.82), 'hatch': (4.1, 1.78), 'suv': (4.6, 1.9)}[style]
    hh = {'sedan': 1.0, 'hatch': 1.05, 'suv': 1.3}[style]
    body = 0xdcdcdc
    z0, z1 = -L / 2, L / 2
    x0, x1 = -Wd / 2, Wd / 2
    m.box(x0, x1, 0.32, 0.82, z0, z1, body)
    # cabin: a tapered block
    c0, c1 = z0 + L * (0.22 if style != 'hatch' else 0.12), z1 - L * (0.3 if style != 'hatch' else 0.22)
    top = 0.82 + (hh - 0.5) * 0.55 + 0.25
    m.face([(x0 + 0.08, 0.82, c1), (x1 - 0.08, 0.82, c1), (x1 - 0.12, top, c1 - 0.7), (x0 + 0.12, top, c1 - 0.7)], 0x1c242b, 0.28, (0, 0.5, 1))        # windscreen
    m.face([(x1 - 0.08, 0.82, c0), (x0 + 0.08, 0.82, c0), (x0 + 0.12, top, c0 + (0.5 if style != 'hatch' else 0.3)), (x1 - 0.12, top, c0 + (0.5 if style != 'hatch' else 0.3))], 0x1c242b, 0.28, (0, 0.5, -1))
    m.face([(x0 + 0.12, top, c1 - 0.7), (x1 - 0.12, top, c1 - 0.7), (x1 - 0.12, top, c0 + 0.5), (x0 + 0.12, top, c0 + 0.5)], body, 0.0, (0, 1, 0))
    for s, nx in ((x1, 1), (x0, -1)):
        m.face([(s - nx * 0.08, 0.82, c1), (s - nx * 0.08, 0.82, c0), (s - nx * 0.12, top, c0 + 0.5), (s - nx * 0.12, top, c1 - 0.7)], 0x1c242b, 0.28, (nx, 0.3, 0))
    if lod < 2:
        for sx in (x0, x1):
            for zc in (z0 + 0.85, z1 - 0.85):
                nx = 1 if sx > 0 else -1
                m.box(sx - 0.12 if nx > 0 else sx - 0.02, sx + 0.02 if nx > 0 else sx + 0.12, 0.0, 0.62, zc - 0.34, zc + 0.34, 0x181818)
        m.box(x0 + 0.05, x1 - 0.05, 0.4, 0.5, z1, z1 + 0.06, 0x3a3a3a)           # bumpers
        m.box(x0 + 0.05, x1 - 0.05, 0.4, 0.5, z0 - 0.06, z0, 0x3a3a3a)
        m.box(x0 + 0.1, x0 + 0.5, 0.6, 0.72, z1, z1 + 0.04, 0xf2f0dc); m.box(x1 - 0.5, x1 - 0.1, 0.6, 0.72, z1, z1 + 0.04, 0xf2f0dc)
        m.box(x0 + 0.1, x0 + 0.5, 0.6, 0.72, z0 - 0.04, z0, 0xb01a1a); m.box(x1 - 0.5, x1 - 0.1, 0.6, 0.72, z0 - 0.04, z0, 0xb01a1a)
    return m, dict(w=Wd, D=L, top=top, front=0.0)


def mailbox(lod, seed, style, pal):
    m = Mesh(seed)
    m.box(-0.04, 0.04, 0, 1.0, -0.04, 0.04, 0x6a5a48)
    m.box(-0.12, 0.12, 1.0, 1.22, -0.25, 0.25, 0x2a2e33)
    m.box(-0.12, 0.12, 1.22, 1.26, -0.25, 0.25, 0x2a2e33)
    m.box(0.12, 0.14, 1.1, 1.25, 0.12, 0.14, 0xa81c1c)
    return m, dict(w=0.3, D=0.5, top=1.26, front=0.0)


# name, builder, style, palette, hands (mirror too)
DESIGNS = [
    ('td_a', triple, 'flat', 'cream', True), ('td_b', triple, 'gable', 'sage', True), ('td_c', triple, 'bay', 'slate', True),
    ('td_d', triple, 'flat', 'yellow', True),
    ('cape_a', cape, 'plain', 'white', True), ('cape_b', cape, 'bay', 'taupe', True), ('cape_c', cape, 'plain', 'green', True),
    ('gf_a', gable_front, 'left', 'blue', True), ('gf_b', gable_front, 'right', 'rose', True), ('gf_c', gable_front, 'left', 'white', True),
    ('vic_a', victorian, 'a', 'green', True), ('vic_b', victorian, 'a', 'red', True),
    ('store_a', corner_store, 'lit', 'taupe', True),
    ('garage_a', garage, 'a', 'white', False), ('garage_b', garage, 'a', 'sage', False),
    ('shed_a', shed, 'a', 'green', False),
]
PROPS = [('car0', car, 'sedan'), ('car1', car, 'hatch'), ('car2', car, 'suv'), ('mailbox', mailbox, 'a')]


def clapboard_maps():
    """clap_bc / clap_bn: one tile (TILE m square) of eight boards, made by numpy."""
    import numpy as np
    N = 256
    rng = np.random.default_rng(7)
    v = (np.arange(N) + 0.5) / N
    f = (v * 8) % 1.0
    b = np.floor(v * 8).astype(int)
    h = np.where(f < 0.9, 1.0 - 0.55 * f, 1.0 - 0.55 * 0.9 + 0.25 * (f - 0.9) * 10)   # a board thins upward; the lip of the next one steps out
    # tint per board and grain along u
    tint = 0.9 + 0.1 * rng.random(8)
    u = (np.arange(N) + 0.5) / N
    grain = np.zeros((N, N))
    for k in range(6):
        fr = 3 + 5 * k
        grain += rng.random() * np.sin(2 * pi * (fr * u[None, :] * 3 + rng.random() * 6 + 7 * v[:, None] * (1 + k)))
    grain = 0.03 * grain / 3
    shadow = np.where(f > 0.9, 0.55 + 0.45 * (1 - f) * 10, 1.0)
    hl = np.where(f < 0.04, 1.06, 1.0)
    col = (tint[b] * shadow * hl)[:, None] * np.ones((1, N)) + grain
    col = np.clip(col * 0.94, 0, 1)
    dh = np.gradient(h, 1.0 / N) * 0.12
    nx = np.zeros((N, N)); ny = -dh[:, None] * np.ones((1, N)) + 0.02 * grain * 5
    nz = np.ones((N, N))
    ln = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    nrm = np.stack([nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, nz / ln * 0.5 + 0.5, np.ones((N, N))], axis=-1)
    bc = np.stack([col, col, col * 0.99, np.ones((N, N))], axis=-1)
    res = {}
    for name, arr, cs in (('clap_bc', bc, 'sRGB'), ('clap_bn', nrm, 'Non-Color')):
        img = bpy.data.images.new(name, N, N, alpha=True)
        img.colorspace_settings.name = cs
        if cs == 'sRGB': arr = np.concatenate([arr[..., :3] ** 2.2, arr[..., 3:]], axis=-1)
        img.pixels.foreach_set(arr.astype('float32').ravel())
        img.update()
        path = os.path.join(OUT, name + '.webp')
        scn = bpy.context.scene
        scn.render.image_settings.file_format = 'WEBP'
        scn.render.image_settings.quality = 90
        try:
            img.save_render(path, scene=scn)
        except Exception as e:
            path = os.path.join(OUT, name + '.png'); scn.render.image_settings.file_format = 'PNG'; img.save_render(path, scene=scn)
        res[name] = os.path.basename(path)
    return res


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
    all_obs, far, stats, meta = [], [], {}, {}
    x = 0.0
    for di, (name, fn, style, pal, hands) in enumerate(DESIGNS):
        for lod in (0, 1, 2):
            m, mt = fn(lod, 400 + di, style, pal)
            for hand in ((False, True) if hands else (False,)):
                mm = m.mirrored(mt['w']) if hand else m
                nm = f'{name}m_{lod}' if hand else f'{name}_{lod}'
                ob = mm.to_object(nm, coll)
                ob.location = (x + (mt['w'] + 3 if hand else 0), -lod * 28, 0)
                vertex_ao(ob, reach=2.5 if lod < 2 else 3.0, rays=10 if lod == 0 else 8)
                all_obs.append(ob)
                if lod == 2: far.append(ob)
                stats[nm] = len(mm.f)
            if lod == 0: meta[name] = mt
        x += (mt['w'] * 2 + 6) if hands else (mt['w'] + 3)
        try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
        except Exception: pass
    for name, fn, style in PROPS:
        for lod in ((0, 1, 2) if name.startswith('car') else (0,)):
            m, mt = fn(lod, 900, style, 'white')
            nm = f'{name}_{lod}' if name.startswith('car') else name
            ob = m.to_object(nm, coll); ob.location = (x, 40, 0)
            vertex_ao(ob, reach=1.5, rays=6)
            all_obs.append(ob)
            if lod == 2 or not name.startswith('car'): far.append(ob)
            stats[nm] = len(m.f)
        meta[name] = mt
        x += 5
    out = {'faces': stats, 'meta': meta, 'tile': TILE}
    out.update(clapboard_maps())
    out['houses_kB'] = export(all_obs, os.path.join(OUT, 'houses.glb'))
    out['far_kB'] = export(far, os.path.join(OUT, 'houses_far.glb'))
    print('HOUSE_STATS ' + json.dumps(out))
    with open(os.path.join(ROOT, 'scratch', 'hoods', 'houses_meta.json'), 'w') as fh: json.dump(out, fh, indent=1)


os.makedirs(os.path.join(ROOT, 'scratch', 'hoods'), exist_ok=True)
main()
if '--stay' not in FLAGS:
    sys.stdout.flush()
    os._exit(0)
