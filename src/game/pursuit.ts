// Fun queue item 12: Hot Pursuit, a police chase between players (tag with cars).
//
// Two police stations take calls: Harbor Patrol Station No. 1 on the island, and the Tepid Falls patrol post by the
// town square on the mainland. A player at one presses G:
//  - alone in town (or offline): a toast, it needs two or more players;
//  - with others in town: a CALL. Everybody else gets a toast and a P on the radar for JOIN_S seconds; whoever drives up
//    to the station joins. While calling, Q switches who is the cop: the caller, or somebody drawn at random. G again
//    starts at once, or the window runs out; then the caller sends the round (the cop, everybody in it, the times).
// The cop gets a cruiser at the station with a working light bar and siren (Q, or the SIREN key on a phone), and waits
// out the wanted players' head start (HEAD_S, a "GO" for them). Then ROUND_S of chase. The cop busts a wanted player by
// staying within BUST_M of them while they are slow (BUST_SLOW) for BUST_S seconds: a BUSTED bar fills on both screens.
// The wanted player's own browser judges that (it knows its own speed exactly) and says so in a Bust frame, so every
// screen counts the same busts. Wanted players still free when the clock runs out escape.
// The radar shows the cop to the wanted only while the siren is on, and shows each wanted player to the cop as a fuzzy
// circle that shrinks as the cop closes in. Nobody gets hurt: a crash or a ram just stops them (health is kept up), and
// the Harbor Patrol leaves players in a round alone (their heat is held at zero).
// The end: a podium on every screen from the same frames, cash (the cop per bust, escapees for surviving), and town
// records (most busts in a round, longest time survived as wanted) written by the host (net/pursuit.ts).
// Kid-friendly mode: fully allowed, it is tag. Nothing here changes in it.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import { Police } from '../sim/police';
import { Beacons } from '../sim/policeAir';
import { Siren } from '../audio/trouble';
import { SITES } from '../world/mainland';
import { groundAt } from '../world/plan';
import { save } from './save';
import { taper } from './activities';
import type { Markers, Pt } from './script';

export const JOIN_S = 30;
export const HEAD_S = 20;
export const ROUND_S = 300;
const AT_M = 12, JOIN_M = 26;
/** Busting: this close (m), the wanted player this slow (m/s, about 11 mph), for this long (s). */
export const BUST_M = 8, BUST_SLOW = 5, BUST_S = 3;
const COP_CASH = 300, ESCAPE_CASH = 450;
/** After the clock, how long every screen waits for the last frames before the podium (ms). */
const GRACE_MS = 2500;

export interface PursuitWire { kind: number; caller: number; station: number; a: number; b: number; c: number; ms: number; ids: number[] }
export interface PursuitRecord { busts: number; bustsBy: string; escape: number; escapeBy: string }
/** What the network gives the round (net/pursuit.ts). */
export interface PursuitLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): Pt | null;
  vehicleOf(id: number): Vehicle | null;
  send(m: PursuitWire): void;
  record(): PursuitRecord | null;
}
export const PK = { Call: 1, Join: 2, Go: 3, Siren: 4, Hold: 5, Bust: 6, Done: 7, Off: 8 } as const;

type Phase = 'idle' | 'calling' | 'joined' | 'head' | 'chase' | 'done' | 'podium';
interface Player { id: number; name: string; cop: boolean; busted: boolean; bustMs: number; hold: number; done: boolean; left: boolean }
interface Invite { caller: number; station: number; until: number }
interface Station { x: number; z: number; name: string; park: { x: number; z: number; h: number } }
interface Row { id: number; name: string; cop: boolean; how: string; busts: number; ms: number; cash: number; me: boolean }

