// The paint shop: every texture in the game, drawn on canvases at load time.
// Nothing here is loaded from a file. A fixed-seed RNG makes each one come out
// identical on every load.
//
// WHAT IS WHERE (materials.ts wraps each of these in a material of the same name)
//
//   Tiling surfaces (RepeatWrapping). Size of one repeat in meters is in TILE_M:
//     street, avenue        u across the FULL road width (0 = one curb, 1 = the other), v along it, 12 m per repeat
//     asphalt, sidewalk, grass, sand, cobble, roofGravel   use world-space uv = (x, z) / TILE_M.<name>
//     wood                  planks run along v, u counts across them (16 planks per repeat)
//     roofTile, shingle     courses run along u, v climbs the slope (v = 0 at the eave)
//     corrugated            ribs run along v
//     ramp                  chevrons point toward +v (up the ramp)
//   facade[0..3]            8 bays wide x 8 floors tall per repeat, matching Batch.walls(..., tiles = 8)
//   Atlases (not tiling, look pieces up by name with .rect()):
//     kit                   shopfronts, doors, windows, loading dock (with a night-glow twin)
//     signs                 every signboard, billboard, notice and street-name blade
//     marks                 road paint. Its top rows tile along u, see MARKS notes
//   container, fence        strip textures: tile along u, bands along v (CONTAINER_UV, FENCE_UV)
//   glow                    soft white dot for additive lamp halos and light pools
//
// Every rect is { u0, v0, u1, v1, aspect } with (u0, v0) the bottom-left corner
// and (u1, v1) the top-right, so it drops straight into Batch.quad(..., u0, v0, u1, v1)
// when the quad's corners go bottom-left, bottom-right, top-right, top-left.
//
// Light, near-neutral paint is deliberate wherever a builder is expected to tint:
// the material multiplies the map by the vertex colour.

import * as THREE from 'three';
import type { Quality } from '../core/api';
import { RNG } from '../core/util';
import { EW_NAMES, NS_NAMES } from './plan';

// ── What the builders get ────────────────────────────────────────────────────

/** One facade style: the daytime map and the emissive map that lights its windows. Same UVs. */
export interface FacadeTex { map: THREE.Texture; glow: THREE.Texture }

/** A piece of an atlas. (u0, v0) = bottom-left, (u1, v1) = top-right, aspect = width / height. */
export interface AtlasRect { u0: number; v0: number; u1: number; v1: number; aspect: number }

export interface Atlas {
  tex: THREE.Texture;
  /** Look a piece up by name. An unknown name warns once and returns the first piece rather than throwing. */
  rect(name: string): AtlasRect;
  has(name: string): boolean;
  names: string[];
}

/** Ground-floor pieces. `glow` is the matching emissive map (shop windows, door lights). */
export interface KitAtlas extends Atlas { glow: THREE.Texture }

export interface SignAtlas extends Atlas {
  /** Shop fascia boards, all 4:1, interchangeable: the easter-egg four first, then the rest. */
  shops: string[];
  /** 2:1 billboards. 'wdoof' is the first. */
  billboards: string[];
  /** Harbor Authority paperwork, portrait 7:10. */
  notices: string[];
  /** Place-name plates (PELICAN PIER and friends), 4:1 like the shop boards. */
  places: string[];
  /** Round hanging pictogram signs (alpha-cut), 1:1. */
  hanging: string[];
  /** Name of the blade for a street from plan.ts NS_NAMES / EW_NAMES, e.g. street('Anchor Ave'). 5:1. */
  street(name: string): string;
}

export interface Textures {
  /** 0 glass tower, 1 brick mid-rise, 2 old-town stucco, 3 corrugated industrial. See FACADE for suggested bay sizes. */
  facade: FacadeTex[];
  kit: KitAtlas;
  signs: SignAtlas;
  /** Road paint with alpha: see MARKS for the tiling rows; stamps (arrows, manhole) come from rect(). */
  marks: Atlas;

  /** 12 m wide two-lane street. u across the full width, v along (12 m per repeat). */
  street: THREE.Texture;
  /** 20 m wide four-lane avenue. u across the full width, v along (12 m per repeat). */
  avenue: THREE.Texture;
  /** Bare asphalt for intersections and lots: the same mix as the roads, no paint. */
  asphalt: THREE.Texture;
  sidewalk: THREE.Texture;
  grass: THREE.Texture;
  sand: THREE.Texture;
  /** Bleached planks, light enough to tint: pier decking, boardwalk, clapboard siding. */
  wood: THREE.Texture;
  /** Old-town stone setts. */
  cobble: THREE.Texture;

  roofGravel: THREE.Texture;
  /** Terracotta barrel tiles, coloured in the map (leave the vertex colour near white). */
  roofTile: THREE.Texture;
  /** Asphalt shingles, pale grey so each house can tint its own roof. */
  shingle: THREE.Texture;
  /** Corrugated sheet, pale: sawtooth roofs, sheds, fences. */
  corrugated: THREE.Texture;

  /** Shipping container, pale so it tints. Bands in CONTAINER_UV. */
  container: THREE.Texture;
  /** Vermilion and bone chevrons for stunt ramps, pointing toward +v. */
  ramp: THREE.Texture;
  /** Chain link, picket and railing with alpha. Bands in FENCE_UV. */
  fence: THREE.Texture;

  /** Soft round white dot, black at the rim: additive lamp halos and light pools. */
  glow: THREE.Texture;
  /** 256 px tileable noise for shaders (linear, not sRGB): R soft blotches, G finer blotches, B per-pixel grain. */
  noise: THREE.Texture;
  /**
   * The physically based twins of a colour map, keyed by that map: a tangent-space normal map and an
   * ORM sheet (G roughness, B metalness), both with the colour map's UVs. Empty on the low preset.
   */
  pbr: Map<THREE.Texture, Pbr>;
}

/** Normal map plus roughness (G) and metalness (B), same UVs as the colour map they were derived from. */
export interface Pbr { normal: THREE.Texture; orm: THREE.Texture }

/** Meters covered by one repeat of each tiling texture (uv = meters / TILE_M.x). */
export const TILE_M = {
  street: 12, avenue: 12, asphalt: 8, sidewalk: 3, grass: 8, sand: 8, wood: 4, cobble: 4,
  roofGravel: 8, roofTile: 4, shingle: 4, corrugated: 4, ramp: 2,
} as const;

/** Suggested `bay` and `floorH` (meters) for Batch.walls() with each facade style. Cells are drawn square. */
export const FACADE = [
  { name: 'glass', bay: 3.4, floorH: 3.6 },
  { name: 'brick', bay: 3.4, floorH: 3.3 },
  { name: 'stucco', bay: 3.2, floorH: 3.2 },
  { name: 'metal', bay: 4.5, floorH: 4.5 },
] as const;

/**
 * tex.marks layout. The first rows tile along u (one repeat = `tileM` meters) and
 * are picked with their v band: marks.rect('crosswalk') returns u0 = 0, u1 = 1.
 * All paint is white so the vertex colour chooses yellow or white.
 *   crosswalk  ladder stripes 0.6 m on / 0.6 m off across u; the band is 3 m deep. u = 0 falls in the
 *              middle of a gap, so u = (meters from the road centerline) / tileM is symmetric.
 *   stopline   solid bar, band is 0.5 m      line  thin solid line, band is 0.15 m (stalls, edges)
 *   hatch      diagonal no-parking hatching, band is 1.5 m      solid  plain paint
 * Stamps (do not tile): arrow (points to +v), arrowTurn (bends left; swap u0/u1 for right), stop (lettering,
 * top toward +v), duckXing, and three that carry their own colours, so leave the vertex colour white:
 * manhole, drain, stain.
 */
export const MARKS = { tileM: 9.6 } as const;

/**
 * tex.container: u tiles along the box, one repeat = a 40 ft container (12.2 m), so a 20 ft
 * box uses u 0..0.5 (plain) or 0.5..1 (with a shipping-line name). Ends and roof are 1:1 cells.
 */
export const CONTAINER_UV = {
  side: { v0: 0.5, v1: 1 },
  door: { u0: 0, v0: 0, u1: 0.25, v1: 0.5 },
  back: { u0: 0.25, v0: 0, u1: 0.5, v1: 0.5 },
  /** Roof sheet: u across the 2.44 m width, tile it along the length. */
  roof: { u0: 0.5, v0: 0, u1: 0.75, v1: 0.5 },
  door2: { u0: 0.75, v0: 0, u1: 1, v1: 0.5 },
} as const;

/** tex.fence: u tiles along the run (one repeat = `tileM` meters, one post per repeat); v band per kind, `h` = height in meters. */
export const FENCE_UV = {
  chain: { v0: 0.5, v1: 1, tileM: 3, h: 2.4 },
  picket: { v0: 0.25, v1: 0.5, tileM: 2, h: 1 },
  rail: { v0: 0, v1: 0.25, tileM: 2, h: 1.1 },
} as const;

// ── Palette and small tools ──────────────────────────────────────────────────

const INK = '#14213d', BONE = '#f2e8cf', VERM = '#e4572e', MUST = '#f0a202', TEAL = '#2a9d8f';
const BRICK = '#9c4a3c', TERRA = '#c96f4a', SAGE = '#8a9a6b';
const HEAD = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const TEXT = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

/** Lamp-lit rooms, a television, an office ceiling, a workshop tube. */
const WARM = ['#ffd9a0', '#ffe4b8', '#ffcd84', '#fff1d6'] as const;
const OFFICE = ['#fff1d6', '#ffe4b8', '#eef3ff', '#fff6e6'] as const;
const TUBE = ['#eaf3cc', '#ffc56b', '#f4f6e4'] as const;
const TV = '#86bfff';
const GLASS_HI = '#35525e', GLASS_LO = '#1b2f3a';

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h));
  return [cv, cv.getContext('2d') as Ctx];
}

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (r: number, g: number, b: number, a = 1): string =>
  `rgba(${Math.max(0, Math.min(255, Math.round(r)))},${Math.max(0, Math.min(255, Math.round(g)))},${Math.max(0, Math.min(255, Math.round(b)))},${a})`;
/** A hex colour made brighter (k > 1) or darker (k < 1). */
function lum(hex: string, k: number, a = 1): string {
  const [r, g, b] = hexRgb(hex);
  return rgba(r * k, g * k, b * k, a);
}
function mix(a: string, b: string, t: number, alpha = 1): string {
  const [r, g, bl] = hexRgb(a), [r2, g2, b2] = hexRgb(b);
  return rgba(r + (r2 - r) * t, g + (g2 - g) * t, bl + (b2 - bl) * t, alpha);
}
const grey = (v: number, a = 1): string => rgba(v, v, v, a);
const ink = (a: number): string => `rgba(12,16,24,${a})`;

/**
 * The trick that keeps glow maps glued to their windows: every shape is drawn by
 * the same code twice, once choosing the day colour and once the night one
 * (black unless it gives off light).
 */
function painter(c: Ctx, glow: boolean): (day: string | CanvasGradient, night?: string | CanvasGradient) => void {
  return (day, night = '#000') => { c.fillStyle = glow ? night : day; };
}

function vgrad(c: Ctx, y0: number, y1: number, top: string, bottom: string): CanvasGradient {
  const g = c.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  return g;
}

function poly(c: Ctx, pts: number[]): void {
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}
function rrect(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
  c.closePath();
}
/** A rectangle whose top bows upward by `rise` (0 = plain rectangle). Leaves the path open for fill or clip. */
function archPath(c: Ctx, x: number, y: number, w: number, h: number, rise: number): void {
  c.beginPath();
  c.moveTo(x, y + h); c.lineTo(x, y + rise);
  if (rise > 0) c.quadraticCurveTo(x + w / 2, y - rise, x + w, y + rise); else c.lineTo(x + w, y);
  c.lineTo(x + w, y + h); c.closePath();
}
function disc(c: Ctx, x: number, y: number, r: number): void {
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
}

// Noise is made once as small tiles and laid over the big canvases as a
// repeating pattern: per-pixel loops over a 2048 px road would cost a second each.

