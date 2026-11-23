// The picture after the scene is drawn: ambient occlusion, bloom, one tone map
// and a restrained grade. Hand-rolled so the whole thing is a dozen small
// full-screen draws instead of a stack of stock passes, each of which would
// copy the frame once more.
//
//   scene -> half-float colour + depth (multisampled twice)
//   depth -> AO at half size -> two depth-aware blur passes
//   colour -> bright pass at half size -> a short mip chain down, then back up
//   colour, edges smoothed (FXAA) * AO + bloom -> tone map (the operator and exposure the
//          sky chose) -> sRGB -> contrast, vignette, grain -> canvas
//
// Antialiasing. The scene target used to be multisampled four times at high and
// twice at medium, and nothing else smoothed an edge. On the baseline laptop GPU
// (Iris Xe, 1080p) a multisampled half-float target is dear: about 2 ms of the
// frame for two samples and 3 to 4.5 ms for four, measured A/B with
// tools/bench.mjs. The composite now runs FXAA on the scene colour (five taps
// everywhere, more only on an edge), in a folded 0..1 space so a bright sky
// against a dark roof blends the way it will look after the tone map.
//   high    two samples and FXAA. In enlarged crops it is as clean as four
//           samples were, and smoother on leaf cards and fences, which
//           multisampling never touched; 0.6 to 1.6 ms cheaper than four.
//   medium  two samples and no FXAA, exactly as before.
// FXAA alone (`?aa=fxaa`) is the big saving, 2.3 to 4 ms at high and 1.4 to
// 2.3 ms at medium, but anything thinner than a pixel (a far lamp post, a signal
// arm) breaks into dashes, because no filter can put back what the rasteriser
// never drew. So it is a switch, not the default: set a tier's `msaa` to 0 (and
// `fxaa` to true) to take it. `?aa=msaa` brings the old multisampled target
// back (4x or 2x, no FXAA). scratch/m6/aacmp.mjs makes the comparison crops.
//
// Rendering to a target makes three skip tone mapping and the sRGB encode in
// every material, so the scene arrives here linear and unclipped and is mapped
// exactly once, in the composite. Fog is mixed in the materials before that,
// which is why the sky hands the fog its raw colour while this is on.
//
// Nothing here allocates per frame, and the quality tier `low` never builds
// one of these at all.

import * as THREE from 'three';
import type { Game } from './game';

/** `msaa` and `fxaa`: how the tier smooths edges. `msaaAlone`: the samples it had before there was FXAA (`?aa=msaa`). */
interface Tier { ao: number; levels: number; msaa: number; fxaa: boolean; msaaAlone: number }
const TIERS: Record<'medium' | 'high', Tier> = {
  medium: { ao: 6, levels: 3, msaa: 2, fxaa: false, msaaAlone: 2 },
  // Eight AO samples, not ten: in crops under a parked car and in a doorway the two cannot be told apart.
  high: { ao: 8, levels: 5, msaa: 2, fxaa: true, msaaAlone: 4 },
};

