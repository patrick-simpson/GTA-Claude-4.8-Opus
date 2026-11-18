# Port Calamity's trees, modelled in Blender by script and exported as one .glb.
#
#   blender --background --factory-startup --python tools/blender/flora.py
#
# Writes public/models/flora.glb. Everything is authored in the GAME's frame
# (y up, a tree stands on y = 0 at the origin) and passed through B() into
# Blender's Z-up frame; the exporter's Y-up conversion lands it back.
#
# A tree is ONE mesh: a bark tube skeleton (trunk, a leader, primary and
# secondary branches) and a crown of flat leaf cards, several hundred of them,
# scattered over a lumpy ellipsoid shell with a darker sparse layer inside. The
# cards are what make the silhouette leafy instead of a ball. Each species comes
# at two levels of detail built from the same seed, so the far one is the same
# tree with fewer, bigger cards and a bare trunk.
#
# Nodes (the contract with src/world/floraAssets.ts):
#   plane_L0/1 maple_L0/1 oak_L0/1 cypress_L0/1   whole trees
#   palmtrunk_L0/1   8 m tall, top at (0, 8, 0); the game scales its height
#   palmcrown_L0/1   fronds around the origin, set on the trunk's top
#   shrub_L0 hedge_L0   a round bush; a 2 m run of clipped hedge along x
#
# UVs address the atlas floraAssets.ts paints on a canvas (image space, v down,
# 4 x 4 cells): column 0 is bark and repeats down v (2 m a repeat); the other
# cells are leaf pictures with alpha. u < 0.25 therefore means "bark", and the
# game uses exactly that test to keep the per-tree leaf tint off the wood.
# Vertex colours are a tint times hand-rolled occlusion: cards deep in the crown
# and on its underside are darker. Leaf normals are NOT trusted from here: the
# loader replaces them with ones that swell out from the crown, which is what
# makes a crown shade as one round mass.

import bpy, sys, os, math, random
from math import sin, cos, pi, tau, exp
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'models', 'flora.glb')
UP = Vector((0, 1, 0))


def cell(c, r, w=1, h=1, pad=0.006):
    return (c * 0.25 + pad, r * 0.25 + pad, (c + w) * 0.25 - pad, (r + h) * 0.25 - pad)


LEAF = [cell(1, 0), cell(2, 0), cell(3, 0)]
FROND = cell(1, 1, 3, 1)
CYPRESS, SHRUB, HEDGE = cell(1, 2), cell(2, 2), cell(3, 3)


class M:
    def __init__(self):
        self.v = []; self.f = []; self.uv = []; self.col = []

    def add(self, pts, uvs, cols):
        b = len(self.v)
        self.v.extend(pts)
        self.f.append(tuple(range(b, b + len(pts)))); self.uv.append(uvs); self.col.append(cols)

    def tris(self):
        return sum(len(f) - 2 for f in self.f)


def bu(f):
    """Bark u: out across the strip and back, so the seam mirrors and does not show."""
    return 0.02 + 0.21 * (1 - abs(2 * f - 1))


def tube(m, pts, radii, sides, tint, shades=None, vrep=0.5):
    ref = Vector((0.31, 0.0, 0.95)).normalized()
    rings = []; vs = []; L = 0.0
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        r_ = ref if abs(t.dot(ref)) < 0.9 else Vector((1, 0, 0))
        b = t.cross(r_).normalized(); n = b.cross(t)
        if i: L += (p - pts[i - 1]).length
        rings.append(len(m.v)); vs.append(L * vrep)
        for j in range(sides + 1):
            a = tau * j / sides
            m.v.append(p + (n * cos(a) + b * sin(a)) * radii[i])
    for i in range(len(pts) - 1):
        s0 = shades[i] if shades else 1.0; s1 = shades[i + 1] if shades else 1.0
        c0 = tuple(c * s0 for c in tint); c1 = tuple(c * s1 for c in tint)
        for j in range(sides):
            a0 = rings[i] + j; b0 = rings[i + 1] + j
            u0 = bu(j / sides); u1 = bu((j + 1) / sides)
            m.f.append((a0, a0 + 1, b0 + 1, b0))
            m.uv.append([(u0, vs[i]), (u1, vs[i]), (u1, vs[i + 1]), (u0, vs[i + 1])])
            m.col.append([c0, c0, c1, c1])


