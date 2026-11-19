# Brief: the mainland, part 1 — the land, the bridge and the streets

Read tools/briefs/common.md first and follow it.

Also read, in full: PLAN.md "Owner decisions, Nov 18 evening — add-on land and progression";
src/world/plan.ts (the city as data: grid, nodes, edges, blocks, lots, islandSD, terrainAt, groundAt,
decks, BRIDGE, RAMPS, districts, placeName, findPath); src/world/world.ts; and enough of
src/world/ground.ts, landmarks.ts (the Perpetual Bridge and its end ramp), buildings.ts, places.ts,
src/ui/hud.ts (the radar chart), src/sim/traffic.ts and peds.ts to know everything that reads the plan.

THE OWNER'S DECISION: the first add-on land is the mainland to the north, reached by FINISHING the
Perpetual Bridge, and it is themed after Waterville, Maine: a central-Maine mill town on a river.
Players must see slow, continual progression, so the bridge is built span by span as the player earns
progress and the mainland opens in stages.

Research first (briefly): use web search to check Waterville's real layout and character so the town
feels right: the river on the east side with a dam and falls, the big brick mill complex beside it,
the narrow pedestrian suspension footbridge to the sister town across the river, Main Street's brick
commercial blocks, the square and opera house / city hall, the rail yard, the college on its hill to
the west with a white-spired chapel and lawns, the stream and lake to the west, the interstate running
north-south with two exits, triple-decker and clapboard neighbourhoods. Use it as inspiration for
layout and atmosphere. INVENT every name (this is still Port Calamity's world: the mainland town needs
its own dry, slightly absurd name, street names, mill name, college name); do not use real business
names. Send nothing about this project or its owner in any search.

YOU OWN for this task: src/world/plan.ts; new src/world/mainland.ts (data and helpers for the new
land) and src/world/progress.ts (bridge and unlock state); the parts of src/world/landmarks.ts that
build the bridge and its end ramp; src/world/ground.ts where it must change to draw the new terrain,
river, roads, sidewalks and street furniture; small necessary edits to src/ui/hud.ts (radar chart
extent), src/sim/traffic.ts and peds.ts (only if they hard-code the island's extent), and
src/core/game.ts / src/main.ts for registration and test hooks. Buildings and landmarks on the
mainland are part 2 (another brief): leave lots EMPTY but laid out, with districts assigned.

Do it in this order; each step must leave the game booting and the island exactly as playable as
before (run the existing checks: the start view, a drive around the island, traffic still flowing).

1. THE PLAN GROWS. Generalise plan.ts so the world is more than one island without breaking anything
   that reads it. The mainland lies north of the island across a channel a few hundred meters wide;
   its southern shore faces the island and the bridge lands on it. Size: comparable to the island
   (roughly 1.3 km east-west by 1.0 km north-south of town, with countryside fading out beyond). Give
   it a coast (signed-distance like islandSD), gentle relief where it helps the character (the
   riverbank drops to the river; the college sits on a real hill of 12 to 18 m; the rest near-flat so
   the arcade physics and the block slabs keep working: say clearly how groundAt handles the hill,
   and keep groundAt fast, since physics calls it constantly), a RIVER that runs through the east side
   to the channel with a dam and a short falls, and a stream on the west. Extend plan.bounds, placeName,
   districtAt and streetAt. New districts, with invented names: the mill riverfront, downtown Main
   Street, a triple-decker neighbourhood, the college hill, the rail yard, the interstate corridor,
   lake and countryside edge, and the sister town's bank across the river (reachable only by the
   footbridge, on foot).
2. STREETS. A road graph for the town in the same node/edge/block/lot structures (so traffic,
   pedestrians, parking, signals, route-finding and the radar work unchanged): an irregular grid that
   bends with the river (the existing grid generator can be parameterised with an origin, a rotation
   or per-line offsets; streets do not all have to be axis-aligned if the rest of the code can cope,
   but if axis-aligned streets keep every consumer simple, keep them axis-aligned and get the
   irregularity from uneven spacing, removed segments and the river cutting through). One Main Street
   avenue, a riverside mill road, a road up the college hill, a rail line with level crossings
   (decorative track; no trains yet), a road bridge over the river, the interstate as a divided
   avenue on the west with two exits, and a road from the bridge landing into downtown. Blocks and
   lots split as on the island, each lot tagged with its new district.
3. THE BRIDGE, IN STAGES. src/world/progress.ts holds a bridge-completion value (0 = today's stub that
   stops in mid-air, 1 = complete) in whole spans (about 8 to 10 spans across the channel), saved in
   localStorage, with `window.__game` hooks to set it for tests. groundAt, the bridge mesh (deck,
   towers, cables, barriers with collision) and the "BRIDGE OUT" end (ramp, torn rebar, sign) all
   follow it: the broken end and its stunt ramp MOVE outward as spans are added (so the jump stays a
   joke until the very last span), construction dressing sits on the newest span (crane, barriers,
   stacked girders, a Harbor Authority notice), and at completion the ramp goes and the road runs
   through to the mainland landing. Changing the value at runtime rebuilds only what it must.
   For now progress advances by a simple rule that already gives slow continual progression and
   that later systems can feed: each span costs money paid at a "Bridge Completion Fund" collection
   box at the bridge foot (walk up, press the interact key, pay a rising price per span) plus a small
   trickle from play itself (distance driven, jobs done later); show a toast and a small tag when a
   span completes. Expose `progress.add(points)` for missions and activities.
4. DRAW THE LAND. Extend ground.ts so the mainland's terrain, shore, river (reuse the sea shader with a
   flowing river variant; the dam and falls can be a simple textured weir with a foam strip and, if
   src/fx/particles.ts makes it easy, mist), streets, intersections, sidewalks, lamps, signals, trees
   (central-Maine species: white pine, birch, sugar maple: add them to tools/blender/flora.py and
   public/models/flora.glb only if time allows; otherwise reuse the existing species and say so) and
   street furniture are all drawn through the same code paths as the island, chunked so the far land
   costs nothing when you are on the island. The radar chart in hud.ts must show the new land.
5. LIFE REACHES IT. Parked cars, AI traffic and walkers appear on the mainland when the player is
   there (the systems already work in a bubble around the player; fix only what assumes the island).
6. STAGED UNLOCKS. The mainland's districts open in stages after the bridge completes (riverfront
   mills, then downtown, then the college hill, then the interstate and lake), held in progress.ts.
   Until a stage opens, its entry streets are closed by construction barriers with collision and a
   notice; give each stage a point cost fed by the same progress points. Keep it simple and data-driven.

CHECK: with the bridge at 0 the island plays exactly as before (same start view, same numbers of draw
calls and triangles within a few percent when standing on the island); step the bridge through every
span with the hook and screenshot each; drive across the finished bridge onto the mainland and around
every street of the town (a scripted tour: no falling through, no invisible walls, no floating or
buried road pieces, groundAt agrees with what is drawn, including on the hill); AI traffic and walkers
present and flowing there (a 5 minute soak); aerial stills of the whole mainland and the channel with
the bridge at half and at full; the radar chart on both sides; frame cost on the island and on the
mainland at high and with q=low. This task will be followed by part 2 (buildings and landmarks), so
empty lots are expected, but streets, river, hill and shore must look finished.

Report as common.md asks, plus: the town's invented names; a short description of the layout with
coordinates of each district, the bridge landing, the river, dam, footbridge site, mill site, square
and college hill (part 2 builds on exactly these); how groundAt changed and what it costs; the
progress API.
