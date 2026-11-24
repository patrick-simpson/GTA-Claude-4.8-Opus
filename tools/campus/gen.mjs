// node scratch/campus/tools/gen.mjs : OSM (items.json, TPS-warped) -> tools/briefs/dithers-campus-plan.json + src/world/dithersPlan.ts
import fs from 'node:fs';
import { makeTPS } from './tps.mjs';
const ROOT = new URL('../../../', import.meta.url);
const rd = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const { items } = JSON.parse(rd('scratch/campus/osm/items.json'));
const T = makeTPS(0.002, 1000);
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

// ── Names, styles and floors (real name -> game name; style; floors; extras) ──
// style: geo = Georgian Revival brick, gable slate roof, white cornice; flat = brick, flat roof; glass = modern glass/metal;
//        arena = big metal-and-glass athletics hall; plant = utility; stand = grandstand
const B = {
  'Miller Library': ['The Overdue Library', 'geo', 4, { tower: 'library', portico: 1 }],
  'Lorimer Chapel': ['Chapel of Second Thoughts', 'geo', 1, { tower: 'chapel', nave: 11 }],
  'Colby College Museum of Art': ['Museum of Ambiguous Art', 'museum', 2, {}],
  'Bixler Music & Art Center': ['Bickering Hall (music and art)', 'geo', 3, { cupola: 1 }],
  'Gordon Center For Creative & Performing Arts': ['Stage Fright Center for the Performing Arts', 'glass', 3, {}],
  'Cotter Union': ['Clutter Union', 'geo', 3, {}],
  'Roberts Union': ['Rebuttal Union', 'geo', 3, { cupola: 1 }],
  'Runnals Union': ['Runaround Union', 'geo', 3, { cupola: 1 }],
  'Diamond': ['Rough Diamond Hall', 'geo', 4, { cupola: 1 }],
  'Davis': ['Devise Science Center', 'flat', 4, {}],
  'Lovejoy': ['Lovesick Hall', 'geo', 3, { cupola: 1 }],
  'Eustis': ['Red Tape Hall (administration)', 'geo', 3, { cupola: 1 }],
  'Keyes': ['Keyless Science Hall', 'geo', 4, {}],
  'Arey': ['Awry Science Hall', 'geo', 4, {}],
  'Seeley G. Mudd': ['Mudd-ish Science Hall', 'flat', 3, {}],
  'F. W. Olin': ['F.Y.I. Science Center', 'flat', 3, {}],
  'Lunder': ['Blunder House (admissions)', 'geo', 2, {}],
  'Schair-Swenson-Watson Alumni Center': ['Swansong Alumni Center', 'geo', 2, { cupola: 1 }],
  'Grossman': ['Grossly Hall', 'geo', 3, {}],
  'Garrison-Foster': ['Gauze-Foster Health Center', 'geo', 2, {}],
  'Foss': ['Fuss Hall', 'geo', 3, { cupola: 1 }],
  'Woodman': ['Wouldn\'t-Man Hall', 'geo', 3, {}],
  'Mary Low': ['Mary Lowkey Hall', 'geo', 3, {}],
  'Coburn': ['Cold Burn Hall', 'geo', 3, {}],
  'Dana': ['Dawdle Hall', 'flat', 4, {}],
  'Heights': ['The Hesitant Heights', 'flat', 4, {}],
  'Alfond': ['All Fond Apartments', 'geo', 3, {}],
  'Johnson Pond 1': ['Ponder Hall 1', 'geo', 2, {}], 'Johnson Pond 2': ['Ponder Hall 2', 'geo', 2, {}],
  'Johnson Pond 3': ['Ponder Hall 3', 'geo', 2, {}], 'Johnson Pond 4': ['Ponder Hall 4', 'geo', 2, {}],
  'West Quad': ['West Squabble', 'geo', 3, {}], 'East Quad': ['East Squabble', 'geo', 3, {}],
  'Johnson': ['Jonesing Hall', 'geo', 4, {}],
  'Piper': ['Pied Piper Hall', 'geo', 3, {}], 'Drummond': ['Drumroll Hall', 'geo', 3, {}], 'Pierce': ['Pierced Hall', 'geo', 3, {}],
  'Perkins-Wilson': ['Perky-Wilson Hall', 'geo', 3, {}], 'Goddard-Hodgkins': ['Odd-Hodge Hall', 'geo', 3, {}], 'Treworgy': ['Tree-Worry Hall', 'geo', 3, {}],
  'Williams': ['Willy-Nilly Hall', 'geo', 3, {}], 'Marriner': ['Mariner Hall', 'geo', 3, {}], 'Leonard': ['Lean-On Hall', 'geo', 3, {}],
  'Sturtevant': ['Sturdy-Vent Hall', 'geo', 3, {}], 'Taylor': ['Tailor Hall', 'geo', 3, {}],
  'Anthony': ['Ant Hill Hall', 'flat', 3, {}], 'Mitchel': ['Mitch-Mash Hall', 'flat', 3, {}], 'Schupf': ['Shove Hall', 'flat', 3, {}],
  'Osborne House': ['Oz-Born House', 'geo', 2, {}],
  'Harold Alfond Athletic and Recreation Center': ['The Halfhearted Athletic Center', 'arena', 3, {}],
  'Facilities Services': ['Department of Broken Things', 'plant', 2, {}],
  'Steam station': ['The Hot Air Plant', 'plant', 2, {}], 'Biomass station': ['The Wood Chip Plant', 'plant', 2, {}],
};
const F = {
  'Harold Alfond Stadium': 'Halfhearted Stadium', 'Seaverns Field': 'Several Field (football, inside the track)',
  'Coombs Baseball Field': 'Combs Field (baseball)', 'Bill Alfond Field': 'Bill Halfhearted Field (soccer)',
  'Mark J. Serdjenian Field': 'Sergeant Field (soccer)', 'Colby Softball Field': 'Softish Field (softball)',
  'Runnals Field': 'Runaround Field', 'Practice Field': 'Practice Makes Field', 'Alfond-Wales Tennis Courts': 'Whale\'s Tennis Courts',
  'Johnson Pond': 'Ponder Pond',
};
const DRIVES = { 'Alumni Drive': 'Alumni Sigh Drive', 'Cotter Drive': 'Clutter Drive', 'Pond Drive': 'Ponder Drive', 'Bixler Drive': 'Bickering Drive',
  'Runnals Drive': 'Runaround Drive', 'Senior Drive': 'Senior Moment Drive', 'Senoir Drive': 'Senior Moment Drive', 'Garden Road': 'Weed Rd',
  'Hillhouse Drive': 'Hill Hesitation Dr', 'Quarry Road': 'Query Rd', 'Solar Way': 'Partly Sunny Way', 'Big Sky Lane': 'Big Sigh Lane', 'Lowell Heights Drive': 'Lowly Heights Dr' };

