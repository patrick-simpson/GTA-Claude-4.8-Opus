# Lead notes (whoever holds the session reads this first after a restart)

The session that built M1-M5 died to the usage limit on Nov 19, 9:58 PM ET, with two workers in
flight. A new lead session took over on Nov 20. PLAN.md is still the handoff; this file holds the
owner's ground rules for the takeover and the running state.

## Owner's ground rules (Nov 20, 2026)

- Do both unfinished jobs: cars pass two first, then M6 (tools/briefs/m6-polish.md).
- Push often, so people checking gta.doofus.live keep seeing new things. Push each finished change
  (PLAN.md "Push updates regularly" says how to check a build before pushing).
- Work slowly. The owner would rather the job take longer than have the 5-hour window burn out early.
  ONE worker at a time. Small tasks, each ending in something pushable.
- Usage limits: inside a 5-hour window the job may use all of it, but spread out so 100% is reached
  only near the end. For the week, stop at 95% and wait for the weekly reset (Sunday 4 PM ET).
  The gauge: the lead's own session events of kind `rate_limit_event` carry
  `unifiedWindows.five_hour.utilization` and `seven_day.utilization` (0 to 1) with reset times.
  Check it before starting each worker; if usage is ahead of the clock, wait.
- Models: the top model for craft work (car models, performance fixes, lighting, integration);
  Sonnet for routine work (running the benchmark, scripted play-testing, small owed-list fixes).
- Tell the owner at each push: what changed and usage so far. No five-minute check-ins on this job.
  Also say so if work pauses or stalls.
- A scheduled task "Resume GTA work" fires into the lead session every 5 hours in case it stalls.
  Delete it when both jobs are done.
- Laptop rules that still apply: Blender runs with its window showing (no `--background`), and
  heavy work pauses at 20% battery until 80%. On battery the laptop sleeps after 3 minutes, so it
  must stay plugged in.

## State

- Nov 20, 4:30 AM ET: tree has uncommitted car work (all twelve models and maps, vehicle.ts,
  vehicleAssets.ts, cars.py) and the start of M6 (tools/bench.mjs, src/core/post.ts). It type-checks.
  The car worker's scratch is scratch/cars2/ (p1.py-p6.py are its patches in order; p6 merges every
  kind's maps into one pair of sheets because per-kind materials cost frame time; bench-loop.txt has
  its timings). Not yet run in the game since the cut-off.
- Nov 20, 5:25 AM ET: pushed a251577 (cars share one pair of sheets; PLAN.md has the entry and the
  owed list for steps A-E). The M6 worker's half-done post.ts change (FXAA in place of MSAA) is NOT
  in the tree: it is saved as scratch/m6/post.wip.ts and post.wip.patch for the M6 pass to pick up.
  One unit (a worker plus a Sonnet checker, about 30 minutes) costs about 10% of a 5-hour window and
  about 1% of the week. Units are run through one reusable workflow script ("game-unit").
- Car units planned, in order: (1) Bolt face + taxi far-level band [running 5:30 AM]; (2) paint and
  reflections, send only the new sheet cell at load; (3) surfacing: mirrors, handles, bumper notch;
  (4) inspect the rest (bus face, cabins, night lamps), roughness maps if budget allows. Then M6 in
  the order of its brief, starting from scratch/m6 and tools/bench.mjs.
- Nov 20, 6:00 AM ET: pushed 16af28d (Bolt face, taxi far-level band; deploy succeeded). Gauge then:
  5-hour window 29% with 37% of it gone (resets 9:10 AM ET), week 68%. A full window costs about 15%
  of the week, so about 27 weekly points were left before the 95% stop: roughly 15 more units.
  Car unit (2), paint and reflections plus the sheet re-send fix, launched 6:02 AM. Still to come:
  (3) surfacing, (4) inspect the rest and re-export the ten kinds with the shallower lamp relief.
- Nov 20, 6:50 AM ET: pushed the paint step (dark paint without blotches, cell-only sheet sends).
  Gauge at 6:42 AM: window 42% with 51% gone, week 70%. Next: car unit (3) known flaws + re-export
  all twelve, then (4) inspect the uninspected kinds; then M6. Budget: about 13 units to the 95% stop,
  so cars get two more units at most and M6 the rest.
- Nov 20, 7:05 AM ET: OWNER REQUEST: add their 2015 grey Ford C-Max (kind `cmax`), using the measured
  shape from the other project at C:/Users/User/cmax; not beside the Bolt; parked somewhere and/or in
  traffic. Brief: tools/briefs/cmax.md. Runs NEXT, right after the "car flaws, re-export all" unit
  (same files, so not at the same time), as two units: (a) model + registration + one parked,
  (b) likeness pass against the other project's renders, traffic, night. Then M6. The separate
  "inspect the uninspected kinds" car unit is dropped unless budget is left after M6.
- OWNER RULE (Nov 20, 7:10 AM): every update to the owner states a percentage complete. Count used:
  steps pushed out of steps planned for the takeover job. Plan as of now is 14 steps: car pass two
  x4 (three pushed, the fourth running), C-Max x2, M6 x8 (measure, the frame x2, auto quality,
  loading, owed list, bug bash, night). Say so when a new request changes the total.
- Nov 20, 7:40 AM ET: pushed car unit 4 (lamps, bumpers, mirrors, handles; all twelve re-exported).
  4 of 14 steps done. Gauge at 7:34 AM: window 56% with 68% gone (resets 9:10 AM), week 72%. One unit
  costs about 12 window points and 2 weekly points, so about 11 units remain before the 95% stop and
  10 are planned. C-Max unit (a) launched 7:42 AM.
