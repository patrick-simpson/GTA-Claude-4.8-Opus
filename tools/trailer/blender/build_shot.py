# Build one trailer shot in Blender from tools/trailer/export.mjs output, with the window VISIBLE (never -b):
#
#   blender.exe --python tools/trailer/blender/build_shot.py -- --shot C:/Users/User/trailer/export/P1_tower
#       [--look golden] [--engine CYCLES|EEVEE] [--blend C:/Users/User/trailer/blend/P1_tower.blend] [--quit]
#
# Moving instanced meshes (cars, wheels, boats: inst.dyn) become one keyed single-point instancer per instance; people
# (people.bin, skinned by the exporter) become meshes driven by a point cache (PC2); effects the export cannot carry
# come from fx.py (the shot's "fx" in shots.json).
# Steps: import scene.glb (glTF importer; y-up -> z-up), rebuild instanced meshes as geometry-node instances from
# inst.bin (per-instance colours and attributes on the points, read in shaders with an Instancer attribute), key the
# actors' per-frame matrices and visibility, key the camera (position, aim, vertical field of view) from anim.json,
# then the look (look.py): materials, sky, sun, haze, mist, lamps, grass, hero rebuilds, lens, grade, render settings.
# Saves the .blend, writes <blend>.log.json, and quits with --quit (os._exit, so no save prompt can hold the window).

import bpy, sys, os, json, math, time, traceback
import numpy as np
from mathutils import Matrix, Vector, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib, look, fx
importlib.reload(look)

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
A = {}
i = 0
while i < len(argv):
    k = argv[i].lstrip('-')
    if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
        A[k] = argv[i + 1]; i += 2
    else:
        A[k] = True; i += 1
SHOT = A['shot'].replace('\\', '/')
SID = os.path.basename(SHOT.rstrip('/'))
BLEND = A.get('blend', f'C:/Users/User/trailer/blend/{SID}.blend')
os.makedirs(os.path.dirname(BLEND), exist_ok=True)
LOG = {'shot': SID, 'steps': []}


def step(msg, **kw):
    LOG['steps'].append({'t': round(time.time() - T0, 2), 'msg': msg, **kw})
    print('[build]', msg, kw if kw else '')


T0 = time.time()
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
Ci = C.inverted()
Cn = np.array(C, dtype=np.float64)
Cin = np.array(Ci, dtype=np.float64)


def m3(e):
    """three.js column-major 16 -> Blender Matrix (game frame)."""
    return Matrix(((e[0], e[4], e[8], e[12]), (e[1], e[5], e[9], e[13]), (e[2], e[6], e[10], e[14]), (e[3], e[7], e[11], e[15])))


def pt(v):
    return Vector((v[0], -v[2], v[1]))


def fcurves_of(ob):
    act = ob.animation_data.action
    try:
        return list(act.fcurves)
    except Exception:
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    out += list(cb.fcurves)
        return out


def key_series(ob, path, values, frames):
    """values: (n, k) array -> keyframes on frames 1..n for each component, set in bulk."""
    if not ob.animation_data:
        ob.animation_data_create()
    if not ob.animation_data.action:
        ob.animation_data.action = bpy.data.actions.new(ob.name + '-act')
    act = ob.animation_data.action
    n, k = values.shape
    for c in range(k):
        # Insert one key to create the curve in whatever action layout this version uses, then fill.
        ob.keyframe_insert(path, index=c, frame=1) if k > 1 else ob.keyframe_insert(path, frame=1)
    fcs = [fc for fc in fcurves_of(ob) if fc.data_path == path]
    for fc in fcs:
        c = fc.array_index
        fc.keyframe_points.clear()
        fc.keyframe_points.add(n)
        co = np.empty(n * 2, np.float32)
        co[0::2] = np.arange(1, n + 1, dtype=np.float32)
        co[1::2] = values[:, c]
        fc.keyframe_points.foreach_set('co', co)
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
        fc.update()