// ── The window the campus is cut from (game metres) ──
const WIN = { x0: -650, x1: -225, z0: -2720, z1: -2195 };
const inWin = ([x, z]) => x > WIN.x0 && x < WIN.x1 && z > WIN.z0 && z < WIN.z1;

// ── Game roads from streetData.ts ──
const sd = rd('src/world/streetData.ts');
const roads = [];
for (const m of sd.matchAll(/"name":"([^"]+)","kind":"([^"]+)","lanes":(\d+),"oneWay":(true|false),"divided":(true|false).*?"pts":\[([^\]]+)\]/g)) {
  const p = m[6].split(',').map(Number), pts = []; for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  // Half the paved width exactly as streets.ts roadHW has it, plus the 3.5 m sidewalk (the old guess was 1.5-3 m too narrow for streets and arterials).
  const dv = m[5] === 'true', hw = (m[2] === 'highway' ? 12 : m[2] === 'ramp' ? 4.5 : +m[3] >= 2 ? (dv ? 11 : 10) : m[4] === 'true' ? 5 : m[2] === 'arterial' ? (dv ? 7.5 : 7) : 6) + 3.5;
  roads.push({ name: m[1], kind: m[2], hw, pts });
}
const segd = (p, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1]; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1); t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz); };
/** Distance from a point to a convex quad (0 inside). */
const dPoly = (p, q) => { let best = 1e9, pos = true, neg = true; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; best = Math.min(best, segd(p, a, b)); const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (c < 0) pos = false; if (c > 0) neg = false; } return pos || neg ? 0 : best; };
/** True when no road (with its sidewalk and margin m) touches or crosses the quad: roads are sampled every 1.5 m. */
const roadClearOfQuad = (q, m) => { for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) { const a = r.pts[i], b = r.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.5)); for (let k = 0; k <= n; k++) if (dPoly([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], q) < r.hw + m) return false; } return true; };
const roadClear = (p, m) => { for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) if (segd(p, r.pts[i], r.pts[i + 1]) < r.hw + m) return false; return true; };
// Campus drives (OSM roads the street graph does not have), collected early so buildings keep off them too.
const drives = [];
for (const o of items) {
  const t = o.t; if (!inWin(o.g)) continue;
  if (t.highway && ['unclassified', 'service', 'residential'].includes(t.highway) && !['parking_aisle', 'driveway', 'drive-through'].includes(t.service) && t.name !== 'Mayflower Hill Drive' && t.name !== 'Campus Drive') {
    const pts = o.real.map(T);
    const inCore = pts.filter(p => p[0] > -640 && p[0] < -280 && p[1] > -2665 && p[1] < -2240).length / pts.length;
    const free = pts.filter(p => roadClear(p, -2)).length / pts.length;
    if (free < 0.6 || inCore < 0.7) continue;
    drives.push({ osm: o.id, real: t.name || null, name: DRIVES[t.name] || null, pts: pts.map(p => p.map(r1)) });
  }
}
const driveClear = (p, m) => { for (const d of drives) for (let i = 0; i < d.pts.length - 1; i++) if (segd(p, d.pts[i], d.pts[i + 1]) < 3.5 + m) return false; return true; };

