// Fun queue item 15: the town leaderboard. The categories, this player's own bests, and the board shown on the two
// billboards (world/leaderBillboard.ts) and in the pause menu (Stats, Form S-3).
//
// Alone, the board is this player's own personal bests. In a town (net/leaderboard.ts) it is the town's: the top five
// per category, kept as host-written durable facts, the same on every screen; every browser offers the host its own
// best when it beats an entry there, and the host checks it is believable and writes it. Race times come from the
// race records the races already keep (net/race.ts, one per route).
//
// What this file keeps itself, in the save's best table (game/save.ts, which keeps any key it is given):
//   lb.high    the highest a car has climbed above where it left the ground, decimeters
//   lb.money   the most cash ever on hand, dollars
//   lb.busts   the most busts in one round of Hot Pursuit (as the cop)
//   lb.escape  the longest time on the run in one round of Hot Pursuit (as the wanted), seconds
// Everything else is read from what the game already counts (save.ts counts and stats).

import type { Game } from '../core/game';
import { save } from './save';
import { groundAt } from '../world/plan';
import { clock } from './script';
import { money } from '../core/util';
import { LeaderBillboard } from '../world/leaderBillboard';
import { TownBoard } from '../net/leaderboard';
import { presentsFound } from '../world/christmas';
import { FIND_COUNT, findsCatalogued } from '../world/pardonsCatalogue';

const FEET = 3.28084;

export interface Category {
  key: string;
  title: string;
  /** Plausibility ceiling, in the category's units (the host drops anything above). */
  max: number;
  fmt(v: number): string;
}

/** The categories, in this order on the wire (net/leaderboard.ts sends the index): APPEND ONLY. */
export const CATEGORIES: readonly Category[] = [
  { key: 'high', title: 'Highest jump', max: 4000, fmt: (v) => `${Math.round((v / 10) * FEET)} ft` },
  { key: 'air', title: 'Longest airtime', max: 600, fmt: (v) => `${(v / 10).toFixed(1)} s` },
  { key: 'rag', title: 'Longest ragdoll flight', max: 3000, fmt: (v) => `${Math.round(v * FEET)} ft` },
  { key: 'cannon', title: 'Furthest cannon launch', max: 6000, fmt: (v) => `${Math.round(v * FEET)} ft` },
  { key: 'trick', title: 'Best trick score', max: 50_000_000, fmt: (v) => `${v.toLocaleString('en-US')} pts` },
  { key: 'busts', title: 'Most busts in a round', max: 30, fmt: (v) => `${v} bust${v === 1 ? '' : 's'}` },
  { key: 'escape', title: 'Longest escape', max: 3600, fmt: (v) => clock(v) },
  { key: 'derby', title: 'Derby wins', max: 100_000, fmt: (v) => `${v} win${v === 1 ? '' : 's'}` },
  { key: 'rush', title: 'Best delivery rush', max: 1_000_000, fmt: (v) => money(v) },
  { key: 'money', title: 'Most money on hand', max: 1_000_000_000, fmt: (v) => money(v) },
  { key: 'ducks', title: 'Ducks returned', max: 100_000, fmt: (v) => String(v) },
  { key: 'moose', title: 'Moose met', max: 100_000, fmt: (v) => String(v) },
  { key: 'presents', title: 'Presents found', max: 25, fmt: (v) => `${v} of 25` },
  { key: 'taxi', title: 'Best taxi shift', max: 1_000_000, fmt: (v) => money(v) },
  { key: 'finds', title: "Pardon's Finds catalogued", max: FIND_COUNT, fmt: (v) => `${v} of ${FIND_COUNT}` },
];
export const CAT = Object.fromEntries(CATEGORIES.map((c, i) => [c.key, i])) as Record<string, number>;

export interface BoardRow { name: string; v: number; me: boolean }
/** One page of the board: a category, or a race route. `fmt` turns a value into words. */
export interface BoardPage { title: string; rows: BoardRow[]; mine: number | null; fmt(v: number): string; town: boolean }

