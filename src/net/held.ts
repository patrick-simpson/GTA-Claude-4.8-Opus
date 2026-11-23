// Multiplayer, stage 4, step 2: a mission's cars and a job's cars stay their runner's.
//
// Each player runs their own missions and jobs (the working rule of stage 4; the owner has been asked). A script
// marks the cars it is using (Vehicle.held: the van it made, the cab the shift is in, the car to be towed) and unmarks
// them when it lets go. Alone the mark means nothing. In a town on the MAIN service it means the car is its runner's
// and nobody else's, and the runner's own browser is the one that simulates it and says what becomes of it:
//
//  - It is never handed to the town. Getting out of an ordinary car gives it to the host (cars.ts); getting out of a
//    held one does not, so it gets no number in the traffic frames, the host never stands a copy of it, cannot give
//    it to anybody who asks, and has nothing of it to tidy away as a wreck (cars.ts and shared.ts leave it alone).
//  - The others are SHOWN it, as that player's car: while the runner drives it, by the runner's State frames like any
//    car; while it stands with nobody in it, by the list sent from here (protocol.ts, "Held"). On their screens it is
//    drawn and solid like another player's car (Vehicles.ghost), which is also why nobody else can get in: it is not
//    one of their browser's cars and not one of the town's, so it has no door for them.
//  - When the script takes it away (despawn, a retry, the mission set aside or over) it leaves the list, and is gone
//    from every screen; there never was a second copy anywhere to be left behind.
//  - When the script lets go of one that is still on the street with nobody in it (the shift ended with the driver on
//    foot), it is left to the town from that moment exactly as if the player had just got out of it.
//
// What this costs: nothing while the cars stand still. The whole list (4 + 15 bytes a car) goes when a car joins or
// leaves it or one in it moves, at most SEND_HZ times a second, and once when somebody arrives.
//
// Not here yet (later steps): the mission's people, a cab's rider, another player's shots at a held car (they do
// nothing to it), and the backup service, where cars are private to each browser as before.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { angleDiff } from '../core/util';
import { KINDS, type VehicleKind } from '../ent/vehicleSpecs';
import { DAMAGE_WRECK, HELD_CAR_BYTES, HELD_HEADER_BYTES, HELD_MAX, SEND_HZ, blankHeldCar, damageNibble, decodeHeld, encodeHeld, type HeldCar } from './protocol';
import type { Connection } from './conn';
import { INTERP_MS, showDamage, type Remote } from './remote';
import type { SharedTraffic } from './shared';
import type { TownCars } from './cars';

const SEND_MS = 1000 / SEND_HZ;
/** A shown car further than this from where its owner says it is now is put there at once; nearer, it is slid. Meters. */
const SNAP = 8;
/** How fast a shown car closes on where it should be, per second (it is told ten times a second while it moves). */
const EASE = 10;

/** One of another player's held cars, as drawn here. */
interface Shown { v: Vehicle; kind: VehicleKind; want: HeldCar; placed: boolean; still: boolean; door: boolean }

