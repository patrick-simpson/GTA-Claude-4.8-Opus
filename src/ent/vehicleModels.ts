// The cars as shapes. Each of the eleven kinds is built once, in code, into
// three merged geometries (paint, trim, glass) plus the points the vehicle
// code needs: wheel centers, lamps, beacon, the driver's eye.
//
// Local frame: the car faces +Z, Y is up, y = 0 is the road under the tires,
// the origin is midway between the axles and +X is the car's LEFT side.
//
// How a body is made:
//   * The lower body is a loft: a 17-point cross-section ring swept through
//     stations from tail to nose. The ring's width tapers at both ends (plan
//     view), tucks under at the sill, leans in at the shoulder and bulges over
//     the wheels. Its lower edge follows the wheel arches, and the same ring
//     carries the wheel-well liner and the underbody, so the arches are real
//     holes with something dark behind them.
//   * The greenhouse is a faceted box with tumblehome, set on top. Each window
//     is a hole in a painted frame with a glass pane just behind it.
//   * Everything else (bumpers, lamps, seams, signs, tow gear) is small boxes,
//     beams and strips.
// Normals are area-weighted across soft edges, which turns the small chamfers
// into rounded corners while the large panels stay flat.

import * as THREE from 'three';
import { SPECS, type VehicleKind, type VehicleSpec } from './vehicleSpecs';
import { clamp01, lerp, smooth } from '../core/util';

export interface VehicleModel {
  /** Body panels that take the paint. Attributes: position, normal, color. The vertex colors are white-to-grey shading multipliers (baked ambient occlusion, panel shading); the per-instance color supplies the hue. */
  paint: THREE.BufferGeometry;
  /** Everything unpainted, in final vertex colors: bumpers, grille, trim, underbody, lamp lenses, mirrors, roof signs, light bars, tow gear. */
  trim: THREE.BufferGeometry;
  /** Windows. Rendered dark and glossy so they mirror the sky. Attributes: position, normal (color optional). */
  glass: THREE.BufferGeometry;
  /** Wheel centers in local space. First four are front-left, front-right, rear-left, rear-right; extra rear wheels (dual axles) follow and never steer. */
  wheels: THREE.Vector3[];
  /** Local centers of the head lamps and tail lamps, for glow sprites. */
  head: THREE.Vector3[];
  tail: THREE.Vector3[];
  /** Roof beacon / light bar center (cruiser, tow truck), else null. */
  beacon: THREE.Vector3 | null;
  /** Driver's eye point, local. */
  seat: THREE.Vector3;
}

type P2 = [number, number];
type V3 = [number, number, number];
type RGB = [number, number, number];

// THREE.Color converts the sRGB hex to the linear values vertex colors are read as.
const rgb = (hex: number): RGB => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const WHITE: RGB = [1, 1, 1];
const RUBBER = rgb(0x191b1f), UNDER = rgb(0x0c0d0f), SEAM = rgb(0x111316), CHROME = rgb(0xcfd0ca),
  STEEL = rgb(0x555a61), LAMP = rgb(0xfff4d4), TAIL = rgb(0xc9301c), AMBER = rgb(0xf0a202),
  BONE = rgb(0xf2e8cf), MUSTARD = rgb(0xf0a202), VERMILION = rgb(0xe4572e), BLUE = rgb(0x2f6db0),
  GLASS = rgb(0x0d1420);

/** Shoulder chamfer: the rounded edge where the body side turns into hood, belt or deck. */
const CH = 0.05;
/** How far the glass sits behind its frame. */
const GLASS_INSET = 0.012;

/** Piecewise-linear lookup through points sorted by x. */
function pl(pts: P2[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const a = pts[i - 1], b = pts[i];
      return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0] || 1);
    }
  }
  return pts[pts.length - 1][1];
}

class Buf { pos: number[] = []; col: number[] = []; }

/** Triangle soup in three groups, with mirroring and a handful of solid primitives. */
class Mesher {
  paint = new Buf();
  trim = new Buf();
  glass = new Buf();
  /** Baked shading for painted vertices, by height and position along the car. */
  shade: (y: number, z: number) => number = () => 1;
  private flip = false;

  tri(g: Buf, a: V3, b: V3, c: V3, col: RGB, shaded = g === this.paint): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    // The loft collapses ring segments wherever there is no wheel arch; drop those.
    if (nx * nx + ny * ny + nz * nz < 1e-13) return;
    const m = this.flip ? -1 : 1;
    const vs = this.flip ? [a, c, b] : [a, b, c];
    for (const v of vs) {
      g.pos.push(v[0] * m, v[1], v[2]);
      const s = shaded ? this.shade(v[1], v[2]) : 1;
      g.col.push(col[0] * s, col[1] * s, col[2] * s);
    }
  }
  quad(g: Buf, a: V3, b: V3, c: V3, d: V3, col: RGB, shaded?: boolean): void {
    this.tri(g, a, b, c, col, shaded);
    this.tri(g, a, c, d, col, shaded);
  }
  /** Convex polygon as a fan, wound so that it faces along `hint`. */
  poly(g: Buf, pts: V3[], col: RGB, hint: V3, shaded?: boolean): void {
    const n = newell(pts);
    const p = n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0 ? pts.slice().reverse() : pts;
    for (let i = 1; i + 1 < p.length; i++) this.tri(g, p[0], p[i], p[i + 1], col, shaded);
  }
  /** Run a builder twice: as written (the car's left) and mirrored to the right. */
  both(fn: () => void): void { fn(); this.flip = true; fn(); this.flip = false; }
  /** Run a builder mirrored only: the curb side. */
  right(fn: () => void): void { this.flip = true; fn(); this.flip = false; }

  /** Axis-aligned box: center and full size. */
  box(g: Buf, c: V3, s: V3, col: RGB, shaded?: boolean): void {
    this.beam(g, [c[0], c[1], c[2] - s[2] / 2], [c[0], c[1], c[2] + s[2] / 2], s[0], s[1], col, shaded);
  }
  /** Box of width w and height h running from a to b. */
  beam(g: Buf, a: V3, b: V3, w: number, h: number, col: RGB, shaded?: boolean): void {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const ref = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const sx = new THREE.Vector3().crossVectors(ref, d).normalize().multiplyScalar(w / 2);
    const sy = new THREE.Vector3().crossVectors(d, sx).normalize().multiplyScalar(h / 2);
    const k = (e: V3, i: number, j: number): V3 =>
      [e[0] + sx.x * i + sy.x * j, e[1] + sx.y * i + sy.y * j, e[2] + sx.z * i + sy.z * j];
    const A = [k(a, -1, -1), k(a, 1, -1), k(a, 1, 1), k(a, -1, 1)];
    const B = [k(b, -1, -1), k(b, 1, -1), k(b, 1, 1), k(b, -1, 1)];
    this.poly(g, A, col, [-d.x, -d.y, -d.z], shaded);
    this.poly(g, B, col, [d.x, d.y, d.z], shaded);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const out: V3 = [A[i][0] + A[j][0] - 2 * a[0], A[i][1] + A[j][1] - 2 * a[1], A[i][2] + A[j][2] - 2 * a[2]];
      this.poly(g, [A[i], A[j], B[j], B[i]], col, out, shaded);
    }
  }

  /**
   * A window: a flat convex polygon becomes a painted frame around a hole,
   * with a glass pane a little larger than the hole set just behind it (so
   * no slit opens at a glancing angle and nothing is coplanar).
   */
  framed(pts: V3[], hint: V3, margin: (a: V3, b: V3) => number): void {
    let p = pts;
    let n = newell(p);
    if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) { p = pts.slice().reverse(); n = [-n[0], -n[1], -n[2]]; }
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const N = new THREE.Vector3(n[0] / nl, n[1] / nl, n[2] / nl);
    const O = new THREE.Vector3(...p[0]);
    const U = new THREE.Vector3(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]).normalize();
    const V = new THREE.Vector3().crossVectors(N, U);
    const q: P2[] = p.map((v) => {
      const dx = v[0] - O.x, dy = v[1] - O.y, dz = v[2] - O.z;
      return [dx * U.x + dy * U.y + dz * U.z, dx * V.x + dy * V.y + dz * V.z];
    });
    const m = p.map((v, i) => margin(v, p[(i + 1) % p.length]));
    const hole = inset(q, m), pane = inset(q, m.map((x) => Math.max(0.004, x - 0.02)));
    if (!hole || !pane) { this.poly(this.paint, p, WHITE, hint); return; }
    const lift = (w: P2, off: number): V3 => [
      O.x + U.x * w[0] + V.x * w[1] - N.x * off,
      O.y + U.y * w[0] + V.y * w[1] - N.y * off,
      O.z + U.z * w[0] + V.z * w[1] - N.z * off,
    ];
    const h3 = hole.map((w) => lift(w, 0));
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      this.quad(this.paint, p[i], p[j], h3[j], h3[i], WHITE);
    }
    const g3 = pane.map((w) => lift(w, GLASS_INSET));
    for (let i = 1; i + 1 < g3.length; i++) this.tri(this.glass, g3[0], g3[i], g3[i + 1], GLASS);
  }
}

