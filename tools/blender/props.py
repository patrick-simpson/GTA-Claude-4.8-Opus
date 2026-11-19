# Port Calamity's street furniture, modelled by script.
#
#   blender --background --factory-startup --python tools/blender/props.py
#
# Writes public/models/props.glb: one mesh per prop, in the GAME's frame (y up, standing on
# y = 0 at the origin, facing +z), to the same outside measurements as the stand-ins that
# src/world/ground.ts builds in code, because collision, the lamp's light pool and the
# sign faces all depend on them. Each vertex carries
#   POSITION    float
#   NORMAL      8-bit; smooth where two faces meet at under 38 degrees, creased elsewhere
#   COLOR_0     8-bit linear colour: the paint, times ambient occlusion baked by casting rays
#               at the model and the ground it stands on, times a little grime and wear
#   TEXCOORD_0  8-bit (roughness, metalness): the game's prop material reads its finish
#               per vertex, so one draw call holds paint, galvanised pipe, glass and timber
# There is no texture: the detail is geometry (bevels, bolts, flanges, rivets, seams) and
# the occlusion lives in the vertices, which costs nothing to draw.
#
# Blender is used for its ray caster (mathutils.bvhtree); every shape is built here, so
# nothing depends on an operator that changes between versions.

import sys, os, json, struct, math
import numpy as np
from math import sin, cos, pi, tau, sqrt
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'models', 'props.glb')

# ── Finishes: (hex, roughness, metalness) ─────────────────────────────────────
INK, BONE, VERM, MUST, TEAL, STEEL = 0x1e2b44, 0xf2e8cf, 0xe4572e, 0xf0a202, 0x2a9d8f, 0x9aa1a6


def fin(hexv, rough, metal):
    return (hexv, rough, metal)


BOLT = fin(0x6f757b, 0.42, 0.9)
CHROME = fin(0xc9ced2, 0.22, 0.95)


def lin(hexv):
    out = []
    for sh in (16, 8, 0):
        c = ((hexv >> sh) & 255) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


# ── Transforms ────────────────────────────────────────────────────────────────
def xform(x=0.0, y=0.0, z=0.0, rx=0.0, ry=0.0, rz=0.0, sx=1.0, sy=1.0, sz=1.0):
    """Scale, then turn about x, y, z in that order of application (three's XYZ Euler), then move."""
    cx, sx_ = cos(rx), sin(rx); cy, sy_ = cos(ry), sin(ry); cz, sz_ = cos(rz), sin(rz)
    RX = np.array([[1, 0, 0], [0, cx, -sx_], [0, sx_, cx]])
    RY = np.array([[cy, 0, sy_], [0, 1, 0], [-sy_, 0, cy]])
    RZ = np.array([[cz, -sz_, 0], [sz_, cz, 0], [0, 0, 1]])
    M = np.eye(4)
    M[:3, :3] = RX @ RY @ RZ @ np.diag([sx, sy, sz])
    M[:3, 3] = [x, y, z]
    return M


class Model:
    def __init__(self):
        self.V = []; self.F = []; self.FM = []; self.mats = []

    def add(self, prim, finish, M=None, **kw):
        V, F = prim
        V = np.asarray(V, float)
        if M is None: M = xform(**kw)
        V = V @ M[:3, :3].T + M[:3, 3]
        if finish not in self.mats: self.mats.append(finish)
        b = len(self.V); mi = self.mats.index(finish)
        self.V.extend(V.tolist())
        for f in F:
            self.F.append([b + i for i in f]); self.FM.append(mi)
        return self


