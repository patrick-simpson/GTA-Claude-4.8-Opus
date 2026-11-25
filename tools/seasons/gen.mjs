// Fun queue 2, item 34: where the seasons' fixtures go. Generated into src/world/seasonData.ts (run with --write).
//
//   node tools/seasons/gen.mjs            prints the picked spots
//   node tools/seasons/gen.mjs --write    also writes the lists into src/world/seasonData.ts (between the GENERATED markers)
//
// Boots the real world (net=0) and looks for flat dry ground clear of walls and of the paved road at a few anchor places:
//   ICE     summer ice-cream stands: the pier's deck, the downtown sidewalk, Mercy Park, Quorum Square, Main St of Tepid Falls
//   PUMPKIN fall harvest stands: Mercy Park, Quorum Square, the country verges
//   VIEW    leaf-peeper pull-offs: the highest verges beside the country roads
//   BOATS   summer sailboats: circles of open water in the harbour, each ringed by water all round
// The game reads the fixed list, it never re-derives it, so every browser puts the same things in the same places.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

const t = await boot({ query: 'net=0&stage=4', width: 800, height: 450 });
const r = await t.page.evaluate(`(async () => {
  const G = window.__game.game;
  const P = await import('/src/world/plan.ts');
  const PD = await import('/src/world/dithersPond.ts');
  const RW = await import('/src/world/railway.ts');
  const sg = G.plan.streets, col = G.col, gA = P.groundAt;
  const walls = (x, z) => { const y = gA(x, z); return col.pointBlocked(x, z, y + 0.5) || col.pointBlocked(x, z, y + 2.5) || col.pointBlocked(x, z, y + 5); };
  const boxesNear = (x, z, r) => { let n = 0; col.forBoxes(x, z, r, () => { n++; }); return n; };
  const propsNear = (x, z, r) => { let n = 0; col.forProps(x, z, r, () => { n++; }); return n; };
  const flat = (x, z, rr, tol) => { const y = gA(x, z); for (const [a, b] of [[rr,0],[-rr,0],[0,rr],[0,-rr]]) if (Math.abs(gA(x + a, z + b) - y) > tol) return false; return true; };
  const dry = (x, z) => !P.isWater(x, z) && PD.pondSD(x, z) > 1.5 && gA(x, z) > P.WATER_Y + 0.4;
  const ok = (x, z, rc = 1.8, road = 0.4) => dry(x, z) && !walls(x, z) && flat(x, z, 1.3, 0.3) && boxesNear(x, z, rc) === 0 && propsNear(x, z, 1.3) === 0 && sg.clearOfRoads(x, z, road);
  // Face the nearest road.
  const faceRoad = (x, z) => { const n = sg.nearestEdge(x, z, (e) => !e.deck); const p = sg.project(n.edge, x, z), c = sg.pointAt(n.edge, p.s); return Math.atan2(c.x - x, c.z - z); };
  const found = (ax, az, maxR, pred, skip) => {
    for (let rr = 0; rr <= maxR; rr += 1.5) for (let k = 0, n = Math.max(1, Math.round(rr * 1.2)); k < n; k++) {
      const a = k / n * Math.PI * 2 + rr, x = ax + Math.cos(a) * rr, z = az + Math.sin(a) * rr;
      if (pred(x, z) && skip.every((s) => Math.hypot(s[0] - x, s[1] - z) > 18)) return [Math.round(x * 10) / 10, Math.round(z * 10) / 10, Math.round(faceRoad(x, z) * 100) / 100];
    }
    return null;
  };
  const down = G.plan.sidewalkPoint(5, 4, 2, 0.5), down2 = G.plan.sidewalkPoint(3, 5, 0, 0.5);
  const out = { ice: [], pumpkin: [], view: [], boats: [] };
  const taken = [];
  // On the pier: the deck's two edges (no road there, so the spots are fixed by hand, checked against walls and props).
  for (const [x, z, h] of [[6.2, 478, -1.57], [-6.2, 540, 1.57]]) { out.ice.push([x, z, h]); taken.push([x, z]); }
  for (const [ax, az] of [[down.x, down.z], [245, -167], [131, -1808], [60, -1900], [250, -1700], [170, -2124], [-380, -2256], [down2.x, down2.z]]) { const s = found(ax, az, 80, ok, taken); if (s) { out.ice.push(s); taken.push(s); } }
  for (const [ax, az] of [[255, -150], [118, -1800], [160, -1830], [-612, -1160], [-40, -2100]]) { const s = found(ax, az, 45, ok, taken); if (s) { out.pumpkin.push(s); taken.push(s); } }
  // Leaf-peeper pull-offs: beside a country road, on rising ground.
  const cands = [];
  for (const e of sg.edges) {
    if (e.land !== 1 || e.deck || e.len < 60) continue;
    for (let s = 20; s < e.len - 20; s += 30) {
      const c = sg.pointAt(e, s);
      for (const sd of [-1, 1]) {
        const off = e.hw + 5.5, x = c.x - c.dz * sd * off, z = c.z + c.dx * sd * off;
        if (z > -900 || gA(x, z) < 6 || RW.railNear(x, z, 30) || !ok(x, z, 3.5, 3.2) || !flat(x, z, 2.6, 0.45)) continue;
        let hh = 0; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; hh += gA(x + Math.cos(a) * 70, z + Math.sin(a) * 70); }
        cands.push([x, z, Math.atan2(c.dx, c.dz), gA(x, z) - hh / 8, gA(x, z)]);
      }
    }
  }
  cands.sort((a, b) => b[3] - a[3]);
  for (const q of cands) { if (out.view.length >= 3) break; if (out.view.every((v) => Math.hypot(v[0] - q[0], v[1] - q[1]) > 350)) out.view.push([Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, Math.round(q[2] * 100) / 100]); }
  // Hand-picked (looked at in the game): the verge by the park on the river road, which the height search cannot see. The pond lookout is added in code.
  out.view.push([413.1, -1779.6, 1.43]);
  // Sailboats: open water in the harbour, ringed by water at r + 8.
  for (const [cx, cz, rr] of [[140, 520, 28], [-130, 540, 30], [210, 600, 24], [-200, 610, 26], [70, 725, 30], [-70, 700, 26], [280, 480, 22], [-290, 480, 22], [0, 770, 26], [150, 700, 20], [-150, 720, 20], [330, 560, 18], [-330, 570, 18], [250, 650, 18]]) {
    let okc = true;
    for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; for (const m of [rr + 8, rr - 6]) if (gA(cx + Math.cos(a) * m, cz + Math.sin(a) * m) > P.WATER_Y - 1.2) okc = false; }
    if (Math.abs(cx) < 70 && cz < 700) okc = false;
    out.boats.push([cx, cz, rr, okc ? 1 : 0]);
  }
  return out;
})()`);
console.log(JSON.stringify(r));
if (process.argv.includes('--write')) {
  const f = 'src/world/seasonData.ts';
  let s = fs.readFileSync(f, 'utf8');
  const crlf = s.includes('\r\n'); s = s.replace(/\r\n/g, '\n');
  const fmt = (a) => '[' + a.map((q) => '[' + q.join(', ') + ']').join(', ') + ']';
  const T = 'readonly (readonly [number, number, number])[]';
  const body = `// GENERATED by tools/seasons/gen.mjs: x, z, heading (facing the road)\nexport const ICE_SPOTS: ${T} = ${fmt(r.ice)};\nexport const PUMPKIN_SPOTS: ${T} = ${fmt(r.pumpkin)};\nexport const VIEW_SPOTS: ${T} = ${fmt(r.view)};\n// centre x, z, radius of the circle a boat sails\nexport const BOAT_RINGS: ${T} = ${fmt(r.boats.filter((b) => b[3]).map((b) => b.slice(0, 3)))};\n`;
  s = s.replace(/\/\/ <GENERATED>[\s\S]*\/\/ <\/GENERATED>/, `// <GENERATED>\n${body}// </GENERATED>`);
  fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log('wrote', f);
}
await t.close();
process.exit(0);
