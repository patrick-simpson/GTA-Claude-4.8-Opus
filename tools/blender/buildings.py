# Tepid Falls' buildings, modelled in Blender by script and exported as .glb (the brief: tools/briefs/tepid-waterville.md;
# the real buildings each design follows, and their invented names: tools/briefs/tepid-reference.md).
#
#   blender --factory-startup --python tools/blender/buildings.py --python-expr "import bpy; bpy.ops.wm.quit_blender()" -- [names...] [--no-bake] [--no-export]
#   blender --factory-startup --python tools/blender/buildings.py -- --store     (Pardon's, the surplus store: see store_build)
#   blender --factory-startup --python tools/blender/buildings.py -- --river     (Lackwool Mill, the footbridge, the lot's kit: see river_main)
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
        m.box(x0, x1, y0, y0 + 0.1, z, fz, FRAME, skip='kb')
        m.box(x0, x0 + fw, y0, y1, z, fz, FRAME, skip='kbtl'); m.box(x1 - fw, x1, y0, y1, z, fz, FRAME, skip='kbtr')
        if rise <= 0.01: m.box(x0, x1, y1 - fw, y1, z, fz, FRAME, skip='kt')
        ym = (y0 + y1) / 2
        m.box(x0, x1, ym - 0.04, ym + 0.04, z, fz + 0.03, FRAME, skip='klr')
        if self.lod == 0 and panes != '1/1':
            nx, ny = {'2/2': (2, 1), '6/6': (3, 2), '12/12': (4, 3)}.get(panes, (1, 1))
            for half in (0, 1):
                h0, h1 = (y0, ym) if half == 0 else (ym, y1)
                for i in range(1, nx): xx = x0 + (x1 - x0) * i / nx; m.box(xx - 0.018, xx + 0.018, h0, h1, z, fz - 0.01, FRAME, skip='ktb')
                for j in range(1, ny): yy = h0 + (h1 - h0) * j / ny; m.box(x0, x1, yy - 0.018, yy + 0.018, z, fz - 0.01, FRAME, skip='klr')

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
            self.back(w, D)
        self.body_roof(w, D, top)

    def back(self, w, D):
        """The working back (The Holding Pattern sees these): steel rear doors under hoods and lamps, a service step, meters,
        and on three floors and up a fire escape of grated landings, railings, zig-zag stairs and a drop ladder."""
        m, S, lod, r = self.m, self.S, self.lod, self.r
        fl, z0 = S['floors'], -D
        IRONK, STEEL = 0x24262a, 0x56606a
        doors = [w * 0.22] + ([w * 0.74] if w > 14 else [])
        for xc in doors:
            m.box(xc - 0.6, xc + 0.6, 0, 2.25, z0 - 0.03, z0, r.choice([STEEL, 0x3d4a44, 0x6a2e26]), 0.0)
            m.box(xc - 0.72, xc + 0.72, 2.25, 2.4, z0 - 0.06, z0, 0x9d998d)           # stone lintel
            m.box(xc - 0.75, xc + 0.75, 0, 0.18, z0 - 0.9, z0, 0xa9a69c)              # concrete step
            if lod == 0:
                m.box(xc - 0.85, xc + 0.85, 2.55, 2.62, z0 - 0.75, z0, 0x3a3d40)       # hood
                m.box(xc - 0.12, xc + 0.12, 2.42, 2.55, z0 - 0.3, z0 - 0.1, 0xfff1cc, 0.97)  # lamp, lit at night
                m.box(xc + 0.85, xc + 1.15, 1.3, 1.75, z0 - 0.2, z0, 0x8a8c88)         # meter box
                m.box(xc + 0.95, xc + 1.05, 0.3, 1.3, z0 - 0.08, z0, 0x5a5c58)         # conduit
        if len(fl) < 3: return
        # Fire escape: x0..x1 across two bays, landings 1.1 m deep at every upper floor.
        fw = min(5.6, w * 0.5); x0 = w * 0.62 - fw / 2; x1 = x0 + fw; dz = 1.15
        y = fl[0]; lands = []
        for h in fl[1:]:
            lands.append(y + 0.45); y += h
        for i, ly in enumerate(lands):
            m.box(x0, x1, ly - 0.06, ly, z0 - dz, z0, IRONK)                          # grating
            for (a, b) in ((x0, x0 + 0.05), (x1 - 0.05, x1)):
                m.box(a, b, ly, ly + 1.0, z0 - dz, z0, IRONK, skip='b')              # end rails
            m.box(x0, x1, ly + 0.95, ly + 1.0, z0 - dz, z0 - dz + 0.05, IRONK)        # top rail
            if lod == 0:
                m.box(x0, x1, ly + 0.45, ly + 0.48, z0 - dz, z0 - dz + 0.03, IRONK)
                for k in range(int(fw / 0.32)):
                    xx = x0 + 0.16 + k * 0.32
                    m.box(xx - 0.012, xx + 0.012, ly, ly + 0.95, z0 - dz, z0 - dz + 0.024, IRONK, skip='tb')
                for k in range(3):                                                     # brackets
                    xx = x0 + 0.2 + k * (fw - 0.4) / 2
                    m.face([(xx, ly - 0.06, z0), (xx, ly - 0.06, z0 - dz + 0.05), (xx, ly - 0.9, z0)], IRONK, 0.0, (1, 0, 0))
            # Stairs from this landing down to the one below (the lowest ends in a counterweighted ladder).
            yb = lands[i - 1] if i else None
            if yb is not None:
                xa, xb = (x0 + 0.3, x1 - 0.5) if i % 2 else (x1 - 0.3, x0 + 0.5)
                sw = 0.62
                zs0, zs1 = z0 - dz + 0.06, z0 - dz + 0.06 + sw
                for (zz0, zz1) in ((zs0, zs0 + 0.05), (zs1 - 0.05, zs1)):
                    m.face([(xa, ly, zz0), (xb, yb, zz0), (xb, yb + 0.12, zz0), (xa, ly + 0.12, zz0)], IRONK, 0.0, (0, 0, -1))
                    m.face([(xa, ly, zz1), (xb, yb, zz1), (xb, yb + 0.12, zz1), (xa, ly + 0.12, zz1)], IRONK, 0.0, (0, 0, 1))
                if lod == 0:
                    n = int(abs(ly - yb) / 0.2)
                    for k in range(1, n):
                        t = k / n; xx = xa + (xb - xa) * t; yy = ly + (yb - ly) * t
                        m.box(xx - 0.12, xx + 0.12, yy - 0.02, yy + 0.02, zs0, zs1, IRONK)
                    m.face([(xa, ly + 0.95, zs0), (xb, yb + 0.95, zs0), (xb, yb + 1.0, zs0), (xa, ly + 1.0, zs0)], IRONK, 0.0, (0, 0, -1))
        if lod == 0:
            ly = lands[0]; xl = x0 + 0.25
            for xx in (xl, xl + 0.45):
                m.box(xx - 0.025, xx + 0.025, ly - 2.6, ly + 0.9, z0 - dz + 0.05, z0 - dz + 0.1, IRONK)
            for k in range(11):
                yy = ly - 2.5 + k * 0.3
                m.box(xl, xl + 0.45, yy - 0.015, yy + 0.015, z0 - dz + 0.06, z0 - dz + 0.09, IRONK)

    def body_roof(self, w, D, top):
        m, S = self.m, self.S
        brick = S['brick']
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

def vertex_ao(ob, rays=12, reach=2.5, big=0.0, ground=True):
    """Per-face occlusion by ray casting (the mesh and the street), multiplied into the corner colours (not the alpha)."""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    if ground: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=80, matrix=__import__('mathutils').Matrix.Translation((0, 0, -0.005)))
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
        if big and p.area > 0.3: k = max(k, big)      # broad panels (pegboard, shelves): no blotches from a few rays
        for li in p.loop_indices:
            c = att.data[li].color
            att.data[li].color = (c[0] * k, c[1] * k, c[2] * k, c[3])


