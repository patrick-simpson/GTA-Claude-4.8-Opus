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
import { kid } from '../core/kid';
import type { Look, Person, Vehicle } from '../core/api';
import { RNG, clamp, dampAngle } from '../core/util';
import { MAIN_SPLIT_Z, waterLevelAt } from '../world/mainland';
import { nearestShore } from '../world/shore';
import { PIER, groundAt, type Block, type District, type RoadEdge, type RoadNode } from '../world/plan';
import type { StreetGraph } from '../world/streets';
import type { Prop } from '../world/collide';
import { signalState } from '../world/signals';
import { spawnOk, type Anchor, type RoadPed } from './traffic';
import { setEmote } from '../ent/character';

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
interface Spot {
  prop: Prop; side: number; bench: boolean; n: number;
  /** New streets: the spot is on an edge's sidewalk. ix, iz point away from the road, tx, tz run along it, sd is the side (+1 left of a -> b). */
  ix?: number; iz?: number; tx?: number; tz?: number; sd?: number;
}

/** A moving vehicle, with the trigonometry done once for everybody. */
export interface Mover {
  v: Vehicle; sh: number; ch: number; sp: number;
  /** Multiplayer host: another player's car. People get out of its way, but only its own browser says whom it has hit. */
  ghost?: boolean;
}

/** Multiplayer host: players who are close together, and the share of the cast kept round them. */
interface Group { a: Anchor; members: Anchor[]; blocks: Block[]; top: number; want: number; n: number; jumped: boolean; fill: number }

/** Where each swimming walker is heading (swimHome). */
const swimTo = new WeakMap<object, { x: number; z: number }>();
/** Metres per second of a pedestrian's paddle. */
const SWIM_PACE = 1.3;

export interface Walker extends RoadPed {
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
  /** New streets: the signalled junction being crossed at and the roads whose mouths the way crosses (must all be at red). */
  cnode: RoadNode | null; ced: RoadEdge[];
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
  /**
   * New streets (plan.streets): the walker follows the sidewalk of an edge instead of a block's side. e is the edge (null = a block
   * walker), es the distance along it, sd the side (+1 is left of a -> b), dir the way along. pe, px, pz, ps, pdir, psd: the edge
   * and the place across the road that a crossing is making for.
   */
  e: RoadEdge | null; es: number; sd: number;
  pe: RoadEdge | null; px: number; pz: number; ps: number; pdir: number; psd: number;
  /** Multiplayer: their number on the wire (0 until this browser has been in a shared town), and which group of players they are nearest. */
  wid: number; grp: number;
  /** Fun queue 2, item 32: seconds left of cheering at (cx, cz), seconds of a startled hop, and seconds before they react to anything again. */
  cheer: number; cx: number; cz: number; hop: number; react: number;
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
  /** New streets: benches and bus-stop posts by the edge whose sidewalk they stand on. */
  private readonly espots = new Map<number, Spot[]>();
  private nearBlocks: Block[] = [];
  /** New streets: the edges with a sidewalk near the player (the mainland's people walk these, not the old blocks). */
  private nearEdges: RoadEdge[] = [];
  private readonly sg: StreetGraph | null;
  private nearT = 0;
  /** The busiest of the near blocks, so the choice between them is relative. */
  private top = 1;
  private movers: readonly Mover[] = [];
  private frame = 0;
  // Result of at(): a point on a block's sidewalk.
  private qx = 0; private qz = 0;

  // ── Multiplayer (src/net/people.ts; Ambient passes the first three on from the traffic) ──
  /** The other players in town, when this browser is the host: the cast is kept round all of them. Empty otherwise. */
  extra: readonly Anchor[] = [];
  /** Their cars (drawn only, so not in vehicles.list), and those of them on foot. */
  others: readonly Vehicle[] = [];
  feet: readonly RoadPed[] = [];
  /** The host's people are shown instead: nobody is simulated here, and the bodies are the network's to place. */
  guest = false;
  /** Guest: something loud happened here; the host is told, and its people run. */
  onAlarm: ((x: number, z: number, radius: number) => void) | null = null;
  /** Guest: one of the shown people was punched or shot here. Returns whether they look finished. */
  onHurt: ((p: Person, dmg: number, dx: number, dz: number, fist: boolean, shove: number) => boolean) | null = null;
  private readonly groups: Group[] = [];
  private readonly own: Anchor = { x: 0, z: 0, cx: 0, cz: 0, yaw: 0, jumped: false, n: 0 };
  private seatA: Anchor | null = null;
  private wasMany = false;

