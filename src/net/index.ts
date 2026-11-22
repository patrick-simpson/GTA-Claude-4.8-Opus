// Multiplayer, stage 1: see each other. One system in game.systems.
//
// What travels: this browser's own character, or the car it is driving (kind, colour, position, full orientation,
// speed, steering). Parked cars, traffic, pedestrians, police and everything else stay local to each browser until
// stage 2: another player's car is a drawn copy here (Vehicles.ghost), never one of this browser's simulated cars.
// Stage 2, step 1 (shared.ts): on the main service the moving traffic is the host's, the same for everybody.
// Stage 2, step 2: another player's car is solid here (each browser moves only its own car in a crash); on the main
// service the traffic signals run on one town clock, and a guest's knocks on the host's cars are told to the host.
// Stage 2, step 3 (cars.ts): on the main service the parked cars are one set for the town, any player can take any of
// the town's cars by asking the host, and a car a player gets out of stays where it is for everybody.
// Stage 3 (people.ts, police.ts): on the main service the pedestrians are the host's, and so are the police: each
// player keeps a wanted level of their own, and the host's one set of police chases whoever is wanted.
// Stage 3, step 3 (fight.ts): the players see each other's shots and can hurt each other, on both services.
//
// Sending (protocol.ts has the rules): a State frame up to SEND_HZ times a second, but only when something has
// changed since the last one sent; a one byte keepalive every KEEPALIVE_MS otherwise; the measured frame time every
// PERF_INTERVAL_MS. Alone in the city, nothing at all is sent, so the city sleeps.
//
// When there is no seat (the town holds 8) or the service has paused itself for the day, the game is the single
// player game with one small line under the cash slip saying so, and one notice on entry. conn.ts decides when to ask
// again; nothing here does.

import type { Game } from '../core/game';
import { angleDiff } from '../core/util';
import { KINDS } from '../ent/vehicleSpecs';
import {
  HELD_SHIFT, KEEPALIVE_FRAME, KEEPALIVE_MS, PERF_CANNOT_HOST_MS, PERF_INTERVAL_MS, PLAYER_STATE_BYTES, POSES, PlayerFlag, PlayerMode, SEND_HZ,
  Frame, PlayerEvent, WorldKind, blankPlayerState, decodePlayerEvent, decodePlayerState, encodePlayerEvent, encodeMsg, encodePlayerState, frameKind,
  type PlayerEntry, type ServerMsg, type WelcomeMsg,
} from './protocol';
import { Connection, servicePlan, type NetStatus } from './conn';
import { Remote } from './remote';
import { SharedTraffic } from './shared';
import { TownCars } from './cars';
import { TownPeople } from './people';
import { TownPolice } from './police';
import { TownFight } from './fight';
import { SAYS, myName, nameText, rerollName } from './names';

const SEND_MS = 1000 / SEND_HZ;
/** The fewest ms between two things said by this player. */
export const SAY_GAP_MS = 2000;

export class Net {
  readonly conn: Connection;
  /** Everybody else in this city, by id. */
  readonly remotes = new Map<number, Remote>();
  /** The town's traffic: simulated here for everybody (host), shown from the host's frames (guest), or private. */
  readonly shared: SharedTraffic;
  /** The town's parked cars, and taking and leaving cars (stage 2, step 3). */
  readonly cars: TownCars;
  /** The town's pedestrians: the host's, shown to everybody (stage 3, step 1). */
  readonly people: TownPeople;
  /** The town's police: the host's, after anybody wanted, seen by everybody (stage 3, step 2). */
  readonly police: TownPolice;
  /** Weapons between players: their shots seen, their claims on each other judged (stage 3, step 3). */
  readonly fight: TownFight;
  /** State frames sent, apart from the totals in conn.sent. */
  statesSent = 0;

