# Tepid Falls' hero churches and schools, modelled in Blender by script and exported as .glb. Same conventions and helpers as
# tools/blender/campus.py (its header is the contract for the frame and the vertex alpha); the helpers are loaded from that file.
#
#   church_clap    a white clapboard meeting-house church: slate gable roof, arched windows, a front tower with a clock stage,
#                  a louvred belfry, an octagonal lantern and a tall white spire (after the old white village churches).
#   church_gothic  a red-brick Gothic church: buttressed nave, lancet windows in stained glass, a rose window, a corner tower
#                  with a stone belfry, pinnacles and a tall slate spire (after the big brick-and-stone city churches).
#   church_rom     a stone Romanesque church: ashlar courses, round-arched windows, a recessed portal, a square front tower with
#                  an arcaded belfry and a pyramid roof with four turrets.
#   school_elem    a brick elementary school: two floors of sash windows, a pedimented entrance pavilion, a hipped slate roof
#                  and a white cupola with a copper-green cap.
#   civic_hall     a brick town hall: pedimented pavilion, slate hip roof, a clock tower with a copper dome.
#   school_high    a large brick high school: a three-storey block with a six-column portico and pediment, long wings, and a
#                  clock tower (four lit clock faces, a belfry, a dome).
# (The City Hall with its clock tower, the post office with its columns and Our Lady, First Church and St. Dither's are already
#  Blender models in civic.glb, from buildings.py --civic; civicHero.ts is for the footprint churches, schools and halls.)
#
#   "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" --factory-startup --python tools/blender/civic_hero.py
#   (with its window showing, never --background)
#
# Writes, in public/models (CIVIC_OUT overrides the folder for a trial):
#   civic_hero.glb       <name>_0 <name>_1 <name>_2 for each of the five (near, street, far levels of detail)
#   civic_hero_far.glb   the _1 and _2 meshes only: what phones and the low preset fetch.
# Each model is centred on the middle of its plan (x, z) with y = 0 at the first floor and the footings 3 m below; the front is +z.
# The printed CIVIC_HERO_STATS carry each model's plan size (w x d, metres) for HERO in civicHero.ts.

import bpy, bmesh, sys, os, json, random
from math import sin, cos, pi, sqrt

_here = os.path.dirname(os.path.abspath(__file__))
_src = open(os.path.join(_here, 'campus.py'), encoding='utf-8').read().split('def library(')[0]
exec(compile(_src, 'campus_helpers', 'exec'))
OUT = os.environ.get('CIVIC_OUT') or os.path.join(ROOT, 'public', 'models')

LIME, COPPER, SLATE2 = 0xd8d2c0, 0x6f9f8f, 0x4a4d52
STONEC = 0x8d8676
GLASSES = [0x2d4f9a, 0x9a2f2f, 0xc99a2e, 0x2f7a4a, 0x6b3a8a, 0x3a7fa8]


def L(hex_, k=1.0):
    c = lin(hex_)
    return (c[0] * k, c[1] * k, c[2] * k)


def clapwall(W, u0, u1, y0, y1, lod, col=WHITE):
    """A white clapboard wall: a flat quad, and at the near level a board every 0.22 m."""
    W.quad(u0, u1, y0, y1, 0, col, 0.0)
    if lod == 0:
        y = y0 + 0.22
        while y < y1 - 0.1:
            W.box(u0, u1, y, y + 0.045, 0, 0.022, 0xdedacc, skip='b')
            y += 0.22


def ashlar(W, u0, u1, y0, y1, lod, base, seed):
    """Courses of stone blocks in slightly different greys."""
    if lod == 2:
        W.quad(u0, u1, y0, y1, 0, base, 0.0)
        return
    rnd = random.Random(seed)
    row = 0.6 if lod == 0 else 1.2
    y, r = y0, 0
    while y < y1 - 1e-6:
        y2 = min(y1, y + row)
        u = u0 - (0.6 if r % 2 else 0.0)
        while u < u1 - 1e-6:
            w = rnd.uniform(0.9, 1.7) * (1 if lod == 0 else 1.8)
            a, b = max(u0, u), min(u1, u + w)
            if b - a > 0.05: W.quad(a, b, y, y2, 0, L(base, rnd.uniform(0.82, 1.14)), 0.0)
            u += w
        y, r = y2, r + 1


def lancet(W, lod, uc, y0, w, h, hex_=GLASS, a=None, trim=LIME, tw=0.26):
    """A pointed (lancet) window or door opening with a stone surround."""
    if a is None: a = glass_alpha(W.m, W.m.rnd.random() < 0.3)
    ys = y0 + h * 0.62
    pts = [(uc - w / 2, y0), (uc + w / 2, y0), (uc + w / 2, ys), (uc + w / 4, ys + h * 0.27), (uc, y0 + h), (uc - w / 4, ys + h * 0.27), (uc - w / 2, ys)]
    W.poly([(u, y, 0.03) for u, y in pts], hex_, a)
    if lod == 2: return
    cu, cy = uc, y0 + h * 0.45
    k = 1 + 2 * tw / w
    q = [(cu + (u - cu) * k, cy + (y - cy) * (1 + 2 * tw / h)) for u, y in pts]
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        if i == 0: continue  # the sill is a box below
        W.poly([(pts[i][0], pts[i][1], 0.08), (pts[j][0], pts[j][1], 0.08), (q[j][0], q[j][1], 0.08), (q[i][0], q[i][1], 0.08)], trim)
    W.box(uc - w / 2 - tw, uc + w / 2 + tw, y0 - 0.16, y0, 0, 0.2, trim, skip='b')


