// Tepid Falls, the places: what stands on the square, the hill, the yard, the river and the lake.
//
// Everything here is drawn into mainlandBuildings.ts's kit (same wall sheet, same sign atlas, same
// 300 m chunks), so a landmark costs triangles and no draw calls of its own. This builder runs last
// and is the one that turns the kit's batches into meshes.
//
// Where things are (meters; the town plateau is y = 5):
//   Quorum Square        bandstand at (20, -1452), soldier's monument at (20, -1430)
//   Postponement Hall    city hall and opera house, north side of the square across Bobbin St
//   Exact Change Bridge  ground.ts hangs the deck; the tower bracing, piers, anchors, toll hut are here
//   Dithers College      chapel, two halls, lawn and gate on the flat top of the hill
//   The depot            south of the tracks east of Main St, with a water tower and cars on the sidings
//   The Thruway          four sign gantries; Idle Hands truck stop by the Second Thought Ave exit
//   Fort Reluctance      the blockhouse in Lesser Tepid
//   Lake Indecision      boat ramp, dock and camps on the south shore

import type { WorldPart } from '../core/api';
import { RNG } from '../core/util';
import { DAM_Z, FOOTBRIDGE, FOOTBRIDGE_Z, LAKE, MAIN_Y, POND_Y, RAIL, riverX } from './mainland';
import { groundAt, type Lot, type Rect } from './plan';
import { FENCE_UV, MWALL } from './textures';
import { OPERA, PX, PZ, WIN, cut, dim, frameOf, frect, mainKit, type Frame, type MainKit, type WinStyle } from './mainlandBuildings';

const R = MWALL.rows, RED = MWALL.redBrick, TAU = Math.PI * 2;
const STONE = 0xcfcac0, GRAN = 0xb5b1a6, TAR = 0x4a4b4d, IRON = 0x2e3338, WHITE = 0xf1ede2, SLATE = 0x596068, PATH = 0xc9c1ad, WOOD = 0x6a4a32, CONC = 0xa9a69c;
const big = (w: number, h: number, sill: number): WinStyle => ({ ...WIN.round, w, h, sill });
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, z0: r.z0 - d, x1: r.x1 + d, z1: r.z1 + d });
const sqr = (x: number, z: number, h: number): Rect => ({ x0: x - h, z0: z - h, x1: x + h, z1: z + h });
const hits = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

/** A park bench of four boards, its back to (bx, bz). */
function bench(k: MainKit, x: number, z: number, y: number, alongX: boolean): void {
  const sx = alongX ? 1.7 : 0.45, sz = alongX ? 0.45 : 1.7;
  k.F.box(x, y + 0.4, z, sx, 0.07, sz, WOOD);
  k.F.box(x + (alongX ? 0 : -0.2), y + 0.47, z + (alongX ? -0.2 : 0), alongX ? 1.7 : 0.07, 0.42, alongX ? 0.07 : 1.7, WOOD);
  for (const t of [-0.7, 0.7]) k.F.box(x + (alongX ? t : 0), y, z + (alongX ? 0 : t), alongX ? 0.08 : 0.4, 0.4, alongX ? 0.4 : 0.08, IRON, 0, 4);
  k.game.col.addProp(x, z, 0.7, y + 0.9, 'bench', false);
}

/** A strip of path between two points, any direction. */
function strip(k: MainKit, x0: number, z0: number, x1: number, z1: number, w: number, y: number, hex: number): void {
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w / 2, nz = (dx / l) * w / 2;
  k.F.quad(x0 + nx, y, z0 + nz, x0 - nx, y, z0 - nz, x1 - nx, y, z1 - nz, x1 + nx, y, z1 + nz, hex);
  k.F.quad(x1 + nx, y, z1 + nz, x1 - nx, y, z1 - nz, x0 - nx, y, z0 - nz, x0 + nx, y, z0 + nz, hex);
}

/** White columns under an entablature and a pediment, standing `out` from the wall between a and b. Returns the top of the entablature. */
function portico(k: MainKit, f: Frame, a: number, b: number, yg: number, y: number, colH: number, out: number, n: number, hex = WHITE): number {
  const ey = y + colH, mid = (a + b) / 2, pk = ey + 0.9 + (b - a) * 0.16;
  k.fbox(f, a - 0.3, b + 0.3, 0, out + 0.3, yg, y, STONE, 5);
  k.fbox(f, a - 0.7, b + 0.7, out + 0.3, out + 0.75, yg, yg + (y - yg) * 0.66, STONE, 5); k.fbox(f, a - 0.7, b + 0.7, out + 0.75, out + 1.2, yg, yg + (y - yg) * 0.33, STONE, 5);
  for (let i = 0; i < n; i++) {
    const s = a + 0.5 + (i * (b - a - 1)) / (n - 1), cx = PX(f, s, out - 0.5), cz = PZ(f, s, out - 0.5);
    k.F.cyl(cx, y, cz, 0.36, 0.3, colH, hex, k.low ? 6 : 10, false);
    k.F.box(cx, y, cz, 0.9, 0.18, 0.9, hex); k.F.box(cx, ey - 0.2, cz, 0.86, 0.2, 0.86, hex);
    k.game.col.addProp(cx, cz, 0.42, ey, 'post', false);
  }
  k.ledge(f, a, b, ey, ey + 0.9, 0, out, hex);
  k.F.tri(PX(f, a, out), ey + 0.9, PZ(f, a, out), PX(f, b, out), ey + 0.9, PZ(f, b, out), PX(f, mid, out), pk, PZ(f, mid, out), hex);
  for (const [sa, sb, ya, yb] of [[a, mid, ey + 0.9, pk], [mid, b, pk, ey + 0.9]]) {
    k.F.quad(PX(f, sa, out), ya, PZ(f, sa, out), PX(f, sb, out), yb, PZ(f, sb, out), PX(f, sb, 0), yb, PZ(f, sb, 0), PX(f, sa, 0), ya, PZ(f, sa, 0), 0x6f7478);
  }
  return ey + 0.9;
}

