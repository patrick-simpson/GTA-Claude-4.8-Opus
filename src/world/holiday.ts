// The holiday season (fun queue item 17, the Christmas update): on by the calendar from 22 November to 6 January, or
// pinned by the settings menu ("Holiday decorations: Auto / On / Off", kept in this browser's localStorage under
// pc.holiday so the save format is untouched). ?xmas=1 or ?xmas=0 pins it for a test.
//
// Multiplayer: in a town the pick is the town's and Auto is the host's calendar (net/townSeason.ts, FACT_SEASON), as
// world/season.ts does; alone it is this browser's own. ?xmas= stays this screen's, for tests.

export type HolidayPick = 'auto' | 'on' | 'off';

/** Late November to early January. */
export function holidayOf(d: Date): boolean {
  const m = d.getMonth(), day = d.getDate();
  return (m === 10 && day >= 22) || m === 11 || (m === 0 && day <= 6);
}

const KEY = 'pc.holiday';
const urlPick = ((): boolean | null => {
  try {
    const s = new URLSearchParams(location.search).get('xmas');
    return s === '1' || s === 'on' ? true : s === '0' || s === 'off' ? false : null;
  } catch { return null; }
})();

class HolidayState {
  private _pick: HolidayPick = 'auto';
  /** The town's pick and the host's Auto, while in a town (net/townSeason.ts); null alone. */
  town: { pick: HolidayPick; auto: boolean } | null = null;
  /** Set by net/townSeason.ts while in a town: a menu pick goes to the town. */
  ask: ((pick: HolidayPick) => boolean) | null = null;
  private auto = holidayOf(new Date());
  private checked = 0;

  constructor() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'on' || v === 'off') this._pick = v;
    } catch { /* storage blocked: auto */ }
  }

  get pick(): HolidayPick { return this._pick; }
  set pick(v: HolidayPick) {
    this._pick = v;
    try { if (v === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* not kept */ }
  }

  /** What the menu shows as chosen: the town's pick in a town, else this browser's. */
  get shown(): HolidayPick { return this.town ? this.town.pick : this._pick; }
  /** This browser's own calendar, for the host to write into the town's fact. */
  get local(): boolean { return holidayOf(new Date()); }

  /** The menu at this keyboard: kept as this browser's own, and sent to the town if in one. */
  choose(v: HolidayPick): void {
    this.pick = v;
    this.ask?.(v);
  }

  get on(): boolean {
    if (urlPick !== null) return urlPick;
    const tw = this.town;
    if (tw) return tw.pick !== 'auto' ? tw.pick === 'on' : tw.auto;
    if (this._pick !== 'auto') return this._pick === 'on';
    const t = Date.now();
    if (t - this.checked > 60000) { this.checked = t; this.auto = holidayOf(new Date(t)); }
    return this.auto;
  }
}

export const holiday = new HolidayState();
