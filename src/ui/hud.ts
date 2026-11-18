// The HUD: Harbor Authority paperwork laid over the picture. A round radar
// drawn as a nautical chart, a cash slip, a speed ticket, rubber stamps.
//
// Two rules keep it cheap. The DOM is written only when a value changes (every
// readout remembers what it last showed), and the only thing redrawn on a
// clock is the radar canvas, at most 30 times a second and only when the
// player, the camera or a gauge has actually moved.

import './hud.css';
import type { Game } from '../core/game';
import type { GameState, HudApi, Vehicle, Weather } from '../core/api';
import { MPH, RNG, TAU, clamp, clamp01, damp } from '../core/util';
import {
  BREAKWATER, BRIDGE, LIGHTHOUSE, PIER, PIER_HEAD, RAMPS, WATER_Y, ZS,
  islandSD, terrainAt, type CityPlan, type District, type Rect,
} from '../world/plan';

const INK = '#14213d', BONE = '#f2e8cf', VERMILION = '#e4572e', MUSTARD = '#f0a202', TEAL = '#2a9d8f', SAGE = '#8a9a6b';
// Chart tints. Land is the buff of a paper chart and the sea is left as bare
// paper, which is how the real ones do it and keeps the vermilion arrow loud.
const LAND = '#ead8ab', BUILT = '#dfca98', SAND = '#f8f0dc', SHOAL = '#d2e2d0', PLANK = '#cdb682';

// A wash per district, every one close to the buff: town reads as
// neighbourhoods at a glance and the streets and the arrow lose no contrast.
const WASH: Record<District, string> = {
  downtown: '#c6cac0', midtown: '#e6c67c', oldtown: '#dba486', suburb: '#cdd6a2', industrial: '#c2ab84',
  port: '#b4cfc4', strand: '#f2cda6', park: SAGE, arena: BUILT,
};

// ── The chart ────────────────────────────────────────────────────────────────

/**
 * The closed curve f = 0 around the island (f < 0 inside), found by bisection
 * along rays from the island's middle. That middle is (0, -5) in plan.ts and
 * the coast wobbles only with the angle around it, so every ray crosses each
 * curve exactly once.
 */
function ring(f: (x: number, z: number) => number, n = 720): Float32Array {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, cx = Math.cos(a), cz = Math.sin(a);
    let lo = 0, hi = 1400;
    for (let k = 0; k < 22; k++) {
      const m = (lo + hi) / 2;
      if (f(cx * m, -5 + cz * m) < 0) lo = m; else hi = m;
    }
    out[i * 2] = cx * lo;
    out[i * 2 + 1] = -5 + cz * lo;
  }
  return out;
}

function trace(c: CanvasRenderingContext2D, pts: Float32Array): void {
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}

function box(c: CanvasRenderingContext2D, r: Rect, fill: string, line: number): void {
  c.fillStyle = fill;
  c.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
  if (line > 0) { c.lineWidth = line; c.strokeRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0); }
}

