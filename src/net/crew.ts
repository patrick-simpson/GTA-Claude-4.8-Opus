// Multiplayer, stage 4, step 3: missions done together (the owner, Nov 22: "Missions are done together").
//
// Only in a town on the MAIN service. On the backup, and alone, nothing here runs and nothing is sent: missions there
// stay each player's own, as before (a start with no crew sends nothing at all).
//
// WHO IS IN IT. When a mission begins in this browser (the starter's), everybody it shows within CREW_RANGE meters of
// its player, who is not already known to be on somebody else's mission, is its crew, with no prompt (Team). A retry
// from the checkpoint is a beginning too: whoever is near then is drafted again. A drafted browser that is busy with
// a mission or a job of its own says no (Reply) and is dropped; otherwise it is on the crew until the mission is
// over, its player leaves town, or the starter does. While on a crew a player cannot start a mission or a job of
// their own (ThingsToDo.busy is held), and a player who is on one is never drafted into another.
//
// ONE AUTHORITY. The starter's browser runs the script, alone, exactly as in single player. The crew are SHOWN it:
// "you are on <name>'s job: <title>", the objective (sent as the mission's number and the step's: every browser reads
// the words from its own copy of the story, so no text travels), the timer (counted down here between frames), and the
// markers and radar blips where the starter has them (Show, sent only when one of them changes, at most SEND_HZ
// times a second). What a helper does counts toward the objectives only through the mission's car (below).
//
// THE OUTCOME (End). Passed: every helper is paid the mission's full reward in their own browser, the mission is
// filed in their own saved story whether or not they had reached it, and its points go to their own bridge progress
// (not to the town's a second time: the starter's browser counted it for the town once). Failed or set aside: the
// helpers see the same notice and are let go. Money and story marks are trusted from the starter's browser: nothing
// here checks them (clients are trusted, multiplayer.md). A helper who dies respawns and is still on the crew.
//
// THE CAR. held.ts made a mission's car untakeable by anybody but its runner; the crew are the exception. On a
// helper's screen the starter's held cars are drawn as cars with a door (held.ts crewOf). At the door the helper asks
// (Ask); the starter's browser lends it (Lend) if it is a car of the script's, nobody is in it, and it is not lent
// already, and takes it off its own streets. From then the car is SIMULATED IN THE HELPER'S BROWSER, as any car a
// player drives, and seen by everybody (the starter included) through the helper's State frames. The starter's script
// keeps its own record of the car and follows the helper's car with it every frame (where, how fast, how bent, burnt
// out), so the mission's rules (the van at Gus's and stopped; the van written off) are judged on the starter's
// screen exactly as if the starter were driving. When the helper gets out the car goes back (Back: where, which way,
// how fast, how bent): the starter stands it again as the script's car, held as before. When the script takes it
// away (a despawn, a retry, the mission set aside) the helper's copy goes (Reclaim); when the mission is passed with
// the helper at the wheel it is the helper's from then on, an ordinary car, as the starter's own would be.
//
// SECOND PIECE (stage 4, step 3, continued):
//  - A helper's own actions count. The starter's browser judges them from where it already shows each helper (their
//    State frames): no frame is sent for it. A goto (no particular car), a collect item, a race checkpoint, a getVehicle
//    of a kind (or of anything) and a survive ring are met by ANY crew member as the step asks (on foot, in a car, in
//    a kind). Not covered: loseHeat (heat is each player's own).
//
// THIRD PIECE (stage 4, step 5):
//  - A helper's rounds, fists and rams count against the starter's held cars (a destroy objective's targets), as a
//    CLAIM, like weapons between players (fight.ts): the helper's browser says "my rounds took this much off your car
//    in slot N" (Hit, 9 bytes, gathered for a tenth of a second, sent only while hitting); the starter's browser, which
//    owns the car, applies it if the helper is a crew member, shown within that weapon's reach of the car (a ram: within
//    a car's length or two), and no faster than a helper could do it (HIT_RATE health a second, HIT_CAP at once). A
//    helper's rocket is a Blast for everybody already: the starter's browser lets a crew member's blast hurt its held
//    cars (Weapons.explode asks hurtsHeld). Nobody else's rounds or blasts touch a held car: still the runner's own.
//    A car hurt that way burns and goes up by the single player rules on the starter's screen, named as the helper's.
//  - A tail is judged on the nearest crew member, not the starter alone (script.ts): any of them too close is seen,
//    and the car is lost only when all of them are too far.
//  - The countdown follows the starter's mission clock: each Show carries the rate that clock runs at against the wall
//    clock (measured here from game time), 0 while the starter is paused (told the moment they pause).
//  - A failure hands a lent car back (the helper is put out of it and it stands as the starter's script's car); a
//    checkpoint passed while a helper drives the script's car is that car, where it is (script.ts snap).
//  - The mission's people (spawnActor) are shown to the crew (Things: the step that made each, where, which way), in
//    the same look; targets are the starter's held cars (held.ts) with their markers and blips from Show.
//  - A helper who leaves town at the wheel of a lent car leaves it to its starter, never to the town (borrowing()).
// Not here yet: taxi riders, job things, pause in town for those not on the crew.

