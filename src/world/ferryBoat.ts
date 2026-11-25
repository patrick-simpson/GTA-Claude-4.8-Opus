// Fun queue 2, item 11: the Calamity Shuttle, built in code, and its two landings.
//
// The launch: 11.4 m, a teal hull with a cream band, a glazed cabin forward with a helm and four seats, and an open after
// deck under a canopy with three rows of slatted benches (12 seats). Local axes as ent/boat.ts: +z forward, +x to the left
// (heading h turns +x to (cos h, -sin h)), y up from the waterline.
//
// The landings: Pelican Landing, a timber T-jetty from the beach east of the pier whose head the ferry lies along, and the
// wharf on the Muddle River's west bank below the Main St bridge. Each has a name sign, a timetable board, bollards and
// a bench; the jetty has a canopy. All in one batched mesh with a few small canvas textures.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { Batch } from './batch';
import { groundAt } from './plan';
import { DOCKS, departures, ferryPlan, FERRIES, type Dock } from './ferryRoute';

export const FERRY_LEN = 11.4, FERRY_BEAM = 3.6;
/** Heights above the waterline: the open deck, a seated person's hips. */
export const DECK = 0.55, HIPS = 0.97;
/** Seats: [across (+ left), along], hips at HIPS. The after deck's three benches face the bow; the cabin's four seats too. */
export const FERRY_SEATS: readonly (readonly [number, number])[] = (() => {
  const s: [number, number][] = [];
  for (const z of [-1.0, -2.4, -3.8]) for (const x of [1.2, 0.62, -0.62, -1.2]) s.push([x, z]);
  for (const z of [1.7, 2.9]) for (const x of [0.78, -0.78]) s.push([x, z]);
  return s;
})();

const TEAL = 0x1d5566, DEEP = 0x143a47, CREAM = 0xe9e0c8, ORANGE = 0xe4572e, WOODC = 0x9a7650, IRON = 0x2b3138, ROOF = 0xf1ead6, DARK = 0x23262a;

const hullShape = (s: number): THREE.Shape => {
  const sh = new THREE.Shape(), b = FERRY_BEAM / 2 * s, st = -5.5 * s;
  sh.moveTo(-b, st); sh.lineTo(b, st); sh.lineTo(b, 1.8); sh.lineTo(b * 0.68, 4.3); sh.lineTo(0, 5.9); sh.lineTo(-b * 0.68, 4.3); sh.lineTo(-b, 1.8); sh.closePath();
  return sh;
};

