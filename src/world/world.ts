// The world, assembled. Each builder owns one slice of the city and hands back
// a WorldPart; this file only strings them together and answers the questions
// other systems ask about the world as a whole.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Signal, WorldApi, WorldPart } from '../core/api';
import { makeTextures } from './textures';
import { makeMaterials, type CityMaterials } from './materials';
import { buildGround } from './ground';
import { buildBuildings } from './buildings';
import { buildLandmarks } from './landmarks';
import { buildPlaces } from './places';
import { buildMainlandBuildings } from './mainlandBuildings';
import { signalState } from './signals';

export class World implements WorldApi {
  readonly group = new THREE.Group();
  mats!: CityMaterials;
  private parts: WorldPart[] = [];
  /** How many collision boxes existed after each builder ran (ground, buildings, landmarks, places): lets a test say whose box is in the road. */
  readonly boxMarks: number[] = [];

  constructor(private game: Game) {
    this.group.name = 'world';
    game.scene.add(this.group);
  }

  /** Built in slices with a breath between them so the loading card can repaint. */
  async init(step: (f: number, label: string) => Promise<void>): Promise<void> {
    const g = this.game;
    await step(0.02, 'Mixing paint');
    const tex = await makeTextures(g.quality);
    this.mats = makeMaterials(tex, g.quality);
    await step(0.2, 'Pouring streets');
    this.parts.push(buildGround(g, this.mats, this.group));
    this.boxMarks.push(g.col.allBoxes.length);
    await step(0.5, 'Raising the skyline');
    this.parts.push(buildBuildings(g, this.mats, this.group));
    this.boxMarks.push(g.col.allBoxes.length);
    await step(0.8, 'Inflating one very large duck');
    this.parts.push(buildLandmarks(g, this.mats, this.group));
    this.boxMarks.push(g.col.allBoxes.length);
    await step(0.92, 'Mowing Mercy Park');
    this.parts.push(buildPlaces(g, this.mats, this.group));
    this.boxMarks.push(g.col.allBoxes.length);
    await step(0.96, 'Laying brick in Tepid Falls');
    this.parts.push(buildMainlandBuildings(g, this.mats, this.group));
    this.boxMarks.push(g.col.allBoxes.length);
    await step(1, 'Sweeping up');
  }

  setNight(n: number): void {
    this.mats.setNight(n);
    for (const p of this.parts) p.setNight?.(n);
  }

  update(dt: number): void {
    // Both are no-ops until the value moves: rain soaks the ground, and the sky re-bakes its reflection map now and then.
    this.mats.setWet(this.game.sky?.wet ?? 0);
    this.mats.setEnv(this.game.scene.environment);
    for (const p of this.parts) p.update?.(dt);
  }

  signal(nodeId: number, horiz: boolean): Signal {
    return signalState(this.game.plan.nodes[nodeId], horiz, this.game.time);
  }
}
