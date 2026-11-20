# Brief: M6 — performance and polish

Read tools/briefs/common.md first and follow it, and no git commands that change state at all.

RESTARTED Nov 20. The first worker on this brief was cut off about half an hour in. M6 is now done
as a series of small runs, one worker at a time, each given ONE numbered section below (or part of
one) in its prompt, each followed by an independent check and a push to the live site. Do only the
part your prompt names. Stay inside common.md's limits (about 60 tool calls, about 14 pictures)
unless your prompt raises them. What the first worker left:
- tools/bench.mjs: the benchmark of section 1, written and working (read its header). It was adding
  "several A/B pairs" and "survive a failed boot" when it stopped; check both.
- scratch/m6/before.txt and before2.txt: its baseline measurements. census.mjs, probe.mjs, sync.mjs:
  its helper scripts.
- scratch/m6/post.wip.ts and post.wip.patch: its unfinished change to src/core/post.ts, NOT in the
  tree: FXAA in the composite in place of the 4x multisampled half-float scene target (it measured
  the resolve at 3.4 to 5.5 ms, a fifth of the frame on this GPU), and AO samples 10 to 8 at high.
  It type-checked but was never judged in the game.

Read PLAN.md's entries dated Nov 20 and the "Owed" lists under the older pushes. The car work is
finished for now: do not touch tools/blender/cars.py or the car files in public/models, and change
src/ent/vehicle*.ts only if your section needs it. Since this brief was written the game gained a
thirteenth car kind (the owner's C-Max) and the cars' texture sheets grew to 4096x4096.

The game now has two lands, Blender models for cars, people, trees and props, physically based
materials, a post pass, traffic, pedestrians, police, weapons, missions, saving and sound. It grew
fast and nobody has tuned the whole. The baseline machine is an Intel Iris Xe laptop GPU; the live
site measured about 105 frames a second two days ago and about 72 now. Phones use the `low` preset.

Do it in this order; measure before and after every change and keep only what helps:

1. MEASURE. Build a repeatable benchmark (extend tools/pbr-bench.mjs or write tools/bench.mjs): fixed
   camera paths and stills at the start, downtown, Mercy Park, Gull Heights, the pier, mid-bridge,
   Main St in Tepid Falls (query bridge=8&stage=4), The Stacks, a night street in rain with heat 3;
   at high, medium and low; reporting draw calls, triangles, textures and their memory, ms per frame
   (200 renders with gl.finish; machines are noisy, so interleave A/B within one session), the cost of
   each system's update (sim, people, traffic, police, fx, audio, missions, HUD), and load time from
   navigation to ready and to all models loaded, with the download broken down by file.
2. THE FRAME. Find and fix the biggest costs. Candidates named in PLAN.md: the MSAA half-float scene
   target (try FXAA or SMAA in the composite), AO resolution and sample count, PBR cost on facades,
   leaf-card overdraw and the trees' middle level, shadow pass content (what is drawn into it and how
   far), people at the near level, the 16 MB radar chart canvas, anything drawn that is not visible
   (the far land when you are on the other one), instanced meshes with frustum culling off, materials
   that could share programs. Targets on this machine at 1080p: at least 60 frames a second everywhere
   at high with headroom, and the low preset no slower than it was.
3. QUALITY THAT CHOOSES ITSELF. Replace the fixed preset choice: detect a sensible starting preset from
   reliable hints plus a quarter-second benchmark at first run (cached with the GPU string), and a
   governor that watches real frame times and nudges pixel ratio, then shadows, then AO, down and
   back up with hysteresis so it never oscillates. `?q=` still overrides; the menu's quality setting
   gains "Auto" as the default.
4. LOADING. The site is over 20 MB. Split the JS bundle sensibly (Vite manual chunks or dynamic import
   for audio, missions, the menu and the mainland), load models in order of need (what is near the
   player first; mainland models only when the bridge is nearly done or the player is close), show
   honest progress on the title card, and make sure the old box people and blocky cars are not what
   the player sees for the first seconds if a short wait fixes it (or fade the real models in).
   Compress what can be compressed without new dependencies at runtime.
5. THE OWED LIST. Work through PLAN.md's owed items that are small and certain, starting with the ones
   a player would notice in the first ten minutes: the teal cast on shadowed roads; distant haze
   swallowing the island and the college spire (thin fog with camera height, cap the fog amount);
   bench sitters holding the driving pose (set the new bench flag); the mill pond swim height
   (`waterLevelAt`); the HUD showing the police search state; T for the radio on the quick-reference
   card; the dead pause-card code; api.ts declarations that lag the implementations; Dess almost black
   at night (a soft fill on people); the unexplained olive wedge and brown band near (-19, -1)
   downtown; AI cars hitting pedestrians; anything else you find.
6. BUG BASH. Play it by script the way a person would, for an hour of game time across both lands: a
   mission, a taxi shift, a chase at heat 3, an arrest, a death, a swim, the bridge box, a reload
   mid-everything, the menu, the phone layout with touch. Fix what breaks. Run a long soak (30 minutes)
   watching memory for leaks.
7. NIGHT. The plan asked for bloom at night: make the night scenes as good as the post pass allows
   (lamps, windows, headlights, the Ferris wheel, wet streets), with the retuned AO and bloom against
   the current materials.

Report as common.md asks, with the benchmark table before and after for every scene and preset, what
you changed and what each change bought, what you tried and reverted, and the remaining owed list.
