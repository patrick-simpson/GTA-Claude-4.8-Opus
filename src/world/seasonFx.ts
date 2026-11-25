// The year beyond snow (fun queue 2, item 34): mud season, high summer and the fall. It reads the SAME season the sky and the
// trees do (world/season.ts: the town's fact, or the real date in Maine; no new fact key) and its phase, which splits summer into
// mud season (26 March - 30 April), a plain spring and high summer (20 June on), and calls autumn 'fall'. ?season=mud|summer|
// fall|winter pins one for a test. Winter's snow, the Christmas fair, the plough and the snowball fields are not touched.
//
//   Mud season  the kerb ridges along every street are brown road shoulders (fx/snow.ts), with grey old snow in them for the
//               first fortnight; the lawns go grey-green and the open ground brown, the trees are still bare; puddles lie in
//               the gutters and splash (and spatter mud) when a car goes through; the player's car is a little greasy on
//               the pavement, slower and slidier off it, and meets a frost heave here and there (ent/vehicle.ts, heaveAt).
//   Summer      the lawns deepen to a lush green, the evenings run an hour longer (world/sky.ts), tourists in summer clothes
//               fill the downtown and harbour sidewalks (sim/peds.ts) and out-of-state-style cars (bright paints) join the
//               traffic (sim/traffic.ts); ice-cream stands stand on the pier and in the squares; sailboats circle the harbour
//               (a pure function of the town clock, the same on every screen).
//   Fall        the trees' autumn colours and the falling leaves are the existing ones; the lawns go dry and golden, harvest
//               stands of pumpkins and hay stand in the squares and the country verges, leaf-peepers' cars are pulled over at
//               three viewpoints with a couple of people photographing the view, and the traffic carries slow tourist cars.
//
// Everything is cheap: tints on existing materials, one instanced mesh a kind, puddles and viewpoint props only near the
// player, instance buffers written through game.flip. Under ?streets=old the Tepid Falls fixtures are left out.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { Person, WorldPart } from '../core/api';
import type { Prop } from './collide';
import type { CityMaterials } from './materials';
import { groundAt, WATER_Y } from './plan';
import { seaY } from './sea';
import { season, type Phase } from './season';
import { STREETS_NEW } from './streets';
import { LOOKOUT } from './dithersPond';
import { ICE_SPOTS, PUMPKIN_SPOTS, VIEW_SPOTS, BOAT_RINGS, VISITOR_PAINT } from './seasonData';
import type { VehicleKind } from '../ent/vehicleSpecs';
import type { Vehicle } from '../core/api';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ── Code-built models ────────────────────────────────────────────────────────

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

