# Port Calamity's people, modelled in Blender by script and exported as .glb.
#
#   blender --background --factory-startup --python tools/blender/people.py -- [f] [m] [--no-render] [--no-export] [--sheets a,b]
#
# Writes public/models/person_<f|m>.glb, the shared texture atlases public/models/people_*.webp
# and preview sheets shots/blender/person_<f|m>_<sheet>.jpg.
#
# Everything is authored in the GAME's frame (x = the person's left, y = up,
# z = forward, feet at y 0) and passed through B() into Blender's Z-up frame;
# the exporter's Y-up conversion lands it back where it started.
#
# A body is not one welded skin. It is a set of closed, smooth lofts (rings of
# a superellipse stacked along a limb) and grids that run into each other the
# way a jointed doll's parts do: the upper arm ends in a ball buried in the
# sleeve, the thigh in a ball buried in the trousers, the shoe swallows the
# shin. That is deliberate. Shoulders and hips are where a welded skin collapses
# when a limb swings through 150 degrees; a ball turning inside a sleeve cannot.
# Where the surface IS continuous (knee, elbow, waist, neck) the weights cross
# the joint over a few rings, two bones a vertex, never more.
#
# THE CONTRACT with src/ent/characterAssets.ts and character.ts:
#   Material names (MATS) are parts. The game colours each from the person's
#     Look and folds away the ones that person is not wearing, which is how one
#     mesh carries every face, haircut, garment and hat.
#   COLOR_0 is baked ambient occlusion times a tint (lips, lashes, soles).
#   COLOR_0's alpha is the surface class / 16: skin, cloth, leather,
#     rubber, hair, metal, eye, plastic; +8 when the vertex keeps its own colour
#     instead of taking the part's (buttons, soles, zips).
#   TEXCOORD_0 addresses the shared atlases (people_n.webp, people_m.webp).
#   Morph targets m0..m4 on LOD0 are shared slots. What a slot means depends on
#     where the vertex is: on the head jaw, nose, brow, age, blink; on the eyes
#     -, -, brow, look x, look y; on a hand fist, wheel grip, weapon grip.
# Bones (19): hips spine chest neck head, shoulder_ upperarm_ forearm_ hand_
# (l, r), thigh_ shin_ foot_ (l, r). Every bone's rest frame is the world's, so
# the game needs only each joint's position, which it reads from the file.
# The leg joints sit exactly where character.ts's stride solver believes they
# are (hip 0.90, knee 0.48, ankle 0.085, 0.092 off centre): move them here and
# the feet slide there.

import bpy, bmesh, sys, os, json
from math import sin, cos, pi, radians, sqrt, copysign, exp, acos, atan2
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MATS = ['head', 'body', 'arm', 'leg', 'eyewhite', 'iris', 'brow',
        'tee', 'shirt', 'hoodie', 'jacket', 'coverall', 'dress',
        'trousers', 'jeans', 'shorts', 'skirt', 'sneakers', 'boots',
        'hair_crop', 'hair_part', 'hair_long', 'hair_tail', 'hair_bun', 'hair_curls', 'hair_afro', 'hair_bald', 'beard', 'stubble',
        'cap', 'peak_f', 'peak_b', 'beanie', 'brimhat', 'glasses', 'bag', 'belt']
MI = {n: i for i, n in enumerate(MATS)}
# Which of a person's choices a part belongs to. Parts of one slot never see each other's shadow.
SLOT = {n: ('top' if n in ('tee', 'shirt', 'hoodie', 'jacket', 'coverall', 'dress') else
            'bottom' if n in ('trousers', 'jeans', 'shorts', 'skirt') else
            'shoes' if n in ('sneakers', 'boots') else
            'hair' if n.startswith('hair') else
            'hat' if n in ('cap', 'peak_f', 'peak_b', 'beanie', 'brimhat') else n) for n in MATS}
OCCLUDERS = ('head', 'body', 'tee', 'trousers', 'sneakers')
SKIN_C, CLOTH, LEATHER, RUBBER, HAIR_C, METAL, EYE_C, PLASTIC, FIXED = 0, 1, 2, 3, 4, 5, 6, 7, 8
CLS = {n: (SKIN_C if n in ('head', 'body', 'arm', 'leg') else EYE_C if n in ('eyewhite', 'iris') else
           HAIR_C if SLOT[n] == 'hair' or n in ('brow', 'beard', 'stubble') else
           LEATHER if n in ('boots', 'belt', 'bag') else PLASTIC if n == 'glasses' else CLOTH) for n in MATS}
# Preview colours only; the game supplies its own.
SKIN, HAIR, TOP, BOT = (0.50, 0.27, 0.17), (0.03, 0.015, 0.01), (0.012, 0.02, 0.05), (0.03, 0.05, 0.11)
PREVIEW = {n: (SKIN if CLS[n] == SKIN_C else HAIR if CLS[n] == HAIR_C else TOP if SLOT[n] == 'top' else BOT if SLOT[n] == 'bottom' else
               (0.75, 0.1, 0.03) if SLOT[n] == 'hat' else (0.05, 0.03, 0.02)) for n in MATS}
PREVIEW.update(eyewhite=(0.8, 0.78, 0.74), iris=(0.10, 0.05, 0.02), sneakers=(0.6, 0.6, 0.58), glasses=(0.01, 0.01, 0.01))

HIP_Y, KNEE_Y, ANKLE_Y, HIP_X = 0.90, 0.48, 0.085, 0.092
UPPER, FORE = 0.28, 0.24

BODY = {
    'm': dict(
        sh=0.185, sh_y=1.378, arm=1.0, leg=1.0, neck=0.056, head=1.0, hand=1.0, foot=1.0,
        face=dict(jaw=0.25, nose=0.15, brow=0.3, lip=0.0),
        # y, half width, front depth, back depth, centre z
        pants=[(0.80, 0.100, 0.085, 0.090, -0.005), (0.84, 0.158, 0.100, 0.105, -0.006), (0.90, 0.170, 0.105, 0.112, -0.008),
               (0.96, 0.163, 0.105, 0.100, -0.006), (1.00, 0.152, 0.102, 0.092, -0.004)],
        shirt=[(0.885, 0.178, 0.113, 0.118, -0.008), (0.94, 0.171, 0.112, 0.108, -0.006), (1.04, 0.150, 0.108, 0.094, -0.002),
               (1.14, 0.152, 0.112, 0.098, 0.0), (1.24, 0.160, 0.120, 0.104, 0.004), (1.33, 0.170, 0.114, 0.108, 0.0),
               (1.375, 0.180, 0.104, 0.102, -0.004), (1.412, 0.184, 0.090, 0.094, -0.006), (1.436, 0.160, 0.078, 0.086, -0.008), (1.453, 0.112, 0.068, 0.078, -0.009), (1.467, 0.068, 0.062, 0.068, -0.010)]),
    'f': dict(
        sh=0.160, sh_y=1.372, arm=0.92, leg=0.98, neck=0.052, head=0.965, hand=0.9, foot=0.92,
        face=dict(jaw=-0.45, nose=-0.4, brow=-0.6, lip=0.7),
        pants=[(0.80, 0.100, 0.080, 0.090, -0.005), (0.84, 0.160, 0.097, 0.108, -0.008), (0.90, 0.175, 0.101, 0.118, -0.010),
               (0.96, 0.158, 0.097, 0.100, -0.007), (1.01, 0.134, 0.090, 0.086, -0.004)],
        shirt=[(0.885, 0.183, 0.110, 0.125, -0.010), (0.94, 0.170, 0.106, 0.110, -0.007), (1.05, 0.128, 0.094, 0.086, -0.003),
               (1.14, 0.134, 0.100, 0.090, 0.0), (1.25, 0.146, 0.128, 0.096, 0.004), (1.31, 0.152, 0.118, 0.100, 0.002),
               (1.365, 0.157, 0.098, 0.094, -0.004), (1.405, 0.160, 0.084, 0.088, -0.006), (1.430, 0.138, 0.072, 0.080, -0.008), (1.448, 0.098, 0.064, 0.072, -0.009), (1.464, 0.060, 0.056, 0.062, -0.010)]),
}
# What a morph slot adds to the model's parameters (see the contract above).
SLOTS = [dict(jaw=1.0, fist=1.0), dict(nose=1.0, wheel=1.0), dict(brow=1.0, gun=1.0), dict(age=1.0, lookx=1.0), dict(blink=1.0, looky=1.0)]
F0 = dict(jaw=0.0, nose=0.0, brow=0.0, lip=0.0, age=0.0, blink=0.0, lookx=0.0, looky=0.0, smile=0.0, fist=0.0, wheel=0.0, gun=0.0)

# The skull, chin to crown: y, half width, front depth, back depth, centre z.
HEAD = [(1.534, 0.022, 0.026, 0.030, 0.052), (1.540, 0.035, 0.042, 0.040, 0.047), (1.548, 0.045, 0.048, 0.050, 0.040), (1.566, 0.0565, 0.060, 0.072, 0.028),
        (1.590, 0.065, 0.074, 0.088, 0.016), (1.620, 0.0685, 0.082, 0.096, 0.010), (1.650, 0.071, 0.084, 0.100, 0.008),
        (1.680, 0.074, 0.088, 0.102, 0.008), (1.710, 0.072, 0.085, 0.099, 0.008), (1.730, 0.063, 0.074, 0.089, 0.007),
        (1.745, 0.047, 0.055, 0.068, 0.005), (1.753, 0.027, 0.032, 0.040, 0.004)]
def cr(y):
    """The cranium above the brow, stretched: the eyes belong halfway up a head."""
    return y if y < 1.68 else 1.68 + (y - 1.68) * 1.30


HEAD = [(cr(y), rx * 1.06, zf, zb, cz) for y, rx, zf, zb, cz in HEAD]
HEAD_Y = 1.56   # the head's pivot, and the level its sizes scale about
HN = 2.15       # the skull's superellipse exponent
EX, EY, ER, EA = 0.0315, 1.6555, 0.0155, 0.0125   # eye: off centre, height, the ball's radius, half the opening's width


def B(x, y, z):
    return Vector((x, -z, y))


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(t, a=0.0, b=1.0):
    return max(a, min(b, t))


def smooth(t):
    t = clamp(t)
    return t * t * (3 - 2 * t)


def G2(x, x0, w):
    return exp(-((x - x0) / w) ** 2)


def two(a, b, t):
    """Weights across a joint: bone a at t = 0, bone b at t = 1."""
    t = clamp(t)
    return {a: 1.0} if t <= 0 else {b: 1.0} if t >= 1 else {a: 1 - t, b: t}


def rgb(t):
    return (t, t, t) if isinstance(t, (int, float)) else tuple(t)


# ── The atlas ────────────────────────────────────────────────────────────────
# One layout for both bodies and every level of detail, in 1/1024ths. A loft
# that names no rectangle lands on the neutral texel at the origin.

ATLAS_N = 1024
ATLAS_LIST = [('head', 400, 400)]
ATLAS = {}


def pack():
    x = y = 8; row = 0
    for name, w, h in ATLAS_LIST:
        if x + w > ATLAS_N: x = 8; y += row + 4; row = 0
        ATLAS[name] = (x / ATLAS_N, y / ATLAS_N, w / ATLAS_N, h / ATLAS_N); x += w + 4; row = max(row, h)
    assert y + row <= ATLAS_N, 'atlas full'


pack()


# ── The loft ─────────────────────────────────────────────────────────────────

def S(y, rx, zf=None, zb=None, cz=0.0, cx=0.0, **kw):
    """A horizontal ring: half width rx along x, depth zf ahead of the centre and zb behind."""
    zf = rx if zf is None else zf
    return dict(c=Vector((cx, y, cz)), rx=rx, zf=zf, zb=zf if zb is None else zb, u=Vector((1, 0, 0)), v=Vector((0, 0, 1)), **kw)


