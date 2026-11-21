// Local test of the message service. From server/:
//   npm test                      the checks (about 90 s; the daily budget is tested on a second copy with tiny limits)
//   npm run measure               8 simulated players (4 driving at 10 Hz, 4 standing still) for 60 s, and the sums
//   node test/local.mjs --measure --seconds=20 --players=8 --still=0
// It starts `wrangler dev` (workerd, no Cloudflare account, no network) on a spare port with a
// throwaway storage folder, talks to it over real WebSockets, and stops it again.
// Needs Node 22.18 or newer: it imports the TypeScript protocol file directly.

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import * as W from '../src/where.ts';
import { tmpdir } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as P from '../../src/net/protocol.ts';
import * as B from '../src/budget.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = pathJoin(here, '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const a = args.find((s) => s.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : dflt;
};
const MEASURE = args.includes('--measure');
// --home: the same checks against the Node home (server/home/main.ts) instead of the Worker.
const HOME = args.includes('--home');
const PORT = arg('port', HOME ? 8794 : 8791);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const GOOD_ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the local Worker ----

let child = null;
let persistDir = null;
let serverLog = '';

async function startServer(testBudget = null, vars = {}) {
  serverLog = '';
  persistDir ??= mkdtempSync(pathJoin(tmpdir(), 'port-calamity-city-'));
  child = HOME ? spawn(process.execPath, ['--disable-warning=ExperimentalWarning', pathJoin(serverDir, 'home', 'main.ts')],
    { cwd: serverDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PC_PORT: String(PORT), PC_STATE: persistDir, PC_RELEASE: 'test-1', ...vars } }) : spawn(
    pathJoin(serverDir, 'node_modules', '.bin', 'wrangler'),
    ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, '--show-interactive-dev-session=false',
      // The ONLY way to change the limits: a var given to the local `wrangler dev`. A deployed service has none.
      ...(testBudget ? ['--var', `TEST_BUDGET:${JSON.stringify(testBudget)}`] : []),
      ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
    { cwd: serverDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } },
  );
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(HTTP + '/');
      if (r.ok && (await r.text()).startsWith('port-calamity-')) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('the local Worker did not start:\n' + serverLog.slice(-2000));
}

async function stopServer(keepStorage = false) {
  const c = child;
  child = null;
  if (c && c.exitCode === null) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch { /* gone */ }
    for (let i = 0; i < 50 && c.exitCode === null; i++) await sleep(100);
  }
  if (keepStorage) return;
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
  persistDir = null;
}

// ---- a test client ----

class Client {
  constructor(ws) {
    this.ws = ws;
    this.inbox = []; // { text } or { bin: ArrayBuffer }
    this.waiters = [];
    this.closed = null; // { code }
    this.msgsIn = 0;
    this.bytesIn = 0;
    this.msgsOut = 0;
    this.bytesOut = 0;
    this.welcome = null;
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      this.msgsIn++;
      this.bytesIn += isBinary ? data.byteLength : Buffer.byteLength(data.toString());
      if (this.counting) return;
      if (isBinary) this.inbox.push({ bin: data });
      else {
        const text = data.toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* "pong" */ }
        this.inbox.push({ text, json });
      }
      this.pump();
    });
    ws.on('close', (code) => {
      this.closed = { code };
      this.pump();
    });
    ws.on('error', () => {});
  }
  get id() {
    return this.welcome.id;
  }
  pump() {
    for (const w of this.waiters.slice()) w();
  }
  /** Resolves with the first queued message matching `pred` (and removes it), or null on timeout. */
  take(pred, ms = 2000) {
    return new Promise((resolve) => {
      const tryNow = () => {
        const i = this.inbox.findIndex(pred);
        if (i < 0) return false;
        const [m] = this.inbox.splice(i, 1);
        done(m);
        return true;
      };
      const done = (m) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== tryNow);
        resolve(m);
      };
      const timer = setTimeout(() => done(null), ms);
      this.waiters.push(tryNow);
      tryNow();
    });
  }
  takeJson(t, ms) {
    return this.take((m) => m.json && m.json.t === t, ms).then((m) => (m ? m.json : null));
  }
  takeBin(kind, ms) {
    return this.take((m) => m.bin && new Uint8Array(m.bin)[0] === kind, ms).then((m) => (m ? m.bin : null));
  }
  async waitClose(ms = 2000) {
    const until = Date.now() + ms;
    while (!this.closed && Date.now() < until) await sleep(20);
    return this.closed ? this.closed.code : null;
  }
  send(data) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.msgsOut++;
    this.bytesOut += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    this.ws.send(data);
  }
  sendJson(m) {
    this.send(JSON.stringify(m));
  }
  clear() {
    this.inbox.length = 0;
  }
  async close() {
    if (this.closed) return;
    this.ws.close(1000);
    await this.waitClose(2000);
  }
}

/** Opens a socket. Resolves { client } after the welcome, or { status } when the upgrade is refused. */
function open(name = [1, 2], { origin = GOOD_ORIGIN, query } = {}) {
  return new Promise((resolve) => {
    const q = query ?? `v=${P.PROTOCOL_VERSION}&name=${name.join('.')}`;
    const ws = new WebSocket(`${WS}/?${q}`, origin === null ? {} : { origin });
    const client = new Client(ws);
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.on('error', () => resolve({ status: -1 }));
    client.take((m) => m.json && ['welcome', 'full', 'rest'].includes(m.json.t), 5000).then(async (m) => {
      const w = m && m.json;
      if (w && w.t === 'welcome') {
        client.welcome = w;
        resolve({ client });
      } else if (w) resolve({ refused: w, code: await client.waitClose(2000) }); // a seat was not given: one message, then closed
      else if (!client.closed) resolve({ status: -2 });
    });
  });
}
async function join(name) {
  const r = await open(name);
  if (!r.client) throw new Error(`could not join (status ${r.status})`);
  return r.client;
}
async function closeAll(clients) {
  await Promise.all(clients.map((c) => c.close()));
  await sleep(250);
}

