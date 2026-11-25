// Fun queue 2, item 21: photo challenges. Photo mode itself is fx/photo.ts (O); this is what the shutter asks.
//
// Each day (the real date, the same everywhere, nothing sent) the town wants four subjects photographed, picked from
// a pool: the civic hall, a church, a school, Johnson Pond, the Perpetual Bridge, the Budget Line train, a Calamity
// Shuttle ferry, a moose, a Harbor Line bus at a stop, and, while one is on, the evening's town event. A shot counts
// when a subject's bounding sphere is in the frame (its middle within 85% of the way to the edge, in front of the
// lens), in range, big enough (its share of the frame height) and not behind a wall (one ray to its middle).
// Pay is tapered like every job; the first picture of each subject earns a ribbon (a small bonus), and all ribbons earn
// the Town Photographer stamp. Saved in the best table beside the events: ph.day and ph.mask (today's done list),
// ph.<subject> (the ribbons), ph.all; counts ph.win and ph.shots. The album of your own thumbnails is local to the
// browser (localStorage, eight of them), not the save.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { civicHero } from '../world/civicHero';
import { POND_SHORE, POND_LEVEL } from '../world/dithersPond';
import { BRIDGE, bridgeY } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { trains } from '../world/train';
import { groundAt } from '../world/plan';
import { save } from './save';
import { taper } from './activities';
import type { Moose } from '../world/moose';

export interface Target { x: number; y: number; z: number; r: number }
interface Subject {
  id: string; name: string; hint: string; pay: number;
  /** Smallest share of the frame height, and the farthest range in metres. */
  min: number; max: number;
  /** The things that would count right now. */
  targets(g: Game, out: Target[]): void;
  /** Is it part of this world at all (it may not be in view)? */
  exists(g: Game): boolean;
}

const pondC = ((): { x: number; z: number } => { let x = 0, z = 0; const n = POND_SHORE.length / 2; for (let i = 0; i < POND_SHORE.length; i += 2) { x += POND_SHORE[i]; z += POND_SHORE[i + 1]; } return { x: x / n, z: z / n }; })();

const hero = (names: string[]) => (g: Game, out: Target[]): void => { void g; if (civicHero) for (const b of civicHero.bounds()) if (names.includes(b.name)) out.push(b); };
const heroExists = (names: string[]) => (): boolean => !!civicHero && civicHero.bounds().some((b) => names.includes(b.name));

export const SUBJECTS: Subject[] = [
  { id: 'hall', name: 'The civic hall', hint: 'the big hall on the mainland: stand back and get all of it in', pay: 120, min: 0.3, max: 260, exists: heroExists(['civic_hall']), targets: hero(['civic_hall']) },
  { id: 'church', name: 'A church steeple', hint: 'any of the three hero churches north of the bridge', pay: 100, min: 0.3, max: 220, exists: heroExists(['church_clap', 'church_gothic', 'church_rom']), targets: hero(['church_clap', 'church_gothic', 'church_rom']) },
  { id: 'school', name: 'A school', hint: 'the elementary or the high school in Tepid Falls', pay: 100, min: 0.3, max: 260, exists: heroExists(['school_elem', 'school_high']), targets: hero(['school_elem', 'school_high']) },
  { id: 'pond', name: 'Johnson Pond', hint: 'the pond at Dithers College, best from the lookout on Cherry Tree St', pay: 90, min: 0.12, max: 260,
    exists: () => STREETS_NEW, targets: (g, out) => { void g; out.push({ x: pondC.x, y: POND_LEVEL + 0.5, z: pondC.z, r: 30 }); } },
  { id: 'bridge', name: 'The Perpetual Bridge', hint: 'the bridge that climbs north out of town and stops', pay: 110, min: 0.2, max: 420,
    exists: () => true, targets: (g, out) => { void g; out.push({ x: BRIDGE.x, y: bridgeY((BRIDGE.z0 - BRIDGE.z1) / 2) + 3, z: (BRIDGE.z0 + BRIDGE.z1) / 2, r: 45 }); } },
  { id: 'train', name: 'The Budget Line train', hint: 'the train on its way between the stations', pay: 140, min: 0.1, max: 220,
    exists: () => !!trains.cur, targets: (g, out) => { void g; const t = trains.cur, m = t ? t.marker() : null; if (m) out.push({ x: m.x, y: groundAt(m.x, m.z) + 3, z: m.z, r: 22 }); } },
  { id: 'ferry', name: 'A Calamity Shuttle ferry', hint: 'the ferry crossing the harbour', pay: 130, min: 0.1, max: 240,
    exists: (g) => g.ferry.ferries.length > 0, targets: (g, out) => { for (const f of g.ferry.ferries) out.push({ x: f.x, y: f.y + 4, z: f.z, r: 14 }); } },
  { id: 'moose', name: 'A moose', hint: 'moose cross the country roads around dusk and dawn; the Moose Festival has some too', pay: 170, min: 0.05, max: 90,
    exists: () => true, targets: (g, out) => { const m = (g as unknown as { moose?: Moose }).moose; if (!m) return; const v = new THREE.Vector3(); for (const o of m.standing()) { o.getWorldPosition(v); out.push({ x: v.x, y: v.y + 1.6, z: v.z, r: 2.4 }); } } },
  { id: 'bus', name: 'A bus at its stop', hint: 'a Harbor Line bus standing at a stop', pay: 90, min: 0.07, max: 100,
    exists: (g) => g.bus.on, targets: (g, out) => { for (const v of g.bus.vehicles) for (const s of g.bus.stations) if (Math.hypot(v.x - s.x, v.z - s.z) < 18) { out.push({ x: v.x, y: v.y + 1.8, z: v.z, r: 6 }); break; } } },
  { id: 'event', name: 'The town event', hint: 'this evening\'s event, while it is on', pay: 160, min: 0.2, max: 220,
    exists: (g) => g.todo.events.rows().some((r) => r.when.open),
    targets: (g, out) => { for (const r of g.todo.events.rows()) if (r.when.open) out.push({ x: r.x, y: groundAt(r.x, r.z) + 5, z: r.z, r: 30 }); } },
];
/** How many the town asks for each day (the event, when on, is on top). */
const PER_DAY = 4;
const ALBUM_KEY = 'pc.album', ALBUM_MAX = 8;

