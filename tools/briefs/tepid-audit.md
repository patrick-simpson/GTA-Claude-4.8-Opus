# Tepid Falls audit (item 19b), diagnosis only

Run Nov 24 against the working tree at that time (other workers were editing, so the lot count moved 660 -> 627 during the run).
No src/ files were edited. Scripts and data are in scratch/audit/ (graph.ts, bld.ts, rail.ts, analyze.py, pois.py, drive.mjs, train.mjs,
play.mjs). Machine-readable: graph.json (all edges and nodes, dead ends, crossings, ramps, controls, all-pairs result), gamebld.json
(lots, campus rects, buildings near rail/road/water, roads in water, rail crossings), density.json, empty_cells.json,
overbuilt_cells.json, builtup_proxy_empty.json, missing_roads.json, game_roads_no_real.json, rail_compare.json, pois.json,
play_points.json, drive*.json, soak.txt.
Overlay picture: **scratch/audit/overlay.png** (zooms: overlay_downtown.png, overlay_campus.png). Game pictures: pic_downtown.png,
pic_rail_campus.png, stuckN_thruway-full.png.

Honest limits: OSM building data for Waterville is sparse (876 footprints fall in the game box; many houses are unmapped), so the "real"
counts are a floor. The warp is the street plan's own thin-plate spline (scratch/streets/tools/warp.py). "Game buildings" are the planned
lots from mainlandLots() plus the campus rects; I did not verify that each is actually built. The autopilot drive test has no obstacle
avoidance, so stalls behind AI cars say little (see item 14).

## Counts

| Category | Count |
|---|---|
| Roads: graph | 208 nodes, 332 edges (172 island), 1 connected component, 2 overpasses, 43 blocks |
| Roads: all-pairs routing (110 mainland nodes, 11,990 pairs) | 109 failures, all to ONE node (205, ramp 318 start); findPath agrees with reachability on 300 samples |
| Roads: dead ends (mainland) | 13 (4 are map-edge stubs, 1 is the unjoined ramp, 2 are near-miss unjoined T junctions) |
| Roads: gaps over 1 m between edge ends and nodes | 0 |
| Roads: overlapping (same two nodes) edge pairs | 9 |
| Roads: crossings without junction or overpass | 0 (only the 2 listed overpasses) |
| Roads: metres in water | 4 edges, 216 m (Tuition Ave 108, Trestle St 72 = its bridge, Far Bank Rd 24, Second Thought Ave 12) |
| Roads: real roads not in the game | major 24% of 27.5 km, local 70% of 44 km (more than 25 m from a game edge) |
| Roads: game roads with no real road within 40 m | 1 (Front St edge 227, 60 m) |
| Rail: crossings | 7, derived from the graph so they match exactly |
| Rail: planned lots overlapping the track corridor | 5 |
| Buildings: on roads / water / coast | 0 / 0 / 0 |
| Buildings: 100 m cells with 250 m+ of real street and no game lot | 55 (builtup_proxy_empty.json); 32 cells with 6+ real buildings and almost none in game |
| POIs: named, in game area | 396 (shop 115, amenity 170, leisure 67, office 22, tourism 21, craft 1); 62 on a game building, 99 within 30 m of one, 36 on a road, 199 on empty ground |
| Behaviour: soak (5 min, 4 places) | 0 stuck, 8 cars removed as stuck, 1 car off-road, 1 AI hit, 0 red-light or stop runs |

## Top 15 defects

