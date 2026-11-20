// Pedestrians: the people on the sidewalks.
//
// Nobody here has anywhere to be, but they go about it convincingly. A walker
// follows the sidewalk of a block (a "rail": block, side, distance along, and
// how far in from the kerb), steering a little ahead of where they are, so
// stepping round each other, a lamp post or Dess never needs a special case. At
// a corner they turn, or wait at the kerb for the cross traffic's red and walk
// over to the next block. Some stop at shop windows, benches and bus stops;
// all of them mind cars, most of the time successfully.
//
// The cast is a fixed pool kept in a bubble round the player. How many of the
// pool are out depends on the hour, the rain and the district.

import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import { RNG, clamp, dampAngle } from '../core/util';
import { PIER, groundAt, type Block, type District, type RoadNode } from '../world/plan';
import type { Prop } from '../world/collide';
import { signalState } from '../world/signals';
import { spawnOk, type RoadPed } from './traffic';

/** Head counts at full density. */
const WALKERS = 54, STROLLERS = 6;
/** Strollers turn back here, short of the pier head and its ramp. */
const PIER_TURN = 596;
/** Body radius for bumping into things. */
const R = 0.3;
/** A vehicle moving faster than this (m/s, about 5 mph) knocks a person down instead of nudging them aside. */
const KNOCK = 2.2;
/** At or above this the person does not get up. */
const HARD = 7;

const WALK = 0, KERB = 1, CROSS = 2, IDLE = 3, SIT = 4, DOWN = 5, GOTO = 6;

/** Heading into the block from each side (0 north, clockwise), and the same as a vector. */
const INWARD = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
const IN_X = [0, -1, 0, 1], IN_Z = [1, 0, -1, 0];
/** Direction each side runs, clockwise round the block. */
const DIR_X = [1, 0, -1, 0], DIR_Z = [0, 1, 0, -1];

/** How busy a district's sidewalks are, by day and by night. */
const BUSY: Record<District, [number, number]> = {
  downtown: [1, 0.45], midtown: [0.85, 0.4], oldtown: [0.85, 0.4], suburb: [0.45, 0.15],
  industrial: [0.07, 0.03], port: [0.05, 0.02], strand: [1.6, 0.5], park: [0.9, 0.1], arena: [0.35, 0.1],
  // Tepid Falls: a small town. Main Street is busy by its own standards.
  main: [0.8, 0.3], square: [0.9, 0.15], mill: [0.25, 0.06], stacks: [0.45, 0.15], college: [0.5, 0.1],
  yard: [0.06, 0.02], exits: [0.08, 0.04], lake: [0.05, 0.01], sister: [0.2, 0.05],
};
const SHOPS: Record<District, boolean> = {
  downtown: true, midtown: true, oldtown: true, strand: true, suburb: false, industrial: false, port: false, park: false, arena: false,
  // Nothing is built on the mainland's lots yet, so nobody there has a shop to step into.
  main: false, square: false, mill: false, stacks: false, college: false, yard: false, exits: false, lake: false, sister: false,
};

/** A bench to sit on or a bus stop to wait at. */
interface Spot { prop: Prop; side: number; bench: boolean; n: number }

/** A moving vehicle, with the trigonometry done once for everybody. */
export interface Mover { v: Vehicle; sh: number; ch: number; sp: number }

interface Walker extends RoadPed {
  p: Person;
  active: boolean;
  /** One of the strollers on the pier, who only go up and down it. */
  pier: boolean;
  block: Block;
  /** Which side of the block (0 north, clockwise), and meters along it from its first corner. */
  side: number; t: number;
  dir: number;
  /** Distance in from the kerb; on the pier, the X they keep to. */
  inset: number;
  pace: number;
  mode: number;
  /** Mode clock: seconds waited, sat, lain. */
  timer: number;
  /** Where a kerb, crossing or errand is heading. */
  tx: number; tz: number;
  /** The far side of a crossing: block, side and distance along it. */
  nb: Block | null; nside: number; nt: number;
  node: RoadNode | null; crossH: boolean; cs: number;
  /** Crosses when the road is empty, whatever the light says. */
  jay: boolean;
  spot: Spot | null;
  face: number;
  /** Seconds left of running away. */
  flee: number;
  hurry: number;
  hard: boolean;
  /** Push from other people this frame, and a dodge away from a car on the sidewalk. */
  ax: number; az: number;
  asideX: number; asideZ: number; asideT: number;
  /** Blocked: seconds of getting nowhere, then seconds of sidling round whatever it is. */
  stuck: number; sideT: number; sideS: number;
  /** Seconds until they next fancy a sit-down, and until the next look around. */
  cool: number; scan: number;
  /** Cars within reach, parked or crawling, refreshed on the scan. */
  cars: Vehicle[];
  inRoad: boolean;
  hitCool: number;
}

export class Peds {
  readonly walkers: Walker[] = [];
  /** Everyone on foot in the roadway right now, for the drivers. */
  readonly road: RoadPed[] = [];
  readonly stats = { hits: 0, crossings: 0, jaywalks: 0, fled: 0, sits: 0, drivers: 0 };

