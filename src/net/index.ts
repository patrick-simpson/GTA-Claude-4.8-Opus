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
// Stage 3, step 4: a car's damage, fire and wreck are seen by everybody (the bits were spare; shared.ts, remote.ts,
// ent/weapons.ts), and on the main service street furniture knocked over is down for everybody (props.ts).
//
// Stage 4, step 1 (town.ts): the hour and the weather are the town's on both services, worked out from the service's
// clock without a message; on the main service the bridge and the far town's stages are the town's too.
//
// Stage 4, step 2 (held.ts): each player runs their own missions and jobs; a car one of them is holding stays its
// runner's, is shown to the others as theirs, and is taken away for everybody when the script takes it away.
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
import { KINDS, isBoatKind } from '../ent/vehicleSpecs';
import { DAMAGE_BYTES, damageOf, pack } from '../ent/carDamage';
import {
  HELD_SHIFT, KEEPALIVE_FRAME, KEEPALIVE_MS, PERF_CANNOT_HOST_MS, PERF_INTERVAL_MS, PLAYER_STATE_BYTES, POSES, PlayerFlag, PlayerMode, SEND_HZ,
  Frame, PlayerEvent, RAG_FLOATS, RAG_TAIL_BYTES, readRagTail, writeRagTail, DMG_TAIL_BYTES, readDmgTail, writeDmgTail, WorldKind, blankPlayerState, damageNibble, decodePlayerEvent, decodePlayerState, encodePlayerEvent, encodeLookEvent, decodeLookEvent, encodeMsg, encodePlayerState, frameKind,
  type PlayerEntry, type ServerMsg, type WelcomeMsg,
} from './protocol';
import { Connection, servicePlan, type NetStatus } from './conn';
import { Remote } from './remote';
import { SharedTraffic } from './shared';
import { TownCars } from './cars';
import { TownPeople } from './people';
import { TownPolice } from './police';
import { TownFight } from './fight';
import { TownProps } from './props';
import { Town } from './town';
import { TownHeld } from './held';
import { TownCrew } from './crew';
import { TownJobs } from './jobs';
import { TownRide } from './ride';
import { TownRace } from './race';
import { TownRaces } from './townRaces';
import { TownPursuit } from './pursuit';
import { TownCoop } from './coop';
import { TownDerby } from './derby';
import { TownExtras } from './extras';
import { TownChat } from './chat';
import { SAYS, myName, nameText, rerollName } from './names';
import { hostBotPass } from './hostbot';
import { encodeLook, myLook, onMyLook } from '../game/looks';
import { emoteOf } from '../ent/character';

