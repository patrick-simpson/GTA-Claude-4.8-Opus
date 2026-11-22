// Multiplayer, stage 2, step 1: the same moving traffic for everyone.
//
// ONE browser, the host (the service names it), simulates the town's traffic exactly as a single player game does,
// but keeps it busy round EVERY player out of the one budget of cars, and sends the whole list ten times a second
// (protocol.ts, "World frames"). Every other browser, a guest, stops driving cars of its own and shows the host's:
// each is an ordinary car in vehicles.list, placed by the network instead of by physics (Vehicles.setShared), so it is
// drawn, heard, walked into and crashed into like any other, and it cannot be moved, damaged or entered from here.
// What a knock does to the car on the host is a later step.
//
// Only on the MAIN service. On the backup every message in is billed, so there the host sends no World frame at all
// and everybody keeps private traffic, as in stage 1. The same goes for single player.
//
// Changing hands. When the service names a new host, the old one (if it is still here) lets go of its cars in place
// and they become shown cars; the new one takes the wheel of the cars it was showing, each from where it stands with
// the speed it had (Traffic.adopt finds the lane). Numbers on the wire are kept, so the rest of the town sees the
// same cars carry on. A browser that drops to single player or to the backup takes its shown cars over the same way.
//
// Smoothing is the same as for the other players (remote.ts): shown INTERP_MS in the past, between two frames.
//
// Stage 2, step 2.
// The signals. In a town on the main service the lamps run on a TOWN clock instead of each browser's own game time
// (Game.signalClock). A browser's first idea of it is the service's clock from the welcome: one jump of the lamps.
// The host stamps every World frame with its town clock (the 16 bits that were its private clock before: same bytes),
// and a guest eases its own clock onto the host's as shown here, INTERP_MS back, so the lamps on a guest's screen are
// the ones the shown cars are obeying. Easing is a clock running a little fast or slow, never a second jump. A guest
// that becomes host keeps the clock it has, so the town's time outlives its hosts. On the backup, alone, or with no
// service the lamps run on game time as they always did; on leaving a town they carry on from where they were.
// Knocks. A guest's car stops against a shown car at once, on its own screen (the shown car cannot give way). It
// tells the host how hard and where (a 10 byte ToHost frame, protocol.ts), the host shoves and dents the real car and
// its driver reacts as to the host's own car, and that comes back to everybody in the World frames, damage included.
// The other players' cars are solid in the host's streets too (Vehicles.ghost), so its drivers cannot drive through them.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { angleDiff } from '../core/util';
import { KINDS, SPECS } from '../ent/vehicleSpecs';
import { Ambient } from '../sim/ambient';
import type { Anchor, RoadPed, Traffic } from '../sim/traffic';
import {
  CAR_HIT_BYTES, CAR_HIT_HZ, PlayerMode, TRAFFIC_CAR_BYTES, TRAFFIC_DAMAGE_SHIFT, TRAFFIC_HEADER_BYTES, TRAFFIC_MAX_CARS, ToHostKind, TrafficFlag, WORLD_HZ, WorldKind,
  blankTrafficCar, blankTrafficFrame, damageStep, decodeCarHit, decodeTraffic, encodeCarHit, encodeTraffic, frameSender, type TrafficCar,
} from './protocol';
import type { Connection } from './conn';
import { EXTRAP_MS, INTERP_MS, type Remote } from './remote';