  private readonly rng = new RNG(60311);
  private readonly blocks: Block[];
  private readonly usable: boolean[] = [];
  private readonly spots: Spot[][] = [];
  private nearBlocks: Block[] = [];
  private nearT = 0;
  /** The busiest of the near blocks, so the choice between them is relative. */
  private top = 1;
  private movers: readonly Mover[] = [];
  private frame = 0;
  // Result of at(): a point on a block's sidewalk.
  private qx = 0; private qz = 0;

  constructor(private readonly game: Game) {
    const rng = this.rng, plan = game.plan;
    for (const b of plan.blocks) {
      this.usable[b.id] = b.road[0] || b.road[1] || b.road[2] || b.road[3];
      this.spots[b.id] = [];
    }
    this.blocks = plan.blocks.filter((b) => this.usable[b.id]);
    // Benches and bus-stop posts on the kerb strip, filed under the block and side they stand on.
    const file = (pr: Prop): void => {
      if ((pr.kind !== 'bench' || pr.r > 0.6) && pr.kind !== 'post') return;
      const b = this.blockAtPoint(pr.x, pr.z);
      if (!b || !this.usable[b.id]) return;
      const r = b.rect, d = [pr.z - r.z0, r.x1 - pr.x, r.z1 - pr.z, pr.x - r.x0];
      let side = 0;
      for (let k = 1; k < 4; k++) if (d[k] < d[side]) side = k;
      if (d[side] < 0 || d[side] > 1.6 || !b.road[side]) return;
      this.spots[b.id].push({ prop: pr, side, bench: pr.kind === 'bench', n: 0 });
    };
    game.col.forProps(0, 0, 1300, file);
    // Tepid Falls' benches, north of where the first sweep stops.
    game.col.forProps(-60, -1920, 618, file);

    const den = clamp(game.quality.density, 0.4, 1);
    const nW = Math.round(WALKERS * den), nS = Math.round(STROLLERS * den);
    for (let i = 0; i < nW + nS; i++) {
      const w: Walker = {
        p: game.people.spawn(0, 0, 0), active: false, pier: i >= nW, block: this.blocks[0], side: 0, t: 0, dir: rng.sign(), inset: 2,
        // A few amble, a few stride.
        pace: rng.chance(0.2) ? rng.range(0.9, 1.15) : rng.chance(0.25) ? rng.range(1.6, 1.95) : rng.range(1.2, 1.6),
        mode: WALK, timer: 0, tx: 0, tz: 0, nb: null, nside: 0, nt: 0, node: null, crossH: false, cs: 1.5,
        jay: rng.chance(0.14), spot: null, face: 0, flee: 0, hurry: 0, hard: false,
        ax: 0, az: 0, asideX: 0, asideZ: 0, asideT: 0, stuck: 0, sideT: 0, sideS: 1,
        cool: rng.range(4, 40), scan: rng.next() * 0.5, cars: [], inRoad: false, hitCool: 0,
        x: 0, z: 0, vx: 0, vz: 0,
      };
      w.p.visible = false;
      this.walkers.push(w);
    }
    this.refreshNear();
    const target = this.target();
    let out = 0;
    for (const w of this.walkers) {
      if (w.pier) { this.seatPier(w); continue; }
      if (out >= target) continue;
      for (let k = 0; k < 80 && !w.active; k++) this.seat(w, 6, 110, 0);
      if (w.active) out++;
    }
  }

  /** How busy this block is at this hour. */
  private busy(b: Block): number {
    const k = BUSY[b.district];
    return k[0] + (k[1] - k[0]) * this.game.sky.night;
  }

  /** How many of the street pool should be out: fewer at night, in the rain, and in the quiet parts of town. */
  private target(): number {
    let n = 0, f = 0;
    for (const w of this.walkers) if (!w.pier) n++;
    for (const b of this.nearBlocks) f += this.busy(b);
    f = this.nearBlocks.length ? Math.min(1, f / this.nearBlocks.length * 1.15) : 0;
    return Math.round(n * f * (this.game.sky.weather === 'rain' ? 0.55 : 1));
  }

  /** A crash, a bang: everyone within earshot runs from it. */
  alarm(x: number, z: number, radius: number): void {
    for (const w of this.walkers) {
      if (!w.active || w.mode === DOWN) continue;
      const dx = w.p.x - x, dz = w.p.z - z;
      if (dx * dx + dz * dz < radius * radius) this.scare(w, x, z, this.rng.range(3.5, 6));
    }
  }