# ── Shapes. Each returns (vertices, faces) with faces wound to face outward. ──
def lathe(profile, seg):
    """Turned about y. `profile` is (radius, height) pairs; walking it with the axis on your left, the surface faces right."""
    V = []; F = []
    n = len(profile)
    for r, y in profile:
        for j in range(seg):
            a = tau * j / seg
            V.append((r * cos(a), y, r * sin(a)))
    for i in range(n - 1):
        r0, r1 = profile[i][0], profile[i + 1][0]
        for j in range(seg):
            a, b, c, d = i * seg + j, i * seg + (j + 1) % seg, (i + 1) * seg + (j + 1) % seg, (i + 1) * seg + j
            if r0 < 1e-6 and r1 < 1e-6: continue
            if r0 < 1e-6: F.append((a, d, c))
            elif r1 < 1e-6: F.append((a, d, b))
            else: F.append((a, d, c, b))
    return V, F


def cyl(r, h, seg=12, bevel=0.0, r2=None):
    """A closed cylinder (or cone) on y = 0..h, its rims chamfered by `bevel`."""
    r2 = r if r2 is None else r2
    b = min(bevel, h / 3, r / 2)
    if b > 0: p = [(0, 0), (r - b, 0), (r, b), (r2, h - b), (r2 - b, h), (0, h)]
    else: p = [(0, 0), (r, 0), (r2, h), (0, h)]
    return lathe(p, seg)


def dome(r, h, seg=8, rings=3):
    """A rivet or a carriage-bolt head: a cap of height h on y = 0."""
    p = [(r * cos(pi / 2 * i / rings), h * sin(pi / 2 * i / rings)) for i in range(rings + 1)]
    p[-1] = (0, h)
    return lathe(p, seg)


def sphere(seg=16, rings=8):
    p = [(sin(pi * i / rings), -cos(pi * i / rings)) for i in range(rings + 1)]
    p[0] = (0, -1); p[-1] = (0, 1)
    return lathe(p, seg)


def rbox(w, h, d, r=0.01, k=2):
    """A box centred on the origin with every edge and corner rounded to radius r."""
    H = (w / 2, h / 2, d / 2)
    r = min(r, min(H) * 0.98)

    def line(Hh):
        a = [-Hh + r * i / k for i in range(k + 1)]
        return a + [-v for v in reversed(a)]
    V = []; F = []
    for ax in range(3):
        u, v = (ax + 1) % 3, (ax + 2) % 3
        lu, lv = line(H[u]), line(H[v])
        for s in (-1, 1):
            base = len(V)
            for a in lu:
                for b in lv:
                    p = [0.0, 0.0, 0.0]; p[ax] = s * H[ax]; p[u] = a; p[v] = b
                    c = [max(-(H[i] - r), min(H[i] - r, p[i])) for i in range(3)]
                    dv = [p[i] - c[i] for i in range(3)]
                    L = sqrt(sum(q * q for q in dv))
                    if L > 1e-9: p = [c[i] + dv[i] / L * r for i in range(3)]
                    V.append(tuple(p))
            nu, nv = len(lu), len(lv)
            for i in range(nu - 1):
                for j in range(nv - 1):
                    a, b, c, d = base + i * nv + j, base + (i + 1) * nv + j, base + (i + 1) * nv + j + 1, base + i * nv + j + 1
                    F.append((a, b, c, d) if s > 0 else (a, d, c, b))
    return V, F


def plate(w, h, t, cr=0.02, k=4):
    """A sheet in the xy plane, t thick about z = 0, its four corners rounded to cr (seen from +z)."""
    cr = min(cr, w / 2 * 0.98, h / 2 * 0.98)
    ring = []
    for q, (cx, cy) in enumerate([(w / 2 - cr, h / 2 - cr), (-(w / 2 - cr), h / 2 - cr), (-(w / 2 - cr), -(h / 2 - cr)), (w / 2 - cr, -(h / 2 - cr))]):
        for i in range(k + 1):
            a = pi / 2 * (q + i / k)
            ring.append((cx + cr * cos(a), cy + cr * sin(a)))
    n = len(ring)
    V = [(x, y, t / 2) for x, y in ring] + [(x, y, -t / 2) for x, y in ring] + [(0, 0, t / 2), (0, 0, -t / 2)]
    F = []
    for i in range(n):
        j = (i + 1) % n
        F.append((2 * n, i, j)); F.append((2 * n + 1, n + j, n + i)); F.append((i, n + i, n + j, j))
    return V, F


