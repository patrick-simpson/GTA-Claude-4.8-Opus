# Brief: Tepid Falls' streets and traffic in the shape of real Waterville (owner, Nov 23)

Owner: "Does the traffic flow in general shape of Waterville match reality? It should."
Today it does not: Tepid Falls (src/world/mainland*.ts, plan.ts) was laid out before the Waterville
likeness was asked for, and the units since then mapped real places onto the EXISTING grid (see
tools/briefs/tepid-reference.md: Main St kept, Kennedy Memorial Drive mapped onto Second Thought Ave,
I-95 onto The Thruway at x -700). The general shape of the road network and traffic flow must match
real Waterville.

Do: trace real Waterville's road network from OpenStreetMap and satellite views (in headed Chrome on
the laptop; nothing copied into the repo) and re-lay the mainland's streets to match its general shape
and flow, scaled to the space: the Kennebec on the east side (the river already runs there), downtown
Main St and Front St and Water St, The Concourse lot, Elm St, Silver St, College Ave running north,
Upper/Lower Main, Kennedy Memorial Drive west to I-95 with its two interchanges (exits 127 and 130),
I-95 itself north-south on the west, Mayflower Hill Drive up to the college, the bridges across to the
Winslow side (Ticonic Bridge with Route 201), the one-way and two-way streets, signalled
intersections and roundabouts where Waterville has them, and the main routes traffic actually uses.
Keep invented names (the existing pun names, mapped to the real roads; add new pun names for new ones).

The buildings already placed must come along: Main St's blocks (mainStreetAssets.ts), the riverfront
mill, footbridge and Holding Pattern lot (riverfrontAssets.ts), Pardon's on the strip (pardonsSite.ts,
which must stay at the real store's place on Kennedy Memorial Drive by the I-95 interchange), the
churches and civic buildings (being built now in the Blender lane: coordinate), the moose crossing
places and signs (src/world/moose.ts), cannons (launchers.ts river and fort sites), the flood reach
(flood.ts), the bridge from the island (it lands where it lands; join it sensibly), and the
progression stages (src/world/progress.ts opens the mainland in stages). Traffic rails, signals,
parking, pedestrians' walks, collision, the radar and the pause map all follow the new streets.
Multiplayer: the map is static and the same for every browser; the host-run traffic must use the new
rails (check src/net/shared.ts and cars.ts key traffic by rail/edge ids).
This is big: split it into a first unit that produces the new street plan as data plus a picture of
it overlaid on the real map for the lead to check BEFORE rebuilding, then the rebuild.

## Step 1 done (Nov 23): the plan is tools/briefs/tepid-streets-plan.json (pictures in scratch/streets/)
Owner decisions on it: (1) "Yes, real layout": downtown moves ~560 m north above the dam, arrival is the
South End by the mills, diagonals and the I-95 curve kept; (2) The Holding Pattern moves WEST of Main St
to the real Concourse's place (option B in the plan). Lead decision: the exit 127 ramps clash with
Pardon's lot: move the Thruway ~35 m west through the exit (Pardon's stays at its real place).
Step 2, about six units in order: (1) plan graph with angled/curved edges from the JSON (plan.ts;
island untouched and first in the lists); (2) ground meshes along polylines, junction pads,
roundabouts, bridges; (3) traffic on polylines, signals, roundabouts, adoption in multiplayer;
(4) move the assets (Main St rows, Quorum Square and civic buildings, footbridge, road bridge, rail,
depot, Holding Pattern to the west, college hill site); (5) radar, map, parking, pedestrians, police,
moose places, flood reach, snowbanks, activities; (6) per-road stages, protocol version bump (edge ids
change), full checks. Each unit leaves the game working (use a switch such as ?streets=old until unit 6
makes the new plan the default).