// ---- checks ----

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  (' + detail + ')' : ''}`);
}
const stateFrame = (x) => P.encodePlayerState({ id: 0, t: 1234, x, y: 2, z: -3, yaw: 1, vx: 4, vz: -5, mode: P.PlayerMode.Driving, flags: 3, vehicle: 7 });

async function runChecks() {
  // -- origin --
  let r = await open([1, 2], { origin: 'https://evil.example' });
  check('a bad Origin is refused (403)', r.status === P.HTTP_BAD_ORIGIN, `status ${r.status}`);
  r = await open([1, 2], { origin: null });
  check('a missing Origin is refused (403)', r.status === P.HTTP_BAD_ORIGIN, `status ${r.status}`);
  r = await open([1, 2], { origin: 'https://gta.doofus.live.evil.example' });
  check('a look-alike Origin is refused (403)', r.status === P.HTTP_BAD_ORIGIN, `status ${r.status}`);
  for (const origin of ['https://gta.doofus.live', 'http://127.0.0.1:4173', 'http://localhost:5173']) {
    r = await open([1, 2], { origin });
    check(`Origin ${origin} is accepted`, !!r.client, `status ${r.status}`);
    if (r.client) await closeAll([r.client]);
  }

  // -- names --
  const badNames = ['name=7', 'name=1.2.3.4', 'name=1.999', 'name=1.-2', 'name=bob.smith', 'name=%3Cb%3Ehi', 'name=1.2e1', ''];
  let allRefused = true;
  for (const n of badNames) {
    r = await open(null, { query: `v=${P.PROTOCOL_VERSION}&${n}` });
    if (r.status !== 400) allRefused = false;
  }
  check(`bad names are refused at the door (${badNames.length} tried, all 400)`, allRefused);
  r = await open(null, { query: 'v=999&name=1.2' });
  check('a wrong protocol version is refused (400)', r.status === 400, `status ${r.status}`);

  // -- join and presence --
  const a = await join([1, 2]);
  check('first player: welcome with an id, city 1, alone, and is host',
    a.id >= 1 && a.welcome.city === 1 && a.welcome.players.length === 1 && a.welcome.host === a.id && a.welcome.players[0].join() === [a.id, 1, 2].join(),
    JSON.stringify(a.welcome));
  const b = await join([3, 4, 5]);
  const c = await join([6, 7]);
  const seenB = await a.takeJson('join');
  check('second player: welcome lists both, with names', b.welcome.players.length === 2 && b.welcome.players.some((p) => p.join() === [a.id, 1, 2].join()) && b.welcome.host === a.id, JSON.stringify(b.welcome));
  check('those present are told of a join (id and name indexes)', !!seenB && seenB.id === b.id && seenB.name.join() === '3,4,5', JSON.stringify(seenB));
  check('ids are distinct small numbers', new Set([a.id, b.id, c.id]).size === 3 && [a, b, c].every((p) => p.id >= 1 && p.id <= 255));
  await sleep(100);
  for (const p of [a, b, c]) p.clear();

  // -- relay --
  const sent = stateFrame(100.5);
  a.send(sent);
  const gotB = await b.takeBin(P.Frame.State);
  const gotC = await c.takeBin(P.Frame.State);
  const echo = await a.takeBin(P.Frame.State, 400);
  const dec = gotB && P.decodePlayerState(gotB);
  check('relay: state reaches the others, tagged with the sender id, payload intact',
    !!dec && !!gotC && dec.id === a.id && dec.x === 100.5 && dec.z === -3 && dec.vehicle === 7 && gotB.byteLength === P.PLAYER_STATE_BYTES
    && Buffer.compare(Buffer.from(gotB).subarray(2), Buffer.from(sent).subarray(2)) === 0, JSON.stringify(dec));
  check('relay: nothing comes back to the sender', echo === null);

  b.send(P.encodePlayerEvent(P.PlayerEvent.Horn, 2));
  const ev = P.decodePlayerEvent((await a.takeBin(P.Frame.Event)) ?? new ArrayBuffer(0));
  check('relay: an event (horn) reaches the others', !!ev && ev.id === b.id && ev.code === P.PlayerEvent.Horn && ev.arg === 2);

  // host only frames
  const world = new Uint8Array(P.makeFrame(P.Frame.World, 300));
  world[2] = 42;
  b.send(world); // b is not the host
  const stray = await c.takeBin(P.Frame.World, 400);
  a.send(world);
  const w1 = await b.takeBin(P.Frame.World);
  check('world frames: relayed from the host only', stray === null && !!w1 && new Uint8Array(w1)[1] === a.id && new Uint8Array(w1)[2] === 42 && w1.byteLength === 302);
  c.send(P.makeFrame(P.Frame.ToHost, 4));
  const th = await a.takeBin(P.Frame.ToHost);
  const thStray = await b.takeBin(P.Frame.ToHost, 300);
  a.send(P.makeFrame(P.Frame.ToPlayer, 4, c.id));
  const tp = await c.takeBin(P.Frame.ToPlayer);
  const tpStray = await b.takeBin(P.Frame.ToPlayer, 300);
  check('to-host reaches only the host; to-player reaches only its target', !!th && new Uint8Array(th)[1] === c.id && thStray === null && !!tp && new Uint8Array(tp)[1] === a.id && tpStray === null);

  // rename
  c.sendJson({ t: 'name', name: [9, 9, 9] });
  const rn = await a.takeJson('name');
  check('a re-rolled name reaches the others', !!rn && rn.id === c.id && rn.name.join() === '9,9,9');

  // ping without waking the city
  a.send(P.PING_TEXT);
  const pong = await a.take((m) => m.text === P.PONG_TEXT, 1000);
  check('"ping" is answered "pong"', !!pong);

  // -- rejections after joining --
  const reject = async (label, code, action) => {
    const x = await join([10, 11]);
    await a.takeJson('join');
    action(x);
    const got = await x.waitClose(3000);
    const left = await a.takeJson('leave', 2000);
    check(`${label}: closed with ${code}, and the others are told`, got === code && !!left && left.id === x.id, `closed ${got}`);
  };
  await reject('an oversized state frame', P.Close.TooBig, (x) => x.send(new Uint8Array(P.MAX_PLAYER_FRAME_BYTES + 1).fill(1)));
  await reject('an oversized binary frame', P.Close.TooBig, (x) => { const f = new Uint8Array(P.MAX_HOST_FRAME_BYTES + 1); f[0] = P.Frame.World; x.send(f); });
  await reject('an oversized text message', P.Close.TooBig, (x) => x.send(JSON.stringify({ t: 'name', name: [1, 2], pad: 'x'.repeat(P.MAX_TEXT_CHARS) })));
  await reject('a typed name in a rename', P.Close.BadMessage, (x) => x.sendJson({ t: 'name', name: 'Bob' }));
  await reject('an out of range name index', P.Close.BadMessage, (x) => x.sendJson({ t: 'name', name: [1, 256] }));
  await reject('text that is not a known message', P.Close.BadMessage, (x) => x.send('hello everyone'));
  await reject('an unknown frame kind', P.Close.BadMessage, (x) => x.send(new Uint8Array([99, 0, 1])));
  await reject('a flood of messages', P.Close.TooFast, (x) => { for (let i = 0; i < P.RATE_BURST * 3; i++) x.send(P.KEEPALIVE_FRAME); });
  for (const p of [a, b, c]) p.clear();
  a.send(stateFrame(1));
  check('the city still works after the rejections', !!(await b.takeBin(P.Frame.State)));

  // -- facts --
  a.sendJson({ t: 'fact', k: P.FACT_BRIDGE, v: 0.25 });
  const f1 = await b.takeJson('fact');
  check('a fact written by the host reaches the others', !!f1 && f1.k === P.FACT_BRIDGE && f1.v === 0.25);
  await c.takeJson('fact');
  b.sendJson({ t: 'fact', k: P.FACT_BRIDGE, v: 0.99 });
  check('a fact written by someone else is ignored', (await c.takeJson('fact', 400)) === null);
  a.sendJson({ t: 'fact', k: P.FACT_WEATHER_SEED, v: 777 });
  a.sendJson({ t: 'fact', k: P.FACT_CLOCK, v: [3, 14.5] });
  a.sendJson({ t: 'fact', k: P.FACT_BRIDGE, v: 0.5 }); // a burst: the last value must be the one kept
  await c.take((m) => m.json && m.json.t === 'fact' && m.json.v === 0.5);
  await reject('a fact holding text', P.Close.BadMessage, (x) => x.sendJson({ t: 'fact', k: 'motto', v: 'hi' }));

  // -- host moves when the host disconnects --
  for (const p of [a, b, c]) p.clear();
  await a.close();
  const hb = await b.takeJson('host');
  const hc = await c.takeJson('host');
  const lb = await b.takeJson('leave');
  check('host leaves: the others are told who left and who hosts now', !!hb && !!hc && hb.id === hc.id && [b.id, c.id].includes(hb.id) && !!lb && lb.id === a.id, JSON.stringify(hb));
  await closeAll([b, c]);

  // -- facts survive an empty city --
  const d = await join([20, 21]);
  const fx = d.welcome.facts;
  check('durable facts survive everyone leaving and one player rejoining',
    fx[P.FACT_BRIDGE] === 0.5 && fx[P.FACT_WEATHER_SEED] === 777 && Array.isArray(fx[P.FACT_CLOCK]) && fx[P.FACT_CLOCK][1] === 14.5 && !('motto' in fx), JSON.stringify(fx));
  check('the lone rejoiner is the host', d.welcome.host === d.id && d.welcome.players.length === 1);

  // -- host moves when it reports a bad frame time (with hysteresis) --
  const t0 = Date.now();
  const e = await join([22, 23]);
  const beat = setInterval(() => { d.send(P.KEEPALIVE_FRAME); e.send(P.KEEPALIVE_FRAME); }, 1000);
  d.sendJson({ t: 'perf', ms: 60 });
  e.sendJson({ t: 'perf', ms: 10 });
  check('struggling host is NOT replaced before its minimum tenure', (await e.takeJson('host', 1500)) === null);
  d.sendJson({ t: 'perf', ms: P.HOST_SLOW_MS - 1 });
  e.sendJson({ t: 'perf', ms: 5 });
  const wait = Math.max(900, P.HOST_MIN_TENURE_MS + 900 - (Date.now() - t0));
  check('a host that is fast enough is kept, even when someone is faster', (await e.takeJson('host', wait)) === null);
  e.sendJson({ t: 'perf', ms: 35 }); // the candidate first: the city decides on whatever it last heard
  await sleep(100);
  d.sendJson({ t: 'perf', ms: 40 });
  check('a struggling host is kept when nobody is clearly faster (hysteresis)', (await e.takeJson('host', 900)) === null);
  e.sendJson({ t: 'perf', ms: 10 });
  const hp = await d.takeJson('host', 2000);
  check('a struggling host is replaced by a clearly faster player', !!hp && hp.id === e.id, JSON.stringify(hp));
  e.sendJson({ t: 'perf', ms: 90 });
  d.sendJson({ t: 'perf', ms: 8 });
  check('the job does not flap straight back', (await d.takeJson('host', 1200)) === null);

  // the new host may write facts, the old one may not
  d.sendJson({ t: 'fact', k: 'old.host', v: 1 });
  e.sendJson({ t: 'fact', k: 'new.host', v: 2 });
  const nf = await d.takeJson('fact', 1500);
  check('after the move, only the new host can write facts', !!nf && nf.k === 'new.host' && (await e.takeJson('fact', 300)) === null);

  // -- host moves when it stalls --
  clearInterval(beat);
  d.clear(); e.clear();
  const quiet = setInterval(() => d.send(P.KEEPALIVE_FRAME), 250); // d keeps talking, e (the host) says nothing
  const hs = await d.takeJson('host', P.HOST_STALL_MS + 2500);
  clearInterval(quiet);
  check('a host that goes silent for a few seconds is replaced', !!hs && hs.id === d.id, JSON.stringify(hs));
  await closeAll([d, e]);

  // -- the cap: 8 seats, one town, no second city --
  const crowd = [];
  for (let i = 0; i < P.CITY_CAP; i++) crowd.push(await join([i, i + 1]));
  const last = crowd[crowd.length - 1];
  check(`the cap is 8; players 1 to ${P.CITY_CAP} share the one town`, P.CITY_CAP === 8 && crowd.every((p) => p.welcome.city === 1) && last.welcome.players.length === P.CITY_CAP && new Set(crowd.map((p) => p.id)).size === P.CITY_CAP);
  const fullAt = Date.now();
  r = await open([30, 31]);
  check(`player ${P.CITY_CAP + 1} is refused: "full" with the retry hint and the seat count, closed ${P.Close.Full}`,
    !!r.refused && r.refused.t === 'full' && r.refused.retry === P.FULL_RETRY_S && r.refused.seats === P.CITY_CAP && r.code === P.Close.Full, JSON.stringify(r).slice(0, 200));
  check('there is no second city: nobody was told of a join, and no welcome was sent', !r.client && (await last.takeJson('join', 400)) === null);
  for (const p of crowd) p.clear();
  crowd[3].send(stateFrame(5));
  const heard = await Promise.all(crowd.map((p, i) => (i === 3 ? null : p.takeBin(P.Frame.State, 1500))));
  check(`a full town relays to all ${P.CITY_CAP - 1} others`, heard.filter(Boolean).length === P.CITY_CAP - 1);
  await crowd[0].close();
  if (HOME) {
    r = await open([32, 33]);
    check('the Node home keeps no memory of "full": the open seat is given at once', !!r.client && r.client.welcome.players.length === P.CITY_CAP, JSON.stringify(r).slice(0, 200));
    await closeAll([...crowd, ...(r.client ? [r.client] : [])]);
    return;
  }
  r = await open([32, 33]);
  check('just after a seat opens the Worker still answers "full" from memory (it asks the town again within 15 s)', !!r.refused && r.refused.t === 'full');
  await sleep(Math.max(0, B.FULL_CACHE_MS + 500 - (Date.now() - fullAt)));
  r = await open([32, 33]);
  check('once that memory has lapsed, the open seat is given', !!r.client && r.client.welcome.city === 1 && r.client.welcome.players.length === P.CITY_CAP, JSON.stringify(r).slice(0, 200));
  // "Where is main" with the placeholder key that is committed until the home computer exists.
  const stranger = generateKeyPairSync('ed25519').privateKey;
  const reg = await register(signed(stranger, 'https://some-quick-tunnel.trycloudflare.com', Date.now(), Date.now()));
  check('placeholder public key: even a well signed registration is refused (403)', reg === 403, `status ${reg}`);
  const where = await fetch(HTTP + P.MAIN_PATH);
  check('placeholder public key: "where is main" answers that there is none', where.status === 200 && (await where.json()).u === null);
  const hook = await (await fetch(HTTP + '/__test?add=86400000')).text();
  check('without the local test var there are no test hooks (the limits cannot be changed from outside)', hook.startsWith('port-calamity-city'), hook.slice(0, 80));
  await closeAll([...crowd, ...(r.client ? [r.client] : [])]);
}