def tube(points, r, seg=8, steps=12, r_end=None, caps=True):
    """A round bar through `points` (Catmull-Rom), tapering to r_end if given."""
    P = [np.array(p, float) for p in points]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    path = []
    for i in range(1, len(P) - 2):
        for s in range(steps):
            t = s / steps
            path.append(0.5 * ((2 * P[i]) + (-P[i - 1] + P[i + 1]) * t + (2 * P[i - 1] - 5 * P[i] + 4 * P[i + 1] - P[i + 2]) * t * t + (-P[i - 1] + 3 * P[i] - 3 * P[i + 1] + P[i + 2]) * t ** 3))
    path.append(P[-2])
    n = len(path); V = []; F = []
    T0 = path[1] - path[0]; T0 /= np.linalg.norm(T0)
    N = np.cross(T0, [1, 0, 0]) if abs(T0[0]) < 0.9 else np.cross(T0, [0, 1, 0])
    N /= np.linalg.norm(N)
    for i in range(n):
        T = path[min(i + 1, n - 1)] - path[max(i - 1, 0)]; T /= np.linalg.norm(T)
        N = N - T * np.dot(N, T); N /= np.linalg.norm(N)
        B = np.cross(T, N)
        rr = r if r_end is None else r + (r_end - r) * i / (n - 1)
        for j in range(seg):
            a = tau * j / seg
            V.append(tuple(path[i] + rr * (cos(a) * N + sin(a) * B)))
    for i in range(n - 1):
        for j in range(seg):
            a, b, c, d = i * seg + j, i * seg + (j + 1) % seg, (i + 1) * seg + (j + 1) % seg, (i + 1) * seg + j
            F.append((a, b, c, d))
    if caps:
        V.append(tuple(path[0])); V.append(tuple(path[-1]))
        for j in range(seg):
            F.append((n * seg, (j + 1) % seg, j)); F.append((n * seg + 1, (n - 1) * seg + j, (n - 1) * seg + (j + 1) % seg))
    return V, F


def ring_of(m, prim, finish, count, radius, y, phase=0.0, **kw):
    for i in range(count):
        a = phase + tau * i / count
        m.add(prim, finish, x=radius * cos(a), y=y, z=radius * sin(a), **kw)


# ── The props ─────────────────────────────────────────────────────────────────
def hydrant():
    m = Model(); iron = fin(VERM, 0.62, 0.35); cap = fin(BONE, 0.6, 0.35)
    m.add(lathe([(0, 0), (0.2, 0), (0.205, 0.008), (0.205, 0.042), (0.197, 0.052), (0.15, 0.058)], 20), iron)
    ring_of(m, cyl(0.017, 0.022, 6, 0.004), BOLT, 8, 0.176, 0.05, 0.2)
    m.add(lathe([(0.15, 0.058), (0.136, 0.075), (0.13, 0.11), (0.126, 0.47), (0.132, 0.492), (0.166, 0.5), (0.17, 0.508), (0.17, 0.548),
                 (0.166, 0.556), (0.136, 0.566), (0.13, 0.61), (0.11, 0.66), (0.075, 0.7), (0.052, 0.712), (0.05, 0.722), (0.037, 0.726)], 20), iron)
    ring_of(m, cyl(0.013, 0.016, 6, 0.003), BOLT, 8, 0.152, 0.554, 0.4)
    # The operating nut is five-sided so that only the fire department's wrench fits it.
    m.add(lathe([(0.037, 0.722), (0.037, 0.785), (0.03, 0.8), (0, 0.8)], 5), iron)
    for s in (-1, 1):
        m.add(cyl(0.056, 0.2, 14, 0.004), iron, x=0, y=0.36, rz=-s * pi / 2)
        m.add(cyl(0.07, 0.05, 14, 0.008), cap, x=s * 0.19, y=0.36, rz=-s * pi / 2)
        m.add(cyl(0.026, 0.028, 4, 0.004), cap, x=s * 0.238, y=0.36, rz=-s * pi / 2)
    m.add(cyl(0.076, 0.2, 16, 0.004), iron, y=0.33, rx=pi / 2)
    m.add(cyl(0.09, 0.05, 16, 0.008), cap, y=0.33, z=0.19, rx=pi / 2)
    m.add(cyl(0.03, 0.03, 4, 0.004), cap, y=0.33, z=0.238, rx=pi / 2)
    # A cast band round the barrel, where the two halves of the mould met.
    m.add(lathe([(0.127, 0.268), (0.134, 0.274), (0.134, 0.286), (0.127, 0.292)], 20), iron)
    return m


