// Traffic signal timing, in one place so the lamps drawn on the poles and the
// rules traffic obeys can never disagree.
//
// 26 s cycle: north-south gets 10 s green and 2.5 s yellow, then half a second
// where everyone is red, then east-west gets the same. `node.phase` staggers
// intersections so the whole city does not change at once.

import type { Signal } from '../core/api';
import type { RoadNode } from './plan';

export const SIGNAL_CYCLE = 26;
const GREEN = 10, YELLOW = 2.5, HALF = SIGNAL_CYCLE / 2;

/** Colour shown to traffic arriving along an east-west (`horiz`) or north-south street. */
export function signalState(node: RoadNode, horiz: boolean, time: number): Signal {
  if (!node.hasLight) return 'green';
  let t = (time + node.phase) % SIGNAL_CYCLE;
  if (horiz) t = (t + HALF) % SIGNAL_CYCLE;
  return t < GREEN ? 'green' : t < GREEN + YELLOW ? 'yellow' : 'red';
}
