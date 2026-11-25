// The car radio. Six stations, none of them playing anything that exists.
//
// A station is a composer and a small band. The composer is a pure function:
// (station, bar number) -> the notes of that bar. It never keeps state, so a
// station can be joined at any moment of any song and it is the same song it
// would have been had she been listening all along: stations keep time while
// she is away because their clock is the game's.
//
// A song is 66 bars: the station's ident, an intro, A A' B A'' C B' A''' and an
// outro. Each song draws a key, a progression for each letter and a two-bar
// motif for each letter from its own seed. A section is four two-bar phrases:
// the motif, the motif in sequence, the motif again (ornamented later in the
// song), and a cadence. Notes on strong beats are pulled onto the chord, and
// any note a semitone from a chord tone that is foreign to the key gives way to
// it, so a V7 in a minor key gets its leading tone. The last bar of a section
// has a drum fill.
//
// The band is scheduled a quarter of a second ahead and nothing is touched per
// frame but a clock comparison. Off, or with the music slider at zero, there is
// no band and no cost.

import type { Game } from '../core/game';
import { save } from '../game/save';
import { progress } from '../world/progress';
import { mulberry, type AudioCore } from './audio';
import { hiss, ping, thud } from './sfx';
import { ClaudeFM, CLAUDE_FM_CALL } from './claudefm';
import { CAROLS } from './carols';
import { holiday } from '../world/holiday';
import { RadioVoice, ClaudeFMDJ } from './voices';

// ── Harmony ──────────────────────────────────────────────────────────────────

export interface Chord { name: string; root: number; tones: number[] }
const NUM: Record<string, number> = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };
const chords = new Map<string, Chord>();
/** "V7", "ii7", "bVII", "IM7", "iv6", "viidim": upper case major, lower case minor, a flat lowers the root. */
export function chord(tok: string): Chord {
  let c = chords.get(tok);
  if (c) return c;
  const m = /^(b?)([ivIV]+)(M7|7|6|dim)?$/.exec(tok);
  if (!m) throw new Error('chord ' + tok);
  const major = m[2] === m[2].toUpperCase(), ext = m[3] ?? '';
  const tones = ext === 'dim' ? [0, 3, 6, 9] : major ? [0, 4, 7] : [0, 3, 7];
  if (ext === 'M7') tones.push(11); else if (ext === '7') tones.push(10); else if (ext === '6') tones.push(9);
  c = { name: tok, root: (NUM[m[2].toLowerCase()] - (m[1] ? 1 : 0) + 12) % 12, tones };
  chords.set(tok, c);
  return c;
}
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10];
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const degSemi = (scale: number[], deg: number): number => scale[mod(deg, 7)] + 12 * Math.floor(deg / 7);
const inChord = (c: Chord, semi: number): boolean => c.tones.includes(mod(semi - c.root, 12));
/** Pull a melody note (semitones above the tonic) onto the harmony: always on a strong beat, and anywhere it would grind against an altered chord tone. */
function fit(c: Chord, scale: number[], semi: number, strong: boolean): number {
  if (inChord(c, semi)) return semi;
  for (const d of [1, -1]) if (inChord(c, semi + d) && !scale.includes(mod(semi + d, 12))) return semi + d;
  if (strong) for (const d of [-1, 1, -2, 2]) if (inChord(c, semi + d)) return semi + d;
  return semi;
}

// ── Stations ─────────────────────────────────────────────────────────────────

export type Inst = 'kick' | 'snare' | 'hat' | 'ohat' | 'rim' | 'shaker' | 'tom' | 'crash' | 'clap' | 'block' | 'bass' | 'stab' | 'pad' | 'lead' | 'lead2';
/** One note. s, d: start and length in sixteenths from the bar line. m: MIDI pitch (drums: a variant). v: 0..1. */
export interface Ev { s: number; d: number; i: Inst; m: number; v: number }
export interface Bar { song: number; sec: string; n: number; of: number; key: number; chord: Chord; ev: Ev[] }

/** A tone generator. lp: filter cutoff as a multiple of the note's frequency. */
export interface Patch {
  w: OscillatorType | number[]; a: number; d: number; s: number; r: number; lp: number; level: number;
  /** Extra cutoff at the attack, as a multiple. */ lpEnv?: number;
  /** Vibrato depth in cents, and its rate. */ vib?: number; vibHz?: number;
  /** A second oscillator this many cents away. */ det?: number;
  /** Cents below the note it starts from. */ scoop?: number;
  /** Air: noise through a band at the note, 0..1. */ breath?: number;
}
type Style = 'oompah' | 'lofi' | 'bossa' | 'funk' | 'waltz' | 'chacha';
export interface Station {
  call: string; name: string; seed: number; style: Style;
  bpm: number; beats: 3 | 4; swing: number; scale: number[]; tonic: string;
  /** Tonics to choose from, as MIDI notes near 48..59. The first is the station's own, and its ident's. */
  keys: number[];
  A: string[]; B: string[]; C: string[];
  /** Melody: how busy, how syncopated, and which octave above the tonic it lives in. */
  dens: number; sync: number; oct: number;
  kit: 'band' | 'box' | 'lofi';
  bass: Patch; stab: Patch; pad: Patch; lead: Patch; lead2: Patch;
  /** Channel levels. */
  mix: { drums: number; bass: number; stab: number; pad: number; lead: number; lead2: number };
  /** Tremolo on the lead channel: depth 0..1 and rate. */ trem?: [number, number];
  /** Reverb send. */ wet: number;
  /** A long-wave set: nothing below 300 Hz or above 3.4 kHz, and hiss. */ am?: boolean;
  /** Surface noise. */ hiss?: number;
  /** The station's own level, set so that all six read the same on the meter. */ gain: number;
}

const ACC = [1, 0.5, 0.6, 0.3, 0.35, 0.2, 0.15, 0.1];
const UPRIGHT: Patch = { w: [1, 0.4, 0.15, 0.05], a: 0.008, d: 0.25, s: 0.3, r: 0.08, lp: 5, level: 0.4 };