def bin_():
    m = Model(); paint = fin(TEAL, 0.5, 0.3); band = fin(BONE, 0.5, 0.3)
    side = lambda y: 0.27 + 0.06 * (y - 0.03) / 0.83
    m.add(lathe([(0, 0.004), (0.25, 0.004), (0.27, 0.03), (0.33, 0.86), (0.352, 0.868), (0.364, 0.885), (0.366, 0.905), (0.36, 0.927), (0.345, 0.943),
                 (0.325, 0.95), (0.308, 0.943), (0.3, 0.925), (0.3, 0.62), (0, 0.62)], 24), paint)
    for y in (0.16, 0.36, 0.78):
        r = side(y)
        m.add(lathe([(r - 0.002, y - 0.016), (r + 0.011, y - 0.006), (r + 0.011, y + 0.006), (r - 0.002, y + 0.016)], 24), paint)
    m.add(lathe([(side(0.585) - 0.002, 0.583), (0.338, 0.59), (0.338, 0.7), (side(0.705) - 0.002, 0.707)], 24), band)
    # The seam of the rolled sheet, riveted, at the back.
    for y in (0.1, 0.24, 0.44, 0.52, 0.76, 0.84):
        m.add(dome(0.011, 0.006), BOLT, x=0, y=y, z=-(side(y) - 0.001), rx=-pi / 2)
    ring_of(m, rbox(0.07, 0.03, 0.07, 0.008), fin(0x15171c, 0.8, 0.2), 4, 0.21, 0.012, pi / 4)
    return m


def mailbox():
    m = Model(); blue = fin(0x27457a, 0.42, 0.15); dark = fin(0x16203a, 0.42, 0.15)
    for sx in (-0.2, 0.2):
        for sz in (-0.17, 0.17):
            m.add(rbox(0.05, 0.32, 0.05, 0.008), dark, x=sx, y=0.16, z=sz)
            m.add(rbox(0.1, 0.012, 0.1, 0.004, 1), dark, x=sx, y=0.006, z=sz)
            m.add(cyl(0.012, 0.012, 6, 0.003), BOLT, x=sx + 0.032 * (1 if sx > 0 else -1), y=0.012, z=sz)
    m.add(rbox(0.54, 0.64, 0.5, 0.03, 3), blue, y=0.62)
    # The barrel top, its axis across the box.
    m.add(cyl(0.25, 0.54, 28, 0.012), blue, x=0.27, y=0.93, rz=pi / 2)
    # The pull-down door, its hinge rod and its handle.
    m.add(rbox(0.46, 0.17, 0.02, 0.008), blue, y=0.985, z=0.228, rx=-0.42)
    m.add(tube([(-0.2, 0.9, 0.253), (0.2, 0.9, 0.253)], 0.009, 6, 1), dark)
    m.add(tube([(-0.12, 1.02, 0.218), (-0.12, 1.035, 0.262), (0.12, 1.035, 0.262), (0.12, 1.02, 0.218)], 0.011, 6, 5), CHROME)
    m.add(plate(0.4, 0.12, 0.008, 0.012), fin(BONE, 0.6, 0), y=0.66, z=0.253)
    m.add(plate(0.2, 0.09, 0.006, 0.008), fin(BONE, 0.6, 0), y=0.47, z=0.252)
    for sx in (-0.245, 0.245):
        for y in (0.36, 0.5, 0.64, 0.78):
            m.add(dome(0.008, 0.005, 6, 2), blue, x=sx, y=y, z=0.25, rx=pi / 2)
    return m


