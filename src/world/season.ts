// The time of year. One small piece of state everybody reads: the sky (snow in the weather rotation, rain that falls
// as snow), the trees (floraAssets.ts: autumn colours, bare in winter), the falling leaves (fx/snow.ts).
//
// By default it is the real date, Maine's version of it: autumn from 10 September (October is the peak of the
// foliage), winter from 20 November to 25 March, and the rest of the year is the game as it always was ("summer").
// The settings menu can pin one (save.ts `season`), and ?season=autumn|winter|summer pins one for a test.
//
// Multiplayer (owner, Nov 24: "the season should always sync across players"): in a town the season is the town's
// (net/townSeason.ts, the fact FACT_SEASON, written by the host). The menu's pick goes to the town, and Auto is the
// HOST's calendar, written in the fact, so two screens in different time zones never disagree. Alone, it is this
// browser's own pick (save.ts) and its own calendar, as before. ?season= stays this screen's, for tests.

export type Season = 'summer' | 'autumn' | 'winter';
export type SeasonPick = 'auto' | Season;

/** The season of a calendar date. */
export function seasonOf(d: Date): Season {
  const m = d.getMonth(), day = d.getDate();
  const md = m * 100 + day; // 0-based month: 10 Sep is 810, 20 Nov is 1020, 25 Mar is 225
  if (md >= 1020 || md <= 225) return 'winter';
  if (md >= 810) return 'autumn';
  return 'summer';
}

const urlPick = ((): Season | null => {
  try {
    const s = new URLSearchParams(location.search).get('season');
    return s === 'autumn' || s === 'winter' || s === 'summer' ? s : null;
  } catch { return null; }
})();

class SeasonState {
  /** This browser's own pick (save.ts `season`): what it is alone. */
  pick: SeasonPick = 'auto';
  /** The town's pick and the host's Auto, while in a town (net/townSeason.ts); null alone. */
  town: { pick: SeasonPick; auto: Season } | null = null;
  /** Set by net/townSeason.ts while in a town: a menu pick goes to the town. True when it took it. */
  ask: ((pick: SeasonPick) => boolean) | null = null;
  private auto: Season = seasonOf(new Date());
  private checked = 0;

  get now(): Season {
    if (urlPick) return urlPick;
    const tw = this.town;
    if (tw) return tw.pick !== 'auto' ? tw.pick : tw.auto;
    if (this.pick !== 'auto') return this.pick;
    // A game left running over midnight on the last day of autumn.
    const t = Date.now();
    if (t - this.checked > 60000) { this.checked = t; this.auto = seasonOf(new Date(t)); }
    return this.auto;
  }
  get pinnedByUrl(): boolean { return urlPick !== null; }
  /** What the menu shows as chosen: the town's pick in a town, else this browser's. */
  get shown(): SeasonPick { return this.town ? this.town.pick : this.pick; }
  /** This browser's own Auto (its calendar), for the host to write into the town's fact. */
  get local(): Season { return seasonOf(new Date()); }

  /** The menu at this keyboard: kept as this browser's own, and sent to the town if in one. */
  choose(pick: SeasonPick): void {
    this.pick = pick;
    this.ask?.(pick);
  }
}

export const season = new SeasonState();
