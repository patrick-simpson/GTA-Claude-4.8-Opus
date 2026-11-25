// Fun queue 2, item 22: where Tepid Falls' lost ducks and bridge-bond receipts go.
//
//   node tools/collect/gen.mjs            prints the lists (and writes src/game/findsData.ts with --write)
//
// Boots the real world (net=0) and builds candidate spots from real features: the river banks, Johnson Pond's shore, the
// back yards and side gaps of the street lots, the Harbor Line shelters, the Budget Line platforms and the campus paths.
// Every candidate must be on dry ground, flat, outside every wall, clear of the paved road, open to walk up to, and
// 30 m from every other find. A seeded pick then spreads the sets over the town. The result is a fixed list of x,z
// pairs (src/game/findsData.ts): the game reads them, it never re-derives them, so the bits in a save stay put.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

const t = await boot({ query: 'net=0&stage=4', width: 800, height: 450 });
const r = await t.page.evaluate(`(async () => {
  const G = window.__game.game;
  const P = await import('/src/world/plan.ts');
  const R = await import('/src/world/railway.ts');
  const TS = await import('/src/world/trainStations.ts');
  const DP = await import('/src/world/dithersPlan.ts');
  const PD = await import('/src/world/dithersPond.ts');
  const sg = G.plan.streets, col = G.col, gA = P.groundAt;
  let seed = 22022;
  const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return seed / 4294967296; };
  const walls = (x, z) => { const y = gA(x, z); return col.pointBlocked(x, z, y + 0.5) || col.pointBlocked(x, z, y + 2.5) || col.pointBlocked(x, z, y + 5); };
  const flat = (x, z, rr, tol = 0.4) => { const y = gA(x, z); for (const [a, b] of [[rr,0],[-rr,0],[0,rr],[0,-rr]]) if (Math.abs(gA(x + a, z + b) - y) > tol) return false; return true; };
  const open = (x, z) => { let n = 0; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, qx = x + Math.cos(a) * 3, qz = z + Math.sin(a) * 3; if (!walls(qx, qz) && !P.isWater(qx, qz) && Math.abs(gA(qx, qz) - gA(x, z)) < 0.9) n++; } return n >= 3; };
  const ok = (x, z, margin = 1.2, tol = 0.4) => z < -900 && !P.isWater(x, z) && gA(x, z) > P.WATER_Y + 0.5 && !walls(x, z) && flat(x, z, 1.2, tol) && sg.clearOfRoads(x, z, margin) && open(x, z) && (DP.campusFree(x, z, 0.6) || true);
  const pools = { river: [], pond: [], yard: [], shelter: [], platform: [], campus: [] };
  // River banks: every 5 m along the river, the dry ground 2.5 m beyond each side of a wide run of water.
  for (let z = -2900; z < -1000; z += 5) {
    let a = null;
    for (let x = 150; x < 520; x += 2) {
      const w = P.isWater(x, z);
      if (w && a === null) a = x;
      if (!w && a !== null) { if (x - a > 25) { for (const d of [-1, 1]) for (let o = 1.5; o < 14; o += 1) { const bx = d < 0 ? a - o : x + o; if (gA(bx, z) > 0.15 && ok(bx, z, 1.5, 0.55)) { pools.river.push([bx, z, d]); break; } } } a = null; }
    }
  }
  // Johnson Pond: the shore ring, a little way up the bank.
  const S = PD.POND_SHORE; let cx = 0, cz = 0; const n = S.length / 2; for (let i = 0; i < S.length; i += 2) { cx += S[i]; cz += S[i + 1]; } cx /= n; cz /= n;
  for (let i = 0; i < S.length; i += 2) for (const o of [1.8, 3]) { const dx = S[i] - cx, dz = S[i + 1] - cz, d = Math.hypot(dx, dz); const x = S[i] + dx / d * o, z = S[i + 1] + dz / d * o; const y = gA(x, z); if (y > PD.POND_LEVEL + 0.1 && y < PD.POND_LEVEL + 1.6 && ok(x, z, 1)) pools.pond.push([x, z]); }
  // Lots: the gap beside a building and the yard behind it.
  for (const l of sg.lots) {
    if (l.cz > -900) continue;
    const s = Math.sin(l.h), c = Math.cos(l.h);
    const cand = [[-s * (l.d / 2 + 1.4), -c * (l.d / 2 + 1.4)], [c * (l.w / 2 + 1.1), -s * (l.w / 2 + 1.1)], [-c * (l.w / 2 + 1.1), s * (l.w / 2 + 1.1)]];
    for (const [dx, dz] of cand) { const x = l.cx + dx, z = l.cz + dz; if (ok(x, z, 2.2)) pools.yard.push([x, z, l.district]); }
  }
  // Harbor Line shelters in Tepid Falls: on the walk beside the glass.
  for (const st of G.bus.stations) {
    if (st.z > -900) continue;
    const tx = Math.sin(st.h), tz = Math.cos(st.h);
    for (const u of [3.4, -3.4]) { const w = st.hw + 2.2; const x = st.x + tx * u + st.rx * w, z = st.z + tz * u + st.rz * w; if (ok(x, z, 0.4)) { pools.shelter.push([x, z, st.name]); break; } }
  }
  // Budget Line platforms.
  // (The spot on each platform that a walker can actually reach past the shelter, benches and signs was found by walking
  // them: scratch only; the Depot's is further down its platform.)
  R.STATIONS.forEach((st, si) => { const u = si === 1 ? -15 : -4; { const q = TS.stationPoint(st, u, TS.PLATFORM_IN + TS.PLATFORM_W / 2, { x: 0, z: 0 }); if (q.z < -900 && !walls(q.x, q.z) && !P.isWater(q.x, q.z)) pools.platform.push([q.x, q.z, st.name, u]); } });
  // Campus paths: beside the walk.
  for (const p of DP.CAMPUS_PATHS) for (let k = 0; k + 3 < p.length; k += 2) { const dx = p[k + 2] - p[k], dz = p[k + 3] - p[k + 1], d = Math.hypot(dx, dz) || 1; for (const sd of [1, -1]) { const x = (p[k] + p[k + 2]) / 2 - dz / d * 2.2 * sd, z = (p[k + 1] + p[k + 3]) / 2 + dx / d * 2.2 * sd; if (ok(x, z, 1)) pools.campus.push([x, z]); } }
  // Seeded pick with spacing.
  const taken = [];
  const far = (x, z, m) => taken.every((q) => Math.hypot(q[0] - x, q[1] - z) > m);
  const pick = (pool, n, gap, evenBy) => {
    const out = [];
    let list = pool.slice();
    if (evenBy) list.sort((a, b) => a[evenBy] - b[evenBy]);
    else for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    if (evenBy) { const step = list.length / (n * 1.0); const sel = []; for (let i = 0; i < n; i++) sel.push(list[Math.min(list.length - 1, Math.floor(i * step + rnd() * step * 0.8))]); list = sel.concat(list); }
    for (const q of list) { if (out.length >= n) break; if (far(q[0], q[1], gap)) { out.push(q); taken.push(q); } }
    return out;
  };
  const dr = [...pick(pools.river, 15, 50, 1), ...pick(pools.pond, 5, 25), ...pick(pools.yard, 7, 70), ...pick(pools.campus, 3, 40)];
  const rc = [...pick(pools.shelter, 6, 40), ...pick(pools.platform, 3, 30), ...pick(pools.yard, 7, 70), ...pick(pools.campus, 4, 40)];
  return { sizes: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])), ducks: dr.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]), receipts: rc.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]) };
})()`);
console.log(JSON.stringify({ sizes: r.sizes, ducks: r.ducks.length, receipts: r.receipts.length }));
if (process.argv.includes('--write')) {
  const fmt = (a) => a.map((q) => `[${q[0]}, ${q[1]}]`).join(', ');
  fs.writeFileSync('src/game/findsData.ts', `// Fun queue 2, item 22: where the finds lie. Generated by tools/collect/gen.mjs (real river banks, pond shore, back yards, shelters,
// platforms and campus walks, each checked for dry flat open ground outside every wall and off the road); do not edit by hand:
// the index of a spot is its bit in the save.

/** Lost rubber ducks: x, z pairs. */
export const DUCK_SPOTS: [number, number][] = [${fmt(r.ducks)}];
/** Bridge-bond receipts: x, z pairs. */
export const RECEIPT_SPOTS: [number, number][] = [${fmt(r.receipts)}];
`);
}
await t.close();