def bench():
    m = Model(); wood = fin(0xa8744a, 0.82, 0); iron = fin(INK, 0.62, 0.35)
    for i in range(4):
        m.add(rbox(1.7, 0.035, 0.105, 0.01), wood, y=0.44, z=-0.17 + i * 0.125)
    for i in range(2):
        m.add(rbox(1.7, 0.15, 0.03, 0.01), wood, y=0.64 + i * 0.2, z=-0.25 - i * 0.032, rx=-0.16)
    for x in (-0.72, 0.72):
        m.add(rbox(0.05, 0.44, 0.05, 0.008), iron, x=x, y=0.22, z=0.22)
        m.add(rbox(0.05, 0.98, 0.05, 0.008), iron, x=x, y=0.49, z=-0.27, rx=-0.1)
        m.add(rbox(0.05, 0.05, 0.54, 0.008), iron, x=x, y=0.4, z=-0.01)
        # The arm: up off the front leg, back in a flat curve and down into the back leg.
        m.add(tube([(x, 0.44, 0.22), (x, 0.62, 0.235), (x, 0.675, 0.16), (x, 0.665, -0.12), (x, 0.66, -0.3)], 0.024, 8, 5), iron)
        m.add(rbox(0.07, 0.022, 0.4, 0.008), iron, x=x, y=0.69, z=0.0)
        for z in (0.22, -0.32):
            m.add(rbox(0.09, 0.014, 0.09, 0.005, 1), iron, x=x, y=0.007, z=z)
        # A brace from the foot of the back leg to the seat rail.
        m.add(tube([(x, 0.06, -0.3), (x, 0.2, -0.12), (x, 0.38, 0.1)], 0.014, 6, 4), iron)
        for i in range(4):
            m.add(dome(0.011, 0.005, 6, 2), BOLT, x=x, y=0.4575, z=-0.17 + i * 0.125)
        for i in range(2):
            m.add(dome(0.011, 0.005, 6, 2), BOLT, x=x, y=0.64 + i * 0.2, z=-0.25 - i * 0.032 + 0.015, rx=pi / 2 - 0.16)
    return m


def post():
    m = Model(); galv = fin(STEEL, 0.46, 0.85); enamel = lambda h: fin(h, 0.42, 0.15)
    m.add(lathe([(0, 0), (0.09, 0), (0.092, 0.006), (0.092, 0.016), (0.062, 0.024), (0.046, 0.05), (0.04, 0.06), (0.04, 2.69), (0.036, 2.71), (0, 2.72)], 12), galv)
    ring_of(m, cyl(0.011, 0.016, 6, 0.003), BOLT, 4, 0.074, 0.014, pi / 4)
    m.add(plate(0.52, 0.62, 0.012, 0.045), enamel(MUST), y=2.03, z=0.066)
    # The pressed rim every sheet sign has, and the blade above it.
    m.add(plate(0.47, 0.57, 0.004, 0.03), enamel(0xf7b42a), y=2.03, z=0.073)
    m.add(plate(0.52, 0.13, 0.014, 0.02), enamel(INK), y=2.46, z=0.066)
    for y in (1.83, 2.23, 2.46):
        m.add(rbox(0.11, 0.035, 0.07, 0.006), galv, y=y, z=0.03)
        for sx in (-0.03, 0.03):
            m.add(dome(0.009, 0.005, 6, 2), BOLT, x=sx, y=y, z=0.073 if y > 2.4 else 0.0755, rx=pi / 2)
    return m


