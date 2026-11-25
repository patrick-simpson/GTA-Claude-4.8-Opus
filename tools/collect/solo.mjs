// Finds (fun queue 2, item 22), single player (net=0): src/game/finds.ts, src/game/findsData.ts, the Places "Finds" chip.
//
//   node tools/collect/solo.mjs [--shots] [--walk N | --all]
//
// Every one of the fifty spots is checked: in Tepid Falls, on dry ground the plan agrees with, flat, outside every wall,
// off the paved road, with open ground to walk up from. A walk from 8 m away picks up a sample on foot (N, default 8);
// a car drives through one; picking pays the cash, counts and toasts; a set completed (the last find, by teleport)
// pays its prize and sets the .all flag; the save holds the masks; the radar shows a badge for a near find and for a
// nearly done set; the Places panel lists both sets.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const WALK = Number(process.argv[process.argv.indexOf('--walk') + 1]) || 8;
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-22/shots/';

const t = await boot({ query: 'net=0&stage=4' + (process.env.FD_QUERY ? '&' + process.env.FD_QUERY : ''), width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(30); });
await t.page.evaluate(`(async () => {
  const P = await import('/src/world/plan.ts');
  const S = await import('/src/game/save.ts');
  const G = window.__game.game;
  window.__fd = { P, S, G, F: G.todo.finds, toasts: [] };
  const tt = G.hud.toast.bind(G.hud); G.hud.toast = (m, s) => { window.__fd.toasts.push(String(m)); return tt(m, s); };
})()`);

// ── 1. Every spot ──
const bad = await t.game(() => {
  const X = window.__fd, G = X.G, sg = G.plan.streets, P = X.P, out = [], ring = [];
  for (const id of ['duck', 'receipt']) {
    for (let i = 0; i < X.F.total(id); i++) {
      const { x, y, z } = X.F.at(id, i), gy = P.groundAt(x, z), why = [];
      if (z > -900) why.push('not in Tepid Falls');
      if (Math.abs(y - gy) > 0.01) why.push('y differs from the ground');
      if (P.isWater(x, z) || gy < P.WATER_Y + 0.5) why.push('wet');
      for (const h of [0.5, 2.5, 5]) if (G.col.pointBlocked(x, z, gy + h)) { why.push('inside a wall'); break; }
      if (!sg.clearOfRoads(x, z, 0.3)) why.push('on the road');
      let fl = 0; for (const [a, b] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) fl = Math.max(fl, Math.abs(P.groundAt(x + a, z + b) - gy));
      if (fl > 0.6) why.push('slope ' + fl.toFixed(2));
      let open = 0; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, qx = x + Math.cos(a) * 3, qz = z + Math.sin(a) * 3, qy = P.groundAt(qx, qz); if (!G.col.pointBlocked(qx, qz, qy + 0.5) && !P.isWater(qx, qz) && Math.abs(qy - gy) < 0.9) open++; }
      if (open < 3) why.push('closed in');
      if (why.length) out.push({ id, i, x, z, why: why.join(', ') });
      ring.push([x, z]);
    }
  }
  let minGap = 1e9; for (let a = 0; a < ring.length; a++) for (let b = a + 1; b < ring.length; b++) minGap = Math.min(minGap, Math.hypot(ring[a][0] - ring[b][0], ring[a][1] - ring[b][1]));
  return { out, n: ring.length, minGap, ducks: X.F.total('duck'), receipts: X.F.total('receipt') };
});
check(bad.ducks === 30 && bad.receipts === 20, 'thirty ducks and twenty receipts', `${bad.ducks}/${bad.receipts}`);
check(bad.out.length === 0, `all ${bad.n} spots are dry, flat, open ground off the road and outside walls`, JSON.stringify(bad.out.slice(0, 4)));
check(bad.minGap > 25, 'no two finds closer than 25 m', bad.minGap.toFixed(1));