  constructor(private readonly game: Game) {
    const rng = this.rng, plan = game.plan;
    this.sg = plan.streets;
    for (const b of plan.blocks) {
      // With the new streets the old mainland grid is gone: its blocks hold nobody.
      this.usable[b.id] = (b.road[0] || b.road[1] || b.road[2] || b.road[3]) && !(this.sg && b.land === 1);
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
    // The new streets: the same furniture, filed under the edge (and side) it stands beside.
    const sgr = this.sg;
    if (sgr) {
      game.col.forProps(60, -2000, 1100, (pr) => {
        if ((pr.kind !== 'bench' || pr.r > 0.6) && pr.kind !== 'post') return;
        const ne = sgr.nearestEdge(pr.x, pr.z, (e) => e.id >= sgr.isle.edges && this.kindWalks(e)).edge;
        if (!ne) return;
        const s = sgr.project(ne, pr.x, pr.z).s, c = sgr.pointAt(ne, s), ox = -c.dz, oz = c.dx;
        const lat = (pr.x - c.x) * ox + (pr.z - c.z) * oz, a = Math.abs(lat);
        if (a < ne.hw - 0.2 || a > ne.hw + 3.2 || s < 6 || s > ne.len - 6) return;
        const sd = lat >= 0 ? 1 : -1;
        let l = this.espots.get(ne.id);
        if (!l) { l = []; this.espots.set(ne.id, l); }
        l.push({ prop: pr, side: 0, bench: pr.kind === 'bench', n: 0, ix: ox * sd, iz: oz * sd, tx: c.dx, tz: c.dz, sd });
      });
    }

    const den = clamp(game.quality.density, 0.4, 1);
    const nW = Math.round(WALKERS * den), nS = Math.round(STROLLERS * den);
    for (let i = 0; i < nW + nS; i++) {
      const w: Walker = {
        p: game.people.spawn(0, 0, 0), active: false, pier: i >= nW, block: this.blocks[0], side: 0, t: 0, dir: rng.sign(), inset: 2,
        // A few amble, a few stride.
        pace: rng.chance(0.2) ? rng.range(0.9, 1.15) : rng.chance(0.25) ? rng.range(1.6, 1.95) : rng.range(1.2, 1.6),
        mode: WALK, timer: 0, tx: 0, tz: 0, nb: null, nside: 0, nt: 0, node: null, crossH: false, cs: 1.5, cnode: null, ced: [],
        jay: rng.chance(0.14), spot: null, face: 0, flee: 0, hurry: 0, hard: false,
        cheer: 0, cx: 0, cz: 0, hop: 0, react: 0, ax: 0, az: 0, asideX: 0, asideZ: 0, asideT: 0, stuck: 0, sideT: 0, sideS: 1,
        cool: rng.range(4, 40), scan: rng.next() * 0.5, cars: [], inRoad: false, hitCool: 0,
        x: 0, z: 0, vx: 0, vz: 0, wid: 0, grp: 0,
        e: null, es: 0, sd: 1, pe: null, px: 0, pz: 0, ps: 0, pdir: 1, psd: 1,
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
    for (const e of this.nearEdges) f += this.edgeBusy(e);
    const cnt = this.nearBlocks.length + this.nearEdges.length;
    f = cnt ? Math.min(1, f / cnt * 1.15) : 0;
    return Math.round(n * f * (this.game.sky.weather === 'rain' ? 0.55 : 1));
  }

  /** Fun queue 2, item 32: told when the player's car passes a walker close by (the crowd shouts). */
  onFlinch: ((w: Walker, v: Vehicle) => void) | null = null;
  /** The walkers cheerAt() has just turned to watch. */
  readonly cheerers: Walker[] = [];
  /** The other half of the pair chatterNear() last returned. */
  partner: Walker | null = null;

  /**
   * Item 32: up to `max` people within `radius` of (x, z) stop, turn to watch it and clap or cheer for `secs`. Only people
   * strolling or standing about: not those crossing, sitting, running or down. Returns how many.
   */
  cheerAt(x: number, z: number, radius: number, max: number, secs: number): number {
    const out = this.cheerers;
    out.length = 0;
    if (this.guest) return 0;
    const r2 = radius * radius;
    for (const w of this.walkers) {
      if (out.length >= max) break;
      if (!w.active || w.pier || w.flee > 0 || w.cheer > 0 || (w.mode !== WALK && w.mode !== IDLE)) continue;
      const dx = w.p.x - x, dz = w.p.z - z;
      if (dx * dx + dz * dz > r2) continue;
      this.leave(w);
      w.mode = IDLE; w.timer = 0; w.cool = secs * 2 + 0.6; w.cheer = secs; w.cx = x; w.cz = z; w.vx = w.vz = 0;
      w.p.speed = 0; w.hop = 0;
      setEmote(w.p, this.rng.chance(0.5) ? 5 : 6);
      out.push(w);
    }
    return out.length;
  }

  /**
   * Item 32: two people strolling or standing within 3 m of each other, near (x, z), free to talk. Returns one and leaves the
   * other in `partner`, or null. Nothing changes until converse() is called on them.
   */
  chatterNear(x: number, z: number, radius: number): Walker | null {
    if (this.guest) return null;
    const ws = this.walkers, n = ws.length, r2 = radius * radius, off = Math.floor(this.rng.next() * n);
    for (let ii = 0; ii < n; ii++) {
      const a = ws[(ii + off) % n];
      if (!this.chatty(a)) continue;
      const ax = a.p.x - x, az = a.p.z - z;
      if (ax * ax + az * az > r2) continue;
      for (let jj = 1; jj < n; jj++) {
        const b = ws[(ii + off + jj) % n];
        if (!this.chatty(b)) continue;
        const dx = b.p.x - a.p.x, dz = b.p.z - a.p.z;
        if (dx * dx + dz * dz > 9) continue;
        this.partner = b;
        return a;
      }
    }
    return null;
  }

  /** The two stop and face each other for `secs`. */
  converse(a: Walker, b: Walker, secs: number): void {
    const dx = b.p.x - a.p.x, dz = b.p.z - a.p.z;
    this.hush(a, secs); this.hush(b, secs);
    a.face = Math.atan2(dx, dz); b.face = Math.atan2(-dx, -dz);
  }

  private hush(w: Walker, secs: number): void {
    this.leave(w);
    w.mode = IDLE; w.timer = 0; w.cool = secs * 2; w.react = secs + 10; w.vx = w.vz = 0; w.p.speed = 0;
  }

  private chatty(w: Walker): boolean {
    return w.active && !w.pier && w.react <= 0 && w.flee <= 0 && w.cheer <= 0 && !w.inRoad && (w.mode === WALK || w.mode === IDLE);
  }

  /** A crash, a bang: everyone within earshot runs from it. */
  alarm(x: number, z: number, radius: number): void {
    if (this.guest) { this.onAlarm?.(x, z, radius); return; }
    for (const w of this.walkers) {
      if (!w.active || w.mode === DOWN) continue;
      const dx = w.p.x - x, dz = w.p.z - z;
      if (dx * dx + dz * dz < radius * radius) this.scare(w, x, z, this.rng.range(3.5, 6));
    }
  }

  /** A driver climbs out at (x, z) and runs from their car. Borrows whoever in the cast is furthest out of sight. */
  spawnDriver(v: Vehicle, x: number, z: number): void {
    if (this.guest) return;
    let best: Walker | null = null, far = 0;
    for (const w of this.walkers) {
      if (w.pier || w.mode === DOWN) continue;
      if (!w.active) { best = w; break; }
      const d2 = this.far2(w.p.x, w.p.z);
      if (d2 > far && this.fair(w.p.x, w.p.z, 50, 1e5, 100)) { far = d2; best = w; }
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
    if (this.guest) return;
    // A host keeps people round every player in town: `gs` is those players, in groups. Alone, none of this runs.
    const many = this.extra.length > 0, gs = this.groups;
    let moved = jumped || many !== this.wasMany;
    this.wasMany = many;
    if (many) {
      const a = this.own, cam = g.camera.position;
      a.x = px; a.z = pz; a.cx = cam.x; a.cz = cam.z; a.yaw = g.cam.yaw; a.jumped = jumped;
      for (const e of this.extra) if (e.jumped) moved = true;
    }
    if ((this.nearT -= dt) <= 0 || moved) this.refreshNear();
    if (many) {
      for (const q of gs) {
        q.n = 0; q.jumped = false;
        for (const m of q.members) if (m.jumped) q.jumped = true;
        // Somebody has just arrived there: their street is filled in plain view for a moment, as it is after a jump alone.
        if (q.jumped) q.fill = 2.5; else if (q.fill > 0) q.fill -= dt;
      }
      for (const w of this.walkers) {
        if (!w.active || w.pier) continue;
        let best = 0, bd = Infinity;
        for (let k = 0; k < gs.length; k++) { const a = gs[k].a, dx = w.p.x - a.x, dz = w.p.z - a.z, d2 = dx * dx + dz * dz; if (d2 < bd) { bd = d2; best = k; } }
        w.grp = best; gs[best].n++;
      }
    }

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
      // The other players on foot get the same room, and the same fright when they run straight at somebody.
      for (const o of this.feet) {
        const dx = ap.x - o.x, dz = ap.z - o.z, d2 = dx * dx + dz * dz;
        if (d2 >= 2.56 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), f = (1.6 - d) * 1.8 / d;
        a.ax += dx * f; a.az += dz * f;
        if (o.vx * o.vx + o.vz * o.vz > 27 && d < 1.3 && dx * o.vx + dz * o.vz > 0) this.scare(a, o.x, o.z, 3);
      }
    }

    let tries = 3;
    for (let i = 0; i < n; i++) {
      const w = ws[i], p = w.p;
      if (w.pier) { this.pierLife(w, day); if (!w.active) continue; }
      else if (!w.active) {
        if (many) {
          // For whichever group of players is furthest short of its share.
          let q: Group | null = null, need = 0;
          for (const c of gs) if (c.want - c.n > need) { need = c.want - c.n; q = c; }
          if (q && (tries > 0 || q.fill > 0)) {
            tries--;
            const nb = this.nearBlocks, top = this.top;
            this.nearBlocks = q.blocks; this.top = q.top; this.seatA = q.a;
            if (q.jumped) { for (let k = 0; k < 40 && !w.active; k++) this.seat(w, 8, 110, 0); }
            else if (q.fill > 0) { for (let k = 0; k < 6 && !w.active; k++) this.seat(w, 8, 110, 0); }
            else this.seat(w, 40, 118, 80);
            this.nearBlocks = nb; this.top = top; this.seatA = null;
            if (w.active) { out++; q.n++; w.grp = gs.indexOf(q); }
          }
          continue;
        }
        // A few tries a frame fill a street within a few seconds of arriving on it.
        if (out < target && (tries > 0 || jumped)) {
          tries--;
          if (jumped) { for (let k = 0; k < 40 && !w.active; k++) this.seat(w, 8, 110, 0); }
          else this.seat(w, 40, 118, 80);
          if (w.active) out++;
        }
        continue;
      } else if (many) {
        const q = gs[w.grp] ?? gs[0];
        // Far from everybody, or more round these players than their share while others go short: out, when nobody can see.
        if (this.far2(p.x, p.z) > 135 * 135
          || (q.n > q.want && w.mode !== DOWN && (this.frame + i) % 10 === 0 && this.fair(p.x, p.z, 35, 1e5, 85))) {
          this.leave(w); w.active = false; p.visible = false; out--; q.n--;
          continue;
        }
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
      if (w.react > 0) w.react -= dt;
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
          if (w.e) { this.pathWalk(w, v, dt); break; }
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
          else if (w.timer > 45 || run) { w.mode = WALK; w.dir = -w.dir; w.pe = null; }
          break;
        }
        case CROSS: {
          this.atFar(w);
          const far = this.step(w, this.qx, this.qz, run ? 4.6 : w.cs * (w.hurry > 0 ? 1.4 : 1), dt);
          w.timer += dt;
          if (far < 0.5 && w.pe) { w.e = w.pe; w.es = w.ps; w.dir = w.pdir; w.sd = w.psd; w.pe = null; w.mode = WALK; }
          else if (far < 0.5 && w.nb) { w.block = w.nb; w.side = w.nside; w.nb = null; w.mode = WALK; }
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
            p.x = s.prop.x - (s.ix ?? IN_X[s.side]) * 0.22; p.z = s.prop.z - (s.iz ?? IN_Z[s.side]) * 0.22; p.y = groundAt(p.x, p.z) + 0.42;
            w.face = s.ix !== undefined ? Math.atan2(s.ix, s.iz!) : INWARD[s.side]; w.cool = rng.range(10, day ? 30 : 16);
          } else { w.mode = IDLE; w.face = (s.ix !== undefined ? Math.atan2(s.ix, s.iz!) : INWARD[s.side]) + Math.PI; w.cool = rng.range(9, 24); }
          break;
        }
        default: {
          // IDLE and SIT: on the spot until the mood passes.
          w.timer += dt;
          p.pose = w.mode === SIT ? 'sit' : 'stand'; p.speed = 0;
          if (w.cheer > 0) { w.cheer -= dt; w.face = Math.atan2(w.cx - p.x, w.cz - p.z); }
          p.h = dampAngle(p.h, w.face, 5, dt);
          w.vx = w.vz = 0;
          if (run || w.timer > w.cool || (w.spot && !w.spot.prop.alive)) { this.leave(w); w.cool = rng.range(15, 45); }
        }
      }
      if (w.hop > 0) { w.hop -= dt; p.pose = 'jump'; }
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
    if (w.pe) { this.qx = w.px; this.qz = w.pz; }
    else if (w.nb && w.nt >= 0) this.at(w.nb, w.nside, w.nt, w.inset);
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
    this.nearEdges = [];
    const sg = this.sg;
    if (sg && pl.z < MAIN_SPLIT_Z + 130) {
      for (let k = sg.isle.edges; k < sg.edges.length; k++) {
        const e = sg.edges[k];
        if (!this.walkable(e)) continue;
        const m = sg.pointAt(e, e.len / 2);
        if (Math.abs(m.x - pl.x) < 100 + e.len / 2 && Math.abs(m.z - pl.z) < 100 + e.len / 2 && sg.project(e, pl.x, pl.z).d < 100) this.nearEdges.push(e);
      }
    }
    for (const b of this.nearBlocks) this.top = Math.max(this.top, this.busy(b));
    for (const e of this.nearEdges) this.top = Math.max(this.top, this.edgeBusy(e));
    if (this.extra.length > 0) this.regroup();
  }

  // ── Multiplayer host: one cast, kept round every player ─────────────────────

  /**
   * Who is where: players within 50 m of each other are one group. Each group would have its single player crowd; when
   * those add up to more than the cast, every group is cut back by the same share. Never more people than one game has.
   */
  private regroup(): void {
    const gs = this.groups, old = gs.slice();
    gs.length = 0;
    let street = 0;
    for (const w of this.walkers) if (!w.pier) street++;
    const rain = this.game.sky.weather === 'rain' ? 0.55 : 1;
    let sum = 0;
    const add = (a: Anchor): void => {
      for (const q of gs) {
        const dx = q.a.x - a.x, dz = q.a.z - a.z;
        if (dx * dx + dz * dz < 2500) { q.members.push(a); return; }
      }
      const blocks = this.blocks.filter((b) => {
        const r = b.rect, dx = Math.max(r.x0 - a.x, 0, a.x - r.x1), dz = Math.max(r.z0 - a.z, 0, a.z - r.z1);
        return dx * dx + dz * dz < 100 * 100;
      });
      let top = 0.01, f = 0;
      for (const b of blocks) { const k = this.busy(b); f += k; if (k > top) top = k; }
      f = blocks.length ? Math.min(1, f / blocks.length * 1.15) : 0;
      const want = Math.round(street * f * rain);
      sum += want;
      gs.push({ a, members: [a], blocks, top, want, n: 0, jumped: false, fill: old.find((q) => q.a === a)?.fill ?? 0 });
    };
    add(this.own);
    for (const a of this.extra) add(a);
    if (sum > street) for (const q of gs) q.want = Math.floor(q.want * street / sum);
  }

  /** Squared distance from (x, z) to the nearest player in town. */
  private far2(x: number, z: number): number {
    const pl = this.game.player;
    let dx = x - pl.x, dz = z - pl.z, d2 = dx * dx + dz * dz;
    for (const a of this.extra) { dx = x - a.x; dz = z - a.z; d2 = Math.min(d2, dx * dx + dz * dz); }
    return d2;
  }

  /**
   * Is (x, z) a fair place for somebody to appear or vanish? Alone, exactly spawnOk. As host: at least `near` from
   * every player, within `far` of the one being seated for, and behind or `front` away from everybody's view.
   */
  private fair(x: number, z: number, near: number, far: number, front: number): boolean {
    const g = this.game;
    if (this.extra.length === 0) return spawnOk(g, x, z, near, far, front);
    const s = this.seatA;
    if (s && s !== this.own) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > far * far) return false;
      far = 1e9;
    }
    if (!spawnOk(g, x, z, near, far, front)) return false;
    for (const a of this.extra) {
      const dx = x - a.x, dz = z - a.z;
      if (dx * dx + dz * dz < near * near) return false;
      if (front <= 0) continue;
      const cx = x - a.cx, cz = z - a.cz;
      if (cx * Math.sin(a.yaw) + cz * Math.cos(a.yaw) >= 0 && cx * cx + cz * cz <= front * front) return false;
    }
    return true;
  }