def news():
    m = Model(); body = fin(0xffffff, 0.42, 0.15)
    m.add(rbox(0.34, 0.14, 0.3, 0.012), fin(0x333333, 0.7, 0.3), y=0.07)
    for sx in (-0.13, 0.13):
        for sz in (-0.11, 0.11):
            m.add(cyl(0.012, 0.01, 6, 0.003), BOLT, x=sx, y=0.0, z=sz)
    m.add(rbox(0.46, 0.9, 0.4, 0.03, 3), body, y=0.59)
    m.add(rbox(0.49, 0.03, 0.43, 0.012), body, y=1.035)
    # The window: a frame standing proud of the door, and glass set back in it.
    for sx in (-0.18, 0.18): m.add(rbox(0.03, 0.38, 0.02, 0.006), body, x=sx, y=0.76, z=0.205)
    for dy in (-0.175, 0.175): m.add(rbox(0.39, 0.03, 0.02, 0.006), body, y=0.76 + dy, z=0.205)
    m.add(plate(0.34, 0.33, 0.004, 0.01), fin(0x1c2026, 0.12, 0), y=0.76, z=0.203)
    m.add(rbox(0.09, 0.15, 0.035, 0.008), fin(0x8c9096, 0.4, 0.9), x=0.15, y=0.46, z=0.212)
    m.add(rbox(0.035, 0.006, 0.012, 0.002, 1), fin(0x15171c, 0.6, 0.5), x=0.15, y=0.5, z=0.231)
    m.add(cyl(0.014, 0.012, 8, 0.003), CHROME, x=0.15, y=0.43, z=0.229, rx=pi / 2)
    m.add(tube([(-0.16, 0.5, 0.198), (-0.16, 0.5, 0.245), (0.02, 0.5, 0.245), (0.02, 0.5, 0.198)], 0.01, 6, 5), CHROME)
    for sx in (-0.2, 0.2): m.add(cyl(0.012, 0.05, 6, 0.003), BOLT, x=sx, y=0.3 if sx < 0 else 0.86, z=0.2, rx=pi / 2)
    return m


def lamp():
    m = Model(); paint = fin(INK, 0.5, 0.3)
    m.add(lathe([(0, 0), (0.2, 0), (0.205, 0.01), (0.205, 0.05), (0.19, 0.068), (0.152, 0.12), (0.132, 0.16), (0.126, 0.69), (0.132, 0.7), (0.132, 0.72),
                 (0.112, 0.76), (0.09, 0.82), (0.088, 0.84)], 16), paint)
    ring_of(m, cyl(0.022, 0.03, 6, 0.005), BOLT, 4, 0.168, 0.06, pi / 4)
    # The hand-hole cover on the kerb side of the base, held by two screws.
    m.add(rbox(0.1, 0.24, 0.012, 0.005), paint, y=0.42, z=-0.127)
    for dy in (-0.09, 0.09): m.add(dome(0.008, 0.004, 6, 2), BOLT, y=0.42 + dy, z=-0.133, rx=-pi / 2)
    m.add(lathe([(0.088, 0.84), (0.06, 6.21), (0.068, 6.22), (0.068, 6.25), (0.06, 6.26), (0.05, 6.3), (0, 6.31)], 12), paint)
    m.add(tube([(0, 6.25, 0), (0, 6.62, 0.35), (0, 6.68, 1.1), (0, 6.52, 1.72)], 0.045, 8, 6), paint)
    m.add(cyl(0.06, 0.16, 10, 0.006), fin(INK, 0.42, 0.3), y=6.535, z=1.66, rx=pi / 2 + 0.2)
    # The cobra head: a shell flattened underneath, and the lens hanging from it.
    V, F = sphere(18, 10)
    V = [(x * 0.24, max(y * 0.1, -0.055) + (0.035 * (1 - abs(z)) if y > 0 else 0), z * 0.5) for x, y, z in V]
    m.add((V, F), fin(INK, 0.42, 0.3), y=6.46, z=2.05)
    V, F = sphere(14, 6)
    V = [(x * 0.16, min(y, 0.0) * 0.055, z * 0.34) for x, y, z in V]
    m.add((V, F), fin(0xf6e7b4, 0.25, 0), y=6.404, z=2.1)
    m.add(cyl(0.028, 0.05, 8, 0.008), fin(0x8c9096, 0.4, 0.6), y=6.565, z=1.98)
    return m


