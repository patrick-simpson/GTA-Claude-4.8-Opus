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
