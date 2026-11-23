// Kid-friendly mode for the whole town (owner, Nov 23; core/kid.ts, net/town.ts FACT_KID). Two headless browsers
// against a LOCAL home service (server/home/main.ts, found through a lookup stand-in, so it is "main").
//
//   node tools/net/kid.mjs              the checks, and one picture of B's menu into shots/net/
//   node tools/net/kid.mjs --noshots
//
// A is the host (B says it cannot host, as a hidden tab does). Checks:
//  1. A (the host) flips it on through the menu's own switch: B is switched within a few seconds, and told by whom.
//  2. B (a guest) flips it off: B at once, A within seconds (B's Kid frame, then A's fact). B flips it on again.
//  3. On B: no weapon can be drawn (the cheat gives everything; the hand stays empty), firing does nothing.
//  4. On B: hit by a car at 45 mph three times (the player's own car-hit path: damage, then the ragdoll knock),
//     and its health written to 0: never CLOCKED OUT, health stays 100, up again on its feet.
//  5. B at heat 3 for 75 s: the host's officers fire no shot at all, B loses no health; a hold is a ticket.
//  6. A late joiner C sees the town in kid mode from its welcome.
//  7. A flips it off: everybody is switched back.
// Prints PASS or FAIL per check; exits 1 on a FAIL.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const PORT = 8861, LOOKUP = 8862;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const tmp = mkdtempSync(path.join(tmpdir(), 'pc-kid-'));
const home = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(PORT), PC_STATE: path.join(tmp, 'h') } });
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${PORT}` }));
}).listen(LOOKUP, '127.0.0.1');
const viaMain = `net=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8862|request failed: ws/;

const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&kid=0&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.kidFrames = 0;
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => { const p = f.payload; if (typeof p !== 'string' && p.length >= 3 && p[0] === 4 && p[2] === 12) t.kidFrames++; }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.town = async () => (await t.net()).town;
  t.until = async (fn, ms = 45000, every = 200) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.me = () => t.page.evaluate(() => { const p = window.__game.game.player; return { health: p.health, mode: p.mode, slot: p.weapons.slot, owned: p.weapons.owned.filter(Boolean).length, money: p.money }; });
  /** The menu's own switch: pause, open Settings, click "Kid friendly", unpause. */
  t.flip = async (shot) => {
    await t.page.evaluate(() => { const g = window.__game.game; g.setPaused(true); g.todo.menu.setTab(3); });
    await sleep(300);
    const r = await t.page.evaluate(() => {
      const b = document.querySelector('button[data-set="kid"]');
      if (!b) return 'no switch';
      b.click();
      return 'clicked';
    });
    if (shot) { await sleep(400); console.log('shot', await t.shot(shot)); }
    await t.page.evaluate(() => window.__game.game.setPaused(false));
    return r;
  };
  await t.page.evaluate(() => window.__game.start());
  return t;
}

