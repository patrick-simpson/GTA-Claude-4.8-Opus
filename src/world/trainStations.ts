// Fun queue 2, item 8: the Budget Line's stations. A low concrete platform beside the coaches' door line with a yellow
// edge stripe, a small glass shelter with a bench, and a name board on two posts (double faced, square to the track), at
// the south terminus and the North Halt. The depot has its own platform (world/mainlandPlaces.ts); it gets the name boards.
//
// Cost: one batched mesh for the lot, one for the glass, and one small canvas texture and four planes per station.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { groundAt } from './plan';
import { Batch } from './batch';
import { STATIONS, type RailStation } from './railway';

/** Platform edge to the track's centre line, and the platform's width, meters: the coaches' sides stand 1.55 m out. */
export const PLATFORM_IN = 2.3, PLATFORM_W = 3.7;
/** Half the platform's length: the two coaches. */
export const PLATFORM_HALF = 23;

const CONC = 0x9d9a90, STRIPE = 0xd9b43a, GREEN = 0x2a4a33, IRON = 0x2b3138, WOOD = 0x7a5a3c;

/** The point `u` along the line from the station's middle and `w` out to the platform's side (+) or the other way (-). */
export function stationPoint(st: RailStation, u: number, w: number, out: { x: number; z: number }): { x: number; z: number } {
  const s = Math.sin(st.h), c = Math.cos(st.h);
  out.x = st.x + s * u + c * w * st.side;
  out.z = st.z + c * u - s * w * st.side;
  return out;
}

function board(st: RailStation): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 768; c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#1f3a2a'; x.fillRect(0, 0, 768, 256);
  x.strokeStyle = '#e6dcc0'; x.lineWidth = 8; x.strokeRect(12, 12, 744, 232);
  x.fillStyle = '#e6dcc0'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '600 34px "Barlow Semi Condensed", sans-serif';
  x.fillText('THE BUDGET LINE', 384, 52);
  x.font = '800 100px "Big Shoulders Display", "Barlow Semi Condensed", sans-serif';
  x.fillText(st.sign, 384, 136);
  x.font = '500 28px "IBM Plex Mono", monospace';
  x.fillText(st.sub.length > 44 ? st.sub.slice(0, 43) + '…' : st.sub, 384, 208);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Draw every station's platform, shelter and boards. Returns the root (already in the scene). */
export function buildStationMeshes(game: Game): THREE.Group {
  const b = new Batch(), glass = new Batch(), root = new THREE.Group();
  const q = { x: 0, z: 0 };
  for (const st of STATIONS) {
    const hd = st.h;
    const P = (u: number, w: number): [number, number] => { stationPoint(st, u, w, q); return [q.x, q.z]; };
    // The depot's platform is the building's own (0.42 high); the boards stand on it.
    const lift = st.own ? 0 : 0.42;
    const wMid = PLATFORM_IN + PLATFORM_W / 2;
    const gy = (u: number, w: number): number => { const [x, z] = P(u, w); return groundAt(x, z); };
    if (st.own) {
      for (let u = -PLATFORM_HALF; u < PLATFORM_HALF - 0.5; u += 4) {
        const um = u + 2;
        let lo = 1e9, hi = -1e9;
        for (const du of [0, 4]) for (const w of [PLATFORM_IN, PLATFORM_IN + PLATFORM_W]) { const g = gy(u + du, w); lo = Math.min(lo, g); hi = Math.max(hi, g); }
        const top = hi + 0.16, [x, z] = P(um, wMid);
        b.box(x, lo - 0.4, z, PLATFORM_W, top - lo + 0.4, 4.02, CONC, hd);
        const [ex, ez] = P(um, PLATFORM_IN + 0.3);
        b.box(ex, top, ez, 0.24, 0.012, 4.02, STRIPE, hd);
      }
      // The shelter: a roof on four posts, glass behind, a bench, a bin.
      const top = Math.max(gy(0, wMid), gy(-3.4, wMid), gy(3.4, wMid)) + 0.16;
      const [rx, rz] = P(0, wMid + 0.4);
      b.box(rx, top + 2.55, rz, 2.7, 0.14, 8.0, GREEN, hd);
      b.box(rx, top + 2.45, rz, 2.4, 0.1, 7.6, 0x1c2e22, hd);
      for (const u of [-3.6, 3.6]) for (const w of [wMid - 0.7, wMid + 1.55]) {
        const [px, pz] = P(u, w);
        b.box(px, top, pz, 0.1, 2.55, 0.1, IRON, hd);
        game.col.addProp(px, pz, 0.12, top + 2.5, 'post', false).hard = true;
      }
      const [gx, gz] = P(0, wMid + 1.62);
      glass.box(gx, top, gz, 0.04, 2.3, 7.4, 0xb7d3e0, hd);
      for (const u of [-3.65, 3.65]) { const [sx, sz] = P(u, wMid + 0.5); glass.box(sx, top + 0.3, sz, 2.0, 2.0, 0.04, 0xb7d3e0, hd); }
      const [bx, bz] = P(0.4, wMid + 1.25);
      b.box(bx, top + 0.46, bz, 0.5, 0.07, 3.2, WOOD, hd);
      { const [kx, kz] = P(0.4, wMid + 1.5); b.box(kx, top + 0.62, kz, 0.06, 0.5, 3.2, WOOD, hd); }
      for (const u of [-1.1, 1.9]) { const [lx, lz] = P(u, wMid + 1.25); b.box(lx, top, lz, 0.34, 0.46, 0.08, IRON, hd); }
      { const [nx, nz] = P(-2.9, wMid + 1.3); b.cyl(nx, top, nz, 0.22, 0.2, 0.75, 0x3d5a45, 10); }
    }
    // Name boards on two posts at the platform's back, one near each end, a face to the track and one to the back.
    const tex = board(st);
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0xdddddd });
    for (const u of [-17, 17]) {
      const w = PLATFORM_IN + PLATFORM_W - 0.45, [px, pz] = P(u, w);
      const base = groundAt(px, pz) + (st.own ? 0.16 : lift);
      b.box(px, base, pz, 0.12, 2.9, 0.12, IRON, hd);
      game.col.addProp(px, pz, 0.14, base + 2.8, 'post', false).hard = true;
      // Toward the track: along the platform's inward normal.
      const [tx, tz] = P(u, w - 1), nx = tx - px, nz = tz - pz;
      for (const f of [0, 1]) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.9), mat);
        const dir = f ? 1 : -1;
        m.rotation.y = Math.atan2(nx * dir, nz * dir);
        m.position.set(px + nx * dir * 0.08, base + 2.35, pz + nz * dir * 0.08);
        m.matrixAutoUpdate = false; m.updateMatrix();
        root.add(m);
      }
    }
  }
  const mesh = new THREE.Mesh(b.toGeometry(), game.world.mats.flat);
  mesh.castShadow = game.quality.shadows; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
  root.add(mesh);
  const gm = new THREE.Mesh(glass.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.3, roughness: 0.15, metalness: 0, depthWrite: false, side: THREE.DoubleSide }));
  gm.matrixAutoUpdate = false; gm.renderOrder = 2;
  root.add(gm);
  root.matrixAutoUpdate = false;
  game.scene.add(root);
  return root;
}