def Z(z, rx, up, dn, cy, cx=0.0, **kw):
    """An upright ring facing along z (shoes, cap brims): half width rx, `up` above the centre and `dn` below."""
    return dict(c=Vector((cx, cy, z)), rx=rx, zf=up, zb=dn, u=Vector((1, 0, 0)), v=Vector((0, 1, 0)), **kw)


def thin(secs, tol=0.007):
    """Drop every ring a straight line between its kept neighbours already describes."""
    def near(a, b, s, t):
        if s['rx'] == 0: return False
        if abs(lerp(a['rx'], b['rx'], t) - s['rx']) > tol or abs(lerp(a['zf'], b['zf'], t) - s['zf']) > tol: return False
        if abs(lerp(a['zb'], b['zb'], t) - s['zb']) > tol or (a['c'].lerp(b['c'], t) - s['c']).length > tol: return False
        wa, wb, ws = a.get('w'), b.get('w'), s.get('w')
        if callable(wa) or callable(wb) or callable(ws): return True
        for k in set(wa) | set(wb) | set(ws):
            if abs(lerp(wa.get(k, 0), wb.get(k, 0), t) - ws.get(k, 0)) > 0.3: return False
        return True
    out = [secs[0]]; i = 1
    while i < len(secs):
        j = i
        # Reach as far ahead as every skipped ring still allows.
        while j + 1 < len(secs):
            a, b = out[-1], secs[j + 1]; L = (b['c'] - a['c']).length
            if L < 1e-6 or not all(near(a, b, secs[k], (secs[k]['c'] - a['c']).length / L) for k in range(i, j + 1)): break
            j += 1
        out.append(secs[j]); i = j + 1
    return out


def near_segs(n):
    """Up close a limb is rounder than it was drawn: a quarter more sides on anything with ten or more."""
    return n if n < 10 else int(n * 1.25 / 2 + 0.5) * 2


