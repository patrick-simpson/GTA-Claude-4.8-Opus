// Weapons, aiming and what they do to things.
//
// One system does the lot, because every part reads the same few facts: what
// she is holding, where it points, and what a line through the world meets
// first. Bullets are hitscan: a ray from the camera through the reticle finds
// the point being looked at, and the round then flies from the muzzle to that
// point, so a wall beside her stops the bullet and not the picture. The ray is
// tested against the buildings (collide.raycast), the ground, each vehicle as
// a box turned to its heading, and each person as an upright cylinder.
//
// Everything a shot needs is scratch storage on the class: firing allocates
// nothing, including the two event objects, which are reused (listeners copy
// what they keep).
//
// Damage to people goes through the walkers' own knock-down state in
// sim/peds.ts (nobody is hurt in detail: they stagger, run, or lie down and
// stay there). Vehicles lose health; under 20 the engine burns, then the car
// goes up and is left as a wreck. The same blast serves the launcher.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import type { FireHandle, P3 } from '../fx/particles';
import type { Peds } from '../sim/peds';
import type { RayHit } from '../world/collide';
import { RNG, angleDiff, clamp, clamp01, damp, lerp } from '../core/util';
import { WATER_Y, groundAt } from '../world/plan';
import type { Aimable } from './character';

export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'launcher';

export interface WeaponSpec {
  id: WeaponId;
  /** Invented names only. No real makes. */
  name: string;
  /** What the requisition slip calls it. */
  note: string;
  /** Usable from a car window. */
  oneHand: boolean;
  /** Fires for as long as the trigger is held. */
  auto: boolean;
  mag: number;
  /** Most spare rounds she can carry. */
  reserve: number;
  /** Seconds to reload. */
  reload: number;
  /** Rounds (or punches) a minute. */
  rpm: number;
  /** Cone half-angle in radians: aimed, and from the hip. */
  spread: number; hip: number;
  pellets: number;
  /** Per pellet, at close range. */
  damage: number;
  /** Full damage out to `near` meters, falling to `floor` of it at `far`. */
  near: number; far: number; floor: number;
  range: number;
  /** Camera kick per shot, radians. */
  kick: number;
  /** Hand to muzzle, meters. */
  len: number;
}

export const WEAPONS: readonly WeaponSpec[] = [
  { id: 'fists', name: 'Bare Hands', note: 'Issued at birth', oneHand: true, auto: false, mag: 0, reserve: 0, reload: 0, rpm: 140, spread: 0, hip: 0, pellets: 0, damage: 24, near: 1.5, far: 1.5, floor: 1, range: 1.5, kick: 0, len: 0 },
  { id: 'pistol', name: 'Paperweight', note: 'Sidearm, desk', oneHand: true, auto: false, mag: 12, reserve: 120, reload: 1.3, rpm: 330, spread: 0.006, hip: 0.035, pellets: 1, damage: 26, near: 25, far: 90, floor: 0.5, range: 140, kick: 0.012, len: 0.2 },
  { id: 'smg', name: 'Stapler', note: 'Fastener, rapid', oneHand: true, auto: true, mag: 30, reserve: 240, reload: 1.9, rpm: 720, spread: 0.016, hip: 0.06, pellets: 1, damage: 13, near: 15, far: 70, floor: 0.35, range: 110, kick: 0.006, len: 0.4 },
  { id: 'shotgun', name: 'Gull Duster', note: 'Pest control, loud', oneHand: false, auto: false, mag: 6, reserve: 48, reload: 2.6, rpm: 70, spread: 0.055, hip: 0.09, pellets: 8, damage: 11, near: 8, far: 45, floor: 0.1, range: 60, kick: 0.04, len: 0.62 },
  { id: 'launcher', name: 'Strongly Worded Letter', note: 'Correspondence, final', oneHand: false, auto: false, mag: 1, reserve: 8, reload: 3, rpm: 30, spread: 0.004, hip: 0.03, pellets: 1, damage: 150, near: 0, far: 0, floor: 1, range: 0, kick: 0.05, len: 0.55 },
];

/** Vehicles take this share of a bullet's damage: a sedan is nine pistol rounds from catching fire. */
export const CAR_SHARE = 0.36;
/** Under this health the engine burns; this long after, it goes up. */
const BURN_AT = 20, FUSE = 4.5;
const BLAST_R = 9, BLAST_DMG = 120;
/** A wreck is tidied away once she is this far from it. */
const WRECK_FAR = 150;
/**
 * Multiplayer: a car this browser is only shown gets its fire once she is this near, and loses it again past the
 * second distance (fx/particles.ts draws no fire beyond 200 m anyway). A town can have fires all over it; the few
 * fire emitters there are belong to the ones she can see.
 */
const FIRE_NEAR = 220, FIRE_FAR = 260;
const ROCKET_V = 42;
export const ROCKET_G = 7;
/** The mode number sim/peds.ts uses for "lying in the road". It is not exported; keep in step with it. */
const PED_DOWN = 5;
/** Drive-by: the window arcs, as radians of camera heading away from the car's nose. */
const ARC_MIN = 0.45, ARC_MAX = 2.7;

const NONE = 0, WALL = 1, GROUND = 2, WATER = 3, CAR = 4, BODY = 5;

type Walker = Peds['walkers'][number];
type Wreckable = Vehicle;
interface Burn { v: Vehicle; fire: FireHandle; t: number; done: boolean }
const NO_CARS: readonly Vehicle[] = [];

/** The paint of a burnt out car. */
const WRECK_COLOR = 0x15130f;
const paintWas = new WeakMap<Vehicle, number>();
/**
 * Burnt out: black, dead, lamps off (vehicle.ts draws the soot). The ONE place a car is made a wreck: the fire here
 * does it, and so does the network when another browser says a car it shows has burnt out (net/shared.ts, remote.ts).
 */
export function charCar(v: Vehicle): void {
  if (!v.wreck) paintWas.set(v, v.color);
  v.wreck = true; v.health = 0; v.color = WRECK_COLOR; v.lights = false;
}
/** The colour a car left the factory in: its own, or what it was before it burnt (the network names a car by it). */
export function paintOf(v: Vehicle): number {
  return v.wreck ? paintWas.get(v) ?? v.color : v.color;
}
interface Rocket { mesh: THREE.Mesh; live: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }
interface Pickup { x: number; y: number; z: number; slot: number; ammo: number; mesh: THREE.Object3D; wait: number; where: string }

