// SpeedScan headquarters, inside (tools/briefs/speedscan-hq.md, "Interior"): the lobby you walk into from the plaza, two
// lifts that ride to the office floor (42, with the card-printer room) and the roof deck, and the people in them.
//
// The models are Blender's (tools/blender/speedscan_int.py; its header is the contract): models/speedscan_int.glb (the
// lobby, the office and the car with their light baked in Cycles into the vertex colours, drawn unlit; the glass; the
// roof deck, lit by the sun) and models/speedscan_int.json (what is solid, where people sit, stand and walk), in the
// tower's model frame (speedscanHQ.ts: HQ is its origin in the world).
//
// Costs: the lobby is drawn only from inside or from the plaza in front of it, the office only near its height, the
// roof's cars only from the deck; elsewhere the tower's stand-in lobby glass (hq_lobby) shows and nothing here is drawn.
// Inside a closed car the world beyond 40 m is not drawn; inside the lobby and the office the sun's shadow map is left
// as it was (nothing inside is lit by it). Phones (low) get none of it: the podium stays solid there.
// Lifts: each player rides their own (nothing on the wire). [G] calls a car at a landing; inside, [G] picks the floor
// (each press the next one) and the car goes a moment after the last press: doors close, the counter runs, the car is
// swapped for the same car at the other landing while its doors are shut, the doors open.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { Person } from '../core/api';
import type { Box } from './collide';
import { assets } from '../core/assets';
import { nightBloom } from '../core/post';

const CARS = [-4.125, 4.125];
const CAR_Z = -3.3, CAR_W = 2.6, CAR_D = 2.6, DOOR_W = 1.3, DOOR_H = 2.4, LEAF_Z = -3.24;
const LEVELS = [
  { y: 0.2, label: 'L', name: 'Lobby' },
  { y: 160, label: '42', name: '42 · SpeedScan offices' },
  { y: 322.1, label: 'R', name: 'Roof deck' },
];
/** The tower above the podium, for anything that flies or climbs (model frame: x0, x1, z0, z1, y0, y1). */
const TOWER: number[][] = [[-33, 33, -36, 6, 15, 160], [-33, 33, -36, 6, 163, 190], [-29, 29, -33, 3, 190, 262], [-26, 26, -31, 1, 262, 322]];
/** Where the owner's logo goes inside (model frame): x, y, z, turn, width; the first two in the lobby, the rest on 42. */
const LOGOS: number[][] = [
  [-19, 6.7, -13.86, 0, 9], [-18, 0.62, 0.012, 0, 3.0],
  [0, 161.75, -3.17, 0, 3.0], [-24.6, 161.9, -22.14, Math.PI, 3.4], [-26.0, 161.9, -21.86, 0, 3.4],
];

interface SsData { solid: number[][]; seats: [number, number, number, number, string][]; stands: number[][]; walks: number[][][] }
interface Walker { p: Person; path: number[][]; i: number; wait: number; y: number }

function label(y: number): string { return y < 10 ? 'L' : y > 318 ? 'R' : String(Math.round(y / 3.8)); }

export class SpeedScanInterior {
  private low: boolean;
  private ox: number; private oz: number;
  private lobby = new THREE.Group();
  private office = new THREE.Group();
  private roof = new THREE.Group();
  private roofCars = new THREE.Group();
  private standIn: THREE.Object3D | null = null;
  private logoGeo: THREE.BufferGeometry | null = null;
  private glass: THREE.MeshStandardMaterial | null = null;
  private loaded = false;
  private cam = new THREE.Vector3();
  // Doors: open[level][car] 0..1, want, hold time; their leaves and collision boxes.
  private open = LEVELS.map(() => CARS.map(() => 0));
  private want = LEVELS.map(() => CARS.map(() => 0));
  private hold = LEVELS.map(() => CARS.map(() => 0));
  private leaves: { mesh: THREE.Mesh; l: number; c: number; x0: number; dir: number }[] = [];
  private doorBox: Box[][] = [];
  // The ride.
  private phase: 'idle' | 'arm' | 'closing' | 'ride' = 'idle';
  private t = 0; private dur = 1;
  private car = 0; private from = 0; private sel = -1;
  private shown = '';
  private counter: { cv: HTMLCanvasElement; tex: THREE.CanvasTexture } | null = null;
  private prompting = false;
  private people: Walker[] = [];
  private still: Person[] = [];
  /** Where the camera is (for the rest of the game). */
  inside = false;
  private indoors = false;
  private crowdLobby = false;
  private bloomOff = false;

