// Stunt replay and slow motion (fun queue item 1).
//
// RECORDING. A rolling buffer of about eleven seconds, sampled at most 60 times a second after the camera has moved
// (CameraRig.update calls Replay.update last): the camera, a focus point, the player's car or body, the ten cars
// nearest her and up to eight people (her, anyone flying as a ragdoll, the nearest walkers). Everything lives in
// typed arrays made once; a slot keeps the same car or person from frame to frame so playback can interpolate.
// About 600 numbers a frame; nothing is allocated while recording.
//
// PLAYBACK. The SIMULATION KEEPS RUNNING underneath, alone and in a shared town alike: the replay is only drawn.
// Game.render is wrapped (see install()): just before the picture, the recorded cars and people are put where they
// were, the car and people buffers are rewritten for that pose (Vehicles.update(0), Occupants.place(),
// People.update(0): draw-only calls), the picture is drawn, and every field is put back before anything else runs.
// Nothing is sent, nothing is simulated from the replay pose, other players keep seeing the live game. While it
// plays the controls are held (the car coasts), any key, click, tap or pad button skips, and the HUD is hidden
// behind a film-strip border with a deadpan caption.
//
// WHEN. Automatically after a long jump, a stunt jump, a hard crash, a long ragdoll flight of hers, or a
// pedestrian sent flying at speed, unless the setting is off, a mission or job holds the floor (todo.busy), the
// police want her, or one played in the last 25 s. J (and the REPLAY key on touch) rewatches the last ten
// seconds at any time.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import { groundAt } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import { save } from '../game/save';

const FR = 680;            // frames kept (11.3 s at 60 a second)
const STEP = 1 / 61;       // the least time between two samples
const NC = 10, CF = 8;     // car slots; x y z h pitch roll steer speed
const NP = 8, PF = 48;     // people slots; pelvis 4x4, 29 channels, feet xyz
const NCH = 29;
const HF = 13;             // camera xyz, quaternion, fov, focus xyz, excitement, cut
const KEEP = 10;           // seconds the rewatch key plays
const COOL = 25;           // seconds between automatic replays
const SHOT = 2.7;          // seconds on screen per camera shot
const CAR_R2 = 75 * 75, PED_R2 = 32 * 32, RAG_R2 = 70 * 70;
const STORE = 'pc-replay';
const FEET = 3.28084, MPH = 2.23694;

// Channel numbers and the pelvis height, as in ent/character.ts.
const RX = 0, RY = 1, RZ = 2, TIP = 3, YAW = 4, PITCH = 5, ROLL = 6, WATER = 28, HIP = 0.9;

type Kind = 'jump' | 'stunt' | 'crash' | 'self' | 'ped' | 'manual';
type Shot = 'game' | 'low' | 'orbit' | 'tv';

/** The fields of a car (ent/vehicle.ts Car) the replay moves and puts back. */
interface CarLive {
  x: number; y: number; z: number; h: number; pitch: number; roll: number; groundRoll: number; lift: number;
  steerAng: number; spinF: number; spinR: number; stale: boolean; removed?: boolean; airTime: number; speed: number;
  spec: { wheelR: number };
}
/** The fields of a body (ent/character.ts Body) the replay moves and puts back. */
interface BodyLive {
  x: number; y: number; z: number; h: number; visible: boolean; occupant?: boolean;
  rag: Float64Array | null; ragCh: Float32Array | null; cur: Float32Array; from: Float32Array; look: { height: number };
}
interface RagLive { p: Person; x: number; y: number; z: number; air: number; remote: boolean; sx: number; sz: number }

const CAPTIONS: Record<Kind, string[]> = {
  jump: [
    'Airborne for {t} seconds. The car was not consulted.',
    '{ft} feet of unscheduled flight. The suspension has filed a complaint.',
    'Gravity: briefly optional. {t} seconds.',
    '{ft} feet. The Harbor Authority does not issue pilot licences for this.',
  ],
  stunt: [
    'Stunt jump, {ft} feet. Noted by the Harbor Authority, with concern.',
    'A stunt jump, {t} seconds aloft. Forms will be sent.',
  ],
  crash: [
    'Impact at {mph} mph. The insurer would like a word.',
    'The car stopped. Most of it, anyway.',
    'Witnesses describe it as "loud". {mph} mph.',
    '{mph} mph into something that did not move. Physics, as ever, undefeated.',
  ],
  self: [
    'Dess, {ft} feet, no aircraft involved.',
    'A flight with no in-flight service. {t} seconds.',
    'Landed. Technically.',
  ],
  ped: [
    'One pedestrian, rerouted by air.',
    'They will be fine. They said so, from the ground.',
    'Flying lesson delivered, unrequested.',
  ],
  manual: [
    'The last ten seconds, for the record.',
    'Exhibit A.',
    'Played back at the request of the applicant.',
  ],
};

