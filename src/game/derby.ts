// Fun queue item 13: the demolition derby at Flounder Field. Last car running wins.
//
// The bowl is the old pitch, dug up into dirt with concrete barriers and tyre walls round it (world/places.ts, DERBY).
// At the gate on the west side, by the lot, a player presses G:
//  - alone in town (or offline): the derby starts at once against AI drivers;
//  - with others in town: a CALL. Everybody else gets a toast and a D on the radar for JOIN_S seconds; whoever drives
//    up to the gate joins. G again starts at once, or the window runs out.
// AI drivers fill the field up to eight cars in battered old sedans and pickups; everybody gets a derby car with a
// number painted on its doors and roof, on a grid round the bowl facing the middle. Three, two, one, then: the AI aims
// at the nearest car still running, rams it, and reverses out when stuck. A car is OUT when its health is gone or it
// has not moved for STILL_S seconds; an out car smokes and stays where it died, an obstacle. Last car running wins
// (or, when the clock runs out, the healthiest one still going).
// The damage is the street's (ent/carDamage.ts zones: dents, glass, lamps, bumpers off into the dirt) and then some:
// every hit in the bowl dents again and costs more. Nobody is hurt and nothing burns: a derby car's health is held
// above the fire line (weapons.ts BURN_AT), and "out" is where it smokes hardest.
// Who decides what: each browser drives, damages and judges its own car (Stat frames: health, out, hits); the
// caller's browser also drives the AI cars (Cars and Dents frames: everybody else draws them as ghosts) and calls the
// end (End: the order). Hits: a ram counts for whoever was driving into the other, judged by the browser that owns the
// rammer. Podium, cash and town records (most derby wins, most hits in one derby; net/derby.ts writes them, host only).
// Kid-friendly mode: cars only, nothing changes.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import type { VehicleKind } from '../ent/vehicleSpecs';
import { CarDamage, damageOf, dent, pack, unpack, DAMAGE_BYTES } from '../ent/carDamage';
import { DERBY } from '../world/places';
import { groundAt } from '../world/plan';
import { RNG, TAU } from '../core/util';
import { save } from './save';
import { taper } from './activities';
import type { Markers, Pt } from './script';

export const JOIN_S = 30;
export const ROUND_S = 240;
export const STILL_S = 20;
const COUNT_S = 4;
const CARS = 8;
const AI_BASE = 200;
const AT_M = 14, JOIN_M = 30;
/** vehicle.health is held at or above this (weapons.ts burns cars under 20); at it, the car is out. */
const FLOOR = 21;
/** Extra damage in the bowl, per m/s of closing speed over 3, on top of the street's. */
const EXTRA = 1.7;
const WIN_CASH = 800, SECOND_CASH = 400, THIRD_CASH = 200, HIT_CASH = 25;
const GRACE_MS = 2500;
const CAR_BYTES = 10;

export interface DerbyWire { kind: number; caller: number; a: number; b: number; c: number; ms: number; bytes: number[] }
export interface DerbyRecord { wins: number; winsBy: string; hits: number; hitsBy: string }
export interface DerbyLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): Pt | null;
  vehicleOf(id: number): Vehicle | null;
  send(m: DerbyWire): void;
  record(): DerbyRecord | null;
}
export const DK = { Call: 1, Join: 2, Go: 3, Cars: 4, Dents: 5, Stat: 6, End: 7, Done: 8, Off: 9 } as const;

type Phase = 'idle' | 'calling' | 'joined' | 'bets' | 'count' | 'fight' | 'done' | 'podium';
interface Ent {
  id: number; num: number; name: string; ai: boolean;
  car: Vehicle | null; kind: VehicleKind; color: number;
  hp: number; out: boolean; outAt: number; hits: number; left: boolean;
  /** Stillness: where it was at the last sample, and for how long it has hardly moved (s). */
  sx: number; sz: number; still: number; sampleAt: number;
  /** AI: reversing until, stuck time, last hit at. */
  rev: number; stuck: number; revSteer: number; target: number; pick: number; close: number;
  /** Ghost (somebody else's AI): where the caller last said it is. */
  tx: number; tz: number; th: number; ts: number; tSteer: number; seen: number;
  plates: THREE.Group | null;
}
interface Invite { caller: number; until: number }
interface Row { id: number; num: number; name: string; place: number; hits: number; how: string; cash: number; me: boolean }

const AI_NAMES = ['Dale Thibodeau', 'Big Lorraine', 'Reverend Skip', 'Nana Pelletier', 'Gary from Accounts', 'The Unlicensed Kevin',
  'Moose Ouellette', 'Two-Coat Marcotte', 'Deb (no relation)', 'Vic the Insurable'];
const AI_COLORS = [0x6b7a3a, 0x8a3b2e, 0x3d4f6b, 0xb08a3e, 0x5a5a58, 0x7a5a8a, 0x2f5d4f, 0x9a6b4a, 0xc9c0a8, 0x4a2f2a];
const PA = {
  open: ['Welcome to the Flounder Field demolition derby. The insurance company has asked us not to say "demolition". Derby.',
    'Good evening. Tonight\'s derby is sponsored by nobody, after last time.'],
  go: ['Drivers, find someone you dislike.', 'Engines up. Manners down.'],
  hit: ['That is going to show up on a Carfax.', 'Number {n} has made a strong case for public transport.',
    'A reminder that the snack bar accepts cash and grief.', 'That one was felt in the cheap seats. All seats are the cheap seats.',
    'Number {n} would like everyone to know that was on purpose.', 'Somewhere, a mechanic just bought a boat.'],
  bumper: ['Number {n}\'s bumper has left the car to pursue other interests.', 'Bumper on the field. Please do not take it home. Again.'],
  out: ['Number {n} is out. Number {n} is now a planter.', 'Number {n} has stopped. We are told that is permanent.',
    'Number {n} is retiring from motoring, effective now.'],
  still: ['Number {n} is parked. This is not a parking lot. The parking lot is the parking lot.'],
  win: ['Number {n} wins. The car is a total loss, which is the point.', 'Your winner, number {n}. Drive home carefully. You cannot.'],
};
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
/** The AI drivers' names for a seed: the first draws of the seed's generator, the same on every screen. */
const shuffled = (rng: RNG): string[] => {
  const names = AI_NAMES.slice();
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  return names;
};
/** Who is in a derby by its Go frame: the players in grid order, then the AI (id AI_BASE + k), numbered from 1. Names are the AI's (betting.ts). */
export function derbyField(ids: number[], ai: number, seed: number): { id: number; num: number; name: string }[] {
  const names = shuffled(new RNG(seed * 7919));
  return [...ids, ...Array.from({ length: ai }, (_, k) => AI_BASE + k)].map((id, k) => ({ id, num: k + 1, name: id >= AI_BASE ? names[(id - AI_BASE) % names.length] : '' }));
}
/** Seconds of a derby of eight locals (no player in it). */
const WATCH_ROUND_S = 150;
const clock = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const clamp = (v: number, a: number, b: number): number => v < a ? a : v > b ? b : v;
const wrap = (a: number): number => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

interface VehiclesX {
  ghost(kind: VehicleKind, color: number): Vehicle;
  unghost(v: Vehicle): void;
  ghostPose(v: Vehicle, x: number, y: number, z: number, h: number, pitch: number, roll: number, steer: number, speed: number, braking: boolean, reversing: boolean, dt: number): void;
  showDamage(v: Vehicle, dropped: number): void;
  wake(v: Vehicle): void;
}

export class Derby {
  link: DerbyLink | null = null;
  prompt: string | null = null;
  phase: Phase = 'idle';
  /** For the tests: a shorter round (s) and join window (s), the caller's only (sent in the Go frame). */
  testRound = 0; testJoin = 0;
  readonly stats = { called: 0, joined: 0, rounds: 0, hits: 0, outs: 0, podiums: 0, bumpers: 0, wall: 0, sent: 0, got: 0 };

