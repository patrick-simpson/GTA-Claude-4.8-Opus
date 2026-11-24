// Step 2 unit 1: turn tools/briefs/tepid-streets-plan.json into src/world/streetData.ts.
//   node scratch/streets2/gen.mjs
// Cleans the traced polylines (duplicate points, back-tracking spikes), applies the lead's decision
// (the Thruway and its exit 127 ramps move ~35 m west so the ramps clear Pardon's lot), fixes the
// Landing Rd stub, and writes plain typed data. The graph itself is built at run time by streets.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/briefs/tepid-streets-plan.json'), 'utf8'));

const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
/** The Thruway shift: full 35 m south of z -1600 (exit 127 and the south end), easing out by z -1900. */
const SHIFT = 35;
const shiftX = (z) => -SHIFT * smooth((z + 1900) / 300);
const isShifted = (r) => r.id === 'the_thruway_0' || r.id.startsWith('ramp_127_');

function clean(pts) {
  let p = pts.map(([x, z]) => [x, z]);
  // duplicates
  p = p.filter((q, i) => i === 0 || Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) > 0.5);
  // spikes: a vertex where the line turns back on itself (> 150 degrees)
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < p.length - 1; i++) {
      const ax = p[i][0] - p[i - 1][0], az = p[i][1] - p[i - 1][1], bx = p[i + 1][0] - p[i][0], bz = p[i + 1][1] - p[i][1];
      const c = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
      if (c < Math.cos((150 * Math.PI) / 180)) { p.splice(i, 1); changed = true; break; }
    }
  }
  return p;
}

const roads = [];
let spikes = 0;
for (const r of plan.roads) {
  let pts = clean(r.pts);
  spikes += r.pts.length - pts.length;
  if (r.id === 'landing_rd_0') pts = [[-30, -1072], [-30, -1103]]; // traced as a hook; the deck ends at z -1072, Birch St is at -1102.6
  if (isShifted(r)) pts = pts.map(([x, z]) => [x + shiftX(z), z]);
  const kind = r.type === 'highway' ? 'highway' : r.type === 'ramp' ? 'ramp' : r.type === 'arterial' ? 'arterial' : 'local';
  roads.push({
    id: r.id, name: r.game_name, kind, lanes: r.lanes_per_dir, oneWay: !!r.one_way, divided: !!r.divided, stage: r.stage,
    pts: pts.flat().map((v) => Math.round(v * 10) / 10),
  });
}
// Unit 3 fixes. (1) The east-side exit 127 ramps were traced inside the Thruway's width: rebuild them 18.5 m east of
// its centreline (clear of the carriageway and of Pardon's lot), tapering in at the diverge (z -1132) and the merge
// (z -1530, where the on-ramp now ends instead of crossing the Thruway near -1420). Both meet Second Thought Ave at
// grade. (2) The Trestle St / Far Bank Rd / Upriver Rd junction moves from mid-river to the east bank (x 370) and
// Upriver Rd follows the bank instead of running in the water.
{
  const thru = roads.find((r) => r.id === 'the_thruway_0').pts;
  const thruX = (z) => {
    for (let k = 0; k + 3 < thru.length; k += 2) {
      const z0 = thru[k + 1], z1 = thru[k + 3];
      if ((z - z0) * (z - z1) <= 0 && z0 !== z1) return thru[k] + ((z - z0) / (z1 - z0)) * (thru[k + 2] - thru[k]);
    }
    throw new Error('thruX ' + z);
  };
  const D = 18.5, ZD = -1131.8, ZS = -1295, ZM = -1530.5;
  const ramp = (za, zb) => {
    const o = [];
    const n = Math.ceil(Math.abs(zb - za) / 12);
    for (let i = 0; i <= n; i++) {
      const z = za + ((zb - za) * i) / n;
      const t = Math.min(Math.abs(z - ZD), Math.abs(z - ZM));
      // (Off the outer lane at once: the end point itself snaps onto the Thruway, inside its junction pad.)
      o.push(Math.round((thruX(z) + (t < 1 ? 0 : 7 + (D - 7) * smooth(t / 110))) * 10) / 10, Math.round(z * 10) / 10);
    }
    return o;
  };
  // The Second Thought Ave end is at full offset (the taper is far away there).
  roads.find((r) => r.id === 'ramp_127_43139504').pts = ramp(ZD, ZS);
  roads.find((r) => r.id === 'ramp_127_297170948').pts = ramp(ZS, ZM);
  const JX = 370, JZ = -1636;
  const tb = roads.find((r) => r.id === 'trestle_st_0_b');
  tb.pts = [JX, JZ, 260, -1634];
  const fb = roads.find((r) => r.id === 'far_bank_rd_0');
  fb.pts.splice(0, 2, JX, JZ);
  const up = roads.find((r) => r.id === 'upriver_rd_0');
  const k = up.pts.findIndex((v, i) => i % 2 === 1 && Math.abs(v + 1954) < 2);
  if (k < 0) throw new Error('Upriver Rd bend not found');
  const riverX = (z) => 340 + 30 * Math.sin((z + 1100) / 210);
  const bank = [];
  for (let z = -1900; z <= -1670; z += 40) bank.push(Math.round((riverX(z) + 36 + 14) * 10) / 10, z);
  up.pts = [...up.pts.slice(0, k + 1), ...bank, JX, JZ];
}
let turn = [];

