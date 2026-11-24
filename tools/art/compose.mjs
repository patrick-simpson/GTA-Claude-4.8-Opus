// Set the lettering on the Stable Diffusion pictures, in the game's own fonts, and pack the results.
//
//   node tools/art/compose.mjs            raw pictures in scratch/art/raw -> public/textures/art/
//
// The pictures carry no text (SD cannot spell). Text is real DOM in Big Shoulders Display and Barlow
// Semi Condensed, rendered with Playwright, so it matches the HUD and the sign atlas.
// Output: boards.webp (2048x2048, eight 1024x512 billboards), posters.webp (2048x2048, eight 512x1024
// posters), card-*.webp (1024x512 loading and title cards). Layout order is the TS order in
// src/world/artBoards.ts: keep them in step.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = path.join(ROOT, 'scratch', 'art', 'raw');
const OUT = path.join(ROOT, 'public', 'textures', 'art');
// Fonts go in as data URIs: a page set from a string cannot read file:// URLs.
const F = (p) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(ROOT, 'node_modules', '@fontsource', p)).toString('base64');
const INK = '#14213d', BONE = '#f2e8cf', VERM = '#e4572e', MUST = '#f0a202', TEAL = '#2a9d8f';

export const BOARDS = [
  ['bb-speedscan', 'SPEEDSCAN', 'If it moves, we have scanned it.', 'Eventually. Ask about our Tuesday backlog.', VERM],
  ['bb-pardons', 'PARDON’S SURPLUS & SALVAGE', 'Bring nothing.', 'Leave with everything. Mind the canoe.', MUST],
  ['bb-dithers', 'DITHERS COLLEGE', 'Admissions are pending.', 'So are we. Apply by whenever.', VERM],
  ['bb-lackwool', 'LACKWOOL MILL', 'Itchy since 1887.', 'Sweaters that outlast the sheep.', TEAL],
  ['bb-radio881', '88.1, MORE OR LESS', 'Within a few megahertz of your dial.', 'Music to file by.', MUST],
  ['bb-tepid', 'TEPID FALLS', 'Come for the falls.', 'Stay for the drizzle. Kettle on site.', TEAL],
  ['bb-bridge', 'BUY A PLANK', 'The Bridge Bond Drive.', 'Own a plank. Wave at it. Form 14‑C.', VERM],
  ['bb-derby', 'DERBY NIGHT', 'Saturday, at dusk.', 'Bring a car you used to like.', MUST],
];
export const POSTERS = [
  ['po-duck', 'LOST DUCK', VERM, ['Answers to “Gerald.”', 'Does not.'], 'Last seen on Strand Blvd, judging people. Reward: our thanks and a modest casserole.', 'GERALD'],
  ['po-moose', 'MOOSE CROSSING', MUST, ['Next four miles.', 'The moose has right of way.'], 'He has the paperwork. You do not.', null],
  ['po-bond', 'BRIDGE BOND DRIVE', TEAL, ['Every plank counts.', 'Most count twice.'], 'Pledge at the Clerk’s office. Bring Form 14‑C and a pencil.', null],
  ['po-derby', 'DERBY NIGHT', VERM, ['Saturday at dusk.', 'Gates 6. Mud 7.'], 'Closed shoes only. Waivers at the gate, in triplicate.', null],
  ['po-fair', 'CHRISTMAS FAIR', TEAL, ['Cocoa, wreaths,', 'and one raffle.'], 'Town square. All welcome, by order of the Fair Committee.', null],
  ['po-cat', 'FOUND CAT', MUST, ['Has taken over Desk 4.', 'Not leaving.'], 'Claim with two forms of ID. The cat will want to see yours too.', null],
  ['po-light', 'LIGHTHOUSE TOURS', VERM, ['On the half hour,', 'keeper permitting.'], 'Mind the lean. The lean is not covered by the tour.', null],
  ['po-stamp', 'PUBLIC NOTICE', INK, ['Form 27-B must be filed', 'before any form is filed.'], 'Failure to file is itself a filing. — Office of Forms', null],
];
export const CARDS = [
  ['ca-harbor', 'Counting the gulls.', 'Twice, for accuracy.'],
  ['ca-moose', 'Waiting for the moose.', 'He is almost across.'],
  ['ca-mill', 'Carding the wool.', 'Tediously.'],
  ['ca-downtown', 'Stamping your visit.', 'In triplicate.'],
];

const css = `
@font-face{font-family:BSD;font-weight:900;src:url(${F('big-shoulders-display/files/big-shoulders-display-latin-900-normal.woff2')})}
@font-face{font-family:BSD;font-weight:700;src:url(${F('big-shoulders-display/files/big-shoulders-display-latin-700-normal.woff2')})}
@font-face{font-family:BAR;font-weight:600;src:url(${F('barlow-semi-condensed/files/barlow-semi-condensed-latin-600-normal.woff2')})}
@font-face{font-family:BAR;font-weight:500;src:url(${F('barlow-semi-condensed/files/barlow-semi-condensed-latin-500-normal.woff2')})}
*{margin:0;box-sizing:border-box}body{background:#000}
.c{position:relative;overflow:hidden;font-family:BAR;color:${INK}}
.c img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.h{font-family:BSD;font-weight:900;line-height:.9;letter-spacing:.01em;text-transform:uppercase}
.grain{position:absolute;inset:0;border:10px solid ${INK};pointer-events:none}
`;

