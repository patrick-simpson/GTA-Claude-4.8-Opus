# port-calamity-city: the message service

A Cloudflare Worker and one Durable Object class (`City`) that let browsers playing PORT CALAMITY
see each other. It simulates nothing. It passes messages between the players of a city, knows who is
present, chooses which player's browser is the host (the one that simulates shared traffic and
people), moves that job when the host leaves, stalls or struggles, and keeps a few durable facts
(bridge progress, the clock, a weather seed) so the city outlives any one player.

It is a package of its own. The game's root `package.json` knows nothing about it. The only shared
code is `../src/net/protocol.ts`, which has no imports and is used by both sides.

This Worker is the BACKUP home of the service (owner, Nov 21 2026). The main home will be a Node
program on a home computer with no daily limits; the game tries that first, then this, then single
player. Because this one runs on a free Cloudflare account that it shares with a more important
service, it rations itself: see "The daily budget" below.

- `src/room.ts`: the room. Seats (8, one town, no second city), presence, relay, host choice,
  facts, validation, rate caps. NO Cloudflare types: sockets, storage and the clock come in through
  three small interfaces (`RoomSocket`, `RoomEnv`, and `Seat` for what must outlive a restart), so
  a Node wrapper can use the same file unchanged (it has no constructor shorthand or enums, so Node
  can run it by stripping the types).
- `src/budget.ts`: every limit, the game's share, the margin and the pause line, with the source.
- `src/city.ts`: the Durable Object, a thin wrapper round the room: hibernatable sockets, SQLite
  (`new_sqlite_classes`, required on the free plan), the alarm, and the count of what is billed.
- `src/index.ts`: the Worker. Checks the Origin and the name, hands the socket to the town, and
  answers "full" and "resting" from its own memory whenever it can.
- `src/where.ts`, `src/mainkey.ts`: "where is main" (below): the signed registration and its check, and
  the home computer's PUBLIC key (a placeholder until the owner has installed; while it is, every
  registration is refused).
- `home/`: the MAIN home, a Node wrapper round the same room, with its install script: see `home/README.md`.
- `wrangler.toml`: Worker name `port-calamity-city`, binding `CITY`. It has no `[vars]`.

## Run it locally

Needs Node 22.18 or newer. No Cloudflare account, no network.

    cd server
    npm install        # once
    npm run dev        # the service on http://127.0.0.1:8787
    npm test           # starts its own copies (port 8791: plain, tiny limits, a test key; then the Node home on 8794), PASS or FAIL per check
    npm run measure    # 8 simulated players (4 driving at 10 Hz, 4 still) for 60 s, and the budget sums
    npm run typecheck

`node test/local.mjs --measure --seconds=20 --players=8 --still=0 --hz=5` changes the measurement.
From the repository root, with `npm run dev` running here: `node tools/net/two.mjs` (two browsers
see each other). `node tools/net/notices.mjs` starts its own copy (port 8793) and checks the
"town full" and "resting" notices in real browsers.

Testing the pause without sending 800,000 messages: the limits (and the seat count) can be replaced
ONLY by a variable handed to the local `wrangler dev`, which is what the tests do:

    npx wrangler dev --port 8787 --var 'TEST_BUDGET:{"doRequests":100,"seats":2}'

With that variable present, `GET /__test` shows the count and `GET /__test?add=86400000` moves the
service's clock a day on. A deployed service has no such variable (`wrangler.toml` has no `[vars]`
and the deploy workflow passes none), so there `/__test` is the ordinary health line and nothing a
client sends can change a limit.

## Where is main

The main home sits behind a free quick tunnel whose address changes when it restarts. So:

- `POST /main` (the home computer): `{u, t, n, sig}`: the address, its clock, a counter that only rises,
  and an Ed25519 signature over all three. There is no shared secret: the private key never leaves the
  home computer, and the public key is the constant in `src/mainkey.ts`. Refused: the placeholder key
  (403, everything), a bad signature or a clock more than 5 minutes out (401), a counter seen before
  (409), any address that is not `https://<name>.trycloudflare.com` (400). Sent on change and every
  30 minutes: 48 a day, each 1 Worker request, 1 Durable Object request and 2 rows, which is 0.12% of
  the request pause lines and 1.2% of the duration line (as an upper bound).
- `GET /main` (the game): `{"u": "https://....trycloudflare.com"}` or `{"u": null}`, cacheable for 60 s,
  answered from the Worker's memory for 60 s at a time, counted like any request, and answered while
  resting too. An address with no heartbeat for 70 minutes is dropped.