function square(k: MainKit): void {
  const cx = 20, cz = -1452, y = groundAt(cx, cz), col = k.game.col, P = FENCE_UV.picket;
  k.at(cx, cz);
  k.F.floor(cx - 1.4, -1495.5, cx + 1.4, -1409.5, y + 0.04, PATH);
  k.F.floor(-16.5, cz - 1.4, cx - 1.4, cz + 1.4, y + 0.04, PATH); k.F.floor(cx + 1.4, cz - 1.4, 56.5, cz + 1.4, y + 0.04, PATH);
  k.F.cyl(cx, y - 0.2, cz, 7.5, 7.5, 0.27, PATH, 16, true);

  // The bandstand: eight posts on a stone drum, a green roof, a rail all round but for the steps.
  const by = y + 1, ry = by + 3.1;
  k.F.cyl(cx, y, cz, 4.2, 4.2, 1, 0xb9b3a4, 8, true);
  k.F.cyl(cx, by, cz, 4.4, 4.4, 0.1, WHITE, 8, true);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * TAU, a1 = ((i + 1) / 8) * TAU, ax = cx + Math.cos(a0) * 3.9, az = cz + Math.sin(a0) * 3.9, bx = cx + Math.cos(a1) * 3.9, bz = cz + Math.sin(a1) * 3.9;
    k.F.cyl(ax, by, az, 0.09, 0.09, 3.1, WHITE, 6, false);
    if (i !== 1) k.N.quad(ax, by + 0.1, az, bx, by + 0.1, bz, bx, by + 1.05, bz, ax, by + 1.05, az, 0xffffff, 0, P.v0 + 0.004, 1.5, P.v1 - 0.004);
    // The ceiling, since the roof above is one-sided.
    k.F.tri(cx, ry, cz, cx + Math.cos(a0) * 5, ry, cz + Math.sin(a0) * 5, cx + Math.cos(a1) * 5, ry, cz + Math.sin(a1) * 5, 0xd9d4c4);
  }
  k.F.cyl(cx, ry, cz, 5, 0.25, 2.3, 0x4f6a5a, 8, false);
  k.F.cyl(cx, ry + 2.3, cz, 0.08, 0.03, 1.2, IRON, 5, false);
  const sa = (1.5 / 8) * TAU;
  k.F.box(cx + Math.cos(sa) * 4.6, y, cz + Math.sin(sa) * 4.6, 2, 0.66, 1.3, 0xb9b3a4, Math.PI / 2 - sa); k.F.box(cx + Math.cos(sa) * 5.5, y, cz + Math.sin(sa) * 5.5, 2, 0.33, 1.3, 0xb9b3a4, Math.PI / 2 - sa);
  col.addBox(cx - 3.6, cz - 3.6, cx + 3.6, cz + 3.6, ry, y - 1);

  // The soldier's monument: a private of volunteers on a granite shaft, facing the bridge he did not live to see started.
  const mz = -1430, BRONZE = 0x55685a;
  k.F.box(cx, y, mz, 4.4, 0.4, 4.4, GRAN); k.F.box(cx, y + 0.4, mz, 3.4, 0.4, 3.4, GRAN); k.F.box(cx, y + 0.8, mz, 2.2, 2.2, 2.2, 0xc4c0b6); k.F.box(cx, y + 3, mz, 2.6, 0.3, 2.6, GRAN);
  k.frustum(sqr(cx, mz, 0.8), y + 3.3, sqr(cx, mz, 0.55), y + 6.6, 0xc4c0b6);
  k.F.box(cx, y + 6.6, mz, 1.4, 0.25, 1.4, GRAN);
  k.F.box(cx, y + 6.85, mz, 0.5, 1, 0.34, BRONZE); k.F.box(cx, y + 7.85, mz, 0.62, 0.8, 0.38, BRONZE);
  k.F.cyl(cx, y + 8.65, mz, 0.17, 0.16, 0.3, BRONZE, 6, true); k.F.box(cx, y + 8.95, mz + 0.05, 0.36, 0.1, 0.44, BRONZE);
  k.pipe(k.F, cx + 0.4, y + 6.85, mz + 0.12, cx + 0.42, y + 8.75, mz + 0.12, 0.035, 0x3a4640, 5);
  k.signAt(frameOf(sqr(cx, mz, 1.1), 2), 1.1, y + 1.45, 1.9, 0.02, 'm-monument');
  col.addBox(cx - 2.2, mz - 2.2, cx + 2.2, mz + 2.2, y + 7, y - 1);

  for (const bz of [-1486, -1470, -1420]) { bench(k, cx - 2.2, bz, y, false); bench(k, cx + 2.2, bz + 5, y, false); }
  for (const bx of [-6, 42]) bench(k, bx, cz - 2.2, y, true);
}

/** Postponement Hall: city offices below, the opera house above, a clock tower over the door. */
function opera(k: MainKit): void {
  const B: Rect = { x0: OPERA.x0 + 2, z0: OPERA.z0 + 1, x1: OPERA.x1 - 2, z1: OPERA.z1 - 3.5 }, y = groundAt(20, -1530);
  const b0 = y + 1.4, f1 = 7.4, f2 = 5.2, top = b0 + f1 + f2 + 1;
  k.at(20, -1530);
  k.solid(B, top, y - 1);
  k.F.floor(OPERA.x0, OPERA.z0, OPERA.x1, OPERA.z1, y + 0.03, 0xbdb6a4);
  for (let s = 0; s < 4; s++) {
    const f = frameOf(B, s);
    k.band(f, 0, f.len, y, b0, GRAN, R.granite, y);
    if (s) { k.facade(f, 0, f.len, b0, f1, 1, RED, 1, big(2, 5.6, 0.9), 4.4, 3 + s); k.facade(f, 0, f.len, b0 + f1, f2, 1, RED, 1, big(1.5, 3.4, 0.8), 4.4, 7 + s); }
    else k.plainWall(f, 0, f.len, b0, b0 + f1 + f2, RED, 0.94, R.brick, { st: WIN.sash, yb: b0, fh: 4.2, floors: 3, pitch: 4.4, seed: 2 });
    k.band(f, 0, f.len, b0 + f1 + f2, top, RED, R.brick, b0 + f1 + f2, 1);
    k.ledge(f, 0, f.len, b0 + f1 - 0.15, b0 + f1 + 0.15, 0, 0.12, STONE);
    k.cornice(f, 0, f.len, top, RED, 1, 0.62, 0.24);
  }
  k.frustum(grow(B, 0.3), top, { x0: B.x0 + 9, z0: B.z0 + 9, x1: B.x1 - 9, z1: B.z1 - 9 }, top + 3.2, 0x5f7a6a, R.seam);
  k.F.floor(B.x0 + 9, B.z0 + 9, B.x1 - 9, B.z1 - 9, top + 3.2, 0x4a5f54);

  const T: Rect = { x0: 16, z0: B.z1 - 4, x1: 24, z1: B.z1 + 2.5 }, tt = top + 11, tf = frameOf(T, 2);
  k.solid({ ...T, z1: T.z1 + 2.4 }, y + 1.4, y - 1);
  k.solid(T, tt, y - 1);
  for (let s = 0; s < 4; s++) {
    const f = frameOf(T, s);
    k.band(f, 0, f.len, y, tt, RED, R.brick, y, s === 2 ? 1 : 0.96);
    k.signAt(f, f.len / 2, tt - 4.6, 3.4, 0.05, 'm-clock');
    k.cornice(f, 0, f.len, tt, RED, 1, 0.62, 0.24);
    k.ledge(f, -0.1, f.len + 0.1, top - 0.1, top + 0.2, 0, 0.12, STONE);
    if (s !== 0) k.piece(f, f.len / 2 - 0.75, 1.5, b0 + f1 + 0.8, 3.4, 0.03, R.round, 4 + s, 0xffffff);
    if (s !== 0) k.piece(f, f.len / 2 - 0.6, 1.2, top + 1.6, 2.6, 0.03, R.round, 9 + s, 0xffffff);
  }
  k.piece(tf, 4 - 1.5, 3, b0, 4.2, 0.04, R.door, MWALL.doors.hall, 0x5a3a28);
  k.signAt(tf, 4, b0 + 4.5, 6.6, 0.06, 'm-opera');
  for (let i = 0; i < 4; i++) k.F.box(20, y, T.z1 + 0.3 + i * 0.55, 9, 1.4 - i * 0.35, 0.6, GRAN);
  k.frustum(grow(T, 0.3), tt, sqr(20, (T.z0 + T.z1) / 2, 0.05), tt + 7.5, 0x4a5f54);
  k.F.cyl(20, tt + 7.4, (T.z0 + T.z1) / 2, 0.06, 0.03, 3, IRON, 5, false);
}

