// Fun queue 2, item 26: spectator betting, in-game cash only. Back a driver in the demolition derby or in a street race you
// are not in; if they win you are paid.
//
// WINDOWS: a window opens when somebody calls a street race or a derby (the Call frame every browser in town already gets,
// net/race.ts and net/derby.ts) and closes at the start (the Go frame; a derby's window runs the 4 s count too, because that is
// when the AI cars first have names). A player who is in the event cannot bet on it (no backing yourself to throw it); one who
// joins after betting gets the stake back. At Flounder Field's gate, Z with nothing open puts on a derby of eight locals (no
// player in it) with a 25 s window, so anyone alone in town can watch and bet too.
// ODDS: the field's weights (1 each, 1.35 for the town record holder), a share p = w / sum(w); the pay for a winning stake is
// (1 - HOUSE) / p, rounded DOWN to cents of a multiple, so a bet is never worth its stake: 15% stays with the house.
// MONEY: one bet per window, $10 to $500, taken at once and held (bt.hold in the best table: a page reloaded mid-event gets
// it back), paid on the result seen by every browser (the Done frames of a race, the End frame of a derby); refunded when the
// event is called off, the caller or the backed driver leaves town, the result never comes, or you take it back before the
// start. Saved: bt.won (dollars won over the stakes), bt.lost (stakes lost), bt.n (bets), bt.hold. Each browser settles its
// own bet from what it sees: there is no pool on the wire, no new event code, no protocol change, no fact key.

import type { Game } from '../core/game';
import { money } from '../core/util';
import { save } from './save';
import { derbyField } from './derby';

export const BET_MIN = 10, BET_MAX = 500;
/** The house keeps this share of every pool. */
export const HOUSE = 0.15;
export const STAKES = [10, 25, 50, 100, 250, 500];
/** A town record holder is rated this much over the rest of the field. */
const HOLDER_W = 1.35;
/** A race that has not finished this long after its first finisher is settled with the ones who have. */
const LATE_MS = 80000;
/** Bets taken back and settled windows are kept this long for the panel. */
const KEEP_MS = 90000;
/** How long a window waits for its Go frame past its time, and for a result after the start, before it is called off. */
const GO_GRACE_MS = 15000, RESULT_MS = 25 * 60000;
/** The derby window stays open this long after the Go frame (the grid's count), ms. */
const DERBY_COUNT_MS = 3500;
const LOCAL_WINDOW_S = 25;

export type BetKind = 'race' | 'derby';
export interface Entrant { key: string; name: string; tag: string; w: number }
export interface Bet { pick: string; name: string; tag: string; stake: number; mult: number }
export interface Win {
  id: string; kind: BetKind; title: string; caller: number; local: boolean;
  state: 'open' | 'closed' | 'settled' | 'void';
  until: number; goAt: number; settledAt: number; firstDone: number;
  entrants: Entrant[]; bet: Bet | null; result: string;
  fin: Map<string, { how: number; ms: number }>;
}

/** The pay multiple for each weight: (1 - HOUSE) / p, rounded down to hundredths. */
export function odds(ws: number[]): number[] {
  const s = ws.reduce((a, b) => a + b, 0);
  return ws.map((w) => Math.floor(((1 - HOUSE) * s / w) * 100) / 100);
}
/** What a winning stake returns (the stake included), whole dollars, rounded down. */
export const returns = (stake: number, mult: number): number => Math.floor(stake * mult);
const mult = (x: number): string => `x${x.toFixed(2).replace(/0$/, '')}`;
export const multText = mult;
const humanKey = (id: number): string => `p${id}`;
const aiKey = (k: number): string => `a${k}`;
export const keyOfDerbyId = (id: number): string => (id >= 200 ? aiKey(id - 200) : humanKey(id));

export class Betting {
  readonly wins = new Map<string, Win>();
  /** Raised on every change, for the panel. */
  rev = 0;
  /** Set by ui/betPanel.ts. */
  show: (() => void) | null = null;
  panelOpen = false;
  readonly stats = { opened: 0, placed: 0, won: 0, lost: 0, refunded: 0 };
  private clk = 0;