// ── Geometry helpers ──
function obb(poly) { // min-area oriented box: {cx,cz,w,d,a} with w along angle a
  let best = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = Math.atan2(poly[i + 1][1] - poly[i][1], poly[i + 1][0] - poly[i][0]), c = Math.cos(a), s = Math.sin(a);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const [x, z] of poly) { const u = x * c + z * s, v = -x * s + z * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const ar = (u1 - u0) * (v1 - v0);
    if (!best || ar < best.ar) { const um = (u0 + u1) / 2, vm = (v0 + v1) / 2; best = { ar, a, cx: um * c - vm * s, cz: um * s + vm * c, w: u1 - u0, d: v1 - v0 }; }
  }
  // keep w the long side
  if (best.d > best.w) { [best.w, best.d] = [best.d, best.w]; best.a += Math.PI / 2; }
  best.a = Math.atan2(Math.sin(best.a), Math.cos(best.a)); if (best.a > Math.PI / 2) best.a -= Math.PI; if (best.a < -Math.PI / 2) best.a += Math.PI;
  return best;
}
const inPoly = (x, z, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
// Decompose a polygon into up to `max` rects in its OBB frame (raster 0.5 m, greedy largest rectangle).
function decompose(poly, max = 6) {
  const o = obb(poly), c = Math.cos(o.a), s = Math.sin(o.a), R = 0.5;
  const nu = Math.max(1, Math.round(o.w / R)), nv = Math.max(1, Math.round(o.d / R));
  const g = []; let total = 0;
  for (let j = 0; j < nv; j++) { g.push(new Uint8Array(nu)); for (let i = 0; i < nu; i++) {
    const u = -o.w / 2 + (i + 0.5) * (o.w / nu), v = -o.d / 2 + (j + 0.5) * (o.d / nv);
    const x = o.cx + u * c - v * s, z = o.cz + u * s + v * c; if (inPoly(x, z, poly)) { g[j][i] = 1; total++; } } }
  const rects = []; let covered = 0;
  const minCells = Math.round(2.4 / R);
  for (let k = 0; k < max; k++) {
    // largest all-ones rectangle (histogram method) on cells still 1
    const h = new Int32Array(nu); let bestA = 0, bi = 0, bj = 0, bw = 0, bh = 0;
    for (let j = 0; j < nv; j++) { for (let i = 0; i < nu; i++) h[i] = g[j][i] === 1 ? h[i] + 1 : 0;
      const st = []; for (let i = 0; i <= nu; i++) { const hi = i < nu ? h[i] : 0; let start = i;
        while (st.length && st[st.length - 1][1] >= hi) { const [si, sh] = st.pop(); const wdt = i - si; if (sh >= minCells && wdt >= minCells && sh * wdt > bestA) { bestA = sh * wdt; bi = si; bj = j - sh + 1; bw = wdt; bh = sh; } start = si; }
        st.push([start, hi]); } }
    if (!bestA || (rects.length && bestA < total * 0.04)) break;
    for (let j = bj; j < bj + bh; j++) for (let i = bi; i < bi + bw; i++) g[j][i] = 2;
    covered += bestA;
    const u = -o.w / 2 + (bi + bw / 2) * (o.w / nu), v = -o.d / 2 + (bj + bh / 2) * (o.d / nv);
    rects.push({ u, v, w: bw * (o.w / nu), d: bh * (o.d / nv) });
    if (covered > total * 0.93) break;
  }
  return { o, rects, fill: covered / Math.max(1, total) };
}
const corners = (cx, cz, w, d, a) => { const c = Math.cos(a), s = Math.sin(a); return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + (i * w / 2) * c - (j * d / 2) * s, cz + (i * w / 2) * s + (j * d / 2) * c]); };
function sat(A, B) { // convex quads overlap?
  for (const P of [A, B]) for (let i = 0; i < 4; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % 4], nx = z0 - z1, nz = x1 - x0;
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9; for (const [x, z] of A) { const t = x * nx + z * nz; a0 = Math.min(a0, t); a1 = Math.max(a1, t); } for (const [x, z] of B) { const t = x * nx + z * nz; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
    if (a1 < b0 || b1 < a0) return false; }
  return true;
}

