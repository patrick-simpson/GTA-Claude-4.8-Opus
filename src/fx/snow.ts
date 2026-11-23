// Winter and autumn in the air and along the kerbs (the sky owns one of these: Sky.snowfall).
//
//  * Falling snow: one mesh of small soft discs in a box that wraps round the camera in the vertex shader, like the
//    rain sheet in sky.ts. Each flake drifts on its own slow sine; nothing moves on the CPU. A storm shows more of
//    them and blows them sideways.
//  * Falling leaves in autumn: the same trick with fewer, bigger, tumbling cards in maple colours, shown where the
//    tree field has deciduous trees close to the camera.
//  * Snowbanks: ploughed ridges along the kerbs of every open street, one instanced mesh filled from a grid with the
//    banks near the camera (refilled only when the camera has moved or a bank has gone, registered with game.flip).
//    They grow with the snow cover. A car that drives into one bursts it into powder (Fx.powder) and loses a little
//    speed; the test is a lookup in a 24 m grid for the cars near the camera, so far away it costs nothing.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { flip, sendRange } from '../core/flip';
import { groundAt } from '../world/plan';
import { treeSeason } from '../world/floraAssets';

const FLAKE_BOX = new THREE.Vector3(40, 22, 40);
const LEAF_BOX = new THREE.Vector3(30, 14, 30);

