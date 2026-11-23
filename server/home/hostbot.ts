// The HOST BOT: the town's permanent host, on the mini PC beside the message service.
//
// The shared town (traffic, parked cars, the crowd, police, fire...) is simulated by one browser, the host. This
// program keeps one such browser running here, always: headless Chromium showing the public game in its host-only
// mode (src/net/hostbot.ts), joined to the service on this computer with a signed pass, so the service makes it the
// host whenever it is live and the players' own browsers only draw. It has no player, draws nothing, takes no seat.
//
// Node 22.18 or newer runs this file as it is (it strips the types). Its only package is `ws` (already here for the
// service), used to ask the page for its numbers through Chromium's own debugging socket (loopback only).
//
// Environment (all optional):
//   PC_PORT        the message service's port (8788)
//   PC_KEYDIR      where the tunnel keeps main.key (./state/key); this program only reads it
//   PC_BOT_KEYFILE a PEM private key instead (tests)
//   PC_CHROMIUM    the browser (else chromium, chromium-browser or google-chrome on the PATH)
//   PC_GAME_URL    the game (https://gta.doofus.live/)
//   PC_BOT_STATE   a folder for the browser's throwaway profile (./state/bot)
//   PC_BOT_ARGS    extra browser switches, space separated (tests)
//   PC_BOT_LOG_MS  how often the line is logged (60000; tests)
//   PC_CURRENT     the "current release" link: when it moves, exit so that systemd starts the new copy
//
// It logs one line a minute: players, the town's cars, people and police cars, tick time, CPU and memory.
// Privacy: no addresses, no names.

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { BOT_PARAM, hostBotText } from '../../src/net/protocol.ts';

const PORT = Number(process.env.PC_PORT) || 8788;
const KEYDIR = process.env.PC_KEYDIR || join(process.cwd(), 'state', 'key');
const GAME_URL = (process.env.PC_GAME_URL || 'https://gta.doofus.live/').replace(/\/?$/, '/');
const STATE = process.env.PC_BOT_STATE || join(process.cwd(), 'state', 'bot');
const CURRENT = process.env.PC_CURRENT || '';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** How long a pass lasts; the browser is restarted (with a new one) well before. */
const PASS_S = 36 * 3600;
const RESTART_EVERY_MS = 24 * 3600 * 1000;
const LOG_MS = Number(process.env.PC_BOT_LOG_MS) || 60_000;
/** A page that has not answered (or has no host bot in it) for this long is started again. */
const DEAD_MS = 3 * 60_000;
const VERSION_MS = 5 * 60_000;

function log(line: string): void {
  console.log(line); // journald adds the time
}

function loadKey(): KeyObject {
  const file = process.env.PC_BOT_KEYFILE || join(KEYDIR, 'main.key');
  return createPrivateKey(readFileSync(file, 'utf8'));
}

function pass(key: KeyObject): string {
  const exp = Math.floor(Date.now() / 1000) + PASS_S;
  return `${exp}.${sign(null, Buffer.from(hostBotText(exp)), key).toString('base64url')}`;
}

function findBrowser(): string {
  if (process.env.PC_CHROMIUM) return process.env.PC_CHROMIUM;
  for (const c of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(c)) return c;
  const w = spawnSync('sh', ['-c', 'command -v chromium || command -v chromium-browser || command -v google-chrome'], { encoding: 'utf8' });
  return (w.stdout || '').trim();
}

function pageUrl(p: string): string {
  const q = new URLSearchParams({
    hostbot: '1', net: `ws://127.0.0.1:${PORT}`, q: 'low', glb: '0', people: '0', flora: '0', props: '0', noupdate: '1', save: '0',
  });
  q.set(BOT_PARAM, p);
  return `${GAME_URL}?${q.toString()}`;
}

// ---- the browser ----

let browser: ChildProcess | null = null;
let startedAt = 0;
let lastGood = 0;
let devPort = 0;
let buildId = '';
let stopping = false;

function start(): void {
  if (stopping) return;
  const exe = findBrowser();
  if (!exe) {
    log('no Chromium found (the installer adds the Debian package "chromium"); trying again in a minute');
    setTimeout(start, 60_000);
    return;
  }
  const profile = join(STATE, 'profile');
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* fine */ }
  mkdirSync(profile, { recursive: true });
  let key: KeyObject;
  try {
    key = loadKey();
  } catch {
    log('cannot read the key yet (the tunnel makes it on its first start); trying again in a minute');
    setTimeout(start, 60_000);
    return;
  }
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    // (No sandbox: systemd's lock-down forbids the namespaces it needs, and the page is the game's own.)
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-dev-shm-usage',
    // Nothing is drawn, but the game still makes its WebGL context: in software, which costs nothing when unused.
    '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=320,240', '--js-flags=--max-old-space-size=384',
    ...(process.env.PC_BOT_ARGS ? process.env.PC_BOT_ARGS.split(' ').filter(Boolean) : []),
    pageUrl(pass(key)),
  ];
  const c = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  browser = c;
  startedAt = lastGood = Date.now();
  devPort = 0;
  let err = '';
  c.stderr?.on('data', (d: Buffer) => {
    err = (err + d.toString('utf8')).slice(-4000);
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
    if (m && !devPort) devPort = Number(m[1]);
  });
  c.on('exit', (code) => {
    if (browser !== c) return;
    browser = null;
    if (stopping) return;
    log(`browser stopped (exit ${code ?? 'by signal'}); starting it again in 5 s`);
    setTimeout(start, 5000);
  });
  log(`browser started: ${GAME_URL} as the town's host`);
}

