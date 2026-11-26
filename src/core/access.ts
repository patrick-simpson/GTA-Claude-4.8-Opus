// Accessibility (fun queue 2, item 40): colourblind-safe palettes, subtitles for the spoken audio, a text size, calmer
// screen effects and hold-or-toggle for sprint and aim. Kept per device in localStorage pc.access (not the game save);
// every default is the game as it always was. Pure data and a small line queue: no DOM here except the two body hooks.
//
//   ACC.c.alert ...   the live colour of each meaning as '#rrggbb' (the radar, the maps, the HUD); ACC.n.alert as 0xrrggbb
//                     (three.js materials). ACC.ver changes whenever any of it does, so a material can re-read lazily.
//   ACC.shapes        true under any palette but the default: markers add a shape beside the colour.
//   subs.say(...)     queue a spoken line (src/audio/voices.ts); subs.poll(now) is the one on screen right now.

export type PalName = 'default' | 'deut' | 'trit' | 'high';
/** What a colour means: alert (danger, cops, health, the red team, the player's arrow), goal (where to go: the waypoint, the route),
 *  job (a job, a convoy or co-op ring, the radar's teal), peer (another player), follow (a Follow me light), red / blue (snowball teams). */
export type Slot = 'alert' | 'goal' | 'job' | 'peer' | 'follow' | 'red' | 'blue';
const SLOTS: readonly Slot[] = ['alert', 'goal', 'job', 'peer', 'follow', 'red', 'blue'];

export const PALETTES: Record<PalName, Record<Slot, string>> = {
  default: { alert: '#e4572e', goal: '#f0a202', job: '#2a9d8f', peer: '#8e3fb8', follow: '#ffd166', red: '#d9382c', blue: '#2f6fd0' },
  // Red-green: the Okabe-Ito set, which keeps hue apart on the blue-yellow axis and lightness apart where hue is weak.
  deut: { alert: '#d55e00', goal: '#f0e442', job: '#0072b2', peer: '#cc79a7', follow: '#56b4e9', red: '#d55e00', blue: '#0072b2' },
  // Blue-yellow: reds, oranges and dark teal apart by lightness, with a deep purple and a pale peach, nothing leaning on blue against green.
  trit: { alert: '#d7263d', goal: '#ff9f1c', job: '#006d6d', peer: '#5b2a86', follow: '#ffd9b3', red: '#d7263d', blue: '#006d6d' },
  high: { alert: '#ff0000', goal: '#ffff00', job: '#00ffff', peer: '#ff00ff', follow: '#ffffff', red: '#ff0000', blue: '#3d7bff' },
};
export const PAL_NAMES: readonly [PalName, string][] = [['default', 'Default'], ['deut', 'Red-green safe'], ['trit', 'Blue-yellow safe'], ['high', 'High contrast']];
export const SUB_NAMES: readonly [number, string][] = [[0, 'Off'], [1, 'On'], [2, 'With names']];
export const SCALES: readonly number[] = [100, 125, 150];

const KEY = 'pc.access';
const num = (h: string): number => parseInt(h.slice(1), 16);

interface Saved { pal: PalName; subs: number; scale: number; calm: boolean; toggle: boolean }

class Access {
  pal: PalName = 'default';
  /** 0 off, 1 on, 2 on with the speaker's name. */
  subs = 0;
  /** UI text size, percent (100 / 125 / 150). */
  scale = 100;
  /** Calmer screen: a fifth of the camera shake, no splat or hurt flash, softer firework flashes. */
  calm = false;
  /** Sprint and aim: press once to switch on, again to switch off (instead of holding). */
  toggle = false;
  shapes = false;
  ver = 0;
  readonly c: Record<Slot, string> = { ...PALETTES.default };
  readonly n: Record<Slot, number> = { alert: 0, goal: 0, job: 0, peer: 0, follow: 0, red: 0, blue: 0 };