/** Per-pixel grey noise around mid-grey: laid over with 'overlay' it gives grain without shifting the colour. */
function grainTile(seed: number, size = 256, spread = 90): HTMLCanvasElement {
  const [cv, c] = canvas(size, size);
  const img = c.createImageData(size, size), d = img.data, r = new RNG(seed);
  for (let i = 0; i < d.length; i += 4) {
    const v = 128 + (r.next() + r.next() - 1) * spread;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}

/** Wrapped value noise, 0..1, three octaves. `cells` = blotches across the tile. */
function cloudField(seed: number, size: number, cells: number): Float32Array {
  const out = new Float32Array(size * size), r = new RNG(seed);
  let amp = 0.57;
  for (let o = 0, n = cells; o < 3; o++, n *= 2, amp *= 0.5) {
    const lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = r.next();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * n, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
        const a = lat[y0 * n + x0], b = lat[y0 * n + x1], cc = lat[y1 * n + x0], dd = lat[y1 * n + x1];
        out[y * size + x] += amp * (a + (b - a) * sx + (cc - a + (a - b + dd - cc) * sx) * sy);
      }
    }
  }
  return out;
}
function cloudTile(seed: number, size = 256, cells = 4, contrast = 1.6): HTMLCanvasElement {
  const [cv, c] = canvas(size, size);
  const f = cloudField(seed, size, cells), img = c.createImageData(size, size), d = img.data;
  for (let i = 0; i < f.length; i++) {
    const v = 128 + (f[i] - 0.5) * 255 * contrast;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}

interface Noise { grain: HTMLCanvasElement; fine: HTMLCanvasElement; cloud: HTMLCanvasElement; blotch: HTMLCanvasElement; wear: HTMLCanvasElement }

/** Lay a noise tile over a region. `scale` stretches the tile: keep (tile size x scale) a divisor of a tiling canvas. */
function wash(c: Ctx, w: number, h: number, tile: HTMLCanvasElement, alpha: number, mode: GlobalCompositeOperation = 'overlay', scale = 1): void {
  const p = c.createPattern(tile, 'repeat');
  if (!p) return;
  if (scale !== 1) p.setTransform(new DOMMatrix().scale(scale, scale));
  c.save();
  c.globalAlpha = alpha; c.globalCompositeOperation = mode; c.fillStyle = p;
  c.fillRect(0, 0, w, h);
  c.restore();
}

/** Draw the same thing nine times, one tile apart, so whatever crosses an edge comes back in on the other side. */
function wrapped(c: Ctx, w: number, h: number, fn: () => void, alongU = true, alongV = true): void {
  for (let i = alongU ? -1 : 0; i <= (alongU ? 1 : 0); i++)
    for (let j = alongV ? -1 : 0; j <= (alongV ? 1 : 0); j++) {
      c.save(); c.translate(i * w, j * h); fn(); c.restore();
    }
}

/** A wandering hairline: cracks in asphalt, concrete and plaster. Returns points so it can be drawn wrapped. */
function crackPath(r: RNG, x: number, y: number, ang: number, steps: number, step: number): number[] {
  const pts = [x, y];
  for (let i = 0; i < steps; i++) {
    ang += r.range(-0.7, 0.7);
    x += Math.cos(ang) * step * r.range(0.6, 1.3); y += Math.sin(ang) * step * r.range(0.6, 1.3);
    pts.push(x, y);
  }
  return pts;
}
function strokePts(c: Ctx, pts: number[]): void {
  c.beginPath(); c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.stroke();
}

function finish(cv: HTMLCanvasElement, repeat: boolean | 'u' = false, aniso = 4, data = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = repeat === true ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  return t;
}

// ── Lettering ────────────────────────────────────────────────────────────────

function setFont(c: Ctx, weight: number, px: number, fam = HEAD): void { c.font = `${weight} ${px}px ${fam}`; }

/** Width of `text` at the current font with `track` em of extra space between letters. */
function textW(c: Ctx, text: string, px: number, track = 0): number {
  return c.measureText(text).width + track * px * Math.max(0, text.length - 1);
}
/** Set the largest font up to `max` px at which `text` fits in `maxW`, and return its size. */
function fit(c: Ctx, text: string, weight: number, max: number, maxW: number, fam = HEAD, track = 0): number {
  setFont(c, weight, max, fam);
  const w = textW(c, text, max, track);
  const px = w > maxW ? Math.max(6, Math.floor((max * maxW) / w)) : max;
  setFont(c, weight, px, fam);
  return px;
}
/**
 * Draw text on a baseline. align: -1 left, 0 centered, 1 right. Tracking is done
 * by hand because canvas letterSpacing is still missing from some phones.
 */
function label(c: Ctx, text: string, x: number, y: number, px: number, align = 0, track = 0): void {
  c.textBaseline = 'alphabetic';
  if (!track) {
    c.textAlign = align < 0 ? 'left' : align > 0 ? 'right' : 'center';
    c.fillText(text, x, y);
    return;
  }
  const w = textW(c, text, px, track);
  let cx = align < 0 ? x : align > 0 ? x - w : x - w / 2;
  c.textAlign = 'left';
  for (const ch of text) { c.fillText(ch, cx, y); cx += c.measureText(ch).width + track * px; }
}
/** Height of a capital letter at the current font, for centering lines optically. */
const capH = (c: Ctx): number => c.measureText('H').actualBoundingBoxAscent;

// ── Atlas packing ────────────────────────────────────────────────────────────

type Draw = (c: Ctx, w: number, h: number, glow: boolean) => void;
interface Piece { name: string; w: number; h: number; draw: Draw; x: number; y: number; lit: boolean }

/**
 * Shelf packer. Pieces are queued in design pixels, sorted tallest first, and
 * drawn at `scale`. Each gets its edge pixels smeared into a gutter so mipmaps
 * never pull a neighbour's colour across the seam.
 */
class AtlasBuilder {
  private pieces: Piece[] = [];
  constructor(private width: number, private scale: number, private pad = 4) {}

  /** `lit` pieces are drawn a second time into the glow sheet. */
  add(name: string, w: number, h: number, draw: Draw, lit = false): void {
    this.pieces.push({ name, w, h, draw, x: 0, y: 0, lit });
  }

  build(withGlow: boolean): { cv: HTMLCanvasElement; glow: HTMLCanvasElement | null; rects: Map<string, AtlasRect>; names: string[] } {
    const s = this.scale, pad = this.pad, W = this.width;
    const order = this.pieces.map((p, i) => ({ p, i })).sort((a, b) => b.p.h - a.p.h || a.i - b.i).map((o) => o.p);
    let x = pad, y = pad, rowH = 0;
    for (const p of order) {
      const w = Math.round(p.w * s), h = Math.round(p.h * s);
      if (x + w + pad > W) { x = pad; y += rowH + pad * 2; rowH = 0; }
      p.x = x; p.y = y;
      x += w + pad * 2; rowH = Math.max(rowH, h);
    }
    const H = Math.ceil((y + rowH + pad) / 64) * 64;
    const [cv, c] = canvas(W, H);
    const gs = 0.5, glowPair = withGlow ? canvas(W * gs, H * gs) : null;
    if (glowPair) { glowPair[1].fillStyle = '#000'; glowPair[1].fillRect(0, 0, W * gs, H * gs); }
    c.imageSmoothingEnabled = false;
    const rects = new Map<string, AtlasRect>();
    for (const p of this.pieces) {
      const w = Math.round(p.w * s), h = Math.round(p.h * s);
      const [tv, t] = canvas(w, h);
      t.scale(w / p.w, h / p.h);
      p.draw(t, p.w, p.h, false);
      c.drawImage(tv, p.x, p.y);
      c.drawImage(tv, 0, 0, 1, h, p.x - pad, p.y, pad, h);
      c.drawImage(tv, w - 1, 0, 1, h, p.x + w, p.y, pad, h);
      c.drawImage(tv, 0, 0, w, 1, p.x, p.y - pad, w, pad);
      c.drawImage(tv, 0, h - 1, w, 1, p.x, p.y + h, w, pad);
      if (glowPair && p.lit) {
        const [gv, g] = canvas(w, h);
        g.scale(w / p.w, h / p.h);
        g.fillStyle = '#000'; g.fillRect(0, 0, p.w, p.h);
        p.draw(g, p.w, p.h, true);
        glowPair[1].drawImage(gv, p.x * gs, p.y * gs, w * gs, h * gs);
      }
      rects.set(p.name, { u0: p.x / W, u1: (p.x + w) / W, v0: 1 - (p.y + h) / H, v1: 1 - p.y / H, aspect: p.w / p.h });
    }
    return { cv, glow: glowPair ? glowPair[0] : null, rects, names: this.pieces.map((p) => p.name) };
  }
}

function lookup(kind: string, rects: Map<string, AtlasRect>, names: string[]): Pick<Atlas, 'rect' | 'has' | 'names'> {
  const warned = new Set<string>();
  return {
    names,
    has: (name) => rects.has(name),
    rect(name) {
      const r = rects.get(name);
      if (r) return r;
      if (!warned.has(name)) { warned.add(name); console.warn(`textures: no ${kind} piece called "${name}"`); }
      return rects.get(names[0]) as AtlasRect;
    },
  };
}

// Phones get every canvas at half size. Drawing at full size and shrinking once
// keeps all the pixel arithmetic below free of a scale factor.
let shrinkBy = 1;
function done(cv: HTMLCanvasElement, repeat: boolean | 'u' = false, aniso = 4, data = false): THREE.CanvasTexture {
  if (shrinkBy < 1) {
    const [sv, s] = canvas(cv.width * shrinkBy, cv.height * shrinkBy);
    s.drawImage(cv, 0, 0, sv.width, sv.height);
    cv = sv;
  }
  return finish(cv, repeat, aniso, data);
}

// ── Physically based twins ───────────────────────────────────────────────────
// Every surface gets a normal map and a roughness / metalness sheet made from the
// canvas it was painted on, so the relief can never drift off the picture. Height
// is the paint's own luminance (mortar, cracks, joints and pits are already the
// dark parts; crowns of ribs and tiles the light ones), run through a Sobel filter.
// Three things the luminance cannot know are handled apart:
//   * glass: found by its colour (the dark teal every pane is painted with). It is
//     pushed back into the wall, made flat and near-mirror smooth, and brightened in
//     the colour map, because a metallic surface shows its colour only as the tint
//     of what it reflects. Smooth glass in a rough wall is most of what makes a
//     building read as real.
//   * roughness that is not about brightness (tire paths, tar, road paint): the
//     painter leaves a grey sheet in EXTRA and it is used as drawn.
//   * panes that do not sit quite flat (curtain walls): a tilt sheet in EXTRA.

interface PbrSpec {
  /** Normal strength: slope of the normal per unit of height change across one texel. */
  bump: number;
  /** Roughness at the sheet's mean brightness. */
  rough: number;
  /** How much rougher the dark parts are than the light ones (pits and joints hold dirt). */
  roughK?: number;
  metal?: number;
  /** Look for window glass by colour. */
  glass?: boolean;
  /** Normal map size relative to the colour canvas. */
  scale?: number;
  /** Clip height this far above the mean: paint is bright but it is not a kerb. */
  cap?: number;
}

/** Sheets a painter drew by hand for derive(): `rough` grey = roughness; `tilt` R, G = normal offset around 128, alpha = where. */
const EXTRA = new WeakMap<HTMLCanvasElement, { rough?: HTMLCanvasElement; tilt?: HTMLCanvasElement }>();

const GLASS_GAIN = 1.8, GLASS_ROUGH = 0.07, GLASS_METAL = 0.85;
/** Every pane in the game is painted between GLASS_HI and GLASS_LO or the factory's grey-teal: blue over red, and dark. */
const isGlass = (r: number, g: number, b: number): boolean => b >= g - 2 && b - r > 18 && r + g + b < 380;

function pixels(src: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  if (src.width === w && src.height === h) return (src.getContext('2d') as Ctx).getImageData(0, 0, w, h).data;
  const [cv, c] = canvas(w, h);
  c.drawImage(src, 0, 0, w, h);
  return c.getImageData(0, 0, w, h).data;
}

function derive(cv: HTMLCanvasElement, s: PbrSpec, repeat: boolean | 'u'): { normal: HTMLCanvasElement; orm: HTMLCanvasElement } {
  const k = s.scale ?? 1, w = Math.max(4, Math.round(cv.width * k)), h = Math.max(4, Math.round(cv.height * k)), n = w * h;
  const d = pixels(cv, w, h), ex = EXTRA.get(cv);
  const rr = ex?.rough ? pixels(ex.rough, w, h) : null, tt = ex?.tilt ? pixels(ex.tilt, w, h) : null;
  const H = new Float32Array(n), glass = new Uint8Array(n);
  let mean = 0, cnt = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (d[p + 3] < 8) { H[i] = -1; continue; }       // a gap in an atlas
    const L = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
    H[i] = L; mean += L; cnt++;
    if (s.glass && isGlass(d[p], d[p + 1], d[p + 2])) glass[i] = 1;
  }
  mean /= Math.max(1, cnt);

  const [ov, o] = canvas(w, h), oi = o.createImageData(w, h), od = oi.data;
  const top = mean + (s.cap ?? 1), pit = Math.max(0, mean - 0.24), rk = s.roughK ?? 0.3, metal = (s.metal ?? 0) * 255;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const L = H[i];
    let rough: number, m = metal;
    if (glass[i]) { rough = GLASS_ROUGH; m = GLASS_METAL * 255; H[i] = pit; }
    else if (L < 0) { rough = s.rough; H[i] = mean; }
    else {
      rough = rr ? rr[p] / 255 : s.rough + rk * (mean - L);
      if (L > top) H[i] = top;
    }
    od[p] = 255; od[p + 1] = Math.max(10, Math.min(255, rough * 255)); od[p + 2] = m; od[p + 3] = 255;
  }
  o.putImageData(oi, 0, 0);

  const [nv, c] = canvas(w, h), ni = c.createImageData(w, h), nd = ni.data;
  const wu = repeat !== false, wv = repeat === true, bump = s.bump * 0.125;
  for (let y = 0; y < h; y++) {
    const y0 = (y > 0 ? y - 1 : wv ? h - 1 : 0) * w, y1 = y * w, y2 = (y < h - 1 ? y + 1 : wv ? 0 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : wu ? w - 1 : 0, xp = x < w - 1 ? x + 1 : wu ? 0 : w - 1;
      const a = H[y0 + xm], b = H[y0 + x], cc = H[y0 + xp], e = H[y1 + xm], f = H[y1 + xp], g = H[y2 + xm], hh = H[y2 + x], ii = H[y2 + xp];
      // Canvas rows run down and v runs up, so the v slope changes sign.
      let nx = -((cc + 2 * f + ii) - (a + 2 * e + g)) * bump, ny = ((g + 2 * hh + ii) - (a + 2 * b + cc)) * bump;
      const p = (y1 + x) * 4;
      if (tt && tt[p + 3] > 128) { nx += (tt[p] - 128) / 127; ny += (tt[p + 1] - 128) / 127; }
      const inv = 127 / Math.sqrt(nx * nx + ny * ny + 1);
      nd[p] = 128 + nx * inv; nd[p + 1] = 128 + ny * inv; nd[p + 2] = 128 + inv; nd[p + 3] = 255;
    }
  }
  c.putImageData(ni, 0, 0);

  if (s.glass) {
    const fc = cv.getContext('2d') as Ctx, fi = fc.getImageData(0, 0, cv.width, cv.height), fd = fi.data;
    for (let p = 0; p < fd.length; p += 4) {
      if (fd[p + 3] > 8 && isGlass(fd[p], fd[p + 1], fd[p + 2])) { fd[p] *= GLASS_GAIN; fd[p + 1] *= GLASS_GAIN; fd[p + 2] *= GLASS_GAIN; }
    }
    fc.putImageData(fi, 0, 0);
  }

  // Roughness changes slowly: half the normal map's size is plenty.
  if (w < 512) return { normal: nv, orm: ov };
  const [hv, hc] = canvas(w / 2, h / 2);
  hc.drawImage(ov, 0, 0, w / 2, h / 2);
  return { normal: nv, orm: hv };
}

/** A grey roughness sheet at half the size of a w x h canvas, drawn in that canvas's own pixel coordinates. */
function roughSheet(w: number, h: number, nz: Noise, base: number): [HTMLCanvasElement, Ctx] {
  const [rv, rc] = canvas(w / 2, h / 2);
  rc.scale(0.5, 0.5);
  rc.fillStyle = grey(base); rc.fillRect(0, 0, w, h);
  // Broad patches a little smoother than the rest: dry they hardly show, wet they are where the sky lies in the road.
  wash(rc, w, h, nz.blotch, 0.42, 'overlay', 2);
  wash(rc, w, h, nz.cloud, 0.3, 'overlay');
  return [rv, rc];
}

/** Transparent tile of scattered opaque flecks: rubbed over fresh paint with 'destination-out' it wears it away. */
function wearTile(seed: number, size = 256): HTMLCanvasElement {
  const [cv, c] = canvas(size, size);
  const f = cloudField(seed, size, 6), img = c.createImageData(size, size), d = img.data, r = new RNG(seed + 1);
  for (let i = 0; i < f.length; i++) {
    const v = (f[i] - 0.52) * 3.2 + (r.next() - 0.5) * 0.9;
    d[i * 4 + 3] = v <= 0 ? 0 : Math.min(255, v * 255);
  }
  c.putImageData(img, 0, 0);
  return cv;
}

function makeNoise(): Noise {
  return { grain: grainTile(11), fine: grainTile(12, 128, 50), cloud: cloudTile(13), blotch: cloudTile(14, 256, 2, 2.2), wear: wearTile(15) };
}

// ── Roads ────────────────────────────────────────────────────────────────────

// Sun-faded and warm, well above real asphalt: the road is the biggest shape in every street-level
// frame and building shadows already take it down a long way, so a true charcoal reads as a black slab.
const ASPHALT = '#918c82', ROAD_YELLOW = '#e2a622', ROAD_WHITE = '#ebe5d6';

/** The asphalt mix shared by roads and intersections, so they meet without a change of tone. */
function asphaltBase(c: Ctx, w: number, h: number, nz: Noise, seed: number): RNG {
  const r = new RNG(seed);
  c.fillStyle = ASPHALT; c.fillRect(0, 0, w, h);
  wash(c, w, h, nz.blotch, 0.05, 'overlay', 2);
  wash(c, w, h, nz.cloud, 0.06, 'overlay');
  wash(c, w, h, nz.grain, 0.26, 'overlay');
  // Aggregate: pale stones and dark pits showing through the worn binder.
  for (let i = Math.round((w * h) / 650); i > 0; i--) {
    c.fillStyle = r.chance(0.6) ? grey(225, r.range(0.1, 0.3)) : grey(40, r.range(0.1, 0.28));
    c.fillRect(r.next() * w, r.next() * h, r.range(1, 2.6), r.range(1, 2.6));
  }
  return r;
}