// ── 2. Walk up to a sample on foot ──
const sample = [];
if (process.argv.includes('--all')) { for (let i = 0; i < 30; i++) sample.push(['duck', i]); for (let i = 0; i < 20; i++) sample.push(['receipt', i]); }
else for (let i = 0; i < WALK; i++) sample.push(i % 2 ? ['receipt', Math.floor(i * 19 / WALK)] : ['duck', Math.floor(i * 30 / WALK)]);
let walked = 0;
for (const [id, i] of sample) {
  // Every clear bearing in turn (up to sixteen): a sign post or a bench is not a wall, and a find only has to be reachable from somewhere.
  let got = false, tried = 0;
  for (let from = 0; from < 16 && !got && tried < 16; from++) {
    const r = await t.game((g, a) => {
      const X = window.__fd, G = X.G, P = X.P, f = X.F.at(a.id, a.i);
      for (let k = a.from; k < 16; k++) {
        const ang = k * Math.PI / 8, sx = f.x + Math.cos(ang) * 8, sz = f.z + Math.sin(ang) * 8;
        if (G.col.pointBlocked(sx, sz, P.groundAt(sx, sz) + 0.5) || P.isWater(sx, sz)) continue;
        let clear = Math.abs(P.groundAt(sx, sz) - f.y) < 0.7;
        for (let q = 1; q < 8; q++) { const px = f.x + Math.cos(ang) * q, pz = f.z + Math.sin(ang) * q, py = P.groundAt(px, pz); if (G.col.pointBlocked(px, pz, py + 0.5) || Math.abs(py - f.y) > 0.7 || P.isWater(px, pz)) clear = false; }
        if (!clear) continue;
        g.teleport(sx, sz, Math.atan2(f.x - sx, f.z - sz)); g.step(20);
        return { ok: true, k };
      }
      return { ok: false };
    }, { id, i, from });
    if (!r.ok) break;
    from = r.k; tried++;
    await t.page.keyboard.down('KeyW');
    for (let s = 0; s < 20 && !got; s++) { await t.step(6); got = await t.game((g, a) => window.__fd.F.has(a.id, a.i), { id, i }); }
    await t.page.keyboard.up('KeyW');
  }
  if (got) walked++; else console.log(`NOTE  ${id} ${i} not reached on foot (${tried} approaches tried)`, JSON.stringify(await t.game((g, a) => { const p = window.__fd.G.player, f = window.__fd.F.at(a.id, a.i); return { p: [p.x, p.y, p.z], f, d: Math.hypot(p.x - f.x, p.z - f.z), v: !!p.vehicle, sw: p.swimming }; }, { id, i })));
}
check(walked >= Math.max(1, Math.floor(sample.length * 0.75)), `walking up to a find picks it up (${walked} of ${sample.length} sampled)`);
if (process.argv.includes('--all')) check(walked === sample.length, 'every one of the fifty can be walked up to');

// A full walk collected everything: put the sets back before the pay checks.
await t.game(() => { const b = window.__fd.S.save.data.best; b['fd.duck'] = 0; b['fd.receipt'] = 0; delete b['fd.duck.all']; delete b['fd.receipt.all']; });

// ── 3. A car drives through one; pay, toast and counts ──
{
  const pre = await t.game(() => { const X = window.__fd; return { money: X.G.player.money, fd: X.S.save.count('fd.found'), ducks: X.F.got('duck') }; });
  const f = await t.game((g) => {
    const X = window.__fd, F = X.F, G = X.G, P = X.P;
    // A duck with a dry, wall-free run-up of 12 m (the car needs room to get going), taken from the yards and the campus.
    for (let i = 29; i >= 15; i--) {
      if (F.has('duck', i)) continue;
      const s = F.at('duck', i);
      for (let k = 0; k < 16; k++) {
        const ang = k * Math.PI / 8; let clear = true;
        for (let q = 1; q <= 12; q++) { const px = s.x + Math.cos(ang) * q, pz = s.z + Math.sin(ang) * q, py = P.groundAt(px, pz); if (P.isWater(px, pz) || G.col.pointBlocked(px, pz, py + 0.5) || G.col.pointBlocked(px, pz, py + 1.2) || Math.abs(py - s.y) > 1.2) clear = false; }
        if (!clear) continue;
        const sx = s.x + Math.cos(ang) * 12, sz = s.z + Math.sin(ang) * 12;
        g.teleport(sx, sz, Math.atan2(s.x - sx, s.z - sz)); g.drive('sports'); g.step(5);
        return { id: 'duck', i };
      }
    }
    return { id: 'duck', i: -1 };
  });
  await t.page.keyboard.down('KeyW'); await t.step(120); await t.page.keyboard.up('KeyW');
  const post = await t.game((g, a) => { const X = window.__fd; return { money: X.G.player.money, fd: X.S.save.count('fd.found'), has: X.F.has(a.id, a.i), ducks: X.F.got('duck'), best: X.S.save.data.best['fd.duck'], toast: X.toasts.find((m) => /^Duck \d+ of 30/.test(m)) ?? '' }; }, f);
  check(post.has, 'a car driving through a duck collects it', JSON.stringify(f));
  check(post.money - pre.money >= 10 && post.fd > pre.fd, 'a find pays and is counted', `+${post.money - pre.money}, found ${post.fd}`);
  check(typeof post.best === 'number' && post.best !== 0 && post.ducks > pre.ducks, 'the save holds the bitmask', String(post.best));
  check(/Duck \d+ of 30/.test(post.toast), 'a toast says "Duck N of 30"', post.toast);
}

