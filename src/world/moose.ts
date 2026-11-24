// Moose crossings (fun queue item 5): big Maine moose wander out of the trees onto the roads, stand there, and amble off.
//
// Where: crossing places picked from the road plan once at start. On the mainland the country roads (the Thruway,
// Town Line Rd, the far bank, Upriver Rd, Offramp Rd, Chapel Hill Rd) and anything near Lake Indecision, at any hour
// and more at dawn and dusk; on the island only the edge streets (Anchor Ave, Keel Row, Gull Heights Rd), and only at
// dawn and dusk. A yellow MOOSE CROSSING sign stands on four of the mainland places.
//
// When: the town clock is cut into 96-minute episodes (15 a day). For each place and episode a seeded hash of the place,
// the episode and the calendar date says whether a moose comes, what kind (a bull with antlers, or a cow, now and then
// with a calf at her heels), from which side, and how long it stands in the road. Where it is at any moment is a pure
// function of the clock: it grazes at the edge of the trees, walks out, stands in the road looking about, and walks off
// the other side. In a shared town the clock is the host's (sky.hour), so every screen sees the same moose in the same
// place without a byte on the wire. What happens to a moose locally (a car hits it, it charges you) is an offset on top
// of that path that walks itself back to zero.
//
// Solid: a car that hits one stops dead (crunch, heavy damage, the windscreen cracks); the moose staggers, shakes its
// head and carries on. It never dies; nothing is gory. Too close on foot and a bull (or a cow with her calf) lowers its
// head and charges, which knocks the player down as a ragdoll (Player.knockDown). Traffic stops for them and, after a
// while, honks: each moose in the road is handed to the drivers as three people standing in the lane (the traffic
// update is wrapped once, here; traffic.ts is not edited).
//
// Model: public/models/moose.glb from tools/blender/moose.py, one armature and eight skinned meshes (bull and cow at
// three levels of detail plus a far version; the calf is the cow, scaled and tinted). Phones (the low preset) never
// draw the nearest level and go to the far version sooner. At most MAX_SHOWN moose are drawn, each a SkeletonUtils
// clone with its own AnimationMixer (walk, trot, charge, graze, look, shake); no per-frame instance buffers.
//
// Cost: per frame a hash per place on episode change only, a distance check per active crossing, and for each moose
// shown a mixer update and a check against every car within reach.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Game } from '../core/game';
import type { Vehicle, WorldPart } from '../core/api';
import type { RoadPed } from '../sim/traffic';
import { assets } from '../core/assets';
import { groundAt, isWater } from './plan';
import { LAKE } from './mainland';
import { save } from '../game/save';
import type { AudioCore } from '../audio/audio';
import { bellow, grunt, hoof, snort } from '../audio/moose';

/** Episode length, game minutes; 15 to a day. */
const EP = 96;
/** How far off the road's middle a moose starts and finishes, m. */
const OFF = 30;
/** Path walking speed, m per game minute (a game minute is a real second at the default rate). */
const V = 1.25;
const GRAZE = 9;
/** The calf trails its mother by this many game minutes along the same path. */
const CALF_LAG = 3.2;
/** Native ground speed of each gait at time scale 1, m/s (tools/blender/moose.py's strides). */
const NATIVE: Record<string, number> = { walk: 0.9, trot: 3.3, charge: 5.5 };
const MAX_SHOWN = 8;
const SHOW_R = 450;
const CHARGE_V = 6.8;
/** Body circles along the heading (m from the middle) and their radius, for cars, the player and traffic. */
const BODY = [1.0, 0.0, -0.95];
const BODY_R = 0.62;

const RURAL = new Set(['The Thruway', 'Town Line Rd', 'Upriver Rd', 'Far Bank Rd', 'Offramp Rd', 'Chapel Hill Rd']);
const ISLAND_EDGE = new Set(['Anchor Ave', 'Keel Row', 'Gull Heights Rd']);
/**
 * The new streets (streets.ts): the plan's moose places (tepid-streets-plan.json moose_places) lie on these. Second Thought Ave
 * only out past the exit toward the lake; the town's own streets never.
 */
const RURAL_NEW = new Set(['The Thruway', 'Upriver Rd', 'Far Bank Rd', 'Offramp Rd', 'Chapel Hill Rd', 'Cherry Tree St', 'Dithers Loop', 'Blockhouse Rd', 'Second Thought Ave']);

const FIRST_HIT = 'You hit a moose. The moose is fine. The car is not.';
const HIT = ['The moose would like a word with your insurer.', 'Moose: 1. Car: 0.', 'It is still standing. Your bumper is not.', 'Like hitting a sofa made of granite.'];
const CHARGED = ['That is what the antlers are for.', 'The moose has asserted its right of way.', 'Lesson learned: do not hug the moose.', 'Flattened, politely, by a moose.'];
const SPOTTED_FIRST = 'A moose. Do not pet the moose.';