/** Patches of newer asphalt, hairline cracks and tar-sealed ones. `pxm` = pixels per meter. */
function asphaltWear(c: Ctx, w: number, h: number, r: RNG, pxm: number, patches: number, cracks: number, rc: Ctx | null = null): void {
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (rc) { rc.lineCap = 'round'; rc.lineJoin = 'round'; }
  for (let i = 0; i < patches; i++) {
    const pw = r.range(0.9, 2.2) * pxm, ph = r.range(1.2, 3.2) * pxm, x = r.next() * w, y = r.next() * h;
    wrapped(c, w, h, () => {
      c.fillStyle = ink(0.08); c.fillRect(x, y, pw, ph);
      c.strokeStyle = ink(0.2); c.lineWidth = Math.max(1.5, pxm * 0.03); c.strokeRect(x, y, pw, ph);
    });
    // A newer patch is closer-grained than the road round it, and its sealed edge is tar.
    if (rc) wrapped(rc, w, h, () => {
      rc.fillStyle = grey(196, 0.85); rc.fillRect(x, y, pw, ph);
      rc.strokeStyle = grey(96); rc.lineWidth = Math.max(2.5, pxm * 0.035); rc.strokeRect(x, y, pw, ph);
    });
  }
  for (let i = 0; i < cracks; i++) {
    const sealed = i % 3 === 0;
    const pts = crackPath(r, r.next() * w, r.next() * h, r.range(0, TAU_), r.int(7, 16), pxm * 0.28);
    c.strokeStyle = ink(sealed ? 0.42 : 0.34); c.lineWidth = Math.max(1, pxm * (sealed ? 0.045 : 0.014));
    wrapped(c, w, h, () => strokePts(c, pts));
    if (rc && sealed) { rc.strokeStyle = grey(84); rc.lineWidth = Math.max(2.5, pxm * 0.05); wrapped(rc, w, h, () => strokePts(rc, pts)); }
  }
}
const TAU_ = Math.PI * 2;

/**
 * A full-width road. lanes = lane centers in meters from the centerline; solid and
 * dashed = white line offsets. Everything is mirrored about the middle.
 */
function roadCanvas(nz: Noise, seed: number, widthM: number, W: number, lanes: number[], solid: number[], dashed: number[]): HTMLCanvasElement {
  const H = 1024, [cv, c] = canvas(W, H), px = W / widthM, py = H / TILE_M.street;
  const r = asphaltBase(c, W, H, nz, seed);
  const X = (m: number): number => W / 2 + m * px;
  // Roughness, drawn beside the colour: open aggregate, then everything traffic and crews have done to it.
  const [rv, rc] = roughSheet(W, H, nz, 232);
  const polish = (m: number, halfM: number, v: number, a: number): void => {
    const g = rc.createLinearGradient(X(m - halfM), 0, X(m + halfM), 0);
    g.addColorStop(0, grey(v, 0)); g.addColorStop(0.5, grey(v, a)); g.addColorStop(1, grey(v, 0));
    rc.fillStyle = g; rc.fillRect(X(m - halfM), 0, halfM * 2 * px, H);
  };
  const band = (m: number, halfM: number, a: number): void => {
    const g = c.createLinearGradient(X(m - halfM), 0, X(m + halfM), 0);
    g.addColorStop(0, ink(0)); g.addColorStop(0.5, ink(a)); g.addColorStop(1, ink(0));
    c.fillStyle = g; c.fillRect(X(m - halfM), 0, halfM * 2 * px, H);
  };
  for (const side of [-1, 1]) {
    for (const l of lanes) {
      band(side * (l - 0.82), 0.45, 0.085); band(side * (l + 0.82), 0.45, 0.085);  // tire paths
      band(side * l, 0.3, 0.05);                                               // the oil drip line between them
      polish(side * (l - 0.82), 0.55, 140, 0.8); polish(side * (l + 0.82), 0.55, 140, 0.8);   // tires polish the stone
      polish(side * l, 0.3, 110, 0.4);
    }
    // Gutter grime against the curb.
    const g = c.createLinearGradient(X(side * (widthM / 2 - 0.9)), 0, X(side * widthM / 2), 0);
    g.addColorStop(0, ink(0)); g.addColorStop(1, ink(0.14));
    c.fillStyle = g; c.fillRect(Math.min(X(side * (widthM / 2 - 0.9)), X(side * widthM / 2)), 0, 0.9 * px, H);
  }
  // Oil stains where cars park.
  const park = widthM / 2 - 1.3;
  for (let i = 0; i < 7; i++) {
    const x = X(r.sign() * (park + r.range(-0.5, 0.5))), y = r.next() * H, rad = r.range(0.15, 0.4) * px;
    wrapped(c, W, H, () => {
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, ink(0.26)); g.addColorStop(1, ink(0));
      c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }, false, true);
    wrapped(rc, W, H, () => {
      const g = rc.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, grey(60, 0.9)); g.addColorStop(1, grey(60, 0));
      rc.fillStyle = g; rc.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }, false, true);
  }
  asphaltWear(c, W, H, r, px, 3, 7, rc);

  // Paint goes on its own layer so it can be worn through before it lands on the asphalt.
  const [pv, p] = canvas(W, H);
  const line = (m: number, wM: number, col: string, y0 = 0, y1 = H): void => {
    p.fillStyle = col; p.fillRect(X(m) - (wM * px) / 2, y0, wM * px, y1 - y0);
  };
  for (const side of [-1, 1]) {
    line(side * 0.13, 0.11, ROAD_YELLOW);
    for (const m of solid) line(side * m, 0.11, ROAD_WHITE);
    for (const m of dashed) line(side * m, 0.12, ROAD_WHITE, 4.5 * py, 7.5 * py);
  }
  wash(p, W, H, nz.wear, 0.75, 'destination-out');
  wash(p, W, H, nz.wear, 0.5, 'destination-out', 2);
  c.globalAlpha = 0.92; c.drawImage(pv, 0, 0); c.globalAlpha = 1;
  // Road paint is the glossiest thing on the street, exactly where it has not worn through.
  p.globalCompositeOperation = 'source-in'; p.fillStyle = grey(104); p.fillRect(0, 0, W, H);
  rc.drawImage(pv, 0, 0);
  EXTRA.set(cv, { rough: rv });
  return cv;
}

function asphaltCanvas(nz: Noise): HTMLCanvasElement {
  const [cv, c] = canvas(512, 512);
  const r = asphaltBase(c, 512, 512, nz, 31);
  const [rv, rc] = roughSheet(512, 512, nz, 232);
  asphaltWear(c, 512, 512, r, 512 / TILE_M.asphalt, 2, 5, rc);
  EXTRA.set(cv, { rough: rv });
  return cv;
}

/** Vermilion and bone chevrons pointing toward +v, scuffed by tires. */
function rampCanvas(nz: Noise): HTMLCanvasElement {
  const S = 256, [cv, c] = canvas(S, S);
  c.fillStyle = BONE; c.fillRect(0, 0, S, S);
  c.fillStyle = VERM;
  for (let y = -S; y < S * 2; y += 128) { poly(c, [0, y + 128, 128, y, S, y + 128, S, y + 192, 128, y + 64, 0, y + 192]); c.fill(); }
  wash(c, S, S, nz.grain, 0.35, 'overlay');
  wash(c, S, S, nz.cloud, 0.25, 'multiply');
  const r = new RNG(77);
  for (let i = 0; i < 5; i++) { c.fillStyle = ink(r.range(0.06, 0.14)); c.fillRect(r.next() * S, 0, r.range(10, 26), S); }
  return cv;
}

/**
 * Road paint with alpha. Rows that tile along u sit at the top; stamps below.
 * Layout is fixed here and mirrored in MARK_RECTS, both in canvas pixels of a 1024 sheet.
 */
const MARK_PX: Record<string, [number, number, number, number]> = {
  crosswalk: [0, 8, 1024, 320], stopline: [0, 344, 1024, 54], line: [0, 414, 1024, 16],
  hatch: [0, 446, 1024, 160], solid: [0, 622, 1024, 16],
  arrow: [8, 656, 150, 360], arrowTurn: [170, 656, 190, 360], duckXing: [372, 656, 200, 200],
  manhole: [584, 656, 136, 136], drain: [732, 656, 150, 76], stain: [584, 804, 200, 200], stop: [796, 744, 220, 272],
};
function marksCanvas(nz: Noise): HTMLCanvasElement {
  const S = 1024, [cv, c] = canvas(S, S), W = '#ffffff';
  const at = (n: string, fn: (w: number, h: number) => void): void => {
    const [x, y, w, h] = MARK_PX[n];
    c.save(); c.translate(x, y); c.beginPath(); c.rect(0, 0, w, h); c.clip(); fn(w, h); c.restore();
  };
  c.fillStyle = W;
  // 8 stripes per repeat; a half gap at each end so the ladder is symmetric about u = 0.
  at('crosswalk', (_w, h) => { for (let i = 0; i < 8; i++) c.fillRect(32 + i * 128, 0, 64, h); });
  at('stopline', (w, h) => c.fillRect(0, 0, w, h));
  at('line', (w, h) => c.fillRect(0, 0, w, h));
  at('solid', (w, h) => c.fillRect(0, 0, w, h));
  at('hatch', (w, h) => {
    for (let x = -h; x < w + h; x += 64) { poly(c, [x, h, x + h, 0, x + h + 22, 0, x + 22, h]); c.fill(); }
    c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
  });
  // The tiling rows take the heavy wear; the stamps below are drawn after it and only get the light pass.
  wash(c, S, 640, nz.wear, 0.8, 'destination-out');
  at('arrow', (w, h) => { poly(c, [w / 2, 0, w, h * 0.42, w * 0.66, h * 0.42, w * 0.66, h, w * 0.34, h, w * 0.34, h * 0.42, 0, h * 0.42]); c.fill(); });
  at('arrowTurn', (w, h) => { poly(c, [w * 0.62, h, w * 0.92, h, w * 0.92, h * 0.2, w * 0.42, h * 0.2, w * 0.42, 0, 0, h * 0.3, w * 0.42, h * 0.6, w * 0.42, h * 0.4, w * 0.62, h * 0.4]); c.fill(); });
  // Road lettering is stretched tall so it reads from a driver's low angle.
  at('stop', (w, h) => { c.save(); c.scale(1, 2.3); fit(c, 'STOP', 900, 118, w - 8); label(c, 'STOP', w / 2, h / 2.3 - 6, 100); c.restore(); });
  at('duckXing', (w, h) => {
    c.save(); c.translate(w / 2, h / 2); c.scale(w / 220, h / 220);
    c.beginPath(); c.ellipse(-6, 22, 58, 36, 0, 0, TAU_); c.fill();
    disc(c, 42, -26, 27); poly(c, [62, -30, 96, -22, 64, -12]); c.fill();
    poly(c, [-60, 8, -92, -18, -50, -8]); c.fill();
    c.fillRect(-70, 76, 140, 10);
    c.restore();
  });
  wash(c, S, S, nz.wear, 0.55, 'destination-out', 2);
  // Ironwork and stains carry their own colours and are not worn.
  at('manhole', (w) => {
    const m = w / 2;
    c.fillStyle = '#3d3f42'; disc(c, m, m, m - 2); c.fillStyle = '#56585a'; disc(c, m, m, m - 10);
    c.strokeStyle = '#34363a'; c.lineWidth = 5;
    for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(m + i * 14, 18); c.lineTo(m + i * 14, w - 18); c.stroke(); }
    c.fillStyle = '#56585a'; disc(c, m, m, 20); c.fillStyle = '#34363a'; disc(c, m, m, 7);
  });
  at('drain', (w, h) => {
    c.fillStyle = '#3d3f42'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#17191c'; for (let i = 0; i < 7; i++) c.fillRect(12 + i * 19, 10, 9, h - 20);
  });
  at('stain', (w, h) => {
    const r = new RNG(91);
    for (let i = 0; i < 9; i++) {
      const x = w / 2 + r.range(-0.2, 0.2) * w, y = h / 2 + r.range(-0.2, 0.2) * h, rad = r.range(0.12, 0.3) * w;
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, ink(0.45)); g.addColorStop(1, ink(0));
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
  });
  return cv;
}

// ── Ground ───────────────────────────────────────────────────────────────────

function sidewalkCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), r = new RNG(41);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { c.fillStyle = grey(r.range(176, 192)); c.fillRect(i * 256, j * 256, 256, 256); }
  c.fillStyle = 'rgba(214,190,140,0.14)'; c.fillRect(0, 0, S, S);   // a little warmth: old concrete, not office grey
  wash(c, S, S, nz.cloud, 0.22, 'overlay');
  wash(c, S, S, nz.grain, 0.4, 'overlay');
  for (let i = 0; i < 2; i++) {
    c.fillStyle = ink(0.42); c.fillRect(i * 256 - 2, 0, 4, S); c.fillRect(0, i * 256 - 2, S, 4); c.fillRect(S - 2, 0, 2, S); c.fillRect(0, S - 2, S, 2);
    c.fillStyle = grey(255, 0.2); c.fillRect(i * 256 + 2, 0, 2, S); c.fillRect(0, i * 256 + 2, S, 2);
  }
  c.strokeStyle = ink(0.35); c.lineWidth = 1.3;
  for (let i = 0; i < 3; i++) strokePts(c, crackPath(r, r.range(40, 470), r.range(40, 470), r.range(0, TAU_), r.int(5, 10), 16));
  for (let i = 0; i < 14; i++) { c.fillStyle = ink(r.range(0.12, 0.3)); disc(c, r.range(8, 504), r.range(8, 504), r.range(2, 5)); }   // gum
  return cv;
}

function grassCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), r = new RNG(42);
  c.fillStyle = '#7c9455'; c.fillRect(0, 0, S, S);
  // Kept faint: strong blotches show the 8 m repeat as a checkerboard across a lawn.
  wash(c, S, S, nz.blotch, 0.08, 'overlay', 2);
  wash(c, S, S, nz.cloud, 0.12, 'overlay');
  const blades = ['#93a965', '#6a8349', '#a3b574', '#5f7a44', '#b3bb7d'];
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = blades[i % 5]; c.globalAlpha = r.range(0.25, 0.7);
    c.fillRect(r.next() * S, r.next() * S, 1.6, r.range(3, 7));
  }
  c.globalAlpha = 1;
  wash(c, S, S, nz.grain, 0.3, 'overlay');
  return cv;
}

function sandCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), r = new RNG(43);
  c.fillStyle = '#e2d0a2'; c.fillRect(0, 0, S, S);
  wash(c, S, S, nz.blotch, 0.09, 'overlay', 2);
  // Wind ripples: whole numbers of waves each way so the tile closes on itself.
  c.lineWidth = 3;
  for (let k = 0; k < 16; k++) {
    c.strokeStyle = k % 2 ? grey(255, 0.1) : 'rgba(120,90,40,0.1)';
    c.beginPath();
    for (let x = 0; x <= S; x += 8) { const y = (k + 0.5) * 32 + (k % 2) * 3 + Math.sin((x / S) * TAU_ * 3 + k * 0.5) * 7; if (x) c.lineTo(x, y); else c.moveTo(x, y); }
    c.stroke();
  }
  wash(c, S, S, nz.grain, 0.55, 'overlay');
  for (let i = 0; i < 260; i++) { c.fillStyle = r.chance(0.5) ? grey(255, 0.5) : 'rgba(110,84,50,0.45)'; c.fillRect(r.next() * S, r.next() * S, r.range(1, 3), r.range(1, 2.4)); }
  return cv;
}

function woodCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), r = new RNG(44), pw = S / 16;
  for (let i = 0; i < 16; i++) {
    const v = r.range(-16, 16), x = i * pw;
    c.fillStyle = rgba(190 + v, 178 + v, 154 + v); c.fillRect(x, 0, pw, S);
    // Grain: long streaks that never cross a plank edge, and run the full repeat so v tiles.
    for (let k = 0; k < 7; k++) { c.fillStyle = r.chance(0.5) ? ink(r.range(0.05, 0.14)) : grey(255, r.range(0.06, 0.14)); c.fillRect(x + r.range(2, pw - 3), 0, r.range(1, 2.5), S); }
    c.fillStyle = ink(0.55); c.fillRect(x, 0, 2, S);
    c.fillStyle = grey(255, 0.16); c.fillRect(x + 2, 0, 1.5, S);
    // Butt joints, staggered, with a nail either side.
    const jy = r.range(20, S - 20);
    c.fillStyle = ink(0.5); c.fillRect(x, jy, pw, 2);
    c.fillStyle = ink(0.6);
    for (const dy of [-9, 9]) for (const dx of [8, pw - 7]) disc(c, x + dx, jy + dy, 1.7);
    if (r.chance(0.3)) { c.fillStyle = 'rgba(80,60,40,0.3)'; c.beginPath(); c.ellipse(x + pw / 2, r.next() * S, 4, 7, 0, 0, TAU_); c.fill(); }
  }
  wash(c, S, S, nz.cloud, 0.22, 'overlay');
  wash(c, S, S, nz.fine, 0.3, 'overlay');
  return cv;
}

function cobbleCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), cols = 12, rows = 16, cw = S / cols, rh = S / rows;
  c.fillStyle = '#6a655d'; c.fillRect(0, 0, S, S);
  for (let j = 0; j < rows; j++) for (let i = -1; i < cols; i++) {
    const x = (i + (j % 2) * 0.5) * cw, y = j * rh;
    // The stone that hangs off the right edge is the one that starts off the left, so reuse its shade.
    const v = hashShade(((i + cols) % cols) + j * 31) * 34 - 17;
    c.fillStyle = rgba(172 + v, 165 + v, 153 + v);
    rrect(c, x + 2, y + 2, cw - 4, rh - 4, 6); c.fill();
    c.fillStyle = grey(255, 0.16); rrect(c, x + 4, y + 3, cw - 10, 4, 2); c.fill();
    c.fillStyle = ink(0.16); rrect(c, x + 4, y + rh - 8, cw - 8, 5, 2); c.fill();
  }
  wash(c, S, S, nz.cloud, 0.25, 'overlay');
  wash(c, S, S, nz.grain, 0.4, 'overlay');
  return cv;
}
const hashShade = (n: number): number => { const s = Math.sin(n * 127.1 + 3.7) * 43758.5453; return s - Math.floor(s); };

// ── Roofs ────────────────────────────────────────────────────────────────────

function gravelCanvas(nz: Noise): HTMLCanvasElement {
  const S = 256, [cv, c] = canvas(S, S), r = new RNG(51);
  c.fillStyle = '#b3ada0'; c.fillRect(0, 0, S, S);
  wash(c, S, S, nz.cloud, 0.3, 'overlay');
  for (let i = 0; i < 3800; i++) { c.fillStyle = r.chance(0.5) ? grey(240, r.range(0.2, 0.5)) : grey(40, r.range(0.15, 0.4)); c.fillRect(r.next() * S, r.next() * S, 2, 2); }
  wash(c, S, S, nz.grain, 0.35, 'overlay');
  return cv;
}

/** Barrel tiles: ribs climb the slope (v), courses overlap every eighth of the repeat. */
function roofTileCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), r = new RNG(52), cw = S / 16, ch = S / 8;
  for (let j = 0; j < 8; j++) for (let i = 0; i < 16; i++) {
    const x = i * cw, y = j * ch, v = r.range(-0.12, 0.12);
    const g = c.createLinearGradient(x, 0, x + cw, 0);
    g.addColorStop(0, lum(TERRA, 0.52 + v)); g.addColorStop(0.2, lum(TERRA, 0.92 + v));
    g.addColorStop(0.5, lum(TERRA, 1.14 + v)); g.addColorStop(0.82, lum(TERRA, 0.86 + v)); g.addColorStop(1, lum(TERRA, 0.5 + v));
    c.fillStyle = g; c.fillRect(x, y, cw, ch);
    // The lip of the tile above casts a shadow down onto this one.
    c.fillStyle = vgrad(c, y, y + 12, ink(0.5), ink(0)); c.fillRect(x, y, cw, 12);
    c.fillStyle = grey(255, 0.14); c.fillRect(x + 6, y + ch - 5, cw - 12, 3);
  }
  wash(c, S, S, nz.cloud, 0.3, 'overlay');
  wash(c, S, S, nz.grain, 0.3, 'overlay');
  return cv;
}

function shingleCanvas(nz: Noise): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S), rows = 16, rh = S / rows, tw = 64;
  for (let j = 0; j < rows; j++) for (let i = -1; i < 8; i++) {
    const x = (i + (j % 2) * 0.5) * tw, y = j * rh, v = hashShade(((i + 8) % 8) * 7 + j * 13) * 30 - 15;
    c.fillStyle = grey(182 + v); c.fillRect(x, y, tw, rh);
    c.fillStyle = ink(0.3); c.fillRect(x, y, 2, rh);
    c.fillStyle = vgrad(c, y, y + 8, ink(0.42), ink(0)); c.fillRect(x, y, tw, 8);
  }
  wash(c, S, S, nz.grain, 0.6, 'overlay');
  wash(c, S, S, nz.cloud, 0.2, 'overlay');
  return cv;
}

/** A strip of ribs as a repeating pattern source: light on the crown, shade in the valley. */
function ribTile(period: number, lo: number, hi: number): HTMLCanvasElement {
  const [cv, c] = canvas(period, 8);
  for (let x = 0; x < period; x++) {
    const t = 0.5 - 0.5 * Math.cos(((x + 0.5) / period) * TAU_);
    c.fillStyle = grey(lo + (hi - lo) * t); c.fillRect(x, 0, 1, 8);
  }
  return cv;
}
function ribs(c: Ctx, x: number, y: number, w: number, h: number, tile: HTMLCanvasElement): void {
  const p = c.createPattern(tile, 'repeat');
  if (!p) return;
  c.save(); c.translate(x, y); c.fillStyle = p; c.fillRect(0, 0, w, h); c.restore();
}

function corrugatedCanvas(nz: Noise): HTMLCanvasElement {
  const S = 256, [cv, c] = canvas(S, S), r = new RNG(53);
  ribs(c, 0, 0, S, S, ribTile(16, 158, 232));
  c.fillStyle = ink(0.3); c.fillRect(0, 126, S, 2); c.fillStyle = grey(255, 0.25); c.fillRect(0, 128, S, 2);
  for (let i = 0; i < 16; i++) { c.fillStyle = ink(0.4); disc(c, i * 16 + 8, 134, 1.6); }
  for (let i = 0; i < 10; i++) { c.fillStyle = `rgba(150,84,48,${r.range(0.05, 0.16)})`; c.fillRect(r.next() * S, r.next() * S, r.range(3, 8), r.range(20, 70)); }
  wash(c, S, S, nz.cloud, 0.22, 'overlay');
  wash(c, S, S, nz.fine, 0.2, 'overlay');
  return cv;
}

// ── Containers and fences ────────────────────────────────────────────────────

function containerCanvas(nz: Noise): HTMLCanvasElement {
  const W = 1024, H = 512, [cv, c] = canvas(W, H), r = new RNG(61), rib = ribTile(32, 168, 236), fine = ribTile(16, 176, 232);
  // Side: the top half. Two 20 ft boxes end to end make one 40 ft repeat.
  ribs(c, 0, 0, W, 256, rib);
  c.fillStyle = grey(150); c.fillRect(0, 0, W, 14); c.fillRect(0, 240, W, 16);
  c.fillStyle = grey(232); c.fillRect(0, 14, W, 3);
  for (const x of [0, 512, 1024]) { c.fillStyle = grey(160); c.fillRect(x - 9, 0, 18, 256); c.fillStyle = ink(0.3); c.fillRect(x - 10, 0, 2, 256); c.fillRect(x + 8, 0, 2, 256); }
  // Stencil lettering is dark so it survives the tint (white would just vanish into a pale box).
  c.fillStyle = 'rgba(30,34,44,0.82)';
  fit(c, 'CALAMITY LINE', 900, 84, 400); label(c, 'CALAMITY LINE', 768, 148, 84, 0, 0.04);
  setFont(c, 500, 22, MONO); label(c, 'CLMU 404199 7', 1000, 52, 22, 1); label(c, 'PCHU 198700 3', 488, 52, 22, 1);
  setFont(c, 600, 15, TEXT); label(c, 'MAX GROSS 67,200 LB · TARE 8,380 LB · DUCKS 0', 1000, 226, 15, 1);
  for (let i = 0; i < 16; i++) { c.fillStyle = `rgba(140,74,40,${r.range(0.08, 0.2)})`; c.fillRect(r.next() * W, r.range(14, 200), r.range(3, 9), r.range(16, 60)); }
  // Bottom half: door, back, roof, second door.
  const door = (x: number, tag: string): void => {
    c.fillStyle = grey(206); c.fillRect(x, 256, 256, 256);
    c.fillStyle = grey(150); c.fillRect(x, 256, 256, 12); c.fillRect(x, 496, 256, 16); c.fillRect(x, 256, 10, 256); c.fillRect(x + 246, 256, 10, 256);
    c.fillStyle = ink(0.45); c.fillRect(x + 126, 268, 4, 228);
    for (const bx of [44, 92, 160, 208]) {
      c.fillStyle = grey(128); c.fillRect(x + bx, 270, 7, 224); c.fillStyle = grey(245, 0.6); c.fillRect(x + bx, 270, 2, 224);
      c.fillStyle = grey(96); c.fillRect(x + bx - 8, 392, 23, 9);
    }
    for (const hy of [290, 350, 410, 470]) { c.fillStyle = grey(120); c.fillRect(x + 10, hy, 12, 8); c.fillRect(x + 234, hy, 12, 8); }
    c.fillStyle = 'rgba(30,34,44,0.8)'; setFont(c, 500, 15, MONO); label(c, tag, x + 238, 292, 15, 1);
  };
  door(0, 'CLMU 404199 7'); door(768, 'PCHU 198700 3');
  ribs(c, 256, 256, 256, 256, rib);
  c.fillStyle = grey(150); c.fillRect(256, 256, 256, 12); c.fillRect(256, 496, 256, 16); c.fillRect(256, 256, 10, 256); c.fillRect(502, 256, 10, 256);
  ribs(c, 512, 256, 256, 256, fine);
  c.fillStyle = ink(0.12); c.fillRect(512, 256, 256, 256);
  wash(c, W, H, nz.cloud, 0.2, 'overlay');
  wash(c, W, H, nz.grain, 0.18, 'overlay');
  return cv;
}

function fenceCanvas(): HTMLCanvasElement {
  const S = 512, [cv, c] = canvas(S, S);
  // Chain link: canvas rows 0..256. The post straddles u = 0 so half shows at each end of a repeat.
  c.save(); c.beginPath(); c.rect(0, 6, S, 250); c.clip();
  c.strokeStyle = '#a4aaac'; c.lineWidth = 2.6;
  for (let x = -S; x < S * 2; x += 16) {
    c.beginPath(); c.moveTo(x, 6); c.lineTo(x + 250, 256); c.stroke();
    c.beginPath(); c.moveTo(x, 6); c.lineTo(x - 250, 256); c.stroke();
  }
  c.fillStyle = '#8d9396'; c.fillRect(0, 6, S, 8); c.fillRect(0, 246, S, 6);
  c.fillRect(-7, 6, 14, 250); c.fillRect(S - 7, 6, 14, 250);
  c.restore();
  // Picket: rows 256..384, eight pickets per repeat.
  for (let i = 0; i < 8; i++) {
    const x = i * 64 + 10;
    c.fillStyle = '#f1ede2'; poly(c, [x, 384, x, 280, x + 22, 262, x + 44, 280, x + 44, 384]); c.fill();
    c.fillStyle = ink(0.14); c.fillRect(x + 38, 280, 6, 104);
  }
  c.fillStyle = '#d9d4c8'; c.fillRect(0, 300, S, 10); c.fillRect(0, 352, S, 10);
  for (let i = 0; i < 8; i++) { c.fillStyle = '#f1ede2'; c.fillRect(i * 64 + 10, 296, 38, 18); c.fillRect(i * 64 + 10, 348, 38, 18); }
  // Railing: rows 384..512, a post per repeat and thin balusters.
  c.fillStyle = '#e9e5da';
  c.fillRect(0, 390, S, 12); c.fillRect(0, 492, S, 8);
  for (let i = 0; i < 8; i++) c.fillRect(i * 64 + 28, 400, 7, 94);
  c.fillRect(-9, 388, 18, 124); c.fillRect(S - 9, 388, 18, 124);
  return cv;
}

function glowCanvas(): HTMLCanvasElement {
  const S = 128, [cv, c] = canvas(S, S);
  c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  // Roughly a gaussian: a hot core and a long tail that reaches exactly black at the rim, so quads never show their corners.
  for (const [t, v] of [[0, 255], [0.08, 232], [0.2, 150], [0.36, 80], [0.55, 34], [0.75, 10], [1, 0]]) g.addColorStop(t, grey(v));
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  return cv;
}

function noiseCanvas(): HTMLCanvasElement {
  const S = 256, [cv, c] = canvas(S, S), a = cloudField(71, S, 4), b = cloudField(72, S, 8), r = new RNG(73);
  const img = c.createImageData(S, S), d = img.data;
  for (let i = 0; i < a.length; i++) { d[i * 4] = a[i] * 255; d[i * 4 + 1] = b[i] * 255; d[i * 4 + 2] = r.next() * 255; d[i * 4 + 3] = 255; }
  c.putImageData(img, 0, 0);
  return cv;
}

// ── Facades ──────────────────────────────────────────────────────────────────
// One 1024 px sheet per style, 8 x 8 cells of 128 px. Row 0 of the cells is the
// top of the canvas; since Batch.walls() only ever shifts by whole cells, which
// row is which does not matter, only that every cell is a complete floor.

interface Cell { lit: number; tint: string; blind: number; kind: number }

/**
 * Who is home. About a third of the cells end up lit. `runs` lights stretches of a
 * floor together, the way offices do, which is what stops a tower looking like a
 * random checkerboard.
 */
function cellGrid(seed: number, p: number, palette: readonly string[], tvP: number, runs: boolean): Cell[] {
  const r = new RNG(seed), out: Cell[] = [];
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      const tv = r.chance(tvP);
      out.push({ lit: r.chance(p) ? r.range(0.62, 1.12) * (tv ? 0.75 : 1) : 0, tint: tv ? TV : r.pick(palette), blind: r.chance(0.45) ? r.range(0.15, 0.7) : 0, kind: r.next() });
    }
    if (!runs) continue;
    for (let k = r.int(0, 2); k > 0; k--) {
      const a = r.int(0, 7), n = r.int(2, 4), tint = r.pick(palette), lit = r.range(0.72, 1.1);
      for (let i = a; i < a + n; i++) { const cell = out[j * 8 + (i % 8)]; cell.lit = lit * r.range(0.85, 1); cell.tint = tint; }
    }
  }
  return out;
}

type Paint = ReturnType<typeof painter>;

/** A pane: dark teal by day, and by night whatever its room is doing. */
function pane(c: Ctx, set: Paint, x: number, y: number, w: number, h: number, cell: Cell | null, k = 1): void {
  const lit = cell ? cell.lit * k : 0;
  set(vgrad(c, y, y + h, GLASS_HI, GLASS_LO), lit && cell ? vgrad(c, y, y + h, lum(cell.tint, lit), lum(cell.tint, lit * 0.82)) : '#000');
  c.fillRect(x, y, w, h);
}
const litCol = (cell: Cell, k: number): string => (cell.lit ? lum(cell.tint, cell.lit * k) : '#000');

function facadePair(draw: (c: Ctx, glow: boolean) => void): [HTMLCanvasElement, HTMLCanvasElement] {
  const [cv, c] = canvas(1024, 1024);
  draw(c, false);
  // Weather: every floor line sheds a little dirt down the wall below it. Streaks stop short of the
  // next floor or the sheet's edge, so any cell can still sit above any other.
  const gr = new RNG(109);
  for (let i = 0; i < 90; i++) {
    const x = gr.next() * 1024, y = gr.int(0, 7) * 128 + gr.range(-6, 30), len = gr.range(24, 92), wd = gr.range(3, 13);
    c.fillStyle = vgrad(c, y, y + len, `rgba(58,50,40,${gr.range(0.05, 0.14)})`, 'rgba(58,50,40,0)');
    c.fillRect(x, y, wd, len);
  }
  // Half size is plenty for light, and the same drawing code guarantees it lines up.
  const [gv, g] = canvas(512, 512);
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
  g.scale(0.5, 0.5);
  draw(g, true);
  return [cv, gv];
}

