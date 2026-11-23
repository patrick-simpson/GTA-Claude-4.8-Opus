// Rare weather (fun queue item 8): the tornado (world/tornado.ts) and the Tepid Falls flood (world/flood.ts) as one
// WorldPart, so world.ts needs one line. Both are scheduled from the shared clock (world/stormSky.ts) and cost a
// comparison a frame while nothing is happening.
//
// Test hooks, from the console or a test: `__storm.tornado.start()`, `__storm.flood.start(4)`, `.stop()`, `.stats`.

import type * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import { Tornado } from './tornado';
import { Flood } from './flood';
import { stormSky } from './stormSky';

export class RareWeather implements WorldPart {
  readonly tornado: Tornado;
  readonly flood: Flood;

  constructor(game: Game, parent: THREE.Group) {
    this.tornado = new Tornado(game, parent);
    this.flood = new Flood(game, parent);
    const sky = stormSky(game);
    (window as unknown as { __storm?: unknown }).__storm = { tornado: this.tornado, flood: this.flood, sky };
  }

  update(dt: number): void {
    this.tornado.update(dt);
    this.flood.update(dt);
  }
}
