// The Worker in front of the town. It answers one thing: a WebSocket upgrade from the game.
// It checks the Origin and the name, then hands the socket to THE town (there is one, with 8 seats).
// It never reads or logs the caller's address.
//
// Refusals are answered here whenever possible, without waking the Durable Object:
//  - a bad Origin, version or name: a plain 4xx;
//  - "town is full" and "resting until 00:00 UTC": the town says so once (a 409 with the reason),
//    this isolate remembers it (full for FULL_CACHE_MS, resting until the reset), and every later
//    caller gets the same answer from memory. A browser cannot read a refused upgrade, so the
//    answer is a socket that carries one message and closes. Such a refusal costs ONE Worker
//    request and nothing else: no Durable Object request, no duration, no storage.
// Each isolate keeps its own memory, so a fresh one asks the town once.

import { Close, HTTP_BAD_HELLO, HTTP_BAD_ORIGIN, PROTOCOL_VERSION, CITY_CAP, isAllowedOrigin, isValidName } from '../../src/net/protocol';
import type { FullMsg, RestMsg } from '../../src/net/protocol';
import { FULL_CACHE_MS, WORKER_REPORT_EVERY } from './budget';
import { REFUSED_STATUS } from './city';
import type { CityEnv } from './city';
import { parseNameParam } from './room';

export { City } from './city';

export interface Env extends CityEnv {
  CITY: DurableObjectNamespace;
}

// ---- this isolate's memory (lost whenever Cloudflare recycles it; nothing depends on it surviving) ----

/** The last refusal the town gave, and when it stops being believed. */
let refusal: { msg: FullMsg | RestMsg; until: number } | null = null;
/** Requests this isolate has answered and not yet told the town about. */
let unreported = 0;
/** Local tests only: ms added to the clock (see /__test). */
let shift = 0;

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** A socket that says one thing and closes. */
function refuse(msg: FullMsg | RestMsg, now: number): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.send(JSON.stringify(msg.t === 'rest' ? { ...msg, now } : msg));
  server.close(msg.t === 'rest' ? Close.Rest : Close.Full, msg.t === 'rest' ? 'resting' : 'full');
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function town(env: Env): DurableObjectStub {
  return env.CITY.get(env.CITY.idFromName('city-1'));
}

/** Requests that never reach the town are still billed: tell it now and then. */
function report(env: Env, ctx: ExecutionContext): void {
  if (unreported < WORKER_REPORT_EVERY) return;
  const w = unreported;
  unreported = 0;
  ctx.waitUntil(town(env).fetch(`https://city/count?w=${w}`).then(() => {}, () => { unreported += w; }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    unreported++;
    const url = new URL(request.url);
    const now = Date.now() + shift;

    if (env.TEST_BUDGET && url.pathname === '/__test') {
      // Local tests only: move the clock (?add=ms), forget the remembered refusal, and show the count.
      const add = Number(url.searchParams.get('add')) || 0;
      shift += add;
      if (add || url.searchParams.has('forget')) refusal = null;
      const w = url.searchParams.has('flush') ? unreported : 0;
      unreported -= w;
      const res = await town(env).fetch(`https://city/__test?add=${add}&w=${w}`);
      return Response.json({ ...(await res.json() as object), unreported, remembered: refusal && now + add < refusal.until ? refusal.msg.t : null });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      report(env, ctx);
      return plain(200, `port-calamity-city v${PROTOCOL_VERSION}, ${CITY_CAP} seats\n`);
    }
    if (!isAllowedOrigin(request.headers.get('Origin'))) {
      report(env, ctx);
      return plain(HTTP_BAD_ORIGIN, 'origin not allowed\n');
    }
    if (url.searchParams.get('v') !== String(PROTOCOL_VERSION)) {
      report(env, ctx);
      return plain(HTTP_BAD_HELLO, 'wrong protocol version\n');
    }
    const name = parseNameParam(url.searchParams.get('name'));
    if (!isValidName(name)) {
      report(env, ctx);
      return plain(HTTP_BAD_HELLO, 'bad name\n');
    }

    // The cheap refusal: answered from memory.
    if (refusal) {
      if (now < refusal.until) {
        report(env, ctx);
        return refuse(refusal.msg, now);
      }
      refusal = null;
    }

    const w = unreported;
    unreported = 0;
    let res: Response;
    try {
      // A fresh, minimal request: nothing of the caller's headers (address included) reaches the town.
      res = await town(env).fetch(`https://city/?name=${name.join('.')}&w=${w}`, { headers: { Upgrade: 'websocket' } });
    } catch {
      // The town cannot be reached (Cloudflare's own limit, perhaps). The game falls back to single player.
      unreported += w;
      return plain(503, 'unavailable\n');
    }
    if (res.status !== REFUSED_STATUS) return res;
    const msg = await res.json() as FullMsg | RestMsg;
    refusal = { msg, until: msg.t === 'rest' ? msg.until : now + FULL_CACHE_MS };
    return refuse(msg, now);
  },
} satisfies ExportedHandler<Env>;
