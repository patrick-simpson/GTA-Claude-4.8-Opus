// WJNGL 122.5, the Christmas station (fun queue item 17). On the dial only in the holiday season (world/holiday.ts).
//
// Like every station here it plays nothing that exists: radio.ts's composer writes its songs bar by bar from the seed,
// in the shape of a carol (a lilting three, plain hymn-book harmony, a cadence at every fourth bar), voiced for a
// small choir singing "ooh", a celesta, sleigh-bell shaker and a string pad. The carollers in the parks
// (world/christmas.ts) sing the same station through the town's speakers, unaccompanied by the radio.

import type { Station } from './radio';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const STRINGS = [1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12];

export const CAROLS: Station = {
  call: 'WJNGL 122.5', gain: 1.25, name: 'All carols, all season', seed: 1225, style: 'waltz', bpm: 126, beats: 3, swing: 0,
  scale: MAJOR, tonic: 'I', keys: [55, 50, 53, 58],
  A: ['I I IV I V7 V7 I I', 'I vi IV V7 I IV V7 I', 'I IV I vi ii V7 I I'],
  B: ['IV IV I I ii V7 I I', 'vi vi IV IV I ii V7 V7', 'IV I IV I vi II7 V7 V7'],
  C: ['vi iii IV I ii V7 I I', 'IV iv I vi ii V7 I I'],
  dens: 0.45, sync: 0.04, oct: 1, kit: 'band',
  bass: { w: [1, 0.3, 0.1], a: 0.02, d: 0.3, s: 0.6, r: 0.15, lp: 4, level: 0.34 },
  // Celesta chords on the off beats.
  stab: { w: [1, 0, 0, 0.3, 0, 0, 0, 0, 0, 0.08], a: 0.002, d: 0.6, s: 0.08, r: 0.4, lp: 12, level: 0.12 },
  pad: { w: STRINGS, a: 0.25, d: 0.4, s: 0.8, r: 0.5, lp: 4, det: 9, vib: 8, vibHz: 5, level: 0.07 },
  // The choir: a soft rounded vowel, slow onset, gentle vibrato and breath.
  lead: { w: [1, 0.55, 0.3, 0.12, 0.08, 0.04], a: 0.09, d: 0.3, s: 0.85, r: 0.25, lp: 4, vib: 16, vibHz: 5.2, det: 11, breath: 0.1, level: 0.3 },
  // Glockenspiel answering it.
  lead2: { w: [1, 0, 0, 0.4, 0, 0, 0, 0, 0, 0.15], a: 0.001, d: 0.9, s: 0.02, r: 0.6, lp: 14, level: 0.24 },
  mix: { drums: 0.45, bass: 0.9, stab: 1, pad: 1, lead: 1, lead2: 0.9 }, wet: 0.3,
};