class Model:
    def __init__(s, lod):
        s.lod = lod; s.V = []; s.W = []; s.T = []; s.C = []; s.F = []; s.FM = []; s.FUV = []

    def grid(s, rows, mat, closed=True, cls=None, uv=None, us=None, vs=None, keep=None, orient=None, min_lod=2):
        """Rows of (position, weights, tint); a row of one is a pole. `keep(j, k)` drops the face after row j, column k."""
        if s.lod > min_lod: return
        c = CLS[mat] if cls is None else cls
        base = len(s.V); idx = []
        for r in rows:
            ids = []
            for p, w, t in r:
                ids.append(len(s.V)); s.V.append(p); s.W.append(dict(w)); s.T.append(rgb(t)); s.C.append(c(p) if callable(c) else c)
            idx.append(ids)
        n = max(len(r) for r in rows); nu = n if closed else n - 1
        us = us or [k / nu for k in range(nu + 1)]; vs = vs or [j / (len(rows) - 1) for j in range(len(rows))]
        X, Y, Wd, Ht = ATLAS.get(uv, (0.002, 0.002, 0.0, 0.0))
        faces = []
        for j in range(len(rows) - 1):
            r0, r1 = idx[j], idx[j + 1]
            for k in range(nu):
                k2 = (k + 1) % n if closed else k + 1
                if (keep and not keep(j, k)) or (len(r0) == 1 and len(r1) == 1): continue
                um = (us[k] + us[k + 1]) / 2
                if len(r0) == 1: f = (r0[0], r1[k2], r1[k]); t = ((um, vs[j]), (us[k + 1], vs[j + 1]), (us[k], vs[j + 1]))
                elif len(r1) == 1: f = (r0[k], r0[k2], r1[0]); t = ((us[k], vs[j]), (us[k + 1], vs[j]), (um, vs[j + 1]))
                else: f = (r0[k], r0[k2], r1[k2], r1[k]); t = ((us[k], vs[j]), (us[k + 1], vs[j]), (us[k + 1], vs[j + 1]), (us[k], vs[j + 1]))
                faces.append((f, tuple((X + a * Wd, Y + b * Ht) for a, b in t)))
        if not faces: return
        # Wind outward: the same test for closed lofts and open shells.
        cen = orient or sum((s.V[i] for i in range(base, len(s.V))), Vector()) / (len(s.V) - base); vol = 0.0
        for f, _ in faces:
            p = [s.V[i] for i in f]
            vol += ((p[1] - p[0]).cross(p[2] - p[0])).dot(sum(p, Vector()) / len(p) - cen)
        for f, t in faces:
            s.F.append(f if vol >= 0 else f[::-1]); s.FUV.append(t if vol >= 0 else t[::-1]); s.FM.append(MI[mat])

    def tube(s, secs, segs, mat, w=None, keep=None, disp=None, tint=1.0, lod_segs=None, min_lod=2, cls=None, uv=None, seam=-pi / 2, orient=None):
        """Loft the rings in order. A ring with rx 0 is a pole. `keep(y, a)` drops faces; `disp(a, sec)` pushes a vertex along its radius."""
        if s.lod > min_lod: return
        if s.lod == 0:
            segs = near_segs(segs)
        else:
            # The middle distance keeps three quarters of the roundness of anything big; the far crowd is prisms.
            segs = max(lod_segs or 0, (segs * 3 // 4) if segs >= 12 else max(5, segs // 2)) if s.lod == 1 else (lod_segs or max(5, segs // 2))
            # The far crowd: a body is a handful of prisms.
            if s.lod == 2: segs = max(4, segs * 2 // 3)
            secs = thin([dict(x, w=x.get('w', w)) for x in secs], 0.004 if s.lod == 1 else 0.02)
        rows = []
        for sec in secs:
            ww = sec.get('w', w); row = []
            for k in range(1 if sec['rx'] == 0 else segs):
                a = seam + 2 * pi * k / segs
                cs, sn = cos(a), sin(a); e = 2.0 / sec.get('n', 2.0)
                px = copysign(abs(cs) ** e, cs) * sec['rx']
                pz = copysign(abs(sn) ** e, sn) * (sec['zf'] if sn >= 0 else sec['zb'])
                if disp and sec['rx'] != 0:
                    d = disp(a, sec); r = sqrt(px * px + pz * pz) or 1.0
                    px *= 1 + d / r; pz *= 1 + d / r
                p = sec['c'] + sec['u'] * px + sec['v'] * pz
                tt = sec.get('t', tint)
                row.append((p, ww(a, p) if callable(ww) else ww, tt(p) if callable(tt) else tt))
            rows.append(row)
        kp = None
        if keep:
            kp = lambda j, k: keep((secs[j]['c'].y + secs[j + 1]['c'].y) / 2, seam + 2 * pi * (k + 0.5) / segs)
        s.grid(rows, mat, True, cls, uv, None, [x['tv'] for x in secs] if 'tv' in secs[0] else None, kp, orient, min_lod)

    def ball(s, c, r, mat, w, segs=8, rings=4, tint=1.0, min_lod=0):
        """An ellipsoid: r is (x, y, z) radii."""
        secs = [S(c[1] - r[1], 0, 0, 0, c[2], c[0])]
        for i in range(1, rings):
            t = pi * i / rings
            secs.append(S(c[1] - r[1] * cos(t), r[0] * sin(t), r[2] * sin(t), None, c[2], c[0]))
        secs.append(S(c[1] + r[1], 0, 0, 0, c[2], c[0]))
        s.tube(secs, segs, mat, w, tint=tint, min_lod=min_lod)

    def scale_from(s, i0, pivot, k):
        for i in range(i0, len(s.V)): s.V[i] = pivot + (s.V[i] - pivot) * k


# ── The head ─────────────────────────────────────────────────────────────────
# The face is one grid over the skull's rings, pushed in and out by a field of
# features, with its columns and rows crowded where the features are. All of it
# is a function of the face parameters F, so a morph target is simply the same
# head built with one parameter moved.

def head_at(y, k=1.0):
    """Interpolated skull ring at height y (scaled by k about the pivot)."""
    H = [(HEAD_Y + (h[0] - HEAD_Y) * k, h[1] * k, h[2] * k, h[3] * k, h[4] * k) for h in HEAD] if k != 1.0 else HEAD
    for a, b in zip(H, H[1:]):
        if y <= b[0] or b is H[-1]:
            t = clamp((y - a[0]) / (b[0] - a[0]))
            return [lerp(a[i], b[i], t) for i in range(5)]


def face_z(x, y, k):
    """Depth of the bare skull's front at (x, y)."""
    _, rx, zf, _, cz = head_at(y, k)
    return cz + zf * sqrt(max(0.0, 1 - (x / rx) ** 2))


def ang_of_x(x, y):
    """The angle round the skull's ring at height y whose point is x off centre (front half)."""
    a = acos(clamp(abs(x) / head_at(y)[1]) ** (HN / 2))
    return a if x >= 0 else pi - a


def eye_c(F, side):
    a = ang_of_x(EX, EY); _, rx, zf, _, cz = head_at(EY)
    z = cz + zf * sin(a) ** (2 / HN)
    return Vector((side * EX, EY, z - (0.0068 + 0.0016 * F['brow']) - ER))


def feat(F, ax, y, lod):
    """How far the face stands out of the skull at (|x|, y), and its tint there."""
    nose, jaw, brow, age, lipf = F['nose'], F['jaw'], F['brow'], F['age'], F['lip']
    d = (0.0030 + 0.0022 * brow) * G2(y, 1.681, 0.008) * (0.45 + 0.55 * smooth((ax - 0.006) / 0.012)) * (1 - smooth((ax - 0.050) / 0.02))
    sock = G2(y, 1.657, 0.011) * G2(ax, 0.032, 0.018)
    d -= (0.0050 + 0.0020 * brow + 0.0012 * age) * sock
    d += 0.0032 * G2(y, 1.630, 0.016) * G2(ax, 0.050, 0.020)                     # cheekbones
    d -= 0.0028 * age * G2(y, 1.600, 0.016) * G2(ax, 0.047, 0.016)               # and the hollow under them
    d += 0.0030 * age * G2(y, 1.561, 0.012) * G2(ax, 0.040, 0.012)               # jowls
    d -= 0.0015 * G2(y, 1.695, 0.02) * smooth((ax - 0.060) / 0.012)              # temples
    t = [1.0, 1.0, 1.0]
    if 1.598 < y < 1.684:
        ns = 1 + 0.30 * nose
        if y >= 1.6135: h = (0.0020 + 0.0225 * (1 - clamp((y - 1.6135) / 0.0625) ** 0.85)) * smooth((1.684 - y) / 0.012)
        else: h = lerp(0.0245, 0.0032, smooth((1.6135 - y) / 0.008))
        w = lerp(0.0100, 0.0058, clamp((y - 1.612) / 0.05)) * (1 + 0.25 * nose)
        d += h * ns * (0.8 * exp(-((ax / w) ** 2) * 1.1) + 0.2 * exp(-((ax / (2.4 * w)) ** 2)))
        d += 0.0062 * ns * G2(y, 1.6105, 0.0055) * G2(ax, 0.0128 * (1 + 0.25 * nose), 0.0046)   # the wings
        nos = G2(y, 1.6062, 0.0022) * G2(ax, 0.0068, 0.0030)
        d -= 0.0045 * nos
        for i in range(3): t[i] *= (1 - 0.8 * nos) * (1 - 0.22 * G2(y, 1.6055, 0.003) * G2(ax, 0.0, 0.014))
    d += 0.0022 * G2(y, 1.588, 0.017) * G2(ax, 0.0, 0.027)                       # the teeth behind the mouth
    mw = 0.0245
    ends = 1 - smooth((ax - (mw - 0.007)) / 0.007)
    up = G2(y, 1.5884, 0.0030) * ends * (1 - 0.22 * G2(ax, 0.0, 0.004))
    lo = G2(y, 1.5782, 0.0036) * (1 - smooth((ax - 0.011) / 0.010))
    line = G2(y, 1.5836 + 0.0012 * F['smile'] * smooth(ax / mw), 0.0014) * (1 - smooth((ax - mw) / 0.004))
    d += (0.0024 + 0.0010 * lipf - 0.0009 * age) * up + (0.0030 + 0.0012 * lipf - 0.0009 * age) * lo - 0.0034 * line
    d -= 0.0011 * G2(ax, 0.0, 0.0028) * smooth((y - 1.5915) / 0.003) * (1 - smooth((y - 1.603) / 0.003))   # philtrum
    d -= 0.0022 * G2(y, 1.5665, 0.005) * G2(ax, 0.0, 0.016)
    d += (0.0050 + 0.0020 * jaw) * G2(y, 1.549, 0.009) * G2(ax, 0.0, 0.016 + 0.004 * jaw)                 # chin
    lip = clamp(1.25 * max(up * (1.0 if y > 1.5836 else 0.0) + G2(y, 1.586, 0.002) * ends * 0.8, lo * (1.0 if y < 1.5836 else 0.0) + G2(y, 1.5815, 0.002) * ends * 0.6))
    lc = (0.86, 0.62, 0.62)
    for i in range(3): t[i] *= lerp(1.0, lc[i], lip) * (1 - 0.45 * line)
    if lod: t = [c * (1 - 0.5 * G2(y, EY, 0.008) * G2(ax, EX, 0.012)) for c in t]
    return d, t


def face_point(F, a, y, t=None, tag=None, lod=0, off=0.0):
    """A point of the face: angle a round the skull at height y. t is where an eye column lies across its eye (-1 inner corner, 1 outer)."""
    tint = None
    if t is not None and lod == 0:
        o = (1 - t * t) ** 0.8 if abs(t) < 1 else 0.0
        if tag in ('lo', 'mid', 'up'):
            ec = EY + 0.0008 * t
            ylo = ec - 0.0039 * o; yup = lerp(ec + 0.0052 * o, ylo + 0.0003, F['blink'])
            ya = ylo if tag == 'lo' else yup if tag == 'up' else (ylo + yup) / 2
            y = lerp(ya, y, smooth((abs(t) - 1) / 0.6))
            if o > 0: tint = (0.30, 0.24, 0.22) if tag == 'up' else (0.82, 0.78, 0.78)
        elif tag == 'crease':
            y -= 0.0032 * F['blink'] * o
    _, rx, zf, zb, cz = head_at(y)
    cs, sn = cos(a), sin(a); e = 2 / HN
    x = copysign(abs(cs) ** e, cs) * rx
    z = copysign(abs(sn) ** e, sn) * (zf if sn >= 0 else zb)
    x *= 1 + 0.09 * F['jaw'] * smooth((1.615 - y) / 0.045)
    r = sqrt(x * x + z * z) or 1.0
    f = smooth(sn / 0.3) if sn > 0 else 0.0
    d, tn = feat(F, abs(x), y, lod) if f > 0 else (0.0, (1.0, 1.0, 1.0))
    d = d * f + off
    x += d * x / r; z += d * z / r + cz
    if f > 0 and lod == 0:
        E = eye_c(F, 1 if x > 0 else -1)
        q = sqrt(((x - E.x) / 0.0150) ** 2 + ((y - E.y) / 0.0096) ** 2)
        if q < 1.8:
            R1 = ER + 0.0011 + off
            zs = E.z + sqrt(max(R1 * R1 - (x - E.x) ** 2 - (y - E.y) ** 2, (0.3 * R1) ** 2))
            z = lerp(z, zs, 1 - smooth((q - 1) / 0.8))
    return Vector((x, y, z)), tint or tuple(lerp(1.0, c, f) for c in tn)


def face_xy(F, x, y, off=0.0, lod=0):
    return face_point(F, ang_of_x(x, y), y, lod=lod, off=off)[0]


FRONT_X = [0.0, 0.004, 0.008, 0.013, 0.019, 0.0232, 0.0273, 0.0315, 0.0357, 0.0398, 0.044, 0.050, 0.056, 0.062, 0.068, 0.073]
FACE_ROWS = [(1.534, 0), (1.540, 0), (1.546, 0), (1.553, 0), (1.560, 0), (1.566, 0), (1.572, 0), (1.5775, 0), (1.5815, 0), (1.5836, 0), (1.5857, 0),
             (1.5885, 0), (1.592, 0), (1.597, 0), (1.602, 0), (1.6045, 0), (1.607, 0), (1.6095, 0), (1.612, 0), (1.616, 0), (1.622, 0), (1.630, 0),
             (1.640, 0), (1.647, 0), (1.6515, 'lo'), (1.6555, 'mid'), (1.6595, 'up'), (1.665, 'crease'), (1.672, 0), (1.679, 0), (1.686, 0),
             (1.695, 0), (1.705, 0), (1.715, 0), (1.725, 0), (1.734, 0), (1.741, 0), (1.747, 0), (1.752, 0)]
COARSE2_ROWS = [(y, 0) for y in (1.534, 1.560, 1.600, 1.645, 1.690, 1.730, 1.750)]
COARSE_ROWS = [(y, 0) for y in (1.534, 1.549, 1.566, 1.584, 1.598, 1.612, 1.632, 1.656, 1.681, 1.705, 1.728, 1.746)]


def head_cols():
    ang = lambda x: ang_of_x(x, EY)
    step = (ang(FRONT_X[-1]) + pi / 2) / 9
    plus = [(-pi / 2 + j * step, None) for j in range(9)]
    tt = lambda x: (x - EX) / EA if abs(x - EX) / EA <= 1.6 else None
    fp = [(ang(x), tt(x)) for x in reversed(FRONT_X[1:])]
    fm = [(pi - ang(x), tt(x)) for x in FRONT_X[1:]]
    return plus + fp + [(pi / 2, None)] + fm + [(pi - a, None) for a, _ in reversed(plus[1:])]


def build_head(M, F, lod):
    HW = {'head': 1.0}
    nc = 14 if lod == 1 else 8
    cols = head_cols() if lod == 0 else [(-pi / 2 + 2 * pi * k / nc, None) for k in range(nc)]
    rws = FACE_ROWS if lod == 0 else COARSE_ROWS if lod == 1 else COARSE2_ROWS
    rows = [[(Vector((0, 1.528, HEAD[0][4] - 0.004)), HW, 1.0)]]
    for y, tag in rws:
        row = []; y = cr(y)
        for a, t in cols:
            p, tn = face_point(F, a, y, t, tag, lod); row.append((p, HW, tn))
        rows.append(row)
    rows.append([(Vector((0, cr(1.758), HEAD[-1][4])), HW, 1.0)])
    tags = [None] + [t for _, t in rws]
    inside = [t is not None and abs(t) <= 1.0001 for _, t in cols]
    n = len(cols)
    def keep(j, k):
        return not (tags[j] in ('lo', 'mid') and inside[k] and inside[(k + 1) % n])
    M.grid(rows, 'head', keep=keep if lod == 0 else None, uv='head')
    for s in (1, -1):
        if lod == 2: break
        build_ear(M, s, lod)
        if lod == 0: build_eye(M, F, s)
        # Eyebrow: a strip lying on the brow ridge, thick at the nose and thinning outward.
        nb = 7 if lod == 0 else 3; rows = []
        for j in range(3):
            row = []
            for i in range(nb):
                q = i / (nb - 1); x = 0.0085 + 0.046 * q
                yc = 1.6735 + 0.0048 * sin(pi * q ** 0.75) * (1 - 0.3 * q) - 0.0012 * F['brow'] - 0.001 * F['age']
                row.append((face_xy(F, s * x, yc - 0.001 + (j - 1) * (0.0048 - 0.0030 * q), 0.0013, lod), HW, 1.0 if j == 1 else 0.8))
            rows.append(row)
        M.grid(rows, 'brow', closed=False, orient=Vector((0, 1.65, 0)))


def build_ear(M, s, lod):
    HW = {'head': 1.0}; cy, cz = 1.642, -0.010
    def side_x(y, z):
        _, rx, zf, zb, c0 = head_at(y)
        return rx * (1 - clamp(abs(z - c0) / (zf if z > c0 else zb)) ** HN) ** (1 / HN)
    def pt(r, th, back=0.0, sc=1.0, fwd=0.0):
        # Taller than wide, wider at the top, a narrow lobe; the rear edge stands off the head.
        y = cy + 0.031 * r * sc * sin(th); z = cz - 0.002 + fwd + 0.0165 * (1 + 0.18 * sin(th)) * r * sc * cos(th)
        flare = 0.0035 + 0.0100 * clamp((cz + 0.014 - z) / 0.030)
        h = 0.0030 * G2(r, 0.94, 0.09) - 0.0012 * G2(r, 0.74, 0.07) + 0.0022 * G2(r, 0.52, 0.09) * smooth(0.5 - cos(th)) - 0.0055 * G2(r, 0.18, 0.24)
        x = side_x(y, z) + (flare + h - back if sc == 1.0 else -0.002)
        k = lerp(1.0, 0.62, G2(r, 0.15, 0.25))
        return Vector((s * x, y, z)), HW, (k, k * 0.93, k * 0.91)
    nth = 14 if lod == 0 else 6
    rr = [0.30, 0.55, 0.76, 0.93, 1.0] if lod == 0 else [0.6, 1.0]
    rows = [[pt(0, 0)]] + [[pt(r, 2 * pi * k / nth) for k in range(nth)] for r in rr]
    rows.append([pt(0.97, 2 * pi * k / nth, 0.0045) for k in range(nth)])
    rows.append([pt(1.0, 2 * pi * k / nth, sc=0.5, fwd=0.005) for k in range(nth)])
    M.grid(rows, 'head')


def build_eye(M, F, s):
    HW = {'head': 1.0}; E = eye_c(F, s)
    def sph(phi, th, r, rot=None):
        v = Vector((sin(phi) * cos(th), sin(phi) * sin(th), cos(phi))) * r
        return E + (rot @ v if rot else v)
    ring = lambda p, t, r=ER, rot=None: [(sph(radians(p), 2 * pi * k / 10, r, rot), HW, t) for k in range(10)]
    M.grid([[(sph(0, 0, ER), HW, 1.0)]] + [ring(p, 1.0 - 0.3 * (p / 56) ** 2) for p in (10, 22, 34, 45, 56)], 'eyewhite', min_lod=0)
    # The iris rides just proud of the white and turns with the look. Its tint paints the pupil and the dark rim.
    rot = Matrix.Rotation(F['lookx'] * 0.35, 3, 'Y') @ Matrix.Rotation(-F['looky'] * 0.30, 3, 'X')
    R = ER + 0.00035
    M.grid([[(sph(0, 0, R, rot), HW, 0.0)]] + [ring(p, t, R, rot) for p, t in ((6.3, 0.0), (7.6, 0.8), (15.0, 1.0), (20.5, 0.5), (22.0, 0.3))], 'iris', min_lod=0)


# ── A person ─────────────────────────────────────────────────────────────────

def joints(G):
    sx, sy = G['sh'], G['sh_y']
    J = {'hips': ((0, HIP_Y, 0), None), 'spine': ((0, 1.02, 0), 'hips'), 'chest': ((0, 1.20, 0), 'spine'),
         'neck': ((0, 1.47, -0.008), 'chest'), 'head': ((0, HEAD_Y, 0.0), 'neck')}
    for n, s in (('l', 1), ('r', -1)):
        J['shoulder_' + n] = ((s * 0.04, sy + 0.02, -0.01), 'chest')
        J['upperarm_' + n] = ((s * sx, sy, -0.01), 'shoulder_' + n)
        J['forearm_' + n] = ((s * sx, sy - UPPER, -0.01), 'upperarm_' + n)
        J['hand_' + n] = ((s * sx, sy - UPPER - FORE, -0.01), 'forearm_' + n)
        J['thigh_' + n] = ((s * HIP_X, HIP_Y, 0), 'hips')
        J['shin_' + n] = ((s * HIP_X, KNEE_Y, 0), 'thigh_' + n)
        J['foot_' + n] = ((s * HIP_X, ANKLE_Y, 0), 'shin_' + n)
    return J


def at(rows, y):
    """A list of (y, a, b, ...) rings read at height y; the list may run up or down."""
    if rows[0][0] > rows[-1][0]: rows = rows[::-1]
    if y <= rows[0][0]: return list(rows[0][1:])
    for a, b in zip(rows, rows[1:]):
        if y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            return [lerp(a[i], b[i], t) for i in range(1, len(a))]
    return list(rows[-1][1:])


# The bare arm, shoulder to wrist: distance down from the joint, half width, half depth.
ARM = [(-0.033, 0.022, 0.022), (-0.018, 0.037, 0.039), (0.010, 0.046, 0.049), (0.06, 0.047, 0.050), (0.12, 0.046, 0.049), (0.20, 0.045, 0.048),
       (0.245, 0.042, 0.044), (0.265, 0.041, 0.043), (0.28, 0.041, 0.043), (0.295, 0.042, 0.043), (0.315, 0.043, 0.045), (0.36, 0.043, 0.047),
       (0.44, 0.035, 0.039), (0.50, 0.027, 0.033), (0.53, 0.023, 0.031)]
# A trouser leg, crotch to hem, and the bare leg inside it: y, half width, front, back, centre z.
TROUSER = [(0.925, 0.055, 0.066, 0.070, 0.0), (0.88, 0.078, 0.090, 0.097, -0.004), (0.82, 0.084, 0.092, 0.096, -0.004), (0.70, 0.082, 0.089, 0.087, 0.0),
           (0.60, 0.074, 0.080, 0.075, 0.0), (0.545, 0.068, 0.073, 0.068, 0.0), (0.52, 0.066, 0.071, 0.066, 0.0), (0.50, 0.065, 0.071, 0.064, 0.0),
           (0.48, 0.064, 0.071, 0.063, 0.0), (0.46, 0.064, 0.069, 0.063, 0.0), (0.44, 0.063, 0.067, 0.065, 0.0), (0.37, 0.063, 0.061, 0.071, 0.0),
           (0.30, 0.060, 0.059, 0.067, 0.0), (0.20, 0.056, 0.057, 0.060, 0.0), (0.105, 0.055, 0.058, 0.058, 0.0)]
BARE = [(0.84, 0.074, 0.084, 0.088, -0.004), (0.70, 0.074, 0.081, 0.079, 0.0), (0.60, 0.066, 0.072, 0.067, 0.0), (0.56, 0.058, 0.063, 0.060, 0.0),
        (0.52, 0.053, 0.059, 0.054, 0.0), (0.50, 0.052, 0.060, 0.052, 0.0), (0.48, 0.051, 0.060, 0.051, 0.0), (0.46, 0.050, 0.057, 0.052, 0.0),
        (0.44, 0.049, 0.053, 0.056, 0.0), (0.37, 0.056, 0.050, 0.072, 0.0), (0.30, 0.052, 0.047, 0.066, 0.0), (0.20, 0.041, 0.042, 0.048, 0.0),
        (0.13, 0.035, 0.037, 0.040, 0.0), (0.07, 0.035, 0.037, 0.040, 0.0)]
# Finger: offset along the palm's width, length of the first bone, radius, how far down the palm it starts.
FINGERS = [(0.029, 0.040, 0.0082, 0.090), (0.010, 0.045, 0.0085, 0.094), (-0.009, 0.041, 0.0080, 0.092), (-0.027, 0.032, 0.0070, 0.086)]


def streak(p):
    """Hair is not one flat colour: strands catch the light in turn."""
    return 0.80 + 0.20 * sin(atan2(p.x, p.z + 0.01) * 23.0 + p.y * 40.0) ** 2


def build_hand(M, G, F, s, n, lod):
    hd = 'hand_' + n; W = {hd: 1.0}; k = G['hand']
    wx, wy, wz = s * G['sh'], G['sh_y'] - UPPER - FORE, -0.01
    inx = -s   # toward the body: the way the palm faces and the fingers close
    if lod:
        # Further off, a mitten: palm inward, fingers curling toward the leg.
        def Hn(d, rx, rz, curl=0.0, fz=0.0):
            return S(wy - d * k, rx * k, rz * k, None, wz + fz * k, wx - s * curl * k)
        M.tube([Hn(-0.015, 0.021, 0.029), Hn(0.02, 0.019, 0.037, 0, 0.003), Hn(0.055, 0.017, 0.043, 0.001, 0.005), Hn(0.085, 0.015, 0.042, 0.004, 0.007),
                Hn(0.125, 0.012, 0.038, 0.012, 0.009), Hn(0.160, 0.010, 0.030, 0.022, 0.010), Hn(0.178, 0, 0, 0.028, 0.010)], 8, 'body', W, lod_segs=5)
        return
    fist, wheel, gun = F['fist'], F['wheel'], F['gun']
    def Pm(d, th, wd, fz=0.0):
        return S(wy - d * k, th * k, wd * k, None, wz + fz * k, wx, n=2.8)
    M.tube([Pm(-0.022, 0.019, 0.026), Pm(0.0, 0.0165, 0.0275), Pm(0.028, 0.0135, 0.036, 0.003), Pm(0.058, 0.0125, 0.041, 0.004),
            Pm(0.086, 0.0105, 0.0395, 0.004), Pm(0.097, 0.0065, 0.036, 0.004), Pm(0.099, 0, 0, 0.004)], 8, 'body', W, min_lod=0)

    def loft(pts, r0, r1, flat=1.0, nail=None):
        """A finger along a bent line: one ring a knuckle, turned to split the bend."""
        secs = []
        for i, p in enumerate(pts):
            a = pts[i] - pts[i - 1] if i else pts[1] - pts[0]
            b = pts[i + 1] - pts[i] if i + 1 < len(pts) else a
            d = (a.normalized() + b.normalized()).normalized()
            v = d.cross(Vector((inx, 0, 0)))
            v = v.normalized() if v.length > 1e-4 else Vector((0, 0, 1))
            u = v.cross(d).normalized()
            r = lerp(r0, r1, i / (len(pts) - 1)) * k
            # Knuckles are a touch thicker than the bones between them.
            if 0 < i < len(pts) - 1: r *= 1.06
            secs.append(dict(c=p.copy(), rx=r * flat, zf=r, zb=r, u=u, v=v))
        tip = pts[-1] + (pts[-1] - pts[-2]).normalized() * r1 * k * 0.8
        secs.append(dict(c=tip, rx=0, zf=0, zb=0, u=Vector((1, 0, 0)), v=Vector((0, 0, 1))))
        M.tube(secs, 6, 'body', W, min_lod=0, tint=nail or 1.0)

    for fi, (fz, L1, r, bd) in enumerate(FINGERS):
        rel = 0.20 + 0.07 * fi
        trig = fi == 0
        c = [rel + fist * (1.45 - rel) + wheel * (1.0 - rel) + gun * ((0.30 if trig else 1.4) - rel),
             0.32 + fist * 1.33 + wheel * 0.95 + gun * (0.55 if trig else 1.2),
             0.22 + fist * 0.9 + wheel * 0.6 + gun * (0.35 if trig else 0.8)]
        p = Vector((wx + inx * 0.002 * k, wy - bd * k, wz + (fz + 0.004) * k)); th = 0.0
        pts = [p + Vector((0, 0.008 * k, 0)), p.copy()]
        for L, cc in zip((L1, L1 * 0.62, L1 * 0.52), c):
            th += cc
            p = p + Vector((inx * sin(th), -cos(th), 0)) * L * k
            pts.append(p.copy())
        loft(pts, r, r * 0.80)
    # Thumb: off the front of the palm, forward and down; across the fingers when they close.
    g = max(fist, wheel, gun)
    p = Vector((wx + inx * 0.005 * k, wy - 0.034 * k, wz + 0.027 * k))
    d1 = Vector((inx * (0.25 + 0.45 * g), -0.72, 0.62 - 0.25 * g)).normalized()
    d2 = Vector((inx * (0.30 + 0.75 * fist + 0.55 * wheel + 0.5 * gun), -0.80 + 0.25 * g, 0.50 - 0.75 * fist - 0.5 * wheel - 0.35 * gun)).normalized()
    d3 = Vector((inx * (0.30 + 0.9 * fist + 0.8 * wheel + 0.6 * gun), -0.85 + 0.3 * g, 0.42 - 1.0 * fist - 0.8 * wheel - 0.5 * gun)).normalized()
    pts = [p - d1 * 0.012 * k, p.copy(), p + d1 * 0.034 * k]
    pts.append(pts[-1] + d2 * 0.028 * k); pts.append(pts[-1] + d3 * 0.022 * k)
    loft(pts, 0.0105, 0.0078)


def person(G, lod, F):
    M = Model(lod)
    hk = G['head']
    F = {k: v + G['face'].get(k, 0.0) for k, v in F.items()}
    HW = {'head': 1.0}
    def hy(y): return HEAD_Y + (y - HEAD_Y) * hk

    build_head(M, F, lod)
    if lod < 2:
        build_face_extras(M, F, lod)
    M.scale_from(0, Vector((0, HEAD_Y, 0)), hk)

    P, T, nk = G['pants'], G['shirt'], G['neck']

    def torso_w(y):
        def w(a, p):
            base = two('hips', 'spine', (y - 0.96) / 0.12) if y < 1.14 else two('spine', 'chest', (y - 1.14) / 0.12)
            # The outer corners of the shoulder line ride the collar bones.
            t = clamp((y - 1.30) / 0.07) * clamp((abs(p.x) - 0.07) / 0.07) * 0.7
            return {'chest': 1 - t, 'shoulder_l' if p.x > 0 else 'shoulder_r': t} if t > 0.02 else base
        return w

    def front(x, y, ease=0.0):
        """Where the chest's surface is at (x, y), for things sewn onto it."""
        rx, zf, zb, cz = at(T, y)
        return cz + (zf + ease) * max(0.0, 1 - (abs(x) / (rx + ease)) ** 2.3) ** (1 / 2.3)

    def torso(mat, ease, hem, keep=None, neck=0.008, hem_ring=None, flare=0.0, min_lod=2):
        """A top's body: hem to neck, `ease` of air between cloth and skin."""
        b = hem_ring or [v + (ease + flare if i < 3 else 0) for i, v in enumerate(at(T, hem))]
        secs = [S(hem + 0.004, b[0] - 0.014, b[1] - 0.014, b[2] - 0.014, b[3], n=2.3, w=torso_w(hem), t=0.55)] if lod < 2 else []
        secs.append(S(hem, b[0], b[1], b[2], b[3], n=2.3, w=torso_w(hem), t=0.9))
        for y, rx, zf, zb, cz in T:
            if y < hem + 0.02: continue
            e = ease * (1.0 if y < 1.40 else 0.55)
            # Cloth hangs from the chest and shoulders rather than following the waist in.
            e += flare * clamp((1.20 - y) / 0.25)
            secs.append(S(y, rx + e, zf + e, zb + e, cz, n=2.3 if y < 1.42 else 2.0, w=torso_w(y)))
        ty = T[-1][0]
        secs.append(S(ty + 0.006, nk + neck, None, None, T[-1][4], w={'chest': 1.0}))
        secs.append(S(ty + 0.003, nk - 0.004, None, None, T[-1][4], w={'chest': 1.0}, t=0.55))
        M.tube(secs, 16, mat, keep=keep, min_lod=min_lod)

    def collar(mat, out=0.030, high=0.030, gap=0.30):
        """A turned-down collar: up the neck, folded, lying on the shoulders, open at the throat."""
        cz = -0.014
        secs = [S(1.462, nk + 0.004, None, None, cz, w={'chest': 1.0}, t=0.7), S(1.462 + high, nk + 0.007, None, None, cz - 0.003, w={'chest': 0.5, 'neck': 0.5}),
                S(1.464 + high, nk + 0.012, None, None, cz - 0.003, w={'chest': 0.5, 'neck': 0.5}),
                S(1.470, nk + out, nk + out + 0.008, nk + out - 0.004, cz, w={'chest': 1.0}), S(1.466, nk + out - 0.004, nk + out + 0.004, nk + out - 0.008, cz, w={'chest': 1.0}, t=0.6)]
        M.tube(secs, 14, mat, keep=lambda y, a: abs(a - pi / 2) > gap, min_lod=1, orient=Vector((0, 1.47, cz)))

    def patch(mat, x0, x1, y0, y1, ease, lift=0.004, tint=0.86, nx=3, ny=3, cls=None, flap=0.0):
        """A pocket, a zip: a piece of the chest's surface lifted off it."""
        rows = []
        for j in range(ny + 1):
            y = lerp(y0, y1, j / ny); row = []
            for i in range(nx + 1):
                x = lerp(x0, x1, i / nx)
                edge = min(i, nx - i, j, ny - j) == 0
                tt = tint if isinstance(tint, tuple) else tint * (0.86 if edge else 1.0) * (0.8 if flap and abs(y - (y1 - flap)) < 0.012 else 1.0)
                p = Vector((x, y, front(x, y, ease) + (lift * 0.4 if edge else lift)))
                row.append((p, torso_w(y)(0, p), tt))
            rows.append(row)
        M.grid(rows, mat, closed=False, cls=cls, orient=Vector((0, (y0 + y1) / 2, -1)), min_lod=0)

    # ── Tops ──
    torso('tee', 0.0, 0.885)
    torso('shirt', 0.006, 0.862, flare=0.010)
    collar('shirt')
    for i in range(6):
        y = 0.90 + i * 0.098
        M.ball((0, y, front(0, y, 0.006 + 0.010 * clamp((1.20 - y) / 0.25)) + 0.001), (0.0055, 0.0055, 0.003), 'shirt', torso_w(y)(0, Vector((0, y, 0))), 6, 3, tint=(0.80, 0.78, 0.70), min_lod=0)
    patch('shirt', 0.045, 0.110, 1.235, 1.315, 0.007, 0.003, 0.97)
    torso('hoodie', 0.016, 0.868, flare=0.014, neck=0.016)
    # Its rib at the hem, the pouch on the belly and the hood lying on the back.
    M.tube([S(0.862, at(T, 0.885)[0] + 0.020, at(T, 0.885)[1] + 0.020, at(T, 0.885)[2] + 0.020, -0.008, n=2.3, w={'hips': 1.0}, t=0.8),
            S(0.900, at(T, 0.90)[0] + 0.034, at(T, 0.90)[1] + 0.034, at(T, 0.90)[2] + 0.034, -0.008, n=2.3, w={'hips': 1.0}, t=0.9)], 16, 'hoodie', min_lod=1)
    patch('hoodie', -0.105, 0.105, 0.925, 1.045, 0.031, 0.006, 0.88, nx=6, ny=2)
    M.tube([S(1.395, 0, 0, 0, -0.105), S(1.41, 0.085, 0.035, 0.030, -0.100, w={'chest': 1.0}), S(1.455, 0.118, 0.050, 0.045, -0.088, w={'chest': 1.0}),
            S(1.495, 0.100, 0.052, 0.040, -0.074, w={'chest': 1.0}, t=0.85), S(1.515, 0.070, 0.040, 0.030, -0.068, w={'chest': 1.0}, t=0.7), S(1.52, 0, 0, 0, -0.066, w={'chest': 1.0})],
           10, 'hoodie', {'chest': 1.0}, lod_segs=6)
    torso('jacket', 0.018, 0.842, keep=lambda y, a: not (abs(a - pi / 2) < 0.25 and y < 1.445), flare=0.016, neck=0.018)
    collar('jacket', 0.040, 0.034, 0.42)
    # Coveralls: one piece, so the body runs into the trousers' seat; belt, zip and two flapped chest pockets.
    pr = at(P, 0.955)
    torso('coverall', 0.011, 0.955, hem_ring=[pr[0] + 0.006, pr[1] + 0.006, pr[2] + 0.006, pr[3]], flare=0.006)
    collar('coverall', 0.034, 0.028, 0.36)
    patch('coverall', -0.0065, 0.0065, 0.97, 1.452, 0.012, 0.0035, (0.16, 0.155, 0.14), nx=1, ny=10, cls=PLASTIC + FIXED)
    for sg in (1, -1):
        patch('coverall', sg * 0.050, sg * 0.122, 1.225, 1.318, 0.012, 0.0045, 1.0, flap=0.026)
    by = at(T, 1.0)
    M.tube([S(0.984, by[0] + 0.010, by[1] + 0.010, by[2] + 0.010, by[3], n=2.3, w=torso_w(1.0), t=0.7), S(0.986, by[0] + 0.019, by[1] + 0.019, by[2] + 0.019, by[3], n=2.3, w=torso_w(1.0)),
            S(1.022, by[0] + 0.019, by[1] + 0.019, by[2] + 0.019, by[3], n=2.3, w=torso_w(1.0)), S(1.024, by[0] + 0.010, by[1] + 0.010, by[2] + 0.010, by[3], n=2.3, w=torso_w(1.0), t=0.7)],
           16, 'belt', min_lod=1)
    M.ball((0, 1.004, by[3] + by[1] + 0.020), (0.024, 0.019, 0.006), 'belt', torso_w(1.0)(0, Vector((0, 1, 0))), 6, 4, tint=(0.50, 0.47, 0.38), min_lod=0)
    # Dress: fitted to the waist, then a skirt to the knee.
    torso('dress', 0.003, 0.99, neck=0.022)

    def skirt(mat, top, hem, wide, min_lod=2):
        """Hangs from the hips; each side follows its own thigh so a stride does not come through it."""
        def w(y):
            def f(a, p):
                t = clamp((0.93 - y) / 0.25) * 0.85 * smooth(abs(p.x) / 0.03)
                return {'hips': 1 - t, 'thigh_l' if p.x > 0 else 'thigh_r': t} if t > 0.02 else {'hips': 1.0}
            return f
        t0 = at(P, top)
        secs = [S(top + 0.003, t0[0] - 0.006, t0[1] - 0.006, t0[2] - 0.006, t0[3], n=2.3, w=w(top), t=0.6), S(top, t0[0] + 0.005, t0[1] + 0.005, t0[2] + 0.005, t0[3], n=2.3, w=w(top))]
        hp = at(P, 0.90)
        secs.append(S(0.90, hp[0] + 0.010, hp[1] + 0.012, hp[2] + 0.010, hp[3], n=2.2, w=w(0.90)))
        n = 5
        for i in range(1, n + 1):
            q = i / n; y = lerp(0.90, hem, q)
            secs.append(S(y, hp[0] + 0.010 + wide * q, hp[1] + 0.012 + wide * 0.6 * q, hp[2] + 0.010 + wide * 0.7 * q, hp[3] * (1 - q), n=2.1, w=w(y), t=1.0 if i < n else 0.9))
        secs.append(S(hem + 0.004, hp[0] + wide - 0.02, hp[1] + wide * 0.6 - 0.02, hp[2] + wide * 0.7 - 0.02, 0, n=2.1, w=w(hem), t=0.45))
        M.tube(secs, 16, mat, min_lod=min_lod)
    skirt('dress', 1.00, 0.50, 0.050)
    skirt('skirt', 1.005, 0.58, 0.028)

    # ── Seats ──
    def seat(mat, ease=0.0):
        secs = [S(0.775, 0, 0, 0, P[0][4])] + [S(y, rx + ease, zf + ease, zb + ease, cz, n=2.3) for y, rx, zf, zb, cz in P] + [S(P[-1][0] + 0.005, 0, 0, 0, 0)]
        M.tube(secs, 16, mat, {'hips': 1.0})
    seat('trousers'); seat('jeans', -0.002); seat('shorts', 0.002)

    # Neck.
    secs = [S(1.44, nk + 0.004, nk + 0.002, nk + 0.010, -0.016, w={'chest': 1.0}), S(1.47, nk, nk - 0.002, nk + 0.006, -0.018, w={'chest': 0.5, 'neck': 0.5}),
            S(1.50, nk - 0.002, nk - 0.008, nk + 0.002, -0.021, w={'neck': 1.0}), S(1.535, nk - 0.002, nk - 0.010, nk + 0.004, -0.021, w={'neck': 0.5, 'head': 0.5}),
            S(1.580, nk, nk - 0.004, nk + 0.010, -0.018, w={'head': 1.0})]
    M.tube(secs, 10, 'head')
    # The collar bones and the hollow of the throat, for open necks.
    M.tube([S(1.36, 0.10, 0.085, 0.06, 0.0, w={'chest': 1.0}), S(1.40, 0.105, 0.078, 0.07, -0.004, w={'chest': 1.0}), S(1.44, 0.085, 0.060, 0.07, -0.010, w={'chest': 1.0}),
            S(1.462, nk + 0.012, nk + 0.008, nk + 0.014, -0.014, w={'chest': 1.0})], 10, 'head', min_lod=1)

    # ── Hair ── A shell over the skull whose edge dives under the skin at the hairline.
    def shell(mat, off, line, top=1.0, hang=None, lo=1.56, rise=1.0, bump=None, until=None, tint=streak, segs=20, min_lod=2):
        ramp = max(0.022, off * 1.1)
        n_eff = near_segs(segs) if lod == 0 else max(10, segs * 3 // 4) if lod == 1 else 6
        def has(yu, a):
            return yu > line(a) - 0.004 and (until is None or yu < until(a))
        def d(a, sec):
            # A vertex on the rim (any face round it missing) sits just under the skin, so no shell ever shows its inside.
            da = pi / n_eff
            if not all(has((sec['hy'] + yn) / 2, a + sa * da) for yn in (sec['yp'], sec['yn']) for sa in (-1, 1)): return -0.003
            o = off * (bump(a, sec['hy']) if bump else 1.0) * sec['hz']
            return o * clamp((sec['hy'] - line(a)) / ramp, -0.5 if off < 0.02 else -0.08, 1.0)
        secs = []; crown = HEAD[-1][0]
        hs = [h for h in HEAD if h[0] >= lo]
        for i, h in enumerate(hs):
            y, rx, zf, zb, cz = head_at(hy(max(h[0], hang) if hang else h[0]), hk)
            yy = hy(h[0]); yy = hy(lo) + (yy - hy(lo)) * rise
            # Over the crown the hair's depth is upward, not outward.
            t = clamp((h[0] - 1.67) / (crown - 1.67))
            secs.append(S(yy + off * t ** 1.5 * top, rx, zf, zb, cz, hy=h[0], hz=1 - 0.4 * t * t, n=2.15,
                          yp=hs[i - 1][0] if i else h[0] - 0.03, yn=hs[i + 1][0] if i + 1 < len(hs) else crown + 0.01))
        secs.append(S(secs[-1]['c'].y + 0.004 * hk + 0.12 * off, 0, 0, 0, secs[-1]['c'].z, hy=9.0, hz=1.0))
        def keep(y, a):
            # The ring pair this face lies between, by height.
            for s0, s1 in zip(secs, secs[1:]):
                if min(s0['c'].y, s1['c'].y) - 1e-6 <= y <= max(s0['c'].y, s1['c'].y) + 1e-6:
                    return has((s0['hy'] + min(s1['hy'], crown + 0.01)) / 2, a)
            return True
        M.tube(secs, segs, mat, HW, keep=keep, disp=d, lod_segs=10, tint=tint, min_lod=min_lod)
    crop = lambda a: lerp(1.662, 1.738, smooth(sin(a) / 0.85)) if sin(a) > 0 else lerp(1.662, 1.598, smooth(-sin(a) / 0.8))
    bob = lambda a: lerp(1.555, 1.735, smooth((sin(a) - 0.12) / 0.4))
    for hm in ('hair_crop', 'hair_tail', 'hair_bun'): shell(hm, 0.011, crop, lo=1.59)
    # Side part: more of it, swept across from the left of the crown and falling toward the right brow.
    shell('hair_part', 0.019, lambda a: crop(a) - 0.014 * G2(a, 1.05, 0.5), lo=1.59, bump=lambda a, y: 0.75 + 0.55 * smooth((cos(a - 2.2) + 0.2) / 1.2))
    shell('hair_long', 0.017, bob, hang=1.64)
    # ...and the rest of it down the back to the shoulder blades.
    M.tube([S(1.60, 0.078, 0.020, 0.050, -0.052, w=HW), S(1.54, 0.088, 0.026, 0.050, -0.062, w=HW), S(1.47, 0.094, 0.030, 0.044, -0.082, w={'head': 0.5, 'chest': 0.5}),
            S(1.40, 0.090, 0.026, 0.036, -0.098, w={'chest': 1.0}), S(1.345, 0.070, 0.016, 0.022, -0.104, w={'chest': 1.0}), S(1.33, 0, 0, 0, -0.104, w={'chest': 1.0})],
           10, 'hair_long', tint=streak, lod_segs=6)
    shell('hair_curls', 0.030, lambda a: crop(a) - 0.008, lo=1.59, bump=lambda a, y: 1.0 + 0.32 * sin(a * 9.0) * sin(y * 150.0), segs=24)
    shell('hair_afro', 0.062, lambda a: crop(a) - 0.004, lo=1.59, top=1.0, bump=lambda a, y: (1.0 + 0.10 * sin(a * 7.0 + y * 90.0)) * (0.55 + 0.45 * smooth((y - 1.60) / 0.07)), segs=24)
    # Balding: what is left round the sides and back.
    shell('hair_bald', 0.008, crop, lo=1.59, until=lambda a: 1.712 if sin(a) < 0.25 else 1.60)
    # Pony tail and bun.
    M.tube([S(hy(1.745), 0, 0, 0, -0.085), S(hy(1.725), 0.024, None, None, -0.108), S(hy(1.66), 0.03, None, None, -0.128), S(hy(1.58), 0.026, None, None, -0.135),
            S(hy(1.50), 0.017, None, None, -0.128), S(hy(1.45), 0, 0, 0, -0.122)], 8, 'hair_tail', HW, lod_segs=5, tint=streak)
    M.ball((0, hy(1.755), -0.088), (0.042, 0.04, 0.042), 'hair_bun', HW, 8, 5, min_lod=1)
    # ── Hats ── Cap: a taller shell over the hair, and a brim for each way round it can be worn.
    shell('cap', 0.021, lambda a: 1.688, lo=1.65, rise=1.04, tint=1.0)
    for mat, sg in (('peak_f', 1), ('peak_b', -1)):
        z0 = face_z(0, hy(1.70), hk) if sg > 0 else -(head_at(hy(1.70), hk)[3] - head_at(hy(1.70), hk)[4])
        zs = [(-0.03, 0.082, 0.0), (0.03, 0.076, -0.007), (0.075, 0.060, -0.017), (0.098, 0.034, -0.023)]
        secs = [Z(z0 + sg * dz, rx * hk, 0.004, 0.004, hy(1.702) + dy) for dz, rx, dy in zs] + [Z(z0 + sg * 0.106, 0, 0, 0, hy(1.702) - 0.026)]
        M.tube([Z(z0 - sg * 0.035, 0, 0, 0, hy(1.702))] + secs, 8, mat, HW, lod_segs=6)
    # Beanie: pulled down over the ears at the back, with its cuff turned up.
    bline = lambda a: lerp(1.640, 1.690, smooth((sin(a) + 0.2) / 1.0))
    shell('beanie', 0.016, bline, lo=1.59, rise=1.03, tint=lambda p: 0.86 + 0.14 * sin(atan2(p.x, p.z) * 30.0) ** 2)
    shell('beanie', 0.023, bline, lo=1.59, rise=1.0, until=lambda a: bline(a) + 0.040, tint=0.9, min_lod=1)
    # Brimmed hat: a crown and a brim all the way round.
    shell('brimhat', 0.020, lambda a: 1.690, lo=1.65, rise=1.12, top=0.5, tint=1.0)
    _, rx, zf, zb, cz = head_at(hy(1.695), hk)
    M.tube([S(hy(1.700), rx + 0.016, zf + 0.016, zb + 0.016, cz), S(hy(1.692), rx + 0.078, zf + 0.085, zb + 0.075, cz), S(hy(1.687), rx + 0.078, zf + 0.085, zb + 0.075, cz, t=0.8),
            S(hy(1.692), rx + 0.010, zf + 0.010, zb + 0.010, cz, t=0.6)], 16, 'brimhat', HW, lod_segs=8)
    # A band round the crown, in its own colour.
    M.tube([S(hy(1.702), rx + 0.0225, zf + 0.0225, zb + 0.0225, cz), S(hy(1.720), rx + 0.0222, zf + 0.0222, zb + 0.0222, cz)], 16, 'brimhat', HW, tint=(0.03, 0.025, 0.02), cls=CLOTH + FIXED, min_lod=0)

    # ── Backpack ──
    M.tube([S(1.075, 0, 0, 0, -0.165), S(1.085, 0.095, 0.040, 0.045, -0.165, n=3.5), S(1.12, 0.125, 0.052, 0.062, -0.165, n=3.5), S(1.33, 0.120, 0.050, 0.060, -0.162, n=3.5),
            S(1.40, 0.098, 0.044, 0.046, -0.152, n=3.0), S(1.415, 0, 0, 0, -0.150)], 10, 'bag', {'chest': 1.0}, lod_segs=6)
    M.tube([S(1.11, 0.090, 0.012, 0.010, -0.222, n=3.5, t=0.8), S(1.21, 0.090, 0.016, 0.010, -0.224, n=3.5, t=0.8), S(1.215, 0, 0, 0, -0.224)], 8, 'bag', {'chest': 1.0}, min_lod=0)
    for sg in (1, -1):
        secs = []
        for i in range(13):
            th = 2 * pi * i / 12
            c = Vector((sg * 0.108, 1.303 + 0.158 * sin(th), -0.012 + 0.140 * cos(th)))
            rad = Vector((0, sin(th), cos(th)))
            secs.append(dict(c=c, rx=0.017, zf=0.004, zb=0.004, u=Vector((1, 0, 0)), v=rad, n=3.0, w={'chest': 1.0}, t=0.85))
        M.tube(secs, 4, 'bag', {'chest': 1.0}, min_lod=1, lod_segs=4, orient=Vector((sg * 0.108, 1.303, -0.012)))

    for n, s in (('l', 1), ('r', -1)):
        # Arm. d runs down from the shoulder joint.
        ua, fa, hd = 'upperarm_' + n, 'forearm_' + n, 'hand_' + n
        sx, sy, k = s * G['sh'], G['sh_y'], G['arm']
        def aw(d): return two(ua, fa, (d - UPPER + 0.035) / 0.07)
        def A(d, r, rz=None, grow=0.0, **kw):
            return S(sy - d, r * k + grow, (rz or r) * k + grow, None, -0.01, sx, w=aw(d), **kw)
        def sleeve(mat, ease, end, cuff=0.0, wr=0.0, rib=0.0, min_lod=2):
            """Shoulder to `end`; `wr` is how deep the cloth folds at the elbow, `cuff` a band at the wrist."""
            secs = [A(-0.040 - ease * 0.5, 0)]
            for i, (d, r, rz) in enumerate(ARM):
                if d >= end - 0.008: break
                g = ease + (wr * (1.0 if i % 2 else -0.35) if 0.24 < d < 0.33 else 0.0)
                # Long sleeves hang loose at the forearm, then gather.
                if d > 0.34: g += ease * 0.12
                secs.append(A(d, r, rz, g))
            r, rz = at(ARM, end)
            if cuff or rib:
                secs.append(A(end - 0.034, r, rz, ease * (0.4 if rib else 1.2) + cuff)); secs.append(A(end - 0.002, r, rz, ease * 0.4 + cuff, t=0.9))
            else:
                secs.append(A(end, r, rz, ease))
            secs.append(A(end + 0.002, r - 0.008, rz - 0.008, 0.0, t=0.5))
            M.tube(secs, 10, mat, min_lod=min_lod)
        sleeve('tee', 0.007, 0.152)
        sleeve('dress', 0.005, 0.085)
        sleeve('shirt', 0.008, 0.505, cuff=0.005, wr=0.004)
        sleeve('hoodie', 0.016, 0.510, rib=1.0, cuff=0.006, wr=0.005)
        sleeve('jacket', 0.017, 0.515, cuff=0.004, wr=0.005)
        sleeve('coverall', 0.012, 0.500, cuff=0.004, wr=0.005)
        M.tube([A(d, r, rz) for d, r, rz in ARM if d >= 0.06], 10, 'arm')
        build_hand(M, G, F, s, n, lod)

        # Leg.
        th_, sh_, ft = 'thigh_' + n, 'shin_' + n, 'foot_' + n
        lx, k = s * HIP_X, G['leg']
        def lw(y): return two(th_, sh_, (KNEE_Y + 0.04 - y) / 0.08)
        def Lg(y, rx, zf, zb, grow=0.0, cz=0.0, **kw):
            return S(y, rx * k + grow, zf * k + grow, zb * k + grow, cz, lx, w=lw(y), **kw)
        def leg(mat, ease, hem, slim=0.0, cuff=0.0, wr=0.003, flare=0.0, min_lod=2):
            """Crotch to hem. `slim` pulls the lower leg in toward the calf; `wr` folds the cloth at the knee and over the shoe."""
            secs = [Lg(0.945, 0, 0, 0)]
            for i, (y, rx, zf, zb, cz) in enumerate(TROUSER):
                if y <= hem + 0.008: break
                if y < 0.545 and slim:
                    b = at(BARE, y); rx, zf, zb = lerp(rx, b[0] + 0.006, slim), lerp(zf, b[1] + 0.006, slim), lerp(zb, b[2] + 0.006, slim)
                g = ease + (wr * (1.0 if i % 2 else -0.4) if 0.45 < y < 0.53 else 0.0)
                secs.append(Lg(y, rx, zf, zb, g, cz))
            rx, zf, zb, cz = at(TROUSER, hem)
            if slim and hem < 0.545:
                b = at(BARE, hem); rx, zf, zb = lerp(rx, b[0] + 0.006, slim), lerp(zf, b[1] + 0.006, slim), lerp(zb, b[2] + 0.006, slim)
            if cuff:
                secs.append(Lg(hem + 0.042, rx, zf, zb, ease + cuff, cz, t=0.92))
            if hem < 0.2:
                # The break: cloth stacking on the shoe.
                secs.append(Lg(hem + 0.030, rx, zf + 0.004, zb, ease + wr * 1.4 + cuff, cz))
            secs.append(Lg(hem, rx, zf, zb, ease + flare + cuff, cz, t=0.9))
            secs.append(Lg(hem + 0.003, rx - 0.016, zf - 0.016, zb - 0.016, 0.0, cz, t=0.45))
            M.tube(secs, 12, mat, min_lod=min_lod)
        leg('trousers', 0.0, 0.100)
        leg('jeans', -0.002, 0.108, slim=0.55, cuff=0.004, wr=0.004)
        leg('shorts', 0.004, 0.555, flare=0.008, wr=0.0)
        M.tube([Lg(y, rx, zf, zb, 0.0, cz) for y, rx, zf, zb, cz in BARE], 12, 'leg')
        # Shoes, heel to toe. A sneaker's sole is pale rubber whatever the upper is; a boot has a dark one and a shaft up the shin.
        fk = G['foot']
        last = [(-0.066, 0.028, 0.040, 0.050), (-0.045, 0.038, 0.014, 0.090), (0.0, 0.044, 0.014, 0.100), (0.045, 0.048, 0.013, 0.078), (0.095, 0.051, 0.013, 0.060),
                (0.145, 0.049, 0.012, 0.050), (0.180, 0.036, 0.012, 0.040)]
        for mat, sole, upper, grow, toe in (('sneakers', (0.74, 0.73, 0.68), CLOTH, 0.0, 0.0), ('boots', (0.022, 0.020, 0.018), LEATHER, 0.003, 0.008)):
            secs = [Z(-0.074 * fk - grow, 0, 0, 0, 0.035, lx)]
            for z, rx, cy, top in last:
                tp = top + (toe if z > 0.04 else 0.0)
                secs.append(Z(z * fk, rx * fk + grow, tp - cy, cy - 0.001, cy, lx, n=2.6))
            secs.append(Z(0.193 * fk + grow, 0, 0, 0, 0.018, lx))
            M.tube(secs, 10, mat, {ft: 1.0}, tint=lambda p, c=sole: c if p.y < 0.017 else 1.0, lod_segs=6,
                   cls=lambda p, u=upper: RUBBER + FIXED if p.y < 0.017 else u)
        b0 = at(BARE, 0.215)
        M.tube([Lg(0.06, 0.047, 0.050, 0.052, t=0.8), Lg(0.13, 0.046, 0.048, 0.051), Lg(0.205, b0[0] + 0.010, b0[1] + 0.010, b0[2] + 0.010),
                Lg(0.222, b0[0] + 0.013, b0[1] + 0.013, b0[2] + 0.013, t=0.9), Lg(0.218, b0[0], b0[1], b0[2], t=0.5)], 10, 'boots', {sh_: 1.0}, lod_segs=5)
    return M


def build_face_extras(M, F, lod):
    """Things that sit on the face and must move with it when it changes: beard, stubble, glasses. Built before the head is scaled."""
    HW = {'head': 1.0}
    def on(x, y, off):
        rx = head_at(y)[1] * 0.985
        return face_xy(F, max(-rx, min(rx, x)), y, off, lod)
    def region(x, y):
        """How much beard there is at a spot: 0 none, 1 full."""
        ax = abs(x)
        if ax < 0.021 and 1.576 < y < 1.5905: return 0.0                     # the mouth
        if y > 1.5905 and ax < 0.027: return clamp((1.6035 - y) / 0.004) * clamp((0.027 - ax) / 0.004)   # moustache
        side = smooth((ax - 0.018) / 0.010)
        top = 1.586 + 0.050 * smooth((ax - 0.032) / 0.03)                      # up the jaw toward the sideburn
        return clamp((top - y) / 0.010) * (1.0 if y < 1.576 else side)
    nc = 14
    cols = [c for c in (head_cols() if lod == 0 else [(-pi / 2 + 2 * pi * k / nc, None) for k in range(nc)]) if -0.05 < c[0] < pi + 0.05]
    rws = [r for r in (FACE_ROWS if lod == 0 else COARSE_ROWS) if r[0] < 1.645]
    for mat, off, lift in (('beard', 0.0070, 1.0), ('stubble', 0.0012, 0.0)):
        rows = []; R = []
        for y, tag in rws:
            row = []; rr = []
            for a, t in cols:
                p0, _ = face_point(F, a, y, t, tag, lod)
                r = region(p0.x, y); rr.append(r)
                o = off * (1.0 + 0.5 * G2(y, 1.545, 0.012) * G2(p0.x, 0, 0.03)) if lift else off
                pt, _ = face_point(F, a, y, t, tag, lod, off=lerp(-0.0008, o, smooth(r / 0.7)))
                row.append((pt, HW, 0.86 + 0.14 * sin(p0.x * 900 + y * 700) ** 2))
            rows.append(row); R.append(rr)
        M.grid(rows, mat, closed=False, keep=lambda j, k, R=R: max(R[j][k], R[j][k + 1], R[j + 1][k], R[j + 1][k + 1]) > 0.0,
               orient=Vector((0, 1.58, -0.2)), min_lod=1 if lift else 0)
    # Glasses: two rims, a bridge, and arms back to the ears.
    for s in (1, -1):
        E = eye_c(F, s); cx = s * (EX + 0.0015); z0 = E.z + ER + 0.0105
        ring = lambda rx, ry, dz, t: [(Vector((cx + rx * cos(2 * pi * i / 12), EY - 0.001 + ry * sin(2 * pi * i / 12), z0 + dz - 0.004 * (cos(2 * pi * i / 12) * s > 0.5))), HW, t) for i in range(12)]
        M.grid([ring(0.0185, 0.0140, -0.002, 0.7), ring(0.0185, 0.0140, 0.0, 1.0), ring(0.0222, 0.0175, 0.0, 1.0), ring(0.0222, 0.0175, -0.002, 0.7)], 'glasses', orient=Vector((cx, EY, z0 - 0.3)), min_lod=1)
        M.tube([Z(z0 - 0.004, 0.0013, 0.0022, 0.0022, EY + 0.003, s * (EX + 0.0225)), Z(z0 - 0.03, 0.0013, 0.0022, 0.0022, EY + 0.004, s * 0.066), Z(-0.012, 0.0013, 0.0022, 0.0022, EY + 0.002, s * 0.0795)],
               4, 'glasses', HW, min_lod=0)
    zb = eye_c(F, 1).z + ER + 0.0105
    M.grid([[(Vector((x, EY + 0.006, zb + 0.001 - 0.0)), HW, 1.0) for x in (-0.011, 0.0, 0.011)], [(Vector((x, EY + 0.002, zb + 0.001)), HW, 1.0) for x in (-0.011, 0.0, 0.011)]],
           'glasses', closed=False, orient=Vector((0, EY, zb - 0.3)), min_lod=0)


# ── Into Blender ─────────────────────────────────────────────────────────────

DIRS = []
for i in range(24):
    zz = 0.15 + 0.85 * (i + 0.5) / 24; rr = sqrt(1 - zz * zz); aa = i * 2.39996
    DIRS.append((rr * cos(aa), rr * sin(aa), zz))


def occlusion(bm, M):
    """Per vertex, against the part itself and a default outfit. Arms and the rest ignore each other: in the bind pose the arm hangs against a hip it never touches in the game."""
    armv = [any('arm' in k or 'hand' in k for k in w) for w in M.W]
    faces = {}; nv = len(bm.verts); vpart = [None] * nv
    for f in bm.faces:
        ids = [v.index for v in f.verts]; n = MATS[f.material_index]
        faces.setdefault(n, []).append(ids)
        for i in ids: vpart[i] = n
    V = [v.co.copy() for v in bm.verts] + [Vector((-9, -9, 0)), Vector((9, -9, 0)), Vector((9, 9, 0)), Vector((-9, 9, 0))]
    trees = {}
    def tree(part, cls):
        if (part, cls) not in trees:
            who = {part} | {o for o in OCCLUDERS if SLOT[o] != SLOT[part] and not (part in ('leg', 'arm') and SLOT[o] in ('top', 'bottom'))}
            F = [f for q in who for f in faces.get(q, []) if all(armv[i] == cls for i in f)]
            F.append([nv + i for i in range(4)])
            trees[(part, cls)] = BVHTree.FromPolygons(V, F)
        return trees[(part, cls)]
    ao = []
    for v in bm.verts:
        p = vpart[v.index]
        if p is None: ao.append(1.0); continue
        n = v.normal; t = n.orthogonal().normalized(); b = n.cross(t); o = v.co + n * 0.003; occ = 0.0; tr = tree(p, armv[v.index])
        for dx, dy, dz in DIRS:
            hit = tr.ray_cast(o, t * dx + b * dy + n * dz, 0.16)
            if hit[0] is not None: occ += 1 - hit[3] / 0.16
        a = 0.45 + 0.55 * max(0.0, 1 - occ / len(DIRS) * 1.3)
        ao.append(max(a, 0.85) if CLS[p] == EYE_C else a)
    return ao


def to_blender(M, name, arm_ob, D=None):
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('uv'); col = bm.loops.layers.color.new('Col'); cl = bm.verts.layers.float.new('_cls')
    vs = [bm.verts.new(B(*p)) for p in M.V]
    for v, c in zip(vs, M.C): v[cl] = c / 16.0
    for f, m, t in zip(M.F, M.FM, M.FUV):
        try: face = bm.faces.new([vs[i] for i in f])
        except ValueError: continue
        face.material_index = m; face.smooth = True
        for l, uv in zip(face.loops, t): l[uvl].uv = uv
    bm.verts.index_update(); bm.normal_update()
    ao = occlusion(bm, M)
    me = bpy.data.meshes.new(name)
    for n in MATS: me.materials.append(bpy.data.materials[n])
    for f in bm.faces:
        for l in f.loops:
            a = ao[l.vert.index]; t = M.T[l.vert.index]; l[col] = (a * t[0], a * t[1], a * t[2], M.C[l.vert.index] / 16.0)
    bm.to_mesh(me); bm.free()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons)); me.update()
    me.color_attributes.active_color = me.color_attributes['Col']
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    for bone in arm_ob.data.bones: ob.vertex_groups.new(name=bone.name)
    for i, w in enumerate(M.W):
        for k, x in w.items():
            if x > 0: ob.vertex_groups[k].add([i], x, 'REPLACE')
    if D:
        ob.shape_key_add(name='Basis', from_mix=False)
        for k, dk in enumerate(D):
            kb = ob.shape_key_add(name=f'm{k}', from_mix=False); kb.slider_min = -2.0; kb.slider_max = 2.0; kb.value = 0.0
            kb.data.foreach_set('co', [c for v, d in zip(M.V, dk) for c in B(*(v + d))])
    ob.parent = arm_ob
    ob.modifiers.new('arm', 'ARMATURE').object = arm_ob
    return ob


def armature(J):
    ad = bpy.data.armatures.new('rig'); ob = bpy.data.objects.new('rig', ad)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    for n, (p, par) in J.items():
        b = ad.edit_bones.new(n); b.head = B(*p); b.tail = B(*p) + Vector((0, 0, 0.06)); b.roll = 0
        if par: b.parent = ad.edit_bones[par]
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def make_materials():
    for n in MATS:
        m = bpy.data.materials.new(n)
        try: m.use_nodes = True
        except Exception: pass
        nt = m.node_tree
        bsdf = next((x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None: continue
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'Col'
        mul = nt.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = PREVIEW[n]
        nt.links.new(at.outputs['Color'], mul.inputs[0]); nt.links.new(mul.outputs[0], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = {SKIN_C: 0.5, EYE_C: 0.08, HAIR_C: 0.6, LEATHER: 0.5}.get(CLS[n], 0.85)
        m.use_backface_culling = True


def pose(arm_ob, P):
    """P: bone -> (axis in the game's frame, angle). Rotations are about the rest frame's axes, parent first."""
    for pb in arm_ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (1, 0, 0, 0)
        if pb.name in P:
            R0 = pb.bone.matrix_local.to_3x3(); q = Matrix.Identity(3)
            for ax, ang in P[pb.name]:
                q = q @ Quaternion(B(*ax), ang).to_matrix()
            pb.rotation_quaternion = (R0.inverted() @ q @ R0).to_quaternion()
    bpy.context.view_layer.update()


REST = {'upperarm_l': [((0, 0, 1), 0.12)], 'upperarm_r': [((0, 0, 1), -0.12)], 'forearm_l': [((1, 0, 0), -0.2)], 'forearm_r': [((1, 0, 0), -0.2)]}
BEND = {'upperarm_l': [((1, 0, 0), -1.3)], 'forearm_l': [((1, 0, 0), -1.5)], 'upperarm_r': [((0, 0, 1), -1.45)], 'forearm_r': [((1, 0, 0), -0.6)],
        'thigh_l': [((1, 0, 0), -1.15)], 'shin_l': [((1, 0, 0), 1.5)], 'thigh_r': [((1, 0, 0), 0.3)], 'shin_r': [((1, 0, 0), 0.5)],
        'chest': [((0, 1, 0), 0.3)], 'spine': [((1, 0, 0), 0.15)], 'head': [((0, 1, 0), -0.5)], 'shoulder_r': [((0, 0, 1), -0.25)]}
BASE_SHOW = {'head', 'body', 'eyewhite', 'iris', 'brow'}
STAGE = None


def stage():
    """Lights, floor and camera for the preview sheets, once."""
    global STAGE
    if STAGE: return STAGE
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    try: sc.eevee.taa_render_samples = 24
    except Exception: pass
    w = bpy.data.worlds.new('w'); sc.world = w
    try: w.use_nodes = True
    except Exception: pass
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.55, 0.62, 0.72, 1); bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 3.5; sun.angle = radians(3)
    so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so); so.rotation_euler = (radians(52), 0, radians(40))
    gm = bpy.data.materials.new('ground')
    try: gm.use_nodes = True
    except Exception: pass
    next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value = (0.2, 0.2, 0.21, 1)
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    gme = bpy.data.meshes.new('ground'); bm.to_mesh(gme); bm.free(); gme.materials.append(gm)
    sc.collection.objects.link(bpy.data.objects.new('ground', gme))
    tgt = bpy.data.objects.new('tgt', None); sc.collection.objects.link(tgt)
    cam = bpy.data.cameras.new('cam')
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    c = co.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    STAGE = (sc, co, cam, tgt)
    return STAGE


def void():
    m = bpy.data.materials.get('void')
    if m: return m
    m = bpy.data.materials.new('void')
    try: m.use_nodes = True
    except Exception: pass
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type != 'OUTPUT_MATERIAL': nt.nodes.remove(n)
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    nt.links.new(tr.outputs[0], next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL').inputs['Surface'])
    return m


def sheet(kind, name, arm_ob, obs, shots, W, H, ncols):
    """Each shot: dict(lod, cam, tgt, lens, pose, show (part names), keys (morph slot -> weight))."""
    import numpy as np
    sc, co, cam, tgt = stage()
    sc.render.resolution_x, sc.render.resolution_y = W, H
    os.makedirs(os.path.join(ROOT, 'shots', 'blender'), exist_ok=True)
    nrows = (len(shots) + ncols - 1) // ncols
    out = np.zeros((H * nrows, W * ncols, 4), dtype=np.float32)
    for ob in obs: ob.hide_render = True
    for i, sh in enumerate(shots):
        pose(arm_ob, sh.get('pose', REST))
        co.location = B(*sh['cam']); tgt.location = B(*sh.get('tgt', (0, 0.9, 0))); cam.lens = sh.get('lens', 70)
        src = obs[sh.get('lod', 0)]
        # Hiding a part is done on a copy with those faces removed.
        tmp = src.copy(); tmp.data = src.data.copy(); sc.collection.objects.link(tmp)
        show = BASE_SHOW | set(sh['show'])
        # A part is hidden by swapping its material for a clear one. (Deleting faces through bmesh scrambles the shape keys.)
        for mi, n in enumerate(MATS):
            if n not in show: tmp.data.materials[mi] = void()
        tmp.hide_render = False
        if tmp.data.shape_keys:
            for k, v in sh.get('keys', {}).items(): tmp.data.shape_keys.key_blocks[f'm{k}'].value = v
        path = os.path.join(ROOT, 'shots', 'blender', f'_person_{i}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(path); px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)
        r, c = divmod(i, ncols)
        out[(nrows - 1 - r) * H:(nrows - r) * H, c * W:(c + 1) * W] = px
        bpy.data.images.remove(img); os.remove(path)
        bpy.data.objects.remove(tmp)
    im = bpy.data.images.new('sheet', W * ncols, H * nrows)
    im.pixels.foreach_set(out.ravel())
    im.filepath_raw = os.path.join(ROOT, 'shots', 'blender', f'person_{kind}_{name}.jpg'); im.file_format = 'JPEG'
    im.save(); bpy.data.images.remove(im)
    pose(arm_ob, {})


DESS = ['coverall', 'trousers', 'belt', 'boots', 'hair_tail', 'cap', 'peak_f']
OUTFITS = [DESS,
           ['tee', 'arm', 'jeans', 'sneakers', 'hair_long'],
           ['dress', 'arm', 'leg', 'sneakers', 'hair_bun', 'glasses'],
           ['hoodie', 'shorts', 'leg', 'sneakers', 'hair_curls', 'bag'],
           ['jacket', 'tee', 'skirt', 'leg', 'boots', 'hair_crop', 'beanie'],
           ['shirt', 'trousers', 'boots', 'hair_afro', 'stubble'],
           ['shirt', 'jeans', 'sneakers', 'hair_bald', 'beard', 'brimhat', 'glasses'],
           ['tee', 'arm', 'shorts', 'leg', 'sneakers', 'hair_part', 'bag']]


def sheets(kind, G, arm_ob, obs, which):
    hk = G['head']; ey = HEAD_Y + (1.640 - HEAD_Y) * hk
    out = {}
    wear = ['tee', 'arm', 'trousers', 'sneakers']
    # Four faces from one head: the game mixes these per person.
    faces = [{}, {0: 0.8, 1: 0.5, 2: 0.7}, {0: -0.8, 1: -0.6, 2: -0.4, 4: 1.0}, {0: 0.3, 1: 0.9, 2: 0.2, 3: 1.0}]
    hairs = [['hair_tail'], ['hair_long' if kind == 'f' else 'hair_part'], ['hair_curls', 'stubble'], ['hair_bald', 'beard'] if kind == 'm' else ['hair_afro', 'glasses']]
    out['faces'] = ([dict(cam=(0.0, ey, 0.95), tgt=(0, ey, 0.02), lens=85, show=wear + h, keys=k) for k, h in zip(faces, hairs)] +
                    [dict(cam=(0.62, ey + 0.02, 0.72), tgt=(0, ey, 0.02), lens=85, show=wear + h, keys=k) for k, h in zip(faces, hairs)] +
                    [dict(cam=(0.95, ey, 0.02), tgt=(0, ey, 0.02), lens=85, show=wear + h, keys=k) for k, h in zip(faces[:2], hairs)] +
                    [dict(cam=(0.0, ey + 0.015, 0.9), tgt=(0.02, ey + 0.015, 0.02), lens=400, show=wear, keys={}),
                     dict(cam=(0.5, ey + 0.015, 0.75), tgt=(0.02, ey + 0.015, 0.02), lens=400, show=wear, keys={})], 400, 460, 4)
    out['body'] = ([dict(cam=(0.0, 1.0, 4.9), show=DESS), dict(cam=(4.9, 1.0, 0.0), show=DESS), dict(cam=(-2.6, 1.5, -4.0), show=DESS),
                    dict(cam=(3.0, 1.3, 3.9), pose=BEND, show=DESS), dict(cam=(1.6, 1.0, 4.6), lod=1, show=DESS), dict(cam=(1.6, 1.0, 4.6), lod=2, show=DESS)], 350, 760, 6)
    out['wardrobe'] = ([dict(cam=(1.9, 1.15, 4.5), show=o) for o in OUTFITS[1:5]] + [dict(cam=(-2.2, 1.3, -4.2), show=OUTFITS[3]), dict(cam=(1.9, 1.15, 4.5), show=OUTFITS[5])] +
                       [dict(cam=(1.9, 1.15, 4.5), show=o) for o in OUTFITS[6:]], 380, 760, 4)
    hx, hyy = G['sh'], G['sh_y'] - UPPER - FORE - 0.07
    hv = lambda c, k={}: dict(cam=(hx + c[0], hyy + c[1], c[2]), tgt=(hx, hyy, 0.0), lens=300, show=['arm'], pose={}, keys=k)
    out['hands'] = [hv((1.5, 0, 0)), hv((0, 0, 1.5)), hv((-1.5, 0, 0)), hv((-1.0, -0.2, 1.0)),
                    hv((-1.0, 0, 1.0), {0: 1.0}), hv((-1.0, 0, 1.0), {1: 1.0}), hv((-1.0, 0, 1.0), {2: 1.0}), hv((1.0, 0.3, 1.0), {0: 1.0})], 380, 380, 4
    for n in which:
        if n in out: sheet(kind, n, arm_ob, obs, *out[n])


def build(kind, do_render=True, do_export=True, which=('faces', 'body', 'wardrobe', 'hands')):
    G = BODY[kind]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    global STAGE
    STAGE = None
    make_materials()
    arm_ob = armature(joints(G))
    bodies = []; stats = {}
    for lod in (0, 1, 2):
        M = person(G, lod, F0)
        D = None
        if lod == 0:
            D = [[b - a for a, b in zip(M.V, person(G, 0, {**F0, **sl}).V)] for sl in SLOTS]
            stats['morphed'] = [sum(1 for d in dk if d.length > 1e-7) for dk in D]
        ob = to_blender(M, f'LOD{lod}', arm_ob, D)
        bodies.append(ob)
        by = {}
        for p in ob.data.polygons: by[MATS[p.material_index]] = by.get(MATS[p.material_index], 0) + len(p.vertices) - 2
        stats[f'LOD{lod}'] = sum(by.values())
        stats[f'worn{lod}'] = sum(v for k, v in by.items() if k in BASE_SHOW or k in DESS)
        if lod == 0: stats['parts'] = by
    ys = [v.co.z for v in bodies[0].data.vertices]
    stats['feet_to_crown'] = [round(min(ys), 3), round(max(ys), 3)]
    if do_export:
        out = os.path.join(ROOT, 'public', 'models'); os.makedirs(out, exist_ok=True)
        path = os.path.join(out, f'person_{kind}.glb')
        bpy.ops.object.select_all(action='DESELECT')
        arm_ob.select_set(True)
        for b in bodies: b.select_set(True)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                                  export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
                                  export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_attributes=False,
                                  export_active_vertex_color_when_no_material=True, export_animations=False,
                                  export_skins=True, export_morph=True, export_morph_normal=False, export_try_sparse_sk=True, export_try_omit_sparse_sk=True,
                                  export_extras=False)
        stats['kB'] = round(os.path.getsize(path) / 1000)
        import struct
        with open(path, 'rb') as fh:
            fh.seek(12); n, _ = struct.unpack('<II', fh.read(8)); g = json.loads(fh.read(n))
        stats['nodes'] = len(g['nodes']); stats['joints'] = len(g['skins'][0]['joints']) if g.get('skins') else 0
        pr = g['meshes'][0]['primitives'][0]
        stats['attrs'] = sorted(pr['attributes']); stats['targets'] = len(pr.get('targets', []))
    print('STATS ' + json.dumps({kind: stats}))
    if do_render: sheets(kind, G, arm_ob, bodies, which)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    kinds = [a for a in argv if not a.startswith('--') and a in BODY] or list(BODY)
    which = argv[argv.index('--sheets') + 1].split(',') if '--sheets' in argv else ('faces', 'body', 'wardrobe', 'hands')
    for k in kinds:
        build(k, '--no-render' not in argv, '--no-export' not in argv, which)
