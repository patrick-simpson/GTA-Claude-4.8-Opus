// The game, and the hooks tests drive it with. Fetched by src/main.ts, which has put the title card up already:
// this file and everything it imports (three.js, the world, the menu, the sound) is the large script, and the card
// should not wait for it.

import * as THREE from 'three';
import { Game } from './core/game';
import { assets } from './core/assets';
import { carFiles, wantsCarMaps } from './ent/vehicleAssets';
import { PEOPLE_FILES } from './ent/characterAssets';
import { FLORA_FILES } from './world/floraAssets';
import { PROPS_FILE } from './world/propAssets';
import { MPH } from './core/util';
import { progress } from './world/progress';
import { watchForUpdates } from './core/update';
import { encodeLook, myLook, setMyLook } from './game/looks';
import { hostBotPass, runHostBot } from './net/hostbot';
import { title, titleAt } from './ui/title';
import type { Weather } from './core/api';
import type { VehicleKind } from './ent/vehicleSpecs';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const game = new Game(canvas);

// The downloads start now, under the building of the world, most needed first and a few at a time (core/assets.ts):
// Dess and the people, every car's far level, the street furniture and the trees, then the three cars parked at the
// start; the other kinds follow in order of how common they are. A phone draws only the far levels and the simple
// trees, so it fetches three files and stops. Each list must say what its loader will really ask for.
{
  const qs = new URLSearchParams(location.search), on = (k: string): boolean => qs.get(k) !== '0';
  const low = game.quality.name === 'low';
  const cars = on('glb')
    ? carFiles(low ? 'only' : on('carfar') ? 'first' : 'none', wantsCarMaps(low || !!game.quality.lean, game.renderer.capabilities.maxTextureSize))
    : { far: [], opening: [], later: [] };
  const town = low ? [] : [...(on('props') && on('pbr') ? [PROPS_FILE] : []), ...(on('flora') ? FLORA_FILES : [])];
  const opening = [...(on('people') ? PEOPLE_FILES : []), ...cars.far, ...town, ...cars.opening];
  assets.plan([...opening, ...cars.later], opening.length);
}
title.attach(game);
watchForUpdates(game);

/**
 * Test hooks. Playwright drives the simulation through these instead of
 * waiting on real time: freeze(), then step(n) as many frames as the test needs.
 */