const SEND_MS = 1000 / WORLD_HZ;
/** A car that has not changed is still sent whole this often, so nobody is left holding a stale one. */
const REFRESH_MS = 1000;
/** ...and a car nobody is in, standing where it was left, this often: there may be dozens, and they do not change. */
const REFRESH_LEFT_MS = 8000;
/** Frames further apart than this are a pause, not motion (as in remote.ts). */
const GAP_MS = 450;
const MOVE_MS = 100;
const KEEP = 8;
/** A guest's clock is eased onto the host's by running at most this much fast or slow. */
const SLEW = 0.2;
const HIT_MS = 1000 / CAR_HIT_HZ;
/** Closing speed below this (summed over one send interval) is leaning, not a knock: not worth a message. m/s. */
const HIT_MIN = 0.3;
/** A report from further than this from the car it names is not believed. Meters. */
const HIT_REACH = 25;
/** The 16 damage steps of the wire as health on a guest's screen: never low enough to set the shown car alight here. */
const HEALTH_STEP = 5;

interface Sample { t: number; x: number; y: number; z: number; yaw: number; speed: number; steer: number; pitch: number; roll: number; flags: number }
const blank = (): Sample => ({ t: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, steer: 0, pitch: 0, roll: 0, flags: 0 });

/** One of the host's cars, as shown here. */
interface Shown {
  wid: number; kind: number; paint: number;
  v: Vehicle;
  buf: Sample[];
  cur: Sample;
  /** The last frame that mentioned it. */
  seq: number;
}

/** What the host last sent about one car, and when it last went whole. */
interface Sent { rec: TrafficCar; at: number; seq: number }

export class SharedTraffic {
  /** local: private traffic (alone, single player, or on the backup). host: simulating for the town. guest: showing the host's. */
  mode: 'local' | 'host' | 'guest' = 'local';
  /** The host's cars shown here, by their number on the wire. Empty unless a guest. */
  readonly cars = new Map<number, Shown>();
  readonly stats = { framesSent: 0, bytesSent: 0, framesGot: 0, bytesGot: 0, adopted: 0, dropped: 0, takeovers: 0, handovers: 0, hitsSent: 0, hitBytesSent: 0, hitsGot: 0, hitsDone: 0 };

