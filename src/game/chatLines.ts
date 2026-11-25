// Safe chat (fun queue item 21): everything anybody can say, and every place they can name. Nothing here is typed by a
// player: a message on the wire is a phrase index and a place index into these tables (net/chat.ts), and a screen only ever
// shows what is in them. Kid mode keeps the same indices with gentler wording, so a town mixing the two still agrees.
//
// Indices travel between players: never renumber or delete, only add at the end.

import type { Game } from '../core/game';
import { BRIDGE, LIGHTHOUSE, PIER_HEAD } from '../world/plan';
import { DERBY } from '../world/places';
import { SITES } from '../world/mainland';

export interface Phrase {
  /** The line; `%` is where a place name goes (a phrase with one is a "place phrase" and drops a marker on the others' maps). */
  t: string;
  /** The gentler line shown while kid mode is on. */
  k: string;
}
const P = (t: string, k: string = t): Phrase => ({ t, k });

export const PHRASES: readonly Phrase[] = [
  // 0 to 5: hello and goodbye
  P('Good day. Please take a number.', 'Hello! Nice to see you.'),
  P('Greetings. Form 1 is attached.', 'Hi, friend!'),
  P('Your presence has been noted.', 'So glad you are here!'),
  P('Goodbye. Pending review.', 'Bye for now!'),
  P('Good morning. Or whatever this is.', 'Good day!'),
  P('Welcome to Port Calamity. Mind the gap.', 'Welcome to Port Calamity!'),
  // 6 to 11: answers
  P('Yes. In writing.', 'Yes!'),
  P('No. See Appendix C.', 'No, thank you.'),
  P('Thank you. This will be noted.', 'Thank you!'),
  P('Sorry. Form 7 to follow.', 'Sorry, my mistake!'),
  P('Maybe. Pending committee.', 'Maybe!'),
  P('One moment. Processing.', 'One moment, please!'),
  // 12 to 17: trouble
  P('Help. This is not a drill. Possibly.', 'Help, please!'),
  P('Officer ahead. Be polite.'),
  P('Mind the bridge. It is unfinished.'),
  P('I have lost my car. It was here.'),
  P('That was not me. I was elsewhere.', 'That was an accident!'),
  P('Watch out for the duck.'),
  // 18 to 25: small talk
  P('Nice parking. Legally questionable.', 'Nice parking!'),
  P('Well driven. Penalties waived.', 'Great driving!'),
  P('Who needs a road?'),
  P('I would like to speak to the manager.'),
  P('This is fine. Filed under fine.'),
  P('Stamp that for me, please.'),
  P('Another day, another form.'),
  P('Bridge update: no.'),
  // 26 to 31: reactions
  P('*applause, officially*', '*applause!*'),
  P('*stamps approval*'),
  P('*stamps rejection*', '*a gentle no*'),
  P('*gasp, procedural*', '*gasp!*'),
  P('*laughs, off the record*', '*laughs!*'),
  P('*sighs, in triplicate*', '*sighs*'),
  // 32 to 35: place phrases
  P('Meet me at %. Bring ID.', 'Meet me at %!'),
  P('Race you to %. No cutting corners.', 'Race you to %!'),
  P("Let's go to %. It is on the list.", "Let's go to %!"),
  P('Where is %? Asking for a form.', 'Where is %?'),
  // 36 to 47 (fun queue 2, item 29): 36 lights the sender's car for others (game/follow.ts); the rest are plain lines.
  P('Follow me!'),
  P('Nice driving!'),
  P('Race you there!'),
  P('Need a lift?'),
  P('Wait up!'),
  P('Over here!'),
  P('Thanks!'),
  P('Sorry!'),
  P("Let's do a co-op job!"),
  P('Snowball fight?'),
  P('Good game!'),
  P('Anyone for a race?'),
];
/** Place index meaning "none" on the wire. */
export const NO_PLACE = 255;
export const isPlacePhrase = (i: number): boolean => !!PHRASES[i] && PHRASES[i].t.includes('%');

