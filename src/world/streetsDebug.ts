// Debug overlay of the new street graph (streets.ts), shown with ?streets=new until the ground meshes
// (step 2 unit 2) replace it: plain coloured strips at road width a little above the ground, a disc per
// junction coloured by its control, rings for roundabouts, block outlines and lot footprints.
//   strips: highway orange, ramp yellow, arterial white, local steel blue, the bridge cyan; one-way roads darker
//   discs:  signal red, stop / give-way amber, dead end magenta; overpasses violet squares

import * as THREE from 'three';
import { groundAt, roadY } from './plan';
import { lotCorners, type StreetGraph } from './streets';

const KIND: Record<string, number> = { highway: 0xff8c00, ramp: 0xffd400, arterial: 0xf4f4f4, local: 0x8fb3de, bridge: 0x00e5ff };
const CTRL: Record<string, number> = { signal: 0xff2020, stop: 0xffb000, end: 0xff00ff, roundabout: 0x00e5ff };

const yAt = (x: number, z: number, lift: number): number => Math.max(groundAt(x, z), roadY(x, z)) + lift;

export function buildStreetsOverlay(g: StreetGraph): THREE.Group {
  const group = new THREE.Group();
  group.name = 'streets-debug';
  const pos: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  const quad = (ax: number, az: number, bx: number, bz: number, hw: number, lift: number): void => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) return;
    const nx = -(bz - az) / L * hw, nz = (bx - ax) / L * hw;
    const n = Math.max(1, Math.ceil(L / 8));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const p = [
        [x0 + nx, z0 + nz], [x0 - nx, z0 - nz], [x1 + nx, z1 + nz],
        [x1 + nx, z1 + nz], [x0 - nx, z0 - nz], [x1 - nx, z1 - nz],
      ];
      for (const [x, z] of p) { pos.push(x, yAt(x, z, lift), z); col.push(c.r, c.g, c.b); }
    }
  };
  for (let k = g.isle.edges; k < g.edges.length; k++) {
    const e = g.edges[k], p = g.edgePts(e);
    c.setHex(KIND[e.kind ?? 'local'] ?? 0xffffff);
    if (e.oneWay) c.multiplyScalar(0.7);
    // Each segment a strip, with a disc at every bend so corners close.
    for (let i = 0; i + 3 < p.length; i += 2) quad(p[i], p[i + 1], p[i + 2], p[i + 3], e.hw, 0.32 + (e.kind === 'highway' ? 0.04 : 0));
    for (let i = 2; i + 2 < p.length; i += 2) disc(p[i], p[i + 1], e.hw, 0.31);
  }
  function disc(x: number, z: number, r: number, lift: number): void {
    const n = 12;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const pts = [[x, z], [x + Math.cos(a1) * r, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, z + Math.sin(a0) * r]];
      for (const [px, pz] of pts) { pos.push(px, yAt(px, pz, lift), pz); col.push(c.r, c.g, c.b); }
    }
  }
  for (let k = g.isle.nodes; k < g.nodes.length; k++) {
    const n = g.nodes[k], ctl = n.control ?? 'none';
    if (ctl === 'roundabout') {
      c.setHex(CTRL.roundabout);
      const r = n.ring ?? 13, m = 24;
      for (let i = 0; i < m; i++) {
        const a0 = (i / m) * Math.PI * 2, a1 = ((i + 1) / m) * Math.PI * 2;
        quad(n.x + Math.cos(a0) * r, n.z + Math.sin(a0) * r, n.x + Math.cos(a1) * r, n.z + Math.sin(a1) * r, 3.5, 0.4);
      }
      continue;
    }
    if (!CTRL[ctl]) continue;
    c.setHex(CTRL[ctl]);
    disc(n.x, n.z, ctl === 'signal' ? 4.5 : 3, 0.45);
  }
  c.setHex(0xc77dff);
  for (const o of g.overpasses) { quad(o.x - 6, o.z, o.x + 6, o.z, 6, 0.5); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 5;
  group.add(mesh);

  // Block outlines and lot footprints as lines.
  const lp: number[] = [], lc: number[] = [];
  const seg = (ax: number, az: number, bx: number, bz: number, hex: number, lift: number): void => {
    c.setHex(hex);
    lp.push(ax, yAt(ax, az, lift), az, bx, yAt(bx, bz, lift), bz);
    lc.push(c.r, c.g, c.b, c.r, c.g, c.b);
  };
  for (const b of g.blocks) {
    const n = b.poly.length;
    for (let k = 0; k < n; k += 2) seg(b.poly[k], b.poly[k + 1], b.poly[(k + 2) % n], b.poly[(k + 3) % n], b.open ? 0x3060a0 : 0x40ff90, 0.6);
  }
  for (const l of g.lots) {
    const q = lotCorners(l);
    for (let k = 0; k < 8; k += 2) seg(q[k], q[k + 1], q[(k + 2) % 8], q[(k + 3) % 8], 0xffffff, 0.5);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, fog: false }));
  lines.renderOrder = 6;
  group.add(lines);
  return group;
}
