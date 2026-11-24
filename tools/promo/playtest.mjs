// Checks the in-game trailer player (src/ui/promo.ts) in the real game with a stand-in file.
//
//   node tools/promo/playtest.mjs [--file /scratch/promo/promo_720.webm | 1] [--shots C:/Users/User/promo/test]
//   (--file 1 lets the player pick public/promo/ itself. From Git Bash, a path starting with / needs MSYS_NO_PATHCONV=1.)
//
// The file must be served by the dev server: put it under scratch/ (ignored by git). Playwright's Chromium has
// no H.264, so test the WebM; Chrome plays both. Checks: the title card's key starts the game AND the trailer,
// it plays (time advances, game clock held), a key skips it and gives the game back, the "seen" mark stops it
// next time, the logo card comes up at the hit, the menu has "Watch the trailer", and a missing file never blocks.

import { boot } from '../pw.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const FILE = arg('file', '/scratch/promo/promo_720.webm');
const SHOTS = arg('shots', 'C:/Users/User/promo/test');
const ok = [];
const check = (name, cond, info = '') => { ok.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' (' + info + ')' : ''}`); };

// 1. It plays on the first key, real time running (not the frozen harness clock).
let t = await boot({ start: false, query: `net=0&promo=${encodeURIComponent(FILE)}` });
await t.page.waitForFunction(() => document.querySelector('#title.ready, .ready'), null, { timeout: 60000 }).catch(() => {});
await t.page.waitForTimeout(2500);
await t.page.keyboard.press('KeyX');
// A first start may wait up to 5 s for the file (the game's own downloads share the line), then plays.
await t.page.waitForFunction(() => { const v = document.querySelector('.pr-root video'); return v && v.currentTime > 1.5; }, null, { timeout: 15000 }).catch(() => {});
let s = await t.page.evaluate(() => { const v = document.querySelector('.pr-root video'); return { stats: window.__game.promo.stats, ct: v?.currentTime ?? -1, frozen: window.__game.game.frozen, state: window.__game.game.state, err: v?.error?.code ?? 0 }; });
check('plays after the title card key', s.stats.played === 1 && s.ct > 1.5, `t=${s.ct.toFixed(2)} passed='${s.stats.passed}' err=${s.err}`);
check('game started and held while it plays', s.state === 'play' && s.frozen === true);
await t.page.screenshot({ path: path.join(SHOTS, 'promo_playing.png') });
await t.page.keyboard.press('Space');
await t.page.waitForTimeout(600);
s = await t.page.evaluate(() => ({ stats: window.__game.promo.stats, frozen: window.__game.game.frozen, shown: getComputedStyle(document.querySelector('.pr-root')).display, seen: localStorage.getItem('pc-promo-seen') }));
check('a key skips it and gives the game back', s.stats.skipped === 1 && !s.frozen && s.shown === 'none', JSON.stringify(s));
check('marked as seen', !!s.seen, s.seen);

// 2. The menu button replays it; seeking to the hit brings up the logo card.
await t.page.keyboard.press('Escape');
await t.page.waitForTimeout(800);
const btn = await t.page.$('.pr-menu');
check('menu has "Watch the trailer"', !!btn);
if (btn) {
  await btn.click();
  await t.page.waitForTimeout(1200);
  await t.page.evaluate(() => { const v = document.querySelector('.pr-root video'); v.currentTime = 56; });
  await t.page.waitForTimeout(1500);
  const end = await t.page.evaluate(() => document.querySelector('.pr-end')?.classList.contains('on'));
  check('logo card over the end plate', end);
  await t.page.screenshot({ path: path.join(SHOTS, 'promo_endcard.png') });
}
await t.close();

// 3. A file that is not there never blocks the start.
t = await boot({ start: false, query: 'net=0&promo=/scratch/promo/missing.webm' });
await t.page.waitForTimeout(4000);
await t.page.keyboard.press('KeyX');
await t.page.waitForTimeout(1500);
s = await t.page.evaluate(() => ({ stats: window.__game.promo.stats, state: window.__game.game.state, open: !!document.querySelector('.pr-root.on') }));
check('missing file: game starts, no trailer', s.state === 'play' && !s.open, `passed='${s.stats.passed}'`);
await t.close();
console.log(ok.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
