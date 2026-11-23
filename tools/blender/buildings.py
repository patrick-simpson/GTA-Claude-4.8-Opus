# Tepid Falls' buildings, modelled in Blender by script and exported as .glb (the brief: tools/briefs/tepid-waterville.md;
# the real buildings each design follows, and their invented names: tools/briefs/tepid-reference.md).
#
#   blender --factory-startup --python tools/blender/buildings.py --python-expr "import bpy; bpy.ops.wm.quit_blender()" -- [names...] [--no-bake] [--no-export]
#   (with its window showing, never --background: the owner watches the screen)
#
# Writes, in public/models (BLD_OUT overrides the folder for a trial):
#   mainst.glb        every design at three levels of detail: <name>_0 (near: window reveals, sash frames and
#                     muntins, sills, lintels and arches, bracketed or corbelled cornices, gables with brick relief,
#                     shopfronts with recessed doors and a lit room behind the glass, awnings), <name>_1 (street:
#                     the same outline with the small parts left out) and <name>_2 (far: the box, window holes and
#                     cornice only); <name>_0g and <name>_1g are the shopfront glass, drawn see-through.
#   mainst_far.glb    the <name>_2 meshes alone: the whole file the phone preset fetches.
#   mainst_o.webp     ambient occlusion of every <name>_0, baked by Cycles into one atlas (the near meshes' only UV).
#   mainst_bn.webp    tangent-space normals of a running-bond brick wall, 1.6 m x 1.0075 m per repeat, baked from a
#                     height field of bricks and recessed mortar; mainst_bc.webp the matching brick-to-brick colour.
#   shots/blender/mainst_sheet.png  a still of the near levels side by side.
#
# Frame: every design is authored in the GAME's frame with its front-left corner at the origin: x along the
# frontage (0..w, left to right as seen from the street), y up from the sidewalk, z out of the facade toward the
# street (the facade's wall plane is z = 0, the building runs back to z = -D). B() turns that into Blender's Z-up
# frame and the glTF exporter turns it back. src/world/mainStreetAssets.ts stretches a design to the exact
# frontage (x) and lot depth (z) it is given, never in y.
#
# The contract with src/world/mainStreetAssets.ts (keep DESIGNS there in step with META printed at the end):
#   * Albedo is the vertex colour (linear, already times occlusion on levels 1 and 2). Its ALPHA says what the face is:
#       1.0          brick: the game lays the brick maps over it, in meters, from position and normal;
#       0.0          anything else that is not glass: stone, wood, iron, canvas, roofing;
#       0.02 - 0.98  a window or a room behind a shopfront; at night the higher half of these light up.
#   * Nothing is smoothed: every face has its own corners.

import bpy, bmesh, sys, os, json, random
from math import sin, cos, pi, radians, sqrt, atan2
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.environ.get('BLD_OUT') or os.path.join(ROOT, 'public', 'models')
SHOTS = os.path.join(ROOT, 'shots', 'blender')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FLAGS = {a for a in ARGS if a.startswith('--')}
ONLY = [a for a in ARGS if not a.startswith('--')]
AO_N = 2048
BRICK_W, BRICK_H = 1.6, 1.0075        # one repeat of the brick maps, meters: 8 bricks by 13 courses