  private readonly out = blankPlayerState();
  private readonly last = blankPlayerState();
  private readonly outBuf = new ArrayBuffer(PLAYER_STATE_BYTES);
  private readonly inState = blankPlayerState();
  /** Send the next state whether or not it changed: somebody has just arrived and knows nothing about us. */
  private force = true;
  private stateAt = 0;
  private anyAt = 0;
  private perfAt = 0;
  private sayAt = -1e9;
  private sayNext = 0;
  /** Lines this player has sent, and the one most recently sent (index into SAYS, -1 none). */
  saysSent = 0;
  lastSay = -1;
  private readonly peerList: Remote[] = [];
  private countEl: HTMLElement | null = null;
  private countShown = -1;
  private noteEl: HTMLElement | null = null;
  /** What the line under the cash slip says now ('' = hidden), and which notices have had their one toast. */
  private noteShown = '';
  private noteKind: '' | 'full' | 'rest' = '';
  private readonly told = { full: false, rest: false };

  constructor(private readonly game: Game) {
    const plan = servicePlan();
    const c = this.conn = new Connection(plan.urls, myName, plan.fullRetryS, plan.lookup, plan.probeS);
    c.onWelcome = (m) => this.welcome(m);
    c.onMsg = (m) => this.msg(m);
    c.onFrame = (b) => this.frame(b);
    c.onDown = () => this.clear();
    c.onChange = () => this.showNote();
    this.shared = new SharedTraffic(game, c, this.remotes);
    this.cars = new TownCars(game, c, this.remotes, this.shared);
    this.people = new TownPeople(game, c, this.remotes, this.shared);
    this.police = new TownPolice(game, c, this.remotes, this.shared, this.people);
    this.fight = new TownFight(game, c, this.remotes, this.shared, this.cars);
    // A paused game simulates nothing, so it says at once that it cannot host (and, on resuming, that it can again).
    game.on('pause', () => { this.perfAt = 0; });
    c.start();
    this.showNote();
    // The game's own loop stops while paused and in a hidden tab; the keepalive must not.
    if (c.status !== 'off') setInterval(() => this.pump(performance.now()), 500);
  }

  get status(): NetStatus { return this.conn.status; }
  get name(): string { return nameText(myName()); }
  /** Others to draw on the radar and the map: empty unless connected. The list is reused; do not keep it. */
  get peers(): readonly Remote[] {
    const l = this.peerList; l.length = 0;
    if (this.conn.status === 'online') for (const r of this.remotes.values()) if (r.seen) l.push(r);
    return l;
  }
  /** Is there anybody to say something to? */
  get canSay(): boolean { return this.conn.status === 'online' && this.remotes.size > 0; }

  /**
   * Say line i of SAYS (0 is the wave) to everybody: one 4 byte frame, sent only when somebody is here, and at most one
   * every SAY_GAP_MS. Returns whether it went.
   */
  say(i: number, now = performance.now()): boolean {
    if (!this.canSay || !Number.isInteger(i) || i < 0 || i >= SAYS.length || now - this.sayAt < SAY_GAP_MS) return false;
    const f = i === 0 ? encodePlayerEvent(PlayerEvent.Wave, 0) : encodePlayerEvent(PlayerEvent.Shout, i - 1);
    if (!this.conn.send(f)) return false;
    this.sayAt = now; this.saysSent++; this.lastSay = i;
    return true;
  }

  /** The say key: the next line in turn. */
  sayCycle(): void {
    const i = this.sayNext;
    if (this.say(i)) {
      this.sayNext = (i + 1) % SAYS.length;
      this.game.hud.toast(`You: ${SAYS[i]}`, 2);
    }
  }

  /** Everybody in town, this player included; 0 when not connected. */
  get count(): number { return this.conn.status === 'online' ? this.remotes.size + 1 : 0; }

