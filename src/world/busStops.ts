// Fun queue 2, item 7: the Harbor Line's stops. Each stop is a glass shelter with a bench and a roof, and a flag sign on a
// pole nearer the lane (two painted faces: the stop's name and the routes that call). They stand on the kerb side of the
// bus's lane, where the bus's door comes to rest, and are merged where two lines share a stop (Quorum Square).
//
// Cost: one batched mesh for every shelter and pole, and one small canvas texture and two planes per stop.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Route } from '../sim/busRoutes';
import { groundAt } from './plan';
import { Batch } from './batch';
import { LINES } from '../sim/busRoutes';

export interface Station {
  name: string;
  x: number; y: number; z: number; h: number; rx: number; rz: number;
  /** From the stop's lane point to the kerb (the street's half width less the lane's offset). */
  hw: number;
  /** The (route index, stop index) pairs that call here. */
  items: { r: number; j: number }[];
}

const INK = '#14213d', BONE = '#f2e8cf';

/** Group every route's stops into stations and draw them. */
export function buildStations(game: Game, routes: readonly Route[]): Station[] {
  const out: Station[] = [];
  routes.forEach((r, ri) => {
    if (!r.ok) return;
    r.stops.forEach((s, j) => {
      const near = out.find((o) => Math.hypot(o.x - s.x, o.z - s.z) < 22);
      if (near) { near.items.push({ r: ri, j }); return; }
      out.push({ name: s.name, x: s.x, y: groundAt(s.x, s.z), z: s.z, h: s.h, rx: s.rx, rz: s.rz, hw: s.hw - s.lane, items: [{ r: ri, j }] });
    });
  });
  const b = new Batch(), glass = new Batch(), root = new THREE.Group();
  for (const st of out) {
    const hd = st.h, tx = Math.sin(hd), tz = Math.cos(hd);
    // Point u along the travel, w toward the kerb.
    const P = (u: number, w: number): [number, number] => [st.x + tx * u + st.rx * w, st.z + tz * u + st.rz * w];
    const box = (u: number, w: number, y0: number, su: number, sy: number, sw: number, hex: number): void => { const [x, z] = P(u, w); b.box(x, groundAt(x, z) + y0, z, sw, sy, su, hex, hd); };
    const w0 = st.hw + 2.7;
    // The shelter: back panel, roof, two road-side posts, a bench with a back.
    { const [x, z] = P(0, w0 + 0.62); glass.box(x, groundAt(x, z), z, 0.05, 2.3, 3.6, 0xb7d3e0, hd); }
    box(0, w0, 2.3, 3.9, 0.12, 1.7, 0x23394d);
    box(0, w0 + 0.62, 2.1, 3.9, 0.22, 0.1, 0x23394d);
    for (const u of [-1.8, 1.8]) box(u, w0 - 0.7, 0, 0.09, 2.3, 0.09, 0x2b3138);
    for (const u of [-1.8, 1.8]) box(u, w0 + 0.6, 0, 0.09, 2.3, 0.09, 0x2b3138);
    box(0, w0 + 0.3, 0.46, 2.6, 0.07, 0.46, 0x7a5a3c);
    box(0, w0 + 0.52, 0.62, 2.6, 0.5, 0.05, 0x7a5a3c);
    for (const u of [-1.1, 1.1]) box(u, w0 + 0.3, 0, 0.08, 0.46, 0.34, 0x2b3138);
    // A shelter bin and the pole.
    box(2.5, w0 + 0.3, 0, 0.45, 0.8, 0.45, 0x3d5a45);
    const [qx, qz] = P(-3.3, st.hw + 0.9);
    b.cyl(qx, groundAt(qx, qz), qz, 0.06, 0.06, 3.5, 0x2b3138, 8);
    game.col.addProp(qx, qz, 0.1, groundAt(qx, qz) + 3.4, 'post', false).hard = true;
    // The flag: two faces back to back, square to the lane (readable from the road and from the pavement).
    const tex = sign(st);
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0xe6e6e6 });
    const gy = groundAt(qx, qz);
    for (const f of [0, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), mat);
      // A plane faces +z; turned to face along the travel direction or against it (square to the street).
      const dir = f ? 1 : -1;
      m.rotation.y = f ? hd : hd + Math.PI;
      m.position.set(qx + tx * dir * 0.04, gy + 2.95, qz + tz * dir * 0.04);
      m.matrixAutoUpdate = false; m.updateMatrix();
      root.add(m);
    }
  }
  const mesh = new THREE.Mesh(b.toGeometry(), game.world.mats.flat);
  mesh.castShadow = game.quality.shadows; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
  root.add(mesh);
  // The glass: see-through, so nobody standing in the shelter has the camera walled in by it.
  const gm = new THREE.Mesh(glass.toGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.3, roughness: 0.15, metalness: 0, depthWrite: false, side: THREE.DoubleSide }));
  gm.matrixAutoUpdate = false; gm.renderOrder = 2;
  root.add(gm);
  root.matrixAutoUpdate = false;
  game.scene.add(root);
  return out;
}

function sign(st: Station): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.fillStyle = BONE; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = INK; x.lineWidth = 10; x.strokeRect(5, 5, 246, 246);
  x.fillStyle = INK; x.fillRect(5, 5, 246, 62);
  x.fillStyle = BONE; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '800 40px "Big Shoulders Display", "Arial Narrow", sans-serif';
  x.fillText('BUS STOP', 128, 38);
  x.fillStyle = INK; x.font = '700 21px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
  const words = st.name.split(', '), lines = words.length > 1 ? words : [st.name];
  lines.slice(0, 2).forEach((l, i) => x.fillText(l, 128, 90 + i * 24, 226));
  return finishSign(c, st);
}

function finishSign(c: HTMLCanvasElement, st: Station): THREE.CanvasTexture {
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const n = st.items.length;
  st.items.forEach((it, i) => {
    const d = LINES[it.r], y = 144 + i * 50, bx = 20;
    x.fillStyle = d.color; x.beginPath(); x.roundRect(bx, y, 216, 42, 8); x.fill();
    x.strokeStyle = INK; x.lineWidth = 3; x.stroke();
    x.fillStyle = '#fff'; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.font = '800 30px "Big Shoulders Display", "Arial Narrow", sans-serif';
    x.fillText(String(d.n), bx + 12, y + 22);
    x.font = '700 18px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    x.fillText(d.short, bx + 44, y + 22, 164);
  });
  void n;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
