# Port Calamity's vegetation, built and baked in Blender by script.
#
#   blender --background --factory-startup --python tools/blender/flora.py -- [noatlas] [sheets]
#
# Writes, under public/models/:
#   flora_atlas.webp   2048 x 1536 colour: eight bark tiles across the top quarter, then
#                      256 px cells of branch-tip sprays, fronds and ground cover, every one
#                      RENDERED from leaf geometry of the right species (outline, midrib,
#                      side veins, a fold along the midrib), not painted
#   flora_mask.webp    the same picture's coverage (alpha), kept apart so the colour under a
#                      transparent texel survives compression and the mip chain
#   flora_nrm.webp     tangent-space normals: bark from its height field, leaves from the
#                      same render pass as the colour (the fold and tilt of each leaf)
#   flora_far.webp, flora_far_mask.webp
#                      the impostor atlas: every tree, rendered from its full-detail model
#                      from two sides (128 x 256) and from above (128 x 128)
#   flora2.glb         the models (see "The file" below)
#
# `noatlas` reuses the leaf renders cached in scratch/allout (the slow step); `sheets`
# also renders lit contact sheets of every tree to shots/allout/sheet-*.png.
#
# Everything is authored in the GAME's frame (y up, a tree stands on y = 0 at the origin).
#
# The file. A tree at full detail is 6-10 thousand triangles, and there are three variants
# of each of sixteen-odd kinds: stored whole that is 12 MB. So the file holds what is
# unique and the loader (src/world/floraAssets.ts) assembles the rest:
#   <kind><v>_w0, _w1   the wood (trunk, scaffold limbs, secondary branches) at two levels
#                       of detail. Quantised: 16-bit positions, 8-bit normals.
#   <kind><v>_t         a point per branch tip: POSITION where the twig leaves its branch,
#                       NORMAL the way it points, COLOR_0 = scale, roll, occlusion, template
#   tpl<i>_L0, _L1      the templates a tip is an instance of: a twig and three or four bent
#                       cards of foliage (L0), or flat cards (L1); a palm frond with every
#                       leaflet (L0) or as a folded strip (L1); a fan leaf on its petiole
#   asset.extras.kinds  per kind: its impostor cells and size, and how the middle level of
#                       detail thins the tips
# COLOR_0 alpha on a mesh vertex says what it is: 0 bark (never tinted), 255 a leaf that
# takes the tree's tint, 128 foliage that keeps its own colour (dead palm fans).

import bpy, sys, os, math, random, struct, json
import numpy as np
from math import sin, cos, pi, tau, exp, sqrt, atan2
from mathutils import Vector, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODELS = os.path.join(ROOT, 'public', 'models')
TMP = os.path.join(ROOT, 'scratch', 'allout')
SHOTS = os.path.join(ROOT, 'shots', 'allout')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
UP = Vector((0, 1, 0))
AW, AH, Q = 2048, 1536, 256

# ── Atlas cells ───────────────────────────────────────────────────────────────
CELLS = {}
BARKS = ['bk_plane', 'bk_furrow', 'bk_birch', 'bk_pine', 'bk_fibre', 'bk_ring', 'bk_boot', 'bk_smooth']
for i, n in enumerate(BARKS): CELLS[n] = (i, 0, 1, 2)
ROWS = [
    ['plane', 'maple', 'oak', 'redoak', 'birch', 'elm', 'cherry', 'shrub'],
    ['pine', 'spruce', 'cypress', 'hedge', 'ivy', 'fern', 'reed', 'fallen'],
    ['grass', 'dune', 'wild', 'bedwarm', 'bedcool', 'fan', 'fandead', 'leaflet'],
]
for r, row in enumerate(ROWS):
    for c, n in enumerate(row): CELLS[n] = (c, r + 2, 1, 1)
CELLS['frond'] = (0, 5, 3, 1)


def rect(name, pad=5):
    c, r, w, h = CELLS[name]
    return ((c * Q + pad) / AW, (r * Q + pad) / AH, ((c + w) * Q - pad) / AW, ((r + h) * Q - pad) / AH)


def lin(c):
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# ── Leaf geometry for the bake ────────────────────────────────────────────────
class Soup:
    """Triangles in the atlas plane (x right, y up, z toward the camera), a colour a vertex."""
    def __init__(self):
        self.v = []; self.t = []; self.c = []

    def add(self, shape, M, col):
        b = len(self.v)
        for p, k in zip(shape['p'], shape['k']):
            self.v.append(tuple(M @ Vector(p)))
            self.c.append((col[0] * k[0], col[1] * k[1], col[2] * k[2]))
        self.t.extend((a + b, c + b, d + b) for a, c, d in shape['t'])

    def line(self, p0, p1, w0, w1, col, z=0.0, col1=None):
        d = Vector((p1[0] - p0[0], p1[1] - p0[1], 0))
        if d.length < 1e-6: return
        n = Vector((-d.y, d.x, 0)).normalized()
        b = len(self.v)
        for p, w, c in ((p0, w0, col), (p1, w1, col1 or col)):
            for s in (-0.5, 0.5):
                self.v.append((p[0] + n.x * w * s, p[1] + n.y * w * s, z)); self.c.append(c)
        self.t.extend(((b, b + 2, b + 3), (b, b + 3, b + 1)))

    def curve(self, pts, w0, w1, col, z=0.0, col1=None):
        n = len(pts) - 1
        for i in range(n):
            f0, f1 = i / n, (i + 1) / n
            mix = lambda f: tuple(col[k] + ((col1 or col)[k] - col[k]) * f for k in range(3))
            self.line(pts[i], pts[i + 1], w0 + (w1 - w0) * f0, w0 + (w1 - w0) * f1, mix(f0), z, mix(f1))

    def disc(self, x, y, r, col, z=0.0, n=10):
        b = len(self.v)
        self.v.append((x, y, z)); self.c.append(col)
        for i in range(n):
            a = tau * i / n
            self.v.append((x + cos(a) * r, y + sin(a) * r, z)); self.c.append(col)
        self.t.extend((b, b + 1 + i, b + 1 + (i + 1) % n) for i in range(n))


VEIN = (1.16, 1.14, 1.0)


def pinnate(profile, n=24, fold=0.28, veins=6, vein_w=0.014):
    """A leaf with a midrib: unit length along +x, half-width profile(t), folded up along the rib."""
    p = []; t = []; k = []
    for i in range(n + 1):
        f = i / n; w = profile(f)
        p += [(f, 0, 0), (f, w, fold * w), (f, -w, fold * w)]
        k += [(0.9, 0.9, 0.9), (1, 1, 1), (1, 1, 1)]
    for i in range(n):
        a = 3 * i; b = a + 3
        t += [(a, b, b + 1), (a, b + 1, a + 1), (a, a + 2, b + 2), (a, b + 2, b)]

    def strip(p0, p1, w):
        b = len(p)
        d = Vector((p1[0] - p0[0], p1[1] - p0[1], 0)); nn = Vector((-d.y, d.x, 0)).normalized() * w
        p.extend([(p0[0] - nn.x, p0[1] - nn.y, p0[2] + 0.006), (p0[0] + nn.x, p0[1] + nn.y, p0[2] + 0.006), (p1[0], p1[1], p1[2] + 0.006)])
        k.extend([VEIN] * 3); t.append((b, b + 1, b + 2))
    strip((-0.12, 0, 0), (0.98, 0, 0), vein_w)
    for i in range(1, veins + 1):
        f = i / (veins + 1) * 0.86
        f1 = min(0.98, f + 0.16); w = profile(f1) * 0.9
        for s in (1, -1): strip((f, 0, 0), (f1, s * w, fold * w), vein_w * 0.55)
    return {'p': p, 't': t, 'k': k}


def palmate(lobes, hw, pw, floor, teeth=0.0, n=72, span=2.75, fold=0.1):
    """A leaf with lobes radiating from the stalk: (angle, length) a lobe."""
    p = [(0, 0, 0)]; k = [(0.9, 0.9, 0.9)]; t = []
    for i in range(n + 1):
        th = -span + 2 * span * i / n
        r = floor * (1 - 0.55 * (abs(th) / span) ** 2)
        for a, l in lobes:
            d = abs(th - a) / hw
            if d < 1: r = max(r, floor * 0.8 + (l - floor * 0.8) * (1 - d) ** pw)
        r *= 1 + teeth * (abs((th * 7) % 2 - 1) - 0.5)
        p.append((r * cos(th), r * sin(th), fold * r * abs(sin(th * 2.2)))); k.append((1, 1, 1))
    t += [(0, i, i + 1) for i in range(1, n + 1)]
    for a, l in lobes:
        b = len(p)
        nx, ny = -sin(a) * 0.016, cos(a) * 0.016
        p += [(-nx, -ny, 0.008), (nx, ny, 0.008), (l * 0.96 * cos(a), l * 0.96 * sin(a), 0.012 + fold * l * abs(sin(a * 2.2)))]
        k += [VEIN] * 3; t.append((b, b + 2, b + 1) if True else None)
    b = len(p)
    p += [(-0.3, -0.012, 0), (-0.3, 0.012, 0), (0.02, 0.014, 0), (0.02, -0.014, 0)]
    k += [(0.8, 0.85, 0.7)] * 4; t += [(b, b + 3, b + 2), (b, b + 2, b + 1)]
    return {'p': p, 't': t, 'k': k}


saw = lambda x: abs((x % 1.0) * 2 - 1)
SHAPES = {
    'maple': palmate([(0, 1.0), (0.92, 0.84), (-0.92, 0.84), (1.8, 0.52), (-1.8, 0.52)], 0.5, 1.25, 0.36, 0.1),
    'plane': palmate([(0, 0.95), (0.85, 0.86), (-0.85, 0.86), (1.65, 0.6), (-1.65, 0.6)], 0.62, 0.8, 0.5, 0.07),
    'ivy': palmate([(0, 1.0), (1.0, 0.78), (-1.0, 0.78), (1.9, 0.5), (-1.9, 0.5)], 0.7, 0.75, 0.55, 0.0),
    'oak': pinnate(lambda f: 0.3 * sin(pi * f ** 1.35) ** 0.7 * (0.58 + 0.42 * sin(pi * 4.5 * f) ** 2) + 0.004, 36, 0.2, 5),
    'redoak': pinnate(lambda f: 0.36 * sin(pi * f ** 1.1) ** 0.8 * (0.4 + 0.6 * saw(f * 4.5 + 0.5) ** 1.6) + 0.004, 40, 0.2, 5),
    'birch': pinnate(lambda f: 0.36 * (f ** 0.45) * (1 - f) ** 0.85 * 1.9 * (1 + 0.1 * saw(f * 13)) + 0.003, 30, 0.3, 6),
    'elm': pinnate(lambda f: 0.27 * sin(pi * f ** 0.8) ** 0.75 * (1 + 0.09 * saw(f * 16)) + 0.003, 34, 0.3, 8),
    'oval': pinnate(lambda f: 0.22 * sin(pi * f ** 0.9) ** 0.8 + 0.003, 14, 0.3, 4),
    'small': pinnate(lambda f: 0.27 * sin(pi * f ** 0.85) ** 0.75 + 0.003, 10, 0.35, 0),
    'petal': pinnate(lambda f: 0.36 * sin(pi * f ** 0.6) ** 0.7 + 0.003, 10, 0.2, 0, 0.0),
    'pinna': pinnate(lambda f: 0.16 * (1 - f) ** 0.6 * (0.75 + 0.25 * saw(f * 7)) + 0.003, 14, 0.2, 0, 0.008),
    'blade': pinnate(lambda f: 0.045 * (1 - f ** 2.2) + 0.002, 8, 0.5, 0, 0.004),
}


def put(S, shape, x, y, ang, L, col, rng, z, tilt=1.0):
    M = (Matrix.Translation((x, y, z)) @ Matrix.Rotation(ang, 4, 'Z') @ Matrix.Rotation(rng.uniform(-0.3, 0.3) * tilt, 4, 'Y')
         @ Matrix.Rotation(rng.uniform(-0.6, 0.6) * tilt, 4, 'X') @ Matrix.Scale(L, 4))
    S.add(SHAPES[shape], M, col)