  private caller = 0;
  private readonly ents = new Map<number, Ent>();
  private readonly invites = new Map<number, Invite>();
  private until = 0;
  private goAt = 0; private endAt = 0; private doneAt = 0; private roundS = ROUND_S;
  private podiumUntil = 0;
  private seed = 1;
  private statSent = { hp: -1, out: false, hits: -1, at: 0 };
  private carsAt = 0; private dentsAt = 0;
  private lastRows: Row[] = [];
  private lastNotes: string[] = [];
  private recBefore: DerbyRecord | null = null;
  private outOrder: number[] = [];
  private paAt = 0;
  private cheer = 0;
  private told = new Set<string>();
  /** A derby of eight locals with the player on the sidelines, to bet on (betting.ts): no frames are sent, nothing is paid but the bets. */
  private watching = false;
  private watchSeed = 0;
  /** Game time, ms: the round runs on the simulation's clock (stepped tests, a paused game). */
  private clk = 0;

  private readonly ui = new DerbyUi();
  private crowd: Crowd | null = null;
  private plateMats: THREE.MeshStandardMaterial[] | null = null;
  private plateGeo: THREE.PlaneGeometry | null = null;

  constructor(private readonly game: Game, private readonly markers: Markers,
    private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    game.on('impact', (e) => this.onImpact(e.vehicle, e.speed, e.other, e.x, e.z));
  }

  private get me(): number { return this.link ? this.link.me() : 0; }
  private nameOf(id: number): string { return id >= AI_BASE ? this.ents.get(id)?.name ?? 'AI' : this.link ? this.link.nameOf(id) : 'You'; }
  private get amCaller(): boolean { return this.caller === this.me; }
  /** Derby Night (game/events.ts, Fridays evening): the night's title, a double purse, fireworks after. */
  private get night(): boolean { return !this.watching && (this.game.todo.events?.derbyNight ?? false); }
  private get inRound(): boolean { return this.phase === 'count' || this.phase === 'fight' || this.phase === 'done'; }
  private get vx(): VehiclesX { return this.game.vehicles as unknown as VehiclesX; }
  private send(m: Partial<DerbyWire> & { kind: number }): void {
    if (!this.link || this.watching) return;
    this.link.send({ caller: this.caller, a: 0, b: 0, c: 0, ms: 0, bytes: [], ...m });
    this.stats.sent++;
  }

  // ── Starting ───────────────────────────────────────────────────────────────

  private offer(): void {
    const g = this.game, p = g.player, now = this.clk;
    for (const [id, inv] of this.invites) {
      if (now > inv.until) { this.invites.delete(id); continue; }
      this.markers.put(DERBY.gateX, DERBY.gateZ, 'goal', 9, 60);
      if (p.vehicle && Math.hypot(p.x - DERBY.gateX, p.z - DERBY.gateZ) < JOIN_M && this.isFree()) { this.join(inv); return; }
    }
    const d = Math.hypot(p.x - DERBY.gateX, p.z - DERBY.gateZ);
    if (d > 300) return;
    this.markers.put(DERBY.gateX, DERBY.gateZ, 'job', 7, 22);
    if (!(d < AT_M && Math.abs(p.speed) < 4 && this.isFree() && p.health > 0)) return;
    const many = this.link ? this.link.others().length : 0, rec = this.link?.record();
    const recT = rec ? ` · records: ${rec.wins} win${rec.wins === 1 ? '' : 's'} by ${rec.winsBy}, ${rec.hits} hits by ${rec.hitsBy}` : '';
    this.prompt = (many ? `[G] Call a demolition derby: ${many} other${many > 1 ? 's' : ''} in town get ${JOIN_S} s to drive in${recT}`
      : `[G] Demolition derby: you and ${CARS - 1} locals. Last car running wins${recT}`) + ' · [Z] Bet on a derby of eight locals';
    if (!g.input.eat('interact')) return;
    this.call(many);
  }

  /** At the gate, free, on the ground: Z may put on a derby to watch and bet on (betting.ts). */
  watchOffer(): boolean {
    const p = this.game.player;
    return this.phase === 'idle' && this.isFree() && p.health > 0 && Math.hypot(p.x - DERBY.gateX, p.z - DERBY.gateZ) < AT_M + 6 && Math.abs(p.speed) < 4;
  }

  /** Eight locals and nobody of ours: a 25 s window to bet in (betting.ts), then the same derby, run by this browser alone. */
  watch(): void {
    if (!this.watchOffer()) return;
    this.caller = this.me;
    this.ents.clear(); this.invites.clear();
    this.watching = true;
    this.watchSeed = 1 + Math.floor(Math.random() * 250);
    this.phase = 'bets';
    this.until = this.clk + this.game.todo.betting.localSecs() * 1000;
    this.setBusy('derby');
    this.stats.called++;
    this.game.todo.betting.openLocalDerby(this.watchSeed, CARS);
    this.game.hud.stamp('DERBY OF LOCALS', 'Eight local drivers, nobody of ours. Back a driver on the slip (Z); play money only. It starts when the clock runs out.');
  }

  call(many = 0): void {
    this.caller = this.me;
    this.ents.clear(); this.invites.clear();
    this.addEnt(this.me);
    this.setBusy('derby');
    this.stats.called++;
    if (!many) { this.go(); return; }
    this.phase = 'calling';
    this.until = this.clk + (this.testJoin || JOIN_S) * 1000;
    this.sendCall();
    this.game.hud.stamp(this.night ? 'DERBY NIGHT' : 'DEMOLITION DERBY', `Flounder Field · everybody in town has ${JOIN_S} s to drive to the gate · G to start now`);
  }

  private sendCall(): void {
    if (this.phase !== 'calling') return;
    this.send({ kind: DK.Call, a: Math.max(1, (this.until - this.clk) / 1000), bytes: [...this.ents.keys()] });
  }

  private join(inv: Invite): void {
    this.invites.clear();
    this.caller = inv.caller;
    this.ents.clear();
    this.until = inv.until;
    this.phase = 'joined';
    this.setBusy('derby');
    this.stats.joined++;
    this.send({ kind: DK.Join, a: 1 });
    this.game.hud.stamp('YOU ARE IN', `${this.nameOf(inv.caller)}'s demolition derby · wait at the gate for the start`);
  }

  private addEnt(id: number, num = 0): Ent {
    let x = this.ents.get(id);
    if (!x) {
      this.ents.set(id, x = {
        id, num, name: '', ai: id >= AI_BASE, car: null, kind: 'sedan', color: 0x777777, hp: 100, out: false, outAt: 0, hits: 0, left: false,
        sx: 0, sz: 0, still: 0, sampleAt: 0, rev: 0, stuck: 0, revSteer: 0, target: -1, pick: 0, close: 0, tx: 0, tz: 0, th: 0, ts: 0, tSteer: 0, seen: 0, plates: null,
      });
      if (!x.ai) x.name = this.nameOf(id);
    }
    return x;
  }

  /** The caller: everybody in, the AI to fill up the field. */
  private go(): void {
    const ids = [...this.ents.keys()].slice(0, CARS);
    const ai = CARS - ids.length, seed = 1 + Math.floor(Math.random() * 250), round = this.testRound || ROUND_S;
    this.send({ kind: DK.Go, a: ai, b: seed, c: round, bytes: ids });
    this.start(ids, ai, seed, round);
  }

  /** The grid: slot k of eight round the bowl, facing the middle. */
  private slot(k: number): { x: number; z: number; h: number } {
    const t = (k / CARS) * TAU + 0.2, x = DERBY.x + Math.cos(t) * DERBY.a * 0.72, z = DERBY.z + Math.sin(t) * DERBY.b * 0.72;
    return { x, z, h: Math.atan2(DERBY.x - x, DERBY.z - z) };
  }

