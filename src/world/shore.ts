// Where the nearest dry land is, from open water: the lifeguard's van, the washed-up card and a ped's swim home.

import { groundAt } from './plan';
import { waterLevelAt } from './mainland';

/** How far above the water the ground must be to count as the shore: not a sandbar a wave could cover. */
const DRY = 0.25;
/** ...and how high at most: a cliff top or a roof is no beach. */
const HIGH = 3.5;

/**
 * The closest spot to (x, z) with dry, low ground under it, searched in widening rings up to `max` metres; `ok` can
 * refuse spots (walls). The spot is nudged 1.5 m inland when that is dry too, so she lands on the sand and not at the
 * waterline. Returns null if there is none in range.
 */
export function nearestShore(x: number, z: number, max = 600, ok?: (x: number, z: number, g: number) => boolean): { x: number; z: number; g: number } | null {
  const dry = (px: number, pz: number): number => {
    const g = groundAt(px, pz);
    return g >= waterLevelAt(px, pz) + DRY && g <= waterLevelAt(px, pz) + HIGH ? g : NaN;
  };
  for (let r = 4; r <= max; r += r < 60 ? 4 : 8) {
    const n = Math.max(10, Math.ceil((Math.PI * 2 * r) / 9));
    const o = (r * 7.31) % 1;
    for (let i = 0; i < n; i++) {
      const a = ((i + o) / n) * Math.PI * 2;
      const dx = Math.sin(a), dz = Math.cos(a);
      let px = x + dx * r, pz = z + dz * r, g = dry(px, pz);
      if (g !== g) continue;
      const ix = px + dx * 1.5, iz = pz + dz * 1.5, ig = dry(ix, iz);
      if (ig === ig) { px = ix; pz = iz; g = ig; }
      if (ok && !ok(px, pz, g)) continue;
      return { x: px, z: pz, g };
    }
  }
  return null;
}