def scatter(rng, n, cx, cy, rx, ry):
    pts = []
    for _ in range(n):
        best = None; bd = -1
        for _k in range(10):
            a = rng.uniform(0, tau); r = sqrt(rng.random())
            p = (cx + cos(a) * r * rx, cy + sin(a) * r * ry)
            d = min(((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 for q in pts), default=9)
            if d > bd: bd = d; best = p
        pts.append(best)
    return pts


PALE = lin((0.68, 0.73, 0.56))
TWIG = lin((0.36, 0.3, 0.24))


def tone(rng, base, f, lo=0.62):
    """Leaves laid first are underneath: darker, as if shaded by the ones on top."""
    v = (lo + (1 - lo) * f) * rng.uniform(0.9, 1.08)
    return (base[0] * v * rng.uniform(0.94, 1.06), base[1] * v, base[2] * v * rng.uniform(0.85, 1.1))


def twigs(S, ox, oy, rng, n=4, top=0.66, w=0.022, col=TWIG):
    x1 = 0.5 + rng.uniform(-0.05, 0.05)
    main = [(ox + 0.5 + (x1 - 0.5) * (f ** 2), oy + 0.01 + (top - 0.01) * f) for f in [i / 8 for i in range(9)]]
    S.curve(main, w, w * 0.4, col, 0.0005)
    for i in range(n):
        f = 0.2 + 0.7 * (i + rng.random()) / n; s = 1 if i % 2 else -1
        j = int(f * 8); p = main[j]
        a = pi / 2 - s * rng.uniform(0.6, 1.0); L = rng.uniform(0.2, 0.34) * (1.2 - f)
        q = (p[0] + cos(a) * L, p[1] + sin(a) * L)
        m = ((p[0] + q[0]) / 2 + s * 0.012, (p[1] + q[1]) / 2 + 0.02)
        S.curve([p, m, q], w * 0.55, w * 0.25, col, 0.0005)


def leafy(S, cell, shape, n, L, rng, base=PALE, jit=0.55, oval=None, tw=True):
    c, r, _, _ = CELLS[cell]; ox, oy = c, AH / Q - r - 1
    if tw: twigs(S, ox, oy, rng)
    rx, ry = oval or (0.465 - L * 0.5, 0.465 - L * 0.5)
    pts = scatter(rng, n, 0.5, 0.52, rx, ry)
    # Outer leaves first, so the middle of the spray is on top and brightest.
    pts.sort(key=lambda p: -((p[0] - 0.5) ** 2 + (p[1] - 0.45) ** 2))
    for i, p in enumerate(pts):
        a = atan2(p[1] - 0.2, p[0] - 0.5) + rng.uniform(-jit, jit)
        l = L * rng.uniform(0.78, 1.12)
        put(S, shape, ox + p[0] - cos(a) * l * 0.5, oy + p[1] - sin(a) * l * 0.5, a, l, tone(rng, base, i / n), rng, 0.01 + 0.0015 * i)


def paint_cells(S):
    rng = random.Random(77)
    org = lambda cell: (CELLS[cell][0], AH / Q - CELLS[cell][1] - 1)
    leafy(S, 'plane', 'plane', 26, 0.25, rng)
    leafy(S, 'maple', 'maple', 30, 0.23, rng)
    leafy(S, 'oak', 'oak', 34, 0.27, rng)
    leafy(S, 'redoak', 'redoak', 30, 0.3, rng)
    leafy(S, 'birch', 'birch', 60, 0.14, rng)
    leafy(S, 'elm', 'elm', 44, 0.2, rng)
    leafy(S, 'shrub', 'small', 110, 0.1, rng)
    leafy(S, 'ivy', 'ivy', 30, 0.2, rng, base=lin((0.2, 0.36, 0.17)), jit=1.6, oval=(0.36, 0.38))

    # Cherry in blossom: clusters of five-petalled flowers, a few bronze leaves just breaking.
    ox, oy = org('cherry'); twigs(S, ox, oy, rng, 5, 0.8)
    for i, p in enumerate(scatter(rng, 9, 0.5, 0.52, 0.3, 0.32)):
        a = rng.uniform(0, tau)
        put(S, 'oval', ox + p[0], oy + p[1], a, 0.15, tone(rng, lin((0.56, 0.5, 0.4)), 0.6), rng, 0.01)
    for i, p in enumerate(scatter(rng, 46, 0.5, 0.52, 0.38, 0.39)):
        r = rng.uniform(0.045, 0.062); a0 = rng.uniform(0, tau); z = 0.02 + 0.002 * i
        col = tone(rng, lin((0.93, 0.9, 0.9)), i / 46, 0.8)
        for q in range(5):
            a = a0 + q * tau / 5
            S.add(SHAPES['petal'], Matrix.Translation((ox + p[0], oy + p[1], z)) @ Matrix.Rotation(a, 4, 'Z') @ Matrix.Rotation(-0.25, 4, 'Y') @ Matrix.Scale(r, 4), col)
        S.disc(ox + p[0], oy + p[1], r * 0.2, lin((0.8, 0.62, 0.5)), z + 0.004, 6)

    # White pine: bundles of five long soft needles, brushed forward along the twig.
    ox, oy = org('pine'); col = lin((0.52, 0.64, 0.54))
    stems = [[(0.5, 0.02), (0.5, 0.4), (0.5, 0.74)], [(0.5, 0.2), (0.36, 0.42), (0.26, 0.6)], [(0.5, 0.3), (0.63, 0.5), (0.74, 0.62)]]
    for st in stems: S.curve([(ox + x, oy + y) for x, y in st], 0.02, 0.008, TWIG, 0.0005)
    k = 0
    for st in stems:
        for seg in range(2):
            (x0, y0), (x1, y1) = st[seg], st[seg + 1]
            nb = 13 if seg else 7
            for i in range(nb):
                f = (i + rng.random()) / nb
                if st is stems[0] and seg == 0 and f < 0.5: continue
                px, py = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f; a = atan2(y1 - y0, x1 - x0)
                for q in range(6):
                    b = a + rng.uniform(-0.75, 0.75); L = rng.uniform(0.17, 0.24); k += 1
                    c = tone(rng, col, rng.random(), 0.6)
                    S.line((ox + px, oy + py), (ox + px + cos(b) * L, oy + py + sin(b) * L), 0.008, 0.003, c, 0.002 + 0.00002 * k)

    # Spruce: a flat spray, every side shoot lined with short stiff needles.
    ox, oy = org('spruce'); col = lin((0.5, 0.62, 0.52)); k = 0
    def needled(pts, w):
        nonlocal k
        S.curve([(ox + x, oy + y) for x, y in pts], w, w * 0.4, TWIG, 0.0005)
        for i in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]; L = math.hypot(x1 - x0, y1 - y0); a = atan2(y1 - y0, x1 - x0)
            for j in range(int(L / 0.011)):
                f = j * 0.011 / L; px, py = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
                for s in (1, -1):
                    b = a + s * rng.uniform(0.7, 1.15); l = rng.uniform(0.032, 0.046); k += 1
                    S.line((ox + px, oy + py), (ox + px + cos(b) * l, oy + py + sin(b) * l), 0.0085, 0.004, tone(rng, col, rng.random(), 0.55), 0.002 + 0.00001 * k)
    needled([(0.5, 0.02), (0.5, 0.5), (0.5, 0.95)], 0.02)
    for i in range(7):
        y = 0.1 + i * 0.115; L = 0.4 * (1 - 0.1 * i) * rng.uniform(0.85, 1.0)
        for s in (1, -1):
            a = pi / 2 - s * 0.95
            needled([(0.5, y), (0.5 + cos(a) * L * 0.5, y + sin(a) * L * 0.5 + 0.01), (0.5 + cos(a) * L, y + sin(a) * L)], 0.012)

    # Cypress: scale leaves, so the spray is the shoots themselves, forking and forking again.
    ox, oy = org('cypress'); col = lin((0.5, 0.64, 0.5)); k = 0
    def fork(x, y, a, L, w, d):
        nonlocal k
        x1, y1 = x + cos(a) * L, y + sin(a) * L; k += 1
        if not (0.03 < x1 < 0.97 and y1 < 0.97): return
        c = tone(rng, col, min(1, d / 4 + rng.random() * 0.4), 0.5)
        S.line((ox + x, oy + y), (ox + x1, oy + y1), w, w * 0.8, c, 0.001 + 0.00001 * k)
        S.disc(ox + x1, oy + y1, w * 0.4, c, 0.001 + 0.00001 * k, 6)
        if d >= 5: return
        fork(x1, y1, a + rng.uniform(-0.12, 0.12), L * 0.82, w * 0.86, d + 1)
        for s in (1, -1):
            if rng.random() < 0.85: fork(x + cos(a) * L * rng.uniform(0.3, 0.8), y + sin(a) * L * rng.uniform(0.3, 0.8), a + s * rng.uniform(0.35, 0.6), L * 0.62, w * 0.8, d + 1)
    for i in range(7): fork(0.5 + (i - 3) * 0.035, 0.02, pi / 2 + (i - 3) * 0.2 + rng.uniform(-0.05, 0.05), rng.uniform(0.2, 0.26), 0.03, 0)

    # A clipped hedge face: leaves in every direction over a dark ground, no gaps at all.
    ox, oy = org('hedge')
    b = len(S.v); dk = lin((0.3, 0.36, 0.26))
    S.v += [(ox, oy, 0), (ox + 1, oy, 0), (ox + 1, oy + 1, 0), (ox, oy + 1, 0)]; S.c += [dk] * 4; S.t += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
    for i in range(520):
        put(S, 'small', ox + rng.uniform(0.02, 0.98), oy + rng.uniform(0.02, 0.98), rng.uniform(0, tau), rng.uniform(0.06, 0.09), tone(rng, PALE, i / 520, 0.5), rng, 0.004 + 0.0001 * i, 1.6)

    # A fern frond, from the ground up.
    ox, oy = org('fern'); col = lin((0.3, 0.5, 0.2))
    for fr in range(5):
        a0 = pi / 2 + (fr - 2) * 0.42 + rng.uniform(-0.08, 0.08); L = rng.uniform(0.72, 0.92) * (1 - 0.1 * abs(fr - 2)); bend = (fr - 2) * -0.22
        pts = []; x, y, a = 0.5 + (fr - 2) * 0.02, 0.01, a0
        for i in range(15):
            pts.append((x, y)); x += cos(a) * L / 14; y += sin(a) * L / 14; a += bend / 14 * (1 + i / 7)
        S.curve([(ox + px, oy + py) for px, py in pts], 0.012, 0.004, lin((0.36, 0.42, 0.2)), 0.001 * fr)
        for i in range(2, 15):
            f = i / 14; l = 0.2 * sin(pi * f ** 0.6) ** 0.8 + 0.02; ta = atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0])
            for s in (1, -1):
                put(S, 'pinna', ox + pts[i][0], oy + pts[i][1], ta + s * 1.15, l, tone(rng, col, 0.5 + 0.5 * f, 0.6), rng, 0.001 * fr + 0.0005, 0.5)

    # Blades from the ground: lawn grass, straw dune grass, reeds with their brown heads.
    def blades(cell, n, spread, h0, h1, lean, w, c0, c1, zc=0.0):
        ox, oy = org(cell)
        for i in range(n):
            bx = 0.5 + rng.uniform(-spread, spread); h = rng.uniform(h0, h1); tip = rng.uniform(-lean, lean) * h / h1
            f = rng.random(); c = tuple(c0[q] + (c1[q] - c0[q]) * f for q in range(3))
            pts = [(ox + bx + tip * (t ** 2), oy + 0.005 + h * t * (1 - 0.12 * abs(tip) * t)) for t in [q / 6 for q in range(7)]]
            S.curve(pts, w, w * 0.15, tuple(q * 0.6 for q in c), zc + 0.0001 * i, c)
            yield (pts[-1][0], pts[-1][1], i)
    for _ in blades('grass', 150, 0.4, 0.3, 0.93, 0.3, 0.028, lin((0.3, 0.46, 0.17)), lin((0.52, 0.66, 0.28))): pass
    for _ in blades('dune', 46, 0.2, 0.5, 0.96, 0.42, 0.016, lin((0.6, 0.6, 0.36)), lin((0.8, 0.76, 0.5))): pass
    ox, oy = org('reed')
    for x, y, i in blades('reed', 26, 0.3, 0.6, 0.97, 0.14, 0.022, lin((0.34, 0.46, 0.2)), lin((0.56, 0.62, 0.3))):
        if i % 3 == 0:
            S.line((x, y - 0.2), (x, y - 0.03), 0.034, 0.03, lin((0.3, 0.19, 0.11)), 0.01)
            S.disc(x, y - 0.03, 0.015, lin((0.3, 0.19, 0.11)), 0.01, 6); S.disc(x, y - 0.2, 0.017, lin((0.3, 0.19, 0.11)), 0.01, 6)

    # Flowers in their own colours: a meadow mix, and two beds.
    def bloom(x, y, r, col, eye, z, petals=8, shape='petal'):
        a0 = rng.uniform(0, tau)
        for q in range(petals):
            S.add(SHAPES[shape], Matrix.Translation((x, y, z)) @ Matrix.Rotation(a0 + q * tau / petals, 4, 'Z') @ Matrix.Rotation(-0.2, 4, 'Y') @ Matrix.Scale(r, 4), tone(rng, col, 1, 0.85))
        S.disc(x, y, r * 0.3, eye, z + 0.004, 7)
    MEADOW = [((0.96, 0.95, 0.9), (0.9, 0.7, 0.1), 12), ((0.95, 0.76, 0.1), (0.7, 0.45, 0.05), 6), ((0.84, 0.2, 0.16), (0.1, 0.08, 0.08), 5), ((0.42, 0.45, 0.85), (0.2, 0.2, 0.4), 9), ((0.9, 0.55, 0.72), (0.9, 0.8, 0.3), 6)]
    WARM = [((0.9, 0.2, 0.14), (0.25, 0.1, 0.05), 6), ((0.96, 0.55, 0.1), (0.5, 0.25, 0.05), 10), ((0.98, 0.82, 0.16), (0.6, 0.4, 0.05), 8), ((0.78, 0.1, 0.22), (0.95, 0.8, 0.2), 5)]
    COOL = [((0.93, 0.5, 0.7), (0.95, 0.85, 0.4), 6), ((0.6, 0.4, 0.8), (0.95, 0.85, 0.3), 5), ((0.96, 0.95, 0.92), (0.9, 0.75, 0.2), 9), ((0.75, 0.25, 0.55), (0.2, 0.1, 0.2), 5)]
    ox, oy = org('wild')
    for x, y, i in blades('wild', 70, 0.4, 0.25, 0.86, 0.24, 0.022, lin((0.3, 0.46, 0.18)), lin((0.5, 0.64, 0.28))):
        if i % 4 == 0 and y - oy > 0.4:
            c, e, n = MEADOW[rng.randrange(len(MEADOW))]
            bloom(x, min(y, oy + 0.9), rng.uniform(0.045, 0.07), lin(c), lin(e), 0.02 + 0.001 * i, n)
    for cell, pal in (('bedwarm', WARM), ('bedcool', COOL)):
        ox, oy = org(cell)
        for i in range(64):
            a = pi / 2 + rng.uniform(-1.1, 1.1); l = rng.uniform(0.16, 0.26)
            put(S, 'oval', ox + 0.5 + rng.uniform(-0.36, 0.36), oy + rng.uniform(0.02, 0.5), a, l, tone(rng, lin((0.26, 0.44, 0.18)), i / 64, 0.55), rng, 0.002 + 0.0002 * i)
        for i, p in enumerate(scatter(rng, 24, 0.5, 0.6, 0.39, 0.3)):
            c, e, n = pal[rng.randrange(len(pal))]
            S.line((ox + p[0], oy + 0.2), (ox + p[0], oy + p[1]), 0.012, 0.01, lin((0.3, 0.46, 0.2)), 0.015)
            bloom(ox + p[0], oy + p[1], rng.uniform(0.06, 0.085), lin(c), lin(e), 0.02 + 0.001 * i, n)

    # Fallen leaves, flat on the ground, in the colours they fell in.
    ox, oy = org('fallen')
    FALL = [(0.8, 0.42, 0.1), (0.72, 0.2, 0.08), (0.86, 0.66, 0.16), (0.5, 0.3, 0.14), (0.62, 0.36, 0.12)]
    for i, p in enumerate(scatter(rng, 26, 0.5, 0.5, 0.36, 0.36)):
        sh = rng.choice(['maple', 'maple', 'oak', 'birch', 'redoak']); L = 0.13 if sh == 'maple' else 0.19
        put(S, sh, ox + p[0], oy + p[1], rng.uniform(0, tau), L * rng.uniform(0.8, 1.1), tone(rng, lin(rng.choice(FALL)), 1, 0.8), rng, 0.002 + 0.0003 * i, 0.5)

    # A fan palm's leaf: fifty-odd pleated segments joined for two thirds of their length, the tips free and split.
    for cell, c0 in (('fan', PALE), ('fandead', lin((0.62, 0.5, 0.32)))):
        ox, oy = org(cell); N = 46
        for i in range(N):
            a = pi / 2 + (i / (N - 1) - 0.5) * 2.95; L = 0.88 * (0.78 + 0.22 * cos((i / (N - 1) - 0.5) * 2.4)) * rng.uniform(0.94, 1.0)
            c = tone(rng, c0, 0.5 + 0.5 * (i % 2), 0.72)
            hx, hy = ox + 0.5, oy + 0.06
            mid = (hx + cos(a) * L * 0.62, hy + sin(a) * L * 0.62)
            S.line((hx, hy), mid, 0.008, 0.047, c, 0.001 + 0.00002 * i)
            d = rng.uniform(-0.1, 0.1) if cell == 'fan' else rng.uniform(-0.3, 0.3)
            S.line(mid, (mid[0] + cos(a + d) * L * 0.38, mid[1] + sin(a + d) * L * 0.38), 0.047, 0.003, c, 0.001 + 0.00002 * i)
            S.line((hx, hy), mid, 0.004, 0.006, tuple(q * 1.15 for q in c), 0.003)
    # One leaflet of a feather palm, and the whole frond for the far models.
    ox, oy = org('leaflet')
    for i in range(4):
        y = oy + 0.125 + i * 0.25
        S.add(SHAPES['blade'], Matrix.Translation((ox + 0.03, y, 0)) @ Matrix.Scale(0.94, 4) @ Matrix.Diagonal((1, 2.1, 1, 1)), tone(rng, PALE, 0.6 + 0.13 * i, 0.7))
    ox, oy = org('frond')
    S.line((ox + 0.02, oy + 0.5), (ox + 2.97, oy + 0.5), 0.03, 0.006, lin((0.62, 0.64, 0.42)), 0.02)
    for i in range(110):
        f = i / 109; x = 0.06 + 2.88 * f; L = 0.12 + 0.34 * sin(pi * f ** 0.6) ** 0.7
        for s in (1, -1):
            a = s * (1.05 - 0.45 * f) + rng.uniform(-0.05, 0.05)
            S.add(SHAPES['blade'], Matrix.Translation((ox + x, oy + 0.5, 0.001 + 0.0001 * i)) @ Matrix.Rotation(a, 4, 'Z') @ Matrix.Scale(L, 4) @ Matrix.Diagonal((1, 1.5, 1, 1)), tone(rng, PALE, rng.random(), 0.66))


