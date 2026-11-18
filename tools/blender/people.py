# Port Calamity's people, modelled in Blender by script and exported as .glb.
#
#   blender --background --factory-startup --python tools/blender/people.py -- [f] [m] [--no-render] [--no-export]
#
# Writes public/models/person_<f|m>.glb and a preview sheet shots/blender/person_<f|m>.jpg
# (front, side, back three-quarter, and a posed bend that shows the joints hold).
#
# Everything is authored in the GAME's frame (x = the person's left, y = up,
# z = forward, feet at y 0) and passed through B() into Blender's Z-up frame;
# the exporter's Y-up conversion lands it back where it started.
#
# A body is not one welded skin. It is a set of closed, smooth lofts (rings of
# a superellipse stacked along a limb) that run into each other the way a
# jointed doll's parts do: the upper arm ends in a ball buried in the shirt,
# the thigh in a ball buried in the trousers, the shoe swallows the shin. That
# is deliberate. Shoulders and hips are where a welded skin collapses when a
# limb swings through 150 degrees; a ball turning inside a sleeve cannot. Where
# the surface IS continuous (knee, elbow, waist, neck) the weights cross the
# joint over a few rings, two bones a vertex, never more.
#
# Material names are the contract with src/ent/characterAssets.ts, which turns
# each into a per-vertex part id the game colours and shows or hides per person:
#   skin top bottom shoes            always drawn, in the Look's colours
#   arm_bare | top_long              the arm below a short sleeve, or a long sleeve
#   leg_bare | bottom_long           the leg below shorts, or the trouser leg
#   hair hair_bob hair_tail hair_bun beard   hair pieces, hair colour
#   hat brim_f brim_b                a cap and its brim, worn forwards or backwards
#   eye eyewhite brow lip            fixed colours (brow takes the hair colour, lip a darker skin)
# Vertex colours carry baked ambient occlusion times a tint (soles, cuffs).
# Bones (19): hips spine chest neck head, shoulder_ upperarm_ forearm_ hand_
# (l, r), thigh_ shin_ foot_ (l, r). Every bone's rest frame is the world's, so
# the game needs only each joint's position, which it reads from the file.
# The leg joints sit exactly where character.ts's stride solver believes they
# are (hip 0.90, knee 0.48, ankle 0.085, 0.092 off centre): move them here and
# the feet slide there.
# LOD1 is the same recipe with fewer segments round each ring and every ring
# dropped that its neighbours already describe to within 7 mm.

import bpy, bmesh, sys, os, json
from math import sin, cos, pi, radians, sqrt, copysign
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MATS = ['skin', 'top', 'bottom', 'shoes', 'arm_bare', 'top_long', 'leg_bare', 'bottom_long', 'hair', 'hair_bob',
        'hair_tail', 'hair_bun', 'beard', 'hat', 'brim_f', 'brim_b', 'eye', 'brow', 'lip', 'eyewhite']
MI = {n: i for i, n in enumerate(MATS)}
# Preview colours only; the game supplies its own.
SKIN, HAIR, TOP, BOT = (0.36, 0.16, 0.08), (0.03, 0.015, 0.01), (0.012, 0.02, 0.05), (0.03, 0.05, 0.11)
PREVIEW = {'skin': SKIN, 'arm_bare': SKIN, 'leg_bare': SKIN, 'top': TOP, 'top_long': TOP, 'bottom': BOT,
           'bottom_long': BOT, 'shoes': (0.05, 0.03, 0.02), 'hair': HAIR, 'hair_bob': HAIR, 'hair_tail': HAIR,
           'hair_bun': HAIR, 'beard': HAIR, 'hat': (0.75, 0.1, 0.03), 'brim_f': (0.75, 0.1, 0.03),
           'brim_b': (0.75, 0.1, 0.03), 'eye': (0.01, 0.01, 0.015), 'brow': HAIR, 'lip': (0.2, 0.06, 0.05), 'eyewhite': (0.8, 0.78, 0.74)}

HIP_Y, KNEE_Y, ANKLE_Y, HIP_X = 0.90, 0.48, 0.085, 0.092
UPPER, FORE = 0.28, 0.24