- The game tries the address it remembers (localStorage) without asking; it asks only when it has none
  or it failed; then main, then this Worker, then single player. Set `BACKUP_HOST` in
  `../src/net/protocol.ts` after the first deploy: the game and the home computer both read it.
- Local tests give the Worker a test key with `wrangler dev --var TEST_MAIN_KEY:<key>`, the same
  local-only way as `TEST_BUDGET`.

## Deploy

`npm run deploy` (`wrangler deploy`) with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set.
The game repository has no Cloudflare access, so in practice the manual workflow drafted in
`deploy/deploy-port-calamity-city.yml` is copied into the repository that holds those secrets and
run from there. The service then answers at `https://port-calamity-city.<account>.workers.dev`
(`wss://` for the game). A plain GET answers one line of text, which is a handy health check.

## Protocol (all of it is in `src/net/protocol.ts`)

Connect: `wss://<host>/?v=3&name=3.17.20`. The name is two or three integers, indexes into
the game's own word lists (part i is below `NAME_LIST_SIZES[i]`, today 40, 40 and 24). There is no hello message: a bad name, a wrong version (400), a
disallowed Origin (403) refuse the upgrade. A full town and a resting service do NOT refuse it (a
browser cannot read a refused upgrade): the socket opens, carries one `full` or `rest` message, and
closes with 4008 or 4009.

Binary frames (frequent). Byte 0 is the kind, byte 1 a player id that the service overwrites with
the sender's id; the service reads nothing else and forwards the same buffer.

| kind | name | from | goes to | size cap | use |
| --- | --- | --- | --- | --- | --- |
| 0 | Keepalive | anyone | nobody | 1 | "I am alive" |
| 1 | State | anyone, 10 Hz | everyone else | 96 | own character or car (34 bytes today) |
| 2 | World | host only | everyone else | 4096 | shared traffic, people, police (stage 2 on) |
| 3 | Event | anyone, rare | everyone else | 96 | horn, wave, canned shout (4 bytes) |
| 4 | ToHost | anyone | the host | 96 | a request to the host (stage 2 on) |
| 5 | ToPlayer | host only | byte 1's player | 4096 | join snapshot for one player (stage 2 on) |

JSON text (rare).

| message | direction | meaning |
| --- | --- | --- |
| `{t:"welcome",v,id,city,host,players:[[id,a,b,c?]...],facts,now}` | service to joiner | first message on every socket |
| `{t:"join",id,name}` / `{t:"leave",id}` | service to others | presence |
| `{t:"name",name}` then `{t:"name",id,name}` | client, then service to others | re-rolled name |
| `{t:"perf",ms}` | client, every 5 s | measured frame time; 1000 or more means "do not make me host" |
| `{t:"host",id}` | service to all | the host changed |
| `{t:"fact",k,v}` | host, then service to others | durable fact; `v` is a number or up to 16 numbers |
| `{t:"full",retry,seats}` then close 4008 | service to joiner | every seat is taken; `retry` is a hint in seconds (180) |
| `{t:"rest",until,now}` then close 4009 | service to joiner, or to everybody | paused until `until` (ms since 1970, UTC; always the next 00:00 UTC); `now` is the service's clock |
| `ping` / `pong` | client / service | a connection check; counted and rate limited like any message |

Rules a client must follow:

- Send something at least every 2 s while others are present (State, Perf and Keepalive all count),
  or a host is taken for stalled after 4 s. Alone in the city, send nothing: the city then sleeps.
- World and ToPlayer frames and facts from a player who is not the host are dropped silently, so a
  client must stop simulating shared things when it sees `host` name someone else.
- Write a fact when it changes, not every frame. Bursts are stored at most every 5 s.
- After `full`: play alone and ask the SAME address again no sooner than the hint (the game waits 3
  minutes plus up to a quarter more, at random). Never fall through to another address: that would
  be a second city.
- After `rest`: do not contact this address again before `until` plus a random 0 to 5 minutes, not
  even after a reload (the game keeps the time in localStorage). Every request, refused or not, is
  billed.
- Breaking a limit closes the socket: 4001 too big, 4002 too fast (40 a second, burst 80), 4003 not
  a valid message.

Host choice: the first player in is host. The job moves when the host disconnects, when nothing has
arrived from it for 4 s, or when it reports more than 25 ms a frame while another player reports at
most 70% of that, and then not within 8 s of the last move.