  private start(ids: number[], ai: number, seed: number, round: number): void {
    const g = this.game, now = this.clk, rng = new RNG(seed * 7919);
    this.clearCars();
    this.ents.clear();
    this.seed = seed; this.roundS = round; this.outOrder = []; this.told.clear();
    const names = shuffled(rng);
    const all = [...ids, ...Array.from({ length: ai }, (_, k) => AI_BASE + k)];
    all.forEach((id, k) => {
      const e = this.addEnt(id, k + 1);
      e.kind = e.ai ? (rng.next() < 0.45 ? 'pickup' : 'sedan') : 'sedan';
      e.color = AI_COLORS[Math.floor(rng.next() * AI_COLORS.length)];
      if (e.ai) e.name = names[(id - AI_BASE) % names.length];
      const s = this.slot(k);
      e.sx = e.tx = s.x; e.sz = e.tz = s.z; e.th = s.h;
      if (id === this.me) {
        const p = g.player;
        if (p.vehicle) p.exit(true);
        const v = g.vehicles.spawn(e.kind, s.x, s.z, s.h, e.color);
        v.held = true;
        this.batter(v, rng, 0.08);
        e.car = v;
        p.enter(v, true);
        g.cam.snap();
      } else if (e.ai && this.amCaller) {
        const v = g.vehicles.spawn(e.kind, s.x, s.z, s.h, e.color);
        v.held = true; v.driver = 'ai';
        this.batter(v, rng, 0.25);
        e.car = v;
      } else if (e.ai) {
        const v = this.vx.ghost(e.kind, e.color);
        this.vx.ghostPose(v, s.x, groundAt(s.x, s.z), s.z, s.h, 0, 0, 0, 0, false, false, 0);
        e.car = v;
      }
    });
    this.goAt = now + COUNT_S * 1000; this.endAt = this.goAt + round * 1000; this.doneAt = 0;
    this.phase = 'count';
    this.stats.rounds++;
    this.recBefore = this.link?.record() ?? null;
    this.statSent = { hp: -1, out: false, hits: -1, at: 0 };
    const mine = this.ents.get(this.me);
    if (this.watching) g.hud.stamp('THE LOCALS', `${all.length} cars · last one running wins · bets are closed`);
    else g.hud.stamp(this.night ? `DERBY NIGHT · CAR #${mine?.num ?? '?'}` : `CAR #${mine?.num ?? '?'}`, `${all.length} cars · last one running wins · a car that sits still for ${STILL_S} s is out${this.night ? ' · double purse tonight' : ''}`);
    this.pa(pick(PA.open), true);
  }

  /** An old car: a few dents it came with. */
  private batter(v: Vehicle, rng: RNG, k: number): void {
    const c = v as unknown as { dmg: CarDamage | null };
    if (!('dmg' in c)) return;
    const d = c.dmg ?? (c.dmg = new CarDamage());
    for (let i = 0; i < 3; i++) { const a = rng.next() * TAU; dent(d, Math.sin(a) * v.hw, Math.cos(a) * v.hl, v.hl, v.hw, 6 + rng.next() * 30 * k, () => rng.next()); }
    d.scrL = rng.next() * 0.6; d.scrR = rng.next() * 0.6;
    v.health = 100;
  }

  // ── The network's ──────────────────────────────────────────────────────────

  got(from: number, m: DerbyWire): void {
    this.stats.got++;
    const now = this.clk;
    this.bets(from, m);
    if (m.kind === DK.Call) {
      if (from !== m.caller) return;
      if (this.phase === 'joined' && this.caller === m.caller) { this.until = now + m.a * 1000; return; }
      if (this.phase !== 'idle') return;
      const old = this.invites.get(m.caller);
      this.invites.set(m.caller, { caller: m.caller, until: now + m.a * 1000 });
      if (!old) this.game.hud.toast(`${this.nameOf(m.caller)} called a demolition derby at Flounder Field. Drive to the D on the radar within ${Math.round(m.a)} s to join.`, 8);
      return;
    }
    if (m.kind === DK.Off) {
      this.invites.delete(m.caller);
      if ((this.phase === 'joined' || this.inRound) && this.caller === m.caller && from === m.caller) { this.end(); this.game.hud.toast(`${this.nameOf(m.caller)} called the derby off.`, 5); }
      return;
    }
    if (m.kind === DK.Join) {
      if (this.phase !== 'calling' || m.caller !== this.me) return;
      if (m.a && this.ents.size < CARS) { this.addEnt(from); this.game.hud.toast(`${this.nameOf(from)} is in.`, 3); }
      else if (!m.a) this.ents.delete(from);
      this.sendCall();
      return;
    }
    if (m.kind === DK.Go) {
      if (this.phase !== 'joined' || m.caller !== this.caller || from !== this.caller) return;
      if (!m.bytes.includes(this.me)) { this.end(); this.game.hud.toast('The derby filled up before you got there.', 5); return; }
      this.start(m.bytes, m.a, m.b, m.c);
      return;
    }
    if (m.caller !== this.caller || !(this.inRound || this.phase === 'podium')) return;
    if (m.kind === DK.Cars && from === this.caller) {
      for (let o = 0; o + CAR_BYTES <= m.bytes.length; o += CAR_BYTES) {
        const b = m.bytes, e = this.ents.get(AI_BASE + b[o]);
        if (!e || !e.car) continue;
        const i16 = (k: number): number => { const v = b[o + k] | (b[o + k + 1] << 8); return v > 32767 ? v - 65536 : v; };
        const i8 = (k: number): number => b[o + k] > 127 ? b[o + k] - 256 : b[o + k];
        e.tx = DERBY.x + i16(1) / 50; e.tz = DERBY.z + i16(3) / 50; e.th = (b[o + 5] / 256) * TAU; e.ts = i8(6) / 2; e.tSteer = i8(7) / 100;
        e.hp = b[o + 8]; e.hits = b[o + 9] & 0x7f; this.setOut(e, !!(b[o + 9] & 0x80), now);
        e.car.health = FLOOR + (100 - FLOOR) * e.hp / 100;
        e.seen = now;
      }
    } else if (m.kind === DK.Dents && from === this.caller) {
      const dv = new DataView(new Uint8Array(m.bytes).buffer);
      for (let o = 0; o + 1 + DAMAGE_BYTES <= m.bytes.length; o += 1 + DAMAGE_BYTES) {
        const e = this.ents.get(AI_BASE + m.bytes[o]);
        const host = e?.car as unknown as { dmg: CarDamage | null } | undefined;
        if (!e || !host || !('dmg' in host)) continue;
        const d = host.dmg ?? (host.dmg = new CarDamage());
        const dropped = unpack(d, dv, o + 1);
        if (dropped) { this.vx.showDamage(e.car!, dropped); this.stats.bumpers++; }
      }
    } else if (m.kind === DK.Stat) {
      const e = this.ents.get(from);
      if (!e || e.ai) return;
      const was = e.hits;
      e.hp = m.a; e.hits = m.c;
      if (e.hits > was) this.whoop(0.7);
      this.setOut(e, !!m.b, now);
    } else if (m.kind === DK.End && from === this.caller) {
      const n = m.bytes.length >> 1, order = m.bytes.slice(0, n), hits = m.bytes.slice(n);
      order.forEach((id, i) => { const e = this.ents.get(id >= 200 ? id : id); if (e) { e.hits = Math.max(e.hits, hits[i] ?? 0); } });
      this.podium(order);
    }
  }

  /** The bet slip hears every call, go, end and call-off, in the derby or not (game/betting.ts). */
  private bets(from: number, m: DerbyWire): void {
    if (from !== m.caller || m.caller === this.me) return;
    const bt = this.game.todo.betting, names = (ids: number[]): string[] => ids.map((id) => this.nameOf(id));
    if (m.kind === DK.Call) bt.derbyCall(m.caller, m.bytes, names(m.bytes), m.a, this.link?.record()?.winsBy ?? '');
    else if (m.kind === DK.Go) bt.derbyGo(m.caller, m.bytes, m.a, m.b, names(m.bytes));
    else if (m.kind === DK.End && m.bytes.length >= 2) bt.derbyEnd(m.caller, m.bytes[0]);
    else if (m.kind === DK.Off) bt.derbyOff(m.caller);
  }

