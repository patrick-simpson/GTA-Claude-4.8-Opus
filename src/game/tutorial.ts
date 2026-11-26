// Fun queue 2, item 36: the optional first hour. A short chain of nine steps over the bridge to Tepid Falls, told by Lou
// (and Ines at Quorum Square): get in a car, drive to a marker, set a waypoint on the map, do one paid job, take a photo,
// buy a find at Pardon's or catch a fish, cross to Tepid Falls (the bridge when it is built, else the ferry), say hello at
// Quorum Square, then Claude FM and the Places panel. Words: game/tutorialData.ts. Card: ui/tutorialCard.ts.
//
// Offered once, on a fresh save (nothing played, no mission, no fares); skippable at any time (Skip step and End tour on the
// card, or the comma key: tap skips, hold ends) and replayable from the pause menu's Settings page. It watches what the game
// already exposes and never takes anything over: no job of its own, no busy slot, the radar badge and the gold column are
// drawn only while nothing else has the floor, the route line is its own only when there is no mission or waypoint, and a
// convoy or a mission simply goes on beside it. Saved in the best table (tut.seen, tut.on, tut.step, tut.done, tut.paid), so a
// reload resumes at the step you were on; the $250 and the WELCOME TO TEPID FALLS stamp are paid once per save. This browser
// only: no protocol bump, no server change, no new fact key.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import type { Markers, Pt } from './script';
import type { Townsfolk } from './townsfolk';
import type { Fishing } from './fishing';
import { save } from './save';
import { STREETS_NEW } from '../world/streets';
import { MAIN_SPLIT_Z } from '../world/mainland';
import { progress } from '../world/progress';
import { isWater } from '../world/plan';
import { DOCKS } from '../world/ferryRoute';
import { findsCatalogued } from '../world/pardonsCatalogue';
import { isBoatKind, isCycleKind } from '../ent/vehicleSpecs';
import { money } from '../core/util';
import { TutorialCard, type CardView } from '../ui/tutorialCard';
import { STEPS, OFFER, DONE, REWARD } from './tutorialData';

/** Quorum Square, the heart of Tepid Falls. */
const SQUARE: Pt = STREETS_NEW ? { x: 131, z: -1808 } : { x: 20, z: -1452 };
/** Pardon's Surplus & Salvage (the same door the Courtesy Cab's hub list uses), and the pier to fish from when its street is shut. */
const PARDONS: Pt = { x: -612, z: -1160 };
const PIER: Pt = { x: 0, z: 652 };
/** Seconds the unanswered offer stays up, how long the final card stays, how long she may linger at the square before the step is done anyway. */
const OFFER_FOR = 45, DONE_FOR = 12, LINGER = 20;
/** Holding the comma key this long (ms) ends the tour or says no thanks. */
const HOLD = 1100;

type Phase = 'idle' | 'offer' | 'step' | 'done';

