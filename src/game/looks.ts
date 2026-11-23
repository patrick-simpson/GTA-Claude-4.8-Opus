// The player's own look: body, face, hair, clothes, and the car they drive (paint, finish, rims, horn).
//
// One compact descriptor (PlayerLook) is the whole truth. It is saved in this browser, drawn on this screen through
// toStyled(), and sent to everybody else as LOOK_BYTES bytes (net/index.ts, PlayerEvent.Look), who draw it through the
// same toStyled(). So a player looks the same on every screen, their own included. Before a player picks anything they
// get a random look, made once and saved, so it does not change from visit to visit either.
//
// Colours are indexes into fixed palettes (small, safe to decode, and the same list on every page); the car paint is
// a full colour. decodeLook() never throws and clamps every field, so a corrupt or hostile frame is just some look.

import { RNG } from '../core/util';
import type { VehicleKind } from '../ent/vehicleSpecs';
import type { HairCut, StyledLook, TopKind, BottomKind } from '../ent/character';

export const SKIN_TONES = [0xf6dcc5, 0xf3d3b8, 0xe8b990, 0xd9a273, 0xc68e62, 0xb07a52, 0x9c6b4a, 0x7d4d30, 0x6a3f27, 0x4e2e1c];
export const HAIR_COLORS = [0x15110f, 0x2b1d17, 0x3a2a20, 0x5a3c26, 0x7a4a2a, 0x9c4326, 0xa57a42, 0xd8b56e, 0xe4dfd3, 0x8e8d88, 0x2f5fa8, 0xc8578f, 0x3e8a5a, 0x6b3fa0];
export const CLOTH_COLORS = [
  0xf2e8cf, 0xfafafa, 0x1b1b1f, 0x45474d, 0x8e8f93, 0x14213d, 0x3d5a80, 0x7fb0bd, 0x2a9d8f, 0x8a9a6b,
  0x2f5233, 0xf0a202, 0xe07a1f, 0xe4572e, 0xb3262e, 0x6d1f2c, 0xe58fa8, 0x5b3f8c, 0xb8a57a, 0x5a3a26,
];
export const CUTS: readonly HairCut[] = ['crop', 'part', 'long', 'tail', 'bun', 'curls', 'afro', 'bald'];
export const CUT_NAMES = ['Crop', 'Side part', 'Long', 'Pony tail', 'Bun', 'Curls', 'Afro', 'Shaved'];
export const TOP_KINDS: readonly TopKind[] = ['tee', 'shirt', 'hoodie', 'dress', 'coverall'];
export const TOP_NAMES = ['Tee', 'Shirt', 'Hoodie', 'Dress', 'Coveralls'];
export const BOTTOM_KINDS: readonly BottomKind[] = ['trousers', 'jeans', 'shorts', 'skirt'];
export const BOTTOM_NAMES = ['Trousers', 'Jeans', 'Shorts', 'Skirt'];
export const SHOE_NAMES = ['Sneakers', 'Boots'];
export const HAT_NAMES = ['None', 'Cap', 'Cap, backwards', 'Beanie', 'Brimmed hat'];
export const GLASSES_COLORS = [0x17171c, 0x5a3a1e, 0xb8963e];
export const GLASSES_NAMES = ['None', 'Black', 'Tortoiseshell', 'Wire, gold'];
export const BEARD_NAMES = ['None', 'Stubble', 'Beard'];
/** The faces character.ts pulls its one head into (FACES there); the last is the tired one the story's Dess wears. */
export const FACE_COUNT = 9;
export const RIM_COLORS = [0xb8bcc2, 0x1c1c20, 0xd8aa48, 0xa86a3e, 0xd8372a, 0x3c6ee0];
export const RIM_NAMES = ['Stock', 'Black', 'Gold', 'Bronze', 'Red', 'Blue'];
export const FINISH_NAMES = ['Factory', 'Solid gloss', 'Metallic'];
export const PAINTS = [
  0xf4f4f0, 0xc9ccd0, 0x8a8e94, 0x2b2d33, 0x0e0f12, 0x14213d, 0x2c5aa0, 0x5fa8d3, 0x2a9d8f, 0x1f5f3a,
  0x8a9a6b, 0xf0a202, 0xf2c94c, 0xe07a1f, 0xe4572e, 0xb3262e, 0x6d1f2c, 0xd16ba5, 0x5b3f8c, 0x6b4a2e,
];
/** Index 0 is the car's own horn. */
export const HORN_CHOICES: readonly (VehicleKind | null)[] = [null, 'sedan', 'hatch', 'muscle', 'sports', 'tow', 'bus', 'bolt', 'speedboat', 'jetski'];
export const HORN_NAMES = ["The car's own", 'Two-tone', 'Beeper', 'Muscle', 'Sports', 'Air horn', 'Bus', 'Polite', 'Ship', 'Toy'];

