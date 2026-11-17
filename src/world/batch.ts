// Geometry batching. The whole city is thousands of boxes and quads; drawing
// each one separately would be far too slow, so they are accumulated here and
// merged into a handful of big meshes, split into square chunks for culling.

import * as THREE from 'three';

const C = new THREE.Color();
const CHUNK = 220;

export class Batch {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  private n = 0;

  /** Quad a-b-c-d, counter-clockwise when seen from the front. UVs: a=(u0,v0) b=(u1,v0) c=(u1,v1) d=(u0,v1). */
  quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    hex: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1, shade = 1,
  ): void {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    C.setHex(hex);
    const r = C.r * shade, g = C.g * shade, b = C.b * shade;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    this.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, b, r, g, b, r, g, b, r, g, b);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    const n = this.n;
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    this.n += 4;
  }

  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, hex: number, shade = 1): void {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    C.setHex(hex);
    const r = C.r * shade, g = C.g * shade, b = C.b * shade;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, b, r, g, b, r, g, b);
    this.uv.push(0, 0, 1, 0, 0.5, 1);
    const n = this.n;
    this.idx.push(n, n + 1, n + 2);
    this.n += 3;
  }

  /**
   * Box with its base at y0. `rot` turns it about the vertical axis.
   * `faces` is a bit mask: 1 top, 2 bottom, 4 sides.
   */
  box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, hex: number, rot = 0, faces = 5, shade = 1): void {
    const hx = sx / 2, hz = sz / 2, y1 = y0 + sy;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    // Corner i: (±hx, ±hz) rotated.
    const X = (lx: number, lz: number): number => cx + lx * cs + lz * sn;
    const Z = (lx: number, lz: number): number => cz - lx * sn + lz * cs;
    const x00 = X(-hx, -hz), z00 = Z(-hx, -hz), x10 = X(hx, -hz), z10 = Z(hx, -hz);
    const x11 = X(hx, hz), z11 = Z(hx, hz), x01 = X(-hx, hz), z01 = Z(-hx, hz);
    if (faces & 1) this.quad(x01, y1, z01, x11, y1, z11, x10, y1, z10, x00, y1, z00, hex, 0, 0, 1, 1, shade);
    if (faces & 2) this.quad(x00, y0, z00, x10, y0, z10, x11, y0, z11, x01, y0, z01, hex, 0, 0, 1, 1, shade);
    if (faces & 4) {
      this.quad(x01, y0, z01, x11, y0, z11, x11, y1, z11, x01, y1, z01, hex, 0, 0, 1, 1, shade); // +Z
      this.quad(x10, y0, z10, x00, y0, z00, x00, y1, z00, x10, y1, z10, hex, 0, 0, 1, 1, shade); // -Z
      this.quad(x11, y0, z11, x10, y0, z10, x10, y1, z10, x11, y1, z11, hex, 0, 0, 1, 1, shade); // +X
      this.quad(x00, y0, z00, x01, y0, z01, x01, y1, z01, x00, y1, z00, hex, 0, 0, 1, 1, shade); // -X
    }
  }

  /** Flat horizontal rectangle facing up. UVs span the rect once unless a repeat is given. */
  floor(x0: number, z0: number, x1: number, z1: number, y: number, hex: number, ur = 1, vr = 1, shade = 1): void {
    this.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, hex, 0, 0, ur, vr, shade);
  }

  /** Four textured walls of an axis-aligned box. u counts bays, v counts floors (in texture tiles). */
  walls(
    x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, hex: number,
    bay: number, floorH: number, tiles: number, seed: number,
  ): void {
    const fl = Math.max(1, Math.round((y1 - y0) / floorH)) / tiles;
    const side = (ax: number, az: number, bx: number, bz: number, k: number): void => {
      const len = Math.hypot(bx - ax, bz - az);
      const u = Math.max(1, Math.round(len / bay)) / tiles;
      const uo = ((seed * 7 + k * 3) % tiles) / tiles, vo = ((seed * 5 + k) % tiles) / tiles;
      this.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, hex, uo, vo, uo + u, vo + fl);
    };
    side(x0, z1, x1, z1, 0); // south face (+Z)
    side(x1, z0, x0, z0, 1); // north face (-Z)
    side(x1, z1, x1, z0, 2); // east face (+X)
    side(x0, z0, x0, z1, 3); // west face (-X)
  }

  /** Vertical cylinder / cone frustum with its base at y0. */
  cyl(cx: number, y0: number, cz: number, r0: number, r1: number, h: number, hex: number, seg = 8, cap = true, shade = 1): void {
    const y1 = y0 + h;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      // Outward-facing side quad (angles increase counter-clockwise seen from above => a1 is to the left).
      this.quad(
        cx + c1 * r0, y0, cz + s1 * r0, cx + c0 * r0, y0, cz + s0 * r0,
        cx + c0 * r1, y1, cz + s0 * r1, cx + c1 * r1, y1, cz + s1 * r1, hex, 0, 0, 1, 1, shade,
      );
      if (cap && r1 > 0.01) this.tri(cx, y1, cz, cx + c1 * r1, y1, cz + s1 * r1, cx + c0 * r1, y1, cz + s0 * r1, hex, shade);
    }
  }

  get empty(): boolean { return this.n === 0; }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A set of batches keyed by map chunk, so far-away parts of the city can be skipped by the GPU. */
export class Chunked {
  private map = new Map<string, Batch>();
  at(x: number, z: number): Batch {
    const k = Math.floor(x / CHUNK) + ':' + Math.floor(z / CHUNK);
    let b = this.map.get(k);
    if (!b) this.map.set(k, (b = new Batch()));
    return b;
  }
  build(mat: THREE.Material, parent: THREE.Object3D, shadows = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const b of this.map.values()) {
      if (b.empty) continue;
      const m = new THREE.Mesh(b.toGeometry(), mat);
      m.castShadow = shadows; m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      parent.add(m);
      out.push(m);
    }
    this.map.clear();
    return out;
  }
}
