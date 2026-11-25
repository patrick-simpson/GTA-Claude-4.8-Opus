// Fun queue 2, item 28: the town project. After the bridge and the four stages of Tepid Falls, everybody in town works on one
// more thing together: the Millpond Promenade, a fenced-off, derelict yard on the bank of the mill pond that opens up in three
// stages (world/progress.ts: stages 5, 6 and 7 of the same pool of points, the same fact, the same Give frames).
//
//   what counts   every point the bridge fund would take: jobs paid, finds, deliveries, events, missions, the trickle of driving,
//                 and cash handed in at the project board (G; one dollar is one point), from anybody in town. Nothing here
//                 decides a point: this file only SHOWS the project and takes the board's cash.
//   what unlocks  0  the yard: a chain-link fence all round, rubble, pallets, drums, a skip and a site hut (the fence is solid)
//                 1  The Gates Open: fence and rubble go; gate piers and a sign, a paved promenade along the bank with railings,
//                    a plaza, benches, planters and bins
//                 2  The Lamps Are Lit: lamp posts along every path and string lights over the plaza; glow at night
//                 3  The Pavilion: a bandstand with a raised floor, columns, a roof and bunting
//                 the first time you walk in after a stage opens, a ribbon-cutting purse ($150, $250, $400: once each per save)
//   the board     by the gate on the Water St side: a painted board of the stages and the bar for the one in hand, redrawn as
//                 the town's points come in, with the coin box under it. The Places panel's Project chip and the progress
//                 page of the menu show the same. It opens when Tepid Falls is fully open (the goals come after its stages).
//   the net       nothing of its own: the town's stage is the town's FACT_BRIDGE [spans, stage, bank, by] with the stage going
//                 on past 4 (net/town.ts is unchanged but for the name of the stage in "<name>'s points finished ...").
//                 No new fact key, no new frame, protocol and service untouched.
//
// Cost: built once, the first time the player is within 700 m; four groups of a few thousand triangles, hidden by distance; the
// board is one canvas redrawn only when its numbers change.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { Batch } from '../world/batch';
import { ALL_STAGES, PROJECT_NAME, PROJECT_STAGES, STAGES, Toggle, goalOf, progress, stageName } from '../world/progress';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { RNG, money } from '../core/util';
import { save } from './save';

/** The yard (metres): the promenade's ground, between Water St and the pond's bank. */
export const SITE = { x0: 200, x1: 296, z0: -1958, z1: -1906 };
const PLAZA = { x: 246, z: -1932, r: 15 };
const GATE_Z = -1932;
/** The board and its coin box, by the gate on the street side. */
export const BOARD = { x: 192, z: -1927 };
/** The ribbon-cutting purses, one per stage. */
const RIBBON = [150, 250, 400];
const RIBBON_KEY = 'pj.ribbon';
/** Closer than this to the coin box (on foot) and the prompt shows. */
const REACH = 3.4;

const INK = 0x14213d, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, STEEL = 0x8c9096, SLAB = 0xb4afa3, BRICK = 0x8a3b2e, GREEN = 0x2f5d4a;

