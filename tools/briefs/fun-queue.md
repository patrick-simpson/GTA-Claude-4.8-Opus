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

19b. TEPID FALLS MUST WORK (owner, Nov 24, BEFORE the promo): "The road and train network feels a bit
    broken in tepid falls. Before generating the promo make sure that there are buildings where there are
    realistically buildings in Waterville, the roads all connect, match and make sense and everything
    works." So: (1) audit against OpenStreetMap for Waterville (roads, rail, building footprints and land
    use, ODbL credited): every road connected (no dead ends that aren't real cul-de-sacs, no gaps, no
    overlaps, ramps and bridges joined, lanes and signals sane), the rail line, trestle, spur and crossings
    consistent with roads, terrain and bridges, and the train runs cleanly end to end; (2) buildings where
    Waterville has buildings (downtown blocks full, neighbourhood density right, mills, strip, campus), none
    on roads/rail, no empty lots where the real city is built up; (3) drive, walk and ride every road and the
    train in tests: traffic soak, pathfinding from every node to every other, no stuck cars, police chases,
    missions and races all reachable. Fix everything found. Then the promo.
    OWNER'S TEST OF SUCCESS (Nov 24): "I'll know that this is successful when I can pick a business in
    Waterville, and locate it by navigation on the map." So 19b also covers: (a) a BUSINESS DIRECTORY built
    from OpenStreetMap POIs for Waterville (shops, restaurants, services, offices, churches, schools; ODbL,
    credited), each given a punny game name in the style of Pardon's (never the real name), placed in the
    building at its real location, with a sign or storefront; (b) the big map can list/search places by
    category and name and set a waypoint with a GPS route line drawn along the streets (radar too), with
    turn arrows; (c) fill gaps where OSM lacks POIs by marking those buildings as generic shops/offices.
    Geometry sources allowed: OSM (ODbL), Microsoft building footprints (ODbL), USGS 3DEP / Maine LiDAR
    (public domain) for real building heights and roof shapes, Maine GIS open data. NOT allowed: Google or
    Apple Maps 3D/imagery (their terms forbid extracting or copying it); Mapillary (CC BY-SA) is fine as
    visual reference for facades.

19c. FAST TRAVEL (owner, Nov 24: "Add fast travel. Prioritize it."): the Calamity Courtesy Cab from the map's
    Places panel, markers, waypoints and hub stops; fade + Form FT-1 card + warm-up at the destination; car and
    passengers come along; fare by distance (free in kid mode); refused while wanted, in missions/races, in water.

20. THE PROMO (owner, Nov 24; LAST, after everything including the quality pass): a 60-second promo that
    plays on load, "highest quality you can muster", that makes players think they are about to play an
    epic game; any key (or tap) skips straight into the game. Music: "Swing Machine" from the owner's
    YouTube link https://youtu.be/Rtahc_olXjE (confirm the title and artist from the video page first).
    Play it the way Claude FM is played (src/audio/claudefm.ts): the YouTube IFrame player, hidden, streaming
    from YouTube; never download or copy the audio into the repo. Browsers only allow sound after a click or
    key, so the promo starts on the title card's first click/tap (which already exists), and if YouTube
    can't be reached it plays silent with the game's own music bed.
    OWNER CHANGE 2 (Nov 24): "It's copyright free, so you can just grab the mp3." The video is by Kevin
    MacLeod (incompetech; oEmbed confirms channel @incompetech_kmac), whose music is Creative Commons
    Attribution 4.0. So BAKE THE MUSIC INTO THE VIDEO (this overrides the streaming/no-copy lines above and
    below): get the official MP3 from Kevin MacLeod's own sources (incompetech.com; its pieces.json
    catalogue did NOT list "Swing Machine" on Nov 24, and the guessed mp3 URL 404s; try filmmusic.io,
    which the lead's network could not reach, or a download link in the video description, read in the
    laptop's Chrome). Record the license and add the credit line, in the promo's end card and the
    credits/menu: '"Swing Machine" Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By
    Attribution 4.0 License, http://creativecommons.org/licenses/by/4.0/'. Only if no official file
    exists, ask the lead before taking the audio any other way. Then the picture and music are cut together
    in one file, and the sync and YouTube fallback below no longer apply.
    DaVinci Resolve 21.2 (free) is installed for the grade and edit (fuscript.exe for scripting).
    OWNER CHANGE (Nov 24): "prepackage the video so it's super high quality. Don't have it render in real
    time." So it is a PRE-RENDERED VIDEO FILE, picture only (no audio track: the music still streams from
    the hidden YouTube player, and the video's clock follows the player's time so cuts stay on the beat;
    if YouTube fails, the video plays with the game's own music bed). How to make it: drive the real game
    on the laptop's RTX 4050 in an offline capture mode (fixed time step frame by frame, not real time,
    so every frame is perfect): maximum quality settings, supersampled (render 4K, downscale), motion
    blur by sub-frame accumulation, 60 fps, plus Blender (window visible) for any hero shots the engine
    can't make look good enough (e.g. the logo reveal). Colour-grade and encode with ffmpeg: 1080p60
    (H.264 high profile for reach, plus AV1/VP9 if smaller) and a 720p cut for phones; keep each file
    small enough for GitHub Pages (aim under ~25 MB for 1080p). Load it in the background while the
    title card shows; any key/tap skips. The shot list below still applies, as a scripted sequence of shots
    from the actual game cut to the song's beats (measure the beat grid from the track's tempo): the
    SpeedScan tower with its stink lines, a car chase with police and the helicopter, ragdolls and the
    cannon, the stunt-park loop, boats and the duck, moose on a snowy road, the derby crowd, the tornado,
    fireworks over the pier, Tepid Falls' Main St, the store interior, multiplayer racers at the lights;
    cinematic cameras (dolly, crane, orbit, slow-motion at the drop), letterbox, title cards in the game's
    paperwork style with punchy lines, and the logo at the end with "PRESS ANY KEY" (overlaid live as HTML
    so it stays sharp). Phones get the 720p file. Shown once per new edition
    or first visit, with a menu option to replay it.

21. SAFE CHAT (owner, Nov 24: "Is there a safe way to add chat that can't be abused" -> "Yes, add it").
    No typing, ever (multiplayer decision 5 stands). Chat built from pieces: a quick-chat wheel (hold a key /
    long-press) of ~30 lines in the game's voice; a sentence builder from fixed lists ("Meet me at [place]",
    "Race you to [place]", "Let's go [activity]") that also drops a marker on the others' maps; map pings
    (tap the map); short speech bubbles over the character and emoji reactions; a per-player mute. On the
    wire only a phrase index and a place index travel; screens show only built-in phrases, so a tampered
    client can't send words. Kid mode uses a gentler list. Rate-limited per player.
22. DROWNING (owner, Nov 24: "add the ability to drown if you don't swim"). Water is dangerous if you don't
    keep swimming: stop swimming (no input) and you tread for a moment, then start sinking; a breath meter
    appears underwater; when it runs out you drown (screen fades, "WASHED UP" card in the paperwork style,
    respawn on the nearest shore or the hospital, the usual cost). Swimming keeps you up, so normal
    swimming is unchanged; long swims tire you (stamina) and tired swimmers sink faster. Cars that sink:
    get out or drown. Ragdoll-ish limp float. NPCs knocked into water swim to shore. Kid mode: a lifeguard
    whistle and you're plucked out onto the shore, no drowning. Multiplayer: others see you sink and wash up.
