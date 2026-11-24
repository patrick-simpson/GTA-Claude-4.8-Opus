import { chromium } from 'playwright';
import fs from 'node:fs';
const D = 'C:/Users/User/Documents/GitHub/GTA-Claude-4.8-Opus/scratch/renderdoc/';
const only = process.argv[2] ? process.argv[2].split(',') : null;
const extra = process.argv[3] || '';
const BASE = 'http://127.0.0.1:5199/index.html?net=0&q=high&save=0&xmas=0' + extra;
const S = {
  downtown: { q: '', time: 23, at: [-30, 0, 3.14] },
  hq: { q: '', time: 23, at: [27, 32, 0] },
  hqout: { q: '', time: 23, at: [27, -20, 0] },
  pardons: { q: '&bridge=8&stage=4', time: 13, at: [-628, -1135, 0] },
  mainst: { q: '&bridge=8&stage=4', time: 13, at: [80, -1300, 3.14] },
  park: { q: '', time: 13, at: [140, -110, 1.57] },
  storm: { q: '', time: 17, at: [-30, 0, 3.14], storm: true },
};
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('5199')) || ctx.pages()[0];
let curQ = null;
for (const [name, s] of Object.entries(S)) {
  if (only && !only.includes(name)) continue;
  if (curQ !== s.q) {
    await page.goto(BASE + s.q, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 120000 });
    await page.evaluate(() => window.__game.start());
    curQ = s.q;
    await page.waitForTimeout(8000);
  }
  await page.evaluate(([s]) => { const g = window.__game; g.setTime(s.time); g.teleport(s.at[0], s.at[1], s.at[2]); if (s.storm) { g.setWeather('rain'); window.__storm.tornado.start(); } }, [s]);
  await page.waitForTimeout(7000);
  const fps = await page.evaluate(() => new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 120) requestAnimationFrame(f); else { const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b); res({ avg: +(ts.length * 1000 / (ts[ts.length - 1] - ts[0])).toFixed(1), p95: +d[Math.floor(d.length * .95)].toFixed(1) }); } }; requestAnimationFrame(f); }));
  fs.writeFileSync(D + `req_${name}.txt`, name);
  for (let i = 0; i < 80 && !fs.existsSync(D + `done_${name}.txt`); i++) await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: D + name + '.png' });
  console.log(name, JSON.stringify(fps), fs.existsSync(D + `done_${name}.txt`) ? fs.readFileSync(D + `done_${name}.txt`, 'utf8') : 'NOCAP');
}
await browser.close().catch(() => {});
