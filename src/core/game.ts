// The one object that owns everything. Subsystems take `game` in their
// constructor and reach each other through it (see core/api.ts for what each
// one promises). The frame order below is the only place that order matters.

import * as THREE from 'three';
import type { GameEvents, GameState, ParkedSpot, Quality, Vehicle } from './api';
import { Input } from './input';
import { RNG } from './util';
import { CityPlan } from '../world/plan';
import { Colliders } from '../world/collide';
import { World } from '../world/world';
import { Sky } from '../world/sky';
import { Vehicles } from '../ent/vehicle';
import { SPECS, commonKind } from '../ent/vehicleSpecs';
import { People } from '../ent/character';
import { Ragdolls } from '../ent/ragdoll';
import { Occupants } from '../ent/occupants';
import { Player } from '../ent/player';
import { CameraRig } from './camera';
import { Hud } from '../ui/hud';
import { TouchUI } from '../ui/touch';
import { Cheats } from './cheats';
import { Ambient } from '../sim/ambient';
import { Police } from '../sim/police';
import { Post } from './post';
import { flip } from './flip';
import { ShaderWarmup } from './warmup';
import { Fx } from '../fx/particles';
import { Skids } from '../fx/skids';
import { ProgressWorks, progress } from '../world/progress';
import { ThingsToDo } from '../game/index';
import { Governor, pickQuality } from './governor';
import { GameAudio } from '../audio/index';
import { Net } from '../net/index';
import { Emotes } from '../game/emotes';
import { Leaderboard } from '../game/leaderboard';
import { Photo } from '../fx/photo';
import { Spectate } from '../fx/spectate';

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