def rose(W, lod, uc, yc, r, rnd):
    """A round stained-glass window: wedges of colour in a stone ring."""
    disc(W, lod, uc, yc, r + 0.28, LIME, 0.0, 0.02)
    n = 12 if lod == 0 else 8
    if lod == 2:
        disc(W, lod, uc, yc, r, 0x7a3a5a, 0.35, 0.04)
        return
    for i in range(n):
        a0, a1 = 2 * pi * i / n, 2 * pi * (i + 1) / n
        W.poly([(uc, yc, 0.04), (uc + r * cos(a0), yc + r * sin(a0), 0.04), (uc + r * cos(a1), yc + r * sin(a1), 0.04)],
               GLASSES[(i * 2 + rnd.randrange(2)) % len(GLASSES)], rnd.uniform(0.32, 0.38))
    if lod == 0:
        for i in range(n):
            a = 2 * pi * i / n
            W.box(uc + r * 0.5 * cos(a) - 0.03, uc + r * 0.5 * cos(a) + 0.03, yc + r * 0.5 * sin(a) - 0.03, yc + r * 0.5 * sin(a) + 0.03, 0.04, 0.08, LIME)
        disc(W, lod, uc, yc, r * 0.22, LIME, 0.0, 0.07)


def gable(m, x0, x1, z0, z1, y, rise, col, endcol, enda, ov, lod, trim=WHITE):
    """A gable roof with the ridge along z; the gable ends (z0 and z1) in `endcol`."""
    xm = (x0 + x1) / 2
    a0, a1, b0, b1 = x0 - ov, x1 + ov, z0 - ov, z1 + ov
    ins = (xm, y + rise * 0.3, (z0 + z1) / 2)
    m.face([(a0, y - 0.25, b0), (a0, y - 0.25, b1), (xm, y + rise, b1), (xm, y + rise, b0)], col, inside=ins)
    m.face([(a1, y - 0.25, b0), (a1, y - 0.25, b1), (xm, y + rise, b1), (xm, y + rise, b0)], col, inside=ins)
    for z, s in ((z1, 1), (z0, -1)):
        m.face([(x0, y, z), (x1, y, z), (xm, y + rise * 0.96, z)], endcol, enda, n=(0, 0, s))
        if lod < 2:
            for sx in (-1, 1):
                ex = x0 - ov if sx < 0 else x1 + ov
                m.face([(ex, y - 0.25, z + s * 0.1), (ex + (0.35 if sx < 0 else -0.35), y - 0.25, z + s * 0.1), (xm, y + rise + 0.2, z + s * 0.1), (xm, y + rise - 0.15, z + s * 0.1)], trim, n=(0, 0, s))
            m.box(x0 - ov, x1 + ov, y - 0.45, y - 0.15, z + (0.0 if s > 0 else -0.5), z + (0.5 if s > 0 else 0.0), trim, skip='b')


def pinnacle(m, cx, cz, y0, h, r, col, n=4):
    m.cone(cx, cz, y0, y0 + h, r, 0.0, n, col, pi / n)


def tower_box(m, lod, cx, cz, hx, hz, y0, y1, fn):
    """Four walls of a tower, each drawn by fn(wall, u0, u1, face_name); no box faces are made, so nothing doubles."""
    for kind, plane, n, u0, u1, name in (('z', cz + hz, 1, cx - hx, cx + hx, 'f'), ('z', cz - hz, -1, cx - hx, cx + hx, 'k'),
                                         ('x', cx + hx, 1, cz - hz, cz + hz, 'r'), ('x', cx - hx, -1, cz - hz, cz + hz, 'l')):
        fn(Wall(m, kind, plane, n), u0, u1, name)
    m.face([(cx - hx, y1, cz - hz), (cx + hx, y1, cz - hz), (cx + hx, y1, cz + hz), (cx - hx, y1, cz + hz)], 0x77746e, n=(0, 1, 0))


# ── church_clap ──────────────────────────────────────────────────────────────

