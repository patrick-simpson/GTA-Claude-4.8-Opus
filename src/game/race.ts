// Fun queue item 11: races between players, and against the clock alone.
//
// A race marker stands at the start of every route in Activities.races (the six old ones and three more: the
// Downtown Circuit, the Coast Run and the Tepid Falls Loop, that last one only once its streets are open). A player in
// a car at a marker presses G:
//  - alone (offline, or nobody else in town): straight to the grid, a countdown, the race, against par, their own best
//    and the town's record;
//  - with others in town: a CALL. Every other player gets a toast and an R on the radar for JOIN_S seconds; whoever drives
//    up to the marker in a car joins. The caller presses G again to go early, or the window runs out; then the caller
//    sends the grid (who is in, in slot order) and the GO time.
// The grid stands on the first street of the route, two by two, behind a start gantry. A countdown (three red lights,
// then green, with beeps and a horn) holds every car still on its own screen. Checkpoints are glowing rings with an arrow
// to the next; positions are worked out on every screen from the checkpoints each racer has passed (one small frame
// per checkpoint, net/race.ts) and where their car is shown, and gaps from the times at the same checkpoint. A loop runs
// for its laps and finishes under a chequered banner. Each racer's own browser times its own race (wall clock, from
// its own GO) and says so in a Done frame, so the order on the podium is the same on every screen: by those times.
// Anyone still out on the road a minute after the winner's time is out (they say so themselves).
// Cash for places (tapered like every other job here); records go to the town: the host writes the fact (net/race.ts)
// and everybody, a late joiner too, sees who holds each route's race and lap record at its marker.
// Traffic, police and collisions run as normal throughout. Kid-friendly mode changes nothing here.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import { groundAt } from '../world/plan';
import { money } from '../core/util';
import { save } from './save';
import { taper, type RaceDef } from './activities';
import type { Markers, Pt } from './script';
import { BUILT_LOCAL, BUILT_ROUTE0 } from '../net/protocol';

/** Seconds others have to drive to the marker after a call. */
export const JOIN_S = 30;
/** How near the marker counts as being at it (to call), and as having driven up to it (to join), meters. */
const AT_M = 10, JOIN_M = 26;
/** Ms from the grid going out to GO. */
const GRID_MS = 6000;
/** A checkpoint is passed within this, meters. */
const CP_M = 13;
/** Out of the car this long during a race: out of the race. */
const AWAY_S = 10;
/** Still racing this long after the winner's time: out. */
const LATE_S = 60;
/** Cash for 1st, 2nd, 3rd, the rest (tapered by how many races have paid). */
const PLACE_CASH = [450, 280, 160, 80];

export interface TownRecord { lap: number; lapBy: string; race: number; raceBy: string; laps: number }
export interface RaceWire { kind: number; caller: number; route: number; laps: number; secs: number; ms: number; lap: number; count: number; how: number; ids: number[] }

/** What the network gives the race (net/race.ts). Null offline: then every race is a solo one. */
export interface RaceLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): Pt | null;
  send(m: RaceWire): void;
  record(route: number): TownRecord | null;
}
export const RK = { Call: 1, Join: 2, Go: 3, Cp: 4, Done: 5, Off: 6 } as const;

type Phase = 'idle' | 'calling' | 'joined' | 'grid' | 'race' | 'done' | 'podium';
interface Racer { id: number; name: string; slot: number; count: number; times: number[]; total: number; best: number; how: number }
interface Invite { caller: number; route: number; until: number; laps: number; told: boolean }

