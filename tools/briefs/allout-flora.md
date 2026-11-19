# Brief: go all out on the trees, plants and street furniture

Read tools/briefs/common.md first and follow it. Its tool-call and image limits are raised for this
task (about 130 tool calls, 36 images); its other rules stand.

The owner has said: "Go all out on these Blender models." Read PLAN.md "Realistic rework, step (d)",
then tools/blender/flora.py, src/world/floraAssets.ts and the TreeField and street-furniture code in
src/world/ground.ts. Blender 5.2 is at "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"
(headless; probe its API before relying on an operator). Other engineers are working on the mainland
buildings (src/world/mainland*.ts, textures.ts, materials.ts, world.ts), the cars and the people:
touch none of those files.

YOU OWN: tools/blender/flora.py, a new tools/blender/props.py, public/models/flora*.glb and
props*.glb (plus any texture files they need), src/world/floraAssets.ts, a new
src/world/propAssets.ts if you want one, and the tree and street-furniture drawing code in
src/world/ground.ts.

Known weaknesses today: leaf cards read as cards within 5 m; one model per species, so rows repeat;
the cypress has a ragged foot and stands in for pine; tree shadows are not dappled; trees cost
2-4 ms in tree-heavy views; street furniture was rebuilt in code and most of it (hydrant, mailbox,
bin, post, news box, palm) was never inspected close up.

Do it in this order, each step exported, loaded and seen in the game before the next:

1. TREES THAT HOLD UP CLOSE. Real branching structure (trunk, scaffold limbs, secondary branches,
   twigs) with bark that has depth (baked normal map, root flare at the base), and foliage built from
   small branch-tip cards painted or baked from actual leaf geometry of the right species (leaf shape,
   veins, translucency mask), layered so the crown has depth and gaps, not a shell. Three to four
   variants per species so rows do not repeat, with per-instance scale, lean and tint.
2. THE SPECIES LIST. Island: London plane, maple, oak, Mediterranean cypress, palms (two kinds: a tall
   fan or coconut-style and a shorter date-style, with real frond geometry and a ringed, tapering
   trunk with old frond bases), a flowering street tree, shrubs, clipped and loose hedges, beach grass.
   Mainland (Tepid Falls, a central-Maine mill town): eastern white pine, paper birch (white peeling
   bark), sugar maple, red oak, spruce, and an elm for the square; plus an autumn-colour tint option
   for the maples and birches that the mainland uses. Place the mainland species on the mainland's
   trees (plan nodes, edges and blocks carry `land`: 1 = mainland) and keep the island's on the island.
3. LIGHT. Leaves that glow when backlit by a low sun, correct two-sided shading, no shimmer at
   distance, and dappled shadows on the ground under trees (shadow-casting leaf cards with
   alpha-tested depth, tuned so the shadow pass stays cheap; say what it costs).
4. LEVELS OF DETAIL AND COST. Near (about 6-10k triangles), middle (about 1.5-2.5k), far (an impostor
   of crossed or octahedral cards baked in Blender from the near model), switched by distance with
   hysteresis and no visible pop. The park and Gull Heights must end up CHEAPER than today at high,
   and unchanged or cheaper on the phone preset: cut leaf-card overdraw first. Measure before and after.
5. GROUND COVER AND SMALL PLANTS. Grass tufts, wildflowers, ferns, reeds at the pond, river and lake
   edges, ivy on a few walls, flower beds with real blooms, potted plants and planters downtown,
   fallen leaves under mainland trees.
6. STREET FURNITURE IN BLENDER (props.py). Remodel properly, with bevels, bolts, seams, wear and baked
   normal and AO: street lamp (the island's swan-neck cobra head and a different, older cast-iron
   post-top lamp for Tepid Falls), traffic signal mast with hooded heads and visors, pedestrian
   signal, fire hydrant, litter bin, mailbox, bench (slatted with iron ends), bus shelter, news box,
   parking meter, bollard, bike rack, manhole and drain covers, stop sign and street-name blades,
   utility pole with crossarms, insulators and sagging wires for the mainland streets. Keep instancing,
   slots, the breakable and `hard` shear behaviour, the lamp head positions the light pools rely on,
   and distance cut-offs. Two levels of detail each.

CHECK: Blender render sheets per species and prop; in the game, close-ups at 2 m and 10 m of each tree
species and each prop, Mercy Park and a Gull Heights street by day, at a low evening sun (backlit
leaves and long dappled shadows) and at night under lamps, a mainland street (`?bridge=8&stage=4`,
`g.teleport(-240, -1350, 0)`), the pond edge; drive through a hydrant, a bin and a lamp to confirm
they still break and shear; numbers before and after at high and with q=low in the park, Gull
Heights, downtown and on the mainland (draw calls, triangles, ms per frame), and the download size.
Judge honestly against a good recent game's vegetation and say what still gives it away.