export class TownHeld {
  /** Lists sent and bytes of them; lists heard; cars let go of by a script and left to the town. */
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0, released: 0 };

  // This player's.
  private was = new Set<Vehicle>();
  private cur = new Set<Vehicle>();
  private readonly slots = new Map<Vehicle, number>();
  private readonly recs: HeldCar[] = [];
  private readonly last: HeldCar[] = [];
  private nLast = 0;
  private force = false;
  private sendAt = 0;
  // The others'.
  private readonly theirs = new Map<number, Map<number, Shown>>();
  private readonly queue: { at: number; id: number; cars: HeldCar[] }[] = [];
  private readonly shown: Vehicle[] = [];
  private readonly shownSet = new Set<Vehicle>();

  /**
   * Stage 4, step 3 (crew.ts): is this player on that player's mission? Their held cars are then drawn here as cars
   * WITH a door (one of the town's kind: in the list, placed from here, asked for at the door) instead of as a ghost.
   */
  crewOf: ((id: number) => boolean) | null = null;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly shared: SharedTraffic, private readonly cars: TownCars) {}

  /** Somebody has just arrived and knows nothing: the list goes once more (if there is anything in it). */
  refresh(): void { this.force = true; }

  /** Every held car of another player's that is drawn here. The list is reused; do not keep it. */
  list(): readonly Vehicle[] { return this.shown; }
  /** Is this one of them? */
  has(v: Vehicle): boolean { return this.shownSet.has(v); }

  /** Whose, and in which slot, a car shown here is. */
  shownSlot(v: Vehicle): { id: number; slot: number } | null {
    if (!this.shownSet.has(v)) return null;
    for (const [id, map] of this.theirs) for (const [slot, s] of map) if (s.v === v) return { id, slot };
    return null;
  }
  /** This player's held car in a slot of its lists. */
  mineAt(slot: number): Vehicle | null { for (const [v, s] of this.slots) if (s === slot) return v; return null; }

  /** A shown car with a door becomes this browser's own (a helper has been lent it): it is no longer shown from here. */
  adopt(v: Vehicle): boolean {
    for (const [id, map] of this.theirs) for (const [slot, s] of map) {
      if (s.v !== v || !s.door) continue;
      map.delete(slot);
      // (A list sent before the starter let go of it, still waiting to be shown, must not stand it here again.)
      for (const q of this.queue) if (q.id === id) q.cars = q.cars.filter((c) => c.slot !== slot);
      this.relist();
      return true;
    }
    return false;
  }

  /** Being on somebody's crew or not has changed: their cars are drawn again in the other way. */
  restyle(id: number): void {
    const map = this.theirs.get(id);
    if (!map) return;
    const door = !!this.crewOf?.(id);
    for (const s of map.values()) {
      if (s.door === door) continue;
      this.unshow(s);
      s.v = this.make(s.kind, s.want.color, door); s.door = door; s.placed = false; s.still = false;
    }
    this.relist();
  }

  private make(kind: VehicleKind, color: number, door: boolean): Vehicle {
    const vs = this.game.vehicles;
    if (!door) { const v = vs.ghost(kind, color); v.driver = null; return v; }
    const v = vs.spawn(kind, 0, -5000, 0, color);
    vs.setShared(v, true);
    v.driver = null;
    return v;
  }
  private unshow(s: Shown): void { if (s.door) this.game.vehicles.remove(s.v); else this.game.vehicles.unghost(s.v); }

  // ── The others' ─────────────────────────────────────────────────────────────

  /** An Event frame: the cars a script is holding for its sender. */
  event(buf: ArrayBuffer, now: number): void {
    const m = decodeHeld(buf);
    if (!m || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    // Their own car is shown INTERP_MS in the past (remote.ts). So is this, or a car they have just got out of would
    // stand in two places for a moment, and one they have just got into in none.
    this.queue.push({ at: now + INTERP_MS, id: m.id, cars: m.cars });
  }

  private apply(id: number, cars: HeldCar[]): void {
    if (!this.remotes.has(id)) return;
    const vs = this.game.vehicles;
    let map = this.theirs.get(id);
    if (!map) this.theirs.set(id, map = new Map());
    const door = !!this.crewOf?.(id);
    for (const [slot, s] of map) if (!cars.some((c) => c.slot === slot)) { this.unshow(s); map.delete(slot); }
    for (const c of cars) {
      const kind = KINDS[c.kind];
      let s = map.get(c.slot);
      // (Another kind in the slot, or a whole car where a burnt out one stood: another car.)
      if (s && (!kind || s.kind !== kind || s.door !== door || (s.v.wreck && c.damage < DAMAGE_WRECK))) { this.unshow(s); map.delete(c.slot); s = undefined; }
      if (!kind) continue;
      if (!s) {
        // Nobody is in it: no lamps, no daytime strip.
        const v = this.make(kind, c.color, door);
        map.set(c.slot, s = { v, kind, want: c, placed: false, still: false, door });
      }
      s.want = c; s.still = false;
    }
    if (map.size === 0) this.theirs.delete(id);
    this.relist();
  }

  private relist(): void {
    const l = this.shown, set = this.shownSet;
    l.length = 0; set.clear();
    for (const map of this.theirs.values()) for (const s of map.values()) { l.push(s.v); set.add(s.v); }
  }

  /** Somebody has left town (index.ts): their cars go with them. */
  dropped(id: number): void {
    const map = this.theirs.get(id);
    for (let k = this.queue.length - 1; k >= 0; k--) if (this.queue[k].id === id) this.queue.splice(k, 1);
    if (!map) return;
    for (const s of map.values()) this.unshow(s);
    this.theirs.delete(id);
    this.relist();
  }

  /** Out of town altogether. */
  clear(): void {
    for (const map of this.theirs.values()) for (const s of map.values()) this.unshow(s);
    this.theirs.clear();
    this.queue.length = 0;
    this.relist();
    // (Whoever is met next knows nothing of this player's cars either.)
    this.nLast = 0;
  }

  private draw(dt: number): void {
    const vs = this.game.vehicles;
    for (const map of this.theirs.values()) for (const s of map.values()) {
      const v = s.v, w = s.want;
      // As bent as its owner's browser says: that is what makes it steam, burn and stand as a wreck here.
      showDamage(v, w.damage);
      if (!v.wreck) v.color = w.color;
      if (s.still) continue;
      let x = w.x, y = w.y, z = w.z, h = w.yaw, pitch = w.pitch, roll = w.roll;
      const d = Math.hypot(w.x - v.x, w.y - v.y, w.z - v.z), turn = angleDiff(v.h, w.yaw);
      if (s.placed && d < SNAP && (d > 0.02 || Math.abs(turn) > 0.004)) {
        const k = Math.min(1, dt * EASE);
        x = v.x + (w.x - v.x) * k; y = v.y + (w.y - v.y) * k; z = v.z + (w.z - v.z) * k;
        h = v.h + turn * k; pitch = v.pitch + (w.pitch - v.pitch) * k; roll = v.roll + (w.roll - v.roll) * k;
      } else s.still = true;
      s.placed = true;
      vs.ghostPose(v, x, y, z, h, pitch, roll, 0, 0, false, false, dt);
      v.driver = null; v.lights = false;
    }
  }

  // ── This player's ───────────────────────────────────────────────────────────

  /** What the scripts hold now; anything they have let go of since the last look is left to the town. */
  private look(): void {
    const g = this.game, cur = this.was, was = this.cur;
    // (The two sets swap each frame: no garbage.)
    cur.clear();
    // (A mission car a helper has borrowed from another player is that player's to list: crew.ts.)
    for (const v of g.vehicles.list) if (v.held && !v.removed && !v.lent) cur.add(v);
    for (const v of was) {
      if (cur.has(v)) continue;
      this.slots.delete(v);
      // Let go of with nobody in it, and still on the street: from here it is a car its player has just got out of.
      if (!v.held && !v.removed && !v.sunk && !v.lent && v.driver === null && this.shared.town) { this.cars.release(v); this.stats.released++; }
    }
    this.was = was; this.cur = cur;
  }

  private send(now: number): void {
    const c = this.conn, cur = this.cur, slots = this.slots, recs = this.recs;
    if (c.status !== 'online' || !this.shared.town || this.remotes.size === 0) {
      // Nobody to tell. Whoever is met later is told from nothing.
      this.nLast = 0;
      return;
    }
    if (now - this.sendAt < SEND_MS - 4) return;
    let n = 0, used = 0;
    for (const s of slots.values()) used |= 1 << s;
    for (const v of cur) {
      // The one being driven is in the State frames; one in the Sound is gone.
      if (v.driver === 'player' || v.sunk) { slots.delete(v); continue; }
      let slot = slots.get(v);
      if (slot === undefined) {
        slot = 0;
        while (slot < HELD_MAX && (used & (1 << slot))) slot++;
        // (More cars than the frame holds: the rest are not shown. No mission has more than three.)
        if (slot >= HELD_MAX) continue;
        slots.set(v, slot); used |= 1 << slot;
      }
      const r = recs[n] ?? (recs[n] = blankHeldCar());
      n++;
      r.slot = slot; r.damage = damageNibble(v.health, !!v.wreck);
      r.kind = KINDS.indexOf(v.spec.kind); r.color = v.color;
      r.x = v.x; r.y = v.y; r.z = v.z; r.yaw = v.h; r.pitch = v.pitch; r.roll = v.roll;
    }
    // (A slot whose car is no longer in the list is free again.)
    for (const [v] of slots) if (!cur.has(v)) slots.delete(v);
    const last = this.last;
    let changed = n !== this.nLast;
    for (let i = 0; i < n && !changed; i++) {
      const a = recs[i], b = last[i];
      // (Small enough not to be tripped by a car settling on its springs, as for the State frames.)
      changed = a.slot !== b.slot || a.kind !== b.kind || a.damage !== b.damage || (a.color !== b.color && a.damage < DAMAGE_WRECK)
        || Math.abs(a.x - b.x) > 0.04 || Math.abs(a.z - b.z) > 0.04 || Math.abs(a.y - b.y) > 0.04
        || Math.abs(angleDiff(a.yaw, b.yaw)) > 0.008 || Math.abs(a.pitch - b.pitch) > 0.012 || Math.abs(a.roll - b.roll) > 0.012;
    }
    if (!changed && !(this.force && n > 0)) { this.force = false; return; }
    if (!c.send(encodeHeld(recs, n))) return;
    for (let i = 0; i < n; i++) Object.assign(last[i] ?? (last[i] = blankHeldCar()), recs[i]);
    this.nLast = n;
    this.force = false;
    this.sendAt = now;
    this.stats.sent++; this.stats.bytesSent += HELD_HEADER_BYTES + n * HELD_CAR_BYTES;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number, dt: number): void {
    this.look();
    this.send(now);
    const q = this.queue;
    while (q.length && q[0].at <= now) { const m = q.shift() as { at: number; id: number; cars: HeldCar[] }; this.apply(m.id, m.cars); }
    if (this.shown.length) this.draw(dt);
  }

  /** For the tests (window.__game.net().held). */
  info(): Record<string, unknown> {
    const r1 = (v: number): number => +v.toFixed(1);
    const mine: Record<string, unknown>[] = [], theirs: Record<string, unknown>[] = [];
    for (const v of this.cur) mine.push({ slot: this.slots.get(v) ?? -1, kind: v.spec.kind, x: r1(v.x), z: r1(v.z), driver: v.driver });
    for (const [id, map] of this.theirs) for (const [slot, s] of map) theirs.push({ id, slot, door: s.door, kind: s.kind, color: s.v.color, x: r1(s.v.x), z: r1(s.v.z), h: +s.v.h.toFixed(2), wreck: !!s.v.wreck });
    return { ...this.stats, mine, theirs };
  }
}
