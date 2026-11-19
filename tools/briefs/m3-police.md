# Brief: M3 heat and police

Read tools/briefs/common.md first and follow it.

Also read: PLAN.md milestone M3 and the M2 notes; src/sim/traffic.ts and peds.ts (how AI cars drive
through Vehicle.ctl and how walkers are run: reuse their helpers rather than copying them);
src/world/plan.ts (findPath, nearestNode, road graph); src/world/collide.ts (lineOfSight);
src/fx/particles.ts (game.fx.emitters); src/ui/hud.ts (it already shows game.player.heat as five
beacon pips). Another engineer is adding weapons, aiming and damage and owns src/ent/weapons.ts,
src/ent/player.ts, src/core/camera.ts and src/ui/: do not touch those. Coordinate only through
src/core/api.ts (append-only) and events.

YOU OWN: new src/sim/police.ts (split into more files under src/sim/ if cleaner), the line in
src/core/game.ts that registers it, and append-only additions to src/core/api.ts.

Original wording and look throughout: the force is the Harbor Patrol, heat is shown as beacon pips,
the arrest stamp is "BOOKED". Do not imitate any existing game's wanted system presentation.

Do it in this order, each step working in the game before the next:

1. HEAT. A Heat system that owns game.player.heat (0..5): crimes raise it (subscribe to 'pedHit' with
   byPlayer, 'impact' involving the player's car and another occupied car or a cruiser, taking an
   occupied car ('enter' on an AI-driven car), and a new 'crime' event { kind, x, z, weight } that the
   weapons engineer will emit for gunfire and hits). A crime only counts if someone could have seen it:
   a pedestrian or officer within range with line of sight. Heat decays only while no officer has seen
   the player for a while: a hidden "search" phase with a shrinking search radius, shown to the HUD via
   a new readonly field or event (for example 'heat' { level, seen, searching, timeLeft }).
2. PATROL CARS. Cruisers ('cruiser' kind) spawn out of view on the road network, route to the player's
   last known position with plan.findPath, and pursue: at heat 1 one car that tries to pull alongside
   and box in; at 2 two or three, more aggressive, attempting to spin the player out; at 3 they ram and
   set roadblocks ahead on the player's likely route (two cruisers angled across the lanes, officers
   beside them); at 4 and 5 more units, faster, and less regard for their own cars. Beacon light bars
   flash (the cruiser model has a light bar on lamp materials; drive it however vehicleAssets.ts
   allows, or add a glow sprite). Sirens are milestone 5: emit a 'siren' event or expose state so sound
   can hook in later.
3. OFFICERS ON FOOT. When the player is on foot or stopped, officers get out and chase on foot (run
   pose), and arrest at heat 1-2 when they reach a stopped or slow player: a short hold, then "BOOKED"
   (game.hud.stamp), a fine, weapons flagged for confiscation via an event, respawn outside the Harbor
   Patrol station (pick a real sidewalk spot downtown and name it). From heat 3 they shoot instead:
   implement the hit logic yourself as hitscan against the player with line of sight and falloff, and
   use game.fx.emitters.muzzleFlash / tracer; damage goes to game.player.health (armor first).
4. LOSING THEM. Break line of sight and leave the search radius and heat falls a level at a time;
   hiding in a different vehicle no officer saw the player enter helps. The respray shop: one real
   location (a garage frontage on a street in the Cannery or Tinker Row; name it "Fresh Coat"), drive
   in unseen with heat > 0, pay a fee, the car changes colour and heat clears.
5. HELICOPTER at heat 4+: a simple Blender-free model built in code is fine (body, tail, spinning
   rotors), circling above the player with a visible spotlight cone at night that follows the player,
   and it keeps the player "seen" while it has line of sight from above.

Keep it fair and fun: escape must always be possible; police must not teleport in view; units are
recycled when far away; cost stays small (measure the update time). Honour game.quality.density.

CHECK with scripts: raise heat by hitting pedestrians in view of others and confirm it does NOT rise
when nobody can see; at each level record how many units come, how long they take to arrive, whether
they catch a player driving a sedan at full speed along an avenue, and whether a player who turns
three corners and parks out of sight loses them; an arrest on foot at heat 1; officers firing at
heat 3; the respray; the helicopter at night. Soak 10 simulated minutes at heat 3 with the player
driving randomly: no NaN, no stuck pile-ups that never clear, no units inside buildings. Stills of a
pursuit, a roadblock, an arrest, and the helicopter spotlight at night.