/** World radius of the occlusion search, meters: kerbs, door recesses, the gap under a car. */
const AO_RADIUS = 1.4;
/** Past this the search is a pixel or two wide and only makes noise, so it fades out. */
const AO_FADE = 150;
/** Scales how much of the night glow applies: a lit interior (pardonsStore.ts) sets it to 0 while the camera is inside, so the night bloom bar does not wash a bright room out. */
export const nightBloom = { scale: 1 };
const AO_STRENGTH = 0.92;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DEPTH_FN = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uNearFar;
float viewDist(float d) {
  return uNearFar.x * uNearFar.y / (uNearFar.y - (uNearFar.y - uNearFar.x) * d);
}`;

// Occlusion as the mean cosine of what rises above the tangent plane inside
// the radius. The normal comes from depth alone (the nearer neighbour on each
// axis, so it does not bend across an edge), which is why no second geometry
// pass is needed. The spiral is turned per pixel by a fixed screen pattern:
// the blur removes it and, being fixed, it cannot crawl.
const AO_FRAG = /* glsl */ `
${DEPTH_FN}
uniform vec2 uInvP;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uFade;
varying vec2 vUv;
vec3 posAt(vec2 uv) {
  float z = viewDist(texture2D(tDepth, uv).x);
  return vec3((uv * 2.0 - 1.0) * uInvP * z, -z);
}
void main() {
  // A half-size pixel's centre is a corner between four depth texels; step onto one.
  vec2 uv = vUv + 0.5 * uTexel;
  float d = texture2D(tDepth, uv).x;
  float dist = viewDist(d);
  if (d > 0.99995 || dist > uFade) { gl_FragColor = vec4(1.0, min(dist, 60000.0), 0.0, 1.0); return; }
  vec3 P = vec3((uv * 2.0 - 1.0) * uInvP * dist, -dist);
  vec3 Pl = posAt(uv - vec2(uTexel.x, 0.0)), Pr = posAt(uv + vec2(uTexel.x, 0.0));
  vec3 Pd = posAt(uv - vec2(0.0, uTexel.y)), Pu = posAt(uv + vec2(0.0, uTexel.y));
  vec3 dx = abs(Pl.z - P.z) < abs(Pr.z - P.z) ? P - Pl : Pr - P;
  vec3 dy = abs(Pd.z - P.z) < abs(Pu.z - P.z) ? P - Pd : Pu - P;
  vec3 n = normalize(cross(dx, dy));

  float rv = min(uRadius * 0.5 / (dist * uInvP.y), 0.11);
  vec2 ruv = vec2(rv * uInvP.y / uInvP.x, rv);
  float ang = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float R2 = uRadius * uRadius;
  // Depth this far away is only so exact; anything flatter than this is the surface itself.
  float skin = 0.012 + 0.004 * dist;
  float sum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + 0.5) / float(SAMPLES);
    float a = ang + float(i) * 2.3999632;
    vec3 v = posAt(uv + vec2(cos(a), sin(a)) * ruv * (0.12 + 0.88 * t)) - P;
    float vv = dot(v, v), vn = dot(v, n);
    float fall = max(1.0 - vv / R2, 0.0);
    sum += step(skin, vn) * max(vn * inversesqrt(vv + 1e-5) - 0.06, 0.0) * fall;
  }
  float ao = clamp(1.0 - 3.0 * sum / float(SAMPLES), 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(uFade * 0.55, uFade, dist));
  gl_FragColor = vec4(ao, dist, 0.0, 1.0);
}`;

// Seven taps along one axis; a tap only counts if it lies at about the centre's
// depth, so a car's occlusion never smears onto the wall behind it.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tAO, vUv).xy;
  float tol = 1.0 / (0.06 * c.y + 0.1);
  float sum = c.x * 0.2, w = 0.2;
  vec2 s; float k;
  #define TAP(o, g) s = texture2D(tAO, vUv + uDir * o).xy; k = g * max(0.0, 1.0 - abs(s.y - c.y) * tol); sum += s.x * k; w += k;
  TAP(1.0, 0.18) TAP(-1.0, 0.18) TAP(2.0, 0.12) TAP(-2.0, 0.12) TAP(3.0, 0.06) TAP(-3.0, 0.06)
  gl_FragColor = vec4(sum / w, c.y, 0.0, 1.0);
}`;