/** The wheel: a ring of choices; a choice is a group (another ring), a plain phrase, or a place phrase (then the places). */
export interface Node { label: string; kids?: Node[]; phrase?: number; place?: number; more?: number }
const range = (a: number, b: number): Node[] => { const l: Node[] = []; for (let i = a; i <= b; i++) l.push({ label: '', phrase: i }); return l; };

export const ROOT: Node[] = [
  { label: 'Hello', kids: range(0, 5) },
  { label: 'Answers', kids: range(6, 11) },
  { label: 'Trouble', kids: range(12, 17) },
  { label: 'Small talk', kids: range(18, 25) },
  { label: 'Reactions', kids: range(26, 31) },
  { label: 'Meet me at...', more: 32 },
  { label: 'Race you to...', more: 33 },
  { label: "Let's go to...", more: 34 },
  { label: 'Where is...', more: 35 },
  { label: 'Follow me!', phrase: 36 },
  { label: 'More...', kids: [
    { label: 'Out and about', kids: range(37, 41) },
    { label: 'Thanks and sorry', kids: range(42, 43) },
    { label: 'Plans and play', kids: range(44, 47) },
  ] },
];

/** The places a place phrase can name: a fixed order, so an index means the same on every screen (this build's table). */
export interface Place { name: string; x: number; z: number }
export const PLACE_GROUPS: { label: string; from: number; to: number }[] = [
  { label: 'Port Calamity', from: 0, to: 7 },
  { label: 'Mainland', from: 8, to: 12 },
  { label: 'Race starts', from: 13, to: 21 },
];
export const PLACE_COUNT = 22;

/** The place table now. Entries a world cannot give (a short list while it builds) are null and cannot be named or shown. */
export function placeTable(game: Game): (Place | null)[] {
  const t: (Place | null)[] = [];
  const at = (name: string, x: number, z: number): void => { t.push({ name, x, z }); };
  const todo = game.todo as unknown as { shops?: { list: { at: { x: number; z: number }; name: string }[] }; jobs?: { yards: { at: { x: number; z: number }; name: string }[]; races: { name: string; start: { x: number; z: number } }[] } } | undefined;
  at('the pier', (PIER_HEAD.x0 + PIER_HEAD.x1) / 2, (PIER_HEAD.z0 + PIER_HEAD.z1) / 2);
  at('the lighthouse', LIGHTHOUSE.x, LIGHTHOUSE.z);
  at('the Perpetual Bridge', BRIDGE.x, BRIDGE.z0);
  at('the derby arena', DERBY.x, DERBY.z);
  const shops = todo?.shops?.list ?? [], yards = todo?.jobs?.yards ?? [], races = todo?.jobs?.races ?? [];
  for (let i = 0; i < 2; i++) { const s = shops[i]; if (s) at(s.name.split(',')[0], s.at.x, s.at.z); else t.push(null); }
  for (let i = 0; i < 2; i++) { const s = yards[i]; if (s) at(s.name.split(',')[0].replace(/^the /, ''), s.at.x, s.at.z); else t.push(null); }
  at('Tepid Landing', SITES.landing.x, SITES.landing.z);
  at('Quorum Square', SITES.square.x, SITES.square.z);
  at('Dithers College', SITES.hilltop.x, SITES.hilltop.z);
  at('Lake Indecision', SITES.lake.x, SITES.lake.z);
  at('the dam', SITES.dam.x, SITES.dam.z);
  for (let i = 0; i < 9; i++) { const r = races[i]; if (r) at(`${r.name} start`, r.start.x, r.start.z); else t.push(null); }
  return t;
}

/** The text of phrase `i` for a screen in kid mode or not; `place` fills the %. '' for an index this build does not have. */
export function phraseText(i: number, place: Place | null, kid: boolean): string {
  const p = PHRASES[i];
  if (!p) return '';
  const s = kid ? p.k : p.t;
  return s.includes('%') ? s.replace('%', place ? place.name : 'somewhere') : s;
}
