# Brief: the mainland, part 2 — buildings and landmarks of Tepid Falls

Read tools/briefs/common.md first and follow it.

Part 1 built the land: the town of TEPID FALLS on the mainland north of the island, themed after
Waterville, Maine (a central-Maine mill town on a river), reached over the Perpetual Bridge, which is
built span by span (src/world/progress.ts). Its streets, river, dam, hill, rail line, footbridge deck,
lamps, trees and traffic exist; every lot is EMPTY. Read PLAN.md "The mainland, part 1" and "Owner
decisions, Nov 18 evening", then src/world/mainland.ts in full (SITES, EXTRA_LOTS, HILL, RAIL, DECKS,
mCell, waterLevelAt), the mainland parts of src/world/plan.ts (plan.mainlandLots, land, blockAt,
blockAtPoint), and src/world/buildings.ts, places.ts and landmarks.ts as the pattern (Batch/Chunked,
shared CityMaterials, sign atlas, collision boxes, WorldPart).

To see the mainland in tests boot with the query `bridge=8&stage=4` (or `__game.bridge(8);
__game.stage(4)`), then for example `g.teleport(70, -1450, 3.14)` (Main St). Everything on Dithers
Hill must sit at groundAt() height.

LAYOUT (meters, north is -Z; the town plateau is at y = 5, blocks one curb higher):
- Shore about z = -980 with a 30 m bluff; bridge lands at x = -30, z = -1056; connector to Front St.
- North-south streets, west to east (x = -700, -590, -480, -350, -240, -130, -30, 70, 170, 470, 580):
  The Thruway, Offramp Rd, Chapel Hill Rd, Birch St, Porch St, Triple St, Landing Rd, Main St,
  Water St, Far Bank Rd, Upriver Rd. Avenues: The Thruway, Landing Rd, Main St.
- East-west streets, north to south (z = -2060, -1955, -1840, -1735, -1620, -1505, -1400, -1295,
  -1180, -1080): Town Line Rd, Depot St, Sidetrack St, Trestle St, Spindle St, Bobbin St, Quorum St,
  Second Thought Ave (avenue), Shirttail St, Front St.
- Muddle River: centerline x = 340 + 30*sin((z + 1100)/210), half-width 36, banks 22 m. Threadbare
  Dam and falls at z = -1570. Road bridge on Trestle St (z = -1735). Exact Change Footbridge at
  z = -1345, x 250..376, 2.8 m wide. Rail: one track at z = -1897 with a trestle over the river.
- Mill site: three lots, x 180..248, z -1565..-1200, between Water St and the river.
- Quorum Square: block x -20..60, z -1499..-1406, grass, no lots.
- Dithers Hill (college): footprint x -680..-370, z -1820..-1525, 12 m high, flat top about
  x -580..-470, z -1720..-1625.
- The Thruway at x = -700 with a divider; exits at Depot St and Second Thought Ave.
- Lake Indecision centered (-830, -2110); Afterthought Stream at x about -800.
- Lesser Tepid: east of the river, 12 house lots either side of a footpath at z = -1345; blockhouse
  lot ("Fort Reluctance") x 380..440, z -1478..-1425.
- District keys: mill (Loom Row), main (Lower Main), square (Quorum Square), stacks (The Stacks),
  college (Dithers Hill), yard (Sidetrack Yard), exits (The Exits), lake (Indecision Township),
  sister (Lesser Tepid). Lot counts: stacks 558, main 133, exits 44, mill 23, yard 21, sister 13,
  college 9.

YOU OWN: new src/world/mainlandBuildings.ts (everything on plan.mainlandLots and EXTRA_LOTS) and new
src/world/mainlandPlaces.ts (landmarks and dressing), their registration lines in src/world/world.ts,
and append-only additions to src/world/textures.ts and materials.ts (new facade or kit textures, new
signs). The look is realistic (PLAN.md), physically based materials, not flat or low-poly: real depth
on facades (recessed windows, sills, cornices, storefront bays, porches as geometry where it is cheap).
Keep the far land free when the player is on the island (chunked meshes; nothing per-frame).

