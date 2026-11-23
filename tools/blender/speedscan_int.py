# SpeedScan headquarters, inside (tools/briefs/speedscan-hq.md, "Interior"): the lobby, the office floor (42) with its
# card-printer room, the lift cars and the roof deck, modelled by script with the light baked in Cycles on the RTX.
#
#   blender --factory-startup --python tools/blender/speedscan_int.py --python-expr "import bpy; bpy.ops.wm.quit_blender()" -- [--no-bake]
#   (with its window showing, never --background: the owner watches the screen)
#
# Writes, in public/models (BLD_OUT overrides the folder):
#   speedscan_int.glb   in_lobby, in_office, in_car (baked: their vertex colour is the final lit colour, drawn unlit),
#                       in_glass_lobby, in_glass_office, in_glass_roof (glass, drawn as glass), in_roof (the deck, lit
#                       by the game's sun like any outdoor thing).
#   speedscan_int.json  what is solid ([x0, x1, z0, z1, y0, y1]) and where people sit, stand and walk.
#
# Frame: speedscan.py's (the game's, y up, x east, z south, origin at the tower's lot centre, street level 0); the car is
# authored with its door at the origin (it faces +z) and placed by src/world/speedscanInterior.ts at each landing:
# cars at x -4.125 and 4.125, door plane z -3.3; floors: lobby 0.2, office 160, roof deck 322.1.
# The light: Cycles DIFFUSE (direct + indirect + colour) baked into the corner colours of welded, subdivided meshes; the
# ceiling lights are emitters and the sky comes in at the windows. Each object is then scaled so its floor averages a set
# brightness. Without the GPU (or with --no-bake) a simple fall-off from the lights stands in.

import bpy, bmesh, sys, os, json, math, random, time

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.environ.get('BLD_OUT') or os.path.join(ROOT, 'public', 'models')
FLAGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SAMPLES = int(os.environ.get('SSI_SAMPLES', '384'))
random.seed(42)

YL, YO, YR = 0.2, 160.0, 322.1           # lobby floor, office floor, roof deck
CARS = (-4.125, 4.125)
CAR_Z, CAR_W, CAR_D, DOOR_W, DOOR_H = -3.3, 2.6, 2.6, 1.3, 2.4


def lin(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def B(x, y, z):
    return (x, -z, y)


SOLID, SEATS, STANDS, WALKS = [], [], [], []


def solid(x0, x1, z0, z1, y0, y1):
    SOLID.append([round(min(x0, x1), 3), round(max(x0, x1), 3), round(min(z0, z1), 3), round(max(z0, z1), 3), round(y0, 3), round(y1, 3)])


def head(dx, dz):
    return round(math.atan2(-dx, -dz), 3)


class K:
    """Faces with their own corners: an albedo per face and whether it is a light (its emission strength)."""

    def __init__(self):
        self.v, self.f, self.c, self.e = [], [], [], []

    def face(self, pts, col, n=None, sub=0.0, emit=0.0, jit=0.0):
        col = lin(col) if isinstance(col, int) else col
        if n is not None:
            cr = [0.0, 0.0, 0.0]
            for k in range(len(pts)):
                a, b = pts[k], pts[(k + 1) % len(pts)]
                cr[0] += (a[1] - b[1]) * (a[2] + b[2]); cr[1] += (a[2] - b[2]) * (a[0] + b[0]); cr[2] += (a[0] - b[0]) * (a[1] + b[1])
            if cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0: pts = pts[::-1]
        if sub > 0 and len(pts) == 4:
            p0, p1, p2, p3 = pts
            L = lambda a, b: math.dist(a, b)
            nu, nv = max(1, math.ceil(L(p0, p1) / sub)), max(1, math.ceil(L(p0, p3) / sub))
            if nu * nv > 1:
                def at(u, v):
                    return tuple(p0[i] * (1 - u) * (1 - v) + p1[i] * u * (1 - v) + p2[i] * u * v + p3[i] * (1 - u) * v for i in range(3))
                for i in range(nu):
                    for j in range(nv):
                        c = col
                        if jit: k = 1 + (random.random() - 0.5) * jit; c = tuple(min(1, x * k) for x in col)
                        self._add([at(i / nu, j / nv), at((i + 1) / nu, j / nv), at((i + 1) / nu, (j + 1) / nv), at(i / nu, (j + 1) / nv)], c, emit)
                return
        self._add(pts, col, emit)

    def _add(self, pts, col, emit):
        i = len(self.v)
        self.v.extend(pts)
        self.f.append(list(range(i, i + len(pts))))
        self.c.append(col)
        self.e.append(emit)

    def box(self, x0, x1, y0, y1, z0, z1, col, skip='', sub=0.0, emit=0.0, top=None):
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
            if k not in skip: self.face(p, top if (k == 't' and top is not None) else col, n, sub, emit)

    def cyl(self, cx, cz, r, y0, y1, col, n=8, caps='t', r1=None):
        r1 = r if r1 is None else r1
        for i in range(n):
            a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
            p = [(cx + r * math.cos(a0), y0, cz + r * math.sin(a0)), (cx + r * math.cos(a1), y0, cz + r * math.sin(a1)),
                 (cx + r1 * math.cos(a1), y1, cz + r1 * math.sin(a1)), (cx + r1 * math.cos(a0), y1, cz + r1 * math.sin(a0))]
            am = (a0 + a1) / 2
            self.face(p, col, (math.cos(am), 0, math.sin(am)))
        if 't' in caps: self.face([(cx + r1 * math.cos(2 * math.pi * i / n), y1, cz + r1 * math.sin(2 * math.pi * i / n)) for i in range(n)], col, (0, 1, 0))

    def ball(self, cx, cy, cz, r, col, ry=None):
        ry = r if ry is None else ry
        n, m = 7, 4
        for i in range(n):
            for j in range(m):
                a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
                b0, b1 = math.pi * j / m - math.pi / 2, math.pi * (j + 1) / m - math.pi / 2
                P = lambda a, b: (cx + r * math.cos(b) * math.cos(a), cy + ry * math.sin(b), cz + r * math.cos(b) * math.sin(a))
                pts = [P(a0, b0), P(a0, b1), P(a1, b1), P(a1, b0)]
                if j == 0: pts = [P(a0, b0), P(a0, b1), P(a1, b1)]
                if j == m - 1: pts = [P(a0, b0), P(a0, b1), P(a1, b0)]
                am, bm = (a0 + a1) / 2, (b0 + b1) / 2
                self.face(pts, col, (math.cos(bm) * math.cos(am), math.sin(bm), math.cos(bm) * math.sin(am)))

    def obj(self, name, coll, loc=(0, 0, 0)):
        me = bpy.data.meshes.new(name)
        me.from_pydata([B(*p) for p in self.v], [], self.f)
        me.update()
        alb = me.color_attributes.new('albedo', 'FLOAT_COLOR', 'CORNER')
        flat = []
        for poly in me.polygons:
            c = self.c[poly.index]
            for k in range(poly.loop_total): flat.extend((c[0], c[1], c[2], 1.0))
        alb.data.foreach_set('color', flat)
        em = me.attributes.new('emit', 'FLOAT', 'FACE')
        em.data.foreach_set('value', self.e)
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0004)
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(name, me)
        ob.location = B(*loc)
        coll.objects.link(ob)
        return ob


# ── Furniture ────────────────────────────────────────────────────────────────

WHITE, STEEL, BLACK, WOOD, GREEN, LIME = 0xe9e7e2, 0xa9aeb2, 0x1c1e21, 0x8a6142, 0x3f7a36, 0x84cc16


def plant(m, x, y, z, s=1.0, pot=0x34373a):
    m.box(x - 0.3 * s, x + 0.3 * s, y, y + 0.55 * s, z - 0.3 * s, z + 0.3 * s, pot, skip='b')
    m.cyl(x, z, 0.03 * s, y + 0.5 * s, y + 1.2 * s, 0x5a4632, n=5, caps='')
    for (dx, dy, dz, r) in ((0, 1.35, 0, 0.42), (0.22, 1.1, 0.1, 0.32), (-0.2, 1.15, -0.12, 0.3), (0.05, 1.6, -0.05, 0.28)):
        m.ball(x + dx * s, y + dy * s, z + dz * s, r * s, (0.05, 0.16, 0.04) if dy < 1.2 else (0.06, 0.2, 0.05))
    solid(x - 0.3 * s, x + 0.3 * s, z - 0.3 * s, z + 0.3 * s, y - 0.2, y + 0.55 * s)