// ---- the daily budget (a second local Worker, started with tiny limits) ----

const TEST_LIMITS = { doRequests: 100, seats: 2 };
const probe = async (q = '') => (await fetch(`${HTTP}/__test${q}`)).json();

async function runBudgetChecks() {
  let s = await probe();
  const line = TEST_LIMITS.doRequests * B.GAME_SHARE * B.PAUSE_AT;
  check(`pause line = limit x ${B.GAME_SHARE} share x ${B.PAUSE_AT} margin (real: ${B.pauseLines().doRequests} of ${B.FREE_PLAN_PER_DAY.doRequests} requests; here ${line} of ${TEST_LIMITS.doRequests})`,
    s.lines.doRequests === line && B.pauseLines().doRequests === 40000 && s.seats === 2, JSON.stringify(s.lines));

  // -- the cheap refusal: the Worker answers "full" from memory, the town is not asked --
  const a = await join([1, 2]);
  const b = await join([3, 4]);
  let r = await open([5, 6]);
  check('town full (2 seats here): the third is refused', !!r.refused && r.refused.t === 'full' && r.refused.seats === 2);
  const before = await probe();
  let cheap = 0;
  for (let i = 0; i < 5; i++) {
    r = await open([5, 6]);
    if (r.refused && r.refused.t === 'full' && r.code === P.Close.Full) cheap++;
  }
  const after = await probe();
  // The two probes are themselves requests to the town: exactly one of them lies between the two readings.
  const cost = after.used.doRequests - before.used.doRequests - 1;
  check('five more refusals cost the town nothing: 0 Durable Object requests, 0 rows (bar the one this look wrote), 5 Worker requests',
    cheap === 5 && Math.abs(cost) < 1e-9 && after.used.rowsWritten - before.used.rowsWritten === 1 && after.unreported - before.unreported === 6 && before.remembered === 'full',
    `cost ${cost}, unreported ${before.unreported} to ${after.unreported}, remembered ${before.remembered}`);

  // -- the count reaches the line --
  s = await probe('?forget');
  const need = Math.ceil((line - s.used.doRequests) * B.WS_MESSAGES_PER_REQUEST);
  const t0 = Date.now();
  let sentMsgs = 0;
  const flood = setInterval(() => { for (const c of [a, b]) { c.send(P.KEEPALIVE_FRAME); sentMsgs++; } }, 40);
  const ra = await a.takeJson('rest', 30000);
  clearInterval(flood);
  const rb = await b.takeJson('rest', 3000);
  const [ca, cb] = [await a.waitClose(3000), await b.waitClose(3000)];
  const midnight = (t) => (Math.floor(t / 86400000) + 1) * 86400000;
  check(`after about ${need} more messages (20 to a request) everybody is told "rest"`, !!ra && !!rb && sentMsgs >= need && sentMsgs < need + 60, `sent ${sentMsgs} in ${Date.now() - t0} ms`);
  check('the resume time is the next 00:00 UTC, with the service clock alongside', !!ra && ra.until === midnight(ra.now) && ra.until % 86400000 === 0 && Math.abs(ra.now - Date.now()) < 5000 && rb.until === ra.until, JSON.stringify(ra));
  check(`and their sockets are closed with ${P.Close.Rest}`, ca === P.Close.Rest && cb === P.Close.Rest, `${ca} ${cb}`);
  s = await probe();
  check('the count stopped just past the line (and was stored: 1 row or more written)', s.spent === 'doRequests' && s.used.doRequests >= line && s.used.doRequests < line + 3 && s.size === 0 && s.used.rowsWritten >= 1, JSON.stringify(s.used));

  // -- resting: joins refused, cheaply --
  r = await open([7, 8]);
  check('a join while resting is refused: "rest" with the resume time', !!r.refused && r.refused.t === 'rest' && r.refused.until === ra.until && r.code === P.Close.Rest, JSON.stringify(r).slice(0, 200));
  const rest0 = await probe();
  cheap = 0;
  for (let i = 0; i < 5; i++) {
    r = await open([7, 8]);
    if (r.refused && r.refused.t === 'rest' && r.refused.until === ra.until && r.code === P.Close.Rest) cheap++;
  }
  const rest1 = await probe('?flush');
  check('five more are answered by the Worker alone: 0 Durable Object requests', cheap === 5 && Math.abs(rest1.used.doRequests - rest0.used.doRequests - 1) < 1e-9 && rest0.remembered === 'rest',
    `${rest1.used.doRequests - rest0.used.doRequests - 1}`);
  check('the Worker reports its own requests to the town (refused ones included)', rest1.used.workerRequests >= 20 && rest1.unreported === 0, `${rest1.used.workerRequests} counted`);

  const resting = await fetch(HTTP + P.MAIN_PATH);
  check('"where is main" is still answered while the backup rests', resting.status === 200 && (await resting.json()).u === null);

  // -- a new UTC day --
  s = await probe('?add=86400000');
  check('after the day changes the count starts from zero', s.spent === null && s.used.doRequests <= 2 && s.until === ra.until + 86400000, JSON.stringify(s.used));
  const c = await join([9, 10]);
  const d = await join([11, 12]);
  c.send(stateFrame(7));
  check('and the town is open again: two join and are relayed', c.welcome.players.length === 1 && d.welcome.players.length === 2 && !!(await d.takeBin(P.Frame.State)));
  check('the welcome carries the (moved) service clock', Math.abs(c.welcome.now - (Date.now() + 86400000)) < 5000);
  await closeAll([c, d]);
}

