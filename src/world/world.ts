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
import { buildMainlandPlaces } from './mainlandPlaces';
import { buildDithersCampus } from './dithersCampus';
import { STREETS_NEW as CAMPUS_NEW } from './streets';
import { signalState } from './signals';
import { Fireworks } from '../fx/fireworks';
import { Launchers } from './launchers';
import { Moose } from './moose';
import { Fauna } from './fauna';
import { Train } from './train';
import { DuckLoose } from './duckLoose';
import { StuntPark } from './stuntPark';
import { RareWeather } from './rareWeather';
import { buildStreetsOverlay } from './streetsDebug';

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
    const ground = buildGround(g, this.mats, this.group);
    this.parts.push(ground);
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
    await step(0.98, 'Postponing the opera');
    this.parts.push(buildMainlandPlaces(g.plan.mainlandLots, g.plan.lots.length));
    this.boxMarks.push(g.col.allBoxes.length);
    // Dithers College (world/dithersCampus.ts): the campus after the real Mayflower Hill, new streets only.
    if (CAMPUS_NEW) { this.parts.push(buildDithersCampus(g, this.mats, this.group)); this.boxMarks.push(g.col.allBoxes.length); }
    // New streets: the woods go in last, round every wall that now stands (ground.ts dressTown).
    ground.dressTown();
    // Fireworks over Pelican Pier (fx/fireworks.ts): the Saturday and holiday show, and the stall on the pier.
    const fireworks = new Fireworks(g, this.group);
    this.parts.push(fireworks);
    // Cannons and catapults (world/launchers.ts): five machines that put Dess into the sky.
    this.parts.push(new Launchers(g, this.group));
    // Moose crossings (world/moose.ts): bulls, cows and calves on the country roads, from the shared clock.
    this.parts.push(new Moose(g, this.group));
    // Wildlife (world/fauna.ts): deer, geese, gulls and the odd bear, on the same shared clock; none under ?streets=old except the gulls.
    this.parts.push(new Fauna(g, this.group));
    // The Budget Line (world/train.ts): a train on the mainland's rail, on the shared clock; the player can drive it.
    this.parts.push(new Train(g, this.group));
    // Giant rubber duck events (world/duckLoose.ts): the duck breaks loose now and then; push it home for a reward.
    this.parts.push(new DuckLoose(g, this.group, fireworks));
    // Waiver Park (world/stuntPark.ts, stuntRide.ts): the stunt park east of Dock Seven, its loop, wall ride and trick score.
    this.parts.push(new StuntPark(g, this.group));
    // Rare weather (world/rareWeather.ts): now and then a tornado, and the Muddle River flooding Tepid Falls.
    this.parts.push(new RareWeather(g, this.group));
    // ?streetsdebug: the new street graph (streets.ts) drawn as a debug overlay over its ground meshes.
    if (g.plan.streets && new URLSearchParams(location.search).has('streetsdebug')) this.group.add(buildStreetsOverlay(g.plan.streets));
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
    return signalState(this.game.plan.nodes[nodeId], horiz, this.game.signalTime);
  }
}