/** What ground.ts's footbridge lacks: braced towers on stone piers, more hangers, anchor blocks, and somebody to pay. */
function footbridge(k: MainKit): void {
  const fb = FOOTBRIDGE, fz = FOOTBRIDGE_Z, Y = MAIN_Y, T0 = fb.x0 + 7, T1 = fb.x1 - 7, TOP = Y + 9.5, IRONC = 0x4f5a63, col = k.game.col;
  const sag = (x: number): number => { const u = (x - T0) / (T1 - T0); return TOP - (TOP - Y - 1.5) * 4 * u * (1 - u); };
  for (const tx of [T0, T1]) {
    k.at(tx, fz);
    for (const sg of [-1, 1]) {
      const z = fz + sg * 1.75, g = groundAt(tx, z);
      k.F.box(tx, Math.min(g, Y) - 3, z, 1.2, Y + 0.7 - Math.min(g, Y) + 3, 1.2, GRAN);
      k.F.box(tx, TOP + 0.3, z, 0.7, 0.16, 0.7, IRONC);
      k.frustum(sqr(tx, z, 0.3), TOP + 0.46, sqr(tx, z, 0.02), TOP + 1.1, IRONC);
      col.addBox(tx - 0.6, z - 0.6, tx + 0.6, z + 0.6, Y + 0.7, Y - 6);
    }
    k.F.box(tx, Y + 3.1, fz, 0.26, 0.26, 3.5, IRONC);
    for (const [ya, yb] of [[Y + 3.4, Y + 8.8], [Y + 8.8, Y + 3.4]]) k.pipe(k.F, tx, ya, fz - 1.75, tx, yb, fz + 1.75, 0.06, IRONC, 5);
  }
  if (!k.low) for (let x = T0 + 3.5; x < T1 - 3; x += 7) { k.at(x, fz); for (const sg of [-1, 1]) k.pipe(k.F, x, sag(x), fz + sg * 1.75, x, Y - 0.1, fz + sg * 1.42, 0.03, IRONC, 4); }
  for (const ax of [fb.x0 - 9, fb.x1 + 9]) {
    k.at(ax, fz);
    for (const sg of [-1, 1]) { const z = fz + sg * 1.9, g = groundAt(ax, z); k.F.box(ax, g - 0.3, z, 1.5, 0.95, 0.8, CONC); col.addBox(ax - 0.75, z - 0.4, ax + 0.75, z + 0.4, g + 0.65, g - 1); }
  }
  // The toll hut at the town end, the sign, and the box the two cents go in.
  const H: Rect = { x0: 248.7, z0: -1350.6, x1: 251.3, z1: -1347.7 }, y = groundAt(250, -1349), ht = y + 2.5;
  k.at(250, -1349);
  k.solid(H, ht + 0.8, y - 1);
  for (let s = 0; s < 4; s++) { const f = frameOf(H, s); k.band(f, 0, f.len, y, ht, 0xc7a544, R.clap, y, s ? 0.95 : 1); }
  k.piece(frameOf(H, 2 + 2), 0.7, 1.2, y + 0.95, 1.2, 0.03, R.house, 3, WHITE);
  k.piece(frameOf(H, 3), 0.95, 0.95, y, 2.05, 0.03, R.door, MWALL.doors.panel, 0x2c4a3a);
  k.frustum(grow(H, 0.35), ht, sqr(250, -1349.15, 0.1), ht + 1.3, 0x3f4744);
  k.board(249.4, -1342.6, 3, y, 1.3, 'm-toll', 1.5, WHITE);
  k.F.box(249.2, y, -1346.9, 0.12, 1.1, 0.12, IRON); k.F.box(249.2, y + 1.1, -1346.9, 0.3, 0.36, 0.26, 0x8c2f25);
  col.addProp(249.2, -1346.9, 0.2, y + 1.4, 'post', false);
}

