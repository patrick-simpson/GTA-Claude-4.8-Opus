// Fun queue 2, item 19: the weekly town calendar. Pure functions of the real date and the shared game clock, so every
// screen in the town works out the same schedule with no message and no fact key (the town clock, sky.hour, is already
// the host's). No imports: tools can run this file under plain node to check the calendar.
//
//   Wednesday   The Regatta           the harbour
//   Friday      Derby Night           Flounder Field
//   Saturday    The Christmas Fair    Mercy Park (the holiday season only)
//   Sunday      The Moose Festival    Quorum Square, Tepid Falls
//
// Days are Maine's (America/New_York), so two screens in different time zones agree. Each event runs in the evening
// of its day, from game hour 17 to 23: the game's day is 24 minutes of real time (1 game hour a minute), so the window
// opens six real minutes after every game midnight and stays open for six.

export type EventId = 'derby' | 'moose' | 'regatta' | 'fair';

/** Sunday is 0, as Date.getDay(). */
export const EVENT_DAY: Record<EventId, number> = { moose: 0, regatta: 3, derby: 5, fair: 6 };
export const EVENT_ORDER: readonly EventId[] = ['regatta', 'derby', 'fair', 'moose'];
export const WINDOW = { from: 17, to: 23 } as const;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let fmt: Intl.DateTimeFormat | null | undefined;
/** Weekday (0 = Sunday) and the seconds left until midnight, in Maine, at a moment (ms since 1970). */
export function maine(ms: number): { wd: number; left: number } {
  if (fmt === undefined) {
    try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }); } catch { fmt = null; }
  }
  if (fmt) {
    let wd = -1, h = 0, m = 0, s = 0;
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type === 'weekday') wd = SHORT.indexOf(p.value);
      else if (p.type === 'hour') h = Number(p.value) % 24;
      else if (p.type === 'minute') m = Number(p.value);
      else if (p.type === 'second') s = Number(p.value);
    }
    if (wd >= 0) return { wd, left: 86400 - (h * 3600 + m * 60 + s) };
  }
  const d = new Date(ms - 5 * 3600000);
  return { wd: d.getUTCDay(), left: 86400 - (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) };
}

const mod24 = (h: number): number => ((h % 24) + 24) % 24;

export interface When {
  /** The window is open now. */
  open: boolean;
  /** Real seconds until it opens (0 when open); null when it is not on the calendar (the fair out of season). */
  opensIn: number | null;
  /** Real seconds until it closes (only while open). */
  closesIn: number;
}

/**
 * When an event runs. ms: now. hour: the town clock (0..24). rate: game hours per real second. season: whether the
 * holiday season is on (the fair only runs in it). Pure.
 */
export function when(id: EventId, ms: number, hour: number, rate: number, season: boolean): When {
  if (id === 'fair' && !season) return { open: false, opensIn: null, closesIn: 0 };
  const r = Math.max(rate, 1e-6), day = EVENT_DAY[id], now = maine(ms);
  const inWin = (h: number): boolean => h >= WINDOW.from && h < WINDOW.to;
  if (now.wd === day && inWin(hour)) return { open: true, opensIn: 0, closesIn: (WINDOW.to - hour) / r };
  if (now.wd === day) {
    const t = mod24(WINDOW.from - hour) / r;
    if (t < now.left) return { open: false, opensIn: t, closesIn: 0 };
  }
  for (let k = 1; k <= 15; k++) {
    const start = now.left + (k - 1) * 86400;
    if (maine(ms + (start + 2) * 1000).wd !== day) continue;
    const h0 = mod24(hour + r * start);
    return { open: false, opensIn: inWin(h0) ? start : start + mod24(WINDOW.from - h0) / r, closesIn: 0 };
  }
  return { open: false, opensIn: null, closesIn: 0 };
}

/** "in 3 days", "in 12 min", "on now". */
export function countdown(w: When): string {
  if (w.open) return `on now, ${Math.max(1, Math.round(w.closesIn / 60))} min left`;
  if (w.opensIn === null) return 'not this season';
  const s = w.opensIn;
  if (s < 90) return `in ${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `in ${Math.round(s / 60)} min`;
  if (s < 172800) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}
