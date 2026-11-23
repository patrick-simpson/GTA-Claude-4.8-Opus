# Port Calamity's moose (fun queue item 5), modelled in Blender by script and exported as one .glb.
#
#   blender --factory-startup --python tools/blender/moose.py --python-expr "import bpy; bpy.ops.wm.quit_blender()" -- [--no-render]
#
# Writes public/models/moose.glb and a preview, shots/blender/moose.jpg.
#
# Authored in the GAME's frame (x = the animal's left, y = up, z = forward, hooves at y 0) and passed through B()
# into Blender's Z-up frame; the exporter's Y-up conversion lands it back where it started.
#
# A moose is a set of smooth lofts that run into each other like a jointed doll's parts (as people.py does it):
# one long tube from rump to nose with elliptical rings that are taller above the spine line than below (the
# shoulder hump, the deep chest, the long overhanging nose), four legs buried in the body, ears, the bell under the
# bull's throat, a stub tail, and on the bull two palmate antlers (a beam out of the skull and a cupped palm whose
# rim is the tines). Every level of detail is built from the same controls with fewer rings and stations, which
# keeps the silhouette where decimation would eat the antlers.
#
# THE CONTRACT with src/world/moose.ts:
#   One armature, 'rig', 21 bones (BONES below), and eight skinned meshes bound to it:
#     bull_L0 bull_L1 bull_L2 bull_far   cow_L0 cow_L1 cow_L2 cow_far
#   (the calf is the cow, scaled and tinted in the game). One material, 'moose'; COLOR_0 is the coat with a
#   little baked occlusion (alpha 1). Animations, looping, at 30 fps: walk, trot, charge, graze, look, shake.
#   Walk covers WALK_STRIDE m per loop, trot TROT_STRIDE, charge CHARGE_STRIDE (printed in STATS; the game scales
#   playback to its speed).

import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Quaternion, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'models', 'moose.glb')
SHOT = os.path.join(ROOT, 'shots', 'blender', 'moose.jpg')
FPS = 30


def B(p):
    return Vector((p[0], -p[2], p[1]))


def norm(v):
    l = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / l for c in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def add(a, b, k=1.0):
    return tuple(a[i] + b[i] * k for i in range(3))


def catmull(ctrl, per):
    """Catmull-Rom through a list of equal-length tuples, `per` samples per span (ends included)."""
    out = []
    n = len(ctrl)
    for i in range(n - 1):
        p0 = ctrl[max(0, i - 1)]; p1 = ctrl[i]; p2 = ctrl[i + 1]; p3 = ctrl[min(n - 1, i + 2)]
        for s in range(per):
            t = s / per
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                                    + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3) for k in range(len(p1))))
    out.append(tuple(ctrl[-1]))
    return out


# ── The skeleton (game frame) ───────────────────────────────────────────────

BONES = []  # (name, head, tail, parent)


def bone(name, h, t, parent=None):
    BONES.append((name, h, t, parent))


bone('hips', (0, 1.55, -0.85), (0, 1.50, -0.20))
bone('spine', (0, 1.50, -0.20), (0, 1.55, 0.40), 'hips')
bone('chest', (0, 1.55, 0.40), (0, 1.62, 0.82), 'spine')
bone('neck', (0, 1.62, 0.82), (0, 1.84, 1.16), 'chest')
bone('head', (0, 1.84, 1.16), (0, 1.60, 1.86), 'neck')
bone('tail', (0, 1.60, -1.22), (0, 1.42, -1.38), 'hips')
for s, side in ((1, 'l'), (-1, 'r')):
    bone(f'ear_{side}', (0.09 * s, 1.98, 1.22), (0.30 * s, 2.08, 1.12), 'head')
    bone(f'f{side}_up', (0.24 * s, 1.30, 0.52), (0.24 * s, 0.88, 0.47), 'chest')
    bone(f'f{side}_lo', (0.24 * s, 0.88, 0.47), (0.23 * s, 0.55, 0.52), f'f{side}_up')
    bone(f'f{side}_cn', (0.23 * s, 0.55, 0.52), (0.23 * s, 0.10, 0.56), f'f{side}_lo')
    bone(f'f{side}_hf', (0.23 * s, 0.10, 0.56), (0.23 * s, 0.0, 0.64), f'f{side}_cn')
    bone(f'b{side}_up', (0.23 * s, 1.40, -0.78), (0.23 * s, 0.95, -0.62), 'hips')
    bone(f'b{side}_lo', (0.23 * s, 0.95, -0.62), (0.23 * s, 0.62, -0.95), f'b{side}_up')
    bone(f'b{side}_cn', (0.23 * s, 0.62, -0.95), (0.23 * s, 0.10, -0.86), f'b{side}_lo')
    bone(f'b{side}_hf', (0.23 * s, 0.10, -0.86), (0.23 * s, 0.0, -0.78), f'b{side}_cn')
