// The Budget Line's passenger coach, built in code (fun queue 2, item 8).
//
// The Blender coach in public/models/train.glb is a closed box with windows painted on it: nobody inside could be seen.
// This one has real window openings, glass you can see through, a floor, an aisle, 44 seats in rows that line up with
// the windows, and ceiling lights that come on with the dark. It stands in for the glb's coach at close range
// (world/train.ts keeps the glb's cheaper levels for the distance). Local axes as the glb's: +z forward, +x to the left
// (heading h turns +x to (cos h, -sin h)), y up from the rail's top; the floor is at 1.25 as the glb's deck is.

import * as THREE from 'three';
import { Batch } from './batch';

/** Floor height above the rail's top, and the cushion's top above the floor (where a seated person's hips go). */
export const COACH_FLOOR = 1.32;
export const COACH_CUSHION = 1.77;
/** Seats: row k (0..10, front to back as the coach faces forward) and place j (0..3) is seat k * 4 + j, at these local x, z. */
export const COACH_SEATS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let k = 0; k < 11; k++) for (const x of [1.15, 0.65, -0.65, -1.15]) out.push([x, -7.9 + k * 1.58 + 0.2]);
  return out;
})();
/** How the passenger's own coach is told apart in the state frame: world/train.ts car index 1 and 2 are these ids (document: net/protocol uses vehicle 0 for these riders and `color` = id << 8 | seat). */
export const TRAIN_RIDE_BASE = 128;

const GREEN = 0x21452b, DEEP = 0x17301e, CREAM = 0xe6dcc0, ROOF = 0x1c1d1f, FLOOR = 0x3b3029, CARPET = 0x5d2326, VELVET = 0x7a2430, DARK = 0x161617;

export interface CoachParts {
  /** The whole coach body, at its near level of detail (clone it for each coach: geometry and materials are shared). */
  group: THREE.Group;
  /** A warm glow behind every window after dark: its opacity is the train's to set (world/train.ts, with the night). */
  glow: THREE.MeshBasicMaterial;
}

/** Window positions along the coach, as the glb's: 11 a side. */
const WZ: number[] = Array.from({ length: 11 }, (_, k) => -7.9 + k * 1.58);
const WH = 1.15 / 2;
const SILL = 2.3, TOP = 3.55;

function banner(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 64;
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, 1024, 64);
  x.fillStyle = '#e6dcc0';
  x.font = '700 40px "Big Shoulders Display", "Barlow Semi Condensed", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('TEPID FALLS & BUDGET GAP  ·  NO. 4  ALMOST EXPRESS', 512, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Build the coach. `env` is the world's environment map; `lamps` collects the light materials so the train can brighten
 * them after dark (world/train.ts keeps one list for all its lamps).
 */