/** What the network gives the board (net/leaderboard.ts). Absent, or offline: the board is this player's own. */
export interface BoardLink {
  /** In a town, with a welcome: the board is the town's. */
  inTown(): boolean;
  /** The town's top five of a category, best first ([] when nobody has one). */
  top(cat: number): BoardRow[];
  /** The race records the town holds, by route index. */
  race(route: number): { race: number; raceBy: string; lap: number; lapBy: string } | null;
  /** This player's own best in a category has moved: offer it if it would make the town's top five. */
  offer(cat: number, v: number): void;
}

/** This player's own best in each category (null: none filed), in the category's units. */
export function myBest(game: Game, cat: number): number | null {
  const c = save.data.counts, b = save.data.best, st = save.data.stats;
  const pos = (n: number | undefined): number | null => (n !== undefined && n > 0 ? Math.round(n) : null);
  switch (CATEGORIES[cat]?.key) {
    case 'high': return pos(b['lb.high']);
    case 'air': return pos(Math.max(st.airtime * 10, c.trickAir ?? 0));
    case 'rag': return pos(c.ragFar);
    case 'cannon': return pos(c.launchFar);
    case 'trick': return pos(c.trickBest);
    case 'busts': return pos(b['lb.busts']);
    case 'escape': return pos(b['lb.escape']);
    // (The derby, fun queue item 13, counts its wins under one of these, once it exists.)
    case 'derby': return pos(c.derbyWins ?? c.derby ?? b['lb.derby']);
    case 'rush': return pos(b.rush);
    case 'taxi': return pos(b.taxi);
    case 'money': return pos(Math.max(b['lb.money'] ?? 0, game.player ? game.player.money : 0));
    case 'ducks': return pos(c.ducksReturned);
    case 'moose': return pos(c.moose);
    case 'presents': return pos(presentsFound());
    case 'finds': return pos(findsCatalogued());
    default: return null;
  }
}

/** Time a billboard holds a page, seconds. */
const PAGE_S = 6;

export class Leaderboard {
  /** Set by net/leaderboard.ts. */
  link: BoardLink | null = null;
  private net: TownBoard | null = null;
  readonly stats = { jumps: 0, offers: 0, pages: 0 };
  private readonly signs: LeaderBillboard[] = [];
  private airV: unknown = null;
  private airY0 = 0;
  private airPeak = 0;
  private airT = 0;
  private lastY = 0;
  private page = 0;
  private pageT = 0;
  private offerT = 0;
  private podiums = -1;
  private readonly offered: number[] = [];

  constructor(private readonly game: Game) {
    board.current = this;
    try {
      for (const s of signSpots(game)) this.signs.push(new LeaderBillboard(game, s.x, s.z, s.h));
    } catch (e) { console.warn('leaderboard: no billboard', e); }
    // In a town: the wire (net/leaderboard.ts) chains itself onto the Net's connection. No socket, no town: the board is this player's own.
    try { const n = game.net; if (n && n.conn) this.net = new TownBoard(game, n.conn, n.remotes, this); } catch (e) { console.warn('leaderboard: no town board', e); }
    this.draw();
  }

  get inTown(): boolean { return !!this.link && this.link.inTown(); }

  /** Every page, in the billboard's order: the categories, then the race routes. */
  pages(): BoardPage[] {
    const g = this.game, town = this.inTown, out: BoardPage[] = [];
    CATEGORIES.forEach((c, i) => {
      const mine = myBest(g, i);
      const rows = town ? this.link!.top(i) : mine !== null ? [{ name: 'You', v: mine, me: true }] : [];
      out.push({ title: c.title, rows, mine, fmt: c.fmt, town });
    });
    const races = g.todo?.jobs?.races ?? [];
    for (const r of races) {
      const b = save.data.best['race:' + r.name], mine = b !== undefined ? Math.round(b * 1000) : null;
      const rec = town ? this.link!.race(r.idx) : null;
      const rows: BoardRow[] = rec && Number.isFinite(rec.race) ? [{ name: rec.raceBy, v: rec.race, me: false }] : !town && mine !== null ? [{ name: 'You', v: mine, me: true }] : [];
      out.push({ title: `Race: ${r.name}`, rows, mine, fmt: (v) => clock(v / 1000), town });
    }
    return out;
  }

