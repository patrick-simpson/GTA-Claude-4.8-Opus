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
//  - "go to main": while the main service (the home computer) is registered and alive, a caller is not seated
//    here but told main's address, the same way (one message, then the close), from the same memory that
//    answers GET /main. Everybody then meets in ONE town. A caller that says it could not reach main
//    (`nm=1`) is seated here as before, so nobody is sent round in a circle.
// Each isolate keeps its own memory, so a fresh one asks the town once.

import { Close, HTTP_BAD_HELLO, HTTP_BAD_ORIGIN, MAIN_PATH, PROTOCOL_VERSION, CITY_CAP, TRIED_MAIN_PARAM, isAllowedOrigin, isValidName } from '../../src/net/protocol';
import type { FullMsg, MainMsg, RestMsg } from '../../src/net/protocol';
import { FULL_CACHE_MS, WORKER_REPORT_EVERY } from './budget';
import { REFUSED_STATUS } from './city';
import type { CityEnv } from './city';
import { parseNameParam } from './room';
import { MAIN_PUBLIC_KEY } from './mainkey';
import { MAIN_BODY_MAX, MAIN_CACHE_S, MAIN_MEMO_MS, MAIN_OVERDUE_MS, MAIN_STALE_MS, isRealKey, parseRegistration, verifyRegistration } from './where';

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
/** Where the main service is, as the town last said: the address (or none), its last heartbeat, its counter, and when this was learnt. */
let mainMemo: { u: string | null; hb: number; n: number; at: number } | null = null;

/** GET /main: "where is the main service". One Worker request; the town is asked at most once a minute per isolate. */
async function whereIsMain(request: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = { 'content-type': 'application/json', vary: 'Origin' };
  if (isAllowedOrigin(origin)) headers['access-control-allow-origin'] = origin as string;
  if (!mainMemo || now - mainMemo.at >= MAIN_MEMO_MS || now < mainMemo.at) {
    const w = unreported;
    unreported = 0;
    try {
      const res = await town(env).fetch(`https://city${MAIN_PATH}?w=${w}`);
      const m = await res.json() as { u: string | null; hb: number; n: number };
      mainMemo = { u: m.u, hb: m.hb, n: m.n, at: now };
    } catch {
      unreported += w;
      return new Response('{"u":null}\n', { status: 503, headers: { ...headers, 'cache-control': 'no-store' } });
    }
  } else report(env, ctx);
  const u = mainMemo.u && now - mainMemo.hb <= MAIN_OVERDUE_MS ? mainMemo.u : null;
  return new Response(JSON.stringify({ u }) + '\n', { headers: { ...headers, 'cache-control': `public, max-age=${MAIN_CACHE_S}` } });
}

/** POST /main: the home computer says where it is. Everything that can be refused is refused here, before the town is woken. */
async function registerMain(request: Request, env: Env, now: number): Promise<Response> {
  // The committed public key; a local `wrangler dev --var` may give a test key instead (a deployed service has no vars).
  const key = env.TEST_MAIN_KEY ?? MAIN_PUBLIC_KEY;
  if (!isRealKey(key)) return plain(403, 'no main key is set: registrations are off\n');
  if (Number(request.headers.get('content-length')) > MAIN_BODY_MAX) return plain(413, 'too big\n');
  const reg = parseRegistration((await request.text()).slice(0, MAIN_BODY_MAX + 1));
  if (!reg) return plain(400, 'not a registration\n');
  if (Math.abs(now - reg.t) > MAIN_STALE_MS) return plain(401, 'stale\n');
  if (!(await verifyRegistration(key, reg))) return plain(401, 'bad signature\n');
  const w = unreported;
  unreported = 0;
  let res: Response;
  try {
    res = await town(env).fetch(`https://city${MAIN_PATH}?w=${w}`, { method: 'POST', body: JSON.stringify({ u: reg.u, n: reg.n }) });
  } catch {
    unreported += w;
    return plain(503, 'unavailable\n');
  }
  if (res.status !== 204) return plain(409, 'seen before\n');
  mainMemo = { u: reg.u, hb: now, n: reg.n, at: now };
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** A socket that says one thing and closes. */
function refuse(msg: FullMsg | RestMsg | MainMsg, now: number): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.send(JSON.stringify(msg.t === 'rest' ? { ...msg, now } : msg));
  server.close(msg.t === 'rest' ? Close.Rest : msg.t === 'main' ? Close.Main : Close.Full, msg.t === 'rest' ? 'resting' : msg.t);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Main's address, when this isolate has heard of it within MAIN_MEMO_MS and its heartbeat is not overdue. Else null. */
function liveMain(now: number): string | null {
  const m = mainMemo;
  return m && m.u && now >= m.at && now - m.at < MAIN_MEMO_MS && now - m.hb <= MAIN_OVERDUE_MS ? m.u : null;
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
      if (add || url.searchParams.has('forget')) mainMemo = null;
      const w = url.searchParams.has('flush') ? unreported : 0;
      unreported -= w;
      const res = await town(env).fetch(`https://city/__test?add=${add}&w=${w}`);
      return Response.json({ ...(await res.json() as object), unreported, remembered: refusal && now + add < refusal.until ? refusal.msg.t : null });
    }

    if (url.pathname === MAIN_PATH) {
      if (request.method === 'GET') return whereIsMain(request, env, ctx, now);
      if (request.method === 'POST') return registerMain(request, env, now);
      report(env, ctx);
      return plain(405, 'GET or POST\n');
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

    // The caller has tried main already and could not reach it: it is seated here, never sent there again.
    const triedMain = url.searchParams.get(TRIED_MAIN_PARAM) === '1';

    // The cheap refusals: answered from memory. Resting comes first (then nothing is said about main: the game
    // asks for it itself), then "go to main" (even when this town is full: main is where everybody belongs).
    if (refusal && now >= refusal.until) refusal = null;
    const sendTo = triedMain || refusal?.msg.t === 'rest' ? null : liveMain(now);
    if (sendTo) {
      report(env, ctx);
      return refuse({ t: 'main', u: sendTo }, now);
    }
    if (refusal) {
      report(env, ctx);
      return refuse(refusal.msg, now);
    }

    const w = unreported;
    unreported = 0;
    let res: Response;
    try {
      // A fresh, minimal request: nothing of the caller's headers (address included) reaches the town.
      res = await town(env).fetch(`https://city/?name=${name.join('.')}&w=${w}${triedMain ? `&${TRIED_MAIN_PARAM}=1` : ''}`, { headers: { Upgrade: 'websocket' } });
    } catch {
      // The town cannot be reached (Cloudflare's own limit, perhaps). The game falls back to single player.
      unreported += w;
      return plain(503, 'unavailable\n');
    }
    if (res.status !== REFUSED_STATUS) return res;
    const msg = await res.json() as FullMsg | RestMsg | (MainMsg & { hb: number; n: number });
    if (msg.t === 'main') {
      // Remembered exactly as an answer to GET /main is, so the next callers are sent on without asking the town.
      mainMemo = { u: msg.u, hb: msg.hb, n: msg.n, at: now };
      return refuse({ t: 'main', u: msg.u }, now);
    }
    refusal = { msg, until: msg.t === 'rest' ? msg.until : now + FULL_CACHE_MS };
    return refuse(msg, now);
  },
} satisfies ExportedHandler<Env>;
