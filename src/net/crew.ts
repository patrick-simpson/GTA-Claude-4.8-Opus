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
// Not here yet (later steps): the mission's people, targets, pickups and riders shown to the crew; crew actions other
// than driving the car counting (a helper reaching a marker, wrecking a target); pause.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { money } from '../core/util';
import { KINDS, SPECS } from '../ent/vehicleSpecs';
import { charCar } from '../ent/weapons';
import { progress } from '../world/progress';
import { FAILS, type CrewLink, type Guest, type Mission, type Runner, type ViewMark } from '../game/script';
import { save } from '../game/save';
import {
  CREW_BACK_BYTES, CREW_MARK_BYTES, CREW_MARKS_MAX, CREW_SHOW_BYTES, CrewEnd, CrewKind, CrewLabel, SEND_HZ,
  crewKindOf, decodeCrewBack, decodeCrewLend, decodeCrewShow, decodeCrewSmall, decodeCrewTeam,
  encodeCrewBack, encodeCrewLend, encodeCrewShow, encodeCrewSmall, encodeCrewTeam, type CrewShowRec,
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

interface Lent { id: number; kind: string; color: number }
interface Borrowed { boss: number; sat: boolean; at: number }

export class TownCrew implements CrewLink {
  /** Frames sent and heard, by what they were, and bytes; drafts, pays, cars lent and handed back. */
  readonly stats = { sent: 0, bytesSent: 0, got: 0, bytesGot: 0, shows: 0, showBytes: 0, teams: 0, drafted: 0, declined: 0, paid: 0, lent: 0, back: 0, reclaimed: 0 };

  // ── As the starter ──
  private team: number[] = [];
  private mIdx = 0;
  private readonly lentOut = new Map<Vehicle, Lent>();
  private last: CrewShowRec | null = null;
  private lastAt = 0;
  private force = false;

  // ── As a helper ──
  /** The starter whose crew this player is on (0: none). */
  boss = 0;
  private bossM: Mission | null = null;
  private readonly borrowed = new Map<Vehicle, Borrowed>();
  private asking: { v: Vehicle; at: number; refused: boolean } | null = null;
  /** The last outcome this player was told, for the tests. */
  lastEnd = '';

  // ── Everybody ──
  /** Other starters and their crews: nobody in these is drafted. */
  private readonly others = new Map<number, number[]>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly held: TownHeld, private readonly cars: TownCars) {
    this.runner.crew = this;
    held.crewOf = (id) => id !== 0 && id === this.boss;
    const prev = game.takeShared;
    game.takeShared = (v) => this.ask(v) ?? (prev ? prev(v) : 'no');
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
    this.team = []; this.mIdx = 0; this.last = null;
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

  drop(v: Vehicle, keep: boolean): void {
    const l = this.lentOut.get(v);
    if (!l) return;
    this.lentOut.delete(v);
    if (this.inTown && this.send(encodeCrewSmall(CrewKind.Reclaim, l.id, keep ? 1 : 0))) this.stats.reclaimed++;
  }

  private sendTeam(mIdx: number, ids: number[]): void {
    if (!this.inTown) return;
    if (this.send(encodeCrewTeam(mIdx, ids))) { this.stats.teams++; this.force = true; }
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
        if (l && l.to === me) this.answered(l.id, l.slot, l.yes, l.health);
        return;
      }
      case CrewKind.Back: {
        const b = decodeCrewBack(buf);
        if (b && b.starter === me) this.back(k.id, b);
        return;
      }
      case CrewKind.Reclaim: {
        const r = decodeCrewSmall(buf);
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
    const gu: Guest = { who, m, line, objective: null, timerLabel: null, timerMode: 0, timerValue: 0, timerUrgent: false, timerAt: 0, marks: [] };
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
      this.release('', true);
      g.hud.stamp('FILED', `${m.title} · ${money(m.reward)} · ${m.points} toward the bridge · on ${who}'s job`);
      if (m.unlocks) g.hud.toast(m.unlocks, 8);
      return;
    }
    const f = FAILS[why];
    this.lastEnd = how === CrewEnd.Failed ? `failed: ${f ? f[0] : '?'}` : 'set aside';
    this.release('', true);
    if (how === CrewEnd.Failed) g.hud.stamp(f ? f[0] : 'CALLED OFF', `${who}'s job: ${f ? f[1] : 'it did not work out.'}`);
    else g.hud.toast(`${who} set the job aside. Your time is your own again.`, 6);
  }

  /** Off the crew. `why`: a toast, or nothing. */
  private release(why: string, quiet = false): void {
    const by = this.boss;
    if (!by) return;
    this.boss = 0; this.bossM = null;
    this.runner.unguest();
    if (this.game.todo.busy?.startsWith('crew:')) this.game.todo.setBusy(null);
    this.held.restyle(by);
    if (!quiet && why) this.game.hud.toast(why, 6);
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
  private giveBack(v: Vehicle, b: Borrowed): void {
    this.borrowed.delete(v);
    v.lent = false;
    if (!this.remotes.has(b.boss) || !this.inTown) {
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
    const ok = !!v && this.team.includes(to) && this.runner.owns(v) && v.driver === null && !v.wreck && !v.sunk && !v.removed && vs.list.includes(v) && !this.lentOut.has(v);
    if (!ok || !v) { this.send(encodeCrewLend(to, slot, false, 0)); return; }
    if (!this.send(encodeCrewLend(to, slot, true, v.health))) return;
    // Off this browser's streets: the helper's browser simulates it now. The script keeps its record (`v`), which
    // follows the helper's car from here on (update()).
    this.lentOut.set(v, { id: to, kind: v.spec.kind, color: v.color });
    vs.remove(v);
    this.stats.lent++;
  }

  private back(from: number, b: { flags: number; health: number; kind: number; x: number; y: number; z: number; yaw: number; vx: number; vz: number }): void {
    for (const [v, l] of this.lentOut) {
      if (l.id !== from) continue;
      this.lentOut.delete(v);
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

  private sendShow(now: number): void {
    const run = this.runner, m = run.cur;
    if (!m || !this.team.length || run.failed) return;
    const v = run.view, rec: CrewShowRec = {
      mission: this.mIdx, step: Math.min(255, (run.want()?.i ?? 0)), what: v.what, arg: v.arg, label: v.label, mode: v.mode,
      urgent: v.urgent, value: v.value, marks: v.marks.slice(0, CREW_MARKS_MAX),
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
        const gone = (now - this.lastAt) / 100;
        const guess = l.mode === 1 ? l.value - gone : l.value;
        changed = rec.mode === 3 ? rec.value !== l.value && now - this.lastAt >= METERS_MS : Math.abs(guess - rec.value) > DRIFT;
      }
    }
    if (!changed || now - this.lastAt < SEND_MS - 4) return;
    const buf = encodeCrewShow(rec);
    if (!this.send(buf)) return;
    this.stats.shows++; this.stats.showBytes += CREW_SHOW_BYTES + rec.marks.length * CREW_MARK_BYTES;
    // (A copy: the view's marks are reused next frame.)
    this.last = { ...rec, marks: rec.marks.map((k) => ({ ...k })) };
    this.lastAt = now;
    this.force = false;
  }

  // ── Comings and goings ──────────────────────────────────────────────────────

  /** Somebody has left town (index.ts). */
  dropped(id: number): void {
    this.others.delete(id);
    for (const ids of this.others.values()) { const i = ids.indexOf(id); if (i > 0) ids.splice(i, 1); }
    if (this.boss === id) this.release(`${this.runner.guest?.who ?? 'The starter'} has left town. The job went with them.`);
    for (const [v, b] of this.borrowed) if (b.boss === id) this.giveBack(v, b);
    const i = this.team.indexOf(id);
    if (i >= 0) { this.team.splice(i, 1); this.sendTeam(this.team.length ? this.mIdx : 0, this.team); if (!this.team.length) this.mIdx = 0; }
    // A car they had: it comes back where they were last seen with it.
    for (const [v, l] of this.lentOut) if (l.id === id) { this.lentOut.delete(v); this.standAgain(v, v.x, v.z, v.h, 0, 0, v.health, !!v.wreck); }
  }

  /** Out of town altogether. */
  clear(): void {
    this.others.clear();
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
    this.sendShow(now);
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
      ...this.stats, range: CREW_RANGE, team: this.team.slice(), mission: this.mIdx, boss: this.boss, lastEnd: this.lastEnd,
      lentOut: [...this.lentOut.values()].map((l) => l.id), borrowed: this.borrowed.size,
      others: [...this.others.entries()].map(([k, v]) => [k, ...v.slice(1)]),
      guest: gu ? { who: gu.who, mission: gu.m.id, line: gu.line, objective: gu.objective, timer: gu.timerLabel, mode: gu.timerMode, value: gu.timerValue, marks: gu.marks.length, blips: gu.marks.filter((k) => k.blip).length } : null,
      backBytes: CREW_BACK_BYTES,
    };
  }
}
