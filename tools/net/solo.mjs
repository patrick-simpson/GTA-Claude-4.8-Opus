// Multiplayer must cost a lone visitor nothing: with no service configured nothing connects, and with a service that
// cannot be reached the game is the single player game, with no errors.
//
//   node tools/net/solo.mjs
//
// Boots three times: no `?net` at high, no `?net` at low, and `?net` pointing at a port nobody listens on.
// (The browser prints one console line of its own for each failed attempt; the game cannot stop that, so it spaces
// the attempts out: 5 s, 15 s, 45 s, then minutes.)
// Prints the connection status, the attempts made, every WebSocket the page opened and the console errors.

import { boot } from '../pw.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

for (const [label, query] of [['no ?net, high', 'q=high'], ['no ?net, low', 'q=low'], ['dead port, low', 'q=low&net=' + encodeURIComponent('ws://127.0.0.1:8799')]]) {
  const t = await boot({ start: false, query, width: 640, height: 360 });
  const sockets = [];
  t.page.on('websocket', (ws) => sockets.push(ws.url()));
  try {
    await t.page.evaluate(() => window.__game.start());
    await t.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
    const x0 = (await t.info()).x;
    await t.page.keyboard.down('KeyW'); await sleep(4000); await t.page.keyboard.up('KeyW');
    const i = await t.info(), n = await t.page.evaluate(() => window.__game.net());
    const dead = query.includes('net=');
    check(i.state === 'play' && i.x - x0 > 0.1, `${label}: boots and plays`, `walked ${(i.x - x0).toFixed(1)} m, quality ${i.quality}`);
    if (dead) check(n.status === 'waiting' && n.count === 0 && n.countText === '', `${label}: single player, quietly retrying`, `status ${n.status}, ${n.attempts} attempt(s)`);
    else check(n.status === 'off' && n.attempts === 0 && sockets.length === 0, `${label}: nothing tries to connect`, `status ${n.status}, ${sockets.length} sockets`);
    // A page cannot stop the browser printing its own line for a socket that failed to open; anything else is ours.
    const own = t.errors.filter((e) => /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:8799\/.*failed/.test(e));
    const rest = t.errors.filter((e) => !own.includes(e));
    check(rest.length === 0, `${label}: no errors from the game`, rest.slice(0, 2).join(' | ').slice(0, 300) || (own.length ? `the browser's own "WebSocket connection failed" line, ${own.length} time(s)` : '"errors": []'));
  } finally { await t.close(); }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