def church_clap(lod):
    m = Mesh(31)
    X, Z0, Z1, B, EY = 6.0, -11.0, 11.0, 0.6, 7.2
    m.box(-X - 0.3, X + 0.3, -3, B, Z0 - 0.3, Z1 + 0.3, GRANITE)
    for s in (1, -1):
        W = Wall(m, 'x', X * s, s)
        clapwall(W, Z0, 7.6, B, EY, lod)
        for zc in (-8.0, -4.6, -1.2, 2.2, 5.6): arch_window(W, lod, zc, B + 1.2, 1.3, 4.6)
        clapwall(W, 7.6, Z1, B, EY, lod)
        if lod == 0:
            for zc in (-8.0, -4.6, -1.2, 2.2, 5.6):      # dark green shutters
                for t in (-1, 1): W.box(zc + t * 1.0 - 0.18, zc + t * 1.0 + 0.18, B + 1.4, B + 5.6, 0, 0.08, 0x2c4a3a)
    Wb = Wall(m, 'z', Z0, -1)
    clapwall(Wb, -X, X, B, EY, lod)
    arch_window(Wb, lod, 0.0, B + 1.8, 1.5, 4.8)
    Wf = Wall(m, 'z', Z1, 1)
    clapwall(Wf, -X, X, B, EY, lod)
    for s in (-1, 1): arch_window(Wf, lod, s * 4.3, B + 1.4, 1.2, 4.2)
    gable(m, -X, X, Z0, Z1, EY, 4.4, SLATE, WHITE, 0.0, 0.55, lod)
    # the tower, standing 1.6 m out of the front wall
    tz0, tz1, th = Z1 - 1.0, Z1 + 1.6, 14.0
    cz = (tz0 + tz1) / 2

    def stage(Wt, u0, u1, name):
        clapwall(Wt, u0, u1, B, th, lod)
        if name == 'f':
            Wt.quad(-1.0, 1.0, B, B + 2.9, 0.05, 0x2b4a38)
            arch_window(Wt, lod, 0.0, B + 3.0, 2.0, 1.5, lit=True)
            arch_window(Wt, lod, 0.0, B + 5.4, 1.5, 3.4, lit=True)
            clock(Wt, lod, 0.0, th - 2.0, 1.2, m)
        else:
            arch_window(Wt, lod, (u0 + u1) / 2, B + 5.4, 1.2, 3.4, lit=False)
    tower_box(m, lod, 0.0, cz, 2.5, 1.3, B, th, stage)
    m.box(-3.0, 3.0, th, th + 0.5, tz0 - 0.5, tz1 + 0.5, WHITE, skip='b')
    y0, y1 = th + 0.5, th + 4.4
    bz = 1.9

    def belfry(Wt, u0, u1, name):
        clapwall(Wt, u0, u1, y0, y1, lod)
        arch_window(Wt, lod, (u0 + u1) / 2, y0 + 0.8, 1.5, 2.8, lit=False, surround=0.14)
    tower_box(m, lod, 0.0, cz, bz, bz, y0, y1, belfry)
    m.box(-bz - 0.4, bz + 0.4, y1, y1 + 0.45, cz - bz - 0.4, cz + bz + 0.4, WHITE, skip='b')
    n = 8 if lod < 2 else 4
    m.cone(0.0, cz, y1 + 0.45, y1 + 2.6, 1.8, 1.7, n, WHITE, pi / n)
    m.cone(0.0, cz, y1 + 2.6, y1 + 3.0, 2.2, 1.75, n, WHITE, pi / n)
    top = y1 + 3.0 + 10.5
    m.cone(0.0, cz, y1 + 3.0, top, 1.75, 0.0, n, WHITE, pi / n)
    m.box(-0.05, 0.05, top - 0.5, top + 1.6, cz - 0.05, cz + 0.05, GOLD)
    if lod < 2: m.box(-0.4, 0.4, top + 0.7, top + 0.8, cz - 0.03, cz + 0.03, GOLD)
    return m


# ── church_gothic ────────────────────────────────────────────────────────────

