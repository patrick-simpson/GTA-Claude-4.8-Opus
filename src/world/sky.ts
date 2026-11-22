// The sky, the light and the weather. One clock (`hour`) drives everything:
// each update the time-of-day palette is blended from keyframes, bent by the
// weather, and pushed to the dome shader, the two lights, the fog, the
// exposure and (now and then) the reflection environment. Nothing here keeps
// state that depends on the clock running smoothly, so tests and cheats can
// set `hour` to anything at any moment.
//
// The one rule that makes the island sit in its sky: the fog colour and the
// dome's horizon band are the same number. Far geometry fades to `fog.color`;
// the dome fades to the same uniform below a few degrees of elevation. three
// mixes fog in AFTER tone mapping, though, and the dome is tone mapped like any
// other surface, so the number handed to the fog is the dome's one put through
// the exposure and the tone curve by hand (see faceFog). Skip that and the two
// agree at noon and part company at night, as a ruler line along the horizon.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { CameraApi, SkyApi, Weather } from '../core/api';
import { RNG, clamp01, lerp, smooth } from '../core/util';

// ── Time-of-day palette ──────────────────────────────────────────────────────

interface KeyDef {
  /** Hour this look is fully in. */
  h: number;
  /** Dome gradient: overhead, the band a hand above the horizon, the horizon itself. */
  zen: number; mid: number; hor: number;
  /** What the horizon turns to on the sun's side of the sky, and how strongly (0..1). */
  glow: number; glowAmt: number;
  /** Key light colour and intensity (the sun; the moon is added separately). */
  sun: number; sunI: number;
  /** The sun's disc as painted in the dome: always the palest thing in the sky. discI near 1 keeps it a flat wafer. */
  disc: number; discI: number;
  hemiSky: number; hemiGnd: number; hemiI: number;
  /** Fog density multiplier: morning haze is thicker than noon. */
  fog: number;
  exposure: number;
  cloudLit: number; cloudShade: number;
}

// No object takes more than this share of the fog colour, however far: a landmark across the water keeps a tenth of its own colour,
// so a spire or a far shore still reads as a shape against the haze. Three's fog chunk has no cap, so it is added here, before
// any material compiles.
const FOG_CAP = '0.9';
if (!THREE.ShaderChunk.fog_fragment.includes('FOG_CAP')) {
  THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment
    .replace('float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );', 'float fogFactor = min(1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth ), ' + FOG_CAP + '); // FOG_CAP')
    .replace('float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );', 'float fogFactor = min(smoothstep( fogNear, fogFar, vFogDepth ), ' + FOG_CAP + '); // FOG_CAP');
}

const NIGHT: Omit<KeyDef, 'h'> = {
  zen: 0x0a1326, mid: 0x13233f, hor: 0x183542, glow: 0x183542, glowAmt: 0,
  sun: 0xffffff, sunI: 0, disc: 0xffd27a, discI: 0,
  hemiSky: 0x4a6da6, hemiGnd: 0x1e2c3c, hemiI: 1.05,
  fog: 1.1, exposure: 1.22, cloudLit: 0x2c4660, cloudShade: 0x101c30,
};
const DAY: Omit<KeyDef, 'h'> = {
  zen: 0x4f9ccd, mid: 0x93c8de, hor: 0xe1e0cb, glow: 0xf1ead2, glowAmt: 0.5,
  sun: 0xfff3dc, sunI: 3.1, disc: 0xfffbe6, discI: 6,
  hemiSky: 0xa9cfe8, hemiGnd: 0xb3ab98, hemiI: 1.75,
  fog: 1, exposure: 1, cloudLit: 0xfdf8ea, cloudShade: 0xa9c4cf,
};