export const STATIONS: Station[] = [
  {
    call: 'WDOOF 99.9', gain: 1.5, name: 'Radio for Doofuses', seed: 999, style: 'oompah', bpm: 116, beats: 4, swing: 0, scale: MAJOR, tonic: 'I', keys: [53, 58, 48, 55],
    A: ['I I V7 V7 V7 V7 I I', 'I IV I V7 I IV V7 I', 'I I IV IV V7 V7 I I'],
    B: ['IV IV I I V7 V7 I I7', 'IV I V7 I IV I II7 V7'],
    C: ['vi vi ii ii V7 V7 I V7', 'I I7 IV iv I V7 I I'],
    dens: 0.6, sync: 0.1, oct: 1, kit: 'band',
    bass: { w: 'sawtooth', a: 0.03, d: 0.15, s: 0.7, r: 0.08, lp: 3, level: 0.4 },
    stab: { w: 'square', a: 0.005, d: 0.08, s: 0.3, r: 0.05, lp: 5, det: 8, level: 0.15 },
    pad: { w: ACC, a: 0.02, d: 0.1, s: 0.7, r: 0.06, lp: 8, det: 12, level: 0.08 },
    // The kazoo: a buzz with a nose, a wide wobble, and a scoop up into every note.
    lead: { w: [1, 0.9, 0.8, 1, 1.1, 0.9, 0.6, 0.5, 0.3, 0.3, 0.2, 0.2], a: 0.03, d: 0.2, s: 0.85, r: 0.06, lp: 10, vib: 28, vibHz: 6.3, scoop: 90, breath: 0.06, level: 0.3 },
    lead2: { w: 'sawtooth', a: 0.04, d: 0.2, s: 0.8, r: 0.08, lp: 4, vib: 12, vibHz: 5.5, scoop: 60, level: 0.28 },
    mix: { drums: 0.8, bass: 1, stab: 1, pad: 0.8, lead: 1, lead2: 1 }, wet: 0.08,
  },
  {
    call: 'Low Tide FM', gain: 1.0, name: '88.1, more or less', seed: 881, style: 'lofi', bpm: 78, beats: 4, swing: 0.3, scale: MAJOR, tonic: 'IM7', keys: [52, 57, 50, 55],
    A: ['IM7 iii7 IVM7 iv6 IM7 vi7 ii7 V7', 'IM7 IM7 IVM7 IVM7 ii7 V7 IM7 V7'],
    B: ['IVM7 iv6 iii7 vi7 ii7 ii7 V7 V7', 'vi7 vi7 IVM7 IVM7 ii7 V7 IM7 IM7'],
    C: ['IVM7 V7 iii7 vi7 IVM7 V7 IM7 IM7'],
    dens: 0.35, sync: 0.35, oct: 1, kit: 'lofi',
    bass: { w: 'triangle', a: 0.01, d: 0.3, s: 0.5, r: 0.1, lp: 4, level: 0.42 },
    stab: { w: [1, 0.35, 0.05, 0.12, 0, 0.03], a: 0.004, d: 0.5, s: 0.25, r: 0.25, lp: 8, level: 0.17 },
    pad: { w: [1, 0.35, 0.05, 0.12, 0, 0.03], a: 0.01, d: 1.2, s: 0.3, r: 0.4, lp: 6, level: 0.13 },
    // A guitar with the tremolo arm leaned on.
    lead: { w: [1, 0.5, 0.3, 0.12, 0.08, 0.04], a: 0.006, d: 0.6, s: 0.35, r: 0.25, lp: 7, vib: 10, vibHz: 5, scoop: 45, level: 0.32 },
    lead2: { w: [1, 0, 0, 0.25, 0, 0, 0, 0, 0, 0.06], a: 0.002, d: 0.7, s: 0.05, r: 0.3, lp: 12, level: 0.3 },
    mix: { drums: 0.75, bass: 1, stab: 1, pad: 1, lead: 1, lead2: 1 }, trem: [0.35, 5.5], wet: 0.25, hiss: 0.006,
  },
  {
    call: 'Ledger 1040', gain: 1.1, name: 'Music to file by', seed: 1040, style: 'bossa', bpm: 132, beats: 4, swing: 0, scale: MAJOR, tonic: 'IM7', keys: [48, 53, 51, 55],
    A: ['IM7 vi7 ii7 V7 IM7 vi7 ii7 V7', 'IM7 IM7 ii7 V7 iii7 VI7 ii7 V7', 'I6 I6 ii7 V7 ii7 V7 IM7 IM7'],
    B: ['IVM7 IVM7 iii7 VI7 ii7 ii7 V7 V7', 'ii7 V7 IM7 IM7 iv7 bVII7 IM7 V7'],
    C: ['vi7 II7 ii7 V7 vi7 II7 ii7 V7'],
    dens: 0.5, sync: 0.5, oct: 1, kit: 'band',
    bass: UPRIGHT,
    stab: { w: [1, 0.6, 0.35, 0.2, 0.1, 0.06], a: 0.003, d: 0.18, s: 0.1, r: 0.08, lp: 6, level: 0.13 },
    pad: { w: [1, 0.35, 0.05, 0.12], a: 0.02, d: 0.8, s: 0.4, r: 0.3, lp: 5, level: 0.08 },
    lead: { w: [1, 0.25, 0.08, 0.03], a: 0.05, d: 0.2, s: 0.8, r: 0.08, lp: 6, vib: 14, vibHz: 5.2, breath: 0.12, level: 0.3 },
    lead2: { w: [1, 0, 0, 0.25, 0, 0, 0, 0, 0, 0.06], a: 0.002, d: 0.7, s: 0.05, r: 0.3, lp: 12, level: 0.32 },
    mix: { drums: 0.7, bass: 1, stab: 1, pad: 1, lead: 1, lead2: 1 }, wet: 0.14,
  },
  {
    call: 'The Cannery 88', gain: 1.7, name: 'Shift work', seed: 88, style: 'funk', bpm: 104, beats: 4, swing: 0, scale: DORIAN, tonic: 'i7', keys: [52, 57, 50, 55],
    A: ['i7 i7 IV7 IV7 i7 i7 IV7 IV7', 'i7 i7 i7 IV7 i7 i7 bVII IV7'],
    B: ['bVI bVII i7 i7 bVI bVII V7 V7', 'iv7 iv7 i7 i7 bVI bVI V7 V7'],
    C: ['i7 i7 i7 i7 IV7 IV7 i7 V7'],
    dens: 0.55, sync: 0.6, oct: 1, kit: 'box',
    bass: { w: 'sawtooth', a: 0.004, d: 0.09, s: 0.35, r: 0.04, lp: 3.5, lpEnv: 3, level: 0.4 },
    stab: { w: 'square', a: 0.002, d: 0.06, s: 0.15, r: 0.03, lp: 9, level: 0.085 },
    pad: { w: 'sawtooth', a: 0.02, d: 0.15, s: 0.6, r: 0.06, lp: 5, lpEnv: 1.5, det: 10, level: 0.085 },
    lead: { w: 'sawtooth', a: 0.01, d: 0.15, s: 0.7, r: 0.06, lp: 5, lpEnv: 2, vib: 12, vibHz: 5.5, det: 7, level: 0.19 },
    lead2: { w: 'square', a: 0.008, d: 0.12, s: 0.7, r: 0.05, lp: 6, lpEnv: 2, vib: 10, vibHz: 6, level: 0.17 },
    mix: { drums: 1, bass: 1, stab: 1, pad: 1, lead: 1, lead2: 1 }, wet: 0.08,
  },
  {
    call: 'Radio Fishbone', gain: 0.9, name: 'Old town, old tunes', seed: 1851, style: 'waltz', bpm: 152, beats: 3, swing: 0, scale: MINOR, tonic: 'i', keys: [50, 45, 52, 47],
    A: ['i i iv iv V7 V7 i i', 'i bVII bIII bIII iv iv V7 V7', 'i iv i V7 i iv V7 i'],
    B: ['bIII bIII bVII bVII iv iv V7 V7', 'bVI bVI bIII bIII iv iv V7 V7'],
    C: ['iv iv i i V7 V7 i i'],
    dens: 0.6, sync: 0.05, oct: 2, kit: 'band',
    bass: UPRIGHT,
    stab: { w: ACC, a: 0.02, d: 0.1, s: 0.7, r: 0.06, lp: 8, det: 12, level: 0.1 },
    pad: { w: ACC, a: 0.06, d: 0.2, s: 0.8, r: 0.12, lp: 6, det: 12, level: 0.055 },
    // A tin whistle: nearly a sine, a lot of air, a flick up into the note.
    lead: { w: [1, 0.12, 0.04], a: 0.035, d: 0.1, s: 0.9, r: 0.05, lp: 6, vib: 18, vibHz: 5.8, scoop: 70, breath: 0.2, level: 0.26 },
    lead2: { w: ACC, a: 0.03, d: 0.1, s: 0.8, r: 0.06, lp: 8, det: 9, vib: 10, vibHz: 5.5, level: 0.2 },
    mix: { drums: 0.7, bass: 1, stab: 1, pad: 1, lead: 1, lead2: 1 }, wet: 0.2,
  },
  {
    // Tepid Falls' own, on the air once there is a bridge to carry it: one home organ, one rhythm box, one long afternoon.
    call: 'WTPD 610 AM', gain: 2.1, name: 'The Lukewarm Sound of Tepid Falls', seed: 610, style: 'chacha', bpm: 118, beats: 4, swing: 0, scale: MAJOR, tonic: 'I', keys: [48, 53, 55, 58],
    A: ['I I ii V7 ii V7 I I', 'I vi ii V7 I vi ii V7', 'I I6 IV IV V7 V7 I V7'],
    B: ['IV IV I I ii V7 I I7', 'IV iv I VI7 ii V7 I I'],
    C: ['vi vi ii ii IV V7 I V7'],
    dens: 0.5, sync: 0.25, oct: 1, kit: 'box',
    bass: { w: [1, 0.5, 0, 0.1], a: 0.01, d: 0.1, s: 0.8, r: 0.05, lp: 6, level: 0.45 },
    stab: { w: [1, 0.8, 0.5, 0.4, 0, 0.25, 0, 0.2], a: 0.004, d: 0.05, s: 0.6, r: 0.03, lp: 10, level: 0.075 },
    pad: { w: [1, 0.8, 0.5, 0.4, 0, 0.25, 0, 0.2], a: 0.01, d: 0.1, s: 0.9, r: 0.05, lp: 8, level: 0.05 },
    lead: { w: [1, 0.9, 0.6, 0.5, 0, 0.3, 0, 0.3], a: 0.006, d: 0.05, s: 0.9, r: 0.04, lp: 10, vib: 14, vibHz: 6.6, level: 0.19 },
    lead2: { w: [1, 0.3, 0.9, 0.2, 0, 0.5, 0, 0.4], a: 0.006, d: 0.05, s: 0.9, r: 0.04, lp: 12, vib: 16, vibHz: 6.6, level: 0.15 },
    mix: { drums: 0.8, bass: 1, stab: 1, pad: 1, lead: 1, lead2: 1 }, trem: [0.2, 6.6], wet: 0.1, am: true, hiss: 0.012,
  },  // The Christmas station (audio/carols.ts), on the air in the holiday season only: onAir() below.
  CAROLS,
];

