// Fun queue 2, item 25: player-run shops, the online part. Headless browsers against LOCAL services.
//
//   node tools/net/shops.mjs [--noshots]
//
// Started and stopped as tools/net/convoy.mjs is (never run two of these tests at once). A rents a storefront and stocks it;
// B walks up and buys. The shop rides on PlayerEvent.Store (26), an ordinary Event frame the service relays unread:
// nothing in server/ is touched.
//  1. A's shop shows up on B: name, stock, the door is taken (B cannot rent it), the prompt at the door is "Browse".
//  2. B buys: B pays, A's till and stock change, B's collection gets the find, A is told; B cannot buy what it has.
//  3. Refusals: a find that is gone, a price that moved, a customer too far from the door: B gets its money back.
//  4. A name from the wire that would not pass the filter shows as "A Shop"; a full shop's frame fits the 96-byte limit.
//  5. A gives up the lease: the shop disappears from B; A leaving town takes it off B too.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, ROOT } from '../pw.mjs';

const MAIN = 8895, LOOKUP = 8896, BACKUP = 8897;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-shops-'));
const kids = [];
const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
function startHome(port, dir) {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(port), PC_STATE: path.join(tmp, dir) } });
  kids.push(c);
  return c;
}
const stop = async (c) => { if (c.exitCode === null) { const gone = new Promise((r) => c.once('exit', r)); try { c.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); } };
const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${MAIN}` }));
}).listen(LOOKUP, '127.0.0.1');
const viaMain = `net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8896|request failed: ws/;
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const open = [];
async function visitor(tag, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${viaMain}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.st = () => t.page.evaluate(() => window.__game.game.todo.stores.info());
  t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.swait = async (fn, ms = 12000, every = 200) => { const end = Date.now() + ms; for (;;) { const n = await t.st(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  t.money = () => t.page.evaluate(() => window.__game.game.player.money);
  t.toast = (re, ms = 6000) => wait(async () => (await t.page.evaluate((s) => (document.body.innerText.match(new RegExp(s)) || [''])[0], re.source)) || null, ms);
  t.run = (fn, arg) => t.page.evaluate(`(async () => { const S = await import('/src/game/save.ts'); const P = await import('/src/net/protocol.ts'); const C = await import('/src/world/pardonsCatalogue.ts'); const G = window.__game.game; const SS = G.todo.stores; return (${fn.toString()})({ S, P, C, G, SS }, ${JSON.stringify(arg ?? null)}); })()`);
  t.shot = (name) => SHOTS ? t.page.screenshot({ path: path.join(ROOT, 'shots', `shops-${name}.png`) }) : null;
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const calm = (t) => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.constructor && s.constructor.name === 'Police'); g.player.heat = 0; g.player.health = 100; if (p) p.clear(); });
const footAt = (t, x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const G = window.__game, g = G.game; if (g.player.vehicle) g.player.exit(true); G.teleport(x, z, h); return true; }, [x, z, h]);
async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const A = await visitor('A', [960, 540]);
  const B = await visitor('B', [960, 540]); await B.pin(true);
  const both = await wait(async () => { const ns = await Promise.all([A.net(), B.net()]); return ns.every((r) => r.status === 'online' && r.count === 2) ? ns : null; }, 60000);
  check(!!both, 'two in town', both ? both.map((r) => r.traffic.mode).join(', ') : 'no');
  const ids = both ? both.map((r) => r.id) : [];
  for (const t of [A, B]) await calm(t);
  await A.run((X) => X.SS.list().length);
  const door = (await A.st()).sites[0];
  check(!!door, 'a storefront to test with', JSON.stringify(door));
  await footAt(A, door.x, door.z);
  await footAt(B, door.x + 3, door.z + 3);
  await sleep(1500);

  // ── 1. A rents and stocks; B sees it ──
  const mk = await A.run((X) => {
    X.G.player.money = 3000; X.S.save.data.best['pf.found'] = (1 << 0) | (1 << 1) | (1 << 12) | (1 << 21);
    const r = X.SS.rentSite(0, 'Gerald Goods');
    const e = [X.SS.stock(0, 30), X.SS.stock(1, 40), X.SS.stock(12, 90), X.SS.stock(21, 250)];
    return { r, e };
  });
  check(mk.r === '' && mk.e.every((x) => x === ''), 'A rented site 0 and stocked four finds', JSON.stringify(mk));
  const seen = await B.swait((r) => r.remote.length === 1 && r.remote[0].n === 4);
  check(!!seen && seen.remote[0].name === 'Gerald Goods' && seen.remote[0].site === 0 && seen.remote[0].owner === ids[0], 'B sees the shop: name, door and four items', JSON.stringify(seen && seen.remote));
  const rb = await B.run((X) => X.SS.rentSite(0, 'Copycat'));
  check(rb === 'Somebody has that storefront.', 'B cannot rent the door that is taken', rb);
  await sleep(700);
  const pr = (await B.st()).prompt;
  check(/Browse Gerald Goods \(4 for sale\)/.test(pr ?? ''), 'at the door B is offered to browse it', pr);
  await B.run((X) => X.SS.open(0));
  const shown = await B.page.evaluate(() => ({ h: document.querySelector('.sp-card h2')?.textContent, n: document.querySelectorAll('[data-a=buy]').length }));
  check(shown.h === 'Gerald Goods' && shown.n === 4, "B's panel lists the four items with Buy buttons", JSON.stringify(shown));
  await B.shot('browse');
  await B.page.evaluate(() => document.querySelector('[data-a=close]').click());

  // ── 2. B buys ──
  const mA = await A.money();
  await B.run((X) => { X.G.player.money = 500; });
  const buy = await B.run((X) => X.SS.buyRemote(X.SS.info().remote[0].owner, 1));
  check(buy === '', 'B buys the $40 item', buy);
  const gotB = await B.swait((r) => r.stats.boughtOnline === 1);
  const afterB = await B.run((X) => ({ money: X.G.player.money, found: (X.C.foundMask() >> 1) & 1, owns: X.SS.owns(1) }));
  check(!!gotB && afterB.money === 460 && afterB.found === 1 && afterB.owns, 'B paid $40 and has the find in its collection', JSON.stringify(afterB));
  const sA = await A.swait((r) => r.stats.soldOnline === 1);
  const shopA = await A.run((X) => ({ till: X.S.save.data.shop.till, stock: X.S.save.data.shop.stock.map((e) => e.id), sold: X.SS.info().sold & 2 }));
  check(!!sA && shopA.till === 40 && !shopA.stock.includes(1) && shopA.stock.length === 3 && shopA.sold === 2, "A's till holds the $40, the item left the shelf and is gone for good", JSON.stringify(shopA));
  check(!!(await A.toast(/bought Box of mismatched/, 4000)), 'A is told of the sale');
  check((await A.money()) === mA, "the money waits in A's till, not in A's pocket");
  const upd = await B.swait((r) => r.remote.length === 1 && r.remote[0].n === 3);
  check(!!upd, "B's view of the shop updates to three items");
  await B.run((X) => { X.S.save.data.best['pf.found'] |= (1 << 12); });
  const dup2 = await B.run((X) => X.SS.buyRemote(X.SS.info().remote[0].owner, 12));
  check(/already have/.test(dup2), 'a customer cannot buy a find it already has', dup2);
  await sleep(1000);
  await B.run((X) => { X.G.player.money = 500; });

  // ── 3. Refusals ──
  await B.run((X) => { const r = X.SS.remote.get(X.SS.info().remote[0].owner); r.stock.push({ id: 5, price: 10 }); });
  const m0 = await B.money();
  await B.run((X) => X.SS.buyRemote(X.SS.info().remote[0].owner, 5));
  check(!!(await B.toast(/beat you to it/, 6000)) && (await B.money()) === m0, 'an item that is not on the shelf: refused, the money comes back', String(await B.money()));
  await B.run((X) => { const r = X.SS.remote.get(X.SS.info().remote[0].owner); const e = r.stock.find((q) => q.id === 21); e.price = 5; });
  await B.run((X) => X.SS.buyRemote(X.SS.info().remote[0].owner, 21));
  check(!!(await B.toast(/price changed/, 6000)) && (await B.money()) === m0, 'a price the owner no longer asks: refused, money back');
  await sleep(1500);
  await footAt(B, door.x + 400, door.z + 300);
  await sleep(2500);
  await B.run((X) => { const r = X.SS.remote.get(X.SS.info().remote[0].owner); const e = r.stock.find((q) => q.id === 21); e.price = 250; });
  await B.run((X) => X.SS.buyRemote(X.SS.info().remote[0].owner, 21));
  check(!!(await B.toast(/Too far from the counter/, 6000)) && (await B.money()) === m0, 'a customer far from the door: refused, money back');
  const pend = await B.swait((r) => !r.pending, 8000);
  check(!!pend, 'nothing is left pending on B');
  const shopA2 = await A.run((X) => ({ till: X.S.save.data.shop.till, n: X.S.save.data.shop.stock.length }));
  check(shopA2.till === 40, "A's till is untouched by the refused sales", JSON.stringify(shopA2));
  await footAt(B, door.x + 3, door.z + 3);

  // ── 4. Wire hygiene ──
  await A.run((X) => { X.S.save.data.shop.name = 'Walmart'; X.SS.announce(); });
  const nm = await B.swait((r) => r.remote.length === 1 && r.remote[0].name === 'A Shop', 9000);
  check(!!nm, 'a name that would not pass the filter reaches B as "A Shop"', JSON.stringify(nm && nm.remote));
  await A.run((X) => { X.S.save.data.shop.name = 'Gerald Goods'; X.SS.announce(); });
  const size = await A.run((X) => {
    const stock = []; for (let i = 0; i < 20; i++) stock.push({ item: i, price: 9999 });
    return X.P.encodeStore({ id: 1, kind: X.P.StoreKind.Open, owner: 1, buyer: 0, site: 5, reason: 0, item: 0, price: 0, name: 'ABCDEFGHIJKLMNOPQRST', stock }).byteLength;
  });
  check(size <= 96, 'a full shop (20 items, a 20-letter name) fits one 96-byte Event frame', String(size));
  await B.shot('door');

  // ── 5. Closing ──
  await A.run((X) => { X.SS.giveUp('closed by test'); });
  const gone = await B.swait((r) => r.remote.length === 0, 8000);
  check(!!gone, 'A gives up the lease: the shop is gone from B');
  const back = await A.run((X) => ({ owns: X.SS.owns(12) && X.SS.owns(21) }));
  check(back.owns, "the unsold finds are back in A's collection", JSON.stringify(back));
  await A.run((X) => { X.SS.rentSite(0, 'Back Again'); });
  await B.swait((r) => r.remote.length === 1, 8000);
  await A.page.close(); open.splice(open.indexOf(A), 1);
  const dropped = await B.swait((r) => r.remote.length === 0, 15000);
  check(!!dropped, 'the owner leaves town: the shop goes off B');
  const errs = [B].flatMap((t) => t.errors).filter((e) => !NOISE.test(e));
  check(errs.length === 0, 'no errors from the game on the page that stayed', errs.slice(0, 3).join(' | ').slice(0, 400) || '"errors": []');
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  for (const t of open.splice(0)) await t.close().catch(() => {});
  lookup.close();
  await stop(home); await stop(backup);
  for (const c of kids) await stop(c);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
