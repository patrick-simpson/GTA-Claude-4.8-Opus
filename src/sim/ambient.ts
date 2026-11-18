// Ambient life: people on the sidewalks and cars in the lanes.
//
// Nobody here has anywhere to be. A walker paces the sidewalks of one block; a
// car follows its lane to the next intersection and picks a turn. Both are kept
// in a bubble around the player, so a small cast fills whichever street is on
// screen: anything left far behind is moved to a street the camera is not
// looking down. Cars drive through the same physics and controls the player
// uses, which is why they can be shunted, blocked and stolen like any other.

import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import { RNG, TAU, clamp } from '../core/util';
import { CURB, PIER, groundAt, type Block, type RoadEdge, type RoadNode } from '../world/plan';
import { signalState } from '../world/signals';
import { SPECS, commonKind } from '../ent/vehicleSpecs';

/** Head counts at full density. */
const WALKERS = 46, STROLLERS = 6, CARS = 18;
/** Lane center, meters right of the street's centerline. Avenues have a second lane; ramps and parked cars own it. */
const LANE = 1.8;
/** Strollers turn back here, short of the pier head and its ramp. */
const PIER_TURN = 596;

interface Walker {
  p: Person;
  /** null for the strollers on the pier, who only go up and down it. */
  block: Block | null;
  /** Which side of the block (0 north, clockwise), and meters along it from its first corner. */
  side: number; t: number;
  dir: number;
  /** Distance in from the curb; on the pier, the X they keep to. */
  inset: number;
  pace: number;
  /** Seconds left lying in the road after being run down. */
  down: number;
}

interface Driver {
  v: Vehicle | null;
  e: RoadEdge;
  /** The intersection being driven toward, and the street to take from it. */
  to: RoadNode;
  next: RoadEdge;
  cruise: number;
  stuck: number; back: number; jams: number;
  /** Seconds spent held up by something that is not a red light, and seconds left of ignoring it. */
  wait: number; push: number;
}

export class Ambient {
  private readonly rng = new RNG(60311);
  private readonly walkers: Walker[] = [];
  private readonly drivers: Driver[] = [];
  private readonly blocks: Block[];
  // Result of at(): a point on a block's sidewalk and the direction that side runs.
  private qx = 0; private qz = 0; private qdx = 0; private qdz = 0;
  private lastX = 0; private lastZ = 0;

  constructor(private readonly game: Game) {
    const rng = this.rng, plan = game.plan;
    const den = clamp(game.quality.density, 0.4, 1);
    this.blocks = plan.blocks.filter((b) => b.road[0] || b.road[1] || b.road[2] || b.road[3]);
    const nW = Math.round(WALKERS * den), nS = Math.round(STROLLERS * den);
    for (let i = 0; i < nW + nS; i++) {
      const w: Walker = {
        p: game.people.spawn(0, 0, 0), block: null, side: 0, t: 0, dir: rng.sign(), inset: 0,
        pace: rng.range(1.15, 1.7), down: 0,
      };
      if (i < nW) {
        let ok = false;
        for (let k = 0; k < 60 && !ok; k++) ok = this.seatWalker(w, 6, 120, 0);
        for (let k = 0; k < 200 && !ok; k++) ok = this.seatWalker(w, 0, 1e5, 0);
      } else {
        w.t = rng.range(PIER.z0 + 8, PIER_TURN);
        w.inset = rng.sign() * rng.range(5.2, 7.6);
      }
      this.walkers.push(w);
    }
    const nC = Math.round(CARS * den);
    for (let i = 0; i < nC; i++) {
      const d: Driver = {
        v: null, e: plan.edges[0], to: plan.nodes[0], next: plan.edges[0], cruise: 10,
        stuck: 0, back: 0, jams: 0, wait: 0, push: 0,
      };
      for (let k = 0; k < 60 && !d.v; k++) this.seatCar(d, 18, 200, 0);
      this.drivers.push(d);
    }
  }