def church_gothic(lod):
    m = Mesh(32)
    rnd = random.Random(7)
    X, Z0, Z1, B, EY = 7.0, -14.0, 14.0, 0.8, 10.5
    m.box(-X - 0.3, X + 0.3, -3, B, Z0 - 0.3, Z1 + 0.3, GRANITE)
    bz = [-11.6, -7.6, -3.6, 0.4, 4.4, 8.4]
    for s in (1, -1):
        W = Wall(m, 'x', X * s, s)
        W.quad(Z0, Z1, B, EY, 0, BRICK, 1.0)
        for zc in [-13.7] + bz + [13.7]:
            if lod < 2:
                W.box(zc - 0.35, zc + 0.35, B, EY - 0.5, 0, 0.8, BRICK, 1.0, skip='b')
                if lod < 2: W.box(zc - 0.45, zc + 0.45, EY - 0.55, EY - 0.35, 0, 0.95, LIME, skip='b')
        for zc in bz[:-1] + [10.4]:
            if zc > 12: continue
            lancet(W, lod, zc + 2.0 if zc != 10.4 else zc, B + 2.0, 1.5, 6.4, GLASSES[rnd.randrange(6)], rnd.uniform(0.32, 0.38))
        if lod < 2: W.box(Z0, Z1, EY - 0.3, EY, 0, 0.5, LIME, skip='b')
    Wb = Wall(m, 'z', Z0, -1)
    Wb.quad(-X, X, B, EY, 0, BRICK, 1.0)
    lancet(Wb, lod, 0.0, B + 3.0, 2.6, 7.0, GLASSES[1], 0.35)
    for s in (-1, 1): lancet(Wb, lod, s * 4.5, B + 3.0, 1.2, 5.0, GLASSES[2 if s > 0 else 4], 0.35)
    Wf = Wall(m, 'z', Z1, 1)
    Wf.quad(-X, X, B, EY, 0, BRICK, 1.0)
    lancet(Wf, lod, 0.6, B + 4.4, 2.6, 6.4, GLASSES[0], 0.35)
    lancet(Wf, lod, 0.6, B + 0.0, 2.2, 3.6, 0x3a2418, 0.0)
    gable(m, -X, X, Z0, Z1, EY, 6.4, SLATE, BRICK, 1.0, 0.5, lod, LIME)
    # rose windows in the gable ends
    rose(Wb, lod, 0.0, EY + 2.6, 1.5, rnd)
    # the corner tower, left of the front
    cx, cz, hh = -6.6, 12.4, 2.8
    ty = 23.5

    def shaft(Wt, u0, u1, name):
        Wt.quad(u0, u1, B, ty, 0, BRICK, 1.0)
        uc = (u0 + u1) / 2
        if name == 'f':
            lancet(Wt, lod, uc, B, 2.2, 4.0, 0x3a2418, 0.0)
            lancet(Wt, lod, uc, B + 5.6, 1.6, 5.2, GLASSES[3], 0.35)
            lancet(Wt, lod, uc, B + 13.6, 1.1, 3.6, GLASSES[5], 0.35)
            clock(Wt, lod, uc, ty - 3.2, 1.3, m)
        elif name in ('l', 'k'):
            lancet(Wt, lod, uc, B + 5.6, 1.3, 4.8, GLASSES[2], 0.35)
            lancet(Wt, lod, uc, B + 13.6, 1.0, 3.4, GLASSES[1], 0.35)
        if lod < 2:
            for yy in (B + 9.0, B + 17.0): Wt.box(u0 - 0.1, u1 + 0.1, yy, yy + 0.2, 0, 0.14, LIME, skip='b')
    tower_box(m, lod, cx, cz, hh, hh, B, ty, shaft)
    if lod < 2:
        for sx in (-1, 1):
            for sz in (-1, 1):
                m.box(cx + sx * hh - 0.38 + sx * 0.3, cx + sx * hh + 0.38 + sx * 0.3, B, 17.0, cz + sz * hh - 0.38 + sz * 0.3, cz + sz * hh + 0.38 + sz * 0.3, BRICK, 1.0, skip='t')
                m.box(cx + sx * hh - 0.45 + sx * 0.3, cx + sx * hh + 0.45 + sx * 0.3, 17.0, 17.3, cz + sz * hh - 0.45 + sz * 0.3, cz + sz * hh + 0.45 + sz * 0.3, LIME, skip='b')
    m.box(cx - hh - 0.3, cx + hh + 0.3, ty, ty + 0.5, cz - hh - 0.3, cz + hh + 0.3, LIME, skip='b')
    y0, y1 = ty + 0.5, ty + 5.2
    hb = 2.25

    def belfry(Wt, u0, u1, name):
        Wt.quad(u0, u1, y0, y1, 0, LIME, 0.0)
        lancet(Wt, lod, (u0 + u1) / 2, y0 + 0.5, 1.5, 3.9, DARK, 0.26, LIME, 0.16)
    tower_box(m, lod, cx, cz, hb, hb, y0, y1, belfry)
    m.box(cx - hb - 0.35, cx + hb + 0.35, y1, y1 + 0.5, cz - hb - 0.35, cz + hb + 0.35, LIME, skip='b')
    for sx in (-1, 1):
        for sz in (-1, 1): pinnacle(m, cx + sx * (hb + 0.1), cz + sz * (hb + 0.1), y1 + 0.5, 3.4, 0.5, LIME)
    n = 8 if lod < 2 else 4
    top = y1 + 0.5 + 12.5
    m.cone(cx, cz, y1 + 0.5, top, hb + 0.1, 0.0, n, SLATE2, pi / n)
    m.box(cx - 0.05, cx + 0.05, top - 0.6, top + 1.8, cz - 0.05, cz + 0.05, GOLD)
    m.box(cx - 0.4, cx + 0.4, top + 0.9, top + 1.0, cz - 0.03, cz + 0.03, GOLD)
    return m


# ── church_rom ───────────────────────────────────────────────────────────────

