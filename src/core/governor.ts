// Quality that chooses itself (milestone 6, section 3). Two halves:
//
// THE STARTING PRESET (pickQuality). `?q=low|medium|high` wins and switches the
// governor off; then a preset the player picked in the menu, the same; otherwise
// Auto. Auto reads what the browser will say for nothing (a finger for a pointer,
// the screen's size, device memory, core count, pixel ratio), and on the first
// visit times a small synthetic frame for about a fifth of a second on a canvas
// that is never attached to the page: a lit, textured, three-deep surface into
// a half-float target, then a twelve-tap composite, read back so the time is the
// GPU's. The score is kept in localStorage with the GPU's name, so it runs once
// per machine. A preset decides how the world is BUILT (density, materials,
// models), so it cannot change without a reload: everything after this is the
// governor's.
//
// THE GOVERNOR. It watches the real loop's frame intervals in one-second
// buckets and judges each by its mean with the worst twentieth of frames left
// out, and by the share of frames that ran long, so one bad frame (a model arriving, a level-of-detail swap, the
// reflection cube's six frames) never counts. Three slow seconds in a row (two
// if very slow) and it takes one step down the ladder:
//
//   pixel ratio, a tenth at a time, to a floor
//   the shadow map at half its edge (a shorter shadow reach was measured too: it bought nothing, so it is not a step)
//   ambient occlusion off
//   FXAA alone instead of a multisampled scene target
//   the next preset down: a note for the next load, and one more notch of pixels now
//
// It climbs back the same way, never above the full preset it started from: at
// once when frames show real room (a fifth under the budget for five seconds,
// which only an unpaced loop or a fast display can show), and otherwise by trying
// one step after twelve smooth seconds. A try that has to be taken back within
// half a minute doubles the wait for that step (to five minutes), so it cannot
// swing. The budget is 60 frames a second whatever the display's rate. If three
// steps down buy nothing, the limit is not the picture (a display held at 30, a
// processor that cannot keep up): it goes back to where it began and accepts the
// rate it has. It is deaf for the first seconds after load and after the title
// card, after a resize, and when the tab comes back.
//
// What a change costs (measured, scratch/m6/notes-governor-nov20.txt): a pixel
// ratio step and the antialiasing switch rebuild the scene target; the shadow
// map's size rebuilds the map; occlusion is free. None costs more than one or two frames.

import type { Quality } from './api';
import type { Game } from './game';
import { readGfx, savedQuality, writeGfx, type GfxNote, type QualityPick } from '../game/save';

type Name = Quality['name'];
const ORDER: Name[] = ['low', 'medium', 'high'];

export const PRESETS: Record<Name, Quality> = {
  low: { name: 'low', pixelRatio: 1.5, antialias: false, shadows: false, shadowSize: 1024, drawDist: 520, density: 0.5 },
  medium: { name: 'medium', pixelRatio: 1.5, antialias: true, shadows: true, shadowSize: 2048, drawDist: 800, density: 0.8 },
  high: { name: 'high', pixelRatio: 2, antialias: true, shadows: true, shadowSize: 2048, drawDist: 1100, density: 1 },
};

// ── The starting preset ──────────────────────────────────────────────────────

export interface Hints {
  /** The pointer is a finger and no mouse or trackpad is attached. */
  touch: boolean;
  /** The screen's shorter side and its area, in CSS pixels and millions of them. */
  minScreen: number;
  screenMpx: number;
  windowMpx: number;
  /** GB, where the browser says (Chrome only, and never more than 8). */
  mem: number | null;
  cores: number | null;
  dpr: number;
}

/** A touch screen narrower than this (CSS px, short side) is a phone; at or above it, a tablet or a touch laptop. */
const PHONE_SCREEN = 700;

function readHints(): Hints {
  const mm = (q: string): boolean => { try { return matchMedia(q).matches; } catch { return false; } };
  const nav = navigator as Navigator & { deviceMemory?: number };
  const sw = screen.width || innerWidth, sh = screen.height || innerHeight;
  const minScreen = Math.min(sw, sh);
  return {
    touch: mm('(pointer: coarse)') && (!mm('(any-pointer: fine)') || minScreen < 600),
    minScreen, screenMpx: sw * sh / 1e6, windowMpx: innerWidth * innerHeight / 1e6,
    mem: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    dpr: devicePixelRatio || 1,
  };
}

