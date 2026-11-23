// Multiplayer, stage 4, step 1: the same hour, the same weather and the same bridge for everybody in town.
//
// THE HOUR is not sent at all. The service puts its own clock in every welcome; one real minute is one game hour
// (the game's own rate), so the town's hour is that clock read as game hours, plus one durable fact (FACT_CLOCK, game
// hours, 0 until somebody changes it). Every browser works it out for itself, the same on the main service and on the
// backup, and no host is needed for it: it cannot be lost in a host change. It runs on real time, so it does not stop
// for a pause, and a browser that was paused or has just connected catches up as a short time lapse (never backward).
//
// THE WEATHER is not sent either. Town time is cut into spells of WEATHER_SPELL_H game hours, and the weather of a
// spell is a fixed function of its number and a seed (FACT_WEATHER_SEED), with the single player game's own odds. The
// same fact can carry one forced weather and the hour it ends, for a cheat or a test.
//
// Only the HOST can write a fact (the service drops anybody else's), so an hour or a weather asked for at the host's
// keyboard (Sky.ask: the cheats and the test hooks) becomes the town's; asked for at a guest's it is put straight back.
//
// THE BRIDGE (and the stages of the far town) is the town's on the MAIN service: FACT_BRIDGE = [spans, stage, bank].
//  - What everybody sees is the town's. It never goes backward.
//  - Each player's own progress is kept apart (world/progress.ts `mine`), still earns every point that player earns,
//    is the only thing saved in their browser, and is what they see again on a visit without the town.
//  - The town takes up the furthest progress it meets (TOWN_TAKES_FURTHEST): a player whose own is further along
//    brings the town up to it. So nobody ever stands on a span the town has not got. This is the one rule most
//    likely to be changed by the owner; with the constant false the town only ever advances by points earned in it.
//  - Points earned in town (missions, jobs, the boxes, driving) count for the town as well: each browser counts its own
//    on its own screen at once and tells the host (Give), who counts everybody's and writes the fact.
//  - On the BACKUP the bridge stays each player's own and nothing is sent about it (every message there is rationed).
//  - If the connection drops, the screen keeps the bridge it was showing until the page is reloaded.
//
// WHOSE POINTS (stage 4, step 5). FACT_BRIDGE carries a fourth number: the player whose points finished the last span or
// stage (their number in town; 0 unknown). The host knows it: a guest's Give that finished a goal on its screen, a
// guest's Mine that moved the town on, or else its own player's. Every screen in town is told once, when the fact
// moves on a goal: "<name>'s points finished span 4 of 8." (the game's made up names only), "Your points ..." on the
// finisher's own. An older page reads the first three numbers and never looks at the fourth.
//
// Sent: nothing while nothing changes. A fact when the host changes the hour or the weather; the bridge fact when a
// span or a stage is finished (at once) or the bank has moved (at most every BANK_MS); a guest's Give at most every
// GIVE_MS while it is earning; a Mine only when a guest is ahead of the town.