def card(m, P, nrm, w, h, rect, col, roll=0.0, flip=False, up=UP):
    r = up.cross(nrm)
    if r.length < 1e-3: r = Vector((1, 0, 0))
    r.normalize(); u = nrm.cross(r).normalized()
    cr, sr = cos(roll), sin(roll)
    r2 = r * cr + u * sr; u2 = u * cr - r * sr
    hw, hh = w / 2, h / 2
    u0, v0, u1, v1 = rect
    if flip: u0, u1 = u1, u0
    m.add([P - r2 * hw - u2 * hh, P + r2 * hw - u2 * hh, P + r2 * hw + u2 * hh, P - r2 * hw + u2 * hh],
          [(u0, v1), (u1, v1), (u1, v0), (u0, v0)], [col] * 4)


def crown_cards(m, rng, C, R, n, size, rects, lump, inner=0.12, bottom=-0.45):
    ph = [rng.uniform(0, tau) for _ in range(4)]
    k = 0
    while k < n:
        y = rng.uniform(-1, 1); a = rng.uniform(0, tau); hh = math.sqrt(1 - y * y)
        deep = rng.random() < inner
        r1 = rng.random(); r2 = rng.uniform(0.4, 0.72)
        j = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        s = rng.uniform(size[0], size[1]); tv = rng.uniform(0.72, 1.0); roll = rng.uniform(0, tau)
        rect = rng.choice(rects); flip = rng.random() < 0.5
        if y < bottom and rng.random() < 0.8: continue
        d = Vector((hh * cos(a), y, hh * sin(a)))
        lm = 1 + lump * (sin(3 * a + ph[0]) * cos(2.2 * y + ph[1]) * 0.6 + sin(5 * a + ph[2]) * sin(3 * y + ph[3]) * 0.4)
        rf = r2 if deep else 1 - 0.28 * r1 * r1
        P = Vector(C) + Vector((d.x * R[0], d.y * R[1], d.z * R[2])) * lm * rf
        nrm = (d + j * 0.55).normalized()
        ao = (0.36 + 0.64 * rf * rf) * (0.58 + 0.42 * (d.y * 0.5 + 0.5)) * tv
        card(m, P, nrm, s, s, rect, (ao, ao, ao * 0.97), roll, flip)
        k += 1


