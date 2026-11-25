# The Blender trailer: plan (phase 1 done: pipeline, look development, proof)

Owner's request (Nov 24 evening): "Let's redo the trailer, so that it renders in Blender but is super high quality.
Realistically higher quality than the game would be, but it should be photorealistic and high quality. I also want to get
rid of the words on the screen, just the gameplay. I'm looking for epic and awesome."

So: 60 s, rendered in Blender (5.2, RTX 4050 6 GB, OptiX), photoreal, built from the game's own world (same places, cars,
people and events), NO title cards or words laid over the picture, cut to "Swing Machine" (public domain, the 60 s edit and
beat grid in tools/promo/storyboard.json), ending on a clean hero plate that the game's live HTML logo card
("PRESS ANY KEY") overlays, as the promo does today (src/ui/promo.ts).

Big files live OUTSIDE the repo, in C:\Users\User\trailer\ (exports, blends, frames, proofs, logs).

## 1. Pipeline

```
tools/trailer/shots.json        shot definitions (promo storyboard format + dur, radius, look, lookOverrides, shake, waterY)
tools/trailer/export.mjs        game -> C:/Users/User/trailer/export/<id>/{scene.glb, anim.json, inst.bin, ref/*.jpg}
tools/trailer/run.mjs           Blender runner with the house rules (visible window, <= 2 Blenders, battery 20%/80%)
tools/trailer/blender/build_shot.py   export -> C:/Users/User/trailer/blend/<id>.blend (+ .log.json)
tools/trailer/blender/look.py         materials, sky/sun/haze/mist, lamps, grass, hero rebuilds, lens, grade, render settings
tools/trailer/blender/render.py       renders a blend (stills or a frame range), resumable, timing per frame
tools/trailer/blender/inspect_blend.py  debugging: evaluated geometry and lights of a built blend
```

One shot, end to end (about 1 minute plus the render):

```
set PW_GPU=high
node tools/trailer/export.mjs --shot P2_mainst --refs          # ~40 s: boots the game, runs the shot, exports
node tools/trailer/run.mjs build P2_mainst                     # ~10 s: Blender builds and saves the .blend, then quits
node tools/trailer/run.mjs render P2_mainst --still 48 --pct 50 --samples 64 --tag look   # a look check
node tools/trailer/run.mjs batch P2_mainst --engine CYCLES --samples 128 --threshold 0.015   # every frame, resumable
```

### Export (tools/trailer/export.mjs)
- Boots the real game with Playwright (`q=high&net=0&ktx=0` plus the shot's `query`, e.g. `season=autumn`), runs the shot's
  `setup` (hour, weather, teleport, spawns), `warm`, places the camera at the shot's start and waits for streamed models.
- Census at frame 0: every visible Mesh, InstancedMesh, Points and Line; THREE.LOD always exports level 0 (the nearest),
  even when the game is showing a farther level.
- Runs the shot frame by frame at 24 fps (same tick / P.each / P.place order as tools/promo/capture.mjs) and compares every
  object's world matrix with frame 0: whatever moved becomes an ACTOR with per-frame matrices (and visibility). Nothing has
  to be declared: the train, cars, the helicopter, rigid people all fall out of this.
- Keeps what is within `radius` of the camera path, then GLTFExporter (binary): flat nodes with baked world matrices;
  geometry de-quantised to float32; vertex colours as COLOR_0 with their alpha ALSO as `_ALPHA` (the game packs material
  classes in it); custom attributes as `_NAME` (`_APBR` roughness/metal, ...); custom shaders become standard materials with
  their uniforms in extras; the textures are the game's source pictures (KTX2 off, compressed/render-target textures
  dropped and named in extras). Instanced meshes: base mesh once, matrices, colours and per-instance attributes in inst.bin.