try:
    anim = json.load(open(os.path.join(SHOT, 'anim.json')))
    shots_file = os.path.join(HERE, '..', 'shots.json')
    shot_def = next((s for s in json.load(open(shots_file))['shots'] if s['id'] == SID), {})
    look_name = A.get('look') or shot_def.get('look') or 'golden'
    L = dict(look.LOOKS[look_name])
    L.update(shot_def.get('lookOverrides', {}))
    LOG['look'] = look_name
    frames = anim['frames']

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, frames
    sc.render.fps = int(anim.get('fps', 24))
    bpy.ops.import_scene.gltf(filepath=os.path.join(SHOT, 'scene.glb'), merge_vertices=False, import_shading='NORMALS')
    step('imported', objects=len(bpy.data.objects))

    byi = {}
    for ob in list(bpy.data.objects):
        pc = ob.get('pc')
        if pc is None:
            continue
        pc = pc.to_dict() if hasattr(pc, 'to_dict') else dict(pc)
        ob['pcj'] = json.dumps(pc)
        byi[int(pc['i'])] = (ob, pc)

    # Classify and drop what Blender does better (fake shadows, the sky dome, particles, the game's stink ribbons).
    drop = 0
    classes = {}
    for i, (ob, pc) in list(byi.items()):
        mats = pc.get('mat') or [{}]
        cls = look.classify(pc.get('path', ''), mats[0], ob.name)
        if pc.get('kind') in ('points', 'line'):
            cls = 'drop'
        if any(k in (pc.get('path', '') + ob.name).lower() for k in ('tornado', 'halo', 'landmark-glow', 'people_')):
            cls = 'drop'
        if any(ob.name.startswith(d) for d in shot_def.get('drop', [])):
            cls = 'drop'      # per shot: meshes the game rewrites every frame (a boat's wake ribbon), frozen in the export
        ob['cls'] = cls
        classes[cls] = classes.get(cls, 0) + 1
        if cls == 'drop':
            bpy.data.objects.remove(ob, do_unlink=True)
            del byi[i]
            drop += 1
    step('classified', classes=classes, dropped=drop)

    # Camera positions per frame (Blender frame), for clearances.
    CAMP = np.array([[r[0], -r[2], r[1]] for r in anim['camera']], np.float64)
    CLEAR = float(shot_def.get('clear', 0))
    # Instances.
    ib = open(os.path.join(SHOT, 'inst.bin'), 'rb').read() if os.path.exists(os.path.join(SHOT, 'inst.bin')) else b''
    gn = bpy.data.node_groups.new('inst-gn', 'GeometryNodeTree')
    gn.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    s_obj = gn.interface.new_socket('Object', in_out='INPUT', socket_type='NodeSocketObject')
    gn.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nb = look.NB(gn, x=-800)
    gi = nb.n('NodeGroupInput'); go = nb.n('NodeGroupOutput')
    oi = nb.n('GeometryNodeObjectInfo', transform_space='ORIGINAL')
    rot = nb.n('GeometryNodeInputNamedAttribute', data_type='FLOAT_VECTOR'); rot.inputs['Name'].default_value = 'rot'
    scl = nb.n('GeometryNodeInputNamedAttribute', data_type='FLOAT_VECTOR'); scl.inputs['Name'].default_value = 'scl'
    iop = nb.n('GeometryNodeInstanceOnPoints')
    nb.link(gi.outputs['Geometry'], iop.inputs['Points']); nb.link(oi.outputs['Geometry'], iop.inputs['Instance'])
    nb.link(rot.outputs['Attribute'], iop.inputs['Rotation']); nb.link(scl.outputs['Attribute'], iop.inputs['Scale'])
    nb.link(iop.outputs[0], go.inputs[0])
    inst_objs = 0
    inst_total = 0
    inst_col_mats = set()
    for key, info in anim.get('inst', {}).items():
        i = int(key)
        if i not in byi:
            continue
        ob, pc = byi[i]
        n = info['count']
        if n <= 0 and not info.get('dyn'):
            ob.hide_render = True
            continue
        if info.get('dyn'):
            # Rewritten every frame by the game (cars and their wheels): one instancer per slot, keyed in world space.
            dn = info['dyn']; mx = dn['max']; counts = np.array(dn['counts'])
            DM = np.frombuffer(ib, np.float32, frames * mx * 16, dn['offset']).astype(np.float64).reshape(frames, mx, 4, 4).transpose(0, 1, 3, 2)
            PW = np.array(ob.matrix_world, np.float64)
            cols0 = np.frombuffer(ib, np.float32, n * 3, info['colors']).reshape(n, 3) if info.get('colors', -1) >= 0 and n > 0 else None
            if cols0 is not None:
                for ms in ob.material_slots:
                    if ms.material:
                        inst_col_mats.add(ms.material.name)
            g2 = gn.copy(); g2.name = 'inst-' + ob.name[:40]
            [nd for nd in g2.nodes if nd.bl_idname == 'GeometryNodeObjectInfo'][0].inputs['Object'].default_value = ob
            for k in range(mx):
                live = counts > k
                if not live.any():
                    continue
                W = PW @ (Cn @ DM[:, k] @ Cin)
                # A slot that is off this frame keeps its last good matrix.
                last = None
                for f in range(frames):
                    if live[f] and abs(np.linalg.det(W[f][:3, :3])) > 1e-9:
                        last = W[f]
                    elif last is not None:
                        W[f] = last
                first_ok = next((W[f] for f in range(frames) if live[f]), None)
                for f in range(frames):
                    if not live[f] and (f == 0 or not live[:f].any()):
                        W[f] = first_ok
                locs = W[:, :3, 3]; RS = W[:, :3, :3]
                # Traffic that drives through the lens (the camera rides ahead of the hero car, in the lane) is left out.
                if CLEAR > 0 and (np.linalg.norm(locs - CAMP[:len(locs)], axis=1)[live] < CLEAR).any():
                    LOG['cleared'] = LOG.get('cleared', 0) + 1
                    continue
                sc3 = np.linalg.norm(RS, axis=1); sc3[sc3 == 0] = 1e-6
                q = []; prev = None
                for r_ in (RS / sc3[:, None, :]):
                    qq = Matrix(r_.tolist()).to_quaternion()
                    if prev is not None and prev.dot(qq) < 0:
                        qq.negate()
                    q.append(tuple(qq)); prev = qq
                me = bpy.data.meshes.new(ob.name + '-pt'); me.vertices.add(1)
                a = me.attributes.new('rot', 'FLOAT_VECTOR', 'POINT'); a.data.foreach_set('vector', [0.0, 0.0, 0.0])
                a = me.attributes.new('scl', 'FLOAT_VECTOR', 'POINT'); a.data.foreach_set('vector', [1.0, 1.0, 1.0])
                if cols0 is not None:
                    c = cols0[min(k, n - 1)]
                    a = me.attributes.new('inst_col', 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', [float(c[0]), float(c[1]), float(c[2]), 1.0])
                for an, ai in (info.get('attrs') or {}).items():
                    sz = ai['size']
                    if k >= ai['count']:
                        continue
                    arr = np.frombuffer(ib, np.float32, sz, ai['offset'] + k * sz * 4)
                    nm = 'i_' + an
                    if sz == 1:
                        a = me.attributes.new(nm, 'FLOAT', 'POINT'); a.data.foreach_set('value', arr)
                    elif sz == 2:
                        a = me.attributes.new(nm, 'FLOAT2', 'POINT'); a.data.foreach_set('vector', arr)
                    elif sz == 3:
                        a = me.attributes.new(nm, 'FLOAT_VECTOR', 'POINT'); a.data.foreach_set('vector', arr)
                    else:
                        a = me.attributes.new(nm, 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', arr[:4])
                po = bpy.data.objects.new(f'{ob.name}-dyn{k}', me)
                for col in ob.users_collection:
                    col.objects.link(po)
                po['cls'] = ob.get('cls', 'surface')
                mod = po.modifiers.new('inst', 'NODES'); mod.node_group = g2
                po.rotation_mode = 'QUATERNION'
                key_series(po, 'location', locs, frames)
                key_series(po, 'rotation_quaternion', np.array(q), frames)
                key_series(po, 'scale', sc3, frames)
                # A slot handed to another car between two frames is a cut, not a move: hold, so motion blur cannot smear it.
                jump = np.linalg.norm(np.diff(locs, axis=0), axis=1) > 14.0
                if jump.any():
                    for fc in fcurves_of(po):
                        for f in np.nonzero(jump)[0]:
                            fc.keyframe_points[int(f)].interpolation = 'CONSTANT'
                if not live.all():
                    for f in range(frames):
                        if f == 0 or live[f] != live[f - 1]:
                            po.hide_render = not bool(live[f]); po.keyframe_insert('hide_render', frame=f + 1)
                inst_total += 1
            ob.hide_render = True
            ob.hide_set(True)
            inst_objs += 1
            dyn_inst = LOG.setdefault('dyn_inst', 0) + 1; LOG['dyn_inst'] = dyn_inst
            continue
        M = np.frombuffer(ib, np.float32, n * 16, info['offset']).astype(np.float64).reshape(n, 4, 4).transpose(0, 2, 1)
        B = Cn @ M @ Cin
        loc = B[:, :3, 3]
        RS = B[:, :3, :3]
        sc3 = np.linalg.norm(RS, axis=1)
        sc3[sc3 == 0] = 1e-6
        R = RS / sc3[:, None, :]
        eul = np.array([Matrix(r.tolist()).to_euler() for r in R])
        me = bpy.data.meshes.new(ob.name + '-pts')
        me.vertices.add(n)
        me.vertices.foreach_set('co', loc.astype(np.float32).ravel())
        a = me.attributes.new('rot', 'FLOAT_VECTOR', 'POINT'); a.data.foreach_set('vector', eul.astype(np.float32).ravel())
        a = me.attributes.new('scl', 'FLOAT_VECTOR', 'POINT'); a.data.foreach_set('vector', sc3.astype(np.float32).ravel())
        if info.get('colors', -1) >= 0:
            cols = np.frombuffer(ib, np.float32, n * 3, info['colors']).reshape(n, 3)
            c4 = np.concatenate([cols, np.ones((n, 1), np.float32)], axis=1)
            a = me.attributes.new('inst_col', 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', c4.ravel())
            for ms in ob.material_slots:
                if ms.material:
                    inst_col_mats.add(ms.material.name)
        for an, ai in (info.get('attrs') or {}).items():
            s = ai['size']; cnt = min(n, ai['count'])
            arr = np.zeros((n, s), np.float32)
            arr[:cnt] = np.frombuffer(ib, np.float32, cnt * s, ai['offset']).reshape(cnt, s)
            nm = 'i_' + an
            if s == 1:
                a = me.attributes.new(nm, 'FLOAT', 'POINT'); a.data.foreach_set('value', arr.ravel())
            elif s == 2:
                a = me.attributes.new(nm, 'FLOAT2', 'POINT'); a.data.foreach_set('vector', arr.ravel())
            elif s == 3:
                a = me.attributes.new(nm, 'FLOAT_VECTOR', 'POINT'); a.data.foreach_set('vector', arr.ravel())
            else:
                a = me.attributes.new(nm, 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', arr[:, :4].ravel())
        po = bpy.data.objects.new(ob.name + '-inst', me)
        for col in ob.users_collection:
            col.objects.link(po)
        po.parent = ob
        po.matrix_parent_inverse = Matrix.Identity(4)
        po['cls'] = ob.get('cls', 'surface')
        g2 = gn.copy(); g2.name = 'inst-' + ob.name[:40]
        [n for n in g2.nodes if n.bl_idname == 'GeometryNodeObjectInfo'][0].inputs['Object'].default_value = ob
        mod = po.modifiers.new('inst', 'NODES'); mod.node_group = g2
        ob.hide_render = True
        ob.hide_set(True)
        inst_objs += 1; inst_total += n
    step('instances', objects=inst_objs, instances=inst_total)

    # Actors: per-frame world matrices and visibility.
    nact = 0
    for key, a in anim.get('actors', {}).items():
        i = int(key)
        if i not in byi:
            continue
        ob = byi[i][0]
        if 'm' in a:
            Ms = np.array(a['m'], np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
            B = Cn @ Ms @ Cin
            locs = B[:, :3, 3]
            RS = B[:, :3, :3]
            if CLEAR > 0 and max(ob.dimensions) < 8.0 and (np.linalg.norm(locs - CAMP[:len(locs)], axis=1) < CLEAR).any():
                # Part of something that passes through the lens (a driver in a car that was left out): left out too.
                ob.hide_render = True; LOG['cleared'] = LOG.get('cleared', 0) + 1
                continue
            sc3 = np.linalg.norm(RS, axis=1); sc3[sc3 == 0] = 1e-6
            q = []
            prev = None
            for r in (RS / sc3[:, None, :]):
                qq = Matrix(r.tolist()).to_quaternion()
                if prev is not None and prev.dot(qq) < 0:
                    qq.negate()
                q.append(tuple(qq)); prev = qq
            ob.rotation_mode = 'QUATERNION'
            key_series(ob, 'location', locs, frames)
            key_series(ob, 'rotation_quaternion', np.array(q), frames)
            key_series(ob, 'scale', sc3, frames)
            # A teleport between two frames is a cut, not a move: hold, so motion blur cannot smear it.
            jump = np.linalg.norm(np.diff(locs, axis=0), axis=1) > 14.0
            if jump.any():
                for fc in fcurves_of(ob):
                    for f in np.nonzero(jump)[0]:
                        fc.keyframe_points[int(f)].interpolation = 'CONSTANT'
        if 'vis' in a:
            v = np.array(a['vis'], np.float32)
            for f in range(len(v)):
                if f == 0 or v[f] != v[f - 1]:
                    ob.hide_render = not bool(v[f]); ob.keyframe_insert('hide_render', frame=f + 1)
        nact += 1
    step('actors', count=nact)

    # People: the exporter skinned them on the CPU; each mesh follows its rows of people.bin through a PC2 point cache.
    ppl_bin = os.path.join(SHOT, 'people.bin')
    nppl = 0
    if os.path.exists(ppl_bin) and anim.get('people'):
        import struct
        tot = sum(p['nv'] for p in anim['people'])
        nfr = os.path.getsize(ppl_bin) // (tot * 12)
        data = np.memmap(ppl_bin, np.float32, 'r', shape=(nfr, tot, 3))
        cdir = os.path.join(os.path.dirname(BLEND), SID + '_cache'); os.makedirs(cdir, exist_ok=True)
        # The game hands its crowd-texture rows around from frame to frame, so "row r" is not one person for the whole
        # shot. Follow each person instead: among the rows that share a model (same vertex count), the one whose body
        # is nearest to where this person was a frame ago. Nobody within 4 m: the person has left (hold the pose, hide).
        groups = {}
        for k, p_ in enumerate(anim['people']):
            groups.setdefault(p_['nv'], []).append(k)
        follow = {}          # person k -> (list of member index per frame, first frame gone or None)
        for nv_, members in groups.items():
            # (Median, not mean: parts a person does not wear are scaled to nothing and sit at the world's origin.)
            cents = np.stack([np.median(np.array(data[:, anim['people'][m]['off']:anim['people'][m]['off'] + nv_:7, :]), axis=1) for m in members], axis=1)   # (frames, members, 3)
            cur = {m: (cents[0, j], j) for j, m in enumerate(members)}
            tracks = {m: [j] for j, m in enumerate(members)}
            gone_at = {m: None for m in members}
            for f in range(1, nfr):
                taken = set()
                order = sorted(members, key=lambda m: 0 if gone_at[m] is None else 1)
                for m in order:
                    if gone_at[m] is not None:
                        tracks[m].append(tracks[m][-1]); continue
                    dist = np.linalg.norm(cents[f] - cur[m][0], axis=1)
                    for j in np.argsort(dist):
                        if int(j) not in taken:
                            break
                    if dist[j] > 4.0:
                        gone_at[m] = f; tracks[m].append(tracks[m][-1]); continue
                    taken.add(int(j)); tracks[m].append(int(j)); cur[m] = (cents[f, j], int(j))
            for m in members:
                follow[m] = ([members[j] for j in tracks[m]], gone_at[m])
        for ob in list(bpy.data.objects):
            pc = json.loads(ob.get('pcj', '{}'))
            pp = pc.get('ppl')
            if not pp or ob.type != 'MESH':
                continue
            nv = pp['nv']
            if len(ob.data.vertices) != nv:
                LOG.setdefault('mat_errors', []).append(f'{ob.name}: people verts {len(ob.data.vertices)} != {nv}')
                continue
            kme = next(k for k, p_ in enumerate(anim['people']) if p_['off'] == pp['off'])
            path_, gone = follow[kme]
            d = np.empty((nfr, nv, 3), np.float32)
            for f in range(nfr):
                o_ = anim['people'][path_[f]]['off']
                d[f] = data[f, o_:o_ + nv, :]
            if gone is not None:
                d[gone:] = d[gone - 1]
            # A row that was handed to a different model in mid-shot skins into a giant: such a person is left out.
            worn = np.abs(d).sum(axis=2).min(axis=0) > 1e-5      # vertices that are never collapsed to the origin
            dv = d[:, worn] if worn.any() else d
            ext = np.linalg.norm(dv.max(axis=1) - dv.min(axis=1), axis=1)
            if ext.max() > 4.5:
                ob.hide_render = True; LOG['people_bad'] = LOG.get('people_bad', 0) + 1
                continue
            if CLEAR > 0:
                cw = dv.mean(axis=1); cw = np.stack([cw[:, 0], -cw[:, 2], cw[:, 1]], axis=1)
                if (np.linalg.norm(cw - CAMP[:len(cw)], axis=1) < CLEAR + 1.0).any():
                    ob.hide_render = True; LOG['cleared'] = LOG.get('cleared', 0) + 1      # the driver of a car left out
                    continue
            # Into the mesh's own space (the importer put the y-up -> z-up turn in the vertices or in the object).
            inv = np.array(ob.matrix_world.inverted(), np.float32)
            w = np.stack([d[..., 0], -d[..., 2], d[..., 1]], axis=-1)
            loc = w @ inv[:3, :3].T + inv[:3, 3]
            fn = os.path.join(cdir, ob.name.split('|')[0] + '.pc2')
            with open(fn, 'wb') as fh:
                fh.write(struct.pack('<12siiffi', b'POINTCACHE2\0', 1, nv, 1.0, 1.0, nfr))
                fh.write(loc.astype('<f4').tobytes())
            md = ob.modifiers.new('cache', 'MESH_CACHE'); md.cache_format = 'PC2'; md.filepath = fn
            md.frame_start = 1.0; md.forward_axis = 'POS_Y'; md.up_axis = 'POS_Z'; md.interpolation = 'LINEAR'
            me = ob.data
            if 'custom_normal' in me.attributes:
                me.attributes.remove(me.attributes['custom_normal'])
            me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
            ob['cls'] = 'skin'
            if gone is not None:
                ob.hide_render = False; ob.keyframe_insert('hide_render', frame=1)
                ob.hide_render = True; ob.keyframe_insert('hide_render', frame=gone + 1)
                LOG['people_cut'] = LOG.get('people_cut', 0) + 1
            nppl += 1
        step('people', meshes=nppl, frames=int(nfr))

    # Camera.
    cam_d = bpy.data.cameras.new('trailer-cam')
    cam = bpy.data.objects.new('trailer-cam', cam_d)
    sc.collection.objects.link(cam); sc.camera = cam
    cam_d.sensor_fit = 'VERTICAL'; cam_d.sensor_height = 24.0; cam_d.sensor_width = 36.0
    cam_d.clip_start = 0.1; cam_d.clip_end = 6000.0
    rows = anim['camera']
    locs, eul, lens, focus = [], [], [], []
    prev = None
    for r in rows:
        p = pt(r[0:3]); tg = pt(r[3:6])
        d = tg - p
        # Pitch and yaw written out (no roll), yaw unwrapped below: an Euler taken from a quaternion can change its
        # representation between two frames, and motion blur then swings the camera through the gap (one smeared frame).
        e = (math.atan2(math.hypot(d.x, d.y), -d.z), 0.0, math.atan2(-d.x, d.y))
        locs.append(tuple(p)); eul.append(e)
        lens.append(12.0 / math.tan(math.radians(r[6]) / 2.0))
        focus.append(d.length)
    cam.rotation_mode = 'XYZ'
    eul = np.array(eul, np.float64); eul[:, 2] = np.unwrap(eul[:, 2])
    key_series(cam, 'location', np.array(locs), frames)
    key_series(cam, 'rotation_euler', eul, frames)
    cam_d.animation_data_create(); cam_d.animation_data.action = bpy.data.actions.new('cam-lens')
    for f, (l, fd) in enumerate(zip(lens, focus)):
        cam_d.lens = l; cam_d.keyframe_insert('lens', frame=f + 1)
        cam_d.dof.focus_distance = float(fd); cam_d.keyframe_insert('dof.focus_distance', frame=f + 1)
    step('camera', frames=len(rows), lens=[round(lens[0], 1), round(lens[-1], 1)], focus=[round(focus[0], 1), round(focus[-1], 1)])

    # Materials.
    done = set()
    cls_by_mat = {}
    path_by_mat = {}
    pbr_mats = set()
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        if '_APBR' in ob.data.attributes:
            for ms in ob.material_slots:
                if ms.material:
                    pbr_mats.add(ms.material.name)
        for ms in ob.material_slots:
            if ms.material and ms.material.name not in cls_by_mat:
                cls_by_mat[ms.material.name] = ob.get('cls', 'surface')
                path_by_mat[ms.material.name] = json.loads(ob.get('pcj', '{}')).get('path', '')
    tower_m = water_m = river_m = falls_m = None
    for ob in list(bpy.data.objects):
        cls = ob.get('cls')
        if ob.type != 'MESH' or cls is None:
            continue
        if cls == 'tower':
            tower_m = tower_m or look.tower_material('speedscan-tower', L)
            for ms in ob.material_slots:
                ms.material = tower_m
        elif cls == 'water':
            path = json.loads(ob.get('pcj', '{}')).get('path', '')
            if path.split('/')[-1] == 'sea':
                water_m = water_m or look.water_material('sea', L)
                for ms in ob.material_slots: ms.material = water_m
            else:
                river_m = river_m or look.water_material('river', L, river=True)
                for ms in ob.material_slots: ms.material = river_m
        elif cls == 'falls':
            falls_m = falls_m or look.falls_material('falls')
            for ms in ob.material_slots: ms.material = falls_m
    n_enh = 0
    for m in list(bpy.data.materials):
        if m.name in done or not m.use_nodes or m.name in ('speedscan-tower', 'sea', 'river', 'falls'):
            continue
        cls = cls_by_mat.get(m.name)
        if cls is None or cls in ('tower', 'water', 'falls', 'drop'):
            continue
        info = m.get('pc')
        info = info.to_dict() if hasattr(info, 'to_dict') else (dict(info) if info else {})
        if cls == 'hills':
            # The far hills are a game shader; its base colour is a uniform.
            hx = (info.get('uniforms') or {}).get('uBase', '#2f4034').lstrip('#')
            lin = [((int(hx[k:k + 2], 16) / 255) ** 2.2) for k in (0, 2, 4)]
            P = look.principled(m.node_tree)
            if P:
                P.inputs['Base Color'].default_value = (*lin, 1); P.inputs['Roughness'].default_value = 0.95
            cls = 'surface'
        try:
            look.enhance(m, info, cls, L, {'inst_col': m.name in inst_col_mats, 'pbr': m.name in pbr_mats, 'no_alpha_win': False})
            n_enh += 1
        except Exception:
            LOG.setdefault('mat_errors', []).append(m.name + ': ' + traceback.format_exc().splitlines()[-1])
        done.add(m.name)
    step('materials', enhanced=n_enh, pbr=len(pbr_mats), instcol=len(inst_col_mats))

    # Sky, sun, haze.
    sky = anim.get('sky', {})
    sd = pt(sky.get('sunDir', [0.5, 0.5, 0.5]))
    sd.normalize()
    cam_pts = [tuple(pt(r[0:3])) for r in rows]
    mid = rows[len(rows) // 2]
    look.setup_world(L, sd, cam_fwd=tuple(pt(mid[3:6]) - pt(mid[0:3])))
    look.haze_box(L, cam_pts[len(cam_pts) // 2])
    if L.get('mist'):
        c = cam_pts[0]
        # The mist sits on the water: the lowest water surface near the camera, else 3 m under the camera.
        wz = [(ob.matrix_world @ Vector(ob.bound_box[0])).z for ob in bpy.data.objects if ob.get('cls') == 'water' and ob.type == 'MESH']
        L['mist'].setdefault('base', float(shot_def['waterY']) if 'waterY' in shot_def else (min(wz) - 0.5 if wz else c[2] - 3.0))
        step('mist', base=L['mist']['base'])
        look.ground_mist(L, (c[0], c[1]), size=1400.0)
    # Hero: the stink lines whenever the tower is in the shot.
    if any(ob.get('cls') == 'tower' for ob in bpy.data.objects):
        look.stink_lines(L)
        step('stink lines')
    # Street lamps: lights at the heads of instanced lamp posts.
    lamp_pts = []
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and ob.name.endswith('-inst') and ob.parent is not None:
            path = json.loads(ob.parent.get('pcj', '{}')).get('path', '').lower()
            if 'lamp' in path and 'traffic' not in path:
                # The head: the centroid of the topmost 0.4 m of the post's vertices, light just under it.
                vz = [v.co for v in ob.parent.data.vertices]
                top = max(v.z for v in vz)
                hv = [v for v in vz if v.z > top - 0.4]
                head = Vector((sum(v.x for v in hv) / len(hv), sum(v.y for v in hv) / len(hv), top - 0.55))
                rotv = ob.data.attributes['rot'].data; sclv = ob.data.attributes['scl'].data
                for k, v in enumerate(ob.data.vertices):
                    from mathutils import Euler
                    Mk = Matrix.LocRotScale(v.co, Euler(rotv[k].vector), Vector(sclv[k].vector))
                    lamp_pts.append(tuple(ob.matrix_world @ (Mk @ head)))
    for p in anim.get('lamps', []):
        q = pt(p); lamp_pts.append((q.x, q.y, q.z - 0.25))
    nl = look.add_lamp_lights(lamp_pts, L, cam_pts)
    step('lamps', posts=len(lamp_pts), lights=nl)
    if L.get('grass'):
        grounds = [ob for ob in bpy.data.objects if ob.type == 'MESH' and ob.get('cls') == 'surface' and 'ground' in json.loads(ob.get('pcj', '{}')).get('path', '') and not ob.name.endswith('-inst')]
        ng = look.scatter_grass(grounds, cam_pts, radius=float(shot_def.get('grassRadius', 60)), density=float(shot_def.get('grassDensity', 45)))
        step('grass', grounds=len(grounds), marked=ng)
    fx.apply(shot_def, anim, L, cam_pts, step)
    look.camera_look(cam, L, shake=float(shot_def.get('shake', 0.6)), focus=shot_def.get('focus'))
    look.color_and_comp(L)
    engine = str(A.get('engine', 'CYCLES')).upper()
    look.render_settings('CYCLES' if engine == 'CYCLES' else 'EEVEE', samples=int(A['samples']) if 'samples' in A else None, shutter=float(shot_def.get('shutter', 0.3)))
    if 'volstep' in shot_def and hasattr(sc.cycles, 'volume_step_rate'):
        sc.cycles.volume_step_rate = float(shot_def['volstep'])
    step('look', engine=engine)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=False)
    step('saved', blend=BLEND)
except Exception:
    LOG['error'] = traceback.format_exc()
    print(LOG['error'])
json.dump(LOG, open(BLEND + '.log.json', 'w'), indent=1)
if A.get('quit'):
    os._exit(0)