/** Dithers College: a brick chapel with a white spire at the head of a lawn, a hall down each side, a gate at the foot. */
function college(k: MainKit): void {
  const y = groundAt(-535, -1670), col = k.game.col;
  // The chapel.
  const C: Rect = { x0: -546, z0: -1717, x1: -524, z1: -1691 }, b0 = y + 1, wt = b0 + 9.5, cf = frameOf(C, 2);
  k.at(-535, -1700);
  k.solid(C, wt + 3, y - 1);
  for (let s = 0; s < 4; s++) {
    const f = frameOf(C, s);
    k.band(f, 0, f.len, y, b0, GRAN, R.granite, y);
    if (s & 1) k.facade(f, 0, f.len, b0, 9.5, 1, RED, 1, big(1.7, 6, 1.7), 4.6, s);
    else k.band(f, 0, f.len, b0, wt, RED, R.brick, b0, 1);
    if (s & 1) k.ledge(f, -0.4, f.len + 0.4, wt - 0.3, wt + 0.05, 0, 0.3, WHITE);
  }
  k.gableRoof(C, wt, 5.4, false, 0.4, 0x4a4f55, RED, R.brick, 1, R.seam);
  k.piece(cf, 11 - 1.2, 2.4, b0, 3.6, 0.03, R.door, MWALL.doors.hall, WHITE);
  for (const s of [4.2, 17.8]) k.piece(cf, s - 0.8, 1.6, b0 + 1.2, 4.4, 0.03, R.round, Math.round(s), 0xffffff);
  portico(k, cf, 4, 18, y, b0, 7, 3, 4);
  k.solid(frect(cf, 3.5, 18.5, 0, 3.4), b0, y - 1);
  // Tower, lantern, belfry, spire: brick to above the ridge, then white all the way up.
  const tx = -535, tz = -1694.5, t1 = wt + 7, t2 = t1 + 5.2, t3 = t2 + 4.2, tip = t3 + 25;
  for (let s = 0; s < 4; s++) {
    const a = frameOf(sqr(tx, tz, 3), s), b = frameOf(sqr(tx, tz, 2.4), s), c = frameOf(sqr(tx, tz, 1.9), s);
    k.band(a, 0, a.len, wt - 1, t1, RED, R.brick, wt - 1, 1);
    k.ledge(a, -0.15, a.len + 0.15, t1 - 0.1, t1 + 0.2, 0, 0.18, WHITE);
    k.band(b, 0, b.len, t1, t2, WHITE, R.clap, t1, 1);
    k.signAt(b, b.len / 2, t1 + 1.3, 2.7, 0.04, 'm-clock');
    k.ledge(b, -0.15, b.len + 0.15, t2 - 0.1, t2 + 0.2, 0, 0.18, WHITE);
    k.band(c, 0, c.len, t2, t3, WHITE, R.clap, t2, 1);
    k.vq(k.F, c, c.len / 2 - 0.6, c.len / 2 + 0.6, t2 + 0.8, t2 + 3.4, 0.03, 0x2e3338);
    k.ledge(c, -0.15, c.len + 0.15, t3 - 0.1, t3 + 0.2, 0, 0.18, WHITE);
  }
  k.frustum(sqr(tx, tz, 1.95), t3 + 0.2, sqr(tx, tz, 0.04), tip, 0xf4f1e8);
  k.F.cyl(tx, tip - 0.3, tz, 0.05, 0.03, 2.4, 0xc9a24a, 5, false);
  k.F.box(tx, tip + 1.2, tz, 0.9, 0.08, 0.08, 0xc9a24a);

  // The halls: three floors of sashes under a long roof, white doorcase to the lawn.
  for (const [x0, side] of [[-578, 1], [-510, 3]]) {
    const B: Rect = { x0, z0: -1686, x1: x0 + 14, z1: -1638 }, fh = 3.6, h0 = y + 0.9, ht = h0 + 3 * fh;
    k.at(x0 + 7, -1662);
    k.solid(B, ht + 2.5, y - 1);
    for (let s = 0; s < 4; s++) {
      const f = frameOf(B, s);
      k.band(f, 0, f.len, y, h0, GRAN, R.granite, y);
      if (s === side) k.facade(f, 0, f.len, h0, fh, 3, 0x9c4a3a, 1, WIN.sash, 3, 5 + s);
      else k.plainWall(f, 0, f.len, h0, ht, 0x9c4a3a, 0.95, R.brick, { st: WIN.sash, yb: h0, fh, floors: 3, pitch: 3, seed: s });
      if (s & 1) k.ledge(f, -0.3, f.len + 0.3, ht - 0.3, ht + 0.05, 0, 0.25, WHITE);
    }
    k.gableRoof(B, ht, 3.6, false, 0.35, 0x4a4f55, 0x9c4a3a, R.brick, 1, R.seam);
    for (const cz of [B.z0 + 1.2, B.z1 - 1.2]) k.F.box(x0 + 7, ht + 1.5, cz, 1.6, 3.6, 0.9, 0x8a4233, 0, 5);
    const lf = frameOf(B, side), m = lf.len / 2;
    k.fbox(lf, m - 1.5, m + 1.5, 0, 0.22, y, h0 + 3.3, WHITE, 5);
    k.piece(lf, m - 0.9, 1.8, h0, 2.7, 0.23, R.door, MWALL.doors.hall, 0x2c4a3a);
    k.F.tri(PX(lf, m - 1.7, 0.22), h0 + 3.3, PZ(lf, m - 1.7, 0.22), PX(lf, m + 1.7, 0.22), h0 + 3.3, PZ(lf, m + 1.7, 0.22), PX(lf, m, 0.22), h0 + 4.2, PZ(lf, m, 0.22), WHITE);
    k.fbox(lf, m - 1.8, m + 1.8, 0, 1.4, y, h0, STONE, 5);
  }

  // The lawn's paths, benches, and the gate at the foot of it.
  k.at(-535, -1660);
  const py = y + 0.05;
  strip(k, -562, -1686, -510, -1640, 2.2, py, PATH); strip(k, -562, -1640, -510, -1686, 2.2, py + 0.004, PATH);
  k.F.floor(-536.1, -1686.6, -533.9, -1629, py + 0.008, PATH);
  k.F.floor(-534, -1631.2, -486.5, -1629, py + 0.008, PATH);
  for (const bz of [-1676, -1650]) { bench(k, -538.2, bz, y, false); bench(k, -531.8, bz, y, false); }
  for (const gx of [-537.6, -532.4]) {
    k.F.box(gx, y, -1629, 0.95, 3.2, 0.95, dim(RED, 0.95)); k.F.box(gx, y + 3.2, -1629, 1.15, 0.22, 1.15, STONE); k.F.cyl(gx, y + 3.42, -1629, 0.3, 0.05, 0.5, STONE, 6, false);
    col.addBox(gx - 0.5, -1629.5, gx + 0.5, -1628.5, y + 3.4, y - 1);
  }
  for (let i = 0; i < 6; i++) {
    const a0 = Math.PI * (i / 6), a1 = Math.PI * ((i + 1) / 6);
    k.pipe(k.F, -535 - Math.cos(a0) * 2.6, y + 3.3 + Math.sin(a0) * 1.5, -1629, -535 - Math.cos(a1) * 2.6, y + 3.3 + Math.sin(a1) * 1.5, -1629, 0.05, IRON, 5);
  }
  for (const s of [0, 2]) { const f = frameOf({ x0: -537, z0: -1629.04, x1: -533, z1: -1628.96 }, s); k.signAt(f, 2, y + 3.45, 3.9, 0.01, 'm-college'); }
}