function eachCell(cells: Cell[], fn: (x: number, y: number, cell: Cell, i: number, j: number) => void): void {
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) fn(i * 128, j * 128, cells[j * 8 + i], i, j);
}

/** 0: curtain wall. Two panes a bay over an opaque spandrel panel, pale mullions. */
function glassFacade(nz: Noise): [HTMLCanvasElement, HTMLCanvasElement] {
  const cells = cellGrid(101, 0.14, OFFICE, 0.02, true);
  // No two panes of a curtain wall sit in quite the same plane, which is why a real tower's
  // reflection of the sky breaks up pane by pane instead of lying across it like a poster.
  const [tv, t] = canvas(1024, 1024);
  const pair = facadePair((c, glow) => {
    const set = painter(c, glow);
    set('#dcdedb'); c.fillRect(0, 0, 1024, 1024);
    eachCell(cells, (x, y, cell) => {
      set('#a9b3b6'); c.fillRect(x + 4, y + 97, 120, 27);
      set('#c3cacb'); c.fillRect(x + 4, y + 97, 120, 3);
      for (let k = 0; k < 2; k++) {
        const px = x + 4 + k * 61, py = y + 5, pw = 59, ph = 88;
        pane(c, set, px, py, pw, ph, cell);
        if (!glow) {
          t.fillStyle = rgba(128 + (hashShade(x * 3.1 + y * 0.7 + k * 19) - 0.5) * 11, 128 + (hashShade(x * 1.3 + y * 2.9 + k * 7) - 0.5) * 9, 255);
          t.fillRect(px - 1, py - 1, pw + 2, ph + 2);
        }
        // Blinds on a few bays only; on every bay they turn the tower into a patchwork.
        if (cell.blind && cell.kind > 0.6) { set('rgba(214,212,200,0.85)', litCol(cell, 0.55)); c.fillRect(px, py, pw, ph * cell.blind * 0.6); }
        if (!glow) {
          c.fillStyle = grey(255, 0.05 + cell.kind * 0.06);
          poly(c, [px + pw * 0.1, py + ph, px + pw * 0.5, py, px + pw * 0.85, py, px + pw * 0.45, py + ph]); c.fill();
        }
      }
    });
    if (!glow) wash(c, 1024, 1024, nz.cloud, 0.14, 'overlay', 4);
  });
  EXTRA.set(pair[0], { tilt: tv });
  return pair;
}

function brickTile(): HTMLCanvasElement {
  const [cv, c] = canvas(256, 256), r = new RNG(102);
  c.fillStyle = '#b9b1a4'; c.fillRect(0, 0, 256, 256);
  for (let j = 0; j < 32; j++) for (let i = -1; i < 8; i++) {
    const v = hashShade(((i + 8) % 8) * 5 + j * 17) * 40 + 190 + r.range(-3, 3);
    c.fillStyle = rgba(v + 8, v, v - 9);
    c.fillRect((i + (j % 2) * 0.5) * 32 + 1, j * 8 + 1, 30, 6.4);
  }
  return cv;
}

/** 1: brick with two-over-two sash windows under stone lintels. */
function brickFacade(nz: Noise): [HTMLCanvasElement, HTMLCanvasElement] {
  const cells = cellGrid(103, 0.34, WARM, 0.14, false), bricks = brickTile(), FRAME = '#f2ede0';
  return facadePair((c, glow) => {
    const set = painter(c, glow);
    if (glow) { c.fillStyle = '#000'; c.fillRect(0, 0, 1024, 1024); }
    else {
      c.fillStyle = c.createPattern(bricks, 'repeat') as CanvasPattern; c.fillRect(0, 0, 1024, 1024);
      wash(c, 1024, 1024, nz.cloud, 0.2, 'overlay', 4);
    }
    eachCell(cells, (x, y, cell) => {
      const wx = x + 36, wy = y + 24, ww = 56, wh = 80;
      set('#ece7dc'); c.fillRect(x + 28, y + 12, 72, 12); c.fillRect(x + 28, y + 104, 72, 7);
      if (!glow) {
        c.fillStyle = ink(0.28); c.fillRect(x + 30, y + 111, 68, 3);
        // Soot washed down from the sill ends.
        for (const sx of [x + 28, x + 94]) { c.fillStyle = vgrad(c, y + 112, y + 128, ink(0.16), ink(0)); c.fillRect(sx, y + 112, 6, 16); }
      }
      set(FRAME); c.fillRect(wx, wy, ww, wh);
      pane(c, set, wx + 4, wy + 4, ww - 8, 34, cell);
      pane(c, set, wx + 4, wy + 42, ww - 8, 34, cell, 0.9);
      if (cell.blind) { set('#e2dbc9', litCol(cell, 0.55)); c.fillRect(wx + 4, wy + 4, ww - 8, Math.min(72, 110 * cell.blind)); }
      else if (cell.kind > 0.5) {
        set('rgba(240,232,214,0.8)', litCol(cell, 0.4));
        c.fillRect(wx + 4, wy + 4, 9, 72); c.fillRect(wx + ww - 13, wy + 4, 9, 72);
      }
      set(FRAME); c.fillRect(wx + ww / 2 - 1.5, wy + 4, 3, wh - 8); c.fillRect(wx + 4, wy + 38, ww - 8, 4);
      if (cell.kind < 0.08 && !glow) {
        // A window air conditioner, because every third-floor walk-up has one.
        c.fillStyle = '#b5b6b0'; c.fillRect(wx + 9, wy + wh - 24, ww - 18, 22);
        c.fillStyle = ink(0.3); for (let k = 0; k < 4; k++) c.fillRect(wx + 12, wy + wh - 20 + k * 5, ww - 24, 2);
      }
    });
  });
}

/** 2: old-town plaster, arched windows, louvred shutters, the odd flower box. */
function stuccoFacade(nz: Noise): [HTMLCanvasElement, HTMLCanvasElement] {
  const cells = cellGrid(104, 0.36, WARM, 0.1, false), SHUT = '#6f918b', TRIMW = '#f8f4ea';
  const cr = new RNG(105), cracks: number[][] = [];
  for (let i = 0; i < 7; i++) cracks.push(crackPath(cr, cr.next() * 1024, cr.next() * 1024, cr.range(1, 2.2), cr.int(6, 12), 14));
  return facadePair((c, glow) => {
    const set = painter(c, glow);
    set('#e9e3d6'); c.fillRect(0, 0, 1024, 1024);
    if (!glow) {
      wash(c, 1024, 1024, nz.blotch, 0.22, 'overlay', 4);
      wash(c, 1024, 1024, nz.cloud, 0.16, 'overlay', 2);
      c.strokeStyle = ink(0.2); c.lineWidth = 1.2;
      for (const p of cracks) wrapped(c, 1024, 1024, () => strokePts(c, p));
    }
    eachCell(cells, (x, y, cell) => {
      const ox = x + 44, oy = y + 26, ow = 40, oh = 74, closed = cell.kind < 0.14;
      set(TRIMW); archPath(c, ox - 5, oy - 5, ow + 10, oh + 10, 8); c.fill();
      if (!glow) {
        // Rain streaks under the sill.
        for (const sx of [ox - 8, ox + ow + 3]) { c.fillStyle = vgrad(c, y + 108, y + 128, 'rgba(90,80,60,0.2)', 'rgba(90,80,60,0)'); c.fillRect(sx, y + 108, 5, 20); }
      }
      const louvres = (lx: number, ly: number, lw: number, lh: number): void => {
        set(SHUT); c.fillRect(lx, ly, lw, lh);
        if (glow) return;
        c.fillStyle = ink(0.22); for (let k = ly + 4; k < ly + lh - 3; k += 6) c.fillRect(lx + 2, k, lw - 4, 2);
        c.fillStyle = grey(255, 0.18); c.fillRect(lx, ly, 1.5, lh);
      };
      if (closed) {
        c.save(); archPath(c, ox, oy, ow, oh, 7); c.clip();
        louvres(ox, oy - 8, ow / 2 - 1, oh + 8); louvres(ox + ow / 2 + 1, oy - 8, ow / 2 - 1, oh + 8);
        c.restore();
      } else {
        c.save(); archPath(c, ox, oy, ow, oh, 7); c.clip();
        pane(c, set, ox, oy - 8, ow, oh + 8, cell);
        if (cell.kind > 0.6) { set('rgba(244,238,224,0.5)', litCol(cell, 0.7)); c.fillRect(ox, oy + oh * 0.45, ow, oh); }
        set(TRIMW); c.fillRect(ox + ow / 2 - 1.5, oy - 8, 3, oh + 8); c.fillRect(ox, oy + oh * 0.36, ow, 3);
        c.restore();
        louvres(ox - 25, oy + 5, 19, oh - 5); louvres(ox + ow + 6, oy + 5, 19, oh - 5);
      }
      set('#d8d1c2'); c.fillRect(ox - 9, oy + oh + 5, ow + 18, 5);
      if (cell.kind > 0.3 && cell.kind < 0.48) {
        set(TERRA); c.fillRect(ox - 5, oy + oh - 3, ow + 10, 9);
        if (!glow) for (let k = 0; k < 9; k++) {
          c.fillStyle = k % 3 ? SAGE : VERM;
          disc(c, ox - 2 + k * 5.5, oy + oh - 5 - hashShade(x + y + k) * 4, 3.6);
        }
      }
    });
  });
}

/** 3: corrugated sheet with a strip of small factory panes high in each bay. */
function metalFacade(nz: Noise): [HTMLCanvasElement, HTMLCanvasElement] {
  const cells = cellGrid(106, 0.3, TUBE, 0, false), rib = ribTile(16, 172, 228);
  return facadePair((c, glow) => {
    const set = painter(c, glow);
    if (glow) { c.fillStyle = '#000'; c.fillRect(0, 0, 1024, 1024); }
    else {
      ribs(c, 0, 0, 1024, 1024, rib);
      for (let y = 0; y < 1024; y += 64) {
        c.fillStyle = ink(0.28); c.fillRect(0, y + 62, 1024, 2); c.fillStyle = grey(255, 0.22); c.fillRect(0, y, 1024, 2);
      }
    }
    eachCell(cells, (x, y, cell, i, j) => {
      if (cell.kind < 0.2) {
        if (cell.kind < 0.09 && !glow) {
          c.fillStyle = '#7d8386'; c.fillRect(x + 44, y + 22, 40, 30);
          c.fillStyle = ink(0.45); for (let k = 0; k < 5; k++) c.fillRect(x + 47, y + 26 + k * 5, 34, 2);
        }
        return;
      }
      const wx = x + 12, wy = y + 16, pw = 22.25, ph = 17.5;
      set('#565c5f'); c.fillRect(wx, wy, 104, 44);
      for (let b = 0; b < 2; b++) for (let a = 0; a < 4; a++) {
        const hh = hashShade(i * 53 + j * 17 + a * 7 + b * 3), px = wx + 3 + a * (pw + 3), py = wy + 3 + b * (ph + 3);
        if (hh < 0.12) set('#b8bbb6');                      // painted over
        else if (hh < 0.19) set('#0f1417');                 // broken
        else set(vgrad(c, py, py + ph, '#5f7c82', '#3f575e'), litCol(cell, 0.7 + 0.3 * hh));
        c.fillRect(px, py, pw, ph);
      }
      if (!glow) for (const sx of [wx + 2, wx + 96]) {
        c.fillStyle = vgrad(c, wy + 44, wy + 100, 'rgba(150,84,48,0.34)', 'rgba(150,84,48,0)'); c.fillRect(sx, wy + 44, 6, 56);
      }
    });
    if (!glow) wash(c, 1024, 1024, nz.cloud, 0.2, 'overlay', 4);
  });
}

// ── The ground-floor kit ─────────────────────────────────────────────────────

/** Real-world size of each kit piece in meters, [width, height]. Pieces are drawn at 64 design px per meter. */
export const KIT_M: Record<string, [number, number]> = {
  shop0: [4, 3.6], shop1: [4, 3.6], shop2: [4, 3.6], shop3: [4, 3.6],
  rowhouse0: [4, 3.4], rowhouse1: [4, 3.4], dock: [6, 3.6],
  garage: [3.6, 3.2], roller: [3, 3.2], door: [1.2, 2.4], doorSteel: [1.2, 2.4],
  window: [1.5, 1.5], windowDark: [1.5, 1.5], awningStripe: [4, 1], awningSolid: [4, 1],
};

const WALL = '#e5e0d4', TRIM = '#f4efe3', LEAF = '#aaa395';
const lamp = (k: number): string => lum('#ffdfa8', k);

function shopWindow(c: Ctx, set: Paint, glow: boolean, x: number, y: number, w: number, h: number, lit: number, r: RNG): void {
  set('#3a4043'); c.fillRect(x - 3, y - 3, w + 6, h + 6);
  set(vgrad(c, y, y + h, GLASS_HI, GLASS_LO), vgrad(c, y, y + h, lamp(lit), lamp(lit * 0.78))); c.fillRect(x, y, w, h);
  // Goods on two shelves: pale ghosts by day, silhouettes against the lit shop by night.
  for (const sy of [0.5, 0.86]) {
    const by = y + h * sy;
    set('rgba(190,200,190,0.22)', lum('#4a3016', lit)); c.fillRect(x + 4, by, w - 8, 2.5);
    for (let gx = x + 8; gx < x + w - 16;) {
      const gw = r.range(6, 15), gh = r.range(8, h * 0.26);
      set(`rgba(200,206,190,${r.range(0.1, 0.24)})`, lum('#6e4a22', lit * r.range(0.4, 1)));
      if (r.chance(0.3)) disc(c, gx + gw / 2, by - gw / 2, gw / 2); else c.fillRect(gx, by - gh, gw, gh);
      gx += gw + r.range(3, 9);
    }
  }
  if (!glow) { c.fillStyle = grey(255, 0.07); poly(c, [x + w * 0.12, y + h, x + w * 0.42, y, x + w * 0.62, y, x + w * 0.32, y + h]); c.fill(); }
}

function shopDoor(c: Ctx, set: Paint, x: number, y: number, w: number, h: number, lit: number, card = ''): void {
  set(TRIM); c.fillRect(x - 4, y - 4, w + 8, h + 4);
  set(LEAF); c.fillRect(x, y, w, h);
  set(vgrad(c, y, y + h, GLASS_HI, GLASS_LO), lamp(lit * 0.85)); c.fillRect(x + 7, y + 8, w - 14, h * 0.6);
  set('#8f887a'); c.fillRect(x + 7, y + h * 0.68, w - 14, h * 0.24);
  set('#2b2f33'); c.fillRect(x + w - 13, y + h * 0.5, 4, 16);
  set('#57534c'); c.fillRect(x - 4, y + h - 4, w + 8, 4);
  if (card) {
    set(BONE, lum(BONE, lit * 0.5)); c.fillRect(x + w / 2 - 15, y + h * 0.28, 30, 13);
    set(VERM, '#000'); setFont(c, 900, 11); label(c, card, x + w / 2, y + h * 0.28 + 10.5, 11);
  }
}

