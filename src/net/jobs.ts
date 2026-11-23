// Multiplayer, stage 4, step 5: the others are shown a player's job (taxi, courier, tow) where its runner has it.
//
// Jobs stay personal: the runner's browser runs the job alone, exactly as in single player, and is paid alone. Only on
// the MAIN service, with somebody else in town; on the backup and alone nothing here runs and nothing is sent.
//
// What the others see, from ONE small Event frame (protocol.ts, Job, 14 bytes) sent only when it changes:
//  - taxi: the fare waiting at the kerb, standing where the runner's browser stood them, in the same look (the look
//    is made from a seed in the frame: activities.ts riderLook); once aboard they sit in the back of the cab, on the
//    runner's screen and on everybody else's (Nov 23, with riding together: seat()), and the runner's name tag says
//    "fare aboard".
//  - courier: the parcels still in the van, on the runner's name tag ("2 of 4 parcels").
//  - tow: the car to be towed is one of the runner's held cars (held.ts) and is shown where it stands. Once it is on the
//    hook the frame says so (and which held car it is), the runner stops sending its moves, and every other screen
//    puts it behind the truck the runner is shown driving, as the runner's own browser does (a rigid bar). Before this
//    step the towed car's moves went in the Held list, 4 + 15 bytes a car up to SEND_HZ times a second while the
//    truck moved (see info().towBytes and tools/net/story.mjs for what it costs now).
//
// Sent: nothing while the job stands still; a frame when it starts, when a fare is picked up or dropped, a parcel is
// signed for, the car is hooked, the job ends (job 0, once), and once more to somebody who arrives.

import type { Game } from '../core/game';
import type { Person } from '../core/api';
import { riderLook, type Activities } from '../game/activities';
import { JOB_BYTES, JobKind, JobRider, SEND_HZ, blankJob, decodeJob, encodeJob, type JobRec } from './protocol';
import type { Vehicle } from '../core/api';
import { PASSENGER_SEATS } from '../ent/vehicleSpecs';
import { seatSpot } from './ride';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { TownHeld } from './held';

const SEND_MS = 1000 / SEND_HZ;
/** A waiting fare further than this from where the others were told is told again, meters. */
const MOVED = 0.5;

/** A fare sat in a cab: the person drawn, and the look they were made with. */
interface Fare { p: Person | null; look: number }
interface Theirs { rec: JobRec; rider: Person | null; look: number; fare: Fare }

