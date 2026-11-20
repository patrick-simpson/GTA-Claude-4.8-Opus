# Port Calamity — build plan and handoff

An original open-world crime sandbox for the browser, replacing the old mobile
driving prototype. Same genre as the big-name crime games (drive, carjack,
traffic, police chases, missions) but with its own name, city, characters, art
and writing. **Do not copy any existing game's name, characters, map, HUD look
or music.**

Owner preferences: plain-English explanations, whimsical humor and easter eggs,
American units (mph, feet), Eastern Time, percent-complete updates, and
**push to `main` after every milestone** (credit is limited, so nothing may be
lost). Keep token use lean: write code directly, verify cheaply, avoid large
multi-agent fan-outs.

## Where things stand (about 93% done)

**Milestone 1, the first playable, is live** at gta.doofus.live (switched over
Nov 18, 2026, about 6:30 AM ET). You can walk, swim, get in and out of any of the
eleven vehicles and drive the whole island, by keyboard, gamepad or phone, through
a full day and night with weather. Next up is a test-and-polish pass on M1 (list
below), then M2.

| File | What it is |
| --- | --- |
| `src/core/api.ts` | The contracts: what every subsystem promises the others. Read this before touching anything |
| `src/core/game.ts` | The `Game` object, quality presets, events, the frame order, and `game.systems` (a plug-in slot for later milestones) |
| `src/main.ts` | Entry point and the `window.__game` test hooks |
| `src/core/util.ts`, `input.ts`, `camera.ts`, `cheats.ts` | Helpers and conventions; keyboard, mouse, gamepad and touch as one action map; the third-person and chase camera; typed cheat words |
| `src/world/plan.ts`, `collide.ts`, `batch.ts`, `signals.ts` | The city as data; static collision; geometry batching; traffic-signal timing |
| `src/world/textures.ts`, `materials.ts` | Every canvas texture (facades, roads, the sign atlas with all the pun shops) and the shared materials |
| `src/world/ground.ts`, `buildings.ts`, `landmarks.ts`, `places.ts`, `world.ts` | Terrain, sea, roads, lamps, signals, trees, props; every building; pier, Ferris wheel, lighthouse, bridge, ramps, duck; park, arena, billboards, beach, harbor; and the file that assembles them |
| `src/world/sky.ts` | Sky dome, sun and moon, clouds, fog, weather, lights and shadows, tone mapping, the game clock |
| `src/ent/vehicleSpecs.ts`, `vehicleModels.ts`, `vehicle.ts` | The roster, the car bodies, and the driving physics and drawing |
| `src/ent/character.ts`, `player.ts` | People as animated box-limb figures; Dess on foot and at the wheel |
| `src/ui/hud.ts`, `title.ts`, `touch.ts` (+ CSS) | Radar, readouts, stamps, toasts, pause card; title card; touch controls |
| `tools/pw.mjs`, `tools/shot.mjs` | Test harness: boots the game in headless Chromium and takes screenshots (`node tools/shot.mjs shots/a.png --at -340,291.8,1.5708 --drive sports --keys KeyW --steps 260`) |
| `next/` | Staging folder for later-milestone modules written ahead of time. Empty so far apart from its README |

Easter eggs already in: the giant rubber duck, Gerald the seagull, the 3 AM UFO,
the "Room 404" door, typed cheat words, the pun shop signs, the WDOOF billboard.
Still owed: the pause-menu stat "Mistakes made: 0*" belongs to the M4 menu (the M1
pause card shows it already).

### Owner decisions since M1 (Nov 18, 2026) — these override older text in this file

