// Voices: the only recorded sound in the game, and none of it recorded. Every line was written for Port Calamity and
// spoken by Piper (offline neural text-to-speech; voices and licences in tools/licenses/voices.md, credit in the
// menu's credits line), dressed for its world (a radio's band-pass, a megaphone's grit, a dispatcher's squelch) and
// packed into a few small sprite files under public/audio/voice/ (Opus in WebM at 24 kbps, MP3 for browsers that
// cannot): tools in scratch/voices/ made them.
//
//   dj-<station>   a DJ's links and idents for each generated station: played over the intro of the next song
//   ads            fake adverts for the town's invented businesses, in between
//   dj-claudefm    the host of Claude FM (the live stream): Kokoro, not Piper; ClaudeFMDJ below ducks the stream for a line
//   police         megaphone lines and radio chatter from a cruiser in a pursuit, placed in the world
//   barks          what the townsfolk say: bumped, hit, nearly hit, running away, cheering at the derby
//
// A pack is fetched the first time something wants it (tuning to a station, a pursuit, a passer-by with something
// to say), decoded once at 22 kHz (half the memory of the context's rate) and kept. Nothing here sends anything
// over the network: every line is triggered by an event this browser already has.
//
// Levels: the radio's voices go to the music bus (they follow the Music slider with the songs), everything placed in
// the world to the sfx bus (the Effects slider), through core.place() and its reverb send. Kid mode: nobody is hit,
// so there are no 'hit' barks; every other line is clean for all ages.

import type { Vehicle } from '../core/api';
import type { Game } from '../core/game';
import { kid } from '../core/kid';
import type { AudioCore } from './audio';
import { mulberry } from './audio';
import REACT_LINES from './fmReactLines.json';
import SUB_TEXT from './subtitleText.json';
import { ACC, subs } from '../core/access';

/** Shown in the menu's settings: what the licences ask for (tools/licenses/voices.md). */
export const VOICE_CREDIT = 'Spoken lines: Piper text-to-speech. Voices trained on the VCTK corpus and the Alba recordings (University of Edinburgh, CC BY 4.0) and on LJ Speech (public domain). The Claude FM host: Kokoro-82M text-to-speech (Apache-2.0, hexgrad), voice am_michael.';

type Clip = { id: string; t: number; d: number; kind: string; g: string };

/** A sprite file and its index. */
export class Pack {
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  buf: AudioBuffer | null = null;
  clips: Clip[] = [];
  private byKind = new Map<string, Clip[]>();
  constructor(readonly name: string) {}

  get(kind: string): Clip[] { return this.byKind.get(kind) ?? []; }

  load(core: AudioCore): void {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    void this.fetch(core).catch((e) => { this.state = 'failed'; console.warn('voice pack ' + this.name + ': ' + e); });
  }

  private async fetch(core: AudioCore): Promise<void> {
    const ext = webmOpus() ? 'webm' : 'mp3', base = 'audio/voice/' + this.name;
    const [ix, raw] = await Promise.all([
      fetch(base + '.json').then((r) => { if (!r.ok) throw new Error('index ' + r.status); return r.json() as Promise<{ clips: [string, number, number, string, string?][] }>; }),
      fetch(base + '.' + ext).then((r) => { if (!r.ok) throw new Error(ext + ' ' + r.status); return r.arrayBuffer(); }),
    ]);
    let buf: AudioBuffer;
    try { buf = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(raw.slice(0)); } catch { buf = await core.ctx.decodeAudioData(raw); }
    for (const [id, t, d, kind, g] of ix.clips) {
      const c: Clip = { id, t, d, kind, g: g ?? '' };
      this.clips.push(c);
      let a = this.byKind.get(kind); if (!a) this.byKind.set(kind, (a = []));
      a.push(c);
    }
    this.buf = buf; this.state = 'ready';
  }
}

let webm: boolean | null = null;
/** Opus in WebM, where the browser says it can play it; MP3 otherwise (older Safari). */
function webmOpus(): boolean {
  if (webm === null) { try { webm = document.createElement('audio').canPlayType('audio/webm; codecs="opus"') !== ''; } catch { webm = false; } }
  return webm;
}

/** Which pack each station's DJ lives in. */
const DJ_OF: Record<string, string> = {
  'WDOOF 99.9': 'wdoof', 'Low Tide FM': 'lowtide', 'Ledger 1040': 'ledger', 'The Cannery 88': 'cannery',
  'Radio Fishbone': 'fishbone', 'WTPD 610 AM': 'wtpd', 'WJNGL 122.5': 'carols',
};