BODY = {
    'm': dict(
        sh=0.185, sh_y=1.378, arm=1.0, leg=1.0, neck=0.060, head=1.0, hand=1.0, foot=1.0,
        # y, half width, front depth, back depth, centre z
        pants=[(0.80, 0.100, 0.085, 0.090, -0.005), (0.84, 0.158, 0.100, 0.105, -0.006), (0.90, 0.170, 0.105, 0.112, -0.008),
               (0.96, 0.163, 0.105, 0.100, -0.006), (1.00, 0.152, 0.102, 0.092, -0.004)],
        shirt=[(0.885, 0.178, 0.113, 0.118, -0.008), (0.94, 0.171, 0.112, 0.108, -0.006), (1.04, 0.150, 0.108, 0.094, -0.002),
               (1.14, 0.152, 0.112, 0.098, 0.0), (1.24, 0.160, 0.120, 0.104, 0.004), (1.33, 0.170, 0.114, 0.108, 0.0),
               (1.375, 0.180, 0.104, 0.102, -0.004), (1.412, 0.184, 0.090, 0.094, -0.006), (1.436, 0.160, 0.078, 0.086, -0.008), (1.453, 0.112, 0.068, 0.078, -0.009), (1.467, 0.068, 0.062, 0.068, -0.010)]),
    'f': dict(
        sh=0.160, sh_y=1.372, arm=0.92, leg=0.98, neck=0.052, head=0.965, hand=0.9, foot=0.92,
        pants=[(0.80, 0.100, 0.080, 0.090, -0.005), (0.84, 0.160, 0.097, 0.108, -0.008), (0.90, 0.175, 0.101, 0.118, -0.010),
               (0.96, 0.158, 0.097, 0.100, -0.007), (1.01, 0.134, 0.090, 0.086, -0.004)],
        shirt=[(0.885, 0.183, 0.110, 0.125, -0.010), (0.94, 0.170, 0.106, 0.110, -0.007), (1.05, 0.128, 0.094, 0.086, -0.003),
               (1.14, 0.134, 0.100, 0.090, 0.0), (1.25, 0.146, 0.128, 0.096, 0.004), (1.31, 0.152, 0.118, 0.100, 0.002),
               (1.365, 0.157, 0.098, 0.094, -0.004), (1.405, 0.160, 0.084, 0.088, -0.006), (1.430, 0.138, 0.072, 0.080, -0.008), (1.448, 0.098, 0.064, 0.072, -0.009), (1.464, 0.060, 0.056, 0.062, -0.010)]),
}

# The head, chin to crown: y, half width, front depth, back depth, centre z.
HEAD = [(1.530, 0.026, 0.028, 0.030, 0.052), (1.545, 0.050, 0.042, 0.050, 0.040), (1.565, 0.062, 0.058, 0.072, 0.028),
        (1.590, 0.069, 0.074, 0.088, 0.016), (1.620, 0.070, 0.082, 0.096, 0.010), (1.650, 0.073, 0.084, 0.100, 0.008),
        (1.680, 0.075, 0.088, 0.102, 0.008), (1.710, 0.073, 0.086, 0.100, 0.008), (1.735, 0.060, 0.070, 0.086, 0.006),
        (1.748, 0.036, 0.042, 0.052, 0.004)]
HEAD = [(y, rx * 1.06, zf, zb, cz) for y, rx, zf, zb, cz in HEAD]
HEAD_Y = 1.56   # the head's pivot, and the level its sizes scale about


def B(x, y, z):
    return Vector((x, -z, y))


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(t, a=0.0, b=1.0):
    return max(a, min(b, t))


def smooth(t):
    t = clamp(t)
    return t * t * (3 - 2 * t)


def two(a, b, t):
    """Weights across a joint: bone a at t = 0, bone b at t = 1."""
    t = clamp(t)
    return {a: 1.0} if t <= 0 else {b: 1.0} if t >= 1 else {a: 1 - t, b: t}


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
        if s['rx'] == 0 or 'm' in s: return False
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
            if L < 1e-6 or 'm' in secs[j] or not all(near(a, b, secs[k], (secs[k]['c'] - a['c']).length / L) for k in range(i, j + 1)): break
            j += 1
        out.append(secs[j]); i = j + 1
    return out


