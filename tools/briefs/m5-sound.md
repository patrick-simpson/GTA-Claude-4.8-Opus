# Brief: M5 — sound

Read tools/briefs/common.md first and follow it. Its limits are raised for this task (about 150 tool
calls, 30 images); its other rules stand, and no git commands that change state at all.

Read PLAN.md (milestone M5; the notes for M2, M3, M4 list events waiting for sound), src/core/api.ts
(GameEvents: impact, enter, exit, splash, propBreak, duck, pedHit, shot, crime, heat, siren, gunshot,
roadblock, booked, respray, personHit and others), src/core/game.ts, src/ent/vehicle.ts and
vehicleSpecs.ts (speed, ctl, slip, onGround, airTime, spec; the `bolt` is electric), src/sim/police.ts
and policeAir.ts, src/ent/weapons.ts, src/sim/traffic.ts (AI cars set ctl.horn), src/game/ (missions,
activities, save and settings), src/ui/menu.ts (SETTINGS has volume controls greyed out until now),
src/core/input.ts (the `radio` and `horn` actions), src/world/plan.ts and mainland.ts (districts,
coast, river, dam).

YOU OWN: new files under src/audio/, their registration in src/core/game.ts, the volume settings in
src/ui/menu.ts and src/game/save.ts, a radio station readout in src/ui/hud.ts, and a radio key in
src/ui/touch.ts. Everything is synthesized with the Web Audio API: no audio files, no samples, no
network. Do not reproduce any existing melody, jingle or game sound.

You cannot hear. Verify like an engineer without speakers: structure the code so the same graph runs
on an OfflineAudioContext, render each sound offline in the headless browser, and measure and LOOK:
peak and RMS (nothing clipping, nothing inaudible, classes of sound balanced), DC offset, clicks at
starts and ends, band energies, and spectrograms drawn to a canvas and screenshotted. A horn should
show stable harmonics, a crash a broadband burst with a tail, an engine harmonics that rise with rpm.

Do it in this order, each step working in the game before the next:

1. THE ENGINE ROOM. src/audio/audio.ts: one AudioContext created lazily and resumed on the first user
   gesture (safe and silent before that); buses for master, engine, sfx, ambience, music and ui with
   smoothed volumes wired to the menu's settings and saved; a gentle limiter; suspend when paused or
   the tab is hidden; a listener from the camera; distance rolloff and stereo pan per sound (no HRTF);
   shared noise buffers; a cheap reverb send (street and open-water tails); a voice limiter so a
   pile-up never distorts.
2. VEHICLES. Engine synthesis for the player's vehicle, distinct per kind, from a virtual gearbox and
   rpm (gear changes, idle, limiter, engine braking): a buzzy three-cylinder hatch, smooth fours, a
   lumpy V8 for the muscle car, a high wail for the sports car, diesels for the pickup, van, tow truck
   and bus, a hard V8 for the cruiser, and for the 2017 Chevy Bolt the near-silent whine of an
   electric motor with a low-speed pedestrian-warning hum and tyre noise doing most of the work.
   Simplified engine voices for the nearest few other vehicles with a mild Doppler shift. Tyre squeal
   from slip, road roar, wind, landing thumps, impacts scaled by speed (never the same twice), a horn
   per kind for the player and for AI cars that set ctl.horn, reverse beeper on the tow truck and bus,
   door thunks on enter and exit, splash and gurgle when a car sinks.
3. THE WORLD. Ambience that crossfades with place and time: surf near the coast, harbour clanks and a
   bell buoy at the pier and docks, gulls by day, city hum downtown, birdsong and crickets in the
   suburbs, industry in the Cannery; in Tepid Falls the dam's roar near the falls, mill machinery at
   Loom Row, a distant train horn and crossing bell now and then, a church bell on the hour, pines in
   wind on the hill. Rain, distant thunder, a foghorn in fog. Footsteps by surface, jumps, swimming,
   prop breaks (the hydrant geyser hiss), the giant duck's enormous squeaky honk, Gerald's squawk, the
   3 AM saucer's hum.
4. TROUBLE. Sirens for the Harbor Patrol with an original pattern, positional with pitch shift, driven
   by the police events; the helicopter; gunshots per weapon with a crack, a body and a street tail,
   for the player and for officers; ricochets; explosions with a sub thump; fire crackle; pedestrians'
   short non-verbal reactions (a gasp, a yelp: synthesized, no speech).
5. PAPERWORK. UI sounds in character: a rubber-stamp thunk for stamps and tags, paper for toasts and
   the menu, a beacon pip for heat changes, a till-like tick for money that is our own, mission pass
   and fail stings, a checkpoint chime, the duck-collected squeak, span-completed fanfare.
6. THE RADIO. Plays in vehicles; the radio action (T, a touch key) steps through stations with a burst
   of static, and the HUD shows the station. Five original stations plus off, each an endless
   procedural generator with its own instruments, tempo and harmony, real song structure, progressions
   that function, melodies built from motifs that repeat and develop, drum fills, a balanced mix, and
   a short ident sting: WDOOF 99.9 "Radio for Doofuses" (committed novelty oompah with a kazoo-like
   lead), Low Tide FM (lazy surfy lo-fi), Ledger 1040 (lobby bossa), The Cannery 88 (drum-machine
   funk), Radio Fishbone (an old-town sea waltz), and once the bridge is complete a sixth from Tepid
   Falls (a small-town station of your own invention). Stations keep time while you are away. Seeded,
   deterministic, light on CPU.

Performance: audio must never hitch the frame (no allocation in per-frame paths, parameters scheduled
ahead, voices capped), and the whole thing must be silent and free when muted. Check on the phone
preset too.

CHECK: offline renders with spectrograms for each engine through a scripted run (idle, launch, top
speed, lift, brake, drift), each horn, impacts, the siren, each gunshot, the explosion, each ambience
bed, the duck honk, the UI set, and 30 s of each station plus its note log read like a score; level
tables showing balance and no clipping when rain, surf, a siren, an engine and the radio play
together; in the live game, that audio stays suspended before a gesture and runs after a real click,
that the volume sliders work and persist, that pausing suspends, and the cost per frame.
