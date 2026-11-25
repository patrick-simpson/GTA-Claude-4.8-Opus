// Fun queue 2, item 23: co-op missions for 2 to 4 players in the same town, for one shared payout.
//
// Three jobs, each posted at its own dispatch lot (a teal C on the radar, a teal ring in the street). Stand there (not in
// the middle of a mission or a job of your own) and press G:
//  - alone in town (or offline): a toast, it needs two or more players;
//  - with others in town: a CALL. Everybody else gets a toast and a C on the radar for JOIN_S seconds; whoever gets to the
//    lot joins (up to four in all). G again starts at once, or the window runs out.
//    1  TWO-TRUCK HAUL   every player is handed a van or a pickup at the lot; all of them must reach the drop-off ring in
//                         a vehicle before the clock runs out. Stay together: while the trucks still on the road are
//                         strung out more than GAP_M apart the clock runs faster.
//    2  THE DRIVE-UP JOB  roles by the order of the crew: the CALLER drives the getaway car, everybody else is a
//                         safecracker. The crackers work the vault on foot at the marked spot while the driver sits in a
//                         car close by; the bar fills faster with more crackers. Then the getaway: the driver takes the
//                         car to the hideout with every cracker close aboard (or right alongside).
//    3  LIGHT UP THE STAND  at Flounder Field's derby bowl: one floodlight switch plate for every player, all of them held
//                         at once for a few seconds, three rounds, the plates moving out each round.
// ONE AUTHORITY. The caller's browser judges the mission from where it already sees everybody (their ordinary State
// frames, as the story crews of net/crew.ts are judged) and tells the others what it sees (Show): the stage, the bar, the
// clock, who is where they should be. Every browser words the objective and draws the markers from its own copy of the
// list below, so no text travels. A player who leaves is gone from the next Show; fewer than two left sets the mission
// aside; the caller leaving sets it aside for everybody (no pay).
// THE PAY is shared: every player on the crew when it is passed gets the same, `pay()` (a base for the job, +25% for each
// player over two, +25% for a quick job, tapered like every other job) and one more on their "coop" count. Money is
// trusted from the caller's End frame like the story crews' (clients are trusted, multiplayer.md). Kid mode needs nothing.
// Nothing is saved but the money and the count; no town fact key, no board row.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { VehicleKind } from '../ent/vehicleSpecs';
import type { Blip } from '../ui/hud';
import { DERBY } from '../world/places';
import { save } from './save';
import { taper } from './activities';
import { clock, type Markers, type Pt } from './script';

export const JOIN_S = 30;
const AT_M = 12, JOIN_M = 30, LEAVE_M = 120;
export const GAP_M = 170;
const ARRIVE_M = 20, SAFE_M = 5, SAFE_DRIVER_M = 38, HIDE_M = 24, ABOARD_M = 16, PLATE_M = 3.4;
export const CRACK_S = 24, HOLD_S = 8;
/** In a Show's flags: bit k is crew member k where they should be; this one says the haul is strung out. */
const APART_BIT = 0x100;
const SILENCE_MS = 12000;
const SEND_GAP_MS = 250, SEND_EVERY_MS = 1000;

export interface CoopWire { kind: number; caller: number; mission: number; a: number; b: number; c: number; ms: number; ids: number[] }
export interface CoopLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): Pt | null;
  vehicleOf(id: number): Vehicle | null;
  send(m: CoopWire): void;
}
export const CK = { Call: 1, Join: 2, Go: 3, Show: 4, End: 5, Off: 6 } as const;
const HOW = { Passed: 1, Failed: 2, Aside: 3 } as const;

interface Def {
  id: number; name: string; short: string; limit: number; base: number;
  /** The reasons a mission fails or is set aside; the End frame sends an index. */
  why: string[];
  blurb: string;
}
/** Append only: a mission's number travels in the frames. */
export const MISSIONS: Def[] = [
  { id: 1, name: 'Two-Truck Haul', short: 'HAUL', limit: 240, base: 700, blurb: 'every player takes a truck to the drop-off, together',
    why: ['The convoy never got there in time.', 'The crew fell below two players.', 'The caller left town.'] },
  { id: 2, name: 'The Drive-Up Job', short: 'DRIVE-UP JOB', limit: 300, base: 1100, blurb: 'one drives the getaway, the rest crack the vault',
    why: ['The clock beat the crew.', 'The crew fell below two players.', 'The caller left town.'] },
  { id: 3, name: 'Light Up the Stand', short: 'FLOODLIGHTS', limit: 200, base: 600, blurb: 'a switch plate each, held all at once',
    why: ['The stand stayed dark.', 'The crew fell below two players.', 'The caller left town.'] },
];
const ROUNDS = 3;
const ROUND_K = [0.38, 0.62, 0.82];