// What is bright enough to glow, with a soft knee so the cut-off never shows
// as an edge. Measured after exposure, so "bright" means bright on screen.
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 pass(vec2 uv) {
  // The ceiling stops one glinting pixel of chrome from becoming a white disc.
  vec3 c = clamp(texture2D(tColor, uv).rgb * uExposure, 0.0, 6.0);
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  return c * (max(rq, br - uThreshold) / max(br, 1e-4));
}
void main() {
  vec3 c = pass(vUv + uTexel * vec2(-1.0, -1.0)) + pass(vUv + uTexel * vec2(1.0, -1.0))
         + pass(vUv + uTexel * vec2(-1.0, 1.0)) + pass(vUv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0
    + texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
    + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c * 0.125, 1.0);
}`;

// A 3x3 tent, drawn additively onto the next level up, so the chain needs no second set of targets.
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uGain;
varying vec2 vUv;
void main() {
  vec2 t = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0
    + (texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(t.x, 0.0)).rgb
     + texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, t.y)).rgb) * 2.0
    + texture2D(tSrc, vUv + t).rgb + texture2D(tSrc, vUv - t).rgb
    + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(c * (0.0625 * uGain), 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
${DEPTH_FN}
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform sampler2D tBloom;
uniform vec2 uHalf;
uniform float uAO;
uniform float uBloom;
uniform float uPeak;
uniform float uExposure;
uniform float uFogDensity;
uniform float uGrade;
uniform float uDebug;
uniform float uFxaa;
uniform vec2 uEdge;
uniform vec2 uTexel;
#ifdef PHOTO
uniform float uFocus;
uniform float uDofK;
uniform float uDofPx;
uniform float uPhotoExp;
uniform float uLook;
uniform float uVig;
uniform float uGrain;
uniform float uPx;
#endif
varying vec2 vUv;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// Into 0..1 and back, so that averaging two pixels gives the average of how they will look.
vec3 fold(vec3 c) { c = max(c, 0.0) * uExposure; return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 unfold(vec3 c) { return c / (max(1.0 - max(c.r, max(c.g, c.b)), 0.002) * uExposure); }
vec3 tap(vec2 uv) { return fold(texture2D(tColor, uv).rgb); }
float luma(vec3 c) { return sqrt(dot(c, LUMA)); }
float lumaAt(vec2 uv) { return luma(tap(uv)); }
// FXAA, the form that walks along an edge to find where it ends, so a long roof line or a car's
// trim gets an even ramp from end to end instead of a row of teeth.
vec3 sceneColour() {
  vec3 m = tap(vUv);
  if (uFxaa < 0.5) return unfold(m);
  vec2 px = uTexel;
  float lM = luma(m);
  float lD = lumaAt(vUv - vec2(0.0, px.y)), lU = lumaAt(vUv + vec2(0.0, px.y));
  float lL = lumaAt(vUv - vec2(px.x, 0.0)), lR = lumaAt(vUv + vec2(px.x, 0.0));
  float lo = min(lM, min(min(lD, lU), min(lL, lR))), hi = max(lM, max(max(lD, lU), max(lL, lR)));
  float range = hi - lo;
  // No edge here: most of the screen leaves now.
  if (range < max(uEdge.x, hi * uEdge.y)) return unfold(m);
  float lDL = lumaAt(vUv - px), lUR = lumaAt(vUv + px);
  float lDR = lumaAt(vUv + vec2(px.x, -px.y)), lUL = lumaAt(vUv + vec2(-px.x, px.y));
  // Which way the edge runs: brightness bends hardest across it.
  float bendV = abs(lDL + lUL - 2.0 * lL) + 2.0 * abs(lD + lU - 2.0 * lM) + abs(lDR + lUR - 2.0 * lR);
  float bendH = abs(lDL + lDR - 2.0 * lD) + 2.0 * abs(lL + lR - 2.0 * lM) + abs(lUL + lUR - 2.0 * lU);
  bool horz = bendV >= bendH;
  // The neighbour on the far side of the edge is the one that differs more.
  float l1 = horz ? lD : lL, l2 = horz ? lU : lR;
  float g1 = abs(l1 - lM), g2 = abs(l2 - lM);
  bool first = g1 >= g2;
  float grad = 0.25 * max(g1, g2);
  float pairAvg = 0.5 * ((first ? l1 : l2) + lM);
  vec2 perp = horz ? vec2(0.0, px.y) : vec2(px.x, 0.0);
  if (first) perp = -perp;
  vec2 run = horz ? vec2(px.x, 0.0) : vec2(0.0, px.y);
  // Walk both ways along the seam between the two rows until the edge stops being one.
  vec2 pN = vUv + perp * 0.5 - run, pP = vUv + perp * 0.5 + run;
  float eN = lumaAt(pN) - pairAvg, eP = lumaAt(pP) - pairAvg;
  bool doneN = abs(eN) >= grad, doneP = abs(eP) >= grad;
  for (int i = 1; i < 6; i++) {
    if (doneN && doneP) break;
    float s = i < 2 ? 1.5 : i < 4 ? 2.0 : i < 5 ? 4.0 : 8.0;
    if (!doneN) { pN -= run * s; eN = lumaAt(pN) - pairAvg; doneN = abs(eN) >= grad; }
    if (!doneP) { pP += run * s; eP = lumaAt(pP) - pairAvg; doneP = abs(eP) >= grad; }
  }
  float dN = horz ? vUv.x - pN.x : vUv.y - pN.y, dP = horz ? pP.x - vUv.x : pP.y - vUv.y;
  // The nearer end says how far along the step this pixel is; it only counts if the edge
  // ends there the right way round.
  bool below = lM < pairAvg;
  bool good = dN < dP ? (eN < 0.0) != below : (eP < 0.0) != below;
  float blend = good ? 0.5 - min(dN, dP) / (dN + dP) : 0.0;
  // A lone pixel, or a line one pixel wide, has no step to measure: it is blended by how far it
  // stands out from the eight round it, and only lightly, so a lamp post keeps its weight.
  float sub = clamp(abs((2.0 * (lD + lU + lL + lR) + lDL + lDR + lUL + lUR) / 12.0 - lM) / range, 0.0, 1.0);
  sub = sub * sub * (3.0 - 2.0 * sub);
  blend = max(blend, sub * sub * 0.25);
  return unfold(mix(m, tap(vUv + perp), blend));
}
#ifdef PHOTO
// Photo mode's depth of field (fx/photo.ts), gathered, not scattered: a disc of taps whose radius is this pixel's
// blur. A tap nearer than the pixel only counts as far as its own blur reaches, so a sharp thing in front never
// smears a halo onto the soft background behind it. Averaged in the folded space, like the edge smoothing.
float coc(float z) { return clamp(uDofK * abs(z - uFocus) / max(z, 0.1), 0.0, 1.0) * uDofPx; }
vec3 dofColour(vec3 m, float z) {
  float c = coc(z);
  if (c < 0.6) return m;
  vec3 sum = fold(m); float wsum = 1.0;
  float ang = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  for (int i = 0; i < 20; i++) {
    float t = (float(i) + 0.5) / 20.0;
    float r = sqrt(t) * c, a = ang + float(i) * 2.3999632;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
    float zt = viewDist(texture2D(tDepth, uv).x);
    float w = zt < z ? smoothstep(r - 1.0, r + 1.0, coc(zt)) : 1.0;
    sum += tap(uv) * w; wsum += w;
  }
  return unfold(sum / wsum);
}
#endif
void main() {
  vec3 col = sceneColour();
  float d = texture2D(tDepth, vUv).x;
  #ifdef PHOTO
  if (uDofK > 0.0) col = dofColour(col, viewDist(d));
  col *= uPhotoExp;
  #endif
  float shown = 1.0;
  if (d < 0.99995 && uAO > 0.0) {
    // Half-size AO brought up to full size by the four nearest texels, each
    // trusted only as far as its depth agrees with this pixel's: a plain
    // bilinear fetch would leak a dark fringe around every silhouette.
    float z = viewDist(d);
    vec2 p = vUv * uHalf - 0.5, f = fract(p), t = 1.0 / uHalf, b = (floor(p) + 0.5) * t;
    vec2 a00 = texture2D(tAO, b).xy, a10 = texture2D(tAO, b + vec2(t.x, 0.0)).xy;
    vec2 a01 = texture2D(tAO, b + vec2(0.0, t.y)).xy, a11 = texture2D(tAO, b + t).xy;
    vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    w *= max(vec4(0.002), 1.0 - abs(vec4(a00.y, a10.y, a01.y, a11.y) - z) / (0.05 * z + 0.06));
    float ao = dot(w, vec4(a00.x, a10.x, a01.x, a11.x)) / dot(w, vec4(1.0));
    // Fog already stands between the eye and the crease, and anything shining
    // (a lamp's glow sprite, a lit window, a sunlit wall) is not ambient light:
    // both take less. Glow sprites and water write no depth, so this is also
    // what keeps the occlusion of whatever is behind them off them.
    float fog = exp(-uFogDensity * uFogDensity * z * z);
    float lum = dot(col, LUMA) * uExposure;
    shown = mix(1.0, ao * ao, uAO * fog * (1.0 - 0.6 * smoothstep(0.6, 2.0, lum)));
    col *= shown;
  }
  vec3 glow = texture2D(tBloom, vUv).rgb * uBloom;
  col += glow;
  // After dark nothing goes into the tone map brighter than uPeak (after exposure), and it is brought down with
  // its colour intact. The tone map turns anything far over range toward white: a brake lamp at four times
  // white came out pink and a sodium lamp cream. By day the limit is out of reach and this is skipped.
  float pk = max(col.r, max(col.g, col.b)) * uExposure;
  if (pk > 1.0 && uPeak < 60.0) { float room = uPeak - 1.0; col *= (1.0 + room * (1.0 - exp((1.0 - pk) / room))) / pk; }
  if (uDebug > 1.5) col = glow; else if (uDebug > 0.5) col = vec3(shown) * 0.8 / uExposure;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // The grade, on the finished picture: a gentle S, corners a little darker,
  // and still grain fine enough to read as film stock, not as noise. The grain
  // also dithers the night sky's gradient out of its bands.
  vec3 g = clamp(gl_FragColor.rgb, 0.0, 1.0);
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.16 * uGrade);
  float l = dot(g, LUMA);
  g = mix(vec3(l), g, 1.0 + 0.05 * uGrade);
  vec2 q = vUv - 0.5;
  g *= 1.0 - 0.17 * uGrade * smoothstep(0.1, 0.56, dot(q, q));
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  g += n * 0.016 * uGrade * (1.0 - 0.6 * l);
  #ifdef PHOTO
  // The film looks: 1 warm, 2 cool, 3 black and white, 4 faded film, 5 high contrast, 6 the paperwork sepia
  // (the HUD's own ink and bone).
  g = clamp(g, 0.0, 1.0);
  l = dot(g, LUMA);
  if (uLook > 5.5) g = mix(vec3(0.078, 0.129, 0.239), vec3(0.949, 0.910, 0.812), smoothstep(0.0, 1.0, l * 1.08));
  else if (uLook > 4.5) { g = g * g * (3.0 - 2.0 * g); g = clamp(mix(vec3(dot(g, LUMA)), g, 1.3), 0.0, 1.0); }
  else if (uLook > 3.5) g = mix(vec3(0.10, 0.09, 0.12), vec3(0.93, 0.91, 0.84), mix(vec3(l), g, 0.65));
  else if (uLook > 2.5) { l = l * l * (3.0 - 2.0 * l); g = vec3(mix(dot(g, LUMA), l, 0.5)); }
  else if (uLook > 1.5) g *= vec3(0.9, 1.0, 1.12);
  else if (uLook > 0.5) g = g * vec3(1.1, 1.0, 0.84) + vec3(0.02, 0.01, 0.0);
  g *= 1.0 - uVig * smoothstep(0.04, 0.5, dot(q, q));
  vec2 gp = floor(gl_FragCoord.xy / uPx);
  float gn = fract(sin(dot(gp, vec2(91.3458, 47.9898))) * 23421.631) - 0.5;
  g += gn * uGrain * 0.22 * (1.0 - 0.5 * dot(g, LUMA));
  #endif
  gl_FragColor = vec4(clamp(g, 0.0, 1.0), 1.0);
}`;

