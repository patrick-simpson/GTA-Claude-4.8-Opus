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

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { angleDiff } from '../core/util';
import { KINDS, SPECS } from '../ent/vehicleSpecs';
import { Ambient } from '../sim/ambient';
import type { Anchor, RoadPed, Traffic } from '../sim/traffic';
import {
  PlayerMode, TRAFFIC_CAR_BYTES, TRAFFIC_HEADER_BYTES, TRAFFIC_MAX_CARS, TrafficFlag, WORLD_HZ, WorldKind,
  blankTrafficCar, blankTrafficFrame, decodeTraffic, encodeTraffic, frameSender, type TrafficCar,
} from './protocol';
import type { Connection } from './conn';
import { EXTRAP_MS, INTERP_MS, type Remote } from './remote';

const SEND_MS = 1000 / WORLD_HZ;
/** A car that has not changed is still sent whole this often, so nobody is left holding a stale one. */
const REFRESH_MS = 1000;
/** Frames further apart than this are a pause, not motion (as in remote.ts). */
const GAP_MS = 450;
const MOVE_MS = 100;
const KEEP = 8;

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
  readonly stats = { framesSent: 0, bytesSent: 0, framesGot: 0, bytesGot: 0, adopted: 0, dropped: 0, takeovers: 0, handovers: 0 };

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

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    const amb = game.systems.find((s): s is Ambient => s instanceof Ambient);
    this.traffic = amb ? amb.traffic : null;
  }

  /** Somebody has just arrived and knows nothing: the next frame carries every car whole. */
  refresh(): void { this.force = true; }

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
          a.flags = driverless ? TrafficFlag.Driverless : 0;
          s.buf.push(a);
          Object.assign(s.cur, a);
        });
        this.stats.handovers++;
      } else tr.clearCars();
      this.clearHost();
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
      this.stats.takeovers++;
    }
    if (want === 'host') { this.force = true; this.sendAt = 0; } else this.clearHost();
  }

  /** Not (or no longer) simulating for anybody else. */
  private clearHost(): void {
    const tr = this.traffic;
    if (tr) { tr.extra = []; tr.others = []; tr.walkers = []; }
    this.anchors.clear();
    this.sent.clear();
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
      r.flags = driverless ? TrafficFlag.Driverless
        : ((ctl.accel < -0.05 && sp > 0.5) || ctl.handbrake ? TrafficFlag.Braking : 0)
          | (sp < -0.3 && ctl.accel < 0 ? TrafficFlag.Reversing : 0) | (ctl.horn ? TrafficFlag.Horn : 0);
    });
    // Whole records first, then the numbers of the cars that have not moved since theirs.
    const order = this.order, still = this.still;
    let nFull = 0, nStill = 0;
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      let s = sent.get(r.id);
      const b = s?.rec;
      const same = !!b && !this.force && now - (s as Sent).at < REFRESH_MS + (r.id % 8) * 40
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
    const len = encodeTraffic(Math.floor(now), order, nFull, still, nStill, this.out);
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
    return s;
  }

  private unshow(s: Shown): void {
    this.game.vehicles.remove(s.v);
    this.cars.delete(s.wid);
  }

  /** A World frame. now: this browser's clock, ms. */
  frame(buf: ArrayBuffer, now: number): void {
    if (buf.byteLength < 3 || new Uint8Array(buf, 2, 1)[0] !== WorldKind.Traffic) return;
    this.sync();
    // Only the host's, and only while this browser is showing them.
    if (this.mode !== 'guest' || frameSender(buf) !== this.conn.host) return;
    const f = this.inFrame;
    if (!decodeTraffic(buf, f)) return;
    this.stats.framesGot++; this.stats.bytesGot += buf.byteLength;

    // The host's clock, unwrapped and placed on this one's, exactly as remote.ts does for a player.
    const from = frameSender(buf);
    if (this.lastArrive < 0 || from !== this.from || now - this.lastArrive > 20000) {
      this.sendT = f.t; this.offset = now - f.t; this.from = from;
    } else {
      const guess = this.sendT + (now - this.lastArrive);
      let t = guess - ((guess - f.t) % 65536 + 65536) % 65536;
      if (guess - t > 32768) t += 65536;
      if (t <= this.sendT) return;
      this.sendT = t;
      this.offset = Math.min(this.offset + 0.02 * (now - this.lastArrive), now - t);
    }
    this.lastArrive = now;
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
    // Nothing done to it here counts yet (a later step): it does not dent, burn or sink on this screen.
    v.health = 100;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number, dt: number): void {
    if (!this.traffic) return;
    this.sync();
    if (this.mode === 'host') {
      this.watch();
      if (now - this.sendAt >= SEND_MS - 4) { this.sendAt = now; this.send(now); }
    } else if (this.mode === 'guest') {
      for (const s of this.cars.values()) {
        this.sample(s, now);
        this.place(s, s.cur, dt);
      }
    }
  }

  /** For the tests (window.__game.net().traffic). */
  info(): Record<string, unknown> {
    const r2 = (v: number): number => +v.toFixed(2), tr = this.traffic;
    const cars: Record<string, unknown>[] = [];
    if (this.mode === 'guest') for (const s of this.cars.values()) cars.push({ id: s.wid, kind: s.v.spec.kind, color: s.v.color, x: r2(s.v.x), z: r2(s.v.z), h: r2(s.v.h), speed: r2(s.cur.speed), driver: s.v.driver });
    else if (tr) tr.eachShared((wid, v, driverless) => cars.push({ id: wid, kind: v.spec.kind, color: v.color, x: r2(v.x), z: r2(v.z), h: r2(v.h), speed: r2(v.speed), driver: driverless ? null : 'ai' }));
    return { mode: this.mode, ...this.stats, anchors: this.anchorList.length + 1, cars };
  }
}
