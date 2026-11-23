// Slow, continual progress: the Perpetual Bridge is finished one span at a time,
// and then Tepid Falls opens one district at a time.
//
// One pool of points feeds a fixed list of goals, in order: the eight spans, then
// the four stages of the town. Points come from three places:
//   - money paid at a collection box (one dollar is one point): the Bridge
//     Completion Fund at the island foot of the bridge, and once the bridge is
//     done, the Tepid Falls Improvement Fund at the landing;
//   - a trickle from play itself (distance driven);
//   - anything else that calls progress.add(points): missions, jobs, collectibles.
//
// `progress` is the state and is created with the module, because the plan has to
// know which streets are closed before the world is built. ProgressWorks is what
// the player sees of it in the world: the two boxes and the barriers across the
// streets that are not open yet. The bridge itself is drawn by landmarks.ts,
// which listens with progress.onChange().
//
// In a shared town (the main multiplayer service; net/town.ts) what is drawn is the TOWN's bridge and stages, the
// same for everybody there. The player's own progress is kept apart in `mine`, goes on being counted with every point
// they earn, and is the only thing ever saved here: see showTown() and add().
//
// State is kept in localStorage. `?bridge=N` and `?stage=N` in the address
// override it for one visit without saving (the test harness uses them).

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Box } from './collide';
import { Batch } from './batch';
import type { Vehicle } from '../core/api';
import { RNG, money } from '../core/util';
import { commonKind, type VehicleKind } from '../ent/vehicleSpecs';
import { BRIDGE_SPANS, groundAt, roadY, setBridgeSpans, type CityPlan } from './plan';
import { SITES, STAGE_NAMES, TOWN_NAME } from './mainland';

const KEY = 'portcalamity.progress.v1';
export const STAGES = 4;
/** Price of span k (1..BRIDGE_SPANS) and of stage n (1..STAGES), in points. A dollar at the box is a point. */
export const spanCost = (k: number): number => 250 + 100 * (k - 1);
export const stageCost = (n: number): number => 800 + 400 * n;
/** Meters driven per point of trickle. */
const DRIVE_M = 60;

export type ProgressChange = 'bridge' | 'stage';
/** How far along: spans, stage, and the points held toward the next goal. */
export interface Stand { spans: number; stage: number; bank: number }
/** The town this browser is in (net/town.ts). */
export interface TownSink {
  /** Points earned at this keyboard, for the town's host to count as well. */
  give(points: number): void;
}

/** Which of two is further along? Negative, zero or positive, as a sort would have it. */
export function cmpStand(a: Stand, b: Stand): number { return a.spans - b.spans || a.stage - b.stage || Math.floor(a.bank) - Math.floor(b.bank); }

/** What `s` is working toward: the goal's kind, number and price, or null when everything is open. */
function goalOf(s: Stand): { kind: ProgressChange; n: number; cost: number } | null {
  if (s.spans < BRIDGE_SPANS) return { kind: 'bridge', n: s.spans + 1, cost: spanCost(s.spans + 1) };
  if (s.stage < STAGES) return { kind: 'stage', n: s.stage + 1, cost: stageCost(s.stage + 1) };
  return null;
}

/** Count points onto a stand that nothing is drawn from. Returns how many goals it finished. */
function advance(s: Stand, points: number): number {
  s.bank += points;
  let done = 0;
  for (let g = goalOf(s); g && s.bank >= g.cost; g = goalOf(s)) {
    s.bank -= g.cost;
    if (g.kind === 'bridge') s.spans++; else s.stage++;
    done++;
  }
  if (!goalOf(s)) s.bank = 0;
  return done;
}
export interface Goal { kind: ProgressChange; n: number; label: string; cost: number; have: number }

