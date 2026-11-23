// Cannons and catapults (fun queue item 4): five machines around both towns that put Dess into the sky.
//
//   The Great Calamitini        a circus cannon on Saltwater Strand, over Low Tide Beach and out to a floating ring
//   The Mercy Park Trebuchet    a timber trebuchet on the west lawn, at a target painted on the grass
//   SpeedScan Overnight         a parcel cannon on a podium roof by Calamity Ave, down the avenue (ride up from the
//                               kiosk on the sidewalk); no target, only roofs and traffic
//   Fort Reluctance Catapult    a mangonel beside the blockhouse, out over the Lesser Tepid meadow, at a painted target
//   The Muddle River Crossing   a catapult on the Loom Row bank, across the Muddle River at a target on the far bank
//
// Walk up and press F (the touch LAUNCH button): Dess climbs in. W/S set the power, A/D the direction, Q/E the angle
// (the touch stick does power and direction); a dotted arc shows where she is going. F or Space fires: the cannon's
// fuse fizzes for a second and a half and it BOOMs (flash, smoke, a shake); the trebuchet's counterweight drops and
// the arm comes over creaking; the catapult ratchets and snaps against its stop bar. G climbs out.
//
// The flight is the ragdoll (ent/ragdoll.ts) through Player.knockDown, so it spins and flails, splashes in water,
// bounces off what it hits, and is sent to other players in the shared town by the existing ragdoll state frame;
// the machines are static scenery everywhere. The aim preview steps the same gravity and air drag as the ragdoll.
// Roofs: the ragdoll's floor is the street, so this file bounces a body that comes down onto a building top (twice
// at most) before letting the ragdoll's walls push it off the edge. Stunt replay (fx/replay.ts) plays a launch by
// itself: it already watches her own flights.
//
// Scored at the first touch: the landing distance from the machine ("Furthest launch"), and on a target, rings of
// 10, 6 and 2.5 m (outer $40, inner $100, bullseye $250; "Bullseyes"). Every shot counts "Times fired from a
// cannon" (catapults included: the form has one box).
//
// Cost: each machine is merged per material (about 9 meshes with its sign; frustum-culled, so a handful are drawn
// at once), one instanced draw for the arc beads while aiming (registered with game.flip). Per frame with nobody in
// a machine: a distance check against five points and the float ring's bob.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import { flip } from '../core/flip';
import { clamp, pickRand } from '../core/util';
import { groundAt } from './plan';
import { waterLevelAt } from './mainland';
import { HIP } from '../ent/character';
import { save } from '../game/save';
import type { AudioCore } from '../audio/audio';
import { fwBoom } from '../audio/fireworks';
import { creak, fuseHiss, ratchet, thwack, whoosh } from '../audio/launchers';

/** The ragdoll's own numbers (ent/ragdoll.ts): gravity, air drag per second, centre of mass above the hip joint. */
const GRAV = 9.81 * 0.8, DRAG = 0.05, COM_Y = 0.14;
const STEP = 1 / 60;
const FEET = 3.28084;
const RINGS = [2.5, 6, 10];
const PRIZE = [250, 100, 40];
const MOUNT_R = 3.4;
const DOTS = 64;

type Kind = 'cannon' | 'trebuchet' | 'catapult';
type TargetKind = 'float' | 'paint' | null;

interface SiteDef {
  id: string; name: string; kind: Kind;
  x: number; z: number;
  /** Direction of fire (game heading: 0 is +Z, atan2(dx, dz)). */
  h: number;
  /** Stand on the roof under (x, z) rather than the ground. */
  roof?: boolean;
  /** Where she walks up to it, if not beside it (the rooftop cannon's kiosk). */
  booth?: { x: number; z: number; h: number };
  /** Launch speed range, m/s, and the default share of it. */
  v0: number; v1: number; power: number;
  /** Elevation, radians: default and range. */
  pitch: number; p0: number; p1: number;
  target: TargetKind;
  /** Paint: barrel and trim colours (cannon), or the timber stain (catapult). */
  paint: number; trim: number;
  blurb: string;
}

const SITES: SiteDef[] = [
  { id: 'strand', name: 'The Great Calamitini', kind: 'cannon', x: 94, z: 427, h: 0.05, v0: 16, v1: 38, power: 0.6, pitch: 0.7, p0: 0.3, p1: 1.15,
    target: 'float', paint: 0xc8262c, trim: 0xe8b33a, blurb: 'Human cannonball, one careful owner' },
  { id: 'park', name: 'The Mercy Park Trebuchet', kind: 'trebuchet', x: 100, z: -44, h: Math.PI, v0: 14, v1: 36, power: 0.55, pitch: 0.75, p0: 0.35, p1: 1.15,
    target: 'paint', paint: 0x8a6440, trim: 0x2d2d30, blurb: 'Siege engine, municipal' },
  { id: 'avenue', name: 'SpeedScan Overnight', kind: 'cannon', x: -47.6, z: 14, h: 2.99, roof: true, booth: { x: -42.2, z: 20, h: -Math.PI / 2 },
    v0: 12, v1: 34, power: 0.55, pitch: 0.45, p0: 0.1, p1: 1.0, target: null, paint: 0x1d4f9c, trim: 0xf28c28, blurb: 'Parcel cannon. You are the parcel' },
  { id: 'fort', name: 'Fort Reluctance Catapult', kind: 'catapult', x: 428, z: -1444, h: Math.PI / 2 + 0.1, v0: 12, v1: 32, power: 0.55, pitch: 0.75, p0: 0.35, p1: 1.15,
    target: 'paint', paint: 0x7a5636, trim: 0x2b2a28, blurb: 'Built 1754. Finally used' },
  { id: 'river', name: 'The Muddle River Crossing', kind: 'catapult', x: 243.8, z: -1250, h: Math.PI / 2, v0: 16, v1: 40, power: 0.62, pitch: 0.72, p0: 0.35, p1: 1.15,
    target: 'paint', paint: 0x55703c, trim: 0x2b2a28, blurb: 'A ferry, in the broad sense' },
];

const LANDED: Record<string, string[]> = {
  water: ['Splashdown. The lifeguard has filed a strongly worded whistle.', 'Into the drink. Style points: some.', 'Wet, but airborne first. That counts.'],
  beach: ['Sand in places sand should not be.', 'A beach landing. The gulls have notes.', 'Low Tide Beach, now with a Dess-shaped crater.'],
  ground: ['Landing: technically a landing.', 'The ground was there. As promised.', 'Arrived. Somewhat.'],
  roof: ['Roof inspected personally.', 'Building code compliance checked from above.', 'Pigeons displaced: several.'],
};
const BULL = ['BULLSEYE. The judges are standing.', 'Dead centre. Somebody check the math.', 'Bullseye. Frame this one.'];
const RING = ['On the target. Close enough to brag.', 'Ring hit. The paint is grateful.'];

// ── Materials and a tiny model kit ──────────────────────────────────────────