function newell(p: V3[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

const area2 = (q: P2[]): number => {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; a += p[0] * r[1] - r[0] * p[1]; }
  return a;
};

/** Shrink a counter-clockwise convex polygon by a margin per edge. Null if it collapses. */
function inset(q: P2[], m: number[]): P2[] | null {
  const n = q.length;
  const pt: P2[] = [], dir: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = q[i], b = q[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: P2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    dir.push(d);
    pt.push([a[0] - d[1] * m[i], a[1] + d[0] * m[i]]);
  }
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n;
    const cr = dir[h][0] * dir[i][1] - dir[h][1] * dir[i][0];
    if (Math.abs(cr) < 1e-6) { out.push(pt[i]); continue; }
    const t = ((pt[i][0] - pt[h][0]) * dir[i][1] - (pt[i][1] - pt[h][1]) * dir[i][0]) / cr;
    out.push([pt[h][0] + dir[h][0] * t, pt[h][1] + dir[h][1] * t]);
  }
  // A margin wider than the polygon turns it inside out or swaps its corners.
  if (area2(out) < 0.004) return null;
  for (let i = 0; i < n; i++) {
    const a = out[i], b = out[(i + 1) % n];
    if ((b[0] - a[0]) * dir[i][0] + (b[1] - a[1]) * dir[i][1] <= 0.005) return null;
  }
  return out;
}

/** Clip a convex polygon in (z, y) to the slab z0 <= z <= z1. */
function clipZ(poly: P2[], z0: number, z1: number): P2[] {
  let p = poly;
  for (const [lim, sgn] of [[z0, 1], [z1, -1]] as P2[]) {
    const out: P2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const da = (a[0] - lim) * sgn, db = (b[0] - lim) * sgn;
      if (da >= 0) out.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const t = da / (da - db);
        out.push([lim, a[1] + (b[1] - a[1]) * t]);
      }
    }
    p = out;
  }
  return p;
}

/**
 * Soup to BufferGeometry. A corner's normal is the area-weighted sum of every
 * face that touches the same point and lies within the crease angle of its own
 * face: big panels stay flat, chamfers shade as rounds, real creases stay hard.
 */
