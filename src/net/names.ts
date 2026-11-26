// Made-up names. Nobody types anything: a name is two or three indexes into the fixed lists below, and only the
// indexes travel (protocol.ts). Every browser turns them back into the same words.
//
// The lists are part of the protocol: APPEND ONLY IN STEP WITH NAME_LIST_SIZES in protocol.ts (the line under the
// lists stops the build when they disagree), and never reorder, or everybody's name changes under them.
// Tone: Harbor Authority paperwork and things found on a pier. Nothing that could describe a real person or group.

import { NAME_LIST_SIZES, isValidName, type NameIndexes } from './protocol';

/** How somebody is filed. */
const FIRST = [
  'Soggy', 'Deputy', 'Unlicensed', 'Tepid', 'Alleged', 'Barnacled', 'Honest', 'Overdue',
  'Damp', 'Reckless', 'Punctual', 'Suspicious', 'Salty', 'Sideways', 'Grumpy', 'Polite',
  'Dented', 'Wobbly', 'Borrowed', 'Certified', 'Lukewarm', 'Unpaid', 'Foggy', 'Rusty',
  'Squeaky', 'Jaywalking', 'Double-Parked', 'Interim', 'Acting', 'Low-Tide', 'Discount', 'Sunburnt',
  'Misfiled', 'Notarized', 'Second-Hand', 'Off-Duty', 'Unstamped', 'Waterlogged', 'Provisional', 'Expired',
] as const;

/** What they are, as far as the paperwork knows. */
const SECOND = [
  'Pelican', 'Barnacle', 'Forklift', 'Gull', 'Anchovy', 'Crab', 'Tugboat', 'Parking Cone',
  'Lamppost', 'Mackerel', 'Clipboard', 'Buoy', 'Dinghy', 'Squid', 'Hubcap', 'Sandbag',
  'Lobster', 'Turnstile', 'Flounder', 'Bollard', 'Walrus', 'Tow Hook', 'Prawn', 'Stapler',
  'Otter', 'Rubber Duck', 'Mooring', 'Doofus', 'Haddock', 'Life Ring', 'Shrimp', 'Fender',
  'Kelp', 'Heron', 'Bucket', 'Foghorn', 'Sardine', 'Wrench', 'Puffin', 'Seagull',
] as const;

/** An optional last word. */
const THIRD = [
  'of Pier 9', 'the Third', '(Allegedly)', 'Esq.', 'of Room 404', 'Jr.', 'on Probation', 'the Unready',
  '(Pending)', 'of Tepid Falls', 'in Triplicate', 'the Lesser', 'at Low Tide', '(Appealing)', 'of the Strand', 'With Fries',
  'the Damp', '(Form 55)', 'of No Fixed Dock', 'After Hours', 'the Punctual', '(Unverified)', 'of WDOOF', 'the Second-Best',
] as const;

/** The build stops here when the lists and the protocol's limits disagree. */
const SIZES: readonly [typeof FIRST.length, typeof SECOND.length, typeof THIRD.length] = NAME_LIST_SIZES;
void SIZES;

const LISTS: readonly (readonly string[])[] = [FIRST, SECOND, THIRD];
const KEY = 'pc.net.name';

/** "Soggy Pelican of Pier 9". Indexes out of range (a newer client's longer lists) wrap rather than break. */
export function nameText(n: readonly number[]): string {
  let s = '';
  for (let i = 0; i < n.length && i < LISTS.length; i++) {
    const l = LISTS[i], w = l[(((n[i] | 0) % l.length) + l.length) % l.length];
    s += (i ? ' ' : '') + w;
  }
  return s || 'Somebody';
}

function roll(): NameIndexes {
  const r = (i: number): number => Math.floor(Math.random() * NAME_LIST_SIZES[i]);
  const n = [r(0), r(1)];
  if (Math.random() < 0.4) n.push(r(2));
  return n;
}

function save(n: NameIndexes): void {
  try { localStorage.setItem(KEY, n.join('.')); } catch { /* private browsing: the name lasts for this visit */ }
}

let mine: NameIndexes | null = null;

/** This browser's name: the one it kept from last time, or a new one. */
export function myName(): NameIndexes {
  if (mine) return mine;
  let n: NameIndexes | null = null;
  try {
    const s = localStorage.getItem(KEY);
    if (s && /^\d{1,3}(\.\d{1,3}){1,2}$/.test(s)) { const a = s.split('.').map(Number); if (isValidName(a)) n = a; }
  } catch { /* no storage */ }
  if (!n) { n = roll(); save(n); }
  return (mine = n);
}

/** A different name, kept for next time. */
export function rerollName(): NameIndexes {
  const old = myName().join('.');
  let n = roll();
  for (let i = 0; i < 8 && n.join('.') === old; i++) n = roll();
  save(n);
  return (mine = n);
}

/** The dot other players wear on the radar and the map: a violet nothing else on either of them uses. This is the default palette's;
 *  the live colour is ACC.c.peer (core/access.ts), which the colour-safe palettes change. */
export const PEER_COLOR = '#8e3fb8';

/**
 * The only things one player can say to another. They travel as an index into this list and nothing else (protocol.ts
 * PlayerEvent): index 0 is the wave (PlayerEvent.Wave), the rest are shouts (PlayerEvent.Shout, arg = index - 1).
 * Same tone as the names: dry paperwork, clean, aimed at nobody. APPEND ONLY; a shorter list on an older client
 * just ignores indexes it does not have.
 */
export const SAYS = [
  'Hello. This is a wave.',
  'Nobody saw that.',
  'Please hold. I am driving.',
  'That is not my dinghy.',
  'Filed under: fine.',
] as const;