def church_rom(lod):
    m = Mesh(33)
    rnd = random.Random(9)
    X, Z0, Z1, B, EY = 8.0, -13.0, 13.0, 1.0, 9.6
    m.box(-X - 0.3, X + 0.3, -3, B, Z0 - 0.3, Z1 + 0.3, 0x6c6962)
    zs = [-9.6, -4.8, 0.0, 4.8]
    for s in (1, -1):
        W = Wall(m, 'x', X * s, s)
        ashlar(W, Z0, Z1, B, EY, lod, STONEC, 5 + s)
        for zc in zs: arch_window(W, lod, zc, B + 1.9, 1.7, 5.2)
        if lod < 2:
            for zc in [-12.4] + [z + 2.4 for z in zs] + [12.4]:
                W.box(zc - 0.3, zc + 0.3, B, EY - 0.3, 0, 0.35, 0x7d7869)
        if lod < 2: W.box(Z0, Z1, EY - 0.4, EY, 0, 0.5, 0x7d7869, skip='b')
        if lod == 0:
            for zc in [Z0 + 0.4 + i * 0.8 for i in range(int((Z1 - Z0) / 0.8))]:       # the arcaded corbel table
                W.box(zc - 0.18, zc + 0.18, EY - 0.75, EY - 0.4, 0, 0.3, 0x6c6962)
    Wb = Wall(m, 'z', Z0, -1)
    ashlar(Wb, -X, X, B, EY, lod, STONEC, 12)
    for xc in (-3.6, 0.0, 3.6): arch_window(Wb, lod, xc, B + 2.4, 1.5, 4.6)
    rose(Wb, lod, 0.0, EY + 1.7, 1.2, rnd)
    Wf = Wall(m, 'z', Z1, 1)
    ashlar(Wf, -X, X, B, EY, lod, STONEC, 14)
    for s in (-1, 1): arch_window(Wf, lod, s * 5.9, B + 1.8, 1.4, 4.8)
    gable(m, -X, X, Z0, Z1, EY, 3.8, SLATE, STONEC, 0.0, 0.5, lod, 0xcfc9b8)
    # the square front tower, 3 m out of the front wall
    cz, hh, ty = 12.5, 3.4, 17.6

    def shaft(Wt, u0, u1, name):
        ashlar(Wt, u0, u1, B, ty, lod, STONEC, 20 + ord(name))
        uc = (u0 + u1) / 2
        if name == 'f':
            for k, (w, h, sr) in enumerate(((3.2, 5.0, 0.4), (2.5, 4.4, 0.3))):
                arch_window(Wt, lod, uc, B, w, h, lit=False, surround=sr)
            arch_window(Wt, lod, uc - 2.5, B + 8.8, 0.7, 2.2, lit=True, surround=0.12)
            arch_window(Wt, lod, uc + 2.5, B + 8.8, 0.7, 2.2, lit=True, surround=0.12)
            clock(Wt, lod, uc, 13.4, 1.3, m)
        else:
            arch_window(Wt, lod, uc, B + 8.0, 0.8, 2.6, lit=True, surround=0.14)
    tower_box(m, lod, 0.0, cz, hh, hh, B, ty, shaft)
    m.box(-hh - 0.4, hh + 0.4, ty, ty + 0.5, cz - hh - 0.4, cz + hh + 0.4, 0x7d7869, skip='b')
    y0, y1 = ty + 0.5, ty + 5.4
    hb = 3.0

    def belfry(Wt, u0, u1, name):
        ashlar(Wt, u0, u1, y0, y1, lod, STONEC, 40 + ord(name))
        uc = (u0 + u1) / 2
        for d in (-0.95, 0.95): arch_window(Wt, lod, uc + d, y0 + 0.8, 1.3, 3.6, lit=False, surround=0.2)
    tower_box(m, lod, 0.0, cz, hb, hb, y0, y1, belfry)
    m.box(-hb - 0.5, hb + 0.5, y1, y1 + 0.5, cz - hb - 0.5, cz + hb + 0.5, 0x7d7869, skip='b')
    for sx in (-1, 1):
        for sz in (-1, 1):
            pinnacle(m, sx * (hb + 0.25), cz + sz * (hb + 0.25), y1 + 0.5, 4.2, 0.85, SLATE2, 8)
    top = y1 + 0.5 + 8.4
    m.cone(0.0, cz, y1 + 0.5, top, hb * 1.45, 0.0, 4, SLATE, pi / 4)
    m.box(-0.05, 0.05, top - 0.5, top + 1.6, cz - 0.05, cz + 0.05, GOLD)
    return m


# ── school_elem ──────────────────────────────────────────────────────────────

def cupola(m, lod, cx, cz, y, hs=1.6):
    m.box(cx - hs, cx + hs, y, y + 2.6, cz - hs, cz + hs, WHITE, skip='b')
    for kind, plane, n, uc in (('z', cz + hs, 1, cx), ('z', cz - hs, -1, cx), ('x', cx + hs, 1, cz), ('x', cx - hs, -1, cz)):
        arch_window(Wall(m, kind, plane, n), lod, uc, y + 0.4, 1.3, 1.9, lit=False, surround=0.12)
    m.box(cx - hs - 0.35, cx + hs + 0.35, y + 2.6, y + 3.0, cz - hs - 0.35, cz + hs + 0.35, WHITE, skip='b')
    n = 8 if lod < 2 else 4
    m.cone(cx, cz, y + 3.0, y + 5.8, hs + 0.3, 0.0, n, COPPER, pi / n)
    m.box(cx - 0.05, cx + 0.05, y + 5.4, y + 7.2, cz - 0.05, cz + 0.05, GOLD)


