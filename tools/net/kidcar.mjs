// Kid-friendly mode: cars pass straight through people (owner, Nov 23). node tools/net/kidcar.mjs
//  1. Alone, ?kid=1: a sedan drives through a row of people at ~40 mph: nobody goes down, the car keeps its speed.
//  2. Alone, ?kid=0: same drive, people are knocked down.
//  3. Two browsers on a local service, ?kid=1: a guest drives through the host's people: nobody down on either screen,
//     no knock sent by the guest, none applied by the host.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const PORT = 8871, LOOKUP = 8872;
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const LANE = { x: -340, z: 291.8 };
const open = [];
const mk = async (query) => { const t = await boot({ start: false, query: `q=low&${query}`, width: 480, height: 270 }); open.push(t); return t; };
const peds = (t) => t.page.evaluate(() => window.__game.game.systems.find((s) => s.peds && s.traffic).peds.walkers.map((w) => ({ wid: w.p.id, pose: w.p.pose, mode: w.mode, x: Math.round(w.p.x) })));
const standRow = (t, n) => t.page.evaluate(([x, z, n]) => { const P = window.__game.game.systems.find((s) => s.peds && s.traffic).peds; const ids = []; for (let i = 0; i < n; i++) { P.stand(x + 18 + i * 6, z + (i % 2 ? 0.6 : -0.6), -Math.PI / 2, 120); const w = P.walkers.find((w) => Math.abs(w.p.x - (x + 18 + i * 6)) < 0.01); if (w) ids.push(w.p.id); } return ids; }, [LANE.x, LANE.z, n]);

/** Drive a sedan through the row; report the lowest speed once it is among them, and who went down. */
async function pass(t, ids, viewers = [t]) {
  await t.page.evaluate(([x, z]) => { window.__game.teleport(x - 14, z, Math.PI / 2); window.__game.drive('sedan'); }, [LANE.x, LANE.z]);
  await t.page.keyboard.down('KeyW');
  let top = 0, min = 99, down = new Set(), end = Date.now() + 40000;
  while (Date.now() < end) {
    const i = await t.page.evaluate(() => window.__game.info());
    top = Math.max(top, i.speed);
    if (i.x > LANE.x + 18 && i.x < LANE.x + 18 + 6 * ids.length) min = Math.min(min, i.speed);
    for (const v of viewers) for (const w of await peds(v)) if (ids.includes(w.wid) && w.pose === 'down') down.add(`${v.tag ?? 'x'}:${w.wid}@${w.x}m${w.mode}`);
    if (i.x > LANE.x + 18 + 6 * ids.length + 6) break;
    await sleep(100);
  }
  await t.page.keyboard.up('KeyW');
  await t.page.evaluate(() => { const p = window.__game.game.player; if (p.vehicle) p.exit(); });
  return { top, min, down: [...down] };
}

try {
  for (const kid of [1, 0]) {
    const t = await mk(`kid=${kid}&net=0`); t.tag = 'S';
    await t.page.evaluate(() => window.__game.start());
    await t.page.evaluate(([x, z]) => window.__game.teleport(x, z, 0), [LANE.x, LANE.z]);
    await sleep(5000);
    let ids = [];
    for (let k = 0; k < 20 && ids.length < 4; k++) { ids = (await standRow(t, 6)).filter(Boolean); if (ids.length < 4) await sleep(1500); }
    const r = await pass(t, ids);
    if (kid) check(ids.length >= 4 && r.down.length === 0 && r.min > 12, 'alone, kid on: through the row, nobody down, car keeps its speed', `${ids.length} people, top ${(r.top * 2.237).toFixed(0)} mph, min while among them ${(r.min * 2.237).toFixed(0)} mph, down ${r.down.join(',')}`);
    else check(ids.length >= 4 && r.down.length > 0, 'alone, kid off: people are knocked over as before', `${ids.length} people, down ${r.down.length}, min ${(r.min * 2.237).toFixed(0)} mph`);
    await t.close();
  }

  // ── two browsers ──
  const home = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(PORT), PC_STATE: path.join(mkdtempSync(path.join(tmpdir(), 'pc-kc-')), 'h') } });
  const lookup = createServer((req, res) => { if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${PORT}` })); }).listen(LOOKUP, '127.0.0.1');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* */ } await sleep(300); }
  try {
    const q = `kid=1&net=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
    const A = await mk(q); A.tag = 'A';
    await A.page.evaluate(() => window.__game.start());
    const B = await mk(q); B.tag = 'B';
    await B.page.evaluate(() => window.__game.start());
    const net = (t) => t.page.evaluate(() => window.__game.net());
    for (let i = 0; i < 100; i++) { const [a, b] = [await net(A), await net(B)]; if (a.status === 'online' && b.status === 'online' && a.count === 2) break; await sleep(300); }
    let H = A, G = B;
    for (let i = 0; i < 50; i++) { if ((await net(A)).people.mode === 'host') { H = A; G = B; break; } if ((await net(B)).people.mode === 'host') { H = B; G = A; break; } await sleep(300); }
    await H.page.evaluate(([x, z]) => window.__game.teleport(x - 6, z + 14, 0), [LANE.x, LANE.z]);
    await G.page.evaluate(([x, z]) => window.__game.teleport(x, z, 0), [LANE.x, LANE.z]);
    await sleep(2500);
    const ids = (await standRow(H, 6)).filter(Boolean);
    await sleep(2500);
    const k0 = (await net(G)).people.knocksSent, d0 = (await net(H)).people.knocksDone;
    const r = await pass(G, ids, [G, H]);
    const k1 = (await net(G)).people.knocksSent, d1 = (await net(H)).people.knocksDone;
    check(ids.length >= 4 && r.down.length === 0 && k1 === k0 && d1 === d0 && r.min > 12, `guest ${G.tag} drives through host ${H.tag}'s people: nobody down on either screen, no knock sent or applied`, `${ids.length} people, min ${(r.min * 2.237).toFixed(0)} mph, down ${r.down.length}, knocks sent ${k1 - k0}, applied ${d1 - d0}`);
    for (const t of [A, B]) check(t.errors.length === 0, `${t.tag} no errors`, JSON.stringify(t.errors).slice(0, 200));
  } finally { home.kill(); lookup.close(); }
} finally { for (const t of open) { try { await t.close(); } catch { /* */ } } }
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
