# Blender-native effects for the trailer shots: what the game export cannot carry (tools/trailer/PLAN.md).
#
#   vehicle lights   headlights, tail lights and police light bars on the cars the exporter recorded (anim.veh)
#   searchlight      the police helicopter's beam (anim.rec[].heli -> the player's car), visible in the night haze
#   fireworks        shells timed to the beat grid (anim.beats): rising tails, bursts of sparks with trails (geometry
#                    nodes, ballistic with drag, from Scene Time), a flash light per burst, smoke lit from inside
#   tornado          a rotating funnel volume with a dust skirt, a cloud ceiling, orbiting debris, lightning on the beats
#   puffs            soft noisy volumes: the falls' spray, the speedboat's wake spray, derby dust, breath
#
# Used by build_shot.py: fx.apply(shot_def, anim, L, cam_pts). A shot lists its effects in shots.json "fx".
# Game frame -> Blender: (x, y, z) -> (x, -z, y); a game heading h faces (sin h, cos h) in x, z.

import bpy, math, random
import numpy as np
from mathutils import Vector, Matrix, Euler
import look
from look import NB, sock, world_pos, make_box


def pt(v):
    return Vector((v[0], -v[2], v[1]))


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def fcurves_of(idb):
    act = idb.animation_data.action
    try:
        return list(act.fcurves)
    except Exception:
        return [fc for layer in act.layers for strip in layer.strips for cb in strip.channelbags for fc in cb.fcurves]


def key_series(ob, path, values, interp='LINEAR'):
    """values: (n, k) array -> keys on frames 1..n."""
    values = np.asarray(values, np.float32)
    if values.ndim == 1:
        values = values[:, None]
    n, k = values.shape
    for c in range(k):
        ob.keyframe_insert(path, index=c, frame=1) if k > 1 else ob.keyframe_insert(path, frame=1)
    for fc in [fc for fc in fcurves_of(ob) if fc.data_path == path]:
        c = fc.array_index
        fc.keyframe_points.clear(); fc.keyframe_points.add(n)
        co = np.empty(n * 2, np.float32); co[0::2] = np.arange(1, n + 1); co[1::2] = values[:, c]
        fc.keyframe_points.foreach_set('co', co)
        for kp in fc.keyframe_points:
            kp.interpolation = interp
        fc.update()


def key_vis(ob, vis):
    """vis: per-frame booleans -> keyed hide_render (and viewport)."""
    prev = None
    for f, v in enumerate(vis):
        if prev is None or bool(v) != prev:
            ob.hide_render = not bool(v); ob.keyframe_insert('hide_render', frame=f + 1)
            prev = bool(v)


def emit_mat(name, color, strength):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            nt.nodes.remove(n)
    out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = (*color, 1); e.inputs['Strength'].default_value = strength
    nt.links.new(e.outputs[0], out.inputs['Surface'])
    return m


def blob(name, mat, radius=0.08, scale=(1, 1, 1)):
    import bmesh
    key = f'blob-{mat.name}'
    me = bpy.data.meshes.get(key)
    if me is None:
        me = bpy.data.meshes.new(key); bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0); bm.to_mesh(me); bm.free()
        me.materials.append(mat)
    ob = link(bpy.data.objects.new(name, me))
    ob.scale = (radius * scale[0], radius * scale[1], radius * scale[2])
    try:
        ob.visible_shadow = False
    except Exception:
        pass
    return ob


# ---------------------------------------------------------------------------------------------------------------------
# Tracks and rigs.

def vehicle_tracks(anim):
    tr = {}
    for f, lst in enumerate(anim.get('veh') or []):
        for v in lst:
            d = tr.setdefault(v[0], dict(kind=v[1], L=v[6], W=v[7], H=v[8], player=v[9], fr={}, moved=False))
            d['fr'][f] = (v[2], v[3], v[4], v[5])
            if v[10] > 0.6 or v[9]:
                d['moved'] = True
    return tr


def rig(name, fr, frames):
    """An empty that follows a recorded track: fr = {frame: (x, y, z, h)} in the game's frame. Local +Y is forward."""
    ob = link(bpy.data.objects.new(name, None)); ob.empty_display_size = 0.5
    have = sorted(fr)
    locs = np.zeros((frames, 3), np.float32); rz = np.zeros(frames, np.float64)
    for f in range(frames):
        g = min(have, key=lambda q: abs(q - f))
        x, y, z, h = fr[g]
        locs[f] = (x, -z, y); rz[f] = math.pi + h
    rz = np.unwrap(rz)
    ob.rotation_mode = 'XYZ'
    key_series(ob, 'location', locs)
    key_series(ob, 'rotation_euler', np.stack([np.zeros(frames), np.zeros(frames), rz], axis=1))
    if len(have) < frames:
        key_vis(ob, [f in fr for f in range(frames)])
    return ob


def child(ob, parent, loc, rot=(0, 0, 0)):
    ob.parent = parent; ob.location = loc; ob.rotation_euler = rot
    return ob


def car_lights(name, parent, d, head=True, power=1.0, frames=1, vis=None):
    L, W = d['L'], d['W']
    out = []
    if head:
        lens = emit_mat('fx-headlamp', (1.0, 0.93, 0.80), 220.0)
        for sx in (-1, 1):
            ld = bpy.data.lights.new(name + '-head', 'SPOT'); ld.energy = 500.0 * power; ld.spot_size = math.radians(72); ld.spot_blend = 0.55
            ld.shadow_soft_size = 0.06; ld.color = (1.0, 0.93, 0.82)
            lo = child(link(bpy.data.objects.new(name + '-head', ld)), parent, (sx * W * 0.33, L * 0.5 + 0.02, 0.66), (math.radians(86), 0, 0))
            b = child(blob(name + '-lens', lens, 0.085, (1.3, 0.35, 0.8)), parent, (sx * W * 0.33, L * 0.5 - 0.01, 0.66))
            out += [lo, b]
        red = emit_mat('fx-taillamp', (1.0, 0.03, 0.02), 30.0)
        for sx in (-1, 1):
            out.append(child(blob(name + '-tail', red, 0.07, (1.6, 0.3, 0.7)), parent, (sx * W * 0.34, -L * 0.5 + 0.01, 0.80)))
        pd = bpy.data.lights.new(name + '-tailglow', 'POINT'); pd.energy = 14.0 * power; pd.color = (1.0, 0.05, 0.03); pd.shadow_soft_size = 0.2
        out.append(child(link(bpy.data.objects.new(name + '-tailglow', pd)), parent, (0, -L * 0.5 - 0.25, 0.8)))
    if vis is not None:
        for o in out:
            key_vis(o, vis)
    return out