  dropped(id: number): void {
    this.invites.delete(id);
    if ((this.phase === 'joined' || this.inRound) && this.caller === id) { this.end(); this.game.hud.toast('The derby\'s caller left town. It is off.', 5); return; }
    if (this.phase === 'calling') { this.ents.delete(id); this.sendCall(); return; }
    const e = this.ents.get(id);
    if (!e || !this.inRound) return;
    e.left = true; this.setOut(e, true, this.clk);
  }

  offline(): void {
    this.invites.clear();
    if (this.phase === 'calling') { this.phase = 'idle'; this.go(); return; }
    if (this.phase === 'joined' || (this.inRound && !this.amCaller)) { this.end(); return; }
    if (this.inRound) for (const e of this.ents.values()) if (!e.ai && e.id !== this.me) { e.left = true; this.setOut(e, true, this.clk); }
  }

  announce(): void { this.sendCall(); this.statSent.at = 0; this.statSent.hp = -1; }

  // ── Hits ───────────────────────────────────────────────────────────────────

  private entOf(v: Vehicle | null): Ent | null {
    if (!v) return null;
    for (const e of this.ents.values()) if (e.car === v || (!e.ai && e.id !== this.me && this.link?.vehicleOf(e.id) === v)) return e;
    return null;
  }
  /** This browser drives it: my own car, or an AI car when I called the derby. */
  private local(e: Ent): boolean { return e.id === this.me || (e.ai && this.amCaller); }

  private onImpact(v: Vehicle, speed: number, other: Vehicle | null, x: number, z: number): void {
    if (this.phase !== 'fight' && this.phase !== 'count') return;
    const a = this.entOf(v);
    if (!a) return;
    if (!other) { if (this.local(a)) this.hurt(a, speed, x, z, 2.4); return; }
    const b = this.entOf(other);
    if (!b) return;
    if (this.local(a)) this.hurt(a, speed, x, z, 1);
    if (this.local(b)) this.hurt(b, speed, x, z, 1);
    if (speed < 3.5 || this.phase !== 'fight') return;
    // Who was driving into whom: the larger share of the closing speed.
    const dx = other.x - v.x, dz = other.z - v.z, l = Math.hypot(dx, dz) || 1;
    const va = (v.vx * dx + v.vz * dz) / l, vb = -(other.vx * dx + other.vz * dz) / l;
    const hitter = va >= vb ? a : b, victim = hitter === a ? b : a;
    if (!this.local(hitter) || hitter.out || victim.out) return;
    hitter.hits++;
    this.stats.hits++;
    this.whoop(Math.min(1, speed / 14));
    if (speed > 9 && this.clk - this.paAt > 6000) this.pa(pick(PA.hit).replace(/\{n\}/g, String(victim.num)));
  }

  /** The bowl's own share of a knock: more health, and the panel folded again. */
  private hurt(e: Ent, speed: number, x: number, z: number, k: number): void {
    const v = e.car;
    if (!v || e.out || speed < 3) { if (v && v.health < FLOOR) v.health = FLOOR; return; }
    v.health = Math.max(FLOOR, v.health - (speed - 3) * EXTRA * k);
    const c = v as unknown as { dmg: CarDamage | null };
    if ('dmg' in c && speed > 5) {
      const d = c.dmg ?? (c.dmg = new CarDamage());
      const dx = x - v.x, dz = z - v.z, s = Math.sin(v.h), co = Math.cos(v.h);
      const r = dent(d, dx * co - dz * s, dx * s + dz * co, v.hl, v.hw, speed * 1.35, Math.random);
      if (r.dropped) {
        this.vx.showDamage(v, r.dropped);
        this.stats.bumpers++;
        if (this.clk - this.paAt > 5000) this.pa(pick(PA.bumper).replace(/\{n\}/g, String(e.num)));
      }
    }
    if (v.health <= FLOOR + 0.5) this.setOut(e, true, this.clk);
  }

  private setOut(e: Ent, out: boolean, now: number): void {
    if (!out || e.out) return;
    e.out = true; e.outAt = now; e.hp = 0;
    this.outOrder.push(e.id);
    this.stats.outs++;
    if (e.car) { e.car.health = FLOOR; if (e.ai && this.amCaller) { e.car.ctl.accel = 0; e.car.ctl.steer = 0; e.car.driver = null; } }
    this.whoop(1);
    const g = this.game;
    if (e.id === this.me) g.hud.stamp('YOU ARE OUT', `Car #${e.num} is done · ${this.running()} still running · stay and watch`);
    else if (this.phase === 'fight') this.pa(pick(PA.out).replace(/\{n\}/g, String(e.num)), true);
  }