interface Site { x: number; z: number; dx: number; dz: number; hw: number; len: number; land: number; name: string }
interface Cross { t0: number; dur: number; walk: number; stand: number; side: number; along: number; bull: boolean; calf: boolean; wob: number }

type Mode = 'path' | 'stagger' | 'recover' | 'windup' | 'charge';

interface Beast {
  key: string;
  root: THREE.Group;
  meshes: Record<string, THREE.SkinnedMesh>;
  mixer: THREE.AnimationMixer;
  acts: Record<string, THREE.AnimationAction>;
  cur: string;
  bull: boolean; calf: boolean; mother: boolean;
  lod: string;
  x: number; z: number; h: number; y: number;
  /** Local offset from the shared path, and its velocity. */
  ox: number; oz: number; ovx: number; ovz: number;
  mode: Mode; mt: number; cool: number;
  hoofT: number; noiseT: number;
  onRoad: boolean;
  wob: number;
  used: boolean;
}

interface Crack { car: Vehicle; mesh: THREE.Mesh; t: number }

function hash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1) ^ Math.imul(d + 0x7f4a7c15, 0xd3a2646c);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 1 at dawn (5 to 8) and dusk (17 to 20.5), easing off around them; 0 in the middle of the day and night. */
function twilight(hour: number): number {
  const near = (c: number, w: number): number => Math.max(0, 1 - Math.abs(hour - c) / w);
  return Math.min(1, near(6.5, 2.2) + near(18.75, 2.2));
}

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

/** How far from the camera a crossing sign is drawn (m): it is 1 m wide, so past this it is a speck. */
const SIGN_SHOW = 450;

export class Moose implements WorldPart {
  readonly stats = { sites: 0, active: 0, shown: 0, hits: 0, charges: 0, knocks: 0, ms: 0, loaded: false };
  private readonly group = new THREE.Group();
  /** The crossing signs (three draws each): hidden beyond SIGN_SHOW so a far mainland costs no calls from downtown. */
  private readonly signGroups: THREE.Group[] = [];
  sites: Site[] = [];
  private cache: (Cross | null)[] = [];
  private cacheKey = '';
  private src: { scene: THREE.Object3D; anims: THREE.AnimationClip[] } | null = null;
  private loading = false;
  private beasts: Beast[] = [];
  private byKey = new Map<string, Beast>();
  private mats: { coat: THREE.MeshStandardMaterial; calf: THREE.MeshStandardMaterial } | null = null;
  private cracks: Crack[] = [];
  private crackMat: THREE.MeshBasicMaterial | null = null;
  private readonly roadPeds: (RoadPed & { on: boolean })[] = [];
  private readonly merged: RoadPed[] = [];
  private patched = false;
  private seen = new Set<string>();
  /** Test hook: force a crossing at this place index, starting now (game minutes). */
  forced: { si: number; t0: number; bull: boolean; calf: boolean; stand: number; side: number } | null = null;

  constructor(private readonly game: Game, parent: THREE.Group) {
    this.group.name = 'moose';
    parent.add(this.group);
    (game as unknown as { moose: Moose }).moose = this;
    this.pickSites();
    this.signs();
  }

  // ── Places ────────────────────────────────────────────────────────────────

