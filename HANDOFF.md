# Port Calamity: handoff to the next lead agent

Written Saturday Nov 21, 2026, about 8:30 AM ET, by the lead session that ran Nov 20. The owner is
closing that session and starting a new one. Read this file, then `PLAN.md` (the entries dated Nov 20
at the top of "Where things stand"), then `tools/briefs/multiplayer.md`. That is enough to carry on.

To take over, the owner only needs to give a new agent this repository and tell it:
"Read HANDOFF.md at the root of the repository (main branch) and take over as lead."

> **Update, Nov 23, 2026, about 6:20 AM ET: the multiplayer job this file handed over is FINISHED.** All five
> stages are live on main, still protocol version 4. Read the top entries of "Where things stand" in `PLAN.md` (the
> newest is "Multiplayer stage 5, hardening part 2") for what was built, measured and left open, and the last lines
> of `tools/briefs/lead-notes.md` for how the work was run. Owner decisions are in `tools/briefs/multiplayer.md`
> (1 to 15). Section 5 below is history. What a person still has to do: play it with friends on real hardware and
> listen to it; decide whether the backup should send at 5 a second (PLAN.md, the cost count).

## 0. You do not have the owner's laptop (read this first)

The session that wrote this ran ON the owner's Windows laptop. The owner has decided the next lead
works WITHOUT it, from a session that has only this repository. Everything you need is in the
repository; paths below that begin `C:\Users\User\` are the laptop's and are not yours to use.
What changes for you:

- **Set up:** clone, `npm ci`, then `npx tsc --noEmit` and `npm run build` work anywhere. The test
  harness (`tools/pw.mjs`, `tools/shot.mjs`) needs Playwright's Chromium; use the one your
  environment provides (if the pinned version does not match, pass its executable path to
  `chromium.launch` in `tools/pw.mjs` rather than installing another browser).
- **No GPU.** Without one the browser draws in software: pictures are right but slow, and frame
  times mean nothing. Use boots with empty error lists, pictures, counts (draw calls, uploads,
  messages) and logic tests. Do NOT quote frame rates or compare with the numbers in `PLAN.md`
  (those are from the laptop's Iris Xe); list performance as owed for a later check on real hardware.
- **No Blender.** You cannot rebuild the car, people, tree or prop models (`tools/blender/*.py`
  write the files in `public/models`). Do not change those scripts or files; if a job needs a
  model changed, tell the owner it needs the laptop. Multiplayer needs none of it.
- **No scratch folder.** `scratch/` and `shots/` were never in git. The tools that mattered are
  copied to `tools/lead/`; the findings that mattered are in `PLAN.md`. Where this file or
  `PLAN.md` names a `scratch/...` file, treat it as gone.
- **The second repository.** Multiplayer's service is deployed by a workflow in the owner's
  `kvbcawana` repository (same GitHub account), which holds the Cloudflare secrets. Ask your
  environment for access to it when you reach that step; the deploy itself runs in GitHub Actions,
  so it needs nothing from the laptop.
- **Pushing and deploying work as before:** every push to `main` here builds and publishes the
  site through GitHub Actions. If `gh` is not available to you, confirm a deploy by fetching
  https://gta.doofus.live/ and checking that the script names in its HTML match your `dist/`.
- **Rules 9 and 10 below (Blender's window, the battery) apply only on the laptop.** All the other
  rules apply to you in full.

## 1. Where things stand

- **Everything asked for before multiplayer is done, pushed and live** at https://gta.doofus.live
  (`main`, last game commit 9f3c5de). The tree is clean. Nothing is half-done.
  - Cars, all-out pass two: shared texture sheets, the Bolt's face, paint, lamps, bumpers, mirrors.
  - The owner's 2015 Ford C-Max (kind `cmax`), parked at Mercy Park and in traffic.
  - M6 complete: benchmark, cheaper antialiasing, the two-copy instance buffers (51 to 65 fps at
    high downtown on this laptop), quality that chooses itself, loading, the owed list, the bug
    bash, night, interface leftovers.
- **Next job: live multiplayer**, not started. The owner's decisions, the design and five stages
  are in `tools/briefs/multiplayer.md`. Start with stage 1 (the message service, seeing each other).
- **It must not start before the weekly usage reset: Sunday Nov 22, 4:00 PM ET.** The week stood at
  95% when this was written, which is the owner's stop.
- By the count given to the owner: the original job is 100% done; with multiplayer (about 20 more
  steps) the whole job is about 39% (13 of roughly 33 steps).

## 2. The owner's ground rules (these are instructions, not suggestions)

1. **Push often**, so people watching the site keep seeing new things. Push each finished change.
2. **Work slowly; do not burn the usage.** One worker at a time, in small steps that each end in a
   push. The owner would rather the job take longer than have a 5-hour window emptied early.
3. **Usage limits, and the weekly cap above all.** The owner's plan has a 5-hour window and a
   WEEKLY limit shared with everything else the owner does; the weekly one is the real constraint.
   - **The week: stop at 95%** and wait for the weekly reset (it fell on Sunday at 4:00 PM ET in
     November 2026; read the real reset time from the gauge). The last 5% is the owner's reserve.
   - **Do not start a step that could cross the stop.** A top-model step costs 2 to 3 points of the
     week, so start none above 92%; a Sonnet step costs about 1, so start none above 94%.
   - **Budget the week before spending it.** At the start of each week read the gauge, count the
     points left to 95%, and plan the steps to fit, cheapest model that does each job (rule 4). If
     the job cannot finish this week, say so to the owner early, with what will wait.
   - **Inside a 5-hour window** use all of it, but spread out, reaching 100% only near the end.
   - **Your own turns cost too.** Report at each push and otherwise stay quiet; do not poll.
4. **Use the cheapest model that does the job well.** This is the owner's standing decision
   (`PLAN.md`, "Owner decisions since M1", item 2), and it is how the weekly cap is kept:
   - **Haiku** for fixed-recipe work: running a script and reporting its numbers, taking a set of
     screenshots, counting messages or bytes, validating data, checking that a build boots.
   - **Sonnet** for well-specified code and small fixes with a clear way to reproduce them,
     scripted play-testing, and every independent check of another worker's step.
   - **The top model** only for work that needs judgement: design, protocol and architecture,
     driving feel, art and lighting, performance work, integration, hard or unexplained bugs.
   Choose per step, and say in each report which model did what. If a cheaper model's step fails
   its check twice, move that step up one model rather than repeating it.
5. **Tell the owner at each push** what changed, honestly, with usage so far. No five-minute
   check-ins on this job. Say so plainly if work pauses or stalls.
6. **Every update starts with a percentage complete** (steps pushed out of steps planned; say so
   when a new request changes the total).
7. **A scheduled task every 5 hours that fires into the lead's own session**, to resume the work if
   it stops. The old session's tasks were deleted with it: CREATE YOUR OWN, and delete it when the
   whole job is done. While paused for the weekly reset, switch it off and use a single one-off
   wake-up at the reset instead (see section 6 for why).
8. **Questions: ask first, one at a time**, until you understand. Then act without asking again.
9. **Blender runs with its window showing**, never `--background` or `-b` (the owner watches the
   laptop). `tools/blender/cars.py` works that way; its header shows the command.
10. **Battery:** before heavy work check the charge; at 20% or below start nothing heavy and wait
    until 80%. On battery the laptop sleeps after 3 minutes, so it must stay plugged in.
11. **Where the work runs.** The owner used to want everything done on the laptop (Blender 5.2, the
    GPU and the C-Max source project are there). On Nov 21 the owner chose to hand the work to an
    agent without the laptop: see section 0 for what that rules out.
12. **Privacy.** The site and this repo are public. Never put the owner's name, email, real licence
    plate, VIN, photographs, account or session identifiers, or secrets in the repo or in commits.

The owner follows from a phone, reads the reports, and judges by the live site. Write reports for
someone who has not been watching: full sentences, what changed, what was checked, what is still
wrong.

## 3. How the work was run (it held a 5-hour window for the full five hours)

**One unit = one pushable step.** A worker builds it; a second, independent worker (Sonnet) checks
it in the running game without being told the first one's conclusions; if the check finds
blockers, one repair round and a re-check. Then the lead verifies, pushes and reports.

- `tools/lead/game-unit.workflow.js` is the Workflow script used for every unit after the first.
  Run it with the Workflow tool (`scriptPath`) and `args`:
  `{ label, brief, task, files, checkFocus, builderModel?: 'sonnet', blender: true|false }`.
  `brief` is a file under `tools/briefs/`; `task` and `checkFocus` are written fresh for each unit.
- `tools/briefs/common.md` holds the rules every worker follows (limits of about 60 tool calls and
  14 pictures; no git commands that change state; never leave the tree unbootable). Raise the
  limits in the task text only when a step needs it.
- Write tasks as: what is wrong and why it matters, the order to work in, "get a complete first
  version in early", what to measure, what to report. Write check focus as concrete things to look
  at, with "a blocker is breakage a player would see".
- A unit took 20 to 75 minutes and cost about 10 to 13% of a 5-hour window and 2 to 3 points of the
  week on the top model, about 1 point on Sonnet.

**The lead's push routine, every time:**
1. Read the worker's report and the checker's verdict (the workflow's `journal.jsonl` holds both
   in full; print only the fields you need).
2. Look at one or two of the pictures yourself. Run any measurement the worker skipped.
3. `npx tsc --noEmit`, then `npm run build`, then boot the PRODUCTION build with no errors:
   `node tools/shot.mjs shots/lead/a.png --dist --query "q=high" --wait 5000`, the mainland
   (`--query "bridge=8&stage=4&q=medium"`), the phone layout (`--mobile`) and Auto (no `q`).
4. Add an entry at the top of the dated entries in `PLAN.md`: what changed, how it was checked,
   and an honest "Owed" list. Append a line to `tools/briefs/lead-notes.md`.
5. Commit (a plain-language title a player would understand, a short body), push to `main`, and
   wait for the deploy: `gh run list --branch main --limit 1`. Every push builds and deploys, and
   a failed build deploys nothing, so `main` must always pass `npm run build`.
6. Report to the owner (rules 5 and 6), then start the next unit.

**The usage gauge.** The lead's own session events of kind `rate_limit_event` (the session tools'
event listing, on your own session id) carry `unifiedWindows.five_hour.utilization` and
`seven_day.utilization` (0 to 1) with `resetsAt` times. Read it before starting each unit; if
usage is ahead of the clock, wait. Ask for few events at a time: the answer is large.

## 4. Things the next lead must know about the code

- **Test hooks** (`window.__game`) are in `src/boot.ts` now and appear after a dynamic import;
  `tools/pw.mjs` waits for them. `src/main.ts` is only the 4.8 kB title-card entry.
- **A boot with no `?q=` is Auto quality** (`src/core/governor.ts`): the preset comes from a
  benchmark. Pass `?q=high|medium|low` for anything compared between runs.
- **Frame rate is measured in a real loop**, `node tools/lead/rafprobe.mjs --q high --scene
  downtown --vsync --cfg full,noFlip` (about 68 fps standing and 65 moving with the two-copy
  buffers, 53 and 51 without). `tools/bench.mjs` stills understate the running game by about 4 ms
  and its paths overstate by about 5 ms; use it for A/B (`--ab`) and for load times (`--load`).
- **`src/core/flip.ts`:** any instance buffer rewritten every frame must be registered with
  `game.flip`, or the whole frame falls back in step with the GPU (about 4 ms). `node
  tools/lead/flipcheck.mjs --q high` must report `"bad":0` in every scene; `--break` proves the
  check can fail. Multiplayer will add buffers (other players, their cars): register them.
- **`src/core/assets.ts`** is the one download queue (order of need, four at a time). New model
  files go through it. `public/models/cars_far.glb` is derived from the full car files by the last
  step of `tools/blender/cars.py`; any car export must run that step or phones get stale cars.
- **Other tools copied into `tools/lead/`** from the ignored scratch folder: `nightshots.mjs` (ten
  fixed night pictures into a folder you name) and `netload.mjs` (load times with the network
  slowed). Their headers still show the old `scratch/` paths, and only `rafprobe.mjs` was re-run
  from its new place. The scratch and shots folders are git-ignored and exist only on this laptop
  (`scratch/m6/` has the notes files of every M6 step).
- **Everything was measured in headless Chromium on this laptop's Iris Xe.** Nobody has watched a
  frame counter on a real screen, tried a real phone, Safari or Firefox, or the laptop's RTX 4050;
  and nobody has HEARD the sound (the owner was asked on Nov 19 and Nov 20 and has not said).

## 5. Multiplayer: where to begin

`tools/briefs/multiplayer.md` is the brief. In short the owner chose: one fully shared world (the
same traffic, police and missions for everyone); the message service deployed from the owner's
`kvbcawana` repo, which already holds the Cloudflare secrets and runs a Worker with a Durable
Object; one public city only; made-up names and no typing. The design: one player's browser is the
host that simulates what is shared, the Durable Object relays, picks the host and keeps the durable
facts; every browser is the authority for its own character and car.

Suggested first units for stage 1:
1. **The service** (top model): a `server/` folder here with the Worker and Durable Object (rooms,
   join and leave, relay, host choice, a cap), a local test with `wrangler dev` or Miniflare, and
   the small manual workflow in `kvbcawana` that deploys it. Look at `kvbcawana/worker/` for how
   that account's existing Worker is set up, touch nothing else there, and confirm the token can
   create a new Worker before relying on it. `wrangler` is not installed on this laptop. If the
   deploy needs anything from the owner (a route, a subdomain, a permission), ask once, plainly.
2. **The client** (top model): `src/net/` with the connection, the made-up names, and other
   players drawn walking, swimming and driving, smoothed between updates; fall back to
   single-player if the service cannot be reached. Test with two or three headless browsers at once.
3. **A check under load** (Haiku to run it, Sonnet if it needs writing): four simulated players for ten minutes, message counts against
   the free-plan limits, frame rate unchanged with `rafprobe`.

Then stages 2 to 5 as the brief lists them. Decide and record in `PLAN.md` what is shared and what
stays personal before stage 4.

## 6. Loose ends and warnings

- **Open question for the owner:** should AI traffic drive over the finished bridge? None did in a
  three-minute watch. No answer yet.
- **A long-lived lead session gets expensive.** By the end, every wake-up of the old session cost
  about 6% of a 5-hour window and 1 point of the week just to re-read its history; the 5-hourly
  resume checks alone took the week from 92% to 95% while paused. Keep the lead's context small:
  send long outputs to files and print only what you need, never read a worker's transcript, and
  suggest a fresh lead with this file when the session grows long.
- **Owed lists** are under every dated entry in `PLAN.md`. The ones a player would notice: the
  C-Max's tail (glass stops above the lamps) and slim head lamps; lit windows at night are flat
  cards and signs do not glow; markers still cover labels on the phone map; a reload mid-chase
  clears the police; very slow connections wait 17 s to start; later missions, shops, weapons and
  a gamepad were never played by script.
- **The owner's standing preferences** were also saved as memory notes on the laptop. You cannot
  see them; section 2 carries everything in them that bears on this job.
- **Multiplayer's first unit asks for a local test with `wrangler dev` or Miniflare.** Both run
  without a Cloudflare account, through `npx`; adding `wrangler` as a dev dependency of a `server/`
  package of its own (not of the game) is fine and does not break the "no new dependencies" rule,
  which is about what the game ships to players.
