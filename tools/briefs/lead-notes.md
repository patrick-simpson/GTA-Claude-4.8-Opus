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