// ---- where is main (a third local Worker, started with a test public key) ----

function signed(key, u, t, n) {
  return JSON.stringify({ u, t, n, sig: sign(null, Buffer.from(W.registrationText(u, t, n)), key).toString('base64url') });
}
async function register(body) {
  return (await fetch(HTTP + P.MAIN_PATH, { method: 'POST', body })).status;
}
const whereIs = async (origin = GOOD_ORIGIN) => fetch(HTTP + P.MAIN_PATH, { headers: origin ? { origin } : {} });
const node = (script, argv, env, stdio = 'ignore') => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', pathJoin(serverDir, 'home', script), ...argv], { cwd: serverDir, env: { ...process.env, ...env }, stdio });

async function runMainChecks(keyDir) {
  const key = createPrivateKey(readFileSync(pathJoin(keyDir, 'main.key'), 'utf8'));
  const other = generateKeyPairSync('ed25519').privateKey;
  const A = 'https://first-quick-tunnel.trycloudflare.com', B2 = 'https://second-quick-tunnel.trycloudflare.com';
  let now = Date.now();

  let r = await whereIs();
  check('before any registration: no main; the answer is cacheable for a minute and readable by the game only',
    r.status === 200 && (await r.json()).u === null && r.headers.get('cache-control') === `public, max-age=${W.MAIN_CACHE_S}` && r.headers.get('access-control-allow-origin') === GOOD_ORIGIN
    && (await whereIs('https://evil.example')).headers.get('access-control-allow-origin') === null);

  check('a registration signed by a different key is refused (401)', (await register(signed(other, A, now, now))) === 401);
  const forB = JSON.parse(signed(key, B2, now, now));
  check('a signature made for another address is refused (401)', (await register(JSON.stringify({ ...forB, u: A }))) === 401);
  const wrong = ['https://evil.example', 'http://first-quick-tunnel.trycloudflare.com', 'https://a.trycloudflare.com.evil.example', 'https://a.trycloudflare.com/path', 'https://trycloudflare.com', 'https://a.b.trycloudflare.com', 'https://a.trycloudflare.com:8443', 'https://A.trycloudflare.com'];
  const codes = [];
  for (const u of wrong) codes.push(await register(signed(key, u, now, now)));
  check(`a well signed registration for any other kind of address is refused (${wrong.length} tried, all 400)`, codes.every((c) => c === 400), codes.join());
  check('a stale timestamp is refused (401), in the past or the future', (await register(signed(key, A, now - W.MAIN_STALE_MS - 5000, now))) === 401 && (await register(signed(key, A, now + W.MAIN_STALE_MS + 5000, now))) === 401);
  check('junk and oversized bodies are refused (400, 413)', (await register('hello')) === 400 && (await register(JSON.stringify({ u: A, t: now, n: now, sig: 'x'.repeat(700) }))) === 413);
  r = await whereIs();
  check('after all those refusals there is still no main', (await r.json()).u === null);

  const before = await probe('?forget');
  const good = signed(key, A, now, now);
  check('a well signed, fresh registration is accepted (204)', (await register(good)) === 204);
  const after = await probe();
  check('it cost the town 1 request and 2 rows (the address, and the count)', Math.abs(after.used.doRequests - before.used.doRequests - 2) < 1e-9 && after.used.rowsWritten - before.used.rowsWritten === 3,
    `requests ${after.used.doRequests - before.used.doRequests - 1}, rows ${after.used.rowsWritten - before.used.rowsWritten - 1}`);
  r = await whereIs();
  check('"where is main" now answers the registered address', (await r.json()).u === A);
  let same = 0;
  for (let i = 0; i < 5; i++) if ((await (await whereIs()).json()).u === A) same++;
  const cheap = await probe();
  check('five more lookups are answered from the Worker\'s memory: 0 Durable Object requests', same === 5 && Math.abs(cheap.used.doRequests - after.used.doRequests - 1) < 1e-9, `${cheap.used.doRequests - after.used.doRequests - 1}`);
  await probe('?forget');
  check('a fresh Worker isolate learns it from the town', (await (await whereIs()).json()).u === A);
  check('the same registration again is refused (409, replay)', (await register(good)) === 409);
  check('a new signature with an old counter is refused (409)', (await register(signed(key, B2, Date.now(), now - 1))) === 409);
  check('the address did not change', (await (await whereIs()).json()).u === A);
  check('a later registration moves main (the tunnel restarted)', (await register(signed(key, B2, Date.now(), now + 1))) === 204 && (await (await whereIs()).json()).u === B2);

  // -- the home computer's own programs: the game service, a stand-in cloudflared, and the supervisor --
  const homePort = PORT + 5;
  const stateDir = mkdtempSync(pathJoin(tmpdir(), 'port-calamity-home-'));
  const fake = pathJoin(stateDir, 'cloudflared');
  const C = 'https://third-quick-tunnel.trycloudflare.com';
  writeFileSync(fake, `#!/bin/sh\necho "INF Requesting new quick Tunnel on trycloudflare.com..." >&2\necho "ERR something about https://api.trycloudflare.com and a server at 198.51.100.7" >&2\nsleep 1\necho "INF |  ${C}  |" >&2\nexec sleep 600\n`);
  chmodSync(fake, 0o755);
  const home = node('main.ts', [], { PC_PORT: String(homePort), PC_STATE: stateDir });
  let out = '';
  const sup = node('tunnel.ts', [], { PC_PORT: String(homePort), PC_KEYDIR: keyDir, PC_CLOUDFLARED: fake, PC_REGISTER: HTTP }, ['ignore', 'pipe', 'pipe']);
  sup.stdout.on('data', (d) => (out += d));
  sup.stderr.on('data', (d) => (out += d));
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    await sleep(500);
    await probe('?forget');
    found = (await (await whereIs()).json()).u === C;
  }
  check('the supervisor reads the tunnel address from cloudflared, signs it and registers it', found, out.slice(-300));
  check('the private key is readable by its owner only (0600); the public key file matches', (statSync(pathJoin(keyDir, 'main.key')).mode & 0o777) === 0o600 && out.includes(readFileSync(pathJoin(keyDir, 'main.pub'), 'utf8').trim()));
  check('the supervisor prints no numeric address and none of cloudflared\'s own lines', !/\d+\.\d+\.\d+\.\d+|api\.trycloudflare|localhost/.test(out) && out.includes(`tunnel up: ${C}`), out.slice(-300));
  const gone = new Promise((res) => sup.once('exit', res));
  sup.kill('SIGTERM');
  check('stopped, it stops cloudflared too and exits cleanly', (await gone) === 0);
  home.kill('SIGTERM');
  rmSync(stateDir, { recursive: true, force: true });

  // -- a heartbeat long overdue --
  await probe(`?add=${W.MAIN_OVERDUE_MS - 120000}`);
  check('just inside the overdue time the address is still given', (await (await whereIs()).json()).u === C);
  await probe('?add=180000');
  check(`no heartbeat for ${W.MAIN_OVERDUE_MS / 60000} minutes: the address is dropped`, (await (await whereIs()).json()).u === null);
  now = Date.now() + W.MAIN_OVERDUE_MS + 60000;
  check('an old registration cannot bring it back (409); the next heartbeat can', (await register(signed(key, A, now, 5))) === 409 && (await register(signed(key, A, now, now))) === 204 && (await (await whereIs()).json()).u === A);
  const perDay = 86400000 / W.MAIN_HEARTBEAT_MS, lines = B.pauseLines();
  console.log(`      heartbeat every ${W.MAIN_HEARTBEAT_MS / 60000} min = ${perDay} a day: ${(100 * perDay / lines.workerRequests).toFixed(2)}% of the Worker request pause line, ${(100 * perDay / lines.doRequests).toFixed(2)}% of the Durable Object one, ${(100 * 2 * perDay / lines.rowsWritten).toFixed(2)}% of rows written, ${(100 * perDay * (B.AWAKE_GAP_MS / 1000) * B.DO_BILLED_GB / lines.doGbSeconds).toFixed(2)}% of duration (upper bound)`);
}