function box(parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/**
 * Multiplayer (src/net/fight.ts): what the weapons ask of the town, and tell it. Null in a game with nobody else in
 * it, and then none of it is ever called.
 */
export interface WeaponsNet {
  /** The other players' cars: drawn and solid, but not in vehicles.list. A round can strike them all the same. */
  cars(): readonly Vehicle[];
  /** Is this body another player's? (Their own browser decides what becomes of them.) */
  isPlayer(p: Person): boolean;
  /** A round or a fist of this player's has found somebody. False when they are not another player. */
  hitPlayer(p: Person, dmg: number, dx: number, dz: number, fist: boolean): boolean;
  /** A round has struck a car. False when the car is this browser's own to dent; true when its owner has been told instead. */
  hitCar(v: Vehicle, dmg: number): boolean;
  /** One of the rounds the others are shown: the weapon, what it met (the numbers of ShotEnd in net/protocol.ts) and where. */
  shot(slot: number, end: number, x: number, y: number, z: number): void;
  /** A punch thrown. */
  swing(): void;
  rocket(x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
  /** Something has gone off on this browser. by: the player whose doing it was, when not this one (their number; 0 = nobody else's). */
  blast(x: number, y: number, z: number, radius: number, damage: number, by: number): void;
  /** Is this browser the one that counts what happens to the town's cars and people? */
  hostsTown(): boolean;
  /** Is no other player within r meters of here who is shown this browser's cars? (A wreck is not tidied away under somebody's nose.) */
  nobodyNear(x: number, z: number, r: number): boolean;
}

let gunMats: { dark: THREE.Material; grip: THREE.Material; band: THREE.Material } | null = null;
function mats(): { dark: THREE.Material; grip: THREE.Material; band: THREE.Material } {
  return gunMats ?? (gunMats = {
    dark: new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.65, roughness: 0.42 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x6b4a2e, metalness: 0, roughness: 0.7 }),
    band: new THREE.MeshStandardMaterial({ color: 0xf0a202, metalness: 0.1, roughness: 0.6 }),
  });
}

/** The model of a weapon, built along +Z from the hand like every model in the game. Null for bare hands. The other players' are made here too. */
export function makeGun(id: WeaponId): THREE.Group | null {
  if (id === 'fists') return null;
  const { dark, grip, band } = mats();
  const g = new THREE.Group();
  if (id === 'pistol') {
    box(g, dark, 0.034, 0.046, 0.2, 0, 0.03, 0.09);
    box(g, grip, 0.03, 0.1, 0.045, 0, -0.035, 0.01).rotation.x = 0.25;
  } else if (id === 'smg') {
    box(g, dark, 0.05, 0.075, 0.3, 0, 0.03, 0.12);
    box(g, dark, 0.022, 0.022, 0.12, 0, 0.04, 0.33);
    box(g, dark, 0.03, 0.16, 0.04, 0, -0.08, 0.16);
    box(g, grip, 0.032, 0.09, 0.04, 0, -0.04, 0.0).rotation.x = 0.25;
    box(g, dark, 0.02, 0.03, 0.2, 0, 0.04, -0.13);
  } else if (id === 'shotgun') {
    box(g, dark, 0.036, 0.036, 0.62, 0, 0.04, 0.3);
    box(g, dark, 0.03, 0.03, 0.5, 0, 0.004, 0.27);
    box(g, grip, 0.052, 0.05, 0.17, 0, 0, 0.3);
    box(g, grip, 0.04, 0.085, 0.26, 0, -0.01, -0.12).rotation.x = -0.12;
  } else {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.95, 10), dark);
    tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.1, 0.08);
    g.add(tube);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 10), band);
    ring.rotation.x = Math.PI / 2; ring.position.set(0, 0.1, 0.5);
    g.add(ring);
    box(g, grip, 0.03, 0.1, 0.04, 0, 0, 0.02);
    box(g, dark, 0.03, 0.06, 0.03, 0, 0.18, 0.2);
  }
  g.visible = false;
  return g;
}

let rocketGeo: THREE.BoxGeometry | null = null, rocketMat: THREE.Material | null = null;
/** A rocket in flight: one shape and one material for every one there will ever be. */
export function makeRocket(): THREE.Mesh {
  rocketGeo ??= new THREE.BoxGeometry(0.11, 0.11, 0.5);
  rocketMat ??= new THREE.MeshStandardMaterial({ color: 0xf2e8cf, emissive: 0xe4572e, emissiveIntensity: 1.5, roughness: 0.6 });
  const mesh = new THREE.Mesh(rocketGeo, rocketMat);
  mesh.visible = false;
  return mesh;
}

export class Weapons {
  /** Which weapons she has, the rounds in each magazine and the spares, by slot (index into WEAPONS). */
  readonly owned = [true, false, false, false, false];
  readonly mags = [0, 0, 0, 0, 0];
  readonly spare = [0, 0, 0, 0, 0];
  slot = 0;
  /** Holding the aim key, on foot, able to. The camera and the player read this. */
  aiming = false;
  /** 0 = no reticle, 1 = live, 2 = shown but the shot is not on (drive-by, outside the window's arc). */
  reticle = 0;
  /** Extra spread from sustained fire and from moving, radians. The reticle opens with it. */
  bloom = 0;
  /** 0 when not reloading, else the fraction done. */
  reloading = 0;
  /** game.time of the last round that hit a person or vehicle, and whether it put somebody down. The HUD's hit marker. */
  hitT = -9; hitDown = false;
  /** True while a one-handed weapon can be fired from the car she is driving. */
  driveBy = false;
  /** Counters for the test scripts. */
  readonly stats = { shots: 0, pellets: 0, wall: 0, ground: 0, car: 0, body: 0, lastKind: 0, lastDist: 0, lastDmg: 0, lastX: 0, lastY: 0, lastZ: 0, crimes: 0, shotEvents: 0, blasts: 0 };
  readonly pickups: Pickup[] = [];

  private readonly rng = new RNG(7741);
  private cool = 0;
  private reloadT = 0;
  private raiseT = 0;
  private punchT = -1; private punchHit = false;
  private aimK = 0;
  private crimeT = 0; private alarmT = 0;
  private told = false;

