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
    OWNER (Nov 23): today each player sees THEMSELVES differently from how others see them (you are
    Dess on your screen but another look on theirs). Fix that as part of this: whatever look a player has
    (picked, or the default before they pick) must be exactly the same on their own screen and on every
    other screen, including face, skin, hair, clothes and car paint. NEXT in the fun queue after item 8.
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

17. CHRISTMAS UPDATE (owner, Nov 23: "Release a Christmas update", end of the queue): a festive
    edition switched on by the date (late November to early January) and the season system
    (src/world/season.ts): lights on houses, shops and Main St in both towns, wreaths and garland,
    a big lit tree in Mercy Park and one on Tepid Falls' Quorum Square, light-up decorations at
    Pardon's and SpeedScan HQ, a few inflatable lawn decorations, Santa hats on some pedestrians,
    a sleigh flying over the island at night (and through the fireworks), carollers, Christmas
    music on one generated radio station, presents hidden around both towns to collect (a counter
    and a reward), snowball throwing if snow is down, and a "Christmas update" WHAT'S NEW message.
    Cheap at night (lights as emissive instanced bulbs, not real lights), off outside the season
    or with a menu switch. Nothing tied to a particular religion beyond the familiar holiday decor.

18. A TRAIN ON THE TRACKS (owner, Nov 23: "put a train on the train tracks"). Find the existing rail
    line(s) (src/world/mainland*.ts has the depot and Tepid Falls rail; check plan.ts, places.ts and
    ground.ts for island track) and run real trains on them: a freight train (locomotive in a Maine
    railroad style with invented markings, boxcars, tankers, flatcars with logs and lumber, a caboose)
    and now and then a short passenger train stopping at the depot. Blender-modelled cars with levels
    of detail (window showing, one Blender at a time). Proper rail motion (bogies follow the curve,
    couplings, slack), headlight, ditch lights, bell and horn at crossings (the two-long-one-short-
    one-long pattern), crossing gates and flashing lights that come down for the train, cars stopping
    at crossings. Solid: it hits cars and people (ragdolls) and wins. The player can stand on a flatcar
    or ride the caboose. Multiplayer: the train follows the shared clock (deterministic schedule from
    the town time), so every screen sees it in the same place without new messages.
    OWNER ADDITION: "It should drive": the player can drive the train. Climb into the locomotive's
    cab (F) and take the throttle (forward/back), brake and horn; it stays on the rails, with real
    weight (slow to start, long to stop), it can derail if taken through a curve far too fast
    (spectacular, survivable), and the scheduled train resumes when the player leaves. In multiplayer
    the train a player drives is sent like their car, so others see it move.

19. QUALITY PASS ON EVERY BLENDER MODEL (owner, Nov 23: "spend some extra effort and make sure the
    Blender renders are super high quality on the avatars and everything you're making"; a separate
    step after everything else). Go back over the people/avatars (faces, hands, hair, clothes, skin
    shading), the cars, the C-Max, the boats, the moose, SpeedScan HQ and its interior, Pardon's and its
    stock, Main St, the riverfront and the civic buildings: higher-detail sculpting where it shows,
    proper UVs, baked normal/roughness/AO maps from high-poly versions on the RTX, PBR materials,
    better levels of detail, side-by-side pictures before and after for each. Keep the phone and
    frame budgets (measure each).

20. THE PROMO (owner, Nov 24; LAST, after everything including the quality pass): a 60-second promo that
    plays on load, "highest quality you can muster", that makes players think they are about to play an
    epic game; any key (or tap) skips straight into the game. Music: "Swing Machine" from the owner's
    YouTube link https://youtu.be/Rtahc_olXjE (confirm the title and artist from the video page first).
    Play it the way Claude FM is played (src/audio/claudefm.ts): the YouTube IFrame player, hidden, streaming
    from YouTube; never download or copy the audio into the repo. Browsers only allow sound after a click or
    key, so the promo starts on the title card's first click/tap (which already exists), and if YouTube
    can't be reached it plays silent with the game's own music bed.
    Build it as a REAL-TIME in-engine cinematic (no video file to download): a scripted sequence of shots
    from the actual game cut to the song's beats (measure the beat grid from the track's tempo): the
    SpeedScan tower with its stink lines, a car chase with police and the helicopter, ragdolls and the
    cannon, the stunt-park loop, boats and the duck, moose on a snowy road, the derby crowd, the tornado,
    fireworks over the pier, Tepid Falls' Main St, the store interior, multiplayer racers at the lights;
    cinematic cameras (dolly, crane, orbit, slow-motion at the drop), letterbox, title cards in the game's
    paperwork style with punchy lines, and the logo at the end with "PRESS ANY KEY". Every shot pre-warmed
    (src/core/warmup.ts) so nothing hitches; phones get a shorter, lighter cut. Shown once per new edition
    or first visit, with a menu option to replay it.