class Progress {
  /** New spans built, 0..BRIDGE_SPANS. 0 is the original stub that stops in mid-air. */
  spans = 0;
  /** Stages of the mainland open, 0..STAGES. Stage n opens every street whose `stage` is n or less. */
  stage = 0;
  /** Points held toward the goal in hand. */
  bank = 0;
  /** Every point ever earned, for a readout. */
  total = 0;
  /**
   * This player's OWN progress while the town's is on the screen (spans, stage and bank above are then the town's).
   * null: what is shown is their own. Once set it stays for the visit, so that a span never vanishes from under a car
   * when the connection drops; the next visit starts from what is saved, which is always their own.
   */
  mine: Stand | null = null;
  /** The town being played in right now, or null (alone, or on the backup service). */
  sink: TownSink | null = null;
  /** True while a change is being shown that nobody here earned (joining a town): no fanfare for it. */
  quiet = false;
  private plan: CityPlan | null = null;
  private game: Game | null = null;
  private listeners: ((what: ProgressChange) => void)[] = [];
  private saving = true;

  /** Called once by Game before the world is built. */
  init(plan: CityPlan): void {
    this.plan = plan;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Progress>;
        this.spans = clampInt(s.spans, 0, BRIDGE_SPANS);
        this.stage = this.spans < BRIDGE_SPANS ? 0 : clampInt(s.stage, 0, STAGES);
        this.bank = Math.max(0, Number(s.bank) || 0);
        this.total = Math.max(0, Number(s.total) || 0);
      }
    } catch { /* private browsing, or a save from some other shape: start from nothing */ }
    const q = new URLSearchParams(location.search), qb = q.get('bridge'), qs = q.get('stage');
    if (qb !== null || qs !== null) {
      this.saving = false;
      this.stage = clampInt(qs ?? 0, 0, STAGES);
      this.spans = this.stage > 0 ? BRIDGE_SPANS : clampInt(qb ?? 0, 0, BRIDGE_SPANS);
      this.bank = 0;
    }
    this.apply();
  }

  /** The HUD and the world arrive later than the plan. */
  attach(game: Game): void { this.game = game; }

  get complete(): boolean { return this.spans >= BRIDGE_SPANS; }
  get allDone(): boolean { return this.complete && this.stage >= STAGES; }
  /** Goals finished out of all of them, 0..1, for a progress readout. */
  get fraction(): number { return (this.spans + this.stage) / (BRIDGE_SPANS + STAGES); }

  /** What the points are going toward right now, or null when everything is open. */
  goal(): Goal | null {
    if (!this.complete) {
      const n = this.spans + 1;
      return { kind: 'bridge', n, label: `Span ${n} of ${BRIDGE_SPANS}`, cost: spanCost(n), have: this.bank };
    }
    if (this.stage < STAGES) {
      const n = this.stage + 1;
      return { kind: 'stage', n, label: STAGE_NAMES[n], cost: stageCost(n), have: this.bank };
    }
    return null;
  }

  /** This player's own progress, whatever is on the screen. */
  own(): Stand { return this.mine ?? this; }

  /**
   * Show the town's bridge and stages instead of this player's own. Never backward: a stand behind what is already
   * on the screen is refused (false). `announce`: somebody in town has just earned it, so say so as if it were earned here.
   */
  showTown(t: Stand, announce: boolean): boolean {
    const spans = clampInt(t.spans, 0, BRIDGE_SPANS), stage = spans < BRIDGE_SPANS ? 0 : clampInt(t.stage, 0, STAGES);
    const to: Stand = { spans, stage, bank: Math.max(0, Number(t.bank) || 0) };
    if (!goalOf(to)) to.bank = 0;
    if (this.mine && cmpStand(to, this) < 0) return false;
    if (!this.mine) {
      this.mine = { spans: this.spans, stage: this.stage, bank: this.bank };
      if (cmpStand(to, this) < 0) return false;
    }
    const bridge = to.spans !== this.spans, staged = to.stage !== this.stage;
    this.spans = to.spans; this.stage = to.stage; this.bank = to.bank;
    if (!bridge && !staged) return true;
    this.apply();
    this.quiet = !announce;
    try {
      if (announce && this.game?.state === 'play') this.announce(staged ? { kind: 'stage', n: stage, label: STAGE_NAMES[stage], cost: 0, have: 0 } : { kind: 'bridge', n: spans, label: '', cost: 0, have: 0 });
      if (bridge) this.emit('bridge');
      if (staged) this.emit('stage');
    } finally { this.quiet = false; }
    return true;
  }

  /** Host of a town: points another player earned there. Counted on what is shown, not on this player's own. */
  addTown(points: number): number { return points > 0 ? this.count(points) : 0; }

  /**
   * Earn progress. Missions and activities call this; so do the collection boxes and the trickle. Returns how many
   * goals it finished on the screen. In a town the points count twice over: on the player's own progress (saved, not
   * shown) and on the town's (shown; every browser counts its own at once, and the host is told so that it counts for all).
   */
  add(points: number): number {
    if (!(points > 0)) return 0;
    this.total += points;
    if (this.mine && advance(this.mine, points) > 0) this.save();
    if (this.mine) this.sink?.give(points);
    return this.count(points);
  }

  /**
   * Earn progress for this player alone: in a town, their own (saved) progress and not the town's. A helper's share of
   * a mission done together (net/crew.ts): the starter's browser has already counted the mission for the town once.
   * Alone, the same as add().
   */
  addOwn(points: number): number {
    if (!(points > 0)) return 0;
    if (!this.mine) return this.add(points);
    this.total += points;
    if (advance(this.mine, points) > 0) this.save();
    return 0;
  }

  private count(points: number): number {
    this.bank += points;
    let done = 0;
    for (let g = this.goal(); g && this.bank >= g.cost; g = this.goal()) {
      this.bank -= g.cost;
      if (g.kind === 'bridge') this.spans++; else this.stage++;
      this.apply();
      this.announce(g);
      this.emit(g.kind);
      done++;
    }
    if (!this.goal()) this.bank = 0;
    if (done > 0) this.save();
    return done;
  }

  /** Write the bank down now. add() only saves when a goal completes; the works save the trickle every so often. */
  save(): void {
    if (!this.saving) return;
    // Their own, never the town's.
    const o = this.own();
    try { localStorage.setItem(KEY, JSON.stringify({ spans: o.spans, stage: o.stage, bank: Math.floor(o.bank), total: Math.floor(this.total) })); } catch { /* no storage */ }
  }

  /** Tests and cheats: put the bridge at n spans. Going below the full bridge closes the town again. */
  setSpans(n: number): void {
    const v = clampInt(n, 0, BRIDGE_SPANS);
    // With the town's on the screen this changes the player's own; the town takes it up if it is further (net/town.ts).
    const m = this.mine;
    if (m) {
      const st = v < BRIDGE_SPANS ? 0 : m.stage;
      if (v !== m.spans || st !== m.stage) { m.spans = v; m.stage = st; m.bank = 0; this.save(); }
      return;
    }
    const stage = v < BRIDGE_SPANS ? 0 : this.stage;
    const staged = stage !== this.stage;
    if (v === this.spans && !staged) return;
    this.spans = v; this.stage = stage; this.bank = 0;
    this.apply(); this.save();
    this.emit('bridge');
    if (staged) this.emit('stage');
  }

  /** Tests and cheats: open the mainland up to stage n. Any stage at all needs the whole bridge. */
  setStage(n: number): void {
    const v = clampInt(n, 0, STAGES);
    const m = this.mine;
    if (m) {
      if (v !== m.stage || (v > 0 && m.spans < BRIDGE_SPANS)) { m.stage = v; m.bank = 0; if (v > 0) m.spans = BRIDGE_SPANS; this.save(); }
      return;
    }
    const bridged = v > 0 && !this.complete;
    if (v === this.stage && !bridged) return;
    this.stage = v; this.bank = 0;
    if (bridged) this.spans = BRIDGE_SPANS;
    this.apply(); this.save();
    if (bridged) this.emit('bridge');
    this.emit('stage');
  }

  /** "Start over": the stub in mid-air and a closed town. (In a town: for this player's own progress; the town's stays.) */
  reset(): void {
    this.total = 0;
    if (this.mine) { this.mine.spans = 0; this.mine.stage = 0; this.mine.bank = 0; this.save(); return; }
    this.setStage(0); this.setSpans(0);
    this.bank = 0; this.save();
  }

  /** Be told when a span or a stage is added (or, in tests, taken away). */
  onChange(fn: (what: ProgressChange) => void): void { this.listeners.push(fn); }

  private emit(what: ProgressChange): void { for (const fn of this.listeners) fn(what); }

  /** Push the state into the plan: where the bridge ends, and which streets traffic may use. */
  private apply(): void {
    setBridgeSpans(this.spans);
    if (!this.plan) return;
    for (const e of this.plan.edges) {
      if (!e.land) continue;
      e.closed = e.deck ? !this.complete : e.stage > this.stage;
    }
  }

  private announce(g: Goal): void {
    const hud = this.game?.hud;
    if (!hud) return;
    if (g.kind === 'bridge') {
      if (this.complete) {
        hud.toast(`The Perpetual Bridge is finished. The Harbor Authority has asked that nobody make a fuss. ${TOWN_NAME} is at the far end.`, 9);
        hud.tag('Bridge complete', `${BRIDGE_SPANS} of ${BRIDGE_SPANS} spans`, 8);
      } else {
        hud.toast(`Span ${g.n} of ${BRIDGE_SPANS} is in. The bridge now ends ${BRIDGE_SPANS - g.n === 1 ? 'one span' : `${BRIDGE_SPANS - g.n} spans`} short instead.`, 7);
        hud.tag(`Span ${g.n} of ${BRIDGE_SPANS} built`, 'The Perpetual Bridge', 6);
      }
    } else {
      hud.toast(`${g.label} is open. The barriers have been moved somewhere else.`, 7);
      hud.tag(g.label, `${TOWN_NAME}: now open`, 6);
    }
  }
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