type Phase = 'idle' | 'calling' | 'joined' | 'run' | 'card';
interface Site { x: number; z: number; h: number }
interface Geo { start: Site; dest?: Site; safe?: Site; hide?: Site }
interface Invite { caller: number; mission: number; until: number }
interface Row { id: number; name: string; role: string; me: boolean }

/** The pay each player gets for a passed job (also what the caller puts in the End frame). */
export function pay(mission: number, crew: number, quick: boolean, done: number): number {
  const d = MISSIONS[mission - 1];
  if (!d) return 0;
  const n = Math.max(2, Math.min(4, crew));
  return Math.round(d.base * (1 + 0.25 * (n - 2)) * (quick ? 1.25 : 1) * taper(done).cash / 10) * 10;
}

export class Coop {
  link: CoopLink | null = null;
  prompt: string | null = null;
  phase: Phase = 'idle';
  /** For the tests: the caller's time limit can be shortened (seconds). Sent in the Go frame. */
  testLimit = 0;
  readonly stats = { called: 0, joined: 0, started: 0, passed: 0, failed: 0, aside: 0, sent: 0, got: 0 };

  private mission = 0;
  private caller = 0;
  private ids: number[] = [];
  private until = 0;
  private limit = 0;
  private startAt = 0;
  // What the caller's browser judges, and what the others are told.
  private stage = 1; private prog = 0; private left = 0; private flags = 0;
  private gotShowAt = 0;
  private sentKey = ''; private sentAt = 0;
  private arrived = new Set<number>();
  private apart = false;
  private cardUntil = 0;
  private lastRows: Row[] = [];
  private lastHow = 0; private lastWhy = ''; private lastPay = 0;
  private mine: Vehicle[] = [];
  private readonly invites = new Map<number, Invite>();
  private geoCache = new Map<number, Geo>();
  private uiAt = 0;
  private readonly ui = new CoopUi();

