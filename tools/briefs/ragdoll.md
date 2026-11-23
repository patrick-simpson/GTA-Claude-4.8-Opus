# Brief: ragdoll physics when a car hits someone, and make it funny (owner request, Nov 23)

Owner: "Can you add ragdoll physics when you get hit by a car? Make it funny if possible."

- Who: the player (Dess) on foot, pedestrians, police on foot, and other players in multiplayer.
- Today people are knocked over by a canned fall (find it in src/ent/character.ts, src/sim/peds.ts,
  src/ent/player.ts and the hit handling in src/ent/vehicle.ts). Replace it with a ragdoll driven by the
  existing skeleton (characterAssets BONES): a light verlet or rigid-body chain written here (no new
  runtime dependency), joints with limits so limbs bend the right way, momentum from the car's speed and
  direction, tumbling over the bonnet at speed, bouncing off walls and the ground, settling, then the
  person gets back up (blend from the ragdoll pose to a get-up animation) or stays down if killed.
- Funny, in the game's deadpan tone: exaggerated but readable flight at speed, arms and legs flailing,
  a cartoon spin, the occasional absurd outcome (lands sitting on a bench, ends up in a bin, bounces off
  the giant duck), a short stagger and dusting off after getting up, a pun toast now and then, and a
  "Mistakes made" style stat. Never gory: no blood, no broken-limb angles.
- Cheap: at most a handful of ragdolls at once (the rest keep the old fall), only near the camera,
  fixed step, no frame cost when nobody is flying (rafprobe downtown). Per-frame buffers via game.flip.
- Multiplayer: the host simulates ragdolls for shared people; a player's own ragdoll is simulated by
  their browser and sent as a few bone rotations at the normal rate; guests smooth them (src/net/).
- Check: a scripted set of hits at 10, 30 and 60 mph from front and side, into walls, on slopes, in
  water; pictures of the funniest; two browsers in one town see the same flight; tsc clean, no errors.
