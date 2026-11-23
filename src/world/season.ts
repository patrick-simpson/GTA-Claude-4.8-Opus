// The time of year. One small piece of state everybody reads: the sky (snow in the weather rotation, rain that falls
// as snow), the trees (floraAssets.ts: autumn colours, bare in winter), the falling leaves (fx/snow.ts).
//
// By default it is the real date, Maine's version of it: autumn from 10 September (October is the peak of the
// foliage), winter from 20 November to 25 March, and the rest of the year is the game as it always was ("summer").
// The settings menu can pin one (save.ts `season`), and ?season=autumn|winter|summer pins one for a test.
//
// Multiplayer: nothing is sent. Every screen in a town works the season out from its own calendar, which is the
// same calendar to within a time zone, and the town's weather already comes from the host (net/town.ts): a host
// "rain" falls as snow on every screen in winter. A season pinned in the menu is this screen's alone. (If the host
// ever has to set the season for everybody, the one field to add is a season index in FACT_WEATHER_SEED.)

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
  /** What the settings menu says. */
  pick: SeasonPick = 'auto';
  private auto: Season = seasonOf(new Date());
  private checked = 0;

  get now(): Season {
    if (urlPick) return urlPick;
    if (this.pick !== 'auto') return this.pick;
    // A game left running over midnight on the last day of autumn.
    const t = Date.now();
    if (t - this.checked > 60000) { this.checked = t; this.auto = seasonOf(new Date(t)); }
    return this.auto;
  }
  get pinnedByUrl(): boolean { return urlPick !== null; }
}

export const season = new SeasonState();