  private readonly guns: (THREE.Group | null)[] = [];
  private readonly burns: Burn[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly mine = new WeakSet<Vehicle>();
  /** Multiplayer: the cars another player's rounds or blast last hurt, and whose (their number in town). */
  private readonly theirs = new WeakMap<Vehicle, number>();
  private walkerOf: Map<Person, Walker> | null = null;
  private peds: Peds | null = null;
  /** Multiplayer: the town (net/fight.ts sets it while there is anybody else in it). */
  net: WeaponsNet | null = null;
  /** Multiplayer host: the player whose blast is being counted here right now (their number in town; 0 = this browser's own doing). */
  private blame = 0;

  // Scratch: muzzle, direction, the last trace, and the reusable events.
  private mx = 0; private my = 0; private mz = 0;
  private dx = 0; private dy = 0; private dz = 1;
  private readonly rh: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };
  private hKind = NONE; private hnx = 0; private hny = 1; private hnz = 0;
  private hCar: Vehicle | null = null; private hBody: Person | null = null;
  private readonly from: P3 = { x: 0, y: 0, z: 0 };
  private readonly to: P3 = { x: 0, y: 0, z: 0 };
  private readonly v3 = new THREE.Vector3();
  private readonly door = { x: 0, z: 0 };
  private readonly evShot = { x: 0, z: 0, loud: true };
  private readonly evCrime = { kind: '', x: 0, z: 0, weight: 1 };
  private readonly evHit = { person: null as unknown as Person, damage: 0, x: 0, z: 0, byPlayer: true, by: 0 };

  constructor(private readonly game: Game) {
    const { dark, band } = mats();
    for (const w of WEAPONS) {
      const g = makeGun(w.id);
      if (g) game.scene.add(g);
      this.guns.push(g);
    }
    for (let i = 0; i < 4; i++) {
      const mesh = makeRocket();
      game.scene.add(mesh);
      this.rockets.push({ mesh, live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 });
    }
    this.placePickups(band, dark);
    // Arrested with the lot on her: the Harbor Patrol keeps it.
    game.on('booked', (e) => { if (e.confiscate) this.clear(); });
  }

  get spec(): WeaponSpec { return WEAPONS[this.slot]; }
  /** The weapon that is up in her hand for anybody to see (its slot), or 0. Multiplayer shows the others this. */
  get raised(): number { return this.slot !== 0 && this.aimK > 0.35 && this.game.player.canFight ? this.slot : 0; }
  get armed(): boolean { return this.slot !== 0; }
  get mag(): number { return this.mags[this.slot]; }
  get reserve(): number { return this.spare[this.slot]; }

  // ── Having weapons ─────────────────────────────────────────────────────────

  /** Hand her a weapon (by id) with spare rounds, and put it in her hand if she had nothing. */
  give(id: WeaponId, ammo: number): void {
    const i = WEAPONS.findIndex((w) => w.id === id);
    if (i <= 0) return;
    const w = WEAPONS[i];
    if (!this.owned[i]) { this.owned[i] = true; this.mags[i] = w.mag; }
    this.spare[i] = Math.min(w.reserve, this.spare[i] + ammo);
    if (this.slot === 0) this.select(i);
  }

  /** The cheat: everything, full. */
  giveAll(): void {
    for (let i = 1; i < WEAPONS.length; i++) { this.owned[i] = true; this.mags[i] = WEAPONS[i].mag; this.spare[i] = WEAPONS[i].reserve; }
    if (this.slot === 0) this.select(1);
  }

  /** Back to bare hands: a reset, or the police taking everything away. */
  clear(): void {
    for (let i = 1; i < WEAPONS.length; i++) { this.owned[i] = false; this.mags[i] = 0; this.spare[i] = 0; }
    this.select(0);
    for (const k of this.pickups) { k.wait = 0; k.mesh.visible = true; }
  }

  select(i: number): void {
    if (i === this.slot || !this.owned[i]) return;
    this.slot = i;
    this.reloadT = 0; this.reloading = 0; this.punchT = -1;
    this.cool = Math.max(this.cool, 0.25);
  }

  private cycle(dir: number): void {
    const n = WEAPONS.length;
    for (let k = 1; k < n; k++) {
      const i = (this.slot + dir * k + n * k) % n;
      if (this.owned[i]) { this.select(i); return; }
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    const g = this.game;
    if (!this.peds) this.findPeds();
    if (g.state === 'play') this.control(dt);
    else { this.aiming = false; this.reticle = 0; }
    this.pose(dt);
    this.flyRockets(dt);
    this.burnCars(dt);
    this.spinPickups(dt);
  }

  private control(dt: number): void {
    const g = this.game, inp = g.input, p = g.player;
    if (inp.wheel !== 0) this.cycle(inp.wheel > 0 ? 1 : -1);
    if (inp.hit('nextWeapon')) this.cycle(1);
    if (inp.hit('prevWeapon')) this.cycle(-1);
    if (inp.digit >= 1 && inp.digit <= WEAPONS.length) this.select(inp.digit - 1);

    const w = this.spec, v = p.vehicle;
    const foot = p.canFight;
    this.driveBy = !!v && this.slot !== 0 && w.oneHand && p.health > 0;
    this.aiming = foot && inp.down('aim');
    if (this.cool > 0) this.cool -= dt;
    if (this.crimeT > 0) this.crimeT -= dt;
    if (this.alarmT > 0) this.alarmT -= dt;
    if (this.raiseT > 0) this.raiseT -= dt;
    this.bloom = Math.max(0, this.bloom - dt * 0.08) * Math.exp(-3 * dt);

    let inArc = true;
    if (this.driveBy && v) {
      const rel = Math.abs(angleDiff(v.h, g.cam.yaw));
      inArc = rel > ARC_MIN && rel < ARC_MAX;
    }
    this.reticle = this.slot === 0 ? 0 : this.driveBy ? (inArc ? 1 : 2) : this.aiming ? 1 : 0;

    // Reloading: asked for, or the trigger pulled on an empty magazine.
    const can = foot || this.driveBy;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      this.reloading = clamp01(1 - this.reloadT / w.reload);
      if (this.reloadT <= 0) {
        const n = Math.min(w.mag - this.mags[this.slot], this.spare[this.slot]);
        this.mags[this.slot] += n; this.spare[this.slot] -= n;
        this.reloading = 0;
      }
    } else if (can && this.slot !== 0 && this.mags[this.slot] < w.mag && this.spare[this.slot] > 0
      && (inp.hit('reload') || (this.mags[this.slot] === 0 && inp.down('fire')))) {
      this.reloadT = w.reload; this.reloading = 0.001;
    }

    if (this.punchT >= 0) this.punch(dt);
    if (!can || this.reloadT > 0 || this.cool > 0) return;
    const pull = w.auto ? inp.down('fire') : inp.hit('fire');
    if (!pull) return;
    if (this.slot === 0) {
      if (!foot) return;
      this.punchT = 0; this.punchHit = false;
      this.cool = 60 / w.rpm;
      return;
    }
    if (this.mags[this.slot] <= 0 || !inArc) return;
    this.cool += 60 / w.rpm;
    this.mags[this.slot]--;
    this.raiseT = 0.8;
    this.aimRay(true);
    if (w.id === 'launcher') this.launch(); else this.shoot(w);
    g.cam.kick(w.kick * (this.aiming ? 1 : 0.6), (this.rng.next() - 0.5) * w.kick * 0.8);
    this.bloom = Math.min(0.03, this.bloom + (w.auto ? 0.0035 : 0.008));
    this.noise(this.mx, this.mz);
  }

