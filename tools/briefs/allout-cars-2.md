# Brief: cars, all-out pass two (restarted Nov 20 after a cut-off)

Read tools/briefs/common.md first and follow it, with the changes under "Rules for this restart"
below. Then read tools/briefs/allout-cars.md, and PLAN.md's entry "Pushed Nov 19, about 11:35 AM ET"
(cars, all-out pass one) for what pass one did and what it owed.

## The job (as first given on Nov 19)

Pass one delivered steps 1-6 and 8 of allout-cars.md in geometry and vertex colour only. Pass two is
what it skipped or fell short on, in this order (each step exported, loaded and looked at in the game
before the next; Bolt first, then sedan, hatch, pickup, van, taxi, then the rest):

A. STEP 7, TEXTURES. UV-unwrap the vehicles in tools/blender/cars.py and bake in Blender from a
   higher-detail version: tangent-space normal maps (panel gaps, grille mesh, vents, lamp lens
   ribbing, tread and sidewall, seat fabric, dashboard grain), ambient occlusion, and
   roughness/metalness where it helps. Pack into small atlases, shared across kinds where the parts
   are shared (wheels, lamps, interiors), about 1 MB per vehicle or less in a compressed web format
   (WebP is fine; the flora loader in src/world/floraAssets.ts shows how textures are fetched and
   decoded here, including a bug to avoid: read a bitmap's size BEFORE closing it). Extend
   src/ent/vehicleAssets.ts and the car materials in src/ent/vehicle.ts to use them at the near and
   middle levels of detail, keeping per-instance paint colour, the per-car dirt, lamp sections and
   instancing. The low (phone) preset keeps the untextured far model.
B. PAINT AND REFLECTIONS. Car paint that reads as real lacquer: clearcoat with a visible sun
   highlight, metallic flake on the colours that would have it, correct fresnel on glass, chrome that
   mirrors. Reflections currently show sky only; if a cheap improvement exists (for example a
   low-resolution local environment capture refreshed rarely, or a generic street reflection blended
   in below the horizon), do it and measure it.
C. THE BOLT'S FACE AND WHEELS. Against the real 2017 Chevrolet Bolt EV: the black mask that joins the
   head lamps to the lower lamp pods and the shield-shaped closed panel between them, the shorter
   bonnet, some sculpting in the flanks (the rising crease from the front wing into the rear lamp),
   and the real twin-spoke machined alloy wheel. It is the one real car in the game, requested by the
   owner by name.
D. SURFACING. Raise the near level's subdivision where arches are visibly faceted; blend the bumpers
   into the body's surfacing instead of separate swept sections; rounder mirrors and door handles;
   cut the bus doors into the shell.
E. INSPECT WHAT NOBODY LOOKED AT. Pass one never viewed the hatch, van, coupe, muscle, sports,
   cruiser, tow and bus close up in the game. Shoot each at 3 m by day and at night with lamps on,
   and fix what is wrong.

Budget: a street of thirty parked cars must not cost more frame time than before pass two at high,
and the phone preset must not get slower; report draw calls, triangles, ms and the total car download
before and after (it was 11.9 MB after pass one; keep it under about 25 MB).

Your files: tools/blender/cars.py, src/ent/vehicle.ts, src/ent/vehicleAssets.ts,
src/ent/vehicleModels.ts, public/models/<kind>.* and the shared car maps in public/models.

## Where the first worker got to

It ran from 8:53 PM to 9:57 PM ET on Nov 19 and was cut off mid-task with no report. What it left:

- scratch/cars2/ is its workshop. p1.py to p6.py are the patches it applied, in order (each is a
  list of exact text replacements, so reading them shows what changed and why). cars.pass1.py,
  vehicle.pass1.ts and vehicleAssets.pass1.ts are the files as pass one left them; vehicle.pre6.ts
  and vehicleAssets.pre6.ts are the files just before p6. buildA/C/D.log are Blender runs. shot.mjs,
  env.mjs and bench2.mjs are its own harness scripts. before.txt and bench-loop.txt are timings.
- Its work up to about 9:30 PM went live with the M5 push (commit 2a4c374): baked normal and
  occlusion maps (<kind>_n.webp, <kind>_o.webp) and the loader for them.
- bench-loop.txt shows the textured cars costing frame time against the pass-one base ("new-high" vs
  "base-high"; the `cars` number is the part the cars cost). p6 is its answer: every kind's maps
  copied into ONE pair of sheets so the kinds share materials. p6 was applied at 9:54 PM and has
  NEVER BEEN RUN in the game. Everything after commit 2a4c374 (see `git diff --stat`) is unverified.
- The lead's street check after the M5 push seemed to show the taxi without its checker band.

## Rules for this restart (these override common.md where they differ)

- Nobody else is editing the tree. Still, do not touch src/core/post.ts or tools/bench.mjs: they
  belong to the performance pass that runs after you.
- Blender must run WITH ITS WINDOW SHOWING, never with `--background` or `-b` (the owner watches the
  laptop screen). Run it as: blender --factory-startup --python tools/blender/cars.py --python-expr
  "import bpy; bpy.ops.wm.quit_blender()" -- <args>   so it closes itself when the script ends, and
  check afterwards that no Blender window is left open. Blender 5.2 is under
  "C:/Program Files/Blender Foundation". If a step truly cannot run with the window (give the error),
  stop and report it; do not fall back to headless.
- Battery: before each Blender run check the charge with
  powershell -NoProfile -Command "(Get-CimInstance Win32_Battery).EstimatedChargeRemaining"
  If it is 20 or below, start nothing heavy: wait in sleeps of at most 5 minutes until it is 80 or
  above, then carry on.
- Usage is rationed harder than before. Stay inside common.md's limits (about 60 tool calls, about
  14 images). Do exactly the task you are given in your prompt and stop: other workers take the
  remaining steps one at a time, and the lead pushes to the live site between them.
- Leave the tree type-checking and the game booting at every pause, with model files and the loader
  in step with each other.
