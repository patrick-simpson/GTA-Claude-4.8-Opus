// Fun queue 2, item 19: weekly town events. A calendar from the real date and the shared town clock (eventCalendar.ts:
// no message, no fact key, the same on every screen), and four evenings in it:
//
//   Wednesday  The Regatta           a buoy course round the harbour from the pier, timed; spectators on the pier.
//   Friday     Derby Night           Flounder Field with floodlights, a banner and a queue at the gate; a double purse,
//                                    "DERBY NIGHT" in the derby's captions, and fireworks after the round (derby.ts asks).
//   Saturday   The Christmas Fair    (holiday season only) Mercy Park: stalls, hot-cocoa stands, carollers round the tree,
//                                    lamps, the tree lighting at the open, and a snowball range.
//   Sunday     The Moose Festival    Quorum Square, Tepid Falls: stalls, a parade, tame moose strolling about (moose.ts
//                                    `festival`), a moose-calling contest (a timing bar) and moose-antler hats for sale.
//
// Each runs in the evening window (game hours 17 to 23). Props exist only while the event is on and the player is near it
// (hidden groups cost no draws), and nothing runs at all while no event is on but a once-a-second calendar check.
// Prizes live in the save's best table: ev.antler (the antler hat), ev.trophy (the regatta trophy), ev.cane (the candy cane
// from the snowball range) and ev.regatta (the best regatta time, seconds); the leaderboard reads ev.regatta.
// ?event=moose|regatta|derby|fair (comma list) forces an event on for a test; the Places panel's Events chip, the map's
// badges, the radar and a toast when one opens nearby all read this class. Kid mode: nothing here hurts anybody.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { holiday } from '../world/holiday';
import { DERBY } from '../world/places';
import { seaY } from '../world/sea';
import { save } from './save';
import { taper } from './activities';
import type { Markers } from './script';
import { DAY_NAMES, EVENT_ORDER, WINDOW, countdown, when, type EventId, type When } from './eventCalendar';
import { People, antlers, banner, floodlight, lampString, signTex, stall } from './eventProps';
import type { Moose } from '../world/moose';

export type { EventId } from './eventCalendar';

const FORCED = ((): Set<string> => {
  try { return new Set((new URLSearchParams(location.search).get('event') ?? '').split(',').filter(Boolean)); } catch { return new Set(); }
})();

interface Info { id: EventId; title: string; where: string; letter: string; blurb: string; x: number; z: number; show: number }
const INFO: Record<EventId, Info> = {
  regatta: { id: 'regatta', title: 'The Regatta', where: 'the harbour, from Pelican Pier', letter: 'G', x: 45, z: 560, show: 420,
    blurb: 'A buoy course round the harbour. Take a boat from the dock and race the clock.' },
  derby: { id: 'derby', title: 'Derby Night', where: 'Flounder Field', letter: 'D', x: DERBY.x, z: DERBY.z, show: 320,
    blurb: 'Crowds, floodlights, a double purse and fireworks after.' },
  fair: { id: 'fair', title: 'The Christmas Fair', where: 'Mercy Park', letter: 'X', x: 179, z: -52, show: 240,
    blurb: 'Stalls, cocoa, carollers, the tree lighting and a snowball range.' },
  moose: { id: 'moose', title: 'The Moose Festival', where: 'Quorum Square, Tepid Falls', letter: 'M', x: STREETS_NEW ? 131 : 20, z: STREETS_NEW ? -1808 : -1452, show: 280,
    blurb: 'Stalls, a parade, moose about town, antler hats and the moose-calling contest.' },
};

// The regatta's course: the buoys in order, then back through the gate.
const GATE = { x: INFO.regatta.x, z: INFO.regatta.z };
const BUOYS: readonly [number, number][] = [[130, 640], [150, 780], [40, 860], [-110, 800], [-140, 690], [-20, 730], [80, 700]];
const BUOY_R = 18, GATE_R = 16;
const COURSE_M = ((): number => { let l = 0, px = GATE.x, pz = GATE.z; for (const [x, z] of [...BUOYS, [GATE.x, GATE.z] as [number, number]]) { l += Math.hypot(x - px, z - pz); px = x; pz = z; } return l; })();
/** Par for the regatta, seconds: a clean run at 20 m/s (the speedboat tops out near 26). */
export const REGATTA_PAR = Math.round(COURSE_M / 20);
const ANTLER_PRICE = 75;
const AT_M = 5;

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const clock = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

interface Stage { group: THREE.Group; update(dt: number): void }
type Mini = null | { kind: 'moose' | 'snow' | 'regatta'; t: number };

/** The Places panel's row for an event. */
export interface EventRow { id: EventId; title: string; day: string; where: string; blurb: string; when: When; text: string; x: number; z: number; letter: string }

export class TownEvents {
  prompt: string | null = null;
  readonly stats = { opened: 0, toasts: 0, moose: 0, regatta: 0, snow: 0, cocoa: 0, shows: 0 };
  /** For tests: skip the "is the window open" check for these. */
  readonly forced = new Set<string>(FORCED);

  private clk = 0;
  private calAt = -1e9;
  private cal = new Map<EventId, When>();
  private was = new Map<EventId, boolean>();
  private told = new Set<string>();
  private readonly stages = new Map<EventId, Stage>();
  private show = new Map<EventId, boolean>();
  private near = new Map<EventId, boolean>();
  private mini: Mini = null;
  private bar: HTMLElement | null = null;
  private antler: THREE.Group | null = null;
  private wearing = ((): boolean => { try { return localStorage.getItem('pc.antlers') !== 'off'; } catch { return true; } })();