def bake_ao(obs, name='mainst_o', ground_at=None, gpu=False):
    """Cycles ambient occlusion of every near mesh into one atlas, <name>.webp; the atlas becomes their only UV.
    ground_at: {object name: height of the street under it, or None for no street} (default 0 for all)."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try: sc.cycles.device = 'CPU'; sc.cycles.use_denoising = False
    except Exception: pass
    if gpu: cycles_gpu(sc)
    w = bpy.data.worlds.new('bakeworld'); sc.world = w
    try: w.light_settings.distance = 2.0
    except Exception: pass
    img = bpy.data.images.new(name, AO_N, AO_N, alpha=False); img.generated_color = (1, 1, 1, 1)
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
        gz = (ground_at or {}).get(ob.name, 0.0)
        ground.location = (0, 0, (gz if gz is not None else -500.0) - 0.01)
        for o2 in bpy.data.objects: o2.hide_render = o2 is not ob and o2 is not ground
        bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type='AO', margin=3, use_clear=False)
    for o2 in bpy.data.objects: o2.hide_render = False
    bpy.data.objects.remove(ground)
    img.filepath_raw = os.path.join(OUT, name + '.webp'); img.file_format = 'WEBP'; img.save(quality=82)
    return round(os.path.getsize(os.path.join(OUT, name + '.webp')) / 1000)


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


# ── Pardon's Surplus & Salvage (`-- --store`): the big box on Second Thought Ave ──────────────────────────────
# After the Waterville store of the surplus-and-salvage chain on Kennedy Memorial Drive (reference and numbers:
# tools/briefs/tepid-reference.md, "The surplus store"). Writes public/models/pardons.glb (everything below) and
# pardons_far.glb (pd_far alone, for phones and distance). src/world/pardonsStore.ts is the other half of the contract.
#
# Frame: x along the storefront from the east end (0) to the west end (SW), left to right as seen from the lot;
# y up from the store floor (= the lot); z out of the front wall toward the lot (front wall z = 0, back wall z = -SD).
# The entrance block (x 0..SEW) stands SBZ proud of the front wall. Objects, each with its own material in the game:
#   pd_ext    exterior, vertex colour (white panels, red bands, roof, units, sidewalk, bollards, the sign letters)
#   pd_cmu    the split-face block walls (vertex colour; the game lays a block texture over them in meters)
#   pd_glass  storefront glass (see-through), door openings left empty (the game slides its own door leaves)
#   pd_int    interior shell with its light already in the vertex colour (walls, soffit, columns, checkouts, desk)
#   pd_floor  floor (the game tiles it), pd_ceil ceiling (the game draws the tile grid), pd_lights the lamp lenses
#   pd_far    the far box; pd_sign the road sign, pd_corral a cart corral, pd_lamp a lot light (origin at its base)
SW, SD, SH, SEW, SBZ, SEH, SCH = 82.0, 62.0, 6.8, 23.0, 1.6, 8.8, 4.3
S_WHITE, S_RED, S_REDD, S_CMU, S_COPE, S_ROOF = 0xf1f0eb, 0xcc2229, 0x5e1114, 0xb4b6b3, 0x8e908f, 0x3b3e42
S_BRONZE, S_CONC = 0x2e2a26, 0xc9c6be
S_DOORS = [(3.5, 6.5), (16.5, 19.5)]           # entrance openings in the storefront, x0..x1 (two leaves each)
S_LANES = [27.0 + 3.6 * k for k in range(8)]   # checkout counters, west edge x


def _font():
    for f in ('ariblk.ttf', 'arialbd.ttf'):
        p = os.path.join('C:/Windows/Fonts', f)
        if os.path.exists(p): return bpy.data.fonts.load(p)
    return None


def text_into(m, s, height, maxw, place, face_hex, side_hex, extrude=0.06, res=None):
    """Extruded letters into Mesh m. place(tx, ty, tz) maps text space (x right, y up, z toward the reader, centred,
    cap height = `height`, at most `maxw` wide) into the game frame; it must be a rotation, not a mirror."""
    cu = bpy.data.curves.new('txt', 'FONT'); cu.body = s
    f = _font()
    if f: cu.font = f
    cu.size = 1.0; cu.extrude = extrude; cu.resolution_u = res or (3 if height > 1 else 1); cu.align_x = 'CENTER'; cu.align_y = 'CENTER'
    ob = bpy.data.objects.new('txt', cu); bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get(); eo = ob.evaluated_get(dg); me = eo.to_mesh()
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
    k = height / max(1e-6, max(ys) - min(ys))
    k = min(k, maxw / max(1e-6, max(xs) - min(xs)))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    for p in me.polygons:
        pts = [me.vertices[i].co for i in p.vertices]
        col = face_hex if abs(p.normal.z) > 0.7 else side_hex
        m.face([place((v.x - cx) * k, (v.y - cy) * k, v.z) for v in pts], col, 0.0)
    eo.to_mesh_clear(); bpy.data.objects.remove(ob); bpy.data.curves.remove(cu)


def cyl(m, cx, cz, r, y0, y1, hex_, n=8, top=True):
    pts = [(cx + r * cos(2 * pi * i / n), cz + r * sin(2 * pi * i / n)) for i in range(n)]
    for i in range(n):
        (ax, az), (bx, bz) = pts[i], pts[(i + 1) % n]
        m.face([(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)], hex_, 0.0, ((ax + bx) / 2 - cx, 0, (az + bz) / 2 - cz))
    if top: m.face([(x, y1, z) for x, z in pts], hex_, 0.0, (0, 1, 0))


def wall_x(m, x, z0, z1, bands, nx):
    """A wall in the plane x = const, in horizontal bands [(y0, y1, hex)], facing nx."""
    for y0, y1, h in bands: m.face([(x, y0, z0), (x, y0, z1), (x, y1, z1), (x, y1, z0)], h, 0.0, (nx, 0, 0))


def wall_z(m, z, x0, x1, bands, nz):
    for y0, y1, h in bands: m.face([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], h, 0.0, (0, 0, nz))


def store_build():
    ext, cmu, gl, it, fl, ce, li, far = Mesh(), Mesh(), Mesh(), Mesh(), Mesh(), Mesh(), Mesh(), Mesh()
    rnd = random.Random(458)
    # ── Block walls: front (west of the entrance block), both ends, back; a red stripe and a coping all round.
    STR = (2.35, 2.7)
    cmu.face([(SEW, 0, 0), (SW, 0, 0), (SW, SH, 0), (SEW, SH, 0)], S_CMU, 1.0, (0, 0, 1))
    cmu.face([(SW, 0, 0), (SW, 0, -SD), (SW, SH, -SD), (SW, SH, 0)], S_CMU, 1.0, (1, 0, 0))
    cmu.face([(0, 0, -SD), (SW, 0, -SD), (SW, SH, -SD), (0, SH, -SD)], S_CMU, 1.0, (0, 0, -1))
    cmu.face([(0, 0, -2), (0, 0, -SD), (0, SH, -SD), (0, SH, -2)], S_CMU, 1.0, (-1, 0, 0))
    # The raised parapet beside the entrance block.
    cmu.face([(SEW, SH, 0), (SEW + 10, SH, 0), (SEW + 10, 7.9, 0), (SEW, 7.9, 0)], 0xc3c5c2, 1.0, (0, 0, 1))
    ext.box(SEW, SEW + 10, SH, 7.9, -0.6, 0, 0xc3c5c2, skip='fb')
    ext.box(SEW - 0.02, SEW + 10.08, 7.9, 8.1, -0.68, 0.06, S_COPE, skip='b')
    q = 0.03
    ext.box(SEW, SW + q, STR[0], STR[1], -0.0, q, S_RED, skip='lkb')
    ext.box(SW, SW + q, STR[0], STR[1], -SD - q, 0, S_RED, skip='lkbft')
    ext.box(-q, SW + q, STR[0], STR[1], -SD - q, -SD, S_RED, skip='fbt')
    ext.box(-q, 0, STR[0], STR[1], -SD - q, -2, S_RED, skip='rbtf')
    for (x0, x1, z0, z1) in ((SEW + 10, SW, -0.05, 0.05), (SW - 0.05, SW + 0.05, -SD, 0), (0, SW, -SD - 0.05, -SD + 0.05), (-0.05, 0.05, -SD, -2)):
        ext.box(x0, x1, SH - 0.22, SH + 0.05, z0, z1, S_COPE, skip='b')
    ext.face([(0, 6.6, 0), (SW, 6.6, 0), (SW, 6.6, -SD), (0, 6.6, -SD)], S_ROOF, 0.0, (0, 1, 0))
    for _ in range(11):
        ux, uz = rnd.uniform(SEW + 14, SW - 6), rnd.uniform(-SD + 6, -8)
        ext.box(ux, ux + 2.4, 6.6, 8.0, uz, uz + 1.6, 0xb7b9b6, skip='b')
        ext.box(ux + 0.3, ux + 2.1, 8.0, 8.12, uz + 0.2, uz + 1.4, 0x9a9c99, skip='b')
    ext.box(30, 30.1, 6.6, 12.8, -6.1, -6.0, 0xd0d0cc)
    # Overhead door and a steel door in the block front, at the west end.
    ext.face([(73, 0, 0.02), (77, 0, 0.02), (77, 3.9, 0.02), (73, 3.9, 0.02)], 0xe7e7e3, 0.0, (0, 0, 1))
    for k in range(7): ext.face([(73, 0.5 + k * 0.55, 0.03), (77, 0.5 + k * 0.55, 0.03), (77, 0.53 + k * 0.55, 0.03), (73, 0.53 + k * 0.55, 0.03)], 0xb9b9b5, 0.0, (0, 0, 1))
    ext.box(72.8, 77.2, 3.9, 4.05, 0, 0.08, 0x8a8c8b)
    ext.face([(61, 0, 0.02), (62, 0, 0.02), (62, 2.15, 0.02), (61, 2.15, 0.02)], 0x8e9399, 0.0, (0, 0, 1))
    # ── The white entrance block, its red bands and the sign.
    Z = SBZ
    ext.face([(0, 3.75, Z), (SEW, 3.75, Z), (SEW, SEH, Z), (0, SEH, Z)], S_WHITE, 0.0, (0, 0, 1))
    for x0, x1 in ((0, 0.6), (SEW - 0.6, SEW)): ext.face([(x0, 0, Z), (x1, 0, Z), (x1, 3.75, Z), (x0, 3.75, Z)], S_WHITE, 0.0, (0, 0, 1))
    ext.face([(0, 0, -2), (0, 0, Z), (0, SEH, Z), (0, SEH, -2)], S_WHITE, 0.0, (-1, 0, 0))
    ext.face([(SEW, 0, Z), (SEW, 0, 0), (SEW, SEH, 0), (SEW, SEH, Z)], S_WHITE, 0.0, (1, 0, 0))
    ext.face([(SEW, SH, 0), (SEW, SH, -2), (SEW, SEH, -2), (SEW, SEH, 0)], S_WHITE, 0.0, (1, 0, 0))
    ext.face([(0, SEH, Z), (SEW, SEH, Z), (SEW, SEH, -2), (0, SEH, -2)], S_ROOF, 0.0, (0, 1, 0))
    ext.face([(0, 6.6, -2), (SEW, 6.6, -2), (SEW, SEH, -2), (0, SEH, -2)], S_WHITE, 0.0, (0, 0, -1))
    ext.box(-0.08, SEW + 0.08, SEH - 0.38, SEH + 0.04, -2.08, Z + 0.1, S_RED, skip='b')
    ext.box(-0.05, SEW + 0.05, 3.85, 4.45, -0.05, Z + 0.07, S_RED, skip='k')
    text_into(ext, "PARDON'S", 2.3, 20.0, lambda x, y, z: (SEW / 2 + x, 6.25 + y, Z + 0.1 + z), S_RED, S_REDD, 0.07)
    # Storefront: bronze frame and mullions, a transom bar, glass; the door openings stay open (the game's leaves).
    gx0, gx1 = 0.6, SEW - 0.6
    ext.box(gx0, gx1, 3.62, 3.75, Z - 0.12, Z + 0.02, S_BRONZE)
    ext.box(gx0, gx1, 0, 0.12, Z - 0.12, Z + 0.02, S_BRONZE)
    xs = [gx0 + k * (gx1 - gx0) / 14 for k in range(15)]
    for d0, d1 in S_DOORS: xs += [d0, d1]
    for x in sorted(set(round(v, 3) for v in xs)):
        if any(d0 + 0.05 < x < d1 - 0.05 for d0, d1 in S_DOORS): continue
        ext.box(x - 0.06, x + 0.06, 0, 3.75, Z - 0.12, Z + 0.03, S_BRONZE)
    ext.box(gx0, gx1, 2.4, 2.5, Z - 0.12, Z + 0.03, S_BRONZE)
    for d0, d1 in S_DOORS: ext.box(d0, d1, 2.28, 2.4, Z - 0.14, Z + 0.03, S_BRONZE)
    segs, x = [], gx0
    for d0, d1 in S_DOORS: segs.append((x, d0)); x = d1
    segs.append((x, gx1))
    for a, b in segs: gl.face([(a, 0.12, Z - 0.05), (b, 0.12, Z - 0.05), (b, 2.4, Z - 0.05), (a, 2.4, Z - 0.05)], 0x8fa3aa, 0.5, (0, 0, 1))
    gl.face([(gx0, 2.5, Z - 0.05), (gx1, 2.5, Z - 0.05), (gx1, 3.62, Z - 0.05), (gx0, 3.62, Z - 0.05)], 0x8fa3aa, 0.5, (0, 0, 1))
    # Sidewalk along the front, red bollards at the entrance block.
    ext.face([(SEW, 0.03, 0), (SW + 1.5, 0.03, 0), (SW + 1.5, 0.03, 4.0), (SEW, 0.03, 4.0)], S_CONC, 0.0, (0, 1, 0))
    ext.face([(-1.5, 0.03, Z), (SEW, 0.03, Z), (SEW, 0.03, Z + 4.2), (-1.5, 0.03, Z + 4.2)], S_CONC, 0.0, (0, 1, 0))
    ext.face([(-1.5, 0.03, -SD), (-1.5, 0.03, Z), (0, 0.03, Z), (0, 0.03, -SD)], S_CONC, 0.0, (0, 1, 0))
    for k in range(11):
        bx = 1.1 + k * 2.08
        cyl(ext, bx, Z + 3.7, 0.15, 0.03, 1.1, 0xc42a2e)
        cyl(ext, bx, Z + 3.7, 0.16, 1.1, 1.16, 0xb22428)
    # ── Interior shell. Light baked as a gentle fall-off up the walls (fluorescent rows, even light).
    i0, i1, d0 = 0.3, SW - 0.3, -SD + 0.3
    WB = [(0, 0.12, 0x4d4d4d), (0.12, 1.2, 0xe6e4de), (1.2, 2.2, 0xe9e7e1), (2.2, 3.0, 0xe8e6e0), (3.0, 3.45, 0xbf232c), (3.45, SCH, 0xd8d6d0)]
    wall_x(it, i0, d0, Z - 0.12, WB, 1)
    wall_x(it, i1, d0, -0.3, WB, -1)
    wall_z(it, d0, i0, i1, WB, 1)
    wall_z(it, -0.3, SEW - 0.3, i1, WB, -1)
    wall_x(it, SEW - 0.3, -0.3, Z - 0.12, WB, -1)
    wall_z(it, Z - 0.12, i0, SEW - 0.3, [(3.75, SCH, 0xdcdad4)], -1)
    for x0, x1 in ((i0, gx0 + 0.06), (gx1 - 0.06, SEW - 0.3)): wall_z(it, Z - 0.12, x0, x1, [(0, 3.75, 0xdcdad4)], -1)
    it.face([(73, 0, -0.29), (77, 0, -0.29), (77, 3.9, -0.29), (73, 3.9, -0.29)], 0xa9adb1, 0.0, (0, 0, -1))
    # Back wall: stockroom double doors, the office door.
    for dx, wd in ((6, 1.0), (20, 2.4), (41, 2.4), (66, 2.4)):
        it.face([(dx, 0, d0 + 0.02), (dx + wd, 0, d0 + 0.02), (dx + wd, 2.3, d0 + 0.02), (dx, 2.3, d0 + 0.02)], 0x8d9196, 0.0, (0, 0, 1))
        if wd > 2: it.face([(dx + wd / 2 - 0.02, 0, d0 + 0.03), (dx + wd / 2 + 0.02, 0, d0 + 0.03), (dx + wd / 2 + 0.02, 2.3, d0 + 0.03), (dx + wd / 2 - 0.02, 2.3, d0 + 0.03)], 0x55585c, 0.0, (0, 0, 1))
        for wx in ((dx + 0.35, dx + 0.75), (dx + wd - 0.75, dx + wd - 0.35)) if wd > 2 else ((dx + 0.3, dx + 0.7),):
            it.face([(wx[0], 1.3, d0 + 0.035), (wx[1], 1.3, d0 + 0.035), (wx[1], 1.85, d0 + 0.035), (wx[0], 1.85, d0 + 0.035)], 0x2a2f33, 0.0, (0, 0, 1))
    # Columns on a 12 m grid.
    for cx in (11, 23, 35, 47, 59, 71):
        for cz in (-14, -26, -38, -50):
            it.box(cx - 0.15, cx + 0.15, 0, SCH, cz - 0.15, cz + 0.15, 0xe0e0dc, skip='tb')
            it.box(cx - 0.17, cx + 0.17, 0, 0.1, cz - 0.17, cz + 0.17, 0x56595c, skip='b')
    # The soffit over the front (checkouts and the way in), red stripe and the name facing into the store.
    SZ = -9.0
    it.face([(i0, 3.3, -0.3), (60, 3.3, -0.3), (60, 3.3, SZ), (i0, 3.3, SZ)], 0xe4e3de, 0.0, (0, -1, 0))
    it.face([(i0, 3.3, SZ), (60, 3.3, SZ), (60, SCH, SZ), (i0, SCH, SZ)], 0xeceae4, 0.0, (0, 0, -1))
    it.face([(60, 3.3, SZ), (60, 3.3, -0.3), (60, SCH, -0.3), (60, SCH, SZ)], 0xeceae4, 0.0, (1, 0, 0))
    it.box(i0, 60.02, 3.3, 3.55, SZ - 0.03, SZ, 0xc4232d, skip='kt')
    text_into(it, "PARDON'S", 0.55, 6.0, lambda x, y, z: (14 - x, 3.95 + y, SZ - 0.04 - z), S_RED, S_REDD, 0.02)
    text_into(it, "PARDON'S", 0.55, 6.0, lambda x, y, z: (44 - x, 3.95 + y, SZ - 0.04 - z), S_RED, S_REDD, 0.02)
    # Its face toward the doors, over the way in: the name again, as you walk in.
    it.face([(i0, 3.3, -0.3), (SEW - 0.3, 3.3, -0.3), (SEW - 0.3, SCH, -0.3), (i0, SCH, -0.3)], 0xeceae4, 0.0, (0, 0, 1))
    it.face([(i0, 3.3, -0.29), (SEW - 0.3, 3.3, -0.29), (SEW - 0.3, 3.55, -0.29), (i0, 3.55, -0.29)], 0xc4232d, 0.0, (0, 0, 1))
    text_into(it, "PARDON'S", 0.5, 6.0, lambda x, y, z: (11.5 + x, 3.95 + y, -0.27 + z), S_RED, S_REDD, 0.02)
    for k in range(int((60 - 2) / 3)):
        for zz in (-2.4, -6.4):
            x = 2 + k * 3; li.face([(x - 0.13, 3.29, zz - 0.13), (x + 0.13, 3.29, zz - 0.13), (x + 0.13, 3.29, zz + 0.13), (x - 0.13, 3.29, zz + 0.13)], 0xffffff, 0.0, (0, -1, 0))
    # Checkout lanes: red counters with a black belt, a register stand at the front end, a numbered lane light.
    for n, lx in enumerate(S_LANES):
        it.box(lx, lx + 0.8, 0, 0.88, -7.2, -3.0, 0xc22430, skip='b')
        it.box(lx - 0.02, lx + 0.82, 0.88, 0.93, -7.22, -3.0, 0x2c2d30, skip='b')
        it.box(lx + 0.1, lx + 0.7, 0.93, 0.95, -6.9, -4.6, 0x18191b, skip='b')
        it.box(lx, lx + 0.8, 0, 1.12, -3.0, -2.3, 0x3a3c40, skip='b')
        it.box(lx + 0.15, lx + 0.65, 1.12, 1.45, -2.9, -2.5, 0x202124, skip='b')
        it.box(lx + 0.8, lx + 1.5, 0, 0.82, -3.6, -2.3, 0xb81f2b, skip='b')
        it.box(lx + 0.35, lx + 0.45, 0.93, 2.6, -7.15, -7.05, 0x9a9da1, skip='b')
        it.box(lx + 0.1, lx + 0.7, 2.6, 3.15, -7.14, -7.06, 0xc4232d)
        num = str(n + 1)
        text_into(it, num, 0.34, 0.4, lambda x, y, z, lx=lx: (lx + 0.4 + x, 2.875 + y, -7.06 + 0.012 + z * 0.2), 0xffffff, 0xffffff, 0.01)
        text_into(it, num, 0.34, 0.4, lambda x, y, z, lx=lx: (lx + 0.4 - x, 2.875 + y, -7.14 - 0.012 - z * 0.2), 0xffffff, 0xffffff, 0.01)
    # Service desk by the door, entrance mats.
    it.box(1.0, 7.0, 0, 1.05, -6.4, -5.6, 0xc22430, skip='b'); it.box(0.95, 7.05, 1.05, 1.1, -6.45, -5.55, 0x2c2d30, skip='b')
    it.box(6.2, 7.0, 0, 1.05, -9.0, -6.4, 0xc22430, skip='b')
    for a, b in S_DOORS: fl.face([(a - 0.8, 0.008, -3.0), (b + 0.8, 0.008, -3.0), (b + 0.8, 0.008, Z - 0.14), (a - 0.8, 0.008, Z - 0.14)], 0x26282b, 0.5, (0, 1, 0))
    # Floor and ceiling (the game tiles them); the lamp lenses in rows of 2x4 troffers past the soffit.
    fl.face([(i0, 0, d0), (i1, 0, d0), (i1, 0, -0.3), (i0, 0, -0.3)], 0xffffff, 1.0, (0, 1, 0))
    fl.face([(i0, 0, -0.3), (SEW - 0.3, 0, -0.3), (SEW - 0.3, 0, Z - 0.12), (i0, 0, Z - 0.12)], 0xffffff, 1.0, (0, 1, 0))
    ce.face([(i0, SCH, d0), (i1, SCH, d0), (i1, SCH, -0.3), (i0, SCH, -0.3)], 0xffffff, 1.0, (0, -1, 0))
    ce.face([(i0, SCH, -0.3), (SEW - 0.3, SCH, -0.3), (SEW - 0.3, SCH, Z - 0.12), (i0, SCH, Z - 0.12)], 0xffffff, 1.0, (0, -1, 0))
    x = 2.4
    while x < SW - 1.5:
        z = -10.8
        while z > -SD + 1.5:
            if not (x < 60 and z > SZ - 0.5):
                li.face([(x - 0.3, SCH - 0.01, z - 0.6), (x + 0.3, SCH - 0.01, z - 0.6), (x + 0.3, SCH - 0.01, z + 0.6), (x - 0.3, SCH - 0.01, z + 0.6)], 0xffffff, 0.0, (0, -1, 0))
            z -= 2.4
        x += 3.6
    for k in range(int((SW - 2 - 61) / 3) + 1):
        for zz in (-2.4, -6.4):
            x = 62 + k * 3
            li.face([(x - 0.3, SCH - 0.01, zz - 0.6), (x + 0.3, SCH - 0.01, zz - 0.6), (x + 0.3, SCH - 0.01, zz + 0.6), (x - 0.3, SCH - 0.01, zz + 0.6)], 0xffffff, 0.0, (0, -1, 0))
    # ── Far: the outline and the colours that read from a distance.
    far.box(0, SW, 0, SH, -SD, 0, S_CMU, skip='b')
    far.box(0, SEW, 0, SEH, -2, Z, S_WHITE, skip='b')
    far.box(-0.05, SEW + 0.05, SEH - 0.38, SEH, -2, Z + 0.05, S_RED, skip='bk')
    far.box(-0.05, SEW + 0.05, 3.85, 4.45, -1, Z + 0.05, S_RED, skip='bkt')
    far.box(SEW, SW + 0.03, STR[0], STR[1], -SD - 0.03, 0.03, S_RED, skip='bklt')
    far.face([(0.6, 0.1, Z + 0.02), (SEW - 0.6, 0.1, Z + 0.02), (SEW - 0.6, 3.7, Z + 0.02), (0.6, 3.7, Z + 0.02)], 0x23292d, 0.0, (0, 0, 1))
    text_into(far, "PARDON'S", 2.3, 20.0, lambda x, y, z: (SEW / 2 + x, 6.25 + y, Z + 0.06 + z * 0.3), S_RED, S_REDD, 0.04, 1)
    return dict(pd_ext=ext, pd_cmu=cmu, pd_glass=gl, pd_int=it, pd_floor=fl, pd_ceil=ce, pd_lights=li, pd_far=far)


def store_props():
    sign, cor, lamp = Mesh(), Mesh(), Mesh()
    # Road sign: two steel posts, a white cabinet with the name both ways, the red band, a reader board.
    for px in (-1.7, 1.7): sign.box(px - 0.17, px + 0.17, 0, 9.4, -0.17, 0.17, 0x6d7177, skip='b')
    sign.box(-2.9, 2.9, 0, 0.6, -0.6, 0.6, 0x8c8a85, skip='b')
    sign.box(-2.8, 2.8, 6.3, 9.2, -0.35, 0.35, S_WHITE, skip='b')
    sign.box(-2.85, 2.85, 9.2, 9.35, -0.4, 0.4, S_RED, skip='b')
    sign.box(-2.8, 2.8, 6.3, 7.0, -0.37, 0.37, S_RED, skip='tb')
    for sgn in (1, -1):
        text_into(sign, "PARDON'S", 1.25, 5.2, lambda x, y, z, s=sgn: (s * x, 8.05 + y, s * (0.37 + z * 0.4)), S_RED, S_REDD, 0.03)
        text_into(sign, "SURPLUS & SALVAGE", 0.36, 4.8, lambda x, y, z, s=sgn: (s * x, 6.65 + y, s * (0.385 + z * 0.2)), S_WHITE, S_WHITE, 0.01)
        text_into(sign, "NEW STUFF EVERY DAY", 0.34, 4.4, lambda x, y, z, s=sgn: (s * x, 5.35 + y, s * (0.24 + z * 0.2)), 0x1d1d1f, 0x1d1d1f, 0.01)
        text_into(sign, "PRICES YOU WONT REGRET", 0.3, 4.4, lambda x, y, z, s=sgn: (s * x, 4.75 + y, s * (0.24 + z * 0.2)), 0x1d1d1f, 0x1d1d1f, 0.01)
    sign.box(-2.5, 2.5, 4.3, 5.8, -0.22, 0.22, 0xf4f4f0, skip='b')
    sign.box(-2.55, 2.55, 5.8, 5.9, -0.25, 0.25, 0x3a3c40, skip='b')
    sign.box(-2.55, 2.55, 4.2, 4.3, -0.25, 0.25, 0x3a3c40)
    # Cart corral: galvanised pipe, 6 m long, 1.3 m wide, open at z = +3, a sign at the closed end.
    G = 0xa9aeb2
    for px in (-0.65, 0.65):
        for py in (0.45, 1.0): cor.box(px - 0.03, px + 0.03, py - 0.03, py + 0.03, -3, 3, G)
        for pz in (-3, -1, 1, 3): cor.box(px - 0.03, px + 0.03, 0, 1.0, pz - 0.03, pz + 0.03, G, skip='b')
    for py in (0.45, 1.0): cor.box(-0.65, 0.65, py - 0.03, py + 0.03, -3.03, -2.97, G)
    cor.box(-0.03, 0.03, 1.0, 2.1, -3.03, -2.97, G, skip='b')
    cor.box(-0.45, 0.45, 1.55, 2.15, -3.0, -2.98, S_WHITE)
    cor.box(-0.45, 0.45, 1.95, 2.15, -3.0, -2.975, S_RED, skip='k')
    text_into(cor, "PARDON'S", 0.13, 0.8, lambda x, y, z: (x, 2.05 + y, -2.97 + z * 0.1), S_WHITE, S_WHITE, 0.005)
    text_into(cor, "RETURN CARTS HERE", 0.1, 0.8, lambda x, y, z: (x, 1.72 + y, -2.97 + z * 0.1), S_RED, S_RED, 0.005)
    # Lot light: square steel pole, 10 m, two shoebox heads.
    lamp.box(-0.11, 0.11, 0, 10.0, -0.11, 0.11, 0x55595d, skip='b')
    lamp.box(-0.35, 0.35, 0, 0.7, -0.35, 0.35, 0xa7a49d, skip='b')
    lamp.box(-1.0, 1.0, 9.85, 9.97, -0.05, 0.05, 0x55595d)
    for hx in (-1.25, 1.25): lamp.box(hx - 0.45, hx + 0.45, 9.8, 10.05, -0.28, 0.28, 0x2f3134, skip='b')
    lens = Mesh()
    for hx in (-1.25, 1.25): lens.face([(hx - 0.4, 9.79, -0.24), (hx + 0.4, 9.79, -0.24), (hx + 0.4, 9.79, 0.24), (hx - 0.4, 9.79, 0.24)], 0xffffff, 0.0, (0, -1, 0))
    return dict(pd_sign=sign, pd_corral=cor, pd_lamp=lamp, pd_lens=lens)


def store_main():
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True)
    parts = store_build(); parts.update(store_props())
    obs, stats = {}, {}
    for name, m in parts.items():
        obs[name] = m.to_object(name, coll); stats[name] = len(m.f)
        try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
        except Exception: pass
    for name in ('pd_ext', 'pd_cmu', 'pd_int', 'pd_far', 'pd_sign', 'pd_corral', 'pd_lamp'): vertex_ao(obs[name], rays=10)
    out = {'faces': stats}
    if '--no-export' not in FLAGS:
        out['pardons_kB'] = export([o for n, o in obs.items() if n != 'pd_far'], os.path.join(OUT, 'pardons.glb'))
        out['far_kB'] = export([obs['pd_far']], os.path.join(OUT, 'pardons_far.glb'))
    obs['pd_sign'].location = (20, 30, 0); obs['pd_corral'].location = (40, 20, 0); obs['pd_lamp'].location = (50, 20, 0)
    obs['pd_far'].location = (0, 0, -30)
    print('BLD_STATS ' + json.dumps(out))


# ── Pardon's stock (`-- --stock`): the fixture kit, the sales-floor layout and the baked floor light (store unit 2) ──
# Writes, in public/models:
#   pardons_kit.glb    one mesh per fixture, at the origin, vertex colour times occlusion (the game instances them):
#     pk_gond   gondola section, 1.22 m long (z) x 1.2 m deep (x), 1.83 m, red base deck, white pegboard, three shelves
#               a side (goods stand at y = GOND_LEVELS); pk_gondp the hardware version (one shelf, pegboard and hooks
#               to 2.13 m); pk_end an endcap facing +z (0.5 m deep); pk_low a fabric table (bolts at 0.75 m)
#     pk_rround round clothing rack (ring 1.2 m at 1.3 m), pk_rline two-way rack (rail 1.5 m along x at 1.35 m)
#     pk_sofa, pk_recl, pk_matt, pk_dress, pk_table furniture (light upholstery: the game tints by instance colour)
#     pk_rack   a pallet-rack bay for flooring rolls (2.4 m along x, 3.6 m deep along -z, beams at ROLL_LEVELS)
#     pk_rugbin a bin of standing rugs' dividers; pk_cart a shopping cart (nose toward -x); pk_reg a register on its
#               stand (top at 1.12 m), pk_candy an impulse rack stocked, pk_bags a bag carousel (on the 0.82 m shelf)
#   pardons_stock.json the layout in the store frame: fx [kit, x, z, rot, dept] and runs [x, z0, z1, dept, height]
#                      (each run of gondolas is one collision box in the game); the game stocks the shelves from it
#   pardons_lm.webp    the floor's light, baked in Cycles (GPU) from the troffers and soffit lights with the fixtures,
#                      counters and columns in place: R = the floor (contact shadows under the runs), G = the same
#                      room with no fixtures (what lights the goods and fixtures); 0.5 = the median of G; B = the
#                      ceiling's light (the underside, lit from below by the floor and goods; 0.5 = its median).
#                      u = x / SW, v = (z + SD) / (SD + SBZ), 20 px a meter.
PK_DEPTS = [('grocery', 1.5, 21, -40, -11, 'gondola'), ('hba', 1.5, 21, -57, -42, 'gondola'),
            ('house', 24, 45, -34, -11, 'gondola'), ('hardware', 24, 45, -57, -36, 'gondola'),
            ('clothing', 48, 58, -57, -11, 'racks'), ('fabric', 61, 80, -30, -11, 'gondola'),
            ('furniture', 61, 80, -50, -32, 'floor'), ('flooring', 61, 81.4, -57.5, -51, 'rolls')]
PK_COLS = [(cx, cz) for cx in (11, 23, 35, 47, 59, 71) for cz in (-14, -26, -38, -50)]
GL = 1.22
GOND_H = {'pk_gond': 1.83, 'pk_gondp': 2.13, 'pk_low': 1.1}
GOND_RED, GOND_WHITE, SHELF = 0xc22430, 0xefefeb, 0xe3e3df


def stock_layout():
    fx, runs = [], []
    for di, (name, x0, x1, z0, z1, fill) in enumerate(PK_DEPTS):
        if fill == 'gondola':
            kit = 'pk_gondp' if name == 'hardware' else ('pk_low' if name == 'fabric' else 'pk_gond')
            ends = kit != 'pk_low'
            k = 0
            while 0.6 + 3.6 * k + 0.6 <= x1:
                x = 0.6 + 3.6 * k; k += 1
                if x - 0.6 < x0: continue
                blocks = [(cz - 0.8, cz + 0.8) for cx, cz in PK_COLS if abs(cx - x) < 0.8]
                if z1 - z0 > 18: zm = (z0 + z1) / 2; blocks.append((zm - 1.3, zm + 1.3))
                free, top = [], z1
                for b0, b1 in sorted(blocks, key=lambda b: -b[1]):
                    if b1 < top and b1 > z0: free.append((max(z0, b1), top))
                    top = min(top, b0)
                if top > z0: free.append((z0, top))
                for za, zb in free:
                    n = int((zb - za - (1.0 if ends else 0)) / GL)
                    if n < 2: continue
                    L = n * GL; zc = (za + zb) / 2
                    for i in range(n): fx.append([kit, x, zc + L / 2 - GL / 2 - i * GL, 0, di])
                    e = 0.5 if ends else 0
                    if ends:
                        fx.append(['pk_end', x, zc + L / 2 + 0.25, 0, di]); fx.append(['pk_end', x, zc - L / 2 - 0.25, pi, di])
                    runs.append([x, round(zc - L / 2 - e, 3), round(zc + L / 2 + e, 3), di, GOND_H[kit]])
        elif fill == 'racks':
            for j in range(17):
                z = z1 - 1.6 - j * 2.65
                if z < z0 + 0.8: break
                for i, x in enumerate((49.7, 53.0, 56.3)):
                    fx.append(['pk_rround' if (i + j) % 2 == 0 else 'pk_rline', x, z, 0 if (i + j) % 4 < 2 else pi / 2, di])
        elif fill == 'floor':
            for x in (63.2, 66.8, 75.0, 78.4): fx.append(['pk_sofa', x, -33.6, 0, di])
            for x in (62.4, 64.0, 65.6, 67.2, 68.8, 74.0, 75.6, 77.2, 78.8): fx.append(['pk_recl', x, -37.4, 0, di])
            for x in (62.9, 65.4, 67.9, 74.2, 76.7, 79.2): fx.append(['pk_matt', x, -42.4, 0, di])
            for x in (63.0, 65.2, 74.0, 76.2): fx.append(['pk_dress', x, -46.9, 0, di])
            for x in (68.0, 78.5): fx.append(['pk_table', x, -47.2, 0, di])
        elif fill == 'rolls':
            for b in range(8): fx.append(['pk_rack', 62.4 + b * 2.4, -53.95, 0, di])
            for x in (63.0, 66.0, 69.0, 74.0, 77.0): fx.append(['pk_rugbin', x, -51.6, 0, di])
    # Carts nested in two rows between the entrances, and the checkout detail.
    for r, zz in enumerate((1.0, 0.25)):
        for i in range(16): fx.append(['pk_cart', 8.2 + i * 0.32 + r * 0.6, zz, 0, -1])
    for lx in S_LANES:
        fx.append(['pk_reg', lx + 0.4, -2.65, 0, -1]); fx.append(['pk_candy', lx + 3.35, -5.7, 0, -1])
        fx.append(['pk_bags', lx + 1.15, -2.95, 0, -1])
    return fx, runs


def kit_gond(m, kit):
    H = GOND_H[kit]; hz = GL / 2
    if kit == 'pk_low':
        for sx in (-1, 1):
            for sz in (-1, 1): m.box(sx * 0.55 - 0.03, sx * 0.55 + 0.03, 0, 0.7, sz * 0.55 - 0.03, sz * 0.55 + 0.03, 0x8a8c8f, skip='b')
        m.box(-0.6, 0.6, 0.55, 0.7, -hz, hz, GOND_RED, skip='t')
        m.box(-0.6, 0.6, 0.7, 0.75, -hz, hz, 0xe6e4de)
        m.box(-0.025, 0.025, 0.75, H, -hz, hz, GOND_WHITE, skip='b')
        m.box(-0.6, 0.6, 0.04, 0.08, -hz + 0.05, hz - 0.05, 0x8a8c8f)
        return
    m.box(-0.6, 0.6, 0, 0.14, -hz, hz, GOND_RED, skip='tb')
    m.face([(-0.6, 0.14, -hz), (0.6, 0.14, -hz), (0.6, 0.14, hz), (-0.6, 0.14, hz)], SHELF, 0.0, (0, 1, 0))
    m.box(-0.03, 0.03, 0.14, H, -hz, hz, GOND_WHITE, skip='b')
    for sz in (-1, 1): m.box(-0.045, 0.045, 0.0, H + 0.02, sz * hz - 0.02, sz * hz + 0.02, 0xa9abad, skip='b')
    levels = (0.55,) if kit == 'pk_gondp' else (0.55, 0.95, 1.35)
    for sx in (-1, 1):
        for y in levels:
            m.box(sx * 0.03, sx * 0.58, y - 0.025, y, -hz + 0.02, hz - 0.02, SHELF)
            m.box(sx * 0.58, sx * 0.605, y - 0.06, y + 0.012, -hz + 0.02, hz - 0.02, 0xf6f6f2)
            for t in range(3):
                tz = -hz + 0.2 + t * 0.4 + (0.05 if sx > 0 else -0.03)
                m.box(sx * 0.606, sx * 0.607, y - 0.052, y + 0.004, tz, tz + 0.06, 0xf2d03a if t == 1 and y == 0.95 else 0xffffff, skip='b')
        m.box(sx * 0.58, sx * 0.605, 0.11, 0.15, -hz + 0.02, hz - 0.02, 0xf6f6f2)
        if kit == 'pk_gondp':
            for y in (1.0, 1.32, 1.64, 1.96):
                for i in range(5):
                    hz0 = -hz + 0.16 + i * 0.225
                    m.box(sx * 0.03, sx * 0.3, y - 0.006, y + 0.006, hz0 - 0.004, hz0 + 0.004, 0xb5b8bb, skip='b')
    m.box(-0.07, 0.07, H, H + 0.03, -hz, hz, 0xd8d8d4, skip='b')


def kit_end(m):
    m.box(-0.6, 0.6, 0, 0.14, -0.25, 0.25, GOND_RED, skip='tbk')
    m.face([(-0.6, 0.14, -0.22), (0.6, 0.14, -0.22), (0.6, 0.14, 0.25), (-0.6, 0.14, 0.25)], SHELF, 0.0, (0, 1, 0))
    m.box(-0.6, 0.6, 0.14, 1.83, -0.25, -0.22, GOND_WHITE, skip='bk')
    for sx in (-1, 1): m.box(sx * 0.6 - 0.02, sx * 0.6 + 0.02, 0, 1.85, -0.25, -0.2, 0xa9abad, skip='b')
    for y in (0.55, 0.95, 1.35):
        m.box(-0.58, 0.58, y - 0.025, y, -0.22, 0.23, SHELF)
        m.box(-0.58, 0.58, y - 0.06, y + 0.012, 0.23, 0.255, 0xf6f6f2)
    m.box(-0.58, 0.58, 0.11, 0.15, 0.23, 0.255, 0xf6f6f2)


def kit_rack(m, round_):
    G = 0xb8bbbe
    if round_:
        for a in range(4):
            ca, sa = round(cos(a * pi / 2)), round(sin(a * pi / 2))
            m.box(min(0, ca * 0.55) - 0.02, max(0, ca * 0.55) + 0.02, 0.02, 0.05, min(0, sa * 0.55) - 0.02, max(0, sa * 0.55) + 0.02, G)
        m.box(-0.025, 0.025, 0.02, 1.3, -0.025, 0.025, G, skip='b')
        n = 12
        for i in range(n):
            a0, a1 = 2 * pi * i / n, 2 * pi * (i + 1) / n
            p0 = (0.6 * cos(a0), 0.6 * sin(a0)); p1 = (0.6 * cos(a1), 0.6 * sin(a1))
            for y0, y1, o in ((1.29, 1.31, 0.0), (1.27, 1.33, 0.015)):
                m.face([(p0[0], y1, p0[1]), (p1[0], y1, p1[1]), (p1[0], y0, p1[1]), (p0[0], y0, p0[1])], G, 0.0, ((p0[0] + p1[0]), 0, (p0[1] + p1[1])))
            m.face([(p0[0] * 0.97, 1.31, p0[1] * 0.97), (p1[0] * 0.97, 1.31, p1[1] * 0.97), (p1[0], 1.31, p1[1]), (p0[0], 1.31, p0[1])], G, 0.0, (0, 1, 0))
        for a in (0, pi / 2): m.box(-0.6 * abs(cos(a)) - 0.01, 0.6 * abs(cos(a)) + 0.01, 1.28, 1.3, -0.6 * abs(sin(a)) - 0.01, 0.6 * abs(sin(a)) + 0.01, G)
    else:
        for sx in (-0.75, 0.75):
            m.box(sx - 0.02, sx + 0.02, 0.02, 1.38, -0.02, 0.02, G, skip='b')
            m.box(sx - 0.03, sx + 0.03, 0.0, 0.05, -0.32, 0.32, G)
        for sz in (-0.27, 0.27): m.box(-0.78, 0.78, 1.33, 1.36, sz - 0.012, sz + 0.012, G)
        m.box(-0.75, 0.75, 0.12, 0.15, -0.015, 0.015, G)


def kit_furniture():
    U, D = 0xe2e0dc, 0x2b2420
    so, re, ma, dr, ta = Mesh(), Mesh(), Mesh(), Mesh(), Mesh()
    for sx in (-1, 1):
        for sz in (-1, 1): so.box(sx * 0.95 - 0.03, sx * 0.95 + 0.03, 0, 0.1, sz * 0.38 - 0.03, sz * 0.38 + 0.03, D, skip='b')
    so.box(-1.05, 1.05, 0.1, 0.42, -0.46, 0.46, shade(U, 0.92), skip='b')
    so.box(-1.05, 1.05, 0.42, 0.88, -0.46, -0.24, U)
    for sx in (-1, 1): so.box(sx * 1.05 - sx * 0.18, sx * 1.05, 0.42, 0.66, -0.46, 0.46, U)
    for i in range(3):
        x0 = -0.87 + i * 0.58
        so.box(x0 + 0.01, x0 + 0.57, 0.42, 0.55, -0.24, 0.45, shade(U, 1.04) if i != 1 else U)
        so.box(x0 + 0.03, x0 + 0.55, 0.55, 0.84, -0.24, -0.1, shade(U, 1.02))
    so.box(0.6, 0.8, 0.85, 0.86, -0.3, -0.29, 0xf4f4f4)
    re.box(-0.42, 0.42, 0.0, 0.12, -0.4, 0.4, D, skip='b')
    re.box(-0.45, 0.45, 0.12, 0.48, -0.45, 0.45, shade(U, 0.94), skip='b')
    re.box(-0.33, 0.33, 0.48, 0.58, -0.25, 0.42, U)
    re.box(-0.36, 0.36, 0.48, 1.05, -0.45, -0.22, U)
    for sx in (-1, 1): re.box(sx * 0.45 - sx * 0.12, sx * 0.45, 0.48, 0.7, -0.45, 0.45, U)
    ma.box(-0.78, 0.78, 0, 0.36, -1.03, 1.03, 0x3c3e42, skip='b')
    ma.box(-0.76, 0.76, 0.36, 0.64, -1.0, 1.0, 0xf3f2ee, skip='b')
    ma.box(-0.765, 0.765, 0.43, 0.47, -1.005, 1.005, 0x8a9db8, skip='tb')
    for i in range(6):
        for j in range(8):
            ma.box(-0.66 + i * 0.25, -0.64 + i * 0.25, 0.64, 0.645, -0.9 + j * 0.25, -0.88 + j * 0.25, 0xd8d6d0, skip='b')
    ma.box(0.5, 0.75, 0.25, 0.6, 1.035, 1.04, 0xfafafa)
    ma.box(0.52, 0.73, 0.5, 0.58, 1.041, 1.042, 0xcc2229)
    W = 0x9a6b44
    dr.box(-0.75, 0.75, 0.05, 0.85, -0.25, 0.25, W, skip='b')
    dr.box(-0.77, 0.77, 0.85, 0.88, -0.27, 0.27, shade(W, 1.08))
    for r in range(3):
        for c in range(2):
            x0, y0 = -0.72 + c * 0.73, 0.1 + r * 0.25
            dr.box(x0, x0 + 0.7, y0, y0 + 0.23, 0.25, 0.262, shade(W, 1.1))
            dr.box(x0 + 0.3, x0 + 0.4, y0 + 0.1, y0 + 0.13, 0.262, 0.28, 0xc9b27a)
    for sx in (-1, 1):
        for sz in (-1, 1): dr.box(sx * 0.7 - 0.03, sx * 0.7 + 0.03, 0, 0.05, sz * 0.2 - 0.03, sz * 0.2 + 0.03, shade(W, 0.7), skip='b')
    ta.box(-0.75, 0.75, 0.72, 0.76, -0.45, 0.45, W)
    for sx in (-1, 1):
        for sz in (-1, 1): ta.box(sx * 0.68 - 0.03, sx * 0.68 + 0.03, 0, 0.72, sz * 0.38 - 0.03, sz * 0.38 + 0.03, shade(W, 0.85), skip='b')
    for cx, cz, f in ((-0.35, 0.62, 1), (0.35, 0.62, 1), (-0.35, -0.62, -1), (0.35, -0.62, -1)):
        ta.box(cx - 0.2, cx + 0.2, 0.44, 0.48, cz - 0.2, cz + 0.2, shade(W, 0.95))
        ta.box(cx - 0.2, cx + 0.2, 0.48, 0.95, cz + f * 0.17, cz + f * 0.2, shade(W, 0.95))
        for sx in (-1, 1):
            for sz in (-1, 1): ta.box(cx + sx * 0.17 - 0.015, cx + sx * 0.17 + 0.015, 0, 0.44, cz + sz * 0.17 - 0.015, cz + sz * 0.17 + 0.015, shade(W, 0.85), skip='b')
    return dict(pk_sofa=so, pk_recl=re, pk_matt=ma, pk_dress=dr, pk_table=ta)


def kit_misc():
    rk, rb, ca, rg, cd, bg = Mesh(), Mesh(), Mesh(), Mesh(), Mesh(), Mesh()
    O, BL = 0xd8642a, 0x2f5a9e
    for sx in (-1.2, 1.2):
        for sz in (0.0, -3.6): rk.box(sx - 0.04, sx + 0.04, 0, 2.5, sz - 0.04, sz + 0.04, BL, skip='b')
        rk.box(sx - 0.02, sx + 0.02, 0.3, 2.4, -3.6, 0.0, BL, skip='tb')
    for y in (0.15, 0.75, 1.35, 1.95):
        for sz in (0.0, -3.6, -1.8): rk.box(-1.2, 1.2, y - 0.1, y, sz - 0.05, sz + 0.05, O)
    rk.box(-1.2, 1.2, 2.4, 2.5, -0.05, 0.05, O)
    G = 0x8d9095
    rb.box(-1.2, 1.2, 0, 0.08, -0.4, 0.4, G, skip='b')
    for sz in (-0.4, 0.4): rb.box(-1.2, 1.2, 0.08, 0.6, sz - 0.02, sz + 0.02, G, skip='b')
    for sx in (-1.2, -0.6, 0, 0.6, 1.2): rb.box(sx - 0.02, sx + 0.02, 0.08, 0.6, -0.4, 0.4, G, skip='b')
    # Cart: wire basket on a frame, nose toward -x, handle at +x (0.95 m long, 0.58 wide).
    W, R = 0xb9bdc1, 0xc4232d
    for sz in (-0.27, 0.27):
        ca.box(-0.45, 0.42, 0.14, 0.17, sz - 0.012, sz + 0.012, W)
        ca.box(0.4, 0.43, 0.14, 1.0, sz - 0.012, sz + 0.012, W)
        for k in range(8): x = -0.4 + k * 0.1; ca.box(x - 0.004, x + 0.004, 0.45, 0.93, sz - 0.006, sz + 0.006, W)
        ca.box(-0.45, 0.4, 0.92, 0.94, sz - 0.01, sz + 0.01, W); ca.box(-0.42, 0.4, 0.45, 0.47, sz - 0.008, sz + 0.008, W)
        for wx in (-0.38, 0.36):
            ca.box(wx - 0.04, wx + 0.04, 0.0, 0.08, sz - 0.015, sz + 0.015, 0x202224)
            ca.box(wx - 0.01, wx + 0.01, 0.06, 0.15, sz - 0.01, sz + 0.01, W)
    for k in range(6): z = -0.25 + k * 0.1; ca.box(-0.45, 0.4, 0.92, 0.935, z - 0.004, z + 0.004, W); ca.box(-0.42, 0.4, 0.45, 0.46, z - 0.004, z + 0.004, W)
    ca.box(-0.47, -0.45, 0.45, 0.94, -0.27, 0.27, W, skip='lr'); ca.box(0.38, 0.4, 0.45, 0.94, -0.27, 0.27, W, skip='lr')
    for k in range(5): z = -0.22 + k * 0.11; ca.box(-0.47, -0.45, 0.45, 0.94, z - 0.004, z + 0.004, W)
    ca.box(0.44, 0.5, 0.98, 1.04, -0.29, 0.29, R)
    ca.box(0.2, 0.39, 0.7, 0.92, -0.25, 0.25, R, skip='b')
    # Register on its stand: screen on a stalk toward the cashier (+x), drawer, keypad; a card terminal toward -x.
    D = 0x1d1e21
    rg.box(-0.2, 0.2, 1.12, 1.24, -0.22, 0.22, 0x2a2b2f, skip='b')
    rg.box(-0.15, 0.15, 1.24, 1.27, -0.18, 0.12, D)
    rg.box(-0.02, 0.02, 1.24, 1.5, 0.14, 0.18, D)
    rg.box(-0.02, 0.06, 1.42, 1.7, 0.0, 0.32, D)
    rg.box(0.06, 0.065, 1.44, 1.68, 0.02, 0.3, 0x5a7d9a)
    rg.box(-0.26, -0.18, 1.12, 1.4, -0.06, 0.06, D)
    rg.box(-0.27, -0.17, 1.4, 1.55, -0.07, 0.07, 0x2c2e33)
    rg.box(-0.275, -0.274, 1.47, 1.53, -0.05, 0.05, 0x4f7f6a)
    rg.box(-0.12, 0.12, 1.27, 1.29, -0.33, -0.23, 0x9ea2a6)
    # Impulse rack: four wire shelves of sweets and gum along z, facing -x and +x.
    rnd = random.Random(31)
    cd.box(-0.18, 0.18, 0, 0.12, -0.8, 0.8, 0x2c2d30, skip='b')
    cd.box(-0.02, 0.02, 0.12, 1.45, -0.8, 0.8, 0x2c2d30, skip='b')
    cd.box(-0.18, 0.18, 1.45, 1.6, -0.8, 0.8, GOND_RED)
    COLS = [0xd23a2a, 0x2b6cc4, 0xf2c230, 0x3aa35a, 0x8a3fb0, 0xf07a1a, 0xffffff, 0x5a3a22, 0xe85a9a]
    for y in (0.2, 0.52, 0.84, 1.16):
        for sx in (-1, 1):
            cd.box(sx * 0.02, sx * 0.18, y - 0.01, y, -0.78, 0.78, 0x9a9da1)
            z = -0.76
            while z < 0.74:
                w = rnd.choice((0.05, 0.07, 0.09, 0.12)); h = rnd.choice((0.12, 0.16, 0.2, 0.24)); c = rnd.choice(COLS)
                cd.box(sx * 0.03, sx * 0.17, y, y + h, z, z + w - 0.005, c, skip='b')
                cd.box(sx * 0.171, sx * 0.172, y + h * 0.55, y + h * 0.8, z + 0.008, z + w - 0.013, 0xffffff if c != 0xffffff else 0xd23a2a, skip='b')
                z += w
    # Bag carousel on the bagging shelf: a post, three arms, white bags.
    bg.box(-0.02, 0.02, 0.82, 1.42, -0.02, 0.02, 0x9ea2a6, skip='b')
    for a in range(3):
        ca_, sa = cos(a * 2 * pi / 3), sin(a * 2 * pi / 3)
        bg.box(min(0, ca_ * 0.25) - 0.01, max(0, ca_ * 0.25) + 0.01, 1.38, 1.4, min(0, sa * 0.25) - 0.01, max(0, sa * 0.25) + 0.01, 0x9ea2a6)
        bx, bz = ca_ * 0.2, sa * 0.2
        bg.box(bx - 0.13, bx + 0.13, 0.98, 1.36, bz - 0.09, bz + 0.09, 0xf4f4f2, skip='t')
        bg.box(bx - 0.04, bx + 0.04, 1.2, 1.28, bz + 0.09, bz + 0.092, 0xcc2229, skip='b')
    return dict(pk_rack=rk, pk_rugbin=rb, pk_cart=ca, pk_reg=rg, pk_candy=cd, pk_bags=bg)


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


def stock_bake(fx, runs, coll, samples):
    """The floor's light: R with the fixtures, G without. Returns the stats."""
    import numpy as np, time
    sc = bpy.context.scene
    dev = cycles_gpu(sc)
    sc.cycles.samples = samples; sc.cycles.use_denoising = False
    w = bpy.data.worlds.new('stockworld'); sc.world = w
    w.use_nodes = True
    try: w.node_tree.nodes['Background'].inputs[1].default_value = 0.0
    except Exception: pass
    i0, i1, d0, Z = 0.3, SW - 0.3, -SD + 0.3, SBZ
    fl, room, blk, li, ce = Mesh(), Mesh(), Mesh(), Mesh(), Mesh()
    ce.face([(i0, SCH - 0.01, -0.3), (i1, SCH - 0.01, -0.3), (i1, SCH - 0.01, d0), (i0, SCH - 0.01, d0)], 0xffffff, 0, (0, -1, 0))
    fl.face([(i0, 0, d0), (i1, 0, d0), (i1, 0, -0.3), (i0, 0, -0.3)], 0xffffff, 0, (0, 1, 0))
    fl.face([(i0, 0, -0.3), (SEW - 0.3, 0, -0.3), (SEW - 0.3, 0, Z - 0.12), (i0, 0, Z - 0.12)], 0xffffff, 0, (0, 1, 0))
    room.box(i0, i1, 0, SCH, d0, Z - 0.12, 0xffffff, skip='')
    for f in room.f: pass
    # Turn the room box inside out (normals inward): rebuild with reversed winding.
    room.f = [list(reversed(f)) for f in room.f]
    room.box(i0, 60, 3.3, SCH, -9.0, -0.3, 0xffffff)
    for cx, cz in PK_COLS: room.box(cx - 0.15, cx + 0.15, 0, SCH, cz - 0.15, cz + 0.15, 0xffffff, skip='tb')
    for lx in S_LANES:
        room.box(lx, lx + 0.82, 0, 0.93, -7.22, -3.0, 0xffffff, skip='b'); room.box(lx, lx + 0.8, 0, 1.12, -3.0, -2.3, 0xffffff, skip='b')
        room.box(lx + 0.8, lx + 1.5, 0, 0.82, -3.6, -2.3, 0xffffff, skip='b')
    room.box(1.0, 7.0, 0, 1.1, -6.45, -5.55, 0xffffff, skip='b'); room.box(6.2, 7.0, 0, 1.05, -9.0, -6.4, 0xffffff, skip='b')
    SIZE = {'pk_gond': (1.2, 1.83, GL), 'pk_gondp': (1.2, 2.13, GL), 'pk_low': (1.2, 1.1, GL), 'pk_end': (1.2, 1.83, 0.5),
            'pk_rround': (1.25, 1.35, 1.25), 'pk_rline': (1.6, 1.4, 0.65), 'pk_sofa': (2.1, 0.88, 0.92), 'pk_recl': (0.9, 1.05, 0.9),
            'pk_matt': (1.56, 0.64, 2.06), 'pk_dress': (1.54, 0.88, 0.54), 'pk_table': (1.5, 0.76, 1.6), 'pk_rugbin': (2.4, 1.6, 0.8),
            'pk_cart': (0.95, 1.0, 0.58), 'pk_candy': (0.36, 1.6, 1.6)}
    for k, x, z, r, d in fx:
        if k not in SIZE: continue
        sx, sy, sz = SIZE[k]
        if abs(sin(r)) > 0.7: sx, sz = sz, sx
        y0 = 0.12 if k in ('pk_rround', 'pk_rline') else (0.0 if k != 'pk_low' else 0.55)
        if k in ('pk_rround', 'pk_rline'): y0 = 0.45      # hanging clothes: open below
        blk.box(x - sx / 2, x + sx / 2, y0, sy, z - sz / 2, z + sz / 2, 0xffffff, skip='b' if y0 == 0 else '')
        if k in ('pk_rround', 'pk_rline'): blk.box(x - 0.05, x + 0.05, 0, y0, z - 0.05, z + 0.05, 0xffffff, skip='b')
    for k, x, z, r, d in fx:
        if k == 'pk_rack': blk.box(x - 1.2, x + 1.2, 0.05, 2.2, z - 3.6, z, 0xffffff, skip='')
    x = 2.4
    while x < SW - 1.5:
        z = -10.8
        while z > -SD + 1.5:
            if not (x < 60 and z > -9.5):
                li.face([(x - 0.3, SCH - 0.02, z - 0.6), (x + 0.3, SCH - 0.02, z - 0.6), (x + 0.3, SCH - 0.02, z + 0.6), (x - 0.3, SCH - 0.02, z + 0.6)], 0xffffff, 0, (0, -1, 0))
            z -= 2.4
        x += 3.6
    for k in range(19):
        for zz in (-2.4, -6.4):
            x = 2 + k * 3; li.face([(x - 0.36, 3.28, zz - 0.36), (x + 0.36, 3.28, zz - 0.36), (x + 0.36, 3.28, zz + 0.36), (x - 0.36, 3.28, zz + 0.36)], 0xffffff, 0, (0, -1, 0))
    for k in range(7):
        for zz in (-2.4, -6.4):
            x = 62 + k * 3; li.face([(x - 0.3, SCH - 0.02, zz - 0.6), (x + 0.3, SCH - 0.02, zz - 0.6), (x + 0.3, SCH - 0.02, zz + 0.6), (x - 0.3, SCH - 0.02, zz + 0.6)], 0xffffff, 0, (0, -1, 0))

    def mat(name, col, emit=0.0):
        m = bpy.data.materials.new(name); m.use_nodes = True
        b = next(x for x in m.node_tree.nodes if x.type == 'BSDF_PRINCIPLED')
        b.inputs['Base Color'].default_value = (col, col, col, 1); b.inputs['Roughness'].default_value = 0.9
        if emit:
            b.inputs['Emission Color'].default_value = (1, 1, 1, 1); b.inputs['Emission Strength'].default_value = emit
            # The troffers light only downward (a mesh light is two-sided): strength times (1 - backfacing).
            nt_ = m.node_tree; gm = nt_.nodes.new('ShaderNodeNewGeometry'); mm = nt_.nodes.new('ShaderNodeMath')
            mm.operation = 'MULTIPLY_ADD'; mm.inputs[1].default_value = -emit; mm.inputs[2].default_value = emit
            nt_.links.new(gm.outputs['Backfacing'], mm.inputs[0]); nt_.links.new(mm.outputs[0], b.inputs['Emission Strength'])
        return m
    obs = {}
    for name, m, mt in (('bk_floor', fl, mat('bkf', 0.62)), ('bk_room', room, mat('bkr', 0.78)), ('bk_blk', blk, mat('bkb', 0.55)), ('bk_li', li, mat('bkl', 0.8, 40.0)), ('bk_ceil', ce, mat('bkc', 0.8))):
        o = m.to_object(name, coll); o.data.materials.append(mt); obs[name] = o
    W_, H_ = int(SW * 20), int((SD + SBZ) * 20)
    for nm in ('bk_floor', 'bk_ceil'):
        me = obs[nm].data; uvl = me.uv_layers.new(name='LM')
        for lp in me.loops:
            co = me.vertices[lp.vertex_index].co
            uvl.data[lp.index].uv = (co.x / SW, (-co.y + SD) / (SD + SBZ))
    out = {'device': dev, 'px': [W_, H_], 'samples': samples}
    res = []
    for tag, hide in (('R', False), ('G', True), ('B', False)):
        tgt = obs['bk_ceil' if tag == 'B' else 'bk_floor']
        img = bpy.data.images.new('lm' + tag, W_, H_, alpha=False, float_buffer=True); img.colorspace_settings.name = 'Non-Color'
        nt = tgt.data.materials[0].node_tree
        nd = nt.nodes.new('ShaderNodeTexImage'); nd.image = img
        for x in nt.nodes: x.select = False
        nd.select = True; nt.nodes.active = nd
        obs['bk_blk'].hide_render = hide
        bpy.ops.object.select_all(action='DESELECT'); tgt.select_set(True); bpy.context.view_layer.objects.active = tgt
        try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
        except Exception: pass
        t0 = time.time()
        sc.render.bake.use_pass_direct = True; sc.render.bake.use_pass_indirect = True; sc.render.bake.use_pass_color = False
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=6, use_clear=True)
        out['bake_s_' + tag] = round(time.time() - t0, 1)
        a = np.empty(W_ * H_ * 4, dtype=np.float32); img.pixels.foreach_get(a)
        a = a.reshape(H_, W_, 4)[:, :, :3].mean(axis=2)
        r = 2 if tag == 'R' else 4
        if tag == 'B': out['B_raw_median'] = float(np.median(a[a > 1e-4]))
        acc = np.zeros_like(a); n = 0
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1): acc += np.roll(np.roll(a, dy, 0), dx, 1); n += 1
        res.append(acc / n)
        nt.nodes.remove(nd)
    R, G, C = res
    ref = float(np.median(G[G > 1e-4]))
    out['ref'] = ref
    refc = float(np.median(C[C > 1e-4])); out['refc'] = refc
    rgb = np.zeros((H_, W_, 4), dtype=np.float32)
    rgb[:, :, 0] = np.clip(R / ref * 0.5, 0, 1); rgb[:, :, 1] = np.clip(G / ref * 0.5, 0, 1); rgb[:, :, 2] = np.clip(C / refc * 0.5, 0, 1); rgb[:, :, 3] = 1
    out['B_p5_p50_p95'] = [round(float(np.percentile(rgb[:, :, 2], q)), 3) for q in (5, 50, 95)]
    out['R_p5_p50_p95'] = [round(float(np.percentile(rgb[:, :, 0], q)), 3) for q in (5, 50, 95)]
    im = bpy.data.images.new('pardons_lm', W_, H_, alpha=False); im.colorspace_settings.name = 'Non-Color'
    im.pixels.foreach_set(rgb.ravel())
    p = os.path.join(OUT, 'pardons_lm.webp'); im.filepath_raw = p; im.file_format = 'WEBP'; im.save(quality=90)
    out['lm_kB'] = round(os.path.getsize(p) / 1000)
    return out


