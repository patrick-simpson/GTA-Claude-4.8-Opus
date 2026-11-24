// SpeedScan headquarters, the extra floors (tools/briefs/speedscan-hq.md, "more floors"): 12 the ID card print room, 20 the
// data hall (green haze in its floor vents), 28 the break room, 34 a floor under renovation and 70 the CEO's corner office.
// Built here in code (no Blender): each floor is a handful of merged vertex-coloured meshes (drawn unlit, the light is in
// the colours), one glow mesh whose lights blink in the shader (one clock uniform, no per-frame buffers) and a few moving
// props. A floor is built the first time the camera is in it and is drawn only while the camera is in it.
// speedscanInterior.ts owns the lifts and the doors and asks this file for the tower's solid boxes (gaps cut for the floors,
// the lift core, the outer walls) and for each floor's group (its lift cars go in it).

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person } from '../core/api';

export const FLOOR_H = 3.4;
export interface FloorDef { id: string; y: number; label: string; name: string; fp: number[] }
const F33 = [-33, 33, -36, 6], F26 = [-26, 26, -31, 1];
export const FLOORS: FloorDef[] = [
  { id: 'print', y: 45.6, label: '12', name: '12 · ID card print room', fp: F33 },
  { id: 'data', y: 76, label: '20', name: '20 · Data hall', fp: F33 },
  { id: 'break', y: 106.4, label: '28', name: '28 · Break room', fp: F33 },
  { id: 'reno', y: 129.2, label: '34', name: '34 · Under renovation', fp: F33 },
  { id: 'ceo', y: 266, label: '70', name: "70 · The CEO's office", fp: F26 },
];
const SECTIONS: number[][] = [[-33, 33, -36, 6, 15, 160], [-33, 33, -36, 6, 163, 190], [-29, 29, -33, 3, 190, 262], [-26, 26, -31, 1, 262, 322]];
const CAR_Z = -3.3, CAR_W = 2.6, DOOR_W = 1.3, CARS = [-4.125, 4.125];

/** The tower above the podium as solid boxes (model frame: x0, x1, z0, z1, y0, y1), the floors' gaps cut and walled, the lift core in each. */
export function towerBoxes(): number[][] {
  const out: number[][] = [];
  for (const [x0, x1, z0, z1, y0, y1] of SECTIONS) {
    const here = FLOORS.filter((f) => f.y >= y0 && f.y + FLOOR_H <= y1 && f.fp[0] === x0 && f.fp[2] === z0).sort((a, b) => a.y - b.y);
    let at = y0;
    for (const f of here) {
      out.push([x0, x1, z0, z1, at, f.y]);
      out.push([x0, x0 + 1, z0, z1, f.y, f.y + FLOOR_H], [x1 - 1, x1, z0, z1, f.y, f.y + FLOOR_H], [x0, x1, z0, z0 + 1, f.y, f.y + FLOOR_H], [x0, x1, z1 - 1, z1, f.y, f.y + FLOOR_H]);
      const d = DOOR_W / 2, c0 = CARS[0], c1 = CARS[1], w = CAR_W / 2;
      for (const [a, b] of [[-9.5, c0 - d], [c0 + d, c1 - d], [c1 + d, 9.5]]) out.push([a, b, CAR_Z, -3.19, f.y - 0.5, f.y + FLOOR_H]);
      for (const c of CARS) out.push([c - d, c + d, CAR_Z, -3.19, f.y + 2.4, f.y + FLOOR_H]);
      for (const [a, b] of [[-9.5, c0 - w], [c0 + w, c1 - w], [c1 + w, 9.5]]) out.push([a, b, -6.5, CAR_Z, f.y - 0.5, f.y + FLOOR_H]);
      for (const c of CARS) out.push([c - w, c + w, -6.5, CAR_Z - 2.6, f.y - 0.5, f.y + FLOOR_H]);
      at = f.y + FLOOR_H;
    }
    out.push([x0, x1, z0, z1, at, y1]);
  }
  return out;
}