const SEND_MS = 1000 / SEND_HZ;
/** The fewest ms between two things said by this player. */
export const SAY_GAP_MS = 2000;
/** Stage 4, step 5: with others in town, no pausing while wanted at this level or more... */
export const PAUSE_HEAT = 2;
/** ...or within this long (game seconds) of being hurt. */
export const PAUSE_HIT_S = 4;

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
  /** The street furniture cars knock over: down for one, down for all (stage 3, step 4). */
  readonly props: TownProps;
  /** The town's hour, weather and bridge (stage 4, step 1). */
  readonly town: Town;
  /** The cars missions and jobs are holding: their runner's own, and shown to the others as that (stage 4, step 2). */
  readonly held: TownHeld;
  /** Missions done together: who is on whose crew, what they are shown, the pay, and the mission car lent (stage 4, step 3). */
  readonly crew: TownCrew;
  /** Jobs shown to the others where their runner has them: a fare, the parcels, the car on the hook (stage 4, step 5). */
  readonly jobs: TownJobs;
  /** Races between players (fun queue item 11): the wire and the town's records. */
  readonly race: TownRace;
  readonly built: TownRaces;
  /** Hot Pursuit (fun queue item 12): the wire and the town's records. */
  readonly pursuit: TownPursuit;
  /** Co-op missions (fun queue 2, item 23): the wire; the missions are game/coop.ts. */
  readonly coop: TownCoop;
  /** The demolition derby (fun queue item 13): the wire and the town's records. */
  readonly derby: TownDerby;
  /** Shared fireworks you light yourself and the pushed loose duck (extras.ts). */
  readonly extras: TownExtras;
  /** Safe chat: phrase and place indices only, with mute and rate limits (chat.ts; game/chat.ts is the screen). */
  readonly chat: TownChat;
  /** Riding together: this player in another's car, or others in this player's (ride.ts). */
  readonly ride: TownRide;
  /** This page is the mini PC's host bot (hostbot.ts): no player, nothing drawn, the town's host. */
  readonly isBot: boolean;
  /** State frames sent, apart from the totals in conn.sent. */
  statesSent = 0;

  private readonly out = blankPlayerState();
  private readonly last = blankPlayerState();
  private readonly outBuf = new ArrayBuffer(PLAYER_STATE_BYTES);
  /** The same with a ragdoll tail, while this player's own ragdoll flies (protocol writeRagTail). */
  private readonly outRag = new ArrayBuffer(PLAYER_STATE_BYTES + RAG_TAIL_BYTES);
  private readonly ragOut = new Float32Array(RAG_FLOATS);
  private readonly ragIn = new Float32Array(RAG_FLOATS);
  private readonly inState = blankPlayerState();
  /** Send the next state whether or not it changed: somebody has just arrived and knows nothing about us. */
  private force = true;
  /** Send this player's look (game/looks.ts) at the next chance: on arriving, when somebody arrives, when it changes. */
  private lookDue = true;
  private lookAt = -1e9;
  /** Look frames sent and received, for the tests. */
  looksSent = 0; looksGot = 0;
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
    c.bot = hostBotPass();
    this.isBot = c.bot !== '';
    c.onWelcome = (m) => this.welcome(m);
    c.onMsg = (m) => this.msg(m);
    onMyLook(() => { this.lookDue = true; });
    c.onFrame = (b) => this.frame(b);
    c.onDown = () => { this.town.down(); this.clear(); };
    c.onChange = () => this.showNote();
    this.shared = new SharedTraffic(game, c, this.remotes);
    this.cars = new TownCars(game, c, this.remotes, this.shared);
    this.people = new TownPeople(game, c, this.remotes, this.shared);
    this.police = new TownPolice(game, c, this.remotes, this.shared, this.people);
    this.fight = new TownFight(game, c, this.remotes, this.shared, this.cars);
    this.props = new TownProps(game, c, this.remotes, this.shared);
    this.town = new Town(game, c, this.remotes);
    this.held = new TownHeld(game, c, this.remotes, this.shared, this.cars);
    this.fight.held = this.held;
    this.crew = new TownCrew(game, c, this.remotes, this.held, this.cars);
    this.shared.heldCars = () => this.held.list();
    this.jobs = new TownJobs(game, c, this.remotes, this.held);
    this.race = new TownRace(game, c, this.remotes);
    this.built = new TownRaces(game, c, this.remotes);
    this.race.custom = this.built;
    this.pursuit = new TownPursuit(game, c, this.remotes);
    this.coop = new TownCoop(game, c, this.remotes);
    this.derby = new TownDerby(game, c, this.remotes);
    this.extras = new TownExtras(game, c, this.remotes);
    this.chat = new TownChat(game, c, this.remotes);
    this.ride = new TownRide(game, c, this.remotes);
    this.fight.crewHit = (v, dmg) => this.crew.hitHeld(v, dmg);
    this.fight.crewMate = (id) => this.crew.onTeam(id);
    // A paused game simulates nothing, so it says at once that it cannot host (and, on resuming, that it can again).
    // The others are told at once too (the Paused flag in the next state frame).
    game.on('pause', () => { this.perfAt = 0; this.stateAt = 0; });
    // Pause is no shield: refused while wanted at PAUSE_HEAT or more, or within PAUSE_HIT_S of being hurt, when
    // anybody else is in town (alone it is the menu it always was).
    game.pauseGuard = () => this.pauseRefusal();
    c.start();
    this.showNote();
    // The game's own loop stops while paused and in a hidden tab; the keepalive must not.
    if (c.status !== 'off') setInterval(() => { this.pump(performance.now()); c.flush(); }, 500);
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

  /** Emotes (game/emotes.ts): frames sent and heard. */
  emotesSent = 0;
  emotesGot = 0;
  /**
   * Tell everybody this player has started emote `id` (game/emotes.ts EMOTES), or stopped (0). One 4 byte Event frame,
   * only when somebody is here to see it. Returns whether it went.
   */
  emote(id: number): boolean {
    if (!this.canSay || !Number.isInteger(id) || id < 0 || id > 255) return false;
    if (!this.conn.send(encodePlayerEvent(PlayerEvent.Emote, id))) return false;
    this.emotesSent++;
    return true;
  }

  /** Fast travel puffs: events sent and heard. */
  cabsSent = 0;
  cabsGot = 0;
  /** Fast travel (game/travel.ts): tell the others this player is leaving (0) or has arrived (1), for the taxi-drop puff. */
  cab(arg: 0 | 1): boolean {
    if (!this.canSay) return false;
    if (!this.conn.send(encodePlayerEvent(PlayerEvent.Cab, arg))) return false;
    this.cabsSent++;
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

  /** Why this player may not pause now (null: they may). Only with somebody else in town: pause must not be a shield. */
  pauseRefusal(): string | null {
    if (this.conn.status !== 'online' || this.remotes.size === 0) return null;
    const g = this.game, p = g.player;
    if (p.heat >= PAUSE_HEAT) return 'No pausing with the Harbor Patrol this keen. Lose them first.';
    if (g.time - p.hurtT < PAUSE_HIT_S) return 'No pausing in the middle of a fight. Get clear first.';
    return null;
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
    this.lookDue = true;
    this.shared.refresh();
    this.cars.refresh();
    this.people.refresh();
    this.props.refresh();
    this.held.refresh();
    this.jobs.refresh();
    this.ride.refresh();
    this.race.refresh();
    this.pursuit.refresh();
    this.coop.refresh();
    this.derby.refresh();
  }

  private drop(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    // (A car another player lent them for a mission goes back to that player, who stands it again: crew.ts. Not a stray.)
    this.ride.dropped(id);
    if (!this.crew.borrowing(id)) this.cars.dropped(r, performance.now());
    this.fight.dropped(id);
    this.crew.dropped(id);
    this.jobs.dropped(id);
    this.race.dropped(id);
    this.built.dropped(id);
    this.pursuit.dropped(id);
    this.coop.dropped(id);
    this.derby.dropped(id);
    this.extras.dropped(id);
    this.chat.dropped(id);
    this.held.dropped(id);
    r.dispose();
    this.remotes.delete(id);
  }

  private clear(): void {
    this.ride.clear();
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.fight.clear();
    this.crew.clear();
    this.jobs.clear();
    this.race.clear();
    this.built.clear();
    this.pursuit.clear();
    this.coop.clear();
    this.derby.clear();
    this.held.clear();
    this.chat.clear();
    this.showCount();
  }

  private welcome(m: WelcomeMsg): void {
    this.clear();
    for (const e of m.players) this.add(e);
    const now = performance.now();
    this.shared.welcome(m.now, now);
    this.town.welcome(m, now);
    this.race.welcome(m.facts);
    this.built.welcome(m.facts);
    this.pursuit.welcome(m.facts);
    this.derby.welcome(m.facts);
    this.force = true;
    this.anyAt = now; this.perfAt = now - PERF_INTERVAL_MS + 1000;
    this.showCount();
  }

  private msg(m: ServerMsg): void {
    if (m.t === 'join') this.add([m.id, ...m.name]);
    else if (m.t === 'leave') this.drop(m.id);
    else if (m.t === 'name' && 'id' in m) this.remotes.get(m.id)?.rename(m.name.slice());
    else if (m.t === 'fact' || m.t === 'host') { this.town.msg(m); if (m.t === 'fact') { this.race.fact(m.k, m.v); this.built.fact(m.k, m.v); this.pursuit.fact(m.k, m.v); this.derby.fact(m.k, m.v); } }
    this.showCount();
  }

  private frame(buf: ArrayBuffer): void {
    const k = frameKind(buf);
    if (k === Frame.Event) {
      const e = decodePlayerEvent(buf);
      if (!e) return;
      // The horn is heard from the flag in the state frames; waves and shouts come this way, and so does gunfire.
      if (e.code === PlayerEvent.Look) {
        const l = decodeLookEvent(buf);
        if (l) { this.looksGot++; this.remotes.get(l.id)?.setLook(l.look); }
        return;
      }
      if (e.code === PlayerEvent.Cab) {
        const r = this.remotes.get(e.id);
        this.cabsGot++;
        if (r && r.seen) {
          const fx = this.game.fx.emitters;
          for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2, s = 1.4 + (i % 3) * 0.5; fx.dust(r.x + Math.sin(a) * 0.8, r.y + 0.2, r.z + Math.cos(a) * 0.8, Math.sin(a) * s, Math.cos(a) * s, 0.7, false); }
          fx.sparks(r.x, r.y + 1, r.z, 0, 1, 0, 6, 4);
        }
        return;
      }
      if (e.code === PlayerEvent.Emote) {
        const r = this.remotes.get(e.id);
        if (r) { r.emote = e.arg; r.emoteAt = performance.now(); r.emoteN++; this.emotesGot++; }
        return;
      }
      if (e.code === PlayerEvent.Ride || e.code === PlayerEvent.Seats) this.ride.event(buf);
      else if (e.code === PlayerEvent.Held) this.held.event(buf, performance.now());
      else if (e.code === PlayerEvent.Crew) this.crew.event(buf);
      else if (e.code === PlayerEvent.Job) this.jobs.event(buf);
      else if (e.code === PlayerEvent.Prop) this.props.event(buf);
      else if (e.code === PlayerEvent.Race) this.race.event(buf);
      else if (e.code === PlayerEvent.Built) this.built.event(buf);
      else if (e.code === PlayerEvent.Pursuit) this.pursuit.event(buf);
      else if (e.code === PlayerEvent.Coop) this.coop.event(buf);
      else if (e.code === PlayerEvent.Derby) this.derby.event(buf);
      else if (e.code === PlayerEvent.Fireworks || e.code === PlayerEvent.Duck) this.extras.event(buf);
      else if (e.code === PlayerEvent.Chat) this.chat.event(buf);
      else if (e.code >= PlayerEvent.Fire) this.fight.event(e.code, buf, performance.now());
      else if (!this.chat.muted(e.id)) this.remotes.get(e.id)?.hear(e.code, e.arg, performance.now());
      return;
    }
    if (k === Frame.World) {
      const what = buf.byteLength > 2 ? new Uint8Array(buf, 2, 1)[0] : 0;
      if (what === WorldKind.People) this.people.frame(buf, performance.now());
      else if (what === WorldKind.Police) this.police.world(buf, performance.now());
      else {
        this.shared.frame(buf, performance.now());
        if (what === WorldKind.Props) this.props.world(buf);
      }
      return;
    }
    if (k === Frame.ToHost) {
      const now = performance.now();
      if (this.town.toHost(buf)) return;
      if (!this.people.toHost(buf) && !this.police.toHost(buf, now) && !this.fight.toHost(buf, now)) this.shared.toHost(buf, now);
      return;
    }
    if (k === Frame.ToPlayer) { if (!this.police.toPlayer(buf)) this.cars.toPlayer(buf, performance.now()); return; }
    if (k !== Frame.State) return;
    const s = decodePlayerState(buf, this.inState);
    if (!s) return;
    const r = this.remotes.get(s.id);
    if (!r) return;
    r.push(s, performance.now());
    if (readRagTail(buf, s, this.ragIn)) r.pushRag(this.ragIn, performance.now());
    else if (readDmgTail(buf, r.dmgTail)) r.hasDmg = true;
  }

  // ── Car damage (Nov 23; ent/carDamage.ts, protocol.ts writeDmgTail) ─────────

  private readonly outDmg = new ArrayBuffer(PLAYER_STATE_BYTES + DMG_TAIL_BYTES);
  private readonly dmgNow = new Uint8Array(DAMAGE_BYTES);
  private readonly dmgSent = new Uint8Array(DAMAGE_BYTES);
  private readonly dmgView = new DataView(this.dmgNow.buffer);
  /** Driving one of the cars (not a boat): its damage into dmgNow. Returns false on foot, in a boat or as a passenger. */
  private gatherDamage(): boolean {
    const v = this.game.player.vehicle;
    if (!v || this.out.mode !== PlayerMode.Driving || isBoatKind(v.spec.kind) || v.spec.kind === 'train') return false;
    pack(damageOf(v), this.dmgView, 0);
    return true;
  }
  private damageChanged(): boolean {
    for (let i = 0; i < DAMAGE_BYTES; i++) if (this.dmgNow[i] !== this.dmgSent[i]) return true;
    return false;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /** This browser's character or car, into this.out. */
  private gather(now: number): void {
    const p = this.game.player, o = this.out, v = p.vehicle, per = p.person;
    o.t = Math.floor(now) & 0xffff;
    // (In the pause menu: the others draw a sign over this player and leave them be. Stage 4, step 5.)
    // (Photo mode, fx/photo.ts, stops the simulation like a pause, and says so.)
    o.flags = this.game.state === 'paused' || this.game.photo?.open || this.game.spectate?.on ? PlayerFlag.Paused : 0;
    const ride = this.ride.riding, rv = p.riding, bus = this.game.bus.rider ?? this.game.rail.rider ?? this.game.ferry.rider;
    if (bus && rv && !v) {
      // A passenger of the Harbor Line (sim/bus.ts) or the Budget Line (sim/rail.ts, ids from 129) or the Calamity Shuttle (sim/ferry.ts, 140 and 141): no driver (vehicle 0), the bus's number and the seat in `color`. Every
      // screen puts them in that seat of that bus from the shared clock, so a seated rider costs keepalives only.
      o.mode = PlayerMode.Passenger;
      o.x = per.x; o.y = per.y; o.z = per.z; o.yaw = rv.h;
      o.vx = rv.vx; o.vz = rv.vz;
      o.pitch = 0; o.roll = 0; o.steer = 0; o.damage = 0;
      o.vehicle = 0; o.color = (bus.id << 8) | bus.seat;
      o.pose = POSES.indexOf('sit');
      o.flags |= PlayerFlag.Bench | (p.weapons.raised << HELD_SHIFT);
    } else if (ride && rv && !v) {
      // A passenger (ride.ts): whose car and which seat. Where they are follows from the car on every screen.
      o.mode = PlayerMode.Passenger;
      o.x = per.x; o.y = per.y; o.z = per.z; o.yaw = rv.h;
      o.vx = rv.vx; o.vz = rv.vz;
      o.pitch = 0; o.roll = 0; o.steer = 0; o.damage = 0;
      o.vehicle = ride.driver; o.color = ride.seat;
      o.pose = POSES.indexOf('sit');
      o.flags |= PlayerFlag.Bench | (p.weapons.raised << HELD_SHIFT);
    } else if (v) {
      o.mode = PlayerMode.Driving;
      o.x = v.x; o.y = v.y; o.z = v.z; o.yaw = v.h;
      o.vx = v.vx; o.vz = v.vz;
      o.pitch = v.pitch; o.roll = v.roll;
      o.steer = v.ctl.steer;
      o.vehicle = KINDS.indexOf(v.spec.kind) + 1;
      o.color = v.color;
      o.pose = POSES.indexOf('sit');
      // How bent it is, for the others to show: steam, smoke, fire and the wreck all follow from it (stage 3, step 4).
      o.damage = damageNibble(v.health, !!v.wreck);
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
      o.pitch = 0; o.roll = 0; o.steer = 0; o.vehicle = 0; o.color = 0; o.damage = 0;
      o.pose = Math.max(0, POSES.indexOf(pose));
      if (per.bench) o.flags |= PlayerFlag.Bench;
      // The weapon she has up, for the others to put in her hand.
      o.flags |= p.weapons.raised << HELD_SHIFT;
    }
  }

  /** Has anything another screen would show moved since the last frame sent? Small enough not to be tripped by a car settling on its springs. */
  private changed(): boolean {
    const a = this.out, b = this.last;
    // (A passenger is placed from the car on every screen: only who, where and what they hold counts.)
    if (a.mode === PlayerMode.Passenger && b.mode === PlayerMode.Passenger) return a.vehicle !== b.vehicle || a.color !== b.color || a.flags !== b.flags;
    return a.mode !== b.mode || a.pose !== b.pose || a.flags !== b.flags || a.vehicle !== b.vehicle || a.color !== b.color || a.damage !== b.damage
      || Math.abs(a.x - b.x) > 0.02 || Math.abs(a.z - b.z) > 0.02 || Math.abs(a.y - b.y) > 0.03
      || Math.abs(angleDiff(a.yaw, b.yaw)) > 0.008
      || Math.abs(a.vx - b.vx) > 0.25 || Math.abs(a.vz - b.vz) > 0.25
      || Math.abs(a.pitch - b.pitch) > 0.01 || Math.abs(a.roll - b.roll) > 0.01 || Math.abs(a.steer - b.steer) > 0.08;
  }

  private pump(now: number): void {
    const c = this.conn;
    // (The bot keeps saying it is alive even alone, so the service never takes it for stalled when a player arrives.)
    if (c.status !== 'online' || (this.remotes.size === 0 && !this.isBot)) return;
    const state = this.game.state;
    // Nobody is shown to the others while still on the title card.
    if ((state === 'play' || state === 'paused') && now - this.stateAt >= SEND_MS - 4) {
      this.gather(now);
      const dmg = this.gatherDamage();
      if (dmg && this.damageChanged()) this.force = true;
      if (this.force || this.changed() || this.game.people.rag.flying(this.game.player.person)) {
        const rag = this.game.people.rag.sample(this.game.player.person, this.ragOut);
        if (rag) { encodePlayerState(this.out, this.outRag); writeRagTail(this.outRag, this.out, this.ragOut); }
        else if (dmg) { encodePlayerState(this.out, this.outDmg); writeDmgTail(this.outDmg, this.dmgNow); this.dmgSent.set(this.dmgNow); }
        if (c.send(rag ? this.outRag : dmg ? this.outDmg : encodePlayerState(this.out, this.outBuf))) {
          Object.assign(this.last, this.out);
          this.force = false;
          this.stateAt = this.anyAt = now;
          this.statesSent++;
        }
      }
    }
    // The look: 27 bytes, now and then. A burst of arrivals is answered once (lookAt).
    if (this.lookDue && !this.isBot && now - this.lookAt >= 400 && c.send(encodeLookEvent(encodeLook(myLook())))) {
      this.lookDue = false; this.lookAt = this.anyAt = now; this.looksSent++;
    }
    if (now - this.perfAt >= PERF_INTERVAL_MS) {
      const g = this.game;
      // (Hidden or paused: the game loop is stopped, and a host that simulates nothing freezes everybody's traffic.)
      const ms = document.hidden || g.state === 'paused' || g.photo?.open || g.spectate?.on ? PERF_CANNOT_HOST_MS : g.gov.ms > 0 ? g.gov.ms : 1000 / Math.max(1, g.fps);
      if (c.send(encodeMsg({ t: 'perf', ms: Math.round(ms * 10) / 10 }))) this.perfAt = this.anyAt = now;
    }
    if (now - this.anyAt >= KEEPALIVE_MS && c.send(KEEPALIVE_FRAME)) this.anyAt = now;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    // (Alone too, with no service at all: a Bolt always waiting at the start.)
    if (this.game.state === 'play') this.cars.keepBolt(performance.now());
    if (this.conn.status === 'off') return;
    // (The frame's own time, not the moment this line runs: the work done earlier in the frame varies, and with it
    // where everything shown from the network would be placed. core/game.ts frameTime.)
    const now = this.game.frameTime(), g = this.game;
    if (this.noteKind && !this.told[this.noteKind] && g.state === 'play') this.tellOnce(this.noteKind);
    // (Before this player's own state goes: a car they have this moment got out of is in the list by then.)
    this.held.update(now, dt);
    this.crew.update(now);
    this.jobs.update(now);
    this.pump(now);
    if (g.state === 'play' && g.input.hit('say')) this.sayCycle();
    if (this.remotes.size > 0) {
      const eye = g.view ? g.view.pos : g.camera.position;
      const night = g.sky.night;
      for (const r of this.remotes.values()) r.update(now, dt, eye, night);
    }
    // (Once the cars are placed: the passengers go in their seats, this player among them.)
    this.ride.update(now);
    this.jobs.seat();
    // After the others have been placed: a host's drivers are told where they are.
    this.fight.update(now, dt);
    this.shared.update(now, dt);
    this.cars.update(now);
    this.people.update(now, dt);
    this.police.update(now);
    this.props.update(now);
    this.town.update(now);
    // Everything this frame said goes as one message (conn.ts: Frame.Bundle, when the service takes it).
    this.conn.flush();
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
      // props: street furniture down on this browser, and what was said and heard about it (props.ts).
      props: this.props.info(),
      // town: the hour and weather on this screen and the town's, the bridge as the service holds it, as shown and this player's own (town.ts).
      town: this.town.info(),
      // held: the cars scripts hold for this player (`mine`) and the other players' as drawn here (`theirs`), and the lists sent and heard (held.ts).
      held: this.held.info(),
      // crew: missions done together: the crew this player drafted, whose crew they are on and what they are shown (crew.ts).
      crew: this.crew.info(),
      // jobs: what this player's job shows the others, and theirs as shown here (jobs.ts). pause: this player's guard (index.ts).
      jobs: this.jobs.info(),
      // race: frames, the town's records as this page knows them, and the race on this screen (game/race.ts).
      race: this.race.info(),
      built: this.built.info(),
      // pursuit: Hot Pursuit frames, the town's records, and the round on this screen (game/pursuit.ts).
      pursuit: this.pursuit.info(),
      coop: this.coop.info(),
      derby: this.derby.info(),
      extras: this.extras.info(),
      chat: this.chat.info(),
      // ride: riding together: this player's seat in another's car, the riders in this player's car, the lists heard (ride.ts).
      ride: this.ride.info(),
      pause: { refused: this.game.pauseRefused, why: this.pauseRefusal(), state: this.game.state },
      // looks (game/looks.ts): this player's descriptor and their body as drawn here; frames sent and heard.
      looks: { sent: this.looksSent, got: this.looksGot, mine: Array.from(encodeLook(myLook())), drawn: JSON.stringify(this.game.player.person.look) },
      emotesSent: this.emotesSent, emotesGot: this.emotesGot,
      saysSent: this.saysSent, lastSay: this.lastSay, radarDots: this.game.hud.peerDots.slice(),
      countText: this.countEl && this.countEl.style.display !== 'none' ? this.countEl.textContent : '',
      remotes: [...this.remotes.values()].map((r) => ({
        id: r.id, name: r.text, seen: r.seen, frames: r.frames,
        x: r3(r.x), y: r3(r.y), z: r3(r.z), h: r3(r.h), speed: r3(r.speed),
        mode: r.mode, pose: r.pose, vehicle: r.kind, color: r.color, label: r.labelShown, rideOf: r.rideOf, rideSeat: r.rideSeat,
        body: r.body ? { x: r3(r.body.x), y: r3(r.body.y), z: r3(r.body.z), visible: r.body.visible, pose: r.body.pose } : null,
        car: r.vehicle ? { x: r3(r.vehicle.x), y: r3(r.vehicle.y), z: r3(r.vehicle.z), h: r3(r.vehicle.h) } : null,
        // Their car as shown here: the 16 steps of damage their browser sends, and the health and wreck made of it.
        damage: r.damage, carHealth: r.vehicle ? +r.vehicle.health.toFixed(1) : null, carWreck: !!r.vehicle?.wreck,
        look: r.look ? Array.from(encodeLook(r.look)) : null, drawn: r.body ? JSON.stringify(r.body.look) : '',
        carFinish: r.vehicle?.finish ?? 0, carRims: r.vehicle?.rims ?? 0, carHorn: r.vehicle?.hornKind ?? null,
        emote: r.emote, emoteN: r.emoteN, bodyEmote: r.body ? emoteOf(r.body) : 0, tunes: r.tunes,
        horns: r.horns, hornOn: r.horn, said: r.said, lastSaid: r.lastSaid, sayShown: r.sayShown, saidCount: r.saidCount,
      })),
    };
  }
}