function nameplate(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const x = c.getContext('2d')!;
  x.fillStyle = '#143a47'; x.fillRect(0, 0, 512, 96);
  x.fillStyle = '#e9e0c8'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '800 54px "Big Shoulders Display", "Barlow Semi Condensed", sans-serif';
  x.fillText('THE CALAMITY SHUTTLE', 256, 44);
  x.font = '600 20px "Barlow Semi Condensed", sans-serif';
  x.fillStyle = '#e4572e'; x.fillText('PELICAN LANDING  ⇄  TEPID FALLS', 256, 80);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export interface FerryParts { group: THREE.Group }

/** Build one ferry (the geometry and materials are shared between ferries: pass the same `shared` back in). */
export interface FerryKit { hull: THREE.BufferGeometry; deck: THREE.BufferGeometry; body: THREE.BufferGeometry; glass: THREE.BufferGeometry; plate: THREE.Texture; mats: { hull: THREE.Material; deck: THREE.Material; body: THREE.Material; glass: THREE.Material; plate: THREE.Material } }

export function ferryKit(env: THREE.Texture | null): FerryKit {
  // Hull: a vertical-sided body from the gunwale down to the chine, and a narrower keel under it.
  const upper = new THREE.ExtrudeGeometry(hullShape(1), { depth: DECK + 0.55, bevelEnabled: false });
  upper.rotateX(Math.PI / 2); upper.translate(0, DECK, 0);
  const lower = new THREE.ExtrudeGeometry(hullShape(0.72), { depth: 0.55, bevelEnabled: false });
  lower.rotateX(Math.PI / 2); lower.translate(0, -0.55 + 0.0, 0);
  const hull = new THREE.BufferGeometry();
  const merge = (gs: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    for (const g of gs) {
      const gi = g.index ? g : g.toNonIndexed();
      const p = gi.getAttribute('position'), n = gi.getAttribute('normal'), base = pos.length / 3;
      for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
      if (gi.index) for (let i = 0; i < gi.index.count; i++) idx.push(base + gi.index.getX(i)); else for (let i = 0; i < p.count; i++) idx.push(base + i);
    }
    const o = new THREE.BufferGeometry();
    o.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); o.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); o.setIndex(idx);
    return o;
  };
  hull.copy(merge([upper, lower]));
  // The deck: a plank floor in the hull's outline, a hair under the gunwale's inner edge.
  const deck = new THREE.ExtrudeGeometry(hullShape(0.94), { depth: 0.06, bevelEnabled: false });
  deck.rotateX(Math.PI / 2); deck.translate(0, DECK + 0.012, 0);
  const b = new Batch(), g = new Batch();
  // The band along the topsides, a stripe at the waterline, and the bulwarks (both faces) with a cream cap.
  for (const s of [-1, 1]) {
    b.box(s * 1.82, 0.3, -1.85, 0.05, 0.14, 7.3, CREAM, 0, 7);
    b.box(s * 1.83, 0.02, -1.85, 0.05, 0.1, 7.3, ORANGE, 0, 7);
    b.box(s * 1.76, DECK, -1.85, 0.08, 0.5, 7.3, DEEP, 0, 7);
    b.box(s * 1.76, DECK + 0.5, -1.85, 0.15, 0.04, 7.3, CREAM, 0, 7);
  }
  b.box(0, DECK, -5.46, 3.52, 0.5, 0.08, DEEP, 0, 7);
  b.box(0, DECK + 0.5, -5.46, 3.6, 0.04, 0.15, CREAM, 0, 7);
  // The bow's two bulwark panels, each face drawn.
  const panel = (x0: number, z0: number, x1: number, z1: number): void => {
    const y0 = DECK, y1 = DECK + 0.5;
    b.quad(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, DEEP);
    b.quad(x1, y0, z1, x0, y0, z0, x0, y1, z0, x1, y1, z1, DEEP);
  };
  for (const s of [-1, 1]) { panel(s * 1.76, 1.8, s * 1.2, 4.3); panel(s * 1.2, 4.3, 0, 5.82); }
  // The cabin: sole, walls with window openings (glass in them), roof and the helm.
  const CZ0 = 0.75, CZ1 = 4.1, CW = 1.38;
  b.box(0, DECK + 0.012, (CZ0 + CZ1) / 2, 2.7, 0.02, CZ1 - CZ0, 0x3b2f27, 0, 7);
  for (const s of [-1, 1]) {
    b.box(s * CW, DECK, (CZ0 + CZ1) / 2, 0.08, 1.52 - DECK, CZ1 - CZ0, CREAM, 0, 7);
    b.box(s * CW, 1.52, (CZ0 + CZ1) / 2, 0.08, 0.1, CZ1 - CZ0, ORANGE, 0, 7);
    for (const z of [CZ0 + 0.07, 1.95, 3.3, CZ1 - 0.07]) b.box(s * CW, 1.62, z, 0.1, 0.84, 0.14, CREAM, 0, 7);
    b.box(s * CW, 2.46, (CZ0 + CZ1) / 2, 0.1, 0.08, CZ1 - CZ0, CREAM, 0, 7);
    g.box(s * (CW - 0.02), 1.62, (CZ0 + CZ1) / 2, 0.025, 0.84, CZ1 - CZ0 - 0.2, 0xaebfc9, 0, 7);
  }
  // Forward wall with a windscreen, aft wall open (a wide door).
  b.box(0, DECK, CZ1, 2.84, 1.52 - DECK, 0.08, CREAM, 0, 7);
  b.box(0, 2.46, CZ1, 2.84, 0.08, 0.08, CREAM, 0, 7);
  g.box(0, 1.52, CZ1 - 0.03, 2.6, 0.94, 0.025, 0xaebfc9, 0, 7);
  b.box(0, 1.52, CZ1, 0.08, 0.94, 0.1, CREAM, 0, 7);
  for (const s of [-1, 1]) b.box(s * 1.2, DECK, CZ0, 0.5, 1.97, 0.1, CREAM, 0, 7);
  b.box(0, 2.52, (CZ0 + CZ1) / 2, 3.1, 0.12, CZ1 - CZ0 + 0.5, ROOF, 0, 7);
  b.box(0, 2.62, (CZ0 + CZ1) / 2, 1.6, 0.1, CZ1 - CZ0 - 0.3, DEEP, 0, 7);
  // Helm: a console, a wheel stand, a mast with a lamp and a little flag.
  b.box(0, DECK, 3.65, 1.3, 0.78, 0.5, DARK, 0, 7);
  b.box(0, DECK + 0.78, 3.55, 1.0, 0.04, 0.4, 0x16181a, 0, 7);
  b.box(0, 2.62, 2.9, 0.07, 1.0, 0.07, IRON, 0, 4);
  b.box(0.18, 3.5, 2.9, 0.34, 0.2, 0.02, ORANGE, 0, 7);
  // The canopy over the after deck: a flat roof on slim posts.
  const AZ0 = -5.1, AZ1 = CZ0 + 0.05;
  b.box(0, 2.5, (AZ0 + AZ1) / 2, 3.5, 0.1, AZ1 - AZ0, ROOF, 0, 7);
  b.box(0, 2.6, (AZ0 + AZ1) / 2, 3.5, 0.025, AZ1 - AZ0, TEAL, 0, 7);
  for (const s of [-1, 1]) for (const z of [-4.9, -3.1, -1.3]) b.box(s * 1.76, DECK + 0.5, z, 0.07, 1.45, 0.07, CREAM, 0, 4);
  // Benches: slats and a backrest, facing the bow, with a pedestal under.
  for (const [z, ctr] of [[-1.0, 0], [-2.4, 0], [-3.8, 0], [1.7, 1], [2.9, 1]] as const) {
    const xs = ctr ? [0.78, -0.78] : [0.91, -0.91], w = ctr ? 0.6 : 1.38;
    for (const x of xs) {
      b.box(x, DECK, z, w - 0.1, HIPS - 0.07 - DECK, 0.38, 0x3b3a3a, 0, 7);
      b.box(x, HIPS - 0.07, z, w, 0.07, 0.46, WOODC, 0, 7);
      b.box(x, HIPS, z - 0.25, w, 0.55, 0.06, WOODC, 0, 7);
    }
  }
  // Life rings on the cabin's sides, a bollard at the stern and one at the bow.
  for (const s of [-1, 1]) { b.box(s * 1.45, 1.75, 2.0, 0.06, 0.4, 0.4, ORANGE, 0, 7); b.box(s * 1.47, 1.8, 2.0, 0.04, 0.3, 0.3, CREAM, 0, 7); }
  b.box(0, DECK, -5.2, 0.16, 0.25, 0.16, IRON, 0, 4); b.box(0, DECK, 4.9, 0.16, 0.25, 0.16, IRON, 0, 4);
  const body = b.toGeometry(), glass = g.toGeometry();
  const plate = nameplate();
  const mats = {
    hull: new THREE.MeshStandardMaterial({ color: TEAL, roughness: 0.32, metalness: 0.05, envMap: env }),
    deck: new THREE.MeshStandardMaterial({ color: 0xb59a76, roughness: 0.85, metalness: 0, envMap: env }),
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05, envMap: env }),
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, envMap: env }),
    plate: new THREE.MeshStandardMaterial({ map: plate, roughness: 0.6, transparent: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMap: env }),
  };
  return { hull, deck, body, glass, plate, mats };
}