// ── 4. Radar and Places ──
{
  const r = await t.game((g) => {
    const X = window.__fd, F = X.F; let i = 0; while (F.has('receipt', i)) i++;
    const s = F.at('receipt', i); X.G.player.teleport(s.x + 60, s.z, 0); g.step(10);
    const out = []; F.blips(out); const near = out.some((b) => b.label === 'R' && Math.hypot(b.x - s.x, b.z - s.z) < 1);
    X.G.player.teleport(s.x + 600, s.z, 0); g.step(10);
    const out2 = []; F.blips(out2); const far = out2.some((b) => b.label === 'R');
    return { near, far };
  });
  check(r.near, 'the radar shows the nearest receipt within range');
  check(!r.far, 'the radar does not show a far one while the set is far from done');
  await t.game((g) => { const G = window.__fd.G; G.todo.menu.tab = 0; G.setPaused(true); g.step(2); });
  const n = await t.page.evaluate(`document.querySelectorAll('.pl-fdchip').length`);
  check(n === 1, 'the Places panel has a Finds chip', String(n));
  const txt = await t.page.evaluate(`(() => { const c = document.querySelector('.pl-fdchip'); if (!c) return ''; c.click(); return document.querySelector('.pl-list').innerText + ' | ' + document.querySelector('.pl-foot').innerText; })()`);
  check(/Lost ducks · \d+ of 30/.test(txt) && /Bridge-bond receipts · \d+ of 20/.test(txt), 'the Finds chip lists both sets with counts', txt.slice(0, 120).replace(/\n/g, ' '));
  if (SHOTS) await t.shot(SH + 'places.png');
  await t.game((g) => { window.__fd.G.setPaused(false); g.step(2); });
  const m = await t.game((g) => {
    const X = window.__fd, F = X.F, b = X.S.save.data.best; let mask = 0; for (let i = 0; i < 17; i++) mask |= 1 << i; b['fd.receipt'] = mask;
    X.G.player.teleport(0, -1000, 0); g.step(10);
    const out = []; F.blips(out); return out.some((q) => q.label === 'R');
  });
  check(m, 'a nearly finished set shows its nearest on the radar wherever it is');
}

// ── 5. Completing a set ──
{
  const r = await t.game((g) => {
    const X = window.__fd, F = X.F, b = X.S.save.data.best, p = X.G.player;
    let mask = 0; for (let i = 0; i < 19; i++) mask |= 1 << i; b['fd.receipt'] = mask; delete b['fd.receipt.all'];
    const s = F.at('receipt', 19), m0 = p.money;
    p.teleport(s.x, s.z, 0); g.step(10);
    const stamp = document.body.innerText.includes('BOND COLLECTOR');
    return { got: F.got('receipt'), all: b['fd.receipt.all'], gain: p.money - m0, stamp, mask: b['fd.receipt'] };
  });
  check(r.got === 20 && r.all === 1, 'the twentieth receipt completes the set', JSON.stringify(r));
  check(r.gain === 25 + 1200, 'the set pays its prize on top of the find ($1,225)', String(r.gain));
  check(r.stamp, 'the prize stamp shows');
  const again = await t.game((g) => { const X = window.__fd, p = X.G.player, m0 = p.money, s = X.F.at('receipt', 19); p.teleport(s.x, s.z, 0); g.step(10); return p.money - m0; });
  check(again === 0, 'a collected find pays nothing twice');
  const stored = await t.game(() => { window.__fd.G.todo.saveNow(); const j = JSON.parse(localStorage.getItem('portcalamity.save.v1')); return { r: j.best['fd.receipt'], a: j.best['fd.receipt.all'], n: j.counts['fd.found'] }; });
  check(stored.r === r.mask && stored.a === 1 && stored.n > 0, 'the save on disk holds the receipts mask, the prize flag and the count', JSON.stringify(stored));
  const d = await t.game((g) => {
    const X = window.__fd, F = X.F, b = X.S.save.data.best, p = X.G.player;
    b['fd.duck'] = 0x3fffffff & ~(1 << 7); delete b['fd.duck.all'];
    const s = F.at('duck', 7), m0 = p.money; p.teleport(s.x, s.z, 0); g.step(10);
    return { got: F.got('duck'), all: b['fd.duck.all'], gain: p.money - m0, mask: b['fd.duck'] };
  });
  check(d.got === 30 && d.all === 1 && d.gain === 810 && d.mask === 0x3fffffff, 'the thirtieth duck completes that set ($810), mask 2^30-1', JSON.stringify(d));
}

if (SHOTS) {
  await t.game((g) => { const X = window.__fd; X.S.save.data.best['fd.duck'] = 0; X.S.save.data.best['fd.receipt'] = 0; g.step(2); });
  for (const [id, i] of [['duck', 0], ['duck', 20], ['receipt', 4], ['receipt', 10]]) {
    await t.game((g, a) => {
      const X = window.__fd, f = X.F.at(a.id, a.i);
      let best = null;
      for (let k = 0; k < 16; k++) { const ang = k * Math.PI / 8, sx = f.x + Math.cos(ang) * 7, sz = f.z + Math.sin(ang) * 7; if (X.G.col.pointBlocked(sx, sz, X.P.groundAt(sx, sz) + 1) || X.P.isWater(sx, sz)) continue; best = [sx, sz]; break; }
      const b = best ?? [f.x + 7, f.z];
      X.G.player.teleport(f.x + 40, f.z, 0); g.step(10);
      g.view(b[0], X.P.groundAt(b[0], b[1]) + 2, b[1], f.x, f.y + 0.6, f.z);
      g.step(3);
    }, { id, i });
    await t.page.waitForTimeout(500); await t.step(2);
    await t.shot(SH + `${id}${i}.png`);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
console.log('errors:', JSON.stringify(t.errors));
await t.close();
process.exit(failed || t.errors.length ? 1 : 0);