/** The depot, its platform, a water tower, and what was left on the sidings. */
function depot(k: MainKit): void {
  const D: Rect = { x0: 92, z0: -1887, x1: 122, z1: -1878.5 }, y = groundAt(107, -1882), col = k.game.col, BUFF = 0xcdb37a, GREEN = 0x3a5244, wt = y + 4.1;
  k.at(107, -1885);
  k.F.box(107, y, -1889, 48, 0.42, 4, CONC);
  col.addBox(83, -1891, 131, -1887, y + 0.42, y - 1);
  k.solid(D, wt + 2, y - 1);
  for (let s = 0; s < 4; s++) {
    const f = frameOf(D, s), n = Math.floor(f.len / 3.4);
    k.band(f, 0, f.len, y, y + 1.1, GREEN, R.clap, y, 1);
    k.band(f, 0, f.len, y + 1.1, wt, BUFF, R.clap, y + 1.1, s ? 0.96 : 1);
    for (let i = 0; i < n; i++) {
      const sx = ((i + 0.5) * f.len) / n;
      if (!(s & 1) && i % 3 === 1) k.piece(f, sx - 0.6, 1.2, y, 2.5, 0.03, R.door, MWALL.doors.hall + 8 * (i % 3), GREEN);
      else k.piece(f, sx - 0.5, 1, y + 1.1, 1.9, 0.03, R.house, i * 5 + s, WHITE);
    }
    if (s & 1) k.signAt(f, f.len / 2, wt - 1.3, 3.4, 0.04, 'm-depot');
  }
  // The operator's bay on the track side, and the roof: a low hip carried far out over the platform on every side.
  const nf = frameOf(D, 0);
  k.fbox(nf, 13.6, 16.4, 0, 0.8, y, wt, BUFF, 4);
  k.piece(nf, 14.3, 1.4, y + 1.1, 1.9, 0.81, R.house, 6, WHITE);
  k.frustum(grow(D, 3.2), wt - 0.5, { x0: D.x0 + 5, z0: -1882.85, x1: D.x1 - 5, z1: -1882.65 }, wt + 3.3, 0x6a7a70, R.seam);
  k.board(107, -1890.5, 0, y + 0.42, 3.4, 'm-depot', 2.3, 0x3a5244);
  if (!k.low) {
    const [u, v] = [D.x0 - 3.2, D.z0 - 3.2];
    k.F.quad(u, wt - 0.53, v, D.x1 + 3.2, wt - 0.53, v, D.x1 + 3.2, wt - 0.53, D.z1 + 3.2, u, wt - 0.53, D.z1 + 3.2, 0xd9d4c4, 0, 0, 1, 1, 0.8);
    for (let s = 2; s < 30; s += 5.2) for (const o of [0.05, 8.45]) k.pipe(k.F, D.x0 + s, wt - 2, D.z0 + o, D.x0 + s, wt - 0.9, D.z0 + o + (o < 1 ? -2.6 : 2.6), 0.07, GREEN, 4);
  }
  for (const bx of [88, 126]) bench(k, bx, -1888.2, y + 0.42, true);

  // The water tower: a cedar tank on six legs.
  const wx = 138, wz = -1882, ty = y + 7.5;
  k.at(wx, wz);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; k.pipe(k.F, wx + Math.cos(a) * 3.3, y, wz + Math.sin(a) * 3.3, wx + Math.cos(a) * 2.6, ty, wz + Math.sin(a) * 2.6, 0.14, 0x4a3a2c, 5); }
  k.F.cyl(wx, ty, wz, 3.1, 3.1, 0.25, 0x4a3a2c, 12, false);
  k.F.cyl(wx, ty + 0.25, wz, 3, 3.15, 4.8, 0x8a6442, 12, false);
  for (const hy of [1, 2.6, 4.2]) k.F.cyl(wx, ty + 0.25 + hy, wz, 3.2, 3.2, 0.1, IRON, 12, false);
  k.F.cyl(wx, ty + 5.05, wz, 3.5, 0.2, 1.9, 0x3f4744, 12, false);
  k.pipe(k.F, wx, ty + 0.6, wz - 3, wx, ty - 1.6, wz - 7.4, 0.16, IRON, 6);
  col.addBox(wx - 3.3, wz - 3.3, wx + 3.3, wz + 3.3, ty + 5, y - 1);

  // Boxcars and a flat on the sidings, clear of every crossing.
  const CAR = [0x7a3b2e, 0x6a4a36, 0x3f5a4a, 0x8a6a2e, 0x55606a];
  const cars: [number, number, number][] = [[2, -4.6, 3], [100, -4.6, 2], [-196, 4.6, 2], [-88, 4.6, 1], [112, 4.6, 0]];
  let n = 0;
  for (const [x0, dz, count] of cars) for (let i = 0; i < Math.max(1, count); i++, n++) {
    const x = x0 + i * 13.6, z = RAIL.z + dz, g = groundAt(x, z) + 0.3, hex = CAR[n % CAR.length], flatcar = count === 0;
    k.at(x, z);
    for (const t of [-4.2, 4.2]) k.F.box(x + t, g, z, 2.4, 0.75, 2.2, 0x26282b, 0, 4);
    k.F.box(x, g + 0.75, z, 12.6, 0.3, 2.7, 0x2e3033);
    if (flatcar) { for (let j = 0; j < 3; j++) k.pipe(k.F, x - 5.5, g + 1.45 + (j === 2 ? 0.75 : 0), z + (j === 2 ? 0 : j ? 0.48 : -0.48), x + 5.5, g + 1.45 + (j === 2 ? 0.75 : 0), z + (j === 2 ? 0 : j ? 0.48 : -0.48), 0.42, 0x7a5a3c, 7); }
    else {
      k.F.box(x, g + 1.05, z, 12.4, 2.9, 2.8, hex, 0, 5);
      for (const sg of [-1, 1]) k.F.box(x + 0.4, g + 1.15, z + sg * 1.42, 2.3, 2.6, 0.06, dim(hex, 1.2), 0, 4);
      k.F.box(x, g + 3.95, z, 12, 0.08, 0.6, 0x3a3a3a);
    }
    col.addBox(x - 6.3, z - 1.4, x + 6.3, z + 1.4, g + (flatcar ? 2.4 : 3.9), g - 1);
  }
}