def light_bar(name, parent, d, frames, night, phase=0):
    """Police light bar: red and blue flashing in turn (three frames each), as emissive lenses and real lights."""
    H, W = d['H'], d['W']
    for k, (col, sx) in enumerate((((1.0, 0.02, 0.02), -1), ((0.03, 0.12, 1.0), 1))):
        m = emit_mat(f'fx-bar{k}', col, 400.0 if night < 0.5 else 160.0)
        b = child(blob(f'{name}-bar{k}', m, 0.11, (2.2, 1.0, 0.7)), parent, (sx * W * 0.2, -0.15, H + 0.06))
        pd = bpy.data.lights.new(f'{name}-bar{k}', 'POINT'); pd.energy = 900.0 + 700.0 * night; pd.color = col; pd.shadow_soft_size = 0.12
        lo = child(link(bpy.data.objects.new(f'{name}-barl{k}', pd)), parent, (sx * W * 0.2, -0.15, H + 0.22))
        vis = [((f + phase) // 3) % 2 == k for f in range(frames)]
        key_vis(b, vis); key_vis(lo, vis)


def vehicle_lights(anim, L, cam_pts, force=False, clear=0.0):
    frames = anim['frames']
    night = L.get('night', 0.0)
    tr = vehicle_tracks(anim)
    cops = set()
    for r in anim.get('rec') or []:
        for c in (r or {}).get('cops') or []:
            cops.add(c)
    cams = np.array(cam_pts, np.float32)
    n = 0
    for vid, d in tr.items():
        if d['kind'] in ('speedboat', 'jetski', 'train', 'bike', 'scooter'):
            continue
        # Near the camera at some point?
        near = False
        for f, (x, y, z, h) in d['fr'].items():
            c = cams[min(f, len(cams) - 1)]
            if (x - c[0]) ** 2 + (-z - c[1]) ** 2 < (120.0 if d['moved'] else 60.0) ** 2:
                near = True; break
        if not near:
            continue
        if clear > 0 and any((x - cams[min(f, len(cams) - 1)][0]) ** 2 + (-z - cams[min(f, len(cams) - 1)][1]) ** 2 < clear ** 2 for f, (x, y, z, h) in d['fr'].items()):
            continue          # drives through the lens: left out (build_shot.py drops its body the same way)
        is_cop = vid in cops or d['kind'] == 'cruiser'
        if not (night >= 0.3 or force or is_cop):
            continue
        # Parked cars are dark: only cars that drive (or wait in traffic, when the shot asks) have their lamps on.
        if not is_cop and not d['moved'] and not force:
            continue
        r = rig(f'veh{vid}', d['fr'], frames)
        vis = [f in d['fr'] for f in range(frames)] if len(d['fr']) < frames else None
        if night >= 0.3 or force:
            car_lights(f'veh{vid}', r, d, frames=frames, vis=vis)
        if is_cop:
            light_bar(f'veh{vid}', r, d, frames, night, phase=vid % 5)
        n += 1
    return n


def searchlight(anim, L):
    frames = anim['frames']
    rec = anim.get('rec') or []
    hp = [r.get('heli') for r in rec]
    if not any(hp):
        return False
    first = next(h for h in hp if h)
    locs = np.array([pt((h or first)[:3]) + Vector((0, 0, -1.2)) for h in hp], np.float32)
    ld = bpy.data.lights.new('searchlight', 'SPOT'); ld.energy = 1.5e5; ld.spot_size = math.radians(6.5); ld.spot_blend = 0.25
    ld.shadow_soft_size = 0.35; ld.color = (0.86, 0.92, 1.0)
    ob = link(bpy.data.objects.new('searchlight', ld))
    key_series(ob, 'location', locs)
    tg = link(bpy.data.objects.new('searchlight-aim', None))
    tl = np.array([pt(r['pl']) for r in rec], np.float32)
    f = np.arange(frames)
    tl[:, 0] += np.sin(f * 0.21) * 3.0 + np.sin(f * 0.07 + 1.0) * 2.0
    tl[:, 1] += np.cos(f * 0.17 + 0.5) * 3.0
    key_series(tg, 'location', tl)
    c = ob.constraints.new('TRACK_TO'); c.target = tg; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    # The beam: a cone of thin haze along the light (the shot's haze is done in the compositor, so the beam has its own).
    import bmesh
    LEN = 140.0
    me = bpy.data.meshes.new('searchlight-beam'); bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=LEN * math.tan(ld.spot_size * 0.5) * 1.25, radius2=0.5, depth=LEN)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, -LEN * 0.5 - 0.6)); bm.to_mesh(me); bm.free()
    beam = link(bpy.data.objects.new('searchlight-beam', me)); beam.parent = ob
    bmat = bpy.data.materials.new('searchlight-beam'); bmat.use_nodes = True
    bt = bmat.node_tree
    for n_ in list(bt.nodes):
        if n_.type == 'BSDF_PRINCIPLED':
            bt.nodes.remove(n_)
    bout = [n_ for n_ in bt.nodes if n_.type == 'OUTPUT_MATERIAL'][0]
    bv = bt.nodes.new('ShaderNodeVolumeScatter'); bv.inputs['Density'].default_value = 0.004; bv.inputs['Anisotropy'].default_value = 0.5
    bt.links.new(bv.outputs[0], bout.inputs['Volume'])
    me.materials.append(bmat)
    try:
        beam.visible_shadow = False
    except Exception:
        pass
    lens = blob('searchlight-lens', emit_mat('fx-search', (0.9, 0.95, 1.0), 4000.0), 0.3)
    lens.parent = ob; lens.location = (0, 0, 0.5)
    return True


