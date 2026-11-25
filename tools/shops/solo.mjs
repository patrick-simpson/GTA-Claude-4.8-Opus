// Player-run shops (fun queue 2, item 25), single player (net=0): src/game/stores.ts, src/ui/storePanel.ts.
//
//   node tools/shops/solo.mjs [--shots]
//
//  1. Six storefronts: real doors in Tepid Falls, apart, with a rent and a sign mesh.
//  2. Names: rude words, brands, odd characters and lengths are refused; ordinary names pass.
//  3. Rent: the prompt at the door; not enough money, a bad name; then rented, rent taken, saved.
//  4. Stock: only filed finds (each once), 20 at most, prices; a find on a shelf is not stockable twice.
//  5. NPC sales over time: fair prices sell, a silly price never sells, sold finds are gone for good and the till and
//     the take agree, nothing sells outside opening hours, a sale never pays above 1.6x the worth.
//  6. Rent day and eviction: rent from the till, then the pocket; missed days owe; two missed and the lease ends.
//  7. The save: the document survives sanitize and localStorage; the panel works from the DOM.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-25/shots/';

const t = await boot({ query: 'net=0&stage=4', width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(30); });
await t.page.evaluate(`(async () => {
  const S = await import('/src/game/save.ts');
  const ST = await import('/src/game/stores.ts');
  const C = await import('/src/world/pardonsCatalogue.ts');
  const G = window.__game.game;
  window.__sh = { S, ST, C, G, SS: G.todo.stores, toasts: [] };
  const tt = G.hud.toast.bind(G.hud); G.hud.toast = (m, s) => { window.__sh.toasts.push(String(m)); return tt(m, s); };
})()`);
const run = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__sh, ${JSON.stringify(arg ?? null)})`);

// ── 1. Sites ──
const sites = await run((X) => { X.G.todo.stores.list(); return X.SS.info(); });
check(sites.on === true && sites.sites.length === 6, 'six storefronts', String(sites.sites.length));
check(sites.sites.every((s) => s.z < -900 && s.rent >= 50 && s.rent <= 130), 'all in Tepid Falls, rent $50 to $130', JSON.stringify(sites.sites.map((s) => s.rent)));
const gap = await run((X) => { const L = X.SS.list(); let m = 1e9; for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length; b++) m = Math.min(m, Math.hypot(L[a].x - L[b].x, L[a].z - L[b].z)); return m; });
check(gap > 30, 'no two storefronts closer than 30 m', gap.toFixed(1));
console.log('NOTE  sites ' + JSON.stringify(sites.sites));
check(await run((X) => !!X.G.scene.getObjectByName('store-signs')), 'the sign mesh is in the scene');
// A vacant door has a street and a sign; each is a real door of a footprint building.
check(await run((X) => X.SS.list().every((s) => s.street.length > 0 && s.door.sw >= 1.6)), 'each has a street and a sign board');

// ── 2. Names ──
const names = await run((X) => {
  const bad = ['Walmart', 'W a l m a r t', 'Starb0cks Coffee', 'Fuck Yeah Goods', 'sh1t shack', 'Big Ass Hats', 'ab', '', '   ', '<b>Hi</b>', 'Twenty One Characters!!', '!!!!', 'Apple Store', 'McDonalds', 'Tesla Parts'];
  const ok = ['Odds & Ends', 'Loose Change Goods', "Dave's Finds", 'Glass Half Full', 'Passable Hats', 'Class Act', 'Peacock Supply'];
  return { bad: bad.filter((n) => X.ST.nameProblem(n) === ''), ok: ok.filter((n) => X.ST.nameProblem(n) !== ''), clean: X.ST.cleanName('Fuck Off'), clean2: X.ST.cleanName('Good Name') };
});
check(names.bad.length === 0, 'rude words, brands, odd names and bad lengths are refused', JSON.stringify(names.bad));
check(names.ok.length === 0, 'ordinary names pass (Class Act, Peacock Supply too)', JSON.stringify(names.ok));
check(names.clean === 'A Shop' && names.clean2 === 'Good Name', 'a bad name from the wire becomes "A Shop"');

// ── 3. Rent ──
await t.game((g) => { g.teleport(0, 0, 0); g.step(5); });
const s0 = (await run((X) => { const s = X.SS.list()[0]; return { x: s.x, z: s.z, rent: s.rent, nx: s.nx, nz: s.nz }; }));
await t.game((g, s) => { g.teleport(s.x, s.z, 0); g.step(10); }, s0);
const near = await run((X) => X.SS.info());
check(near.nearSite === 0 && /Rent this storefront/.test(near.prompt ?? ''), 'at the door the prompt offers to rent it', near.prompt);
const pre = await run((X) => { X.G.player.money = 5; return X.SS.rentSite(0, 'Test Goods'); });
check(/rent is/.test(pre), 'too little money: refused', pre);
const bad = await run((X) => { X.G.player.money = 5000; return X.SS.rentSite(0, 'Walmart'); });
check(/brand/.test(bad), 'a brand name: refused', bad);
const ok = await run((X) => { const r = X.SS.rentSite(0, 'Passable Goods'); return { r, money: X.G.player.money, shop: X.S.save.data.shop }; });
check(ok.r === '' && ok.shop && ok.shop.name === 'Passable Goods', 'rented and named', JSON.stringify(ok));
check(ok.money === 5000 - s0.rent, 'first day up front', String(ok.money));
const again = await run((X) => X.SS.rentSite(1, 'Second Place'));
check(again === 'You already run a shop.', 'only one shop');
await t.game((g, s) => { g.teleport(s.x, s.z, 0); g.step(10); }, s0);
check(/Open your shop: Passable Goods/.test((await run((X) => X.SS.info())).prompt ?? ''), 'at your own door: open your shop');

// ── 4. Stock ──
const st = await run((X) => {
  X.S.save.data.best['pf.found'] = 0;
  const none = X.SS.stock(0);
  X.S.save.data.best['pf.found'] = (1 << 0) | (1 << 1) | (1 << 12) | (1 << 21) | (1 << 26);
  const inv1 = X.SS.inventory().length;
  const a = X.SS.stock(0), b = X.SS.stock(0), c = X.SS.stock(12, 70), d = X.SS.stock(21, 3000), e = X.SS.stock(26);
  X.SS.setPrice(1, 9);
  return { none, inv1, a, b, c, d, e, stock: X.S.save.data.shop.stock, inv2: X.SS.inventory().length };
});
check(st.none === 'You do not have that one.' && st.inv1 === 5, 'only filed finds are stockable', JSON.stringify([st.none, st.inv1]));
check(st.a === '' && st.b === 'You do not have that one.' && st.c === '' && st.d === '' && st.e === '' && st.stock.length === 4 && st.inv2 === 1, 'a find sits on one shelf once', JSON.stringify(st.stock));
const cap = await run((X) => {
  X.S.save.data.best['pf.found'] = (1 << 30) - 1; X.S.save.data.shop.stock = [];
  let n = 0, last = '';
  for (let i = 0; i < 30; i++) { last = X.SS.stock(i); if (last === '') n++; }
  X.S.save.data.shop.stock = []; X.S.save.data.best['pf.found'] = 0;
  return { n, last };
});
check(cap.n === 20 && /hold 20/.test(cap.last), 'the shelves hold 20', JSON.stringify(cap));

// ── 5. NPC sales ──
// A fresh shelf: three commons at their worth, one rare priced at three times its worth.
await run((X) => {
  X.S.save.data.best['pf.found'] = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 21) | (1 << 3);
  X.S.save.data.best['sh.sold'] = 0;
  const sh = X.S.save.data.shop; sh.stock = []; sh.till = 0; sh.owed = 0; sh.acc = 0; sh.sales = 0; sh.earned = 0;
  X.SS.stock(0); X.SS.stock(1); X.SS.stock(2); X.SS.stock(3); X.SS.stock(21, 660);
});
let guard = 0;
while (guard++ < 400) {
  await t.game((g) => { g.setTime(13); g.step(120, 0.5); });
  if ((await run((X) => X.S.save.data.shop.sales)) >= 4) break;
}
const sold = await run((X) => { const sh = X.S.save.data.shop; return { sales: sh.sales, earned: sh.earned, till: sh.till, stock: sh.stock.slice(), mask: X.SS.info().sold, info: X.SS.info().stats, found: X.C.foundMask() }; });
check(sold.sales === 4, 'the four fair-priced finds sold to shoppers', JSON.stringify([sold.sales, sold.info.shoppers]));
check(sold.till === sold.earned && sold.earned > 0 && sold.earned <= 4 * 25 * 1.6, 'the till holds the take, and it is at most 1.6x the worth', JSON.stringify([sold.till, sold.earned]));
check(sold.stock.length === 1 && sold.stock[0].id === 21, 'the rare at three times its worth is still on the shelf', JSON.stringify(sold.stock));
check((sold.mask & 15) === 15 && (sold.found & 15) === 15, 'sold finds are marked gone for good but stay in the ledger');
const gone = await run((X) => ({ own: [0, 1, 2, 3].map((i) => X.SS.owns(i)), re: X.SS.stock(0) }));
check(gone.own.every((v) => v === false) && gone.re === 'You do not have that one.', 'a sold find cannot be stocked again (nothing to farm)', JSON.stringify(gone));
// A silly price never sells: ten more game hours.
for (let k = 0; k < 6; k++) await t.game((g) => { g.setTime(13); g.step(120, 0.5); });
check((await run((X) => X.S.save.data.shop.stock.length)) === 1, 'at three times the worth nothing sells in an hour of shoppers', '');
// Closed at night: no shoppers.
const night = await run((X) => { const a = X.SS.info().stats.shoppers; return a; });
await t.game((g) => { g.setTime(2); g.step(1, 0.01); });
await t.game((g) => { g.step(120, 0.25); });
const night2 = await run((X) => X.SS.info().stats.shoppers);
check(night2 === night, 'no shoppers while the shop is closed (2:00)', `${night}->${night2}`);
// Busy hours beat quiet hours and an event beats none.
const ff = await run((X) => { const g = X.G; g.sky.hour = 8.5; X.SS.update(0); const a = X.SS.footfallNow(); g.sky.hour = 14; const b = X.SS.footfallNow(); g.todo.events.forced.add('fair'); const c = X.SS.footfallNow(); g.todo.events.forced.delete('fair'); return { a, b, c }; });
check(ff.a > 0 && ff.b > ff.a && ff.c > ff.b, 'more footfall at lunch than first thing, more again at a town event', JSON.stringify(ff));
// Fair prices sell faster: expected chance by price.
const ch = await run((X) => [0.5, 1, 1.25, 1.6, 3].map((r) => +X.ST.buyChance(r * 100, 100).toFixed(2)));
check(ch[0] > ch[1] && ch[1] > ch[2] && ch[2] > ch[3] && ch[3] === 0 && ch[4] === 0, 'the cheaper the price the likelier the sale; none at 1.6x or more', JSON.stringify(ch));
// A margin check: the whole stock of 30 finds is worth about $4,500 once, and that is all the trade there is.
const total = await run((X) => { let v = 0; for (let i = 0; i < 30; i++) v += X.ST.valueOf(i); return v; });
check(total > 3000 && total < 7000, 'all thirty finds together are worth a bounded few thousand dollars, once', String(total));

// ── 6. Rent day and eviction ──
const rd = await run((X) => {
  const sh = X.S.save.data.shop, rent = X.SS.rentOf();
  sh.till = rent + 30; sh.acc = 23.999; X.G.player.money = 400;
  return { rent, till: sh.till };
});
await t.game((g) => { g.setTime(13); g.step(30, 0.5); });
const r1 = await run((X) => { const sh = X.S.save.data.shop; return { till: sh.till, money: X.G.player.money, owed: sh.owed, acc: sh.acc, rentPaid: X.SS.info().stats.rentPaid, t: X.toasts.slice(-3) }; });
check(r1.till >= 0 && r1.till <= 40 && r1.money === 400 && r1.owed === 0 && r1.rentPaid >= rd.rent, 'the day turns over: rent comes out of the till first', JSON.stringify(r1));
await run((X) => { const sh = X.S.save.data.shop; sh.till = 0; sh.acc = 23.999; X.G.player.money = 10 + X.SS.rentOf(); });
await t.game((g) => { g.setTime(13); g.step(30, 0.5); });
const r2 = await run((X) => ({ money: X.G.player.money, owed: X.S.save.data.shop.owed }));
check(r2.money < 12 && r2.owed === 0, 'with an empty till the pocket pays', JSON.stringify(r2));
await run((X) => { const sh = X.S.save.data.shop; sh.till = 0; sh.acc = 23.999; X.G.player.money = 0; });
await t.game((g) => { g.setTime(13); g.step(30, 0.5); });
const r3 = await run((X) => ({ owed: X.S.save.data.shop?.owed, rent: X.SS.rentOf(), t: X.toasts.slice(-1)[0] }));
check(r3.owed === r3.rent && r3.owed > 0, 'a day missed is owed, the shop stays open', JSON.stringify(r3));
await run((X) => { const sh = X.S.save.data.shop; sh.acc = 23.999; });
await t.game((g) => { g.setTime(13); g.step(30, 0.5); });
const r4 = await run((X) => ({ shop: X.S.save.data.shop, own21: X.SS.owns(21), evicted: X.SS.info().stats.evicted, last: X.toasts.slice(-1)[0] }));
check(r4.shop === null && r4.evicted === 1 && r4.own21 === true, 'two missed days: the lock is changed, the unsold find is back in the collection', JSON.stringify(r4));
const pay = await run((X) => {
  X.G.player.money = 5000; const r = X.SS.rentSite(1, 'Comeback Kid'); const sh = X.S.save.data.shop; sh.owed = 10; sh.till = 0;
  const n0 = X.G.player.money; X.SS.payOwed(); return { r, paid: n0 - X.G.player.money, owed: sh.owed };
});
check(pay.r === '' && pay.paid === 10 && pay.owed === 0, 'a new lease on another door; owed rent can be paid by hand', JSON.stringify(pay));

// ── 7. The save and the panel ──
const sv = await run((X) => {
  const sh = X.S.save.data.shop; sh.name = 'Saved Shop'; X.S.save.data.best['pf.found'] = (1 << 5) | (1 << 6); X.SS.stock(5, 33); X.SS.stock(6, 44); sh.till = 77;
  X.S.save.write();
  const raw = JSON.parse(localStorage.getItem('portcalamity.save.v1') || 'null');
  const back = X.S.sanitize(raw);
  const evil = X.S.sanitize({ v: 1, shop: { site: 3, name: 'x\u0000éy<>', stock: [{ id: 5, price: -4 }, { id: 99, price: 5 }, { id: 5, price: 6 }], till: 'a', owed: 9, acc: 99 } });
  return { enabled: X.S.save.enabled, raw: raw && raw.shop, back: back.shop, evil: evil.shop };
});
check(sv.enabled && sv.raw && sv.raw.name === 'Saved Shop' && sv.raw.till === 77, 'written to the save', JSON.stringify(sv.raw));
check(sv.back && JSON.stringify(sv.back) === JSON.stringify(sv.raw), 'it reads back the same');
check(sv.evil && sv.evil.name === 'xy<>' && sv.evil.stock.length === 1 && sv.evil.stock[0].price === 1 && sv.evil.till === 0 && sv.evil.acc === 24, 'a damaged save is made safe field by field', JSON.stringify(sv.evil));
// Panel by the DOM.
await run((X) => { X.SS.giveUp('x'); });
await t.game((g, s) => { g.teleport(s.x, s.z, 0); g.step(10); }, s0);
await run((X) => { X.G.player.money = 2000; X.S.save.data.best['pf.found'] = (1 << 0) | (1 << 12) | (1 << 21) | (1 << 26); X.S.save.data.best['sh.sold'] = 0; X.SS.open(0); });
check(await run(() => !!document.querySelector('.sp-back.on h2') && /to let/i.test(document.querySelector('.sp-card h2').textContent)), 'the panel opens on a vacant storefront');
if (SHOTS) await t.shot(SH + 'panel-rent.png');
await run(() => { const i = document.querySelector('.sp-name'); i.value = 'Fuck Shop'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-a=rent]').click(); });
check(await run(() => /door in this town/.test(document.querySelector('.sp-msg').textContent)), 'a rude name shows its reason in the panel');
await run(() => { const i = document.querySelector('.sp-name'); i.value = 'Gerald and Co'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-a=rent]').click(); });
check(await run((X) => X.S.save.data.shop && X.S.save.data.shop.name === 'Gerald and Co' && /Gerald and Co/.test(document.querySelector('.sp-card h2').textContent)), 'rented through the panel');
await run(() => { document.querySelectorAll('[data-a=stock]')[0].click(); });
await run(() => { document.querySelectorAll('[data-a=stock]')[0].click(); });
await run(() => { document.querySelectorAll('[data-a=stock]')[0].click(); });
await run(() => { const p = document.querySelector('[data-price]'); p.value = '30'; p.dispatchEvent(new Event('change', { bubbles: true })); });
check(await run((X) => { const s = X.S.save.data.shop.stock; return s.length === 3 && s.some((e) => e.price === 30); }), 'stocked three from the collection and set a price');
if (SHOTS) await t.shot(SH + 'panel-shop.png');
const frozen = await run((X) => ({ en: X.G.input.enabled, open: X.SS.panelOpen }));
check(frozen.open === true, 'the panel has the input while it is up');
await run(() => { document.querySelector('[data-a=close]').click(); });
check(await run((X) => !X.SS.panelOpen && !document.querySelector('.sp-back.on')), 'Close puts it away');
if (SHOTS) {
  // The sign, from the street.
  await run((X) => { X.S.save.data.shop.name = 'Gerald and Co'; X.SS.rev++; X.SS.dirty = true; });
  const look = (g, s) => { g.teleport(s.x + s.nx * 12, s.z + s.nz * 12, 0); g.step(5); g.view(s.x + s.nx * 8, s.y + 0.6, s.z + s.nz * 8, s.sx, s.y, s.sz); g.step(40); };
  const L = await run((X) => X.SS.list().map((s) => ({ x: s.x, z: s.z, nx: s.nx, nz: s.nz, sx: s.door.sx, sz: s.door.sz, y: s.door.sy + s.door.sh / 2 })));
  await t.game(look, L[0]);
  await t.shot(SH + 'sign-mine.png');
  await t.game(look, L[1]);
  await t.shot(SH + 'sign-tolet.png');
  await t.game((g) => g.view());
}

check(t.errors.length === 0, 'no page errors', JSON.stringify(t.errors.slice(0, 3)));
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
await t.close();
process.exit(failed ? 1 : 0);