  /** A shot was fired here: tell whoever listens, and send the sidewalk running. */
  private noise(x: number, z: number): void {
    const g = this.game;
    this.evShot.x = x; this.evShot.z = z; this.evShot.loud = true;
    this.stats.shotEvents++;
    g.emit('shot', this.evShot);
    if (this.crimeT <= 0) { this.crimeT = 0.5; this.crime('gunfire', x, z, 0.5); }
    if (this.alarmT <= 0) { this.alarmT = 0.6; this.peds?.alarm(x, z, 45); }
  }

  /** weight is in heat levels (see GameEvents.crime): a burst of gunfire is half a level, putting somebody down a level and a half. */
  private crime(kind: string, x: number, z: number, weight: number): void {
    const e = this.evCrime;
    e.kind = kind; e.x = x; e.z = z; e.weight = weight;
    this.stats.crimes++;
    this.game.emit('crime', e);
  }

  // ── Where it points ────────────────────────────────────────────────────────

  /**
   * Fill the muzzle (mx..) and the direction (dx..). With `exact`, the direction is
   * from the muzzle to whatever the middle of the picture is on; without, it is
   * just the way the weapon is held (enough for drawing it).
   */
  private aimRay(exact: boolean): void {
    const g = this.game, p = g.player, per = p.person, cam = g.camera, v = p.vehicle;
    const w = this.spec;
    // The view: the real camera, or the rig's angles while a test has the camera pinned elsewhere.
    let cx: number, cy: number, cz: number;
    const d = this.v3;
    const looking = this.aiming || !!v;
    if (looking && !g.view) {
      cam.getWorldDirection(d);
      cx = cam.position.x; cy = cam.position.y; cz = cam.position.z;
    } else {
      const yaw = looking ? g.cam.yaw : per.h, pitch = looking ? -g.cam.pitch * 0.6 : 0;
      d.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      cx = NaN; cy = 0; cz = 0;
    }
    this.dx = d.x; this.dy = d.y; this.dz = d.z;

    if (v) {
      // Out of the window on the side the camera is looking.
      const side = angleDiff(v.h, g.cam.yaw) > 0 ? -1 : 1;
      this.mx = v.x - Math.cos(v.h) * side * (v.hw + 0.12);
      this.mz = v.z + Math.sin(v.h) * side * (v.hw + 0.12);
      this.my = v.y + Math.min(1.05, v.spec.height * 0.72);
    } else {
      const H = per.look.height, s = Math.sin(per.h), c = Math.cos(per.h);
      // Right shoulder, then an arm's length along the aim.
      const reach = 0.5 * H;
      this.mx = per.x - c * 0.17 + this.dx * (reach + w.len);
      this.my = per.y + 1.4 * H + this.dy * (reach + w.len);
      this.mz = per.z + s * 0.17 + this.dz * (reach + w.len);
    }
    if (!exact || Number.isNaN(cx)) return;
    // Start past her own head, so the ray cannot find the back of it (or the car she is in).
    const t0 = Math.max(0, (this.mx - cx) * this.dx + (this.my - cy) * this.dy + (this.mz - cz) * this.dz) + 0.2;
    const sx = cx + this.dx * t0, sy = cy + this.dy * t0, sz = cz + this.dz * t0;
    const far = Math.max(w.range, 120);
    const t = this.trace(sx, sy, sz, this.dx, this.dy, this.dz, far, v);
    if (t < 1.2) return;
    const ax = sx + this.dx * t - this.mx, ay = sy + this.dy * t - this.my, az = sz + this.dz * t - this.mz;
    const l = Math.hypot(ax, ay, az);
    if (l < 0.5) return;
    this.dx = ax / l; this.dy = ay / l; this.dz = az / l;
  }

  /** Raise the arm, hold the weapon in the hand, keep both pointing along the aim. */
  private pose(dt: number): void {
    const g = this.game, p = g.player, per = p.person as Person & Partial<Aimable>;
    const gun = this.guns[this.slot];
    for (let i = 1; i < this.guns.length; i++) if (i !== this.slot) this.guns[i]!.visible = false;
    const foot = p.canFight && g.state === 'play';
    const up = foot && this.slot !== 0 && (this.aiming || this.raiseT > 0) && this.reloadT <= 0;
    this.aimK = damp(this.aimK, up ? 1 : 0, up ? 16 : 9, dt);
    let k = this.aimK, pitch = 0, two = !this.spec.oneHand;
    if (foot && k > 0.02) { this.aimRay(false); pitch = Math.asin(clamp(this.dy, -1, 1)); }
    if (this.punchT >= 0 && foot) {
      // A jab: out fast, back slower.
      const t = this.punchT / 0.32;
      k = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
      two = false; pitch = 0.05;
    }
    per.aim = foot ? k : 0; per.aimPitch = pitch; per.aimTwo = two;
    if (!gun) return;
    gun.visible = foot && per.visible && this.aimK > 0.35;
    if (!gun.visible) return;
    const L = this.spec.len;
    gun.position.set(this.mx - this.dx * L, this.my - this.dy * L - 0.02, this.mz - this.dz * L);
    this.v3.set(this.mx + this.dx, this.my + this.dy, this.mz + this.dz);
    gun.lookAt(this.v3);
  }

  // ── Fists ──────────────────────────────────────────────────────────────────