  update(dt: number): void {
    const g = this.game, pl = g.player, pv = pl.vehicle;
    const px = pl.x, pz = pl.z;
    // A teleport (the hospital, a test hook) lands in a street nobody has been moved to yet.
    // Fill it at once and in plain view: an empty street is worse than a sudden one.
    const jx = px - this.lastX, jz = pz - this.lastZ, jumped = jx * jx + jz * jz > 2500;
    this.lastX = px; this.lastZ = pz;

    for (const w of this.walkers) {
      const p = w.p;
      if (w.down > 0) {
        w.down -= dt;
        if (w.down > 0) continue;
        // Nobody stays down: they are back on a sidewalk somewhere else, unharmed and unimpressed.
        p.health = 100;
        if (w.block) for (let k = 0; k < 8; k++) if (this.seatWalker(w, 40, 130, 80)) break;
      }
      const dx = p.x - px, dz = p.z - pz, d2 = dx * dx + dz * dz;
      if (w.block && d2 > (jumped ? 14400 : 22500)) {
        if (jumped) { for (let k = 0; k < 60; k++) if (this.seatWalker(w, 8, 120, 0)) break; }
        else for (let k = 0; k < 3; k++) if (this.seatWalker(w, 40, 130, 80)) break;
      }
      if (pv && d2 < 100 && Math.abs(pv.speed) > 2.5 && Math.abs(pv.y - p.y) < 1.5) {
        const sh = Math.sin(pv.h), ch = Math.cos(pv.h);
        if (Math.abs(dx * sh + dz * ch) < pv.hl + 0.3 && Math.abs(-dx * ch + dz * sh) < pv.hw + 0.3) {
          p.pose = 'down'; p.speed = 0; p.health = 0;
          w.down = 9;
          continue;
        }
      }
      let v = w.pace;
      // Dess is standing in the way: wait rather than walk through her.
      if (!pv && d2 < 1 && dx * Math.sin(p.h) + dz * Math.cos(p.h) < 0) v = 0;
      w.t += v * dt * w.dir;
      if (w.block) {
        const len = this.sideLen(w.block, w.side, w.inset);
        if (w.t > len || w.t < 0) {
          const nx = (w.side + w.dir + 4) & 3;
          // Round the corner if there is a street there; a side with no street has no sidewalk either.
          if (w.block.road[nx]) { w.side = nx; w.t = w.dir > 0 ? 0 : this.sideLen(w.block, nx, w.inset); }
          else { w.dir = -w.dir; w.t = clamp(w.t, 0, len); }
        }
        this.at(w.block, w.side, w.t, w.inset);
        p.x = this.qx; p.z = this.qz; p.y = CURB;
        p.h = Math.atan2(this.qdx * w.dir, this.qdz * w.dir);
      } else {
        if (w.t > PIER_TURN) w.dir = -1; else if (w.t < PIER.z0 + 6) w.dir = 1;
        p.x = w.inset; p.z = w.t; p.y = groundAt(p.x, p.z);
        p.h = w.dir > 0 ? 0 : Math.PI;
      }
      p.speed = v;
      p.pose = v > 0 ? 'walk' : 'stand';
    }

    for (const d of this.drivers) {
      let v = d.v;
      // Stolen or drowned: it is somebody else's car now.
      if (v && (v.driver !== 'ai' || v.sunk)) d.v = v = null;
      if (v) {
        const dx = v.x - px, dz = v.z - pz;
        if (dx * dx + dz * dz > 40000 || d.jams > 2) { g.vehicles.remove(v); d.v = v = null; }
      }
      if (!v) {
        if (jumped) for (let k = 0; k < 60 && !d.v; k++) this.seatCar(d, 25, 185, 0);
        else for (let k = 0; k < 3 && !d.v; k++) this.seatCar(d, 70, 185, 120);
        continue;
      }
      this.drive(d, v, dt);
    }
  }

  // ── Walkers ────────────────────────────────────────────────────────────────

  /** Side k of a block runs from corner k to corner k+1, clockwise from the north-west, `m` in from the edge. */
  private at(b: Block, side: number, t: number, m: number): void {
    const r = b.rect;
    switch (side) {
      case 0: this.qx = r.x0 + m + t; this.qz = r.z0 + m; this.qdx = 1; this.qdz = 0; break;
      case 1: this.qx = r.x1 - m; this.qz = r.z0 + m + t; this.qdx = 0; this.qdz = 1; break;
      case 2: this.qx = r.x1 - m - t; this.qz = r.z1 - m; this.qdx = -1; this.qdz = 0; break;
      default: this.qx = r.x0 + m; this.qz = r.z1 - m - t; this.qdx = 0; this.qdz = -1;
    }
  }

  private sideLen(b: Block, side: number, m: number): number {
    const r = b.rect;
    return (side & 1 ? r.z1 - r.z0 : r.x1 - r.x0) - 2 * m;
  }

