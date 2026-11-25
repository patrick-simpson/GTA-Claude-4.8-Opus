// The cab ranks: where a yellow Calamity Courtesy Cab stands waiting (taxi missions, game/taxi.ts). Two of the kerb places
// nearest each rank are given a taxi instead of the dice's car, and are always taken, so every browser parks the same cabs.
// A tiny module of its own: core/game.ts and world/progress.ts use it when they lay out the parked cars.

import type { CityPlan } from '../world/plan';
import { SITES } from '../world/mainland';
import { RAILWAY } from '../world/railway';

interface Spot { x: number; z: number }

/** The ranks of one land (0: the island, 1: Tepid Falls): downtown and the landing, the Depot and the landing across the water. */
export function rankPoints(plan: CityPlan, land: 0 | 1): { x: number; z: number }[] {
  if (land === 0) {
    const down = plan.sidewalkPoint(5, 4, 2, 0.5), land0 = plan.sidewalkPoint(5, 6, 2, 0.45), strand = plan.sidewalkPoint(3, 5, 2, 0.5);
    return [down, land0, strand];
  }
  return [{ x: RAILWAY ? RAILWAY.depot.x - 4.4 : 170, z: RAILWAY ? RAILWAY.depot.z : -2124.5 }, { x: SITES.landing.x, z: SITES.landing.z }];
}

/** The kerb places that are cab ranks: the two nearest each rank point, within 70 m of it. */
export function cabSpots<T extends Spot>(plan: CityPlan, spots: readonly T[], land: 0 | 1): Set<T> {
  const out = new Set<T>();
  for (const r of rankPoints(plan, land)) {
    const near = spots.filter((s) => !out.has(s) && Math.hypot(s.x - r.x, s.z - r.z) < 70).sort((a, b) => Math.hypot(a.x - r.x, a.z - r.z) - Math.hypot(b.x - r.x, b.z - r.z));
    for (let i = 0; i < Math.min(2, near.length); i++) out.add(near[i]);
  }
  return out;
}