const fmt = (ms: number): string => {
  if (!(ms > 0)) return '--:--.-';
  const t = Math.round(ms / 100), m = Math.floor(t / 600), s = (t % 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};
const ord = (n: number): string => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

export class Racing {
  link: RaceLink | null = null;
  prompt: string | null = null;
  phase: Phase = 'idle';
  readonly stats = { called: 0, joined: 0, finished: 0, podiums: 0, sent: 0, got: 0 };

  private route: RaceDef | null = null;
  private laps = 1;
  private caller = 0;
  private readonly racers = new Map<number, Racer>();
  private until = 0;
  private goAt = 0;
  /** Race clock, ms: wall time while this page runs the game (a pause does not count). */
  private rt = 0;
  private lastWall = 0;
  private awayT = 0;
  private leaderMs = 0;
  private firstDoneWall = 0;
  private recBefore: TownRecord | null = null;
  private podiumUntil = 0;
  private lastResults: { id: number; name: string; place: number; total: number; best: number; how: number; cash: number }[] = [];
  private readonly invites = new Map<number, Invite>();
  private beeped = -1;
  private uiAt = 0;

  private readonly ui: RaceUi;
  private readonly gfx: RaceGfx;

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly races: () => RaceDef[],
    private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    this.ui = new RaceUi();
    this.gfx = new RaceGfx(game.scene);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private get me(): number { return this.link ? this.link.me() : 0; }
  private nameOf(id: number): string { return this.link ? this.link.nameOf(id) : 'You'; }
  private routeOk(r: RaceDef): boolean { return r.edges.every((e) => !(this.game.plan.streets ?? this.game.plan).edges[e]?.closed); }
  private send(m: Partial<RaceWire> & { kind: number }): void {
    if (!this.link) return;
    this.link.send({ caller: this.caller, route: this.route ? this.route.idx : 0, laps: this.laps, secs: 0, ms: 0, lap: 0, count: 0, how: 0, ids: [], ...m });
    this.stats.sent++;
  }
  private byIdx(idx: number): RaceDef | null { return this.races().find((r) => r.idx === idx) ?? null; }
  /** A route by its index (the old ones, and the town's built ones from BUILT_ROUTE0: game/raceBuilder.ts). */
  def(idx: number): RaceDef | null { return this.byIdx(idx); }
  /** Every checkpoint of the race in order (laps times round). */
  private cpAt(k: number): Pt { const r = this.route as RaceDef; return r.cps[k % r.cps.length]; }
  private get total(): number { return this.route ? this.route.cps.length * this.laps : 0; }

  /** The town's record for a route, or this player's own best while offline. */
  record(r: RaceDef): TownRecord | null {
    const t = this.link?.record(r.idx);
    if (t) return t;
    const b = save.data.best['race:' + r.name], l = save.data.best['lap:' + r.name];
    return b === undefined ? null : { race: b * 1000, raceBy: 'you', lap: (l ?? b) * 1000, lapBy: 'you', laps: r.laps };
  }

  /** Grid slot k: two by two on the first street, nose toward the first checkpoint. */
  slot(k: number): { x: number; z: number; h: number } {
    const r = this.route as RaceDef, s = r.start, c = r.cps[0];
    const L = Math.hypot(c.x - s.x, c.z - s.z), dx = r.dir ? r.dir.x : (c.x - s.x) / L, dz = r.dir ? r.dir.z : (c.z - s.z) / L, h = Math.atan2(dx, dz);
    const row = Math.floor(k / 2), side = k % 2 ? 1 : -1, ahead = 30 - row * 8.5;
    return { x: s.x + dx * ahead + Math.cos(h) * 2.8 * side, z: s.z + dz * ahead - Math.sin(h) * 2.8 * side, h };
  }
  private line(): { x: number; z: number; h: number } {
    const r = this.route as RaceDef, s = r.start, c = r.cps[0];
    const L = Math.hypot(c.x - s.x, c.z - s.z), dx = r.dir ? r.dir.x : (c.x - s.x) / L, dz = r.dir ? r.dir.z : (c.z - s.z) / L;
    return { x: s.x + dx * 37, z: s.z + dz * 37, h: Math.atan2(dx, dz) };
  }

  // ── Starting ───────────────────────────────────────────────────────────────

  private offer(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle, now = performance.now();
    void dt;
    // Invitations: a marker and a blip while open; driving up to it joins.
    for (const [id, inv] of this.invites) {
      if (now > inv.until) { this.invites.delete(id); continue; }
      const r = this.byIdx(inv.route);
      if (!r) continue;
      this.markers.put(r.start.x, r.start.z, 'goal', 9, 60);
      const d = Math.hypot(p.x - r.start.x, p.z - r.start.z);
      if (v && d < JOIN_M && this.isFree()) { this.join(inv, r); return; }
    }
    let at: RaceDef | null = null;
    for (const r of this.races()) {
      if (!this.routeOk(r)) continue;
      const d = Math.hypot(p.x - r.start.x, p.z - r.start.z);
      if (d > 300) continue;
      this.markers.put(r.start.x, r.start.z, 'job', 7, 22);
      if (d < 60) this.gfx.flag(r.start, r.cps[0], now);
      if (v && d < AT_M && p.speed < 4 && this.isFree()) at = r;
    }
    if (!at) return;
    const rec = this.record(at), mine = save.data.best['race:' + at.name];
    const many = this.link && at.idx < BUILT_LOCAL ? this.link.others().length : 0;
    const what = `${at.laps > 1 ? `${at.laps} laps · ` : ''}par ${fmt(at.par * 1000)}`;
    const recT = rec ? ` · record ${fmt(rec.race)} by ${rec.raceBy}${at.laps > 1 ? `, lap ${fmt(rec.lap)} by ${rec.lapBy}` : ''}` : ' · no record yet';
    this.prompt = `[G] ${many ? 'Call a race' : 'Race'}: "${at.name}" · ${what}${recT}${mine !== undefined && rec?.raceBy !== 'you' ? ` · your best ${fmt(mine * 1000)}` : ''}`;
    if (g.input.eat('interact')) this.call(at);
  }

  /** G at a marker. */
  call(r: RaceDef): void {
    const others = this.link ? this.link.others() : [];
    this.route = r; this.laps = r.laps; this.caller = this.me;
    this.racers.clear();
    this.addRacer(this.me);
    this.invites.clear();
    this.setBusy('race');
    this.stats.called++;
    // (A race from the player's own list was never published: nobody else has its route, so it is only ever run alone.)
    if (!others.length || r.idx >= BUILT_LOCAL) { this.grid([this.me], GRID_MS - 1500); return; }
    this.phase = 'calling';
    this.until = performance.now() + JOIN_S * 1000;
    this.sendCall();
    this.game.hud.stamp('RACE CALLED', `${r.name} · everybody in town has ${JOIN_S} s to drive here · G to start now`);
  }

  private sendCall(): void {
    if (this.phase !== 'calling') return;
    this.send({ kind: RK.Call, secs: Math.max(1, (this.until - performance.now()) / 1000), ids: [...this.racers.keys()] });
  }

  private join(inv: Invite, r: RaceDef): void {
    this.invites.clear();
    this.route = r; this.laps = inv.laps; this.caller = inv.caller;
    this.racers.clear();
    this.until = inv.until;
    this.phase = 'joined';
    this.setBusy('race');
    this.stats.joined++;
    this.send({ kind: RK.Join, how: 1 });
    this.game.hud.stamp('YOU ARE IN', `${this.nameOf(inv.caller)}'s race · ${r.name} · wait for the grid`);
  }

  private addRacer(id: number): Racer {
    let x = this.racers.get(id);
    if (!x) this.racers.set(id, x = { id, name: this.nameOf(id), slot: this.racers.size, count: 0, times: [], total: 0, best: 0, how: 0 });
    return x;
  }

  /** Everybody in: the grid, and GO in ms. */
  private grid(ids: number[], ms: number): void {
    const g = this.game, v = g.player.vehicle;
    this.racers.clear();
    for (const id of ids) this.addRacer(id);
    this.phase = 'grid';
    this.goAt = performance.now() + ms;
    this.rt = 0; this.awayT = 0; this.leaderMs = 0; this.firstDoneWall = 0; this.beeped = -1;
    this.recBefore = this.route ? this.record(this.route) : null;
    if (v) {
      const s = this.slot(ids.indexOf(this.me));
      this.hold(v, s, true);
    }
    this.gfx.start(this.line(), true);
    this.ui.lights(0, 'GRID');
  }

  private hold(v: Vehicle, s: { x: number; z: number; h: number }, first: boolean): void {
    const c = v as Vehicle & { yawRate?: number };
    v.x = s.x; v.z = s.z; v.h = s.h; v.y = Math.max(groundAt(s.x, s.z), 0);
    v.vx = v.vy = v.vz = 0; c.yawRate = 0; v.pitch = 0; v.roll = 0;
    if (first) { (this.game.vehicles as unknown as { wake?: (v: Vehicle) => void }).wake?.(v); this.game.cam.snap(); }
  }

  // ── The network's ──────────────────────────────────────────────────────────

  /** A race frame from another player (net/race.ts). */
  got(from: number, m: RaceWire): void {
    this.stats.got++;
    const now = performance.now(), r = this.byIdx(m.route);
    this.bets(from, m, r);
    if (m.kind === RK.Call) {
      if (from !== m.caller || !r) return;
      if (this.phase === 'joined' && this.caller === m.caller) { this.until = now + m.secs * 1000; return; }
      if (this.phase !== 'idle') return;
      const old = this.invites.get(m.caller);
      this.invites.set(m.caller, { caller: m.caller, route: m.route, laps: m.laps, until: now + m.secs * 1000, told: true });
      if (!old) {
        const where = this.game.plan.placeName(r.start.x, r.start.z);
        this.game.hud.toast(`${this.nameOf(m.caller)} called a race: "${r.name}" at ${where}. Drive to the R on the radar within ${Math.round(m.secs)} s to join.`, 8);
      }
      return;
    }
    if (m.kind === RK.Off) {
      this.invites.delete(m.caller);
      if (this.phase === 'joined' && this.caller === m.caller) { this.end(); this.game.hud.toast(`${this.nameOf(m.caller)} called the race off.`, 5); }
      return;
    }
    if (m.kind === RK.Join) {
      if (this.phase !== 'calling' || m.caller !== this.me) return;
      if (m.how && this.racers.size < 8) { this.addRacer(from); this.game.hud.toast(`${this.nameOf(from)} is in.`, 3); }
      else if (!m.how) this.racers.delete(from);
      this.sendCall();
      return;
    }
    if (m.kind === RK.Go) {
      if (this.phase !== 'joined' || m.caller !== this.caller) return;
      if (!m.ids.includes(this.me)) { this.end(); this.game.hud.toast('The grid filled up before you got there.', 5); return; }
      this.laps = m.laps;
      this.grid(m.ids, m.ms);
      return;
    }
    if (m.caller !== this.caller || !['grid', 'race', 'done', 'podium'].includes(this.phase)) return;
    const x = this.racers.get(from);
    if (!x) return;
    if (m.kind === RK.Cp) { x.count = Math.max(x.count, m.count); x.times[m.count - 1] = m.ms; }
    else if (m.kind === RK.Done) this.done(x, m.how, m.ms, m.lap);
  }

  /** The bet slip hears every call, go, finish and call-off, racing or not (game/betting.ts). */
  private bets(from: number, m: RaceWire, r: RaceDef | null): void {
    const bt = this.game.todo.betting, names = (ids: number[]): string[] => ids.map((id) => this.nameOf(id));
    if (m.kind === RK.Call) { if (from === m.caller && r && r.idx < BUILT_LOCAL) bt.raceCall(m.caller, `${r.name} (race)`, m.ids, names(m.ids), m.secs, this.record(r)?.raceBy ?? ''); }
    else if (m.kind === RK.Go) { if (from === m.caller) bt.raceGo(m.caller, m.ids, names(m.ids)); }
    else if (m.kind === RK.Done) bt.raceDone(m.caller, from, m.how, m.ms);
    else if (m.kind === RK.Off) { if (from === m.caller) bt.raceOff(m.caller); }
  }

  /** A player left town. */
  dropped(id: number): void {
    this.game.todo.betting.dropped(id);
    this.invites.delete(id);
    if (this.phase === 'joined' && this.caller === id) { this.end(); this.game.hud.toast('The race caller left town. Race off.', 5); return; }
    if (this.phase === 'calling') { this.racers.delete(id); this.sendCall(); return; }
    const x = this.racers.get(id);
    if (x && !x.how) this.done(x, 2, 0, 0);
  }

  /** Off the network: whoever else was racing is out; this player's own race goes on. */
  offline(): void {
    this.game.todo.betting.offline();
    this.invites.clear();
    if (this.phase === 'joined') { this.end(); return; }
    for (const x of this.racers.values()) if (x.id !== this.me && !x.how) this.done(x, 2, 0, 0);
  }

  /** Somebody has just arrived: an open call is told again. */
  announce(): void { this.sendCall(); }

  private done(x: Racer, how: number, ms: number, lap: number): void {
    if (x.how) return;
    x.how = how; x.total = ms; x.best = lap;
    if (how === 1 && (!this.leaderMs || ms < this.leaderMs)) this.leaderMs = ms;
    if (how === 1 && !this.firstDoneWall) this.firstDoneWall = performance.now();
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const now = performance.now(), wall = Math.min(250, Math.max(0, now - (this.lastWall || now)));
    this.lastWall = now;
    this.prompt = null;
    this.gfx.begin();
    const g = this.game, p = g.player, v = p.vehicle;
    if (this.phase === 'idle') { if (this.isFree()) this.offer(dt); this.ui.panel(null); this.gfx.end(); return; }
    const r = this.route as RaceDef;
    if (this.phase === 'calling') {
      const left = Math.max(0, (this.until - now) / 1000), n = this.racers.size;
      this.markers.put(r.start.x, r.start.z, 'goal', 9, 60);
      this.gfx.flag(r.start, r.cps[0], now);
      this.prompt = `[G] Start the race now · ${n - 1} joined · ${Math.ceil(left)} s`;
      g.hud.objective(`Race called: ${r.name}. Waiting for others (${Math.ceil(left)} s).`);
      if (!v || !(p.health > 0) || Math.hypot(p.x - r.start.x, p.z - r.start.z) > 80) {
        this.send({ kind: RK.Off }); this.end(); g.hud.toast('Race called off.', 4); this.gfx.end(); return;
      }
      if (g.input.eat('interact') || left <= 0) {
        const ids = [...this.racers.keys()];
        this.send({ kind: RK.Go, ms: GRID_MS, ids });
        this.grid(ids, GRID_MS);
      }
    } else if (this.phase === 'joined') {
      const left = Math.max(0, (this.until - now) / 1000);
      this.markers.put(r.start.x, r.start.z, 'goal', 9, 60);
      this.gfx.flag(r.start, r.cps[0], now);
      g.hud.objective(`In ${this.nameOf(this.caller)}'s race: ${r.name}. The grid goes out in ${Math.ceil(left)} s.`);
      if (Math.hypot(p.x - r.start.x, p.z - r.start.z) > 90 || !(p.health > 0)) { this.send({ kind: RK.Join, how: 0 }); this.end(); g.hud.toast('You left the race before the start.', 4); this.gfx.end(); return; }
      if (now > this.until + 10000) { this.end(); g.hud.toast('The race never started.', 4); this.gfx.end(); return; }
    } else if (this.phase === 'grid') {
      const toGo = this.goAt - now, step = Math.ceil(toGo / 1000);
      if (v) this.hold(v, this.slot([...this.racers.keys()].indexOf(this.me)), false);
      this.gfx.start(this.line(), true);
      this.showCp(0);
      if (step <= 3 && step >= 1 && step !== this.beeped) { this.beeped = step; this.ui.lights(4 - step, String(step)); beep(g, 440, 0.18); }
      if (toGo <= 0) {
        this.phase = 'race'; this.rt = 0;
        this.ui.lights(4, 'GO!');
        beep(g, 880, 0.35); horn(g);
      }
      g.hud.objective(`${r.name}: on the grid. Wait for green.`);
    } else if (this.phase === 'race') {
      this.rt += wall;
      this.tickRace(dt);
    } else if (this.phase === 'done') {
      // Waiting for the rest: every racer has said, or the late ones are a long way behind.
      const all = [...this.racers.values()].every((x) => x.how);
      if (all || (this.leaderMs && now - this.firstDoneWall > (LATE_S + 20) * 1000)) this.podium();
    } else if (this.phase === 'podium') {
      if (now > this.podiumUntil || g.input.eat('interact')) { this.ui.podium(null); this.phase = 'idle'; this.route = null; this.racers.clear(); }
    }
    if (this.phase === 'grid' || this.phase === 'race' || this.phase === 'done') {
      if (this.phase !== 'grid' && now > this.goAt + 1500) this.ui.lights(-1, '');
      this.gfx.start(this.line(), this.phase !== 'done');
      if (now - this.uiAt > 150) { this.uiAt = now; this.ui.panel(this.board()); }
    } else this.ui.panel(null);
    this.gfx.end();
  }

  private showCp(k: number): void {
    if (!this.route) return;
    const total = this.total, c = this.cpAt(k), n = k + 1 < total ? this.cpAt(k + 1) : null;
    const prev = k === 0 ? this.route.start : this.cpAt(k - 1);
    this.gfx.cp(c, prev, n, k === total - 1, performance.now());
  }

  private tickRace(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle, me = this.racers.get(this.me) as Racer, r = this.route as RaceDef;
    if (!me) { this.end(); return; }
    // Out of the car, dead, or a long way behind the winner: out.
    if (!v) this.awayT += dt; else this.awayT = 0;
    if (this.awayT > AWAY_S || !(p.health > 0) || (this.leaderMs && this.rt > this.leaderMs + LATE_S * 1000)) { this.finish(me, 2); return; }
    const k = me.count, c = this.cpAt(k), x = v ? v.x : p.x, z = v ? v.z : p.z;
    this.showCp(k);
    const n = r.cps.length, lap = Math.floor(k / n) + 1;
    g.hud.objective(!v ? 'Get back in a car, or you are out of the race.' : `${r.name}: checkpoint ${k % n + 1} of ${n}${this.laps > 1 ? ` · lap ${lap} of ${this.laps}` : ''}.`);
    g.hud.timer(this.laps > 1 ? `Lap ${lap}/${this.laps}` : 'Race', fmt(this.rt), false);
    if (Math.hypot(x - c.x, z - c.z) > CP_M) return;
    me.count++;
    // (Whole ms, as the frame carries them: every screen works with the same numbers.)
    me.times[me.count - 1] = Math.round(this.rt);
    this.send({ kind: RK.Cp, count: me.count, ms: me.times[me.count - 1] });
    if (me.count < this.total) { beep(g, me.count % n === 0 ? 990 : 660, 0.08); return; }
    this.finish(me, 1);
  }

  private finish(me: Racer, how: number): void {
    const n = (this.route as RaceDef).cps.length;
    let best = 0;
    if (how === 1) for (let l = 0; l < this.laps; l++) {
      const t = me.times[(l + 1) * n - 1] - (l ? me.times[l * n - 1] : 0);
      if (t > 0 && (!best || t < best)) best = t;
    }
    const total = how === 1 ? Math.round(this.rt) : 0;
    this.send({ kind: RK.Done, how, ms: total, lap: best });
    this.done(me, how, total, best);
    this.phase = 'done';
    this.game.hud.timer(null);
    this.game.hud.objective(how === 1 ? 'Finished. Waiting for the others.' : 'Out of the race.');
    if (how === 1) { beep(this.game, 1320, 0.4); this.stats.finished++; }
  }

  /** Every screen: the order by the times the racers sent; this player is paid for their own place. */
  private podium(): void {
    const g = this.game, r = this.route as RaceDef, before = this.recBefore;
    const list = [...this.racers.values()].sort((a, b) => (a.how === 1 ? 0 : 1) - (b.how === 1 ? 0 : 1) || (a.how === 1 ? a.total - b.total : a.slot - b.slot));
    let pay = 0;
    const field = list.length;
    this.lastResults = list.map((x, i) => {
      let cash = 0;
      if (x.how === 1) {
        const base = field > 1 ? PLACE_CASH[Math.min(i, 3)] : x.total <= r.par * 1000 ? PLACE_CASH[0] : PLACE_CASH[3];
        cash = Math.round(base * (r.laps > 1 ? 1.3 : 1) * taper(save.count('race:' + r.name)).cash * (r.idx >= BUILT_ROUTE0 ? 0.4 : 1));
      }
      if (x.id === this.me) pay = cash;
      return { id: x.id, name: x.name, place: i + 1, total: x.total, best: x.best, how: x.how, cash };
    });
    const me = list.find((x) => x.id === this.me);
    const notes: string[] = [];
    const win = list[0]?.how === 1 ? list[0] : null;
    if (win && (!before || win.total < before.race)) notes.push(`New town race record: ${fmt(win.total)} by ${win.name}`);
    const bestLap = list.filter((x) => x.how === 1 && x.best > 0).sort((a, b) => a.best - b.best)[0];
    if (bestLap && r.laps > 1 && (!before || bestLap.best < before.lap)) notes.push(`New town lap record: ${fmt(bestLap.best)} by ${bestLap.name}`);
    if (me && me.how === 1) {
      save.record('race:' + r.name, +(me.total / 1000).toFixed(1), true);
      if (me.best) save.record('lap:' + r.name, +(me.best / 1000).toFixed(1), true);
      save.bump('race:' + r.name);
      save.data.stats.races++;
    }
    if (pay > 0) { g.player.money += pay; save.credit(pay); save.data.stats.earned += pay; }
    if (me && me.how === 1 && field > 1) g.emit('moment', { kind: list[0] === me ? 'raceWin' : 'raceLose' });
    this.ui.podium({ title: r.name, rows: this.lastResults.map((x) => ({ ...x, me: x.id === this.me })), notes, pay, solo: field === 1, par: r.par * 1000 });
    this.stats.podiums++;
    this.phase = 'podium';
    this.podiumUntil = performance.now() + 14000;
    g.hud.objective(null);
    this.setBusy(null);
  }

  private end(): void {
    const was = this.phase;
    this.phase = 'idle'; this.route = null; this.racers.clear();
    this.ui.lights(-1, ''); this.ui.panel(null);
    this.game.hud.objective(null); this.game.hud.timer(null);
    if (was !== 'idle' && was !== 'podium') this.setBusy(null);
  }

  /** Live order: finished by time, then by checkpoints passed, then by how near the next one. */
  private board(): BoardRow[] {
    const p = this.game.player, v = p.vehicle;
    const rows = [...this.racers.values()].map((x) => {
      const at = x.id === this.me ? { x: v ? v.x : p.x, z: v ? v.z : p.z } : this.link?.posOf(x.id) ?? null;
      const c = x.count < this.total ? this.cpAt(x.count) : null;
      return { x, d: at && c ? Math.hypot(at.x - c.x, at.z - c.z) : 9999 };
    });
    rows.sort((a, b) => {
      const fa = a.x.how === 1, fb = b.x.how === 1;
      if (fa || fb) return fa && fb ? a.x.total - b.x.total : fa ? -1 : 1;
      if ((a.x.how === 2) !== (b.x.how === 2)) return a.x.how === 2 ? 1 : -1;
      return b.x.count - a.x.count || a.d - b.d;
    });
    const lead = rows[0]?.x;
    return rows.map((o, i) => {
      const x = o.x;
      let gap = '';
      if (i > 0 && lead) {
        if (x.how === 2) gap = 'out';
        else if (x.how === 1 && lead.how === 1) gap = `+${((x.total - lead.total) / 1000).toFixed(1)}`;
        else if (x.count > 0 && lead.times[x.count - 1] !== undefined && x.times[x.count - 1] !== undefined) gap = `+${((x.times[x.count - 1] - lead.times[x.count - 1]) / 1000).toFixed(1)}`;
        else if (lead.count > x.count) gap = `-${lead.count - x.count} cp`;
      } else if (x.how === 1) gap = fmt(x.total);
      return { pos: i + 1, name: x.id === this.me ? `${x.name} (you)` : x.name, gap, me: x.id === this.me, done: x.how === 1 };
    }).concat([]).map((row, _i, all) => ({ ...row, of: all.length, lap: this.myLap(), laps: this.laps, cp: this.myCp(), cps: this.total, clock: fmt(this.phase === 'race' ? this.rt : this.racers.get(this.me)?.total ?? 0) }));
  }
  private myLap(): number { const me = this.racers.get(this.me), n = this.route ? this.route.cps.length : 1; return me ? Math.min(this.laps, Math.floor(me.count / n) + 1) : 1; }
  private myCp(): number { return this.racers.get(this.me)?.count ?? 0; }

  blips(out: Blip[]): void {
    const p = this.game.player;
    for (const inv of this.invites.values()) { const r = this.byIdx(inv.route); if (r) out.push({ x: r.start.x, z: r.start.z, kind: 'goal', label: 'R' }); }
    if (this.phase === 'race') { const me = this.racers.get(this.me); if (me && me.count < this.total) { const c = this.cpAt(me.count); out.push({ x: c.x, z: c.z, kind: 'goal' }); } return; }
    if (this.phase !== 'idle' || !this.isFree()) return;
    const near = this.races().filter((r) => this.routeOk(r)).map((r) => ({ r, d: Math.hypot(r.start.x - p.x, r.start.z - p.z) })).sort((a, b) => a.d - b.d).slice(0, 2);
    for (const n of near) out.push({ x: n.r.start.x, z: n.r.start.z, kind: 'job', label: 'R' });
  }

  /** For the tests (window.__game.game.todo.racing.info()) and the leaderboard later. */
  info(): Record<string, unknown> {
    const r = this.route;
    return {
      ...this.stats, phase: this.phase, route: r ? r.name : null, idx: r ? r.idx : -1, laps: this.laps, caller: this.caller,
      rt: Math.round(this.rt), invites: [...this.invites.values()].map((i) => ({ caller: i.caller, route: i.route })),
      racers: [...this.racers.values()].map((x) => ({ id: x.id, name: x.name, count: x.count, total: Math.round(x.total), best: Math.round(x.best), how: x.how })),
      results: this.lastResults, total: this.total,
      board: this.phase === 'race' || this.phase === 'done' ? this.board().map((b) => `${b.pos}:${b.name}${b.gap ? ' ' + b.gap : ''}`) : [],
      records: this.races().map((x) => ({ route: x.name, rec: this.record(x) })),
    };
  }
  /** For the tests: the points a car should drive through, grid slot first. */
  path(): Pt[] {
    if (!this.route) return [];
    const s = this.slot(Math.max(0, [...this.racers.keys()].indexOf(this.me))), pts: Pt[] = [{ x: s.x, z: s.z }];
    for (let k = 0; k < this.total; k++) pts.push(this.cpAt(k));
    return pts;
  }
}

// ── Sounds (the page's own AudioContext, made by the game on the first key) ─────

function out(g: Game): { ctx: AudioContext; to: GainNode } | null {
  const ctx = g.audio?.ctx;
  if (!ctx || ctx.state !== 'running') return null;
  const s = save.data.settings as unknown as Record<string, number>;
  const lvl = (Number(s.volMaster ?? 1)) * (Number(s.volSfx ?? 1));
  if (!(lvl > 0)) return null;
  const to = ctx.createGain(); to.gain.value = 0.22 * lvl; to.connect(ctx.destination);
  return { ctx, to };
}
function beep(g: Game, hz: number, len: number): void {
  const o = out(g); if (!o) return;
  const t = o.ctx.currentTime, osc = o.ctx.createOscillator(), env = o.ctx.createGain();
  osc.type = 'square'; osc.frequency.value = hz;
  env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.5, t + 0.01); env.gain.setValueAtTime(0.5, t + len); env.gain.linearRampToValueAtTime(0, t + len + 0.05);
  osc.connect(env).connect(o.to); osc.start(t); osc.stop(t + len + 0.1);
}
function horn(g: Game): void {
  const o = out(g); if (!o) return;
  const t = o.ctx.currentTime + 0.05;
  for (const hz of [349, 440]) {
    const osc = o.ctx.createOscillator(), env = o.ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = hz;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.35, t + 0.03); env.gain.setValueAtTime(0.35, t + 0.9); env.gain.linearRampToValueAtTime(0, t + 1.05);
    osc.connect(env).connect(o.to); osc.start(t); osc.stop(t + 1.1);
  }
}