/** A metal shed on a lot by the Thruway or in the yard. */
function shed(k: MainKit, lot: Lot, rng: RNG): void {
  const r = lot.rect, L = frameOf(r, lot.face), w = Math.min(L.len - 8, rng.range(18, 32)), D = Math.min(L.depth - 12, rng.range(12, 20));
  if (w < 10 || D < 8) return;
  const s0 = rng.range(3, L.len - w - 3), br = cut(r, lot.face, s0, s0 + w, 9, 9 + D), y = groundAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
  const H = rng.range(5, 7.5), hex = rng.pick([0xb8bcb6, 0x8fa0a8, 0xa9a08a, 0x7f8c7a, 0xb0563f, 0xc9c4b4]);
  k.at((br.x0 + br.x1) / 2, (br.z0 + br.z1) / 2);
  k.solid(br, y + H, y - 1);
  for (let s = 0; s < 4; s++) { const f = frameOf(br, lot.face + s); k.band(f, 0, f.len, y, y + H, hex, R.seam, y, s ? 0.93 : 1, 0, H + 0.01); k.vq(k.F, f, 0, f.len, y + H - 0.25, y + H + 0.05, 0.03, dim(hex, 0.7)); }
  const f = frameOf(br, lot.face), n = Math.max(1, Math.floor(w / 9));
  for (let i = 0; i < n; i++) k.piece(f, 2 + i * ((w - 8) / n), 3.6, y, 3.9, 0.03, R.door, MWALL.doors.garage, 0xe6e2d6);
  k.piece(f, w - 2.4, 1, y, 2.15, 0.03, R.door, MWALL.doors.steel);
  k.F.floor(br.x0, br.z0, br.x1, br.z1, y + H, 0x8d9092);
}

