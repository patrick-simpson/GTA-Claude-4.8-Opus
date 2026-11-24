// The host bot (Nov 23, server/home/hostbot.ts + src/net/hostbot.ts): the mini PC's dedicated host, here on this
// computer against LOCAL stand-ins (the Node home as main, as hard1.mjs does; nothing outside is touched).
//
//   node tools/net/hostbot.mjs
//
//  1. the home service with a test key; the real hostbot.ts runs Playwright's Chromium on the game (a local Vite
//     server) with a pass signed by that key; /health says the bot is in;
//  2. players A and B join: the bot is the host, both are guests of its traffic, people and police; neither is told of
//     the bot (one other player each, "2 in town"), and /health counts 2 players;
//  3. shared: A and B see the same town cars in the same places; smooth: B's town cars move as fast frame to frame as
//     their speed says (pops counted);
//  4. the bot logs its line (players, town cars, tick time); its CPU and memory on this computer are measured;
//  5. a pass signed by another key is refused; the bot stopped (its browser killed): a player takes over at once;
//  6. the bot back: it is the host again and both players are guests again;
//  7. the seats: with 2 seats (PC_SEATS) and the bot in, a third player is told the town is full;
//  8. no errors on any page.
// PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ROOT } from '../pw.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.PC_BOT_PUBKEY = String(publicKey.export({ format: 'jwk' }).x);
process.env.PC_SEATS = '2';
const { services, check: verdict, failures, sleep, wait } = await import('./hardlib.mjs');
const check = (what, ok, detail = '') => verdict(!!ok, what, detail);

const MAIN = 8971;
const S = services({ main: MAIN, lookup: MAIN + 1, backup: MAIN + 2 });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pc-hostbot-test-'));
const keyFile = path.join(tmp, 'bot.key');
writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
const health = async () => { try { return await (await fetch(`http://127.0.0.1:${MAIN}/health`)).json(); } catch { return null; } };

const vite = await createServer({ root: ROOT, logLevel: 'error', clearScreen: false, optimizeDeps: { noDiscovery: true, include: [] },
  cacheDir: path.join(os.tmpdir(), 'pc-vite-bot-' + process.pid), server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await vite.listen();
const gameUrl = `http://127.0.0.1:${vite.httpServer.address().port}/`;

let bot = null, botLog = '';
const startBot = () => {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'home', 'hostbot.ts')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PC_PORT: String(MAIN), PC_BOT_KEYFILE: keyFile, PC_CHROMIUM: chromium.executablePath(), PC_GAME_URL: gameUrl,
      PC_BOT_STATE: path.join(tmp, 'bot'), PC_BOT_LOG_MS: '10000' },
  });
  c.stdout.on('data', (d) => { botLog += d.toString(); });
  c.stderr.on('data', (d) => { botLog += d.toString(); });
  bot = c;
};
/** The bot and its browser, all of it (Windows has no process groups: the tree by its root). */
const killBot = () => {
  if (!bot) return;
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(bot.pid), '/T', '/F'], { stdio: 'ignore' }); else bot.kill('SIGTERM'); } catch { /* gone */ }
  bot = null;
};
/** CPU (share of one core) and memory of the bot's browser processes over `ms`, from the OS (Windows). */
const usage = async (ms) => {
  if (process.platform !== 'win32') return null;
  const probe = () => JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command',
    `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(tmp)}*' -and $_.Name -notlike 'node*' }; ` +
    `@{ cpu = ($p | Measure-Object -Property UserModeTime -Sum).Sum + ($p | Measure-Object -Property KernelModeTime -Sum).Sum; ` +
    `ws = ($p | Measure-Object -Property WorkingSetSize -Sum).Sum; priv = ($p | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64 } | Measure-Object -Sum).Sum; n = @($p).Count } | ConvertTo-Json -Compress`], { encoding: 'utf8' }));
  const a = probe(), t0 = Date.now();
  await sleep(ms);
  const b = probe();
  return { cpu: ((b.cpu - a.cpu) / 1e4) / (Date.now() - t0) * 100, wsMB: b.ws / 1048576, privMB: b.priv / 1048576, procs: b.n };
};