  /** A driver climbs out at (x, z) and runs from their car. Borrows whoever in the cast is furthest out of sight. */
  spawnDriver(v: Vehicle, x: number, z: number): void {
    const g = this.game;
    let best: Walker | null = null, far = 0;
    for (const w of this.walkers) {
      if (w.pier || w.mode === DOWN) continue;
      if (!w.active) { best = w; break; }
      const dx = w.p.x - g.player.x, dz = w.p.z - g.player.z, d2 = dx * dx + dz * dz;
      if (d2 > far && spawnOk(g, w.p.x, w.p.z, 50, 1e5, 100)) { far = d2; best = w; }
    }
    if (!best) return;
    this.stats.drivers++;
    this.leave(best);
    const p = best.p;
    p.x = x; p.z = z; p.y = groundAt(x, z); p.h = v.h; p.visible = true; p.health = 100; p.pose = 'stand';
    best.active = true;
    this.adopt(best);
    this.scare(best, v.x, v.z, 7);
  }

  update(dt: number, movers: readonly Mover[], jumped: boolean): void {
    const g = this.game, pl = g.player, px = pl.x, pz = pl.z, rng = this.rng;
    this.movers = movers;
    this.frame++;
    this.road.length = 0;
    if ((this.nearT -= dt) <= 0 || jumped) this.refreshNear();

    const ws = this.walkers, n = ws.length;
    let out = 0;
    for (const w of ws) if (w.active && !w.pier) out++;
    const target = this.target();
    const day = g.sky.night < 0.5;

    // People give each other room, and pass on the right like the traffic does.
    for (const w of ws) { w.ax = 0; w.az = 0; }
    for (let i = 0; i < n; i++) {
      const a = ws[i];
      if (!a.active || a.mode === DOWN) continue;
      const ap = a.p;
      for (let j = i + 1; j < n; j++) {
        const b = ws[j];
        if (!b.active || b.mode === DOWN) continue;
        const dx = b.p.x - ap.x, dz = b.p.z - ap.z;
        if (dx > 1.7 || dx < -1.7 || dz > 1.7 || dz < -1.7) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > 2.89 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), f = (d < 0.7 ? 3.2 : (1.7 - d) * 0.9) / d;
        a.ax -= dx * f; a.az -= dz * f; b.ax += dx * f; b.az += dz * f;
        if (Math.cos(ap.h - b.p.h) < -0.3) {
          const k = (1.7 - d) * 0.8;
          a.ax -= Math.cos(ap.h) * k; a.az += Math.sin(ap.h) * k;
          b.ax -= Math.cos(b.p.h) * k; b.az += Math.sin(b.p.h) * k;
        }
      }
      if (!pl.vehicle) {
        const dx = ap.x - px, dz = ap.z - pz, d2 = dx * dx + dz * dz;
        if (d2 < 2.56 && d2 > 1e-6) {
          const d = Math.sqrt(d2), f = (1.6 - d) * 1.8 / d;
          a.ax += dx * f; a.az += dz * f;
          // Dess running straight at somebody sends them scurrying.
          if (pl.speed > 5.2 && d < 1.3 && -dx * Math.sin(pl.h) - dz * Math.cos(pl.h) < 0) this.scare(a, px, pz, 3);
        }
      }
    }