export function buildCoach(env: THREE.Texture | null, lamps: THREE.MeshBasicMaterial[], shadows: boolean): CoachParts {
  const b = new Batch(), g = new Batch(), lit = new Batch(), gl = new Batch();
  const HL = 10.3;   // half the body, end wall to end wall
  // Underframe: the chassis, skirts and a battery box or two.
  b.box(0, 0.78, 0, 2.7, 0.47, 20.6, DARK);
  b.box(0, 0.98, 0, 3.0, 0.3, 17.6, 0x232426);
  for (const z of [-3.2, 3.2]) b.box(0, 0.62, z, 2.0, 0.4, 1.2, 0x2b2c2f);
  // Floor, carpet down the aisle, the sills under the doors.
  b.box(0, COACH_FLOOR - 0.07, 0, 2.94, 0.07, 20.6, FLOOR, 0, 7);
  b.box(0, COACH_FLOOR, 0, 0.7, 0.012, 20.0, CARPET);
  // Side walls: a lower band, an upper band and a pier between windows; the openings are the windows.
  for (const s of [-1, 1]) {
    const x = s * 1.46;
    b.box(x, 1.25, 0, 0.08, SILL - 1.25, 20.6, GREEN, 0, 7);
    b.box(x + s * 0.005, 1.95, 0, 0.09, 0.07, 20.6, CREAM, 0, 7);
    b.box(x, TOP, 0, 0.08, 4.35 - TOP, 20.6, GREEN, 0, 7);
    b.box(x + s * 0.005, 4.26, 0, 0.09, 0.04, 20.6, CREAM, 0, 7);
    const edges = [-HL, ...WZ.flatMap((z) => [z - WH, z + WH]), HL];
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i], c = edges[i + 1], len = c - a;
      if (len < 0.01) continue;
      b.box(x, SILL, (a + c) / 2, 0.08, TOP - SILL, len, i === 0 || i === edges.length - 2 ? DEEP : GREEN, 0, 7);
    }
    // The glass: one pane to a window, a thin sheet in the wall's thickness.
    for (const z of WZ) { g.box(x, SILL, z, 0.025, TOP - SILL, 1.15, 0xaebfc9, 0, 7); const gx = s * 1.38, z0 = z - WH, z1 = z + WH;
      // A single quad on the wall's inner face, facing into the coach: seen from inside, never from the street side.
      if (s > 0) gl.quad(gx, SILL, z0, gx, SILL, z1, gx, TOP, z1, gx, TOP, z0, 0xffdc9a);
      else gl.quad(gx, SILL, z1, gx, SILL, z0, gx, TOP, z0, gx, TOP, z1, 0xffdc9a); }
    // A lit reading lamp over every other window.
    for (let k = 0; k < WZ.length; k += 2) lit.box(s * 1.05, 4.2, WZ[k], 0.22, 0.04, 0.5, 0xfff0cf, 0, 7);
  }
  // Ends: the bulkheads with their doors, the roof, the clerestory and the lining under it.
  for (const e of [-1, 1]) {
    b.box(0, 1.25, e * HL, 2.94, 4.35 - 1.25, 0.12, DEEP, 0, 7);
    b.box(0, 1.32, e * (HL - 0.08), 1.0, 2.2, 0.03, 0x2d241d, 0, 7);
    b.box(0, 1.3, e * (HL + 0.18), 2.0, 0.08, 0.4, 0x2b2c2f);   // the end platform's floor
  }
  b.box(0, 4.35, 0, 3.1, 0.2, 20.8, ROOF, 0, 7);
  b.box(0, 4.55, 0, 1.7, 0.45, 18.4, ROOF);
  b.box(0, 4.28, 0, 2.9, 0.07, 20.4, CREAM, 0, 7);
  for (let k = 0; k < 5; k++) lit.box(0, 4.24, -8 + k * 4, 0.3, 0.04, 1.3, 0xfff3d8, 0, 7);
  // Seats: a pedestal, the cushion and a back, in rows that face the front.
  for (const [x, z] of COACH_SEATS) {
    const zr = z - 0.2;
    b.box(x, COACH_FLOOR, zr, 0.34, COACH_CUSHION - 0.1 - COACH_FLOOR, 0.4, 0x222325);
    b.box(x, COACH_CUSHION - 0.1, zr, 0.5, 0.1, 0.52, VELVET);
    b.box(x, COACH_CUSHION, zr - 0.25, 0.5, 0.66, 0.1, VELVET);
  }
  // The name along each side, above the windows.
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.08, envMap: env });
  const body = new THREE.Mesh(b.toGeometry(), mat);
  body.castShadow = shadows; body.receiveShadow = shadows;
  grp.add(body);
  const glass = new THREE.Mesh(g.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.25, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, envMap: env }));
  glass.renderOrder = 2;
  grp.add(glass);
  const lm = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.1, 1.1, 1.1) });
  lm.name = 'lamp'; lamps.push(lm);
  grp.add(new THREE.Mesh(lit.toGeometry(), lm));
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const gmesh = new THREE.Mesh(gl.toGeometry(), glow);
  gmesh.renderOrder = 1;
  grp.add(gmesh);
  const tex = banner();
  const bm = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false, envMap: env });
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 0.6), bm);
    // The plane faces +z; turn it to face out of the side it is on, reading front to back as you look at it.
    m.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    m.position.set(s * 1.512, 3.95, 0);
    grp.add(m);
  }
  return { group: grp, glow };
}
