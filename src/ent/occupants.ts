// People seen through the car windows (owner, Nov 23: "Show the passengers through the car windows").
//
// The near and street levels of the Blender cars have a cabin and seats behind see-through tinted glass (vehicle.ts
// paneMat); the far level and phones draw the glass solid and nothing inside. So only cars within OCC_R of the camera
// get anybody drawn in them, and nothing at all on the low preset.
//
// Drivers: every car with somebody at the wheel (the player's own, another player's, the traffic's and the police's)
// gets a body from a small pool, posed seated with its hands on the wheel at the driver's seat. The player's own body
// and another player's stay hidden while they drive, as before (the camera and the map read them at the car's middle);
// the pool body wears their look. Passengers: other players riding are their own bodies, placed by ride.ts in the
// seats of PASSENGER_SEATS; this file seats them again in the same step as the cars are drawn (Game.tick calls place()
// between the cars and the people), so a passenger in this player's car does not trail it by a frame at speed.
//
// Pool bodies are marked `occupant`: weapons pass them by (a car's driver is the car's, as before this change).

import type { Look, Person, Vehicle } from '../core/api';
import type { Game } from '../core/game';
import { RNG } from '../core/util';
import { PlayerMode } from '../net/protocol';
import { CUSHION, PASSENGER_SEATS, SEAT_BACK, type VehicleKind } from './vehicleSpecs';

/** Cars nearer the camera than this get their occupants drawn, meters. */
export const OCC_R = 40;
/** At most this many drivers drawn at once (the nearest). */
const POOL = 12;

const spot = { x: 0, z: 0 };

/** Seat height above the car's road level for a kind: the cushion under the sitter's hips. */
function cushion(kind: VehicleKind): number { return CUSHION[kind]; }

/** Place a seated person at `across` (+ toward the passenger side), `along` (from the driver's seat, + forward), `up`. */
function place(v: Vehicle, across: number, along: number, up: number, out: { x: number; y: number; z: number }): void {
  const s = Math.sin(v.h), c = Math.cos(v.h);
  // The driver's seat is level with the driver's door: doorPos says how far along the car that is.
  v.doorPos(1, spot);
  const a = (spot.x - v.x) * s + (spot.z - v.z) * c + along - (SEAT_BACK[v.spec.kind] ?? 0);
  // Right of a car facing (s, c) is (-c, s).
  out.x = v.x - c * across + s * a;
  out.z = v.z + s * across + c * a;
  out.y = v.y + cushion(v.spec.kind) + up;
}

/** Where passenger seat i of car v is now: the point on the cushion under the sitter's hips. False if there is no such seat. */
export function seatSpot(v: Vehicle, i: number, out: { x: number; y: number; z: number }): boolean {
  const seat = PASSENGER_SEATS[v.spec.kind][i];
  if (!seat) return false;
  place(v, seat[0], seat[1], seat[2], out);
  return true;
}

/** Where the driver of car v sits. */
export function driverSpot(v: Vehicle, out: { x: number; y: number; z: number }): void {
  place(v, -(v.seatX ?? 0.37), 0, 0, out);
}

interface Seat { v: Vehicle; p: Person; stamp: number }

export class Occupants {
  /** For the tests and the bench: drivers drawn last frame. */
  drawn = 0;
  private readonly on: boolean;
  private readonly pool: Person[] = [];
  private readonly free: Person[] = [];
  private readonly seats = new Map<Vehicle, Seat>();
  private readonly looks = new Map<number, Look>();
  private readonly cand: Vehicle[] = [];
  private readonly dist = new Map<Vehicle, number>();
  private stamp = 0;
  private readonly at = { x: 0, y: 0, z: 0 };
  /** Test hook: extra passengers in single player (car, seat, person). */
  readonly demo: { v: Vehicle; seat: number; p: Person }[] = [];

  constructor(private readonly game: Game) {
    this.on = game.quality.name !== 'low' && new URLSearchParams(location.search).get('occ') !== '0';
  }