/** Play a clip into `out` at audio time t. Returns the source (so a caller can cut it short). */
function play(core: AudioCore, pack: Pack, c: Clip, out: AudioNode, t: number, gain = 1, rate = 1): AudioBufferSourceNode | null {
  if (!pack.buf) return null;
  const s = core.ctx.createBufferSource(), g = core.gain(gain);
  s.buffer = pack.buf; s.playbackRate.value = rate;
  s.connect(g); g.connect(out);
  s.start(t, c.t, c.d / rate + 0.02);
  if (ACC.subs) caption(pack, c, t - core.now, c.d / rate);
  return s;
}

/** The words of a clip and who says them, for the subtitles (Settings > Accessibility). Every clip of every pack has its text. */
const STATION_OF: Record<string, string> = {};
function station(key: string): string {
  if (!STATION_OF[key]) for (const [call, k] of Object.entries(DJ_OF)) STATION_OF[k] = call;
  return STATION_OF[key] ?? 'Radio';
}
function caption(pack: Pack, c: Clip, delay: number, dur: number): void {
  const n = pack.name, txt = SUB_TEXT as unknown as Record<string, Record<string, string> | Record<string, string[]>>;
  let text = '', who = 'Radio', pri = 2;
  if (n === 'dj-claudefm-react') {
    const at = c.id.indexOf('#');
    text = ((REACT_LINES as Record<string, string[]>)[c.id.slice(0, at)] ?? [])[Number(c.id.slice(at + 1))] ?? ''; who = 'Claude FM';
  } else if (n === 'barks') {
    const m = /^([a-z]+)(\d+)[mf]$/.exec(c.id);
    text = m ? (txt.barks as Record<string, string[]>)[m[1]]?.[Number(m[2])] ?? '' : ''; who = 'Passer-by'; pri = 1;
  } else {
    text = (txt[n] as Record<string, string> | undefined)?.[c.id] ?? '';
    if (n === 'police') { who = c.kind === 'chat' ? 'Dispatch' : 'Officer'; pri = 3; }
    else if (n === 'ads') { who = 'Advert'; pri = 1; }
    else if (n === 'dj-claudefm') who = 'Claude FM';
    else if (n.startsWith('dj-')) who = station(n.slice(3));
  }
  subs.say(who, text, delay, dur, pri);
}

// ── The radio's ──────────────────────────────────────────────────────────────

interface DuckPlayer { duck: GainNode; st: { call: string; seed: number } }

export class RadioVoice {
  readonly djs = new Map<string, Pack>();
  readonly ads = new Pack('ads');
  /** For the tests. */
  stats = { idents: 0, links: 0, ads: 0, last: '' };
  private player: DuckPlayer | null = null;
  private lastSong = -1;
  private tuneT = 0;
  private identDone = false;
  private busyUntil = 0;
  private src: AudioBufferSourceNode | null = null;
  private recent: string[] = [];

  constructor(private readonly core: AudioCore) {}

  /** Called every frame while a generated station is playing (null: none). `clock` is the station's time on the air; songBars its song length in seconds. */
  tick(p: DuckPlayer | null, clock: number, songSeconds: number): void {
    const c = this.core, t = c.now;
    if (p !== this.player) {
      this.cut(t);
      this.player = p; this.lastSong = -1; this.identDone = false; this.tuneT = t; this.busyUntil = 0;
      if (p && p.st.call in DJ_OF) { this.pack(p).load(c); this.ads.load(c); }
    }
    if (!p) return;
    // The stations you earn (unlocks) have no host: music only.
    if (!(p.st.call in DJ_OF)) return;
    const dj = this.pack(p);
    if (dj.state !== 'ready') return;
    const song = Math.floor(clock / songSeconds), into = clock - song * songSeconds;
    // Tuning in: a station ident after half a second, once.
    if (!this.identDone && t - this.tuneT > 0.5) {
      this.identDone = true; this.lastSong = song;
      if (this.say(p, dj, 'id', t + 0.05)) return;
    }
    // A new song: the DJ talks over its intro. Joined late in a song, they wait for the next.
    if (song !== this.lastSong) {
      const first = this.lastSong < 0;
      this.lastSong = song;
      if (!first && into < 2.5) {
        const r = mulberry(p.st.seed * 31 + song)();
        if (r < 0.3 && this.ads.state === 'ready') this.say(p, this.ads, 'ad', t + 0.2);
        else this.say(p, dj, r < 0.42 ? 'id' : 'link', t + 0.2);
      }
    }
  }

