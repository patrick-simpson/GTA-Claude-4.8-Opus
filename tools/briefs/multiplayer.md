# Brief: live multiplayer (asked for Nov 20; starts after M6, after the weekly usage reset)

Read tools/briefs/common.md first. This file records what the owner decided and the design the lead
chose from it. Each stage below is several small runs, one worker at a time, each checked and pushed.

## What the owner asked for and decided (Nov 20, 2026)

"Make it so that when multiple people are on it, it does live multiplayer."

Asked one question at a time, the owner chose:
1. **One fully shared world**, not just seeing each other: everyone sees the same traffic, the same
   police chase, the same missions. (Told it is weeks of work in about five stages; accepted.)
2. **Finish M6 first.** Multiplayer starts after M6's last steps, which means after the weekly usage
   reset on Sunday Nov 22, 4 PM ET.
3. **The message service is deployed from the kvbcawana repo** (the owner's church project,
   C:/Users/User/Documents/GitHub/kvbcawana), which already holds CLOUDFLARE_API_TOKEN and
   CLOUDFLARE_ACCOUNT_ID as Actions secrets and already runs a Worker with a Durable Object
   (worker/wrangler.toml, "awana-sync"). The GTA repo has no Cloudflare access. So: the service's
   code lives in THIS repo (a `server/` folder), and a small workflow added to kvbcawana checks this
   repo out and runs `wrangler deploy` for it. Touch nothing else in kvbcawana, keep that workflow
   manual or path-limited so the church project's own deploys are unaffected, and never print secrets.
4. **One public city only.** Everyone who opens the site is in the same city. No private rooms, no
   "play alone" switch.
5. **Made-up names, no typing.** The game gives each player a silly name in its own style, which
   they can re-roll. No text chat and no typed names: horns, a wave, a few canned shouts.

## The design (the lead's choices; change them if a stage proves them wrong, and say so in PLAN.md)

- **Who simulates what.** GitHub Pages serves files only, and a free Cloudflare Durable Object cannot
  run a 60 Hz city. So ONE player's browser, the host, simulates everything shared (traffic, parked
  cars, pedestrians, police, fire, missions, the bridge), and the other browsers draw what it sends,
  smoothed between updates. Every browser is the authority for its own character and the car it is
  driving. The Durable Object passes messages, knows who is present, chooses the host, moves the job
  to another player when the host leaves or stalls, and keeps the durable facts of the city (bridge
  progress, the clock, the weather seed) so the city outlives any one player.
- **Things already the same for everyone without messages:** the map, signal timing, and anything
  driven by the shared clock. Keep as much as possible deterministic from clock and seed.
- **Limits that follow.** A slow host makes shared traffic stutter for everyone, so choose the host
  by measured frame time and move it when it struggles. Clients are trusted (no cheat protection).
  Free-plan budgets (requests and wake time) cap how chatty the protocol can be: batch, send about
  10 times a second, send differences, and measure message counts in every stage.
- **Engineering necessities the owner did not ask about, kept small:** if the service cannot be
  reached the game runs single-player rather than locking people out; if the one city is full (set
  the cap from measurements, start at 16) a second copy opens silently.
- **Privacy and safety:** nothing typed by a player is ever shown to another. No accounts, no IDs
  beyond a random per-browser token, no logs of IP addresses in our code.

## Stages (each ends with something a visitor can see, pushed live)

1. **See each other.** The service, the connection, names, other players walking, swimming and
   driving, smoothed; a count of who is in town; horn, wave, shouts.
2. **The same cars for everyone.** Host-run traffic and parked cars; players' cars bump each other;
   getting in and out of the same car; damage, wrecks and respawns shared.
3. **The same people and trouble.** Pedestrians, police and heat, weapons between players, fire and
   explosions, breakable props.
4. **The same story.** Missions, activities, the bridge and money rules in a shared city: decide
   and record what is shared (the bridge, the city) and what stays personal (cash, the story step).
5. **Hardening.** Joining a city already running, the host leaving mid-chase, reconnecting, a
   30-minute soak with four simulated players, message and cost counts against the free limits.

## Owner decisions, Nov 21, 2026 (these override the text above)

6. **Be very sparing with Cloudflare.** The free limits are shared by the owner's whole account,
   so the game draws from the same daily pool as the church service. The game may use at most
   **50% of any daily free limit**. The service counts its own use and, well before that line,
   pauses multiplayer until the daily reset (midnight UTC).
7. **When paused, players play alone** and see a notice saying multiplayer is resting and the time
   it resumes (shown in their local time). Single player costs Cloudflare nothing.
8. **8 players at a time, total.** One city, cap 8, NO second city. Player 9 plays alone with a
   small "town is full" notice, and the game retries quietly every few minutes and moves them in
   when a seat opens. A refused join must cost as little as possible.
9. Send only what changes; a still player sends almost nothing. Measure message counts every stage.