type Handler<K extends keyof GameEvents> = (e: GameEvents[K]) => void;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly plan = new CityPlan();
  readonly col = new Colliders();
  /** The preset this visit was built with: `?q=`, the menu's choice, or what core/governor.ts measured. A copy, so nothing changes the table. */
  readonly quality: Quality;
  /** Auto quality: watches the real frame times and trims the picture to keep them (core/governor.ts). Inert unless Auto is in charge. */
  readonly gov: Governor;
  /** Ambient occlusion, bloom, the tone map and the grade. Null on the `low` preset and with `?post=0`: a plain render straight to the canvas. */
  readonly post: Post | null;
  /** Background shader compiles (core/warmup.ts). */
  warmup!: ShaderWarmup;
  /** The two-copy instance buffers (core/flip.ts), here so tools can switch them off and measure. */
  readonly flip = flip;

  world!: World;
  sky!: Sky;
  vehicles!: Vehicles;
  people!: People;
  /** Drivers and riders drawn in their seats through the car glass (ent/occupants.ts). */
  occupants!: Occupants;
  player!: Player;
  cam!: CameraRig;
  /** Photo mode (fx/photo.ts): while open it has the frame instead of the simulation. */
  photo!: Photo;
  /** Spectating (fx/spectate.ts): watch another player; it sets the lens after the camera rig. */
  spectate!: Spectate;
  hud!: Hud;
  touchUI!: TouchUI;
  private cheats!: Cheats;
  /** Particles: smoke, sparks, spray. `fx.emitters` is how other systems ask for an effect. */
  fx!: Fx;
  /** Milestone 4: the save, the missions, the jobs and the menu (src/game/). */
  todo!: ThingsToDo;
  /** Milestone 5: every sound in the game (src/audio/). Silent, and no AudioContext at all, until the first key or click. */
  audio!: GameAudio;
  /** Emotes and horn tunes (game/emotes.ts). */
  emotes!: Emotes;
  /** Multiplayer stage 1 (src/net/): the other players in town, drawn only. */
  net!: Net;
  /** Systems from later milestones plug in here until they earn a named slot. Updated after the world, while running. */
  readonly systems: { update(dt: number): void }[] = [];

  state: GameState = 'loading';
  /** Simulated seconds since the world was built. Stops while paused. */
  time = 0;
  /**
   * What the traffic signals run on. Alone it is `time` exactly. In a shared town (src/net/shared.ts) it is the
   * town's clock, the same in every browser there; on leaving, `signalShift` keeps the lamps where they were.
   */
  signalClock: (() => number) | null = null;
  /** Every kerb place on the island and the car that belongs in it (placeStart), then the four cars the game opens with. */
  readonly parkSpots: ParkedSpot[] = [];
  /**
   * Multiplayer (src/net/cars.ts): the player is at the door of a car that is the town's, not this browser's. Asks its
   * keeper for it: 'wait' until the answer is in, 'no' when it is not to be had. Null alone: such a car has no door.
   */
  takeShared: ((v: Vehicle) => 'wait' | 'no') | null = null;
  signalShift = 0;
  get signalTime(): number { return this.signalClock ? this.signalClock() : this.time + this.signalShift; }
  /** Length of the step being simulated right now. */
  dt = 0;
  frame = 0;
  /** Smoothed frames per second of real rendering. */
  fps = 60;
  /** Tests set this to stop real time driving the simulation, then call tick() themselves. */
  frozen = false;
  /** Fixed camera for screenshots: overrides the camera rig until set back to null. */
  view: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  private handlers = new Map<string, Handler<never>[]>();
  private lastNight = -1;
  private lastT = 0;
  /** The governor's share of the preset's pixel ratio: 1 is all of it. */
  private ratioScale = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const choice = pickQuality();
    const q = this.quality = choice.quality;
    // `low` is the phone preset and pays nothing for post-processing. `?post=0` is the before picture, for comparing.
    const post = q.name !== 'low' && new URLSearchParams(location.search).get('post') !== '0';
    // With post on, the scene is antialiased in its own target; the canvas only ever receives one full-screen triangle.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias && !post, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(innerWidth, innerHeight, false);
    // A frame is several render() calls now; count them all, not just the last pass.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The sky owns tone mapping and exposure; it changes them through the day.
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.4, 4000);
    this.camera.position.set(0, 120, 520);
    this.input = new Input(canvas);
    this.input.setEnabled(false);
    // Before anything is built: the bridge's length and the closed streets are part of the plan the builders read.
    progress.init(this.plan);
    this.post = post ? new Post(this) : null;
    this.post?.setSize(innerWidth, innerHeight, this.renderer.getPixelRatio());
    if (new URLSearchParams(location.search).get('flip') === '0') flip.enabled = false;
    this.gov = new Governor(this, choice);
    this.gov.apply();
    addEventListener('resize', () => this.resize());
  }

  private pixelRatio(): number {
    return Math.min(devicePixelRatio || 1, this.quality.pixelRatio) * this.ratioScale;
  }

  /** The governor's pixel lever. The canvas and every post target are rebuilt at the new size, so it is called before a frame is drawn, never between passes. */
  setRatioScale(k: number): void {
    if (k === this.ratioScale) return;
    this.ratioScale = k;
    this.resize();
  }

  private resize(): void {
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.post?.setSize(innerWidth, innerHeight, this.renderer.getPixelRatio());
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Build the world. `progress` gets a 0..1 fraction and a line for the loading card. */
  async init(progress: (f: number, label: string) => void = () => {}): Promise<void> {
    progress(0.05, 'Surveying the island');
    await nextFrame();
    this.world = new World(this);
    await this.world.init(async (f, label) => { progress(0.05 + f * 0.6, label); await nextFrame(); });

    progress(0.68, 'Hanging the sun');
    await nextFrame();
    this.sky = new Sky(this);

    progress(0.76, 'Parking badly');
    await nextFrame();
    this.vehicles = new Vehicles(this);
    this.people = new People(this);
    this.people.rag = new Ragdolls(this);
    this.player = new Player(this);
    this.occupants = new Occupants(this);
    this.placeStart();

    progress(0.9, 'Stamping the paperwork');
    await nextFrame();
    this.cam = new CameraRig(this);
    this.hud = new Hud(this);
    this.touchUI = new TouchUI(this);
    this.cheats = new Cheats(this);
    this.systems.push(new Ambient(this));
    this.systems.push((this.fx = new Fx(this)), new Skids(this));
    this.systems.push(new Police(this));
    this.systems.push(this.player.weapons);
    this.systems.push(new ProgressWorks(this));
    this.systems.push((this.todo = new ThingsToDo(this)));
    // Multiplayer (src/net/): inert, and no socket at all, unless a service URL is configured.
    this.systems.push((this.net = new Net(this)));
    // Emotes and horn tunes (fun queue item 9): after the net, so what others did this frame is heard at once.
    this.systems.push((this.emotes = new Emotes(this)));
    this.systems.push(new Leaderboard(this)); // fun queue item 15: the town leaderboard (billboards, menu, town facts)
    this.photo = new Photo(this);
    this.spectate = new Spectate(this);
    // Shader programs compiled in the background before they are first drawn (core/warmup.ts).
    this.systems.push((this.warmup = new ShaderWarmup(this)));
    // Last: it listens to what everything above did this frame.
    this.systems.push((this.audio = new GameAudio(this)));

    // The sky exists now, so the governor's starting step can reach the shadows too.
    this.gov.apply();

    // One full step so every system has seen every other before the first picture.
    this.state = 'title';
    this.cam.snap();
    this.tick(1 / 60);
    this.cam.snap();
    progress(1, 'Ready');
  }

  /** Dess starts on Strand Blvd beside her last tow truck, with the pier at her back. */
  private placeStart(): void {
    const plan = this.plan;
    const feet = plan.sidewalkPoint(5, 6, 2, 0.45);
    const truck = plan.curbPoint(5, 6, 2, 0.45);
    const coupe = plan.curbPoint(5, 6, 2, 0.62);
    const first = [this.vehicles.spawn('tow', truck.x, truck.z, truck.h, 0xe4572e), this.vehicles.spawn('coupe', coupe.x, coupe.z, coupe.h, 0xf0a202)];
    // The owner's car: a black 2017 Bolt at the same kerb, the first thing on the left as the game opens.
    const bolt = plan.curbPoint(5, 6, 2, 0.30);
    first.push(this.vehicles.spawn('bolt', bolt.x, bolt.z, bolt.h, 0x0b0c0e));
    // The owner's other car: a grey 2015 C-Max, always parked at Mercy Park's kerb on Ledger St (the park's south side).
    const cmax = plan.curbPoint(6, 3, 2, 0.5);
    first.push(this.vehicles.spawn('cmax', cmax.x, cmax.z, cmax.h, 0x474a48));
    // A step out from the wall, so the opening camera has room behind her for a full-length boom.
    this.player.teleport(feet.x, feet.z + 0.9, 0);

    // Parked cars are part of the first impression, so they do not wait for the traffic milestone.
    // Every kerb place is noted with the car that belongs in it, parked here or not: in a shared town (src/net/cars.ts)
    // every browser parks the same ones, and a car's place in this list is its number there.
    const rng = new RNG(4021), spots = this.parkSpots, share = 0.55 * this.quality.density;
    for (const s of plan.parking) {
      let roll = rng.next();
      const kind = commonKind(rng.next());
      const tint = rng.next();
      const colors = SPECS[kind].colors;
      const spot: ParkedSpot = { x: s.x, z: s.z, h: s.h, kind, color: colors[Math.floor(tint * colors.length)], roll, v: null };
      spots.push(spot);
      if ((Math.abs(s.x - truck.x) < 16 && Math.abs(s.z - truck.z) < 16) || (Math.abs(s.x - coupe.x) < 9 && Math.abs(s.z - coupe.z) < 9)
        || (Math.abs(s.x - bolt.x) < 9 && Math.abs(s.z - bolt.z) < 9) || (Math.abs(s.x - cmax.x) < 9 && Math.abs(s.z - cmax.z) < 9)) roll = spot.roll = 2;
      if (roll >= share) continue;
      const v = spot.v = this.vehicles.spawn(kind, s.x, s.z, s.h);
      v.color = spot.color;
    }
    // The four that are always there, last in the list.
    for (const v of first) spots.push({ x: v.x, z: v.z, h: v.h, kind: v.spec.kind, color: v.color, roll: 0, v });
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  on<K extends keyof GameEvents>(name: K, fn: Handler<K>): void {
    let a = this.handlers.get(name);
    if (!a) this.handlers.set(name, (a = []));
    a.push(fn as Handler<never>);
  }
  emit<K extends keyof GameEvents>(name: K, data: GameEvents[K]): void {
    const a = this.handlers.get(name);
    if (a) for (const fn of a) (fn as Handler<K>)(data);
  }

  // ── State ──────────────────────────────────────────────────────────────────

  /** Leave the title card and hand the controls over. */
  start(): void {
    if (this.state !== 'title') return;
    this.state = 'play';
    this.input.setEnabled(true);
    this.cam.snap();
    this.emit('start', {});
  }

  /**
   * Multiplayer (net/index.ts): why the player may not pause now, or null. In a town with others a pause makes them
   * untouchable, so it is refused while they are wanted or have just been hurt. Alone it is always null.
   */
  pauseGuard: (() => string | null) | null = null;
  /** The last refusal, for the tests. */
  pauseRefused = '';

  setPaused(on: boolean): void {
    if (this.state !== (on ? 'play' : 'paused')) return;
    if (on) {
      const why = this.pauseGuard ? this.pauseGuard() : null;
      if (why) { this.pauseRefused = why; this.hud.toast(why, 3); return; }
    }
    this.state = on ? 'paused' : 'play';
    if (on) this.input.unlock();
    this.emit('pause', { on });
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /** Simulate one step. Rendering is separate so tests can run thousands of these quickly. */
  tick(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.dt = dt;
    this.frame++;
    this.input.poll();
    if (this.photo?.open) { this.photo.update(dt); this.input.endFrame(); return; }
    // Cheat words get the keys first, so a letter in a word is not also a control (see Cheats.update).
    if (this.state === 'play') this.cheats.update();
    if (this.state === 'play' || this.state === 'paused') {
      if (this.input.eat('pause')) this.setPaused(this.state === 'play');
    }
    const running = this.state === 'play' || this.state === 'title';
    if (running) {
      this.time += dt;
      if (this.state === 'play') this.player.update(dt);
      this.vehicles.update(dt);
      // Between the two: whoever sits in a car is drawn against it as it is drawn this frame.
      this.occupants.place();
      this.people.update(dt);
      this.world.update(dt);
      for (const s of this.systems) s.update(dt);
    }
    this.cam.update(running ? dt : 0);
    this.spectate?.update(dt);
    if (running) {
      this.sky.update(dt);
      const n = this.sky.night;
      if (Math.abs(n - this.lastNight) > 0.004) { this.lastNight = n; this.world.setNight(n); }
    }
    this.hud.update(dt);
    this.touchUI.update(dt);
    this.input.endFrame();
  }

  /**
   * The time (performance.now() clock, ms) of the frame being simulated: the display's frame time from the real-time
   * loop, so things placed by time (the other players, the shared town) move evenly however uneven the work before
   * them is. Frozen (tests stepping by hand) or between frames: the clock itself.
   */
  frameTime(): number {
    const n = performance.now();
    return !this.frozen && this.lastT > 0 && n - this.lastT < 100 ? this.lastT : n;
  }

  render(): void {
    if (this.view) {
      this.camera.position.copy(this.view.pos);
      this.camera.lookAt(this.view.target);
    }
    this.renderer.info.reset();
    // Buffers that changed this frame move to the copy the GPU is not still reading (core/flip.ts).
    flip.swap();
    if (this.post?.enabled) this.post.render();
    else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Start the real-time loop. */
  run(): void {
    this.lastT = performance.now();
    this.gov.begin();
    const loop = (t: number): void => {
      requestAnimationFrame(loop);
      // Before the frame is drawn: a change of size here is never seen half-made.
      this.gov.frame(t);
      const dt = Math.max(0.001, (t - this.lastT) / 1000);
      this.lastT = t;
      this.fps += (1 / dt - this.fps) * 0.05;
      if (!this.frozen) this.tick(dt);
      this.render();
    };
    requestAnimationFrame(loop);
  }
}
