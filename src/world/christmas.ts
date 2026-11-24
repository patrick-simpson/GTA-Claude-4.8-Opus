// The Christmas update (fun queue item 17): the towns dressed for the holidays, from late November to early January
// (world/holiday.ts; the settings menu's "Holiday decorations" can pin it on or off).
//
// What is here, all built the first time the season is on and hidden (not freed) when it goes off:
//   lights      emissive instanced bulbs, no real lights: strings along the eaves of most low buildings in both towns
//               (found from the collision boxes, so they follow any building that moves), spirals up every street
//               lamp, garland and strings across the street on Main St (Tepid Falls) and Calamity Ave (the island),
//               found from the street graph by name. Bulbs are chunked by 1000 m (few draw calls; the camera still culls a town behind it); they
//               twinkle in the vertex shader and glow brighter at night (Sky.night).
//   wreaths     on the lamp posts, on Postponement Hall, the Dead Letter Office, Pardon's and SpeedScan HQ
//   trees       a 12 m lit fir with a star in Mercy Park and on Quorum Square (public/models/christmas.glb from
//               tools/blender/christmas.py)
//   Pardon's and SpeedScan HQ: their fronts outlined in bulbs, a big bulb snowflake on each, candy-striped columns
//   inflatables a snowman and a penguin on a few front lawns, in the park and at HQ, breathing in the wind
//   Santa hats  on one hatless pedestrian in four, worn on the skinned head frame (ent/character.ts setHeadHook)
//   the sleigh  eight reindeer and a sleigh on a lap over the island at night; the lap passes over Pelican Pier's
//               fireworks site (fx/fireworks.ts: SHOW_X 0, SHOW_Z 800) low, so on a show night it flies through it
//   carollers   four in the park and four on the square, singing the Christmas station (audio/carols.ts) for whoever
//               stands near
//   presents    25 hidden in front yards around both towns: walk or drive into one. Found ones are kept in the save
//               (best['xmas.found'], a bit mask) and counted on the leaderboard (game/leaderboard.ts 'presents');
//               all 25 pays $2,500.
//   snowballs   X on foot (or the SNOWBALL button on a touch screen) when there is snow on the ground: a harmless
//               white splat on whatever it hits. Works in kid mode. This screen only: nothing is sent.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { Person } from '../core/api';
import { assets } from '../core/assets';
import { save } from '../game/save';
import { setHeadHook } from '../ent/character';
import { StationPlayer } from '../audio/radio';
import { CAROLS } from '../audio/carols';
import { holiday } from './holiday';
import { groundAt, type RoadEdge } from './plan';
import { SNOW_U } from './snowCover';
import { HQ } from './speedscanHQ';
import { PD } from './pardonsSite';
import { CIVIC } from './civicAssets';
import { RNG } from '../core/util';
import { flip } from '../core/flip';
import { STREETS_NEW } from './streets';
import { mainlandLots } from './mainlandBuildings';

const TAU = Math.PI * 2;
// 250 m chunks, each drawn only while the camera is within `far` of it (Christmas.cull): a string of bulbs is a speck
// beyond about 300 m and a garland beyond 150 m, so nothing is gained by drawing 30 000 bulbs from the other end of the
// island. (It was 1000 m chunks drawn always: 2.2 M triangles in every frame, a fixed cost anywhere in town.)
const CHUNK = 250;
export const PRESENTS = 25;
const FOUND_KEY = 'xmas.found';
const REWARD = 2500;

/** Where the two big trees stand. Mercy Park's is worked out from the park's blocks at build time. */
const SQUARE_TREE = STREETS_NEW ? { x: 113, z: -1795 } : { x: 4, z: -1468 };  // the lawn west of the bandstand
const TREE_H = 11.4, TREE_R = 4.3, TREE_Y0 = 1.2;

const WARM = [1.0, 0.72, 0.38], COOL = [0.75, 0.85, 1.0];
const MULTI = [[1, 0.12, 0.08], [0.1, 0.85, 0.2], [0.15, 0.35, 1], [1, 0.62, 0.05], [0.95, 0.2, 0.7]];
const RED = [1, 0.08, 0.06], WHITE = [1, 0.95, 0.9], GOLDB = [1, 0.75, 0.25];

const hash = (n: number): number => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };
export const popcount = (n: number): number => { let c = 0; for (let i = 0; i < PRESENTS; i++) if (n & (1 << i)) c++; return c; };
export function presentsFound(): number { return popcount(save.data.best[FOUND_KEY] ?? 0); }

interface BulbChunk { p: number[]; c: number[]; s: number[] }

/** Bulbs, garland or wreaths by 250 m chunk, made into one InstancedMesh each. */
interface Part { mesh: THREE.Object3D; x: number; y: number; z: number; reach: number }
class Scatter {
  readonly chunks = new Map<number, BulbChunk>();
  count = 0;
  constructor(readonly cap: number) {}
  add(x: number, y: number, z: number, col: number[], s: number): void {
    if (this.count >= this.cap) return;
    const k = Math.floor(x / CHUNK) * 4096 + Math.floor(z / CHUNK);
    let ch = this.chunks.get(k);
    if (!ch) this.chunks.set(k, (ch = { p: [], c: [], s: [] }));
    ch.p.push(x, y, z); ch.c.push(col[0], col[1], col[2]); ch.s.push(s);
    this.count++;
  }
  /** The chunk meshes made, with the distance each is drawn out to (see Christmas.cull). */
  readonly parts: Part[] = [];
  build(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, far: number): void {
    const m = new THREE.Matrix4(), c = new THREE.Color();
    for (const ch of this.chunks.values()) {
      const n = ch.s.length, mesh = new THREE.InstancedMesh(geo, mat, n);
      for (let i = 0; i < n; i++) {
        const s = ch.s[i];
        m.makeScale(s, s, s).setPosition(ch.p[i * 3], ch.p[i * 3 + 1], ch.p[i * 3 + 2]);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, c.setRGB(ch.c[i * 3], ch.c[i * 3 + 1], ch.c[i * 3 + 2]));
      }
      mesh.computeBoundingSphere();
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      const bs = mesh.boundingSphere!;
      this.parts.push({ mesh, x: bs.center.x, y: bs.center.y, z: bs.center.z, reach: far + bs.radius });
    }
  }
}