const uri = (id) => 'data:image/png;base64,' + fs.readFileSync(path.join(RAW, id + '.png')).toString('base64');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function board([id, head, line, strap, col]) {
  const long = head.length > 14;
  return `<div class="c" style="width:1024px;height:512px"><img src="${uri(id)}">
  <div style="position:absolute;left:34px;top:34px;max-width:${long ? 760 : 620}px;background:${BONE};padding:14px 24px 10px;border:6px solid ${INK};box-shadow:10px 10px 0 ${INK}">
    <div class="h" style="font-size:${long ? 78 : 112}px;color:${INK}">${esc(head)}</div>
    <div style="font-weight:600;font-size:34px;margin-top:8px;color:${col === MUST ? '#8a4b00' : col === TEAL ? '#1b6f65' : '#b03a18'}">${esc(line)}</div></div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:84px;background:${INK};color:${BONE};display:flex;align-items:center;padding:0 38px;font-weight:600;font-size:40px;border-top:8px solid ${col}">${esc(strap)}</div>
  <div class="grain"></div></div>`;
}

function poster([id, head, col, lines, foot, tab]) {
  const fg = col === MUST ? INK : BONE;
  const big = head.length > 12 ? 82 : 100;
  const tabs = tab ? `<div style="position:absolute;left:0;right:0;bottom:0;height:150px;display:flex;border-top:3px dashed ${INK};background:${BONE}">${Array.from({ length: 5 }, () => `<div style="flex:1;border-right:3px dashed ${INK};writing-mode:vertical-rl;transform:rotate(180deg);font-family:BSD;font-weight:700;font-size:34px;display:flex;align-items:center;justify-content:center">${tab}?</div>`).join('')}</div>` : '';
  return `<div class="c" style="width:512px;height:1024px;background:${BONE}">
  <div style="position:absolute;left:0;right:0;top:0;height:250px;background:${col};color:${fg};display:flex;align-items:center;justify-content:center;text-align:center;padding:0 24px;border-bottom:8px solid ${INK}"><div class="h" style="font-size:${big}px">${esc(head)}</div></div>
  <div style="position:absolute;left:28px;right:28px;top:278px;height:${tab ? 330 : 440}px;border:6px solid ${INK};overflow:hidden"><img src="${uri(id)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>
  <div style="position:absolute;left:28px;right:28px;top:${tab ? 632 : 744}px;text-align:center">
    ${lines.map((l) => `<div class="h" style="font-weight:700;font-size:${tab || lines.some((l) => l.length > 22) ? 44 : 54}px;line-height:1.02">${esc(l)}</div>`).join('')}
    <div style="font-weight:500;font-size:${tab ? 27 : 29}px;margin-top:14px;line-height:1.12">${esc(foot)}</div></div>
  ${tabs}<div class="grain" style="border-width:8px"></div></div>`;
}

/** Title-card plates carry no lettering: the caption is set in the page (src/ui/title.ts). Just the frame. */
function card([id]) {
  return `<div class="c" style="width:1024px;height:512px"><img src="${uri(id)}"><div class="grain" style="border-width:0"></div></div>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
async function render(html, w, h) {
  await page.setContent(`<style>${css}</style>${html}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
}
fs.mkdirSync(OUT, { recursive: true });
const have = (id) => fs.existsSync(path.join(RAW, id + '.png'));

const cell = [];
let n = 0;
for (const [i, b] of BOARDS.entries()) if (have(b[0])) { cell.push({ input: await render(board(b), 1024, 512), left: (i % 2) * 1024, top: Math.floor(i / 2) * 512 }); n++; }
if (n) await sharp({ create: { width: 2048, height: 2048, channels: 3, background: INK } }).composite(cell).webp({ quality: 82 }).toFile(path.join(OUT, 'boards.webp'));
console.log('boards', n);

const pc = [];
n = 0;
for (const [i, p] of POSTERS.entries()) if (have(p[0])) { pc.push({ input: await render(poster(p), 512, 1024), left: (i % 4) * 512, top: Math.floor(i / 4) * 1024 }); n++; }
if (n) await sharp({ create: { width: 2048, height: 2048, channels: 3, background: BONE } }).composite(pc).webp({ quality: 82 }).toFile(path.join(OUT, 'posters.webp'));
console.log('posters', n);

for (const c of CARDS) if (have(c[0])) await sharp(await render(card(c), 1024, 512)).webp({ quality: 80 }).toFile(path.join(OUT, c[0].replace('ca-', 'card-') + '.webp'));
await browser.close();
