// Fun queue 2, item 22: finds. Thirty lost rubber ducks and twenty bridge-bond receipts are hidden across Tepid Falls.
//
// Ducks sit along the river banks, the shore of Johnson Pond, behind houses and on the campus walks; receipts (paper
// slips pinned to a post) wait in alleys, beside bus shelters, on the Budget Line platforms and on the campus. The
// places are a fixed list (findsData.ts, made by tools/collect/gen.mjs from the real streets, each on dry flat ground
// outside every wall and off the road). Walk or drive through one to pick it up: a toast with the count, a little
// cash, a few points toward the bridge, and a prize for each completed set. Progress is one bitmask per set in the
// save's best table (fd.duck, fd.receipt), plus fd.duck.all / fd.receipt.all for the prizes and the count fd.found.
//
// Cost: three small instanced meshes (ducks, receipts, glints) rewritten through game.flip, only for finds within
// 160 m of the player; nothing at all while the player is on the island. A glint star turns and pulses over each find,
// the duck bobs and turns, the receipt flutters on its post. The radar shows the nearest uncollected find within 150 m,
// and the nearest of a set that is nearly done (five or fewer left) wherever it is.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { progress } from '../world/progress';
import { money } from '../core/util';
import { save } from './save';
import { DUCK_SPOTS, RECEIPT_SPOTS } from './findsData';

export type FindSet = 'duck' | 'receipt';
interface SetDef {
  id: FindSet; key: string; label: string; one: string; spots: [number, number][];
  cash: number; points: number; prize: number; prizeTitle: string; prizeText: string; letter: string;
}
const SETS: SetDef[] = [
  { id: 'duck', key: 'fd.duck', label: 'Lost ducks', one: 'Duck', spots: DUCK_SPOTS, cash: 10, points: 3, prize: 800, prizeTitle: 'DUCK WRANGLER', prizeText: 'Every lost duck is home. $800, the title, and a very long quack from the river.', letter: 'D' },
  { id: 'receipt', key: 'fd.receipt', label: 'Bridge-bond receipts', one: 'Receipt', spots: RECEIPT_SPOTS, cash: 25, points: 8, prize: 1200, prizeTitle: 'BOND COLLECTOR', prizeText: 'Every bridge-bond receipt is filed. $1,200 and the title; the bridge fund has never been so well documented.', letter: 'R' },
];
/** Pick up within this many metres on foot, and in a vehicle. */
const REACH_FOOT = 2.3, REACH_CAR = 3.6;
/** Finds are drawn (and checked) inside this range. */
const NEAR = 160;
/** The radar shows the nearest one inside this range, or the nearest of a nearly finished set at any range. */
const RADAR = 150, MOSTLY = 5;

export interface FindRow { id: FindSet; label: string; got: number; total: number; prize: boolean; prizeTitle: string; x: number | null; z: number | null; dist: number | null }

/** Merge small parts into one vertex-coloured geometry. */
const merge = (a: THREE.BufferGeometry[], c: number[]): THREE.BufferGeometry => {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [], k = new THREE.Color();
  let off = 0;
  a.forEach((g, gi) => {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), ix = g.getIndex();
    k.setHex(c[gi]);
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(k.r, k.g, k.b); }
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
};

/** A rubber duck about 0.5 m long: body, tail, head, beak and two eyes. Faces +Z. */
function duckGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.22, 12, 8); body.scale(0.9, 0.78, 1.15); body.translate(0, 0.2, 0);
  const tail = new THREE.ConeGeometry(0.1, 0.2, 8); tail.rotateX(-Math.PI / 2 - 0.5); tail.translate(0, 0.3, -0.27);
  const head = new THREE.SphereGeometry(0.13, 10, 8); head.translate(0, 0.45, 0.15);
  const beak = new THREE.BoxGeometry(0.1, 0.035, 0.1); beak.translate(0, 0.43, 0.3);
  const eyeA = new THREE.SphereGeometry(0.022, 5, 4); eyeA.translate(0.065, 0.49, 0.24);
  const eyeB = new THREE.SphereGeometry(0.022, 5, 4); eyeB.translate(-0.065, 0.49, 0.24);
  return merge([body, tail, head, beak, eyeA, eyeB], [0xf5c518, 0xf5c518, 0xf5c518, 0xe8731c, 0x111111, 0x111111]);
}
/** A receipt: a slip of paper pinned to a short post, with a red pin and printed bands. Faces +Z. */
function receiptGeometry(): THREE.BufferGeometry {
  const post = new THREE.BoxGeometry(0.06, 0.8, 0.06); post.translate(0, 0.4, 0);
  const slip = new THREE.BoxGeometry(0.3, 0.42, 0.015); slip.translate(0, 0.98, 0.04);
  const band = new THREE.BoxGeometry(0.22, 0.05, 0.02); band.translate(0, 1.08, 0.045);
  const band2 = new THREE.BoxGeometry(0.16, 0.03, 0.02); band2.translate(-0.03, 0.97, 0.045);
  const pin = new THREE.SphereGeometry(0.035, 6, 5); pin.translate(0, 1.15, 0.06);
  return merge([post, slip, band, band2, pin], [0x6b5338, 0xf4f0e2, 0x2b4a7a, 0x8a8f99, 0xc8231e]);
}

