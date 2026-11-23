// The mission script: a small typed, step-based format and the runner that
// plays it.
//
// A mission is a list of steps. Most steps are instant (spawn a van, say a
// line in passing, start a countdown, pay her); the rest hold the floor until
// the player has done something (got there, got in, collected them all, lost
// the heat, kept the tail, beaten the clock, outlasted the timer). The runner
// plays one mission at a time, keeps one objective on the strip, one target on
// the radar with its route, markers in the world, and a checkpoint to come
// back to when it goes wrong.
//
// Nothing in here knows a name or a line of dialogue: that is missions.ts.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Look, Person, Vehicle } from '../core/api';
import { KINDS, type VehicleKind } from '../ent/vehicleSpecs';
import type { WeaponId } from '../ent/weapons';
import type { Blip } from '../ui/hud';
import { groundAt } from '../world/plan';
import type { CityPlan } from '../world/plan';
import { progress } from '../world/progress';
import { RNG, money } from '../core/util';
import { save } from './save';

export interface Pt { x: number; z: number }

/** How the player has to arrive: on foot, at the wheel of anything, or either. */
export type Mode = 'any' | 'foot' | 'car';

export type Step =
  // ── Instant ──
  /** A line of dialogue. It holds the script until it has been read (or skipped with G) unless `bg`, which says it over whatever comes next. */
  | { t: 'say'; who: string; text: string; bg?: boolean }
  | { t: 'spawnVehicle'; tag: string; kind: VehicleKind; at: Pt; h: number; color?: number }
  | { t: 'spawnActor'; tag: string; at: Pt; h: number; look?: Partial<Look> }
  | { t: 'despawn'; tag: string }
  | { t: 'money'; amount: number; note?: string }
  | { t: 'heat'; level: number }
  | { t: 'give'; weapon: WeaponId; ammo: number }
  /** Start the countdown shown under the objective strip; running out fails the mission. `secs: 0` stops it. */
  | { t: 'timer'; secs: number; label?: string }
  /** Failing after this starts again from here. */
  | { t: 'checkpoint' }
  // ── Holding ──
  | { t: 'wait'; secs: number }
  /** Get to a place: by any means, on foot, in any vehicle, in one kind of vehicle, or in one particular (tagged) vehicle. `stop` wants her at rest there. */
  | { t: 'goto'; at: Pt; text: string; r?: number; mode?: Mode; kind?: VehicleKind; tag?: string; stop?: boolean }
  /** Be at the wheel of a tagged vehicle, or of any vehicle of a kind. */
  | { t: 'getVehicle'; text: string; tag?: string; kind?: VehicleKind }
  /** Bring a tagged vehicle to a place and stop it there. */
  | { t: 'deliver'; tag: string; at: Pt; text: string; r?: number }
  /** Pick up every item, in any order. */
  | { t: 'collect'; items: Pt[]; text: string; r?: number; mode?: Mode }
  /** Wreck every tagged vehicle (burnt out, or in the Sound). */
  | { t: 'destroy'; tags: string[]; text: string }
  | { t: 'loseHeat'; text: string }
  /** Follow a tagged vehicle as it drives `route`: fail by crowding it (inside `near` m) or losing it (beyond `far` m). */
  | { t: 'tail'; tag: string; route: Pt[] | (() => Pt[]); text: string; speed?: number; near?: number; far?: number }
  /** Through every checkpoint in order inside `par` seconds. */
  | { t: 'race'; cps: Pt[]; par: number; text: string; r?: number; mode?: Mode }
  /** Last `secs` seconds; with `at`, the clock only runs while she is within `r` of it. */
  | { t: 'survive'; secs: number; text: string; at?: Pt; r?: number };

export interface Mission {
  id: string;
  title: string;
  /** Key into the giver table. */
  giver: string;
  /** One dry line under the title when it starts. */
  intro: string;
  /** Mission ids that must be filed first. */
  needs?: string[];
  /** Town stage (progress.stage) that must be open. */
  stage?: number;
  reward: number;
  points: number;
  /** What finishing it opens, said in a notice. */
  unlocks: string;
  steps: Step[];
}

export interface Giver {
  name: string;
  /** One letter for the radar badge. */
  letter: string;
  at: Pt; h: number;
  look: Look;
  /** Said by the prompt when she walks up: "Talk to Finch". */
  short: string;
}