  private body(): Person {
    let p = this.free.pop();
    if (!p) {
      p = this.game.people.spawn(0, -1000, 0);
      p.occupant = true;
      p.pose = 'sit'; p.bench = false; p.speed = 0;
      // Seated from the first frame: a blend from standing would put the head through the roof for a moment.
      this.game.people.settle(p);
      this.pool.push(p);
    }
    return p;
  }

  private release(s: Seat): void {
    s.p.visible = false;
    this.free.push(s.p);
    this.seats.delete(s.v);
  }

  /** The look of whoever drives v. */
  private lookOf(v: Vehicle): Look {
    const g = this.game;
    if (v.driver === 'player' && v === g.player.vehicle) return g.player.person.look;
    const net = g.net;
    if (net && net.remotes.size) for (const r of net.remotes.values()) if (r.vehicle === v && r.body) return r.body.look;
    let l = this.looks.get(v.id);
    if (!l) {
      if (this.looks.size > 400) this.looks.clear();
      l = g.people.randomLook(new RNG(v.id * 7919 + 13));
      // The police wear navy.
      if (v.spec.kind === 'cruiser') l = { ...l, top: 0x1c2638, bottom: 0x1c2638 };
      this.looks.set(v.id, l);
    }
    return l;
  }

  /** Is somebody at v's wheel, as this screen knows it? */
  private driven(v: Vehicle): boolean {
    if (v.removed || v.sunk || v.wreck) return false;
    if (v.driver !== null) return true;
    // Another player's car: driven while its player is in Driving mode (net/remote.ts keeps that).
    const net = this.game.net;
    if (net && net.remotes.size) for (const r of net.remotes.values()) if (r.vehicle === v && r.mode === PlayerMode.Driving) return true;
    return false;
  }

  /** Game.tick, after the cars have moved and been drawn and before the people are: everybody into their seats. */
  place(): void {
    const g = this.game;
    // Other players riding: seated against the car as it is drawn this frame (net/ride.ts decides who sits where).
    g.net?.ride.seatOthers();
    for (const d of this.demo) if (!d.v.removed && seatSpot(d.v, d.seat, this.at)) { const p = d.p; p.x = this.at.x; p.y = this.at.y; p.z = this.at.z; p.h = d.v.h; if (p.pose !== 'sit') { p.pose = 'sit'; this.game.people.settle(p); } p.bench = true; p.speed = 0; p.visible = true; }
    if (!this.on) return;
    const st = ++this.stamp, eye = g.view ? g.view.pos : g.camera.position, r2 = OCC_R * OCC_R;
    const cand = this.cand, dist = this.dist;
    cand.length = 0; dist.clear();
    const look = (list: readonly Vehicle[]): void => {
      for (const v of list) {
        const dx = v.x - eye.x, dy = v.y - eye.y, dz = v.z - eye.z, d = dx * dx + dy * dy + dz * dz;
        if (d < r2 && this.driven(v)) { cand.push(v); dist.set(v, d); }
      }
    };
    look(g.vehicles.list);
    look(g.vehicles.ghostList);
    if (cand.length > POOL) { cand.sort((a, b) => dist.get(a)! - dist.get(b)!); cand.length = POOL; }
    // The ones already seated keep their bodies; the rest take free ones.
    for (const v of cand) { const s = this.seats.get(v); if (s) s.stamp = st; }
    for (const s of [...this.seats.values()]) if (s.stamp !== st) this.release(s);
    for (const v of cand) {
      let s = this.seats.get(v);
      if (!s) { s = { v, p: this.body(), stamp: st }; this.seats.set(v, s); }
      const p = s.p, l = this.lookOf(v);
      if (p.look !== l) p.look = l;
      driverSpot(v, this.at);
      p.x = this.at.x; p.y = this.at.y; p.z = this.at.z; p.h = v.h;
      p.pose = 'sit'; p.bench = false; p.speed = 0; p.visible = true; p.health = 100;
    }
    this.drawn = cand.length;
  }
}