# ── Blender plumbing ──────────────────────────────────────────────────────────
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 24
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    sc.render.resolution_percentage = 100
    w = bpy.data.worlds.new('w'); sc.world = w
    try: w.use_nodes = True
    except Exception: pass
    bg = w.node_tree.nodes.get('Background')
    if bg: bg.inputs[0].default_value = (0, 0, 0, 1); bg.inputs[1].default_value = 0.0
    try: sc.view_settings.view_transform = 'Standard'
    except Exception as e: print('view transform', e)
    try: sc.view_settings.look = 'None'
    except Exception: pass
    return sc


def ortho_cam(sc, cx, cy, scale):
    cd = bpy.data.cameras.new('cam'); cd.type = 'ORTHO'; cd.ortho_scale = scale; cd.clip_start = 0.1; cd.clip_end = 200
    cam = bpy.data.objects.new('cam', cd); cam.location = (cx, cy, 50)
    sc.collection.objects.link(cam); sc.camera = cam
    return cam


def new_mat(name):
    m = bpy.data.materials.new(name)
    try: m.use_nodes = True
    except Exception: pass
    for n in list(m.node_tree.nodes): m.node_tree.nodes.remove(n)
    m.use_backface_culling = False
    return m, m.node_tree.nodes, m.node_tree.links