- anim.json: camera per frame (position, target, vertical fov), actors, instances, the game sky (hour, sun direction, wet,
  night, fog), street lamp heads (from the ground's halo cloud), shot metadata. ref/ holds the game's own frames.

### Build (tools/trailer/blender/build_shot.py)
- glTF import (y-up -> z-up); everything in anim.json is converted the same way: (x, y, z) -> (x, -z, y).
- Instances -> one point cloud per instanced mesh + a geometry-nodes Instance on Points (rotation/scale per point; instance
  colour and per-instance attributes readable in shaders through an Instancer attribute).
- Actors keyed per frame (location, quaternion, scale, hide_render); camera keyed (location, rotation, focal length from
  the vertical fov, focus distance = distance to the look target).
- Drops what Blender does better: fake contact-shadow decals, the sky dome, particle sprites, rain streaks.

### Look (tools/trailer/blender/look.py)
- Every game material keeps its own colours (texture x vertex colour x instance colour) and gets real physics: roughness
  (from `_APBR` where the game has it), metalness never trusted on world surfaces (the game packs data there), micro bump,
  grime (AO in crevices, broad weathering), WINDOWS painted into facade textures found by colour (bluish or very dark texels)
  and the buildings.py alpha contract, made into smooth reflective glazing that lights up room by room at night.
- Wet: up-facing surfaces darken and go to roughness 0.3, puddles (noise) become mirror-flat clear coat; walls get streaks.
- Glass: transmission, IOR 1.5. Car paint: clear coat 0.025 over a metallic flake base. Water: deep, Fresnel, animated
  two-scale waves. Falls: animated foam. Foliage: translucency. Far hills: the game's own hill colour.
- Hero rebuilds: the SpeedScan tower (glass curtain wall from the game's alpha classes, 3 x 3.8 m panes each tilted a hair
  for broken reflections, anodised mullions, lit offices at night) and its STINK LINES, rebuilt from speedscanHQ.ts's own
  numbers and vertex-shader formula in geometry nodes, turned into a real glowing green VOLUME (points to volume + 4D noise).
- Sky: Blender's physical sky (Multiple Scattering, the successor of Nishita) with a matching sun lamp, warm at low angles;
  aerial haze in a 5 km box around the camera (a world volume would swallow the sky); river mist as a low noisy volume.
  No HDRI is used, so no third-party licence is involved.
- Street lamps: one downward spot (650 W, cobra-head cone) plus a visible emissive lens at every lamp head the game has
  near the camera (193 on Main St). Shopfronts glow with their own painted interiors.
- Grass: geometry-node clumps of curved blades on green, flat ground within ~60 m of the camera.
- Lens: real focal lengths, depth of field (f/2 street, f/4 river, f/5.6 aerial), 180-degree shutter motion blur, noise
  "handheld" shake on rotation (per shot `shake`). Grade: AgX with a contrast look (Punchy on the golden tower), bloom
  (Glare), a touch of lens distortion and dispersion, vignette.

## 2. Engine choice

Measured on this laptop at 1920x1080 (RTX 4050 Laptop, 6 GB, OptiX; nothing else on the GPU):

| shot | Cycles (OptiX, OIDN, adaptive) | EEVEE (raytraced) |
|---|---|---|
| P2 Main St, wet dusk, 205 lamps | 128 spp: 207 s first frame, 100 s next frames (persistent data) | 64 spp: 18 s/frame (+~10 s shader compile once) |
| P3 river, sunrise mist volume | see section 3 | 64 spp: 70 s/frame (volumes) |
| P1 tower, golden hour | see section 3 | not measured |

Pick: **CYCLES** for every shot. It is the one that reads photoreal here: real off-screen reflections in the puddles and
the river, correct soft shadows from 200 lamps, real god rays in the mist. EEVEE is 5x faster on hard-surface shots but
looks flatter and greyer (side by side: C:\Users\User\trailer\look\P2_mainst\e1_f0048.png vs
C:\Users\User\trailer\bench\P2_cycles\f0049.png), and is NOT faster on the volumetric shots that matter most (mist,
tornado, fireworks smoke). EEVEE stays the fallback for any shot that blows the budget.

Final settings: 1920x1080, 24 fps, Cycles 128 samples, adaptive threshold 0.015 (min 32), OpenImageDenoise on the GPU
(albedo + normal), light tree on, bounces 8 (diffuse 3, glossy 4, transmission 8, volume 1), indirect clamp 8, filter
glossy 1, persistent data on, motion blur 0.5.

## 3. The proof

(filled in from the renders: see the report at the end of this file)

## 4. Shot list (19 shots, no words, cut on the measured beat grid; 108 beats = 60.0 s; 24 fps = 1440 frames)

A day in Port Calamity, from a quiet foggy dawn to a night of chaos and fireworks. The quiet intro (0 to 16.9 s) is wide and
slow; the band comes in on the tower (17.09 s, the first beat after 16.9); cuts tighten through the afternoon chase; the breath
(39.8 s) falls in the last beat of Main St and the tornado follows; the climb (43.8 s) is night and speed; the drop is slow motion; the final hit (54.75 s, beat 105) lands the clean hero plate.

| # | beats | time (s), frames | shot | place, light | camera | type |
|---|---|---|---|---|---|---|
| 1 | 0-8 | 0.00-4.76 (114 f) | Dawn over the harbour: drone glides low over flat water through fog toward the skyline; the tower's stink lines glow faintly | harbour, 6:30, fog | 24 mm drone, slow push, 2 m over water | volume |
| 2 | 8-16 | 4.76-8.87 (99 f) | The Budget Line crosses the river trestle into the sun (proof P3) | Tepid Falls river, sunrise mist | 33 mm, bank, slow pan | volume |
| 3 | 16-24 | 8.87-13.00 (99 f) | A bull moose stands in a misty snow lane; breath steam; a car's headlights come round the bend | Anchor St, winter morning | 135 mm long lens, locked off | volume |
| 4 | 24-32 | 13.00-17.09 (98 f) | Threadbare Dam's falls and the mills: crane up from the spray to the town | Tepid Falls, morning | 28 mm crane | volume (spray) |
| 5 | 32-40 | 17.09-21.22 (99 f) | BAND IN: drone crane up the SpeedScan tower to the stink lines (proof P1) | downtown, golden hour | 33-28 mm drone | city day |
| 6 | 40-44 | 21.22-23.29 (50 f) | Speedboat flat out at the giant duck, spray over the lens | harbour, afternoon glitter | 24 mm, low tracking | water |
| 7 | 44-48 | 23.29-25.36 (50 f) | Sports car hits the stunt-park ramp and flies past the camera | stunt park, afternoon | 18 mm, low, side | city day |
| 8 | 48-52 | 25.36-27.40 (49 f) | The Great Calamitini fires; follow the flight (0.5x) | Strand, afternoon | 50 mm follow | city day |
| 9 | 52-56 | 27.40-29.47 (49 f) | Derby bowl: cars collide, the crowd on its feet, dust | derby bowl, late afternoon | 35 mm orbit | city day + dust |
| 10 | 56-62 | 29.47-32.58 (75 f) | The chase begins: heat 5 on the Thruway, three cruisers, the helicopter low | Thruway, golden hour | 24 mm ahead, looking back | city day |
| 11 | 62-70 | 32.58-36.71 (99 f) | From the helicopter: the pursuit weaving through traffic, lights flashing, sun flare | Thruway to Calamity Ave | 50 mm aerial follow | city day |
| 12 | 70-77 | 36.71-40.31 (86 f) | Main St after rain at dusk, lamps on (proof P2) | Tepid Falls Main St | 30 mm, low push | city night |
| 13 | 77-85 | 40.31-44.44 (100 f) | THE BREATH: the tornado crosses an open lot beyond a house, debris swirling, lightning | west lots, storm | 24 mm, low, near-locked | volume (heavy) |
| 14 | 85-89 | 44.44-46.49 (49 f) | Four cars on the line at the lights under the Christmas lights; they launch | Main St, night | 40 mm low dolly | city night |
| 15 | 89-93 | 46.49-48.55 (49 f) | The helicopter's searchlight sweeps the pursuit through downtown, wet, police lights | downtown, night | 35 mm | city night + beam |
| 16 | 93-97 | 48.55-50.62 (50 f) | First fireworks shells climb from the pier; faces of the crowd lit | pier, night | 50 mm | fireworks |
| 17 | 97-101 | 50.62-52.69 (49 f) | THE DROP, 0.25x: a car off the stunt ramp over the camera, fireworks behind | stunt park, night | 14 mm, from below | fireworks |
| 18 | 101-105 | 52.69-54.75 (50 f) | Fireworks finale over the harbour: volleys on the beats, smoke lit from inside | harbour, night | 35 mm, pier head | fireworks (heavy) |
| 19 | 105-108+ | 54.75-60.00 (126 f) | HIT: the clean hero plate. Slow drift over the night harbour to the lit tower, stink lines glowing; the live HTML logo card overlays it | harbour, night | 50 mm drift | city night |

Beat times come from storyboard.json music.grid through tools/promo/timeline.mjs (the same code as the promo), so cuts land
exactly on beats; P.beats inside a shot puts events (shells, the launch, the lightning) on beats too.

## 5. Render-time estimate and schedule

Seconds per final frame (Cycles, 1080p, 128 spp), from the proof renders, by shot type:

| type | s/frame | shots | frames |
|---|---|---|---|
| city day (P1-like) | TBD | 5, 7, 8, 9, 10, 11 | TBD |
| city night / wet (P2-like) | ~100 | 12, 14, 15, 19 | TBD |
| volume (P3-like) | TBD | 1, 2, 3, 4, 13 | TBD |
| water | ~P1 x 1.2 | 6 | |
| fireworks | ~P2 x 1.5 (emissive smoke volumes) | 16, 17, 18 | |

(The table is completed in section 7 with the measured numbers.)

## 6. Disk

TBD in section 7.

## 7. Results and numbers (phase 1)
