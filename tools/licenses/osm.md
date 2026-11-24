# OpenStreetMap data (Dithers College layout)

**Source:** OpenStreetMap, queried through the Overpass API on 2026-11-23, area of Colby College, Waterville, Maine, USA.
**Licence:** Open Database Licence (ODbL) 1.0. **Credit:** "© OpenStreetMap contributors" (openstreetmap.org/copyright).

**What was derived:** building footprints, campus roads and drives, footpaths, parking lots, sports pitches, the running
track, tennis courts and the pond outline. They were warped onto the game's street graph (thin-plate spline), rounded,
renamed (no real names are shown in the game) and written as constants in `src/world/dithersPlan.ts` and
`tools/briefs/dithers-campus-plan.json` (generator: `scratch/campus/tools/gen.mjs`). That file is a Derivative Database
and is offered under the ODbL; the game's code, art and other content are not.
No map tiles, photographs or textures were used; all wall textures are painted by `src/world/dithersCampus.ts`.

**In game:** `MAP_CREDIT` in `src/core/credits.ts`, shown in the pause menu's Settings notes beside the voice credit.
