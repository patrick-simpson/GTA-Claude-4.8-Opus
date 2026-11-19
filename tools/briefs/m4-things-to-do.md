# Brief: M4 — things to do

Read tools/briefs/common.md first and follow it. Its limits are raised for this task (about 160 tool
calls, 30 images); its other rules stand, and no git commands that change state at all.

Read PLAN.md in full first: milestone M4, "Story and humor", "Owner decisions, Nov 18 evening"
(slow, continual progression; the bridge to Tepid Falls is built span by span from progress points),
the M2, M3 and mainland notes. Then src/core/api.ts, game.ts, src/world/progress.ts
(`progress.add(points)`, spans, stages), src/world/plan.ts (findPath, sidewalkPoint, curbPoint,
districts, RAMPS), src/sim/police.ts (heat, 'booked', station and shop positions), src/ent/weapons.ts,
src/ent/player.ts (money, reset()), src/ui/hud.ts (objective strip, toast, tag, stamp, radar),
src/ui/touch.ts, src/core/cheats.ts. Other engineers are working on vegetation (src/world/ground.ts,
floraAssets.ts, tools/blender/) and possibly on car and people models: touch none of those files.

YOU OWN: new files under src/game/ (script.ts, missions.ts, activities.ts, save.ts and whatever else
you need), new src/ui/menu.ts and menu.css, the registration lines in src/core/game.ts, append-only
additions to src/core/api.ts, and the parts of src/ui/hud.ts, hud.css and touch.ts that the new
features need (radar markers and route line, subtitles, timers, the pause card becoming the menu).

The tone: dry, absurd, played straight. Original characters and writing only. The lead is Odessa
"Dess" Marlowe, a tow-truck driver whose yard was seized by the Harbor Authority. Contacts: Barnacle
Finch (a fence who runs a bait shop on the Strand; fishing metaphors that do not quite work),
Councilwoman Priya Vance (polished, always campaigning, plays every side), Gus (an accountant who
works out of the back of an arcade and pays in tokens when he can); rivals: the Gull Syndicate (take
themselves very seriously; named after seabirds); the Harbor Authority (faceless paperwork).

Do it in this order, each step working in the game before the next:

1. SAVE. src/game/save.ts: one versioned JSON document in localStorage: player (money, position,
   health, weapons and ammo), progress (already saved by progress.ts: fold it in or leave it and say
   which), missions done, collectibles, stats, settings. Autosave at most every 10 s and on pagehide;
   tolerate missing, corrupt or old data without throwing. Loading the page continues where you left
   off (position, money, time of day). "Start over" (player.reset()) asks whether to wipe the save and
   the bridge progress too: make the pause-card button a full new game with a clear confirmation, and
   keep hold-Backspace as a simple unstick that wipes nothing.
2. MISSION SCRIPT. src/game/script.ts: a small typed step-based mission format and a runner: go to a
   place (on foot, in any vehicle, in a specific one), get a vehicle, deliver, collect, destroy, lose
   heat, tail, race through checkpoints, survive a timer, dialogue (subtitles with speaker names),
   plus spawn/despawn actors and vehicles, give money, set heat, timers with an on-screen countdown,
   checkpoints and retry, fail conditions with original wording ("CLOCKED OUT", "BOOKED", "THE TRAIL
   WENT COLD"). Markers and a route line on the radar (plan.findPath), a marker in the world (a
   tall soft beam or ring in the particle or glow style, not a copy of any game's marker).
3. THE STORY. src/game/missions.ts: ten story missions in order that teach the game and escalate,
   using every step type at least once, each with a title that winks, an intro, dialogue in voice at
   the start, middle and end, fair fail conditions, a money reward and progress points
   (`progress.add`), and what it unlocks. Givers stand at fixed real spots (Finch's bait shop and Gus's
   arcade on the Strand, Vance's office downtown, Dess's seized yard in the Cannery; find the actual
   buildings and signs in src/world/buildings.ts) as a person you walk up to, with a radar icon.
   The arc: getting the truck back to work; jobs for Finch, Gus and Vance; run-ins with the Gull
   Syndicate; and a finale tied to the bridge. Because the bridge is built from progress, pace the
   story so the island missions fund roughly the first half of the bridge, and add at least three
   further missions set in Tepid Falls that unlock as its stages open (a mill job, a college job, a
   thruway job), so there is always something new: slow, continual progression.
4. ACTIVITIES. src/game/activities.ts: taxi fares in the Calamity Cab (pick-up and drop-off across
   districts, fare by route length, tip that melts with time and bumps, passenger one-liners); street
   races on six named routes with checkpoints and par times; courier runs in the van; stunt jumps at
   every ramp with scoring from airtime and distance and dry result lines; thirty hidden golden rubber
   ducks spread over the island and Tepid Falls (each on walkable ground outside any building: verify
   against collision), with a counter and a reward at ten, twenty and thirty; towing jobs in the tow
   truck (hook a marked car and haul it to a yard: a simple rigid tow is fine). Every activity pays
   money and progress points, with repeat payouts that taper so nothing can be farmed.
5. THE MENU. src/ui/menu.ts: the pause card becomes a Harbor Authority dossier with tabs: MAP (the
   whole world as a nautical chart on a canvas from the plan: both lands, the bridge with its built
   spans, street and district names, the player, mission and activity markers, collected ducks; zoom
   and pan with mouse, touch and gamepad; click to set a waypoint that draws a route on the radar),
   PROGRESS (bridge spans, town stages, missions, ducks, stunt jumps, as a filled-in form), STATS
   (distance driven and walked, cars borrowed, top speed, airtime record, times booked, ending with
   "Mistakes made: 0*" and its footnote), SETTINGS (mouse sensitivity, invert Y, quality, full screen
   on tap, reduced motion; sound volumes greyed until M5), CONTROLS, Resume, New game. Usable with
   mouse, keyboard, touch and gamepad; flat paperwork style; opacity and transform animations only.
6. SHOPS AND MONEY SINKS, if budget remains: an ammunition counter and a body shop that repairs the
   car you are in, each at a real building with a sign, so money has uses beside the bridge fund.

CHECK: play each mission through by script with a competent scripted player and assert it can be
passed, and once failing to see the fail path and retry; reload the page mid-mission and mid-game and
confirm the save restores; each activity run once with its payout; all thirty duck positions verified
walkable and outside collision; the menu on desktop, at 1920x1080 and on the phone layout (stills of
each tab); a 10-minute soak of normal play with saving on, no errors. Stills of a mission giver, a
dialogue subtitle, a world marker, a race checkpoint, the map tab.