def render_to(sc, path, w, h):
    sc.render.resolution_x = w; sc.render.resolution_y = h; sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def read_png(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return (a.reshape(h, w, 4)[::-1] * 255 + 0.5).astype(np.uint8)


def save_img(arr, path, quality=90):
    h, w, ch = arr.shape
    img = bpy.data.images.new('out', w, h, alpha=(ch == 4))
    px = np.ones((h, w, 4), np.float32); px[..., :ch] = arr[::-1].astype(np.float32) / 255
    img.pixels.foreach_set(px.ravel())
    img.file_format = 'WEBP' if path.endswith('.webp') else 'PNG'
    img.filepath_raw = path
    img.save(quality=quality)
    bpy.data.images.remove(img)


def dilate(rgb, alpha, n=24):
    """Carry leaf colour out under the transparent texels, so mip levels and filtering never pull in black."""
    rgb = rgb.astype(np.float32); have = alpha > 40
    fill = rgb[have].mean(0) if have.any() else np.array([120, 130, 100], np.float32)
    for _ in range(n):
        acc = np.zeros_like(rgb); cnt = np.zeros(have.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            acc += np.roll(rgb * have[..., None], (dy, dx), (0, 1)); cnt += np.roll(have, (dy, dx), (0, 1))
        new = (~have) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][:, None]
        have = have | new
    rgb[~have] = fill
    return np.clip(rgb, 0, 255).astype(np.uint8)


# ── Bark: a height field a tile, coloured and differentiated ──────────────────
def vnoise(w, h, fx, fy, rs):
    g = rs.random((fy, fx))
    ys = np.arange(h) * fy / h; xs = np.arange(w) * fx / w
    y0 = ys.astype(int); x0 = xs.astype(int); ty = ys - y0; tx = xs - x0
    ty = ty * ty * (3 - 2 * ty); tx = tx * tx * (3 - 2 * tx)
    y1 = (y0 + 1) % fy; x1 = (x0 + 1) % fx
    top = g[np.ix_(y0, x0)] * (1 - tx) + g[np.ix_(y0, x1)] * tx
    bot = g[np.ix_(y1, x0)] * (1 - tx) + g[np.ix_(y1, x1)] * tx
    return top * (1 - ty)[:, None] + bot * ty[:, None]


def fbm(w, h, fx, fy, rs, octv=4):
    out = np.zeros((h, w)); amp = 1.0; tot = 0.0
    for o in range(octv):
        out += vnoise(w, h, fx << o, fy << o, rs) * amp; tot += amp; amp *= 0.5
    return out / tot


def ramp(h, stops):
    xs = [s[0] for s in stops]
    return np.stack([np.interp(h, xs, [s[1][k] for s in stops]) for k in range(3)], -1)


def barks():
    W, H = Q, 2 * Q; out = {}
    rs = np.random.RandomState(5)
    yy, xx = np.mgrid[0:H, 0:W]
    ridge = lambda n, p=0.7: 1 - np.abs(2 * n - 1) ** p
    # Furrowed (maple, oak, elm): long ridges that braid.
    h = ridge(fbm(W, H, 9, 3, rs)) * 0.8 + fbm(W, H, 32, 24, rs, 3) * 0.2
    out['bk_furrow'] = (h, ramp(h, [(0.15, (58, 50, 44)), (0.5, (150, 140, 128)), (0.9, (206, 198, 186))]), 5.0)
    # London plane: smooth, and shed in patches of cream, olive and grey.
    a = fbm(W, H, 4, 6, rs, 3); b = fbm(W, H, 5, 7, rs, 3)
    h = 0.5 + 0.25 * (a > 0.54) - 0.2 * (b > 0.58) + fbm(W, H, 40, 60, rs, 2) * 0.08
    col = np.where((a > 0.54)[..., None], np.array([226, 220, 190.0]), np.where((b > 0.58)[..., None], np.array([150, 152, 120.0]), np.array([182, 176, 160.0])))
    col *= (0.9 + 0.2 * fbm(W, H, 24, 30, rs, 3))[..., None]
    out['bk_plane'] = (h, col, 2.0)
    # Paper birch: white, with dark lenticels across it, a few black scars, tan where it has peeled.
    h = np.full((H, W), 0.6); col = np.full((H, W, 3), (236, 233, 224.0))
    peel = fbm(W, H, 2, 12, rs, 3)
    col[peel > 0.62] = (214, 190, 160); h[peel > 0.62] -= 0.12
    edge = (np.abs(peel - 0.62) < 0.012); col[edge] = (120, 104, 90); h[edge] += 0.2
    for i in range(170):
        x = rs.randint(0, W); y = rs.randint(2, H - 4); L = rs.randint(6, 44); t = rs.randint(1, 4)
        xsl = np.arange(x, x + L) % W
        col[y:y + t, xsl] = (52, 46, 42) if i % 3 else (110, 100, 92); h[y:y + t, xsl] -= 0.3
    for i in range(5):
        x = rs.randint(20, W - 20); y = rs.randint(20, H - 30); s = rs.randint(8, 16)
        m = (np.abs(xx - x) < (s - (yy - y) * 0.8)) & (yy >= y) & (yy < y + s)
        col[m] = (34, 30, 28); h[m] -= 0.35
    col *= (0.93 + 0.14 * fbm(W, H, 20, 40, rs, 3))[..., None]
    out['bk_birch'] = (h, col, 3.0)
    # White pine: broad plates between deep furrows.
    h = ridge(fbm(W, H, 5, 3, rs, 2), 0.5) * 0.7 + ridge(fbm(W, H, 6, 9, rs, 2), 0.8) * 0.3
    out['bk_pine'] = (h, ramp(h, [(0.2, (46, 40, 38)), (0.55, (122, 106, 96)), (0.9, (172, 150, 132))]), 6.0)
    # Cypress and spruce: thin fibrous strips.
    h = fbm(W, H, 44, 3, rs, 3) * 0.7 + fbm(W, H, 12, 12, rs, 3) * 0.3
    out['bk_fibre'] = (h, ramp(h, [(0.2, (84, 66, 56)), (0.5, (150, 128, 110)), (0.85, (196, 178, 160))]), 3.0)
    # A palm's rings: each steps out a little above its scar.
    f = (yy % 64) / 64.0
    h = (1 - f) ** 0.6 * 0.6 + fbm(W, H, 50, 5, rs, 3) * 0.4
    col = ramp(h, [(0.2, (112, 102, 90)), (0.6, (176, 166, 148)), (0.95, (208, 198, 180))]); col[f > 0.9] *= 0.62
    out['bk_ring'] = (h, col, 4.0)
    # A date palm's boots: the cut stubs of old fronds, in a diamond lattice.
    row = (yy * 9 // H); fy = (yy * 9 / H) % 1.0; fx = ((xx * 6 / W) + 0.5 * (row % 2)) % 1.0
    h = np.clip((1 - fy) ** 0.5 * (1 - np.abs(2 * fx - 1) ** 3), 0, 1) * 0.85 + fbm(W, H, 30, 30, rs, 3) * 0.15
    col = ramp(h, [(0.1, (40, 32, 26)), (0.5, (128, 104, 80)), (0.9, (176, 150, 118))])
    out['bk_boot'] = (h, col, 7.0)
    # Cherry and shrub stems: smooth and banded.
    h = 0.5 + 0.2 * (fbm(W, H, 3, 40, rs, 2) > 0.6) + fbm(W, H, 30, 30, rs, 2) * 0.1
    out['bk_smooth'] = (h, ramp(h, [(0.4, (120, 96, 84)), (0.6, (164, 140, 124)), (0.8, (206, 190, 170))]), 2.0)
    return out


def build_atlas(sc):
    col_png = os.path.join(TMP, 'leaf_col.png'); nrm_png = os.path.join(TMP, 'leaf_nrm.png')
    if 'noatlas' not in ARGS or not os.path.exists(col_png):
        S = Soup(); paint_cells(S)
        V = np.array(S.v, np.float32); T = np.array(S.t, np.int32); C = np.array(S.c, np.float32)
        fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
        fn[fn[:, 2] < 0] *= -1
        N = np.zeros_like(V)
        for k in range(3): np.add.at(N, T[:, k], fn)
        N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        C = C * (0.72 + 0.28 * N[:, 2:3])
        me = bpy.data.meshes.new('leaves'); me.from_pydata(V.tolist(), [], T.tolist()); me.update()
        for name, data in (('c', C), ('n', np.stack([0.5 + 0.5 * N[:, 0], 0.5 - 0.5 * N[:, 1], 0.5 + 0.5 * N[:, 2]], -1))):
            at = me.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
            at.data.foreach_set('color', np.concatenate([data, np.ones((len(V), 1))], 1).astype(np.float32).ravel())
        mat, nodes, links = new_mat('bake')
        an = nodes.new('ShaderNodeAttribute'); an.attribute_name = 'c'
        em = nodes.new('ShaderNodeEmission'); out = nodes.new('ShaderNodeOutputMaterial')
        links.new(an.outputs['Color'], em.inputs['Color']); links.new(em.outputs[0], out.inputs['Surface'])
        me.materials.append(mat)
        ob = bpy.data.objects.new('leaves', me); sc.collection.objects.link(ob)
        ortho_cam(sc, AW / Q / 2, AH / Q / 2, AW / Q)
        print('atlas: %d triangles of leaf' % len(T))
        render_to(sc, col_png, AW, AH)
        an.attribute_name = 'n'; sc.view_settings.view_transform = 'Raw'
        render_to(sc, nrm_png, AW, AH)
        sc.view_settings.view_transform = 'Standard'
        bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    col = read_png(col_png); nrm = read_png(nrm_png)
    alpha = col[..., 3].copy()
    # Nothing may touch a cell's edge, or it shows as a line on the next cell's card.
    for name, (c, r, w, h) in CELLS.items():
        if name.startswith('bk_') or name == 'hedge': continue
        x0, y0, x1, y1 = c * Q, r * Q, (c + w) * Q, (r + h) * Q
        alpha[y0:y0 + 3, x0:x1] = 0; alpha[y1 - 3:y1, x0:x1] = 0; alpha[y0:y1, x0:x0 + 3] = 0; alpha[y0:y1, x1 - 3:x1] = 0
    hc, hr, _, _ = CELLS['hedge']; alpha[hr * Q:(hr + 1) * Q, hc * Q:(hc + 1) * Q] = 255
    rgb = dilate(col[..., :3], alpha)
    nm = nrm[..., :3].copy(); nm[alpha < 128] = (128, 128, 255)
    for name, (h, c, strength) in barks().items():
        bc = CELLS[name][0] * Q
        rgb[0:2 * Q, bc:bc + Q] = np.clip(c, 0, 255)
        dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength; dy = np.gradient(h, axis=0) * 2 * strength
        n = np.stack([-dx, -dy, np.ones_like(h)], -1); n /= np.linalg.norm(n, axis=2, keepdims=True)
        nm[0:2 * Q, bc:bc + Q] = np.clip(n * 127.5 + 127.5, 0, 255)
    alpha[0:2 * Q, :] = 255
    save_img(rgb, os.path.join(MODELS, 'flora_atlas.webp'), 88)
    save_img(np.repeat(alpha[..., None], 3, 2), os.path.join(MODELS, 'flora_mask.webp'), 92)
    small = nm.reshape(AH // 2, 2, AW // 2, 2, 3).mean((1, 3)).astype(np.uint8)
    save_img(small, os.path.join(MODELS, 'flora_nrm.webp'), 90)
    rgba = np.concatenate([rgb, alpha[..., None]], 2)
    save_img(rgba, os.path.join(TMP, 'atlas.png'))
    return os.path.join(TMP, 'atlas.png')


# ── Meshes in the game's frame ────────────────────────────────────────────────
class Mesh:
    def __init__(self):
        self.p = []; self.n = []; self.uv = []; self.c = []; self.leaf = []; self.t = []

    def vert(self, p, n, uv, c, leaf=0.0):
        self.p.append((p[0], p[1], p[2])); self.n.append((n[0], n[1], n[2])); self.uv.append(uv); self.c.append(c); self.leaf.append(leaf)
        return len(self.p) - 1

    def tris(self): return len(self.t)


def tri_wave(x): return abs((x % 2.0) - 1.0)


def tube(m, pts, rad, sides, bark, tint, shade=None, vrep=0.5, flare=None, cap=False):
    u0, v0, u1, v1 = rect(bark, 8)
    nrm = None; L = 0.0; rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        if nrm is None:
            ref = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 0, 1))
            nrm = (ref - t * ref.dot(t)).normalized()
        else:
            nrm = (nrm - t * nrm.dot(t)).normalized()
        b = t.cross(nrm)
        if i: L += (p - pts[i - 1]).length
        vv = v0 + (v1 - v0) * (0.02 + 0.96 * tri_wave(L * vrep))
        s = shade[i] if shade else 1.0
        rings.append(len(m.p))
        for j in range(sides + 1):
            a = tau * j / sides; d = nrm * cos(a) + b * sin(a)
            r = rad[i] * (flare(i, a) if flare else 1.0)
            m.vert(p + d * r, d, (u0 + (u1 - u0) * (1 - abs(2 * j / sides - 1)), vv), (tint[0] * s, tint[1] * s, tint[2] * s))
    for i in range(len(pts) - 1):
        for j in range(sides):
            a0 = rings[i] + j; b0 = rings[i + 1] + j
            m.t += [(a0, a0 + 1, b0 + 1), (a0, b0 + 1, b0)]
    if cap:
        c = m.vert(pts[-1], (pts[-1] - pts[-2]).normalized(), ((u0 + u1) / 2, v0 + 0.01), tint)
        m.t += [(rings[-1] + j, rings[-1] + j + 1, c) for j in range(sides)]


def bez(S, d0, T, n, rng, gnarl):
    L = (T - S).length; c = S + d0 * (L * 0.5)
    o1 = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * (gnarl * L)
    o2 = Vector((rng.uniform(-1, 1), rng.uniform(-0.5, 0.5), rng.uniform(-1, 1))) * (gnarl * L * 0.6)
    out = []
    for i in range(n + 1):
        t = i / n
        out.append(S * (1 - t) ** 2 + c * (2 * t * (1 - t)) + T * (t * t) + o1 * sin(pi * t) * t + o2 * sin(tau * t) * (1 - t))
    return out


def along(pts, t):
    f = min(max(t, 0.0), 0.9999) * (len(pts) - 1); i = int(f)
    return pts[i].lerp(pts[i + 1], f - i), (pts[i + 1] - pts[i]).normalized()


def rand_unit(rng):
    while True:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if 0.05 < v.length < 1: return v.normalized()


def tcard(m, cell, C, w, h, pitch, roll, bend=0.0, cup=0.0, flip=False, seg=2, shade=1.0, leaf=1.0, yaw=0.0):
    """One card of a template: in its own frame it lies in XY, grows along +y, faces +z."""
    u0, v0, u1, v1 = rect(cell)
    if flip: u0, u1 = u1, u0
    R = Matrix.Rotation(roll, 3, 'Y') @ Matrix.Rotation(yaw, 3, 'Z') @ Matrix.Rotation(pitch, 3, 'X')
    P = []
    for j in range(seg + 1):
        for i in range(seg + 1):
            a = i / seg - 0.5; b = j / seg - 0.5
            P.append(R @ Vector((a * w, b * h, -bend * h * (b + 0.5) ** 2 + cup * w * (a * a * 4 - 0.33))) + Vector(C))
    base = len(m.p)
    for j in range(seg + 1):
        for i in range(seg + 1):
            q = P[j * (seg + 1) + i]
            qx = P[j * (seg + 1) + min(i + 1, seg)] - P[j * (seg + 1) + max(i - 1, 0)]
            qy = P[min(j + 1, seg) * (seg + 1) + i] - P[max(j - 1, 0) * (seg + 1) + i]
            n = qx.cross(qy).normalized()
            m.vert(q, n, (u0 + (u1 - u0) * i / seg, v1 - (v1 - v0) * j / seg), (shade, shade, shade), leaf)
    for j in range(seg):
        for i in range(seg):
            a = base + j * (seg + 1) + i; b = a + seg + 1
            m.t += [(a, a + 1, b + 1), (a, b + 1, b)]


TWIGC = (0.4, 0.33, 0.27)
TPL = []          # (name, L0 mesh, L1 mesh)
TPLI = {}


def template(name, l0, l1):
    TPLI[name] = len(TPL); TPL.append((name, l0, l1))


def build_templates():
    for cell in ('plane', 'maple', 'oak', 'redoak', 'birch', 'elm', 'cherry', 'shrub', 'spruce'):
        a = Mesh(); b = Mesh()
        tube(a, [Vector((0, 0, 0)), Vector((0.01, 0.3, 0.01)), Vector((0, 0.62, 0))], [0.022, 0.015, 0.006], 3, 'bk_smooth', TWIGC)
        droop = 0.3 if cell in ('birch', 'spruce', 'elm') else 0.2
        tcard(a, cell, (0, 0.6, 0.02), 1.0, 1.0, 0.0, 0.0, droop, 0.08)
        tcard(a, cell, (-0.2, 0.52, 0.06), 0.92, 0.95, -0.18, 0.95, droop * 0.7, 0.06, True, yaw=0.3)
        tcard(a, cell, (0.2, 0.5, 0.06), 0.92, 0.95, 0.14, -0.95, droop * 0.7, 0.06, False, yaw=-0.3)
        tcard(a, cell, (0, 0.42, -0.16), 0.9, 0.8, 1.1, 0.0, 0.1, 0.05, True, seg=1, shade=0.82)
        tcard(b, cell, (0, 0.6, 0.0), 1.0, 1.0, -0.12, 0.0, seg=1)
        tcard(b, cell, (-0.16, 0.52, 0.04), 0.95, 0.95, 0.0, 1.05, flip=True, seg=1)
        tcard(b, cell, (0.16, 0.5, 0.04), 0.95, 0.95, 0.0, -1.05, seg=1)
        template(cell, a, b)
    for cell in ('pine', 'cypress'):
        a = Mesh(); b = Mesh()
        for k in range(3): tcard(a, cell, (0, 0.5, 0), 0.9, 1.0, 0.0, k * pi / 3 + 0.2, 0.12, 0.1, k == 1)
        for k in range(2): tcard(b, cell, (0, 0.5, 0), 0.95, 1.0, 0.0, k * pi / 2 + 0.2, seg=1)
        template(cell, a, b)
    a = Mesh(); b = Mesh()
    for k in range(2): tcard(a, 'shrub', (0, 0.5, 0), 1.0, 1.0, 0.0, k * pi / 2, seg=1)
    tcard(b, 'shrub', (0, 0.5, 0), 1.0, 1.0, 0.0, 0.4, seg=1)
    template('sprig', a, b)

    # A fan leaf: a petiole a meter long, the blade pleated and drooping at the rim.
    for name, cell, leaf, sag in (('fan', 'fan', 1.0, 0.22), ('fandead', 'fandead', 0.5, 0.5)):
        u0, v0, u1, v1 = rect(cell)
        for lod in (0, 1):
            m = Mesh(); N = 14 if lod == 0 else 5; RG = 2 if lod == 0 else 1
            if lod == 0: tube(m, [Vector((0, 0, 0)), Vector((0, 0.55, 0.04)), Vector((0, 1.05, 0))], [0.035, 0.026, 0.02], 3, 'bk_smooth', (0.6, 0.62, 0.4) if leaf == 1 else (0.5, 0.42, 0.3))
            base = len(m.p)
            for r in range(RG + 1):
                rho = r / RG
                for i in range(N + 1):
                    ph = (i / N - 0.5) * 2.9
                    z = (0.045 if i % 2 else -0.045) * rho * (1 if lod == 0 else 0) - sag * rho ** 2 * (0.5 + 0.5 * abs(sin(ph)))
                    p = Vector((sin(ph) * rho * 0.82, 1.0 + cos(ph) * rho * 0.82, z))
                    uu = u0 + (u1 - u0) * (0.5 + 0.5 * rho * 0.96 * sin(ph)); vv = v1 - (v1 - v0) * (0.06 + 0.92 * rho * cos(ph) * 0.96 + 0.0)
                    vv = v1 - (v1 - v0) * (0.06 + 0.9 * max(-0.04, rho * cos(ph)))
                    m.vert(p, (0, 0, 1), (uu, vv), (1, 1, 1) if rho > 0 else (0.75, 0.75, 0.75), leaf)
            for r in range(RG):
                for i in range(N):
                    a = base + r * (N + 1) + i; b = a + N + 1
                    m.t += [(a, a + 1, b + 1), (a, b + 1, b)]
            if lod == 0: l0 = m
            else: l1 = m
        template(name, l0, l1)

    # A feather-palm frond: the rachis arches and every leaflet is its own quad (L0), or a folded strip (L1).
    lu0, lv0, lu1, lv1 = rect('leaflet'); fu0, fv0, fu1, fv1 = rect('frond')
    for name, L, arch in (('frond', 3.5, 0.5), ('frondup', 3.1, 0.2)):
        P = lambda t: Vector((0, L * t * (1 - 0.1 * arch * t), L * arch * (0.55 * t - 0.95 * t * t)))
        T = lambda t: (P(min(1, t + 0.01)) - P(max(0, t - 0.01))).normalized()
        a = Mesh()
        gu, gv = (lu0 + lu1) / 2, (lv0 + lv1) * 0.5 - (lv1 - lv0) * 0.375
        for i in range(9):
            t = i / 8; p = P(t); w = 0.035 * (1 - 0.8 * t)
            for s in (-1, 0, 1): a.vert(p + Vector((s * w, 0, -abs(s) * w)), (s * 0.7, 0, 0.7), (gu, gv), (0.8, 0.82, 0.6), 1.0)
        for i in range(8):
            for s in range(2):
                q = i * 3 + s; a.t += [(q, q + 1, q + 4), (q, q + 4, q + 3)]
        NL = 44
        for i in range(NL):
            t = 0.1 + 0.9 * i / (NL - 1); p = P(t); tg = T(t); ll = 0.62 * sin(pi * t ** 0.62) ** 0.7 + 0.1
            row = i % 4; va = lv0 + (lv1 - lv0) * (row * 0.25 + 0.02); vb = lv0 + (lv1 - lv0) * (row * 0.25 + 0.23)
            for s in (1, -1):
                d = (Vector((s, 0, 0)) * 0.72 + tg * (0.5 + 0.4 * t) + Vector((0, 0, 0.3))).normalized()
                wv = tg * 0.03 + Vector((0, 0, 0.012))
                e = p + d * ll - Vector((0, 0, 0.12 * ll))
                n = d.cross(tg) * s
                b = len(a.p); sh = 0.8 + 0.2 * t
                a.vert(p - wv, n, (lu0, vb), (sh * 0.8,) * 3, 1.0); a.vert(p + wv, n, (lu0, va), (sh * 0.8,) * 3, 1.0)
                a.vert(e + wv * 0.3, n, (lu1, va), (sh,) * 3, 1.0); a.vert(e - wv * 0.3, n, (lu1, vb), (sh,) * 3, 1.0)
                a.t += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
        b = Mesh(); SG = 5
        for i in range(SG + 1):
            t = i / SG; p = P(t); tg = T(t); ll = 0.62
            for s in (-1, 0, 1):
                q = p + Vector((s * ll * 0.8, 0, abs(s) * (0.3 * ll - 0.1)))
                b.vert(q, (s * 0.4, 0, 0.9), (fu0 + (fu1 - fu0) * t, fv0 + (fv1 - fv0) * (0.5 + 0.5 * s)), (0.8 + 0.2 * t,) * 3, 1.0)
        for i in range(SG):
            for s in range(2):
                q = i * 3 + s; b.t += [(q, q + 1, q + 4), (q, q + 4, q + 3)]
        template(name, a, b)


# ── Trees ─────────────────────────────────────────────────────────────────────
class Tree:
    def __init__(self): self.w0 = Mesh(); self.w1 = Mesh(); self.tips = []; self.midstep = 2; self.midscale = 1.42; self.far = True

    def tip(self, pos, d, scale, roll, ao, tpl):
        self.tips.append((tuple(pos), tuple(d.normalized()), scale, roll, ao, TPLI[tpl]))


def trunk_flare(n_lobes, amt, ph, ys):
    return lambda i, a: 1 + amt * exp(-max(ys[i], 0) / 0.42) * (0.6 + 0.4 * cos(n_lobes * a + ph)) + (0.25 * amt if ys[i] < 0 else 0)


def broadleaf(sp, seed):
    rng = random.Random(seed); T = Tree()
    k = rng.uniform(0.93, 1.07)
    H = sp['h'] * k; fork = sp['fork'] * rng.uniform(0.9, 1.1); r0 = sp['r0'] * rng.uniform(0.92, 1.1)
    R = Vector(sp['R']) * k
    lean = Vector((rng.uniform(-1, 1), 0, rng.uniform(-1, 1))) * sp.get('lean', 0.25)
    C = Vector((lean.x, H - R.y * 0.95, lean.z))
    leader = sp.get('leader', False)
    top = (C.y + R.y * 0.25) if leader else fork
    NS = 9
    tp = []; tr = []; ts = []
    for i in range(NS + 1):
        f = i / NS; y = -0.3 + (top + 0.3) * f
        fy = max(y, 0) / top
        tp.append(Vector((lean.x * fy * fy + rng.uniform(-1, 1) * 0.07 * fy, y, lean.z * fy * fy + rng.uniform(-1, 1) * 0.07 * fy)))
        tr.append(r0 * (1 - (0.82 if leader else 0.3) * fy ** 1.3) + 0.012)
        ts.append(0.72 if y < 0.15 else (1.0 if y < fork else 0.7))
    fl = trunk_flare(rng.choice([4, 5, 6]), sp.get('flare', 0.5), rng.uniform(0, tau), [p.y for p in tp])
    bark = sp['bark']; tint = sp['tint']; cell = sp['cell']
    tube(T.w0, tp, tr, 12, bark, tint, ts, flare=fl, cap=not leader)
    tube(T.w1, tp[::3], tr[::3], 6, bark, tint, ts[::3], flare=fl if False else None, cap=not leader)

    def trunk_at(y):
        f = min(max((y + 0.3) / (top + 0.3), 0), 0.999) * NS; i = int(f)
        return tp[i].lerp(tp[i + 1], f - i), tr[i] + (tr[i + 1] - tr[i]) * (f - i)

    def env(P):
        q = P - C
        return sqrt((q.x / R.x) ** 2 + (q.y / R.y) ** 2 + (q.z / R.z) ** 2)

    ns = sp['ns']; nsec = sp['nsec']; ntw = sp['ntw']
    az0 = rng.uniform(0, tau)
    for i in range(ns):
        az = az0 + i * tau / (ns - 1 if ns > 3 else ns) + rng.uniform(-0.25, 0.25)
        crownTop = (i == 0 and ns > 3)
        el = 0.12 if crownTop else rng.uniform(sp['el'][0], sp['el'][1])
        dirp = Vector((sin(el) * cos(az), cos(el), sin(el) * sin(az)))
        Tg = C + Vector((dirp.x * R.x, dirp.y * R.y, dirp.z * R.z)) * (0.6 if not crownTop else 0.55)
        y0 = (fork + (top - fork) * rng.uniform(0.0, 0.85)) if leader else fork - rng.uniform(0.0, 0.35)
        if crownTop and leader: y0 = top - 0.2
        S, rt = trunk_at(y0)
        sprd = sp['spread'] * rng.uniform(0.8, 1.15)
        d0 = (Vector((cos(az), 0, sin(az))) * sin(sprd) + UP * cos(sprd)).normalized()
        if crownTop: d0 = UP.copy()
        pts = bez(S, d0, Tg, 6, rng, sp['gnarl'])
        rs = max(rt * (0.62 if not crownTop else 0.75), 0.04)
        rad = [rs * (1 - 0.6 * q / 6) for q in range(7)]
        tube(T.w0, pts, rad, 7, bark, tint, [0.74] + [0.62] * 6)
        tube(T.w1, pts[::3], rad[::3], 4, bark, tint, [0.66] * 3)
        out = (Tg - C).normalized()
        puff = R * sp.get('puff', 0.5)
        for j in range(nsec):
            t0 = 0.3 + 0.7 * (j + rng.random()) / nsec
            S2, tan = along(pts, t0); r2 = max(rs * (1 - 0.6 * t0) * 0.6, 0.022)
            v = (rand_unit(rng) + out * 0.7 + UP * 0.25).normalized()
            T2 = Tg + Vector((v.x * puff.x, v.y * puff.y, v.z * puff.z)) * rng.uniform(0.7, 1.0)
            e = env(T2)
            if e > 1: T2 = C + (T2 - C) / e
            d2 = (tan * 0.5 + (T2 - S2).normalized() * 0.6 + rand_unit(rng) * 0.25).normalized()
            p2 = bez(S2, d2, T2, 4, rng, sp['gnarl'] * 0.8)
            rad2 = [r2 * (1 - 0.7 * q / 4) + 0.008 for q in range(5)]
            tube(T.w0, p2, rad2, 5, bark, tint, [0.6] * 5)
            tube(T.w1, [p2[0], p2[2], p2[4]], [rad2[0], rad2[2], rad2[4]], 3, bark, tint, [0.55] * 3)
            for q in range(ntw):
                t = 0.25 + 0.75 * (q + rng.random()) / ntw
                last = q == ntw - 1
                base, tg2 = along(p2, 1.0 if last else t)
                d = tg2.copy() if last else (tg2 * 0.45 + rand_unit(rng) * 0.85 + (base - C).normalized() * 0.45).normalized()
                d.y -= sp.get('droop', 0.1) * rng.uniform(0.5, 1.5); d.normalize()
                s = sp['tip'] * rng.uniform(0.82, 1.2)
                qv = base + d * (0.6 * s) - C
                ee = min(1.0, sqrt((qv.x / R.x) ** 2 + (qv.y / R.y) ** 2 + (qv.z / R.z) ** 2))
                ao = (0.4 + 0.6 * ee ** 1.6) * (0.74 + 0.26 * min(1, max(0, qv.y / R.y * 0.5 + 0.5)))
                T.tip(base, d, s, rng.uniform(-0.7, 0.7), ao, cell)
    return T


def conifer(sp, seed):
    rng = random.Random(seed); T = Tree()
    H = sp['h'] * rng.uniform(0.9, 1.1); r0 = sp['r0'] * rng.uniform(0.92, 1.1); h0 = sp['h0'] * rng.uniform(0.85, 1.2)
    bark = sp['bark']; tint = sp['tint']; cell = sp['cell']; spruce = sp['kind'] == 'spruce'
    lx, lz = rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3)
    NS = 10
    tp = [Vector((lx * (i / NS) ** 2 + rng.uniform(-0.04, 0.04) * (i > 0), -0.3 + (H + 0.3) * i / NS, lz * (i / NS) ** 2)) for i in range(NS + 1)]
    tr = [r0 * (1 - 0.96 * (i / NS) ** 1.1) + 0.012 for i in range(NS + 1)]
    fl = trunk_flare(5, 0.4, rng.uniform(0, tau), [p.y for p in tp])
    tube(T.w0, tp, tr, 10, bark, tint, [0.72] + [1.0] * 3 + [0.7] * 7, flare=fl)
    tube(T.w1, tp[::2], tr[::2], 5, bark, tint, [0.8] * 6)

    def trunk_at(y):
        f = min(max((y + 0.3) / (H + 0.3), 0), 0.999) * NS; i = int(f)
        return tp[i].lerp(tp[i + 1], f - i), tr[i] + (tr[i + 1] - tr[i]) * (f - i)

    y = h0; w = 0
    while y < H - 0.6:
        f = (y - h0) / (H - h0)
        nb = rng.choice(sp['nb']); a0 = rng.uniform(0, tau)
        for b in range(nb):
            az = a0 + b * tau / nb + rng.uniform(-0.3, 0.3)
            if spruce: Lb = (sp['L'] * (1 - f) ** 0.85 + 0.35) * rng.uniform(0.85, 1.08)
            else: Lb = sp['L'] * (0.4 + 0.6 * sin(pi * min(1, f ** 0.75 * 1.05)) ** 0.8) * rng.uniform(0.55, 1.12)
            S, rt = trunk_at(y + rng.uniform(-0.15, 0.15))
            hz = Vector((cos(az), 0, sin(az)))
            if spruce: Tg = S + hz * Lb + UP * (-0.28 * Lb * (1 - f) + 0.05); d0 = (hz + UP * 0.25).normalized()
            else: Tg = S + hz * Lb + UP * (0.3 * Lb * (0.3 + f)); d0 = (hz + UP * (0.05 + 0.5 * f)).normalized()
            pts = bez(S, d0, Tg, 4, rng, 0.04)
            rb = max(min(rt * 0.5, 0.02 + 0.012 * Lb), 0.016)
            rad = [rb * (1 - 0.8 * q / 4) + 0.006 for q in range(5)]
            tube(T.w0, pts, rad, 5, bark, tint, [0.6] * 5)
            if b % 2 == 0: tube(T.w1, [pts[0], pts[2], pts[4]], [rad[0], rad[2], rad[4]], 3, bark, tint, [0.55] * 3)
            nt = max(2, int(Lb * sp['dens']))
            for q in range(nt):
                t = 0.28 + 0.72 * (q + 0.5) / nt if q < nt - 1 else 1.0
                base, tg = along(pts, t)
                side = tg.cross(UP).normalized() * (1 if q % 2 else -1)
                if q == nt - 1: d = (tg + UP * 0.15).normalized()
                elif spruce: d = (tg * 0.55 + side * 0.8 - UP * 0.12).normalized()
                else: d = (tg * 0.55 + side * 0.7 + UP * 0.38).normalized()
                s = sp['tip'] * rng.uniform(0.85, 1.2) * (0.75 + 0.35 * (1 - f) if spruce else 1)
                ao = (0.5 + 0.5 * t ** 1.3) * (0.7 + 0.3 * f)
                T.tip(base, d, s, rng.uniform(-0.5, 0.5), ao, cell)
        y += sp['dy'] * rng.uniform(0.85, 1.15) * (1 - 0.3 * f); w += 1
    top, _ = trunk_at(H - 0.9)
    for q in range(4):
        d = (UP + Vector((cos(q * 1.6), 0, sin(q * 1.6))) * (0.5 if q else 0)).normalized()
        T.tip(top + UP * (0.2 * q), d, sp['tip'] * 0.9, 0, 1.0, cell)
    return T


