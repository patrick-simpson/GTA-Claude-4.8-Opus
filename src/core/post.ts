// The picture after the scene is drawn: ambient occlusion, bloom, one tone map
// and a restrained grade. Hand-rolled so the whole thing is a dozen small
// full-screen draws instead of a stack of stock passes, each of which would
// copy the frame once more.
//
//   scene -> half-float colour + depth (MSAA resolved by the target)
//   depth -> AO at half size -> two depth-aware blur passes
//   colour -> bright pass at half size -> a short mip chain down, then back up
//   colour * AO + bloom -> tone map (the operator and exposure the sky chose)
//          -> sRGB -> contrast, vignette, grain -> canvas
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

interface Tier { ao: number; levels: number; msaa: number }
const TIERS: Record<'medium' | 'high', Tier> = {
  medium: { ao: 6, levels: 3, msaa: 2 },
  high: { ao: 10, levels: 5, msaa: 4 },
};

/** World radius of the occlusion search, meters: kerbs, door recesses, the gap under a car. */
const AO_RADIUS = 1.4;
/** Past this the search is a pixel or two wide and only makes noise, so it fades out. */
const AO_FADE = 150;
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
varying vec2 vUv;
void main() {
  vec2 t = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0
    + (texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(t.x, 0.0)).rgb
     + texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, t.y)).rgb) * 2.0
    + texture2D(tSrc, vUv + t).rgb + texture2D(tSrc, vUv - t).rgb
    + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(c * 0.0625, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
${DEPTH_FN}
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform sampler2D tBloom;
uniform vec2 uHalf;
uniform float uAO;
uniform float uBloom;
uniform float uExposure;
uniform float uFogDensity;
uniform float uGrade;
uniform float uDebug;
varying vec2 vUv;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 col = max(texture2D(tColor, vUv).rgb, 0.0);
  float d = texture2D(tDepth, vUv).x;
  float shown = 1.0;
  if (d < 0.99995) {
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
  /** 1 shows the occlusion alone, 2 the bloom alone. */
  debug = 0;

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

    const depth = new THREE.DepthTexture(2, 2, THREE.UnsignedIntType);
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, samples: q.antialias ? this.tier.msaa : 0,
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
    this.upMat = pass(UP_FRAG, { tSrc: tex(), uTexel: v2() }, { blending: THREE.AdditiveBlending, transparent: true });
    this.compMat = pass(COMPOSITE_FRAG, {
      tColor: tex(this.sceneRT.texture), tDepth: tex(depth), tAO: tex(this.aoA.texture), tBloom: tex(this.mips[0].texture),
      uNearFar: v2(), uHalf: v2(), uAO: num(1), uBloom: num(0), uExposure: num(1), uFogDensity: num(0), uGrade: num(1), uDebug: num(0),
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
    this.draw(this.aoMat, this.aoA);
    const bu = this.blurMat.uniforms, dir = bu.uDir.value as THREE.Vector2;
    bu.tAO.value = this.aoA.texture; dir.set(1 / this.aoA.width, 0);
    this.draw(this.blurMat, this.aoB);
    bu.tAO.value = this.aoB.texture; dir.set(0, 1 / this.aoA.height);
    this.draw(this.blurMat, this.aoA);

    // ── Bloom ──
    // By day only what is brighter than a sunlit white wall may glow; after
    // dark the bar drops so lamps, windows and tail lamps all carry a halo.
    const night = g.sky ? g.sky.night : 0;
    const exposure = r.toneMappingExposure;
    const br = this.brightMat.uniforms;
    br.uExposure.value = exposure;
    br.uThreshold.value = 1.05 - 0.65 * night;
    br.uKnee.value = 0.25;
    const mips = this.mips, n = mips.length;
    this.draw(this.brightMat, mips[0]);
    const du = this.downMat.uniforms, uu = this.upMat.uniforms;
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
    cu.uAO.value = AO_STRENGTH * this.ao;
    cu.uExposure.value = exposure;
    // The chain sums one copy per level, and it was built after exposure while
    // the composite applies exposure again: undo both here.
    cu.uBloom.value = this.bloom * (0.6 + 1.5 * night) / (n * Math.max(exposure, 1e-3));
    cu.uGrade.value = this.grade;
    cu.uDebug.value = this.debug;
    this.draw(this.compMat, null);

    r.autoClear = auto;
  }

  dispose(): void {
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.aoA.dispose();
    this.aoB.dispose();
    for (const m of this.mips) m.dispose();
    for (const m of [this.aoMat, this.blurMat, this.brightMat, this.downMat, this.upMat, this.compMat]) m.dispose();
    this.quad.geometry.dispose();
  }
}
