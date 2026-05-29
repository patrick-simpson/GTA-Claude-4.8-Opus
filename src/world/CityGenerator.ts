import * as THREE from 'three';
import { Vehicle } from '../entities/Vehicle';

// ── Grid constants ────────────────────────────────────────────────────────────
const GRID        = 8;          // 8×8 city blocks
const BLOCK       = 32;         // block footprint (units)
const STREET      = 10;         // street width
const CELL        = BLOCK + STREET;   // 42
const HALF        = (GRID * CELL) / 2; // 168 — city radius from origin

// ── Color palettes ────────────────────────────────────────────────────────────
const BLDG_COLORS = [
  0xe63946, 0x457b9d, 0x1d3557, 0x2a9d8f,
  0xe9c46a, 0xf4a261, 0x264653, 0x6a0572,
  0x4ecdc4, 0xc77dff, 0x0077b6, 0x588157,
];
const CAR_COLORS = [
  0xff4444, 0x4488ff, 0x44cc44, 0xffcc00,
  0xff44cc, 0x00ccff, 0xff8800, 0xaa44ff,
  0xffffff, 0x888888, 0xcc3300, 0x005577,
];

// ── Shared static materials (no lighting calculation for ground/sidewalk) ─────
const groundMat   = new THREE.MeshBasicMaterial({ color: 0x1a1a2e });
const sidewalkMat = new THREE.MeshLambertMaterial({ color: 0x3a3a52 });
const lineMat     = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
const lampPoleMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
const lampBulbMat = new THREE.MeshLambertMaterial({ color: 0xffffaa, emissive: 0x554400 });

// ── Simple seeded PRNG (LCG) so city is always identical ─────────────────────
class Rng {
  private s: number;
  constructor(seed = 42) { this.s = seed; }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) & 0xffffffff;
    return (this.s >>> 0) / 0x100000000;
  }
  int(min: number, max: number): number { return Math.floor(this.next() * (max - min + 1)) + min; }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
}

export class CityGenerator {
  /** Populates scene with city geometry, returns drivable parked-car instances. */
  generate(scene: THREE.Scene): Vehicle[] {
    const rng = new Rng(7331);
    this._buildGround(scene);
    this._buildBlocks(scene, rng);
    this._buildLampposts(scene);
    this._buildRoadLines(scene);
    return this._buildParkedCars(scene, rng);
  }

  // ── Ground plane ─────────────────────────────────────────────────────────────
  private _buildGround(scene: THREE.Scene): void {
    const size = GRID * CELL + STREET * 2;
    const geo  = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.01;
    scene.add(mesh);
  }