import type { Game } from '../core/game';
import type { Weather } from '../core/api';
import { cmpStand, progress, type Stand } from '../world/progress';
import { BRIDGE_SPANS } from '../world/plan';
import { STAGE_NAMES } from '../world/mainland';
import {
  FACT_BRIDGE, FACT_CLOCK, FACT_WEATHER_SEED, GIVE_BYTES, MINE_BYTES, TOWN_WEATHERS, ToHostKind,
  decodeGive, decodeMine, encodeGive, encodeMine, encodeMsg,
  type FactValue, type ServerMsg, type WelcomeMsg,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';

/** Does a player whose own bridge is further along than the town's bring the town up to it? (See the header.) */
export const TOWN_TAKES_FURTHEST = true;
/** Real ms to one game hour: the game's own rate (Sky.rate, 1/60 of an hour a second). */
const HOUR_MS = 60000;
/** Game hours one spell of town weather lasts. */
export const WEATHER_SPELL_H = 2;
/** Game hours a weather asked for by the host is held. */
const FORCED_H = 3;
/** Catching up after a pause or a late join: game hours a real second, forward only. */
const LAPSE_H_PER_S = 3;
/** For this long after the game starts the town's hour and weather are set at a stroke, ms. */
const START_SNAP_MS = 1500;
/** The host writes a bank that has only crept (no span finished) no more often than this. */
const BANK_MS = 5000;
/** A guest's earnings go to the host no more often than this, unless there are GIVE_NOW points waiting. */
const GIVE_MS = 3000;
const GIVE_NOW = 20;
/** A guest ahead of the town says so after this long (longer just after a Give: the host's fact is on its way), and at most CLAIM_MAX times to one host. */
const CLAIM_MS = 1500;
const CLAIM_AFTER_GIVE_MS = 7000;
const CLAIM_AGAIN_MS = 5000;
const CLAIM_MAX = 6;

/** A number in [0, 1) from two integers, the same in every browser. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The town's weather at town time `a` (game hours since 1970): the single player game's odds, decided once a spell. */
export function townWeather(a: number, seed: number): Weather {
  const spell = Math.floor(a / WEATHER_SPELL_H);
  const h = (((spell + 0.5) * WEATHER_SPELL_H) % 24 + 24) % 24, r = hash01(spell, seed);
  // (Sky.pickWeather's numbers: fog belongs to the small hours, rain now and then, mostly clear.)
  const pFog = h > 3.5 && h < 8.5 ? 0.4 : h > 10 && h < 19 ? 0.03 : 0.1, pRain = 0.13, pOver = 0.2;
  return r < pFog ? 'fog' : r < pFog + pRain ? 'rain' : r < pFog + pRain + pOver ? 'overcast' : 'clear';
}

const mod24 = (h: number): number => ((h % 24) + 24) % 24;
const DEFAULTS: Record<string, string> = { [FACT_CLOCK]: '0', [FACT_WEATHER_SEED]: '[0,0,0]' };

export class Town {
  readonly stats = { factsSent: 0, factBytes: 0, factsGot: 0, gives: 0, giveBytes: 0, givesGot: 0, claims: 0, claimBytes: 0, claimsGot: 0, lapses: 0, finishes: 0 };

  /** The service's clock less this browser's (ms); NaN until a welcome. */
  private svcOff = NaN;
  /** FACT_CLOCK: game hours added to the service's clock. */
  private clockOff = 0;
  /** FACT_WEATHER_SEED: the seed, a forced weather (0 none, else 1 + index) and the town hour it ends. */
  private seed = 0;
  private forced = 0;
  private forcedUntil = 0;
  /** FACT_BRIDGE as the service holds it, or null when it holds none (or this is the backup). */
  private bridge: Stand | null = null;
  /** Host: whose points finished the goal the town is about to write (0: this player's own, or nobody known). */
  private finisher = 0;
  /** The last "whose points" notice, for the tests. */
  lastFinish = '';
  /** What the service holds, as JSON by key: a fact equal to it is not written again. */
  private readonly known = new Map<string, string>();

  private led = false;
  private lapsing = false;
  /** The host's hour or weather fact has still to go out. */
  private unsent = false;
  private snap = true;
  private snapUntil = 0;
  private lastState = '';
  private lastAt = 0;
  /** In a town on the main service: the bridge is the town's. */
  private inTown = false;
  private hostReady = false;
  /** False until the town's bridge has first been put on this screen: that first change is nobody's news. */
  private live = false;
  private bankAt = -1e9;
  private owed = 0;
  private giveAt = -1e9;
  private aheadSince = 0;
  private claimAt = -1e9;
  private claimsMade = 0;

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {
    game.sky.asked = (hour, weather) => this.asked(hour, weather);
  }

  private get online(): boolean { return this.conn.status === 'online'; }
  private get host(): boolean { return this.online && this.conn.host === this.conn.id; }
  /** Town time now: game hours since 1970. */
  private at(now: number): number { return (now + this.svcOff) / HOUR_MS + this.clockOff; }

  // ── Facts in ────────────────────────────────────────────────────────────────

  welcome(m: WelcomeMsg, now: number): void {
    this.down();
    this.svcOff = Number.isFinite(m.now) ? m.now - now : NaN;
    for (const k of Object.keys(m.facts)) this.fact(k, m.facts[k]);
  }

  msg(m: ServerMsg): void {
    if (m.t === 'fact') { this.stats.factsGot++; this.fact(m.k, m.v); }
    // A new host: what this guest is owed or ahead by is said again to that one.
    else if (m.t === 'host') { this.claimsMade = 0; this.claimAt = -1e9; this.aheadSince = 0; }
  }

  private fact(k: string, v: FactValue): void {
    this.known.set(k, JSON.stringify(v));
    if (k === FACT_CLOCK) { if (typeof v === 'number' && Number.isFinite(v)) this.clockOff = v >= 0 && v < 24 ? v : mod24(v); }
    else if (k === FACT_WEATHER_SEED) {
      const a = typeof v === 'number' ? [v] : v;
      this.seed = Math.floor(Number(a[0]) || 0);
      const f = Math.floor(Number(a[1]) || 0);
      this.forced = f >= 1 && f <= TOWN_WEATHERS.length ? f : 0;
      this.forcedUntil = Number(a[2]) || 0;
    } else if (k === FACT_BRIDGE && Array.isArray(v) && v.length >= 3 && this.conn.home === 'main') {
      const was = this.bridge, to = { spans: Number(v[0]) || 0, stage: Number(v[1]) || 0, bank: Number(v[2]) || 0 };
      this.bridge = to;
      // (The first one heard on a visit is history, not news.)
      if (was && this.live) this.finished(was, to, Math.floor(Number(v[3]) || 0));
    }
  }

  /** The town's bridge moved from `was` to `to` on somebody's points: say whose, if a span or a stage was finished. */
  private finished(was: Stand, to: Stand, by: number): void {
    const span = to.spans > was.spans, stage = to.stage > was.stage;
    if (!span && !stage) return;
    const what = stage ? `${STAGE_NAMES[to.stage] ?? `stage ${to.stage}`}` : `span ${to.spans} of ${BRIDGE_SPANS}`;
    const mine = by !== 0 && by === this.conn.id, r = by ? this.remotes.get(by) : undefined;
    const line = mine ? `Your points finished ${what} for the town.` : r ? `${r.text}'s points finished ${what}.` : `The town's points finished ${what}.`;
    this.lastFinish = line;
    this.stats.finishes++;
    if (this.game.state === 'play' || this.game.state === 'paused') this.game.hud.toast(line, 6);
  }

  /** The connection has gone. The sky runs on by itself from where it is; the bridge on the screen stays (see the header). */
  down(): void {
    this.svcOff = NaN;
    this.clockOff = 0; this.seed = 0; this.forced = 0; this.forcedUntil = 0;
    this.bridge = null;
    this.known.clear();
    this.led = this.game.sky.led = false;
    this.inTown = false; this.hostReady = false; this.live = false; this.unsent = false;
    progress.sink = null;
    this.owed = 0; this.aheadSince = 0; this.claimsMade = 0; this.claimAt = -1e9;
  }

  /** Write a fact unless the service already holds exactly this. False: it could not be sent; try again. */
  private put(k: string, v: FactValue): boolean {
    const j = JSON.stringify(v);
    if ((this.known.get(k) ?? DEFAULTS[k]) === j) return true;
    const text = encodeMsg({ t: 'fact', k, v });
    if (!this.conn.send(text)) return false;
    this.known.set(k, j);
    this.stats.factsSent++; this.stats.factBytes += text.length;
    return true;
  }

  // ── The hour and the weather ────────────────────────────────────────────────

  /** A cheat or a test at this keyboard has set the hour or the weather (already done on this screen). */
  private asked(hour: number | null, weather: Weather | null): void {
    if (!this.online || !Number.isFinite(this.svcOff)) return;
    // A guest cannot change the town: the next frame puts the town's back.
    if (!this.host) { this.snap = true; return; }
    const now = performance.now();
    if (hour !== null && Number.isFinite(hour)) {
      this.clockOff = +mod24(hour - (now + this.svcOff) / HOUR_MS).toFixed(4);
      if (!this.put(FACT_CLOCK, this.clockOff)) this.unsent = true;
      this.snap = true;
    }
    if (weather !== null) {
      this.forced = TOWN_WEATHERS.indexOf(weather) + 1;
      this.forcedUntil = +(this.at(now) + FORCED_H).toFixed(2);
      if (!this.put(FACT_WEATHER_SEED, [this.seed, this.forced, this.forcedUntil])) this.unsent = true;
    }
  }

  private wantWeather(a: number): Weather {
    return this.forced > 0 && a < this.forcedUntil ? TOWN_WEATHERS[this.forced - 1] : townWeather(a, this.seed);
  }

  private sky(now: number): void {
    const g = this.game, sky = g.sky, state = g.state;
    // The title card holds an hour of its own; the town's begins with the game.
    const led = this.online && Number.isFinite(this.svcOff) && state === 'play';
    // (Coming off the title card the card puts its held hour and weather back a moment after the game starts: for
    // that moment the town's are simply set, so the game does not open on a time lapse and a 20 second change of weather.)
    if (state !== this.lastState) { if (this.lastState !== 'play' && this.lastState !== 'paused') this.snapUntil = now + START_SNAP_MS; this.lastState = state; }
    if (now < this.snapUntil) this.snap = true;
    const dt = Math.min(0.25, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    if (led !== this.led) { this.led = sky.led = led; }
    if (!led) return;
    const a = this.at(now), want = mod24(a), day = Math.floor(a / 24);
    const gap = mod24(want - sky.hour);
    // Within three game minutes either way it is simply set; otherwise the hands run forward to it.
    const snap = this.snap || gap < 0.05 || gap > 23.95;
    if (snap) sky.lead(want, day);
    else {
      if (!this.lapsing && gap > 1) this.stats.lapses++;
      sky.lead(mod24(sky.hour + Math.min(gap, LAPSE_H_PER_S * dt)), day);
    }
    this.lapsing = !snap;
    const w = this.wantWeather(a);
    if (sky.weather !== w) sky.setWeather(w, this.snap);
    // (A host whose fact did not go out, the socket being busy: again.)
    if (this.unsent && this.host) {
      const a1 = this.put(FACT_CLOCK, this.clockOff), a2 = this.put(FACT_WEATHER_SEED, [this.seed, this.forced, this.forcedUntil]);
      this.unsent = !(a1 && a2);
    }
    this.snap = false;
  }

  // ── The bridge ──────────────────────────────────────────────────────────────

  private further(a: Stand, b: Stand | null): Stand { return b && cmpStand(b, a) > 0 ? b : a; }

  private works(now: number): void {
    const c = this.conn, main = this.online && c.home === 'main';
    if (main !== this.inTown) {
      this.inTown = main;
      this.hostReady = false;
      if (main) {
        // From here on `progress` shows the town's and keeps this player's own apart.
        if (!progress.mine) progress.showTown(progress, false);
        progress.sink = { give: (p) => { this.owed += p; } };
      } else progress.sink = null;
    }
    if (!main) return;
    const shown: Stand = progress;
    if (this.host) {
      this.owed = 0;
      if (!this.hostReady) {
        // The town's is the furthest of what the service remembers and what is on this screen (and this player's own).
        let best = this.further(shown, this.bridge);
        if (TOWN_TAKES_FURTHEST) best = this.further(best, progress.own());
        progress.showTown({ spans: best.spans, stage: best.stage, bank: best.bank }, this.live);
        this.hostReady = this.live = true;
      } else if (TOWN_TAKES_FURTHEST && cmpStand(progress.own(), shown) > 0) {
        const o = progress.own();
        progress.showTown({ spans: o.spans, stage: o.stage, bank: o.bank }, true);
      }
      const b = this.bridge, bank = Math.floor(shown.bank);
      const goal = !b || b.spans !== shown.spans || b.stage !== shown.stage;
      if (goal || (b && b.bank !== bank && now - this.bankAt >= BANK_MS)) {
        // (Whose points: the guest's whose Give or Mine finished it, else this player's own.)
        const by = goal ? this.finisher || this.conn.id : 0;
        const fact = by ? [shown.spans, shown.stage, bank, by] : [shown.spans, shown.stage, bank];
        if (this.put(FACT_BRIDGE, fact)) {
          const to = { spans: shown.spans, stage: shown.stage, bank };
          if (b && goal && this.live) this.finished(b, to, by);
          this.bridge = to; this.bankAt = now; this.finisher = 0;
        }
      }
      return;
    }
    // A guest.
    this.hostReady = false;
    const b = this.bridge;
    if (b && cmpStand(b, shown) > 0) progress.showTown({ spans: b.spans, stage: b.stage, bank: b.bank }, this.live);
    if (b) this.live = true;
    if (this.owed >= 0.01 && (this.owed >= GIVE_NOW || now - this.giveAt >= GIVE_MS)) {
      if (c.send(encodeGive(this.owed))) { this.owed = 0; this.giveAt = now; this.stats.gives++; this.stats.giveBytes += GIVE_BYTES; }
    }
    // Ahead of the town (a further bridge of this player's own, or points the host never heard of): say so.
    const best = TOWN_TAKES_FURTHEST ? this.further(shown, progress.own()) : shown;
    const ahead = b ? cmpStand(best, b) > 0 : true;
    if (!ahead || !TOWN_TAKES_FURTHEST && !b) { this.aheadSince = 0; this.claimsMade = 0; return; }
    if (!this.aheadSince) this.aheadSince = now;
    const wait = now - this.giveAt < CLAIM_AFTER_GIVE_MS ? CLAIM_AFTER_GIVE_MS : CLAIM_MS;
    if (now - this.aheadSince < wait || now - this.claimAt < CLAIM_AGAIN_MS || this.claimsMade >= CLAIM_MAX) return;
    if (c.send(encodeMine(best.spans, best.stage, best.bank))) { this.claimAt = now; this.claimsMade++; this.stats.claims++; this.stats.claimBytes += MINE_BYTES; }
  }

  /** A ToHost frame. True: it was the town's (whether or not it was acted on). */
  toHost(buf: ArrayBuffer): boolean {
    if (buf.byteLength < 3) return false;
    const what = new Uint8Array(buf, 2, 1)[0];
    if (what !== ToHostKind.Give && what !== ToHostKind.Mine) return false;
    if (!this.host || !this.inTown || !this.hostReady) return true;
    if (what === ToHostKind.Give) {
      const g = decodeGive(buf);
      if (!g || !this.remotes.has(g.id)) return true;
      this.stats.givesGot++;
      if (progress.addTown(g.points) > 0) this.finisher = g.id;
    } else {
      const m = decodeMine(buf);
      if (!m || !this.remotes.has(m.id)) return true;
      this.stats.claimsGot++;
      const was = { spans: progress.spans, stage: progress.stage };
      progress.showTown({ spans: m.spans, stage: m.stage, bank: m.bank }, true);
      if (progress.spans > was.spans || progress.stage > was.stage) this.finisher = m.id;
    }
    return true;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number): void {
    this.sky(now);
    this.works(now);
  }

  /** For the tests (window.__game.net().town). */
  info(): Record<string, unknown> {
    const now = performance.now(), sky = this.game.sky, ok = this.online && Number.isFinite(this.svcOff);
    const a = ok ? this.at(now) : NaN, o = progress.own();
    const st = (s: Stand | null): number[] | null => s ? [s.spans, s.stage, Math.floor(s.bank)] : null;
    return {
      host: this.host, home: this.conn.home, led: this.led,
      // hour: on this screen. townHour: what the town's clock says (null when not in one). weather: on this screen.
      hour: +sky.hour.toFixed(3), townHour: ok ? +mod24(a).toFixed(3) : null, weather: sky.weather, townWeather: ok ? this.wantWeather(a) : null,
      clock: this.clockOff, seed: this.seed, forced: this.forced > 0 && ok && a < this.forcedUntil ? TOWN_WEATHERS[this.forced - 1] : '',
      // bridge: the fact as the service holds it. shown: on this screen. own: this player's own, which is what is saved. Each [spans, stage, bank].
      inTown: this.inTown, bridge: st(this.bridge), shown: st(progress), own: st(o), apart: progress.mine !== null, owed: +this.owed.toFixed(2),
      lastFinish: this.lastFinish,
      ...this.stats,
    };
  }
}