export class Tutorial {
  phase: Phase = 'idle';
  idx = 0;
  /** Where the radar badge, the gold column and (when nothing else is going) the route line point, or null. */
  target: Pt | null = null;
  readonly stats = { offered: 0, started: 0, finished: 0, skipped: 0, ended: 0, declined: 0 };
  private readonly card: TutorialCard;
  private t = 0;          // seconds in this phase
  private wait = 0;       // seconds until the offer shows
  private seek = 0;       // seconds until the car or cab target is looked for again
  private spot: Pt | null = null;
  private way0: Pt | null = null;
  private earned0 = 0; private wasBusy = false; private jobMoment = false;
  private shots0 = 0; private finds0 = 0; private landed0 = 0;
  private greeted0 = 0; private linger = -1;
  private mapSeen = false;
  private holdTimer = 0;
  private armed = false;

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly busy: () => string | null, private readonly townsfolk: Townsfolk, private readonly fishing: Fishing) {
    this.card = new TutorialCard({
      yes: () => this.start(), no: () => this.decline(), skip: () => this.skip(), end: () => this.end(), close: () => { this.card.hide(); this.phase = 'idle'; },
    });
    game.on('start', () => this.begin());
    game.on('moment', (e) => { if (this.phase === 'step' && STEPS[this.idx].id === 'job' && (e.kind === 'taxi' || e.kind === 'delivery')) this.jobMoment = true; });
    // The Places panel is the map tab of the pause menu: look once the menu has drawn itself.
    game.on('pause', (e) => { if (e.on && this.phase === 'step') setTimeout(() => { const m = game.todo?.menu; if (m && m.open && m.tab === 0) this.mapSeen = true; }, 0); });
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
  }

  private get best(): Record<string, number> { return save.data.best; }

  /** A fresh save: nothing played, no mission, no fare, and the offer not yet answered. */
  offerable(): boolean {
    const b = this.best, s = save.data.stats;
    return !b['tut.seen'] && !b['tut.on'] && s.played < 300 && !save.data.missions.length && s.passed === 0 && s.fares === 0;
  }

  get active(): boolean { return this.phase === 'step'; }
  get done(): boolean { return !!this.best['tut.done']; }
  get paid(): boolean { return !!this.best['tut.paid']; }

  /** The game has started: pick up where a reload left it, or offer. */
  private begin(): void {
    if (this.best['tut.on'] && this.best['tut.step'] > 0) { this.enter(Math.min(STEPS.length - 1, this.best['tut.step'] - 1)); return; }
    if (this.offerable()) this.wait = 2.5;
  }

  /** Start the tour from the first step (the offer's Show me, and the menu's replay). */
  start(): void {
    this.best['tut.seen'] = 1;
    this.stats.started++;
    this.enter(0);
  }

  private decline(): void {
    this.best['tut.seen'] = 1; this.stats.declined++;
    this.phase = 'idle'; this.target = null; this.card.hide();
    this.game.hud.toast('Lou: "No trouble. It is in the pause menu, under Settings, if you change your mind."', 6);
    this.game.todo.saveNow();
  }

  /** Stop the tour where it is (the progress is kept as ended: a replay starts again from the top). */
  end(): void {
    if (this.phase !== 'step') { if (this.phase === 'offer') this.decline(); return; }
    this.best['tut.on'] = 0; this.best['tut.step'] = 0; this.best['tut.seen'] = 1;
    this.stats.ended++;
    this.phase = 'idle'; this.target = null; this.card.hide();
    this.game.hud.toast('Tour ended. You can pick it up again from the pause menu, under Settings.', 5);
    this.game.todo.saveNow();
  }

  /** Leave the step in hand undone and go to the next. */
  skip(): void {
    if (this.phase !== 'step') return;
    this.stats.skipped++;
    this.next();
  }

  /** Tests: go straight to a step. */
  goTo(i: number): void { this.enter(Math.max(0, Math.min(STEPS.length - 1, i))); }

  private enter(i: number): void {
    const g = this.game;
    this.idx = i; this.phase = 'step'; this.t = 0; this.seek = 0; this.linger = -1; this.target = null; this.spot = null;
    this.best['tut.on'] = 1; this.best['tut.step'] = i + 1;
    // The baselines the step is measured from.
    this.way0 = g.todo.waypoint;
    this.earned0 = save.data.stats.earned; this.wasBusy = this.busy() !== null; this.jobMoment = false;
    this.shots0 = save.count('ph.shots'); this.finds0 = findsCatalogued(); this.landed0 = this.fishing.stats.landed;
    this.greeted0 = this.townsfolk.stats.greeted; this.mapSeen = false;
    const id = STEPS[i].id;
    if (id === 'drive') { this.spot = this.pickSpot(); if (!this.spot) { this.next(); return; } this.target = this.spot; }
    else if (id === 'shop') this.target = this.shopTarget();
    else if (id === 'cross') this.target = progress.complete ? SQUARE : { x: DOCKS[0].x, z: DOCKS[0].z };
    else if (id === 'square') this.target = SQUARE;
    this.show();
    g.todo.saveNow();
  }

  private next(): void {
    if (this.idx + 1 >= STEPS.length) { this.finish(); return; }
    this.enter(this.idx + 1);
  }

  private finish(): void {
    const g = this.game, b = this.best;
    this.phase = 'done'; this.t = 0; this.target = null;
    b['tut.on'] = 0; b['tut.step'] = 0; b['tut.done'] = 1; b['tut.seen'] = 1;
    this.stats.finished++;
    if (!b['tut.paid']) {
      b['tut.paid'] = 1;
      g.player.money += REWARD; save.credit(REWARD); save.data.stats.earned += REWARD;
      g.hud.stamp(DONE.stamp, `${DONE.sub}, ${money(REWARD)}`);
    } else g.hud.toast('Tour finished. The stamp is already in your file, so no second purse, but you knew that.', 5);
    this.show();
    g.todo.saveNow();
  }

  // ── The card ──

  private view(): CardView | null {
    const phone = this.game.input.touch || !!document.getElementById('touch')?.classList.contains('show');
    if (this.phase === 'offer') return { who: OFFER.who, say: OFFER.say, n: null, of: STEPS.length, goal: '', kb: '', touch: '', mode: 'offer', phone };
    if (this.phase === 'done') return { who: DONE.who, say: `${DONE.say} ${this.stats.finished && this.paid ? `${money(REWARD)} and a stamp for your file.` : ''}`.trim(), n: null, of: STEPS.length, goal: '', kb: '', touch: '', mode: 'done', phone };
    if (this.phase === 'step') {
      const s = STEPS[this.idx], ines = s.who === 'Ines' && !this.townsfolk.on;
      let goal = s.goal, kb = s.kb, touch = s.touch;
      if (s.id === 'shop') { const pard = this.pardonsOpen(); if (!pard) { goal = 'Catch a fish from Pelican Pier.'; kb = 'G at the fishing sign'; touch = 'USE button'; } }
      if (s.id === 'cross' && !progress.complete) { goal = 'Cross to Tepid Falls: take the ferry from Pelican Landing.'; kb = 'F on the dock, when the ferry is in'; touch = 'GET IN button on the dock'; }
      return { who: ines ? 'Lou' : s.who, say: ines && s.old ? s.old : s.say, n: this.idx + 1, of: STEPS.length, goal, kb, touch, mode: 'step', phone };
    }
    return null;
  }

  private show(): void {
    const v = this.view(), inp = this.game.input;
    if (v) { if (inp.device === 'pad') v.pad = inp.label('tutorial'); this.card.show(v); } else this.card.hide();
  }

  // ── Keys: comma taps and holds ──

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.game.input.is(e.code, 'tutorial')) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (this.game.state !== 'play' || (this.phase !== 'offer' && this.phase !== 'step')) { this.armed = false; return; }
    if (down) {
      if (e.repeat || this.armed) return;
      this.armed = true;
      this.holdTimer = window.setTimeout(() => { if (!this.armed) return; this.armed = false; this.holdTimer = 0; if (this.phase === 'offer') this.decline(); else this.end(); }, HOLD);
    } else if (this.armed) {
      this.armed = false; clearTimeout(this.holdTimer); this.holdTimer = 0;
      if (this.phase === 'offer') this.start(); else this.skip();
    }
  }

  // ── Per frame ──

  /** Called between Markers.begin and end each frame while playing. */
  update(dt: number): void {
    const g = this.game, p = g.player;
    if (this.wait > 0 && this.phase === 'idle') { this.wait -= dt; if (this.wait <= 0 && this.offerable()) { this.phase = 'offer'; this.t = 0; this.stats.offered++; this.show(); } }
    this.t += dt;
    if (this.phase === 'offer') { if (this.t > OFFER_FOR) { this.phase = 'idle'; this.card.hide(); } return; }
    if (this.phase === 'done') { if (this.t > DONE_FOR) { this.phase = 'idle'; this.card.hide(); } return; }
    if (this.phase !== 'step') return;
    const s = STEPS[this.idx];
    if (p.health <= 0) return;
    const veh = !!(p.vehicle || p.riding);
    let ok = false;
    switch (s.id) {
      case 'car':
        ok = veh;
        if ((this.seek -= dt) <= 0) { this.seek = 0.6; const v = this.nearCar(); this.target = v ? { x: v.x, z: v.z } : null; }
        break;
      case 'drive':
        ok = !!p.vehicle && !!this.spot && Math.hypot(p.x - this.spot.x, p.z - this.spot.z) < 18;
        break;
      case 'map':
        ok = g.todo.waypoint !== null && g.todo.waypoint !== this.way0;
        break;
      case 'job': {
        const busy = this.busy() !== null;
        if (busy) this.wasBusy = true;
        ok = this.jobMoment || (this.wasBusy && !busy && save.data.stats.earned > this.earned0);
        if (!busy && !ok && (this.seek -= dt) <= 0) { this.seek = 1.5; const v = this.nearCab(); this.target = v ? { x: v.x, z: v.z } : null; }
        if (busy) this.target = null;
        break;
      }
      case 'photo':
        ok = save.count('ph.shots') > this.shots0;
        break;
      case 'shop':
        ok = findsCatalogued() > this.finds0 || this.fishing.stats.landed > this.landed0;
        break;
      case 'cross':
        ok = p.z < SQUARE.z + 300;
        break;
      case 'square':
        if (Math.hypot(p.x - SQUARE.x, p.z - SQUARE.z) < 45) {
          if (this.linger < 0) this.linger = 0; else this.linger += dt;
          ok = !this.townsfolk.on || this.townsfolk.stats.greeted > this.greeted0 || this.linger >= LINGER;
        }
        break;
      case 'radio':
        ok = this.mapSeen && (g.audio?.radio?.station ?? 0) === 0;
        break;
    }
    if (ok) {
      g.hud.toast(`Done: ${s.goal}`, 3);
      this.next();
      return;
    }
    // The gold column only while nothing else has the floor (a mission, a job or a race draws its own).
    const t = this.target;
    // (Not when she is already standing in it: the column would fill the screen.)
    if (t && this.busy() === null && g.todo.waypoint === null && Math.hypot(p.x - t.x, p.z - t.z) > 14) this.markers.put(t.x, t.z, 'goal', 5, 30);
  }

  /** The radar badge for the step in hand. */
  blips(out: Blip[]): void {
    const t = this.target;
    if (this.phase === 'step' && t) out.push({ x: t.x, z: t.z, kind: 'goal', label: String(this.idx + 1) });
  }

  // ── Where to ──

  private nearCar(): Vehicle | null {
    const p = this.game.player;
    return this.game.vehicles.nearest(p.x, p.z, 500, (v) => !v.shared && !v.wreck && !v.removed && v.driver === null && !isBoatKind(v.spec.kind) && !isCycleKind(v.spec.kind));
  }

  private nearCab(): Vehicle | null {
    const p = this.game.player;
    if (p.vehicle) return null;
    return this.game.vehicles.nearest(p.x, p.z, 700, (v) => !v.shared && !v.wreck && !v.removed && v.driver === null && v.spec.kind === 'taxi');
  }

  /** An open junction of the street grid 150 to 450 m off, nearest to 260 m. */
  private pickSpot(): Pt | null {
    const g = this.game, p = g.player, land = p.z < MAIN_SPLIT_Z ? 1 : 0, plan = g.plan;
    let best: Pt | null = null, bd = 1e9;
    for (const n of plan.nodes) {
      if (n.land !== land) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < 150 || d > 450 || isWater(n.x, n.z)) continue;
      let open = true;
      for (const e of n.edges) if (plan.edges[e].closed) { open = false; break; }
      if (!open) continue;
      const s = Math.abs(d - 260);
      if (s < bd) { bd = s; best = { x: n.x, z: n.z }; }
    }
    return best;
  }

  private pardonsOpen(): boolean {
    return STREETS_NEW && this.game.todo.travel.open({ name: 'Pardon\'s', x: PARDONS.x, z: PARDONS.z, nx: 0, nz: 1 });
  }

  private shopTarget(): Pt { return this.pardonsOpen() ? PARDONS : PIER; }

  info(): Record<string, unknown> {
    return { phase: this.phase, step: this.phase === 'step' ? STEPS[this.idx].id : null, idx: this.idx, steps: STEPS.length, target: this.target, offerable: this.offerable(), done: this.done, paid: this.paid, saved: { ...Object.fromEntries(Object.entries(this.best).filter(([k]) => k.startsWith('tut.'))) }, stats: { ...this.stats }, card: this.card.shown };
  }
}