class Model:
    def __init__(s, lod):
        s.lod = lod; s.V = []; s.W = []; s.T = []; s.F = []; s.FM = []

    def tube(s, secs, segs, mat, w=None, keep=None, disp=None, tint=1.0, lod_segs=None, min_lod=1):
        """Loft the rings in order. A ring with rx 0 is a pole. `keep(y, a)` drops faces; `disp(a, sec)` pushes a vertex along its radius."""
        if s.lod > min_lod: return
        if s.lod:
            segs = lod_segs or max(5, segs // 2)
            secs = thin([dict(x, w=x.get('w', w)) for x in secs])
        base = len(s.V); rows = []; faces = []
        for sec in secs:
            ww = sec.get('w', w); row = []
            n = 1 if sec['rx'] == 0 else segs
            for k in range(n):
                a = pi / 2 + 2 * pi * k / segs
                cs, sn = cos(a), sin(a); e = 2.0 / sec.get('n', 2.0)
                px = copysign(abs(cs) ** e, cs) * sec['rx']
                pz = copysign(abs(sn) ** e, sn) * (sec['zf'] if sn >= 0 else sec['zb'])
                if disp and n > 1:
                    d = disp(a, sec); r = sqrt(px * px + pz * pz) or 1.0
                    px *= 1 + d / r; pz *= 1 + d / r
                p = sec['c'] + sec['u'] * px + sec['v'] * pz
                row.append(len(s.V)); s.V.append(p)
                s.W.append(dict(ww(a, p) if callable(ww) else ww))
                tt = sec.get('t', tint); s.T.append(tt(p) if callable(tt) else tt)
            rows.append(row)
        m = mat
        for i in range(len(secs) - 1):
            m = secs[i].get('m', m)
            r0, r1 = rows[i], rows[i + 1]
            ymid = (secs[i]['c'].y + secs[i + 1]['c'].y) / 2
            for k in range(segs):
                k2 = (k + 1) % segs
                if keep and not keep(ymid, pi / 2 + 2 * pi * (k + 0.5) / segs): continue
                if len(r0) == 1 and len(r1) == 1: continue
                f = (r0[0], r1[k2], r1[k]) if len(r0) == 1 else (r0[k], r0[k2], r1[0]) if len(r1) == 1 else (r0[k], r0[k2], r1[k2], r1[k])
                faces.append((f, m))
        # Wind outward: the same test for closed lofts and open shells.
        if not faces: return
        cen = sum((s.V[i] for i in range(base, len(s.V))), Vector()) / (len(s.V) - base); vol = 0.0
        for f, _ in faces:
            p = [s.V[i] for i in f]
            vol += ((p[1] - p[0]).cross(p[2] - p[0])).dot(sum(p, Vector()) / len(p) - cen)
        for f, m in faces:
            s.F.append(f if vol >= 0 else f[::-1]); s.FM.append(MI[m])

    def ball(s, c, r, mat, w, segs=8, rings=4, tint=1.0, min_lod=0):
        """An ellipsoid: r is (x, y, z) radii."""
        secs = [S(c[1] - r[1], 0, 0, 0, c[2], c[0])]
        for i in range(1, rings):
            t = pi * i / rings
            secs.append(S(c[1] - r[1] * cos(t), r[0] * sin(t), r[2] * sin(t), None, c[2], c[0]))
        secs.append(S(c[1] + r[1], 0, 0, 0, c[2], c[0]))
        s.tube(secs, segs, mat, w, tint=tint, min_lod=min_lod)


# ── A person ─────────────────────────────────────────────────────────────────

def head_at(y, k):
    """Interpolated head ring at height y (already scaled by k about the pivot)."""
    H = [(HEAD_Y + (h[0] - HEAD_Y) * k, h[1] * k, h[2] * k, h[3] * k, h[4] * k) for h in HEAD]
    for a, b in zip(H, H[1:]):
        if y <= b[0] or b is H[-1]:
            t = clamp((y - a[0]) / (b[0] - a[0]))
            return [lerp(a[i], b[i], t) for i in range(5)]


def face_z(x, y, k):
    """Depth of the face surface at (x, y)."""
    _, rx, zf, _, cz = head_at(y, k)
    return cz + zf * sqrt(max(0.0, 1 - (x / rx) ** 2))


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


def person(G, lod):
    M = Model(lod)
    hk = G['head']

    # Trousers' seat, then the shirt over it.
    P = G['pants']
    secs = [S(0.775, 0, 0, 0, P[0][4])] + [S(y, rx, zf, zb, cz, n=2.3) for y, rx, zf, zb, cz in P] + [S(P[-1][0] + 0.005, 0, 0, 0, 0)]
    M.tube(secs, 16, 'bottom', {'hips': 1.0})

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
    M.tube(secs, 16, 'top')

    # Neck.
    nk = G['neck']
    secs = [S(1.44, nk + 0.004, nk + 0.006, nk + 0.008, -0.010, w={'chest': 1.0}), S(1.47, nk, nk + 0.003, nk + 0.004, -0.008, w={'chest': 0.5, 'neck': 0.5}),
            S(1.50, nk - 0.002, nk + 0.001, nk + 0.002, -0.004, w={'neck': 1.0}), S(1.535, nk - 0.002, nk + 0.002, nk + 0.004, 0.0, w={'neck': 0.5, 'head': 0.5}),
            S(1.575, nk, nk + 0.004, nk + 0.008, 0.004, w={'head': 1.0})]
    M.tube(secs, 10, 'skin')

    # Head, with the brow pushed out and the eye sockets and temples pulled in.
    def face(a, sec):
        y = HEAD_Y + (sec['c'].y - HEAD_Y) / hk; f = sin(a); side = abs(cos(a))
        if f < 0.2: return 0.0
        d = 0.004 * max(0.0, 1 - ((y - 1.682) / 0.014) ** 2) * f                       # brow
        d -= 0.007 * max(0.0, 1 - ((y - 1.655) / 0.016) ** 2) * max(0.0, 1 - ((side - 0.42) / 0.3) ** 2)  # sockets
        d += 0.004 * max(0.0, 1 - ((y - 1.625) / 0.02) ** 2) * max(0.0, 1 - ((side - 0.6) / 0.3) ** 2)   # cheekbones
        d += 0.003 * max(0.0, 1 - ((y - 1.590) / 0.012) ** 2) * max(0.0, 1 - (side / 0.35) ** 2)          # lips
        return d * hk
    hs = [head_at(HEAD_Y + (h[0] - HEAD_Y) * hk, hk) for h in HEAD]
    secs = [S(hs[0][0] - 0.008 * hk, 0, 0, 0, hs[0][4] - 0.004)] + [S(y, rx, zf, zb, cz, n=2.15) for y, rx, zf, zb, cz in hs]
    secs.append(S(hs[-1][0] + 0.006 * hk, 0, 0, 0, hs[-1][4]))
    HW = {'head': 1.0}
    M.tube(secs, 20, 'skin', HW, disp=face, lod_segs=10)

    def hy(y): return HEAD_Y + (y - HEAD_Y) * hk
    # Nose: a wedge from the bridge down to the tip, then tucked back under.
    nz = lambda y: face_z(0, hy(y), hk)
    secs = [S(hy(1.672), 0, 0, 0, nz(1.672) - 0.002), S(hy(1.660), 0.007 * hk, 0.004, 0.01, nz(1.660)), S(hy(1.640), 0.009 * hk, 0.012 * hk, 0.01, nz(1.640)),
            S(hy(1.620), 0.014 * hk, 0.022 * hk, 0.01, nz(1.620)), S(hy(1.611), 0.013 * hk, 0.015 * hk, 0.01, nz(1.611)), S(hy(1.606), 0, 0, 0, nz(1.606) - 0.002)]
    M.tube(secs, 6, 'skin', HW, min_lod=0)
    for s in (1, -1):
        M.ball((s * 0.076 * hk, hy(1.640), 0.0), (0.008, 0.030 * hk, 0.016 * hk), 'skin', HW, 6, 4, tint=0.9, min_lod=0)       # ear
        ex = s * 0.031 * hk
        ez = face_z(ex, hy(1.655), hk) - 0.0055
        M.ball((ex, hy(1.655), ez), (0.0135 * hk, 0.0075, 0.004), 'eyewhite', HW, 8, 4, min_lod=0)
        M.ball((ex * 0.97, hy(1.655), ez + 0.0012), (0.0062, 0.0066, 0.004), 'eye', HW, 6, 3, min_lod=0)
        M.ball((ex * 1.05, hy(1.676), face_z(ex, hy(1.676), hk) - 0.002), (0.016 * hk, 0.0035, 0.004), 'brow', HW, 6, 3, min_lod=0)
    M.ball((0, hy(1.588), face_z(0, hy(1.588), hk) + 0.001), (0.021 * hk, 0.0035, 0.004), 'lip', HW, 6, 3, min_lod=0)

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
    beard = lambda a: 9.0 if sin(a) < -0.1 else 0.0
    shell('hair', 0.011, crop, lo=1.59)
    shell('hair_bob', 0.017, bob, hang=1.64)
    # A short boxed beard: the jaw's own rings, pushed out, below the cheekbones.
    def bd(a, sec):
        return 0.007 * clamp((1.618 - sec['hy']) / 0.02, -0.5, 1) * clamp((sin(a) + 0.25) / 0.2, -0.5, 1) * (0.0 if abs(cos(a)) < 0.3 and 1.58 < sec['hy'] < 1.60 else 1.0)
    bs = [S(hs[0][0] - 0.012 * hk, 0, 0, 0, hs[0][4] - 0.004, hy=1.52)] + [S(y, rx, zf, zb, cz, hy=h[0], n=2.15) for h, (y, rx, zf, zb, cz) in zip(HEAD, hs) if h[0] < 1.63]
    M.tube(bs, 20, 'beard', HW, keep=lambda y, a: sin(a) > -0.2 and HEAD_Y + (y - HEAD_Y) / hk < 1.612, disp=bd, lod_segs=10, min_lod=0)
    # Pony tail and bun.
    M.tube([S(hy(1.725), 0, 0, 0, -0.085), S(hy(1.71), 0.024, None, None, -0.105), S(hy(1.66), 0.03, None, None, -0.128), S(hy(1.58), 0.026, None, None, -0.135),
            S(hy(1.50), 0.017, None, None, -0.128), S(hy(1.45), 0, 0, 0, -0.122)], 8, 'hair_tail', HW, lod_segs=5)
    M.ball((0, hy(1.735), -0.088), (0.042, 0.04, 0.042), 'hair_bun', HW, 8, 5)
    # Cap: a taller shell over the hair, and a brim for each way round it can be worn.
    shell('hat', 0.021, lambda a: 1.688, lo=1.65, rise=1.12)
    for mat, sg in (('brim_f', 1), ('brim_b', -1)):
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
                A(0.150, 0.050, 0.053, t=0.8), A(0.152, 0.040, 0.042, t=0.6)], 10, 'top')
        M.tube([A(0.13, 0.046, 0.049), A(0.20, 0.045, 0.048), A(0.245, 0.042, 0.044), A(0.265, 0.041, 0.043), A(0.28, 0.041, 0.043), A(0.295, 0.042, 0.043),
                A(0.315, 0.043, 0.045), A(0.36, 0.043, 0.047), A(0.44, 0.035, 0.039), A(0.50, 0.027, 0.033), A(0.53, 0.023, 0.031)], 10, 'arm_bare')
        g = 0.007
        M.tube([A(0.14, 0.046, 0.049, g), A(0.20, 0.045, 0.048, g), A(0.245, 0.042, 0.044, g), A(0.265, 0.041, 0.043, g), A(0.28, 0.041, 0.043, g),
                A(0.295, 0.042, 0.043, g), A(0.315, 0.043, 0.045, g), A(0.36, 0.043, 0.047, g), A(0.44, 0.036, 0.040, g), A(0.495, 0.030, 0.035, g, t=0.8),
                A(0.497, 0.020, 0.026, t=0.6)], 10, 'top_long')
        # Hand: a mitten hanging palm inward, fingers curling toward the leg, and a thumb forward of it.
        wy, hk2 = sy - UPPER - FORE, G['hand']
        def Hn(d, rx, rz, curl=0.0, fz=0.0):
            return S(wy - d * hk2, rx * hk2, rz * hk2, None, -0.01 + fz * hk2, sx - s * curl * hk2)
        M.tube([Hn(-0.015, 0.021, 0.029), Hn(0.02, 0.019, 0.037, 0, 0.003), Hn(0.055, 0.017, 0.043, 0.001, 0.005), Hn(0.085, 0.015, 0.042, 0.004, 0.007),
                Hn(0.125, 0.012, 0.038, 0.012, 0.009), Hn(0.160, 0.010, 0.030, 0.022, 0.010), Hn(0.178, 0, 0, 0.028, 0.010)], 8, 'skin', {hd: 1.0}, lod_segs=5)
        th = [(0.022, 0.030, 0.012), (0.045, 0.047, 0.012), (0.075, 0.058, 0.010), (0.098, 0.062, 0.008)]
        M.tube([Hn(0.008, 0, 0, 0.0, 0.02)] + [S(wy - d * hk2, r * hk2, None, None, -0.01 + fz * hk2, sx - s * 0.006) for d, fz, r in th] + [Hn(0.108, 0, 0, 0.006, 0.062)],
               6, 'skin', {hd: 1.0}, min_lod=0)

        # Leg.
        th_, sh_, ft = 'thigh_' + n, 'shin_' + n, 'foot_' + n
        lx, k = s * HIP_X, G['leg']
        def lw(y): return two(th_, sh_, (KNEE_Y + 0.04 - y) / 0.08)
        def Lg(y, rx, zf, zb, grow=0.0, cz=0.0, **kw):
            return S(y, rx * k + grow, zf * k + grow, zb * k + grow, cz, lx, w=lw(y), **kw)
        M.tube([Lg(0.945, 0, 0, 0), Lg(0.925, 0.055, 0.066, 0.070), Lg(0.88, 0.078, 0.090, 0.097, 0, -0.004), Lg(0.82, 0.084, 0.092, 0.096, 0, -0.004),
                Lg(0.70, 0.082, 0.089, 0.087), Lg(0.60, 0.074, 0.080, 0.075), Lg(0.545, 0.068, 0.073, 0.068, t=0.8), Lg(0.543, 0.052, 0.058, 0.054, t=0.6)], 12, 'bottom')
        skin = [(0.56, 0.056, 0.060, 0.058), (0.52, 0.053, 0.059, 0.054), (0.50, 0.052, 0.060, 0.052), (0.48, 0.051, 0.060, 0.051), (0.46, 0.050, 0.057, 0.052),
                (0.44, 0.049, 0.053, 0.056), (0.37, 0.056, 0.050, 0.072), (0.30, 0.052, 0.047, 0.066), (0.20, 0.041, 0.042, 0.048), (0.13, 0.035, 0.037, 0.040), (0.07, 0.035, 0.037, 0.040)]
        M.tube([Lg(*r) for r in skin], 12, 'leg_bare')
        # The trouser leg hangs from the knee rather than hugging the calf.
        tr = [(0.545, 0.068, 0.073, 0.068), (0.52, 0.066, 0.071, 0.066), (0.50, 0.065, 0.071, 0.064), (0.48, 0.064, 0.071, 0.063), (0.46, 0.064, 0.069, 0.063),
              (0.44, 0.063, 0.067, 0.065), (0.37, 0.063, 0.061, 0.071), (0.30, 0.060, 0.059, 0.067), (0.20, 0.056, 0.057, 0.060), (0.105, 0.055, 0.058, 0.058)]
        M.tube([Lg(*r) for r in tr] + [Lg(0.103, 0.036, 0.04, 0.04, t=0.5)], 12, 'bottom_long')
        # Shoe, heel to toe, with a darker sole.
        fk = G['foot']
        sole = lambda p: 0.4 if p.y < 0.016 else 1.0
        sh = [(-0.066, 0.028, 0.040, 0.050), (-0.045, 0.038, 0.014, 0.090), (0.0, 0.044, 0.014, 0.100), (0.045, 0.048, 0.013, 0.078), (0.095, 0.051, 0.013, 0.060),
              (0.145, 0.049, 0.012, 0.050), (0.180, 0.036, 0.012, 0.040)]
        secs = [Z(-0.074 * fk, 0, 0, 0, 0.035, lx)] + [Z(z * fk, rx * fk, top - cy, cy - 0.001, cy, lx, n=2.6) for z, rx, cy, top in sh] + [Z(0.193 * fk, 0, 0, 0, 0.018, lx)]
        M.tube(secs, 10, 'shoes', {ft: 1.0}, tint=sole, lod_segs=6)
    return M