type U = Record<string, THREE.IUniform>;

function pass(fragmentShader: string, uniforms: U, extra: THREE.ShaderMaterialParameters = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader, uniforms,
    depthTest: false, depthWrite: false, fog: false, toneMapped: false, ...extra,
  });
}

export class Post {
  /** Off means Game.render() draws straight to the canvas. */
  enabled = true;
  /** Multipliers for tuning from the console or a test; 1 is the shipped look. */
  ao = 1;
  bloom = 1;
  grade = 1;
  /**
   * The night's bloom, for tuning from a test (the day's is fixed: threshold 1.05, strength 0.6, every level alike).
   * `nightThreshold`: how bright (on screen, after exposure) a thing must be to glow at all. High enough that a pale
   * car under a lamp does not, low enough that a lit window does. `nightStrength`: the glow of a wide bright
   * area, as a share of what it is over the threshold. `nightSpread`: each wider level of the chain counts this
   * many times the one before, so the glow is a wide soft halo round the lamp and not a second coat of white
   * on the lamp itself. `nightPeak`: see uPeak in the composite.
   */
  nightThreshold = 0.56;
  nightStrength = 3.0;
  nightSpread = 1.7;
  nightPeak = 1.7;
  /**
   * Photo mode (fx/photo.ts): null while it is closed, and the composite is then exactly the shipped one (the photo
   * version is a second material, compiled on first use). `focus` meters, `dof` 0..1 (0 off), `exposure` a
   * multiplier, `look` 0..6, `vignette` and `grain` 0..1, `px` render pixels per window pixel (for a big save).
   */
  photo: { focus: number; dof: number; exposure: number; look: number; vignette: number; grain: number; px: number } | null = null;
  private photoMat: THREE.ShaderMaterial | null = null;
  /** 1 shows the occlusion alone, 2 the bloom alone. */
  debug = 0;
  /** The occlusion passes, on or off (a lever for the quality governor of M6 section 3). Costs nothing while off. */
  aoOn = true;
  /** Edge smoothing (FXAA) in the composite: the tier's choice, unless `?aa=` says otherwise. */
  fxaa = true;
  /** What FXAA takes for an edge: a brightness step (0..1, as it will look on screen) of at least x, and at least y of the brighter side. */
  readonly fxaaEdge = new THREE.Vector2(0.04, 0.125);
  /** The antialiasing this visit started with (the tier's, or `?aa=`): what the governor goes back to after `setAA(0, true)`. */
  readonly baseSamples: number;
  readonly baseFxaa: boolean;