// ---- the Node home only ----

async function runHomeChecks() {
  let h = await (await fetch(HTTP + '/health')).json();
  check('/health: version, release, uptime and seats, and nothing else', h.ok === true && h.v === P.PROTOCOL_VERSION && h.release === 'test-1' && h.seats === P.CITY_CAP && h.players === 0 && h.uptime >= 0
    && Object.keys(h).sort().join() === 'ok,players,release,seats,service,uptime,v', JSON.stringify(h));
  const post = await fetch(HTTP + '/health', { method: 'POST', body: 'x' });
  check('anything but GET is refused (405)', post.status === 405, `status ${post.status}`);
  // Facts across a restart of the process (the file in the state folder).
  const a = await join([1, 2]);
  a.sendJson({ t: 'fact', k: 'restart.proof', v: [4, 5, 6] });
  await sleep(P.FACT_FLUSH_MS + 600);
  a.sendJson({ t: 'fact', k: P.FACT_BRIDGE, v: 0.75 }); // a write the SIGTERM must flush
  await sleep(200);
  await stopServer(true);
  check('a stopped home closes its sockets (1001)', (await a.waitClose(3000)) === 1001, `closed ${a.closed && a.closed.code}`);
  await startServer();
  const b = await join([3, 4]);
  const fx = b.welcome.facts;
  check('facts survive a restart of the process', Array.isArray(fx['restart.proof']) && fx['restart.proof'].join() === '4,5,6' && fx[P.FACT_BRIDGE] === 0.75 && fx[P.FACT_WEATHER_SEED] === 777, JSON.stringify(fx));
  await closeAll([b]);
  // The listener: loopback only.
  check('the log holds no address of any kind', !/\d+\.\d+\.\d+\.\d+|::1|localhost/.test(serverLog), serverLog.slice(0, 200));
  // Fewer seats (a test variable; it cannot raise the cap).
  await stopServer(true);
  await startServer(null, { PC_SEATS: '99' });
  h = await (await fetch(HTTP + '/health')).json();
  check('PC_SEATS cannot raise the cap above 8', h.seats === P.CITY_CAP, JSON.stringify(h));
}