const hooks = {
  game,
  ready: false,
  error: '' as string,
  /** Skip the title card. */
  start(): void { game.start(); },
  /** Stop (or resume) real time driving the simulation. */
  freeze(on = true): void { game.frozen = on; },
  /** Simulate n steps of dt seconds, then draw one frame. */
  step(n = 1, dt = 1 / 60): void {
    for (let i = 0; i < n; i++) game.tick(dt);
    game.render();
  },
  teleport(x: number, z: number, h = 0): void { game.player.teleport(x, z, h); game.cam.snap(); },
  setTime(hour: number): void { game.sky.ask(hour); },
  setWeather(w: Weather): void { game.sky.ask(null, w, true); },
  setHeat(n: number): void { game.player.heat = Math.max(0, Math.min(5, n)); },
  /** The bridge and the mainland's unlock state (src/world/progress.ts): progress.add(points), .spans, .stage, .goal(). */
  progress,
  /**
   * Auto quality (core/governor.ts): `enabled`, `step` (0 is the full preset), `steps` (the ladder), `reason` (why it
   * last changed), `log` (every change with its time, the median frame that caused it and the hitch it cost),
   * `ms`/`longShare` (the last second), `choice` (the starting preset and why), `force(step)`.
   */
  governor: game.gov,
  /** How this visit started: ms the first-visit benchmark took (0 when cached or not needed) and when the title card was built. */
  boot: {
    benchMs: +game.gov.choice.benchMs.toFixed(1), titleAt: +titleAt.toFixed(1),
    /** When the world was built, when the card said "start", and whether everything round the player had arrived by then (or the wait ran out). */
    builtAt: 0, playableAt: 0, openingIn: false,
  },
  /** The download queue: bytes arrived and expected (all files, and the opening view's), and `marks`: when each loader's share of the opening view was in the scene. */
  loads(): Record<string, unknown> { return { ...assets.state(), marks: assets.marks }; },
  /** Build the Perpetual Bridge out to n new spans (0 = the stub in mid-air, 8 = finished). */
  bridge(n: number): void { progress.setSpans(n); },
  /** Open the mainland up to stage n (0 = only the landing, 4 = everything). Finishes the bridge if it is not. */
  stage(n: number): void { progress.setStage(n); },
  /** Spawn a vehicle (default: 8 m ahead of the player) and return its id. */
  spawnVehicle(kind: VehicleKind = 'sedan', x?: number, z?: number, h?: number): number {
    const p = game.player;
    const hh = h ?? p.h;
    const v = game.vehicles.spawn(kind, x ?? p.x + Math.sin(p.h) * 8, z ?? p.z + Math.cos(p.h) * 8, hh);
    return v.id;
  },
  /** Put the player straight into a vehicle: by id, or the nearest one, or a fresh one of `kind`. */
  drive(idOrKind?: number | VehicleKind): number {
    const p = game.player;
    let v = typeof idOrKind === 'number' ? game.vehicles.list.find((c) => c.id === idOrKind) ?? null : null;
    if (!v && typeof idOrKind === 'string') v = game.vehicles.spawn(idOrKind, p.x, p.z, p.h);
    if (!v) v = game.vehicles.nearest(p.x, p.z, 60);
    if (!v) v = game.vehicles.spawn('sedan', p.x, p.z, p.h);
    if (p.vehicle) p.exit();
    p.enter(v, true);
    game.cam.snap();
    return v.id;
  },
  /** Pin the camera for a screenshot: view(x, y, z, tx, ty, tz). Call view() with no arguments to release it. */
  view(x?: number, y?: number, z?: number, tx = 0, ty = 0, tz = 0): void {
    game.view = x === undefined || y === undefined || z === undefined
      ? null
      : { pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(tx, ty, tz) };
  },
  /**
   * Hold every CSS animation at a fraction of its run, so a stamp or toast can be photographed
   * from the frozen harness (they run on the wall clock). No argument lets them play again.
   */
  seekUi(fraction?: number): void {
    for (const a of document.getAnimations()) {
      if (fraction === undefined) { a.play(); continue; }
      const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
      a.pause();
      a.currentTime = end * fraction;
    }
  },
  /** Multiplayer (src/net/index.ts): status ('off' | 'connecting' | 'online' | 'waiting'), own id and name, message counts, and `remotes` with their smoothed positions. */
  net(): Record<string, unknown> { return game.net.info(); },
  /** A new made-up name for this browser (for a later menu button). Returns it. */
  rerollName(): string { return game.net.reroll(); },
  /** The player's look (game/looks.ts): change some fields (as the Wardrobe would), then the descriptor's bytes and the body as drawn. */
  look(change?: Record<string, number>): { bytes: number[]; drawn: string; car: { color: number; finish: number; rims: number } | null } {
    if (change) setMyLook({ ...myLook(), ...change, picked: true });
    const v = game.player.vehicle;
    return { bytes: Array.from(encodeLook(myLook())), drawn: JSON.stringify(game.player.person.look), car: v ? { color: v.color, finish: v.finish ?? 0, rims: v.rims ?? 0 } : null };
  },
  info(): Record<string, unknown> {
    const p = game.player, r = game.renderer.info;
    return {
      state: game.state, time: +game.time.toFixed(2), frame: game.frame, fps: Math.round(game.fps),
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), h: +p.h.toFixed(3),
      speed: +p.speed.toFixed(2), mph: Math.round(p.speed * MPH),
      vehicle: p.vehicle ? p.vehicle.spec.kind : null, onGround: p.vehicle ? p.vehicle.onGround : null,
      swimming: p.swimming, health: p.health, heat: p.heat, money: p.money,
      place: game.plan.placeName(p.x, p.z), street: game.plan.streetAt(p.x, p.z),
      hour: +game.sky.hour.toFixed(2), night: +game.sky.night.toFixed(2), weather: game.sky.weather,
      vehicles: game.vehicles.list.length, people: game.people.list.length,
      traffic: game.vehicles.list.reduce((n, v) => n + (v.driver === 'ai' ? 1 : 0), 0),
      calls: r.render.calls, tris: r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures,
      quality: game.quality.name, spans: progress.spans, stage: progress.stage,
      gov: game.gov.brief(),
    };
  },
};
(window as unknown as { __game: typeof hooks }).__game = hooks;

// `?debug`: one line at the foot of the screen saying what the quality governor is doing and why.
if (new URLSearchParams(location.search).has('debug')) {
  const el = document.createElement('div');
  el.id = 'gov-readout';
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-width:calc(100vw - 16px);padding:3px 8px;background:rgba(10,14,24,.72);color:#f2e8cf;font:12px/1.4 "IBM Plex Mono",monospace;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  document.body.appendChild(el);
  setInterval(() => { el.textContent = `${Math.round(game.fps)} fps · ${game.gov.line()}`; }, 500);
}

/** The longest the card waits, once the world is built, for what is round the player to arrive: a slow line gets a better first picture, not a locked door. */
const HOLD_MS = 10000;
/** The honest part of the label: megabytes of the opening view's files that have really arrived. Empty once they all have. */
const arrived = (): string => {
  const s = assets.state();
  return s.openGot < s.openTotal ? ` · ${(s.openGot / 1e6).toFixed(1)} of ${(s.openTotal / 1e6).toFixed(1)} MB` : '';
};
/** The rule on the card: half is the world being built, half the opening view's bytes arriving. Both are measured. */
const rule = (built: number): number => {
  const s = assets.state();
  return 0.5 * built + 0.5 * (s.openTotal > 0 ? s.openGot / s.openTotal : 1);
};

game.init((f, label) => title.progress(rule(f), label)).then(async () => {
  hooks.ready = true;
  hooks.boot.builtAt = Math.round(performance.now());
  // The mini PC's host bot: the town and nothing else, nothing drawn (net/hostbot.ts).
  if (hostBotPass()) { runHostBot(game); return; }
  // The loop starts under the picture: the first frames compile every shader and send every texture, the longest
  // hitch of the whole game, and the models that arrive during the wait are built into the scene unseen.
  game.run();
  await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 4000))]);
  hooks.boot.openingIn = await assets.opening(HOLD_MS, () => title.progress(rule(1), arrived() ? 'Unloading' + arrived() : 'Unpacking the crates'));
  hooks.boot.playableAt = Math.round(performance.now());
  title.ready();
}).catch((err: unknown) => {
  hooks.error = String((err as Error)?.stack ?? err);
  console.error(err);
  title.progress(0, 'Something sank. Reload to try again.');
});