  constructor() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
      if (j) {
        if (j.pal && j.pal in PALETTES) this.pal = j.pal;
        if (j.subs === 0 || j.subs === 1 || j.subs === 2) this.subs = j.subs;
        if (SCALES.includes(Number(j.scale))) this.scale = Number(j.scale);
        this.calm = j.calm === true; this.toggle = j.toggle === true;
      }
    } catch { /* no storage, or nothing saved: the defaults */ }
    this.refresh();
  }

  private refresh(): void {
    const p = PALETTES[this.pal];
    for (const s of SLOTS) { this.c[s] = p[s]; this.n[s] = num(p[s]); }
    this.shapes = this.pal !== 'default';
    this.ver++;
    try {
      const b = document.body, r = document.documentElement;
      if (b) { b.classList.toggle('acc-calm', this.calm); b.classList.toggle('acc-high', this.pal === 'high'); }
      r.style.setProperty('--ui-scale', String(this.scale / 100));
      r.style.setProperty('--acc-alert', this.c.alert);
    } catch { /* no document: a unit test */ }
  }

  /** Change some of the settings and keep them. */
  set(p: Partial<Saved>): void {
    if (p.pal && p.pal in PALETTES) this.pal = p.pal;
    if (p.subs === 0 || p.subs === 1 || p.subs === 2) { this.subs = p.subs; if (!p.subs) subs.clear(); }
    if (p.scale !== undefined && SCALES.includes(p.scale)) this.scale = p.scale;
    if (p.calm !== undefined) this.calm = p.calm;
    if (p.toggle !== undefined) this.toggle = p.toggle;
    this.refresh();
    try { localStorage.setItem(KEY, JSON.stringify({ pal: this.pal, subs: this.subs, scale: this.scale, calm: this.calm, toggle: this.toggle } satisfies Saved)); } catch { /* not kept */ }
  }

  /** Re-apply the body hooks (the body may not have existed when this was first built). */
  apply(): void { this.refresh(); }
}
export const ACC = new Access();

// ── Subtitles ────────────────────────────────────────────────────────────────

/** One piece of a spoken line, on screen from `start` to `end` (performance.now ms). */
export interface Cue { who: string; text: string; start: number; end: number; pri: number }

const MAX_CHARS = 84, MAX_LINE = 130, MIN_SHOW = 900, QUEUE = 14;

/** A line cut into pieces that fit two lines of the strip: whole sentences up to about 84 characters, a long sentence at a comma. */
export function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const s of text.trim().split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + 1 + s.length > MAX_CHARS) { out.push(cur); cur = ''; }
    cur = cur ? cur + ' ' + s : s;
  }
  if (cur) out.push(cur);
  const res: string[] = [];
  for (const c of out) {
    let s = c;
    while (s.length > MAX_LINE) {
      let at = s.lastIndexOf(', ', Math.floor(s.length / 2) + 12);
      if (at < 20) at = s.indexOf(' ', Math.floor(s.length / 2));
      if (at < 0) break;
      res.push(s.slice(0, at + 1).trim()); s = s.slice(at + 1).trim();
    }
    res.push(s);
  }
  return res;
}

/** The subtitle queue: spoken lines go in (each timed from its clip), one piece at a time comes out, never over another. */
class Subtitles {
  private q: Cue[] = [];
  private cur: Cue | null = null;
  private shownUntil = 0;
  /** For the tests: lines taken, pieces shown. */
  stats = { lines: 0, shown: 0, dropped: 0 };

  /**
   * A line is about to be spoken: `delay` seconds from now, for `dur` seconds. `pri`: 3 police, 2 the radio's hosts, 1 adverts and passers-by.
   * Long ones are cut to pieces shown in turn over the clip's length.
   */
  say(who: string, text: string, delay: number, dur: number, pri = 2): void {
    if (!ACC.subs || !text) return;
    const parts = chunks(text), total = parts.reduce((a, s) => a + s.length, 0) || 1;
    let at = performance.now() + Math.max(0, delay) * 1000;
    this.stats.lines++;
    for (const t of parts) {
      const d = Math.max(MIN_SHOW, dur * 1000 * (t.length / total));
      if (this.q.length >= QUEUE) { this.q.shift(); this.stats.dropped++; }
      this.q.push({ who: ACC.subs === 2 ? who : '', text: t, start: at, end: at + d, pri });
      at += d;
    }
  }

  /** The piece to show now (null: none). The same object until it changes. */
  poll(now: number): Cue | null {
    if (this.cur && now >= this.shownUntil) this.cur = null;
    if (this.cur) return this.cur;
    for (let i = this.q.length - 1; i >= 0; i--) if (this.q[i].end <= now) { this.q.splice(i, 1); this.stats.dropped++; }
    let pick: Cue | null = null;
    for (const c of this.q) if (c.start <= now && (!pick || c.pri > pick.pri || (c.pri === pick.pri && c.start < pick.start))) pick = c;
    if (!pick) return null;
    this.q.splice(this.q.indexOf(pick), 1);
    this.cur = pick; this.shownUntil = Math.max(pick.end, now + MIN_SHOW); this.stats.shown++;
    return pick;
  }

  clear(): void { this.q.length = 0; this.cur = null; }
}
export const subs = new Subtitles();
