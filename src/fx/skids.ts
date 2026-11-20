// Rubber on the road. One preallocated mesh of ribbon quads used as a ring:
// while a rear tire is sliding on something hard, each stretch it covers
// becomes one quad that shares its leading edge with the next, so a strip is
// continuous through a curve. A strip starts and ends at zero alpha, so it
// breaks cleanly when the slide stops or the car leaves the ground.
//
// Marks fade over about a minute. Nothing is rebuilt for that: a slice of the
// ring has its alpha rewritten in place each frame, so every segment is
// revisited a few times a second and only that slice is sent to the GPU.

import * as THREE from 'three';
import { flip } from '../core/flip';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { BRIDGE, WATER_Y, groundAt, terrainAt } from '../world/plan';
import { clamp01 } from '../core/util';

const SEGS = 3000;
/** Seconds until a mark is gone. */
const LIFE = 60;
/** Segments re-faded per frame: the whole ring about three times a second at 60 fps. */
const SLICE = 150;
/** Height above the surface; polygonOffset does the rest. */
const LIFT = 0.022;

const VS = /* glsl */ `
attribute vec2 aUA;   // x: 0..1 across the strip, y: alpha
varying vec2 vUA;
varying vec3 vW;
varying float vDist;
void main() {
  vUA = aUA;
  vW = position;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */ `
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 uTint;
varying vec2 vUA;
varying vec3 vW;
varying float vDist;
void main() {
  float u = vUA.x;
  // Soft shoulders, a slightly heavier pair of bands where the tread blocks carry the load, and grain along the road.
  float edge = smoothstep(0.0, 0.28, u) * smoothstep(1.0, 0.72, u);
  float tread = 0.8 + 0.2 * cos(u * 18.85);
  float grain = 0.82 + 0.18 * fract(sin(dot(floor(vW.xz * 9.0), vec2(12.9898, 78.233))) * 43758.5453);
  float a = vUA.y * edge * tread * grain;
  if (a < 0.004) discard;
  float fogF = 1.0 - exp(-fogDensity * fogDensity * vDist * vDist);
  gl_FragColor = vec4(mix(uTint, fogColor, fogF), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** One rear wheel's strip in progress. */
interface Strip {
  on: boolean;
  /** False until the first quad is laid: there is no direction of travel to square the edge to yet. */
  edge: boolean;
  /** Wheel centre at the last edge. */
  cx: number; cz: number;
  /** The last edge: left point, right point. */
  lx: number; ly: number; lz: number; rx: number; ry: number; rz: number;
  a: number;
  /** Last segment written and its birth time, to find it again when the strip ends. */
  seg: number; born: number;
}
const strip = (): Strip => ({ on: false, edge: false, cx: 0, cz: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, a: 0, seg: -1, born: 0 });

export class Skids {
  private readonly pos = new Float32Array(SEGS * 12);
  private readonly ua = new Float32Array(SEGS * 8);
  /** Per segment: alpha when laid at its trailing and leading edge, and when. born 0 = empty. */
  private readonly a0 = new Float32Array(SEGS);
  private readonly a1 = new Float32Array(SEGS);
  private readonly born = new Float32Array(SEGS);
  private readonly aPos: THREE.BufferAttribute;
  private readonly aUA: THREE.BufferAttribute;
  private readonly mesh: THREE.Mesh;
  private readonly cars = new WeakMap<Vehicle, [Strip, Strip]>();
  private head = 0;
  private sweep = 0;
  /** Seconds until the newest mark has faded: the mesh is hidden and the sweep stops when it reaches 0. */
  private liveFor = 0;

  constructor(private game: Game) {
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUA = new THREE.BufferAttribute(this.ua, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aUA', this.aUA);
    flip.geo(geo, 'position'); flip.geo(geo, 'aUA');
    const idx = new Uint16Array(SEGS * 6);
    for (let i = 0; i < SEGS; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
      this.ua[i * 8 + 2] = 1; this.ua[i * 8 + 6] = 1;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTint: { value: new THREE.Color(0.012, 0.012, 0.013) } },
      vertexShader: VS, fragmentShader: FS, fog: true,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // Laid a finger above the road; the offset keeps it from flickering into the surface at a distance.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Over the road and its paint, under every car's blob shadow, glow and smoke.
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    game.scene.add(this.mesh);
  }

  /** Segments currently showing. Walks the ring: for tests, not for every frame. */
  get count(): number { let n = 0; for (let i = 0; i < SEGS; i++) if (this.born[i] > 0) n++; return n; }

  update(dt: number): void {
    if (dt <= 0) return;
    const g = this.game, cam = g.camera.position, list = g.vehicles.list;
    const wet = 1 - 0.5 * g.sky.wet;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const dx = v.x - cam.x, dz = v.z - cam.z;
      let st = this.cars.get(v);
      const v2 = v.vx * v.vx + v.vz * v.vz;
      const sliding = v.onGround && !v.sunk && v.slip > 0.4 && v2 > 9 && v.y > WATER_Y && dx * dx + dz * dz < 40000 && !this.soft(v);
      if (!sliding) {
        if (st) { this.end(st[0]); this.end(st[1]); }
        continue;
      }
      if (!st) { st = [strip(), strip()]; this.cars.set(v, st); }
      const s = Math.sin(v.h), c = Math.cos(v.h), sp = v.spec;
      const rx = v.x - s * sp.wheelbase * 0.5, rz = v.z - c * sp.wheelbase * 0.5, ht = sp.track * 0.5;
      const alpha = 0.78 * clamp01((v.slip - 0.3) * 2.2) * wet;
      // Sparser at speed: a quad every 0.3 m at a crawl, 0.7 m at 45 mph. The ring then holds most of a minute of two-wheel sliding.
      const gap = 0.3 + Math.sqrt(v2) * 0.02;
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? 1 : -1;
        this.lay(st[w], rx - c * ht * side, rz + s * ht * side, v.y, s, c, sp.wheelW, alpha, gap);
      }
    }
    if (this.liveFor > 0) {
      this.liveFor -= dt;
      this.fade();
      if (this.liveFor <= 0) this.mesh.visible = false;
    }
  }

  /** Sand and turf take ruts, not rubber. Same test the physics uses for soft ground. */
  private soft(v: Vehicle): boolean {
    return (v.x < -610 || v.x > 610 || v.z < -440 || v.z > 410)
      && !(v.z < -430 && Math.abs(v.x - BRIDGE.x) <= BRIDGE.hw + 2) && Math.abs(v.y - terrainAt(v.x, v.z)) < 0.05;
  }

  private lay(st: Strip, x: number, z: number, carY: number, sh: number, ch: number, wheelW: number, alpha: number, gap: number): void {
    if (!st.on) { st.on = true; st.edge = false; st.cx = x; st.cz = z; st.seg = -1; return; }
    const dx = x - st.cx, dz = z - st.cz, d2 = dx * dx + dz * dz;
    if (d2 < gap * gap) return;
    // Meters in one frame is a teleport, not a slide.
    if (d2 > 16) { this.end(st); return; }
    const d = Math.sqrt(d2), ux = dx / d, uz = dz / d;
    // A tire sliding sideways paints its whole contact patch; one sliding straight on paints its width.
    const along = Math.abs(ux * sh + uz * ch);
    const hw = 0.55 * (wheelW * along + 0.24 * (1 - along)) + 0.02;
    const px = -uz * hw, pz = ux * hw;
    if (!st.edge) {
      // The strip's first edge, square to the first stretch of travel, at zero alpha so it feathers in.
      st.lx = st.cx + px; st.lz = st.cz + pz; st.ly = this.height(st.lx, st.lz, carY);
      st.rx = st.cx - px; st.rz = st.cz - pz; st.ry = this.height(st.rx, st.rz, carY);
      st.a = 0; st.edge = true;
    }
    const nlx = x + px, nlz = z + pz, nly = this.height(nlx, nlz, carY);
    const nrx = x - px, nrz = z - pz, nry = this.height(nrx, nrz, carY);

    const i = this.head, p = this.pos, o = i * 12;
    this.head = i + 1 === SEGS ? 0 : i + 1;
    p[o] = st.lx; p[o + 1] = st.ly; p[o + 2] = st.lz; p[o + 3] = st.rx; p[o + 4] = st.ry; p[o + 5] = st.rz;
    p[o + 6] = nlx; p[o + 7] = nly; p[o + 8] = nlz; p[o + 9] = nrx; p[o + 10] = nry; p[o + 11] = nrz;
    const t = this.game.time + 1e-3;
    this.a0[i] = st.a; this.a1[i] = alpha; this.born[i] = t;
    this.write(i, 1);
    this.aPos.addUpdateRange(o, 12); this.aPos.needsUpdate = true;

    st.lx = nlx; st.ly = nly; st.lz = nlz; st.rx = nrx; st.ry = nry; st.rz = nrz;
    st.cx = x; st.cz = z; st.a = alpha; st.seg = i; st.born = t;
    this.liveFor = LIFE;
    this.mesh.visible = true;
  }

  /** The surface under a point, unless that is a different level from the one the car is on (under the bridge, beside a deck). */
  private height(x: number, z: number, carY: number): number {
    const gy = groundAt(x, z);
    return (Math.abs(gy - carY) < 0.4 ? gy : carY) + LIFT;
  }

  /** Close a strip: its last quad's leading edge goes to zero so the mark tapers out instead of stopping square. */
  private end(st: Strip): void {
    if (!st.on) return;
    st.on = false; st.edge = false;
    const i = st.seg;
    if (i >= 0 && this.born[i] === st.born) { this.a1[i] = 0; this.write(i, this.strength(i)); }
    st.seg = -1;
  }

  private strength(i: number): number {
    const t = (this.game.time - this.born[i]) / LIFE;
    // Slow at first, as rubber weathers: still three quarters there at half a minute.
    return t >= 1 ? 0 : 1 - t * t;
  }

  private write(i: number, k: number): void {
    const u = this.ua, o = i * 8, a0 = this.a0[i] * k, a1 = this.a1[i] * k;
    u[o + 1] = a0; u[o + 3] = a0; u[o + 5] = a1; u[o + 7] = a1;
    this.aUA.addUpdateRange(o, 8); this.aUA.needsUpdate = true;
  }

  /** Re-fade the next slice of the ring in place. */
  private fade(): void {
    const start = this.sweep, end = Math.min(start + SLICE, SEGS), u = this.ua;
    let any = false;
    for (let i = start; i < end; i++) {
      if (this.born[i] === 0) continue;
      const k = this.strength(i);
      if (k === 0) this.born[i] = 0;
      const o = i * 8, a0 = this.a0[i] * k, a1 = this.a1[i] * k;
      u[o + 1] = a0; u[o + 3] = a0; u[o + 5] = a1; u[o + 7] = a1;
      any = true;
    }
    if (any) { this.aUA.addUpdateRange(start * 8, (end - start) * 8); this.aUA.needsUpdate = true; }
    this.sweep = end === SEGS ? 0 : end;
  }
}
