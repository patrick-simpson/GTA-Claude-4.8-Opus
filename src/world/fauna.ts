// Wildlife (fun queue 2, item 33): deer, geese, gulls and, now and then at night, a black bear. Built on the moose's patterns
// (world/moose.ts): what is where is a pure function of the shared clock (sky.day and sky.hour), so every screen sees the
// same animal in the same place with nothing on the wire, and what happens to an animal locally (it hears a car, it is hit)
// is an offset on top of that which walks itself back to zero.
//
//   Deer      17 herds of two to four at fixed spots (world/faunaData.ts, made by tools/fauna/gen.mjs): the Muddle River's
//             banks, the woods round Johnson Pond, the country verges, the island's east shore. They graze, lift their heads
//             when you come within about 38 m, bolt when you are closer or a car comes fast, and walk home when it is quiet.
//             At dawn and dusk a few cross the country roads at the moose crossings. A car that hits one stops short, and the
//             deer tumbles, shakes itself and bounds off: same rules as the moose, scaled down.
//   Geese     11 flocks of four to seven on Johnson Pond, the river, Lake Indecision and their banks: they waddle and graze on
//             the bank, glide on the water, honk and flap off when you walk up, circle and come back. Every 70 game minutes or
//             so a V of seven flies down the river (or across the harbour).
//   Gulls     22 round the harbour, the pier (rail posts and lamp tops), the breakwater and the ferry: a cycle of perching,
//             taking off, circling and landing from the clock; they scatter when you walk up and cry now and then.
//   Bear      three visits a game night, each at a fixed site (the dumpsters behind Main St, a forest edge), from the clock: it
//             ambles in, forages, stands up on its hind legs when you come close, and lumbers off. It never attacks. A car
//             that hits one is stopped like by a moose.
//
// Models are code-built low-poly rigs (world/faunaRig.ts), each part one InstancedMesh written through game.flip. Nothing is
// simulated or drawn beyond its range, and under ?streets=old only the gulls (the island is the same) keep their harbour.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle, WorldPart } from '../core/api';
import type { RoadPed } from '../sim/traffic';
import { groundAt, WATER_Y, PIER, PIER_HEAD, DECK_Y, BREAKWATER } from './plan';
import { POND_LEVEL, pondSD, inPondBox } from './dithersPond';
import { waterLevelAt, riverX } from './mainland';
import { seaY } from './sea';
import { STREETS_NEW } from './streets';
import { DEER_SITES, GEESE_SITES, BEAR_SITES } from './faunaData';
import { Rig, Pose, SPECIES, type Kind } from './faunaRig';
import type { AudioCore } from '../audio/audio';
import { honk, gullCry, deerBlow, bearHuff } from '../audio/fauna';
import type { Moose } from './moose';

const EP = 96;
const NONE = -9999;
const TAU = Math.PI * 2;

function hash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1) ^ Math.imul(d + 0x7f4a7c15, 0xd3a2646c);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const twilight = (hour: number): number => {
  const near = (c: number, w: number): number => Math.max(0, 1 - Math.abs(hour - c) / w);
  return Math.min(1, near(6.5, 2.2) + near(18.75, 2.2));
};
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const smooth = (t: number): number => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

/** The water's surface at a point, or NONE on dry land. */
function surface(x: number, z: number): number {
  if (inPondBox(x, z) && pondSD(x, z) < 0.15) return POND_LEVEL;
  if (groundAt(x, z) < WATER_Y - 0.35) return z < -830 ? waterLevelAt(x, z) : seaY(x, z);
  return NONE;
}

// Modes.
const PATH = 0, ALERT = 1, BOLT = 2, BACK = 3, DOWN = 4, FLY = 5, RET = 6, STAND = 7, LUMBER = 8, GONE = 9;
// What the pure pose says an animal is doing.
const S_STILL = 0, S_WALK = 1, S_SWIM = 2, S_PERCH = 3, S_FLAP = 4, S_GLIDE = 5;
// Sources.
const SRC_HERD = 0, SRC_CROSS = 1, SRC_FLOCK = 2, SRC_GULL = 3, SRC_BEAR = 4, SRC_VEE = 5;

class Ani {
  kind: Kind = 'deer'; src = 0; key = 0; sid = 0; mem = 0; gen = 0;
  seed = 0; scale = 1; tint = 0xffffff; buck = false; fawn = false;
  /** Anchor (herd, flock) and where in the ring round it this one stays. */
  ax = 0; az = 0; ang = 0; ring = 0; wet = false;
  /** The shared pose, its height, state, and heading (pure). */
  px = 0; pz = 0; py = 0; ph = 0; st = 0; proll = 0;
  /** The pose as shown. */
  x = 0; y = 0; z = 0; h = 0; pitch = 0; roll = 0;
  /** Local offset from the pure pose (ground animals). */
  ox = 0; oz = 0; vx = 0; vz = 0;
  /** Local flight (geese, gulls): position, heading, turn rate, time left. */
  fx = 0; fy = 0; fz = 0; fh = 0; turn = 0; ft = 0;
  mode = PATH; mt = 0; cool = 0; delay = 0;
  gait = 0; flap = 0; spd = 0; noiseT = 5;
  /** Gull: its cycle, circle and centre; bear: its entry point. */
  P = 90; R = 25; H = 18; phi = 0; dir = 1; cen = 0;
  ex = 0; ez = 0; t0 = 0; dur = 0; walk = 0; side = 0; along = 0; stand = 0;
  onRoad = false; seen = false; vis = true;
  readonly pose = new Pose();
  reset(kind: Kind, src: number, key: number, sid: number, mem: number): void {
    this.kind = kind; this.src = src; this.key = key; this.sid = sid; this.mem = mem;
    this.mode = PATH; this.mt = 0; this.cool = 0; this.delay = 0; this.ox = this.oz = this.vx = this.vz = 0; this.roll = 0; this.pitch = 0;
    this.gait = 0; this.flap = 0; this.spd = 0; this.noiseT = 3 + Math.random() * 8; this.onRoad = false; this.seen = false; this.vis = true;
    this.buck = false; this.fawn = false; this.scale = 1; this.tint = 0xffffff; this.wet = false;
    const p = this.pose;
    p.gait = p.amp = p.head = p.up = p.flap = p.spread = p.dih = p.tail = 0; p.buck = false;
    this.x = this.y = this.z = NONE;
  }
}

interface Perch { x: number; y: number; z: number; h: number; kind: number }
interface Site { x: number; z: number; dx: number; dz: number; hw: number; len: number; land: number; name: string }
interface Cross { t0: number; n: number; walk: number; stand: number; side: number; along: number; wob: number }
interface BearEv { k: number; start: number; site: number; entry: number }

const KINDS: Kind[] = ['deer', 'goose', 'gull', 'bear'];
/** A map key from a source and an id. */
const K = (src: number, id: number): number => src * 1e9 + id;

// Ranges, m (low quality scales them down), and caps.
const R_DEER = 190, R_GOOSE = 240, R_GULL = 250, R_BEAR = 230, R_VEE = 420;
const CAP = { deer: 14, goose: 36, gull: 22, bear: 2 };
const CAP_LOW = { deer: 7, goose: 16, gull: 11, bear: 2 };
/** Deer cross where the moose do: this far off the road's middle they start and finish, m; walking pace, m per game minute. */
const OFF = 24, DV = 1.6, GRAZE = 5;
const DEER_BODY = [0.55, -0.5], DEER_R = 0.42;
const BEAR_BODY = [0.85, 0, -0.8], BEAR_R = 0.55;
const GULLS = 22, VEE_N = 7, VEE_PERIOD = 70, GULL_CEN: [number, number][] = [[0, 640], [150, 545], [-70, 560], [90, 505]];

const FIRST_DEER = 'A deer. At dusk they cross the country roads: watch the verges.';
const HIT_DEER = ['You hit a deer. The deer is fine. Your bumper is not.', 'The deer bounded off. Your insurer will want a word.', 'Deer: 1. Car: 0.', 'It shook itself off. The car did not.'];
const HIT_BEAR = ['You hit a bear. The bear is fine. Do not stop to check.', 'The bear has seen worse than a bumper.'];
const FIRST_BEAR = 'A black bear. Give it room: it only wants the bins.';

export class Fauna implements WorldPart {
  readonly stats = { deer: 0, geese: 0, gulls: 0, bears: 0, hits: 0, scares: 0, ms: 0, active: 0 };
  /** Tests: ignore the hash that says whether a herd is out, and show every site's animals. */
  always = false;
  /** Tests: pretend this crossing place has a crossing starting now. */
  forcedCross: { si: number; t0: number } | null = null;
  /** Tests: a bear event forced at this site, starting now (game minutes of the town clock). */
  forcedBear: { site: number; t0: number } | null = null;