function finish(b: Buf, creaseDeg: number, bake: boolean): THREE.BufferGeometry {
  const pos = new Float32Array(b.pos), col = new Float32Array(b.col);
  const nt = pos.length / 9;
  const fa = new Float32Array(nt * 3), fu = new Float32Array(nt * 3);
  const at = new Map<string, number[]>();
  const keys: string[] = [];
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fa[t * 3] = nx; fa[t * 3 + 1] = ny; fa[t * 3 + 2] = nz;
    fu[t * 3] = nx / l; fu[t * 3 + 1] = ny / l; fu[t * 3 + 2] = nz / l;
    for (let k = 0; k < 3; k++) {
      const key = Math.round(pos[o + k * 3] * 2000) + ',' + Math.round(pos[o + k * 3 + 1] * 2000) + ',' + Math.round(pos[o + k * 3 + 2] * 2000);
      keys.push(key);
      const list = at.get(key);
      if (list) list.push(t); else at.set(key, [t]);
    }
  }
  const cosC = Math.cos(creaseDeg * Math.PI / 180);
  const nor = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    const ax = fu[t * 3], ay = fu[t * 3 + 1], az = fu[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      let x = 0, y = 0, z = 0;
      for (const u of at.get(keys[t * 3 + k])!) {
        if (fu[u * 3] * ax + fu[u * 3 + 1] * ay + fu[u * 3 + 2] * az < cosC) continue;
        x += fa[u * 3]; y += fa[u * 3 + 1]; z += fa[u * 3 + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      const o = t * 9 + k * 3;
      nor[o] = x / l; nor[o + 1] = y / l; nor[o + 2] = z / l;
      if (bake) {
        // Sky-facing panels a touch brighter, undersides darker: the car keeps its form in flat light.
        const s = 0.9 + 0.1 * (y / l);
        col[o] *= s; col[o + 1] *= s; col[o + 2] *= s;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

interface Cab {
  /** Greenhouse side profile: rear base, rear roof edge, front roof edge, windshield base (z). */
  z0: number; zr0: number; zr1: number; z1: number;
  roof: number;
  /** Pillar centers between side windows (z, ascending). */
  pillars: number[];
  /** Stretches of the side with no window. */
  blank?: P2[];
  /** Frame widths above and below the glass. */
  mTop?: number; mBot?: number;
  rear?: boolean;
}

interface Cfg {
  /** Upper edge of the lower body, tail to nose: deck, belt line, hood. */
  top: P2[];
  /** Underside. */
  bot: P2[];
  cab: Cab;
  /** Fraction of the width lost at the nose and the tail (plan view), over `corner` meters. */
  taperF: number; taperR: number; corner: number;
  /** How far the fenders stand proud of the doors. */
  flare: number;
  /** Sill tuck-under and shoulder lean-in. */
  tuck: number; lean: number;
  /** Hood and deck crown height. */
  crown: number;
  /** Bumper depth: the loft stops this short of the overall length. */
  bump: number;
  /** Clearance between tire and arch. */
  gap: number;
  /** How much narrower the roof is than the belt, per side. */
  tumble: number;
  /** Extra inset of the greenhouse (boxes whose cabin runs into the tapered ends). */
  cabIn: number;
  /** Open load bed: from, to, floor height. */
  bed?: [number, number, number];
  /** Twin rear wheels: deeper wells. */
  dual?: boolean;
  /** Stretch of the body side rendered in bone instead of paint (the cruiser's doors). */
  panel?: P2;
}

const cfg = (o: Partial<Cfg> & Pick<Cfg, 'top' | 'bot' | 'cab'>): Cfg => ({
  taperF: 0.16, taperR: 0.12, corner: 0.45, flare: 0.035, tuck: 0.05, lean: 0.03, crown: 0.03,
  bump: 0.08, gap: 0.06, tumble: 0.13, cabIn: 0, ...o,
});
const underside = (zF: number, y: number, rise: number): P2[] =>
  [[-zF, y + rise], [-zF + 0.35, y], [zF - 0.35, y], [zF, y + rise - 0.02]];

class Car extends Mesher {
  readonly hw: number; readonly zF: number; readonly zR: number; readonly fa: number;
  readonly Ra: number; readonly xin: number; readonly peak: number;
  head: THREE.Vector3[] = [];
  tail: THREE.Vector3[] = [];
  beacon: THREE.Vector3 | null = null;
  // Greenhouse numbers, filled in by cabin() and reused by the details.
  yS = 0; cabRef = 0; cabW = 0;

  constructor(readonly s: VehicleSpec, readonly c: Cfg) {
    super();
    this.hw = s.width / 2;
    this.zF = s.length / 2 - c.bump;
    this.zR = -this.zF;
    this.fa = s.wheelbase / 2;
    this.Ra = s.wheelR + c.gap;
    this.peak = s.wheelR + this.Ra + 0.09;
    this.xin = s.track / 2 - s.wheelW * (c.dual ? 1.6 : 0.5) - 0.06;
    const ref = 0.75 * this.top(0) - 0.15;
    this.shade = (y, z) => {
      // Darker toward the road, darkest around the wheel openings.
      const d = Math.hypot(this.axle(z), y - s.wheelR);
      return (0.6 + 0.4 * smooth((y - 0.15) / ref)) * (0.7 + 0.3 * clamp01((d - this.Ra) / 0.16));
    };
  }

  top(z: number): number { return pl(this.c.top, z); }
  bot(z: number): number { return pl(this.c.bot, z); }
  /** Distance along the car to the nearer axle. */
  axle(z: number): number { return Math.min(Math.abs(z - this.fa), Math.abs(z + this.fa)); }
  /** Shoulder height: the belt line, lifted into a fender wherever a wheel would otherwise break through the hood. */
  shoulder(z: number): number {
    const t = this.top(z);
    return t + Math.max(0, this.peak - t) * (1 - smooth((this.axle(z) - this.Ra) / 0.45));
  }
  planW(z: number): number {
    const c = this.c, dF = (this.zF - z) / c.corner, dR = (z - this.zR) / c.corner;
    let k = 1;
    if (dF < 1) k -= c.taperF * (1 - dF) * (1 - dF);
    if (dR < 1) k -= c.taperR * (1 - dR) * (1 - dR);
    return this.hw * k;
  }
  /**
   * Half-width of the body side at a height: sill tucked under, widest below
   * the middle, leaning in to the shoulder. Over a wheel the lean and the door
   * inset both fade out, so the fender stands square over the tire and covers
   * it from above.
   */
  sideX(z: number, y: number): number {
    const c = this.c, yB = this.bot(z), yS = this.shoulder(z) - CH;
    const t = clamp01((y - yB) / (yS - yB));
    const flat = smooth(this.axle(z) / (this.Ra * 1.7));
    const prof = t < 0.45 ? -c.tuck * (1 - smooth(t / 0.45)) : -c.lean * flat * ((t - 0.45) / 0.55) ** 2;
    return this.planW(z) + prof - c.flare * flat;
  }
  archY(z: number): number {
    const d = this.axle(z);
    return d < this.Ra - 1e-4 ? this.s.wheelR + Math.sqrt(this.Ra * this.Ra - d * d) : 0;
  }
  private inBed(z: number): boolean {
    const b = this.c.bed;
    return !!b && z >= b[0] - 1e-6 && z <= b[1] + 1e-6;
  }

  /** Cross-section at z: from the underside's center line, out and up the left side, over the top and down the right. */
  private ring(z: number): V3[] {
    const c = this.c, yB = this.bot(z), yT = this.top(z), ySh = this.shoulder(z), yS = ySh - CH;
    const yL = Math.max(yB, this.archY(z));
    const x3 = this.sideX(z, yL), xi = Math.min(this.xin, x3 - 0.05);
    const y4 = lerp(yL, yS, 0.5), x5 = this.sideX(z, yS);
    let x7 = (x5 - CH) * 0.62, y7 = yT + c.crown * 0.8, y8 = yT + c.crown;
    if (this.inBed(z)) { x7 = x5 - CH - 0.07; y7 = y8 = c.bed![2]; }
    const half: P2[] = [[0, yB], [xi, yB], [xi, yL], [x3, yL], [this.sideX(z, y4), y4], [x5, yS], [x5 - CH, ySh], [x7, y7], [0, y8]];
    const r: V3[] = [];
    for (let i = 0; i < 9; i++) r.push([half[i][0], half[i][1], z]);
    for (let i = 7; i >= 0; i--) r.push([-half[i][0], half[i][1], z]);
    return r;
  }

  private stations(): number[] {
    const c = this.c, zs: number[] = [];
    for (const p of c.top) zs.push(p[0]);
    for (const p of c.bot) zs.push(p[0]);
    for (const d of [0, 0.05, 0.14, 0.28, c.corner]) zs.push(this.zF - d, this.zR + d);
    for (const zc of [this.fa, -this.fa]) {
      for (let k = 0; k <= 8; k++) zs.push(zc + this.Ra * Math.cos(Math.PI * k / 8));
      for (const d of [0.22, 0.45]) zs.push(zc + this.Ra + d, zc - this.Ra - d);
    }
    // A pair of stations a few millimeters apart makes the bed's end walls.
    if (c.bed) zs.push(c.bed[0] - 0.004, c.bed[0], c.bed[1], c.bed[1] + 0.004);
    if (c.panel) zs.push(c.panel[0], c.panel[1]);
    const s = zs.filter((z) => z >= this.zR - 1e-6 && z <= this.zF + 1e-6).sort((a, b) => a - b);
    const out: number[] = [];
    for (const z of s) {
      const last = out[out.length - 1];
      if (out.length && z - last < 1.5e-3) continue;
      if (out.length && z - last > 0.8) { const n = Math.ceil((z - last) / 0.8); for (let i = 1; i < n; i++) out.push(last + (z - last) * i / n); }
      out.push(z);
    }
    return out;
  }

  /** The lofted lower body, wheel wells and underbody included. */
  body(): void {
    const zs = this.stations(), rings = zs.map((z) => this.ring(z)), panel = this.c.panel;
    for (let i = 0; i + 1 < zs.length; i++) {
      const zm = (zs[i] + zs[i + 1]) / 2, a = rings[i], b = rings[i + 1];
      const door = !!panel && zm > panel[0] && zm < panel[1];
      for (let j = 0; j < 16; j++) {
        const seg = j < 8 ? j : 15 - j;
        if (seg < 3) this.quad(this.trim, a[j], a[j + 1], b[j + 1], b[j], UNDER);
        else if (door && seg < 5) this.quad(this.trim, a[j], a[j + 1], b[j + 1], b[j], BONE, true);
        else this.quad(this.paint, a[j], a[j + 1], b[j + 1], b[j], WHITE);
      }
    }
    const f = rings[rings.length - 1], r = rings[0];
    const cf: V3 = [0, (this.bot(this.zF) + this.top(this.zF)) / 2, this.zF];
    const cr: V3 = [0, (this.bot(this.zR) + this.top(this.zR)) / 2, this.zR];
    for (let j = 0; j < 16; j++) {
      this.tri(this.paint, cf, f[j], f[j + 1], WHITE);
      this.tri(this.paint, cr, r[j + 1], r[j], WHITE);
    }
  }

  /** Half-width of the greenhouse at a height. */
  cabX(y: number): number {
    return this.cabW - this.c.tumble * clamp01((y - this.cabRef) / (this.yS - this.cabRef));
  }
  /** Where the windshield is at a height. */
  shieldZ(y: number): number {
    const k = this.c.cab, yb = this.top(k.z1) - 0.03;
    return lerp(k.z1, k.zr1, (y - yb) / (this.yS - yb));
  }

  cabin(): void {
    const c = this.c, k = c.cab, rc = 0.045;
    const yS = this.yS = k.roof - rc;
    const yb0 = this.top(k.z0) - 0.03, yb1 = this.top(k.z1) - 0.03;
    this.cabRef = Math.min(yb0, yb1);
    this.cabW = this.hw - c.flare - c.lean - CH - 0.02 - c.cabIn;
    const mTop = k.mTop ?? 0.055, mBot = k.mBot ?? 0.045;
    const side: P2[] = [[k.z0, yb0], [k.zr0, yS], [k.zr1, yS], [k.z1, yb1]];
    const baseAt = (z: number): number => lerp(yb0, yb1, (z - k.z0) / (k.z1 - k.z0));
    const margin = (a: V3, b: V3): number => {
      if (Math.abs(a[2] - b[2]) < 1e-4) return 0.035;
      return (a[1] + b[1]) / 2 < baseAt((a[2] + b[2]) / 2) + 0.02 ? mBot : mTop;
    };
    const bounds = [k.z0, ...k.pillars, k.z1];
    this.both(() => {
      for (let i = 0; i + 1 < bounds.length; i++) {
        const zm = (bounds[i] + bounds[i + 1]) / 2;
        const pts = clipZ(side, bounds[i], bounds[i + 1]).map((p): V3 => [this.cabX(p[1]), p[1], p[0]]);
        if (pts.length < 3) continue;
        if (k.blank?.some((r) => zm > r[0] && zm < r[1])) this.poly(this.paint, pts, WHITE, [1, 0, 0]);
        else this.framed(pts, [1, 0, 0], margin);
      }
    });
    const xb1 = this.cabX(yb1), xb0 = this.cabX(yb0), xt = this.cabX(yS);
    const endMargin = (a: V3, b: V3): number => {
      if (Math.abs(a[0] - b[0]) < 0.3) return 0.05;
      return (a[1] + b[1]) / 2 < yS - 0.05 ? mBot : mTop;
    };
    this.framed([[xb1, yb1, k.z1], [-xb1, yb1, k.z1], [-xt, yS, k.zr1], [xt, yS, k.zr1]], [0, 0.3, 1], endMargin);
    const back: V3[] = [[xb0, yb0, k.z0], [-xb0, yb0, k.z0], [-xt, yS, k.zr0], [xt, yS, k.zr0]];
    if (k.rear === false) this.poly(this.paint, back, WHITE, [0, 0.3, -1]);
    else this.framed(back, [0, 0.3, -1], endMargin);
    // Roof: a flat panel inside a chamfer on all four edges.
    const xr = xt - rc, r0 = k.zr0 + rc, r1 = k.zr1 - rc, yR = k.roof, up: V3 = [0, 1, 0];
    this.poly(this.paint, [[xr, yR, r0], [xr, yR, r1], [-xr, yR, r1], [-xr, yR, r0]], WHITE, up);
    this.poly(this.paint, [[xt, yS, k.zr1], [-xt, yS, k.zr1], [-xr, yR, r1], [xr, yR, r1]], WHITE, up);
    this.poly(this.paint, [[xt, yS, k.zr0], [-xt, yS, k.zr0], [-xr, yR, r0], [xr, yR, r0]], WHITE, up);
    this.both(() => this.poly(this.paint, [[xt, yS, k.zr0], [xt, yS, k.zr1], [xr, yR, r1], [xr, yR, r0]], WHITE, up));
  }

  /** Thin strip lying on the body side, both sides: seams, rails, bands. */
  sideStrip(g: Buf, z0: number, z1: number, y0: number, y1: number, col: RGB, lift = 0.012): void {
    const p = (z: number, y: number): V3 => [this.sideX(z, y) + lift, y, z];
    // In short pieces: one long quad would cut straight through the fender bulges.
    const n = Math.max(1, Math.ceil(Math.abs(z1 - z0) / 0.45));
    for (let i = 0; i < n; i++) {
      const a = lerp(z0, z1, i / n), b = lerp(z0, z1, (i + 1) / n);
      this.poly(g, [p(a, y0), p(b, y0), p(b, y1), p(a, y1)], col, [1, 0, 0], false);
    }
  }
  /** The same on the greenhouse. */
  cabStrip(g: Buf, z0: number, z1: number, y0: number, y1: number, col: RGB, lift = 0.012): void {
    const p = (z: number, y: number): V3 => [this.cabX(y) + lift, y, z];
    this.poly(g, [p(z0, y0), p(z1, y0), p(z1, y1), p(z0, y1)], col, [1, 0, 0], false);
  }
  /** Vertical door seam down the body side, in two pieces so it follows the curve. */
  seam(z: number, y1 = this.shoulder(z) - CH - 0.01): void {
    const y0 = Math.max(this.bot(z) + 0.02, this.archY(z)), ym = (y0 + y1) / 2;
    this.sideStrip(this.trim, z - 0.009, z + 0.009, y0, ym, SEAM, 0.008);
    this.sideStrip(this.trim, z - 0.009, z + 0.009, ym, y1, SEAM, 0.008);
  }

  /** A bar swept around the nose or tail, following the plan curve and thinning as it wraps the corners. */
  bumper(front: boolean, y0: number, y1: number, col: RGB, wrap = 0.42): void {
    const sg = front ? 1 : -1, zE = front ? this.zF : this.zR, ym = (y0 + y1) / 2, th = this.c.bump;
    const ds = [wrap, wrap * 0.55, wrap * 0.25, 0.06, 0];
    const path: P2[] = [], thick: number[] = [];
    for (const d of ds) { const z = zE - sg * d; path.push([sg * this.sideX(z, ym), z]); thick.push(lerp(th, 0.03, d / wrap)); }
    for (let i = ds.length - 1; i >= 0; i--) { const z = zE - sg * ds[i]; path.push([-sg * this.sideX(z, ym), z]); thick.push(lerp(th, 0.03, ds[i] / wrap)); }
    const n = path.length, O: P2[] = [], I: P2[] = [];
    for (let k = 0; k < n; k++) {
      const a = path[Math.max(0, k - 1)], p = path[k], b = path[Math.min(n - 1, k + 1)];
      let ax = p[0] - a[0], az = p[1] - a[1], bx = b[0] - p[0], bz = b[1] - p[1];
      if (k === 0) { ax = bx; az = bz; }
      if (k === n - 1) { bx = ax; bz = az; }
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      const n1x = az / la, n1z = -ax / la;
      let nx = n1x + bz / lb, nz = n1z - bx / lb;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l; nz /= l;
      const sc = thick[k] / Math.max(0.6, nx * n1x + nz * n1z);
      O.push([p[0] + nx * sc, p[1] + nz * sc]);
      I.push([p[0] - nx * 0.08, p[1] - nz * 0.08]);
    }
    const g = this.trim;
    // A shallow bevel on the upper and lower edge keeps the bar from reading as a plank.
    const bv = Math.min(0.03, (y1 - y0) * 0.22);
    const P = (q: P2, y: number): V3 => [q[0], y, q[1]];
    const M = (k: number): P2 => [lerp(O[k][0], I[k][0], 0.22), lerp(O[k][1], I[k][1], 0.22)];
    for (let k = 0; k + 1 < n; k++) {
      this.quad(g, P(O[k], y0 + bv), P(O[k], y1 - bv), P(O[k + 1], y1 - bv), P(O[k + 1], y0 + bv), col);
      this.quad(g, P(O[k], y1 - bv), P(M(k), y1), P(M(k + 1), y1), P(O[k + 1], y1 - bv), col);
      this.quad(g, P(M(k), y1), P(I[k], y1), P(I[k + 1], y1), P(M(k + 1), y1), col);
      this.quad(g, P(M(k), y0), P(O[k], y0 + bv), P(O[k + 1], y0 + bv), P(M(k + 1), y0), col);
      this.quad(g, P(I[k], y0), P(M(k), y0), P(M(k + 1), y0), P(I[k + 1], y0), col);
    }
    this.poly(g, [P(I[0], y0), P(I[0], y1), P(O[0], y1 - bv), P(O[0], y0 + bv)], col, [0, 0, -sg]);
    this.poly(g, [P(I[n - 1], y0), P(I[n - 1], y1), P(O[n - 1], y1 - bv), P(O[n - 1], y0 + bv)], col, [0, 0, -sg]);
  }
}

interface Dress {
  /** Bumper bottom and top. */
  by: [number, number];
  chrome: boolean;
  /** Door seam positions, front to back; a handle goes just ahead of every seam after the first. */
  seams: number[];
  lamp?: P2; tailLamp?: P2;
  grille?: number;
  wipers?: boolean;
  exhaust?: number;
}

/** The parts every vehicle has: bumpers, grille, lamps, plates, mirrors, seams, handles, sills, wipers, exhaust. */
function dress(c: Car, o: Dress): void {
  const T = c.trim, zF = c.zF, zR = c.zR, k = c.c.cab;
  const metal = o.chrome ? CHROME : RUBBER;
  c.bumper(true, o.by[0], o.by[1], metal);
  c.bumper(false, o.by[0], o.by[1], metal);

  // Front face: grille between two lamps, in the band between bumper and hood edge.
  const yN = c.top(zF), bandH = yN - o.by[1], yc = o.by[1] + bandH * 0.5;
  const [lw, lh] = o.lamp ?? [0.26, Math.min(0.16, bandH * 0.62)];
  const hx = c.sideX(zF, yc) - lw / 2 - 0.05;
  c.both(() => c.box(T, [hx, yc, zF + 0.01], [lw, lh, 0.07], LAMP));
  c.both(() => c.box(T, [hx, yc, zF], [lw + 0.04, lh + 0.04, 0.05], metal));
  const gw = 2 * (hx - lw / 2 - 0.05), gh = bandH * (o.grille ?? 0.7);
  c.box(T, [0, yc, zF], [gw, gh, 0.05], RUBBER);
  if (o.chrome) for (const f of [-0.25, 0.25]) c.box(T, [0, yc + gh * f, zF + 0.012], [gw - 0.04, 0.022, 0.05], CHROME);
  c.box(T, [0, (o.by[0] + o.by[1]) / 2, zF + c.c.bump], [0.3, Math.min(0.11, o.by[1] - o.by[0] - 0.03), 0.02], BONE);
  // Amber turn lamps set into the bumper under the head lamps.
  c.both(() => c.box(T, [hx, (o.by[0] + o.by[1]) / 2, zF + c.c.bump * 0.8], [0.17, 0.05, 0.05], AMBER));
  c.head = [new THREE.Vector3(hx, yc, zF + 0.05), new THREE.Vector3(-hx, yc, zF + 0.05)];

  // Tail: lamps at the corners, plate between.
  const yT = c.top(zR), tb = yT - o.by[1], ty = o.by[1] + tb * 0.55;
  const [tw, th] = o.tailLamp ?? [0.34, Math.min(0.14, tb * 0.6)];
  const tx = c.sideX(zR, ty) - tw / 2 - 0.04;
  c.both(() => c.box(T, [tx, ty, zR - 0.005], [tw, th, 0.06], TAIL));
  c.both(() => c.box(T, [tx - tw / 2 - 0.05, ty, zR - 0.005], [0.07, th * 0.8, 0.05], AMBER));
  c.box(T, [0, ty - 0.01, zR], [0.32, 0.12, 0.03], BONE);
  c.tail = [new THREE.Vector3(tx, ty, zR - 0.04), new THREE.Vector3(-tx, ty, zR - 0.04)];

  // Door mirrors on a short stalk at the base of the windshield pillar.
  // Hung off the greenhouse, not the body side: over a front wheel the fender is wider than the door.
  const zm = k.z1 - 0.3, ym = c.top(zm) + 0.07, xm = c.cabW;
  c.both(() => {
    c.box(T, [xm + 0.13, ym, zm], [0.07, 0.11, 0.17], RUBBER);
    c.box(T, [xm + 0.06, ym - 0.03, zm], [0.12, 0.03, 0.06], RUBBER);
  });

  c.both(() => {
    o.seams.forEach((z, i) => {
      c.seam(z);
      if (i > 0) { const y = c.top(z) - CH - 0.11; c.box(T, [c.sideX(z + 0.14, y), y, z + 0.14], [0.03, 0.028, 0.13], o.chrome ? CHROME : RUBBER); }
    });
    // Dark sill between the wheels, so the body seems to sit over a shadow.
    const z0 = -c.fa + c.Ra + 0.02, z1 = c.fa - c.Ra - 0.02, yb = c.bot(0);
    c.sideStrip(T, z0, z1, yb, yb + 0.07, RUBBER, 0.01);
  });

  if (o.wipers !== false) {
    const yw = c.top(k.z1) + 0.035, zw = c.shieldZ(yw) + 0.02;
    for (const x of [0.36, -0.2]) c.beam(T, [x - 0.24, yw, zw], [x + 0.24, yw + 0.03, zw - 0.02], 0.02, 0.018, SEAM);
  }
  const ex = o.exhaust ?? 1;
  // Tucked under the bumper and stopping just short of its face.
  for (let i = 0; i < ex; i++) c.box(T, [-(c.hw * 0.55) + i * 0.13, o.by[0] - 0.035, zR + 0.05], [0.08, 0.07, 0.24], STEEL);
}

function build(kind: VehicleKind): VehicleModel {
  const s = SPECS[kind];
  const zF = s.length / 2 - 0.08, fa = s.wheelbase / 2, H = s.height;
  let c: Car;
  const T = (): Buf => c.trim;

  switch (kind) {
    case 'sedan': case 'taxi': case 'cruiser': {
      const cab: Cab = { z0: -fa - 0.1, zr0: -fa + 0.6, zr1: fa - 1.1, z1: fa - 0.35, roof: H, pillars: [-fa + 0.55, fa - 1.6] };
      cab.blank = [[cab.z0, cab.pillars[0]]];
      const seams = [cab.z1 - 0.1, cab.pillars[1], cab.pillars[0]];
      c = new Car(s, cfg({
        top: [[-zF, 0.84], [-fa + 0.05, 0.94], [fa - 0.45, 0.96], [fa + 0.5, 0.87], [zF, 0.75]],
        bot: underside(zF, 0.22, 0.14), cab,
        panel: kind === 'cruiser' ? [seams[2], seams[0]] : undefined,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.34, 0.52], chrome: kind !== 'cruiser', seams });
      const zr = (cab.zr0 + cab.zr1) / 2;
      if (kind === 'taxi') {
        // Roof sign, and a two-row checker band along the doors.
        c.box(T(), [0, H + 0.02, zr + 0.15], [0.8, 0.04, 0.3], RUBBER);
        c.box(T(), [0, H + 0.12, zr + 0.15], [0.66, 0.17, 0.2], BONE);
        c.box(T(), [0, H + 0.12, zr + 0.15], [0.3, 0.1, 0.215], RUBBER);
        const yb = 0.66, sq = 0.1, n = Math.floor((seams[0] - seams[2]) / sq);
        c.both(() => {
          c.sideStrip(T(), seams[2], seams[2] + n * sq, yb, yb + 2 * sq, BONE, 0.011);
          for (let i = 0; i < n; i++) {
            const z = seams[2] + i * sq, y = yb + (i % 2) * sq;
            c.sideStrip(T(), z, z + sq, y, y + sq, SEAM, 0.017);
          }
        });
      }
      if (kind === 'cruiser') {
        // Light bar: vermilion over the driver, blue over the curb.
        c.box(T(), [0, H + 0.025, zr], [1.2, 0.05, 0.3], RUBBER);
        c.box(T(), [0.34, H + 0.1, zr], [0.5, 0.11, 0.24], VERMILION);
        c.box(T(), [-0.34, H + 0.1, zr], [0.5, 0.11, 0.24], BLUE);
        c.box(T(), [0, H + 0.1, zr], [0.16, 0.12, 0.26], BONE);
        c.beacon = new THREE.Vector3(0, H + 0.1, zr);
        // Push bumper: two uprights and two rails ahead of the grille.
        const zp = zF + 0.13;
        c.both(() => c.beam(T(), [0.3, 0.3, zp], [0.3, 0.82, zp - 0.03], 0.07, 0.09, RUBBER));
        for (const y of [0.46, 0.7]) c.box(T(), [0, y, zp - 0.01], [0.86, 0.055, 0.05], RUBBER);
        c.both(() => c.beam(T(), [0.3, 0.44, zp - 0.02], [0.3, 0.44, zF - 0.02], 0.05, 0.05, RUBBER));
        // Spot lamp on the driver's pillar and a whip aerial on the deck.
        c.box(T(), [c.cabX(1.05) + 0.07, 1.06, cab.z1 - 0.2], [0.1, 0.1, 0.12], CHROME);
        c.beam(T(), [-0.5, 0.9, -fa - 0.5], [-0.5, 1.75, -fa - 0.62], 0.018, 0.018, SEAM);
      }
      break;
    }
    // The Bolt's stand-in until bolt.glb arrives is the hatch's shape at the Bolt's size: no rack, no tailpipe.
    case 'hatch': case 'bolt': case 'cmax': {
      const cab: Cab = { z0: -zF + 0.05, zr0: -zF + 0.42, zr1: 0.1, z1: 0.85, roof: H, pillars: [-0.4] };
      c = new Car(s, cfg({
        top: [[-zF, 0.94], [-fa, 1.0], [fa - 0.45, 0.98], [fa + 0.25, 0.9], [zF, 0.78]],
        bot: underside(zF, 0.22, 0.14), cab, tumble: 0.1, taperF: 0.14, taperR: 0.1,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.34, 0.52], chrome: false, seams: [cab.z1 - 0.1, cab.pillars[0]], lamp: [0.22, 0.17], grille: 0.45, tailLamp: [0.16, 0.2], exhaust: kind === 'bolt' ? 0 : 1 });
      // Roof rack and a lip over the hatch.
      const xr = c.cabX(H) - 0.1;
      if (kind === 'hatch') {
        c.both(() => c.box(T(), [xr, H + 0.05, -0.55], [0.035, 0.035, 1.2], RUBBER));
        for (const z of [-0.95, -0.15]) c.box(T(), [0, H + 0.075, z], [xr * 2 + 0.1, 0.03, 0.05], STEEL);
      }
      c.box(c.paint, [0, H - 0.005, cab.zr0 - 0.02], [xr * 2 + 0.06, 0.035, 0.2], WHITE);
      break;
    }
    case 'coupe': {
      const cab: Cab = { z0: -zF + 0.27, zr0: -0.5, zr1: 0, z1: 0.85, roof: H, pillars: [-1.1, -0.5], blank: [[-3, -1.1]] };
      c = new Car(s, cfg({
        top: [[-zF, 0.84], [-fa, 0.9], [fa - 0.5, 0.9], [fa + 0.45, 0.8], [zF, 0.66]],
        bot: underside(zF, 0.2, 0.14), cab, tumble: 0.15, taperF: 0.2, taperR: 0.14, flare: 0.045,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.3, 0.46], chrome: true, seams: [cab.z1 - 0.1, -0.5], lamp: [0.3, 0.1], grille: 0.5, exhaust: 2 });
      // Ducktail on the deck edge.
      c.box(c.paint, [0, c.top(-zF + 0.08) + 0.045, -zF + 0.1], [c.sideX(-zF + 0.1, 0.8) * 2 - 0.12, 0.06, 0.16], WHITE);
      break;
    }
    case 'muscle': {
      const cab: Cab = { z0: -fa - 0.15, zr0: -fa + 0.5, zr1: -0.2, z1: 0.5, roof: H, pillars: [-fa + 0.55], blank: [[-3, -fa + 0.55]] };
      c = new Car(s, cfg({
        top: [[-zF, 0.9], [-fa - 0.2, 0.98], [-fa + 0.3, 0.98], [0.45, 0.93], [fa + 0.5, 0.9], [zF, 0.82]],
        bot: underside(zF, 0.24, 0.14), cab, gap: 0.08, tumble: 0.14, taperF: 0.1, taperR: 0.1, flare: 0.045, crown: 0.02,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.36, 0.53], chrome: true, seams: [cab.z1 - 0.1, -fa + 0.55], lamp: [0.22, 0.17], grille: 0.85, exhaust: 2, tailLamp: [0.5, 0.11] });
      // Hood scoop with a dark mouth, twin stripes up the hood, a spoiler on short legs.
      const zs = 1.25, yh = c.top(zs) + 0.02;
      c.box(c.paint, [0, yh + 0.045, zs], [0.52, 0.11, 0.78], WHITE);
      c.box(T(), [0, yh + 0.05, zs + 0.375], [0.44, 0.07, 0.04], SEAM);
      // The stripes break where the hood line does, or they would cut through it.
      const zk = [0.55, fa + 0.5, zF - 0.03];
      for (const x of [0.36, -0.36]) for (let i = 0; i < 2; i++) {
        const y0 = c.top(zk[i]) + 0.032, y1 = c.top(zk[i + 1]) + 0.032;
        c.poly(T(), [[x - 0.09, y0, zk[i]], [x + 0.09, y0, zk[i]], [x + 0.09, y1, zk[i + 1]], [x - 0.09, y1, zk[i + 1]]], BONE, [0, 1, 0]);
      }
      const zw = -zF + 0.14, yw = c.top(zw) + 0.15;
      c.box(c.paint, [0, yw, zw], [s.width - 0.3, 0.04, 0.24], WHITE);
      c.both(() => c.box(c.paint, [0.6, yw - 0.07, zw], [0.05, 0.14, 0.16], WHITE));
      break;
    }
    case 'sports': {
      const cab: Cab = { z0: -1.05, zr0: -0.5, zr1: -0.05, z1: 0.9, roof: H, pillars: [] };
      c = new Car(s, cfg({
        top: [[-zF, 0.8], [-1.15, 0.84], [0.6, 0.74], [1.5, 0.64], [zF, 0.47]],
        bot: [[-zF, 0.3], [-zF + 0.4, 0.15], [zF - 0.4, 0.14], [zF, 0.2]], cab,
        gap: 0.055, tumble: 0.17, taperF: 0.22, taperR: 0.1, flare: 0.075, tuck: 0.07, lean: 0.05, crown: 0.02, bump: 0.05,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.2, 0.3], chrome: false, seams: [0.72, -0.35], lamp: [0.34, 0.07], grille: 0.4, exhaust: 2, tailLamp: [0.5, 0.07] });
      // Rear wing on two plates, engine-cover louvers, side intakes, a splitter.
      const zw = -zF + 0.2, yw = 1.04;
      c.box(c.paint, [0, yw, zw], [s.width - 0.16, 0.035, 0.3], WHITE);
      c.both(() => c.box(c.paint, [s.width / 2 - 0.1, yw - 0.04, zw], [0.03, 0.14, 0.36], WHITE));
      c.both(() => c.beam(T(), [0.55, c.top(zw + 0.08), zw + 0.1], [0.55, yw, zw], 0.04, 0.12, RUBBER));
      for (let i = 0; i < 4; i++) { const z = -1.22 - i * 0.14; c.box(T(), [0, c.top(z) + 0.03, z], [0.9, 0.03, 0.06], SEAM); }
      c.both(() => c.sideStrip(T(), -fa + c.Ra + 0.04, -fa + c.Ra + 0.34, 0.4, 0.62, SEAM, 0.014));
      c.box(T(), [0, 0.17, zF - 0.06], [c.sideX(zF, 0.3) * 2 - 0.02, 0.03, 0.2], RUBBER);
      break;
    }
    case 'pickup': {
      const cab: Cab = { z0: -0.5, zr0: -0.42, zr1: 0.5, z1: 1.2, roof: H, pillars: [], mTop: 0.07 };
      c = new Car(s, cfg({
        top: [[-zF, 1.12], [-0.56, 1.12], [-0.5, 1.16], [1.1, 1.16], [1.2, 1.13], [2.25, 1.09], [zF, 1.0]],
        bot: underside(zF, 0.44, 0.08), cab, bed: [-zF + 0.1, -0.6, 0.8],
        gap: 0.08, tumble: 0.1, taperF: 0.07, taperR: 0.03, corner: 0.35, flare: 0.04, crown: 0.02,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.5, 0.7], chrome: true, seams: [1.1, -0.42], lamp: [0.26, 0.2], grille: 0.9, tailLamp: [0.12, 0.3] });
      // Step bars under the doors, a tailgate seam and handle, a light bar across the cab.
      c.both(() => c.box(T(), [s.width / 2 - 0.06, 0.4, 0.35], [0.16, 0.05, 1.5], STEEL));
      c.both(() => c.seam(-0.56));
      c.box(T(), [0, 0.98, -zF - 0.005], [0.26, 0.05, 0.03], CHROME);
      c.box(T(), [0, H + 0.035, 0.3], [1.1, 0.05, 0.06], STEEL);
      c.both(() => { for (const x of [0.2, 0.42]) c.box(T(), [x, H + 0.06, 0.34], [0.15, 0.1, 0.07], LAMP); });
      break;
    }
    case 'van': {
      const cab: Cab = { z0: -zF + 0.02, zr0: -zF + 0.08, zr1: 1.2, z1: 1.85, roof: H, pillars: [0.75], blank: [[-9, 0.75]], mTop: 0.14, mBot: 0.06 };
      c = new Car(s, cfg({
        top: [[-zF, 1.22], [1.7, 1.22], [1.8, 1.16], [2.3, 1.06], [zF, 0.94]],
        bot: underside(zF, 0.3, 0.1), cab, tumble: 0.07, taperF: 0.1, taperR: 0.03, corner: 0.3, cabIn: 0.015, flare: 0.03, crown: 0.02,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.4, 0.6], chrome: false, seams: [1.72, 0.72, -0.62], lamp: [0.24, 0.17], grille: 0.6, tailLamp: [0.1, 0.34] });
      // Sliding-door seams carried up the box, the rail the door runs on, roof ribs, a seam between the rear doors.
      c.both(() => {
        for (const z of [0.72, -0.62]) c.cabStrip(T(), z - 0.009, z + 0.009, 1.2, H - 0.16, SEAM, 0.008);
        c.cabStrip(T(), -0.62, 0.72, H - 0.17, H - 0.152, SEAM, 0.008);
        c.sideStrip(T(), -1.95, -0.62, 1.09, 1.125, SEAM, 0.01);
        c.cabStrip(T(), 0.86, 1.02, 1.5, 1.53, RUBBER, 0.02);
      });
      for (const z of [-1.9, -1.0, -0.1]) c.box(c.paint, [0, H + 0.005, z], [c.cabX(H) * 2 - 0.3, 0.03, 0.12], WHITE);
      c.box(T(), [0, 1.3, -zF - 0.0], [0.022, 1.7, 0.07], SEAM);
      break;
    }
    case 'tow': {
      const roof = H - 0.17;
      const cab: Cab = { z0: 0.3, zr0: 0.38, zr1: 1.4, z1: 2.05, roof, pillars: [], mTop: 0.07 };
      c = new Car(s, cfg({
        top: [[-zF, 1.1], [0.2, 1.1], [0.28, 1.42], [1.95, 1.42], [2.05, 1.38], [2.8, 1.32], [zF, 1.2]],
        bot: underside(zF, 0.6, 0.08), cab, dual: true,
        gap: 0.08, tumble: 0.1, taperF: 0.06, taperR: 0.02, corner: 0.35, flare: 0.04, crown: 0.02, bump: 0.1,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.64, 0.9], chrome: true, seams: [1.95, 0.4], lamp: [0.28, 0.22], grille: 0.9, tailLamp: [0.3, 0.12], exhaust: 0 });
      // Light bar.
      c.box(T(), [0, roof + 0.02, 0.9], [1.3, 0.04, 0.26], RUBBER);
      c.both(() => c.box(T(), [0.36, roof + 0.085, 0.9], [0.46, 0.11, 0.2], AMBER));
      c.box(T(), [0, roof + 0.085, 0.9], [0.2, 0.11, 0.22], BONE);
      c.beacon = new THREE.Vector3(0, roof + 0.09, 0.9);
      // Headache rack behind the cab, and a stack on the curb side.
      c.both(() => c.beam(T(), [0.86, 1.08, 0.1], [0.86, 2.1, 0.1], 0.08, 0.08, STEEL));
      for (const y of [1.62, 2.1]) c.box(T(), [0, y, 0.1], [1.8, 0.08, 0.08], STEEL);
      c.beam(T(), [-1.0, 1.0, 0.16], [-1.0, 2.45, 0.16], 0.11, 0.11, CHROME);
      // Boom, braces, winch, cable and hook.
      const tip: V3 = [0, 2.1, -zF + 0.05];
      c.beam(T(), [0, 1.12, -0.75], tip, 0.24, 0.24, STEEL);
      c.both(() => c.beam(T(), [0.8, 1.08, -1.2], [0.05, 1.72, -zF + 1.0], 0.09, 0.09, STEEL));
      c.box(T(), [0, 1.3, -0.5], [0.7, 0.42, 0.5], RUBBER);
      c.box(T(), [0, 2.1, -zF + 0.02], [0.3, 0.2, 0.2], MUSTARD);
      c.beam(T(), [0, 2.05, -zF + 0.0], [0, 1.25, -zF - 0.02], 0.025, 0.025, SEAM);
      c.box(T(), [0, 1.17, -zF - 0.02], [0.1, 0.18, 0.1], MUSTARD);
      c.box(T(), [0, 1.06, -zF + 0.01], [0.05, 0.06, 0.16], STEEL);
      // Tool lockers along the deck, wheel-lift bar at the tail, mustard chevron on the deck edge.
      c.both(() => c.box(c.paint, [s.width / 2 - 0.3, 1.25, -1.35], [0.36, 0.34, 1.9], WHITE));
      c.both(() => c.box(T(), [s.width / 2 - 0.115, 1.27, -1.35], [0.02, 0.05, 0.3], CHROME));
      c.box(T(), [0, 0.72, -zF - 0.12], [1.5, 0.09, 0.12], STEEL);
      c.both(() => c.sideStrip(T(), -zF + 0.15, -fa - c.Ra - 0.05, 0.8, 0.98, MUSTARD, 0.012));
      break;
    }
    case 'bus': {
      const roof = H - 0.1;
      const cab: Cab = {
        z0: -zF + 0.02, zr0: -zF + 0.1, zr1: zF - 0.26, z1: zF - 0.03, roof,
        pillars: [-4.3, -3.1, -1.9, -0.7, 0.5, 1.7, 2.9, 4.1], mTop: 0.42, mBot: 0.1,
      };
      c = new Car(s, cfg({
        top: [[-zF, 1.42], [zF, 1.42]],
        bot: [[-zF, 0.62], [-zF + 0.5, 0.4], [zF - 0.5, 0.4], [zF, 0.56]], cab, dual: true,
        gap: 0.09, tumble: 0.06, taperF: 0.05, taperR: 0.03, corner: 0.4, cabIn: 0.03, flare: 0.02, crown: 0.01, bump: 0.08,
      }));
      c.body(); c.cabin();
      dress(c, { by: [0.56, 0.8], chrome: true, seams: [], lamp: [0.3, 0.2], grille: 0.35, tailLamp: [0.2, 0.3], wipers: false });
      // Destination box over the windshield: a dark face with a lit strip where the route would be.
      const yd = roof - 0.26, zd = c.shieldZ(yd);
      c.box(T(), [0, yd, zd], [1.7, 0.3, 0.12], RUBBER);
      c.box(T(), [0, yd, zd + 0.052], [1.3, 0.14, 0.03], MUSTARD);
      // Mustard band under the windows, roof unit, big mirrors on arms.
      c.both(() => c.sideStrip(T(), -zF + 0.4, zF - 0.4, 1.14, 1.3, MUSTARD, 0.012));
      c.box(T(), [0, roof + 0.05, -1.5], [1.5, 0.1, 2.6], BONE);
      c.both(() => {
        c.beam(T(), [c.cabX(2.3), 2.3, zF - 0.2], [c.cabX(2.3) + 0.2, 2.2, zF + 0.05], 0.035, 0.035, RUBBER);
        c.box(T(), [c.cabX(2.3) + 0.2, 2.0, zF + 0.05], [0.06, 0.4, 0.2], RUBBER);
      });
      // Doors on the curb side: front and middle, each a pair of leaves.
      c.right(() => {
        for (const z of [4.3, -0.1]) {
          for (const d of [-0.5, 0, 0.5]) c.seam(z + d);
          c.sideStrip(T(), z - 0.5, z + 0.5, c.bot(z) + 0.02, c.bot(z) + 0.1, STEEL, 0.02);
        }
      });
      for (const x of [0.5, -0.5]) c.beam(T(), [x - 0.3, 1.5, zd + 0.11], [x + 0.3, 1.52, zd + 0.11], 0.025, 0.02, SEAM);
      break;
    }
  }

  const t2 = s.track / 2, R = s.wheelR;
  const wheels = [new THREE.Vector3(t2, R, fa), new THREE.Vector3(-t2, R, fa), new THREE.Vector3(t2, R, -fa), new THREE.Vector3(-t2, R, -fa)];
  if (c.c.dual) {
    const xi = t2 - s.wheelW - 0.03;
    wheels.push(new THREE.Vector3(xi, R, -fa), new THREE.Vector3(-xi, R, -fa));
  }
  const k = c.c.cab;
  return {
    paint: finish(c.paint, 50, true),
    trim: finish(c.trim, 40, false),
    glass: finish(c.glass, 30, false),
    wheels, head: c.head, tail: c.tail, beacon: c.beacon,
    // Eye height: under the roof in a car, but a bus driver does not sit against the ceiling.
    seat: new THREE.Vector3(c.cabX(k.roof - 0.3) * 0.5, Math.min(k.roof - 0.3, c.top(k.z1) + 0.75), k.zr1 - 0.3),
  };
}

const cache = new Map<VehicleKind, VehicleModel>();

/** Built once per kind and cached. */
export function vehicleModel(kind: VehicleKind): VehicleModel {
  let m = cache.get(kind);
  if (!m) { m = build(kind); cache.set(kind, m); }
  return m;
}

let wheel: THREE.BufferGeometry | null = null;

/**
 * One wheel of radius 1 and width 1 with its axle along X, vertex-colored.
 * Both faces carry the rim and five spokes, so the same instance serves either
 * side of the car without being turned around.
 */
export function wheelGeometry(): THREE.BufferGeometry {
  if (wheel) return wheel;
  const m = new Mesher(), g = m.trim, N = 12;
  const TIRE = rgb(0x121315), LIP = rgb(0xb4b6b2), DISH = rgb(0x26282c), SPOKE = rgb(0xd4d4cf), HUB = rgb(0x8d9094);
  const P = (x: number, r: number, a: number): V3 => [x, r * Math.cos(a), r * Math.sin(a)];
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2, b = (i + 1) / N * Math.PI * 2, am = (a + b) / 2;
    const out: V3 = [0, Math.cos(am), Math.sin(am)];
    m.poly(g, [P(-0.36, 1, a), P(0.36, 1, a), P(0.36, 1, b), P(-0.36, 1, b)], TIRE, out);
    for (const sx of [1, -1]) {
      const X: V3 = [sx, 0, 0];
      m.poly(g, [P(sx * 0.36, 1, a), P(sx * 0.5, 0.68, a), P(sx * 0.5, 0.68, b), P(sx * 0.36, 1, b)], TIRE, [sx, out[1], out[2]]);
      m.poly(g, [P(sx * 0.5, 0.68, a), P(sx * 0.4, 0.62, a), P(sx * 0.4, 0.62, b), P(sx * 0.5, 0.68, b)], LIP, X);
      m.poly(g, [[sx * 0.4, 0, 0], P(sx * 0.4, 0.62, a), P(sx * 0.4, 0.62, b)], DISH, X);
    }
  }
  for (const sx of [1, -1]) {
    const X: V3 = [sx, 0, 0], x = sx * 0.47;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2, b = (i + 1) / 5 * Math.PI * 2;
      m.poly(g, [P(x, 0.2, a - 0.5), P(x, 0.64, a - 0.1), P(x, 0.64, a + 0.1), P(x, 0.2, a + 0.5)], SPOKE, X);
      m.poly(g, [[sx * 0.49, 0, 0], P(sx * 0.485, 0.22, a), P(sx * 0.485, 0.22, b)], HUB, X);
    }
  }
  wheel = finish(g, 62, false);
  return wheel;
}