const FALL_VERT = /* glsl */ `
attribute vec4 seed;
uniform vec3 uOff, uBox;
uniform float uAmount, uTime, uSize, uSway;
varying float vA;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  // Speeds in tenths, so the CPU's offset can wrap at ten boxes without a jump.
  float sp = 0.7 + 0.1 * floor( seed.x * 6.0 );
  vec3 p = position + uOff * sp;
  float ph = seed.y * 40.0;
  p.x += sin( uTime * ( 0.6 + seed.y * 0.8 ) + ph ) * uSway;
  p.z += cos( uTime * ( 0.5 + seed.x * 0.7 ) + ph * 1.3 ) * uSway;
  vec3 rel = mod( p - cameraPosition, uBox ) - 0.5 * uBox;
  float dist = length( rel );
  vec4 mv = viewMatrix * vec4( cameraPosition + rel, 1.0 );
  // A flake keeps about a pixel and a half far off instead of vanishing into aliasing.
  float sz = uSize * ( 0.6 + 0.8 * seed.w ) * max( 1.0, dist * 0.03 );
  vec2 q = uv - 0.5;
  #ifdef LEAF
    // A leaf turns over as it falls: its card narrows and widens.
    float spin = uTime * ( 1.5 + 2.5 * seed.x ) + ph;
    q.x *= 0.25 + 0.75 * abs( cos( spin ) );
    q = mat2( cos( ph ), sin( ph ), - sin( ph ), cos( ph ) ) * q;
    float pick = fract( seed.w * 7.3 );
    vCol = pick < 0.35 ? vec3( 0.55, 0.07, 0.02 ) : pick < 0.7 ? vec3( 0.8, 0.28, 0.03 ) : pick < 0.9 ? vec3( 0.78, 0.55, 0.05 ) : vec3( 0.35, 0.2, 0.06 );
  #else
    vCol = vec3( 1.0 );
  #endif
  mv.xy += q * sz;
  vA = step( seed.z, uAmount ) * smoothstep( 0.5 * uBox.x, 0.3 * uBox.x, dist ) * smoothstep( 0.8, 2.2, dist );
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;

const FALL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float r = length( vUv - 0.5 );
  #ifdef LEAF
    float a = 1.0 - smoothstep( 0.36, 0.5, r );
    if ( a * vA < 0.3 ) discard;
    gl_FragColor = vec4( vCol * uColor, 1.0 );
  #else
    float a = 1.0 - smoothstep( 0.12, 0.5, r );
    gl_FragColor = vec4( uColor, a * vA * uOpacity );
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function fallMesh(n: number, box: THREE.Vector3, seedBase: number, leaf: boolean, u: Record<string, THREE.IUniform>): THREE.Mesh {
  let s = seedBase;
  const rnd = (): number => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const pos = new Float32Array(n * 12), seed = new Float32Array(n * 16), uv = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = rnd() * box.x, y = rnd() * box.y, z = rnd() * box.z, a = rnd(), b = rnd(), c = rnd(), d = rnd();
    for (let k = 0; k < 4; k++) {
      pos.set([x, y, z], i * 12 + k * 3);
      seed.set([a, b, c, d], i * 16 + k * 4);
      uv.set([k & 1, k >> 1], i * 8 + k * 2);
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: u, vertexShader: FALL_VERT, fragmentShader: FALL_FRAG, defines: leaf ? { LEAF: 1 } : {},
    transparent: !leaf, depthWrite: leaf, side: THREE.DoubleSide, fog: false,
  }));
  m.frustumCulled = false;
  m.renderOrder = leaf ? 0 : 901;
  m.visible = false;
  m.name = leaf ? 'leaves' : 'snowfall';
  return m;
}

/** A ploughed ridge: a lumpy half-ellipse, 1 m long, 1 m wide, 1 m high before its instance scale. */
function bankGeometry(): THREE.BufferGeometry {
  const L = 10, R = 8, pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= L; i++) {
    const u = i / L, end = Math.sin(Math.PI / 2 * Math.min(1, Math.min(u, 1 - u) * 3 + 0.15));
    for (let j = 0; j <= R; j++) {
      const a = Math.PI * j / R, lump = 1 + 0.07 * Math.sin(i * 1.9 + j * 1.3) + 0.04 * Math.sin(i * 3.7 - j * 2.1);
      pos.push(u - 0.5, Math.sin(a) * end * lump, Math.cos(a) * 0.5 * (0.7 + 0.3 * end) * lump);
    }
  }
  for (let i = 0; i < L; i++) for (let j = 0; j < R; j++) {
    const a = i * (R + 1) + j, b = a + R + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const CELL = 24;
const BANK_W = 1.1;

export class Snowfall {
  readonly flakes: THREE.Mesh;
  readonly leaves: THREE.Mesh;
  private readonly fu: Record<string, THREE.IUniform>;
  private readonly lu: Record<string, THREE.IUniform>;
  private readonly fOff = new THREE.Vector3();
  private readonly lOff = new THREE.Vector3();
  private time = 0;

  // Snowbanks: x, z, along-X (1) or along-Z (0), length, y; alive flags apart.
  private banks: Float32Array | null = null;
  private alive: Uint8Array | null = null;
  private grid = new Map<number, number[]>();
  private readonly bankMesh: THREE.InstancedMesh;
  private readonly cap: number;
  private readonly reach: number;
  private lastX = 1e9; lastZ = 1e9; private lastCover = -1;
  private dirty = true;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  /** Banks burst so far (tools read it). */
  bursts = 0;
  private breathT = 1;
  /** Snowbanks on/off (a switch for measuring). */
  banksOn = true;

  constructor(private game: Game, private low: boolean) {
    const q = game.quality;
    this.fu = {
      uOff: { value: this.fOff }, uBox: { value: FLAKE_BOX }, uAmount: { value: 0 }, uTime: { value: 0 },
      uSize: { value: 0.075 }, uSway: { value: 0.7 }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0.85 },
    };
    this.lu = {
      uOff: { value: this.lOff }, uBox: { value: LEAF_BOX }, uAmount: { value: 0 }, uTime: { value: 0 },
      uSize: { value: 0.09 }, uSway: { value: 1.4 }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 1 },
    };
    this.flakes = fallMesh(low ? 2200 : Math.round(10000 * Math.max(0.6, q.density)), FLAKE_BOX, 913, false, this.fu);
    this.leaves = fallMesh(low ? 150 : 420, LEAF_BOX, 4417, true, this.lu);
    game.scene.add(this.flakes, this.leaves);

    this.cap = low ? 260 : 900;
    this.reach = low ? 70 : 100;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.83, 0.89), roughness: 0.8, metalness: 0 });
    mat.userData.noSnow = true;
    this.bankMesh = new THREE.InstancedMesh(bankGeometry(), mat, this.cap);
    this.bankMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flip.mesh(this.bankMesh);
    this.bankMesh.count = 0;
    this.bankMesh.visible = false;
    this.bankMesh.frustumCulled = false;
    this.bankMesh.receiveShadow = true;
    this.bankMesh.castShadow = false;
    this.bankMesh.name = 'snowbanks';
    game.scene.add(this.bankMesh);
  }

  /**
   * Every frame, from the sky. fall: 0..1 snow in the air. storm: 0..1 how hard. leaves: 0..1 autumn.
   * light: the flakes' colour (the fog's, brightened), so they sit in the scene's light.
   */
  tick(dt: number, fall: number, storm: number, leaves: number, light: THREE.Color): void {
    this.time += dt;
    const fu = this.fu;
    this.flakes.visible = fall > 0.01;
    if (this.flakes.visible) {
      const wind = 0.6 + 4.5 * storm, o = this.fOff;
      o.x = (o.x + wind * dt) % (FLAKE_BOX.x * 10);
      o.y = (o.y - (1.2 + 0.8 * storm) * dt) % (FLAKE_BOX.y * 10);
      o.z = (o.z + wind * 0.45 * dt) % (FLAKE_BOX.z * 10);
      fu.uAmount.value = fall * (0.45 + 0.55 * storm);
      fu.uTime.value = this.time;
      (fu.uColor.value as THREE.Color).copy(light);
    }
    const near = leaves > 0 ? treeSeason.nearLeafy : 0;
    const la = leaves * Math.min(1, near / 3) * (1 - fall);
    this.leaves.visible = la > 0.01;
    if (this.leaves.visible) {
      const o = this.lOff;
      o.x = (o.x + 0.5 * dt) % (LEAF_BOX.x * 10);
      o.y = (o.y - 0.75 * dt) % (LEAF_BOX.y * 10);
      o.z = (o.z + 0.3 * dt) % (LEAF_BOX.z * 10);
      this.lu.uAmount.value = 0.12 + 0.6 * la;
      this.lu.uTime.value = this.time;
      (this.lu.uColor.value as THREE.Color).copy(light).multiplyScalar(0.55);
    }
  }

  /** Gameplay: the snowbanks near the camera, and the cars that hit them. Fx.update calls it. */
  update(dt: number): void {
    const g = this.game, cover = g.sky.snowCover;
    // Breath fog on foot in winter: a small puff every couple of seconds, a little quicker when running.
    const pl = g.player;
    if (g.sky.season === 'winter' && pl && !pl.vehicle) {
      this.breathT -= dt;
      if (this.breathT <= 0) {
        const p = pl.person;
        this.breathT = 1.6 + Math.random() * 1.2;
        g.fx?.emitters.breath(p.x, p.y + 1.6, p.z, Math.sin(p.h), Math.cos(p.h));
      }
    }
    const show = this.banksOn && cover > 0.12;
    if (!show) {
      if (this.bankMesh.visible) { this.bankMesh.visible = false; this.bankMesh.count = 0; }
      // Thawed: the ploughs will make new ones next time.
      if (cover < 0.03 && this.alive && this.bursts) { this.alive.fill(1); this.bursts = 0; }
      return;
    }
    if (!this.banks) this.build();
    const cam = g.camera.position;
    const cars = g.vehicles.list;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const vv = c.vx * c.vx + c.vz * c.vz;
      if (vv < 4) continue;
      const dx = c.x - cam.x, dz = c.z - cam.z;
      if (dx * dx + dz * dz > this.reach * this.reach) continue;
      this.hit(c);
    }
    if (this.dirty || Math.abs(cover - this.lastCover) > 0.03 || (cam.x - this.lastX) ** 2 + (cam.z - this.lastZ) ** 2 > 100) this.fill(cam.x, cam.z, cover);
  }

  private key(cx: number, cz: number): number { return (cx + 2000) * 4096 + (cz + 2000); }

  /** Every open street, both kerbs, cut into ridges of about 3 m with gaps, stopping short of the junctions. */
  private build(): void {
    const plan = this.game.plan, out: number[] = [];
    let s = 77;
    const rnd = (): number => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    for (const e of plan.edges) {
      if (e.closed || e.deck) continue;
      const A = plan.nodes[e.a], B = plan.nodes[e.b];
      const off = e.hw - BANK_W * 0.5 - 0.05;
      const t0 = (e.horiz ? A.x + A.hx : A.z + A.hz) + 3, t1 = (e.horiz ? B.x - B.hx : B.z - B.hz) - 3;
      for (const side of [-1, 1]) {
        let t = t0 + rnd() * 2;
        while (t < t1 - 1.5) {
          const len = Math.min(2.4 + rnd() * 1.8, t1 - t);
          const mid = t + len / 2;
          const x = e.horiz ? mid : A.x + side * off, z = e.horiz ? A.z + side * off : mid;
          const y = groundAt(x, z);
          // Not where the street runs over water (bridges, the causeway's edges).
          if (y > -0.5) out.push(x, z, e.horiz ? 1 : 0, len, y);
          t += len + (rnd() < 0.18 ? 3 + rnd() * 4 : 0.3 + rnd() * 0.6);
        }
      }
    }
    this.banks = new Float32Array(out);
    const n = out.length / 5;
    this.alive = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const k = this.key(Math.floor(out[i * 5] / CELL), Math.floor(out[i * 5 + 1] / CELL));
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(i);
    }
  }

  private hit(c: { x: number; y: number; z: number; vx: number; vz: number; hl: number; hw: number }): void {
    const b = this.banks!, al = this.alive!, cx = Math.floor(c.x / CELL), cz = Math.floor(c.z / CELL);
    const r = Math.max(c.hl, c.hw) * 0.85;
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const l = this.grid.get(this.key(gx, gz));
      if (!l) continue;
      for (const i of l) {
        if (!al[i]) continue;
        const o = i * 5, along = b[o + 2] > 0.5;
        const da = along ? c.x - b[o] : c.z - b[o + 1], dc = along ? c.z - b[o + 1] : c.x - b[o];
        if (Math.abs(da) > b[o + 3] * 0.5 + r || Math.abs(dc) > BANK_W * 0.5 + r * 0.8 || Math.abs(c.y - b[o + 4]) > 1.5) continue;
        al[i] = 0;
        this.dirty = true;
        this.bursts++;
        this.game.fx?.emitters.powder(b[o], b[o + 4] + 0.3, b[o + 1], c.vx, c.vz, 36);
        // Snow is heavy: a bank takes a bite out of the speed.
        c.vx *= 0.9; c.vz *= 0.9;
      }
    }
  }

  private fill(x: number, z: number, cover: number): void {
    this.lastX = x; this.lastZ = z; this.lastCover = cover; this.dirty = false;
    const b = this.banks!, al = this.alive!, R = this.reach, R2 = R * R, m = this.bankMesh;
    const arr = m.instanceMatrix.array as Float32Array;
    const h = 0.18 + 0.55 * Math.min(1, (cover - 0.12) / 0.6);
    let n = 0;
    const c0x = Math.floor((x - R) / CELL), c1x = Math.floor((x + R) / CELL), c0z = Math.floor((z - R) / CELL), c1z = Math.floor((z + R) / CELL);
    for (let gx = c0x; gx <= c1x && n < this.cap; gx++) for (let gz = c0z; gz <= c1z && n < this.cap; gz++) {
      const l = this.grid.get(this.key(gx, gz));
      if (!l) continue;
      for (const i of l) {
        if (!al[i]) continue;
        const o = i * 5, dx = b[o] - x, dz = b[o + 1] - z;
        if (dx * dx + dz * dz > R2) continue;
        const jit = 0.8 + 0.4 * ((i * 0.618) % 1);
        this.q.setFromAxisAngle(this.up, b[o + 2] > 0.5 ? 0 : Math.PI / 2);
        this.m4.compose(this.v.set(b[o], b[o + 4] - 0.05, b[o + 1]), this.q, this.sc.set(b[o + 3], h * jit, BANK_W));
        this.m4.toArray(arr, n * 16);
        if (++n >= this.cap) break;
      }
    }
    m.count = n;
    m.visible = n > 0;
    if (n) sendRange(m.instanceMatrix, n * 16);
  }
}