// The fill light (hemiI) is deliberately held up through sunset and let go
// afterwards: the sun's key fades faster than the eye expects, and without the
// overlap the street is darker at half past seven than at midnight.
//
// No purple anywhere. Evening runs blue -> cream -> mustard -> vermilion, and
// the way down to night goes through sage and teal rather than violet, which
// is why dusk has so many keys: a straight blend from orange to navy is mud.
const KEYS: KeyDef[] = [
  { h: 0, ...NIGHT },
  { h: 4.7, ...NIGHT },
  { // first light: the east goes dusty peach under a still-dark sky
    h: 5.5, zen: 0x1b2d4c, mid: 0x47697b, hor: 0x8f958c, glow: 0xe89e74, glowAmt: 0.95,
    sun: 0xffb27a, sunI: 0, disc: 0xffd9a0, discI: 1,
    hemiSky: 0x6f8fb2, hemiGnd: 0x4a4038, hemiI: 1.15,
    fog: 2.05, exposure: 1.15, cloudLit: 0xe2a383, cloudShade: 0x2c425a,
  },
  { // sunrise: cream and peach sea fog
    h: 6.3, zen: 0x6497ad, mid: 0xf0dcb8, hor: 0xf3c7a0, glow: 0xf7a56c, glowAmt: 0.9,
    sun: 0xffc48e, sunI: 1.9, disc: 0xfff0c4, discI: 1.1,
    hemiSky: 0xd6cdbb, hemiGnd: 0xa08a70, hemiI: 1.55,
    fog: 2.3, exposure: 1.05, cloudLit: 0xfde3c0, cloudShade: 0xc79a86,
  },
  { // the cream hour
    h: 7.5, zen: 0x66a8c8, mid: 0xcfe4da, hor: 0xf2e8cf, glow: 0xfcebc6, glowAmt: 0.7,
    sun: 0xffe2b8, sunI: 2.7, disc: 0xfff8dc, discI: 2.5,
    hemiSky: 0xbcd6de, hemiGnd: 0xb3a78e, hemiI: 1.7,
    fog: 1.95, exposure: 1, cloudLit: 0xfff6e2, cloudShade: 0xb9c9c8,
  },
  { h: 9.5, ...DAY },
  { h: 16, ...DAY },
  { // late afternoon: the horizon warms first
    h: 17.5, zen: 0x4e96c2, mid: 0xb7d5cc, hor: 0xefdcab, glow: 0xf6cd77, glowAmt: 0.75,
    sun: 0xffdfa8, sunI: 2.9, disc: 0xfff6d0, discI: 2.5,
    hemiSky: 0xa9cbe0, hemiGnd: 0xbfa680, hemiI: 1.65,
    fog: 1, exposure: 1, cloudLit: 0xfff0cf, cloudShade: 0xa9bcc0,
  },
  { // golden hour: mustard under a band of cream
    h: 18.6, zen: 0x4c8fb8, mid: 0xf3e2b0, hor: 0xf0b244, glow: 0xee8433, glowAmt: 0.9,
    sun: 0xffbe6a, sunI: 2.5, disc: 0xfff0b8, discI: 1.15,
    hemiSky: 0x9fbccd, hemiGnd: 0xc49a5e, hemiI: 1.58,
    fog: 1.1, exposure: 1.03, cloudLit: 0xfdd58c, cloudShade: 0xb97a56,
  },
  { // sunset: vermilion
    h: 19.5, zen: 0x27496e, mid: 0xe0a95e, hor: 0xdf7a42, glow: 0xee5a2c, glowAmt: 1,
    sun: 0xff8a4e, sunI: 1.3, disc: 0xffd27a, discI: 1.05,
    hemiSky: 0x7d93ad, hemiGnd: 0x9a6a4a, hemiI: 1.62,
    fog: 1.1, exposure: 1.1, cloudLit: 0xf2884a, cloudShade: 0x3a4b5c,
  },
  { // the band above the horizon cools to sage while the horizon still burns
    h: 19.8, zen: 0x1a3358, mid: 0x8fae8c, hor: 0xd98e52, glow: 0xe85a2c, glowAmt: 1,
    sun: 0xff8a4e, sunI: 0, disc: 0xffd27a, discI: 1,
    hemiSky: 0x6f8aad, hemiGnd: 0x6a5648, hemiI: 1.43,
    fog: 1.1, exposure: 1.14, cloudLit: 0xd9764a, cloudShade: 0x2a3550,
  },
  { // teal over sage, one ember left in the west
    h: 20.1, zen: 0x13254a, mid: 0x3d7f86, hor: 0x7d9a7c, glow: 0xc9603a, glowAmt: 0.9,
    sun: 0xff8a4e, sunI: 0, disc: 0xffd27a, discI: 0,
    hemiSky: 0x5d7ba6, hemiGnd: 0x3a3c44, hemiI: 1.3,
    fog: 1.1, exposure: 1.18, cloudLit: 0x8a6a5a, cloudShade: 0x18284a,
  },
  { // dusk
    h: 20.45, zen: 0x0f1c36, mid: 0x1d4160, hor: 0x2f6e74, glow: 0x8a5a44, glowAmt: 0.6,
    sun: 0xff8a4e, sunI: 0, disc: 0xffd27a, discI: 0,
    hemiSky: 0x52729f, hemiGnd: 0x263040, hemiI: 1.14,
    fog: 1.1, exposure: 1.2, cloudLit: 0x3f4f62, cloudShade: 0x121f36,
  },
  { h: 21.2, ...NIGHT },
  { h: 24, ...NIGHT },
];

/** A keyframe with its colours converted to linear once, and the blended result. */
class Pal {
  zen = new THREE.Color(); mid = new THREE.Color(); hor = new THREE.Color(); glow = new THREE.Color();
  sun = new THREE.Color(); disc = new THREE.Color(); hemiSky = new THREE.Color(); hemiGnd = new THREE.Color();
  cloudLit = new THREE.Color(); cloudShade = new THREE.Color();
  glowAmt = 0; sunI = 0; discI = 0; hemiI = 0; fog = 1; exposure = 1;

  from(k: Omit<KeyDef, 'h'>): this {
    this.zen.setHex(k.zen); this.mid.setHex(k.mid); this.hor.setHex(k.hor); this.glow.setHex(k.glow);
    this.sun.setHex(k.sun); this.disc.setHex(k.disc); this.hemiSky.setHex(k.hemiSky); this.hemiGnd.setHex(k.hemiGnd);
    this.cloudLit.setHex(k.cloudLit); this.cloudShade.setHex(k.cloudShade);
    this.glowAmt = k.glowAmt; this.sunI = k.sunI; this.discI = k.discI; this.hemiI = k.hemiI;
    this.fog = k.fog; this.exposure = k.exposure;
    return this;
  }

  mix(a: Pal, b: Pal, t: number): void {
    this.zen.lerpColors(a.zen, b.zen, t); this.mid.lerpColors(a.mid, b.mid, t);
    this.hor.lerpColors(a.hor, b.hor, t); this.glow.lerpColors(a.glow, b.glow, t);
    this.sun.lerpColors(a.sun, b.sun, t); this.disc.lerpColors(a.disc, b.disc, t);
    this.hemiSky.lerpColors(a.hemiSky, b.hemiSky, t); this.hemiGnd.lerpColors(a.hemiGnd, b.hemiGnd, t);
    this.cloudLit.lerpColors(a.cloudLit, b.cloudLit, t); this.cloudShade.lerpColors(a.cloudShade, b.cloudShade, t);
    this.glowAmt = lerp(a.glowAmt, b.glowAmt, t); this.sunI = lerp(a.sunI, b.sunI, t);
    this.discI = lerp(a.discI, b.discI, t); this.hemiI = lerp(a.hemiI, b.hemiI, t);
    this.fog = lerp(a.fog, b.fog, t); this.exposure = lerp(a.exposure, b.exposure, t);
  }
}

// ── Weather ──────────────────────────────────────────────────────────────────

// What each kind of weather does to the palette. Stored as plain numbers so a
// change of weather is one array lerp.
const enum W { cover, sun, amb, sat, dim, fogMul, dens, haze, tint, rain, gloom, cirrus, N }

function weatherParams(w: Weather, drawDist: number): Float32Array {
  const p = new Float32Array(W.N);
  // FogExp2 leaves 5% of the scene's own colour at distance 1.73 / density.
  const vis = (m: number): number => 1.73 / m;
  switch (w) {
    case 'clear':
      p.set([0.3, 1, 1, 1, 1, 1, 0, 0.075, 0, 0, 0, 1]); break;
    case 'overcast':
      p.set([1, 0.27, 1.14, 0.5, 0.9, 1.25, 0, 0.12, 0.15, 0, 0.1, 0]); break;
    case 'fog':
      p.set([0.5, 0.3, 1.05, 0.55, 1, 1, vis(150), 3, 1, 0, 0.3, 0]); break;
    case 'rain':
      p.set([1, 0.1, 0.84, 0.3, 0.52, 1, vis(Math.min(430, drawDist * 0.8)), 0.3, 0.3, 1, 0.3, 0]); break;
  }
  return p;
}