def cypress(seed):
    rng = random.Random(seed); T = Tree()
    H = rng.uniform(8.6, 10.4); RM = rng.uniform(0.82, 1.0)
    tint = (0.5, 0.42, 0.36)
    tp = [Vector((0, -0.3, 0)), Vector((0, 0.5, 0)), Vector((0.02, 3, 0.02)), Vector((0, H - 1, 0))]
    tube(T.w0, tp, [0.2, 0.15, 0.1, 0.02], 8, 'bk_fibre', tint, [0.7, 1, 0.6, 0.6], flare=trunk_flare(5, 0.45, 0.7, [p.y for p in tp]))
    tube(T.w1, tp, [0.2, 0.15, 0.1, 0.02], 4, 'bk_fibre', tint, [0.8] * 4)
    prof = lambda f: RM * min(1.0, 0.5 + f * 4.0) * (1 - f) ** 0.6 + 0.05
    y0 = 0.42
    # A dark core, so the gaps between sprays show shade and never daylight.
    u0, v0, u1, v1 = rect('hedge', 12)
    for m, sides, rings in ((T.w0, 8, 9), (T.w1, 5, 5)):
        base = len(m.p)
        for i in range(rings + 1):
            f = i / rings; r = prof(f) * 0.52 if i < rings else 0.01
            for j in range(sides + 1):
                a = tau * j / sides
                m.vert((cos(a) * r, y0 + 0.25 + f * (H - y0 - 0.7), sin(a) * r), (cos(a), 0.2, sin(a)), (u0 + (u1 - u0) * (j % 2), v0 + (v1 - v0) * (i % 2)), (0.3, 0.3, 0.3), 1.0)
        for i in range(rings):
            for j in range(sides):
                a = base + i * (sides + 1) + j; b = a + sides + 1
                m.t += [(a, a + 1, b + 1), (a, b + 1, b)]
    n = 250
    for i in range(n):
        f = ((i + rng.random()) / n) ** 1.15
        y = y0 + f * (H - y0 - 0.9); pr = prof(f)
        a = i * 2.39996 + rng.uniform(-0.3, 0.3); deep = rng.random() < 0.18
        rr = pr * (0.3 if deep else rng.uniform(0.42, 0.62))
        d = (Vector((cos(a), 0, sin(a))) * (0.42 + 0.3 * (1 - f)) + UP).normalized()
        s = (0.75 + 0.6 * pr) * rng.uniform(0.85, 1.15)
        ao = (0.55 if deep else rng.uniform(0.82, 1.0)) * (0.7 + 0.3 * f)
        T.tip(Vector((cos(a) * rr, y, sin(a) * rr)), d, s, rng.uniform(0, tau), ao, 'cypress')
    T.midstep = 3; T.midscale = 1.5
    return T


