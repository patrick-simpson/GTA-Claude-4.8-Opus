# SpeedScan headquarters (tools/briefs/speedscan-hq.md): the tower in the Ledger District, modelled in Blender by script.
#
#   blender --factory-startup --python tools/blender/speedscan.py --python-expr "import bpy; bpy.ops.wm.quit_blender()"
#   (with its window showing, never --background: the owner watches the screen)
#
# Writes, in public/models (BLD_OUT overrides the folder for a trial):
#   speedscan.glb      hq_0 (near: fins, spandrel ledges, corner piers, lobby, canopy, plaza furniture), hq_1 (street: the
#                      same outline with fins every other bay and no plaza furniture), hq_2 (far: boxes, crown and mast);
#                      logo_0 (the owner's logo as geometry: extruded Orbitron letters and the speed lines, on its light
#                      panel) and logo_2 (the same, flat and coarse).
#   speedscan_far.glb  hq_2 and logo_2 alone: the whole file the phone preset fetches.
#
# The logo comes from the owner's own artwork, tools/blender/speedscan/SpeedScan Logo Light.svg (polygons and Orbitron
# text, fonts beside it under the SIL Open Font License, OFL.txt). Its gradients are carried as vertex colours.
#
# Frame: the game's, y up, x east, z south, origin at the centre of the merged lot (block 44, x -16.5..70.5,
# z -6.5..70.5 in the world: centre 27, 32) at street level. The plaza is the south side, facing Bollard St and the spawn.
# The logo is authored 1 unit wide (x -0.5..0.5, centred on its panel), facing +z; src/world/speedscanHQ.ts places and
# scales it (the spots are in LOGO_SPOTS there, in step with the faces built here).
#
# Contract with src/world/speedscanHQ.ts: albedo is the vertex colour (linear); its ALPHA says what the face is:
#   0.0   stone, metal, paving: plain;
#   0.5   office glass: the game draws mullions, spandrels and lit offices on it from world position (3 m bays, 3.8 m floors);
#   0.85  lobby glass: lit warm all night;
#   1.0   lights: glow in their own colour at night (crown strips, aviation lights, the logo).
# Nothing is smoothed.

import bpy, sys, os, json, math, random
import xml.etree.ElementTree as ET

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
HERE = os.path.join(ROOT, 'tools', 'blender', 'speedscan')
OUT = os.environ.get('BLD_OUT') or os.path.join(ROOT, 'public', 'models')
SVG = os.path.join(HERE, 'SpeedScan Logo Light.svg')


def srgb(hex_):
    return [((hex_ >> s) & 255) / 255 for s in (16, 8, 0)]