1. **Not low-poly: as realistic as a browser can manage.** The owner asked for
   this after seeing M1. It replaces the flat "travel poster" shading (the palette
   survives as the town's colours and the colour grade; the HUD paperwork style
   stays) and it lifts the "no external art" rule: models and textures may ship as
   files, as long as our own scripts generate them (Blender 5.2 is installed on the
   owner's PC and may be used). Do it in visible steps, pushing each: (a) physically
   based materials and lighting across the city (normal and roughness maps, wet
   roads, soft shadows, ambient occlusion, reflections, bloom, a filmic grade);
   (b) cars modelled in Blender with curved panels, interiors and baked shading,
   with simpler versions at distance; (c) people with real proportions, a skeleton
   and skinned meshes instead of box limbs; (d) foliage, props, building depth.
   Phones get a simpler version. This rework comes BEFORE the rest of M2.
2. **Use cheaper models where they do the job.** Haiku for fixed-recipe checks
   (screenshot sets, scripted numbers, data validation); Sonnet for well-specified
   code and small fixes with a clear repro; the top model for driving feel, art,
   lighting, integration and writing.
3. **The site is at gta.doofus.live** (the owner moved it from gtaopus).

### Owner decisions, Nov 18 evening — add-on land and progression

1. **The first add-on land is the mainland, reached by FINISHING the Perpetual
   Bridge** (the owner chose this over a ferry). The mid-air stop and its stunt
   jump go away once the bridge is complete.
2. **Theme: Waterville, Maine.** A central-Maine mill town on a river: a brick
   Main Street downtown, big brick textile mills by a dam and falls, a narrow
   pedestrian footbridge across the river, a small hilltop liberal-arts college
   with a white-spired chapel and lawns, railroad yards, an interstate with
   exits, an opera house and town square, wooden triple-deckers and
   clapboard houses with porches, pines, birches and maples, a stream and a
   lake nearby, a sister town across the river with a timber blockhouse fort.
   Use it as inspiration for layout and character; invent the names (this is
   still Port Calamity's world), and verify real details against a map before
   leaning on them.
3. **Slow, continual progression.** Players should see steady progress over a
   long time rather than everything at once. Working design until the owner says
   otherwise: the bridge is visibly BUILT span by span as the player earns
   progress (missions, jobs, money paid to the "Bridge Completion Fund",
   collectibles), so the mainland opens gradually; the mainland itself unlocks in
   stages (the riverfront mills, then downtown, then the college hill, then the
   interstate and lake); vehicles, weapons and shops unlock over time; a visible
   progress readout in the pause menu. Save progress (M4's save system).
4. **Place stamp gets in the way** when entering a new area: make it small and
   out of the sight line (in progress with M3).
5. **A reset button** ("Start over" on the pause card, and hold Backspace) (in
   progress with M3).
### M5 "Sound": pushed Nov 19, about 9:30 PM ET

`src/audio/` (about 3,000 lines, no audio files; `game.audio`): engine synthesis
per vehicle kind (the Bolt a whine), tyres, horns, impacts, doors; ten ambience
beds by place and time incl. Tepid Falls (dam, mill, pines); footsteps, props,
the duck, Gerald, the saucer; sirens, helicopter, gunshots, explosions, fire,
pedestrian gasps; UI sounds; a radio with six generated stations (WDOOF 99.9,
Low Tide FM, Ledger 1040, The Cannery 88, Radio Fishbone, and a Tepid Falls
station once the bridge is complete), T or the RADIO touch key. Volume sliders in
the menu, saved. Silent until the first click; suspended when paused or muted.
Owed, important: NOBODY HAS HEARD ANY OF IT. Levels, spectra and note data were
measured; whether it sounds right needs the owner's ears. Tune in the tables
`ENGINES`, `HORNS`, `STATIONS`, `GUN_LEVEL`, `TRIM`. Also: several triggers never
fired in tests (AI horns, fire, ricochets, officers' shots, booked, respray,
thunder, foghorn, train, church bell); tab-hidden suspend untested; HUD sounds
hook by wrapping hud methods; footstep surfaces are approximated; the on-screen
quick-reference card does not list T for the radio.
### M4 "Things to do": pushed Nov 19, about 5:00 PM ET

`src/game/` (`index.ts` registers `ThingsToDo` as `game.todo`): `save.ts` (one
versioned document, key `portcalamity.save.v1`; autosave; `?save=0` disables it),
`script.ts` (19 step types, checkpoints, retry), `missions.ts` (13 missions: ten
on the island paying 2,430 points, i.e. 5 of the 8 bridge spans, then mill,
college and thruway jobs as Tepid Falls opens; givers at the Marlowe yard (Lou,
a Harbor Authority watchman), Finch's bait shop, Gus's arcade, Vance's office),
`activities.ts` (taxi, courier, towing, six races, stunt jumps, 30 ducks with 8
in Tepid Falls; payouts taper), `shops.ts` ("Forms & Rounds" ammo on Ledger St,
"Bent & Dented" body shop on Tinplate St). `src/ui/menu.ts`: the pause card is
now a dossier with MAP, PROGRESS, STATS ("Mistakes made: 0*"), SETTINGS,
CONTROLS, New game (wipes save, bridge and stages; hold Backspace only unsticks).
Press G to talk or use; USE key on touch; M opens the map.
Owed, important: NOBODY HAS PLAYED IT BY HAND. Every mission was passed by a
script that hops along the street graph and does not steer, so timers and
difficulty are untuned ("Public Comment Period" may be too hard). Also: towing
is rigid and clips walls; five of six races never driven; gamepad and touch
map gestures untested; duck rewards at 10/20/30 untested; nothing is actually
gated by unlocks; no hostile Gull Syndicate actors; no shops or respray in
Tepid Falls; radar badges crowd; dead pause-card code left in hud.ts;
`HudApi` in api.ts lacks subtitle/timer/nav/chart/tag.
### Pushed Nov 19, about 4:40 PM ET: trees and street furniture, all-out pass one

`tools/blender/flora.py` -> `flora2.glb` plus five texture files: trees with real
branching, several variants per species, backlit leaves, dappled shadows, baked
impostors at distance; island species on the island, white pine, birch, maple,
oak, spruce and elm with autumn colour in Tepid Falls. Ground cover: reeds at
pond, river, lake and stream, ferns, fallen leaves, wildflower drifts.
`tools/blender/props.py` -> `props.glb`: hydrant, bin, mailbox, bench, sign post,
news box and cobra-head lamp modelled in Blender, drawn within 42 m
(`propAssets.ts`); `?props=0` and `?flora=0` switch back.
Owed: most of the prop list is not done (Tepid Falls post-top lamp, signal masts,
pedestrian signal, bus shelter, parking meter, bollard, bike rack, covers, stop
sign, utility poles and wires); no ivy or planters; props have no baked maps;
prop swap at 42 m is a hard cut; trees still cost 1.7-2.3 ms in tree-heavy
views (not shown to be cheaper than before); cypress is dark and spiky close up;
mailbox and sign post never inspected; an unexplained olive wedge and brown band
near (-19, -1) downtown in shots/fx/felled.png, not from flora or props.
Cause of the black-trees snapshot that was held back: a texture's size was read
after its bitmap was closed (0 x 0 upload). The look-first rule caught it.
### Pushed Nov 19, about 11:50 AM ET: people, all-out pass one

`tools/blender/people.py` and both bodies re-exported together (1.44 MB each):
modelled heads with eyeballs, lids, nose, lips, ears; nine face variants by
morph; hands with fingers (fist, wheel and gun grips); garments as geometry
(tee, shirt, hoodie, jacket, coveralls, dress, trousers, jeans, shorts, skirt,
sneakers, boots, cap, beanie, brimmed hat, glasses, backpack); eleven hair and
beard options; per-vertex surface classes (skin, cloth, leather, hair) in the
shader; three levels of detail with only the nearest 8 people at full detail;
stride scaled by height; a bench pose (nothing sets it yet: `bench` on the body
is not in api.ts). `StyledLook` gained topKind/bottomKind/shoeKind/hatKind/
glasses/bag/face/beard and lost shortSleeves/shorts.
Owed: no UVs or baked maps (as with the cars); faces smooth and long; hair is
helmet shells; garments are tubes; limbs are jointed-doll pieces; no heel-to-toe
gait or look-at; 60 people cost about 4 ms at high; the crowd texture is RGBA32F
and untested on a real phone.
WARNING learned here: pushing mid-task snapshots shipped a man with most of his
body missing for about half an hour (model file and loader out of step). When
pushing a snapshot, LOOK at Dess, a pedestrian, a car and a tree in the
production build first, not only at the console.
### Pushed Nov 19, about 11:35 AM ET: Tepid Falls complete, cars all-out pass one

- **Mainland part 2 is done and live** (`mainlandBuildings.ts`, `mainlandPlaces.ts`):
  Lower Main (incl. the picture house "The Hesitation"), The Stacks, Loom Row with
  the Threadbare mill, Quorum Square and Postponement Hall, the Exact Change
  Footbridge, Dithers College, the depot, Thruway exits and Idle Hands truck stop,
  Fort Reluctance, Lake Indecision; easter egg: a duckling at the lip of the dam.
  Owed: college spire hidden from the landing and faint from the bridge; smokestack
  lettering low contrast; porches are solid; rain, fog, medium preset unchecked.
- **Cars, all-out pass one** (`tools/blender/cars.py`, all twelve re-exported):
  three levels of detail (LOD0 12-16k triangles for the nearest four cars, LOD1,
  LOD2), lamps with bowls and sectioned lenses that light independently (head,
  tail, brake, reverse, indicator, daytime), plates, emblems and scripts, tread,
  calipers, undersides, fuller interiors behind half-transparent glass, real bus
  doors, per-car dirt. The Bolt is reworked (kink, split tall tail lamps, roof
  rails, two-tone alloys). Car files went from 4.6 MB to 11.9 MB.
  Owed: no UVs or baked normal/roughness maps at all (step 7 of the brief); LOD0
  is far below the 40-60k asked for; bumpers still separate sections; mirrors and
  handles boxy; reflections show sky only; Bolt's face still generic, wheels not
  twin-spoke; many kinds never inspected close up in the game.
- Queue: people all-out (running), flora and props all-out (next), then M4.
### Owner requests, Nov 19 morning

- **A 2017 Chevy Bolt, black** (kind `bolt`): the one real car, by explicit request;
  parked at the start. Pushed about 6:30 AM ET. Not yet a faithful likeness: nose
  too blunt, tail lamps too short, rims render dark, and black hides its shape.
- **Tapping the game goes full screen** (`goFullscreen` in `src/ui/title.ts`;
  `?fs=0` turns it off; iPhone Safari cannot do it). Pushed about 6:30 AM ET.
- **"Go all out on these Blender models."** Briefs in `tools/briefs/allout-*.md`:
  people (faces, hands, garments, hair, baked textures, gait), flora and street
  furniture (real branching, species per land, dappled shade, props in Blender),
  and cars (lamps, interiors, panel gaps, badges, baked detail). In progress.
- **Push updates regularly as things are created.** Rule for whoever holds the
  session: whenever the shared tree type-checks, build it, boot the production
  build on the island, the mainland (`?bridge=8&stage=4`) and the phone preset
  with zero console errors, and push, even while agents are mid-task on other
  files. CI only deploys a build that passes, so a bad snapshot cannot reach the
  site. Check again at least every time an agent reports.
### The mainland, part 1 (land, bridge, streets): pushed Nov 19, about 2:30 AM ET

The mainland town is **Tepid Falls** (Waterville-inspired, all names invented):
the Muddle River with Threadbare Dam, Dithers Hill (college), Lake Indecision,
the Thruway, Sidetrack Yard, Lesser Tepid across the Exact Change Footbridge.
Data in `src/world/mainland.ts` (`SITES`, `EXTRA_LOTS`, `HILL`, `RAIL`, `DECKS`);
the plan's nodes, edges and blocks now carry `land` (0 island, 1 mainland), and
the 801 mainland lots are in `plan.mainlandLots` (empty until part 2).
`src/world/progress.ts`: the bridge is built in 8 spans (250 to 950 points each,
4,800 in all; a dollar at the Bridge Completion Fund box at the bridge foot is a
point, driving trickles 1 point per 60 m, `progress.add(points)` for missions),
then four town stages (mills and Lesser Tepid; Main St, square, yard; college
and The Stacks; exits and lake) behind construction barriers. Test with
`?bridge=8&stage=4` or `__game.bridge(n)` / `__game.stage(n)`.
The full layout table with coordinates is in the part 1 report, summarised in
`tools/briefs/mainland-2-buildings.md`.
Owed: every mainland lot is empty (part 2); the mill pond is drawn 1.2 m above
sea level but swimming still uses WATER_Y (`waterLevelAt` is exported, unused);
at 7 spans a fast car can jump the last gap; trees are island species (no pine or
birch yet); no mist at the falls; police station and release point are island
only; night, rain and phone were not checked on the mainland; "Start over" does
NOT reset bridge progress (deliberate for now: Backspace is also the unstick
key; ask the owner).
### M3 "Trouble": pushed Nov 19, about 1:35 AM ET

`src/sim/police.ts`, `policeAir.ts`: heat only rises for crimes someone could
see; Harbor Patrol cruisers pursue, ram and set roadblocks by level; officers on
foot arrest ("BOOKED", $150 fine, weapons confiscated, release at Harbor Patrol
Station No. 1 on Ledger St) or shoot from heat 3; a helicopter with a spotlight
at heat 4+; "Fresh Coat" respray on Bollard St in the Cannery clears heat.
`src/ent/weapons.ts`: fists, Paperweight (pistol), Stapler (SMG), Gull Duster
(shotgun) and a launcher; over-the-shoulder aim; cars smoke, burn, explode and
leave wrecks; drive-by; pickups at five places; cheat `BADIDEAS`.
Also in this push: the district stamp is now a small tag under the objective
strip, and "Start over" (pause card, or hold Backspace) calls `player.reset()`.
Owed: at heat 1 a player who drives off at once is never reached; parking with
cruisers on your bumper never loses them (escape is only by outrunning);
officers carry no gun model and no flash was seen in stills; no arm or weapon
drawn in a drive-by; recoil never recovers and has not been hand-played; the
HUD does not yet show the search state from the 'heat' event (radar circle,
"searching" pips); `PlayerApi` in api.ts lacks hurt/reset/weapons; police.ts
should call `player.hurt(dmg, from)` for hit direction; weapons.ts copies a
mode number from peds.ts; sirens and gunshots wait for M5.
### M2 "A living city": pushed Nov 18, about 8:40 PM ET

`src/sim/peds.ts` and `traffic.ts` (behind the `Ambient` class in `ambient.ts`):
walkers cross at lights, avoid each other, flee, sit, and are knocked down by any
car ('pedHit' event); AI cars use every lane, stop at lines, queue, overtake,
honk, and react to being cut off or hit. Ten-minute soaks at four places: no
stuck cars, no AI-on-AI collisions, no red-light running, about 0.08 ms.
`src/fx/particles.ts` and `skids.ts`: tyre smoke, skid marks, sparks, debris,
hydrant geyser, splashes, dusts, rain splashes, engine smoke; explosion, fire,
tracers and muzzle flash are built and waiting for M3 (`game.fx.emitters`).
Owed: the city is thin (24 cars, 60 walkers; a junction averages 2 cars and 7
walkers nearby); AI cars still hit 0-3 pedestrians per 10 minutes; overtaking on
two-lane streets is slow; bench sitters hold the driving pose; give-way-to-the-
right never runs (every 3-arm junction has a signal); several effects were never
looked at (foam ring, rain splashes, dusts, engine smoke); old marks code in
vehicle.ts is switched off by `OLD_MARKS`, delete it once the new system has
proved itself; nothing listens to 'pedHit' or plays the horn yet.
Agent briefs live in `tools/briefs/` (a cut-off agent's replacement re-reads the
same brief).
### Realistic rework, step (d) foliage, furniture, land: pushed Nov 18, about 5:20 PM ET

`tools/blender/flora.py` -> `public/models/flora.glb` (plane, maple, oak, cypress,
palm, shrub, hedge; leaf cards, two levels of detail), loaded by
`src/world/floraAssets.ts` and drawn by `TreeField` in `ground.ts`. Street
furniture rebuilt as rounded models in code. Land: pale beach sand with a wet
tide band, a soft foam shoreline, the east coast dressed (dune grass, driftwood,
rocks, hauled-out boats), Strand block cores filled with beds, stalls and courts,
lawn variation and ground cover. `?flora=0` switches the trees back.
Owed: trees cost roughly 2-4 ms in tree-heavy views at high (leaf-card overdraw);
leaf cards read as cards within 5 m; one model per species so rows repeat;
hydrant, mailbox, bin, post, news box and palms were never inspected close up;
Gull Heights verge tufts may sit on driveways; Strand cores are still mostly
paving; lawn variation patches `mats.grass` at runtime and belongs in
materials.ts. Distant haze (sky.ts): thin fog with camera height, cap fog amount
near 0.8, cool the far colour.

**The realistic rework's first pass is complete** (materials and post, cars,
people, foliage and land). Each has a list of improvements above. Next: the
rest of M2, then the add-on lands.
### Realistic rework, step (c) people: pushed Nov 18, about 5:00 PM ET

`tools/blender/people.py` builds two skinned bodies (`public/models/person_f.glb`,
`person_m.glb`, 19 bones, two levels of detail); `src/ent/characterAssets.ts`
loads them and `character.ts` skins the whole crowd in the vertex shader from one
bone texture (4 draw calls). The old box people remain as the fallback until the
files load (`?people=0` forces them). Honest state: people at 5 m and beyond, and
in motion; smooth mannequins up close. Next, in order: a modelled face and head
with separate skin and cloth roughness; clothes with their own silhouette
(collar, jacket, skirt) and a cloth detail texture; a gait pass (feet drift
about a tenth of body travel when running, and the player has no walk, only a
jog); fingers. Not verified: seated pose inside a car, the fall and knocked-down
poses, night, a real phone (the crowd texture is RGBA32F).
Note for tests: models load after boot, so `tools/shot.mjs` taken immediately
shows the old cars and people; wait a few seconds of real time first
(`scratch/distwait.mjs` shows how).
### Realistic rework, step (b) cars: first one pushed Nov 18, about 4:10 PM ET

`tools/blender/cars.py` builds vehicles in Blender (headless) and exports
`public/models/<kind>.glb` with two levels of detail, a wheel, named materials and
baked shading. `src/ent/vehicleAssets.ts` loads them after boot; **add each new
kind to `GLB_KINDS` there** or the game keeps drawing the old procedural shape.
All eleven vehicles are Blender models and live (pushed about 4:40 PM ET). Modeller's own verdict: smooth and correct in silhouette, but lamps are flat panels, bumpers read as separate tubs, the bus doors are slabs, and there are no badges or shut-lines on tailgates; those are the next car improvements. Known: the distance model's
lamps are mangled by decimation (phones see it up close), paint reads satin
rather than glossy, lamp glow sprites sit slightly off the lenses, `?glb=0`
switches the Blender models off.

### Owner request, Nov 18: land

After the realistic rework: (1) finish the parts of the island that still look
like works in progress (empty paved cores in Strand blocks, bare east-coast sand
flats, olive beach sand, distant haze); (2) then start on add-on lands: new
territory beyond the island. The Perpetual Bridge points at a mainland to the
north, which is the natural first one. Order: cars, people, foliage and land
finishing, the rest of M2, then add-on lands.
### Realistic rework, step (a): pushed Nov 18, about 12:05 PM ET

City surfaces are physically based on medium and high (`materials.ts`, with normal
and roughness maps derived in `textures.ts`; glass reflects the sky; roads go
glossy in rain), and `src/core/post.ts` adds ambient occlusion, bloom, one
tone-map and a light grade. Low (phones) keeps the old cheap path. `?pbr=0` and
`?post=0` switch each off for comparison; `tools/pbr-bench.mjs` measures.
Honest state: the gain is modest so far (clearest on glass towers and at night),
and it costs roughly 9 ms a frame downtown at 1080p on Iris Xe. Owed: remove the
teal cast on shadowed roads (`ENV` in materials.ts or the hemisphere light),
retune AO and bloom against the new materials, try FXAA instead of MSAA on the
scene target (saves about 2-3 ms), fade the sun-shadow box edge so it can be
tightened, weathering on surfaces other than facades. Steps (b) cars, (c) people
and (d) foliage and building depth are not started; those are where "low-poly"
actually goes away.
### Test-and-fix round after M1 (pushed Nov 18, about 11:45 AM ET)

Eight testers, nine fixers, one integration gate. Now in: `src/sim/ambient.ts`, a
first cut of M2's living city (about 50 walkers and 18 AI cars that follow lanes,
stop at red lights and queue), lamps and signal masts that shear off when hit
hard, ramps moved so every stunt works, cheats that no longer trigger controls, a
styled health and armor readout, and an opening objective strip. Still open:
walkers ignore each other and never cross streets; AI cars use one lane; the pier
handrail is solid at any speed; the park pond is flat ground; a felled lamp keeps
its light pool; car bodies and people are untouched because the rework replaces
them.
### How M1 was checked, and what was not

Checked on the production build: type-check and build clean; boots with zero
console errors on desktop and the phone preset; 119 to 180 draw calls and 0.5 to
0.8 million triangles; a scripted walk, get-in, drive, steer, get-out; the bridge
jump into the sea and the swim back; collision audit (no building on a road, no
overlap between builders); drawn surfaces against `groundAt()` on the pier, bridge
and breakwater.

Not yet checked (this is the next job, before M2): an independent test pass. The
testers' briefs are written and ready in the session's workflow script; they
cover first impression, art by day and night, landmarks, vehicle looks, driving
feel, on foot, HUD, touch, performance and two code reviews.

Known problems from integration:
- The opening camera is side-on to Dess with a palm trunk mid-frame.
- From very far away the island is nearly lost in haze (fog is tuned for street level).
- Dess is almost black at night and against a sunset: no fill light on people.
- The quick-reference card sometimes shows half-faded; the district stamp can be stale after a teleport.
- The cannery ramp straddles a curb, so one half sits 0.16 m higher.
- Some Gull Heights yard details have no collision; the "BRIDGE OUT" sign overlaps a signal pole.
- The JS bundle is one 800 kB chunk. Nothing has been measured on a real phone.
- Not exercised: gamepad, pointer lock, real touch hardware, death and respawn in the full game.

### How to work on this without wasting the owner's credit

The owner's plan has a 5-hour usage window, and it is the real constraint. Two
runs died to it: a dozen agents at once emptied the window in about 20 minutes
and killed everything in flight. What worked:
- Tell every builder to get a complete first version onto disk early, then improve it in place. A cut-off then loses little.
- Cap look-and-improve rounds (two) and screenshots (about ten) per agent.
- One integrator with a fresh context, after the builders, is cheap and effective.
- Commit and push after every stage, even when the tree does not build: before the switch-over that was harmless; now use a branch or keep `main` building.
- Do not run later-milestone work alongside the current milestone: it competes for the same window.

### Deployment

Every push to any branch runs `.github/workflows/deploy.yml`: `npm ci`,
`npm run build`, publish `dist/`. If the build fails nothing is deployed and the
site keeps the last good build, so **`main` must always pass `npm run build`**.
GitHub Pages is set to deploy from GitHub Actions (it was "deploy from branch"
until the switch-over, which would have served the raw source page). The custom
domain comes from the Pages setting and from `public/CNAME`.

## Tech decisions

- TypeScript (strict) + Vite + three.js 0.167. `vite.config.ts` uses `base: './'`.
- No physics library: custom arcade physics. No external art or audio: everything is procedural (canvas textures, WebAudio).
- Fonts are installed from npm and bundled: `@fontsource/big-shoulders-display` (headlines), `@fontsource/barlow-semi-condensed` (text), `@fontsource/ibm-plex-mono` (numbers). Import only the `latin-*.css` files. Await `document.fonts.load(...)` before drawing sign textures.
- Variable time step clamped to 0.05 s; vehicle physics sub-steps at 1/120 s.
- One `Game` object holds every subsystem; subsystems take `game` in their constructor.
- Testing: Playwright 1.64.0 is a dev dependency (pinned to match the Chromium already on the owner's PC; never run `playwright install`), and WebGL runs on the real GPU there. Use `tools/pw.mjs`. Expose `window.__game` with `step(n, dt)`, `teleport`, `setTime`, `setHeat`, `spawnVehicle` so tests can run the simulation without waiting on real time. After each milestone: `npx tsc --noEmit`, `npm run build`, boot the build headless, fail on any console error, look at a screenshot.

## World conventions (already in code)

Meters and seconds, Y up. East = +X, South = +Z. Heading `h`: forward =
`(sin h, 0, cos h)`, right = `(-cos h, 0, sin h)`; turning right *decreases*
`h`. Models face +Z. Traffic drives on the right. Streets are at height 0,
city blocks one curb (0.16) higher, water at -0.8.

## The city

An island about 0.85 mi wide. Districts: Gull Heights (suburbs, north), Ledger
District (downtown towers), Tinker Row (mid-rise, west), Fishbone (old town,
east), The Cannery (industrial, south-west), Saltwater Strand (boardwalk, south),
Dock Seven (container port, south-east), Mercy Park, Flounder Field (arena).
Landmarks: Pelican Pier with a Ferris wheel, Last Light Breakwater and
lighthouse, and the Perpetual Bridge, which climbs north out of town and simply
stops (it is the biggest stunt jump).

## Art direction

Sun-bleached harbor travel poster, not neon. Palette: ink navy `#14213D`, bone
`#F2E8CF`, vermilion `#E4572E`, mustard `#F0A202`, sea teal `#2A9D8F`, plus brick,
terracotta and sage for buildings. Cream sea fog in the mornings, sodium-yellow
street lamps at night. Avoid the usual AI look: no purple gradients, glassy
cards, glow on everything, pill buttons or emoji icons.

HUD is flat and print-like ("Harbor Authority paperwork"): a round radar drawn
as a nautical chart with health and armor as arcs around it; "HEAT" shown as
five beacon pips (not stars); money in mono numerals; district names stamped in
large condensed type; objective text on a navy strip with a vermilion rule.
Original wording for fail states (for example "CLOCKED OUT" and "BOOKED").

## Remaining work, in order (push to `main` after each)

**M1 — First playable (DONE; test-and-polish pass still owed)**
- `world/textures.ts`: canvas textures. Four facade styles (8x8 windows each, color + night-glow map), street and avenue surfaces with lane lines matching the traffic lanes (street lanes at ±1.75 m; avenue lanes at ±1.8 and ±5.2 m), a sign atlas, glow sprite.
- `world/buildings.ts`: per-district generators that fill each lot and register collision boxes: towers, mid-rises with shopfronts, rowhouses, houses with yards, warehouses, container stacks, boardwalk shops.
- `world/world.ts`: terrain mesh from `terrainAt` (drop it 6 cm on land to avoid flicker against roads), roads, crosswalks, sidewalks, lamps with additive light pools, traffic lights (26 s cycle: 10 green, 2.5 yellow, 0.5 all-red per axis, offset by `node.phase`), instanced trees and props, park, arena, pier, lighthouse, bridge, ramps, water shader, `setNight(n)`.
- `world/sky.ts`: sky dome shader (gradient, sun, moon, stars, drifting clouds), sun and hemisphere lights, time-of-day palette, fog, weather (clear, overcast, fog, rain).
- `ent/vehicle.ts`: about ten original vehicle types built from an extruded side profile; physics as designed below; wheels as one instanced mesh.
- `ent/character.ts`: instanced box-limb people (about 13 parts, about 13 draw calls for everyone) with walk, run, jump, swim and knocked-down poses.
- `ent/player.ts`, `core/camera.ts`, `ui/hud.ts` + CSS, `ui/touch.ts`, `core/game.ts`, `main.ts`, title screen.

**M2 — A living city (DONE, first pass):** traffic on lane rails that obeys lights and turns into physical cars when hit; pedestrians on sidewalk loops who cross at lights, flee, and get knocked over; parked cars; particles, skid marks, breakable props (hydrants geyser).

**M3 — Trouble (DONE, first pass):** heat levels 1-5, police on foot and in cruisers using route-finding, roadblocks, a helicopter with a spotlight at high heat, losing them by breaking line of sight, respray shop; weapons (fists, pistol, SMG, shotgun, launcher), aiming, vehicle damage, fire and explosions.

**M4 — Things to do (DONE, first pass, unplayed by hand):** about ten story missions from a small step-based script format (go to, get vehicle, deliver, collect, destroy, lose heat, tail, race, survive, dialogue); taxi fares, street races, courier runs, stunt jumps, 30 hidden golden rubber ducks; shops, money, autosave to `localStorage`, pause menu with full map and settings.

**M5 — Sound (DONE, first pass, unheard):** procedural engine, tires, impacts, sirens, horn, gunshots, sea and gulls, rain; radio stations with generated music.

**M6 — Polish:** bloom at night, quality presets with auto-detect for phones, performance pass, bug bash.

## Vehicle physics design

Split velocity into forward and sideways parts. Engine force falls off toward
top speed; brake key brakes, then reverses. Yaw rate = `-forwardSpeed *
tan(steer) / wheelbase` (steer limit shrinks with speed). Sideways speed decays
by `exp(-grip * dt)`; grip drops to about a quarter with the handbrake and about
half once sliding, which gives drifts. Height: apply gravity, and if the
predicted height is below `groundAt`, snap to the ground and set vertical speed
to the ground-following speed, so ramps launch cars naturally. A sudden rise
over 0.7 m counts as a wall. Car-versus-building uses a rotated-box test with
push-out, bounce, spin and damage; car-versus-car exchanges impulses by mass.

## Story and humor

Lead character: Odessa "Dess" Marlowe, a tow-truck driver whose yard was seized
by the Harbor Authority. Contacts: Barnacle Finch (fence with a bait shop),
Councilwoman Priya Vance, Gus the arcade accountant; rivals: the Gull Syndicate.

Easter eggs to include: a giant rubber duck in the harbor that honks when hit; a
seagull named Gerald who steals pocket change on the pier; a UFO over the
lighthouse at 3 AM; a "Room 404" door on a building with no doorway; typed cheat
words; pun shop signs ("Squid Pro Quo Legal", "Pier Pressure Tattoo", "Gull &
Void Insurance", "Prawn Shop"); a billboard for "WDOOF 99.9 — Radio for
Doofuses"; and a pause-menu stat reading "Mistakes made: 0*".