PROPS = [('hydrant', hydrant, 0.5), ('bin', bin_, 0.5), ('mailbox', mailbox, 0.5), ('bench', bench, 0.5), ('post', post, 0.3), ('news', news, 0.5), ('lamp', lamp, 0.35)]


# ── Normals, occlusion, wear ──────────────────────────────────────────────────
def finish_model(m, wear):
    V = np.array(m.V, float)
    tris = []; tmat = []
    for f, mi in zip(m.F, m.FM):
        for k in range(1, len(f) - 1):
            a, b, c = f[0], f[k], f[k + 1]
            if np.linalg.norm(np.cross(V[b] - V[a], V[c] - V[a])) < 1e-12: continue
            tris.append((a, b, c)); tmat.append(mi)
    T = np.array(tris); tmat = np.array(tmat)
    fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
    area = np.linalg.norm(fn, axis=1, keepdims=True); fn /= area
    # Weld by position, then give each corner the average of the faces round it that lie within the crease angle.
    key = {}; wid = np.zeros(len(V), int)
    for i, p in enumerate(np.round(V / 2e-4).astype(np.int64)):
        wid[i] = key.setdefault((p[0], p[1], p[2]), len(key))
    around = [[] for _ in range(len(key))]
    for t, tri in enumerate(T):
        for v in tri: around[wid[v]].append(t)
    COS = cos(math.radians(38))
    out = {}; P = []; N = []; MI = []; I = []
    for t, tri in enumerate(T):
        for v in tri:
            w = wid[v]; n = np.zeros(3)
            for u in around[w]:
                if np.dot(fn[u], fn[t]) > COS: n += fn[u] * area[u]
            n /= np.linalg.norm(n)
            k = (w, tmat[t], int(round(n[0] * 60)), int(round(n[1] * 60)), int(round(n[2] * 60)))
            if k not in out:
                out[k] = len(P); P.append(V[v]); N.append(n); MI.append(tmat[t])
            I.append(out[k])
    P = np.array(P); N = np.array(N); MI = np.array(MI)
    # Occlusion: cosine-weighted rays from every vertex against the model and the pavement.
    G = 30.0
    bv = BVHTree.FromPolygons([tuple(p) for p in V] + [(-G, 0, -G), (G, 0, -G), (G, 0, G), (-G, 0, G)],
                              [tuple(int(i) for i in t) for t in T] + [(len(V), len(V) + 2, len(V) + 1), (len(V), len(V) + 3, len(V) + 2)])
    rng = np.random.default_rng(7); R = 28
    u1 = rng.random(R); u2 = rng.random(R)
    loc = np.stack([np.sqrt(u1) * np.cos(tau * u2), np.sqrt(u1) * np.sin(tau * u2), np.sqrt(1 - u1)], 1)
    ao = np.ones(len(P))
    for i in range(len(P)):
        n = N[i]; t = np.cross(n, [0, 1, 0] if abs(n[1]) < 0.9 else [1, 0, 0]); t /= np.linalg.norm(t); b = np.cross(n, t)
        o = Vector(P[i] + n * 0.004); hit = 0.0
        for l in loc:
            d = l[0] * t + l[1] * b + l[2] * n
            h = bv.ray_cast(o, Vector(d), 0.45)
            if h[0] is not None: hit += 1.0 - 0.6 * (h[3] / 0.45)
        ao[i] = 1 - hit / R
    C = np.zeros((len(P), 3)); PBR = np.zeros((len(P), 2))
    for mi, (hexv, rough, metal) in enumerate(m.mats):
        sel = MI == mi
        C[sel] = lin(hexv); PBR[sel] = (rough, metal)
    # Grime: road dirt thrown up the first hand's height, and a slow mottle so no panel is one flat colour.
    mott = 0.5 + 0.5 * np.sin(P[:, 0] * 23.1 + P[:, 1] * 17.3 + np.sin(P[:, 2] * 29.7 + P[:, 1] * 9.1) * 2.0)
    shade = (0.38 + 0.62 * ao ** 1.15) * (1 - wear * 0.12 * mott) * (1 - wear * 0.3 * np.clip(1 - P[:, 1] / 0.16, 0, 1) ** 2)
    C *= shade[:, None]
    PBR[:, 0] = np.clip(PBR[:, 0] + wear * (0.1 * mott + 0.25 * np.clip(1 - P[:, 1] / 0.16, 0, 1) + 0.2 * (1 - ao)), 0.05, 1)
    return P.astype(np.float32), N, C, PBR, np.array(I, np.uint32)