/** Shopfront: fascia band for a sign across the top, pilasters at the edges so tiles butt cleanly. */
function shopDraw(v: number): Draw {
  return (c, w, h, glow) => {
    const set = painter(c, glow), r = new RNG(200 + v), lit = v === 3 ? 0.3 : 0.9;
    set(WALL); c.fillRect(0, 0, w, h);
    set(TRIM); c.fillRect(0, 0, w, 36); c.fillRect(0, 36, 10, h); c.fillRect(w - 10, 36, 10, h);
    if (!glow) {
      c.fillStyle = ink(0.22); c.fillRect(0, 36, w, 2.5); c.fillRect(0, 0, w, 2);
      c.fillStyle = ink(0.1); c.fillRect(10, 38, 1.5, h); c.fillRect(w - 11.5, 38, 1.5, h);
    }
    const win = (x0: number, x1: number): void => {
      shopWindow(c, set, glow, x0, 50, x1 - x0, 134, lit, r);
      // Stall riser under the glass.
      set('#d3cdbf'); c.fillRect(x0 - 3, 190, x1 - x0 + 6, 40);
      if (!glow) { c.strokeStyle = ink(0.2); c.lineWidth = 1.5; c.strokeRect(x0 + 4, 197, x1 - x0 - 8, 26); }
    };
    if (v === 0) { win(20, 166); shopDoor(c, set, 182, 50, 54, 180, lit, 'OPEN'); }
    else if (v === 1) { win(20, 90); shopDoor(c, set, 102, 50, 52, 180, lit); win(166, 236); }
    else if (v === 2) {
      shopDoor(c, set, 22, 50, 54, 180, lit); win(92, 236);
      // Transom lights: a row of small panes across the top of the big window.
      set('#3a4043'); for (let x = 92 + 36; x < 236; x += 36) c.fillRect(x - 1.5, 50, 3, 30);
      c.fillRect(92, 80, 144, 3);
    } else { win(20, 100); shopDoor(c, set, 114, 50, 44, 180, lit, 'SHUT'); shopDoor(c, set, 158, 50, 44, 180, lit); win(216, 236); }
  };
}

function doorDraw(steel: boolean): Draw {
  return (c, w, h, glow) => {
    const set = painter(c, glow);
    set(WALL); c.fillRect(0, 0, w, h);
    if (steel) {
      set('#7c8285'); c.fillRect(6, 6, w - 12, h - 6);
      set('#9da3a5'); c.fillRect(10, 10, w - 20, h - 10);
      set('#b4b9ba'); c.fillRect(10, h - 30, w - 20, 26);
      set('#27323a'); c.fillRect(w / 2 - 9, 26, 18, 30);
      set('#2b2f33'); c.fillRect(w - 24, h * 0.52, 8, 5);
      return;
    }
    set(TRIM); c.fillRect(5, 5, w - 10, h - 5);
    set(vgrad(c, 10, 34, GLASS_HI, GLASS_LO), lamp(0.55)); c.fillRect(10, 10, w - 20, 22);
    set(LEAF); c.fillRect(10, 36, w - 20, h - 36);
    if (!glow) {
      c.strokeStyle = ink(0.25); c.lineWidth = 1.5;
      c.strokeRect(17, 44, w - 34, 44); c.strokeRect(17, 96, w - 34, 46);
    }
    set('#2b2f33'); disc(c, w - 19, 94, 3);
    set('#57534c'); c.fillRect(5, h - 4, w - 10, 4);
  };
}

const rollerDraw: Draw = (c, w, h, glow) => {
  const set = painter(c, glow);
  set(WALL); c.fillRect(0, 0, w, h);
  set('#7c8285'); c.fillRect(6, 8, w - 12, h - 8);
  set('#8b9194'); c.fillRect(10, 8, w - 20, 16);
  for (let y = 24; y < h - 12; y += 9) {
    set(vgrad(c, y, y + 9, '#cfd2d2', '#a9adae')); c.fillRect(14, y, w - 28, 9);
    set('#868b8d'); c.fillRect(14, y + 8, w - 28, 1.2);
  }
  // Hazard stripe on the bottom bar.
  c.save(); c.beginPath(); c.rect(14, h - 14, w - 28, 12); c.clip();
  set(MUST); c.fillRect(14, h - 14, w - 28, 12);
  set(INK); for (let x = 0; x < w + 20; x += 20) { poly(c, [x, h - 2, x + 12, h - 14, x + 22, h - 14, x + 10, h - 2]); c.fill(); }
  c.restore();
  set('#3a3f43'); c.fillRect(w / 2 - 5, h - 26, 10, 10);
};

const garageDraw: Draw = (c, w, h, glow) => {
  const set = painter(c, glow);
  set(WALL); c.fillRect(0, 0, w, h);
  set(TRIM); c.fillRect(8, 10, w - 16, h - 10);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const pw = (w - 28) / 4, ph = (h - 22) / 4, x = 14 + i * pw, y = 16 + j * ph;
    set('#d6d1c6'); c.fillRect(x + 1, y + 1, pw - 2, ph - 2);
    if (j === 0) { set(vgrad(c, y, y + ph, GLASS_HI, GLASS_LO), lamp(0.3)); c.fillRect(x + 7, y + 8, pw - 14, ph - 16); }
    else if (!glow) { c.strokeStyle = ink(0.16); c.lineWidth = 1.5; c.strokeRect(x + 7, y + 8, pw - 14, ph - 16); }
  }
  set('#2b2f33'); c.fillRect(w / 2 - 8, h - 30, 16, 4);
};

function rowhouseDraw(v: number): Draw {
  return (c, w, h, glow) => {
    const set = painter(c, glow);
    if (v) { c.translate(w, 0); c.scale(-1, 1); }
    set(WALL); c.fillRect(0, 0, w, h);
    if (!glow) { c.fillStyle = ink(0.09); for (let y = 9; y < h; y += 10) c.fillRect(0, y, w, 1.4); }
    // Stoop.
    set('#bdb7aa'); c.fillRect(14, h - 30, 96, 30); set('#cfc9bc'); c.fillRect(20, h - 30, 84, 9); c.fillRect(14, h - 16, 96, 3);
    // Door with a transom and a porch lamp.
    set(TRIM); c.fillRect(30, 28, 64, h - 58);
    set(vgrad(c, 34, 52, GLASS_HI, GLASS_LO), lamp(0.6)); c.fillRect(35, 33, 54, 18);
    set(LEAF); c.fillRect(35, 55, 54, h - 85);
    if (!glow) { c.strokeStyle = ink(0.25); c.lineWidth = 1.5; c.strokeRect(42, 63, 40, 44); c.strokeRect(42, 115, 40, 60); }
    set('#2b2f33'); disc(c, 82, 122, 3);
    set('#3a3f43', '#000'); c.fillRect(104, 52, 9, 4);
    set('#ddd4bd', '#fff0cc'); disc(c, 108, 63, 6.5);
    // Sash window.
    const wx = 138, wy = 56, ww = 88, wh = 100, room: Cell = { lit: v ? 0.55 : 0.85, tint: v ? TV : WARM[0], blind: 0, kind: 0 };
    set(TRIM); c.fillRect(wx - 6, wy - 6, ww + 12, wh + 12);
    pane(c, set, wx, wy, ww, wh, room);
    set('rgba(240,232,214,0.8)', litCol(room, 0.45)); c.fillRect(wx, wy, 14, wh); c.fillRect(wx + ww - 14, wy, 14, wh);
    set(TRIM); c.fillRect(wx + ww / 2 - 2, wy, 4, wh); c.fillRect(wx, wy + wh / 2 - 2, ww, 4);
    set('#d3cdbf'); c.fillRect(wx - 10, wy + wh + 6, ww + 20, 6);
    if (v) {
      set(TERRA); c.fillRect(wx - 4, wy + wh - 4, ww + 8, 11);
      if (!glow) for (let k = 0; k < 14; k++) { c.fillStyle = k % 3 ? SAGE : MUST; disc(c, wx + k * 6.6, wy + wh - 6 - hashShade(k) * 4, 4); }
    }
  };
}

const dockDraw: Draw = (c, w, h, glow) => {
  const set = painter(c, glow);
  if (glow) { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); } else ribs(c, 0, 0, w, h, ribTile(12, 176, 228));
  for (const [x, n] of [[24, '3'], [210, '4']] as [number, string][]) {
    set('#6f7578'); c.fillRect(x - 5, 16, 160, 140);
    for (let y = 22; y < 154; y += 9) { set(vgrad(c, y, y + 9, '#c9cccc', '#a3a7a8')); c.fillRect(x, y, 150, 9); }
    set('rgba(30,34,44,0.7)'); setFont(c, 900, 54); label(c, n, x + 75, 108, 54);
  }
  set('#b7b2a6'); c.fillRect(0, 154, w, 76);
  c.save(); c.beginPath(); c.rect(0, 154, w, 10); c.clip();
  set(MUST); c.fillRect(0, 154, w, 10);
  set(INK); for (let x = -10; x < w + 20; x += 20) { poly(c, [x, 164, x + 10, 154, x + 20, 154, x + 10, 164]); c.fill(); }
  c.restore();
  set('#2a2c2f'); for (const x of [10, 184, 362]) c.fillRect(x, 172, 14, 46);
  if (!glow) { c.fillStyle = ink(0.2); c.fillRect(0, 226, w, 4); }
  set('#3a3f43'); c.fillRect(186, 20, 12, 5);
  set('#e3e6d2', '#f4f6e4'); disc(c, 192, 32, 7);
};

function houseWindowDraw(lit: number): Draw {
  return (c, w, h, glow) => {
    const set = painter(c, glow), room: Cell = { lit, tint: WARM[1], blind: 0, kind: 0 };
    set(WALL); c.fillRect(0, 0, w, h);
    set(TRIM); c.fillRect(12, 10, w - 24, h - 26);
    pane(c, set, 18, 16, w - 36, h - 38, room);
    set('rgba(240,232,214,0.8)', litCol(room, 0.45)); c.fillRect(18, 16, 11, h - 38); c.fillRect(w - 29, 16, 11, h - 38);
    set(TRIM); c.fillRect(w / 2 - 2, 16, 4, h - 38); c.fillRect(18, h / 2 - 5, w - 36, 4);
    set('#d3cdbf'); c.fillRect(6, h - 16, w - 12, 6);
  };
}

/** Awning cloth, pale so the vertex colour dyes it: two tones of whatever colour the shop picks. */
function awningDraw(striped: boolean): Draw {
  return (c, w, h, glow) => {
    if (glow) return;
    c.fillStyle = '#fbf9f3'; c.fillRect(0, 0, w, h);
    if (striped) { c.fillStyle = '#b9b6ae'; for (let x = 16; x < w; x += 32) c.fillRect(x, 0, 16, h); }
    else { c.fillStyle = ink(0.1); for (let x = 0; x < w; x += 64) c.fillRect(x, 0, 1.5, h); }
    // The valance hangs below a seam; scallops are drawn, not cut.
    c.fillStyle = ink(0.22); c.fillRect(0, h - 15, w, 2);
    c.fillStyle = ink(0.12); for (let x = 0; x < w; x += 16) { c.beginPath(); c.arc(x + 8, h + 3, 9, Math.PI, TAU_); c.fill(); }
    c.fillStyle = vgrad(c, 0, 10, ink(0.18), ink(0)); c.fillRect(0, 0, w, 10);
  };
}

function kitAtlas(): { cv: HTMLCanvasElement; glow: HTMLCanvasElement; rects: Map<string, AtlasRect>; names: string[] } {
  const a = new AtlasBuilder(2048, 1.5, 6);
  const add = (name: string, draw: Draw, lit = true): void => { const [w, h] = KIT_M[name]; a.add(name, w * 64, h * 64, draw, lit); };
  for (let v = 0; v < 4; v++) add('shop' + v, shopDraw(v));
  add('rowhouse0', rowhouseDraw(0)); add('rowhouse1', rowhouseDraw(1));
  add('dock', dockDraw); add('garage', garageDraw); add('roller', rollerDraw, false);
  add('door', doorDraw(false)); add('doorSteel', doorDraw(true), false);
  add('window', houseWindowDraw(0.85)); add('windowDark', houseWindowDraw(0), false);
  add('awningStripe', awningDraw(true), false); add('awningSolid', awningDraw(false), false);
  const b = a.build(true);
  return { cv: b.cv, glow: b.glow as HTMLCanvasElement, rects: b.rects, names: b.names };
}

// ── Signs ────────────────────────────────────────────────────────────────────

type Picto = 'anchor' | 'fish' | 'gull' | 'squid' | 'wave' | '';

/** A pictogram in a 100-unit box centered on (x, y). `bg` cuts the eyes out. */
function picto(c: Ctx, kind: Picto, x: number, y: number, size: number, fg: string, bg: string): void {
  if (!kind) return;
  c.save(); c.translate(x, y); c.scale(size / 100, size / 100);
  c.lineCap = 'round'; c.lineJoin = 'round'; c.fillStyle = fg; c.strokeStyle = fg;
  if (kind === 'anchor') {
    c.lineWidth = 9;
    c.beginPath(); c.arc(0, -36, 9, 0, TAU_); c.stroke();
    c.beginPath(); c.moveTo(0, -27); c.lineTo(0, 40); c.moveTo(-20, -12); c.lineTo(20, -12); c.stroke();
    c.beginPath(); c.arc(0, 8, 31, 0.08 * Math.PI, 0.92 * Math.PI); c.stroke();
    poly(c, [-43, 14, -21, 12, -33, -9]); c.fill(); poly(c, [43, 14, 21, 12, 33, -9]); c.fill();
  } else if (kind === 'fish') {
    c.beginPath(); c.ellipse(-8, 0, 34, 19, 0, 0, TAU_); c.fill();
    poly(c, [18, 0, 46, -20, 40, 0, 46, 20]); c.fill();
    poly(c, [-14, -17, 2, -30, 10, -14]); c.fill();
    c.fillStyle = bg; disc(c, -26, -4, 4);
  } else if (kind === 'gull') {
    c.lineWidth = 10;
    c.beginPath(); c.moveTo(-46, 2); c.quadraticCurveTo(-26, -30, -2, 2); c.quadraticCurveTo(24, -30, 46, 2); c.stroke();
    c.beginPath(); c.ellipse(-2, 8, 9, 6, 0, 0, TAU_); c.fill();
  } else if (kind === 'squid') {
    poly(c, [0, -48, 17, -22, 15, 6, -15, 6, -17, -22]); c.fill();
    poly(c, [-13, -34, -33, -20, -15, -12]); c.fill(); poly(c, [13, -34, 33, -20, 15, -12]); c.fill();
    c.lineWidth = 5;
    for (let k = -2; k <= 2; k++) { c.beginPath(); c.moveTo(k * 6, 6); c.quadraticCurveTo(k * 6 + (k & 1 ? 9 : -9), 26, k * 11, 46); c.stroke(); }
    c.fillStyle = bg; disc(c, -7, -6, 3.6); disc(c, 7, -6, 3.6);
  } else {
    c.lineWidth = 8;
    for (let k = -1; k <= 1; k++) {
      c.beginPath(); c.moveTo(-44, k * 22 + 4);
      for (let i = 0; i < 4; i++) c.quadraticCurveTo(-33 + i * 22, k * 22 + (i & 1 ? 14 : -10), -22 + i * 22, k * 22 + 4);
      c.stroke();
    }
  }
  c.restore();
}

