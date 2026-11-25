# Render a built shot with Blender's window VISIBLE (the render shows in its own window as it goes), then quit.
#
#   blender.exe C:/Users/User/trailer/blend/P1_tower.blend --python tools/trailer/blender/render.py --
#       --out C:/Users/User/trailer/proof/P1_tower [--frames 1-96 | --still 48] [--engine CYCLES|EEVEE]
#       [--samples N] [--threshold 0.012] [--pct 100] [--w 1920 --h 1080] [--tag name]
#
# Resume: frames already on disk are skipped (use_overwrite off, placeholders on), so a batch cut off by the battery
# rule, a crash or the morning can be started again with the same command and carries on where it stopped.
# Timing: <out>/timing[-tag].json gets seconds per frame (render_pre to render_post, including scene sync).

import bpy, sys, os, json, time

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
A = {}
i = 0
while i < len(argv):
    k = argv[i].lstrip('-')
    if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
        A[k] = argv[i + 1]; i += 2
    else:
        A[k] = True; i += 1
OUT = A['out'].replace('\\', '/')
os.makedirs(OUT, exist_ok=True)
sc = bpy.context.scene
r = sc.render
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import look

if 'engine' in A and (A['engine'].upper() == 'CYCLES') != (r.engine == 'CYCLES'):
    # Only when the engine really changes: the blend already carries the shot's own settings (shutter, resolution).
    look.render_settings('CYCLES' if A['engine'].upper() == 'CYCLES' else 'EEVEE', samples=int(A['samples']) if 'samples' in A else None,
                         threshold=float(A.get('threshold', 0.025)), shutter=r.motion_blur_shutter)
if r.engine == 'CYCLES':
    print('[render] OptiX devices:', look.enable_gpu(), flush=True)
if 'threshold' in A and r.engine == 'CYCLES':
    sc.cycles.adaptive_threshold = float(A['threshold'])
for k_, attr_ in (('diffuse', 'diffuse_bounces'), ('glossy', 'glossy_bounces'), ('transmission', 'transmission_bounces'), ('bounces', 'max_bounces'), ('volstep', 'volume_step_rate')):
    if k_ in A and r.engine == 'CYCLES':
        setattr(sc.cycles, attr_, type(getattr(sc.cycles, attr_))(float(A[k_])))
if 'denoiser' in A and r.engine == 'CYCLES':
    sc.cycles.denoiser = A['denoiser'].upper()
if 'samples' in A:
    if r.engine == 'CYCLES':
        sc.cycles.samples = int(A['samples'])
    else:
        sc.eevee.taa_render_samples = int(A['samples'])
if 'w' in A:
    r.resolution_x, r.resolution_y = int(A['w']), int(A['h'])
r.resolution_percentage = int(A.get('pct', 100))
tag = A.get('tag', r.engine.lower())
times = []
state = {'t': 0.0, 'start': time.time()}


def pre(scene, *_):
    state['t'] = time.time()


def post(scene, *_):
    times.append({'frame': scene.frame_current, 's': round(time.time() - state['t'], 2)})
    json.dump({'engine': r.engine, 'res': [r.resolution_x, r.resolution_y, r.resolution_percentage],
               'samples': sc.cycles.samples if r.engine == 'CYCLES' else sc.eevee.taa_render_samples, 'frames': times},
              open(os.path.join(OUT, f'timing-{tag}.json'), 'w'), indent=1)


def done(scene, *_):
    post_t = time.time() - state['start']
    with open(os.path.join(OUT, f'done-{tag}.txt'), 'w') as f:
        f.write(f'{len(times)} frames in {post_t:.1f} s\n')
    os._exit(0)


bpy.app.handlers.render_pre.append(pre)
bpy.app.handlers.render_post.append(post)
bpy.app.handlers.render_complete.append(done)
bpy.app.handlers.render_cancel.append(done)

if 'still' in A:
    f = int(A['still'])
    sc.frame_set(f)
    r.filepath = os.path.join(OUT, f'{tag}_f{f:04d}.png')
else:
    a, b = (A.get('frames') or f'{sc.frame_start}-{sc.frame_end}').split('-')
    sc.frame_start, sc.frame_end = int(a), int(b)
    r.filepath = OUT + '/f'
    r.use_overwrite = False
    r.use_placeholder = True


def go():
    if 'still' in A:
        bpy.ops.render.render('INVOKE_DEFAULT', write_still=True)
    else:
        bpy.ops.render.render('INVOKE_DEFAULT', animation=True)
    return None


bpy.app.timers.register(go, first_interval=2.0)