// ── Buildings ──
const SKIP = new Set(['house', 'garage', 'shed', 'roof', 'garages', 'carport']);
const blds = [];
for (const o of items) {
  const t = o.t; if (!t.building || !inWin(o.g)) continue;
  if (SKIP.has(t.building) && t.name !== 'Osborne House') continue;
  const name = t.name || '';
  const spec = B[name];
  if (!spec && (o.area < 380 || !name)) {
    if (t.building === 'grandstand') { /* stands kept below */ } else continue;
  }
  const poly = o.real.map(T);
  const dec = decompose(poly, spec && spec[3].tower ? 3 : 6);
  const kind = t.building === 'grandstand' ? 'stand' : null;
  const [gname, style, floors, extra] = spec || (kind ? ['Stands', 'stand', 1, {}] : [`(unnamed ${t.building})`, ['warehouse', 'industrial'].includes(t.building) ? 'plant' : 'geo', 2, {}]);
  const lv = +t['building:levels'] || 0;
  blds.push({ osm: o.id, real: name || null, name: gname, style, floors: lv && style !== 'arena' ? Math.max(lv, floors) : floors, extra, area_real: Math.round(o.area), poly, dec, E: style === 'stand' ? 1.2 : style === 'arena' ? 1.15 : 1.42 });
}
// The same name twice (Johnson's two wings): number them.
const seen = {}; for (const b of blds) { if (!b.real) continue; seen[b.real] = (seen[b.real] || 0) + 1; if (seen[b.real] > 1 || blds.filter(q => q.real === b.real).length > 1) b.name += ` (${seen[b.real] === 1 ? 'north' : 'south'} wing)`; }

const rectsOf = (b, E) => { const { o, rects } = b.dec, c = Math.cos(o.a), s = Math.sin(o.a);
  // scale about the building's own OBB centre
  return rects.map(r => ({ cx: o.cx + (r.u * E) * c - (r.v * E) * s, cz: o.cz + (r.u * E) * s + (r.v * E) * c, w: r.w * E, d: r.d * E, a: o.a })); };