/** The key a sign is stored under: 'Gull & Void Insurance' -> 'gull-and-void-insurance'. */
export function signKey(title: string): string {
  return title.toLowerCase().replace(/&/g, 'and').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// [name, small print, pictogram]. The first four are PLAN.md's easter eggs.
const SHOPS: [string, string, Picto][] = [
  ['Squid Pro Quo Legal', 'Something for something · Est. 1974', 'squid'],
  ['Pier Pressure Tattoo', 'Everyone else is getting one', 'anchor'],
  ['Gull & Void Insurance', 'Coverage subject to gulls', 'gull'],
  ['Prawn Shop', 'We buy · We sell · We do not ask', 'fish'],
  ['Cod Almighty', 'Fish & chips of some conviction', 'fish'],
  ['Sole Proprietor', 'Shoe repair · One cobbler, no partners', ''],
  ['Knot My Problem', 'Rope, twine & chandlery', 'anchor'],
  ['Buoy Howdy', 'Marine supply & general enthusiasm', ''],
  ['Shore Thing Realty', 'Probably above the tide line', 'wave'],
  ['Anchor Management', 'Counseling for the easily adrift', 'anchor'],
  ['Tide & True Laundry', 'In by ebb · Out by flood', 'wave'],
  ['Kelp Wanted', 'Staffing agency · Apply within', ''],
  ['Seas the Day Travel', 'One-way tickets a specialty', 'gull'],
  ['Clam Down Spa', 'Please lower your voice', ''],
  ['Mussel Beach Gym', 'No pearls without effort', ''],
  ['Fish & Quips', 'Comedy nightly · Two-herring minimum', 'fish'],
  ['Net Losses', 'Certified public accountants', ''],
  ['Hull & Oats', 'Breakfast served until it runs out', ''],
  ['Dock Holiday Motel', 'Vacancy · Always', 'anchor'],
  ['Bait & Switch', 'Electronics · All sales final', ''],
  ['Eel Be Back', 'Auto repair · Same-week service', ''],
  ['Either Oar', 'Canoe rental · Decide at the dock', ''],
  ['Tern for the Worse', 'Public house · Est. regrettably', 'gull'],
  ['Carp Diem', 'Fishmonger · Today’s catch, today', 'fish'],
  ['Crab & Go', 'Lunch counter · Sideways service', ''],
  ['Shell Shock Fireworks', 'Stand well back · No refunds', ''],
  ['Claws & Effect', 'Physics tutoring · Results follow', ''],
  ['Brine & Dandy', 'Pickles · Fine, thank you', ''],
  ['Abandon Shop', 'Liquidators · Everything must go', 'wave'],
  ['Barnacle Bills', 'Debt collection · We attach ourselves', ''],
  ['Star Board Games', 'Hobbies · Always on the right', ''],
  ['Any Port Wine & Spirits', 'Open in a storm', 'anchor'],
  ['Wharf & Peace', 'Used books · Mostly long ones', ''],
  ['Floss & Jetsam', 'Family dentistry', ''],
  ['Perch & Sons Ladders', 'A step up since 1931', ''],
  ['Current Affairs', 'Electrician · Shockingly punctual', ''],
  ['Flounder’s Keepers', 'Lost property · No returns', 'fish'],
  ['The Sea Level Lounge', 'Downstairs', 'wave'],
  ['High Tide Dry Cleaners', 'Closed at low tide', ''],
  ['Salt of the Hearth', 'Bakery · Bread with opinions', ''],
];

// [background, lettering, accent]
const SCHEMES: [string, string, string][] = [
  [INK, BONE, MUST], [BONE, INK, VERM], [VERM, BONE, INK], [TEAL, BONE, MUST],
  [MUST, INK, VERM], [SAGE, INK, BONE], [BRICK, BONE, MUST], ['#e9dcc0', '#7a2e22', TEAL],
];

const PLACES: [string, string, Picto][] = [
  ['PELICAN PIER', 'EST. 1911 · NO REFUNDS ON THE WHEEL', 'gull'],
  ['FLOUNDER FIELD', 'HOME OF THE FLOUNDERS · EVENTUALLY', 'fish'],
  ['MERCY PARK', 'PLEASE KEEP OFF THE DUCKS', 'wave'],
  ['DOCK SEVEN', 'AUTHORIZED FREIGHT ONLY · DOCKS 1–6 NEVER BUILT', 'anchor'],
  ['LAST LIGHT', 'BREAKWATER & LIGHTHOUSE · MIND THE EDGE', 'wave'],
];

const NOTICES: [string, string, string, string][] = [
  ['notice-seized', '114-B', 'THIS PROPERTY IS SEIZED', 'Pending review. The review is pending. Enquiries may be filed and will be.'],
  ['notice-gulls', '9-G', 'DO NOT FEED THE GULLS', 'They remember. The Authority accepts no liability for pocket change, sandwiches or dignity.'],
  ['notice-fishing', '31-F', 'NO FISHING', 'All fish are the property of the Harbor Authority until proven otherwise.'],
  ['notice-parking', '56-P', 'NO PARKING', 'Tuesdays, Thursdays, and at any other time when it would be convenient.'],
  ['notice-duck', '404-D', 'THE DUCK IS NOT A VESSEL', 'Do not board, moor to, race, or attempt to negotiate with the duck.'],
];

function wrapText(c: Ctx, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (line && c.measureText(next).width > maxW) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

function signAtlas(nz: Noise): { cv: HTMLCanvasElement; rects: Map<string, AtlasRect>; names: string[]; shops: string[]; billboards: string[]; notices: string[]; hanging: string[]; places: string[] } {
  const a = new AtlasBuilder(2048, 1, 4);
  // Paint is never quite flat: a little grain and a sun-faded top edge on every board.
  const age = (c: Ctx, w: number, h: number): void => {
    wash(c, w, h, nz.fine, 0.14, 'overlay');
    c.fillStyle = vgrad(c, 0, h, grey(255, 0.07), ink(0.08)); c.fillRect(0, 0, w, h);
  };
  const frame = (c: Ctx, w: number, h: number, col: string, inset = 6, lw = 3): void => {
    c.strokeStyle = col; c.lineWidth = lw; c.strokeRect(inset + lw / 2, inset + lw / 2, w - inset * 2 - lw, h - inset * 2 - lw);
  };

  // Shop fascias, 448 x 112.
  const shops: string[] = [];
  SHOPS.forEach(([title, sub, pic], i) => {
    const key = signKey(title); shops.push(key);
    const [bg, fg, ac] = SCHEMES[(i * 3) % 8], layout = i % 3;
    a.add(key, 448, 112, (c, w, h) => {
      c.fillStyle = bg; c.fillRect(0, 0, w, h);
      const x0 = pic ? 102 : 22, x1 = w - 22, mid = (x0 + x1) / 2, T = title.toUpperCase();
      if (pic) {
        c.fillStyle = ac; disc(c, 56, layout === 1 ? 44 : 56, layout === 1 ? 34 : 38);
        picto(c, pic, 56, layout === 1 ? 44 : 56, layout === 1 ? 50 : 56, bg, ac);
      }
      if (layout === 1) { c.fillStyle = ac; c.fillRect(0, 84, w, 28); } else frame(c, w, h, layout ? ac : fg, 5, layout ? 2 : 3);
      c.fillStyle = fg;
      const px = fit(c, T, 900, 62, x1 - x0, HEAD, 0.02);
      label(c, T, mid, (layout === 1 ? 46 : layout === 2 ? 45 : 52) + px * 0.36, px, 0, 0.02);
      if (layout === 2) { c.fillStyle = ac; c.fillRect(x0, 78, x1 - x0, 2); }
      c.fillStyle = layout === 1 ? bg : layout === 2 ? fg : ac;
      const S = sub.toUpperCase(), sx0 = layout === 1 ? 22 : x0, sp = fit(c, S, 600, 17, x1 - sx0, TEXT, 0.06);
      label(c, S, (sx0 + x1) / 2, layout === 1 ? 104 : layout === 2 ? 99 : 97, sp, 0, 0.06);
      age(c, w, h);
    });
  });

  // Story places, same 4:1 board so they drop into any shop slot.
  a.add('barnacle-finch', 448, 112, (c, w, h) => {
    c.fillStyle = SAGE; c.fillRect(0, 0, w, h); frame(c, w, h, INK);
    c.fillStyle = INK; disc(c, 58, 56, 38); picto(c, 'fish', 58, 56, 56, BONE, INK);
    c.fillStyle = INK; let px = fit(c, 'BARNACLE FINCH', 900, 50, 320); label(c, 'BARNACLE FINCH', 266, 50, px);
    c.fillStyle = BONE; px = fit(c, 'BAIT & TACKLE', 700, 30, 320, HEAD, 0.14); label(c, 'BAIT & TACKLE', 266, 79, px, 0, 0.14);
    c.fillStyle = INK; px = fit(c, 'LIVE WORMS · DEAD CERTAIN DISCRETION', 600, 14, 320, TEXT, 0.06); label(c, 'LIVE WORMS · DEAD CERTAIN DISCRETION', 266, 99, px, 0, 0.06);
    age(c, w, h);
  });
  a.add('gus-arcade', 448, 112, (c, w, h) => {
    c.fillStyle = MUST; c.fillRect(0, 0, w, h); frame(c, w, h, INK);
    c.fillStyle = INK; const px = fit(c, 'GUS’S ARCADE', 900, 70, 268); label(c, 'GUS’S ARCADE', 154, 62, px);
    c.fillStyle = VERM; setFont(c, 600, 14, TEXT); label(c, 'TOKENS · PRIZES · NO QUESTIONS', 154, 92, 14, 0, 0.08);
    // The accounting practice is an afterthought screwed on at an angle.
    c.save(); c.translate(366, 56); c.rotate(-0.045);
    c.fillStyle = ink(0.25); c.fillRect(-66, -30, 138, 68);
    c.fillStyle = BONE; c.fillRect(-70, -34, 138, 68);
    c.fillStyle = INK; setFont(c, 900, 27); label(c, 'ACCOUNTING', -1, -5, 27, 0, 0.02);
    setFont(c, 700, 21); label(c, 'IN REAR', -16, 22, 21, 0, 0.1);
    c.fillStyle = VERM; poly(c, [30, 9, 46, 9, 46, 3, 60, 14, 46, 25, 46, 19, 30, 19]); c.fill();
    c.fillStyle = grey(90); for (const sx of [-63, 61]) for (const sy of [-27, 27]) disc(c, sx, sy, 2.2);
    c.restore();
    age(c, w, h);
  });
  a.add('vance-office', 448, 112, (c, w, h) => {
    c.fillStyle = BONE; c.fillRect(0, 0, w, h); frame(c, w, h, INK, 5, 2); frame(c, w, h, INK, 10, 1);
    c.fillStyle = VERM; setFont(c, 700, 17); label(c, 'OFFICE OF', w / 2, 33, 17, 0, 0.32);
    c.fillStyle = INK; const px = fit(c, 'COUNCILWOMAN PRIYA VANCE', 900, 46, 400, HEAD, 0.03); label(c, 'COUNCILWOMAN PRIYA VANCE', w / 2, 73, px, 0, 0.03);
    c.fillRect(150, 82, 148, 1.5);
    setFont(c, 600, 13, TEXT); label(c, 'LEDGER DISTRICT · BY APPOINTMENT · APPOINTMENTS UNAVAILABLE', w / 2, 99, 13, 0, 0.05);
    age(c, w, h);
  });
  a.add('marlowe-towing', 448, 112, (c, w, h) => {
    c.fillStyle = '#d9cdb0'; c.fillRect(0, 0, w, h); frame(c, w, h, 'rgba(20,33,61,0.6)');
    c.fillStyle = 'rgba(20,33,61,0.72)'; const px = fit(c, 'MARLOWE TOWING', 900, 58, 400); label(c, 'MARLOWE TOWING', w / 2, 54, px);
    setFont(c, 600, 15, TEXT); label(c, '24 HOURS · WE COME TO YOU · O. MARLOWE, PROP.', w / 2, 94, 15, 0, 0.06);
    wash(c, w, h, nz.wear, 0.3, 'destination-out'); c.globalCompositeOperation = 'destination-over'; c.fillStyle = '#d9cdb0'; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'source-over';
    // The Authority's sticker, slapped across the family name.
    c.save(); c.translate(w / 2 + 62, h / 2 + 25); c.rotate(-0.06);
    c.fillStyle = ink(0.25); c.fillRect(-148, -19, 300, 44);
    c.fillStyle = VERM; c.fillRect(-150, -22, 300, 44);
    c.strokeStyle = BONE; c.lineWidth = 2; c.strokeRect(-146, -18, 292, 36);
    c.fillStyle = BONE; setFont(c, 900, 34); label(c, 'SEIZED', -92, 12, 34, 0, 0.04);
    setFont(c, 700, 14); label(c, 'BY ORDER OF THE', 52, -3, 14, 0, 0.1); label(c, 'HARBOR AUTHORITY', 52, 13, 14, 0, 0.1);
    c.restore();
    age(c, w, h);
  });

  // Place names: enamel plates.
  const places: string[] = [];
  for (const [title, sub, pic] of PLACES) {
    const key = signKey(title); places.push(key);
    a.add(key, 448, 112, (c, w, h) => {
      c.fillStyle = INK; c.fillRect(0, 0, w, h); frame(c, w, h, BONE, 5, 3); frame(c, w, h, MUST, 12, 1);
      picto(c, pic, 44, 52, 38, MUST, INK); picto(c, pic, w - 44, 52, 38, MUST, INK);
      c.fillStyle = BONE; const px = fit(c, title, 900, 60, 286, HEAD, 0.07); label(c, title, w / 2, 48 + px * 0.36, px, 0, 0.07);
      c.fillStyle = MUST; const sp = fit(c, sub, 600, 13, 310, TEXT, 0.1); label(c, sub, w / 2, 95, sp, 0, 0.1);
      age(c, w, h);
    });
  }

  // Billboards, 640 x 320.
  const strap = (c: Ctx, text: string, bg: string, fg: string): void => {
    c.fillStyle = bg; c.fillRect(0, 258, 640, 62);
    c.fillStyle = fg; const px = fit(c, text, 600, 27, 590, TEXT, 0.03); label(c, text, 320, 298, px, 0, 0.03);
  };
  a.add('wdoof', 640, 320, (c, w, h) => {
    c.fillStyle = MUST; c.fillRect(0, 0, w, h);
    // A radio mast, broadcasting in every direction including down.
    c.strokeStyle = INK; c.fillStyle = INK; c.lineWidth = 5; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(62, 244); c.lineTo(92, 70); c.lineTo(122, 244); c.stroke();
    c.lineWidth = 3; c.beginPath();
    for (let k = 0; k < 4; k++) { const y0 = 244 - k * 44, y1 = y0 - 44, s0 = 30 - k * 7.6, s1 = s0 - 7.6; c.moveTo(92 - s0, y0); c.lineTo(92 + s1, y1); c.moveTo(92 + s0, y0); c.lineTo(92 - s1, y1); }
    c.stroke(); disc(c, 92, 62, 9);
    c.strokeStyle = VERM; c.lineWidth = 6; c.lineCap = 'round';
    for (let k = 1; k <= 3; k++) for (const s of [-1, 1]) { c.beginPath(); c.arc(92, 62, 12 + k * 13, s > 0 ? -0.9 : Math.PI - 0.9, s > 0 ? 0.9 : Math.PI + 0.9); c.stroke(); }
    c.fillStyle = INK; const big = fit(c, 'WDOOF', 900, 150, 290), ww = c.measureText('WDOOF').width; label(c, 'WDOOF', 170, 150, big, -1);
    c.fillStyle = VERM; fit(c, '99.9', 900, big, 606 - 186 - ww); label(c, '99.9', 186 + ww, 150, big, -1);
    c.fillStyle = INK; const px = fit(c, 'RADIO FOR DOOFUSES', 900, 62, 440, HEAD, 0.05); label(c, 'RADIO FOR DOOFUSES', 170, 226, px, -1, 0.05);
    strap(c, 'All of the hits. Some of the notes.', INK, BONE);
    frame(c, w, h, INK, 0, 6); age(c, w, h);
  });
  a.add('bb-visit', 640, 320, (c, w, h) => {
    c.fillStyle = BONE; c.fillRect(0, 0, w, h);
    c.fillStyle = MUST; disc(c, 520, 150, 78);
    c.fillStyle = TEAL; c.fillRect(0, 214, w, 106);
    c.strokeStyle = BONE; c.lineWidth = 3; for (let k = 0; k < 2; k++) { c.beginPath(); for (let x = 0; x <= w; x += 16) c.lineTo(x, 226 + k * 12 + ((x / 16) & 1 ? 3 : 0)); c.stroke(); }
    // The lighthouse.
    c.fillStyle = INK; poly(c, [58, 240, 72, 92, 108, 92, 122, 240]); c.fill(); c.fillRect(64, 82, 52, 10); poly(c, [70, 62, 90, 40, 110, 62]); c.fill();
    c.fillStyle = VERM; c.fillRect(68, 130, 44, 22); c.fillRect(64, 184, 52, 22);
    c.fillStyle = MUST; c.fillRect(74, 62, 32, 20);
    c.fillStyle = VERM; setFont(c, 700, 30); label(c, 'VISIT SCENIC', 160, 78, 30, -1, 0.3);
    c.fillStyle = INK; const px = fit(c, 'PORT CALAMITY', 900, 112, 440); label(c, 'PORT CALAMITY', 158, 176, px, -1);
    c.fillStyle = BONE; setFont(c, 600, 28, TEXT); label(c, 'Now with 40% fewer incidents*', 160, 270, 28, -1);
    setFont(c, 600, 15, TEXT); label(c, '*than last quarter. Past incidents do not guarantee future incidents.', 160, 298, 15, -1);
    frame(c, w, h, INK, 0, 6); age(c, w, h);
  });
  a.add('bb-gullbgone', 640, 320, (c, w, h) => {
    c.fillStyle = VERM; c.fillRect(0, 0, w, h);
    c.fillStyle = BONE; disc(c, 112, 132, 88); picto(c, 'gull', 112, 132, 120, INK, BONE);
    c.strokeStyle = INK; c.lineWidth = 12; c.beginPath(); c.arc(112, 132, 80, 0, TAU_); c.moveTo(56, 76); c.lineTo(168, 188); c.stroke();
    c.fillStyle = BONE; const px = fit(c, 'GULL-B-GONE', 900, 120, 400); label(c, 'GULL-B-GONE', 224, 132, px, -1);
    c.fillStyle = INK; setFont(c, 700, 38); label(c, 'SEAGULL REPELLENT', 226, 184, 38, -1, 0.06);
    c.fillStyle = BONE; setFont(c, 600, 26, TEXT); label(c, 'Does not work. Smells terrific.', 226, 224, 26, -1);
    c.fillStyle = MUST; disc(c, 572, 222, 48); c.fillStyle = INK; setFont(c, 500, 26, MONO); label(c, '$4.99', 572, 231, 26);
    strap(c, 'Ask for it by name. The gulls already have.', INK, BONE);
    frame(c, w, h, INK, 0, 6); age(c, w, h);
  });
  a.add('bb-bridge', 640, 320, (c, w, h) => {
    c.fillStyle = INK; c.fillRect(0, 0, w, h);
    // A deck that climbs and then thinks better of it.
    c.strokeStyle = BONE; c.lineWidth = 9; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(0, 236); c.quadraticCurveTo(200, 226, 372, 150); c.stroke();
    c.lineWidth = 5; for (const x of [70, 160, 250, 330]) { c.beginPath(); c.moveTo(x, 240 - (x / 372) ** 2 * 84); c.lineTo(x, 258); c.stroke(); }
    c.strokeStyle = MUST; c.lineWidth = 5; c.setLineDash([12, 12]); c.beginPath(); c.moveTo(384, 144); c.quadraticCurveTo(500, 108, 640, 104); c.stroke(); c.setLineDash([]);
    c.fillStyle = MUST; const px = fit(c, 'THE PERPETUAL BRIDGE', 900, 76, 590, HEAD, 0.03); label(c, 'THE PERPETUAL BRIDGE', 320, 82, px, 0, 0.03);
    c.fillStyle = BONE; setFont(c, 700, 34); label(c, 'OPENING SOON', 610, 190, 34, 1, 0.1); label(c, 'SINCE 1987', 610, 230, 34, 1, 0.1);
    strap(c, 'Your toll dollars at rest. A Harbor Authority project.', TEAL, BONE);
    frame(c, w, h, BONE, 0, 6); age(c, w, h);
  });
  a.add('bb-anchors', 640, 320, (c, w, h) => {
    c.fillStyle = BONE; c.fillRect(0, 0, w, h);
    c.fillStyle = TEAL; disc(c, 116, 132, 92); picto(c, 'anchor', 116, 132, 132, BONE, TEAL);
    c.fillStyle = INK; setFont(c, 700, 34); label(c, 'LARRY’S', 232, 62, 34, -1, 0.2);
    c.fillStyle = VERM; let px = fit(c, 'DISCOUNT ANCHORS', 900, 92, 380); label(c, 'DISCOUNT ANCHORS', 230, 142, px, -1);
    c.fillStyle = INK; px = fit(c, 'THEY HOLD. MOSTLY.', 900, 54, 380, HEAD, 0.08); label(c, 'THEY HOLD. MOSTLY.', 232, 206, px, -1, 0.08);
    strap(c, 'Dock Seven · Cash only · No floating returns', INK, BONE);
    frame(c, w, h, INK, 0, 6); age(c, w, h);
  });

  // Harbor Authority paperwork, 224 x 320.
  const notices: string[] = [];
  for (const [key, no, head, body] of NOTICES) {
    notices.push(key);
    a.add(key, 224, 320, (c, w, h) => {
      c.fillStyle = '#f4ecd6'; c.fillRect(0, 0, w, h);
      c.fillStyle = INK; c.fillRect(0, 0, w, 58);
      c.fillStyle = BONE; setFont(c, 900, 25); label(c, 'HARBOR AUTHORITY', w / 2, 30, 25, 0, 0.05);
      c.fillStyle = MUST; setFont(c, 500, 12, MONO); label(c, 'PUBLIC NOTICE No. ' + no, w / 2, 48, 12);
      c.fillStyle = INK;
      setFont(c, 900, 40);
      const lines = wrapText(c, head, w - 20);
      let y = 104;
      for (const ln of lines) { const px = fit(c, ln, 900, 46, w - 28); label(c, ln, w / 2, y, px); y += 43; }
      c.fillStyle = VERM; c.fillRect(20, y - 26, w - 40, 4);
      c.fillStyle = INK; setFont(c, 600, 16, TEXT);
      y += 2;
      for (const ln of wrapText(c, body, w - 36)) { label(c, ln, 18, y, 16, -1); y += 20; }
      setFont(c, 500, 10, MONO); c.fillStyle = 'rgba(20,33,61,0.7)'; label(c, 'FORM HA-7 · POST IN TRIPLICATE', w / 2, h - 12, 10);
      // The stamp.
      c.save(); c.translate(w - 50, h - 52); c.rotate(-0.26);
      c.strokeStyle = 'rgba(228,87,46,0.85)'; c.fillStyle = 'rgba(228,87,46,0.85)'; c.lineWidth = 2.5; c.strokeRect(-36, -14, 72, 28);
      setFont(c, 900, 19); label(c, 'OFFICIAL', 0, 7, 19, 0, 0.06);
      c.restore();
      frame(c, w, h, INK, 0, 3); age(c, w, h);
    });
  }

  a.add('room-404', 160, 80, (c, w, h) => {
    c.fillStyle = '#c79a34'; c.fillRect(0, 0, w, h);
    c.fillStyle = vgrad(c, 0, h, grey(255, 0.22), ink(0.14)); c.fillRect(0, 0, w, h);
    frame(c, w, h, 'rgba(20,33,61,0.75)', 5, 2);
    c.fillStyle = INK; setFont(c, 700, 16); label(c, 'ROOM', w / 2, 27, 16, 0, 0.4);
    setFont(c, 500, 40, MONO); label(c, '404', w / 2, 63, 40);
    c.fillStyle = 'rgba(20,33,61,0.7)'; for (const x of [13, w - 13]) disc(c, x, h / 2, 2.6);
  });
  a.add('bridge-out', 384, 192, (c, w, h) => {
    c.fillStyle = MUST; c.fillRect(0, 0, w, h); frame(c, w, h, INK, 6, 7);
    c.fillStyle = INK; const px = fit(c, 'BRIDGE OUT', 900, 110, 330, HEAD, 0.02); label(c, 'BRIDGE OUT', w / 2, 106, px, 0, 0.02);
    setFont(c, 700, 40); label(c, '(SINCE 1987)', w / 2, 158, 40, 0, 0.08);
    age(c, w, h);
  });

  // Round hanging signs. Their corners stay transparent: the sign material alpha-tests.
  const hanging: string[] = [];
  ([['anchor', INK, BONE], ['fish', TEAL, BONE], ['gull', BONE, INK], ['squid', VERM, BONE]] as [Picto, string, string][]).forEach(([pic, bg, fg]) => {
    hanging.push('hang-' + pic);
    a.add('hang-' + pic, 128, 128, (c, w) => {
      c.fillStyle = fg; disc(c, w / 2, w / 2, 62); c.fillStyle = bg; disc(c, w / 2, w / 2, 57);
      c.strokeStyle = fg; c.lineWidth = 2; c.beginPath(); c.arc(w / 2, w / 2, 50, 0, TAU_); c.stroke();
      picto(c, pic, w / 2, w / 2 + 2, 74, fg, bg);
    });
  });

  // Street-name blades, 320 x 64.
  for (const name of [...NS_NAMES, ...EW_NAMES]) {
    a.add('street:' + name, 320, 64, (c, w, h) => {
      c.fillStyle = TEAL; c.fillRect(0, 0, w, h); frame(c, w, h, BONE, 4, 2);
      const cut = name.lastIndexOf(' '), main = name.slice(0, cut).toUpperCase(), kind = name.slice(cut + 1).toUpperCase();
      c.fillStyle = BONE; setFont(c, 700, 22); const kw = textW(c, kind, 22, 0.06);
      const px = fit(c, main, 900, 42, w - 44 - kw, HEAD, 0.04), mw = textW(c, main, px, 0.04), x = (w - mw - kw - 10) / 2;
      label(c, main, x, 46, px, -1, 0.04);
      setFont(c, 700, 22); label(c, kind, x + mw + 10, 46, 22, -1, 0.06);
    });
  }

  const b = a.build(false);
  return { cv: b.cv, rects: b.rects, names: b.names, shops, billboards: ['wdoof', 'bb-visit', 'bb-gullbgone', 'bb-bridge', 'bb-anchors'], notices, hanging, places };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

async function loadFonts(): Promise<void> {
  const want = ['900 48px "Big Shoulders Display"', '700 48px "Big Shoulders Display"', '600 24px "Barlow Semi Condensed"', '500 24px "IBM Plex Mono"'];
  // A font that never arrives must not hold the game on the loading card: signs fall back to a system face.
  const giveUp = new Promise<void>((res) => { setTimeout(res, 3000); });
  await Promise.all(want.map((f) => Promise.race([document.fonts.load(f).then(() => undefined, () => undefined), giveUp])));
}

/** Draw every texture in the game. Takes a few hundred milliseconds; call once. */
export async function makeTextures(q: Quality): Promise<Textures> {
  await loadFonts();
  shrinkBy = q.name === 'low' ? 0.5 : 1;
  const nz = makeNoise(), ground = q.name === 'low' ? 4 : 8;

  // Phones keep the flat paint: no normal or roughness sheets are made at all. `?pbr=0` does the
  // same on any preset, which is the honest A/B for what these maps cost.
  const flat = q.name === 'low' || new URLSearchParams(location.search).get('pbr') === '0';
  const pbr = new Map<THREE.Texture, Pbr>();
  const surf = (cv: HTMLCanvasElement, repeat: boolean | 'u', aniso: number, spec: PbrSpec): THREE.Texture => {
    // derive() runs first: it brightens the glass in the colour canvas.
    const twins = flat ? null : derive(cv, spec, repeat);
    const t = done(cv, repeat, aniso);
    if (twins) pbr.set(t, { normal: finish(twins.normal, repeat, aniso, true), orm: finish(twins.orm, repeat, Math.min(aniso, 4), true) });
    return t;
  };

  const FSPEC: PbrSpec[] = [
    { bump: 3, rough: 0.5, roughK: 0.2, glass: true, cap: 0.12 },
    { bump: 6, rough: 0.9, roughK: 0.35, glass: true, cap: 0.14 },
    { bump: 3.5, rough: 0.88, roughK: 0.3, glass: true, cap: 0.12 },
    { bump: 7, rough: 0.52, roughK: 0.5, metal: 0.35, glass: true },
  ];
  const facade = [glassFacade, brickFacade, stuccoFacade, metalFacade].map((f, i) => {
    const [cv, gv] = f(nz);
    return { map: surf(cv, true, 4, FSPEC[i]), glow: done(gv, true, 2) };
  });

  const k = kitAtlas();
  const kit: KitAtlas = { tex: surf(k.cv, false, 4, { bump: 3, rough: 0.72, roughK: 0.25, glass: true, scale: 0.5 }), glow: done(k.glow, false, 2), ...lookup('kit', k.rects, k.names) };

  const s = signAtlas(nz);
  const signs: SignAtlas = {
    tex: done(s.cv, false, 8), ...lookup('sign', s.rects, s.names),
    shops: s.shops, billboards: s.billboards, notices: s.notices, hanging: s.hanging, places: s.places,
    street: (name) => 'street:' + name,
  };

  // Rows are inset a pixel or two so a mipmap never pulls in the transparent gap above and below.
  const markRects = new Map<string, AtlasRect>();
  for (const name in MARK_PX) {
    const [x, y, w, h] = MARK_PX[name], row = w === 1024, i = row ? 2 : 0;
    markRects.set(name, { u0: row ? 0 : x / 1024, u1: row ? 1 : (x + w) / 1024, v0: 1 - (y + h - i) / 1024, v1: 1 - (y + i) / 1024, aspect: w / h });
  }
  const marks: Atlas = { tex: done(marksCanvas(nz), 'u', ground), ...lookup('mark', markRects, Object.keys(MARK_PX)) };

  return {
    facade, kit, signs, marks, pbr,
    street: surf(roadCanvas(nz, 21, 12, 1024, [1.75], [3.5], []), true, ground, { bump: 5, rough: 0.92, cap: 0.08 }),
    avenue: surf(roadCanvas(nz, 22, 20, 2048, [1.8, 5.2], [7], [3.5]), true, ground, { bump: 5, rough: 0.92, cap: 0.08, scale: 0.5 }),
    asphalt: surf(asphaltCanvas(nz), true, ground, { bump: 5, rough: 0.92 }),
    sidewalk: surf(sidewalkCanvas(nz), true, ground, { bump: 4, rough: 0.86, roughK: 0.4 }),
    grass: surf(grassCanvas(nz), true, ground, { bump: 3, rough: 0.95, roughK: 0.1 }),
    sand: surf(sandCanvas(nz), true, ground, { bump: 3.5, rough: 0.96, roughK: 0.1 }),
    wood: surf(woodCanvas(nz), true, ground, { bump: 4, rough: 0.8, roughK: 0.4 }),
    cobble: surf(cobbleCanvas(nz), true, ground, { bump: 5, rough: 0.74, roughK: 0.6 }),
    roofGravel: surf(gravelCanvas(nz), true, 4, { bump: 5, rough: 0.97, roughK: 0.1 }),
    roofTile: surf(roofTileCanvas(nz), true, 4, { bump: 3, rough: 0.78, roughK: 0.3 }),
    shingle: surf(shingleCanvas(nz), true, 4, { bump: 4, rough: 0.92, roughK: 0.2 }),
    corrugated: surf(corrugatedCanvas(nz), true, 4, { bump: 8, rough: 0.5, roughK: 0.5, metal: 0.5 }),
    container: surf(containerCanvas(nz), 'u', 4, { bump: 6, rough: 0.52, roughK: 0.45, metal: 0.2 }),
    ramp: surf(rampCanvas(nz), true, ground, { bump: 2, rough: 0.6, roughK: 0.3 }),
    fence: done(fenceCanvas(), 'u', 4),
    glow: done(glowCanvas(), false, 1),
    noise: done(noiseCanvas(), true, 1, true),
  };
}