  /** Try one random sidewalk spot. Moves the walker only if the spot is acceptable. */
  private seatWalker(w: Walker, near: number, far: number, front: number): boolean {
    const rng = this.rng, b = rng.pick(this.blocks);
    let side = rng.int(0, 3);
    for (let k = 0; k < 4 && !b.road[side]; k++) side = (side + 1) & 3;
    // Between the furniture along the curb and the shopfronts.
    const inset = rng.range(1.5, 2.8), len = this.sideLen(b, side, inset);
    if (len < 6) return false;
    const t = rng.next() * len;
    this.at(b, side, t, inset);
    if (!this.ok(this.qx, this.qz, near, far, front)) return false;
    w.block = b; w.side = side; w.t = t; w.inset = inset;
    w.p.x = this.qx; w.p.z = this.qz; w.p.y = CURB;
    return true;
  }

  /**
   * Is (x, z) a fair place to make someone appear? Between `near` and `far` from the
   * player, and either behind the camera or at least `front` away from it (0 = anywhere).
   */
  private ok(x: number, z: number, near: number, far: number, front: number): boolean {
    const g = this.game, pl = g.player;
    const dx = x - pl.x, dz = z - pl.z, d2 = dx * dx + dz * dz;
    if (d2 < near * near || d2 > far * far) return false;
    if (front <= 0) return true;
    const cam = g.camera.position, yaw = g.cam.yaw;
    const cx = x - cam.x, cz = z - cam.z;
    return cx * Math.sin(yaw) + cz * Math.cos(yaw) < 0 || cx * cx + cz * cz > front * front;
  }

  // ── Traffic ────────────────────────────────────────────────────────────────

  /** The street to take on arriving at `at` along `e`: usually straight on, back the way it came only at a dead end. */
  private pick(e: RoadEdge, at: RoadNode): RoadEdge {
    const plan = this.game.plan;
    let best = e, top = 0;
    for (const id of at.edges) {
      if (id === e.id) continue;
      const c = plan.edges[id];
      const k = (c.horiz === e.horiz ? 2.2 : 1) * (0.2 + this.rng.next());
      if (k > top) { top = k; best = c; }
    }
    return best;
  }

  /** Try one random spot in a lane; on success a new car is driving there. */
  private seatCar(d: Driver, near: number, far: number, front: number): boolean {
    const g = this.game, plan = g.plan, rng = this.rng;
    const e = rng.pick(plan.edges), fwd = rng.chance(0.5);
    const from = plan.nodes[fwd ? e.a : e.b], to = plan.nodes[fwd ? e.b : e.a];
    const s0 = (e.horiz ? from.hx : from.hz) + 10, s1 = e.len - (e.horiz ? to.hx : to.hz) - 10;
    if (s1 <= s0) return false;
    const s = rng.range(s0, s1), sg = fwd ? 1 : -1;
    const dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
    // Travelling along (dx, dz), the right-hand side is (-dz, dx).
    const x = from.x + dx * s - dz * LANE, z = from.z + dz * s + dx * LANE;
    if (!this.ok(x, z, near, far, front)) return false;
    for (const o of g.vehicles.list) {
      const ox = o.x - x, oz = o.z - z;
      if (Math.abs(ox * dx + oz * dz) < 11 && Math.abs(-ox * dz + oz * dx) < 2.3) return false;
    }
    const v = g.vehicles.spawn(commonKind(rng.next()), x, z, Math.atan2(dx, dz));
    v.driver = 'ai';
    d.v = v; d.e = e; d.to = to; d.next = this.pick(e, to);
    d.cruise = Math.min(rng.range(8.5, 12), SPECS[v.spec.kind].topSpeed * 0.5);
    d.stuck = d.back = d.jams = d.wait = d.push = 0;
    // Already rolling, so a street does not fill with cars pulling away at once.
    v.vx = dx * d.cruise * 0.7; v.vz = dz * d.cruise * 0.7;
    return true;
  }