## Safety and privacy

- Upgrades are accepted only from `https://gta.doofus.live` and from localhost or 127.0.0.1 origins.
  (Origin stops other web pages, not hand-written programs; the limits below are for those.)
- Nothing typed can travel: names are indexes, shouts are numbers, facts are numbers. The service
  refuses anything else rather than passing it on.
- No accounts and no identifiers beyond the per-connection id. The code never reads the caller's
  address, the Worker passes none of the caller's headers to the city, there is no `console.log`,
  and observability is off in `wrangler.toml`.
- Clients are trusted beyond that: there is no cheat protection.

## The daily budget (owner's rules, Nov 21 2026)

The free limits belong to the whole Cloudflare account, which also runs a more important service.
The game may use at most 50% of any daily limit and must stop itself well before that, until the
limits reset at 00:00 UTC. All of the numbers are named constants in `src/budget.ts`.

| meter | free limit a day | game's share (50%) | pause line (80% of the share) | what is counted |
| --- | --- | --- | --- | --- |
| Durable Object requests | 100,000 | 50,000 | **40,000** | each fetch from the Worker, each alarm, incoming messages / 20 |
| Durable Object duration | 13,000 GB-s | 6,500 | **5,200 GB-s** (the town awake 11.3 h) | an upper bound: every gap between events, up to 10 s each, at 128 MB |
| Worker requests | 100,000 | 50,000 | **40,000** | counted in the Worker's memory, reported to the town on its next visit or every 200 |
| SQLite rows written | 100,000 | 50,000 | **40,000** | facts, the count itself, alarms set |
| SQLite rows read | 5,000,000 | 2,500,000 | 2,000,000 | counted, but cannot be approached (about 33 rows per wake) |

Source: developers.cloudflare.com/durable-objects/platform/pricing/ and /workers/platform/limits/,
read Nov 21 2026 (incoming WebSocket messages are billed 20 to 1, outgoing ones are free, duration
is billed at 128 MB, limits reset at 00:00 UTC, and past a limit operations of that type fail).

When any meter reaches its pause line the town sends everybody `rest` with the resume time, closes
their sockets, stores the count, and refuses joins until the first event of the next UTC day.

Why 80%: the last fifth of the share covers what the count can miss. The count is stored (one row)
on every visit from the Worker, whenever somebody leaves, and once a minute while messages flow,
never per message. In between, each socket's attachment carries its own message count (attachments
are not billed), so an eviction or crash loses at most 19 messages a socket plus a minute of the
duration estimate and of fact rows: under 1% of the share. Worker requests counted in an isolate
that Cloudflare recycles before it reports are lost too (under 200 each time).

What a refusal costs:

- Bad Origin, version or name: one Worker request. The town is not woken.
- "Full" or "resting", answered from the Worker's memory: **one Worker request and nothing else**
  (no Durable Object request, no duration, no rows). The Worker remembers "full" for 15 s and
  "resting" until the reset. The price of the 15 s is that a seat can stand empty that long.
- The first such refusal in each Worker isolate: one Worker request, one Durable Object request
  (a few ms awake) and one row for the count.

What it cannot do: stop requests arriving. A hand-written program that hammers the Worker is
still billed one Worker request each time, resting or not; the service only counts them and rests.
A Cloudflare rate limiting rule on the hostname would be the defence if that ever happens.

## Player hours (measured Nov 21 2026 with `npm run measure`, the game's real send pattern)

- 8 players, 4 driving at 10 Hz and 4 standing still, 60 s: 2,576 messages in, 16,744 out, none lost.
- A driver sends 36,539 messages an hour = **1,827 billed requests**. A player standing still sends
  only keepalives and frame times: 2,100 messages an hour = **105 requests**.
- Pause line 40,000 requests: **21.9 player hours a day if everybody drives** (8 people driving
  nonstop: 2.7 hours, then rest until 00:00 UTC); **41.4 player hours a day half idle** (8 people,
  half of them still: 5.2 hours).
- If everybody stood still the requests would last 8 people 47 hours, so the duration line decides:
  the town may be awake 11.3 hours a day at most, however many are in it. A lone player sends
  nothing, so a town of one sleeps and costs nothing.
- Stage 2 warning: a host World frame at 10 Hz adds 1,800 requests per town hour. Keep it ONE frame
  per tick for all cars.
