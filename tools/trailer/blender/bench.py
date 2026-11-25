# Where does a shot's render time go? Opens a built blend (window visible), renders one frame several times with one
# thing changed each time, and writes the seconds to <out>/bench.json. Used to pick savings that do not show.
#
#   blender.exe <shot>.blend --python tools/trailer/blender/bench.py -- --out DIR [--frame 60] [--pct 100] [--samples 96]
#       [--variants base,nomist,nohaze,nolamps,novol,step8,nodof,noblur,nograss,bounce,oidnfast,optix,s64,s48]

import bpy, sys, os, json, time

argv = sys.argv[sys.argv.index('--') + 1:]
A = {}
i = 0
while i < len(argv):
    k = argv[i].lstrip('-')
    if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
        A[k] = argv[i + 1]; i += 2
    else:
        A[k] = True; i += 1
OUT = A['out']; os.makedirs(OUT, exist_ok=True)
sc = bpy.context.scene; r = sc.render; c = sc.cycles
sc.frame_set(int(A.get('frame', 30)))
r.resolution_percentage = int(A.get('pct', 100))
if 'samples' in A:
    c.samples = int(A['samples'])
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import look
print('[bench] OptiX devices:', look.enable_gpu(), flush=True)
res = {}


def objs(pred):
    return [o for o in bpy.data.objects if pred(o)]


def hide(obs, v):
    for o in obs:
        o.hide_render = v


def run(name):
    r.filepath = os.path.join(OUT, name + '.png')
    t = time.time()
    bpy.ops.render.render(write_still=True)
    res[name] = round(time.time() - t, 1)
    print('[bench]', name, res[name], flush=True)
    json.dump(res, open(os.path.join(OUT, 'bench.json'), 'w'), indent=1)


V = (A.get('variants') or 'base,base2').split(',')
for v in V:
    if v in ('base', 'base2'):
        run(v)
    elif v in ('nomist', 'nohaze', 'nolamps', 'nograss', 'nostink', 'novol', 'nofx'):
        pred = {'nomist': lambda o: o.name.startswith('mist'), 'nohaze': lambda o: o.name.startswith('haze'),
                'nolamps': lambda o: o.type == 'LIGHT' and o.name.startswith('lamp'), 'nostink': lambda o: o.name.startswith('stink'),
                'novol': lambda o: o.name.startswith(('mist', 'haze', 'stink', 'puff', 'fw-smoke', 'funnel')),
                'nofx': lambda o: o.name.startswith(('veh', 'fw', 'searchlight', 'puff')),
                'nograss': lambda o: any(m.name == 'grass' for m in o.modifiers)}[v]
        if v == 'nograss':
            ms = [m for o in bpy.data.objects for m in o.modifiers if m.name == 'grass']
            for m in ms: m.show_render = False
            run(v)
            for m in ms: m.show_render = True
        else:
            obs = [o for o in objs(pred) if not o.hide_render]
            hide(obs, True); run(v + f'_{len(obs)}'); hide(obs, False)
    elif v.startswith('step'):
        old = c.volume_step_rate; c.volume_step_rate = float(v[4:]); run(v); c.volume_step_rate = old
    elif v == 'nodof':
        sc.camera.data.dof.use_dof = False; run(v); sc.camera.data.dof.use_dof = True
    elif v == 'noblur':
        r.use_motion_blur = False; run(v); r.use_motion_blur = True
    elif v == 'bounce':
        old = (c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.volume_bounces)
        c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.volume_bounces = 4, 2, 2, 4, 0
        run(v); c.max_bounces, c.diffuse_bounces, c.glossy_bounces, c.transmission_bounces, c.volume_bounces = old
    elif v == 'oidnfast':
        old = c.denoising_prefilter; c.denoising_prefilter = 'FAST'; run(v); c.denoising_prefilter = old
    elif v == 'optix':
        old = c.denoiser; c.denoiser = 'OPTIX'; run(v); c.denoiser = old
    elif v == 'nodenoise':
        c.use_denoising = False; run(v); c.use_denoising = True
    elif v == 'nocomp':
        r.use_compositing = False; run(v); r.use_compositing = True
    elif v == 'noao':
        # The grime's ambient-occlusion node is a ray query per shading point.
        nodes = [n for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes if n.type == 'AMBIENT_OCCLUSION']
        for n in nodes: n.mute = True
        run(v + f'_{len(nodes)}')
        for n in nodes: n.mute = False
    elif v[0] == 's' and v[1:].isdigit():
        old = c.samples; c.samples = int(v[1:]); run(v); c.samples = old
    elif v[0] == 't' and v[1:].isdigit():
        old = c.adaptive_threshold; c.adaptive_threshold = int(v[1:]) / 1000.0; run(v); c.adaptive_threshold = old
os._exit(0)
