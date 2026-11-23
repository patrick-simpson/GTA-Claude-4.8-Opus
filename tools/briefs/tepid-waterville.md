# Brief: Tepid Falls in Waterville's likeness (owner request, Nov 23)

Owner: "make it look more reminiscent of Waterville without using any usual names from Waterville.
Use Blender to render realistic stuff wherever it makes sense." Asked one at a time, the owner chose:
- The MAINLAND town, Tepid Falls (src/world/mainland*.ts), not the island.
- All four: Main Street and the big parking lot behind it (the Concourse); the riverfront, falls and
  brick mills (Hathaway / Lockwood style) and the footbridge (already the Exact Change Footbridge);
  churches and civic buildings (steeples, opera house / city hall, post office); neighbourhoods of
  wooden triple-deckers and colonials with maples, and the hilltop brick college with a chapel spire.
- "Where possible the buildings should look almost photorealistic to actual ones in Waterville."
- Reference: the lead or worker browses freely licensed photos (Wikimedia Commons) and Google Street
  View in Chrome ON THE LAPTOP, and models from them. No photograph, and no texture taken from one,
  goes into the game or the repo; textures are made by our own scripts (as the cars and the C-Max).
- No real Waterville names on anything: invent names in the game's punning style.

Method: buildings modelled in Blender by script (a new tools/blender/buildings.py in the style of
cars.py: levels of detail, baked normal and occlusion maps in shared sheets, windows that light at
night, Blender run WITH ITS WINDOW SHOWING), loaded through src/core/assets.ts, mainland only when
the bridge is near done. Keep the frame budget (measure on the GPU with tools/lead/rafprobe.mjs)
and the phone preset light (far versions only, like cars_far.glb).
Order: Main Street first (what a player sees on arrival), then the Concourse, the mills and river,
the churches and civic buildings, the neighbourhoods, the college.

## Owner, Nov 23: "Dithers College should look just like Colby"
Dithers College is Tepid Falls' stand-in for Colby College (Mayflower Hill, Waterville). Model it to
look just like Colby's campus, from reference (Wikimedia Commons, web pictures, Street View in headed
Chrome; nothing copied into the repo): the red-brick Georgian Revival buildings with white trim, white
columned porticos and cupolas; Miller Library's tall white spire and clock tower as the centrepiece
over the main lawn; Lorimer Chapel with its white steeple on the hill; the quad and the long lawns,
brick paths, the dorm rows, Johnson Pond, and the campus's hilltop setting above the town. Keep the
invented name "Dithers College" and invented building names (no real Colby names on signs). Same
pipeline and budgets as the other Tepid Falls units (buildings.py, levels of detail, baked occlusion,
night windows, far versions for phones). This is its own Blender-lane unit after the churches.
Owner, Nov 23 (more): "it should have the same buildings and the same roads as Colby currently does,
including the museum, athletic facilities and all that." So: the full current campus layout, building
by building and road by road, traced from current maps and satellite views (OpenStreetMap and Google
Maps satellite in headed Chrome on the laptop; nothing copied into the repo): Mayflower Hill Drive and
the campus loop roads and parking lots, the academic quad and Miller Library, Lorimer Chapel, the
science buildings, the dorm rows and newer residence halls, the student center, the art museum with
its modern glass pavilions, the performing arts center, and the athletic campus: the big field house
and indoor arena, the ice rink, the turf stadium with stands, the outdoor track, the tennis courts and
the playing fields; plus Johnson Pond and the arboretum woods. Scale it to fit Tepid Falls' hill (keep
the real arrangement and proportions; say what scale). Likely two or three units: layout and roads
with every building's massing first, then the signature buildings in detail, then the rest.