/** A soft four-point star for the glints. */
function starTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,240,170,0.55)'); g.addColorStop(1, 'rgba(255,220,120,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.beginPath(); x.moveTo(32, 2); x.lineTo(36, 28); x.lineTo(62, 32); x.lineTo(36, 36); x.lineTo(32, 62); x.lineTo(28, 36); x.lineTo(2, 32); x.lineTo(28, 28); x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Finds {
  /** True only in the new Tepid Falls (?streets=old has none of this ground). */
  readonly on = STREETS_NEW;
  readonly stats = { picked: 0 };
  private built = false;
  private t = 0;
  private group: THREE.Group | null = null;
  private duckMesh!: THREE.InstancedMesh;
  private recMesh!: THREE.InstancedMesh;
  private glintMesh!: THREE.InstancedMesh;
  /** Ground height under each find, per set (read once, when the world is up). */
  private readonly y: Record<FindSet, Float32Array> = { duck: new Float32Array(DUCK_SPOTS.length), receipt: new Float32Array(RECEIPT_SPOTS.length) };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(private readonly game: Game) {}

  def(id: FindSet): SetDef { return SETS.find((s) => s.id === id) as SetDef; }
  total(id: FindSet): number { return this.def(id).spots.length; }
  mask(id: FindSet): number { return (save.data.best[this.def(id).key] ?? 0) | 0; }
  has(id: FindSet, i: number): boolean { return (this.mask(id) & (1 << i)) !== 0; }
  got(id: FindSet): number { let n = 0, m = this.mask(id); while (m) { n += m & 1; m = m >>> 1; } return n; }
  /** Where find i of a set is: x, z and the ground under it. */
  at(id: FindSet, i: number): { x: number; y: number; z: number } {
    const [x, z] = this.def(id).spots[i];
    return { x, y: this.built ? this.y[id][i] : groundAt(x, z), z };
  }

  private build(): void {
    const g = this.game, grp = new THREE.Group();
    grp.name = 'finds';
    const mat = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
    const dm = mat(); dm.emissive.setHex(0x3a2c00); dm.roughness = 0.35;
    this.duckMesh = new THREE.InstancedMesh(duckGeometry(), dm, DUCK_SPOTS.length);
    this.recMesh = new THREE.InstancedMesh(receiptGeometry(), mat(), RECEIPT_SPOTS.length);
    const star = new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, map: starTexture() });
    this.glintMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), star, DUCK_SPOTS.length + RECEIPT_SPOTS.length);
    for (const m of [this.duckMesh, this.recMesh, this.glintMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.count = 0;
      g.flip.mesh(m);
      grp.add(m);
    }
    g.scene.add(grp);
    this.group = grp;
    for (const d of SETS) d.spots.forEach(([x, z], i) => { this.y[d.id][i] = groundAt(x, z); });
    this.built = true;
  }

  update(dt: number): void {
    if (!this.on) return;
    const g = this.game, p = g.player;
    // Far from every find (the island, the bridge): nothing to do, nothing drawn.
    if (p.z > -700) { if (this.group?.visible) this.group.visible = false; return; }
    if (!this.built) this.build();
    if (this.group && !this.group.visible) this.group.visible = true;
    this.t += Math.min(dt, 0.1);
    const reach = p.vehicle ? REACH_CAR : REACH_FOOT, cam = g.camera.position;
    let nd = 0, nr = 0, ng = 0;
    for (const d of SETS) {
      const mask = this.mask(d.id), ys = this.y[d.id];
      for (let i = 0; i < d.spots.length; i++) {
        if (mask & (1 << i)) continue;
        const [x, z] = d.spots[i], dd = Math.hypot(x - p.x, z - p.z);
        if (dd > NEAR) continue;
        const y = ys[i];
        if (dd < reach && Math.abs(p.y - y) < 3.2) { this.pick(d, i); continue; }
        const ph = this.t * 2 + i * 1.7;
        if (d.id === 'duck') {
          this.e.set(Math.sin(ph * 0.7) * 0.08, ph * 0.35 + i, Math.cos(ph) * 0.06); this.q.setFromEuler(this.e);
          this.v.set(x, y + 0.02 + Math.sin(ph) * 0.05, z); this.s.setScalar(1.15);
          this.m.compose(this.v, this.q, this.s); this.duckMesh.setMatrixAt(nd++, this.m);
        } else {
          this.e.set(0, i * 2.1 + Math.sin(ph * 0.6) * 0.5, Math.sin(ph) * 0.05); this.q.setFromEuler(this.e);
          this.v.set(x, y, z); this.s.setScalar(1);
          this.m.compose(this.v, this.q, this.s); this.recMesh.setMatrixAt(nr++, this.m);
        }
        // The glint: a four-point star turned to the camera, pulsing, above the find.
        const gy = y + (d.id === 'duck' ? 0.95 : 1.55) + Math.sin(ph * 1.3) * 0.08, sc = (0.45 + 0.15 * Math.sin(ph * 2.2)) * (1 + dd / 60);
        this.e.set(0, Math.atan2(cam.x - x, cam.z - z), 0, 'YXZ'); this.q.setFromEuler(this.e);
        this.v.set(x, gy, z); this.s.setScalar(sc);
        this.m.compose(this.v, this.q, this.s); this.glintMesh.setMatrixAt(ng++, this.m);
      }
    }
    this.duckMesh.count = nd; this.recMesh.count = nr; this.glintMesh.count = ng;
    if (nd) this.duckMesh.instanceMatrix.needsUpdate = true;
    if (nr) this.recMesh.instanceMatrix.needsUpdate = true;
    if (ng) this.glintMesh.instanceMatrix.needsUpdate = true;
  }

  private pick(d: SetDef, i: number): void {
    const g = this.game, b = save.data.best, p = g.player;
    b[d.key] = this.mask(d.id) | (1 << i);
    const n = this.got(d.id), total = d.spots.length;
    this.stats.picked++;
    save.bump('fd.found');
    p.money += d.cash; save.credit(d.cash); save.data.stats.earned += d.cash;
    progress.add(d.points);
    if (n >= total && !b[d.key + '.all']) {
      b[d.key + '.all'] = 1;
      p.money += d.prize; save.credit(d.prize); save.data.stats.earned += d.prize;
      progress.add(d.points * 20);
      g.hud.stamp(d.prizeTitle, d.prizeText);
    } else {
      const left = total - n;
      g.hud.toast(`${d.one} ${n} of ${total} · ${money(d.cash)}${left > 0 && left <= MOSTLY ? ` · ${left} to go: the radar knows where` : ''}`, 4);
    }
    g.todo.saveNow();
  }

  /** The Places panel's rows, one per set, with the nearest uncollected find of each. */
  rows(): FindRow[] {
    const p = this.game.player;
    return SETS.map((d) => {
      const best = this.nearest(d, p.x, p.z);
      return { id: d.id, label: d.label, got: this.got(d.id), total: d.spots.length, prize: !!save.data.best[d.key + '.all'], prizeTitle: d.prizeTitle, x: best ? best.x : null, z: best ? best.z : null, dist: best ? best.d : null };
    });
  }

  private nearest(d: SetDef, px: number, pz: number): { i: number; x: number; z: number; d: number } | null {
    const mask = this.mask(d.id);
    let bi = -1, bd = 1e18;
    for (let i = 0; i < d.spots.length; i++) {
      if (mask & (1 << i)) continue;
      const dd = Math.hypot(d.spots[i][0] - px, d.spots[i][1] - pz);
      if (dd < bd) { bd = dd; bi = i; }
    }
    return bi < 0 ? null : { i: bi, x: d.spots[bi][0], z: d.spots[bi][1], d: bd };
  }

  /** Radar badges: the nearest find in a short range; a nearly finished set shows its nearest wherever it is. */
  blips(out: Blip[]): void {
    if (!this.on) return;
    const p = this.game.player;
    for (const d of SETS) {
      const n = this.nearest(d, p.x, p.z);
      if (!n) continue;
      const left = d.spots.length - this.got(d.id);
      if (n.d < RADAR || left <= MOSTLY) out.push({ x: n.x, z: n.z, kind: 'job', label: d.letter });
    }
  }

  info(): Record<string, unknown> {
    return { on: this.on, ducks: this.got('duck'), receipts: this.got('receipt'), picked: this.stats.picked, drawn: this.built ? [this.duckMesh.count, this.recMesh.count, this.glintMesh.count] : null };
  }
}
