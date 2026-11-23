# The fun queue (owner, Nov 23): sixteen extras, ONE AT A TIME, in a lane parallel to the other work

Owner: "Do all of those, one at a time as a parallel worker from the existing work running."
Run them in this order (things that need src/net or server come after the multiplayer host job is in).
Each is one worker (top model to build; a Haiku check after; the lead pushes with a player-facing commit
message, because the last commit message becomes the in-game WHAT'S NEW card).

 1. Stunt replay and slow-mo: big jumps, crashes and ragdoll flights replay automatically in slow
    motion from a cinematic camera (skippable); a key/button rewatches the last 10 seconds.
 2. Photo mode: pause anywhere, free-fly camera, depth of field, film filters, time-of-day slider,
    hide HUD, save a high-resolution screenshot.
 3. Fireworks over Pelican Pier at night: shows on holidays and Saturday nights, plus fireworks a
    player can buy at a shop and set off.
 4. Cannons and catapults: a few placed around both towns that launch the player (ragdoll) sky-high,
    with a landing target and a stat for distance.
 5. Moose crossings: big Maine moose wander onto roads (more on the mainland), very solid when hit,
    wander off; never gory.
 6. Giant rubber duck events: the duck breaks loose and drifts around the harbour; push it back with
    a boat or car for a reward.
 7. Stunt park: loops, half-pipes, big ramps on the beach or the docks; scores for flips and airtime.
 8. Rare weather events: a tornado that throws loose things around (cars, props, people as ragdolls),
    and a flood in Tepid Falls when the river rises; both rare, survivable, spectacular.
 9. Emotes and taunts: dances, waves, honking tunes (a radial or key menu; touch too).
10. Customise your character and car: clothes, hats, paint, wheels, horn; saved; seen by other players.
11. Races between players: start from a marker, invite others in town, grid, countdown, checkpoints,
    podium, lap records kept in the town.
12. Police chase with friends: one player is the cop (siren, cruiser), the others are wanted; timed.
13. Demolition derby at Flounder Field: last car running wins.
14. Delivery rush: packages from SpeedScan HQ or Pardon's across both towns against the clock.
15. Town leaderboard: highest jump, longest ragdoll flight, most money, best race times, on a
    billboard in town (and the menu).
16. Spectating: watch another player through their camera.

Rules for every item: stay off files another running worker owns (the lead says which in the prompt);
multiplayer items (10-16, and the shared parts of 1-9) touch src/net and server only once the host job
is done; per-frame instance buffers registered with game.flip; measure frame rate (rafprobe --vsync);
boots with no errors at high, low and the phone layout; nothing gory.