  private pack(p: DuckPlayer): Pack {
    const key = DJ_OF[p.st.call] ?? 'wdoof';
    let k = this.djs.get(key);
    if (!k) this.djs.set(key, (k = new Pack('dj-' + key)));
    return k;
  }

  /** Say a line (not the last few said); the song under it ducks. */
  private say(p: DuckPlayer, pack: Pack, kind: string, at: number): boolean {
    const c = this.core;
    if (at < this.busyUntil || pack.state !== 'ready') return false;
    const list = pack.get(kind).filter((x) => !this.recent.includes(x.id + pack.name));
    const pool = list.length ? list : pack.get(kind);
    if (!pool.length) return false;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    this.recent.push(clip.id + pack.name); if (this.recent.length > 4) this.recent.shift();
    const g = p.duck.gain, end = at + clip.d;
    g.cancelScheduledValues(at - 0.2); g.setTargetAtTime(0.28, at - 0.1, 0.12);
    g.setTargetAtTime(1, end + 0.05, 0.35);
    // The voice rides the music bus beside the songs: it follows the Music slider and nothing else.
    this.src = play(c, pack, clip, c.bus.music, at, 1.5);
    this.busyUntil = end + 0.4;
    if (kind === 'ad') this.stats.ads++; else if (kind === 'id') this.stats.idents++; else this.stats.links++;
    this.stats.last = pack.name + ':' + clip.id;
    return true;
  }

  private cut(t: number): void {
    if (this.src) { try { this.src.stop(t + 0.05); } catch { /* done */ } this.src = null; }
  }
}

// ── Claude FM's ──────────────────────────────────────────────────────────────

/** The few parts of ClaudeFM (claudefm.ts) the host needs: is it sounding, and the factor it may be ducked by. */
interface FMLike { readonly playing: boolean; duck: number }

/** Seconds of listening before the first line (never under 30), and between lines after that (about 4 to 7 minutes). */
/** Reactive lines: ms between two (any kind), ms before one is said, ms it may wait for its turn; bigger moments push out smaller ones. */
const REACT_COOL = 90000, REACT_DELAY = 2500, REACT_LIFE = 40000;
const REACT_PRI: Record<string, number> = {
  busted: 3, raceWin: 3, derbyWin: 3, stage: 3, coop: 3, duckSet: 3, receiptSet: 3, wreck: 2, escaped: 2, raceLose: 2, taxi: 2,
  delivery: 2, plow: 2, fish: 2, photo: 2, jump: 1, eventSoon: 1, snow: 1,
};
const FM_FIRST = [45, 90], FM_EVERY = [240, 420], FM_DUCK = 0.25, FM_RAMP = 0.6;

/**
 * The host of Claude FM. The stream is YouTube's, so it cannot be mixed: it is pulled down (setVolume, through
 * ClaudeFM.duck) to a quarter over 0.6 s, one line is spoken on the music bus (it follows the Music slider like the
 * stream does), and the stream comes back over 0.6 s. Only counts time while the stream is really playing; stopping
 * (left the car, paused, tab hidden) cuts the line short and puts the volume back. The pack loads on first play.
 */
export class ClaudeFMDJ {
  readonly pack = new Pack('dj-claudefm');
  /** The reactive lines (tools/radio/gen-react.py): what the host says about what the player just did. */
  readonly reactPack = new Pack('dj-claudefm-react');
  stats = { lines: 0, last: '', kind: '', react: 0, reactToast: 0, reactLast: '' };
  private pending: { kind: string; pri: number; due: number; exp: number; quiet: boolean } | null = null;
  private lastReact = -1e9;
  private forced: Clip | null = null;
  private recentReact: string[] = [];
  /** Phase: waiting, ducking down, speaking, coming back. */
  phase: 'wait' | 'down' | 'say' | 'up' = 'wait';
  private left = FM_FIRST[0] + Math.random() * (FM_FIRST[1] - FM_FIRST[0]);
  private t = 0;
  private src: AudioBufferSourceNode | null = null;
  private clip: Clip | null = null;
  private recent: string[] = [];
  private first = true;

  constructor(private readonly core: AudioCore, private readonly fm: FMLike, private readonly toast: (text: string) => void = () => { /* none */ }) {}

