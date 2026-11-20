// The one object that owns everything. Subsystems take `game` in their
// constructor and reach each other through it (see core/api.ts for what each
// one promises). The frame order below is the only place that order matters.

import * as THREE from 'three';
import type { GameEvents, GameState, Quality } from './api';
import { Input } from './input';
import { RNG } from './util';
import { CityPlan } from '../world/plan';
import { Colliders } from '../world/collide';
import { World } from '../world/world';
import { Sky } from '../world/sky';
import { Vehicles } from '../ent/vehicle';
import { commonKind } from '../ent/vehicleSpecs';
import { People } from '../ent/character';
import { Player } from '../ent/player';
import { CameraRig } from './camera';
import { Hud } from '../ui/hud';
import { TouchUI } from '../ui/touch';
import { Cheats } from './cheats';
import { Ambient } from '../sim/ambient';
import { Police } from '../sim/police';
import { Post } from './post';
import { Fx } from '../fx/particles';
import { Skids } from '../fx/skids';
import { ProgressWorks, progress } from '../world/progress';
import { ThingsToDo } from '../game/index';
import { savedQuality } from '../game/save';
import { GameAudio } from '../audio/index';

const PRESETS: Record<Quality['name'], Quality> = {
  low: { name: 'low', pixelRatio: 1.5, antialias: false, shadows: false, shadowSize: 1024, drawDist: 520, density: 0.5 },
  medium: { name: 'medium', pixelRatio: 1.5, antialias: true, shadows: true, shadowSize: 2048, drawDist: 800, density: 0.8 },
  high: { name: 'high', pixelRatio: 2, antialias: true, shadows: true, shadowSize: 2048, drawDist: 1100, density: 1 },
};

/** `?q=low|medium|high` wins; otherwise phones get the light preset. Milestone 6 replaces this with a measured choice. */
function pickQuality(): Quality {
  const asked = new URLSearchParams(location.search).get('q') as Quality['name'] | null;
  if (asked && PRESETS[asked]) return PRESETS[asked];
  // The menu's own choice (SETTINGS, kept in the save) comes next.
  const kept = savedQuality();
  if (kept) return PRESETS[kept];
  const phone = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 500;
  return PRESETS[phone ? 'low' : 'high'];
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

type Handler<K extends keyof GameEvents> = (e: GameEvents[K]) => void;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly plan = new CityPlan();
  readonly col = new Colliders();
  readonly quality: Quality = pickQuality();
  /** Ambient occlusion, bloom, the tone map and the grade. Null on the `low` preset and with `?post=0`: a plain render straight to the canvas. */
  readonly post: Post | null;

  world!: World;
  sky!: Sky;
  vehicles!: Vehicles;
  people!: People;
  player!: Player;
  cam!: CameraRig;
  hud!: Hud;
  touchUI!: TouchUI;
  private cheats!: Cheats;
  /** Particles: smoke, sparks, spray. `fx.emitters` is how other systems ask for an effect. */
  fx!: Fx;
  /** Milestone 4: the save, the missions, the jobs and the menu (src/game/). */
  todo!: ThingsToDo;
  /** Milestone 5: every sound in the game (src/audio/). Silent, and no AudioContext at all, until the first key or click. */
  audio!: GameAudio;
  /** Systems from later milestones plug in here until they earn a named slot. Updated after the world, while running. */
  readonly systems: { update(dt: number): void }[] = [];

  state: GameState = 'loading';
  /** Simulated seconds since the world was built. Stops while paused. */
  time = 0;
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

  constructor(readonly canvas: HTMLCanvasElement) {
    const q = this.quality;
    // `low` is the phone preset and pays nothing for post-processing. `?post=0` is the before picture, for comparing.
    const post = q.name !== 'low' && new URLSearchParams(location.search).get('post') !== '0';
    // With post on, the scene is antialiased in its own target; the canvas only ever receives one full-screen triangle.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias && !post, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.pixelRatio));
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
    addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.quality.pixelRatio));
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
    this.player = new Player(this);
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
    // Last: it listens to what everything above did this frame.
    this.systems.push((this.audio = new GameAudio(this)));

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
    this.vehicles.spawn('tow', truck.x, truck.z, truck.h, 0xe4572e);
    this.vehicles.spawn('coupe', coupe.x, coupe.z, coupe.h, 0xf0a202);
    // The owner's car: a black 2017 Bolt at the same kerb, the first thing on the left as the game opens.
    const bolt = plan.curbPoint(5, 6, 2, 0.30);
    this.vehicles.spawn('bolt', bolt.x, bolt.z, bolt.h, 0x0b0c0e);
    // A step out from the wall, so the opening camera has room behind her for a full-length boom.
    this.player.teleport(feet.x, feet.z + 0.9, 0);

    // Parked cars are part of the first impression, so they do not wait for the traffic milestone.
    const rng = new RNG(4021);
    for (const s of plan.parking) {
      const keep = rng.chance(0.55 * this.quality.density);
      const kind = commonKind(rng.next());
      const tint = rng.next();
      if (!keep) continue;
      if (Math.abs(s.x - truck.x) < 16 && Math.abs(s.z - truck.z) < 16) continue;
      if (Math.abs(s.x - coupe.x) < 9 && Math.abs(s.z - coupe.z) < 9) continue;
      if (Math.abs(s.x - bolt.x) < 9 && Math.abs(s.z - bolt.z) < 9) continue;
      const v = this.vehicles.spawn(kind, s.x, s.z, s.h);
      v.color = v.spec.colors[Math.floor(tint * v.spec.colors.length)];
    }
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

  setPaused(on: boolean): void {
    if (this.state !== (on ? 'play' : 'paused')) return;
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
      this.people.update(dt);
      this.world.update(dt);
      for (const s of this.systems) s.update(dt);
    }
    this.cam.update(running ? dt : 0);
    if (running) {
      this.sky.update(dt);
      const n = this.sky.night;
      if (Math.abs(n - this.lastNight) > 0.004) { this.lastNight = n; this.world.setNight(n); }
    }
    this.hud.update(dt);
    this.touchUI.update(dt);
    this.input.endFrame();
  }

  render(): void {
    if (this.view) {
      this.camera.position.copy(this.view.pos);
      this.camera.lookAt(this.view.target);
    }
    this.renderer.info.reset();
    if (this.post?.enabled) this.post.render();
    else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Start the real-time loop. */
  run(): void {
    this.lastT = performance.now();
    const loop = (t: number): void => {
      requestAnimationFrame(loop);
      const dt = Math.max(0.001, (t - this.lastT) / 1000);
      this.lastT = t;
      this.fps += (1 / dt - this.fps) * 0.05;
      if (!this.frozen) this.tick(dt);
      this.render();
    };
    requestAnimationFrame(loop);
  }
}
