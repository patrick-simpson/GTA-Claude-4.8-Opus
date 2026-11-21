// The daily budget of the Cloudflare BACKUP service. Every number that decides when multiplayer
// pauses is in this file. No Cloudflare types: it is plain arithmetic, and the tests import it.
//
// Why it exists (owner, Nov 21 2026): the free limits belong to the whole Cloudflare account, which
// also runs a more important service. The game may use at most HALF of any daily free limit, and
// must stop itself WELL BEFORE that, until the limits reset at 00:00 UTC.

/**
 * Workers Free plan, per day, per ACCOUNT. Read on Nov 21 2026 from
 *   https://developers.cloudflare.com/durable-objects/platform/pricing/   (requests, duration, SQLite rows)
 *   https://developers.cloudflare.com/workers/platform/limits/           (Worker requests; "resetting at midnight UTC")
 * Past a limit, "further operations of that type fail with an error" until the reset.
 */
export const FREE_PLAN_PER_DAY = {
  /** Requests to Workers (every HTTP request to the Worker, refused ones included). */
  workerRequests: 100_000,
  /** Requests to Durable Objects: each fetch from the Worker, each alarm, and incoming WebSocket messages at 20 to 1. */
  doRequests: 100_000,
  /** Durable Object duration, GB-s: wall time while the object is active (or cannot hibernate), at 128 MB. */
  doGbSeconds: 13_000,
  /** SQLite rows written (setAlarm counts as one). */
  rowsWritten: 100_000,
  /** SQLite rows read. */
  rowsRead: 5_000_000,
} as const;
export type Meter = keyof typeof FREE_PLAN_PER_DAY;
export const METERS = Object.keys(FREE_PLAN_PER_DAY) as Meter[];

/** "100 incoming WebSocket messages are billed as 5 requests"; outgoing messages are free. */
export const WS_MESSAGES_PER_REQUEST = 20;
/** Duration is billed as if every object used 128 MB, whatever it really uses. */
export const DO_BILLED_GB = 0.128;

/** The owner's rule: the game's share of every daily limit. */
export const GAME_SHARE = 0.5;
/**
 * The safety margin: multiplayer pauses when any meter reaches this fraction of the game's share,
 * so at 40% of the account's limit. The last fifth of the share is there for what the count can miss:
 *  - counting lost if the object is evicted or crashes between two stores: at most 19 messages a
 *    socket (each socket carries its own count, see city.ts) and BUDGET_FLUSH_MS of the duration
 *    estimate (8 GB-s) and of fact rows written (384 at the very most): well under 1% of the share;
 *  - Worker requests counted in an isolate that is thrown away before it reports (under WORKER_REPORT_EVERY each);
 *  - the minutes between the pause and the last socket really closing;
 *  - Cloudflare counting something this code does not know about.
 */
export const PAUSE_AT = 0.8;

/** While messages flow the count is stored this often (also on every visit from the Worker and whenever somebody leaves). */
export const BUDGET_FLUSH_MS = 60_000;
/**
 * Duration cannot be measured from inside, so it is estimated as an upper bound: the object is taken
 * to be awake (and billed) for the whole gap between two events, up to this many ms per gap. An idle
 * object with hibernatable sockets stops being billed after about 10 s.
 */
export const AWAKE_GAP_MS = 10_000;
/** The Worker counts its own requests in memory and tells the city on its next visit, or after this many. */
export const WORKER_REPORT_EVERY = 200;
/** How long the Worker believes "the town is full" without asking the city again. */
export const FULL_CACHE_MS = 15_000;

const DAY_MS = 86_400_000;
/** The UTC day number of a time. */
export function dayOf(now: number): number {
  return Math.floor(now / DAY_MS);
}
/** 00:00 UTC after `now`, ms since 1970: when the limits reset. */
export function nextReset(now: number): number {
  return (dayOf(now) + 1) * DAY_MS;
}

export type Counts = Record<Meter, number>;
export function zeroCounts(): Counts {
  return { workerRequests: 0, doRequests: 0, doGbSeconds: 0, rowsWritten: 0, rowsRead: 0 };
}

/** The pause line of each meter, from the limits (or a test's replacement limits). */
export function pauseLines(limits: Partial<Counts> = {}): Counts {
  const out = zeroCounts();
  for (const m of METERS) out[m] = (limits[m] ?? FREE_PLAN_PER_DAY[m]) * GAME_SHARE * PAUSE_AT;
  return out;
}

/** What survives in storage: one small row. */
export interface BudgetRow {
  day: number;
  used: Counts;
}

/** One UTC day's count. */
export class Budget {
  day: number;
  used: Counts = zeroCounts();
  readonly lines: Counts;
  /** Changed since it was last stored. */
  dirty = false;

  constructor(now: number, limits: Partial<Counts> = {}, stored: BudgetRow | null = null) {
    this.lines = pauseLines(limits);
    this.day = dayOf(now);
    if (stored && stored.day === this.day) for (const m of METERS) this.used[m] = Number(stored.used?.[m]) || 0;
  }

  /** Call before reading or adding: a new UTC day starts from zero. True when the day changed. */
  roll(now: number): boolean {
    const d = dayOf(now);
    if (d === this.day) return false;
    this.day = d;
    this.used = zeroCounts();
    this.dirty = true;
    return true;
  }

  add(meter: Meter, n: number): void {
    if (n > 0) {
      this.used[meter] += n;
      this.dirty = true;
    }
  }

  /** The first meter at or past its pause line, or null while there is budget left. */
  spent(): Meter | null {
    for (const m of METERS) if (this.used[m] >= this.lines[m]) return m;
    return null;
  }

  row(): BudgetRow {
    return { day: this.day, used: { ...this.used } };
  }
}