Do it in this order, each step verified before the next:

1. LOWER MAIN (district main). Two- to four-storey brick commercial blocks wall to wall along Main St
   and the cross streets, in the manner of a New England Main Street: arched or flat-lintel upper
   windows, corbelled brick cornices, cast-iron and glass storefronts with recessed doors and signs
   above, a few painted "ghost signs" on side walls, awnings, the odd gap with a parking lot. Shop
   names invented, in the game's dry humour, with a Maine small-town flavour (a diner, a hardware
   store, a bookshop, a bank in a granite temple front, a movie house with a marquee, a bakery, a
   laundromat). Never the same sign twice on a block; never mirrored.
2. THE STACKS (district stacks, the big one: 558 lots). Wooden triple-deckers with stacked front
   porches and exterior stairs, clapboard two-storey houses with gables and porches, the occasional
   corner store, church with a white steeple, and school; narrow lots, driveways, sheds, picket and
   chain-link fences, yards. It must be CHEAP: build a small set of house models once and instance or
   batch them with variation in colour (weathered whites, greys, barn red, mustard, sage), trim and
   mirror, so 558 lots cost a few draw calls and well under 400k triangles in total, with collision
   boxes for every house.
3. LOOM ROW (district mill) and the mill site. The showpiece: a long five-storey red-brick textile
   mill beside the river with rows of tall segmental-arched windows, a stair tower with a clock and a
   mansard cap, a tall square brick smokestack with the mill's invented name lettered down it, a
   lower weave shed with a sawtooth roof, a headrace canal and a penstock at the dam, loading docks,
   a railed river walk. Smaller brick mill buildings, a boiler house, worker tenement rows on the
   blocks around it.
4. LANDMARKS (mainlandPlaces.ts). Quorum Square with a bandstand, a soldier's monument, benches and
   paths, and on its edge the city hall / opera house (brick, tall arched windows, a clock tower, the
   name invented); the Exact Change Footbridge as a real narrow wire-suspension footbridge with two
   towers, cables, hangers and a plank deck exactly on the existing deck height, with a toll hut and a
   sign demanding two cents; Dithers College on the hilltop: a red-brick Georgian chapel or library
   with a tall white spire that can be seen from across town and from the bridge, two or three brick
   halls around a lawn with crossing paths, a gate; the rail depot (a low hipped-roof station with a
   wide overhanging canopy) with freight cars on the sidings and a water tower; the Thruway's exit
   signs, overpass-style gantries and a truck stop with a tall sign at one exit; Fort Reluctance, a
   two-storey timber blockhouse with an overhanging upper floor, in Lesser Tepid, plus its dozen
   houses; a boat ramp and camps (small cottages) on Lake Indecision; a welcome sign at the bridge
   landing ("TEPID FALLS — incorporated, eventually" or better).
5. ONE NEW EASTER EGG of your own that fits the town, findable but not announced; describe it in the
   report.

Register collision for everything solid. Honour game.quality (low keeps simpler geometry and no extra
normal maps). Budget for the whole of part 2 when standing on Main St: under about 110 added draw
calls and 700k added triangles at high, and nothing added to the frame when standing on the island
beyond what distance culling leaves visible across the channel.

CHECK: eye-level stills of Main St, a Stacks street, the mill from the river walk and from the road
bridge, the square and opera house, the footbridge, the college lawn and the spire seen from the
bridge landing, the depot, a Thruway exit, Fort Reluctance, the lake; an aerial of the whole town;
night versions of Main St and the mill (window glow); a drive down Main St and a walk into a porch and
a storefront to check collision; draw calls, triangles and ms per frame on Main St, in The Stacks and
back on the island at high and with q=low, before and after.