def tree(m, x, y, z):
    m.box(x - 0.7, x + 0.7, y, y + 0.8, z - 0.7, z + 0.7, 0xb9b1a3, skip='b', top=0x3b2f25)
    m.cyl(x, z, 0.09, y + 0.8, y + 3.4, 0x5c4a38, n=6, caps='')
    for (dx, dy, dz, r) in ((0, 4.3, 0, 1.2), (0.6, 3.6, 0.3, 0.8), (-0.6, 3.8, -0.3, 0.85), (0.2, 5.1, -0.2, 0.75), (-0.3, 3.3, 0.5, 0.6)):
        m.ball(x + dx, y + dy, z + dz, r, (0.04, 0.14, 0.035) if dy < 4 else (0.055, 0.18, 0.045))
    solid(x - 0.7, x + 0.7, z - 0.7, z + 0.7, y - 0.2, y + 0.8)


def chair(m, x, y, z, fx, fz, col=BLACK):
    """An office chair facing (fx, fz) (axis-aligned)."""
    m.cyl(x, z, 0.28, y + 0.04, y + 0.07, 0x2a2c2f, n=5, caps='t')
    m.cyl(x, z, 0.03, y + 0.07, y + 0.42, STEEL, n=5, caps='')
    m.box(x - 0.25, x + 0.25, y + 0.42, y + 0.5, z - 0.25, z + 0.25, col)
    bx, bz = x - fx * 0.24, z - fz * 0.24
    if fx: m.box(bx - 0.04, bx + 0.04, y + 0.55, y + 1.05, z - 0.23, z + 0.23, col)
    else: m.box(x - 0.23, x + 0.23, y + 0.55, y + 1.05, bz - 0.04, bz + 0.04, col)


def desk(m, x0, x1, z0, z1, y, screen_z, face):
    """A desk top on legs, a monitor at the back edge facing `face` (+1: +z), a chair in front."""
    m.box(x0, x1, y + 0.71, y + 0.74, z0, z1, WHITE)
    for lx in (x0 + 0.05, x1 - 0.08):
        m.box(lx, lx + 0.03, y, y + 0.71, z0 + 0.05, z1 - 0.05, 0x3a3d41, skip='tb')
    cx = (x0 + x1) / 2
    m.box(cx - 0.1, cx + 0.1, y + 0.74, y + 0.76, screen_z - 0.08, screen_z + 0.08, 0x2a2c2f)
    m.box(cx - 0.02, cx + 0.02, y + 0.76, y + 0.95, screen_z - 0.02, screen_z + 0.02, 0x2a2c2f)
    m.box(cx - 0.3, cx + 0.3, y + 0.92, y + 1.27, screen_z - 0.015, screen_z + 0.015, 0x15171a, skip='f' if face > 0 else 'k')
    zz = screen_z + face * 0.016
    m.face([(cx - 0.28, y + 0.94, zz), (cx + 0.28, y + 0.94, zz), (cx + 0.28, y + 1.25, zz), (cx - 0.28, y + 1.25, zz)],
           random.choice([(0.12, 0.2, 0.32), (0.18, 0.26, 0.34), (0.1, 0.24, 0.12), (0.22, 0.24, 0.3)]), (0, 0, face), emit=1.4)
    m.box(cx - 0.22, cx + 0.22, y + 0.74, y + 0.755, z0 + (z1 - z0) / 2 - face * 0.05 - 0.07, z0 + (z1 - z0) / 2 - face * 0.05 + 0.07, 0x2b2d30)
    cz = (z1 + 0.35) if face < 0 else (z0 - 0.35)
    cz = z0 - 0.4 if face > 0 else z1 + 0.4
    chair(m, cx + random.uniform(-0.1, 0.1), y, cz, 0, face)
    return (cx, cz)


def pod(m, cx, cz, y, seats):
    """Four desks back to back with a green fabric screen between: two columns along x, facing -z and +z."""
    for k, (x0, x1) in enumerate(((cx - 1.6, cx), (cx, cx + 1.6))):
        s1 = desk(m, x0 + 0.02, x1 - 0.02, cz - 0.8, cz, y, cz - 0.1, -1)
        s2 = desk(m, x0 + 0.02, x1 - 0.02, cz, cz + 0.8, y, cz + 0.1, 1)
        seats.append((s1[0], y, s1[1] + 0.05, head(0, 1)))
        seats.append((s2[0], y, s2[1] - 0.05, head(0, -1)))
    m.box(cx - 1.6, cx + 1.6, y + 0.74, y + 1.32, cz - 0.02, cz + 0.02, 0x5f7356)
    m.box(cx - 1.6, cx + 1.6, y + 1.32, y + 1.34, cz - 0.025, cz + 0.025, LIME, emit=0.0)
    solid(cx - 1.6, cx + 1.6, cz - 0.8, cz + 0.8, y - 0.2, y + 0.76)