export interface PlayerLook {
  body: 0 | 1;          // 0 the woman's body, 1 the man's
  skin: number; face: number;
  cut: number; hair: number; beard: number;
  top: number; topColor: number;
  /** 0 none, else a CLOTH_COLORS index + 1: an open jacket over a tee of topColor. */
  jacket: number;
  bottom: number; bottomColor: number;
  shoes: number; shoeColor: number;
  hat: number; hatColor: number;
  glasses: number; bag: number;
  /** 0..255: 0.9 .. 1.1 tall, 0.9 .. 1.15 broad. */
  height: number; build: number;
  /** The small details (eye colour, the bag's colour, the cast of the face). */
  seed: number;
  /** 0 = the car keeps its own paint; 1 solid gloss, 2 metallic, in `paint`. */
  finish: number; paint: number;
  rims: number; horn: number;
  /** Has the player chosen this, or is it the random first look? Not sent. */
  picked?: boolean;
}

export const LOOK_VERSION = 1;
export const LOOK_BYTES = 24;

const mod = (v: number, n: number): number => ((Math.floor(v) % n) + n) % n;

export function randomPlayerLook(rng: RNG = new RNG((Math.random() * 0xffffffff) >>> 0)): PlayerLook {
  const body: 0 | 1 = rng.chance(0.5) ? 0 : 1;
  const f = body === 0;
  const cutPool = f ? [2, 2, 3, 3, 4, 1, 5, 6, 0] : [0, 0, 1, 1, 5, 6, 7];
  const top = rng.pick(f ? [0, 0, 1, 2, 3] : [0, 0, 1, 1, 2]);
  const pick = (): number => rng.int(0, CLOTH_COLORS.length - 1);
  const topColor = pick();
  let bottomColor = rng.pick([3, 5, 6, 6, 18, 2, 4, 19]);
  if (bottomColor === topColor) bottomColor = 6;
  return {
    body, skin: rng.int(0, SKIN_TONES.length - 1), face: rng.int(0, FACE_COUNT - 2),
    cut: rng.pick(cutPool), hair: rng.int(0, 9), beard: !f && rng.chance(0.4) ? rng.int(1, 2) : 0,
    top, topColor, jacket: top !== 3 && rng.chance(0.25) ? rng.pick([2, 5, 19, 9, 6]) + 1 : 0,
    bottom: top === 3 ? 0 : rng.chance(0.2) ? 2 : f && rng.chance(0.2) ? 3 : rng.chance(0.55) ? 1 : 0, bottomColor,
    shoes: rng.chance(0.7) ? 0 : 1, shoeColor: rng.pick([2, 2, 1, 19, 0, 5, 13]),
    hat: rng.chance(0.3) ? rng.int(1, 4) : 0, hatColor: pick(),
    glasses: rng.chance(0.18) ? rng.int(1, 3) : 0, bag: rng.chance(0.15) ? 1 : 0,
    height: rng.int(70, 185), build: rng.int(60, 190), seed: rng.int(0, 65535),
    finish: 0, paint: 0, rims: 0, horn: 0,
  };
}

/** The descriptor as character.ts draws it. The same on every screen. */
export function toStyled(l: PlayerLook): StyledLook {
  const top = TOP_KINDS[mod(l.top, TOP_KINDS.length)];
  const jacket = l.jacket > 0 && top !== 'dress' && top !== 'coverall';
  const cloth = (i: number): number => CLOTH_COLORS[mod(i, CLOTH_COLORS.length)];
  const hat = mod(l.hat, HAT_NAMES.length);
  const topHex = cloth(l.topColor);
  return {
    skin: SKIN_TONES[mod(l.skin, SKIN_TONES.length)],
    hair: HAIR_COLORS[mod(l.hair, HAIR_COLORS.length)],
    top: jacket ? cloth(l.jacket - 1) : topHex,
    // Coveralls are one piece: the trousers are the same cloth.
    bottom: top === 'coverall' ? topHex : cloth(l.bottomColor),
    shoes: cloth(l.shoeColor),
    hat: hat ? cloth(l.hatColor) : null,
    height: 0.9 + 0.2 * mod(l.height, 256) / 255,
    build: 0.9 + 0.25 * mod(l.build, 256) / 255,
    body: l.body ? 'm' : 'f',
    cut: CUTS[mod(l.cut, CUTS.length)],
    beard: l.beard === 2 ? true : l.beard === 1 ? 'stubble' : false,
    topKind: jacket ? 'jacket' : top,
    under: jacket ? topHex : undefined,
    bottomKind: BOTTOM_KINDS[mod(l.bottom, BOTTOM_KINDS.length)],
    shoeKind: l.shoes ? 'boots' : 'sneakers',
    hatKind: hat === 3 ? 'beanie' : hat === 4 ? 'brim' : 'cap',
    capBack: hat === 2,
    glasses: l.glasses > 0,
    glassesColor: l.glasses > 0 ? GLASSES_COLORS[mod(l.glasses - 1, GLASSES_COLORS.length)] : undefined,
    bag: l.bag > 0,
    face: mod(l.face, FACE_COUNT),
    seed: mod(l.seed, 65536),
  };
}