// ---- measurement ----

async function runMeasure() {
  const seconds = arg('seconds', 60);
  const players = arg('players', P.CITY_CAP);
  const still = Math.min(players, arg('still', Math.floor(players / 2)));
  const hz = arg('hz', P.SEND_HZ);
  const clients = [];
  for (let i = 0; i < players; i++) clients.push(await join([i, i + 1]));
  await sleep(300);
  for (const c of clients) {
    c.counting = true;
    c.msgsIn = c.bytesIn = c.msgsOut = c.bytesOut = 0;
    c.anyAt = Date.now();
  }
  // The client's real pattern (src/net/index.ts): a driver sends a State frame `hz` times a second; a player standing
  // still sends none, only the frame time every PERF_INTERVAL_MS and a one byte keepalive when KEEPALIVE_MS have
  // passed with nothing else sent. The first `still` clients stand still.
  const buf = new ArrayBuffer(P.PLAYER_STATE_BYTES);
  let tick = 0;
  const timers = [];
  timers.push(setInterval(() => {
    tick++;
    for (let i = still; i < clients.length; i++) {
      P.encodePlayerState({ id: 0, t: tick * 100, x: i * 10 + tick * 0.1, y: 1, z: tick * 0.2, yaw: tick * 0.01, vx: 1, vz: 2, mode: 0, flags: 0, vehicle: 0 }, buf);
      clients[i].send(buf.slice(0));
      clients[i].anyAt = Date.now();
    }
  }, 1000 / hz));
  timers.push(setInterval(() => clients.forEach((c, i) => { c.sendJson({ t: 'perf', ms: 8 + i }); c.anyAt = Date.now(); }), P.PERF_INTERVAL_MS));
  timers.push(setInterval(() => { const now = Date.now(); for (const c of clients) if (now - c.anyAt >= P.KEEPALIVE_MS) { c.send(P.KEEPALIVE_FRAME); c.anyAt = now; } }, 250));
  const started = Date.now();
  await sleep(seconds * 1000);
  timers.forEach(clearInterval);
  const elapsed = (Date.now() - started) / 1000;
  await sleep(500);

  const sum = (list, f) => list.reduce((n, c) => n + f(c), 0);
  const msgsUp = sum(clients, (c) => c.msgsOut), bytesUp = sum(clients, (c) => c.bytesOut);
  const msgsDown = sum(clients, (c) => c.msgsIn), bytesDown = sum(clients, (c) => c.bytesIn);
  const drivers = clients.slice(still), idlers = clients.slice(0, still);
  const expectDown = drivers.length * (clients.length - 1) * tick;
  await closeAll(clients);

  // Every figure below comes from src/budget.ts (limits read from Cloudflare's documentation on Nov 21 2026).
  const lines = B.pauseLines();
  const perHour = (list) => (list.length ? (sum(list, (c) => c.msgsOut) / list.length) * (3600 / elapsed) : 0);
  const dMsgs = perHour(drivers), sMsgs = perHour(idlers);
  const dReq = dMsgs / B.WS_MESSAGES_PER_REQUEST, sReq = sMsgs / B.WS_MESSAGES_PER_REQUEST;
  const n = (v, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d });
  const awakeHours = lines.doGbSeconds / B.DO_BILLED_GB / 3600;
  console.log(`MEASURE  ${players} players (${drivers.length} driving at ${hz} Hz, ${idlers.length} standing still), ${n(elapsed, 1)} s`);
  console.log(`  into the service:   ${n(msgsUp)} messages, ${n(bytesUp)} bytes  (${n(msgsUp / elapsed, 1)} msg/s, ${n(bytesUp / elapsed)} B/s)`);
  console.log(`  out of the service: ${n(msgsDown)} messages, ${n(bytesDown)} bytes  (${n(msgsDown / elapsed, 1)} msg/s, ${n(bytesDown / elapsed)} B/s); outgoing messages are free`);
  console.log(`  relay loss: ${n(expectDown - msgsDown)} of ${n(expectDown)} expected state frames not seen`);
  console.log(`  a driver:        ${n(dMsgs)} messages an hour = ${n(dReq)} billed requests (20 messages to a request)`);
  console.log(`  a still player:  ${n(sMsgs)} messages an hour = ${n(sReq)} billed requests`);
  console.log(`  pause line: ${n(B.FREE_PLAN_PER_DAY.doRequests)} requests a day x ${B.GAME_SHARE} (the game's share) x ${B.PAUSE_AT} (margin) = ${n(lines.doRequests)} requests`);
  if (dReq > 0) console.log(`  all driving:  ${n(lines.doRequests / dReq, 1)} player hours a day; ${P.CITY_CAP} people driving nonstop = ${n(lines.doRequests / dReq / P.CITY_CAP, 1)} hours, then rest until 00:00 UTC`);
  if (dReq > 0 && sReq > 0) {
    const half = lines.doRequests / ((dReq + sReq) / 2);
    console.log(`  half idle:    ${n(half, 1)} player hours a day; ${P.CITY_CAP} people, half of them still = ${n(half / P.CITY_CAP, 1)} hours`);
    console.log(`  all still:    requests would last ${n(lines.doRequests / sReq / P.CITY_CAP, 1)} hours for ${P.CITY_CAP}, so the duration line decides instead (next line)`);
  }
  console.log(`  duration line: ${n(B.FREE_PLAN_PER_DAY.doGbSeconds)} GB-s x ${B.GAME_SHARE} x ${B.PAUSE_AT} = ${n(lines.doGbSeconds)} GB-s = the town awake for ${n(awakeHours, 1)} hours a day at most,`);
  console.log(`             however many are in it (counted as an upper bound: awake whenever messages are under ${B.AWAKE_GAP_MS / 1000} s apart)`);
  console.log(`  a host World frame at ${hz} Hz (stage 2) would add ${n((hz * 3600) / B.WS_MESSAGES_PER_REQUEST)} requests per town hour`);
}

