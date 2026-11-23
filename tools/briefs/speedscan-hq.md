# Brief: SpeedScan headquarters (owner request, Nov 23)

Owner: "incorporate SpeedScan headquarters. It should have stink lines and be massive." Placement chosen
by the owner: DOWNTOWN ON THE ISLAND, in the Ledger District, taller than every tower there, the first
thing a player sees from the start.

- Massive: a corporate tower clearly taller and bulkier than anything in the Ledger District (read
  src/world/buildings.ts / plan.ts for the district's lots and heights; take or merge a lot rather than
  overlapping streets), modelled in Blender by script (tools/blender/, window showing, battery check)
  with real facade depth, a crown, an entrance plaza, lit windows at night, levels of detail and a far
  version for phones; it must read from across the island and from the bridge.
- The SpeedScan logo: the owner's own artwork is "SpeedScan Logo Light.svg" in C:/Users/User/speedscan
  (outside the repo). Use it for big signage on the crown and over the entrance (a texture made from
  the SVG by our own script, or geometry from it); copying this logo into the repo is the owner's wish.
- Stink lines: GREEN (lime to green), wavy, rising off the roof and drifting, like the owner's
  SpeedScan printer videos (neon wavy tubes there); animated in the game, visible by day and glowing
  at night, cheap (a few draw calls; register any per-frame buffer with game.flip).
- It must not cost the downtown frame rate more than about 5% (tools/lead/rafprobe.mjs --vsync,
  scene downtown, Iris Xe) and must not break traffic, pedestrians, collision or the radar/map.
- Multiplayer: it is static scenery, the same for everyone; nothing on the wire.