  /** Every walker gets a number for the wire and the look that goes with that number, the same in every browser. */
  number(lookOf: (wid: number) => Look): void {
    const used = new Set<number>();
    for (const w of this.walkers) if (w.wid) used.add(w.wid);
    let next = 1;
    for (const w of this.walkers) {
      if (!w.wid) { while (used.has(next)) next++; w.wid = next; used.add(next); }
      const look = lookOf(w.wid);
      if (w.p.look !== look) w.p.look = look;
    }
  }

  /** The walker with this number, if they are out. */
  byWid(wid: number): Walker | null {
    if (wid) for (const w of this.walkers) if (w.wid === wid && w.active) return w;
    return null;
  }

  /**
   * The host's people are shown here from now on: everybody steps out of the simulation. `keep` is told of each who
   * was out (a host handing over: they stay where they stand, and the new host's frames move them).
   */
  lend(keep: ((w: Walker) => void) | null): void {
    for (const w of this.walkers) {
      if (w.active && keep) keep(w);
      w.p.bench = false;
      if (w.spot) { w.spot.n--; w.spot = null; }
      w.active = false; w.mode = WALK; w.nb = null; w.flee = 0; w.hard = false; w.vx = w.vz = 0;
    }
    this.road.length = 0;
    this.guest = true;
  }

