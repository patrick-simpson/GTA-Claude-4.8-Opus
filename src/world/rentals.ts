// Dithers Wheels and Riverside Rides (fun queue 2, item 9): docked rental bicycles and electric kick scooters.
//
// Five docks, each a rack of bikes and scooters on a rubber pad under a sign: Dithers Wheels at the library quad, the
// athletics centre and Cherry Tree St by the pond; Riverside Rides at the footbridge end of the river walk and on Main St. Walk up and
// press F: $1 a ride, free in kid mode. Ride back into any dock and the bike is returned (and you step off); leave it
// somewhere else and it rolls back to a dock with a free place after a couple of minutes of nobody being near it.
//
// The cycles are ordinary vehicles (ent/vehicle.ts, kinds 'bike' and 'scooter': small, light, leaning), so cars treat them as
// small vehicles, other players see them (a rented one is `held`: it stays its rider's, net/held.ts), and phones ride them
// like cars. A crash (the 'impact' event) throws the rider off as a ragdoll (ent/ragdoll.ts); it never costs more than a
// few points of health and nothing at all in kid mode (ent/player.ts damage()).
//
// ent/player.ts asks rentalHook.beforeEnter(v) when F is pressed at a vehicle: that is where the dollar is taken.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { kid } from '../core/kid';
import { money } from '../core/util';
import { groundAt, streetSurface } from './plan';
import { LOOKOUT, pondNear } from './dithersPond';
import { FOOTBRIDGE_Z, RIVER_HW, riverX } from './mainland';
import { SPECS, isCycleKind, type VehicleKind } from '../ent/vehicleSpecs';
import type { Box } from './collide';

const PRICE = 1;
/** A bike left alone this long, and this far from the player, is taken back to a dock, s and m. */
const ROLLBACK_S = 120, ROLLBACK_M = 30;
/** Within this of a dock's middle you are in the dock. */
const DOCK_R = 3.6;
const SLOT_GAP = 0.9;

interface Slot { x: number; z: number; h: number; kind: VehicleKind; rec: Rec | null }
interface Dock { name: string; short: string; x: number; z: number; h: number; slots: Slot[]; board: THREE.Mesh }
interface Rec {
  v: Vehicle; kind: VehicleKind; color: number;
  /** The slot it stands in; null while it is out. */
  slot: Slot | null;
  /** Seconds since it was rented (counted while out). */
  rented: number;
  /** Seconds out with nobody on it. */
  idle: number;
  /** It has been ridden clear of its dock (a return needs that, or the grace). */
  clear: boolean;
}

interface DockDef { name: string; short: string; x: number; z: number; h: number; kinds: VehicleKind[]; exact?: boolean; walk?: boolean }

const B: VehicleKind = 'bike', S: VehicleKind = 'scooter';
// Anchors; clearSpot() nudges each onto open ground. h: the way the bikes face (the row runs across it).
const DEFS: DockDef[] = [
  { name: 'Dithers Wheels', short: 'Library Quad', x: -456, z: -2436, h: 0, kinds: [B, B, S, B] },
  { name: 'Dithers Wheels', short: 'Athletics', x: -538, z: -2602, h: Math.PI / 2, kinds: [S, B, B, S, B] },
  { name: 'Dithers Wheels', short: 'Cherry Tree St', x: -566, z: -2486, h: Math.PI, kinds: [B, S, B, B, S], walk: true },
  { name: 'Riverside Rides', short: 'Footbridge', x: riverX(FOOTBRIDGE_Z) - RIVER_HW - 29, z: FOOTBRIDGE_Z - 6, h: Math.PI, kinds: [B, B, S, B, S] },
  // The east walk of Main St (the road is x 64..77 there, the walk 78..81): the row runs along the kerb, bikes nose to the shopfronts.
  { name: 'Riverside Rides', short: 'Main St', x: 79.6, z: -1905, h: -Math.PI / 2, kinds: [B, S, B, B], walk: true },
];