  private readonly traffic: Traffic | null;
  // Sending.
  private sendAt = 0;
  private force = true;
  private sendSeq = 0;
  private readonly sent = new Map<number, Sent>();
  private readonly recs: TrafficCar[] = [];
  private readonly order: TrafficCar[] = [];
  private readonly still = new Uint8Array(TRAFFIC_MAX_CARS);
  private readonly out = new Uint8Array(TRAFFIC_HEADER_BYTES + TRAFFIC_MAX_CARS * (TRAFFIC_CAR_BYTES + 1));
  private readonly anchors = new Map<number, Anchor & { lx: number; lz: number }>();
  private readonly anchorList: Anchor[] = [];
  private readonly others: Vehicle[] = [];
  private readonly walkers: RoadPed[] = [];
  private readonly walkerPool: RoadPed[] = [];
  // Receiving.
  private readonly inFrame = blankTrafficFrame();
  private seq = 0;
  private from = 0;
  private sendT = 0;
  private lastArrive = -1;
  private offset = 0;
  private clockLag = 0;
  // The town clock: performance.now() + townOff, ms since 1970 as the service counts them (near enough).
  private townOn = false;
  private townOff = 0;
  /** Where a guest's clock is being eased to; equal to townOff when there is nothing to follow. */
  private townWant = 0;
  private svcOff = 0;
  private clockAt = 0;
  /** Times the lamps were put on another clock at a stroke (for the tests): once per town joined. */
  signalJumps = 0;
  // Knocks: what this guest's car has done to shown cars since the last report, and when each guest last reported.
  private readonly byVeh = new Map<Vehicle, Shown>();
  private readonly struck = new Map<number, { vx: number; vz: number; rx: number; rz: number }>();
  private hitAt = 0;
  private readonly hitFrom = new Map<number, number>();
  // Stage 2, step 3 (cars.ts): the parked cars, and taking and leaving cars, hang on these.
  /** This browser has changed between local, host and guest; the cars have already changed hands. */
  onMode: ((was: 'local' | 'host' | 'guest', now: 'local' | 'host' | 'guest') => void) | null = null;
  /** Host: about to send a traffic frame. Anything that must reach the others first goes now. */
  onTick: ((now: number) => void) | null = null;
  /** Guest: a World frame from the host that is not traffic. */
  onWorld: ((buf: ArrayBuffer, now: number) => void) | null = null;
  /** Host: a ToHost frame that is not a knock on a traffic car. */
  onAsk: ((buf: ArrayBuffer, now: number) => void) | null = null;
  /** Guest: this browser's car has struck a shared car that is not in the traffic frames. */
  onOtherHit: ((b: Vehicle, cvx: number, cvz: number, rx: number, rz: number) => void) | null = null;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    const amb = game.systems.find((s): s is Ambient => s instanceof Ambient);
    this.traffic = amb ? amb.traffic : null;
    game.vehicles.onSharedHit = (b, cvx, cvz, rx, rz) => {
      const s = this.byVeh.get(b);
      if (this.mode !== 'guest') return;
      if (!s) { this.onOtherHit?.(b, cvx, cvz, rx, rz); return; }
      const h = this.struck.get(s.wid);
      if (h) { h.vx += cvx; h.vz += cvz; h.rx = rx; h.rz = rz; } else this.struck.set(s.wid, { vx: cvx, vz: cvz, rx, rz });
    };
  }

  // ── The town clock ──────────────────────────────────────────────────────────

  /** The service's clock, from its welcome (ms since 1970). now: this browser's clock at that moment. */
  welcome(serviceNow: number, now: number): void {
    if (Number.isFinite(serviceNow)) this.svcOff = serviceNow - now;
  }

  /** Switch the lamps onto the town clock or back, and ease a guest's clock toward the host's. */
  private clock(now: number): void {
    const c = this.conn, g = this.game;
    const on = c.status === 'online' && c.home === 'main';
    if (on !== this.townOn) {
      this.townOn = on;
      if (on) {
        this.townOff = this.townWant = this.svcOff;
        g.signalClock = () => (performance.now() + this.townOff) / 1000;
        this.signalJumps++;
      } else {
        // Alone again: the lamps carry on from where they are, on game time as before.
        g.signalShift = g.signalTime - g.time;
        g.signalClock = null;
      }
    }
    const dt = Math.min(1000, Math.max(0, now - this.clockAt));
    this.clockAt = now;
    if (!on) return;
    if (this.mode !== 'guest' || now - this.lastArrive > 2000 || this.lastArrive < 0) { this.townWant = this.townOff; return; }
    const d = this.townWant - this.townOff, step = SLEW * dt;
    this.townOff += d > step ? step : d < -step ? -step : d;
  }

  /** Somebody has just arrived and knows nothing: the next frame carries every car whole. */
  refresh(): void { this.force = true; }

  /** Is this browser in a town whose cars are shared (online on the main service)? */
  get town(): boolean { return this.townOn; }
  /** The traffic this browser simulates when it is the host or alone. */
  get sim(): Traffic | null { return this.traffic; }

  // ── Stage 2, step 3: one car changing between the host's and a player's (cars.ts) ──

  /** Guest: the number a shown car has in the traffic frames, or 0 when it is not one of them. */
  widOf(v: Vehicle): number { return this.byVeh.get(v)?.wid ?? 0; }
  /** Guest: the shown car with this number. */
  carOf(wid: number): Vehicle | null { return this.cars.get(wid)?.v ?? null; }
  /** Guest: this shown car is this browser's own now (the host granted it): forget it without taking it off the street. */
  claim(v: Vehicle): void {
    const s = this.byVeh.get(v);
    if (!s) return;
    this.cars.delete(s.wid);
    this.byVeh.delete(v);
    this.struck.delete(s.wid);
  }
  /**
   * Guest: a car that is already standing on this browser's street is, from now on, the host's car `wid` (a parked
   * car that was pushed, or the car this player has just got out of). False when that number is already shown.
   */
  adoptShown(wid: number, v: Vehicle): boolean {
    if (this.mode !== 'guest' || wid === 0 || this.cars.has(wid)) return false;
    this.game.vehicles.setShared(v, true);
    const s = this.show(wid, KINDS.indexOf(v.spec.kind), Math.max(0, v.spec.colors.indexOf(v.color)), v);
    const a = blank();
    a.t = performance.now(); a.x = v.x; a.y = v.y; a.z = v.z; a.yaw = v.h; a.pitch = v.pitch; a.roll = v.roll;
    a.flags = TrafficFlag.Driverless | (damageStep(v.health) << TRAFFIC_DAMAGE_SHIFT);
    s.buf.push(a);
    Object.assign(s.cur, a);
    return true;
  }

  // ── Who drives ─────────────────────────────────────────────────────────────

  /** Work out which of the three this browser is now, and change over if that is new. */
  private sync(): void {
    const c = this.conn, tr = this.traffic;
    if (!tr) return;
    const shared = c.status === 'online' && c.home === 'main';
    const want = shared && c.host !== 0 && c.host !== c.id ? 'guest' : shared && this.remotes.size > 0 ? 'host' : 'local';
    const was = this.mode;
    if (want === was) return;
    this.mode = want;
    const g = this.game;
    if (want === 'guest') {
      this.lastArrive = -1;
      this.from = 0;
      if (was === 'host') {
        // Still in town, no longer the host: the cars stay where they are and the new host's frames move them.
        const now = performance.now();
        tr.handOver((wid, v, driverless) => {
          g.vehicles.setShared(v, true);
          const s = this.show(wid, KINDS.indexOf(v.spec.kind), Math.max(0, v.spec.colors.indexOf(v.color)), v);
          const a = blank();
          a.t = now; a.x = v.x; a.y = v.y; a.z = v.z; a.yaw = v.h; a.speed = v.speed; a.pitch = v.pitch; a.roll = v.roll;
          a.flags = (driverless ? TrafficFlag.Driverless : 0) | (damageStep(v.health) << TRAFFIC_DAMAGE_SHIFT);
          s.buf.push(a);
          Object.assign(s.cur, a);
        });
        this.stats.handovers++;
      } else tr.clearCars();
      this.clearHost();
      this.onMode?.(was, want);
      return;
    }
    if (was === 'guest') {
      // The wheel is this browser's now: host of the town, or alone again (single player, or the backup).
      tr.resume();
      for (const s of this.cars.values()) {
        g.vehicles.setShared(s.v, false);
        if (tr.adopt(s.v, s.wid, (s.cur.flags & TrafficFlag.Driverless) !== 0)) this.stats.adopted++;
        else { g.vehicles.remove(s.v); this.stats.dropped++; }
      }
      this.cars.clear();
      this.byVeh.clear(); this.struck.clear();
      this.stats.takeovers++;
    }
    if (want === 'host') { this.force = true; this.sendAt = 0; } else this.clearHost();
    this.onMode?.(was, want);
  }

  /** Not (or no longer) simulating for anybody else. */
  private clearHost(): void {
    const tr = this.traffic;
    if (tr) { tr.extra = []; tr.others = []; tr.walkers = []; }
    this.anchors.clear();
    this.sent.clear();
    this.hitFrom.clear();
  }

  // ── Host: the other players as the drivers see them, and the frames ─────────

  private watch(): void {
    const tr = this.traffic as Traffic, list = this.anchorList, others = this.others, walkers = this.walkers;
    list.length = 0; others.length = 0; walkers.length = 0;
    for (const [id, a] of this.anchors) if (!this.remotes.get(id)?.seen) this.anchors.delete(id);
    for (const r of this.remotes.values()) {
      if (!r.seen) continue;
      let a = this.anchors.get(r.id);
      const isNew = !a;
      if (!a) this.anchors.set(r.id, a = { x: r.x, z: r.z, cx: r.x, cz: r.z, yaw: r.h, jumped: true, n: 0, lx: r.x, lz: r.z });
      a.x = r.x; a.z = r.z; a.yaw = r.h;
      // Their camera is not known: behind them, looking the way they face, is near enough.
      a.cx = r.x - Math.sin(r.h) * 6; a.cz = r.z - Math.cos(r.h) * 6;
      const jx = r.x - a.lx, jz = r.z - a.lz;
      a.jumped = isNew || jx * jx + jz * jz > 2500;
      a.lx = r.x; a.lz = r.z;
      list.push(a);
      const car = r.vehicle;
      if (car) others.push(car);
      else if (r.mode === PlayerMode.OnFoot || r.mode === PlayerMode.Down) {
        const w = this.walkerPool[walkers.length] ?? (this.walkerPool[walkers.length] = { x: 0, z: 0, vx: 0, vz: 0 });
        w.x = r.x; w.z = r.z; w.vx = r.vx; w.vz = r.vz;
        walkers.push(w);
      }
    }
    tr.extra = list; tr.others = others; tr.walkers = walkers;
  }

  private send(now: number): void {
    const tr = this.traffic as Traffic, recs = this.recs, sent = this.sent, seq = ++this.sendSeq;
    let n = 0;
    tr.eachShared((wid, v, driverless) => {
      if (n >= TRAFFIC_MAX_CARS) return;
      const r = recs[n] ?? (recs[n] = blankTrafficCar());
      n++;
      const sp = v.speed, ctl = v.ctl;
      r.id = wid;
      r.kind = KINDS.indexOf(v.spec.kind);
      r.paint = Math.max(0, v.spec.colors.indexOf(v.color));
      r.x = v.x; r.y = v.y; r.z = v.z; r.yaw = v.h;
      r.speed = Math.abs(sp) < 0.12 ? 0 : sp;
      r.steer = driverless ? 0 : ctl.steer;
      r.pitch = v.pitch; r.roll = v.roll;
      r.flags = (driverless ? TrafficFlag.Driverless
        : ((ctl.accel < -0.05 && sp > 0.5) || ctl.handbrake ? TrafficFlag.Braking : 0)
          | (sp < -0.3 && ctl.accel < 0 ? TrafficFlag.Reversing : 0) | (ctl.horn ? TrafficFlag.Horn : 0))
        | (damageStep(v.health) << TRAFFIC_DAMAGE_SHIFT);
    });
    // Whole records first, then the numbers of the cars that have not moved since theirs.
    const order = this.order, still = this.still;
    let nFull = 0, nStill = 0;
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      let s = sent.get(r.id);
      const b = s?.rec;
      const same = !!b && !this.force && now - (s as Sent).at < ((r.flags & TrafficFlag.Driverless) !== 0 ? REFRESH_LEFT_MS : REFRESH_MS) + (r.id % 8) * 40
        && b.kind === r.kind && b.paint === r.paint && b.flags === r.flags && b.speed === 0 && r.speed === 0
        && Math.abs(b.x - r.x) < 0.03 && Math.abs(b.z - r.z) < 0.03 && Math.abs(b.y - r.y) < 0.03
        && Math.abs(angleDiff(b.yaw, r.yaw)) < 0.004 && Math.abs(b.steer - r.steer) < 0.08
        && Math.abs(b.pitch - r.pitch) < 0.01 && Math.abs(b.roll - r.roll) < 0.01;
      if (!s) sent.set(r.id, s = { rec: blankTrafficCar(), at: now, seq });
      s.seq = seq;
      if (same) still[nStill++] = r.id;
      else { Object.assign(s.rec, r); s.at = now; order[nFull++] = r; }
    }
    for (const [id, s] of sent) if (s.seq !== seq) sent.delete(id);
    // Stamped with the town clock: it places the cars in time on the other screens, and it sets their lamps.
    const len = encodeTraffic(Math.floor(now + this.townOff), order, nFull, still, nStill, this.out);
    // (A view of exactly the bytes used: the socket sends the view, not the buffer behind it.)
    if (this.conn.send(this.out.subarray(0, len))) {
      this.force = false;
      this.stats.framesSent++; this.stats.bytesSent += len;
    }
  }

  // ── Guest: the host's cars ──────────────────────────────────────────────────

  private show(wid: number, kind: number, paint: number, v: Vehicle): Shown {
    const s: Shown = { wid, kind, paint, v, buf: [], cur: blank(), seq: this.seq };
    this.cars.set(wid, s);
    this.byVeh.set(v, s);
    return s;
  }

  private unshow(s: Shown): void {
    this.game.vehicles.remove(s.v);
    this.cars.delete(s.wid);
    this.byVeh.delete(s.v);
    this.struck.delete(s.wid);
  }

  // ── Knocks: a guest's car against one of the host's ─────────────────────────

  /** Guest: tell the host what this browser's car has just done to its cars. At most CAR_HIT_HZ frames a second. */
  private report(now: number): void {
    const st = this.struck;
    if (st.size === 0 || now - this.hitAt < HIT_MS - 4) return;
    for (const [wid, h] of st) {
      if (Math.hypot(h.vx, h.vz) < HIT_MIN) continue;
      if (this.conn.send(encodeCarHit(wid, h.vx, h.vz, h.rx, h.rz))) { this.stats.hitsSent++; this.stats.hitBytesSent += CAR_HIT_BYTES; }
      this.hitAt = now;
      // One car a turn; a second one struck in the same moment waits a tenth of a second.
      st.delete(wid);
      return;
    }
    st.clear();
  }

  /** Host: a ToHost frame. A guest's car has struck one of the cars simulated here. */
  toHost(buf: ArrayBuffer, now: number): void {
    const tr = this.traffic;
    if (this.mode !== 'host' || !tr) return;
    if (buf.byteLength > 2 && new Uint8Array(buf, 2, 1)[0] !== ToHostKind.CarHit) { this.onAsk?.(buf, now); return; }
    const h = decodeCarHit(buf);
    if (!h) return;
    this.stats.hitsGot++;
    const r = this.remotes.get(h.id);
    // Somebody known and seen, no faster than the rule allows, and no harder than a car can go.
    if (!r || !r.seen || now - (this.hitFrom.get(h.id) ?? -1e9) < HIT_MS * 0.5) return;
    const sp = Math.hypot(h.vx, h.vz);
    if (!(sp >= HIT_MIN) || sp > 80) return;
    let car: Vehicle | null = null;
    tr.eachShared((wid, v) => { if (wid === h.car) car = v; });
    const v = car as Vehicle | null;
    if (!v || Math.hypot(v.x - r.x, v.z - r.z) > HIT_REACH) return;
    this.hitFrom.set(h.id, now);
    this.game.vehicles.knock(v, r.vehicle, h.vx, h.vz, h.rx, h.rz);
    this.stats.hitsDone++;
  }

  /** A World frame. now: this browser's clock, ms. */
  frame(buf: ArrayBuffer, now: number): void {
    if (buf.byteLength < 3) return;
    const what = new Uint8Array(buf, 2, 1)[0];
    this.clock(now);
    this.sync();
    // Only the host's, and only while this browser is showing them.
    if (this.mode !== 'guest' || frameSender(buf) !== this.conn.host) return;
    if (what !== WorldKind.Traffic) { this.onWorld?.(buf, now); return; }
    const f = this.inFrame;
    if (!decodeTraffic(buf, f)) return;
    this.stats.framesGot++; this.stats.bytesGot += buf.byteLength;

    // The host's clock, unwrapped and placed on this one's, exactly as remote.ts does for a player.
    const from = frameSender(buf);
    if (this.lastArrive < 0 || from !== this.from || now - this.lastArrive > 20000) {
      // The 16 bits are the low end of the host's town clock: the whole of it is the one nearest this browser's own idea.
      const est = now + this.townOff;
      let lo = ((est - f.t) % 65536 + 65536) % 65536;
      if (lo >= 32768) lo -= 65536;
      this.sendT = est - lo; this.offset = this.clockLag = now - this.sendT; this.from = from;
    } else {
      const guess = this.sendT + (now - this.lastArrive);
      let t = guess - ((guess - f.t) % 65536 + 65536) % 65536;
      if (guess - t > 32768) t += 65536;
      if (t <= this.sendT) return;
      this.sendT = t;
      this.offset = Math.min(this.offset + 0.02 * (now - this.lastArrive), now - t);
      // The same for the lamps, but steadier: the quickest frame of the last minute or so is the best reading of the
      // host's clock, and a clock that wanders after every late frame would be a worse one.
      this.clockLag = Math.min(this.clockLag + 0.002 * (now - this.lastArrive), now - t);
    }
    this.lastArrive = now;
    // The lamps belong with the cars: the host's town clock as of the moment being shown here.
    this.townWant = -this.clockLag - INTERP_MS;
    const t = this.sendT + this.offset, seq = ++this.seq, g = this.game;

    for (let i = 0; i < f.n; i++) {
      const c = f.cars[i], kind = KINDS[c.kind];
      if (!kind || c.id === 0) continue;
      let s = this.cars.get(c.id);
      // The number has gone round to another car.
      if (s && (s.kind !== c.kind || s.paint !== c.paint)) { this.unshow(s); s = undefined; }
      if (!s) {
        const colors = SPECS[kind].colors;
        const v = g.vehicles.spawn(kind, c.x, c.z, c.yaw, colors[c.paint] ?? colors[0]);
        g.vehicles.setShared(v, true);
        s = this.show(c.id, c.kind, c.paint, v);
        this.place(s, c, 0);
      }
      s.seq = seq;
      const b = s.buf, prev = b.length ? b[b.length - 1] : null;
      if (prev) {
        const d = Math.hypot(c.x - prev.x, c.y - prev.y, c.z - prev.z), dt = Math.max(0.05, (t - prev.t) / 1000);
        const sp = Math.max(Math.abs(c.speed), Math.abs(prev.speed));
        // Further than its speed explains: take it at once.
        if (d > 6 + sp * Math.min(dt, 1) * 2) b.length = 0;
        else if (t - prev.t > GAP_MS) {
          // It stood still (only its number was sent) and has set off again: the move starts now, not back then.
          const hold = b.length >= KEEP ? (b.shift() as Sample) : blank();
          Object.assign(hold, prev);
          hold.t = t - MOVE_MS; hold.speed = 0;
          b.push(hold);
        }
      }
      const a = b.length >= KEEP ? (b.shift() as Sample) : blank();
      a.t = t; a.x = c.x; a.y = c.y; a.z = c.z; a.yaw = c.yaw; a.speed = c.speed; a.steer = c.steer;
      a.pitch = c.pitch; a.roll = c.roll; a.flags = c.flags;
      b.push(a);
    }
    for (let i = 0; i < f.nStill; i++) {
      const s = this.cars.get(f.still[i]);
      if (s) s.seq = seq;
    }
    // In neither part: it has gone (driven out of everybody's range, stolen, sunk).
    for (const s of this.cars.values()) if (s.seq !== seq) this.unshow(s);
  }

  /** Where a car is at `now - INTERP_MS`, into s.cur. */
  private sample(s: Shown, now: number): void {
    const buf = s.buf, c = s.cur, rt = now - INTERP_MS, n = buf.length;
    if (n === 0) return;
    const last = buf[n - 1];
    if (rt >= last.t) {
      Object.assign(c, last);
      const k = Math.min(rt - last.t, EXTRAP_MS) / 1000 * last.speed;
      c.x += Math.sin(last.yaw) * k; c.z += Math.cos(last.yaw) * k;
      // Nothing more is coming for now (it has stopped, or the host has): it is standing, not rolling.
      if (rt - last.t > EXTRAP_MS) c.speed = 0;
      return;
    }
    let i = n - 2;
    while (i > 0 && buf[i].t > rt) i--;
    const a = buf[Math.max(i, 0)], b = buf[Math.max(i, 0) + 1] ?? a;
    if (rt <= a.t || b === a) { Object.assign(c, a); return; }
    const k = (rt - a.t) / (b.t - a.t);
    Object.assign(c, k < 0.5 ? a : b);
    c.x = a.x + (b.x - a.x) * k; c.y = a.y + (b.y - a.y) * k; c.z = a.z + (b.z - a.z) * k;
    c.yaw = a.yaw + angleDiff(a.yaw, b.yaw) * k;
    c.speed = a.speed + (b.speed - a.speed) * k;
    c.steer = a.steer + (b.steer - a.steer) * k;
    c.pitch = a.pitch + (b.pitch - a.pitch) * k; c.roll = a.roll + (b.roll - a.roll) * k;
  }

  private place(s: Shown, c: Omit<Sample, 't'>, dt: number): void {
    const v = s.v, driverless = (c.flags & TrafficFlag.Driverless) !== 0;
    this.game.vehicles.ghostPose(v, c.x, c.y, c.z, c.yaw, c.pitch, c.roll, c.steer, c.speed,
      (c.flags & TrafficFlag.Braking) !== 0, (c.flags & TrafficFlag.Reversing) !== 0, dt);
    v.driver = driverless ? null : 'ai';
    if (driverless) v.lights = false;
    v.ctl.horn = (c.flags & TrafficFlag.Horn) !== 0;
    // Its health is the host's to count: what is shown is what the host last said, in steps.
    v.health = 100 - ((c.flags >> TRAFFIC_DAMAGE_SHIFT) & 15) * HEALTH_STEP;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number, dt: number): void {
    this.clock(now);
    if (!this.traffic) return;
    this.sync();
    if (this.mode === 'host') {
      this.watch();
      if (now - this.sendAt >= SEND_MS - 4) { this.sendAt = now; this.onTick?.(now); this.send(now); }
    } else if (this.mode === 'guest') {
      this.report(now);
      for (const s of this.cars.values()) {
        // Something on this side took it off the street (a reset tows bent cars): the host's next whole record puts it back.
        if (s.v.removed) { this.unshow(s); continue; }
        this.sample(s, now);
        this.place(s, s.cur, dt);
      }
    }
  }

  /** For the tests (window.__game.net().traffic). */
  info(): Record<string, unknown> {
    const r2 = (v: number): number => +v.toFixed(2), tr = this.traffic;
    const cars: Record<string, unknown>[] = [];
    if (this.mode === 'guest') for (const s of this.cars.values()) cars.push({ id: s.wid, kind: s.v.spec.kind, color: s.v.color, x: r2(s.v.x), z: r2(s.v.z), h: r2(s.v.h), speed: r2(s.cur.speed), driver: s.v.driver, health: r2(s.v.health) });
    else if (tr) tr.eachShared((wid, v, driverless) => cars.push({ id: wid, kind: v.spec.kind, color: v.color, x: r2(v.x), z: r2(v.z), h: r2(v.h), speed: r2(v.speed), driver: driverless ? null : 'ai', health: r2(v.health) }));
    // signal: is the town clock on, the signals' time now (s), and how many times the lamps changed clock at a stroke.
    const signal = { town: this.townOn, t: +this.game.signalTime.toFixed(3), jumps: this.signalJumps, easing: +(this.townWant - this.townOff).toFixed(1) };
    return { mode: this.mode, ...this.stats, anchors: this.anchorList.length + 1, signal, cars };
  }
}
