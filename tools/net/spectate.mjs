// Fun queue item 16: spectating (fx/spectate.ts). Three browsers on a local service.
//
//   cd server && npx wrangler dev --port 8787        (in another shell, first)
//   node tools/net/spectate.mjs                      C on a desktop (keys)
//   node tools/net/spectate.mjs --phone              C on a phone (the banner's buttons, the menu list)
//   node tools/net/spectate.mjs --noshots
//
// 1. C presses U (or, on a phone, picks A from SPECTATE in the pause menu): C's camera goes behind A, who is driving
//    the C-Max; the banner names A and says so; A sees C as paused; C's own player has not moved.
// 2. C switches (right arrow, or the banner's next button): the camera goes behind B.
// 3. C switches back to A; A leaves town: C goes on to B by itself.
// 4. Esc (or Back) returns C's camera to C's own player, and C is not paused any more.
// 5. A race C is not in (a Go frame heard): "Watch the race? [U]"; U watches the racer, "1st in the race".
// Prints PASS or FAIL per check; exits 1 on a FAIL. Pictures: shots/net/spectate-*.png (C's screen).

import { boot } from '../pw.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const NET = val('net', 'ws://127.0.0.1:8787');
const PHONE = has('phone');
const SHOTS = !has('noshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('shots/net', { recursive: true });

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

async function open(tag, o = {}) {
  const t = await boot({ start: false, query: `net=${encodeURIComponent(NET)}&q=${o.q ?? 'low'}`, width: o.w ?? 480, height: o.h ?? 270, mobile: !!o.mobile });
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.sp = () => t.page.evaluate(() => {
    const g = window.__game.game, c = g.camera.position, p = g.player;
    return { ...g.spectate.info(), cam: { x: c.x, y: c.y, z: c.z }, me: { x: p.x, z: p.z }, state: g.state };
  });
  t.remote = (id) => t.page.evaluate((id) => { const r = window.__game.game.net.remotes.get(id); return r ? { x: r.x, z: r.z, paused: r.paused, seen: r.seen } : null; }, id);
  t.until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) { const n = await fn(); if (n) return n; if (Date.now() > end) return null; await sleep(200); }
  };
  return t;
}
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const A = await open('A'), B = await open('B');
const C = await open('C', PHONE ? { mobile: true, q: 'low', w: 844, h: 390 } : { q: val('q', 'high'), w: 960, h: 540 });
let aOpen = true;
try {
  const online = (t) => t.until(async () => { const n = await t.net(); return n.status === 'online' && n.remotes.length >= 2 ? n : null; });
  const [na, nb, nc] = [await online(A), await online(B), await online(C)];
  if (!na || !nb || !nc) throw new Error('no connection: is the service running on ' + NET + '?');
  A.id = na.id; B.id = nb.id; C.id = nc.id;
  for (const t of [A, B, C]) await t.page.evaluate(() => window.__game.start());
  for (const t of [A, B, C]) await t.page.evaluate(() => window.__game.setTime(14));
  await A.page.evaluate(() => { window.__game.teleport(-30, 285, 1.57); window.__game.drive('cmax'); });
  await B.page.evaluate(() => window.__game.teleport(60, 300, 0));
  await C.page.evaluate(() => window.__game.teleport(-30, 315, 3.14));
  await A.page.keyboard.down('KeyW');
  await sleep(1500);
  await A.page.keyboard.up('KeyW');
  const seen = await C.until(async () => { const a = await C.remote(A.id), b = await C.remote(B.id); return a?.seen && b?.seen; });
  check(!!seen, 'C sees A and B in town');
  await sleep(1500);

  // ── 1. Watch A ──
  const before = await C.sp();
  if (PHONE) {
    await C.page.evaluate(() => window.__game.game.setPaused(true));
    await sleep(300);
    const btn = await C.page.$('#menu .mn-spec');
    check(!!btn && await btn.isVisible(), 'the pause menu has a SPECTATE button');
    await btn.click();
    await sleep(300);
    const rows = await C.page.$$eval('#pc-spectate-pick .sp-row', (r) => r.map((x) => x.textContent));
    check(rows.length === 2, 'the list names the two others', rows.join(' | '));
    if (SHOTS) await C.shot('shots/net/spectate-phone-list.png');
    await C.page.click(`#pc-spectate-pick .sp-row[data-id="${A.id}"]`);
  } else {
    await C.page.keyboard.press('KeyU');
  }
  await sleep(1200);
  let s = await C.sp(), ra = await C.remote(A.id);
  check(s.on && s.id === A.id, 'C is watching A', `on ${s.on} id ${s.id} (A ${A.id})`);
  check(d2(s.cam, ra) < 14 && d2(s.cam, s.me) > 8, "C's camera is behind A, not at C", `to A ${d2(s.cam, ra).toFixed(1)} m, to C ${d2(s.cam, s.me).toFixed(1)} m`);
  check(/Watching .+ · driving the 2015 Ford C-Max/.test(s.banner), 'the banner says who and what', s.banner);
  check(d2(s.me, before.me) < 0.3, "C's own player stands still", `${d2(s.me, before.me).toFixed(2)} m`);
  const cOnA = await A.until(async () => (await A.remote(C.id))?.paused ? true : null, 5000);
  check(!!cOnA, 'A sees C as paused (cannot be hurt, cannot host)');
  if (SHOTS) await C.shot(`shots/net/spectate-${PHONE ? 'phone-' : ''}a.png`);

  // ── 2. Switch to B ──
  if (PHONE) await C.page.click('#pc-spectate .sp-next'); else await C.page.keyboard.press('ArrowRight');
  await sleep(1200);
  s = await C.sp();
  const rb = await C.remote(B.id);
  check(s.id === B.id && d2(s.cam, rb) < 10, 'switching goes to B', `id ${s.id} (B ${B.id}), cam to B ${d2(s.cam, rb).toFixed(1)} m`);
  if (SHOTS && !PHONE) await C.shot('shots/net/spectate-b.png');

  // ── 3. Back to A, and A leaves ──
  if (PHONE) await C.page.click('#pc-spectate .sp-prev'); else await C.page.keyboard.press('ArrowLeft');
  await sleep(500);
  s = await C.sp();
  check(s.id === A.id, 'switching back goes to A', `id ${s.id}`);
  await A.close(); aOpen = false;
  const after = await C.until(async () => { const x = await C.sp(); return x.id === B.id ? x : null; }, 20000);
  check(!!after && after.on && after.lostTarget >= 1, 'A left town: C goes on to B', after ? `id ${after.id} lost ${after.lostTarget}` : JSON.stringify(await C.sp()));

  // ── 4. Return ──
  if (PHONE) await C.page.click('#pc-spectate .sp-back'); else await C.page.keyboard.press('Escape');
  await sleep(800);
  s = await C.sp();
  check(!s.on && s.state === 'play' && d2(s.cam, s.me) < 12, "Esc returns C's camera to C", `on ${s.on} state ${s.state} cam to C ${d2(s.cam, s.me).toFixed(1)} m`);
  const cOnB = await B.until(async () => (await B.remote(C.id))?.paused === false ? true : null, 5000);
  check(!!cOnB, 'B sees C unpaused again');

  // ── 5. A race C is not in ──
  await C.page.evaluate((id) => window.__game.game.todo.racing.got(id, { kind: 3, caller: id, route: 0, laps: 1, secs: 0, ms: 3000, lap: 0, count: 0, how: 0, ids: [id] }), B.id);
  const pr = await C.until(async () => { const x = await C.sp(); return x.prompt ? x : null; }, 4000);
  check(!!pr && pr.prompt === 'Watch the race? [U]', 'a race C is not in: the prompt', pr ? pr.prompt : 'none');
  if (SHOTS) await C.shot(`shots/net/spectate-${PHONE ? 'phone-' : ''}prompt.png`);
  if (PHONE) {
    const at = await C.page.evaluate(() => { const b = document.querySelector('#pc-spectate-prompt .sp-go').getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2; return { x, y, hit: document.elementFromPoint(x, y)?.className ?? '', w: innerWidth, h: innerHeight, cls: document.querySelector('#pc-spectate-prompt').className, touch: document.querySelector('#touch')?.className }; });

    check(at.hit === 'sp-go', 'the Watch button is on top where it is tapped', `${at.hit} at ${at.x.toFixed(0)},${at.y.toFixed(0)}`);
    await C.page.touchscreen.tap(at.x, at.y);
  } else await C.page.keyboard.press('KeyU');
  await sleep(800);
  s = await C.sp();
  check(s.on && s.id === B.id && /1st in the race/.test(s.banner), 'U watches the racer', s.banner || JSON.stringify(s));
  if (PHONE) await C.page.click('#pc-spectate .sp-back'); else await C.page.keyboard.press('Escape');
  await sleep(300);

  const errs = [...B.errors, ...C.errors].filter((e) => !/WebSocket|net::ERR|Failed to load resource/.test(String(e)));
  check(errs.length === 0, 'no page errors on B and C', errs.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  ' + (e && e.stack || e));
  failed++;
} finally {
  if (aOpen) await A.close();
  await B.close(); await C.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