  private drive(d: Driver, v: Vehicle, dt: number): void {
    const g = this.game, plan = g.plan, ctl = v.ctl;
    let e = d.e, to = d.to;
    let fwd = plan.nodes[e.b] === to;
    let from = plan.nodes[fwd ? e.a : e.b];
    let sg = fwd ? 1 : -1, dx = e.horiz ? sg : 0, dz = e.horiz ? 0 : sg;
    let s = (v.x - from.x) * dx + (v.z - from.z) * dz;
    if (s > e.len - (e.horiz ? to.hx : to.hz) - 0.5) {
      // Into the intersection: from here it steers for the lane of the street it is taking.
      from = to;
      e = d.e = d.next;
      to = d.to = plan.nodes[plan.other(e, from.id)];
      d.next = this.pick(e, to);
      fwd = plan.nodes[e.b] === to;
      sg = fwd ? 1 : -1; dx = e.horiz ? sg : 0; dz = e.horiz ? 0 : sg;
      s = (v.x - from.x) * dx + (v.z - from.z) * dz;
    }
    const endHalf = e.horiz ? to.hx : to.hz, startHalf = e.horiz ? from.hx : from.hz;
    const sp = v.speed, sh = Math.sin(v.h), ch = Math.cos(v.h);

    // Steer at a point a little way up the lane; the faster, the further.
    const st = Math.max(s + clamp(3.5 + 0.55 * Math.abs(sp), 5, 11), startHalf + 2);
    const tx = from.x + dx * st - dz * LANE - v.x, tz = from.z + dz * st + dx * LANE - v.z;
    let err = Math.atan2(tx, tz) - v.h;
    err -= Math.round(err / TAU) * TAU;

    let want = d.cruise * (1 - 0.62 * Math.min(1, Math.abs(err) * 1.3));
    let held = false;
    // Distance from the nose to the stop line.
    const stop = e.len - endHalf - 2 - v.hl - s;
    if (stop > -1.5) {
      if (d.next.horiz !== e.horiz || d.next === e) want = Math.min(want, 5 + Math.max(0, stop) * 0.35);
      if (to.hasLight && stop < 45) {
        const sig = signalState(to, e.horiz, g.time);
        // A yellow too close to stop for is driven through.
        if (sig === 'red' || (sig === 'yellow' && stop > sp * 1.4)) want = Math.min(want, stop < 1 ? 0 : Math.sqrt(4.5 * stop));
      }
    }

    if (d.push > 0) d.push -= dt;
    else {
      for (const o of g.vehicles.list) {
        if (o === v) continue;
        const ox = o.x - v.x, oz = o.z - v.z;
        if (ox > 26 || ox < -26 || oz > 26 || oz < -26) continue;
        const lf = ox * sh + oz * ch;
        if (lf <= 0) continue;
        // The other car's reach along and across this one's nose, whichever way it is turned.
        const c = Math.abs(sh * Math.sin(o.h) + ch * Math.cos(o.h)), sn = Math.sqrt(Math.max(0, 1 - c * c));
        if (Math.abs(-ox * ch + oz * sh) > v.hw + o.hw * c + o.hl * sn + 0.35) continue;
        const gap = lf - v.hl - (o.hl * c + o.hw * sn);
        if (gap > 16) continue;
        const lim = gap < 1.8 ? 0 : (gap - 1.8) * 0.8 + Math.max(0, o.vx * sh + o.vz * ch) * 0.9;
        if (lim < want) { want = lim; held = lim < 0.5; }
      }
      const pl = g.player;
      if (!pl.vehicle) {
        const ox = pl.x - v.x, oz = pl.z - v.z, lf = ox * sh + oz * ch - v.hl;
        if (lf > -1 && lf < 14 && Math.abs(-ox * ch + oz * sh) < v.hw + 0.7 && Math.abs(pl.y - v.y) < 2) {
          const lim = lf < 2.5 ? 0 : (lf - 2.5) * 0.8;
          if (lim < want) { want = lim; held = lim < 0.5; }
        }
      }
      // Two cars each waiting for the other would wait all day. After a while one of them just goes.
      d.wait = held ? d.wait + dt : 0;
      if (d.wait > 9) { d.wait = 0; d.push = 2.5; }
    }

    // Pinned on something the lane logic knows nothing about: back off and try again.
    if (want > 1.5 && Math.abs(sp) < 0.5) d.stuck += dt; else if (Math.abs(sp) > 1.5) d.stuck = 0;
    if (d.stuck > 4) { d.stuck = 0; d.back = 1.4; d.jams++; }
    const steer = clamp(-err * 1.9, -1, 1);
    if (d.back > 0) {
      d.back -= dt;
      ctl.accel = -0.7; ctl.steer = -steer; ctl.handbrake = false;
      return;
    }
    ctl.steer = steer;
    if (want < 0.25 && sp < 0.8) { ctl.accel = 0; ctl.handbrake = true; return; }
    ctl.handbrake = false;
    const dv = want - sp;
    // Negative accel is the brake only while rolling forward; at rest it would select reverse.
    ctl.accel = dv > 0 ? Math.min(1, dv * 0.45 + 0.08) : dv < -1.2 && sp > 0.5 ? Math.max(-1, dv * 0.5) : 0;
  }
}
