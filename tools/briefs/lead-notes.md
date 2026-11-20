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