// ── Fix unit A (Nov 24, audit tepid-audit.md): joins, duplicates, dead ends, water, turnarounds, added roads ──────────
const R = (id) => { const r = roads.find((q) => q.id === id); if (!r) throw new Error('road ' + id); return r; };
const pairs = (pts) => { const o = []; for (let k = 0; k < pts.length; k += 2) o.push([pts[k], pts[k + 1]]); return o; };
const flat = (a) => a.flat().map((v) => Math.round(v * 10) / 10);
const projPoly = (pts, x, z) => {
  let best = { d: Infinity, x: 0, z: 0, i: 0 };
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { d, x: px, z: pz, i: k / 2 };
  }
  return best;
};
const segHit = (a, b, c, d) => {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1], den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1], t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, x: a[0] + rx * t, z: a[1] + rz * t } : null;
};
/** Cut a road's end back to where it crosses another road (and end there). */
const trimTo = (id, end, otherId) => {
  const r = R(id), O = pairs(R(otherId).pts); let P = pairs(r.pts);
  if (end === 0) P = P.reverse();
  for (let k = P.length - 2; k >= 0; k--) {
    for (let j = 0; j + 1 < O.length; j++) {
      const h = segHit(P[k], P[k + 1], O[j], O[j + 1]);
      if (h) { P = [...P.slice(0, k + 1), [h.x, h.z]]; r.pts = flat(end === 0 ? P.reverse() : P); return; }
    }
  }
  throw new Error('trimTo ' + id + ' ' + otherId);
};
/** Extend a road's end onto the nearest point of another road. */
const extendTo = (id, end, otherId) => {
  const r = R(id), P = pairs(r.pts), e = end ? P[P.length - 1] : P[0], q = projPoly(R(otherId).pts, e[0], e[1]);
  if (end) P.push([q.x, q.z]); else P.unshift([q.x, q.z]);
  r.pts = flat(P);
};
const drop = (id) => { const i = roads.findIndex((q) => q.id === id); if (i < 0) throw new Error('drop ' + id); roads.splice(i, 1); };
{
  const thru = R('the_thruway_0');
  const thruX2 = (z) => { const T = pairs(thru.pts); for (let k = 0; k + 1 < T.length; k++) { const z0 = T[k][1], z1 = T[k + 1][1]; if ((z - z0) * (z - z1) <= 0 && z0 !== z1) return T[k][0] + ((z - z0) / (z1 - z0)) * (T[k + 1][0] - T[k][0]); } throw new Error('tx ' + z); };
  // 1. Exit 127: the southbound off-ramp starts ON the Thruway (it was 10.5 m off, outside the 8 m snap) and ends on Second Thought
  //    Ave's west signal; the odd loop (397489876) beside it goes (cars reversed off its stubs).
  { const r = R('ramp_127_43139502'); const p = pairs(r.pts); p[0] = [thruX2(p[0][1]), p[0][1]]; p.push([-761.7, -1295]); r.pts = flat(p); }
  drop('ramp_127_397489876');
  // 2. Turnarounds at the Thruway's two ends (it leaves the map there): a roundabout where the last ramp meets it, no stub beyond.
  //    South: at the exit 127 on-ramp's merge. North: at exit 130's ramp pair (the on-ramp used to U-turn at the very end).
  const ZS = -1071.4, T1 = [-79.9, -2897.3];
  { const p = pairs(thru.pts); while (p.length && p[p.length - 1][1] > ZS) p.pop(); p.push([thruX2(ZS) ?? -709.9, ZS]); thru.pts = flat(p); }
  { const p = pairs(thru.pts); while (p.length > 2 && p[0][1] < T1[1] + 0.1) p.shift(); p.unshift(T1); thru.pts = flat(p); }
  const rs = pairs(R('ramp_127_43139503').pts); rs[rs.length - 1] = pairs(thru.pts).at(-1); R('ramp_127_43139503').pts = flat(rs);
  { const r = R('ramp_130_43139524'), p = pairs(r.pts); p[p.length - 1] = T1; r.pts = flat(p); }
  { const r = R('ramp_130_43139522'), p = pairs(r.pts); p[0] = T1; r.pts = flat(p); }
  turn = [{ name: 'Turnaround 130', x: T1[0], z: T1[1], r: 14 }, { name: 'Turnaround 127', x: pairs(thru.pts).at(-1)[0], z: ZS, r: 14 }];
  // 3. Main St's south end joins Trestle St.
  trimTo('main_st_0_downtown', 0, 'trestle_st_0');
  // 4. Duplicate plan roads (each had every edge doubled by another piece of the same street).
  for (const id of ['upriver_rd_1', 'cherry_tree_st_1', 'waiting_room_pkwy_1', 'bagpipe_ave_1', 'porch_st_1']) drop(id);
  // Drifting West Ave began with a hook that doubled Halfway Rangeway's bit; Passable St began with a hook doubling Main St.
  { const r = R('drifting_west_ave_0'); r.pts = flat([[-306, -1751], ...pairs(r.pts).slice(4)]); }
  { const r = R('passable_st_0'); r.pts = flat(pairs(r.pts).slice(2)); }
  // Front St ran 10 m on past Trestle St along Water St: both meet Trestle St at one point.
  { const tp = projPoly(R('trestle_st_0').pts, 170, -1618); const f = R('front_st_0'), w = R('water_st_0'); const fp = pairs(f.pts); fp[fp.length - 1] = [tp.x, tp.z]; f.pts = flat(fp); const wp = pairs(w.pts); wp[0] = [tp.x, tp.z]; w.pts = flat(wp); }
  // 5. Dead ends. Porch St runs on to Dutch Elm St (west) and stops at Birch St (it overshot by 24 m).
  extendTo('porch_st_0', 0, 'dutch_elm_st_0');
  trimTo('porch_st_0', 1, 'birch_st_0');
  // Tuition Ave: the first 108 m crossed the Kennebec (and nothing joins the far bank up there): start it on the west bank, and
  // link it to the north end's streets (Bagpipe Ave, Depot St) with a new road that follows the bank.
  { const r = R('tuition_ave_0'); r.pts = flat(pairs(r.pts).slice(3)); }
  extendTo('acorn_st_0', 0, 'tuition_ave_0');
  // Tiny edges: ends that met a street 3-8 m apart now meet at one point.
  const moveEnd = (id, end, pt) => { const r = R(id), p = pairs(r.pts); p[end ? p.length - 1 : 0] = pt; r.pts = flat(p); };
  { const q = projPoly(R('main_st_0_upper').pts, 0, -2519.7), pt = [q.x, q.z]; moveEnd('acorn_st_0', 1, pt); moveEnd('waiting_room_pkwy_0', 1, pt); }
  { const r = R('ramp_127_43139502'), p = pairs(r.pts); p.splice(p.length - 2, 2, [-761.7, -1287]); r.pts = flat(p); }
  { const r = R('ramp_127_43139503'), p = pairs(r.pts); p.splice(0, 2, [-761.7, -1287]); r.pts = flat(p); }
  moveEnd('ramp_130_43139524', 0, [-122.3, -2828.2]);
}

