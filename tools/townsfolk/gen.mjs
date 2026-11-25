// Fun queue 2, item 30: where the named townsfolk go.
//
//   node tools/townsfolk/gen.mjs            prints a report
//   node tools/townsfolk/gen.mjs --write    also writes src/game/townsfolkData.ts
//
// Boots the real world (net=0), snaps every stop of the cast below to open walkable ground (dry, flat, outside every wall, off the
// paved road) beside the real business, finds a home lot for each, and routes each leg between stops with an A* over a 1.5 m
// grid of that same ground (the paved road costs a lot, so they cross it once and square). The routes are simplified and
// re-checked every 0.5 m; the game only ever reads the finished list (src/game/townsfolkData.ts), never re-derives it.
// Times are the town clock (sky.hour): [hour they ARRIVE, stop]. Names, looks and lines are in src/game/townsfolk.ts.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

// poi: a business in the directory; at: a fixed point; home: a house lot near that business (front yard).
const CAST = [
  { id: 'mabel', stops: { home: { home: 'Crumbs Accepted Bakery & Deli' }, shop: { poi: 'Crumbs Accepted Bakery & Deli' }, cafe: { poi: 'Table for Maybe Cafe' }, salon: { poi: 'Bad Bangs Hair Studio' } },
    sched: [[6, 'shop'], [9.5, 'cafe'], [12, 'shop'], [16.5, 'salon'], [18.5, 'home']] },
  { id: 'harlan', stops: { home: { home: 'Tepid Falls Depot (Trains, In Principle)' }, jetty: { at: [289, -1693] }, depot: { poi: 'Tepid Falls Depot (Trains, In Principle)' }, pub: { poi: 'The Hog Wallow Pub' } },
    sched: [[7, 'jetty'], [11.5, 'depot'], [13, 'jetty'], [17, 'pub'], [20, 'home']] },
  { id: 'winnie', stops: { home: { home: 'Tepid Falls Depot (Trains, In Principle)' }, bank: { at: [310, -1850] }, square: { poi: 'Quorum Square' } },
    sched: [[7, 'bank'], [9.5, 'square'], [12, 'bank'], [15, 'home'], [17.5, 'square'], [19.5, 'home']] },
  { id: 'ambrose', stops: { home: { poi: 'Oz-Born House' }, coffee: { poi: 'Mild Brew Coffeehouse' }, hall: { poi: 'Shrug Hall' }, lunch: { poi: 'Pennywhistle Dining Hall of Mystery Meat' }, lecture: { poi: 'Procrastination Hall' } },
    sched: [[8.5, 'coffee'], [9.8, 'hall'], [12, 'lunch'], [13.5, 'lecture'], [16, 'hall'], [17.5, 'home']] },
  { id: 'gus', stops: { home: { home: 'Lackwool Mill' }, dam: { at: [278, -1600] }, jetty: { at: [289, -1693] } },
    sched: [[5.5, 'dam'], [12, 'jetty'], [14.5, 'dam'], [19, 'home']] },
  { id: 'ines', stops: { home: { home: 'Lost-and-Found Consignment' }, shop: { poi: 'Lost-and-Found Consignment' }, square: { poi: 'Quorum Square' }, bus: { at: [172, -1809] } },
    sched: [[8.5, 'shop'], [12, 'square'], [14, 'shop'], [17.5, 'bus'], [20.2, 'home']] },
  { id: 'tamsin', stops: { home: { home: 'Waiting Room Health Group' }, clinic: { poi: 'Waiting Room Health Group' }, shop: { poi: 'Bargain Brigadier Variety' } },
    sched: [[8.5, 'home'], [17.5, 'shop'], [19, 'clinic']] },
  { id: 'cornelius', stops: { home: { home: 'The Hall of Unfinished Toasts' }, hall: { poi: 'The Hall of Unfinished Toasts' }, cafe: { poi: 'Hush-Hush Cafe & Deli' }, tribunal: { poi: 'Tepid Falls Tribunal of Mild Grievances' }, pizza: { poi: 'Slightly Burnt Pizza' } },
    sched: [[8.5, 'hall'], [12, 'cafe'], [13.5, 'hall'], [16.5, 'tribunal'], [19, 'pizza'], [21.5, 'home']] },
  { id: 'beppo', stops: { home: { home: 'The Dead Letter Office' }, office: { poi: 'The Dead Letter Office' }, clinic: { poi: 'Low Expectations Clinic' }, cafe: { poi: 'Hush-Hush Cafe & Deli' }, table: { poi: 'Table for Maybe Cafe' } },
    sched: [[7, 'office'], [9.5, 'clinic'], [12, 'cafe'], [15, 'table'], [17.5, 'office'], [19, 'home']] },
  { id: 'lena', stops: { home: { home: 'Brewed Under Protest' }, cafe: { poi: 'Brewed Under Protest' }, market: { poi: 'Sirloin Subcommittee Meat Market (Downtown)' }, friend: { poi: 'Hush-Hush Cafe & Deli' } },
    sched: [[6.5, 'cafe'], [10.8, 'market'], [13.2, 'cafe'], [16.3, 'friend'], [19.2, 'home']] },
  { id: 'jo', stops: { home: { poi: 'Doting Apartments' }, books: { poi: 'Dithers Bookstore & Overpriced Hoodies' }, lecture: { poi: 'Procrastination Hall' }, dining: { poi: 'Quibble Dining Hall' }, library: { poi: 'The Overdue Library' } },
    sched: [[8, 'books'], [9.8, 'lecture'], [12, 'dining'], [14.5, 'library'], [19.5, 'home']] },
  { id: 'walt', stops: { home: { home: 'The Hog Wallow Pub' }, pub: { poi: 'The Hog Wallow Pub' }, grocer: { poi: 'Bargain Brigadier Variety' } },
    sched: [[10, 'pub'], [13, 'grocer'], [15.5, 'pub'], [23.5, 'home']] },
];

