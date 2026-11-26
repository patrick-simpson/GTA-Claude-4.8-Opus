// Fun queue 2, item 48: the daily Town Notice, as data and pure functions (no imports, so a test can run it in plain node).
//
// Every real day in Maine the Town Notice posts three quick challenges, picked from a pool of 32 with a day-number shuffle
// (the same pattern as the photo challenges), so every screen asks for the same three with nothing sent. Only challenges
// that are possible right now are picked (no snow work without snow, no ferry without a ferry, a photo subject only when it
// is on today's photo list). Each is about five to ten minutes of play.
//
// A challenge counts from a SOURCE: a number that only ever goes up (a stat in the save, a count, or one of the notice's
// own counters 'nt.k.*' kept in the best table). Its progress is the source now minus the source when it was posted.

export type Level = 'easy' | 'medium';

export interface Challenge {
  id: string;
  /** Two challenges from one group never share a day. */
  grp: string;
  level: Level;
  /** The line on the notice. */
  text: string;
  /** How much of the source it asks for. */
  goal: number;
  /** Where the number comes from: 'stat:x' (save.stats), 'cnt:x' (save.counts), 'k:x' (a notice counter in the best table). */
  src: string;
  /** What has to be true for it to be possible (see Notice.gate). */
  need?: string;
  /** The unit shown beside the numbers; 'm' goals show kilometres. */
  unit?: 'm' | '$';
}

export const POOL: readonly Challenge[] = [
  { id: 'parcel2', grp: 'deliver', level: 'easy', text: 'Deliver 2 parcels', goal: 2, src: 'stat:parcels' },
  { id: 'parcel4', grp: 'deliver', level: 'medium', text: 'Deliver 4 parcels', goal: 4, src: 'stat:parcels' },
  { id: 'taxi2', grp: 'taxi', level: 'easy', text: 'Carry 2 taxi fares', goal: 2, src: 'stat:fares' },
  { id: 'taxi4', grp: 'taxi', level: 'medium', text: 'Carry 4 taxi fares', goal: 4, src: 'stat:fares' },
  { id: 'fish1', grp: 'fish', level: 'easy', text: 'Catch a fish', goal: 1, src: 'k:catch', need: 'fish' },
  { id: 'fish3', grp: 'fish', level: 'medium', text: 'Catch 3 fish', goal: 3, src: 'k:catch', need: 'fish' },
  { id: 'fish3lb', grp: 'fish', level: 'medium', text: 'Catch a fish over 3 lb', goal: 1, src: 'k:fish3', need: 'fish' },
  { id: 'jump30', grp: 'jump', level: 'medium', text: 'Land a stunt jump of 30 m', goal: 1, src: 'k:jump30' },
  { id: 'race1', grp: 'race', level: 'medium', text: 'Finish a street race', goal: 1, src: 'stat:races' },
  { id: 'escape', grp: 'police', level: 'medium', text: 'Escape the police once', goal: 1, src: 'k:escape' },
  { id: 'finds2', grp: 'finds', level: 'easy', text: 'Find 2 lost ducks or bond receipts', goal: 2, src: 'cnt:fd.found', need: 'finds' },
  { id: 'finds4', grp: 'finds', level: 'medium', text: 'Find 4 lost ducks or bond receipts', goal: 4, src: 'cnt:fd.found', need: 'finds' },
  { id: 'shot-train', grp: 'photo', level: 'easy', text: 'Take a photo of the Budget Line train', goal: 1, src: 'k:shot.train', need: 'shot:train' },
  { id: 'shot-bridge', grp: 'photo', level: 'easy', text: 'Take a photo of the Perpetual Bridge', goal: 1, src: 'k:shot.bridge', need: 'shot:bridge' },
  { id: 'shot-ferry', grp: 'photo', level: 'easy', text: 'Take a photo of a ferry', goal: 1, src: 'k:shot.ferry', need: 'shot:ferry' },
  { id: 'shot-gull', grp: 'photo', level: 'easy', text: 'Take a photo of a gull', goal: 1, src: 'k:shot.gull', need: 'shot:gull' },
  { id: 'shots3', grp: 'photo', level: 'easy', text: 'Take 3 photos in photo mode (O)', goal: 3, src: 'cnt:ph.shots' },
  { id: 'dash5', grp: 'drive', level: 'medium', text: 'Drive 5 km in the dashboard view', goal: 5000, src: 'k:dash', unit: 'm' },
  { id: 'drive4', grp: 'drive', level: 'easy', text: 'Drive 4 km', goal: 4000, src: 'stat:driven', unit: 'm' },
  { id: 'speed', grp: 'drive', level: 'medium', text: 'Top 75 mph in a vehicle', goal: 1, src: 'k:fast' },
  { id: 'walk1', grp: 'drive', level: 'easy', text: 'Walk 1 km on foot', goal: 1000, src: 'stat:walked', unit: 'm' },
  { id: 'ferry', grp: 'ride', level: 'easy', text: 'Ride the ferry', goal: 1, src: 'k:rideFerry', need: 'ferry' },
  { id: 'bus', grp: 'ride', level: 'easy', text: 'Ride a Harbor Line bus', goal: 1, src: 'k:rideBus', need: 'bus' },
  { id: 'train', grp: 'ride', level: 'easy', text: 'Ride the Budget Line train', goal: 1, src: 'k:rideTrain', need: 'rail' },
  { id: 'pie', grp: 'eat', level: 'easy', text: 'Order pie at the Side Door Diner', goal: 1, src: 'k:pie', need: 'diner' },
  { id: 'book', grp: 'lib', level: 'easy', text: 'Borrow a book at the Overdue Library', goal: 1, src: 'k:book', need: 'library' },
  { id: 'snowfight', grp: 'snow', level: 'medium', text: 'Win a snowball fight', goal: 1, src: 'cnt:sf.win', need: 'snowfield' },
  { id: 'plow', grp: 'snow', level: 'medium', text: 'Plow or salt a street', goal: 1, src: 'k:plow', need: 'snow' },
  { id: 'earn500', grp: 'earn', level: 'medium', text: 'Earn $500 from jobs', goal: 500, src: 'stat:earned', unit: '$' },
  { id: 'earn250', grp: 'earn', level: 'easy', text: 'Earn $250 from jobs', goal: 250, src: 'stat:earned', unit: '$' },
  { id: 'folk3', grp: 'folk', level: 'easy', text: 'Say hello to 3 named townsfolk', goal: 3, src: 'folk', need: 'folk' },
];