  update(dt: number): void {
    const g = this.game;
    if (g.state === 'play') this.watch(dt);
    this.pageT += dt;
    if (this.pageT >= PAGE_S) {
      this.pageT = 0; this.stats.pages++;
      this.page++;
      this.draw();
    }
    this.offerT -= dt;
    if (this.offerT <= 0) { this.offerT = 1; this.tick(); }
  }

  /** Repaint the billboards' current page (also when the town's board changes). */
  draw(): void {
    if (!this.signs.length) return;
    const all = this.pages();
    // (Pages nobody has filed anything on are skipped on the billboards, unless everything is empty.)
    const shown = all.filter((p) => p.rows.length > 0);
    const list = shown.length ? shown : all;
    const p = list[this.page % list.length];
    for (const s of this.signs) s.paint(p, this.page % list.length, list.length);
  }

  /** Once a second: the money record, Hot Pursuit's last round, and an offer to the town for anything that moved. */
  private tick(): void {
    const g = this.game, b = save.data.best;
    if (g.player && g.player.money > (b['lb.money'] ?? 0) && g.player.money < 1e9) b['lb.money'] = Math.floor(g.player.money);
    const pu = g.todo?.pursuit;
    if (pu) {
      const inf = pu.info() as { podiums?: number; results?: { id: number; cop: boolean; busts: number; ms: number }[] };
      const n = inf.podiums ?? 0;
      if (this.podiums >= 0 && n !== this.podiums) {
        const me = pu.link ? pu.link.me() : 0, row = (inf.results ?? []).find((r) => r.id === me);
        if (row) {
          if (row.cop) save.record('lb.busts', row.busts, false);
          else if (row.ms > 0) save.record('lb.escape', Math.round(row.ms / 1000), false);
        }
      }
      this.podiums = n;
    }
    const l = this.link;
    if (!l || !l.inTown()) return;
    for (let i = 0; i < CATEGORIES.length; i++) {
      const v = myBest(g, i);
      if (v === null || v > CATEGORIES[i].max || this.offered[i] === v) continue;
      const top = l.top(i), myName = top.find((r) => r.me);
      const beats = top.length < 5 ? !myName || v > myName.v : v > top[top.length - 1].v && (!myName || v > myName.v);
      this.offered[i] = v;
      if (beats) { l.offer(i, v); this.stats.offers++; }
    }
  }

  /** The town's board has changed (net/leaderboard.ts): forget what was offered, so a lost write is offered again. */
  changed(): void { this.offered.length = 0; this.draw(); }

  /** The highest a car climbs above where it left the ground. */
  private watch(dt: number): void {
    const v = this.game.player.vehicle;
    if (v !== this.airV) { this.airV = v; this.airT = 0; }
    if (!v || v.sunk || v.spec.kind === 'speedboat' || v.spec.kind === 'jetski') { this.airT = 0; return; }
    if (!v.onGround) {
      if (this.airT === 0) { this.airY0 = Math.max(v.y, groundAt(v.x, v.z)); this.airPeak = v.y; this.lastY = v.y; }
      // (A teleport or a lift by a test is not a jump.)
      if (Math.abs(v.y - this.lastY) > 80 * Math.max(dt, 1 / 60) || this.airT > 40) { this.airT = 41; this.lastY = v.y; return; }
      this.airT += dt; this.lastY = v.y;
      if (v.y > this.airPeak) this.airPeak = v.y;
    } else if (this.airT > 0) {
      const h = this.airPeak - this.airY0;
      if (this.airT <= 40 && this.airT > 0.4 && h > 0.5) {
        this.stats.jumps++;
        if (save.record('lb.high', Math.round(h * 10), false)) this.draw();
      }
      this.airT = 0;
    }
  }