  private running(): number { let n = 0; for (const e of this.ents.values()) if (!e.out) n++; return n; }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.clk += Math.min(dt, 0.25) * 1000;
    const now = this.clk, g = this.game, p = g.player;
    this.prompt = null;
    this.drawCrowd(dt);
    if (this.phase === 'idle') {
      if (this.isFree() || this.invites.size) this.offer();
      return;
    }
    if (this.phase === 'calling') {
      const left = Math.max(0, (this.until - now) / 1000);
      this.markers.put(DERBY.gateX, DERBY.gateZ, 'goal', 9, 60);
      this.prompt = `[G] Start the derby now · ${this.ents.size - 1} joined · ${Math.ceil(left)} s`;
      g.hud.objective(`Derby called. Waiting for others (${Math.ceil(left)} s).`);
      if (!(p.health > 0) || Math.hypot(p.x - DERBY.gateX, p.z - DERBY.gateZ) > 80) {
        this.send({ kind: DK.Off }); this.end(); g.hud.toast('Derby called off.', 4); return;
      }
      if (g.input.eat('interact') || left <= 0) this.go();
      return;
    }
    if (this.phase === 'joined') {
      const left = Math.max(0, (this.until - now) / 1000);
      this.markers.put(DERBY.gateX, DERBY.gateZ, 'goal', 9, 60);
      g.hud.objective(`In ${this.nameOf(this.caller)}'s derby. It starts in ${Math.ceil(left)} s.`);
      if (Math.hypot(p.x - DERBY.gateX, p.z - DERBY.gateZ) > 90 || !(p.health > 0)) { this.send({ kind: DK.Join, a: 0 }); this.end(); g.hud.toast('You left before the start.', 4); return; }
      if (now > this.until + 10000) { this.end(); g.hud.toast('The derby never started.', 4); }
      return;
    }
    if (this.phase === 'bets') {
      const left = Math.max(0, (this.until - now) / 1000);
      this.markers.put(DERBY.gateX, DERBY.gateZ, 'goal', 9, 60);
      g.hud.objective(`Bets are open on a derby of eight locals. Z for the slip. It starts in ${Math.ceil(left)} s.`);
      if (!(p.health > 0) || Math.hypot(p.x - DERBY.gateX, p.z - DERBY.gateZ) > 250) { this.game.todo.betting.voidLocal('You walked away, so the derby is off.'); this.end(); g.hud.toast('Derby off.', 4); return; }
      if (left <= 0) {
        this.game.todo.betting.closeLocal();
        this.start([], CARS, this.watchSeed, this.testRound || WATCH_ROUND_S);
      }
      return;
    }
    if (this.phase === 'podium') {
      this.plates();
      if (now > this.podiumUntil || g.input.eat('interact')) this.leave();
      return;
    }
    this.tick(dt, now);
    this.plates();
  }

  private tick(dt: number, now: number): void {
    const g = this.game, p = g.player, mine = this.ents.get(this.me), me = mine as Ent;
    if (!mine && !this.watching) { this.end(); return; }
    if (!this.watching) {
      if (p.heat > 0) p.heat = 0;
      if (p.health > 0 && p.health < 100) p.health = 100;
    }
    const count = this.phase === 'count';
    // Everybody this browser drives: kept in the bowl; the AI driven; the still ones counted out.
    for (const e of this.ents.values()) {
      if (!e.car) continue;
      if (this.local(e)) {
        const v = e.car;
        if (v.health < FLOOR) v.health = FLOOR;
        if (!e.out) e.hp = Math.round(clamp((v.health - FLOOR) / (100 - FLOOR), 0, 1) * 100);
        if (count) { const s = this.slot(e.num - 1); v.x = s.x; v.z = s.z; v.h = s.h; v.vx = v.vz = 0; (v as { yawRate: number }).yawRate = 0; }
        else {
          if (e.ai && !e.out) this.drive(e, dt);
          if (e.out) { v.vx *= 0.97; v.vz *= 0.97; if (e.id === this.me) { v.ctl.accel = 0; } }
          this.keepIn(e, v);
          if (!e.out && now - e.sampleAt > 1000) {
            if (Math.hypot(v.x - e.sx, v.z - e.sz) < 1.2) e.still += (now - (e.sampleAt || now)) / 1000; else e.still = 0;
            e.sx = v.x; e.sz = v.z; e.sampleAt = now;
            if (e.still >= STILL_S) { this.setOut(e, true, now); this.pa(pick(PA.still).replace(/\{n\}/g, String(e.num))); }
          }
        }
      } else if (e.ai) this.poseGhost(e, dt);
    }
    // My car left behind: out.
    if (!this.watching && !count && !me.out && p.vehicle !== me.car) this.setOut(me, true, now);
    if (count) {
      const left = this.goAt - now;
      g.hud.timer('Derby starts', String(Math.max(1, Math.ceil(left / 1000))), true);
      g.hud.objective(this.watching ? 'The cars are on the grid.' : `Car #${me.num}. Wait for it…`);
      if (left <= 0) {
        this.phase = 'fight';
        for (const e of this.ents.values()) { e.sampleAt = now; e.still = 0; if (e.car) { e.sx = e.car.x; e.sz = e.car.z; } }
        g.hud.stamp('WRECK \'EM!', `${this.ents.size} cars · last one running wins`);
        this.pa(pick(PA.go), true);
        this.whoop(1);
      }
    } else if (this.phase === 'fight' && this.watching) {
      const left = this.endAt - now, run = this.running();
      g.hud.timer(`${run} running`, clock(left), left < 30000);
      g.hud.objective('Watching the derby of locals.');
      this.sendCars(now);
      if (run <= 1 || left <= 0) this.callEnd();
    } else if (this.phase === 'fight') {
      const left = this.endAt - now, run = this.running();
      g.hud.timer(`#${me.num} · HP ${me.out ? 'OUT' : me.hp} · hits ${me.hits} · ${run} running`, clock(left), left < 30000);
      if (me.out) g.hud.objective('You are out. Watch the rest of it from the wreck.');
      else if (me.still > 8) g.hud.objective(`MOVE! Out in ${Math.ceil(STILL_S - me.still)} s if you sit still.`);
      else g.hud.objective('Hit them before they hit you. Reverse into them to save your engine.');
      this.sendStat(me, now);
      if (this.amCaller) {
        this.sendCars(now);
        if (run <= 1 || left <= 0) this.callEnd();
      }
    } else if (this.phase === 'done') {
      g.hud.timer(null);
      if (now - this.doneAt > GRACE_MS * 4 && !this.amCaller) { this.end(); g.hud.toast('The derby\'s caller went quiet. It is over.', 5); }
    }
  }

  /** Aim at a car still running (nearest, ahead of the bonnet for choice), ram it, back off for a run-up, reverse out when stuck. */
  private drive(e: Ent, dt: number): void {
    const v = e.car!, c = v.ctl;
    e.pick -= dt;
    let tgt = e.target >= 0 ? this.ents.get(e.target) ?? null : null;
    if (!tgt || tgt.out || e.pick <= 0) {
      let best: Ent | null = null, bs = Infinity;
      for (const o of this.ents.values()) {
        if (o === e || o.out) continue;
        const ov = o.car ?? this.link?.vehicleOf(o.id) ?? null;
        if (!ov) continue;
        const d = Math.hypot(ov.x - v.x, ov.z - v.z), ang = Math.abs(wrap(Math.atan2(ov.x - v.x, ov.z - v.z) - v.h));
        const sc = d + ang * 6 + Math.random() * 8 + (o.id === this.me ? -1 : 0);
        if (sc < bs) { bs = sc; best = o; }
      }
      tgt = best; e.target = best ? best.id : -1; e.pick = 3 + Math.random() * 3;
    }
    const tv = tgt ? tgt.car ?? this.link?.vehicleOf(tgt.id) ?? null : null;
    const tx = tv ? tv.x + tv.vx * 0.35 : DERBY.x, tz = tv ? tv.z + tv.vz * 0.35 : DERBY.z;
    const bd = Math.hypot(tx - v.x, tz - v.z);
    const want = Math.atan2(tx - v.x, tz - v.z), diff = wrap(want - v.h);
    if (e.rev > 0) {
      e.rev -= dt;
      c.accel = -1; c.steer = e.revSteer; c.handbrake = false;
      return;
    }
    const r = Math.hypot((v.x - DERBY.x) / DERBY.a, (v.z - DERBY.z) / DERBY.b);
    const outward = Math.sin(v.h) * (v.x - DERBY.x) / DERBY.a + Math.cos(v.h) * (v.z - DERBY.z) / DERBY.b;
    if (Math.abs(v.speed) < 1) e.stuck += dt; else e.stuck = Math.max(0, e.stuck - dt * 3);
    // In a scrum for too long: back out and come again with a run-up.
    if (bd < 5.5) e.close += dt; else e.close = Math.max(0, e.close - dt);
    if (e.close > 2.2 + Math.random()) { e.close = 0; e.stuck = 2; e.pick = 0; }
    if (e.stuck > 1.4) {
      // Pushing and going nowhere: back off for a run-up (straight back from a car, turning away from the barrier).
      e.stuck = 0;
      const wall = r > 0.8 && outward > 0.2;
      e.rev = wall ? 1 + Math.random() * 0.6 : 1.3 + Math.random() * 0.9;
      e.revSteer = wall ? (diff > 0 ? 1 : -1) : (Math.random() - 0.5) * 0.8;
      if (!wall) e.pick = Math.min(e.pick, 1.5);
      return;
    }
    c.steer = clamp(-diff * 2.4, -1, 1);
    c.accel = Math.abs(diff) > 2.2 && bd > 8 ? 0.6 : 1;
    c.handbrake = Math.abs(diff) > 1.3 && Math.abs(v.speed) > 6 && bd > 6;
  }

  /** The barrier: an ellipse. A corner past it is pushed back and the car bounces; a hard one dents. */
  private keepIn(e: Ent, v: Vehicle): void {
    const A = DERBY.a - 0.5, B = DERBY.b - 0.5, s = Math.sin(v.h), co = Math.cos(v.h);
    let worst = 0, px = 0, pz = 0;
    for (const f of [1, -1]) for (const w of [1, -1]) {
      const x = v.x + s * v.hl * f + co * v.hw * w, z = v.z + co * v.hl * f - s * v.hw * w;
      const ex = (x - DERBY.x) / A, ez = (z - DERBY.z) / B, q = Math.hypot(ex, ez);
      if (q > 1 && q > worst) { worst = q; px = x; pz = z; }
    }
    if (!worst) return;
    let nx = (px - DERBY.x) / (A * A), nz = (pz - DERBY.z) / (B * B);
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const depth = Math.hypot(px - DERBY.x, pz - DERBY.z) * (1 - 1 / worst);
    v.x -= nx * depth; v.z -= nz * depth;
    const vn = v.vx * nx + v.vz * nz;
    if (vn > 0) {
      v.vx -= 1.25 * vn * nx; v.vz -= 1.25 * vn * nz;
      const c = v as { yawRate: number }; c.yawRate *= 0.7;
      if (vn > 3 && this.phase === 'fight') { this.stats.wall++; this.game.emit('impact', { vehicle: v, speed: vn, other: null, x: px, z: pz }); }
    }
  }

  private poseGhost(e: Ent, dt: number): void {
    const v = e.car!;
    // Carried on from the last pose by its speed, and slid toward where the caller says it is.
    e.tx += Math.sin(e.th) * e.ts * dt; e.tz += Math.cos(e.th) * e.ts * dt;
    const k = Math.min(1, dt * 8);
    let x = v.x + (e.tx - v.x) * k, z = v.z + (e.tz - v.z) * k;
    if (Math.hypot(e.tx - v.x, e.tz - v.z) > 8) { x = e.tx; z = e.tz; }
    const h = v.h + wrap(e.th - v.h) * k;
    this.vx.ghostPose(v, x, groundAt(x, z), z, h, 0, 0, e.tSteer, e.out ? 0 : e.ts, false, e.ts < -0.5, dt);
  }

  private sendStat(me: Ent, now: number): void {
    const s = this.statSent;
    const due = me.out !== s.out || me.hits !== s.hits || Math.abs(me.hp - s.hp) >= 2 || now - s.at > 2000;
    if (!due || now - s.at < 250) return;
    s.hp = me.hp; s.out = me.out; s.hits = me.hits; s.at = now;
    this.send({ kind: DK.Stat, a: me.hp, b: me.out ? 1 : 0, c: me.hits });
  }

  /** The caller: the AI cars' poses (6 a second) and dents (about one a second). */
  private sendCars(now: number): void {
    if (!this.link || !this.link.others().length) return;
    if (now - this.carsAt >= 160) {
      this.carsAt = now;
      const b: number[] = [];
      for (const e of this.ents.values()) {
        if (!e.ai || !e.car) continue;
        const v = e.car, i16 = (n: number): void => { const q = clamp(Math.round(n), -32768, 32767) & 0xffff; b.push(q & 0xff, q >> 8); };
        b.push(e.id - AI_BASE);
        i16((v.x - DERBY.x) * 50); i16((v.z - DERBY.z) * 50);
        b.push(Math.round(((v.h % TAU + TAU) % TAU) / TAU * 256) & 0xff);
        b.push(clamp(Math.round(v.speed * 2), -127, 127) & 0xff, clamp(Math.round(v.ctl.steer * 100), -100, 100) & 0xff);
        b.push(e.hp, Math.min(127, e.hits) | (e.out ? 0x80 : 0));
      }
      if (b.length) this.send({ kind: DK.Cars, bytes: b });
    }
    if (now - this.dentsAt >= 900) {
      this.dentsAt = now;
      const buf = new DataView(new ArrayBuffer(DAMAGE_BYTES)), b: number[] = [];
      for (const e of this.ents.values()) {
        if (!e.ai || !e.car) continue;
        pack(damageOf(e.car), buf, 0);
        b.push(e.id - AI_BASE);
        for (let i = 0; i < DAMAGE_BYTES; i++) b.push(buf.getUint8(i));
      }
      if (b.length) this.send({ kind: DK.Dents, bytes: b });
    }
  }

  /** The caller: the order, winner first (the ones still running by health, then the last out first). */
  private callEnd(): void {
    const now = this.clk;
    const run = [...this.ents.values()].filter((e) => !e.out).sort((a, b) => b.hp - a.hp || b.hits - a.hits);
    const outs = this.outOrder.slice().reverse().map((id) => this.ents.get(id)!).filter((e) => e && e.out);
    const order = [...run, ...outs.filter((e) => !run.includes(e))];
    for (const e of this.ents.values()) if (!order.includes(e)) order.push(e);
    this.sendCars(now - 1000);
    this.send({ kind: DK.End, bytes: [...order.map((e) => e.id), ...order.map((e) => Math.min(255, e.hits))] });
    if (this.watching && order[0]) this.game.todo.betting.derbyEnd(-1, order[0].id);
    this.podium(order.map((e) => e.id));
  }

  private podium(order: number[]): void {
    if (this.phase === 'podium') return;
    const g = this.game, night = this.night, t = taper(save.count('derby')).cash * (night ? 2 : 1), me = this.me;
    let pay = 0, won = false, myHits = 0;
    const rows: Row[] = order.map((id, i) => {
      const e = this.ents.get(id);
      const hits = e?.hits ?? 0;
      const cash = id === me ? Math.round(((i === 0 ? WIN_CASH : i === 1 ? SECOND_CASH : i === 2 ? THIRD_CASH : 0) + HIT_CASH * hits) * t) : 0;
      if (id === me) { pay = cash; won = i === 0; myHits = hits; }
      return { id, num: e?.num ?? 0, name: e ? (e.ai ? e.name : this.nameOf(id)) : `Player ${id}`, place: i + 1, hits,
        how: i === 0 ? 'STILL RUNNING' : e?.left ? 'left town' : e?.out ? 'out' : 'running', cash, me: id === me };
    });
    this.lastRows = rows;
    const wins = won ? save.bump('derbyWins') : save.count('derbyWins');
    const watching = this.watching;
    const rec = this.recBefore, notes: string[] = [];
    const humans = rows.filter((r) => r.id < AI_BASE);
    const w = rows[0];
    if (w && w.id < AI_BASE && w.me && wins > (rec?.wins ?? 0)) notes.push(`New town record: ${wins} derby win${wins === 1 ? '' : 's'} by ${w.name}`);
    const hb = humans.slice().sort((a, b) => b.hits - a.hits)[0];
    if (hb && hb.hits > (rec?.hits ?? 0) && this.link) notes.push(`New town record: ${hb.hits} hit${hb.hits === 1 ? "" : "s"} in one derby by ${hb.name}`);
    if (won) notes.push(`Your derby wins: ${wins}`);
    this.lastNotes = notes;
    if (pay > 0) { g.player.money += pay; save.credit(pay); save.data.stats.earned += pay; }
    if (won && !watching) g.emit('moment', { kind: 'derbyWin' });
    if (!watching) save.bump('derby');
    this.send({ kind: DK.Done, a: wins, c: myHits });
    if (night) { notes.push('Derby Night: the purse is doubled.'); this.game.todo.events.derbyOver(); }
    if (watching) notes.push('A derby of locals: nobody of ours was in it. Bets are settled on the slip (Z).');
    this.lastNotes = notes;
    this.ui.podium({ rows, notes, pay, night });
    if (w) this.pa(pick(PA.win).replace(/\{n\}/g, String(w.num)), true);
    this.whoop(1);
    this.stats.podiums++;
    this.phase = 'podium';
    this.podiumUntil = this.clk + 15000;
    g.hud.objective(null); g.hud.timer(null);
    this.setBusy(null);
  }

  /** The podium closed: the cars cleared away, the player back out at the gate in their battered car. */
  private leave(): void {
    const g = this.game, p = g.player, me = this.ents.get(this.me);
    this.ui.podium(null);
    const car = me?.car ?? null;
    this.clearCars(car);
    if (car && !car.removed) {
      car.held = false;
      car.x = DERBY.gateX - 6; car.z = DERBY.gateZ; car.h = -Math.PI / 2; car.vx = car.vz = 0; car.y = groundAt(car.x, car.z);
      if (car.health < 30) car.health = 30;
      this.vx.wake(car);
      if (p.vehicle !== car) { if (p.vehicle) p.exit(true); p.enter(car, true); }
    } else if (!this.watching && Math.hypot(p.x - DERBY.x, p.z - DERBY.z) < 50) p.teleport(DERBY.gateX - 4, DERBY.gateZ);
    if (!this.watching) g.cam.snap();
    this.phase = 'idle';
    this.watching = false;
    this.ents.clear();
  }

  private clearCars(keep: Vehicle | null = null): void {
    for (const e of this.ents.values()) {
      if (e.plates) { e.plates.removeFromParent(); e.plates = null; }
      if (!e.car || e.car === keep) continue;
      if (e.ai && !this.amCaller) this.vx.unghost(e.car);
      else if (e.ai || e.id === this.me) { if (this.game.player.vehicle === e.car) this.game.player.exit(true); this.game.vehicles.remove(e.car); }
      e.car = null;
    }
  }

  private end(): void {
    const was = this.phase;
    if (this.watching) this.game.todo.betting.voidLocal('The derby was called off.');
    if (this.inRound || was === 'podium') { this.ui.podium(null); this.leave(); }
    this.phase = 'idle'; this.ents.clear(); this.watching = false;
    this.game.hud.objective(null); this.game.hud.timer(null);
    if (was !== 'idle' && was !== 'podium') this.setBusy(null);
  }

  // ── Numbers, crowd, announcer ──────────────────────────────────────────────

  private plateMat(n: number): THREE.MeshStandardMaterial {
    if (!this.plateMats) {
      const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 128;
      const x = cv.getContext('2d')!;
      for (let i = 0; i < 8; i++) {
        const cx = i * 128 + 64;
        x.fillStyle = '#f4efe2'; x.beginPath(); x.arc(cx, 64, 58, 0, TAU); x.fill();
        x.lineWidth = 6; x.strokeStyle = '#141414'; x.stroke();
        x.fillStyle = '#141414'; x.font = '900 92px "Arial Black", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(String(i + 1), cx, 70);
      }
      const base = new THREE.CanvasTexture(cv);
      base.colorSpace = THREE.SRGBColorSpace; base.anisotropy = 4;
      this.plateMats = Array.from({ length: 8 }, (_, i) => {
        const t = base.clone(); t.needsUpdate = true; t.repeat.set(1 / 8, 1); t.offset.set(i / 8, 0);
        return new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.5, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4 });
      });
      this.plateGeo = new THREE.PlaneGeometry(1, 1);
    }
    return this.plateMats[(n - 1) & 7];
  }

  /** The numbers on each car's doors and roof follow it. */
  private plates(): void {
    for (const e of this.ents.values()) {
      const v = e.car ?? (e.ai ? null : this.link?.vehicleOf(e.id) ?? null);
      if (!v || v.removed) { if (e.plates) e.plates.visible = false; continue; }
      if (!e.plates) {
        const m = this.plateMat(e.num), grp = new THREE.Group(), H = v.spec.height, sz = Math.min(1.1, H * 0.62);
        for (const side of [-1, 1]) {
          const q = new THREE.Mesh(this.plateGeo!, m);
          q.position.set(side * (v.hw + 0.02), H * 0.5, -v.hl * 0.08); q.rotation.y = side * Math.PI / 2; q.scale.setScalar(sz);
          grp.add(q);
        }
        grp.rotation.order = 'YXZ';
        this.game.scene.add(grp);
        e.plates = grp;
      }
      e.plates.visible = true;
      e.plates.position.set(v.x, v.y, v.z);
      e.plates.rotation.set(-v.pitch, v.h, v.roll);
    }
  }

  private drawCrowd(dt: number): void {
    const g = this.game, eye = g.camera.position, d = Math.hypot(eye.x - DERBY.x, eye.z - DERBY.z);
    if (d > 400 && !this.crowd) return;
    if (!this.crowd) { this.crowd = new Crowd(g.scene, g.quality.name === 'low' ? 0.45 : 1); g.scene.add(dirtFloor()); }
    this.cheer = Math.max(this.inRound || this.phase === 'podium' ? 0.15 : this.night ? 0.12 : 0, this.cheer - dt * 0.35);
    this.crowd.update(dt, d < 400, this.cheer);
  }

  /** The crowd goes up: on their feet in the stands, and a roar. */
  private whoop(k: number): void {
    this.cheer = Math.min(1, this.cheer + k * 0.6);
    const core = this.game.audio?.core;
    if (!core || core.ctx.state !== 'running') return;
    const d = Math.hypot(this.game.camera.position.x - DERBY.x, this.game.camera.position.z - DERBY.z);
    if (d > 200 || !core.claim('derby-roar', 2, 0.6)) return;
    const t = core.now, len = 1.4 + k * 1.2;
    const src = core.burst('pink', t, len), bp = core.filter('bandpass', 700 + Math.random() * 300, 0.6), gn = core.gain(0);
    src.connect(bp); bp.connect(gn); gn.connect(core.bus.sfx);
    core.env(gn.gain, t, 0.25, 0.22 * k * Math.max(0.2, 1 - d / 200), len);
    this.game.audio.voices?.cheer(DERBY.x, DERBY.z);
  }

  private pa(text: string, force = false): void {
    const now = this.clk;
    if (!force && now - this.paAt < 4000) return;
    if (this.told.has(text) && !force) return;
    this.told.add(text);
    this.paAt = now;
    this.ui.pa(text);
  }

  // ── Radar and tests ────────────────────────────────────────────────────────

  blips(out: Blip[]): void {
    const p = this.game.player;
    for (const _ of this.invites.values()) { out.push({ x: DERBY.gateX, z: DERBY.gateZ, kind: 'goal', label: 'D' }); break; }
    if (this.phase === 'calling' || this.phase === 'joined') { out.push({ x: DERBY.gateX, z: DERBY.gateZ, kind: 'goal', label: 'D' }); return; }
    if (this.phase !== 'idle' || !this.isFree()) return;
    if (Math.hypot(DERBY.gateX - p.x, DERBY.gateZ - p.z) < 700) out.push({ x: DERBY.gateX, z: DERBY.gateZ, kind: 'job', label: 'D' });
  }

  /** For the tests (window.__game.game.todo.derby.info()). */
  info(): Record<string, unknown> {
    const now = this.clk;
    return {
      ...this.stats, phase: this.phase, caller: this.caller, running: this.inRound ? this.running() : 0,
      left: this.phase === 'fight' ? Math.round(this.endAt - now) : 0,
      invites: [...this.invites.values()].map((i) => i.caller),
      cars: [...this.ents.values()].map((e) => {
        const v = e.car ?? this.link?.vehicleOf(e.id) ?? null, d = v ? damageOf(v) : null;
        return { id: e.id, num: e.num, ai: e.ai, name: e.ai ? e.name : this.nameOf(e.id), hp: e.hp, out: e.out, hits: e.hits, still: Math.round(e.still),
          x: v ? Math.round(v.x) : null, z: v ? Math.round(v.z) : null, kind: v?.spec.kind ?? null, health: v ? Math.round(v.health) : null,
          dmg: d ? Array.from(d.z).map((n) => +n.toFixed(2)) : null, bumpers: d ? [d.bumpF, d.bumpR] : null };
      }),
      results: this.lastRows.map((r) => ({ id: r.id, num: r.num, place: r.place, hits: r.hits, how: r.how, cash: r.cash })),
      notes: this.lastNotes,
      gate: { x: DERBY.gateX, z: DERBY.gateZ },
    };
  }
}