export const progress = new Progress();

// ── Shared bits for anything that puts up a notice or a barrier ──────────────

/** A painted notice board: a heading and a few lines, in the paperwork colours. 2:1. */
export function noticeTexture(head: string, lines: string[], paper = '#f2e8cf', ink = '#14213d'): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = paper; c.fillRect(0, 0, 512, 256);
  c.strokeStyle = ink; c.lineWidth = 8; c.strokeRect(10, 10, 492, 236);
  c.fillStyle = '#e4572e'; c.fillRect(14, 14, 484, 62);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = paper;
  let px = 50;
  c.font = `900 ${px}px "Big Shoulders Display", "Arial Narrow", sans-serif`;
  while (c.measureText(head).width > 460 && px > 20) { px -= 2; c.font = `900 ${px}px "Big Shoulders Display", "Arial Narrow", sans-serif`; }
  c.fillText(head, 256, 48);
  c.fillStyle = ink;
  const n = Math.max(lines.length, 1), step = Math.min(50, 160 / n);
  lines.forEach((t, i) => {
    let p = Math.round(step * 0.74);
    c.font = `600 ${p}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
    while (c.measureText(t).width > 460 && p > 12) { p -= 1; c.font = `600 ${p}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`; }
    c.fillText(t, 256, 86 + step * (i + 0.5) + (160 - step * n) / 2);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Collision boxes that can be switched off and on again: Colliders cannot forget a box, so an idle one is parked far underground. */
export class Toggle {
  private items: { b: Box; y0: number; y1: number }[] = [];
  private on = true;
  add(b: Box): void { this.items.push({ b, y0: b.y0, y1: b.y1 }); if (!this.on) { b.y0 = b.y1 = -999; } }
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    for (const it of this.items) { it.b.y0 = on ? it.y0 : -999; it.b.y1 = on ? it.y1 : -999; }
  }
}

const INK = 0x14213d, BONE = 0xf2e8cf, VERM = 0xe4572e, MUST = 0xf0a202, STEEL = 0x8c9096;

/** A striped road barrier across `width` meters, centered on (x, z), its boards facing along heading h. */
export function sawhorses(b: Batch, x: number, y: number, z: number, h: number, width: number): void {
  const n = Math.max(1, Math.round(width / 2.9)), w = width / n;
  const sx = Math.cos(h), sz = -Math.sin(h);
  for (let k = 0; k < n; k++) {
    const o = (k + 0.5) * w - width / 2, cx = x + sx * o, cz = z + sz * o, bw = w - 0.35;
    for (const e of [-1, 1]) {
      const px = cx + sx * e * (bw / 2 - 0.12), pz = cz + sz * e * (bw / 2 - 0.12);
      b.box(px, y, pz, 0.09, 1.05, 0.5, STEEL, h);
    }
    // Two boards of alternating stripes: eight short boxes each is cheaper than a texture nobody else needs.
    for (const [by, bh] of [[0.78, 0.24], [0.36, 0.2]]) {
      const S = 6;
      for (let s = 0; s < S; s++) {
        const so = (s + 0.5) * (bw / S) - bw / 2;
        b.box(cx + sx * so, y + by, cz + sz * so, bw / S, bh, 0.06, (s + k) % 2 ? VERM : BONE, h);
      }
    }
    b.box(cx, y + 1.05, cz, 0.16, 0.16, 0.16, MUST, h);
  }
}

// ── What the player sees of it ───────────────────────────────────────────────

interface FundBox { x: number; z: number; group: THREE.Group; head: string }
/** A curb-side spot on the mainland and the car that belongs in it: the same car every time the player comes back. */
interface Parked { x: number; z: number; h: number; kind: VehicleKind; tint: number; edge: number; v: Vehicle | null }

/** The collection boxes, the barriers across streets that are not open yet, and the trickle. A system: game.systems updates it. */
export class ProgressWorks {
  private readonly root = new THREE.Group();
  private boxes: FundBox[] = [];
  private barriers: THREE.Group | null = null;
  private barrierWalls = new Toggle();
  private notices: THREE.Material[] = [];
  private driven = 0;
  private saveT = 0;
  private prompting = false;
  private lastPay = -9;
  private parked: Parked[] = [];
  private parkT = 0;

  constructor(private readonly game: Game) {
    this.root.name = 'progress';
    game.world.group.add(this.root);
    progress.attach(game);
    this.boxes.push(this.fundBox(SITES.fundBox.x, SITES.fundBox.z, 0, 'BRIDGE COMPLETION FUND',
      ['Est. 1987. Still collecting.', 'Give generously. Or at all.', 'Walk up and press G']));
    this.boxes.push(this.fundBox(SITES.townBox.x, SITES.townBox.z, 0, `${TOWN_NAME.toUpperCase()} IMPROVEMENT FUND`,
      ['Opening the town, a street at a time.', 'Barriers moved while you wait.', 'Walk up and press G']));
    this.rebuildBarriers();
    progress.onChange((what) => { if (what === 'stage') this.rebuildBarriers(); });

    // The island parks all its cars at the start. The mainland's are kept as a list and put out only around the player.
    const rng = new RNG(4022), plan = game.plan;
    for (const s of plan.mainlandParking) {
      const keep = rng.chance(0.5 * game.quality.density), kind = commonKind(rng.next()), tint = rng.next();
      if (keep) this.parked.push({ x: s.x, z: s.z, h: s.h, kind, tint, edge: plan.nearestEdge(s.x, s.z).edge.id, v: null });
    }
  }

  /** Park cars within sight of the player on streets that are open, and take away the untouched ones left far behind. */
  private parking(): void {
    const game = this.game, pl = game.player, edges = game.plan.edges;
    let budget = 8;
    for (const s of this.parked) {
      const dx = s.x - pl.x, dz = s.z - pl.z, d2 = dx * dx + dz * dz;
      if (s.v) {
        const v = s.v;
        // Driven off, stolen, sunk or shunted: it is an ordinary car now and no longer this spot's.
        const moved = v.driver !== null || v.sunk || Math.abs(v.x - s.x) + Math.abs(v.z - s.z) > 1.5 || game.vehicles.list.indexOf(v) < 0;
        if (moved) s.v = null;
        else if (d2 > 380 * 380) { game.vehicles.remove(v); s.v = null; }
      } else if (d2 < 300 * 300 && d2 > 45 * 45 && budget > 0 && !edges[s.edge].closed) {
        if (game.vehicles.nearest(s.x, s.z, 5)) continue;
        const v = game.vehicles.spawn(s.kind, s.x, s.z, s.h);
        v.color = v.spec.colors[Math.floor(s.tint * v.spec.colors.length)];
        s.v = v;
        budget--;
      }
    }
  }

  /** A steel post with a slotted box and a notice over it. */
  private fundBox(x: number, z: number, h: number, head: string, lines: string[]): FundBox {
    const g = new THREE.Group(), b = new Batch(), y = groundAt(x, z);
    b.box(x, y, z, 0.5, 0.08, 0.5, STEEL, h);
    b.box(x, y, z, 0.14, 2.9, 0.14, INK, h);
    b.box(x, y + 0.95, z, 0.62, 0.7, 0.5, VERM, h);
    b.box(x + Math.sin(h) * 0.26, y + 1.42, z + Math.cos(h) * 0.26, 0.36, 0.05, 0.03, INK, h);
    b.box(x, y + 1.65, z, 0.7, 0.07, 0.58, INK, h);
    b.box(x, y + 1.95, z, 1.9, 0.98, 0.08, INK, h);
    const m = new THREE.Mesh(b.toGeometry(), this.game.world.mats.flat);
    m.castShadow = this.game.quality.shadows; m.receiveShadow = true; m.matrixAutoUpdate = false;
    g.add(m);
    const s = new Batch(), tx = Math.cos(h) * 0.9, tz = -Math.sin(h) * 0.9, ox = Math.sin(h) * 0.05, oz = Math.cos(h) * 0.05;
    s.quad(x - tx + ox, y + 2.0, z - tz + oz, x + tx + ox, y + 2.0, z + tz + oz, x + tx + ox, y + 2.9, z + tz + oz, x - tx + ox, y + 2.9, z - tz + oz, 0xffffff, 0, 0, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ map: noticeTexture(head, lines), vertexColors: true, roughness: 0.85, metalness: 0 });
    const sm = new THREE.Mesh(s.toGeometry(), mat);
    sm.matrixAutoUpdate = false;
    g.add(sm);
    this.root.add(g);
    this.game.col.addProp(x, z, 0.36, y + 3, 'post', false).hard = true;
    return { x, z, group: g, head };
  }

  /** Barriers across the mouth of every closed street, at each crossing that also has an open one. */
  private rebuildBarriers(): void {
    const game = this.game, plan = game.plan;
    if (this.barriers) {
      this.barriers.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      this.root.remove(this.barriers);
    }
    for (const m of this.notices) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
    this.notices = [];
    this.barrierWalls.set(false);
    this.barrierWalls = new Toggle();
    const g = (this.barriers = new THREE.Group());
    g.name = 'stage-barriers';
    this.root.add(g);
    const flat = new Batch(), boards = new Map<number, Batch>();
    for (const n of plan.nodes) {
      if (!n.land) continue;
      let open = false;
      for (const id of n.edges) if (!plan.edges[id].closed && !plan.edges[id].deck) open = true;
      if (!open) continue;
      for (const id of n.edges) {
        const e = plan.edges[id];
        if (!e.closed || e.deck) continue;
        const away = e.horiz ? (e.a === n.id ? Math.PI / 2 : -Math.PI / 2) : (e.a === n.id ? 0 : Math.PI);
        const dx = Math.sin(away), dz = Math.cos(away), half = (e.horiz ? n.hx : n.hz) + 6;
        const x = n.x + dx * half, z = n.z + dz * half, y = roadY(x, z), face = away + Math.PI;
        sawhorses(flat, x, y, z, face, e.hw * 2 - 0.4);
        this.barrierWalls.add(e.horiz
          ? game.col.addBox(x - 0.3, z - e.hw, x + 0.3, z + e.hw, y + 1.15, y - 0.5)
          : game.col.addBox(x - e.hw, z - 0.3, x + e.hw, z + 0.3, y + 1.15, y - 0.5));
        // The notice stands behind the barrier, in the lane a driver would have used, facing the open street.
        const rx = -dz, rz = dx, nx = x + dx * 1.4 - rx * Math.min(3, e.hw * 0.5), nz = z + dz * 1.4 - rz * Math.min(3, e.hw * 0.5);
        for (const o of [-0.85, 0.85]) flat.box(nx + Math.cos(face) * o, y, nz - Math.sin(face) * o, 0.1, 2.5, 0.1, INK, face);
        flat.box(nx, y + 1.4, nz, 2.1, 1.1, 0.08, INK, face);
        let bb = boards.get(e.stage);
        if (!bb) boards.set(e.stage, (bb = new Batch()));
        const tx = Math.cos(face), tz = -Math.sin(face), fx = Math.sin(face) * 0.05, fz = Math.cos(face) * 0.05;
        bb.quad(nx - tx + fx, y + 1.45, nz - tz + fz, nx + tx + fx, y + 1.45, nz + tz + fz, nx + tx + fx, y + 2.45, nz + tz + fz, nx - tx + fx, y + 2.45, nz - tz + fz, 0xffffff, 0, 0, 1, 1);
      }
    }
    if (!flat.empty) {
      const m = new THREE.Mesh(flat.toGeometry(), game.world.mats.flat);
      m.castShadow = game.quality.shadows; m.receiveShadow = true; m.matrixAutoUpdate = false;
      g.add(m);
    }
    for (const [stage, bb] of boards) {
      const mat = new THREE.MeshStandardMaterial({
        map: noticeTexture('ROAD CLOSED', [`${STAGE_NAMES[stage] ?? 'This part of town'} is not open yet.`, `${TOWN_NAME} Improvement Fund`, `Still needed: ${money(stageCost(stage))}, in its turn`]),
        vertexColors: true, roughness: 0.85, metalness: 0,
      });
      this.notices.push(mat);
      const m = new THREE.Mesh(bb.toGeometry(), mat);
      m.matrixAutoUpdate = false;
      g.add(m);
    }
  }

  update(dt: number): void {
    const game = this.game, pl = game.player;
    // The far land's furniture is not worth a draw call from the island, and the other way about.
    const cz = game.camera.position.z, far = game.quality.drawDist + 150;
    if (this.barriers) this.barriers.visible = cz < -1056 + far;
    this.boxes[0].group.visible = cz > SITES.fundBox.z - far;
    this.boxes[1].group.visible = progress.complete && cz < SITES.townBox.z + far;

    this.parkT -= dt;
    if (this.parkT <= 0) { this.parkT = 0.35; if (pl.z < -560 || this.parked.some((s) => s.v)) this.parking(); }

    // The trickle: every DRIVE_M meters at the wheel is a point.
    if (pl.vehicle && game.state === 'play') {
      this.driven += pl.speed * dt;
      if (this.driven >= DRIVE_M) { const pts = Math.floor(this.driven / DRIVE_M); this.driven -= pts * DRIVE_M; progress.add(pts); }
      this.saveT += dt;
      if (this.saveT > 60) { this.saveT = 0; progress.save(); }
    }

    // The box in use: the bridge fund until the bridge is done, then the town's.
    const goal = progress.goal(), box = this.boxes[progress.complete ? 1 : 0];
    const near = goal !== null && !pl.vehicle && Math.abs(pl.x - box.x) < 2.6 && Math.abs(pl.z - box.z) < 2.6;
    if (near && goal) {
      const need = Math.ceil(goal.cost - goal.have);
      game.hud.prompt(`[G] Pay into the fund: ${goal.label}, ${money(need)} to go`);
      this.prompting = true;
      if (game.input.eat('interact') && game.time - this.lastPay > 0.4) {
        this.lastPay = game.time;
        const pay = Math.min(Math.floor(pl.money), need);
        if (pay <= 0) game.hud.toast('The Fund does not accept good intentions. It has plenty.', 4);
        else {
          pl.money -= pay;
          const done = progress.add(pay);
          progress.save();
          if (!done) game.hud.toast(`${money(pay)} received. ${goal.label}: ${money(need - pay)} still to find. A receipt will not be issued.`, 5);
        }
      }
    } else if (this.prompting) { game.hud.prompt(null); this.prompting = false; }
  }
}