  /** For the tests (window.__game.game.systems: the board, or `board.current`). */
  info(): Record<string, unknown> {
    return {
      ...this.stats, town: this.inTown, net: this.net ? this.net.info() : null, signs: this.signs.length, page: this.signs[0]?.shown ?? '',
      pages: this.pages().map((p) => ({ title: p.title, rows: p.rows.map((r) => `${r.name}=${r.v}${r.me ? '*' : ''}`), mine: p.mine })),
    };
  }
}

/** The one board in the game, for the net and the menu to find. */
export const board: { current: Leaderboard | null } = { current: null };

/** Downtown near the start (the sidewalk the game opens on), and Tepid Falls on Main St. */
function signSpots(game: Game): { x: number; z: number; h: number }[] {
  const plan = game.plan, out: { x: number; z: number; h: number }[] = [];
  out.push(plan.sidewalkPoint(5, 6, 2, 0.9));
  // Tepid Falls: on Main St's east sidewalk. New streets: at the south end of downtown, where the street opens up from
  // Trestle St (Main St's half-width 7 plus half the sidewalk), facing the street.
  if (plan.streets) out.push({ x: 70 + 7 + 1.75, z: -1652, h: -Math.PI / 2 });
  else if (plan.blockAt(39, 40)) out.push(plan.sidewalkPoint(39, 40, 3, 0.5));
  return out;
}

/** The menu's Form S-3 (ui/menu.ts, Stats). */
export function boardHtml(game: Game): string {
  const b = board.current;
  if (!b) return '';
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const pages = b.pages(), town = b.inTown;
  const rows = pages.map((p) => {
    const list = p.rows.length
      ? p.rows.map((r, i) => `<span class="lb-e${r.me ? ' lb-me' : ''}"><i>${i + 1}</i>${esc(r.name)} · ${esc(p.fmt(r.v))}</span>`).join('')
      : '<span class="lb-e lb-none">Nobody on file</span>';
    return `<div class="lb-row"><b>${esc(p.title)}</b><span class="lb-list">${list}</span><em>${p.mine !== null ? `yours: ${esc(p.fmt(p.mine))}` : 'yours: none filed'}</em></div>`;
  }).join('');
  void game;
  return `<div class="mn-sec lb-sec"><style>${LB_CSS}</style>
    <h3>Form S-3 · ${town ? 'Town leaderboard (top five, the same on every screen)' : 'Leaderboard (your own bests; in a town, the town\'s)'}</h3>
    ${rows}
  </div>`;
}

const LB_CSS = `
.lb-sec { grid-column: 1 / -1; }
.lb-row { display: grid; grid-template-columns: minmax(9em, 14em) minmax(0, 1fr) auto; gap: 0.3em 0.8em; align-items: baseline; padding: 0.35em 0; border-bottom: 1px dashed currentColor; }
.lb-row b { font-family: var(--f-head); font-weight: 700; letter-spacing: 0.02em; }
.lb-list { display: flex; flex-wrap: wrap; gap: 0.25em 0.9em; font-family: var(--f-mono); font-size: 0.78em; }
.lb-e i { font-style: normal; opacity: 0.6; margin-right: 0.35em; }
.lb-me { color: #e4572e; font-weight: 600; }
.lb-none { opacity: 0.55; }
.lb-row em { font-style: normal; font-size: 0.72em; opacity: 0.75; text-align: right; }
@media (max-width: 720px) { .lb-row { grid-template-columns: minmax(0, 1fr) auto; } .lb-list { grid-column: 1 / -1; grid-row: 2; } }
`;