const t = await boot({ query: 'net=0&stage=4', width: 800, height: 450 });
const r = await t.page.evaluate(`(async () => {
  const G = window.__game.game;
  const P = await import('/src/world/plan.ts');
  const sg = G.plan.streets, col = G.col, gA = P.groundAt;
  const CAST = ${JSON.stringify(CAST)};
  const places = G.todo.places();
  const CELL = 1.5;
  const wall = (x, z, y) => col.pointBlocked(x, z, y + 0.4) || col.pointBlocked(x, z, y + 1.0) || col.pointBlocked(x, z, y + 1.7);
  const ring = [[0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]];
  const hard = (x, z) => {
    const y = gA(x, z);
    if (P.isWater(x, z) || y < P.WATER_Y + 0.3) return true;
    if (wall(x, z, y)) return true;
    for (const [a, b] of ring) if (wall(x + a, z + b, gA(x + a, z + b))) return true;
    let sl = 0; for (const [a, b] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) sl = Math.max(sl, Math.abs(gA(x + a, z + b) - y));
    return sl > 0.6;
  };
  // A lane: inside the paved width of an edge. A roundabout's pad (its ring, kerb and walk) is wider than that: crossing it costs less.
  const inRoad = (x, z) => {
    if (z < -900 && sg.clearOfRoads(x, z, 0.1)) return false;
    const n = sg.nearestEdge(x, z); return n.d < n.edge.hw + 0.1;
  };
  const inPad = (x, z) => z < -900 && !sg.clearOfRoads(x, z, 0.1) && !inRoad(x, z);
  const near = (x, z) => { for (const [a, b] of [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) if (wall(x + a, z + b, gA(x + a, z + b))) return true; return false; };
  const open = (x, z) => { let n = 0; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, qx = x + Math.cos(a) * 2.2, qz = z + Math.sin(a) * 2.2; if (!hard(qx, qz) && !inRoad(qx, qz)) n++; } return n >= 5; };
  // Snap to the nearest open, dry, off-road cell, by growing rings.
  const snap = (x0, z0, maxR = 24) => {
    for (let rr = 0; rr <= maxR; rr += 1) {
      let best = null, bd = 1e9;
      const n = Math.max(1, Math.round(rr * 8));
      for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2, x = x0 + Math.cos(a) * rr, z = z0 + Math.sin(a) * rr;
        if (hard(x, z) || inRoad(x, z) || !open(x, z)) continue;
        const d = Math.hypot(x - x0, z - z0); if (d < bd) { bd = d; best = [x, z]; }
      }
      if (best) return best;
    }
    return null;
  };
  const usedLots = new Set();
  const out = [], problems = [];
  // The lots, near a business: the front yard of the closest one not already somebody's home.
  const lotHome = (x, z) => {
    let best = -1, bd = 1e9;
    sg.lots.forEach((l, i) => { if (usedLots.has(i) || !(l.district)) return; const d = Math.hypot(l.cx - x, l.cz - z); if (d >= 22 && d < bd && z < -900 === l.cz < -900) { bd = d; best = i; } });
    if (best < 0) return null;
    usedLots.add(best);
    const l = sg.lots[best], f = l.d / 2 + 2.2;
    return [l.cx + Math.sin(l.h) * f, l.cz + Math.cos(l.h) * f, l.h];
  };
  const poiAt = (name) => { const p = places.find((q) => q.name === name); if (!p) throw new Error('no place ' + name); return p; };
  // A*
  const route = (a, b) => {
    for (const margin of [50, 120, 260]) {
      const x0 = Math.min(a[0], b[0]) - margin, x1 = Math.max(a[0], b[0]) + margin, z0 = Math.min(a[1], b[1]) - margin, z1 = Math.max(a[1], b[1]) + margin;
      const W = Math.ceil((x1 - x0) / CELL) + 1, H = Math.ceil((z1 - z0) / CELL) + 1;
      const cx = (i) => x0 + i * CELL, cz = (j) => z0 + j * CELL;
      const info = new Int8Array(W * H); // 0 unknown, 1 open, 2 road, 3 hard, 4 near wall
      const kind = (i, j) => { const k = j * W + i; let v = info[k]; if (v) return v; const x = cx(i), z = cz(j); v = hard(x, z) ? 3 : inRoad(x, z) ? 2 : inPad(x, z) ? 5 : near(x, z) ? 4 : 1; info[k] = v; return v; };
      const si = Math.round((a[0] - x0) / CELL), sj = Math.round((a[1] - z0) / CELL), ei = Math.round((b[0] - x0) / CELL), ej = Math.round((b[1] - z0) / CELL);
      const g = new Float32Array(W * H).fill(1e9), from = new Int32Array(W * H).fill(-1), closed = new Uint8Array(W * H);
      const heap = []; const push = (k, f) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, rr = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top[1]; };
      const sk = sj * W + si, ek = ej * W + ei;
      g[sk] = 0; push(sk, Math.hypot(si - ei, sj - ej));
      let found = false;
      while (heap.length) {
        const k = pop(); if (closed[k]) continue; closed[k] = 1;
        if (k === ek) { found = true; break; }
        const i = k % W, j = (k / W) | 0;
        for (let d = 0; d < 8; d++) {
          const di = [1, -1, 0, 0, 1, 1, -1, -1][d], dj = [0, 0, 1, -1, 1, -1, 1, -1][d];
          const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const nk = nj * W + ni; if (closed[nk]) continue;
          const kd = kind(ni, nj); if (kd === 3 && nk !== ek) continue;
          if (di && dj && (kind(i + di, j) === 3 || kind(i, j + dj) === 3)) continue;
          const step = Math.hypot(di, dj) * (kd === 2 ? 30 : kd === 5 ? 3 : kd === 4 ? 1.5 : 1);
          const ng = g[k] + step;
          if (ng < g[nk]) { g[nk] = ng; from[nk] = k; push(nk, ng + Math.hypot(ni - ei, nj - ej)); }
        }
      }
      if (!found) continue;
      const pts = []; for (let k = ek; k >= 0; k = from[k]) { pts.push([cx(k % W), cz((k / W) | 0)]); if (k === sk) break; }
      pts.reverse(); pts[0] = a.slice(); pts[pts.length - 1] = b.slice();
      return pts;
    }
    return null;
  };
  const okSeg = (p, q) => { const L = Math.hypot(q[0] - p[0], q[1] - p[1]); const n = Math.max(1, Math.ceil(L / 0.5)); for (let k = 0; k <= n; k++) { const f = k / n, x = p[0] + (q[0] - p[0]) * f, z = p[1] + (q[1] - p[1]) * f; if (hard(x, z)) return false; } return true; };
  // Simplify: greedily jump to the farthest point reachable in a straight, wall-free line that does not add road metres.
  const roadM = (p, q) => { const L = Math.hypot(q[0] - p[0], q[1] - p[1]); const n = Math.max(1, Math.ceil(L / 0.75)); let c = 0; for (let k = 0; k <= n; k++) { const f = k / n; if (inRoad(p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)) c++; } return c * L / n; };
  const simplify = (pts) => {
    const out = [pts[0]]; let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) {
        if (!okSeg(pts[i], pts[j])) continue;
        let was = 0; for (let k = i; k < j; k++) was += roadM(pts[k], pts[k + 1]);
        if (roadM(pts[i], pts[j]) <= was + 0.5) break;
      }
      out.push(pts[j]); i = j;
    }
    return out;
  };
  const len = (pts) => { let L = 0; for (let k = 0; k + 1 < pts.length; k++) L += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); return L; };

  for (const c of CAST) {
    const ids = Object.keys(c.stops), stops = {};
    for (const id of ids) {
      const s = c.stops[id]; let raw, face = 0, name = id;
      if (s.poi) { const p = poiAt(s.poi); raw = [p.x, p.z]; name = p.name; face = null; stops[id] = { raw, fx: p.x, fz: p.z, name }; }
      else if (s.at) { raw = s.at; stops[id] = { raw, fx: null, name: id }; }
      else { const h = lotHome(poiAt(s.home).x, poiAt(s.home).z); if (!h) { problems.push(c.id + ' ' + id + ': no lot'); continue; } stops[id] = { raw: [h[0], h[1]], fx: null, fh: h[2], name: 'home' }; }
    }
    const idx = {}; const list = [];
    for (const id of ids) {
      const s = stops[id]; if (!s) continue;
      const q = snap(s.raw[0], s.raw[1]);
      if (!q) { problems.push(c.id + ' ' + id + ': no walkable ground near ' + s.raw.map(Math.round)); continue; }
      let face = s.fh !== undefined ? s.fh + Math.PI : 0;
      if (s.fx !== null && s.fx !== undefined) { const dx = s.fx - q[0], dz = s.fz - q[1]; if (Math.hypot(dx, dz) > 1.5) face = Math.atan2(dx, dz); }
      idx[id] = list.length;
      list.push({ id, name: s.name, x: Math.round(q[0] * 10) / 10, z: Math.round(q[1] * 10) / 10, face: Math.round(face * 100) / 100, snapped: Math.round(Math.hypot(q[0] - s.raw[0], q[1] - s.raw[1])) });
    }
    const sched = c.sched.map(([h, id]) => [h, idx[id]]); if (sched.some((s) => s[1] === undefined)) { problems.push(c.id + ': missing stop'); }
    const legs = [];
    for (let k = 0; k < sched.length; k++) {
      const A = list[sched[k][1]], B = list[sched[(k + 1) % sched.length][1]];
      if (!A || !B) { legs.push([]); continue; }
      if (A === B) { legs.push([A.x, A.z]); continue; }
      const raw = route([A.x, A.z], [B.x, B.z]);
      if (!raw) { problems.push(c.id + ' leg ' + A.id + '>' + B.id + ': no route'); legs.push([A.x, A.z, B.x, B.z]); continue; }
      let pts = simplify(raw);
      const flat = []; for (const p of pts) flat.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
      let bad = 0; for (let m = 0; m + 3 < flat.length; m += 2) if (!okSeg([flat[m], flat[m + 1]], [flat[m + 2], flat[m + 3]])) bad++;
      if (bad) problems.push(c.id + ' leg ' + A.id + '>' + B.id + ': ' + bad + ' segments touch a wall');
      legs.push(flat);
    }
    out.push({ id: c.id, stops: list, sched, legs, lens: legs.map((f) => { const p = []; for (let m = 0; m < f.length; m += 2) p.push([f[m], f[m + 1]]); return Math.round(len(p)); }) });
  }
  return { out, problems };
})()`);