/** The whole island as one picture, `s` pixels to the meter, north up. Drawn once. */
function drawChart(plan: CityPlan, s: number): HTMLCanvasElement {
  const b = plan.bounds;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((b.x1 - b.x0) * s);
  cv.height = Math.ceil((b.z1 - b.z0) * s);
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = BONE;
  c.fillRect(0, 0, cv.width, cv.height);
  // From here on the units are meters and the origin is the island's.
  c.scale(s, s);
  c.translate(-b.x0, -b.z0);
  c.lineJoin = 'round';

  // Shoal water, then the engraver's water lines: each one further out and fainter.
  trace(c, ring((x, z) => islandSD(x, z) - 46));
  c.fillStyle = SHOAL;
  c.fill();
  c.strokeStyle = TEAL;
  const lines: [number, number, number][] = [[16, 2.4, 0.85], [46, 2.2, 0.75], [86, 1.9, 0.55], [136, 1.7, 0.4]];
  for (const [level, w, alpha] of lines) {
    trace(c, ring((x, z) => islandSD(x, z) - level));
    c.lineWidth = w;
    c.globalAlpha = alpha;
    c.stroke();
  }
  // Open sea: short hatch strokes, scattered.
  const rng = new RNG(5150);
  c.lineWidth = 2;
  c.lineCap = 'butt';
  c.globalAlpha = 0.5;
  c.beginPath();
  for (let z = b.z0 + 24, row = 0; z < b.z1; z += 42, row++) {
    for (let x = b.x0 + (row % 2 ? 50 : 14); x < b.x1 - 30; x += 72) {
      const jx = rng.range(-16, 16), jz = rng.range(-12, 12), len = rng.range(14, 30);
      if (!rng.chance(0.6) || islandSD(x + jx, z + jz) < 160) continue;
      c.moveTo(x + jx, z + jz);
      c.lineTo(x + jx + len, z + jz);
    }
  }
  c.stroke();
  c.globalAlpha = 1;

  // The compass rose every chart keeps somewhere out of the way.
  rose(c, -800, 545, 58);

  // Land: sand to the waterline, buff above the beach, a fine ink coast.
  const shore = ring((x, z) => WATER_Y - terrainAt(x, z));
  trace(c, shore);
  c.fillStyle = SAND;
  c.fill();
  trace(c, ring((x, z) => islandSD(x, z) + 26));
  c.fillStyle = LAND;
  c.fill();
  c.fillStyle = INK;
  c.globalAlpha = 0.42;
  for (let i = 0; i < 1500; i++) {
    const a = rng.next() * TAU, d = rng.range(0.3, 1);
    // Stipple between the beach line and the water: the chart symbol for sand.
    const k = Math.floor((a / TAU) * 720) * 2;
    const ex = shore[k], ez = shore[k + 1] + 5, len = Math.hypot(ex, ez);
    const r = len - d * 20;
    c.fillRect((ex / len) * r - 0.8, -5 + (ez / len) * r - 0.8, 1.7, 1.7);
  }
  c.globalAlpha = 1;
  trace(c, shore);
  c.strokeStyle = INK;
  c.lineWidth = 2.8;
  c.stroke();

  // City blocks. Mercy Park is sage; the port and the arena get a hatch.
  for (const blk of plan.blocks) {
    const r = blk.rect, w = r.x1 - r.x0, d = r.z1 - r.z0;
    if (w <= 0 || d <= 0) continue;
    c.fillStyle = WASH[blk.district];
    c.fillRect(r.x0, r.z0, w, d);
    if (blk.district !== 'port' && blk.district !== 'arena') continue;
    c.save();
    c.beginPath();
    c.rect(r.x0, r.z0, w, d);
    c.clip();
    c.strokeStyle = INK;
    c.globalAlpha = 0.3;
    c.lineWidth = 2.2;
    c.beginPath();
    if (blk.district === 'port') {
      for (let z = r.z0 + 9; z < r.z1; z += 13) { c.moveTo(r.x0, z); c.lineTo(r.x1, z); }
    } else {
      for (let k = -d; k < w; k += 16) { c.moveTo(r.x0 + k, r.z0); c.lineTo(r.x0 + k + d, r.z1); }
    }
    c.stroke();
    c.restore();
  }

  // Decks over the water.
  c.strokeStyle = INK;
  box(c, PIER, PLANK, 2.6);
  box(c, PIER_HEAD, PLANK, 2.6);
  box(c, BREAKWATER, PLANK, 2.6);

  // Streets in ink, avenues heavier and split by a paper line.
  const road = (x0: number, z0: number, x1: number, z1: number, w: number, color: string, cap: CanvasLineCap): void => {
    c.strokeStyle = color; c.lineWidth = w; c.lineCap = cap;
    c.beginPath(); c.moveTo(x0, z0); c.lineTo(x1, z1); c.stroke();
  };
  for (const pass of [1, 2, 3]) {
    for (const e of plan.edges) {
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      if (pass === 1 && e.lanes === 1) road(A.x, A.z, B.x, B.z, 7, INK, 'square');
      if (pass === 2 && e.lanes === 2) road(A.x, A.z, B.x, B.z, 13, INK, 'square');
      if (pass === 3 && e.lanes === 2) road(A.x, A.z, B.x, B.z, 2, LAND, 'butt');
    }
  }
  // The Perpetual Bridge: drawn as built, then as promised.
  road(BRIDGE.x, ZS[0], BRIDGE.x, BRIDGE.z1, 13, INK, 'butt');
  road(BRIDGE.x, ZS[0], BRIDGE.x, BRIDGE.z1, 2, BONE, 'butt');
  road(BRIDGE.x - 13, BRIDGE.z1, BRIDGE.x + 13, BRIDGE.z1, 6, VERMILION, 'butt');
  c.setLineDash([11, 9]);
  c.globalAlpha = 0.55;
  road(BRIDGE.x, BRIDGE.z1 - 14, BRIDGE.x, BRIDGE.z1 - 120, 3.2, INK, 'butt');
  c.globalAlpha = 1;
  c.setLineDash([]);

  // Stunt ramps: a mustard wedge pointing the way you leave the ground.
  for (const r of RAMPS) {
    const fx = Math.sin(r.h), fz = Math.cos(r.h), sx = -fz, sz = fx, hw = r.width * 0.9;
    c.beginPath();
    c.moveTo(r.x + fx * (r.len + 5), r.z + fz * (r.len + 5));
    c.lineTo(r.x - fx * 3 + sx * hw, r.z - fz * 3 + sz * hw);
    c.lineTo(r.x - fx * 3 - sx * hw, r.z - fz * 3 - sz * hw);
    c.closePath();
    c.fillStyle = MUSTARD;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 1.6;
    c.stroke();
  }

  // Chart symbols. The wheel on the pier head:
  const wx = (PIER_HEAD.x0 + PIER_HEAD.x1) / 2, wz = (PIER_HEAD.z0 + PIER_HEAD.z1) / 2;
  c.strokeStyle = VERMILION;
  c.lineWidth = 2.2;
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i / 8) * TAU;
    c.moveTo(wx - Math.cos(a) * 21, wz - Math.sin(a) * 21);
    c.lineTo(wx + Math.cos(a) * 21, wz + Math.sin(a) * 21);
  }
  c.stroke();
  c.lineWidth = 5;
  c.beginPath(); c.arc(wx, wz, 21, 0, TAU); c.stroke();
  c.fillStyle = INK;
  c.beginPath(); c.arc(wx, wz, 4.5, 0, TAU); c.fill();

  // The light: a solid disc, a bone lamp and the flare charts give a lit mark.
  c.beginPath(); c.arc(LIGHTHOUSE.x, LIGHTHOUSE.z, LIGHTHOUSE.r, 0, TAU); c.fill();
  c.fillStyle = BONE;
  c.beginPath(); c.arc(LIGHTHOUSE.x, LIGHTHOUSE.z, 7.5, 0, TAU); c.fill();
  c.save();
  c.translate(LIGHTHOUSE.x, LIGHTHOUSE.z);
  c.rotate(0.62);
  c.fillStyle = VERMILION;
  c.beginPath();
  c.moveTo(27, 0); c.lineTo(72, -11); c.arc(72, 0, 11, -Math.PI / 2, Math.PI / 2); c.closePath();
  c.fill();
  c.restore();

  // An anchorage off Dock Seven.
  anchor(c, 742, 418, 24);
  return cv;
}

function rose(c: CanvasRenderingContext2D, x: number, z: number, r: number): void {
  c.save();
  c.translate(x, z);
  c.strokeStyle = INK;
  c.fillStyle = INK;
  c.globalAlpha = 0.55;
  c.lineWidth = 1.8;
  c.beginPath(); c.arc(0, 0, r, 0, TAU); c.stroke();
  c.beginPath(); c.arc(0, 0, r * 0.74, 0, TAU); c.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU, len = i % 2 ? r * 0.5 : r * 0.96, w = r * 0.12;
    c.beginPath();
    c.moveTo(Math.sin(a) * len, -Math.cos(a) * len);
    c.lineTo(Math.cos(a) * w, Math.sin(a) * w);
    c.lineTo(-Math.cos(a) * w, -Math.sin(a) * w);
    c.closePath();
    // North is the one filled point.
    if (i === 0) c.fill(); else c.stroke();
  }
  c.restore();
}

function anchor(c: CanvasRenderingContext2D, x: number, z: number, r: number): void {
  c.save();
  c.translate(x, z);
  c.strokeStyle = INK;
  c.lineWidth = 4.2;
  c.lineCap = 'butt';
  c.beginPath();
  c.arc(0, -r * 1.05, r * 0.24, 0, TAU);
  c.moveTo(0, -r * 0.8); c.lineTo(0, r);
  c.moveTo(-r * 0.5, -r * 0.42); c.lineTo(r * 0.5, -r * 0.42);
  c.moveTo(r * 0.85, r * 0.2);
  c.arc(0, r * 0.15, r * 0.85, 0.06, Math.PI - 0.06);
  c.stroke();
  c.restore();
}

// ── The radar ────────────────────────────────────────────────────────────────