def school_elem(lod):
    m = Mesh(41)
    X, Z, Y0, FH, FL = 22.0, 8.0, 0.9, 3.9, 2
    EY = Y0 + FH * FL
    m.box(-X - 0.3, X + 0.3, -3, Y0, -Z - 0.3, Z + 0.3, GRANITE)
    facade(m, lod, 'z', Z, 1, -X, X, Y0, FH, FL, 11, skip={(0, 5), (1, 5)}, ww=1.4, wh=2.7)
    facade(m, lod, 'z', -Z, -1, -X, X, Y0, FH, FL, 11, ww=1.4, wh=2.7)
    facade(m, lod, 'x', X, 1, -Z, Z, Y0, FH, FL, 4, ww=1.4, wh=2.7)
    facade(m, lod, 'x', -X, -1, -Z, Z, Y0, FH, FL, 4, ww=1.4, wh=2.7)
    cornice(m, -X, X, -Z, Z, EY, lod, ov=0.5)
    hip_roof(m, -X, X, -Z, Z, EY, 2.6, SLATE, 0.5)
    # the entrance pavilion
    m.box(-3.7, 3.7, Y0, EY + 0.9, Z, Z + 1.5, BRICK, 1.0, skip='b')
    Wp = Wall(m, 'z', Z + 1.5, 1)
    Wp.quad(-1.1, 1.1, Y0, Y0 + 2.9, 0.05, 0x2c4a3a)
    arch_window(Wp, lod, 0.0, Y0 + 3.0, 2.2, 1.6, lit=True)
    arch_window(Wp, lod, 0.0, Y0 + FH + 1.0, 1.6, 2.8, lit=True, surround=0.2)
    if lod < 2:
        for s in (-1, 1): Wp.box(s * 3.45 - 0.25, s * 3.45 + 0.25, Y0, EY + 0.9, 0, 0.14, WHITE)
        Wp.box(-1.5, 1.5, Y0 + 2.9, Y0 + 3.0 + 1.6 + 0.3, 0, 0.0, WHITE) if False else None
    pediment(m, lod, 0.0, 3.5, EY + 0.9, 2.0, Z + 1.6, 1.8)
    steps(m, lod, 0.0, 2.2, Y0, Z + 1.5, 6, 0.4, 0.15)
    if lod < 2:
        cupola(m, lod, 0.0, 0.0, EY + 1.4, 1.6)
        for xc in (-14.0, 14.0): m.box(xc - 0.6, xc + 0.6, EY, EY + 3.8, -3.6, -2.4, BRICK, 1.0)
    else:
        m.box(-1.6, 1.6, EY + 1.4, EY + 4.0, -1.6, 1.6, WHITE)
        m.cone(0, 0, EY + 4.0, EY + 7.2, 1.9, 0.0, 4, COPPER, pi / 4)
    return m


# ── school_high ──────────────────────────────────────────────────────────────