  private pickSites(): void {
    const p = this.game.plan;
    const G = p.streets;
    if (G) {
      // Mainland crossings from the new graph: the longest straight piece of each rural road's edge, at least 40 m.
      for (let i = G.isle.edges; i < G.edges.length; i++) {
        const e = G.edges[i], pts = e.pts;
        if (!pts || e.deck || e.kind === 'ramp' || e.kind === 'bridge') continue;
        let best = -1, bl = 40;
        for (let k = 0; k + 3 < pts.length; k += 2) { const l = Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]); if (l > bl) { bl = l; best = k; } }
        if (best < 0) continue;
        const ax = pts[best], az = pts[best + 1], bx = pts[best + 2], bz = pts[best + 3], mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const ok = RURAL_NEW.has(e.name) ? e.name !== 'Second Thought Ave' || mx < -760 : Math.hypot(mx - LAKE.x, mz - LAKE.z) < 520 && e.kind !== 'arterial';
        if (!ok) continue;
        const dx = (bx - ax) / bl, dz = (bz - az) / bl;
        let dry = true;
        for (const s of [-1, 1]) for (const d of [8, 18, OFF]) if (isWater(mx - dz * d * s, mz + dx * d * s)) dry = false;
        if (!dry) continue;
        this.sites.push({ x: mx, z: mz, dx, dz, hw: e.hw, len: bl, land: 1, name: e.name });
      }
    }
    for (const e of p.edges) {
      if (G && e.land === 1) continue;
      if (e.deck) continue;
      const a = p.nodes[e.a], b = p.nodes[e.b];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 60) continue;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const ok = e.land === 1
        ? RURAL.has(e.name) || Math.hypot(mx - LAKE.x, mz - LAKE.z) < 520
        : ISLAND_EDGE.has(e.name);
      if (!ok) continue;
      const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
      // Both sides must be dry land the moose can come out of.
      let dry = true;
      for (const s of [-1, 1]) for (const d of [8, 18, OFF]) if (isWater(mx - dz * d * s, mz + dx * d * s)) dry = false;
      if (!dry) continue;
      this.sites.push({ x: mx, z: mz, dx, dz, hw: e.hw, len, land: e.land, name: e.name });
    }
    this.stats.sites = this.sites.length;
  }

  /** The crossing at place `si` in episode `ep` of day `day`, or null. Pure: the same on every screen. */
  private crossing(si: number, ep: number, day: number): Cross | null {
    const s = this.sites[si];
    const h = (k: number): number => hash(si * 31 + 7, ep, day, k);
    const hour = ((ep + 0.5) * EP) / 60;
    const tw = twilight(hour), night = hour < 4.5 || hour > 22;
    const chance = s.land === 1 ? (0.035 + 0.085 * tw) * (night ? 0.5 : 1) : 0.07 * tw;
    if (h(0) >= chance) return null;
    const walk = OFF / V, stand = 10 + h(4) * 16;
    const dur = GRAZE + 2 * walk + stand + CALF_LAG;
    const bull = h(1) < 0.42;
    return {
      t0: ep * EP + h(5) * Math.max(0, EP - dur - 1), dur, walk, stand,
      side: h(2) < 0.5 ? -1 : 1, along: (h(3) - 0.5) * Math.min(80, s.len * 0.5),
      bull, calf: !bull && h(6) < 0.45, wob: h(7) * 6.28,
    };
  }

  /** Where an animal on crossing `c` is at path time `tau`. */
  private pathAt(s: Site, c: Cross, tau: number, out: { x: number; z: number; s: number; anim: string; h: number }): boolean {
    if (tau < 0 || tau > GRAZE + 2 * c.walk + c.stand) return false;
    let d: number, anim: string;
    const w1 = GRAZE + c.walk, w2 = w1 + c.stand;
    // It stands in the lane on its own side (not on a divided road's barrier), then walks on across.
    const lane = s.hw * 0.4;
    if (tau < GRAZE) { d = OFF; anim = 'graze'; }
    else if (tau < w1) { d = lane + (OFF - lane) * (1 - (tau - GRAZE) / c.walk); anim = 'walk'; }
    else if (tau < w2) { d = lane; anim = 'look'; }
    else { d = lane - (OFF + lane) * ((tau - w2) / c.walk); anim = 'walk'; }
    const px = -s.dz, pz = s.dx;
    const a = c.along + 1.8 * Math.sin(tau * 0.09 + c.wob);
    out.x = s.x + px * d * c.side + s.dx * a;
    out.z = s.z + pz * d * c.side + s.dz * a;
    out.s = d;
    out.anim = anim;
    // Heading: across the road toward the far side, bent by the wander; standing, a slow turn to look along it.
    const da = 1.8 * 0.09 * Math.cos(tau * 0.09 + c.wob) / V;
    const fx = -px * c.side + s.dx * da, fz = -pz * c.side + s.dz * da;
    out.h = Math.atan2(fx, fz) + (anim === 'look' ? 0.5 * Math.sin((tau - w1) * 0.12) : anim === 'graze' ? 0.4 * Math.sin(c.wob) : 0);
    return true;
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  private load(): void {
    this.loading = true;
    void (async () => {
      const buf = await assets.bytes('models/moose.glb');
      if (!buf) return;
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      const coat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, envMapIntensity: 0.5 });
      // Living animals shed snow (world/snowCover.ts).
      coat.userData.noSnow = true;
      const calf = coat.clone();
      calf.color.setRGB(1.75, 1.3, 1.0);
      this.mats = { coat, calf };
      gltf.scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isSkinnedMesh) { m.material = coat; m.frustumCulled = false; }
      });
      this.src = { scene: gltf.scene, anims: gltf.animations };
      this.stats.loaded = true;
    })().catch((e) => { console.warn('moose: model failed', e); });
  }

  private make(key: string, bull: boolean, calf: boolean, mother: boolean): Beast | null {
    let b = this.beasts.find((x) => !x.used && x.bull === bull && x.calf === calf);
    if (!b) {
      if (!this.src || this.beasts.length >= MAX_SHOWN * 2) return null;
      const root = new THREE.Group();
      const model = SkeletonUtils.clone(this.src.scene);
      root.add(model);
      const meshes: Record<string, THREE.SkinnedMesh> = {};
      const shadows = this.game.quality.shadows;
      model.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        meshes[m.name] = m;
        m.visible = false;
        m.castShadow = shadows && /_L[01]$/.test(m.name);
        if (calf) m.material = this.mats!.calf;
      });
      if (calf) root.scale.setScalar(0.56);
      else if (!bull) root.scale.setScalar(0.92);
      const mixer = new THREE.AnimationMixer(model);
      const acts: Record<string, THREE.AnimationAction> = {};
      for (const clip of this.src.anims) acts[clip.name] = mixer.clipAction(clip);
      b = {
        key, root, meshes, mixer, acts, cur: '', bull, calf, mother, lod: '', x: 0, z: 0, h: 0, y: 0,
        ox: 0, oz: 0, ovx: 0, ovz: 0, mode: 'path', mt: 0, cool: 0, hoofT: 0, noiseT: 4 + Math.random() * 6, onRoad: false, wob: 0, used: true,
      };
      this.beasts.push(b);
    }
    b.key = key; b.used = true; b.mother = mother;
    b.ox = b.oz = b.ovx = b.ovz = 0; b.mode = 'path'; b.mt = 0; b.cool = 0; b.cur = ''; b.lod = '';
    for (const a of Object.values(b.acts)) a.stop();
    for (const m of Object.values(b.meshes)) m.visible = false;
    this.group.add(b.root);
    this.byKey.set(key, b);
    return b;
  }

  private release(b: Beast): void {
    b.used = false;
    this.group.remove(b.root);
    this.byKey.delete(b.key);
  }

  private play(b: Beast, name: string, scale: number): void {
    const a = b.acts[name];
    if (!a) return;
    a.timeScale = scale;
    if (b.cur === name) return;
    const prev = b.cur ? b.acts[b.cur] : null;
    a.reset().setEffectiveWeight(1).play();
    if (prev) { a.crossFadeFrom(prev, 0.35, false); }
    b.cur = name;
  }

  // ── Per frame ─────────────────────────────────────────────────────────────

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.game;
    if (this.signGroups.length) {
      const cp = g.camera.position;
      for (const sg of this.signGroups) sg.visible = Math.hypot(sg.position.x - cp.x, sg.position.z - cp.z) < SIGN_SHOW;
    }
    if (!this.patched) this.patchTraffic();
    if (!this.src) { if (!this.loading) this.load(); this.roadPeds.length = 0; return; }
    const sky = g.sky;
    if (!sky) return;
    const minutes = sky.hour * 60;
    const ep = Math.floor(minutes / EP);
    const d = new Date(), day = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const ck = `${day}:${ep}`;
    if (ck !== this.cacheKey) {
      this.cacheKey = ck;
      this.cache = this.sites.map((_, i) => this.crossing(i, ep, day));
    }
    const rate = Math.max(0, sky.rate * 60);
    const cam = g.camera.position;
    const want = new Set<string>();
    const pos = { x: 0, z: 0, s: 0, anim: '', h: 0 };
    let active = 0;
    const consider = (si: number, c: Cross, tag: string): void => {
      const s = this.sites[si];
      for (let k = 0; k < (c.calf ? 2 : 1); k++) {
        const calf = k === 1;
        const tau = minutes - c.t0 - (calf ? CALF_LAG : 0);
        if (!this.pathAt(s, calf ? { ...c, along: c.along + 1.3 } : c, tau, pos)) continue;
        active++;
        if (Math.hypot(pos.x - cam.x, pos.z - cam.z) > SHOW_R) continue;
        const key = `${tag}:${k}`;
        want.add(key);
        let b = this.byKey.get(key);
        if (!b) { if (this.byKey.size >= MAX_SHOWN) continue; b = this.make(key, c.bull, calf, c.calf && !calf) ?? undefined; if (!b) continue; }
        this.drive(b, s, pos, rate, dt);
      }
    };
    const f = this.forced;
    if (f) {
      const c: Cross = { t0: f.t0, dur: 0, walk: OFF / V, stand: f.stand, side: f.side, along: 0, bull: f.bull, calf: f.calf, wob: 1 };
      consider(f.si, c, `forced:${f.si}:${f.t0}`);
    }
    for (let i = 0; i < this.sites.length; i++) { const c = this.cache[i]; if (c) consider(i, c, `${day}:${ep}:${i}`); }
    for (const b of this.beasts) if (b.used && !want.has(b.key)) this.release(b);
    this.stats.active = active;
    this.stats.shown = this.byKey.size;
    // The drivers' view of the road: three standing people along each moose in it.
    this.roadPeds.length = 0;
    for (const b of this.beasts) {
      if (!b.used || !b.onRoad) continue;
      const sh = Math.sin(b.h), ch = Math.cos(b.h);
      for (const o of BODY) this.roadPeds.push({ x: b.x + sh * o, z: b.z + ch * o, vx: 0, vz: 0, on: true });
    }
    this.updateCracks(dt);
    this.stats.ms = performance.now() - t0;
  }

  /** One animal: its path pose plus the local offset, what it is doing, its collisions, sounds and drawing. */
  private drive(b: Beast, s: Site, p: { x: number; z: number; s: number; anim: string; h: number }, rate: number, dt: number): void {
    const g = this.game, pl = g.player;
    b.cool -= dt; b.mt += dt;
    let anim = p.anim, scale = anim === 'walk' ? (V * rate) / NATIVE.walk : 1;
    let h = p.h;
    const onFoot = !pl.vehicle;
    const px = pl.x, pz = pl.z;
    const dpx = px - b.x, dpz = pz - b.z, dp = Math.hypot(dpx, dpz);
    const angry = (b.bull || b.mother) && !b.calf;
    if (b.mode === 'path') {
      // Walk the local offset back to the shared path.
      const od = Math.hypot(b.ox, b.oz);
      if (od > 0.05) {
        const step = Math.min(od, 1.3 * dt);
        b.ox -= (b.ox / od) * step; b.oz -= (b.oz / od) * step;
        if (od > 0.6) { anim = 'walk'; scale = 1.3 / NATIVE.walk; h = Math.atan2(-b.ox, -b.oz); }
      }
      if (angry && onFoot && b.cool <= 0 && dp < (b.bull ? 9 : 6.5) && Math.abs(pl.y - b.y) < 2.5 && g.state === 'play') {
        b.mode = 'windup'; b.mt = 0; this.say(b, 'snort');
      }
    }
    if (b.mode === 'windup') {
      anim = 'charge'; scale = 0.15;
      h = Math.atan2(dpx, dpz);
      if (b.mt > 1.1) { b.mode = 'charge'; b.mt = 0; this.stats.charges++; this.say(b, 'bellow'); }
    } else if (b.mode === 'charge') {
      anim = 'charge'; scale = CHARGE_V / NATIVE.charge;
      h = Math.atan2(dpx, dpz);
      const sp = Math.min(CHARGE_V, b.mt * 12);
      b.ox += Math.sin(h) * sp * dt; b.oz += Math.cos(h) * sp * dt;
      if (onFoot && dp < 2.7 && Math.abs(pl.y - b.y) < 2) {
        pl.knockDown(Math.sin(h) * 9, Math.cos(h) * 9, 3.8);
        g.cam.shake(0.7);
        this.stats.knocks++;
        g.hud.toast(pick(CHARGED), 3.5);
        b.mode = 'recover'; b.mt = 0; b.cool = 30;
      } else if (b.mt > 3.2 || dp > 22 || !onFoot) { b.mode = 'recover'; b.mt = 0; b.cool = 18; }
    } else if (b.mode === 'stagger') {
      anim = 'walk'; scale = 2.2;
      b.ox += b.ovx * dt; b.oz += b.ovz * dt;
      const k = Math.exp(-3 * dt); b.ovx *= k; b.ovz *= k;
      h = b.h + Math.sin(b.mt * 14) * 0.25 * dt * 10;
      if (b.mt > 0.9) { b.mode = 'recover'; b.mt = 0; this.say(b, 'grunt'); }
    }
    if (b.mode === 'recover') {
      anim = 'shake'; scale = 1;
      h = b.h;
      if (b.mt > 1.6) { b.mode = 'path'; b.mt = 0; }
    }
    b.x = p.x + b.ox; b.z = p.z + b.oz;
    // Turn smoothly rather than snap.
    let dh = h - b.h;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.h += dh * Math.min(1, dt * (b.mode === 'charge' || b.mode === 'windup' ? 6 : 2.5));
    b.y = groundAt(b.x, b.z);
    b.onRoad = Math.abs(p.s) < s.hw + 2.5 || (b.mode !== 'path' && Math.abs((b.x - s.x) * -s.dz + (b.z - s.z) * s.dx) < s.hw + 2.5);
    this.collide(b, dt);
    this.play(b, anim, scale);
    b.mixer.update(dt);
    b.root.position.set(b.x, b.y, b.z);
    b.root.rotation.set(0, b.h, b.mode === 'stagger' ? Math.sin(b.mt * 9) * 0.12 * (1 - b.mt / 0.9) : 0);
    // Level of detail.
    const cam = g.camera.position, dist = Math.hypot(b.x - cam.x, b.z - cam.z);
    const low = g.quality.name === 'low';
    const lv = low ? (dist < 25 ? 'L1' : dist < 60 ? 'L2' : 'far') : dist < 35 ? 'L0' : dist < 90 ? 'L1' : dist < 190 ? 'L2' : 'far';
    if (lv !== b.lod) {
      const kind = b.bull ? 'bull' : 'cow';
      for (const [n, m] of Object.entries(b.meshes)) m.visible = n === `${kind}_${lv}`;
      b.lod = lv;
    }
    b.root.visible = dist < Math.max(220, g.quality.drawDist);
    // Sounds: hooves near by, now and then a snort or (a bull) a bellow.
    if (dist < 32 && (anim === 'walk' || anim === 'trot' || anim === 'charge')) {
      const period = anim === 'walk' ? 1.3 : anim === 'trot' ? 0.72 : 0.56;
      b.hoofT -= (dt * 4 * scale) / period;
      if (b.hoofT <= 0) { b.hoofT += 1; this.hoofSound(b, Math.abs(p.s) < s.hw + 0.5, anim !== 'walk'); }
    }
    b.noiseT -= dt;
    if (b.noiseT <= 0 && dist < 140) {
      b.noiseT = 7 + Math.random() * 14;
      if (b.mode === 'path') this.say(b, b.bull && Math.random() < 0.35 ? 'bellow' : b.calf ? 'grunt' : 'snort');
    }
    // Moose encountered: once per animal, within 40 m of the player.
    if (!this.seen.has(b.key) && Math.hypot(dpx, dpz) < 40) {
      this.seen.add(b.key);
      if (save.bump('moose') === 1) g.hud.toast(SPOTTED_FIRST, 4);
    }
  }

  /** Cars stop dead against it; the player on foot is pushed out of it. */
  private collide(b: Beast, dt: number): void {
    const g = this.game, sh = Math.sin(b.h), ch = Math.cos(b.h);
    for (const v of g.vehicles.list) {
      const rx = v.x - b.x, rz = v.z - b.z;
      if (rx * rx + rz * rz > 64 || Math.abs(v.y - b.y) > 2.2 || v.removed) continue;
      const vsh = Math.sin(v.h), vch = Math.cos(v.h);
      for (const o of BODY) {
        const cx = b.x + sh * o, cz = b.z + ch * o;
        const ox = cx - v.x, oz = cz - v.z;
        const lf = ox * vsh + oz * vch, lat = -ox * vch + oz * vsh;
        const ef = lf - Math.max(-v.hl, Math.min(v.hl, lf)), er = lat - Math.max(-v.hw, Math.min(v.hw, lat));
        let nlf: number, nlat: number, depth: number;
        const dd = Math.hypot(ef, er);
        if (dd > 1e-4) {
          if (dd >= BODY_R) continue;
          nlf = ef / dd; nlat = er / dd; depth = BODY_R - dd;
        } else {
          // The middle of the circle is inside the box: out along the shallower axis.
          const pf = v.hl - Math.abs(lf), pr = v.hw - Math.abs(lat);
          if (pf < pr) { nlf = Math.sign(lf) || 1; nlat = 0; depth = pf + BODY_R; } else { nlf = 0; nlat = Math.sign(lat) || 1; depth = pr + BODY_R; }
        }
        // Normal from the car toward the moose, in the world.
        const nx = nlf * vsh - nlat * vch, nz = nlf * vch + nlat * vsh;
        const vn = v.vx * nx + v.vz * nz;
        v.x -= nx * depth; v.z -= nz * depth;
        if (vn > 0) {
          if (vn > 2.5) this.hit(b, v, vn, nx, nz);
          else { v.vx -= vn * nx; v.vz -= vn * nz; }
        }
      }
    }
    const pl = g.player;
    if (!pl.vehicle) {
      const per = pl.person;
      if (Math.abs(per.y - b.y) < 2.2) for (const o of BODY) {
        const cx = b.x + sh * o, cz = b.z + ch * o;
        const dx = per.x - cx, dz = per.z - cz, d = Math.hypot(dx, dz), r = BODY_R + 0.32;
        if (d < r && d > 1e-4) { per.x = cx + (dx / d) * r; per.z = cz + (dz / d) * r; }
      }
    }
    void dt;
  }

  private hit(b: Beast, v: Vehicle, sp: number, nx: number, nz: number): void {
    const g = this.game;
    // Stops dead: a 600 kg animal on legs a metre and a half long is a wall at bumper height.
    v.vx = 0; v.vz = 0; v.yawRate *= 0.2;
    if (sp > 5) {
      v.health = Math.max(0, v.health - Math.min(70, 18 + sp * 2.6));
      this.crack(v);
    } else v.health = Math.max(0, v.health - sp);
    g.emit('impact', { vehicle: v, speed: Math.max(sp, 6), other: null, x: b.x - nx * BODY_R, z: b.z - nz * BODY_R });
    this.stats.hits++;
    if (b.mode !== 'stagger') {
      const k = Math.min(2.2, 0.35 + sp * 0.09);
      b.ovx = nx * k * 2.5; b.ovz = nz * k * 2.5;
      b.mode = 'stagger'; b.mt = 0;
      this.say(b, 'grunt');
    }
    if (v === g.player.vehicle) {
      g.hud.toast(save.bump('mooseHit') === 1 ? FIRST_HIT : pick(HIT), 3.5);
    }
  }

  // ── The cracked windscreen ───────────────────────────────────────────────

  private crack(v: Vehicle): void {
    if (this.cracks.some((c) => c.car === v)) return;
    if (!this.crackMat) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const x = c.getContext('2d')!;
      let s = 5;
      const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
      x.strokeStyle = 'rgba(240,244,248,0.95)';
      const cx = 150, cy = 110;
      for (let i = 0; i < 22; i++) {
        let a = (i / 22) * Math.PI * 2 + r() * 0.3, px = cx, py = cy;
        x.lineWidth = 2.8; x.beginPath(); x.moveTo(px, py);
        for (let k = 0; k < 7; k++) { a += (r() - 0.5) * 0.5; px += Math.cos(a) * (12 + r() * 16); py += Math.sin(a) * (12 + r() * 16); x.lineTo(px, py); }
        x.stroke();
      }
      x.lineWidth = 2;
      for (let ring = 1; ring <= 3; ring++) {
        x.beginPath();
        for (let i = 0; i <= 18; i++) { const a = (i / 18) * Math.PI * 2, rr = ring * 16 + r() * 8; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        x.stroke();
      }
      x.fillStyle = 'rgba(240,245,250,0.55)'; x.beginPath(); x.arc(cx, cy, 8, 0, 6.3); x.fill();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      this.crackMat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide, fog: true });
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.crackMat);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    if (this.cracks.length >= 6) { const old = this.cracks.shift()!; this.group.remove(old.mesh); old.mesh.geometry.dispose(); }
    this.cracks.push({ car: v, mesh, t: 0 });
  }

  private readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _v = new THREE.Vector3();
  private updateCracks(dt: number): void {
    for (let i = this.cracks.length - 1; i >= 0; i--) {
      const c = this.cracks[i], v = c.car;
      c.t += dt;
      if (v.removed || v.sunk || c.t > 240 || v.health > 99) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); this.cracks.splice(i, 1); continue; }
      const H = v.spec.height, L = v.spec.length;
      this._e.set(-v.pitch, v.h, v.roll);
      c.mesh.quaternion.setFromEuler(this._e);
      this._v.set(0, H * 0.8, L * 0.11).applyQuaternion(c.mesh.quaternion);
      c.mesh.position.set(v.x + this._v.x, v.y + this._v.y, v.z + this._v.z);
      c.mesh.rotateX(-1.0);
      c.mesh.scale.set(v.hw * 1.5, 0.62, 1);
    }
  }

  // ── Traffic ───────────────────────────────────────────────────────────────

  /** Once: hand the moose in the road to the drivers alongside the people walking (sim/traffic.ts reads them as pedestrians). */
  private patchTraffic(): void {
    this.patched = true;
    const amb = this.game.systems.find((s) => (s as { traffic?: unknown }).traffic) as unknown as
      { traffic: { update(dt: number, peds: readonly RoadPed[], jumped: boolean): void } } | undefined;
    if (!amb) return;
    const tr = amb.traffic, orig = tr.update.bind(tr);
    tr.update = (dt: number, peds: readonly RoadPed[], jumped: boolean): void => {
      if (this.roadPeds.length === 0) { orig(dt, peds, jumped); return; }
      const m = this.merged;
      m.length = 0;
      for (const p of peds) m.push(p);
      for (const p of this.roadPeds) m.push(p);
      orig(dt, m, jumped);
    };
  }

  // ── Sound ─────────────────────────────────────────────────────────────────

  private spot(x: number, y: number, z: number, ref: number): { in: AudioNode; t: number; core: AudioCore } | null {
    const core = this.game.audio?.core;
    if (!core) return null;
    const sp = core.place(x, y, z, { ref, max: 400, wet: 0.3 });
    return sp ? { in: sp.in, t: core.now + sp.lag, core } : null;
  }

  private hoofSound(b: Beast, road: boolean, hard: boolean): void {
    const a = this.spot(b.x, b.y, b.z, 4);
    if (a) hoof(a.core, a.t, a.in, (hard ? 0.9 : 0.55) * (b.calf ? 0.5 : 1), road);
  }

  private say(b: Beast, what: 'snort' | 'bellow' | 'grunt'): void {
    const a = this.spot(b.x + Math.sin(b.h) * 1.7, b.y + 1.7, b.z + Math.cos(b.h) * 1.7, what === 'bellow' ? 14 : 7);
    if (!a) return;
    if (what === 'snort') snort(a.core, a.t, a.in, b.calf ? 0.5 : 1);
    else if (what === 'bellow') bellow(a.core, a.t, a.in, b.bull ? 1.7 : 1.1, b.calf ? 1.9 : b.bull ? 1 : 1.25);
    else grunt(a.core, a.t, a.in, b.calf ? 2 : b.bull ? 1 : 1.2);
  }

  // ── Signs ─────────────────────────────────────────────────────────────────

  private signs(): void {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 384;
    const x = c.getContext('2d')!;
    // The diamond.
    x.fillStyle = '#1b1b1b';
    x.beginPath(); x.moveTo(128, 2); x.lineTo(254, 128); x.lineTo(128, 254); x.lineTo(2, 128); x.closePath(); x.fill();
    x.fillStyle = '#f2c230';
    x.beginPath(); x.moveTo(128, 10); x.lineTo(246, 128); x.lineTo(128, 246); x.lineTo(10, 128); x.closePath(); x.fill();
    // A moose, side on.
    x.fillStyle = '#141414';
    x.beginPath(); x.ellipse(118, 128, 50, 26, 0, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.moveTo(150, 112); x.quadraticCurveTo(170, 92, 178, 96); x.lineTo(196, 116); x.quadraticCurveTo(200, 126, 190, 126); x.lineTo(172, 116); x.lineTo(158, 132); x.fill();
    x.beginPath(); x.moveTo(140, 104); x.quadraticCurveTo(150, 92, 162, 102); x.fill();
    for (const lx of [78, 92, 140, 154]) x.fillRect(lx, 140, 7, 52);
    x.beginPath(); x.moveTo(170, 98); x.lineTo(160, 74); x.lineTo(168, 80); x.lineTo(170, 66); x.lineTo(176, 80); x.lineTo(184, 68); x.lineTo(184, 84); x.lineTo(194, 76); x.lineTo(186, 96); x.fill();
    x.beginPath(); x.moveTo(176, 120); x.lineTo(178, 138); x.lineTo(182, 122); x.fill();
    // The plate under it.
    x.fillStyle = '#1b1b1b'; x.fillRect(28, 276, 200, 96);
    x.fillStyle = '#f2c230'; x.fillRect(33, 281, 190, 86);
    x.fillStyle = '#141414'; x.textAlign = 'center'; x.font = 'bold 34px Arial, sans-serif';
    x.fillText('MOOSE', 128, 318); x.fillText('CROSSING', 128, 356, 180);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const face = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.55, metalness: 0.1 });
    const back = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.6, metalness: 0.5, side: THREE.BackSide, alphaMap: tex, alphaTest: 0.5 });
    const post = new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.45, metalness: 0.7 });
    const plane = new THREE.PlaneGeometry(1.1, 1.65);
    const pole = new THREE.CylinderGeometry(0.035, 0.035, 2.9, 8);
    pole.translate(0, 1.45, -0.03);
    const mainland = this.sites.filter((s) => s.land === 1);
    const chosen = [...mainland.filter((s) => s.name === 'The Thruway').slice(0, 2), ...mainland.filter((s) => s.name !== 'The Thruway').slice(0, 2)];
    for (const s of chosen) {
      for (const dir of [1, -1]) {
        // On the right of the traffic coming toward the crossing, facing it, 45 m before.
        const ddx = s.dx * dir, ddz = s.dz * dir, rx = -ddz, rz = ddx;
        const sx = s.x - ddx * 45 + rx * (s.hw + 1.8), sz = s.z - ddz * 45 + rz * (s.hw + 1.8);
        const gnd = groundAt(sx, sz);
        const g = new THREE.Group();
        g.position.set(sx, gnd, sz);
        g.rotation.y = Math.atan2(-ddx, -ddz);
        const f = new THREE.Mesh(plane, face); f.position.y = 2.35; f.castShadow = true;
        const bk = new THREE.Mesh(plane, back); bk.position.y = 2.35;
        const p = new THREE.Mesh(pole, post); p.castShadow = true;
        g.add(f, bk, p);
        this.group.add(g);
        this.signGroups.push(g);
      }
    }
  }
}