const clock = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class Pursuit {
  link: PursuitLink | null = null;
  prompt: string | null = null;
  phase: Phase = 'idle';
  /** For the tests: the caller's round can be shortened (seconds). Sent in the Go frame, so only the caller's counts. */
  testHead = 0; testRound = 0;
  readonly stats = { called: 0, joined: 0, rounds: 0, busts: 0, podiums: 0, sent: 0, got: 0 };

  private station = 0;
  private caller = 0;
  private cop = 0;
  private random = false;
  private readonly players = new Map<number, Player>();
  private until = 0;
  private releaseAt = 0;
  private endAt = 0;
  private doneAt = 0;
  private headS = HEAD_S; private roundS = ROUND_S;
  private siren = false;
  private hold = 0; private holdSent = 0; private holdAt = 0;
  private cruiser: Vehicle | null = null;
  private podiumUntil = 0;
  private lastRows: Row[] = [];
  private lastNotes: string[] = [];
  private readonly invites = new Map<number, Invite>();
  private fuzz = new Map<number, { ox: number; oz: number; at: number }>();
  private stationsCache: Station[] | null = null;
  private uiAt = 0;
  private told = false;
  /** The town's records as they stood at the start of the round: every screen's podium notes compare with these. */
  private recBefore: PursuitRecord | null = null;

  private readonly ui = new PursuitUi();
  private readonly bars: Beacons;
  private voice: { v: Vehicle; s: Siren; g: GainNode; pan: StereoPannerNode } | null = null;

  constructor(private readonly game: Game, private readonly markers: Markers,
    private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    this.bars = new Beacons(game);
    this.ui.onKey = () => this.qKey();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private get me(): number { return this.link ? this.link.me() : 0; }
  private nameOf(id: number): string { return this.link ? this.link.nameOf(id) : 'You'; }
  private send(m: Partial<PursuitWire> & { kind: number }): void {
    if (!this.link) return;
    this.link.send({ caller: this.caller, station: this.station, a: 0, b: 0, c: 0, ms: 0, ids: [], ...m });
    this.stats.sent++;
  }
  private get amCop(): boolean { return this.cop === this.me && this.cop !== 0; }
  private get inRound(): boolean { return this.phase === 'head' || this.phase === 'chase' || this.phase === 'done'; }

  /** The two stations: where to call from, and the curb the cop's cruiser waits at. */
  stations(): Station[] {
    if (this.stationsCache) return this.stationsCache;
    const g = this.game, pol = g.systems.find((s) => s instanceof Police) as Police | undefined;
    const near = (list: { x: number; z: number; h: number }[], x: number, z: number): { x: number; z: number; h: number } => {
      let best = { x, z, h: 0 }, bd = Infinity;
      for (const s of list) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd && d > 4) { bd = d; best = s; } }
      return best;
    };
    const st = pol ? pol.station : { x: 0, z: 0, name: 'Harbor Patrol Station No. 1' };
    const isl = { x: st.x, z: st.z, name: 'Harbor Patrol Station No. 1', park: near(g.plan.parking, st.x, st.z) };
    const mp = near(g.plan.mainlandParking, SITES.square.x, SITES.square.z);
    const ml = { x: mp.x, z: mp.z, name: 'the Tepid Falls patrol post', park: mp };
    this.stationsCache = [isl, ml];
    return this.stationsCache;
  }

  // ── Starting ───────────────────────────────────────────────────────────────

  private offer(): void {
    const g = this.game, p = g.player, v = p.vehicle, now = performance.now();
    for (const [id, inv] of this.invites) {
      if (now > inv.until) { this.invites.delete(id); continue; }
      const s = this.stations()[inv.station];
      this.markers.put(s.x, s.z, 'goal', 9, 60);
      if (v && Math.hypot(p.x - s.x, p.z - s.z) < JOIN_M && this.isFree()) { this.join(inv); return; }
    }
    let at = -1;
    this.stations().forEach((s, i) => {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d > 300) return;
      this.markers.put(s.x, s.z, 'job', 7, 22);
      if (d < AT_M && p.speed < 4 && this.isFree()) at = i;
    });
    if (at < 0) return;
    const many = this.link ? this.link.others().length : 0, rec = this.link?.record();
    const recT = rec ? ` · records: ${rec.busts} bust${rec.busts === 1 ? '' : 's'} by ${rec.bustsBy}, ${clock(rec.escape * 1000)} on the run by ${rec.escapeBy}` : '';
    this.prompt = many ? `[G] Call Hot Pursuit: you are the cop, ${many} other${many > 1 ? 's' : ''} in town${recT}` : `[G] Hot Pursuit (needs 2+ players)${recT}`;
    if (!g.input.eat('interact')) return;
    if (!many) { g.hud.toast('Hot Pursuit needs two or more players in town. Come back with friends: one is the cop, the rest are wanted.', 6); return; }
    this.call(at);
  }

  call(station: number): void {
    this.station = station; this.caller = this.me; this.cop = 0; this.random = false;
    this.players.clear(); this.invites.clear();
    this.addPlayer(this.me);
    this.setBusy('pursuit');
    this.stats.called++;
    this.phase = 'calling';
    this.until = performance.now() + JOIN_S * 1000;
    this.sendCall();
    this.game.hud.stamp('HOT PURSUIT', `${this.stations()[station].name} · everybody in town has ${JOIN_S} s to drive here · G to start now · Q: who is the cop`);
  }

  private sendCall(): void {
    if (this.phase !== 'calling') return;
    this.send({ kind: PK.Call, a: Math.max(1, (this.until - performance.now()) / 1000), b: this.random ? 1 : 0, ids: [...this.players.keys()] });
  }

  private join(inv: Invite): void {
    this.invites.clear();
    this.station = inv.station; this.caller = inv.caller;
    this.players.clear();
    this.until = inv.until;
    this.phase = 'joined';
    this.setBusy('pursuit');
    this.stats.joined++;
    this.send({ kind: PK.Join, a: 1 });
    this.game.hud.stamp('YOU ARE IN', `${this.nameOf(inv.caller)}'s Hot Pursuit · wait for the start`);
  }

  private addPlayer(id: number): Player {
    let x = this.players.get(id);
    if (!x) this.players.set(id, x = { id, name: this.nameOf(id), cop: false, busted: false, bustMs: 0, hold: 0, done: false, left: false });
    return x;
  }

  /** Everybody in: the cop, the head start, the round. */
  private start(cop: number, ids: number[], head: number, round: number): void {
    const g = this.game, now = performance.now();
    this.players.clear();
    for (const id of ids) this.addPlayer(id).cop = id === cop;
    this.cop = cop; this.headS = head; this.roundS = round;
    this.releaseAt = now + head * 1000; this.endAt = this.releaseAt + round * 1000;
    this.phase = 'head'; this.siren = false; this.hold = 0; this.holdSent = 0; this.doneAt = 0; this.told = false;
    this.fuzz.clear();
    this.recBefore = this.link?.record() ?? null;
    this.stats.rounds++;
    if (this.amCop) {
      const s = this.stations()[this.station].park, p = g.player;
      if (p.vehicle) p.exit(true);
      const v = g.vehicles.spawn('cruiser', s.x, s.z, s.h);
      this.cruiser = v;
      p.enter(v, true);
      this.pin(v, true);
      g.hud.stamp('YOU ARE THE COP', `Wait ${head} s while they run · Q (or SIREN) for the lights and siren · stay close to a slow car for ${BUST_S} s to bust it`);
    } else {
      g.hud.stamp('GO! YOU ARE WANTED', `${this.nameOf(cop)} is the cop · ${head} s head start · survive ${clock(round * 1000)}`);
    }
  }

  private pin(v: Vehicle, first: boolean): void {
    const s = this.stations()[this.station].park, c = v as Vehicle & { yawRate?: number };
    v.x = s.x; v.z = s.z; v.h = s.h; v.y = Math.max(groundAt(s.x, s.z), 0);
    v.vx = v.vy = v.vz = 0; c.yawRate = 0; v.pitch = 0; v.roll = 0;
    if (first) { (this.game.vehicles as unknown as { wake?: (v: Vehicle) => void }).wake?.(v); this.game.cam.snap(); }
  }

  // ── The network's ──────────────────────────────────────────────────────────

  got(from: number, m: PursuitWire): void {
    this.stats.got++;
    const now = performance.now();
    if (m.kind === PK.Call) {
      if (from !== m.caller || m.station > 1) return;
      if (this.phase === 'joined' && this.caller === m.caller) { this.until = now + m.a * 1000; return; }
      if (this.phase !== 'idle') return;
      const old = this.invites.get(m.caller);
      this.invites.set(m.caller, { caller: m.caller, station: m.station, until: now + m.a * 1000 });
      if (!old) this.game.hud.toast(`${this.nameOf(m.caller)} called Hot Pursuit at ${this.stations()[m.station].name}. Drive to the P on the radar within ${Math.round(m.a)} s to join.`, 8);
      return;
    }
    if (m.kind === PK.Off) {
      this.invites.delete(m.caller);
      if (this.phase === 'joined' && this.caller === m.caller) { this.end(); this.game.hud.toast(`${this.nameOf(m.caller)} called Hot Pursuit off.`, 5); }
      return;
    }
    if (m.kind === PK.Join) {
      if (this.phase !== 'calling' || m.caller !== this.me) return;
      if (m.a && this.players.size < 8) { this.addPlayer(from); this.game.hud.toast(`${this.nameOf(from)} is in.`, 3); }
      else if (!m.a) this.players.delete(from);
      this.sendCall();
      return;
    }
    if (m.kind === PK.Go) {
      if (this.phase !== 'joined' || m.caller !== this.caller) return;
      if (!m.ids.includes(this.me)) { this.end(); this.game.hud.toast('Hot Pursuit filled up before you got there.', 5); return; }
      this.start(m.a, m.ids, m.b, m.c);
      return;
    }
    if (m.caller !== this.caller || !(this.inRound || this.phase === 'podium')) return;
    const x = this.players.get(from);
    if (!x) return;
    if (m.kind === PK.Siren) { if (from === this.cop) this.siren = !!m.a; }
    else if (m.kind === PK.Hold) x.hold = m.a / 255;
    else if (m.kind === PK.Bust) this.busted(x, m.ms);
    else if (m.kind === PK.Done) x.done = true;
  }

  dropped(id: number): void {
    this.invites.delete(id);
    if (this.phase === 'joined' && this.caller === id) { this.end(); this.game.hud.toast('The Hot Pursuit caller left town. It is off.', 5); return; }
    if (this.phase === 'calling') { this.players.delete(id); this.sendCall(); return; }
    const x = this.players.get(id);
    if (!x || !this.inRound) return;
    x.left = true; x.done = true;
    if (id === this.cop) { this.game.hud.toast('The cop left town. Everybody still free got away.', 5); this.endAt = Math.min(this.endAt, performance.now()); }
  }

  offline(): void {
    this.invites.clear();
    if (this.phase === 'calling' || this.phase === 'joined') { this.end(); return; }
    if (this.inRound) for (const x of this.players.values()) if (x.id !== this.me) { x.left = true; x.done = true; }
    if (this.inRound) this.endAt = Math.min(this.endAt, performance.now());
  }

  announce(): void {
    this.sendCall();
    if (this.inRound && this.amCop && this.siren) this.send({ kind: PK.Siren, a: 1 });
  }

  private busted(x: Player, ms: number): void {
    if (x.busted || x.cop) return;
    x.busted = true; x.bustMs = ms; x.hold = 1;
    this.stats.busts++;
    const g = this.game;
    if (x.id === this.me) g.hud.stamp('BUSTED!', `${this.nameOf(this.cop)} caught you after ${clock(ms)} · wait for the end of the round`);
    else if (this.amCop) g.hud.stamp('BUSTED!', `You caught ${x.name} · ${this.wantedLeft()} still on the run`);
    else g.hud.toast(`${x.name} was busted by ${this.nameOf(this.cop)}.`, 4);
  }
  private wantedLeft(): number { let n = 0; for (const x of this.players.values()) if (!x.cop && !x.busted && !x.left) n++; return n; }

  // ── Per frame ──────────────────────────────────────────────────────────────

  /** Q, or the SIREN / COP key on the glass. */
  private qKey(): void {
    if (this.phase === 'calling') { this.random = !this.random; this.sendCall(); return; }
    if (this.inRound && this.amCop && this.phase !== 'done') {
      this.siren = !this.siren;
      this.send({ kind: PK.Siren, a: this.siren ? 1 : 0 });
    }
  }

  update(dt: number): void {
    const now = performance.now(), g = this.game, p = g.player, v = p.vehicle;
    this.prompt = null;
    this.bars.begin();
    if (this.phase === 'idle') {
      if (this.isFree() || this.invites.size) this.offer();
      this.ui.bar(null); this.ui.key(null); this.bars.end(); this.sound(null);
      return;
    }
    const s = this.stations()[this.station];
    if ((this.phase === 'calling' || this.inRound) && g.input.eat('prevWeapon')) this.qKey();
    if (this.phase === 'calling') {
      const left = Math.max(0, (this.until - now) / 1000), n = this.players.size;
      this.markers.put(s.x, s.z, 'goal', 9, 60);
      this.prompt = `[G] Start now · ${n - 1} joined · ${Math.ceil(left)} s · [Q] cop: ${this.random ? 'drawn at random' : 'you'}`;
      this.ui.key(this.random ? 'COP: RANDOM' : 'COP: YOU');
      g.hud.objective(`Hot Pursuit called. Waiting for others (${Math.ceil(left)} s).`);
      if (!(p.health > 0) || Math.hypot(p.x - s.x, p.z - s.z) > 80) {
        this.send({ kind: PK.Off }); this.end(); g.hud.toast('Hot Pursuit called off.', 4); this.bars.end(); return;
      }
      if (g.input.eat('interact') || left <= 0) {
        const ids = [...this.players.keys()];
        if (ids.length < 2) { this.send({ kind: PK.Off }); this.end(); g.hud.toast('Nobody came: Hot Pursuit needs two or more players.', 5); this.bars.end(); return; }
        const cop = this.random ? ids[Math.floor(Math.random() * ids.length)] : this.me;
        const head = this.testHead || HEAD_S, round = this.testRound || ROUND_S;
        this.send({ kind: PK.Go, a: cop, b: head, c: round, ids });
        this.start(cop, ids, head, round);
      }
    } else if (this.phase === 'joined') {
      const left = Math.max(0, (this.until - now) / 1000);
      this.markers.put(s.x, s.z, 'goal', 9, 60);
      g.hud.objective(`In ${this.nameOf(this.caller)}'s Hot Pursuit. It starts in ${Math.ceil(left)} s.`);
      this.ui.key(null);
      if (Math.hypot(p.x - s.x, p.z - s.z) > 90 || !(p.health > 0)) { this.send({ kind: PK.Join, a: 0 }); this.end(); g.hud.toast('You left before the start.', 4); this.bars.end(); return; }
      if (now > this.until + 10000) { this.end(); g.hud.toast('Hot Pursuit never started.', 4); this.bars.end(); return; }
    } else if (this.inRound) {
      this.tick(dt, now);
    } else if (this.phase === 'podium') {
      if (now > this.podiumUntil || g.input.eat('interact')) { this.ui.podium(null); this.phase = 'idle'; this.players.clear(); this.cop = 0; }
    }
    this.drawBars();
    this.bars.end();
  }

  private tick(dt: number, now: number): void {
    const g = this.game, p = g.player, v = p.vehicle, me = this.players.get(this.me);
    if (!me) { this.end(); return; }
    // Tag, not a fight: the Patrol leaves players in a round alone, and nobody is hurt.
    if (p.heat > 0) p.heat = 0;
    if (p.health > 0 && p.health < 100) p.health = 100;
    if (v && v.health < 40) v.health = 40;
    const copPos = this.amCop ? (v ? { x: v.x, z: v.z } : { x: p.x, z: p.z }) : this.link?.posOf(this.cop) ?? null;
    if (this.phase === 'head') {
      const left = this.releaseAt - now;
      if (this.amCop) { if (v) this.pin(v, false); g.hud.objective(`They are running. You go in ${Math.ceil(left / 1000)} s.`); }
      else g.hud.objective(`Head start: the cop goes in ${Math.ceil(left / 1000)} s. Get away!`);
      g.hud.timer('Head start', clock(left), left < 5000);
      if (left <= 0) {
        this.phase = 'chase';
        g.hud.stamp(this.amCop ? 'GO! GET THEM' : 'THE COP IS COMING', this.amCop ? `${this.wantedLeft()} wanted · ${clock(this.roundS * 1000)}` : `Survive ${clock(this.roundS * 1000)}`);
      }
    } else if (this.phase === 'chase') {
      const left = this.endAt - now;
      g.hud.timer(this.amCop ? 'Busts ' + this.bustCount() : me.busted ? 'Busted' : 'Escape in', clock(left), left < 30000);
      if (this.amCop) g.hud.objective(`Find them: the circles on the radar shrink as you close in. ${this.wantedLeft()} still on the run.`);
      else if (!me.busted) g.hud.objective(this.siren ? 'The cop has the siren on: the C on the radar.' : 'The cop is running dark. Keep moving!');
      // The wanted player's own screen judges a bust.
      if (!this.amCop && !me.busted && !me.left) {
        const d = copPos ? Math.hypot((v ? v.x : p.x) - copPos.x, (v ? v.z : p.z) - copPos.z) : Infinity;
        if (d < BUST_M && Math.abs(p.speed) < BUST_SLOW) this.hold = Math.min(1, this.hold + dt / BUST_S);
        else this.hold = Math.max(0, this.hold - dt / 1.5);
        me.hold = this.hold;
        if (this.hold >= 1) { const ms = Math.round(now - this.releaseAt); this.send({ kind: PK.Bust, ms }); this.busted(me, ms); }
        else if ((Math.abs(this.hold - this.holdSent) > 0.08 || (this.hold === 0 && this.holdSent > 0)) && now - this.holdAt > 150) {
          this.holdSent = this.hold; this.holdAt = now; this.send({ kind: PK.Hold, a: this.hold * 255 });
        }
      }
      if (left <= 0 || this.wantedLeft() === 0) this.finish(now);
    } else if (this.phase === 'done') {
      g.hud.timer(null);
      const all = [...this.players.values()].every((x) => x.done);
      if (all || now - this.doneAt > GRACE_MS) this.podium();
      return;
    }
    // The BUSTED bar: the wanted player's own, or the fullest one near the cop.
    if (now - this.uiAt > 100) {
      this.uiAt = now;
      let bar: { name: string; k: number; busted: boolean } | null = null;
      if (this.amCop) { for (const x of this.players.values()) if (!x.cop && (x.hold > 0.01 && !x.busted) && (!bar || x.hold > bar.k)) bar = { name: x.name, k: x.hold, busted: x.busted }; }
      else if (me.busted || this.hold > 0.01) bar = { name: 'you', k: me.busted ? 1 : this.hold, busted: me.busted };
      this.ui.bar(bar);
      this.ui.key(this.amCop ? (this.siren ? 'SIREN: ON' : 'SIREN: OFF') : null);
    }
  }

  private bustCount(): number { let n = 0; for (const x of this.players.values()) if (x.busted) n++; return n; }

  private finish(now: number): void {
    const me = this.players.get(this.me);
    if (!me) return;
    const survived = me.cop ? 0 : me.busted ? me.bustMs : Math.round(this.roundS * 1000);
    this.send({ kind: PK.Done, a: me.cop ? 1 : me.busted ? 3 : 2, b: me.cop ? this.bustCount() : 0, ms: survived });
    me.done = true;
    this.phase = 'done'; this.doneAt = now;
    this.siren = false;
    this.ui.bar(null); this.ui.key(null);
    this.game.hud.timer(null);
    this.game.hud.objective('Time! Waiting for the others.');
  }

  /** Every screen: the same busts heard, so the same card; this player is paid for their own part. */
  private podium(): void {
    const g = this.game, busts = this.bustCount(), t = taper(save.count('pursuit')).cash;
    let pay = 0;
    const rows: Row[] = [...this.players.values()].map((x) => {
      const ms = x.cop ? 0 : x.busted ? x.bustMs : Math.round(this.roundS * 1000);
      const cash = Math.round((x.cop ? COP_CASH * busts : x.busted ? Math.min(150, 25 + ms / 2000) : x.left ? 0 : ESCAPE_CASH) * t);
      if (x.id === this.me) pay = cash;
      return { id: x.id, name: x.name, cop: x.cop, how: x.cop ? `${busts} bust${busts === 1 ? '' : 's'}` : x.busted ? `busted at ${clock(ms)}` : x.left ? 'left town' : 'ESCAPED', busts: x.cop ? busts : 0, ms, cash, me: x.id === this.me };
    });
    rows.sort((a, b) => (a.cop ? -1 : b.cop ? 1 : b.ms - a.ms || a.id - b.id));
    this.lastRows = rows;
    const rec = this.recBefore, notes: string[] = [];
    const copRow = rows.find((r) => r.cop);
    if (copRow && busts > 0 && (!rec || busts > rec.busts)) notes.push(`New town record: ${busts} bust${busts === 1 ? '' : 's'} in a round by ${copRow.name}`);
    const best = rows.filter((r) => !r.cop).sort((a, b) => b.ms - a.ms)[0];
    if (best && best.ms > 0 && (!rec || Math.round(best.ms / 1000) > rec.escape)) notes.push(`New town record: ${clock(best.ms)} on the run by ${best.name}`);
    this.lastNotes = notes;
    if (pay > 0) { g.player.money += pay; save.credit(pay); save.data.stats.earned += pay; }
    save.bump('pursuit');
    this.ui.podium({ rows, notes, pay });
    this.stats.podiums++;
    this.phase = 'podium';
    this.podiumUntil = performance.now() + 14000;
    g.hud.objective(null);
    this.setBusy(null);
  }

  private end(): void {
    const was = this.phase;
    this.phase = 'idle'; this.players.clear(); this.cop = 0; this.siren = false;
    this.ui.bar(null); this.ui.key(null);
    this.game.hud.objective(null); this.game.hud.timer(null);
    if (was !== 'idle' && was !== 'podium') this.setBusy(null);
  }

  // ── Lights, siren, radar ───────────────────────────────────────────────────

  /** The cop's car this frame (here, or as shown for another player), when the round is on. */
  private copCar(): Vehicle | null {
    if (!this.inRound || this.phase === 'done' || !this.cop) return null;
    if (this.amCop) return this.game.player.vehicle;
    return this.link?.vehicleOf(this.cop) ?? null;
  }

  private drawBars(): void {
    const v = this.siren ? this.copCar() : null;
    if (v) {
      const sh = Math.sin(v.h), ch = Math.cos(v.h);
      this.bars.bar(v.x - sh * 0.15, v.y + v.spec.height + 0.14, v.z - ch * 0.15, v.h, 0.3);
    }
    this.sound(v);
  }

  private sound(v: Vehicle | null): void {
    const core = this.game.audio?.core;
    if (!core || core.ctx.state !== 'running') return;
    const t = core.now;
    if (this.voice && this.voice.v !== v) { this.voice.s.stop(t); this.voice = null; }
    if (!v) return;
    if (!this.voice) {
      const g = core.gain(0), pan = core.ctx.createStereoPanner(), s = new Siren(core, t, 0.2);
      s.out.connect(g); g.connect(pan); pan.connect(core.bus.sfx);
      this.voice = { v, s, g, pan };
    }
    this.voice.s.ahead(t);
    this.voice.g.gain.setTargetAtTime(core.gainAt(v.x, v.y, v.z, 14, 560), t, 0.1);
    this.voice.pan.pan.setTargetAtTime(core.panAt(v.x, v.z), t, 0.1);
  }

  blips(out: Blip[]): void {
    const p = this.game.player, now = performance.now();
    for (const inv of this.invites.values()) { const s = this.stations()[inv.station]; out.push({ x: s.x, z: s.z, kind: 'goal', label: 'P' }); }
    if (this.phase === 'calling' || this.phase === 'joined') { const s = this.stations()[this.station]; out.push({ x: s.x, z: s.z, kind: 'goal', label: 'P' }); return; }
    if (this.phase === 'chase' || this.phase === 'head') {
      if (this.amCop) {
        const v = p.vehicle, cx = v ? v.x : p.x, cz = v ? v.z : p.z;
        for (const x of this.players.values()) {
          if (x.cop || x.busted || x.left) continue;
          const at = this.link?.posOf(x.id);
          if (!at) continue;
          const d = Math.hypot(at.x - cx, at.z - cz), r = Math.max(12, Math.min(160, d * 0.35));
          let f = this.fuzz.get(x.id);
          if (!f || now - f.at > 2500) { const a = Math.random() * Math.PI * 2, k = Math.random() * 0.7; this.fuzz.set(x.id, f = { ox: Math.cos(a) * k, oz: Math.sin(a) * k, at: now }); }
          out.push({ x: Math.round(at.x + f.ox * r), z: Math.round(at.z + f.oz * r), kind: 'goal', r: Math.round(r) });
        }
      } else if (this.siren) {
        const at = this.link?.posOf(this.cop);
        if (at) out.push({ x: at.x, z: at.z, kind: 'giver', label: 'C' });
      }
      return;
    }
    if (this.phase !== 'idle' || !this.isFree()) return;
    const s = this.stations().map((x) => ({ x, d: Math.hypot(x.x - p.x, x.z - p.z) })).sort((a, b) => a.d - b.d)[0];
    if (s && s.d < 900) out.push({ x: s.x.x, z: s.x.z, kind: 'job', label: 'P' });
  }

  /** For the tests (window.__game.game.todo.pursuit.info()). */
  info(): Record<string, unknown> {
    const now = performance.now();
    return {
      ...this.stats, phase: this.phase, station: this.station, caller: this.caller, cop: this.cop, random: this.random, siren: this.siren,
      hold: +this.hold.toFixed(2), left: this.inRound ? Math.round((this.phase === 'head' ? this.releaseAt : this.endAt) - now) : 0,
      cruiser: !!this.cruiser && this.game.player.vehicle === this.cruiser && this.cruiser.spec.kind === 'cruiser',
      invites: [...this.invites.values()].map((i) => ({ caller: i.caller, station: i.station })),
      players: [...this.players.values()].map((x) => ({ id: x.id, name: x.name, cop: x.cop, busted: x.busted, bustMs: x.bustMs, hold: +x.hold.toFixed(2), done: x.done })),
      results: this.lastRows.map((r) => ({ id: r.id, cop: r.cop, how: r.how, busts: r.busts, ms: r.ms, cash: r.cash })),
      notes: this.lastNotes,
      stations: this.stations().map((s) => ({ x: Math.round(s.x), z: Math.round(s.z), name: s.name })),
    };
  }
}