// ── The composer ─────────────────────────────────────────────────────────────

const FORM: readonly (readonly [string, number])[] = [['ident', 2], ['intro', 4], ['A', 8], ['A2', 8], ['B', 8], ['A3', 8], ['C', 8], ['B2', 8], ['A4', 8], ['outro', 4]];
export const SONG_BARS = FORM.reduce((n, f) => n + f[1], 0);
export const barSeconds = (st: Station): number => (60 / st.bpm) * st.beats;

interface Motif { rh: [number, number][][]; deg: number[][]; seq: number }
interface Song { key: number; A: string[]; B: string[]; C: string[]; riff: [number, number, number][]; kick: number[]; clav: number[] }
const songs = new Map<string, Song>(), motifs = new Map<string, Motif>();
const rngFor = (st: Station, song: number, salt: number): (() => number) => mulberry((st.seed * 7919 + song * 104729 + salt * 1299709) >>> 0);
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length) % a.length];

function songOf(st: Station, n: number): Song {
  const k = st.call + n;
  let s = songs.get(k);
  if (s) return s;
  if (songs.size > 12) songs.clear();
  const r = rngFor(st, n, 1);
  // A funk bass riff: the one, then a scatter of syncopations on the root, its octave, the seventh and the fifth.
  const riff: [number, number, number][] = [[0, 2, 0]];
  for (const p of [3, 4, 6, 7, 10, 11, 12, 14]) if (r() < 0.45) riff.push([p, r() < 0.3 ? 2 : 1, pick(r, [0, 0, 12, 10, 7, 12])]);
  s = {
    key: st.keys[n === 0 ? 0 : Math.floor(r() * st.keys.length)],
    A: pick(r, st.A).split(' '), B: pick(r, st.B).split(' '), C: pick(r, st.C).split(' '),
    riff, kick: pick(r, [[0, 6, 10], [0, 3, 8, 10], [0, 7, 10, 11], [0, 6, 8, 11]]), clav: [2, 5, 8, 11, 14].filter(() => r() < 0.65),
  };
  songs.set(k, s);
  return s;
}

/** Two bars of tune: a rhythm built beat by beat from a few cells, and a line that mostly moves by step. */
function motifOf(st: Station, song: number, letter: string): Motif {
  const k = st.call + song + letter;
  let m = motifs.get(k);
  if (m) return m;
  if (motifs.size > 40) motifs.clear();
  const r = rngFor(st, song, letter.charCodeAt(0));
  const dens = st.dens + (letter === 'C' ? 0.2 : 0), bar = st.beats * 4;
  const rh: [number, number][][] = [[], []], deg: number[][] = [[], []];
  let cur = pick(r, [0, 2, 4, 4, 7]);
  for (let b = 0; b < 2; b++) {
    for (let beat = 0; beat < st.beats; beat++) {
      const s = beat * 4, first = b === 0 && beat === 0;
      if (!first && r() > dens + 0.25) continue;
      const c = r();
      if (c < 0.22 && beat < st.beats - 1) { rh[b].push([s, 8]); beat++; }
      else if (c < 0.5 - st.sync * 0.3) rh[b].push([s, 4]);
      else if (c < 0.78 - st.sync * 0.2) { rh[b].push([s, 2]); rh[b].push([s + 2, 2]); }
      else if (c < 0.78 + st.sync * 0.2 && !first) rh[b].push([s + 2, beat < st.beats - 1 ? 4 : 2]);
      else { rh[b].push([s, 3]); rh[b].push([s + 3, 1]); }
    }
    if (!rh[b].length) rh[b].push([0, 4]);
    // No note runs into the next one, and the phrase's last note is held.
    for (let i = 0; i < rh[b].length - 1; i++) rh[b][i][1] = Math.min(rh[b][i][1], rh[b][i + 1][0] - rh[b][i][0]);
    const last = rh[b][rh[b].length - 1];
    if (b === 1) last[1] = Math.max(last[1], Math.min(8, bar - last[0] - 2)); else last[1] = Math.min(last[1], bar - last[0]);
    for (let i = 0; i < rh[b].length; i++) {
      deg[b].push(cur);
      // Up in the first bar, down in the second: an arch, more often than not.
      const u = r() + (b === 0 ? 0.12 : -0.12);
      cur += u < 0.1 ? -3 : u < 0.22 ? -2 : u < 0.47 ? -1 : u < 0.55 ? 0 : u < 0.8 ? 1 : u < 0.92 ? 2 : 3;
      cur = cur < -3 ? cur + 3 : cur > 9 ? cur - 3 : cur;
    }
  }
  m = { rh, deg, seq: pick(r, [-1, 1, 1, 2, -2]) };
  motifs.set(k, m);
  return m;
}