  constructor(private readonly game: Game, private readonly markers: Markers,
    private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  private get me(): number { return this.link ? this.link.me() : 0; }
  private nameOf(id: number): string { return this.link ? this.link.nameOf(id) : 'You'; }
  private get amCaller(): boolean { return this.caller !== 0 && this.caller === this.me; }
  private get running(): boolean { return this.phase === 'run'; }
  private def(): Def { return MISSIONS[this.mission - 1] ?? MISSIONS[0]; }
  private send(m: Partial<CoopWire> & { kind: number }): void {
    if (!this.link) return;
    this.link.send({ caller: this.caller, mission: this.mission, a: 0, b: 0, c: 0, ms: 0, ids: [], ...m });
    this.stats.sent++;
  }

  /** The nearest curb-side spot of the town's parking to a hint (a flat, open place a car can stand). */
  private spot(x: number, z: number): Site {
    let best: Site = { x, z, h: 0 }, bd = Infinity;
    for (const s of this.game.plan.parking) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = { x: s.x, z: s.z, h: s.h }; } }
    return best;
  }

  /** The places of each job, worked out once. */
  geo(mission: number): Geo {
    let g = this.geoCache.get(mission);
    if (g) return g;
    const sp = (x: number, z: number): Site => this.spot(x, z);
    if (mission === 1) g = { start: sp(49, 76), dest: sp(-300, -320) };
    else if (mission === 2) g = { start: sp(140, 150), safe: sp(300, 190), hide: sp(-120, 330) };
    else g = { start: sp(DERBY.gateX, DERBY.gateZ) };
    this.geoCache.set(mission, g);
    return g;
  }

  /** The switch plates of a round (the stand's bowl): one per player, round the middle. */
  plates(round: number, n: number): Pt[] {
    const k = ROUND_K[Math.max(0, Math.min(ROUNDS - 1, round - 1))];
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (round - 1) * 0.5;
      out.push({ x: DERBY.x + Math.cos(a) * DERBY.a * k, z: DERBY.z + Math.sin(a) * DERBY.b * k });
    }
    return out;
  }

  private place(id: number): { x: number; z: number; car: boolean } | null {
    if (id === this.me) { const p = this.game.player, v = p.vehicle; return v ? { x: v.x, z: v.z, car: true } : { x: p.x, z: p.z, car: false }; }
    const at = this.link?.posOf(id);
    return at ? { x: at.x, z: at.z, car: !!this.link?.vehicleOf(id) } : null;
  }

  private roleOf(i: number): string {
    if (this.mission === 2) return i === 0 ? 'DRIVER' : 'CRACKER';
    return this.mission === 1 ? `TRUCK ${i + 1}` : `PLATE ${i + 1}`;
  }

  // ── Starting ───────────────────────────────────────────────────────────────

  private offer(): void {
    const g = this.game, p = g.player, now = performance.now();
    for (const [id, inv] of this.invites) {
      if (now > inv.until) { this.invites.delete(id); continue; }
      const s = this.geo(inv.mission).start;
      this.markers.put(s.x, s.z, 'goal', 9, 60);
      if (Math.hypot(p.x - s.x, p.z - s.z) < JOIN_M && this.isFree() && p.health > 0) { this.join(inv); return; }
    }
    let at = 0;
    for (const d of MISSIONS) {
      const s = this.geo(d.id).start, dist = Math.hypot(p.x - s.x, p.z - s.z);
      if (dist > 300) continue;
      this.markers.put(s.x, s.z, 'job', 7, 22);
      if (dist < AT_M && p.speed < 4 && this.isFree()) at = d.id;
    }
    if (!at) return;
    const d = MISSIONS[at - 1], many = this.link ? this.link.others().length : 0;
    this.prompt = many ? `[G] Call the co-op job "${d.name}": ${d.blurb} (2-4 players, ${many} other${many > 1 ? 's' : ''} in town)` : `[G] Co-op job "${d.name}" (needs 2+ players)`;
    if (!g.input.eat('interact')) return;
    if (!many) { g.hud.toast(`${d.name} needs two or more players in town: ${d.blurb}. Come back with friends.`, 6); return; }
    this.call(at);
  }

  call(mission: number): void {
    this.mission = mission; this.caller = this.me;
    this.ids = [this.me]; this.invites.clear();
    this.setBusy('coop');
    this.stats.called++;
    this.phase = 'calling';
    this.until = performance.now() + JOIN_S * 1000;
    this.sendCall();
    this.game.hud.stamp(this.def().short, `${this.def().name} · everybody in town has ${JOIN_S} s to get to the lot · G to start now`);
  }

  private sendCall(): void {
    if (this.phase !== 'calling') return;
    this.send({ kind: CK.Call, a: Math.max(1, (this.until - performance.now()) / 1000), ids: this.ids });
  }

  private join(inv: Invite): void {
    this.invites.clear();
    this.mission = inv.mission; this.caller = inv.caller; this.ids = [];
    this.until = inv.until;
    this.phase = 'joined';
    this.setBusy('coop');
    this.stats.joined++;
    this.send({ kind: CK.Join, a: 1 });
    this.game.hud.stamp('YOU ARE IN', `${this.nameOf(inv.caller)}'s ${this.def().name} · wait at the lot for the start`);
  }

  /** The crew is in: the Go frame's. Everybody gets their vehicle and the mission begins. */
  private start(ids: number[], limit: number): void {
    const g = this.game, p = g.player, now = performance.now();
    this.ids = ids.slice(0, 4); this.limit = limit;
    this.startAt = now; this.left = limit; this.stage = 1; this.prog = 0; this.flags = 0; this.apart = false;
    this.arrived.clear(); this.sentKey = ''; this.sentAt = 0; this.gotShowAt = now;
    this.phase = 'run';
    this.stats.started++;
    const geo = this.geo(this.mission), i = Math.max(0, this.ids.indexOf(this.me)), d = this.def();
    if (this.mission !== 3) {
      const kind: VehicleKind = this.mission === 1 ? (i % 2 ? 'pickup' : 'van') : i === 0 ? 'muscle' : 'sedan';
      const s = geo.start, fx = Math.sin(s.h), fz = Math.cos(s.h), back = 7 * i;
      if (p.vehicle) p.exit(true);
      const v = g.vehicles.spawn(kind, s.x - fx * back, s.z - fz * back, s.h);
      this.mine.push(v);
      p.enter(v, true);
      g.cam.snap();
    }
    else {
      // The stand's bowl is walled in (the derby's cars are set down inside): everybody is stood on the dirt, a few steps apart.
      if (p.vehicle) p.exit(true);
      p.teleport(DERBY.x + (i - (this.ids.length - 1) / 2) * 3.5, DERBY.z + 6, 0);
      g.cam.snap();
    }
    const how = this.mission === 1 ? `Get your truck to the drop-off, together. ${clock(limit)} on the clock.`
      : this.mission === 2 ? (i === 0 ? 'YOU DRIVE. Wait by the vault for the crackers, then get them out.' : 'YOU CRACK. On foot, at the vault, while the driver waits.')
        : `Everybody on a switch plate and hold. ${clock(limit)} on the clock.`;
    g.hud.stamp(d.short, how);
  }

  // ── The network's ──────────────────────────────────────────────────────────

  got(from: number, m: CoopWire): void {
    this.stats.got++;
    const now = performance.now();
    if (m.kind === CK.Call) {
      if (from !== m.caller || m.mission < 1 || m.mission > MISSIONS.length) return;
      if (this.phase === 'joined' && this.caller === m.caller) { this.until = now + m.a * 1000; return; }
      if (this.phase !== 'idle') return;
      const old = this.invites.get(m.caller);
      this.invites.set(m.caller, { caller: m.caller, mission: m.mission, until: now + m.a * 1000 });
      if (!old) this.game.hud.toast(`${this.nameOf(m.caller)} called a co-op job: ${MISSIONS[m.mission - 1].name}. Get to the C on the radar within ${Math.round(m.a)} s to join.`, 8);
      return;
    }
    if (m.kind === CK.Off) {
      this.invites.delete(m.caller);
      if (this.phase === 'joined' && this.caller === m.caller) { this.end(); this.game.hud.toast(`${this.nameOf(m.caller)} called the job off.`, 5); }
      return;
    }
    if (m.kind === CK.Join) {
      if (this.phase !== 'calling' || m.caller !== this.me) return;
      if (m.a && !this.ids.includes(from)) {
        if (this.ids.length >= 4) return;
        this.ids.push(from); this.game.hud.toast(`${this.nameOf(from)} is in.`, 3);
      } else if (!m.a) this.ids = this.ids.filter((x) => x !== from);
      this.sendCall();
      return;
    }
    if (m.kind === CK.Go) {
      if (this.phase !== 'joined' || m.caller !== this.caller) return;
      if (!m.ids.includes(this.me)) { this.end(); this.game.hud.toast('The crew was full before you got there.', 5); return; }
      this.mission = m.mission;
      this.start(m.ids, m.c);
      return;
    }
    if (!this.running || m.caller !== this.caller || from !== this.caller) return;
    if (m.kind === CK.Show) {
      this.gotShowAt = now;
      this.stage = m.a; this.prog = m.b / 255; this.left = m.c; this.flags = m.ms; this.apart = (m.ms & APART_BIT) !== 0;
      if (m.ids.length) this.ids = m.ids;
      if (!this.ids.includes(this.me)) { this.finish(HOW.Aside, 1, 0); this.game.hud.toast('You are out of the job.', 4); }
    } else if (m.kind === CK.End) this.finish(m.a, m.b, m.c, (m.ms & 1) === 1);
  }

  dropped(id: number): void {
    this.invites.delete(id);
    if ((this.phase === 'joined' || this.running) && this.caller === id && !this.amCaller) {
      if (this.running) this.finish(HOW.Aside, 2, 0); else this.end();
      this.game.hud.toast('The caller left town. The job is off.', 5);
      return;
    }
    if (this.phase === 'calling') { this.ids = this.ids.filter((x) => x !== id); this.sendCall(); return; }
    if (this.running && this.amCaller && this.ids.includes(id)) {
      this.ids = this.ids.filter((x) => x !== id);
      this.arrived.delete(id);
      if (this.ids.length < 2) this.conclude(HOW.Aside, 1);
      else { this.game.hud.toast(`${this.nameOf(id)} left the job. ${this.ids.length} still on it.`, 4); this.sentKey = ''; }
    }
  }

  offline(): void {
    this.invites.clear();
    if (this.phase === 'calling' || this.phase === 'joined') this.end();
    else if (this.running) this.finish(HOW.Aside, 2, 0);
  }

  announce(): void { this.sendCall(); }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    const now = performance.now(), g = this.game, p = g.player;
    this.prompt = null;
    if (this.phase === 'idle') {
      if (this.isFree() || this.invites.size) this.offer();
      this.ui.bar(null);
      return;
    }
    if (this.phase === 'card') {
      this.ui.bar(null);
      if (now > this.cardUntil || g.input.eat('interact')) this.closeCard();
      return;
    }
    if (this.phase === 'calling') {
      const s = this.geo(this.mission).start, left = Math.max(0, (this.until - now) / 1000), n = this.ids.length;
      this.markers.put(s.x, s.z, 'goal', 9, 60);
      this.prompt = `[G] Start now · ${n - 1} joined · ${Math.ceil(left)} s`;
      g.hud.objective(`${this.def().name} called. Waiting for others (${Math.ceil(left)} s).`);
      if (!(p.health > 0) || Math.hypot(p.x - s.x, p.z - s.z) > LEAVE_M) {
        this.send({ kind: CK.Off }); this.end(); g.hud.toast('Co-op job called off.', 4); return;
      }
      if (g.input.eat('interact') || left <= 0) {
        if (this.ids.length < 2) { this.send({ kind: CK.Off }); this.end(); g.hud.toast('Nobody came: a co-op job needs two or more players.', 5); return; }
        const limit = this.testLimit || this.def().limit;
        this.send({ kind: CK.Go, c: limit, ids: this.ids });
        this.start(this.ids, limit);
      }
      return;
    }
    if (this.phase === 'joined') {
      const s = this.geo(this.mission).start, left = Math.max(0, (this.until - now) / 1000);
      this.markers.put(s.x, s.z, 'goal', 9, 60);
      g.hud.objective(`In ${this.nameOf(this.caller)}'s ${this.def().name}. It starts in ${Math.ceil(left)} s.`);
      if (Math.hypot(p.x - s.x, p.z - s.z) > LEAVE_M || !(p.health > 0)) { this.send({ kind: CK.Join, a: 0 }); this.end(); g.hud.toast('You left before the start.', 4); return; }
      if (now > this.until + 10000) { this.end(); g.hud.toast('The co-op job never started.', 4); }
      return;
    }
    this.tick(dt, now);
  }

  private tick(dt: number, now: number): void {
    const g = this.game;
    if (this.amCaller) this.judge(dt, now);
    else {
      // The others count the clock down between Shows; a caller who has gone silent ends it.
      this.left = Math.max(0, this.left - dt);
      if (now - this.gotShowAt > SILENCE_MS) { this.finish(HOW.Aside, 2, 0); g.hud.toast('The caller went quiet. The job is off.', 5); return; }
    }
    if (!this.running) return;
    this.draw();
    if (now - this.uiAt > 100) {
      this.uiAt = now;
      this.ui.bar({ text: this.barText(), k: this.prog });
    }
    g.hud.objective(this.objective());
    g.hud.timer('Time', clock(this.left), this.left < 25);
  }

  /** The caller's judgement: where everybody is against what the job asks. */
  private judge(dt: number, now: number): void {
    const n = this.ids.length, pl = this.ids.map((id) => ({ id, at: this.place(id) }));
    let flags = 0;
    this.apart = false;
    let drain = 1;
    if (this.mission === 1) {
      const d = this.geo(1).dest as Site;
      pl.forEach((q, k) => {
        if (!q.at) return;
        if (q.at.car && Math.hypot(q.at.x - d.x, q.at.z - d.z) < ARRIVE_M) this.arrived.add(q.id);
        if (this.arrived.has(q.id)) flags |= 1 << k;
      });
      const rest = pl.filter((q) => q.at && !this.arrived.has(q.id));
      let far = 0;
      for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) far = Math.max(far, Math.hypot((rest[i].at as Pt).x - (rest[j].at as Pt).x, (rest[i].at as Pt).z - (rest[j].at as Pt).z));
      if (far > GAP_M) { this.apart = true; drain = 2.2; flags |= APART_BIT; }
      this.prog = this.arrived.size / n;
      this.stage = 1;
      if (this.arrived.size >= n) { this.conclude(HOW.Passed, 0); return; }
    } else if (this.mission === 2) {
      const geo = this.geo(2), safe = geo.safe as Site, hide = geo.hide as Site;
      const drv = pl[0].at;
      if (this.stage === 1) {
        const driverOk = !!drv && drv.car && Math.hypot(drv.x - safe.x, drv.z - safe.z) < SAFE_DRIVER_M;
        if (driverOk) flags |= 1;
        let present = 0;
        pl.forEach((q, k) => { if (k > 0 && q.at && !q.at.car && Math.hypot(q.at.x - safe.x, q.at.z - safe.z) < SAFE_M) { present++; flags |= 1 << k; } });
        const crackers = Math.max(1, n - 1);
        if (driverOk && present > 0) this.prog = Math.min(1, this.prog + dt / CRACK_S * (present / crackers) * (1 + 0.15 * (crackers - 1)));
        else this.prog = Math.max(0, this.prog - dt / CRACK_S * 0.4);
        if (this.prog >= 1) { this.stage = 2; this.prog = 0; this.game.hud.stamp('VAULT OPEN', 'Everybody out: the getaway'); }
      } else {
        const inRing = !!drv && drv.car && Math.hypot(drv.x - hide.x, drv.z - hide.z) < HIDE_M;
        let aboard = 0;
        pl.forEach((q, k) => { if (k > 0 && q.at && drv && Math.hypot(q.at.x - drv.x, q.at.z - drv.z) < ABOARD_M) { aboard++; flags |= 1 << k; } });
        if (inRing) flags |= 1;
        this.prog = drv ? Math.max(0, Math.min(1, 1 - Math.hypot(drv.x - hide.x, drv.z - hide.z) / Math.max(60, Math.hypot(safe.x - hide.x, safe.z - hide.z)))) : 0;
        if (inRing && aboard >= n - 1) { this.conclude(HOW.Passed, 0); return; }
      }
    } else {
      const ps = this.plates(this.stage, n);
      let held = 0;
      const used = new Set<number>();
      for (const pt of ps) {
        const k = pl.findIndex((q, idx) => !used.has(idx) && !!q.at && Math.hypot(q.at.x - pt.x, q.at.z - pt.z) < PLATE_M);
        if (k >= 0) { used.add(k); held++; flags |= 1 << k; }
      }
      if (held >= n) this.prog = Math.min(1, this.prog + dt / HOLD_S);
      else this.prog = Math.max(0, this.prog - dt / 3);
      if (this.prog >= 1) {
        if (this.stage >= ROUNDS) { this.conclude(HOW.Passed, 0); return; }
        this.stage++; this.prog = 0;
        this.game.hud.stamp(`LIGHTS ${this.stage - 1} OF ${ROUNDS}`, 'The plates moved. Everybody to a new one.');
      }
    }
    this.flags = flags;
    this.left = Math.max(0, this.left - dt * drain);
    if (this.left <= 0) { this.conclude(HOW.Failed, 0); return; }
    // Say it (when it changes, and about once a second).
    const key = `${this.stage}.${Math.round(this.prog * 100)}.${flags}.${this.ids.join(',')}`;
    if ((key !== this.sentKey && now - this.sentAt > SEND_GAP_MS) || now - this.sentAt > SEND_EVERY_MS) {
      this.sentKey = key; this.sentAt = now;
      this.send({ kind: CK.Show, a: this.stage, b: this.prog * 255, c: Math.ceil(this.left), ms: flags, ids: this.ids });
    }
  }

  /** The caller: it is over. Tell everybody, then this screen. */
  private conclude(how: number, why: number): void {
    const took = performance.now() - this.startAt;
    const quick = how === HOW.Passed && took < this.limit * 600;
    const cash = how === HOW.Passed ? pay(this.mission, this.ids.length, quick, save.count('coop')) : 0;
    this.send({ kind: CK.End, a: how, b: why, c: cash, ms: (Math.round(took) & ~1) | (quick ? 1 : 0), ids: this.ids });
    this.finish(how, why, cash, quick);
  }

  /** Every screen: the card, and the money. */
  private finish(how: number, why: number, cash: number, quick = false): void {
    if (!this.running) return;
    const g = this.game, d = this.def();
    const rows: Row[] = this.ids.map((id, i) => ({ id, name: this.nameOf(id), role: this.roleOf(i), me: id === this.me }));
    this.lastRows = rows; this.lastHow = how; this.lastPay = 0;
    this.lastWhy = how === HOW.Passed ? (quick ? 'A quick job: bonus paid.' : 'Job done.') : (d.why[why] ?? d.why[0]);
    if (how === HOW.Passed) {
      const c = Math.max(0, Math.min(5000, Math.round(cash)));
      this.lastPay = c;
      if (c > 0) { g.player.money += c; save.credit(c); save.data.stats.earned += c; }
      save.bump('coop'); save.bump(`coop.${this.mission}`);
      g.emit('moment', { kind: 'coop' });
      this.stats.passed++;
    } else if (how === HOW.Failed) this.stats.failed++;
    else this.stats.aside++;
    this.ui.bar(null);
    this.ui.card({ title: d.name.toUpperCase(), head: how === HOW.Passed ? 'JOB DONE' : how === HOW.Failed ? 'JOB FAILED' : 'JOB OFF', rows, note: this.lastWhy, pay: this.lastPay });
    this.phase = 'card';
    this.cardUntil = performance.now() + 14000;
    g.hud.objective(null); g.hud.timer(null);
    this.setBusy(null);
  }

  /** Back out of the bowl, to the gate, when a floodlights job ends. */
  private outOfBowl(): void {
    const p = this.game.player;
    if (Math.hypot(p.x - DERBY.x, p.z - DERBY.z) < 50) p.teleport(DERBY.gateX - 4, DERBY.gateZ, -Math.PI / 2);
  }

  private closeCard(): void {
    this.ui.card(null);
    this.phase = 'idle';
    this.outOfBowl();
    // The trucks and cars of the job go back to the town unless the player is still in one.
    const p = this.game.player;
    for (const v of this.mine) if (p.vehicle !== v && !v.removed) this.game.vehicles.remove(v);
    this.mine.length = 0;
    this.ids = []; this.caller = 0; this.mission = 0;
  }

  private end(): void {
    const was = this.phase;
    this.phase = 'idle'; this.ids = []; this.caller = 0; this.mission = 0;
    this.outOfBowl();
    this.ui.bar(null);
    this.game.hud.objective(null); this.game.hud.timer(null);
    if (was !== 'idle' && was !== 'card') this.setBusy(null);
  }

  // ── What the player sees ───────────────────────────────────────────────────

  /** Where the job wants everybody now (one point each for the plates). */
  targets(): Pt[] {
    if (!this.running) return [];
    const geo = this.geo(this.mission);
    if (this.mission === 1) return geo.dest ? [geo.dest] : [];
    if (this.mission === 2) return this.stage === 1 ? [geo.safe as Site] : [geo.hide as Site];
    return this.plates(this.stage, this.ids.length);
  }

  private draw(): void {
    const r = this.mission === 3 ? PLATE_M + 1.2 : this.mission === 2 && this.stage === 1 ? 6 : 12;
    for (const s of this.targets()) this.markers.put(s.x, s.z, this.mission === 3 ? 'job' : 'goal', r, this.mission === 3 ? 30 : 60);
  }

  private objective(): string {
    const i = this.ids.indexOf(this.me), n = this.ids.length, ok = (this.flags >> Math.max(0, i)) & 1;
    if (this.mission === 1) {
      const done = (this.flags & 15).toString(2).split('1').length - 1;
      return `${done} of ${n} trucks at the drop-off. ${ok ? 'You are there: wait for the rest.' : 'Get your truck to the ring.'}${this.apart ? ' STAY TOGETHER: the clock is running fast.' : ''}`;
    }
    if (this.mission === 2) {
      if (this.stage === 1) return i === 0 ? `You are the driver: park close to the vault${ok ? ' (good)' : ''} and keep the engine on.` : `You are a cracker: on foot at the vault, while the driver is close${ok ? ' (cracking)' : ''}.`;
      return i === 0 ? 'GETAWAY: take the car to the hideout, the crackers close behind or aboard.' : 'GETAWAY: get in or stay right by the driver!';
    }
    return `Lights ${this.stage} of ${ROUNDS}: ${ok ? 'you are on a plate. Hold!' : 'get on a free plate.'} Everybody at once.`;
  }

  private barText(): string {
    const pct = Math.round(this.prog * 100);
    if (this.mission === 1) return `CONVOY ${Math.round(this.prog * this.ids.length)} / ${this.ids.length} ARRIVED`;
    if (this.mission === 2) return this.stage === 1 ? `CRACKING THE VAULT ${pct}%` : `GETAWAY ${pct}%`;
    return `FLOODLIGHTS ${this.stage}/${ROUNDS} · HOLD ${pct}%`;
  }

  blips(out: Blip[]): void {
    const p = this.game.player;
    for (const inv of this.invites.values()) { const s = this.geo(inv.mission).start; out.push({ x: s.x, z: s.z, kind: 'goal', label: 'C' }); }
    if (this.phase === 'calling' || this.phase === 'joined') { const s = this.geo(this.mission).start; out.push({ x: s.x, z: s.z, kind: 'goal', label: 'C' }); return; }
    if (this.running) {
      for (const s of this.targets()) out.push({ x: s.x, z: s.z, kind: 'goal', label: 'C' });
      return;
    }
    if (this.phase !== 'idle' || !this.isFree()) return;
    for (const d of MISSIONS) { const s = this.geo(d.id).start; if (Math.hypot(s.x - p.x, s.z - p.z) < 900) out.push({ x: s.x, z: s.z, kind: 'job', label: 'C' }); }
  }

  /** For the tests (window.__game.game.todo.coop.info()). */
  info(): Record<string, unknown> {
    return {
      ...this.stats, phase: this.phase, mission: this.mission, caller: this.caller, ids: [...this.ids], stage: this.stage,
      prog: +this.prog.toFixed(3), left: Math.round(this.left), flags: this.flags, apart: this.apart, arrived: [...this.arrived],
      invites: [...this.invites.values()].map((i) => ({ caller: i.caller, mission: i.mission })),
      result: { how: this.lastHow, why: this.lastWhy, pay: this.lastPay, rows: this.lastRows.map((r) => ({ id: r.id, role: r.role })) },
      cars: this.mine.map((v) => v.spec.kind),
      geo: MISSIONS.map((d) => { const g = this.geo(d.id); return { id: d.id, start: g.start, dest: g.dest, safe: g.safe, hide: g.hide }; }),
      plates: this.running && this.mission === 3 ? this.plates(this.stage, this.ids.length) : [],
    };
  }
}

