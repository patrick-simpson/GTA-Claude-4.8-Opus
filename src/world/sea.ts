// The swell: long, low waves rolling in from the open sea toward the island. One description, two readers: the sea's
// vertex and fragment shaders (world/ground.ts, through SWELL_GLSL) lift and shade the surface with it, and seaY()
// gives the same height to anything that floats (ent/boat.ts). Both run on the sea's own clock, seaClock.t, which
// ground.ts advances with the shader's uTime.
//
// Three sine trains with deep-water speeds (omega^2 = g k). They die away toward the shore (inside about 50 m of the
// island's coast the water is flat; full height from about 280 m out) and toward the mainland, so the harbour by the
// pier stays calm enough to moor in and the river never heaves. In the shader each train also fades with distance
// from the camera, where the sea's mesh is too coarse to carry it; boats only ask near the camera, where it is whole.

import { WATER_Y, islandSD } from './plan';

/** The sea's clock in seconds: ground.ts copies the shader's uTime here every frame. */
export const seaClock = { t: 0 };

const G = 9.81;
// [direction x, direction z, wavelength m, amplitude m, phase]. Heading north-ish, onto the south shore and the pier.
const TRAINS: readonly (readonly [number, number, number, number, number])[] = [
  [0.25, -0.97, 56, 0.55, 0],
  [-0.45, -0.89, 34, 0.36, 1.7],
  [0.7, -0.71, 21, 0.2, 4.1],
];
interface Train { dx: number; dz: number; k: number; w: number; a: number; ph: number; lam: number }
const W: Train[] = TRAINS.map(([x, z, lam, a, ph]) => {
  const l = Math.hypot(x, z), k = (2 * Math.PI) / lam;
  return { dx: x / l, dz: z / l, k, w: Math.sqrt(G * k), a, ph, lam };
});

const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0 in the harbour and along every shore, 1 on the open sea. */
export function swellFade(x: number, z: number): number {
  if (z < -860) return 0;
  return sstep(50, 280, islandSD(x, z)) * sstep(-860, -640, z);
}

/** Height of the sea surface at (x, z), meters (WATER_Y in a flat calm). */
export function seaY(x: number, z: number, t = seaClock.t): number {
  const f = swellFade(x, z);
  if (f <= 0) return WATER_Y;
  let h = 0;
  for (const s of W) h += s.a * Math.sin(s.k * (s.dx * x + s.dz * z) - s.w * t + s.ph);
  return WATER_Y + h * f;
}

/**
 * Slope of the surface (dh/dx, dh/dz) and its vertical speed, into out. The fade's own slope is left out: it is
 * gentle beside the wave's.
 */
export function seaSlope(x: number, z: number, out: { x: number; z: number; vy: number }, t = seaClock.t): void {
  const f = swellFade(x, z);
  out.x = 0; out.z = 0; out.vy = 0;
  if (f <= 0) return;
  for (const s of W) {
    const ph = s.k * (s.dx * x + s.dz * z) - s.w * t + s.ph, c = Math.cos(ph) * s.a * f;
    out.x += c * s.k * s.dx; out.z += c * s.k * s.dz; out.vy -= c * s.w;
  }
}

const F = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * GLSL: swellFade(p), swellH(p, t, dist) and swellG(p, t, dist), the same sums as above. `dist` is the distance from
 * the camera: each train eases out between 4 and 8 of its wavelengths away, where the mesh can no longer hold it.
 */
export const SWELL_GLSL = /* glsl */ `
float swellIsleSD(vec2 p) {
  p -= vec2(0.0, -5.0);
  vec2 q = abs(p) - vec2(540.0, 365.0);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 140.0;
  float th = atan(p.y, p.x);
  return sd + 13.0 * sin(th * 5.0 + 1.3) + 8.0 * sin(th * 11.0 + 0.4) + 4.0 * sin(th * 23.0);
}
float swellFade(vec2 p) {
  if (p.y < -860.0) return 0.0;
  return smoothstep(50.0, 280.0, swellIsleSD(p)) * smoothstep(-860.0, -640.0, p.y);
}
float swellH(vec2 p, float t, float dist) {
  float f = swellFade(p);
  if (f <= 0.0) return 0.0;
  float h = 0.0;
${W.map((s) => `  h += ${F(s.a)} * (1.0 - smoothstep(${F(s.lam * 4)}, ${F(s.lam * 8)}, dist)) * sin(${s.k.toFixed(6)} * dot(vec2(${s.dx.toFixed(6)}, ${s.dz.toFixed(6)}), p) - ${s.w.toFixed(6)} * t + ${F(s.ph)});`).join('\n')}
  return h * f;
}
vec2 swellG(vec2 p, float t, float dist) {
  float f = swellFade(p);
  if (f <= 0.0) return vec2(0.0);
  vec2 g = vec2(0.0);
  float c;
${W.map((s) => `  c = ${F(s.a)} * ${s.k.toFixed(6)} * (1.0 - smoothstep(${F(s.lam * 4)}, ${F(s.lam * 8)}, dist)) * cos(${s.k.toFixed(6)} * dot(vec2(${s.dx.toFixed(6)}, ${s.dz.toFixed(6)}), p) - ${s.w.toFixed(6)} * t + ${F(s.ph)});\n  g += c * vec2(${s.dx.toFixed(6)}, ${s.dz.toFixed(6)});`).join('\n')}
  return g * f;
}
`;