// Radii as fractions of the instrument's half-width, from the middle out:
// chart face, compass ring, then the two gauge scales on the navy housing.
const R_FACE = 0.79, R_RING = 0.872, R_GAUGE = 0.937, W_GAUGE = 0.07;
/** Half the gap left at the top and bottom of the gauge scales, radians. */
const GAUGE_GAP = 0.2;

// Landmarks the radar points at from anywhere: off the face, each rides the
// inside edge on its bearing, so the middle of town still says where the sea
// front is. The symbols are the chart's own.
type MarkKind = 'wheel' | 'light' | 'bridge';
const MARKS: { x: number; z: number; kind: MarkKind }[] = [
  { x: (PIER_HEAD.x0 + PIER_HEAD.x1) / 2, z: (PIER_HEAD.z0 + PIER_HEAD.z1) / 2, kind: 'wheel' },
  { x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, kind: 'light' },
  { x: BRIDGE.x, z: (BRIDGE.z0 + BRIDGE.z1) / 2, kind: 'bridge' },
];

class Radar {
  private ctx: CanvasRenderingContext2D;
  private size = 0;
  private full: HTMLCanvasElement;
  private half: HTMLCanvasElement;
  private s: number;
  private x0: number;
  private z0: number;

  constructor(private canvas: HTMLCanvasElement, plan: CityPlan, light: boolean) {
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    // 1.2 px per meter is sharp on a 1080p radar; phones show it far smaller.
    this.s = light ? 0.8 : 1.2;
    this.x0 = plan.bounds.x0;
    this.z0 = plan.bounds.z0;
    this.full = drawChart(plan, this.s);
    // A half-size copy for when the radar shows the chart at under half scale:
    // squeezing the big one that far makes the thin lines crawl as it turns.
    this.half = document.createElement('canvas');
    this.half.width = this.full.width >> 1;
    this.half.height = this.full.height >> 1;
    const h = this.half.getContext('2d') as CanvasRenderingContext2D;
    h.imageSmoothingQuality = 'high';
    h.drawImage(this.full, 0, 0, this.half.width, this.half.height);
  }

  /** Match the backing store to the CSS box. Reads layout, so call it only after a resize. */
  resize(): void {
    const css = this.canvas.clientWidth || 200;
    const px = Math.round(css * Math.min(devicePixelRatio || 1, 2));
    if (px === this.size) return;
    this.size = px;
    this.canvas.width = px;
    this.canvas.height = px;
  }

  /**
   * @param yaw    camera heading: the chart turns so this points up
   * @param h      player heading, for the arrow
   * @param viewR  meters from the middle to the edge of the face
   * @param hp     0..1   @param armor 0..1
   * @param faint  draw the health bar dimmed (the low-health blink)
   * @param hot    index into MARKS of the landmark to pick out in mustard, or -1
   */
  draw(x: number, z: number, yaw: number, h: number, viewR: number, hp: number, armor: number, faint: boolean, hot: number): void {
    const c = this.ctx, H = this.size / 2;
    if (H <= 0) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.size, this.size);
    c.translate(H, H);

    // Housing.
    c.fillStyle = INK;
    c.beginPath(); c.arc(0, 0, H, 0, TAU); c.fill();

    // Chart face, turned so the camera looks up the screen.
    const rf = H * R_FACE;
    c.save();
    c.beginPath(); c.arc(0, 0, rf, 0, TAU); c.clip();
    c.fillStyle = BONE;
    c.fillRect(-rf, -rf, rf * 2, rf * 2);
    c.rotate(yaw - Math.PI);
    this.blit(x, z, viewR, rf / viewR);
    c.restore();

    // Bearing marks, upright whichever way the chart is turned.
    const mr = H * 0.085, md = rf - mr * 1.3, ca = Math.cos(yaw - Math.PI), sa = Math.sin(yaw - Math.PI);
    for (let i = 0; i < MARKS.length; i++) {
      const m = MARKS[i], dx = m.x - x, dz = m.z - z, d = Math.hypot(dx, dz);
      // Inside this the chart's own drawing of the place is on the face.
      if (d < viewR * 0.86) continue;
      this.mark(m.kind, ((dx * ca - dz * sa) / d) * md, ((dx * sa + dz * ca) / d) * md, mr, i === hot);
    }

    // Compass ring: a bone card that turns with the chart.
    const rr = H * R_RING, north = yaw + Math.PI / 2;
    c.strokeStyle = BONE;
    c.lineWidth = rr - rf;
    c.beginPath(); c.arc(0, 0, (rr + rf) / 2, 0, TAU); c.stroke();
    c.strokeStyle = INK;
    c.lineWidth = Math.max(1, H * 0.016);
    c.beginPath(); c.arc(0, 0, rf, 0, TAU); c.stroke();
    c.beginPath();
    for (let i = 1; i < 24; i++) {
      const a = north + (i / 24) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const inner = i % 6 === 0 ? rf : i % 2 === 0 ? rf + (rr - rf) * 0.35 : rf + (rr - rf) * 0.62;
      c.moveTo(ca * inner, sa * inner);
      c.lineTo(ca * rr, sa * rr);
    }
    c.stroke();

    // Gauge scales on the housing: health up the left side, armor up the right.
    const bottom = Math.PI / 2, top = -Math.PI / 2;
    this.gauge(bottom + GAUGE_GAP, top + TAU - GAUGE_GAP, hp, VERMILION, faint ? 0.3 : 1);
    this.gauge(bottom - GAUGE_GAP, top + GAUGE_GAP, armor, TEAL, 1);
    // Lubber mark: the fixed notch that says "up is where the camera looks".
    c.fillStyle = BONE;
    c.beginPath();
    c.moveTo(0, -rr - H * 0.012);
    c.lineTo(H * 0.05, -H * 0.985);
    c.lineTo(-H * 0.05, -H * 0.985);
    c.closePath();
    c.fill();