def lin(hex_):
    """sRGB hex to linear RGB."""
    c = [((hex_ >> s) & 255) / 255 for s in (16, 8, 0)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def B(x, y, z):
    return (x, -z, y)


def shade(hex_, k):
    r, g, b = [min(255, int(((hex_ >> s) & 255) * k)) for s in (16, 8, 0)]
    return (r << 16) | (g << 8) | b


# ── Mesh accumulator ─────────────────────────────────────────────────────────

class Mesh:
    """Faces with their own corners, a colour and an alpha (see the contract above) each."""

    def __init__(self):
        self.v, self.f, self.c = [], [], []

    def face(self, pts, hex_, a=0.0, n=None):
        """Polygon in game coordinates; if n is given the winding is turned to face it."""
        if n is not None and len(pts) >= 3:
            p0, p1, p2 = (Vector(p) for p in pts[:3])
            cr = (p1 - p0).cross(p2 - p0)
            if cr.length < 1e-12 and len(pts) > 3: cr = (p2 - p0).cross(Vector(pts[3]) - p0)
            if cr.dot(Vector(n)) < 0: pts = pts[::-1]
        i = len(self.v)
        self.v.extend(pts)
        self.f.append(list(range(i, i + len(pts))))
        self.c.append((lin(hex_) if isinstance(hex_, int) else hex_) + (a,))

    def quad_z(self, x0, x1, y0, y1, z, hex_, a=0.0, nz=1):
        self.face([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], hex_, a, (0, 0, nz))

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

    def prism(self, poly, z0, z1, hex_, a=0.0, back=False):
        """A vertical slab: the polygon (x, y) in the plane, extruded from z0 to z1."""
        self.face([(x, y, z1) for x, y in poly], hex_, a, (0, 0, 1))
        if back: self.face([(x, y, z0) for x, y in poly], hex_, a, (0, 0, -1))
        m = len(poly)
        cx = sum(p[0] for p in poly) / m; cy = sum(p[1] for p in poly) / m
        for i in range(m):
            (ax, ay), (bx, by) = poly[i], poly[(i + 1) % m]
            nx, ny = by - ay, -(bx - ax)
            if nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0: nx, ny = -nx, -ny
            self.face([(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)], hex_, a, (nx, ny, 0))

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


# ── Specification of a design ────────────────────────────────────────────────
# floors: storey heights, ground floor first. bays: per floor above the ground, a list of window centres is made from
# `groups` (bays per group) with pilasters between groups. win: shape per upper floor ('seg' segmental arch, 'round',
# 'flat' stone lintel, 'splay' splayed brick lintel, 'iron' cast-iron hood, 'grid' sheet-metal frame), w, h, panes
# ('1/1', '2/2', '6/6', '12/12'), pair (two sashes side by side). cornice: 'wood' bracketed, 'corbel' stepped brick,
# 'stone' plain coping, 'deco' stepped parapet with piers. gables: per group 'tri' / 'seg' / None.

DESIGNS = {
    # Second Guess Blocks: three of the six gabled Queen Anne blocks of the row (a design of three, placed twice).
    'secondguess': dict(w=22.8, D=18, floors=[4.6, 3.8, 3.7], brick=0x7d3b2d, stone=0xb1aca1, trim=0x3b3730,
                        groups=[3, 3, 3], pil=0.62, win=[dict(shape='seg', w=1.05, h=2.2), dict(shape='splay', w=1.0, h=2.0)],
                        belts=True, cornice='wood', par=0.9, gables=['tri', 'seg', 'tri'], zig=True,
                        shop=dict(units=3, pier='granite', col=0x26302a, awn=[0x2c4a3a, None, 0x8c2f25]), plaques=True),
    # Hemming & Hawing Hardware: four storeys, three bays of paired sash, continuous granite sills, splayed arches.
    'hemming': dict(w=9.8, D=20, floors=[4.6, 3.6, 3.5, 3.5], brick=0x86432f, stone=0xa9a59b, trim=0x2f2b27,
                    groups=[3], pil=0.0, win=[dict(shape='splay', w=1.75, h=2.15, pair=True)] * 3, csill=True,
                    cornice='corbel', par=1.1, shop=dict(units=1, pier='iron', col=0x6a2620, awn=[0x6a2620])),
    # Monotony Ward: Georgian Revival department store, seven bays, keystone lintels, slate mansard with dormers.
    'monotony': dict(w=24.0, D=24, floors=[5.0, 3.7, 3.6], brick=0x8a4332, stone=0xe9e4d6, trim=0xf1ede2,
                     groups=[7], pil=0.0, win=[dict(shape='flat', w=1.4, h=2.3, panes='6/6', key=True)] * 2,
                     cornice='wood', par=0.3, mansard=0x4f545a, shop=dict(units=3, pier='stone', col=0x1f2a36, awn=[None, None, None])),
    # The Bleached Block: blonde brick, three bays, plain Commercial Style.
    'bleached': dict(w=10.2, D=17, floors=[4.4, 3.5, 3.5], brick=0xd2bf96, stone=0xc8c2b4, trim=0x5b5a55,
                     groups=[3], pil=0.0, win=[dict(shape='flat', w=1.5, h=2.1, pair=False)] * 2,
                     cornice='stone', par=1.0, shop=dict(units=2, pier='granite', col=0x3a3a3a, awn=[0xc9892e, None])),
    # Lukewarm Trust Co.: Art Deco bank block, buff brick, piers running up through a stepped parapet.
    'lukewarm': dict(w=15.4, D=22, floors=[5.0, 3.6, 3.6, 3.6], brick=0xcdb791, stone=0xd8d0bd, trim=0x24282a,
                     groups=[6], pil=0.0, win=[dict(shape='deco', w=1.25, h=2.4)] * 3,
                     cornice='deco', par=1.6, shop=dict(units=2, pier='stone', col=0x1d2326, awn=[None, None])),
    # Overdue Row: half of a long Greek Revival row, granite lintels and sills, name blocks under the top floor.
    'overdue': dict(w=15.6, D=16, floors=[4.4, 3.4, 3.3, 3.2], brick=0x91503b, stone=0xb7b2a7, trim=0x3d3a36,
                    groups=[6], pil=0.0, win=[dict(shape='flat', w=1.05, h=1.95, panes='1/1')] * 3,
                    cornice='stone', par=0.8, plaques=True, shop=dict(units=2, pier='granite', col=0x25395c, awn=[0x25395c, 0x8c2f25])),
    # The Chaperone Block: four storeys, three bays, belt course, splayed lintels.
    'chaperone': dict(w=8.8, D=17, floors=[4.4, 3.5, 3.4, 3.4], brick=0x9a5640, stone=0xbdb6a6, trim=0x4a3f36,
                      groups=[3], pil=0.0, win=[dict(shape='splay', w=1.0, h=2.0)] * 3, belts=True,
                      cornice='corbel', par=1.0, shop=dict(units=1, pier='iron', col=0x2f5a57, awn=[0x2f5a57])),
    # Pressed-for-Time Block: one of three Romanesque sections, pressed red brick with grey sandstone, round arches up top.
    'pressed': dict(w=9.0, D=18, floors=[4.5, 3.7, 3.7], brick=0x7a2c22, stone=0x9d998d, trim=0x2a2522,
                    groups=[3], pil=0.0, win=[dict(shape='flat', w=1.0, h=2.2), dict(shape='round', w=1.0, h=2.3)],
                    belts=True, cornice='corbel', par=1.3, shop=dict(units=1, pier='stone', col=0x4a2a22, awn=[None])),
    # Grid & Bear It Building: five bays of pressed sheet-metal framing between two wide brick piers.
    'gridbear': dict(w=10.4, D=18, floors=[4.4, 3.6, 3.6], brick=0x8e4a38, stone=0xb2ab9d, trim=0x55625a,
                     groups=[5], pil=0.0, side=1.3, win=[dict(shape='grid', w=1.35, h=2.4)] * 2,
                     cornice='wood', par=0.6, shop=dict(units=1, pier='iron', col=0x55625a, awn=[0xd9cfb4])),
    # Jack-of-Some-Trades Co.: two storeys, Colonial Revival, four bays, steel beam over a wide shopfront.
    'jack': dict(w=10.0, D=16, floors=[4.6, 3.8], brick=0x8c4637, stone=0xe6e0d0, trim=0xefeadc,
                 groups=[4], pil=0.0, win=[dict(shape='flat', w=1.15, h=2.2, panes='6/6', key=True)],
                 cornice='wood', par=1.1, shop=dict(units=1, pier='granite', col=0x2c4a3a, awn=[0x2c4a3a])),
    # Scraping-the-Barrel Block: 1850 Greek Revival half with 12/12 sash and cast-iron lintels.
    'barrel': dict(w=13.8, D=17, floors=[4.4, 3.5, 3.4], brick=0x8f4e3a, stone=0xb4ae9f, trim=0x2b2b2b,
                   groups=[6], pil=0.0, win=[dict(shape='iron', w=1.05, h=2.25, panes='12/12')] * 2,
                   cornice='stone', par=0.7, shop=dict(units=2, pier='iron', col=0x6a2620, awn=[None, 0x8c2f25])),
    # Small Change Five-and-Ten: two storeys of buff brick, a band of small paired windows over a long signboard.
    'smallchange': dict(w=19.6, D=22, floors=[4.8, 3.6], brick=0xcbb68c, stone=0xd6cfbd, trim=0x8c2f25,
                        groups=[6], pil=0.0, win=[dict(shape='flat', w=1.6, h=1.6, pair=True)],
                        cornice='stone', par=1.0, shop=dict(units=2, pier='brick', col=0x8c2f25, awn=[None, None])),
}

GLASS_DARK = 0x1c2226
FRAME = 0xe9e5da


class Build:
    """One design at one level of detail: lod 0 near, 1 street, 2 far."""

    def __init__(self, name, S, lod, seed):
        self.n, self.S, self.lod = name, S, lod
        self.m, self.g = Mesh(), Mesh()     # body and shopfront glass
        self.r = random.Random(seed)
        self.meta = {'w': S['w'], 'D': S['D']}

    # ── Windows ──────────────────────────────────────────────────────────────
    def opening(self, x0, x1, y0, y1, rise, d, wall):
        """Reveal faces of an opening (rectangle, or arched head of height `rise`) through a wall at z=0, depth d."""
        m = self.m
        m.face([(x0, y0, 0), (x0, y0, -d), (x0, y1, -d), (x0, y1, 0)], wall, 1.0, (1, 0, 0))
        m.face([(x1, y0, -d), (x1, y0, 0), (x1, y1, 0), (x1, y1, -d)], wall, 1.0, (-1, 0, 0))
        m.face([(x0, y0, 0), (x1, y0, 0), (x1, y0, -d), (x0, y0, -d)], wall, 1.0, (0, 1, 0))
        pts = self.arc(x0, x1, y1, rise)
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            cx, cy = (x0 + x1) / 2, y1 - (0 if rise <= 0 else 0)
            m.face([(ax, ay, 0), (bx, by, 0), (bx, by, -d), (ax, ay, -d)], wall, 1.0, (cx - (ax + bx) / 2, min(y1, cy) - (ay + by) / 2 - 0.01, 0))

    def arc(self, x0, x1, y1, rise):
        if rise <= 0.01: return [(x0, y1), (x1, y1)]
        n = 8 if self.lod == 0 else 4
        hw = (x1 - x0) / 2; R = (hw * hw + rise * rise) / (2 * rise); cy = y1 + rise - R; cx = (x0 + x1) / 2
        a0 = atan2(y1 - cy, -hw)
        out = []
        for i in range(n + 1):
            a = a0 + (pi - 2 * a0) * i / n
            out.append((cx + R * cos(a), cy + R * sin(a)))
        return out

    def sash(self, x0, x1, y0, y1, rise, d, panes, lit):
        """Glass, frame, meeting rail and muntins at the back of a reveal; a blind drawn part way down."""
        m, z = self.m, -d
        top = self.arc(x0, x1, y1, rise)
        a = lit
        m.face([(x0, y0, z), (x1, y0, z)] + [(px, py, z) for px, py in top[::-1]], GLASS_DARK, a, (0, 0, 1))
        if self.lod == 2: return
        r = self.r
        blind = r.random()
        if blind > 0.35:
            bh = (y1 - y0) * (0.15 + 0.5 * r.random())
            m.quad_z(x0 + 0.02, x1 - 0.02, y1 - bh, y1, z + 0.02, r.choice([0xd9cfb4, 0xe8e2d0, 0xbfb6a0, 0x8a7a62]), a)
        fw, fz = 0.07, z + 0.06
        m.box(x0, x1, y0, y0 + 0.1, z, fz, FRAME)
        m.box(x0, x0 + fw, y0, y1, z, fz, FRAME); m.box(x1 - fw, x1, y0, y1, z, fz, FRAME)
        if rise <= 0.01: m.box(x0, x1, y1 - fw, y1, z, fz, FRAME)
        ym = (y0 + y1) / 2
        m.box(x0, x1, ym - 0.04, ym + 0.04, z, fz + 0.03, FRAME)
        if self.lod == 0 and panes != '1/1':
            nx, ny = {'2/2': (2, 1), '6/6': (3, 2), '12/12': (4, 3)}.get(panes, (1, 1))
            for half in (0, 1):
                h0, h1 = (y0, ym) if half == 0 else (ym, y1)
                for i in range(1, nx): xx = x0 + (x1 - x0) * i / nx; m.box(xx - 0.018, xx + 0.018, h0, h1, z, fz - 0.01, FRAME)
                for j in range(1, ny): yy = h0 + (h1 - h0) * j / ny; m.box(x0, x1, yy - 0.018, yy + 0.018, z, fz - 0.01, FRAME)

    def window(self, x0, x1, y0, y1, w):
        """A whole window in the wall: hole, reveal, sash, sill and the head the style asks for."""
        S, m, lod = self.S, self.m, self.lod
        shape, stone, brick = w.get('shape', 'flat'), S['stone'], S['brick']
        rise = {'seg': 0.28, 'round': (x1 - x0) / 2}.get(shape, 0.0)
        d = 0.06 if lod == 2 else 0.26
        lit = 0.02 + 0.96 * self.r.random()
        self.holes.append((x0, x1, y0, y1, rise))
        if lod < 2: self.opening(x0, x1, y0, y1, rise, d, brick)
        self.sash(x0, x1, y0, y1, rise, d, w.get('panes', '1/1' if shape != 'grid' else '2/2'), lit)
        if lod == 2: return
        if not S.get('csill'): m.box(x0 - 0.08, x1 + 0.08, y0 - 0.1, y0, -0.03, 0.08, stone)
        if shape == 'flat':
            m.box(x0 - 0.14, x1 + 0.14, y1, y1 + 0.3, 0, 0.05, stone)
            if w.get('key') and lod == 0:
                xc = (x0 + x1) / 2
                m.prism([(xc - 0.13, y1), (xc + 0.13, y1), (xc + 0.17, y1 + 0.36), (xc - 0.17, y1 + 0.36)], 0, 0.08, stone)
        elif shape == 'splay':
            m.prism([(x0, y1), (x1, y1), (x1 + 0.18, y1 + 0.36), (x0 - 0.18, y1 + 0.36)], 0, 0.025, shade(brick, 0.86), 1.0)
        elif shape == 'iron':
            m.box(x0 - 0.12, x1 + 0.12, y1, y1 + 0.26, 0, 0.07, S['trim'])
            if lod == 0: m.prism([(x0, y1 + 0.26), (x1, y1 + 0.26), ((x0 + x1) / 2, y1 + 0.48)], 0, 0.05, S['trim'])
        elif shape in ('seg', 'round'):
            outer, inner = self.arc(x0 - 0.16, x1 + 0.16, y1, rise + 0.16), self.arc(x0, x1, y1, rise)
            col = shade(brick, 0.82) if shape == 'seg' else stone
            for (a0, b0), (a1, b1), (c0, d0), (c1, d1) in zip(inner[:-1], inner[1:], outer[:-1], outer[1:]):
                m.face([(a0, b0, 0.035), (a1, b1, 0.035), (c1, d1, 0.035), (c0, d0, 0.035)], col, 0.0 if shape == 'round' else 1.0, (0, 0, 1))
                m.face([(c0, d0, 0), (c1, d1, 0), (c1, d1, 0.035), (c0, d0, 0.035)], col, 0.0, ((c0 + c1) / 2 - (x0 + x1) / 2, (d0 + d1) / 2 - y1, 0))
        elif shape == 'deco':
            m.box(x0 - 0.05, x1 + 0.05, y1, y1 + 0.55, -0.04, 0.0, 0x3a3f3e)
        elif shape == 'grid':
            m.box(x0 - 0.16, x1 + 0.16, y1, y1 + 0.42, 0, 0.09, S['trim'])

    # ── The facade ───────────────────────────────────────────────────────────
    def wall_with_holes(self, x0, x1, y0, y1, hex_, a=1.0):
        """The wall plane z=0 between x0..x1, y0..y1 minus self.holes, as a grid of quads (arch heads filled round)."""
        holes = [h for h in self.holes if h[0] < x1 and h[1] > x0 and h[2] < y1 and h[3] + h[4] > y0]
        xs = sorted({x0, x1, *[h[0] for h in holes], *[h[1] for h in holes]})
        ys = sorted({y0, y1, *[h[2] for h in holes], *[h[3] for h in holes], *[h[3] + h[4] for h in holes]})
        xs = [x for x in xs if x0 <= x <= x1]; ys = [y for y in ys if y0 <= y <= y1]
        m = self.m
        for i in range(len(xs) - 1):
            for j in range(len(ys) - 1):
                cx, cy = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
                hit = next((h for h in holes if h[0] < cx < h[1] and h[2] < cy < h[3] + h[4]), None)
                if hit is None:
                    m.quad_z(xs[i], xs[i + 1], ys[j], ys[j + 1], 0, hex_, a)
                elif cy > hit[3] and hit[4] > 0.01:
                    # Spandrels round an arch head: the cell above the spring line, less the arc.
                    hx0, hx1, _, hy1, rise = hit
                    pts = self.arc(hx0, hx1, hy1, rise)
                    top = ys[j + 1]
                    mid = len(pts) // 2
                    left = [(hx0, top)] + [(px, py) for px, py in pts[:mid + 1]] + [(pts[mid][0], top)]
                    right = [(pts[mid][0], top)] + [(px, py) for px, py in pts[mid:]] + [(hx1, top)]
                    for poly in (left, right):
                        cxp = sum(p[0] for p in poly) / len(poly); cyp = sum(p[1] for p in poly) / len(poly)
                        for k in range(1, len(poly) - 1):
                            tri = [poly[0], poly[k], poly[k + 1]]
                            m.face([(px, py, 0) for px, py in tri], hex_, a, (0, 0, 1))

    def bays(self, x0, x1, n, ww, pair):
        """Centres of n bays spread evenly over x0..x1."""
        step = (x1 - x0) / n
        return [x0 + step * (i + 0.5) for i in range(n)]

    def build(self):
        S, m, lod = self.S, self.m, self.lod
        w, D, fl = S['w'], S['D'], S['floors']
        brick, stone, trim = S['brick'], S['stone'], S['trim']
        HS = fl[0]
        tops = [HS]
        for h in fl[1:]: tops.append(tops[-1] + h)
        H = tops[-1]                      # top of the top floor = cornice line
        par = S.get('par', 1.0)
        top = H + par
        self.holes = []
        groups, pil, side = S['groups'], S.get('pil', 0.0), S.get('side', 0.35)
        nG = len(groups)
        gw = (w - 2 * side - pil * (nG - 1)) / nG
        gx = [side + i * (gw + pil) for i in range(nG)]
        # Upper floors: windows.
        for fi, h in enumerate(fl[1:]):
            wst = S['win'][min(fi, len(S['win']) - 1)]
            yb = tops[fi] + 0.75
            wh = min(wst['h'], h - 1.05)
            for gi, nb in enumerate(groups):
                for cx in self.bays(gx[gi], gx[gi] + gw, nb, wst['w'], wst.get('pair')):
                    ww = wst['w']
                    if wst.get('pair'):
                        self.window(cx - ww / 2, cx - 0.06, yb, yb + wh, wst)
                        self.window(cx + 0.06, cx + ww / 2, yb, yb + wh, wst)
                        if lod < 2: m.box(cx - 0.06, cx + 0.06, yb, yb + wh, -0.26, -0.02, brick, 1.0)
                    else:
                        self.window(cx - ww / 2, cx + ww / 2, yb, yb + wh, wst)
            if S.get('csill') and lod < 2: m.box(side, w - side, yb - 0.12, yb, -0.03, 0.09, stone)
            if S.get('belts') and lod < 2: m.box(0, w, yb - 0.14, yb - 0.02, 0, 0.07, stone)
        # The wall itself, with all the holes, from the shop cornice up to the top of the parapet.
        self.wall_with_holes(0, w, HS, top, brick)
        # Pilasters between groups and at the ends, brick, proud of the wall.
        if lod < 2:
            for i in range(nG + 1):
                xa = (gx[i] - pil) if i < nG else (w - side)
                xb = gx[i] if i < nG else w
                if i == 0: xa, xb = 0, side
                if xb - xa > 0.05: m.box(xa, xb, HS, H, 0, 0.09 if lod == 0 else 0.07, shade(brick, 0.95), 1.0, skip='b')
        # Plaques with nothing on them yet: granite name blocks.
        if S.get('plaques') and lod < 2:
            for i in range(nG):
                xc = gx[i] + gw / 2
                yy = (tops[-2] + 0.15) if len(tops) > 2 else H - 0.8
                m.box(xc - 0.75, xc + 0.75, yy - 0.05, yy + 0.4, 0, 0.05, stone)
        self.cornice(w, H, top, gx, gw)
        self.shopfront(w, HS)
        self.body(w, D, top, HS)
        self.meta.update(top=round(top, 2), H=round(H, 2), HS=HS)

    def cornice(self, w, H, top, gx, gw):
        S, m, lod = self.S, self.m, self.lod
        brick, stone, trim, kind = S['brick'], S['stone'], S['trim'], S['cornice']
        if kind == 'wood':
            m.box(-0.02, w + 0.02, H + 0.0, H + 0.55, 0, 0.12, trim)                  # frieze
            m.box(-0.1, w + 0.1, H + 0.55, H + 0.75, 0, 0.62 if lod < 2 else 0.5, trim)   # corona
            if lod < 2: m.box(-0.12, w + 0.12, H + 0.75, H + 0.88, 0, 0.7, shade(trim, 1.15))  # crown
            if lod == 0:
                n = max(2, int(w / 0.95))
                for i in range(n + 1):
                    x = 0.12 + (w - 0.24) * i / n
                    m.box(x - 0.09, x + 0.09, H + 0.05, H + 0.55, 0.12, 0.52, trim, 0.0, skip='k')
                for i in range(int(w / 0.22)):
                    x = 0.1 + i * 0.22
                    m.box(x, x + 0.11, H + 0.47, H + 0.55, 0.12, 0.3, trim, 0.0, skip='k')
            if top > H + 0.9: self.parapet(w, H + 0.88, top)
        elif kind == 'corbel':
            for k in range(3):
                m.box(0, w, H + k * 0.17, H + (k + 1) * 0.17, 0, 0.06 * (k + 1), shade(brick, 0.97), 1.0)
            if lod == 0:
                for i in range(int(w / 0.34)):
                    x = 0.1 + i * 0.34
                    m.box(x, x + 0.17, H - 0.24, H, 0, 0.06, brick, 1.0, skip='k')
            m.box(-0.02, w + 0.02, top - 0.12, top, -0.1, 0.12, stone)
        elif kind == 'stone':
            m.box(-0.04, w + 0.04, H + 0.1, H + 0.42, 0, 0.18 if lod < 2 else 0.12, stone)
            m.box(-0.04, w + 0.04, top - 0.1, top, -0.1, 0.06, stone)
        elif kind == 'deco':
            # Piers rise through the parapet and end in stepped caps; spandrel bands in dark metal.
            n = sum(S['groups'])
            for i in range(n + 1):
                x = S.get('side', 0.35) + (w - 2 * S.get('side', 0.35)) * i / n
                if lod < 2: m.box(x - 0.2, x + 0.2, self.S['floors'][0], top + 0.5, 0, 0.14, shade(brick, 1.05), 1.0, skip='b')
                if lod == 0: m.box(x - 0.14, x + 0.14, top + 0.5, top + 0.75, 0, 0.1, stone)
            m.box(0, w, H + 0.2, H + 0.45, 0, 0.08, stone)
            m.box(w * 0.3, w * 0.7, top, top + 0.9, -0.1, 0.06, brick, 1.0)
            m.box(w * 0.3 - 0.05, w * 0.7 + 0.05, top + 0.9, top + 1.02, -0.1, 0.1, stone)
        # Gables over each group (Second Guess Blocks), brick with stone coping and a zigzag panel.
        for gi, gk in enumerate(S.get('gables') or []):
            if not gk: continue
            x0, x1 = gx[gi] - 0.2, gx[gi] + gw + 0.2
            xc, base, rise = (x0 + x1) / 2, top - 0.05, 2.3
            if gk == 'tri':
                poly = [(x0, base), (x1, base), (xc, base + rise)]
            else:
                poly = [(x0, base), (x1, base)] + self.arc(x0, x1, base + 0.5, rise - 0.5)[::-1]
            m.prism(poly, -0.25, 0.04, brick, 1.0, back=True)
            if lod < 2:
                pts = poly[1:] + [poly[0]]
                for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
                    if ay < base + 0.01 and by < base + 0.01: continue
                    dx, dy = bx - ax, by - ay; L = sqrt(dx * dx + dy * dy); nx, ny = -dy / L * 0.14, dx / L * 0.14
                    if ny < 0: nx, ny = -nx, -ny
                    m.prism([(ax, ay), (bx, by), (bx + nx, by + ny), (ax + nx, ay + ny)], -0.3, 0.1, stone, 0.0, back=True)
            if lod == 0 and S.get('zig'):
                # Zigzag brick relief in the tympanum: chevron rows of headers stood proud.
                for row in range(3):
                    yy = base + 0.35 + row * 0.38
                    span = (x1 - x0) * (1 - (yy - base) / rise) * 0.7 if gk == 'tri' else (x1 - x0) * 0.6
                    n = int(span / 0.3)
                    for k in range(n):
                        xx = xc - span / 2 + k * 0.3
                        m.prism([(xx, yy), (xx + 0.15, yy + 0.16), (xx + 0.3, yy), (xx + 0.3, yy + 0.07), (xx + 0.15, yy + 0.23), (xx, yy + 0.07)], 0.04, 0.075, shade(brick, 1.12), 1.0)
                m.box(xc - 0.5, xc + 0.5, base + 0.05, base + 0.3, 0.04, 0.08, stone)
        # Mansard: a slate slope behind the cornice with dormers (Monotony Ward).
        if S.get('mansard'):
            sl, rise, back = S['mansard'], 2.6, 1.1
            y0, y1 = top, top + rise
            m.face([(0, y0, 0.0), (w, y0, 0.0), (w, y1, -back), (0, y1, -back)], sl, 0.0, (0, back, rise))
            m.face([(0, y0, 0), (0, y1, -back), (0, y0, -back)], sl, 0.0, (-1, 0, 0))
            m.face([(w, y0, 0), (w, y0, -back), (w, y1, -back)], sl, 0.0, (1, 0, 0))
            m.box(0, w, y0, y1, -self.S['D'] + 0.3, -back, sl, 0.0, skip='fb')
            n = sum(S['groups'])
            for i in range(n):
                xc = S.get('side', 0.35) + (w - 0.7) * (i + 0.5) / n
                if lod == 2:
                    m.face([(xc - 0.5, y0 + 0.5, -0.22), (xc + 0.5, y0 + 0.5, -0.22), (xc + 0.5, y0 + 1.7, -0.68), (xc - 0.5, y0 + 1.7, -0.68)], GLASS_DARK, 0.3, (0, 1, 2))
                    continue
                m.box(xc - 0.65, xc + 0.65, y0 + 0.3, y0 + 2.0, -0.9, 0.05, trim, 0.0, skip='kt')
                m.face([(xc - 0.75, y0 + 2.0, 0.12), (xc + 0.75, y0 + 2.0, 0.12), (xc, y0 + 2.6, 0.12)], trim, 0.0, (0, 0, 1))
                m.face([(xc - 0.75, y0 + 2.0, 0.12), (xc, y0 + 2.6, 0.12), (xc, y0 + 2.6, -0.9), (xc - 0.75, y0 + 2.0, -0.9)], sl, 0.0, (-1, 1, 0))
                m.face([(xc + 0.75, y0 + 2.0, 0.12), (xc + 0.75, y0 + 2.0, -0.9), (xc, y0 + 2.6, -0.9), (xc, y0 + 2.6, 0.12)], sl, 0.0, (1, 1, 0))
                m.quad_z(xc - 0.45, xc + 0.45, y0 + 0.5, y0 + 1.8, 0.06, GLASS_DARK, 0.02 + 0.96 * self.r.random())
                if lod == 0: m.box(xc - 0.45, xc + 0.45, y0 + 1.12, y0 + 1.18, 0.06, 0.1, FRAME)

    def parapet(self, w, y0, y1):
        self.m.box(0, self.S['w'], y1 - 0.12, y1, -0.15, 0.06, self.S['stone'])

    # ── Shopfront ────────────────────────────────────────────────────────────
    def shopfront(self, w, HS):
        S, m, g, lod, r = self.S, self.m, self.g, self.lod, self.r
        sh = S['shop']
        n, col = sh['units'], sh['col']
        pier_hex = {'granite': 0xa8a49b, 'stone': S['stone'], 'iron': col, 'brick': S['brick']}[sh['pier']]
        pier_a = 1.0 if sh['pier'] == 'brick' else 0.0
        pw = 0.55
        uw = (w - pw) / n
        gh, fas0, fas1 = 3.15, 3.45, HS - 0.3
        signs = []
        # Lintel band and fascia across the front, cornice over them.
        m.box(0, w, gh, HS, -0.02, 0.0, col)
        m.box(0, w, fas0, fas1, 0.0, 0.1, shade(col, 1.1))
        m.box(-0.05, w + 0.05, fas1, fas1 + 0.12, 0, 0.3, shade(col, 0.9))
        m.box(-0.05, w + 0.05, fas1 + 0.12, HS, 0, 0.18, col)
        for u in range(n + 1):
            x = u * uw
            m.box(x, x + pw, 0, fas0, 0, 0.14, pier_hex, pier_a, skip='b')
            if lod == 0 and sh['pier'] == 'iron':
                m.box(x + 0.08, x + pw - 0.08, fas0 - 0.3, fas0 - 0.15, 0.14, 0.2, col)
        for u in range(n):
            a, b = u * uw + pw, (u + 1) * uw
            signs.append([round(a + 0.2, 2), round(b - 0.2, 2), fas0, fas1, 0.105])
            self.unit(a, b, gh, col)
            awn = (sh.get('awn') or [None])[u % len(sh.get('awn') or [None])]
            if awn and lod < 2:
                ay1, ay0, out = gh + 0.12, 2.45, 1.45
                m.face([(a + 0.1, ay1, 0.05), (b - 0.1, ay1, 0.05), (b - 0.1, ay0, out), (a + 0.1, ay0, out)], awn, 0.0, (0, out, ay1 - ay0))
                m.face([(a + 0.1, ay1 - 0.01, 0.05), (b - 0.1, ay1 - 0.01, 0.05), (b - 0.1, ay0 - 0.01, out), (a + 0.1, ay0 - 0.01, out)], shade(awn, 0.6), 0.0, (0, -out, -(ay1 - ay0)))
                m.box(a + 0.1, b - 0.1, ay0 - 0.3, ay0, out - 0.01, out, awn)
                for xx in (a + 0.1, b - 0.1):
                    m.face([(xx, ay1, 0.05), (xx, ay0, out), (xx, ay0 - 0.3, out)], awn, 0.0, (1 if xx > a + 1 else -1, 0, 0))
        # Base of the wall: where there is no pier, nothing; the shop units fill the rest.
        self.meta['signs'] = signs

    def unit(self, a, b, gh, col):
        """One shop: bulkhead, display glass in frames, transom, a recessed door, and a room behind."""
        m, g, lod, r = self.m, self.g, self.lod, self.r
        wdt = b - a
        dw = 1.25
        door_at = a + (wdt - dw) / 2 if wdt < 6 else (a + 0.6 if r.random() < 0.5 else b - 0.6 - dw)
        rec = 1.1 if lod < 2 else 0.0
        bulk = 0.55
        set_ = 0.18 if lod < 2 else 0.04
        # Bulkheads and display glass either side of the door.
        for x0, x1 in ((a, door_at), (door_at + dw, b)):
            if x1 - x0 < 0.2: continue
            m.box(x0, x1, 0, bulk, -set_, -set_ + 0.08, shade(col, 0.95))
            if lod == 0: m.box(x0 + 0.12, x1 - 0.12, 0.12, bulk - 0.1, -set_ + 0.08, -set_ + 0.11, shade(col, 1.12))
            m.box(x0, x1, gh - 0.1, gh, -set_, -set_ + 0.1, col)
            if lod < 2:
                g.quad_z(x0, x1, bulk, gh - 0.1, -set_ + 0.03, 0xa6b8be, 0.0)
                nm = max(1, int((x1 - x0) / 1.9))
                for k in range(nm + 1):
                    xx = x0 + (x1 - x0) * k / nm
                    m.box(xx - 0.04, xx + 0.04, bulk, gh, -set_, -set_ + 0.06, col)
                m.box(x0, x1, bulk, bulk + 0.06, -set_, -set_ + 0.07, col)
                if lod == 0:
                    # Transom: a row of small lights (prism glass), dark by day, lit at night with the shop.
                    m.box(x0, x1, gh - 0.62, gh - 0.56, -set_, -set_ + 0.06, col)
            else:
                m.quad_z(x0, x1, bulk, gh - 0.1, -set_ + 0.01, GLASS_DARK, 0.9)
        # The door, set back in its recess, with side lights.
        dz = -set_ - rec
        m.box(door_at, door_at + dw, 0, gh, dz - 0.05, dz, 0x5a3a26)
        if lod < 2:
            m.quad_z(door_at + 0.18, door_at + dw - 0.18, 1.0, gh - 0.55, dz + 0.01, GLASS_DARK, 0.9)
            m.box(door_at, door_at + dw, gh - 0.1, gh, dz, -set_ + 0.1, col)
            m.face([(door_at, 0.02, -set_), (door_at + dw, 0.02, -set_), (door_at + dw, 0.02, dz), (door_at, 0.02, dz)], 0x8d8a82, 0.0, (0, 1, 0))
            m.face([(door_at, gh - 0.1, -set_), (door_at, gh - 0.1, dz), (door_at + dw, gh - 0.1, dz), (door_at + dw, gh - 0.1, -set_)], 0xe8dfc6, 0.0, (0, -1, 0))
            for xx, nx in ((door_at, 1), (door_at + dw, -1)):
                g.face([(xx, bulk, -set_), (xx, bulk, dz), (xx, gh - 0.1, dz), (xx, gh - 0.1, -set_)], 0xa6b8be, 0.0, (nx, 0, 0))
                m.box(xx - 0.03, xx + 0.03, 0, bulk, dz, -set_, shade(col, 0.95))
        if lod == 2: return
        # The room: floor, ceiling with pendant lamps, back wall, shelving and a counter. Lit at night.
        z0, z1 = -set_ - 0.02, -6.5
        lit = 0.9
        wall_col = r.choice([0xe8e0cc, 0xd9cfb4, 0xc9d1c8, 0xe6d6c0, 0x9fb3a8])
        m.face([(a, 0.01, z0), (a, 0.01, z1), (b, 0.01, z1), (b, 0.01, z0)], r.choice([0x7a5a3a, 0x8d7a5a, 0x5e5a55]), lit, (0, 1, 0))
        m.face([(a, gh + 0.3, z0), (b, gh + 0.3, z0), (b, gh + 0.3, z1), (a, gh + 0.3, z1)], 0xf0ebe0, lit, (0, -1, 0))
        m.quad_z(a, b, 0, gh + 0.3, z1, wall_col, lit, 1)
        m.face([(a, 0, z0), (a, 0, z1), (a, gh + 0.3, z1), (a, gh + 0.3, z0)], wall_col, lit, (1, 0, 0))
        m.face([(b, 0, z1), (b, 0, z0), (b, gh + 0.3, z0), (b, gh + 0.3, z1)], wall_col, lit, (-1, 0, 0))
        if lod == 0:
            for k in range(max(1, int(wdt / 2.2))):
                xx = a + (k + 0.5) * wdt / max(1, int(wdt / 2.2))
                m.box(xx - 0.18, xx + 0.18, gh + 0.0, gh + 0.12, -2.5, -2.2, 0xfff4d8, 0.98)
                m.box(xx - 0.015, xx + 0.015, gh + 0.12, gh + 0.3, -2.37, -2.33, 0x222222, 0.0)
            # Shelves on the back wall, goods on them, a counter and a display table.
            for k in range(3):
                yy = 0.5 + k * 0.6
                m.box(a + 0.3, b - 0.3, yy, yy + 0.04, z1 + 0.02, z1 + 0.45, 0x6b4a32, lit)
                xx = a + 0.4
                while xx < b - 0.7:
                    ww = 0.2 + 0.4 * r.random()
                    m.box(xx, xx + ww, yy + 0.04, yy + 0.2 + 0.25 * r.random(), z1 + 0.05, z1 + 0.35,
                          r.choice([0x8c2f25, 0x25395c, 0xd9cfb4, 0x2c4a3a, 0xc9892e, 0x6a5a8a, 0xe8e4d8]), lit)
                    xx += ww + 0.08
            m.box(a + 0.5, a + 0.5 + min(2.4, wdt * 0.35), 0, 0.95, -4.4, -3.8, 0x5a3a26, lit)
            if wdt > 3.5:
                xc = (a + b) / 2 + (0.8 if door_at < (a + b) / 2 else -0.8)
                m.box(xc - 0.6, xc + 0.6, 0, 0.75, -1.9, -1.2, 0x6b4a32, lit)
                m.box(xc - 0.4, xc + 0.4, 0.75, 1.05, -1.75, -1.35, r.choice([0xc9892e, 0x8c2f25, 0x2f5a57]), lit)

    # ── The body: sides, back, roof ──────────────────────────────────────────
    def body(self, w, D, top, HS):
        m, S = self.m, self.S
        brick = S['brick']
        # Side walls (party walls, seen at corners and over lower neighbours), the back, and the roof inside the parapet.
        m.face([(0, 0, -D), (0, 0, 0), (0, top, 0), (0, top, -D)], shade(brick, 0.96), 1.0, (-1, 0, 0))
        m.face([(w, 0, 0), (w, 0, -D), (w, top, -D), (w, top, 0)], shade(brick, 0.96), 1.0, (1, 0, 0))
        m.quad_z(0, w, 0, top, -D, shade(brick, 0.9), 1.0, -1)
        # Side windows: hidden against a neighbour, a row of plain sash where the block ends at a corner or a lane.
        fl = S['floors']; y = fl[0]
        for h in fl[1:]:
            nwin = max(1, int((D - 3) / 3.4))
            for i in range(nwin):
                zc = -1.8 - (i + 0.5) * (D - 3.6) / nwin
                wh = min(1.9, h - 1.2)
                for xx, nx in ((-0.02, -1), (w + 0.02, 1)):
                    m.face([(xx, y + 0.8, zc - 0.5), (xx, y + 0.8, zc + 0.5), (xx, y + 0.8 + wh, zc + 0.5), (xx, y + 0.8 + wh, zc - 0.5)],
                           GLASS_DARK, 0.02 + 0.96 * self.r.random(), (nx, 0, 0))
                    if self.lod < 2:
                        m.box(xx - 0.07 if nx < 0 else xx, xx if nx < 0 else xx + 0.07, y + 0.7, y + 0.8, zc - 0.6, zc + 0.6, S['stone'])
                        m.box(xx - 0.04 if nx < 0 else xx, xx if nx < 0 else xx + 0.04, y + 0.8 + wh, y + 1.05 + wh, zc - 0.65, zc + 0.65, shade(brick, 0.85), 1.0)
            y += h
        # Back windows, plain, so a lane or the lot behind sees a working wall.
        if self.lod < 2:
            fl = S['floors']; y = fl[0]
            for h in fl[1:]:
                for i in range(max(1, int(w / 3.2))):
                    xc = (i + 0.5) * w / max(1, int(w / 3.2))
                    m.quad_z(xc + 0.5, xc - 0.5, y + 0.8, y + 0.8 + min(1.8, h - 1.2), -D - 0.02, GLASS_DARK, 0.02 + 0.96 * self.r.random(), -1)
                y += h
        ry = top - 0.6
        m.face([(0.05, ry, -0.3), (w - 0.05, ry, -0.3), (w - 0.05, ry, -D + 0.05), (0.05, ry, -D + 0.05)], 0x4a4b4d, 0.0, (0, 1, 0))
        m.face([(0.05, ry, -0.3), (0.05, top, -0.3), (w - 0.05, top, -0.3), (w - 0.05, ry, -0.3)], shade(brick, 0.85), 1.0, (0, 0, -1))
        cap = shade(S['stone'], 0.9)
        m.box(0, 0.3, top - 0.02, top, -D, -0.3, cap, 0.0, skip='b'); m.box(w - 0.3, w, top - 0.02, top, -D, -0.3, cap, 0.0, skip='b')
        m.box(0.3, w - 0.3, top - 0.02, top, -D, -D + 0.3, cap, 0.0, skip='b')
        m.face([(0.3, ry, -D + 0.3), (0.3, top, -D + 0.3), (0.3, top, -0.3), (0.3, ry, -0.3)], shade(brick, 0.85), 1.0, (1, 0, 0))
        m.face([(w - 0.3, ry, -0.3), (w - 0.3, top, -0.3), (w - 0.3, top, -D + 0.3), (w - 0.3, ry, -D + 0.3)], shade(brick, 0.85), 1.0, (-1, 0, 0))
        m.face([(0.3, ry, -D + 0.3), (w - 0.3, ry, -D + 0.3), (w - 0.3, top, -D + 0.3), (0.3, top, -D + 0.3)], shade(brick, 0.85), 1.0, (0, 0, 1))
        if self.lod < 2:
            r = self.r
            cx, cz = w * (0.3 + 0.4 * r.random()), -D * (0.4 + 0.3 * r.random())
            m.box(cx - 0.6, cx + 0.6, ry, ry + 2.2, cz - 0.6, cz + 0.6, shade(brick, 0.9), 1.0, skip='b')
            m.box(w * 0.6 - 1.1, w * 0.6 + 1.1, ry, ry + 1.1, -D * 0.7 - 0.8, -D * 0.7 + 0.8, 0x9a9c98, 0.0, skip='b')


# ── Occlusion ────────────────────────────────────────────────────────────────

def vertex_ao(ob, rays=12, reach=2.5):
    """Per-face occlusion by ray casting (the mesh and the street), multiplied into the corner colours (not the alpha)."""
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
        k = max(0.35, 1 - 0.85 * hit / rays)
        for li in p.loop_indices:
            c = att.data[li].color
            att.data[li].color = (c[0] * k, c[1] * k, c[2] * k, c[3])


def bake_ao(obs):
    """Cycles ambient occlusion of every near mesh into one atlas, mainst_o.webp; the atlas becomes their only UV."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try: sc.cycles.device = 'CPU'; sc.cycles.use_denoising = False
    except Exception: pass
    w = bpy.data.worlds.new('bakeworld'); sc.world = w
    try: w.light_settings.distance = 2.0
    except Exception: pass
    img = bpy.data.images.new('mainst_o', AO_N, AO_N, alpha=False); img.generated_color = (1, 1, 1, 1)
    img.colorspace_settings.name = 'Non-Color'
    mat = bpy.data.materials.new('bld'); mat.use_nodes = True
    nt = mat.node_tree; nd = nt.nodes.new('ShaderNodeTexImage'); nd.name = 'bake_target'; nd.image = img
    for x in nt.nodes: x.select = False
    nd.select = True; nt.nodes.active = nd
    # The image node feeds the base colour so the exporter writes the UVs out with the material.
    bsdf = next(x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED')
    nt.links.new(nd.outputs['Color'], bsdf.inputs['Base Color'])
    for ob in obs:
        ob.data.materials.clear(); ob.data.materials.append(mat)
        while ob.data.uv_layers: ob.data.uv_layers.remove(ob.data.uv_layers[0])
        ob.data.uv_layers.new(name='AO')
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs: ob.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=radians(66), island_margin=0.001)
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=0.001, shape_method='CONCAVE')
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=0.001)
    bpy.ops.object.mode_set(mode='OBJECT')
    # The street under them, so the foot of every wall darkens.
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=200)
    gme = bpy.data.meshes.new('bakeground'); bm.to_mesh(gme); bm.free()
    ground = bpy.data.objects.new('bakeground', gme); sc.collection.objects.link(ground)
    ground.location = (0, 0, -0.01)
    # The designs stand apart in Blender (see main); each bakes with only itself and the street.
    sc.cycles.samples = 48
    # Every other mesh (the other designs, the street and far levels, the glass) stands on the same spot: hide them all.
    for ob in obs:
        for o2 in bpy.data.objects: o2.hide_render = o2 is not ob and o2 is not ground
        bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type='AO', margin=3, use_clear=False)
    for o2 in bpy.data.objects: o2.hide_render = False
    bpy.data.objects.remove(ground)
    img.filepath_raw = os.path.join(OUT, 'mainst_o.webp'); img.file_format = 'WEBP'; img.save(quality=82)
    return round(os.path.getsize(os.path.join(OUT, 'mainst_o.webp')) / 1000)


def brick_maps(N=512):
    """mainst_bn.webp (tangent-space normals) and mainst_bc.webp (brick-to-brick colour) for one 1.6 x 1.0075 m repeat."""
    import numpy as np
    Hh = int(round(N * BRICK_H / BRICK_W / 4)) * 4        # keep texels square in meters
    ys, xs = np.mgrid[0:Hh, 0:N]
    u, v = (xs + 0.5) / N * BRICK_W, (ys + 0.5) / Hh * BRICK_H
    course = np.floor(v / (BRICK_H / 13)).astype(int)
    vv = v - course * (BRICK_H / 13)
    uu = (u + (course % 2) * 0.1) % 0.2
    mort = 0.0095
    du = np.minimum(uu, 0.2 - uu); dv = np.minimum(vv, BRICK_H / 13 - vv)
    edge = np.minimum(du, dv)
    h = np.clip((edge - mort / 2) / 0.004, 0, 1)        # 0 in the mortar joint, rounding up to the brick face
    rng = np.random.default_rng(3)
    bid = course * 9 + np.floor((u + (course % 2) * 0.1) / 0.2).astype(int) % 8
    tone = rng.uniform(0.8, 1.0, 13 * 9 + 9)[bid]
    noise = rng.normal(0, 0.02, h.shape)
    hf = h * 0.006 + noise * 0.0006 * h                 # meters of relief
    px = BRICK_W / N
    gx = (np.roll(hf, -1, 1) - np.roll(hf, 1, 1)) / (2 * px)
    gy = (np.roll(hf, -1, 0) - np.roll(hf, 1, 0)) / (2 * px)
    nx, ny, nz = -gx, -gy, np.ones_like(gx)
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    nrm = np.stack([nx / L * 0.5 + 0.5, ny / L * 0.5 + 0.5, nz / L * 0.5 + 0.5, np.ones_like(gx)], -1)
    col = np.where(h > 0.5, tone + noise, 1.0)
    colr = np.stack([col, col, col, np.ones_like(col)], -1).clip(0, 1)
    out = {}
    for name, arr, cs in (('mainst_bn', nrm, 'Non-Color'), ('mainst_bc', colr, 'Non-Color')):
        im = bpy.data.images.new(name, N, Hh, alpha=False)
        im.colorspace_settings.name = cs
        im.pixels.foreach_set(arr.astype(np.float32).ravel())     # row 0 is the bottom: v grows upward, as in the game
        p = os.path.join(OUT, name + '.webp')
        im.filepath_raw = p; im.file_format = 'WEBP'; im.save(quality=88)
        out[name + '_kB'] = round(os.path.getsize(p) / 1000)
    return out


def export(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs: ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False,
                              export_skins=False, export_morph=False, export_extras=False, export_image_format='NONE')
    return round(os.path.getsize(path) / 1000)


def main():
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True); os.makedirs(SHOTS, exist_ok=True)
    names = ONLY or list(DESIGNS)
    stats, meta, near, all_obs, far = {}, {}, [], [], []
    for di, name in enumerate(names):
        S = DESIGNS[name]
        for lod in (0, 1, 2):
            b = Build(name, S, lod, seed=1000 + di)
            b.build()
            ob = b.m.to_object(f'{name}_{lod}', coll)
            ob.location = (0, 0, 0)
            all_obs.append(ob)
            if lod == 0: near.append(ob)
            else: vertex_ao(ob)
            if lod == 2: far.append(ob)
            if lod < 2 and b.g.f:
                gob = b.g.to_object(f'{name}_{lod}g', coll); all_obs.append(gob)
            stats[f'{name}_{lod}'] = len(b.m.f)
            if lod == 0: meta[name] = b.meta
        # Redraw so the owner sees each design appear.
        try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
        except Exception: pass
    out = {'faces': stats}
    if '--no-bake' not in FLAGS:
        out.update(brick_maps())
        out['ao_kB'] = bake_ao(near)
    else:
        for ob in near: vertex_ao(ob)
    if '--no-export' not in FLAGS:
        # Far levels have no material: the exporter then writes only positions, normals and colours.
        out['mainst_kB'] = export(all_obs, os.path.join(OUT, 'mainst.glb'))
        out['far_kB'] = export(far, os.path.join(OUT, 'mainst_far.glb'))
    # Lay the designs out in a row for the still, near levels only.
    x = 0
    for name in names:
        for lod in (0, 1, 2):
            for suf in ('', 'g'):
                o = bpy.data.objects.get(f'{name}_{lod}{suf}')
                if o: o.location = (x, 0 if lod == 0 else 40 * lod, 0)
        x += DESIGNS[name]['w'] + 2
    print('BLD_STATS ' + json.dumps(out))
    print('BLD_META ' + json.dumps(meta))
    with open(os.path.join(SHOTS, 'mainst_meta.json'), 'w') as fh: json.dump({'stats': out, 'meta': meta}, fh, indent=1)


main()
# Close the window once the files are written: wm.quit_blender can stop on an unsaved-changes prompt.
if '--stay' not in FLAGS:
    sys.stdout.flush()
    os._exit(0)