  /** For a menu button: a new made-up name, told to everybody. */
  reroll(): string {
    const n = rerollName();
    this.conn.send(encodeMsg({ t: 'name', name: n }));
    return nameText(n);
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  private add(e: PlayerEntry): void {
    const id = e[0];
    if (id === this.conn.id || this.remotes.has(id)) return;
    this.remotes.set(id, new Remote(this.game, id, e.slice(1)));
    this.force = true;
    this.shared.refresh();
    this.cars.refresh();
    this.people.refresh();
  }

  private drop(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.cars.dropped(r, performance.now());
    this.fight.dropped(id);
    r.dispose();
    this.remotes.delete(id);
  }

  private clear(): void {
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.fight.clear();
    this.showCount();
  }

  private welcome(m: WelcomeMsg): void {
    this.clear();
    for (const e of m.players) this.add(e);
    const now = performance.now();
    this.shared.welcome(m.now, now);
    this.force = true;
    this.anyAt = now; this.perfAt = now - PERF_INTERVAL_MS + 1000;
    this.showCount();
  }

  private msg(m: ServerMsg): void {
    if (m.t === 'join') this.add([m.id, ...m.name]);
    else if (m.t === 'leave') this.drop(m.id);
    else if (m.t === 'name' && 'id' in m) this.remotes.get(m.id)?.rename(m.name.slice());
    this.showCount();
  }

  private frame(buf: ArrayBuffer): void {
    const k = frameKind(buf);
    if (k === Frame.Event) {
      const e = decodePlayerEvent(buf);
      if (!e) return;
      // The horn is heard from the flag in the state frames; waves and shouts come this way, and so does gunfire.
      if (e.code >= PlayerEvent.Fire) this.fight.event(e.code, buf, performance.now());
      else this.remotes.get(e.id)?.hear(e.code, e.arg, performance.now());
      return;
    }
    if (k === Frame.World) {
      const what = buf.byteLength > 2 ? new Uint8Array(buf, 2, 1)[0] : 0;
      if (what === WorldKind.People) this.people.frame(buf, performance.now());
      else if (what === WorldKind.Police) this.police.world(buf, performance.now());
      else this.shared.frame(buf, performance.now());
      return;
    }
    if (k === Frame.ToHost) {
      const now = performance.now();
      if (!this.people.toHost(buf) && !this.police.toHost(buf, now) && !this.fight.toHost(buf, now)) this.shared.toHost(buf, now);
      return;
    }
    if (k === Frame.ToPlayer) { if (!this.police.toPlayer(buf)) this.cars.toPlayer(buf, performance.now()); return; }
    if (k !== Frame.State) return;
    const s = decodePlayerState(buf, this.inState);
    if (!s) return;
    this.remotes.get(s.id)?.push(s, performance.now());
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /** This browser's character or car, into this.out. */
  private gather(now: number): void {
    const p = this.game.player, o = this.out, v = p.vehicle, per = p.person;
    o.t = Math.floor(now) & 0xffff;
    o.flags = 0;
    if (v) {
      o.mode = PlayerMode.Driving;
      o.x = v.x; o.y = v.y; o.z = v.z; o.yaw = v.h;
      o.vx = v.vx; o.vz = v.vz;
      o.pitch = v.pitch; o.roll = v.roll;
      o.steer = v.ctl.steer;
      o.vehicle = KINDS.indexOf(v.spec.kind) + 1;
      o.color = v.color;
      o.pose = POSES.indexOf('sit');
      const sp = v.speed;
      if (v.ctl.accel < -0.05 && sp > 0.5 || v.ctl.handbrake) o.flags |= PlayerFlag.Braking;
      if (sp < -0.3 && v.ctl.accel < 0) o.flags |= PlayerFlag.Reversing;
      if (v.ctl.horn) o.flags |= PlayerFlag.Horn;
    } else {
      const pose = per.pose;
      o.mode = pose === 'down' ? PlayerMode.Down : p.swimming ? PlayerMode.Swimming : PlayerMode.OnFoot;
      o.x = per.x; o.y = per.y; o.z = per.z; o.yaw = per.h;
      // People face the way they go; the speed is what drives the stride on the other screens.
      o.vx = Math.sin(per.h) * per.speed; o.vz = Math.cos(per.h) * per.speed;
      o.pitch = 0; o.roll = 0; o.steer = 0; o.vehicle = 0; o.color = 0;
      o.pose = Math.max(0, POSES.indexOf(pose));
      if (per.bench) o.flags |= PlayerFlag.Bench;
      // The weapon she has up, for the others to put in her hand.
      o.flags |= p.weapons.raised << HELD_SHIFT;
    }
  }

  /** Has anything another screen would show moved since the last frame sent? Small enough not to be tripped by a car settling on its springs. */
  private changed(): boolean {
    const a = this.out, b = this.last;
    return a.mode !== b.mode || a.pose !== b.pose || a.flags !== b.flags || a.vehicle !== b.vehicle || a.color !== b.color
      || Math.abs(a.x - b.x) > 0.02 || Math.abs(a.z - b.z) > 0.02 || Math.abs(a.y - b.y) > 0.03
      || Math.abs(angleDiff(a.yaw, b.yaw)) > 0.008
      || Math.abs(a.vx - b.vx) > 0.25 || Math.abs(a.vz - b.vz) > 0.25
      || Math.abs(a.pitch - b.pitch) > 0.01 || Math.abs(a.roll - b.roll) > 0.01 || Math.abs(a.steer - b.steer) > 0.08;
  }

  private pump(now: number): void {
    const c = this.conn;
    if (c.status !== 'online' || this.remotes.size === 0) return;
    const state = this.game.state;
    // Nobody is shown to the others while still on the title card.
    if ((state === 'play' || state === 'paused') && now - this.stateAt >= SEND_MS - 4) {
      this.gather(now);
      if (this.force || this.changed()) {
        if (c.send(encodePlayerState(this.out, this.outBuf))) {
          Object.assign(this.last, this.out);
          this.force = false;
          this.stateAt = this.anyAt = now;
          this.statesSent++;
        }
      }
    }
    if (now - this.perfAt >= PERF_INTERVAL_MS) {
      const g = this.game;
      // (Hidden or paused: the game loop is stopped, and a host that simulates nothing freezes everybody's traffic.)
      const ms = document.hidden || g.state === 'paused' ? PERF_CANNOT_HOST_MS : g.gov.ms > 0 ? g.gov.ms : 1000 / Math.max(1, g.fps);
      if (c.send(encodeMsg({ t: 'perf', ms: Math.round(ms * 10) / 10 }))) this.perfAt = this.anyAt = now;
    }
    if (now - this.anyAt >= KEEPALIVE_MS && c.send(KEEPALIVE_FRAME)) this.anyAt = now;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.conn.status === 'off') return;
    const now = performance.now(), g = this.game;
    if (this.noteKind && !this.told[this.noteKind] && g.state === 'play') this.tellOnce(this.noteKind);
    this.pump(now);
    if (g.state === 'play' && g.input.hit('say')) this.sayCycle();
    if (this.remotes.size > 0) {
      const eye = g.view ? g.view.pos : g.camera.position;
      const night = g.sky.night;
      for (const r of this.remotes.values()) r.update(now, dt, eye, night);
    }
    // After the others have been placed: a host's drivers are told where they are.
    this.fight.update(now, dt);
    this.shared.update(now, dt);
    this.cars.update(now);
    this.people.update(now, dt);
    this.police.update(now);
  }

  /** "3 in town", under the cash slip; only while connected with somebody else here. */
  private showCount(): void {
    const n = this.remotes.size > 0 ? this.count : 0;
    if (n === this.countShown) return;
    this.countShown = n;
    if (!this.countEl) {
      if (n === 0) return;
      const cash = document.querySelector('#hud .hud-right .hud-cash');
      if (!cash) return;
      const el = this.countEl = document.createElement('div');
      el.className = 'hud-town hud-lbl';
      cash.insertAdjacentElement('afterend', el);
    }
    this.countEl.style.display = n ? '' : 'none';
    if (n) this.countEl.textContent = `${n} in town`;
  }

  // ── No seat, or no service today ───────────────────────────────────────────

  /** The resume time as this player's own clock shows it: "7:00 PM", or "19:00" where that is the custom. */
  private resumeText(): string {
    // To the minute: the two clocks (ours and the service's) were compared over a network.
    const t = Math.round(this.conn.resumeAt / 60000) * 60000;
    try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return new Date(t).toTimeString().slice(0, 5); }
  }

