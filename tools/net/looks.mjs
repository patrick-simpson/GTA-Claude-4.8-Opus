// Fun queue item 10: a player looks the same on every screen (game/looks.ts, PlayerEvent.Look).
//
//   cd server && npx wrangler dev --port 8787        (in another shell, first)
//   node tools/net/looks.mjs                 the checks and the pictures (shots/net/looks-*.png)
//   node tools/net/looks.mjs --noshots
//
// 1. Before anybody picks: A's random first look is what B draws for A, and B's is what A draws for B.
// 2. A picks a look (as the Wardrobe does): B draws exactly that; A's own screen draws the same.
// 3. A, driving, paints the car metallic blue with gold rims and the air horn: B's copy of the car has that paint,
//    finish, rims and horn.
// 4. A reloads the page: the look was saved in the browser and comes back the same, and B draws it again.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const NET = val('net', 'ws://127.0.0.1:8787');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

async function open(tag, quality = 'low', size = [480, 270]) {
  const t = await boot({ start: false, query: `net=${encodeURIComponent(NET)}&q=${quality}`, width: size[0], height: size[1] });
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.look = (c) => t.page.evaluate((c) => window.__game.look(c), c);
  t.until = async (fn, ms = 20000, arg) => {
    const end = Date.now() + ms;
    for (;;) {
      const n = await t.net();
      if (fn(n, arg)) return n;
      if (Date.now() > end) return null;
      await sleep(150);
    }
  };
  return t;
}
const remoteOf = (n, id) => n.remotes.find((r) => r.id === id);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

let A = await open('A'), B = await open('B', 'low', [1280, 720]);
try {
  let na = await A.until((n) => n.status === 'online' && n.remotes.length === 1);
  let nb = await B.until((n) => n.status === 'online' && n.remotes.length === 1);
  if (!na || !nb) throw new Error('no connection: is the service running on ' + NET + '?');
  A.id = na.id; B.id = nb.id;
  for (const t of [A, B]) await t.page.evaluate(() => window.__game.start());
  await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  await B.page.evaluate(() => window.__game.teleport(-36, 288, 1.57));

  // ── 1. The first looks ──
  const a0 = await A.look(), b0 = await B.look();
  nb = await B.until((n, id) => same(remoteOf(n, id)?.look, a0.bytes) && remoteOf(n, id)?.drawn, 15000, A.id);
  na = await A.until((n, id) => same(remoteOf(n, id)?.look, b0.bytes) && remoteOf(n, id)?.drawn, 15000, B.id);
  check(!!nb, "B has A's first look", nb ? '' : JSON.stringify(remoteOf(await B.net(), A.id)?.look));
  check(!!na, "A has B's first look");
  check(!!nb && remoteOf(nb, A.id).drawn === a0.drawn, "B draws A exactly as A's own screen does", nb ? '' : a0.drawn);
  check(!!na && remoteOf(na, B.id).drawn === b0.drawn, "A draws B exactly as B's own screen does");
  check(a0.drawn !== b0.drawn, 'the two first looks differ (random per player)');

  // ── 2. A picks a look ──
  const pick = { body: 1, skin: 6, face: 3, cut: 6, hair: 7, beard: 2, top: 2, topColor: 13, jacket: 6, bottom: 1, bottomColor: 6, shoes: 1, shoeColor: 19, hat: 0, glasses: 3, bag: 0, height: 200, build: 210 };
  const a1 = await A.look(pick);
  nb = await B.until((n, id) => same(remoteOf(n, id)?.look, a1.bytes), 10000, A.id);
  check(!!nb, "B gets A's picked look within 10 s");
  check(!!nb && remoteOf(nb, A.id).drawn === a1.drawn, "B draws A's picked look exactly as A's screen does", a1.drawn.slice(0, 120));
  check(JSON.parse(a1.drawn).cut === 'afro' && JSON.parse(a1.drawn).topKind === 'jacket', "A's own body took the pick (afro, jacket)");

  // ── 3. A's car ──
  const BLUE = 0x2c5aa0;
  await A.page.evaluate(() => window.__game.drive('sports'));
  const a2 = await A.look({ finish: 2, paint: BLUE, rims: 2, horn: 5 });
  check(!!a2.car && a2.car.color === BLUE && a2.car.finish === 2 && a2.car.rims === 2, "A's own car took the paint, finish and rims", JSON.stringify(a2.car));
  nb = await B.until((n, id) => { const r = remoteOf(n, id); return r && r.vehicle === 'sports' && r.color === BLUE && r.carFinish === 2 && r.carRims === 2; }, 15000, A.id);
  const rb = remoteOf(nb ?? await B.net(), A.id);
  check(!!nb, "B sees A's car metallic blue with gold rims", JSON.stringify({ v: rb?.vehicle, c: rb?.color, f: rb?.carFinish, r: rb?.carRims }));
  check(rb?.carHorn === 'tow', "B's copy of A's car has A's horn (the air horn)", String(rb?.carHorn));

  // ── Pictures: B's view of A and A's own view, the same moment ──
  if (!has('noshots')) {
    await A.page.evaluate(() => window.__game.game.player.exit());
    await sleep(1500);
    await B.page.evaluate(() => window.__game.setTime(14));
    await A.page.evaluate(() => window.__game.setTime(14));
    const pos = await A.page.evaluate(() => { const i = window.__game.info(); return { x: i.x, y: i.y, z: i.z, h: i.h }; });
    const pin = (t) => t.page.evaluate((p) => { const s = Math.sin(p.h), c = Math.cos(p.h); window.__game.view(p.x + s * 3.6 + c * 1.2, p.y + 1.55, p.z + c * 3.6 - s * 1.2, p.x, p.y + 1.0, p.z); }, pos);
    await sleep(9000);
    await pin(A); await pin(B);
    await sleep(3000);
    console.log('shot', await A.shot('shots/net/looks-a-own.png'));
    console.log('shot', await B.shot('shots/net/looks-b-sees-a.png'));
  }

  // ── 4. Saved: A comes back with the same look ──
  const before = (await A.look()).bytes;
  await A.page.reload();
  await A.page.waitForFunction(() => window.__game?.game?.net, null, { timeout: 90000 });
  await A.page.waitForFunction(() => window.__game.net().status === 'online', null, { timeout: 60000 });
  const after = await A.look();
  check(same(before, after.bytes), 'the look is saved in the browser and comes back after a reload');
  na = await A.net();
  nb = await B.until((n, id) => same(remoteOf(n, id)?.look, after.bytes), 15000, na.id);
  check(!!nb, 'B draws the returning A with the saved look', `A is now ${na.id}`);
  const lk = (await A.net()).looks, lb = (await B.net()).looks;
  console.log(`look frames: A sent ${lk.sent} got ${lk.got}; B sent ${lb.sent} got ${lb.got}`);
  check(lb.sent <= 6, 'B sent its look only a few times (on arriving and when somebody arrived)', String(lb.sent));
  console.log('errors', JSON.stringify({ A: A.errors, B: B.errors }));
  check(!A.errors.length && !B.errors.length, 'no page errors');
} catch (e) {
  console.log('FAIL ', e.message);
  failed++;
} finally {
  for (const t of [A, B]) if (t) await t.close().catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
