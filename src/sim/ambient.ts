// Ambient life: people on the sidewalks and cars in the lanes.
//
// This file only holds the two halves together. `peds.ts` is everyone on foot,
// `traffic.ts` is everyone at a wheel; each frame the walkers are told which
// vehicles are moving, and the drivers are told who is standing in the road.
// Both casts are fixed pools kept in a bubble around the player, so a small
// number fills whichever street is on screen.

import type { Game } from '../core/game';
import { Peds, type Mover } from './peds';
import { Traffic } from './traffic';

export class Ambient {
  readonly peds: Peds;
  readonly traffic: Traffic;
  /** Cost of update() in milliseconds: last, slowest, and a running total for averaging. */
  readonly stats = { ms: 0, max: 0, sum: 0, n: 0 };

  private readonly movers: Mover[] = [];
  private readonly pool: Mover[] = [];
  private lastX = 0; private lastZ = 0;

  constructor(private readonly game: Game) {
    this.peds = new Peds(game);
    this.traffic = new Traffic(game);
    // The driver of a car that has been hit and stopped gets out and runs.
    this.traffic.onBail = (v, x, z) => this.peds.spawnDriver(v, x, z);
    // A crash is heard down the block.
    game.on('impact', (e) => { if (e.speed > 6) this.peds.alarm(e.x, e.z, Math.min(26, 10 + e.speed)); });
  }

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.game, pl = g.player;
    // A teleport (the hospital, a test hook) lands in a street nobody has been moved to yet.
    // Fill it at once and in plain view: an empty street is worse than a sudden one.
    const jx = pl.x - this.lastX, jz = pl.z - this.lastZ, jumped = jx * jx + jz * jz > 2500;
    this.lastX = pl.x; this.lastZ = pl.z;

    const movers = this.movers, pool = this.pool;
    movers.length = 0;
    for (const v of g.vehicles.list) {
      if (v.vx === 0 && v.vz === 0) continue;
      const sp = Math.hypot(v.vx, v.vz);
      if (sp < 0.6) continue;
      const m = pool[movers.length] ?? (pool[movers.length] = { v, sh: 0, ch: 0, sp: 0 });
      m.v = v; m.sh = Math.sin(v.h); m.ch = Math.cos(v.h); m.sp = sp;
      movers.push(m);
    }
    this.peds.update(dt, movers, jumped);
    this.traffic.update(dt, this.peds.road, jumped);

    const s = this.stats, ms = performance.now() - t0;
    s.ms = ms; s.sum += ms; s.n++;
    if (ms > s.max) s.max = ms;
  }
}