/** A vertex-coloured, non-indexed part, placed. Rotation in YXZ order. */
function part(geo: THREE.BufferGeometry, hex: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  const c = new THREE.Color(hex), n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const box = (w: number, h: number, d: number, hex: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry => part(new THREE.BoxGeometry(w, h, d), hex, x, y, z, rx, ry, rz);

/** An ice-cream stand, 2.6 m wide, front toward +z: a mint kiosk with a striped awning, a cone and two scoops on the roof. */
function iceStand(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  P.push(box(2.6, 1.0, 1.0, 0xf3ead2, 0, 0.5, 0.15));
  P.push(box(2.8, 0.07, 1.25, 0x7fd1b9, 0, 1.04, 0.2));
  P.push(box(2.6, 2.3, 0.12, 0x7fd1b9, 0, 1.15, -0.5));
  P.push(box(0.1, 2.3, 1.1, 0x7fd1b9, 1.25, 1.15, 0.05), box(0.1, 2.3, 1.1, 0x7fd1b9, -1.25, 1.15, 0.05));
  P.push(box(2.9, 0.1, 1.9, 0xf4ead8, 0, 2.32, 0.1));
  for (let i = 0; i < 7; i++) P.push(box(0.4, 0.05, 1.0, i % 2 ? 0xffffff : 0xf06a8f, -1.2 + i * 0.4, 2.05, 0.82, -0.42));
  P.push(part(new THREE.ConeGeometry(0.34, 0.95, 10), 0xd9a65c, 0, 2.95, -0.1, 0, 0, Math.PI));
  P.push(part(new THREE.SphereGeometry(0.34, 10, 8), 0xf6a5c0, 0, 3.55, -0.1), part(new THREE.SphereGeometry(0.28, 10, 8), 0xf4ead8, 0, 3.98, -0.1));
  // Menu boards on the front and a tub of cones on the counter.
  P.push(box(0.9, 0.6, 0.04, 0x2b3a3a, -0.75, 1.55, -0.42), box(0.9, 0.6, 0.04, 0x2b3a3a, 0.75, 1.55, -0.42));
  P.push(part(new THREE.CylinderGeometry(0.14, 0.12, 0.3, 8), 0xf06a8f, 1.0, 1.22, 0.45));
  return mergeGeometries(P, false);
}

/** A harvest stand, 2.8 m wide, front toward +z: a trestle table of pumpkins, crates, hay bales, corn stalks and a striped canopy. */
function pumpkinStand(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const wood = 0x8a5a36, orange = 0xe8731a;
  P.push(box(2.6, 0.08, 1.0, wood, 0, 0.82, 0.2));
  for (const sx of [-1.15, 1.15]) for (const sz of [-0.2, 0.55]) P.push(box(0.08, 0.8, 0.08, wood, sx, 0.4, sz));
  P.push(box(1.0, 0.4, 0.7, 0xa8743f, -1.7, 0.2, 0.5), box(1.0, 0.4, 0.7, 0xa8743f, 1.75, 0.2, 0.4));
  P.push(box(1.1, 0.5, 0.5, 0xd8b45a, -0.9, 0.25, 1.15), box(1.1, 0.5, 0.5, 0xcba74d, -0.8, 0.75, 1.1, 0, 0.2, 0), box(1.1, 0.5, 0.5, 0xd8b45a, 1.0, 0.25, 1.2, 0, -0.15, 0));
  const pump = (x: number, y: number, z: number, r: number, c = orange): void => {
    P.push(part(new THREE.SphereGeometry(r, 9, 7), c, x, y + r * 0.8, z, 0, 0, 0, 1, 0.82, 1));
    P.push(box(r * 0.22, r * 0.4, r * 0.22, 0x4f6a2a, x, y + r * 1.55, z));
  };
  for (let i = 0; i < 7; i++) pump(-1.05 + i * 0.35, 0.86, 0.1 + (i % 2) * 0.35, 0.17 + (i % 3) * 0.02, i % 4 === 3 ? 0xd9a21b : orange);
  for (let i = 0; i < 3; i++) pump(-1.9 + i * 0.3, 0.4, 0.45 + (i % 2) * 0.2, 0.15);
  for (let i = 0; i < 3; i++) pump(1.5 + i * 0.3, 0.4, 0.3 + (i % 2) * 0.2, 0.16);
  pump(-0.9, 1.0, 1.15, 0.4); pump(0.1, 0.0, 1.45, 0.3); pump(1.0, 1.0, 1.2, 0.34, 0xf0a030);
  // Corn stalks, in bundles at the back.
  for (let i = 0; i < 8; i++) P.push(box(0.1, 1.9, 0.1, i % 2 ? 0xc8b070 : 0xb59a58, -1.3 + i * 0.37, 0.95, -0.55, -0.08, 0, 0.05 * (i % 3 - 1)));
  // The canopy: two posts and a striped roof.
  P.push(box(0.1, 2.5, 0.1, wood, -1.4, 1.25, -0.4), box(0.1, 2.5, 0.1, wood, 1.4, 1.25, -0.4));
  for (let i = 0; i < 7; i++) P.push(box(0.4, 0.05, 1.5, i % 2 ? 0xffffff : 0xd9531e, -1.2 + i * 0.4, 2.52, 0.2, -0.22));
  return mergeGeometries(P, false);
}

/** A sailboat, 3.6 m long, bow toward +z, sail up: white hull and sails (tinted per boat), a dark mast and deck. */
function sailboat(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  P.push(box(1.2, 0.5, 3.0, 0xf4f4f0, 0, 0.3, -0.2));
  P.push(part(new THREE.BoxGeometry(0.86, 0.5, 0.86), 0xf4f4f0, 0, 0.3, 1.35, 0, Math.PI / 4, 0));
  P.push(box(1.0, 0.06, 2.6, 0x7a5a3a, 0, 0.58, -0.1));
  P.push(box(1.22, 0.1, 3.05, 0x3b6ea8, 0, 0.2, -0.2));
  P.push(part(new THREE.CylinderGeometry(0.035, 0.05, 4.6, 6), 0x55595c, 0, 2.85, 0.35));
  const tri = (a: number[], b: number[], c: number[], hex: number): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry(), col = new THREE.Color(hex);
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b], 3));
    return g;
  };
  P.push(tri([0, 0.9, 0.3], [0, 5.0, 0.38], [0, 0.9, -1.6], 0xffffff), tri([0, 0.9, -1.6], [0, 5.0, 0.38], [0, 0.9, 0.3], 0xffffff));
  P.push(tri([0, 0.8, 0.5], [0, 4.0, 0.4], [0, 0.8, 1.7], 0xf6f0e4), tri([0, 0.8, 1.7], [0, 4.0, 0.4], [0, 0.8, 0.5], 0xf6f0e4));
  return mergeGeometries(P, false);
}