// ── The page's own bits: the progress bar and the result card ────────────────────

const CSS = `
#co-bar{position:fixed;left:50%;top:18%;transform:translateX(-50%);width:min(380px,76vw);padding:8px 12px 10px;background:rgba(20,33,61,.86);color:#f2e8cf;font:800 15px/1.2 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.06em;text-align:center;border:2px solid #2a9d8f;border-radius:4px;z-index:40;pointer-events:none;display:none}
#co-bar i{display:block;height:12px;margin-top:6px;background:rgba(242,232,207,.2);border-radius:2px;overflow:hidden}
#co-bar b{display:block;height:100%;width:0;background:linear-gradient(90deg,#2a9d8f,#f0a202)}
#co-card{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,92vw);max-height:84vh;overflow:auto;padding:14px 18px;background:#f2e8cf;color:#14213d;font:600 14px/1.35 system-ui,sans-serif;border:3px solid #14213d;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.45);z-index:50;display:none}
#co-card h2{margin:0 0 4px;font:900 26px/1 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.05em}
#co-card h3{margin:0 0 8px;font:800 14px/1 system-ui,sans-serif;letter-spacing:.08em;opacity:.7}
#co-card table{width:100%;border-collapse:collapse}#co-card td{padding:3px 4px;border-top:1px solid rgba(20,33,61,.2)}
#co-card tr.me td{font-weight:800}#co-card .n{color:#9a3412;font-weight:700;margin-top:6px}#co-card .f{margin-top:8px;font-size:12px;opacity:.7}
`;