  private readonly group = new THREE.Group();
  private readonly rigs: Partial<Record<Kind, Rig>> = {};
  private built = false;
  private readonly act = new Map<number, Ani>();
  private readonly list: Ani[] = [];
  private readonly free: Ani[] = [];
  private gen = 0;
  private readonly shown: Record<Kind, number> = { deer: 0, goose: 0, gull: 0, bear: 0 };
  private cap = CAP;
  private rangeK = 1;
  private clock = 0;
  private T = 0;
  private perches: Perch[] = [];
  private msites: Site[] = [];
  private cache: (Cross | null)[] = [];
  private cacheKey = -1;
  private readonly cc: Cross = { t0: 0, n: 1, walk: 0, stand: 0, side: 1, along: 0, wob: 0 };
  /** Pooled drivers' view of deer in the road: the first roadN are live. */
  private readonly rp: RoadPed[] = [];
  private roadN = 0;
  private herdSize: number[] = [];
  private readonly herdAlarm = new Float64Array(260);
  private readonly alarmDx = new Float32Array(260);
  private readonly alarmDz = new Float32Array(260);
  private readonly flockAlarm = new Float64Array(40);
  private readonly flockDx = new Float32Array(40);
  private readonly flockDz = new Float32Array(40);
  private readonly merged: RoadPed[] = [];
  private patched = false;
  private readonly th = { e: 1e9, d: 0, dx: 0, dz: 0, car: false };
  private readonly tmp = { x: 0, y: 0, z: 0, st: 0, h: 0, roll: 0 };
  private readonly tmp2 = { x: 0, y: 0, z: 0, st: 0, h: 0, roll: 0 };
  /** Tests: draw one animal of a kind in a given pose (looking at the models). */
  specimen: { kind: Kind; x: number; y: number; z: number; h: number; scale?: number; pose: Partial<Pose> } | null = null;
  private readonly specPose = new Pose();
  private soundT = 0;
  private toldDeer = false;
  private toldBear = false;
  private bearDay = -1;
  private bearEvs: BearEv[] = [];

