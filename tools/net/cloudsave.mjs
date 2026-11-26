// Fun queue 2, item 41: cloud saves. Two headless browsers (a laptop and a phone) against a LOCAL service (started and
// stopped here; never the live town). Needs `npm install` once in server/.
//
//   node tools/net/cloudsave.mjs [--noshots] [--fast]
//
//  0. An old client (cloud save never switched on) sends nothing to /save and plays in town as before.
//  1. A (laptop) plays, turns Cloud save on in Settings: the service holds one save, no secret on disk, status "Last synced".
//  2. A shows a link code; wrong and reused codes fail.
//  3. B (phone, a fresh browser) types the code in Settings: it takes A's progress (page reloads), same money.
//  4. B plays and the debounced upload carries it up (the 90 s tick; --fast skips this and uses the page-hide upload);
//     A reloads and has it (taken before the game loads, no second load).
//  5. Both change: the choice card ("Use this device's progress" / "Use the cloud's progress"), both ways.
//  6. Offline: B's changes wait, then go up when the connection returns.
//  7. An oversize save is refused and the cloud copy is untouched.
//  8. The service restarts and still has it.
//  9. Unlink: B leaves, A stays, the last one out deletes the save.
// 10. A new client against an OLD service (no /save, it answers 200 with its health line): cloud quietly does not work (a code is refused, the status waits), the game is fine.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL. Pictures in shots/cloud-*.png.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const PORT = 8881, OLD = 8882;
const SHOTS = !process.argv.includes('--noshots');
const FAST = process.argv.includes('--fast');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-cloud-'));
const state = path.join(tmp, 'state');
let kid = null;
const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
function startHome() {
  kid = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(PORT), PC_STATE: state, PC_SAVE_LIMITS: '{"get":100000}' } });
}
async function stopHome() {
  if (kid && kid.exitCode === null) { const gone = new Promise((r) => kid.once('exit', r)); try { kid.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); }
}
// An "old service": answers every request, /save included, the way the Worker from before this feature did (its plain health line, 200).
const oldHits = [];
const old = createServer((req, res) => { oldHits.push(req.method + ' ' + req.url); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': req.headers.origin ?? '*' }).end('port-calamity-city v6, 8 seats\n'); }).listen(OLD, '127.0.0.1');

const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: ws|request failed: http:\/\/127\.0\.0\.1:8881\/save|ERR_INTERNET_DISCONNECTED|net::ERR/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const api = async (op, k, extra = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/save`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://localhost:5173' }, body: JSON.stringify({ op, k, ...extra }) });
  return { s: r.status, j: await r.json() };
};
const saveFiles = () => { try { return readdirSync(path.join(state, 'saves')).filter((n) => n.endsWith('.json')); } catch { return []; } };

const open = [];
async function visitor(tag, { mobile = false, port = PORT } = {}) {
  const t = await boot({ start: false, mobile, query: `q=low&net=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`, width: mobile ? 844 : 960, height: mobile ? 390 : 540 });
  open.push(t);
  t.tag = tag;
  t.saveReqs = 0;
  t.page.on('request', (r) => { if (r.url().endsWith('/save')) t.saveReqs++; });
  t.cl = () => t.page.evaluate(() => { const c = window.__game.cloud; return { on: c.on, available: c.available, state: c.state, last: c.lastSync, line: c.statusLine(), code: c.code, msg: c.msg }; });
  t.k = () => t.page.evaluate(() => JSON.parse(localStorage.getItem('pc.cloud') || '{}').k);
  t.money = () => t.page.evaluate(() => window.__game.game.player.money);
  t.setMoney = (n) => t.page.evaluate((n) => { window.__game.game.player.money = n; window.__game.game.todo.saveNow(); }, n);
  t.stored = () => t.page.evaluate(() => { const j = JSON.parse(localStorage.getItem('portcalamity.save.v1') || 'null'); return j && j.player ? j.player.money : null; });
  t.begin = async () => { await t.page.evaluate(() => window.__game.start()); await sleep(400); };
  /** The page hides (a phone sends it to the background): the game writes and the cloud sends. */
  t.hide = () => t.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; });
  t.reload = async () => {
    await t.page.reload({ waitUntil: 'load' });
    await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
    await t.begin();
  };
  t.settings = async () => {
    await t.page.keyboard.press('Escape');
    await sleep(500);
    await t.page.evaluate(() => { const b = [...document.querySelectorAll('.mn-tab')].find((x) => /Settings/i.test(x.textContent)); if (b) b.click(); });
    await t.page.waitForSelector('#mn-cloud', { timeout: 10000 });
  };
  t.press = (key) => t.page.evaluate((key) => document.querySelector(`[data-cloud="${key}"]`).click(), key);
  t.until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); } };
  t.shot = async (name, sel = '#mn-cloud') => { if (!SHOTS) return; const el = await t.page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await sleep(250); await t.page.screenshot({ path: path.join(ROOT, 'shots', `cloud-${name}.png`) }); } };
  return t;
}
const serverMoney = async (k) => { const r = await api('get', k); return r.s === 200 ? r.j.doc.save.player.money : null; };

startHome();
try {
  if (!(await up(PORT))) throw new Error('the local service did not start (run `npm install` in server/ once)');

  // ── 0. An old client: nothing sent ──
  const O = await visitor('O');
  await O.begin();
  await sleep(3000);
  const net0 = await O.page.evaluate(() => window.__game.net());
  check(O.saveReqs === 0 && !(await O.cl()).on, 'cloud save is off by default and sends nothing to /save', `${O.saveReqs} requests`);
  check(net0.status === 'online' || net0.status === 'connecting', 'the town still works beside it', net0.status);
  await O.setMoney(321);
  await O.hide();
  await sleep(1500);
  check(O.saveReqs === 0, 'even after the page hides, with it off, nothing is sent', String(O.saveReqs));
  await O.close().catch(() => {});
  open.splice(open.indexOf(O), 1);

  // ── 1. A turns it on ──
  const A = await visitor('A');
  await A.begin();
  await A.setMoney(1234);
  await A.settings();
  await A.press('toggle');
  const aOn = await A.until(async () => { const c = await A.cl(); return c.on && c.state === 'ok' ? c : null; }, 15000);
  check(!!aOn && /Last synced/.test(aOn.line), 'A turns Cloud save on in Settings: status says "Last synced"', aOn ? aOn.line : 'never synced');
  const kA = await A.k();
  check(/^[A-Za-z0-9_-]{43}$/.test(kA ?? ''), 'a 43-letter secret was made in the browser');
  check(saveFiles().length === 1, 'the service holds one save', String(saveFiles().length));
  check((await serverMoney(kA)) === 1234, 'it is A\'s progress ($1234)');
  const disk = saveFiles().map((n) => readFileSync(path.join(state, 'saves', n), 'utf8')).join('');
  check(!disk.includes(kA), 'the secret is not on the service\'s disk, only its hash');
  await A.shot('A-on');

  // ── 2. a code, wrong and reused ──
  await A.press('code');
  const code = (await A.until(async () => (await A.cl()).code, 8000))?.c;
  check(/^[A-HJ-NP-Z2-9]{8}$/.test(code ?? ''), 'A shows a link code', code);
  const shownCode = await A.page.evaluate(() => document.querySelector('#mn-cloud b.mn-val')?.textContent ?? '');
  check(shownCode === `${code.slice(0, 4)}-${code.slice(4)}`, 'and the page prints it as XXXX-XXXX', shownCode);
  await A.shot('A-code');

  // ── 3. B (phone) links ──
  const B = await visitor('B', { mobile: true });
  await B.begin();
  await B.settings();
  const bWrong = await B.page.evaluate(() => window.__game.cloud.useCode('ZZZZ-ZZZZ'));
  const bMsgWrong = (await B.cl()).msg;
  check(bWrong === false && /not right|expired/.test(bMsgWrong), 'a wrong code fails with a plain message', bMsgWrong);
  const bBad = await B.page.evaluate(() => window.__game.cloud.useCode('abc'));
  check(bBad === false, 'a malformed code is refused before it is sent');
  await B.page.evaluate(() => { window.__marker = 1; });
  await B.page.fill('#mn-cloud-code', code.slice(0, 4).toLowerCase() + '-' + code.slice(4));
  await B.shot('B-typed');
  await B.press('use');
  await B.page.waitForFunction(() => !window.__marker && window.__game && window.__game.ready, null, { timeout: 90000 });
  await B.begin();
  check((await B.money()) === 1234, 'B took A\'s progress ($1234) and reloaded into it', String(await B.money()));
  const bc = await B.cl();
  check(bc.on && bc.state === 'ok', 'B is on and in step', bc.state);
  const reused = await A.page.evaluate((c) => window.__game.cloud.useCode(c), code);
  check(reused === false, 'the same code cannot be used a second time');
  const kB = await B.k();
  check(kB && kB !== kA && (await api('get', kB)).j.devices === 2, 'the service now shares the save between two devices, with two secrets');
  await B.settings();
  await B.shot('B-on');

  // ── 4. B plays; A reloads ──
  await B.setMoney(5678);
  if (FAST) await B.hide();
  const up4 = await B.until(async () => (await serverMoney(kB)) === 5678, FAST ? 15000 : 150000);
  check(!!up4, FAST ? 'B\'s page-hide upload reached the cloud' : 'B\'s change went up by itself (debounced tick)');
  await A.reload();
  check((await A.money()) === 5678, 'A reloads and has B\'s progress ($5678)', String(await A.money()));
  const aSettings = await A.page.evaluate(() => JSON.parse(localStorage.getItem('portcalamity.save.v1')).settings.quality);
  check(aSettings === 'auto' || aSettings === 'low' || aSettings === 'medium' || aSettings === 'high', 'A kept its own settings block', aSettings);

  // ── 5. both change: the choice ──
  await sleep(6000);
  await A.setMoney(111);
  await A.hide();
  check(!!(await A.until(async () => (await serverMoney(kA)) === 111, 15000)), 'A\'s change is in the cloud ($111)');
  await B.setMoney(222);
  await B.reload();
  const ask = await B.until(() => B.page.evaluate(() => { const r = document.querySelector('.pc-cloud-ask'); return r ? r.innerText.replace(/\s+/g, ' ') : ''; }), 15000);
  check(!!ask && /Use this device's progress/i.test(ask) && /Use the cloud's progress/i.test(ask) && /\$111/.test(ask) && /\$222/.test(ask), 'both changed: the choice card shows both sides', (ask || '').slice(0, 160));
  if (SHOTS) { await B.page.screenshot({ path: path.join(ROOT, 'shots', 'cloud-choice.png') }); }
  await B.page.evaluate(() => [...document.querySelectorAll('.pc-cloud-ask .opt')].find((b) => /cloud/i.test(b.textContent)).click());
  await B.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await B.begin();
  check((await B.money()) === 111, 'choosing the cloud\'s progress: B has $111', String(await B.money()));
  await sleep(6000);
  await A.setMoney(333);
  await A.hide();
  check(!!(await A.until(async () => (await serverMoney(kA)) === 333, 15000)), 'A\'s next change is in the cloud ($333)');
  await B.setMoney(444);
  await B.reload();
  const ask2 = await B.until(() => B.page.evaluate(() => !!document.querySelector('.pc-cloud-ask')), 15000);
  check(ask2, 'both changed again: the card again');
  await B.page.evaluate(() => [...document.querySelectorAll('.pc-cloud-ask .opt')].find((b) => /this device/i.test(b.textContent)).click());
  await B.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await B.begin();
  check((await B.money()) === 444, 'choosing this device\'s progress: B keeps $444', String(await B.money()));
  check(!!(await B.until(async () => (await serverMoney(kB)) === 444, 15000)), 'and it replaced the cloud copy');
  await A.reload();
  check((await A.money()) === 444, 'A reloads and has it ($444)', String(await A.money()));

  // ── 6. offline ──
  await sleep(6000);
  await B.page.context().setOffline(true);
  await B.setMoney(555);
  await B.hide();
  await sleep(1500);
  const off = await B.cl();
  check(off.state === 'offline' && (await serverMoney(kB)) === 444, 'offline: B\'s change waits and the status says so', `${off.state}: ${off.line}`);
  await B.page.context().setOffline(false);
  check(!!(await B.until(async () => (await serverMoney(kB)) === 555, 30000)), 'back online: the queued change goes up by itself ($555)');
  const back = await B.cl();
  check(back.state === 'ok', 'and the status is back to synced', back.line);

  // ── 7. oversize ──
  await sleep(6000);
  await A.reload();
  check((await A.money()) === 555, 'A reloads and has the offline change ($555)', String(await A.money()));
  const before = (await api('get', kA)).j.rev;
  await A.page.evaluate(() => { const j = JSON.parse(localStorage.getItem('portcalamity.save.v1')); j.pad = 'x'.repeat(70000); j.when = Date.now() + 5; localStorage.setItem('portcalamity.save.v1', JSON.stringify(j)); });
  await A.page.evaluate(() => window.__game.cloud.syncNow());
  const big = await A.cl();
  const after = (await api('get', kA)).j;
  check(big.state === 'toobig' && after.rev === before && !JSON.stringify(after.doc).includes('xxxxxxxx'), 'an oversize save is refused and the cloud copy is untouched', `${big.state}, rev ${before} -> ${after.rev}`);
  await A.setMoney(666);

  // ── 8. restart ──
  await stopHome();
  startHome();
  check(await up(PORT), 'the service restarts');
  check((await serverMoney(kB)) === 555, 'and still has the save');
  await B.reload();
  check((await B.money()) === 555 && (await B.cl()).on, 'B reloads into it', String(await B.money()));

  // ── 9. unlink ──
  await B.settings();
  await B.press('unlink');
  await B.press('unlink');
  await B.until(async () => !(await B.cl()).on, 8000);
  check(!(await B.cl()).on && (await api('get', kB)).s === 404 && (await B.money()) === 555, 'B unlinks: it keeps its progress, the cloud forgets it');
  check((await api('get', kA)).s === 200 && (await api('get', kA)).j.devices === 1, 'A is still linked');
  await A.page.evaluate(() => window.__game.cloud.unlink());
  check((await api('get', kA)).s === 404 && saveFiles().length === 0, 'the last device out deletes the save');

  // ── 10. a new client against an old service ──
  const N = await visitor('N', { port: OLD });
  await N.begin();
  const avail = await N.cl();
  const oldUse = await N.page.evaluate(() => window.__game.cloud.useCode('ABCD-2345'));
  check(oldUse === false && !(await N.cl()).on, 'a link code against it is refused, not taken for success');
  await N.page.evaluate(() => window.__game.cloud.setOn(true));
  await sleep(1500);
  const nc = await N.cl();
  await N.page.evaluate(() => { const g = window.__game; g.step(60); });
  const bad = N.errors.filter((e) => !NOISE.test(e));
  check(avail.available && nc.state !== 'ok' && bad.length === 0, 'against a service with no /save the page just waits and the game is fine', `${nc.state}; ${bad.slice(0, 2).join(' | ').slice(0, 200) || 'no errors'}`);
  check(await N.page.evaluate(() => window.__game.game.state === 'play'), 'and the game is still playing');
  const NN = await visitor('NN');
  check(!(await NN.cl()).on, 'a fresh page again starts with it off');
  const errs = [A, B, O, NN].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
  check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
} catch (e) {
  check(false, 'the test ran to the end', String((e && e.stack) || e).slice(0, 700));
} finally {
  for (const t of open) await t.close().catch(() => {});
  await stopHome();
  old.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