  constructor(private game: Game, private parent: THREE.Object3D, origin: { x: number; z: number }, private env: () => THREE.Texture | null) {
    this.low = game.quality.name === 'low';
    this.ox = origin.x; this.oz = origin.z;
    for (const g of [this.lobby, this.office, this.roof]) { g.visible = false; parent.add(g); }
    this.lobby.name = 'speedscan-lobby'; this.office.name = 'speedscan-office'; this.roof.name = 'speedscan-roof';
    this.roof.add(this.roofCars);
    const col = game.col;
    for (const [x0, x1, z0, z1, y0, y1] of TOWER) col.addBox(this.ox + x0, this.oz + z0, this.ox + x1, this.oz + z1, y1, y0);
    if (this.low || new URLSearchParams(location.search).get('hq') === '0') {
      // No interior on phones: the podium is solid where the lobby is, and so is the lantern.
      col.addBox(this.ox - 31, this.oz - 14, this.ox + 31, this.oz + 10, 20, 0);
      col.addBox(this.ox - 22, this.oz - 27, this.ox + 22, this.oz - 3, 348, 322);
      return;
    }
    // Lift doors: solid while mostly shut.
    this.doorBox = LEVELS.map((L) => CARS.map((cx) => col.addBox(this.ox + cx - DOOR_W / 2, this.oz + CAR_Z, this.ox + cx + DOOR_W / 2, this.oz + LEAF_Z + 0.06, L.y + DOOR_H, L.y - 0.5)));
    // ?ssint=0 leaves the furnishings out (the shell's stand-in glass stays): for timing what the interior costs.
    if (new URLSearchParams(location.search).get('ssint') === '0') return;
    void this.load().catch((e) => console.warn('ssi', e));
  }

  /** From speedscanHQ.ts once the tower's file is in: the stand-in lobby glass and the logo's geometry. */
  attach(standIn: THREE.Object3D | null, logo: THREE.BufferGeometry | null): void {
    this.standIn = standIn; this.logoGeo = logo;
    if (this.loaded) this.logos();
  }

