// Test harness: serve the source with Vite on a free port and open it in
// Chromium with Playwright. Every check in this repo boots through here.
//
//   import { boot } from './pw.mjs';
//   const t = await boot({ start: true });          // title card skipped, time frozen
//   await t.game((g) => { g.teleport(0, 300); g.step(60); });
//   await t.shot('shots/pier.png');
//   console.log(await t.info(), t.errors);
//   await t.close();
//
// Nothing here writes to dist/, so any number of these can run at once.

import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * @param {object} [o]
 * @param {string}  [o.page='index.html']  Page to open, relative to the repo root (a scratch harness page works too).
 * @param {boolean} [o.dist=false]        Serve the production build in dist/ instead of the source.
 * @param {boolean} [o.mobile=false]      Phone-sized touch context (landscape 844x390, device scale 2).
 * @param {number}  [o.width=1280] @param {number} [o.height=720]
 * @param {string}  [o.query='']          Extra query string, e.g. 'q=low'.
 * @param {boolean} [o.start=true]        Wait for the game, skip the title card and freeze real time.
 * @param {boolean} [o.wait=true]         Wait for window.__game.ready (set false for scratch pages without the game).
 * @param {number}  [o.timeout=90000]
 */
export async function boot(o = {}) {
  const { page: pagePath = 'index.html', dist = false, mobile = false, query = '', start = true, wait = true, timeout = 90000 } = o;
  const width = o.width ?? (mobile ? 844 : 1280), height = o.height ?? (mobile ? 390 : 720);
  const port = await freePort();
  let server;
  if (dist) {
    server = await preview({ root: ROOT, logLevel: 'error', preview: { port, strictPort: true, host: '127.0.0.1' } });
  } else {
    server = await createServer({
      root: ROOT, logLevel: 'error', clearScreen: false,
      // No dependency pre-bundling: three ships as a single ES module, and skipping
      // the optimizer means parallel servers never fight over a shared cache.
      optimizeDeps: { noDiscovery: true, include: [] },
      cacheDir: path.join(os.tmpdir(), 'pc-vite-' + process.pid),
      server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
    });
    await server.listen();
  }
  // A container whose Playwright and browser versions differ: PW_CHROMIUM, or the fixed path such containers use.
  const exe = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '');
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : { channel: 'chromium' }), headless: true,
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', ...(process.env.PW_VSYNC === '1' ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']), ...(process.env.PW_GPU === 'high' ? ['--force_high_performance_gpu'] : process.env.PW_GPU === 'low' ? ['--force_low_power_gpu'] : [])],
  });
  const ctx = await browser.newContext(mobile
    ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  // The Claude FM radio embeds a YouTube player; its own ad, tracking and stream hiccups are not the game's errors.
  const THIRD = /youtube\.com|youtube-nocookie|ytimg\.com|googlevideo\.com|doubleclick\.net|google\.com|gstatic\.com|googleads|ggpht.com|compute-pressure/i;
  const errors = [];
  const add = (s) => { if (!THIRD.test(s)) errors.push(s); };
  page.on('console', (m) => { if (m.type() === 'error') add(m.text() + ' ' + (m.location()?.url ?? '')); });
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('requestfailed', (r) => add('request failed: ' + r.url()));
  const file = dist && !fs.existsSync(path.join(ROOT, 'dist', pagePath)) ? '' : pagePath;
  const url = `http://127.0.0.1:${port}/${file}${query ? '?' + query : ''}`;
  await page.goto(url, { waitUntil: 'load', timeout });

  if (wait) {
    await page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout })
      .catch(() => errors.push('timed out waiting for window.__game.ready'));
    const err = await page.evaluate(() => window.__game?.error || '');
    if (err) errors.push('init failed: ' + err);
    else if (start) await page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
  }

  return {
    page, errors, url, browser,
    /** Run a function in the page with the test hooks: t.game((g, arg) => ..., arg). */
    game: (fn, arg) => page.evaluate(`(${fn.toString()})(window.__game, ${JSON.stringify(arg ?? null)})`),
    info: () => page.evaluate(() => window.__game.info()),
    /** Advance the frozen simulation. */
    step: (n = 1, dt = 1 / 60) => page.evaluate(([n, dt]) => window.__game.step(n, dt), [n, dt]),
    async shot(file) {
      const out = path.resolve(ROOT, file);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out });
      return out;
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}
