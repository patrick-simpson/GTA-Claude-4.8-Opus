# Brief: M2 particles and skid marks

Read scratch/briefs/common.md first and follow it.

Also read: PLAN.md milestone M2; src/core/post.ts (the scene renders to a half-float target with a
depth texture, then AO, bloom, tone-map); src/ent/vehicle.ts (slip, airTime, onGround, how 'impact'
is emitted); src/world/ground.ts (how props break and where 'propBreak' is emitted). Another engineer
is reworking pedestrians and traffic in src/sim/: do not touch src/sim/.

YOU OWN: new files src/fx/particles.ts and src/fx/skids.ts, and the few lines in src/core/game.ts
that construct and register them (leave the rest of game.ts alone).

Do it in this order, each step working in the game before the next:

1. THE SYSTEM + TIRE SMOKE. src/fx/particles.ts: class Fx { constructor(game); update(dt); emitters }.
   One pooled, instanced, camera-facing particle system: at most two draw calls (one alpha-blended and
   lit, one additive), about 4,000 particles on high and fewer by game.quality.density, no allocations
   per frame, oldest-first recycling, state in typed arrays. Realistic, not cartoon: soft puffs from a
   small sprite atlas painted on a canvas (several puff shapes with internal detail, rotated), lit by
   game.sky.lightDir and darker and bluer at night, soft fade against scene depth where the depth
   texture is available, correct with fog and the post pipeline. First emitter: tire smoke at the rear
   wheels of any nearby car whose slip is high (positions from x, z, h, spec.wheelbase, spec.track),
   hanging and drifting.
2. SKID MARKS. src/fx/skids.ts: class Skids { constructor(game); update(dt) }. Ribbon quads in one
   preallocated mesh used as a ring buffer (about 3,000 segments), a strip per rear wheel while slip
   is high and the car is grounded, on the road with polygonOffset and following groundAt on ramps and
   decks, dark rubber with soft edges, alpha by slip, fading over about a minute by rewriting alpha in
   place, breaking cleanly when the slide stops or the car leaves the ground.
3. IMPACTS AND PROPS. 'impact' -> sparks (bright additive streaks with gravity, one bounce) and debris
   scaled by closing speed; 'propBreak' -> debris chips in the prop's colour, and for hydrants a
   geyser that runs about 8 s (tall pressurised column, mist, falling spray).
4. WATER AND GROUND. 'splash' -> column, droplets and an expanding foam ring on the sea (y = WATER_Y),
   smaller for a person; dust on sand and grass and on landings (airTime returning to 0); exhaust puff
   on hard launch; rain splashes on the road around the camera in rain; white then dark smoke from a
   badly damaged engine (vehicle.health low).
5. READY FOR M3, built and checked in a harness but not wired: muzzleFlash, tracer(from, to),
   bulletImpact, explosion (flash, fireball rolling into dark smoke, embers), fire (start/stop handle).

Low (phone) preset: a much smaller budget and no soft-particle depth read. Only spend on what is near
the camera.

CHECK: a handbrake slide in the muscle car on Strand Blvd (g.teleport(-340, 291.8, 1.5708);
g.drive('muscle'); hold KeyW, then Space and KeyA), shot mid-drift and after; a wall crash with
sparks; driving through a hydrant and a bin; the pier jump into the sea (from g.teleport(0, 470, 0)
south at speed); night versions of the drift and crash so bloom on sparks shows. Report draw calls,
update time with 4,000 live particles (well under 1 ms) and ms per frame with a screen full of smoke
(overdraw is the risk: cap on-screen particle size and the count near the camera).
