# Brief: M3 weapons, aiming and damage

Read tools/briefs/common.md first and follow it.

Also read: PLAN.md milestone M3; src/core/input.ts (actions fire, aim, reload, nextWeapon, prevWeapon,
wheel, digit; touch hooks); src/ent/player.ts and src/core/camera.ts (how control and the camera work
now); src/ent/character.ts and characterAssets.ts (the skinned people and their poses);
src/sim/peds.ts (walkers: health, knock-down, flee; 'pedHit'); src/ent/vehicle.ts (health, impacts);
src/fx/particles.ts (game.fx.emitters: muzzleFlash, tracer, bulletImpact, explosion, fire, sparks);
src/world/collide.ts (raycast with normals); src/ui/hud.ts and touch.ts. Another engineer is adding
heat and police in src/sim/police.ts and registers it in game.ts: do not touch src/sim/police*.
Coordinate only through src/core/api.ts (append-only) and events.

YOU OWN: new src/ent/weapons.ts; src/ent/player.ts; src/core/camera.ts; src/ui/hud.ts, hud.css,
touch.ts, touch.css; append-only additions to src/core/api.ts; the line in src/core/game.ts that
registers anything new. You may make small, necessary edits to src/ent/vehicle.ts (damage, fire,
explosion) and src/ent/character.ts (an aiming upper-body pose and a held weapon mesh), keeping them
minimal and listed in your report.

Do it in this order, each step working in the game before the next:

1. WEAPONS AND AIMING ON FOOT. Fists, pistol, SMG, shotgun, launcher, with their own invented names
   (no real makes), ammo, magazine size, reload time, rate of fire, spread, damage and falloff as a data
   table. Switch with the wheel, Q/E and number keys. Hold aim (right mouse) for an over-the-shoulder
   camera: closer, offset to one side, narrower field of view, a small original reticle (not a copy of
   any game's), the character turns to face the aim and holds the weapon up (an upper-body aim pose
   blended over the walk; a simple weapon mesh in the hand, built in code). Without aiming, fire shoots
   where the character faces with more spread. Fists: a short punch with a hit check in front.
2. SHOOTING. Hitscan from the camera through the reticle, then from the muzzle to that point, against
   buildings (collide.raycast), vehicles (rotated box) and people (a capsule). Effects through
   game.fx.emitters (muzzle flash, tracer, impact by surface). The launcher fires a visible projectile
   with an arc and an explosion with area damage and force. Emit 'crime' { kind, x, z, weight } for
   gunfire and hits and 'shot' { x, z, loud } so the police engineer's heat system and, later, sound can
   react; add those events to GameEvents if they are not there yet (append only).
3. DAMAGE TO PEOPLE. Walkers hit by bullets or fists: stagger, flee, or go down and stay down by
   damage; everyone nearby flees gunfire. The player's own health and armor take damage from a public
   method (hurt(amount, from)) that the police engineer will call; a hit feedback (brief screen-edge
   flash in the HUD's flat style, camera kick) and regeneration is NOT wanted (health comes back at
   respawn or pickups later).
4. DAMAGE TO VEHICLES. Bullets and crashes lower vehicle.health; visible stages already exist in the
   particle system (white then dark smoke under 50); under 20 the engine catches fire
   (game.fx.emitters.fire, a handle on the car) and after a few seconds it explodes
   (emitters.explosion), with area damage and force on nearby cars and people, leaving a burnt wreck
   (dark tint, no driver, inert) that is cleared when far away. Tires and windows are out of scope.
   Occupants get out before the explosion if they can; the player takes heavy damage if still inside.
5. DRIVE-BY. With a one-handed weapon (pistol, SMG) the player can fire from a vehicle to the left and
   right (aim with the camera; limited arc).
6. HUD AND TOUCH. Current weapon and ammo as a small paperwork-style readout (a requisition slip, in
   the existing HUD language), shown only when armed; reload prompt; a hit marker of your own design.
   Touch: FIRE and AIM keys and a weapon-cycle key appear when armed, laid out so a thumb can aim by
   dragging and fire at once.
7. GETTING WEAPONS. For now: a typed cheat word of your own invention that gives the full set with
   ammo (add it in src/core/cheats.ts, which you may edit for this only), and pickups lying at four or
   five fitting places (a simple rotating crate marker), with locations listed in your report.

Keep the tone of the game: dry, absurd, not grim. No gore: people fall down and stay down.

CHECK with scripts using real key and mouse events where the harness allows: each weapon's rate of
fire, spread and damage against a wall, a parked car and a walker at 10, 30 and 80 m; reload; switching;
aim camera framing by day and night (stills); a car taken from 100 health to fire to explosion and
what the blast does to cars and people around it; a drive-by; the launcher arc; that 'crime' and
'shot' fire; touch controls in the mobile context. Measure the cost of 10 seconds of continuous SMG
fire (no allocations per shot, frame time flat).

## Two owner requests, in files you own (do these FIRST if they are not done yet)

A. The big place stamp shown when entering a district ("SALTWATER STRAND / STRAND BLVD") gets in the
   way. Make it unobtrusive: much smaller, out of the centre of the screen (a compact stamped tag near
   the top edge under the objective strip, or beside the radar), about 1.5 s plus a quick fade, never
   overlapping the objective strip, toasts or quick-reference card, and entirely out of the driving
   sight line. Keep the paperwork style. The big centred treatment stays only for hud.stamp() calls
   such as CLOCKED OUT and BOOKED.
B. A reset button. "Start over" on the pause card with a one-step confirmation in the same form style:
   Dess back at the start point on foot, full health, starting money, zero heat, no weapons, morning
   clock, clear weather. Also hold Backspace for one second as a no-menu shortcut, listed in the
   quick-reference card as "Hold Backspace: back to the start". Implement the reset as one public
   method (for example in player.ts) so other systems can call it.