BONE = {b[0]: b for b in BONES}


def seg_dist(p, a, b):
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ap = (p[0] - a[0], p[1] - a[1], p[2] - a[2])
    t = max(0.0, min(1.0, dot(ap, ab) / (dot(ab, ab) or 1)))
    q = add(a, ab, t)
    return math.sqrt(sum((p[i] - q[i]) ** 2 for i in range(3)))


def weights(p, cands):
    """The two nearest candidate bones, by inverse cube of distance."""
    ds = sorted(((seg_dist(p, BONE[c][1], BONE[c][2]), c) for c in cands))[:2]
    if len(ds) == 1:
        return [(ds[0][1], 1.0)]
    w0 = 1 / max(ds[0][0], 0.02) ** 3; w1 = 1 / max(ds[1][0], 0.02) ** 3
    return [(ds[0][1], w0 / (w0 + w1)), (ds[1][1], w1 / (w0 + w1))]


# ── A mesh builder ──────────────────────────────────────────────────────────

class M:
    def __init__(self):
        self.v = []; self.f = []; self.col = []; self.w = []

    def tube(self, stations, segs, cands, colour, cap0=True, cap1=True, ref=(0, 1, 0)):
        """stations: (x, y, z, rx, ry_top, ry_bot). Rings around the path, superellipse-ish, capped."""
        base = len(self.v)
        n = len(stations)
        for i, st in enumerate(stations):
            c = st[:3]
            a = stations[max(0, i - 1)][:3]; b = stations[min(n - 1, i + 1)][:3]
            t = norm((b[0] - a[0], b[1] - a[1], b[2] - a[2]))
            r = ref if abs(dot(t, ref)) < 0.9 else (0, 0, 1)
            side = norm(cross(r, t)); up = norm(cross(t, side))
            for k in range(segs):
                ang = 2 * math.pi * k / segs
                ca, sa = math.cos(ang), math.sin(ang)
                ry = st[4] if sa > 0 else st[5]
                # A slightly squared ellipse reads as muscle rather than pipe.
                e = 0.85
                cx = math.copysign(abs(ca) ** e, ca); sy = math.copysign(abs(sa) ** e, sa)
                p = add(add(c, side, cx * st[3]), up, sy * ry)
                nrm = norm(add(side and tuple(s_ * ca / max(st[3], 1e-3) for s_ in side), tuple(u_ * sa / max(ry, 1e-3) for u_ in up)))
                self._vert(p, nrm, cands, colour)
        for i in range(n - 1):
            for k in range(segs):
                a = base + i * segs + k; b = base + i * segs + (k + 1) % segs
                self.f.append((a, base + (i + 1) * segs + k, base + (i + 1) * segs + (k + 1) % segs, b))
        if cap0:
            ci = len(self.v); self._vert(stations[0][:3], (0, 0, 0), cands, colour)
            for k in range(segs):
                self.f.append((ci, base + (k + 1) % segs, base + k))
        if cap1:
            ci = len(self.v); self._vert(stations[-1][:3], (0, 0, 0), cands, colour)
            o = base + (n - 1) * segs
            for k in range(segs):
                self.f.append((ci, o + k, o + (k + 1) % segs))

    def _vert(self, p, nrm, cands, colour):
        self.v.append(p)
        self.col.append(colour(p, nrm))
        self.w.append(weights(p, cands) if isinstance(cands, (list, tuple)) else [(cands, 1.0)])

    def sphere(self, c, r, segs, cands, colour):
        rings = max(3, segs // 2)
        st = []
        for i in range(rings + 1):
            a = -math.pi / 2 + math.pi * i / rings
            rr = max(r * math.cos(a), 1e-4)
            st.append((c[0], c[1], c[2] + r * math.sin(a), rr, rr, rr))
        self.tube(st, segs, cands, colour, False, False)

    def palm(self, s, base, scale, sub, colour):
        """A cupped antler palm whose rim is the tines, built as a solidified, subdivided outline."""
        U = norm((s * 1.0, 0.22, -0.18))
        V = norm((-s * 0.25, 0.62, 0.60))
        N = norm(cross(U, V)) if s > 0 else norm(cross(V, U))
        out = [(0.0, 0.03), (0.12, -0.06), (0.40, -0.13), (0.70, -0.11), (0.92, -0.02), (1.04, 0.16), (0.90, 0.20),
               (0.97, 0.40), (0.82, 0.34), (0.80, 0.55), (0.67, 0.42), (0.62, 0.62), (0.53, 0.43), (0.44, 0.58),
               (0.37, 0.38), (0.25, 0.46), (0.20, 0.22), (0.08, 0.10)]
        bm = bmesh.new()
        vs = []
        for (u, v) in out:
            cup = 0.16 * (v + 0.13) ** 2 + 0.05 * u * u
            p = add(add(add(base, U, u * scale), V, v * scale), N, cup * scale * (1 if s > 0 else 1))
            vs.append(bm.verts.new(B(p)))
        f = bm.faces.new(vs if s > 0 else list(reversed(vs)))
        bmesh.ops.triangulate(bm, faces=[f])
        me = bpy.data.meshes.new('palm_tmp'); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new('palm_tmp', me); bpy.context.scene.collection.objects.link(ob)
        so = ob.modifiers.new('s', 'SOLIDIFY'); so.thickness = 0.045; so.offset = 0
        if sub:
            ss = ob.modifiers.new('ss', 'SUBSURF'); ss.levels = sub; ss.render_levels = sub
        dg = bpy.context.evaluated_depsgraph_get()
        me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
        me2.calc_loop_triangles() if hasattr(me2, 'calc_loop_triangles') else None
        off = len(self.v)
        for vt in me2.vertices:
            g = (vt.co.x, vt.co.z, -vt.co.y)
            self.v.append(g); self.col.append(colour(g, (0, 1, 0))); self.w.append([('head', 1.0)])
        for p in me2.polygons:
            self.f.append(tuple(off + i for i in p.vertices))
        bpy.data.meshes.remove(me2)

    def finish(self, name, mat, arm_ob):
        me = bpy.data.meshes.new(name)
        me.from_pydata([B(p) for p in self.v], [], self.f)
        me.validate(clean_customdata=False)
        for p in me.polygons:
            p.use_smooth = True
        ca = me.color_attributes.new('Col', 'BYTE_COLOR', 'POINT')
        for i, c in enumerate(self.col):
            ca.data[i].color = (c[0], c[1], c[2], 1.0)
        me.color_attributes.active_color = ca
        me.materials.append(mat)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        groups = {b[0]: ob.vertex_groups.new(name=b[0]) for b in BONES}
        for i, ws in enumerate(self.w):
            for (bn, w) in ws:
                if w > 0.001:
                    groups[bn].add([i], w, 'REPLACE')
        ob.parent = arm_ob
        md = ob.modifiers.new('rig', 'ARMATURE'); md.object = arm_ob
        return ob, len(me.polygons)


# ── Coats ───────────────────────────────────────────────────────────────────

def lerp3(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def smooth(t):
    t = max(0.0, min(1.0, t)); return t * t * (3 - 2 * t)


def coat(bull):
    body = (0.115, 0.075, 0.048) if bull else (0.20, 0.135, 0.085)
    back = (0.06, 0.042, 0.03) if bull else (0.13, 0.09, 0.06)
    leg = (0.50, 0.44, 0.35) if bull else (0.56, 0.49, 0.39)
    face = (0.16, 0.12, 0.09) if bull else (0.30, 0.23, 0.16)
    nose = (0.07, 0.06, 0.05)

    def f(p, n):
        x, y, z = p
        c = body
        c = lerp3(c, back, smooth((y - 1.80) / 0.25) * smooth((z + 0.4) / 0.6))
        if z > 1.12 and y > 1.3:
            c = lerp3(c, face, smooth((z - 1.15) / 0.2))
            c = lerp3(c, nose, smooth((z - 1.62) / 0.18))
            # Eyes and nostrils.
            if abs(abs(x) - 0.15) < 0.04 and abs(y - 1.88) < 0.04 and abs(z - 1.36) < 0.05:
                c = (0.02, 0.02, 0.02)
        # Pale stockings, dark hooves.
        c = lerp3(c, leg, smooth((1.0 - y) / 0.3))
        c = lerp3(c, (0.05, 0.045, 0.04), smooth((0.11 - y) / 0.04))
        ao = 0.62 + 0.38 * (0.5 + 0.5 * max(-1.0, min(1.0, n[1] if n != (0, 0, 0) else 0)))
        if abs(x) < 0.3 and 0.6 < y < 1.15:
            ao *= 0.8  # between the legs, under the belly
        return tuple(ci * ao for ci in c)
    return f


def antler_coat(p, n):
    y = p[1]
    t = smooth((y - 2.05) / 0.45)
    c = lerp3((0.30, 0.25, 0.18), (0.80, 0.74, 0.62), t)
    return c


def eye_coat(p, n):
    return (0.015, 0.012, 0.01)


# ── The body ────────────────────────────────────────────────────────────────

SPINE_BULL = [
    # (z, y, rx, ry_top, ry_bot)
    (-1.32, 1.56, 0.05, 0.05, 0.05),
    (-1.24, 1.62, 0.20, 0.20, 0.28),
    (-1.06, 1.63, 0.32, 0.29, 0.42),
    (-0.76, 1.58, 0.39, 0.32, 0.50),
    (-0.30, 1.48, 0.45, 0.40, 0.52),
    (0.15, 1.50, 0.44, 0.48, 0.53),
    (0.50, 1.50, 0.40, 0.58, 0.56),
    (0.80, 1.56, 0.29, 0.50, 0.48),
    (1.00, 1.71, 0.21, 0.34, 0.36),
    (1.16, 1.85, 0.17, 0.22, 0.25),
    (1.33, 1.87, 0.155, 0.16, 0.19),
    (1.55, 1.75, 0.125, 0.12, 0.15),
    (1.74, 1.65, 0.125, 0.115, 0.135),
    (1.86, 1.59, 0.13, 0.115, 0.115),
    (1.94, 1.54, 0.07, 0.07, 0.07),
]
# The cow: no hump to speak of, a slimmer neck, a finer head.
SPINE_COW = [(z, y - (0.08 if 0.2 < z < 0.9 else 0.0), rx * (0.92 if z < 0.9 else 0.88), rt * (0.80 if 0.3 < z < 0.95 else 0.92), rb * 0.94)
             for (z, y, rx, rt, rb) in SPINE_BULL]

FRONT = [(0.20, 1.34, 0.50, 0.15), (0.235, 1.12, 0.52, 0.16), (0.245, 0.88, 0.47, 0.105), (0.235, 0.56, 0.52, 0.075),
         (0.232, 0.45, 0.53, 0.058), (0.23, 0.15, 0.555, 0.052), (0.23, 0.07, 0.585, 0.068), (0.23, 0.0, 0.62, 0.07)]
HIND = [(0.17, 1.42, -0.80, 0.19), (0.225, 1.16, -0.70, 0.20), (0.235, 0.96, -0.63, 0.135), (0.235, 0.80, -0.80, 0.10),
        (0.232, 0.63, -0.95, 0.078), (0.232, 0.50, -0.935, 0.058), (0.23, 0.15, -0.865, 0.052), (0.23, 0.07, -0.83, 0.068),
        (0.23, 0.0, -0.795, 0.07)]

LODS = {  # stations per span, ring segments, leg segments, antler subdivision, extras
    'L0': (5, 30, 14, 2, True),
    'L1': (3, 18, 10, 1, True),
    'L2': (2, 12, 7, 0, False),
    'far': (1, 8, 5, 0, False),
}


def build(kind, lod, mat, arm_ob):
    bull = kind == 'bull'
    per, segs, lsegs, asub, extras = LODS[lod]
    m = M()
    col = coat(bull)
    spine = SPINE_BULL if bull else SPINE_COW
    st = [(0.0, y, z, rx, rt, rb) for (z, y, rx, rt, rb) in catmull(spine, per)]
    m.tube(st, segs, ['hips', 'spine', 'chest', 'neck', 'head'], col)
    for s, side in ((1, 'l'), (-1, 'r')):
        for ctrl, pre, par in ((FRONT, 'f', 'chest'), (HIND, 'b', 'hips')):
            k = 1.0 if bull else 0.94
            pts = catmull([(x * s, y, z, r * k) for (x, y, z, r) in ctrl], max(1, per - 1))
            m.tube([(p[0], p[1], p[2], p[3] * 0.9, p[3], p[3]) for p in pts], lsegs,
                   [par] + [f'{pre}{side}_{b}' for b in ('up', 'lo', 'cn', 'hf')], col, ref=(0, 0, 1))
        # Ears: long, flattened, a little cupped forward.
        ear = catmull([(0.08 * s, 1.97, 1.23, 0.04), (0.17 * s, 2.03, 1.19, 0.065), (0.25 * s, 2.07, 1.15, 0.055), (0.31 * s, 2.09, 1.12, 0.022)], max(1, per - 1))
        m.tube([(p[0], p[1], p[2], p[3] * 0.45, p[3], p[3]) for p in ear], max(6, lsegs - 4), f'ear_{side}', col)
        if extras:
            m.sphere((0.148 * s, 1.885, 1.355), 0.026, 10 if lod == 'L0' else 6, 'head', eye_coat)
        if bull:
            beam = catmull([(0.09 * s, 1.99, 1.24, 0.06), (0.22 * s, 2.06, 1.20, 0.052), (0.33 * s, 2.10, 1.16, 0.045)], max(1, per - 1))
            m.tube([(p[0], p[1], p[2], p[3], p[3], p[3]) for p in beam], max(6, lsegs - 4), 'head', antler_coat)
            m.palm(s, (0.31 * s, 2.09, 1.16), 0.80, asub, antler_coat)
    # The bell under the throat (the bull's is longer), and the stub tail.
    bl = 0.30 if bull else 0.12
    bell = catmull([(0.0, 1.62, 1.20, 0.07), (0.0, 1.55 - bl * 0.4, 1.17, 0.05), (0.0, 1.50 - bl, 1.15, 0.035), (0.0, 1.47 - bl, 1.15, 0.01)], max(1, per - 1))
    m.tube([(p[0], p[1], p[2], p[3] * 0.4, p[3], p[3]) for p in bell], max(6, lsegs - 4), ['neck', 'head'], col, ref=(0, 0, 1))
    tail = catmull([(0.0, 1.60, -1.22, 0.06), (0.0, 1.50, -1.32, 0.05), (0.0, 1.42, -1.37, 0.02)], max(1, per - 1))
    m.tube([(p[0], p[1], p[2], p[3], p[3], p[3]) for p in tail], max(6, lsegs - 6), 'tail', col)
    return m.finish(f'{kind}_{lod}', mat, arm_ob)


# ── Rig and animation ───────────────────────────────────────────────────────

def make_rig():
    arm = bpy.data.armatures.new('rig')
    ob = bpy.data.objects.new('rig', arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for (n, h, t, par) in BONES:
        b = arm.edit_bones.new(n)
        b.head = B(h); b.tail = B(t); b.roll = 0
        if par:
            b.parent = eb[par]
            b.use_connect = False
        eb[n] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob


GX = Vector((1, 0, 0))   # game X (pitch: + is nose down, leg back)
GY = Vector((0, 0, 1))   # game Y (yaw: + turns toward the animal's left)
GZ = Vector((0, -1, 0))  # game Z (roll)


def pose_q(ob, name, pitch=0.0, yaw=0.0, roll=0.0):
    R = ob.data.bones[name].matrix_local.to_3x3()
    Ri = R.inverted()
    q = Quaternion()
    for ax, a in ((GY, yaw), (GX, pitch), (GZ, roll)):
        if a:
            q = q @ Quaternion(Ri @ ax, a)
    return q


def leg(p, duty, A):
    p %= 1.0
    if p < duty:
        s = p / duty
        return -A + 2 * A * s, 0.0
    s = (p - duty) / (1 - duty)
    return A - 2 * A * smooth(s), math.sin(math.pi * s)


def gait_pose(t, period, duty, Af, Ab, phases, bounce, extra):
    """phases: lf, rf, lb, rb. Returns {bone: (pitch, yaw, roll)}, hips offset (game)."""
    u = t / period
    P = {}
    for side, pf, pb in (('l', phases[0], phases[2]), ('r', phases[1], phases[3])):
        a, fold = leg(u + pf, duty, Af)
        P[f'f{side}_up'] = (a, 0, 0); P[f'f{side}_lo'] = (-0.35 * fold, 0, 0)
        P[f'f{side}_cn'] = (1.15 * fold, 0, 0); P[f'f{side}_hf'] = (0.35 * fold - 0.1 * a, 0, 0)
        a, fold = leg(u + pb, duty, Ab)
        P[f'b{side}_up'] = (a - 0.32 * fold, 0, 0); P[f'b{side}_lo'] = (0.55 * fold, 0, 0)
        P[f'b{side}_cn'] = (-0.75 * fold, 0, 0); P[f'b{side}_hf'] = (0.3 * fold - 0.1 * a, 0, 0)
    w = 2 * math.pi * u
    P['hips'] = (0.02 * math.sin(2 * w), 0.02 * math.sin(w), 0.025 * math.sin(w))
    P['spine'] = (0, -0.015 * math.sin(w), 0)
    P['chest'] = (-0.02 * math.sin(2 * w), -0.02 * math.sin(w), -0.02 * math.sin(w))
    P['neck'] = (extra[0] + 0.05 * math.sin(2 * w + 0.6), 0.02 * math.sin(w), 0)
    P['head'] = (extra[1] - 0.04 * math.sin(2 * w + 0.6), 0, 0)
    P['tail'] = (0.1 * math.sin(w), 0.15 * math.sin(w), 0)
    off = (0, -bounce * (0.5 - 0.5 * math.cos(2 * w)), 0)
    return P, off


def act_walk(t):
    return gait_pose(t, 1.30, 0.66, 0.30, 0.27, (0.25, 0.75, 0.0, 0.5), 0.025, (0.08, 0.05))


def act_trot(t):
    return gait_pose(t, 0.72, 0.46, 0.44, 0.40, (0.0, 0.5, 0.5, 0.0), 0.06, (0.0, 0.0))


def act_charge(t):
    return gait_pose(t, 0.56, 0.42, 0.52, 0.48, (0.0, 0.5, 0.5, 0.0), 0.08, (0.45, 0.55))


def act_graze(t):
    w = 2 * math.pi * t / 3.0
    P = {'neck': (1.05, 0.08 * math.sin(w * 0.5), 0), 'head': (0.45 + 0.05 * math.sin(w * 3), 0.05 * math.sin(w), 0),
         'chest': (0.12, 0, 0), 'spine': (0.03, 0, 0),
         'ear_l': (0, 0.25 * max(0, math.sin(w * 2)) ** 8, 0), 'ear_r': (0, -0.2 * max(0, math.sin(w * 2 + 2)) ** 8, 0),
         'tail': (0, 0.2 * math.sin(w * 2), 0)}
    for side, s in (('l', 1), ('r', -1)):
        P[f'f{side}_up'] = (-0.22, 0, 0.10 * s); P[f'f{side}_cn'] = (0.12, 0, 0); P[f'f{side}_hf'] = (0.1, 0, 0)
        P[f'b{side}_up'] = (0.05, 0, 0)
    return P, (0, -0.03, 0)


def act_look(t):
    # Head up, a slow look one way, a pause, the other way; ears that never stop.
    T = 4.0
    u = (t % T) / T
    yaw = 0.55 * math.sin(2 * math.pi * u) * (0.7 + 0.3 * math.cos(4 * math.pi * u))
    P = {'neck': (-0.18, yaw * 0.6, 0), 'head': (0.05, yaw * 0.5, 0.05 * yaw),
         'ear_l': (0, 0.3 * math.sin(2 * math.pi * u * 3), 0), 'ear_r': (0, -0.3 * math.sin(2 * math.pi * u * 3 + 1), 0),
         'tail': (0, 0.15 * math.sin(2 * math.pi * u * 2), 0), 'chest': (-0.03, 0.04 * yaw, 0)}
    return P, (0, 0, 0)


def act_shake(t):
    # The "what was that" after a car: a big shake of the head and neck, settling.
    T = 1.6
    env = math.sin(math.pi * min(1.0, t / T))
    w = 2 * math.pi * 4.5 * t
    P = {'neck': (0.25 * env, 0.25 * env * math.sin(w), 0.2 * env * math.sin(w)), 'head': (0.15 * env, 0.25 * env * math.sin(w + 0.5), 0.5 * env * math.sin(w)),
         'ear_l': (0, 0.4 * env * math.sin(w), 0), 'ear_r': (0, -0.4 * env * math.sin(w), 0), 'chest': (0, 0, 0.06 * env * math.sin(w))}
    for side in 'lr':
        P[f'f{side}_up'] = (-0.08 * env, 0, 0)
    return P, (0, -0.02 * env, 0)


ACTIONS = [('walk', act_walk, 1.30), ('trot', act_trot, 0.72), ('charge', act_charge, 0.56),
           ('graze', act_graze, 3.0), ('look', act_look, 4.0), ('shake', act_shake, 1.6)]


def stride(period, duty, A):
    # Hoof travel in stance: the upper leg turns 2A over the stance about a pivot ~1.3 m up.
    return 2 * math.sin(A) * 1.3 / duty * 1.0


def animate(ob):
    ob.animation_data_create()
    rest_hips = ob.data.bones['hips'].matrix_local.to_3x3().inverted()
    for name, fn, period in ACTIONS:
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        ob.animation_data.action = act
        n = int(round(period * FPS))
        for f in range(n + 1):
            t = (f % n) / FPS if f < n else 0.0
            P, off = fn(t)
            for pb in ob.pose.bones:
                r = P.get(pb.name, (0, 0, 0))
                pb.rotation_quaternion = pose_q(ob, pb.name, *r)
                pb.keyframe_insert('rotation_quaternion', frame=f + 1)
            hp = ob.pose.bones['hips']
            hp.location = rest_hips @ B(off)
            hp.keyframe_insert('location', frame=f + 1)
    ob.animation_data.action = None


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.context.scene.render.fps = FPS
    mat = bpy.data.materials.new('moose')
    mat.roughness = 0.85
    arm_ob = make_rig()
    stats = {}
    meshes = []
    for kind in ('bull', 'cow'):
        for lod in ('L0', 'L1', 'L2', 'far'):
            ob, tris = build(kind, lod, mat, arm_ob)
            meshes.append(ob); stats[ob.name] = tris
    animate(arm_ob)
    stats['WALK_STRIDE'] = round(stride(1.30, 0.66, 0.30) * 0.5, 3)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    arm_ob.select_set(True)
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = arm_ob
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
                              export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_active_vertex_color_when_no_material=True, export_animations=True,
                              export_animation_mode='ACTIONS', export_skins=True, export_morph=False, export_extras=False)
    stats['kB'] = round(os.path.getsize(OUT) / 1000)
    print('STATS ' + json.dumps(stats))
    if '--no-render' not in argv:
        preview(arm_ob, meshes)


def preview(arm_ob, meshes):
    # Bull walking at the left, a cow grazing at the right (a second rig object sharing the armature).
    sc = bpy.context.scene
    cow_rig = arm_ob.copy(); sc.collection.objects.link(cow_rig)
    cow_rig.location = (2.6, 1.2, 0)
    cow_rig.animation_data_create()
    for m in meshes:
        m.hide_render = m.name not in ('bull_L0', 'cow_L0')
        if m.name == 'cow_L0':
            m.parent = cow_rig; m.modifiers['rig'].object = cow_rig
    arm_ob.animation_data.action = bpy.data.actions['walk']
    cow_rig.animation_data.action = bpy.data.actions['graze']
    try:
        arm_ob.animation_data.action_slot = arm_ob.animation_data.action_suitable_slots[0]
        cow_rig.animation_data.action_slot = cow_rig.animation_data.action_suitable_slots[0]
    except Exception:
        pass
    sc.frame_set(12)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam)
    cam.location = (7.5, -6.0, 2.6)
    d = Vector((1.3, 0.3, 1.2)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 40
    sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO'; sh.color_type = 'VERTEX'; sh.show_cavity = True; sh.show_shadows = True
    sc.render.resolution_x = 1400; sc.render.resolution_y = 800
    sc.render.image_settings.file_format = 'JPEG'
    os.makedirs(os.path.dirname(SHOT), exist_ok=True)
    sc.render.filepath = SHOT
    bpy.ops.render.render(write_still=True)
    print('SHEET ' + SHOT)


try:
    main()
except Exception:
    import traceback
    traceback.print_exc()
    print('FAILED')
# Close the window ourselves: quit_blender stops at a "save changes?" box.
sys.stdout.flush()
os._exit(0)