/** A chord voiced in the octave from `lo` up. */
function voice(c: Chord, key: number, lo: number, out: number[]): number[] {
  out.length = 0;
  for (const t of c.tones) { let m = key + c.root + t; while (m < lo) m += 12; while (m >= lo + 12) m -= 12; out.push(m); }
  return out.sort((a, b) => a - b);
}
const low = (c: Chord, key: number, tone: number, lo = 36): number => { let m = key + c.root + c.tones[tone % c.tones.length]; while (m < lo) m += 12; while (m >= lo + 12) m -= 12; return m; };
const NOTES: number[] = [];

export function compose(st: Station, bar: number): Bar {
  const song = Math.floor(bar / SONG_BARS), sg = songOf(st, song), ev: Ev[] = [];
  let n = bar - song * SONG_BARS, fi = 0;
  while (n >= FORM[fi][1]) { n -= FORM[fi][1]; fi++; }
  const sec = FORM[fi][0], of = FORM[fi][1], L = sec === 'outro' ? 'A' : sec[0], variant = (Number(sec.slice(1)) || 1) - 1;
  const steps = st.beats * 4, r = rngFor(st, song, 1000 + bar);
  // The ident is the station's own and never changes key; everything else is the song's.
  const key = sec === 'ident' ? st.keys[0] : sg.key;
  const prog = L === 'B' ? sg.B : L === 'C' ? sg.C : sg.A;
  const tok = sec === 'ident' ? st.tonic : sec === 'intro' ? prog[n] : sec === 'outro' ? (n === 3 ? st.tonic : n === 2 ? 'V7' : prog[4 + n]) : prog[n];
  const c = chord(tok), end = sec === 'outro' && n === 3, fill = n === of - 1 && sec !== 'outro' && sec !== 'ident';
  const add = (i: Inst, s: number, d: number, m: number, v: number): void => { ev.push({ s, d, i, m, v }); };
  const stabAt = (s: number, d: number, v: number, i: Inst = 'stab', lo = key + 7): void => { for (const m of voice(c, key, lo, NOTES)) add(i, s, d, m, v); };

  if (sec === 'ident') {
    // The sting: the same handful of notes every time, climbing the tonic chord to its octave, and a button on the end.
    const ir = mulberry(st.seed * 31 + 7), ds = [0, 2, 4, 7, 9];
    if (n === 0) { let d = pick(ir, [0, 2, 4]); for (let s = 0; s < steps; s += 2) { add('lead', s, 2, key + 12 * st.oct + degSemi(st.scale, d), 0.9); d += pick(ir, [1, 2, 2, -1, 3]); if (d > 9) d -= 4; } add('crash', 0, 4, 0, 0.6); add('kick', 0, 2, 0, 0.9); }
    else {
      for (let i = 0; i < 9; i++) ir();
      add('lead', 0, 2, key + 12 * st.oct + degSemi(st.scale, pick(ir, ds)), 0.9); add('lead', 2, 2, key + 12 * st.oct + degSemi(st.scale, 4), 0.9);
      add('lead', 4, steps - 6, key + 12 * st.oct + 12, 1); add('lead2', 4, steps - 6, key + 12 * st.oct + 7, 0.6);
      stabAt(4, steps - 6, 0.8, 'pad'); add('bass', 4, steps - 6, low(c, key, 0), 1); add('kick', 4, 2, 0, 1); add('crash', 4, 4, 0, 0.8); add('snare', 0, 1, 0, 0.6); add('snare', 2, 1, 0, 0.8);
    }
    return { song, sec, n, of, key, chord: c, ev };
  }

  // ── The band ──
  if (end) {
    // Everybody lands on the tonic and stays there.
    add('bass', 0, steps - 2, low(c, key, 0), 1); stabAt(0, steps - 2, 0.8, 'pad'); stabAt(0, 3, 0.9); add('kick', 0, 2, 0, 1); add('crash', 0, 4, 0, 0.8);
    add('lead', 0, steps - 2, key + 12 * st.oct + (st.oct > 1 ? 0 : 12), 1);
    return { song, sec, n, of, key, chord: c, ev };
  }
  const style = st.style, loud = variant >= 3 || L === 'C' ? 1 : 0.9, alt = n % 2 === 1;
  if (n === 0 && sec !== 'intro') add('crash', 0, 4, 0, 0.5);
  if (style === 'oompah') {
    add('bass', 0, 3, low(c, key, 0), 1); add('bass', 8, 3, low(c, key, 2, 34), 0.9);
    stabAt(4, 1.5, 0.8); stabAt(12, 1.5, 0.8);
    if (variant >= 1 && alt) { stabAt(6, 1, 0.5); stabAt(14, 1, 0.5); }
    add('kick', 0, 2, 0, 0.9); add('kick', 8, 2, 0, 0.8); add('snare', 4, 1, 0, 0.5); add('snare', 12, 1, 0, 0.55);
    if (L === 'C') for (let s = 2; s < 16; s += 4) add('hat', s, 1, 0, 0.4);
    if (fill) { for (let s = 12; s < 16; s++) add('snare', s, 1, 0, 0.45 + (s - 12) * 0.15); add('tom', 10, 1, 1, 0.7); add('tom', 11, 1, 2, 0.7); }
  } else if (style === 'lofi') {
    add('bass', 0, 6, low(c, key, 0), 1); add('bass', 10, 4, low(c, key, r() < 0.6 ? 2 : 0, 40), 0.8);
    stabAt(0, 14, 0.7, 'pad', key + 4); stabAt(6, 2, 0.6); if (alt) stabAt(14, 2, 0.45);
    add('kick', 0, 2, 0, 0.9); add('kick', 10, 2, 0, 0.75); if (r() < 0.35) add('kick', 7, 1, 0, 0.5);
    add('snare', 4, 1, 0, 0.6); add('snare', 12, 1, 0, 0.65);
    for (let s = 0; s < 16; s += 2) add('hat', s, 1, 0, s % 4 ? 0.3 : 0.5);
    if (fill) { add('tom', 10, 1, 0, 0.6); add('tom', 12, 1, 1, 0.65); add('tom', 14, 1, 2, 0.7); }
  } else if (style === 'bossa') {
    add('bass', 0, 5, low(c, key, 0), 1); add('bass', 6, 2, low(c, key, 2, 34), 0.7); add('bass', 8, 5, low(c, key, 2, 34), 0.9); add('bass', 14, 2, low(c, key, 0), 0.7);
    for (const s of alt ? [2, 5, 8, 11, 14] : [0, 3, 6, 10, 13]) stabAt(s, 2, s % 4 === 0 ? 0.75 : 0.6);
    for (const s of [0, 3, 6, 10, 12]) add('rim', s, 1, 0, 0.6);
    for (let s = 0; s < 16; s += 2) add('shaker', s, 1, 0, s % 4 === 2 ? 0.7 : 0.4);
    add('kick', 0, 2, 0, 0.45); add('kick', 8, 2, 0, 0.4);
    if (L === 'B') stabAt(0, 15, 0.6, 'pad', key + 12);
    if (fill) { for (const s of [12, 13, 14, 15]) add('rim', s, 1, 0, 0.5 + (s - 12) * 0.1); add('tom', 14, 1, 1, 0.5); }
  } else if (style === 'funk') {
    for (const k of sg.kick) add('kick', k, 2, 0, k === 0 ? 1 : 0.85);
    add('snare', 4, 1, 0, 0.9); add('snare', 12, 1, 0, 0.95); add('clap', 12, 1, 0, 0.6);
    if (r() < 0.5) add('snare', pick(r, [7, 9, 15]), 1, 0, 0.25);
    const open = alt ? 14 : -1;
    for (let s = 0; s < 16; s++) if (s !== open) add('hat', s, 1, 0, s % 4 === 0 ? 0.6 : s % 2 === 0 ? 0.42 : 0.24);
    if (open >= 0) add('ohat', open, 2, 0, 0.5);
    if (sec !== 'intro' || n >= 2) for (const [s, d, o] of sg.riff) add('bass', s, d, low(c, key, 0) + (o === 10 ? (c.tones.includes(10) ? 10 : 7) : o), s === 0 ? 1 : 0.8);
    else add('bass', 0, 2, low(c, key, 0), 1);
    for (const s of sg.clav) stabAt(s, 1, 0.7, 'stab', key + 12);
    if (L === 'B' || variant >= 3) { stabAt(0, 3, 0.8, 'pad', key + 12); stabAt(6, 2, 0.7, 'pad', key + 12); }
    if (fill) { for (let s = 8; s < 16; s++) add('snare', s, 1, 0, 0.3 + (s - 8) * 0.08); add('tom', 13, 1, 0, 0.7); add('tom', 14, 1, 1, 0.75); add('tom', 15, 1, 2, 0.8); }
  } else if (style === 'waltz') {
    add('bass', 0, 4, low(c, key, alt ? 2 : 0, alt ? 34 : 36), 1);
    stabAt(4, 2.5, 0.7); stabAt(8, 2.5, 0.65);
    add('kick', 0, 2, 0, 0.55); add('shaker', 4, 1, 0, 0.5); add('shaker', 8, 1, 0, 0.5);
    if (L !== 'A') stabAt(0, 11, 0.7, 'pad', key);
    if (fill) { add('bass', 8, 2, low(c, key, 2, 34), 0.8); add('bass', 10, 2, low(c, key, 1, 34), 0.8); stabAt(10, 1.5, 0.6); add('snare', 8, 1, 0, 0.4); add('snare', 10, 1, 0, 0.5); }
  } else {
    add('bass', 0, 4, low(c, key, 0), 1); add('bass', 8, 4, low(c, key, 2, 34), 0.9); add('bass', 14, 2, low(c, key, 0), 0.7);
    stabAt(0, 15, 0.8, 'pad', key + 12);
    for (const s of [2, 6, 10, 14]) stabAt(s, 1.5, 0.7);
    add('kick', 0, 2, 0, 0.8); add('kick', 8, 2, 0, 0.7);
    for (const s of [0, 4, 8, 12]) add('block', s, 1, 0, 0.5);
    // Cha-cha-cha.
    for (const s of [8, 10, 12]) add('rim', s, 1, 0, 0.7);
    for (let s = 0; s < 16; s += 2) add('shaker', s, 1, 0, s % 4 === 2 ? 0.6 : 0.35);
    if (fill) for (const [s, m] of [[8, 0], [10, 0], [12, 1], [14, 2]]) add('tom', s, 1, m, 0.65);
  }

  // ── The tune ──
  if (sec === 'intro') return { song, sec, n, of, key, chord: c, ev };
  const m = motifOf(st, song, L), pair = n >> 1, which = n & 1;
  const inst: Inst = L === 'C' ? 'lead2' : 'lead', base = key + 12 * st.oct;
  const cadence = (sec === 'outro' ? n === 3 : pair === 3 && which === 1);
  if (cadence) {
    // The phrase comes to rest: on the tonic if the harmony is home, on a chord tone of wherever it has stopped if not.
    const home = c.root === 0, td = home ? (m.deg[1][0] > 4 ? 7 : 0) : 1, semi = fit(c, st.scale, degSemi(st.scale, td), true);
    add(inst, 0, 2, base + fit(c, st.scale, degSemi(st.scale, td + 1), false), 0.8 * loud);
    add(inst, 2, steps - 6, base + semi, 0.9 * loud);
  } else {
    const shift = sec === 'outro' ? 0 : pair === 1 ? m.seq : 0, rh = m.rh[which], dg = m.deg[which];
    for (let i = 0; i < rh.length; i++) {
      const [s, d] = rh[i], strong = s === 0 || (s % 4 === 0 && d >= 4);
      const semi = fit(c, st.scale, degSemi(st.scale, dg[i] + shift), strong);
      // Later in the song a held note gets an upper neighbour run into it.
      if (variant >= 2 && d >= 4 && r() < 0.4) { add(inst, s, 2, base + degSemi(st.scale, dg[i] + shift + 1), 0.7 * loud); add(inst, s + 2, d - 2, base + semi, 0.85 * loud); }
      else add(inst, s, d, base + semi, (strong ? 0.9 : 0.75) * loud);
      // And from the second time round, somebody sings along a third below.
      if (variant >= 1 && L === 'A') { const h = fit(c, st.scale, degSemi(st.scale, dg[i] + shift - 2), true); if (h !== semi) add('lead2', s, d, base + h, 0.4); }
    }
  }
  return { song, sec, n, of, key, chord: c, ev };
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = (m: number): string => NAMES[mod(m, 12)] + (Math.floor(m / 12) - 1);
/** Bars as lines of text, for reading: section, chord, the tune, the bass, the drums on a sixteenth grid. */
export function score(st: Station, from: number, count: number): string[] {
  const out: string[] = [];
  for (let b = from; b < from + count; b++) {
    const bar = compose(st, b), steps = st.beats * 4;
    const line = (i: Inst): string => bar.ev.filter((e) => e.i === i).sort((a, c) => a.s - c.s).map((e) => `${noteName(e.m)}@${e.s}/${e.d}`).join(' ');
    const grid = (i: Inst, ch: string): string => { const g = new Array<string>(steps).fill('.'); for (const e of bar.ev) if (e.i === i) g[Math.floor(e.s)] = ch; return g.join(''); };
    const chordNotes = [...new Set(bar.ev.filter((e) => e.i === 'stab').map((e) => noteName(e.m)))].join(',');
    out.push(`${String(b).padStart(3)} ${(bar.sec + ' ' + (bar.n + 1) + '/' + bar.of).padEnd(10)} ${noteName(bar.key).replace(/\d/, '')}: ${bar.chord.name.padEnd(5)} | ${line(bar.sec[0] === 'C' ? 'lead2' : 'lead').padEnd(52)} | bass ${line('bass').padEnd(34)} | K ${grid('kick', 'x')} S ${grid('snare', 'o')} T ${grid('tom', 't')} | ${chordNotes}`);
  }
  return out;
}

// ── The band ─────────────────────────────────────────────────────────────────

const LOOK = 0.28;
const waveCache = new WeakMap<AudioCore, Map<Patch, PeriodicWave>>();
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

function tone(core: AudioCore, p: Patch, out: AudioNode, t: number, midi: number, dur: number, vel: number): void {
  const f = midiHz(midi), end = t + dur;
  let wave: OscillatorType | PeriodicWave;
  if (typeof p.w === 'string') wave = p.w;
  else {
    let m = waveCache.get(core);
    if (!m) waveCache.set(core, (m = new Map()));
    let w = m.get(p);
    if (!w) m.set(p, (w = core.wave(p.w)));
    wave = w;
  }
  const lp = core.filter('lowpass', Math.min(9000, f * p.lp), 0.8), g = core.gain(0), peak = vel * p.level;
  if (p.lpEnv) { lp.frequency.setValueAtTime(Math.min(11000, f * p.lp * (1 + p.lpEnv)), t); lp.frequency.setTargetAtTime(Math.min(9000, f * p.lp), t, p.d); }
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + p.a);
  g.gain.setTargetAtTime(peak * p.s, t + p.a, p.d);
  g.gain.setTargetAtTime(0, Math.max(end, t + p.a + 0.01), p.r / 3);
  const stop = Math.max(end, t + p.a) + p.r * 2 + 0.05;
  lp.connect(g); g.connect(out);
  const n = p.det ? 2 : 1;
  let vib: GainNode | null = null;
  if (p.vib) {
    const o = core.osc('sine', p.vibHz ?? 5.5);
    vib = core.gain(0);
    // The wobble arrives once the note has settled.
    vib.gain.setValueAtTime(0, t); vib.gain.linearRampToValueAtTime(p.vib, t + Math.min(0.25, dur * 0.6));
    o.connect(vib); o.start(t); o.stop(stop);
  }
  for (let i = 0; i < n; i++) {
    const o = core.osc(wave, f);
    if (i) o.detune.value = p.det ?? 0;
    if (p.scoop) { o.detune.setValueAtTime(-p.scoop + (i ? p.det ?? 0 : 0), t); o.detune.linearRampToValueAtTime(i ? p.det ?? 0 : 0, t + 0.07); }
    if (vib) vib.connect(o.detune);
    o.connect(lp); o.start(t); o.stop(stop);
  }
  if (p.breath) {
    const s = core.burst('white', t, stop - t), b = core.filter('bandpass', Math.min(8000, f * 2), 1.5), bg = core.gain(0);
    bg.gain.setValueAtTime(0, t); bg.gain.linearRampToValueAtTime(peak * p.breath * 3, t + p.a); bg.gain.setTargetAtTime(peak * p.breath, t + p.a, 0.08); bg.gain.setTargetAtTime(0, Math.max(end, t + p.a + 0.01), p.r / 3);
    s.connect(b); b.connect(bg); bg.connect(out);
  }
}

