// Entry point: fonts, the title card, the game, and the hooks tests drive it with.
//
// The font imports have no .css extension on purpose: the packages' export map
// adds it, and Vite fails to resolve the path when it is written out.

import '@fontsource/big-shoulders-display/latin-700';
import '@fontsource/big-shoulders-display/latin-900';
import '@fontsource/barlow-semi-condensed/latin-400';
import '@fontsource/barlow-semi-condensed/latin-500';
import '@fontsource/barlow-semi-condensed/latin-600';
import '@fontsource/ibm-plex-mono/latin-400';
import '@fontsource/ibm-plex-mono/latin-500';
import '@fontsource/ibm-plex-mono/latin-600';
import './ui/base.css';

import * as THREE from 'three';
import { Game } from './core/game';
import { MPH } from './core/util';
import { Title } from './ui/title';
import type { Weather } from './core/api';
import type { VehicleKind } from './ent/vehicleSpecs';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const game = new Game(canvas);
const title = new Title(game);

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
  setTime(hour: number): void { game.sky.hour = ((hour % 24) + 24) % 24; },
  setWeather(w: Weather): void { game.sky.setWeather(w, true); },
  setHeat(n: number): void { game.player.heat = Math.max(0, Math.min(5, n)); },
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
      calls: r.render.calls, tris: r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures,
      quality: game.quality.name,
    };
  },
};
(window as unknown as { __game: typeof hooks }).__game = hooks;

game.init((f, label) => title.progress(f, label)).then(() => {
  hooks.ready = true;
  title.ready();
  game.run();
}).catch((err: unknown) => {
  hooks.error = String((err as Error)?.stack ?? err);
  console.error(err);
  title.progress(0, 'Something sank. Reload to try again.');
});