import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import { money } from '../core/util';
import { KINDS, SPECS } from '../ent/vehicleSpecs';
import { charCar } from '../ent/weapons';
import { progress } from '../world/progress';
import { FAILS, actorLook, type CrewLink, type CrewMember, type Guest, type Mission, type Runner, type ViewMark } from '../game/script';
import { save } from '../game/save';
import {
  CREW_HIT_BYTES, CrewHitHow, decodeCrewHit, encodeCrewHit,
  CREW_BACK_BYTES, CREW_MARK_BYTES, CREW_MARKS_MAX, CREW_SHOW_BYTES, CREW_THING_BYTES, CREW_THINGS_MAX, CrewEnd, CrewKind, CrewLabel, SEND_HZ,
  crewKindOf, decodeCrewBack, decodeCrewLend, decodeCrewShow, decodeCrewSmall, decodeCrewTeam, decodeCrewThings,
  encodeCrewBack, encodeCrewLend, encodeCrewShow, encodeCrewSmall, encodeCrewTeam, encodeCrewThings, type CrewShowRec, type CrewThingRec,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { TownHeld } from './held';
import type { TownCars } from './cars';

/** Within this many meters of the starter when the mission begins: on the crew (the lead's choice; the owner said "near"). */
export const CREW_RANGE = 30;
const SEND_MS = 1000 / SEND_HZ;
/** A helper at the door waits this long for the starter's answer, ms. */
const ASK_MS = 4000;
/** A car lent and never sat in goes back after this long, ms. */
const UNUSED_MS = 6000;
/** A countdown on a helper's screen further than this from the starter's is told again, tenths of a second. */
const DRIFT = 5;
/** A distance (the tail) is told at most this often, ms. */
const METERS_MS = 500;
/** A helper's claims on a target: no more health off it a second than a helper could take (a shotgun at full tilt), nor at once. */
const HIT_RATE = 75, HIT_CAP = 60;
/** A claim from a helper shown further from the car than this is refused, meters: rounds (a rifle's reach and slack), a ram. */
const HIT_REACH = 155, RAM_REACH = 16;
/** Health a bump takes, as Vehicles.collide works it out (HARD_HIT, DAMAGE in ent/vehicle.ts). */
const RAM_HARD = 3, RAM_DAMAGE = 1.5;

interface Lent { id: number; kind: string; color: number }
/** A mission person drawn on a helper's screen. */
interface Extra { p: Person; want: CrewThingRec }

/**
 * A helper's own words for each way a starter's mission fails (FAILS, by the same index): "<name>'s job failed: ...".
 * The starter's own lines say "you", which on a helper's screen is the wrong person.
 */
const CREW_FAILS: readonly ((who: string) => string)[] = [
  (w) => `${w} was booked by the Harbor Patrol.`,
  (w) => `${w} did not live to invoice for it.`,
  () => 'the clock ran out.',
  () => 'that vehicle was the whole job.',
  () => 'there is nothing left of them to follow.',
  () => 'they looked in the mirror and saw the whole crew.',
  () => 'they went one way and the crew went another.',
];
/** The words a helper is shown when the job they were on fails (for the tests too). */
export function crewFailLine(who: string, why: number): string {
  const f = CREW_FAILS[why];
  return `${who}'s job failed: ${f ? f(who) : 'it did not work out.'}`;
}
/** How quickly the measured rate of the starter's mission clock follows a change (per second). */
const RATE_EASE = 1.5;
/** A mission person further than this from where the starter's browser has them is told again, meters. */
const THING_MOVE = 0.3;
interface Borrowed { boss: number; sat: boolean; at: number }

export class TownCrew implements CrewLink {
  /** Frames sent and heard, by what they were, and bytes; drafts, pays, cars lent and handed back. */
  readonly stats = {
    sent: 0, bytesSent: 0, got: 0, bytesGot: 0, shows: 0, showBytes: 0, teams: 0, drafted: 0, declined: 0, paid: 0, lent: 0, back: 0, reclaimed: 0, things: 0, thingBytes: 0, handedBack: 0,
    /** Stage 4, step 5. A helper's claims on the starter's targets: sent (and the damage in them); heard, applied, refused (the last reason). */
    hitsSent: 0, hitBytes: 0, hitDamageSent: 0, ramsSent: 0, hitsGot: 0, hitsDone: 0, ramsDone: 0, hitsRefused: 0, hitDamageDone: 0, lastHitRefusal: '',
  };

  // ── As the starter ──
  private team: number[] = [];
  private mIdx = 0;
  private readonly lentOut = new Map<Vehicle, Lent>();
  private last: CrewShowRec | null = null;
  private lastAt = 0;
  private force = false;
  /** The rate the mission clock (game time) runs at against the wall clock, as measured here; paused: 0. */
  private rate = 1;
  private rateAt = 0;
  private rateGame = 0;
  private rateN = 0;
  private paused = false;
  private readonly crewOut: CrewMember[] = [];
  private readonly thingRecs: CrewThingRec[] = [];
  private lastThings: CrewThingRec[] = [];
  private thingsAt = 0;
  private thingsForce = false;

  // ── As a helper ──
  /** The starter whose crew this player is on (0: none). */
  boss = 0;
  private bossM: Mission | null = null;
  private readonly borrowed = new Map<Vehicle, Borrowed>();
  private asking: { v: Vehicle; at: number; refused: boolean } | null = null;
  /** The last outcome this player was told, and the words, for the tests. */
  lastEnd = '';
  lastLine = '';
  /** The mission's people as drawn here, by the step that made them. */
  private readonly extras = new Map<number, Extra>();

  /** A helper's rounds and rams on the starter's cars not told yet, by slot: [rounds, ram]. */
  private readonly hitOwed = new Map<number, [number, number]>();
  private hitAt = 0;
  /** The starter's: what each helper may still take off its cars now (HIT_RATE, HIT_CAP). */
  private readonly hitBudgets = new Map<number, { left: number; at: number }>();

  // ── Everybody ──
  /** Other starters and their crews: nobody in these is drafted. */
  private readonly others = new Map<number, number[]>();
  /**
   * Who is at the wheel of a starter's car lent to them (helper id to starter id), as heard by every browser from the
   * Lend frames. A helper who leaves town in one leaves it to its starter (who stands it again), never to the town as
   * a stray (index.ts asks borrowing()).
   */
  private readonly lentTo = new Map<number, number>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly held: TownHeld, private readonly cars: TownCars) {
    this.runner.crew = this;
    held.crewOf = (id) => id !== 0 && id === this.boss;
    const prev = game.takeShared;
    game.takeShared = (v) => this.ask(v) ?? (prev ? prev(v) : 'no');
    // The starter pauses: the game (and this system) stops at once, so the helpers are told now that the clock is
    // standing; the next frame after the pause says it runs again.
    // A helper's car striking one of the starter's: what the knock would have taken off it, as alone, is claimed.
    game.on('impact', (e) => {
      const p = this.game.player, o = e.other;
      if (!o || e.vehicle !== p.vehicle || e.vehicle.driver !== 'player' || !(e.speed > RAM_HARD)) return;
      const share = e.vehicle.spec.mass / (e.vehicle.spec.mass + o.spec.mass);
      this.owe(o, (e.speed - RAM_HARD) * RAM_DAMAGE * share, 1);
    });
    game.on('pause', ({ on }) => {
      this.paused = on;
      this.rateAt = 0;
      if (on && this.team.length && this.inTown) { this.force = true; this.sendShow(performance.now(), true); }
    });
  }

  private get runner(): Runner { return this.game.todo.missions; }
  private get inTown(): boolean { return this.conn.status === 'online' && this.conn.home === 'main'; }

  private send(buf: ArrayBuffer): boolean {
    if (!this.conn.send(buf)) return false;
    this.stats.sent++; this.stats.bytesSent += buf.byteLength;
    return true;
  }

  // ── The runner's line (CrewLink) ─────────────────────────────────────────────

  began(m: Mission): void {
    if (this.team.length) this.sendTeam(0, []);
    this.team = []; this.mIdx = 0; this.last = null; this.lastThings = [];
    this.rateN = 0; this.rateAt = 0;
    if (!this.inTown || this.boss) return;
    const p = this.game.player;
    for (const r of this.remotes.values()) {
      if (!r.seen || Math.hypot(r.x - p.x, r.z - p.z) > CREW_RANGE || this.elsewhere(r.id)) continue;
      this.team.push(r.id);
    }
    if (!this.team.length) return;
    this.mIdx = this.runner.missions.indexOf(m) + 1;
    this.stats.drafted += this.team.length;
    this.sendTeam(this.mIdx, this.team);
  }

  ended(_m: Mission, how: 'pass' | 'fail' | 'aside', why: number): void {
    if (this.team.length && this.inTown) {
      const code = how === 'pass' ? CrewEnd.Passed : how === 'fail' ? CrewEnd.Failed : CrewEnd.Aside;
      this.send(encodeCrewSmall(CrewKind.End, this.mIdx, code, why + 1));
    }
    this.team = []; this.mIdx = 0; this.last = null;
  }

  lent(v: Vehicle): boolean { return this.lentOut.has(v); }

  shared(): boolean { return this.inTown; }

  members(): readonly CrewMember[] {
    const out = this.crewOut;
    out.length = 0;
    if (!this.inTown) return out;
    for (const id of this.team) {
      const r = this.remotes.get(id);
      if (!r || !r.seen || r.dead) continue;
      out.push({ x: r.x, z: r.z, kind: r.kind, speed: r.speed });
    }
    return out;
  }

  drop(v: Vehicle, keep: boolean): void {
    const l = this.lentOut.get(v);
    if (!l) return;
    this.lentOut.delete(v);
    this.lentTo.delete(l.id);
    if (this.inTown && this.send(encodeCrewSmall(CrewKind.Reclaim, l.id, keep ? 1 : 0))) this.stats.reclaimed++;
  }

  // ── A helper's hits on the starter's cars (stage 4, step 5) ─────────────────

  /** Is this player on this browser's crew (the starter's)? Their blasts may hurt its held cars (fight.ts). */
  onTeam(id: number): boolean { return this.inTown && this.team.includes(id); }

  /**
   * fight.ts: a round of this player's struck a car. One of the starter's (this player is on their crew): owed to them
   * as a claim, and true. Anything else: false.
   */
  hitHeld(v: Vehicle, dmg: number): boolean { return this.owe(v, dmg, 0); }

  private owe(v: Vehicle, dmg: number, k: 0 | 1): boolean {
    if (!this.boss || !this.inTown || !(dmg > 0)) return false;
    const at = this.held.shownSlot(v);
    if (!at || at.id !== this.boss || v.wreck) return false;
    let o = this.hitOwed.get(at.slot);
    if (!o) this.hitOwed.set(at.slot, o = [0, 0]);
    o[k] += dmg;
    return true;
  }

  /** What has been owed this tenth of a second goes, one frame a car and a kind of blow. */
  private sendHits(now: number): void {
    if (!this.hitOwed.size || now - this.hitAt < SEND_MS - 4) return;
    for (const [slot, o] of this.hitOwed) {
      for (let k = 0; k < 2; k++) {
        const dmg = o[k];
        if (!(dmg > 0.01)) continue;
        if (this.boss && this.send(encodeCrewHit(this.boss, slot, k ? CrewHitHow.Ram : CrewHitHow.Rounds, dmg))) {
          this.stats.hitsSent++; this.stats.hitBytes += CREW_HIT_BYTES; this.stats.hitDamageSent += dmg; if (k) this.stats.ramsSent++;
        }
      }
    }
    // (Sent or not: a blow nobody could be told of is not worth telling late.)
    this.hitOwed.clear();
    this.hitAt = now;
  }

  private refuseHit(why: string): void { this.stats.hitsRefused++; this.stats.lastHitRefusal = why; }

  /** The starter: a helper says their rounds or their car took this much off one of this browser's held cars. */
  private hitBy(id: number, slot: number, how: number, damage: number, now: number): void {
    this.stats.hitsGot++;
    if (!this.team.includes(id)) return this.refuseHit('not on the crew');
    const v = this.held.mineAt(slot), r = this.remotes.get(id);
    if (!v || this.lentOut.has(v) || v.removed || v.sunk) return this.refuseHit(`no car of the script's in slot ${slot}`);
    if (v.wreck) return this.refuseHit('already a wreck');
    if (!r || !r.seen) return this.refuseHit('the helper is not shown here');
    const d = Math.hypot(r.x - v.x, r.z - v.z), reach = how === CrewHitHow.Ram ? RAM_REACH : HIT_REACH;
    if (d > reach) return this.refuseHit(`out of reach: ${d.toFixed(0)} m for ${how === CrewHitHow.Ram ? 'a ram' : 'rounds'}`);
    let b = this.hitBudgets.get(id);
    if (!b) this.hitBudgets.set(id, b = { left: HIT_CAP, at: now });
    b.left = Math.min(HIT_CAP, b.left + HIT_RATE * Math.max(0, now - b.at) / 1000);
    b.at = now;
    const dmg = Math.min(damage, b.left);
    if (!(dmg > 0.01)) return this.refuseHit('faster than a helper could do it');
    b.left -= dmg;
    v.health = Math.max(0, v.health - dmg);
    this.game.vehicles.wake(v);
    // (If it burns for this, the blast is the helper's, as alone it would have been this player's.)
    this.game.player.weapons.blameCar(v, id);
    this.stats.hitsDone++; this.stats.hitDamageDone += dmg; if (how === CrewHitHow.Ram) this.stats.ramsDone++;
  }

  private sendTeam(mIdx: number, ids: number[]): void {
    if (!this.inTown) return;
    if (this.send(encodeCrewTeam(mIdx, ids))) { this.stats.teams++; this.force = true; this.thingsForce = true; }
  }

  /** On somebody else's mission (as its starter or on its crew), as far as this browser has been told. */
  private elsewhere(id: number): boolean {
    for (const ids of this.others.values()) if (ids.includes(id)) return true;
    return false;
  }

  // ── Frames ──────────────────────────────────────────────────────────────────

  /** An Event frame with the Crew code (index.ts). */
  event(buf: ArrayBuffer): void {
    const k = crewKindOf(buf);
    if (!k || !this.remotes.has(k.id)) return;
    this.stats.got++; this.stats.bytesGot += buf.byteLength;
    const me = this.conn.id;
    switch (k.kind) {
      case CrewKind.Team: {
        const t = decodeCrewTeam(buf);
        if (!t) return;
        if (t.mission) this.others.set(t.id, [t.id, ...t.ids]); else this.others.delete(t.id);
        const named = t.mission > 0 && t.ids.includes(me);
        if (this.boss === t.id) { if (!named) this.release('', true); return; }
        if (named) this.drafted(t.id, t.mission);
        return;
      }
      case CrewKind.Show: {
        const s = decodeCrewShow(buf);
        if (s && s.id === this.boss) this.shown(s);
        return;
      }
      case CrewKind.Things: {
        const t = decodeCrewThings(buf);
        if (t && t.id === this.boss && this.bossM && this.runner.missions.indexOf(this.bossM) + 1 === t.mission) this.things(t.things);
        return;
      }
      case CrewKind.End: {
        const e = decodeCrewSmall(buf);
        this.others.delete(k.id);
        if (e && e.id === this.boss) this.outcome(e.b, e.c - 1);
        return;
      }
      case CrewKind.Reply: {
        const r = decodeCrewSmall(buf);
        if (!r || r.a !== me || r.b === 1) return;
        // Busy with something of their own: off the crew, and everybody is told who is on it now.
        const i = this.team.indexOf(k.id);
        if (i < 0) return;
        this.team.splice(i, 1);
        this.stats.declined++;
        this.sendTeam(this.team.length ? this.mIdx : 0, this.team);
        if (!this.team.length) this.mIdx = 0;
        return;
      }
      case CrewKind.Ask: {
        const a = decodeCrewSmall(buf);
        if (a && a.a === me) this.lend(k.id, a.b);
        return;
      }
      case CrewKind.Lend: {
        const l = decodeCrewLend(buf);
        if (l && l.yes) this.lentTo.set(l.to, k.id);
        if (l && l.to === me) this.answered(l.id, l.slot, l.yes, l.health);
        return;
      }
      case CrewKind.Back: {
        const b = decodeCrewBack(buf);
        if (b) this.lentTo.delete(k.id);
        if (b && b.starter === me) this.back(k.id, b);
        return;
      }
      case CrewKind.Hit: {
        const h = decodeCrewHit(buf);
        if (h && h.starter === me) this.hitBy(k.id, h.slot, h.how, h.damage, performance.now());
        return;
      }
      case CrewKind.Reclaim: {
        const r = decodeCrewSmall(buf);
        if (r && this.lentTo.get(r.a) === k.id) this.lentTo.delete(r.a);
        if (r && r.a === me) this.reclaimed(k.id, r.b === 1);
        return;
      }
      default: return;
    }
  }

  // ── As a helper ─────────────────────────────────────────────────────────────

  private drafted(by: number, mIdx: number): void {
    const td = this.game.todo, m = this.runner.missions[mIdx - 1];
    // Busy with a mission, a job or another crew of this player's own: not this one.
    if (!m || this.boss || td.busy !== null || this.runner.cur) { this.send(encodeCrewSmall(CrewKind.Reply, by, 0)); return; }
    const r = this.remotes.get(by), who = r ? r.text : 'Somebody';
    this.boss = by; this.bossM = m;
    td.setBusy(`crew:${m.id}`);
    const line = `You are on ${who}'s job: ${m.title}.`;
    const gu: Guest = { who, m, line, objective: null, timerLabel: null, timerMode: 0, timerValue: 0, timerUrgent: false, timerRate: 1, timerAt: 0, marks: [] };
    this.runner.guest = gu;
    this.game.hud.stamp(m.title, `On ${who}'s job. ${m.intro}`);
    this.held.restyle(by);
    this.send(encodeCrewSmall(CrewKind.Reply, by, 1));
  }

  private label(m: Mission, code: number): string {
    if (code < CrewLabel.Step) { const s = m.steps[code]; return s && s.t === 'timer' && s.label ? s.label : 'Past due in'; }
    return code === CrewLabel.Par ? 'Par' : code === CrewLabel.HoldOut ? 'Hold out' : code === CrewLabel.TooClose ? 'Too close'
      : code === CrewLabel.Losing ? 'Losing them' : code === CrewLabel.Following ? 'Following at' : 'Past due in';
  }

  private shown(s: CrewShowRec): void {
    const gu = this.runner.guest, m = this.bossM;
    if (!gu || !m || this.runner.missions.indexOf(m) + 1 !== s.mission) return;
    let text: string | null = null;
    if (s.what === 1) { const st = m.steps[s.arg]; text = st && 'text' in st && st.t !== 'say' ? st.text : null; }
    else if (s.what === 2) { const k = KINDS[s.arg]; text = `Get back in the ${k ? SPECS[k].name : 'car'}.`; }
    else if (s.what === 3) text = 'Get back inside the ring. The clock is not running out here.';
    gu.objective = text;
    gu.timerMode = s.mode;
    gu.timerLabel = s.mode ? this.label(m, s.label) : null;
    gu.timerValue = s.mode === 3 ? s.value : s.value / 10;
    gu.timerUrgent = s.urgent;
    gu.timerRate = s.rate;
    gu.timerAt = performance.now();
    gu.marks = s.marks as ViewMark[];
  }

  private outcome(how: number, why: number): void {
    const m = this.bossM, g = this.game, r = this.remotes.get(this.boss), who = r ? r.text : this.runner.guest?.who ?? 'Somebody';
    if (!m) { this.release('', true); return; }
    if (how === CrewEnd.Passed) {
      // The full pay, and the story mark, in this player's own browser (trusted from the starter's: see the header).
      g.player.money += m.reward;
      const d = save.data;
      if (!d.missions.includes(m.id)) d.missions.push(m.id);
      d.stats.passed++; d.stats.earned += m.reward;
      progress.addOwn(m.points);
      this.stats.paid++;
      this.lastEnd = 'passed';
      this.lastLine = `${m.title}: filed, on ${who}'s job.`;
      this.release('', true);
      g.hud.stamp('FILED', `${m.title} · ${money(m.reward)} · ${m.points} toward the bridge · on ${who}'s job`);
      if (m.unlocks) g.hud.toast(m.unlocks, 8);
      return;
    }
    const f = FAILS[why];
    this.lastEnd = how === CrewEnd.Failed ? `failed: ${f ? f[0] : '?'}` : 'set aside';
    // A car of the starter's this player has: handed back now, where it is (the starter's script still has it, for a
    // retry), so it never goes from under them later.
    if (how === CrewEnd.Failed) this.handBack(this.boss);
    this.release('', true);
    if (how === CrewEnd.Failed) { this.lastLine = crewFailLine(who, why); g.hud.stamp(f ? f[0] : 'CALLED OFF', this.lastLine); }
    else { this.lastLine = `${who} set the job aside. Your time is your own again.`; g.hud.toast(this.lastLine, 6); }
  }

  /** Off the crew. `why`: a toast, or nothing. */
  private release(why: string, quiet = false): void {
    const by = this.boss;
    if (!by) return;
    this.boss = 0; this.bossM = null;
    this.runner.unguest();
    this.things([]);
    if (this.game.todo.busy?.startsWith('crew:')) this.game.todo.setBusy(null);
    this.held.restyle(by);
    if (!quiet && why) { this.lastLine = why; this.game.hud.toast(why, 6); }
  }

  /** The job failed: every car of that starter's this player has goes back to them (out of it first). */
  private handBack(boss: number): void {
    const p = this.game.player;
    for (const [v, b] of this.borrowed) {
      if (b.boss !== boss) continue;
      if (p.vehicle === v) p.exit();
      if (p.vehicle === v) p.teleport(v.x + Math.cos(v.h) * 2.6, v.z - Math.sin(v.h) * 2.6, v.h);
      this.giveBack(v, b);
      this.stats.handedBack++;
    }
  }

  /** The mission's people as the starter's browser has them: drawn here, the same look from the same story. */
  private things(list: readonly CrewThingRec[]): void {
    const m = this.bossM, g = this.game;
    for (const [step, e] of this.extras) if (!m || !list.some((t) => t.step === step)) { g.people.remove(e.p); this.extras.delete(step); }
    if (!m) return;
    const mi = this.runner.missions.indexOf(m);
    for (const t of list) {
      const s = m.steps[t.step];
      if (!s || s.t !== 'spawnActor') continue;
      let e = this.extras.get(t.step);
      if (!e) {
        const p = g.people.spawn(t.x, t.z, t.yaw, actorLook(g, mi, t.step, s));
        p.pose = 'stand';
        this.extras.set(t.step, e = { p, want: t });
      }
      e.want = t;
      const p = e.p;
      p.x = t.x; p.z = t.z; p.h = t.yaw;
      p.pose = t.down ? 'down' : 'stand';
    }
  }

  /** The player is at the door of a car (Game.takeShared). Null: not one of the starter's cars; the town's own rules apply. */
  private ask(v: Vehicle): 'wait' | 'no' | null {
    const sl = this.held.shownSlot(v);
    if (!sl) return null;
    if (sl.id !== this.boss || !this.inTown) return 'no';
    const now = performance.now(), a = this.asking;
    if (a && a.v === v) {
      if (a.refused || now - a.at > ASK_MS) { this.asking = null; return 'no'; }
      return 'wait';
    }
    if (!this.send(encodeCrewSmall(CrewKind.Ask, this.boss, sl.slot))) return 'no';
    this.asking = { v, at: now, refused: false };
    return 'wait';
  }

  private answered(from: number, _slot: number, yes: boolean, health: number): void {
    const a = this.asking;
    if (!a || from !== this.boss) return;
    if (!yes) { a.refused = true; return; }
    this.asking = null;
    const v = a.v;
    if (v.removed || !this.held.adopt(v)) return;
    // This browser's own car from here on, from where it stands, as bent as the starter had it.
    this.game.vehicles.setShared(v, false);
    v.health = health;
    v.held = true; v.lent = true;
    v.ctl.accel = 0; v.ctl.steer = 0; v.ctl.horn = false; v.ctl.handbrake = true;
    this.borrowed.set(v, { boss: from, sat: false, at: performance.now() });
    this.stats.lent++;
  }

  private reclaimed(from: number, keep: boolean): void {
    for (const [v, b] of this.borrowed) {
      if (b.boss !== from) continue;
      this.borrowed.delete(v);
      v.lent = false; v.held = false;
      if (keep) {
        // The mission is over with this player at the wheel: theirs, an ordinary car. Out of it, it is the town's.
        if (this.game.player.vehicle !== v && !v.removed) this.cars.release(v);
        continue;
      }
      // The script has taken it away: so it goes here too.
      const p = this.game.player;
      if (p.vehicle === v) p.teleport(v.x + Math.cos(v.h) * 2.6, v.z - Math.sin(v.h) * 2.6, v.h);
      if (!v.removed) this.game.vehicles.remove(v);
    }
  }

  /** The player is out of a lent car (or it has sunk): it goes back to the starter. */
  private giveBack(v: Vehicle, b: Borrowed, gone = false): void {
    this.borrowed.delete(v);
    v.lent = false;
    if (gone || !this.remotes.has(b.boss) || !this.inTown) {
      // Nobody to give it to: an ordinary car of this player's.
      v.held = false;
      if (!v.removed && !v.sunk && this.game.player.vehicle !== v) this.cars.release(v);
      return;
    }
    const flags = (v.wreck ? 1 : 0) | (v.sunk || v.removed ? 2 : 0);
    if (this.send(encodeCrewBack(b.boss, { flags, health: v.health, kind: KINDS.indexOf(v.spec.kind), x: v.x, y: v.y, z: v.z, yaw: v.h, vx: v.vx, vz: v.vz }))) this.stats.back++;
    v.held = false;
    if (!v.removed) this.game.vehicles.remove(v);
  }

  // ── As the starter ──────────────────────────────────────────────────────────

  private lend(to: number, slot: number): void {
    const v = this.held.mineAt(slot), vs = this.game.vehicles;
    const ok = !!v && this.team.includes(to) && this.runner.drivable(v) && v.driver === null && !v.wreck && !v.sunk && !v.removed && vs.list.includes(v) && !this.lentOut.has(v);
    if (!ok || !v) { this.send(encodeCrewLend(to, slot, false, 0)); return; }
    if (!this.send(encodeCrewLend(to, slot, true, v.health))) return;
    // Off this browser's streets: the helper's browser simulates it now. The script keeps its record (`v`), which
    // follows the helper's car from here on (update()).
    this.lentOut.set(v, { id: to, kind: v.spec.kind, color: v.color });
    this.lentTo.set(to, this.conn.id);
    vs.remove(v);
    this.stats.lent++;
  }

  private back(from: number, b: { flags: number; health: number; kind: number; x: number; y: number; z: number; yaw: number; vx: number; vz: number }): void {
    for (const [v, l] of this.lentOut) {
      if (l.id !== from) continue;
      this.lentOut.delete(v);
      this.lentTo.delete(from);
      this.stats.back++;
      if (b.flags & 2) { v.sunk = true; return; }
      this.standAgain(v, b.x, b.z, b.yaw, b.vx, b.vz, b.health, !!(b.flags & 1));
      return;
    }
  }

  /** The script's car is this browser's again, where the helper left it. */
  private standAgain(old: Vehicle, x: number, z: number, h: number, vx: number, vz: number, health: number, wreck: boolean): void {
    const vs = this.game.vehicles, nv = vs.spawn(old.spec.kind, x, z, h, old.color);
    nv.vx = vx; nv.vz = vz;
    nv.health = health;
    nv.held = true;
    vs.wake(nv);
    if (wreck) charCar(nv);
    this.runner.swap(old, nv);
  }

  /** How fast the mission clock (game time) is running against the wall clock, eased; 0 while paused. */
  private measure(now: number): void {
    const t = this.game.time;
    // (Paused, this system does not run; a pause in the middle of a sample would spoil it, so the next one starts fresh.)
    if (this.paused) { this.rateAt = 0; return; }
    if (!this.rateAt) { this.rateAt = now; this.rateGame = t; return; }
    const dw = (now - this.rateAt) / 1000;
    if (dw < 0.2) return;
    const r = Math.max(0, Math.min(1, (t - this.rateGame) / dw));
    // (The first sample of a mission is taken as it is: a slow page would otherwise be told the wall clock for a while.)
    this.rate = this.rateN++ === 0 ? r : this.rate + (r - this.rate) * Math.min(1, dw * RATE_EASE);
    this.rateAt = now; this.rateGame = t;
  }

  private sendShow(now: number, pausing = false): void {
    const run = this.runner, m = run.cur;
    if (!m || !this.team.length || run.failed) return;
    const rate = pausing || this.paused ? 0 : this.rate;
    const v = run.view, rec: CrewShowRec = {
      mission: this.mIdx, step: Math.min(255, (run.want()?.i ?? 0)), what: v.what, arg: v.arg, label: v.label, mode: v.mode,
      urgent: v.urgent, value: v.value, marks: v.marks.slice(0, CREW_MARKS_MAX), rate,
    };
    const l = this.last;
    let changed = this.force || !l || l.mission !== rec.mission || l.step !== rec.step || l.what !== rec.what || l.arg !== rec.arg
      || l.mode !== rec.mode || l.urgent !== rec.urgent || (rec.mode && l.label !== rec.label) || l.marks.length !== rec.marks.length;
    if (!changed && l) {
      for (let i = 0; i < rec.marks.length && !changed; i++) {
        const a = rec.marks[i], b = l.marks[i];
        changed = a.kind !== b.kind || a.blip !== b.blip || a.target !== b.target || Math.abs(a.r - b.r) > 0.3 || Math.abs(a.x - b.x) > 0.5 || Math.abs(a.z - b.z) > 0.5;
      }
      if (!changed && rec.mode) {
        // (What the helper's screen shows now: the last value told, counted down at the rate told with it.)
        const gone = ((now - this.lastAt) / 100) * l.rate;
        const guess = l.mode === 1 ? l.value - gone : l.value;
        changed = rec.mode === 3 ? rec.value !== l.value && now - this.lastAt >= METERS_MS : Math.abs(guess - rec.value) > DRIFT;
      }
      // (Paused or running again: told at once.)
      if (!changed) changed = (rec.rate === 0) !== (l.rate === 0);
    }
    if (!changed || (!pausing && now - this.lastAt < SEND_MS - 4)) return;
    const buf = encodeCrewShow(rec);
    if (!this.send(buf)) return;
    this.stats.shows++; this.stats.showBytes += CREW_SHOW_BYTES + rec.marks.length * CREW_MARK_BYTES;
    // (A copy: the view's marks are reused next frame.)
    this.last = { ...rec, marks: rec.marks.map((k) => ({ ...k })) };
    this.lastAt = now;
    this.force = false;
  }

  /** The mission's people, to the crew: when one comes, goes or moves (at most SEND_HZ times a second). */
  private sendThings(now: number): void {
    const run = this.runner;
    if (!run.cur || !this.team.length || !this.mIdx) return;
    const recs = this.thingRecs;
    let n = 0;
    for (const a of run.actors()) {
      if (n >= CREW_THINGS_MAX) break;
      const r = recs[n] ?? (recs[n] = { step: 0, x: 0, z: 0, yaw: 0, down: false });
      n++;
      r.step = a.step; r.x = a.p.x; r.z = a.p.z; r.yaw = a.p.h; r.down = !(a.p.health > 0);
    }
    const l = this.lastThings;
    let changed = this.thingsForce || n !== l.length;
    for (let i = 0; i < n && !changed; i++) {
      const a = recs[i], b = l[i];
      changed = a.step !== b.step || a.down !== b.down || Math.hypot(a.x - b.x, a.z - b.z) > THING_MOVE || Math.abs(a.yaw - b.yaw) > 0.1;
    }
    // (Nobody now and nobody told: nothing to say.)
    if (!changed || (n === 0 && l.length === 0) || now - this.thingsAt < SEND_MS - 4) { if (n === 0 && l.length === 0) this.thingsForce = false; return; }
    if (!this.send(encodeCrewThings(this.mIdx, recs, n))) return;
    this.stats.things++; this.stats.thingBytes += 6 + n * CREW_THING_BYTES;
    this.lastThings = recs.slice(0, n).map((r) => ({ ...r }));
    this.thingsAt = now;
    this.thingsForce = false;
  }

  // ── Comings and goings ──────────────────────────────────────────────────────

  /** Was this player at the wheel of a car another player lent them (as far as this browser heard)? */
  borrowing(id: number): boolean { const s = this.lentTo.get(id); return s !== undefined && (s === this.conn.id || this.remotes.has(s)); }

  /** Somebody has left town (index.ts). */
  dropped(id: number): void {
    this.others.delete(id);
    this.lentTo.delete(id);
    for (const [h, s] of this.lentTo) if (s === id) this.lentTo.delete(h);
    for (const ids of this.others.values()) { const i = ids.indexOf(id); if (i > 0) ids.splice(i, 1); }
    if (this.boss === id) this.release(`${this.runner.guest?.who ?? 'The starter'} has left town. The job went with them.`);
    // (Their remote is still in the list while this runs: `gone` says there is nobody to give it back to.)
    for (const [v, b] of this.borrowed) if (b.boss === id) this.giveBack(v, b, true);
    const i = this.team.indexOf(id);
    if (i >= 0) { this.team.splice(i, 1); this.sendTeam(this.team.length ? this.mIdx : 0, this.team); if (!this.team.length) this.mIdx = 0; }
    // A car they had: it comes back where they were last seen with it.
    for (const [v, l] of this.lentOut) if (l.id === id) { this.lentOut.delete(v); this.standAgain(v, v.x, v.z, v.h, 0, 0, v.health, !!v.wreck); }
  }

  /** Out of town altogether. */
  clear(): void {
    this.others.clear();
    this.lentTo.clear();
    this.release('Out of town: the job you were helping with goes on without you.');
    for (const [v, b] of this.borrowed) this.giveBack(v, b);
    this.team = []; this.mIdx = 0; this.last = null;
    for (const v of [...this.lentOut.keys()]) { this.lentOut.delete(v); this.standAgain(v, v.x, v.z, v.h, 0, 0, v.health, !!v.wreck); }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number): void {
    if (!this.inTown) { if (this.boss || this.team.length || this.lentOut.size || this.borrowed.size) this.clear(); return; }
    // The starter: the script's record of a lent car follows the helper's car.
    for (const [v, l] of this.lentOut) {
      const r = this.remotes.get(l.id);
      if (!r || r.kind !== v.spec.kind) continue;
      v.x = r.x; v.y = r.y; v.z = r.z; v.h = r.h; v.vx = r.vx; v.vz = r.vz;
      const c = r.vehicle;
      if (c) { v.health = c.health; if (c.wreck) v.wreck = true; }
    }
    if (this.team.length) { this.measure(now); this.sendShow(now); this.sendThings(now); }
    if (this.boss) this.sendHits(now); else if (this.hitOwed.size) this.hitOwed.clear();
    // A helper: a lent car they are out of goes back.
    const p = this.game.player;
    for (const [v, b] of this.borrowed) {
      if (p.vehicle === v) { b.sat = true; continue; }
      if (b.sat || v.removed || v.sunk || now - b.at > UNUSED_MS) this.giveBack(v, b);
    }
    if (this.asking && now - this.asking.at > ASK_MS * 2) this.asking = null;
  }

  /** For the tests (window.__game.net().crew). */
  info(): Record<string, unknown> {
    const gu = this.runner.guest;
    return {
      ...this.stats, range: CREW_RANGE, team: this.team.slice(), mission: this.mIdx, boss: this.boss, lastEnd: this.lastEnd, lastLine: this.lastLine,
      rate: +this.rate.toFixed(3), extras: [...this.extras.entries()].map(([step, e]) => ({ step, x: +e.p.x.toFixed(1), z: +e.p.z.toFixed(1), top: e.p.look.top, hair: e.p.look.hair, skin: e.p.look.skin })),
      lentOut: [...this.lentOut.values()].map((l) => l.id), borrowed: this.borrowed.size,
      others: [...this.others.entries()].map(([k, v]) => [k, ...v.slice(1)]),
      guest: gu ? { who: gu.who, mission: gu.m.id, line: gu.line, objective: gu.objective, timer: gu.timerLabel, mode: gu.timerMode, value: gu.timerValue, rate: gu.timerRate, left: +this.runner.guestLeft().toFixed(2), marks: gu.marks.length, blips: gu.marks.filter((k) => k.blip).length, targets: gu.marks.filter((k) => k.target).length } : null,
      backBytes: CREW_BACK_BYTES,
    };
  }
}