function drum(core: AudioCore, kit: Station['kit'], out: AudioNode, t: number, i: Inst, m: number, v: number): void {
  if (i === 'kick') {
    if (kit === 'box') { thud(core, t, out, 150, 44, v * 0.9, 0.24); hiss(core, t, out, 'white', 'lowpass', 3000, 0.5, v * 0.12, 0.0005, 0.008); }
    else if (kit === 'lofi') { thud(core, t, out, 115, 46, v * 0.85, 0.2); }
    else { thud(core, t, out, 105, 50, v * 0.7, 0.14); hiss(core, t, out, 'pink', 'lowpass', 320, 0.6, v * 0.3, 0.002, 0.05); }
  } else if (i === 'snare') {
    if (kit === 'lofi') { hiss(core, t, out, 'pink', 'bandpass', 2400, 0.8, v * 0.5, 0.008, 0.09); thud(core, t, out, 190, 150, v * 0.15, 0.05); }
    else { hiss(core, t, out, 'white', 'bandpass', kit === 'box' ? 2100 : 1800, 0.7, v * 0.7, 0.001, kit === 'box' ? 0.12 : 0.08); thud(core, t, out, 215, 165, v * 0.3, 0.06); }
  } else if (i === 'hat') hiss(core, t, out, 'white', 'highpass', kit === 'lofi' ? 6000 : 7500, 0.5, v * 0.4, 0.001, 0.028);
  else if (i === 'ohat') hiss(core, t, out, 'white', 'highpass', 7000, 0.5, v * 0.36, 0.002, 0.2);
  else if (i === 'rim') { ping(core, t, out, 1750, v * 0.22, 0.03, 'triangle'); hiss(core, t, out, 'white', 'bandpass', 2600, 4, v * 0.5, 0.0005, 0.012); }
  else if (i === 'shaker') hiss(core, t, out, 'white', 'bandpass', 6200, 1, v * 0.4, 0.012, 0.04);
  else if (i === 'tom') { const f = [185, 140, 104][m] ?? 140; thud(core, t, out, f, f * 0.6, v * 0.6, 0.17); }
  else if (i === 'crash') hiss(core, t, out, 'white', 'highpass', 4500, 0.5, v * 0.3, 0.002, 0.9);
  else if (i === 'clap') { for (let k = 0; k < 3; k++) hiss(core, t + k * 0.011, out, 'white', 'bandpass', 1300, 1.2, v * 0.35, 0.001, k === 2 ? 0.09 : 0.012); }
  else if (i === 'block') { ping(core, t, out, 562, v * 0.2, 0.09, 'square'); ping(core, t, out, 845, v * 0.14, 0.07, 'square'); }
}