### Roads
1. **Exit 127 ramp 318 is not joined to the Thruway** (edge 318, road ramp_127_43139502, node 205 at (-727.0, -1542.7)). Its start is 10.5 m from Thruway edge 175 and the build's snap radius is 8 m, so the one-way ramp has no way in. It is the only routing failure in all 11,990 pairs, and mission t03 checkpoint 2 at (-715, -1600) sits on it, unreachable by routing. Fix: join node 205 to Thruway edge 175 (move the start 10.5 m or raise SNAP for ramps to 12). Evidence: graph.json (ramps, oneWayTraps), play_points.json.
2. **Tuition Ave runs 108 m through the river** (edge 212, from (412.5,-2908.7) toward (262,-2733); first wet point (347,-2829)). Cars and walkers go into water. Fix: reroute the north end east of the river, add a bridge deck, or drop the road north of z -2733 (the real counterpart is Hazelwood/Drummond Ave). Evidence: graph.json roadsInWater, overlay.png (pink line over the hatched river, top right).
3. **Main St's south end is not joined to Trestle St** (edge 194, a 9.1 m stub, end node 124 at (70,-1624.3), 8.4 m from Trestle St edge 230). Downtown's main street dead-ends beside the bridge approach; real Main St meets Spring St there. Fix: snap its end onto Trestle St (T junction, signal). Evidence: graph.json nearMiss.
4. **Nine overlapping edge pairs between the same two nodes**: Upriver Rd 237/240 and 238/241, Cherry Tree St 257/260 and 258/261, Waiting Room Pkwy 283/285, Bagpipe Ave 314/317, Drifting West Ave 245 with Halfway Rangeway 264, Main St 203 with Passable St 266 (at (74.5,-2285)), Front St 228 with Water St 328 ((170,-1628)). Probable doubled road meshes (z-fighting), doubled parking and rails, and traffic choosing between near-identical edges. Fix: drop the duplicate plan roads (the _1 pieces) or make them different. Evidence: graph.json parallel (geometry not yet viewed in game).
5. **Dead ends that are neither map edges nor known real cul-de-sacs**: Porch St (edge 274, ends (36,-1520), 77 m short of Dutch Elm St's node at (-41,-1518); 288 m long), Offramp Rd (edge 243, (-568,-1048), 223 m, runs to the south coast), Blockhouse Rd (edge 242, (782,-1353), 382 m), Depot St (edge 305, (-2.3,-2907.6)), Acorn St (edge 308, (170.9,-2487.6)), Bagpipe Ave (edge 312, (144.6,-2896.6)), Far Bank Rd (edge 236, (524.4,-1216.7)). The Thruway has stubs at both ends ((-707.7,-1043.7), 27.8 m; and (-70.8,-2909.4)); the soak found a taxi 6 m off-road at (-61,-2920). Fix: join the first three to a neighbour (real Waterville has through streets there) and cap map-edge roads with a barrier and turnaround. Evidence: graph.json deadEnds.
6. **Interchange congestion**: the 5-minute soak removed 4 stuck cars at exit 127 and 4 at exit 130 ("stop n114 e244" repeated; exit 127 also 1 AI hit and 12 merges). Zero stuck downtown and at the circle. Fix: look at node 114 (stop control, Offramp Rd edge 244 at Second Thought Ave) and the stop-controlled ramp merges at both interchanges. Evidence: soak.txt.
7. **Real road network missing** (missing_roads.json). Major roads absent: Benton Ave 620 m, First Rangeway 537, Clinton Ave 474, Pleasant St 418, Country Club Rd 404, China Rd 370, Lincoln St 313, Front St (north part) 313, Augusta Rd 281, Silver St 262, Cushman Rd 259, Water St 185, and the real I-95 beyond the north end (872 m). 70% of real local street length is absent: the South End and West End are four long parallel arterials with lot rows and no cross streets. Fix: add cross streets on the infill zones' grid (plan grid_m 90-110), or at least every 100 m along Tarnish St, Halfway Rangeway, Room Temperature St and Drifting West Ave.
8. **Signals**: 16 signal nodes, 75 stop nodes, 2 roundabouts, no uncontrolled junction. Stop-only where three or more arterials meet: (70,-1767) Main/Tarnish/Bobbin, (15,-1767), (-20,-1714.8), (-41.3,-1518.5), (71.8,-2195.8) Main/Due North, (234.6,-2273.5) Tuition/Front, (170,-1617.5) Front/Trestle/Water. The plan lists about 22 OSM signals; downtown Main St crossings are the obvious candidates. Also the Upriver Rd junction (636,-2163) is stop-controlled 11 m from the rail crossing at x 624.9 (queues spill onto the track).

### Rail
9. **The railway does not follow the real line.** The game track is a straight east-west line at z -2150 from x -640 to 640. Real Waterville's line runs north-south along the river's west bank (yard at about x 330-500, z -2900..-2300; crossing at about (440,-1590); black lines on overlay.png): 46 of 65 sample points on the game line are over 60 m from any real track (rail_compare.json). It crosses seven streets (Cherry Tree St x -589.9, Chapel Hill Rd -366.9, Passable St 37.8, Main St 70.5, Tuition Ave 119.8, Front St 230.7, Upriver Rd 624.9), cuts across the south of the campus (pic_rail_campus.png), and the far-bank spur (ends (530,-2430)) goes nowhere (91.7 m from the nearest road). Fix (large): lay the line on the warped OSM track (rail_compare.json has the polylines in game coordinates); crossings follow automatically (train.ts findCrossings). Minimum: keep the line, fix item 10.
10. **Five planned lots sit on the track corridor** (|z+2150| under 3): college lots at (-611,-2149), (-569,-2154), (-390,-2151), (-334,-2140) and a Main St lot at (3,-2134) (gamebld.json bad.onRail). Not verified as built. Fix: add the rail corridor (9 m half-width) to RESERVED in mainlandBuildings.ts. Tuition Ave also crosses the line obliquely (36 m along the track, edge 215 at x 119.8).

### Buildings
11. **Far bank / Winslow is empty**: 4 game lots against 278 real footprints (including the real mill complex, a block of about 20 buildings at x 400-520, z -2380..-2130) and 57 POIs (55 on empty ground). Fix: infill zone for the far bank (Clinton Ave / Benton Ave area) and the mill at its warped spot.
12. **South End and West End are over-built in strips where the real town is a grid**: 125 and 120 game lots against 20 and 14 real footprints (OSM is sparse), as single-file rows 300-800 m long along four arterials, plus a 30-lot straight row along Water St (x 130-160, z -1580..-1130) that sits over real-map ponds (check). overbuilt_cells.json: 12 cells with 8-10 game lots and 0-1 real. Fix: cross streets (item 7) and thinner strips.
13. **Under-built districts versus OSM** (table below). Largest holes: Strip + exit 127 (22 game vs 96 real), North End (9 vs 46), Upper Main + exit 130 (10 vs 24), downtown side blocks (36 vs 91; Main St itself looks right in pic_downtown.png; cell (120,-1880) 4 vs 16, cell (40,-1720) 2 vs 14). Fix: infill lots behind the Main St rows, the Kennedy Memorial Drive strip and the North End grid.

| District | Real footprints | Game lots | Real cover % | Game cover % |
|---|---|---|---|---|
| Downtown Main St (x -30..300, z -2120..-1630) | 91 | 36 | 12.8 | 13.3 |
| South End / The Stacks | 20 | 125 | 2.3 | 25.9 |
| Mills + Water St (x 170..300, z -1620..-1100) | 3 | 0 | 2.3 | 0.0 |
| West End | 14 | 120 | 1.2 | 17.4 |
| North End | 46 | 9 | 6.3 | 8.0 |
| Mayflower Hill houses | 6 | 8 | 0.5 | 15.8 |
| Campus (Dithers) (x -640..-300, z -2700..-2280) | 90 | 157 | 5.6 | 17.7 |
| Strip + exit 127 (x -820..-480, z -1450..-1000) | 96 | 22 | 4.0 | 4.6 |
| Upper Main + exit 130 (z < -2700, x -300..200) | 24 | 10 | 1.8 | 2.0 |
| Far bank / Winslow (x > 380) | 278 | 4 | 3.9 | 1.0 |
| Island-side bridge landing (x -80..20, z -1100..-950) | 0 | 0 | 0.0 | 0.0 |

Nothing stands on a road, on water or in the sea (0 of 627 lots + 128 campus rects), measured to the road's paved edge.

### Behaviour
14. **Thruway: autopilot stalls with damage** in the first 12 m of the south end ((-711,-1083)), at (-88,-2883) by exit 130 and at (-718,-1293) at exit 127's overpass, even with AI cars cleared and a 6 m offset to the right carriageway (hp falls to 92-97). stuckN_thruway-full.png shows a median wall ending mid-road at the south stub. Could be the median wall against the lane line or the autopilot; needs a human drive. All other routes (bridge to downtown 1.1 km, Main St south to exit 130 1.3 km, campus loop, Dithers to the landing 2 km, Trestle St to the far bank, Upriver Rd, Tuition Ave, Water St) drove end to end with traffic cleared (drive_noai.json). With traffic present the no-avoidance autopilot stalled on 9 of 11: not a game fault.
15. **Missions, races, chase, train**. 72 mission and giver points checked (play_points.json), 4 flagged: t03 checkpoint 2 (-715,-1600) unreachable (item 1); m03 step 3 (314,262) and m09 item 3 (316,230) are island points 3.5 and 10.5 m into water; m08 step 7 (135,-150) is 55 m from any road. Race checkpoints were NOT checked (my script could not find the races list); the Loop's own points (70,-1640), (70,-1955), (166,-1975), (170,-1625) lie on Main St, Applejack St and Front/Water St. Police chase works: at heat 4, 4 cruisers appear in 9 s and reach the player in 19 s; heat cooled by 49 s. Train: the scheduled run over 24 game hours goes x -521..600 with dwells at both ends (passenger 0-5, freight after); driven from the cab it ran -278 to 659 at up to 22 m/s, hit 6 things at crossings and derailed at the east buffer (659,-2143) as designed; the trestle meets terrain (deck 5.15 over ground 5.0, banks falling to 1.5 m within 20 m, river 36 m either side under a 128 m deck). Walking downtown was checked only by picture (pic_downtown.png: blocks and city hall present); no pedestrian soak was run.

## Also found
- Reachability from the landing by stage: stages 0-3 reach every open node; stage 4 fails only on node 205 (item 1).
- Bridge edge 331 joins Landing Rd (-30,-1072) to the island at (-30,-430).
- Downtown (pic_downtown.png) reads well: brick rows, city hall and clock tower, signs.

## Businesses and navigation

Owner test: "pick a business in Waterville and locate it by navigation on the map".

1. **POIs in the game area** (OSM, named, warped with the street plan's spline; pois.json, real names stay in scratch only): 396. By tag: amenity 170 (restaurant 31, fast_food 23, place_of_worship 15, parking 11, fuel 8, bank 7), shop 115 (car 14, convenience 9, supermarket 7), leisure 67 (park 26, pitch 25), office 22 (research 11), tourism 21, craft 1.
2. **Where they land**: on a game building 62 (16%), within 30 m of one 99 (25%), on a road 36 (9%), on empty ground 199 (50%).
3. **By district (game lots / POIs: on building, near, on road, empty)**: Downtown 36 / 49: 12, 15, 9, 13. Campus 157 / 58: 22, 28, 0, 8. Strip + exit 127 22 / 44: 2, 6, 6, 30. Upper Main + exit 130 10 / 34: 6, 13, 4, 11. Far bank 4 / 57: 0, 0, 2, 55. South End 181 / 15: 6, 3, 2, 4. West End 138 / 9: 3, 2, 1, 3. North End 15 / 35: 3, 5, 7, 20. Mills 0 / 3. Buildings but almost no POIs: South End and West End (about 320 lots, 24 POIs; residential). POIs but no buildings: Far bank, the strip, the North End.
4. **What the map offers now** (src/ui/menu.ts chart, src/game/index.ts): street name labels from zoom 0.55, badges for work givers, races (R), jumps (J) and yards (Y), a waypoint set by clicking (click again clears it), and a route line along the streets from the player to the waypoint or mission target (plan.findPath between nearest nodes, then a straight line to the point). The radar shows the same badges. There is no business layer, no search, no list, and no route to a business. To pass the owner's test: a business layer from pois.json (punned names), a search box and list on the chart, "go there" sets the waypoint, put each business's door on a game building (move the 199 empty-ground POIs to the nearest lot frontage, or grow lots there), and route to the door's street frontage.
5. **LiDAR and building heights**: USGS 3DEP covers Waterville. The National Map Access API (https://tnmaccess.nationalmap.gov/api/v1/products) returns 30 point-cloud tiles for a box around the town (project ME_Maine_LiDAR_NRCS_14, LAS, e.g. tile 19TDK470320) and 1 m bare-earth DEM tiles (ME_MidCentral_B23). USGS data is public domain. Building heights: download the LAS tiles for the box, take class 6 (building) returns with PDAL or laspy, subtract the 1 m DEM, and take the 90th percentile inside each OSM footprint; or use first-return DSM minus DEM. Check that the project's metadata carries class 6 before relying on it.