  /**
   * Something notable happened (a key of fmReactLines.json) and Claude FM is the station on the dial. The host says
   * so about two seconds later, never over another clip, at most once every 90 s whatever it was; a bigger moment
   * pushes out a smaller one still waiting. `quiet`: the game has its own toast for it, so no text fallback.
   */
  offer(kind: string, quiet = false): boolean {
    const now = performance.now(), pri = REACT_PRI[kind] ?? 1;
    if (!(kind in REACT_LINES) || now - this.lastReact < REACT_COOL) return false;
    if (this.pending && this.pending.pri >= pri) return false;
    this.pending = { kind, pri, due: now + REACT_DELAY, exp: now + REACT_LIFE, quiet };
    return true;
  }

  private reactText(kind: string): string {
    const all = (REACT_LINES as Record<string, string[]>)[kind] ?? [];
    const ids = all.map((_, i) => kind + '#' + i);
    const pool = ids.filter((id) => !this.recentReact.includes(id));
    const use = pool.length ? pool : ids;
    const id = use[Math.floor(Math.random() * use.length)];
    if (!id) return '';
    this.recentReact.push(id); if (this.recentReact.length > 6) this.recentReact.shift();
    return all[Number(id.split('#')[1])] ?? '';
  }

  /** The reactive line waiting its turn. eligible: Claude FM is the station and she is in a vehicle. */
  private reactTick(on: boolean, eligible: boolean): void {
    const p = this.pending; if (!p) return;
    const now = performance.now();
    if (!eligible) { if (now > p.exp) this.pending = null; return; }
    if (now < p.due) return;
    const pk = this.reactPack, c = this.core;
    const fallback = (): void => {
      this.pending = null; this.lastReact = now;
      if (!p.quiet) { this.toast('Claude FM: ' + this.reactText(p.kind)); this.stats.reactToast++; }
      this.stats.reactLast = p.kind;
    };
    if (!on) { fallback(); return; }
    if (pk.state === 'idle') pk.load(c);
    if (pk.state === 'failed') { fallback(); return; }
    if (pk.state !== 'ready' || c.ctx.state !== 'running') { if (now > p.exp) fallback(); return; }
    if (this.phase !== 'wait') { if (now > p.exp) this.pending = null; return; }
    const all = pk.get(p.kind), pool = all.filter((x) => !this.recentReact.includes(x.id));
    const clip = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))];
    if (!clip) { fallback(); return; }
    this.recentReact.push(clip.id); if (this.recentReact.length > 6) this.recentReact.shift();
    this.forced = clip; this.pending = null; this.lastReact = now;
    this.phase = 'down'; this.t = 0;
    this.stats.react++; this.stats.reactLast = p.kind;
  }

  /** Each frame with the real seconds since the last. `on`: Claude FM is wanted and sounding. `eligible`: it is the station and she is in a vehicle. */
  tick(dt: number, on: boolean, eligible = on): void {
    const fm = this.fm;
    this.reactTick(on, eligible);
    if (on && this.pack.state === 'idle') this.pack.load(this.core);
    if (!on) {
      if (this.phase !== 'wait') this.stop();
      if (fm.duck !== 1) fm.duck = 1;
      return;
    }
    dt = Math.min(dt, 0.25);
    const c = this.core;
    if (this.phase === 'wait') {
      this.left -= dt;
      if (this.left > 0) return;
      if (this.pack.state !== 'ready' || c.ctx.state !== 'running') { this.left = 5; return; }
      this.phase = 'down'; this.t = 0;
    } else if (this.phase === 'down') {
      this.t += dt;
      fm.duck = 1 - (1 - FM_DUCK) * Math.min(1, this.t / FM_RAMP);
      if (this.t >= FM_RAMP) {
        if (!this.speak()) { this.phase = 'up'; this.t = 0; } else { this.phase = 'say'; this.t = 0; }
      }
    } else if (this.phase === 'say') {
      this.t += dt;
      if (this.clip && this.t >= this.clip.d + 0.15) { this.phase = 'up'; this.t = 0; this.src = null; }
    } else {
      this.t += dt;
      fm.duck = FM_DUCK + (1 - FM_DUCK) * Math.min(1, this.t / FM_RAMP);
      if (this.t >= FM_RAMP) { fm.duck = 1; this.phase = 'wait'; this.left = FM_EVERY[0] + Math.random() * (FM_EVERY[1] - FM_EVERY[0]); }
    }
  }

  /** Say one line now (not one of the last few; the first is always an ident). Returns false if it could not. */
  private speak(): boolean {
    const c = this.core, pk = this.pack;
    if (this.forced) {
      const f = this.forced; this.forced = null;
      this.src = play(c, this.reactPack, f, c.bus.music, c.now + 0.03, 1.5);
      if (!this.src) return false;
      this.clip = f; return true;
    }
    const kinds = this.first ? ['id'] : Math.random() < 0.6 ? ['tip'] : ['link', 'id'];
    let pool = kinds.flatMap((k) => pk.get(k)).filter((x) => !this.recent.includes(x.id));
    if (!pool.length) pool = pk.clips.filter((x) => !this.recent.includes(x.id));
    if (!pool.length) return false;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    this.recent.push(clip.id); if (this.recent.length > 8) this.recent.shift();
    // The voice rides the music bus: the Music slider and the master level set it, as they set the stream.
    this.src = play(c, pk, clip, c.bus.music, c.now + 0.03, 1.5);
    if (!this.src) return false;
    this.clip = clip; this.first = false; this.stats.lines++; this.stats.last = clip.id; this.stats.kind = clip.kind;
    return true;
  }

  /** Cut whatever is being said and put the stream back at once. */
  private stop(): void {
    if (this.src) { try { this.src.stop(this.core.now + 0.03); } catch { /* done */ } this.src = null; }
    this.phase = 'wait'; this.fm.duck = 1;
    this.left = FM_EVERY[0] + Math.random() * (FM_EVERY[1] - FM_EVERY[0]);
  }

  /** For the tests: speak at the next frame. */
  force(): void { this.phase = 'wait'; this.left = 0; }
}