// ── In the world: rings, an arrow, the start gantry and the chequered banner ────

class RaceGfx {
  private readonly ring: THREE.Mesh;
  private readonly next: THREE.Mesh;
  private readonly arrow: THREE.Group;
  private readonly gantry: THREE.Group;
  private readonly finishG: THREE.Group;
  private readonly flagG: THREE.Group;
  private usedRing = false; private usedGantry = false; private usedFlag = false;

  constructor(scene: THREE.Scene) {
    const glow = (c: number, o: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(6.2, 0.45, 10, 48), glow(0xffc93a, 0.95));
    this.next = new THREE.Mesh(new THREE.TorusGeometry(5.0, 0.3, 8, 40), glow(0x39d0ff, 0.45));
    this.arrow = new THREE.Group();
    const head = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 4), glow(0xffe08a, 0.95));
    head.rotation.x = Math.PI / 2; head.position.z = 1.3;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 2.4), glow(0xffe08a, 0.85));
    shaft.position.z = -0.9;
    this.arrow.add(head, shaft);
    // A chequered banner on two posts.
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 32;
    const c2 = cv.getContext('2d') as CanvasRenderingContext2D;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { c2.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f0'; c2.fillRect(i * 16, j * 16, 16, 16); }
    const chq = new THREE.CanvasTexture(cv); chq.colorSpace = THREE.SRGBColorSpace;
    const banner = (w: number, tex: THREE.Texture | null, col: number): THREE.Group => {
      const gr = new THREE.Group();
      const postM = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 });
      for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 6.4, 8), postM); p.position.set(s * w / 2, 3.2, 0); gr.add(p); }
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.3), new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : col, side: THREE.DoubleSide, roughness: 0.8, emissive: tex ? 0x222222 : col, emissiveIntensity: tex ? 1 : 0.6 }));
      m.position.y = 5.8; gr.add(m);
      return gr;
    };
    this.gantry = banner(13, chq, 0xffffff);
    this.finishG = banner(13, chq, 0xffffff);
    this.flagG = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.7, roughness: 0.4 }));
    pole.position.y = 2.5;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.2), new THREE.MeshStandardMaterial({ map: chq, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(0.95, 4.3, 0);
    this.flagG.add(pole, flag);
    for (const o of [this.ring, this.next, this.arrow, this.gantry, this.finishG, this.flagG]) { o.visible = false; o.frustumCulled = false; scene.add(o); }
    this.ring.renderOrder = this.next.renderOrder = 5;
  }

  begin(): void { this.usedRing = this.usedGantry = this.usedFlag = false; }
  end(): void {
    if (!this.usedRing) { this.ring.visible = this.next.visible = this.arrow.visible = this.finishG.visible = false; }
    if (!this.usedGantry) this.gantry.visible = false;
    if (!this.usedFlag) this.flagG.visible = false;
  }

  /** The chequered flag beside a race marker (the nearest one only). */
  flag(at: Pt, toward: Pt, now: number): void {
    if (this.usedFlag) return;
    this.usedFlag = true;
    const h = Math.atan2(toward.x - at.x, toward.z - at.z);
    this.flagG.visible = true;
    this.flagG.position.set(at.x + Math.cos(h) * 8, groundAt(at.x, at.z), at.z - Math.sin(h) * 8);
    this.flagG.rotation.y = h + Math.sin(now / 400) * 0.15;
  }

  start(at: { x: number; z: number; h: number }, on: boolean): void {
    if (!on) return;
    this.usedGantry = true;
    this.gantry.visible = true;
    this.gantry.position.set(at.x, groundAt(at.x, at.z), at.z);
    this.gantry.rotation.y = at.h;
  }

  cp(c: Pt, from: Pt, n: Pt | null, last: boolean, now: number): void {
    this.usedRing = true;
    const y = groundAt(c.x, c.z), h = Math.atan2(c.x - from.x, c.z - from.z);
    this.ring.visible = !last;
    this.ring.position.set(c.x, y + 4.2 + Math.sin(now / 300) * 0.15, c.z);
    this.ring.rotation.set(0, h, 0);
    const pulse = 1 + Math.sin(now / 180) * 0.04;
    this.ring.scale.setScalar(pulse);
    this.finishG.visible = last;
    if (last) { this.finishG.position.set(c.x, y, c.z); this.finishG.rotation.y = h; }
    if (n) {
      const nh = Math.atan2(n.x - c.x, n.z - c.z);
      this.next.visible = true;
      this.next.position.set(n.x, groundAt(n.x, n.z) + 3.6, n.z);
      this.next.rotation.set(0, nh, 0);
      this.arrow.visible = true;
      this.arrow.position.set(c.x, y + 12 + Math.sin(now / 250) * 0.4, c.z);
      this.arrow.rotation.set(0, nh, 0);
    } else { this.next.visible = false; this.arrow.visible = false; }
  }
}

