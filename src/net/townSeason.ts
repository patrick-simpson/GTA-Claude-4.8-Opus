// The season and the holiday decorations are the TOWN's (owner, Nov 24: "the season should always sync across players").
// Built the way kid-friendly mode is (core/kid.ts, net/town.ts FACT_KID):
//
//   FACT_SEASON = [season pick, holiday pick, Auto season, Auto holiday, by]
//     season pick   0 auto, 1 autumn, 2 winter, 3 summer   (world/season.ts SeasonPick)
//     holiday pick  0 auto, 1 on, 2 off                     (world/holiday.ts HolidayPick)
//     Auto season   0 autumn, 1 winter, 2 summer            (the HOST's calendar: what Auto means for everybody)
//     Auto holiday  0 or 1                                  (the host's calendar)
//     by            the number in town of whoever changed a pick last (0: the host's calendar, nobody)
//   Written by the host only. The host rewrites it when its calendar turns over (checked every AUTO_CHECK_MS), so
//   two screens in different time zones never disagree, even at midnight on a boundary day.
//
//   A Season ToHost frame (ToHostKind.Season = 13), 5 bytes: "make the town's pick this":
//     0 kind (Frame.ToHost)  1 id  2 ToHostKind.Season  3 what (0 season, 1 holiday)  4 the pick's number as above
//   A guest's screen changes at once and asks the host; if no fact answers within WAIT_MS (a host of an older page),
//   it goes back to the town's. The service relays ToHost frames and stores facts without reading them: no server
//   change and no protocol version bump.
//
// A town with no fact yet (a new town, or a host of an older page has never written one): the host writes one from its
// own menu picks and calendar. While no fact is known, a guest shows its own (an older host never writes one).
// Leaving the town: back to this browser's own picks and calendar. ?season= and ?xmas= pins stay this screen's.

import { Frame, ToHostKind, type FactValue } from './protocol';
import { season, type Season, type SeasonPick } from '../world/season';
import { holiday, type HolidayPick } from '../world/holiday';

export const FACT_SEASON = 'season';
export const SEASON_BYTES = 5;
const SPICK: SeasonPick[] = ['auto', 'autumn', 'winter', 'summer'];
const HPICK: HolidayPick[] = ['auto', 'on', 'off'];
const SAUTO: Season[] = ['autumn', 'winter', 'summer'];
const WAIT_MS = 4000;
const AUTO_CHECK_MS = 30000;

export function encodeSeason(what: 0 | 1, pick: number): ArrayBuffer {
  const b = new Uint8Array(SEASON_BYTES);
  b[0] = Frame.ToHost; b[2] = ToHostKind.Season; b[3] = what; b[4] = pick;
  return b.buffer;
}
export function decodeSeason(buf: ArrayBuffer): { id: number; what: 0 | 1; pick: number } | null {
  if (buf.byteLength < SEASON_BYTES) return null;
  const b = new Uint8Array(buf);
  if (b[0] !== Frame.ToHost || b[2] !== ToHostKind.Season || b[3] > 1) return null;
  const what = b[3] as 0 | 1;
  if (b[4] >= (what ? HPICK.length : SPICK.length)) return null;
  return { id: b[1], what, pick: b[4] };
}

interface TownState { sp: number; hp: number; sa: number; ha: number; by: number }

/** What net/town.ts lends it. */
export interface SeasonLink {
  /** In a town with a welcome (the service clock known). */
  inTown(): boolean;
  isHost(): boolean;
  id(): number;
  hostKnown(): boolean;
  send(buf: ArrayBuffer): boolean;
  put(k: string, v: FactValue): boolean;
  /** A remote's made-up name, or null. */
  name(id: number): string | null;
  isRemote(id: number): boolean;
  say(line: string): void;
}

export class TownSeason {
  /** FACT_SEASON as the service holds it (null: none, or no welcome yet). */
  fact: TownState | null = null;
  private asked: { at: number } | null = null;
  private checkAt = 0;
  readonly stats = { asks: 0, askBytes: 0, got: 0, writes: 0 };
  /** The last line shown, for the tests. */
  last = '';

  constructor(private readonly l: SeasonLink) {
    season.ask = (p) => this.choose(0, SPICK.indexOf(p));
    holiday.ask = (p) => this.choose(1, HPICK.indexOf(p));
  }

  welcome(facts: Record<string, FactValue>): void {
    this.down();
    if (FACT_SEASON in facts) this.heard(facts[FACT_SEASON], true);
  }

  /** A fact from the service: true if it was this one. */
  factIn(k: string, v: FactValue): boolean {
    if (k !== FACT_SEASON) return false;
    this.heard(v, false);
    return true;
  }

  down(): void {
    this.fact = null; this.asked = null; this.checkAt = 0;
    season.town = null; holiday.town = null;
  }