type GpuClass = 'software' | 'mobile' | 'integrated' | 'discrete' | 'unknown';
export function gpuClass(s: string): GpuClass {
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(s)) return 'software';
  if (/adreno|mali|powervr|videocore|tegra|xclipse|sgx/i.test(s)) return 'mobile';
  if (/nvidia|geforce|quadro|rtx|gtx|radeon\s*(\(tm\))?\s*(rx|pro)|arc\s*(\(tm\))?\s*[ab]\d|apple m\d/i.test(s)) return 'discrete';
  if (/intel|iris|uhd|hd graphics|radeon|vega/i.test(s)) return 'integrated';
  return 'unknown';
}

export function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; }
}

// Big enough that the GPU's work, not the round trip to it, is what gets timed: at 1280 x 720 and three layers a frame
// was 2.3 ms on the reference laptop and read anywhere from 2.3 to 5.6.
const BENCH_W = 1920, BENCH_H = 1080, BENCH_LAYERS = 4;
/**
 * The benchmark's score on the machine the presets were tuned on (Iris Xe, ANGLE/D3D11), ms: 4.0 to 5.0 there in
 * fifteen runs, 4.1 to 5.0 at boot (scratch/m6/benchnoise.mjs), and once 7.4 straight after other pages had closed.
 * A machine's frame is predicted as that machine's score over this, times the model below.
 */
const REF_SCORE = 4.5;
/** The real loop on that machine, downtown: ms that do not depend on the pixel count, and ms per million pixels. */
const MODEL: Record<Name, [number, number]> = { high: [7.5, 3.7], medium: [6, 2.6], low: [4, 1.2] };
const BUDGET = 1000 / 60;

export interface BenchResult { score: number; /** The quickest and the middle frame, for judging the measurement itself. */ best: number; median: number; frames: number; took: number; gpu: string }