const HOLDING = new Set(['wait', 'goto', 'getVehicle', 'deliver', 'collect', 'destroy', 'loseHeat', 'tail', 'race', 'survive']);
export const clock = (s: number): string => { const t = Math.max(0, Math.ceil(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);

/** The streets between two points as a line a car can follow: intersection to intersection, kept to the right-hand lane. */
export function streetRoute(plan: CityPlan, a: Pt, b: Pt, lane = 3): Pt[] {
  const ids = plan.findPath(plan.nearestNode(a.x, a.z).id, plan.nearestNode(b.x, b.z).id);
  const c: Pt[] = ids.map((id) => ({ x: plan.nodes[id].x, z: plan.nodes[id].z }));
  if (c.length < 2) return [a, b];
  const out: Pt[] = [];
  for (let i = 0; i < c.length; i++) {
    let rx = 0, rz = 0;
    for (const k of [i - 1, i]) {
      if (k < 0 || k + 1 >= c.length) continue;
      const dx = c[k + 1].x - c[k].x, dz = c[k + 1].z - c[k].z, l = Math.hypot(dx, dz) || 1;
      rx += -dz / l; rz += dx / l;
    }
    out.push({ x: c[i].x + rx * lane, z: c[i].z + rz * lane });
  }
  return out;
}

/**
 * Where a script's own car can go when it wants the spot `at` (facing h). Alone that is the spot: whatever the city
 * parked there has been towed. In a shared town a car this browser is only SHOWN (the town's, placed by the host;
 * another player's) cannot be towed from here, because it would still be standing there for everybody else: the
 * script's car then takes the nearest clear length of the same lane instead.
 */
export function clearOf(game: Game, at: Pt, h: number): Pt {
  const vs = game.vehicles;
  const taken = (x: number, z: number): boolean => {
    for (const o of vs.list) if (o.shared && Math.hypot(o.x - x, o.z - z) < 5) return true;
    for (const o of vs.ghostList) if (Math.hypot(o.x - x, o.z - z) < 5) return true;
    return false;
  };
  if (!taken(at.x, at.z)) return at;
  const sx = Math.sin(h), sz = Math.cos(h);
  for (let k = 1; k <= 5; k++) for (const s of [1, -1]) {
    const x = at.x + sx * 6.5 * k * s, z = at.z + sz * 6.5 * k * s;
    if (!taken(x, z) && !vs.nearest(x, z, 5)) return { x, z };
  }
  return at;
}

/** A mission person's look in a shared town: the step's own, the rest fixed by the mission and the step, the same in every browser. */
export function actorLook(game: Game, mission: number, step: number, s: Step): Look {
  const own = s.t === 'spawnActor' ? s.look : undefined;
  return { ...game.people.randomLook(new RNG(((mission + 1) * 7919 + step * 104729) ^ 0x2c1b3c6d), true), ...own };
}

// ── World markers ────────────────────────────────────────────────────────────

export type MarkKind = 'goal' | 'giver' | 'job' | 'item';
const MARK_COLOR: Record<MarkKind, number> = { goal: 0xf0a202, giver: 0xf2e8cf, job: 0x2a9d8f, item: 0xf0a202 };

/**
 * A tall soft column of light over a ring on the ground, in the glow style of
 * the particles: additive, no depth write, fading to nothing at the top. Drawn
 * immediate-mode: begin(), put() for each one wanted this frame, end().
 */
export class Markers {
  private readonly beams: THREE.Mesh[] = [];
  private readonly rings: THREE.Mesh[] = [];
  private readonly mats = new Map<MarkKind, [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial]>();
  private readonly beamGeo: THREE.CylinderGeometry;
  private readonly ringGeo: THREE.RingGeometry;
  private readonly fade: THREE.CanvasTexture;
  private used = 0;
  private t = 0;

  constructor(private readonly game: Game) {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 128;
    const x = c.getContext('2d') as CanvasRenderingContext2D, g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.3)'); g.addColorStop(1, 'rgba(255,255,255,0.8)');
    x.fillStyle = g; x.fillRect(0, 0, 4, 128);
    this.fade = new THREE.CanvasTexture(c);
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
    this.beamGeo.translate(0, 0.5, 0);
    this.ringGeo = new THREE.RingGeometry(0.8, 1, 48);
    this.ringGeo.rotateX(-Math.PI / 2);
  }

  private mat(kind: MarkKind): [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial] {
    let m = this.mats.get(kind);
    if (!m) {
      // Not additive: against a noon sky an additive column is white on white. Plain see-through colour reads at any hour.
      const base = { color: MARK_COLOR[kind], transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false };
      m = [new THREE.MeshBasicMaterial({ ...base, map: this.fade }), new THREE.MeshBasicMaterial({ ...base, opacity: 0.85 })];
      this.mats.set(kind, m);
    }
    return m;
  }

  begin(dt: number): void { this.used = 0; this.t += dt; }

  /** r: radius of the ring in meters. tall: height of the column. lift: how far up the column starts (over a person's head, say). */
  put(x: number, z: number, kind: MarkKind, r = 4, tall = 30, lift = 0): void {
    const i = this.used++;
    if (i >= this.beams.length) {
      const b = new THREE.Mesh(this.beamGeo), g = new THREE.Mesh(this.ringGeo);
      b.frustumCulled = g.frustumCulled = false;
      b.renderOrder = g.renderOrder = 5;
      this.game.scene.add(b, g);
      this.beams.push(b); this.rings.push(g);
    }
    const b = this.beams[i], g = this.rings[i], [mb, mr] = this.mat(kind);
    const y = Math.max(groundAt(x, z), -0.7) + 0.14;
    b.material = mb; g.material = mr;
    b.visible = g.visible = true;
    const reduced = document.body.classList.contains('reduced-motion');
    const pulse = reduced ? 1 : 1 + 0.07 * Math.sin(this.t * 3.2 + i);
    b.position.set(x, y + lift, z); b.scale.set(r * 0.5, tall, r * 0.5);
    g.position.set(x, y, z); g.scale.set(r * pulse, 1, r * pulse);
  }

  end(): void {
    for (let i = this.used; i < this.beams.length; i++) this.beams[i].visible = this.rings[i].visible = false;
  }
}

// ── The runner ───────────────────────────────────────────────────────────────

interface Rail { v: Vehicle; pts: Pt[]; seg: number; s: number; speed: number; done: boolean }
interface Snap { i: number; x: number; z: number; h: number; tag: string | null; kind: VehicleKind | null; timer: number; timerLabel: string; code: number }
interface Line { who: string; text: string; left: number }

/** What the runner is asking for right now, for the scripted player in the tests. */
/**
 * Every way a mission can fail, title and line. The runner fails only with these, so a starter can tell its helpers
 * which by number (net/crew.ts) and their own browser says the words.
 */
export const FAILS: readonly (readonly [string, string])[] = [
  ['BOOKED', 'The Harbor Patrol has filed you under "pending".'],
  ['CLOCKED OUT', 'You did not live to invoice for it.'],
  ['PAST DUE', 'The clock ran out. It always had more time than you.'],
  ['WRITTEN OFF', 'That vehicle was the whole job.'],
  ['THE TRAIL WENT COLD', 'There is nothing left of them to follow.'],
  ['MADE', 'They looked in the mirror and you were all of it.'],
  ['THE TRAIL WENT COLD', 'They went one way. You went into speculation.'],
];

/** One marker as the runner put it this frame: what a helper is shown (net/crew.ts). kind: 0 goal, 1 item, 2 none (only a blip or the route's end). */
export interface ViewMark { x: number; z: number; r: number; kind: number; blip: boolean; target: boolean; tall: number }
/**
 * What the runner showed this frame, as numbers: the objective (0 none, 1 step `arg`'s text, 2 "get back in" the kind
 * `arg`, 3 back inside the ring), the timer (label: a step's index, or one of crew.ts's fixed labels; mode 0 none,
 * 1 counting down, 2 standing, 3 meters), and the markers.
 */
export interface View { what: number; arg: number; label: number; mode: number; value: number; urgent: boolean; marks: ViewMark[] }

/** What a helper on another player's mission is shown (net/crew.ts fills it; the runner draws it). */
export interface Guest {
  /** The starter's made-up name. */
  who: string;
  m: Mission;
  /** "You are on X's job: Title." */
  line: string;
  objective: string | null;
  timerLabel: string | null;
  timerMode: number;
  timerValue: number;
  timerUrgent: boolean;
  /** How fast the starter's mission clock runs against the wall clock (0: paused), as told with the value. */
  timerRate: number;
  /** performance.now() when the timer value was told. */
  timerAt: number;
  marks: ViewMark[];
}

/** The runner's line to a shared town (net/crew.ts). Alone it is null and nothing changes. */
export interface CrewLink {
  /** A mission has begun here (a retry is a beginning). */
  began(m: Mission): void;
  /** It is over: passed, failed (with the index of its line in FAILS) or set aside. */
  ended(m: Mission, how: 'pass' | 'fail' | 'aside', why: number): void;
  /** Is this car of the script's out with a helper, being driven in their browser? */
  lent(v: Vehicle): boolean;
  /** The script is done with a car a helper has: theirs to keep as an ordinary car (the mission is over), or taken away. */
  drop(v: Vehicle, keep: boolean): void;
  /**
   * The crew's players where this browser shows them (alive, in town). A goto, a collect, a race's checkpoint, a
   * getVehicle of a kind and a survive ring are met by any of them as by the starter (stage 4, step 3, second piece).
   */
  members(): readonly CrewMember[];
  /** In a town on the main service (where missions are shared): only then do a mission's people get a fixed look. */
  shared(): boolean;
}

/** A helper as the starter's browser shows them: where, and the kind of car they are at the wheel of (null on foot). */
export interface CrewMember { x: number; z: number; kind: VehicleKind | null; speed: number }

function memberSeated(c: CrewMember, mode: Mode | undefined, kind: VehicleKind | undefined): boolean {
  if (kind) return c.kind === kind;
  if (mode === 'foot') return !c.kind;
  if (mode === 'car') return !!c.kind;
  return true;
}

export interface Want { id: string; i: number; t: string; at: Pt | null; r: number; mode: Mode; tag: string | null; kind: VehicleKind | null; stop: boolean; tags: string[]; items: Pt[]; failed: string | null }

export class Runner {
  cur: Mission | null = null;
  /** The reason the mission in hand has failed, while a retry is on offer. */
  failed: string | null = null;
  /** Wanted on the prompt line this frame. */
  prompt: string | null = null;
  /** Where the business in hand is, for the route line. */
  target: Pt | null = null;
  readonly ents = new Map<string, Vehicle | Person>();
  /** Multiplayer: set by net/crew.ts in a shared town on the main service. */
  crew: CrewLink | null = null;
  /** Multiplayer: this player is on another player's mission, and this is what they are shown of it. */
  guest: Guest | null = null;
  /** What was shown this frame, for the helpers (see View). */
  readonly view: View = { what: 0, arg: 0, label: 0, mode: 0, value: 0, urgent: false, marks: [] };
  private nMarks = 0;
  private readonly markPool: ViewMark[] = [];

  private i = 0;
  private stepT = 0;
  private entered = false;
  private timer = 0; private timerLabel = '';
  /** The countdown's label as crew.ts sends it: the `timer` step that named it, or one of the fixed ones. */
  private labelCode = 249;
  private lastObj = '';
  private cp: Snap | null = null;
  private lines: Line[] = [];
  private rail: Rail | null = null;
  private left: Pt[] = [];
  private cpI = 0;
  private nearT = 0; private farT = 0;
  private failT = 0;
  private count = 0;
  private readonly people = new Map<string, Person>();

  constructor(
    private readonly game: Game,
    private readonly markers: Markers,
    readonly givers: Record<string, Giver>,
    readonly missions: Mission[],
    /** Told when a mission starts and when the floor is free again. */
    private readonly onBusy: (id: string | null) => void,
    private readonly isFree: () => boolean,
  ) {
    for (const [id, g] of Object.entries(givers)) {
      const p = game.people.spawn(g.at.x, g.at.z, g.h, g.look);
      p.pose = 'stand';
      this.people.set(id, p);
    }
    game.on('booked', () => { if (this.cur && !this.failed) this.fail('BOOKED', 'The Harbor Patrol has filed you under "pending".'); });
  }

  done(id: string): boolean { return save.data.missions.includes(id); }

  /** Can it be started now? */
  open(m: Mission): boolean {
    if (this.done(m.id)) return false;
    if (m.stage !== undefined && progress.stage < m.stage) return false;
    return !(m.needs ?? []).some((n) => !this.done(n));
  }

  /** The mission each giver has waiting, if any. */
  offers(): { giver: string; m: Mission }[] {
    const out: { giver: string; m: Mission }[] = [];
    for (const m of this.missions) if (this.open(m) && !out.some((o) => o.giver === m.giver)) out.push({ giver: m.giver, m });
    return out;
  }

  blips(out: Blip[]): void {
    const gu = this.guest;
    if (gu && !this.cur) { for (const k of gu.marks) if (k.blip) out.push({ x: k.x, z: k.z, kind: 'goal' }); return; }
    const s = this.step();
    if (!this.cur || this.failed) {
      if (!this.cur) for (const o of this.offers()) { const g = this.givers[o.giver]; out.push({ x: g.at.x, z: g.at.z, kind: 'giver', label: g.letter }); }
      return;
    }
    if (!s) return;
    if (s.t === 'collect') { for (const p of this.left.slice(0, 8)) out.push({ x: p.x, z: p.z, kind: 'goal' }); return; }
    if (s.t === 'destroy') { for (const tag of s.tags) { const v = this.car(tag); if (v && !this.gone(v)) out.push({ x: v.x, z: v.z, kind: 'goal' }); } return; }
    if (this.target) out.push({ x: this.target.x, z: this.target.z, kind: 'goal' });
  }

  private step(): Step | null { return this.cur ? this.cur.steps[this.i] ?? null : null; }
  private car(tag: string): Vehicle | null { const e = this.ents.get(tag); return e && 'spec' in e ? e : null; }
  private gone(v: Vehicle): boolean { return !!v.wreck || v.sunk || (!this.crew?.lent(v) && !this.game.vehicles.list.includes(v)); }
  /** At the wheel of it: this player, or (in a shared town) a helper this player's browser lent it to. */
  private driving(v: Vehicle): boolean { return this.game.player.vehicle === v || !!this.crew?.lent(v); }

  /** A helper has handed back a car of the script's: the new one stands in for the old under the same tag. */
  swap(old: Vehicle, now: Vehicle): void {
    for (const [k, e] of this.ents) if (e === old) this.ents.set(k, now);
    if (this.rail && this.rail.v === old) this.rail.v = now;
  }
  /** Is this one of the script's cars? */
  owns(v: Vehicle): boolean { for (const e of this.ents.values()) if (e === v) return true; return false; }
  /** One of the script's cars that a step wants driven (a getVehicle, deliver or goto names its tag): a helper may borrow it. A target may not. */
  drivable(v: Vehicle): boolean {
    const m = this.cur;
    if (!m) return false;
    for (const [k, e] of this.ents) {
      if (e !== v) continue;
      return m.steps.some((s) => (s.t === 'getVehicle' || s.t === 'deliver' || s.t === 'goto') && s.tag === k);
    }
    return false;
  }
  /** The script's people, with the `spawnActor` step that made each (crew.ts shows them to the helpers). The list is reused. */
  actors(): readonly { p: Person; step: number }[] {
    const out = this.actorOut;
    out.length = 0;
    for (const [p, step] of this.actorStep) out.push({ p, step });
    return out;
  }
  private readonly actorStep = new Map<Person, number>();
  private readonly actorOut: { p: Person; step: number }[] = [];

  // ── What is shown, for the helpers ─────────────────────────────────────────

  private obj(what: number, arg: number, text: string | null): void {
    this.view.what = what; this.view.arg = arg;
    this.game.hud.objective(text);
  }
  private time(label: number, mode: number, value: number, urgent: boolean, text: string, shown: string): void {
    const v = this.view;
    v.label = label; v.mode = mode; v.value = value; v.urgent = urgent;
    this.game.hud.timer(text, shown, urgent);
  }
  private noTime(): void { this.view.mode = 0; this.game.hud.timer(null); }
  private mark(x: number, z: number, kind: 'goal' | 'item', r: number, tall: number, blip = false): void {
    this.markers.put(x, z, kind, r, tall);
    const m = this.markPool[this.nMarks] ?? (this.markPool[this.nMarks] = { x: 0, z: 0, r: 0, kind: 0, blip: false, target: false, tall: 0 });
    this.nMarks++;
    m.x = x; m.z = z; m.r = r; m.kind = kind === 'goal' ? 0 : 1; m.blip = blip; m.target = false; m.tall = tall;
  }
  /** The frame's markers into the view, with the route's end marked (and added when it is not one of them). */
  private closeView(): void {
    const v = this.view, t = this.target;
    v.marks.length = 0;
    for (let i = 0; i < this.nMarks; i++) v.marks.push(this.markPool[i]);
    if (!this.cur || this.failed) { v.marks.length = 0; return; }
    if (t) {
      let hit = false;
      for (const m of v.marks) if (Math.abs(m.x - t.x) < 0.3 && Math.abs(m.z - t.z) < 0.3) { m.target = m.blip = true; hit = true; break; }
      if (!hit) {
        const m = this.markPool[this.nMarks] ?? (this.markPool[this.nMarks] = { x: 0, z: 0, r: 0, kind: 0, blip: false, target: false, tall: 0 });
        m.x = t.x; m.z = t.z; m.r = 0; m.kind = 2; m.blip = true; m.target = true; m.tall = 0;
        v.marks.push(m);
      }
    }
  }

  // ── Starting, finishing, failing ───────────────────────────────────────────

  start(m: Mission): void {
    const g = this.game;
    this.cur = m; this.failed = null;
    this.i = 0; this.entered = false; this.stepT = 0;
    this.timer = 0; this.lines.length = 0; this.rail = null;
    this.onBusy(m.id);
    this.cp = this.snap(0);
    // Whatever the strip was saying (the newcomer's tour, usually) gives way to the mission.
    this.obj(0, 0, null);
    g.hud.stamp(m.title, m.intro);
    this.crew?.began(m);
  }

  private snap(i: number): Snap {
    const p = this.game.player, v = p.vehicle;
    let tag: string | null = null;
    if (v) for (const [k, e] of this.ents) if (e === v) tag = k;
    const base = { i, timer: this.timer, timerLabel: this.timerLabel, code: this.labelCode };
    if (!v && this.crew) {
      // In a shared town a helper may be at the wheel of the script's car when the checkpoint is passed (crew.ts). The
      // checkpoint is then that car, where it is: a retry puts the starter at its wheel there, as if they had been
      // driving it (the helpers are drafted again around that spot).
      for (const [k, e] of this.ents) if ('spec' in e && this.crew.lent(e)) return { ...base, x: e.x, z: e.z, h: e.h, tag: k, kind: e.spec.kind };
    }
    return { ...base, x: p.x, z: p.z, h: p.h, tag, kind: v ? v.spec.kind : null };
  }

  private clearEnts(keep = false): void {
    const g = this.game;
    for (const e of this.ents.values()) {
      if ('spec' in e) {
        // Out with a helper: theirs to keep if the mission is over with them at the wheel, else taken away.
        if (this.crew?.lent(e)) { this.crew.drop(e, keep); e.held = false; continue; }
        // Let go of (the mark is for a shared town: net/held.ts). The one she is sitting in is hers to keep, as an ordinary car.
        e.held = false;
        if (g.player.vehicle === e) continue;
        if (g.vehicles.list.includes(e)) { if (e.driver === 'ai') e.driver = null; g.vehicles.remove(e); }
      } else { g.people.remove(e); this.actorStep.delete(e); }
    }
    this.ents.clear();
    this.rail = null;
  }

  private tidy(): void {
    const h = this.game.hud;
    this.obj(0, 0, null); this.noTime(); h.subtitle(null);
    this.lines.length = 0; this.timer = 0; this.target = null;
  }

  private finish(): void {
    const g = this.game, m = this.cur as Mission;
    this.clearEnts(true); this.tidy();
    save.data.missions.push(m.id);
    save.data.stats.passed++; save.data.stats.earned += m.reward;
    g.player.money += m.reward;
    progress.add(m.points);
    this.cur = null;
    this.onBusy(null);
    g.hud.stamp('FILED', `${m.title} · ${money(m.reward)} · ${m.points} toward the bridge`);
    if (m.unlocks) g.hud.toast(m.unlocks, 8);
    this.crew?.ended(m, 'pass', -1);
  }

  fail(title: string, why: string): void {
    if (!this.cur || this.failed) return;
    const g = this.game;
    this.failed = title; this.failT = 0;
    this.tidy();
    this.rail = null;
    save.data.stats.failed++;
    // Death and arrest strike their own stamps; the rest get theirs here.
    if (title !== 'CLOCKED OUT' && title !== 'BOOKED') g.hud.stamp(title, why);
    else g.hud.toast(`${this.cur.title}: ${why}`, 6);
    this.crew?.ended(this.cur, 'fail', FAILS.findIndex((f) => f[0] === title && f[1] === why));
  }

  /** Give the mission up: everything it made is cleared away and the giver has it again. */
  abandon(): void {
    if (!this.cur) return;
    const m = this.cur, failed = this.failed;
    this.clearEnts(); this.tidy();
    this.cur = null; this.failed = null;
    this.onBusy(null);
    // (A failed one has told its helpers already.)
    if (!failed) this.crew?.ended(m, 'aside', -1);
  }

  /** Back to the last checkpoint with everything as it was there. */
  retry(): void {
    const g = this.game, m = this.cur, cp = this.cp;
    if (!m || !cp || !(g.player.health > 0)) return;
    const p = g.player;
    if (p.vehicle) p.exit();
    p.teleport(cp.x, cp.z, cp.h);
    this.clearEnts();
    for (let k = 0; k < cp.i; k++) {
      const s = m.steps[k];
      // (this.i is the step being made, for an actor's look and its number on the wire.)
      if (s.t === 'spawnVehicle' || s.t === 'spawnActor' || s.t === 'despawn') { this.i = k; this.instant(s); }
    }
    p.heat = 0;
    p.health = Math.max(p.health, 70);
    let v: Vehicle | null = cp.tag ? this.car(cp.tag) : null;
    if (!v && cp.kind) v = this.spawnCar(cp.kind, cp, cp.h);
    if (v) { v.x = cp.x; v.z = cp.z; v.h = cp.h; v.vx = v.vy = v.vz = 0; v.yawRate = 0; p.enter(v, true); }
    g.cam.snap();
    this.failed = null;
    this.i = cp.i; this.entered = false; this.stepT = 0;
    this.timer = cp.timer; this.timerLabel = cp.timerLabel; this.labelCode = cp.code;
    this.lines.length = 0;
    g.hud.toast('From the last checkpoint. The file has been amended.', 4);
    this.crew?.began(m);
  }

  private spawnCar(kind: VehicleKind, at: Pt, h: number, color?: number): Vehicle {
    const vs = this.game.vehicles;
    // Whatever the city parked on the spot makes way. (Not a car this browser is only shown in a shared town, and not
    // one a script is holding: see clearOf.)
    const own = (o: Vehicle): boolean => o.driver === null && o !== this.game.player.vehicle && !o.shared && !o.held;
    for (let c = vs.nearest(at.x, at.z, 5, own); c; c = vs.nearest(at.x, at.z, 5, own)) vs.remove(c);
    const p = clearOf(this.game, at, h);
    return vs.spawn(kind, p.x, p.z, h, color);
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.prompt = null;
    this.nMarks = 0;
    this.run(dt);
    this.closeView();
  }

  private run(dt: number): void {
    if (!this.cur && this.guest) { this.helping(); return; }
    if (!this.cur) { this.idle(); return; }
    const g = this.game, p = g.player;
    if (this.failed) {
      this.target = null;
      if (!(p.health > 0)) return;
      this.failT += dt;
      this.prompt = '[G] Try again from the last checkpoint';
      g.hud.objective(`${this.cur.title}: ${this.failed.toLowerCase()}. Try again, or walk away.`);
      if (g.input.eat('interact')) { this.retry(); return; }
      if (this.failT > 25) { this.abandon(); g.hud.toast('Mission set aside. Whoever gave it to you will still be standing there.', 5); }
      return;
    }
    if (!(p.health > 0)) { this.fail('CLOCKED OUT', 'You did not live to invoice for it.'); return; }

    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) { this.fail('PAST DUE', 'The clock ran out. It always had more time than you.'); return; }
      this.time(this.labelCode, 1, Math.round(this.timer * 10), this.timer < 15, this.timerLabel, clock(this.timer));
    }
    this.tickRail(dt);
    this.tickLines(dt);

    for (let guard = 0; guard < 40 && this.cur && !this.failed; guard++) {
      const s = this.step();
      if (!s) { this.finish(); return; }
      if (!HOLDING.has(s.t)) {
        if (s.t === 'say' && !s.bg) {
          if (!this.entered) { this.entered = true; this.lines.push({ who: s.who, text: s.text, left: -1 }); }
          // Held until every line queued so far has been read.
          if (this.lines.length) { if (g.input.eat('interact')) this.lines[0].left = 0; return; }
        } else this.instant(s);
        this.advance();
        continue;
      }
      if (!this.entered) { this.entered = true; this.stepT = 0; this.enter(s); }
      this.stepT += dt;
      if (!this.hold(s, dt)) return;
      this.leave(s);
      this.advance();
    }
  }

  private advance(): void { this.i++; this.entered = false; }

  /** On another player's mission: their objective, timer and markers, as their browser says (net/crew.ts). */
  private helping(): void {
    const gu = this.guest as Guest, h = this.game.hud;
    this.target = null;
    const text = gu.objective ?? gu.line;
    if (text !== this.lastObj) { this.lastObj = text; h.objective(text); }
    if (gu.timerMode === 0 || gu.timerLabel === null) h.timer(null);
    else if (gu.timerMode === 3) h.timer(gu.timerLabel, `${gu.timerValue} m`, gu.timerUrgent);
    else {
      const left = this.guestLeft();
      h.timer(gu.timerLabel, clock(left), gu.timerUrgent || (gu.timerMode === 1 && left < 15));
    }
    for (const k of gu.marks) {
      if (k.kind !== 2) this.markers.put(k.x, k.z, k.kind === 0 ? 'goal' : 'item', k.r, k.tall);
      if (k.target) this.target = { x: k.x, z: k.z };
    }
  }

  /** A helper's countdown as shown now: the value told, run down at the starter's rate since. */
  guestLeft(): number {
    const gu = this.guest;
    if (!gu) return 0;
    return gu.timerMode === 1 ? gu.timerValue - ((performance.now() - gu.timerAt) / 1000) * gu.timerRate : gu.timerValue;
  }

  /** The helper is let go of: the strip and the timer are cleared. */
  unguest(): void {
    if (!this.guest) return;
    this.guest = null; this.lastObj = '';
    this.target = null;
    this.game.hud.objective(null); this.game.hud.timer(null);
  }

  private idle(): void {
    const g = this.game, p = g.player;
    this.target = null;
    if (!this.isFree()) return;
    for (const o of this.offers()) {
      const gv = this.givers[o.giver], d = Math.hypot(p.x - gv.at.x, p.z - gv.at.z);
      if (d < 320) this.markers.put(gv.at.x, gv.at.z, 'giver', 1.3, 16, 2.5);
      if (d > (p.vehicle ? 7 : 3.6) || p.speed > 3) continue;
      this.prompt = `[G] ${gv.short}: "${o.m.title}"`;
      if (g.input.eat('interact')) this.start(o.m);
      return;
    }
  }

  private tickLines(dt: number): void {
    const l = this.lines[0];
    if (!l) return;
    if (l.left < 0) { l.left = 2 + l.text.length * 0.05; this.game.hud.subtitle(l.who, l.text, l.left + 0.3); }
    if ((l.left -= dt) <= 0) { this.lines.shift(); if (!this.lines.length) this.game.hud.subtitle(null); }
  }

  private tickRail(dt: number): void {
    const r = this.rail;
    if (!r || r.done) return;
    const v = r.v;
    if (this.gone(v)) { r.done = true; return; }
    let left = r.speed * dt;
    while (left > 0 && r.seg < r.pts.length - 1) {
      const a = r.pts[r.seg], b = r.pts[r.seg + 1], len = dist(a, b);
      if (r.s + left < len) { r.s += left; left = 0; } else { left -= len - r.s; r.seg++; r.s = 0; }
    }
    if (r.seg >= r.pts.length - 1) { r.done = true; v.vx = v.vz = 0; v.driver = null; return; }
    const at = this.along(r, 0), ahead = this.along(r, 5);
    const want = Math.atan2(ahead.x - at.x, ahead.z - at.z);
    let dh = want - v.h;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    v.h += Math.max(-2.2 * dt, Math.min(2.2 * dt, dh));
    v.x = at.x; v.z = at.z; v.y = Math.max(groundAt(at.x, at.z), 0);
    v.vx = Math.sin(v.h) * r.speed; v.vz = Math.cos(v.h) * r.speed; v.vy = 0; v.yawRate = 0;
    v.pitch = 0; v.roll = 0;
    v.driver = 'ai';
    v.ctl.accel = 0.3; v.ctl.steer = 0; v.ctl.handbrake = false;
  }

  private along(r: Rail, extra: number): Pt {
    let seg = r.seg, s = r.s + extra;
    while (seg < r.pts.length - 2 && s > dist(r.pts[seg], r.pts[seg + 1])) { s -= dist(r.pts[seg], r.pts[seg + 1]); seg++; }
    const a = r.pts[seg], b = r.pts[seg + 1], len = dist(a, b) || 1, k = Math.min(1, s / len);
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private instant(s: Step): void {
    const g = this.game;
    switch (s.t) {
      case 'say': this.lines.push({ who: s.who, text: s.text, left: -1 }); break;
      case 'spawnVehicle': {
        const v = this.spawnCar(s.kind, s.at, s.h, s.color);
        // The script's own until it lets go: in a shared town it stays this player's (net/held.ts).
        v.held = true;
        this.ents.set(s.tag, v);
        break;
      }
      case 'spawnActor': {
        // In a shared town the rest of the look comes from the mission and the step, so a helper's browser makes the
        // same person (crew.ts, actorLook). Alone it is random, as it always was.
        const look = this.crew?.shared() && this.cur ? actorLook(g, this.missions.indexOf(this.cur), this.i, s) : { ...g.people.randomLook(), ...s.look };
        const p = g.people.spawn(s.at.x, s.at.z, s.h, look);
        p.pose = 'stand';
        this.ents.set(s.tag, p);
        this.actorStep.set(p, this.i);
        break;
      }
      case 'despawn': {
        const e = this.ents.get(s.tag);
        if (!e) break;
        if ('spec' in e && this.crew?.lent(e)) { this.crew.drop(e, false); e.held = false; }
        else if ('spec' in e) { e.held = false; if (g.player.vehicle !== e && g.vehicles.list.includes(e)) { e.driver = null; g.vehicles.remove(e); } } else { g.people.remove(e); this.actorStep.delete(e); }
        if (this.rail && this.rail.v === e) this.rail = null;
        this.ents.delete(s.tag);
        break;
      }
      case 'money': g.player.money += s.amount; if (s.note) g.hud.toast(s.note, 5); break;
      case 'heat': g.player.heat = s.level; break;
      case 'give': g.player.weapons.give(s.weapon, s.ammo); break;
      case 'timer': this.timer = s.secs; this.timerLabel = s.label ?? 'Past due in'; this.labelCode = s.label ? Math.min(this.i, 239) : 249; if (s.secs <= 0) this.noTime(); break;
      case 'checkpoint': this.cp = this.snap(this.i + 1); break;
      default: break;
    }
  }

  private enter(s: Step): void {
    const g = this.game;
    if ('text' in s && s.t !== 'say') this.obj(1, this.i, s.text);
    switch (s.t) {
      case 'collect': this.left = s.items.slice(); this.count = s.items.length; break;
      case 'race': this.cpI = 0; this.timer = s.par; this.timerLabel = 'Par'; this.labelCode = 254; break;
      case 'survive': this.count = s.secs; break;
      case 'tail': {
        const v = this.car(s.tag);
        this.nearT = this.farT = 0;
        if (!v) break;
        // A route given as a function is worked out now, not at start-up: streets open and close with the town.
        const pts = typeof s.route === 'function' ? s.route() : s.route;
        const a = pts[0], b = pts[1] ?? a;
        v.x = a.x; v.z = a.z; v.h = Math.atan2(b.x - a.x, b.z - a.z);
        this.rail = { v, pts, seg: 0, s: 0, speed: s.speed ?? 11, done: false };
        break;
      }
      default: break;
    }
  }

  private leave(s: Step): void {
    if (s.t === 'race') { this.timer = 0; this.noTime(); }
    if (s.t === 'survive' || s.t === 'tail') this.noTime();
    this.target = null;
  }

  /**
   * Is anybody of the crew (this player, or a helper where this browser shows them) within r of `at`, travelling as
   * `mode`/`kind` asks, and (with `stop`) at rest? Alone only this player is asked, as before.
   */
  private anyAt(at: Pt, r: number, mode: Mode | undefined, kind: VehicleKind | undefined, stop: boolean, carSlack = 0): boolean {
    const p = this.game.player;
    if (this.seated(mode, kind) && Math.hypot(p.x - at.x, p.z - at.z) < r + (p.vehicle ? carSlack : 0) && (!stop || Math.abs(p.speed) < 2.5)) return true;
    const crew = this.crew;
    if (!crew) return false;
    for (const c of crew.members()) {
      if (!memberSeated(c, mode, kind)) continue;
      if (Math.hypot(c.x - at.x, c.z - at.z) < r + (c.kind ? carSlack : 0) && (!stop || Math.abs(c.speed) < 2.5)) return true;
    }
    return false;
  }

  /** The player is at the wheel of what the step wants (or the step wants nothing in particular). */
  private seated(mode: Mode | undefined, kind?: VehicleKind, tag?: string): boolean {
    const v = this.game.player.vehicle;
    if (tag) { const c = this.car(tag); return !!c && (v === c || !!this.crew?.lent(c)); }
    if (kind) return !!v && v.spec.kind === kind;
    if (mode === 'foot') return !v;
    if (mode === 'car') return !!v;
    return true;
  }

  /** True when the step is done. */
  private hold(s: Step, dt: number): boolean {
    const g = this.game, p = g.player;
    switch (s.t) {
      case 'wait': return this.stepT >= s.secs;
      case 'goto': case 'deliver': {
        const tag = s.tag, v = tag ? this.car(tag) : null;
        if (tag && (!v || this.gone(v))) { this.fail('WRITTEN OFF', 'That vehicle was the whole job.'); return false; }
        const r = s.r ?? 7;
        if (v && !this.driving(v)) {
          // Out of the one she needs: the business is getting back into it.
          this.target = { x: v.x, z: v.z };
          this.mark(v.x, v.z, 'goal', 3, 16);
          this.obj(2, KINDS.indexOf(v.spec.kind), `Get back in the ${v.spec.name}.`);
          return false;
        }
        this.obj(1, this.i, s.text);
        this.target = s.at;
        this.mark(s.at.x, s.at.z, 'goal', r, 34);
        const mode = s.t === 'goto' ? s.mode : undefined, kind = s.t === 'goto' ? s.kind : undefined;
        const stop = s.t === 'deliver' || !!s.stop;
        // (No particular car: any of the crew getting there will do.)
        if (!tag) return this.anyAt(s.at, r, mode, kind, stop);
        if (!this.seated(mode, kind, tag)) return false;
        // (A car out with a helper is where it is and goes as fast as it goes: this player may be anywhere.)
        const who = v && p.vehicle !== v ? v : p;
        return Math.hypot(who.x - s.at.x, who.z - s.at.z) < r && (!stop || Math.abs(who.speed) < 2.5);
      }
      case 'getVehicle': {
        let v: Vehicle | null = s.tag ? this.car(s.tag) : null;
        if (s.tag && (!v || this.gone(v))) { this.fail('WRITTEN OFF', 'That vehicle was the whole job.'); return false; }
        if (!v && s.kind) { const k = s.kind; v = g.vehicles.nearest(p.x, p.z, 900, (c) => c.spec.kind === k && !c.wreck && c.driver !== 'ai'); }
        if (s.tag || s.kind ? this.seated(undefined, s.kind, s.tag) : !!p.vehicle) return true;
        // A kind, or anything: a helper at the wheel of one will do. (A tagged car a helper drives is lent: seated says so.)
        if (!s.tag && this.crew) for (const c of this.crew.members()) if (c.kind && (!s.kind || c.kind === s.kind)) return true;
        if (v) { this.target = { x: v.x, z: v.z }; this.mark(v.x, v.z, 'goal', 3, 18); }
        return false;
      }
      case 'collect': {
        const r = s.r ?? 3;
        for (let k = this.left.length - 1; k >= 0; k--) {
          const it = this.left[k];
          if (this.anyAt(it, r, s.mode, undefined, false, 1.5)) {
            this.left.splice(k, 1);
            g.hud.toast(`${this.count - this.left.length} of ${this.count}.`, 2.5);
          } else this.mark(it.x, it.z, 'item', 1.6, 12, true);
        }
        let best: Pt | null = null, bd = Infinity;
        for (const it of this.left) { const d = Math.hypot(p.x - it.x, p.z - it.z); if (d < bd) { bd = d; best = it; } }
        this.target = best;
        return this.left.length === 0;
      }
      case 'destroy': {
        let alive = 0;
        for (const tag of s.tags) { const v = this.car(tag); if (v && !this.gone(v)) { alive++; this.mark(v.x, v.z, 'goal', 3.5, 20, true); if (alive === 1) this.target = { x: v.x, z: v.z }; } }
        return alive === 0;
      }
      case 'loseHeat': return p.heat <= 0 && this.stepT > 0.5;
      case 'tail': {
        const v = this.car(s.tag), r = this.rail;
        if (!v || this.gone(v)) { this.fail('THE TRAIL WENT COLD', 'There is nothing left of them to follow.'); return false; }
        if (!r || r.done) return true;
        const d = Math.hypot(p.x - v.x, p.z - v.z), near = s.near ?? 14, far = s.far ?? 110;
        this.target = { x: v.x, z: v.z };
        this.nearT = d < near ? this.nearT + dt : Math.max(0, this.nearT - dt * 0.5);
        this.farT = d > far ? this.farT + dt : 0;
        this.time(d < near ? 252 : d > far ? 251 : 250, 3, Math.round(d), d < near || d > far, d < near ? 'Too close' : d > far ? 'Losing them' : 'Following at', `${Math.round(d)} m`);
        if (this.nearT > 2.5) { this.fail('MADE', 'They looked in the mirror and you were all of it.'); return false; }
        if (this.farT > 7) { this.fail('THE TRAIL WENT COLD', 'They went one way. You went into speculation.'); return false; }
        return false;
      }
      case 'race': {
        const r = s.r ?? 10, c = s.cps[this.cpI];
        this.target = c;
        this.mark(c.x, c.z, 'goal', r, 40);
        const n = s.cps[this.cpI + 1];
        if (n) this.mark(n.x, n.z, 'item', r * 0.6, 14);
        if (this.anyAt(c, r, s.mode, undefined, false)) {
          this.cpI++;
          if (this.cpI < s.cps.length) g.hud.toast(`Checkpoint ${this.cpI} of ${s.cps.length}.`, 2);
        }
        return this.cpI >= s.cps.length;
      }
      case 'survive': {
        const inside = !s.at || this.anyAt(s.at, s.r ?? 40, undefined, undefined, false);
        if (s.at) { this.mark(s.at.x, s.at.z, 'goal', s.r ?? 40, 10); this.target = inside ? null : s.at; }
        if (inside) this.count -= dt;
        if (inside) this.obj(1, this.i, s.text); else this.obj(3, 0, 'Get back inside the ring. The clock is not running out here.');
        this.time(253, inside ? 1 : 2, Math.round(this.count * 10), false, 'Hold out', clock(this.count));
        return this.count <= 0;
      }
      default: return true;
    }
  }

  /** For the tests' scripted player: what is being asked for. */
  want(): Want | null {
    const m = this.cur, s = this.step();
    if (!m) return null;
    const w: Want = { id: m.id, i: this.i, t: s ? s.t : 'end', at: this.target, r: 7, mode: 'any', tag: null, kind: null, stop: false, tags: [], items: [], failed: this.failed };
    if (!s) return w;
    if (s.t === 'goto') { w.at = s.at; w.r = s.r ?? 7; w.mode = s.mode ?? 'any'; w.tag = s.tag ?? null; w.kind = s.kind ?? null; w.stop = !!s.stop; }
    if (s.t === 'deliver') { w.at = s.at; w.r = s.r ?? 7; w.tag = s.tag; w.stop = true; }
    if (s.t === 'getVehicle') { w.tag = s.tag ?? null; w.kind = s.kind ?? null; }
    if (s.t === 'collect') { w.items = this.left.slice(); w.r = s.r ?? 3; w.mode = s.mode ?? 'any'; }
    if (s.t === 'destroy') w.tags = s.tags.filter((t) => { const v = this.car(t); return !!v && !this.gone(v); });
    if (s.t === 'race') { w.at = s.cps[this.cpI] ?? null; w.r = s.r ?? 10; w.mode = s.mode ?? 'any'; }
    if (s.t === 'tail') { w.tag = s.tag; }
    if (s.t === 'survive') { w.at = s.at ?? null; w.r = s.r ?? 40; }
    return w;
  }
}