// ── On screen: the countdown lights, the live order, the podium ─────────────────

interface BoardRow { pos: number; of: number; name: string; gap: string; me: boolean; done: boolean; lap: number; laps: number; cp: number; cps: number; clock: string }
interface PodiumCard { title: string; rows: { name: string; place: number; total: number; best: number; how: number; cash: number; me: boolean }[]; notes: string[]; pay: number; solo: boolean; par: number }

const CSS = `
#rc-lights{position:fixed;left:50%;top:16%;transform:translateX(-50%);display:none;flex-direction:column;align-items:center;gap:8px;z-index:40;pointer-events:none;font-family:'Oswald','Arial Narrow',sans-serif}
#rc-lights .row{display:flex;gap:12px;background:rgba(12,14,18,.82);padding:10px 16px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.45)}
#rc-lights i{display:block;width:42px;height:42px;border-radius:50%;background:#2a1414;box-shadow:inset 0 0 8px #000}
#rc-lights i.r{background:radial-gradient(circle at 40% 35%,#ff8a7a,#e01b0c 60%,#7a0a04);box-shadow:0 0 18px #ff2a12}
#rc-lights i.g{background:radial-gradient(circle at 40% 35%,#b6ffad,#21d43a 60%,#0b6b18);box-shadow:0 0 18px #2bff4a}
#rc-lights b{font-size:44px;color:#fff;text-shadow:0 3px 10px rgba(0,0,0,.7);letter-spacing:2px}
#rc-board{position:fixed;left:14px;top:84px;min-width:220px;max-width:300px;background:rgba(12,14,18,.78);color:#eee;border-radius:10px;padding:8px 10px;z-index:30;pointer-events:none;font:13px/1.35 'Inter',system-ui,sans-serif;display:none;box-shadow:0 4px 16px rgba(0,0,0,.35)}
#rc-board.tch{left:8px;top:42vh;min-width:140px;max-width:180px}
#rc-board .top{display:flex;justify-content:space-between;font:600 15px 'Oswald','Arial Narrow',sans-serif;letter-spacing:1px;color:#ffd166;margin-bottom:4px}
#rc-board .top .pos{font-size:26px;color:#fff}
#rc-board .ln{display:flex;justify-content:space-between;gap:8px;padding:1px 0;white-space:nowrap}
#rc-board .ln span:first-child{overflow:hidden;text-overflow:ellipsis}
#rc-board .ln.me{color:#7fd8ff;font-weight:600}
#rc-board .ln.done{color:#9be89b}
#rc-pod{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));background:linear-gradient(180deg,#1b1f27,#101318);color:#eee;border-radius:14px;padding:0 0 12px;z-index:45;display:none;box-shadow:0 12px 40px rgba(0,0,0,.6);font:14px/1.4 'Inter',system-ui,sans-serif;overflow:hidden}
#rc-pod .chq{height:14px;background:repeating-conic-gradient(#111 0 25%,#f2f2ee 0 50%) 0 0/14px 14px}
#rc-pod h2{margin:10px 16px 2px;font:600 22px 'Oswald','Arial Narrow',sans-serif;letter-spacing:1px;color:#ffd166}
#rc-pod .sub{margin:0 16px 8px;color:#aab}
#rc-pod table{width:calc(100% - 24px);margin:0 12px;border-collapse:collapse}
#rc-pod td{padding:5px 4px;border-top:1px solid rgba(255,255,255,.08);white-space:nowrap}
#rc-pod td.n{overflow:hidden;text-overflow:ellipsis;max-width:150px}
#rc-pod tr.me td{color:#7fd8ff;font-weight:600}
#rc-pod .p1{color:#ffd700}#rc-pod .p2{color:#d0d6dc}#rc-pod .p3{color:#d08a4a}
#rc-pod .note{margin:8px 16px 0;color:#ffd166;font-weight:600}
#rc-pod .foot{margin:8px 16px 0;color:#889;font-size:12px}
@media (max-width:700px),(max-height:450px){#rc-board{top:58px;left:8px;min-width:140px;max-width:180px;font-size:11px;padding:6px 8px}#rc-board .top .pos{font-size:20px}#rc-lights i{width:28px;height:28px}#rc-lights b{font-size:30px}#rc-lights{top:12%}}
`;