def sofa(m, x, y, z, w, fx, fz, col=0x2f3a44):
    """A sofa `w` long, its seat facing (fx, fz)."""
    hw, d = w / 2, 0.9
    if fz:
        z0, z1 = (z - d / 2, z + d / 2)
        bz0, bz1 = (z0, z0 + 0.22) if fz > 0 else (z1 - 0.22, z1)
        m.box(x - hw, x + hw, y + 0.1, y + 0.45, z0, z1, col, skip='b')
        m.box(x - hw, x + hw, y + 0.45, y + 0.85, bz0, bz1, col)
        for ax in (x - hw, x + hw - 0.2): m.box(ax, ax + 0.2, y + 0.45, y + 0.65, z0, z1, col)
        solid(x - hw, x + hw, z0, z1, y - 0.2, y + 0.6)
    else:
        x0, x1 = (x - d / 2, x + d / 2)
        bx0, bx1 = (x0, x0 + 0.22) if fx > 0 else (x1 - 0.22, x1)
        m.box(x0, x1, y + 0.1, y + 0.45, z - hw, z + hw, col, skip='b')
        m.box(bx0, bx1, y + 0.45, y + 0.85, z - hw, z + hw, col)
        for az in (z - hw, z + hw - 0.2): m.box(x0, x1, y + 0.45, y + 0.65, az, az + 0.2, col)
        solid(x0, x1, z - hw, z + hw, y - 0.2, y + 0.6)
    for k in range(int(w // 0.9)):
        t = -hw + 0.45 + k * 0.9
        SEATS.append((x + t if fz else x + fx * 0.1, y, z + fz * 0.1 if fz else z + t, head(fx, fz), 'bench'))


def printer(m, x, y, z):
    """The HID Fargo DTC4500 (460 W x 249 H x 234 D mm), simplified from the owner's model: output card area on the
    left, the main body with its silver lid, LCD and blue button, the smoked input hopper on the right. Faces +z."""
    W, H, D = 0.46, 0.249, 0.234
    x0, z0 = x - W / 2, z - D / 2
    PL, SIL = 0x0a0a0b, 0x9fa2a6
    m.box(x0, x0 + 0.102, y, y + 0.16, z0, z0 + D, PL, skip='b')                       # output module
    m.box(x0 + 0.102, x0 + 0.342, y, y + 0.215, z0, z0 + D, PL, skip='b')              # main body
    m.box(x0 + 0.11, x0 + 0.334, y + 0.215, y + H, z0 + 0.01, z0 + D - 0.01, SIL)       # silver lid
    m.box(x0 + 0.342, x0 + W, y, y + 0.18, z0, z0 + D, PL, skip='b')                   # input module
    m.box(x0 + 0.352, x0 + W - 0.01, y + 0.18, y + 0.235, z0 + 0.02, z0 + D - 0.02, (0.14, 0.14, 0.15))   # smoked hopper cover
    zf = z0 + D + 0.002
    m.face([(x0 + 0.14, y + 0.15, zf), (x0 + 0.2, y + 0.15, zf), (x0 + 0.2, y + 0.18, zf), (x0 + 0.14, y + 0.18, zf)], (0.3, 0.42, 0.3), (0, 0, 1), emit=1.0)
    m.face([(x0 + 0.215, y + 0.155, zf), (x0 + 0.235, y + 0.155, zf), (x0 + 0.235, y + 0.175, zf), (x0 + 0.215, y + 0.175, zf)], (0.08, 0.3, 1.0), (0, 0, 1), emit=2.0)
    m.face([(x0 + 0.13, y + 0.04, zf), (x0 + 0.33, y + 0.04, zf), (x0 + 0.33, y + 0.11, zf), (x0 + 0.13, y + 0.11, zf)], 0x050506, (0, 0, 1))
    # Printed cards in the output hopper (a stack, the top one in the owner's colours) and blanks in the input.
    n = random.randint(3, 14)
    m.box(x0 + 0.012, x0 + 0.098, y + 0.16, y + 0.16 + n * 0.0016, z0 + 0.06, z0 + 0.2, 0xf0f0ee, skip='b',
          top=random.choice([(0.25, 0.6, 0.08), (0.05, 0.35, 0.6), (0.9, 0.9, 0.88), (0.1, 0.45, 0.2)]))


def bench(m, x0, x1, z0, z1, y):
    m.box(x0, x1, y + 0.72, y + 0.76, z0, z1, 0xdedcd6)
    m.box(x0 + 0.05, x1 - 0.05, y + 0.1, y + 0.72, z0 + 0.3, z0 + 0.33, 0x8e9296, skip='tb')
    for lx in (x0 + 0.05, x1 - 0.1):
        m.box(lx, lx + 0.05, y, y + 0.72, z0 + 0.05, z1 - 0.05, 0x6f7377, skip='tb')
    solid(x0, x1, z0, z1, y - 0.2, y + 0.77)


# ── The lift car (its door at the origin, facing +z) ─────────────────────────

def car():
    m = K()
    hw, D, H = CAR_W / 2, CAR_D, 2.7
    m.face([(-hw, 0, 0), (hw, 0, 0), (hw, 0, -D), (-hw, 0, -D)], 0x4a3e33, (0, 1, 0), sub=0.4)
    m.face([(-hw, H, 0), (hw, H, 0), (hw, H, -D), (-hw, H, -D)], 0xdedcd8, (0, -1, 0), sub=0.5)
    m.face([(-0.8, H - 0.01, -0.5), (0.8, H - 0.01, -0.5), (0.8, H - 0.01, -2.1), (-0.8, H - 0.01, -2.1)], (1, 0.97, 0.9), (0, -1, 0), emit=6.0)
    for sx in (-1, 1):
        m.face([(sx * hw, 0, 0), (sx * hw, 0, -D), (sx * hw, H, -D), (sx * hw, H, 0)], 0x9da3a8, (-sx, 0, 0), sub=0.4)
        m.box(sx * hw - sx * 0.05, sx * hw - sx * 0.02, 0.88, 0.93, -D + 0.15, -0.25, 0xc9ced2)
    m.face([(-hw, 0, -D), (hw, 0, -D), (hw, 0.9, -D), (-hw, 0.9, -D)], 0x9da3a8, (0, 0, 1), sub=0.4)
    m.face([(-hw, 0.9, -D), (hw, 0.9, -D), (hw, 2.3, -D), (-hw, 2.3, -D)], 0xaebdc7, (0, 0, 1), sub=0.4)     # mirror
    m.face([(-hw, 2.3, -D), (hw, 2.3, -D), (hw, H, -D), (-hw, H, -D)], 0x9da3a8, (0, 0, 1), sub=0.4)
    m.box(-hw + 0.1, hw - 0.1, 0.88, 0.93, -D + 0.02, -D + 0.05, 0xc9ced2)
    # Front wall, inside face, around the door; its reveal out to the landing (z 0..0.3); the button panel.
    dw = DOOR_W / 2
    for (x0, x1, y0, y1) in ((-hw, -dw, 0, H), (dw, hw, 0, H), (-dw, dw, DOOR_H, H)):
        m.face([(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)], 0x9da3a8, (0, 0, -1), sub=0.4)
    for sx in (-1, 1):
        m.face([(sx * dw, 0, 0), (sx * dw, 0, 0.3), (sx * dw, DOOR_H, 0.3), (sx * dw, DOOR_H, 0)], 0xb7bcc0, (-sx, 0, 0))
    m.face([(-dw, DOOR_H, 0), (dw, DOOR_H, 0), (dw, DOOR_H, 0.3), (-dw, DOOR_H, 0.3)], 0xb7bcc0, (0, -1, 0))
    m.face([(-dw, 0.005, 0), (dw, 0.005, 0), (dw, 0.005, 0.3), (-dw, 0.005, 0.3)], 0x8d9196, (0, 1, 0))
    m.box(0.85, 1.1, 0.95, 1.55, -0.03, 0, 0x101214)
    for k in range(3):
        m.face([(0.94, 1.08 + k * 0.14, -0.031), (1.01, 1.08 + k * 0.14, -0.031), (1.01, 1.15 + k * 0.14, -0.031), (0.94, 1.15 + k * 0.14, -0.031)], (0.9, 0.95, 1.0), (0, 0, -1), emit=2.0)
    return m


def core_face(m, y, z, col, h):
    """The lift wall at z with the two door holes and steel surrounds (lobby and office)."""
    xs = [-10, CARS[0] - DOOR_W / 2, CARS[0] + DOOR_W / 2, CARS[1] - DOOR_W / 2, CARS[1] + DOOR_W / 2, 10]
    for k in range(0, 6, 2): m.face([(xs[k], y, z), (xs[k + 1], y, z), (xs[k + 1], y + h, z), (xs[k], y + h, z)], col, (0, 0, 1), sub=1.0)
    for k in (1, 3): m.face([(xs[k], y + DOOR_H, z), (xs[k + 1], y + DOOR_H, z), (xs[k + 1], y + h, z), (xs[k], y + h, z)], col, (0, 0, 1), sub=1.0)
    for cx in CARS:
        dw = DOOR_W / 2
        m.box(cx - dw - 0.12, cx - dw, y, y + DOOR_H + 0.12, z, z + 0.04, 0xb7bcc0, skip='bk')
        m.box(cx + dw, cx + dw + 0.12, y, y + DOOR_H + 0.12, z, z + 0.04, 0xb7bcc0, skip='bk')
        m.box(cx - dw, cx + dw, y + DOOR_H, y + DOOR_H + 0.12, z, z + 0.04, 0xb7bcc0, skip='bk')
        m.box(cx + dw + 0.25, cx + dw + 0.37, y + 1.0, y + 1.3, z, z + 0.02, 0x15171a, skip='bk')
        m.face([(cx + dw + 0.28, y + 1.1, z + 0.021), (cx + dw + 0.34, y + 1.1, z + 0.021), (cx + dw + 0.34, y + 1.18, z + 0.021), (cx + dw + 0.28, y + 1.18, z + 0.021)], (0.9, 0.95, 1.0), (0, 0, 1), emit=2.0)


def core_solid(y0, y1, zb):
    """The lift core around the two cars (cavity = car + 0.15 m), from the door plane back to zb."""
    a0, a1 = CARS[0] - CAR_W / 2 - 0.15, CARS[0] + CAR_W / 2 + 0.15
    b0, b1 = CARS[1] - CAR_W / 2 - 0.15, CARS[1] + CAR_W / 2 + 0.15
    zf, zc = -3.2, CAR_Z - CAR_D - 0.15
    for (x0, x1) in ((-10, a0), (a1, b0), (b1, 10)): solid(x0, x1, zb, zf, y0, y1)
    solid(-10, 10, zb, zc, y0, y1)
    for cx in CARS:     # the front wall either side of each door, inside the cavity
        solid(cx - CAR_W / 2 - 0.15, cx - DOOR_W / 2, CAR_Z, zf, y0, y1); solid(cx + DOOR_W / 2, cx + CAR_W / 2 + 0.15, CAR_Z, zf, y0, y1)


# ── The lobby ────────────────────────────────────────────────────────────────

def lobby():
    m, g = K(), K()
    Y, H = YL, 15.0
    X0, X1, Z0, Z1 = -31, 31, -14, 10
    # Floor: honed travertine in 1.55 x 1.5 m slabs with a dark granite border and a runner from the doors to the gates.
    for i in range(40):
        for j in range(16):
            x0, z0 = X0 + i * 1.55, Z0 + j * 1.5
            x1, z1 = x0 + 1.55, z0 + 1.5
            edge = i == 0 or i == 39 or j == 0
            run = -2.2 < (x0 + x1) / 2 < 2.2 and z0 >= 0
            c = 0x3b3c3e if (edge or run) else (0xd8d1c4 if (i + j) % 2 else 0xd0c8ba)
            c = tuple(v * random.uniform(0.97, 1.03) for v in lin(c))
            m.face([(x0, Y, z1), (x1, Y, z1), (x1, Y, z0), (x0, Y, z0)], c, (0, 1, 0), sub=0.78)
    # Ceiling with light slots running east-west every 3 m.
    m.face([(X0, Y + H, Z0), (X1, Y + H, Z0), (X1, Y + H, Z1), (X0, Y + H, Z1)], 0xe6e5e1, (0, -1, 0), sub=1.5)
    for z in range(-12, 10, 3):
        m.face([(-29, Y + H - 0.02, z - 0.12), (29, Y + H - 0.02, z - 0.12), (29, Y + H - 0.02, z + 0.12), (-29, Y + H - 0.02, z + 0.12)], (1, 0.95, 0.86), (0, -1, 0), emit=22.0)
    # Side walls: limestone; back wall: walnut either side of the core.
    for sx in (-1, 1):
        x = sx * 31
        m.face([(x, Y, Z0), (x, Y, Z1), (x, Y + H, Z1), (x, Y + H, Z0)], 0xcfc5b4, (-sx, 0, 0), sub=1.5)
        for z in range(-12, 10, 4):
            m.box(x - sx * 0.02, x - sx * 0.035, Y, Y + H, z - 0.015, z + 0.015, 0xb3a996, skip='bk' if sx < 0 else 'bk')
    for (x0, x1) in ((X0, -10), (10, X1)):
        m.face([(x0, Y, Z0), (x1, Y, Z0), (x1, Y + H, Z0), (x0, Y + H, Z0)], 0x5a3d28, (0, 0, 1), sub=1.5)
        for k in range(int(x0) + 1, int(x1), 1):
            m.box(k - 0.03, k + 0.03, Y + 0.3, Y + H - 0.3, Z0, Z0 + 0.04, 0x47301f, skip='bk')
    # The logo wall behind reception: a light panel (the logo itself is the game's) with a wash light above.
    m.box(-25, -13, Y + 2.8, Y + 10.2, Z0, Z0 + 0.12, 0xf1f0ec, skip='bk')
    m.face([(-25, Y + 10.4, Z0 + 0.6), (-13, Y + 10.4, Z0 + 0.6), (-13, Y + 10.4, Z0 + 0.3), (-25, Y + 10.4, Z0 + 0.3)], (1, 0.96, 0.9), (0, -1, 0), emit=30.0)
    # A mural of speed lines in the owner's greens on the east part of the back wall.
    for k, (y, x0, x1) in enumerate(((3.2, 13, 27), (4.6, 15, 29), (6.0, 12, 24), (7.4, 17, 29), (8.8, 14, 26), (10.2, 19, 28))):
        c = [(0.25, 0.62, 0.05), (0.11, 0.45, 0.16), (0.42, 0.75, 0.08)][k % 3]
        m.box(x0, x1, Y + y, Y + y + 0.55, Z0, Z0 + 0.06, c, skip='bk')
    # Art on the side walls: two big abstract canvases.
    for (sx, z0, z1, y0, y1, pal) in ((-1, -9, -1, 4, 11, ((0.5, 0.36, 0.2), (0.08, 0.16, 0.3), (0.7, 0.6, 0.45), (0.12, 0.3, 0.12))),
                                      (1, -1, 7, 3.5, 10, ((0.06, 0.2, 0.32), (0.6, 0.52, 0.4), (0.2, 0.42, 0.1), (0.45, 0.1, 0.06)))):
        x = sx * 30.95
        m.box(x, x - sx * 0.08, Y + y0 - 0.1, Y + y1 + 0.1, z0 - 0.1, z1 + 0.1, 0x202020, skip='b')
        rows, cols = 3, 4
        for r in range(rows):
            for c in range(cols):
                za, zb = z0 + (z1 - z0) * c / cols, z0 + (z1 - z0) * (c + 1) / cols
                ya, yb = y0 + (y1 - y0) * r / rows, y0 + (y1 - y0) * (r + 1) / rows
                xx = x - sx * 0.085
                m.face([(xx, Y + ya, za), (xx, Y + ya, zb), (xx, Y + yb, zb), (xx, Y + yb, za)], pal[(r * 3 + c * 2 + (r * c)) % 4], (-sx, 0, 0))
    # The core: dark stone, lift doors in steel surrounds.
    core_face(m, Y, -3.2, 0x55585a, H)
    for sx in (-1, 1):
        m.face([(sx * 10, Y, Z0), (sx * 10, Y, -3.2), (sx * 10, Y + H, -3.2), (sx * 10, Y + H, Z0)], 0x55585a, (sx, 0, 0), sub=1.5)
    core_solid(-1, Y + H, Z0)
    # Gates: speed lanes, steel cabinets with black glass tops and green lamps; glass balustrades either side.
    for k in range(11):
        x = -6 + 1.2 * k
        m.box(x - 0.13, x + 0.13, Y, Y + 0.98, 0, 1.6, 0xb5babd, skip='b')
        m.box(x - 0.135, x + 0.135, Y + 0.98, Y + 1.02, -0.01, 1.61, 0x111418)
        m.box(x - 0.05, x + 0.05, Y + 1.021, Y + 1.025, 1.3, 1.5, (0.2, 0.9, 0.2), emit=4.0)
        solid(x - 0.14, x + 0.14, 0, 1.6, -1, Y + 1.02)
        for s in ((-1, 1) if 0 < k < 10 else ((1,) if k == 0 else (-1,))):
            g.face([(x + s * 0.13, Y + 0.45, 0.6), (x + s * 0.42, Y + 0.45, 0.6), (x + s * 0.42, Y + 1.35, 0.6), (x + s * 0.13, Y + 1.35, 0.6)], (0.75, 0.85, 0.85), (0, 0, 1))
    for (x0, x1) in ((-10, -6.13), (6.13, 10)):
        g.face([(x0, Y, 0.8), (x1, Y, 0.8), (x1, Y + 1.1, 0.8), (x0, Y + 1.1, 0.8)], (0.75, 0.85, 0.85), (0, 0, 1))
        m.box(x0, x1, Y + 1.1, Y + 1.14, 0.77, 0.83, 0xb5babd)
        solid(x0, x1, 0.7, 0.9, -1, Y + 1.14)
    for sx in (-1, 1):
        g.face([(sx * 10, Y, -3.2), (sx * 10, Y, 0.8), (sx * 10, Y + 1.1, 0.8), (sx * 10, Y + 1.1, -3.2)], (0.75, 0.85, 0.85), (sx, 0, 0))
        m.box(sx * 10 - 0.03, sx * 10 + 0.03, Y + 1.1, Y + 1.14, -3.2, 0.8, 0xb5babd)
        solid(sx * 10 - 0.1, sx * 10 + 0.1, -3.2, 0.8, -1, Y + 1.14)
    # Reception: a long white desk with a green light line at its foot (the logo on its front is the game's).
    m.box(-23, -13, Y, Y + 1.1, -0.4, 0, 0xeeeeea, skip='b')
    m.box(-23.1, -12.9, Y + 1.1, Y + 1.14, -0.5, 0.08, 0xd9d5cc)
    m.box(-23, -13, Y + 0.02, Y + 0.08, 0.0, 0.03, (0.4, 0.85, 0.1), emit=5.0)
    m.box(-23, -13, Y + 0.72, Y + 0.75, -1.3, -0.4, 0xe2ded6)
    m.box(-23, -22.7, Y, Y + 1.1, -1.3, -0.4, 0xeeeeea, skip='b'); m.box(-13.3, -13, Y, Y + 1.1, -1.3, -0.4, 0xeeeeea, skip='b')
    for x in (-20.5, -15.5):
        m.box(x - 0.25, x + 0.25, Y + 0.75, Y + 1.05, -0.8, -0.78, 0x15171a)
        chair(m, x, Y, -1.9, 0, 1)
        STANDS.append((x, Y, -1.7, head(0, 1)))
    solid(-23.1, -12.9, -1.3, 0.08, -1, Y + 1.14)
    # A guard's podium by the gates.
    m.box(7.2, 8.6, Y, Y + 1.1, 2.0, 2.7, 0x3a3d40, skip='b', top=0x15171a)
    solid(7.2, 8.6, 2.0, 2.7, -1, Y + 1.1); STANDS.append((7.9, Y, 3.3, head(0, -1)))
    # Seating: two lounges on rugs, low tables.
    for (cx, cz) in ((20.5, 2.5), (-24.5, 5.0)):
        m.box(cx - 5, cx + 5, Y, Y + 0.012, cz - 3, cz + 3, 0x2e3337, skip='b')
        sofa(m, cx, Y, cz - 1.9, 3.2, 0, 1); sofa(m, cx, Y, cz + 1.9, 3.2, 0, -1)
        sofa(m, cx - 3.4, Y, cz, 1.8, 1, 0, 0x6b5a46); sofa(m, cx + 3.4, Y, cz, 1.8, -1, 0, 0x6b5a46)
        m.box(cx - 1.1, cx + 1.1, Y + 0.3, Y + 0.38, cz - 0.55, cz + 0.55, 0x2b2420)
        m.box(cx - 1.0, cx + 1.0, Y, Y + 0.3, cz - 0.45, cz + 0.45, 0x1c1a18, skip='tb')
        m.box(cx - 0.2, cx + 0.15, Y + 0.38, Y + 0.41, cz - 0.15, cz + 0.12, (0.3, 0.6, 0.1))
        solid(cx - 1.1, cx + 1.1, cz - 0.55, cz + 0.55, -1, Y + 0.38)
    for (x, z) in ((-27.5, 7.6), (27.5, 7.6), (-27.5, -11.6), (27.5, -11.6), (-12.8, 6.5), (12.8, 6.5)):
        tree(m, x, Y, z)
    for (x, z) in ((-11.2, -2.4), (11.2, -2.4)):
        plant(m, x, Y, z, 1.2)
    # The glass front (behind the stone's mullions, speedscan.py) and its doors' gap (the leaves are the game's).
    for (x0, x1, y0) in ((-31, -1.6, 0), (1.6, 31, 0), (-1.6, 1.6, 2.6)):
        g.face([(x0, Y + y0 - 0.2 if y0 == 0 else Y + y0, 9.85), (x1, Y + y0 - 0.2 if y0 == 0 else Y + y0, 9.85), (x1, Y + 14.8, 9.85), (x0, Y + 14.8, 9.85)], (0.62, 0.72, 0.76), (0, 0, 1))
    m.box(-1.75, 1.75, Y + 2.6, Y + 2.75, 9.78, 9.92, 0x2b3239)
    for x in (-1.7, 1.7): m.box(x - 0.06, x + 0.06, Y, Y + 2.6, 9.78, 9.92, 0x2b3239, skip='b')
    # Collision: the glass either side of the doors, the gap above them, the ceiling slab.
    solid(-31, -1.6, 9.75, 9.95, -1, 15); solid(1.6, 31, 9.75, 9.95, -1, 15); solid(-1.6, 1.6, 9.75, 9.95, Y + 2.6, 15)
    solid(-31, 31, -14, 10, 15, 20)
    # People: visitors walking from the doors to the gates and back, and to reception.
    WALKS.append([[0, 8.5], [0, 3.2], [-2.4, 2.2], [-2.4, -2.0], [-2.4, 2.2], [0, 3.2]])
    WALKS.append([[1.2, 8.8], [-8, 4], [-17.6, 1.2], [-8, 4]])
    WALKS.append([[-1.0, 7.5], [3.6, 2.4], [3.6, -2.2], [3.6, 2.4]])
    return m, g


# ── The office floor (42) ────────────────────────────────────────────────────

def office():
    m, g = K(), K()
    Y, H = YO, 3.0
    X0, X1, Z0, Z1 = -33, 33, -36, 6
    zones = [(-10, 10, -3.2, 1, 0xcfc8bb), (-32.7, -20, -20, -6, 0x9a7350), (-32.7, -16, -35.7, -22, 0x9a9c9e)]

    def floor_col(x, z):
        for (a, b, c, d, col) in zones:
            if a <= x <= b and c <= z <= d: return col
        return 0x454b54
    # Floor: carpet tiles, stone at the lifts, oak in the kitchen, vinyl in the printer room.
    step = 0.75
    nx, nz = int((X1 - X0) / step), int((Z1 - Z0) / step)
    for i in range(nx):
        for j in range(nz):
            x0, z0 = X0 + i * step, Z0 + j * step
            cx, cz = x0 + step / 2, z0 + step / 2
            if -10 < cx < 10 and -16 < cz < -3.2: continue
            c = tuple(v * random.uniform(0.95, 1.05) for v in lin(floor_col(cx, cz)))
            m._add([(x0, Y, z0 + step), (x0 + step, Y, z0 + step), (x0 + step, Y, z0), (x0, Y, z0)], c, 0.0)
    # Ceiling and light panels on a 3 m grid.
    m.face([(X0, Y + H, Z0), (X1, Y + H, Z0), (X1, Y + H, Z1), (X0, Y + H, Z1)], 0xe8e8e6, (0, -1, 0), sub=1.0)
    for i in range(22):
        for j in range(14):
            x, z = X0 + 1.5 + i * 3, Z0 + 1.5 + j * 3
            if -11 < x < 11 and -17 < z < -2.5: continue
            m.face([(x - 0.6, Y + H - 0.01, z - 0.3), (x + 0.6, Y + H - 0.01, z - 0.3), (x + 0.6, Y + H - 0.01, z + 0.3), (x - 0.6, Y + H - 0.01, z + 0.3)], (1, 0.98, 0.94), (0, -1, 0), emit=14.0)
    # Perimeter: a low heater band, mullions on the facade's 3 m bays, the glass.
    D = 0.3
    for (a, b, c, d) in ((X0, X1, Z1 - D, Z1), (X0, X1, Z0, Z0 + D), (X0, X0 + D, Z0, Z1), (X1 - D, X1, Z0, Z1)):
        m.box(a, b, Y, Y + 0.38, c, d, 0x2c3035, skip='b')
        m.box(a, b, Y + H - 0.15, Y + H, c, d, 0xdcdcda, skip='t')
        solid(a, b, c, d, Y - 0.5, Y + H)
    for k in range(1, 22):
        x = X0 + 3 * k
        for z in (Z1 - 0.1, Z0 + 0.1): m.box(x - 0.04, x + 0.04, Y, Y + H, z - 0.06, z + 0.06, 0x30353a, skip='bt')
    for k in range(1, 14):
        z = Z0 + 3 * k
        for x in (X1 - 0.1, X0 + 0.1): m.box(x - 0.06, x + 0.06, Y, Y + H, z - 0.04, z + 0.04, 0x30353a, skip='bt')
    for (p, n) in (([(X0, Y, Z1 - 0.12), (X1, Y, Z1 - 0.12), (X1, Y + H, Z1 - 0.12), (X0, Y + H, Z1 - 0.12)], (0, 0, -1)),
                   ([(X0, Y, Z0 + 0.12), (X1, Y, Z0 + 0.12), (X1, Y + H, Z0 + 0.12), (X0, Y + H, Z0 + 0.12)], (0, 0, 1)),
                   ([(X0 + 0.12, Y, Z0), (X0 + 0.12, Y, Z1), (X0 + 0.12, Y + H, Z1), (X0 + 0.12, Y + H, Z0)], (1, 0, 0)),
                   ([(X1 - 0.12, Y, Z0), (X1 - 0.12, Y, Z1), (X1 - 0.12, Y + H, Z1), (X1 - 0.12, Y + H, Z0)], (-1, 0, 0))):
        g.face(p, (0.55, 0.62, 0.66), n)
    # The core: walnut on the lift side, pale elsewhere; washroom doors at the back.
    core_face(m, Y, -3.2, 0x6b4a32, H)
    for sx in (-1, 1):
        m.face([(sx * 10, Y, -16), (sx * 10, Y, -3.2), (sx * 10, Y + H, -3.2), (sx * 10, Y + H, -16)], 0xc4c1bb, (sx, 0, 0), sub=1.0)
    m.face([(-10, Y, -16), (10, Y, -16), (10, Y + H, -16), (-10, Y + H, -16)], 0xc4c1bb, (0, 0, -1), sub=1.0)
    for x in (-6, 6):
        m.box(x - 0.5, x + 0.5, Y, Y + 2.2, -16.04, -16, 0x8a6a4c, skip='bf')
    core_solid(Y - 0.5, Y + H, -16)
    # Printer room: glass to the office on the east, a white wall with a green stripe on the south, its door.
    for k in range(10):
        z = -35.7 + 1.37 * k
        m.box(-16.04, -15.96, Y, Y + H, z - 0.03, z + 0.03, 0x9aa0a5, skip='bt')
    g.face([(-16, Y, -35.7), (-16, Y, -22), (-16, Y + H, -22), (-16, Y + H, -35.7)], (0.7, 0.8, 0.82), (1, 0, 0))
    solid(-16.08, -15.92, -35.7, -22, Y - 0.5, Y + H)
    for (x0, x1) in ((-32.7, -19.2), (-17.6, -16)):
        m.box(x0, x1, Y, Y + H, -22.1, -21.9, 0xeceae6)
        m.box(x0, x1, Y + 1.0, Y + 1.12, -21.88, -21.87, (0.3, 0.65, 0.08)); m.box(x0, x1, Y + 1.0, Y + 1.12, -22.13, -22.12, (0.3, 0.65, 0.08))
        solid(x0, x1, -22.1, -21.9, Y - 0.5, Y + H)
    m.box(-19.2, -17.6, Y + 2.2, Y + H, -22.1, -21.9, 0xeceae6, skip='t')
    # The printers: three benches of eight DTC4500s, cards in their hoppers, a card stock shelf on the west glass.
    for zc in (-33.4, -29.8, -26.2):
        bench(m, -31.2, -18.4, zc - 0.4, zc + 0.4, Y)
        for k in range(8):
            printer(m, -30.4 + 1.6 * k, Y + 0.76, zc - 0.08)
            m.box(-30.4 + 1.6 * k + 0.32, -30.4 + 1.6 * k + 0.55, Y + 0.76, Y + 0.95, zc - 0.25, zc - 0.05, 0xd9d7d0)     # card box
        STANDS.append((-27.0, Y, zc + 0.85, head(0, -1)))
    for z in (-34.5, -30.5, -26.5):
        m.box(-32.6, -32.0, Y, Y + 2.0, z - 1.6, z + 1.6, 0x8e9296, skip='b')
        for sh in range(5):
            yy = Y + 0.15 + sh * 0.38
            for b in range(6):
                m.box(-32.0, -31.98, yy, yy + 0.26, z - 1.5 + b * 0.5, z - 1.1 + b * 0.5, random.choice([0xf0eee8, 0x2f6fb0, 0x6aa52a, 0xd9d7d0]), skip='bk')
        solid(-32.6, -32.0, z - 1.6, z + 1.6, Y - 0.5, Y + 2.0)
    # Kitchen: a counter along the west glass with a sink and the coffee machine, an island with stools, tables.
    m.box(-32.6, -31.9, Y, Y + 0.88, -19.4, -8, 0xf2f1ee, skip='b')
    m.box(-32.65, -31.85, Y + 0.88, Y + 0.92, -19.45, -7.95, 0x2b2d30)
    m.box(-32.45, -32.05, Y + 0.915, Y + 0.921, -14.2, -13.4, 0x8d9196)
    m.box(-32.5, -32.1, Y + 0.92, Y + 1.36, -10.4, -10.0, 0x111214)
    m.box(-32.6, -31.85, Y, Y + 2.05, -20.0, -19.4, 0xc9ccce, skip='b')
    solid(-32.7, -31.8, -20.0, -7.9, Y - 0.5, Y + 2.05)
    m.box(-27.2, -25.8, Y, Y + 0.9, -17, -10, 0x6b4a32, skip='b')
    m.box(-27.3, -25.7, Y + 0.9, Y + 0.95, -17.1, -9.9, 0xf2f1ee)
    solid(-27.3, -25.7, -17.1, -9.9, Y - 0.5, Y + 0.95)
    for k in range(5):
        z = -16 + 1.4 * k
        m.cyl(-24.9, z, 0.18, Y + 0.68, Y + 0.72, BLACK, n=6)
        m.cyl(-24.9, z, 0.025, Y, Y + 0.68, STEEL, n=4, caps='')
    for z in (-17.5, -13.0, -8.5):
        m.cyl(-21.5, z, 0.6, Y + 0.71, Y + 0.74, 0xf2f1ee, n=10)
        m.cyl(-21.5, z, 0.05, Y, Y + 0.71, 0x2b2d30, n=5, caps='')
        for (dx, dz) in ((0.9, 0), (-0.9, 0), (0, 0.9), (0, -0.9)):
            chair(m, -21.5 + dx, Y, z + dz, -dx / 0.9 if dx else 0, -dz / 0.9 if dz else 0, 0x4f6b3a)
        solid(-22.1, -20.9, z - 0.6, z + 0.6, Y - 0.5, Y + 0.74)
    STANDS.append((-28.0, Y, -13.0, head(1, 0))); STANDS.append((-31.4, Y, -10.6, head(-1, 0)))
    SEATS.append((-21.5 + 0.9, Y, -13.0, head(-1, 0), 'bench'))
    # Meeting rooms along the east glass: glass fronts with doors, white walls between, a table, chairs, a screen.
    rooms = ((-35.7, -26.0), (-26.0, -16.3), (-16.3, -6.6))
    for (z0, z1) in rooms:
        dz0, dz1 = z1 - 2.2, z1 - 1.1
        g.face([(23, Y, z0), (23, Y, dz0), (23, Y + H, dz0), (23, Y + H, z0)], (0.7, 0.8, 0.82), (-1, 0, 0))
        g.face([(23, Y, dz1), (23, Y, z1), (23, Y + H, z1), (23, Y + H, dz1)], (0.7, 0.8, 0.82), (-1, 0, 0))
        g.face([(23, Y + 2.2, dz0), (23, Y + 2.2, dz1), (23, Y + H, dz1), (23, Y + H, dz0)], (0.7, 0.8, 0.82), (-1, 0, 0))
        m.box(22.96, 23.04, Y + 2.2, Y + 2.26, dz0, dz1, 0x9aa0a5)
        for z in (z0, dz0, dz1, z1): m.box(22.96, 23.04, Y, Y + H, z - 0.03, z + 0.03, 0x9aa0a5, skip='bt')
        solid(22.92, 23.08, z0, dz0, Y - 0.5, Y + H); solid(22.92, 23.08, dz1, z1, Y - 0.5, Y + H)
        if z1 < -7: pass
        m.box(23, 32.7, Y, Y + H, z1 - 0.06, z1 + 0.06, 0xeceae6) if z1 < -7 else m.box(23, 32.7, Y, Y + H, z1 - 0.06, z1 + 0.06, 0xeceae6)
        solid(23, 32.7, z1 - 0.07, z1 + 0.07, Y - 0.5, Y + H)
        cz = (z0 + z1) / 2
        m.box(26.2, 30.2, Y + 0.72, Y + 0.76, cz - 0.7, cz + 0.7, 0x7a5638)
        m.box(27.6, 28.8, Y, Y + 0.72, cz - 0.3, cz + 0.3, 0x2b2d30, skip='tb')
        solid(26.2, 30.2, cz - 0.7, cz + 0.7, Y - 0.5, Y + 0.76)
        for k in range(4):
            x = 26.7 + k * 1.0
            chair(m, x, Y, cz - 1.15, 0, 1); chair(m, x, Y, cz + 1.15, 0, -1)
        m.box(26.5, 29.9, Y + 1.1, Y + 2.05, z0 + 0.07, z0 + 0.11, 0x0b0d10)
        m.face([(26.6, Y + 1.15, z0 + 0.111), (29.8, Y + 1.15, z0 + 0.111), (29.8, Y + 2.0, z0 + 0.111), (26.6, Y + 2.0, z0 + 0.111)], (0.1, 0.3, 0.12), (0, 0, 1), emit=1.6)
    SEATS.append((26.7, Y, -21.15 - 1.15 + 0.1, head(0, 1), 'bench')); SEATS.append((28.7, Y, -21.15 + 1.15 - 0.1, head(0, -1), 'bench'))
    # Desk pods: open plan south, north and east of the core.
    seats = []
    pods = [(x, 2.2) for x in (-29, -24.4, -19.8, -15.2, 15.2, 19.8, 24.4, 29)]
    pods += [(x, z) for x in (-11.5, -6.5, -1.5, 3.5, 8.5) for z in (-33.0, -28.0, -23.0, -18.8)]
    pods += [(x, z) for x in (13.6, 18.6) for z in (-33.0, -28.0, -23.0, -18.8, -13.6, -8.6)]
    for (cx, cz) in pods: pod(m, cx, cz, Y, seats)
    random.shuffle(seats)
    for s in seats[:30]: SEATS.append(s + ('desk',))
    # A lounge by the core and plants about the floor.
    sofa(m, -15.0, Y, -10.0, 2.4, 1, 0, 0x4f6b3a); sofa(m, -12.2, Y, -10.0, 2.4, -1, 0, 0x4f6b3a)
    for (x, z) in ((-12, 4.6), (12, 4.6), (-31.8, 4.6), (31.8, 4.6), (-14.5, -34.6), (21.6, -34.6), (21.6, -4.2), (-17, -4.2), (31.8, -4.6), (-31.8, -4.6)):
        plant(m, x, Y, z, 1.1)
    # Collision: the floor slab, the ceiling to the roof of the first shaft.
    WALKS.append([[-8, -1.5], [-8, -16.5 + 0.0], [-14, -17], [-14, -21], [-18.4, -21], [-18.4, -24.5], [-18.4, -21], [-14, -17], [-8, -16.5]])
    WALKS.append([[11.2, 0.0], [11.2, -16], [21, -16], [21, -5], [11.2, -5]])
    return m, g


# ── The roof deck ────────────────────────────────────────────────────────────

def roof():
    m, g = K(), K()
    Y = YR
    ring = ((-26, 26, -3, 1), (-26, 26, -31, -27), (-26, -22, -27, -3), (22, 26, -27, -3))
    for (x0, x1, z0, z1) in ring:
        # Ipe boards along the long side, every 0.6 m a little different.
        along = (x1 - x0) > (z1 - z0)
        n = int(((z1 - z0) if along else (x1 - x0)) / 0.6)
        for k in range(n):
            c = tuple(v * random.uniform(0.9, 1.08) for v in lin(0x7a5a40))
            if along: m.box(x0, x1, Y - 0.1, Y, z0 + k * 0.6 + 0.01, z0 + (k + 1) * 0.6 - 0.01, c, skip='b')
            else: m.box(x0 + k * 0.6 + 0.01, x0 + (k + 1) * 0.6 - 0.01, Y - 0.1, Y, z0, z1, c, skip='b')
        solid(x0, x1, z0, z1, Y - 0.3, Y)
    # Railings at the band's edge: steel posts, a top rail, glass panels (collision low enough to jump over).
    edges = (((-25.85, 0.85), (25.85, 0.85)), ((-25.85, -30.85), (25.85, -30.85)), ((-25.85, -30.85), (-25.85, 0.85)), ((25.85, -30.85), (25.85, 0.85)))
    for (a, b) in edges:
        L = math.dist(a, b); n = int(L / 1.6)
        for k in range(n + 1):
            x, z = a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n
            m.box(x - 0.04, x + 0.04, Y, Y + 1.1, z - 0.04, z + 0.04, 0x9aa3ab, skip='b')
        if a[1] == b[1]:
            m.box(a[0], b[0], Y + 1.08, Y + 1.14, a[1] - 0.05, a[1] + 0.05, 0xb8c1c8)
            g.face([(a[0], Y + 0.08, a[1]), (b[0], Y + 0.08, a[1]), (b[0], Y + 1.06, a[1]), (a[0], Y + 1.06, a[1])], (0.7, 0.8, 0.82), (0, 0, 1))
            solid(a[0], b[0], a[1] - 0.1, a[1] + 0.1, Y - 0.3, Y + 1.0)
        else:
            m.box(a[0] - 0.05, a[0] + 0.05, Y + 1.08, Y + 1.14, a[1], b[1], 0xb8c1c8)
            g.face([(a[0], Y + 0.08, a[1]), (a[0], Y + 0.08, b[1]), (a[0], Y + 1.06, b[1]), (a[0], Y + 1.06, a[1])], (0.7, 0.8, 0.82), (1, 0, 0))
            solid(a[0] - 0.1, a[0] + 0.1, a[1], b[1], Y - 0.3, Y + 1.0)
    # Coin binoculars along the south rail, facing out over the island.
    for x in (-17, -11, 11, 17):
        z = 0.2
        m.cyl(x, z, 0.12, Y, Y + 0.95, 0x3f7a36, n=8)
        m.box(x - 0.2, x + 0.2, Y + 0.95, Y + 1.25, z - 0.18, z + 0.18, 0x4a8a3e)
        for sx in (-0.09, 0.09):
            m.cyl(x + sx, z, 0.055, Y + 1.04, Y + 1.04, 0x111111, n=6, caps='')
            m.box(x + sx - 0.05, x + sx + 0.05, Y + 1.05, Y + 1.15, z + 0.18, z + 0.26, 0x15171a)
            m.box(x + sx - 0.035, x + sx + 0.035, Y + 1.07, Y + 1.13, z - 0.26, z - 0.18, 0x15171a)
        solid(x - 0.2, x + 0.2, z - 0.2, z + 0.2, Y - 0.3, Y + 1.25)
    STANDS.append((-11, Y, -0.45, head(0, 1))); STANDS.append((15.5, Y, -0.2, head(0, 1))); STANDS.append((-22.5, Y, -12, head(-1, 0)))
    # The stink-line vents at the lantern's corners: green stacks with a lime ring, where the lines rise from.
    for (x, z) in ((22, -2), (-22, -2), (22, -28), (-22, -28)):
        cx, cz = x + (1.6 if x > 0 else -1.6), z + (0.6 if z > -15 else -0.6)
        cx, cz = x, z
        m.cyl(cx, cz, 0.85, Y, Y + 0.85, 0x2d5f2a, n=12, caps='')
        m.cyl(cx, cz, 0.92, Y + 0.85, Y + 1.0, (0.45, 0.8, 0.08), n=12)
        m.cyl(cx, cz, 0.6, Y + 1.0, Y + 1.02, 0x101210, n=12)
        solid(cx - 0.9, cx + 0.9, cz - 0.9, cz + 0.9, Y - 0.3, Y + 1.0)
    # Benches and planters on the south deck.
    for x in (-6.5, 6.5):
        m.box(x - 0.9, x + 0.9, Y + 0.4, Y + 0.45, -2.6, -2.15, 0x8a6142)
        for lx in (x - 0.8, x + 0.75): m.box(lx, lx + 0.05, Y, Y + 0.4, -2.55, -2.2, 0x3a3d41)
        solid(x - 0.9, x + 0.9, -2.6, -2.15, Y - 0.3, Y + 0.45)
    SEATS.append((6.5, Y, -2.3, head(0, 1), 'bench'))
    for (x, z) in ((-24, -0.5), (24, -0.5), (-24, -29), (24, -29)):
        m.box(x - 0.8, x + 0.8, Y, Y + 0.7, z - 0.8, z + 0.8, 0x6e6a62, top=0x3b2f25)
        for k in range(4): m.ball(x + (k % 2 - 0.5) * 0.6, Y + 0.95, z + (k // 2 - 0.5) * 0.6, 0.38, (0.06, 0.2, 0.05))
        solid(x - 0.8, x + 0.8, z - 0.8, z + 0.8, Y - 0.3, Y + 0.7)
    # The landing: steel frames round the two door holes in the lantern glass, call buttons.
    for cx in CARS:
        dw = DOOR_W / 2
        m.box(cx - dw - 0.12, cx - dw, Y, Y + DOOR_H + 0.12, -3.0, -2.9, 0xb7bcc0, skip='bk')
        m.box(cx + dw, cx + dw + 0.12, Y, Y + DOOR_H + 0.12, -3.0, -2.9, 0xb7bcc0, skip='bk')
        m.box(cx - dw, cx + dw, Y + DOOR_H, Y + DOOR_H + 0.12, -3.0, -2.9, 0xb7bcc0, skip='bk')
        m.box(cx + dw + 0.2, cx + dw + 0.32, Y + 1.0, Y + 1.3, -3.0, -2.97, 0x15171a, skip='bk')
    # The lantern is solid round the cars (collision only).
    a0, a1 = CARS[0] - CAR_W / 2 - 0.15, CARS[0] + CAR_W / 2 + 0.15
    b0, b1 = CARS[1] - CAR_W / 2 - 0.15, CARS[1] + CAR_W / 2 + 0.15
    for (x0, x1) in ((-22, a0), (a1, b0), (b1, 22)): solid(x0, x1, -27, -3, Y - 0.3, 348)
    solid(-22, 22, -27, CAR_Z - CAR_D - 0.15, Y - 0.3, 348)
    for cx in CARS:
        solid(cx - CAR_W / 2 - 0.15, cx - DOOR_W / 2, CAR_Z, -3.0, Y - 0.3, 348); solid(cx + DOOR_W / 2, cx + CAR_W / 2 + 0.15, CAR_Z, -3.0, Y - 0.3, 348)
        solid(cx - CAR_W / 2 - 0.15, cx + CAR_W / 2 + 0.15, CAR_Z - CAR_D - 0.15, -3.0, Y + 2.7, 348)
    return m, g


# ── Light ────────────────────────────────────────────────────────────────────

def cycles_gpu(sc):
    sc.render.engine = 'CYCLES'
    try:
        pr = bpy.context.preferences.addons['cycles'].preferences
        for t in ('OPTIX', 'CUDA'):
            try:
                pr.compute_device_type = t; pr.get_devices()
                if any(d.type == t for d in pr.devices):
                    for d in pr.devices: d.use = d.type == t
                    sc.cycles.device = 'GPU'; return t
            except Exception: pass
    except Exception: pass
    sc.cycles.device = 'CPU'; return 'CPU'


def materials(ob, strength):
    md = bpy.data.materials.new(ob.name + '_d'); md.use_nodes = True
    nt = md.node_tree; nt.nodes.clear()
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'albedo'
    df = nt.nodes.new('ShaderNodeBsdfDiffuse'); out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(at.outputs['Color'], df.inputs['Color']); nt.links.new(df.outputs[0], out.inputs[0])
    me_ = bpy.data.materials.new(ob.name + '_e'); me_.use_nodes = True
    nt = me_.node_tree; nt.nodes.clear()
    at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'albedo'
    em = nt.nodes.new('ShaderNodeEmission'); out = nt.nodes.new('ShaderNodeOutputMaterial')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(at.outputs['Color'], em.inputs['Color']); nt.links.new(em.outputs[0], out.inputs[0])
    # The face's own strength: one emission material per distinct strength.
    me = ob.data
    me.materials.append(md)
    ev = [0.0] * len(me.polygons); me.attributes['emit'].data.foreach_get('value', ev)
    strengths = sorted(set(e for e in ev if e > 0))
    for s in strengths:
        mm = me_.copy(); mm.node_tree.nodes['Emission'].inputs['Strength'].default_value = s * strength
        me.materials.append(mm)
    idx = [0 if e <= 0 else 1 + strengths.index(e) for e in ev]
    me.polygons.foreach_set('material_index', idx)
    return ev


def corners(ob):
    me = ob.data
    alb = me.color_attributes['albedo']
    a = [0.0] * (len(me.loops) * 4); alb.data.foreach_get('color', a)
    return a


def fallback_light(ob, lights, amb):
    """Light from point stand-ins for the emitters, cosine and distance squared, no shadows; plus an ambient."""
    me = ob.data
    lit = me.color_attributes['lit']
    a = corners(ob); out = [0.0] * len(a)
    mw = ob.matrix_world
    for poly in me.polygons:
        n = mw.to_3x3() @ poly.normal
        for li in poly.loop_indices:
            p = mw @ me.vertices[me.loops[li].vertex_index].co
            e = amb
            for (lp, s) in lights:
                d = lp - p; r2 = max(0.5, d.length_squared)
                c = max(0.0, n.dot(d.normalized()))
                e += s * c / r2
            for k in range(3): out[li * 4 + k] = a[li * 4 + k] * e
            out[li * 4 + 3] = 1.0
    lit.data.foreach_set('color', out)


def finish(ob, ev, target, glow=1.0):
    """Lights glow in their own colour; scale so the light on the floor-facing faces averages `target`; drop the albedo."""
    me = ob.data
    lit = me.color_attributes['lit']
    a = corners(ob); L = [0.0] * len(a); lit.data.foreach_get('color', L)
    s, n = 0.0, 0
    up = []
    for poly in me.polygons:
        nz = poly.normal.z
        for li in poly.loop_indices:
            if ev[poly.index] <= 0 and nz > 0.9:
                # The light falling on the floor (the bake over the albedo), so a dark carpet is not lifted to grey.
                la = 0.2126 * a[li * 4] + 0.7152 * a[li * 4 + 1] + 0.0722 * a[li * 4 + 2]
                if la > 0.02: s += (0.2126 * L[li * 4] + 0.7152 * L[li * 4 + 1] + 0.0722 * L[li * 4 + 2]) / la; n += 1
    k = target / max(1e-4, s / max(1, n))
    for poly in me.polygons:
        for li in poly.loop_indices:
            if ev[poly.index] > 0:
                for c in range(3): L[li * 4 + c] = min(1.0, a[li * 4 + c] * glow)
            else:
                for c in range(3): L[li * 4 + c] = min(1.0, L[li * 4 + c] * k)
            L[li * 4 + 3] = 1.0
    lit.data.foreach_set('color', L)
    me.color_attributes.remove(me.color_attributes['albedo'])
    lit = me.color_attributes['lit']
    me.color_attributes.active_color = lit
    try: me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception: pass
    return round(k, 3)


def plain(ob):
    me = ob.data
    alb = me.color_attributes['albedo']
    me.color_attributes.active_color = alb


def export(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs: ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=False, export_tangents=False, export_materials='NONE',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False,
                              export_skins=False, export_morph=False, export_extras=False)
    return round(os.path.getsize(path) / 1000)


def colors8(path):
    """Rewrite the GLB with its vertex colours as normalized bytes instead of floats (a third of the size)."""
    import struct
    b = open(path, 'rb').read()
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])
    bin0 = 20 + jl + 8
    cols = set()
    for me in j['meshes']:
        for pr in me['primitives']:
            if 'COLOR_0' in pr['attributes']: cols.add(pr['attributes']['COLOR_0'])
    conv = {}
    for ai in cols:
        a = j['accessors'][ai]
        ct = a['componentType']
        if ct not in (5126, 5123): continue
        bv = j['bufferViews'][a['bufferView']]
        n, comp = a['count'], {'VEC3': 3, 'VEC4': 4}[a['type']]
        off = bin0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        if ct == 5126: fl = struct.unpack_from('<%df' % (n * comp), b, off)
        else:
            st = bv.get('byteStride', comp * 2)
            fl = [struct.unpack_from('<H', b, off + i * st + k * 2)[0] / 65535 for i in range(n) for k in range(comp)]
        q = bytearray()
        for i in range(n):
            px = [max(0, min(255, round(fl[i * comp + k] * 255))) for k in range(comp)] + ([255] if comp == 3 else [])
            q += bytes(px)
        conv[a['bufferView']] = bytes(q)
        a['componentType'] = 5121; a['normalized'] = True; a['type'] = 'VEC4'; a.pop('byteOffset', None)
        a.pop('min', None); a.pop('max', None)
    out = bytearray()
    for vi, bv in enumerate(j['bufferViews']):
        data = conv.get(vi)
        if data is None: data = b[bin0 + bv.get('byteOffset', 0): bin0 + bv.get('byteOffset', 0) + bv['byteLength']]
        while len(out) % 4: out += b'\x00'
        bv['byteOffset'] = len(out); bv['byteLength'] = len(data); bv.pop('byteStride', None) if vi in conv else None
        out += data
    while len(out) % 4: out += b'\x00'
    j['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total)); f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)
    return round(total / 1000)


def show(target=None):
    try:
        for area in bpy.context.screen.areas:
            if area.type == 'VIEW_3D':
                sp = area.spaces.active
                sp.shading.type = 'SOLID'; sp.shading.color_type = 'VERTEX'
                sp.clip_end = 5000
                with bpy.context.temp_override(area=area, region=[r for r in area.regions if r.type == 'WINDOW'][0]):
                    bpy.ops.view3d.view_all()
        bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
    except Exception as e:
        print('SSI_VIEW', e)


def main():
    t0 = time.time()
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True)
    out = {}
    lm, lg = lobby(); om, og = office(); rm, rg = roof(); cm = car()
    obs = {
        'in_lobby': lm.obj('in_lobby', coll), 'in_glass_lobby': lg.obj('in_glass_lobby', coll),
        'in_office': om.obj('in_office', coll), 'in_glass_office': og.obj('in_glass_office', coll),
        'in_roof': rm.obj('in_roof', coll), 'in_glass_roof': rg.obj('in_glass_roof', coll),
        'in_car': cm.obj('in_car', coll, (CARS[0], YL, CAR_Z)),
    }
    out['faces'] = {k: len(o.data.polygons) for k, o in obs.items()}
    print('SSI_BUILT', json.dumps(out['faces']), round(time.time() - t0, 1), flush=True)
    show()
    baked = ['in_lobby', 'in_office', 'in_car']
    evs = {}
    for k in baked:
        ob = obs[k]
        ob.data.color_attributes.new('lit', 'FLOAT_COLOR', 'CORNER')
        evs[k] = materials(ob, 1.0)
        ob.data.color_attributes.active_color = ob.data.color_attributes['lit']
    for k in obs:
        if k not in baked: obs[k].hide_render = True; plain(obs[k])
    sc = bpy.context.scene
    done = False
    if '--no-bake' not in FLAGS:
        try:
            out['device'] = cycles_gpu(sc)
            sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = False
            w = bpy.data.worlds.new('ssi_sky'); sc.world = w; w.use_nodes = True
            bg = w.node_tree.nodes.get('Background')
            if bg: bg.inputs[0].default_value = (0.62, 0.74, 0.95, 1); bg.inputs[1].default_value = 0.9
            sc.render.bake.target = 'VERTEX_COLORS'
            sc.render.bake.use_pass_direct = True; sc.render.bake.use_pass_indirect = True; sc.render.bake.use_pass_color = True
            bpy.ops.object.select_all(action='DESELECT')
            for k in baked: obs[k].select_set(True)
            bpy.context.view_layer.objects.active = obs['in_lobby']
            t1 = time.time()
            bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT', 'COLOR'}, target='VERTEX_COLORS', use_clear=True, margin=0)
            out['bake_s'] = round(time.time() - t1, 1)
            done = True
        except Exception as e:
            out['bake_error'] = str(e)[:300]
    if not done:
        from mathutils import Vector
        for k in baked:
            ob = obs[k]; me = ob.data; mw = ob.matrix_world
            ev = evs[k]; L = []
            for poly in me.polygons:
                if ev[poly.index] >= 5: L.append((mw @ poly.center + (mw.to_3x3() @ poly.normal) * 0.3, ev[poly.index] * poly.area))
            fallback_light(ob, L, 0.25)
    out['scale'] = {}
    for k, tgt in (('in_lobby', 0.82), ('in_office', 0.78), ('in_car', 0.62)):
        out['scale'][k] = finish(obs[k], evs[k], tgt)
    for ob in obs.values(): ob.data.materials.clear()
    out['speedscan_int_kB'] = export(list(obs.values()), os.path.join(OUT, 'speedscan_int.glb'))
    out['speedscan_int_kB_bytes'] = colors8(os.path.join(OUT, 'speedscan_int.glb'))
    with open(os.path.join(OUT, 'speedscan_int.json'), 'w') as f:
        json.dump({'solid': SOLID, 'seats': [list(s) for s in SEATS], 'stands': [list(s) for s in STANDS], 'walks': WALKS}, f, separators=(',', ':'))
    out['json_kB'] = round(os.path.getsize(os.path.join(OUT, 'speedscan_int.json')) / 1000)
    out['solids'] = len(SOLID); out['s'] = round(time.time() - t0, 1)
    show()
    print('SSI_META ' + json.dumps(out), flush=True)
    sys.stdout.flush()
    os._exit(0)


main()