# ── Into Blender ─────────────────────────────────────────────────────────────

DIRS = []
for i in range(24):
    zz = 0.15 + 0.85 * (i + 0.5) / 24; rr = sqrt(1 - zz * zz); aa = i * 2.39996
    DIRS.append((rr * cos(aa), rr * sin(aa), zz))


BASE = [MI[n] for n in ('skin', 'top', 'bottom', 'shoes')]


def occlusion(bm, arm):
    """Per vertex. Arms and the rest ignore each other: in the bind pose the arm hangs against a hip it never touches in the game."""
    out = []
    for cls in (False, True):
        V = [v.co.copy() for v in bm.verts]
        F = [[v.index for v in f.verts] for f in bm.faces if f.material_index in BASE and all(arm[v.index] == cls for v in f.verts)]
        F.append([len(V) + i for i in range(4)]); V += [Vector((-9, -9, 0)), Vector((9, -9, 0)), Vector((9, 9, 0)), Vector((-9, 9, 0))]
        out.append(BVHTree.FromPolygons(V, F))
    ao = []
    for v in bm.verts:
        n = v.normal; t = n.orthogonal().normalized(); b = n.cross(t); o = v.co + n * 0.003; occ = 0.0
        for dx, dy, dz in DIRS:
            hit = out[1 if arm[v.index] else 0].ray_cast(o, t * dx + b * dy + n * dz, 0.16)
            if hit[0] is not None: occ += 1 - hit[3] / 0.16
        ao.append(0.45 + 0.55 * max(0.0, 1 - occ / len(DIRS) * 1.3))
    return ao