  /** Simulating again (host of the town, or alone). */
  resume(): void { this.guest = false; this.nearT = 0; }

  /** Forget every number: the ones the last host used are about to be given out with its people. */
  unnumber(): void { for (const w of this.walkers) w.wid = 0; }

  /** Carry on with somebody the last host was simulating: this walker's body already stands where they were shown. */
  takeOver(w: Walker, wid: number, down: boolean, hard: boolean, run: boolean): void {
    const p = w.p;
    w.wid = wid; w.active = true;
    w.pier = p.x > PIER.x0 && p.x < PIER.x1 && p.z > PIER.z0 + 2;
    p.visible = true; p.bench = false;
    w.spot = null; w.nb = null; w.flee = run ? 3 : 0; w.hurry = 0; w.hard = hard;
    w.cars.length = 0; w.scan = 0; w.stuck = 0; w.sideT = 0; w.asideT = 0; w.hitCool = 0; w.timer = 0; w.vx = w.vz = 0;
    w.x = p.x; w.z = p.z;
    if (down) {
      // Still on the ground: they get up (or do not) on this browser's clock from here.
      this.adopt(w);
      w.mode = DOWN; w.timer = hard ? 8 : 2.5; p.pose = 'down';
      return;
    }
    p.y = groundAt(p.x, p.z);
    this.adopt(w);
    if (w.pier) w.dir = Math.cos(p.h) >= 0 ? 1 : -1;
    else if (w.e) w.dir = this.alongDir(w, Math.sin(p.h), Math.cos(p.h));
    else w.dir = Math.sin(p.h) * DIR_X[w.side] + Math.cos(p.h) * DIR_Z[w.side] >= 0 ? 1 : -1;
  }