// ── The world's ──────────────────────────────────────────────────────────────

interface PoliceLike { units: { v: Vehicle; state: string; shown: boolean }[] }
interface Heat { level: number; seen: boolean; searching: boolean }

export class Voices {
  readonly police = new Pack('police');
  readonly barks = new Pack('barks');
  /** For the tests: lines started, by kind, and the last one. */
  stats: Record<string, number> = { mega: 0, chat: 0, search: 0, bump: 0, hit: 0, near: 0, flee: 0, cheer: 0 };
  last = '';
  private readonly cops: PoliceLike | null;
  private heat: Heat = { level: 0, seen: false, searching: false };
  private scanT = 0;
  private megaAt = 0; private chatAt = 0; private barkAt = 0; private nearAt = 0; private fleeAt = 0; private cheerAt = 0; private hitAt = -9;
  private readonly seen = new Map<number, number>();
  private recent: string[] = [];

  constructor(private readonly core: AudioCore, private readonly game: Game) {
    this.cops = (game.systems.find((s) => (s as { tag?: string }).tag === 'police') as unknown as PoliceLike | undefined) ?? null;
    game.on('heat', (e) => { this.heat = e; if (e.level > 0) this.police.load(core); });
    game.on('pedHit', (e) => {
      this.hitAt = core.now;
      if (!kid.on) this.bark('hit', e.x, e.z, (Math.round(e.x * 7 + e.z * 3) >>> 0) & 1, 0.25);
    });
  }

  // ── Barks ──

  /** Somebody says something short, from where they stand. */
  bark(cat: string, x: number, z: number, odd: number, delay = 0, force = false): boolean {
    const c = this.core, pk = this.barks;
    if (cat === 'hit' && kid.on) return false;
    if (pk.state === 'idle') { pk.load(c); return false; }
    if (pk.state !== 'ready' || c.ctx.state !== 'running') return false;
    const t = c.now;
    // Never chatty: one voice at a time, and a pause after each unless it is a cry of pain.
    if (!force && t < this.barkAt) return false;
    const want = odd ? 'f' : 'm';
    const pool = pk.get(cat).filter((k) => k.g === want && !this.recent.includes(k.id));
    if (!pool.length) return false;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    if (!c.claim('bark', 2, clip.d)) return false;
    const sp = c.place(x, 1.6, z, { bus: 'sfx', ref: 6, max: 70, wet: 0.3 });
    if (!sp) return false;
    this.recent.push(clip.id); if (this.recent.length > 5) this.recent.shift();
    play(c, pk, clip, sp.in, t + sp.lag + delay, 1.6, 0.97 + Math.random() * 0.06);
    this.barkAt = t + clip.d + 1.8 + Math.random() * 2.5;
    this.stats[cat]++; this.last = cat + ':' + clip.id;
    return true;
  }

  /** The derby crowd (game/derby.ts calls this where it roars): a few of them shout, spread round the stands. */
  cheer(x: number, z: number): void {
    const t = this.core.now;
    if (t < this.cheerAt) return;
    this.cheerAt = t + 3.5 + Math.random() * 3;
    for (let i = 0; i < 2; i++) this.bark('cheer', x + (Math.random() - 0.5) * 30, z + (Math.random() - 0.5) * 20, (Math.random() * 2) | 0, i * 0.35, true);
  }