for (const p of r.out) console.log(p.id.padEnd(10), 'stops', p.stops.map((s) => `${s.id}(${s.x},${s.z}${s.snapped > 3 ? ' snap' + s.snapped : ''})`).join(' '), '\n           legs m', p.lens.join(' '), ' sched', p.sched.map((s) => s[0]).join(','));
console.log(r.problems.length ? 'PROBLEMS:\n' + r.problems.join('\n') : 'no problems');
if (process.argv.includes('--write') && !r.problems.length) {
  const num = (a) => '[' + a.join(', ') + ']';
  const body = r.out.map((p) => `  { id: '${p.id}',
    stops: [${p.stops.map((s) => `{ id: '${s.id}', name: ${JSON.stringify(s.name)}, x: ${s.x}, z: ${s.z}, face: ${s.face} }`).join(',\n      ')}],
    sched: [${p.sched.map((s) => `[${s[0]}, ${s[1]}]`).join(', ')}],
    legs: [${p.legs.map(num).join(',\n      ')}] }`).join(',\n');
  fs.writeFileSync('src/game/townsfolkData.ts', `// Fun queue 2, item 30: where the named townsfolk go. Generated by tools/townsfolk/gen.mjs (real businesses and house lots, every stop on open
// dry ground outside every wall and off the paved road, every leg routed over the same ground). The game reads this, it never re-derives it.
// sched: [hour of arrival on the town clock, stop index]; the day wraps from the last entry to the first. legs[k] runs from sched[k]'s stop to
// the next entry's (flat x, z pairs, both ends included).

export interface TfStop { id: string; name: string; x: number; z: number; face: number }
export interface TfRoute { id: string; stops: TfStop[]; sched: [number, number][]; legs: number[][] }

export const TF_ROUTES: TfRoute[] = [
${body},
];
`);
  console.log('wrote src/game/townsfolkData.ts');
}
await t.close();