const quadsOf = (b, E, grow = 0) => rectsOf(b, E).map(r => corners(r.cx, r.cz, r.w + grow, r.d + grow, r.a));
const clearRoads = (b, E) => quadsOf(b, E).every(q => roadClearOfQuad(q, 2.0)) && quadsOf(b, E).every(q => { for (let i = 0; i < 4; i++) { const a = q[i], c = q[(i + 1) % 4]; for (let k = 0; k <= 4; k++) { const p = [a[0] + (c[0] - a[0]) * k / 4, a[1] + (c[1] - a[1]) * k / 4]; if (!roadClear(p, 1.5) || (E > 1 && !driveClear(p, 0.5))) return false; } } return true; });
const dropped = [];
for (const b of blds) {
  while (b.E > 1.0 && !clearRoads(b, b.E)) b.E = r2(b.E - 0.04);
  if (!clearRoads(b, b.E)) { // nudge away from the nearest road, up to 14 m
    let ok = false;
    for (let step = 2; step <= 14 && !ok; step += 2) for (let k = 0; k < 8 && !ok; k++) { const a = k * Math.PI / 4, dx = Math.cos(a) * step, dz = Math.sin(a) * step;
      b.dec.o.cx += dx; b.dec.o.cz += dz; if (clearRoads(b, b.E)) { ok = true; b.nudged = [r1(dx), r1(dz)]; } else { b.dec.o.cx -= dx; b.dec.o.cz -= dz; } }
    if (!ok) { b.drop = 'on a game road'; dropped.push(b); }
  }
}
let live = blds.filter(b => !b.drop);
// Pairs that already touch at warp scale (wings of one block) may touch; others keep 2 m apart.
for (let pass = 0; pass < 30; pass++) {
  let any = false;
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const A = live[i], Bb = live[j];
    const touch0 = quadsOf(A, 1).some(p => quadsOf(Bb, 1).some(q => sat(p, q)));
    if (touch0) continue;
    if (quadsOf(A, A.E, 2).some(p => quadsOf(Bb, Bb.E, 2).some(q => sat(p, q)))) { any = true; if (A.E > 1 && !A.fixed) A.E = r2(A.E - 0.03); if (Bb.E > 1 && !Bb.fixed) Bb.E = r2(Bb.E - 0.03); }
  }
  if (!any) break;
}

// Drives give way to the buildings: cut a drive where it runs through one (the signature buildings keep their size).
const inQuad = (p, q) => { let sg = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (c === 0) continue; const k = c > 0 ? 1 : -1; if (sg && k !== sg) return false; sg = k; } return true; };
const allQ = live.flatMap(b => quadsOf(b, b.E, 4));
{ const keep = []; for (const d of drives) { let cur = []; const dense = []; for (let i = 0; i < d.pts.length - 1; i++) { const a = d.pts[i], b = d.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3)); for (let k = 0; k < n; k++) dense.push([r1(a[0] + (b[0] - a[0]) * k / n), r1(a[1] + (b[1] - a[1]) * k / n)]); } dense.push(d.pts[d.pts.length - 1]);
  for (const p of dense) { if (allQ.some(q => inQuad(p, q))) { if (cur.length > 2) keep.push({ ...d, pts: cur }); cur = []; } else cur.push(p); } if (cur.length > 2) keep.push({ ...d, pts: cur }); }
  drives.length = 0; drives.push(...keep); }