  private punch(dt: number): void {
    const g = this.game, per = g.player.person;
    this.punchT += dt;
    if (!this.punchHit && this.punchT >= 0.1) {
      this.punchHit = true;
      const s = Math.sin(per.h), c = Math.cos(per.h);
      let best: Person | null = null, bd = 1.5;
      for (const o of g.people.list) {
        if (o === per || !o.visible || o.pose === 'down' || Math.abs(o.y - per.y) > 1.2) continue;
        const ox = o.x - per.x, oz = o.z - per.z, d = Math.hypot(ox, oz);
        // In front of her: within sixty degrees of the way she faces.
        if (d < bd && ox * s + oz * c > d * 0.5) { bd = d; best = o; }
      }
      this.net?.swing();
      if (best) {
        // (Another player: their own browser decides what the blow did. Here it is a claim.)
        if (!this.net?.hitPlayer(best, this.spec.damage, s, c, true)) this.hurtPerson(best, this.spec.damage, s, c, true);
        g.cam.shake(0.12);
        this.crime('assault', per.x, per.z, 0.5);
      }
    }
    if (this.punchT > 0.32) this.punchT = -1;
  }

  // ── Bullets ────────────────────────────────────────────────────────────────

  private shoot(w: WeaponSpec): void {
    const g = this.game, fx = g.fx.emitters, p = g.player, rng = this.rng;
    const st = this.stats;
    st.shots++;
    fx.muzzleFlash(this.mx, this.my, this.mz, this.dx, this.dy, this.dz);
    const cone = (this.aiming || p.vehicle ? w.spread : w.hip) + this.bloom + Math.min(p.speed, 8) * (p.vehicle ? 0.0012 : 0.003);
    // Two directions square to the aim, to spread the cone over.
    let rx = this.dz, rz = -this.dx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ux = -rz * this.dy, uy = rz * this.dx - rx * this.dz, uz = rx * this.dy;
    for (let i = 0; i < w.pellets; i++) {
      // The sum of two is peaked in the middle: most rounds land near the mark.
      const a = (rng.next() + rng.next() - 1) * cone, b = (rng.next() + rng.next() - 1) * cone;
      let dx = this.dx + rx * a + ux * b, dy = this.dy + uy * b, dz = this.dz + rz * a + uz * b;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl; dy /= dl; dz /= dl;
      const t = this.trace(this.mx, this.my, this.mz, dx, dy, dz, w.range, p.vehicle);
      const hx = this.mx + dx * t, hy = this.my + dy * t, hz = this.mz + dz * t;
      st.pellets++; st.lastKind = this.hKind; st.lastDist = t; st.lastDmg = 0;
      st.lastX = hx; st.lastY = hy; st.lastZ = hz;
      if (i % 3 === 0) {
        this.from.x = this.mx; this.from.y = this.my; this.from.z = this.mz;
        this.to.x = hx; this.to.y = hy; this.to.z = hz;
        fx.tracer(this.from, this.to);
        // The rounds that leave a line here are the ones the others are shown.
        this.net?.shot(this.slot, this.hKind, hx, hy, hz);
      }
      const dmg = w.damage * (t <= w.near ? 1 : lerp(1, w.floor, clamp01((t - w.near) / (w.far - w.near))));
      switch (this.hKind) {
        case WALL: st.wall++; fx.bulletImpact(hx, hy, hz, this.hnx, this.hny, this.hnz); break;
        case GROUND: st.ground++; fx.bulletImpact(hx, hy, hz, 0, 1, 0); fx.dust(hx, hy, hz, 0, 0, 0.7, false); break;
        case WATER: fx.splash(hx, hz, false); break;
        case CAR: {
          const v = this.hCar!;
          st.car++; st.lastDmg = dmg * CAR_SHARE;
          fx.sparks(hx, hy, hz, this.hnx, this.hny + 0.4, this.hnz, 5, 5);
          // (Another player's car, or one of the town's shown here: whoever counts its health is told.)
          if (this.net?.hitCar(v, dmg * CAR_SHARE)) { /* theirs */ }
          else if (!(v as Wreckable).wreck) { v.health = Math.max(0, v.health - dmg * CAR_SHARE); this.mine.add(v); this.theirs.delete(v); }
          this.hitT = g.time; this.hitDown = false;
          if (v.driver === 'ai' && this.crimeT < 0.3) this.crime('shotVehicle', hx, hz, 0.5);
          break;
        }
        case BODY: {
          st.body++; st.lastDmg = dmg;
          fx.dust(hx, hy, hz, dx, dz, 0.6, false);
          this.hitT = g.time;
          // Another player is a person like any other to the Patrol: shooting one is 'shotPerson', if anybody saw.
          // (Whether it put them down is their browser's to say, so it is never 'personDown' here.)
          this.hitDown = this.net?.hitPlayer(this.hBody!, dmg, dx, dz, false) ? false : this.hurtPerson(this.hBody!, dmg, dx, dz, false);
          this.crime(this.hitDown ? 'personDown' : 'shotPerson', hx, hz, this.hitDown ? 1.5 : 1);
          break;
        }
      }
    }
  }