// Column-major 4x4 helpers, the same as ent/character.ts.
function rotX(m: Float64Array, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 3; i++) { const y = m[4 + i], z = m[8 + i]; m[4 + i] = y * c + z * s; m[8 + i] = z * c - y * s; }
}
function rotY(m: Float64Array, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 3; i++) { const x = m[i], z = m[8 + i]; m[i] = x * c - z * s; m[8 + i] = x * s + z * c; }
}
function rotZ(m: Float64Array, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 3; i++) { const x = m[i], y = m[4 + i]; m[i] = x * c + y * s; m[4 + i] = y * c - x * s; }
}
function move(m: Float64Array, x: number, y: number, z: number): void {
  m[12] += m[0] * x + m[4] * y + m[8] * z; m[13] += m[1] * x + m[5] * y + m[9] * z; m[14] += m[2] * x + m[6] * y + m[10] * z;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpAng = (a: number, b: number, t: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

const _M = new Float64Array(16);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _v = new THREE.Vector3(), _look = new THREE.Vector3();

export class Replay {
  /** Automatic replays (the menu's setting; kept in this browser). */
  auto = true;
  playing = false;
  /** Recording at all (off only with ?replay=off). */
  rec = true;
  /** For the tests and the lead's measurements: samples taken, replays played. */
  readonly stats = { frames: 0, played: 0, skipped: 0 };

  // ── The buffer ──
  private readonly times = new Float64Array(FR);
  private readonly head = new Float32Array(FR * HF);
  private readonly carRef: (Vehicle | null)[] = new Array<Vehicle | null>(FR * NC).fill(null);
  private readonly carF = new Float32Array(FR * NC * CF);
  private readonly pRef: (Person | null)[] = new Array<Person | null>(FR * NP).fill(null);
  private readonly pF = new Float32Array(FR * NP * PF);
  private next = 0;
  private count = 0;
  /** Recorded seconds: only runs while recording, so a replay's own gap is a cut, not a pause. */
  private clock = 0;
  private acc = 0;
  private gap = false;
  // Slots as they stood in the last sample, and scratch for picking the next one.
  private readonly lastCars: (Vehicle | null)[] = new Array<Vehicle | null>(NC).fill(null);
  private readonly lastPeople: (Person | null)[] = new Array<Person | null>(NP).fill(null);
  private readonly candC: (Vehicle | null)[] = new Array<Vehicle | null>(NC).fill(null);
  private readonly candD = new Float64Array(NC);
  private readonly candP: (Person | null)[] = new Array<Person | null>(NP).fill(null);
  private readonly candPD = new Float64Array(NP);

  // ── Triggers ──
  private inAir = false; private airStart = 0; private airMax = 0; private airX = 0; private airZ = 0; private jumps0 = 0;
  private selfFly = false; private selfStart = 0; private selfX = 0; private selfZ = 0;
  private lastImpact = -9; private impactV = 0;
  private pending: { at: number; from: number; to: number; kind: Kind; t: number; ft: number; mph: number } | null = null;
  private lastAuto = -999;

  // ── Playback ──
  private from = 0; private to = 0; private playT = 0; private rate = 1; private manual = false;
  private wall = 0; private shotT = 0; private shotI = 0; private shots: Shot[] = [];
  private side = 1; private a0 = 0;
  private readonly fixed = new THREE.Vector3();
  private readonly perp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly lookS = new THREE.Vector3();
  private lookSnap = true;
  private liveFov = 60;
  private inputWas = true;
  private padWas = false;
  private startedAt = 0;
  private shownRate = '';
  // Puppet arrays (one per people slot) and what the live game had, to put back.
  private readonly pupM: Float64Array[] = [];
  private readonly pupC: Float32Array[] = [];
  private readonly liveC = new Float32Array(NC * 11);
  private readonly liveCars: (CarLive | null)[] = new Array<CarLive | null>(NC).fill(null);
  private readonly liveB: (BodyLive | null)[] = new Array<BodyLive | null>(NP).fill(null);
  private readonly liveBX = new Float32Array(NP * 3);
  private readonly liveRag: (Float64Array | null)[] = new Array<Float64Array | null>(NP).fill(null);
  private readonly liveRagCh: (Float32Array | null)[] = new Array<Float32Array | null>(NP).fill(null);
  private readonly liveCur = new Float32Array(NP * NCH * 2);

  // ── The film strip ──
  private el: HTMLElement | null = null;
  private capEl: HTMLElement | null = null;
  private rateEl: HTMLElement | null = null;
  private skipEl: HTMLElement | null = null;

  constructor(private readonly game: Game) {
    for (let i = 0; i < NP; i++) { this.pupM.push(new Float64Array(16)); this.pupC.push(new Float32Array(NCH)); }
    try { this.auto = localStorage.getItem(STORE) !== '0'; } catch { /* default on */ }
    // ?replay=0: no automatic replays; ?replay=off: nothing recorded at all (for measuring what recording costs).
    const q = new URLSearchParams(location.search).get('replay');
    if (q === '0' || q === 'off') this.auto = false;
    if (q === 'off') this.rec = false;
    this.install();
    game.on('impact', (e) => {
      const v = game.player.seated;
      if (!v || (e.vehicle !== v && e.other !== v) || this.playing) return;
      this.lastImpact = this.clock;
      if (e.speed >= 20) this.want('crash', this.clock - 3.2, this.clock + 1.6, 0, 0, e.speed * MPH);
    });
    game.on('pedHit', (e) => {
      if (!e.byPlayer || e.speed < 19 || this.playing) return;
      this.want('ped', this.clock - 2.2, this.clock + 2.8, 0, 0, e.speed * MPH);
    });
    addEventListener('keydown', (e) => {
      if (this.playing) {
        if (performance.now() - this.startedAt > 250) { this.stats.skipped++; this.stop(); }
        return;
      }
      if (!game.input.is(e.code, 'replay') || e.repeat || game.state !== 'play') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.rewatch();
    });
    addEventListener('mousedown', () => { if (this.playing && performance.now() - this.startedAt > 250) { this.stats.skipped++; this.stop(); } }, true);
  }

  setAuto(on: boolean): void {
    this.auto = on;
    try { localStorage.setItem(STORE, on ? '1' : '0'); } catch { /* fine */ }
  }

  /** The rewatch key: the last ten seconds, now. A second press stops it. */
  rewatch(): void {
    if (this.playing) { this.stop(); return; }
    if (this.game.state !== 'play') return;
    if (this.count < 40) { this.game.hud.toast('Nothing worth replaying yet. Give it a moment.', 2.5); return; }
    this.pending = null;
    this.start(this.clock - KEEP, this.clock, 'manual', 0, 0, 0);
  }

  /** Seconds of recording held, for the tests. */
  get held(): number { return this.count < 2 ? 0 : this.clock - this.times[this.index(0)]; }

  // ── Every frame (from CameraRig.update, after the camera has moved) ─────────

  update(dt: number): void {
    if (this.playing) { this.play(dt); return; }
    const g = this.game;
    if (dt <= 0 || g.state !== 'play' || !this.rec) return;
    this.acc += dt;
    if (this.acc < STEP) return;
    this.clock += this.acc;
    this.acc = 0;
    this.record();
    this.watch();
    const p = this.pending;
    if (p && this.clock >= p.at) {
      this.pending = null;
      if (this.allowed()) this.start(p.from, p.to, p.kind, p.t, p.ft, p.mph);
    }
  }

  private allowed(): boolean {
    const g = this.game;
    return this.auto && g.state === 'play' && !g.todo?.busy && g.player.heat <= 0 && this.clock - this.lastAuto > COOL && !g.view;
  }

  /** Something spectacular has happened: play it once it has finished happening (merged with one already waiting). */
  private want(kind: Kind, from: number, to: number, t: number, ft: number, mph: number): void {
    if (!this.allowed()) return;
    const p = this.pending;
    const at = to + 0.2;
    if (p) {
      p.from = Math.min(p.from, from); p.to = Math.max(p.to, to); p.at = Math.max(p.at, at);
      // The better story wins the caption.
      const rank: Kind[] = ['ped', 'crash', 'jump', 'self', 'stunt'];
      if (rank.indexOf(kind) > rank.indexOf(p.kind)) { p.kind = kind; p.t = t; p.ft = ft; }
      p.mph = Math.max(p.mph, mph);
      return;
    }
    this.pending = { at, from, to, kind, t, ft, mph };
  }

  /** Jumps and her own flights, watched from the recorded state. */
  private watch(): void {
    const g = this.game, v = g.player.seated, c = this.clock;
    if (v) {
      const air = (v as unknown as CarLive).airTime;
      if (air > 0.05 && !v.sunk) {
        if (!this.inAir) { this.inAir = true; this.airStart = c; this.airMax = 0; this.airX = v.x; this.airZ = v.z; this.jumps0 = save.data.jumps.length; }
        if (air > this.airMax) this.airMax = air;
      } else if (this.inAir) {
        this.inAir = false;
        const dist = Math.hypot(v.x - this.airX, v.z - this.airZ);
        if (this.airMax >= 1.3 || (this.airMax >= 0.8 && dist >= 38)) {
          // Activities marks a landed stunt jump in the same step; look again when the replay is due.
          const kind: Kind = save.data.jumps.length > this.jumps0 ? 'stunt' : 'jump';
          this.want(kind, this.airStart - 1.5, c + 1.6, this.airMax, dist * FEET, 0);
        }
      }
    } else this.inAir = false;
    const rag = g.people.rag, me = g.player.person;
    const flying = !!rag && rag.flying(me);
    if (flying && !this.selfFly) { this.selfFly = true; this.selfStart = c; this.selfX = me.x; this.selfZ = me.z; }
    else if (!flying && this.selfFly) {
      this.selfFly = false;
      const t = c - this.selfStart, dist = Math.hypot(me.x - this.selfX, me.z - this.selfZ);
      if (t >= 1.8 || dist >= 13) this.want('self', this.selfStart - 1.2, Math.min(c + 0.8, this.selfStart + 4.5), t, dist * FEET, 0);
    }
    if (this.pending && this.pending.kind === 'jump' && save.data.jumps.length > this.jumps0) this.pending.kind = 'stunt';
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  private index(k: number): number { return (this.next - this.count + k + FR * 2) % FR; }

  private record(): void {
    const g = this.game, i = this.next, cam = g.camera, me = g.player, v = me.seated;
    this.next = (i + 1) % FR;
    if (this.count < FR) this.count++;
    this.stats.frames++;
    this.times[i] = this.clock;
    const h = this.head, o = i * HF;
    h[o] = cam.position.x; h[o + 1] = cam.position.y; h[o + 2] = cam.position.z;
    h[o + 3] = cam.quaternion.x; h[o + 4] = cam.quaternion.y; h[o + 5] = cam.quaternion.z; h[o + 6] = cam.quaternion.w;
    h[o + 7] = cam.fov;
    let fx: number, fy: number, fz: number, excite = 0;
    if (v) { fx = v.x; fy = v.y + 0.9; fz = v.z; if ((v as unknown as CarLive).airTime > 0.25) excite = 1; }
    else { fx = me.person.x; fy = me.person.y + 1; fz = me.person.z; }
    if (this.clock - this.lastImpact < 0.7) excite = 1;
    const px = me.x, pz = me.z;

    // Cars: the seated one in its slot, then the nearest, each keeping last frame's slot where it can.
    const cand = this.candC, cd = this.candD;
    let nc = 0;
    if (v) { cand[0] = v; cd[0] = -1; nc = 1; }
    const list = g.vehicles.list;
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (c === v || (c as unknown as CarLive).removed) continue;
      const dx = c.x - px, dz = c.z - pz, d = dx * dx + dz * dz;
      if (d > CAR_R2) continue;
      let j = nc;
      if (nc < NC) nc++; else if (d >= cd[NC - 1]) continue; else j = NC - 1;
      while (j > 0 && cd[j - 1] > d) { cd[j] = cd[j - 1]; cand[j] = cand[j - 1]; j--; }
      cd[j] = d; cand[j] = c;
    }
    for (let k = nc; k < NC; k++) cand[k] = null;
    this.slot(this.lastCars, cand, nc);
    const cf = this.carF;
    for (let s = 0; s < NC; s++) {
      const c = this.lastCars[s];
      this.carRef[i * NC + s] = c;
      if (!c) continue;
      const L = c as unknown as CarLive, q = (i * NC + s) * CF;
      cf[q] = L.x; cf[q + 1] = L.y; cf[q + 2] = L.z; cf[q + 3] = L.h; cf[q + 4] = L.pitch; cf[q + 5] = L.roll;
      cf[q + 6] = L.steerAng; cf[q + 7] = L.speed;
    }

    // People: her on foot, anyone flying, then the nearest walkers.
    const cp = this.candP, pd = this.candPD;
    let np = 0;
    const meB = me.person as unknown as BodyLive;
    if (!v && meB.visible) { cp[0] = me.person; pd[0] = -2; np = 1; }
    const rag = g.people.rag as unknown as { list: RagLive[] } | undefined;
    if (rag) {
      for (const r of rag.list) {
        if (np >= NP) break;
        if (r.p === me.person && np === 1) continue;
        const dx = r.x - px, dz = r.z - pz, d = dx * dx + dz * dz;
        if (d > RAG_R2) continue;
        cp[np] = r.p; pd[np] = -1; np++;
        // The farthest flier near her is part of the story: the camera looks between them.
        if (r.p !== me.person && r.air > 0.2 && r.y - groundAt(r.x, r.z) > 1.2 && d < 40 * 40) { fx = (fx + r.x) / 2; fy = (fy + r.y) / 2; fz = (fz + r.z) / 2; excite = 1; }
        else if (r.p === me.person && r.air > 0.2) excite = 1;
      }
    }
    const fixedN = np;
    const people = g.people.list;
    for (let k = 0; k < people.length; k++) {
      const p = people[k], b = p as unknown as BodyLive;
      if (!b.visible || b.occupant || b.rag || p === me.person) continue;
      const dx = p.x - px, dz = p.z - pz, d = dx * dx + dz * dz;
      if (d > PED_R2) continue;
      let j = np;
      if (np < NP) np++; else if (d >= pd[NP - 1] || NP - 1 < fixedN) continue; else j = NP - 1;
      while (j > fixedN && pd[j - 1] > d) { pd[j] = pd[j - 1]; cp[j] = cp[j - 1]; j--; }
      pd[j] = d; cp[j] = p;
    }
    for (let k = np; k < NP; k++) cp[k] = null;
    this.slot(this.lastPeople, cp, np);
    const pf = this.pF;
    for (let s = 0; s < NP; s++) {
      const p = this.lastPeople[s];
      this.pRef[i * NP + s] = p;
      if (!p) continue;
      const b = p as unknown as BodyLive, q = (i * NP + s) * PF;
      if (b.rag) for (let k = 0; k < 16; k++) pf[q + k] = b.rag[k];
      else {
        const c = b.cur, k = b.look.height, sh = Math.sin(b.h) * k, ch = Math.cos(b.h) * k, M = _M;
        M[0] = ch; M[1] = 0; M[2] = -sh; M[3] = 0; M[4] = 0; M[5] = k; M[6] = 0; M[7] = 0;
        M[8] = sh; M[9] = 0; M[10] = ch; M[11] = 0;
        M[12] = b.x; M[13] = c[WATER] > 0 ? lerp(b.y, waterLevelAt(b.x, b.z), c[WATER]) : b.y; M[14] = b.z; M[15] = 1;
        rotX(M, c[TIP]); move(M, c[RX], HIP + c[RY], c[RZ]); rotY(M, c[YAW]); rotX(M, c[PITCH]); rotZ(M, c[ROLL]);
        for (let j = 0; j < 16; j++) pf[q + j] = M[j];
      }
      const src = b.ragCh ?? b.cur;
      for (let k = 0; k < NCH; k++) pf[q + 16 + k] = src[k];
      pf[q + 45] = b.x; pf[q + 46] = b.y; pf[q + 47] = b.z;
      if (p === me.person && b.rag) { fx = b.rag[12]; fy = b.rag[13]; fz = b.rag[14]; }
    }
    h[o + 8] = fx; h[o + 9] = fy; h[o + 10] = fz; h[o + 11] = excite; h[o + 12] = this.gap ? 1 : 0;
    this.gap = false;
  }

  /** Keep each of last frame's slots that is still wanted; fill the free ones with the rest. */
  private slot<T>(last: (T | null)[], cand: (T | null)[], n: number): void {
    for (let s = 0; s < last.length; s++) {
      const x = last[s];
      if (x === null) continue;
      let keep = false;
      for (let k = 0; k < n; k++) if (cand[k] === x) { keep = true; cand[k] = null; break; }
      if (!keep) last[s] = null;
    }
    let s = 0;
    for (let k = 0; k < n; k++) {
      const x = cand[k];
      if (x === null) continue;
      while (s < last.length && last[s] !== null) s++;
      if (s >= last.length) break;
      last[s] = x;
    }
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  private start(from: number, to: number, kind: Kind, t: number, ft: number, mph: number): void {
    if (this.count < 20) return;
    const first = this.times[this.index(0)];
    from = Math.max(from, first); to = Math.min(to, this.clock);
    // An automatic replay is a moment, not a documentary: at most 6.5 recorded seconds.
    if (kind !== 'manual') from = Math.max(from, to - 6.5);
    if (to - from < 1.2) return;
    const g = this.game;
    this.playing = true;
    this.manual = kind === 'manual';
    if (!this.manual) { this.lastAuto = this.clock; }
    this.stats.played++;
    this.from = from; this.to = to; this.playT = from;
    this.rate = this.manual ? 1 : 0.8;
    this.wall = 0; this.shotT = 0; this.shotI = 0;
    this.shots = kind === 'manual' ? ['game', 'low', 'orbit', 'tv']
      : kind === 'crash' ? ['tv', 'low', 'orbit']
      : kind === 'ped' ? ['orbit', 'tv', 'low']
      : kind === 'self' ? ['orbit', 'low', 'tv']
      : ['low', 'tv', 'orbit'];
    this.side = Math.random() < 0.5 ? -1 : 1;
    this.beginShot();
    this.liveFov = g.camera.fov;
    const inp = g.input as unknown as { enabled?: boolean };
    this.inputWas = inp.enabled !== false;
    g.input.setEnabled(false);
    g.input.unlock();
    this.startedAt = performance.now();
    this.padWas = this.padDown();
    const pool = CAPTIONS[kind];
    const line = pool[Math.floor(Math.random() * pool.length)]
      .replace('{t}', t.toFixed(1)).replace('{ft}', String(Math.round(ft))).replace('{mph}', String(Math.round(mph)));
    this.show(line);
  }

  stop(): void {
    if (!this.playing) return;
    const g = this.game;
    this.playing = false;
    this.gap = true;
    this.hide();
    g.camera.fov = this.liveFov;
    g.camera.updateProjectionMatrix();
    if (g.state === 'play' || g.state === 'paused') g.input.setEnabled(this.inputWas);
    // The buffers still hold the replay's pose: draw the live one again now, in case the game is paused.
    g.vehicles.update(0);
    g.occupants.place();
    g.people.update(0);
    g.cam.snap();
  }

  private padDown(): boolean {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return false;
    for (const p of pads) if (p) for (const b of p.buttons) if (b.pressed) return true;
    return false;
  }

  /** Where along the buffer a recorded time falls: the two frames either side and how far between (one shared answer). */
  private readonly _at = { i0: 0, i1: 0, a: 0 };
  private sample(t: number): { i0: number; i1: number; a: number } {
    const r = this._at;
    let lo = 0, hi = this.count - 1;
    if (t <= this.times[this.index(0)]) { r.i0 = r.i1 = this.index(0); r.a = 0; return r; }
    if (t >= this.times[this.index(hi)]) { r.i0 = r.i1 = this.index(hi); r.a = 0; return r; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.times[this.index(m)] <= t) lo = m; else hi = m; }
    const i0 = this.index(lo), i1 = this.index(hi), t0 = this.times[i0], t1 = this.times[i1];
    r.i0 = i0;
    // Across a cut (the gap a replay leaves), never blend: one side or the other.
    if (this.head[i1 * HF + 12] > 0) { r.i1 = i0; r.a = 0; return r; }
    r.i1 = i1; r.a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return r;
  }

  private focusAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const { i0, i1, a } = this.sample(t), h = this.head;
    return out.set(lerp(h[i0 * HF + 8], h[i1 * HF + 8], a), lerp(h[i0 * HF + 9], h[i1 * HF + 9], a), lerp(h[i0 * HF + 10], h[i1 * HF + 10], a));
  }

  private beginShot(): void {
    const t = this.playT;
    // The way things are going: the focus a moment ahead minus a moment behind.
    const f = this.focusAt(t, _look).clone();
    const ahead = this.focusAt(Math.min(this.to, t + 0.6), _v);
    this.fwd.set(ahead.x - f.x, 0, ahead.z - f.z);
    if (this.fwd.lengthSq() < 0.5) { const { i0 } = this.sample(t), h = this.head; _qa.set(h[i0 * HF + 3], h[i0 * HF + 4], h[i0 * HF + 5], h[i0 * HF + 6]); this.fwd.set(0, 0, -1).applyQuaternion(_qa).setY(0); }
    this.fwd.normalize();
    this.perp.set(this.fwd.z, 0, -this.fwd.x);
    this.side = -this.side;
    this.a0 = Math.atan2(this.perp.x * this.side, this.perp.z * this.side);
    // A fixed spot for the television shot: beside where things will be in a second and a half.
    const later = this.focusAt(Math.min(this.to, t + 1.6), _v);
    this.fixed.set(later.x + this.perp.x * this.side * 13 + this.fwd.x * 7, 0, later.z + this.perp.z * this.side * 13 + this.fwd.z * 7);
    this.fixed.y = Math.max(groundAt(this.fixed.x, this.fixed.z), waterLevelAt(this.fixed.x, this.fixed.z)) + 1.7;
    this.lookSnap = true;
  }

  private play(dt: number): void {
    if (dt <= 0) { this.place(); return; }
    // Skips from a pad: a fresh press.
    const pad = this.padDown();
    if (pad && !this.padWas && performance.now() - this.startedAt > 250) { this.stats.skipped++; this.stop(); return; }
    this.padWas = pad;
    const { i0, i1, a } = this.sample(this.playT);
    const excite = lerp(this.head[i0 * HF + 11], this.head[i1 * HF + 11], a);
    const want = excite > 0.5 ? (this.manual ? 0.4 : 0.28) : (this.manual ? 1 : 0.75);
    this.rate += (want - this.rate) * Math.min(1, dt * 3);
    const before = this.playT;
    this.playT += dt * this.rate;
    this.wall += dt; this.shotT += dt;
    // A cut crossed in the recording is a cut on screen too.
    const j = this.sample(this.playT);
    const cut = this.head[j.i1 * HF + 12] > 0 && this.times[j.i1] > before && this.times[j.i1] <= this.playT + 0.02;
    if (this.playT >= this.to || this.wall > 30) { this.stop(); return; }
    if (this.shotT > SHOT || cut) { this.shotT = 0; this.shotI = (this.shotI + 1) % this.shots.length; this.beginShot(); }
    const r = this.rate.toFixed(2) + '×';
    if (r !== this.shownRate && this.rateEl) { this.shownRate = r; this.rateEl.textContent = r; }
    if (this.capEl && this.wall > 0.5) this.capEl.style.opacity = '1';
    this.place();
  }

  /** The cinematic camera for this moment. */
  private place(): void {
    const g = this.game, cam = g.camera, t = this.playT;
    const { i0, i1, a } = this.sample(t), h = this.head;
    const shot = this.shots[this.shotI];
    const f = this.focusAt(t, _look);
    if (shot === 'game') {
      cam.position.set(lerp(h[i0 * HF], h[i1 * HF], a), lerp(h[i0 * HF + 1], h[i1 * HF + 1], a), lerp(h[i0 * HF + 2], h[i1 * HF + 2], a));
      _qa.set(h[i0 * HF + 3], h[i0 * HF + 4], h[i0 * HF + 5], h[i0 * HF + 6]);
      _qb.set(h[i1 * HF + 3], h[i1 * HF + 4], h[i1 * HF + 5], h[i1 * HF + 6]);
      cam.quaternion.slerpQuaternions(_qa, _qb, a);
      cam.fov = lerp(h[i0 * HF + 7], h[i1 * HF + 7], a);
      cam.updateProjectionMatrix();
      return;
    }
    const s = this.side;
    let x: number, y: number, z: number;
    if (shot === 'low') {
      // Tracking alongside, low to the road, a little behind: the car goes up and out of the frame.
      x = f.x + this.perp.x * s * 6.5 - this.fwd.x * 2.5; z = f.z + this.perp.z * s * 6.5 - this.fwd.z * 2.5;
      y = Math.max(groundAt(x, z), waterLevelAt(x, z)) + 0.55;
    } else if (shot === 'orbit') {
      const ang = this.a0 + this.shotT * 0.42 * s;
      x = f.x + Math.sin(ang) * 10; z = f.z + Math.cos(ang) * 10;
      y = Math.max(f.y + 2.4, Math.max(groundAt(x, z), waterLevelAt(x, z)) + 1.2);
    } else {
      x = this.fixed.x; y = this.fixed.y; z = this.fixed.z;
    }
    // Smoothed aim; walls pull the lens in toward what it is looking at.
    if (this.lookSnap) { this.lookS.copy(f); this.lookSnap = false; } else this.lookS.lerp(f, 0.18);
    const L = this.lookS;
    _v.set(x - L.x, y - L.y, z - L.z);
    const d = _v.length();
    if (d > 0.5) {
      _v.multiplyScalar(1 / d);
      const hit = g.col.raycast(L.x, L.y, L.z, _v.x, _v.y, _v.z, d);
      if (hit < d) { const k = Math.max(1.5, hit - 0.4); x = L.x + _v.x * k; y = L.y + _v.y * k; z = L.z + _v.z * k; }
    }
    y = Math.max(y, Math.max(groundAt(x, z), waterLevelAt(x, z)) + 0.35);
    cam.position.set(x, y, z);
    cam.lookAt(L);
    const dist = Math.max(1, Math.hypot(x - L.x, y - L.y, z - L.z));
    cam.fov = shot === 'tv' ? THREE.MathUtils.clamp(2 * Math.atan(7 / dist) * 180 / Math.PI, 16, 55) : shot === 'low' ? 62 : 50;
    cam.updateProjectionMatrix();
  }

  // ── Drawing the recorded pose (around Game.render) ─────────────────────────

  private install(): void {
    const g = this.game, draw = g.render.bind(g);
    g.render = (): void => {
      if (!this.playing) { draw(); return; }
      this.pose();
      try { draw(); } finally { this.unpose(); }
    };
  }

  private pose(): void {
    const g = this.game, { i0, i1, a } = this.sample(this.playT);
    const cf = this.carF, lc = this.liveC;
    for (let s = 0; s < NC; s++) {
      this.liveCars[s] = null;
      const r0 = this.carRef[i0 * NC + s], r1 = this.carRef[i1 * NC + s];
      const ref = r0 && r0 === r1 ? r0 : a < 0.5 ? r0 : r1;
      if (!ref) continue;
      const c = ref as unknown as CarLive;
      if (c.removed) continue;
      const q0 = (i0 * NC + s) * CF, q1 = (i1 * NC + s) * CF, both = r0 === r1;
      const k = both ? a : 0, A = both || ref === r0 ? q0 : q1, B = both ? q1 : A;
      const o = s * 11;
      lc[o] = c.x; lc[o + 1] = c.y; lc[o + 2] = c.z; lc[o + 3] = c.h; lc[o + 4] = c.pitch; lc[o + 5] = c.roll;
      lc[o + 6] = c.groundRoll; lc[o + 7] = c.lift; lc[o + 8] = c.steerAng; lc[o + 9] = c.spinF; lc[o + 10] = c.spinR;
      this.liveCars[s] = c;
      c.x = lerp(cf[A], cf[B], k); c.y = lerp(cf[A + 1], cf[B + 1], k); c.z = lerp(cf[A + 2], cf[B + 2], k);
      c.h = lerpAng(cf[A + 3], cf[B + 3], k); c.pitch = lerp(cf[A + 4], cf[B + 4], k);
      c.roll = c.groundRoll = lerp(cf[A + 5], cf[B + 5], k); c.lift = 0;
      c.steerAng = lerp(cf[A + 6], cf[B + 6], k);
      // The wheels turn with the recorded speed over recorded time.
      const turn = (this.playT * lerp(cf[A + 7], cf[B + 7], k) / c.spec.wheelR) % (Math.PI * 2);
      c.spinF = c.spinR = turn;
      c.stale = true;
    }
    g.vehicles.update(0);
    g.occupants.place();
    const pf = this.pF, lx = this.liveBX, lcur = this.liveCur;
    for (let s = 0; s < NP; s++) {
      this.liveB[s] = null;
      const r0 = this.pRef[i0 * NP + s], r1 = this.pRef[i1 * NP + s];
      const ref = r0 && r0 === r1 ? r0 : a < 0.5 ? r0 : r1;
      if (!ref) continue;
      const b = ref as unknown as BodyLive;
      if (!b.visible || b.occupant) continue;
      const q0 = (i0 * NP + s) * PF, q1 = (i1 * NP + s) * PF, both = r0 === r1;
      const k = both ? a : 0, A = both || ref === r0 ? q0 : q1, B = both ? q1 : A;
      this.liveB[s] = b;
      lx[s * 3] = b.x; lx[s * 3 + 1] = b.y; lx[s * 3 + 2] = b.z;
      this.liveRag[s] = b.rag; this.liveRagCh[s] = b.ragCh;
      lcur.set(b.cur, s * NCH * 2); lcur.set(b.from, s * NCH * 2 + NCH);
      const M = this.pupM[s], C = this.pupC[s];
      for (let j = 0; j < 16; j++) M[j] = lerp(pf[A + j], pf[B + j], k);
      for (let j = 0; j < NCH; j++) C[j] = lerp(pf[A + 16 + j], pf[B + 16 + j], k);
      b.x = lerp(pf[A + 45], pf[B + 45], k); b.y = lerp(pf[A + 46], pf[B + 46], k); b.z = lerp(pf[A + 47], pf[B + 47], k);
      b.rag = M; b.ragCh = C;
    }
    g.people.update(0);
  }

  private unpose(): void {
    const lc = this.liveC;
    for (let s = 0; s < NC; s++) {
      const c = this.liveCars[s];
      if (!c) continue;
      const o = s * 11;
      c.x = lc[o]; c.y = lc[o + 1]; c.z = lc[o + 2]; c.h = lc[o + 3]; c.pitch = lc[o + 4]; c.roll = lc[o + 5];
      c.groundRoll = lc[o + 6]; c.lift = lc[o + 7]; c.steerAng = lc[o + 8]; c.spinF = lc[o + 9]; c.spinR = lc[o + 10];
      c.stale = true;
      this.liveCars[s] = null;
    }
    const lx = this.liveBX, lcur = this.liveCur;
    for (let s = 0; s < NP; s++) {
      const b = this.liveB[s];
      if (!b) continue;
      b.x = lx[s * 3]; b.y = lx[s * 3 + 1]; b.z = lx[s * 3 + 2];
      b.rag = this.liveRag[s]; b.ragCh = this.liveRagCh[s];
      b.cur.set(lcur.subarray(s * NCH * 2, s * NCH * 2 + NCH));
      b.from.set(lcur.subarray(s * NCH * 2 + NCH, s * NCH * 2 + NCH * 2));
      this.liveB[s] = null; this.liveRag[s] = null; this.liveRagCh[s] = null;
    }
  }

  // ── The film strip ────────────────────────────────────────────────────────

  private show(caption: string): void {
    if (!this.el) this.build();
    const el = this.el!;
    this.capEl!.textContent = caption;
    this.capEl!.style.opacity = '0';
    this.shownRate = '';
    const touch = this.game.input.touch || matchMedia('(pointer: coarse)').matches;
    this.skipEl!.textContent = touch ? 'Tap to skip' : 'Any key to skip';
    el.style.display = 'block';
    document.body.classList.add('pc-replaying');
  }

  private hide(): void {
    if (this.el) this.el.style.display = 'none';
    document.body.classList.remove('pc-replaying');
  }

  private build(): void {
    const css = document.createElement('style');
    css.textContent = `
#pc-replay{position:fixed;inset:0;z-index:60;display:none;cursor:pointer;touch-action:none;
  box-shadow:inset 0 0 18vmin rgba(0,0,0,.55);}
#pc-replay .rp-bar{position:absolute;left:0;right:0;height:clamp(40px,11vh,84px);background:#0c0b0a;
  display:flex;align-items:center;justify-content:space-between;padding:0 max(16px,env(safe-area-inset-left));box-sizing:border-box;}
#pc-replay .rp-top{top:0}
#pc-replay .rp-bot{bottom:0;justify-content:center}
#pc-replay .rp-bar::before,#pc-replay .rp-bar::after{content:'';position:absolute;left:0;right:0;height:clamp(5px,1.3vh,9px);
  background:repeating-linear-gradient(90deg,transparent 0 9px,rgba(242,232,207,.82) 9px 21px,transparent 21px 30px);opacity:.75}
#pc-replay .rp-top::before{top:clamp(4px,1vh,8px)} #pc-replay .rp-top::after{display:none}
#pc-replay .rp-bot::after{bottom:clamp(4px,1vh,8px)} #pc-replay .rp-bot::before{display:none}
#pc-replay .rp-tag{font:700 clamp(12px,2.2vmin,16px) var(--f-mono,monospace);letter-spacing:.2em;color:#f2e8cf;padding-top:clamp(6px,1.4vh,10px)}
#pc-replay .rp-tag i{display:inline-block;width:.7em;height:.7em;border-radius:50%;background:#c1121f;margin-right:.6em;vertical-align:-.05em;animation:rp-blink 1s steps(2) infinite}
#pc-replay .rp-cap{font:700 clamp(14px,3vmin,24px)/1.2 var(--f-head,sans-serif);text-transform:uppercase;letter-spacing:.05em;color:#f2e8cf;
  text-align:center;padding:0 12px clamp(6px,1.4vh,10px);opacity:0;transition:opacity .6s;max-width:min(60em,100%)}
#pc-replay .rp-skip{opacity:.65}
@keyframes rp-blink{0%{opacity:1}100%{opacity:.15}}
body.pc-replaying #hud,body.pc-replaying #touch{visibility:hidden}
body.reduced-motion #pc-replay .rp-tag i{animation:none}`;
    document.head.append(css);
    const el = document.createElement('div');
    el.id = 'pc-replay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Replay');
    el.innerHTML = `<div class="rp-bar rp-top"><span class="rp-tag"><i></i>REPLAY <b class="rp-rate"></b></span>`
      + `<span class="rp-tag rp-skip"></span></div>`
      + `<div class="rp-bar rp-bot"><div class="rp-cap"></div></div>`;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (performance.now() - this.startedAt > 250) { this.stats.skipped++; this.stop(); }
    });
    document.body.append(el);
    this.el = el;
    this.capEl = el.querySelector('.rp-cap');
    this.rateEl = el.querySelector('.rp-rate');
    this.skipEl = el.querySelector('.rp-skip');
  }
}