// ── Fields, pond, lots, paths, drives ──
const fields = [], lots = [], paths = [];
let pond = null;
for (const o of items) {
  const t = o.t; if (!inWin(o.g)) continue;
  if (t.natural === 'water' && t.name === 'Johnson Pond') pond = { real: 'Johnson Pond', name: F['Johnson Pond'], poly: o.real.map(T).map(p => p.map(r1)) };
  else if (t.leisure === 'pitch' && o.area > 2000 && t.sport !== 'tennis') {
    const poly = o.real.map(T), ob = obb(poly);
    fields.push({ osm: o.id, real: t.name || null, name: F[t.name] || `(${t.sport || 'playing'} field)`, sport: t.sport || 'multi', cx: r1(ob.cx), cz: r1(ob.cz), w: r1(ob.w), d: r1(ob.d), a: r2(ob.a), poly: poly.map(p => p.map(r1)) });
  } else if (t.leisure === 'sports_centre' && t.sport === 'tennis') {
    const ob = obb(o.real.map(T)); fields.push({ osm: o.id, real: t.name, name: F[t.name], sport: 'tennis', cx: r1(ob.cx), cz: r1(ob.cz), w: r1(ob.w), d: r1(ob.d), a: r2(ob.a) });
  } else if (t.amenity === 'parking' && o.area > 1500) {
    lots.push({ osm: o.id, real: t.name || null, poly: o.real.map(T).map(p => p.map(r1)) });
  } else if (t.highway && ['footway', 'path', 'pedestrian', 'steps'].includes(t.highway)) {
    const pts = o.real.map(T); let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    // campus walks only: inside the hill and its athletics, not the woods trails beyond
    const core = pts.filter(p => p[0] > -630 && p[0] < -290 && p[1] > -2600 && p[1] < -2250).length / pts.length;
    if (len > 6 && core > 0.8 && t.footway !== 'sidewalk') paths.push(pts.map(p => p.map(r1)));
  }
}
// Track: a 400 m-style oval round the football field inside the stadium, at the same scale as the field.
const foot = fields.find(f => f.sport === 'american_football');
const track = foot ? { cx: foot.cx, cz: foot.cz, a: foot.a, straight: r1(foot.w * 1.0), r_in: r1(foot.d / 2 + 0.5), lanes: 3, lane_w: 1.0 } : null;
// Roads (Chapel Hill Rd, Dithers Loop) came out through the track's outer lanes and a tennis court: the fields and the track move off
// the roads (searching up to 12 m round the OSM position, smallest move first, clear of every building and road, sidewalks included).
{ const qB = live.flatMap((b) => quadsOf(b, b.E, 1)); const trackQ = (T) => corners(T.cx, T.cz, T.straight + 2 * (T.r_in + T.lanes * T.lane_w + 1), 2 * (T.r_in + T.lanes * T.lane_w + 1), T.a);
  const ok = (q, m) => roadClearOfQuad(q, m) && !qB.some((r) => sat(q, r));
  const shift = (q0, mk) => { for (let st = 0; st <= 12; st += 1) for (let k = 0; k < (st ? 16 : 1); k++) { const an = k * Math.PI / 8, dx = Math.cos(an) * st, dz = Math.sin(an) * st; if (ok(mk(dx, dz), 0.5)) return [dx, dz]; } return null; };
  const capClear = (T, m, nb = false) => { const c = Math.cos(T.a), s = Math.sin(T.a), h = T.straight / 2, A = [T.cx - h * c, T.cz - h * s], B = [T.cx + h * c, T.cz + h * s], R = T.r_in + T.lanes * T.lane_w;
    for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) { const a = r.pts[i], b = r.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))); for (let k = 0; k <= n; k++) if (segd([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], A, B) < R + r.hw + m) return false; } return nb || !qB.some((q) => sat(trackQ(T), q)); };
  if (track) { let d = null; for (let st = 0; st <= 12 && !d; st += 1) for (let k = 0; k < (st ? 16 : 1) && !d; k++) { const an = k * Math.PI / 8, dx = Math.cos(an) * st, dz = Math.sin(an) * st; if (capClear({ ...track, cx: track.cx + dx, cz: track.cz + dz }, 0.3)) d = [dx, dz]; } if (!d && capClear(track, 0, true)) { console.log('track stays: its oval clears the roads, a stand corner touches the margin'); } else if (d) { track.cx = r1(track.cx + d[0]); track.cz = r1(track.cz + d[1]); foot.cx = track.cx; foot.cz = track.cz; console.log('track moved', d.map(r1)); } else console.log('TRACK STILL ON A ROAD'); }
  for (const f of fields) { if (f === foot) continue; const d = shift(0, (dx, dz) => corners(f.cx + dx, f.cz + dz, f.w + 2, f.d + 2, f.a)); if (d && (d[0] || d[1])) { f.cx = r1(f.cx + d[0]); f.cz = r1(f.cz + d[1]); console.log('field moved', f.name, d.map(r1)); } else if (!d) console.log('FIELD STILL ON A ROAD', f.name); } }