/** One ferry's visible body from the shared kit. */
export function ferryBody(k: FerryKit, shadows: boolean): THREE.Group {
  const grp = new THREE.Group();
  const hull = new THREE.Mesh(k.hull, k.mats.hull); hull.castShadow = shadows; hull.receiveShadow = shadows;
  const deck = new THREE.Mesh(k.deck, k.mats.deck); deck.receiveShadow = shadows;
  const body = new THREE.Mesh(k.body, k.mats.body); body.castShadow = shadows; body.receiveShadow = shadows;
  const glass = new THREE.Mesh(k.glass, k.mats.glass); glass.renderOrder = 2;
  grp.add(hull, deck, body, glass);
  // The name on the cabin's roof fascia, both sides (a plane faces +z; turn it out of the side it is on).
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 0.58), k.mats.plate);
    m.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    // On the topsides aft of the cabin: a long board.
    m.position.set(s * 1.835, 0.9, -3.0);
    m.scale.set(1.5, 0.75, 1);
    grp.add(m);
  }
  return grp;
}

// ── The landings ──

const mmTime = (m: number): string => {
  const h = Math.floor(m / 60) % 24, mi = Math.round(m % 60), hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(mi).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

function signTexture(d: Dock): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 768; c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#143a47'; x.fillRect(0, 0, 768, 256);
  x.strokeStyle = '#e9e0c8'; x.lineWidth = 8; x.strokeRect(12, 12, 744, 232);
  x.fillStyle = '#e9e0c8'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '600 34px "Barlow Semi Condensed", sans-serif';
  x.fillText('THE CALAMITY SHUTTLE', 384, 52);
  x.fillStyle = '#e4572e'; x.fillRect(120, 78, 528, 5);
  x.fillStyle = '#e9e0c8';
  x.font = '800 86px "Big Shoulders Display", "Barlow Semi Condensed", sans-serif';
  x.fillText(d.sign, 384, 144, 700);
  x.font = '500 28px "IBM Plex Mono", monospace';
  x.fillText(d.sub, 384, 210, 700);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function timetableTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 768; c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f2e8cf'; x.fillRect(0, 0, 768, 512);
  x.strokeStyle = '#143a47'; x.lineWidth = 8; x.strokeRect(12, 12, 744, 488);
  x.fillStyle = '#143a47'; x.fillRect(12, 12, 744, 76);
  x.fillStyle = '#e9e0c8'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '800 54px "Big Shoulders Display", "Barlow Semi Condensed", sans-serif';
  x.fillText('SAILINGS  ·  CALAMITY SHUTTLE', 384, 52);
  x.fillStyle = '#143a47'; x.textAlign = 'left';
  let y = 130;
  for (const d of DOCKS) {
    x.font = '700 30px "Barlow Semi Condensed", sans-serif';
    x.fillText(`Leaves ${d.name}`, 40, y);
    x.font = '500 27px "IBM Plex Mono", monospace';
    const t = departures(DOCKS.indexOf(d)).map(mmTime);
    x.fillText(t.slice(0, 4).join('  '), 40, y + 38);
    x.fillText(t.slice(4).join('  '), 40, y + 38 + (t.length > 4 ? 32 : 0));
    y += 128;
  }
  const P = ferryPlan();
  x.font = '600 24px "Barlow Semi Condensed", sans-serif';
  x.fillStyle = '#e4572e';
  x.fillText(`${FERRIES} boats. About ${Math.round(P.ab.total / 60 * 10) / 10} min across, ${Math.round(P.ab.len / 100) / 10} km. Fare $4 each way,`, 40, 424);
  x.fillText('free in kid-friendly mode. No refunds, no waves.', 40, 456);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** The two landings: planks, piles, bollards, benches, a canopy, signs and timetable boards. Returns the root, already in the scene. */
export function buildFerryDocks(game: Game): THREE.Group {
  const b = new Batch(), root = new THREE.Group();
  const col = game.col;
  const PLANK = 0x9a7a55, TIM = 0x6a4f38, TIMD = 0x4f3b2b;
  const flat = (x0: number, z0: number, x1: number, z1: number, y: number, hex: number): void => { b.box((x0 + x1) / 2, y - 0.14, (z0 + z1) / 2, x1 - x0, 0.14, z1 - z0, hex, 0, 7); };
  const pile = (x: number, z: number, top: number): void => { b.cyl(x, -5, z, 0.2, 0.18, top + 5, TIMD, 6, false); };
  const bollard = (x: number, y: number, z: number): void => { b.cyl(x, y, z, 0.14, 0.12, 0.38, IRON, 8); b.cyl(x, y + 0.38, z, 0.2, 0.2, 0.07, IRON, 8); };
  const bench = (x: number, y: number, z: number, rot: number, len: number): void => {
    const s = Math.sin(rot), c = Math.cos(rot);
    b.box(x, y + 0.4, z, rot ? 0.5 : len, 0.07, rot ? len : 0.5, WOODC, 0, 7);
    b.box(x - s * 0.22, y + 0.47, z - c * 0.22, rot ? 0.06 : len, 0.45, rot ? len : 0.06, WOODC, 0, 7);
    for (const e of [-len / 2 + 0.2, len / 2 - 0.2]) b.box(x + (rot ? 0 : e), y, z + (rot ? e : 0), 0.08, 0.4, 0.08, IRON, 0, 4);
  };
  const post = (x: number, y: number, z: number, h: number): void => { b.box(x, y, z, 0.14, h, 0.14, IRON, 0, 4); };
  const boards: { x: number; y: number; z: number; ry: number; tex: THREE.Texture; w: number; h: number }[] = [];
  const sign = (x: number, y: number, z: number, ry: number, tex: THREE.Texture, w: number, h: number): void => {
    // Two posts square to the board and the board on them, double-faced.
    const s = Math.sin(ry), c = Math.cos(ry);
    for (const e of [-w / 2 + 0.2, w / 2 - 0.2]) { post(x + c * e, y, z - s * e, h + 1.15); col.addProp(x + c * e, z - s * e, 0.12, y + h + 1.1, 'post', false).hard = true; }
    boards.push({ x, y: y + 1.15 + h / 2, z, ry, tex, w, h });
  };

  // ── Pelican Landing: the stem from the beach, the T-head, piles, fenders ──
  {
    const D0 = DOCKS[0], SX0 = 138.5, SX1 = 141.5, SZ0 = 458, SZ1 = 558, Y = 0.4;
    const HX0 = 118, HX1 = 162, HZ0 = 558, HZ1 = 562;
    flat(SX0, SZ0, SX1, SZ1, Y, TIM); flat(HX0, HZ0, HX1, HZ1, Y, TIM);
    for (let z = SZ0 + 0.2; z < SZ1; z += 0.34) b.box((SX0 + SX1) / 2, Y - 0.04, z, SX1 - SX0, 0.04, 0.3, PLANK, 0, 7);
    for (let x = HX0 + 0.2; x < HX1; x += 0.34) b.box(x, Y - 0.04, (HZ0 + HZ1) / 2, 0.3, 0.04, HZ1 - HZ0, PLANK, 0, 7);
    for (let z = SZ0 + 30; z <= SZ1; z += 10) for (const x of [SX0 + 0.2, SX1 - 0.2]) pile(x, z, Y - 0.1);
    for (let x = HX0 + 1; x <= HX1; x += 6) for (const z of [HZ0 + 0.2, HZ1 - 0.2]) pile(x, z, Y + 0.7);
    // Fenders along the head's south face, bollards on its edge.
    for (let x = D0.x - 5; x <= D0.x + 5; x += 2.5) b.box(x, 0.0, HZ1 + 0.1, 0.5, 0.45, 0.2, 0x1a1a1a, 0, 7);
    for (const x of [D0.x - 4.5, D0.x + 4.5]) bollard(x, Y, HZ1 - 0.3);
    col.addBox(SX0, SZ0, SX1, SZ1, Y, -0.6);
    col.addBox(HX0, HZ0, HX1, HZ1, Y, -0.6);
    // The shelter: four posts, a roof, a bench under it.
    const sx = 130, sz = 560;
    for (const dx of [-3.4, 3.4]) for (const dz of [-1.3, 1.3]) post(sx + dx, Y, sz + dz, 2.5);
    b.box(sx, Y + 2.5, sz, 8.2, 0.12, 3.6, TEAL, 0, 7); b.box(sx, Y + 2.62, sz, 8.6, 0.05, 4.0, CREAM, 0, 7);
    bench(sx, Y, sz + 1.0, 0, 4.0);
    // The beach end: a gravel apron and a bench either side of the stem's root.
    flat(SX0 - 3, SZ0 - 4, SX1 + 3, SZ0 + 1, 0.42, 0x8a8576);
    bench(SX0 - 2.0, 0.42, SZ0 + 3.5, Math.PI / 2, 2.2); bench(SX1 + 2.0, 0.42, SZ0 + 3.5, Math.PI / 2, 2.2);
    // Boards: the name over the stem's root, the timetable on the T-head's back, facing the jetty's length.
    sign(140, 0.42, SZ0 + 6, 0, signTexture(D0), 3.6, 1.2);
    sign(151, Y, 559.6, Math.PI, timetableTexture(), 2.6, 1.75);
  }

  // ── Tepid Falls Landing: the wharf below the road bridge ──
  {
    const D1 = DOCKS[1], X0 = 289, X1 = 298.6, Z0 = -1742, Z1 = -1702, Y = 1.0;
    flat(X0, Z0, X1, Z1, Y, TIM);
    for (let z = Z0 + 0.2; z < Z1; z += 0.34) b.box((X0 + X1) / 2, Y - 0.04, z, X1 - X0, 0.04, 0.3, PLANK, 0, 7);
    for (let z = Z0 + 1; z <= Z1; z += 6) for (const x of [X0 + 0.5, X1 - 0.2]) pile(x, z, Y + (x > 296 ? 0.5 : -0.1));
    // Fenders on the water edge and the bollards the ferry's lines go to.
    for (let z = D1.z - 5; z <= D1.z + 5; z += 2.5) b.box(X1 + 0.1, 0.35, z, 0.2, 0.5, 0.5, 0x1a1a1a, 0, 7);
    for (const z of [D1.z - 4.5, D1.z + 4.5]) bollard(X1 - 0.35, Y, z);
    col.addBox(X0, Z0, X1, Z1, Y, 0.2);
    // A rail on the water side, broken at the berth, and the bench.
    for (const [za, zb] of [[Z0, D1.z - 6.5], [D1.z + 6.5, Z1]] as const) {
      for (let z = za; z <= zb + 0.01; z += 2.3) post(X1 - 0.12, Y, z, 0.95);
      b.box(X1 - 0.12, Y + 0.9, (za + zb) / 2, 0.08, 0.07, zb - za, CREAM, 0, 7);
      b.box(X1 - 0.12, Y + 0.45, (za + zb) / 2, 0.05, 0.05, zb - za, CREAM, 0, 7);
    }
    bench(X0 + 1.2, Y, D1.z - 8.5, Math.PI / 2, 2.2);
    // On the bank above the wharf, where the street is, facing the water and the way down.
    const bx = 276.5;
    sign(bx, groundAt(bx, Z0 + 3), Z0 + 3, Math.PI / 2, signTexture(D1), 3.6, 1.2);
    sign(bx, groundAt(bx, Z1 - 3), Z1 - 3, Math.PI / 2, timetableTexture(), 2.6, 1.75);
  }

  const mesh = new THREE.Mesh(b.toGeometry(), game.world.mats.flat);
  mesh.castShadow = game.quality.shadows; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
  root.add(mesh);
  for (const bd of boards) {
    const mat = new THREE.MeshBasicMaterial({ map: bd.tex, toneMapped: false, color: 0xdddddd });
    for (const f of [0, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(bd.w, bd.h), mat);
      m.rotation.y = bd.ry + (f ? Math.PI : 0);
      const off = f ? -0.1 : 0.1;
      m.position.set(bd.x + Math.sin(bd.ry) * off, bd.y, bd.z + Math.cos(bd.ry) * off);
      m.matrixAutoUpdate = false; m.updateMatrix();
      root.add(m);
    }
  }
  root.matrixAutoUpdate = false;
  game.scene.add(root);
  return root;
}