function signTexture(lines: string[], bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.fillStyle = bg; x.fillRect(0, 0, 256, 96);
  x.strokeStyle = fg; x.lineWidth = 5; x.strokeRect(5, 5, 246, 86);
  x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = 'bold 40px Georgia, serif';
  if (lines.length === 1) x.fillText(lines[0], 128, 50);
  else { x.fillText(lines[0], 128, 32); x.font = 'bold 30px Georgia, serif'; x.fillText(lines[1], 128, 68); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ── The fixtures: stands ─────────────────────────────────────────────────────

interface Stand { mesh: THREE.InstancedMesh; sign: THREE.InstancedMesh; props: Prop[]; n: number; xz: number[] }

function buildStands(game: Game, group: THREE.Group, spots: readonly (readonly [number, number, number])[], geo: THREE.BufferGeometry, lines: string[], bg: string, fg: string, signY: number, signZ: number): Stand {
  const list = spots.filter((s) => STREETS_NEW || s[1] > -440);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, envMapIntensity: 0.5, side: THREE.DoubleSide });
  mat.customProgramCacheKey = (): string => 'seasonstand';
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  const smat = new THREE.MeshBasicMaterial({ map: signTexture(lines, bg, fg), side: THREE.DoubleSide, fog: true });
  smat.userData.noSnow = true;
  const sign = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.7, 0.64), smat, Math.max(1, list.length));
  const props: Prop[] = [], xz: number[] = [];
  list.forEach((s, i) => {
    const [x, z, h] = s, y = groundAt(x, z);
    _q.setFromAxisAngle(_v.set(0, 1, 0), h);
    _m.compose(_v.set(x, y, z), _q, _s.set(1, 1, 1));
    mesh.setMatrixAt(i, _m);
    const sx = Math.sin(h), cz = Math.cos(h);
    _q.setFromAxisAngle(_v.set(0, 1, 0), h);
    _m.compose(_v.set(x + sx * signZ, y + signY, z + cz * signZ), _q, _s.set(1, 1, 1));
    sign.setMatrixAt(i, _m);
    props.push(game.col.addProp(x, z, 1.35, y + 2.4, 'bin', false));
    xz.push(x, z);
  });
  mesh.count = sign.count = list.length;
  mesh.name = 'seasonStand'; sign.name = 'seasonSign';
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.visible = sign.visible = false;
  for (const p of props) p.alive = false;
  group.add(mesh, sign);
  return { mesh, sign, props, n: list.length, xz };
}

