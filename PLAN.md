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

## Where things stand (about 10% done)

Written and type-checking clean (`npx tsc --noEmit`):

| File | What it is |
| --- | --- |
| `src/core/util.ts` | Math helpers, seeded random numbers, and the world conventions (read its header first) |
| `src/core/input.ts` | Keyboard, mouse, gamepad and touch feeding one action map |
| `src/world/plan.ts` | The city as data: street grid, intersections, blocks, lots, parking spots, island shape, ground height (`groundAt`), ramps, pier, breakwater, unfinished bridge, route-finding |
| `src/world/collide.ts` | Static collision: building boxes and street-prop circles in a grid, with push-out, ray casts and line of sight |
| `src/world/batch.ts` | Merges thousands of boxes and quads into a few big meshes, split into chunks |

Not started: everything in "Remaining work" below. There is no `src/main.ts`
and no new page yet.

### The live site is deliberately untouched

`index.html` and `.github/workflows/deploy.yml` are still the **old prototype**
(a self-contained page; the workflow just copies it). Every push to any branch
redeploys to gtaopus.doofus.live, so they stay as they are until the new game is
playable. At the first playable milestone, in one commit:

1. Replace `index.html` with the Vite entry page (`<canvas id="c">`, HUD root, `<script type="module" src="/src/main.ts">`).
2. Move `CNAME` to `public/CNAME` so the build copies it.
3. Change the deploy job steps to: `actions/checkout@v4`, `actions/setup-node@v4` (node 22, `cache: npm`), `npm ci`, `npm run build`, `actions/upload-pages-artifact@v3` with `path: dist`, `actions/deploy-pages@v4`. Keep the triggers and permissions as they are.
4. Run `npm run build` locally and smoke-test `dist` before pushing.

## Tech decisions

- TypeScript (strict) + Vite + three.js 0.167. `vite.config.ts` uses `base: './'`.
- No physics library: custom arcade physics. No external art or audio: everything is procedural (canvas textures, WebAudio).
- Fonts are installed from npm and bundled: `@fontsource/big-shoulders-display` (headlines), `@fontsource/barlow-semi-condensed` (text), `@fontsource/ibm-plex-mono` (numbers). Import only the `latin-*.css` files. Await `document.fonts.load(...)` before drawing sign textures.
- Variable time step clamped to 0.05 s; vehicle physics sub-steps at 1/120 s.
- One `Game` object holds every subsystem; subsystems take `game` in their constructor.
- Testing: Playwright and headless Chromium are preinstalled (`require('playwright')`), and WebGL works there. Expose `window.__game` with `step(n, dt)`, `teleport`, `setTime`, `setHeat`, `spawnVehicle` so tests can run the simulation without waiting on real time. After each milestone: `npx tsc --noEmit`, `npm run build`, boot the build headless, fail on any console error, look at a screenshot.

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

**M1 — First playable (then switch the live site over)**
- `world/textures.ts`: canvas textures. Four facade styles (8x8 windows each, color + night-glow map), street and avenue surfaces with lane lines matching the traffic lanes (street lanes at ±1.75 m; avenue lanes at ±1.8 and ±5.2 m), a sign atlas, glow sprite.
- `world/buildings.ts`: per-district generators that fill each lot and register collision boxes: towers, mid-rises with shopfronts, rowhouses, houses with yards, warehouses, container stacks, boardwalk shops.
- `world/world.ts`: terrain mesh from `terrainAt` (drop it 6 cm on land to avoid flicker against roads), roads, crosswalks, sidewalks, lamps with additive light pools, traffic lights (26 s cycle: 10 green, 2.5 yellow, 0.5 all-red per axis, offset by `node.phase`), instanced trees and props, park, arena, pier, lighthouse, bridge, ramps, water shader, `setNight(n)`.
- `world/sky.ts`: sky dome shader (gradient, sun, moon, stars, drifting clouds), sun and hemisphere lights, time-of-day palette, fog, weather (clear, overcast, fog, rain).
- `ent/vehicle.ts`: about ten original vehicle types built from an extruded side profile; physics as designed below; wheels as one instanced mesh.
- `ent/character.ts`: instanced box-limb people (about 13 parts, about 13 draw calls for everyone) with walk, run, jump, swim and knocked-down poses.
- `ent/player.ts`, `core/camera.ts`, `ui/hud.ts` + CSS, `ui/touch.ts`, `core/game.ts`, `main.ts`, title screen.

**M2 — A living city:** traffic on lane rails that obeys lights and turns into physical cars when hit; pedestrians on sidewalk loops who cross at lights, flee, and get knocked over; parked cars; particles, skid marks, breakable props (hydrants geyser).

**M3 — Trouble:** heat levels 1-5, police on foot and in cruisers using route-finding, roadblocks, a helicopter with a spotlight at high heat, losing them by breaking line of sight, respray shop; weapons (fists, pistol, SMG, shotgun, launcher), aiming, vehicle damage, fire and explosions.

**M4 — Things to do:** about ten story missions from a small step-based script format (go to, get vehicle, deliver, collect, destroy, lose heat, tail, race, survive, dialogue); taxi fares, street races, courier runs, stunt jumps, 30 hidden golden rubber ducks; shops, money, autosave to `localStorage`, pause menu with full map and settings.

**M5 — Sound:** procedural engine, tires, impacts, sirens, horn, gunshots, sea and gulls, rain; radio stations with generated music.

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
