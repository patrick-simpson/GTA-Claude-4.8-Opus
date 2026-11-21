# port-calamity-city: the message service

A Cloudflare Worker and one Durable Object class (`City`) that let browsers playing PORT CALAMITY
see each other. It simulates nothing. It passes messages between the players of a city, knows who is
present, chooses which player's browser is the host (the one that simulates shared traffic and
people), moves that job when the host leaves, stalls or struggles, and keeps a few durable facts
(bridge progress, the clock, a weather seed) so the city outlives any one player.

It is a package of its own. The game's root `package.json` knows nothing about it. The only shared
code is `../src/net/protocol.ts`, which has no imports and is used by both sides.

- `src/index.ts`: the Worker. Checks the Origin and the name, then hands the socket to city 1, or
  city 2 when city 1 is full (16 players), and so on up to 8 cities.
- `src/city.ts`: the Durable Object. SQLite backed (`new_sqlite_classes`, required on the free plan)
  and written on the WebSocket Hibernation API (no timers), so a quiet city costs nothing.
- `wrangler.toml`: Worker name `port-calamity-city`, binding `CITY`.

## Run it locally

Needs Node 22.18 or newer. No Cloudflare account, no network.

    cd server
    npm install        # once
    npm run dev        # the service on http://127.0.0.1:8787
    npm test           # starts its own copy on port 8791, runs the checks, prints PASS or FAIL per check
    npm run measure    # 4 simulated players at 10 Hz for 60 s, message counts and free plan sums
    npm run typecheck

`node test/local.mjs --measure --seconds=20 --players=8 --hz=5` changes the measurement.

## Deploy

`npm run deploy` (`wrangler deploy`) with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set.
The game repository has no Cloudflare access, so in practice the manual workflow drafted in
`deploy/deploy-port-calamity-city.yml` is copied into the repository that holds those secrets and
run from there. The service then answers at `https://port-calamity-city.<account>.workers.dev`
(`wss://` for the game). A plain GET answers one line of text, which is a handy health check.

## Protocol (all of it is in `src/net/protocol.ts`)

Connect: `wss://<host>/?v=2&name=3.17.20`. The name is two or three integers, indexes into
the game's own word lists (part i is below `NAME_LIST_SIZES[i]`, today 40, 40 and 24). There is no hello message: a bad name, a wrong version (400), a
disallowed Origin (403) or eight full cities (503) refuse the upgrade.

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
| `ping` / `pong` | client / service | answered without waking the city |

Rules a client must follow:

- Send something at least every 2 s while others are present (State, Perf and Keepalive all count),
  or a host is taken for stalled after 4 s. Alone in the city, send nothing: the city then sleeps.
- World and ToPlayer frames and facts from a player who is not the host are dropped silently, so a
  client must stop simulating shared things when it sees `host` name someone else.
- Write a fact when it changes, not every frame. Bursts are stored at most every 5 s.
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

## Cost on the free plan (measured Nov 2026; see `npm run measure`)

Limits read from Cloudflare's documentation: 100,000 Durable Object requests a day, 13,000 GB-s of
Durable Object duration a day, 100,000 Worker requests a day, 100,000 SQLite rows written a day.
Incoming WebSocket messages are billed at 20 to 1; outgoing messages are free.

- 4 players at 10 Hz for 60 s: 2,436 messages in (63,050 bytes), 7,176 out (186,576 bytes), none lost.
- One player hour is about 36,500 messages in, which is 1,827 billed requests. So the free plan
  holds about **54 player hours a day** (4 players for 13.7 hours, or 16 players for 3.4 hours),
  however they are grouped. When it runs out, new messages fail until 00:00 UTC, and the game must
  fall back to single-player.
- Duration is not the limit: a city awake for all 24 hours is 11,059 GB-s, under the 13,000, and a
  hibernating city is not billed between messages at all. Worker requests are one per connection.
- To stretch it: send State at 5 Hz (about 109 player hours); send State only while moving and a
  Keepalive every 2 s when still (a parked player then costs 90 requests an hour instead of 1,827);
  keep the host's World as ONE frame per tick for all cars (at 10 Hz that is 1,800 requests per city
  hour; one frame per car would be ruinous). Packing several players into one frame does not help
  incoming cost, since each browser must still send its own.
