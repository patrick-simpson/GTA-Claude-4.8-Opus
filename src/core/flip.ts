// Two GPU buffers for every instance buffer the game rewrites while it runs.
//
// Milestone 6 measured this on the laptop GPU the game is tuned on (Chrome, ANGLE on Direct3D 11, Intel Iris Xe):
// writing into a buffer the GPU drew from in the frame before makes the new frame wait for that earlier frame to
// finish, so the CPU and the GPU stop working in parallel. A handful of such writes a frame, however small, took
// the real loop from 15.5 ms to 19.5 ms a frame (64 to 51 frames a second); a hundred were no worse than four.
// A buffer last drawn two frames ago is free to write. So each rewritten buffer exists twice over one shared array,
// and a change is sent to the copy that was NOT drawn last frame: that copy is drawn this frame, and the other one
// catches up on the next. A buffer nobody changes stays where it is and costs nothing.
// (scratch/m6/rafprobe.mjs is the measurement: its `flip`, `full` and `noBufUp` rows.)
//
// Use: make the attribute as usual, register it once with how to hang a copy on its mesh or geometry, and mark
// changes with sendRange(), or with needsUpdate on the attribute you registered. Game.render() calls flip.swap()
// once per picture. Anything rewritten every frame that is NOT registered puts the whole frame back in step.

import type { BufferAttribute, BufferGeometry, InstancedBufferAttribute, InstancedMesh } from 'three';

interface Rec {
  /** The one the game marks. */
  a: BufferAttribute;
  /** Its twin over the same array. */
  b: BufferAttribute;
  onB: boolean;
  /** `a.version` when last looked at. */
  seen: number;
  /** How many values last frame's change covered: the copy drawn this frame has not had them yet. */
  prev: number;
  put: (x: BufferAttribute) => void;
}

/** Twin to the attribute the game registered. */
const MASTER = new WeakMap<object, BufferAttribute>();

/** How far into its array an attribute's pending upload reaches. */
function extent(a: BufferAttribute): number {
  const r = a.updateRanges, len = a.array.length;
  if (!r.length) return len;
  let end = 0;
  for (const u of r) if (u.start + u.count > end) end = u.start + u.count;
  return end < len ? end : len;
}

class BufferFlip {
  private recs = new Map<BufferAttribute, Rec>();
  /** Off: one copy of everything, as before M6, for measuring the difference (`game.flip.enabled = false`, or `?flip=0`). */
  enabled = true;

  /** `put` hangs one copy or the other wherever the renderer reads it from. */
  add(a: BufferAttribute, put: (x: BufferAttribute) => void): void {
    if (this.recs.has(a)) return;
    const b = a.clone();
    // clone() copies the numbers; the twin must share them.
    b.array = a.array;
    MASTER.set(b, a);
    this.recs.set(a, { a, b, onB: false, seen: a.version, prev: 0, put });
  }

  /** A geometry's own attribute, by name. */
  geo(g: BufferGeometry, name: string): void {
    this.add(g.getAttribute(name) as BufferAttribute, (x) => { g.setAttribute(name, x); });
  }

  /** An instanced mesh's matrices, and its colours too if they change while the game runs. */
  mesh(m: InstancedMesh, colors = false): void {
    this.add(m.instanceMatrix, (x) => { m.instanceMatrix = x as InstancedBufferAttribute; });
    if (colors && m.instanceColor) this.add(m.instanceColor, (x) => { m.instanceColor = x as InstancedBufferAttribute; });
  }

  remove(a: BufferAttribute | null | undefined): void {
    if (a) this.recs.delete(a);
  }

  /** Once per picture, before it is drawn: every buffer that changed moves to its other copy. */
  swap(): void {
    if (!this.enabled) {
      // Everything back on the copy the game marks; its marks have been piling up there, so nothing is lost.
      for (const r of this.recs.values()) { r.seen = r.a.version; r.prev = 0; if (r.onB) { r.onB = false; r.put(r.a); } }
      return;
    }
    for (const r of this.recs.values()) {
      let c = 0;
      if (r.a.version !== r.seen) { r.seen = r.a.version; c = extent(r.a); }
      const need = c > r.prev ? c : r.prev;
      r.prev = c;
      if (need === 0) continue;
      r.onB = !r.onB;
      if (r.onB) {
        // The twin was last sent two changes ago: it needs this frame's and the one before.
        const u = r.b.updateRanges;
        if (u.length) { if (u[0].count < need) u[0].count = need; } else r.b.addUpdateRange(0, need);
        r.b.needsUpdate = true;
      }
      // Coming back to `a` needs nothing: the game's own marks have been piling up on it since it was last sent.
      r.put(r.onB ? r.b : r.a);
    }
  }
}

export const flip = new BufferFlip();

/**
 * Ask for the first `count` values of a buffer to be uploaded. The range only grows until the renderer has taken it
 * (it empties `updateRanges` when it uploads): several ticks can pass between two pictures. Safe to call with
 * whichever copy a mesh currently holds.
 */
export function sendRange(a: BufferAttribute, count: number): void {
  a = MASTER.get(a) ?? a;
  const r = a.updateRanges;
  if (r.length) { if (r[0].count < count) r[0].count = count; } else a.addUpdateRange(0, count);
  a.needsUpdate = true;
}
