# Brief: the Marden's store in Tepid Falls, hyper-realistic, with a full interior (owner, Nov 23)

Owner: "Make sure Marden's is hyper realistic with a full realistic interior. Use the laptop for this.
This project should take priority and be in the correct space in Waterville."

- It is the Waterville store of Marden's (Maine's surplus and salvage chain), on the Kennedy Memorial
  Drive commercial strip. Place it in Tepid Falls where that store sits relative to downtown, the river
  and the main roads, using tools/briefs/tepid-reference.md's mapping of real Waterville onto the
  Tepid Falls map (extend that mapping if the strip is not on it: a road out of town with the store,
  its big parking lot, cart corrals, lamp posts, the road sign).
- NAME: a pun on Marden's chosen by you (the owner's choice: same look and feel, not the real name or
  trademark; for example "Pardon's Surplus & Salvage"). The sign and storefront copy the real store's
  shapes and colours closely; the words are the pun.
- EXTERIOR: as close to the real building as reference allows (Wikimedia Commons, web pictures, Google
  Street View in headed Chrome on the laptop; pictures kept only under scratch/, never in the repo).
- INTERIOR, walk-in, the priority: the player can walk in through working entrance doors and around a
  full store: checkouts, carts, the ceiling (drop tiles or open trusses with fluorescent fixtures as in
  the real store), aisles of shelving and racks with merchandise that reads as real from close up
  (surplus and salvage mix: furniture, flooring rolls, clothing racks, housewares, food, fabric,
  hand-lettered sale signs), floor wear, back walls, offices and stockroom doors. Collision for walls,
  shelves and counters; the camera must work inside (no clipping through the roof); lighting inside
  that looks like the store, also at night. A few shoppers inside.
- Built in Blender by script (tools/blender/, window showing, battery check), baked lighting for the
  interior where it helps (light maps baked in Cycles on the laptop's RTX), merchandise as instanced
  props from a kit. Loaded only when the player is near (src/core/assets.ts); a far exterior for phones
  and distance. Interior detail must not cost frames when outside (cull it).
- Budget: inside the store at high on the Iris Xe at 60 fps or better (tools/lead/rafprobe.mjs --vsync).