/** Idle Hands: pumps under a canopy, a diner the length of a truck, and a sign you can read from the next exit. */
function truckStop(k: MainKit, lot: Lot): void {
  const r = lot.rect, L = frameOf(r, lot.face), y = groundAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2), w = Math.min(L.len - 6, 24), s0 = (L.len - w) / 2;
  const br = cut(r, lot.face, s0, s0 + w, L.depth - 12, L.depth - 3), f = frameOf(br, lot.face), H = 4.4, hex = 0x9c3a2c;
  k.at((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
  k.solid(br, y + H, y - 1);
  for (let s = 0; s < 4; s++) {
    const sf = frameOf(br, lot.face + s), n = Math.floor(sf.len / 3);
    k.band(sf, 0, sf.len, y, y + H, hex, R.clap, y, s ? 0.94 : 1);
    for (let i = 0; i < n; i++) if (s || i !== (n >> 1)) k.piece(sf, ((i + 0.5) * sf.len) / n - 0.9, 1.8, y + 1, 1.7, 0.03, R.house, i * 3 + s, WHITE);
    k.ledge(sf, -0.2, sf.len + 0.2, y + H - 0.3, y + H + 0.1, 0, 0.25, WHITE);
  }
  k.piece(f, w / 2 - 0.9, 1.8, y, 2.4, 0.04, R.door, MWALL.doors.shop, WHITE);
  k.signAt(f, w / 2, y + H + 0.1, 4.4, 0.1, 'm-truck');
  k.F.floor(br.x0 - 0.2, br.z0 - 0.2, br.x1 + 0.2, br.z1 + 0.2, y + H + 0.11, 0x55575a);
  // The canopy over three pump islands, out toward the road.
  const c = cut(r, lot.face, L.len / 2 - 9, L.len / 2 + 9, 6, 15), cy = y + 5;
  k.F.box((c.x0 + c.x1) / 2, cy, (c.z0 + c.z1) / 2, c.x1 - c.x0, 0.6, c.z1 - c.z0, 0xe9e4d6, 0, 7);
  k.F.box((c.x0 + c.x1) / 2, cy + 0.12, (c.z0 + c.z1) / 2, c.x1 - c.x0 + 0.06, 0.28, c.z1 - c.z0 + 0.06, 0xb33a2a, 0, 4);
  for (const [px, pz] of [[c.x0 + 1, c.z0 + 1], [c.x1 - 1, c.z0 + 1], [c.x0 + 1, c.z1 - 1], [c.x1 - 1, c.z1 - 1]]) { k.F.box(px, y, pz, 0.35, 5, 0.35, 0xd9d4c4, 0, 4); k.game.col.addProp(px, pz, 0.3, y + 5, 'post', false); }
  const cf = frameOf(c, lot.face);
  for (let i = 0; i < 3; i++) {
    const s = 3 + i * (cf.len - 6) / 2, x = PX(cf, s, -cf.depth / 2), z = PZ(cf, s, -cf.depth / 2);
    k.F.box(x, y, z, 1.2, 0.18, 1.2, CONC); k.F.box(x, y + 0.18, z, 0.55, 1.5, 0.55, 0xd9d4c4); k.F.box(x, y + 1.68, z, 0.6, 0.3, 0.6, 0xb33a2a);
    k.game.col.addProp(x, z, 0.5, y + 2, 'post', false);
  }
  // The pylon.
  const px = PX(L, 3.5, -3.5), pz = PZ(L, 3.5, -3.5);
  k.F.box(px, y, pz, 0.6, 19, 0.6, 0xd9d4c4, 0, 4);
  k.board(px, pz + 0.4, 2, y + 15.2, 7, 'm-truck', 0.3, 0xd9d4c4);
  k.game.col.addProp(px, pz, 0.5, y + 19, 'post', false);
}

function thruway(k: MainKit, lots: Lot[], first: number): void {
  // Gantries over both carriageways: the sign reads toward whoever is coming up to the exit.
  const X = -700, y = groundAt(X, -1240), GREY = 0x8d9296;
  for (const [z, face, name, extra] of [[-1238, 2, 'm-exit1', 'm-thru'], [-1352, 0, 'm-exit1', ''], [-1898, 2, 'm-exit2', 'm-thru'], [-2012, 0, 'm-exit2', '']] as [number, number, string, string][]) {
    k.at(X, z);
    for (const px of [X - 11.6, X + 11.6]) { k.F.box(px, y, z, 0.45, 7.6, 0.45, GREY, 0, 5); k.game.col.addProp(px, z, 0.35, y + 7.6, 'post', false).hard = true; }
    k.F.box(X, y + 6.4, z, 23.6, 0.16, 0.5, GREY); k.F.box(X, y + 7.4, z, 23.6, 0.16, 0.5, GREY);
    if (!k.low) for (let x = X - 11; x < X + 10.5; x += 2) k.pipe(k.F, x, y + 6.5, z, x + 2, y + 7.4, z, 0.05, GREY, 4);
    // Northbound traffic keeps to the east lanes, southbound to the west: the exit over the curb lane, the through sign beside it.
    const dir = face === 2 ? 1 : -1;
    for (const [nm, cx, w] of [[name, X + dir * 7.1, 5.6], [extra, X + dir * 2.2, 4]] as [string, number, number][]) {
      if (!nm) continue;
      const pr: Rect = { x0: cx - w / 2, z0: z - 0.3, x1: cx + w / 2, z1: z + 0.3 };
      k.signAt(frameOf(pr, face), w / 2, y + 5.8, w, 0.02, nm);
      k.vq(k.F, frameOf(pr, face + 2), 0, w, y + 5.8, y + 5.8 + w / 2.8, 0.02, 0x5a6064);
    }
  }
  // The lots by the exits and in the yard: one truck stop, the rest sheds, some left empty.
  let stop = -1, bd = 1e9;
  lots.forEach((l, i) => {
    if (l.district !== 'exits' || l.interior) return;
    const d = Math.hypot((l.rect.x0 + l.rect.x1) / 2 + 655, (l.rect.z0 + l.rect.z1) / 2 + 1335);
    if (d < bd && l.rect.x1 - l.rect.x0 > 28 && l.rect.z1 - l.rect.z0 > 28) { bd = d; stop = i; }
  });
  const keep: Rect = { x0: 78, z0: -1896, x1: 146, z1: -1866 };
  lots.forEach((l, i) => {
    if (l.district !== 'exits' && l.district !== 'yard') return;
    if (i === stop) { truckStop(k, l); return; }
    const rng = new RNG(64000 + first + i);
    if (l.interior || hits(l.rect, keep) || !rng.chance(0.7)) return;
    shed(k, l, rng);
  });
}

/** Fort Reluctance: a blockhouse of squared timber, its upper floor jutting out all round, with a gun that has never been fired in anger or at all. */
function fort(k: MainKit): void {
  const cx = 410, cz = -1452, y = groundAt(cx, cz), TIMB = 0x9a7a54, lo = sqr(cx, cz, 3.6), up = sqr(cx, cz, 4.4), y1 = y + 3.3, y2 = y1 + 3;
  k.at(cx, cz);
  k.solid(lo, y2, y - 1);
  k.F.box(cx, y - 0.3, cz, 7.6, 0.6, 7.6, 0x8f8d86, 0, 4);
  for (let s = 0; s < 4; s++) {
    const a = frameOf(lo, s), b = frameOf(up, s);
    k.band(a, 0, a.len, y + 0.3, y1, TIMB, R.timber, y + 0.3, s & 1 ? 0.92 : 1);
    k.band(b, 0, b.len, y1, y2, TIMB, R.timber, y1, s & 1 ? 0.92 : 1);
    k.hq(k.F, b, 0, b.len, -0.8, 0, y1, false, dim(TIMB, 0.5));
    for (const t of [0.25, 0.5, 0.75]) k.vq(k.F, b, b.len * t - 0.09, b.len * t + 0.09, y1 + 1.2, y1 + 1.9, 0.02, 0x1c1a18);
    if (s !== 2) for (const t of [0.3, 0.7]) k.vq(k.F, a, a.len * t - 0.3, a.len * t + 0.3, y + 1.7, y + 1.88, 0.02, 0x1c1a18);
  }
  k.piece(frameOf(lo, 2), 3.6 - 0.6, 1.2, y + 0.3, 2.1, 0.03, R.door, MWALL.doors.plank, 0x7a5a3c);
  k.frustum(grow(up, 0.5), y2, sqr(cx, cz, 0.05), y2 + 3.4, 0x4a4038);
  k.F.cyl(cx, y2 + 3.3, cz, 0.05, 0.03, 3.2, 0xd8d8d4, 5, false);
  k.vq(k.F, frameOf(sqr(cx, cz, 0.01), 1), 0, 1.3, y2 + 5.5, y2 + 6.3, 0, 0x8c2f25); k.vq(k.F, frameOf(sqr(cx, cz, 0.01), 1), 1.3, 0, y2 + 5.5, y2 + 6.3, 0, 0x8c2f25);
  k.board(cx - 8, cz + 12, 2, y, 2.6, 'm-fort', 1, 0x5a4a36);
  // The gun, trained on the footbridge.
  const gx = cx - 9, gz = cz + 4;
  k.F.box(gx, y, gz, 1.5, 0.5, 0.7, 0x5a4a36); k.pipe(k.F, gx + 0.5, y + 0.62, gz, gx - 1.5, y + 0.86, gz, 0.15, 0x26282b, 7);
  for (const sg of [-1, 1]) for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU, b = ((i + 1) / 8) * TAU; k.pipe(k.F, gx + Math.cos(a) * 0.5, y + 0.5 + Math.sin(a) * 0.5, gz + sg * 0.45, gx + Math.cos(b) * 0.5, y + 0.5 + Math.sin(b) * 0.5, gz + sg * 0.45, 0.04, 0x3a2e24, 4); }
  k.game.col.addBox(gx - 1.5, gz - 0.6, gx + 0.8, gz + 0.6, y + 1, y - 1);
  // The garrison's burying ground: five slates, and one that has not made its mind up.
  for (let i = 0; i < 6; i++) {
    const sx = cx + 9 + (i % 3) * 1.9, sz = cz + 6 + Math.floor(i / 3) * 2.6, g = groundAt(sx, sz), h = 0.75 + ((i * 7) % 4) * 0.08;
    k.F.box(sx, g - 0.1, sz, 0.62, h + 0.1, 0.1, 0x6f7378, 0, 5);
    if (i === 4) k.signAt(frameOf({ x0: sx - 0.31, z0: sz - 0.05, x1: sx + 0.31, z1: sz + 0.05 }, 2), 0.31, g + 0.12, 0.6, 0.004, 'm-stone');
  }
}