class CoopUi {
  private readonly barEl: HTMLDivElement;
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly cardEl: HTMLDivElement;
  private barKey = '';

  constructor() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.barEl = document.body.appendChild(document.createElement('div')); this.barEl.id = 'co-bar';
    this.label = this.barEl.appendChild(document.createElement('span'));
    this.fill = this.barEl.appendChild(document.createElement('i')).appendChild(document.createElement('b'));
    this.cardEl = document.body.appendChild(document.createElement('div')); this.cardEl.id = 'co-card';
  }

  bar(b: { text: string; k: number } | null): void {
    const key = b ? `${b.text}${Math.round(b.k * 100)}` : '';
    if (key === this.barKey) return;
    this.barKey = key;
    if (!b) { this.barEl.style.display = 'none'; return; }
    this.barEl.style.display = 'block';
    this.label.textContent = b.text;
    this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, b.k)) * 100)}%`;
  }

  card(c: { title: string; head: string; rows: Row[]; note: string; pay: number } | null): void {
    if (!c) { this.cardEl.style.display = 'none'; return; }
    const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
    this.cardEl.innerHTML = `<h2>${esc(c.head)}</h2><h3>${esc(c.title)} · CO-OP</h3><table>${c.rows.map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.role)}</td><td>${esc(r.name)}${r.me ? ' (you)' : ''}</td><td>${c.pay > 0 ? `$${c.pay}` : ''}</td></tr>`).join('')}</table>`
      + `<div class="n">${esc(c.note)}</div><div class="f">${c.pay > 0 ? `Everybody on the crew was paid $${c.pay}. ` : ''}G to close.</div>`;
    this.cardEl.style.display = 'block';
  }
}