/** ent/player.ts reads this: F at a docked bike is where the fare is taken. */
export const rentalHook: { beforeEnter: ((v: Vehicle) => boolean) | null; crashed: ((v: Vehicle) => boolean) | null } = { beforeEnter: null, crashed: null };

const SAYS = [
  'Dess has been returned to the pavement, bike first.',
  'Wheels: still turning. Dignity: in transit.',
  'The bike would like a word about your steering.',
  'Helmets are for people who plan to fall. Noted.',
  'A short flight, pedal included.',
  'Dithers Wheels reminds you that the ground is firm.',
];

function boardTexture(name: string, short: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d')!;
  const riv = name.startsWith('Riverside');
  g.fillStyle = riv ? '#14506a' : '#6e1f2a'; g.fillRect(0, 0, 512, 160);
  g.fillStyle = riv ? '#f2e8cf' : '#f0c75a'; g.fillRect(0, 0, 512, 10); g.fillRect(0, 150, 512, 10);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = 'bold 54px sans-serif'; g.fillText(name.toUpperCase(), 256, 68);
  g.font = '28px sans-serif'; g.fillStyle = riv ? '#f2e8cf' : '#f0c75a';
  g.fillText(`${short}  -  $${PRICE} a ride  -  press F`, 256, 118);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Rentals {
  readonly docks: Dock[] = [];
  /** Every cycle this system owns. */
  readonly recs: Rec[] = [];
  private built = false;
  private wait = 0;
  private promptOn = false;
  private pendingCrash: Vehicle | null = null;
  private readonly root = new THREE.Group();
  /** For the tests and the HUD: rides taken, returned, rolled back. */
  readonly stats = { rented: 0, returned: 0, rolledBack: 0, crashed: 0, paid: 0 };

  constructor(private readonly game: Game) {
    this.root.name = 'rental-docks';
    game.scene.add(this.root);
    rentalHook.beforeEnter = (v) => this.beforeEnter(v);
    game.on('impact', (e) => {
      const v = e.vehicle;
      if (isCycleKind(v.spec.kind) && v === game.player.vehicle && e.speed > 3.2 && this.recOf(v)) this.pendingCrash = v;
    });
  }

  private recOf(v: Vehicle): Rec | null { for (const r of this.recs) if (r.v === v) return r; return null; }

  // ── Building ───────────────────────────────────────────────────────────────

  /** Is a dock-sized patch of ground at (x, z), facing h, free of walls, water, roads? */
  private patchOk(x: number, z: number, h: number, n: number, walk: boolean): boolean {
    const g = this.game, s = Math.sin(h), c = Math.cos(h), half = ((n - 1) * SLOT_GAP) / 2 + 0.6;
    const surf = streetSurface();
    for (const [a, b] of [[0, 0], [half, 0], [-half, 0], [half, 1.2], [-half, 1.2], [half, -1.2], [-half, -1.2], [0, 1.9]] as const) {
      const px = x + c * a + s * b, pz = z - s * a + c * b;
      if (pondNear(px, pz) < 3 || groundAt(px, pz) < 1.5) return false;
      // (The lookout's own bench and railing are props, not walls: keep the racks off that pad.)
      if (Math.abs(px - LOOKOUT.x) < LOOKOUT.hx + 2.6 && Math.abs(pz - LOOKOUT.z) < LOOKOUT.hz + 2.6) return false;
      if (surf && surf.probe(px, pz).kind === 'road') return false;
      let hit = false;
      g.col.forBoxes(px, pz, 0.9, (bx: Box) => { if (bx.y0 < groundAt(px, pz) + 2 && bx.y1 > groundAt(px, pz) + 0.3 && px > bx.x0 - 0.7 && px < bx.x1 + 0.7 && pz > bx.z0 - 0.7 && pz < bx.z1 + 0.7) hit = true; });
      if (hit) return false;
      if (walk && surf && surf.probe(px, pz).kind !== 'walk') return false;
    }
    return true;
  }

  /** How many metres ahead of (x, z) facing h a cycle can roll: no step, wall, water or road. Up to 30. */
  runway(x: number, z: number, h: number, walk: boolean): number {
    const g = this.game, s = Math.sin(h), c = Math.cos(h), surf = streetSurface();
    let y0 = groundAt(x, z), n = 1;
    for (; n < 30; n += 1) {
      const px = x + s * n, pz = z + c * n, y = groundAt(px, pz);
      // (Beside the line too: a bank that drops away on one side is no road.)
      const yl = groundAt(px + c * 0.8, pz - s * 0.8), yr = groundAt(px - c * 0.8, pz + s * 0.8);
      if (Math.abs(y - y0) > 0.16 || Math.abs(yl - y) > 0.5 || Math.abs(yr - y) > 0.5 || y < 1.5 || pondNear(px, pz) < 2) break;
      y0 = y;
      if (surf && walk && surf.probe(px, pz).kind === 'road') break;
      let hit = false;
      g.col.forBoxes(px, pz, 0.8, (bx: Box) => { if (bx.y0 < y + 2 && bx.y1 > y + 0.35 && px > bx.x0 - 0.6 && px < bx.x1 + 0.6 && pz > bx.z0 - 0.6 && pz < bx.z1 + 0.6) hit = true; });
      if (hit) break;
    }
    return n;
  }

  /** The nearest patch to the anchor that is open, searching outward, and the way along it that is most open. */
  private clearSpot(d: DockDef): { x: number; z: number; h: number } {
    if (d.exact) return { x: d.x, z: d.z, h: d.h };
    let best = { x: d.x, z: d.z, h: d.h, run: -1 };
    for (const walk of d.walk ? [true, false] : [false]) {
      for (let r = 0; r <= 48; r += 1.5) {
        const steps = r === 0 ? 1 : Math.ceil(r * 1.3);
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2, x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
          // The pad slides about and also turns: eight ways, the dock's own first; the way with the most open ground ahead wins.
          for (let k = 0; k < 8; k++) {
            const h = d.h + k * (Math.PI / 4);
            if (!this.patchOk(x, z, h, d.kinds.length, walk)) continue;
            const run = this.runway(x, z, h, walk) - r * 0.15 - k * 0.5;
            if (run > best.run) best = { x, z, h, run };
            if (run >= 12) return best;
          }
        }
      }
      if (best.run > 6) break;
    }
    return best;
  }

  private build(): void {
    const g = this.game;
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, metalness: 0.6, roughness: 0.4 });
    const pad = new THREE.MeshStandardMaterial({ color: 0x2f3a36, roughness: 0.95 });
    const post = new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.6 });
    for (const d of DEFS) {
      const at = this.clearSpot(d), s = Math.sin(at.h), c = Math.cos(at.h), n = d.kinds.length;
      const gy = groundAt(at.x, at.z);
      const grp = new THREE.Group();
      grp.position.set(at.x, gy, at.z); grp.rotation.y = at.h;
      const len = (n - 1) * SLOT_GAP + 1.5;
      const padM = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 2.5), pad);
      padM.position.set(0, 0.02, 0.1); padM.receiveShadow = true; grp.add(padM);
      // The rail the front wheels stand against, with a post at each end.
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), steel);
      rail.position.set(0, 0.32, 1.0); grp.add(rail);
      for (const x of [-len / 2, len / 2]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.38, 0.07), steel);
        p.position.set(x, 0.19, 1.0); grp.add(p);
      }
      // The sign: a mast at the far end of the rack and a two-sided board.
      const mastX = -len / 2 - 0.3;
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.5, 0.1), post);
      mast.position.set(mastX, 1.25, 0.9); mast.castShadow = true; grp.add(mast);
      const tex = boardTexture(d.name, d.short);
      // Two boards back to back, so the writing reads from either side (one double-sided plane would mirror it behind).
      const bm = new THREE.MeshBasicMaterial({ map: tex });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.53), bm);
      board.position.set(mastX + 0.85, 2.3, 0.93); grp.add(board);
      const back = new THREE.Mesh(board.geometry, bm);
      back.position.set(mastX + 0.85, 2.3, 0.87); back.rotation.y = Math.PI; grp.add(back);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.05), post);
      arm.position.set(mastX + 0.85, 2.58, 0.9); grp.add(arm);
      this.root.add(grp);
      const dock: Dock = { name: d.name, short: d.short, x: at.x, z: at.z, h: at.h, slots: [], board };
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * SLOT_GAP;
        // Facing h, the row runs along across = (cos h, -sin h) and the rail is ahead.
        dock.slots.push({ x: at.x + c * a, z: at.z - s * a, h: at.h, kind: d.kinds[i], rec: null });
      }
      this.docks.push(dock);
      for (const sl of dock.slots) this.rack(sl);
    }
    this.built = true;
    void g;
  }

  /** Stand a cycle in a slot: a fresh vehicle (so a returned one is simply gone, and nobody's network state keeps it). */
  private rack(sl: Slot, kind: VehicleKind = sl.kind, paint = -1): Rec {
    const sp = SPECS[kind];
    const color = paint >= 0 ? paint : sp.colors[(this.recs.length * 3 + 1) % sp.colors.length];
    const v = this.game.vehicles.spawn(kind, sl.x, sl.z, sl.h, color);
    sl.kind = kind;
    const r: Rec = { v, kind, color, slot: sl, rented: 0, idle: 0, clear: false };
    sl.rec = r;
    this.recs.push(r);
    return r;
  }

  /** Take a rec off the street and stand a fresh cycle of its kind and colour in a slot. */
  private dockIt(r: Rec, sl: Slot): void {
    this.drop(r);
    this.rack(sl, r.kind, r.color);
  }

  private drop(r: Rec): void {
    const i = this.recs.indexOf(r);
    if (i >= 0) this.recs.splice(i, 1);
    if (r.slot && r.slot.rec === r) r.slot.rec = null;
    if (!r.v.removed) this.game.vehicles.remove(r.v);
  }

  // ── Renting ────────────────────────────────────────────────────────────────

  private beforeEnter(v: Vehicle): boolean {
    const r = this.recOf(v);
    if (!r || r.slot === null) return true;
    const p = this.game.player, hud = this.game.hud;
    if (!kid.on) {
      if (p.money < PRICE) { hud.toast(`A ride is ${money(PRICE)}. Dess has ${money(Math.max(0, Math.floor(p.money)))}.`, 3.5); return false; }
      p.money -= PRICE; this.stats.paid += PRICE;
    }
    r.slot.rec = null; r.slot = null; r.rented = 0; r.idle = 0; r.clear = false;
    v.held = true;
    this.stats.rented++;
    hud.toast(kid.on ? 'Rented, free in kid mode. Ride into any dock to return it.' : `Rented for ${money(PRICE)}. Ride into any dock to return it. Horn key rings the bell.`, 4);
    return true;
  }

  /** The dock whose pad a point is on (null if none). */
  private dockAt(x: number, z: number, r = DOCK_R): Dock | null {
    for (const d of this.docks) if (Math.hypot(x - d.x, z - d.z) < r) return d;
    return null;
  }

  private freeSlot(d: Dock, v: Vehicle): Slot | null {
    let best: Slot | null = null, bd = 1e9;
    for (const s of d.slots) if (!s.rec) { const q = Math.hypot(s.x - v.x, s.z - v.z); if (q < bd) { bd = q; best = s; } }
    return best;
  }

  /** Nearest dock with a free place to a point, for a bike that is being taken back. */
  private nearestFree(v: Vehicle): { d: Dock; s: Slot } | null {
    let best: { d: Dock; s: Slot } | null = null, bd = 1e9;
    for (const d of this.docks) { const s = this.freeSlot(d, v); if (!s) continue; const q = Math.hypot(d.x - v.x, d.z - v.z); if (q < bd) { bd = q; best = { d, s }; } }
    return best;
  }

  /** The rider is on the pad: hand it back. */
  private giveBack(r: Rec, d: Dock): void {
    const g = this.game, p = g.player, s = this.freeSlot(d, r.v);
    if (!s) { g.hud.toast(`${d.name}, ${d.short}: the dock is full. Try another.`, 3); r.clear = false; r.rented = 0; return; }
    p.exit(true);
    this.dockIt(r, s);
    this.stats.returned++;
    g.hud.toast(`Returned to ${d.name}, ${d.short}. Thanks.`, 3);
  }

  update(dt: number): void {
    const g = this.game;
    // Built a moment after the world (its trees, benches and kerbs are all in the collision grid by then, so the docks keep clear of them).
    if (!this.built) { if (!g.player || !g.vehicles || (this.wait += dt) < 1.5) return; this.build(); }
    const p = g.player, riding = p.vehicle;
    const px = p.person.x, pz = p.person.z;

    // A crash: off you go.
    if (this.pendingCrash) {
      const v = this.pendingCrash; this.pendingCrash = null;
      if (p.vehicle === v) this.throwRider(v);
    }

    for (const r of [...this.recs]) {
      const v = r.v;
      // Burnt, sunk or swept away by a reset: the dock restocks its place (or the nearest free one, for a bike that was out).
      if (v.removed || v.sunk) {
        const t = r.slot ?? this.nearestFree(v)?.s ?? null;
        const kind = r.kind, color = r.color;
        if (!v.removed) this.game.vehicles.remove(v);
        const i = this.recs.indexOf(r);
        if (i >= 0) this.recs.splice(i, 1);
        if (r.slot && r.slot.rec === r) r.slot.rec = null;
        if (t) this.rack(t, kind, color);
        continue;
      }
      if (r.slot) continue;
      if (v === riding) {
        r.rented += dt; r.idle = 0;
        const d = this.dockAt(v.x, v.z);
        if (!d) r.clear = true;
        else if (r.clear) this.giveBack(r, d);
      } else {
        // Nobody on it (but not while she is walking round to it): left in the street. A bike left in a dock's circle is racked at once; elsewhere it waits, then rolls home.
        if (p.goingTo === v) { r.idle = 0; continue; }
        r.idle += dt;
        const d = this.dockAt(v.x, v.z, DOCK_R + 1);
        const far = Math.hypot(v.x - px, v.z - pz) > ROLLBACK_M;
        if (d && r.idle > 2 && v.driver === null && Math.hypot(v.vx, v.vz) < 0.4 && this.freeSlot(d, v)) { this.dockIt(r, this.freeSlot(d, v)!); this.stats.returned++; }
        else if (r.idle > ROLLBACK_S && far) {
          const t = this.nearestFree(v);
          if (t) { this.dockIt(r, t.s); this.stats.rolledBack++; }
        }
      }
    }

    // The prompt at a rack.
    const near = p.nearVehicle ? this.recOf(p.nearVehicle) : null;
    if (near && near.slot && !riding) {
      g.hud.prompt(`F  Rent the ${near.kind === 'bike' ? 'bicycle' : 'e-scooter'} (${kid.on ? 'free in kid mode' : money(PRICE)})`);
      this.promptOn = true;
    } else if (this.promptOn) { g.hud.prompt(null); this.promptOn = false; }
  }

  /** The rider is thrown, a ragdoll, with a joke. Never fatal: a few points off, and none in kid mode. */
  private throwRider(v: Vehicle): void {
    const g = this.game, p = g.player;
    const vx = v.vx, vz = v.vz, sp = Math.hypot(vx, vz);
    p.exit(true);
    // Over the bars: along the way it was going, a little up.
    // (Kid mode: a gentle flop, hardly any speed, just enough hop to show the ragdoll, and she is up again with a laugh.)
    if (kid.on) p.knockDown(vx * 0.3, vz * 0.3, 2.6);
    else p.knockDown(vx * 0.85, vz * 0.85, 2.6 + Math.min(sp * 0.25, 2.2));
    if (!kid.on && p.health > 12) p.damage(Math.min(5, p.health - 12));
    g.cam.shake(0.3);
    v.vx *= 0.3; v.vz *= 0.3;
    this.stats.crashed++;
    g.hud.toast(SAYS[Math.floor(Math.random() * SAYS.length)], 3.5);
  }
}