/** Glowing bulbs: unlit, a per-instance twinkle in the vertex shader, brighter by night. */
function bulbMaterial(glow: { value: number }, time: { value: number }): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  m.userData.noSnow = true;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow; sh.uniforms.uTime = time;
    sh.vertexShader = 'uniform float uGlow;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  float twk = fract( sin( float( gl_InstanceID ) * 12.9898 ) * 43758.5453 );
  vColor.rgb *= uGlow * ( 0.72 + 0.28 * sin( uTime * ( 0.8 + 2.4 * twk ) + twk * 40.0 ) );
#endif`);
  };
  m.customProgramCacheKey = () => 'xmas-bulb';
  return m;
}

/** A sagging string of bulbs from a to b: hooks every `hook` meters, bulbs every `gap`. */
function string(sc: Scatter, ax: number, ay: number, az: number, bx: number, by: number, bz: number, gap: number, sag: number, hook: number,
  pal: number[][], seed: number, size = 0.085): void {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const n = Math.max(1, Math.round(len / gap));
  for (let i = 0; i <= n; i++) {
    const t = i / n, d = t * len, f = hook >= len ? t : (d % hook) / hook;
    const y = ay + (by - ay) * t - sag * Math.sin(Math.PI * f);
    sc.add(ax + (bx - ax) * t, y, az + (bz - az) * t, pal[(seed + i) % pal.length], size);
  }
}

function edgePoly(g: Game, e: RoadEdge): number[] {
  if (e.pts) return e.pts;
  const nodes = g.plan.streets ? g.plan.streets.nodes : g.plan.nodes;
  const A = nodes[e.a], B = nodes[e.b];
  return [A.x, A.z, B.x, B.z];
}
function distPoly(pts: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], dx = pts[i + 2] - ax, dz = pts[i + 3] - az;
    const l2 = dx * dx + dz * dz, t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

interface Snowball { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }
interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }

export class Christmas {
  readonly group = new THREE.Group();
  readonly stats = { bulbs: 0, garland: 0, wreaths: 0, lamps: 0, roofs: 0, presents: 0, found: 0, built: false };
  private built = false;
  private loading = false;
  private readonly glow = { value: 1 };
  private readonly time = { value: 0 };
  private kit: Record<string, THREE.Mesh> = {};
  private stars: THREE.Mesh[] = [];
  private inflatables: THREE.Mesh[] = [];
  private sleigh: THREE.Group | null = null;
  private deer: THREE.InstancedMesh | null = null;
  private sleighT = 0;
  private presents: { x: number; y: number; z: number }[] = [];
  private presentMesh: THREE.InstancedMesh | null = null;
  private carollers: Person[] = [];
  private carolSpots: { x: number; z: number }[] = [];
  private carolPlayer: StationPlayer | null = null;
  private carolGain: GainNode | null = null;
  private parkTree = { x: 0, z: 0 };
  /** The trees' and inflatables' colliders: switched off with the season (Colliders has no remove; a dead prop is skipped). */
  private props: { alive: boolean }[] = [];
  // Santa hats
  private hats: THREE.InstancedMesh | null = null;
  private hatN = 0;
  private readonly hatM = new THREE.Matrix4();
  private readonly hatOff = new THREE.Matrix4();
  // Snowballs
  private balls: Snowball[] = [];
  private puffs: Puff[] = [];
  private marks: Puff[] = [];
  private ballMesh: THREE.InstancedMesh | null = null;
  private puffMesh: THREE.InstancedMesh | null = null;
  private throwKey = false;
  private cool = 0;
  private button: HTMLButtonElement | null = null;
  private was = false;
  /** Everything drawn by distance: the chunks of bulbs, garland and wreaths (Scatter.parts). */
  private parts: Part[] = [];
  private cullAt = 0;