class Mesher {
  pos: number[] = []; col: number[] = []; idx: number[] = []; bl: number[] = [];
  private c = new THREE.Color();
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, hex: number, rate = 0, ph = 0): void {
    this.c.set(hex);
    const faces: [number[], number][] = [
      [[x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], 0.9], [[x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0], 0.9],
      [[x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], 0.82], [[x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], 0.82],
      [[x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0], 1], [[x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1], 0.55],
    ];
    for (const [v, s] of faces) {
      const n = this.pos.length / 3, side = s > 0.8 && s < 0.95;
      for (let i = 0; i < 4; i++) {
        this.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
        const k = rate < 0 ? 1 : s * (side && i < 2 ? 0.84 : 1);
        this.col.push(this.c.r * k, this.c.g * k, this.c.b * k);
        this.bl.push(Math.abs(rate), ph);
      }
      this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
  }
  geo(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.bl, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const UT = { value: 0 };
const glowMat = new THREE.ShaderMaterial({
  uniforms: { uTime: UT }, vertexColors: true, toneMapped: false,
  vertexShader: 'attribute vec2 aB; varying vec3 vC; varying vec2 vB; void main(){ vC = color; vB = aB; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float uTime; varying vec3 vC; varying vec2 vB; void main(){ float on = vB.x < 0.01 ? 1.0 : step(0.5, fract(uTime * vB.x + vB.y)); gl_FragColor = vec4(vC * (0.1 + 0.9 * on) * 1.15, 1.0);\n#include <colorspace_fragment>\n}',
});

function hazeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: UT }, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    vertexShader: `uniform float uTime; attribute vec3 aT; attribute vec2 aS; varying vec3 vT;
      vec3 at(vec3 b, float t, float ph) { float y = t * 3.1; return b + vec3(sin(y * 2.3 - uTime * 1.7 + ph * 6.28), 0.0, sin(y * 1.9 - uTime * 1.2 + ph * 9.0)) * (0.05 + 0.32 * t) + vec3(0.0, y, 0.0); }
      void main() {
        vec3 b = (modelMatrix * vec4(position, 1.0)).xyz;
        float t = fract(aT.x * 0.0 + aT.x) , ph = aS.x;
        vec3 p = at(b, t, ph), q = at(b, t + 0.03, ph);
        vec3 side = normalize(cross(normalize(q - p), normalize(cameraPosition - p)));
        p += side * aT.y * aS.y * (0.6 + 0.8 * t);
        vT = vec3(t, aT.y, aT.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `varying vec3 vT;
      void main() {
        float t = vT.x, a = abs(vT.y);
        float core = 1.0 - smoothstep(0.25, 0.45, a), halo = 1.0 - smoothstep(0.0, 1.0, a);
        float ends = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.55, 1.0, t));
        float al = vT.z > 0.5 ? halo * 0.22 * ends : core * 0.85 * ends;
        vec3 c = mix(vec3(0.66, 0.92, 0.22), vec3(0.1, 0.68, 0.3), t);
        gl_FragColor = vec4(c * 1.2, al);
        #include <colorspace_fragment>
      }`,
  });
}

function haze(vents: number[][]): THREE.Mesh {
  const pos: number[] = [], aT: number[] = [], aS: number[] = [], idx: number[] = [], SEG = 24;
  vents.forEach(([x, z], vi) => {
    for (let k = 0; k < 4; k++) {
      const mist = k === 3, ph = ((vi * 3 + k) * 0.618) % 1, w = mist ? 0.55 : 0.05;
      const base = pos.length / 3;
      for (let s = 0; s <= SEG; s++) for (let e = 0; e < 2; e++) {
        pos.push(x + (k - 1) * 0.12, 0.05, z + (k % 2) * 0.15); aT.push(s / SEG, e * 2 - 1, mist ? 1 : 0); aS.push(ph, w);
      }
      for (let s = 0; s < SEG; s++) { const a = base + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 2));
  g.setIndex(idx); g.computeBoundingSphere();
  const m = new THREE.Mesh(g, hazeMaterial()); m.frustumCulled = false; m.renderOrder = 4;
  return m;
}

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = false): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

interface Built { group: THREE.Group; people: Person[]; specs: [number, number, number, boolean][]; y: number; anim: ((t: number) => void) | null; on: boolean }

export class SpeedScanFloors {
  /** One group per floor, at the world origin: the floor's furnishing and its lift cars go in it. */
  readonly groups = new Map<string, THREE.Group>();
  private built = new Map<string, Built>();
  private t = 0;
  /** Set by the interior: true while the camera is indoors (the night bloom is then off). */
  indoors = false;
  onDraw: (() => void) | null = null;

  constructor(private game: Game, parent: THREE.Object3D, private ox: number, private oz: number) {
    for (const f of FLOORS) { const g = new THREE.Group(); g.name = 'speedscan-floor-' + f.id; g.visible = false; parent.add(g); this.groups.set(f.id, g); }
  }

  /** Which floor the camera is in (index into FLOORS) or -1; builds and shows it. */
  update(dt: number, lx: number, ly: number, lz: number): number {
    this.t += dt; UT.value = this.t % 600;
    let at = -1;
    const near = Math.abs(lx) < 48 && lz > -45 && lz < 75;
    FLOORS.forEach((f, i) => {
      const inRange = near && ly > f.y - 1.5 && ly < f.y + FLOOR_H + 1;
      const g = this.groups.get(f.id)!;
      if (inRange) { at = i; if (!this.built.has(f.id)) this.build(f); }
      g.visible = inRange;
      const b = this.built.get(f.id);
      if (b) { b.on = inRange; for (const p of b.people) p.visible = inRange; if (inRange && b.anim) b.anim(this.t); }
    });
    return at;
  }

  /** The crowd was cleared by a restart (or the first time): spawn every built floor's people again. */
  respawn(): void { for (const b of this.built.values()) this.spawnFor(b); }
  firstPerson(): Person | undefined { for (const b of this.built.values()) if (b.people[0]) return b.people[0]; return undefined; }
  private spawnFor(b: Built): void {
    const ppl = this.game.people; if (!ppl) return;
    for (const p of b.people) ppl.remove(p);
    b.people = b.specs.map(([x, z, h, sit]) => { const p = ppl.spawn(this.ox + x, this.oz + z, h, ppl.randomLook()); p.y = b.y + (sit ? 0.05 : 0); p.visible = b.on; p.pose = sit ? 'sit' : 'stand'; if (sit) p.bench = false; return p; });
  }

  private build(f: FloorDef): void {
    const g = this.groups.get(f.id)!, ox = this.ox, oz = this.oz, y0 = f.y, game = this.game;
    const M = new Mesher(), G = new Mesher(), T = new Mesher();
    const specs: [number, number, number, boolean][] = [];
    let anim: ((t: number) => void) | null = null;
    const root = new THREE.Group(); root.name = 'f-' + f.id; root.position.set(ox, y0, oz); g.add(root);
    const b = (x0: number, x1: number, h0: number, h1: number, z0: number, z1: number, hex: number): void => M.box(x0, x1, h0, h1, z0, z1, hex);
    const bc = (cx: number, cz: number, w: number, d: number, h0: number, h1: number, hex: number): void => M.box(cx - w / 2, cx + w / 2, h0, h1, cz - d / 2, cz + d / 2, hex);
    const gl = (x0: number, x1: number, h0: number, h1: number, z0: number, z1: number, hex: number, rate = 0, ph = 0): void => G.box(x0, x1, h0, h1, z0, z1, hex, rate, ph);
    const tr = (x0: number, x1: number, h0: number, h1: number, z0: number, z1: number, hex: number): void => T.box(x0, x1, h0, h1, z0, z1, hex);
    const solid = (x0: number, x1: number, z0: number, z1: number, h: number, h0 = 0): void => { game.col.addBox(ox + x0, oz + z0, ox + x1, oz + z1, y0 + h, y0 + h0); };
    const solidC = (cx: number, cz: number, w: number, d: number, h: number): void => solid(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, h);
    const stand = (x: number, z: number, h: number, sit = false): void => { specs.push([x, z, h, sit]); };
    /** A chair at (x, z) facing north (-z), south (+z), east (+x) or west (-x). */
    const chair = (x: number, z: number, face: 'n' | 's' | 'e' | 'w', hex = 0x2b3038): void => {
      bc(x, z, 0.5, 0.5, 0.42, 0.48, hex); bc(x, z, 0.06, 0.06, 0, 0.42, 0x888e96);
      const d = 0.24, bk = { n: [x, z + d, 0.5, 0.06], s: [x, z - d, 0.5, 0.06], e: [x - d, z, 0.06, 0.5], w: [x + d, z, 0.06, 0.5] }[face];
      bc(bk[0], bk[1], bk[2], bk[3], 0.48, 0.95, hex);
    };
    const plant = (x: number, z: number, s = 1): void => { bc(x, z, 0.4 * s, 0.4 * s, 0, 0.35 * s, 0x6b4a33); bc(x, z, 0.5 * s, 0.5 * s, 0.35 * s, 1.1 * s, 0x2f7a3a); bc(x, z, 0.3 * s, 0.3 * s, 1.1 * s, 1.5 * s, 0x3f9448); };
    const sign = (text: string, x: number, h: number, z: number, ry: number, w: number, bg: string, fg: string, ht = w / 4): void => {
      const tex = canvasTex(1024, Math.round(1024 * ht / w), (c) => {
        c.fillStyle = bg; c.fillRect(0, 0, 1024, 1024); c.fillStyle = fg; c.font = `bold ${Math.round(1024 * ht / w * 0.5)}px Arial`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(text, 512, Math.round(1024 * ht / w / 2) + 4, 980);
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, ht), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      m.position.set(x, h, z); m.rotation.y = ry; root.add(m);
    };
    // Region walkable furnishing goes in: the big room north of the lift core.
    const [rx0, rx1, rz0, rz1] = [f.fp[0] + 1, f.fp[1] - 1, f.fp[2] + 1, f.fp[3] - 1];
    // Shell: floor, ceiling and its lights, window mullions, sills and heads, the lift wall.
    const floorTex = {
      print: canvasTex(64, 64, (c) => { c.fillStyle = '#7d8790'; c.fillRect(0, 0, 64, 64); c.fillStyle = '#6f7a84'; c.fillRect(0, 0, 32, 32); c.fillRect(32, 32, 32, 32); }, true),
      data: canvasTex(64, 64, (c) => { c.fillStyle = '#5b636b'; c.fillRect(0, 0, 64, 64); c.strokeStyle = '#2d3238'; c.lineWidth = 3; c.strokeRect(0, 0, 64, 64); c.fillStyle = '#4f565d'; for (let i = 8; i < 60; i += 12) for (let j = 8; j < 60; j += 12) c.fillRect(i, j, 4, 4); }, true),
      break: canvasTex(64, 64, (c) => { c.fillStyle = '#b8926a'; c.fillRect(0, 0, 64, 64); c.fillStyle = '#a98258'; for (let i = 0; i < 64; i += 16) c.fillRect(0, i, 64, 2); c.fillStyle = '#c29d74'; c.fillRect(0, 8, 40, 8); }, true),
      reno: canvasTex(64, 64, (c) => { c.fillStyle = '#8f8f8a'; c.fillRect(0, 0, 64, 64); for (let i = 0; i < 160; i++) { c.fillStyle = `rgba(${60 + (i * 7) % 60},${60 + (i * 5) % 60},${55 + (i * 3) % 60},0.35)`; c.fillRect((i * 37) % 64, (i * 53) % 64, 3, 3); } }, true),
      ceo: canvasTex(64, 64, (c) => { c.fillStyle = '#8d7a68'; c.fillRect(0, 0, 64, 64); c.fillStyle = '#7e6c5b'; c.fillRect(0, 0, 32, 32); c.fillRect(32, 32, 32, 32); }, true),
    }[f.id as 'print']!;
    floorTex.repeat.set((f.fp[1] - f.fp[0]) / 3, (f.fp[3] - f.fp[2]) / 3);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(f.fp[1] - f.fp[0], f.fp[3] - f.fp[2]), new THREE.MeshBasicMaterial({ map: floorTex, color: f.id === 'reno' ? 0xffffff : 0xdddddd }));
    fl.rotation.x = -Math.PI / 2; fl.position.set((f.fp[0] + f.fp[1]) / 2, 0.01, (f.fp[2] + f.fp[3]) / 2); root.add(fl);
    const ceilHex = f.id === 'reno' ? 0x8a8a86 : f.id === 'data' ? 0x39424b : f.id === 'ceo' ? 0x9a8f86 : 0xc9ccd0;
    b(f.fp[0], f.fp[1], FLOOR_H - 0.1, FLOOR_H, f.fp[2], f.fp[3], ceilHex);
    const lightHex = f.id === 'data' ? 0xa0dcff : f.id === 'break' ? 0xfff0d8 : f.id === 'ceo' ? 0xffd9a0 : f.id === 'reno' ? 0xffe9a8 : 0xf4f8ff;
    for (let x = rx0 + 3; x < rx1 - 1; x += 6) for (let z = rz0 + 2; z < rz1; z += 5) if (f.id !== 'reno' || ((x + z) * 7) % 3 < 1) gl(x - 0.7, x + 0.7, FLOOR_H - 0.13, FLOOR_H - 0.1, z - 0.15, z + 0.15, lightHex);
    const wallHex = f.id === 'ceo' ? 0x6a5f58 : f.id === 'reno' ? 0xa5a49d : 0xdfe2e4;
    const mull = 0x1c2227;
    const [fx0, fx1, fz0, fz1] = f.fp;
    for (const [x0, x1, z0, z1] of [[fx0, fx1, fz0, fz0 + 0.3], [fx0, fx1, fz1 - 0.3, fz1], [fx0, fx0 + 0.3, fz0, fz1], [fx1 - 0.3, fx1, fz0, fz1]]) {
      b(x0, x1, 0, 0.8, z0, z1, wallHex); b(x0, x1, 3.0, FLOOR_H, z0, z1, wallHex);
    }
    for (let x = fx0 + 3; x < fx1; x += 3) { b(x - 0.06, x + 0.06, 0.8, 3, fz0, fz0 + 0.2, mull); b(x - 0.06, x + 0.06, 0.8, 3, fz1 - 0.2, fz1, mull); }
    for (let z = fz0 + 3; z < fz1; z += 3) { b(fx0, fx0 + 0.2, 0.8, 3, z - 0.06, z + 0.06, mull); b(fx1 - 0.2, fx1, 0.8, 3, z - 0.06, z + 0.06, mull); }
    // The lift core: front wall with the two door holes, the ends and back for walking round it.
    const coreHex = f.id === 'ceo' ? 0x7b6e5f : 0xcfd2d4, dd = DOOR_W / 2;
    b(-9.5, CARS[0] - dd, 0, FLOOR_H, CAR_Z, -3.19, coreHex); b(CARS[0] + dd, CARS[1] - dd, 0, FLOOR_H, CAR_Z, -3.19, coreHex); b(CARS[1] + dd, 9.5, 0, FLOOR_H, CAR_Z, -3.19, coreHex);
    for (const c of CARS) { b(c - dd, c + dd, 2.4, FLOOR_H, CAR_Z, -3.19, coreHex); b(c - dd - 0.05, c - dd, 0, 2.4, CAR_Z, -3.18, 0x8e949a); b(c + dd, c + dd + 0.05, 0, 2.4, CAR_Z, -3.18, 0x8e949a); }
    b(-9.5, -9.3, 0, FLOOR_H, -6.5, CAR_Z, coreHex); b(9.3, 9.5, 0, FLOOR_H, -6.5, CAR_Z, coreHex); b(-9.5, 9.5, 0, FLOOR_H, -6.5, -6.3, coreHex);
    sign(f.name, 0, 3.02, -3.2, 0, 3.4, '#0e1418', '#9fe870', 0.3);

    // ───────────────────────────────────────────────────────── 12: ID card print room
    if (f.id === 'print') {
      b(-30, 30, 0, 0.001, -34.5, -8, 0x6d7780);
      const cols = [0xe8453c, 0x2f7de1, 0xf2c230, 0x3aa65c, 0xffffff, 0x8e5cc4];
      const slots: number[][] = [];
      [-14, -20, -26].forEach((bz, row) => {
        b(-28, 28, 0.74, 0.8, bz - 0.5, bz + 0.5, 0xb9bec4); b(-28, -27.8, 0, 0.74, bz - 0.5, bz + 0.5, 0x7c838a); b(27.8, 28, 0, 0.74, bz - 0.5, bz + 0.5, 0x7c838a);
        b(-28, 28, 0.2, 0.26, bz - 0.5, bz + 0.5, 0x7c838a);
        solid(-28, 28, bz - 0.5, bz + 0.5, 0.8);
        for (let i = 0; i < 14; i++) {
          const x = -26 + i * 4;
          bc(x, bz - 0.05, 0.58, 0.5, 0.8, 1.08, 0xe9ecee); bc(x, bz + 0.2, 0.58, 0.1, 0.8, 0.9, 0x3b4046);
          bc(x, bz + 0.26, 0.5, 0.03, 1.0, 1.04, 0x46c14a); bc(x, bz + 0.05, 0.4, 0.4, 1.08, 1.12, 0xc9ced2);
          gl(x - 0.2, x - 0.14, 1.0, 1.04, bz + 0.25, bz + 0.27, i % 3 === 0 ? 0xffb020 : 0x2fe05a, 0.35 + (i % 5) * 0.12, i * 0.31);
          gl(x - 0.1, x + 0.1, 0.99, 1.0, bz + 0.25, bz + 0.265, 0x4aa8ff);
          // The hopper under the slot, a stack of cards in it, and a tray of finished stacks beside.
          bc(x, bz + 0.38, 0.3, 0.2, 0.8, 0.86, 0x2a2e33); bc(x, bz + 0.38, 0.09, 0.06, 0.86, 0.86 + 0.02 + (i % 4) * 0.03, cols[(i + row) % 6]);
          bc(x + 1.4, bz + 0.1, 0.5, 0.3, 0.8, 0.86, 0xc7a46a);
          for (let k = 0; k < 3; k++) bc(x + 1.25 + k * 0.15, bz + 0.1, 0.09, 0.06, 0.86, 0.9 + ((i + k) % 3) * 0.05, cols[(i + k + row) % 6]);
          if (row === 0 && i < 12) slots.push([x, bz + 0.3]);
        }
        for (let i = 0; i < 4; i++) chair(-20 + i * 14, bz + 1.25 + row * 0.01, 'n', 0x3c4a5c);
      });
      // Cards sliding out of a row of printers (the stand-ins for a busy room).
      const cardGeo = new THREE.BoxGeometry(0.086, 0.004, 0.054), cardMat: THREE.MeshBasicMaterial[] = cols.map((c) => new THREE.MeshBasicMaterial({ color: c }));
      const moving = slots.map(([x, z], i) => { const m = new THREE.Mesh(cardGeo, cardMat[i % 6]); root.add(m); return { m, x, z, ph: i * 0.37 }; });
      anim = (t) => { for (const c of moving) { const k = ((t * 0.5 + c.ph) % 1); c.m.position.set(c.x, 0.89 + 0.005, c.z + 0.1 + Math.min(1, k * 1.6) * 0.16); c.m.visible = k < 0.8; } };
      // Pallets of shrink-wrapped cards and cartons on shelves.
      for (const [px, pz] of [[-29, -31], [-27, -31], [29, -31], [27, -31]]) { bc(px, pz, 1.2, 1, 0, 0.14, 0x8a6a42); bc(px, pz, 1.1, 0.9, 0.14, 1.5, 0xc7a46a); bc(px, pz, 1.12, 0.92, 1.0, 1.52, 0xe6eef2); solidC(px, pz, 1.2, 1, 1.5); }
      b(-26, 26, 0, 2.4, -34.5, -34, 0x9aa1a8); solid(-26, 26, -34.5, -33.2, 2.4);
      for (let lv = 0; lv < 4; lv++) { b(-26, 26, 0.4 + lv * 0.55, 0.45 + lv * 0.55, -34, -33.2, 0x56606a); for (let i = 0; i < 40; i++) bc(-25.5 + i * 1.3, -33.6, 1.0, 0.6, 0.45 + lv * 0.55, 0.45 + lv * 0.55 + 0.35 + ((i + lv) % 3) * 0.05, ((i * 5 + lv * 3) % 7) < 3 ? 0xc7a46a : 0xb89258); }
      sign('SPEEDSCAN ID CARDS · PRINTING', 0, 2.9, -33.15, 0, 8, '#0e1418', '#9fe870', 0.9);
      for (const [px, pz, h] of [[-8, -12.7, 0], [6, -18.7, 0], [18, -24.7, 0], [-18, -18.7, 0]]) stand(px, pz, h);
    }

    // ───────────────────────────────────────────────────────── 20: data hall
    if (f.id === 'data') {
      const vents: number[][] = [];
      const rows: [number, 1 | -1][] = [[-14.3, -1], [-15.7, 1], [-24.3, -1], [-25.7, 1]];
      for (const [fz, dir] of rows) {
        const z0 = dir < 0 ? fz : fz - 1, z1 = dir < 0 ? fz + 1 : fz;
        b(-29, -2, 0, 2.1, Math.min(z0, z1), Math.max(z0, z1), 0x22272d);
        solid(-29, -2, Math.min(z0, z1) + 0, Math.max(z0, z1), 2.1);
        const front = fz;
        for (let i = 0; i < 38; i++) {
          const x = -28.65 + i * 0.7;
          for (let u = 0; u < 12; u++) {
            const fzp = dir < 0 ? front - 0.012 : front + 0.012, h = 0.2 + u * 0.15;
            gl(x - 0.28, x + 0.28, h, h + 0.08, Math.min(fzp, fzp + dir * 0.0), Math.max(fzp, fzp + 0.001), 0x2c3138);
            const r = (i * 7 + u * 3 + rows.length) % 11;
            gl(x - 0.22 + (u % 2) * 0.05, x - 0.17 + (u % 2) * 0.05, h + 0.02, h + 0.06, Math.min(fzp, fzp - dir * 0.01), Math.max(fzp, fzp - dir * 0.01) + 0.002, r < 4 ? 0x2fe05a : r < 7 ? 0x4aa8ff : 0xffb020, 0.3 + (r % 5) * 0.31, (i * 13 + u * 7) * 0.113);
            gl(x + 0.1, x + 0.14, h + 0.02, h + 0.06, Math.min(fzp, fzp - dir * 0.01), Math.max(fzp, fzp - dir * 0.01) + 0.002, 0x2fe05a, 1.7 + (r % 3), (i * 7 + u) * 0.17);
          }
        }
      }
      b(-29, -2, 2.4, 2.55, -27, -13, 0x41484f);
      for (const z of [-15, -25]) for (const x of [-22, -12, -4]) { b(x - 0.5, x + 0.5, 0.0, 0.03, z - 0.5, z + 0.5, 0x15191c); vents.push([x, z]); gl(x - 0.45, x + 0.45, 0.03, 0.035, z - 0.45, z + 0.45, 0x1c6b2c, 0.5, x * 0.1); }
      for (const [vx, vz] of [[14, -28], [22, -28], [14, -12]]) { b(vx - 0.5, vx + 0.5, 0, 0.03, vz - 0.5, vz + 0.5, 0x15191c); vents.push([vx, vz]); gl(vx - 0.45, vx + 0.45, 0.03, 0.035, vz - 0.45, vz + 0.45, 0x1c6b2c, 0.5, vx * 0.1); }
      const hz = haze(vents); hz.name = 'f-haze'; hz.position.set(ox, y0, oz); g.add(hz);
      // The monitoring desk: a wall of screens and a few engineers.
      b(8, 29, 0, 2.5, -34.5, -34, 0x1d2227);
      for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) gl(9 + i * 2.9, 11.6 + i * 2.9, 0.9 + j * 0.8, 1.6 + j * 0.8, -34, -33.97, [0x1f7a4d, 0x1b5f9c, 0x7a5a1b, 0x2a2f36][(i + j) % 4], 0.12 + ((i + j) % 3) * 0.1, i * 0.7 + j);
      for (let i = 0; i < 3; i++) { b(11 + i * 5, 14.5 + i * 5, 0, 0.78, -31, -29.8, 0xaeb4ba); gl(11.8 + i * 5, 13.6 + i * 5, 0.9, 1.5, -30.9, -30.86, 0x1f7a4d, 0.2, i); solid(11, 14.5 + i * 5, -31, -29.8, 0.78); chair(12.7 + i * 5, -28.9, 'n'); }
      b(2, 4, 0, 1.4, -10, -8.5, 0x2b3036); solid(2, 4, -10, -8.5, 1.4);
      sign('DATA HALL · AUTHORIZED STAFF', 18, 2.7, -33.9, 0, 7, '#0e1418', '#9fe870', 0.8);
      stand(14, -28, 0); stand(-15, -15, Math.PI / 2); stand(22, -27.3, 0);
    }

    // ───────────────────────────────────────────────────────── 28: break room
    if (f.id === 'break') {
      b(-30, 30, 0, 0.001, -34.5, -8, 0xb8926a);
      // Ping-pong table at (-8, -20): 2.74 along x, 1.525 along z, 0.76 high.
      const px = -8, pz = -20;
      b(px - 1.37, px + 1.37, 0.72, 0.76, pz - 0.7625, pz + 0.7625, 0x1f5fa8); b(px - 1.37, px + 1.37, 0.76, 0.762, pz - 0.0075, pz + 0.0075, 0xffffff);
      b(px - 1.37, px + 1.37, 0.762, 0.764, pz - 0.7625, pz - 0.7525, 0xffffff); b(px - 1.37, px + 1.37, 0.762, 0.764, pz + 0.7525, pz + 0.7625, 0xffffff);
      for (const sx of [-1.25, 1.25]) for (const sz of [-0.65, 0.65]) b(px + sx - 0.04, px + sx + 0.04, 0, 0.72, pz + sz - 0.04, pz + sz + 0.04, 0x2b3036);
      tr(px - 0.01, px + 0.01, 0.76, 0.915, pz - 0.84, pz + 0.84, 0xeeeeee);
      b(px - 0.03, px + 0.03, 0.76, 0.92, pz - 0.88, pz - 0.84, 0x2b3036); b(px - 0.03, px + 0.03, 0.76, 0.92, pz + 0.84, pz + 0.88, 0x2b3036);
      solid(px - 1.37, px + 1.37, pz - 0.76, pz + 0.76, 0.76);
      bc(px - 0.9, pz + 0.3, 0.17, 0.02, 0.77, 0.94, 0xc0392b); bc(px + 1.0, pz - 0.4, 0.17, 0.02, 0.77, 0.94, 0x2b3036);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })); root.add(ball);
      anim = (t) => { const k = (t * 1.1) % 2, u = k < 1 ? k : 2 - k; const x = px - 1.2 + u * 2.4; const hop = Math.abs(Math.sin(t * 5.5)); ball.position.set(x, 0.79 + hop * 0.22, pz + Math.sin(t * 0.9) * 0.3); };
      stand(px - 1.9, pz + 0.3, -Math.PI / 2); stand(px + 1.9, pz - 0.4, Math.PI / 2);
      // Vending machines and a fridge along the north wall.
      [[8, 0xc0392b, 'COLA'], [9.2, 0x2f7de1, 'SNAX'], [10.4, 0x3aa65c, 'WATER']].forEach(([vx, hex], vi) => {
        const x = vx as number;
        b(x - 0.5, x + 0.5, 0, 1.85, -34.4, -33.5, 0x2a2e33); solid(x - 0.5, x + 0.5, -34.4, -33.5, 1.85);
        gl(x - 0.42, x + 0.15, 0.7, 1.7, -33.5, -33.49, 0xfff3d8);
        for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) bc(x - 0.36 + c * 0.13, -33.47, 0.08, 0.02, 0.78 + r * 0.19, 0.92 + r * 0.19, [0xe8453c, 0xf2c230, 0x2f7de1, 0x3aa65c, 0xffffff][(r * 3 + c + vi) % 5]);
        gl(x + 0.2, x + 0.43, 1.35, 1.6, -33.5, -33.49, hex as number); b(x + 0.2, x + 0.43, 1.0, 1.25, -33.5, -33.47, 0x888e96);
        gl(x - 0.4, x + 0.4, 0.06, 0.12, -33.5, -33.49, hex as number, 0.8, vi);
      });
      b(12.4, 13.4, 0, 1.9, -34.4, -33.5, 0xdfe2e4); gl(12.6, 12.65, 1.2, 1.7, -33.5, -33.49, 0x9aa1a8); solid(12.4, 13.4, -34.4, -33.5, 1.9);
      sign('BREAK ROOM · BE BACK IN 5', -12, 2.6, -34.4, 0, 6, '#2a5a8a', '#ffffff', 0.9);
      // Kitchenette along the east wall, a coffee machine on it.
      b(29, 30.4, 0, 0.9, -30, -13, 0xe9e2d4); b(28.9, 30.4, 0.9, 0.95, -30, -13, 0x4b4f55); solid(28.9, 30.4, -30, -13, 0.95);
      b(29.2, 30.4, 1.6, 2.2, -30, -22, 0xe9e2d4); bc(29.6, -17, 0.4, 0.4, 0.95, 1.4, 0x2a2e33); gl(29.4, 29.8, 1.1, 1.2, -17, -16.8, 0xff5a2a);
      for (let i = 0; i < 4; i++) bc(29.5, -28 + i * 1.8, 0.5, 0.3, 0.95, 0.98, 0xaeb4ba);
      // The lounge: sofas round a TV on the west wall, tables and stools.
      b(-31, -30.9, 0.9, 2.2, -24, -16, 0x111317); gl(-30.9, -30.89, 1.0, 2.1, -23.8, -16.2, 0x35568a, 0.15, 0.4);
      b(-28, -24, 0, 0.01, -26, -14, 0x7a3b3b);
      for (const [sx, sz, w, d] of [[-25.3, -20, 1.0, 3.2], [-27.5, -14.8, 3.2, 1.0], [-27.5, -25.4, 3.2, 1.0]]) { bc(sx, sz, w, d, 0, 0.45, 0x3d6b8c); bc(sx + (w < d ? 0.4 : 0), sz + (w >= d ? (sz > -20 ? 0.4 : -0.4) : 0), w < d ? 0.2 : w, w < d ? d : 0.2, 0.45, 0.9, 0x34607f); solidC(sx, sz, w, d, 0.5); }
      bc(-27.5, -20, 1.0, 1.0, 0, 0.4, 0x5b4636);
      [[10, -22], [16, -26], [20, -17], [4, -29]].forEach(([tx, tz], ti) => { bc(tx, tz, 1.0, 1.0, 0.72, 0.76, 0xf1ece0); bc(tx, tz, 0.1, 0.1, 0, 0.72, 0x888e96); solidC(tx, tz, 1.0, 1.0, 0.76); for (const [cx, cz, fc] of [[-0.8, 0, 'e'], [0.8, 0, 'w'], [0, -0.8, 's'], [0, 0.8, 'n']] as [number, number, 'n' | 's' | 'e' | 'w'][]) chair(tx + cx, tz + cz, fc, ti % 2 ? 0xc0392b : 0xf2c230); bc(tx, tz, 0.12, 0.12, 0.76, 0.84, 0xe8453c); });
      plant(-29, -31, 1.4); plant(28, -9, 1.2); plant(0, -33, 1.3); plant(-9, -31, 1);
      stand(8.8, -32.6, 0); stand(-23.8, -20.8, Math.PI / 2, true); stand(10, -21, Math.PI / 2, true);
    }

    // ───────────────────────────────────────────────────────── 34: under renovation
    if (f.id === 'reno') {
      // Studs of new partitions, some with board on, columns, a scaffold, ladders, plastic sheeting.
      for (const cx of [-24, -8, 8, 24]) for (const cz of [-30, -18, -10]) { bc(cx, cz, 0.6, 0.6, 0, FLOOR_H - 0.1, 0x9a9a95); solidC(cx, cz, 0.6, 0.6, FLOOR_H); }
      for (const [z, xa, xb, boarded] of [[-24, -22, -4, 1], [-14, 4, 22, 0]] as number[][]) {
        b(xa, xb, 0, 0.08, z - 0.05, z + 0.05, 0xb8905a); b(xa, xb, 2.7, 2.8, z - 0.05, z + 0.05, 0xb8905a);
        for (let x = xa; x <= xb; x += 0.4) b(x - 0.02, x + 0.02, 0.08, 2.7, z - 0.05, z + 0.05, 0xc9a26a);
        if (boarded) for (let x = xa; x < xb - 4; x += 1.2) b(x, x + 1.2, 0.08, 2.7, z + 0.05, z + 0.1, 0xe3e0d6);
        solid(xa, xb, z - 0.1, z + 0.1, 2.8);
      }
      // The scaffold tower and its planks.
      for (const [sx, sz] of [[-20, -31], [-17, -31], [-20, -29.4], [-17, -29.4]]) bc(sx, sz, 0.06, 0.06, 0, 3, 0x9aa1a8);
      for (const h of [0.5, 1.5, 2.5]) { b(-20, -17, h, h + 0.04, -31, -29.4, 0xb8905a); b(-20, -17, h + 0.04, h + 0.07, -31.02, -31, 0x9aa1a8); b(-20, -17, h - 0.01, h + 0.01, -29.4, -29.38, 0x9aa1a8); }
      solid(-20.1, -16.9, -31.1, -29.3, 3);
      // Ladders: an A-frame and one leaning on the wall.
      const aframe = (x: number, z: number): void => { for (const s of [-1, 1]) { b(x - 0.3, x - 0.26, 0, 2.0, z + s * 0.5 - 0.02 + (s < 0 ? 0.35 : 0), z + s * 0.5 + 0.02 + (s < 0 ? 0.35 : 0), 0xe8a21a); b(x + 0.26, x + 0.3, 0, 2.0, z + s * 0.5 - 0.02 + (s < 0 ? 0.35 : 0), z + s * 0.5 + 0.02 + (s < 0 ? 0.35 : 0), 0xe8a21a); } for (let h = 0.3; h < 1.9; h += 0.3) b(x - 0.3, x + 0.3, h, h + 0.03, z - 0.14, z + 0.14, 0xbfc4c9); b(x - 0.32, x + 0.32, 2.0, 2.06, z - 0.18, z + 0.18, 0x2b3036); solid(x - 0.35, x + 0.35, z - 0.5, z + 0.5, 2.06); };
      aframe(14, -20); aframe(-5, -12); aframe(26, -26);
      for (let h = 0.3; h < 3; h += 0.32) b(-10, -9.4, h, h + 0.03, -33.9 + h * 0.07, -33.8 + h * 0.07, 0xbfc4c9);
      b(-10, -9.96, 0, 3.2, -33.9, -33.85, 0xe8a21a); b(-9.44, -9.4, 0, 3.2, -33.9, -33.85, 0xe8a21a);
      // Tools, buckets, bags, cones, drop cloths, work lights.
      for (let i = 0; i < 8; i++) { const x = -3 + i * 0.5, z = -27 - (i % 3) * 0.4; bc(x, z, 0.3, 0.3, 0, 0.38, i % 2 ? 0xf2f2f2 : 0xe8453c); bc(x, z, 0.26, 0.26, 0.38, 0.4, 0x2b3036); }
      b(-6, 4, 0, 0.012, -26, -22, 0xe8e6dc); b(14, 20, 0, 0.012, -10, -6, 0xbfc4c9);
      for (let i = 0; i < 10; i++) bc(18 + (i % 2) * 1.0, -31 + Math.floor(i / 2) * 0.5, 0.9, 0.45, Math.floor(i / 4) * 0.14, Math.floor(i / 4) * 0.14 + 0.14, 0xbcb7aa);
      solid(17.5, 19.5, -32, -29.3, 0.6);
      for (const [x, z] of [[6, -9], [18, -9], [-14, -20], [-28, -9]]) { bc(x, z, 0.4, 0.4, 0, 0.04, 0x2b3036); bc(x, z, 0.28, 0.28, 0.04, 0.34, 0xff7a1a); bc(x, z, 0.1, 0.1, 0.34, 0.36, 0xffffff); }
      for (const [x, z] of [[-12, -34], [8, -34], [22, -32]]) { b(x - 0.03, x + 0.03, 0, 1.6, z, z + 0.06, 0x2b3036); gl(x - 0.35, x + 0.35, 1.6, 2.0, z - 0.03, z + 0.05, 0xfff0b0); }
      for (const x of [-6, 2, 10]) { b(x, x + 1.6, 0.6, 0.68, -16.4, -15.8, 0xb8905a); b(x + 0.1, x + 0.16, 0, 0.6, -16.4, -15.8, 0xc9a26a); b(x + 1.44, x + 1.5, 0, 0.6, -16.4, -15.8, 0xc9a26a); solid(x, x + 1.6, -16.4, -15.8, 0.68); }
      b(-26, -24, 0, 0.9, -12.8, -11.2, 0x8a6a42); b(-25.8, -24.2, 0.9, 1.0, -12.6, -11.4, 0x8a6a42); solid(-26, -24, -12.8, -11.2, 1);
      // Plastic sheeting hung in waves, across the room and over some of the windows.
      for (const [z, xa, xb] of [[-11.5, -30, -10], [-28, 24, 32]] as number[][]) for (let x = xa; x < xb; x += 1) tr(x, x + 1.02, 0.1, 3.3, z + Math.sin(x * 1.3) * 0.12, z + Math.sin(x * 1.3) * 0.12 + 0.02, 0xdfe8ee);
      for (let z = -34; z < -28; z += 1) tr(-31.8, -31.78, 0.8, 3.0, z, z + 1.02, 0xdfe8ee);
      for (let z = -12; z < -4; z += 1) tr(31.78, 31.8, 0.8, 3.0, z, z + 1.02, 0xdfe8ee);
      // Hazard tape across the lift wall's south side and the sign.
      for (let i = 0; i < 24; i++) b(-9.5 + i * 0.8, -9.5 + i * 0.8 + 0.4, 0.05, 0.12, -3.17, -3.15, i % 2 ? 0x111111 : 0xf2c230);
      sign('UNDER RENOVATION · HARD HATS', 0, 1.9, -3.18, 0, 3.4, '#f2c230', '#111111', 0.5);
      stand(-5, -13, 0); stand(15, -19, Math.PI);
    }

    // ───────────────────────────────────────────────────────── 70: the CEO's office
    if (f.id === 'ceo') {
      b(-25, 25, 0, 0.001, -30, 0, 0x433b4a);
      // The corner office, glass on two sides (the view is the real city), a partition of glass to the floor plan.
      tr(7.9, 8.1, 0, 3.2, -30, -12, 0xa8c4d4); tr(8, 25, 0, 3.2, -9.1, -8.9, 0xa8c4d4); tr(7.9, 8.1, 0, 3.2, -10, -9, 0xa8c4d4);
      b(7.85, 8.15, 0, 0.05, -30, -12, 0x1c2227); b(7.85, 8.15, 3.2, 3.3, -30, -9, 0x1c2227); b(8, 25, 3.2, 3.3, -9.15, -8.85, 0x1c2227);
      solid(7.9, 8.1, -30, -12, 3.2); solid(8, 25, -9.1, -8.9, 3.2);
      b(10, 14, 0, 0.012, -26, -14, 0x7a1f2b);
      // The desk, facing the east window; the founder's chair behind it.
      b(16.2, 17.6, 0.72, 0.78, -22, -17.5, 0x4a2f20); b(16.3, 16.35, 0.0, 0.72, -21.9, -17.6, 0x3a2418); b(17.45, 17.5, 0.0, 0.72, -21.9, -17.6, 0x3a2418); solid(16.2, 17.6, -22, -17.5, 0.78);
      gl(17.0, 17.4, 0.8, 1.15, -21.2, -21.18, 0x4aa8ff); gl(17.0, 17.4, 0.8, 1.15, -18.4, -18.38, 0x4aa8ff); bc(16.7, -19.7, 0.3, 0.2, 0.78, 0.82, 0x111317);
      chair(14.9, -19.75, 'e', 0x1b1b1f); b(14.6, 14.7, 0.48, 1.3, -20.4, -19.1, 0x1b1b1f);
      chair(18.6, -21, 'w', 0x6b4a33); chair(18.6, -18.5, 'w', 0x6b4a33);
      // Sofa, coffee table, a globe, a bookcase and the bar.
      bc(21, -13.5, 3.0, 1.0, 0, 0.45, 0x2f4a3a); bc(21, -13.0, 3.0, 0.2, 0.45, 0.9, 0x2a4235); solidC(21, -13.5, 3.0, 1.0, 0.5); bc(21, -15.3, 1.4, 0.7, 0.3, 0.4, 0xb8905a); solidC(21, -15.3, 1.4, 0.7, 0.4);
      b(10, 14, 0, 2.2, -29.9, -29.5, 0x4a2f20); solid(10, 14, -29.9, -29.5, 2.2);
      for (let r = 0; r < 5; r++) for (let i = 0; i < 18; i++) bc(10.2 + i * 0.21, -29.6, 0.17, 0.3, 0.1 + r * 0.42, 0.1 + r * 0.42 + 0.3 + (i % 3) * 0.04, [0x7a1f2b, 0x1f3a7a, 0xc9a26a, 0x2b6b4a, 0x3a3340][(i + r) % 5]);
      b(17, 20, 0, 1.0, -29.7, -28.9, 0x2a2e33); gl(17.2, 19.8, 1.0, 1.04, -29.6, -29.0, 0xffd9a0); solid(17, 20, -29.7, -28.9, 1.0);
      for (let i = 0; i < 5; i++) bc(17.4 + i * 0.5, -29.3, 0.12, 0.12, 1.04, 1.34, [0x7a1f2b, 0x2b6b4a, 0xc9a26a, 0x1f3a7a, 0xe8d08a][i]);
      b(24.9, 25, 0.9, 2.4, -26, -22, 0x111317); sign('SPEEDSCAN', 24.5, 2.8, -24, -Math.PI / 2, 3.6, '#2a3a2a', '#9fe870', 0.8);
      bc(23, -26, 0.5, 0.5, 0, 0.9, 0x555a62); const gm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), new THREE.MeshBasicMaterial({ color: 0x3a74b8 })); gm.position.set(23, 1.2, -26); root.add(gm);
      plant(23.5, -10.5, 1.6); plant(9, -29, 1.3);
      // Outside the corner office: the board table with ten chairs, reception, a lounge by the lifts.
      b(-20, -9, 0.72, 0.78, -22, -20, 0x4a2f20); b(-19.5, -19.3, 0, 0.72, -21.4, -20.6, 0x3a2418); b(-9.7, -9.5, 0, 0.72, -21.4, -20.6, 0x3a2418); solid(-20, -9, -22, -20, 0.78);
      for (let i = 0; i < 5; i++) { chair(-18.5 + i * 2.2, -22.55, 's', 0x1b1b1f); chair(-18.5 + i * 2.2, -19.45, 'n', 0x1b1b1f); }
      b(-24.9, -24.8, 0.8, 2.6, -26, -16, 0xf2f2f2); sign("Q3 · EVERYONE'S ID, PRINTED", -24.7, 2.9, -21, Math.PI / 2, 5, '#1c1f24', '#ffffff', 0.7);
      b(-8, -2, 0, 1.05, -1.8, -0.6, 0x5b4636); b(-8, -2, 1.05, 1.1, -2.0, -0.4, 0xc9a26a); solid(-8, -2, -2, -0.4, 1.1); sign('OFFICE OF THE FOUNDER', -5, 2.4, -0.55, Math.PI, 3.2, '#1c1f24', '#c9a26a', 0.5);
      bc(-13, -1.5, 3.4, 1.0, 0, 0.45, 0x6a5f58); bc(-13, -2.0, 3.4, 0.2, 0.45, 0.9, 0x5e544d); solidC(-13, -1.5, 3.4, 1.0, 0.5);
      plant(-24, -1.6, 1.6); plant(-24, -28, 1.5); plant(12, -1.5, 1.2);
      for (let i = 0; i < 4; i++) b(-24 + i * 0.8, -23.2 + i * 0.8, 0.9, 1.5, -29.95, -29.9, [0xe0cfa0, 0x9aa7b2, 0xc9a26a, 0x6e7f8f][i]);
      stand(18.3, -19.7, Math.PI / 2); stand(-5, -2.7, Math.PI); stand(-13.2, -20.8, 0, true);
    }
    const mm = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const tm = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: f.id === 'ceo' ? 0.16 : 0.32, depthWrite: false, side: THREE.DoubleSide });
    const addM = (mesher: Mesher, mat: THREE.Material, order = 0): void => {
      if (!mesher.idx.length) return;
      const mesh = new THREE.Mesh(mesher.geo(), mat); mesh.renderOrder = order; mesh.frustumCulled = false;
      mesh.onBeforeRender = () => { if (this.indoors) this.onDraw?.(); };
      root.add(mesh);
    };
    addM(M, mm); addM(G, glowMat); addM(T, tm, 2);
    const built: Built = { group: root, people: [], specs, y: y0, anim, on: true };
    this.built.set(f.id, built);
    this.spawnFor(built);
  }
}
