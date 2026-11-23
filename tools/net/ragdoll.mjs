// Ragdolls in multiplayer (Nov 23): two headless browsers against a LOCAL home service (server/home/main.ts).
//
//   node tools/net/ragdoll.mjs              the checks, and two pictures from B's view into shots/net/
//   node tools/net/ragdoll.mjs --noshots
//
// 1. A's own ragdoll: A is thrown (a 45 mph car); B must show A as a ragdoll too (the state frame's ragdoll tail),
//    following the same flight, and let go of it when A has landed.
// 2. A shared pedestrian: the host runs one down; the guest must fly the same person and put them down near where the
//    host did.
// Real time (the network is), so the tolerances are distances, generous for a slow headless page.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const PORT = 8831, LOOKUP = 8832;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const tmp = mkdtempSync(path.join(tmpdir(), 'pc-rag-'));
const home = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(PORT), PC_STATE: path.join(tmp, 'h') } });
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
// The town is shared (host and guests) only on the MAIN home, found through the lookup: a stand-in for it here.
const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${PORT}` }));
}).listen(LOOKUP, '127.0.0.1');
const query = `q=low&net=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
const open = [];
async function visitor(tag) {
  const t = await boot({ start: false, query, width: 640, height: 360 });
  open.push(t); t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.ev = (fn, a) => t.page.evaluate(fn, a);
  await t.ev(() => window.__game.start());
  return t;
}