def school_high(lod):
    m = Mesh(43)
    Y0, FH, FL = 1.0, 4.0, 3
    EY = Y0 + FH * FL
    CX, CZ, WX, WZ = 18.0, 16.0, 40.0, 12.0
    m.box(-WX - 0.3, WX + 0.3, -3, Y0, -WZ - 0.3, WZ + 0.3, GRANITE)
    m.box(-CX - 0.3, CX + 0.3, -3, Y0, -CZ - 0.3, CZ + 0.3, GRANITE)
    wh = 2.9
    facade(m, lod, 'z', CZ, 1, -CX, CX, Y0, FH, FL, 9, skip={(f, b) for f in range(3) for b in (3, 4, 5)}, ww=1.5, wh=wh)
    facade(m, lod, 'z', -CZ, -1, -CX, CX, Y0, FH, FL, 9, ww=1.5, wh=wh)
    for s in (1, -1):
        facade(m, lod, 'z', WZ, 1, CX if s > 0 else -WX, WX if s > 0 else -CX, Y0, FH, FL, 6, ww=1.5, wh=wh)
        facade(m, lod, 'z', -WZ, -1, CX if s > 0 else -WX, WX if s > 0 else -CX, Y0, FH, FL, 6, ww=1.5, wh=wh)
        facade(m, lod, 'x', WX * s, s, -WZ, WZ, Y0, FH, FL, 4, ww=1.5, wh=wh)
        facade(m, lod, 'x', CX * s, s, WZ, CZ, Y0, FH, FL, 1, ww=1.5, wh=wh)
        facade(m, lod, 'x', CX * s, s, -CZ, -WZ, Y0, FH, FL, 1, ww=1.5, wh=wh)
        # flat roofs on the wings
        x0, x1 = (CX, WX) if s > 0 else (-WX, -CX)
        cornice(m, x0, x1, -WZ, WZ, EY, lod, ov=0.4)
        m.box(x0, x1, EY - 0.1, EY + 0.1, -WZ, WZ, 0x4d4f52, skip='b')
        if lod < 2:
            m.box(x0 - 0.1, x1 + 0.1, EY, EY + 0.7, WZ - 0.25, WZ + 0.1, BRICK, 1.0, skip='b')
            m.box(x0 - 0.1, x1 + 0.1, EY, EY + 0.7, -WZ - 0.1, -WZ + 0.25, BRICK, 1.0, skip='b')
    # the centre: hipped slate roof, the columned portico, the doors
    cornice(m, -CX, CX, -CZ, CZ, EY, lod, ov=0.5)
    hip_roof(m, -CX, CX, -CZ, CZ, EY, 3.6, SLATE, 0.5)
    Wf = Wall(m, 'z', CZ, 1)
    for xc in (-3.0, 0.0, 3.0):
        Wf.quad(xc - 0.8, xc + 0.8, Y0, Y0 + 3.0, 0.05, 0x2c4a3a)
        arch_window(Wf, lod, xc, Y0 + 3.1, 1.6, 1.5, lit=True)
        arch_window(Wf, lod, xc, Y0 + FH + 0.9, 1.5, 3.0, lit=True)
        arch_window(Wf, lod, xc, Y0 + 2 * FH + 0.9, 1.5, 3.0)
    portico(m, lod, 0.0, 6.4, CZ, 4.8, Y0, 8.6, 6, 0.5, 2.7)
    steps(m, lod, 0.0, 6.0, Y0, CZ + 4.8, 7, 0.4, 0.14)
    # the clock tower on the roof
    cx, cz = 0.0, -2.0
    y0 = EY + 1.0
    hb = 2.5
    yb = y0 + 5.0

    def shaft(Wt, u0, u1, name):
        Wt.quad(u0, u1, y0, yb, 0, BRICK, 1.0)
        if lod < 2: window(Wt, lod, (u0 + u1) / 2, y0 + 1.6, 1.4, 2.4, lit=True)
    tower_box(m, lod, cx, cz, hb, hb, y0, yb, shaft)
    m.box(cx - hb - 0.4, cx + hb + 0.4, yb, yb + 0.6, cz - hb - 0.4, cz + hb + 0.4, WHITE, skip='b')
    y1 = yb + 0.6
    hc = hb * 0.86
    yc = y1 + 5.0

    def clockst(Wt, u0, u1, name):
        Wt.quad(u0, u1, y1, yc, 0, WHITE, 0.0)
        clock(Wt, lod, (u0 + u1) / 2, y1 + 2.7, 1.5, m)
    tower_box(m, lod, cx, cz, hc, hc, y1, yc, clockst)
    m.box(cx - hc - 0.45, cx + hc + 0.45, yc, yc + 0.6, cz - hc - 0.45, cz + hc + 0.45, WHITE, skip='b')
    y2 = yc + 0.6
    he = hc * 0.76
    ye = y2 + 4.0

    def bel(Wt, u0, u1, name):
        Wt.quad(u0, u1, y2, ye, 0, WHITE, 0.0)
        arch_window(Wt, lod, (u0 + u1) / 2, y2 + 0.6, 1.5, 3.0, lit=False, surround=0.16)
    tower_box(m, lod, cx, cz, he, he, y2, ye, bel)
    m.box(cx - he - 0.35, cx + he + 0.35, ye, ye + 0.5, cz - he - 0.35, cz + he + 0.35, WHITE, skip='b')
    n = 8 if lod < 2 else 4
    m.cone(cx, cz, ye + 0.5, ye + 2.2, he * 1.2, he * 0.9, n, COPPER, pi / n)
    top = ye + 0.5 + 6.0
    m.cone(cx, cz, ye + 2.2, top, he * 0.9, 0.0, n, COPPER, pi / n)
    m.box(cx - 0.05, cx + 0.05, top - 0.5, top + 2.0, cz - 0.05, cz + 0.05, GOLD)
    return m


# ── civic_hall ───────────────────────────────────────────────────────────────