/** A station playing: its channels, and the pump that keeps a quarter of a second of notes scheduled. */
export class StationPlayer {
  readonly out: GainNode;
  /** The DJ talks over the song: voices.ts pulls this down while they do. */
  readonly duck: GainNode;
  private readonly ch: Record<'drums' | 'bass' | 'stab' | 'pad' | 'lead' | 'lead2', GainNode>;
  private readonly src: AudioScheduledSourceNode[] = [];
  private bar = 0; private barT = 0; private idx = 0;
  private cur: Bar | null = null;
  private readonly stepDur: number;
  /** Notes started since it was tuned in (for the tests). */
  notes = 0;

  constructor(private readonly core: AudioCore, readonly st: Station, dest: AudioNode) {
    const c = core;
    this.stepDur = 60 / st.bpm / 4;
    this.out = c.gain(0);
    const sum = c.gain(st.gain);
    // A dashboard speaker: nothing much under 80 Hz or over 7 kHz.
    let tail: AudioNode = sum;
    const chain = (n: AudioNode): void => { tail.connect(n); tail = n; };
    chain(c.filter('highpass', st.am ? 300 : 80, 0.7));
    chain(c.filter('lowpass', st.am ? 3400 : 7200, 0.7));
    if (st.am) chain(c.filter('peaking', 1400, 0.8, 5));
    tail.connect(this.out);
    this.duck = c.gain(1);
    this.out.connect(this.duck); this.duck.connect(dest);
    const send = c.gain(st.wet); this.duck.connect(send); send.connect(c.reverbFor('music'));
    const mk = (level: number, pan: number): GainNode => { const g = c.gain(level), p = c.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(sum); return g; };
    this.ch = { drums: mk(st.mix.drums, 0), bass: mk(st.mix.bass, 0), stab: mk(st.mix.stab, -0.3), pad: mk(st.mix.pad, 0.25), lead: mk(st.mix.lead, 0.08), lead2: mk(st.mix.lead2, -0.15) };
    if (st.trem) {
      const o = c.osc('sine', st.trem[1]), g = c.gain(st.trem[0] * st.mix.lead * 0.5);
      this.ch.lead.gain.value = st.mix.lead * (1 - st.trem[0] * 0.5);
      o.connect(g); g.connect(this.ch.lead.gain); o.start(); this.src.push(o);
    }
    if (st.hiss) { const s = c.noiseSrc('pink'), g = c.gain(st.hiss); s.connect(g); g.connect(sum); this.src.push(s); }
  }