def stock_main():
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True)
    fx, runs = stock_layout()
    kit = {}
    for k in ('pk_gond', 'pk_gondp', 'pk_low'): kit[k] = Mesh(); kit_gond(kit[k], k)
    kit['pk_end'] = Mesh(); kit_end(kit['pk_end'])
    kit['pk_rround'] = Mesh(); kit_rack(kit['pk_rround'], True)
    kit['pk_rline'] = Mesh(); kit_rack(kit['pk_rline'], False)
    kit.update(kit_furniture()); kit.update(kit_misc())
    obs, stats = {}, {}
    for i, (name, m) in enumerate(kit.items()):
        obs[name] = m.to_object(name, coll); stats[name] = len(m.f)
        obs[name].location = ((i % 6) * 4.0, -(i // 6) * 5.0 - 80, 0)
        vertex_ao(obs[name], rays=24, reach=0.8, big=0.86)
        try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
        except Exception: pass
    for o in obs.values(): o.location = (0, 0, 0)
    out = {'faces': stats, 'fixtures': len(fx), 'runs': len(runs)}
    with open(os.path.join(OUT, 'pardons_stock.json'), 'w') as f:
        json.dump({'fx': [[k, round(x, 3), round(z, 3), round(r, 4), d] for k, x, z, r, d in fx], 'runs': runs,
                   'depts': [d[0] for d in PK_DEPTS]}, f, separators=(',', ':'))
    out['json_kB'] = round(os.path.getsize(os.path.join(OUT, 'pardons_stock.json')) / 1000)
    if '--no-export' not in FLAGS:
        out['kit_kB'] = export(list(obs.values()), os.path.join(OUT, 'pardons_kit.glb'))
    for i, o in enumerate(obs.values()): o.location = ((i % 6) * 4.0, -(i // 6) * 5.0 - 80, 0)
    if '--no-bake' not in FLAGS:
        out.update(stock_bake(fx, runs, coll, int(os.environ.get('PK_SAMPLES', '128'))))
    print('BLD_STATS ' + json.dumps(out))



# ── The riverfront (`-- --river`): Lackwool Mill, the Exact Change Footbridge, The Holding Pattern's kit ───────────
# After the Lockwood mill and the Two Cent Bridge (tools/briefs/tepid-reference.md; the bridge from a CC BY-SA photograph
# kept in scratch/river/ref, never in the repo). Writes, in public/models:
#   riverfront.glb      <piece>_0 / _1 / _2 for: lw_sec (a 31.5 m, ten-bay section of the five-storey main wing, open at
#                       both ends, placed six times), lw_end (its gable end wall, placed at both ends), lw_ell (the four-storey wing toward Water St), lw_boiler, lw_tower
#                       (the stair tower with its belfry and pyramid roof), lw_stack (the round chimney), fb (the
#                       footbridge's lattice towers on their piers, main cables, stays, hangers and lattice stiffening
#                       trusses; the plank deck stays ground.ts's); hp_lamp and hp_dump (The Holding Pattern's lamp standard
#                       and dumpster, one level).
#   riverfront_far.glb  the _2 levels and the kit: all the phone preset fetches.
#   riverfront_o.webp   Cycles occlusion of the _0 levels (their only UV), as mainst_o.webp.
# Frames: mill pieces as the Main St designs (x along the front, y up, z out of the front, the wall plane z = 0); fb in
# the world's own axes from the deck's west end at deck level. src/world/riverfrontAssets.ts places them. The colour and
# alpha contract is mainst.glb's (alpha 1 brick, 0 other, between: windows that light at night).

LW = dict(brick=0x8a4433, stone=0x9a958a, trim=0x3b3730, D=25.0, fh=4.2, b0=0.9, pitch=3.15, bays=10)


class Piece(Build):
    def __init__(self, lod, seed):
        self.lod, self.S = lod, dict(brick=LW['brick'], stone=LW['stone'], trim=LW['trim'])
        self.m, self.g, self.r, self.holes = Mesh(), Mesh(), random.Random(seed), []


def merge(dst, src, fn):
    for f, c in zip(src.f, src.c):
        i = len(dst.v)
        dst.v.extend(fn(*src.v[k]) for k in f)
        dst.f.append(list(range(i, i + len(f)))); dst.c.append(c)


def mill_face(lod, seed, width, floors, fh, b0, pitch, shape='seg', panes='12/12', ww=1.45, top_extra=1.1, door=False, cornice=True):
    """A mill wall at z = 0 over x 0..width: granite base, floors of tall windows between brick piers, a corbelled cornice."""
    p = Piece(lod, seed); m, brick = p.m, LW['brick']
    H = b0 + floors * fh
    n = max(1, int(round(width / pitch))); step = width / n
    for f in range(floors):
        yb = b0 + f * fh + 0.85
        wh = fh - 1.45 if f < floors - 1 else fh - 1.75
        for i in range(n):
            if door and f == 0 and i == n // 2: continue
            cx = step * (i + 0.5)
            p.window(cx - ww / 2, cx + ww / 2, yb, yb + wh, dict(shape=shape, panes=panes))
    p.wall_with_holes(0, width, b0, H + top_extra, brick)
    if b0 > 0.01: m.box(0, width, 0, b0, 0, 0.12, LW['stone'], skip='b')
    if lod < 2 and n > 1:
        for i in range(1, n):
            x = step * i
            m.box(x - 0.3, x + 0.3, b0, H, 0, 0.1, shade(brick, 0.94), 1.0, skip='b')
    if lod < 2:
        for f in range(1, floors):                       # a brick string course at each floor line
            y = b0 + f * fh + 0.62
            m.box(0, width, y, y + 0.16, 0, 0.05, shade(brick, 0.9), 1.0)
    if cornice:
        for k in range(3):
            m.box(0, width, H + 0.25 + k * 0.17, H + 0.42 + k * 0.17, 0, 0.06 * (k + 1) + 0.06, shade(brick, 0.97), 1.0)
        if lod == 0:
            for i in range(int(width / 0.42)):
                x = 0.12 + i * 0.42
                m.box(x, x + 0.2, H + 0.02, H + 0.25, 0, 0.1, brick, 1.0, skip='k')
        m.box(0, width, H + top_extra - 0.14, H + top_extra, 0, 0.4, LW['trim'])
    if door:
        cx = step * (n // 2 + 0.5)
        m.box(cx - 1.75, cx + 1.75, 0, 4.4, 0, 0.32, LW['stone'], skip='b')
        m.quad_z(cx - 1.15, cx + 1.15, 0, 3.4, 0.33, 0x2e2a24, 0.0)
        m.quad_z(cx - 1.0, cx + 1.0, 2.6, 3.3, 0.34, GLASS_DARK, 0.9)
        m.box(cx - 1.3, cx + 1.3, 3.65, 4.2, 0.32, 0.38, shade(LW['stone'], 1.1))     # name plaque, blank
    return m, H


def mill_block(lod, seed, L, D, floors, ends=(False, False), rise=1.6, shape='seg', panes='12/12', pitch=None, fh=None):
    """A mill range L long and D deep: windowed front and back, gabled ends where asked, a low two-slope roof."""
    fh, pitch, b0, te = fh or LW['fh'], pitch or LW['pitch'], LW['b0'], 1.1
    m = Mesh()
    a, H = mill_face(lod, seed, L, floors, fh, b0, pitch, shape, panes); merge(m, a, lambda x, y, z: (x, y, z))
    a, _ = mill_face(lod, seed + 1, L, floors, fh, b0, pitch, shape, panes); merge(m, a, lambda x, y, z: (L - x, y, -D - z))
    Ht = H + te
    for e, closed in enumerate(ends):
        if not closed: continue
        a, _ = mill_face(lod, seed + 2 + e, D, floors, fh, b0, pitch, shape, panes)
        merge(m, a, (lambda x, y, z: (-z, y, -D + x)) if e == 0 else (lambda x, y, z: (L + z, y, -x)))
        xg, nx = (0, -1) if e == 0 else (L, 1)
        m.face([(xg, Ht, 0), (xg, Ht, -D), (xg, Ht + rise, -D / 2)], LW['brick'], 1.0, (nx, 0, 0))
    o = 0.5; x0 = -o if ends[0] else 0; x1 = L + o if ends[1] else L
    ROOF = 0x46494c
    m.face([(x0, Ht, o), (x1, Ht, o), (x1, Ht + rise, -D / 2), (x0, Ht + rise, -D / 2)], ROOF, 0.0, (0, 1, 0.1))
    m.face([(x0, Ht, -D - o), (x0, Ht + rise, -D / 2), (x1, Ht + rise, -D / 2), (x1, Ht, -D - o)], ROOF, 0.0, (0, 1, -0.1))
    if lod < 2:
        for zz0, zz1 in ((0, o), (-D - o, -D)):
            m.face([(x0, Ht - 0.03, zz0), (x1, Ht - 0.03, zz0), (x1, Ht - 0.03, zz1), (x0, Ht - 0.03, zz1)], 0x2f3133, 0.0, (0, -1, 0))
        nv = max(1, int(L / 16))
        for k in range(nv):                               # roof ventilators along the ridge
            xc = (k + 0.5) * L / nv
            m.box(xc - 0.5, xc + 0.5, Ht + rise - 0.2, Ht + rise + 0.9, -D / 2 - 0.5, -D / 2 + 0.5, 0x6d7072, 0.0, skip='b')
            m.box(xc - 0.75, xc + 0.75, Ht + rise + 0.9, Ht + rise + 1.05, -D / 2 - 0.75, -D / 2 + 0.75, 0x55585a, 0.0)
    return m


def mill_end(lod):
    """The gable end of the main wing, in its own front's frame (x across the wing's depth): wall, gable, verge."""
    D, m, ROOF = LW['D'], Mesh(), 0x46494c
    a, H = mill_face(lod, 21, D, 5, LW['fh'], LW['b0'], LW['pitch']); merge(m, a, lambda x, y, z: (x, y, z))
    Ht, rise = H + 1.1, 1.6
    m.face([(0, Ht, 0), (D, Ht, 0), (D / 2, Ht + rise, 0)], LW['brick'], 1.0, (0, 0, 1))
    m.face([(-0.5, Ht, 0.5), (D / 2, Ht + rise, 0.5), (D / 2, Ht + rise, 0), (-0.5, Ht, 0)], ROOF, 0.0, (-0.1, 1, 0))
    m.face([(D / 2, Ht + rise, 0.5), (D + 0.5, Ht, 0.5), (D + 0.5, Ht, 0), (D / 2, Ht + rise, 0)], ROOF, 0.0, (0.1, 1, 0))
    return m


def ring(m, n, r0, r1, y0, y1, hex_, a=0.0, cx=0.0, cz=0.0):
    for i in range(n):
        t0, t1 = 2 * pi * i / n, 2 * pi * (i + 1) / n
        tm = (t0 + t1) / 2
        m.face([(cx + r0 * cos(t0), y0, cz + r0 * sin(t0)), (cx + r0 * cos(t1), y0, cz + r0 * sin(t1)),
                (cx + r1 * cos(t1), y1, cz + r1 * sin(t1)), (cx + r1 * cos(t0), y1, cz + r1 * sin(t0))], hex_, a,
               (cos(tm), (r0 - r1) / (y1 - y0 if abs(y1 - y0) > 0.01 else 0.01), sin(tm)))


def ball(m, cx, cy, cz, r, hex_, n=8):
    rs = [0.001, 0.7, 1, 0.7, 0.001]
    for k in range(4):
        ring(m, n, r * rs[k], r * rs[k + 1], cy - r + 2 * r * k / 4, cy - r + 2 * r * (k + 1) / 4, hex_, 0.0, cx, cz)


def tower(lod):
    """Lackwool's stair tower: seven floors of single windows, a belfry with round arches, a slate pyramid and a finial."""
    m, W, Dp, floors, fh, b0 = Mesh(), 8.4, 6.6, 7, LW['fh'], LW['b0']
    faces = [(W, lambda x, y, z: (x, y, z), True), (Dp, lambda x, y, z: (-z, y, -Dp + x), False),
             (Dp, lambda x, y, z: (W + z, y, -x), False), (W, lambda x, y, z: (W - x, y, -Dp - z), False)]
    Hb = 0
    for k, (wd, fn, door) in enumerate(faces):
        a, H = mill_face(lod, 40 + k, wd, floors, fh, b0, wd, 'seg', '6/6', ww=1.3, door=door); merge(m, a, fn)
        y0 = H + 1.1
        a, Hs = mill_face(lod, 50 + k, wd, 1, 4.8, 0.0, wd, 'round', '1/1', ww=2.7)
        merge(m, a, (lambda f, yo: (lambda x, y, z: f(x, y + yo, z)))(fn, y0))
        Hb = y0 + Hs + 1.1
    SL, o, top = 0x4f545a, 0.45, Hb + 6.5
    c = [(-o, Hb, o), (W + o, Hb, o), (W + o, Hb, -Dp - o), (-o, Hb, -Dp - o)]
    ap = (W / 2, top, -Dp / 2)
    for i in range(4):
        p0, p1 = c[i], c[(i + 1) % 4]
        m.face([p0, p1, ap], SL, 0.0, ((p0[0] + p1[0]) / 2 - ap[0], 0.6, (p0[2] + p1[2]) / 2 - ap[2]))
    m.face(c, 0x2a2b2c, 0.0, (0, -1, 0))
    m.box(W / 2 - 0.05, W / 2 + 0.05, top, top + 2.6, -Dp / 2 - 0.05, -Dp / 2 + 0.05, 0x2a2d30)
    if lod < 2: ball(m, W / 2, top + 0.2, -Dp / 2, 0.35, 0x2a2d30, 6)
    return m


def stack(lod):
    """The round chimney: granite plinth, square brick pedestal, a tapering shaft, a corbelled cap blackened at the top."""
    m, n, br = Mesh(), {0: 20, 1: 12, 2: 7}[lod], LW['brick']
    m.box(-2.7, 2.7, 0, 1.2, -2.7, 2.7, LW['stone'], skip='b')
    m.box(-2.45, 2.45, 1.2, 8.0, -2.45, 2.45, br, 1.0, skip='bt')
    m.box(-2.6, 2.6, 8.0, 8.45, -2.6, 2.6, LW['stone'], skip='b')
    ring(m, n, 2.15, 1.35, 8.45, 44.0, br, 1.0)
    ring(m, n, 1.35, 1.62, 44.0, 44.7, shade(br, 0.9), 1.0)
    ring(m, n, 1.62, 1.62, 44.7, 45.7, shade(br, 0.55), 0.0)
    ring(m, n, 1.62, 1.48, 45.7, 46.1, 0x2a2624, 0.0)
    ring(m, n, 1.2, 1.2, 46.1, 45.2, 0x111111, 0.0)
    if lod < 2:
        for y in (20.0, 32.0):                             # iron bands
            r = 2.15 - (2.15 - 1.35) * (y - 8.45) / 35.55
            ring(m, n, r + 0.04, r + 0.04, y, y + 0.25, 0x2a2b2c, 0.0)
    return m


def bar(m, p0, p1, w, hex_, a=0.0, flat=None):
    """A square bar between two points (flat=(nx,ny,nz): a strip of width w facing that way, two faces)."""
    p0, p1 = Vector(p0), Vector(p1); d = p1 - p0
    if d.length < 1e-6: return
    d.normalize()
    if flat:
        nrm = Vector(flat).normalized(); u = d.cross(nrm).normalized() * (w / 2)
        q = [tuple(p0 + u), tuple(p1 + u), tuple(p1 - u), tuple(p0 - u)]
        m.face(q, hex_, a, tuple(nrm)); m.face(q, hex_, a, tuple(-nrm))
        return
    u = d.cross(Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))).normalized() * (w / 2)
    v = d.cross(u).normalized() * (w / 2)
    cs = [u + v, -u + v, -u - v, u - v]
    for i in range(4):
        c0, c1 = cs[i], cs[(i + 1) % 4]
        m.face([tuple(p0 + c0), tuple(p1 + c0), tuple(p1 + c1), tuple(p0 + c1)], hex_, a, tuple(c0 + c1))


FB_IRON, FB_PIER, FB_GOLD = 0x23272b, 0x8e8a80, 0xc9a24a
FB_T, FB_TOP, FB_Z, FB_LEN = (7.0, 119.0), 9.5, 1.75, 126.0


def lattice_col(m, x, z, s, y0, y1, lod):
    h = s / 2
    if lod == 2: m.box(x - h, x + h, y0, y1, z - h, z + h, FB_IRON); return
    cs = [(x - h, z - h), (x + h, z - h), (x + h, z + h), (x - h, z + h)]
    for cx, cz in cs: m.box(cx - 0.045, cx + 0.045, y0, y1, cz - 0.045, cz + 0.045, FB_IRON)
    pitch = s if lod == 0 else 2 * s
    k = int((y1 - y0) / pitch)
    for i in range(4):
        (ax, az), (bx, bz) = cs[i], cs[(i + 1) % 4]
        nrm = ((ax + bx) / 2 - x, 0, (az + bz) / 2 - z)
        for j in range(k):
            ya, yb = y0 + j * pitch, y0 + (j + 1) * pitch
            bar(m, (ax, ya, az), (bx, yb, bz), 0.035, FB_IRON, flat=nrm)
            if lod == 0: bar(m, (bx, ya, bz), (ax, yb, az), 0.035, FB_IRON, flat=nrm)


def lattice_girder(m, x, z0, z1, y0, y1, lod):
    """A lattice strut in the plane x = const between z0 and z1, from y0 to y1."""
    w = 0.09
    m.box(x - w, x + w, y0, y0 + 0.1, z0, z1, FB_IRON); m.box(x - w, x + w, y1 - 0.1, y1, z0, z1, FB_IRON)
    if lod == 2: return
    n = max(1, int((z1 - z0) / (y1 - y0)))
    for j in range(n):
        za, zb = z0 + (z1 - z0) * j / n, z0 + (z1 - z0) * (j + 1) / n
        for xx in (x - w, x + w):
            bar(m, (xx, y0 + 0.1, za), (xx, y1 - 0.1, zb), 0.04, FB_IRON, flat=(1, 0, 0))
            bar(m, (xx, y0 + 0.1, zb), (xx, y1 - 0.1, za), 0.04, FB_IRON, flat=(1, 0, 0))


def fb_build(lod):
    """The Exact Change Footbridge, after the Two Cent Bridge: lattice towers on stone piers, cables, lattice railings."""
    m = Mesh(); Z = FB_Z

    def cab(u): return FB_TOP - 0.1 - (FB_TOP - 1.7) * 4 * u * (1 - u)
    for T in FB_T:
        m.box(T - 1.35, T + 1.35, -11, -1.55, -2.9, 2.9, FB_PIER, 0.0, skip='b')                       # the pier
        m.box(T - 1.5, T + 1.5, -1.55, -1.3, -3.05, 3.05, shade(FB_PIER, 1.08), 0.0)                 # its cap
        for sg in (-1, 1):
            lattice_col(m, T, sg * Z, 0.5, -1.3, FB_TOP, lod)
            m.box(T - 0.32, T + 0.32, FB_TOP, FB_TOP + 0.12, sg * Z - 0.32, sg * Z + 0.32, FB_IRON)
            if lod < 2: ball(m, T, FB_TOP + 0.42, sg * Z, 0.26, FB_GOLD)
            else: m.box(T - 0.2, T + 0.2, FB_TOP + 0.12, FB_TOP + 0.6, sg * Z - 0.2, sg * Z + 0.2, FB_GOLD)
        lattice_girder(m, T, -Z + 0.25, Z - 0.25, FB_TOP - 1.0, FB_TOP - 0.1, lod)                     # top strut
        lattice_girder(m, T, -Z + 0.25, Z - 0.25, 3.3, 3.9, lod)                                     # lower strut
        if lod < 2:
            for za, zb in ((-Z + 0.25, Z - 0.25), (Z - 0.25, -Z + 0.25)):
                bar(m, (T, FB_TOP - 1.0, za), (T, 3.9, zb), 0.16, FB_IRON, flat=(1, 0, 0))            # the X
            m.box(T - 0.12, T + 0.12, -0.75, -0.3, -Z, Z, FB_IRON)                                   # deck beam
    # Main cables over the towers, back-stays to the anchors, inclined stays and hangers.
    seg = {0: 36, 1: 18, 2: 10}[lod]; cw = 0.09 if lod < 2 else 0.14
    T0, T1 = FB_T
    for sg in (-1, 1):
        z = sg * Z
        bar(m, (-9, -0.4, z), (T0, FB_TOP - 0.1, z), cw, FB_IRON)
        bar(m, (T1, FB_TOP - 0.1, z), (FB_LEN + 9, -0.4, z), cw, FB_IRON)
        for i in range(seg):
            u0, u1 = i / seg, (i + 1) / seg
            bar(m, (T0 + (T1 - T0) * u0, cab(u0), z), (T0 + (T1 - T0) * u1, cab(u1), z), cw, FB_IRON)
        if lod == 2: continue
        x = T0 + 3.5
        while x < T1 - 1:
            u = (x - T0) / (T1 - T0)
            bar(m, (x, cab(u), z), (x, -0.15, sg * 1.48), 0.03, FB_IRON)
            x += 3.5
        for T, s in ((T0, 1), (T1, -1)):
            for dx in (11.0, 19.0, 27.0):
                bar(m, (T, FB_TOP - 0.4, z), (T + s * dx, 1.3, sg * 1.48), 0.045, FB_IRON)
    # The lattice stiffening trusses that make the railings, and floor beams under the planks.
    for sg in (-1, 1):
        z = sg * 1.48
        m.box(0, FB_LEN, -0.32, -0.14, z - 0.07, z + 0.07, FB_IRON)
        m.box(0, FB_LEN, 1.24, 1.4, z - 0.07, z + 0.07, FB_IRON)
        if lod == 2: continue
        x = 0.0
        while x <= FB_LEN + 0.01:
            m.box(x - 0.06, x + 0.06, -0.14, 1.24, z - 0.06, z + 0.06, FB_IRON, skip='tb')
            if sg < 0: m.box(x - 0.1, x + 0.1, -0.62, -0.32, -1.5, 1.5, FB_IRON)
            x += 3.5
        p = 0.7 if lod == 0 else 1.4
        x = 0.0
        while x < FB_LEN - 1.38:
            bar(m, (x, -0.14, z), (x + 1.38, 1.24, z), 0.05, FB_IRON, flat=(0, 0, 1))
            bar(m, (x + 1.38, -0.14, z), (x, 1.24, z), 0.05, FB_IRON, flat=(0, 0, 1))
            x += p
    # Anchor blocks for the back-stays.
    for ax in (-9, FB_LEN + 9):
        m.box(ax - 1.0, ax + 1.0, -3, -0.2, -2.4, 2.4, FB_PIER, 0.0, skip='b')
    return m


def hp_lamp():
    """The Holding Pattern's lamp standard: concrete base, tapered steel pole, cross-arm, two shoebox heads."""
    m, P = Mesh(), 0x2b2e2c
    m.box(-0.32, 0.32, 0, 0.7, -0.32, 0.32, 0xa9a69c, skip='b')
    ring(m, 8, 0.12, 0.065, 0.7, 9.0, P)
    m.box(-1.0, 1.0, 8.82, 8.92, -0.05, 0.05, P)
    for sx in (-1, 1):
        x = sx * 1.0
        m.box(x - 0.34, x + 0.34, 8.7, 8.9, -0.25, 0.25, P, skip='b')
        m.face([(x - 0.3, 8.69, -0.21), (x + 0.3, 8.69, -0.21), (x + 0.3, 8.69, 0.21), (x - 0.3, 8.69, 0.21)], 0xfff2d8, 0.97, (0, -1, 0))
    return m


def hp_dump():
    """A steel dumpster: body, two lids, lifting pockets, skids, a stencilled panel."""
    m, G, K = Mesh(), 0x2f4a3a, 0x1e2a24
    m.box(-0.95, 0.95, 0.14, 1.12, -0.5, 0.62, G)
    for x0, x1 in ((-0.94, -0.01), (0.01, 0.94)):
        m.box(x0, x1, 1.12, 1.19, -0.56, 0.68, 0x1b1d1e)
    for sx in (-1, 1):
        m.box(min(sx * 0.95, sx * 1.07), max(sx * 0.95, sx * 1.07), 0.75, 0.9, -0.3, 0.45, K)
        m.box(sx * 0.7 - 0.08, sx * 0.7 + 0.08, 0, 0.14, -0.45, 0.6, K)
    m.box(-0.6, 0.6, 0.55, 0.85, 0.62, 0.63, 0xd9d6c8)
    return m


def river_main():
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True); os.makedirs(SHOTS, exist_ok=True)
    L, D = LW['pitch'] * LW['bays'], LW['D']
    pieces = {
        'lw_sec': lambda lod: mill_block(lod, 12, L, D, 5),
        'lw_end': mill_end,
        'lw_ell': lambda lod: mill_block(lod, 14, 6 * LW['pitch'], 20.0, 4, ends=(False, True)),
        'lw_boiler': lambda lod: mill_block(lod, 15, 5 * LW['pitch'], 11.0, 1, ends=(True, True), shape='round', panes='6/6', fh=7.0),
        'lw_tower': tower, 'lw_stack': stack, 'fb': fb_build,
    }
    near, all_obs, far, stats, ground = [], [], [], {}, {}
    for name, fn in pieces.items():
        for lod in (0, 1, 2):
            mesh = fn(lod)
            ob = mesh.to_object(f'{name}_{lod}', coll); all_obs.append(ob); stats[ob.name] = len(mesh.f)
            if lod == 0: near.append(ob)
            else: vertex_ao(ob, ground=name != 'fb')
            if lod == 2: far.append(ob)
        ground[f'{name}_0'] = None if name == 'fb' else 0.0
        try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
        except Exception: pass
    for name, fn in (('hp_lamp', hp_lamp), ('hp_dump', hp_dump)):
        mesh = fn(); ob = mesh.to_object(name, coll); vertex_ao(ob); all_obs.append(ob); far.append(ob); stats[name] = len(mesh.f)
    out = {'faces': stats}
    if '--no-bake' not in FLAGS: out['ao_kB'] = bake_ao(near, 'riverfront_o', ground, gpu=True)
    else:
        for ob in near: vertex_ao(ob, ground=not ob.name.startswith('fb'))
    if '--no-export' not in FLAGS:
        out['river_kB'] = export(all_obs, os.path.join(OUT, 'riverfront.glb'))
        out['far_kB'] = export(far, os.path.join(OUT, 'riverfront_far.glb'))
    x = 0
    for name in list(pieces) + ['hp_lamp', 'hp_dump']:
        for lod in (0, 1, 2):
            o = bpy.data.objects.get(f'{name}_{lod}') or (bpy.data.objects.get(name) if lod == 0 else None)
            if o: o.location = (x, 60 * lod, 0)
        x += 40 if name != 'fb' else 140
    print('RIV_STATS ' + json.dumps(out))
    with open(os.path.join(SHOTS, 'riverfront_meta.json'), 'w') as fh: json.dump(out, fh, indent=1)


if '--river' in FLAGS: river_main()
elif '--stock' in FLAGS: stock_main()
elif '--store' in FLAGS: store_main()
else: main()
# Close the window once the files are written: wm.quit_blender can stop on an unsaved-changes prompt.
if '--stay' not in FLAGS:
    sys.stdout.flush()
    os._exit(0)