# ---------------------------------------------------------------------------------------------------------------------
# Volumes.

def volume_material(name, color, density, noise_scale=0.4, speed=0.3, lo=0.35, hi=0.75, aniso=0.3, emission=None, falloff=True):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nb = NB(nt)
    out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    for n in list(nt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            nt.nodes.remove(n)
    tc = nb.n('ShaderNodeTexCoord')
    wd = nb.n('ShaderNodeValue'); wd.outputs[0].driver_add('default_value').driver.expression = f'frame / 24.0 * {speed}'
    nz = nb.maprange(nb.noise(world_pos(nb), scale=noise_scale, detail=2.0, rough=0.5, w=wd.outputs[0]), lo, hi, 0.0, 1.0, smooth=True)
    dens = nz
    if falloff:
        # Object coordinates of the unit box: -0.5..0.5; fade to nothing at the faces.
        ln = nb.n('ShaderNodeVectorMath', operation='LENGTH'); nb.link(tc.outputs['Object'], ln.inputs[0])
        dens = nb.math('MULTIPLY', nz, nb.maprange(ln.outputs['Value'], 0.12, 0.5, 1.0, 0.0, smooth=True))
    vol = nb.n('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (*color, 1); vol.inputs['Anisotropy'].default_value = aniso
    nb.link(nb.math('MULTIPLY', dens, density), vol.inputs['Density'])
    if emission:
        vol.inputs['Emission Color'].default_value = (*emission[:3], 1)
        nb.link(nb.math('MULTIPLY', dens, emission[3]), vol.inputs['Emission Strength'])
    nb.link(vol.outputs[0], out.inputs['Volume'])
    return m


def puff(name, loc, size, color=(1, 1, 1), density=0.1, noise_scale=0.4, speed=0.3, parent=None, **kw):
    ob = make_box(name, loc); ob.scale = size
    ob.data.materials.append(volume_material(name, color, density, noise_scale, speed, **kw))
    if parent is not None:
        ob.parent = parent
    return ob


# ---------------------------------------------------------------------------------------------------------------------
# Fireworks.

PALETTE = [(1.0, 0.10, 0.06), (1.0, 0.55, 0.12), (0.18, 1.0, 0.22), (0.22, 0.42, 1.0), (1.0, 0.18, 0.75), (1.0, 0.92, 0.78), (0.2, 0.95, 1.0), (1.0, 0.78, 0.25)]
G = 5.5       # effective gravity on sparks, m/s^2 (they are light and draggy)


def fireworks(anim, shells, smoke=None, strength=90.0):
    """shells: dicts with tb (burst time, game seconds from the shot's start), pos (game x, y, z), col (palette index),
    kind ('peony' | 'ring' | 'willow' | 'crackle'), n, speed, life, base (game x, y, z of the launcher)."""
    ts = float(anim.get('timeScale') or 1.0)
    J = 6
    rnd = random.Random(11)
    Bs, Vs, T0, LIFE, LAG, KD, COL, WID = [], [], [], [], [], [], [], []
    edges = []
    lights = []

    def add(B, V, t0, life, kd, col, wid, tail):
        i0 = len(Bs)
        for j in range(J):
            Bs.append(B); Vs.append(V); T0.append(t0); LIFE.append(life); LAG.append(j * tail / (J - 1)); KD.append(kd); COL.append((*col, 1.0)); WID.append(wid)
            if j:
                edges.append((i0 + j - 1, i0 + j))

    for s in shells:
        b = pt(s['pos']); col = PALETTE[s.get('col', 0) % len(PALETTE)]
        kind = s.get('kind', 'peony'); n = s.get('n', 200); sp = s.get('speed', 46.0); life = s.get('life', 2.0)
        # The shell's climb: from the launcher to the burst, arriving with no speed left.
        base = pt(s.get('base', (s['pos'][0] * 0.6, 1.0, s['pos'][2])))
        h = max(5.0, b.z - base.z); rise = math.sqrt(2 * h / G)
        v0 = Vector(((b.x - base.x) / rise, (b.y - base.y) / rise, G * rise))
        add(tuple(base), tuple(v0), s['tb'] - rise, rise, 1e-4, (1.0, 0.72, 0.4), 0.22, 0.25)
        tilt = Matrix.Rotation(rnd.uniform(0.3, 1.2), 3, 'X') @ Matrix.Rotation(rnd.uniform(0, 6.28), 3, 'Z')
        for k in range(n):
            if kind == 'ring':
                a = k / n * math.tau
                dvec = tilt @ Vector((math.cos(a), math.sin(a), rnd.uniform(-0.04, 0.04)))
                v = dvec * sp * 0.85; kd = 1.0; lf = life * rnd.uniform(0.85, 1.0); c = col
            else:
                z = rnd.uniform(-1, 1); a = rnd.uniform(0, math.tau); rr = math.sqrt(1 - z * z)
                dvec = Vector((rr * math.cos(a), rr * math.sin(a), z))
                shell_k = rnd.choice((1.0, 1.0, 0.62)) if kind != 'willow' else 1.0
                v = dvec * sp * shell_k * rnd.uniform(0.94, 1.06)
                kd = 1.0 if kind != 'willow' else 0.7
                lf = life * rnd.uniform(0.7, 1.0) * (1.7 if kind == 'willow' else 1.0)
                c = col if (kind != 'peony' or shell_k == 1.0) else PALETTE[(s.get('col', 0) + 5) % len(PALETTE)]
                if kind == 'willow':
                    c = (1.0, 0.62, 0.2)
            add(tuple(b), tuple(v), s['tb'], lf, kd, c, 0.26 if kind != 'willow' else 0.2, 0.34 if kind != 'willow' else 0.7)
        lights.append((s['tb'], b, col, s.get('flash', 1.0) * (n / 200.0)))

    me = bpy.data.meshes.new('fireworks')
    nv = len(Bs)
    me.vertices.add(nv); me.edges.add(len(edges))
    me.vertices.foreach_set('co', np.array(Bs, np.float32).ravel())
    me.edges.foreach_set('vertices', np.array(edges, np.int32).ravel())
    for nm, typ, key, arr in (('B', 'FLOAT_VECTOR', 'vector', Bs), ('V', 'FLOAT_VECTOR', 'vector', Vs), ('t0', 'FLOAT', 'value', T0), ('life', 'FLOAT', 'value', LIFE),
                              ('lag', 'FLOAT', 'value', LAG), ('kd', 'FLOAT', 'value', KD), ('col', 'FLOAT_COLOR', 'color', COL), ('wid', 'FLOAT', 'value', WID)):
        a = me.attributes.new(nm, typ, 'POINT'); a.data.foreach_set(key, np.array(arr, np.float32).ravel())
    me.update()
    ob = link(bpy.data.objects.new('fireworks', me))
    gn = bpy.data.node_groups.new('fireworks-gn', 'GeometryNodeTree')
    gn.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    gn.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nb = NB(gn, x=-1800)
    gi = nb.n('NodeGroupInput'); go = nb.n('NodeGroupOutput')

    def attr(nm, typ='FLOAT'):
        a = nb.n('GeometryNodeInputNamedAttribute', data_type=typ); a.inputs['Name'].default_value = nm
        return a.outputs['Attribute']
    tm = nb.n('GeometryNodeInputSceneTime')
    t = nb.math('MULTIPLY', nb.math('SUBTRACT', tm.outputs['Frame'], 1.0), ts / 24.0)
    age = nb.math('SUBTRACT', nb.math('SUBTRACT', t, attr('t0')), attr('lag'))
    agec = nb.math('MAXIMUM', age, 0.0)
    kd = attr('kd')
    e = nb.math('DIVIDE', nb.math('SUBTRACT', 1.0, nb.math('EXPONENT', nb.math('MULTIPLY', nb.math('MULTIPLY', kd, agec), -1.0))), kd)
    vs = nb.n('ShaderNodeVectorMath', operation='SCALE'); nb.link(attr('V', 'FLOAT_VECTOR'), vs.inputs[0]); nb.link(e, vs.inputs['Scale'])
    drop = nb.n('ShaderNodeCombineXYZ'); nb.link(nb.math('MULTIPLY', nb.math('MULTIPLY', agec, agec), -0.5 * G), drop.inputs['Z'])
    p1 = nb.n('ShaderNodeVectorMath', operation='ADD'); nb.link(attr('B', 'FLOAT_VECTOR'), p1.inputs[0]); nb.link(vs.outputs[0], p1.inputs[1])
    p2 = nb.n('ShaderNodeVectorMath', operation='ADD'); nb.link(p1.outputs[0], p2.inputs[0]); nb.link(drop.outputs[0], p2.inputs[1])
    setp = nb.n('GeometryNodeSetPosition'); nb.link(gi.outputs[0], setp.inputs['Geometry']); nb.link(p2.outputs[0], setp.inputs['Position'])
    life = attr('life')
    fade = nb.math('POWER', nb.math('SUBTRACT', 1.0, nb.math('DIVIDE', agec, life), clamp=True), 1.3)
    lagk = nb.maprange(attr('lag'), 0.0, 0.5, 1.0, 0.25)
    glow = nb.math('MULTIPLY', nb.math('MULTIPLY', fade, lagk), nb.math('GREATER_THAN', age, 0.0))
    st = nb.n('GeometryNodeStoreNamedAttribute', data_type='FLOAT', domain='POINT'); st.inputs['Name'].default_value = 'glow'
    nb.link(setp.outputs[0], st.inputs['Geometry']); nb.link(glow, st.inputs['Value'])
    # Sparks not yet born or burnt out are NOT deleted: a vertex count that changes inside the shutter makes motion
    # blur pair the wrong vertices (one frame smeared across the sky). They shrink to nothing instead.
    alive = nb.math('MULTIPLY', nb.math('GREATER_THAN', age, 0.0), nb.math('LESS_THAN', age, life))
    m2c = nb.n('GeometryNodeMeshToCurve'); nb.link(st.outputs[0], m2c.inputs['Mesh'])
    rad = nb.math('MULTIPLY', nb.math('MULTIPLY', attr('wid'), nb.math('ADD', 0.35, nb.math('MULTIPLY', glow, 0.65))), alive)
    setr = nb.n('GeometryNodeSetCurveRadius'); nb.link(m2c.outputs[0], setr.inputs['Curve']); nb.link(rad, setr.inputs['Radius'])
    circ = nb.n('GeometryNodeCurvePrimitiveCircle'); circ.inputs['Resolution'].default_value = 4; circ.inputs['Radius'].default_value = 1.0
    c2m = nb.n('GeometryNodeCurveToMesh'); nb.link(setr.outputs[0], c2m.inputs['Curve']); nb.link(circ.outputs['Curve'], c2m.inputs['Profile Curve'])
    try:
        nb.link(rad, c2m.inputs['Scale'])
    except Exception:
        pass
    mat = bpy.data.materials.new('fireworks'); mat.use_nodes = True
    mt = mat.node_tree; mnb = NB(mt)
    for n in list(mt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            mt.nodes.remove(n)
    out = [n for n in mt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    em = mnb.n('ShaderNodeEmission')
    ca = mnb.n('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name='col')
    ga = mnb.n('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name='glow')
    # Hot cores go white.
    hot = mnb.mixc(mnb.math('POWER', ga.outputs['Fac'], 3.0), ca.outputs['Color'], (1, 1, 1, 1))
    mnb.link(hot, em.inputs['Color'])
    mnb.link(mnb.math('MULTIPLY', ga.outputs['Fac'], strength), em.inputs['Strength'])
    mnb.link(em.outputs[0], out.inputs['Surface'])
    setm = nb.n('GeometryNodeSetMaterial'); nb.link(c2m.outputs[0], setm.inputs['Geometry']); setm.inputs['Material'].default_value = mat
    nb.link(setm.outputs[0], go.inputs[0])
    mod = ob.modifiers.new('fw', 'NODES'); mod.node_group = gn
    ob.data.materials.append(mat)
    try:
        ob.visible_shadow = False
    except Exception:
        pass
    # A flash of coloured light per burst: lights the water, the smoke, the crowd's faces.
    frames = anim['frames']
    for k, (tb, b, col, pw) in enumerate(lights):
        f0 = tb / ts * 24.0 + 1.0
        if f0 > frames + 2 or f0 < -60 / max(ts, 0.05) * 0.2 - 80:
            continue
        ld = bpy.data.lights.new(f'fw-flash{k}', 'POINT'); ld.color = tuple(0.35 + 0.65 * c for c in col); ld.shadow_soft_size = 14.0
        lo = link(bpy.data.objects.new(f'fw-flash{k}', ld)); lo.location = b
        E0 = 1.6e5 * pw * min(1.0, 2.5 / math.sqrt(len(lights)))
        for f in range(1, frames + 1):
            a = (f - f0) / 24.0 * ts
            e_ = 0.0 if a < -0.02 else E0 * math.exp(-a * 2.2) * (1.0 if a > 0.04 else 0.5)
            ld.energy = e_; ld.keyframe_insert('energy', frame=f)
    if smoke and smoke.get('density', 0) > 0:
        c = pt(smoke['pos'])
        sm = make_box('fw-smoke', c); sm.scale = tuple(smoke.get('size', (420, 160, 150)))
        sm.data.materials.append(volume_material('fw-smoke', (0.75, 0.75, 0.8), smoke.get('density', 0.012), noise_scale=0.012, speed=0.05, lo=0.3, hi=0.8, aniso=0.2))
    return nv


def show(beats, mode, ts=1.0):
    """The shell lists of the three fireworks shots, on the shot's beats (seconds from the cut, in film time)."""
    rnd = random.Random(5)
    S = []
    b = [x * ts for x in beats]      # game seconds
    kinds = ['peony', 'ring', 'peony', 'willow']
    if mode == 'first':
        # The first shells climb from the barge: a burst on each beat after the cut, tails rising between them.
        for k, tb in enumerate(b[1:] + [b[-1] + 0.5, b[-1] + 1.0]):
            S.append(dict(tb=tb, pos=(-40 + (k * 53) % 90, 62 + (k % 3) * 14, 800 + (k % 2) * 25), col=[5, 0, 3, 2, 4, 1][k % 6], kind=kinds[k % 3], n=220, speed=42, life=2.2))
        return S, dict(pos=(0, 70, 810), size=(420, 160, 150), density=0.0)
    if mode == 'drop':
        # Quarter speed: bursts already blooming behind the car as the shot opens, one more on each beat.
        c = (608, 0, 426)
        for k, tb in enumerate([-0.22, -0.1, -0.05] + b[1:]):
            S.append(dict(tb=tb, pos=(c[0] - 55 + k * 26 + rnd.uniform(-6, 6), 72 + (k % 3) * 20, c[2] - 18 + ((k * 37) % 5 - 2) * 16), col=[1, 4, 6, 0, 2, 3, 5][k % 7], kind=['peony', 'peony', 'ring'][k % 3], n=260, speed=44, life=2.4,
                          base=(c[0] - 40 + k * 20, 0, c[2] + 120), flash=0.1))
        return S, dict(pos=(608, 80, 426), size=(320, 240, 140), density=0.0)
    # finale: a volley on every beat, bigger each time, and a wall of willows to end on.
    for k, tb in enumerate(b[1:] + [b[-1] + 0.26]):
        vol = 3 + k
        for j in range(vol):
            S.append(dict(tb=tb + rnd.uniform(-0.03, 0.05) + (j % 2) * 0.12, pos=(-150 + (j + 0.5) * 300 / vol + rnd.uniform(-14, 14), 64 + ((j * 7 + k * 3) % 5) * 15, 790 + rnd.uniform(-30, 40)),
                          col=(k * 2 + j) % 8, kind=kinds[(k + j) % 4], n=230, speed=40 + ((j + k) % 3) * 6, life=2.3))
    # Shells already in the air as the shot opens.
    for j in range(4):
        S.append(dict(tb=-0.25 - j * 0.12, pos=(-120 + j * 80, 70 + (j % 2) * 30, 800), col=(j * 3 + 1) % 8, kind=kinds[j % 4], n=230, speed=44, life=2.4))
    return S, dict(pos=(0, 80, 810), size=(560, 190, 190), density=0.0012)


# ---------------------------------------------------------------------------------------------------------------------
# Tornado.

def tornado(anim, L, cam_pts, height=260.0):
    frames = anim['frames']
    rec = anim.get('rec') or []
    tw = [r.get('tw') for r in rec if r and r.get('tw')]
    if not tw:
        return False
    locs = np.array([pt(p) for p in tw], np.float32)
    if len(locs) < frames:
        locs = np.concatenate([locs, np.repeat(locs[-1:], frames - len(locs), axis=0)])
    root = link(bpy.data.objects.new('tornado', None))
    key_series(root, 'location', locs)
    gz = float(locs[0][2])
    # The funnel: a volume in a cylinder; density from the distance to a wobbling axis against a radius profile.
    import bmesh
    me = bpy.data.meshes.new('funnel'); bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=170.0, radius2=170.0, depth=height)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, height * 0.5)); bm.to_mesh(me); bm.free()
    fo = link(bpy.data.objects.new('funnel', me)); fo.parent = root
    m = bpy.data.materials.new('funnel'); m.use_nodes = True
    nt = m.node_tree; nb = NB(nt)
    out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    for n in list(nt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            nt.nodes.remove(n)
    tc = nb.n('ShaderNodeTexCoord')
    sp = nb.n('ShaderNodeSeparateXYZ'); nb.link(tc.outputs['Object'], sp.inputs[0])
    z = sp.outputs['Z']
    zt = nb.math('DIVIDE', z, height)
    tdrv = nb.n('ShaderNodeValue'); tdrv.outputs[0].driver_add('default_value').driver.expression = 'frame / 24.0'
    tt = tdrv.outputs[0]
    # The axis leans and snakes with height.
    ax = nb.math('MULTIPLY', nb.math('SINE', nb.math('ADD', nb.math('MULTIPLY', z, 0.021), nb.math('MULTIPLY', tt, 0.9))), nb.math('ADD', 3.0, nb.math('MULTIPLY', zt, 16.0)))
    ay = nb.math('MULTIPLY', nb.math('SINE', nb.math('ADD', nb.math('MULTIPLY', z, 0.017), nb.math('ADD', nb.math('MULTIPLY', tt, 0.7), 1.7))), nb.math('ADD', 3.0, nb.math('MULTIPLY', zt, 12.0)))
    dx = nb.math('SUBTRACT', sp.outputs['X'], ax); dy = nb.math('SUBTRACT', sp.outputs['Y'], ay)
    rr = nb.math('SQRT', nb.math('ADD', nb.math('MULTIPLY', dx, dx), nb.math('MULTIPLY', dy, dy)))
    # Radius: a rope near the ground, widening, flaring into the wall cloud at the top.
    R = nb.math('ADD', nb.math('ADD', 8.0, nb.math('MULTIPLY', zt, 30.0)), nb.math('MULTIPLY', nb.math('POWER', zt, 4.0), 75.0))
    # Swirl: the noise is sampled in coordinates rotated about the axis, faster near the core.
    ang = nb.math('ADD', nb.math('MULTIPLY', tt, -2.6), nb.math('MULTIPLY', z, 0.035))
    rot = nb.n('ShaderNodeVectorRotate', rotation_type='Z_AXIS'); nb.link(tc.outputs['Object'], rot.inputs['Vector']); nb.link(ang, rot.inputs['Angle'])
    mp = nb.n('ShaderNodeMapping'); nb.link(rot.outputs[0], mp.inputs['Vector']); mp.inputs['Scale'].default_value = (1.0, 1.0, 0.35)
    rise = nb.n('ShaderNodeCombineXYZ'); nb.link(nb.math('MULTIPLY', tt, -5.0), rise.inputs['Z']); nb.link(rise.outputs[0], mp.inputs['Location'])
    nz = nb.noise(mp.outputs[0], scale=0.022, detail=3.0, rough=0.5)
    edge = nb.math('MULTIPLY', R, nb.maprange(nz, 0.25, 0.75, 0.75, 1.3))
    core = nb.maprange(nb.math('DIVIDE', rr, edge), 0.45, 1.0, 1.0, 0.0, smooth=True)
    # Dust skirt at the foot: wide, low, ragged.
    skirt = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.maprange(z, 0.0, 26.0, 1.0, 0.0, smooth=True), nb.maprange(rr, 12.0, 62.0, 1.0, 0.0, smooth=True)), nb.maprange(nz, 0.35, 0.7, 0.0, 0.5, smooth=True))
    dens = nb.math('ADD', nb.math('MULTIPLY', core, 0.035), nb.math('MULTIPLY', skirt, 0.03))
    # Mostly absorption (a dark column against the pale sky), with a little scattering so the flashes light it.
    va = nb.n('ShaderNodeVolumeAbsorption'); va.inputs['Color'].default_value = (0.02, 0.022, 0.024, 1)
    nb.link(nb.math('MULTIPLY', dens, 1.6), va.inputs['Density'])
    vs_ = nb.n('ShaderNodeVolumeScatter'); vs_.inputs['Color'].default_value = (0.5, 0.5, 0.5, 1)
    nb.link(nb.math('MULTIPLY', dens, 0.25), vs_.inputs['Density'])
    addv = nb.n('ShaderNodeAddShader'); nb.link(va.outputs[0], addv.inputs[0]); nb.link(vs_.outputs[0], addv.inputs[1])
    nb.link(addv.outputs[0], out.inputs['Volume'])
    me.materials.append(m)
    # The ceiling: a low mottled cloud deck the funnel hangs from (a plane that glows faintly, as an overcast does).
    pm = bpy.data.meshes.new('ceiling'); bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=7000.0); bm.to_mesh(pm); bm.free()
    co = link(bpy.data.objects.new('ceiling', pm)); co.location = (float(locs[0][0]), float(locs[0][1]), gz + height - 6.0)
    cm = bpy.data.materials.new('ceiling'); cm.use_nodes = True
    ct = cm.node_tree; cnb = NB(ct)
    for n in list(ct.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            ct.nodes.remove(n)
    cout = [n for n in ct.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    wp = world_pos(cnb)
    cd = cnb.n('ShaderNodeValue'); cd.outputs[0].driver_add('default_value').driver.expression = 'frame / 24.0 * 0.04'
    big = cnb.noise(wp, scale=0.0022, detail=7.0, rough=0.62, w=cd.outputs[0])
    # Darker toward the funnel (the wall cloud), paler away from it.
    dv = cnb.n('ShaderNodeVectorMath', operation='DISTANCE'); cnb.link(wp, dv.inputs[0]); dv.inputs[1].default_value = co.location
    wall = cnb.maprange(dv.outputs['Value'], 120.0, 1500.0, 0.25, 1.0, smooth=True)
    lum = cnb.math('MULTIPLY', cnb.maprange(big, 0.3, 0.72, 0.25, 1.0, smooth=True), wall)
    cc = cnb.mixc(lum, (0.035, 0.04, 0.042, 1), (0.36, 0.40, 0.39, 1))
    ce = cnb.n('ShaderNodeEmission'); cnb.link(cc, ce.inputs['Color']); ce.inputs['Strength'].default_value = L.get('ceiling', 1.6)
    cnb.link(ce.outputs[0], cout.inputs['Surface'])
    pm.materials.append(cm)
    # Debris: boards, shingles and brush orbiting the foot (geometry nodes from Scene Time; hashes on the points).
    N = 1100
    rnd = np.random.default_rng(3)
    dm = bpy.data.meshes.new('debris-pts'); dm.vertices.add(N)
    hh = rnd.random((N, 4)).astype(np.float32)
    a = dm.attributes.new('h', 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', hh.ravel())
    do = link(bpy.data.objects.new('debris', dm)); do.parent = root
    bme = bpy.data.meshes.new('debris-board'); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(bme); bm.free()
    bmat = bpy.data.materials.new('debris'); bmat.use_nodes = True
    bnb = NB(bmat.node_tree); P = look.principled(bmat.node_tree)
    oi = bnb.n('ShaderNodeObjectInfo')
    ramp = bnb.mixc(oi.outputs['Random'], (0.02, 0.014, 0.01, 1), (0.30, 0.25, 0.18, 1))
    bnb.link(ramp, P.inputs['Base Color']); P.inputs['Roughness'].default_value = 0.9
    bme.materials.append(bmat)
    bo = link(bpy.data.objects.new('debris-board', bme)); bo.hide_render = True; bo.hide_viewport = True
    gn = bpy.data.node_groups.new('debris-gn', 'GeometryNodeTree')
    gn.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    gn.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    g = NB(gn, x=-1600)
    gi = g.n('NodeGroupInput'); go = g.n('NodeGroupOutput')
    ha = g.n('GeometryNodeInputNamedAttribute', data_type='FLOAT_COLOR'); ha.inputs['Name'].default_value = 'h'
    hs = g.n('FunctionNodeSeparateColor'); g.link(ha.outputs['Attribute'], hs.inputs[0])
    h0, h1, h2 = hs.outputs[0], hs.outputs[1], hs.outputs[2]
    tmn = g.n('GeometryNodeInputSceneTime'); t = tmn.outputs['Seconds']
    cyc = g.math('ADD', 4.0, g.math('MULTIPLY', h1, 7.0))
    u = g.math('FRACT', g.math('ADD', g.math('DIVIDE', t, cyc), h0))
    hmax = g.math('MULTIPLY', 38.0, g.math('ADD', 0.2, g.math('MULTIPLY', g.math('MULTIPLY', h2, h2), 1.4)))
    y = g.math('MULTIPLY', g.math('POWER', u, 0.8), hmax)
    r = g.math('ADD', g.math('ADD', 6.0, g.math('MULTIPLY', h1, 20.0)), g.math('MULTIPLY', y, 0.3))
    an = g.math('ADD', g.math('MULTIPLY', h2, 6.283), g.math('ADD', g.math('MULTIPLY', g.math('MULTIPLY', t, -1.0), g.math('ADD', 1.2, g.math('DIVIDE', 26.0, g.math('ADD', r, 4.0)))), g.math('MULTIPLY', u, 2.0)))
    pos = g.n('ShaderNodeCombineXYZ'); g.link(g.math('MULTIPLY', g.math('COSINE', an), r), pos.inputs[0]); g.link(g.math('MULTIPLY', g.math('SINE', an), r), pos.inputs[1]); g.link(g.math('ADD', y, 0.8), pos.inputs[2])
    sp_ = g.n('GeometryNodeSetPosition'); g.link(gi.outputs[0], sp_.inputs['Geometry']); g.link(pos.outputs[0], sp_.inputs['Position'])
    m2p = g.n('GeometryNodeMeshToPoints'); g.link(sp_.outputs[0], m2p.inputs['Mesh'])
    oin = g.n('GeometryNodeObjectInfo'); oin.inputs['Object'].default_value = bo
    rotv = g.n('ShaderNodeCombineXYZ'); g.link(g.math('MULTIPLY', t, g.math('ADD', 1.0, g.math('MULTIPLY', h0, 5.0))), rotv.inputs[0]); g.link(g.math('MULTIPLY', t, g.math('ADD', 2.0, g.math('MULTIPLY', h1, 4.0))), rotv.inputs[1]); g.link(g.math('MULTIPLY', h2, 6.0), rotv.inputs[2])
    sz = g.math('MULTIPLY', g.math('ADD', 0.25, g.math('MULTIPLY', g.math('MULTIPLY', h0, h0), 1.1)), g.math('SUBTRACT', 1.0, g.math('POWER', u, 6.0)))
    scl = g.n('ShaderNodeCombineXYZ'); g.link(g.math('MULTIPLY', sz, g.math('ADD', 0.3, h2)), scl.inputs[0]); g.link(g.math('MULTIPLY', sz, g.math('ADD', 0.06, g.math('MULTIPLY', h1, 0.2))), scl.inputs[1]); g.link(g.math('MULTIPLY', sz, g.math('ADD', 0.8, g.math('MULTIPLY', h2, 2.0))), scl.inputs[2])
    iop = g.n('GeometryNodeInstanceOnPoints'); g.link(m2p.outputs[0], iop.inputs['Points']); g.link(oin.outputs['Geometry'], iop.inputs['Instance'])
    g.link(rotv.outputs[0], iop.inputs['Rotation']); g.link(scl.outputs[0], iop.inputs['Scale'])
    g.link(iop.outputs[0], go.inputs[0])
    mod = do.modifiers.new('debris', 'NODES'); mod.node_group = gn
    # Lightning on the beats: a flash that lights the whole scene, and a jagged bolt for three frames.
    beats = [b for b in (anim.get('beats') or []) if b > 0.2][1::2][:4] or [1.0, 2.6]
    fl = bpy.data.lights.new('lightning', 'SUN'); fl.energy = 0.0; fl.color = (0.82, 0.88, 1.0); fl.angle = math.radians(20)
    flo = link(bpy.data.objects.new('lightning', fl)); flo.rotation_euler = (math.radians(50), 0, math.radians(200))
    fl.keyframe_insert('energy', frame=1)
    cmat = cm.node_tree.nodes
    rb = random.Random(9)
    for k, bt in enumerate(beats):
        f = int(round(bt * 24)) + 1
        for df, e_ in ((-1, 0.0), (0, 9.0), (1, 3.0), (2, 7.0), (3, 1.5), (5, 0.0)):
            fl.energy = e_; fl.keyframe_insert('energy', frame=f + df)
            ce.inputs['Strength'].default_value = L.get('ceiling', 1.6) * (1.0 + e_ * 0.9); ce.inputs['Strength'].keyframe_insert('default_value', frame=f + df)
        # The bolt: from the ceiling to the ground, off to one side of the funnel.
        bx = float(locs[min(f, frames - 1)][0]) + rb.choice((-1, 1)) * rb.uniform(90, 190); by = float(locs[min(f, frames - 1)][1]) + rb.uniform(-60, 120)
        cu = bpy.data.curves.new(f'bolt{k}', 'CURVE'); cu.dimensions = '3D'; cu.bevel_depth = 1.1; cu.bevel_resolution = 1
        spn = cu.splines.new('POLY'); NP = 18; spn.points.add(NP - 1)
        x, y_ = bx + rb.uniform(-40, 40), by
        for i in range(NP):
            q = i / (NP - 1)
            spn.points[i].co = (x, y_, gz + height - 8 - q * (height - 8), 1.0)
            x += rb.uniform(-13, 13) + (bx - x) * 0.2; y_ += rb.uniform(-9, 9)
        cu.materials.append(emit_mat('fx-bolt', (0.85, 0.9, 1.0), 900.0))
        bob = link(bpy.data.objects.new(f'bolt{k}', cu))
        key_vis(bob, [f - 1 <= fr < f + 2 for fr in range(1, frames + 1)])
    return True


# ---------------------------------------------------------------------------------------------------------------------

def apply(shot, anim, L, cam_pts, log):
    frames = anim['frames']
    rec = anim.get('rec') or []
    fxs = shot.get('fx') or {}
    ts = float(anim.get('timeScale') or 1.0)
    n = vehicle_lights(anim, L, cam_pts, force=bool(fxs.get('headlights')), clear=float(shot.get('clear', 0)))
    if n:
        log('vehicle lights', rigs=n)
    if fxs.get('searchlight') and searchlight(anim, L):
        log('searchlight')
    if fxs.get('fireworks'):
        shells, smoke = show(anim.get('beats') or [0, 0.5, 1.0, 1.5, 2.0], fxs['fireworks'], ts)
        nv = fireworks(anim, shells, smoke, strength=float(fxs.get('fwStrength', 30.0)))
        log('fireworks', shells=len(shells), verts=nv)
    if fxs.get('tornado') and tornado(anim, L, cam_pts):
        log('tornado')
    for k, p in enumerate(fxs.get('puffs') or []):
        parent = None
        loc = pt(p['pos']) if 'pos' in p else Vector((0, 0, 0))
        if p.get('follow') and rec and rec[0].get(p['follow']):
            fr = {f: tuple(r[p['follow']][:4]) for f, r in enumerate(rec) if r.get(p['follow'])}
            parent = rig('puff-rig%d' % k, fr, frames)
            o = p.get('offset', (0, 0, 0)); loc = Vector((o[0], o[2], o[1]))        # right, up, forward -> local x, z, y
        elif p.get('ref') and rec and rec[0].get(p['ref']):
            r0 = rec[0][p['ref']]
            loc = pt((r0[0] + p['pos'][0], r0[1] + p['pos'][1], r0[2] + p['pos'][2]))
        s = p.get('size', (10, 10, 4))
        puff('puff%d' % k, loc, (s[0], s[2], s[1]), tuple(p.get('color', (1, 1, 1))), p.get('density', 0.1), p.get('noise', 0.4), p.get('speed', 0.4), parent=parent,
             lo=p.get('lo', 0.35), hi=p.get('hi', 0.75), aniso=p.get('aniso', 0.4))
        log('puff', name=p.get('name', k))
    # A synthetic car (the moose shot's headlights round the bend): a straight track given in the shot.
    car = fxs.get('car')
    if car and rec and rec[0].get(car.get('ref', 'site')):
        r0 = rec[0][car.get('ref', 'site')]
        a, b = car['from'], car['to']
        fr = {}
        for f in range(frames):
            u = f / max(1, frames - 1)
            x = r0[0] + a[0] + (b[0] - a[0]) * u; z = r0[2] + a[2] + (b[2] - a[2]) * u
            fr[f] = (x, r0[1] + a[1], z, math.atan2(b[0] - a[0], b[2] - a[2]))
        rg = rig('fxcar', fr, frames)
        car_lights('fxcar', rg, dict(L=4.5, W=1.8, H=1.45), power=car.get('power', 1.0), frames=frames)
        log('fx car')