def shrub(seed):
    rng = random.Random(seed); T = Tree()
    R = Vector((rng.uniform(0.7, 0.9), rng.uniform(0.5, 0.7), rng.uniform(0.7, 0.9))); C = Vector((0, R.y * 0.95, 0))
    for i in range(5):
        a = i * 1.257 + rng.uniform(-0.3, 0.3); e = C + Vector((cos(a) * R.x * 0.55, 0.1, sin(a) * R.z * 0.55))
        pts = [Vector((cos(a) * 0.05, -0.1, sin(a) * 0.05)), (e * 0.5) + Vector((0, 0.1, 0)), e]
        tube(T.w0, pts, [0.03, 0.022, 0.01], 4, 'bk_smooth', (0.45, 0.38, 0.32), [0.6] * 3)
        if i < 2: tube(T.w1, pts, [0.03, 0.022, 0.01], 3, 'bk_smooth', (0.45, 0.38, 0.32), [0.6] * 3)
    n = 30
    for i in range(n):
        y = 1 - 1.5 * (i + 0.5) / n; a = i * 2.39996 + rng.uniform(-0.2, 0.2); hh = sqrt(max(0, 1 - y * y))
        d = Vector((hh * cos(a), y, hh * sin(a)))
        deep = i % 5 == 4
        P = C + Vector((d.x * R.x, d.y * R.y, d.z * R.z)) * (0.25 if deep else 0.5)
        dd = (d + UP * 0.5 + rand_unit(rng) * 0.3).normalized()
        T.tip(P, dd, rng.uniform(0.5, 0.68), rng.uniform(0, tau), (0.5 if deep else 0.75 + 0.25 * (d.y * 0.5 + 0.5)), 'shrub')
    T.midstep = 2; T.midscale = 1.45
    return T


def hedge(seed, loose):
    """A 2 m run along x. Clipped: a box with a leafy face and sprigs breaking its edges. Loose: all sprays."""
    rng = random.Random(seed); T = Tree(); T.far = False
    L, Hh, D = 1.0, (1.0 if loose else 1.15), (0.26 if loose else 0.36)
    u0, v0, u1, v1 = rect('hedge', 10)
    sh = 0.4 if loose else 1.0
    for m in (T.w0, T.w1):
        def face(pts, n, cols):
            b = len(m.p)
            for p, uv, c in zip(pts, ((u0, v1), (u1, v1), (u1, v0), (u0, v0)), cols): m.vert(p, n, uv, (c, c, c), 1.0)
            m.t += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
        lo, hi = 0.5 * sh, 0.95 * sh
        face([(-L, 0, D), (L, 0, D), (L, Hh, D), (-L, Hh, D)], (0, 0.2, 1), (lo, lo, hi, hi))
        face([(L, 0, -D), (-L, 0, -D), (-L, Hh, -D), (L, Hh, -D)], (0, 0.2, -1), (lo, lo, hi, hi))
        face([(L, 0, D), (L, 0, -D), (L, Hh, -D), (L, Hh, D)], (1, 0.2, 0), (lo, lo, hi, hi))
        face([(-L, 0, -D), (-L, 0, D), (-L, Hh, D), (-L, Hh, -D)], (-1, 0.2, 0), (lo, lo, hi, hi))
        face([(-L, Hh, D), (L, Hh, D), (L, Hh, -D), (-L, Hh, -D)], (0, 1, 0), (hi, hi, hi, hi))
    n = 44 if loose else 56
    for i in range(n):
        x = -L + 2 * L * (i + rng.random()) / n; f = rng.random()
        if f < 0.4: P = Vector((x, Hh - 0.05, rng.uniform(-D, D))); d = Vector((rng.uniform(-0.4, 0.4), 1, rng.uniform(-0.5, 0.5)))
        else:
            sg = 1 if f < 0.7 else -1; y = rng.uniform(0.1, Hh)
            P = Vector((x, y, D * sg * 0.9)); d = Vector((rng.uniform(-0.4, 0.4), rng.uniform(0.2, 1.0), sg * 0.9))
        ao = 0.62 + 0.38 * P.y / Hh
        if loose: T.tip(P - d.normalized() * 0.12, d, rng.uniform(0.45, 0.72), rng.uniform(0, tau), ao, 'shrub')
        else: T.tip(P - d.normalized() * 0.1, d, rng.uniform(0.2, 0.3), rng.uniform(0, tau), ao, 'sprig')
    T.midstep = 2; T.midscale = 1.3
    return T


def palm_trunk(kind, seed):
    rng = random.Random(seed); T = Tree()
    if kind == 'fan':
        H = 8.0; N = 26; tint = (0.84, 0.78, 0.68)
        cx = lambda f: 0.25 * sin(pi * f) * (1 if seed % 2 else -0.6)
        pts = []; rad = []; sh = []
        for i in range(N + 1):
            f = i / N; y = -0.3 + (H + 0.3) * f
            base = 0.165 + 0.15 * exp(-max(y, 0) * 1.6) + 0.02 * (1 - f)
            for dy, dr, s in ((0.0, 0.0, 0.6), (0.06, 0.02, 1.0)):
                pts.append(Vector((cx(f), y + dy, 0))); rad.append(base + dr); sh.append(s * (0.75 if y < 0.1 else 1))
        tube(T.w0, pts, rad, 10, 'bk_ring', tint, sh, vrep=0.42)
        tube(T.w1, pts[1::8] + [pts[-1]], rad[1::8] + [rad[-1]], 5, 'bk_ring', tint, [0.9] * (len(pts[1::8]) + 1), vrep=0.42)
        # The top two meters still carry the stubs of old fronds, criss-crossed.
        u0, v0, u1, v1 = rect('bk_boot', 8)
        for i in range(60):
            y = H - 0.05 - 2.2 * (i / 60) ** 1.2; a = i * 2.39996; f = y / H
            c = Vector((cx(f), y, 0)); d = Vector((cos(a), 0, sin(a))); s = d.cross(UP)
            r = 0.2; w = 0.09; ln = 0.34 * (1 - 0.5 * i / 60)
            b = len(T.w0.p); shd = 0.6 + 0.4 * rng.random()
            for q, (du, dv) in zip((c + d * r - s * w - UP * 0.1, c + d * r + s * w - UP * 0.1, c + d * (r + 0.12) + s * w * 0.6 + UP * ln, c + d * (r + 0.12) - s * w * 0.6 + UP * ln), ((0, 1), (0.33, 1), (0.33, 0.78), (0, 0.78))):
                T.w0.vert(q, d + UP * 0.3, (u0 + (u1 - u0) * du, v0 + (v1 - v0) * dv), (0.62 * shd, 0.5 * shd, 0.4 * shd))
            T.w0.t += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
    else:
        H = 4.0; tint = (0.66, 0.56, 0.46)
        prof = [(-0.3, 0.52), (0.0, 0.5), (0.25, 0.4), (0.8, 0.36), (1.6, 0.35), (2.4, 0.35), (3.2, 0.37), (3.6, 0.45), (3.85, 0.5), (4.0, 0.42)]
        pts = [Vector((0.03 * sin(y * 1.3), y, 0)) for y, _ in prof]
        tube(T.w0, pts, [r for _, r in prof], 14, 'bk_boot', tint, [0.7, 0.8] + [1.0] * 8, vrep=0.36)
        tube(T.w1, pts[1::2] + [pts[-1]], [r for _, r in prof][1::2] + [prof[-1][1]], 6, 'bk_boot', tint, [0.9] * 6, vrep=0.36)
        # Boots that stand proud of the trunk: a wedge a stub, spiralling.
        u0, v0, u1, v1 = rect('bk_boot', 8)
        for i in range(110):
            y = 0.5 + 3.5 * i / 110; a = i * 2.39996
            r = np.interp(y, [p[0] for p in prof], [p[1] for p in prof])
            d = Vector((cos(a), 0, sin(a))); s = d.cross(UP); c = Vector((0.03 * sin(y * 1.3), y, 0)); w = 0.1; shd = 0.7 + 0.3 * rng.random()
            b = len(T.w0.p)
            for q, (du, dv) in zip((c + d * (r - 0.02) - s * w, c + d * (r - 0.02) + s * w, c + d * (r + 0.1) + s * w * 0.7 + UP * 0.22, c + d * (r + 0.1) - s * w * 0.7 + UP * 0.22), ((0.5, 0.6), (0.83, 0.6), (0.83, 0.42), (0.5, 0.42))):
                T.w0.vert(q, d * 0.8 + UP * 0.6, (u0 + (u1 - u0) * du, v0 + (v1 - v0) * dv), (tint[0] * shd, tint[1] * shd, tint[2] * shd))
            T.w0.t += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
    return T