/** Frame to frame on one page for `ms`: each town car near (x, z) drawn, its speed from displacement against its own steady speed. */
const smooth = (t, x, z, ms) => t.page.evaluate(async ([x, z, ms]) => {
  const g = window.__game.game, tracks = new Map();
  const end = performance.now() + ms;
  await new Promise((done) => {
    const f = (t) => {
      const ghosts = new Set(g.vehicles.ghostList);
      for (const v of g.vehicles.list) if (v.shared && !ghosts.has(v) && Math.hypot(v.x - x, v.z - z) < 90) {
        let a = tracks.get(v); if (!a) tracks.set(v, a = []); a.push([t, v.x, v.z]);
      }
      if (performance.now() < end) requestAnimationFrame(f); else done();
    };
    requestAnimationFrame(f);
  });
  let n = 0, pops = 0, fast = 0, cars = 0;
  for (const a of tracks.values()) {
    if (a.length < 20) continue;
    const sp = [];
    for (let i = 1; i < a.length; i++) { const dt = (a[i][0] - a[i - 1][0]) / 1000; if (dt > 0) sp.push(Math.hypot(a[i][1] - a[i - 1][1], a[i][2] - a[i - 1][2]) / dt); }
    const sorted = [...sp].sort((p, q) => p - q), med = sorted[Math.floor(sorted.length / 2)];
    if (med < 2) continue;
    cars++;
    for (const s of sp) { n++; if (s > med * 2.5 || s < med / 2.5) pops++; if (s > med * 2.5) fast++; }
  }
  return { cars, frames: n, pops, fast, share: n ? pops / n : 0, fps: n ? 0 : 0 };
}, [x, z, ms]);