function restart(why: string): void {
  log(`restarting the browser: ${why}`);
  const c = browser;
  browser = null;
  if (c) {
    c.removeAllListeners('exit');
    c.kill('SIGTERM');
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  }
  setTimeout(start, 2000);
}

// ---- asking the page ----

interface Stats { status: string; host: boolean; players: number; cars: number; people: number; police: number; tickMs: number; tickMax: number; ticks: number; mode: string }

async function ask(): Promise<Stats | null> {
  if (!devPort) return null;
  const list = (await (await fetch(`http://127.0.0.1:${devPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as { type: string; webSocketDebuggerUrl?: string }[];
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  try {
    return await new Promise<Stats | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__hostbot ? JSON.stringify(window.__hostbot.stats()) : ""', returnByValue: true } })));
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { id?: number; result?: { result?: { value?: string } } };
        if (m.id !== 1) return;
        clearTimeout(timer);
        const v = m.result?.result?.value;
        resolve(v ? (JSON.parse(v) as Stats) : null);
      });
    });
  } finally {
    ws.terminate();
  }
}

/** CPU (share of one core since the last call) and memory of this unit, from its cgroup (Linux; nothing elsewhere). */
let cpuAt = 0, cpuUs = 0;
function usage(): string {
  try {
    const rel = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim();
    if (!rel) return '';
    const dir = join('/sys/fs/cgroup', rel);
    const mem = Number(readFileSync(join(dir, 'memory.current'), 'utf8'));
    const us = Number(/usage_usec (\d+)/.exec(readFileSync(join(dir, 'cpu.stat'), 'utf8'))?.[1] ?? 0);
    const now = Date.now();
    const cpu = cpuAt ? ((us - cpuUs) / 1000 / (now - cpuAt)) * 100 : 0;
    cpuAt = now; cpuUs = us;
    return `, cpu ${cpu.toFixed(0)}% of a core, memory ${(mem / 1048576).toFixed(0)} MB`;
  } catch {
    return '';
  }
}

async function minute(): Promise<void> {
  let s: Stats | null = null;
  try { s = await ask(); } catch { /* not up yet, or stuck */ }
  const now = Date.now();
  if (s && s.status) lastGood = now;
  if (s) {
    log(`${s.status}${s.host ? ', host' : ', NOT host'}: ${s.players} players, ${s.cars} town cars, ${s.people} people, ${s.police} police cars; tick ${s.tickMs} ms (worst ${s.tickMax}, ${s.ticks} ticks)${usage()}`);
  } else log(`no answer from the page yet${usage()}`);
  if (browser && now - lastGood > DEAD_MS) restart('the page has not answered for 3 minutes');
  else if (browser && now - startedAt > RESTART_EVERY_MS) restart('the daily fresh start');
}

/** A new edition of the game: the browser starts again on it (seen twice, five minutes apart, like the players' pages). */
let seenId = '';
async function version(): Promise<void> {
  try {
    const r = await fetch(`${GAME_URL}version.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return;
    const id = String(((await r.json()) as { id?: unknown }).id ?? '');
    if (!id) return;
    if (!buildId) { buildId = id; return; }
    if (id !== buildId && id === seenId) { buildId = id; restart('a new edition of the game'); }
    seenId = id;
  } catch { /* offline: next time */ }
}

// ---- running ----

function stop(why: string): void {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why})`);
  const c = browser;
  browser = null;
  if (c) c.kill('SIGTERM');
  setTimeout(() => { try { c?.kill('SIGKILL'); } catch { /* gone */ } process.exit(0); }, 3000);
}
process.on('SIGTERM', () => stop('asked to'));
process.on('SIGINT', () => stop('asked to'));
process.on('uncaughtException', (e) => {
  log(`crashed: ${e && e.stack ? e.stack : String(e)}`);
  browser?.kill('SIGKILL');
  process.exit(1);
});

if (CURRENT) {
  const mine = realpathSync(ROOT);
  setInterval(() => {
    let now = mine;
    try { now = realpathSync(CURRENT); } catch { /* mid-switch */ }
    if (now !== mine) stop('a newer version is installed');
  }, 5000).unref();
}

mkdirSync(STATE, { recursive: true });
start();
void version();
setInterval(() => { void minute(); }, LOG_MS);
setInterval(() => { void version(); }, VERSION_MS);