// ── Output ──
const out = {
  about: 'Dithers College (Port Calamity) after Colby College, Mayflower Hill, Waterville ME. Traced from OpenStreetMap (Overpass API, 2026-11-23, ODbL) through the street plan\'s thin-plate-spline warp (tools/briefs/tepid-streets-plan.json transform, smoothing 0.002), so it lines up with Chapel Hill Rd, Cherry Tree St, Dithers Loop and the two circles. Real names are for the lead only; the game shows game names.',
  scale: { positions: 'warp scale about 0.43 of real (centres and roads where OSM puts them)', footprints: 'each building enlarged about its own centre by E (1.0-1.42, shown per building) so walls read at about 0.55-0.6 of real; E is cut where it would hit a game road or a neighbour', heights: 'real: floors x 3.4 m; library tower 52 m, chapel spire 38 m' },
  site: { hill: { x0: -625, x1: -315, z0: -2568, z1: -2272, h: 12 }, window: WIN },
  buildings: live.map(b => ({ osm: b.osm, real: b.real, name: b.name, style: b.style, floors: b.floors, extra: b.extra, E: b.E, area_real_m2: b.area_real, nudged: b.nudged,
    rects: rectsOf(b, b.E).map(r => [r1(r.cx), r1(r.cz), r1(r.w), r1(r.d), r2(r.a)]) })),
  dropped: dropped.map(b => ({ real: b.real, name: b.name, why: b.drop })),
  fields, track, pond, lots, paths, campus_drives: drives,
  roads_not_in_street_graph: [...new Set(drives.map(d => d.real ? `${d.real} -> ${d.name}` : null).filter(Boolean))],
};
fs.writeFileSync(new URL('tools/briefs/dithers-campus-plan.json', ROOT), JSON.stringify(out, null, 1));
// Compact data for the game.
const ST = { geo: 0, flat: 1, glass: 2, museum: 3, arena: 4, plant: 5, stand: 6 };
const ts = `// Dithers College plan: generated by scratch/campus/tools/gen.mjs from tools/briefs/dithers-campus-plan.json. Do not edit by hand.
// Buildings: [style, floors, flags, name, ...rects as cx, cz, w, d, angle]. style 0 geo 1 flat 2 glass 3 museum 4 arena 5 plant 6 stand.
// flags: 1 library tower, 2 chapel spire, 4 cupola, 8 portico.
export const CAMPUS_BUILDINGS: [number, number, number, string, number[]][] = [
${live.map(b => `  [${ST[b.style]}, ${b.floors}, ${(b.extra.tower === 'library' ? 1 : 0) | (b.extra.tower === 'chapel' ? 2 : 0) | (b.extra.cupola ? 4 : 0) | (b.extra.portico ? 8 : 0)}, ${JSON.stringify(b.name)}, [${rectsOf(b, b.E).map(r => [r1(r.cx), r1(r.cz), r1(r.w), r1(r.d), r2(r.a)].join(', ')).join(', ')}]],`).join('\n')}
];
/** Fields: [sport, cx, cz, w, d, angle]. sport 0 soccer/multi 1 football 2 baseball 3 softball 4 rugby 5 tennis. */
export const CAMPUS_FIELDS: [number, number, number, number, number, number][] = [
${fields.map(f => `  [${({ american_football: 1, baseball: 2, softball: 3, rugby_union: 4, tennis: 5 })[f.sport] ?? 0}, ${f.cx}, ${f.cz}, ${f.w}, ${f.d}, ${f.a}],`).join('\n')}
];
export const CAMPUS_TRACK = ${JSON.stringify(track)};
export const CAMPUS_POND: number[] = [${pond ? pond.poly.flat().join(', ') : ''}];
export const CAMPUS_LOTS: number[][] = [
${lots.map(l => `  [${l.poly.flat().join(', ')}],`).join('\n')}
];
export const CAMPUS_PATHS: number[][] = [
${paths.map(p => `  [${p.flat().join(', ')}],`).join('\n')}
];
export const CAMPUS_DRIVES: number[][] = [
${drives.map(d => `  [${d.pts.flat().join(', ')}],`).join('\n')}
];
`;
const aabb = (pts) => { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); } return [r1(x0), r1(z0), r1(x1), r1(z1)]; };
// A rotated shape's one axis-aligned box is much bigger than the shape (roads that clear the shape sat 'inside' it): a long or turned
// shape is covered by a staircase of small boxes instead, keeping only the cells that touch it. dist(x, z) is the distance to the shape.
// (cells over a road's paving are left out: props keep off roads anyway, and the paving then never lies inside a box)
const roadPts = roads.flatMap((r) => { const o = []; for (let i = 0; i < r.pts.length - 1; i++) { const a = r.pts[i], b = r.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.5)); for (let k = 0; k <= n; k++) o.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, r.hw - 3.5]); } return o; });
// Junction pads and roundabout rings are wider than the street: every road end and every ring counts as a wide spot.
for (const r of roads) for (const q of [r.pts[0], r.pts[r.pts.length - 1]]) roadPts.push([q[0], q[1], r.hw - 3.5 + 6]);
for (const m of sd.matchAll(/"name":"[^"]+","x":(-?[\d.]+),"z":(-?[\d.]+),"r":(\d+)/g)) roadPts.push([+m[1], +m[2], +m[3] + 14]);
const roadNear = (bb) => roadPts.some(([x, z, w]) => x > bb[0] - w - 5 && x < bb[2] + w + 5 && z > bb[1] - w - 5 && z < bb[3] + w + 5);
const onRoad = (x0, z0, x1, z1) => roadPts.some(([x, z, w]) => { const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1); return dx * dx + dz * dz < (w + 5) * (w + 5); });
const tile = (poly, dist, cell = 6) => { const bb = aabb(poly), ar = (bb[2] - bb[0]) * (bb[3] - bb[1]); let pa = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], c = poly[(i + 1) % poly.length]; pa += a[0] * c[1] - c[0] * a[1]; } pa = Math.abs(pa) / 2;
  if (ar < 1.35 * pa + 30 && !roadNear(bb)) return [bb]; const out = [], h = cell * Math.SQRT1_2; for (let x = bb[0]; x < bb[2]; x += cell) for (let z = bb[1]; z < bb[3]; z += cell) { const x1 = Math.min(bb[2], x + cell), z1 = Math.min(bb[3], z + cell); if (dist((x + x1) / 2, (z + z1) / 2) <= h && !onRoad(x, z, x1, z1)) { const l = out[out.length - 1]; if (l && l[0] === r1(x) && l[3] === r1(z)) l[3] = r1(z1); else out.push([r1(x), r1(z), r1(x1), r1(z1)]); } } return out; }; // (a column's touching cells merge into one tall box)