const SPOT = { x: -30, z: 30 };
const pages = [];
try {
  S.startMain();
  if (!(await S.up(MAIN))) throw new Error('the local service did not start (run `npm ci` in server/ once)');

  // 1. The bot comes in.
  startBot();
  const h1 = await wait(async () => { const h = await health(); return h && h.bot ? h : null; }, 120000, 1000);
  check('the bot joins the home service with its signed pass', !!h1, JSON.stringify(h1));
  // A pass signed by somebody else is refused.
  const other = generateKeyPairSync('ed25519').privateKey, exp = Math.floor(Date.now() / 1000) + 3600;
  const fake = `${exp}.${sign(null, Buffer.from(`port-calamity hostbot ${exp}`), other).toString('base64url')}`;
  const res = await new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${MAIN}/?v=6&name=1.2&bot=${fake}`); ws.onopen = () => { ws.close(); r('opened'); }; ws.onerror = () => r('refused'); });
  check('a pass signed by another key is refused', res === 'refused', res);

  // 2. Two players.
  const A = await S.visitor('A', S.viaMain), B = await S.visitor('B', S.viaMain);
  pages.push(A, B);
  for (const [t, dx] of [[A, 0], [B, 14]]) await t.go(SPOT.x + dx, SPOT.z, 0);
  const both = await wait(async () => {
    const [a, b] = await Promise.all([A.net(), B.net()]);
    return a.status === 'online' && b.status === 'online' && a.traffic.mode === 'guest' && b.traffic.mode === 'guest' ? [a, b] : null;
  }, 60000, 500);
  const [na, nb] = both ?? [await A.net(), await B.net()];
  check('the bot is the host: neither player is', !!both && na.host === nb.host && na.host !== na.id && na.host !== nb.id, `A#${na.id} B#${nb.id} host ${na.host}; traffic ${na.traffic.mode}/${nb.traffic.mode}`);
  const pp = await wait(async () => { const [a, b] = await Promise.all([A.net(), B.net()]); return a.people.mode === 'guest' && b.people.mode === 'guest' && a.police.mode === 'guest' && b.police.mode === 'guest' ? [a, b] : null; }, 30000, 500);
  check('the crowd and the police are the bot\'s too', !!pp, pp ? '' : JSON.stringify([na.people.mode, na.police.mode, nb.people.mode, nb.police.mode]));
  check('nobody is told of the bot: one other player each, "2 in town"', na.remotes.length === 1 && nb.remotes.length === 1 && na.countText === '2 in town',
    `A sees ${na.remotes.map((r) => r.id)}, B sees ${nb.remotes.map((r) => r.id)}, "${na.countText}"`);
  const h2 = await health();
  check('/health counts the 2 players and the bot apart', h2.players === 2 && h2.bot === true, JSON.stringify(h2));

  // 3. Shared and smooth.
  await sleep(8000);
  const [ca, cb] = await Promise.all([A.net(), B.net()]);
  const carsA = ca.traffic.cars ?? [], carsB = cb.traffic.cars ?? [];
  const same = carsA.filter((c) => carsB.some((d) => d.wid === c.wid && Math.hypot(d.x - c.x, d.z - c.z) < 4)).length;
  check('A and B see the same town cars in the same places', carsA.length >= 3 && same >= Math.min(carsA.length, carsB.length) * 0.7, `${carsA.length} on A, ${carsB.length} on B, ${same} the same`);
  const sm = await smooth(B, SPOT.x, SPOT.z, 6000);
  check('B\'s town cars move smoothly (frame speed within 2.5x of their own speed)', sm.cars >= 2 && sm.share < 0.05, `${sm.cars} moving cars, ${sm.frames} car-frames, ${sm.pops} pops (${(sm.share * 100).toFixed(1)}%, ${sm.fast} too fast)`);

  // 4. The line, and the cost.
  const line = await wait(async () => /online, host: 2 players, \d+ town cars/.test(botLog) ? botLog : null, 25000, 1000);
  const last = (botLog.match(/online, host:.*$/gm) ?? []).pop() ?? botLog.slice(-300);
  check('the bot logs its line (players, town cars, tick time)', !!line && /tick [\d.]+ ms/.test(last), last);
  const u = await usage(20000);
  if (u) console.log(`NOTE  bot browser on this laptop: ${u.cpu.toFixed(0)}% of one core, working set ${u.wsMB.toFixed(0)} MB, private ${u.privMB.toFixed(0)} MB, ${u.procs} processes`);

  // 5. The bot stops: a player takes over at once.
  const t0 = Date.now();
  killBot();
  const took = await wait(async () => { const [a, b] = await Promise.all([A.net(), B.net()]); return a.host !== na.host && (a.host === a.id || a.host === b.id) && [a.traffic.mode, b.traffic.mode].sort().join() === 'guest,host' ? [a, b] : null; }, 30000, 250);
  check('the bot gone: a player is the host, the other its guest', !!took, took ? `host ${took[0].host} after ${((Date.now() - t0) / 1000).toFixed(1)} s` : JSON.stringify(await Promise.all([A.net(), B.net()]).then((l) => l.map((n) => [n.host, n.traffic.mode]))));

  if (took) {
    const guest = took[0].host === took[0].id ? B : A;
    const sp = await smooth(guest, SPOT.x, SPOT.z, 6000);
    console.log(`NOTE  the same with a player as host (${guest.tag} its guest): ${sp.cars} moving cars, ${sp.frames} car-frames, ${sp.pops} pops (${(sp.share * 100).toFixed(1)}%, ${sp.fast} too fast)`);
  }

  // 6. And back.
  startBot();
  const back = await wait(async () => { const [a, b] = await Promise.all([A.net(), B.net()]); return a.host === b.host && a.host !== a.id && a.host !== b.id && a.traffic.mode === 'guest' && b.traffic.mode === 'guest' ? [a, b] : null; }, 120000, 500);
  check('the bot back: it is the host again, both players its guests', !!back, back ? `host ${back[0].host}` : '');

  // 7. Seats: 2 here (PC_SEATS), both taken; the bot took none, and a third player is refused.
  const C = await S.visitor('C', S.viaMain);
  pages.push(C);
  const nc = await C.until((n) => n.status === 'full', 30000);
  const h3 = await health();
  check('the seats are the players\': with the bot in, a third player finds the town full', !!nc && h3.players === 2 && h3.bot === true, `C ${nc ? nc.status : (await C.net()).status}; ${JSON.stringify(h3)}`);

  // 8. Errors.
  for (const t of pages) check(`no errors on ${t.tag}`, t.errs().length === 0, t.errs().slice(0, 3).join(' | '));
} catch (e) {
  check('the test ran to the end', false, String(e && e.stack || e).slice(0, 400));
} finally {
  killBot();
  await S.end();
  await vite.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  const n = failures();
  console.log(n ? `${n} FAILED` : 'ALL PASS');
  if (n && botLog) console.log('bot log:\n' + botLog.split('\n').slice(-12).join('\n'));
  process.exit(n ? 1 : 0);
}