# ── The file ──────────────────────────────────────────────────────────────────
class Glb:
    def __init__(self): self.bin = bytearray(); self.views = []; self.acc = []; self.meshes = []; self.nodes = []

    def put(self, arr, ctype, typ, normalized=False, target=34962, minmax=False):
        while len(self.bin) % 4: self.bin.append(0)
        self.views.append({'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': arr.nbytes, 'target': target})
        if target == 34962 and arr.ndim == 2 and arr.itemsize * arr.shape[1] % 4: self.views[-1]['byteStride'] = 4
        raw = arr
        if 'byteStride' in self.views[-1]:
            raw = np.zeros((arr.shape[0], 4 // arr.itemsize), arr.dtype); raw[:, :arr.shape[1]] = arr
            self.views[-1]['byteLength'] = raw.nbytes
        self.bin += raw.tobytes()
        a = {'bufferView': len(self.views) - 1, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
        if normalized: a['normalized'] = True
        if minmax: a['min'] = [float(v) for v in arr.min(0)]; a['max'] = [float(v) for v in arr.max(0)]
        self.acc.append(a)
        return len(self.acc) - 1

    def mesh(self, name, P, N, C, PBR, I):
        at = {
            'POSITION': self.put(P, 5126, 'VEC3', minmax=True),
            'NORMAL': self.put(np.round(N * 127).astype(np.int8), 5120, 'VEC3', True),
            'COLOR_0': self.put(np.concatenate([np.round(np.clip(C, 0, 1) * 255), np.full((len(C), 1), 255)], 1).astype(np.uint8), 5121, 'VEC4', True),
            'TEXCOORD_0': self.put(np.round(np.clip(PBR, 0, 1) * 255).astype(np.uint8), 5121, 'VEC2', True),
        }
        idx = I.astype(np.uint16) if len(P) < 65536 else I
        ia = self.put(idx, 5123 if len(P) < 65536 else 5125, 'SCALAR', target=34963)
        self.meshes.append({'name': name, 'primitives': [{'attributes': at, 'indices': ia}]})
        self.nodes.append({'name': name, 'mesh': len(self.meshes) - 1})

    def write(self, path):
        while len(self.bin) % 4: self.bin.append(0)
        doc = {'asset': {'version': '2.0', 'generator': 'tools/blender/props.py'}, 'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
               'scene': 0, 'scenes': [{'nodes': list(range(len(self.nodes)))}], 'nodes': self.nodes, 'meshes': self.meshes,
               'accessors': self.acc, 'bufferViews': self.views, 'buffers': [{'byteLength': len(self.bin)}]}
        js = json.dumps(doc, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546c67, 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            f.write(struct.pack('<II', len(js), 0x4e4f534a)); f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004e4942)); f.write(bytes(self.bin))


def main():
    g = Glb()
    for name, build, wear in PROPS:
        P, N, C, PBR, I = finish_model(build(), wear)
        g.mesh(name, P, N, C, PBR, I)
        print('%-8s %5d verts %5d tris  box %s .. %s' % (name, len(P), len(I) // 3, np.round(P.min(0), 2).tolist(), np.round(P.max(0), 2).tolist()))
    g.write(OUT)
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')


main()
