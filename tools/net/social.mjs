// Multiplayer stage 1, the small visible pieces: radar and map dots, the new-name button, horns heard, wave and shouts.
//
//   cd server && npx wrangler dev --port 8787        (in another shell, first)
//   node tools/net/social.mjs [--noshots] [--net ws://127.0.0.1:8787]
//
// Two headless browsers. Everything is asserted through window.__game (sound cannot be heard here, so the horn is a
// counter on the remote). Pictures go to shots/net/ (six at most). Prints PASS or FAIL per check; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const NET = val('net', 'ws://127.0.0.1:8787');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = !has('noshots');
// The same list as SAYS in src/net/names.ts (index 0 is the wave).
const SAYS = ['Hello. This is a wave.', 'Nobody saw that.', 'Please hold. I am driving.', 'That is not my dinghy.', 'Filed under: fine.'];

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

async function open(tag, { mobile = false, quality = 'low', size = [480, 270], net = NET } = {}) {
  const t = await boot({ start: false, mobile, query: `net=${encodeURIComponent(net)}&q=${quality}`, ...(mobile ? {} : { width: size[0], height: size[1] }) });
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
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

const solo = await boot({ start: false, query: 'net=0&q=low', width: 480, height: 270 });
const A = await open('A'), B = await open('B', SHOTS ? { quality: 'high', size: [1280, 720] } : {});
let M = null;
try {
  // ── Not configured: nothing to see ──
  const off = await solo.page.evaluate(() => { window.__game.start(); return window.__game.net().status; });
  check(off === 'off', 'with ?net=0 (no service) the net is off', off);
  await solo.page.keyboard.press('Escape'); await solo.page.keyboard.press('Digit4'); await sleep(500);
  const soloBtn = await solo.page.evaluate(() => document.querySelectorAll('[data-set="newname"]').length);
  check(soloBtn === 0, 'no new-name button in the pause menu when multiplayer is not configured', String(soloBtn));
  await solo.close();

  let na = await A.until((n) => n.status === 'online' && n.remotes.length === 1);
  let nb = await B.until((n) => n.status === 'online' && n.remotes.length === 1);
  if (!na || !nb) throw new Error('no connection: is the service running on ' + NET + '?');
  A.id = na.id; B.id = nb.id;
  for (const t of [A, B]) await t.page.evaluate(() => window.__game.start());
  await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  await B.page.evaluate(() => window.__game.teleport(-45, 288, 1.57));
  nb = await B.until((n, id) => n.remotes.find((r) => r.id === id)?.seen, 15000, A.id);
  check(!!nb, 'B sees A drawn');

  // ── 1. Radar ──
  const aPos = await A.page.evaluate(() => { const i = window.__game.info(); return { x: i.x, z: i.z }; });
  nb = await B.until((n, p) => n.radarDots.length >= 2 && Math.hypot(n.radarDots[0] - p.x, n.radarDots[1] - p.z) < 1.5, 8000, aPos);
  check(!!nb, "B's radar data includes A, where A is", nb ? `dots ${JSON.stringify(nb.radarDots)} A ${aPos.x.toFixed(1)},${aPos.z.toFixed(1)}` : JSON.stringify((await B.net()).radarDots));
  const aAlone = await A.net();
  check(aAlone.radarDots.length === 2, "A's radar data includes B", JSON.stringify(aAlone.radarDots));

  if (SHOTS) {
    // A well down the street (about 75 m): the dot has to stand clear of the arrow, then the same on the full map.
    await A.page.evaluate(() => window.__game.teleport(30, 285, 1.57));
    await B.until((n) => n.radarDots.length >= 2 && n.radarDots[0] > 25, 8000);
    await sleep(1500);
    console.log('shot', await B.shot('shots/net/radar-dot.png'));
    await B.page.keyboard.press('KeyM'); await sleep(1500);
    await B.page.evaluate(() => { document.querySelector('.mn-map canvas')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 640, clientY: 360 })); });
    await sleep(1500);
    console.log('shot', await B.shot('shots/net/map-dot.png'));
    await B.page.keyboard.press('Escape'); await sleep(800);
    await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
    await B.until((n) => n.radarDots.length >= 2 && n.radarDots[0] < -25, 8000);
  }

  // ── 2. New name ──
  await B.page.keyboard.press('Escape'); await sleep(600);
  await B.page.keyboard.press('Digit4'); await sleep(600);
  const btn = await B.page.evaluate(() => { const b = document.querySelector('[data-set="newname"]'); return b ? b.textContent : null; });
  const myName = (await B.net()).name;
  check(!!btn && btn.includes(myName), 'the pause menu shows a new-name button with the current name', `${btn}`);
  if (SHOTS) console.log('shot', await B.shot('shots/net/menu-name-desktop.png'));
  const before = remoteOf(await A.net(), B.id)?.name;
  await B.page.evaluate(() => document.querySelector('[data-set="newname"]').click());
  const bName = (await B.net()).name;
  const btn2 = await B.page.evaluate(() => document.querySelector('[data-set="newname"] b').textContent);
  check(bName !== myName && btn2 === bName, 'pressing it changes the name and the button text', `${myName} to ${bName}`);
  na = await A.until((n, a) => remoteOf(n, a.id)?.name === a.nm, 6000, { id: B.id, nm: bName });
  check(!!na && before !== bName, 'A sees the new name', na ? remoteOf(na, B.id).name : remoteOf(await A.net(), B.id).name);
  await B.page.keyboard.press('Escape'); await sleep(600);
  check((await B.net()).name === bName, 'the menu closes and play resumes');

  // ── 3. Horn ──
  await A.page.evaluate(() => window.__game.drive('sedan'));
  nb = await B.until((n, id) => remoteOf(n, id)?.vehicle === 'sedan', 8000, A.id);
  const h0 = remoteOf(await B.net(), A.id).horns;
  await A.page.keyboard.down('KeyH'); await sleep(700);
  const during = remoteOf(await B.net(), A.id);
  await A.page.keyboard.up('KeyH'); await sleep(700);
  const h1 = remoteOf(await B.net(), A.id);
  check(h1.horns === h0 + 1, "A's horn is registered on B, once per press", `horns ${h0} to ${h1.horns}; flag on while held ${during.hornOn}, after ${h1.hornOn}`);
  await A.page.evaluate(() => window.__game.game.player.exit());
  await sleep(1500);

  // ── 4. Wave and shouts ──
  const sent0 = (await A.net()).saysSent;
  await A.page.keyboard.press('KeyB');
  nb = await B.until((n, id) => remoteOf(n, id)?.lastSaid === SAYS[0], 4000, A.id);
  check(!!nb, 'the say key sends the wave: B shows the first line', nb ? remoteOf(nb, A.id).lastSaid : JSON.stringify(remoteOf(await B.net(), A.id)));
  check((await A.net()).saysSent - sent0 === 1, 'the wave is one event frame');
  await sleep(2200);
  const pair = await A.page.evaluate(() => [window.__game.game.net.say(1), window.__game.game.net.say(2)]);
  check(pair[0] === true && pair[1] === false, 'a second line right after the first is not sent (two second limit)', JSON.stringify(pair));
  await sleep(2200);
  const ok = await A.page.evaluate(() => window.__game.game.net.say(2));
  nb = await B.until((n, id) => remoteOf(n, id)?.lastSaid === SAYS[2], 4000, A.id);
  check(ok === true && !!nb, 'shout index 2 shows the right fixed line on B', nb ? remoteOf(nb, A.id).lastSaid : '');
  const said = SAYS[2];
  const lastHeard = Date.now();
  const cl = await B.until((n, id) => remoteOf(n, id)?.said === '', 15000, A.id);
  const secs = ((Date.now() - lastHeard) / 1000).toFixed(1);
  check(!!cl && !remoteOf(cl, A.id).sayShown, 'the line clears by itself after its few seconds', `"${said}" gone ${secs} s after it was last read`);
  // Out of range, straight into B's frame handler (as if a newer or a hostile client had sent it).
  const cnt = remoteOf(await B.net(), A.id).saidCount;
  await B.page.evaluate((id) => {
    const net = window.__game.game.net;
    for (const [code, arg] of [[3, 4], [3, 200], [3, 255], [2, 9], [9, 0], [1, 0]]) net.frame(new Uint8Array([3, id, code, arg]).buffer);
  }, A.id);
  check(remoteOf(await B.net(), A.id).saidCount === cnt + 1, 'an out-of-range shout index (and an unknown event) is ignored; a wave with a stray argument is still a wave', `${cnt} to ${remoteOf(await B.net(), A.id).saidCount}`);
  const badSend = await A.page.evaluate(() => [window.__game.game.net.say(-1), window.__game.game.net.say(5), window.__game.game.net.say(1.5)]);
  check(badSend.every((v) => v === false), 'the sender will not send an out-of-range index', JSON.stringify(badSend));

  // ── Alone in town: nothing is sent ──
  await B.close();
  na = await A.until((n) => n.remotes.length === 0, 10000);
  await sleep(2300);
  const s0 = (await A.net()).sent.msgs;
  await A.page.keyboard.press('KeyB'); await sleep(300);
  const alone = await A.page.evaluate(() => window.__game.game.net.say(1));
  check(alone === false && (await A.net()).sent.msgs === s0, 'alone in town the say key sends nothing', `${(await A.net()).sent.msgs - s0} messages`);
  check((await A.net()).radarDots.length === 0, 'alone, the radar shows no other players');

  // ── Phone layout ──
  if (SHOTS) {
    M = await open('M', { mobile: true });
    nb = await M.until((n) => n.status === 'online' && n.remotes.length === 1, 20000);
    check(!!nb, 'a phone joins');
    await M.page.evaluate(() => { window.__game.start(); window.__game.setTime(14); });
    await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
    await M.page.evaluate(() => window.__game.teleport(-45, 288, 1.57));
    await M.until((n, id) => n.remotes[0]?.seen, 15000);
    await sleep(2500);
    const say = await M.page.evaluate(() => { const e = document.querySelector('.t-say'); return e ? getComputedStyle(e).display : null; });
    check(say && say !== 'none', 'the phone shows the say button when others are in town', String(say));
    await A.page.evaluate(() => window.__game.game.net.say(1));
    await M.until((n) => n.remotes[0]?.lastSaid === SAYS[1], 8000);
    await M.page.evaluate(() => { for (const r of window.__game.game.net.remotes.values()) r.saidAt = performance.now() + 60000; });
    console.log('shot', await M.shot('shots/net/phone-play-say.png'));
    await M.page.evaluate(() => { for (const r of window.__game.game.net.remotes.values()) r.saidAt = performance.now() - 3000; });
    await M.page.tap('.t-pause'); await sleep(800);
    await M.page.evaluate(() => document.querySelector('[data-tab="3"]').click()); await sleep(700);
    const mb = await M.page.evaluate(() => { const b = document.querySelector('[data-set="newname"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, onScreen: r.top >= 0 && r.bottom <= innerHeight }; });
    check(!!mb && mb.h >= 40, 'the phone menu has the new-name button, finger sized', JSON.stringify(mb));
    await M.page.evaluate(() => document.querySelector('[data-set="newname"]').scrollIntoView({ block: 'center' }));
    console.log('shot', await M.shot('shots/net/menu-name-phone.png'));
  }
  for (const t of [A, B, M].filter(Boolean)) if (t.errors.length) check(false, `no console errors on ${t.tag}`, t.errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('ERROR', e.stack.split('\n').slice(0, 3).join(' / '));
  failed++;
} finally {
  for (const t of [A, B, M, solo]) { try { await t?.close(); } catch { /* already closed */ } }
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