  /** Multiplayer host: another player's car has run this person down (their browser saw it; nobody else decides). */
  struck(wid: number, cvx: number, cvz: number): boolean {
    const w = this.byWid(wid), sp = Math.hypot(cvx, cvz);
    if (!w || !(sp > KNOCK) || kid.on) return false;
    this.fall(w, cvx, cvz, sp, false);
    return true;
  }

  /** For the tests: somebody stands at (x, z) facing h for `secs`, unless frightened off. Returns their number (0 = nobody free). */
  stand(x: number, z: number, h: number, secs: number): number {
    if (this.guest) return 0;
    let best: Walker | null = null, far = -1;
    for (const w of this.walkers) {
      if (w.pier || w.mode === DOWN) continue;
      const d2 = w.active ? this.far2(w.p.x, w.p.z) : Infinity;
      if (d2 > far) { far = d2; best = w; }
    }
    if (!best) return 0;
    const w = best, p = w.p;
    this.leave(w);
    p.x = x; p.z = z; p.y = groundAt(x, z); p.h = h; p.visible = true; p.health = 100; p.pose = 'stand'; p.speed = 0; p.bench = false;
    w.active = true; w.flee = 0; w.hurry = 0; w.hard = false; w.cars.length = 0; w.scan = 0; w.vx = w.vz = 0; w.asideT = 0;
    this.adopt(w);
    w.mode = IDLE; w.timer = 0; w.cool = secs; w.face = h;
    return w.wid;
  }

  /** Try one random sidewalk spot. Brings the walker out only if the spot is acceptable. */
  private seat(w: Walker, near: number, far: number, front: number): boolean {
    const rng = this.rng, g = this.game;
    const nB = this.nearBlocks.length, nE = this.nearEdges.length;
    if (nB + nE === 0) return false;
    const pick = rng.int(0, nB + nE - 1);
    if (pick >= nB) return this.seatEdge(w, this.nearEdges[pick - nB], near, far, front);
    const b = this.nearBlocks[pick];
    // Busy districts get more of the cast; the Cannery and the docks next to nobody.
    if (rng.next() * this.top > this.busy(b)) return false;
    let side = rng.int(0, 3);
    for (let k = 0; k < 4 && !b.road[side]; k++) side = (side + 1) & 3;
    // Between the furniture along the kerb and the shopfronts.
    const inset = rng.range(1.5, 2.8), len = this.sideLen(b, side, inset);
    if (len < 6) return false;
    const t = rng.next() * len;
    this.at(b, side, t, inset);
    if (!this.fair(this.qx, this.qz, near, far, front) || g.col.pointBlocked(this.qx, this.qz, 1)) return false;
    w.block = b; w.side = side; w.t = t; w.inset = inset; w.dir = rng.sign(); w.e = null; w.pe = null;
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
    w.pe = null;
    if (this.sg && p.z < MAIN_SPLIT_Z) {
      const sg = this.sg, r = sg.nearestEdge(p.x, p.z, (e) => this.walkable(e));
      const e = r.edge, [lo, hi] = this.span(e), c = sg.pointAt(e, r.s);
      w.e = e; w.es = clamp(r.s, lo, hi); w.inset = clamp(Math.abs(r.d) - e.hw, 1.2, 2.6);
      w.sd = (p.x - c.x) * -c.dz + (p.z - c.z) * c.dx >= 0 ? 1 : -1;
      return;
    }
    w.e = null;
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
    if (w.cheer > 0) { w.cheer = 0; setEmote(w.p, 0); }
    if (w.spot) { w.spot.n--; w.spot = null; }
    if (w.mode === DOWN) return;
    if (w.mode === CROSS) return;
    w.mode = WALK; w.nb = null; w.timer = 0; w.pe = null;
  }

  // ── Sidewalks of the new streets ───────────────────────────────────────────

  /** The kinds of road with a sidewalk (whatever stage the street is open at). */
  private kindWalks(e: RoadEdge): boolean { return !e.deck && e.kind !== 'highway' && e.kind !== 'ramp' && e.kind !== 'bridge'; }

  /** An edge people can walk beside: a street, not a highway, a ramp or the bridge deck, and not behind barriers. */
  private walkable(e: RoadEdge): boolean {
    return !e.deck && !e.closed && e.kind !== 'highway' && e.kind !== 'ramp' && e.kind !== 'bridge' && e.len > 22;
  }

  /** The stretch of an edge with a sidewalk: clear of the junction pads at both ends. */
  private span(e: RoadEdge): [number, number] {
    const sg = this.sg!, A = sg.nodes[e.a], B = sg.nodes[e.b];
    const pa = Math.max(A.hx, A.hz, A.ring ?? 0) + 2.5, pb = Math.max(B.hx, B.hz, B.ring ?? 0) + 2.5;
    return pa + 6 < e.len - pb ? [pa, e.len - pb] : [e.len / 2, e.len / 2];
  }

  private edgeBusy(e: RoadEdge): number {
    const m = this.sg!.pointAt(e, e.len / 2), d = this.game.plan.districtAt(m.x, m.z);
    if (!d) return 0;
    const k = BUSY[d];
    return k[0] + (k[1] - k[0]) * this.game.sky.night;
  }