  private parse(v: FactValue): TownState | null {
    const a = typeof v === 'number' ? [v] : Array.isArray(v) ? v : null;
    if (!a || a.length < 4) return null;
    const n = (i: number, max: number): number => { const x = Math.floor(Number(a[i]) || 0); return x >= 0 && x < max ? x : 0; };
    return { sp: n(0, SPICK.length), hp: n(1, HPICK.length), sa: n(2, SAUTO.length), ha: n(3, 2), by: Math.floor(Number(a[4]) || 0) };
  }

  private heard(v: FactValue, quiet: boolean): void {
    const s = this.parse(v);
    if (!s) return;
    const was = this.fact;
    this.fact = s;
    this.asked = null;
    this.apply(s);
    if (!quiet && was && s.by && s.by !== this.l.id()) {
      if (s.sp !== was.sp) this.tell(this.seasonLine(s, s.by));
      if (s.hp !== was.hp) this.tell(this.holidayLine(s, s.by));
    }
  }

  private apply(s: TownState): void {
    season.town = { pick: SPICK[s.sp], auto: SAUTO[s.sa] };
    holiday.town = { pick: HPICK[s.hp], auto: s.ha === 1 };
  }

  private who(by: number): string { return this.l.name(by) ?? 'Somebody'; }
  private seasonLine(s: TownState, by: number): string {
    const p = SPICK[s.sp];
    return p === 'auto' ? `${this.who(by)} put the season back on the calendar (${SAUTO[s.sa]}).` : `${this.who(by)} made it ${p}.`;
  }
  private holidayLine(s: TownState, by: number): string {
    const p = HPICK[s.hp];
    return p === 'on' ? `${this.who(by)} put the holiday decorations up.` : p === 'off' ? `${this.who(by)} took the holiday decorations down.` : `${this.who(by)} left the holiday decorations to the calendar.`;
  }
  private tell(line: string): void { this.last = line; this.l.say(line); }

  /** The menu at this keyboard. False: not in a town (the pick is this browser's alone). */
  private choose(what: 0 | 1, pick: number): boolean {
    if (!this.l.inTown() || pick < 0) return false;
    const base = this.fact ?? this.mine(0);
    const next = { ...base, by: this.l.id() };
    if (what === 0) next.sp = pick; else next.hp = pick;
    if (this.l.isHost()) { this.write(next); return true; }
    // A guest: its own screen at once, then the host's fact for everybody.
    this.apply(next);
    if (this.l.send(encodeSeason(what, pick))) { this.stats.asks++; this.stats.askBytes += SEASON_BYTES; }
    this.asked = { at: performance.now() };
    return true;
  }

  /** This browser's own picks and calendar, as a town state. */
  private mine(by: number): TownState {
    return { sp: Math.max(0, SPICK.indexOf(season.pick)), hp: Math.max(0, HPICK.indexOf(holiday.pick)), sa: Math.max(0, SAUTO.indexOf(season.local)), ha: holiday.local ? 1 : 0, by };
  }

  private write(s: TownState): void {
    if (!this.l.put(FACT_SEASON, [s.sp, s.hp, s.sa, s.ha, s.by])) return;
    this.stats.writes++;
    this.fact = s;
    this.apply(s);
  }

  /** A ToHost frame: true if it was this kind (whether or not acted on). */
  toHost(buf: ArrayBuffer): boolean {
    const m = decodeSeason(buf);
    if (!m) return new Uint8Array(buf, 2, 1)[0] === ToHostKind.Season;
    if (!this.l.isHost() || !this.l.isRemote(m.id)) return true;
    this.stats.got++;
    const next = { ...(this.fact ?? this.mine(0)), by: m.id };
    if (m.what === 0) next.sp = m.pick; else next.hp = m.pick;
    const was = this.fact;
    this.write(next);
    if (!was || next.sp !== was.sp) this.tell(this.seasonLine(next, m.id));
    if (!was || next.hp !== was.hp) this.tell(this.holidayLine(next, m.id));
    return true;
  }

  tick(now: number): void {
    if (!this.l.inTown()) return;
    if (this.l.isHost()) {
      // The host's calendar is Auto for everybody: write it when there is no fact yet, or when it has turned over.
      if (!this.fact) this.write(this.mine(0));
      else if (now >= this.checkAt) {
        this.checkAt = now + AUTO_CHECK_MS;
        const sa = Math.max(0, SAUTO.indexOf(season.local)), ha = holiday.local ? 1 : 0;
        if (sa !== this.fact.sa || ha !== this.fact.ha) this.write({ ...this.fact, sa, ha });
      }
      return;
    }
    // A guest whose ask went unanswered (a host of an older page): back to the town's, or to its own if none.
    if (this.asked && now - this.asked.at > WAIT_MS) {
      this.asked = null;
      if (this.fact) this.apply(this.fact); else { season.town = null; holiday.town = null; }
    }
  }
}
