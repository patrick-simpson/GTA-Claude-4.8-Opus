// The time of year. One small piece of state everybody reads: the sky (snow in the weather rotation, rain that falls
// as snow), the trees (floraAssets.ts: autumn colours, bare in winter), the falling leaves (fx/snow.ts).
//
// By default it is the real date, Maine's version of it: autumn from 10 September (October is the peak of the
// foliage), winter from 20 November to 25 March, and the rest of the year is the game as it always was ("summer").
// The settings menu can pin one (save.ts `season`), and ?season=autumn|winter|summer pins one for a test (and, item 34,
// ?season=mud|fall too: see Phase below, the look of the year inside those three).
//
// Multiplayer (owner, Nov 24: "the season should always sync across players"): in a town the season is the town's
// (net/townSeason.ts, the fact FACT_SEASON, written by the host). The menu's pick goes to the town, and Auto is the
// HOST's calendar, written in the fact, so two screens in different time zones never disagree. Alone, it is this
// browser's own pick (save.ts) and its own calendar, as before. ?season= stays this screen's, for tests.

export type Season = 'summer' | 'autumn' | 'winter';
export type SeasonPick = 'auto' | Season;
/**
 * Fun queue 2, item 34: the look of the year inside those three. The town's fact still carries only the three, so a phase is
 * worked out from the SAME season plus the calendar (no new fact key): 'summer' splits into mud season (26 March to 30 April, the
 * ground thawing), a plain spring (May to 19 June) and high summer (20 June on, tourists), and 'autumn' is 'fall'. A season
 * somebody picked (the menu, the town) keeps its full look: summer is high summer. ?season=mud|summer|fall|winter forces one.
 */
export type Phase = 'mud' | 'spring' | 'summer' | 'fall' | 'winter';

/** The phase of a calendar date, given the season that date is in (seasonOf). */
export function phaseOf(d: Date, s: Season = seasonOf(d)): Phase {
  if (s === 'winter') return 'winter';
  if (s === 'autumn') return 'fall';
  const md = d.getMonth() * 100 + d.getDate();
  if (md <= 330) return 'mud';
  if (md <= 519) return 'spring';
  return 'summer';
}

/** 0..1 how much old snow is left in mud season: the banks melting in the first two weeks (26 March + 14 days). */
export function mudSnowOf(d: Date): number {
  const days = (d.getTime() - new Date(d.getFullYear(), 2, 26).getTime()) / 86400000;
  return days < 0 || days >= 14 ? 0 : 1 - days / 14;
}

/** The season of a calendar date. */
export function seasonOf(d: Date): Season {
  const m = d.getMonth(), day = d.getDate();
  const md = m * 100 + day; // 0-based month: 10 Sep is 810, 20 Nov is 1020, 25 Mar is 225
  if (md >= 1020 || md <= 225) return 'winter';
  if (md >= 810) return 'autumn';
  return 'summer';
}

/** ?season=mud|summer|fall|autumn|winter: the phase this screen is pinned to (tests), or null. */
const urlPhase = ((): Phase | null => {
  try {
    const s = new URLSearchParams(location.search).get('season');
    return s === 'mud' || s === 'summer' || s === 'winter' ? s : s === 'fall' || s === 'autumn' ? 'fall' : null;
  } catch { return null; }
})();
/** ?mudsnow=0..1 with ?season=mud: how much old snow is left (default 0.3: bare brown mud; 0.5+ is the first days, with grey banks). */
const urlMudSnow = ((): number => {
  try { const v = parseFloat(new URLSearchParams(location.search).get('mudsnow') ?? ''); return v >= 0 && v <= 1 ? v : 0.3; } catch { return 0.3; }
})();
const urlPick: Season | null = urlPhase === null ? null : urlPhase === 'fall' ? 'autumn' : urlPhase === 'winter' ? 'winter' : 'summer';

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
  private autoPhase: Phase = phaseOf(new Date());
  private autoMud = mudSnowOf(new Date());
  private phaseChecked = 0;
  private refresh(): void {
    const t = Date.now();
    if (t - this.phaseChecked < 60000) return;
    this.phaseChecked = t;
    const d = new Date(t);
    this.autoPhase = phaseOf(d); this.autoMud = mudSnowOf(d);
  }
  /**
   * The look of the year now (item 34). Follows `now` (the town's season, so everybody sees winter or autumn together), and
   * inside 'summer' picks mud season, spring or high summer by this browser's calendar, unless the season was picked by hand.
   */
  get phase(): Phase {
    if (urlPhase) return urlPhase;
    const s = this.now;
    if (s === 'autumn') return 'fall';
    if (s === 'winter') return 'winter';
    if ((this.town ? this.town.pick : this.pick) !== 'auto') return 'summer';
    this.refresh();
    // The host's calendar said summer; this one may be a few hours into another season: then it is plain summer.
    return this.autoPhase === 'mud' || this.autoPhase === 'spring' || this.autoPhase === 'summer' ? this.autoPhase : 'summer';
  }
  /** 0..1 old snow still lying in the first fortnight of mud season (?season=mud: 0.3, ?mudsnow= sets it). */
  get mudSnow(): number {
    if (urlPhase) return urlPhase === 'mud' ? urlMudSnow : 0;
    this.refresh();
    return this.phase === 'mud' ? this.autoMud : 0;
  }
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