// Street fix (Nov 24, owner: "Mardens and Colby is screwed up"):
// 1. Cherry Tree St's first edge (from the Offramp Rd node at -588,-1271 to Second Thought Ave) cut across the NE corner of Pardon's
//    lot (x <= -599.5, z >= -1281.5): it now bends south first and meets the avenue along its north kerb, clear of the lot.
{ const r = R('cherry_tree_st_0'); r.pts = flat([[-588.1, -1271], [-589.9, -1276], [-590.2, -1285], [-595, -1291.2], [-604, -1294], [-613.6, -1295], ...pairs(r.pts).slice(2)]); }
// 2. Second Thought Ave's 90 degree corner at -770,-1248.5 (exit 127 interchange, a lamp stood on the carriageway there) becomes an arc.
{ const r = R('second_thought_ave_0'), P = pairs(r.pts), i = P.findIndex((q) => Math.abs(q[0] + 769.9) < 0.2 && Math.abs(q[1] + 1248.5) < 0.2);
  if (i < 1) throw new Error('Second Thought corner');
  const a = P[i - 1], v = P[i], b = P[i + 1], ax = v[0] - a[0], az = v[1] - a[1], bx = b[0] - v[0], bz = b[1] - v[1], la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), rr = Math.min(la, lb) * 0.55;
  const p0 = [v[0] - (ax / la) * rr, v[1] - (az / la) * rr], p1 = [v[0] + (bx / lb) * rr, v[1] + (bz / lb) * rr], arc = [];
  for (let k = 0; k <= 8; k++) { const t = k / 8, u = 1 - t; arc.push([u * u * p0[0] + 2 * u * t * v[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * v[1] + t * t * p1[1]]); }
  P.splice(i, 1, ...arc); r.pts = flat(P); }

