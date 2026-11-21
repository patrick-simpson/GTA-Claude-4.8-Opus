// Multiplayer, stage 1: see each other. One system in game.systems.
//
// What travels: this browser's own character, or the car it is driving (kind, colour, position, full orientation,
// speed, steering). Parked cars, traffic, pedestrians, police and everything else stay local to each browser until
// stage 2: another player's car is a drawn copy here (Vehicles.ghost), never one of this browser's simulated cars.
//
// Sending (protocol.ts has the rules): a State frame up to SEND_HZ times a second, but only when something has
// changed since the last one sent; a one byte keepalive every KEEPALIVE_MS otherwise; the measured frame time every
// PERF_INTERVAL_MS. Alone in the city, nothing at all is sent, so the city sleeps.

import type { Game } from '../core/game';
import { angleDiff } from '../core/util';
import { KINDS } from '../ent/vehicleSpecs';
import {
  KEEPALIVE_FRAME, KEEPALIVE_MS, PERF_CANNOT_HOST_MS, PERF_INTERVAL_MS, PLAYER_STATE_BYTES, POSES, PlayerFlag, PlayerMode, SEND_HZ,
  Frame, blankPlayerState, decodePlayerState, encodeMsg, encodePlayerState, frameKind,
  type PlayerEntry, type ServerMsg, type WelcomeMsg,
} from './protocol';
import { Connection, serviceUrl, type NetStatus } from './conn';
import { Remote } from './remote';
import { myName, nameText, rerollName } from './names';

const SEND_MS = 1000 / SEND_HZ;

export class Net {
  readonly conn: Connection;
  /** Everybody else in this city, by id. */
  readonly remotes = new Map<number, Remote>();
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
  private countEl: HTMLElement | null = null;
  private countShown = -1;

  constructor(private readonly game: Game) {
    const c = this.conn = new Connection(serviceUrl(), myName);
    c.onWelcome = (m) => this.welcome(m);
    c.onMsg = (m) => this.msg(m);
    c.onFrame = (b) => this.frame(b);
    c.onDown = () => this.clear();
    c.start();
    // The game's own loop stops while paused and in a hidden tab; the keepalive must not.
    if (c.status !== 'off') setInterval(() => this.pump(performance.now()), 500);
  }

  get status(): NetStatus { return this.conn.status; }
  get name(): string { return nameText(myName()); }
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
  }

  private drop(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.dispose();
    this.remotes.delete(id);
  }

  private clear(): void {
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.showCount();
  }

  private welcome(m: WelcomeMsg): void {
    this.clear();
    for (const e of m.players) this.add(e);
    const now = performance.now();
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
    if (frameKind(buf) !== Frame.State) return;
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
      const ms = document.hidden ? PERF_CANNOT_HOST_MS : g.gov.ms > 0 ? g.gov.ms : 1000 / Math.max(1, g.fps);
      if (c.send(encodeMsg({ t: 'perf', ms: Math.round(ms * 10) / 10 }))) this.perfAt = this.anyAt = now;
    }
    if (now - this.anyAt >= KEEPALIVE_MS && c.send(KEEPALIVE_FRAME)) this.anyAt = now;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.conn.status === 'off') return;
    const now = performance.now(), g = this.game;
    this.pump(now);
    if (this.remotes.size === 0) return;
    const eye = g.view ? g.view.pos : g.camera.position;
    const night = g.sky.night;
    for (const r of this.remotes.values()) r.update(now, dt, eye, night);
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

  /** For the tests (window.__game.net()). */
  info(): Record<string, unknown> {
    const c = this.conn, r3 = (v: number): number => +v.toFixed(3);
    return {
      status: c.status, id: c.id, host: c.host, city: c.city, name: this.name, count: this.count, attempts: c.attempts,
      sent: { ...c.sent, states: this.statesSent }, got: { ...c.got },
      countText: this.countEl && this.countEl.style.display !== 'none' ? this.countEl.textContent : '',
      remotes: [...this.remotes.values()].map((r) => ({
        id: r.id, name: r.text, seen: r.seen, frames: r.frames,
        x: r3(r.x), y: r3(r.y), z: r3(r.z), h: r3(r.h), speed: r3(r.speed),
        mode: r.mode, pose: r.pose, vehicle: r.kind, color: r.color, label: r.labelShown,
      })),
    };
  }
}