// ── The page's own bits: the BUSTED bar, the SIREN key, the podium card ──────────

const CSS = `
#hp-bar{position:fixed;left:50%;top:22%;transform:translateX(-50%);width:min(340px,70vw);padding:8px 12px 10px;background:rgba(20,33,61,.86);color:#f2e8cf;font:800 15px/1.2 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.06em;text-align:center;border:2px solid #f2e8cf;border-radius:4px;z-index:40;pointer-events:none;display:none}
#hp-bar i{display:block;height:12px;margin-top:6px;background:rgba(242,232,207,.2);border-radius:2px;overflow:hidden}
#hp-bar b{display:block;height:100%;width:0;background:linear-gradient(90deg,#2a62ff,#ff2a1a)}
#hp-key{position:fixed;right:calc(env(safe-area-inset-right,0px) + 12px);top:42%;padding:10px 12px;min-width:84px;background:rgba(20,33,61,.86);color:#f2e8cf;font:800 13px/1 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.06em;border:2px solid #f2e8cf;border-radius:6px;z-index:45;display:none;pointer-events:auto;touch-action:manipulation;user-select:none}
#hp-card{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,92vw);max-height:84vh;overflow:auto;padding:14px 18px;background:#f2e8cf;color:#14213d;font:600 14px/1.35 system-ui,sans-serif;border:3px solid #14213d;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.45);z-index:50;display:none}
#hp-card h2{margin:0 0 8px;font:900 26px/1 "Big Shoulders Display","Arial Narrow",sans-serif;letter-spacing:.05em}
#hp-card table{width:100%;border-collapse:collapse}#hp-card td{padding:3px 4px;border-top:1px solid rgba(20,33,61,.2)}
#hp-card tr.me td{font-weight:800}#hp-card .n{color:#9a3412;font-weight:700;margin-top:6px}#hp-card .f{margin-top:8px;font-size:12px;opacity:.7}
`;