// ---- main ----

process.on('uncaughtException', (err) => { console.log('FAIL  ' + err.stack); void stopServer(); process.exit(1); });

const hardStop = setTimeout(() => { console.log('FAIL  timed out'); void stopServer(); process.exit(1); }, (MEASURE ? arg('seconds', 60) + 90 : 360) * 1000);
try {
  await startServer();
  if (MEASURE) await runMeasure();
  else if (HOME) {
    await runChecks();
    await runHomeChecks();
    console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  } else {
    await runChecks();
    await stopServer();
    await startServer(TEST_LIMITS);
    await runBudgetChecks();
    await stopServer();
    // The key pair is made by the home computer's own program, exactly as the install does it.
    const keyDir = mkdtempSync(pathJoin(tmpdir(), 'port-calamity-key-'));
    const made = node('tunnel.ts', ['--key'], { PC_KEYDIR: keyDir }, ['ignore', 'pipe', 'inherit']);
    let pub = '';
    made.stdout.on('data', (d) => (pub += d));
    await new Promise((res) => made.once('exit', res));
    check('the home computer makes its key pair and prints the public half (43 characters)', W.isRealKey(pub.trim()), pub.slice(0, 80));
    await startServer({}, { TEST_MAIN_KEY: pub.trim() });
    await runMainChecks(keyDir);
    rmSync(keyDir, { recursive: true, force: true });
    console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  }
} catch (err) {
  failed++;
  console.log('FAIL  ' + (err && err.stack ? err.stack : err));
} finally {
  clearTimeout(hardStop);
  await stopServer();
}
process.exit(failed === 0 ? 0 : 1);