function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = '#b08a60'; x.fillRect(0, 0, 128, 256);
  let s = 7;
  const r = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const px = r() * 128, w = 0.6 + r() * 2.2, l = 0.35 + r() * 0.35;
    x.strokeStyle = `rgba(${60 + r() * 40 | 0},${38 + r() * 25 | 0},${20 + r() * 12 | 0},${0.15 + r() * 0.3})`;
    x.lineWidth = w;
    x.beginPath(); x.moveTo(px, 0);
    for (let y = 0; y <= 256; y += 16) x.lineTo(px + Math.sin(y * 0.03 + i) * 3 * l, y);
    x.stroke();
  }
  for (let i = 0; i < 4; i++) { x.fillStyle = 'rgba(70,45,25,0.5)'; x.beginPath(); x.ellipse(r() * 128, r() * 256, 3 + r() * 3, 6 + r() * 5, 0, 0, 6.3); x.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function targetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d')!, m = 256, k = 256 / 10.4;
  x.clearRect(0, 0, 512, 512);
  const ring = (r: number, col: string): void => { x.fillStyle = col; x.beginPath(); x.arc(m, m, r * k, 0, Math.PI * 2); x.fill(); };
  ring(10.4, '#f4f1e8'); ring(10, '#c8262c'); ring(8.6, '#f4f1e8'); ring(6, '#c8262c'); ring(4.6, '#f4f1e8'); ring(2.5, '#f0b429'); ring(1.0, '#c8262c');
  x.strokeStyle = 'rgba(30,30,30,0.35)'; x.lineWidth = 3;
  for (const r of [10, 6, 2.5]) { x.beginPath(); x.arc(m, m, r * k, 0, Math.PI * 2); x.stroke(); }
  // Worn, like any painted lawn marking.
  let s = 11;
  const rr = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(70,90,50,${0.08 + rr() * 0.2})`; x.fillRect(rr() * 512, rr() * 512, 1 + rr() * 5, 1 + rr() * 5); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface Mats {
  wood: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; iron: THREE.MeshStandardMaterial;
  rope: THREE.MeshStandardMaterial; white: THREE.MeshStandardMaterial; stone: THREE.MeshStandardMaterial;
  paint: Map<number, THREE.MeshStandardMaterial>;
}

/** Collects parts by material and merges them: one draw call per material per model. */
class Kit {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  add(g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
    this.e.set(rx, ry, rz);
    this.m.compose(new THREE.Vector3(x, y, z), this.q.setFromEuler(this.e), new THREE.Vector3(1, 1, 1));
    const c = g.clone().applyMatrix4(this.m);
    if (!c.getAttribute('uv')) c.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(c.getAttribute('position').count * 2), 2));
    let l = this.parts.get(mat);
    if (!l) this.parts.set(mat, (l = []));
    l.push(c);
  }
  box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  }
  /** A beam from a to b, square section s. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, s: number, mat: THREE.Material): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az, l = Math.hypot(dx, dy, dz);
    const g = new THREE.BoxGeometry(s, l, s);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / l, dy / l, dz / l));
    g.applyQuaternion(q).translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    this.add(g, mat);
  }
  /** A cylinder along X (axles, wheels), Y or Z. */
  cyl(r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', seg = 14): void {
    this.add(new THREE.CylinderGeometry(r, r, len, seg), mat, x, y, z, axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0);
  }
  /** A spoked wheel in the YZ plane (axle along X). */
  wheel(r: number, w: number, x: number, y: number, z: number, rim: THREE.Material, spoke: THREE.Material, hub: THREE.Material): void {
    this.add(new THREE.TorusGeometry(r - 0.06, 0.07, 6, 28), rim, x, y, z, 0, Math.PI / 2, 0);
    this.add(new THREE.TorusGeometry(r - 0.13, 0.05, 6, 28), spoke, x, y, z, 0, Math.PI / 2, 0);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.add(new THREE.BoxGeometry(w * 0.4, r * 0.86, 0.06), spoke, x, y + Math.cos(a) * r * 0.45, z + Math.sin(a) * r * 0.45, -a, 0, 0);
    }
    this.cyl(r * 0.18, w, hub, x, y, z, 'x', 12);
  }
  build(shadow = true): THREE.Group {
    const grp = new THREE.Group();
    for (const [mat, list] of this.parts) {
      const nonIdx = list.map((g) => (g.index ? g.toNonIndexed() : g));
      const merged = mergeGeometries(nonIdx, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadow; mesh.receiveShadow = true;
      grp.add(mesh);
      for (const g of list) g.dispose();
    }
    return grp;
  }
}

// ── State ────────────────────────────────────────────────────────────────────

interface Site extends SiteDef {
  /** Base height. */
  y: number;
  root: THREE.Group;
  /** The part that moves: the barrel (pitch) or the arm (swing about its axle). */
  mover: THREE.Group;
  /** Current aim. */
  aimH: number; aimP: number; aimV: number;
  /** Arm angle (trebuchet, catapult) and its rest. */
  arm: number; rest: number;
  /** After a throw: seconds until the arm has been wound back. */
  reset: number;
  tx: number; tz: number; ty: number;
  ring: THREE.Group | null;
}

interface Flight {
  site: Site; sx: number; sz: number; t: number; touched: boolean; dist: number; bounces: number;
  prevY: number; where: string; score: number;
}

export class Launchers implements WorldPart {
  readonly sites: Site[] = [];
  /** For tools: what happened this visit. */
  readonly stats = { fired: 0, touched: 0, bulls: 0, rings: 0, bounces: 0, far: 0, last: '' as string, lastDist: 0, lastScore: -1 };
  private readonly mats: Mats;
  private mode: 'idle' | 'aim' | 'windup' = 'idle';
  private cur: Site | null = null;
  private t = 0;
  private flight: Flight | null = null;
  private installed = false;
  private prompting = false;
  private ownView = false;
  private dots!: THREE.InstancedMesh;
  private landMark!: THREE.Mesh;
  private readonly pts = new Float32Array(DOTS * 3);
  private nPts = 0;
  private aimKey = '';
  private fused = false;
  private clock = 0;
  private btns: HTMLElement | null = null;
  private coarse: boolean | null = null;
  private readonly m4 = new THREE.Matrix4();
  private readonly v3 = new THREE.Vector3();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly L = { x: 0, y: 0, z: 0 };

  constructor(private readonly game: Game, parent: THREE.Group) {
    const wood = woodTexture();
    const std = (color: number, rough: number, metal = 0, map: THREE.Texture | null = null): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, map });
    this.mats = {
      wood: std(0xd8b48a, 0.78, 0, wood), dark: std(0x8a6a4a, 0.82, 0, wood), iron: std(0x3a3b3e, 0.42, 0.85),
      rope: std(0xb8a27a, 0.95), white: std(0xf2efe6, 0.5), stone: std(0x8d8a84, 0.9), paint: new Map(),
    };
    const grp = new THREE.Group();
    grp.name = 'launchers';
    parent.add(grp);
    for (const d of SITES) this.sites.push(this.build(d, grp));
    // The arc preview: one instanced draw of small bright beads, and a ring where it comes down.
    const dm = new THREE.MeshBasicMaterial({ color: 0xfff0b8, toneMapped: false, transparent: true, opacity: 0.92, depthWrite: false });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 10, 7), dm, DOTS);
    this.dots.frustumCulled = false; this.dots.visible = false; this.dots.renderOrder = 5;
    for (let i = 0; i < DOTS; i++) this.dots.setMatrixAt(i, this.hidden);
    flip.mesh(this.dots);
    grp.add(this.dots);
    this.landMark = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.5, 40), new THREE.MeshBasicMaterial({ color: 0xfff0b8, toneMapped: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    this.landMark.rotation.x = -Math.PI / 2; this.landMark.visible = false; this.landMark.renderOrder = 5;
    grp.add(this.landMark);
    (game as unknown as { launchers?: Launchers }).launchers = this;
  }

  private paint(c: number, rough = 0.38, metal = 0.1): THREE.MeshStandardMaterial {
    const key = c * 4 + Math.round(rough * 3);
    let m = this.mats.paint.get(key);
    if (!m) this.mats.paint.set(key, (m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal })));
    return m;
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  private build(d: SiteDef, parent: THREE.Group): Site {
    const g = this.game;
    let y = groundAt(d.x, d.z);
    if (d.roof) g.col.forBoxes(d.x, d.z, 0.5, (b) => { if (d.x > b.x0 && d.x < b.x1 && d.z > b.z0 && d.z < b.z1 && b.y1 > y && b.y1 < 40) y = b.y1; });
    const root = new THREE.Group(), mover = new THREE.Group();
    root.position.set(d.x, y, d.z); root.rotation.y = d.h;
    const s: Site = { ...d, y, root, mover, aimH: d.h, aimP: d.pitch, aimV: d.v0 + (d.v1 - d.v0) * d.power, arm: 0, rest: 0, reset: 0, tx: 0, tz: 0, ty: 0, ring: null };
    const M = this.mats, base = new Kit(), mv = new Kit();
    if (d.kind === 'cannon') {
      const barrel = this.paint(d.paint, 0.32, 0.25), trim = this.paint(d.trim, 0.3, 0.6), car = this.paint(d.roof ? 0x2a2c30 : 0x1f3c78, 0.5, 0.1);
      if (d.roof) {
        // A steel turntable on the roof, with a railing and a SpeedScan-blue plinth.
        base.cyl(1.9, 0.35, M.iron, 0, 0.18, 0, 'y', 28);
        base.box(1.6, 1.0, 1.4, barrel, 0, 0.85, -0.3);
        base.box(0.3, 1.4, 1.2, car, -0.95, 1.4, 0); base.box(0.3, 1.4, 1.2, car, 0.95, 1.4, 0);
        for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; base.cyl(0.04, 1.0, trim, Math.cos(a) * 2.3, 0.5, Math.sin(a) * 2.3, 'y', 6); }
        base.add(new THREE.TorusGeometry(2.3, 0.05, 6, 40), trim, 0, 1.0, 0, Math.PI / 2, 0, 0);
      } else {
        // A circus gun carriage: painted cheeks, gilt edging, two big spoked wheels and a trail to the sand.
        base.box(0.22, 1.1, 2.6, car, -0.7, 1.15, -0.2); base.box(0.22, 1.1, 2.6, car, 0.7, 1.15, -0.2);
        base.box(0.26, 0.08, 2.64, trim, -0.7, 1.72, -0.2); base.box(0.26, 0.08, 2.64, trim, 0.7, 1.72, -0.2);
        base.cyl(0.11, 2.3, M.iron, 0, 0.95, 0, 'x');
        base.wheel(0.95, 0.2, -1.05, 0.95, 0, trim, car, M.iron); base.wheel(0.95, 0.2, 1.05, 0.95, 0, trim, car, M.iron);
        base.beam(0, 0.95, -0.9, 0, 0.12, -3.4, 0.36, car); base.box(0.7, 0.14, 0.4, M.iron, 0, 0.08, -3.4);
        // A star-spangled drum to climb in from, and the fuse box.
        base.cyl(0.5, 0.6, barrel, 1.9, 0.3, -1.4, 'y', 20); base.add(new THREE.TorusGeometry(0.5, 0.04, 6, 20), trim, 1.9, 0.6, -1.4, Math.PI / 2, 0, 0);
      }
      // The barrel: a lathe profile (breech knob, reinforce bands, a belled muzzle) along +Z, pivoting at its trunnions.
      const prof = [[0, -1.5], [0.18, -1.55], [0.3, -1.45], [0.5, -1.3], [0.58, -1.1], [0.58, -0.6], [0.54, -0.5], [0.54, 1.2], [0.5, 1.3], [0.48, 2.9], [0.56, 3.05], [0.64, 3.25], [0.5, 3.3], [0.42, 3.2], [0.42, 0]]
        .map(([r, yy]) => new THREE.Vector2(r, yy));
      const lathe = new THREE.LatheGeometry(prof, 28); lathe.rotateX(Math.PI / 2);
      mv.add(lathe, barrel);
      for (const zz of [-1.0, 0.0, 1.25, 2.95]) mv.add(new THREE.TorusGeometry(zz > 2 ? 0.55 : 0.58, 0.055, 6, 28), trim, 0, 0, zz);
      mv.cyl(0.16, 1.5, trim, 0, 0, 0, 'x', 12);
      // Painted stars down each side.
      for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) mv.add(new THREE.OctahedronGeometry(0.12, 0), trim, sx * 0.53, 0, 0.35 + i * 0.6, 0, 0, Math.PI / 4);
      mover.position.set(0, d.roof ? 1.85 : 1.72, 0);
      mover.rotation.x = -d.pitch;
      g.col.addBoxC(d.x, d.z, d.roof ? 3.6 : 2.6, d.roof ? 3.6 : 2.6, y + 1.4, y - 0.5);
    } else if (d.kind === 'trebuchet') {
      const W = M.wood, D = M.dark, I = M.iron;
      // Base: two long sills, cross ties, two A-frame towers carrying the axle 6 m up.
      for (const sx of [-1.3, 1.3]) {
        base.box(0.4, 0.4, 8.4, D, sx, 0.2, 0);
        base.beam(sx, 0.3, -3.6, sx, 6.0, 0, 0.32, W); base.beam(sx, 0.3, 3.6, sx, 6.0, 0, 0.32, W);
        base.beam(sx, 0.3, 0, sx, 6.0, 0, 0.3, W);
        base.beam(sx, 2.6, -2.1, sx, 2.6, 2.1, 0.22, D);
        base.box(0.5, 0.5, 0.6, I, sx, 6.0, 0);
      }
      for (const zz of [-3.9, 0, 3.9]) base.box(3.0, 0.32, 0.36, D, 0, 0.18, zz);
      base.box(2.6, 0.22, 0.26, D, 0, 3.6, 0);
      // The release trough (a plank chute the sling drags along), and a pile of spare stones for scale.
      base.box(0.9, 0.1, 6.0, D, 0, 0.42, -4.4);
      for (let i = 0; i < 5; i++) base.add(new THREE.DodecahedronGeometry(0.28 + (i % 3) * 0.06, 0), M.stone, 2.2 + (i % 2) * 0.4, 0.3, -2 + i * 0.5);
      // Arm on its axle: long end (7.5 m) to the sling, short end (2.5 m) to a counterweight box.
      mv.cyl(0.13, 3.0, I, 0, 0, 0, 'x');
      mv.box(0.36, 10.0, 0.36, W, 0, 2.5, 0);
      for (const yy of [-1.6, 0.6, 3.4, 6.2]) mv.box(0.42, 0.12, 0.42, I, 0, yy, 0);
      mv.box(1.7, 1.5, 1.7, D, 0, -2.9, 0);
      mv.box(1.76, 0.12, 1.76, I, 0, -2.2, 0); mv.box(1.76, 0.12, 1.76, I, 0, -3.6, 0);
      mv.add(new THREE.TorusGeometry(0.35, 0.06, 6, 14), M.rope, 0, 7.7, 0, 0, Math.PI / 2, 0);
      mover.position.set(0, 6.0, 0);
      s.rest = -2.35; s.arm = s.rest;
      this.box(d, 3.4, 8.6, y + 2.2, y - 0.5);
    } else {
      const W = this.paint(d.paint, 0.8), D = M.dark, I = M.iron, Wd = M.wood;
      // A mangonel: a low wheeled frame, a stop bar on two posts, a twisted-rope torsion bundle and a spoon arm.
      for (const sx of [-1.05, 1.05]) {
        base.box(0.3, 0.32, 4.6, W, sx, 0.75, 0);
        base.wheel(0.55, 0.18, sx * 1.25, 0.55, -1.6, I, Wd, I); base.wheel(0.55, 0.18, sx * 1.25, 0.55, 1.6, I, Wd, I);
        base.beam(sx, 0.9, 0.9, sx, 2.6, 0.5, 0.24, W);
        base.beam(sx, 0.9, -0.2, sx, 2.6, 0.5, 0.2, D);
      }
      base.cyl(0.08, 2.9, I, 0, 0.55, -1.6, 'x'); base.cyl(0.08, 2.9, I, 0, 0.55, 1.6, 'x');
      for (const zz of [-2.1, -0.6, 1.0, 2.1]) base.box(2.3, 0.22, 0.28, D, 0, 0.75, zz);
      base.box(2.5, 0.3, 0.36, W, 0, 2.6, 0.5);
      base.box(2.1, 0.18, 0.4, this.paint(0x9a2a24, 0.85), 0, 2.45, 0.42);
      base.cyl(0.32, 2.0, M.rope, 0, 0.9, -0.6, 'x', 16);
      for (const sx of [-1.05, 1.05]) base.cyl(0.36, 0.18, I, sx, 0.9, -0.6, 'x', 16);
      // The winch at the back.
      base.cyl(0.14, 2.3, Wd, 0, 1.0, -2.0, 'x'); for (const sx of [-0.7, 0.7]) base.box(0.06, 0.9, 0.06, Wd, sx, 1.0, -2.0, 0.8, 0, 0);
      mv.box(0.26, 4.0, 0.26, Wd, 0, 2.0, 0);
      mv.add(new THREE.SphereGeometry(0.55, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), D, 0, 4.15, 0, Math.PI, 0, 0);
      mv.add(new THREE.TorusGeometry(0.55, 0.05, 6, 18), I, 0, 4.15, 0, Math.PI / 2, 0, 0);
      for (const yy of [0.6, 2.0, 3.4]) mv.box(0.3, 0.08, 0.3, I, 0, yy, 0);
      mover.position.set(0, 0.9, -0.6);
      s.rest = -1.2; s.arm = s.rest;
      this.box(d, 2.6, 4.2, y + 1.1, y - 0.5);
    }
    const bg = base.build(), mg = mv.build();
    root.add(bg);
    mover.add(mg);
    root.add(mover);
    if (d.kind !== 'cannon') mover.rotation.x = s.arm;
    // A painted sign board with the machine's name, beside it.
    root.add(this.sign(d));
    if (d.booth) this.kiosk(d, parent);
    parent.add(root);
    // The target: where the default aim comes down.
    if (d.target) {
      this.launchPoint(s, this.L);
      // A little further than the default aim (the bullseye wants a touch more power), on a patch clear of trees,
      // lamps, benches and buildings: the first clean spot of a few nearby aims.
      let best: { x: number; y: number; z: number } | null = null;
      search: for (const dp of [0.15, 0.2, 0.1, 0.25, 0.3, 0.05]) for (const dh of [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3]) {
        const r = this.simulate(this.L, s.h + dh, s.aimP, s.v0 + (s.v1 - s.v0) * Math.min(1, s.power + dp), false);
        if (!best) best = r;
        if (d.target === 'float' ? r.what === 'water' : r.what === 'ground' && this.clear(r.x, r.z)) { best = r; break search; }
      }
      s.tx = best!.x; s.tz = best!.z; s.ty = best!.y;
      s.ring = d.target === 'float' ? this.floatRing(s, parent) : this.paintedTarget(s, parent);
    }
    return s;
  }

  /** Nothing standing within a target's radius (props, boxes), and dry. */
  private clear(x: number, z: number): boolean {
    const col = this.game.col;
    let ok = groundAt(x, z) > waterLevelAt(x, z) - 0.2;
    col.forProps(x, z, 11, (p) => { if (Math.hypot(p.x - x, p.z - z) < 10.5 + p.r) ok = false; });
    col.forBoxes(x, z, 11, (b) => { if (x > b.x0 - 10.5 && x < b.x1 + 10.5 && z > b.z0 - 10.5 && z < b.z1 + 10.5) ok = false; });
    return ok;
  }

  /** A collision box for a machine of local size (sx across, sz along), turned to its heading. */
  private box(d: SiteDef, sx: number, sz: number, y1: number, y0: number): void {
    const turned = Math.abs(Math.sin(d.h)) > 0.7;
    this.game.col.addBoxC(d.x, d.z, turned ? sz : sx, turned ? sx : sz, y1, y0);
  }

  private sign(d: SiteDef): THREE.Object3D {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 192;
    const x = c.getContext('2d')!;
    x.fillStyle = d.id === 'avenue' ? '#1d4f9c' : d.id === 'strand' ? '#7a1418' : '#3b2a1c'; x.fillRect(0, 0, 512, 192);
    x.strokeStyle = d.id === 'avenue' ? '#f28c28' : '#e8b33a'; x.lineWidth = 10; x.strokeRect(8, 8, 496, 176);
    x.fillStyle = '#f6eedc'; x.textAlign = 'center';
    x.font = 'bold 44px Georgia, serif'; x.fillText(d.name.toUpperCase().replace('THE ', ''), 256, 82, 470);
    x.font = 'italic 28px Georgia, serif'; x.fillText(d.blurb, 256, 132, 470);
    x.font = 'bold 20px sans-serif'; x.fillText('PRESS F · HELMETS NOT PROVIDED', 256, 170, 470);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const grp = new THREE.Group();
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }));
    board.position.set(0, 1.55, 0.03);
    const back = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.0, 0.05), this.mats.dark);
    back.position.set(0, 1.55, 0);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.2, 0.12), this.mats.dark);
    post.position.set(0, 0.55, -0.05);
    grp.add(board, back, post);
    const side = d.kind === 'trebuchet' ? 3.6 : d.roof ? 2.8 : 2.4;
    grp.position.set(side, 0, -1.5); grp.rotation.y = Math.PI * 0.85;
    grp.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    return grp;
  }

  /** The rooftop cannon's sidewalk kiosk: a parcel drop box with a lift button. */
  private kiosk(d: SiteDef, parent: THREE.Group): void {
    const b = d.booth!, k = new Kit(), y = groundAt(b.x, b.z);
    const blue = this.paint(0x1d4f9c, 0.4), orange = this.paint(0xf28c28, 0.4);
    k.box(1.3, 2.1, 0.8, blue, 0, 1.05, 0); k.box(1.36, 0.14, 0.86, orange, 0, 2.17, 0);
    k.box(0.9, 0.08, 0.05, this.mats.iron, 0, 1.4, 0.41); k.cyl(0.08, 0.06, orange, 0, 1.0, 0.42, 'z', 12);
    const grp = k.build();
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#f28c28'; x.fillRect(0, 0, 256, 128); x.fillStyle = '#10264d'; x.textAlign = 'center';
    x.font = 'bold 30px sans-serif'; x.fillText('SPEEDSCAN', 128, 46); x.font = 'bold 22px sans-serif'; x.fillText('OVERNIGHT ↑ ROOF', 128, 84);
    x.font = '16px sans-serif'; x.fillText('express departures, press F', 128, 112);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.6), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
    sg.position.set(0, 1.75, 0.41);
    grp.add(sg);
    grp.position.set(b.x, y, b.z); grp.rotation.y = b.h;
    parent.add(grp);
    this.game.col.addBoxC(b.x, b.z, 0.9, 0.9, y + 2.1, y - 0.5);
  }

  /** A target painted on the ground under (tx, tz), draped over the terrain. */
  private paintedTarget(s: Site, parent: THREE.Group): THREE.Group {
    const geo = new THREE.PlaneGeometry(20.8, 20.8, 20, 20); geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundAt(s.tx + pos.getX(i), s.tz + pos.getZ(i)) + 0.05);
    geo.translate(s.tx, 0, s.tz);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: targetTexture(), roughness: 0.85, alphaTest: 0.5, transparent: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // The groundskeepers sweep it: snow (world/snowCover.ts) never lies on the target.
    mat.userData.noSnow = true;
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    const grp = new THREE.Group(); grp.add(m);
    parent.add(grp);
    return grp;
  }

  /** Three floating rings and a buoy with a flag, bobbing on the sea. */
  private floatRing(s: Site, parent: THREE.Group): THREE.Group {
    const k = new Kit(), red = this.paint(0xd2332c, 0.45), white = this.mats.white, gold = this.paint(0xf0b429, 0.4);
    const ring = (r: number, segs: number): void => {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const g = new THREE.TorusGeometry(r, 0.32, 8, 10, (Math.PI * 2) / segs);
        k.add(g, i % 2 ? white : red, 0, 0, 0, -Math.PI / 2, 0, a0);
      }
    };
    ring(10, 16); ring(6, 12); ring(2.5, 8);
    // Spokes of rope between the rings, and the buoy.
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; k.beam(Math.cos(a) * 2.8, 0, Math.sin(a) * 2.8, Math.cos(a) * 9.7, 0, Math.sin(a) * 9.7, 0.06, this.mats.rope); }
    k.add(new THREE.SphereGeometry(0.7, 16, 10), gold, 0, 0.1, 0);
    k.cyl(0.05, 2.4, this.mats.iron, 0, 1.3, 0, 'y', 6);
    k.box(0.9, 0.55, 0.02, red, 0.45, 2.2, 0);
    const grp = k.build();
    grp.position.set(s.tx, waterLevelAt(s.tx, s.tz), s.tz);
    parent.add(grp);
    return grp;
  }

  // ── Aim and the flight model ─────────────────────────────────────────────────

  /** Where the body leaves the machine (centre of mass), for the current aim. */
  private launchPoint(s: Site, out: { x: number; y: number; z: number }): void {
    const fx = Math.sin(s.aimH), fz = Math.cos(s.aimH);
    let up: number, fwd: number;
    if (s.kind === 'cannon') { const py = s.roof ? 1.85 : 1.72; up = py + Math.sin(s.aimP) * 3.4; fwd = Math.cos(s.aimP) * 3.4; }
    else if (s.kind === 'trebuchet') { up = 6 + 7.5 * Math.cos(0.5); fwd = 7.5 * Math.sin(0.5); }
    else { up = 0.9 + 4.2 * Math.cos(-0.1); fwd = -0.6 + 4.2 * Math.sin(-0.1); }
    out.x = s.x + fx * fwd; out.y = s.y + up; out.z = s.z + fz * fwd;
  }

  /** Step the ragdoll's gravity and drag from a launch until it comes down. Records beads when asked. */
  private simulate(L: { x: number; y: number; z: number }, h: number, p: number, v: number, beads: boolean): { x: number; y: number; z: number; t: number; what: string } {
    let x = L.x, y = L.y, z = L.z;
    let vx = Math.sin(h) * Math.cos(p) * v, vy = Math.sin(p) * v, vz = Math.cos(h) * Math.cos(p) * v;
    const air = Math.exp(-DRAG * STEP), col = this.game.col;
    if (beads) this.nPts = 0;
    let what = 'ground', i = 0, top = y;
    for (; i < 60 * 16; i++) {
      vy -= GRAV * STEP; vx *= air; vy *= air; vz *= air;
      x += vx * STEP; y += vy * STEP; z += vz * STEP;
      if (beads && i % 6 === 3 && this.nPts < DOTS) { const o = this.nPts * 3; this.pts[o] = x; this.pts[o + 1] = y; this.pts[o + 2] = z; this.nPts++; }
      if (vy > 0) { if (y > top) top = y; continue; }
      const fl = groundAt(x, z), wl = waterLevelAt(x, z);
      if (fl < wl - 0.4) { if (y < wl + 0.5) { what = 'water'; y = wl; break; } }
      else if (y < fl + 0.6) { what = 'ground'; y = fl; break; }
      if (i % 2 === 0 && col.pointBlocked(x, z, y - 0.6)) { what = 'roof'; break; }
    }
    if (beads) this.apex = top;
    return { x, y, z, t: i * STEP, what };
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game;
    if (!this.installed && g.player) this.install();
    this.clock += dt;
    for (const s of this.sites) this.animate(s, dt);
    if (this.flight) this.track(dt);
    if (this.mode === 'idle' && this.prompting && g.state !== 'play') { g.hud.prompt(null); this.prompting = false; }
    this.touchButtons();
  }

  /** Runs inside Player.update, before it: while she is in a machine the player code sits the frame out. */
  private install(): void {
    this.installed = true;
    const pl = this.game.player as unknown as { update(dt: number): void };
    const orig = pl.update.bind(pl);
    pl.update = (dt: number): void => { if (!this.control(dt)) orig(dt); };
  }

  /** True while she is in a machine (the player's own update is skipped). */
  private control(dt: number): boolean {
    const g = this.game, p = g.player, inp = g.input;
    if (this.mode === 'idle') {
      if (this.flight || p.vehicle || !p.canFight || p.ragdolled) { this.unprompt(); return false; }
      const s = this.nearest();
      if (!s) { this.unprompt(); return false; }
      const what = s.kind === 'cannon' ? (s.roof ? 'Ride up and get in the parcel cannon' : 'Climb into the cannon') : s.kind === 'trebuchet' ? 'Sit in the trebuchet sling' : 'Climb into the catapult';
      g.hud.prompt(`[F] ${what} · ${s.name}`); this.prompting = true;
      // F, or the touch USE button (interact), which appears with any prompt.
      if (inp.hit('enter') || inp.hit('interact')) { inp.eat('enter'); inp.eat('interact'); this.mount(s); }
      return false;
    }
    const s = this.cur!;
    // Read the presses, then eat them so nothing else (weapons, the car door) reacts this frame.
    const fireKey = inp.hit('enter') || inp.hit('jump') || this.firePressed;
    const outKey = inp.hit('interact') || this.outPressed;
    for (const a of ['enter', 'jump', 'interact', 'prevWeapon', 'nextWeapon', 'fire', 'aim'] as const) inp.eat(a);
    this.firePressed = false; this.outPressed = false;
    if (this.mode === 'aim') {
      const k = inp as unknown as { keys?: Set<string> };
      const keys = k.keys;
      const q = keys?.has('KeyQ') ? 1 : 0, e = keys?.has('KeyE') ? 1 : 0;
      s.aimV = clamp(s.aimV + inp.moveY * dt * (s.v1 - s.v0) * 0.45, s.v0, s.v1);
      const dh = clamp(s.aimH - s.h - inp.moveX * dt * 0.5, -0.45, 0.45);
      s.aimH = s.h + dh;
      s.aimP = clamp(s.aimP + (e - q) * dt * 0.5, s.p0, s.p1);
      inp.moveX = 0; inp.moveY = 0;
      this.seat(s, 0);
      this.preview(s);
      const pw = Math.round(((s.aimV - s.v0) / (s.v1 - s.v0)) * 100), deg = Math.round((s.aimP * 180) / Math.PI);
      const est = this.est;
      g.hud.prompt(`[F] Fire · power ${pw}% (W/S) · angle ${deg}° (Q/E) · aim A/D · about ${Math.round(est * FEET)} ft · G climbs out`);
      this.prompting = true;
      if (fireKey) { this.mode = 'windup'; this.t = 0; this.fused = false; this.dots.visible = false; this.landMark.visible = false; this.windStart(s); }
      else if (outKey) this.dismount(s);
      return true;
    }
    // Wind-up.
    inp.moveX = 0; inp.moveY = 0;
    this.t += dt;
    this.seat(s, this.t);
    if (this.windDone(s)) this.fire(s);
    return true;
  }

  private firePressed = false;
  private outPressed = false;
  private est = 0;
  private apex = 0;

  private nearest(): Site | null {
    const p = this.game.player;
    for (const s of this.sites) {
      const mx = s.booth ? s.booth.x : s.x, mz = s.booth ? s.booth.z : s.z;
      const r = s.booth ? 2.2 : s.kind === 'trebuchet' ? MOUNT_R + 2.4 : MOUNT_R;
      if (Math.abs(p.x - mx) < r + 1 && Math.abs(p.z - mz) < r + 1 && Math.hypot(p.x - mx, p.z - mz) < r && Math.abs(p.y - (s.booth ? groundAt(mx, mz) : s.y)) < 2.5) return s;
    }
    return null;
  }

  private unprompt(): void { if (this.prompting) { this.game.hud.prompt(null); this.prompting = false; } }

  private mount(s: Site): void {
    const g = this.game;
    this.cur = s; this.mode = 'aim';
    s.aimH = s.h; s.aimP = s.pitch; s.aimV = s.v0 + (s.v1 - s.v0) * s.power;
    s.reset = 0; s.arm = s.rest;
    this.aimKey = '';
    this.seat(s, 0);
    if (!g.view) {
      this.ownView = true;
      g.view = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    }
    this.frame(s);
    g.hud.toast(s.kind === 'cannon' ? `${s.name}. W/S power, A/D aim, Q/E angle, F to light the fuse.` : `${s.name}. W/S power, A/D aim, Q/E angle, F to let go.`, 4.5);
  }

  private dismount(s: Site): void {
    const g = this.game, per = g.player.person;
    this.mode = 'idle'; this.cur = null;
    this.dots.visible = false; this.landMark.visible = false;
    per.visible = true;
    const fx = Math.sin(s.h), fz = Math.cos(s.h);
    if (s.booth) g.player.teleport(s.booth.x + Math.sin(s.booth.h) * 1.4, s.booth.z + Math.cos(s.booth.h) * 1.4, s.booth.h);
    else { const side = s.kind === 'trebuchet' ? 3.2 : 2.6; g.player.teleport(s.x + fz * side - fx * 1.5, s.z - fx * side - fz * 1.5, s.h); }
    this.releaseView();
    this.unprompt();
  }

  private releaseView(): void { if (this.ownView) { this.game.view = null; this.ownView = false; this.game.cam.snap(); } }

  /** Camera behind the machine, looking along the aim, high enough to see the arc. */
  private frame(s: Site): void {
    const v = this.game.view;
    if (!v || !this.ownView) return;
    const fx = Math.sin(s.aimH), fz = Math.cos(s.aimH);
    // Far enough back and high enough that the whole arc, apex to landing ring, is in the picture.
    const d = clamp(this.est, 30, 160), rise = Math.max(4, this.apex - s.y);
    const back = (s.kind === 'trebuchet' ? 16 : 9) + d * 0.07, up = (s.kind === 'trebuchet' ? 7 : 4) + rise * 0.25;
    v.pos.set(s.x - fx * back + fz * 3, s.y + up, s.z - fz * back - fx * 3);
    v.target.set(s.x + fx * d * 0.42, s.y + rise * 0.6, s.z + fz * d * 0.42);
  }

  /** Dess in the machine: hidden in the barrel, or sat in the sling or bucket wherever the arm has got to. */
  private seat(s: Site, t: number): void {
    const per = this.game.player.person;
    const fx = Math.sin(s.aimH), fz = Math.cos(s.aimH);
    s.root.rotation.y = s.aimH;
    if (s.kind === 'cannon') {
      s.mover.rotation.x = -s.aimP;
      this.launchPoint(s, this.L);
      per.x = this.L.x - fx * 1.2; per.z = this.L.z - fz * 1.2; per.y = this.L.y - 1.0;
      per.visible = false;
    } else {
      const a = s.arm;
      const L = s.kind === 'trebuchet' ? 7.5 : 4.2, py = s.kind === 'trebuchet' ? 6 : 0.9, pz = s.kind === 'trebuchet' ? 0 : -0.6;
      const up = py + Math.cos(a) * L, fwd = pz + Math.sin(a) * L;
      per.x = s.x + fx * fwd; per.z = s.z + fz * fwd; per.y = s.y + up - 0.55;
      per.visible = true;
      per.pose = 'sit'; per.bench = true;
    }
    per.h = s.aimH; per.speed = 0;
    void t;
  }

  private preview(s: Site): void {
    const key = `${s.aimH.toFixed(4)}|${s.aimP.toFixed(4)}|${s.aimV.toFixed(3)}`;
    if (key === this.aimKey) { this.frame(s); return; }
    this.aimKey = key;
    this.launchPoint(s, this.L);
    const r = this.simulate(this.L, s.aimH, s.aimP, s.aimV, true);
    this.est = Math.hypot(r.x - s.x, r.z - s.z);
    for (let i = 0; i < DOTS; i++) {
      if (i < this.nPts) {
        const sc = 1 - (i / this.nPts) * 0.45;
        this.m4.makeScale(sc, sc, sc).setPosition(this.pts[i * 3], this.pts[i * 3 + 1], this.pts[i * 3 + 2]);
        this.dots.setMatrixAt(i, this.m4);
      } else this.dots.setMatrixAt(i, this.hidden);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.visible = true;
    this.landMark.position.set(r.x, r.y + 0.12, r.z);
    this.landMark.visible = true;
    this.frame(s);
  }

  // ── Wind-up and firing ───────────────────────────────────────────────────────

  private place(x: number, y: number, z: number, ref: number): { in: AudioNode; lag: number; core: AudioCore } | null {
    const core = this.game.audio?.core;
    if (!core) return null;
    const sp = core.place(x, y, z, { ref, max: 900, wet: 0.3 });
    return sp ? { in: sp.in, lag: sp.lag, core } : null;
  }

  private windStart(s: Site): void {
    if (s.kind === 'cannon') {
      const a = this.place(s.x, s.y + 1, s.z, 8);
      if (a) fuseHiss(a.core, a.core.now + a.lag, a.in, 1.5);
    } else if (s.kind === 'trebuchet') {
      const a = this.place(s.x, s.y + 5, s.z, 14);
      if (a) creak(a.core, a.core.now + a.lag, a.in, 1.3, 0.8);
    } else {
      const a = this.place(s.x, s.y + 1, s.z, 10);
      if (a) ratchet(a.core, a.core.now + a.lag, a.in, 0.7, 7);
    }
  }

  /** Advances the wind-up; true at the moment of release. */
  private windDone(s: Site): boolean {
    const g = this.game, t = this.t;
    if (s.kind === 'cannon') {
      // The fuse: sparks running along the touch hole.
      if (t < 1.5 && Math.floor(t * 20) !== Math.floor((t - g.dt) * 20)) {
        const bx = s.x - Math.sin(s.aimH) * 1.1, bz = s.z - Math.cos(s.aimH) * 1.1;
        g.fx?.emitters.sparks(bx, s.y + (s.roof ? 2.4 : 2.3), bz, 0, 1, 0, 2, 2.5);
      }
      return t >= 1.5;
    }
    if (s.kind === 'trebuchet') {
      // The counterweight falls: the arm accelerates like a pendulum let go of.
      const u = clamp(t / 1.15, 0, 1), e = u * u * (3 - 2 * u) * 0.35 + u * u * 0.65;
      s.arm = s.rest + (0.95 - s.rest) * e;
      s.mover.rotation.x = s.arm;
      return s.arm >= 0.5;
    }
    // Catapult: wound a touch further back for 0.7 s, then let go.
    if (t < 0.7) { s.arm = s.rest - 0.12 * (t / 0.7); s.mover.rotation.x = s.arm; return false; }
    const u = clamp((t - 0.7) / 0.22, 0, 1);
    s.arm = s.rest - 0.12 + (0.12 + 0.12 - s.rest) * u * u;
    s.mover.rotation.x = s.arm;
    return s.arm >= -0.1;
  }

  private fire(s: Site): void {
    const g = this.game, p = g.player, per = p.person;
    this.mode = 'idle'; this.cur = null;
    this.launchPoint(s, this.L);
    const L = this.L, k = per.look.height || 1;
    const fx = Math.sin(s.aimH), fz = Math.cos(s.aimH);
    const ch = Math.cos(s.aimP), vy = Math.sin(s.aimP) * s.aimV, vh = ch * s.aimV;
    per.visible = true; per.bench = false; per.pose = 'stand';
    per.x = L.x; per.z = L.z; per.y = L.y - (HIP + COM_Y) * k;
    this.releaseView();
    this.unprompt();
    // The ragdoll, through the player (she is tumbling until it lands). knockDown makes up a tumble from the speed;
    // trade most of its somersault for a calmer, readable one and a twist.
    p.knockDown(fx * vh, fz * vh, vy);
    const rag = g.people.rag;
    if (!rag.flying(per)) { g.hud.toast('The machine jammed. Nobody was harmed, nobody was launched.', 3); return; }
    const t0 = 1 + vh * 0.3, want = 3 + Math.random() * 3, d = want - t0;
    rag.launch(per, 0, 0, 0, -fz * d, (Math.random() - 0.5) * 4, fx * d);
    s.reset = 3.5;
    this.flight = { site: s, sx: s.x, sz: s.z, t: 0, touched: false, dist: 0, bounces: 0, prevY: per.y, where: '', score: -1 };
    this.stats.fired++;
    save.bump('launchFired');
    // Effects.
    const fxs = g.fx?.emitters;
    if (s.kind === 'cannon') {
      if (fxs) {
        fxs.explosion(L.x + fx * 0.6, L.y - 0.6, L.z + fz * 0.6, 0.42);
        fxs.muzzleFlash(L.x, L.y, L.z, fx * ch, Math.sin(s.aimP), fz * ch);
        fxs.sparks(L.x, L.y, L.z, fx * ch, Math.sin(s.aimP), fz * ch, 18, 14);
      }
      const a = this.place(L.x, L.y, L.z, 30);
      if (a) fwBoom(a.core, a.core.now + a.lag, a.in, 1.25);
      g.cam.shake(0.7);
      // Recoil: the barrel kicks back up a little.
      s.mover.rotation.x = -s.aimP - 0.12;
    } else {
      const a = this.place(L.x, L.y, L.z, 14);
      if (a) { whoosh(a.core, a.core.now + a.lag, a.in); if (s.kind === 'catapult') thwack(a.core, a.core.now + a.lag + 0.06, a.in); }
      if (s.kind === 'catapult') g.cam.shake(0.25);
    }
  }

  /** The arms after a throw: the trebuchet swings through and settles, then both are wound back. */
  private animate(s: Site, dt: number): void {
    if (s.ring && s.target === 'float') s.ring.position.y = waterLevelAt(s.tx, s.tz) + Math.sin(this.clock * 1.3) * 0.12;
    if (s === this.cur || s.reset <= 0) return;
    s.reset -= dt;
    if (s.kind === 'cannon') {
      // Recoil, easing back down.
      s.mover.rotation.x = -s.aimP + (s.mover.rotation.x + s.aimP) * Math.exp(-4 * dt);
    } else if (s.kind === 'trebuchet') {
      const top = 0.95;
      if (s.reset > 2.0) { const u = 3.5 - s.reset; s.arm = top + Math.sin(u * 3.2) * 0.35 * Math.exp(-u * 1.6); }
      else s.arm = s.rest + (top - s.rest) * Math.max(0, s.reset / 2.0);
      s.mover.rotation.x = s.arm;
    } else {
      const stop = 0.12;
      s.arm = s.reset > 2.6 ? stop : s.rest + (stop - s.rest) * Math.max(0, s.reset / 2.6);
      s.mover.rotation.x = s.arm;
    }
    if (s.reset <= 0) {
      s.arm = s.rest; s.aimH = s.h; s.aimP = s.pitch; s.root.rotation.y = s.h;
      s.mover.rotation.x = s.kind === 'cannon' ? -s.pitch : s.rest;
    }
  }

  // ── The flight ───────────────────────────────────────────────────────────────

  private track(dt: number): void {
    const g = this.game, f = this.flight!, per = g.player.person, rag = g.people.rag;
    f.t += dt;
    const flying = rag.flying(per);
    if (flying) {
      const x = per.x, z = per.z, y = per.y, fl = groundAt(x, z), wl = waterLevelAt(x, z), vy = (y - f.prevY) / Math.max(dt, 1e-4);
      // A building top under her that she has just come down onto (the ragdoll's own floor is the street).
      let top = -1e9;
      if (vy < -0.5) g.col.forBoxes(x, z, 0.5, (b) => {
        if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && b.y1 > fl + 2.5 && f.prevY >= b.y1 - 0.4 && y <= b.y1 + 0.5 && b.y1 > top) top = b.y1;
      });
      const onRoof = top > -1e8;
      if (!f.touched) {
        if (onRoof) this.touch(f, 'roof', x, z);
        else if (fl < wl - 0.4 && y < wl + 0.1) this.touch(f, 'water', x, z);
        else if (y < fl + 0.25) this.touch(f, /beach|strand/i.test(g.plan.placeName(x, z)) ? 'beach' : 'ground', x, z);
      }
      // Roofs bounce her, twice at most; after that the ragdoll's walls see her off the edge.
      if (onRoof && f.bounces < 2) {
        f.bounces++; this.stats.bounces++;
        rag.launch(per, 0, Math.min(9, 2.5 - vy * 0.45), 0, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 6);
        g.fx?.emitters.dust(x, top + 0.2, z, 0, 0, 1.2, false);
        const a = this.place(x, top, z, 12);
        if (a) thwack(a.core, a.core.now + a.lag, a.in, true);
      }
    }
    f.prevY = per.y;
    if (!flying || f.t > 25) {
      this.flight = null;
      if (!f.touched) this.touch(f, 'ground', per.x, per.z);
      this.report(f);
    }
  }

  private touch(f: Flight, where: string, x: number, z: number): void {
    f.touched = true; f.where = where;
    f.dist = Math.hypot(x - f.sx, z - f.sz);
    this.stats.touched++; this.stats.last = where; this.stats.lastDist = f.dist; this.stats.lastScore = -1;
    if (f.dist > this.stats.far) this.stats.far = f.dist;
    if (Math.round(f.dist) > save.count('launchFar')) save.data.counts.launchFar = Math.round(f.dist);
    const s = f.site;
    if (s.target) {
      const d = Math.hypot(x - s.tx, z - s.tz);
      const ring = RINGS.findIndex((r) => d < r);
      f.score = ring;
      this.stats.lastScore = ring;
      if (ring >= 0) {
        const g = this.game;
        g.player.money += PRIZE[ring];
        if (ring === 0) { this.stats.bulls++; save.bump('launchBulls'); }
        else this.stats.rings++;
        g.hud.toast(`${ring === 0 ? pickRand(BULL) : pickRand(RING)} +$${PRIZE[ring]}`, 4.5);
        g.fx?.emitters.sparks(x, groundAt(x, z) + 0.5, z, 0, 1, 0, ring === 0 ? 40 : 16, 8);
      }
    }
    if (where === 'beach') this.game.fx?.emitters.dust(x, groundAt(x, z) + 0.2, z, 0, 0, 1.5, true);
  }

  private report(f: Flight): void {
    const g = this.game, ft = Math.round(f.dist * FEET);
    const best = save.count('launchFar') <= Math.round(f.dist) && f.dist > 20;
    const line = pickRand(LANDED[f.where] ?? LANDED.ground);
    // A target hit already had its toast; the distance follows it.
    const delay = f.score >= 0 ? 4.6 : 0;
    const say = (): void => g.hud.toast(`${ft} ft. ${line}${best ? ' A new personal best.' : ''}`, 4.5);
    if (delay > 0) setTimeout(say, delay * 1000); else say();
  }

  // ── Touch ────────────────────────────────────────────────────────────────────

  private touchButtons(): void {
    const coarse = (this.coarse ??= typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    const g = this.game;
    const near = this.mode === 'idle' && !this.flight && g.state === 'play' && !g.player.vehicle && this.prompting;
    const aiming = this.mode === 'aim' && g.state === 'play';
    const want = coarse && (near || aiming);
    if (!want) { if (this.btns && this.btns.style.display !== 'none') this.btns.style.display = 'none'; return; }
    if (!this.btns) {
      const wrap = document.createElement('div');
      Object.assign(wrap.style, { position: 'fixed', right: '92px', top: '34%', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: '30' } as Partial<CSSStyleDeclaration>);
      const mk = (label: string, fn: () => void): HTMLButtonElement => {
        const b = document.createElement('button');
        b.textContent = label;
        Object.assign(b.style, {
          width: '64px', height: '64px', borderRadius: '50%', border: '2px solid rgba(242,232,207,0.85)', background: 'rgba(122,20,24,0.6)',
          color: '#f2e8cf', fontSize: '12px', fontWeight: 'bold', touchAction: 'none',
        } as Partial<CSSStyleDeclaration>);
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        wrap.appendChild(b);
        return b;
      };
      const go = mk('LAUNCH', () => {
        if (this.mode === 'aim') this.firePressed = true;
        else if (this.mode === 'idle') { const s = this.nearest(); if (s && !g.player.vehicle && g.player.canFight) this.mount(s); }
      });
      const out = mk('OUT', () => { this.outPressed = true; });
      out.style.background = 'rgba(20,33,61,0.55)';
      (wrap as unknown as { go: HTMLButtonElement; out: HTMLButtonElement }).go = go;
      (wrap as unknown as { go: HTMLButtonElement; out: HTMLButtonElement }).out = out;
      document.body.appendChild(wrap);
      this.btns = wrap;
    }
    const w = this.btns as unknown as { go: HTMLButtonElement; out: HTMLButtonElement };
    w.go.textContent = aiming ? 'FIRE' : 'LAUNCH';
    w.out.style.display = aiming ? '' : 'none';
    if (this.btns.style.display === 'none') this.btns.style.display = 'flex';
  }

  // ── Tools ────────────────────────────────────────────────────────────────────

  /** Test hook: mount a machine by id. */
  testMount(id: string): boolean {
    const s = this.sites.find((o) => o.id === id);
    if (!s || this.mode !== 'idle') return false;
    this.mount(s);
    return true;
  }
  /** Test hook: set the aim (power share 0..1, pitch radians, heading offset) of the machine she is in. */
  testAim(power: number, pitch?: number, dh = 0): void {
    const s = this.cur;
    if (!s) return;
    s.aimV = s.v0 + (s.v1 - s.v0) * clamp(power, 0, 1);
    if (pitch !== undefined) s.aimP = clamp(pitch, s.p0, s.p1);
    s.aimH = s.h + clamp(dh, -0.45, 0.45);
  }
  /** Test hook: aim the machine she is in at its target's centre (the nearest of a grid of aims). */
  testAimTarget(): number {
    const s = this.cur;
    if (!s || !s.target) return -1;
    let bd = 1e9, bp = s.power, bh = 0;
    this.launchPoint(s, this.L);
    for (let p = 0; p <= 1.0001; p += 0.01) for (let dh = -0.4; dh <= 0.4001; dh += 0.02) {
      const r = this.simulate(this.L, s.h + dh, s.aimP, s.v0 + (s.v1 - s.v0) * p, false);
      const d = Math.hypot(r.x - s.tx, r.z - s.tz);
      if (d < bd) { bd = d; bp = p; bh = dh; }
    }
    this.testAim(bp, s.aimP, bh);
    return bd;
  }
  testFire(): void { if (this.mode === 'aim') this.firePressed = true; }
  get state(): string { return this.flight ? 'flight' : this.mode; }
}
