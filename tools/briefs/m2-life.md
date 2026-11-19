# Brief: M2 pedestrians and traffic

Read scratch/briefs/common.md first and follow it.

Also read: PLAN.md milestone M2 and "Test-and-fix round after M1"; src/world/plan.ts (road graph,
sidewalkPoint); src/world/signals.ts; then src/sim/ambient.ts in full. ambient.ts is a first cut of
the living city (about 50 walkers, 18 AI cars) written in a hurry. You are finishing it. Another
engineer is adding particles and skid marks under src/fx/ and edits src/core/game.ts: do not touch
those.

YOU OWN: src/sim/ambient.ts (split into src/sim/traffic.ts and src/sim/peds.ts if cleaner, keeping
the Ambient class that game.ts registers). You may append events to GameEvents in src/core/api.ts.

Do it in this order, each step working before the next:

1. PEDESTRIANS CROSS. Walk sidewalk loops and cross at intersections when the cross traffic's signal
   is red (game.world.signal), waiting at the kerb otherwise; a few jaywalk.
2. PEDESTRIANS AVOID AND REACT. Cheap steering around each other, the player, lamp posts and props;
   never through buildings or parked cars. Step aside from a car on the sidewalk; flee (run pose) from
   a speeding car close by, a crash nearby ('impact'), or the player sprinting into them. Knocked down
   by ANY moving vehicle above a small speed (down pose, slide with the car's velocity, get up after a
   light hit, otherwise stay down and be recycled out of view). Emit 'pedHit' { x, z, speed, byPlayer }
   (add it to GameEvents).
3. PEDESTRIAN VARIETY. Idle spots (look at a shop, sit on a bench with the sit pose, wait at a bus
   stop), different speeds, fewer at night and in rain, more on the Strand and pier by day, almost
   none in the Cannery and Dock Seven. Density scales with game.quality.density. Keep the bubble
   around the player and the out-of-view recycling.
4. TRAFFIC LANES AND SIGNALS. Use every lane (avenues: lane centres at +-1.8 and +-5.2 m; streets:
   +-1.75 m), keep right, pass a stopped or slow car when the other lane is clear. Stop at the line on
   red, stop on yellow if they can, never block the intersection box; unsignalled junctions give way
   to the right. Turn left, right or straight on a sensible curve.
5. TRAFFIC MANNERS. Follow distance by speed; brake for pedestrians in the road and the player on
   foot; honk (ctl.horn briefly) then go around when blocked for long; a deadlock breaker that does not
   shove cars through each other.
6. TRAFFIC REACTS. Brake or swerve when cut off; after being hit either stop (a driver pedestrian
   spawns beside the car and flees) or speed off; a stolen or abandoned AI car becomes ordinary.
   Mix of kinds by district and time (buses on avenues, taxis downtown and on the Strand, pickups and
   vans in the Cannery and Dock Seven), fewer at night. No cruisers yet.

AI cars keep driving through the normal Vehicle ctl. Cost: with about 24 AI cars and 60 walkers the
whole update stays well under 1.5 ms (measure it).

CHECK: a soak script running 10 simulated minutes at a downtown junction, the Strand, Gull Heights
and an avenue, reporting cars moving versus stuck (none stationary over 40 s except at a red light),
AI-on-AI collisions (near zero), cars off the road, pedestrians inside buildings or standing in the
road outside a crossing, red-light violations, NaN positions, update time. Then scripted reactions:
drive at a crowd, cut off an AI car, rear-end one, stand in the road, block a lane with a parked car.
Stills: a busy junction with people crossing, a queue at a red light, a night street. Does it look
like a city going about its day?
