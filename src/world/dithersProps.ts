// Dithers College's outdoor furniture: granite name plaques on the quad, lamps, benches and lawn maples (all instanced, placed with
// campusFree and kept off the paths), grandstand seating, goals, and a fenced tennis court. Nothing here runs per frame: it is built
// once, as a handful of instanced or merged meshes (about eleven draw calls for the whole campus), and culls as whole meshes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import { groundAt, streetSurface } from './plan';
import { EXTRA } from './floraAssets';
import { CAMPUS_BUILDINGS, CAMPUS_DRIVES, CAMPUS_FIELDS, CAMPUS_PATHS, campusFree } from './dithersPlan';
import { LOOKOUT } from './dithersPond';

/** True when (x, z) is more than m metres from every street's carriageway and sidewalk (the current graph, so no lamp, bench or tree stands in a road). */
const offRoad = (x: number, z: number, m: number): boolean => !streetSurface()?.nearRoad(x, z, m);

/** Merged boxes and quads in a movable frame (a yaw about y, as three's rotation.y). */
class G {
  p: number[] = []; n: number[] = []; c: number[] = []; u: number[] = [];
  private ox = 0; private oy = 0; private oz = 0; private cy = 1; private sy = 0;
  frame(x: number, y: number, z: number, yaw: number): this { this.ox = x; this.oy = y; this.oz = z; this.cy = Math.cos(yaw); this.sy = Math.sin(yaw); return this; }
  W(x: number, y: number, z: number): number[] { return [this.ox + x * this.cy + z * this.sy, this.oy + y, this.oz - x * this.sy + z * this.cy]; }
  /** Local counter-clockwise (seen from outside) polygon given as 4 corners. */
  quad(a: number[], b: number[], c: number[], d: number[], col: number, uv: number[] = [0.02, 0.02, 0.02, 0.02], double = false): void {
    const col3 = new THREE.Color(col), A = this.W(a[0], a[1], a[2]), Bq = this.W(b[0], b[1], b[2]), C = this.W(c[0], c[1], c[2]), D = this.W(d[0], d[1], d[2]);
    const nx = (Bq[1] - A[1]) * (C[2] - A[2]) - (Bq[2] - A[2]) * (C[1] - A[1]), ny = (Bq[2] - A[2]) * (C[0] - A[0]) - (Bq[0] - A[0]) * (C[2] - A[2]), nz = (Bq[0] - A[0]) * (C[1] - A[1]) - (Bq[1] - A[1]) * (C[0] - A[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    const tri = (P: number[][], U: number[][], s: number): void => { for (let i = 0; i < 3; i++) { this.p.push(...P[i]); this.n.push((nx / l) * s, (ny / l) * s, (nz / l) * s); this.c.push(col3.r, col3.g, col3.b); this.u.push(...U[i]); } };
    const U = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
    tri([A, Bq, C], [U[0], U[1], U[2]], 1); tri([A, C, D], [U[0], U[2], U[3]], 1);
    if (double) { tri([A, C, Bq], [U[0], U[2], U[1]], -1); tri([A, D, C], [U[0], U[3], U[2]], -1); }
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: number, uv?: number[]): void {
    const h = [sx / 2, sy / 2, sz / 2], ctr = [cx, cy, cz];
    for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
      const b = (a + 1) % 3, c = (a + 2) % 3, v = (i: number, j: number): number[] => { const q = [0, 0, 0]; q[a] = ctr[a] + s * h[a]; q[b] = ctr[b] + i * h[b]; q[c] = ctr[c] + j * h[c]; return q; };
      const pts = s > 0 ? [v(-1, -1), v(1, -1), v(1, 1), v(-1, 1)] : [v(-1, -1), v(-1, 1), v(1, 1), v(1, -1)];
      this.quad(pts[0], pts[1], pts[2], pts[3], col, uv);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.computeBoundingSphere(); return g;
  }
}

let seed = 91;
const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const fieldXform = (cx: number, cz: number, a: number) => (lx: number, lz: number): [number, number] => [cx + lx * Math.cos(a) - lz * Math.sin(a), cz + lx * Math.sin(a) + lz * Math.cos(a)];

function plaqueAtlas(names: string[]): { tex: THREE.CanvasTexture; rows: number } {
  const H = 48, rows = names.length + 1, c = document.createElement('canvas'); c.width = 512; c.height = H * rows;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8c8a84'; g.fillRect(0, 0, 512, H);
  for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(${60 + rnd() * 120},${60 + rnd() * 120},${60 + rnd() * 120},0.35)`; g.fillRect(rnd() * 512, rnd() * H, 2, 2); }
  names.forEach((nm, i) => {
    const y = (i + 1) * H;
    g.fillStyle = '#2f3a33'; g.fillRect(0, y, 512, H);
    g.strokeStyle = '#b89a5a'; g.lineWidth = 2; g.strokeRect(4, y + 4, 504, H - 8);
    let fs = 24; g.font = `bold ${fs}px Georgia, serif`;
    while (g.measureText(nm).width > 470 && fs > 11) { fs -= 1; g.font = `bold ${fs}px Georgia, serif`; }
    g.fillStyle = '#e6d6a3'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(nm, 256, y + H / 2 + 1);
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { tex: t, rows };
}

function meshTex(kind: 'chain' | 'net'): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!; g.strokeStyle = '#fff'; g.lineWidth = kind === 'chain' ? 3 : 2;
  if (kind === 'chain') { g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64); g.moveTo(0, 32); g.lineTo(32, 64); g.moveTo(32, 0); g.lineTo(64, 32); g.moveTo(0, 32); g.lineTo(32, 0); g.moveTo(32, 64); g.lineTo(64, 32); g.stroke(); }
  else { g.strokeRect(1, 1, 62, 62); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
}

export interface CampusProps { setNight(n: number): void; dispose(): void }

export function buildCampusProps(game: Game, parent: THREE.Object3D, env: THREE.Texture | null): CampusProps {
  void game;
  const grp = new THREE.Group(); grp.name = 'dithers-props'; parent.add(grp);
  const low = game.quality.name === 'low' || !!game.quality.lean, scale = low ? 0.5 : 1;
  const mats: THREE.Material[] = [];
  const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => { const m = new THREE.MeshStandardMaterial({ envMap: env, envMapIntensity: 0.4, ...o }); mats.push(m); return m; };
  const put = (m: THREE.Mesh, cast = false): void => { m.castShadow = cast; m.receiveShadow = true; grp.add(m); };

  // ── Path samples (for keeping lamps and trees off the walks) ──
  const walk: [number, number][] = [];
  for (const arr of [...CAMPUS_PATHS, ...CAMPUS_DRIVES]) for (let i = 0; i + 3 < arr.length; i += 2) {
    const ax = arr[i], az = arr[i + 1], bx = arr[i + 2], bz = arr[i + 3], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    for (let k = 0; k < n; k++) walk.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  const awayFromWalks = (x: number, z: number, d: number): boolean => { for (const w of walk) if (Math.abs(w[0] - x) < d && Math.abs(w[1] - z) < d && Math.hypot(w[0] - x, w[1] - z) < d) return false; return true; };

  // ── Name plaques ──
  {
    const cand: { name: string; x: number; z: number; face: number }[] = [];
    const rowsB = CAMPUS_BUILDINGS.filter((b) => b[4].length >= 5 && b[0] !== 5 && b[0] !== 6).map((b) => ({ b, area: b[4][2] * b[4][3] + (b[2] ? 400 : 0) })).sort((p, q) => q.area - p.area).slice(0, 26);
    for (const { b } of rowsB) {
      const [style, , flags, nm, rr] = b; void style;
      const r = { cx: rr[0], cz: rr[1], w: rr[2], d: rr[3], a: rr[4] }, c = Math.cos(r.a), s = Math.sin(r.a);
      let best = 1e9, bx = r.cx, bz = r.cz;
      for (const [px, pz] of walk) { const dd = Math.hypot(px - r.cx, pz - r.cz); if (dd < best) { best = dd; bx = px; bz = pz; } }
      const lx = (bx - r.cx) * c + (bz - r.cz) * s, lz = -(bx - r.cx) * s + (bz - r.cz) * c;
      let px: number, pz: number;
      if (flags & 8) { const ox = 7.8, oz = r.d / 2 + 6.5; px = r.cx + ox * c - oz * s; pz = r.cz + ox * s + oz * c; }
      else if (flags & 2) { const ox = -r.w / 2 - 9.5, oz = 6.0; px = r.cx + ox * c - oz * s; pz = r.cz + ox * s + oz * c; }
      else if (Math.abs(lx) / (r.w / 2) > Math.abs(lz) / (r.d / 2)) { const ox = Math.sign(lx) * (r.w / 2 + 2.6), oz = Math.max(-r.d / 4, Math.min(r.d / 4, lz)); px = r.cx + ox * c - oz * s; pz = r.cz + ox * s + oz * c; }
      else { const oz = Math.sign(lz) * (r.d / 2 + 2.6), ox = Math.max(-r.w / 4, Math.min(r.w / 4, lx)); px = r.cx + ox * c - oz * s; pz = r.cz + ox * s + oz * c; }
      const face = Math.atan2(bx - px, bz - pz);
      const fx = flags & 8 ? r.cx + 7.8 * c - (r.d / 2 + 6.5) * s : px; void fx;
      if (!campusFree(px, pz, 0.2)) continue;
      cand.push({ name: nm.replace(/\s*\(.*\)\s*/g, ''), x: px, z: pz, face: flags & 8 ? -r.a : flags & 2 ? Math.atan2(-c, -s) : face });
    }
    if (cand.length) {
      const atlas = plaqueAtlas(cand.map((q) => q.name)), H = 1 / atlas.rows;
      const g = new G(), granite = 0xb9b6ad;
      cand.forEach((q, i) => {
        const y = groundAt(q.x, q.z), v0 = 1 - (i + 2) * H + 0.002, v1 = 1 - (i + 1) * H - 0.002;
        g.frame(q.x, y, q.z, q.face);
        g.box(0, 0.12, 0, 1.9, 0.24, 0.55, granite, [0.02, 1 - H + 0.01, 0.4, 0.99]);
        g.box(0, 0.62, 0, 1.7, 0.7, 0.3, granite, [0.02, 1 - H + 0.01, 0.4, 0.99]);
        g.quad([-0.8, 0.3, 0.16], [0.8, 0.3, 0.16], [0.8, 0.94, 0.16], [-0.8, 0.94, 0.16], 0xffffff, [0.02, v0, 0.98, v1]);
      });
      put(new THREE.Mesh(g.geometry(), std({ map: atlas.tex, roughness: 0.7, vertexColors: true })));
    }
  }

  // ── Lamps and benches along the walks ──
  const lampM: THREE.Matrix4[] = [], benchM: THREE.Matrix4[] = [];
  {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
    let acc = 14, side = 1, bacc = 40;
    const LAMP_GAP = 34 / Math.sqrt(scale), BENCH_GAP = 85 / scale;
    for (const arr of CAMPUS_PATHS) for (let i = 0; i + 3 < arr.length; i += 2) {
      const ax = arr[i], az = arr[i + 1], bx = arr[i + 2], bz = arr[i + 3], len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) continue;
      const tx = (bx - ax) / len, tz = (bz - az) / len;
      for (let t = 0; t < len; t += 1) {
        acc += 1; bacc += 1;
        const x = ax + tx * t, z = az + tz * t;
        if (acc > LAMP_GAP && lampM.length < 240) {
          const ox = x - tz * 1.9 * side, oz = z + tx * 1.9 * side;
          if (campusFree(ox, oz, 0.8) && offRoad(ox, oz, 1) && awayFromWalks(ox, oz, 1.2) === true) { lampM.push(m4.clone().setPosition(ox, groundAt(ox, oz), oz)); acc = 0; side = -side; }
          else if (campusFree(ox, oz, 0.8) && offRoad(ox, oz, 1)) { const px = x - tz * 2.6 * side, pz = z + tx * 2.6 * side; if (campusFree(px, pz, 0.8) && offRoad(px, pz, 1)) { lampM.push(m4.clone().setPosition(px, groundAt(px, pz), pz)); acc = 0; side = -side; } }
        }
        if (bacc > BENCH_GAP && benchM.length < 110) {
          const ox = x + tz * 2.3, oz = z - tx * 2.3;
          if (campusFree(ox, oz, 1.0) && offRoad(ox, oz, 1)) { q.setFromAxisAngle(UP, Math.atan2(-tz, tx) + Math.PI / 2 * 0 + Math.PI); benchM.push(new THREE.Matrix4().compose(new THREE.Vector3(ox, groundAt(ox, oz) + 0.02, oz), q.setFromAxisAngle(UP, Math.atan2(tx, tz) - Math.PI / 2), new THREE.Vector3(1, 1, 1))); bacc = 0; }
        }
      }
    }
  }
  let bulbMat: THREE.MeshBasicMaterial | null = null;
  if (lampM.length) {
    const g = new G(), iron = 0x1f2a24;
    g.box(0, 0.2, 0, 0.42, 0.4, 0.42, iron); g.box(0, 2.1, 0, 0.13, 3.4, 0.13, iron); g.box(0, 3.88, 0, 0.45, 0.1, 0.45, iron);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.box(sx * 0.17, 4.22, sz * 0.17, 0.04, 0.6, 0.04, iron);
    g.box(0, 4.6, 0, 0.5, 0.08, 0.5, iron); g.box(0, 4.72, 0, 0.22, 0.16, 0.22, iron);
    const im = new THREE.InstancedMesh(g.geometry(), std({ vertexColors: true, roughness: 0.6, metalness: 0.4 }), lampM.length);
    const bg = new G(); bg.box(0, 4.22, 0, 0.26, 0.52, 0.26, 0xffffff);
    bulbMat = new THREE.MeshBasicMaterial({ color: 0x9a9684 });
    const bi = new THREE.InstancedMesh(bg.geometry(), bulbMat, lampM.length);
    lampM.forEach((m, i) => { im.setMatrixAt(i, m); bi.setMatrixAt(i, m); });
    im.instanceMatrix.needsUpdate = true; bi.instanceMatrix.needsUpdate = true;
    for (const m of [im, bi]) { m.computeBoundingSphere(); put(m); }
  }
  if (benchM.length) {
    const g = new G(), wood = 0x8a5a36, iron = 0x24302a;
    g.box(0, 0.46, 0, 1.7, 0.07, 0.5, wood); g.box(0, 0.8, -0.24, 1.7, 0.42, 0.06, wood);
    for (const sx of [-0.75, 0.75]) { g.box(sx, 0.23, 0, 0.08, 0.46, 0.5, iron); g.box(sx, 0.62, -0.24, 0.08, 0.8, 0.07, iron); }
    const im = new THREE.InstancedMesh(g.geometry(), std({ vertexColors: true, roughness: 0.75 }), benchM.length);
    benchM.forEach((m, i) => im.setMatrixAt(i, m)); im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); put(im);
  }

  // -- Johnson Pond's lookout (dithersPond.ts LOOKOUT): a bench facing the water and a railing on the water side of the pad --
  {
    const L = LOOKOUT, gy = groundAt(L.x, L.z), g = new G(), wood = 0x8a5a36, iron = 0x24302a, rx = L.x + L.hx - 0.2;
    g.frame(L.x - 0.6, gy, L.z, Math.PI / 2);
    g.box(0, 0.46, 0, 1.7, 0.07, 0.5, wood); g.box(0, 0.8, -0.24, 1.7, 0.42, 0.06, wood);
    for (const sx of [-0.75, 0.75]) { g.box(sx, 0.23, 0, 0.08, 0.46, 0.5, iron); g.box(sx, 0.62, -0.24, 0.08, 0.8, 0.07, iron); }
    g.frame(0, gy, 0, 0);
    const z0 = L.z - L.hz - 0.4, z1 = L.z + L.hz + 0.4;
    for (let z = z0; z <= z1 + 0.01; z += (z1 - z0) / 6) g.box(rx, 0.55, z, 0.1, 1.1, 0.1, iron);
    g.box(rx, 1.05, L.z, 0.08, 0.08, z1 - z0, wood); g.box(rx, 0.62, L.z, 0.05, 0.05, z1 - z0, iron);
    put(new THREE.Mesh(g.geometry(), std({ vertexColors: true, roughness: 0.75 })), true);
  }

  // ── Lawn maples (core of the campus), kept 5 m from every building and 3.6 m from the walks and drives ──
  {
    const spots: THREE.Matrix4[] = [], cols: THREE.Color[] = [];
    // The town's own maples: its greens, and what they turn in the fall (ground.ts LEAF and FALL).
    const hues = [0x5f8f48, 0x6f9c4e, 0x528243, 0x5f8f48, 0xe07a28, 0xd9542a, 0xe6a030, 0xc23e2a];
    const step = 17 / Math.sqrt(scale);
    for (let x = -575; x < -330; x += step) for (let z = -2565; z < -2185; z += step) {
      const px = x + (rnd() - 0.5) * step * 0.8, pz = z + (rnd() - 0.5) * step * 0.8;
      if (!campusFree(px, pz, 5) || !awayFromWalks(px, pz, 3.6) || !offRoad(px, pz, 4)) continue;
      const s = 0.62 + rnd() * 0.4;
      spots.push(new THREE.Matrix4().compose(new THREE.Vector3(px, groundAt(px, pz) - 0.1, pz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28), new THREE.Vector3(s, s * (0.9 + rnd() * 0.3), s)));
      cols.push(new THREE.Color(hues[Math.floor(rnd() * hues.length)]).offsetHSL((rnd() - 0.5) * 0.02, 0, (rnd() - 0.5) * 0.06));
    }
    // With the tree models (not on phones, not with ?flora=0) these are the town's sugar maples and red oaks, drawn by the
    // ground's one tree field (floraAssets.ts EXTRA): the code-built crowns below are only the phones' stand-in.
    const models = game.quality.name !== 'low' && new URLSearchParams(location.search).get('flora') !== '0';
    if (models) {
      spots.forEach((m, i) => {
        EXTRA.kind.push(i % 4 === 3 ? 'redoak' : 'sugarmaple');
        const e = m.elements;
        // (The stand-in is drawn small: the model at the same matrix would be a sapling.)
        for (let k = 0; k < 16; k++) EXTRA.m.push(k < 12 ? e[k] * 1.45 : e[k]);
        EXTRA.c.push(cols[i].r * 1.2, cols[i].g * 1.2, cols[i].b * 1.2);
      });
    } else if (spots.length) {
      const lobe = (dx: number, dy: number, dz: number, r: number): THREE.BufferGeometry => {
        const ico = new THREE.IcosahedronGeometry(r, 1); const pos = ico.getAttribute('position');
        for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), k = 1 + 0.16 * Math.sin(x * 2.1 + z * 1.7 + y * 2.9); pos.setXYZ(i, x * k * 1.1 + dx, y * k * 0.85 + dy, z * k * 1.1 + dz); }
        ico.computeVertexNormals(); return ico;
      };
      const crown = mergeGeometries([lobe(0, 6.4, 0, 3.4), lobe(1.8, 5.4, 0.6, 2.4), lobe(-1.7, 5.6, -0.8, 2.5), lobe(0.3, 8.3, -0.3, 2.1)])!;
      const trunkG = new G(); trunkG.box(0, 1.8, 0, 0.45, 3.6, 0.45, 0x5a4330); trunkG.box(0.35, 4.2, 0, 0.2, 2.0, 0.2, 0x5a4330);
      const cm = new THREE.InstancedMesh(crown, std({ roughness: 0.9, flatShading: true }), spots.length), tm = new THREE.InstancedMesh(trunkG.geometry(), std({ vertexColors: true, roughness: 0.95 }), spots.length);
      spots.forEach((m, i) => { cm.setMatrixAt(i, m); tm.setMatrixAt(i, m); cm.setColorAt(i, cols[i]); });
      cm.instanceMatrix.needsUpdate = true; tm.instanceMatrix.needsUpdate = true; if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
      cm.computeBoundingSphere(); tm.computeBoundingSphere(); put(cm); put(tm);
    }
  }

  // ── Stadium seating: rows of seats up each grandstand's slope ──
  {
    const g = new G(), seat = [0x1f3f73, 0x24467f], step = 0x9b9a95;
    for (const [style, , , , rr] of CAMPUS_BUILDINGS) {
      if (style !== 6 || rr.length < 5) continue;
      const r = { cx: rr[0], cz: rr[1], w: rr[2], d: rr[3], a: rr[4] }, c = Math.cos(r.a), s = Math.sin(r.a);
      let yHi = -1e9;
      for (let i = 0; i < 9; i++) { const lx = ((i % 3) - 1) * r.w / 2, lz = (Math.floor(i / 3) - 1) * r.d / 2; yHi = Math.max(yHi, groundAt(r.cx + lx * c - lz * s, r.cz + lx * s + lz * c)); }
      const h = 3.4, rows = Math.max(3, Math.floor(r.d / 0.62));
      g.frame(r.cx, 0, r.cz, -r.a);
      for (let k = 0; k < rows; k++) {
        const t = (k + 0.5) / rows, lz = -r.d / 2 + t * r.d, y = yHi + 1.2 + h * t;
        g.box(0, y + 0.08, lz, r.w - 0.5, 0.09, 0.34, seat[k & 1]);
        g.box(0, y + 0.3, lz + 0.14, r.w - 0.5, 0.3, 0.06, seat[k & 1]);
        if (k % 2 === 0) g.box(0, y - 0.05, lz - 0.05, r.w - 0.3, 0.07, 0.62, step);
      }
      for (const sx of [-0.5, 0.5]) g.box(sx * (r.w - 0.5), yHi + 1.2 + h * 0.5 + 0.6, 0, 0.1, h + 0.4, r.d, 0x6d747b);
    }
    if (g.p.length) put(new THREE.Mesh(g.geometry(), std({ vertexColors: true, roughness: 0.6 })));
  }

  // ── Goals (soccer, football, rugby) ──
  {
    const g = new G(), net = new G(), white = 0xf4f2ea;
    const post = (x: number, y: number, z: number, h: number, col: number, t = 0.12): void => g.box(x, y + h / 2, z, t, h, t, col);
    for (const [sport, cx, cz, w, d, a] of CAMPUS_FIELDS) {
      if (sport === 2 || sport === 3 || sport === 5) continue;
      const X = fieldXform(cx, cz, a);
      for (const sg of [-1, 1]) {
        const lx = sg * (w / 2 - 0.5 + (sport === 0 ? 0 : 0.5)), [wx, wz] = X(lx, 0), y = groundAt(wx, wz);
        g.frame(wx, y, wz, -a);
        if (sport === 0) {
          const half = 3.65, hh = 2.44, dep = 1.8 * sg;
          for (const z of [-half, half]) { post(0, 0, z, hh, white, 0.13); post(dep, 0, z, hh * 0.8, white, 0.06); g.box(dep / 2, hh * 0.9, z, Math.abs(dep), 0.05, 0.05, white); }
          g.box(0, hh, 0, 0.13, 0.13, half * 2 + 0.13, white);
          net.frame(wx, y, wz, -a);
          net.quad([dep, 0, -half], [dep, 0, half], [dep, hh * 0.8, half], [dep, hh * 0.8, -half], 0xffffff, [0, 0, 7, 2], true);
          net.quad([0, hh, -half], [dep, hh * 0.8, -half], [dep, hh * 0.8, half], [0, hh, half], 0xffffff, [0, 0, 7, 2], true);
          for (const z of [-half, half]) net.quad([0, 0, z], [dep, 0, z], [dep, hh * 0.8, z], [0, hh, z], 0xffffff, [0, 0, 2, 2], true);
        } else {
          const col = sport === 1 ? 0xf0c92c : white, bw = sport === 1 ? 5.6 : 5.6, up = sport === 1 ? 6.4 : 9.5;
          post(0, 0, 0, 3.0, col, 0.2); g.box(0, 3.0, 0, 0.1, 0.1, bw, col);
          for (const z of [-bw / 2, bw / 2]) post(0, 3.0, z, up, col, 0.1);
        }
      }
    }
    if (g.p.length) put(new THREE.Mesh(g.geometry(), std({ vertexColors: true, roughness: 0.5, metalness: 0.2 })), true);
    if (net.p.length) { const t = meshTex('net'); put(new THREE.Mesh(net.geometry(), std({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.9 }))); }
  }

  // ── The tennis courts: six nets, and a 3.2 m chain-link fence round the lot with a gate gap ──
  {
    const fence = new G(), posts = new G(), nets = new G();
    for (const [sport, cx, cz, w, d, a] of CAMPUS_FIELDS) {
      if (sport !== 5) continue;
      const X = fieldXform(cx, cz, a), hw = w / 2 + 0.6, hd = d / 2 + 0.6, FH = 3.2;
      const corners: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 3));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const [x0, z0] = X(ax + (bx - ax) * t0, az + (bz - az) * t0), [x1, z1] = X(ax + (bx - ax) * t1, az + (bz - az) * t1), y0 = groundAt(x0, z0), y1 = groundAt(x1, z1);
          posts.frame(0, 0, 0, 0); posts.box(x0, y0 + FH / 2, z0, 0.12, FH + 0.2, 0.12, 0x2d3a34);
          const gate = i === 0 && k === Math.floor(n / 2);
          if (!gate) {
            const len = Math.hypot(x1 - x0, z1 - z0) / 1.6;
            fence.frame(0, 0, 0, 0);
            fence.quad([x0, y0, z0], [x1, y1, z1], [x1, y1 + FH, z1], [x0, y0 + FH, z0], 0xb8c0c4, [0, 0, len, FH / 1.6], true);
          }
        }
      }
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
        const lx = -w / 2 + (i + 0.5) * (w / 3), lz = -d / 2 + (j + 0.5) * (d / 2), cw = w / 3 - 1.2, [nx, nz] = X(lx, lz), y = groundAt(nx, nz);
        nets.frame(nx, y, nz, -a);
        nets.quad([-(cw / 2 - 0.5), 0.05, 0], [cw / 2 - 0.5, 0.05, 0], [cw / 2 - 0.5, 1.0, 0], [-(cw / 2 - 0.5), 1.0, 0], 0xffffff, [0, 0, cw * 2, 2], true);
        nets.box(-(cw / 2 - 0.5), 0.55, 0, 0.1, 1.1, 0.1, 0x2d3a34); nets.box(cw / 2 - 0.5, 0.55, 0, 0.1, 1.1, 0.1, 0x2d3a34);
        nets.box(0, 1.0, 0, cw - 1, 0.06, 0.04, 0xf2f0e6);
      }
    }
    if (posts.p.length) put(new THREE.Mesh(posts.geometry(), std({ vertexColors: true, roughness: 0.6, metalness: 0.3 })), true);
    const chain = meshTex('chain'), netT = meshTex('net');
    if (fence.p.length) put(new THREE.Mesh(fence.geometry(), std({ map: chain, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.5, metalness: 0.4 })));
    if (nets.p.length) put(new THREE.Mesh(nets.geometry(), std({ map: netT, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.9 })));
  }

  return {
    setNight(n: number): void { if (bulbMat) bulbMat.color.setRGB(0.6 + 0.4 * n, 0.58 + 0.2 * n, 0.52 - 0.02 * n).multiplyScalar(0.55 + 2.2 * n); },
    dispose(): void { for (const m of mats) m.dispose(); },
  };
}