// ── The class ────────────────────────────────────────────────────────────────

const PUD_CAP = 96;
const KINDS: VehicleKind[] = ['sedan', 'hatch', 'van', 'pickup', 'sedan'];
/** Per phase: the lawns' tint, then the open ground's. */
const TINT: Record<Phase, [number[], number[]]> = {
  mud: [[0.62, 0.58, 0.38], [0.66, 0.5, 0.36]],
  spring: [[0.97, 1.02, 0.9], [1, 1, 1]],
  summer: [[0.92, 1.1, 0.78], [0.94, 1.04, 0.86]],
  fall: [[1.12, 0.96, 0.56], [1.06, 0.92, 0.72]],
  winter: [[1, 1, 1], [1, 1, 1]],
};

interface Site { x: number; z: number; h: number; vx: number; vz: number; gap: number; cars: Vehicle[]; people: Person[]; up: boolean; fixed?: boolean }

export class SeasonFx implements WorldPart {
  readonly stats = { phase: 'winter' as Phase, puddles: 0, splashes: 0, stands: 0, boats: 0, peepers: 0, peeperCars: 0, ms: 0 };
  /** Tests: the pools of what is drawn. */
  stands: { ice: Stand | null; pumpkin: Stand | null } = { ice: null, pumpkin: null };

  private readonly group = new THREE.Group();
  private phase: Phase | null = null;
  private built = false;

  // Puddles.
  private pud: THREE.InstancedMesh | null = null;
  private readonly kb = new Float32Array(900);
  private readonly px = new Float32Array(PUD_CAP);
  private readonly pz = new Float32Array(PUD_CAP);
  private readonly pr = new Float32Array(PUD_CAP);
  private readonly pLast = new Float32Array(PUD_CAP);
  private pn = 0;
  private pLastX = 1e9; private pLastZ = 1e9; private pDirty = true;

  // Boats.
  private boats: THREE.InstancedMesh | null = null;
  private nBoats = 0;

  // Viewpoints.
  private sites: Site[] = [];

  constructor(private readonly game: Game, parent: THREE.Group, private readonly mats: CityMaterials) {
    this.group.name = 'seasonFx';
    parent.add(this.group);
    (game as unknown as { seasonFx: SeasonFx }).seasonFx = this;
  }