def palm_crown(kind, seed):
    rng = random.Random(seed); T = Tree(); T.midstep = 1; T.midscale = 1.0
    if kind == 'fan':
        tube(T.w0, [Vector((0, -0.5, 0)), Vector((0, 0, 0)), Vector((0, 0.5, 0)), Vector((0, 0.9, 0))], [0.2, 0.26, 0.2, 0.04], 8, 'bk_boot', (0.6, 0.56, 0.4), cap=False)
        tube(T.w1, [Vector((0, -0.5, 0)), Vector((0, 0.2, 0)), Vector((0, 0.9, 0))], [0.2, 0.26, 0.04], 4, 'bk_boot', (0.6, 0.56, 0.4))
        n = rng.randint(30, 36)
        for i in range(n):
            f = i / (n - 1); az = i * 2.39996 + rng.uniform(-0.2, 0.2)
            el = 1.35 - 1.75 * f ** 0.9 + rng.uniform(-0.1, 0.1)
            d = Vector((cos(az) * cos(el), sin(el), sin(az) * cos(el)))
            T.tip(Vector((d.x * 0.1, 0.3 + 0.3 * (1 - f), d.z * 0.1)), d, rng.uniform(0.95, 1.25), rng.uniform(-0.3, 0.3), 0.72 + 0.28 * (1 - f) if el > 0 else 0.62, 'fan')
        for i in range(rng.randint(12, 18)):
            az = i * 2.39996 + rng.uniform(-0.3, 0.3); el = -rng.uniform(1.0, 1.42)
            d = Vector((cos(az) * cos(el), sin(el), sin(az) * cos(el)))
            T.tip(Vector((d.x * 0.15, 0.1 - rng.uniform(0, 0.5), d.z * 0.15)), d, rng.uniform(0.85, 1.1), rng.uniform(-0.4, 0.4), rng.uniform(0.6, 0.85), 'fandead')
    else:
        tube(T.w0, [Vector((0, -0.3, 0)), Vector((0, 0.1, 0)), Vector((0, 0.6, 0)), Vector((0, 1.0, 0))], [0.42, 0.46, 0.3, 0.06], 10, 'bk_boot', (0.62, 0.52, 0.36))
        tube(T.w1, [Vector((0, -0.3, 0)), Vector((0, 0.3, 0)), Vector((0, 1.0, 0))], [0.42, 0.44, 0.06], 5, 'bk_boot', (0.62, 0.52, 0.36))
        n = rng.randint(34, 40)
        for i in range(n):
            f = i / (n - 1); az = i * 2.39996 + rng.uniform(-0.2, 0.2)
            el = 1.3 - 1.7 * f ** 0.85 + rng.uniform(-0.1, 0.1)
            d = Vector((cos(az) * cos(el), sin(el), sin(az) * cos(el)))
            T.tip(Vector((d.x * 0.25, 0.25 + 0.4 * (1 - f), d.z * 0.25)), d, rng.uniform(0.9, 1.12), rng.uniform(-0.25, 0.25), 0.68 + 0.32 * (1 - f), 'frondup' if f < 0.3 else 'frond')
    return T


def expand(tips, lod, step=1, scale=1.0):
    """Every tip's template, set in place. src/world/floraAssets.ts does exactly this at load."""
    m = Mesh()
    for i in range(0, len(tips), step):
        pos, d, s, roll, ao, ti = tips[i]
        tm = TPL[ti][1 + lod]; s *= scale
        d = Vector(d); P = Vector(pos)
        side = d.cross(UP)
        side = Vector((1, 0, 0)) if side.length < 1e-3 else side.normalized()
        up = side.cross(d)
        cr, sr = cos(roll), sin(roll)
        sx = side * cr + up * sr; uz = up * cr - side * sr
        b = len(m.p)
        for p, n, uv, c, lf in zip(tm.p, tm.n, tm.uv, tm.c, tm.leaf):
            m.vert(P + (sx * p[0] + d * p[1] + uz * p[2]) * s, sx * n[0] + d * n[1] + uz * n[2], uv, (c[0] * ao, c[1] * ao, c[2] * ao), lf)
        m.t += [(a + b, c + b, e + b) for a, c, e in tm.t]
    return m


def join(a, b):
    m = Mesh()
    for s in (a, b):
        o = len(m.p)
        m.p += s.p; m.n += s.n; m.uv += s.uv; m.c += s.c; m.leaf += s.leaf; m.t += [(x + o, y + o, z + o) for x, y, z in s.t]
    return m


BROAD = {
    'plane': dict(h=10.6, fork=3.5, r0=0.26, R=(2.8, 3.3, 2.8), ns=5, nsec=6, ntw=7, el=(0.75, 1.25), spread=0.6, gnarl=0.05, tip=0.82, cell='plane', bark='bk_plane', tint=(0.96, 0.94, 0.86), leader=True, flare=0.45, droop=0.12),
    'maple': dict(h=8.6, fork=2.4, r0=0.27, R=(3.2, 3.0, 3.2), ns=6, nsec=6, ntw=6, el=(0.8, 1.35), spread=0.75, gnarl=0.05, tip=0.8, cell='maple', bark='bk_furrow', tint=(0.6, 0.52, 0.46), flare=0.5, droop=0.1),
    'oak': dict(h=10.0, fork=2.6, r0=0.42, R=(4.7, 3.5, 4.7), ns=6, nsec=6, ntw=7, el=(0.95, 1.5), spread=1.0, gnarl=0.1, tip=0.98, cell='oak', bark='bk_furrow', tint=(0.5, 0.43, 0.37), flare=0.7, droop=0.05, puff=0.46),
    'cherry': dict(h=5.4, fork=1.6, r0=0.14, R=(2.5, 1.9, 2.5), ns=5, nsec=5, ntw=6, el=(0.8, 1.3), spread=0.85, gnarl=0.07, tip=0.62, cell='cherry', bark='bk_smooth', tint=(0.5, 0.36, 0.32), flare=0.3, droop=0.0),
    'birch': dict(h=11.0, fork=4.0, r0=0.15, R=(2.3, 3.7, 2.3), ns=6, nsec=5, ntw=6, el=(0.5, 1.0), spread=0.4, gnarl=0.04, tip=0.74, cell='birch', bark='bk_birch', tint=(1.0, 1.0, 0.98), leader=True, flare=0.25, droop=0.55, lean=0.7, puff=0.42),
    'sugarmaple': dict(h=12.0, fork=2.8, r0=0.33, R=(3.8, 4.3, 3.8), ns=6, nsec=6, ntw=7, el=(0.6, 1.25), spread=0.6, gnarl=0.05, tip=0.92, cell='maple', bark='bk_furrow', tint=(0.56, 0.5, 0.46), flare=0.55, droop=0.1),
    'redoak': dict(h=12.5, fork=3.2, r0=0.4, R=(4.4, 4.0, 4.4), ns=6, nsec=6, ntw=7, el=(0.8, 1.4), spread=0.85, gnarl=0.08, tip=1.0, cell='redoak', bark='bk_furrow', tint=(0.46, 0.42, 0.4), flare=0.6, droop=0.05),
    'elm': dict(h=14.0, fork=4.6, r0=0.4, R=(5.2, 3.6, 5.2), ns=6, nsec=6, ntw=7, el=(0.9, 1.35), spread=0.32, gnarl=0.05, tip=1.0, cell='elm', bark='bk_furrow', tint=(0.5, 0.46, 0.42), flare=0.65, droop=0.5, puff=0.44),
}
CONIFER = {
    'pine': dict(kind='pine', h=17.5, r0=0.32, h0=6.0, nb=[3, 4, 5], L=4.2, dy=1.45, dens=1.25, tip=1.25, cell='pine', bark='bk_pine', tint=(0.62, 0.54, 0.5)),
    'spruce': dict(kind='spruce', h=12.5, r0=0.22, h0=1.1, nb=[5, 6], L=2.9, dy=1.0, dens=1.5, tip=0.95, cell='spruce', bark='bk_fibre', tint=(0.5, 0.4, 0.36)),
}


def build_kinds():
    kinds = {}
    for name, sp in BROAD.items():
        for v in range(3): kinds['%s%d' % (name, v)] = broadleaf(sp, 100 + 17 * v + sum(map(ord, name)))
    for name, sp in CONIFER.items():
        for v in range(3): kinds['%s%d' % (name, v)] = conifer(sp, 300 + 13 * v + sum(map(ord, name)))
    for v in range(3): kinds['cypress%d' % v] = cypress(41 + v)
    for v in range(3): kinds['shrub%d' % v] = shrub(61 + v)
    kinds['hedge0'] = hedge(67, False); kinds['hedgeloose0'] = hedge(68, True); kinds['hedgeloose1'] = hedge(69, True)
    for v in range(2): kinds['palmtrunk%d' % v] = palm_trunk('fan', v)
    for v in range(3): kinds['palmcrown%d' % v] = palm_crown('fan', 53 + v)
    kinds['datetrunk0'] = palm_trunk('date', 0)
    for v in range(2): kinds['datecrown%d' % v] = palm_crown('date', 59 + v)
    return kinds


# ── The .glb, written by hand so it can be quantised ──────────────────────────
class Glb:
    def __init__(self):
        self.bin = bytearray(); self.views = []; self.acc = []; self.meshes = []; self.nodes = []

    def view(self, data, target=None, stride=None):
        while len(self.bin) % 4: self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target: v['target'] = target
        if stride: v['byteStride'] = stride
        self.bin += data; self.views.append(v)
        return len(self.views) - 1

    def accessor(self, view, ctype, count, typ, norm=False, mn=None, mx=None):
        a = {'bufferView': view, 'componentType': ctype, 'count': count, 'type': typ}
        if norm: a['normalized'] = True
        if mn is not None: a['min'] = mn; a['max'] = mx
        self.acc.append(a)
        return len(self.acc) - 1

    def mesh(self, name, m):
        n = len(m.p)
        P = np.array(m.p, np.float32); c = (P.min(0) + P.max(0)) / 2; h = np.maximum((P.max(0) - P.min(0)) / 2, 1e-4)
        q = np.zeros((n, 4), np.int16); q[:, :3] = np.round((P - c) / h * 32767)
        N = np.array(m.n, np.float32); N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        nq = np.zeros((n, 4), np.int8); nq[:, :3] = np.round(N * 127)
        uq = np.round(np.clip(np.array(m.uv, np.float32), 0, 1) * 65535).astype(np.uint16)
        cq = np.zeros((n, 4), np.uint8); cq[:, :3] = np.round(np.clip(np.array(m.c, np.float32), 0, 1) * 255); cq[:, 3] = np.round(np.array(m.leaf) * 255)
        idx = np.array(m.t, np.uint16 if n < 65536 else np.uint32).ravel()
        attrs = {
            'POSITION': self.accessor(self.view(q.tobytes(), 34962, 8), 5122, n, 'VEC3', True, [-32767] * 3, [32767] * 3),
            'NORMAL': self.accessor(self.view(nq.tobytes(), 34962, 4), 5120, n, 'VEC3', True),
            'TEXCOORD_0': self.accessor(self.view(uq.tobytes(), 34962, 4), 5123, n, 'VEC2', True),
            'COLOR_0': self.accessor(self.view(cq.tobytes(), 34962, 4), 5121, n, 'VEC4', True),
        }
        ia = self.accessor(self.view(idx.tobytes(), 34963), 5123 if n < 65536 else 5125, len(idx), 'SCALAR')
        self.meshes.append({'name': name, 'primitives': [{'attributes': attrs, 'indices': ia, 'mode': 4}]})
        self.nodes.append({'name': name, 'mesh': len(self.meshes) - 1, 'translation': [float(x) for x in c], 'scale': [float(x) for x in h]})

    def points(self, name, tips):
        n = len(tips)
        if not n: return          # a palm's trunk: the loader reads a missing node as no tips
        P = np.array([t[0] for t in tips], np.float32); D = np.array([t[1] for t in tips], np.float32)
        C = np.array([[t[2], t[3], t[4], t[5]] for t in tips], np.float32)
        attrs = {
            'POSITION': self.accessor(self.view(P.tobytes(), 34962), 5126, n, 'VEC3', False, [float(x) for x in P.min(0)], [float(x) for x in P.max(0)]),
            'NORMAL': self.accessor(self.view(D.tobytes(), 34962), 5126, n, 'VEC3'),
            'COLOR_0': self.accessor(self.view(C.tobytes(), 34962), 5126, n, 'VEC4'),
        }
        self.meshes.append({'name': name, 'primitives': [{'attributes': attrs, 'mode': 0}]})
        self.nodes.append({'name': name, 'mesh': len(self.meshes) - 1})

    def write(self, path, extras):
        while len(self.bin) % 4: self.bin.append(0)
        js = {
            'asset': {'version': '2.0', 'generator': 'Port Calamity tools/blender', 'extras': extras},
            'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
            'scene': 0, 'scenes': [{'nodes': list(range(len(self.nodes)))}], 'nodes': self.nodes, 'meshes': self.meshes,
            'accessors': self.acc, 'bufferViews': self.views, 'buffers': [{'byteLength': len(self.bin)}],
        }
        jb = json.dumps(js, separators=(',', ':')).encode()
        jb += b' ' * (-len(jb) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 28 + len(jb) + len(self.bin)))
            f.write(struct.pack('<II', len(jb), 0x4E4F534A)); f.write(jb)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942)); f.write(self.bin)