  // ── City blocks: sidewalk planes + buildings ──────────────────────────────
  private _buildBlocks(scene: THREE.Scene, rng: Rng): void {
    for (let gi = 0; gi < GRID; gi++) {
      for (let gj = 0; gj < GRID; gj++) {
        const bx = -HALF + STREET + gi * CELL;
        const bz = -HALF + STREET + gj * CELL;
        const cx = bx + BLOCK / 2;
        const cz = bz + BLOCK / 2;

        // Sidewalk slab
        const swGeo  = new THREE.BoxGeometry(BLOCK + 1.4, 0.14, BLOCK + 1.4);
        const swMesh = new THREE.Mesh(swGeo, sidewalkMat);
        swMesh.position.set(cx, 0.07, cz);
        scene.add(swMesh);

        // Buildings: divide block into a sub-grid
        const cols = rng.int(1, 3);
        const rows = rng.int(1, 3);

        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            const cellW = BLOCK / cols;
            const cellD = BLOCK / rows;
            const margin = 1.8;

            const bw = Math.max(3, cellW - margin * 2 + (rng.next() * 1.6 - 0.8));
            const bd = Math.max(3, cellD - margin * 2 + (rng.next() * 1.6 - 0.8));
            const bh = this._rndHeight(rng);

            const px = bx + c * cellW + cellW / 2;
            const pz = bz + r * cellD + cellD / 2;

            const color   = rng.pick(BLDG_COLORS);
            const bldgGeo = new THREE.BoxGeometry(bw, bh, bd);
            const bldgMat = new THREE.MeshLambertMaterial({ color });
            const bldg    = new THREE.Mesh(bldgGeo, bldgMat);
            bldg.position.set(px, bh / 2 + 0.14, pz);
            scene.add(bldg);

            // Rooftop accent (darker strip)
            const roofGeo = new THREE.BoxGeometry(bw, 0.35, bd);
            const roofMat = new THREE.MeshLambertMaterial({
              color: new THREE.Color(color).multiplyScalar(0.55),
            });
            const roof = new THREE.Mesh(roofGeo, roofMat);
            roof.position.set(px, bh + 0.32, pz);
            scene.add(roof);
          }
        }
      }
    }
  }

  private _rndHeight(rng: Rng): number {
    const t = rng.next();
    if (t < 0.50) return 4 + rng.next() * 9;      // low:    4–13
    if (t < 0.80) return 13 + rng.next() * 14;    // mid:   13–27
    return 28 + rng.next() * 22;                   // tall:  28–50
  }

  // ── Road centre-line dashes ───────────────────────────────────────────────
  private _buildRoadLines(scene: THREE.Scene): void {
    const dashLen    = CELL * 0.38;
    const dashGap    = CELL * 0.62;
    const dashOffset = CELL * 0.5;

    // Horizontal roads
    for (let j = 0; j <= GRID; j++) {
      const z = -HALF + j * CELL + STREET / 2;
      for (let i = 0; i < GRID; i++) {
        const x = -HALF + STREET + i * CELL + dashOffset;
        const geo  = new THREE.BoxGeometry(dashLen, 0.04, 0.28);
        const mesh = new THREE.Mesh(geo, lineMat);
        mesh.position.set(x, 0.03, z);
        scene.add(mesh);
      }
    }

    // Vertical roads
    for (let i = 0; i <= GRID; i++) {
      const x = -HALF + i * CELL + STREET / 2;
      for (let j = 0; j < GRID; j++) {
        const z    = -HALF + STREET + j * CELL + dashOffset;
        const geo  = new THREE.BoxGeometry(0.28, 0.04, dashLen);
        const mesh = new THREE.Mesh(geo, lineMat);
        mesh.position.set(x, 0.03, z);
        scene.add(mesh);
      }
    }
  }

  // ── Lampposts at selected intersections ──────────────────────────────────
  private _buildLampposts(scene: THREE.Scene): void {
    // Only place at every-other intersection for perf
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 5, 6);
    const armGeo  = new THREE.BoxGeometry(1.4, 0.1, 0.1);
    const bulbGeo = new THREE.BoxGeometry(0.42, 0.22, 0.42);

    for (let i = 0; i <= GRID; i += 2) {
      for (let j = 0; j <= GRID; j += 2) {
        const ix = -HALF + i * CELL;
        const iz = -HALF + j * CELL;

        const corners = [
          { x: ix + 1.2, z: iz + 1.2 },
          { x: ix - 1.2, z: iz + 1.2 },
        ];

        for (const c of corners) {
          const pole = new THREE.Mesh(poleGeo, lampPoleMat);
          pole.position.set(c.x, 2.5, c.z);
          scene.add(pole);

          const arm = new THREE.Mesh(armGeo, lampPoleMat);
          arm.position.set(c.x + 0.7, 5.05, c.z);
          scene.add(arm);

          const bulb = new THREE.Mesh(bulbGeo, lampBulbMat);
          bulb.position.set(c.x + 1.4, 4.85, c.z);
          scene.add(bulb);
        }
      }
    }
  }

  // ── Parked cars ───────────────────────────────────────────────────────────
  private _buildParkedCars(scene: THREE.Scene, rng: Rng): Vehicle[] {
    const vehicles: Vehicle[] = [];
    const spots: Array<{ x: number; z: number; h: number }> = [];

    // Along horizontal streets (parked on both sides of each block row)
    for (let j = 0; j <= GRID; j++) {
      const streetZ = -HALF + j * CELL + STREET / 2;

      for (let i = 0; i < GRID; i++) {
        const blockMidX = -HALF + STREET + i * CELL + BLOCK / 2;

        if (rng.next() < 0.55) {
          spots.push({ x: blockMidX - BLOCK * 0.15, z: streetZ - 3.6, h: 0 });
        }
        if (rng.next() < 0.55) {
          spots.push({ x: blockMidX + BLOCK * 0.15, z: streetZ + 3.6, h: Math.PI });
        }
      }
    }

    // Along vertical streets
    for (let i = 0; i <= GRID; i++) {
      const streetX = -HALF + i * CELL + STREET / 2;

      for (let j = 0; j < GRID; j++) {
        const blockMidZ = -HALF + STREET + j * CELL + BLOCK / 2;

        if (rng.next() < 0.45) {
          spots.push({ x: streetX - 3.6, z: blockMidZ - BLOCK * 0.12, h: Math.PI / 2 });
        }
        if (rng.next() < 0.45) {
          spots.push({ x: streetX + 3.6, z: blockMidZ + BLOCK * 0.12, h: -Math.PI / 2 });
        }
      }
    }

    // Cap and shuffle (use up to 28 cars for mobile perf)
    const capped = spots.slice(0, 28);
    capped.forEach((s, idx) => {
      const color   = CAR_COLORS[idx % CAR_COLORS.length];
      const vehicle = new Vehicle(scene, new THREE.Vector3(s.x, 0, s.z), s.h, color);
      vehicles.push(vehicle);
    });

    return vehicles;
  }
}

// Export city constants so main.ts can use them for boundary clamping
export const CITY_HALF = HALF;