export interface ShotRow { id: string; title: string; hint: string; pay: number; done: boolean; ribbon: boolean; x: number | null; z: number | null }
export interface Album { t: number; img: string; got: string[] }

/** A fixed shuffle by day number, so every screen asks for the same four. */
function dayPick(day: number, ids: string[]): string[] {
  const a = ids.slice();
  let s = (day * 2654435761) >>> 0;
  const rnd = (): number => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, PER_DAY);
}

export class Shots {
  readonly stats = { shots: 0, wins: 0, misses: 0 };
  /** For tests: pretend it is this day. */
  dayOverride: number | null = null;
  private readonly p = new THREE.Vector3();
  private readonly tmp: Target[] = [];

  constructor(private readonly game: Game) {}

  get day(): number { return this.dayOverride ?? Math.floor(Date.now() / 86400000); }

  /** Today's subjects (ids), the event on top when one is open. Rolls the done list over at midnight. */
  today(): string[] {
    const g = this.game, b = save.data.best;
    if (b['ph.day'] !== this.day) { b['ph.day'] = this.day; b['ph.mask'] = 0; }
    const pool = SUBJECTS.filter((s) => s.id !== 'event' && s.exists(g)).map((s) => s.id);
    const ids = dayPick(this.day, pool);
    if (SUBJECTS[SUBJECTS.length - 1].exists(g)) ids.push('event');
    return ids;
  }

  private bit(id: string): number { return 1 << SUBJECTS.findIndex((s) => s.id === id); }
  isDone(id: string): boolean { return (((save.data.best['ph.mask'] ?? 0) as number) & this.bit(id)) !== 0; }
  ribbons(): number { return SUBJECTS.filter((s) => save.data.best['ph.' + s.id]).length; }

  /** The list for the Places panel and the photo form. */
  rows(): ShotRow[] {
    const g = this.game, out: ShotRow[] = [], pl = g.player;
    this.today();
    for (const id of this.today()) {
      const s = SUBJECTS.find((q) => q.id === id) as Subject;
      this.tmp.length = 0; s.targets(g, this.tmp);
      let best: Target | null = null, bd = 1e18;
      for (const t of this.tmp) { const d = Math.hypot(t.x - pl.x, t.z - pl.z); if (d < bd) { bd = d; best = t; } }
      out.push({ id, title: s.name, hint: s.hint, pay: s.pay, done: this.isDone(id), ribbon: !!save.data.best['ph.' + id], x: best ? best.x : null, z: best ? best.z : null });
    }
    return out;
  }