  private async load(): Promise<void> {
    const [gb, jb] = await Promise.all([assets.bytes('models/speedscan_int.glb'), assets.bytes('models/speedscan_int.json')]);
    if (!gb || gb.byteLength < 20 || new DataView(gb).getUint32(0, true) !== 0x46546c67 || !jb) return;
    let data: SsData;
    try { data = JSON.parse(new TextDecoder().decode(jb)) as SsData; } catch { return; }
    const col = this.game.col;
    for (const [x0, x1, z0, z1, y0, y1] of data.solid) col.addBox(this.ox + x0, this.oz + z0, this.ox + x1, this.oz + z1, y1, y0);
    const gltf = await new GLTFLoader().parseAsync(gb, '');
    const geo = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.computeBoundingSphere(); geo.set(o.name, m.geometry); } });
    const at = new THREE.Matrix4().makeTranslation(this.ox, 0, this.oz);
    const baked = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    this.glass = new THREE.MeshStandardMaterial({ color: 0x6f8189, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
    const deck = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    const put = (name: string, mat: THREE.Material, into: THREE.Object3D, m = at): THREE.Mesh | null => {
      let g = geo.get(name);
      if (!g) return null;
      // The file carries no normals (the baked meshes need none): flat ones for what the sun lights.
      if (!(mat instanceof THREE.MeshBasicMaterial)) { g = g.index ? g.toNonIndexed() : g; g.computeVertexNormals(); g.computeBoundingSphere(); }
      const mesh = new THREE.Mesh(g, mat);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(m); mesh.name = name;
      into.add(mesh);
      return mesh;
    };
    const lob = put('in_lobby', baked, this.lobby);
    const gl = put('in_glass_lobby', this.glass, this.lobby); if (gl) gl.renderOrder = 2;
    const off = put('in_office', baked, this.office);
    const go = put('in_glass_office', this.glass, this.office); if (go) go.renderOrder = 2;
    const rf = put('in_roof', deck, this.roof); if (rf) rf.receiveShadow = true;
    const gr = put('in_glass_roof', this.glass, this.roof); if (gr) gr.renderOrder = 2;
    // The night bloom would wash a bright room out: off while the camera is inside (set at draw time, after every
    // other system's update has had its say).
    for (const m of [lob, off]) if (m) m.onBeforeRender = () => { if (this.indoors) nightBloom.scale = 0; };
    // The cars, one at each landing, and their doors and counters.
    this.counter = this.makeCounter();
    const dispMat = new THREE.MeshBasicMaterial({ map: this.counter.tex, toneMapped: false, fog: false });
    const disp = new THREE.PlaneGeometry(0.34, 0.17);
    const leafG = new THREE.BoxGeometry(DOOR_W / 2 + 0.01, DOOR_H, 0.04).translate(0, DOOR_H / 2, 0);
    const leafMat = new THREE.MeshBasicMaterial({ color: 0x9aa1a8, fog: false });
    const carG = geo.get('in_car');
    LEVELS.forEach((L, l) => {
      const into = l === 0 ? this.lobby : l === 1 ? this.office : this.roofCars;
      CARS.forEach((cx, c) => {
        const m = new THREE.Matrix4().makeTranslation(this.ox + cx, L.y, this.oz + CAR_Z);
        if (carG) { const cm = new THREE.Mesh(carG, baked); cm.matrixAutoUpdate = false; cm.matrix.copy(m); into.add(cm); }
        for (const dir of [-1, 1]) {
          const leaf = new THREE.Mesh(leafG, leafMat);
          const x0 = this.ox + cx + dir * DOOR_W / 4;
          leaf.position.set(x0, L.y, this.oz + LEAF_Z);
          into.add(leaf);
          this.leaves.push({ mesh: leaf, l, c, x0, dir });
        }
        const outZ = l === 2 ? -2.88 : -3.17;
        const d1 = new THREE.Mesh(disp, dispMat); d1.position.set(this.ox + cx, L.y + DOOR_H + 0.27, this.oz + outZ); into.add(d1);
        const d2 = new THREE.Mesh(disp, dispMat); d2.position.set(this.ox + cx, L.y + DOOR_H + 0.15, this.oz + CAR_Z - 0.012); d2.rotation.y = Math.PI; into.add(d2);
      });
    });
    this.loaded = true;
    if (this.logoGeo) this.logos();
    this.spawnPeople(data);
  }

  private logos(): void {
    const lg = this.logoGeo;
    if (!lg) return;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const [into, spots] of [[this.lobby, LOGOS.slice(0, 2)], [this.office, LOGOS.slice(2)]] as [THREE.Group, number[][]][]) {
      const parts = spots.map(([x, y, z, ry, w]) => lg.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(this.ox + x, y, this.oz + z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(w, w, w))));
      const g = mergeGeometries(parts);
      if (!g) continue;
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat); mesh.name = 'speedscan-int-logo';
      into.add(mesh);
    }
  }

  private makeCounter(): { cv: HTMLCanvasElement; tex: THREE.CanvasTexture } {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    return { cv, tex };
  }

  private showCounter(text: string): void {
    if (!this.counter || text === this.shown) return;
    this.shown = text;
    const c = this.counter.cv.getContext('2d')!;
    c.fillStyle = '#07090b'; c.fillRect(0, 0, 128, 64);
    c.fillStyle = '#9fe870'; c.font = 'bold 40px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 64, 34);
    this.counter.tex.needsUpdate = true;
  }

  private data: SsData | null = null;
  private recheck = 0;
  private spawnPeople(d: SsData): void {
    this.data = d;
    const ppl = this.game.people; if (!ppl) return;
    for (const p of this.still) ppl.remove(p);
    for (const w of this.people) ppl.remove(w.p);
    this.still = []; this.people = [];
    const spawn = (x: number, y: number, z: number, h: number): Person => {
      const p = ppl.spawn(this.ox + x, this.oz + z, h, ppl.randomLook()); p.y = y; p.visible = false; return p;
    };
    // About two sofa seats in five taken; every desk listed has someone at it.
    for (const [i, [x, y, z, h, kind]] of d.seats.entries()) { if (kind === 'bench' && ((i * 0.618) % 1) < 0.58) continue; const p = spawn(x, y + (kind === 'desk' ? 0.05 : 0), z, h); p.pose = 'sit'; p.bench = kind !== 'desk'; this.still.push(p); }
    for (const [x, y, z, h] of d.stands) { const p = spawn(x, y, z, h); p.pose = 'stand'; this.still.push(p); }
    d.walks.forEach((path, i) => {
      const y = i < 3 ? LEVELS[0].y : LEVELS[1].y;
      const p = spawn(path[0][0], y, path[0][1], 0); p.pose = 'stand';
      this.people.push({ p, path, i: 0, wait: i * 2.5, y });
    });
  }

  update(dt: number): void {
    if (this.low || !this.loaded) return;
    const g = this.game;
    const cam = g.camera.getWorldPosition(this.cam);
    const lx = cam.x - this.ox, ly = cam.y, lz = cam.z - this.oz;
    const near = Math.abs(lx) < 48 && lz > -45 && lz < 75;
    const lobbyOn = near && ly < 30;
    const inLobby = lx > -31 && lx < 31 && lz > -14 && lz < 9.85 && ly < 15;
    const officeOn = near && ly > 150 && ly < 172;
    const inOffice = lx > -33 && lx < 33 && lz > -36 && lz < 6 && ly > 159.5 && ly < 163.2;
    const roofDist = Math.hypot(lx, lz + 15);
    this.lobby.visible = lobbyOn; this.office.visible = officeOn;
    this.roof.visible = roofDist < 900;
    this.roofCars.visible = ly > 300 && near;
    if (this.standIn) this.standIn.visible = !lobbyOn && Math.hypot(lx, lz) < 470;
    const inCar = CARS.findIndex((cx) => Math.abs(lx - cx) < CAR_W / 2 && lz < CAR_Z + 0.25 && lz > CAR_Z - CAR_D);
    let carLevel = -1;
    if (inCar >= 0) carLevel = LEVELS.findIndex((L) => ly > L.y - 0.5 && ly < L.y + 2.8);
    const closedCar = carLevel >= 0 && this.open[carLevel][inCar] < 0.02;
    this.indoors = inLobby || inOffice || carLevel >= 0;
    this.inside = this.indoors;
    if (!this.indoors && this.bloomOff) nightBloom.scale = 1;
    this.bloomOff = this.indoors;
    this.cull(closedCar ? 'car' : (inLobby || inOffice) ? 'room' : 'none');
    this.lift(dt);
    // Starting or restarting the game clears the crowd: put ours back when they have gone.
    if ((this.recheck -= dt) <= 0) {
      this.recheck = 2;
      const first = this.still[0];
      if (this.data && g.people && (!first || !g.people.list.includes(first))) this.spawnPeople(this.data);
    }
    // From the plaza the lobby's people only within 20 m of the glass (they are most of what it costs from out there).
    this.crowdLobby = lobbyOn && (inLobby || lz < 30);
    this.walkers(dt);
    const env = this.env();
    if (this.glass && this.glass.envMap !== env) { this.glass.envMap = env; this.glass.needsUpdate = true; }
  }

  /** The player's lift: calls, the floor choice, the ride; the doors' motion and collision. */
  private lift(dt: number): void {
    const g = this.game, p = g.player;
    const foot = !!p && !p.vehicle;
    const px = p ? p.x - this.ox : 0, pz = p ? p.z - this.oz : 0, py = p ? p.y : -99;
    const lvl = LEVELS.findIndex((L) => py > L.y - 0.6 && py < L.y + 1.5);
    const inCar = foot && lvl >= 0 ? CARS.findIndex((cx) => Math.abs(px - cx) < CAR_W / 2 && pz < CAR_Z + 0.15 && pz > CAR_Z - CAR_D) : -1;
    const landZ = lvl === 2 ? -3.0 : -3.2;
    const atDoor = foot && lvl >= 0 && inCar < 0 ? CARS.findIndex((cx) => Math.abs(px - cx) < 1.3 && pz > landZ - 0.05 && pz < landZ + 2.4) : -1;
    let text: string | null = null;
    if (this.phase === 'idle') {
      if (inCar >= 0) {
        const others = LEVELS.map((_, i) => i).filter((i) => i !== lvl);
        text = `[G] Choose a floor: ${others.map((i) => LEVELS[i].label).join(' · ')}`;
        this.hold[lvl][inCar] = Math.max(this.hold[lvl][inCar], 2);
        if (g.input.eat('interact')) { this.car = inCar; this.from = lvl; this.sel = others[0]; this.phase = 'arm'; this.t = 1.4; }
      } else if (atDoor >= 0) {
        if (this.open[lvl][atDoor] < 0.5 && this.want[lvl][atDoor] === 0) {
          text = '[G] Call the lift';
          if (g.input.eat('interact')) { this.want[lvl][atDoor] = 1; this.hold[lvl][atDoor] = 6; }
        } else this.hold[lvl][atDoor] = Math.max(this.hold[lvl][atDoor], 2);
      }
    } else if (this.phase === 'arm') {
      text = `[G] Going to ${LEVELS[this.sel].name} · press again to change`;
      if (inCar !== this.car || lvl !== this.from) this.phase = 'idle';
      else if (g.input.eat('interact')) {
        const others = LEVELS.map((_, i) => i).filter((i) => i !== this.from);
        this.sel = others[(others.indexOf(this.sel) + 1) % others.length]; this.t = 1.4;
      } else if ((this.t -= dt) <= 0) { this.phase = 'closing'; this.want[this.from][this.car] = 0; this.hold[this.from][this.car] = 0; }
      this.hold[this.from][this.car] = Math.max(this.hold[this.from][this.car], 0.5);
    } else if (this.phase === 'closing') {
      text = `Going to ${LEVELS[this.sel].name}`;
      if (inCar !== this.car) { this.phase = 'idle'; }
      else if (this.open[this.from][this.car] < 0.01 && p) {
        // Doors shut: the same car at the other landing takes over.
        const dy = LEVELS[this.sel].y - LEVELS[this.from].y;
        p.person.y += dy;
        g.cam.snap();
        this.phase = 'ride'; this.t = 0; this.dur = 2.4 + Math.abs(dy) / 90;
      }
    } else if (this.phase === 'ride') {
      this.t += dt;
      const k = Math.min(1, this.t / this.dur), e = k * k * (3 - 2 * k);
      const y0 = LEVELS[this.from].y, y1 = LEVELS[this.sel].y;
      const arrow = y1 > y0 ? '▲' : '▼';
      this.showCounter(k >= 1 ? LEVELS[this.sel].label : label(y0 + (y1 - y0) * e) + arrow);
      text = null;
      if (k >= 1) { this.want[this.sel][this.car] = 1; this.hold[this.sel][this.car] = 4; this.phase = 'idle'; }
    }
    if (this.phase !== 'ride') this.showCounter(lvl >= 0 ? LEVELS[lvl].label : 'L');
    if (text !== null) { g.hud.prompt(text); this.prompting = true; }
    else if (this.prompting) { g.hud.prompt(null); this.prompting = false; }
    // Doors: open while held, then shut; solid while mostly shut.
    for (let l = 0; l < LEVELS.length; l++) for (let c = 0; c < CARS.length; c++) {
      if (this.want[l][c] && (this.hold[l][c] -= dt) <= 0 && !(this.phase === 'arm' && l === this.from && c === this.car)) this.want[l][c] = 0;
      const w = this.want[l][c], o = this.open[l][c];
      this.open[l][c] = o + Math.sign(w - o) * Math.min(Math.abs(w - o), dt * 1.25);
      const b = this.doorBox[l]?.[c];
      if (b) { const solid = this.open[l][c] < 0.6; b.y0 = solid ? LEVELS[l].y - 0.5 : -1001; b.y1 = solid ? LEVELS[l].y + DOOR_H : -1000; }
    }
    for (const lf of this.leaves) {
      const o = this.open[lf.l][lf.c], s = o * o * (3 - 2 * o);
      lf.mesh.position.x = lf.x0 + lf.dir * (DOOR_W / 2 - 0.02) * s;
    }
  }

  private walkers(dt: number): void {
    const lob = this.crowdLobby, off = this.office.visible, roof = this.roofCars.visible;
    for (const p of this.still) p.visible = p.y < 10 ? lob : p.y < 200 ? off : roof;
    for (const w of this.people) {
      const p = w.p;
      p.visible = w.y < 10 ? lob : off;
      if (!p.visible) continue;
      if (w.wait > 0) { w.wait -= dt; p.pose = 'stand'; p.speed = 0; continue; }
      const [tx, tz] = w.path[(w.i + 1) % w.path.length];
      const dx = this.ox + tx - p.x, dz = this.oz + tz - p.z, d = Math.hypot(dx, dz);
      if (d < 0.15) { w.i = (w.i + 1) % w.path.length; w.wait = w.i === 0 || w.i === w.path.length - 1 ? 2 + Math.random() * 4 : 0; continue; }
      const v = 1.25, s = Math.min(d, v * dt);
      p.x += dx / d * s; p.z += dz / d * s; p.y = w.y;
      p.h = Math.atan2(-dx, -dz); p.pose = 'walk'; p.speed = v;
    }
  }

  /**
   * Inside a shut car nothing beyond 40 m can be seen; inside the lobby or the office nothing is lit by the sun, so its
   * shadow map is left as it is. Both are put back the moment the camera is out.
   */
  private culled: 'none' | 'room' | 'car' = 'none';
  private farWas = 0;
  private cull(mode: 'none' | 'room' | 'car'): void {
    if (mode === this.culled) return;
    const cam = this.game.camera as THREE.PerspectiveCamera, r = this.game.renderer;
    if (this.culled === 'car') cam.far = this.farWas || cam.far;
    if (mode === 'car') { this.farWas = cam.far; cam.far = Math.min(cam.far, 40); }
    r.shadowMap.autoUpdate = mode === 'none';
    if (mode === 'none') r.shadowMap.needsUpdate = true;
    cam.updateProjectionMatrix();
    this.culled = mode;
  }
}