  /** The small line under the cash slip: there while waiting for a seat or for the service, gone once in town. */
  private showNote(): void {
    const c = this.conn;
    const kind: '' | 'full' | 'rest' = c.status === 'online' ? '' : c.resumeAt > 0 ? 'rest' : c.status === 'full' ? 'full' : '';
    const text = kind === 'rest' ? `Multiplayer resting\nBack at ${this.resumeText()}`
      : kind === 'full' ? `Town full${c.seats ? ` \u00b7 ${c.seats} of ${c.seats}` : ''}\nOn the waiting list` : '';
    this.noteKind = kind;
    if (text === this.noteShown) return;
    this.noteShown = text;
    if (!this.noteEl) {
      if (!text) return;
      const cash = document.querySelector('#hud .hud-right .hud-cash');
      if (!cash) { this.noteShown = ''; return; }
      const el = this.noteEl = document.createElement('div');
      el.className = 'hud-town hud-town-note hud-lbl';
      cash.insertAdjacentElement('afterend', el);
    }
    this.noteEl.style.display = text ? '' : 'none';
    this.noteEl.textContent = text;
  }

  /** One notice on entry, in the Harbor Authority's voice; after that the small line is all there is. */
  private tellOnce(kind: 'full' | 'rest'): void {
    this.told[kind] = true;
    const n = this.conn.seats || 8;
    this.game.hud.toast(kind === 'rest'
      ? `Multiplayer is resting until ${this.resumeText()}. Today's allowance of other people is used up. The city is yours alone.`
      : `Town is full: all ${n} berths are taken. You are on the waiting list. Until one opens, the city is yours alone.`, 9);
  }