# ── Impostors and contact sheets ──────────────────────────────────────────────
def to_blender(name, m, mat, tint=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(m.p, [], m.t); me.update()
    uvl = me.uv_layers.new(name='UVMap')
    li = np.empty(len(me.loops), np.int32); me.loops.foreach_get('vertex_index', li)
    UV = np.array(m.uv, np.float32)[li]; UV[:, 1] = 1 - UV[:, 1]
    uvl.data.foreach_set('uv', UV.ravel())
    C = np.array(m.c, np.float32)
    if tint is not None:
        lf = (np.array(m.leaf) > 0.75)[:, None]
        C = np.where(lf, C * np.array(tint, np.float32), C)
    at = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', np.concatenate([C, np.ones((len(C), 1), np.float32)], 1).ravel())
    LF = np.repeat((np.array(m.leaf, np.float32) > 0.75).astype(np.float32)[:, None], 3, 1)
    at = me.color_attributes.new('Lf', 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', np.concatenate([LF, np.ones((len(LF), 1), np.float32)], 1).ravel())
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob


def atlas_material(path, lit):
    mat, nodes, links = new_mat('flora_lit' if lit else 'flora_flat')
    tex = nodes.new('ShaderNodeTexImage'); tex.image = bpy.data.images.load(path, check_existing=True)
    an = nodes.new('ShaderNodeAttribute'); an.attribute_name = 'Col'
    mul = nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'
    links.new(tex.outputs['Color'], mul.inputs[0]); links.new(an.outputs['Color'], mul.inputs[1])
    mat['attr_node'] = an.name
    cut = nodes.new('ShaderNodeMath'); cut.operation = 'GREATER_THAN'; cut.inputs[1].default_value = 0.42
    links.new(tex.outputs['Alpha'], cut.inputs[0])
    tr = nodes.new('ShaderNodeBsdfTransparent'); mix = nodes.new('ShaderNodeMixShader'); out = nodes.new('ShaderNodeOutputMaterial')
    if lit:
        sh = nodes.new('ShaderNodeBsdfDiffuse'); links.new(mul.outputs[0], sh.inputs['Color'])
    else:
        sh = nodes.new('ShaderNodeEmission'); links.new(mul.outputs[0], sh.inputs['Color'])
    links.new(cut.outputs[0], mix.inputs[0]); links.new(tr.outputs[0], mix.inputs[1]); links.new(sh.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs['Surface'])
    try: mat.surface_render_method = 'DITHERED'
    except Exception: pass
    return mat


FW, FH = 2048, 2048


def bake_far(sc, atlas_png, near):
    """Every kind from the front, from the side and from above, each scaled to fill its own cell."""
    mat = atlas_material(atlas_png, False)
    info = {}; obs = {}
    names = [n for n in near if near[n][1].far]
    for i, name in enumerate(names):
        m = near[name][0]
        P = np.array(m.p, np.float32); lf = np.array(m.leaf) > 0.25
        hw = float(np.abs(P[:, [0, 2]]).max()) * 1.02; H = float(P[:, 1].max()) * 1.02
        ly = P[lf, 1] if lf.any() else np.array([H * 2])
        info[name] = {'cell': i, 'hw': round(hw, 3), 'h': round(H, 3), 'cb': round(float(max(0.0, np.percentile(ly, 3)) / H), 3), 'yc': round(float(np.median(ly) / H) if lf.any() else 0.5, 3)}
        obs[name] = to_blender('far_' + name, m, mat)
    ortho_cam(sc, 4, 4, 8)
    passes = []
    # Views 3-5 are views 0-2 again, showing only which texels are leaf: the game tints those and leaves the bark alone.
    for view6 in range(6):
        view = view6 % 3
        if view6 == 3:
            an = mat.node_tree.nodes[mat['attr_node']]; an.attribute_name = 'Lf'
            for l in list(mat.node_tree.links):
                if l.to_node.type == 'EMISSION': mat.node_tree.links.remove(l)
            em = [n for n in mat.node_tree.nodes if n.type == 'EMISSION'][0]
            mat.node_tree.links.new(an.outputs['Color'], em.inputs['Color'])
        for i, name in enumerate(names):
            hw, H = info[name]['hw'], info[name]['h']
            if view < 2:
                slot = i * 2 + view; cx = (slot % 16) * 0.5 + 0.25; top = (slot // 16) * 1.0
                sx = (120 / 256) / (2 * hw); sy = (248 / 256) / H
                ox, oy = cx, 8 - top - 1.0 + 4 / 256
                # Mesh vertices are (x, y, z) in the game's frame; the camera looks down Blender's -Z with +Y up the picture.
                if view == 0: M = Matrix(((sx, 0, 0, ox), (0, sy, 0, oy), (0, 0, sx, 0), (0, 0, 0, 1)))
                else: M = Matrix(((0, 0, -sx, ox), (0, sy, 0, oy), (sx, 0, 0, 0), (0, 0, 0, 1)))
            else:
                cx = (i % 16) * 0.5 + 0.25; cy = 8 - 6.0 - (i // 16) * 0.5 - 0.25
                s = (120 / 256) / (2 * hw)
                M = Matrix(((s, 0, 0, cx), (0, 0, -s, cy), (0, s, 0, 0), (0, 0, 0, 1)))
            obs[name].matrix_world = M
        path = os.path.join(TMP, 'far%d.png' % view6)
        render_to(sc, path, FW, FH); passes.append(read_png(path))
    out = np.zeros((FH, FW, 4), np.uint8); lfm = np.zeros((FH, FW), np.uint8)
    for i in range(len(names)):
        for view in range(2):
            slot = i * 2 + view; x0 = (slot % 16) * 128; y0 = (slot // 16) * 256
            out[y0:y0 + 256, x0:x0 + 128] = passes[view][y0:y0 + 256, x0:x0 + 128]
            lfm[y0:y0 + 256, x0:x0 + 128] = passes[3 + view][y0:y0 + 256, x0:x0 + 128, 0]
        x0 = (i % 16) * 128; y0 = 1536 + (i // 16) * 128
        out[y0:y0 + 128, x0:x0 + 128] = passes[2][y0:y0 + 128, x0:x0 + 128]
        lfm[y0:y0 + 128, x0:x0 + 128] = passes[5][y0:y0 + 128, x0:x0 + 128, 0]
    alpha = out[..., 3]
    lfm = dilate(np.repeat(lfm[..., None], 3, 2), alpha, 12)[..., 0]
    save_img(dilate(out[..., :3], alpha, 12), os.path.join(MODELS, 'flora_far.webp'), 86)
    # Red: coverage. Green: how much of the texel is leaf.
    save_img(np.stack([alpha, lfm, np.zeros_like(alpha)], -1), os.path.join(MODELS, 'flora_far_mask.webp'), 90)
    for o in obs.values():
        me = o.data; bpy.data.objects.remove(o); bpy.data.meshes.remove(me)
    return info


SHEET_TINT = {'plane': (0.3, 0.42, 0.14), 'maple': (0.2, 0.36, 0.1), 'oak': (0.14, 0.27, 0.08), 'cherry': (0.95, 0.62, 0.7), 'birch': (0.75, 0.6, 0.08),
              'sugarmaple': (0.8, 0.25, 0.04), 'redoak': (0.2, 0.3, 0.08), 'elm': (0.2, 0.36, 0.1), 'pine': (0.12, 0.26, 0.14), 'spruce': (0.08, 0.2, 0.12),
              'cypress': (0.06, 0.16, 0.1), 'shrub': (0.16, 0.3, 0.1), 'hedge': (0.16, 0.3, 0.1), 'hedgeloose': (0.16, 0.3, 0.1), 'palmcrown': (0.24, 0.4, 0.12), 'datecrown': (0.2, 0.36, 0.12)}


def sheets(sc, atlas_png, near, mid):
    sc.render.film_transparent = False
    w = sc.world; bg = w.node_tree.nodes.get('Background')
    if bg: bg.inputs[0].default_value = (0.55, 0.68, 0.9, 1); bg.inputs[1].default_value = 0.9
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 4.0
    sun.rotation_euler = (0.9, 0.2, 0.7); sc.collection.objects.link(sun)
    mat = atlas_material(atlas_png, True)
    gm = bpy.data.materials.new('ground'); gm.diffuse_color = (0.2, 0.26, 0.14, 1)
    groups = [
        ('sheet-island', ['plane0', 'plane1', 'plane2', 'maple0', 'maple1', 'oak0', 'oak1', 'oak2', 'cherry0', 'cypress0', 'cypress1']),
        ('sheet-mainland', ['pine0', 'pine1', 'birch0', 'birch1', 'sugarmaple0', 'sugarmaple1', 'redoak0', 'spruce0', 'spruce1', 'elm0', 'elm1']),
        ('sheet-small', ['palmtrunk0', 'palmcrown0', 'palmcrown1', 'datetrunk0', 'datecrown0', 'shrub0', 'shrub1', 'hedge0', 'hedgeloose0', 'oak0:mid', 'pine0:mid', 'palmcrown0:mid']),
    ]
    cam = sc.camera
    for sheet, names in groups:
        made = []; x = 0.0; top = 0.0
        for nm in names:
            key, _, lod = nm.partition(':')
            m = (mid if lod else near)[key][0]
            P = np.array(m.p, np.float32); hw = float(np.abs(P[:, 0]).max()) + 0.5
            base = key.rstrip('0123456789')
            ob = to_blender('s_' + nm, m, mat, SHEET_TINT.get(base))
            x += hw
            ob.matrix_world = Matrix(((1, 0, 0, x), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
            x += hw; top = max(top, float(P[:, 1].max())); made.append(ob)
        gme = bpy.data.meshes.new('g'); gme.from_pydata([(-5, -30, 0), (x + 5, -30, 0), (x + 5, 30, 0), (-5, 30, 0)], [], [(0, 1, 2, 3)]); gme.materials.append(gm)
        g = bpy.data.objects.new('g', gme); sc.collection.objects.link(g); made.append(g)
        cam.data.ortho_scale = x + 1
        cam.location = (x / 2, -80, (x + 1) * 9 / 32 - 0.4 + 14); cam.rotation_euler = (math.radians(80), 0, 0)
        render_to(sc, os.path.join(SHOTS, sheet + '.png'), 1920, 1080)
        for o in made:
            me = o.data; bpy.data.objects.remove(o); bpy.data.meshes.remove(me)


def main():
    os.makedirs(TMP, exist_ok=True); os.makedirs(SHOTS, exist_ok=True); os.makedirs(MODELS, exist_ok=True)
    sc = reset_scene()
    atlas_png = build_atlas(sc)
    for o in list(bpy.data.objects): bpy.data.objects.remove(o)
    build_templates()
    kinds = build_kinds()
    near = {}; mid = {}
    g = Glb()
    for i, (name, l0, l1) in enumerate(TPL):
        g.mesh('tpl%d_L0' % i, l0); g.mesh('tpl%d_L1' % i, l1)
    for name, T in kinds.items():
        g.mesh(name + '_w0', T.w0); g.mesh(name + '_w1', T.w1); g.points(name + '_t', T.tips)
        near[name] = (join(T.w0, expand(T.tips, 0)), T)
        mid[name] = (join(T.w1, expand(T.tips, 1, T.midstep, T.midscale)), T)
        print('  %-14s near %5d  mid %5d tris, %3d tips' % (name, near[name][0].tris(), mid[name][0].tris(), len(T.tips)))
    info = bake_far(sc, atlas_png, near)
    extras = {'kinds': {n: dict(info.get(n, {'cell': -1}), ms=T.midstep, mk=T.midscale) for n, T in kinds.items()}, 'templates': [t[0] for t in TPL]}
    out = os.path.join(MODELS, 'flora2.glb')
    g.write(out, extras)
    if 'sheets' in ARGS: sheets(sc, atlas_png, near, mid)
    for f in ('flora2.glb', 'flora_atlas.webp', 'flora_mask.webp', 'flora_nrm.webp', 'flora_far.webp', 'flora_far_mask.webp'):
        print('wrote %-22s %5d KB' % (f, os.path.getsize(os.path.join(MODELS, f)) // 1024))


main()