  // The moose-calling contest.
  private mRound = 0; private mHits = 0; private mT0 = 0; private mMsg = ''; private mNeedle = 0.5; private mZone = 0.3; private mEnd = 0;
  // The regatta.
  private rLeg = 0; private rGoAt = 0; private rT0 = 0; private rAway = 0; private rTime = 0; private rPhase: 'count' | 'run' = 'count';
  private buoys: THREE.Mesh[] = [];
  // The snowball range.
  private sThrown = 0; private sScore = 0; private sEnd = 0;
  private balls: { m: THREE.Mesh; vx: number; vy: number; vz: number; live: boolean }[] = [];
  private targets: { g: THREE.Group; x: number; y: number; z: number; down: number; pts: number }[] = [];
  private fairShowAt = -1;
  private derbyShow: { at: number; n: number }[] = [];

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    // Mercy Park's south lawn by the promenade (the same spot christmas.ts puts its tree).
    let x0 = Infinity, z1 = -Infinity, x1 = -Infinity;
    for (const b of game.plan.blocks) if (b.district === 'park') { x0 = Math.min(x0, b.rect.x0); x1 = Math.max(x1, b.rect.x1); z1 = Math.max(z1, b.rect.z1); }
    if (Number.isFinite(x0)) { INFO.fair.x = (x0 + x1) / 2 - 14; INFO.fair.z = z1 - 22; }
  }

  // ── The calendar ───────────────────────────────────────────────────────────

  /** When an event runs, from the real date and the town clock. Cached for a second. */
  when(id: EventId): When {
    this.refresh();
    return this.cal.get(id) as When;
  }

  /** Is the event on right now (its evening, or forced by ?event= / a test). */
  on(id: EventId): boolean {
    if (this.forced.has(id)) return true;
    this.refresh();
    return (this.cal.get(id) as When).open;
  }

  private refresh(): void {
    // On the wall clock (the Places panel asks while the game is paused), not the game's.
    const wall = performance.now();
    if (wall - this.calAt < 1000 && this.cal.size) return;
    this.calAt = wall;
    const sky = this.game.sky, hour = sky ? sky.hour : 12, rate = sky ? sky.rate : 1 / 60, now = Date.now(), xmas = holiday.on;
    for (const id of EVENT_ORDER) this.cal.set(id, when(id, now, hour, rate, xmas));
  }

  /** This week's schedule, for the Places panel. */
  rows(): EventRow[] {
    return EVENT_ORDER.map((id) => {
      const i = INFO[id], w = this.forced.has(id) ? { open: true, opensIn: 0, closesIn: 0 } as When : this.when(id);
      const day = id === 'moose' ? 'Sundays' : id === 'regatta' ? 'Wednesdays' : id === 'derby' ? 'Fridays' : 'Saturdays';
      return { id, title: i.title, day, where: i.where, blurb: i.blurb, when: w, text: this.forced.has(id) ? 'on now (forced for a test)' : countdown(w), x: i.x, z: i.z, letter: i.letter };
    }).sort((a, b) => (a.when.opensIn ?? 1e12) - (b.when.opensIn ?? 1e12));
  }

  /** Map badges for the events that are on. */
  badges(): { x: number; z: number; letter: string }[] {
    const out: { x: number; z: number; letter: string }[] = [];
    for (const id of EVENT_ORDER) if (this.on(id)) out.push({ x: INFO[id].x, z: INFO[id].z, letter: INFO[id].letter });
    return out;
  }

  blips(out: Blip[]): void {
    for (const id of EVENT_ORDER) if (this.on(id)) out.push({ x: INFO[id].x, z: INFO[id].z, kind: 'job', label: 'E' });
    if (this.mini?.kind === 'regatta' && this.rPhase === 'run') {
      const t = this.rLeg < BUOYS.length ? BUOYS[this.rLeg] : [GATE.x, GATE.z];
      out.push({ x: t[0], z: t[1], kind: 'goal' });
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.clk += Math.min(dt, 0.25);
    const g = this.game, p = g.player;
    this.prompt = null;
    this.refresh();
    this.announce();
    // Props and crowds: only for an event that is on and near.
    let anyOn = false;
    for (const id of EVENT_ORDER) {
      const i = INFO[id], on = this.on(id), d = Math.hypot(p.x - i.x, p.z - i.z), near = on && d < i.show;
      anyOn = anyOn || on;
      if (near !== (this.show.get(id) ?? false)) { this.show.set(id, near); this.onShow(id, near); }
      const st = this.stages.get(id);
      if (near && !st) this.build(id);
      else if (st) { st.group.visible = near; if (near) st.update(dt); }
      this.near.set(id, near && d < 90);
    }
    const moose = (g as unknown as { moose?: Moose }).moose;
    if (moose) moose.festival = this.show.get('moose') ? { x: INFO.moose.x, z: INFO.moose.z, n: 4 } : null;
    if (anyOn || this.mini || this.derbyShow.length) this.activities(dt);
    this.fireworks();
    this.wear();
  }

  /** Announcements: a toast when an event opens near here, and Claude FM's host a minute before. */
  private announce(): void {
    const p = this.game.player;
    for (const id of EVENT_ORDER) {
      const w = this.cal.get(id) as When, i = INFO[id], open = this.forced.has(id) || w.open;
      if (open && !this.was.get(id)) {
        this.stats.opened++;
        if (Math.hypot(p.x - i.x, p.z - i.z) < 3000 || this.forced.has(id)) { this.game.hud.toast(`${i.title} is on at ${i.where}. ${i.blurb}`, 8); this.stats.toasts++; }
        if (id === 'fair') this.fairShowAt = this.clk + 3;
      }
      this.was.set(id, open);
      if (!open && w.opensIn !== null && w.opensIn < 90 && w.opensIn > 5 && !this.told.has(id + Math.floor(Date.now() / 3600000))) {
        this.told.add(id + Math.floor(Date.now() / 3600000));
        this.game.hud.toast(`Claude FM: ${i.title} opens in about a minute at ${i.where}.`, 7);
        this.stats.toasts++;
      }
    }
  }

  private onShow(id: EventId, on: boolean): void {
    if (id === 'fair' && on && !this.told.has('light')) { this.told.add('light'); this.fairShowAt = this.clk + 2; }
    if (!on && this.mini) {
      const k = this.mini.kind;
      if ((k === 'moose' && id === 'moose') || (k === 'snow' && id === 'fair')) this.endMini(false);
    }
  }

  // ── Stages ─────────────────────────────────────────────────────────────────

  private build(id: EventId): void {
    const g = this.game, group = new THREE.Group();
    group.name = `event-${id}`;
    let update: (dt: number) => void = () => { /* static */ };
    const i = INFO[id], cx = i.x, cz = i.z;
    if (id === 'moose') update = this.buildMoose(group, cx, cz);
    else if (id === 'fair') update = this.buildFair(group, cx, cz);
    else if (id === 'derby') update = this.buildDerby(group);
    else update = this.buildRegatta(group);
    g.scene.add(group);
    this.stages.set(id, { group, update });
  }

  private spot(x: number, z: number): number { return groundAt(x, z); }

  private buildMoose(group: THREE.Group, cx: number, cz: number): (dt: number) => void {
    const labels = ['MAPLE SYRUP', 'POUTINE (NOT SORRY)', 'ANTLER HATS', 'MOOSE JERKY', 'WHOOPIE PIES', 'LOBSTER ROLLS'];
    const cols: [string, string][] = [['#b3262e', '#f2e8cf'], ['#2a7a45', '#f2e8cf'], ['#f0a202', '#14213d'], ['#3d6b9a', '#f2e8cf'], ['#8a3b2e', '#f2e8cf'], ['#e4572e', '#f2e8cf']];
    for (let k = 0; k < 6; k++) {
      const x = cx - 15 + k * 6, z = cz + 16;
      group.add(stall(x, z, Math.PI, cols[k][0], cols[k][1], labels[k]));
    }
    group.add(banner(cx, cz + 20, Math.PI, 'TEPID FALLS MOOSE FESTIVAL', 14, 7.5, '#2a5a3a'));
    // The calling stand: a low stage with a big sign.
    const st = new THREE.Group(); st.position.set(cx, this.spot(cx, cz - 14), cz - 14);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 3.6), new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 })); deck.position.y = 0.3; deck.castShadow = true; st.add(deck);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 1.4), new THREE.MeshBasicMaterial({ map: signTex('MOOSE-CALLING CONTEST', '#14213d', '#f0a202', 768, 192), side: THREE.DoubleSide, toneMapped: false })); board.position.set(0, 3.4, -1.4); st.add(board);
    for (const s of [-1, 1]) { const pole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.2, 0.16), new THREE.MeshStandardMaterial({ color: 0x3a3a3a })); pole.position.set(s * 2.8, 1.6, -1.4); st.add(pole); }
    group.add(st);
    const lamps: { ax: number; az: number; bx: number; bz: number; y: number }[] = [];
    for (let k = 0; k < 5; k++) lamps.push({ ax: cx - 15 + k * 6, az: cz + 16, bx: cx - 9 + k * 6, bz: cz + 16, y: this.spot(cx, cz + 16) + 3.2 });
    group.add(lampString(lamps));
    const parade = new People(16, [0x2a7a45, 0xb3262e, 0xf2e8cf, 0xf0a202, 0x14213d], 21);
    const fans = new People(26, undefined, 22);
    for (let k = 0; k < 26; k++) { const a = (k / 26) * Math.PI * 2, x = cx + Math.cos(a) * 11, z = cz - 14 + 10 + Math.sin(a) * 4.5 + 5; const yaw = Math.atan2(cx - x, cz - 14 - z); fans.put(k, x, this.spot(x, z), z, yaw, 0.95 + (k % 5) * 0.03); }
    fans.commit();
    group.add(parade.mesh, fans.mesh);
    const W = 34, H = 22, P = 2 * (W + H);
    const at = (s: number): { x: number; z: number; yaw: number } => {
      s = ((s % P) + P) % P;
      if (s < W) return { x: cx - W / 2 + s, z: cz - H / 2 + 4, yaw: Math.PI / 2 };
      if (s < W + H) return { x: cx + W / 2, z: cz - H / 2 + 4 + (s - W), yaw: 0 };
      if (s < 2 * W + H) return { x: cx + W / 2 - (s - W - H), z: cz + H / 2 + 4, yaw: -Math.PI / 2 };
      return { x: cx - W / 2, z: cz + H / 2 + 4 - (s - 2 * W - H), yaw: Math.PI };
    };
    return (dt) => {
      const t = this.clk;
      for (let k = 0; k < 16; k++) { const a = at(t * 1.4 + k * 2.4); parade.put(k, a.x, this.spot(a.x, a.z) + Math.abs(Math.sin(t * 5 + k)) * 0.07, a.z, a.yaw); }
      parade.commit();
      void dt;
    };
  }

  private buildFair(group: THREE.Group, cx: number, cz: number): (dt: number) => void {
    const defs: { a: number; r: number; label: string; c: [string, string] }[] = [
      { a: 0.2, r: 17, label: 'HOT COCOA', c: ['#8a3b2e', '#f2e8cf'] }, { a: 1.3, r: 17, label: 'GINGERBREAD', c: ['#b3262e', '#f2e8cf'] },
      { a: 2.4, r: 17, label: 'HOT COCOA', c: ['#2a7a45', '#f2e8cf'] }, { a: 3.5, r: 17, label: 'WREATHS & KNITS', c: ['#14213d', '#f0a202'] },
      { a: 4.6, r: 17, label: 'ROAST CHESTNUTS', c: ['#f0a202', '#14213d'] },
    ];
    for (const d of defs) {
      const x = cx + Math.cos(d.a) * d.r, z = cz + Math.sin(d.a) * d.r;
      group.add(stall(x, z, Math.atan2(cx - x, cz - z), d.c[0], d.c[1], d.label));
    }
    group.add(banner(cx, cz + 24, Math.PI, 'MERCY PARK CHRISTMAS FAIR', 12, 6.5, '#b3262e'));
    const lamps: { ax: number; az: number; bx: number; bz: number; y: number }[] = [];
    for (let k = 0; k < 5; k++) {
      const a = defs[k].a, b = defs[(k + 1) % 5].a, ax = cx + Math.cos(a) * 17, az = cz + Math.sin(a) * 17, bx = cx + Math.cos(b) * 17, bz = cz + Math.sin(b) * 17;
      lamps.push({ ax, az, bx, bz, y: this.spot(cx, cz) + 3.4 });
      lamps.push({ ax, az, bx: cx, bz: cz, y: this.spot(cx, cz) + 4.5 + k * 0.1 });
    }
    group.add(lampString(lamps));
    // The carollers, in a half ring facing the tree; the snowball range to the west.
    const carol = new People(8, [0xb3262e, 0x2a7a45, 0xf2e8cf, 0x14213d], 31);
    const crowd = new People(24, undefined, 32);
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2 + 0.3, r = 9 + (k % 3) * 1.5, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; crowd.put(k, x, this.spot(x, z), z, Math.atan2(cx - x, cz - z), 0.95 + (k % 4) * 0.03); }
    crowd.commit();
    group.add(carol.mesh, crowd.mesh);
    const lx = cx - 30, lz = cz - 4;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1, 4), new THREE.MeshBasicMaterial({ color: 0xf2e8cf })); line.rotation.x = -Math.PI / 2; line.position.set(lx, this.spot(lx, lz) + 0.08, lz); group.add(line);
    group.add(banner(lx + 2, lz - 4.4, -Math.PI / 2, 'SNOWBALL RANGE', 5, 3.6, '#14213d', '#f0a202'));
    const tex = ((): THREE.CanvasTexture => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d') as CanvasRenderingContext2D;
      ['#f2e8cf', '#b3262e', '#f2e8cf', '#b3262e'].forEach((col, k) => { x.fillStyle = col; x.beginPath(); x.arc(64, 64, 62 - k * 15, 0, 7); x.fill(); });
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    this.targets.length = 0;
    for (let k = 0; k < 5; k++) {
      const x = lx - 11 - k * 3.4, z = lz + (k - 2) * 3.2, y = this.spot(x, z), tg = new THREE.Group();
      tg.position.set(x, y, z);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.3, 0.14), new THREE.MeshStandardMaterial({ color: 0x5a3e26 })); post.position.y = 0.65; tg.add(post);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.62, 24), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false })); disc.position.y = 1.5; disc.rotation.y = Math.PI / 2; tg.add(disc);
      group.add(tg);
      this.targets.push({ g: tg, x, y: y + 1.5, z, down: 0, pts: k < 2 ? 1 : k < 4 ? 2 : 3 });
    }
    for (let k = 0; k < 4; k++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
      m.visible = false; group.add(m); this.balls.push({ m, vx: 0, vy: 0, vz: 0, live: false });
    }
    return () => {
      const t = this.clk;
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI - Math.PI * 0.1 + 0.9, r = 5, x = cx + 9 + Math.cos(a) * r * 0.3 + (k - 3.5) * 0.9, z = cz + 6 + Math.sin(a) * 0.2; carol.put(k, x, this.spot(x, z) + Math.abs(Math.sin(t * 3 + k * 0.7)) * 0.09, z, Math.atan2(cx - x, cz - z), 1, Math.sin(t * 1.5 + k) * 0.05); }
      carol.commit();
      for (const tg of this.targets) {
        if (tg.down > 0) { tg.down -= 0.016; tg.g.rotation.z = Math.min(Math.PI / 2, (1 - Math.max(0, tg.down) / 2) * 6); }
        else tg.g.rotation.z = 0;
      }
    };
  }

  private buildDerby(group: THREE.Group): (dt: number) => void {
    const a = DERBY.a + 15, b = DERBY.b + 11;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) group.add(floodlight(DERBY.x + sx * a, DERBY.z + sz * b, DERBY.x, DERBY.z));
    group.add(banner(DERBY.gateX - 6, DERBY.gateZ, -Math.PI / 2, 'DERBY NIGHT', 12, 6.8, '#b3262e'));
    group.add(stall(DERBY.gateX - 12, DERBY.gateZ + 14, Math.PI / 2, '#f0a202', '#14213d', 'HOT DOGS'));
    group.add(stall(DERBY.gateX - 12, DERBY.gateZ - 14, Math.PI / 2, '#2a9d8f', '#f2e8cf', 'FRIED DOUGH'));
    const fans = new People(44, undefined, 41);
    for (let k = 0; k < 44; k++) {
      const t = (k / 44) * Math.PI * 2, x = DERBY.x + Math.cos(t) * (DERBY.a + 9 + (k % 3) * 1.2), z = DERBY.z + Math.sin(t) * (DERBY.b + 7 + (k % 3) * 1.2);
      fans.put(k, x, this.spot(x, z), z, Math.atan2(DERBY.x - x, DERBY.z - z), 0.95 + (k % 4) * 0.03);
    }
    for (let k = 0; k < 12; k++) { const x = DERBY.gateX - 9 - (k % 4) * 0.9, z = DERBY.gateZ - 6 + Math.floor(k / 4) * 4 + (k % 2); fans.put(k, x, this.spot(x, z), z, Math.PI / 2 + (k % 3) * 0.1, 1); }
    fans.commit();
    group.add(fans.mesh);
    return () => {
      const cheer = (this.game.todo.derby.phase === 'fight') ? 0.5 : 0;
      for (let k = 12; k < 44; k++) {
        const t = (k / 44) * Math.PI * 2, x = DERBY.x + Math.cos(t) * (DERBY.a + 9 + (k % 3) * 1.2), z = DERBY.z + Math.sin(t) * (DERBY.b + 7 + (k % 3) * 1.2);
        fans.put(k, x, this.spot(x, z) + cheer * Math.abs(Math.sin(this.clk * 6 + k)) * 0.25, z, Math.atan2(DERBY.x - x, DERBY.z - z), 0.95 + (k % 4) * 0.03);
      }
      fans.commit();
    };
  }

  private buildRegatta(group: THREE.Group): (dt: number) => void {
    // The start gate: two tall poles and a banner across the line.
    const dx = BUOYS[0][0] - GATE.x, dz = BUOYS[0][1] - GATE.z, L = Math.hypot(dx, dz), px = -dz / L, pz = dx / L;
    const wy = seaY(GATE.x, GATE.z);
    const gate = banner(GATE.x, GATE.z, Math.atan2(dx, dz) + Math.PI, 'REGATTA  START / FINISH', 20, 8, '#14213d', '#f0a202', wy);
    group.add(gate);
    void px; void pz;
    const red = new THREE.MeshStandardMaterial({ color: 0xd8372a, roughness: 0.5 }), white = new THREE.MeshStandardMaterial({ color: 0xf2e8cf, roughness: 0.5 });
    this.buoys.length = 0;
    for (let k = 0; k < BUOYS.length; k++) {
      const buoy = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.0, 2.4, 14), k % 2 ? white : red);
      const top = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.1, 14), k % 2 ? red : white); top.position.y = 1.7; buoy.add(top);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd060, toneMapped: false })); lamp.position.y = 2.5; buoy.add(lamp);
      const num = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshBasicMaterial({ map: signTex(String(k + 1), '#14213d', '#f2e8cf', 64, 64), toneMapped: false, side: THREE.DoubleSide })); num.position.set(0, 0.3, 1.03); buoy.add(num);
      buoy.position.set(BUOYS[k][0], seaY(BUOYS[k][0], BUOYS[k][1]) + 0.7, BUOYS[k][1]);
      buoy.castShadow = true;
      group.add(buoy); this.buoys.push(buoy);
    }
    // Spectators along the pier's rails.
    const fans = new People(36, undefined, 51);
    group.add(fans.mesh);
    // The pier's east rail (x 9 is its edge, deck 0.4 m up) and the head's east edge, all facing the course.
    const pier: [number, number, number][] = [];
    for (let k = 0; k < 24; k++) pier.push([k % 2 ? 7.7 : 6.5, 500 + (k >> 1) * 5.3 + (k % 2) * 1.1, Math.PI / 2]);
    for (let k = 24; k < 36; k++) pier.push([32.4 - (k % 2) * 1.1, 606 + (k - 24) * 5, Math.PI / 2]);
    return () => {
      const racing = this.mini?.kind === 'regatta';
      for (let k = 0; k < 36; k++) {
        const [x, z, yaw] = pier[k];
        fans.put(k, x, 0.4 + (racing ? Math.abs(Math.sin(this.clk * 5 + k)) * 0.18 : 0), z, yaw + (k % 3) * 0.12 - 0.12, 0.96);
      }
      fans.commit();
      for (let k = 0; k < this.buoys.length; k++) this.buoys[k].position.y = seaY(BUOYS[k][0], BUOYS[k][1]) + 0.7 + Math.sin(this.clk * 1.7 + k) * 0.08;
    };
  }

  // ── Activities ─────────────────────────────────────────────────────────────

  private dist(id: EventId, x: number, z: number): number { const p = this.game.player; return Math.hypot(p.x - x, p.z - z); }

  private activities(dt: number): void {
    const g = this.game, p = g.player;
    if (this.mini?.kind === 'moose') { this.playMoose(); return; }
    if (this.mini?.kind === 'snow') { this.playSnow(dt); return; }
    if (this.mini?.kind === 'regatta') { this.playRegatta(dt); return; }
    for (const b of this.balls) if (b.live) this.flyBall(b, dt);
    if (!(p.health > 0)) return;
    const free = this.isFree();
    // Moose: the calling stand and the antler stall.
    if (this.near.get('moose') && free && !p.vehicle) {
      const sx = INFO.moose.x, sz = INFO.moose.z - 14 + 3.4;
      this.markers.put(sx, sz, 'job', 4, 20);
      if (this.dist('moose', sx, sz) < 5 && Math.abs(p.speed) < 3) {
        this.prompt = `[G] Moose-calling contest: five calls, press G with the needle in the green · best ${save.count('ev.moose.win')} win${save.count('ev.moose.win') === 1 ? '' : 's'}`;
        if (g.input.eat('interact')) this.startMoose();
      }
      const ax = INFO.moose.x - 15 + 2 * 6, az = INFO.moose.z + 14.2;
      if (this.dist('moose', ax, az) < 3.6) {
        const have = !!save.data.best['ev.antler'];
        this.prompt = have ? 'The antler-hat stall: you already have a pair. They look good on you.' : `[G] Buy a moose-antler hat: $${ANTLER_PRICE}`;
        if (!have && g.input.eat('interact')) {
          if (p.money >= ANTLER_PRICE) { p.money -= ANTLER_PRICE; this.award('antler', 'Moose-antler hat: yours. It is worn on foot, and you can take it off in the Places panel, Events.'); }
          else g.hud.toast(`Antler hats are $${ANTLER_PRICE}. The stall owner is moose-sympathetic, not charitable.`, 4);
        }
      }
    }
    // Fair: the range and the cocoa.
    if (this.near.get('fair') && free && !p.vehicle) {
      const lx = INFO.fair.x - 30, lz = INFO.fair.z - 4;
      this.markers.put(lx, lz, 'job', 3, 18);
      if (this.dist('fair', lx, lz) < 3.2 && Math.abs(p.speed) < 3) {
        this.prompt = `[G] Snowball range: ten snowballs, aim with the camera, G to throw${save.data.best['ev.cane'] ? '' : ' · win the candy cane'}`;
        if (g.input.eat('interact')) this.startSnow();
      }
      for (const d of [0.2, 2.4]) {
        const x = INFO.fair.x + Math.cos(d) * 17, z = INFO.fair.z + Math.sin(d) * 17, sx = x + (INFO.fair.x - x) * 0.14, sz = z + (INFO.fair.z - z) * 0.14;
        if (this.dist('fair', sx, sz) < 3.2) {
          this.prompt = '[G] Hot cocoa: $3';
          if (g.input.eat('interact')) {
            if (p.money >= 3) { p.money -= 3; p.health = Math.min(100, p.health + 15); this.stats.cocoa++; save.bump('ev.cocoa'); g.hud.toast(pick(['Hot cocoa. Marshmallows are structural.', 'Hot cocoa: scalding, then perfect, for nine seconds.', 'You are warm now, and slightly sticky.']), 4); }
            else g.hud.toast('Cocoa is $3. The urn is not on the honour system.', 4);
          }
        }
      }
    }
    // Regatta: the start line.
    if (this.near.get('regatta') || this.on('regatta')) {
      const d = this.dist('regatta', GATE.x, GATE.z);
      if (d < 120 && free) {
        this.markers.put(GATE.x, GATE.z, 'job', 8, 40, 0);
        const boat = p.vehicle && (p.vehicle.spec.kind === 'speedboat' || p.vehicle.spec.kind === 'jetski');
        if (d < 40 && boat && Math.abs(p.speed) < 14) {
          const best = save.data.best['ev.regatta'];
          this.prompt = `[G] Start the Regatta: ${BUOYS.length} buoys, about ${Math.round(COURSE_M)} m, par ${clock(REGATTA_PAR)}${best ? ` · your best ${clock(best)}` : ''}`;
          if (g.input.eat('interact')) this.startRegatta();
        } else if (d < 110 && !boat && !p.vehicle) this.prompt = 'The Regatta is on. Take a boat from the dock at Pelican Pier, then bring it to the start line.';
      }
    }
  }

  private award(what: 'antler' | 'trophy' | 'cane', text: string): boolean {
    const first = !save.data.best['ev.' + what];
    save.data.best['ev.' + what] = 1;
    this.game.hud.stamp(what === 'antler' ? 'MOOSE-ANTLER HAT' : what === 'trophy' ? 'REGATTA TROPHY' : 'CANDY CANE', text);
    this.game.todo.saveNow();
    return first;
  }

  private cash(n: number, key: string): number {
    const g = this.game, pay = Math.round(n * taper(save.count(key)).cash);
    g.player.money += pay; save.credit(pay); save.data.stats.earned += pay;
    return pay;
  }

  // The moose-calling contest.
  private startMoose(): void {
    this.mini = { kind: 'moose', t: 0 };
    this.mRound = 0; this.mHits = 0; this.mT0 = this.clk; this.mMsg = 'Get ready'; this.mEnd = 0;
    this.setBusy('event');
    this.ui(true);
    this.game.hud.stamp('MOOSE-CALLING CONTEST', 'Five calls. Press G while the needle is in the green.');
  }

  /** Needle 0..1, a triangle wave. */
  private needleAt(t: number, round: number): number { const s = (t * (0.55 + round * 0.12)) % 2; return s < 1 ? s : 2 - s; }

  private playMoose(): void {
    const g = this.game, p = g.player;
    if (this.dist('moose', INFO.moose.x, INFO.moose.z - 10.6) > 14 || !(p.health > 0)) { this.endMini(false); return; }
    const t = this.clk - this.mT0 - 1.2;
    if (this.mEnd) { if (this.clk > this.mEnd) this.finishMoose(); this.drawBar(); return; }
    this.mZone = Math.max(0.14, 0.3 - this.mRound * 0.04);
    this.mNeedle = t < 0 ? 0 : this.needleAt(t, this.mRound);
    this.prompt = `Call ${this.mRound + 1} of 5 · G when the needle is in the green`;
    if (t > 0 && g.input.eat('interact')) {
      const hit = Math.abs(this.mNeedle - 0.5) < this.mZone / 2;
      if (hit) { this.mHits++; this.mMsg = Math.abs(this.mNeedle - 0.5) < this.mZone / 6 ? 'PERFECT. Somewhere, a moose looks up.' : 'Good call. Something rustles.'; }
      else this.mMsg = pick(['A crow answers. That is not the target audience.', 'That sounded like a door.', 'Off key. A heron leaves.']);
      this.mRound++; this.mT0 = this.clk - 1.2 + 0.9;
      if (this.mRound >= 5) { this.mEnd = this.clk + 1.4; }
    } else g.input.eat('interact');
    this.drawBar();
  }

  private finishMoose(): void {
    const g = this.game, win = this.mHits >= 3, moose = (g as unknown as { moose?: Moose }).moose;
    this.stats.moose++;
    save.bump('ev.moose');
    if (win) {
      const n = save.bump('ev.moose.win');
      const pay = this.cash(250, 'ev.moose.win');
      const first = this.award('antler', `${this.mHits} of 5 calls. A moose walks out of the trees and agrees with you. Prize: $${pay} and a pair of moose antlers (worn on foot).`);
      if (!first) g.hud.stamp('THE MOOSE ANSWERED', `${this.mHits} of 5 calls · $${pay} · wins: ${n}`);
      void moose;
    } else g.hud.stamp('NOBODY ANSWERED', `${this.mHits} of 5 calls. Three bring a moose. Go again.`);
    this.endMini(true);
  }

  // The snowball range.
  private startSnow(): void {
    this.mini = { kind: 'snow', t: 0 };
    this.sThrown = 0; this.sScore = 0; this.sEnd = 0;
    this.setBusy('event');
    this.game.hud.stamp('SNOWBALL RANGE', 'Ten snowballs. Aim with the camera, G to throw. Near targets are worth 1, far ones 3. Eight points wins.');
  }

  private playSnow(dt: number): void {
    const g = this.game, p = g.player, lx = INFO.fair.x - 30, lz = INFO.fair.z - 4;
    for (const b of this.balls) if (b.live) this.flyBall(b, dt);
    if (this.dist('fair', lx, lz) > 7 || p.vehicle || !(p.health > 0)) { this.endMini(false); return; }
    if (this.sEnd) { if (this.clk > this.sEnd) this.finishSnow(); return; }
    this.prompt = `Snowballs left ${10 - this.sThrown} · points ${this.sScore} · G to throw`;
    g.hud.objective(`Snowball range: ${this.sScore} point${this.sScore === 1 ? '' : 's'}, ${10 - this.sThrown} left`);
    if (g.input.eat('interact') && this.sThrown < 10) {
      const b = this.balls.find((k) => !k.live);
      if (b) {
        const dir = new THREE.Vector3(); g.camera.getWorldDirection(dir);
        dir.y += 0.1; dir.normalize();
        b.m.position.set(p.x, p.y + 1.45, p.z).addScaledVector(dir, 0.6);
        b.vx = dir.x * 24; b.vy = dir.y * 24; b.vz = dir.z * 24; b.live = true; b.m.visible = true;
        this.sThrown++;
        if (this.sThrown >= 10) this.sEnd = this.clk + 2.5;
      }
    }
  }

  private flyBall(b: { m: THREE.Mesh; vx: number; vy: number; vz: number; live: boolean }, dt: number): void {
    b.vy -= 9.8 * dt;
    b.m.position.x += b.vx * dt; b.m.position.y += b.vy * dt; b.m.position.z += b.vz * dt;
    const m = b.m.position;
    for (const t of this.targets) {
      if (t.down > 0) continue;
      if (Math.hypot(m.x - t.x, m.y - t.y, m.z - t.z) < 0.8) {
        t.down = 2;
        const inner = Math.hypot(m.y - t.y, m.z - t.z) < 0.3;
        const pts = t.pts + (inner ? 1 : 0);
        this.sScore += pts;
        this.game.hud.toast(`Hit: +${pts}${inner ? ' (bullseye)' : ''}`, 1.5);
        b.live = false; b.m.visible = false;
        return;
      }
    }
    if (m.y < groundAt(m.x, m.z) + 0.05 || Math.hypot(m.x - this.game.player.x, m.z - this.game.player.z) > 70) { b.live = false; b.m.visible = false; }
  }

  private finishSnow(): void {
    const g = this.game, win = this.sScore >= 8;
    this.stats.snow++;
    save.bump('ev.snow');
    if (win) {
      const n = save.bump('ev.snow.win'), pay = this.cash(200, 'ev.snow.win');
      const first = this.award('cane', `${this.sScore} points. Prize: $${pay} and a candy cane, which is not edible and not for sale.`);
      if (!first) g.hud.stamp('RANGE CHAMPION', `${this.sScore} points · $${pay} · wins: ${n}`);
    } else g.hud.stamp('THE SNOWMAN WINS', `${this.sScore} points. Eight wins. The targets are laughing, quietly.`);
    this.endMini(true);
  }

  // The regatta.
  private startRegatta(): void {
    this.mini = { kind: 'regatta', t: 0 };
    this.rLeg = 0; this.rPhase = 'count'; this.rGoAt = this.clk + 4; this.rAway = 0; this.rTime = 0;
    this.setBusy('event');
    this.game.hud.stamp('THE REGATTA', `${BUOYS.length} buoys round the harbour, then back through the gate · par ${clock(REGATTA_PAR)}`);
  }

  private playRegatta(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle;
    const boat = !!v && (v.spec.kind === 'speedboat' || v.spec.kind === 'jetski');
    if (!boat) { this.rAway += dt; if (this.rAway > 8) { g.hud.toast('You left the boat. The Regatta carries on without you.', 5); this.endMini(false); return; } } else this.rAway = 0;
    if (this.rPhase === 'count') {
      const left = this.rGoAt - this.clk;
      g.hud.timer('Regatta starts in', String(Math.max(1, Math.ceil(left))));
      if (left <= 0) { this.rPhase = 'run'; this.rT0 = this.clk; g.hud.stamp('GO', 'Buoy 1 first. Keep them on your left.'); }
      return;
    }
    this.rTime = this.clk - this.rT0;
    const t = this.rLeg < BUOYS.length ? BUOYS[this.rLeg] : [GATE.x, GATE.z];
    g.hud.timer('Regatta', clock(this.rTime), this.rTime > REGATTA_PAR);
    g.hud.objective(this.rLeg < BUOYS.length ? `Buoy ${this.rLeg + 1} of ${BUOYS.length}` : 'Back through the gate');
    this.markers.put(t[0], t[1], 'goal', 11, 46);
    const d = Math.hypot(p.x - t[0], p.z - t[1]);
    if (this.rLeg < BUOYS.length) { if (d < BUOY_R) { this.rLeg++; g.hud.toast(this.rLeg < BUOYS.length ? `Buoy ${this.rLeg} rounded` : 'Last buoy. Home!', 2); } }
    else if (d < GATE_R) this.finishRegatta();
  }

  private finishRegatta(): void {
    const g = this.game, time = Math.round(this.rTime * 10) / 10, prev = save.data.best['ev.regatta'];
    this.stats.regatta++;
    const under = time <= REGATTA_PAR, rec = prev === undefined || time < prev;
    if (rec) save.data.best['ev.regatta'] = time;
    const n = save.bump('ev.regatta');
    const pay = this.cash(under ? 450 : 140, 'ev.regatta');
    const notes = [`${clock(time)} · par ${clock(REGATTA_PAR)} · $${pay}`, rec ? (prev === undefined ? 'First finish: your time is on the board' : `New best, ${clock(prev - time)} faster`) : `Your best is ${clock(prev as number)}`];
    if (under) { const first = this.award('trophy', `Under par: $${pay} and the Regatta trophy. ${notes[1]}.`); if (!first) g.hud.stamp('UNDER PAR', notes.join(' · ')); }
    else g.hud.stamp('REGATTA FINISHED', `${notes.join(' · ')} · finish ${n}`);
    this.endMini(true);
  }

  private endMini(done: boolean): void {
    void done;
    const g = this.game;
    this.mini = null;
    this.mEnd = 0; this.sEnd = 0;
    g.hud.timer(null); g.hud.objective(null);
    this.ui(false);
    for (const b of this.balls) { b.live = false; b.m.visible = false; }
    this.setBusy(null);
  }

  // ── Prize on the head, fireworks, the page bits ────────────────────────────

  get wearingAntlers(): boolean { return this.wearing; }
  setWearing(on: boolean): void { this.wearing = on; try { localStorage.setItem('pc.antlers', on ? 'on' : 'off'); } catch { /* not kept */ } }
  get hasAntlers(): boolean { return !!save.data.best['ev.antler']; }

  private wear(): void {
    const p = this.game.player, own = !!save.data.best['ev.antler'] && this.wearing;
    if (!own) { if (this.antler) this.antler.visible = false; return; }
    if (!this.antler) { this.antler = antlers(); this.antler.scale.setScalar(0.72); this.game.scene.add(this.antler); }
    const on = !p.vehicle && p.health > 0 && !p.swimming;
    this.antler.visible = on;
    if (on) { this.antler.position.set(p.x, p.y + 1.56, p.z); this.antler.rotation.y = p.h; }
  }

  /** Derby Night: the round is over, the fireworks go up over the field (derby.ts calls this at the podium). */
  derbyOver(): void { this.derbyShow = Array.from({ length: 9 }, (_, k) => ({ at: this.clk + 1 + k * 1.3, n: k })); }

  private fireworks(): void {
    const fw = (this.game as unknown as { fireworks?: { launch(type: string, x: number, y: number, z: number, h: number, c1: number, c2: number, scale: number, local: boolean): void } }).fireworks;
    if (!fw) return;
    const types = ['peony', 'chrys', 'willow', 'palm', 'ring', 'crossette', 'heart', 'glitter', 'strobe'];
    if (this.derbyShow.length && this.clk >= this.derbyShow[0].at) {
      const s = this.derbyShow.shift() as { at: number; n: number };
      const a = (s.n / 9) * Math.PI * 2, x = DERBY.x + Math.cos(a) * 60, z = DERBY.z + Math.sin(a) * 40;
      fw.launch(types[s.n % types.length], x, groundAt(x, z), z, 60 + (s.n % 3) * 14, s.n, s.n + 3, 0.9, false);
      this.stats.shows++;
    }
    if (this.fairShowAt >= 0 && this.clk >= this.fairShowAt && this.show.get('fair')) {
      this.fairShowAt = this.clk + 0.7; this.stats.shows++;
      const k = ++this.stats.shows, x = INFO.fair.x + Math.cos(k) * 12, z = INFO.fair.z + Math.sin(k) * 12;
      fw.launch(types[k % types.length], x, groundAt(x, z), z, 45 + (k % 4) * 8, k, k + 2, 0.75, false);
      if (k > 14) { this.fairShowAt = -1; this.game.hud.toast('The tree is lit. The carollers, who had been waiting, begin.', 6); }
    }
  }

  private ui(on: boolean): void {
    if (!this.bar) {
      const css = document.createElement('style');
      css.textContent = `#ev-bar{position:fixed;left:50%;bottom:22%;transform:translateX(-50%);width:min(420px,84vw);padding:8px 12px;background:rgba(20,20,20,.82);color:#f2e8cf;font:600 14px/1.3 system-ui,sans-serif;border-left:4px solid #f0a202;border-radius:3px;z-index:40;pointer-events:none;display:none}
#ev-bar .t{position:relative;height:18px;background:#3a3a3a;border-radius:2px;margin:6px 0}#ev-bar .z{position:absolute;top:0;bottom:0;background:#2a9d8f;opacity:.9}#ev-bar .n{position:absolute;top:-3px;bottom:-3px;width:4px;margin-left:-2px;background:#f2e8cf;border-radius:2px}`;
      document.head.appendChild(css);
      this.bar = document.createElement('div'); this.bar.id = 'ev-bar';
      this.bar.innerHTML = '<div class="m"></div><div class="t"><div class="z"></div><div class="n"></div></div><div class="s"></div>';
      document.body.appendChild(this.bar);
    }
    this.bar.style.display = on ? 'block' : 'none';
  }

  private drawBar(): void {
    const b = this.bar;
    if (!b) return;
    (b.children[0] as HTMLElement).textContent = `Moose-calling contest · call ${Math.min(5, this.mRound + 1)} of 5 · hits ${this.mHits}`;
    const z = b.querySelector('.z') as HTMLElement, n = b.querySelector('.n') as HTMLElement;
    z.style.left = `${(0.5 - this.mZone / 2) * 100}%`; z.style.width = `${this.mZone * 100}%`;
    n.style.left = `${this.mNeedle * 100}%`;
    (b.children[2] as HTMLElement).textContent = this.mMsg;
  }

  // ── For the tests ──────────────────────────────────────────────────────────

  /** Derby Night is on right now: the derby's captions, purse and fireworks ask. */
  get derbyNight(): boolean { return this.on('derby'); }

  info(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.stats, mini: this.mini?.kind ?? null, forced: [...this.forced], window: WINDOW, par: REGATTA_PAR, course: Math.round(COURSE_M) };
    out.on = EVENT_ORDER.filter((id) => this.on(id));
    out.shown = EVENT_ORDER.filter((id) => this.show.get(id));
    out.schedule = this.rows().map((r) => `${r.title} (${r.day}): ${r.text}`);
    out.moose = { round: this.mRound, hits: this.mHits, needle: +this.mNeedle.toFixed(3), zone: +this.mZone.toFixed(3), msg: this.mMsg };
    out.snow = { thrown: this.sThrown, score: this.sScore, targets: this.targets.map((t) => [Math.round(t.x), Math.round(t.z), t.down > 0]) };
    out.regatta = { leg: this.rLeg, phase: this.rPhase, time: +this.rTime.toFixed(1), buoys: BUOYS, gate: GATE, best: save.data.best['ev.regatta'] ?? null };
    out.prizes = { antler: !!save.data.best['ev.antler'], trophy: !!save.data.best['ev.trophy'], cane: !!save.data.best['ev.cane'] };
    out.sites = INFO;
    out.days = DAY_NAMES;
    return out;
  }
}