- Nov 20, 8:20 AM ET: pushed C-Max part one (kind `cmax`, one parked at Mercy Park, x 138 z -28.6).
  5 of 14 steps done. Part two (likeness, traffic, dent and rust chip, and the fit_bumper sign bug on
  the other kinds) launched right after.
  Gauge at 8:10 AM: window 71% with 80% gone (resets 9:10 AM ET), week 75%. About 10 units left
  before the 95% stop; 9 planned (C-Max part two running, then M6 x8).
- Nov 20, 8:55 AM ET: pushed C-Max part two (likeness by measurement, traffic, dent and rust chip)
  and the bumper sign fix on the other twelve. 6 of 14 steps done. The cars are finished for now;
  M6 starts. M6 is planned as 7 units (measure is merged with the first frame fix), so the total is
  13 steps and 6 are done.
  Gauge at 8:49 AM: window 84% (resets 9:10 AM ET), week 77%: about 9 units left before the 95% stop,
  7 planned. M6 unit 1 (baseline + FXAA from scratch/m6/post.wip.ts) launched 8:48 AM. M6 units after
  it: (2) the frame, next biggest costs; (3) quality that chooses itself; (4) loading; (5) the owed
  list; (6) bug bash; (7) night. The M6 brief has a RESTARTED section at its top.
- Nov 20, 10:00 AM ET: pushed M6 step 1 (baseline; high = 2x MSAA + FXAA, AO 8). 7 of 13 steps done.
  Gauge at 9:52 AM: NEW window 9% (resets 2:10 PM ET), week 79%: about 8 units left before the 95%
  stop, 6 planned. M6 unit 2 (why moving costs 23-29 ms against 13-16 standing; then leaf cards and
  the bloom chain) launched right after.
- Nov 20, 11:15 AM ET: pushed M6 step 2 (flip.ts: 51 to 65 fps at high downtown in the real loop).
  8 of 13 steps done. Gauge at 11:10 AM: window 24% with 40% gone (resets 2:10 PM ET), week 82%.
  That unit cost 3 weekly points (it ran 76 minutes), so only 4 to 6 units fit before the 95% stop.
  Remaining five, in order of value to visitors: (3) quality that chooses itself [top model];
  (4) loading [top model]; (5) the owed list [Sonnet]; (6) bug bash [Sonnet]; (7) night [top model].
  More frame work (leaf cards, the post pass) is dropped unless budget is left. If the week reaches
  95% first, stop, tell the owner what is left, and resume after Sunday 4 PM ET.
- Nov 20, 12:05 PM ET: pushed M6 step 3 (governor.ts, Auto quality). 9 of 13 steps done. Gauge at
  noon: window 40% with 57% gone (resets 2:10 PM ET), week 84%: 11 points left. Remaining four:
  loading [top, launched 12:07 PM], owed list [Sonnet], bug bash [Sonnet], night [top].
  NOTE: a harness boot with no ?q= is now Auto; pass ?q= for anything compared between runs.
- Nov 20, 12:30 PM ET: OWNER REQUEST: live multiplayer, as ONE FULLY SHARED WORLD. Decisions and the
  design are in tools/briefs/multiplayer.md (finish M6 first; service deployed from the kvbcawana
  repo, which holds the Cloudflare secrets; one public city only; made-up names, no typing). It
  starts after M6, which in practice means after the weekly reset on Sunday Nov 22, 4 PM ET. About
  15 to 25 more steps, so the job's total is now about 33 steps, not 13. Percentages given to the
  owner: say both "the original job" and "with multiplayer".
- Nov 20, 12:50 PM ET: pushed M6 step 4 (loading: cars_far.glb for phones, assets.ts queue, the hold).
  10 of 13 original steps done. Gauge at 12:39 PM: window 54% (resets 2:10 PM ET), week 86%: 9 points
  left. Remaining three: owed list [Sonnet, launched 12:52 PM], bug bash [Sonnet], night [top].
- Nov 20, 1:20 PM ET: pushed M6 step 5 (the owed list, by Sonnet). 11 of 13 original steps done.
  Gauge at 1:11 PM: window 58% (resets 2:10 PM ET), week 87%: 8 points left. LEAD FOUND: flipcheck
  fails intermittently (about 1 check in 50, night rain and Gull Heights frame 52) on the live build
  too, so it predates step 5; see PLAN.md. Next unit [top model]: that stale frame first, then the
  scripted bug bash. Then night lighting if the week allows.
- Nov 20, 2:15 PM ET: M6 step 6 done (bug bash). The "stale frame" was a false alarm in the check;
  scripted play found nothing broken; no game code changed, PLAN.md has the list of oddities found.
  12 of 13 original steps done. Gauge at 2:10 PM: NEW window 0% (resets 7:10 PM ET), week 90%:
  5 points left. Last M6 unit, night lighting [top model], launched 2:17 PM. After it: STOP for the
  week unless it is under 93%; multiplayer starts after Sunday Nov 22, 4 PM ET (see multiplayer.md).
- Nov 20, 3:00 PM ET: pushed M6 step 7 (night). M6 IS COMPLETE: 13 of 13 original steps done.
  Gauge at 2:51 PM: window 12% (resets 7:10 PM ET), week 91%: 4 points left before the 95% stop.
  One small Sonnet unit on the oddities the bug bash found fits (about 1 point); then STOP for the
  week. Multiplayer (tools/briefs/multiplayer.md) starts after Sunday Nov 22, 4 PM ET.