// Added roads (unit A, #7): real Waterville streets missing from the plan, warped with the plan's mapping (scratch/fixA/addroads.py)
// and given invented game names; plus one hand-made link that closes the north end (Depot St - Bagpipe Ave - Tuition Ave).
roads.push({ id: 'headwaters_ln_0', name: 'Headwaters Ln', kind: 'local', lanes: 1, oneWay: false, divided: false, stage: 3,
  pts: flat([[-2.3, -2907.6], [70, -2905], [144.6, -2896.6], [215, -2885], [247, -2835], [256, -2785], [262.1, -2733.4]]) });
/** Round the sharp corners of a traced street (cars drive the polyline as a rail): each bend over 20 degrees becomes a short arc. */
function fillet(P) {
  const o = [P[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1], v = P[i], b = P[i + 1];
    const ax = v[0] - a[0], az = v[1] - a[1], bx = b[0] - v[0], bz = b[1] - v[1], la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb || 1))));
    if (turn > 1.9) return null; // a hairpin: not a street cars can drive
    if (turn < 0.35) { o.push(v); continue; }
    const r = Math.min(16, la * 0.45, lb * 0.45), p0 = [v[0] - (ax / la) * r, v[1] - (az / la) * r], p1 = [v[0] + (bx / lb) * r, v[1] + (bz / lb) * r];
    for (let k = 0; k <= 6; k++) { const t = k / 6, u = 1 - t; o.push([u * u * p0[0] + 2 * u * t * v[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * v[1] + t * t * p1[1]]); }
  }
  o.push(P[P.length - 1]);
  return o;
}
for (const a of JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/briefs/tepid-streets-added.json'), 'utf8'))) {
  const pts = fillet(clean(pairs(a.pts)));
  if (!pts || pts.length < 2) continue;
  roads.push({ id: a.id, name: a.name, kind: a.kind, lanes: a.lanes, oneWay: a.oneWay, divided: a.divided, stage: a.stage, pts: flat(pts) });
}
const SHIFT_NAMES = new Set(['The Thruway', 'Thruway exit 127 ramp']);
const junctions = plan.junctions.map((j) => {
  let [x, z] = j.at;
  if (j.roads.some((n) => SHIFT_NAMES.has(n))) x += shiftX(z);
  // The two exit 130 ramp junctions on Main St deadlocked their signal box (ramp and through cars stopped in it): stop signs there.
  const ex130 = j.roads.includes('Thruway exit 130 ramp') && j.roads.includes('Main St');
  const control = j.kind === 'overpass' ? 'overpass' : j.control === 'signal' && !ex130 ? 'signal' : 'stop';
  // Unit 3: the east ramps' Second Thought Ave junction follows them; the ramp-only signal by the Thruway (it put a
  // signal on the Thruway itself) goes; the river junction moves to the east bank.
  if (j.roads.length === 1 && j.roads[0] === 'Thruway exit 127 ramp' && Math.abs(j.at[1] + 1310.5) < 1) return null;
  if (Math.abs(j.at[0] + 717.3 + 35) < 2 && Math.abs(j.at[1] + 1295) < 1) x = roads.find((r) => r.id === 'ramp_127_43139504').pts.at(-2);
  else if (Math.abs(j.at[0] + 682.3) < 2 && Math.abs(j.at[1] + 1295) < 1) x = roads.find((r) => r.id === 'ramp_127_43139504').pts.at(-2);
  if (Math.hypot(j.at[0] - 332.4, j.at[1] + 1637.4) < 3) { x = 370; z = -1636; }
  return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, control, roads: j.roads };
}).filter(Boolean);
const rounds = [...plan.roundabouts.map((r) => ({ name: r.game_name, x: r.at[0], z: r.at[1], r: r.radius })), ...turn];