  // ── The Patrol ──

  private pursuit(): void {
    const c = this.core, t = c.now, cops = this.cops;
    if (!cops || this.heat.level <= 0 || t < Math.min(this.megaAt, this.chatAt)) return;
    // The nearest cruiser that is driving.
    let best: Vehicle | null = null, bd = 1e9;
    for (const u of cops.units) {
      if (u.state !== 'drive') continue;
      const d = Math.hypot(u.v.x - c.lx, u.v.z - c.lz);
      if (d < bd) { bd = d; best = u.v; }
    }
    if (!best || bd > 90) return;
    const pk = this.police;
    if (pk.state !== 'ready' || c.ctx.state !== 'running') return;
    if (t >= this.megaAt && bd < 70) {
      if (this.speak(best, this.heat.seen ? 'mega' : 'search')) this.megaAt = t + 9 + Math.random() * 8;
    } else if (t >= this.chatAt && bd < 45) {
      if (this.speak(best, 'chat')) this.chatAt = t + 14 + Math.random() * 12;
    }
  }

  /** A line from a cruiser, placed where the cruiser is. */
  speak(v: Vehicle, kind: 'mega' | 'chat' | 'search'): boolean {
    const c = this.core, pk = this.police;
    if (pk.state !== 'ready') { pk.load(c); return false; }
    const pool = pk.get(kind).filter((k) => !this.recent.includes(k.id));
    if (!pool.length) return false;
    const clip = pool[Math.floor(Math.random() * pool.length)];
    if (!c.claim('megaphone', 1, clip.d + 0.3)) return false;
    const mega = kind !== 'chat';
    const sp = c.place(v.x, v.y + 1.4, v.z, { bus: 'sfx', ref: mega ? 16 : 9, max: mega ? 170 : 70, wet: mega ? 0.4 : 0.15 });
    if (!sp) return false;
    this.recent.push(clip.id); if (this.recent.length > 6) this.recent.shift();
    play(c, pk, clip, sp.in, c.now + sp.lag + 0.05, mega ? 1.3 : 0.9);
    this.stats[kind]++; this.last = kind + ':' + clip.id;
    return true;
  }

  // ── Frame ──

  update(dt: number): void {
    const c = this.core, g = this.game;
    this.scanT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.3;
    this.pursuit();
    // The first passer-by is the cue to fetch the barks (half a megabyte), so the first cry is not lost to the download.
    if (this.barks.state === 'idle' && this.game.people.list.length) this.barks.load(c);
    const pl = g.player, me = pl.person, t = c.now;
    const list = g.people.list, car = pl.vehicle;
    const cs = car ? Math.hypot(car.vx, car.vz) : 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p === me || !p.visible || p.occupant || p.pose === 'down' || p.pose === 'sit' || p.pose === 'swim') continue;
      const d = Math.hypot(p.x - c.lx, p.z - c.lz);
      if (d > 26) continue;
      const odd = p.id & 1;
      if (car && cs > 0.5) {
        const dc = Math.hypot(p.x - car.x, p.z - car.z);
        // Close to a car that is going somewhere: a shove at a crawl, a shout at speed.
        if (dc < 3.4 && cs > 10 && t - this.hitAt > 2 && t > this.nearAt && !this.seen.has(p.id)) {
          if (this.bark('near', p.x, p.z, odd, 0.15)) { this.nearAt = t + 5; this.seen.set(p.id, t + 25); }
        } else if (dc < 1.9 && cs <= 6 && !this.seen.has(p.id)) {
          if (this.bark('bump', p.x, p.z, odd)) this.seen.set(p.id, t + 20);
        }
      } else if (!car) {
        // On foot: walked into.
        if (d < 0.95 && me.speed > 1.2 && !this.seen.has(p.id)) { if (this.bark('bump', p.x, p.z, odd)) this.seen.set(p.id, t + 20); }
      }
      // Running from something.
      if (p.pose === 'run' && p.speed > 3 && t > this.fleeAt && !this.seen.has(p.id) && d > 2) {
        if (this.bark('flee', p.x, p.z, odd)) { this.fleeAt = t + 6; this.seen.set(p.id, t + 30); }
      }
    }
    if (this.seen.size > 40) for (const [k, v] of this.seen) if (v < t) this.seen.delete(k);
  }
}
