# Port Calamity — build plan and handoff

An original open-world crime sandbox for the browser, replacing the old mobile
driving prototype. Same genre as the big-name crime games (drive, carjack,
traffic, police chases, missions) but with its own name, city, characters, art
and writing. **Do not copy any existing game's name, characters, map, HUD look
or music.**

Owner preferences: plain-English explanations, whimsical humor and easter eggs,
American units (mph, feet), Eastern Time, percent-complete updates, and
**push to `main` after every milestone** (credit is limited, so nothing may be
lost). Keep token use lean: write code directly, verify cheaply, avoid large
multi-agent fan-outs.

## Where things stand (about 93% done)

**Milestone 1, the first playable, is live** at gta.doofus.live (switched over
Nov 18, 2026, about 6:30 AM ET). You can walk, swim, get in and out of any of the
eleven vehicles and drive the whole island, by keyboard, gamepad or phone, through
a full day and night with weather. Next up is a test-and-polish pass on M1 (list
below), then M2.

| File | What it is |
| --- | --- |
| `src/core/api.ts` | The contracts: what every subsystem promises the others. Read this before touching anything |
| `src/core/game.ts` | The `Game` object, quality presets, events, the frame order, and `game.systems` (a plug-in slot for later milestones) |
| `src/main.ts` | Entry point and the `window.__game` test hooks |
| `src/core/util.ts`, `input.ts`, `camera.ts`, `cheats.ts` | Helpers and conventions; keyboard, mouse, gamepad and touch as one action map; the third-person and chase camera; typed cheat words |
| `src/world/plan.ts`, `collide.ts`, `batch.ts`, `signals.ts` | The city as data; static collision; geometry batching; traffic-signal timing |
| `src/world/textures.ts`, `materials.ts` | Every canvas texture (facades, roads, the sign atlas with all the pun shops) and the shared materials |
| `src/world/ground.ts`, `buildings.ts`, `landmarks.ts`, `places.ts`, `world.ts` | Terrain, sea, roads, lamps, signals, trees, props; every building; pier, Ferris wheel, lighthouse, bridge, ramps, duck; park, arena, billboards, beach, harbor; and the file that assembles them |
| `src/world/sky.ts` | Sky dome, sun and moon, clouds, fog, weather, lights and shadows, tone mapping, the game clock |
| `src/ent/vehicleSpecs.ts`, `vehicleModels.ts`, `vehicle.ts` | The roster, the car bodies, and the driving physics and drawing |
| `src/ent/character.ts`, `player.ts` | People as animated box-limb figures; Dess on foot and at the wheel |
| `src/ui/hud.ts`, `title.ts`, `touch.ts` (+ CSS) | Radar, readouts, stamps, toasts, pause card; title card; touch controls |
| `tools/pw.mjs`, `tools/shot.mjs` | Test harness: boots the game in headless Chromium and takes screenshots (`node tools/shot.mjs shots/a.png --at -340,291.8,1.5708 --drive sports --keys KeyW --steps 260`) |
| `next/` | Staging folder for later-milestone modules written ahead of time. Empty so far apart from its README |

Easter eggs already in: the giant rubber duck, Gerald the seagull, the 3 AM UFO,
the "Room 404" door, typed cheat words, the pun shop signs, the WDOOF billboard.
Still owed: the pause-menu stat "Mistakes made: 0*" belongs to the M4 menu (the M1
pause card shows it already).

### Owner decisions since M1 (Nov 18, 2026) — these override older text in this file

