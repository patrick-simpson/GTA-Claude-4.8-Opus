# Print facts about a built shot (evaluated geometry of named objects, lights, world), then quit. Window visible.
#   blender.exe X.blend --python tools/trailer/blender/inspect_blend.py -- --names stink-lines,haze --out C:/Users/User/trailer/inspect.json
import bpy, sys, os, json

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
A = dict(zip([a.lstrip('-') for a in argv[0::2]], argv[1::2]))
names = A.get('names', '').split(',')
out = {}
dg = bpy.context.evaluated_depsgraph_get()
sc = bpy.context.scene
sc.frame_set(int(A.get('frame', 48)))
for n in names:
    ob = bpy.data.objects.get(n)
    if not ob:
        out[n] = 'missing'; continue
    ev = ob.evaluated_get(dg)
    info = {'type': ob.type, 'loc': list(ob.location), 'hide_render': ob.hide_render}
    try:
        me = ev.to_mesh()
        info['verts'] = len(me.vertices)
        if len(me.vertices):
            xs = [v.co for v in me.vertices]
            info['min'] = [min(c[i] for c in xs) for i in range(3)]
            info['max'] = [max(c[i] for c in xs) for i in range(3)]
        ev.to_mesh_clear()
    except Exception as e:
        info['err'] = str(e)
    for m in ob.modifiers:
        info.setdefault('mods', []).append([m.type, getattr(m, 'node_group', None) and m.node_group.name])
    out[n] = info
out['cam'] = list(sc.camera.matrix_world.translation)
out['lights'] = [(o.name, o.data.type, o.data.energy) for o in bpy.data.objects if o.type == 'LIGHT'][:5]
json.dump(out, open(A.get('out', 'C:/Users/User/trailer/inspect.json'), 'w'), indent=1, default=str)
os._exit(0)