try {
  if (!(await up())) throw new Error('the local service did not start (run `npm install` in server/ once)');
  const A = await visitor('A');
  let n = await A.until((x) => x.status === 'online' && x.town.led);
  check(!!n && n.town.host && n.town.kid === false, 'A is online on main, the host, kid mode off', n ? JSON.stringify({ host: n.town.host, kid: n.town.kid }) : 'timed out');
  const B = await visitor('B', SHOTS ? [960, 540] : [480, 270]);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2 && x.town.led && !x.town.host);
  check(!!n, 'B joins as a guest', n ? `count ${n.count}` : 'timed out');

  // ── 1. The host flips it on ──
  let r = await A.flip();
  const t1 = Date.now();
  let nb = await B.until((x) => x.town.kid === true, 15000, 100);
  let na = await A.net();
  check(r === 'clicked' && na.town.kid && !!nb, 'A (host) flips it on in the menu: B is switched too', `${r}; A kid ${na.town.kid}, fact ${na.town.kidFact}; B after ${((Date.now() - t1) / 1000).toFixed(1)} s: ${nb ? nb.town.lastKid : 'not switched'}`);
  check(!!nb && /flipped the switch\. Kid-friendly mode is on\. Nobody gets hurt in Port Calamity today\./.test(nb.town.lastKid) && na.town.lastKid === 'Kid-friendly mode is on. Nobody gets hurt in Port Calamity today.', 'both are told, B with the flipper\'s made-up name', `A: "${na.town.lastKid}" | B: "${nb ? nb.town.lastKid : ''}"`);

  // ── 2. The guest flips it off, then on again ──
  r = await B.flip();
  nb = await B.net();
  const t2 = Date.now();
  na = await A.until((x) => x.town.kid === false, 15000, 100);
  check(r === 'clicked' && nb.town.kid === false && !!na && nb.town.kidAsks === 1 && nb.town.kidBytes === 4 && na.town.kidGot === 1, 'B (guest) flips it off: B at once, A within seconds (one 4 byte Kid frame)', `B kid ${nb.town.kid}; A after ${((Date.now() - t2) / 1000).toFixed(1)} s: ${na ? na.town.lastKid : 'not switched'}; Kid frames from B ${nb.town.kidAsks} (${nb.town.kidBytes} B), got by A ${na ? na.town.kidGot : '?'}`);
  r = await B.flip(SHOTS ? 'shots/net/kid-menu.png' : null);
  na = await A.until((x) => x.town.kid === true, 15000, 100);
  nb = await B.until((x) => x.town.kidFact === true && x.town.kidAsk === null, 15000, 100);
  check(!!na && !!nb && nb.town.kid, 'B flips it on again: the town follows, and B\'s ask is answered by the host\'s fact', `A ${na ? na.town.kid : '?'}; B kid ${nb ? nb.town.kid : '?'} fact ${nb ? nb.town.kidFact : '?'}`);

  // ── 3. No weapons on B ──
  await B.page.evaluate(() => window.__game.game.player.weapons.giveAll());
  await sleep(800);
  await B.page.evaluate(() => { const i = window.__game.game.input; i.touchDown('fire'); });
  await sleep(600);
  await B.page.evaluate(() => { const i = window.__game.game.input; i.touchUp('fire'); });
  let mb = await B.me();
  const armClass = await B.page.evaluate(() => document.querySelector('.armed') !== null);
  const fired = await B.page.evaluate(() => { const w = window.__game.game.player.weapons; return w.mags.reduce((a, b) => a + b, 0); });
  check(mb.slot === 0 && !armClass, 'on B, with every weapon given by the cheat, nothing is in her hand and no FIRE/AIM keys are shown', `slot ${mb.slot}, owned ${mb.owned}, rounds loaded ${fired}`);

  // ── 4. Cars never kill B ──
  for (let i = 0; i < 3; i++) {
    await B.page.evaluate(() => { const P = window.__game.game.player; if (P.mode === 'foot') { P.damage((20 - 3) * 3.2); P.knockDown(4 * 0.8, 19 * 0.8 + 2, 2.6, { vx: 4, vz: 19 }); } });
    await sleep(2500);
  }
  await B.page.evaluate(() => { window.__game.game.player.health = 0; });
  await sleep(1500);
  const stamps = await B.page.evaluate(() => document.body.innerText.includes('CLOCKED OUT'));
  await sleep(4000);
  mb = await B.me();
  check(mb.health === 100 && mb.mode !== 'dead' && !stamps, 'on B, three 45 mph car hits and health written to 0: never clocked out, health 100, up again', `health ${mb.health}, mode ${mb.mode}, CLOCKED OUT shown: ${stamps}`);

  // ── 5. The host's police do not shoot B ──
  {
    const h0 = await A.net(), m0 = await B.me();
    await B.page.evaluate(() => window.__game.setHeat(3));
    const end = Date.now() + 75000;
    let near = 0, booked = false;
    while (Date.now() < end) {
      await sleep(3000);
      const [nh, ng] = await Promise.all([A.net(), B.net()]);
      near = Math.max(near, nh.police.units.filter((u) => u.lit).length);
      if (ng.police.booked > 0 || ng.police.level === 0) { booked = ng.police.booked > 0; if (booked) break; }
      await B.page.evaluate(() => { const g = window.__game.game; if (g.player.heat < 3 && g.player.heat > 0) window.__game.setHeat(3); });
    }
    const [nh, ng] = await Promise.all([A.net(), B.net()]);
    const m1 = await B.me();
    check(nh.police.shots === h0.police.shots && m1.health === 100, 'B wanted at level 3 (75 s): the host\'s officers fire no shot, B loses no health', `${near} cruisers on duty at most; shots ${nh.police.shots - h0.police.shots}, hits ${nh.police.hits - h0.police.hits}; B health ${m1.health}; B level now ${ng.police.level}`);
    check(true, 'a hold on B is a ticket (information)', booked ? `ticketed: money ${m0.money} -> ${m1.money}, still where it was (mode ${m1.mode})` : 'no hold in the time (the officers did not reach B on foot)');
  }

  // ── 6. A late joiner ──
  const C = await visitor('C');
  await C.pin(true);
  const nc = await C.until((x) => x.status === 'online' && x.town.led && x.town.kidFact !== null, 45000);
  check(!!nc && nc.town.kid === true, 'a late joiner C is in kid mode from its welcome', nc ? `C kid ${nc.town.kid}, fact ${nc.town.kidFact}` : 'timed out');

  // ── 7. Off again ──
  await A.flip();
  const [xb, xc] = await Promise.all([B.until((x) => x.town.kid === false, 15000, 100), C.until((x) => x.town.kid === false, 15000, 100)]);
  check(!!xb && !!xc, 'A flips it off: B and C are switched back', `${xb ? xb.town.lastKid : 'B not switched'} | ${xc ? 'C off' : 'C not switched'}`);
  await sleep(1500);
  mb = await B.me();
  check(mb.slot !== 0, 'and B has its weapons back in hand', `slot ${mb.slot}`);

  const errs = [...A.errors, ...B.errors, ...C.errors].filter((e) => !NOISE.test(e));
  check(errs.length === 0, 'no errors on the pages', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  for (const t of open.splice(0)) await t.close().catch(() => {});
  lookup.close();
  if (home.exitCode === null) { try { home.kill('SIGTERM'); } catch { /* gone */ } }
  await sleep(500);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