  constructor(private readonly game: Game) {
    this.group.name = 'christmas';
    this.group.visible = false;
    game.scene.add(this.group);
    this.hatOff.compose(new THREE.Vector3(0, 0.155, -0.012), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.18, 0, 0)), new THREE.Vector3(1.02, 1.02, 1.02));
    addEventListener('keydown', (e) => { if (e.code === 'KeyX' && !e.repeat) this.throwKey = true; });
  }

  update(dt: number): void {
    const g = this.game, on = holiday.on;
    if (on && !this.built && !this.loading) this.build();
    if (on !== this.was) {
      this.was = on;
      this.group.visible = on && this.built;
      setHeadHook(on ? (p, m) => this.hat(p, m) : null);
      for (const p of this.props) p.alive = on;
      if (!on) this.dropCarollers();
      if (this.button) this.button.style.display = 'none';
    }
    if (!on || !this.built) { this.throwKey = false; return; }
    this.group.visible = true;
    const t = (this.time.value += dt), night = g.sky ? g.sky.night : 0;
    this.glow.value = 0.7 + 3.3 * night;
    for (const s of this.stars) s.rotation.y = t * 0.4;
    for (let i = 0; i < this.inflatables.length; i++) {
      const m = this.inflatables[i], w = Math.sin(t * 1.3 + i * 1.7) * 0.035;
      m.rotation.z = w; m.rotation.x = Math.sin(t * 0.9 + i) * 0.025;
      m.scale.set(1, 1 + Math.sin(t * 0.7 + i * 2.1) * 0.012, 1);
    }
    this.cull(t);
    this.flyHats();
    this.flySleigh(dt, night);
    this.carols(dt);
    this.lookForPresents();
    this.snowballs(dt);
  }

  /** Chunks beyond their reach are not drawn: a few dozen distance tests, a few times a second. */
  private cull(t: number): void {
    if (t < this.cullAt) return;
    this.cullAt = t + 0.12;
    const c = this.game.camera.position;
    for (const p of this.parts) {
      const dx = c.x - p.x, dz = c.z - p.z, dy = c.y - p.y, r = p.reach;
      p.mesh.visible = dx * dx + dy * dy + dz * dz < r * r;
    }
  }

  // ── Building it ────────────────────────────────────────────────────────────

  private build(): void {
    this.loading = true;
    // q=low and phones (the governor's lean medium) get a smaller set: fewer, wider-spaced bulbs, fewer roofs.
    const g = this.game, low = g.quality.name === 'low' || !!g.quality.lean;
    const bulbs = new Scatter(low ? 9000 : 30000), green = new Scatter(low ? 2000 : 9000), wreaths = new Scatter(low ? 500 : 1400);
    const bulbGeo = new THREE.OctahedronGeometry(1, 0);
    // Most wanted first: the cap falls on the eaves, which come last.
    this.parkTree = this.findPark();
    for (const tr of [this.parkTree, SQUARE_TREE]) this.treeBulbs(bulbs, tr.x, tr.z);
    this.shops(bulbs, green, wreaths);
    this.mainStreets(bulbs, green);
    this.lamps(bulbs, green, wreaths, low);
    this.roofs(bulbs, low);
    // Out to how far each is drawn: phones and q=low see less of the town at a time anyway.
    const fk = low ? 0.65 : 1;
    bulbs.build(bulbGeo, bulbMaterial(this.glow, this.time), this.group, 300 * fk);
    const garMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    green.build(new THREE.IcosahedronGeometry(1, 0), garMat, this.group, 140 * fk);
    const wreathGeo = this.wreathGeometry();
    wreaths.build(wreathGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), this.group, 120 * fk);
    this.parts = [...bulbs.parts, ...green.parts, ...wreaths.parts];
    this.stats.bulbs = bulbs.count; this.stats.garland = green.count; this.stats.wreaths = wreaths.count;
    this.placePresents();
    this.buildHats();
    this.buildSnowballs();
    this.built = true;
    this.stats.built = true;
    this.group.visible = true;
    void this.loadKit();
  }

  /** Strings along the eaves of most low buildings: the collision boxes that stand on the ground, 3 to 26 m tall. */
  private roofs(sc: Scatter, low: boolean): void {
    const g = this.game, share = low ? 0.3 : 0.5, gap = low ? 0.8 : 0.55;
    // Nearest the town centres first (the island's downtown, Tepid Falls' Main St), and whole roofs only: when the cap
    // is reached the outskirts go without, rather than the roofs in the middle of town getting thin.
    const centre = (b: { x0: number; x1: number; z0: number; z1: number }): number => { const x = (b.x0 + b.x1) / 2, z = (b.z0 + b.z1) / 2; return Math.min(Math.hypot(x, z), Math.hypot(x - 80, z + 1330)); };
    const boxes = g.col.allBoxes.map((b, n) => ({ b, n, d: centre(b) })).sort((p, q) => p.d - q.d);
    for (const { b, n } of boxes) {
      const i = n + 1;
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      if (Math.min(w, d) < 5 || Math.max(w, d) > 95 || w * d < 40) continue;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, gy = groundAt(cx, cz), h = b.y1 - gy;
      if (h < 3 || h > 16 || b.y0 > gy + 1.2) continue;
      const r = hash(Math.round(cx * 7.1 + cz * 3.3));
      if (r > share) continue;
      if (sc.count + Math.round(2 * (w + d) / gap) + 8 > sc.cap) continue;
      this.stats.roofs++;
      const k = Math.floor(hash(i + cx) * 10);
      const pal = k < 5 ? [WARM] : k < 8 ? MULTI : k < 9 ? [COOL] : [RED, [0.1, 0.8, 0.2]];
      const y = b.y1 - 0.12, o = 0.14;
      const c = [[b.x0 - o, b.z0 - o], [b.x1 + o, b.z0 - o], [b.x1 + o, b.z1 + o], [b.x0 - o, b.z1 + o]];
      for (let s = 0; s < 4; s++) {
        const A = c[s], B = c[(s + 1) % 4];
        string(sc, A[0], y, A[1], B[0], y, B[1], gap, 0.16, 1.9, pal, s * 7 + i);
      }
    }
  }

  /** Every street lamp: bulbs wound up the pole and a wreath. */
  private lamps(sc: Scatter, green: Scatter, wreaths: Scatter, low: boolean): void {
    const g = this.game, seen = new Set<unknown>();
    const each = (fn: (x: number, z: number, top: number, r: number) => void): void => {
      for (const [x, z, r] of [[0, 0, 900], [0, -1500, 1100]]) g.col.forProps(x, z, r, (p) => {
        if (seen.has(p) || (p.kind !== 'lamp' && p.kind !== 'post')) return;
        seen.add(p);
        const gy = groundAt(p.x, p.z), top = p.h - gy;
        if (top < 3.5 || top > 13 || p.r > 0.35) return;
        fn(p.x, p.z, top, p.r);
      });
    };
    let n = 0;
    each((x, z, top, r) => {
      n++;
      if (low && n % 2) return;
      const gy = groundAt(x, z), rr = Math.min(0.2, Math.max(0.08, r * 0.6)) + 0.04;
      const y0 = 1.0, y1 = Math.min(top - 1.2, 5.5), turns = 3, steps = low ? 9 : 14;
      const pal = n % 3 === 0 ? MULTI : n % 3 === 1 ? [RED, WHITE] : [WARM];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, a = t * turns * TAU + n;
        sc.add(x + Math.cos(a) * rr, gy + y0 + (y1 - y0) * t, z + Math.sin(a) * rr, pal[i % pal.length], 0.085);
      }
      if (n % 2 === 0) wreaths.add(x, gy + y1 + 0.55, z, [1, 1, 1], 0.42);
      this.stats.lamps++;
    });
    void green;
  }

  /** Main St and Calamity Ave: garland wound with the bulbs and strings across the street between facing lamps. */
  private mainStreets(sc: Scatter, green: Scatter): void {
    const g = this.game, s = g.plan.streets;
    const edges = s ? s.edges : g.plan.edges;
    const polys = edges.filter((e) => e.name === 'Main St' || e.name === 'Calamity Ave').map((e) => ({ pts: edgePoly(g, e), hw: e.hw }));
    if (!polys.length) return;
    const lamps: { x: number; z: number; top: number; gy: number }[] = [];
    const seen = new Set<unknown>();
    for (const [x, z, r] of [[0, 0, 900], [0, -1500, 1100]]) g.col.forProps(x, z, r, (p) => {
      if (seen.has(p) || p.kind !== 'lamp') return;
      seen.add(p);
      const gy = groundAt(p.x, p.z), top = p.h - gy;
      if (top < 3.5 || top > 13) return;
      for (const q of polys) if (distPoly(q.pts, p.x, p.z) < q.hw + 6) { lamps.push({ x: p.x, z: p.z, top, gy }); return; }
    });
    for (const L of lamps) {
      // A garland rope wound up the pole, under the bulbs.
      for (let i = 0; i <= 26; i++) {
        const t = i / 26, a = t * 4 * TAU;
        green.add(L.x + Math.cos(a) * 0.17, L.gy + 1 + 4.2 * t, L.z + Math.sin(a) * 0.17, [0.07, 0.25, 0.09], 0.11);
      }
      // Across the street: the nearest lamp 12..34 m away on the other side.
      let best: typeof L | null = null, bd = 34;
      for (const M of lamps) {
        if (M === L || M.x < L.x || (M.x === L.x && M.z < L.z)) continue;
        const d = Math.hypot(M.x - L.x, M.z - L.z);
        if (d > 12 && d < bd) {
          const mx = (M.x + L.x) / 2, mz = (M.z + L.z) / 2;
          if (polys.some((q) => distPoly(q.pts, mx, mz) < 3)) { bd = d; best = M; }
        }
      }
      if (best) {
        const ya = L.gy + Math.min(L.top - 0.6, 6), yb = best.gy + Math.min(best.top - 0.6, 6);
        string(sc, L.x, ya, L.z, best.x, yb, best.z, 0.4, 1.4, 1e9, MULTI, Math.round(L.x));
        // garland swag hung just under it
        const n = Math.round(bd / 0.18);
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          green.add(L.x + (best.x - L.x) * t, ya + (yb - ya) * t - 1.4 * Math.sin(Math.PI * t) - 0.15, L.z + (best.z - L.z) * t, [0.07, 0.25, 0.09], 0.1);
        }
      }
    }
  }

  /** Pardon's and SpeedScan HQ: fronts outlined, candy-striped columns, a bulb snowflake each, wreaths; the civic fronts' wreaths. */
  private shops(sc: Scatter, green: Scatter, wreaths: Scatter): void {
    // Pardon's: the storefront runs along world z = PD.ZF from x = PD.XE west for PD.SW, facing north over the lot.
    const pz = PD.ZF - 0.4, py = groundAt(PD.XE - 10, PD.ZF - 3);
    for (const [y, pal] of [[PD.SH + 0.1, MULTI], [PD.SOFFIT_Y + 0.15, [RED, WHITE, [0.1, 0.8, 0.2]]]] as [number, number[][]][])
      string(sc, PD.XE, py + y, pz, PD.XE - PD.SW, py + y, pz, 0.35, y > 5 ? 0.2 : 0.12, 1.6, pal, 3);
    for (const [a, b] of PD.DOORS) {
      const cx = PD.XE - (a + b) / 2;
      this.snowflake(sc, cx, py + PD.SH + 2.1, pz - 0.3, 1.7, 0);
      wreaths.add(cx, py + PD.SOFFIT_Y + 1.0, pz - 0.15, [1, 1, 1], 0.6);
      for (let i = 0; i <= 30; i++) green.add(cx - 2 + 4 * (i / 30), py + PD.SOFFIT_Y + 0.35 - 0.35 * Math.sin(Math.PI * i / 30), pz - 0.2, [0.07, 0.25, 0.09], 0.12);
    }
    // SpeedScan HQ: the canopy over the lobby door (model z 18.1, 8.5 m up), its two columns, the monument sign.
    const hy = groundAt(HQ.x, HQ.z + 20);
    string(sc, HQ.x - 14, hy + 9.1, HQ.z + 18.4, HQ.x + 14, hy + 9.1, HQ.z + 18.4, 0.3, 0.12, 1.4, [WARM], 0);
    string(sc, HQ.x - 14, hy + 7.85, HQ.z + 18.4, HQ.x + 14, hy + 7.85, HQ.z + 18.4, 0.3, 0.12, 1.4, MULTI, 1);
    for (const cx of [-12, 12]) {
      for (let i = 0; i <= 60; i++) {
        const t = i / 60, a = t * 9 * TAU;
        sc.add(HQ.x + cx + Math.cos(a) * 0.55, hy + 0.4 + 6.6 * t, HQ.z + 16.5 + Math.sin(a) * 0.55, Math.floor(t * 18) % 2 ? RED : WHITE, 0.075);
      }
      wreaths.add(HQ.x + cx * 0.75, hy + 8.5, HQ.z + 18.35, [1, 1, 1], 0.9);
    }
    this.snowflake(sc, HQ.x - 22, hy + 14, HQ.z + 10.3, 3.2, 0);
    this.snowflake(sc, HQ.x + 22, hy + 14, HQ.z + 10.3, 3.2, 0);
    string(sc, HQ.x + 13, hy + 3.5, HQ.z + 34.9, HQ.x + 31, hy + 3.5, HQ.z + 34.9, 0.3, 0.1, 1.2, MULTI, 2);
    // Postponement Hall's doors and the Dead Letter Office's loggia.
    const hall = CIVIC.hall, dlo = CIVIC.dlo;
    const hgy = groundAt(hall.x0 + hall.W / 2, hall.z + 4);
    for (const dx of [-6, 0, 6]) wreaths.add(hall.x0 + hall.W / 2 + dx, hgy + 4.8, hall.z + 0.35, [1, 1, 1], 1.0);
    string(sc, hall.x0, hgy + 3.4, hall.z + 0.4, hall.x0 + hall.W, hgy + 3.4, hall.z + 0.4, 0.4, 0.35, 2.5, [WARM], 0);
    // The new streets turned it to face west (frontage x = dlo.x, z0..z0+W); the old grid had it facing east (z0..z0-W).
    const dsx = STREETS_NEW ? -1 : 1, dsz = STREETS_NEW ? 1 : -1;
    const dgy = groundAt(dlo.x + 3 * dsx, dlo.z0 + dsz * dlo.W / 2);
    wreaths.add(dlo.x + 0.35 * dsx, dgy + 5.5, dlo.z0 + dsz * dlo.W / 2, [1, 1, 1], 1.1);
    string(sc, dlo.x + 0.4 * dsx, dgy + 4.2, dlo.z0, dlo.x + 0.4 * dsx, dgy + 4.2, dlo.z0 + dsz * dlo.W, 0.4, 0.35, 2.5, [WARM], 0);
  }

  /** A six-armed snowflake of bulbs in the plane facing +Z (rot about y). */
  private snowflake(sc: Scatter, x: number, y: number, z: number, r: number, rot: number): void {
    const cx = Math.cos(rot), sx = Math.sin(rot), put = (u: number, v: number): void => sc.add(x + u * cx, y + v, z - u * sx, COOL, 0.085);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      for (let i = 1; i <= 10; i++) put(ca * r * i / 10, sa * r * i / 10);
      for (const f of [0.5, 0.75]) for (const s of [-1, 1]) {
        const b = a + s * 0.75, bx = ca * r * f, by = sa * r * f;
        for (let i = 1; i <= 3; i++) put(bx + Math.cos(b) * r * 0.1 * i, by + Math.sin(b) * r * 0.1 * i);
      }
    }
    put(0, 0);
  }

  /** The middle of Mercy Park's lawn, clear of the pond: from the plan's park blocks. */
  private findPark(): { x: number; z: number } {
    const g = this.game;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const b of g.plan.blocks) if (b.district === 'park') {
      x0 = Math.min(x0, b.rect.x0); z0 = Math.min(z0, b.rect.z0); x1 = Math.max(x1, b.rect.x1); z1 = Math.max(z1, b.rect.z1);
    }
    if (!Number.isFinite(x0)) return { x: 120, z: -60 };
    // The south lawn by the promenade, off its centre line.
    return { x: (x0 + x1) / 2 - 14, z: z1 - 22 };
  }

  private treeBulbs(sc: Scatter, x: number, z: number): void {
    const gy = groundAt(x, z), n = 520;
    for (let i = 0; i < n; i++) {
      const t = i / n, y = TREE_Y0 + (TREE_H - TREE_Y0) * Math.pow(t, 0.85), a = t * 13 * TAU + hash(i) * 0.4;
      const r = TREE_R * (1 - (y - TREE_Y0) / (TREE_H - TREE_Y0 + 0.4)) * (0.9 + 0.12 * Math.abs(Math.sin(a * 4.5))) + 0.12;
      sc.add(x + Math.cos(a) * r, gy + y, z + Math.sin(a) * r, MULTI[i % MULTI.length], 0.11);
    }
    this.props.push(this.game.col.addProp(x, z, 1.4, gy + 12, 'tree', false));
  }

  private wreathGeometry(): THREE.BufferGeometry {
    // Cheap on purpose (a thousand of them): a five-sided ring of twelve segments and a bow.
    const ring = new THREE.TorusGeometry(0.62, 0.24, 5, 12);
    const bow = new THREE.BoxGeometry(0.42, 0.24, 0.12).translate(0, -0.62, 0.2);
    const parts = [ring.toNonIndexed(), bow.toNonIndexed()];
    const cols = [[0.06, 0.22, 0.08], [0.75, 0.04, 0.05]];
    parts.forEach((p, k) => {
      const c = cols[k === 0 ? 0 : 1], n = p.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
      p.setAttribute('color', new THREE.BufferAttribute(a, 3));
      p.deleteAttribute('uv');
    });
    // Hung facing both ways along x and z: two crossed wreaths read from every street.
    const one = mergeGeometries(parts) as THREE.BufferGeometry;
    return mergeGeometries([one, one.clone().rotateY(Math.PI / 2)]) as THREE.BufferGeometry;
  }

  // ── The Blender kit: trees, inflatables, presents, the sleigh ─────────────

  private async loadKit(): Promise<void> {
    const g = this.game;
    const buf = await assets.bytes('models/christmas.glb');
    if (!buf) return;
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    // Painted decorations stay their colours under a snowfall (world/snowCover.ts would whiten them entirely).
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { this.kit[o.name] = o as THREE.Mesh; ((o as THREE.Mesh).material as THREE.Material).userData.noSnow = true; } });
    const place = (name: string, x: number, z: number, h: number, s = 1): THREE.Mesh | null => {
      const src = this.kit[name];
      if (!src) return null;
      const m = new THREE.Mesh(src.geometry, src.material);
      m.position.set(x, groundAt(x, z), z); m.rotation.y = h; m.scale.setScalar(s);
      m.castShadow = name === 'tree' && g.quality.name !== 'low'; m.receiveShadow = true;
      this.group.add(m);
      this.parts.push({ mesh: m, x, y: m.position.y, z, reach: name === 'tree' ? 400 : 220 });
      return m;
    };
    // The trees and their stars.
    const starGeo = this.starGeometry(), starMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.2, 0.45), toneMapped: false });
    for (const tr of [this.parkTree, SQUARE_TREE]) {
      const tm = place('tree', tr.x, tr.z, 0);
      if (tm) { const mm = (tm.material as THREE.Material).clone(); mm.userData.noSnow = true; tm.material = mm; }
      const st = new THREE.Mesh(starGeo, starMat);
      st.position.set(tr.x, groundAt(tr.x, tr.z) + TREE_H + 0.75, tr.z);
      this.group.add(st); this.stars.push(st);
      this.parts.push({ mesh: st, x: tr.x, y: st.position.y, z: tr.z, reach: 400 });
    }
    // Inflatables: by the park tree, at HQ's plaza, on Quorum Square, outside Pardon's, and on a few front lawns.
    const spots: [string, number, number, number][] = [
      ['snowman', this.parkTree.x + 7, this.parkTree.z + 3, 0.3], ['penguin', this.parkTree.x - 7, this.parkTree.z + 4, -0.3],
      ['snowman', HQ.x - 40, HQ.z + 30, 0.4], ['penguin', HQ.x + 38, HQ.z + 28, -0.5],
      ['penguin', SQUARE_TREE.x + 6, SQUARE_TREE.z + 6, 0.2],
      ['snowman', PD.XE - 3, PD.ZF - 6, Math.PI], ['penguin', PD.XE - PD.SW + 4, PD.ZF - 6, Math.PI],
    ];
    const rng = new RNG(1225), lots = g.plan.lots.filter((l) => l.district === 'suburb');
    for (let i = 0; i < 6 && lots.length; i++) {
      const l = lots[rng.int(0, lots.length - 1)], r = l.rect, f = l.face;
      const fx = f === 1 ? r.x1 - 2.5 : f === 3 ? r.x0 + 2.5 : (r.x0 + r.x1) / 2 + 3;
      const fz = f === 0 ? r.z0 + 2.5 : f === 2 ? r.z1 - 2.5 : (r.z0 + r.z1) / 2 + 3;
      spots.push([i % 2 ? 'penguin' : 'snowman', fx, fz, [Math.PI, Math.PI / 2, 0, -Math.PI / 2][f]]);
    }
    for (const [n, x, z, h] of spots) { const m = place(n, x, z, h); if (m) { this.inflatables.push(m); this.props.push(g.col.addProp(x, z, 0.6, groundAt(x, z) + 2, 'post', false)); } }
    for (const p of this.props) p.alive = this.was;
    // The presents.
    const pr = this.kit.present;
    if (pr) {
      const pm = this.presentMesh = new THREE.InstancedMesh(pr.geometry, pr.material, PRESENTS);
      this.group.add(pm);
      this.showPresents();
    }
    // The sleigh: one sleigh and eight reindeer in pairs ahead of it.
    const sl = this.kit.sleigh, rd = this.kit.reindeer;
    if (sl && rd) {
      const grp = this.sleigh = new THREE.Group();
      grp.add(new THREE.Mesh(sl.geometry, sl.material));
      this.deer = new THREE.InstancedMesh(rd.geometry, rd.material, 8);
      this.deer.frustumCulled = false;
      flip.mesh(this.deer);
      grp.add(this.deer);
      // A little lantern on the dash so it can be seen against the night.
      const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 1.5, 0.6), toneMapped: false }));
      lamp.position.set(0, 1.5, 1.2);
      grp.add(lamp);
      // Bulbs along the sleigh's gold rail and down the reins, so it reads against the night sky.
      const sb = new Scatter(200);
      for (let i = 0; i <= 14; i++) for (const sx of [-0.78, 0.78]) sb.add(sx, 1.08, -1.05 + 2.4 * (i / 14), [WARM, RED, [0.1, 0.8, 0.2]][i % 3], 0.07);
      for (let i = 0; i <= 24; i++) for (const sx of [-0.5, 0.5]) sb.add(sx * (1 - i / 48), 1.0 + 0.2 * Math.sin(Math.PI * i / 24), 1.4 + 11 * (i / 24), GOLDB, 0.05);
      sb.build(new THREE.OctahedronGeometry(1, 0), bulbMaterial(this.glow, this.time), grp, 1e9);
      grp.children.forEach((c) => { c.frustumCulled = false; });
      grp.visible = false;
      this.group.add(grp);
    }
    // The carollers, now that their trees are up.
    this.carolSpots = [this.parkTree, SQUARE_TREE].map((t) => ({ x: t.x, z: t.z + 6.5 }));
  }

  private starGeometry(): THREE.BufferGeometry {
    const sh = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + Math.PI / 2, r = i % 2 ? 0.32 : 0.8;
      if (i) sh.lineTo(Math.cos(a) * r, Math.sin(a) * r); else sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    return new THREE.ExtrudeGeometry(sh, { depth: 0.16, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1 }).translate(0, 0, -0.08);
  }

  // ── Santa hats ─────────────────────────────────────────────────────────────

  private buildHats(): void {
    const cone = new THREE.ConeGeometry(0.105, 0.24, 12, 1, true).translate(0, 0.12, 0).rotateX(-0.35).translate(0, 0, 0.01);
    const brim = new THREE.TorusGeometry(0.1, 0.03, 6, 14).rotateX(Math.PI / 2);
    const pom = new THREE.IcosahedronGeometry(0.035, 1).translate(0, 0.225, 0.09);
    const paint = (geo: THREE.BufferGeometry, c: number[]): THREE.BufferGeometry => {
      const g2 = geo.toNonIndexed(); g2.deleteAttribute('uv');
      const n = g2.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) a.set(c, i * 3);
      g2.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g2;
    };
    const geo = mergeGeometries([paint(cone, [0.62, 0.03, 0.04]), paint(brim, [0.92, 0.92, 0.9]), paint(pom, [0.95, 0.95, 0.93])]) as THREE.BufferGeometry;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
    this.hats = new THREE.InstancedMesh(geo, mat, 256);
    this.hats.count = 0;
    this.hats.frustumCulled = false;
    this.hats.castShadow = false;
    flip.mesh(this.hats);
    this.group.add(this.hats);
  }

  /** Called from the crowd skinning for each person drawn: one in four hatless pedestrians, and every caroller. */
  private hat(p: Person, m: Float64Array): void {
    const hm = this.hats;
    if (!hm || this.hatN >= 256) return;
    const id = (p as unknown as { id: number }).id;
    const caroller = this.carollers.includes(p);
    if (!caroller && (id % 4 !== 1 || p.look.hat !== null || p === this.game.player.person)) return;
    const M = this.hatM;
    M.fromArray(m as unknown as number[]);
    M.multiply(this.hatOff);
    hm.setMatrixAt(this.hatN++, M);
  }

  private flyHats(): void {
    const hm = this.hats;
    if (!hm) return;
    // Rewritten every frame it is drawn, so it lives on two GPU copies (core/flip.ts): one unregistered buffer written
    // each frame puts the whole frame in step with the GPU (that was the Christmas update's 6 ms at night).
    if (this.hatN || hm.count) hm.instanceMatrix.needsUpdate = true;
    hm.count = this.hatN;
    hm.visible = this.hatN > 0;
    this.hatN = 0;
  }

  // ── The sleigh ─────────────────────────────────────────────────────────────

  /** A lap over the island: an ellipse whose north end is the fireworks site off Pelican Pier (0, 800). */
  private sleighAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const a = t * TAU;
    const x = 620 * Math.sin(a), z = 250 + 560 * Math.cos(a);
    // Low over the show site (a = 0), higher over the town.
    const y = 130 + 45 * (1 - Math.cos(a)) * 0.5 + 6 * Math.sin(a * 7);
    return out.set(x, y, z);
  }

  private flySleigh(dt: number, night: number): void {
    const grp = this.sleigh, deer = this.deer;
    if (!grp || !deer) return;
    const up = night > 0.55 || /[?&]sleigh=1/.test(location.search);
    grp.visible = up;
    if (!up) return;
    this.sleighT = (this.sleighT + dt / 130) % 1;  // about two minutes a lap at 28 m/s
    const p = this.sleighAt(this.sleighT, new THREE.Vector3()), q = this.sleighAt(this.sleighT + 0.002, new THREE.Vector3());
    grp.position.copy(p);
    grp.lookAt(q);
    // lookAt points +Z at the target for a non-camera object: the kit faces +Z, as wanted.
    const m = new THREE.Matrix4(), t = this.time.value;
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2), side = i % 2 ? 1 : -1;
      const bob = Math.sin(t * 7 + row * 0.9) * 0.25;
      m.makeRotationX(Math.sin(t * 7 + row * 0.9) * 0.12).setPosition(side * 0.8, 0.3 + bob + row * 0.15, 5.5 + row * 2.6);
      deer.setMatrixAt(i, m);
    }
    deer.instanceMatrix.needsUpdate = true;
  }

  // ── Carollers ──────────────────────────────────────────────────────────────

  private carols(dt: number): void {
    const g = this.game;
    if (!this.carolSpots.length) return;
    // Spawn them when the player is within 250 m of a tree; gone further off.
    let near = Infinity, nearSpot = this.carolSpots[0];
    for (const s of this.carolSpots) { const d = Math.hypot(g.player.x - s.x, g.player.z - s.z); if (d < near) { near = d; nearSpot = s; } }
    if (near < 110 && !this.carollers.length) {
      for (const s of this.carolSpots) for (let i = 0; i < 4; i++) {
        const a = -0.9 + i * 0.6, x = s.x + Math.sin(a) * 2.2, z = s.z + Math.cos(a) * 1.4;
        this.carollers.push(g.people.spawn(x, z, a * 0.5));
      }
    } else if (near > 140 && this.carollers.length) this.dropCarollers();
    for (const p of this.carollers) p.speed = 0;
    // Their singing: the Christmas station, louder the nearer she is.
    const core = g.audio?.core;
    if (!core) return;
    const level = near < 70 ? (1 - near / 70) : 0;
    if (level > 0 && !this.carolPlayer && core.ctx.state === 'running') {
      this.carolGain = core.ctx.createGain();
      this.carolGain.gain.value = 0;
      this.carolGain.connect(core.bus.ambience);
      this.carolPlayer = new StationPlayer(core, CAROLS, this.carolGain);
      this.carolPlayer.start(core.now + 0.05, g.time + CAROLS.seed * 13.7);
    }
    if (this.carolPlayer && this.carolGain) {
      this.carolGain.gain.setTargetAtTime(level * 2.2, core.now, 0.3);
      this.carolPlayer.pump(core.now);
      if (level === 0 && near > 90) { this.carolPlayer.stop(core.now); this.carolPlayer = null; this.carolGain = null; }
    }
    void nearSpot; void dt;
  }

  private dropCarollers(): void {
    for (const p of this.carollers) this.game.people.remove(p);
    this.carollers = [];
    const core = this.game.audio?.core;
    if (this.carolPlayer && core) this.carolPlayer.stop(core.now);
    this.carolPlayer = null; this.carolGain = null;
  }

  // ── Presents ───────────────────────────────────────────────────────────────

  /** 25 places, the same on every screen: front yards of island lots and of Tepid Falls' street lots, clear of buildings. */
  private placePresents(): void {
    const g = this.game, rng = new RNG(2512), out = this.presents;
    const clear = (x: number, z: number): boolean => {
      let hit = false;
      g.col.forBoxes(x, z, 0.6, (b) => { if (x > b.x0 - 0.5 && x < b.x1 + 0.5 && z > b.z0 - 0.5 && z < b.z1 + 0.5) hit = true; });
      return !hit && out.every((p) => Math.hypot(p.x - x, p.z - z) > 60);
    };
    const isle = g.plan.lots.filter((l) => !l.interior && l.district !== 'port');
    for (let tries = 0; out.length < 13 && tries < 400; tries++) {
      const l = isle[rng.int(0, isle.length - 1)], r = l.rect, f = l.face, s = rng.range(0.15, 0.85);
      const x = f === 1 ? r.x1 - 1.2 : f === 3 ? r.x0 + 1.2 : r.x0 + (r.x1 - r.x0) * s;
      const z = f === 0 ? r.z0 + 1.2 : f === 2 ? r.z1 - 1.2 : r.z0 + (r.z1 - r.z0) * s;
      if (clear(x, z)) out.push({ x, y: groundAt(x, z), z });
    }
    // Tepid Falls: the lots its buildings really stand on (mainlandBuildings.ts), so a front yard is outside the building.
    const main = mainlandLots(g.plan).filter((l) => !l.interior);
    for (let tries = 0; out.length < PRESENTS && tries < 600 && main.length; tries++) {
      const l = main[rng.int(0, main.length - 1)], r = l.rect, f = l.face, s = rng.range(0.15, 0.85);
      const x = f === 1 ? r.x1 - 1.2 : f === 3 ? r.x0 + 1.2 : r.x0 + (r.x1 - r.x0) * s;
      const z = f === 0 ? r.z0 + 1.2 : f === 2 ? r.z1 - 1.2 : r.z0 + (r.z1 - r.z0) * s;
      if (clear(x, z)) out.push({ x, y: groundAt(x, z), z });
    }
    this.stats.presents = out.length;
  }

  private showPresents(): void {
    const pm = this.presentMesh;
    if (!pm) return;
    const found = save.data.best[FOUND_KEY] ?? 0, m = new THREE.Matrix4(), c = new THREE.Color();
    this.stats.found = popcount(found);
    const tints = [0x1f7a3a, 0xb3121b, 0x2c6db3, 0x7a2cb3, 0xd4a72c];
    for (let i = 0; i < PRESENTS; i++) {
      const p = this.presents[i];
      if (!p || found & (1 << i)) m.makeScale(0, 0, 0);
      else m.makeRotationY(hash(i) * TAU).scale(new THREE.Vector3(1.3, 1.3, 1.3)).setPosition(p.x, p.y + 0.02, p.z);
      pm.setMatrixAt(i, m);
      pm.setColorAt(i, c.setHex(0xffffff).lerp(new THREE.Color(tints[i % tints.length]), 0.0));
    }
    pm.instanceMatrix.needsUpdate = true;
    pm.computeBoundingSphere();
  }

  private lookForPresents(): void {
    const g = this.game;
    if (g.state !== 'play' || !this.presentMesh) return;
    const reach = g.player.seated ? 3.2 : 1.6;
    let found = save.data.best[FOUND_KEY] ?? 0;
    for (let i = 0; i < this.presents.length; i++) {
      if (found & (1 << i)) continue;
      const p = this.presents[i];
      if (Math.abs(g.player.x - p.x) > reach || Math.abs(g.player.z - p.z) > reach || Math.hypot(g.player.x - p.x, g.player.z - p.z) > reach) continue;
      found |= 1 << i;
      save.data.best[FOUND_KEY] = found;
      const n = popcount(found);
      if (n >= PRESENTS) {
        g.player.money += REWARD;
        g.hud.toast(`All ${PRESENTS} presents found! The Harbor Authority's holiday bonus: $${REWARD.toLocaleString('en-US')}.`, 7);
      } else g.hud.toast(`A present! ${n} of ${PRESENTS} found.`, 3.5);
      save.write();
      this.showPresents();
    }
  }

  // ── Snowballs ──────────────────────────────────────────────────────────────

  private buildSnowballs(): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.9 });
    mat.userData.noSnow = true;
    this.ballMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 1), mat, 24);
    this.puffMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.07, 1), mat, 280);
    for (const m of [this.ballMesh, this.puffMesh]) { m.count = 0; m.frustumCulled = false; m.visible = false; flip.mesh(m); this.group.add(m); }
  }

  /** Snow on the ground (Sky.snowCover through SNOW_U), on foot, playing. */
  private canThrow(): boolean {
    const g = this.game;
    return g.state === 'play' && SNOW_U.value.x > 0.12 && !g.player.seated && !g.player.swimming;
  }

  private snowballs(dt: number): void {
    const g = this.game, can = this.canThrow();
    if (g.input.touch) this.touchButton(can);
    this.cool -= dt;
    if (this.throwKey && can && this.cool <= 0 && this.balls.length < 24) {
      this.cool = 0.35;
      const d = g.camera.getWorldDirection(new THREE.Vector3());
      const v = 19;
      this.balls.push({ x: g.player.x + d.x * 0.6, y: g.player.y + 1.6, z: g.player.z + d.z * 0.6, vx: d.x * v, vy: d.y * v + 4.5, vz: d.z * v, t: 0 });
      const pr = g.player.person;
      pr.h = Math.atan2(d.x, d.z);
    }
    this.throwKey = false;
    const m = new THREE.Matrix4();
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.vy -= 9.8 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.t += dt;
      let hit = b.y <= groundAt(b.x, b.z) + 0.08 || b.t > 4;
      if (!hit) g.col.forBoxes(b.x, b.z, 0.2, (bx) => { if (b.x > bx.x0 && b.x < bx.x1 && b.z > bx.z0 && b.z < bx.z1 && b.y > bx.y0 && b.y < bx.y1) hit = true; });
      if (!hit) for (const p of g.people.list) if (p !== g.player.person && Math.abs(p.x - b.x) < 0.45 && Math.abs(p.z - b.z) < 0.45 && b.y > p.y && b.y < p.y + 1.9) { hit = true; break; }
      if (!hit) for (const v of g.vehicles.list) if (Math.hypot(v.x - b.x, v.z - b.z) < 1.6 && b.y < v.y + 1.6) { hit = true; break; }
      if (hit) {
        for (let k = 0; k < 10 && this.puffs.length < 240; k++)
          this.puffs.push({ x: b.x, y: b.y, z: b.z, vx: (Math.random() - 0.5) * 3 - b.vx * 0.08, vy: Math.random() * 2.5, vz: (Math.random() - 0.5) * 3 - b.vz * 0.08, t: 0 });
        // A lump of snow left where it struck, for a few seconds.
        if (this.marks.length >= 40) this.marks.shift();
        this.marks.push({ x: b.x, y: Math.max(b.y, groundAt(b.x, b.z) + 0.02), z: b.z, vx: 0, vy: 0, vz: 0, t: 0 });
        this.balls.splice(i, 1);
      }
    }
    const bm = this.ballMesh, pm = this.puffMesh;
    // Idle (nothing in the air): hidden and not uploaded, so they cost nothing.
    if (bm && (this.balls.length || bm.count)) { this.balls.forEach((b, i) => bm.setMatrixAt(i, m.makeTranslation(b.x, b.y, b.z))); bm.count = this.balls.length; bm.visible = bm.count > 0; bm.instanceMatrix.needsUpdate = true; }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.t += dt; p.vy -= 7 * dt; p.x += p.vx * dt; p.y = Math.max(groundAt(p.x, p.z) + 0.03, p.y + p.vy * dt); p.z += p.vz * dt;
      if (p.t > 0.7) this.puffs.splice(i, 1);
    }
    for (let i = this.marks.length - 1; i >= 0; i--) if ((this.marks[i].t += dt) > 8) this.marks.splice(i, 1);
    if (pm && (this.puffs.length || this.marks.length || pm.count)) {
      const base = this.puffs.length;
      this.marks.forEach((k, i) => { const s = Math.min(1, (8 - k.t) / 2); pm.setMatrixAt(base + i, m.makeScale(3.2 * s, 0.9 * s, 3.2 * s).setPosition(k.x, k.y, k.z)); });
      this.puffs.forEach((p, i) => { const s = 1 - p.t / 0.7; pm.setMatrixAt(i, m.makeScale(s, s, s).setPosition(p.x, p.y, p.z)); });
      pm.count = Math.min(280, this.puffs.length + this.marks.length); pm.visible = pm.count > 0; pm.instanceMatrix.needsUpdate = true;
    }
  }

  private touchButton(show: boolean): void {
    if (!this.button) {
      const b = this.button = document.createElement('button');
      b.type = 'button'; b.textContent = 'SNOWBALL';
      b.style.cssText = 'position:fixed;right:18px;bottom:46%;z-index:30;padding:10px 12px;border-radius:22px;border:2px solid #fff;background:rgba(40,70,110,.55);color:#fff;font:600 13px "Barlow Semi Condensed",sans-serif;letter-spacing:.06em;display:none;touch-action:none';
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.throwKey = true; });
      document.body.appendChild(b);
    }
    const want = show ? 'block' : 'none';
    if (this.button.style.display !== want) this.button.style.display = want;
  }
}