/** Time a small representative frame on a canvas nobody sees. Null if WebGL 2 will not start: the hints decide alone. */
export function benchmark(): BenchResult | null {
  const t0 = performance.now();
  const c = document.createElement('canvas');
  c.width = BENCH_W; c.height = BENCH_H;
  let gl: WebGL2RenderingContext | null = null;
  try { gl = c.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' }); } catch { gl = null; }
  if (!gl) return null;
  const g = gl;
  try {
    const gpu = gpuName(g);
    const half = !!g.getExtension('EXT_color_buffer_float') || !!g.getExtension('EXT_color_buffer_half_float');
    const program = (vs: string, fs: string): WebGLProgram => {
      const p = g.createProgram()!;
      for (const [type, src] of [[g.VERTEX_SHADER, vs], [g.FRAGMENT_SHADER, fs]] as [number, string][]) {
        const s = g.createShader(type)!;
        g.shaderSource(s, '#version 300 es\nprecision highp float;\n' + src);
        g.compileShader(s);
        g.attachShader(p, s);
      }
      g.bindAttribLocation(p, 0, 'p');
      g.linkProgram(p);
      if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error('benchmark shader: ' + g.getProgramInfoLog(p));
      return p;
    };
    // A surface with a base colour, a normal map, GGX highlights, a nine-tap soft shadow and fog: what a street costs per pixel.
    const scene = program(`
in vec2 p; uniform float uLayer; out vec2 vUv; out vec3 vPos;
void main() { vUv = p; vec2 q = p * 2.0 - 1.0; float h = sin(p.x * 37.0 + uLayer) * cos(p.y * 29.0) * 0.02;
  vPos = vec3(q * 40.0, h); gl_Position = vec4(q.x, q.y + h, 0.5, 1.0); }`, `
uniform sampler2D tNoise; uniform float uLayer; in vec2 vUv; in vec3 vPos; out vec4 o;
void main() {
  vec2 uv = vUv * 8.0 + uLayer * 0.37;
  vec3 a = texture(tNoise, uv).rgb;
  vec3 n = normalize(vec3(texture(tNoise, uv * 2.1).rg - 0.5, 1.0));
  float rough = 0.3 + 0.6 * texture(tNoise, uv * 0.5).b;
  vec3 L = normalize(vec3(0.4, 0.5, 0.75)), V = normalize(vec3(-vPos.xy * 0.01, 1.0)), H = normalize(L + V);
  float nl = max(dot(n, L), 0.0), nh = max(dot(n, H), 0.0), nv = max(dot(n, V), 1e-3);
  float a2 = rough * rough * rough * rough, d = nh * nh * (a2 - 1.0) + 1.0, D = a2 / (3.14159 * d * d);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0, G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  vec3 F = vec3(0.04) + 0.96 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float sh = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) sh += step(0.35, texture(tNoise, vUv * 3.0 + vec2(x, y) / 256.0 + uLayer).a);
  vec3 c = (a / 3.14159 + D * G * F / (4.0 * nv + 1e-3)) * nl * (0.3 + 0.7 * sh / 9.0) * 3.0 + a * 0.25;
  o = vec4(mix(vec3(0.6, 0.7, 0.8), c, exp(-dot(vPos.xy, vPos.xy) * 0.0004)), 1.0);
}`);
    const post = program(`
in vec2 p; out vec2 vUv;
void main() { vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`, `
uniform sampler2D tScene; in vec2 vUv; out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 12; i++) { float a = float(i) * 2.4; c += texture(tScene, vUv + vec2(cos(a), sin(a)) * 0.004 * float(i + 1) / 12.0).rgb; }
  c /= 12.0; c = c / (1.0 + c);
  o = vec4(pow(c, vec3(0.4545)), 1.0);
}`);
    // A 160 x 160 grid, drawn four deep: 200 thousand triangles.
    const N = 160, verts = new Float32Array((N + 1) * (N + 1) * 2), idx = new Uint16Array(N * N * 6);
    for (let y = 0, i = 0; y <= N; y++) for (let x = 0; x <= N; x++) { verts[i++] = x / N; verts[i++] = y / N; }
    for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const a = y * (N + 1) + x, b = a + 1, d = a + N + 1, e = d + 1;
      idx[i++] = a; idx[i++] = b; idx[i++] = d; idx[i++] = b; idx[i++] = e; idx[i++] = d;
    }
    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ARRAY_BUFFER, verts, g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, idx, g.STATIC_DRAW);

    const noise = new Uint8Array(256 * 256 * 4);
    let seed = 1234567;
    for (let i = 0; i < noise.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise[i] = seed >>> 24; }
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, g.createTexture());
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 256, 256, 0, g.RGBA, g.UNSIGNED_BYTE, noise);
    g.generateMipmap(g.TEXTURE_2D);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);

    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, g.createTexture());
    const fbo = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    const target = (float: boolean): boolean => {
      g.texImage2D(g.TEXTURE_2D, 0, float ? g.RGBA16F : g.RGBA8, BENCH_W, BENCH_H, 0, g.RGBA, float ? g.HALF_FLOAT : g.UNSIGNED_BYTE, null);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, g.getParameter(g.TEXTURE_BINDING_2D) as WebGLTexture, 0);
      return g.checkFramebufferStatus(g.FRAMEBUFFER) === g.FRAMEBUFFER_COMPLETE;
    };
    if (!(half && target(true)) && !target(false)) throw new Error('benchmark target');

    g.useProgram(scene);
    g.uniform1i(g.getUniformLocation(scene, 'tNoise'), 0);
    const uLayer = g.getUniformLocation(scene, 'uLayer');
    g.useProgram(post);
    g.uniform1i(g.getUniformLocation(post, 'tScene'), 1);
    g.viewport(0, 0, BENCH_W, BENCH_H);
    g.disable(g.DEPTH_TEST);
    const px = new Uint8Array(4);
    const frame = (): void => {
      g.bindFramebuffer(g.FRAMEBUFFER, fbo);
      g.useProgram(scene);
      for (let l = 0; l < BENCH_LAYERS; l++) { g.uniform1f(uLayer, l); g.drawElements(g.TRIANGLES, idx.length, g.UNSIGNED_SHORT, 0); }
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.useProgram(post);
      g.drawElements(g.TRIANGLES, idx.length, g.UNSIGNED_SHORT, 0);
      // Reading one pixel back is the only wait every browser honours.
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    };
    frame(); frame(); // the first two pay for compiling and for first use
    const times: number[] = [], tb = performance.now();
    while (times.length < 80 && (performance.now() - tb < 150 || times.length < 3)) {
      const a = performance.now();
      frame();
      times.push(performance.now() - a);
      if (times[times.length - 1] > 120) break;
    }
    // The lower quartile: whatever else the machine was doing can only have added time.
    times.sort((a, b) => a - b);
    return { score: Math.max(0.05, times[times.length >> 2]), best: times[0], median: times[times.length >> 1], frames: times.length, took: performance.now() - t0, gpu };
  } catch {
    return null;
  } finally {
    g.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export interface QualityChoice {
  quality: Quality;
  /** Auto is in charge: the governor runs. */
  auto: boolean;
  /** `?q=` said so; the menu's setting waits for a load without it. */
  forced: boolean;
  /** Ratio notches to start below the full preset, from the prediction. */
  notch: number;
  why: string;
  gpu: string;
  score: number | null;
  /** How long the benchmark held the page this load, ms: 0 when it did not run. */
  benchMs: number;
  hints: Hints;
}

/** The ratio notches a session may use: tenths of the preset's ratio, to a floor that depends on how dense the screen is. */
function ratioNotches(q: Quality, dpr: number): number[] {
  const r0 = Math.min(dpr, q.pixelRatio);
  if (q.name === 'low') return r0 >= 1.25 ? [0.9, 0.8, 0.7, 0.6, 0.5] : [0.9, 0.8, 0.7];
  return r0 >= 1.25 ? [0.9, 0.8, 0.7, 0.6] : [0.9, 0.8];
}

function predict(name: Name, mpx: number, rel: number): number {
  return (MODEL[name][0] + MODEL[name][1] * mpx) * rel;
}

function decide(h: Hints, gpu: string, score: number | null, cap: Name | undefined): { name: Name; notch: number; why: string } {
  const cls = gpuClass(gpu);
  const desktopClass = (cls === 'integrated' || cls === 'discrete') && h.minScreen >= 700 && (h.mem === null || h.mem >= 8);
  if (h.touch && !desktopClass) return { name: 'low', notch: 0, why: `a touch screen ${Math.round(h.minScreen)} px on its short side: the phone preset` };
  if (cls === 'software') return { name: 'low', notch: 0, why: `no graphics hardware (${gpu})` };
  if ((h.mem !== null && h.mem <= 2) || (h.cores !== null && h.cores <= 2)) return { name: 'low', notch: 0, why: `${h.mem ?? '?'} GB of memory, ${h.cores ?? '?'} cores` };
  let top: Name = 'high', limit = '';
  // (Touch alone keeps an integrated GPU off high, not a graphics card: a touch laptop such as a Surface with an RTX 4050 says
  // pointer: coarse and no fine pointer at all, QA Nov 23.)
  if ((h.mem !== null && h.mem <= 4) || (h.cores !== null && h.cores <= 4 && cls !== 'discrete') || (h.touch && cls !== 'discrete')) { top = 'medium'; limit = `; ${h.mem ?? '?'} GB, ${h.cores ?? '?'} cores${h.touch ? ', touch' : ''} keep it off high`; }
  if (cap && ORDER.indexOf(cap) < ORDER.indexOf(top)) { top = cap; limit = `; it could not hold ${ORDER[ORDER.indexOf(cap) + 1]} last time`; }
  if (score === null) {
    // No measurement: a named graphics card gets the benefit of the doubt, anything else the middle.
    const name: Name = cls === 'discrete' ? top : ORDER[Math.min(ORDER.indexOf(top), 1)];
    return { name, notch: 0, why: `not measured (${gpu || 'GPU unnamed'})${limit}` };
  }
  const rel = Math.max(0.15, score / REF_SCORE);
  for (let i = ORDER.indexOf(top); i >= 1; i--) {
    const name = ORDER[i], q = PRESETS[name], r0 = Math.min(h.dpr, q.pixelRatio);
    // The preset is for the whole visit, so it is judged at full screen, and by what the governor could make of it:
    // `high` has to fit with a fifth of the pixels and the cheap levers given up, `medium` at the foot of its ladder.
    // Generous on purpose. The benchmark has read two thirds too slow on a busy machine (see REF_SCORE); a preset that proves too heavy is eased by the governor within half a minute and replaced at the next
    // load, while nothing but one second measurement corrects a preset that is too light.
    const eased = name === 'high' ? predict(name, h.screenMpx * r0 * r0 * 0.64, rel) * 0.86 : predict(name, h.screenMpx * r0 * r0 * 0.49, rel) * 0.75;
    if (eased > BUDGET) continue;
    const scales = [1, ...ratioNotches(q, h.dpr)];
    let notch = 0;
    // Pixels are given up at the start only where the prediction is well over (a dense screen): the measurement is
    // good to a tenth or so, and a frame that is a little long is the governor's to find within seconds.
    while (notch < scales.length - 1 && predict(name, h.windowMpx * (r0 * scales[notch]) ** 2, rel) > BUDGET * 1.15) notch++;
    const now = predict(name, h.windowMpx * (r0 * scales[notch]) ** 2, rel);
    return { name, notch, why: `benchmark ${score.toFixed(1)} ms (reference ${REF_SCORE}): about ${now.toFixed(0)} ms a frame at ${name}${notch ? `, ${Math.round(scales[notch] * 100)}% pixels` : ''}${limit}` };
  }
  return { name: 'low', notch: 0, why: `benchmark ${score.toFixed(1)} ms (reference ${REF_SCORE}): too slow for medium${limit}` };
}

/** What Auto would run on this machine, if that is already known without measuring: for the menu. */
export function autoPresetIfKnown(): Name | null {
  const note = readGfx(), h = readHints();
  if (!note) { const d = decide(h, '', null, undefined); return h.touch && h.minScreen < PHONE_SCREEN && d.name === 'low' ? 'low' : null; }
  return decide(h, note.gpu, note.score, note.cap).name;
}

/** Called once, before anything is built. */
export function pickQuality(): QualityChoice {
  let asked: string | null = null, rebench = false;
  try { const p = new URLSearchParams(location.search); asked = p.get('q'); rebench = p.has('rebench'); } catch { /* no address */ }
  const hints = readHints();
  const fixed = (name: Name, why: string, forced: boolean): QualityChoice =>
    ({ quality: { ...PRESETS[name] }, auto: false, forced, notch: 0, why, gpu: '', score: null, benchMs: 0, hints });
  if (asked === 'low' || asked === 'medium' || asked === 'high') return fixed(asked, 'the address asks for it (?q=)', true);
  const kept = asked === 'auto' ? null : savedQuality();
  if (kept) return fixed(kept, 'chosen in the menu', false);

  let note = rebench ? null : readGfx(), benchMs = 0;
  const measure = (old: GfxNote | null): GfxNote => {
    const b = benchmark();
    benchMs = b ? b.took : 0;
    const best = b && old && old.score !== null ? Math.min(old.score, b.score) : b ? b.score : old ? old.score : null;
    const n: GfxNote = { gpu: b?.gpu || old?.gpu || '', score: best === null ? null : +best.toFixed(2), n: (old?.n ?? 0) + 1, when: Date.now() };
    if (old?.cap) { n.cap = old.cap; if (old.capAt) n.capAt = old.capAt; }
    writeGfx(n);
    return n;
  };
  // A phone needs no measuring, and a measurement there would only delay it. A touch screen 700 px or more on its short side
  // may be a tablet or a touch laptop (this laptop: a Surface whose Chrome reports no fine pointer, RTX 4050 inside, QA
  // Nov 23): it is measured, and decide() then knows its GPU.
  const quick = decide(hints, note?.gpu ?? '', null, undefined);
  const phone = hints.touch && hints.minScreen < PHONE_SCREEN && quick.name === 'low';
  if (!note && !phone) note = measure(null);
  let d = decide(hints, note?.gpu ?? '', note?.score ?? null, note?.cap);
  // A first measurement that kept the machine off `high` is taken once more on the next visit and the better of
  // the two kept: one busy moment must not mark a machine for good. Never a third time.
  if (note && !phone && benchMs === 0 && note.n === 1 && note.score !== null && !note.cap && d.name !== 'high') {
    note = measure(note);
    d = decide(hints, note.gpu, note.score, note.cap);
  }
  return { quality: { ...PRESETS[d.name] }, auto: true, forced: asked === 'auto', notch: d.notch, why: d.why, gpu: note?.gpu ?? '', score: note?.score ?? null, benchMs, hints };
}

// ── The governor ─────────────────────────────────────────────────────────────

interface Step { name: string; scale: number; shadow: 0 | 1 | 2; ao: boolean; msaa: boolean; demote: boolean }
export interface GovChange { t: number; from: number; to: number; why: string; ms: number; hitch: number }

/** A bucket is slow above this share of the budget, fine below the next, and shows room to spare below the last. */
const SLOW = 1.1, FINE = 1.03, ROOMY = 0.8;
/** A frame is long past this share of the budget; a slow bucket has this share of them, a fine one no more than the second. */
const LONG = 1.3, LONG_SLOW = 0.3, LONG_FINE = 0.15;
/** Smooth seconds before trying a step up with no proof of room; doubled each time the try fails, to the limit. */
const UP_WAIT = 12, UP_WAIT_MAX = 300;
/** Seconds between any two changes, whatever the frames say. */
const DWELL = 3;

export class Governor {
  /** Auto is in charge. Off with `?q=` and with a preset fixed in the menu: then nothing below ever changes. */
  enabled: boolean;
  readonly forced: boolean;
  /** Where on the ladder the picture is now: 0 is the full preset. */
  step = 0;
  readonly steps: Step[] = [];
  /** Why it last changed, or why it is holding. */
  reason: string;
  readonly log: GovChange[] = [];
  /** The last full second: the mean frame without its worst twentieth, the share of long frames, and the budget they were judged against (ms). */
  ms = 0;
  longShare = 0;
  budget = BUDGET;
  /** Set when stepping down stopped helping: the rate is the display's or the processor's, and is accepted. */
  capped = false;
  /** The preset the next load will use instead, once this one has been found too much. */
  demoted: Name | null = null;
  readonly choice: QualityChoice;
  gpu: string;

  private readonly buf = new Float32Array(400);
  private n = 0;
  private bucketAt = 0;
  private last = 0;
  private quietUntil = 0;
  private skip = 0;
  private slowRun = 0;
  private okRun = 0;
  private roomRun = 0;
  private changedAt = -1e9;
  private readonly upWait: number[];
  private climbedAt = -1e9;
  private climbedFrom = -1;
  private descent: { from: number; ms: number }[] = [];
  private capUntil = 0;
  private capHold = 60;
  private watch = 0;
  private applied = { shadow: 0, ao: true, msaa: true };

  constructor(private game: Game, choice: QualityChoice) {
    this.choice = choice;
    this.enabled = choice.auto;
    this.forced = choice.forced || (!choice.auto && choice.why.includes('?q='));
    this.reason = choice.why;
    const q = game.quality, post = game.post;
    const full: Step = { name: 'full ' + q.name, scale: 1, shadow: 0, ao: true, msaa: true, demote: false };
    this.steps.push(full);
    let s = full;
    const add = (name: string, d: Partial<Step>): void => { s = { ...s, ...d, name }; this.steps.push(s); };
    const notches = ratioNotches(q, devicePixelRatio || 1);
    for (const k of notches) add(`pixels ${Math.round(k * 100)}%`, { scale: k });
    // Only the map's size: pulling the shadow box in to 70% as well measured 10.3 ms against 10.2 (scratch/m6/gov-levers-high.txt).
    if (q.shadows) add(`shadow map ${q.shadowSize / 2}`, { shadow: 1 });
    if (post) add('occlusion off', { ao: false });
    if (post && post.baseSamples > 0) add('FXAA alone', { msaa: false });
    if (q.name !== 'low') add(`${ORDER[ORDER.indexOf(q.name) - 1]} next load, pixels ${Math.round((s.scale - 0.1) * 100)}%`, { scale: s.scale - 0.1, demote: true });
    this.upWait = this.steps.map(() => UP_WAIT);
    this.step = Math.min(choice.auto ? choice.notch : 0, notches.length);
    if (this.step > 0) this.reason = `${choice.why}; started at ${this.steps[this.step].name}`;

    // The cached measurement belongs to one GPU: on another (a dock, a copied profile) it is thrown away for the next load.
    this.gpu = gpuName(game.renderer.getContext());
    const note = readGfx();
    if (note && this.gpu) {
      if (!note.gpu) writeGfx({ ...note, gpu: this.gpu });
      else if (note.gpu !== this.gpu) writeGfx(null);
    }

    const quiet = (ms: number) => (): void => { this.quietUntil = Math.max(this.quietUntil, performance.now() + ms); };
    addEventListener('resize', quiet(1500));
    addEventListener('focus', quiet(1500));
    document.addEventListener('visibilitychange', quiet(1500));
    game.on('start', quiet(2500));
    game.on('pause', quiet(1500));
  }

  /** The loop is about to start: nothing is judged for the first seconds, while models are still arriving. */
  begin(): void {
    this.quietUntil = Math.max(this.quietUntil, performance.now() + 4000);
  }

  /** Once per real frame, before it is simulated and drawn, with requestAnimationFrame's own clock. */
  frame(now: number): void {
    const dt = now - this.last;
    this.last = now;
    if (this.watch > 0) {
      this.watch--;
      const e = this.log[this.log.length - 1];
      if (e && dt > e.hitch && dt < 5000) e.hitch = +dt.toFixed(1);
    }
    const g = this.game;
    if (!this.enabled || g.frozen || g.state === 'paused' || g.state === 'loading' || document.hidden || now < this.quietUntil) { this.n = 0; this.bucketAt = now; return; }
    // A gap this long is the tab coming back or the debugger, not the picture.
    if (dt > 250 || dt <= 0) { this.n = 0; this.bucketAt = now; this.quietUntil = now + 1000; return; }
    if (this.n < this.buf.length) this.buf[this.n++] = dt;
    if (now - this.bucketAt >= 1000 && this.n >= 8) this.judge(now);
  }

  private judge(now: number): void {
    // The mean with the worst twentieth left out. Not the mean: on a real display every interval is a whole number
    // of refreshes, so a 12 ms frame on a 120 Hz screen is a mix of 8.3s and 16.7s and its mean is one or the other.
    const a = this.buf.subarray(0, this.n).slice().sort(), n = a.length, keep = Math.max(1, n - Math.max(1, Math.round(n * 0.05)));
    let mean = 0;
    for (let i = 0; i < keep; i++) mean += a[i];
    mean /= keep;
    let long = 0;
    for (let i = 0; i < n; i++) if (a[i] > this.budget * LONG) long++;
    this.n = 0; this.bucketAt = now;
    this.ms = +mean.toFixed(2);
    this.longShare = +(long / n).toFixed(3);
    // The second after a change holds the change's own hitch.
    if (this.skip > 0) { this.skip--; return; }

    // An accepted slower rate is given up as soon as frames show they can beat it.
    if (this.capped && now > this.capUntil && mean < this.budget * ROOMY) {
      this.capped = false; this.budget = BUDGET;
      this.reason = `frames at ${mean.toFixed(1)} ms: the limit has lifted`;
    }
    const b = this.budget;
    const slow = mean > b * SLOW || long / n > LONG_SLOW;
    const fine = !slow && mean <= b * FINE && long / n <= LONG_FINE;
    if (slow) { this.slowRun++; this.okRun = 0; this.roomRun = 0; }
    else {
      this.slowRun = 0;
      if (fine) { this.okRun++; this.roomRun = mean <= b * ROOMY ? this.roomRun + 1 : 0; }
      else { this.okRun = Math.max(0, this.okRun - 2); this.roomRun = 0; }
      if (this.okRun >= 10) this.descent.length = 0;
    }
    // A step up that has lasted half a minute was right: its wait goes back to normal.
    if (this.climbedFrom >= 0 && now - this.climbedAt > 30000) { this.upWait[this.climbedFrom] = UP_WAIT; this.climbedFrom = -1; }
    // The note that starts the next load a preset lower is lifted when the machine shows it was not needed: back at full on the preset
    // it was lowered from (this session), or a full minute of room to spare on the capped preset itself (a later session).
    if (this.step === 0 && this.roomRun >= (this.demoted ? 30 : 60)) {
      const note = readGfx();
      if (note?.cap && (this.demoted || this.game.quality.name === note.cap)) {
        const { cap: _c, capAt: _a, ...rest } = note;
        writeGfx(rest);
        this.demoted = null;
        this.reason = `${mean.toFixed(1)} ms a frame with room to spare: the note to start lower is cleared`;
      }
    }
    if (now - this.changedAt < DWELL * 1000) return;

    if (this.slowRun >= (mean > b * 1.6 ? 2 : 3)) this.down(now, mean);
    else if (this.step > 0 && (this.roomRun >= Math.max(5, this.upWait[this.step] / 4) || this.okRun >= this.upWait[this.step])) {
      const room = this.okRun < this.upWait[this.step];
      this.climbedAt = now; this.climbedFrom = this.step;
      this.descent.length = 0;
      this.set(this.step - 1, now, mean, room ? `${mean.toFixed(1)} ms a frame: room to spare` : `smooth for ${this.okRun} s: trying a step up`);
    }
  }

  private down(now: number, mean: number): void {
    const d = this.descent;
    // Three steps down and the frame is no shorter: quality is not what is slow.
    if (d.length >= 3 && mean >= d[d.length - 3].ms * 0.95) {
      const back = d[0].from;
      d.length = 0;
      this.capped = true;
      this.budget = Math.max(BUDGET, mean * 1.1);
      this.capUntil = now + this.capHold * 1000;
      this.capHold = Math.min(this.capHold * 2, 600);
      this.set(back, now, mean, `three steps down bought nothing (${mean.toFixed(1)} ms): the display or the processor is the limit, not the picture`);
      return;
    }
    if (this.step >= this.steps.length - 1) { this.reason = `at the last step and still ${mean.toFixed(1)} ms a frame`; this.slowRun = 0; return; }
    // Back down from a step it had only just tried: wait twice as long before trying that one again.
    if (this.climbedFrom === this.step + 1 && now - this.climbedAt < 30000) {
      this.upWait[this.climbedFrom] = Math.min(this.upWait[this.climbedFrom] * 2, UP_WAIT_MAX);
      this.climbedFrom = -1;
    }
    d.push({ from: this.step, ms: mean });
    this.set(this.step + 1, now, mean, `${mean.toFixed(1)} ms a frame, ${Math.round(this.longShare * 100)}% long, for ${this.slowRun} s`);
  }

  private set(step: number, now: number, mean: number, why: string): void {
    const from = this.step;
    this.step = Math.max(0, Math.min(this.steps.length - 1, step));
    this.reason = why;
    this.changedAt = now;
    this.skip = 1; this.slowRun = 0; this.okRun = 0; this.roomRun = 0;
    this.log.push({ t: +(now / 1000).toFixed(1), from, to: this.step, why, ms: +mean.toFixed(1), hitch: 0 });
    if (this.log.length > 200) this.log.shift();
    this.watch = 4;
    this.apply();
    const s = this.steps[this.step];
    if (s.demote && !this.demoted) {
      const g = this.game.quality.name;
      const cap = g === 'high' ? 'medium' : 'low';
      this.demoted = cap;
      const note = readGfx();
      if (note) writeGfx({ ...note, cap, capAt: Date.now() });
    }
  }

  /** Make the picture match the current step. Safe to call at any time: it only touches what differs. */
  apply(): void {
    const g = this.game, s = this.steps[this.step], q = g.quality, a = this.applied;
    g.setRatioScale(s.scale);
    if (g.sky && q.shadows && a.shadow !== s.shadow) {
      a.shadow = s.shadow;
      g.sky.setShadowDetail(s.shadow === 0 ? q.shadowSize : q.shadowSize / 2, s.shadow === 2 ? 0.7 : 1);
    }
    const post = g.post;
    if (post) {
      if (a.ao !== s.ao) { a.ao = s.ao; post.aoOn = s.ao; }
      if (a.msaa !== s.msaa) { a.msaa = s.msaa; if (s.msaa) post.setAA(post.baseSamples, post.baseFxaa); else post.setAA(0, true); }
    }
  }

  /** Tests: go straight to a step, with the governor's own judgement left as it is. */
  force(step: number): void {
    this.set(step, performance.now(), this.ms, 'forced by a test');
  }

  /** The menu's quality setting changed. Auto and a fixed preset swap at once; a different preset still needs a reload. */
  setPick(pick: QualityPick): void {
    if (this.forced) return;
    const on = pick === 'auto';
    if (on === this.enabled) return;
    this.enabled = on;
    this.n = 0; this.slowRun = 0; this.okRun = 0; this.roomRun = 0;
    this.quietUntil = performance.now() + 2000;
    if (!on && this.step !== 0) this.set(0, performance.now(), this.ms, 'a fixed preset was chosen in the menu');
    else this.reason = on ? 'Auto chosen in the menu' : 'a fixed preset was chosen in the menu';
  }

  /** One line for the menu and the `?debug` readout. */
  line(): string {
    const s = this.steps[this.step];
    const at = this.step === 0 ? s.name : `step ${this.step} of ${this.steps.length - 1}, ${s.name}`;
    const rate = this.ms ? ` · ${this.ms.toFixed(1)} ms, ${Math.round(this.longShare * 100)}% long` : '';
    return `${this.enabled ? 'auto' : 'fixed'} ${this.game.quality.name} · ${at}${rate}${this.capped ? ` · holding ${Math.round(1000 / this.budget)} fps` : ''} · ${this.reason}`;
  }

  /** For window.__game.info(). */
  brief(): Record<string, unknown> {
    return {
      enabled: this.enabled, step: this.step, of: this.steps.length - 1, name: this.steps[this.step].name,
      ratio: +this.game.renderer.getPixelRatio().toFixed(3), reason: this.reason, ms: this.ms, long: this.longShare,
      budget: +this.budget.toFixed(2), capped: this.capped, demoted: this.demoted, changes: this.log.length,
    };
  }
}