    let tries = 3;
    for (let i = 0; i < n; i++) {
      const w = ws[i], p = w.p;
      if (w.pier) { this.pierLife(w, day); if (!w.active) continue; }
      else if (!w.active) {
        // A few tries a frame fill a street within a few seconds of arriving on it.
        if (out < target && (tries > 0 || jumped)) {
          tries--;
          if (jumped) { for (let k = 0; k < 40 && !w.active; k++) this.seat(w, 8, 110, 0); }
          else this.seat(w, 40, 118, 80);
          if (w.active) out++;
        }
        continue;
      } else {
        const dx = p.x - px, dz = p.z - pz, d2 = dx * dx + dz * dz;
        if (d2 > (jumped ? 14400 : 135 * 135)) {
          // Left far behind: step out of the world, and back into it on a street nearer the player.
          this.leave(w); w.active = false; p.visible = false; out--;
          continue;
        }
        if (out > target && w.mode !== DOWN && (this.frame + i) % 30 === 0 && spawnOk(g, p.x, p.z, 35, 1e5, 85)) {
          this.leave(w); w.active = false; p.visible = false; out--;
          continue;
        }
      }

      if ((w.scan -= dt) <= 0) { w.scan = 0.5; this.look(w); }
      if (w.hitCool > 0) w.hitCool -= dt;
      this.traffic(w);
      if (w.mode === DOWN) { this.lie(w, dt); if (w.active) this.note(w); else out--; continue; }
      if (w.flee > 0) w.flee -= dt;
      if (w.hurry > 0) w.hurry -= dt;
      if (w.cool > 0) w.cool -= dt;
      if (w.sideT > 0) w.sideT -= dt;
      if (w.asideT > 0) { w.asideT -= dt; w.ax += w.asideX; w.az += w.asideZ; }
      const run = w.flee > 0;

      switch (w.mode) {
        case WALK: {
          const v = run ? 4.6 : w.pace * (w.hurry > 0 ? 1.5 : 1);
          if (w.pier) {
            if (p.z > PIER_TURN) w.dir = -1; else if (p.z < PIER.z0 + 6) w.dir = 1;
            this.step(w, w.inset, p.z + w.dir * 1.6, v, dt);
            break;
          }
          const b = w.block, len = this.sideLen(b, w.side, w.inset);
          w.t = this.project(w);
          if ((w.dir > 0 && w.t >= len - 0.35) || (w.dir < 0 && w.t <= 0.35)) { this.corner(w); break; }
          this.at(b, w.side, clamp(w.t + w.dir * 1.6, 0, len), w.inset);
          this.step(w, this.qx, this.qz, v, dt);
          break;
        }
        case KERB: {
          const far = this.step(w, w.tx, w.tz, run ? 4 : Math.min(w.pace, 1.2), dt);
          if (far > 0.3 && w.timer < 3) { w.timer += dt * 0.2; break; }
          w.timer += dt;
          p.pose = 'stand'; p.speed = 0;
          this.atFar(w);
          p.h = dampAngle(p.h, Math.atan2(this.qx - p.x, this.qz - p.z), 6, dt);
          if ((this.frame + i) % 16 === 0 && this.mayCross(w)) { w.mode = CROSS; w.timer = 0; this.stats.crossings++; }
          else if (w.timer > 45 || run) { w.mode = WALK; w.dir = -w.dir; }
          break;
        }
        case CROSS: {
          this.atFar(w);
          const far = this.step(w, this.qx, this.qz, run ? 4.6 : w.cs * (w.hurry > 0 ? 1.4 : 1), dt);
          w.timer += dt;
          if (far < 0.5 && w.nb) { w.block = w.nb; w.side = w.nside; w.nb = null; w.mode = WALK; }
          else if (w.timer > 40) this.adopt(w);
          break;
        }
        case GOTO: {
          const far = this.step(w, w.tx, w.tz, w.pace, dt);
          w.timer += dt;
          const s = w.spot;
          if (run || !s || !s.prop.alive || w.timer > 7) { this.leave(w); break; }
          if (far > 0.35) break;
          w.timer = 0;
          if (s.bench) {
            w.mode = SIT; this.stats.sits++; p.bench = true;
            // The sit pose is the driving one, hips at foot level and a little ahead of the feet: lift it onto the slats and back against the rail.
            p.x = s.prop.x - IN_X[s.side] * 0.22; p.z = s.prop.z - IN_Z[s.side] * 0.22; p.y = groundAt(p.x, p.z) + 0.42;
            w.face = INWARD[s.side]; w.cool = rng.range(10, day ? 30 : 16);
          } else { w.mode = IDLE; w.face = INWARD[s.side] + Math.PI; w.cool = rng.range(9, 24); }
          break;
        }
        default: {
          // IDLE and SIT: on the spot until the mood passes.
          w.timer += dt;
          p.pose = w.mode === SIT ? 'sit' : 'stand'; p.speed = 0;
          p.h = dampAngle(p.h, w.face, 5, dt);
          w.vx = w.vz = 0;
          if (run || w.timer > w.cool || (w.spot && !w.spot.prop.alive)) { this.leave(w); w.cool = rng.range(15, 45); }
        }
      }
      this.note(w);
    }
  }

  /** Publish where the walker is, and whether that is in the road. */
  private note(w: Walker): void {
    const p = w.p;
    w.x = p.x; w.z = p.z;
    w.inRoad = !w.pier && groundAt(p.x, p.z) < 0.1 && p.y < 0.5;
    if (w.inRoad) this.road.push(w);
  }

  // ── The sidewalk rail ──────────────────────────────────────────────────────

  /** Side k of a block runs from corner k to corner k+1, clockwise from the north-west, `m` in from the edge. */
  private at(b: Block, side: number, t: number, m: number): void {
    const r = b.rect;
    switch (side) {
      case 0: this.qx = r.x0 + m + t; this.qz = r.z0 + m; break;
      case 1: this.qx = r.x1 - m; this.qz = r.z0 + m + t; break;
      case 2: this.qx = r.x1 - m - t; this.qz = r.z1 - m; break;
      default: this.qx = r.x0 + m; this.qz = r.z1 - m - t;
    }
  }

  /** The point a crossing is making for. */
  private atFar(w: Walker): void {
    if (w.nb && w.nt >= 0) this.at(w.nb, w.nside, w.nt, w.inset);
    else { this.qx = w.tx; this.qz = w.tz; }
  }

  private sideLen(b: Block, side: number, m: number): number {
    const r = b.rect;
    return (side & 1 ? r.z1 - r.z0 : r.x1 - r.x0) - 2 * m;
  }

  /** Distance along their side, from where they actually stand. */
  private project(w: Walker): number {
    const r = w.block.rect, p = w.p, m = w.inset;
    switch (w.side) {
      case 0: return p.x - r.x0 - m;
      case 1: return p.z - r.z0 - m;
      case 2: return r.x1 - m - p.x;
      default: return r.z1 - m - p.z;
    }
  }

  private blockAt(i: number, j: number): Block | null {
    return this.game.plan.blockAt(i, j);
  }

  private blockAtPoint(x: number, z: number): Block | null {
    return this.game.plan.blockAtPoint(x, z);
  }

  private refreshNear(): void {
    const pl = this.game.player;
    this.nearT = 2;
    this.nearBlocks = this.blocks.filter((b) => {
      const r = b.rect, dx = Math.max(r.x0 - pl.x, 0, pl.x - r.x1), dz = Math.max(r.z0 - pl.z, 0, pl.z - r.z1);
      return dx * dx + dz * dz < 100 * 100;
    });
    this.top = 0.01;
    for (const b of this.nearBlocks) this.top = Math.max(this.top, this.busy(b));
  }

  /** Try one random sidewalk spot. Brings the walker out only if the spot is acceptable. */
  private seat(w: Walker, near: number, far: number, front: number): boolean {
    const rng = this.rng, g = this.game;
    if (this.nearBlocks.length === 0) return false;
    const b = rng.pick(this.nearBlocks);
    // Busy districts get more of the cast; the Cannery and the docks next to nobody.
    if (rng.next() * this.top > this.busy(b)) return false;
    let side = rng.int(0, 3);
    for (let k = 0; k < 4 && !b.road[side]; k++) side = (side + 1) & 3;
    // Between the furniture along the kerb and the shopfronts.
    const inset = rng.range(1.5, 2.8), len = this.sideLen(b, side, inset);
    if (len < 6) return false;
    const t = rng.next() * len;
    this.at(b, side, t, inset);
    if (!spawnOk(g, this.qx, this.qz, near, far, front) || g.col.pointBlocked(this.qx, this.qz, 1)) return false;
    w.block = b; w.side = side; w.t = t; w.inset = inset; w.dir = rng.sign();
    const p = w.p;
    p.x = this.qx; p.z = this.qz; p.y = groundAt(p.x, p.z); p.h = Math.atan2(DIR_X[side] * w.dir, DIR_Z[side] * w.dir);
    p.visible = true; p.health = 100; p.pose = 'walk'; p.bench = false;
    w.active = true; w.mode = WALK; w.flee = 0; w.hard = false; w.cars.length = 0; w.scan = 0;
    w.cool = rng.range(4, 40);
    return true;
  }

  /** Put a walker on the sidewalk nearest to where they stand (after a fall, a crossing gone wrong, a climb out of a car). */
  private adopt(w: Walker): void {
    const p = w.p;
    w.nb = null; w.mode = WALK;
    if (w.pier) { w.inset = clamp(p.x, -7.6, 7.6); return; }
    let b = this.blockAtPoint(p.x, p.z);
    if (!b || !this.usable[b.id]) {
      let bd = Infinity;
      for (const c of this.blocks) {
        const r = c.rect, dx = Math.max(r.x0 - p.x, 0, p.x - r.x1), dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
        if (dx * dx + dz * dz < bd) { bd = dx * dx + dz * dz; b = c; }
      }
    }
    if (!b) return;
    const r = b.rect, m = w.inset;
    const d = [Math.abs(p.z - r.z0 - m), Math.abs(r.x1 - m - p.x), Math.abs(r.z1 - m - p.z), Math.abs(p.x - r.x0 - m)];
    let side = -1;
    for (let k = 0; k < 4; k++) if (b.road[k] && (side < 0 || d[k] < d[side])) side = k;
    w.block = b; w.side = side < 0 ? 0 : side;
    w.t = clamp(this.project(w), 0.5, Math.max(0.5, this.sideLen(b, w.side, m) - 0.5));
  }

  /** Give up whatever they were doing (a seat, a wait, a crossing not yet begun) and go back to walking. */
  private leave(w: Walker): void {
    w.p.bench = false;
    if (w.spot) { w.spot.n--; w.spot = null; }
    if (w.mode === DOWN) return;
    if (w.mode === CROSS) return;
    w.mode = WALK; w.nb = null; w.timer = 0;
  }

  // ── Corners and crossings ──────────────────────────────────────────────────

  /** At the end of a side: round the corner, cross to the next block, or turn back. */
  private corner(w: Walker): void {
    const b = w.block, k = w.side, dir = w.dir, nx = (k + dir + 4) & 3, rng = this.rng;
    // A side with no street has no sidewalk either.
    if (!b.road[nx]) { w.dir = -dir; return; }
    const nb = this.blockAt(b.i + DIR_X[k] * dir, b.j + DIR_Z[k] * dir);
    const can = nb !== null && this.usable[nb.id] && nb.road[k] && this.sideLen(nb, k, w.inset) > 4;
    const r = rng.next();
    if (can && nb && r < (w.flee > 0 ? 0.15 : 0.68)) {
      const c = dir > 0 ? (k + 1) & 3 : k;
      w.node = this.game.plan.nodeAt(b.i + (c === 1 || c === 2 ? 1 : 0), b.j + (c >= 2 ? 1 : 0));
      w.nb = nb; w.nside = k; w.nt = dir > 0 ? 0 : this.sideLen(nb, k, w.inset);
      // Walking east or west means crossing a north-south street.
      w.crossH = (k & 1) === 1;
      this.at(b, k, dir > 0 ? this.sideLen(b, k, w.inset) : 0, w.inset);
      w.tx = this.qx + DIR_X[k] * dir * (w.inset - 0.5); w.tz = this.qz + DIR_Z[k] * dir * (w.inset - 0.5);
      w.mode = KERB; w.timer = 0;
    } else if (r < 0.96 || !can) {
      w.side = nx;
    } else w.dir = -dir;
  }

  /** Is a moving vehicle within `r` of the point? */
  private moving(x: number, z: number, r: number, slow: number): boolean {
    for (const m of this.movers) {
      if (m.sp < slow) continue;
      const dx = m.v.x - x, dz = m.v.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** Waiting at the kerb: is this the moment? Sets the pace needed to make it over in time. */
  private mayCross(w: Walker): boolean {
    const g = this.game, p = w.p, node = w.node;
    this.atFar(w);
    const fx = this.qx, fz = this.qz, mx = (p.x + fx) / 2, mz = (p.z + fz) / 2;
    const dist = Math.hypot(fx - p.x, fz - p.z);
    w.cs = Math.max(w.pace, 1.4);
    if (node && node.hasLight) {
      // Walk while the traffic being crossed is held at red, and only if the red will last the trip.
      if (g.world.signal(node.id, w.crossH) === 'red' && !this.moving(mx, mz, 9, 3.5)) {
        for (const v of [w.cs, 2.5]) {
          const need = dist / v + 0.5;
          if (signalState(node, w.crossH, g.time + need) === 'red' && signalState(node, w.crossH, g.time + need * 0.5) === 'red') { w.cs = v; return true; }
        }
      }
      if (w.jay && w.timer > 1.5 && !this.moving(mx, mz, 30, 1.5)) { w.cs = 2.1; this.stats.jaywalks++; return true; }
      return false;
    }
    return !this.moving(mx, mz, 30, 1.5);
  }

  /** Mid-block, a quiet street, nothing coming: some people just go. */
  private jaywalk(w: Walker): void {
    const b = w.block, k = w.side, p = w.p;
    const nb = this.blockAt(b.i + (k === 1 ? 1 : k === 3 ? -1 : 0), b.j + (k === 0 ? -1 : k === 2 ? 1 : 0));
    const op = (k + 2) & 3;
    if (!nb || !this.usable[nb.id] || !nb.road[op]) return;
    const r = nb.rect, m = w.inset;
    const tx = k === 1 ? r.x0 + m : k === 3 ? r.x1 - m : p.x, tz = k === 0 ? r.z1 - m : k === 2 ? r.z0 + m : p.z;
    const wide = Math.abs(tx - p.x) + Math.abs(tz - p.z);
    // Streets only: an avenue is four lanes of second thoughts.
    if (wide > 19 || (k & 1 ? tz < r.z0 + 4 || tz > r.z1 - 4 : tx < r.x0 + 4 || tx > r.x1 - 4)) return;
    if (this.moving((p.x + tx) / 2, (p.z + tz) / 2, 32, 1.5)) return;
    // Not where a parked car is in the way.
    for (const o of w.cars) {
      const along = k & 1 ? o.z - p.z : o.x - p.x;
      if (Math.abs(along) < o.hl + 1.3) return;
    }
    w.nb = nb; w.nside = op; w.nt = -1; w.tx = tx; w.tz = tz;
    w.cs = Math.max(w.pace, 1.7); w.mode = CROSS; w.timer = 0; w.dir = this.rng.sign();
    this.stats.jaywalks++;
  }

  // ── Looking around ─────────────────────────────────────────────────────────

  /** Twice a second: which cars are close, and is there anything worth stopping for? */
  private look(w: Walker): void {
    const g = this.game, p = w.p, rng = this.rng;
    w.cars.length = 0;
    for (const o of g.vehicles.list) {
      const dx = o.x - p.x, dz = o.z - p.z;
      if (dx < 16 && dx > -16 && dz < 16 && dz > -16) w.cars.push(o);
    }
    if (w.mode !== WALK || w.flee > 0 || w.cool > 0) return;
    if (w.pier) {
      // Lean on the rail and look at the sea for a bit.
      if (rng.chance(0.04)) { w.mode = IDLE; w.timer = 0; w.face = w.inset > 0 ? Math.PI / 2 : -Math.PI / 2; w.cool = rng.range(5, 14); }
      return;
    }
    const b = w.block;
    for (const s of this.spots[b.id]) {
      if (s.side !== w.side || !s.prop.alive || s.n >= (s.bench ? 1 : 3)) continue;
      const dx = s.prop.x - p.x, dz = s.prop.z - p.z;
      if (dx * dx + dz * dz > 30 || (dx * Math.sin(p.h) + dz * Math.cos(p.h)) < 0 || !rng.chance(s.bench ? 0.3 : 0.18)) continue;
      w.spot = s; s.n++;
      w.mode = GOTO; w.timer = 0;
      const off = s.bench ? 0.62 : 1.15, al = s.bench ? 0 : rng.range(-1.6, 1.6);
      w.tx = s.prop.x + IN_X[s.side] * off + DIR_X[s.side] * al; w.tz = s.prop.z + IN_Z[s.side] * off + DIR_Z[s.side] * al;
      return;
    }
    if (SHOPS[b.district] && rng.chance(0.014)) {
      // A shop window.
      w.mode = IDLE; w.timer = 0; w.face = INWARD[w.side]; w.cool = rng.range(4, 9);
    } else if (w.jay && rng.chance(0.03)) this.jaywalk(w);
  }

  // ── Cars ───────────────────────────────────────────────────────────────────

  /** Everything a walker does about moving vehicles: get knocked down, run, step aside, hurry up. */
  private traffic(w: Walker): void {
    const p = w.p, down = w.mode === DOWN;
    for (const m of this.movers) {
      const v = m.v, dx = p.x - v.x, dz = p.z - v.z;
      if (dx > 20 || dx < -20 || dz > 20 || dz < -20) continue;
      const lf = dx * m.sh + dz * m.ch, lr = -dx * m.ch + dz * m.sh;
      const al = Math.abs(lf), ar = Math.abs(lr);
      if (al < v.hl + 0.3 && ar < v.hw + 0.3 && Math.abs(v.y - p.y) < 1.5) {
        if (m.sp > KNOCK) { this.knock(w, m); if (!down) return; continue; }
        if (down) continue;
        // Crawling: shouldered aside, not flattened.
        if (v.hw + R - ar < v.hl + R - al) { const s = lr < 0 ? -1 : 1, k = v.hw + R - ar; p.x -= m.ch * k * s; p.z += m.sh * k * s; }
        else { const s = lf < 0 ? -1 : 1, k = v.hl + R - al; p.x += m.sh * k * s; p.z += m.ch * k * s; }
        continue;
      }
      if (down) continue;
      // How far ahead of the way it is going (it may be reversing).
      const ahead = v.speed < 0 ? -lf : lf, d2 = dx * dx + dz * dz;
      if (m.sp > 15.5 && d2 < 196 && ar < 7 && (ahead > 0 || d2 < 36)) { this.scare(w, v.x, v.z, 4); continue; }
      if (m.sp > 1 && ahead > 0 && ahead < v.hl + 1 + m.sp * 1.5 && ar < v.hw + 0.8) {
        if (w.inRoad) w.hurry = 0.6;
        else if (w.mode !== SIT || m.sp > 3) {
          // A car on the sidewalk and coming this way: out from in front of it, sideways.
          const s = lr < 0 ? -1 : 1;
          w.asideX = -m.ch * s * 3; w.asideZ = m.sh * s * 3; w.asideT = 0.4;
          if (w.mode === SIT || w.mode === IDLE || m.sp > 6) this.scare(w, v.x, v.z, 2.5);
        }
      }
    }
  }

  private knock(w: Walker, m: Mover): void {
    const p = w.p, v = m.v, was = w.mode === DOWN;
    // Carried along with the car, a little slower, and already down.
    if (was && Math.hypot(w.vx, w.vz) > m.sp * 0.6) return;
    w.vx = v.vx * 0.85; w.vz = v.vz * 0.85;
    if (was && w.hitCool > 0) return;
    this.leave(w);
    w.mode = DOWN; w.nb = null; w.flee = 0;
    w.hard = w.hard || m.sp >= HARD;
    w.timer = w.hard ? 8 : this.rng.range(2.4, 3.8);
    w.hitCool = 1.2;
    p.pose = 'down'; p.speed = 0; p.h = Math.atan2(v.vx, v.vz);
    p.health = w.hard ? 0 : Math.max(10, p.health - 35);
    this.stats.hits++;
    this.game.emit('pedHit', { x: p.x, z: p.z, speed: m.sp, byPlayer: v.driver === 'player' });
    if (m.sp > 5) this.alarm(p.x, p.z, 16);
  }

  /** Lying in the road: slide to a stop, then get up if it was only a bump. */
  private lie(w: Walker, dt: number): void {
    const p = w.p, g = this.game;
    const sp = Math.hypot(w.vx, w.vz);
    if (sp > 0.05) {
      const k = Math.max(0, sp - 7 * dt) / sp;
      w.vx *= k; w.vz *= k;
      p.x += w.vx * dt; p.z += w.vz * dt;
      g.col.resolveCircle(p, R, p.y + 0.2);
    } else w.vx = w.vz = 0;
    p.y = groundAt(p.x, p.z);
    p.pose = 'down'; p.speed = 0;
    w.timer -= dt;
    if (w.timer > 0 || sp > 0.3) return;
    const wet = p.y < -0.5;
    if (!w.hard && !wet) {
      // Only a bump: up, and away from here at a trot.
      p.pose = 'stand';
      this.adopt(w);
      w.flee = 2.5;
      return;
    }
    // Nobody is carted off in plain view. Once nobody is looking they are back in the pool, unharmed and unimpressed.
    if (wet || spawnOk(g, p.x, p.z, 40, 1e5, 95)) { w.active = false; w.hard = false; w.mode = WALK; p.visible = false; p.health = 100; }
  }

  /** Run from (x, z) for a while: along the sidewalk, whichever way is away. */
  private scare(w: Walker, x: number, z: number, secs: number): void {
    if (w.mode === DOWN) return;
    if (w.flee <= 0) this.stats.fled++;
    w.flee = Math.max(w.flee, secs);
    if (w.mode === CROSS) return;
    this.leave(w);
    const p = w.p;
    if (w.pier) { w.dir = p.z >= z ? 1 : -1; return; }
    const along = (p.x - x) * DIR_X[w.side] + (p.z - z) * DIR_Z[w.side];
    if (Math.abs(along) > 0.5) w.dir = along > 0 ? 1 : -1;
  }

  // ── Moving ─────────────────────────────────────────────────────────────────

  /**
   * Walk toward (tx, tz) at `speed`, giving way to people, walls, furniture and parked cars.
   * Returns the distance still to go.
   */
  private step(w: Walker, tx: number, tz: number, speed: number, dt: number): number {
    const p = w.p, g = this.game;
    let dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.02) { p.speed = 0; p.pose = 'stand'; w.vx = w.vz = 0; return d; }
    dx /= d; dz /= d;
    if (w.sideT > 0) {
      // Getting nowhere: sidle round whatever it is.
      const c = 0.26, s = 0.966 * w.sideS, rx = dx * c - dz * s, rz = dx * s + dz * c;
      dx = rx; dz = rz;
    }
    const v = Math.min(speed, d / dt);
    let vx = dx * v + w.ax, vz = dz * v + w.az;
    const cap = Math.max(speed, 1.2) * 1.15, m = Math.hypot(vx, vz);
    if (m > cap) { vx *= cap / m; vz *= cap / m; }
    const ox = p.x, oz = p.z;
    p.x += vx * dt; p.z += vz * dt;
    p.y = groundAt(p.x, p.z);
    g.col.resolveCircle(p, R, p.y + 0.3);
    for (const c of w.cars) {
      const cx = p.x - c.x, cz = p.z - c.z, reach = c.hl + c.hw + R;
      if (cx > reach || cx < -reach || cz > reach || cz < -reach) continue;
      if (Math.abs(c.vx) + Math.abs(c.vz) > KNOCK) continue;
      const sh = Math.sin(c.h), ch = Math.cos(c.h);
      let lf = cx * sh + cz * ch, lr = -cx * ch + cz * sh;
      const ef = lf - clamp(lf, -c.hl, c.hl), er = lr - clamp(lr, -c.hw, c.hw), e2 = ef * ef + er * er;
      if (e2 >= R * R) continue;
      if (e2 > 1e-8) { const e = Math.sqrt(e2), k = (R - e) / e; lf += ef * k; lr += er * k; }
      else if (c.hw - Math.abs(lr) < c.hl - Math.abs(lf)) lr = (lr < 0 ? -1 : 1) * (c.hw + R);
      else lf = (lf < 0 ? -1 : 1) * (c.hl + R);
      p.x = c.x + lf * sh - lr * ch; p.z = c.z + lf * ch + lr * sh;
    }
    const mx = p.x - ox, mz = p.z - oz, made = Math.hypot(mx, mz) / dt;
    if (made < v * 0.35) w.stuck += dt; else if (w.stuck > 0) w.stuck = Math.max(0, w.stuck - dt * 2);
    if (w.stuck > 0.45 && w.sideT <= 0) { w.sideT = 0.9; w.sideS = this.rng.sign(); w.stuck = 0; }
    w.vx = mx / dt; w.vz = mz / dt;
    p.speed += (made - p.speed) * Math.min(1, dt * 8);
    if (made > 0.25) p.h = dampAngle(p.h, Math.atan2(mx, mz), 9, dt);
    p.pose = p.speed > 3 ? 'run' : p.speed > 0.15 ? 'walk' : 'stand';
    return d;
  }

  // ── The pier ───────────────────────────────────────────────────────────────

  private seatPier(w: Walker): void {
    const rng = this.rng, p = w.p;
    w.inset = rng.sign() * rng.range(5.2, 7.6);
    p.x = w.inset; p.z = rng.range(PIER.z0 + 8, PIER_TURN); p.y = groundAt(p.x, p.z);
    p.h = w.dir > 0 ? 0 : Math.PI;
    p.visible = true; p.health = 100; p.pose = 'walk'; p.bench = false;
    w.active = true; w.mode = WALK; w.hard = false; w.flee = 0;
  }

  /** The pier is busy by day and nearly empty after dark, and changes only when nobody is watching it. */
  private pierLife(w: Walker, day: boolean): void {
    if ((this.frame + w.p.id) % 120 !== 0) return;
    const want = day || w.p.id % 3 === 0;
    if (want === w.active || w.mode === DOWN) return;
    if (!spawnOk(this.game, 0, 520, 150, 1e5, 240)) return;
    if (want) this.seatPier(w); else { this.leave(w); w.active = false; w.p.visible = false; }
  }
}