const out = `// GENERATED by scratch/streets2/gen.mjs from tools/briefs/tepid-streets-plan.json: do not edit by hand.
// Tepid Falls' streets after real Waterville (tepid-streets.md step 1), as road centrelines in game
// metres (north = -Z). Cleaned of traced spikes; the Thruway and its exit 127 ramps sit ${SHIFT} m west of
// the plan through the exit (lead's decision: the ramps clear Pardon's lot), easing back by z -1900.
// streets.ts builds the graph (nodes, polyline edges, blocks, lots) from this at run time.

export type RoadKind = 'highway' | 'arterial' | 'local' | 'ramp';
export interface PlanRoad {
  id: string; name: string; kind: RoadKind;
  /** Driving lanes per direction (per carriageway when one-way). */
  lanes: number; oneWay: boolean; divided: boolean;
  /** Progression stage the road opens at (0 opens with the bridge). */
  stage: number;
  /** Centreline, flat x,z pairs, in drawing (and for one-way roads travel) order. */
  pts: number[];
}
export interface PlanJunction { x: number; z: number; control: 'signal' | 'stop' | 'overpass'; roads: string[] }
export interface PlanRoundabout { name: string; x: number; z: number; r: number }

export const PLAN_ROADS: PlanRoad[] = [
${roads.map((r) => '  ' + JSON.stringify(r)).join(',\n')},
];

export const PLAN_JUNCTIONS: PlanJunction[] = [
${junctions.map((r) => '  ' + JSON.stringify(r)).join(',\n')},
];

/** Real signalled junctions, warped with the plan's mapping (flat x,z): streets.ts signals the nearby arterial junctions. */
export const PLAN_SIGNALS: number[] = ${JSON.stringify(plan.signals_osm_warped.flat())};

export const PLAN_ROUNDABOUTS: PlanRoundabout[] = ${JSON.stringify(rounds)};
`;
fs.writeFileSync(path.join(ROOT, 'src/world/streetData.ts'), out);
console.log('roads', roads.length, 'spike/dup points removed', spikes, 'junctions', junctions.length, 'bytes', out.length);