  private readonly tier: Tier;
  private readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly aoA: THREE.WebGLRenderTarget;
  private readonly aoB: THREE.WebGLRenderTarget;
  private readonly mips: THREE.WebGLRenderTarget[] = [];

  private readonly fsScene = new THREE.Scene();
  private readonly fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly aoMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly brightMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly compMat: THREE.ShaderMaterial;
  private w = 0;
  private h = 0;

  constructor(private game: Game) {
    const q = game.quality;
    this.tier = TIERS[q.name === 'medium' ? 'medium' : 'high'];
    const aa = new URLSearchParams(location.search).get('aa');
    const samples = !q.antialias ? 0 : aa === 'msaa' ? this.tier.msaaAlone : aa === 'fxaa' ? 0 : this.tier.msaa;
    this.fxaa = q.antialias && (aa === 'fxaa' || (aa !== 'msaa' && this.tier.fxaa));
    this.baseSamples = samples;
    this.baseFxaa = this.fxaa;

    const depth = new THREE.DepthTexture(2, 2, THREE.UnsignedIntType);
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, samples,
      depthTexture: depth, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
    });
    const small = (format: THREE.PixelFormat): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, format, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.aoA = small(THREE.RGFormat);
    this.aoB = small(THREE.RGFormat);
    for (let i = 0; i < this.tier.levels; i++) this.mips.push(small(THREE.RGBAFormat));

    const tex = (t: THREE.Texture | null = null): THREE.IUniform => ({ value: t });
    const v2 = (): THREE.IUniform => ({ value: new THREE.Vector2() });
    const num = (v = 0): THREE.IUniform => ({ value: v });

    this.aoMat = pass(AO_FRAG, {
      tDepth: tex(depth), uNearFar: v2(), uInvP: v2(), uTexel: v2(), uRadius: num(AO_RADIUS), uFade: num(AO_FADE),
    }, { defines: { SAMPLES: this.tier.ao } });
    this.blurMat = pass(BLUR_FRAG, { tAO: tex(), uDir: v2() });
    this.brightMat = pass(BRIGHT_FRAG, {
      tColor: tex(this.sceneRT.texture), uTexel: v2(), uExposure: num(1), uThreshold: num(1), uKnee: num(0.3),
    });
    this.downMat = pass(DOWN_FRAG, { tSrc: tex(), uTexel: v2() });
    this.upMat = pass(UP_FRAG, { tSrc: tex(), uTexel: v2(), uGain: num(1) }, { blending: THREE.AdditiveBlending, transparent: true });
    this.compMat = pass(COMPOSITE_FRAG, {
      tColor: tex(this.sceneRT.texture), tDepth: tex(depth), tAO: tex(this.aoA.texture), tBloom: tex(this.mips[0].texture),
      uNearFar: v2(), uHalf: v2(), uAO: num(1), uBloom: num(0), uPeak: num(1e6), uExposure: num(1), uFogDensity: num(0), uGrade: num(1), uDebug: num(0), uFxaa: num(1), uTexel: v2(), uEdge: { value: this.fxaaEdge },
    }, { toneMapped: true });

    // One triangle that covers the screen: no diagonal seam, and nothing to cull.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(geo, this.compMat);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);
    this.fsScene.matrixWorldAutoUpdate = false;
    this.fsCam.matrixWorldAutoUpdate = false;
  }

  /** `w` and `h` in CSS pixels, as given to the renderer. */
  setSize(w: number, h: number, pixelRatio: number): void {
    const W = Math.max(8, Math.floor(w * pixelRatio)), H = Math.max(8, Math.floor(h * pixelRatio));
    if (W === this.w && H === this.h) return;
    this.w = W; this.h = H;
    this.sceneRT.setSize(W, H);
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    this.aoA.setSize(hw, hh);
    this.aoB.setSize(hw, hh);
    let mw = hw, mh = hh;
    for (const m of this.mips) {
      m.setSize(mw, mh);
      mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1);
    }
    (this.aoMat.uniforms.uTexel.value as THREE.Vector2).set(1 / W, 1 / H);
    (this.brightMat.uniforms.uTexel.value as THREE.Vector2).set(1 / W, 1 / H);
    (this.compMat.uniforms.uHalf.value as THREE.Vector2).set(hw, hh);
    (this.compMat.uniforms.uTexel.value as THREE.Vector2).set(1 / W, 1 / H);
  }

  /**
   * Change the antialiasing while running, for tools/bench.mjs's A/B and for comparing pictures
   * from one camera: `samples` is the scene target's multisampling (0 for none), `fxaa` the
   * composite's edge smoothing. The target is rebuilt on its next use.
   */
  setAA(samples: number, fxaa: boolean): void {
    if (this.sceneRT.samples !== samples) { this.sceneRT.samples = samples; this.sceneRT.dispose(); }
    this.fxaa = fxaa;
  }

  /** The AO sample count is a shader constant, so this recompiles: for the same comparisons. */
  setAOSamples(n: number): void {
    if (this.aoMat.defines.SAMPLES === n) return;
    this.aoMat.defines.SAMPLES = n;
    this.aoMat.needsUpdate = true;
  }

  private draw(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    const r = this.game.renderer;
    this.quad.material = mat;
    r.setRenderTarget(target);
    r.render(this.fsScene, this.fsCam);
  }

  render(): void {
    const g = this.game, r = g.renderer, cam = g.camera;
    if (this.w === 0) {
      const s = r.getSize(this.aoMat.uniforms.uTexel.value as THREE.Vector2);
      this.setSize(s.x, s.y, r.getPixelRatio());
    }

    r.setRenderTarget(this.sceneRT);
    r.render(g.scene, cam);

    const auto = r.autoClear;
    r.autoClear = false;

    // ── Ambient occlusion ──
    const pe = cam.projectionMatrix.elements;
    const au = this.aoMat.uniforms, cu = this.compMat.uniforms;
    (au.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
    (cu.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
    (au.uInvP.value as THREE.Vector2).set(1 / pe[0], 1 / pe[5]);
    if (this.aoOn) {
      this.draw(this.aoMat, this.aoA);
      const bu = this.blurMat.uniforms, dir = bu.uDir.value as THREE.Vector2;
      bu.tAO.value = this.aoA.texture; dir.set(1 / this.aoA.width, 0);
      this.draw(this.blurMat, this.aoB);
      bu.tAO.value = this.aoB.texture; dir.set(0, 1 / this.aoA.height);
      this.draw(this.blurMat, this.aoA);
    }

    // ── Bloom ──
    // By day only what is brighter than a sunlit white wall may glow; after
    // dark the bar drops so lamps, windows and tail lamps all carry a halo,
    // but not so far that a pale car or a lit pavement glows with them.
    const night = (g.sky ? g.sky.night : 0) * nightBloom.scale;
    const exposure = r.toneMappingExposure;
    const br = this.brightMat.uniforms;
    br.uExposure.value = exposure;
    br.uThreshold.value = 1.05 + (this.nightThreshold - 1.05) * night;
    br.uKnee.value = 0.25;
    const mips = this.mips, n = mips.length;
    this.draw(this.brightMat, mips[0]);
    const du = this.downMat.uniforms, uu = this.upMat.uniforms;
    // By day every level counts alike (gain 1); by night each wider one counts for more.
    const gain = 1 + (this.nightSpread - 1) * night;
    uu.uGain.value = gain;
    let sum = 0;
    for (let i = 0, wgt = 1; i < n; i++, wgt *= gain) sum += wgt;
    for (let i = 1; i < n; i++) {
      du.tSrc.value = mips[i - 1].texture;
      (du.uTexel.value as THREE.Vector2).set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this.draw(this.downMat, mips[i]);
    }
    for (let i = n - 1; i > 0; i--) {
      uu.tSrc.value = mips[i].texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / mips[i].width, 1 / mips[i].height);
      this.draw(this.upMat, mips[i - 1]);
    }

    // ── Composite, tone map, grade ──
    const fog = g.scene.fog;
    cu.uFogDensity.value = fog instanceof THREE.FogExp2 ? fog.density : 0;
    cu.uAO.value = this.aoOn ? AO_STRENGTH * this.ao : 0;
    cu.uFxaa.value = this.fxaa ? 1 : 0;
    cu.uExposure.value = exposure;
    // The chain sums its levels (by weight), and it was built after exposure while
    // the composite applies exposure again: undo both here.
    cu.uBloom.value = this.bloom * (0.6 + (this.nightStrength - 0.6) * night) / (sum * Math.max(exposure, 1e-3));
    // Out of reach by day (64 times white), closing in through dusk: a ratio, so the change is even all the way.
    cu.uPeak.value = night > 0.001 ? this.nightPeak * Math.pow(64 / this.nightPeak, 1 - night) : 1e6;
    cu.uGrade.value = this.grade;
    cu.uDebug.value = this.debug;
    const ph = this.photo;
    if (ph) {
      if (!this.photoMat) {
        const num = (v = 0): THREE.IUniform => ({ value: v });
        // The same uniform objects as the shipped composite, plus the photo ones.
        this.photoMat = pass(COMPOSITE_FRAG, {
          ...this.compMat.uniforms, uFocus: num(10), uDofK: num(0), uDofPx: num(0), uPhotoExp: num(1), uLook: num(0), uVig: num(0), uGrain: num(0), uPx: num(1),
        }, { toneMapped: true, defines: { PHOTO: 1 } });
      }
      const pu = this.photoMat.uniforms;
      pu.uFocus.value = ph.focus;
      pu.uDofK.value = ph.dof * 2.2;
      // The widest blur is a share of the picture, not a count of pixels, so a 2x save looks like the screen.
      pu.uDofPx.value = (6 + 10 * ph.dof) * this.h / 1080;
      pu.uPhotoExp.value = ph.exposure;
      pu.uLook.value = ph.look;
      pu.uVig.value = ph.vignette;
      pu.uGrain.value = ph.grain;
      pu.uPx.value = ph.px;
    }
    this.draw(ph && this.photoMat ? this.photoMat : this.compMat, null);

    r.autoClear = auto;
  }

  dispose(): void {
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.aoA.dispose();
    this.aoB.dispose();
    for (const m of this.mips) m.dispose();
    for (const m of [this.aoMat, this.blurMat, this.brightMat, this.downMat, this.upMat, this.compMat]) m.dispose();
    this.photoMat?.dispose();
    this.quad.geometry.dispose();
  }
}