def civic_hall(lod):
    """A town hall: two brick floors under a slate hip roof, a pedimented central pavilion, a clock tower with a copper dome."""
    m = Mesh(44)
    X, Z, Y0, FH, FL = 24.0, 12.0, 1.0, 4.4, 2
    EY = Y0 + FH * FL
    m.box(-X - 0.3, X + 0.3, -3, Y0, -Z - 0.3, Z + 0.3, GRANITE)
    facade(m, lod, 'z', Z, 1, -X, X, Y0, FH, FL, 9, skip={(f, 4) for f in range(2)}, ww=1.5, wh=3.1)
    facade(m, lod, 'z', -Z, -1, -X, X, Y0, FH, FL, 9, ww=1.5, wh=3.1)
    facade(m, lod, 'x', X, 1, -Z, Z, Y0, FH, FL, 4, ww=1.5, wh=3.1)
    facade(m, lod, 'x', -X, -1, -Z, Z, Y0, FH, FL, 4, ww=1.5, wh=3.1)
    cornice(m, -X, X, -Z, Z, EY, lod, ov=0.6)
    hip_roof(m, -X, X, -Z, Z, EY, 3.4, SLATE, 0.6)
    m.box(-5.2, 5.2, Y0, EY + 1.0, Z, Z + 1.8, BRICK, 1.0, skip='b')
    Wp = Wall(m, 'z', Z + 1.8, 1)
    for xc in (-3.2, 3.2):
        arch_window(Wp, lod, xc, Y0 + 0.5, 1.6, 3.4, lit=True, surround=0.22)
        arch_window(Wp, lod, xc, Y0 + FH + 0.5, 1.6, 3.4, lit=True, surround=0.22)
    Wp.quad(-1.1, 1.1, Y0, Y0 + 3.0, 0.05, 0x2c4a3a)
    arch_window(Wp, lod, 0.0, Y0 + 3.1, 2.2, 1.5, lit=True)
    arch_window(Wp, lod, 0.0, Y0 + FH + 0.5, 1.8, 3.4, lit=True, surround=0.24)
    if lod < 2:
        for sx in (-1, 1): Wp.box(sx * 5.0 - 0.3, sx * 5.0 + 0.3, Y0, EY + 1.0, 0, 0.14, WHITE)
        for yy in (Y0 + FH - 0.1,): Wp.box(-5.2, 5.2, yy, yy + 0.2, 0, 0.1, WHITE, skip='b')
    pediment(m, lod, 0.0, 5.0, EY + 1.0, 2.6, Z + 1.9, 2.1)
    steps(m, lod, 0.0, 3.4, Y0, Z + 1.8, 7, 0.4, 0.14)
    cx, cz, hb = 0.0, Z - 3.6, 2.3
    y0 = EY + 1.2
    yb = y0 + 4.0

    def shaft(Wt, u0, u1, name):
        Wt.quad(u0, u1, y0, yb, 0, BRICK, 1.0)
        if lod < 2 and name != 'k': window(Wt, lod, (u0 + u1) / 2, y0 + 0.8, 1.2, 2.2, lit=True)
    tower_box(m, lod, cx, cz, hb, hb, y0, yb, shaft)
    m.box(cx - hb - 0.4, cx + hb + 0.4, yb, yb + 0.6, cz - hb - 0.4, cz + hb + 0.4, WHITE, skip='b')
    y1 = yb + 0.6
    hc = hb * 0.88
    yc = y1 + 4.6

    def clockst(Wt, u0, u1, name):
        Wt.quad(u0, u1, y1, yc, 0, WHITE, 0.0)
        clock(Wt, lod, (u0 + u1) / 2, y1 + 2.4, 1.4, m)
    tower_box(m, lod, cx, cz, hc, hc, y1, yc, clockst)
    m.box(cx - hc - 0.45, cx + hc + 0.45, yc, yc + 0.5, cz - hc - 0.45, cz + hc + 0.45, WHITE, skip='b')
    y2 = yc + 0.5
    he = hc * 0.78
    ye = y2 + 3.4

    def bel(Wt, u0, u1, name):
        Wt.quad(u0, u1, y2, ye, 0, WHITE, 0.0)
        arch_window(Wt, lod, (u0 + u1) / 2, y2 + 0.5, 1.4, 2.6, lit=False, surround=0.15)
    tower_box(m, lod, cx, cz, he, he, y2, ye, bel)
    m.box(cx - he - 0.35, cx + he + 0.35, ye, ye + 0.45, cz - he - 0.35, cz + he + 0.35, WHITE, skip='b')
    n = 8 if lod < 2 else 4
    m.cone(cx, cz, ye + 0.45, ye + 2.4, he * 1.25, he * 0.8, n, COPPER, pi / n)
    top = ye + 0.45 + 4.8
    m.cone(cx, cz, ye + 2.4, top, he * 0.8, 0.0, n, COPPER, pi / n)
    m.box(cx - 0.05, cx + 0.05, top - 0.4, top + 2.2, cz - 0.05, cz + 0.05, GOLD)
    return m


MODELS = (('church_clap', church_clap), ('church_gothic', church_gothic), ('church_rom', church_rom),
          ('school_elem', school_elem), ('school_high', school_high), ('civic_hall', civic_hall))


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
    allo, far, stats = [], [], {'faces': {}, 'dims': {}}
    for ci, (name, fn) in enumerate(MODELS):
        shift = None
        for lod in (0, 1, 2):
            m = fn(lod)
            xs = [p[0] for p in m.v]; zs = [p[2] for p in m.v]; ys = [p[1] for p in m.v]
            if shift is None:
                shift = ((min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2)
                stats['dims'][name] = [round(max(xs) - min(xs), 2), round(max(zs) - min(zs), 2), round(max(ys), 1)]
            m.v = [(p[0] - shift[0], p[1], p[2] - shift[1]) for p in m.v]
            ob = m.to_object(f'{name}_{lod}', coll)
            ob.location = (ci * 100 - 200, -lod * 80, 0)
            vertex_ao(ob, rays=8 if lod == 0 else 5, reach=3.0)
            allo.append(ob)
            if lod > 0: far.append(ob)
            stats['faces'][f'{name}_{lod}'] = len(m.f)
            try: bpy.ops.wm.redraw_timer(type='DRAW_WIN_SWAP', iterations=1)
            except Exception: pass
    stats['hero_kB'] = export(allo, os.path.join(OUT, 'civic_hero.glb'))
    stats['far_kB'] = export(far, os.path.join(OUT, 'civic_hero_far.glb'))
    print('CIVIC_HERO_STATS ' + json.dumps(stats))
    os.makedirs(os.path.join(ROOT, 'scratch', 'q2-05'), exist_ok=True)
    with open(os.path.join(ROOT, 'scratch', 'q2-05', 'hero_meta.json'), 'w') as fh: json.dump(stats, fh, indent=1)


main()
if '--stay' not in sys.argv:
    sys.stdout.flush()
    os._exit(0)