  private readonly swOk = new Map<number, Uint8Array>();

  /** Is there sidewalk at s on side sd of e: clear of every other street's paved width (the plan puts some streets close)? */
  private sideOk(e: RoadEdge, s: number, sd: number, inset: number): boolean {
    let a = this.swOk.get(e.id);
    const n = Math.ceil(e.len / 3) + 1;
    if (!a) {
      a = new Uint8Array(n * 2);
      for (let k = 0; k < n; k++) {
        for (let q = 0; q < 2; q++) {
          this.edgeAt(e, Math.min(k * 3, e.len), q ? 1 : -1, 1.8);
          a[k * 2 + q] = this.sg!.clearOfOthers(this.qx, this.qz, 0.6, e.id) ? 1 : 0;
        }
      }
      this.swOk.set(e.id, a);
    }
    void inset;
    return a[Math.round(clamp(s, 0, e.len) / 3) * 2 + (sd > 0 ? 1 : 0)] === 1;
  }

  /** Point on the sidewalk of edge e at s, on side sd (+1 left of a -> b), `inset` m past the paved edge. Sets qx, qz. */
  private edgeAt(e: RoadEdge, s: number, sd: number, inset: number): void {
    const c = this.sg!.pointAt(e, s), off = e.hw + inset;
    this.qx = c.x - c.dz * sd * off; this.qz = c.z + c.dx * sd * off;
  }

  /** Which way along their edge (+1 toward b) a heading or a push away points. */
  private alongDir(w: Walker, hx: number, hz: number): number {
    const c = this.sg!.pointAt(w.e!, w.es);
    const d = hx * c.dx + hz * c.dz;
    return Math.abs(d) < 0.05 ? w.dir : d > 0 ? 1 : -1;
  }

  private seatEdge(w: Walker, e: RoadEdge, near: number, far: number, front: number): boolean {
    const rng = this.rng, g = this.game, [lo, hi] = this.span(e);
    if (hi - lo < 6 || rng.next() * this.top > this.edgeBusy(e)) return false;
    const inset = rng.range(1.3, 2.6), sd = rng.sign(), s = rng.range(lo, hi);
    if (!this.sideOk(e, s, sd, inset)) return false;
    this.edgeAt(e, s, sd, inset);
    if (!this.fair(this.qx, this.qz, near, far, front) || g.col.pointBlocked(this.qx, this.qz, 1)) return false;
    w.e = e; w.es = s; w.sd = sd; w.inset = inset; w.dir = rng.sign(); w.pe = null; w.nb = null;
    const p = w.p, c = this.sg!.pointAt(e, s);
    p.x = this.qx; p.z = this.qz; p.y = groundAt(p.x, p.z); p.h = Math.atan2(c.dx * w.dir, c.dz * w.dir);
    p.visible = true; p.health = 100; p.pose = 'walk'; p.bench = false;
    w.active = true; w.mode = WALK; w.flee = 0; w.hard = false; w.cars.length = 0; w.scan = 0;
    w.cool = rng.range(4, 40);
    return true;
  }

  /** WALK along an edge's sidewalk, steering a little ahead; at the end, the corner. */
  private pathWalk(w: Walker, v: number, dt: number): void {
    const e = w.e!, p = w.p, [lo, hi] = this.span(e);
    w.es = this.sg!.project(e, p.x, p.z).s;
    if ((w.dir > 0 && w.es >= hi - 0.35) || (w.dir < 0 && w.es <= lo + 0.35)) { this.pathCorner(w); return; }
    const ahead = clamp(w.es + w.dir * 1.6, lo, hi);
    // Where another street's lanes cover the sidewalk, turn back.
    if (!this.sideOk(e, ahead + w.dir * 3, w.sd, w.inset)) { w.dir = -w.dir; return; }
    this.edgeAt(e, ahead, w.sd, w.inset);
    this.step(w, this.qx, this.qz, v, dt);
  }

