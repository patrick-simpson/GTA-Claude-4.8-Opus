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
#   _CLS (a custom attribute) is the surface class / 16: skin, cloth, leather,
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
        sh=0.185, sh_y=1.378, arm=1.0, leg=1.0, neck=0.060, head=1.0, hand=1.0, foot=1.0,
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
HEAD = [(1.534, 0.022, 0.026, 0.030, 0.052), (1.540, 0.032, 0.042, 0.040, 0.047), (1.548, 0.040, 0.048, 0.050, 0.040), (1.566, 0.052, 0.060, 0.072, 0.028),
        (1.590, 0.062, 0.074, 0.088, 0.016), (1.620, 0.067, 0.082, 0.096, 0.010), (1.650, 0.071, 0.084, 0.100, 0.008),
        (1.680, 0.074, 0.088, 0.102, 0.008), (1.710, 0.072, 0.085, 0.099, 0.008), (1.730, 0.063, 0.074, 0.089, 0.007),
        (1.745, 0.047, 0.055, 0.068, 0.005), (1.753, 0.027, 0.032, 0.040, 0.004)]
HEAD = [(y, rx * 1.06, zf, zb, cz) for y, rx, zf, zb, cz in HEAD]
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


class Model:
    def __init__(s, lod):
        s.lod = lod; s.V = []; s.W = []; s.T = []; s.C = []; s.F = []; s.FM = []; s.FUV = []

    def grid(s, rows, mat, closed=True, cls=None, uv=None, us=None, vs=None, keep=None, orient=None, min_lod=1):
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

    def tube(s, secs, segs, mat, w=None, keep=None, disp=None, tint=1.0, lod_segs=None, min_lod=1, cls=None, uv=None, seam=-pi / 2, orient=None):
        """Loft the rings in order. A ring with rx 0 is a pole. `keep(y, a)` drops faces; `disp(a, sec)` pushes a vertex along its radius."""
        if s.lod > min_lod: return
        if s.lod:
            segs = lod_segs or max(5, segs // 2)
            secs = thin([dict(x, w=x.get('w', w)) for x in secs])
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
        if y >= 1.6135: h = (0.0020 + 0.0195 * (1 - clamp((y - 1.6135) / 0.0625) ** 0.85)) * smooth((1.684 - y) / 0.012)
        else: h = lerp(0.0215, 0.0032, smooth((1.6135 - y) / 0.008))
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
            ylo = ec - 0.0034 * o; yup = lerp(ec + 0.0043 * o, ylo + 0.0003, F['blink'])
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
        q = sqrt(((x - E.x) / 0.0150) ** 2 + ((y - E.y) / 0.0085) ** 2)
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
    cols = head_cols() if lod == 0 else [(-pi / 2 + 2 * pi * k / 14, None) for k in range(14)]
    rws = FACE_ROWS if lod == 0 else COARSE_ROWS
    rows = [[(Vector((0, 1.528, HEAD[0][4] - 0.004)), HW, 1.0)]]
    for y, tag in rws:
        row = []
        for a, t in cols:
            p, tn = face_point(F, a, y, t, tag, lod); row.append((p, HW, tn))
        rows.append(row)
    rows.append([(Vector((0, 1.758, HEAD[-1][4])), HW, 1.0)])
    tags = [None] + [t for _, t in rws]
    inside = [t is not None and abs(t) <= 1.0001 for _, t in cols]
    n = len(cols)
    def keep(j, k):
        return not (tags[j] in ('lo', 'mid') and inside[k] and inside[(k + 1) % n])
    M.grid(rows, 'head', keep=keep if lod == 0 else None, uv='head')
    for s in (1, -1):
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


def person(G, lod, F):
    M = Model(lod)
    hk = G['head']
    F = {k: v + G['face'].get(k, 0.0) for k, v in F.items()}
    HW = {'head': 1.0}
    def hy(y): return HEAD_Y + (y - HEAD_Y) * hk

    build_head(M, F, lod)
    M.scale_from(0, Vector((0, HEAD_Y, 0)), hk)

    # Trousers' seat, then the shirt over it.
    P = G['pants']
    secs = [S(0.775, 0, 0, 0, P[0][4])] + [S(y, rx, zf, zb, cz, n=2.3) for y, rx, zf, zb, cz in P] + [S(P[-1][0] + 0.005, 0, 0, 0, 0)]
    M.tube(secs, 16, 'trousers', {'hips': 1.0})

    def torso_w(y):
        def w(a, p):
            base = two('hips', 'spine', (y - 0.96) / 0.12) if y < 1.14 else two('spine', 'chest', (y - 1.14) / 0.12)
            # The outer corners of the shoulder line ride the collar bones.
            t = clamp((y - 1.30) / 0.07) * clamp((abs(p.x) - 0.07) / 0.07) * 0.7
            return {'chest': 1 - t, 'shoulder_l' if p.x > 0 else 'shoulder_r': t} if t > 0.02 else base
        return w
    T = G['shirt']
    secs = [S(T[0][0], T[0][1] - 0.012, T[0][2] - 0.012, T[0][3] - 0.012, T[0][4], n=2.3, w={'hips': 1.0}, t=0.75)]
    secs += [S(y, rx, zf, zb, cz, n=2.3 if y < 1.42 else 2.0, w=torso_w(y)) for y, rx, zf, zb, cz in T]
    secs.append(S(T[-1][0] + 0.002, G['neck'] + 0.002, None, None, T[-1][4], w={'chest': 1.0}, t=0.7))
    M.tube(secs, 16, 'tee')

    # Neck.
    nk = G['neck']
    secs = [S(1.44, nk + 0.004, nk + 0.002, nk + 0.010, -0.016, w={'chest': 1.0}), S(1.47, nk, nk - 0.002, nk + 0.006, -0.018, w={'chest': 0.5, 'neck': 0.5}),
            S(1.50, nk - 0.002, nk - 0.005, nk + 0.004, -0.021, w={'neck': 1.0}), S(1.535, nk - 0.002, nk - 0.006, nk + 0.006, -0.021, w={'neck': 0.5, 'head': 0.5}),
            S(1.580, nk, nk - 0.004, nk + 0.010, -0.018, w={'head': 1.0})]
    M.tube(secs, 10, 'head')

    # Hair. A shell over the skull whose edge dives under the skin at the hairline.
    def shell(mat, off, line, top=1.0, hang=None, lo=1.56, rise=1.0):
        def d(a, sec):
            return off * clamp((sec['hy'] - line(a)) / 0.022, -0.5, 1.0)
        secs = []
        for h in HEAD:
            if h[0] < lo: continue
            y, rx, zf, zb, cz = head_at(hy(max(h[0], hang) if hang else h[0]), hk)
            yy = hy(h[0]); yy = hy(lo) + (yy - hy(lo)) * rise
            secs.append(S(yy, rx, zf, zb, cz, hy=h[0], n=2.15))
        secs.append(S(secs[-1]['c'].y + (0.006 * hk + off) * top, 0, 0, 0, secs[-1]['c'].z, hy=9.0))
        M.tube(secs, 20, mat, HW, keep=lambda y, a: HEAD_Y + (y - HEAD_Y) / hk > line(a) - 0.004, disp=d, lod_segs=10)
    crop = lambda a: lerp(1.662, 1.722, smooth(sin(a) / 0.85)) if sin(a) > 0 else lerp(1.662, 1.598, smooth(-sin(a) / 0.8))
    bob = lambda a: lerp(1.555, 1.712, smooth((sin(a) - 0.45) / 0.3))
    for hm in ('hair_crop', 'hair_tail', 'hair_bun'): shell(hm, 0.011, crop, lo=1.59)
    shell('hair_long', 0.017, bob, hang=1.64)
    # Pony tail and bun.
    M.tube([S(hy(1.725), 0, 0, 0, -0.085), S(hy(1.71), 0.024, None, None, -0.105), S(hy(1.66), 0.03, None, None, -0.128), S(hy(1.58), 0.026, None, None, -0.135),
            S(hy(1.50), 0.017, None, None, -0.128), S(hy(1.45), 0, 0, 0, -0.122)], 8, 'hair_tail', HW, lod_segs=5)
    M.ball((0, hy(1.735), -0.088), (0.042, 0.04, 0.042), 'hair_bun', HW, 8, 5)
    # Cap: a taller shell over the hair, and a brim for each way round it can be worn.
    shell('cap', 0.021, lambda a: 1.688, lo=1.65, rise=1.12)
    for mat, sg in (('peak_f', 1), ('peak_b', -1)):
        z0 = face_z(0, hy(1.70), hk) if sg > 0 else -(head_at(hy(1.70), hk)[3] - head_at(hy(1.70), hk)[4])
        zs = [(-0.03, 0.082, 0.0), (0.03, 0.076, -0.007), (0.075, 0.060, -0.017), (0.098, 0.034, -0.023)]
        secs = [Z(z0 + sg * dz, rx * hk, 0.004, 0.004, hy(1.702) + dy) for dz, rx, dy in zs] + [Z(z0 + sg * 0.106, 0, 0, 0, hy(1.702) - 0.026)]
        M.tube([Z(z0 - sg * 0.035, 0, 0, 0, hy(1.702))] + secs, 8, mat, HW, lod_segs=6)

    for n, s in (('l', 1), ('r', -1)):
        # Arm. d runs down from the shoulder joint.
        ua, fa, hd = 'upperarm_' + n, 'forearm_' + n, 'hand_' + n
        sx, sy, k = s * G['sh'], G['sh_y'], G['arm']
        def aw(d): return two(ua, fa, (d - UPPER + 0.035) / 0.07)
        def A(d, r, rz=None, grow=0.0, **kw):
            return S(sy - d, r * k + grow, (rz or r) * k + grow, None, -0.01, sx, w=aw(d), **kw)
        M.tube([A(-0.040, 0), A(-0.033, 0.026), A(-0.018, 0.043, 0.045), A(0.010, 0.053, 0.056), A(0.06, 0.054, 0.057), A(0.12, 0.051, 0.054),
                A(0.150, 0.050, 0.053, t=0.8), A(0.152, 0.040, 0.042, t=0.6)], 10, 'tee')
        M.tube([A(0.13, 0.046, 0.049), A(0.20, 0.045, 0.048), A(0.245, 0.042, 0.044), A(0.265, 0.041, 0.043), A(0.28, 0.041, 0.043), A(0.295, 0.042, 0.043),
                A(0.315, 0.043, 0.045), A(0.36, 0.043, 0.047), A(0.44, 0.035, 0.039), A(0.50, 0.027, 0.033), A(0.53, 0.023, 0.031)], 10, 'arm')
        g = 0.007
        M.tube([A(0.14, 0.046, 0.049, g), A(0.20, 0.045, 0.048, g), A(0.245, 0.042, 0.044, g), A(0.265, 0.041, 0.043, g), A(0.28, 0.041, 0.043, g),
                A(0.295, 0.042, 0.043, g), A(0.315, 0.043, 0.045, g), A(0.36, 0.043, 0.047, g), A(0.44, 0.036, 0.040, g), A(0.495, 0.030, 0.035, g, t=0.8),
                A(0.497, 0.020, 0.026, t=0.6)], 10, 'shirt')
        # Hand: a mitten hanging palm inward, fingers curling toward the leg, and a thumb forward of it.
        wy, hk2 = sy - UPPER - FORE, G['hand']
        def Hn(d, rx, rz, curl=0.0, fz=0.0):
            return S(wy - d * hk2, rx * hk2, rz * hk2, None, -0.01 + fz * hk2, sx - s * curl * hk2)
        M.tube([Hn(-0.015, 0.021, 0.029), Hn(0.02, 0.019, 0.037, 0, 0.003), Hn(0.055, 0.017, 0.043, 0.001, 0.005), Hn(0.085, 0.015, 0.042, 0.004, 0.007),
                Hn(0.125, 0.012, 0.038, 0.012, 0.009), Hn(0.160, 0.010, 0.030, 0.022, 0.010), Hn(0.178, 0, 0, 0.028, 0.010)], 8, 'body', {hd: 1.0}, lod_segs=5)
        th = [(0.022, 0.030, 0.012), (0.045, 0.047, 0.012), (0.075, 0.058, 0.010), (0.098, 0.062, 0.008)]
        M.tube([Hn(0.008, 0, 0, 0.0, 0.02)] + [S(wy - d * hk2, r * hk2, None, None, -0.01 + fz * hk2, sx - s * 0.006) for d, fz, r in th] + [Hn(0.108, 0, 0, 0.006, 0.062)],
               6, 'body', {hd: 1.0}, min_lod=0)

        # Leg.
        th_, sh_, ft = 'thigh_' + n, 'shin_' + n, 'foot_' + n
        lx, k = s * HIP_X, G['leg']
        def lw(y): return two(th_, sh_, (KNEE_Y + 0.04 - y) / 0.08)
        def Lg(y, rx, zf, zb, grow=0.0, cz=0.0, **kw):
            return S(y, rx * k + grow, zf * k + grow, zb * k + grow, cz, lx, w=lw(y), **kw)
        M.tube([Lg(0.945, 0, 0, 0), Lg(0.925, 0.055, 0.066, 0.070), Lg(0.88, 0.078, 0.090, 0.097, 0, -0.004), Lg(0.82, 0.084, 0.092, 0.096, 0, -0.004),
                Lg(0.70, 0.082, 0.089, 0.087), Lg(0.60, 0.074, 0.080, 0.075), Lg(0.545, 0.068, 0.073, 0.068, t=0.8), Lg(0.543, 0.052, 0.058, 0.054, t=0.6)], 12, 'trousers')
        skin = [(0.56, 0.056, 0.060, 0.058), (0.52, 0.053, 0.059, 0.054), (0.50, 0.052, 0.060, 0.052), (0.48, 0.051, 0.060, 0.051), (0.46, 0.050, 0.057, 0.052),
                (0.44, 0.049, 0.053, 0.056), (0.37, 0.056, 0.050, 0.072), (0.30, 0.052, 0.047, 0.066), (0.20, 0.041, 0.042, 0.048), (0.13, 0.035, 0.037, 0.040), (0.07, 0.035, 0.037, 0.040)]
        M.tube([Lg(*r) for r in skin], 12, 'leg')
        # The trouser leg hangs from the knee rather than hugging the calf.
        tr = [(0.545, 0.068, 0.073, 0.068), (0.52, 0.066, 0.071, 0.066), (0.50, 0.065, 0.071, 0.064), (0.48, 0.064, 0.071, 0.063), (0.46, 0.064, 0.069, 0.063),
              (0.44, 0.063, 0.067, 0.065), (0.37, 0.063, 0.061, 0.071), (0.30, 0.060, 0.059, 0.067), (0.20, 0.056, 0.057, 0.060), (0.105, 0.055, 0.058, 0.058)]
        M.tube([Lg(*r) for r in tr] + [Lg(0.103, 0.036, 0.04, 0.04, t=0.5)], 12, 'trousers')
        # Shoe, heel to toe, with a darker sole.
        fk = G['foot']
        sole = lambda p: 0.4 if p.y < 0.016 else 1.0
        sh = [(-0.066, 0.028, 0.040, 0.050), (-0.045, 0.038, 0.014, 0.090), (0.0, 0.044, 0.014, 0.100), (0.045, 0.048, 0.013, 0.078), (0.095, 0.051, 0.013, 0.060),
              (0.145, 0.049, 0.012, 0.050), (0.180, 0.036, 0.012, 0.040)]
        secs = [Z(-0.074 * fk, 0, 0, 0, 0.035, lx)] + [Z(z * fk, rx * fk, top - cy, cy - 0.001, cy, lx, n=2.6) for z, rx, cy, top in sh] + [Z(0.193 * fk, 0, 0, 0, 0.018, lx)]
        M.tube(secs, 10, 'sneakers', {ft: 1.0}, tint=sole, lod_segs=6)
    return M




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
            who = {part} | {o for o in OCCLUDERS if SLOT[o] != SLOT[part]}
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
            a = ao[l.vert.index]; t = M.T[l.vert.index]; l[col] = (a * t[0], a * t[1], a * t[2], 1.0)
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


def sheets(kind, G, arm_ob, obs, which):
    hk = G['head']; ey = HEAD_Y + (1.640 - HEAD_Y) * hk
    out = {}
    wear = ['tee', 'arm', 'trousers', 'sneakers']
    # Four faces from one head: the game mixes these per person.
    faces = [{}, {0: 0.8, 1: 0.5, 2: 0.7}, {0: -0.8, 1: -0.6, 2: -0.4, 4: 1.0}, {0: 0.3, 1: 0.9, 2: 0.2, 3: 1.0}]
    hairs = ['hair_crop', 'hair_long' if kind == 'f' else 'hair_crop', 'hair_tail', 'hair_bald']
    out['faces'] = ([dict(cam=(0.0, ey, 0.95), tgt=(0, ey, 0.02), lens=85, show=wear + [h], keys=k) for k, h in zip(faces, hairs)] +
                    [dict(cam=(0.62, ey + 0.02, 0.72), tgt=(0, ey, 0.02), lens=85, show=wear + [h], keys=k) for k, h in zip(faces, hairs)] +
                    [dict(cam=(0.95, ey, 0.02), tgt=(0, ey, 0.02), lens=85, show=wear + [h], keys=k) for k, h in zip(faces[:2], hairs)] +
                    [dict(cam=(0.0, ey + 0.015, 0.9), tgt=(0.02, ey + 0.015, 0.02), lens=400, show=wear, keys={}),
                     dict(cam=(0.5, ey + 0.015, 0.75), tgt=(0.02, ey + 0.015, 0.02), lens=400, show=wear, keys={})], 400, 460, 4)
    out['body'] = ([dict(cam=(0.0, 1.0, 4.9), show=wear + ['hair_tail', 'cap', 'peak_f']),
                    dict(cam=(4.9, 1.0, 0.0), show=wear + ['hair_crop']),
                    dict(cam=(-2.6, 1.5, -4.0), show=wear + ['hair_long']),
                    dict(cam=(3.0, 1.3, 3.9), pose=BEND, show=wear + ['hair_bun']),
                    dict(cam=(1.6, 1.0, 4.6), lod=1, show=wear + ['hair_tail', 'cap', 'peak_f'])], 420, 800, 5)
    for n in which:
        if n in out: sheet(kind, n, arm_ob, obs, *out[n])


def build(kind, do_render=True, do_export=True, which=('faces', 'body')):
    G = BODY[kind]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    global STAGE
    STAGE = None
    make_materials()
    arm_ob = armature(joints(G))
    bodies = []; stats = {}
    for lod in (0, 1):
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
        stats[f'worn{lod}'] = sum(v for k, v in by.items() if k in BASE_SHOW or k in ('tee', 'arm', 'trousers', 'sneakers', 'hair_tail', 'cap', 'peak_f'))
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
                                  export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
                                  export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_attributes=True,
                                  export_active_vertex_color_when_no_material=True, export_animations=False,
                                  export_skins=True, export_morph=True, export_morph_normal=False, export_try_sparse_sk=True,
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
    which = argv[argv.index('--sheets') + 1].split(',') if '--sheets' in argv else ('faces', 'body')
    for k in kinds:
        build(k, '--no-render' not in argv, '--no-export' not in argv, which)