export class TownJobs {
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0, riders: 0, reparked: 0 };
  private spotAt = 0;

  private readonly rec = blankJob();
  private last: JobRec | null = null;
  private force = false;
  private sentAt = 0;
  private readonly theirs = new Map<number, Theirs>();
  /** This player's own fare, sat in the back of the cab. */
  private readonly ownFare: Fare = { p: null, look: -1 };
  private readonly at = { x: 0, y: 0, z: 0 };
  /** False only to measure the old way (the towed car's moves in the Held list): tools/net/story.mjs. */
  cheapTow = true;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly held: TownHeld) {
    this.jobsHere.shared = () => this.inTown;
  }

  private get jobsHere(): Activities { return this.game.todo.jobs; }
  private get inTown(): boolean { return this.conn.status === 'online' && this.conn.home === 'main'; }

  /** Somebody has just arrived and knows nothing: the job goes once more (if there is one). */
  refresh(): void { this.force = true; }

  // ── This player's ──────────────────────────────────────────────────────────

  private gather(): JobRec {
    const w = this.jobsHere.view(), r = this.rec;
    r.job = w.job === 'taxi' ? JobKind.Taxi : w.job === 'courier' ? JobKind.Courier : w.job === 'tow' ? JobKind.Tow : JobKind.None;
    r.state = 0; r.x = 0; r.z = 0; r.yaw = 0; r.look = 0; r.slot = 255; r.total = 0;
    if (r.job === JobKind.Taxi) {
      r.state = w.rider ? JobRider.Waiting : w.aboard ? JobRider.Aboard : JobRider.None;
      r.look = w.riderSeed;
      if (w.rider) { r.x = w.rider.x; r.z = w.rider.z; r.yaw = w.rider.h; }
    } else if (r.job === JobKind.Courier) { r.state = w.parcels; r.total = w.total; }
    else if (r.job === JobKind.Tow) {
      r.state = w.hooked ? 1 : 0;
      r.slot = w.towed ? this.held.slotOf(w.towed) : 255;
    }
    // (The car on the hook moves with the truck: held.ts stops sending its moves.)
    this.held.towing = this.cheapTow && w.hooked && w.towed ? w.towed : null;
    return r;
  }

  private send(now: number): void {
    const r = this.gather(), l = this.last;
    if (this.remotes.size === 0) { this.last = null; return; }
    // Nothing running and nothing told: nothing to say.
    if (r.job === JobKind.None && (!l || l.job === JobKind.None)) { this.force = false; return; }
    const changed = !l || this.force || l.job !== r.job || l.state !== r.state || l.look !== r.look || l.slot !== r.slot || l.total !== r.total
      || Math.hypot(l.x - r.x, l.z - r.z) > MOVED;
    if (!changed || now - this.sentAt < SEND_MS - 4) return;
    if (!this.conn.send(encodeJob(r))) return;
    this.stats.sent++; this.stats.bytesSent += JOB_BYTES;
    this.last = { ...r };
    this.sentAt = now;
    this.force = false;
  }

  // ── The others' ────────────────────────────────────────────────────────────

  /** An Event frame with the Job code (index.ts). */
  event(buf: ArrayBuffer): void {
    const m = decodeJob(buf);
    if (!m || !this.inTown || !this.remotes.has(m.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    let t = this.theirs.get(m.id);
    if (!t) this.theirs.set(m.id, t = { rec: blankJob(), rider: null, look: -1, fare: { p: null, look: -1 } });
    Object.assign(t.rec, m);
    this.apply(m.id, t);
  }

  private apply(id: number, t: Theirs): void {
    const g = this.game, r = t.rec, rem = this.remotes.get(id);
    // The fare at the kerb: the same person, standing where the runner has them.
    const waiting = r.job === JobKind.Taxi && r.state === JobRider.Waiting;
    if (t.rider && (!waiting || t.look !== r.look)) { g.people.remove(t.rider); t.rider = null; }
    if (waiting) {
      if (!t.rider) {
        t.rider = g.people.spawn(r.x, r.z, r.yaw, riderLook(g, r.look));
        t.rider.pose = 'stand';
        t.look = r.look;
        this.stats.riders++;
      } else { t.rider.x = r.x; t.rider.z = r.z; t.rider.h = r.yaw; }
    }
    // The tow hook.
    if (r.job === JobKind.Tow && r.state === 1 && r.slot !== 255) this.held.hooks.set(id, r.slot); else this.held.hooks.delete(id);
    // The runner's tag.
    rem?.setJob(r.job === JobKind.Taxi && r.state === JobRider.Aboard ? 'fare aboard'
      : r.job === JobKind.Courier ? `${r.state} of ${r.total} parcel${r.total === 1 ? '' : 's'}`
        : r.job === JobKind.Tow && r.state === 1 ? 'towing' : '');
    if (r.job === JobKind.None) { this.sit(t.fare, null, 0); this.theirs.delete(id); }
  }

  /** Somebody has left town (index.ts). */
  dropped(id: number): void {
    const t = this.theirs.get(id);
    if (t?.rider) this.game.people.remove(t.rider);
    if (t) this.sit(t.fare, null, 0);
    this.theirs.delete(id);
    this.held.hooks.delete(id);
  }

  /** Out of town altogether. */
  clear(): void {
    for (const id of [...this.theirs.keys()]) this.dropped(id);
    this.held.hooks.clear();
    this.held.towing = null;
    this.last = null;
    this.sit(this.ownFare, null, 0);
  }

  /**
   * Index.ts, once the cars are placed this step: a fare aboard sits in the back of the cab (the rear seat on the kerb
   * side), on the runner's screen and on everybody else's, in the look the runner's browser gave them.
   */
  seat(): void {
    if (!this.inTown) { this.sit(this.ownFare, null, 0); return; }
    const g = this.game, w = this.jobsHere.view();
    this.sit(this.ownFare, w.job === 'taxi' && w.aboard ? g.player.vehicle : null, w.riderSeed);
    for (const [id, t] of this.theirs) {
      const r = t.rec, aboard = r.job === JobKind.Taxi && r.state === JobRider.Aboard;
      this.sit(t.fare, aboard ? this.remotes.get(id)?.vehicle ?? null : null, r.look);
    }
  }

  private sit(f: Fare, car: Vehicle | null, look: number): void {
    const g = this.game;
    if (f.p && (!car || f.look !== look)) { g.people.remove(f.p); f.p = null; }
    if (!car) return;
    const n = PASSENGER_SEATS[car.spec.kind].length;
    if (!n || !seatSpot(car, Math.min(2, n - 1), this.at)) return;
    if (!f.p) { f.p = g.people.spawn(this.at.x, this.at.z, car.h, riderLook(g, look)); f.look = look; }
    const p = f.p;
    p.x = this.at.x; p.y = this.at.y; p.z = this.at.z; p.h = car.h;
    p.pose = 'sit'; p.bench = true; p.speed = 0; p.visible = true;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number): void {
    if (!this.inTown) { if (this.theirs.size || this.last || this.held.towing) this.clear(); return; }
    this.oneSpot(now);
    this.send(now);
  }

  /**
   * Two players who start a tow in the same moment can be given the same kerb place (neither browser had been shown
   * the other's car to tow yet): one car on top of another on every screen. The one not yet hooked whose runner has
   * the higher id moves its car elsewhere (Activities.reparkTowed); the lower id keeps the place. Checked twice a
   * second, nothing sent for it (the held list says where the car went).
   */
  private oneSpot(now: number): void {
    if (now - this.spotAt < 500) return;
    this.spotAt = now;
    const w = this.jobsHere.view(), c = w.job === 'tow' && !w.hooked ? w.towed : null;
    if (!c) return;
    for (const o of this.held.list()) {
      if (Math.hypot(o.x - c.x, o.z - c.z) > 2.5) continue;
      const who = this.held.shownSlot(o);
      if (who && who.id < this.conn.id) { if (this.jobsHere.reparkTowed()) this.stats.reparked++; return; }
    }
  }

  /** For the tests (window.__game.net().jobs). */
  info(): Record<string, unknown> {
    const r2 = (v: number): number => +v.toFixed(2);
    return {
      ...this.stats,
      mine: this.last ? { ...this.last, x: r2(this.last.x), z: r2(this.last.z) } : null,
      ownFare: this.ownFare.p ? { x: r2(this.ownFare.p.x), z: r2(this.ownFare.p.z) } : null,
      theirs: [...this.theirs.entries()].map(([id, t]) => ({ id, fare: t.fare.p ? { x: r2(t.fare.p.x), z: r2(t.fare.p.z) } : null, job: t.rec.job, state: t.rec.state, total: t.rec.total, slot: t.rec.slot, rider: t.rider ? { x: r2(t.rider.x), z: r2(t.rider.z), top: t.rider.look.top, skin: t.rider.look.skin, hair: t.rider.look.hair } : null })),
      hookedShown: this.held.hookedShown,
    };
  }
}