// ── The crowd: people in the stands, on their feet when it goes off (animated in the vertex shader, no per-frame cost) ──

class Crowd {
  private readonly mesh: THREE.InstancedMesh;
  private readonly uTime = { value: 0 };
  private readonly uCheer = { value: 0 };

  constructor(scene: THREE.Scene, share: number) {
    const body = new THREE.BoxGeometry(0.46, 0.62, 0.3); body.translate(0, 0.31, 0);
    const head = new THREE.BoxGeometry(0.22, 0.25, 0.24); head.translate(0, 0.78, 0);
    const legs = new THREE.BoxGeometry(0.4, 0.3, 0.42); legs.translate(0, 0.0, 0.12);
    const geo = mergeBoxes([body, head, legs]);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime; sh.uniforms.uCheer = this.uCheer;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uCheer;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ph = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
          float up = smoothstep(0.1, 0.5, uCheer + ph * 0.25 - 0.12);
          transformed.y += up * (0.35 + 0.18 * abs(sin(uTime * (7.0 + ph * 5.0) + ph * 6.28))) + 0.03 * sin(uTime * 1.3 + ph * 20.0);
          transformed.x += 0.04 * sin(uTime * 0.9 + ph * 9.0);`);
    };
    const R = new RNG(4242), spots: number[] = [];
    const Y = 0.16, N = 56;
    for (let k = 0; k < 7; k++) {
      const a = 31 + k * 2 + 1.1, b = 20 + k * 2 + 1.1, y = 1.3 + k * 1.58 + Y;
      const per = Math.round(TAU * Math.sqrt((a * a + b * b) / 2) / 0.8);
      for (let i = 0; i < per; i++) {
        const t = (i / per) * TAU, seg = Math.floor((t / TAU) * N);
        if (seg % 4 === 0) continue; // aisles
        if (R.next() > 0.62 * share) continue;
        spots.push(DERBY.x + a * Math.cos(t), y, DERBY.z + b * Math.sin(t), t);
      }
    }
    const n = spots.length / 4;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), sc = new THREE.Vector3();
    const shirts = [0xe4572e, 0x2a9d8f, 0xf2e8cf, 0x14213d, 0xf0a202, 0x3d6b9a, 0x8a3b2e, 0xd9d4c7, 0x5a7a3a, 0x222222];
    for (let i = 0; i < n; i++) {
      const x = spots[i * 4], y = spots[i * 4 + 1], z = spots[i * 4 + 2];
      e.set(0, Math.atan2(DERBY.x - x, DERBY.z - z), 0); q.setFromEuler(e);
      const s = 0.92 + R.next() * 0.16; sc.set(s, s, s);
      m.compose(new THREE.Vector3(x, y, z), q, sc);
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, c.setHex(shirts[Math.floor(R.next() * shirts.length)]).multiplyScalar(0.75 + R.next() * 0.3));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.frustumCulled = true;
    this.mesh.computeBoundingSphere();
    scene.add(this.mesh);
  }

  update(dt: number, show: boolean, cheer: number): void {
    this.mesh.visible = show;
    if (!show) return;
    this.uTime.value += dt;
    this.uCheer.value += (cheer - this.uCheer.value) * Math.min(1, dt * 4);
  }
}

/** The bowl's floor: churned dirt with ruts where the cars go round and dark oil, as vertex colours on one mesh. */
function dirtFloor(): THREE.Mesh {
  const RINGS = 18, SEG = 120, Y = 0.16 + 0.045, R = new RNG(1313);
  const blobs: number[] = [];
  for (let i = 0; i < 34; i++) { const a = R.next() * TAU, k = Math.sqrt(R.next()) * 0.9; blobs.push(Math.cos(a) * k, Math.sin(a) * k, 0.06 + R.next() * 0.16, R.next() < 0.18 ? -1 : (R.next() - 0.5) * 2); }
  const pos: number[] = [], col: number[] = [], idx: number[] = [], c = new THREE.Color();
  const A = DERBY.a + 1.4, B = DERBY.b + 1.4;
  for (let i = 0; i <= RINGS; i++) for (let j = 0; j <= SEG; j++) {
    const rr = i / RINGS, t = (j / SEG) * TAU, u = Math.cos(t) * rr, w = Math.sin(t) * rr;
    pos.push(DERBY.x + u * A, Y, DERBY.z + w * B);
    let k = 0.5 + 0.12 * Math.sin(t * 7 + rr * 13) * Math.sin(t * 3 - rr * 5), oil = 0;
    for (let b = 0; b < blobs.length; b += 4) {
      const d = Math.hypot((u - blobs[b]) * 1.4, w - blobs[b + 1]) / blobs[b + 2];
      if (d < 1) { const f = 1 - d * d; if (blobs[b + 3] < -0.5) oil = Math.max(oil, f); else k += blobs[b + 3] * 0.3 * f; }
    }
    for (const q of [0.52, 0.76]) k -= 0.35 * Math.exp(-(((rr - q) * 26) ** 2));
    c.setHex(0x7a5636).multiplyScalar(0.55 + 0.6 * clamp(k, 0, 1));
    c.lerp(new THREE.Color(0x17140f), oil * 0.85);
    // Fades into the old floor under the barrier.
    col.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < RINGS; i++) for (let j = 0; j < SEG; j++) {
    const a = i * (SEG + 1) + j, b = a + SEG + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.getAttribute('normal'); for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, side: THREE.DoubleSide });
  m.userData.snowRoad = true;
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  return mesh;
}

function mergeBoxes(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let off = 0;
  for (const g of list) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), ix = g.getIndex()!;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    off += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

// ── The page's own bits: the PA caption and the podium card ─────────────────────

const CSS = `
#dd-pa{position:fixed;left:50%;top:21%;transform:translateX(-50%);max-width:min(560px,86vw);padding:6px 12px;background:rgba(20,20,20,.78);color:#f2e8cf;font:600 14px/1.3 system-ui,sans-serif;border-left:4px solid #f0a202;border-radius:3px;z-index:40;pointer-events:none;display:none}
#dd-pa b{color:#f0a202;font:800 12px/1 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.08em;margin-right:6px}
#dd-card{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(480px,92vw);max-height:84vh;overflow:auto;padding:14px 18px;background:#f2e8cf;color:#14213d;font:600 14px/1.35 system-ui,sans-serif;border:3px solid #14213d;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.45);z-index:50;display:none}
#dd-card h2{margin:0 0 8px;font:900 26px/1 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.05em}
#dd-card .pod{display:flex;align-items:flex-end;justify-content:center;gap:6px;margin:4px 0 10px}
#dd-card .pod div{width:31%;text-align:center;font:800 13px/1.2 system-ui,sans-serif}
#dd-card .pod i{display:block;margin-top:4px;background:#14213d;color:#f2e8cf;font:900 22px/1 "Big Shoulders Display","Arial Narrow",sans-serif;padding-top:6px;border-radius:3px 3px 0 0}
#dd-card table{width:100%;border-collapse:collapse}#dd-card td{padding:3px 4px;border-top:1px solid rgba(20,33,61,.2)}
#dd-card tr.me td{font-weight:800}#dd-card .n{color:#9a3412;font-weight:700;margin-top:6px}#dd-card .f{margin-top:8px;font-size:12px;opacity:.7}
`;

class DerbyUi {
  private readonly paEl: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private paT = 0;

  constructor() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.paEl = document.body.appendChild(document.createElement('div')); this.paEl.id = 'dd-pa';
    this.card = document.body.appendChild(document.createElement('div')); this.card.id = 'dd-card';
  }

  pa(text: string): void {
    this.paEl.innerHTML = '<b>PA</b>';
    this.paEl.appendChild(document.createTextNode(text));
    this.paEl.style.display = 'block';
    clearTimeout(this.paT);
    this.paT = window.setTimeout(() => { this.paEl.style.display = 'none'; }, 6500);
  }

  podium(c: { rows: Row[]; notes: string[]; pay: number; night?: boolean } | null): void {
    if (!c) { this.card.style.display = 'none'; return; }
    const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
    const step = (r: Row | undefined, h: number): string => r ? `<div>#${r.num} ${esc(r.name)}${r.me ? ' (you)' : ''}<i style="height:${h}px">${r.place}</i></div>` : '<div></div>';
    const [a, b, d] = c.rows;
    this.card.innerHTML = `<h2>${c.night ? 'DERBY NIGHT' : 'DEMOLITION DERBY'} · RESULTS</h2><div class="pod">${step(b, 46)}${step(a, 70)}${step(d, 30)}</div><table>`
      + c.rows.map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${r.place}.</td><td>#${r.num}</td><td>${esc(r.name)}${r.me ? ' (you)' : ''}</td><td>${esc(r.how)}</td><td>${r.hits} hit${r.hits === 1 ? '' : 's'}</td><td>${r.me ? '$' + r.cash : ''}</td></tr>`).join('')
      + `</table>` + c.notes.map((n) => `<div class="n">${esc(n)}</div>`).join('')
      + `<div class="f">${c.pay > 0 ? `You earned $${c.pay}. ` : ''}G to close.</div>`;
    this.card.style.display = 'block';
  }
}