  /** At the end of an edge: turn back, or take another street from the junction, crossing the road mouths in between if the way runs over them. */
  private pathCorner(w: Walker): void {
    const sg = this.sg!, e = w.e!, p = w.p, rng = this.rng;
    const node = sg.nodes[w.dir > 0 ? e.b : e.a];
    const cands = node.edges.map((id) => sg.edges[id]).filter((c) => c !== e && this.walkable(c) && this.span(c)[1] > this.span(c)[0]);
    if (!cands.length || rng.chance(w.flee > 0 ? 0.1 : 0.06)) { w.dir = -w.dir; return; }
    const c = rng.pick(cands), fromA = c.a === node.id, [lo, hi] = this.span(c), s2 = fromA ? lo : hi;
    // The sidewalk of the new street nearest to where we stand: the same corner when it is a turn toward our side.
    let best = 1, bd = Infinity;
    for (const sd of [-1, 1]) {
      if (!this.sideOk(c, s2 + (fromA ? 3 : -3), sd, w.inset)) continue;
      this.edgeAt(c, s2, sd, w.inset);
      const d = Math.hypot(this.qx - p.x, this.qz - p.z);
      if (d < bd) { bd = d; best = sd; }
    }
    if (bd === Infinity) { w.dir = -w.dir; return; }
    this.edgeAt(c, s2, best, w.inset);
    const tx = this.qx, tz = this.qz;
    // Does the straight way over cut across any road leaving the junction?
    const pad = Math.max(node.hx, node.hz, node.ring ?? 0) + 3;
    let cross = false;
    const crossed: RoadEdge[] = [];
    for (const id of node.edges) {
      const f = sg.edges[id];
      if (f.deck) continue;
      const fa = f.a === node.id, p0 = sg.pointAt(f, fa ? Math.min(pad, f.len) : Math.max(f.len - pad, 0));
      const ax = p.x, az = p.z, bx = tx, bz = tz, cx = node.x, cz = node.z, dx = p0.x, dz = p0.z;
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
      if (t > 0.02 && t < 0.98 && u > 0 && u < 1) { cross = true; crossed.push(f); }
    }
    const dir2 = fromA ? 1 : -1;
    if (!cross) { w.e = c; w.es = s2; w.dir = dir2; w.sd = best; return; }
    w.pe = c; w.ps = s2; w.pdir = dir2; w.psd = best; w.px = tx; w.pz = tz;
    w.tx = p.x; w.tz = p.z; w.node = null; w.nb = null;
    w.cnode = node.hasLight ? node : null; w.ced = crossed;
    w.mode = KERB; w.timer = 0;
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

  private railsCache: { lightFor(e: RoadEdge, nodeId: number, ahead?: number): 'green' | 'yellow' | 'red' } | null | undefined;
  /** The new streets' drivers (they own the signal phases), found once. */
  private railsOf(): { lightFor(e: RoadEdge, nodeId: number, ahead?: number): 'green' | 'yellow' | 'red' } | null {
    if (this.railsCache === undefined) {
      const sys = this.game.systems.find((q) => (q as unknown as { traffic?: unknown }).traffic) as unknown as { traffic: { rails: { lightFor(e: RoadEdge, nodeId: number, ahead?: number): 'green' | 'yellow' | 'red' } | null } } | undefined;
      this.railsCache = sys ? sys.traffic.rails : undefined;
    }
    return this.railsCache ?? null;
  }

  /** Waiting at the kerb: is this the moment? Sets the pace needed to make it over in time. */
  private mayCross(w: Walker): boolean {
    const g = this.game, p = w.p, node = w.node;
    this.atFar(w);
    const fx = this.qx, fz = this.qz, mx = (p.x + fx) / 2, mz = (p.z + fz) / 2;
    const dist = Math.hypot(fx - p.x, fz - p.z);
    w.cs = Math.max(w.pace, 1.4);
    // The new streets: walk while every road whose mouth the way crosses is held at red, and the red will last the trip.
    if (w.pe && w.cnode && w.ced.length) {
      const rails = this.railsOf(), cn = w.cnode;
      if (rails) {
        const red = (ahead: number): boolean => w.ced.every((f) => rails.lightFor(f, cn.id, ahead) === 'red');
        if (red(0) && !this.moving(mx, mz, 9, 3.5)) {
          for (const v of [w.cs, 2.5]) {
            const need = dist / v + 0.5;
            if (red(need) && red(need * 0.5)) { w.cs = v; return true; }
          }
        }
        if (w.jay && w.timer > 1.5 && !this.moving(mx, mz, 30, 1.5)) { w.cs = 2.1; this.stats.jaywalks++; return true; }
        return false;
      }
    }
    if (node && node.hasLight) {
      // Walk while the traffic being crossed is held at red, and only if the red will last the trip.
      if (g.world.signal(node.id, w.crossH) === 'red' && !this.moving(mx, mz, 9, 3.5)) {
        for (const v of [w.cs, 2.5]) {
          const need = dist / v + 0.5;
          if (signalState(node, w.crossH, g.signalTime + need) === 'red' && signalState(node, w.crossH, g.signalTime + need * 0.5) === 'red') { w.cs = v; return true; }
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
    for (const o of this.others) {
      const dx = o.x - p.x, dz = o.z - p.z;
      if (dx < 16 && dx > -16 && dz < 16 && dz > -16) w.cars.push(o);
    }
    if (w.mode !== WALK || w.flee > 0 || w.cool > 0) return;
    if (w.pier) {
      // Lean on the rail and look at the sea for a bit.
      if (rng.chance(0.04)) { w.mode = IDLE; w.timer = 0; w.face = w.inset > 0 ? Math.PI / 2 : -Math.PI / 2; w.cool = rng.range(5, 14); }
      return;
    }
    if (w.e) { this.edgeErrand(w); return; }
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

  /** New streets: a bench or bus stop beside the way, or a shop window on Main St, for a walker on an edge's sidewalk. */
  private edgeErrand(w: Walker): void {
    const rng = this.rng, p = w.p, e = w.e!;
    for (const s of this.espots.get(e.id) ?? []) {
      if (s.sd !== w.sd || !s.prop.alive || s.n >= (s.bench ? 1 : 3)) continue;
      const dx = s.prop.x - p.x, dz = s.prop.z - p.z;
      if (dx * dx + dz * dz > 30 || (dx * Math.sin(p.h) + dz * Math.cos(p.h)) < 0 || !rng.chance(s.bench ? 0.3 : 0.18)) continue;
      w.spot = s; s.n++;
      w.mode = GOTO; w.timer = 0;
      const off = s.bench ? 0.62 : 1.15, al = s.bench ? 0 : rng.range(-1.6, 1.6);
      w.tx = s.prop.x + s.ix! * off + s.tx! * al; w.tz = s.prop.z + s.iz! * off + s.tz! * al;
      return;
    }
    // A shop window: where the street is lined with shops (Main St and the square), standing square to the glass.
    const d = this.sg!.districtAt(p.x, p.z);
    if ((d === 'main' || d === 'square') && e.kind !== 'highway' && rng.chance(0.014)) {
      const c = this.sg!.pointAt(e, clamp(w.es, 0, e.len));
      w.mode = IDLE; w.timer = 0; w.face = Math.atan2(-c.dz * w.sd, c.dx * w.sd); w.cool = rng.range(4, 9);
    }
  }

  /** Everything a walker does about moving vehicles: get knocked down, run, step aside, hurry up. */
  private traffic(w: Walker): void {
    // Kid-friendly mode (core/kid.ts): cars drive straight through people; nobody is knocked, nudged, scared or hurried.
    if (kid.on) return;
    const p = w.p, down = w.mode === DOWN;
    for (const m of this.movers) {
      const v = m.v, dx = p.x - v.x, dz = p.z - v.z;
      if (dx > 20 || dx < -20 || dz > 20 || dz < -20) continue;
      const lf = dx * m.sh + dz * m.ch, lr = -dx * m.ch + dz * m.sh;
      const al = Math.abs(lf), ar = Math.abs(lr);
      if (al < v.hl + 0.3 && ar < v.hw + 0.3 && Math.abs(v.y - p.y) < 1.5) {
        if (m.sp > KNOCK) { if (m.ghost) continue; this.knock(w, m); if (!down) return; continue; }
        if (down) continue;
        // Crawling: shouldered aside, not flattened.
        if (v.hw + R - ar < v.hl + R - al) { const s = lr < 0 ? -1 : 1, k = v.hw + R - ar; p.x -= m.ch * k * s; p.z += m.sh * k * s; }
        else { const s = lf < 0 ? -1 : 1, k = v.hl + R - al; p.x += m.sh * k * s; p.z += m.ch * k * s; }
        continue;
      }
      if (down) continue;
      // How far ahead of the way it is going (it may be reversing).
      const ahead = v.speed < 0 ? -lf : lf, d2 = dx * dx + dz * dz;
      // Item 32: the player's car brushing past close by: a jump back and a shout, once in a while.
      if (w.react <= 0 && this.onFlinch && m.sp > 4 && al < v.hl + 2.5 && ar < v.hw + 1.3 && v.driver === 'player') {
        w.react = 9; w.hop = 0.5; this.scare(w, v.x, v.z, 2); this.onFlinch(w, v);
      }
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
    const v = m.v;
    this.fall(w, v.vx, v.vz, m.sp, v.driver === 'player');
  }

  /** Run down by something moving at (cvx, cvz), `sp` m/s. */
  private fall(w: Walker, cvx: number, cvz: number, sp: number, byPlayer: boolean): void {
    const p = w.p, was = w.mode === DOWN;
    // Carried along with the car, a little slower, and already down.
    if (was && Math.hypot(w.vx, w.vz) > sp * 0.6) return;
    w.vx = cvx * 0.85; w.vz = cvz * 0.85;
    if (was && w.hitCool > 0) return;
    this.leave(w);
    w.mode = DOWN; w.nb = null; w.flee = 0;
    // (Kid-friendly mode, core/kid.ts: always only a bump. Down, a flight perhaps, and up again dusted off.)
    w.hard = !kid.on && (w.hard || sp >= HARD);
    w.timer = w.hard ? 8 : this.rng.range(2.4, 3.8);
    w.hitCool = 1.2;
    p.pose = 'down'; p.speed = 0; p.h = Math.atan2(cvx, cvz);
    p.health = w.hard ? 0 : Math.max(10, p.health - 35);
    // Near the camera and with room: a ragdoll (ent/ragdoll.ts) instead of the canned fall. It owns the body until it lands.
    if (!was || this.game.people.rag.flying(p)) {
      this.game.people.rag.hitByCar(p, cvx, cvz, {
        by: byPlayer ? 'player' : 'other',
        onDone: (r) => {
          w.vx = w.vz = 0;
          if (r.up) { w.timer = 0; w.hard = false; p.health = Math.max(p.health, 10); }
          else if (!w.hard) w.timer = Math.min(w.timer, this.rng.range(1.2, 2.2));
        },
      });
    }
    this.stats.hits++;
    this.game.emit('pedHit', { x: p.x, z: p.z, speed: sp, byPlayer });
    if (sp > 5) this.alarm(p.x, p.z, 16);
  }

  /** Lying in the road: slide to a stop, then get up if it was only a bump. */
  private lie(w: Walker, dt: number): void {
    const p = w.p, g = this.game;
    if (g.people.rag.flying(p)) return;
    const sp = Math.hypot(w.vx, w.vz);
    if (sp > 0.05) {
      const k = Math.max(0, sp - 7 * dt) / sp;
      w.vx *= k; w.vz *= k;
      p.x += w.vx * dt; p.z += w.vz * dt;
      g.col.resolveCircle(p, R, p.y + 0.2);
    } else w.vx = w.vz = 0;
    p.y = groundAt(p.x, p.z);
    // Knocked into the water and not badly hurt: she swims for the nearest beach (drowning, fun-queue 22).
    if (p.y < -0.5 && !w.hard && this.swimHome(w, dt)) return;
    p.pose = 'down'; p.speed = 0;
    w.timer -= dt;
    if (w.timer > 0 || sp > 0.3) return;
    const wet = p.y < -0.5;
    if (kid.on && w.hard) { w.hard = false; p.health = Math.max(p.health, 10); }
    if (!w.hard && !wet) {
      // Only a bump: up, and away from here at a trot.
      p.pose = 'stand';
      this.adopt(w);
      w.flee = 2.5;
      return;
    }
    // Nobody is carted off in plain view. Once nobody is looking they are back in the pool, unharmed and unimpressed.
    if (wet || this.fair(p.x, p.z, 40, 1e5, 95)) { w.active = false; w.hard = false; w.mode = WALK; p.visible = false; p.health = 100; }
  }

  /** A walker in deep water paddles to the closest dry sand and carries on. False if there is none in reach (she is then taken away as before). */
  private swimHome(w: Walker, dt: number): boolean {
    const p = w.p;
    let s = swimTo.get(w);
    if (!s) {
      const sh = nearestShore(p.x, p.z, 300);
      if (!sh) return false;
      swimTo.set(w, (s = { x: sh.x, z: sh.z }));
    }
    const dx = s.x - p.x, dz = s.z - p.z, d = Math.hypot(dx, dz);
    if (d > 1.2) {
      const k = Math.min(d, SWIM_PACE * dt) / d;
      p.x += dx * k; p.z += dz * k;
      p.h = dampAngle(p.h, Math.atan2(dx, dz), 6, dt);
      p.y = waterLevelAt(p.x, p.z) - 1.3;
      p.pose = 'swim'; p.speed = SWIM_PACE;
      return true;
    }
    swimTo.delete(w);
    p.x = s.x; p.z = s.z; p.y = groundAt(s.x, s.z);
    p.pose = 'stand'; p.speed = 0; p.health = Math.max(p.health, 10);
    this.adopt(w);
    w.flee = 2.5;
    return true;
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
    if (w.e) { w.dir = this.alongDir(w, p.x - x, p.z - z); return; }
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
      if (Math.abs(c.vx) + Math.abs(c.vz) > (kid.on ? 0.3 : KNOCK)) continue;
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
    if (!this.fair(0, 520, 150, 1e5, 240)) return;
    if (want) this.seatPier(w); else { this.leave(w); w.active = false; w.p.visible = false; }
  }
}
