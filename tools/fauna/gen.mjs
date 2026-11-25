// Fun queue 2, item 33: where the wildlife lives. Generated into src/world/faunaData.ts (run with --write).
//
//   node tools/fauna/gen.mjs            prints the pool sizes and the picked spots
//   node tools/fauna/gen.mjs --write    also writes src/world/faunaData.ts
//
// Boots the real world (net=0) and builds candidates from real features: the river banks, Johnson Pond's shore and water,
// Lake Indecision, the country roads' verges (the moose places), the island's outer strips, the backs of Main St (the
// Holding Pattern's dumpsters, found from their collision boxes). Every spot must be on dry flat ground (or on water,
// for swimmers), outside every wall, clear of the paved road and of buildings. A seeded pick spreads them over the town.
// The game reads the fixed list, it never re-derives it, so every browser puts the same herd in the same place.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

const t = await boot({ query: 'net=0&stage=4', width: 800, height: 450 });
const r = await t.page.evaluate(`(async () => {
  const G = window.__game.game;
  const P = await import('/src/world/plan.ts');
  const PD = await import('/src/world/dithersPond.ts');
  const ML = await import('/src/world/mainland.ts');
  const sg = G.plan.streets, col = G.col, gA = P.groundAt;
  let seed = 33033;
  const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return seed / 4294967296; };
  const walls = (x, z) => { const y = gA(x, z); return col.pointBlocked(x, z, y + 0.5) || col.pointBlocked(x, z, y + 2.5) || col.pointBlocked(x, z, y + 5); };
  const boxesNear = (x, z, r) => { let n = 0; col.forBoxes(x, z, r, () => { n++; }); return n; };
  const flat = (x, z, rr, tol) => { const y = gA(x, z); for (const [a, b] of [[rr,0],[-rr,0],[0,rr],[0,-rr]]) if (Math.abs(gA(x + a, z + b) - y) > tol) return false; return true; };
  const dry = (x, z) => !P.isWater(x, z) && PD.pondSD(x, z) > 1.5 && gA(x, z) > P.WATER_Y + 0.4;
  const okm = (x, z, tol, road, clear) => z < -900 && dry(x, z) && !walls(x, z) && flat(x, z, 3, tol) && sg.clearOfRoads(x, z, road) && boxesNear(x, z, clear) === 0;
  const pools = { river: [], pond: [], rural: [], isle: [], gooseBankPond: [], gooseWaterPond: [], gooseBankRiver: [], gooseWaterRiver: [], lake: [] };
  for (let z = -2860; z < -1000; z += 25) {
    let a = null;
    for (let x = 150; x < 520; x += 2) {
      const w = P.isWater(x, z);
      if (w && a === null) a = x;
      if (!w && a !== null) {
        if (x - a > 25) {
          const mid = (a + x) / 2;
          const wx = mid + (rnd() - 0.5) * (x - a) * 0.35;
          if (P.isWater(wx, z) && P.isWater(wx, z + 6) && P.isWater(wx, z - 6) && z < -1620) pools.gooseWaterRiver.push([wx, z]);
          for (const d of [-1, 1]) {
            for (let o = 2; o < 34; o += 1) { const bx = d < 0 ? a - o : x + o; if (gA(bx, z) > 0.15 && okm(bx, z, 0.8, 4, 3)) { if (o >= 2.5 && o <= 7) pools.gooseBankRiver.push([bx, z]); if (o >= 9) { pools.river.push([bx, z]); break; } } }
          }
        }
        a = null;
      }
    }
  }
  const S = PD.POND_SHORE; let cx = 0, cz = 0; const n = S.length / 2; for (let i = 0; i < S.length; i += 2) { cx += S[i]; cz += S[i + 1]; } cx /= n; cz /= n;
  for (let i = 0; i < S.length; i += 2) {
    const dx = S[i] - cx, dz = S[i + 1] - cz, d = Math.hypot(dx, dz);
    for (const o of [3, 4.5]) { const x = S[i] + dx / d * o, z = S[i + 1] + dz / d * o; if (PD.pondSD(x, z) > 2 && !walls(x, z) && boxesNear(x, z, 3) === 0 && flat(x, z, 1.5, 0.6) && sg.clearOfRoads(x, z, 2)) pools.gooseBankPond.push([x, z]); }
    for (const o of [-9, -14]) { const x = S[i] + dx / d * o, z = S[i + 1] + dz / d * o; if (PD.pondSD(x, z) < -7) pools.gooseWaterPond.push([x, z]); }
    for (const o of [24, 34]) { const x = S[i] + dx / d * o, z = S[i + 1] + dz / d * o; if (okm(x, z, 1.2, 6, 14)) pools.pond.push([x, z]); }
  }
  const L = ML.LAKE;
  for (let k = 0; k < 24; k++) { const a = k / 24 * 6.2832; const lx = L.x + Math.cos(a) * L.a, lz = L.z + Math.sin(a) * L.b; for (const f of [0.35, 0.6]) { const x = L.x + (lx - L.x) * f, z = L.z + (lz - L.z) * f; if (P.isWater(x, z) && P.isWater(x + 8, z) && P.isWater(x - 8, z)) pools.lake.push([x, z]); } }
  for (const s of G.moose.sites) { if (s.land !== 1) continue; for (const side of [-1, 1]) for (let d = 26; d <= 44; d += 6) { const x = s.x - s.dz * d * side + s.dx * 10, z = s.z + s.dx * d * side + s.dz * 10; if (okm(x, z, 1.4, 10, 8)) { pools.rural.push([x, z]); break; } } }
  for (let x = -760; x < 960; x += 8) for (let z = -520; z < 470; z += 8) {
    if (!(z < -446 || x < -614 || x > 594) || (x > 630 && z > 200 && z < 300)) continue;
    const y = gA(x, z);
    if (P.isWater(x, z) || y < 0.1 || walls(x, z) || boxesNear(x, z, 9) || !flat(x, z, 3, 0.8)) continue;
    pools.isle.push([x, z]);
  }
  const taken = [];
  const far = (x, z, m) => taken.every((q) => Math.hypot(q[0] - x, q[1] - z) > m);
  const pick = (pool, nn, gap) => {
    const list = pool.slice();
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    const out = [];
    for (const q of list) { if (out.length >= nn) break; if (far(q[0], q[1], gap)) { out.push(q); taken.push(q); } }
    return out;
  };
  const rd = (a) => a.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
  const deer = [...rd(pick(pools.river, 6, 150)), ...rd(pick(pools.pond, 2, 60)), ...rd(pick(pools.rural, 8, 120)), ...rd(pick(pools.isle, 4, 100))];
  taken.length = 0;
  const geese = [
    ...rd(pick(pools.gooseBankPond, 2, 40)).map((q) => [...q, 0]), ...rd(pick(pools.gooseWaterPond, 2, 30)).map((q) => [...q, 1]),
    ...rd(pick(pools.gooseBankRiver, 4, 150)).map((q) => [...q, 0]), ...rd(pick(pools.gooseWaterRiver, 4, 150)).map((q) => [...q, 1]),
    ...rd(pick(pools.lake, 1, 10)).map((q) => [...q, 1]),
  ];
  const dumps = [];
  for (const b of col.allBoxes) {
    const w = b.x1 - b.x0, l = b.z1 - b.z0;
    if (Math.abs(w - 1.3) < 0.05 && Math.abs(l - 2.1) < 0.05 && b.z1 < -900) {
      const cxm = (b.x0 + b.x1) / 2, czm = (b.z0 + b.z1) / 2;
      for (const side of [-1, 1]) { const x = cxm + side * 1.55, z = czm; if (!walls(x, z) && !P.isWater(x, z) && boxesNear(x, z, 0.6) <= 2) { dumps.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(Math.atan2(-side, 0) * 100) / 100, 1]); break; } }
    }
  }
  taken.length = 0;
  const forest = rd(pick(pools.rural, 5, 60)).map((q) => [...q, 0, 0]);
  taken.length = 0;
  const dsel = []; for (const q of dumps) if (far(q[0], q[1], 30)) { dsel.push(q); taken.push(q); }
  dumps.length = 0; for (const q of dsel.slice(0, 5)) dumps.push(q);
  return { sizes: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])), deer, geese, dumps, forest };
})()`);
console.log(JSON.stringify({ sizes: r.sizes, deer: r.deer.length, geese: r.geese.length, dumps: r.dumps.length, forest: r.forest.length }));
console.log(JSON.stringify(r.deer), JSON.stringify(r.geese), JSON.stringify(r.dumps), JSON.stringify(r.forest));
console.log(t.errors);
if (process.argv.includes('--write')) {
  const fmt = (a) => a.map((q) => `[${q.join(', ')}]`).join(', ');
  fs.writeFileSync('src/world/faunaData.ts', `// Fun queue 2, item 33: where the wildlife lives. Generated by tools/fauna/gen.mjs (real river banks, Johnson Pond, Lake
// Indecision, country verges, the island's outer strips, the dumpsters behind Main St), each on dry flat ground (or water,
// for swimmers), outside every wall and off the road. The game reads this fixed list, it never re-derives it.

/** Deer herds: where each grazes (x, z). */
export const DEER_SITES: [number, number][] = [${fmt(r.deer)}];
/** Goose flocks: x, z and 0 on the bank or 1 afloat. */
export const GEESE_SITES: [number, number, number][] = [${fmt(r.geese)}];
/** Bear places: x, z, the way it faces (radians, forward is (sin h, cos h)), and 1 for a dumpster, 0 for the forest edge. */
export const BEAR_SITES: [number, number, number, number][] = [${fmt([...r.dumps, ...r.forest])}];
`);
  console.log('written');
}
await t.close();