def lin3(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def lin(hex_):
    return lin3(srgb(hex_))


def B(x, y, z):
    return (x, -z, y)


class Mesh:
    """Faces with their own corners; a colour per corner and an alpha per face."""

    def __init__(self):
        self.v, self.f, self.c = [], [], []

    def face(self, pts, col, a=0.0, n=None):
        cols = col if isinstance(col, list) else [lin(col) if isinstance(col, int) else col] * len(pts)
        if n is not None and len(pts) >= 3:
            # Newell's normal: right for concave outlines too (the letters' fills), where three corners can lie.
            cr = [0.0, 0.0, 0.0]
            for k in range(len(pts)):
                a_, b_ = pts[k], pts[(k + 1) % len(pts)]
                cr[0] += (a_[1] - b_[1]) * (a_[2] + b_[2]); cr[1] += (a_[2] - b_[2]) * (a_[0] + b_[0]); cr[2] += (a_[0] - b_[0]) * (a_[1] + b_[1])
            if cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0: pts = pts[::-1]; cols = cols[::-1]
        i = len(self.v)
        self.v.extend(pts)
        self.f.append(list(range(i, i + len(pts))))
        self.c.append([tuple(c) + (a,) for c in cols])

    def box(self, x0, x1, y0, y1, z0, z1, col, a=0.0, skip=''):
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
        for k, (p, nn) in F.items():
            if k not in skip: self.face(p, col, a, nn)

    def cyl(self, cx, cz, r, y0, y1, col, a=0.0, n=8):
        for i in range(n):
            a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
            p = [(cx + r * math.cos(a0), y0, cz + r * math.sin(a0)), (cx + r * math.cos(a1), y0, cz + r * math.sin(a1)),
                 (cx + r * math.cos(a1), y1, cz + r * math.sin(a1)), (cx + r * math.cos(a0), y1, cz + r * math.sin(a0))]
            am = (a0 + a1) / 2
            self.face(p, col, a, (math.cos(am), 0, math.sin(am)))

    def to_object(self, name, coll):
        me = bpy.data.meshes.new(name)
        me.from_pydata([B(*p) for p in self.v], [], self.f)
        me.update()
        att = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        flat = []
        for poly, cols in zip(me.polygons, self.c):
            for k in range(poly.loop_total): flat.extend(cols[k])
        att.data.foreach_set('color', flat)
        me.color_attributes.active_color = att
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        return ob


# ── The tower ────────────────────────────────────────────────────────────────

GLASS, STEEL, DARK, STONE, PAVE, GRAVEL = 0x3f5a70, 0xb8c1c8, 0x2b3239, 0xd8d2c6, 0xb9b2a6, 0x8d8a84
CYAN, LIME, RED, WATER, HEDGE, WARM = 0x22d3ee, 0x84cc16, 0xff2a1a, 0x1f4a5c, 0x3f6b35, 0x6e6a62
FLOOR, BAY = 3.8, 3.0
# Shafts: x0, x1, z0, z1, y0, y1. All centred on x = 0; the shafts on z = -15.
PODIUM = (-42, 42, -37, 10, 0, 20)
SHAFTS = [(-33, 33, -36, 6, 20, 190), (-29, 29, -33, 3, 190, 262), (-25, 25, -30, 0, 262, 306)]
BAND = (-26, 26, -31, 1, 306, 322)
LANTERN = [(-22, 22, -27, -3, 322, 336), (-16, 16, -22, -8, 336, 348)]
SPIRE_TOP, MAST_TOP = 366, 395


def shaft(m, s, lod):
    x0, x1, z0, z1, y0, y1 = s
    a = 0.5
    # Glass skin, one sheet a side (the game draws the mullions and the offices on it).
    m.box(x0, x1, y0, y1, z0, z1, GLASS, a, skip='tb')
    # Roof and parapet.
    m.face([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], GRAVEL, 0, (0, 1, 0))
    for (ax0, ax1, az0, az1) in ((x0, x1, z1 - 0.6, z1 + 0.4), (x0, x1, z0 - 0.4, z0 + 0.6), (x0 - 0.4, x0 + 0.6, z0, z1), (x1 - 0.6, x1 + 0.4, z0, z1)):
        m.box(ax0, ax1, y1 - 0.4, y1 + 1.4, az0, az1, STEEL, 0, skip='b')
    # Corner piers, all levels: they carry the silhouette.
    for cx in (x0, x1):
        for cz in (z0, z1):
            m.box(cx - 1.3, cx + 1.3, y0, y1 + 1.6, cz - 1.3, cz + 1.3, STEEL, 0, skip='b')
    if lod == 2: return
    # Fins: every bay near, every other bay from the street; 0.7 m deep, the real depth of the wall.
    step = BAY if lod == 0 else BAY * 2
    for side in range(4):
        horiz = side in (0, 2)
        lo, hi = (x0, x1) if horiz else (z0, z1)
        n = int((hi - lo) / step)
        pad = (hi - lo - n * step) / 2
        for k in range(1, n):
            t = lo + pad + k * step
            if horiz:
                zz = z1 if side == 2 else z0
                d = 0.7 if side == 2 else -0.7
                m.box(t - 0.16, t + 0.16, y0, y1, zz, zz + d, STEEL, 0, skip='b' + ('k' if side == 2 else 'f'))
            else:
                xx = x1 if side == 1 else x0
                d = 0.7 if side == 1 else -0.7
                m.box(xx, xx + d, y0, y1, t - 0.16, t + 0.16, STEEL, 0, skip='b' + ('l' if side == 1 else 'r'))
    # Spandrel ledges, a slim shelf at every floor (every third from the street).
    fstep = FLOOR if lod == 0 else FLOOR * 3
    y = y0 + fstep
    while y < y1 - 1:
        o = 0.32
        m.box(x0 - o, x1 + o, y - 0.25, y, z1, z1 + o, DARK, 0, skip='k')
        m.box(x0 - o, x1 + o, y - 0.25, y, z0 - o, z0, DARK, 0, skip='f')
        m.box(x1, x1 + o, y - 0.25, y, z0, z1, DARK, 0, skip='lfk')
        m.box(x0 - o, x0, y - 0.25, y, z0, z1, DARK, 0, skip='rfk')
        y += fstep


def podium(m, lod):
    x0, x1, z0, z1, y0, y1 = PODIUM
    m.box(x0, x1, y0, y1, z0, z1, STONE, 0, skip='b')
    # Tall strip windows on the stone, office glass.
    for side in range(4):
        horiz = side in (0, 2)
        lo, hi = (x0, x1) if horiz else (z0, z1)
        k = lo + 3
        while k < hi - 4:
            if not (side == 2 and -31 < k < 31):
                if horiz:
                    zz = (z1 + 0.02) if side == 2 else (z0 - 0.02)
                    m.face([(k, 5.5, zz), (k + 2, 5.5, zz), (k + 2, 18.5, zz), (k, 18.5, zz)], GLASS, 0.5, (0, 0, 1 if side == 2 else -1))
                else:
                    xx = (x1 + 0.02) if side == 1 else (x0 - 0.02)
                    m.face([(xx, 5.5, k), (xx, 5.5, k + 2), (xx, 18.5, k + 2), (xx, 18.5, k)], GLASS, 0.5, (1 if side == 1 else -1, 0, 0))
            k += 4
    # The lobby: a 14 m wall of glass facing the plaza, set back 1.5 m under the stone.
    m.box(-31, 31, 0.2, 15, z1 - 1.5, z1 + 0.05, WARM, 0.85, skip='kb')
    m.box(-31.6, 31.6, 15, 16.2, z1 - 1.6, z1 + 0.3, STEEL, 0, skip='k')
    if lod < 2:
        for k in range(-30, 31, 3 if lod == 0 else 6):
            m.box(k - 0.12, k + 0.12, 0.2, 15, z1 - 0.1, z1 + 0.3, DARK, 0, skip='kb')
    # Entrance: canopy on two columns, its tall fascia carries the logo (z 18.05, y 8.5, 16 m wide).
    m.box(-14, 14, 7.2, 9.8, 10, 18, DARK, 0)
    m.box(-14, 14, 7.0, 7.2, 10, 18, CYAN, 1.0, skip='t')
    for cx in (-12, 12): m.cyl(cx, 16.5, 0.45, 0.2, 7.2, STEEL, 0, n=10 if lod == 0 else 6)
    m.box(-5, 5, 0.2, 5.5, z1 - 1.4, z1 - 1.3, DARK, 0, skip='kb')
    # Aviation-style setback lights at the podium corners.
    for cx in (x0, x1): m.box(cx - 0.4, cx + 0.4, y1 + 0.3, y1 + 1.1, z0 + 0.2, z0 + 1, RED, 1.0, skip='b')


def plaza(m, lod):
    m.box(-42.3, 42.3, 0.0, 0.2, 10, 38.3, PAVE, 0, skip='bk')
    if lod > 0:
        m.box(13, 31, 0.2, 3.4, 32.6, 34.2, STONE, 0, skip='b')   # monument sign; logo on its south face (z 34.25, y 1.9, 16 wide)
        return
    # Paving joints: darker bands every 6 m so it reads as stone.
    for x in range(-42, 43, 6): m.box(x - 0.06, x + 0.06, 0.2, 0.205, 10, 38.3, 0x9c968b, 0, skip='bklrf')
    m.box(13, 31, 0.2, 3.4, 32.6, 34.2, STONE, 0, skip='b')
    m.box(13.4, 30.6, 0.2, 0.5, 34.2, 34.8, DARK, 0, skip='b')
    # Fountain: stone rim, dark water, three jets as thin pale columns.
    m.box(-32, -14, 0.2, 0.8, 18, 30, STONE, 0, skip='b')
    m.box(-31.4, -14.6, 0.8, 0.81, 18.6, 29.4, WATER, 0, skip='bklrf')
    for jx in (-27.5, -23, -18.5): m.cyl(jx, 24, 0.25, 0.8, 3.2, 0xe8f4f6, 0, n=6)
    # Planters with hedges along the street edges, benches between them.
    for x in range(-38, 39, 10):
        if -10 < x < 10 or 12 <= x <= 32: continue      # the entrance, and the monument sign
        m.box(x - 2.4, x + 2.4, 0.2, 0.9, 35.6, 37.6, STONE, 0, skip='b')
        m.box(x - 2.2, x + 2.2, 0.9, 1.6, 35.8, 37.4, HEDGE, 0, skip='b')
    for x in (-6, 6):
        m.box(x - 1.8, x + 1.8, 0.2, 0.65, 26, 26.7, 0x7b5a3a, 0, skip='b')
    # Bollards across the front of the plaza.
    for x in range(-40, 41, 4):
        if -12 < x < 12: m.cyl(x, 37.8, 0.18, 0.2, 1.1, DARK, 0, n=6)
    # Flagpoles beside the entrance.
    for x in (-18, 18):
        m.cyl(x, 30, 0.12, 0.2, 14, STEEL, 0, n=6)
        m.box(x + 0.1, x + 3.2, 11.6, 13.6, 29.98, 30.02, LIME, 0)


def crown(m, lod):
    x0, x1, z0, z1, y0, y1 = BAND
    m.box(x0, x1, y0, y1, z0, z1, DARK, 0)
    for y in (y0, y1 - 0.5):
        m.box(x0 - 0.3, x1 + 0.3, y, y + 0.5, z0 - 0.3, z1 + 0.3, CYAN, 1.0)
    for i, L in enumerate(LANTERN):
        lx0, lx1, lz0, lz1, ly0, ly1 = L
        m.box(lx0, lx1, ly0, ly1, lz0, lz1, GLASS, 0.5, skip='b')
        n = 8 if lod == 2 else 16
        for k in range(n + 1):
            t = lx0 + (lx1 - lx0) * k / n
            m.box(t - 0.25, t + 0.25, ly0, ly1 + 0.6, lz1, lz1 + 0.5, CYAN if k % 2 == 0 else STEEL, 1.0 if k % 2 == 0 else 0, skip='b')
            m.box(t - 0.25, t + 0.25, ly0, ly1 + 0.6, lz0 - 0.5, lz0, CYAN if k % 2 == 0 else STEEL, 1.0 if k % 2 == 0 else 0, skip='b')
        nz = 6 if lod == 2 else 10
        for k in range(nz + 1):
            t = lz0 + (lz1 - lz0) * k / nz
            m.box(lx1, lx1 + 0.5, ly0, ly1 + 0.6, t - 0.25, t + 0.25, CYAN if k % 2 == 0 else STEEL, 1.0 if k % 2 == 0 else 0, skip='b')
            m.box(lx0 - 0.5, lx0, ly0, ly1 + 0.6, t - 0.25, t + 0.25, CYAN if k % 2 == 0 else STEEL, 1.0 if k % 2 == 0 else 0, skip='b')
    # Spire: a four-sided glass pyramid on the last lantern, then the mast.
    lx0, lx1, lz0, lz1, ly0, ly1 = LANTERN[-1]
    ap = (0, SPIRE_TOP, -15)
    c = [(lx0, ly1, lz1), (lx1, ly1, lz1), (lx1, ly1, lz0), (lx0, ly1, lz0)]
    for k in range(4):
        p, q = c[k], c[(k + 1) % 4]
        mx, mz = (p[0] + q[0]) / 2, (p[2] + q[2]) / 2
        m.face([p, q, ap], GLASS, 0.5, (mx, 6, mz + 15))
    m.cyl(0, -15, 0.9, SPIRE_TOP - 4, MAST_TOP, STEEL, 0, n=8)
    m.box(-1.0, 1.0, MAST_TOP, MAST_TOP + 1.6, -16, -14, RED, 1.0)
    m.box(-0.8, 0.8, 352, 353.2, -15.8, -14.2, RED, 1.0)


def build(lod):
    m = Mesh()
    podium(m, lod)
    plaza(m, lod)
    for s in SHAFTS: shaft(m, s, lod)
    crown(m, lod)
    return m


# ── The logo, from the owner's SVG ───────────────────────────────────────────

PANEL = 0xF4F7FB
X0, X1, YC = 493.8, 1158.2, 319.3      # content x span (before the group's translate) and middle height, SVG units
S = 1 / (X1 - X0)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def logo(res, extrude):
    ns = '{http://www.w3.org/2000/svg}'
    root = ET.parse(SVG).getroot()
    stops = {}
    for gr in root.iter(ns + 'linearGradient'):
        st = [s.get('stop-color') for s in gr.iter(ns + 'stop')]
        stops[gr.get('id')] = [srgb(int(c[1:], 16)) for c in st]
    pan = srgb(PANEL)
    m = Mesh()
    nx = lambda x: (x - (X0 + X1) / 2) * S
    ny = lambda y: (YC - y) * S
    # Panel: light, as the artwork's background, with a thin back.
    m.box(-0.54, 0.54, -0.072, 0.072, -0.006, 0.0, PANEL, 1.0)
    fonts = {900: bpy.data.fonts.load(os.path.join(HERE, 'Orbitron-900.ttf'), check_existing=True),
             700: bpy.data.fonts.load(os.path.join(HERE, 'Orbitron-700.ttf'), check_existing=True)}
    g = root.find(ns + 'g')
    for el in g:
        tag = el.tag.replace(ns, '')
        fill = el.get('fill', '')
        gid = fill[5:-1] if fill.startswith('url(') else None
        if tag == 'polygon':
            pts = [tuple(float(v) for v in p.split(',')) for p in el.get('points').split()]
            bx0, bx1 = min(p[0] for p in pts), max(p[0] for p in pts)
            c0 = stops[gid][-1]
            cols = [lin3(mix(pan, c0, (p[0] - bx0) / (bx1 - bx0))) for p in pts]
            m.face([(nx(p[0]), ny(p[1]), extrude * 0.6) for p in pts], cols, 1.0, (0, 0, 1))
        elif tag == 'text':
            weight = int(el.get('font-weight', '900'))
            cu = bpy.data.curves.new('logo_text', 'FONT')
            cu.body = el.text; cu.font = fonts[900 if weight >= 800 else 700]; cu.size = float(el.get('font-size'))
            cu.resolution_u = res; cu.fill_mode = 'BOTH'
            ob = bpy.data.objects.new('logo_text', cu); bpy.context.scene.collection.objects.link(ob)
            dg = bpy.context.evaluated_depsgraph_get()
            me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
            vs = [v.co.copy() for v in me.vertices]
            mnx, mxx = min(v.x for v in vs), max(v.x for v in vs)
            sx = float(el.get('textLength')) / (mxx - mnx)
            tx, ty = float(el.get('x')), float(el.get('y'))
            P = [(tx + (v.x - mnx) * sx, ty - v.y) for v in vs]
            ta, tb = stops['txt'][0], stops['txt'][1]
            colof = lambda p: lin3(mix(ta, tb, (p[0] - X0) / (X1 - X0)))
            edges = {}
            for poly in me.polygons:
                idx = list(poly.vertices)
                m.face([(nx(P[i][0]), ny(P[i][1]), extrude) for i in idx], [colof(P[i]) for i in idx], 1.0, (0, 0, 1))
                for k in range(len(idx)):
                    e = (idx[k], idx[(k + 1) % len(idx)])
                    key = tuple(sorted(e))
                    edges.setdefault(key, []).append((e, poly.index))
            if extrude > 0.0025:
                for key, uses in edges.items():
                    if len(uses) != 1: continue
                    (a, b), pi_ = uses[0]
                    cx = sum(P[i][0] for i in me.polygons[pi_].vertices) / me.polygons[pi_].loop_total
                    cy = sum(P[i][1] for i in me.polygons[pi_].vertices) / me.polygons[pi_].loop_total
                    ex, ey = P[b][0] - P[a][0], P[b][1] - P[a][1]
                    n2 = (ey, ex)          # in SVG units; flip to face away from the polygon
                    mx_, my_ = (P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2
                    if n2[0] * (mx_ - cx) + n2[1] * (my_ - cy) < 0: n2 = (-n2[0], -n2[1])
                    col = [lin3(mix([c * 0.55 for c in ta], [c * 0.55 for c in tb], (P[i][0] - X0) / (X1 - X0))) for i in (a, b, b, a)]
                    m.face([(nx(P[a][0]), ny(P[a][1]), 0), (nx(P[b][0]), ny(P[b][1]), 0), (nx(P[b][0]), ny(P[b][1]), extrude), (nx(P[a][0]), ny(P[a][1]), extrude)],
                           col, 1.0, (n2[0], -n2[1], 0))
            bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    return m


def export(obs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in obs: ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=True, export_tangents=False, export_materials='NONE',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False,
                              export_skins=False, export_morph=False, export_extras=False)
    return round(os.path.getsize(path) / 1000)


def show():
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
        print('SS_VIEW', e)


def main():
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    coll = bpy.context.scene.collection
    os.makedirs(OUT, exist_ok=True)
    obs, stats = {}, {}
    for lod in (0, 1, 2):
        m = build(lod)
        obs[f'hq_{lod}'] = m.to_object(f'hq_{lod}', coll)
        obs[f'hq_{lod}'].location = (lod * 120, 0, 0)
        stats[f'hq_{lod}'] = len(m.f)
        show()
    for name, res, ex in (('logo_0', 10, 0.004), ('logo_2', 2, 0.0)):
        m = logo(res, ex)
        obs[name] = m.to_object(name, coll)
        stats[name] = len(m.f)
    show()
    for ob in obs.values(): ob.location = (0, 0, 0)
    out = {'faces': stats}
    out['speedscan_kB'] = export([obs[k] for k in ('hq_0', 'hq_1', 'hq_2', 'logo_0', 'logo_2')], os.path.join(OUT, 'speedscan.glb'))
    out['speedscan_far_kB'] = export([obs['hq_2'], obs['logo_2']], os.path.join(OUT, 'speedscan_far.glb'))
    print('SS_META ' + json.dumps(out))
    # Close the window once the files are written (as buildings.py does): wm.quit_blender can stop on an
    # unsaved-changes prompt and leave the window up.
    sys.stdout.flush()
    os._exit(0)


main()