// ── Tunables ─────────────────────────────────────────────────────────────────

const SUNRISE = 6, SUNSET = 19.5;
const MOONRISE = 18.5, MOONSET = 6.5;
/** The sun's arc leans this far south of overhead, so the harbor view is side-lit. */
const SUN_TILT = 35 * Math.PI / 180;
const MOON_TILT = 52 * Math.PI / 180;
/** The key light never drops below this (about 13 degrees), or shadows would run to the horizon. */
const MIN_LIGHT_Y = 0.22;
const MOON_LIGHT = new THREE.Color(0xa9c3ea);
const MOON_I = 0.62;
const FOG_DAY = new THREE.Color(0xeae1ca);
const FOG_NIGHT = new THREE.Color(0x1f2d3a);
const WET_GROUND = new THREE.Color(0x6f7068);
/** Seconds for one kind of weather to give way to the next. */
const WEATHER_BLEND = 20;
const SHADOW_BOX = 130;
const SHADOW_DIST = 320;
const ENV_SIZE = 64;
const RAIN_BOX = new THREE.Vector3(34, 26, 34);

// ── Shaders ──────────────────────────────────────────────────────────────────

// A cube is enough: the fragment shader normalises the interpolated position,
// which gives the exact view direction with twelve triangles. The view matrix
// is applied without its translation, so the dome is always centred on
// whichever camera is drawing it and never needs moving.
const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.w);
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uZen, uMid, uHor, uGlow;
uniform float uGlowAmt;
uniform vec3 uFog;
uniform float uHaze;
uniform vec3 uSunDir, uMoonDir, uMoonL;
uniform vec2 uSunAz;
uniform vec3 uSunCol, uHaloCol, uMoonCol;
uniform float uSunDisc, uSunR, uMoonVis;
uniform float uStars, uTime;
uniform vec2 uWind;
uniform float uCover, uCirrus;
uniform vec3 uCloudLit, uCloudShade;
uniform vec3 uGround;
uniform sampler2D uNoise;
varying vec3 vDir;

const float MOON_R = 0.046;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float cloudField(vec2 p) {
  return texture2D(uNoise, p).r * 0.64 + texture2D(uNoise, p * 2.9 + uWind * 0.6).g * 0.36;
}

void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);

  // The gradient. Smoothsteps rather than one long ramp, so each stop holds
  // for a band before giving way to the next: printed, not airbrushed.
  vec2 dxz = d.xz / max(length(d.xz), 1e-4);
  float toSun = 0.5 + 0.5 * dot(dxz, uSunAz);
  float g = uGlowAmt * toSun * toSun * toSun;
  vec3 hor = mix(uHor, uGlow, g);
  vec3 mid = mix(uMid, uGlow, g * 0.3);
  vec3 col = mix(hor, mid, smoothstep(0.015, 0.2, up));
  col = mix(col, uZen, smoothstep(0.16, 0.62, up));

  float muS = dot(d, uSunDir);
  float sunAng = sqrt(max(2.0 * (1.0 - muS), 0.0));
  float mS = max(muS, 0.0);
  // The halo is part of the painted sky, not a post effect: a wide wash and a tight one.
  float m8 = mS * mS; m8 *= m8; m8 *= m8;
  col += uHaloCol * (m8 * 0.5 + pow(mS, 120.0));

#ifndef ENV
  // Moon: a lit sphere seen as a disc, so the phase has a proper curved terminator.
  vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
  vec3 mu = cross(uMoonDir, mr);
  vec2 mp = vec2(dot(d, mr), dot(d, mu)) / MOON_R;
  mp = mat2(0.94, -0.342, 0.342, 0.94) * mp;
  float mrad = length(mp);
  float moonMask = (1.0 - smoothstep(1.0 - fwidth(mrad), 1.0 + fwidth(mrad), mrad)) * step(0.0, dot(d, uMoonDir)) * uMoonVis;
  float maria = texture2D(uNoise, mp * 0.09 + 0.31).b;

  if (uStars > 0.004) {
    vec3 sp = d * 120.0;
    vec3 cell = floor(sp);
    vec3 h = hash33(cell);
    vec3 f = sp - cell - 0.5 - (h - 0.5) * 0.5;
    float mag = h.x * h.x * h.x;
    float r = 0.09 + 0.11 * mag;
    float s = (1.0 - smoothstep(r * 0.35, r, length(f))) * step(0.55, h.y) * (0.3 + 0.7 * mag);
    s *= 0.72 + 0.28 * sin(uTime * (1.5 + 3.0 * h.z) + h.y * 40.0);
    col += vec3(0.95, 0.93, 0.82) * s * uStars * smoothstep(0.02, 0.2, up) * (1.0 - moonMask);
  }

  vec3 mn = vec3(mp, sqrt(max(1.0 - mrad * mrad, 0.0)));
  float mlit = smoothstep(-0.04, 0.1, dot(mn, uMoonL));
  vec3 face = uMoonCol * (0.8 + 0.2 * mn.z) * (1.0 - 0.2 * smoothstep(0.42, 0.62, maria));
  col += uMoonCol * pow(max(dot(d, uMoonDir), 0.0), 900.0) * 0.1 * uMoonVis;
  col = mix(col, mix(col + uMoonCol * 0.03, face, mlit), moonMask);
#endif

  // Clouds live on a flat sheet overhead, so they pile up and flatten toward
  // the horizon the way real decks do.
  vec2 cuv = d.xz / (up + 0.15);
  vec2 p1 = cuv * 0.085 + uWind;
  float n = cloudField(p1);
  float th = mix(0.78, 0.2, uCover);
  float dens = smoothstep(th, th + 0.055, n);
  // One more tap a step toward the sun: where the field falls away in that
  // direction is a sunward edge, and gets the light.
  float nSun = cloudField(p1 + uSunAz * 0.02);
  float thick = smoothstep(th, th + 0.42, n);
  float lit = smoothstep(0.3, 0.7, 0.62 - thick * 0.55 + (n - nSun) * 4.5);
  vec3 ccol = mix(uCloudShade, uCloudLit, lit);
  // A closed deck has no edges for the light to catch, so it gets its shape
  // from long soft bands instead: paler where the lid is thin.
  float band = texture2D(uNoise, cuv * vec2(0.03, 0.085) + uWind * 0.5 + 0.37).g * 0.75 + n * 0.25;
  ccol = mix(ccol, mix(uCloudShade * 0.8, uCloudLit, smoothstep(0.36, 0.64, band)), smoothstep(0.6, 1.0, uCover) * 0.9);
  ccol += uHaloCol * m8 * (1.0 - thick) * 0.6;
  float streak = texture2D(uNoise, vec2(cuv.x * 0.013 + cuv.y * 0.006, cuv.y * 0.075 - cuv.x * 0.02) + uWind * 0.35).g;
  float cirrus = smoothstep(0.5, 0.86, streak) * uCirrus * 0.5;
  float fade = smoothstep(0.0, 0.11, up);
  col = mix(col, uCloudLit, cirrus * fade);
  float cloud = dens * fade;
  col = mix(col, ccol, cloud);

  // The haze band. At the horizon this is exactly the fog colour, which is
  // what makes the far shore melt into the sky. In fog weather uHaze is huge
  // and the whole dome goes to fog.
  float hz = up / uHaze;
  float haze = d.y > 0.0 ? exp(-hz * sqrt(hz)) : 1.0;

