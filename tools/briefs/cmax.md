# Brief: the owner's 2015 Ford C-Max in the game (asked for Nov 20)

Read tools/briefs/common.md first, then "Rules for this restart" in tools/briefs/allout-cars-2.md
(Blender only with its window showing, the battery check, usage limits). PLAN.md's entries dated
Nov 20 say where the cars stand; "Owner requests, Nov 19 morning" shows how the Bolt was added.

## What the owner asked for

"There should also be somewhere a 2015 gray Ford C-Max. You can use the model from another project
that we worked on or make a new one. Hunt around for that other project though, a lot of work was put
into it. This car should not be right next to the Bolt, and can just be driving around or parked
somewhere."

It is the second real car in the game after the Bolt (kind `bolt`), and like the Bolt it is the
owner's own car, so it must be recognisable as that car, not a generic hatchback.

## The other project

C:/Users/User/cmax (read its README.md first; it is NOT part of this repo, so read from it and copy
numbers out of it, but change nothing there).

- It is a Blender model of the owner's actual car, a dark "Magnetic" grey 2015 C-Max Hybrid SE:
  cmax_2015.blend and the script that builds it, cmax_build.py. About 750 named parts, most of them
  internals (suspension, engine bay, interior) the game has no use for.
- What is valuable in it is the MEASURED SHAPE. The body is a loft from tables in cmax_build.py
  (roof and bonnet line ZT, beltline BELT, half-widths W.., WBTAB, WRF, the shoulder table SHLD,
  door, glass and lamp boundaries) that were traced from a studio profile of the same model and then
  corrected against a photogrammetry solve of the owner's own walk-around video, over many rounds
  with the owner (nose too flat, tail too wide, bonnet too high: all fixed and recorded in the
  README). textures/body_mesh.npz is the body surface it exports.
- renders/ shows what it looks like: cmax_01_front_three_quarter, cmax_02_rear_three_quarter,
  cmax_03_side_profile, cmax_05_front, and compare_with_carmax.jpg (the model beside studio photos
  of the real car, the best single reference for judging a likeness).
- Facts about the real car, from the owner: published size 4.41 m long, 1.83 m wide, 1.61 m high,
  wheelbase 2.648 m, 225/50R17 tyres; silver 15-spoke 17-inch alloys; NO fog lights (blank bezels);
  a dent at the left rear corner; a rust chip on the left front wing; tape residue round the
  liftgate handle. Axes there: X nose (0) to tail (4.41), Y + is the passenger side, Z up.

## What the game needs

A new kind `cmax` that behaves like every other car: three levels of detail within the budgets the
other kinds keep (near about 16k triangles, street about 12k, far about 1.6k), the material names
and lamp sections tools/blender/cars.py produces (lamps that light section by section, see-through
glass with a cabin, plates, dirt), separate wheels, UVs with baked normal and occlusion maps in the
kind's 1024 cell of the shared sheets (TEX_KINDS in src/ent/vehicleAssets.ts), per-car paint, and a
far model for phones. The game's cars carry no colour photographs, only paint colour plus those maps.

So there are two honest routes, and you choose after looking at both projects:
1. A new kind in tools/blender/cars.py, as the Bolt was done, whose table is TAKEN FROM the C-Max
   project's measured tables and body mesh rather than guessed, with a d_cmax() for the parts only
   this car has. This is probably the practical route.
2. Bringing the C-Max project's exterior shell into the game's format directly. Better if it can be
   made to meet everything in the paragraph above; do not ship it if it cannot.

Either way the result is judged in the game against renders/compare_with_carmax.jpg: the tall
one-box people-carrier profile with a short steep bonnet, the big trapezoid lower grille with the
slim upper slot, swept-back head lamps, the rising beltline, tall tail lamps either side of the
liftgate, a roof spoiler, the 15-spoke wheels, and the real dark grey (textures/paint.json and the
README's note that the true paint is darker than the first renders).

Details that make it the owner's car, if they fit the budget: the dent at the left rear corner, the
rust chip on the left front wing, no fog lights.

Privacy: the site is public. Do NOT copy the real licence plate, the VIN, or any photograph or
photo texture from the C-Max project into this repo. Give it an invented plate in the game's style.

## Where it goes

- Not beside the Bolt (which is parked at the start).
- One C-Max always parked at a fixed spot a player is likely to come across, somewhere that suits a
  family car (you choose; say exactly where in your report, with coordinates). In its real grey.
- The kind also joins ordinary traffic and the parked-car rotation at a modest weight, always grey.
- Register the kind everywhere a kind must be registered: search the source for every place `bolt`
  appears (specs, names, sounds, traffic and parking lists, the loader) and give `cmax` a fitting
  entry in each. It is a quiet front-wheel-drive hybrid of about 1,650 kg. List every file you
  touched in your report.