/** The reward for all three: $300, and $50 more for each day of the streak after the first, up to day 7. */
export const REWARD = { base: 300, perDay: 50, cap: 7 } as const;
export function rewardFor(streak: number): number {
  return REWARD.base + REWARD.perDay * (Math.max(1, Math.min(streak, REWARD.cap)) - 1);
}

/** Maine's calendar day (America/New_York) at a moment, as days since 1970: the day the notice changes on, the same for every player. */
let fmt: Intl.DateTimeFormat | null | undefined;
export function maineDay(ms: number): number {
  if (fmt === undefined) {
    try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' }); } catch { fmt = null; }
  }
  if (fmt) {
    let y = 0, m = 0, d = 0;
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type === 'year') y = Number(p.value); else if (p.type === 'month') m = Number(p.value); else if (p.type === 'day') d = Number(p.value);
    }
    if (y > 0) return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  return Math.floor((ms - 5 * 3600000) / 86400000);
}

/** Seconds left of the Maine day. */
export function secondsLeft(ms: number): number {
  const d = maineDay(ms);
  // Midnight in Maine is 4 or 5 hours after midnight UTC: find it by bisection on the day number.
  let lo = ms, hi = ms + 26 * 3600000;
  while (hi - lo > 1000) { const mid = (lo + hi) / 2; if (maineDay(mid) === d) lo = mid; else hi = mid; }
  return Math.max(0, Math.round((hi - ms) / 1000));
}

/**
 * Three ids for a day from the ones possible right now: a day-number shuffle, then one easy, one medium and one more, never
 * two from one group. Deterministic: the same day and the same possible set give the same three everywhere.
 */
export function pickThree(day: number, ok: readonly string[]): string[] {
  const list = POOL.filter((c) => ok.includes(c.id));
  let s = (day * 2654435761) >>> 0;
  const rnd = (): number => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; };
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  const out: Challenge[] = [];
  const take = (f: (c: Challenge) => boolean): void => { const c = list.find((q) => !out.includes(q) && !out.some((o) => o.grp === q.grp) && f(q)); if (c) out.push(c); };
  take((c) => c.level === 'easy');
  take((c) => c.level === 'medium');
  take(() => true);
  take(() => true);
  return out.slice(0, 3).map((c) => c.id);
}
