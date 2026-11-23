# Brief: quality testing and optimisation after multiplayer (Nov 23)

Read tools/briefs/common.md, then the top entries of PLAN.md (everything dated Nov 21 to Nov 23 is the
multiplayer job; the Nov 20 entries are M6). HANDOFF.md section 4 lists the measurement tools.

The multiplayer job was built by an agent WITHOUT this laptop: no GPU, so every frame-rate figure,
every "smooth" judgement and every real-browser check since Nov 21 is missing. You ARE on the laptop
(Windows, Intel Iris Xe plus an RTX 4050, Chrome, Playwright's Chromium). Use it fully.

Rules for this job (they override common.md where they differ):
- You may run `npm run build`, `npm ci` in server/, and the server's local tests (`server/README.md`).
- Heavy runs are fine. Battery: check `(Get-CimInstance Win32_Battery).EstimatedChargeRemaining`
  before long runs; at 20% or below wait until 80%.
- No git commands that change state. The lead commits and pushes.
- Never put the owner's name, email or any secret in the repo.
- Limits: about 90 tool calls and 16 pictures. Keep long outputs in files under scratch/qa/.

## What to do, in order

1. FRAME RATE AFTER MULTIPLAYER. On the GPU, with the real-loop probe (tools/lead/rafprobe.mjs
   --vsync), compare today's main against commit 9f3c5de (the last M6 build; check it out into a
   separate worktree under scratch/qa/base, never in the main tree): high downtown, Gull Heights,
   Main St in Tepid Falls; standing and moving; single player. Then with multiplayer running: two to
   four browsers in one town on a local server (the tools/net/ tests and server/README show how to
   run the service locally), measuring the HOST and a GUEST. Any instance buffer the net code
   rewrites every frame must be registered with game.flip (src/core/flip.ts); run
   tools/lead/flipcheck.mjs --q high. Find and fix what costs frames.
2. REAL BROWSERS. Run the production build in headed Chrome on the laptop's screen (not headless) on
   both GPUs if you can choose (Chrome flag or Windows graphics settings; say what you managed), at
   1920x1080 and on the laptop's own display. Report real frame rates, hitches you can see, and
   whether Auto quality (src/core/governor.ts) chooses sensibly on each GPU. Two headed windows
   playing together: is the other player's movement smooth?
3. THE OPEN FAULTS listed under "Still wrong or untested" in PLAN.md's newest entry: reproduce the
   two flaky ones (story.mjs "park the same kerb cars", cars.mjs section 6) with repeated runs now
   that real speed is available, and fix what is real. Kept town cars growing past 40 in the soak:
   find out whether it levels off.
4. SOAK on real hardware: four players, 30 minutes, heap and GPU memory sampled each minute.

Report: tables before and after for every measurement, every fault found (fixed or left, why),
pictures that show anything wrong, and the next optimisations worth doing with numbers.