class RaceUi {
  private readonly lightsEl: HTMLDivElement;
  private readonly boardEl: HTMLDivElement;
  private readonly podEl: HTMLDivElement;
  private boardHtml = '';

  constructor() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const mk = (id: string): HTMLDivElement => { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); return d; };
    this.lightsEl = mk('rc-lights'); this.boardEl = mk('rc-board'); this.podEl = mk('rc-pod');
  }

  /** n: red lights lit (0..3), 4: all green; -1 hides. */
  lights(n: number, word: string): void {
    const e = this.lightsEl;
    if (n < 0) { e.style.display = 'none'; return; }
    e.style.display = 'flex';
    const c = (k: number): string => n >= 4 ? 'g' : k < n ? 'r' : '';
    e.innerHTML = `<div class="row"><i class="${c(0)}"></i><i class="${c(1)}"></i><i class="${c(2)}"></i></div><b>${word}</b>`;
  }

  panel(rows: BoardRow[] | null): void {
    const e = this.boardEl;
    if (!rows || !rows.length) { if (this.boardHtml) { e.style.display = 'none'; this.boardHtml = ''; } return; }
    const me = rows.find((r) => r.me) ?? rows[0];
    const esc = (s: string): string => s.replace(/[&<>]/g, (ch) => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;');
    const html = `<div class="top"><span class="pos">${me.of > 1 ? `${ord(me.pos)}<small>/${me.of}</small>` : me.clock}</span><span>${me.laps > 1 ? `LAP ${me.lap}/${me.laps}<br>` : ''}CP ${Math.min(me.cp, me.cps)}/${me.cps}</span></div>`
      + (me.of > 1 ? rows.map((r) => `<div class="ln${r.me ? ' me' : ''}${r.done ? ' done' : ''}"><span>${r.pos}. ${esc(r.name)}</span><span>${esc(r.gap)}</span></div>`).join('') : '');
    if (html === this.boardHtml) return;
    this.boardHtml = html; e.innerHTML = html; e.style.display = 'block';
    // (On a touch layout the radar has the top left corner: the order goes under it, above the stick.)
    e.classList.toggle('tch', !!document.getElementById('touch')?.classList.contains('show'));
  }

  podium(c: PodiumCard | null): void {
    const e = this.podEl;
    if (!c) { e.style.display = 'none'; return; }
    const esc = (s: string): string => s.replace(/[&<>]/g, (ch) => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;');
    const rows = c.rows.map((r) => `<tr class="${r.me ? 'me' : ''}"><td class="p${r.place}">${r.how === 1 ? ord(r.place) : 'DNF'}</td><td class="n">${esc(r.name)}${r.me ? ' (you)' : ''}</td><td>${r.how === 1 ? fmt(r.total) : 'out'}</td><td>${r.best ? 'lap ' + fmt(r.best) : ''}</td><td>${r.cash ? money(r.cash) : ''}</td></tr>`).join('');
    e.innerHTML = `<div class="chq"></div><h2>${c.solo ? 'TIME TRIAL' : 'RACE RESULTS'}</h2><div class="sub">${esc(c.title)} · par ${fmt(c.par)}</div><table>${rows}</table>`
      + c.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')
      + `<div class="foot">${c.pay ? `You were paid ${money(c.pay)}. ` : ''}G to close.</div>`;
    e.style.display = 'block';
  }
}
