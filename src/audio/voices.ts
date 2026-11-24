// Voices: the only recorded sound in the game, and none of it recorded. Every line was written for Port Calamity and
// spoken by Piper (offline neural text-to-speech; voices and licences in tools/licenses/voices.md, credit in the
// menu's credits line), dressed for its world (a radio's band-pass, a megaphone's grit, a dispatcher's squelch) and
// packed into a few small sprite files under public/audio/voice/ (Opus in WebM at 24 kbps, MP3 for browsers that
// cannot): tools in scratch/voices/ made them.
//
//   dj-<station>   a DJ's links and idents for each generated station: played over the intro of the next song
//   ads            fake adverts for the town's invented businesses, in between
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

/** Shown in the menu's settings: what the licences ask for (tools/licenses/voices.md). */
export const VOICE_CREDIT = 'Spoken lines: Piper text-to-speech. Voices trained on the VCTK corpus and the Alba recordings (University of Edinburgh, CC BY 4.0) and on LJ Speech (public domain).';

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
  return s;
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
      if (p) { this.pack(p).load(c); this.ads.load(c); }
    }
    if (!p) return;
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