export function encodeLook(l: PlayerLook, out = new Uint8Array(LOOK_BYTES)): Uint8Array {
  out[0] = LOOK_VERSION;
  out[1] = (l.body & 1) | ((l.beard & 3) << 1) | ((l.shoes & 1) << 3) | ((l.glasses & 3) << 4) | ((l.bag & 1) << 6);
  out[2] = l.skin; out[3] = l.face; out[4] = l.cut; out[5] = l.hair;
  out[6] = l.top; out[7] = l.topColor; out[8] = l.jacket;
  out[9] = l.bottom; out[10] = l.bottomColor; out[11] = l.shoeColor;
  out[12] = l.hat; out[13] = l.hatColor;
  out[14] = l.height; out[15] = l.build;
  out[16] = l.seed & 0xff; out[17] = (l.seed >> 8) & 0xff;
  out[18] = l.finish & 3;
  out[19] = (l.paint >> 16) & 0xff; out[20] = (l.paint >> 8) & 0xff; out[21] = l.paint & 0xff;
  out[22] = l.rims; out[23] = l.horn;
  return out;
}

/** Null if it is not a look this page understands (an unknown version: the caller keeps the fallback look). */
export function decodeLook(b: Uint8Array): PlayerLook | null {
  if (b.length < LOOK_BYTES || b[0] !== LOOK_VERSION) return null;
  const f = b[1];
  return {
    body: (f & 1) as 0 | 1, beard: mod((f >> 1) & 3, 3), shoes: (f >> 3) & 1, glasses: (f >> 4) & 3, bag: (f >> 6) & 1,
    skin: mod(b[2], SKIN_TONES.length), face: mod(b[3], FACE_COUNT), cut: mod(b[4], CUTS.length), hair: mod(b[5], HAIR_COLORS.length),
    top: mod(b[6], TOP_KINDS.length), topColor: mod(b[7], CLOTH_COLORS.length), jacket: mod(b[8], CLOTH_COLORS.length + 1),
    bottom: mod(b[9], BOTTOM_KINDS.length), bottomColor: mod(b[10], CLOTH_COLORS.length), shoeColor: mod(b[11], CLOTH_COLORS.length),
    hat: mod(b[12], HAT_NAMES.length), hatColor: mod(b[13], CLOTH_COLORS.length),
    height: b[14], build: b[15], seed: b[16] | (b[17] << 8),
    finish: mod(b[18], 3), paint: (b[19] << 16) | (b[20] << 8) | b[21],
    rims: mod(b[22], RIM_COLORS.length), horn: mod(b[23], HORN_CHOICES.length),
  };
}

export const sameLook = (a: PlayerLook, b: PlayerLook): boolean => {
  const x = encodeLook(a), y = encodeLook(b);
  for (let i = 0; i < LOOK_BYTES; i++) if (x[i] !== y[i]) return false;
  return true;
};

// ── Saved in this browser ────────────────────────────────────────────────────

const KEY = 'portcalamity.look.v1';
let mine: PlayerLook | null = null;
const listeners: ((l: PlayerLook) => void)[] = [];

/** This player's look: the saved one, or a random one made now and saved (so it stays the same next time). */
export function myLook(): PlayerLook {
  if (mine) return mine;
  let l: PlayerLook | null = null;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { b?: number[]; p?: boolean } | null;
    if (raw && Array.isArray(raw.b)) { l = decodeLook(Uint8Array.from(raw.b)); if (l) l.picked = raw.p === true; }
  } catch { /* storage refused or junk: a new look */ }
  // ?look=<seed> (tests): a fixed random look, not saved.
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('look') : null;
  if (q && /^\d+$/.test(q)) { mine = randomPlayerLook(new RNG(Number(q) || 1)); return mine; }
  if (!l) { l = randomPlayerLook(); mine = l; store(); }
  mine = l;
  return l;
}

function store(): void {
  if (!mine) return;
  try { localStorage.setItem(KEY, JSON.stringify({ b: Array.from(encodeLook(mine)), p: mine.picked === true })); } catch { /* play on */ }
}

/** Replace this player's look: saved, and told to whoever listens (the player's body, the net). */
export function setMyLook(l: PlayerLook): void {
  mine = { ...l };
  store();
  for (const f of listeners) f(mine);
}

export function onMyLook(f: (l: PlayerLook) => void): void { listeners.push(f); }
