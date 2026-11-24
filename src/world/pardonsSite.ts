// Pardon's Surplus & Salvage: where the store and its lot stand, as plain numbers (no imports, so plan.ts can use it).
//
// After the Waterville store of Maine's surplus-and-salvage chain on Kennedy Memorial Drive, the commercial strip that
// runs west out of downtown to the interstate exit (tools/briefs/tepid-reference.md, "The surplus store"). In Tepid
// Falls that road is Second Thought Ave (z -1295) and the interstate is The Thruway (x -700): the store has the
// exits block on the south side of the avenue beside the Thruway exit (grid cells i 0, j 7 and 8), facing north
// over its lot to the avenue, as the real one faces its lot and the drive. Scaled 0.79 from the real 104 x 79 m.
//
// Store frame (tools/blender/buildings.py `--store` authors in it): x along the storefront from the EAST end (0) to
// the west end (SW), y up from the floor, z out of the front wall toward the lot. World: X = XE - x, Z = ZF - z.

export const PD = {
  XE: -601, ZF: -1158,
  SW: 82, SD: 62, SH: 6.8, SEW: 23, SBZ: 1.6, SEH: 8.8, SCH: 4.3, SOFFIT_Z: -9, SOFFIT_Y: 3.3,
  /** Entrance openings in the storefront (store x), each with two sliding leaves. */
  DOORS: [[3.5, 6.5], [16.5, 19.5]] as [number, number][],
  /** Checkout counters: west edge x of each (store frame); counters run z -7.2..-2.3. */
  LANES: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => 27 + 3.6 * k),
  COLS_X: [11, 23, 35, 47, 59, 71], COLS_Z: [-14, -26, -38, -50],
  /** The grid cells the store takes over (no other builder puts lots on them). */
  CELLS: [[0, 7], [0, 8]] as [number, number][],
  /** The lot (world): inside the block's sidewalks, north of the store's front walk. */
  LOT: { x0: -686.5, x1: -599.5, z0: -1280.3, z1: -1164 },
};

export const pdWorld = (x: number, z: number): [number, number] => [PD.XE - x, PD.ZF - z];
/** A store-frame rectangle as a world rectangle. */
export const pdRect = (x0: number, z0: number, x1: number, z1: number): { x0: number; z0: number; x1: number; z1: number } =>
  ({ x0: PD.XE - Math.max(x0, x1), x1: PD.XE - Math.min(x0, x1), z0: PD.ZF - Math.max(z0, z1), z1: PD.ZF - Math.min(z0, z1) });

/**
 * The lot, west to east: S single row, A drive aisle (7.5 m, running north-south toward the store, as the real lot's
 * rows do), D double row (two 5.5 m stalls nose to nose). Stalls are 2.74 m wide, from the store drive to the north drive.
 */
export const LOT_COLS: { kind: 'S' | 'A' | 'D'; x0: number; x1: number }[] = (() => {
  const seq: ('S' | 'A' | 'D')[] = ['S', 'A', 'D', 'A', 'D', 'A', 'D', 'A', 'D', 'A'];
  const w = { S: 5.5, A: 7.5, D: 11 };
  let x = PD.LOT.x0;
  return seq.map((kind) => { const c = { kind, x0: x, x1: x + w[kind] }; x += w[kind]; return c; });
})();
export const STALL = { w: 2.74, d: 5.5, z0: -1270, z1: -1174.5 };
/** Lamp standards (world x, z), on the centre line of each double row. */
export const LOT_LAMPS: [number, number][] = LOT_COLS.filter((c) => c.kind === 'D').flatMap((c) => [[(c.x0 + c.x1) / 2, -1199], [(c.x0 + c.x1) / 2, -1246]] as [number, number][]);
/** Cart corrals: world centre and the way the open end faces (+1 east, -1 west). */
export const CORRALS: { x: number; z: number; open: 1 | -1 }[] = [
  { x: -670.6, z: -1206.4, open: -1 }, { x: -646.9, z: -1229.7, open: 1 }, { x: -615.4, z: -1192.2, open: -1 },
];
/** The road sign on the island by the avenue, and the two driveways onto the avenue (aisle x ranges). */
export const ROAD_SIGN = { x: -647, z: -1277.5 };
export const DRIVES_N: [number, number][] = [[-644, -636.5], [-607, -599.5]];

/** Every stall: centre and heading (cars point along x), skipping those the corrals take. */
export function pardonsStalls(): { x: number; z: number; h: number }[] {
  const out: { x: number; z: number; h: number }[] = [];
  const n = Math.floor((STALL.z1 - STALL.z0) / STALL.w);
  for (const c of LOT_COLS) {
    if (c.kind === 'A') continue;
    const halves = c.kind === 'S' ? [[c.x0, c.x1, Math.PI / 2]] : [[c.x0, c.x0 + 5.5, Math.PI / 2], [c.x0 + 5.5, c.x1, -Math.PI / 2]];
    for (const [a, b, h] of halves) {
      for (let k = 0; k < n; k++) {
        const x = (a + b) / 2, z = STALL.z0 + (k + 0.5) * STALL.w;
        if (CORRALS.some((q) => Math.abs(q.x - x) < 3 && Math.abs(q.z - z) < 2.5)) continue;
        out.push({ x, z, h });
      }
    }
  }
  return out;
}

/**
 * The sales floor for unit 2 (store frame): departments as rectangles to fill with gondolas, racks and floor stock,
 * after the real store's mix. Gondolas run front to back (along z), 1.2 m deep, on a 3.6 m pitch (2.4 m aisles), and
 * stop short of the column grid (COLS_X x COLS_Z, 0.3 m square). The front 9 m (soffit, checkouts, the way in) and
 * the back 4 m (the stockroom doors) stay clear.
 */
export const DEPARTMENTS: { name: string; x0: number; x1: number; z0: number; z1: number; fill: 'gondola' | 'racks' | 'floor' | 'rolls' }[] = [
  { name: 'grocery and snacks', x0: 1.5, x1: 21, z0: -40, z1: -11, fill: 'gondola' },
  { name: 'health and beauty', x0: 1.5, x1: 21, z0: -57, z1: -42, fill: 'gondola' },
  { name: 'housewares and seasonal', x0: 24, x1: 45, z0: -34, z1: -11, fill: 'gondola' },
  { name: 'hardware and tools', x0: 24, x1: 45, z0: -57, z1: -36, fill: 'gondola' },
  { name: 'clothing and shoes', x0: 48, x1: 58, z0: -57, z1: -11, fill: 'racks' },
  { name: 'fabric', x0: 61, x1: 80, z0: -30, z1: -11, fill: 'gondola' },
  { name: 'furniture and mattresses', x0: 61, x1: 80, z0: -50, z1: -32, fill: 'floor' },
  { name: 'flooring rolls and rugs', x0: 61, x1: 81.4, z0: -57.5, z1: -51, fill: 'rolls' },
];