    // North rides the ring.
    const nx = Math.cos(north) * (rr + rf) / 2, ny = Math.sin(north) * (rr + rf) / 2, nr = H * 0.095;
    c.fillStyle = INK;
    c.beginPath(); c.arc(nx, ny, nr, 0, TAU); c.fill();
    c.fillStyle = BONE;
    c.font = `900 ${Math.round(nr * 1.55)}px "Big Shoulders Display", "Arial Narrow", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('N', nx, ny + nr * 0.1);

    // Dess: a vermilion dart on her own heading.
    const a = H * 0.125;
    c.save();
    c.rotate(yaw - h);
    c.beginPath();
    c.moveTo(0, -a);
    c.lineTo(a * 0.7, a * 0.78);
    c.lineTo(0, a * 0.36);
    c.lineTo(-a * 0.7, a * 0.78);
    c.closePath();
    c.lineJoin = 'miter';
    c.strokeStyle = BONE;
    c.lineWidth = Math.max(2, H * 0.045);
    c.stroke();
    c.fillStyle = VERMILION;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = Math.max(1, H * 0.012);
    c.stroke();
    c.restore();
  }

  /** One landmark badge on the edge of the face. `hot` is the one the player is being sent to. */
  private mark(kind: MarkKind, x: number, y: number, r: number, hot: boolean): void {
    const c = this.ctx, fg = hot ? INK : BONE;
    c.fillStyle = hot ? MUSTARD : INK;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    c.strokeStyle = hot ? INK : BONE;
    c.lineWidth = Math.max(1, r * 0.13);
    c.stroke();
    c.lineCap = 'butt';
    c.beginPath();
    if (kind === 'wheel') {
      const w = r * 0.5;
      c.strokeStyle = hot ? INK : VERMILION;
      c.lineWidth = Math.max(1, r * 0.2);
      c.arc(x, y, w, 0, TAU);
      c.moveTo(x - w, y); c.lineTo(x + w, y);
      c.moveTo(x, y - w); c.lineTo(x, y + w);
      c.stroke();
    } else if (kind === 'light') {
      c.fillStyle = fg;
      c.moveTo(x - r * 0.14, y - r * 0.2); c.lineTo(x + r * 0.14, y - r * 0.2);
      c.lineTo(x + r * 0.36, y + r * 0.62); c.lineTo(x - r * 0.36, y + r * 0.62);
      c.closePath(); c.fill();
      c.fillStyle = hot ? INK : MUSTARD;
      c.beginPath(); c.arc(x, y - r * 0.42, r * 0.24, 0, TAU); c.fill();
    } else {
      c.strokeStyle = fg;
      c.lineWidth = Math.max(1, r * 0.2);
      c.moveTo(x - r * 0.66, y + r * 0.1); c.lineTo(x + r * 0.66, y + r * 0.1);
      c.moveTo(x - r * 0.3, y - r * 0.55); c.lineTo(x - r * 0.3, y + r * 0.5);
      c.moveTo(x + r * 0.3, y - r * 0.55); c.lineTo(x + r * 0.3, y + r * 0.5);
      c.stroke();
    }
  }

  /** Copy the square of chart around (x, z) into the face. k = screen pixels per meter. */
  private blit(x: number, z: number, viewR: number, k: number): void {
    const useHalf = k <= this.s * 0.56;
    const img = useHalf ? this.half : this.full, sm = useHalf ? this.s / 2 : this.s;
    let sx = (x - viewR - this.x0) * sm, sy = (z - viewR - this.z0) * sm;
    let sw = viewR * 2 * sm, sh = sw;
    let dx = -viewR * k, dy = dx, dw = viewR * 2 * k, dh = dw;
    const q = k / sm;
    // Clip the source to the picture by hand; browsers disagree about what a
    // source rectangle hanging off the edge means, and you can swim that far.
    if (sx < 0) { dx -= sx * q; dw += sx * q; sw += sx; sx = 0; }
    if (sy < 0) { dy -= sy * q; dh += sy * q; sh += sy; sy = 0; }
    if (sx + sw > img.width) { const cut = sx + sw - img.width; sw -= cut; dw -= cut * q; }
    if (sy + sh > img.height) { const cut = sy + sh - img.height; sh -= cut; dh -= cut * q; }
    if (sw <= 0 || sh <= 0) return;
    this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  /** One scale from angle `from` to `to`, filled to `frac`, cut into quarters like a gauge glass. */
  private gauge(from: number, to: number, frac: number, color: string, alpha: number): void {
    const c = this.ctx, H = this.size / 2, r = H * R_GAUGE, w = H * W_GAUGE, ccw = to < from;
    c.lineCap = 'butt';
    c.lineWidth = w;
    c.strokeStyle = 'rgba(242, 232, 207, 0.2)';
    c.beginPath(); c.arc(0, 0, r, from, to, ccw); c.stroke();
    if (frac > 0.004) {
      c.globalAlpha = alpha;
      c.strokeStyle = color;
      c.beginPath(); c.arc(0, 0, r, from, from + (to - from) * frac, ccw); c.stroke();
      c.globalAlpha = 1;
    }
    c.strokeStyle = INK;
    c.lineWidth = Math.max(1.5, H * 0.02);
    c.beginPath();
    for (let i = 1; i < 4; i++) {
      const a = from + ((to - from) * i) / 4, ca = Math.cos(a), sa = Math.sin(a);
      c.moveTo(ca * (r - w * 0.6), sa * (r - w * 0.6));
      c.lineTo(ca * (r + w * 0.6), sa * (r + w * 0.6));
    }
    c.stroke();
  }
}

// ── The paperwork ────────────────────────────────────────────────────────────

const WEATHER_WORD: Record<Weather, string> = { clear: 'Fair', overcast: 'Overcast', fog: 'Sea fog', rain: 'Rain' };

/** What goes under a place name where there is no street to name. */
const OFF_GRID: Record<string, string> = {
  'Calamity Sound': 'No streets. Swim.',
  'Pelican Pier': 'Mind the gulls',
  'The Perpetual Bridge': 'Completion date pending',
  'Last Light Breakwater': 'End of the line',
  'Low Tide Beach': 'Parking at own risk',
  'The Shoreline': 'Unincorporated sand',
};

const PIP =
  '<svg class="hud-pip" viewBox="0 0 14 20" aria-hidden="true">' +
  '<path d="M2.4 6.4 7 1l4.6 5.4z"/><path class="glass" d="M3.9 6.4h6.2v6.6H3.9z"/>' +
  '<path d="M1.2 13h11.6v2.6H1.2z"/><path d="M4.3 15.6h5.4v3.6H4.3z"/></svg>';

const KEYS: [string[], string][] = [
  [['W', 'A', 'S', 'D'], 'Move / steer'],
  [['Mouse'], 'Look around'],
  [['Shift'], 'Sprint'],
  [['Space'], 'Jump / handbrake'],
  [['F'], 'Get in or out'],
  [['V'], 'Change camera'],
  [['C'], 'Look back'],
  [['Esc'], 'Pause'],
];

/** Top of the speed scale, mph. The fastest car on the island does about 143. */
const SCALE_MPH = 150;

const kc = (k: string): string => `<span class="hud-kc">${k}</span>`;

function clock12(mins: number): string {
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  // Padded to a fixed width so the weather word beside it never shuffles.
  return `${h % 12 || 12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'AM' : 'PM'}`.padStart(8, ' ');
}

/**
 * Money for the slips, from whole cents: the cents are printed only when there
 * are some, and a debt carries its sign ahead of the dollar sign.
 */
function cashText(cents: number): string {
  const a = Math.abs(cents);
  return (cents < 0 ? '−$' : '$') + (a / 100).toLocaleString('en-US', { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

const FEET = 3.28084;
/** Remarks for a hop too small to earn a stamp. */
const HOPS = [
  'Wheels are advised to remain on the road.',
  'The suspension has filed a grievance.',
  'No flight plan was filed.',
  'Landing gear: none.',
];

interface Toast { el: HTMLElement; left: number; dying: number }

export class Hud implements HudApi {
  private root: HTMLElement;
  private radar: Radar;
  private amt: HTMLElement;
  private delta: HTMLElement;
  private clock: HTMLElement;
  private wx: HTMLElement;
  private heatEl: HTMLElement;
  private pips: Element[];
  private toastBox: HTMLElement;
  private drive: HTMLElement;
  private vname: HTMLElement;
  private mph: HTMLElement;
  private needle: HTMLElement;
  private hint: HTMLElement;
  private objEl: HTMLElement;
  private objTx: HTMLElement;
  private placeEl: HTMLElement;
  private stampEl: HTMLElement;
  private keysEl: HTMLElement;
  private pauseEl: HTMLElement;
  private pauseVals: HTMLElement[];
  private vitals: HTMLElement;
  private hpEl: HTMLElement;
  private arEl: HTMLElement;

  // What each readout last showed. Nothing touches the DOM unless one of these moves.
  private state: GameState = 'loading';
  private touch = false;
  private coarse = matchMedia('(pointer: coarse)').matches;
  private cash = NaN;
  private mins = -1;
  private weather: Weather | '' = '';
  private heat = 0;
  private veh: Vehicle | null = null;
  private shownMph = -1;
  private hintKey = '';
  private promptText: string | null = null;
  private place = '';
  private placeCand = '';
  private placeHeld = 0;
  private placeT = 0;
  private flip = false;
  private instant = false;
  private pinned = false;
  private placeNeed = 0.5;
  private placeShow = 0;
  private lastX = NaN;
  private lastZ = 0;
  private shownHp = -1;
  private shownAr = -1;

  // Notices waiting for room on the stack, and how long the big stamp still has the floor.
  private pending: { text: string; seconds: number }[] = [];
  private stampT = 0;

  // The flight being timed: whose, how long so far, and where it left the ground.
  private airV: Vehicle | null = null;
  private airT = 0;
  private airX = 0;
  private airZ = 0;
  private sunkV: Vehicle | null = null;
  private hops = 0;

  // The newcomer's tour: 0 off, 1 just arrived, 2 pointed at the truck, 3 pointed at the pier.
  private intro = 0;
  private introT = 0;
  private hot = -1;

  private toasts: Toast[] = [];
  private serial = 4070;
  private nameT = 0;
  private keysT = 0;

  private resized = true;
  private radarT = 1;
  private viewR = 150;
  private blink = 0;
  // The radar's last picture: [x, z, yaw, h, viewR, hp, armor, faint].
  private drawn = [NaN, 0, 0, 0, 0, 0, 0, 0];

  constructor(private game: Game) {
    const root = (document.getElementById('hud') ?? document.body.appendChild(document.createElement('div'))) as HTMLElement;
    root.id = 'hud';
    root.className = 'off';
    this.root = root;

    let ticks = '';
    for (let v = 0; v <= SCALE_MPH; v += 10) ticks += `<line x1="${v}" x2="${v}" y1="${v % 50 ? 5.5 : 0}" y2="10"/>`;
    const rows = KEYS.map(([keys, what]) => `<div class="hud-keys-row"><span>${keys.map(kc).join('')}</span><span>${what}</span></div>`).join('');
    const field = (label: string): string => `<div class="hud-card-row"><span class="hud-lbl">${label}</span><span></span></div>`;

    root.innerHTML = `
<div class="hud-frame">
  <div class="hud-radar"><canvas></canvas></div>
  <div class="hud-vitals">
    <span class="hud-vital"><i></i><span class="hud-lbl">Condition</span><b>100</b></span>
    <span class="hud-vital"><i></i><span class="hud-lbl">Padding</span><b>0</b></span>
  </div>
  <div class="hud-right">
    <div class="hud-cash hud-slip">
      <div class="hud-cash-top"><span class="hud-lbl">Cash on hand</span><span class="hud-delta"></span></div>
      <div class="hud-amt">$0</div>
      <div class="hud-meta"><span class="hud-clock"></span><span class="hud-wx"></span></div>
    </div>
    <div class="hud-heat"><span class="hud-heat-word">Heat</span><span class="hud-pips">${PIP.repeat(5)}</span></div>
    <div class="hud-toasts"></div>
  </div>
  <div class="hud-drive">
    <div class="hud-vname"></div>
    <div class="hud-speed hud-slip">
      <div class="hud-speed-hd hud-lbl"><span>Alleged speed</span><span>Form 55</span></div>
      <div class="hud-speed-row"><span class="hud-mph">  0</span><span class="hud-mph-unit">MPH</span></div>
      <div class="hud-scale">
        <svg viewBox="0 0 ${SCALE_MPH} 10" preserveAspectRatio="none" aria-hidden="true">${ticks}<line x1="0" x2="${SCALE_MPH}" y1="10" y2="10"/></svg>
        <div class="hud-needle"><i></i></div>
      </div>
    </div>
  </div>
  <div class="hud-hint"></div>
  <div class="hud-objective"><span class="hud-lbl">Current business</span><span class="hud-objective-tx"></span></div>
  <div class="hud-place"><div class="hud-place-in"><div class="hud-place-t"></div><div class="hud-place-s"></div></div></div>
  <div class="hud-stamp"><div class="hud-stamp-in"><div class="hud-stamp-t"></div><div class="hud-stamp-s"></div></div></div>
  <div class="hud-keys hud-slip">
    <div class="hud-keys-hd"><b>QUICK REFERENCE</b><span class="hud-lbl">Form K-1</span></div>
    ${rows}
    <div class="hud-keys-ft">Press ${kc('K')} to file this card away, or to see it again.</div>
  </div>
</div>
<div class="hud-pause">
  <div class="hud-card hud-slip">
    <div class="hud-card-hd"><span class="hud-lbl">Harbor Authority of Port Calamity</span><span class="hud-lbl">Form P-4</span></div>
    <div class="hud-card-cols">
      <div class="hud-card-main">
        <div class="hud-card-t">PAUSED</div>
        <div class="hud-card-sub">Temporary suspension of all activities, lawful or otherwise.</div>
        <div class="hud-card-rows">
          ${field('Location')}${field('Time')}${field('Cash on hand')}${field('Condition')}${field('Vehicle')}${field('Heat')}
          <div class="hud-card-row"><span class="hud-lbl">Mistakes made</span><span>0*</span></div>
        </div>
      </div>
      <div class="hud-card-keys"><div class="hud-lbl">Attached: Form K-1</div>${rows}</div>
    </div>
    <div class="hud-card-ft"><button class="hud-btn" type="button">Resume</button><span class="hud-card-or">or press ${kc('Esc')}</span></div>
    <div class="hud-card-note">* As reported by the applicant. Anything typed is not counted.</div>
  </div>
</div>`;

    const q = (sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
    this.amt = q('.hud-amt');
    this.delta = q('.hud-delta');
    this.clock = q('.hud-clock');
    this.wx = q('.hud-wx');
    this.heatEl = q('.hud-heat');
    this.pips = Array.from(root.querySelectorAll('.hud-pip'));
    this.toastBox = q('.hud-toasts');
    this.drive = q('.hud-drive');
    this.vname = q('.hud-vname');
    this.mph = q('.hud-mph');
    this.needle = q('.hud-needle');
    this.hint = q('.hud-hint');
    this.objEl = q('.hud-objective');
    this.objTx = q('.hud-objective-tx');
    this.placeEl = q('.hud-place');
    this.stampEl = q('.hud-stamp');
    this.keysEl = q('.hud-keys');
    this.pauseEl = q('.hud-pause');
    this.pauseVals = Array.from(root.querySelectorAll<HTMLElement>('.hud-card-row > span:last-child'));
    this.vitals = q('.hud-vitals');
    this.hpEl = q('.hud-vital:first-child b');
    this.arEl = q('.hud-vital:last-child b');

    this.radar = new Radar(q('.hud-radar canvas') as HTMLCanvasElement, game.plan, game.quality.name === 'low');

    addEventListener('resize', () => { this.resized = true; });
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyK' || e.repeat || this.state !== 'play' || this.touch) return;
      this.showKeys(this.keysT > 0 ? 0 : 12);
    });
    // A click anywhere on the pause sheet resumes, except on the form itself,
    // where only the button does: people click paper to read it.
    this.pauseEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.hud-card') && !t.closest('.hud-btn')) return;
      game.setPaused(false);
      game.input.lock();
    });
    game.on('pause', () => this.syncState());
    game.on('start', () => this.syncState());
  }

  // ── What other systems call ────────────────────────────────────────────────

  toast(text: string, seconds = 4): void {
    let alive = 0;
    for (const t of this.toasts) if (t.dying < 0) alive++;
    if (alive < 3 && this.pending.length === 0) { this.showToast(text, seconds); return; }
    // Three is a stack; four is a pile. The newcomer waits its turn (the oldest
    // slip is hurried along for it), so nothing is lost and nothing is buried.
    if (this.pending.length >= 5) this.pending.shift();
    this.pending.push({ text, seconds });
  }

  private showToast(text: string, seconds: number): void {
    const el = document.createElement('div');
    el.className = 'hud-toast hud-slip';
    el.innerHTML = `<div class="hud-toast-hd hud-lbl"><span>Notice</span><span>No. ${++this.serial}</span></div><div class="hud-toast-tx"></div>`;
    (el.lastChild as HTMLElement).textContent = text;
    this.toastBox.appendChild(el);
    this.toasts.push({ el, left: seconds, dying: -1 });
    // Two frames on, so the slip has been laid out off to the side before it is told to slide in.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }

  stamp(title: string, sub = ''): void {
    this.plate(title, sub, false);
    // The stamp has the floor for its four seconds: the notices dim and their clocks stop.
    this.stampT = 4;
    this.root.classList.add('stamping');
  }

  /** `small` is the same plate struck higher and lighter, for news that must not hide the road. */
  private plate(title: string, sub: string, small: boolean): void {
    const inner = this.stampEl.firstElementChild as HTMLElement;
    (inner.children[0] as HTMLElement).textContent = title;
    (inner.children[1] as HTMLElement).textContent = sub;
    this.stampEl.classList.toggle('sm', small);
    this.restart(this.stampEl);
  }

  /**
   * A leading run of bracketed keys is drawn as key caps: prompt('[G] Talk to Finch').
   * Plain text is shown as it is.
   */
  prompt(text: string | null): void { this.promptText = text; }

  objective(text: string | null): void {
    // Real business outranks the newcomer's tour.
    if (this.intro) { this.intro = 0; this.setHot(-1); }
    this.setObjective(text);
  }

  private setObjective(text: string | null): void {
    this.objEl.classList.toggle('on', !!text);
    if (text) this.objTx.textContent = text;
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game;
    if (g.state !== this.state) this.syncState();
    // A frozen clock means a test is about to take a picture: drop the fade.
    if (g.frozen !== this.instant) { this.instant = g.frozen; this.root.classList.toggle('instant', g.frozen); }
    if (this.state === 'loading' || this.state === 'title') return;
    const live = this.state === 'play';
    const p = g.player;

    const touch = g.input.touch || this.coarse;
    if (touch !== this.touch) {
      this.touch = touch;
      this.root.classList.toggle('touch', touch);
      this.resized = true;
      if (touch) this.showKeys(0);
    }

    // Cash.
    const cash = Math.round(p.money * 100);
    if (cash !== this.cash) {
      if (!Number.isNaN(this.cash)) {
        const d = cash - this.cash;
        this.delta.textContent = (d > 0 ? '+ ' : '− ') + cashText(Math.abs(d));
        this.restart(this.delta);
        this.restart(this.amt);
      }
      this.cash = cash;
      this.amt.textContent = cashText(cash);
    }

    // Clock and weather.
    const mins = Math.floor(g.sky.hour * 60) % 1440;
    if (mins !== this.mins) { this.mins = mins; this.clock.textContent = clock12(mins); }
    const w = g.sky.weather;
    if (w !== this.weather) { this.weather = w; this.wx.textContent = WEATHER_WORD[w] ?? w; }

    // Heat.
    const heat = Math.ceil(clamp(p.heat, 0, 5));
    if (heat !== this.heat) {
      this.heat = heat;
      this.heatEl.classList.toggle('on', heat > 0);
      for (let i = 0; i < this.pips.length; i++) this.pips[i].classList.toggle('lit', i < heat);
      this.restart(this.heatEl);
    }

    // Driving ticket.
    const v = p.vehicle;
    if (v !== this.veh) {
      this.veh = v;
      this.drive.classList.toggle('on', !!v);
      if (v) {
        this.vname.textContent = v.spec.name;
        this.vname.classList.add('on');
        this.nameT = 4;
        this.shownMph = -1;
      }
    }
    if (v) {
      const mph = Math.round(p.speed * MPH);
      if (mph !== this.shownMph) {
        this.shownMph = mph;
        this.mph.textContent = String(mph).padStart(3, ' ');
        this.needle.style.transform = `translateX(${(Math.min(mph / SCALE_MPH, 1) * 100).toFixed(1)}%)`;
      }
    }
    if (this.nameT > 0 && live && (this.nameT -= dt) <= 0) this.vname.classList.remove('on');

    // Hint line: another system's prompt wins over our own "get in".
    const near = live && !v && !touch ? p.nearVehicle : null;
    const key = this.promptText !== null ? 'p' + this.promptText : near ? 'v' + near.spec.name : '';
    if (key !== this.hintKey) {
      this.hintKey = key;
      this.writeHint(near);
    }

    // Condition and padding in figures, beside the two scales that draw them.
    const hpN = Math.max(0, Math.ceil(p.health)), arN = Math.max(0, Math.ceil(p.armor));
    if (hpN !== this.shownHp) {
      this.shownHp = hpN;
      this.hpEl.textContent = String(hpN);
      this.vitals.classList.toggle('low', hpN > 0 && hpN <= 30);
    }
    if (arN !== this.shownAr) { this.shownAr = arN; this.arEl.textContent = String(arN); }

    if (live) {
      this.tickStunts(v);
      this.tickIntro(dt, v, p.z);
      this.tickToasts(dt);
      if (this.keysT > 0 && (this.keysT -= dt) <= 0) this.keysEl.classList.remove('on');
      this.tickPlace(dt, p.x, p.z);
    }

    this.tickRadar(dt, live);
  }

  // ── Pieces ─────────────────────────────────────────────────────────────────

  private syncState(): void {
    const g = this.game, was = this.state, st = g.state;
    if (st === was) return;
    this.state = st;
    const shown = st === 'play' || st === 'paused';
    this.root.classList.toggle('off', !shown);
    this.pauseEl.classList.toggle('on', st === 'paused');
    this.root.classList.toggle('paused', st === 'paused');
    if (st === 'paused') {
      const p = g.player, name = g.plan.placeName(p.x, p.z);
      const street = OFF_GRID[name] ? '' : ', ' + g.plan.streetAt(p.x, p.z);
      this.pauseVals[0].textContent = name + street;
      this.pauseVals[1].textContent = `${clock12(Math.floor(g.sky.hour * 60) % 1440).trim()}, ${(WEATHER_WORD[g.sky.weather] ?? '').toLowerCase()}`;
      this.pauseVals[2].textContent = cashText(Math.round(p.money * 100));
      const ar = Math.max(0, Math.ceil(p.armor)), heat = Math.ceil(clamp(p.heat, 0, 5));
      this.pauseVals[3].textContent = `${Math.max(0, Math.ceil(p.health))} of 100, ${ar > 0 ? 'padding ' + ar : 'no padding'}`;
      this.pauseVals[4].textContent = p.vehicle ? `${p.vehicle.spec.name}, ${Math.round(p.speed * MPH)} mph` : 'On foot';
      this.pauseVals[5].textContent = heat > 0 ? `${heat} of 5 beacons lit` : 'None on file';
    }
    if (st === 'play' && was === 'title') {
      if (!(g.input.touch || this.coarse)) this.showKeys(12);
      this.intro = 1;
      this.introT = 0;
    }
  }

  private showKeys(seconds: number): void {
    this.keysT = seconds;
    this.keysEl.classList.toggle('on', seconds > 0);
  }

  /** Replay an element's one-shot animation. Two identical keyframe sets, swapped, so no reflow is forced. */
  private restart(el: HTMLElement): void {
    this.flip = !this.flip;
    el.classList.toggle('a', this.flip);
    el.classList.toggle('b', !this.flip);
  }

  private writeHint(near: Vehicle | null): void {
    const el = this.hint;
    el.textContent = '';
    const text = this.promptText;
    if (text === null && !near) { el.classList.remove('on'); return; }
    let rest = text ?? 'Get in', caps = text === null ? ['F'] : [];
    if (text !== null) {
      const m = /^\s*((?:\[[^\]]+\]\s*)+)(.*)$/.exec(text);
      if (m) { caps = m[1].match(/[^[\]\s][^[\]]*/g) ?? []; rest = m[2]; }
    }
    for (const k of caps) {
      const cap = document.createElement('span');
      cap.className = 'hud-kc';
      cap.textContent = k;
      el.appendChild(cap);
    }
    el.appendChild(document.createTextNode(rest));
    if (text === null && near) {
      const b = document.createElement('b');
      b.textContent = near.spec.name;
      el.appendChild(b);
    }
    el.classList.toggle('bare', caps.length === 0);
    el.classList.add('on');
  }

  private tickToasts(dt: number): void {
    if (this.stampT > 0) {
      if ((this.stampT -= dt) <= 0) this.root.classList.remove('stamping');
      return;
    }
    const list = this.toasts;
    let alive = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.dying < 0) {
        // With slips waiting, the oldest one up is hurried along.
        if (alive === 0 && this.pending.length) t.left = Math.min(t.left, 1);
        if ((t.left -= dt) <= 0) { t.dying = 0.32; t.el.classList.add('out'); } else alive++;
      } else if ((t.dying -= dt) <= 0) {
        this.dropToast(i--);
      }
    }
    if (alive < 3 && this.pending.length) {
      const next = this.pending.shift() as { text: string; seconds: number };
      this.showToast(next.text, next.seconds);
    }
  }

  /**
   * A car that leaves the ground for long enough gets it in writing, and so
   * does one that leaves the island. Flights are measured takeoff to touchdown
   * along the ground, which is how a witness would pace it out.
   */
  private tickStunts(v: Vehicle | null): void {
    const was = this.airV;
    if (v !== was) {
      // Thrown clear as it went under: the report is still owed.
      if (was && was.sunk) this.lostAtSea(was);
      this.airV = v;
      this.airT = 0;
    }
    if (!v) return;
    if (v.sunk) { this.lostAtSea(v); this.airT = 0; return; }
    if (!v.onGround) {
      if (this.airT === 0) { this.airX = v.x; this.airZ = v.z; }
      this.airT = Math.max(this.airT, v.airTime, 0.001);
      return;
    }
    const t = this.airT;
    if (t === 0) return;
    this.airT = 0;
    if (t < 0.8) return;
    const feet = Math.round(Math.hypot(v.x - this.airX, v.z - this.airZ) * FEET);
    if (t >= 1.5 || feet >= 110) this.plate('AIRBORNE', `${feet} ft · ${t.toFixed(1)} s · no flight plan filed`, true);
    else this.toast(`Off the ground for ${t.toFixed(1)} s and ${feet} ft. ${HOPS[this.hops++ % HOPS.length]}`, 5);
    if (this.intro === 3) this.endIntro();
  }

  private lostAtSea(v: Vehicle): void {
    if (v === this.sunkV) return;
    this.sunkV = v;
    const feet = Math.round(Math.hypot(v.x - this.airX, v.z - this.airZ) * FEET);
    this.toast(this.airT >= 0.8 && feet >= 30
      ? `${feet} ft through the air, concluding in Calamity Sound. One ${v.spec.name}, written off.`
      : `One ${v.spec.name}, lost to Calamity Sound. It was never a boat.`, 6);
    if (this.intro === 3) this.endIntro();
  }

  /**
   * The first minutes, before there are missions to say it: one line of
   * business at a time, pointing a stranger at the truck and then at the pier,
   * whose badge on the radar turns mustard. Any real objective ends the tour.
   */
  private tickIntro(dt: number, v: Vehicle | null, z: number): void {
    if (this.intro === 0) return;
    this.introT += dt;
    if (this.intro === 1 && this.introT > 2.5) {
      this.intro = 2;
      if (!v) this.setObjective('Get in the tow truck. It is the last thing you own.');
    }
    if (this.intro <= 2 && v) {
      this.intro = 3;
      this.introT = 0;
      this.setObjective('Take it down Pelican Pier: due south, under the arch.');
      this.toast('There is a ramp at the end of the pier. Nobody has signed for it.', 7);
      this.setHot(0);
    } else if (this.intro === 3 && (z > PIER_HEAD.z0 - 20 || this.introT > 180)) {
      this.endIntro();
    }
  }

  private endIntro(): void {
    this.intro = 0;
    this.setObjective(null);
    this.setHot(-1);
  }

  private setHot(i: number): void {
    if (i === this.hot) return;
    this.hot = i;
    this.drawn[0] = NaN;
  }

  /** Take a spent slip out and let the ones under it slide up instead of jumping. */
  /** Take a spent slip out and let the ones under it slide up instead of jumping. */
  private dropToast(i: number): void {
    const list = this.toasts;
    const before: number[] = [];
    for (const t of list) before.push(t.el.offsetTop);
    list[i].el.remove();
    list.splice(i, 1);
    before.splice(i, 1);
    for (let k = i; k < list.length; k++) {
      const el = list[k].el, d = before[k] - el.offsetTop;
      if (!d) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${d}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; }));
    }
  }

  private tickPlace(dt: number, x: number, z: number): void {
    const g = this.game;
    // The banner's three seconds are counted in game time, not by the
    // stylesheet, so a paused or stepped game never holds a stale name.
    if (this.placeShow > 0 && (this.placeShow -= dt) <= 0) this.placeEl.classList.remove('on');
    // A pinned camera is somebody composing a picture of somewhere else.
    const pinned = g.view !== null;
    if (pinned !== this.pinned) { this.pinned = pinned; this.root.classList.toggle('pinned', pinned); }

    // Four looks a second is plenty.
    if ((this.placeT -= dt) > 0) return;
    const step = 0.25 - this.placeT;
    this.placeT = 0.25;
    const dx = x - this.lastX, dz = z - this.lastZ;
    this.lastX = x;
    this.lastZ = z;
    const name = g.plan.placeName(x, z);
    // No car covers 30 m between looks, so this is a teleport, a respawn or the
    // first look of all. Wherever she was is no longer news: clear the banner
    // and announce the new place promptly, even if it has the same name.
    if (!(dx * dx + dz * dz < 900)) {
      this.placeEl.classList.remove('on');
      this.placeShow = 0;
      this.place = '';
      this.placeCand = name;
      this.placeHeld = 0;
      this.placeNeed = 0.5;
      return;
    }
    if (name !== this.placeCand) { this.placeCand = name; this.placeHeld = 0; return; }
    this.placeHeld += step;
    // A name has to hold for a second and a half, so driving along a boundary
    // street does not machine-gun banners ...
    if (name === this.place || this.placeHeld < this.placeNeed) return;
    // ... and she has to be staying: if two and a half seconds on at this pace
    // she will be somewhere else, this place was only clipped on the way there.
    const k = 2.5 / step;
    if (g.plan.placeName(x + dx * k, z + dz * k) !== name) return;
    this.place = name;
    this.placeNeed = 1.5;
    this.placeShow = 3;
    const inner = this.placeEl.firstElementChild as HTMLElement;
    (inner.children[0] as HTMLElement).textContent = name;
    (inner.children[1] as HTMLElement).textContent = OFF_GRID[name] ?? g.plan.streetAt(x, z);
    this.placeEl.classList.add('on');
    this.restart(this.placeEl);
  }

  private tickRadar(dt: number, live: boolean): void {
    const g = this.game, p = g.player;
    if (this.resized) { this.resized = false; this.radar.resize(); this.drawn[0] = NaN; }
    if (!live && !Number.isNaN(this.drawn[0])) return;

    // Pull back at speed so the next few corners are on the face.
    const want = p.vehicle ? clamp(165 + p.speed * 2.4, 165, 280) : 150;
    this.viewR = damp(this.viewR, want, 2, dt);
    this.blink += dt;
    const hp = clamp01(p.health / 100), armor = clamp01(p.armor / 100);
    const faint = hp > 0 && hp <= 0.3 && this.blink % 0.7 < 0.3 ? 1 : 0;

    const d = this.drawn, yaw = g.cam.yaw;
    const jumped = Math.abs(p.x - d[0]) > 4 || Math.abs(p.z - d[1]) > 4;
    this.radarT += dt;
    // A teleport redraws at once; otherwise 30 pictures a second is the ceiling.
    if (this.radarT < 1 / 30 && !jumped && !Number.isNaN(d[0])) return;
    this.radarT = 0;
    if (
      Math.abs(p.x - d[0]) < 0.2 && Math.abs(p.z - d[1]) < 0.2 && Math.abs(yaw - d[2]) < 0.003 &&
      Math.abs(p.h - d[3]) < 0.01 && Math.abs(this.viewR - d[4]) < 0.4 && hp === d[5] && armor === d[6] && faint === d[7]
    ) return;
    d[0] = p.x; d[1] = p.z; d[2] = yaw; d[3] = p.h; d[4] = this.viewR; d[5] = hp; d[6] = armor; d[7] = faint;
    this.radar.draw(p.x, p.z, yaw, p.h, this.viewR, hp, armor, faint === 1, this.hot);
  }
}