const qd = (q) => (x, z) => dPoly([x, z], q);
const boxes = [...live.flatMap(b => quadsOf(b, b.E, 1).flatMap(q => tile(q, qd(q)))), ...fields.flatMap(f => { const q = corners(f.cx, f.cz, f.w + 2, f.d + 2, f.a); return tile(q, qd(q)); }), ...lots.flatMap(l => tile(l.poly, (x, z) => { let c = false, b = 1e9; const q = l.poly; for (let i = 0, j = q.length - 1; i < q.length; j = i++) { if ((q[i][1] > z) !== (q[j][1] > z) && x < (q[j][0] - q[i][0]) * (z - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) c = !c; b = Math.min(b, segd([x, z], q[i], q[j])); } return c ? 0 : b; }))];
if (track) { const c = Math.cos(track.a), sn = Math.sin(track.a), h = track.straight / 2, A = [track.cx - h * c, track.cz - h * sn], B = [track.cx + h * c, track.cz + h * sn], R = track.r_in + track.lanes * track.lane_w + 1;
  boxes.push(...tile(corners(track.cx, track.cz, track.straight + 2 * R, 2 * R, track.a), (x, z) => Math.max(0, segd([x, z], A, B) - R))); }
const bx0 = r1(Math.min(...boxes.map(b => b[0])) - 10), bx1 = r1(Math.max(...boxes.map(b => b[2])) + 10);
const bz0 = r1(Math.min(...boxes.map(b => b[1])) - 10), bz1 = r1(Math.max(...boxes.map(b => b[3])) + 10);
const ts2 = ts + `/** Axis-aligned boxes round every building, field, track and car park: trees, houses and lamps keep out of them. */
export const CAMPUS_BOXES: number[][] = [
${boxes.map(b => '  [' + b.join(', ') + '],').join('\n')}
];
/** True where nothing of the campus stands (m metres of margin): no building, field, track, car park or pond. */
export function campusFree(x: number, z: number, m = 0): boolean {
  if (x < ${bx0} || x > ${bx1} || z < ${bz0} || z > ${bz1}) return true;
  for (const b of CAMPUS_BOXES) if (x > b[0] - m && x < b[2] + m && z > b[1] - m && z < b[3] + m) return false;
  const p = CAMPUS_POND; let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) { const zi = p[i + 1], zj = p[j + 1]; if ((zi > z) !== (zj > z) && x < ((p[j] - p[i]) * (z - zi)) / (zj - zi) + p[i]) c = !c; }
  return !c;
}
`;
fs.writeFileSync(new URL('src/world/dithersPlan.ts', ROOT), ts2);
console.log('buildings', live.length, 'dropped', dropped.map(b => b.real || b.name).join(', '), 'fields', fields.length, 'lots', lots.length, 'paths', paths.length, 'drives', drives.length);
console.log('E', live.map(b => `${b.real || '?'}:${b.E}`).join(' '));