  /** Join the broadcast: `clock` is how long the station has been on the air, `t` the audio time that corresponds to. */
  start(t: number, clock: number, fade = 0.25): void {
    const bs = barSeconds(this.st), pos = clock / bs;
    this.bar = Math.floor(pos);
    this.barT = t - (pos - this.bar) * bs;
    this.cur = compose(this.st, this.bar);
    // Drum hits already past are gone, but a note still sounding is picked up where it is: no bar of silence after the dial stops.
    this.idx = 0;
    this.cur.ev.sort((a, b) => a.s - b.s);
    for (; this.idx < this.cur.ev.length && this.time(this.cur.ev[this.idx].s) < t; this.idx++) {
      const e = this.cur.ev[this.idx], i = e.i, left = this.time(e.s + e.d) - t;
      if (left > 0.25 && (i === 'bass' || i === 'stab' || i === 'pad' || i === 'lead' || i === 'lead2')) tone(this.core, this.st[i], this.ch[i], t, e.m, left * 0.92, e.v * 0.9);
    }
    this.out.gain.setValueAtTime(0, t); this.out.gain.linearRampToValueAtTime(1, t + fade);
  }

  /** Bar-relative sixteenths to audio time, with the swing: the off eighth of each beat is late. */
  private time(s: number): number {
    const w = this.st.swing;
    if (w) { const b = Math.floor(s / 4) * 4, x = s - b; s = b + (x < 2 ? x * (1 + w) : 2 + 2 * w + (x - 2) * (1 - w)); }
    return this.barT + s * this.stepDur;
  }

  /** Schedule everything that starts before now + ahead. */
  pump(now: number, ahead = LOOK): void {
    const st = this.st, c = this.core, limit = now + ahead, bs = barSeconds(st);
    for (;;) {
      const bar = this.cur;
      if (!bar) return;
      while (this.idx < bar.ev.length) {
        const e = bar.ev[this.idx], t = this.time(e.s);
        if (t >= limit) return;
        this.idx++; this.notes++;
        const at = t < now ? now : t, i = e.i;
        if (i === 'bass' || i === 'stab' || i === 'pad' || i === 'lead' || i === 'lead2') tone(c, st[i], this.ch[i], at, e.m, e.d * this.stepDur * 0.92, e.v);
        else drum(c, st.kit, this.ch.drums, at, i, e.m, e.v);
      }
      if (this.barT + bs >= limit) return;
      this.bar++; this.barT += bs; this.idx = 0;
      this.cur = compose(st, this.bar);
      this.cur.ev.sort((a, b) => a.s - b.s);
    }
  }

  stop(t: number): void {
    this.cur = null;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.06);
    for (const s of this.src) { try { s.stop(t + 0.5); } catch { /* already stopped */ } }
    // What is still ringing rings into a closed gate; half a second on, the lot is unplugged.
    if (typeof window !== 'undefined') window.setTimeout(() => this.out.disconnect(), 700);
  }
}

/** Between stations: a third of a second of the ether. */
export function staticBurst(core: AudioCore, t: number, out: AudioNode, r: () => number): void {
  const b = hiss(core, t, out, 'white', 'bandpass', 1800, 0.8, 0.3, 0.01, 0.3);
  b.frequency.setValueAtTime(900 + r() * 800, t); b.frequency.exponentialRampToValueAtTime(3200 + r() * 1500, t + 0.3);
  hiss(core, t, out, 'pink', 'lowpass', 2500, 0.5, 0.25, 0.005, 0.22);
  // A carrier whistling past.
  const o = core.osc('sine', 2400), g = core.gain(0);
  o.frequency.setValueAtTime(600 + r() * 2500, t); o.frequency.exponentialRampToValueAtTime(300 + r() * 4000, t + 0.25);
  core.env(g.gain, t, 0.01, 0.06, 0.24);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.32);
  for (let i = 0; i < 4; i++) hiss(core, t + r() * 0.25, out, 'white', 'highpass', 3000, 0.5, 0.25, 0.0005, 0.006);
}

// ── The part the game runs ───────────────────────────────────────────────────

export class Radio {
  /**
   * The dial: -1 off, 0 Claude FM (the live stream, src/audio/claudefm.ts, and the default), then 1.. for
   * STATIONS[0..]. Saved as save.data.settings.station.
   */
  station: number;
  player: StationPlayer | null = null;
  /** Claude FM's hidden YouTube player. Loads nothing until she first tunes to it. */
  readonly fm: ClaudeFM;
  private wasIn = false;
  private paused = false;

