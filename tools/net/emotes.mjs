// Fun queue item 9: emotes and horn tunes between players (game/emotes.ts, PlayerEvent.Emote).
//
//   cd server && npx wrangler dev --port 8787        (in another shell, first)
//   node tools/net/emotes.mjs                 the checks and the pictures (shots/net/emote-*.png, B's view of A)
//   node tools/net/emotes.mjs --noshots
//
// 1. The wheel: holding N opens it with the on-foot emotes; a quick tap leaves it up; N again closes it.
// 2. A dances: A's own body dances, and B's copy of A dances too.
// 3. A walks off: the dance stops on both screens.
// 4. Pictures: B's view of A doing several emotes.
// 5. A, driving, honks a tune and flashes the lights: B hears the tune from A's car and sees the flash.
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
  t.em = () => t.page.evaluate(() => window.__game.game.emotes.info());
  t.play = (id) => t.page.evaluate((id) => window.__game.game.emotes.play(id), id);
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

let A = await open('A'), B = await open('B', val('q', 'high'), [960, 540]);
try {
  let na = await A.until((n) => n.status === 'online' && n.remotes.length === 1);
  let nb = await B.until((n) => n.status === 'online' && n.remotes.length === 1);
  if (!na || !nb) throw new Error('no connection: is the service running on ' + NET + '?');
  A.id = na.id; B.id = nb.id;
  for (const t of [A, B]) await t.page.evaluate(() => window.__game.start());
  await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  await B.page.evaluate(() => window.__game.teleport(-30, 293, 3.14));
  for (const t of [A, B]) await t.page.evaluate(() => window.__game.setTime(14));
  await sleep(2500);

  // ── 1. The wheel ──
  await A.page.bringToFront();
  await A.page.keyboard.down('KeyN');
  await sleep(250);
  let e = await A.em();
  check(e.open && e.items.length === 15 && e.items[0] === 'Wave', 'holding N opens the wheel with the 15 on-foot emotes', JSON.stringify(e.items));
  await A.page.keyboard.up('KeyN');
  await sleep(300);
  e = await A.em();
  check(e.open, 'a quick tap leaves the wheel up to click on');
  await A.page.keyboard.press('KeyN');
  await sleep(300);
  check(!(await A.em()).open, 'N again closes it');

  // ── 2. A dances ──
  check(await A.play(2), 'A starts the disco dance');
  await sleep(600);
  e = await A.em();
  check(e.mine === 2 && e.body === 2, "A's own body is dancing", JSON.stringify(e));
  nb = await B.until((n, id) => { const r = remoteOf(n, id); return r && r.emote === 2 && r.bodyEmote === 2; }, 8000, A.id);
  check(!!nb, "B sees A dancing (the emote id arrived and B's copy of A's body plays it)", JSON.stringify(remoteOf(await B.net(), A.id)?.emote));
  // Still dancing a while later (a loop), and told again for latecomers.
  await sleep(4600);
  na = await A.net();
  check(na.emotesSent >= 2 && (await A.em()).body === 2, 'the dance loops and is told again every few seconds', `sent ${na.emotesSent}`);

  // ── 3. A walks off ──
  await A.page.keyboard.down('KeyW');
  await sleep(500);
  await A.page.keyboard.up('KeyW');
  e = await A.em();
  check(e.mine === 0 && e.body === 0, 'walking stops the dance on A', JSON.stringify(e));
  nb = await B.until((n, id) => { const r = remoteOf(n, id); return r && r.bodyEmote === 0; }, 6000, A.id);
  check(!!nb, "and on B's copy of A");

  // ── 4. Pictures: B's view of A ──
  if (!has('noshots')) {
    await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
    await sleep(2500);
    const pos = await A.page.evaluate(() => { const i = window.__game.info(); return { x: i.x, y: i.y, z: i.z, h: i.h }; });
    const pin = (t, high) => t.page.evaluate(([p, high]) => {
      const s = Math.sin(p.h), c = Math.cos(p.h), d = high ? 3.4 : 3.8;
      window.__game.view(p.x + s * d + c * 1.3, p.y + (high ? 2.6 : 1.45), p.z + c * d - s * 1.3, p.x, p.y + (high ? 0.3 : 0.95), p.z);
    }, [pos, high]);
    const list = [[1, 'wave', 1.0], [2, 'disco', 1.5], [3, 'robot', 1.4], [4, 'bounce', 1.3], [5, 'clap', 1.2], [6, 'cheer', 1.2], [7, 'shrug', 1.0],
      [8, 'facepalm', 1.4], [9, 'point', 1.0], [10, 'salute', 1.2], [11, 'sit', 2.0], [12, 'lie', 3.4], [13, 'flex', 1.4], [14, 'airguitar', 1.5], [15, 'lamppost', 1.0]];
    for (const [id, name, wait] of list) {
      await A.play(id);
      await pin(B, id === 12 || id === 11);
      await sleep(wait * 1000 + 250);
      console.log('shot', await B.shot(`shots/net/emote-${name}.png`));
    }
    await B.page.evaluate(() => window.__game.view());
    await A.page.evaluate(() => window.__game.game.emotes.stop());
  }

  // ── 5. A honks a tune and flashes the lights ──
  await A.page.evaluate(() => window.__game.drive('sports'));
  await sleep(1500);
  await A.page.keyboard.down('KeyN');
  await sleep(250);
  e = await A.em();
  check(e.open && e.items.includes('Shave and a haircut') && e.items.includes('Flash the lights'), 'at the wheel, the wheel holds the horn tunes', JSON.stringify(e.items));
  await A.page.keyboard.up('KeyN');
  await A.page.keyboard.press('KeyN');
  const before = remoteOf(await B.net(), A.id)?.tunes ?? 0;
  check(await A.play(32), 'A honks "shave and a haircut"');
  check((await A.em()).tunes === 1, "A's own car played it");
  nb = await B.until((n, id) => (remoteOf(n, id)?.tunes ?? 0) > before, 8000, A.id);
  check(!!nb, "B hears the tune from A's car", JSON.stringify({ emote: remoteOf(await B.net(), A.id)?.emote, vehicle: remoteOf(await B.net(), A.id)?.vehicle }));
  check(!(await A.play(33)), 'a second tune over the first is refused');
  await sleep(2400);
  check(await A.play(40), 'A flashes the lights');
  nb = await B.until((n, id) => remoteOf(n, id)?.emote === 40, 6000, A.id);
  const flash = await B.page.evaluate((id) => { const r = window.__game.game.net.peers.find((p) => p.id === id); return r && r.vehicle ? r.vehicle.flash : -1; }, A.id);
  check(!!nb && flash > 0, "B sees A's lights flash", `flash ${flash}`);

  na = await A.net(); nb = await B.net();
  console.log(`emote frames: A sent ${na.emotesSent} got ${na.emotesGot}; B sent ${nb.emotesSent} got ${nb.emotesGot}`);
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