/** Lake Indecision's south shore: a ramp, a dock, and the camps. */
function lake(k: MainKit): void {
  const col = k.game.col;
  // The ramp follows the bank down into the water, a hand above it.
  k.at(-770, -1990);
  let pz = -1976, py = groundAt(-770, pz) + 0.08;
  for (let z = -1980; z >= -2008; z -= 4) {
    const gy = groundAt(-770, z) + 0.08;
    k.F.quad(-773, py, pz, -767, py, pz, -767, gy, z, -773, gy, z, CONC, 0, 0, 1, 1, 0.92 + ((z / 4) & 1) * 0.06);
    pz = z; py = gy;
  }
  k.board(-764.5, -1975, 2, groundAt(-764.5, -1975), 2.4, 'm-ramp', 1.2, 0x5a4a36);
  // The dock, on posts, and a skiff tied to it.
  const dy = -0.35;
  k.F.box(-758, dy - 0.15, -1996, 1.6, 0.15, 22, 0x8a6a4a, 0, 7);
  for (let z = -2005; z <= -1987; z += 6) for (const sx of [-0.7, 0.7]) k.F.cyl(-758 + sx, -2.6, z, 0.1, 0.1, 2.9, 0x4a3a2c, 5, true);
  col.addBox(-758.8, -2007, -757.2, -1985, dy, -3);
  k.F.box(-755.6, -0.85, -2002, 1.3, 0.42, 3.6, 0x3f6a5a, 0.12, 4); k.F.box(-755.6, -0.62, -2002, 1.05, 0.05, 3.2, 0x8a6a4a, 0.12, 1);
  // The camps.
  const rng = new RNG(5150), COLS = [0x4a5f4a, 0x7a3b2e, 0x6a4a36, 0x55606a, 0x8a7a54];
  for (const deg of [35, 52, 66, 106, 119]) {
    const a = (deg * Math.PI) / 180, x = LAKE.x + (LAKE.a + 30) * Math.cos(a), z = LAKE.z + (LAKE.b + 30) * Math.sin(a), y = groundAt(x, z);
    if (y < MAIN_Y - 0.4 || Math.abs(groundAt(x + 4, z + 4) - y) > 0.3 || Math.abs(groundAt(x - 4, z - 4) - y) > 0.3) continue;
    const br: Rect = { x0: x - 3.2, z0: z - 2.6, x1: x + 3.2, z1: z + 2.6 }, hex = rng.pick(COLS), top = y + 2.9, f = frameOf(br, 0);
    k.at(x, z);
    k.solid(br, top + 1, y - 1);
    for (let s = 0; s < 4; s++) {
      const sf = frameOf(br, s);
      k.vq(k.F, sf, 0, sf.len, y - 0.4, y + 0.35, 0, 0x6b6a64);
      k.band(sf, 0, sf.len, y + 0.35, top, hex, R.clap, y + 0.35, s ? 0.94 : 1);
      if (s) k.piece(sf, sf.len / 2 - 0.4, 0.8, y + 1.1, 1.3, 0.03, R.house, deg + s, WHITE);
    }
    // The door and the porch face the water.
    k.piece(f, 1.2, 0.9, y + 0.35, 2, 0.03, R.door, MWALL.doors.plank, 0xd8d2c4); k.piece(f, 4, 0.8, y + 1.1, 1.3, 0.03, R.house, deg, WHITE);
    k.fbox(f, 0, 6.4, 0, 1.8, y + 0.2, y + 0.35, 0x8a7a64, 7);
    for (const s of [0.1, 6.3]) k.fbox(f, s - 0.06, s + 0.06, 1.62, 1.74, y + 0.35, top - 0.3, 0x8a7a64, 4);
    k.sq(k.F, f, -0.2, 6.6, 0, top + 0.1, 2, top - 0.35, 0x3f4744); k.sq(k.F, f, -0.2, 6.6, 0, top + 0.08, 2, top - 0.37, 0x8a7a64, 0.7, 0, 0, 1, 1, true);
    k.gableRoof(br, top, 1.5, true, 0.3, 0x3f4744, hex, R.clap);
    k.F.cyl(x + 2, top + 0.6, z + 1.2, 0.09, 0.09, 1.5, 0x26282b, 5, true);
  }
}

/** The first thing over the bridge. */
function welcome(k: MainKit): void {
  const x = -47, z = -1067, y = groundAt(x, z);
  k.at(x, z);
  k.board(x, z, 2, y, 5, 'm-welcome', 1.5, WHITE);
  k.F.box(x, y, z + 0.9, 5.6, 0.3, 1, 0x5a4632); for (let i = 0; i < 6; i++) k.F.box(x - 2.2 + i * 0.9, y + 0.3, z + 0.9, 0.5, 0.28, 0.5, [0xd9a23a, 0xb33a2a, 0xe8e2d0][i % 3], 0, 5);
}

/**
 * Not on any map: a rubber duckling, a tenth the size of the one in the harbour, afloat on the mill pond at the very lip
 * of Threadbare Dam and pointed at the drop. It has been about to go over since the mill closed.
 */
function duckling(k: MainKit): void {
  const x = riverX(DAM_Z) + 9, z = DAM_Z - 2.3, y = POND_Y - 0.12, YEL = 0xf2c230;
  k.at(x, z);
  k.F.cyl(x, y, z, 0.42, 0.62, 0.3, YEL, 8, false); k.F.cyl(x, y + 0.3, z, 0.62, 0.5, 0.3, YEL, 8, false); k.F.cyl(x, y + 0.6, z, 0.5, 0.2, 0.14, YEL, 8, true);
  k.F.box(x, y + 0.45, z - 0.62, 0.3, 0.22, 0.3, YEL, 0.5);
  k.F.cyl(x, y + 0.55, z + 0.3, 0.26, 0.33, 0.25, YEL, 8, false); k.F.cyl(x, y + 0.8, z + 0.3, 0.33, 0.24, 0.22, YEL, 8, false); k.F.cyl(x, y + 1.02, z + 0.3, 0.24, 0.08, 0.08, YEL, 8, true);
  k.F.box(x, y + 0.74, z + 0.66, 0.26, 0.09, 0.26, 0xe8702a);
  for (const sg of [-1, 1]) k.F.box(x + sg * 0.19, y + 0.9, z + 0.56, 0.07, 0.07, 0.07, 0x111111);
}

export function buildMainlandPlaces(lots: Lot[], first: number): WorldPart {
  const k = mainKit();
  square(k);
  opera(k);
  footbridge(k);
  college(k);
  depot(k);
  thruway(k, lots, first);
  fort(k);
  lake(k);
  welcome(k);
  duckling(k);
  k.finish();
  return {};
}

void TAR; void SLATE; void frect;