def to_blender(M, name, arm_ob):
    bm = bmesh.new()
    vs = [bm.verts.new(B(*p)) for p in M.V]
    for f, m in zip(M.F, M.FM):
        try: bm.faces.new([vs[i] for i in f]).material_index = m
        except ValueError: pass
    bm.verts.index_update(); bm.normal_update()
    for f in bm.faces: f.smooth = True
    arm = [any('arm' in k or 'hand' in k for k in w) for w in M.W]
    ao = occlusion(bm, arm)
    me = bpy.data.meshes.new(name)
    for n in MATS: me.materials.append(bpy.data.materials[n])
    col = bm.loops.layers.color.new('Col')
    for f in bm.faces:
        for l in f.loops:
            c = ao[l.vert.index] * M.T[l.vert.index]; l[col] = (c, c, c, 1.0)
    bm.to_mesh(me); bm.free()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons)); me.update()
    me.color_attributes.active_color = me.color_attributes['Col']
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    for bone in arm_ob.data.bones: ob.vertex_groups.new(name=bone.name)
    for i, w in enumerate(M.W):
        for k, x in w.items():
            if x > 0: ob.vertex_groups[k].add([i], x, 'REPLACE')
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
        bsdf.inputs['Roughness'].default_value = 0.55 if n in ('skin', 'arm_bare', 'leg_bare') else 0.85
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