try {
  if (!(await up())) throw new Error('the local home service did not start (run `npm install` in server/ once)');
  const A = await visitor('A');
  await sleep(1500);
  const B = await visitor('B');
  const X = -23, Z = 100;
  await A.ev(([x, z]) => window.__game.teleport(x, z, 0), [X, Z]);
  await B.ev(([x, z]) => window.__game.teleport(x, z, 0), [X + 3, Z - 12]);
  let seen = false;
  for (let i = 0; i < 150 && !seen; i++) {
    const [a, b] = await Promise.all([A.net(), B.net()]);
    seen = a.remotes?.length > 0 && b.remotes?.length > 0;
    if (!seen) await sleep(200);
  }
  check(seen, 'both players see each other');
  if (!seen) throw new Error('no town');

  // ── 1. A thrown by a car; B shows the same flight ──
  await A.ev(() => { const G = window.__game.game, P = G.player; P.knockDown(0, 0, 0, { vx: 4, vz: 19 }); });
  const pa = [], pb = [];
  let bFlew = 0, aLanded = -1, bLet = -1, shot = false;
  for (let i = 0; i < 60; i++) {
    const [a, b] = await Promise.all([
      A.ev(() => { const G = window.__game.game, p = G.player.person; return { f: G.people.rag.flying(p), x: p.x, y: p.y, z: p.z }; }),
      B.ev(() => { const G = window.__game.game, r = [...G.net.remotes.values()][0], p = r && r.person; return p ? { f: G.people.rag.flying(p), x: p.x, y: p.y, z: p.z } : null; }),
    ]);
    if (a.f) pa.push(a);
    if (b && b.f) { bFlew++; pb.push(b); }
    if (!a.f && pa.length && aLanded < 0) aLanded = i;
    if (b && !b.f && bFlew && bLet < 0) bLet = i;
    if (SHOTS && !shot && b && b.f && b.y > 1.2) { shot = true; await B.ev(([x, y, z]) => window.__game.view(x - 6, y + 2, z - 7, x, y, z), [b.x, b.y, b.z]); await sleep(120); await B.shot('shots/net/ragdoll-flight.png'); await B.ev(() => window.__game.view()); }
    if (aLanded >= 0 && bLet >= 0) break;
    await sleep(150);
  }
  const peakA = Math.max(...pa.map((p) => p.y)), peakB = pb.length ? Math.max(...pb.map((p) => p.y)) : -1;
  // Each of B's samples against the nearest of A's (B is a few frames behind, so not index by index).
  let worst = 0;
  for (const q of pb) { let d = 1e9; for (const p of pa) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)); worst = Math.max(worst, d); }
  check(pa.length > 3, 'A flies as a ragdoll', `${pa.length} samples, peak y ${peakA.toFixed(2)}`);
  check(bFlew > 2, 'B shows A as a ragdoll (state frame tail)', `${bFlew} samples, peak y ${peakB.toFixed(2)}`);
  check(pb.length > 0 && worst < 2.5, 'B\'s flight follows A\'s path', `worst ${worst.toFixed(2)} m`);
  check(bLet >= 0, 'B lets go once A has landed', `A landed at sample ${aLanded}, B at ${bLet}`);

  // ── 2. The host runs down a shared pedestrian; the guest flies them too ──
  let na, nb;
  for (let i = 0; i < 100; i++) {
    [na, nb] = await Promise.all([A.net(), B.net()]);
    const m = [na.traffic?.mode, nb.traffic?.mode].sort().join();
    if (m === 'guest,host') break;
    await sleep(300);
  }
  const H = na.traffic?.mode === 'host' ? A : nb.traffic?.mode === 'host' ? B : null;
  const Gst = H === A ? B : A;
  check(!!H, 'one of the two is the host', `${na.traffic?.mode} / ${nb.traffic?.mode}`);
  if (H) {
    // A walker of the host's, and both players beside them (a ragdoll is only for people close to the camera).
    let hit = null, w0 = null;
    for (let i = 0; i < 20 && !w0; i++) {
      await sleep(500);
      w0 = await H.ev(() => {
        const G = window.__game.game, P = G.player, peds = G.systems.find((s) => s.peds)?.peds;
        let best = null, bd = 1e9;
        for (const w of peds.walkers) { if (!w.active || !w.p.visible || w.mode === 5 || w.mode === 4) continue; const d = Math.hypot(w.p.x - P.x, w.p.z - P.z); if (d < bd) { bd = d; best = w; } }
        window.__w = best;
        return best ? { x: best.p.x, z: best.p.z } : null;
      });
    }
    if (w0) {
      await H.ev(([x, z]) => window.__game.teleport(x - 5, z, 0), [w0.x, w0.z]);
      await Gst.ev(([x, z]) => window.__game.teleport(x - 5, z - 5, 0), [w0.x, w0.z]);
      await sleep(2000);
      hit = await H.ev(() => {
        const G = window.__game.game, peds = G.systems.find((s) => s.peds)?.peds, w = window.__w;
        peds.fall(w, 0, 14, 14, false);
        return { x: w.p.x, z: w.p.z, f: G.people.rag.flying(w.p) };
      });
    }
    check(!!hit && hit.f, 'the host flies the pedestrian', hit ? `at ${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}` : 'no walker near');
    if (hit) {
      let gFlew = 0, hEnd = null;
      for (let i = 0; i < 60; i++) {
        const [h, g] = await Promise.all([
          H.ev(() => { const G = window.__game.game, p = window.__w.p; return { f: G.people.rag.flying(p), x: p.x, z: p.z }; }),
          Gst.ev(() => window.__game.game.people.rag.count),
        ]);
        if (g > 0) gFlew++;
        if (!h.f && !hEnd) hEnd = h;
        if (hEnd && g === 0 && i > 5) break;
        await sleep(150);
      }
      check(gFlew > 1, 'the guest flies the same pedestrian', `${gFlew} samples`);
      await sleep(1500);
      const near = await Gst.ev(([x, z]) => { const G = window.__game.game; let d = 1e9; for (const p of G.people.list) if (p.visible && p.pose === 'down') d = Math.min(d, Math.hypot(p.x - x, p.z - z)); return d; }, [hEnd.x, hEnd.z]);
      check(near < 4, 'and puts them down where the host did', `${near.toFixed(2)} m`);
    }
  }
  for (const t of open) check(t.errors.length === 0, `${t.tag}: no page errors`, t.errors.slice(0, 2).join(' | '));
} catch (e) {
  console.log('FAIL ', String(e && e.message || e)); failed++;
} finally {
  for (const t of open) await t.close().catch(() => {});
  try { home.kill('SIGTERM'); } catch { /* gone */ }
  lookup.close();
  await sleep(500);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ }
}
process.exit(failed ? 1 : 0);