  constructor(private readonly game: Game) {
    // Money held in a bet by a page that was closed mid-event comes home.
    const held = Math.floor(save.data.best['bt.hold'] ?? 0);
    if (held > 0) {
      game.player.money += held; save.credit(held);
      save.data.best['bt.hold'] = 0;
      setTimeout(() => game.hud.toast(`A bet was still open when you left. Your ${money(held)} is back.`, 6), 2500);
    }
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyZ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || this.game.state !== 'play' || this.game.photo?.open || this.panelOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.press();
    });
  }

  private get toast(): (s: string, secs?: number) => void { return (s, secs = 5) => this.game.hud.toast(s, secs); }
  private get me(): number { const l = this.game.todo.racing.link; return l ? l.me() : 0; }

  // ── What the player does ───────────────────────────────────────────────────

  /** Z: the bet slip when a window is open or a bet is waiting; else, at the derby gate, a derby of eight locals to bet on. */
  press(): void {
    if (this.openList().length || [...this.wins.values()].some((w) => w.bet && (w.state === 'open' || w.state === 'closed')) || this.recent()) { this.show?.(); return; }
    if (this.game.todo.derby.watchOffer()) { this.game.todo.derby.watch(); return; }
    this.toast('No bets are open. They open when somebody calls a street race or a derby in town, and you are not in it. At the Flounder Field gate, Z puts on a derby of eight locals to bet on.', 7);
  }

  /** Ms to the close of a window's bets (negative once past). */
  left(w: Win): number { return w.until - this.clk; }

  /** The windows a bet can be put on now, soonest first. */
  openList(): Win[] { return [...this.wins.values()].filter((w) => w.state === 'open' && !this.blocked(w)).sort((a, b) => a.until - b.until); }
  /** A window settled lately (its result is on the slip). */
  private recent(): boolean { return [...this.wins.values()].some((w) => (w.state === 'settled' || w.state === 'void') && w.result !== ''); }

  /** Why the player cannot bet on this window, or ''. */
  blocked(w: Win): string {
    if (w.state !== 'open') return 'Bets are closed.';
    if (w.local) return '';
    const g = this.game, t = g.todo;
    if (this.me && w.entrants.some((e) => e.key === humanKey(this.me))) return 'You are in this one, so no betting on it.';
    if (w.kind === 'race' ? t.racing.phase !== 'idle' : t.derby.phase !== 'idle') return 'You are in a race or a derby yourself, so no betting.';
    return '';
  }

  /** Put a stake on a driver. Returns '' or what is wrong, in words for the slip. */
  place(id: string, key: string, stake: number): string {
    const w = this.wins.get(id), g = this.game;
    if (!w || w.state !== 'open') return 'Bets on that are closed.';
    const why = this.blocked(w);
    if (why) return why;
    if (w.bet) return 'You already have a bet on this one. Take it back to change it.';
    if (w.entrants.length < 2) return 'Wait for at least two drivers to be in.';
    const en = w.entrants.find((e) => e.key === key);
    if (!en) return 'Pick a driver first.';
    stake = Math.floor(stake);
    if (!(stake >= BET_MIN && stake <= BET_MAX)) return `Stakes run from ${money(BET_MIN)} to ${money(BET_MAX)}.`;
    if (g.player.money < stake) return `You have ${money(Math.max(0, g.player.money))}.`;
    const m = this.multOf(w, key);
    g.player.money -= stake; save.credit(-stake);
    w.bet = { pick: key, name: en.name, tag: en.tag, stake, mult: m };
    this.hold(stake);
    save.data.best['bt.n'] = (save.data.best['bt.n'] ?? 0) + 1;
    this.stats.placed++;
    this.rev++;
    this.toast(`Bet placed: ${money(stake)} on ${en.tag ? en.tag + ' ' : ''}${en.name} at ${mult(m)}. Pays ${money(returns(stake, m))} if they win.`, 5);
    return '';
  }

  /** The multiple a driver pays in this window's field. */
  multOf(w: Win, key: string): number {
    const ms = odds(w.entrants.map((e) => e.w));
    const i = w.entrants.findIndex((e) => e.key === key);
    return i < 0 ? 0 : ms[i];
  }

  /** Take the bet back before the start. */
  withdraw(id: string): void {
    const w = this.wins.get(id);
    if (!w || !w.bet || w.state !== 'open') return;
    this.refund(w, 'You took your bet back.');
  }

  private hold(d: number): void { save.data.best['bt.hold'] = Math.max(0, Math.floor((save.data.best['bt.hold'] ?? 0) + d)); }

  private refund(w: Win, why: string): void {
    const b = w.bet;
    if (!b) return;
    const g = this.game;
    g.player.money += b.stake; save.credit(b.stake);
    this.hold(-b.stake);
    w.bet = null;
    w.result = `${why} ${money(b.stake)} is back.`;
    this.stats.refunded++;
    this.rev++;
    this.toast(`${why} Your ${money(b.stake)} is back.`, 5);
  }

  private pay(w: Win, winner: string): void {
    const b = w.bet;
    if (!b) { w.result = ''; return; }
    const g = this.game, best = save.data.best;
    this.hold(-b.stake);
    if (b.pick === winner) {
      const back = returns(b.stake, b.mult), profit = back - b.stake;
      g.player.money += back; save.credit(back); save.data.stats.earned += Math.max(0, profit);
      best['bt.won'] = (best['bt.won'] ?? 0) + profit;
      this.stats.won++;
      w.result = `${b.name} won. You are paid ${money(back)} (${money(profit)} over your ${money(b.stake)}).`;
      this.toast(`${b.name} won! You backed them: ${money(back)} paid out, ${money(profit)} up on your ${money(b.stake)}.`, 7);
    } else {
      best['bt.lost'] = (best['bt.lost'] ?? 0) + b.stake;
      this.stats.lost++;
      const wn = w.entrants.find((e) => e.key === winner)?.name ?? 'Somebody else';
      w.result = `${wn} won. Your ${money(b.stake)} on ${b.name} is gone.`;
      this.toast(`${wn} won. Your ${money(b.stake)} on ${b.name} did not come in. Better luck next time.`, 6);
    }
    this.rev++;
  }

  private settle(w: Win, winner: string | null): void {
    if (w.state === 'settled' || w.state === 'void') return;
    if (!winner) { this.voidWin(w, 'Nobody finished, so it is off.'); return; }
    w.state = 'settled'; w.settledAt = this.clk;
    this.pay(w, winner);
    this.rev++;
  }

  private voidWin(w: Win, why: string): void {
    if (w.state === 'settled' || w.state === 'void') return;
    w.state = 'void'; w.settledAt = this.clk;
    if (w.bet) this.refund(w, why); else w.result = '';
    this.rev++;
  }

  // ── The race and the derby tell us (game/race.ts, game/derby.ts: every frame a browser sees, spectator or not) ──

  private open(id: string, kind: BetKind, title: string, caller: number, local: boolean, until: number): Win {
    let w = this.wins.get(id);
    if (!w || w.state === 'settled' || w.state === 'void') {
      w = { id, kind, title, caller, local, state: 'open', until, goAt: 0, settledAt: 0, firstDone: 0, entrants: [], bet: null, result: '', fin: new Map() };
      this.wins.set(id, w);
      this.stats.opened++;
      if (!local) {
        const free = kind === 'race' ? this.game.todo.racing.phase === 'idle' : this.game.todo.derby.phase === 'idle';
        if (free) this.toast(`Bets are open on ${title}. Press Z (or tap the BETS tag) to back a driver. Play money only.`, 7);
      }
    }
    w.until = until;
    this.rev++;
    return w;
  }

  /** Refresh a window's field from a Call frame, keeping each bet's odds as they were when it was placed. */
  private field(w: Win, list: { key: string; name: string; tag: string; holder: boolean }[]): void {
    const before = w.entrants;
    w.entrants = list.map((e) => ({ key: e.key, name: e.name, tag: e.tag, w: e.holder ? HOLDER_W : 1 }));
    if (w.bet && !w.entrants.some((e) => e.key === w.bet!.pick)) this.refund(w, `${w.bet.name} dropped out.`);
    if (before.length !== w.entrants.length) this.rev++;
  }

  raceCall(caller: number, title: string, ids: number[], names: string[], secs: number, holder: string): void {
    const w = this.open(`race:${caller}`, 'race', title, caller, false, this.clk + secs * 1000);
    if (w.state !== 'open') return;
    this.field(w, ids.map((id, i) => ({ key: humanKey(id), name: names[i], tag: '', holder: names[i] === holder })));
  }
  raceGo(caller: number, ids: number[], names: string[]): void {
    const w = this.wins.get(`race:${caller}`);
    if (!w || w.state !== 'open') return;
    w.entrants = ids.map((id, i) => ({ key: humanKey(id), name: names[i], tag: '', w: w.entrants.find((e) => e.key === humanKey(id))?.w ?? 1 }));
    if (w.bet && !w.entrants.some((e) => e.key === w.bet!.pick)) { this.refund(w, `${w.bet.name} is not on the grid.`); }
    w.state = 'closed'; w.goAt = this.clk; this.rev++;
  }
  raceDone(caller: number, id: number, how: number, ms: number): void {
    const w = this.wins.get(`race:${caller}`);
    if (!w || w.state !== 'closed') return;
    const k = humanKey(id);
    if (!w.entrants.some((e) => e.key === k) || w.fin.has(k)) return;
    w.fin.set(k, { how, ms });
    if (how === 1 && !w.firstDone) w.firstDone = this.clk;
    this.raceCheck(w);
  }
  private raceCheck(w: Win): void {
    if (w.entrants.every((e) => w.fin.has(e.key))) this.settle(w, this.raceWinner(w));
  }
  private raceWinner(w: Win): string | null {
    let best: string | null = null, bt = Infinity;
    for (const [k, f] of w.fin) if (f.how === 1 && f.ms > 0 && f.ms < bt) { bt = f.ms; best = k; }
    return best;
  }
  raceOff(caller: number): void { const w = this.wins.get(`race:${caller}`); if (w && w.state === 'open') this.voidWin(w, 'The race was called off.'); }

  derbyCall(caller: number, ids: number[], names: string[], secs: number, holder: string): void {
    const w = this.open(`derby:${caller}`, 'derby', 'the demolition derby', caller, false, this.clk + secs * 1000);
    if (w.state !== 'open') return;
    this.field(w, ids.map((id, i) => ({ key: humanKey(id), name: names[i], tag: '', holder: names[i] === holder })));
  }
  derbyGo(caller: number, ids: number[], ai: number, seed: number, names: string[]): void {
    const w = this.wins.get(`derby:${caller}`);
    if (!w || w.state !== 'open') return;
    const f = derbyField(ids, ai, seed);
    const prev = w.entrants;
    w.entrants = f.map((e, i) => ({
      key: e.id >= 200 ? aiKey(e.id - 200) : humanKey(e.id), name: e.id >= 200 ? e.name : names[i], tag: `#${e.num}`,
      w: prev.find((p) => p.key === humanKey(e.id))?.w ?? 1,
    }));
    if (w.bet && !w.entrants.some((e) => e.key === w.bet!.pick)) this.refund(w, `${w.bet.name} is not in the derby.`);
    w.until = this.clk + DERBY_COUNT_MS; w.goAt = this.clk; this.rev++;
  }
  /** The derby's order is in: the winner's id. Caller -1 is the derby of locals this browser put on. */
  derbyEnd(caller: number, winnerId: number): void {
    const w = this.wins.get(caller < 0 ? 'derby:local' : `derby:${caller}`);
    if (!w || (w.state !== 'closed' && w.state !== 'open')) return;
    w.state = 'closed';
    this.settle(w, keyOfDerbyId(winnerId));
  }
  derbyOff(caller: number): void { const w = this.wins.get(`derby:${caller}`); if (w && (w.state === 'open' || w.state === 'closed')) this.voidWin(w, 'The derby was called off.'); }

  /** Flounder Field, a derby with no player in it: a window with the whole field known up front. */
  openLocalDerby(seed: number, ai: number): Win {
    const f = derbyField([], ai, seed);
    const w = this.open('derby:local', 'derby', 'a derby of eight locals', 0, true, this.clk + LOCAL_WINDOW_S * 1000);
    w.entrants = f.map((e) => ({ key: aiKey(e.id - 200), name: e.name, tag: `#${e.num}`, w: 1 }));
    w.until = this.clk + LOCAL_WINDOW_S * 1000;
    this.rev++;
    this.show?.();
    return w;
  }
  /** The exhibition has started: bets are closed. */
  closeLocal(): void { const w = this.wins.get('derby:local'); if (w && w.state === 'open') { w.state = 'closed'; w.goAt = this.clk; this.rev++; } }
  voidLocal(why: string): void { const w = this.wins.get('derby:local'); if (w) this.voidWin(w, why); }
  localSecs(): number { return LOCAL_WINDOW_S; }

  /** A player left town: their windows are off, they drop from any field. */
  dropped(id: number): void {
    const k = humanKey(id);
    for (const w of this.wins.values()) {
      if (w.local) continue;
      if (w.caller === id && w.state === 'open') { this.voidWin(w, 'The caller left town, so it is off.'); continue; }
      if (w.caller === id && w.state === 'closed' && w.kind === 'derby') { this.voidWin(w, 'The derby\'s caller left town, so it is off.'); continue; }
      if (w.state === 'open') { const n = w.entrants.length; w.entrants = w.entrants.filter((e) => e.key !== k); if (n !== w.entrants.length) { this.rev++; if (w.bet?.pick === k) this.refund(w, `${w.bet.name} left town.`); } }
      else if (w.state === 'closed' && w.kind === 'race' && w.entrants.some((e) => e.key === k) && !w.fin.has(k)) { w.fin.set(k, { how: 2, ms: 0 }); this.raceCheck(w); }
    }
  }

  /** Off the network: every town window is off (the stake comes back). */
  offline(): void { for (const w of this.wins.values()) if (!w.local) this.voidWin(w, 'You went offline, so it is off.'); }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.clk += Math.min(dt, 0.25) * 1000;
    const now = this.clk;
    for (const [id, w] of this.wins) {
      if (w.state === 'settled' || w.state === 'void') { if (now - w.settledAt > KEEP_MS && !this.panelOpen) { this.wins.delete(id); this.rev++; } continue; }
      if (w.state === 'open') {
        if (w.bet && !w.local && this.blocked(w)) { this.refund(w, 'You joined in yourself.'); continue; }
        if (!w.local && w.goAt === 0 && now > w.until + GO_GRACE_MS) { this.voidWin(w, 'It never started.'); continue; }
        if (w.goAt && now > w.until && w.kind === 'derby') { w.state = 'closed'; this.rev++; }
        if (w.local && now > w.until + GO_GRACE_MS) { this.voidWin(w, 'The derby never started.'); continue; }
      } else if (w.state === 'closed') {
        if (w.kind === 'race' && w.firstDone && now - w.firstDone > LATE_MS + 20000) { this.settle(w, this.raceWinner(w)); continue; }
        if (now - w.goAt > RESULT_MS) this.voidWin(w, 'The result never came, so it is off.');
      }
    }
  }

  /** For the tests. */
  info(): Record<string, unknown> {
    return {
      ...this.stats, clk: Math.round(this.clk), hold: save.data.best['bt.hold'] ?? 0, won: save.data.best['bt.won'] ?? 0, lost: save.data.best['bt.lost'] ?? 0, n: save.data.best['bt.n'] ?? 0,
      wins: [...this.wins.values()].map((w) => ({
        id: w.id, kind: w.kind, title: w.title, state: w.state, left: Math.round(w.until - this.clk), local: w.local, result: w.result,
        entrants: w.entrants.map((e) => ({ key: e.key, name: e.name, tag: e.tag, mult: this.multOf(w, e.key) })),
        bet: w.bet, blocked: this.blocked(w),
      })),
    };
  }
}
