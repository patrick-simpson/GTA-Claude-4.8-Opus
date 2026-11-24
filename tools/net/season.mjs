// The season and the holiday decorations for the whole town (owner, Nov 24; net/townSeason.ts, FACT_SEASON). Two
// headless browsers against a LOCAL home service (server/home/main.ts, found through a lookup stand-in), as kid.mjs.
//
//   node tools/net/season.mjs [--noshots]
//
// A is the host (B says it cannot host, as a hidden tab does). Checks:
//  1. Both start with the same town fact, and the same Auto (the host's calendar).
//  2. A (host) picks winter in the menu: B follows within seconds and is told "<name> made it winter."
//  3. B (guest) takes the holiday decorations down: B at once, A within seconds (one 5 byte Season frame).
//  4. B's menu shows the town's choice (winter, off). A picture of it.
//  5. A late joiner C has winter and no decorations from its welcome.
//  6. A puts it back to auto: everybody follows the host's calendar.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const PORT = 8871, LOOKUP = 8872;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const tmp = mkdtempSync(path.join(tmpdir(), 'pc-season-'));
const home = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(PORT), PC_STATE: path.join(tmp, 'h') } });
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${PORT}` }));
}).listen(LOOKUP, '127.0.0.1');
const viaMain = `net=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;

const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&kid=0&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.until = async (fn, ms = 45000, every = 200) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  /** The menu's own buttons: pause, Settings, click, unpause. */
  t.pick = async (key, v, shot) => {
    await t.page.evaluate(() => { const g = window.__game.game; g.setPaused(true); g.todo.menu.setTab(3); });
    await sleep(300);
    const r = await t.page.evaluate(([k, v]) => { const b = document.querySelector(`button[data-set="${k}"][data-v="${v}"]`); if (!b) return 'no button'; b.click(); return 'clicked'; }, [key, v]);
    if (shot) { await sleep(400); console.log('shot', await t.shot(shot)); }
    await t.page.evaluate(() => window.__game.game.setPaused(false));
    return r;
  };
  t.menuOn = () => t.page.evaluate(() => [...document.querySelectorAll('button.mn-seg.on')].map((b) => `${b.dataset.set}=${b.dataset.v}`).join(' '));
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const S = (n) => n ? JSON.stringify({ season: n.town.season, shown: n.town.seasonShown, holiday: n.town.holiday, hshown: n.town.holidayShown, fact: n.town.seasonFact }) : 'timed out';

try {
  if (!(await up())) throw new Error('the local service did not start (run `npm install` in server/ once)');
  const A = await visitor('A');
  let na = await A.until((x) => x.status === 'online' && x.town.led && x.town.seasonFact);
  check(!!na && na.town.host && !!na.town.seasonFact, 'A is the host and has written the town\'s season fact', S(na));
  const B = await visitor('B', SHOTS ? [960, 540] : [480, 270]);
  await B.pin(true);
  let nb = await B.until((x) => x.status === 'online' && x.count === 2 && !x.town.host && x.town.seasonFact);
  check(!!nb && JSON.stringify(nb.town.seasonFact) === JSON.stringify(na.town.seasonFact) && nb.town.season === na.town.season && nb.town.holiday === na.town.holiday, '1. B joins with the same fact, season and decorations', `A ${S(na)} | B ${S(nb)}`);

  let r = await A.pick('season', 'winter');
  const t1 = Date.now();
  nb = await B.until((x) => x.town.season === 'winter' && x.town.seasonShown === 'winter', 15000, 100);
  check(r === 'clicked' && !!nb && /made it winter\.$/.test(nb.town.lastSeason), '2. A (host) picks winter: B follows and is told by whom', `${r}; after ${((Date.now() - t1) / 1000).toFixed(1)} s; B: "${nb ? nb.town.lastSeason : ''}"`);

  r = await B.pick('holiday', 'off');
  nb = await B.net();
  const t2 = Date.now();
  na = await A.until((x) => x.town.holiday === false && x.town.holidayShown === 'off', 15000, 100);
  check(r === 'clicked' && nb.town.holiday === false && !!na && nb.town.seasonAsks === 1 && nb.town.seasonBytes === 5 && na.town.seasonGot === 1, '3. B (guest) takes the decorations down: B at once, A within seconds (one 5 byte frame)', `B holiday ${nb.town.holiday}; A after ${((Date.now() - t2) / 1000).toFixed(1)} s: "${na ? na.town.lastSeason : ''}"`);

  await B.page.evaluate(() => { const g = window.__game.game; g.setPaused(true); g.todo.menu.setTab(3); });
  await sleep(500);
  const on = await B.menuOn();
  if (SHOTS) console.log('shot', await B.shot('shots/net/season-menu.png'));
  await B.page.evaluate(() => window.__game.game.setPaused(false));
  check(/season=winter/.test(on) && /holiday=off/.test(on), '4. B\'s menu shows the town\'s choice', on);

  const C = await visitor('C');
  await C.pin(true);
  const nc = await C.until((x) => x.status === 'online' && x.count === 3 && x.town.seasonFact, 45000);
  check(!!nc && nc.town.season === 'winter' && nc.town.holiday === false, '5. a late joiner C has winter and no decorations from its welcome', S(nc));

  r = await A.pick('season', 'auto');
  await A.pick('holiday', 'auto');
  na = await A.net();
  nb = await B.until((x) => x.town.seasonShown === 'auto' && x.town.holidayShown === 'auto', 15000, 100);
  check(!!nb && nb.town.season === na.town.season && nb.town.holiday === na.town.holiday, '6. A puts both back to auto: B follows the host\'s calendar', `A ${S(na)} | B ${S(nb)}; B: "${nb ? nb.town.lastSeason : ''}"`);
  const errs = open.flatMap((t) => t.errors.filter((e) => !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|request failed/.test(e)));
  check(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | '));
} catch (e) { console.log('FAIL  ' + (e.stack || e)); failed++; } finally {
  for (const t of open) await t.close().catch(() => {});
  home.kill(); lookup.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
}