  constructor(private readonly core: AudioCore, private readonly game: Game) {
    this.station = Math.min(save.data.settings.station, this.count() - 1);
    this.voice = new RadioVoice(core);
    this.fm = new ClaudeFM((why) => {
      console.warn('Claude FM unavailable: ' + why);
      // Silently over to the first generated station, with a word on the HUD; never in the way of the game.
      if (this.station === 0) {
        this.station = 1;
        if (this.game.player.seated) { this.game.hud.toast('Claude FM is off the air. Over to ' + STATIONS[0].call + '.', 3.5); this.show(); }
      }
    });
    this.fmDj = new ClaudeFMDJ(core, this.fm, (t) => this.game.hud.toast(t, 6));
    this.hookMoments();
    game.on('pause', (e) => { this.paused = e.on; if (e.on) this.fm.pause(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.fm.pause(); });
  }

  /** How many places on the dial: Claude FM, then the generated stations; Tepid Falls' transmitter does not reach until the bridge does. */
  count(): number { return 1 + STATIONS.length; }
  /** Dial place n (1.. = STATIONS[n - 1]) is broadcasting: WTPD once the bridge is up, the carols in the holiday season. */
  onAir(n: number): boolean {
    const st = STATIONS[n - 1];
    if (!st) return n <= 0;
    if (st === CAROLS) return holiday.on;
    if (st.seed === 610) return progress.complete;
    return true;
  }

  private show(): void {
    if (this.station === 0) { this.game.hud.radio(CLAUDE_FM_CALL, ''); return; }
    const s = this.station > 0 ? STATIONS[this.station - 1] : null;
    this.game.hud.radio(s ? s.call : 'Radio off', s ? s.name : '');
  }

  /** The dial, one click on. Claude FM is skipped once it has failed this session. */
  next(): void {
    const c = this.core;
    let n = this.station + 1 >= this.count() ? -1 : this.station + 1;
    if (n === 0 && this.fm.state === 'failed') n = 1;
    while (n > 0 && !this.onAir(n)) n = n + 1 >= this.count() ? -1 : n + 1;
    this.station = n;
    save.data.settings.station = this.station;
    save.write();
    if (this.player) { this.player.stop(c.now); this.player = null; }
    if (c.ctx.state === 'running' && c.claim('static', 2, 0.2)) staticBurst(c, c.now + 0.01, c.direct('music', 0.8), Math.random);
    this.tuneAt = c.now + 0.3;
    this.show();
  }
  private tuneAt = 0;
  /** A jukebox is playing (game/nightlife.ts): the station is heard on foot, indoors, as it is in a car. */
  juke = false;
  /** The jukebox's button: the next generated station on the air (never Claude FM or off), tuned like the dial does. Returns its call and name. */
  jukeNext(): { call: string; name: string } {
    const c = this.core;
    let n = this.station < 1 ? 1 : this.station + 1;
    for (let k = 0; k < this.count(); k++) { if (n >= this.count()) n = 1; if (this.onAir(n)) break; n++; }
    if (n >= this.count() || !this.onAir(n)) n = 1;
    this.station = n;
    save.data.settings.station = n;
    save.write();
    if (this.player) { this.player.stop(c.now); this.player = null; }
    if (c.ctx.state === 'running' && c.claim('static', 2, 0.2)) staticBurst(c, c.now + 0.01, c.direct('music', 0.8), Math.random);
    this.tuneAt = c.now + 0.3;
    const st = STATIONS[n - 1];
    this.game.hud.radio(st.call, st.name);
    return { call: st.call, name: st.name };
  }
  /** The host of Claude FM: now and then ducks the stream for a line (voices.ts). */
  readonly fmDj: ClaudeFMDJ;
  private lastKeys = 0;
  private lastBooked = -1e9; private escapeAt = 0; private heatWas = 0;
  private hpV: unknown = null; private hp = 100; private snowOn = false;

  /** The host's reactions (fmDj.offer): the moments other systems announce, plus the ones the game already says. */
  private hookMoments(): void {
    const g = this.game;
    g.on('moment', (e) => { if (this.station === 0) this.fmDj.offer(e.kind, !!e.own); });
    g.on('booked', () => { this.lastBooked = performance.now(); if (this.station === 0) this.fmDj.offer('busted'); });
    g.on('heat', (e) => {
      if (e.level === 0 && this.heatWas > 0) this.escapeAt = performance.now() + 1500;
      this.heatWas = e.level;
    });
  }
  /** The DJs, idents and adverts between songs (voices.ts). */
  readonly voice: RadioVoice;

  /**
   * How long a station has been on the air, in seconds. All of them were broadcasting before she turned up, each
   * a different way into a different song, and all of them run on the game's clock: paused, they wait for her.
   */
  clock(i: number): number { return this.game.time + STATIONS[i].seed * 13.7; }

  /** The radio key, read whether or not the context is awake yet; and Claude FM, which lives outside the context. */
  keys(): void {
    const g = this.game, s = save.data.settings, v = g.player.seated;
    if (v && g.input.hit('radio')) this.next();
    if (this.station === 0 && this.fm.state === 'failed') this.station = 1;
    const fm = this.station === 0 && !!v && !v.sunk && !this.paused && document.visibilityState !== 'hidden'
      && s.volMaster > 0 && s.volMusic > 0 && this.core.now >= this.tuneAt;
    this.fm.set(fm, s.volMaster * s.volMusic);
    const now = performance.now(), dt = this.lastKeys ? (now - this.lastKeys) / 1000 : 0;
    this.lastKeys = now;
    const eligible = this.station === 0 && !!v && !v.sunk && !this.paused && document.visibilityState !== 'hidden';
    if (this.station === 0) this.watch(v ?? null);
    this.fmDj.tick(dt, fm && this.fm.playing, eligible);
  }

  /** Things nobody announces: the car going to pieces, the chase lost, heavy snow. */
  private watch(v: { health: number } | null): void {
    if (v) {
      if (this.hpV === v && this.hp > 20 && v.health <= 20) this.fmDj.offer('wreck');
      this.hpV = v; this.hp = v.health;
    }
    if (this.escapeAt && performance.now() > this.escapeAt) {
      this.escapeAt = 0;
      if (performance.now() - this.lastBooked > 8000) this.fmDj.offer('escaped');
    }
    const snow = this.game.sky ? this.game.sky.snowCover : 0;
    if (snow >= 0.6 && !this.snowOn) { this.snowOn = true; this.fmDj.offer('snow'); } else if (snow < 0.3) this.snowOn = false;
  }

  update(_dt: number): void {
    const c = this.core, g = this.game, v = g.player.seated, t = c.now;
    const inCar = !!v && !v.sunk;
    if (inCar && !this.wasIn && this.station >= 0) this.show();
    this.wasIn = inCar;
    if (this.station >= this.count() || (this.station > 0 && !this.onAir(this.station))) this.station = -1;
    const want = (inCar || this.juke) && this.station > 0 && save.data.settings.volMusic > 0;
    if (!want) { if (this.player) { this.player.stop(t); this.player = null; } this.voice.tick(null, 0, 1); return; }
    if (!this.player) {
      if (t < this.tuneAt) return;
      const st = STATIONS[this.station - 1];
      this.player = new StationPlayer(c, st, c.bus.music);
      this.player.start(t + 0.03, this.clock(this.station - 1));
    }
    this.player.pump(t);
    this.voice.tick(this.player, this.clock(this.station - 1), SONG_BARS * barSeconds(this.player.st));
  }
}