  /**
   * First thing along a ray: wall, ground, sea, vehicle or person. Returns the distance
   * (`max` if nothing) and leaves what it was in hKind, hCar, hBody and the normal.
   */
  private trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, skip: Vehicle | null): number {
    const g = this.game, rh = this.rh;
    this.hKind = NONE; this.hCar = null; this.hBody = null;
    let best = g.col.raycast(ox, oy, oz, dx, dy, dz, max, rh);
    if (best < max) { this.hKind = WALL; this.hnx = rh.nx; this.hny = rh.ny; this.hnz = rh.nz; }

    // The ground, by walking the ray and then closing in on the crossing.
    const step = dy < -0.02 ? 2.5 : 5;
    for (let t = step, prev = 0; prev < best; prev = t, t += step) {
      const tt = Math.min(t, best);
      const floor = Math.max(groundAt(ox + dx * tt, oz + dz * tt), WATER_Y);
      if (oy + dy * tt >= floor) continue;
      let lo = prev, hi = tt;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) * 0.5;
        if (oy + dy * mid < Math.max(groundAt(ox + dx * mid, oz + dz * mid), WATER_Y)) hi = mid; else lo = mid;
      }
      best = lo;
      this.hKind = groundAt(ox + dx * lo, oz + dz * lo) < WATER_Y ? WATER : GROUND;
      this.hnx = 0; this.hny = 1; this.hnz = 0;
      break;
    }

    // (The other players' cars are not in the list: they come second.)
    const others = this.net ? this.net.cars() : null;
    for (let pass = 0; pass < (others ? 2 : 1); pass++) {
      const cars = pass === 0 ? g.vehicles.list : others!;
      for (let i = 0; i < cars.length; i++) {
        const v = cars[i];
        if (v === skip || v.sunk) continue;
        const qx = ox - v.x, qy = oy - (v.y + 0.25), qz = oz - v.z;
        const along = -(qx * dx + qy * dy + qz * dz), R = v.hl + v.hw;
        if (along < -R || along > best + R || qx * qx + qy * qy + qz * qz - along * along > R * R) continue;
        // Into the car's own frame: z along its nose, x to its right.
        const s = Math.sin(v.h), c = Math.cos(v.h);
        const lz = qx * s + qz * c, lx = -qx * c + qz * s;
        const ldz = dx * s + dz * c, ldx = -dx * c + dz * s;
        const top = v.spec.height - 0.25;
        let t0 = 0, t1 = best, axis = -1, sgn = 0;
        // Three slabs. `axis` is the one the ray came in through.
        let ok = true;
        for (let a = 0; a < 3 && ok; a++) {
          const o = a === 0 ? lx : a === 1 ? qy : lz, d = a === 0 ? ldx : a === 1 ? dy : ldz;
          const lo = a === 0 ? -v.hw : a === 1 ? 0 : -v.hl, hi = a === 0 ? v.hw : a === 1 ? top : v.hl;
          if (Math.abs(d) < 1e-7) { if (o < lo || o > hi) ok = false; continue; }
          let ta = (lo - o) / d, tb = (hi - o) / d, sg = -1;
          if (ta > tb) { const x = ta; ta = tb; tb = x; sg = 1; }
          if (ta > t0) { t0 = ta; axis = a; sgn = sg; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) ok = false;
        }
        if (!ok || axis < 0 || t0 >= best) continue;
        best = t0; this.hKind = CAR; this.hCar = v; this.hBody = null;
        if (axis === 1) { this.hnx = 0; this.hny = sgn; this.hnz = 0; }
        else if (axis === 0) { this.hnx = -c * sgn; this.hny = 0; this.hnz = s * sgn; }
        else { this.hnx = s * sgn; this.hny = 0; this.hnz = c * sgn; }
      }
    }

    const a = dx * dx + dz * dz;
    if (a > 1e-9) {
      const me = g.player.person, people = g.people.list;
      for (let i = 0; i < people.length; i++) {
        const o = people[i];
        // Nobody already on the ground is a target.
        if (o === me || !o.visible || o.pose === 'down') continue;
        const qx = ox - o.x, qz = oz - o.z;
        const b = qx * dx + qz * dz, cc = qx * qx + qz * qz - 0.1;
        const disc = b * b - a * cc;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / a;
        if (t < 0 || t >= best) continue;
        const y = oy + dy * t;
        if (y < o.y || y > o.y + (o.pose === 'sit' ? 1.35 : 1.78) * o.look.height) continue;
        best = t; this.hKind = BODY; this.hBody = o; this.hCar = null;
        this.hnx = -dx; this.hny = 0; this.hnz = -dz;
      }
    }
    return best;
  }

  // ── People ─────────────────────────────────────────────────────────────────

  private findPeds(): void {
    for (const s of this.game.systems) {
      const a = s as { peds?: Peds };
      if (a.peds && Array.isArray(a.peds.walkers)) { this.peds = a.peds; break; }
    }
    if (!this.peds) return;
    this.walkerOf = new Map();
    for (const w of this.peds.walkers) this.walkerOf.set(w.p, w);
  }

  /**
   * Hurt somebody who is not the player. Light damage staggers them and they run;
   * more puts them down for a moment; all of it puts them down for good (they are
   * tidied away once nobody is looking, like anyone a car has hit). True if they stay down.
   * (dx, dz) is the way the blow was travelling.
   */
  hurtPerson(per: Person, dmg: number, dx: number, dz: number, fist: boolean, shove = 1): boolean {
    const g = this.game;
    per.health = Math.max(0, per.health - dmg);
    const e = this.evHit;
    e.person = per; e.damage = dmg; e.x = per.x; e.z = per.z; e.by = this.blame;
    g.emit('personHit', e);
    const w = this.walkerOf?.get(per);
    // Multiplayer guest: one of the host's people, shown here. The host is told and decides; this screen shows a first guess.
    if (w && this.peds!.guest) return this.peds!.onHurt?.(per, dmg, dx, dz, fist, shove) ?? per.health <= 0;
    // Somebody else's cast (the police): their owner hears the event and decides.
    if (!w || !w.active) return per.health <= 0;
    const out = per.health <= 0;
    if (out || per.health <= 60 || fist) {
      if (w.spot) { w.spot.n--; w.spot = null; }
      w.mode = PED_DOWN; w.nb = null; w.flee = 0;
      w.hard = out;
      w.timer = out ? 8 : fist ? 2.6 : 1.8;
      w.hitCool = 1.2;
      w.vx = dx * 2.2 * shove; w.vz = dz * 2.2 * shove;
      per.pose = 'down'; per.speed = 0; per.h = Math.atan2(dx, dz);
    } else {
      // A stagger: shoved a step along the shot, then off down the sidewalk with everyone else.
      w.asideX = dx * 1.6; w.asideZ = dz * 1.6; w.asideT = 0.25;
    }
    this.peds!.alarm(per.x, per.z, 16);
    return out;
  }

  // ── Launcher ───────────────────────────────────────────────────────────────

  private launch(): void {
    const r = this.rockets.find((o) => !o.live);
    if (!r) return;
    this.stats.shots++;
    this.game.fx.emitters.muzzleFlash(this.mx, this.my, this.mz, this.dx, this.dy, this.dz);
    r.live = true; r.t = 0;
    r.x = this.mx; r.y = this.my; r.z = this.mz;
    // Lobbed a little above the line of sight, so the drop lands near the mark at middling range.
    r.vx = this.dx * ROCKET_V; r.vy = this.dy * ROCKET_V + 1.6; r.vz = this.dz * ROCKET_V;
    r.mesh.visible = true;
    this.net?.rocket(r.x, r.y, r.z, r.vx, r.vy, r.vz);
  }

  private flyRockets(dt: number): void {
    const g = this.game;
    for (const r of this.rockets) {
      if (!r.live) continue;
      r.t += dt;
      r.vy -= ROCKET_G * dt;
      const sp = Math.hypot(r.vx, r.vy, r.vz), len = sp * dt;
      const dx = r.vx / sp, dy = r.vy / sp, dz = r.vz / sp;
      const t = this.trace(r.x, r.y, r.z, dx, dy, dz, len, g.player.vehicle);
      r.x += dx * t; r.y += dy * t; r.z += dz * t;
      if (this.hKind !== NONE || r.t > 6) {
        r.live = false; r.mesh.visible = false;
        if (this.hKind === WATER) g.fx.emitters.splash(r.x, r.z, true);
        this.explode(r.x - dx * 0.2, r.y - dy * 0.2 + 0.2, r.z - dz * 0.2, BLAST_R, WEAPONS[4].damage, true);
        continue;
      }
      r.mesh.position.set(r.x, r.y, r.z);
      this.v3.set(r.x + dx, r.y + dy, r.z + dz);
      r.mesh.lookAt(this.v3);
      g.fx.emitters.tireSmoke(r.x - dx * 0.4, r.y - dy * 0.4, r.z - dz * 0.4, 0, 0, 0.7);
    }
  }

  // ── Blasts and burning cars ────────────────────────────────────────────────

  /**
   * A blast: damage and a shove for every car and person within `radius`, falling off to nothing at its edge.
   *
   * In a town (multiplayer) each thing has ONE browser that counts what the blast does to it, so nothing is hurt twice:
   * a player and the car they drive, their own; the town's cars and people, the host's. The browser the blast went
   * off on (`from` 0) tells the others; they come here with `from` = that player's number, draw it, and take only
   * their own share. Alone, `from` is 0 and everything is this browser's, as it always was.
   * `culprit`: the other player whose rounds set alight the car that is going up here (0 = none): the others are told,
   * and what the blast does next is theirs too.
   */
  explode(x: number, y: number, z: number, radius: number, damage: number, byPlayer: boolean, from = 0, culprit = 0): void {
    const g = this.game, p = g.player, rng = this.rng, net = this.net;
    this.stats.blasts++;
    g.fx.emitters.explosion(x, y, z, radius / BLAST_R);
    const far = Math.hypot(p.x - x, p.z - z);
    g.cam.shake(clamp(1.3 - far / 40, 0, 1));
    // Somebody else's blast, and this browser is not the town's host: only its own player and car are its business.
    const world = from === 0 || (!!net && net.hostsTown());
    this.blame = from || culprit;

    for (const v of g.vehicles.list) {
      // (A car shown here for the host is the host's to count.)
      if (v.sunk || v.shared || (!world && v !== p.vehicle)) continue;
      let nx = v.x - x, nz = v.z - z;
      const c = Math.hypot(nx, nz), d = Math.max(0, c - v.hw);
      if (d >= radius || Math.abs(v.y - y) > radius) continue;
      const f = 1 - d / radius, wreck = !!(v as Wreckable).wreck;
      if (c > 0.3) { nx /= c; nz /= c; } else { nx = 0; nz = 0; }
      if (!wreck) { v.health = Math.max(0, v.health - damage * f * 0.9); this.hurtBy(v, byPlayer ? 0 : this.blame, byPlayer); }
      // Lighter cars are not thrown farther here: the contract gives no mass. Wrecks only rock.
      const k = f * (wreck ? 3 : 9);
      v.vx += nx * k; v.vz += nz * k; v.vy += 3.2 * f;
      v.yawRate += (rng.next() - 0.5) * 5 * f;
    }
    const me = p.person;
    if (world) for (const o of g.people.list) {
      // (Another player takes their own share on their own browser.)
      if (o === me || !o.visible || net?.isPlayer(o)) continue;
      let nx = o.x - x, nz = o.z - z;
      const d = Math.hypot(nx, nz);
      if (d >= radius || Math.abs(o.y - y) > radius) continue;
      if (d > 0.1) { nx /= d; nz /= d; }
      if (o.pose === 'down') continue;
      // One of the host's people, shown here: the host hears of the blast itself and knocks them down. It is still this player's crime.
      if (this.peds?.guest && this.walkerOf?.has(o)) { if (byPlayer) this.crime('shotPerson', o.x, o.z, 1); continue; }
      const down = this.hurtPerson(o, damage * (1 - d / radius), nx, nz, false, 2.5);
      if (byPlayer) this.crime(down ? 'personDown' : 'shotPerson', o.x, o.z, down ? 1.5 : 1);
    }
    this.blame = 0;
    if (far < radius && Math.abs(p.y - y) < radius) {
      const f = 1 - far / radius;
      const nx = far > 0.1 ? (p.x - x) / far : 0, nz = far > 0.1 ? (p.z - z) / far : 1;
      this.from.x = x; this.from.y = y; this.from.z = z;
      p.hurt(damage * f * (p.vehicle ? 0.2 : 0.7), this.from);
      if (!p.vehicle && f > 0.2) p.knockDown(nx * 9 * f, nz * 9 * f, 2 + 4 * f);
    }
    if (world) this.peds?.alarm(x, z, 50);
    this.evShot.x = x; this.evShot.z = z; this.evShot.loud = true;
    g.emit('shot', this.evShot);
    if (byPlayer) this.crime('explosion', x, z, 2);
    if (from === 0) net?.blast(x, y, z, radius, damage, culprit);
  }

  /** Whose doing a car's damage was, for when it goes up: this player's (mine), or another's (their number in town). The last to hurt it has it. */
  private hurtBy(v: Vehicle, by: number, mine: boolean): void {
    if (mine) { this.mine.add(v); this.theirs.delete(v); }
    else if (by) { this.theirs.set(v, by); this.mine.delete(v); }
  }
  /** Multiplayer (net/fight.ts): another player's rounds have just taken health off this car, here where it is counted. */
  blameCar(v: Vehicle, by: number): void { this.hurtBy(v, by, false); }
  /** Multiplayer: a car this player set alight has gone up on another browser. The crime is the same as alone. */
  blamed(x: number, z: number): void { this.crime('explosion', x, z, 2); }

  /**
   * Fire, the blast and the wreck. A car this browser counts (its own, and every car when alone or the host) burns
   * by the rules here. A car it is only SHOWN (the host's, v.shared; another player's, from net.cars()) gets the same
   * fire from the same health, as the network gives it, and never goes up of its own accord: it is a wreck when its
   * owner says so (charCar, through the network), and the blast is the owner's Blast event.
   */
  private burnCars(dt: number): void {
    const g = this.game, p = g.player, cars = g.vehicles.list, burns = this.burns, net = this.net;
    const others = net ? net.cars() : NO_CARS;
    for (let i = 0; i < cars.length + others.length; i++) {
      const v = (i < cars.length ? cars[i] : others[i - cars.length]) as Wreckable;
      const told = !!v.shared || i >= cars.length;
      if (v.wreck) {
        if (told) continue;
        const dx = v.x - p.x, dz = v.z - p.z;
        if (dx * dx + dz * dz > WRECK_FAR * WRECK_FAR && (!net || net.nobodyNear(v.x, v.z, WRECK_FAR))) { g.vehicles.remove(v); i--; }
        continue;
      }
      if (v.health >= BURN_AT || v.sunk) continue;
      if (told && (v.x - p.x) * (v.x - p.x) + (v.z - p.z) * (v.z - p.z) > FIRE_NEAR * FIRE_NEAR) continue;
      let known = false;
      for (let k = 0; k < burns.length; k++) if (burns[k].v === v) { known = true; break; }
      if (known) continue;
      burns.push({ v, fire: g.fx.emitters.fire(v.x, v.y + 1, v.z, 0.9), t: FUSE + this.rng.range(-0.8, 0.8), done: false });
      if (told) continue;
      if (v.driver === 'ai') {
        // Whoever is at the wheel is out and running well before it goes up.
        v.driver = null;
        v.ctl.accel = 0; v.ctl.steer = 0; v.ctl.handbrake = true; v.ctl.horn = false;
        v.doorPos(-1, this.door);
        this.peds?.spawnDriver(v, this.door.x, this.door.z);
      } else if (v.driver === 'player') {
        g.hud.toast('The engine is on fire. This is not covered. Get out.', 4);
      }
    }
    for (let k = burns.length - 1; k >= 0; k--) {
      const b = burns[k], v = b.v as Wreckable, f = b.fire;
      const shown = cars.indexOf(v) < 0;
      const told = !!v.shared || shown;
      const gone = v.sunk || (shown && others.indexOf(v) < 0);
      b.t -= dt;
      // (A shown car whose owner says it is not alight after all: mended, or another car under the same number. Or she has gone too far off to see it.)
      const out = told && !b.done && ((!v.wreck && v.health >= BURN_AT) || (v.x - p.x) * (v.x - p.x) + (v.z - p.z) * (v.z - p.z) > FIRE_FAR * FIRE_FAR);
      if (gone || (b.done && b.t <= 0) || out) { f.stop(); burns.splice(k, 1); continue; }
      // Over the engine: the front third.
      const s = Math.sin(v.h), c = Math.cos(v.h), at = b.done ? 0 : v.hl * 0.6;
      f.x = v.x + s * at; f.z = v.z + c * at; f.y = v.y + v.spec.height * (b.done ? 0.5 : 0.62);
      if (b.done) continue;
      if (told) {
        // Its owner's browser lights the fuse and says when: from then it burns out here as it does there.
        if (v.wreck) { b.done = true; b.t = 9; f.scale = 1.5; }
        continue;
      }
      if (b.t > 0) continue;

      b.done = true; b.t = 9;
      f.scale = 1.5;
      const inside = v.driver === 'player';
      charCar(v);
      const byPlayer = this.mine.has(v);
      if (inside) {
        // Still at the wheel when it went: most of a health bar, and out through the door the hard way.
        p.hurt(80, null);
        p.exit();
        p.knockDown(-c * 5, s * 5, 4);
      }
      v.driver = null;
      v.vy += 4.5; v.yawRate += (this.rng.next() - 0.5) * 3;
      this.explode(v.x, v.y + 0.7, v.z, BLAST_R, BLAST_DMG, byPlayer, 0, byPlayer ? 0 : this.theirs.get(v) ?? 0);
    }
  }

  /** For the tests: every fire burning here: where, whether the car under it has burnt out, and whether it is one this browser is only shown. */
  burnInfo(): { x: number; z: number; wreck: boolean; told: boolean }[] {
    const cars = this.game.vehicles.list;
    return this.burns.map((b) => ({ x: +b.v.x.toFixed(2), z: +b.v.z.toFixed(2), wreck: !!b.v.wreck, told: !!b.v.shared || cars.indexOf(b.v) < 0 }));
  }

  // ── Pickups ────────────────────────────────────────────────────────────────

  private placePickups(band: THREE.Material, dark: THREE.Material): void {
    const plan = this.game.plan;
    const first = (d: string, side: number, t: number): { x: number; z: number } | null => {
      const b = plan.blocks.find((o) => o.district === d);
      return b ? plan.sidewalkPoint(b.i, b.j, side, t) : null;
    };
    const spots: [string, number, number, { x: number; z: number } | null][] = [
      ['Strand Blvd, by the start', 1, 48, plan.sidewalkPoint(5, 6, 2, 0.3)],
      ['Downtown', 2, 120, first('downtown', 2, 0.5)],
      ['the industrial yards', 3, 24, first('industrial', 0, 0.4)],
      ['the port', 4, 4, first('port', 0, 0.5)],
      ['the arena', 2, 90, first('arena', 2, 0.35)],
    ];
    for (const [where, slot, ammo, at] of spots) {
      if (!at) continue;
      // A stencilled ammunition crate: mustard, two dark straps, turning slowly at knee height.
      const mesh = new THREE.Group();
      box(mesh, band, 0.6, 0.36, 0.4, 0, 0, 0);
      box(mesh, dark, 0.07, 0.38, 0.42, -0.17, 0, 0);
      box(mesh, dark, 0.07, 0.38, 0.42, 0.17, 0, 0);
      const y = groundAt(at.x, at.z) + 0.75;
      mesh.position.set(at.x, y, at.z);
      this.game.scene.add(mesh);
      this.pickups.push({ x: at.x, y, z: at.z, slot, ammo, mesh, wait: 0, where });
    }
  }

  private spinPickups(dt: number): void {
    const g = this.game, p = g.player, t = g.time;
    for (const k of this.pickups) {
      if (k.wait > 0) {
        k.wait -= dt;
        if (k.wait <= 0) k.mesh.visible = true;
        continue;
      }
      const dx = p.x - k.x, dz = p.z - k.z, d2 = dx * dx + dz * dz;
      if (d2 > 14400) continue;
      k.mesh.rotation.y = t * 1.4;
      k.mesh.position.y = k.y + Math.sin(t * 2.2) * 0.08;
      if (d2 > 1.7 || p.vehicle || g.state !== 'play') continue;
      const w = WEAPONS[k.slot];
      this.give(w.id, k.ammo);
      k.wait = 90; k.mesh.visible = false;
      g.hud.toast(this.told ? `Requisitioned: ${w.name}.` : `Requisitioned: ${w.name}. Finders keepers is not a legal doctrine.`, 4);
      this.told = true;
    }
  }
}