  /** For the tests (window.__game.net()). */
  info(): Record<string, unknown> {
    const c = this.conn, r3 = (v: number): number => +v.toFixed(3);
    return {
      status: c.status, id: c.id, host: c.host, city: c.city, name: this.name, count: this.count, attempts: c.attempts,
      // service: which address of the list (-1 none yet). notice: 'full', 'rest' or ''. Times are ms since 1970 on
      // this browser's clock: resumeAt when a resting service resumes, restUntil when it will next be asked,
      // retryAt when a full town will next be asked.
      // home: 'main' or 'backup', whichever is in use or was last tried. lookups: times the backup was asked where main is.
      // probes: background tries of main while on the backup. moves: times one of them moved this browser to main.
      // redirects: times the backup said "go to main".
      home: c.home, lookups: c.lookups, probes: c.probes, moves: c.moves, redirects: c.redirects,
      service: c.service, notice: this.noteKind, noteText: this.noteShown, seats: c.seats,
      resumeAt: c.resumeAt, restUntil: c.restUntil, retryAt: c.status === 'full' ? c.retryAt : 0,
      sent: { ...c.sent, states: this.statesSent }, got: { ...c.got },
      // traffic: mode ('local' | 'host' | 'guest'), World frames and bytes sent and received, and the shared cars with their numbers.
      traffic: this.shared.info(),
      // cars: the parked places (how many, how many the town counts as empty) and the counts of asking, granting and leaving.
      cars: this.cars.info(),
      // people: mode, frames and bytes, and the shared pedestrians with their numbers (people.ts).
      people: this.people.info(),
      // police: mode, this player's own level, the cars and officers with their numbers and whom they are after (police.ts).
      police: this.police.info(),
      // fight: shots and claims sent and heard, and the weapon in each other player's hand (fight.ts).
      fight: this.fight.info(),
      saysSent: this.saysSent, lastSay: this.lastSay, radarDots: this.game.hud.peerDots.slice(),
      countText: this.countEl && this.countEl.style.display !== 'none' ? this.countEl.textContent : '',
      remotes: [...this.remotes.values()].map((r) => ({
        id: r.id, name: r.text, seen: r.seen, frames: r.frames,
        x: r3(r.x), y: r3(r.y), z: r3(r.z), h: r3(r.h), speed: r3(r.speed),
        mode: r.mode, pose: r.pose, vehicle: r.kind, color: r.color, label: r.labelShown,
        horns: r.horns, hornOn: r.horn, said: r.said, lastSaid: r.lastSaid, sayShown: r.sayShown, saidCount: r.saidCount,
      })),
    };
  }
}
