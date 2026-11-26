// Fun queue 2, item 49: progress unlocks. Watches two things and keeps them in the save's best table:
//
//   PLACES FOUND   walking or driving through a named district or a spot (game/unlocksData.ts) marks it found, once
//                  (best['ex.<id>'] = 1), with a small toast "Place found: Name (7 of 32)"; the big map fogs the ones not
//                  yet found and ticks the ones that are.
//   UNLOCKS        a milestone read from counters the save already keeps (races finished, snow jobs, ducks found, photos,
//                  college missions, fish, places) earns an item once (best['un.<id>'] = 1) with a toast and a small
//                  fanfare ('moment' kind 'unlock', which audio/ui.ts plays). Nothing is ever taken away, and a save that
//                  already shows a milestone is granted it at once, with one toast for the lot.
//
// Cars are called to your side from the Unlocks page of the pause menu; outfits and garage paints are in the Wardrobe;
// the two stations are on the radio dial. Local only: no protocol bump, no server change, no new fact key. The keys
// live in best, which core/cloud.ts already counts as progress.

import type { Game } from '../core/game';
import { isWater, groundAt } from '../world/plan';
import { save } from './save';
import { UNLOCKS, available, isUnlocked, placeDefs, placeKey, tally, unlockKey, unlockById, type PlaceDef, type UnlockDef } from './unlocksData';
import type { Vehicle } from '../core/api';

export class Unlocks {
  /** For the tests. */
  readonly stats = { places: 0, unlocks: 0, calls: 0 };
  private t = 0;
  private first = true;
  private readonly called = new Map<string, Vehicle>();
  private cache: PlaceDef[] | null = null;

  constructor(private readonly game: Game) {}

  private get best(): Record<string, number> { return save.data.best; }
  defs(): PlaceDef[] { return this.cache ?? (this.cache = placeDefs()); }
  isFound(id: string): boolean { return this.best[placeKey(id)] === 1; }
  foundCount(): number { return this.defs().filter((d) => this.isFound(d.id)).length; }
  total(): number { return this.defs().length; }
  has(id: string): boolean { return isUnlocked(id); }
  earned(): number { return available().filter((u) => isUnlocked(u.id)).length; }

  /** The named areas not yet found (district names, as the chart draws them), for the map's fog. */
  fogged(): Set<string> {
    const s = new Set<string>();
    for (const d of this.defs()) if (d.area && !this.isFound(d.id)) s.add(d.area);
    return s;
  }
  /** The spots, found or not, for the map. */
  spots(): { def: PlaceDef; found: boolean }[] { return this.defs().filter((d) => d.at).map((def) => ({ def, found: this.isFound(def.id) })); }

  /** Mark a place found. True the first time. */
  find(id: string, quiet = false): boolean {
    const d = this.defs().find((q) => q.id === id);
    if (!d || this.isFound(id)) return false;
    this.best[placeKey(id)] = 1;
    this.stats.places++;
    save.write();
    if (!quiet) this.game.hud.toast(`Place found: ${d.name} (${this.foundCount()} of ${this.total()})`, 4);
    return true;
  }

  /** Earn an unlock. True the first time. */
  grant(id: string, quiet = false): boolean {
    const u = unlockById(id);
    if (!u || isUnlocked(id)) return false;
    this.best[unlockKey(id)] = 1;
    this.stats.unlocks++;
    save.write();
    if (!quiet) this.announce(u);
    return true;
  }

  private announce(u: UnlockDef): void {
    const where = u.kind === 'car' ? 'Call it from the pause menu, Unlocks page.' : u.kind === 'station' ? 'Find it on the radio dial.' : u.kind === 'paint' ? 'It is in the Wardrobe: Garage, Colour.' : 'It is in the Wardrobe: Character, Outfits.';
    this.game.hud.toast(`UNLOCKED: ${u.name}. ${where}`, 7);
    this.game.emit('moment', { kind: 'unlock', id: u.id });
  }

  // ── Each frame ──

  update(dt: number): void {
    const g = this.game, p = g.player;
    if (g.state !== 'play') return;
    this.t += dt;
    if (this.t < 0.5) return;
    this.t = 0;
    if (p.health > 0 && Number.isFinite(p.x) && Number.isFinite(p.z)) this.watchPlaces(p.x, p.z);
    this.check();
  }

  private watchPlaces(x: number, z: number): void {
    const name = this.game.plan.placeName(x, z);
    for (const d of this.defs()) {
      if (this.isFound(d.id)) continue;
      if (d.area ? d.area === name : d.at ? Math.hypot(x - d.at.x, z - d.at.z) <= d.at.r : false) this.find(d.id);
    }
  }

  /** Read every milestone. The first pass of a visit grants quietly and tells once. */
  check(): void {
    const t = tally();
    const fresh: UnlockDef[] = [];
    for (const u of available()) {
      if (isUnlocked(u.id)) continue;
      const [have, goal] = u.prog(t);
      if (have >= goal) fresh.push(u);
    }
    if (!fresh.length) { this.first = false; return; }
    if (this.first && fresh.length > 1) {
      for (const u of fresh) this.grant(u.id, true);
      this.game.hud.toast(`Your progress so far earned ${fresh.length} unlocks. See the pause menu, Unlocks page.`, 8);
      this.game.emit('moment', { kind: 'unlock' });
    } else for (const u of fresh) this.grant(u.id);
    this.first = false;
  }

  // ── Cars ──

  /** Put an unlocked car beside her, on foot. Returns a line to show (the reason when it did not happen). */
  call(id: string): { ok: boolean; text: string } {
    const g = this.game, p = g.player, u = unlockById(id);
    if (!u || !u.car || !isUnlocked(id)) return { ok: false, text: 'Not yet unlocked.' };
    if (g.state !== 'play' || !(p.health > 0)) return { ok: false, text: 'Not right now.' };
    if (p.vehicle) return { ok: false, text: 'Get out of your car first.' };
    const gy = groundAt(p.x, p.z);
    if (p.y - gy > 2.5) return { ok: false, text: 'There is no room to park here.' };
    // The one called last time goes away if nobody is in it.
    const old = this.called.get(id);
    if (old && old.driver === null && !old.wreck && g.vehicles.list.includes(old)) g.vehicles.remove(old);
    this.called.delete(id);
    for (const [d, side] of [[7, 0], [9, 0.7], [9, -0.7], [11, 1.4], [11, -1.4], [6, 2.4], [6, -2.4]] as const) {
      const a = p.h + side, x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
      if (isWater(x, z) || Math.abs(groundAt(x, z) - gy) > 1.2) continue;
      if (g.vehicles.nearest(x, z, 4.5)) continue;
      const v = g.vehicles.spawn(u.car.kind, x, z, p.h + Math.PI / 2, u.car.color);
      this.called.set(id, v);
      this.stats.calls++;
      return { ok: true, text: `${u.name} is waiting beside you.` };
    }
    return { ok: false, text: 'There is no room to park here. Try somewhere open.' };
  }

  /** The number of items of each kind earned, for the page. */
  list(): { u: UnlockDef; on: boolean; have: number; goal: number }[] {
    const t = tally();
    return available().map((u) => { const [have, goal] = u.prog(t); return { u, on: isUnlocked(u.id), have: Math.min(have, goal), goal }; });
  }
  all(): readonly UnlockDef[] { return UNLOCKS; }
}