def broadleaf(seed, lod, fork, r0, C, R, nb, bark, ncards, size, lump):
    rng = random.Random(seed); m = M(); C = Vector(C)
    top = C.y + R[1] * 0.4
    NS = 8
    wob = [(rng.uniform(-1, 1), rng.uniform(-1, 1)) for _ in range(NS + 1)]
    pts = []; rad = []; sh = []
    for i in range(NS + 1):
        f = i / NS; y = f * top
        pts.append(Vector((wob[i][0] * 0.16 * f, y, wob[i][1] * 0.16 * f)))
        rad.append(r0 * (1 - 0.86 * f ** 1.2) + r0 * 0.5 * exp(-y * 3.2) + 0.015)
        sh.append(1.0 if y < fork else 0.72)
    step = 1 if lod == 0 else 4
    tube(m, pts[::step], rad[::step], 9 if lod == 0 else 5, bark, sh[::step])

    def at(y):
        f = min(max(y / top, 0), 0.999) * NS; i = int(f); t = f - i
        return pts[i].lerp(pts[i + 1], t), rad[i] + (rad[i + 1] - rad[i]) * t

    def e(P):
        q = P - C
        return math.sqrt((q.x / R[0]) ** 2 + (q.y / R[1]) ** 2 + (q.z / R[2]) ** 2)

    for b in range(nb):
        f = b / (nb - 1)
        y0 = fork + (top * 0.82 - fork) * f * rng.uniform(0.85, 1.0)
        az = b * 2.399 + rng.uniform(-0.3, 0.3)
        el = 1.2 + (0.5 - 1.2) * f + rng.uniform(-0.12, 0.12)
        twist = [rng.uniform(0.5, 0.9) * (1 if k % 2 else -1) for k in range(2)]
        lens = [rng.uniform(0.38, 0.5) for _ in range(2)]
        d = Vector((cos(az) * sin(el), cos(el), sin(az) * sin(el)))
        start, rt = at(y0)
        rb = rt * 0.6
        L = 0.6
        P = lambda t, L=L: start + d * (L * t) + UP * (0.16 * L * t * t)
        while L < 9 and e(start + d * L + UP * (0.16 * L)) < 0.8: L += 0.2
        Pb = lambda t: start + d * (L * t) + UP * (0.16 * L * t * t)
        n = 4 if lod == 0 else 2
        tube(m, [Pb(k / n) for k in range(n + 1)], [rb * (1 - 0.86 * k / n) + 0.012 for k in range(n + 1)],
             5 if lod == 0 else 3, bark, [0.72] * (n + 1))
        if lod == 0:
            for k, t0 in enumerate((0.42, 0.68)):
                s0 = Pb(t0); a2 = az + twist[k]
                d2 = (Vector((cos(a2), 0, sin(a2))) * 0.8 + UP * 0.55).normalized()
                L2 = L * lens[k]; r2 = rb * (1 - 0.86 * t0) * 0.7
                tube(m, [s0, s0 + d2 * L2 * 0.5 + UP * 0.05, s0 + d2 * L2 + UP * 0.25], [r2, r2 * 0.6, 0.012], 4, bark, [0.7] * 3)
    crng = random.Random(seed + 77)
    if lod == 0:
        crown_cards(m, crng, C, R, ncards, size, LEAF, lump)
    else:
        crown_cards(m, crng, C, R, max(36, ncards // 7), (size[0] * 1.9, size[1] * 1.9), LEAF, lump, inner=0.08)
    return m


def cypress(seed, lod):
    rng = random.Random(seed); m = M(); H = 9.0; RM = 1.1
    tube(m, [Vector((0, 0, 0)), Vector((0, 3, 0)), Vector((0, 7.6, 0))], [0.2, 0.12, 0.02], 6 if lod == 0 else 4, (0.38, 0.3, 0.26))
    n = 170 if lod == 0 else 30; k = 0.0
    sc = 1.15 if lod == 0 else 2.2
    for i in range(n):
        f = (i + rng.random()) / n
        y = 0.5 + f * (H - 0.9)
        prof = RM * min(1.0, 0.45 + f * 3.2) * (1 - f) ** 0.62 + 0.06
        deep = rng.random() < 0.2
        a = i * 2.399 + rng.uniform(-0.4, 0.4)
        rr = prof * (0.55 if deep else rng.uniform(0.86, 1.0))
        d = Vector((cos(a), 0, sin(a)))
        nrm = (d + UP * 0.3 + Vector((rng.uniform(-1, 1), 0, rng.uniform(-1, 1))) * 0.35).normalized()
        ao = (0.5 if deep else rng.uniform(0.8, 1.0)) * (0.72 + 0.28 * f)
        card(m, Vector((d.x * rr, y, d.z * rr)), nrm, rng.uniform(0.75, 1.0) * sc, rng.uniform(1.2, 1.6) * sc, CYPRESS,
             (ao, ao, ao), rng.uniform(-0.25, 0.25), rng.random() < 0.5)
    return m


def palm_trunk(lod):
    m = M(); H = 8.0; tint = (0.74, 0.66, 0.52)
    cx = lambda f: 0.22 * sin(pi * f)
    pts = []; rad = []; sh = []
    if lod == 0:
        N = 22
        for i in range(N + 1):
            f = i / N; y = f * H
            base = 0.17 + 0.13 * exp(-y * 2.2) + 0.02 * (1 - f)
            # A ring scar: the trunk steps out just above each one.
            for dy, dr, s in ((0.0, 0.0, 0.62), (0.05, 0.022, 1.0)):
                pts.append(Vector((cx(f), y + dy, 0))); rad.append(base + dr); sh.append(s)
        tube(m, pts, rad, 9, tint, sh)
    else:
        for i in range(5):
            f = i / 4
            pts.append(Vector((cx(f), f * H, 0))); rad.append(0.19 + 0.12 * exp(-f * H * 2.2))
        tube(m, pts, rad, 5, tint, [0.85] * 5)
    return m


def palm_crown(seed, lod):
    rng = random.Random(seed); m = M()
    # The crownshaft: a green-brown bulb the fronds leave from.
    tube(m, [Vector((0, -0.35, 0)), Vector((0, 0.0, 0)), Vector((0, 0.45, 0)), Vector((0, 0.8, 0))], [0.2, 0.27, 0.2, 0.05],
         7 if lod == 0 else 4, (0.5, 0.5, 0.3))
    nf = 22 if lod == 0 else 11; seg = 7 if lod == 0 else 3
    for i in range(nf):
        tier = i % 3 if lod == 0 else i % 2 * 2
        az = i * 2.399 + rng.uniform(-0.2, 0.2)
        el = (1.05, 0.55, 0.05)[tier] + rng.uniform(-0.12, 0.12)       # above the horizon
        Lf = (3.3, 3.8, 3.4)[tier] * rng.uniform(0.9, 1.08)
        droop = (0.16, 0.24, 0.3)[tier] * rng.uniform(0.9, 1.2)
        hwid = 0.6
        d = Vector((cos(az) * cos(el), sin(el), sin(az) * cos(el)))
        p = Vector((d.x * 0.12, 0.35 + d.y * 0.1, d.z * 0.12))
        rows = []
        for k in range(seg + 1):
            f = k / seg
            side = d.cross(UP)
            if side.length < 1e-3: side = Vector((1, 0, 0))
            side.normalize(); nn = side.cross(d).normalized()
            sag = 0.34 * hwid * (0.4 + f)
            ao = (0.62 + 0.38 * f) * (1.0, 0.92, 0.72)[tier]
            rows.append((p - side * hwid - nn * sag, p.copy(), p + side * hwid - nn * sag, f, ao))
            p = p + d * (Lf / seg)
            d = (d - UP * (droop * 7 / seg) * (0.5 + f)).normalized()
        u0, v0, u1, v1 = FROND; vm = (v0 + v1) / 2
        for k in range(seg):
            a, b = rows[k], rows[k + 1]
            ua = u0 + (u1 - u0) * a[3]; ub = u0 + (u1 - u0) * b[3]
            ca = (a[4],) * 3; cb = (b[4],) * 3
            m.add([a[0], a[1], b[1], b[0]], [(ua, v0), (ua, vm), (ub, vm), (ub, v0)], [ca, ca, cb, cb])
            m.add([a[1], a[2], b[2], b[1]], [(ua, vm), (ua, v1), (ub, v1), (ub, vm)], [ca, ca, cb, cb])
    return m


def shrub(seed):
    rng = random.Random(seed); m = M()
    crown_cards(m, rng, (0, 0.62, 0), (0.78, 0.6, 0.78), 64, (0.5, 0.72), [SHRUB], 0.2, inner=0.25, bottom=-0.8)
    return m


def hedge(seed):
    rng = random.Random(seed); m = M()
    L, Hh, D = 1.0, 1.15, 0.36
    u0, v0, u1, v1 = HEDGE
    c = (0.62, 0.62, 0.6); lo = (0.36, 0.36, 0.35)
    for sgn in (1, -1):
        z = D * sgn
        q = [Vector((-L * sgn, 0, z)), Vector((L * sgn, 0, z)), Vector((L * sgn, Hh, z)), Vector((-L * sgn, Hh, z))]
        m.add(q, [(u0, v1), (u1, v1), (u1, v0), (u0, v0)], [lo, lo, c, c])
        x = L * sgn
        q = [Vector((x, 0, D * sgn)), Vector((x, 0, -D * sgn)), Vector((x, Hh, -D * sgn)), Vector((x, Hh, D * sgn))]
        m.add(q, [(u0, v1), (u0 + (u1 - u0) * 0.36, v1), (u0 + (u1 - u0) * 0.36, v0), (u0, v0)], [lo, lo, c, c])
    m.add([Vector((-L, Hh, D)), Vector((L, Hh, D)), Vector((L, Hh, -D)), Vector((-L, Hh, -D))],
          [(u0, v1), (u1, v1), (u1, v1 - (v1 - v0) * 0.36), (u0, v1 - (v1 - v0) * 0.36)], [c] * 4)
    # Loose sprays breaking every edge, so the run has a leafy outline and not a ruled one.
    for i in range(46):
        face = rng.random()
        x = rng.uniform(-L, L); s = rng.uniform(0.34, 0.5); a = rng.uniform(0.8, 1.0)
        if face < 0.5:
            P = Vector((x, Hh + rng.uniform(-0.04, 0.05), rng.uniform(-D, D))); n = Vector((rng.uniform(-0.5, 0.5), 1, rng.uniform(-0.5, 0.5)))
        else:
            sg = 1 if face < 0.75 else -1
            y = rng.uniform(0.25, Hh); a *= 0.55 + 0.45 * y / Hh
            P = Vector((x, y, (D + 0.03) * sg)); n = Vector((rng.uniform(-0.5, 0.5), rng.uniform(-0.2, 0.6), sg))
        card(m, P, n.normalized(), s, s, SHRUB, (a, a, a), rng.uniform(0, tau), rng.random() < 0.5)
    return m


def to_object(name, m, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(v.x, -v.z, v.y) for v in m.v], [], m.f)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    uv = []; col = []
    for i in range(len(m.f)):
        for k in range(len(m.f[i])):
            u, v = m.uv[i][k]; uv.extend((u, 1.0 - v))
            c = m.col[i][k]; col.extend((c[0], c[1], c[2], 1.0))
    assert len(uv) == len(me.loops) * 2, (name, len(uv), len(me.loops))
    uvl.data.foreach_set('uv', uv)
    ca = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    ca.data.foreach_set('color', col)
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.materials.append(mat)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    print('  %-14s %5d tris' % (name, m.tris()))
    return ob


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mat = bpy.data.materials.new('flora')
    obs = []
    trees = {
        'plane': dict(seed=11, fork=3.3, r0=0.2, C=(0, 6.3, 0), R=(2.5, 2.9, 2.5), nb=6, bark=(0.86, 0.83, 0.72), ncards=290, size=(1.05, 1.5), lump=0.16),
        'maple': dict(seed=23, fork=2.3, r0=0.24, C=(0, 5.3, 0), R=(3.2, 2.7, 3.2), nb=7, bark=(0.52, 0.44, 0.38), ncards=320, size=(1.1, 1.6), lump=0.18),
        'oak': dict(seed=37, fork=2.6, r0=0.38, C=(0, 6.3, 0), R=(4.5, 3.3, 4.5), nb=8, bark=(0.44, 0.37, 0.31), ncards=380, size=(1.3, 1.9), lump=0.22),
    }
    for name, kw in trees.items():
        for lod in (0, 1):
            obs.append(to_object('%s_L%d' % (name, lod), broadleaf(lod=lod, **kw), mat))
    for lod in (0, 1):
        obs.append(to_object('cypress_L%d' % lod, cypress(41, lod), mat))
        obs.append(to_object('palmtrunk_L%d' % lod, palm_trunk(lod), mat))
        obs.append(to_object('palmcrown_L%d' % lod, palm_crown(53, lod), mat))
    obs.append(to_object('shrub_L0', shrub(61), mat))
    obs.append(to_object('hedge_L0', hedge(67), mat))
    for o in obs: o.select_set(True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=False,
                              export_skins=False, export_morph=False, export_extras=False)
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


main()