class PursuitUi {
  onKey: () => void = () => { /* set by Pursuit */ };
  private readonly barEl: HTMLDivElement;
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly keyEl: HTMLButtonElement;
  private readonly card: HTMLDivElement;
  private keyText: string | null = '';
  private barKey = '';

  constructor() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.barEl = document.body.appendChild(document.createElement('div')); this.barEl.id = 'hp-bar';
    this.label = this.barEl.appendChild(document.createElement('span'));
    this.fill = this.barEl.appendChild(document.createElement('i')).appendChild(document.createElement('b'));
    this.keyEl = document.body.appendChild(document.createElement('button')); this.keyEl.id = 'hp-key';
    this.keyEl.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.onKey(); });
    this.card = document.body.appendChild(document.createElement('div')); this.card.id = 'hp-card';
    this.key(null);
  }

  bar(b: { name: string; k: number; busted: boolean } | null): void {
    const key = b ? `${b.name}${Math.round(b.k * 50)}${b.busted}` : '';
    if (key === this.barKey) return;
    this.barKey = key;
    if (!b) { this.barEl.style.display = 'none'; return; }
    this.barEl.style.display = 'block';
    this.label.textContent = b.busted ? (b.name === 'you' ? 'BUSTED!' : `${b.name.toUpperCase()}: BUSTED!`) : b.name === 'you' ? 'BUSTED — get moving!' : `BUSTING ${b.name.toUpperCase()}`;
    this.fill.style.width = `${Math.round(b.k * 100)}%`;
  }

  key(text: string | null): void {
    if (text === this.keyText) return;
    this.keyText = text;
    this.keyEl.style.display = text ? 'block' : 'none';
    if (text) this.keyEl.textContent = `[Q] ${text}`;
  }

  podium(c: { rows: Row[]; notes: string[]; pay: number } | null): void {
    if (!c) { this.card.style.display = 'none'; return; }
    const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
    this.card.innerHTML = `<h2>HOT PURSUIT · RESULTS</h2><table>${c.rows.map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${r.cop ? 'COP' : 'WANTED'}</td><td>${esc(r.name)}${r.me ? ' (you)' : ''}</td><td>${esc(r.how)}</td><td>$${r.cash}</td></tr>`).join('')}</table>`
      + c.notes.map((n) => `<div class="n">${esc(n)}</div>`).join('')
      + `<div class="f">${c.pay > 0 ? `You earned $${c.pay}. ` : ''}G to close.</div>`;
    this.card.style.display = 'block';
  }
}