export interface ProjectRow { n: number; name: string; done: boolean; current: boolean; cost: number; have: number }

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,226,150,1)'); g.addColorStop(0.4, 'rgba(255,200,110,0.5)'); g.addColorStop(1, 'rgba(255,190,90,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function chainTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.clearRect(0, 0, 64, 64);
  x.strokeStyle = '#9aa0a6'; x.lineWidth = 3;
  x.beginPath();
  for (let k = -64; k <= 64; k += 32) { x.moveTo(k, 0); x.lineTo(k + 64, 64); x.moveTo(k + 64, 0); x.lineTo(k, 64); }
  x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A painted sign: big words on paper. 4:1. */
function signTexture(lines: string[], ink = '#14213d', paper = '#f2e8cf'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.fillStyle = paper; x.fillRect(0, 0, 1024, 256);
  x.strokeStyle = ink; x.lineWidth = 10; x.strokeRect(8, 8, 1008, 240);
  x.fillStyle = ink; x.textAlign = 'center'; x.textBaseline = 'middle';
  lines.forEach((t, i) => {
    let px = i === 0 ? 118 : 56;
    x.font = `900 ${px}px "Big Shoulders Display", "Arial Narrow", sans-serif`;
    while (x.measureText(t).width > 940 && px > 20) { px -= 2; x.font = `900 ${px}px "Big Shoulders Display", "Arial Narrow", sans-serif`; }
    x.fillText(t, 512, lines.length === 1 ? 128 : i === 0 ? 96 : 200);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class TownProject {
  /** True only in the new Tepid Falls (?streets=old has no ground for it). */
  readonly on = STREETS_NEW && PROJECT_STAGES > 0;
  readonly stats = { ribbons: 0, gifts: 0, redraws: 0 };
  /** The prompt line at the coin box (the ThingsToDo's one line says it). */
  prompt: string | null = null;
  private built = false;
  private root: THREE.Group | null = null;
  private readonly tiers: THREE.Group[] = [];
  private fence: THREE.Group | null = null;
  private readonly fenceWalls = new Toggle();
  private readonly pavWalls = new Toggle();
  private readonly pathWalls = new Toggle();
  private boardCv!: HTMLCanvasElement;
  private boardTex!: THREE.CanvasTexture;
  private boardKey = '';
  private lampMat!: THREE.MeshBasicMaterial;
  private glowMat!: THREE.MeshBasicMaterial;
  /** The stage on show (0..PROJECT_STAGES), -1 before anything is built. */
  private shown = -1;
  private lastPay = -9;
  private y0 = 5;

  constructor(private readonly game: Game) {}

  /** Stages of the project open on this screen (the town's, in a town). */
  get stage(): number { return this.on ? Math.min(PROJECT_STAGES, progress.project) : 0; }
  /** Can the fund take money yet: Tepid Falls fully open. */
  get open(): boolean { return this.on && progress.complete && progress.stage >= STAGES; }

  rows(): ProjectRow[] {
    const g = progress.goal();
    return Array.from({ length: PROJECT_STAGES }, (_, i) => {
      const n = STAGES + i + 1, cur = g !== null && g.n === n && g.kind === 'project';
      return { n, name: stageName(n), done: progress.stage >= n, current: cur, cost: cur && g ? g.cost : 0, have: cur && g ? Math.floor(g.have) : 0 };
    });
  }

  /** The line the Places panel and the board put under the stages. */
  status(): string {
    if (!this.on) return '';
    const g = progress.goal();
    if (!progress.complete || progress.stage < STAGES) return 'Opens when every part of Tepid Falls is open. Points earned by then count toward it from the first one.';
    if (!g || g.kind !== 'project') return 'The Promenade is finished. Thank you, everybody.';
    return `${stageName(g.n)}: ${Math.floor(g.have)} of ${g.cost} points, ${money(Math.ceil(g.cost - g.have))} to go. Everybody in town counts.`;
  }

  // ── building ───────────────────────────────────────────────────────────────

  private build(): void {
    const g = this.game, root = new THREE.Group();
    root.name = 'town-project';
    this.root = root;
    const y = (this.y0 = groundAt(PLAZA.x, PLAZA.z));
    const mats = g.world.mats;
    const rng = new RNG(2828);
    const solid = (b: Batch, shadow = false): THREE.Mesh => {
      const m = new THREE.Mesh(b.toGeometry(), mats.flatDouble);
      m.castShadow = shadow && g.quality.shadows; m.receiveShadow = true; m.matrixAutoUpdate = false;
      return m;
    };
    const tier = (name: string): THREE.Group => { const t = new THREE.Group(); t.name = name; root.add(t); this.tiers.push(t); return t; };

    // ---- 0: the derelict yard ------------------------------------------------
    const t0 = tier('yard');
    {
      const b = new Batch(), ch = new Batch();
      const { x0, x1, z0, z1 } = SITE;
      // A bare, dark patch of ground with weeds, and rubble of every kind.
      b.floor(x0 + 2, z0 + 2, x1 - 2, z1 - 2, y + 0.012, 0x5b5346, 6, 4);
      for (let i = 0; i < 70; i++) {
        const x = x0 + 4 + rng.next() * (x1 - x0 - 8), z = z0 + 4 + rng.next() * (z1 - z0 - 8);
        if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < 3 && i % 2) continue;
        const h = 0.4 + rng.next() * 0.7;
        b.box(x, y, z, 0.06, h, 0.06, rng.next() < 0.5 ? 0x6e6a3a : 0x7d6f45, rng.next() * 3);
        b.box(x + 0.1, y, z + 0.05, 0.05, h * 0.8, 0.05, 0x6e6a3a, rng.next() * 3);
      }
      for (let i = 0; i < 22; i++) {
        const x = x0 + 5 + rng.next() * (x1 - x0 - 10), z = z0 + 5 + rng.next() * (z1 - z0 - 10), s = 0.5 + rng.next() * 0.9;
        b.box(x, y, z, s * 1.4, s * 0.7, s, rng.next() < 0.6 ? 0x9a9791 : 0x7d7a74, rng.next() * 3);
      }
      // Pallet stacks, drums, cones.
      for (const [px, pz, n] of [[222, -1950, 4], [224.2, -1949.6, 3], [270, -1912, 5], [272.4, -1912.3, 2], [216, -1914, 4]] as [number, number, number][]) {
        for (let k = 0; k < n; k++) {
          b.box(px, y + k * 0.16, pz, 1.2, 0.07, 1.0, 0x8a6b45, k * 0.2);
          for (const o of [-0.45, 0, 0.45]) b.box(px + o, y + k * 0.16 + 0.07, pz, 0.1, 0.09, 1.0, 0x7a5c3a, k * 0.2);
        }
        this.fenceWalls.add(g.col.addBoxC(px, pz, 1.3, 1.1, y + n * 0.16 + 0.1, y - 0.2));
      }
      for (let i = 0; i < 7; i++) {
        const x = 240 + (i % 4) * 0.8 + (i > 3 ? 0.4 : 0), z = -1918 + Math.floor(i / 4) * 0.9;
        b.box(x, y, z, 0.55, 0.9, 0.55, i % 3 === 0 ? 0x2d5aa0 : i % 3 === 1 ? 0x8b4a2b : 0x3c6e47, 0, 5);
        b.box(x, y + 0.9, z, 0.6, 0.05, 0.6, STEEL);
      }
      this.fenceWalls.add(g.col.addBoxC(241.5, -1917.6, 3.6, 1.8, y + 1, y - 0.2));
      for (const [cx, cz] of [[262, -1934], [263.4, -1933.4], [212, -1944], [213.2, -1943]] as [number, number][]) {
        b.box(cx, y, cz, 0.4, 0.05, 0.4, 0xe0701a);
        b.box(cx, y + 0.05, cz, 0.22, 0.6, 0.22, 0xe0701a);
        b.box(cx, y + 0.3, cz, 0.24, 0.1, 0.24, BONE);
      }
      // A skip and a site hut.
      b.box(284, y, -1944, 4.4, 1.3, 1.9, 0x2c6b4d, 0.1);
      b.box(284, y + 1.3, -1944, 4.6, 0.08, 2.1, 0x1e4a35, 0.1);
      this.fenceWalls.add(g.col.addBoxC(284, -1944, 4.6, 2.4, y + 1.4, y - 0.2));
      b.box(212, y, -1954.5, 4.2, 2.5, 2.6, 0xd9d6c8);
      b.box(212, y + 2.5, -1954.5, 4.4, 0.12, 2.8, 0x7d7a74);
      b.box(212, y + 0.05, -1953.1, 0.9, 2.0, 0.08, 0x2d5aa0);
      b.box(209.8, y + 1.2, -1953.15, 1.0, 0.7, 0.06, 0x3b4a5a);
      this.fenceWalls.add(g.col.addBoxC(212, -1954.5, 4.4, 2.8, y + 2.6, y - 0.2));
      // A dirt heap.
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2, a2 = ((i + 1) / 10) * Math.PI * 2, cx = 262, cz = -1950;
        b.tri(cx, y + 2.1, cz, cx + Math.cos(a) * 4.2, y, cz + Math.sin(a) * 3.2, cx + Math.cos(a2) * 4.2, y, cz + Math.sin(a2) * 3.2, 0x6b5a43);
      }
      // The fence: posts and rails here, the chain link below in its own mesh. A gate across the west side, chained.
      const sides: [number, number, number, number][] = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
      for (const [ax, az, bx, bz] of sides) {
        const L = Math.hypot(bx - ax, bz - az), n = Math.round(L / 4), dx = (bx - ax) / L, dz = (bz - az) / L;
        for (let k = 0; k <= n; k++) {
          const px = ax + dx * (L * k / n), pz = az + dz * (L * k / n);
          b.box(px, y, pz, 0.1, 2.1, 0.1, STEEL);
        }
        for (const h of [1.95, 0.05]) b.box((ax + bx) / 2, y + h, (az + bz) / 2, Math.abs(dx) * L + 0.05, 0.06, Math.abs(dz) * L + 0.05, STEEL);
        const seg = (sx0: number, sz0: number, sx1: number, sz1: number): void => {
          const l = Math.hypot(sx1 - sx0, sz1 - sz0), u1 = l / 0.55;
          ch.quad(sx0, y + 0.1, sz0, sx1, y + 0.1, sz1, sx1, y + 1.95, sz1, sx0, y + 1.95, sz0, 0xffffff, 0, 0, u1, 3.4);
        };
        if (ax === x0 && bx === x0) {
          // West: a gap for the gate (4 m); the leaves, closed and chained, are below.
          seg(ax, az, ax, GATE_Z + 2); seg(ax, GATE_Z - 2, bx, bz);
        } else seg(ax, az, bx, bz);
      }
      for (const s of [-1, 1]) b.box(x0 + 0.05, y + 0.15, GATE_Z + s * 1, 0.07, 1.7, 1.9, 0x555b61);
      b.box(x0 - 0.05, y + 0.9, GATE_Z, 0.1, 0.12, 0.5, MUST);
      b.box(x0 - 0.1, y + 0.7, GATE_Z, 0.07, 0.3, 0.2, 0x333333);
      // The long walls (posts and rails aside, the fence is a few boxes).
      this.fenceWalls.add(g.col.addBoxC((x0 + x1) / 2, z0, x1 - x0, 0.3, y + 2.1, y - 0.5));
      this.fenceWalls.add(g.col.addBoxC((x0 + x1) / 2, z1, x1 - x0, 0.3, y + 2.1, y - 0.5));
      this.fenceWalls.add(g.col.addBoxC(x1, (z0 + z1) / 2, 0.3, z1 - z0, y + 2.1, y - 0.5));
      this.fenceWalls.add(g.col.addBoxC(x0, (z0 + z1) / 2, 0.3, z1 - z0, y + 2.1, y - 0.5));
      t0.add(solid(b, true));
      const cm = new THREE.MeshStandardMaterial({ map: chainTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.2, vertexColors: true });
      const fm = new THREE.Mesh(ch.toGeometry(), cm);
      fm.matrixAutoUpdate = false;
      t0.add(fm);
      // Two site signs on the fence: SITE CLOSED, facing out.
      const sg = new Batch();
      for (const [sx, sz, faceNorth] of [[246, z1 + 0.12, false], [246, z0 - 0.12, true]] as [number, number, boolean][]) {
        const s = faceNorth ? -1 : 1, w = 3.2, h = 0.8;
        sg.quad(sx - s * w / 2, y + 1.0, sz, sx + s * w / 2, y + 1.0, sz, sx + s * w / 2, y + 1.0 + h, sz, sx - s * w / 2, y + 1.0 + h, sz, 0xffffff, 0, 0, 1, 1);
      }
      const sm = new THREE.Mesh(sg.toGeometry(), new THREE.MeshStandardMaterial({ map: signTexture(['SITE CLOSED', 'MILLPOND PROMENADE: A TOWN PROJECT'], '#14213d', '#f0a202'), side: THREE.DoubleSide, vertexColors: true, roughness: 0.8, metalness: 0 }));
      sm.matrixAutoUpdate = false;
      t0.add(sm);
    }

    // ---- 1: the gates open: paved walks, railings, benches --------------------
    const t1 = tier('promenade');
    {
      const b = new Batch(), sn = new Batch();
      const { x0, z0, z1 } = SITE;
      // (A street tree of the town stands at 286, -1930: it is left, between the walk and the railing.)
      const px0 = 270, px1 = 278;
      b.box((px0 + px1) / 2, y + 0.005, (z0 + z1) / 2, px1 - px0, 0.07, z1 - z0 - 4, SLAB);
      b.box(236 + 12, y + 0.005, GATE_Z, 62 - 0, 0.07, 5.2, SLAB);
      // The plaza: an octagon of slab with a paler ring.
      for (const [r, hex, dy] of [[PLAZA.r, SLAB, 0.02], [PLAZA.r - 2.2, 0xc9c4b6, 0.045], [8.4, 0xb4afa3, 0.07]] as [number, number, number][]) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2, a2 = ((i + 1) / 12) * Math.PI * 2;
          b.tri(PLAZA.x, y + dy, PLAZA.z, PLAZA.x + Math.cos(a2) * r, y + dy, PLAZA.z + Math.sin(a2) * r, PLAZA.x + Math.cos(a) * r, y + dy, PLAZA.z + Math.sin(a) * r, hex);
        }
      }
      // The street end: brick gate piers, a beam and the name across it.
      for (const s of [-1, 1]) {
        b.box(x0 + 0.4, y, GATE_Z + s * 3.1, 0.9, 3.3, 0.9, BRICK);
        b.box(x0 + 0.4, y + 3.3, GATE_Z + s * 3.1, 1.1, 0.15, 1.1, 0x6d2b21);
        this.pathWalls.add(g.col.addBoxC(x0 + 0.4, GATE_Z + s * 3.1, 1.0, 1.0, y + 3.4, y - 0.3));
      }
      b.box(x0 + 0.4, y + 3.15, GATE_Z, 0.4, 0.4, 6.4, 0x3d4a57);
      sn.quad(x0 - 0.02, y + 3.05, GATE_Z - 3.1, x0 - 0.02, y + 3.05, GATE_Z + 3.1, x0 - 0.02, y + 3.85, GATE_Z + 3.1, x0 - 0.02, y + 3.85, GATE_Z - 3.1, 0xffffff, 0, 0, 1, 1);
      sn.quad(x0 + 0.82, y + 3.05, GATE_Z + 3.1, x0 + 0.82, y + 3.05, GATE_Z - 3.1, x0 + 0.82, y + 3.85, GATE_Z - 3.1, x0 + 0.82, y + 3.85, GATE_Z + 3.1, 0xffffff, 0, 0, 1, 1);
      // Bollards at the street end of the walk, and railings along the bank.
      for (const s of [-1.6, 0, 1.6]) b.box(x0 - 3.4, y, GATE_Z + s * 1.0 + (s === 0 ? 0 : s * 0.2), 0.22, 0.85, 0.22, INK);
      const RX = 298;
      for (let z = z0 + 2; z <= z1 - 2; z += 2) b.box(RX, y, z, 0.09, 1.0, 0.09, INK);
      b.box(RX, y + 0.98, (z0 + z1) / 2, 0.1, 0.07, z1 - z0 - 4, 0x3d4a57);
      b.box(RX, y + 0.45, (z0 + z1) / 2, 0.05, 0.05, z1 - z0 - 4, 0x3d4a57);
      this.pathWalls.add(g.col.addBoxC(RX, (z0 + z1) / 2, 0.25, z1 - z0 - 4, y + 1.1, y - 0.5));
      // Benches facing the pond, benches facing the path, planters, bins.
      const bench = (x: number, z: number, face: number): void => {
        const c = Math.cos(face), s = Math.sin(face);
        // Facing +X when face = 0: seat 0.5 deep along X, 1.8 long along Z.
        const at = (a: number, bz: number): [number, number] => [x + a * c - bz * s, z + a * s + bz * c];
        const [sx, sz] = at(0, 0), [bx, bz2] = at(-0.25, 0);
        b.box(sx, y + 0.42, sz, 0.5, 0.06, 1.8, 0x8a6b45, -face);
        b.box(bx, y + 0.5, bz2, 0.06, 0.5, 1.8, 0x7a5c3a, -face);
        for (const o of [-0.8, 0.8]) { const [lx, lz] = at(0, o); b.box(lx, y, lz, 0.4, 0.42, 0.07, INK, -face); }
        this.pathWalls.add(g.col.addBoxC(x, z, Math.abs(c) > 0.5 ? 0.7 : 1.9, Math.abs(c) > 0.5 ? 1.9 : 0.7, y + 0.9, y - 0.2));
      };
      for (let i = 0; i < 5; i++) bench(281.8, z0 + 6 + i * 10.5, 0);
      for (let i = 0; i < 3; i++) { bench(222 + i * 9, GATE_Z - 4.1, Math.PI / 2); bench(222 + i * 9, GATE_Z + 4.1, -Math.PI / 2); }
      for (let i = 0; i < 6; i++) {
        const z = z0 + 5 + i * 8.6;
        b.box(268.4, y, z, 1.5, 0.6, 1.0, 0x8c8478);
        b.box(268.4, y + 0.6, z, 1.3, 0.5, 0.8, i % 2 ? GREEN : 0x3d6e44);
        this.pathWalls.add(g.col.addBoxC(268.4, z, 1.5, 1.0, y + 1.0, y - 0.2));
      }
      for (const [bx, bz] of [[279.6, z0 + 12], [279.6, z1 - 12], [236, GATE_Z - 3.2], [236, GATE_Z + 3.2]] as [number, number][]) {
        b.box(bx, y, bz, 0.5, 0.9, 0.5, 0x2b3a2f);
        b.box(bx, y + 0.9, bz, 0.56, 0.06, 0.56, INK);
      }
      t1.add(solid(b, true));
      const gm = new THREE.Mesh(sn.toGeometry(), new THREE.MeshStandardMaterial({ map: signTexture(['MILLPOND PROMENADE', 'OPEN. WALK, DO NOT DRIVE.'], '#f2e8cf', '#2f5d4a'), side: THREE.DoubleSide, vertexColors: true, roughness: 0.8, metalness: 0 }));
      gm.matrixAutoUpdate = false;
      t1.add(gm);
    }

    // ---- 2: the lamps are lit ------------------------------------------------
    const t2 = tier('lamps');
    {
      const b = new Batch(), lamp = new Batch(), glow = new Batch();
      const { z0 } = SITE;
      const posts: [number, number][] = [];
      for (let i = 0; i < 5; i++) posts.push([269.2, z0 + 4 + i * 11.2]);
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; posts.push([PLAZA.x + Math.cos(a) * 13.4, PLAZA.z + Math.sin(a) * 13.4]); }
      for (let i = 0; i < 3; i++) posts.push([210 + i * 12.5, GATE_Z - 3.1], [210 + i * 12.5, GATE_Z + 3.1]);
      for (const [x, z] of posts) {
        b.box(x, y, z, 0.3, 0.25, 0.3, 0x2b3a2f);
        b.box(x, y, z, 0.12, 4.3, 0.12, 0x2b3a2f);
        b.box(x, y + 4.2, z, 0.4, 0.07, 0.4, 0x2b3a2f);
        lamp.box(x, y + 3.88, z, 0.34, 0.34, 0.34, 0xfff0c8);
        lamp.box(x, y + 4.26, z, 0.2, 0.1, 0.2, 0xfff0c8);
        glow.quad(x - 5, y + 0.09, z + 5, x + 5, y + 0.09, z + 5, x + 5, y + 0.09, z - 5, x - 5, y + 0.09, z - 5, 0xffffff, 0, 0, 1, 1);
        this.pathWalls.add(g.col.addBoxC(x, z, 0.35, 0.35, y + 4.4, y - 0.2));
      }
      // String lights: four tall poles round the plaza, a sagging line between each pair, a bulb every metre or so.
      const poles: [number, number][] = [[PLAZA.x - 17.5, PLAZA.z - 11], [PLAZA.x + 17.5, PLAZA.z - 11], [PLAZA.x + 17.5, PLAZA.z + 11], [PLAZA.x - 17.5, PLAZA.z + 11]];
      for (const [x, z] of poles) {
        b.box(x, y, z, 0.18, 5.4, 0.18, 0x3d4a57);
        this.pathWalls.add(g.col.addBoxC(x, z, 0.3, 0.3, y + 5.4, y - 0.2));
      }
      const cols = [0xff6a4d, 0xffd24a, 0x7ad37a, 0x6ab7ff, 0xff9ad5];
      let bi = 0;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = poles[k], [bx, bz] = poles[(k + 1) % 4], L = Math.hypot(bx - ax, bz - az), n = Math.round(L / 1.1);
        let px = ax, py = y + 5.3, pz = az;
        for (let i = 1; i <= n; i++) {
          const u = i / n, nx = ax + (bx - ax) * u, nz = az + (bz - az) * u, ny = y + 5.3 - 0.9 * Math.sin(u * Math.PI);
          b.box((px + nx) / 2, (py + ny) / 2 - 0.01, (pz + nz) / 2, Math.max(0.03, Math.abs(nx - px)), 0.03 + Math.abs(ny - py), Math.max(0.03, Math.abs(nz - pz)), 0x20262c);
          lamp.box(nx, ny - 0.16, nz, 0.15, 0.17, 0.15, cols[bi++ % cols.length]);
          px = nx; py = ny; pz = nz;
        }
      }
      t2.add(solid(b, true));
      this.lampMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
      const lm = new THREE.Mesh(lamp.toGeometry(), this.lampMat);
      lm.matrixAutoUpdate = false;
      t2.add(lm);
      this.glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const gm = new THREE.Mesh(glow.toGeometry(), this.glowMat);
      gm.matrixAutoUpdate = false; gm.renderOrder = 3;
      t2.add(gm);
    }

    // ---- 3: the pavilion -----------------------------------------------------
    const t3 = tier('pavilion');
    {
      const b = new Batch();
      const cx = PLAZA.x, cz = PLAZA.z, RC = 6.2, RR = 8.2, HC = 3.6, HA = 6.6;
      // A low raised floor with two steps, eight white columns and a ring beam.
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, a2 = ((i + 1) / 12) * Math.PI * 2;
        for (const [r, dy, hex] of [[7.4, 0.14, 0x9d9a90], [6.6, 0.26, 0xb9b4a6]] as [number, number, number][]) {
          b.tri(cx, y + dy, cz, cx + Math.cos(a2) * r, y + dy, cz + Math.sin(a2) * r, cx + Math.cos(a) * r, y + dy, cz + Math.sin(a) * r, hex);
          b.quad(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, cx + Math.cos(a2) * r, y, cz + Math.sin(a2) * r, cx + Math.cos(a2) * r, y + dy, cz + Math.sin(a2) * r, cx + Math.cos(a) * r, y + dy, cz + Math.sin(a) * r, hex, 0, 0, 1, 1, 0.85);
        }
      }
      const ring: [number, number][] = [], eave: [number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const x = cx + Math.cos(a) * RC, z = cz + Math.sin(a) * RC;
        ring.push([x, z]); eave.push([cx + Math.cos(a) * RR, cz + Math.sin(a) * RR]);
        b.box(x, y + 0.26, z, 0.5, 0.2, 0.5, 0xe9e5d8);
        b.box(x, y + 0.46, z, 0.34, HC - 0.46, 0.34, 0xf2eee2);
        b.box(x, y + HC - 0.1, z, 0.5, 0.2, 0.5, 0xe9e5d8);
        this.pavWalls.add(g.col.addBoxC(x, z, 0.5, 0.5, y + HC, y - 0.2));
      }
      for (let i = 0; i < 8; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 8];
        const L = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bx - ax, bz - az) - Math.PI / 2;
        b.box((ax + bx) / 2, y + HC + 0.1, (az + bz) / 2, L, 0.22, 0.22, 0xe9e5d8, ang);
        // A rail between the columns, with a gap on the two sides the steps face (west and south).
        if (i !== 4 && i !== 6) b.box((ax + bx) / 2, y + 0.7, (az + bz) / 2, L - 0.5, 0.07, 0.07, 0xe9e5d8, ang);
        // The roof: red and white in turn, from the eave up to the apex.
        const [ex0, ez0] = eave[i], [ex1, ez1] = eave[(i + 1) % 8];
        b.tri(cx, y + HA, cz, ex0, y + HC + 0.25, ez0, ex1, y + HC + 0.25, ez1, i % 2 ? 0xf2ede0 : VERM);
        b.tri(cx, y + HA, cz, ex1, y + HC + 0.15, ez1, ex0, y + HC + 0.15, ez0, 0x6d4a35);
        // Bunting along the eave: small pennants in turn.
        const m = 5;
        for (let k = 0; k < m; k++) {
          const u = (k + 0.5) / m, qx = ex0 + (ex1 - ex0) * u, qz = ez0 + (ez1 - ez0) * u, dx = (ex1 - ex0) / m * 0.4, dz = (ez1 - ez0) / m * 0.4;
          b.tri(qx - dx, y + HC + 0.14, qz - dz, qx + dx, y + HC + 0.14, qz + dz, qx, y + HC - 0.4, qz, [MUST, VERM, 0x2d9ac8, 0x7ad37a, BONE][(k + i) % 5]);
        }
      }
      b.box(cx, y + HA, cz, 0.08, 1.5, 0.08, STEEL);
      b.box(cx + 0.35, y + HA + 1.1, cz, 0.7, 0.4, 0.03, VERM);
      // A little stage in the middle: a podium and a drum riser.
      b.box(cx, y + 0.26, cz - 1.4, 3.2, 0.3, 1.8, 0x7a5c3a);
      b.box(cx, y + 0.56, cz - 2.0, 0.5, 1.0, 0.4, 0x3d4a57);
      b.box(cx - 1.4, y + 0.26, cz + 1.0, 0.9, 0.4, 0.9, 0x8a3b2e);
      t3.add(solid(b, true));
    }

    // ---- the board -----------------------------------------------------------
    {
      const b = new Batch(), bd = new Batch();
      const { x, z } = BOARD, W = 5.0, H = 2.5, yb = y + 1.5;
      for (const s of [-1, 1]) b.box(x + 0.3, y, z + s * (W / 2 - 0.2), 0.16, yb + H - y + 0.2, 0.16, INK);
      b.box(x + 0.15, yb - 0.08, z, 0.12, H + 0.16, W + 0.16, INK);
      b.box(x + 0.5, y + 0.35, z, 0.1, 0.1, 0.1, INK);
      // The coin box under the middle of the board: a red box with a slot, like the Fund's.
      b.box(x - 0.1, y, z, 0.5, 0.08, 0.5, STEEL);
      b.box(x - 0.1, y + 0.08, z, 0.14, 0.9, 0.14, INK);
      b.box(x - 0.1, y + 0.9, z, 0.5, 0.62, 0.62, VERM);
      b.box(x - 0.38, y + 1.35, z, 0.04, 0.22, 0.05, INK);
      b.box(x - 0.1, y + 1.52, z, 0.58, 0.05, 0.7, INK);
      g.col.addProp(BOARD.x - 0.1, BOARD.z, 0.38, y + 1.5, 'post', false).hard = true;
      for (const s of [-1, 1]) g.col.addProp(x + 0.3, z + s * (W / 2 - 0.2), 0.14, y + 3.5, 'post', false).hard = true;
      bd.quad(x - 0.02, yb, z - W / 2, x - 0.02, yb, z + W / 2, x - 0.02, yb + H, z + W / 2, x - 0.02, yb + H, z - W / 2, 0xffffff, 0, 0, 1, 1);
      const mesh = new THREE.Mesh(b.toGeometry(), mats.flatDouble);
      mesh.matrixAutoUpdate = false; mesh.receiveShadow = true;
      root.add(mesh);
      this.boardCv = document.createElement('canvas');
      this.boardCv.width = 1024; this.boardCv.height = 512;
      this.boardTex = new THREE.CanvasTexture(this.boardCv);
      this.boardTex.colorSpace = THREE.SRGBColorSpace;
      this.boardTex.anisotropy = 4;
      const fm = new THREE.Mesh(bd.toGeometry(), new THREE.MeshStandardMaterial({ map: this.boardTex, vertexColors: true, roughness: 0.85, metalness: 0 }));
      fm.matrixAutoUpdate = false;
      root.add(fm);
    }
    g.scene.add(root);
    this.built = true;
    this.apply();
    this.drawBoard(true);
  }

  /** Show what the town's stage says: tiers and their walls. */
  private apply(): void {
    const p = this.stage;
    this.shown = p;
    this.tiers[0].visible = p === 0;
    this.tiers[1].visible = p >= 1;
    this.tiers[2].visible = p >= 2;
    this.tiers[3].visible = p >= 3;
    this.fenceWalls.set(p === 0);
    this.pathWalls.set(p >= 1);
    this.pavWalls.set(p >= 3);
  }

  private drawBoard(force = false): void {
    const g = progress.goal(), p = this.stage;
    const key = `${p}|${g ? g.n : 0}|${g ? Math.floor(g.have / 5) : 0}|${this.open ? 1 : 0}|${progress.mine ? 1 : 0}`;
    if (!force && key === this.boardKey) return;
    this.boardKey = key; this.stats.redraws++;
    const c = this.boardCv.getContext('2d') as CanvasRenderingContext2D, W = 1024, H = 512;
    const ink = '#14213d', paper = '#f2e8cf', verm = '#e4572e', green = '#2f5d4a';
    c.fillStyle = paper; c.fillRect(0, 0, W, H);
    c.strokeStyle = ink; c.lineWidth = 12; c.strokeRect(10, 10, W - 20, H - 20);
    c.fillStyle = verm; c.fillRect(16, 16, W - 32, 96);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = paper;
    c.font = '900 76px "Big Shoulders Display", "Arial Narrow", sans-serif';
    c.fillText(PROJECT_NAME.toUpperCase(), W / 2, 56);
    c.fillStyle = ink; c.textAlign = 'left';
    c.font = '600 28px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    c.fillText("A Tepid Falls town project: everybody's points and cash count", 40, 142);
    const rows = this.rows();
    rows.forEach((r, i) => {
      const y = 190 + i * 62;
      c.strokeStyle = ink; c.lineWidth = 5; c.strokeRect(40, y - 20, 40, 40);
      if (r.done) { c.fillStyle = green; c.fillRect(46, y - 14, 28, 28); }
      c.fillStyle = ink; c.font = `${r.current ? 800 : 600} 40px "Big Shoulders Display", "Arial Narrow", sans-serif`;
      c.fillText(`${i + 1}. ${r.name}`, 100, y);
      c.textAlign = 'right'; c.font = '600 30px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
      c.fillText(r.done ? 'DONE' : r.current ? `${r.have} / ${r.cost}` : money(r.cost), W - 44, y);
      c.textAlign = 'left';
    });
    const gl = progress.goal();
    const y = 400;
    if (gl && gl.kind === 'project') {
      c.fillStyle = '#d9cfae'; c.fillRect(40, y, W - 80, 34);
      c.fillStyle = verm; c.fillRect(40, y, (W - 80) * Math.min(1, gl.have / gl.cost), 34);
      c.strokeStyle = ink; c.lineWidth = 4; c.strokeRect(40, y, W - 80, 34);
      c.fillStyle = ink; c.font = '600 30px "Barlow Semi Condensed", "Arial Narrow", sans-serif'; c.textAlign = 'center';
      c.fillText(`${money(Math.ceil(gl.cost - gl.have))} to go. Press G at the coin box to give. Jobs, finds and deliveries count too.`, W / 2, y + 68);
    } else {
      c.fillStyle = ink; c.font = '600 32px "Barlow Semi Condensed", "Arial Narrow", sans-serif'; c.textAlign = 'center';
      const line = gl ? 'Opens when every part of Tepid Falls is open. Points count from the first one.' : 'Finished. Thank you, everybody. Please use the benches.';
      c.fillText(line, W / 2, y + 40);
    }
    this.boardTex.needsUpdate = true;
  }

  // ── each frame ─────────────────────────────────────────────────────────────

  update(): void {
    this.prompt = null;
    if (!this.on) return;
    const g = this.game, pl = g.player;
    const dx = pl.x - PLAZA.x, dz = pl.z - PLAZA.z, d2 = dx * dx + dz * dz;
    if (!this.built) {
      if (d2 > 700 * 700) return;
      this.build();
    }
    const root = this.root as THREE.Group;
    const near = d2 < 600 * 600;
    if (root.visible !== near) root.visible = near;
    if (!near) return;
    if (this.stage !== this.shown) this.apply();
    this.drawBoard();
    // The lamps come on at dusk: the bulbs and the pools of light on the ground.
    if (this.shown >= 2) {
      const n = g.sky.night, k = Math.min(1, Math.max(0, n * 1.4));
      this.lampMat.color.setScalar(0.42 + 1.2 * k);
      this.glowMat.opacity = 0.7 * k;
      this.glowMat.visible = k > 0.02;
    }
    this.ribbon();
    // The coin box.
    const bx = BOARD.x - 0.1, bz = BOARD.z;
    if (pl.vehicle || Math.hypot(pl.x - bx, pl.z - bz) > REACH || g.state !== 'play') return;
    const goal = progress.goal();
    if (!this.open) {
      const next = progress.stage < STAGES ? goalOf({ spans: progress.spans, stage: progress.stage, bank: progress.bank }) : null;
      this.prompt = `The Promenade fund opens when Tepid Falls is fully open${next ? ` (${stageName(next.n)} still to go)` : ''}.`;
      return;
    }
    if (!goal || goal.kind !== 'project') { this.prompt = `${PROJECT_NAME}: finished. Thank you, everybody.`; return; }
    const need = Math.ceil(goal.cost - goal.have);
    this.prompt = `[G] Give to the Promenade fund: ${stageName(goal.n)}, ${money(need)} to go${progress.mine ? ' (the town\'s)' : ''}`;
    if (g.input.eat('interact') && g.time - this.lastPay > 0.4) {
      this.lastPay = g.time;
      const pay = Math.min(Math.floor(pl.money), need);
      if (pay <= 0) { g.hud.toast('The Promenade fund accepts cash. Yours is, at the moment, imaginary.', 4); return; }
      pl.money -= pay;
      this.stats.gifts++;
      const done = progress.add(pay);
      progress.save();
      if (!done) g.hud.toast(`${money(pay)} in the box${progress.mine ? ' for the town' : ''}. ${stageName(goal.n)}: ${money(need - pay)} still to find. The board has been repainted. Not yet, but it will be.`, 5);
      g.todo.saveNow();
    }
  }

  /** The ribbon-cutting purse: the first time you walk in after a stage has opened. */
  private ribbon(): void {
    const g = this.game, pl = g.player, p = this.shown;
    if (p < 1 || g.state !== 'play') return;
    const { x0, x1, z0, z1 } = SITE;
    if (pl.x < x0 + 1 || pl.x > x1 + 4 || pl.z < z0 || pl.z > z1) return;
    const b = save.data.best;
    let mask = (b[RIBBON_KEY] ?? 0) | 0;
    for (let k = 0; k < p; k++) {
      if (mask & (1 << k)) continue;
      mask |= 1 << k;
      b[RIBBON_KEY] = mask;
      const pay = RIBBON[k] ?? 100;
      pl.money += pay; save.credit(pay); save.data.stats.earned += pay;
      this.stats.ribbons++;
      g.hud.stamp(stageName(STAGES + k + 1).toUpperCase(), `Ribbon cut. The Harbor Authority gives you ${money(pay)} from the petty cash.`);
      g.todo.saveNow();
      return;
    }
  }

  /** A radar badge at the yard while the project is in hand and the player is on the mainland. */
  blips(out: Blip[]): void {
    if (!this.on || this.game.player.z > -700) return;
    const g = progress.goal();
    if (!this.open || !g || g.kind !== 'project') return;
    out.push({ x: BOARD.x, z: BOARD.z, kind: 'job', label: 'M' });
  }

  info(): Record<string, unknown> {
    const g = progress.goal();
    return {
      on: this.on, built: this.built, stage: this.stage, shown: this.shown, open: this.open, all: ALL_STAGES,
      goal: g && g.kind === 'project' ? { n: g.n, have: Math.floor(g.have), cost: g.cost } : null,
      tiers: this.tiers.map((t) => t.visible), board: this.boardKey, stats: { ...this.stats },
      ribbons: ((save.data.best[RIBBON_KEY] ?? 0) | 0),
    };
  }
}