  constructor(private readonly game: Game, parent: THREE.Group) {
    this.herdAlarm.fill(-100); this.flockAlarm.fill(-100);
    this.group.name = 'fauna';
    parent.add(this.group);
    (game as unknown as { fauna: Fauna }).fauna = this;
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  private build(): void {
    this.built = true;
    const g = this.game, mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, envMapIntensity: 0.5 });
    // Living animals shed snow (world/snowCover.ts).
    mat.userData.noSnow = true;
    // Its own program: the shared cache key (world/snowCover.ts) does not look at noSnow.
    mat.customProgramCacheKey = (): string => 'fauna';
    const sh = g.quality.shadows, fl = (m: THREE.InstancedMesh): void => { g.flip.mesh(m, true); };
    this.rigs.deer = new Rig(SPECIES.deer, CAP.deer, mat, this.group, fl, sh);
    this.rigs.goose = new Rig(SPECIES.goose, CAP.goose + VEE_N * 2, mat, this.group, fl, false);
    this.rigs.gull = new Rig(SPECIES.gull, CAP.gull, mat, this.group, fl, false);
    this.rigs.bear = new Rig(SPECIES.bear, CAP.bear, mat, this.group, fl, sh);
    this.msites = (g as unknown as { moose?: Moose }).moose?.sites ?? [];
    this.herdSize = DEER_SITES.map(() => 0);
    // Perches for the gulls: the pier's rail posts and lamp tops, the pier head's rail, the breakwater deck and the harbour.
    const per: Perch[] = [];
    const pierY = (z: number): number => DECK_Y * clamp((z - PIER.z0) / 10, 0, 1);
    for (let n = 8; n <= 56; n += 4) for (const sx of [-1, 1]) { const z = PIER.z0 + 2 + 2.8 * n; per.push({ x: sx * 9, y: pierY(z) + 1.12, z, h: sx > 0 ? -Math.PI / 2 : Math.PI / 2, kind: 0 }); }
    for (let z = 452; z < PIER_HEAD.z0; z += 24) for (const sx of [-1, 1]) per.push({ x: sx * 7.65, y: pierY(z) + 5.14, z, h: sx > 0 ? -1.2 : 1.2, kind: 1 });
    for (let n = 2; n <= 22; n += 4) for (const sx of [-1, 1]) { const z = PIER_HEAD.z0 + (n * (PIER_HEAD.z1 - PIER_HEAD.z0)) / 24; per.push({ x: sx * 34, y: DECK_Y + 1.12, z, h: sx > 0 ? -Math.PI / 2 : Math.PI / 2, kind: 0 }); }
    for (let x = BREAKWATER.x0 + 60; x < BREAKWATER.x1 - 10; x += 44) per.push({ x, y: groundAt(x, 256), z: 256 + ((x * 7) % 5) - 2, h: ((x * 13) % 6), kind: 2 });
    for (const [x, z] of [[60, 520], [-80, 560], [120, 610], [210, 520], [-150, 500], [20, 700], [-40, 630], [170, 590]]) per.push({ x, y: 0, z, h: (x * 3) % 6, kind: 3 });
    this.perches = per;
  }

  // ── Per frame ─────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game, sky = g.sky;
    if (!sky) return;
    if (!this.built) this.build();
    if (!this.patched) this.patchTraffic();
    const t0 = performance.now();
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    const low = g.quality.name === 'low';
    this.cap = low ? CAP_LOW : CAP;
    this.rangeK = low ? 0.65 : 1;
    const minutes = sky.hour * 60, day = Math.floor((sky as unknown as { day?: number }).day ?? 0);
    const T = day * 1440 + minutes;
    this.T = T;
    const ep = Math.floor(minutes / EP);
    const ck = day * 100 + ep;
    if (ck !== this.cacheKey) {
      this.cacheKey = ck;
      for (let i = 0; i < DEER_SITES.length; i++) {
        const h = (k: number): number => hash(i * 17 + 3, ep, day, k);
        const night = minutes < 270 || minutes > 1320, tw = twilight(sky.hour);
        const p = clamp(0.5 + 0.4 * tw - (night ? 0.22 : 0), 0, 1);
        this.herdSize[i] = h(0) < p ? 2 + Math.floor(h(1) * 3) : 0;
      }
      this.cache = this.msites.map((_, i) => this.crossing(i, ep, day));
    }
    this.gen++;
    this.shown.deer = this.shown.goose = this.shown.gull = this.shown.bear = 0;
    for (const a of this.list) this.shown[a.kind]++;
    for (let i = 0; i < 4; i++) (this.rigs[KINDS[i]] as Rig).begin();
    if (STREETS_NEW) {
      this.spawnHerds(day, minutes);
      this.spawnCrossings(minutes);
      this.spawnFlocks();
      this.spawnBears(T, day);
      this.spawnVees(T);
    }
    this.spawnGulls(T);
    // Release what is gone; update the rest.
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      if (a.gen !== this.gen) { this.drop(i); continue; }
      this.step(a, dt, T, minutes);
    }
    const sp = this.specimen;
    if (sp) { Object.assign(this.specPose, sp.pose); (this.rigs[sp.kind] as Rig).add(sp.x, sp.y, sp.z, sp.h, sp.scale ?? 1, 0, 0, this.specPose, 0xffffff); }
    for (let i = 0; i < 4; i++) (this.rigs[KINDS[i]] as Rig).end();
    this.roadN = 0;
    this.stats.deer = this.stats.geese = this.stats.gulls = this.stats.bears = 0;
    for (const a of this.list) {
      if (a.kind === 'deer') this.stats.deer++; else if (a.kind === 'goose') this.stats.geese++; else if (a.kind === 'gull') this.stats.gulls++; else this.stats.bears++;
      if (a.kind === 'deer' && a.onRoad && a.vis) for (const o of DEER_BODY) this.roadPed(a.x + Math.sin(a.h) * o, a.z + Math.cos(a.h) * o);
    }
    this.stats.active = this.list.length;
    this.stats.ms = performance.now() - t0;
  }

  private drop(i: number): void {
    const a = this.list[i];
    this.list[i] = this.list[this.list.length - 1]; this.list.pop();
    this.act.delete(a.key);
    this.free.push(a);
  }

  private get(kind: Kind, src: number, key: number, sid: number, mem: number): Ani | null {
    const have = this.act.get(key);
    if (have) { have.gen = this.gen; return have; }
    if (this.shown[kind] >= this.cap[kind]) return null;
    const a = this.free.pop() ?? new Ani();
    a.reset(kind, src, key, sid, mem);
    a.gen = this.gen;
    this.act.set(key, a); this.list.push(a); this.shown[kind]++;
    return a;
  }

  private near(x: number, z: number, r: number): boolean {
    const c = this.game.camera.position, dx = x - c.x, dz = z - c.z;
    return dx * dx + dz * dz < r * r;
  }

  // ── Deer ──────────────────────────────────────────────────────────────────

  private spawnHerds(day: number, minutes: number): void {
    void day; void minutes;
    const R = R_DEER * this.rangeK;
    for (let i = 0; i < DEER_SITES.length; i++) {
      const [hx, hz] = DEER_SITES[i];
      if (!this.near(hx, hz, R + 14)) continue;
      const n = this.always ? Math.max(3, this.herdSize[i]) : this.herdSize[i];
      for (let k = 0; k < 4; k++) {
        const key = K(SRC_HERD, i * 16 + k);
        const have = this.act.get(key);
        if (have) { have.gen = this.gen; continue; }
        if (k >= n || !this.near(hx, hz, R)) continue;
        const a = this.get('deer', SRC_HERD, key, i, k);
        if (!a) continue;
        const s = hash(i, k, 77, 1);
        a.seed = s; a.ax = hx; a.az = hz; a.ang = hash(i, k, 77, 2) * TAU; a.ring = 2 + hash(i, k, 77, 3) * 3.5;
        a.buck = k === 0 && hash(i, 0, 77, 4) < 0.5;
        a.fawn = n >= 3 && k === n - 1 && hash(i, n, 77, 5) < 0.45;
        a.scale = a.fawn ? 0.68 : a.buck ? 1.07 : 0.95 + s * 0.08;
        a.tint = [0xffffff, 0xf2e8da, 0xe9dcc8, 0xfbf3e6][Math.floor(hash(i, k, 77, 6) * 4)];
        this.deerPure(a, this.T);
        a.x = a.px; a.z = a.pz; a.y = groundAt(a.px, a.pz); a.h = a.ph = hash(i, k, 77, 7) * TAU;
      }
    }
  }

  /** The Cross for a crossing place, or null: the moose's rules, scaled for deer, at dusk and dawn more than at night. */
  private crossing(si: number, ep: number, day: number): Cross | null {
    const s = this.msites[si];
    if (!s || s.land !== 1) return null;
    const h = (k: number): number => hash(si * 29 + 11, ep, day, 100 + k);
    const hour = ((ep + 0.5) * EP) / 60, tw = twilight(hour), night = hour < 4.5 || hour > 22;
    if (h(0) >= (0.025 + 0.14 * tw) * (night ? 0.4 : 1)) return null;
    const walk = OFF / DV, stand = 6 + h(4) * 9, n = 1 + Math.floor(h(5) * 3), dur = GRAZE + 2 * walk + stand + n * 1.3;
    return { t0: ep * EP + h(1) * Math.max(0, EP - dur - 1), n, walk, stand, side: h(2) < 0.5 ? -1 : 1, along: (h(3) - 0.5) * Math.min(60, s.len * 0.4), wob: h(6) * TAU };
  }

  private spawnCrossings(minutes: number): void {
    const R = R_DEER * this.rangeK;
    const f = this.forcedCross;
    for (let i = 0; i <= this.msites.length; i++) {
      let c: Cross | null;
      let si = i;
      if (i === this.msites.length) {
        if (!f) break;
        si = f.si;
        c = { t0: f.t0, n: 3, walk: OFF / DV, stand: 14, side: 1, along: 0, wob: 1 };
      } else c = this.cache[i];
      const s = this.msites[si];
      if (!c || !s) continue;
      for (let k = 0; k < c.n; k++) {
        const key = K(SRC_CROSS, si * 100 + (i === this.msites.length ? 15 : Math.floor(minutes / EP) % 15) * 4 + k);
        const tau = minutes - c.t0 - k * 1.3, total = GRAZE + 2 * c.walk + c.stand;
        const have = this.act.get(key);
        if (have) { have.gen = this.gen; continue; }
        if (tau < 0 || tau > total) continue;
        this.crossPure(s, c, k, tau, this.tmp);
        if (!this.near(this.tmp.x, this.tmp.z, R)) continue;
        const a = this.get('deer', SRC_CROSS, key, 100 + si, k);
        if (!a) continue;
        a.seed = hash(si, k, 5, 1); a.ax = si; a.t0 = c.t0 + k * 1.3; a.walk = c.walk; a.stand = c.stand; a.side = c.side; a.along = c.along + (k - 1) * 1.5; a.ang = c.wob;
        a.scale = k === 2 && c.n === 3 ? 0.72 : 0.95 + a.seed * 0.08;
        a.fawn = a.scale < 0.8; a.buck = false;
        a.tint = [0xffffff, 0xf2e8da, 0xe9dcc8][k % 3];
        a.x = this.tmp.x; a.z = this.tmp.z; a.y = groundAt(a.x, a.z); a.h = this.tmp.h;
      }
    }
  }

  /** Where member k of crossing c is at path time tau (the moose's path, shorter): written into out. */
  private crossPure(s: Site, c: Cross, k: number, tau: number, out: { x: number; y: number; z: number; st: number; h: number; roll: number }): void {
    const total = GRAZE + 2 * c.walk + c.stand;
    tau = clamp(tau, 0, total);
    const lane = s.hw * 0.4, w1 = GRAZE + c.walk, w2 = w1 + c.stand;
    let d: number, st = S_WALK;
    if (tau < GRAZE) { d = OFF; st = S_STILL; }
    else if (tau < w1) d = lane + (OFF - lane) * (1 - (tau - GRAZE) / c.walk);
    else if (tau < w2) { d = lane; st = S_STILL; }
    else d = lane - (OFF + lane) * ((tau - w2) / c.walk);
    const px = -s.dz, pz = s.dx, al = c.along + (k - 1) * 1.5 + 1.2 * Math.sin(tau * 0.08 + c.wob);
    out.x = s.x + px * d * c.side + s.dx * al;
    out.z = s.z + pz * d * c.side + s.dz * al;
    out.st = st;
    out.h = Math.atan2(-px * c.side, -pz * c.side) + (st === S_STILL && tau >= GRAZE ? 0.6 * Math.sin((tau - w1) * 0.13) : 0);
    out.roll = d;
  }

  private deerPure(a: Ani, T: number): void {
    if (a.src === SRC_HERD) {
      const f = hash(a.sid, 91, 3, 1) * TAU, A = 3.3;
      a.px = a.ax + Math.cos(a.ang) * a.ring + A * Math.sin(T * 0.042 + f) + 0.7 * Math.sin(T * 0.19 + a.seed * 9);
      a.pz = a.az + Math.sin(a.ang) * a.ring + A * Math.sin(T * 0.034 + f * 1.7) + 0.7 * Math.sin(T * 0.23 + a.seed * 5);
      if (this.badGround(a.px, a.pz, a.y)) { a.px = a.ax; a.pz = a.az; }
      a.st = S_STILL;
    } else {
      const s = this.msites[a.ax];
      const c = this.tmp2;
      const minutes = this.game.sky!.hour * 60;
      // t0 is the episode's minute-of-day; across midnight the path simply ends.
      const tau = minutes - a.t0;
      const cc = this.cc;
      cc.t0 = a.t0; cc.walk = a.walk; cc.stand = a.stand; cc.side = a.side; cc.along = a.along; cc.wob = a.ang;
      this.crossPure(s, cc, 1, tau, c);
      a.px = c.x; a.pz = c.z; a.ph = c.h; a.st = c.st; a.proll = c.roll;
    }
  }

  /** True where a land animal cannot stand: water, or inside a wall. */
  private badGround(x: number, z: number, y: number): boolean {
    if (surface(x, z) !== NONE) return true;
    const gy = groundAt(x, z), col = this.game.col;
    void y;
    return col.pointBlocked(x, z, gy + 0.4) || col.pointBlocked(x, z, gy + 1.0);
  }

  /**
   * The nearest thing that would frighten an animal at (x, z): the player on foot (the more so the faster), or a car
   * (the more so the faster). Writes th.e, the distance scaled by how frightening it is (small is scary), and the way away.
   */
  private threat(x: number, z: number): boolean {
    const g = this.game, pl = g.player, th = this.th;
    th.e = 1e9;
    if (!pl.vehicle) {
      const dx = x - pl.x, dz = z - pl.z, d = Math.hypot(dx, dz);
      const k = pl.speed > 5.5 ? 1.35 : 0.55 + 0.45 * Math.min(1, pl.speed / 4.5);
      if (d / k < th.e) { th.e = d / k; th.d = d; th.dx = dx / (d || 1); th.dz = dz / (d || 1); th.car = false; }
    }
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.removed) continue;
      const dx = x - v.x, dz = z - v.z, d2 = dx * dx + dz * dz;
      if (d2 > 4900) continue;
      const sp = Math.abs(v.speed), k = sp > 2.5 ? 1 + Math.min(0.6, sp / 40) : sp > 0.4 ? 0.5 : 0.22, d = Math.sqrt(d2);
      if (d / k < th.e) { th.e = d / k; th.d = d; th.dx = dx / (d || 1); th.dz = dz / (d || 1); th.car = true; }
    }
    return th.e < 1e8;
  }

  // ── Geese ─────────────────────────────────────────────────────────────────

  private spawnFlocks(): void {
    const R = R_GOOSE * this.rangeK;
    for (let i = 0; i < GEESE_SITES.length; i++) {
      const [gx, gz, afloat] = GEESE_SITES[i];
      if (!this.near(gx, gz, R + 30)) continue;
      const n = 4 + Math.floor(hash(i, 5, 5, 5) * 4);
      for (let k = 0; k < n; k++) {
        const key = K(SRC_FLOCK, i * 16 + k), have = this.act.get(key);
        if (have) { have.gen = this.gen; continue; }
        if (!this.near(gx, gz, R)) continue;
        const a = this.get('goose', SRC_FLOCK, key, i, k);
        if (!a) continue;
        a.seed = hash(i, k, 6, 1); a.ax = gx; a.az = gz; a.ang = a.seed * TAU; a.ring = 0.8 + hash(i, k, 6, 2) * (afloat ? 3.2 : 2.4);
        a.scale = 0.92 + hash(i, k, 6, 3) * 0.14;
        a.tint = [0xffffff, 0xf3eee6, 0xe8e0d4][k % 3];
        a.wet = afloat === 1;
        this.goosePure(a, this.T);
        a.x = a.px; a.z = a.pz; a.y = a.py; a.h = a.ph = hash(i, k, 6, 4) * TAU;
      }
    }
  }

  private goosePure(a: Ani, T: number): void {
    const f = hash(a.sid, 33, 2, 1) * TAU, A = a.wet ? 5.5 : 3.0, w = a.wet ? 0.03 : 0.07;
    a.px = a.ax + Math.cos(a.ang) * a.ring + A * Math.sin(T * w + f) + 0.8 * Math.sin(T * 0.17 + a.seed * 9);
    a.pz = a.az + Math.sin(a.ang) * a.ring + A * Math.sin(T * w * 0.83 + f * 1.9) + 0.8 * Math.sin(T * 0.21 + a.seed * 5);
    const sf = surface(a.px, a.pz);
    if (sf !== NONE) { a.py = sf - 0.2; a.st = S_SWIM; }
    else {
      if (this.badGround(a.px, a.pz, 0)) { a.px = a.ax; a.pz = a.az; }
      a.py = groundAt(a.px, a.pz); a.st = S_STILL;
    }
  }

  // ── Gulls ─────────────────────────────────────────────────────────────────

  private spawnGulls(T: number): void {
    const c = this.game.camera.position;
    if (Math.hypot(c.x - 60, c.z - 560) > 780) return;
    const R = R_GULL * this.rangeK, n = this.game.quality.name === 'low' ? 12 : GULLS;
    for (let i = 0; i < n; i++) {
      const key = K(SRC_GULL, i), have = this.act.get(key);
      if (have) { have.gen = this.gen; continue; }
      // Work out where it is before taking a slot.
      const seed = hash(i, 8, 8, 1), P = 55 + hash(i, 8, 8, 2) * 55;
      const probe = this.tmp2;
      this.gullAt(i, seed, P, hash(i, 8, 8, 3) * TAU, hash(i, 8, 8, 4) < 0.5 ? -1 : 1, 24 + hash(i, 8, 8, 5) * 30, 13 + hash(i, 8, 8, 6) * 14, i % 4 === 0, T, probe);
      if (!this.near(probe.x, probe.z, R)) continue;
      const a = this.get('gull', SRC_GULL, key, i, i);
      if (!a) continue;
      a.seed = seed; a.P = P; a.phi = hash(i, 8, 8, 3) * TAU; a.dir = hash(i, 8, 8, 4) < 0.5 ? -1 : 1; a.R = 24 + hash(i, 8, 8, 5) * 30; a.H = 13 + hash(i, 8, 8, 6) * 14;
      a.cen = i % 4 === 0 ? -1 : i % GULL_CEN.length; a.scale = 1.2 + hash(i, 8, 8, 7) * 0.15;
      a.tint = 0xffffff;
      this.gullPure(a, T);
      a.x = a.px; a.y = a.py; a.z = a.pz; a.h = a.ph;
    }
  }

  private gullPure(a: Ani, T: number): void {
    const o = this.tmp, p = this.tmp2;
    this.gullAt(a.mem, a.seed, a.P, a.phi, a.dir, a.R, a.H, a.cen === -1, T, o);
    this.gullAt(a.mem, a.seed, a.P, a.phi, a.dir, a.R, a.H, a.cen === -1, T + 0.05, p);
    a.px = o.x; a.py = o.y; a.pz = o.z; a.st = o.st;
    if (o.st === S_PERCH) a.ph = o.h;
    else { const dx = p.x - o.x, dz = p.z - o.z; if (dx * dx + dz * dz > 1e-9) a.ph = Math.atan2(dx, dz); a.proll = o.roll; }
  }

  /** A gull's place in its cycle at clock T: perched, taking off, circling, or landing on its next perch. */
  private gullAt(i: number, seed: number, P: number, phi: number, dir: number, R: number, H: number, onFerry: boolean, T: number, o: { x: number; y: number; z: number; st: number; h: number; roll: number }): void {
    const per = this.perches, tt = T + seed * P, n = Math.floor(tt / P), u = tt - n * P;
    const S = P * 0.62, TO = 3.5, LD = 4.5;
    const A = per[Math.floor(hash(i, n, 11, 3) * per.length)], B = per[Math.floor(hash(i, n + 1, 11, 3) * per.length)];
    const ay = A.kind === 3 ? seaY(A.x, A.z) - 0.13 : A.y, by = B.kind === 3 ? seaY(B.x, B.z) - 0.13 : B.y;
    const jx = A.kind >= 2 ? (hash(i, n, 12, 1) - 0.5) * 2.2 : 0, jz = A.kind >= 2 ? (hash(i, n, 12, 2) - 0.5) * 2.2 : 0;
    if (u < S) { o.x = A.x + jx; o.z = A.z + jz; o.y = A.kind >= 2 ? (A.kind === 3 ? ay : groundAt(o.x, o.z)) : ay; o.st = S_PERCH; o.h = A.h + 0.8 * Math.sin(T * 0.07 + seed * 20); o.roll = 0; return; }
    let cx = GULL_CEN[i % GULL_CEN.length][0], cz = GULL_CEN[i % GULL_CEN.length][1];
    if (onFerry) { const fs = this.game.ferry.ferries; if (fs.length) { const f = fs[(i >> 2) % fs.length]; cx = f.x; cz = f.z; } }
    const th = phi + dir * (7 / R) * T, qx = cx + Math.cos(th) * R, qz = cz + Math.sin(th) * R;
    o.roll = -dir * 0.32;
    if (u < S + TO) {
      const e = smooth((u - S) / TO);
      o.x = A.x + jx + (qx - A.x - jx) * e; o.z = A.z + jz + (qz - A.z - jz) * e; o.y = ay + (H - ay) * e; o.st = S_FLAP; o.roll *= e;
    } else if (u < P - LD) { o.x = qx; o.z = qz; o.y = H + 1.6 * Math.sin(T * 0.3 + seed * 9); o.st = S_GLIDE; }
    else {
      const e = smooth((u - (P - LD)) / LD), bx = B.x + (B.kind >= 2 ? (hash(i, n + 1, 12, 1) - 0.5) * 2.2 : 0), bz = B.z + (B.kind >= 2 ? (hash(i, n + 1, 12, 2) - 0.5) * 2.2 : 0);
      o.x = qx + (bx - qx) * e; o.z = qz + (bz - qz) * e; o.y = H + (by - H) * e * e; o.st = e < 0.55 ? S_GLIDE : S_FLAP; o.roll *= 1 - e;
    }
  }

  // ── Geese in a V ──────────────────────────────────────────────────────────

  /** A V of geese on its flight: slot n of the clock; where its leader is at time T, and which way it faces. */
  private veeAt(n: number, T: number, out: { x: number; y: number; z: number; h: number }): boolean {
    const day = Math.floor(n * VEE_PERIOD / 1440);
    if (hash(n, day, 61, 1) >= 0.5) return false;
    const t0 = n * VEE_PERIOD + hash(n, day, 61, 2) * 12, tau = T - t0, speed = 14, route = hash(n, day, 61, 3) < 0.7;
    if (tau < 0) return false;
    const s = tau * speed;
    if (route) {
      // Autumn: south along the Muddle River, a little east of the water.
      const z = -2900 + s;
      if (z > -1000) return false;
      out.x = riverX(z) + 55; out.z = z; out.y = 58;
      const z2 = z + 20;
      out.h = Math.atan2(riverX(z2) - riverX(z), 20);
    } else {
      const x = -760 + s;
      if (x > 940) return false;
      out.x = x; out.z = 470 + 70 * Math.sin(x / 260 + n); out.y = 46; out.h = Math.atan2(1, 70 * Math.cos(x / 260 + n) / 260);
    }
    return true;
  }

  private spawnVees(T: number): void {
    const n1 = Math.floor(T / VEE_PERIOD), o = this.tmp;
    for (let n = n1; n >= n1 - 3; n--) {
      if (!this.veeAt(n, T, o)) continue;
      if (!this.near(o.x, o.z, R_VEE + 40)) continue;
      for (let j = 0; j < VEE_N; j++) {
        const key = K(SRC_VEE, n * 16 + j), have = this.act.get(key);
        if (have) { have.gen = this.gen; continue; }
        const a = this.get('goose', SRC_VEE, key, n, j);
        if (!a) continue;
        a.seed = hash(n, j, 62, 1); a.scale = 1.0; a.tint = [0xffffff, 0xf3eee6][j % 2];
        a.x = o.x; a.z = o.z; a.y = o.y; a.h = o.h; a.flap = a.seed * TAU;
      }
    }
  }

  // ── Bears ─────────────────────────────────────────────────────────────────

  /** The night's three visits for game day `day`: when each begins and where. Pure. */
  bearEvents(day: number): BearEv[] {
    const out: BearEv[] = [];
    const dumps: number[] = [], woods: number[] = [];
    BEAR_SITES.forEach((s, i) => { (s[3] ? dumps : woods).push(i); });
    for (let k = 0; k < 3; k++) {
      const start = 1200 + k * 180 + hash(day, k, 71, 1) * 150;
      const pool = k === 0 ? dumps : k === 1 ? woods : hash(day, k, 71, 2) < 0.5 ? dumps : woods;
      const site = pool.length ? pool[Math.floor(hash(day, k, 71, 3) * pool.length)] : 0;
      out.push({ k, start: day * 1440 + start, site, entry: Math.floor(hash(day, k, 71, 4) * 8) });
    }
    return out;
  }

  /** How long a visit lasts: in, foraging, out (game minutes). */
  private static readonly BEAR_IN = 6; private static readonly BEAR_STAY = 17; private static readonly BEAR_OUT = 6;

  /** The point the bear walks in from for site `site`: the first of eight directions with a clear walk, 22 m (then 14, then 8). */
  private entryOf(site: number, first: number): { x: number; z: number } {
    const [sx, sz, h] = BEAR_SITES[site], isDump = BEAR_SITES[site][3] === 1;
    for (const R of [22, 14, 8]) {
      for (let q = 0; q < 8; q++) {
        const ang = isDump ? h + Math.PI + (q - 3.5) * 0.35 : ((first + q) % 8) * (TAU / 8);
        const ex = sx + Math.sin(ang) * R, ez = sz + Math.cos(ang) * R;
        let ok = true;
        for (let t = 0.2; t <= 1.001 && ok; t += 0.2) { const x = sx + (ex - sx) * t, z = sz + (ez - sz) * t; if (this.badGround(x, z, 0) || Math.abs(groundAt(x, z) - groundAt(sx, sz)) > 1.2) ok = false; }
        if (ok) return { x: ex, z: ez };
      }
    }
    return { x: sx, z: sz };
  }

  private spawnBears(T: number, day: number): void {
    if (day !== this.bearDay) { this.bearDay = day; this.bearEvs = [...this.bearEvents(day - 1), ...this.bearEvents(day)]; }
    const R = R_BEAR * this.rangeK, total = Fauna.BEAR_IN + Fauna.BEAR_STAY + Fauna.BEAR_OUT;
    const fb = this.forcedBear;
    const n = this.bearEvs.length + (fb ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const ev = i < this.bearEvs.length ? this.bearEvs[i] : { k: 7, start: fb!.t0, site: fb!.site, entry: 3 };
      const tau = T - ev.start, key = K(SRC_BEAR, Math.floor(ev.start));
      const have = this.act.get(key);
      if (have) { have.gen = tau > total + 30 ? 0 : this.gen; continue; }
      if (tau < 0 || tau > total) continue;
      const [sx, sz] = BEAR_SITES[ev.site];
      if (!this.near(sx, sz, R)) continue;
      const a = this.get('bear', SRC_BEAR, key, ev.site, ev.k);
      if (!a) continue;
      const e = this.entryOf(ev.site, ev.entry);
      a.ex = e.x; a.ez = e.z; a.t0 = ev.start; a.seed = hash(ev.site, ev.k, 72, 1); a.scale = 0.94 + a.seed * 0.12;
      a.ax = sx; a.az = sz; a.ang = BEAR_SITES[ev.site][2];
      this.bearPure(a, T);
      a.x = a.px; a.z = a.pz; a.y = groundAt(a.x, a.z); a.h = a.ph;
    }
  }

  private bearPure(a: Ani, T: number): void {
    const tau = clamp(T - a.t0, 0, Fauna.BEAR_IN + Fauna.BEAR_STAY + Fauna.BEAR_OUT), isDump = BEAR_SITES[a.sid][3] === 1;
    const sx = a.ax, sz = a.az, tIn = Fauna.BEAR_IN, tOut = tIn + Fauna.BEAR_STAY;
    if (tau < tIn) { const u = smooth(tau / tIn); a.px = a.ex + (sx - a.ex) * u; a.pz = a.ez + (sz - a.ez) * u; a.st = S_WALK; a.ph = Math.atan2(sx - a.ex, sz - a.ez); }
    else if (tau < tOut) {
      // Foraging: at a dumpster, nose in the bin with now and then a stand to look in; at the woods a slow shuffle.
      const w = tau - tIn;
      a.px = sx + (isDump ? 0 : 1.2 * Math.sin(w * 0.35 + a.seed * 7)); a.pz = sz + (isDump ? 0 : 1.1 * Math.sin(w * 0.27 + a.seed * 3));
      a.st = S_STILL;
      a.ph = isDump ? a.ang + 0.12 * Math.sin(w * 0.8) : a.ang + 1.6 * Math.sin(w * 0.18 + a.seed * 5);
    } else { const u = smooth((tau - tOut) / Fauna.BEAR_OUT); a.px = sx + (a.ex - sx) * u; a.pz = sz + (a.ez - sz) * u; a.st = S_WALK; a.ph = Math.atan2(a.ex - sx, a.ez - sz); }
    a.py = groundAt(a.px, a.pz);
    a.proll = tau;
  }

  // ── One animal, one frame ─────────────────────────────────────────────────

  private step(a: Ani, dt: number, T: number, minutes: number): void {
    const g = this.game, cam = g.camera.position;
    let cd: number;
    switch (a.kind) {
      case 'deer': this.stepDeer(a, dt, T); break;
      case 'goose': if (a.src === SRC_VEE) this.stepVee(a, dt, T); else this.stepGoose(a, dt, T); break;
      case 'gull': this.stepGull(a, dt, T); break;
      case 'bear': this.stepBear(a, dt, T); break;
    }
    void minutes;
    // Range: drop a ground animal that has been left far behind (its pure pose will bring it back when we return).
    cd = Math.hypot(a.x - cam.x, a.z - cam.z);
    const R = (a.kind === 'deer' ? R_DEER : a.kind === 'goose' ? (a.src === SRC_VEE ? R_VEE : R_GOOSE) : a.kind === 'gull' ? R_GULL : R_BEAR) * this.rangeK;
    if (cd > R * 1.25 && a.mode === PATH) a.gen = 0;
    else if (cd > R * 1.6) a.gen = 0;
    a.vis = cd < R * 1.12 && a.mode !== GONE;
    if (!a.vis) return;
    const rig = this.rigs[a.kind] as Rig;
    const p = a.pose;
    p.gait = a.gait; p.flap = a.flap;
    rig.add(a.x, a.y, a.z, a.h, a.scale, a.pitch, a.roll, p, a.tint);
  }

  private face(a: Ani, target: number, dt: number, k: number): void { a.h += wrap(target - a.h) * Math.min(1, dt * k); }

  // Deer ---------------------------------------------------------------------

  private stepDeer(a: Ani, dt: number, T: number): void {
    const g = this.game, p = a.pose;
    const px0 = a.px, pz0 = a.pz;
    a.cool -= dt; a.mt += dt;
    this.deerPure(a, T);
    const th = this.threat(a.x, a.z), sid = a.sid;
    const e = th ? this.th.e : 1e9;
    const ALERT_E = 38, BOLT_E = 21;
    // The herd's alarm: one deer that bolts sets the rest off.
    const alarmed = this.herdAlarm[sid] > this.clock - 3;
    let moved = 0;
    if (a.mode === PATH || a.mode === BACK) {
      if (e < BOLT_E) this.startBolt(a, this.th.dx, this.th.dz, 1, true);
      else if (alarmed && this.clock - this.herdAlarm[sid] > 0.12 * a.mem) this.startBolt(a, this.alarmDx[sid], this.alarmDz[sid], 0.8, false);
      else if (e < ALERT_E) { a.mode = ALERT; a.mt = 0; this.say(a, 'blow'); }
    }
    if (a.mode === ALERT) {
      // Stand and stare at the thing; bolt if it comes on, go back to grazing when it goes.
      if (th) this.face(a, Math.atan2(-this.th.dx, -this.th.dz), dt, 5);
      if (e < BOLT_E) this.startBolt(a, this.th.dx, this.th.dz, 1, true);
      else if (alarmed && this.clock - this.herdAlarm[sid] > 0.1 * a.mem) this.startBolt(a, this.alarmDx[sid], this.alarmDz[sid], 1, false);
      else if (e > ALERT_E * 1.2 && a.mt > 2.2) { a.mode = Math.hypot(a.ox, a.oz) > 0.4 ? BACK : PATH; a.mt = 0; }
    } else if (a.mode === BOLT) {
      const sp = 8.6 * Math.min(1, a.mt * 4 + 0.35), nx = Math.sin(a.fh), nz = Math.cos(a.fh);
      moved = this.moveGround(a, nx * sp * dt, nz * sp * dt);
      this.face(a, a.fh, dt, 9);
      if (a.mt > 3.4 || (e > 60 && a.mt > 1.2)) { a.mode = ALERT; a.mt = 0; }
    } else if (a.mode === BACK) {
      if (e < ALERT_E * 0.9) { a.mode = ALERT; a.mt = 0; }
      else {
        const od = Math.hypot(a.ox, a.oz);
        if (od < 0.3) { a.ox = a.oz = 0; a.mode = PATH; }
        else { const st = Math.min(od, 2.2 * dt); moved = this.moveGround(a, -(a.ox / od) * st, -(a.oz / od) * st); this.face(a, Math.atan2(-a.ox, -a.oz), dt, 3); }
      }
    } else if (a.mode === DOWN) {
      // Hit by a car: thrown, rolled, then up and away.
      const k = Math.exp(-2.6 * dt);
      this.moveGround(a, a.vx * dt, a.vz * dt); a.vx *= k; a.vz *= k;
      a.roll = 1.35 * Math.sin(Math.min(1, a.mt / 0.22) * Math.PI / 2) * (a.mt < 1.5 ? 1 : Math.max(0, 1 - (a.mt - 1.5) / 0.5));
      if (a.mt > 2.0) { a.roll = 0; this.startBolt(a, a.vx || this.th.dx, a.vz || this.th.dz, 1, false); }
    }
    if (a.mode !== DOWN) a.roll += (0 - a.roll) * Math.min(1, dt * 8);
    // Where it stands: the shared pose plus the local offset.
    a.x = a.px + a.ox; a.z = a.pz + a.oz;
    if (a.mode === PATH) {
      // Moved by the shared pose alone: its gait follows what it covered; the heading follows the motion.
      moved = Math.hypot(a.px - px0, a.pz - pz0);
      if (a.src === SRC_CROSS) this.face(a, a.ph, dt, 2.5);
      else if (moved > dt * 0.05) this.face(a, Math.atan2(a.px - px0, a.pz - pz0), dt, 2.2);
    }
    a.y = groundAt(a.x, a.z);
    // Pose: gait, head, tail, hop.
    const bolting = a.mode === BOLT, speed = dt > 0 ? moved / dt : 0;
    a.gait += moved * (bolting ? 1.5 : 2.9);
    const walking = speed > 0.12 || (a.src === SRC_CROSS && a.st === S_WALK && a.mode === PATH);
    const ampT = bolting ? 0.85 : a.mode === DOWN ? 0.3 : walking ? 0.42 : 0;
    p.amp += (ampT - p.amp) * Math.min(1, dt * 6);
    const cyc = Math.sin(T * 0.31 + a.seed * 6.28);
    let headT: number;
    if (a.mode === ALERT) headT = 0;
    else if (bolting) headT = 0.28;
    else if (a.mode === DOWN) headT = 0.4;
    else if (a.src === SRC_CROSS) headT = walking ? 0.3 : Math.abs(a.proll) > OFF - 1 ? 1 : 0;
    else headT = walking ? 0.3 : cyc > -0.25 ? 1 : 0;
    p.head += (headT - p.head) * Math.min(1, dt * 2.6);
    const tailT = a.mode === ALERT || bolting || a.mode === DOWN ? 1 : 0;
    p.tail += (tailT - p.tail) * Math.min(1, dt * 7);
    p.buck = a.buck;
    if (bolting) a.y += Math.abs(Math.sin(a.gait)) * 0.2;
    // On the road: drivers see it.
    if (a.src === SRC_CROSS) { const s = this.msites[a.ax]; a.onRoad = Math.abs((a.x - s.x) * -s.dz + (a.z - s.z) * s.dx) < s.hw + 2.2; } else a.onRoad = false;
    this.collideDeer(a);
    if (!a.seen && Math.hypot(a.x - g.player.x, a.z - g.player.z) < 45) { a.seen = true; if (!this.toldDeer) { this.toldDeer = true; g.hud.toast(FIRST_DEER, 4); } }
    a.noiseT -= dt;
  }

  private startBolt(a: Ani, dx: number, dz: number, k: number, own: boolean): void {
    const sid = a.sid;
    a.mode = BOLT; a.mt = 0;
    // Away from the danger, bent a little toward cover (a hash of the animal) so a herd fans out.
    const base = Math.atan2(dx, dz) + (hash(a.sid, a.mem, 3, 3) - 0.5) * 0.9 * k;
    a.fh = base;
    // Only a deer that saw the danger itself raises the herd (one that merely follows does not keep the alarm going).
    if (own) { this.herdAlarm[sid] = this.clock; this.alarmDx[sid] = dx; this.alarmDz[sid] = dz; }
    this.stats.scares++;
  }

  /** Move a land animal by (mx, mz) if the ground there will hold it: a wall or water turns it. Returns the distance moved. */
  private moveGround(a: Ani, mx: number, mz: number): number {
    const nx = a.px + a.ox + mx, nz = a.pz + a.oz + mz;
    if (!this.badGround(nx, nz, a.y) && Math.abs(groundAt(nx, nz) - a.y) < 1.4) { a.ox += mx; a.oz += mz; return Math.hypot(mx, mz); }
    // Blocked: turn off to one side (a flee heading), keep what is left of the step.
    a.fh += (hash(a.sid, a.mem, 4, Math.floor(this.clock * 3)) < 0.5 ? 1 : -1) * 0.9;
    const m = Math.hypot(mx, mz) * 0.6, tx = a.px + a.ox + Math.sin(a.fh) * m, tz = a.pz + a.oz + Math.cos(a.fh) * m;
    if (!this.badGround(tx, tz, a.y) && Math.abs(groundAt(tx, tz) - a.y) < 1.4) { a.ox += tx - (a.px + a.ox); a.oz += tz - (a.pz + a.oz); return m; }
    return 0;
  }

  private collideDeer(a: Ani): void {
    const g = this.game, sh = Math.sin(a.h), ch = Math.cos(a.h);
    if (a.mode === DOWN && a.mt < 0.4) return;
    const R = a.fawn ? DEER_R * 0.75 : DEER_R;
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], rx = v.x - a.x, rz = v.z - a.z;
      if (rx * rx + rz * rz > 36 || Math.abs(v.y - a.y) > 2.2 || v.removed) continue;
      const vsh = Math.sin(v.h), vch = Math.cos(v.h);
      for (let b = 0; b < 2; b++) {
        const o = DEER_BODY[b], cx = a.x + sh * o, cz = a.z + ch * o, ox = cx - v.x, oz = cz - v.z;
        const lf = ox * vsh + oz * vch, lat = -ox * vch + oz * vsh;
        const ef = lf - Math.max(-v.hl, Math.min(v.hl, lf)), er = lat - Math.max(-v.hw, Math.min(v.hw, lat));
        let nlf: number, nlat: number, depth: number;
        const dd = Math.hypot(ef, er);
        if (dd > 1e-4) { if (dd >= R) continue; nlf = ef / dd; nlat = er / dd; depth = R - dd; }
        else { const pf = v.hl - Math.abs(lf), pr = v.hw - Math.abs(lat); if (pf < pr) { nlf = Math.sign(lf) || 1; nlat = 0; depth = pf + R; } else { nlf = 0; nlat = Math.sign(lat) || 1; depth = pr + R; } }
        const nx = nlf * vsh - nlat * vch, nz = nlf * vch + nlat * vsh, vn = v.vx * nx + v.vz * nz;
        if (vn > 1.2) this.hitDeer(a, v, vn, nx, nz);
        else if (vn > 0) { v.x -= nx * depth * 0.5; v.z -= nz * depth * 0.5; }
        else if (vn <= 0) continue;
      }
    }
    const pl = g.player;
    if (!pl.vehicle) {
      const per = pl.person;
      if (Math.abs(per.y - a.y) < 2.2) for (let b = 0; b < 2; b++) {
        const o = DEER_BODY[b], cx = a.x + sh * o, cz = a.z + ch * o, dx = per.x - cx, dz = per.z - cz, d = Math.hypot(dx, dz), r = R + 0.32;
        if (d < r && d > 1e-4) { per.x = cx + (dx / d) * r; per.z = cz + (dz / d) * r; }
      }
    }
  }

  private hitDeer(a: Ani, v: Vehicle, vn: number, nx: number, nz: number): void {
    const g = this.game;
    if (a.mode === DOWN) return;
    // A deer is a lot less than a moose: it takes some of the speed off, and the bumper some of its paint.
    const cut = Math.min(vn, 2 + vn * 0.55);
    v.vx -= nx * cut; v.vz -= nz * cut; v.yawRate *= 0.6;
    if (vn > 4) v.health = Math.max(0, v.health - Math.min(34, 5 + vn * 1.5));
    g.emit('impact', { vehicle: v, speed: Math.max(vn, 5), other: null, x: a.x - nx * DEER_R, z: a.z - nz * DEER_R });
    this.stats.hits++;
    a.mode = DOWN; a.mt = 0;
    const k = Math.min(9, 2.5 + vn * 0.7);
    a.vx = nx * k; a.vz = nz * k;
    this.herdAlarm[a.sid] = this.clock; this.alarmDx[a.sid] = -nx; this.alarmDz[a.sid] = -nz;
    this.say(a, 'blow');
    if (v === g.player.vehicle) g.hud.toast(pick(HIT_DEER), 3.5);
  }

  // Geese ---------------------------------------------------------------------

  private stepGoose(a: Ani, dt: number, T: number): void {
    const p = a.pose, g = this.game;
    const px0 = a.px, pz0 = a.pz;
    a.mt += dt; a.cool -= dt;
    if (a.mode === PATH) {
      this.goosePure(a, T);
      const th = this.threat(a.x, a.z), e = th ? this.th.e : 1e9, sid = a.sid;
      const alarmed = this.flockAlarm[sid] > this.clock - 2.5 && a.cool <= 0;
      if (e < (this.th.car ? 8 : 11)) this.takeOff(a, this.th.dx, this.th.dz, 9, 18 + Math.random() * 10);
      else if (alarmed && this.clock - this.flockAlarm[sid] > 0.08 * a.mem) this.takeOff(a, this.flockDx[sid], this.flockDz[sid], 9, 18 + Math.random() * 10);
      if (a.mode === PATH) {
        a.x = a.px; a.z = a.pz; a.y = a.py + (a.st === S_SWIM ? Math.sin(this.clock * 1.4 + a.seed * 9) * 0.012 : 0);
        const moved = Math.hypot(a.px - px0, a.pz - pz0), speed = dt > 0 ? moved / dt : 0;
        if (moved > dt * 0.04) this.face(a, Math.atan2(a.px - px0, a.pz - pz0), dt, 2.5);
        a.gait += a.st === S_SWIM ? 0 : moved * 5.2;
        p.amp += ((a.st !== S_SWIM && speed > 0.06 ? 0.55 : 0) - p.amp) * Math.min(1, dt * 5);
        p.spread += (0 - p.spread) * Math.min(1, dt * 6);
        const cyc = Math.sin(T * 0.37 + a.seed * 6.28);
        const headT = e < 22 ? 0 : a.st === S_SWIM ? (cyc > 0.7 ? 0.9 : 0) : cyc > -0.1 ? 1 : 0;
        p.head += (headT - p.head) * Math.min(1, dt * 2.6);
        a.pitch += (0 - a.pitch) * Math.min(1, dt * 6);
        a.roll += (0 - a.roll) * Math.min(1, dt * 6);
        // The beat of a wing for a moment after landing.
        if (p.spread > 0.02) a.flap += dt * 14;
      }
    } else this.flyStep(a, dt, T, 'goose');
    a.noiseT -= dt;
    if (a.noiseT <= 0) {
      a.noiseT = 7 + Math.random() * 16;
      if (Math.hypot(a.x - g.camera.position.x, a.z - g.camera.position.z) < 110 && a.mode === PATH) this.say(a, 'honk');
    }
  }

  /** Take off: away from (dx, dz), flapping, climbing, to circle for `secs` before coming home. A goose sets its whole flock off. */
  private takeOff(a: Ani, dx: number, dz: number, speed: number, secs: number): void {
    a.mode = FLY; a.mt = 0; a.cool = 6;
    a.fx = a.x; a.fy = a.y; a.fz = a.z;
    a.fh = Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.8;
    a.turn = (Math.random() < 0.5 ? -1 : 1) * (a.kind === 'gull' ? 0.5 : 0.28);
    a.ft = secs; a.spd = speed;
    this.stats.scares++;
    if (a.kind === 'goose') {
      this.flockAlarm[a.sid] = this.clock; this.flockDx[a.sid] = dx; this.flockDz[a.sid] = dz;
      this.say(a, 'honk');
    } else this.say(a, 'cry');
  }

  /** The flight of a scared bird: climb away in a wide circle for a while, then glide home to where the clock says it is. */
  private flyStep(a: Ani, dt: number, T: number, kind: 'goose' | 'gull'): void {
    const p = a.pose, goose = kind === 'goose';
    if (a.mode === FLY) {
      a.fh += a.turn * dt;
      const spd = a.spd * Math.min(1, 0.45 + a.mt * 0.6);
      a.fx += Math.sin(a.fh) * spd * dt; a.fz += Math.cos(a.fh) * spd * dt;
      const gy = Math.max(groundAt(a.fx, a.fz), 0), alt = goose ? 15 : 13 + a.seed * 8;
      a.fy += clamp(gy + alt - a.fy, -3 * dt, 5.5 * dt);
      a.ft -= dt;
      if (a.ft <= 0) { a.mode = RET; a.mt = 0; }
      p.dih = 0.25;
    } else {
      // Home: head for the shared pose, in 3D, on a glide slope into it.
      if (goose) this.goosePure(a, T); else this.gullPure(a, T);
      const tx = a.px, tz = a.pz, dx = tx - a.fx, dz = tz - a.fz, d = Math.hypot(dx, dz);
      const moving = a.st === S_FLAP || a.st === S_GLIDE;
      if (!moving && this.footNear(tx, tz, goose ? 16 : 11)) { a.mode = FLY; a.mt = 0; a.ft = 5; a.turn = (Math.random() < 0.5 ? -1 : 1) * 0.3; return; }
      a.fh += clamp(wrap(Math.atan2(dx, dz) - a.fh), -2.6 * dt, 2.6 * dt);
      const spd = moving ? 10.5 : Math.min(a.spd + 1, Math.max(3, d * 0.9));
      a.fx += Math.sin(a.fh) * spd * dt; a.fz += Math.cos(a.fh) * spd * dt;
      a.fy += clamp(a.py + (moving ? 0 : Math.min(d * 0.3, 14)) - a.fy, -4 * dt, 4 * dt);
      p.dih = 0.1;
      if (moving ? d < 3.5 : d < 2.4 && Math.abs(a.fy - a.py) < 1.2) {
        a.mode = PATH; a.x = a.px; a.z = a.pz; a.y = a.py; a.cool = 4; p.spread = 0.3; a.ox = a.oz = 0; a.mt = 0;
        return;
      }
    }
    a.x = a.fx; a.y = a.fy; a.z = a.fz;
    a.h = a.fh; a.roll = -clamp(a.turn * 0.9, -0.5, 0.5); a.pitch = 0;
    p.head = goose ? 0.45 : 0; p.amp = 0; a.gait = 0;
    p.spread = 1;
    a.flap += dt * (goose ? 16 : 13);
    // Calls overhead, quiet.
    a.noiseT -= dt;
    if (a.noiseT <= 0) { a.noiseT = 3 + Math.random() * 6; if (Math.hypot(a.x - this.game.camera.position.x, a.z - this.game.camera.position.z) < 120) this.say(a, goose ? 'honk' : 'cry'); }
  }

  private footNear(x: number, z: number, r: number): boolean {
    const pl = this.game.player;
    if (!pl.vehicle) return Math.hypot(pl.x - x, pl.z - z) < r;
    return Math.abs(pl.speed) > 3 && Math.hypot(pl.x - x, pl.z - z) < r * 1.5;
  }

  private stepVee(a: Ani, dt: number, T: number): void {
    const o = this.tmp, p = a.pose;
    const n = a.sid, j = a.mem;
    if (!this.veeAt(n, T, o)) { a.gen = 0; return; }
    // Seven in a V: the leader at the point, the rest in pairs back along either arm.
    const rank = Math.ceil(j / 2), side = j === 0 ? 0 : j % 2 ? 1 : -1, sh = Math.sin(o.h), ch = Math.cos(o.h);
    const back = rank * 3.4 + Math.sin(T * 0.1 + a.seed * 9) * 0.5, lat = side * rank * 2.7 + Math.sin(T * 0.13 + a.seed * 4) * 0.4;
    a.x = o.x - sh * back + ch * lat; a.z = o.z - ch * back - sh * lat;
    a.y = o.y + Math.sin(T * 0.4 + a.seed * 7) * 0.6 - rank * 0.2;
    a.h = o.h; a.roll = 0; a.pitch = 0;
    a.flap += dt * (15 + a.seed * 1.5);
    p.spread = 1; p.head = 0.45; p.amp = 0; p.dih = 0;
    a.noiseT -= dt;
    if (a.noiseT <= 0) { a.noiseT = 4 + Math.random() * 8; if (j === 0 && Math.hypot(a.x - this.game.camera.position.x, a.z - this.game.camera.position.z) < 200) this.say(a, 'honk'); }
  }

  // Gulls ---------------------------------------------------------------------

  private stepGull(a: Ani, dt: number, T: number): void {
    const p = a.pose;
    a.mt += dt; a.cool -= dt;
    if (a.mode === PATH) {
      this.gullPure(a, T);
      const th = this.threat(a.px, a.pz);
      if (a.st === S_PERCH && a.cool <= 0 && th && this.th.e < 8) {
        a.x = a.px; a.y = a.py; a.z = a.pz;
        this.takeOff(a, this.th.dx, this.th.dz, 6.5, 9 + Math.random() * 7);
        this.flyStep(a, dt, T, 'gull');
        return;
      }
      a.x = a.px; a.y = a.py; a.z = a.pz;
      if (a.st === S_PERCH) this.face(a, a.ph, dt, 3); else a.h = a.ph;
      a.roll += (a.proll - a.roll) * Math.min(1, dt * 4);
      a.pitch = a.st === S_FLAP ? -0.15 : 0;
      const flying = a.st === S_FLAP || a.st === S_GLIDE;
      p.spread += ((flying ? (a.st === S_GLIDE ? 0.28 : 1) : 0) - p.spread) * Math.min(1, dt * 5);
      p.dih += ((a.st === S_GLIDE ? 1 : 0.3) - p.dih) * Math.min(1, dt * 3);
      a.flap += dt * (a.st === S_GLIDE ? 3 : 13);
      p.amp = 0; a.gait = 0;
      p.head += ((a.st === S_PERCH ? 0.1 * Math.sin(T * 0.4 + a.seed * 20) : 0) - p.head) * Math.min(1, dt * 3);
    } else this.flyStep(a, dt, T, 'gull');
    a.noiseT -= dt;
    if (a.noiseT <= 0) {
      a.noiseT = 9 + Math.random() * 18;
      if (Math.hypot(a.x - this.game.camera.position.x, a.z - this.game.camera.position.z) < 90) this.say(a, 'cry');
    }
  }

  // Bears ---------------------------------------------------------------------

  private stepBear(a: Ani, dt: number, T: number): void {
    const g = this.game, p = a.pose;
    const px0 = a.px, pz0 = a.pz;
    a.mt += dt; a.cool -= dt;
    this.bearPure(a, T);
    const th = this.threat(a.x, a.z), e = th ? this.th.e : 1e9;
    const isDump = BEAR_SITES[a.sid][3] === 1;
    let moved = 0, upT = 0, headT = 0.3;
    if (a.mode === GONE) {
      // Out of sight, and not coming back while we are near its place.
      a.x = a.px + a.ox; a.z = a.pz + a.oz;
      if (a.mt > 5 && Math.hypot(a.px - g.player.x, a.pz - g.player.z) > 95) { a.mode = PATH; a.ox = a.oz = 0; a.cool = 20; a.mt = 0; }
      a.gen = this.gen;
      return;
    }
    if (a.mode === PATH) {
      if (a.st === S_STILL) {
        // Foraging.
        const w = T - a.t0 - Fauna.BEAR_IN;
        const cyc = 0.5 + 0.5 * Math.sin(w * 0.42 + a.seed * 6);
        if (isDump) { upT = 0.25 + 0.6 * smooth(cyc * 1.6 - 0.2); headT = 0.55 - 0.7 * upT; } else { upT = smooth((Math.sin(w * 0.23 + a.seed * 4) - 0.55) * 3) * 0.8; headT = 0.7 - 0.9 * upT; }
      }
      if (e < 15 && a.cool <= 0 && g.state === 'play') { a.mode = STAND; a.mt = 0; this.say(a, 'huff'); }
      moved = Math.hypot(a.px - px0, a.pz - pz0);
      if (moved > dt * 0.05) this.face(a, Math.atan2(a.px - px0, a.pz - pz0), dt, 2); else this.face(a, a.ph, dt, 1.5);
      a.x = a.px; a.z = a.pz;
    } else if (a.mode === STAND) {
      // Rears up and faces what came near, a moment, then thinks better of it.
      upT = 1; headT = -0.15;
      a.x = a.px + a.ox; a.z = a.pz + a.oz;
      if (th) this.face(a, Math.atan2(-this.th.dx, -this.th.dz), dt, 4);
      if (a.mt > 3.2 || (e < 6.5 && a.mt > 1.4)) { a.mode = LUMBER; a.mt = 0; a.fh = th ? Math.atan2(this.th.dx, this.th.dz) : a.h + Math.PI; a.cool = 14; }
      else if (e > 24 && a.mt > 1.6) { a.mode = PATH; a.mt = 0; a.cool = 10; }
    } else if (a.mode === LUMBER) {
      const sp = Math.min(4.6, a.mt * 5 + 1);
      moved = this.moveGround(a, Math.sin(a.fh) * sp * dt, Math.cos(a.fh) * sp * dt);
      a.x = a.px + a.ox; a.z = a.pz + a.oz;
      this.face(a, a.fh, dt, 5);
      headT = 0.25;
      if (a.mt > 4.5) { a.mode = GONE; a.mt = 0; }
    } else if (a.mode === DOWN) {
      a.x = a.px + a.ox; a.z = a.pz + a.oz;
      this.moveGround(a, a.vx * dt, a.vz * dt); const k = Math.exp(-3 * dt); a.vx *= k; a.vz *= k;
      upT = 0.5;
      if (a.mt > 1.0) { a.mode = LUMBER; a.mt = 0; a.fh = Math.atan2(a.vx || 1, a.vz || 0); a.cool = 14; }
    }
    a.y = groundAt(a.x, a.z);
    const speed = dt > 0 ? moved / dt : 0;
    a.gait += moved * (a.mode === LUMBER ? 1.9 : 2.4);
    const ampT = a.mode === LUMBER ? 0.6 : speed > 0.1 ? 0.4 : 0;
    p.amp += (ampT - p.amp) * Math.min(1, dt * 5);
    p.up += (upT - p.up) * Math.min(1, dt * 2.6);
    p.head += (headT - p.head) * Math.min(1, dt * 3);
    this.collideBear(a);
    if (!a.seen && Math.hypot(a.x - g.player.x, a.z - g.player.z) < 40) { a.seen = true; if (!this.toldBear) { this.toldBear = true; g.hud.toast(FIRST_BEAR, 4.5); } }
  }

  private collideBear(a: Ani): void {
    const g = this.game, sh = Math.sin(a.h), ch = Math.cos(a.h), R = BEAR_R * a.scale;
    const list = g.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], rx = v.x - a.x, rz = v.z - a.z;
      if (rx * rx + rz * rz > 64 || Math.abs(v.y - a.y) > 2.2 || v.removed) continue;
      const vsh = Math.sin(v.h), vch = Math.cos(v.h);
      for (let b = 0; b < 3; b++) {
        const o = BEAR_BODY[b] * (a.pose.up > 0.5 ? 0.35 : 1), cx = a.x + sh * o, cz = a.z + ch * o, ox = cx - v.x, oz = cz - v.z;
        const lf = ox * vsh + oz * vch, lat = -ox * vch + oz * vsh;
        const ef = lf - Math.max(-v.hl, Math.min(v.hl, lf)), er = lat - Math.max(-v.hw, Math.min(v.hw, lat));
        let nlf: number, nlat: number, depth: number;
        const dd = Math.hypot(ef, er);
        if (dd > 1e-4) { if (dd >= R) continue; nlf = ef / dd; nlat = er / dd; depth = R - dd; }
        else { const pf = v.hl - Math.abs(lf), pr = v.hw - Math.abs(lat); if (pf < pr) { nlf = Math.sign(lf) || 1; nlat = 0; depth = pf + R; } else { nlf = 0; nlat = Math.sign(lat) || 1; depth = pr + R; } }
        const nx = nlf * vsh - nlat * vch, nz = nlf * vch + nlat * vsh, vn = v.vx * nx + v.vz * nz;
        v.x -= nx * depth; v.z -= nz * depth;
        if (vn > 0) {
          if (vn > 2.5) this.hitBear(a, v, vn, nx, nz);
          else { v.vx -= vn * nx; v.vz -= vn * nz; }
        }
      }
    }
    const pl = g.player;
    if (!pl.vehicle) {
      const per = pl.person;
      if (Math.abs(per.y - a.y) < 2.2) for (let b = 0; b < 3; b++) {
        const o = BEAR_BODY[b] * (a.pose.up > 0.5 ? 0.35 : 1), cx = a.x + sh * o, cz = a.z + ch * o, dx = per.x - cx, dz = per.z - cz, d = Math.hypot(dx, dz), r = R + 0.32;
        if (d < r && d > 1e-4) { per.x = cx + (dx / d) * r; per.z = cz + (dz / d) * r; }
      }
    }
  }

  private hitBear(a: Ani, v: Vehicle, sp: number, nx: number, nz: number): void {
    const g = this.game;
    // A bear is nearly a moose: the car stops dead and pays for it. The bear is rattled, then lumbers off.
    v.vx = 0; v.vz = 0; v.yawRate *= 0.2;
    v.health = Math.max(0, v.health - (sp > 5 ? Math.min(55, 14 + sp * 2.1) : sp));
    g.emit('impact', { vehicle: v, speed: Math.max(sp, 6), other: null, x: a.x - nx * BEAR_R, z: a.z - nz * BEAR_R });
    this.stats.hits++;
    if (a.mode !== DOWN) {
      a.mode = DOWN; a.mt = 0; a.vx = nx * Math.min(3, 0.6 + sp * 0.2); a.vz = nz * Math.min(3, 0.6 + sp * 0.2);
      this.say(a, 'huff');
    }
    if (v === g.player.vehicle) g.hud.toast(pick(HIT_BEAR), 3.5);
  }

  // ── Traffic ───────────────────────────────────────────────────────────────

  private roadPed(x: number, z: number): void {
    let p = this.rp[this.roadN];
    if (!p) { p = { x: 0, z: 0, vx: 0, vz: 0 }; this.rp[this.roadN] = p; }
    p.x = x; p.z = z; this.roadN++;
  }

  /** Once: hand the deer standing in a road to the drivers alongside the people (and the moose) in it. */
  private patchTraffic(): void {
    this.patched = true;
    const amb = this.game.systems.find((s) => (s as { traffic?: unknown }).traffic) as unknown as
      { traffic: { update(dt: number, peds: readonly RoadPed[], jumped: boolean): void } } | undefined;
    if (!amb) return;
    const tr = amb.traffic, orig = tr.update.bind(tr);
    tr.update = (dt: number, peds: readonly RoadPed[], jumped: boolean): void => {
      if (this.roadN === 0) { orig(dt, peds, jumped); return; }
      const m = this.merged;
      m.length = 0;
      for (const p of peds) m.push(p);
      for (let i = 0; i < this.roadN; i++) m.push(this.rp[i]);
      orig(dt, m, jumped);
    };
  }

  // ── Sound ─────────────────────────────────────────────────────────────────

  private say(a: Ani, what: 'honk' | 'cry' | 'blow' | 'huff'): void {
    if (this.clock < this.soundT) return;
    const core: AudioCore | null | undefined = this.game.audio?.core;
    if (!core) return;
    const cam = this.game.camera.position;
    if (Math.hypot(a.x - cam.x, a.z - cam.z) > 150) return;
    const sp = core.place(a.x, a.y + 0.6, a.z, { ref: what === 'huff' ? 5 : what === 'cry' ? 9 : 6, max: 260, wet: 0.3 });
    if (!sp) return;
    this.soundT = this.clock + (what === 'cry' ? 1.1 : what === 'honk' ? 0.22 : 0.4);
    const t = core.now + sp.lag;
    if (what === 'honk') honk(core, t, sp.in, 0.9 + Math.random() * 0.25);
    else if (what === 'cry') gullCry(core, t, sp.in, 2 + Math.floor(Math.random() * 3), 0.92 + Math.random() * 0.2);
    else if (what === 'blow') deerBlow(core, t, sp.in, a.fawn ? 0.6 : 1);
    else bearHuff(core, t, sp.in, 1);
  }

  // ── For the photo challenges and for tests ────────────────────────────────

  /** Where the shown animals of a kind are: deer and gulls one by one, geese by flock (a point in the middle of three or more). */
  targets(kind: 'deer' | 'goose' | 'gull' | 'bear', out: { x: number; y: number; z: number; r: number }[]): void {
    if (kind === 'goose') {
      for (let i = 0; i < GEESE_SITES.length; i++) {
        let n = 0, sx = 0, sy = 0, sz = 0;
        for (const a of this.list) if (a.kind === 'goose' && a.src === SRC_FLOCK && a.sid === i && a.vis && a.mode === PATH) { n++; sx += a.x; sy += a.y; sz += a.z; }
        if (n >= 3) out.push({ x: sx / n, y: sy / n + 0.4, z: sz / n, r: 4.5 });
      }
      return;
    }
    for (const a of this.list) if (a.kind === kind && a.vis && a.x > NONE + 1) out.push({ x: a.x, y: a.y + (kind === 'deer' ? 0.9 : kind === 'bear' ? 0.9 : 0.35), z: a.z, r: kind === 'deer' ? 1.1 : kind === 'bear' ? 1.2 : 0.7 });
  }

  /** Test hook: what is drawn right now. */
  debug(): { kind: string; src: number; sid: number; mem: number; x: number; y: number; z: number; mode: number; st: number; roll: number; vis: boolean; up: number; spread: number; onRoad: boolean }[] {
    return this.list.map((a) => ({ kind: a.kind, src: a.src, sid: a.sid, mem: a.mem, x: a.x, y: a.y, z: a.z, mode: a.mode, st: a.st, roll: a.roll, vis: a.vis, up: a.pose.up, spread: a.pose.spread, onRoad: a.onRoad }));
  }
  /** Test hook: drawn animals of a kind. */
  count(kind: Kind): number { let n = 0; for (const a of this.list) if (a.kind === kind && a.vis) n++; return n; }
  /** Test hook: every perch the gulls use. */
  allPerches(): Perch[] { return this.perches; }
}
