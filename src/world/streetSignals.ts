// Signal heads at the new mainland street graph's signalled junctions (tepid-streets.md step 2 unit 3).
//
// ground.ts draws the island's (and the old grid's) signals; on the new graph they come with the traffic that obeys
// them (sim/streetTraffic.ts), on the same shared clock (signals.ts signalState + game.signalTime). One mast per
// approach on its near right corner by the crosswalk, an arm reaching back over the approach lanes, a head on the
// arm and one on the mast, facing the drivers who must obey it. Masts are hard props in the collision world.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { RoadEdge, RoadNode } from './plan';
import type { StreetGraph } from './streets';
import { groundAt } from './plan';
import { signalState } from './signals';
import { Batch } from './batch';

const LIT = [0xff2a1a, 0xffb000, 0x35ff78], DIM = [0x2a0907, 0x2a1f06, 0x06260f];
const POLE = 0x3b4046, HEAD = 0x1b1d20;
const padR = (n: RoadNode): number => (n.edges.length === 2 && n.control === 'none' ? n.hx : n.hx + (n.control === 'roundabout' ? 0 : 0.6));

interface Approach { node: RoadNode; phaseB: boolean }

export class StreetSignals {
  private readonly approaches: Approach[] = [];
  private readonly last: Int8Array;
  private readonly bulbs: THREE.InstancedMesh | null = null;
  private readonly lit: THREE.Color[] = LIT.map((c) => new THREE.Color(c));
  private readonly dim: THREE.Color[] = DIM.map((c) => new THREE.Color(c));
  readonly root = new THREE.Group();

  constructor(private readonly game: Game, G: StreetGraph, phaseB: (n: RoadNode, e: RoadEdge) => boolean) {
    const b = new Batch(), mats: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (let id = G.isle.nodes; id < G.nodes.length; id++) {
      const n = G.nodes[id];
      if (n.control !== 'signal') continue;
      for (const eid of n.edges) {
        const e = G.edges[eid];
        if (e.deck || (e.oneWay && e.a === n.id)) continue;
        // Travel toward the node along (tx, tz); its right is (-tz, tx).
        const atA = e.a === n.id, p = G.pointAt(e, atA ? Math.min(3, e.len / 2) : Math.max(0, e.len - 3));
        const tx = atA ? -p.dx : p.dx, tz = atA ? -p.dz : p.dz, rx = -tz, rz = tx;
        const back = padR(n) + 1.2, across = e.hw + 0.9;
        const px = n.x - tx * back + rx * across, pz = n.z - tz * back + rz * across;
        if (!G.clearOfRoads(px, pz, 0.15)) continue;
        const inner = e.oneWay ? -e.hw + 1 : e.divided ? (e.kind === 'highway' ? 0.8 : 1.35) + 0.6 : 0.6;
        const arm = Math.min(9, across - inner);
        const y = groundAt(px, pz), hs = Math.atan2(-tx, -tz), cs = Math.cos(hs), sn = Math.sin(hs);
        const W = (lx: number, lz: number): [number, number] => [px + lx * cs + lz * sn, pz - lx * sn + lz * cs];
        b.cyl(px, y, pz, 0.14, 0.11, 6.5, POLE, 8);
        const [amx, amz] = W(-arm / 2, 0);
        b.box(amx, y + 6.0, amz, arm, 0.16, 0.16, POLE, hs);
        const heads: [number, number, number][] = [[-arm + 0.5, 5.1, 0], [0, 2.7, 0.22]];
        for (const [lx, ly, lz] of heads) {
          const [hx, hz] = W(lx, lz);
          b.box(hx, y + ly, hz, 0.38, 1.18, 0.3, HEAD, hs);
          if (lx !== 0) { const [kx, kz] = W(lx, 0); b.box(kx, y + ly + 1.18, kz, 0.06, 6.0 - ly - 1.18 + 0.02, 0.06, POLE, hs); }
          for (let l = 0; l < 3; l++) {
            const [bx, bz] = W(lx, lz + 0.16);
            pos.set(bx, y + ly + 0.97 - l * 0.38, bz);
            q.setFromAxisAngle(up, hs);
            mats.push(m.compose(pos, q, one).clone());
          }
        }
        const sp = game.col.addProp(px, pz, 0.2, y + 6.2, 'signal', false);
        sp.hard = true;
        this.approaches.push({ node: n, phaseB: phaseB(n, e) });
      }
    }
    this.last = new Int8Array(this.approaches.length).fill(-1);
    if (!this.approaches.length) return;
    const mesh = new THREE.Mesh(b.toGeometry(), game.world.mats.flat);
    mesh.castShadow = game.quality.shadows; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
    this.root.add(mesh);
    const bulbs = new THREE.InstancedMesh(new THREE.CircleGeometry(0.15, 12), new THREE.MeshBasicMaterial({ fog: true }), mats.length);
    mats.forEach((mm, i) => bulbs.setMatrixAt(i, mm));
    bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mats.length * 3), 3);
    bulbs.frustumCulled = false; bulbs.matrixAutoUpdate = false;
    this.bulbs = bulbs;
    this.root.add(bulbs);
    this.root.matrixAutoUpdate = false;
    game.scene.add(this.root);
  }

  get count(): number { return this.approaches.length; }

  /** Light the lamps for the shared clock; only the heads that changed are written. */
  update(): void {
    const bulbs = this.bulbs;
    if (!bulbs) return;
    // Out of sight on the island: nothing to light.
    this.root.visible = this.game.player.z < -700 || this.game.camera.position.z < -700;
    const t = this.game.signalTime;
    let dirty = false;
    for (let i = 0; i < this.approaches.length; i++) {
      const a = this.approaches[i], s = signalState(a.node, a.phaseB, t), k = s === 'red' ? 0 : s === 'yellow' ? 1 : 2;
      if (this.last[i] === k) continue;
      this.last[i] = k;
      dirty = true;
      for (let head = 0; head < 2; head++) for (let l = 0; l < 3; l++) bulbs.setColorAt(i * 6 + head * 3 + l, l === k ? this.lit[l] : this.dim[l]);
    }
    if (dirty && bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
  }
}