#ifdef ENV
  // For reflections the lower half is the ground the car is standing on.
  col = mix(col, uFog, haze * 0.8);
  col = mix(col, uGround, smoothstep(0.02, -0.1, d.y));
  gl_FragColor = vec4(col, 1.0);
#else
  col = mix(col, uFog, haze);

  // The sun goes on last, a flat wafer with a faint printed ring, cut clean by the horizon.
  float aa = fwidth(sunAng);
  float veil = uSunDisc * (1.0 - cloud * 0.92) * smoothstep(-0.003, 0.003, d.y);
  float ring = 1.0 - smoothstep(uSunR * 1.9 - aa, uSunR * 1.9 + aa, sunAng);
  col = mix(col, max(col, uSunCol * 0.5), ring * 0.2 * veil);
  float disc = 1.0 - smoothstep(uSunR - aa, uSunR + aa, sunAng);
  col = mix(col, uSunCol, disc * veil);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Half a grey level of noise: the night gradient is too gentle for eight bits without it.
  gl_FragColor.rgb += (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
#endif
}`;

// Rain is one mesh of thin quads living in a box that wraps around the camera
// in the vertex shader. Nothing is moved on the CPU.
const RAIN_VERT = /* glsl */ `
attribute vec3 seed;
uniform vec3 uOff, uBox, uFall;
uniform float uAmount;
varying float vA;
void main() {
  // Speeds are in tenths so the offset can wrap on the CPU without a visible jump.
  float sp = 0.8 + 0.1 * floor(seed.x * 5.0);
  vec3 rel = mod(position + uOff * sp - cameraPosition, uBox) - 0.5 * uBox;
  vec3 axis = normalize(uFall);
  float len = 0.45 + 0.55 * seed.y;
  float dist = length(rel);
  // Width grows with distance so a streak is about two pixels wherever it is:
  // thinner and far ones sparkle, a fixed width and near ones are bars.
  float wid = max(0.0035, dist * 0.0011);
  vec3 side = normalize(cross(axis, rel));
  vec3 p = cameraPosition + rel - axis * len * uv.y + side * wid * (uv.x - 0.5) * 2.0;
  vA = step(seed.z, uAmount) * smoothstep(0.5 * uBox.x, 0.3 * uBox.x, dist) * smoothstep(1.6, 4.5, dist)
     * (1.0 - abs(uv.y - 0.5) * 1.4);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  gl_FragColor = vec4(uColor, vA * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Tileable noise for the dome: R and G are two cloud fields, B a soft blotch (the moon's seas). */
function makeNoise(): THREE.DataTexture {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const rng = new RNG(7719);
  const chan = (c: number, octaves: number, base: number, gain: number): void => {
    const f = new Float32Array(S * S);
    let amp = 1, cells = base;
    for (let o = 0; o < octaves; o++, amp *= gain, cells *= 2) {
      const lat = new Float32Array(cells * cells);
      for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
      const k = cells / S;
      for (let y = 0; y < S; y++) {
        const fy = y * k, y0 = Math.floor(fy), ty = smooth(fy - y0), y1 = (y0 + 1) % cells;
        for (let x = 0; x < S; x++) {
          const fx = x * k, x0 = Math.floor(fx), tx = smooth(fx - x0), x1 = (x0 + 1) % cells;
          const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1];
          const cc = lat[y1 * cells + x0], dd = lat[y1 * cells + x1];
          f[y * S + x] += amp * lerp(lerp(a, b, tx), lerp(cc, dd, tx), ty);
        }
      }
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < f.length; i++) { lo = Math.min(lo, f[i]); hi = Math.max(hi, f[i]); }
    for (let i = 0; i < f.length; i++) data[i * 4 + c] = Math.round(255 * (f[i] - lo) / (hi - lo));
  };
  chan(0, 5, 4, 0.5);
  chan(1, 5, 8, 0.55);
  chan(2, 3, 4, 0.5);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;
/**
 * Overcast and rain wash the colour out toward grey, then dim it. The sky's
 * grey is cool; the light's is warm (bone), or brick and terracotta under a
 * lid of cloud turn to mud.
 */
function wash(c: THREE.Color, sat: number, dim: number, warm = false): void {
  const l = c.r * LUMA_R + c.g * LUMA_G + c.b * LUMA_B;
  c.r = lerp(l * (warm ? 1.07 : 0.95), c.r, sat) * dim;
  c.g = lerp(l, c.g, sat) * dim;
  c.b = lerp(l * (warm ? 0.86 : 1.04), c.b, sat) * dim;
}

/**
 * three's NeutralToneMapping on the CPU, exposure included. Fog is mixed into
 * every material after its tone mapping, so the fog colour has to be given
 * already mapped to land on the same value as the dome's horizon.
 */
function toneMap(c: THREE.Color, exposure: number): void {
  let r = c.r * exposure, g = c.g * exposure, b = c.b * exposure;
  const x = Math.min(r, g, b);
  const off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= off; g -= off; b -= off;
  const peak = Math.max(r, g, b), start = 0.76;
  if (peak >= start) {
    const d = 1 - start, np = 1 - d * d / (peak + d - start), k = np / peak;
    const m = 1 - 1 / (0.15 * (peak - np) + 1);
    r = lerp(r * k, np, m); g = lerp(g * k, np, m); b = lerp(b * k, np, m);
  }
  c.setRGB(r, g, b);
}

// ── Sky ──────────────────────────────────────────────────────────────────────

export class Sky implements SkyApi {
  hour = 8.5;
  rate = 1 / 60;
  readonly lightDir = new THREE.Vector3(0.6, 0.6, 0.5).normalize();

  /** Extras for anyone who wants them (the water, a lens flare): true positions, which unlike lightDir can be below the horizon. */
  readonly sunDir = new THREE.Vector3(1, 0, 0);
  readonly moonDir = new THREE.Vector3(-1, 0, 0);
  readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);

  /**
   * In a shared town the hour and the weather are the town's (net/town.ts sets them every frame from the service's
   * clock): while this is true the clock here does not run and the weather does not pick for itself.
   */
  led = false;
  /** Somebody at this keyboard asked for an hour or a weather (a cheat, a test). The town listens: its host tells everybody. */
  asked: ((hour: number | null, weather: Weather | null) => void) | null = null;

  get night(): number { return this._night; }
  get weather(): Weather { return this._weather; }
  get wet(): number { return this._wet; }

  private _night = 0;
  private _weather: Weather = 'clear';
  private _wet = 0;

  private readonly fog = new THREE.FogExp2(0xffffff, 0.001);
  private readonly keys: Pal[];
  private readonly pal = new Pal();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly dome: THREE.Mesh;
  private readonly rain: THREE.Mesh;
  private readonly rainU: Record<string, THREE.IUniform>;

  // Weather blend: from -> to over WEATHER_BLEND seconds; `w` is where it stands now.
  private readonly wFrom: Float32Array;
  private readonly wTo: Float32Array;
  private readonly w: Float32Array;
  private readonly wTable: Record<Weather, Float32Array>;
  private wT = 1;
  /** Game hours until the weather next thinks about changing. */
  private drift = 4;
  private readonly rng = new RNG(1907);
  /** Whole days since the start; turns the moon's phase. */
  private day = 0;
  private clock = 0;

  // Environment (reflections).
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envCube: THREE.WebGLCubeRenderTarget;
  private readonly envCam: THREE.CubeCamera;
  private readonly envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private readonly envSig = new Float32Array(16);
  private readonly sig = new Float32Array(16);
  private envAt = -1e9;
  private envForce = true;

  // Horizon colours before the view direction picks between them; onBeforeRender finishes the job.
  private readonly horBase = new THREE.Color();
  private readonly horGlow = new THREE.Color();
  private readonly fogFlat = new THREE.Color();
  private glowAmt = 0;
  private fogTint = 0;
  private exposure = 1;
  private readonly sunAz = new THREE.Vector2(1, 0);
  private readonly viewAz = new THREE.Vector2(0, 1);

  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly c1 = new THREE.Color();
  private readonly envKeep = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private readonly rainOff = new THREE.Vector3();
  /** Edge of the square the sun's shadow map covers, meters: SHADOW_BOX unless the quality governor has shortened it. */
  private shadowBox = SHADOW_BOX;

  constructor(private game: Game) {
    const { renderer, scene, quality } = game;

    // Neutral keeps the palette's hues where they were put and only rolls off
    // the very top; ACES and AgX both drag bone and mustard toward grey.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;

    this.keys = KEYS.map((k) => new Pal().from(k));
    this.wTable = {
      clear: weatherParams('clear', quality.drawDist),
      overcast: weatherParams('overcast', quality.drawDist),
      fog: weatherParams('fog', quality.drawDist),
      rain: weatherParams('rain', quality.drawDist),
    };
    this.wFrom = this.wTable.clear.slice();
    this.wTo = this.wTable.clear.slice();
    this.w = this.wTable.clear.slice();

    // ── Dome ──
    const col = (): THREE.IUniform => ({ value: new THREE.Color() });
    const num = (v = 0): THREE.IUniform => ({ value: v });
    this.uniforms = {
      uZen: col(), uMid: col(), uHor: col(), uGlow: col(), uGlowAmt: num(),
      uFog: col(), uHaze: num(0.05),
      uSunDir: { value: this.sunDir }, uMoonDir: { value: this.moonDir }, uMoonL: { value: new THREE.Vector3(1, 0, 0) },
      uSunAz: { value: this.sunAz },
      uSunCol: col(), uHaloCol: col(), uMoonCol: col(),
      uSunDisc: num(), uSunR: num(0.04), uMoonVis: num(),
      uStars: num(), uTime: num(), uWind: { value: new THREE.Vector2() },
      uCover: num(), uCirrus: num(),
      uCloudLit: col(), uCloudShade: col(), uGround: col(),
      uNoise: { value: makeNoise() },
    };
    const box = new THREE.BoxGeometry(2, 2, 2);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(box, domeMat);
    this.dome.name = 'sky';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.matrixAutoUpdate = false;
    // The fog colour depends on which way the camera faces, and the camera can
    // still be moved after update() (screenshot views, shake). Settling it here,
    // as the first thing drawn each frame, means it is never a frame behind.
    this.dome.onBeforeRender = (_r, _s, camera) => this.faceFog(camera);
    scene.add(this.dome);

    // ── Lights ──
    this.sun.name = 'key';
    scene.add(this.sun, this.sun.target, this.hemi);
    if (quality.shadows) {
      const s = this.sun.shadow, half = SHADOW_BOX / 2;
      this.sun.castShadow = true;
      s.mapSize.set(quality.shadowSize, quality.shadowSize);
      s.camera.left = -half; s.camera.right = half; s.camera.top = half; s.camera.bottom = -half;
      s.camera.near = 1; s.camera.far = SHADOW_DIST * 2;
      s.camera.updateProjectionMatrix();
      // normalBias is in meters and does most of the work: about two texels
      // lifts flat ground clear of acne at low sun without lifting shadows off
      // the tires. The depth bias is kept tiny because it is a fraction of a
      // 640 m range.
      const texel = SHADOW_BOX / quality.shadowSize;
      s.normalBias = texel * 1.6;
      s.bias = -0.00012;
    }

    scene.fog = this.fog;

    // ── Rain ──
    const n = Math.round(5600 * lerp(0.5, 1, quality.density));
    const rr = new RNG(31);
    const pos = new Float32Array(n * 12), seed = new Float32Array(n * 12), uv = new Float32Array(n * 8);
    const idx = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const x = rr.next() * RAIN_BOX.x, y = rr.next() * RAIN_BOX.y, z = rr.next() * RAIN_BOX.z;
      const a = rr.next(), b = rr.next(), c = rr.next();
      for (let k = 0; k < 4; k++) {
        pos.set([x, y, z], i * 12 + k * 3);
        seed.set([a, b, c], i * 12 + k * 3);
        uv.set([k & 1, k >> 1], i * 8 + k * 2);
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
    rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    rg.setIndex(new THREE.BufferAttribute(idx, 1));
    this.rainU = {
      uOff: { value: this.rainOff }, uBox: { value: RAIN_BOX }, uFall: { value: new THREE.Vector3(2.4, -21, 1.1) },
      uAmount: num(), uColor: col(), uOpacity: num(0.26),
    };
    this.rain = new THREE.Mesh(rg, new THREE.ShaderMaterial({
      uniforms: this.rainU, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.rain.name = 'rain';
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 900;
    this.rain.visible = false;
    scene.add(this.rain);

    // ── Environment ──
    // A 64 px cube of the dome alone, prefiltered. Small on purpose: it only
    // has to give paint and glass a sky to mirror, and it is redone often.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();
    this.envCube = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.envCam = new THREE.CubeCamera(0.1, 10, this.envCube);
    const envDome = new THREE.Mesh(box, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, defines: { ENV: 1 },
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    }));
    envDome.frustumCulled = false;
    this.envScene.add(envDome);

    this.update(0);
  }

  /** A cheat or a test wants this hour or this weather: done here, and told to whoever is listening. */
  ask(hour: number | null, weather: Weather | null = null, instant = false): void {
    if (hour !== null && Number.isFinite(hour)) this.hour = ((hour % 24) + 24) % 24;
    if (weather !== null) this.setWeather(weather, instant);
    this.asked?.(hour, weather);
  }

  /** The town's clock (net/town.ts): the hour, and the day it belongs to (the moon's phase). */
  lead(hour: number, day: number): void { this.hour = hour; this.day = day; }

  setWeather(w: Weather, instant = false): void {
    this._weather = w;
    this.wFrom.set(this.w);
    this.wTo.set(this.wTable[w]);
    this.wT = instant ? 1 : 0;
    if (instant) { this.w.set(this.wTo); this.envForce = true; if (w === 'rain') this._wet = 1; }
    // Whoever asked for this weather gets to keep it for a while.
    this.drift = this.spell(w);
  }

  /** How many game hours a kind of weather tends to last. */
  private spell(w: Weather): number {
    const r = this.rng;
    return w === 'clear' ? r.range(3, 6) : w === 'overcast' ? r.range(2, 4) : w === 'fog' ? r.range(1.5, 3) : r.range(1, 2.5);
  }

  /** Mostly clear; fog belongs to the small hours and burns off; rain now and then. */
  private pickWeather(): Weather {
    const h = this.hour, r = this.rng.next();
    const early = h > 3.5 && h < 8.5;
    const pFog = early ? 0.4 : h > 10 && h < 19 ? 0.03 : 0.1;
    const pRain = 0.13, pOver = 0.2;
    if (r < pFog) return 'fog';
    if (r < pFog + pRain) return 'rain';
    if (r < pFog + pRain + pOver) return 'overcast';
    return 'clear';
  }

  update(dt: number): void {
    const g = this.game, q = g.quality, u = this.uniforms, w = this.w;

    // ── Clock ──
    let h = this.hour + (this.led ? 0 : this.rate * dt);
    if (!(h >= 0)) h = 0;
    if (h >= 24) { h %= 24; this.day++; }
    this.hour = h;
    this.clock += dt;

    // ── Weather ──
    if (!this.led) this.drift -= this.rate * dt;
    if (this.drift <= 0) {
      const next = this.pickWeather();
      if (next !== this._weather) this.setWeather(next);
      else this.drift = this.spell(next);
    }
    if (this.wT < 1) {
      this.wT = Math.min(1, this.wT + dt / WEATHER_BLEND);
      const t = smooth(this.wT);
      for (let i = 0; i < W.N; i++) w[i] = lerp(this.wFrom[i], this.wTo[i], t);
    }

    // ── Sun and moon ──
    const sunUp = h >= SUNRISE && h < SUNSET;
    const sa = sunUp
      ? Math.PI * (h - SUNRISE) / (SUNSET - SUNRISE)
      : Math.PI + Math.PI * ((h - SUNSET + 24) % 24) / (24 - SUNSET + SUNRISE);
    this.sunDir.set(Math.cos(sa), Math.sin(sa) * Math.cos(SUN_TILT), Math.sin(sa) * Math.sin(SUN_TILT));
    const moonUp = h >= MOONRISE || h < MOONSET;
    const ma = moonUp
      ? Math.PI * ((h - MOONRISE + 24) % 24) / (24 - MOONRISE + MOONSET)
      : Math.PI + Math.PI * (h - MOONSET) / (MOONRISE - MOONSET);
    this.moonDir.set(Math.cos(ma), Math.sin(ma) * Math.cos(MOON_TILT), Math.sin(ma) * Math.sin(MOON_TILT));
    const sy = this.sunDir.y;
    const dark = 1 - smooth((sy + 0.18) / 0.28);
    // Lamps and windows come on a little in rain and thick fog, even at noon.
    this._night = Math.max(dark, w[W.gloom]);

    // ── Palette ──
    const keys = this.keys;
    let i = 0;
    while (i < KEYS.length - 2 && h >= KEYS[i + 1].h) i++;
    const p = this.pal;
    p.mix(keys[i], keys[i + 1], clamp01((h - KEYS[i].h) / (KEYS[i + 1].h - KEYS[i].h)));

    // Cloud over a lit town is never black: at night the lid keeps more of its light than it does by day.
    const sat = w[W.sat], dim = lerp(w[W.dim], Math.pow(w[W.dim], 0.4), dark);
    wash(p.zen, sat, dim); wash(p.mid, sat, dim); wash(p.hor, sat, dim); wash(p.glow, sat, dim);
    wash(p.cloudLit, lerp(sat, 1, 0.3), lerp(dim, 1, 0.25)); wash(p.cloudShade, sat, dim * lerp(0.8, 1, sat));
    wash(p.hemiSky, lerp(sat, 1, 0.4), 1, true); wash(p.hemiGnd, lerp(sat, 1, 0.4), 1, true);
    // A full deck has no sunlit tops to show from below. Without this an overcast
    // sky reads as white clouds on a grey sky rather than as a lid.
    p.cloudLit.lerp(p.cloudShade, 0.5 * smooth((w[W.cover] - 0.55) / 0.45));

    (u.uZen.value as THREE.Color).copy(p.zen);
    (u.uMid.value as THREE.Color).copy(p.mid);
    (u.uHor.value as THREE.Color).copy(p.hor);
    (u.uGlow.value as THREE.Color).copy(p.glow);
    u.uGlowAmt.value = p.glowAmt;
    (u.uCloudLit.value as THREE.Color).copy(p.cloudLit);
    (u.uCloudShade.value as THREE.Color).copy(p.cloudShade);
    u.uCover.value = w[W.cover];
    u.uCirrus.value = w[W.cirrus];
    u.uHaze.value = w[W.haze] * lerp(1, 1.5, clamp01((p.fog - 1.1) * 1.1));
    u.uTime.value = this.clock;
    // Clouds cross the sky in a few minutes; faster and the eye reads it as a time-lapse.
    (u.uWind.value as THREE.Vector2).set((this.clock * 0.0021) % 1, (this.clock * 0.0008) % 1);

    const veil = clamp01(1 - w[W.tint] * 0.75) * clamp01(w[W.sun] * 2 + 0.25);
    const low = 1 - smooth(sy / 0.5);
    u.uSunR.value = lerp(0.036, 0.058, low);
    u.uSunDisc.value = smooth((sy + 0.07) / 0.05) * veil;
    (u.uSunCol.value as THREE.Color).copy(p.disc).multiplyScalar(p.discI);
    (u.uHaloCol.value as THREE.Color).copy(p.sun).multiplyScalar(0.3 * w[W.sun] * smooth((sy + 0.2) / 0.3));
    const sl = Math.hypot(this.sunDir.x, this.sunDir.z) || 1;
    this.sunAz.set(this.sunDir.x / sl, this.sunDir.z / sl);

    const my = this.moonDir.y;
    u.uMoonVis.value = smooth((my + 0.02) / 0.06) * clamp01(1 - w[W.tint]) * clamp01(1.4 - w[W.cover] * 1.4 + 0.12);
    (u.uMoonCol.value as THREE.Color).setRGB(0.93, 0.9, 0.78).multiplyScalar(lerp(0.55, 1.05, dark));
    // 0.42 of the way round at the start (a fat crescent), full a fortnight later.
    const phase = Math.PI * (0.42 + 0.58 * Math.abs(Math.sin(this.day * Math.PI / 28)));
    (u.uMoonL.value as THREE.Vector3).set(Math.sin(phase), 0, -Math.cos(phase));
    u.uStars.value = smooth((dark - 0.55) / 0.45) * clamp01(1 - w[W.tint] * 1.5);

    // ── Fog ──
    // Fog weather swaps the horizon for sea-fog cream (slate at night), leaning
    // a little on whatever the sky is doing so dawn fog is still peach.
    this.fogFlat.lerpColors(FOG_DAY, FOG_NIGHT, dark).lerp(p.hor, 0.3);
    this.horBase.copy(p.hor);
    this.horGlow.copy(p.glow);
    this.glowAmt = p.glowAmt;
    this.fogTint = w[W.tint];
    // 1.4 / drawDist leaves about 14% of the scene at the draw distance on a
    // clear afternoon: enough air to hide the far edge, thin enough that the
    // skyline still has its shape from the breakwater. Mornings are thicker.
    this.fog.density = Math.max(1.4 / q.drawDist * p.fog * w[W.fogMul], w[W.dens]);
    // Through the post pipeline fog is mixed into linear light, before the tone
    // map and the sRGB encode instead of after them, and the same density reads
    // about an eighth thicker on dark walls. Thin it to keep the distances the
    // weather table was tuned for.
    if (g.post?.enabled) this.fog.density *= 0.88;
    // Higher up there is less air between the eye and the horizon: from 4 m to 60 m up the haze thins by a third, so the far end of
    // the island and the college spire stay readable from the bridge and the heights (the cap on fog_fragment below does the rest).
    this.fog.density *= 1 - 0.34 * smooth((g.camera.position.y - 4) / 56);
    this.exposure = p.exposure;
    this.faceFog(g.camera);

    // ── Lights ──
    // One key light does both jobs. Each fades to nothing before the other
    // starts, so the direction can jump while nobody can see it.
    const sunI = p.sunI * smooth((sy + 0.04) / 0.14) * w[W.sun];
    const moonI = MOON_I * smooth((my - 0.02) / 0.14) * smooth((-0.06 - sy) / 0.1) * lerp(w[W.sun], 1, 0.45);
    const L = this.lightDir;
    if (sunI >= moonI) {
      L.copy(this.sunDir);
      this.sun.color.copy(p.sun);
      this.sun.intensity = sunI;
    } else {
      L.copy(this.moonDir);
      this.sun.color.copy(MOON_LIGHT);
      this.sun.intensity = moonI;
    }
    if (L.y < MIN_LIGHT_Y) {
      const s = Math.sqrt(1 - MIN_LIGHT_Y * MIN_LIGHT_Y) / (Math.hypot(L.x, L.z) || 1);
      L.set(L.x * s, MIN_LIGHT_Y, L.z * s);
    }
    this.hemi.color.copy(p.hemiSky);
    this.hemi.groundColor.copy(p.hemiGnd);
    this.hemi.intensity = p.hemiI * w[W.amb];
    this.placeShadowBox();

    g.renderer.toneMappingExposure = p.exposure;

    // ── Rain and puddles ──
    const rain = w[W.rain];
    this.rain.visible = rain > 0.01;
    if (this.rain.visible) {
      const fall = this.rainU.uFall.value as THREE.Vector3, o = this.rainOff;
      // Wrap at ten boxes: every streak speed is a whole number of tenths, so all of them land where they started.
      o.x = (o.x + fall.x * dt) % (RAIN_BOX.x * 10);
      o.y = (o.y + fall.y * dt) % (RAIN_BOX.y * 10);
      o.z = (o.z + fall.z * dt) % (RAIN_BOX.z * 10);
      this.rainU.uAmount.value = rain;
      // Streaks are a paler cut of the fog, so they read against dark walls and vanish against the sky.
      (this.rainU.uColor.value as THREE.Color).copy(u.uFog.value as THREE.Color).lerp(this.c1.setRGB(0.85, 0.88, 0.86), 0.35)
        .multiplyScalar(lerp(1.5, 2.6, dark));
    }
    if (rain > 0.02) this._wet = Math.min(1, this._wet + dt * rain / 25);
    else this._wet = Math.max(0, this._wet - dt / lerp(240, 110, clamp01(sunI / 3)));

    // ── Reflections ──
    (u.uGround.value as THREE.Color).copy(WET_GROUND)
      .multiplyScalar((sunI * Math.max(L.y, 0.2) * 0.3 + this.hemi.intensity * 0.3))
      .multiply(this.c1.copy(p.hemiSky).lerp(p.sun, clamp01(sunI / 3) * 0.6));
    this.refreshEnv();
  }

  /** Fog colour for the way `camera` is facing; also the colour of the dome's horizon band. */
  private faceFog(camera: THREE.Camera): void {
    const e = camera.matrixWorld.elements;
    const fx = -e[8], fz = -e[10], l = Math.hypot(fx, fz);
    // Looking straight down there is no "way": keep the last one.
    if (l > 0.05) this.viewAz.set(fx / l, fz / l);
    const toSun = 0.5 + 0.5 * (this.viewAz.x * this.sunAz.x + this.viewAz.y * this.sunAz.y);
    const c = this.uniforms.uFog.value as THREE.Color;
    c.lerpColors(this.horBase, this.horGlow, this.glowAmt * toSun * toSun * toSun).lerp(this.fogFlat, this.fogTint);
    // Through the post pipeline nothing is tone mapped until the composite, fog
    // included, so there the fog wants the dome's raw colour and the two are
    // mapped together.
    this.fog.color.copy(c);
    if (!this.game.post?.enabled) toneMap(this.fog.color, this.exposure);
  }

  /**
   * The quality governor's shadow lever (core/governor.ts): the map's edge in texels and the share of the full
   * 130 m box it covers. A new size frees the old map and three makes the next one at the following shadow pass
   * (one reallocation); a new reach only moves the shadow camera's planes. Nothing is recompiled either way.
   */
  setShadowDetail(size: number, reach = 1): void {
    if (!this.sun.castShadow) return;
    const s = this.sun.shadow, box = SHADOW_BOX * reach, half = box / 2;
    if (s.mapSize.x !== size) {
      s.mapSize.set(size, size);
      s.map?.dispose();
      s.map = null;
    }
    this.shadowBox = box;
    s.camera.left = -half; s.camera.right = half; s.camera.top = half; s.camera.bottom = -half;
    s.camera.updateProjectionMatrix();
    s.normalBias = box / size * 1.6;
  }

  /** Centre the shadow box on the action and snap it to whole shadow texels, so edges do not crawl as the camera moves. */
  private placeShadowBox(): void {
    const g = this.game, L = this.lightDir, c = this.v1;
    const cam = g.cam as CameraApi | undefined;
    if (g.view) c.copy(g.view.target);
    else if (cam) {
      // Nudged forward: the camera sits behind the focus looking past it, so that is where the screen is.
      const e = g.camera.matrixWorld.elements, l = Math.hypot(e[8], e[10]) || 1;
      c.copy(cam.focus);
      c.x -= e[8] / l * this.shadowBox * 0.22;
      c.z -= e[10] / l * this.shadowBox * 0.22;
    } else c.copy(g.camera.position);

    if (this.sun.castShadow) {
      // The shadow camera's own axes: right and up across the map, L along its depth.
      const right = this.v2.set(L.z, 0, -L.x).normalize();
      const up = this.v3.crossVectors(L, right);
      const texel = this.shadowBox / this.sun.shadow.mapSize.x;
      const x = Math.round(c.dot(right) / texel) * texel;
      const y = Math.round(c.dot(up) / texel) * texel;
      const z = c.dot(L);
      c.set(right.x * x + up.x * y + L.x * z, right.y * x + up.y * y + L.y * z, right.z * x + up.z * y + L.z * z);
    }
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(L, SHADOW_DIST);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  /** Re-render the reflection cube, but only once the sky has visibly moved on, and never more than every few seconds. */
  private refreshEnv(): void {
    const u = this.uniforms, s = this.sig, e = this.envSig;
    const zen = u.uZen.value as THREE.Color, hor = u.uHor.value as THREE.Color, gnd = u.uGround.value as THREE.Color;
    const cl = u.uCloudLit.value as THREE.Color;
    s[0] = zen.r; s[1] = zen.g; s[2] = zen.b; s[3] = hor.r; s[4] = hor.g; s[5] = hor.b;
    s[6] = gnd.r; s[7] = gnd.g; s[8] = gnd.b; s[9] = cl.r; s[10] = cl.g; s[11] = cl.b;
    s[12] = (u.uCover.value as number) * 0.5; s[13] = this.sunDir.x * 0.2; s[14] = this.sunDir.y * 0.2;
    s[15] = Math.min(1, (u.uHaze.value as number)) * 0.5;
    let d = 0;
    for (let i = 0; i < s.length; i++) d += Math.abs(s[i] - e[i]);
    const now = performance.now();
    // A jump (a test or a cheat set the clock) cannot wait; a drift can.
    if (!this.envForce && !(d > 0.5) && !(d > 0.03 && now - this.envAt > 3000)) return;
    this.envForce = false;
    this.envAt = now;
    e.set(s);

    const g = this.game, r = g.renderer;
    // Mirrors do not want the fog band of whichever way the camera happens to face.
    (u.uFog.value as THREE.Color).copy(this.horBase).lerp(this.fogFlat, this.fogTint);
    // The cube is what shaded surfaces take as ambient. A sky blue with almost no red in it (zenith 0x4f9ccd) gave shaded road and
    // pavement a teal cast (about 50,82,97 in shade at noon, now about 62,81,88); mirrors and shade want the sky's brightness with less of its dye, so the
    // cube sees the same sky pulled 85% toward its own grey by day. Brightness is kept, so the shadows stay as deep as they were.
    const dye = 0.85 * (1 - this._night), keep = this.envKeep;
    const cols = [u.uZen.value, u.uMid.value, u.uHor.value] as THREE.Color[];
    for (let i = 0; i < 3; i++) {
      const c = cols[i], l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      keep[i].copy(c);
      c.r += (l - c.r) * dye; c.g += (l - c.g) * dye; c.b += (l - c.b) * dye;
    }
    this.envCam.update(r, this.envScene);
    for (let i = 0; i < 3; i++) cols[i].copy(keep[i]);
    this.envRT = this.pmrem.fromCubemap(this.envCube.texture, this.envRT);
    g.scene.environment = this.envRT.texture;
    this.faceFog(g.camera);
  }
}