def render(kind, arm_ob, bodies, hide):
    import numpy as np
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    W, H = 420, 800
    sc.render.resolution_x, sc.render.resolution_y = W, H
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
    tgt = bpy.data.objects.new('tgt', None); sc.collection.objects.link(tgt); tgt.location = B(0, 0.9, 0)
    cam = bpy.data.cameras.new('cam'); cam.lens = 70
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    c = co.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    REST = {'upperarm_l': [((0, 0, 1), 0.12)], 'upperarm_r': [((0, 0, 1), -0.12)], 'forearm_l': [((1, 0, 0), -0.2)], 'forearm_r': [((1, 0, 0), -0.2)]}
    BEND = {'upperarm_l': [((1, 0, 0), -1.3)], 'forearm_l': [((1, 0, 0), -1.5)], 'upperarm_r': [((0, 0, 1), -1.45)], 'forearm_r': [((1, 0, 0), -0.6)],
            'thigh_l': [((1, 0, 0), -1.15)], 'shin_l': [((1, 0, 0), 1.5)], 'thigh_r': [((1, 0, 0), 0.3)], 'shin_r': [((1, 0, 0), 0.5)],
            'chest': [((0, 1, 0), 0.3)], 'spine': [((1, 0, 0), 0.15)], 'head': [((0, 1, 0), -0.5)], 'shoulder_r': [((0, 0, 1), -0.25)]}
    # Each shot: lod, camera, pose, materials hidden.
    longs = ['arm_bare', 'leg_bare']; shorts = ['top_long', 'bottom_long']
    shots = [(0, (0.0, 1.0, 4.9), REST, shorts + ['hair_bob', 'hair_bun', 'beard', 'brim_b']),
             (0, (4.9, 1.0, 0.0), REST, longs + ['hair_bob', 'hair_tail', 'hair_bun', 'beard', 'hat', 'brim_f', 'brim_b']),
             (0, (-2.6, 1.5, -4.0), REST, shorts + ['hair', 'hair_tail', 'hair_bun', 'beard', 'hat', 'brim_f', 'brim_b'] if kind == 'f' else longs + ['hair_bob', 'hair_tail', 'hair_bun', 'beard', 'brim_f']),
             (0, (3.0, 1.3, 3.9), BEND, longs + ['hair_bob', 'hair_tail', 'beard', 'hat', 'brim_f', 'brim_b']),
             (0, (0.5, 1.62, 1.25), REST, shorts + ['hair_bob', 'hair_tail', 'hair_bun', 'hat', 'brim_f', 'brim_b'] + ([] if kind == 'm' else ['beard'])),
             (1, (1.6, 1.0, 4.6), REST, shorts + ['hair_bob', 'hair_bun', 'beard', 'brim_b'])]
    os.makedirs(os.path.join(ROOT, 'shots', 'blender'), exist_ok=True)
    sheet = np.zeros((H, W * len(shots), 4), dtype=np.float32)
    for i, (lod, pos, P, hidden) in enumerate(shots):
        pose(arm_ob, P)
        co.location = B(*pos); tgt.location = B(0, 1.64 if i == 4 else 0.9, 0)
        vis = []
        for j, body in enumerate(bodies):
            body.hide_render = True
        # Hiding a material is done on a copy with those faces removed.
        tmp = bodies[lod].copy(); tmp.data = bodies[lod].data.copy(); sc.collection.objects.link(tmp)
        bm = bmesh.new(); bm.from_mesh(tmp.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if MATS[f.material_index] in hidden], context='FACES')
        bm.to_mesh(tmp.data); bm.free(); tmp.hide_render = False
        path = os.path.join(ROOT, 'shots', 'blender', f'_person_{i}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(path); px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)
        sheet[:, i * W:(i + 1) * W] = px
        bpy.data.images.remove(img); os.remove(path)
        bpy.data.objects.remove(tmp)
    out = bpy.data.images.new('sheet', W * len(shots), H)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = os.path.join(ROOT, 'shots', 'blender', f'person_{kind}.jpg'); out.file_format = 'JPEG'
    out.save()
    pose(arm_ob, {})


def build(kind, do_render=True, do_export=True):
    G = BODY[kind]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    J = joints(G)
    arm_ob = armature(J)
    bodies = []; stats = {}
    for lod in (0, 1):
        M = person(G, lod)
        ob = to_blender(M, f'LOD{lod}', arm_ob)
        bodies.append(ob)
        stats[f'LOD{lod}'] = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        by = {}
        for p in ob.data.polygons: by[MATS[p.material_index]] = by.get(MATS[p.material_index], 0) + len(p.vertices) - 2
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
                                  export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                                  export_active_vertex_color_when_no_material=True, export_animations=False,
                                  export_skins=True, export_morph=False, export_extras=False)
        stats['kB'] = round(os.path.getsize(path) / 1000)
        import struct
        with open(path, 'rb') as fh:
            fh.seek(12); n, _ = struct.unpack('<II', fh.read(8)); g = json.loads(fh.read(n))
        stats['nodes'] = len(g['nodes']); stats['joints'] = len(g['skins'][0]['joints']) if g.get('skins') else 0
        stats['attrs'] = sorted(g['meshes'][0]['primitives'][0]['attributes'])
    print('STATS ' + json.dumps({kind: stats}))
    if do_render: render(kind, arm_ob, bodies, None)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    kinds = [a for a in argv if not a.startswith('--')] or list(BODY)
    for k in kinds:
        build(k, '--no-render' not in argv, '--no-export' not in argv)