  private build(): void {
    this.built = true;
    const g = this.game;
    // Ice-cream stands and harvest stands; signs read on the front, above the awning.
    this.stands.ice = buildStands(g, this.group, ICE_SPOTS, iceStand(), ['ICE CREAM', 'cone or cup'], '#f06a8f', '#fff6ea', 3.15, -0.2);
    this.stands.pumpkin = buildStands(g, this.group, PUMPKIN_SPOTS, pumpkinStand(), ['PUMPKINS', 'farm stand, honor box'], '#7a3b12', '#ffd9a0', 3.0, 0.3);
    // Sailboats: pastel tints, a different lap each.
    const rings = BOAT_RINGS;
    const bm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, envMapIntensity: 0.6, side: THREE.DoubleSide });
    bm.userData.noSnow = true;
    bm.customProgramCacheKey = (): string => 'seasonboat';
    this.boats = new THREE.InstancedMesh(sailboat(), bm, Math.max(1, rings.length));
    this.boats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    g.flip.mesh(this.boats);
    const tints = [0xffffff, 0xfff0d0, 0xcfe8ff, 0xffd6d0, 0xd8f0d0, 0xf0e0ff];
    const col = new THREE.Color();
    for (let i = 0; i < rings.length; i++) this.boats.setColorAt(i, col.setHex(tints[i % tints.length]));
    this.boats.frustumCulled = false;
    this.boats.castShadow = false;
    this.boats.name = 'seasonBoats';
    this.boats.visible = false;
    this.nBoats = rings.length; this.boats.count = rings.length;
    this.group.add(this.boats);
    // Viewpoints: the cars and the people come and go with the player.
    for (const [x, z, h] of VIEW_SPOTS) {
      if (!STREETS_NEW && z < -440) continue;
      this.sites.push({ x, z, h, vx: 0, vz: 1, gap: 7.6, cars: [], people: [], up: false });
    }
    // Johnson Pond's lookout: two cars on the gravel pad, the view to the east over the water (the bench and the railing are there).
    if (STREETS_NEW) this.sites.push({ x: LOOKOUT.x - 0.9, z: LOOKOUT.z - 2.6, h: 0, vx: 1, vz: 0, gap: 6.4, cars: [], people: [], up: false, fixed: true });
    for (const s of this.sites) {
      // Look away from the road: from the nearest road point out to the pull-off.
      const sg = g.plan.streets;
      if (sg && !s.fixed) {
        const n = sg.nearestEdge(s.x, s.z, (e) => !e.deck), p = sg.project(n.edge, s.x, s.z), c = sg.pointAt(n.edge, p.s);
        const dx = s.x - c.x, dz = s.z - c.z, d = Math.hypot(dx, dz) || 1;
        s.vx = dx / d; s.vz = dz / d;
      }
    }
  }

  private buildPuddles(): void {
    const g = this.game;
    const low = g.quality.name === 'low';
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3b2d20, roughness: 0.04, metalness: 0, envMapIntensity: 1.1, transparent: true, opacity: 0.9, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    mat.userData.noSnow = true;
    mat.customProgramCacheKey = (): string => 'seasonpuddle';
    const geo = new THREE.CircleGeometry(1, low ? 10 : 16);
    geo.rotateX(-Math.PI / 2);
    this.pud = new THREE.InstancedMesh(geo, mat, PUD_CAP);
    this.pud.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    g.flip.mesh(this.pud);
    this.pud.count = 0;
    this.pud.frustumCulled = false;
    this.pud.renderOrder = 3;
    this.pud.name = 'puddles';
    this.pud.visible = false;
    this.group.add(this.pud);
  }

  /** Apply a phase: the tints, the mud's feel on the roads, and which fixtures stand. */
  private apply(ph: Phase): void {
    this.phase = ph;
    this.stats.phase = ph;
    const t = TINT[ph];
    this.mats.setSeasonTint(new THREE.Color(t[0][0], t[0][1], t[0][2]), new THREE.Color(t[1][0], t[1][1], t[1][2]));
    this.game.vehicles.mud = ph === 'mud' ? 1 : 0;
    const ice = this.stands.ice, pump = this.stands.pumpkin;
    if (ice) { ice.mesh.visible = ice.sign.visible = ph === 'summer'; for (const p of ice.props) p.alive = ph === 'summer'; this.stats.stands = ph === 'summer' ? ice.n : 0; }
    if (pump) { pump.mesh.visible = pump.sign.visible = ph === 'fall'; for (const p of pump.props) p.alive = ph === 'fall'; if (ph === 'fall') this.stats.stands = pump.n; }
    if (this.boats) this.boats.visible = ph === 'summer';
    this.stats.boats = ph === 'summer' ? this.nBoats : 0;
    if (this.pud) { this.pud.visible = ph === 'mud'; if (ph !== 'mud') { this.pud.count = 0; this.pn = 0; } else this.pDirty = true; }
    if (ph !== 'fall') for (const s of this.sites) this.leave(s);
  }

  update(dt: number): void {
    const g = this.game, sky = g.sky;
    if (!sky) return;
    if (!this.built) this.build();
    const ph = season.phase;
    if (ph !== this.phase) this.apply(ph);
    if (ph === 'winter' || ph === 'spring') return;
    const t0 = performance.now();
    dt = Math.min(dt, 0.1);
    if (ph === 'mud') this.puddles(dt);
    else if (ph === 'summer') this.sail();
    else if (ph === 'fall') this.peepers();
    this.stats.ms = performance.now() - t0;
  }

  // ── Mud season: puddles ───────────────────────────────────────────────────

  private puddles(dt: number): void {
    const g = this.game;
    if (!this.pud) this.buildPuddles();
    const pud = this.pud as THREE.InstancedMesh, cam = g.camera.position;
    pud.visible = true;
    // Like the cars, the water takes its reflection from the street's sky.
    const pm = pud.material as THREE.MeshStandardMaterial;
    if (pm.envMap !== g.scene.environment) { pm.envMap = g.scene.environment; pm.needsUpdate = true; }
    const R = g.quality.name === 'low' ? 55 : 80;
    if (this.pDirty || (cam.x - this.pLastX) ** 2 + (cam.z - this.pLastZ) ** 2 > 100) this.fillPuddles(cam.x, cam.z, R);
    // Cars through a puddle: spray, and a little spatter of mud; the player's car loses a touch of speed.
    const cars = g.vehicles.list, pl = g.player.vehicle, now = performance.now() / 1000;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i], v2 = c.vx * c.vx + c.vz * c.vz;
      if (v2 < 6) continue;
      const dx0 = c.x - cam.x, dz0 = c.z - cam.z;
      if (dx0 * dx0 + dz0 * dz0 > 3600) continue;
      for (let k = 0; k < this.pn; k++) {
        const dx = c.x - this.px[k], dz = c.z - this.pz[k], r = this.pr[k] + c.hw * 0.5;
        if (dx > r + c.hl || dx < -r - c.hl || dz > r + c.hl || dz < -r - c.hl) continue;
        if (dx * dx + dz * dz > (r + 0.6) * (r + 0.6) || now - this.pLast[k] < 0.7) continue;
        this.pLast[k] = now;
        this.stats.splashes++;
        const sp = Math.sqrt(v2);
        g.fx.emitters.splash(c.x, c.z, sp > 9);
        g.fx.emitters.debris(c.x, c.y + 0.15, c.z, c.vx * 0.4, c.vz * 0.4, 4 + Math.min(6, Math.floor(sp * 0.4)), 0x5b4632, 2.5 + sp * 0.12);
        if (c === pl) { c.vx *= 0.985; c.vz *= 0.985; }
      }
    }
  }

  private fillPuddles(x: number, z: number, R: number): void {
    this.pLastX = x; this.pLastZ = z; this.pDirty = false;
    const pud = this.pud as THREE.InstancedMesh, sf = this.game.sky.snowfall;
    let n = 0;
    if (sf) {
      const k = sf.kerbs(x, z, R, this.kb);
      for (let i = 0; i < k && n < PUD_CAP; i++) {
        const bx = this.kb[i * 3], bz = this.kb[i * 3 + 1], a = this.kb[i * 3 + 2];
        const ix = Math.floor(bx * 2), iz = Math.floor(bz * 2);
        if (hash(ix, iz, 7) > 0.34) continue;
        // The gutter side is the lower one.
        const sx = Math.sin(a), cz = Math.cos(a);
        const x1 = bx + sx * 1.5, z1 = bz + cz * 1.5, x2 = bx - sx * 1.5, z2 = bz - cz * 1.5;
        const lo = groundAt(x1, z1) <= groundAt(x2, z2);
        const px = lo ? x1 : x2, pz = lo ? z1 : z2, y = groundAt(px, pz);
        if (y < WATER_Y + 0.1) continue;
        const rx = 1.0 + 1.5 * hash(ix, iz, 8), rz = 0.5 + 0.45 * hash(ix, iz, 9);
        _q.setFromAxisAngle(_v.set(0, 1, 0), a);
        _m.compose(_v.set(px, y + 0.03, pz), _q, _s.set(rx, 1, rz));
        pud.setMatrixAt(n, _m);
        this.px[n] = px; this.pz[n] = pz; this.pr[n] = Math.max(0.55, rx * 0.8); this.pLast[n] = 0;
        n++;
      }
    }
    this.pn = n; pud.count = n; this.stats.puddles = n;
    if (n) pud.instanceMatrix.needsUpdate = true;
  }

  // ── Summer: sailboats ─────────────────────────────────────────────────────

  private sail(): void {
    const boats = this.boats;
    if (!boats) return;
    const sky = this.game.sky as unknown as { day?: number; hour: number };
    // The town clock, in game minutes taken as seconds (a game day is 24 real minutes): the same circuit on every screen.
    const T = ((sky.day ?? 0) * 24 + sky.hour) * 60;
    const rings = BOAT_RINGS;
    for (let i = 0; i < rings.length; i++) {
      const [cx, cz, r] = rings[i], dir = i % 2 ? 1 : -1, lap = 90 + 11 * i;
      const a = i * 1.7 + dir * TAU * T / lap;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const tx = -Math.sin(a) * dir, tz = Math.cos(a) * dir;
      const h = Math.atan2(tx, tz);
      _q.setFromEuler(_e.set(0.03 * Math.sin(T * 0.7 + i), h, 0.14 * dir * -1 + 0.04 * Math.sin(T * 0.9 + i * 2), 'YXZ'));
      _m.compose(_v.set(x, seaY(x, z) + 0.08, z), _q, _s.set(1.5, 1.5, 1.5));
      boats.setMatrixAt(i, _m);
    }
    boats.instanceMatrix.needsUpdate = true;
  }

  // ── Fall: leaf-peepers at the viewpoints ──────────────────────────────────

  private peepers(): void {
    const g = this.game, px = g.camera.position.x, pz = g.camera.position.z;
    let cars = 0, people = 0;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i], d2 = (s.x - px) ** 2 + (s.z - pz) ** 2;
      if (!s.up && d2 < 280 * 280) this.arrive(s, i);
      else if (s.up && d2 > 420 * 420) this.leave(s);
      if (s.up) { cars += s.cars.length; people += s.people.length; }
    }
    this.stats.peeperCars = cars; this.stats.peepers = people;
  }

  private arrive(s: Site, i: number): void {
    const g = this.game, tx = Math.sin(s.h), tz = Math.cos(s.h);
    s.up = true;
    for (let k = 0; k < 2; k++) {
      const kind = KINDS[(i + k) % KINDS.length], x = s.x + tx * s.gap * k, z = s.z + tz * s.gap * k;
      const v = g.vehicles.spawn(kind, x, z, s.h, VISITOR_PAINT[(i * 3 + k * 2 + 1) % VISITOR_PAINT.length]);
      s.cars.push(v);
    }
    // Two people at the edge, looking out at the leaves.
    for (let k = 0; k < 2; k++) {
      const x = s.x + s.vx * 2.6 + tx * (2.4 + k * 2.2), z = s.z + s.vz * 2.6 + tz * (2.4 + k * 2.2);
      const p = g.people.spawn(x, z, Math.atan2(s.vx, s.vz), g.people.randomLook());
      p.pose = 'stand'; p.speed = 0;
      s.people.push(p);
    }
  }

  private leave(s: Site): void {
    if (!s.up) return;
    s.up = false;
    const g = this.game;
    for (const v of s.cars) if (v.driver === null) g.vehicles.remove(v);
    for (const p of s.people) g.people.remove(p);
    s.cars.length = 0; s.people.length = 0;
  }

  /** Item 34's sites for tests: where the pull-offs are. */
  get viewpoints(): readonly { x: number; z: number; up: boolean }[] { return this.sites; }
}