1. **Not low-poly: as realistic as a browser can manage.** The owner asked for
   this after seeing M1. It replaces the flat "travel poster" shading (the palette
   survives as the town's colours and the colour grade; the HUD paperwork style
   stays) and it lifts the "no external art" rule: models and textures may ship as
   files, as long as our own scripts generate them (Blender 5.2 is installed on the
   owner's PC and may be used). Do it in visible steps, pushing each: (a) physically
   based materials and lighting across the city (normal and roughness maps, wet
   roads, soft shadows, ambient occlusion, reflections, bloom, a filmic grade);
   (b) cars modelled in Blender with curved panels, interiors and baked shading,
   with simpler versions at distance; (c) people with real proportions, a skeleton
   and skinned meshes instead of box limbs; (d) foliage, props, building depth.
   Phones get a simpler version. This rework comes BEFORE the rest of M2.
2. **Use cheaper models where they do the job.** Haiku for fixed-recipe checks
   (screenshot sets, scripted numbers, data validation); Sonnet for well-specified
   code and small fixes with a clear repro; the top model for driving feel, art,
   lighting, integration and writing.
3. **The site is at gta.doofus.live** (the owner moved it from gtaopus).

### Owner decisions, Nov 18 evening — add-on land and progression

1. **The first add-on land is the mainland, reached by FINISHING the Perpetual
   Bridge** (the owner chose this over a ferry). The mid-air stop and its stunt
   jump go away once the bridge is complete.
2. **Theme: Waterville, Maine.** A central-Maine mill town on a river: a brick
   Main Street downtown, big brick textile mills by a dam and falls, a narrow
   pedestrian footbridge across the river, a small hilltop liberal-arts college
   with a white-spired chapel and lawns, railroad yards, an interstate with
   exits, an opera house and town square, wooden triple-deckers and
   clapboard houses with porches, pines, birches and maples, a stream and a
   lake nearby, a sister town across the river with a timber blockhouse fort.
   Use it as inspiration for layout and character; invent the names (this is
   still Port Calamity's world), and verify real details against a map before
   leaning on them.
3. **Slow, continual progression.** Players should see steady progress over a
   long time rather than everything at once. Working design until the owner says
   otherwise: the bridge is visibly BUILT span by span as the player earns
   progress (missions, jobs, money paid to the "Bridge Completion Fund",
   collectibles), so the mainland opens gradually; the mainland itself unlocks in
   stages (the riverfront mills, then downtown, then the college hill, then the
   interstate and lake); vehicles, weapons and shops unlock over time; a visible
   progress readout in the pause menu. Save progress (M4's save system).
4. **Place stamp gets in the way** when entering a new area: make it small and
   out of the sight line (in progress with M3).
5. **A reset button** ("Start over" on the pause card, and hold Backspace) (in
   progress with M3).
### Multiplayer stage 5, hardening part 2 (two faults fixed, the soak, the cost count): pushed Nov 23, about 6:20 AM ET. ALL FIVE STAGES DONE.

**Fault 1 fixed (game, `src/net/crew.ts`).** A crew starter who drops while a helper drives the lent van no longer
stands the van again on return: the helper keeps it, the starter's mission ends the ordinary way, one van in town.
hard2's NOTE is now 5 real checks.

**Fault 2 explained and fixed (test and game).** Two tow jobs started in the same moment could be given the same
kerb place, because neither browser had yet been shown the other's car; the test then found the other player's car
on the departed host's spot. `src/net/jobs.ts` `oneSpot()` now makes the runner with the higher id move its car
(`Activities.reparkTowed()`, a toast says so); nothing new on the wire. hard1 forces the collision every run.

**The soak (`tools/net/soak.mjs`, `--minutes N`).** Four players on MAIN for 31 minutes: drive, chase with the
helicopter, shooting, a crew mission, a tow job, a pause, a host stall and change, a leave and rejoin. ALL PASS in
the worker's full run: no page errors, nobody stuck, one host, guests agree with the host (47 town cars on all
four, people within 200 m with 0 missing and 0 ghosts), heap level at 42 MB. Average sent: host about 310 B/s and
3.5 messages a second; a guest about 25 B/s and 1 a second. Game speed here is about 10% of real, so these rates
are a floor for busy real play, not a ceiling, and it ran on main only. Town cars left behind grew to 47 (the test
makes a car per player per scene; the traffic code caps kept cars at `KEPT_MAX` 40) and were not seen to level off.

**The cost count for the BACKUP (`tools/net/cost.mjs`), against the limits stated in `server/src/budget.ts`.**
Measured on local `wrangler dev` with real pages and the service's own meter; the real Worker was not run.
- A still player: 0.6 messages a second, about 108 billed requests a player hour (measured).
- A driving player: about 1,827 requests a player hour; a fight at most 3,600 (COMPUTED from the 10 a second rule;
  the test machine could not draw fast enough to measure them).
- Under the service's pause line (40% of each daily limit): everybody driving, about 22 player hours a day, 8
  players for 2.7 hours, first limit hit Durable Object requests; mostly still, first limit hit is duration at 11.3
  town hours a day; half and half, about 41 player hours.
- The pause line fires before 50%: with a test limit of 60 it sent "rest" at 25.05 (41.75%), all four pages showed
  the resting notice with the resume time and played on alone, and were let in again a day later (7 of 7 checks).
- A refused join or a /main lookup costs 1 Worker request, and nothing else once the answer is in memory.
- So the backup never crosses 50%; it rests early instead. NOT DONE, the owner's call: sending state frames at 5 a
  second while on the backup would roughly double its hours (8 drivers about 5.4 hours); client only, no redeploy.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; hard1 48 of 48 and hard2 37 of
37 (run without pictures), cost.mjs --pause 7 of 7, a 7 minute soak 8 of 8; the worker's 30 minute soak log read.

**Still wrong or untested, for whoever comes next.** The real Cloudflare Worker, its billing and the real tunnel
through a real restart have never been exercised by a test. Driving and fighting message rates at real speed are
computed, not measured. No soak on the backup. story.mjs "park the same kerb cars" failed 1 of 2 worker runs (cause
not proven, likely counted mid parking). cars.mjs section 6 failed once on Nov 22 and never again (cause not
proven). No line of sight check on hit claims; claims, pay, story marks, bridge points and blame are trusted from
browsers. The rider aboard another player's cab is not drawn. Mainland kerb cars are each browser's own. Nothing in
multiplayer was ever listened to, and smoothness was never judged on real hardware: both need a person.


### Multiplayer stage 5, hardening part 1 (host change, joining, reconnecting, the backup): pushed Nov 23, about 3:35 AM ET

**What.** Three new tests and one game fix. `tools/net/hard1.mjs` (47 checks): the host stalls or leaves mid chase
with the helicopter up, with a fire, a wreck and props down, as crew starter, as helper, with a tow on and a held van
parked. `hard2.mjs` (33): joining a busy town, a 10 s and a 60 s network drop (a TCP relay plays the network), the
main service restarting at a new address with everyone falling back to the backup and returning. `hard3.mjs` (12):
the backup with shooting, a mission, a job and a pause; nothing for or from a host on its wire. Shared helpers in
`tools/net/hardlib.mjs`. The real Worker was not touched: "backup" here is the local stand in.

**Game fault fixed (`src/net/crew.ts`).** A helper driving a lent van who lost the network for 60 s kept the van as
their own while the starter stood it again: two vans. A borrowed car is now taken away when its borrower finds
itself out of town; the starter's side always stands it again.

**Open fault 1 (seen in every hard2 run, printed as a NOTE).** The other way round: the STARTER drops for 60 s while
a helper drives the lent van; the helper keeps it and the returning starter stands it again: two vans. The lead's
rule for the next step: a starter who finds itself out of town does NOT stand a car that was lent out; its mission
has lost the car and ends.

**Open fault 2 (1 of 1 lead runs of hard1; the worker's 3 runs were clean).** After the host left with a tow job on,
the car it was going to tow was still on another player's screen as a private sedan. Cause not proven; the code is
stage 4 step 5's job display (already live), not this step's change. Next step finds it.

**Checked by the lead.** tsc, build, server tests (148), production boot with no errors; hard2 33 of 33, hard3 12 of
12, crew.mjs 50 of 50 (run without pictures), hard1 46 of 47 (open fault 2); one picture viewed.

**Still untested.** A host stall other than mid chase; a host's own network dropping; a tow with the car on the
hook during a host change; the real tunnel and the Worker's /main registration through a real restart (shortened to
10 s here); police not busting a paused player. A drop longer than main's ping timeout (25 to 50 s) always means a
new seat. Part 2 (the 30 minute four player soak and the cost counts) is next.


### Multiplayer stage 4, step 5, targets, jobs, pause, kerbs and wording (stage 4 done): pushed Nov 23, about 2:10 AM ET

**What.** On MAIN: (1) a crew member's rounds, rams and rocket blasts hurt the starter's held TARGET cars (crew kind
`Hit`, 9 bytes, a claim the starter applies within 155 m, 16 m for a ram, and a budget of 75 health a second); a
tail is judged on the nearest crew member. (2) Jobs are shown to others (new `src/net/jobs.ts`, Event `Job`, 14
bytes, on change): a waiting taxi fare, "fare aboard" and "N of M parcels" on the runner's tag, a towed car placed
behind the truck on every screen (0 bytes while towing, against about 55 B/s the old way). Pay stays the runner's.
(3) A paused player is marked "PAUSED" on their tag (spare bit 7 of the state frame, so also on the backup) and they
and their car take nothing while paused. (4) In town every browser parks the same mainland kerb cars (a fixed 50%
share) and barriers follow the town's bridge. (5) The menu and fund box say the bridge is the town's and show the
player's own separately; a notice names whose points finished a span. Still protocol v4, `server/src` untouched.

**Pause rule (the lead accepts it; the owner may change it).** With anyone else in town, pause and the map key are
refused while wanted at 2 pips or more or within 4 game seconds of being hurt, with a toast saying why. On resume
the player is vulnerable at once. Alone, pause is as before.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; story.mjs (new, 35 checks),
facts.mjs (45), police.mjs (46), the single player mission check (13), one clean run each; both pictures viewed.
The worker ran crew, crew2, weapons and cars once each, all clean.

**cars.mjs section 6.** Its failure line now prints asks, grants, refusals, hosts and the host's refusal reason for
every try. It has not failed since, so the cause of the one bad run is still not proven.

**Still wrong or untested.** The helper shot test calls the game's "round struck a car" path, not aimed fire.
Untested: the backup with these changes, a host change mid mission or mid tow, police not busting a paused player,
a paused host, the kerb change on a low quality page. The rider aboard a cab is drawn on nobody's screen. Mainland
kerb cars are still each browser's own (taking or knocking one is seen only there). A host with further own
progress gets a "Your points finished" toast on first hosting. Nothing was listened to.


### Multiplayer stage 4, step 4, missions together, second piece: pushed Nov 23, about 12:35 AM ET

**What.** On MAIN a helper's own actions now count: a goto, collect, race checkpoint, survive ring or "get a
vehicle" objective is met when ANY crew member meets it, judged by the starter from where it already shows them (no
extra bytes). Mission people (spawnActor) are shown to the crew (crew kind `Things`, 6 + 7 bytes a person, on change).
The helper's countdown follows the starter's mission clock and pause (a rate in a spare byte of Show). A lent car is
handed back at a failure. A helper's fail line reads "<name>'s job failed: ...". A starter leaving town no longer
takes the helper's car with it. Still protocol v4, `server/src` untouched.

**Rules.** Only cars a step wants driven can be lent (destroy and tail targets cannot). A checkpoint passed while a
helper drives is that car where it stands; a retry puts the starter at its wheel there. In a shared town a mission
person's look is fixed by mission and step so every screen draws the same person; alone it is random as before.
Not counted for helpers: destroy (shots do nothing to a held car), losing heat (each player's own), tail, wait.

**Cost (worker's measure).** m05 with two helpers, about a minute: starter 36 crew frames, 650 bytes; each helper
1 frame. Zero clock corrections in a 12 s check. Nothing with no mission running.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; crew.mjs (51), crew2.mjs (new,
23: two helpers, m05, set aside, a helper and the starter leaving town), mission.mjs (58), the single player mission
check (13), one clean run each; helper picture viewed.

**A cars.mjs failure, cause not proven.** In 1 of 3 lead runs "a guest takes a traffic car that had a driver in it"
failed all 10 of its tries ("drove off, or was not granted"); the other two runs were 48 of 48. No mission runs in
that test and this step's code is idle without one, so it was judged not caused by this step, but that is a
judgement, not a proof. Watch it; the failure line should print whether an ask was sent and what the host answered.

**Still wrong or untested.** Helper actions other than goto are written but untested (get a vehicle, race, collect,
survive). The checkpoint rule is only tested with the van at its spawn spot. Untested: a lent car burnt or sunk, a
host change mid mission, a dead actor, the backup. A starter who leaves town while driving a held car still leaves
it as a town car. A lost "paused" frame lets the helper's clock run until the next correction. Not built: a helper's
shots or rams counting against a target, a tail judged on the crew, taxi riders and job things, pause for players
not on the crew, kerb cars, menu wording. Nothing was listened to.


### Multiplayer stage 4, step 3, missions together, first piece (the crew): pushed Nov 22, about 11:05 PM ET

**What.** On MAIN a mission is now shared with whoever stands within 30 m of the starter when it begins (and at a
retry). The crew sees whose job it is, the same objective, timer, markers, blip and route; may get into and drive
the mission car; and on a pass each member is paid the full reward and has the mission filed in their own story,
reached or not. New `src/net/crew.ts`, Event `Crew` = 10 with eight sub kinds, no text on the wire (objectives go as
mission and step numbers). Still protocol v4, `server/src` untouched. On the BACKUP missions stay private.

**Rules.** The starter's browser runs the script and is the authority. A busy player (own mission, job, another
crew) says no when drafted; a crew member cannot start a mission or a job. A helper asks at the door (Ask), the
starter lends the car (Lend), the helper's browser then simulates it and the starter's script follows it about 100 ms
behind; getting out hands it back (Back). A helper's "next mission" is still the first open one per giver, so a
helped mission never comes back and earlier ones are still offered. A helper's points go to their own bridge
progress only, so the town counts them once. Failure or set aside releases the crew; the starter dying is the
ordinary fail; a helper dying changes nothing. Money and story marks are trusted from the starter.

**Cost (worker's measure).** Nothing sent with no mission running. One mission with a fail and retry: starter about
55 frames and 1 kB, helper 4 frames. Most frames are countdown corrections caused by the slow test speed.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; crew.mjs (new, 45 checks),
mission.mjs (58), facts.mjs (45), the single player mission check (13), one clean run each; both pictures viewed
(same objective and countdown, the helper at the wheel). The worker ran on the second model, per the owner's rule.

**Still wrong or untested.** A lent car stays with the helper after a failure and vanishes from under them at the
retry. The helper's countdown runs on the wall clock and is corrected about twice a second on a slow game. A
checkpoint taken while a helper drives records the starter on foot. The fail line is worded for the starter.
Untested: set aside reaching a helper, a helper or the starter leaving town mid mission, a host change, two helpers,
any mission but m03, a lent car burnt or sunk, a helper's death. Not built yet: mission actors, targets, pickups and
riders shown to the crew; a helper's own actions (reaching a marker, wrecking a target) counting; pause.


### Multiplayer stage 4, step 2, mission and job cars stay their runner's: pushed Nov 22, about 8:55 PM ET

**What.** On MAIN a car a mission or a job is holding stays its runner's: it is not handed to the town, another
player cannot take it, the host does not tidy it as a wreck, and fail, retry and mission end leave no copy behind.
Others see it as that player's car (new `src/net/held.ts`, Event `Held` = 9, 19 bytes a car, sent only on change and
once to a newcomer). A tow job no longer removes a shown town car. Still protocol v4, `server/src` untouched.

**Found before the fix (one run of the new test on the old code, 22 of 55 checks failing).** Another player could get
into a runner's mission van, which failed the mission "WRITTEN OFF"; a retry left two vans on every screen; a parked
mission van was not shown to others at all; four tow jobs took two town cars off the guest's screen for good.

**Owner decisions, Nov 22 evening (in tools/briefs/multiplayer.md, 13 to 15).** The town's bridge takes the furthest
player's progress (as pushed). MISSIONS ARE DONE TOGETHER: anyone near the starter when it begins is in it
automatically; everyone gets full pay; it always counts in a helper's story; only the mission's own rules fail it.
This step predates that answer: today a helper is shown the mission car but cannot get in. The next steps change that.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; mission.mjs (new, 58 checks),
bump.mjs (29), the worker's single player mission check (13); pictures viewed. Held off main for about an hour
because cars.mjs "by asking the host, who granted it" failed in 2 of 3 lead runs.

**That failure explained: a test fault, and the old cars.mjs flake.** The test never pinned who hosts; when the
host's job moved to the "guest" before it reached the door, it took the car as a host does, with no ask. Forced with
a `--flip` option, the same failure line appears on this code and on 74722fc, so the step did not cause it. cars.mjs
now pins the guest (48 of 48 pinned). Not proven: that the lead's two failing runs were exactly this move, and why it
showed 2 of 3 times now and 0 of 8 before.

**Still wrong or untested.** A player who drops out while driving a held car leaves it as a town car. Shots do
nothing to a held car; blasts and rams untested. No test moves a held car (a hooked tow, a tail car). Untested: host
change while a car is held, missions other than m03, the courier job, more than six held cars, the backup. Two
players running the same mission each get their own van on the same spot. Nothing was listened to.


### Multiplayer stage 4, step 1, the same hour, weather and bridge: pushed Nov 22, about 6:35 PM ET

**What.** On MAIN everyone in town has the same time of day, the same weather and the same bridge, including a late
joiner, across a host change and a service restart. New `src/net/town.ts`. Still protocol v4 and `server/src`
untouched (the service already stored and relayed the three facts; the game had never used them), so no redeploy.

**Rules.** Hour: never sent; each browser works it out from the service's clock in its welcome (one real minute is
one game hour) plus the `clock` fact. Weather: never sent; a fixed function of the town hour and the `weather.seed`
fact. Only the host can change either (a cheat at a guest's keyboard is put back). Bridge on MAIN: everyone sees the
town's (`bridge` fact), it never goes backward, and points earned in town count for the town (ToHost `Give`). A
player's own progress is kept apart, still earns, is the only thing saved, and is what they see alone. On the BACKUP
hour and weather are shared for free; the bridge stays each player's own.
**The town takes the furthest progress it meets** (`TOWN_TAKES_FURTHEST = true`, ToHost `Mine`): nobody stands on a
span the town lacks, but the first far along player finishes the town's bridge for good. THE OWNER HAS BEEN ASKED
whether to keep this; undoing it after the live town was raised means renaming the fact's key in town.ts.
Working decisions for stage 4, also put to the owner: cash, saves and the story step are personal; each player runs
their own missions; the bridge, hour and weather are shared.

**Cost (worker's measure).** Nothing sent while nothing changes. Bridge fact 37 to 38 bytes on a span or at most
every 5 s; Give 7 bytes at most one per 3 s while earning.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; facts.mjs (new, 45 checks),
cars.mjs (48) and heli.mjs (37), one clean run each with full logs; both pictures viewed (same six span bridge, same
rain; clocks one game minute apart).

**Still wrong or untested.** Guest clock about 1 to 2 game minutes behind in the test pictures (cause not proven,
likely the slow test page). Main and backup hold separate facts. A Give in flight during a host change is lost to
the town. Give and Mine are trusted. The menu does not yet say the bridge is the town's. Untested: town stages, a
real payment at the fund box, the catch up time lapse by eye, pause and resume, three or more earning at once, the
real Worker, `TOWN_TAKES_FURTHEST = false`, single player beyond booting. Nothing was listened to.

**Survey: one player's mission in a shared town (read from the code, not tested).** Mission cars, actors, taxi
riders and tow targets exist only on the runner's browser; a mission car the runner leaves becomes an ordinary town
car anyone can take; despawn, fail and retry may leave the host's copy behind; retry teleports; pause stops only
that browser. Proposed steps: (1) a two player test that runs a real mission and a taxi fare and records what the
other screen shows; (2) mission and job cars stay their runner's; (3) mission actors and riders shown to others;
(4) pause in town; (5) mainland kerb cars and stage barriers follow the town; (6) wording; (7) decisions recorded.


### Multiplayer stage 3, step 5, the police helicopter shared: pushed Nov 22, about 5:45 PM ET

**What.** On MAIN there is now one police helicopter for the town, flown by the host and shown to every guest with
its spotlight and sound. A burning police car keeps its number on guests. This ends stage 3. Still protocol v4 and
`server/src` untouched, so no Worker redeploy is needed. On the BACKUP the helicopter stays private.

**Rules.** It goes to a player at four pips or more, stays with that player while they hold four pips, otherwise
goes to the most wanted (the nearer of two alike; the host's own player first when nothing is up). Its 80 s on
station and 35 s refuel belong to the one helicopter. The host sends "lamp on player N"; each browser aims the lamp
at that player as it draws them. "Seen by the helicopter" is each player's own browser's call. On a host change the
new host flies it on from where it was showing it.

**Cost (worker's measure, two in town).** It rides the police beat as a 6 to 8 byte tail, only while in the sky; the
beat then goes every 400 ms, not every 2 s. Police beat 2.5 B/s idle, 26 to 28 B/s with it up. Guests send nothing new.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; heli.mjs (new, 37 checks),
police.mjs (46) and fire.mjs (41), one clean run each with full logs; both pictures viewed (the same helicopter and
beam over the same junction on both screens). The worker was cut off once by the 5 hour limit and resumed.

**Still wrong or untested.** Smoothness on screen not judged (the test pages draw about 2 frames a second); the
glide is proven only by a stopped clock check of its code. Sound not listened to. No single player helicopter test
was run after the split of its drawing code (read through and booted only). Guests of a host on an older page see no
helicopter. Time of day is each browser's own, so the lamp can be lit on one screen and not another. Untested: the
refuel cycle shared, three or more wanted players, the service going away with it up, a wanted player joining with
a private one up, the burning cruiser through to its wreck. It can blink out 560 m away when its player leaves town.


### Multiplayer stage 3, step 4, fire, wrecks, damage and props: pushed Nov 22, about 1:45 PM ET

**What.** Guests now see a shared car burn, blow and stay as a wreck. Another player's car shows its dents, steam,
fire and wreck. Knocked over street props (hydrants, bins, cones, mailboxes, news boxes, benches, lamps, signals)
are down for everybody on MAIN, including someone who joins later. A car blast is blamed on the player who lit it.
Still protocol v4 and `server/src` untouched, so no Worker redeploy is needed.

**Rules.** Town cars: the host counts the fire as before; the top of the 16 damage steps now means alight (13, 14)
and burnt out (15), so guests draw the same fire from the health the host already sends. A wreck is cleared when no
player is within 150 m. A player's own car: its owner's browser is the authority; 4 spare bits of the state frame's
pose byte carry its damage; on MAIN the wreck is then handed to the host with the Leave frame. Props: only the
browser simulating the car can knock one over, it says so once (Event `Prop`, 10 bytes), and the host is the memory
(World kind `Props`, sent once to a newcomer, newest 1000). Blame: the host remembers whose rounds or blast last hurt
a car; the Blast event names them and their own browser raises the crime. On the BACKUP another player's car still
shows steam and fire; props, shared cars and wrecks stay private.

**Cost (worker's measure, two in town).** Nothing new is sent while nothing burns or breaks. The fire is one 12 byte
Blast; the rest rides in records already sent. Host idle 393 to 407 B/s, as before.

**Checked by the lead.** tsc, build, server tests, production boot with no errors; fire.mjs (new, 41 checks),
weapons.mjs and cars.mjs with full logs; both pictures viewed (the same car burning on both screens).

**Flaky check found.** weapons.mjs "run over by another player's car" was a test fault: at about 10% game speed the
car needed about 29 s of wall time against a 25 s limit, and each failed try left its car in the way. Rewritten.
fire.mjs failed 1 check in the lead's first run (the wreck of a guest's own car: the test counted a second wreck 17 m
away that both screens agreed on); the search was narrowed from 25 m to 10 m and the next full run was clean. Where
that second wreck came from is not proven.

**Still wrong or untested.** A burning police car is redrawn once on guests (new number). When a player's car blows,
others see no car for under a second before the host's wreck. A guest who gets out before the blast loses the blame.
No fire sound for another player's burning car. Blame is trusted. The blame test sends CarShot by hand; real bullets,
a guest's rocket, host change mid fire, a third watcher, and the wanted level from a blamed blast are untested.
Props a guest broke while alone stay broken only for them. A tab from before this step shows no fire. Nothing was
listened to; no frame rates measured.

### Multiplayer stage 3, step 3, weapons between players: pushed Nov 22, about 11:50 AM ET

**What.** Players see each other's shots, swings, rockets and blasts, see the weapon in the other's hand, and can
hurt and kill each other. New `src/net/fight.ts`; hooks in `src/ent/weapons.ts`. Still protocol v4: four new Event
codes (Fire, Rocket, Blast, Vital), one new ToHost kind (CarShot), three spare state flag bits for "weapon raised".
The service relays these unread and an older page ignores them, so no Worker redeploy is needed.

**Rules.** The shooter's screen decides a round hit and sends a claim; the victim's browser applies it only if the
shooter is shown within the weapon's reach (plus 15 m, fists 4 m) and inside a refill budget of what that weapon can
do. A blast is told by the browser it went off on; each browser takes its own player's share, the host the town's.
A guest's rounds on town cars go to the host (CarShot). Hurting a player is a crime like hurting anyone, if seen.
Death and respawn at Mercy General are told with a 5 byte Vital event; the shooter gets the kill. On the backup
shots and player damage work too; cars and people stay private. Nothing is sent while nobody fires; a held trigger
is at most 10 events a second (about 124 bytes a second at full speed, computed not measured).

**Checked by the lead.** tsc, build, server tests (146), production boot with no errors, people, bump, two, both
pictures viewed. weapons.mjs (40 checks, about 5 min): 3 of 5 runs clean. One run failed "run over by another
player's car" four tries running ("the car did not reach them"); one run failed one check my log cut off. That check
uses no new code (the car is simply solid on the victim's screen) and sets the car's speed by hand, so it is taken as
a weak test, not proven. cars.mjs: 1 failure in 4 runs, check not captured; the known flake from the head on fix.
The worker ran police.mjs (pass).

**Backup Worker.** The owner ran the deploy workflow on Nov 22. Live check by the lead: /health says v4, 8 seats; a
plain join is sent to main (close 4010); a join with `nm=1` is welcomed. Nothing owed there now.

**Still wrong or unseen.** No line of sight check on a claim. A paused or just respawned player can be shot.
Untested: a round on a player's car, bullets on moving traffic or a cruiser, a guest's blast on people and officers,
a third player watching, a host change mid fight. Another player's car shows no damage; a town car burning on the
host shows guests the blast but not the fire or wreck. No gun drawn for a player firing from a car. Nothing was
listened to.

### Multiplayer fix, two players head on: pushed Nov 22, about 9:00 AM ET

**Fault.** bump.mjs failed about 1 run in 3: in a head on between two players the cars could end inside each other
or slide past. Another player's car is put down afresh each frame, sometimes metres on and deep inside the local car,
and the shallowest way out of a deep overlap is as likely sideways or out of the far end as back.

**Fix (src/ent/vehicle.ts only, no protocol change, still v4).** While apart, a car remembers which box axis parts it
from a player's car and which side it is on (0.5 s); an overlap is undone along that axis back to that side, however
deep; an overlap under 0.3 m on another axis is a new contact. Players' cars are watched 6 m further out.
`ghostPose()` runs the same collision the moment a player's car is placed. Shared AI and parked cars untouched (same
weakness in theory, never seen).

**Tests.** bump.mjs: new check on main and backup that the two boxes never overlap on either screen; the signal time
allowance now uses the longest frame during the looks, not the averaged frame rate (a test fault, never reproduced).
cars.mjs: more detail on failure only.

**Checked by the lead.** tsc, build, server tests, production boot with no errors, traffic, bump 3 of 3, cars 4 of 4.
The worker had bump 7 of 7, police pass, and cars 2 failures in 6 while it ran batches side by side; not seen again
by the lead. If cars.mjs fails again ("left standing 8 of 9", "host gets out 0 of 3"), look here first.

### Multiplayer stage 3, step 2, the same police for everyone: pushed Nov 22, about 6:40 AM ET

What changed (main only; single player and the backup are as before):
- One set of police, run by the host, seen by everyone. Heat stays per player and shows only on that player's own screen.
- Each browser tells the host its heat when it changes. The host chases the right player from one police budget.
- Police cars ride in the traffic frames and officers in the people frames. Police extras cost 6 to 7 bytes/s; each moving police car adds about 150 bytes/s.
- The host decides hurt and busts for a guest and sends them to that guest.
- Escape is judged on the wanted player's own browser.
- Host change carries the chase on. A guest of an older host page keeps private police.
- Protocol stays at version 4. New file src/net/police.ts. New test tools/net/police.mjs (about 16 minutes a run).

Checked by the lead: tsc, build, server tests, police (46), people, traffic, cars, two, solo, main, notices, social: ALL PASS. Production boot with net=0 shows "errors": []. Pictures police-host and police-guest show the same two police cars; heat on the guest only.

NOT clean: bump.mjs failed 1 of 3 lead runs. In a head on between two players the cars ended inside each other (1.0 m middle to middle). The worker saw the same on the code before this step, so it is a fault from stage 2 step 2, not from the police. It is the next unit of work. The worker also made bump.mjs steadier (picks standing cars, clears police first).

Still wrong or unseen:
- Ramming and roadblocks against a guest who is driving. A guest stealing a police car.
- Fairness at 130 ms was reasoned, not seen.
- The helicopter is still private. A paused guest can be busted.
- A wanted player joining a town sees their private police vanish.
- With more wanted players than the budget, the least wanted get no cars.

Models: top model built it (judgement). Lead checked it.

### Multiplayer stage 3, step 1, the same people on the street: pushed Nov 21, about 10:45 PM ET

What changed (main only; single player and the backup are as before):
- The host runs one crowd around every player and sends it. Guests show the host's people.
- A person's look comes from their number, so no bytes are spent on clothes.
- A record is sent only when a person leaves their predicted path, plus a whole frame every 3 s.
- A guest can knock a person down with a car, punch or shoot one. The guest tells the host in 8 bytes and everyone sees the same result.
- People mind every player's car and feet, not only the host's.
- Host change carries the same people on. A guest of an older host page keeps a private crowd.
- Protocol stays at version 4. New file src/net/people.ts. New test tools/net/people.mjs.

Checked by the lead: tsc, build, server tests, people (35, twice), traffic, cars, bump, two, solo, main, notices, social: ALL PASS. Production boot with net=0 shows "errors": []. Pictures people-a and people-b show the same five people.

Measured: 83 to 87 bytes/s for 30 people, but the host's game ran at about 13% speed here. Rough guess at real speed: 0.2 kB/s. Worst case 4.3 kB/s.

Still wrong or unseen:
- Smoothness and bytes at real speed.
- When a town forms, the host's crowd changes clothes once and a joining guest's crowd pops away.
- A guest gets private heat for hurting shared people. Police are still private.
- A far player had 5 to 7 people against the host's 22 to 24.
- A slow host makes people stride slowly on guests.
- Money drops stay local. Guest rockets are still private.
- A sitting or crossing person walks to the nearest pavement after a host change.

Models: top model built it (judgement). Lead checked it.

### Multiplayer stage 2, step 3, the same parked cars and taking a car: pushed Nov 21, about 9:10 PM ET

What changed (main only; single player and the backup are as before):
- Parked cars are the same for everyone. They are placed from the map with no messages. The host sends one bit per place for "empty", about 100 bytes every 20 s.
- Any player can take a shared car, traffic or parked. The player asks the host; exactly one player gets it. It is then that player's own car.
- A car a player leaves stays there for everyone, as a host standing car. Up to 40 are kept.
- A pushed or dented parked car becomes a host standing car, seen by all.
- Fixed on the way: a left car could overlap a parked car while both slept. The host now wakes it.
- Protocol stays at version 4. New file src/net/cars.ts. New test tools/net/cars.mjs.

Checked by the lead: tsc, build, server tests, cars (48, twice), traffic (30, twice), bump, two, solo, main, notices, social: ALL PASS. Production boot with net=0 shows "errors": []. Pictures cars-host and cars-guest match.
The first hand in failed about half my runs. The worker found one game fault (above) and four test faults, and both tests then passed 4 in a row for the worker and 2 in a row for the lead.

Still wrong or unseen:
- In a shared town every browser parks 432 cars; low quality alone parks 217. Phone cost not measured. The number is PARKED_TOWN_SHARE.
- Police are still private, and a host's private police can push town cars.
- Wrecks are not shared: a burnt parked car vanishes for guests.
- A left car shows no damage while another player drives it. A car left by someone who dropped out comes back at full health.
- Tow truck and coupe paint shows as the first palette colour to third players.
- Empty places never refill while the town lives. Mainland kerbs are still private.
- Mission cars a player leaves become town cars.
- The driver of a taken traffic car just vanishes.

Models: top model built it (judgement). Lead checked it.

### Multiplayer stage 2, step 2, one signal clock and cars that bump: pushed Nov 21, about 5:30 PM ET

What changed:
- Traffic lights run on one town clock on main. The host stamps it in the car frames; a guest eases onto it. Single player and the backup are as before.
- A guest can hit a shared car. The guest sends a 10 byte knock (at most 10 a second while touching). The host shoves and damages the car and the driver reacts. Everyone sees it.
- Players' cars are solid for each other, on both homes. Each browser moves only its own car.
- Protocol stays at version 4. New test tools/net/bump.mjs.

Checked by the lead: tsc, build, server tests, bump (28), traffic (30), two, solo, main, notices, social: ALL PASS. Production boot with net=0 shows "errors": []. Picture of the knocked taxi looked at.

Still wrong or unseen:
- Signal agreement measured 0.61 s here with slow frames. Unseen on a real machine.
- Head on between players: both bounce a little too far apart at speed.
- A guest sees shared car health in steps of 5, never below 25, so it cannot burn on a guest's screen.
- A guest still gets local police heat for hitting a shared car.
- Knocks on a moving car and gentle pushing are untested.
- main.mjs and notices.mjs take over 100 s each. That is why an earlier chained run looked hung.

Models: top model built it (judgement). Lead checked it.

### Multiplayer stage 2, step 1, the same moving traffic for everyone: pushed Nov 21, about 4:15 PM ET

What changed:
- On the mini PC (main) one player's browser, the host, runs the AI traffic and sends it. Everyone else shows the host's cars, about 130 ms behind.
- The host runs traffic around every player from the one car budget, so a far player still has cars.
- Shared cars are solid for a guest. A guest cannot enter one, and a guest's hits and shots do nothing to them yet.
- When the host leaves, the next host takes over in place with the same car numbers.
- On the Cloudflare backup, traffic stays private and no car frames are sent (budget).
- Protocol is now version 4. New file src/net/shared.ts. New test tools/net/traffic.mjs.

After this push: the mini PC updates itself in about 5 minutes. The Cloudflare backup stays on version 3 and refuses new pages until the owner presses Run on the deploy workflow. Until then a page that cannot reach main plays alone.

Checked by the lead: tsc, build, server tests, traffic (30 checks), two, solo, main, notices, social: ALL PASS. Production boot with net=0 shows "errors": []. Pictures traffic-a and traffic-b show the same cars from both players.

Measured: 142 bytes per frame for 10 cars. The host here only made 2.5 frames a second (no video card), so 360 bytes/s. At 10 a second that is about 1.5 kB/s.

Still wrong or unseen:
- Signal lights run on each browser's own clock, so a guest can see cars run a red.
- Parked cars still differ per browser. Shared cars drive through a guest's parked cars.
- Joining main as a guest pops your local traffic away.
- A paused or stalled host freezes traffic for a few seconds.
- Two far players got 4 to 5 cars each out of 12.
- Single player traffic was reasoned to be unchanged, not compared.
- social.mjs hung once in a long chained run, then passed twice. Not explained.

Models: top model built it (judgement). Lead checked it.

### Multiplayer stage 1, step 7, one town not two: pushed Nov 21, about 3:00 PM ET

The bug: two players could land in different towns (mini PC and backup) and never meet.
The cause: on a busy first load, the "where is main" answer took about 6 s to be read. The 6 s limit fired first, so that browser joined the backup and stayed.

What changed:
- Time limits count ticks, so a stalled page cannot use them up. Lookup and main welcome get 8 s.
- Main gets a second try after 1.5 s.
- A player on the backup tries main in the background every 2 to 2.5 minutes and moves over quietly. The lookup is asked at most once per 10 minutes.
- The backup sends new arrivals to main when main is alive (message `main`, close code 4010). A client that already failed on main says so (`nm=1`) and is seated.
- If main is full, players wait for main. No spill to the backup: 8 total stays true.
- Test only: `&netprobe=` shortens the background check.

Checked by the lead: tsc, build, server tests, main (19 checks), two, solo, notices, social: ALL PASS.

Still wrong or unseen:
- The Worker half (the redirect) is NOT deployed until the owner presses Run on the deploy workflow. The client half works alone.
- The real 2 minute interval was only tested shortened.
- An old cached page that cannot reach main is redirected again and again by the new Worker until it reloads.
- Each failed background try prints one console line.

Models: top model built it (judgement). Lead checked it.

### Multiplayer stage 1, step 6, dots, names, horn and shouts: pushed Nov 21, about 2:20 PM ET

What changed:
- Other players show as dots on the radar and on the pause map, with their name on the map.
- Pause menu, Settings: a TOWN NAME button gives you a new random name. Hidden when the net is off.
- Your horn is heard by the others (sent as an event, not sound).
- B key or the SAY button on a phone: a wave line, plus four more fixed lines. Sent as a number, never as text. One every 2 seconds at most.
- `?net=0` now also ignores `&netmain=`. Tests solo.mjs and main.mjs use `net=0` for "off", since the real address is set now.

Checked by the lead: tsc clean, build, server `npm test` ALL PASS, tools/net two, solo, main, notices, social ALL PASS, both production boots show "errors": [], pictures in shots/net looked at.

Still wrong or unseen:
- No wave animation. The character has no wave pose, so it is a text line only.
- The horn for other players is counted, never heard (no sound here).
- LIVE BUG, next step: two players can land on different services (mini PC and backup) and not see each other.
- The desktop shout picture came from a side script, not from social.mjs. Cause not found.

Models: Sonnet built it. Lead checked it.

### Multiplayer is LIVE (stage 1, step 5): pushed Nov 21, about 12:35 PM ET

(The times on the three entries below run about an hour fast: the lead guessed the clock. This
one is from the mail and Actions timestamps.)

- The owner ran the install line on the mini PC over SSH and sent back the public key (now in
  `server/src/mainkey.ts`), then ran the deploy workflow in kvbcawana: run 1, green, Worker
  `port-calamity-city` on the account's workers.dev subdomain. `BACKUP_HOST` in
  `src/net/protocol.ts` is set, so the live game connects.
- Checked on the REAL service before the push: two production-build browsers with no `?net`
  both went online through the Cloudflare backup and saw each other, no console errors. After
  the push the live site's boot script carries the service address.
- One server test expected the placeholder key; it now accepts 401 or 403.

Owed: at push time `GET /main` still answered null, so the mini PC had not registered yet (it
needed this push to learn the Worker's address; it updates within five minutes and registers
then). Until that is seen, everyone is on the backup with its daily budget. Nobody has yet seen
a player on the main home, a tunnel carrying traffic, or the service after a reboot of the PC.

### Multiplayer stage 1, step 4, the home service and its installer: pushed Nov 21, about 1:20 PM ET

By a top model worker; the lead re-ran the tests, read `install.sh` line by line and checked the
three pinned SHA-256 values against the publishers' own lists (Node, cloudflared, ws: all match).
NOT INSTALLED AND NOT LIVE: the installer has never run on a real machine.

- `server/home/`: `main.ts` (Node wrapper round the same `Room`, loopback only, 8 seats, no
  budget), `tunnel.ts` (runs the quick tunnel, checks it, registers its address with an Ed25519
  signature, makes the key pair on first start), `install.sh` / `uninstall.sh` / `update.sh`,
  `pins.env`, four sandboxed systemd units, a README with the one line for the owner.
- No build on the PC: `update.sh` fetches pinned official Node 24 into the service's own folder
  and Node strips the types. Updates every five minutes from `main`, started on a spare port
  and health-checked BEFORE the switch, previous version kept, rollback on failure.
- "Where is main": `server/src/where.ts`, `mainkey.ts` (a placeholder until the owner sends the
  public key; all registrations are refused until then), `GET`/`POST /main` on the Worker. The
  client tries the remembered main first, then asks, then main, backup, single player.
  Heartbeat every 30 minutes (48 a day, about 0.1% of the request pause line).
- Checked here: `server npm test` 140 PASS (Worker 88, Node home 52); `server/test/update-test.sh`
  21 PASS (install, refusal before the switch, rollback, bad checksum); `tools/net/main.mjs`,
  `notices.mjs`, `two.mjs`, `solo.mjs`; `systemd-analyze verify` clean with stand-ins;
  production boot with no errors.

Owed, all because it needs the real PC or a deployed Worker: `install.sh` and `uninstall.sh` never
executed; the units never ran under real systemd (Node and cloudflared inside that sandbox are
unproven); real cloudflared never run (banner parsing, traffic through a tunnel); shellcheck not
run; a bug in `update.sh` or the units needs the owner to re-run the one line; the cloudflared pin
needs raising about twice a year; a player who lands on the backup stays there until reconnect.
To go live: owner runs the install line and sends the public key; lead commits it; owner runs the
deploy workflow in kvbcawana; lead sets `BACKUP_HOST` in `src/net/protocol.ts` and pushes.

### Multiplayer stage 1, step 3, eight seats and a Cloudflare budget: pushed Nov 21, about 12:35 PM ET

The owner's rules of Nov 21 (tools/briefs/multiplayer.md, items 6 to 12). By a top model worker;
the lead re-ran the tests and looked at the resting notice. Still not live: `SERVICE_URLS` in
`src/net/conn.ts` is empty until a service is deployed.

- Server: cap 8, one town, no second city. `server/src/room.ts` holds the room logic with no
  Cloudflare types (the Node home on the mini PC will wrap the same file); `city.ts` is a thin
  Durable Object wrapper; `budget.ts` holds every free limit, the 50% share and the margin.
- The budget: counted per UTC day; the pause line is 40% of each limit (50% share times 80%):
  40,000 requests, 5,200 GB-s. At the line everyone is told `rest` with the resume time, sockets
  close, joins are refused until 00:00 UTC. Refusals (full, resting) are answered by the Worker
  from memory: 1 Worker request, no Durable Object request.
- Client: an ordered list of addresses (main, backup, then single player), a "town is full" notice
  with a quiet retry every 3 minutes, a "multiplayer resting, back at (local time)" notice and no
  contact until then. Protocol version 3.
- Checked: `server npm test` 61 PASS; `tools/net/notices.mjs` ALL PASS (full then moved in, rest
  shown as "Back at 7:00 PM" for New York, no socket while resting or after a reload, phone
  layout); `two.mjs`, `solo.mjs`; production boots with no errors at high and Auto.
- What the backup alone gives per day: 8 people driving nonstop 2.7 hours; 8 half idle 5.2 hours.
  That is why the mini PC is the main home.

Owed: nothing is deployed, so real Cloudflare behaviour (hibernation wake with sockets attached)
is untested; the service only counts and rests, it cannot stop a hand-written program hammering
the Worker (a Cloudflare rate limiting rule would); a freed seat can stand empty up to 15 s; main
and backup are separate rooms, so two groups of 8 could form if some players cannot reach main;
the Node wrapper, the install script and the "where is main" lookup are the next step.

### Multiplayer stage 1, step 2, the game client: pushed Nov 21, about 11:40 AM ET

By a top model worker; the lead re-ran every test and looked at two pictures. NOT LIVE FOR
PLAYERS YET: `SERVICE_URL` in `src/net/conn.ts` is empty until a service is deployed, so the
live game connects to nothing and plays exactly as before.

- `src/net/`: `conn.ts` (connect, retry at 5 s, 15 s, 45 s up to 5 min, single player when the
  service cannot be reached), `names.ts` (made-up names from three fixed lists, only indexes
  travel, re-roll kept in localStorage), `remote.ts` (other players drawn with the game's own
  people and cars, smoothed about 120 ms in the past, a name tag, removed on leave), `index.ts`.
  Protocol version 2: a 34 byte state. "N in town" in the HUD when others are present.
- Outside `src/net`: `game.net` in `core/game.ts`; hooks `__game.net()` and `rerollName()` in
  `boot.ts`; `ghost` cars in `ent/vehicle.ts` (drawn through the existing flip-registered
  buffers, no physics); `randomLook(rng, fixed)` in `ent/character.ts`; `tools/pw.mjs` uses the
  container's Chromium when present.
- Checked: `node tools/net/two.mjs` against a local service, ALL PASS (walking gap 0.42 m worst,
  driving 0.67 m, on foot to driving, right car kind and colour, swimming, join and leave).
  `tools/net/solo.mjs`: no `?net` means zero sockets and no errors. Production build boots with
  no errors at high, mainland medium, phone and Auto. `server` test ALL PASS.
- Messages in 30 s with one other player present: standing still 17 (125 bytes), parked in a car
  17, driving at the 10 Hz cap about 307 (10 kB). Alone in the city: nothing is sent.

Owed: no GPU here, so smoothness at real frame rates is unseen and frame rate with remote
players is unmeasured (flipcheck not run either); only the car you drive is sent, traffic and
parked cars stay local, so a remote car passes through local traffic (stage 2); the remote
driver is not visible inside the car; horn flag sent but not played, wave and shouts not built;
no radar blips for other players; a dead service prints one browser console line per retry;
slopes, jumps and the bridge not looked at; no menu button for the name re-roll yet.

### Multiplayer stage 1, step 1, the message service: pushed Nov 21, about 9:45 AM ET

A new lead took over from HANDOFF.md, working without the laptop (no GPU, no Blender). The owner
lifted the weekly cap for this job (stay inside the 5 hour window only) and confirmed pushes go to
main. Built by a top model worker; the lead re-ran the test itself.

- `server/`: a package of its own (wrangler is a dev dependency there, not of the game). A Worker
  `port-calamity-city` and one SQLite backed Durable Object, `City`, on the WebSocket Hibernation
  API. It seats players (cap 16, then a second city), sends presence, relays binary state frames
  stamped with the sender id, picks and moves the host (leave, 4 s of silence, bad frame time,
  with hysteresis), and keeps numeric durable facts the host writes. Origin limited to the site
  and localhost; names are two or three list indexes, never text; size and rate caps.
- `src/net/protocol.ts`: the one shared protocol file (no imports). Not yet imported by the game,
  so the shipped bundle is unchanged.
- Checked: `cd server && npm test` starts the Worker locally and prints 45 PASS lines, then ALL
  PASS (run by the worker and again by the lead). Root `tsc` and `npm run build` clean.
- Measured (4 simulated players, 10 Hz, 60 s): 2,436 messages in, 7,176 out, about 26 bytes each.
  Against the free plan (100,000 requests a day, incoming messages billed 20 to 1) that is about
  54 player hours a day. 5 Hz doubles it; sending only when moving does far better.

Owed: never run on real Cloudflare yet (hibernation wake and the fact flush are untested there);
the deploy workflow is a draft in `server/deploy/` and is not yet in kvbcawana; when the daily
quota runs out the service is down until midnight UTC, so the client must fall back to single
player; silent non-host players are never dropped; name index ranges are 0 to 255 until the real
word lists exist; the client should send only when moving to stretch the free plan.

### Interface leftovers from the bug bash: pushed Nov 20, about 3:25 PM ET

By a Sonnet worker, checked by a second. On touch screens the pause menu's tabs,
Resume, New game and the settings controls are 44 px tall (Resume is on screen on
every tab). The map draws the bridge label on a plaque below the hint strip and
moves district names clear of markers. The "Take it down Pelican Pier" line
clears when the player leaves the car or is 500 m from the pier.
Owed: on the PHONE map markers still cover the left end of the bridge plaque and
most of one district name; Mercy Park's name is partly under a marker on desktop.
The `willReadFrequently` console warning remains: the canvases are built in
`src/world/textures.ts` (the helper near line 187; `getImageData` near lines 499
and 552). The arrest path for clearing the pier line was not played.

**Where the job stands, Nov 20, 3:25 PM ET:** cars pass two, the C-Max and all of
M6 are done and live. Next is live multiplayer (`tools/briefs/multiplayer.md`),
not started, waiting for the weekly usage reset on Sunday Nov 22, 4 PM ET.

### M6 step 7, night: pushed Nov 20, about 3:00 PM ET (M6 is complete)

- **Bloom at night** (`src/core/post.ts`): threshold 0.56 (was 0.40), wider levels
  weighted 1.7x, strength 3.0, and a night-only brightness limit in the composite
  that keeps colour (1.7x white), skipped by day. The four values are public on
  `Post` (`nightThreshold`, `nightStrength`, `nightSpread`, `nightPeak`). Lamp
  heads, pier lamps, Ferris bulbs and signals carry a halo; brake lamps are red
  to the core; sodium stays orange.
- **Ground** (`ground.ts`, `materials.ts`): lamp pools 1.7x and halos 1.5x where
  there is a post pass; glow sprites 1.5x; a wet-streak mesh (one draw call, only
  dark and wet, not at low) puts a thin orange streak under each street lamp.
- **Cars** (`vehicle.ts`): night reflections cut 62% (`ENV_NIGHT`); brake lens and
  glow sprites toned so they sit on the lamps; the player's beam is a longer,
  dimmer patch of road ahead instead of a cream cloud; wet reach pools.
- Noon and sunset are pixel-identical or nearly; low keeps its old look. Free:
  night rain at heat 3 is 17.0 ms before and after in one session (A/B).
  `scratch/m6/night/shots.mjs <folder>` retakes the ten fixed pictures.
  An independent worker judged rain and the car clearly better, the rest the
  same or barely better, nothing worse.
  Owed: lit windows are still flat cream cards (raising them burns out the shop
  shelves); signs do not glow; only street lamps and car lamps reflect in wet
  roads; the streaks are flat quads (unchecked on the mainland hill) and two or
  three near the kerb read like short orange posts; the beam is a soft blocky
  patch; street lamps cast no real light on cars or people; at medium the Bolt
  is pale blue-white at night (new or not: unknown); dawn was not pictured.

### M6 step 6, the bug bash: Nov 20, about 2:15 PM ET (no game code changed)

- **The "stale frame" of step 5 was a false alarm in the check, not a stale
  buffer.** With the two-copy buffers switched off the check failed at the same
  rate; every registered buffer read back from the GPU equalled its array at every
  bad frame. Night rain: the particles fade against scene depth and on a
  multisampled target read LAST frame's depth (by design, see `particles.ts`), so
  the first draw after a tick differs from a repeat by a few faint drops. Gull
  Heights: the multisampled picture is not exactly repeatable on this GPU (1-2
  pixels in 2-5 of 15 identical draws). `scratch/m6/flipcheck.mjs` now draws
  without multisampling and also reads every registered buffer back; five runs at
  high and two at low: 0 bad of 106 each; `--break` still fails every check.
  An independent worker reran it and the frame rate (68 standing, 65 moving).
- **Scripted play found nothing broken** (errors list empty throughout): new game,
  the first mission's opening steps, across town and over the bridge, four taxi
  fares, heat 3 with roadblocks, an arrest, two deaths, a swim, the menu and every
  tab, Auto and fixed quality across reloads, a reload mid-chase, window resizes,
  the phone layout by real touch events. A ten-minute soak: heap 32 to 36 MB,
  geometries 389 to 526, textures 100 to 112; nothing runs away (a slow creep at
  the end that ten minutes cannot judge).
  Owed (found, not fixed): no AI car crossed the finished bridge in a 3-minute
  watch (is traffic meant to?). A reload mid-chase clears the heat and the car.
  Map tab: the bridge label sits partly under the hint strip and markers cover
  three district names. Phone menu tabs are 26 px tall. The intro line "Take it
  down Pelican Pier" stays as current business for up to 180 s wherever she goes.
  Console warnings at Auto and medium (`willReadFrequently`, `faces -Z` on the
  two people files, HLSL X3595). Not played: later missions, courier, tow and race
  jobs, weapons, shops, respray, the bridge fund box, a gamepad, a 30-minute soak.
  The box people can go back under `flip` (`scratch/m6/owed/character.item9.ts`).

### M6 step 5, the owed list: pushed Nov 20, about 1:20 PM ET

A Sonnet worker, checked item by item by a second one and then by the lead.
- Bench sitters sit, hands in the lap (`p.bench`, set in `peds.ts`).
- The quick-reference card lists T for the radio.
- People get a soft blue fill at night (`uFill` in the skinned materials, set by
  `People.update`), so Dess reads away from the lamps.
- The HUD shows SEARCHING (amber, blinking) while the police have lost you.
- Shade is less teal: the cause was the sky-environment cube (zenith 0x4f9ccd has
  almost no red). `sky.ts refreshEnv` now pulls the sky 85% toward grey while the
  cube is drawn, by day. A shaded pavement went from (50,82,97) toward (62,81,88).
- Fog thins by up to a third from 4 m to 60 m of camera height, and no object
  takes more than 90% fog (a cap patched into three's fog chunk in `sky.ts`).
- The mill pond: swim, wade and camera heights use `waterLevelAt(x, z)`.
- The governor's "one preset lower" note expires after a week and clears itself
  when the machine holds the higher preset (`GfxNote.capAt` in `save.ts`).
- Knocked-down lamps and signal bulbs are registered with `game.flip`.
- `tools/shot.mjs --wait MS` waits real time, so its pictures show real models.
  Owed: **an intermittent stale frame, live since M6 step 2:** `node
  scratch/m6/flipcheck.mjs` fails about one check in fifty in the night-rain scene
  and sometimes in Gull Heights (frame 52), on the build before this push as well
  (three runs of four showed it). It is probably tied to the cars' reflection
  cube redraw. Unexplained; first job of the bug bash. The box people were NOT
  registered with flip (the worker's version is `scratch/m6/owed/character.item9.ts`;
  the lead took it out while chasing the stale frame, and they are hardly seen
  since the title card holds). Left undone: the dead M1 pause-card code and the
  lagging `api.ts` declarations. The less-teal cube also greys the sky seen in car
  paint and glass by day. The college spire is still only a faint tick from
  mid-bridge. The SEARCHING badge was only seen from a hand-sent event; vehicles
  in the mill pond still use `WATER_Y`. No before pictures were taken for the
  night fill or the fog.

### M6 step 4, loading: pushed Nov 20, about 12:50 PM ET

- **Phones download 1.84 MB instead of 9.23** and never show block cars or box
  people: new `public/models/cars_far.glb` (898 kB, 333 gzipped) holds every
  kind's far level, wheel and lamp marks, copied byte for byte out of the full
  files by `pack_far()` at the end of `tools/blender/cars.py` (or `-- --far`
  alone). Low fetches it and the two people files, and no car maps. ANY car
  export that skips that last step leaves it stale.
- **One download queue, `src/core/assets.ts`:** four at a time, in order of need
  (people, far levels, street furniture, trees, the three cars at the start, then
  kinds by how common they are), read in a worker (`?fetchworker=0` turns that
  off; a Content-Security-Policy would need `worker-src blob:`).
- **The title card holds** (showing megabytes really arrived) until what is
  round the player is in the scene, 10 s at most after the world is built
  (`HOLD_MS` in `src/boot.ts`), so the game opens on real people, trees and cars.
  A kind's own file replaces its far level only while none of those cars is on
  screen within 40 m (6 s at most): a swap out of sight, not a fade.
- **`src/main.ts` is now a 4.8 kB entry** that shows the title card; the game is
  `src/boot.ts`, fetched beside it (the test hooks, `window.__game`, live there
  now). Title at 0.12 s instead of 0.30 (0.25 instead of 0.95 on a slow line).
- Measured with the network slowed (25 Mbit/40 ms and 6 Mbit/100 ms), ms after
  navigation, before to after. Phone: real models in at 5.4 to 1.1 s (fast) and
  13.9 to 3.0 s (slow). High: no stand-ins after 10.8 to 5.7 s (fast) and 25.4 to
  10.9 s (slow), last file 11.2 to 8.6 s and 26.8 to 22.5 s; but the card says
  start at 6.3 s where it said 2.4 (11.9 against 3.0 on the slow line): that is
  the hold. High transfers 16.4 MB on the wire (GitHub Pages gzips .glb).
  `tools/bench.mjs --load` reports title, playable and in-scene times.
  Owed: at 1.5 Mbit the start comes at 17 s and real models are all in only at
  42 s. On a fast line the wait at high is the processor (first frames 2.4 s
  cold, trees in at 5.3 s), not profiled. No true cross-fade. Audio, missions,
  the menu and the mainland are still in the one big script (483 kB gzipped).
  Quantised model attributes (KHR_mesh_quantization, no decoder needed) would cut
  the .glb files a lot but mean re-exporting and re-inspecting every model. The
  ten later car kinds each still cost a hitch going in during play. Verified in
  headless Chromium only: no real phone, Safari or Firefox.

### Owner request, Nov 20 midday: live multiplayer, one fully shared world

"Make it so that when multiple people are on it, it does live multiplayer." The
owner chose a fully shared world (the same traffic, police and missions for
everyone), M6 finished first, the message service deployed from the kvbcawana
repo, one public city only, and made-up names with no typing. Decisions, design
and the five stages: `tools/briefs/multiplayer.md`. It starts after M6 and after
the weekly usage reset (Sunday Nov 22, 4 PM ET); about 15 to 25 steps.

### M6 step 3, quality that chooses itself: pushed Nov 20, about 11:50 AM ET

- **`src/core/governor.ts`** (new): the presets, the machine hints, a one-off
  benchmark (175-210 ms before the title card on the first visit, cached in
  localStorage `portcalamity.gfx.v1` with the GPU name), `pickQuality()` and the
  `Governor`. Quality defaults to **Auto**; fixed presets remain in the menu, and
  `?q=low|medium|high` forces one with the governor OFF (tests must pass `?q=`
  to be comparable). `?q=auto`, `?rebench`, `?debug` (a one-line readout);
  `window.__game.governor` (`enabled`, `step`, `steps`, `reason`, `log`, `ms`,
  `force(step)`), `info().gov`.
- **Starting preset:** a phone-sized touch screen gets low, no benchmark. This
  laptop at 1920x1080 1x gets high in full; on its own 1.5x panel high at 90%
  pixels; a 2x 1080p context medium at 70%.
- **The governor's ladder**, taken after about 3 s of long frames and climbed
  back by trial when there is room, never above the full preset (ms a frame at
  high, standing downtown): full 15.4, pixels 90% 12.8, 80% 11.2, shadow map
  1024 10.2, occlusion off 9.8, FXAA alone 8.5, then "start one preset lower next
  load" plus 70% pixels. Pixel steps cost one or two long frames (17-42 ms).
  Tested in the real loop: a window enlarged to 2560x1440 stepped down twice in
  8 s and held 59-69 fps, climbed back 15 s after release and then held for 60 s;
  a 5x CPU throttle (which quality cannot cure) was recognised and it went back
  to full; six teleports caused no step.
- An independent worker confirmed the presets, the cache, the menu and the trace.
  Owed: never run on a real screen (the headless loop caps at 120 fps). The
  benchmark is noisy (4.0-5.0 ms normally, once 12.1 on the same laptop, which
  started that visit at medium); a low first score is measured again on the
  second visit and the better kept. The "one preset lower" note is lifted only by
  a new GPU name or `?rebench`: one bad session could mark a machine down for
  good (give it an expiry). The preset cannot change live (it decides how the
  world is built). Only the pixel steps were reached under real load; the others
  were forced. A small desktop window no longer counts as a phone. This laptop's
  other GPU (RTX 4050) was not the one measured.

### M6 step 2, the running game no longer waits on its own buffers: pushed Nov 20, about 11:15 AM ET

- **What was wrong.** Not "moving": the bench's stills never ran the simulation.
  With it running the game cost about 19 ms a frame at high downtown, standing or
  moving (51 fps), against 15.5 for a still. The tick's CPU is only 1.2-2.1 ms;
  the cost was the 105-118 instance-buffer uploads a frame it caused (94 of them
  cars, parked ones included). On this driver (ANGLE/D3D11, Iris Xe), writing a
  buffer the GPU drew from last frame makes the new frame wait for the old one.
  It is a threshold: one upload a frame runs free, four do not.
- **The fix, `src/core/flip.ts`:** every instance buffer rewritten while the game
  runs has two GPU copies over one array, and a change goes to the copy that was
  not drawn last frame (`game.flip`, `flip.swap()` in `Game.render()`; `?flip=0`
  switches it off). Buffers are also sent only when changed, and only their used
  part (uploads 105 to 24 standing, 118 to 35 moving). Far boats and buoys bob 8
  times a second, not 60. Nothing else looks different: 106 of 106 pixel-equality
  checks pass (`scratch/m6/flipcheck.mjs`).
- **Result in a real browser loop at high, 1920x1080** (`scratch/m6/rafprobe.mjs
  --vsync`; an independent worker reproduced it): downtown 51 to 65-68 fps,
  Gull Heights 50-53 to 64-68, Main St 59-63 to 76-82. Low stays at the 120 cap.
- **Reading the bench:** a still understates the running game by about 4 ms, and
  a path overstates a player's frame by about 5 ms (its read-back forces the very
  wait this removes). Quote real-loop numbers for frame rate.
  Owed: ANY new buffer rewritten every frame must be registered with `flip`, or
  the whole frame falls back in step with the GPU (about 4 ms). Not registered:
  the box people shown before the models arrive, and ground.ts's knocked-down
  lamps. Gull Heights still has 4% of moving frames over 18 ms. Calling
  `flip.swap()` before the reflection cube's draw broke 2 of 106 checks,
  unexplained, so it is not done there. Measured in headless Chromium only; other
  GPUs unmeasured. Next costs (the frame is now the GPU's, about 15 ms): post
  pass 4.4-5.0 ms, leaf and fence cards 3.3-4.7 at the park and Gull Heights,
  shadows about 2.5, the cars' reflection cube in the worst frames.

### M6 step 1, the baseline and cheaper antialiasing: pushed Nov 20, about 10:00 AM ET

- **`tools/bench.mjs`** is the whole-game benchmark (read its header): stills,
  camera paths, per-system costs, load time; `--ab` for interleaved A/B pairs; a
  failed boot is retried. Full baseline: `scratch/m6/baseline-nov20.txt`.
- **Baseline at 1920x1080 on the Iris Xe, high, before this push** (ms, fps):
  start 13.6 (73), downtown 16.1 (62), park 14.8 (67), heights 17.6 (57), pier
  9.4 (107), night rain heat 3 18.9 (53), mid-bridge 11.2 (89), Main St 13.7
  (73), The Stacks 17.5 (57). Medium 8.1-15.3 ms; low 2.0-3.9 ms. The
  simulation is 0.3-0.6 ms a tick: not the problem. Load: ready in 4.7 s, last
  file at 7.5 s, 29.0 MB (models 23.3, of which cars 17.7; code 462 kB).
- **High now draws with 2x multisampling plus FXAA** in the composite (it was 4x
  and none) and AO takes 8 samples, not 10: 0.6-1.6 ms saved a frame (4-9%), e.g.
  heights 57 to 62 fps, The Stacks 58 to 63. Leaf cards and fences get smoother
  edges; distant one-pixel window mullions are slightly softer. Medium and low are
  unchanged. `?aa=msaa` and `?aa=fxaa` switch for comparison; `post.setAA`,
  `post.setAOSamples` at run time.
- FXAA alone would save 2.3-4.0 ms at high and 1.4-2.3 at medium, but far lamp
  posts and signal arms break into dashes: not shipped; a lever for the governor.
  Owed / next, measured by A/B at high: **camera paths (tick + render while
  moving) cost 23-29 ms a frame against 13-16 for stills in the same streets**
  (7-8 against 3.6 at low), unexplained: probably CPU-side draw submission (370
  calls plus the shadow pass). The post pass is a third of the frame (4.4-5.0 ms:
  the 2x target about 2, AO 0.5-0.7, the rest bloom and composite). Alpha-tested
  cards (leaves, fences) are 3.3-4.7 ms at Mercy Park and Gull Heights. The
  shadow pass 1.4-1.9 ms. Half the frame is per-pixel work. Night rain at heat 3
  is still 56 fps. Scene textures are about 464 MB, the two car sheets 85 MB each.

### The C-Max, part two, and the bumper bug: pushed Nov 20, about 8:55 AM ET

- **Likeness, by measuring the exported model against the owner's tables**
  (`scratch/cars4/measure.mjs`): the real fault was the side glass, a third too
  shallow (belt 3 cm high, glass top 6-10 cm low), which made it read as a Prius.
  Now within 1-6 cm; belt on the real line; screen bowed; the nose one curve from
  an upright bumper into a steeper bonnet (16.7 degrees, real 16.0); head lamps a
  thin black seal round a reflector; lower grille bars satin dark; the tail lamp
  one red cluster split only at the tailgate shut line. Roof within 0.8 cm.
- **Traffic:** `common: 1.5` (about one car in thirty), always grey
  (`Vehicles.spawn` forces it). The fixed one at Mercy Park stays.
- **The owner's marks**, near level only: a 1.2 cm dent in the left rear quarter
  and a 5 cm rust chip on the left front wing above the arch lip.
- **Bumper bug fixed:** `fit_bumper` has one rule with the right sign; the other
  twelve kinds re-exported and back to their table lengths (Bolt 4.167 m); front
  plates the over-long bumpers had swallowed are back.
- Checked by an independent worker: better than part one in all three views.
  Owed on the C-Max: still a fairly generic people-carrier. The tailgate glass
  stops above the lamps and the lamp top is 5 cm low (the generator puts the lamp
  band under the deck line; needs a rebuilt tail). Head lamps are slim pods, the
  real ones taller teardrops. The upper slot's chrome bar shows a coloured strip.
  Nose tip 3 cm short. Rear quarter window not the long swept shape. The dent is
  very subtle; the rust chip can pass for a side marker. Its lamps on a DRIVEN
  car at night were not confirmed (parked cars are unlit), and nobody saw one
  moving in traffic in a picture (two were counted driving). Giving it a weight
  reshuffled which kind is parked where across the city.

### The owner's 2015 Ford C-Max, part one: pushed Nov 20, about 8:20 AM ET

Owner request, Nov 20: "There should also be somewhere a 2015 gray Ford C-Max...
not right next to the Bolt, and can just be driving around or parked somewhere."
Brief: `tools/briefs/cmax.md`. It is the owner's own car; another project on
this PC (`C:/Users/User/cmax`, not in this repo) holds a measured Blender model.

- Kind `cmax` ("2015 Ford C-Max"), built in `tools/blender/cars.py` like the Bolt,
  with its table TAKEN FROM that project's measured tables (the mapping is in the
  comment above `VEHICLES['cmax']`): 4.41 m long, 1.83 wide, roof 1.61, wheelbase
  2.648. Trapezoid lower grille, slim upper slot, swept head lamps, wrap-round
  tail lamps, roof spoiler, aerial, 15-spoke silver wheels, blank fog bezels,
  dark grey 0x474a48, invented plate "5CM 2015". 14.9k / 11.2k / 1.6k triangles.
- One is always parked at Mercy Park's kerb on Ledger St (x 138, z -28.6), about
  330 m from the start. Drivable; quiet hybrid sound and horn (unheard).
- The shared car sheets grew from 4096x3072 to 4096x4096 (ROWS 3 to 4: twelve
  kinds had filled it). Car download 21.8 MB. Frame time unchanged.
- Nothing was copied from the other project but numbers: no plate, VIN or photos.
  Owed (part two): it is not in traffic or the parked rotation yet (`common: 0`).
  Likeness: the side is the best view; the checker found the bonnet too long and
  shallow and the roof too low for a tall one-box (reads like a Prius), the
  beltline barely rising; head lamps have a heavy chrome rim; the tail lamp is
  several red pieces with gaps; the tailgate glass foot is 10 cm high; the lower
  grille's chrome bars throw coloured reflections. No dent or rust chip yet.
  Handling numbers are estimates. The stand-in before the file loads is the hatch.
- **Bug found, live since the 7:40 AM push:** `Car.fit_bumper` reads its
  measurement with the wrong sign, so every painted bumper stands out by about its
  own projection again (the Bolt is 4.36 m long, not 4.17). The C-Max sets
  `fit_true` and is right. Fix for the other kinds and re-export: part two.

### Lamps, bumpers, mirrors and handles on every car: pushed Nov 20, about 7:40 AM ET

- All twelve kinds re-exported (`tools/blender/cars.py` only; no TypeScript).
- **Square head lamps** no longer read as an open chrome box: the corner beside
  each lamp is an amber wrap-round indicator lens. Root cause was the end plates'
  corner column standing upright while the plate leaned back (a fin 3 cm proud of
  the lamp, 9 cm on the Bolt); it now leans with the plate, at all three levels.
- **Painted bumpers** run round the corner in one piece (the notch under the
  sedan's and taxi's lamp is gone) and are measured against the finished skin.
- **Bolt:** the tooth in the outline at the front corners is gone; lamp housing
  is black, not chrome. **Mirrors** are rounded shells on a stalk with a glass
  face, **door handles** chrome pulls over a dark recess, on every kind, for
  fewer triangles than the boxes. Every kind carries the shallower lamp relief.
- Near level is now 13.5-18.3k triangles a kind; car download 20.1 MB. Frame
  time unchanged (cars' share 0.0 ms near, +0.66 mid). `--wheel-tex` is wrapped
  for windowed Blender but was not run.
- Checked: all twelve by day, lamps at night front and rear, low preset.
  Owed: the bumper's ledge now reads as a wrap-round piece ending in a seam 4.5 cm
  ahead of the arch (a change of look). Muscle car: a soft fold where the ledge
  turns the corner, and at low a dark triangle under the bumper end ahead of the
  front wheel. The far level keeps box mirrors and no handles. The bus was never
  seen in a clean front three-quarter day view. Car detail on a real phone unseen.
- **Next: the owner's 2015 Ford C-Max** (`tools/briefs/cmax.md`), then M6.

### Dark paint without the blotches: pushed Nov 20, about 6:50 AM ET

- **Paint (step B), high preset only:** black and charcoal cars lost their
  hard-edged brown and teal patches. Cause: the clearcoat read the 128-pixel
  reflection cube nearly sharp (roughness 0.09) at strength 1.6, so a whole flat
  panel took the colour of one wall. Now the coat reads it at roughness 0.15 or
  more, street colours are greyed (15% saturation at the horizon to 55% in the
  sky), reflections below the horizon are darkened 60%, and dark paint's base
  specular is cut to 0.3. The sun highlight has a second, wider lobe. Light paint
  is unchanged. Frame time unchanged (cars' share 0.0 ms near, 0.65 mid).
- **Loading:** only the new kind's 1024 cell is sent to the sheets
  (`Vehicles.sendCell`, raw WebGL2 blits with a whole-sheet fallback): 10-12 ms a
  kind against 12-18.
  Owed: dark paint reads as satin, not mirror (the cube is too coarse for crisp
  reflections without the patches). A faint warm cast on the Bolt's bonnet
  downtown; at night its windscreen and roof carry soft orange and teal patches.
  The hitch per kind is smaller, not gone (a texture array would cure it); the
  first send of a session takes 160-175 ms, unexplained. `sendCell` is tested on
  Chromium only. On phones the black Bolt reads slate-blue under the flat sky
  sheen. The cube is taken 3 m up at the player, not at the car. A harness spawn
  with no colour picks a random one (that was the "blue Bolt at low").
  Seen by the lead: the muscle car's head lamp is an open box from the side.

### The Bolt's face, and the taxi's band on phones: pushed Nov 20, about 6:05 AM ET

- **Bolt (step C):** clear swept-back head lamps with two projectors and a white
  daytime strip (the chain-mail relief is gone: the shared lamp relief is six times
  shallower), a closed gloss-black shield with a fine diamond pattern under the bar
  and bowtie, a black blade from each lamp down to the bumper pod, amber turn
  signals in the pods, a hard crease along the flank, a ramped bonnet.
- **Taxi:** the far level, which is all phones draw, now has the checker band.
- `cars.py` now runs with Blender's window showing (`build()` works inside a window
  and 3D-view override; about 12 s a kind). `Car.panel` gained `soft`/`soft_gap`
  for patches that cross a sharp shoulder. `--wheel-tex` is not wrapped yet.
- Checked by an independent worker (one repair round for a torn patch under the
  lamps), production build boots clean three ways.
  Owed: only the Bolt and taxi were re-exported, so ten kinds still carry the old
  coarse lamp relief. Bolt details judged from memory, not a photograph: the strip
  may be too bold, the diamond pattern is barely visible at 3 m, the crease is a
  tone break more than a highlight. A zig-zag outline at the front wing's edge and
  pale slivers at the lamps' outer corners very close up. The Bolt spawns black at
  high but mid-blue at low (not looked into). Its far-level lamps are smoked grey,
  so dimmer on phones at night (unchecked). Tail lamps at night unconfirmed.

### Cars, all-out pass two, first part: pushed Nov 20, about 5:25 AM ET

A new lead session took over on Nov 20 (the old one died to the usage limit; see
`tools/briefs/lead-notes.md` for the owner's rules: one worker at a time, push
often, spread the usage). Brief: `tools/briefs/allout-cars-2.md`, steps A to E.

- All twelve kinds carry baked normal and occlusion maps on the two near levels,
  copied at load into ONE pair of 4096x3072 sheets so every kind shares materials.
  With that the cars' share of the frame is back to pass one's (thirty parked cars
  at high: +0.6 ms mid view, about zero near), and about 0.2 ms better than the
  build that went out with M5. Low preset unchanged. Car download 20.2 MB.
- Cars skip the maps on a video card whose largest texture is under 4096.
- The cruiser's rear-quarter spikes are gone; the Bolt's shield is flatter.
- Checked: an independent worker looked at every kind close up by day; production
  build boots with no errors on the island, the mainland and the phone layout.
  Owed: every step is only partly done. A: no roughness or metalness maps, paint
  carries occlusion only (no panel gaps in the normal map). B: reflections on dark
  paint are blotchy brown and teal, no clear sun highlight. C: the Bolt's head
  lamps read as chain mail, its shield is mesh-textured, the flank crease does not
  show. D: near level still 14-19k triangles, mirrors and handles simple, a notch
  under the sedan's and taxi's front lamp. E: the taxi has no checker band on its
  far level (so none on phones); the bus's face and most cabins never seen close.
  Each kind that loads re-sends the whole sheet pair (3-9 ms, once 124 ms): send
  only the new cell. Night lamps not re-verified by the checker.

### M5 "Sound": pushed Nov 19, about 9:30 PM ET

`src/audio/` (about 3,000 lines, no audio files; `game.audio`): engine synthesis
per vehicle kind (the Bolt a whine), tyres, horns, impacts, doors; ten ambience
beds by place and time incl. Tepid Falls (dam, mill, pines); footsteps, props,
the duck, Gerald, the saucer; sirens, helicopter, gunshots, explosions, fire,
pedestrian gasps; UI sounds; a radio with six generated stations (WDOOF 99.9,
Low Tide FM, Ledger 1040, The Cannery 88, Radio Fishbone, and a Tepid Falls
station once the bridge is complete), T or the RADIO touch key. Volume sliders in
the menu, saved. Silent until the first click; suspended when paused or muted.
Owed, important: NOBODY HAS HEARD ANY OF IT. Levels, spectra and note data were
measured; whether it sounds right needs the owner's ears. Tune in the tables
`ENGINES`, `HORNS`, `STATIONS`, `GUN_LEVEL`, `TRIM`. Also: several triggers never
fired in tests (AI horns, fire, ricochets, officers' shots, booked, respray,
thunder, foghorn, train, church bell); tab-hidden suspend untested; HUD sounds
hook by wrapping hud methods; footstep surfaces are approximated; the on-screen
quick-reference card does not list T for the radio.
### M4 "Things to do": pushed Nov 19, about 5:00 PM ET

`src/game/` (`index.ts` registers `ThingsToDo` as `game.todo`): `save.ts` (one
versioned document, key `portcalamity.save.v1`; autosave; `?save=0` disables it),
`script.ts` (19 step types, checkpoints, retry), `missions.ts` (13 missions: ten
on the island paying 2,430 points, i.e. 5 of the 8 bridge spans, then mill,
college and thruway jobs as Tepid Falls opens; givers at the Marlowe yard (Lou,
a Harbor Authority watchman), Finch's bait shop, Gus's arcade, Vance's office),
`activities.ts` (taxi, courier, towing, six races, stunt jumps, 30 ducks with 8
in Tepid Falls; payouts taper), `shops.ts` ("Forms & Rounds" ammo on Ledger St,
"Bent & Dented" body shop on Tinplate St). `src/ui/menu.ts`: the pause card is
now a dossier with MAP, PROGRESS, STATS ("Mistakes made: 0*"), SETTINGS,
CONTROLS, New game (wipes save, bridge and stages; hold Backspace only unsticks).
Press G to talk or use; USE key on touch; M opens the map.
Owed, important: NOBODY HAS PLAYED IT BY HAND. Every mission was passed by a
script that hops along the street graph and does not steer, so timers and
difficulty are untuned ("Public Comment Period" may be too hard). Also: towing
is rigid and clips walls; five of six races never driven; gamepad and touch
map gestures untested; duck rewards at 10/20/30 untested; nothing is actually
gated by unlocks; no hostile Gull Syndicate actors; no shops or respray in
Tepid Falls; radar badges crowd; dead pause-card code left in hud.ts;
`HudApi` in api.ts lacks subtitle/timer/nav/chart/tag.
### Pushed Nov 19, about 4:40 PM ET: trees and street furniture, all-out pass one

`tools/blender/flora.py` -> `flora2.glb` plus five texture files: trees with real
branching, several variants per species, backlit leaves, dappled shadows, baked
impostors at distance; island species on the island, white pine, birch, maple,
oak, spruce and elm with autumn colour in Tepid Falls. Ground cover: reeds at
pond, river, lake and stream, ferns, fallen leaves, wildflower drifts.
`tools/blender/props.py` -> `props.glb`: hydrant, bin, mailbox, bench, sign post,
news box and cobra-head lamp modelled in Blender, drawn within 42 m
(`propAssets.ts`); `?props=0` and `?flora=0` switch back.
Owed: most of the prop list is not done (Tepid Falls post-top lamp, signal masts,
pedestrian signal, bus shelter, parking meter, bollard, bike rack, covers, stop
sign, utility poles and wires); no ivy or planters; props have no baked maps;
prop swap at 42 m is a hard cut; trees still cost 1.7-2.3 ms in tree-heavy
views (not shown to be cheaper than before); cypress is dark and spiky close up;
mailbox and sign post never inspected; an unexplained olive wedge and brown band
near (-19, -1) downtown in shots/fx/felled.png, not from flora or props.
Cause of the black-trees snapshot that was held back: a texture's size was read
after its bitmap was closed (0 x 0 upload). The look-first rule caught it.
### Pushed Nov 19, about 11:50 AM ET: people, all-out pass one

`tools/blender/people.py` and both bodies re-exported together (1.44 MB each):
modelled heads with eyeballs, lids, nose, lips, ears; nine face variants by
morph; hands with fingers (fist, wheel and gun grips); garments as geometry
(tee, shirt, hoodie, jacket, coveralls, dress, trousers, jeans, shorts, skirt,
sneakers, boots, cap, beanie, brimmed hat, glasses, backpack); eleven hair and
beard options; per-vertex surface classes (skin, cloth, leather, hair) in the
shader; three levels of detail with only the nearest 8 people at full detail;
stride scaled by height; a bench pose (nothing sets it yet: `bench` on the body
is not in api.ts). `StyledLook` gained topKind/bottomKind/shoeKind/hatKind/
glasses/bag/face/beard and lost shortSleeves/shorts.
Owed: no UVs or baked maps (as with the cars); faces smooth and long; hair is
helmet shells; garments are tubes; limbs are jointed-doll pieces; no heel-to-toe
gait or look-at; 60 people cost about 4 ms at high; the crowd texture is RGBA32F
and untested on a real phone.
WARNING learned here: pushing mid-task snapshots shipped a man with most of his
body missing for about half an hour (model file and loader out of step). When
pushing a snapshot, LOOK at Dess, a pedestrian, a car and a tree in the
production build first, not only at the console.
### Pushed Nov 19, about 11:35 AM ET: Tepid Falls complete, cars all-out pass one

- **Mainland part 2 is done and live** (`mainlandBuildings.ts`, `mainlandPlaces.ts`):
  Lower Main (incl. the picture house "The Hesitation"), The Stacks, Loom Row with
  the Threadbare mill, Quorum Square and Postponement Hall, the Exact Change
  Footbridge, Dithers College, the depot, Thruway exits and Idle Hands truck stop,
  Fort Reluctance, Lake Indecision; easter egg: a duckling at the lip of the dam.
  Owed: college spire hidden from the landing and faint from the bridge; smokestack
  lettering low contrast; porches are solid; rain, fog, medium preset unchecked.
- **Cars, all-out pass one** (`tools/blender/cars.py`, all twelve re-exported):
  three levels of detail (LOD0 12-16k triangles for the nearest four cars, LOD1,
  LOD2), lamps with bowls and sectioned lenses that light independently (head,
  tail, brake, reverse, indicator, daytime), plates, emblems and scripts, tread,
  calipers, undersides, fuller interiors behind half-transparent glass, real bus
  doors, per-car dirt. The Bolt is reworked (kink, split tall tail lamps, roof
  rails, two-tone alloys). Car files went from 4.6 MB to 11.9 MB.
  Owed: no UVs or baked normal/roughness maps at all (step 7 of the brief); LOD0
  is far below the 40-60k asked for; bumpers still separate sections; mirrors and
  handles boxy; reflections show sky only; Bolt's face still generic, wheels not
  twin-spoke; many kinds never inspected close up in the game.
- Queue: people all-out (running), flora and props all-out (next), then M4.
### Owner requests, Nov 19 morning

- **A 2017 Chevy Bolt, black** (kind `bolt`): the one real car, by explicit request;
  parked at the start. Pushed about 6:30 AM ET. Not yet a faithful likeness: nose
  too blunt, tail lamps too short, rims render dark, and black hides its shape.
- **Tapping the game goes full screen** (`goFullscreen` in `src/ui/title.ts`;
  `?fs=0` turns it off; iPhone Safari cannot do it). Pushed about 6:30 AM ET.
- **"Go all out on these Blender models."** Briefs in `tools/briefs/allout-*.md`:
  people (faces, hands, garments, hair, baked textures, gait), flora and street
  furniture (real branching, species per land, dappled shade, props in Blender),
  and cars (lamps, interiors, panel gaps, badges, baked detail). In progress.
- **Push updates regularly as things are created.** Rule for whoever holds the
  session: whenever the shared tree type-checks, build it, boot the production
  build on the island, the mainland (`?bridge=8&stage=4`) and the phone preset
  with zero console errors, and push, even while agents are mid-task on other
  files. CI only deploys a build that passes, so a bad snapshot cannot reach the
  site. Check again at least every time an agent reports.
### The mainland, part 1 (land, bridge, streets): pushed Nov 19, about 2:30 AM ET

The mainland town is **Tepid Falls** (Waterville-inspired, all names invented):
the Muddle River with Threadbare Dam, Dithers Hill (college), Lake Indecision,
the Thruway, Sidetrack Yard, Lesser Tepid across the Exact Change Footbridge.
Data in `src/world/mainland.ts` (`SITES`, `EXTRA_LOTS`, `HILL`, `RAIL`, `DECKS`);
the plan's nodes, edges and blocks now carry `land` (0 island, 1 mainland), and
the 801 mainland lots are in `plan.mainlandLots` (empty until part 2).
`src/world/progress.ts`: the bridge is built in 8 spans (250 to 950 points each,
4,800 in all; a dollar at the Bridge Completion Fund box at the bridge foot is a
point, driving trickles 1 point per 60 m, `progress.add(points)` for missions),
then four town stages (mills and Lesser Tepid; Main St, square, yard; college
and The Stacks; exits and lake) behind construction barriers. Test with
`?bridge=8&stage=4` or `__game.bridge(n)` / `__game.stage(n)`.
The full layout table with coordinates is in the part 1 report, summarised in
`tools/briefs/mainland-2-buildings.md`.
Owed: every mainland lot is empty (part 2); the mill pond is drawn 1.2 m above
sea level but swimming still uses WATER_Y (`waterLevelAt` is exported, unused);
at 7 spans a fast car can jump the last gap; trees are island species (no pine or
birch yet); no mist at the falls; police station and release point are island
only; night, rain and phone were not checked on the mainland; "Start over" does
NOT reset bridge progress (deliberate for now: Backspace is also the unstick
key; ask the owner).
### M3 "Trouble": pushed Nov 19, about 1:35 AM ET

`src/sim/police.ts`, `policeAir.ts`: heat only rises for crimes someone could
see; Harbor Patrol cruisers pursue, ram and set roadblocks by level; officers on
foot arrest ("BOOKED", $150 fine, weapons confiscated, release at Harbor Patrol
Station No. 1 on Ledger St) or shoot from heat 3; a helicopter with a spotlight
at heat 4+; "Fresh Coat" respray on Bollard St in the Cannery clears heat.
`src/ent/weapons.ts`: fists, Paperweight (pistol), Stapler (SMG), Gull Duster
(shotgun) and a launcher; over-the-shoulder aim; cars smoke, burn, explode and
leave wrecks; drive-by; pickups at five places; cheat `BADIDEAS`.
Also in this push: the district stamp is now a small tag under the objective
strip, and "Start over" (pause card, or hold Backspace) calls `player.reset()`.
Owed: at heat 1 a player who drives off at once is never reached; parking with
cruisers on your bumper never loses them (escape is only by outrunning);
officers carry no gun model and no flash was seen in stills; no arm or weapon
drawn in a drive-by; recoil never recovers and has not been hand-played; the
HUD does not yet show the search state from the 'heat' event (radar circle,
"searching" pips); `PlayerApi` in api.ts lacks hurt/reset/weapons; police.ts
should call `player.hurt(dmg, from)` for hit direction; weapons.ts copies a
mode number from peds.ts; sirens and gunshots wait for M5.
### M2 "A living city": pushed Nov 18, about 8:40 PM ET

`src/sim/peds.ts` and `traffic.ts` (behind the `Ambient` class in `ambient.ts`):
walkers cross at lights, avoid each other, flee, sit, and are knocked down by any
car ('pedHit' event); AI cars use every lane, stop at lines, queue, overtake,
honk, and react to being cut off or hit. Ten-minute soaks at four places: no
stuck cars, no AI-on-AI collisions, no red-light running, about 0.08 ms.
`src/fx/particles.ts` and `skids.ts`: tyre smoke, skid marks, sparks, debris,
hydrant geyser, splashes, dusts, rain splashes, engine smoke; explosion, fire,
tracers and muzzle flash are built and waiting for M3 (`game.fx.emitters`).
Owed: the city is thin (24 cars, 60 walkers; a junction averages 2 cars and 7
walkers nearby); AI cars still hit 0-3 pedestrians per 10 minutes; overtaking on
two-lane streets is slow; bench sitters hold the driving pose; give-way-to-the-
right never runs (every 3-arm junction has a signal); several effects were never
looked at (foam ring, rain splashes, dusts, engine smoke); old marks code in
vehicle.ts is switched off by `OLD_MARKS`, delete it once the new system has
proved itself; nothing listens to 'pedHit' or plays the horn yet.
Agent briefs live in `tools/briefs/` (a cut-off agent's replacement re-reads the
same brief).
### Realistic rework, step (d) foliage, furniture, land: pushed Nov 18, about 5:20 PM ET

`tools/blender/flora.py` -> `public/models/flora.glb` (plane, maple, oak, cypress,
palm, shrub, hedge; leaf cards, two levels of detail), loaded by
`src/world/floraAssets.ts` and drawn by `TreeField` in `ground.ts`. Street
furniture rebuilt as rounded models in code. Land: pale beach sand with a wet
tide band, a soft foam shoreline, the east coast dressed (dune grass, driftwood,
rocks, hauled-out boats), Strand block cores filled with beds, stalls and courts,
lawn variation and ground cover. `?flora=0` switches the trees back.
Owed: trees cost roughly 2-4 ms in tree-heavy views at high (leaf-card overdraw);
leaf cards read as cards within 5 m; one model per species so rows repeat;
hydrant, mailbox, bin, post, news box and palms were never inspected close up;
Gull Heights verge tufts may sit on driveways; Strand cores are still mostly
paving; lawn variation patches `mats.grass` at runtime and belongs in
materials.ts. Distant haze (sky.ts): thin fog with camera height, cap fog amount
near 0.8, cool the far colour.

**The realistic rework's first pass is complete** (materials and post, cars,
people, foliage and land). Each has a list of improvements above. Next: the
rest of M2, then the add-on lands.
### Realistic rework, step (c) people: pushed Nov 18, about 5:00 PM ET

`tools/blender/people.py` builds two skinned bodies (`public/models/person_f.glb`,
`person_m.glb`, 19 bones, two levels of detail); `src/ent/characterAssets.ts`
loads them and `character.ts` skins the whole crowd in the vertex shader from one
bone texture (4 draw calls). The old box people remain as the fallback until the
files load (`?people=0` forces them). Honest state: people at 5 m and beyond, and
in motion; smooth mannequins up close. Next, in order: a modelled face and head
with separate skin and cloth roughness; clothes with their own silhouette
(collar, jacket, skirt) and a cloth detail texture; a gait pass (feet drift
about a tenth of body travel when running, and the player has no walk, only a
jog); fingers. Not verified: seated pose inside a car, the fall and knocked-down
poses, night, a real phone (the crowd texture is RGBA32F).
Note for tests: models load after boot, so `tools/shot.mjs` taken immediately
shows the old cars and people; wait a few seconds of real time first
(`scratch/distwait.mjs` shows how).
### Realistic rework, step (b) cars: first one pushed Nov 18, about 4:10 PM ET

`tools/blender/cars.py` builds vehicles in Blender (headless) and exports
`public/models/<kind>.glb` with two levels of detail, a wheel, named materials and
baked shading. `src/ent/vehicleAssets.ts` loads them after boot; **add each new
kind to `GLB_KINDS` there** or the game keeps drawing the old procedural shape.
All eleven vehicles are Blender models and live (pushed about 4:40 PM ET). Modeller's own verdict: smooth and correct in silhouette, but lamps are flat panels, bumpers read as separate tubs, the bus doors are slabs, and there are no badges or shut-lines on tailgates; those are the next car improvements. Known: the distance model's
lamps are mangled by decimation (phones see it up close), paint reads satin
rather than glossy, lamp glow sprites sit slightly off the lenses, `?glb=0`
switches the Blender models off.

### Owner request, Nov 18: land

After the realistic rework: (1) finish the parts of the island that still look
like works in progress (empty paved cores in Strand blocks, bare east-coast sand
flats, olive beach sand, distant haze); (2) then start on add-on lands: new
territory beyond the island. The Perpetual Bridge points at a mainland to the
north, which is the natural first one. Order: cars, people, foliage and land
finishing, the rest of M2, then add-on lands.
### Realistic rework, step (a): pushed Nov 18, about 11:50 AM ET

City surfaces are physically based on medium and high (`materials.ts`, with normal
and roughness maps derived in `textures.ts`; glass reflects the sky; roads go
glossy in rain), and `src/core/post.ts` adds ambient occlusion, bloom, one
tone-map and a light grade. Low (phones) keeps the old cheap path. `?pbr=0` and
`?post=0` switch each off for comparison; `tools/pbr-bench.mjs` measures.
Honest state: the gain is modest so far (clearest on glass towers and at night),
and it costs roughly 9 ms a frame downtown at 1080p on Iris Xe. Owed: remove the
teal cast on shadowed roads (`ENV` in materials.ts or the hemisphere light),
retune AO and bloom against the new materials, try FXAA instead of MSAA on the
scene target (saves about 2-3 ms), fade the sun-shadow box edge so it can be
tightened, weathering on surfaces other than facades. Steps (b) cars, (c) people
and (d) foliage and building depth are not started; those are where "low-poly"
actually goes away.
### Test-and-fix round after M1 (pushed Nov 18, about 11:45 AM ET)

Eight testers, nine fixers, one integration gate. Now in: `src/sim/ambient.ts`, a
first cut of M2's living city (about 50 walkers and 18 AI cars that follow lanes,
stop at red lights and queue), lamps and signal masts that shear off when hit
hard, ramps moved so every stunt works, cheats that no longer trigger controls, a
styled health and armor readout, and an opening objective strip. Still open:
walkers ignore each other and never cross streets; AI cars use one lane; the pier
handrail is solid at any speed; the park pond is flat ground; a felled lamp keeps
its light pool; car bodies and people are untouched because the rework replaces
them.
### How M1 was checked, and what was not

Checked on the production build: type-check and build clean; boots with zero
console errors on desktop and the phone preset; 119 to 180 draw calls and 0.5 to
0.8 million triangles; a scripted walk, get-in, drive, steer, get-out; the bridge
jump into the sea and the swim back; collision audit (no building on a road, no
overlap between builders); drawn surfaces against `groundAt()` on the pier, bridge
and breakwater.

Not yet checked (this is the next job, before M2): an independent test pass. The
testers' briefs are written and ready in the session's workflow script; they
cover first impression, art by day and night, landmarks, vehicle looks, driving
feel, on foot, HUD, touch, performance and two code reviews.

Known problems from integration:
- The opening camera is side-on to Dess with a palm trunk mid-frame.
- From very far away the island is nearly lost in haze (fog is tuned for street level).
- Dess is almost black at night and against a sunset: no fill light on people.
- The quick-reference card sometimes shows half-faded; the district stamp can be stale after a teleport.
- The cannery ramp straddles a curb, so one half sits 0.16 m higher.
- Some Gull Heights yard details have no collision; the "BRIDGE OUT" sign overlaps a signal pole.
- The JS bundle is one 800 kB chunk. Nothing has been measured on a real phone.
- Not exercised: gamepad, pointer lock, real touch hardware, death and respawn in the full game.

### How to work on this without wasting the owner's credit

The owner's plan has a 5-hour usage window, and it is the real constraint. Two
runs died to it: a dozen agents at once emptied the window in about 20 minutes
and killed everything in flight. What worked:
- Tell every builder to get a complete first version onto disk early, then improve it in place. A cut-off then loses little.
- Cap look-and-improve rounds (two) and screenshots (about ten) per agent.
- One integrator with a fresh context, after the builders, is cheap and effective.
- Commit and push after every stage, even when the tree does not build: before the switch-over that was harmless; now use a branch or keep `main` building.
- Do not run later-milestone work alongside the current milestone: it competes for the same window.

### Deployment

Every push to any branch runs `.github/workflows/deploy.yml`: `npm ci`,
`npm run build`, publish `dist/`. If the build fails nothing is deployed and the
site keeps the last good build, so **`main` must always pass `npm run build`**.
GitHub Pages is set to deploy from GitHub Actions (it was "deploy from branch"
until the switch-over, which would have served the raw source page). The custom
domain comes from the Pages setting and from `public/CNAME`.

## Tech decisions

- TypeScript (strict) + Vite + three.js 0.167. `vite.config.ts` uses `base: './'`.
- No physics library: custom arcade physics. No external art or audio: everything is procedural (canvas textures, WebAudio).
- Fonts are installed from npm and bundled: `@fontsource/big-shoulders-display` (headlines), `@fontsource/barlow-semi-condensed` (text), `@fontsource/ibm-plex-mono` (numbers). Import only the `latin-*.css` files. Await `document.fonts.load(...)` before drawing sign textures.
- Variable time step clamped to 0.05 s; vehicle physics sub-steps at 1/120 s.
- One `Game` object holds every subsystem; subsystems take `game` in their constructor.
- Testing: Playwright 1.64.0 is a dev dependency (pinned to match the Chromium already on the owner's PC; never run `playwright install`), and WebGL runs on the real GPU there. Use `tools/pw.mjs`. Expose `window.__game` with `step(n, dt)`, `teleport`, `setTime`, `setHeat`, `spawnVehicle` so tests can run the simulation without waiting on real time. After each milestone: `npx tsc --noEmit`, `npm run build`, boot the build headless, fail on any console error, look at a screenshot.

## World conventions (already in code)

Meters and seconds, Y up. East = +X, South = +Z. Heading `h`: forward =
`(sin h, 0, cos h)`, right = `(-cos h, 0, sin h)`; turning right *decreases*
`h`. Models face +Z. Traffic drives on the right. Streets are at height 0,
city blocks one curb (0.16) higher, water at -0.8.

## The city

An island about 0.85 mi wide. Districts: Gull Heights (suburbs, north), Ledger
District (downtown towers), Tinker Row (mid-rise, west), Fishbone (old town,
east), The Cannery (industrial, south-west), Saltwater Strand (boardwalk, south),
Dock Seven (container port, south-east), Mercy Park, Flounder Field (arena).
Landmarks: Pelican Pier with a Ferris wheel, Last Light Breakwater and
lighthouse, and the Perpetual Bridge, which climbs north out of town and simply
stops (it is the biggest stunt jump).

## Art direction

Sun-bleached harbor travel poster, not neon. Palette: ink navy `#14213D`, bone
`#F2E8CF`, vermilion `#E4572E`, mustard `#F0A202`, sea teal `#2A9D8F`, plus brick,
terracotta and sage for buildings. Cream sea fog in the mornings, sodium-yellow
street lamps at night. Avoid the usual AI look: no purple gradients, glassy
cards, glow on everything, pill buttons or emoji icons.

HUD is flat and print-like ("Harbor Authority paperwork"): a round radar drawn
as a nautical chart with health and armor as arcs around it; "HEAT" shown as
five beacon pips (not stars); money in mono numerals; district names stamped in
large condensed type; objective text on a navy strip with a vermilion rule.
Original wording for fail states (for example "CLOCKED OUT" and "BOOKED").

## Remaining work, in order (push to `main` after each)

**M1 — First playable (DONE; test-and-polish pass still owed)**
- `world/textures.ts`: canvas textures. Four facade styles (8x8 windows each, color + night-glow map), street and avenue surfaces with lane lines matching the traffic lanes (street lanes at ±1.75 m; avenue lanes at ±1.8 and ±5.2 m), a sign atlas, glow sprite.
- `world/buildings.ts`: per-district generators that fill each lot and register collision boxes: towers, mid-rises with shopfronts, rowhouses, houses with yards, warehouses, container stacks, boardwalk shops.
- `world/world.ts`: terrain mesh from `terrainAt` (drop it 6 cm on land to avoid flicker against roads), roads, crosswalks, sidewalks, lamps with additive light pools, traffic lights (26 s cycle: 10 green, 2.5 yellow, 0.5 all-red per axis, offset by `node.phase`), instanced trees and props, park, arena, pier, lighthouse, bridge, ramps, water shader, `setNight(n)`.
- `world/sky.ts`: sky dome shader (gradient, sun, moon, stars, drifting clouds), sun and hemisphere lights, time-of-day palette, fog, weather (clear, overcast, fog, rain).
- `ent/vehicle.ts`: about ten original vehicle types built from an extruded side profile; physics as designed below; wheels as one instanced mesh.
- `ent/character.ts`: instanced box-limb people (about 13 parts, about 13 draw calls for everyone) with walk, run, jump, swim and knocked-down poses.
- `ent/player.ts`, `core/camera.ts`, `ui/hud.ts` + CSS, `ui/touch.ts`, `core/game.ts`, `main.ts`, title screen.

**M2 — A living city (DONE, first pass):** traffic on lane rails that obeys lights and turns into physical cars when hit; pedestrians on sidewalk loops who cross at lights, flee, and get knocked over; parked cars; particles, skid marks, breakable props (hydrants geyser).

**M3 — Trouble (DONE, first pass):** heat levels 1-5, police on foot and in cruisers using route-finding, roadblocks, a helicopter with a spotlight at high heat, losing them by breaking line of sight, respray shop; weapons (fists, pistol, SMG, shotgun, launcher), aiming, vehicle damage, fire and explosions.

**M4 — Things to do (DONE, first pass, unplayed by hand):** about ten story missions from a small step-based script format (go to, get vehicle, deliver, collect, destroy, lose heat, tail, race, survive, dialogue); taxi fares, street races, courier runs, stunt jumps, 30 hidden golden rubber ducks; shops, money, autosave to `localStorage`, pause menu with full map and settings.

**M5 — Sound (DONE, first pass, unheard):** procedural engine, tires, impacts, sirens, horn, gunshots, sea and gulls, rain; radio stations with generated music.

**M6 — Polish:** bloom at night, quality presets with auto-detect for phones, performance pass, bug bash.

## Vehicle physics design

Split velocity into forward and sideways parts. Engine force falls off toward
top speed; brake key brakes, then reverses. Yaw rate = `-forwardSpeed *
tan(steer) / wheelbase` (steer limit shrinks with speed). Sideways speed decays
by `exp(-grip * dt)`; grip drops to about a quarter with the handbrake and about
half once sliding, which gives drifts. Height: apply gravity, and if the
predicted height is below `groundAt`, snap to the ground and set vertical speed
to the ground-following speed, so ramps launch cars naturally. A sudden rise
over 0.7 m counts as a wall. Car-versus-building uses a rotated-box test with
push-out, bounce, spin and damage; car-versus-car exchanges impulses by mass.

## Story and humor

Lead character: Odessa "Dess" Marlowe, a tow-truck driver whose yard was seized
by the Harbor Authority. Contacts: Barnacle Finch (fence with a bait shop),
Councilwoman Priya Vance, Gus the arcade accountant; rivals: the Gull Syndicate.

Easter eggs to include: a giant rubber duck in the harbor that honks when hit; a
seagull named Gerald who steals pocket change on the pier; a UFO over the
lighthouse at 3 AM; a "Room 404" door on a building with no doorway; typed cheat
words; pun shop signs ("Squid Pro Quo Legal", "Pier Pressure Tattoo", "Gull &
Void Insurance", "Prawn Shop"); a billboard for "WDOOF 99.9 — Radio for
Doofuses"; and a pause-menu stat reading "Mistakes made: 0*".
