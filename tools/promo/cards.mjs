// Title cards for the promo, in the game's paperwork style (palette and fonts from src/ui/base.css), drawn by
// Chromium as transparent PNGs the size of the video and laid over the picture by tools/promo/cut.mjs.
//
//   node tools/promo/cards.mjs [--w 1280 --h 720] [--out C:/Users/User/promo/cards]
//
// Each shot in storyboard.json with a "card" gets <out>/<shot id>.png. A card is { "form": "FORM PC-7",
// "line": "THE BIG LINE", "small": "a smaller line", "stamp": "APPROVED", "pos": "low|mid|high" }.
// The logo end card is NOT drawn here: the game overlays it live as HTML ("PRESS ANY KEY") over the clean last plate.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const W = +(opt.w ?? 1280), H = +(opt.h ?? 720);
const OUT = String(opt.out ?? 'C:/Users/User/promo/cards');
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const board = JSON.parse(fs.readFileSync(String(opt.storyboard ?? path.join(here, 'storyboard.json')), 'utf8'));
const k = H / 720;

const css = `
:root { --ink:#14213d; --bone:#f2e8cf; --vermilion:#e4572e; --mustard:#f0a202;
  --f-head:'Big Shoulders Display','Arial Narrow',sans-serif; --f-text:'Barlow Semi Condensed','Arial Narrow',sans-serif;
  --f-mono:'IBM Plex Mono',Consolas,ui-monospace,monospace; }
html,body { margin:0; width:${W}px; height:${H}px; background:transparent; overflow:hidden; }
.slip { position:absolute; left:50%; transform:translateX(-50%) rotate(-1.2deg); background:var(--bone); color:var(--ink);
  border:${3 * k}px solid var(--ink); padding:${14 * k}px ${34 * k}px ${18 * k}px; min-width:${420 * k}px; text-align:center;
  box-shadow:${6 * k}px ${8 * k}px 0 rgba(20,33,61,.55); }
.slip.low { bottom:${120 * k}px; } .slip.mid { top:50%; transform:translate(-50%,-50%) rotate(-1.2deg); } .slip.high { top:${110 * k}px; }
.form { font:700 ${13 * k}px var(--f-mono); letter-spacing:.12em; display:flex; justify-content:space-between; gap:${30 * k}px;
  border-bottom:${2 * k}px solid var(--ink); padding-bottom:${5 * k}px; margin-bottom:${8 * k}px; }
.line { font:800 ${64 * k}px/1 var(--f-head); letter-spacing:.02em; text-transform:uppercase; }
.small { font:600 ${20 * k}px var(--f-text); margin-top:${8 * k}px; }
.stamp { position:absolute; right:${-26 * k}px; top:${-22 * k}px; transform:rotate(12deg); color:var(--vermilion);
  border:${4 * k}px solid var(--vermilion); font:800 ${24 * k}px var(--f-head); padding:${2 * k}px ${12 * k}px; letter-spacing:.08em;
  background:rgba(242,232,207,.85); }
`;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
let n = 0;
for (const s of board.shots) {
  if (!s.card) continue;
  const c = s.card;
  await page.setContent(`<style>${css}</style><div class="slip ${c.pos ?? 'low'}">
    <div class="form"><span>${esc(c.form ?? 'HARBOR AUTHORITY')}</span><span>${esc(c.dept ?? 'PORT CALAMITY')}</span></div>
    <div class="line">${esc(c.line)}</div>${c.small ? `<div class="small">${esc(c.small)}</div>` : ''}
    ${c.stamp ? `<div class="stamp">${esc(c.stamp)}</div>` : ''}</div>`);
  await page.screenshot({ path: path.join(OUT, s.id + '.png'), omitBackground: true });
  n++;
}
await browser.close();
console.log(`${n} cards -> ${OUT}`);