  /** One check of the camera against one subject: '' when it counts, else what is wrong with it. */
  check(s: Subject, cam: THREE.PerspectiveCamera): string {
    const g = this.game;
    this.tmp.length = 0; s.targets(g, this.tmp);
    if (!this.tmp.length) return 'not in sight';
    let why = 'not in the frame';
    const fw = new THREE.Vector3(); cam.getWorldDirection(fw);
    const cp = cam.getWorldPosition(this.p);
    const vfov = (cam.fov * Math.PI) / 180;
    const ndc = new THREE.Vector3();
    for (const t of this.tmp) {
      const dx = t.x - cp.x, dy = t.y - cp.y, dz = t.z - cp.z, d = Math.hypot(dx, dy, dz);
      if (d < 0.5 || dx * fw.x + dy * fw.y + dz * fw.z <= 0) continue;
      if (d > s.max) { why = 'too far away'; continue; }
      ndc.set(t.x, t.y, t.z).project(cam);
      if (Math.abs(ndc.x) > 0.85 || Math.abs(ndc.y) > 0.85) continue;
      if (2 * Math.atan(t.r / d) / vfov < s.min) { why = 'too small in the frame: go closer or zoom in'; continue; }
      // Behind a wall? One ray to its middle: it must reach most of the way.
      const hit = g.col.raycast(cp.x, cp.y, cp.z, dx / d, dy / d, dz / d, d);
      if (hit < d - t.r * 1.15) { why = 'something is in the way'; continue; }
      return '';
    }
    return why;
  }

  /** The shutter: test today's subjects against the camera, pay what counts. Returns lines for the form. */
  take(thumb: string): string[] {
    const g = this.game, cam = g.camera, b = save.data.best, lines: string[] = [];
    this.stats.shots++;
    save.bump('ph.shots');
    const got: string[] = [];
    for (const id of this.today()) {
      const s = SUBJECTS.find((q) => q.id === id) as Subject;
      const why = this.check(s, cam);
      if (why) { if (!this.isDone(id) && /small|way/.test(why)) lines.push(`${s.name}: ${why}`); continue; }
      if (this.isDone(id)) { lines.push(`${s.name}: lovely, but you have it for today`); continue; }
      b['ph.mask'] = ((b['ph.mask'] ?? 0) | this.bit(id));
      const n = save.bump('ph.win');
      let pay = Math.round(s.pay * taper(n - 1).cash);
      const first = !b['ph.' + id];
      if (first) { b['ph.' + id] = 1; pay += 50; }
      g.player.money += pay; save.credit(pay); save.data.stats.earned += pay;
      this.stats.wins++;
      got.push(s.name);
      lines.push(`${s.name}: $${pay}${first ? ' and a photo ribbon' : ''}`);
      g.hud.toast(`Photo challenge: ${s.name}, $${pay}${first ? ', first time: ribbon' : ''}.`, 5);
      if (first) g.emit('moment', { kind: 'photo' });
      if (first && SUBJECTS.every((q) => q.id === 'event' || !q.exists(g) || b['ph.' + q.id])) this.allRibbons(lines);
    }
    if (!got.length) this.stats.misses++;
    if (!lines.length) lines.push('Nothing on today\'s list in this shot.');
    this.albumAdd(thumb, got);
    g.todo.saveNow();
    return lines;
  }

  private allRibbons(lines: string[]): void {
    const g = this.game, b = save.data.best;
    if (b['ph.all']) return;
    b['ph.all'] = 1;
    g.player.money += 500; save.credit(500); save.data.stats.earned += 500;
    lines.push('Every ribbon: TOWN PHOTOGRAPHER, $500');
    g.hud.stamp('TOWN PHOTOGRAPHER', 'a ribbon for every subject, and $500');
  }

  // ── The album: eight thumbnails in this browser only ──

  album(): Album[] {
    try { const a = JSON.parse(localStorage.getItem(ALBUM_KEY) ?? '[]') as Album[]; return Array.isArray(a) ? a.filter((x) => x && typeof x.img === 'string') : []; } catch { return []; }
  }
  private albumAdd(img: string, got: string[]): void {
    if (!img) return;
    const a = this.album();
    a.unshift({ t: Date.now(), img, got });
    a.length = Math.min(a.length, ALBUM_MAX);
    try { localStorage.setItem(ALBUM_KEY, JSON.stringify(a)); } catch { /* full or blocked: the album is a courtesy */ }
  }

  info(): Record<string, unknown> {
    return { day: this.day, today: this.today(), done: this.today().filter((i) => this.isDone(i)), ribbons: this.ribbons(), stats: { ...this.stats } };
  }
}
