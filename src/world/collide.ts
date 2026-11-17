// Static collision world: buildings are axis-aligned boxes, street furniture is
// circles. Everything is stored in a uniform grid so queries only touch what is nearby.

export interface Box {
  x0: number; z0: number; x1: number; z1: number;
  /** Bottom and top of the box. */
  y0: number; y1: number;
  q: number;
}
export type PropKind = 'lamp' | 'tree' | 'hydrant' | 'bin' | 'mailbox' | 'bench' | 'signal' | 'cone' | 'post';
export interface Prop {
  x: number; z: number; r: number; h: number;
  kind: PropKind;
  breakable: boolean;
  alive: boolean;
  /** Instance slot in the prop renderer, so a broken prop can be hidden. */
  slot: number;
  q: number;
}

const CELL = 24;
const key = (cx: number, cz: number): number => (cx + 512) * 1024 + (cz + 512);

export interface RayHit { t: number; nx: number; ny: number; nz: number }

export class Colliders {
  private boxes = new Map<number, Box[]>();
  private props = new Map<number, Prop[]>();
  private qid = 1;
  allBoxes: Box[] = [];
  onBreak: ((p: Prop, vx: number, vz: number) => void) | null = null;

  addBox(x0: number, z0: number, x1: number, z1: number, y1: number, y0 = 0): Box {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const b: Box = { x0, z0, x1, z1, y0, y1, q: 0 };
    this.allBoxes.push(b);
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = key(cx, cz);
        let a = this.boxes.get(k);
        if (!a) this.boxes.set(k, (a = []));
        a.push(b);
      }
    return b;
  }

  /** A box given by center, size and a rotation that must be a multiple of 90 degrees. */
  addBoxC(cx: number, cz: number, sx: number, sz: number, y1: number, y0 = 0): Box {
    return this.addBox(cx - sx / 2, cz - sz / 2, cx + sx / 2, cz + sz / 2, y1, y0);
  }

  addProp(x: number, z: number, r: number, h: number, kind: PropKind, breakable: boolean, slot = -1): Prop {
    const p: Prop = { x, z, r, h, kind, breakable, alive: true, slot, q: 0 };
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let a = this.props.get(k);
    if (!a) this.props.set(k, (a = []));
    a.push(p);
    return p;
  }

  breakProp(p: Prop, vx: number, vz: number): void {
    if (!p.alive) return;
    p.alive = false;
    this.onBreak?.(p, vx, vz);
  }

  forBoxes(x: number, z: number, r: number, fn: (b: Box) => void): void {
    const id = ++this.qid;
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const a = this.boxes.get(key(cx, cz));
        if (!a) continue;
        for (const b of a) { if (b.q === id) continue; b.q = id; fn(b); }
      }
  }

  forProps(x: number, z: number, r: number, fn: (p: Prop) => void): void {
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const a = this.props.get(key(cx, cz));
        if (!a) continue;
        for (const p of a) if (p.alive) fn(p);
      }
  }

  /**
   * Push a standing circle (a person) out of walls and props.
   * `y` is the height of their feet. Returns true if anything was touched.
   */
  resolveCircle(p: { x: number; z: number }, r: number, y: number): boolean {
    let hit = false;
    const id = ++this.qid;
    for (let cx = Math.floor((p.x - r) / CELL); cx <= Math.floor((p.x + r) / CELL); cx++)
      for (let cz = Math.floor((p.z - r) / CELL); cz <= Math.floor((p.z + r) / CELL); cz++) {
        const k = key(cx, cz);
        const boxes = this.boxes.get(k);
        if (boxes) for (const b of boxes) {
          if (b.q === id) continue; b.q = id;
          if (y >= b.y1 - 0.05 || y + 1.7 < b.y0) continue;
          const qx = p.x < b.x0 ? b.x0 : p.x > b.x1 ? b.x1 : p.x;
          const qz = p.z < b.z0 ? b.z0 : p.z > b.z1 ? b.z1 : p.z;
          let dx = p.x - qx, dz = p.z - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          hit = true;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2), push = (r - d) / d;
            p.x += dx * push; p.z += dz * push;
          } else {
            // Center is inside the box: leave through the nearest face.
            const l = p.x - b.x0, rr = b.x1 - p.x, n = p.z - b.z0, s = b.z1 - p.z;
            const m = Math.min(l, rr, n, s);
            if (m === l) p.x = b.x0 - r; else if (m === rr) p.x = b.x1 + r;
            else if (m === n) p.z = b.z0 - r; else p.z = b.z1 + r;
          }
        }
        const props = this.props.get(k);
        if (props) for (const o of props) {
          if (!o.alive || y > o.h) continue;
          const dx = p.x - o.x, dz = p.z - o.z, rr = r + o.r;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-8) continue;
          const d = Math.sqrt(d2), push = (rr - d) / d;
          p.x += dx * push; p.z += dz * push;
          hit = true;
        }
      }
    return hit;
  }

  /** True if a point is inside any wall at the given height. */
  pointBlocked(x: number, z: number, y: number): boolean {
    const a = this.boxes.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!a) return false;
    for (const b of a) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y < b.y1 && y > b.y0) return true;
    return false;
  }

  /**
   * Cast a ray against the buildings. Returns the distance to the first hit,
   * or `maxDist` if nothing was hit. Fills `out` with the surface normal when given.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out?: RayHit): number {
    let best = maxDist;
    let bnx = 0, bny = 0, bnz = 0;
    const id = ++this.qid;
    // Walk the grid cells the ray crosses (2D DDA).
    let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity, tdz = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL) / Math.abs(dx)) : Infinity;
    let tmz = dz !== 0 ? ((dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL) / Math.abs(dz)) : Infinity;
    let tEnter = 0;
    for (let guard = 0; guard < 256 && tEnter <= best; guard++) {
      const a = this.boxes.get(key(cx, cz));
      if (a) for (const b of a) {
        if (b.q === id) continue; b.q = id;
        // Slab test.
        let t0 = 0, t1 = best, axis = -1, sgn = 0;
        let ok = true;
        for (let k = 0; k < 3 && ok; k++) {
          const o = k === 0 ? ox : k === 1 ? oy : oz, d = k === 0 ? dx : k === 1 ? dy : dz;
          const lo = k === 0 ? b.x0 : k === 1 ? b.y0 : b.z0, hi = k === 0 ? b.x1 : k === 1 ? b.y1 : b.z1;
          if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) ok = false; continue; }
          let ta = (lo - o) / d, tb = (hi - o) / d, s = -1;
          if (ta > tb) { const tt = ta; ta = tb; tb = tt; s = 1; }
          if (ta > t0) { t0 = ta; axis = k; sgn = s; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) ok = false;
        }
        if (ok && axis >= 0 && t0 < best) {
          best = t0;
          bnx = axis === 0 ? sgn : 0; bny = axis === 1 ? sgn : 0; bnz = axis === 2 ? sgn : 0;
        }
      }
      if (tmx < tmz) { tEnter = tmx; tmx += tdx; cx += sx; } else { tEnter = tmz; tmz += tdz; cz += sz; }
    }
    if (out) { out.t = best; out.nx = bnx; out.ny = bny; out.nz = bnz; }
    return best;
  }

  /** Can two points at eye height see each other past the buildings? */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.01) return true;
    return this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d) >= d - 0.01;
  }
}
