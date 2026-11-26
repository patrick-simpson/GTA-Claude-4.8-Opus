// "The Speed Scan" (fun queue 2, item 17): a comedic caper through SpeedScan headquarters, using the floors and the lifts.
//
//   brief     Brenda Plonk, a former badge printer, waits at the corner of the HQ block (G). The Founder keeps the Golden Lanyard
//             in a safe on 70; she would like it back, and she would like the Founder's stapler to be left alone (it is in jelly).
//   steps     0 BADGE   floor 12: the visitor-badge kiosk, a three-pass timing game. The lifts obey the badge you carry:
//                         none: L and 12 / Visitor (level 1): 12, 20, 28, 42 / Executive (level 3): everything, 34, 70 and the roof
//             1 ENCODE  floor 20, the data hall: two guards patrol with vision cones (racks and the lift core block their sight). Sneak
//                       to the card encoder at the far west end and hold G for four seconds to upgrade the badge. Or go to the break
//                       room (28) first and start the ping-pong ball machine or shake a vending machine: both guards go and look.
//                       Spotted for a second and a half: ESCORTED OUT (kid mode: politely asked to leave), back at the lift lobby
//                       of floor 12 with the badge intact, plus 20 s on the clock.
//             2 SAFE    floor 70: a three-tumbler timing lock on the safe in the corner office. Three misses trip the alarm early.
//             3 ESCAPE  the alarm: lifts are locked. (a) west wall: the fire stairs down to 34, then the construction hoist on its
//                       west face to the plaza; or (b) east wall: the roof stairs and the SpeedScan promotional parachute to the
//                       corner. If the alarm runs 100 s with you still inside, security walks you back to the 70 lift lobby.
//             4 DROP    Lou's yard (The Cannery) with the Lanyard, and the Harbor Patrol lost first (kid mode: the Lost & Found escort).
//   grade     0..1000: 600 for a clean job, plus 100 each for GHOST (never escorted out), QUIET (no alarm before the grab),
//             STAPLER (the CEO's, in jelly) and SPEED (under 8:00). Letter grades as the Semester's. Best score and best time are
//             kept (save best 'hs.score', 'hs.time'; counts 'hs.runs', 'hs.done'); the leaderboard row "Fastest Speed Scan".
//
// Personal: nothing on the wire (no protocol change); other players just see someone running about. The props, guards and
// cones are this browser's own and drawn only while the player is on their floor. Phones (no interior) are turned away.
// R drops the job. Test hooks: info(), warp(), setGuard(), mini.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Look, Person } from '../core/api';
import type { Blip } from '../ui/hud';
import { kid } from '../core/kid';
import { groundAt } from '../world/plan';
import { HQ } from '../world/speedscanHQ';
import { hqLink } from '../world/speedscanInterior';
import { FLOORS, FLOOR_H } from '../world/speedscanFloors';
import { save } from './save';
import { clock, type Markers, type Pt } from './script';
import { gradeOf } from './semesterData';

/** Floor heights (the floors' y in speedscanFloors.ts, the lobby and the roof deck in speedscanInterior.ts). */
const Y = { lobby: 0.2, print: 45.6, data: 76, brk: 106.4, reno: 129.2, ceo: 266, roof: 322.1 } as const;
type Where = 'print' | 'data' | 'brk' | 'reno' | 'ceo' | 'roof';
const FLOOR_Y: Record<Where, number> = { print: Y.print, data: Y.data, brk: Y.brk, reno: Y.reno, ceo: Y.ceo, roof: Y.roof };

const NEED: Record<string, number> = { L: 0, '12': 0, '20': 1, '28': 1, '42': 1, '34': 3, '70': 3, R: 3 };
const NEED_NAME: Record<number, string> = { 1: 'a Visitor badge', 3: 'an Executive badge' };
const FLOOR_NAME: Record<string, string> = { '12': 'Floor 12', '20': 'Floor 20, the data hall', '28': 'Floor 28', '34': 'Floor 34', '42': 'Floor 42', '70': "Floor 70, the CEO's office", R: 'The roof deck' };

const ALARM_S = 100, TIME_LIMIT = 1200, SPEED_PAR = 480, PENALTY = 20;
const GUARD_RANGE = 11, GUARD_HALF = 0.62, SPOT_S = 1.5;
const AWAY_GONE = 15, AWAY_STAY = 55;
const LANDING = { x: 4.125, z: -1.4 };
/** What blocks a guard's sight on the data hall (local x0, x1, z0, z1): the rack rows and the lift core. */
const BLOCKERS: number[][] = [[-29, -2, -16.7, -13.3], [-29, -2, -26.7, -23.3], [-9.5, 9.5, -6.5, -3.19]];

// Where things are, floor-local (x, z) from the tower's origin.
const KIOSK = { x: 14, z: -9.5 }, ENCODER = { x: -31.2, z: -20 }, BALLS = { x: -12.5, z: -27 }, VENDING = { x: 9.2, z: -32.6 };
const SAFE = { x: 23.4, z: -17.5 }, STAPLER = { x: 16.9, z: -19.0 };
const STAIRS_DOWN = { x: -24.4, z: -10 }, STAIRS_UP = { x: 24.4, z: -4 };
const HOIST = { x: -30.4, z: -16 }, CHUTE = { x: -14, z: -1.4 };
const RENO_ARRIVE = { x: -27.5, z: -8 }, ROOF_ARRIVE = { x: -19, z: -1.4 };

const look = (extra: Partial<Look>): Look => ({ skin: 0xe0b08c, hair: 0x3a2a1e, top: 0x14213d, bottom: 0x14213d, shoes: 0x111111, hat: 0x14213d, height: 1, build: 1.05, ...extra });

const CSS = `
#heist { position: fixed; inset: 0; z-index: 32; pointer-events: none; font-family: var(--f-head, system-ui, sans-serif); color: #0c1a10; }
#heist .hs-card { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); width: min(94vw, 34em); max-height: 88vh; overflow-y: auto; background: #e9f7d8; border: 3px solid #0c1a10; box-shadow: 4px 4px 0 #0c1a10; padding: 0.8em 1em 1em; display: none; pointer-events: auto; }
#heist .hs-card.on { display: block; }
#heist .hs-card h2 { margin: 0 0 0.2em; font-size: 1.15em; letter-spacing: 0.06em; text-transform: uppercase; }
#heist .hs-card h2 small { display: block; font-size: 0.6em; letter-spacing: 0.1em; color: #1f8a3a; }
#heist .hs-card p, #heist .hs-card li { margin: 0.35em 0; font-size: 0.88em; line-height: 1.3; }
#heist .hs-card ol, #heist .hs-card ul { margin: 0.3em 0; padding-left: 1.3em; }
#heist .hs-big { font: 800 4em var(--f-mono, monospace); line-height: 1; text-align: center; color: #1f8a3a; }
#heist .hs-card .hs-b { display: inline-block; margin: 0.15em 0.3em 0.15em 0; padding: 0.1em 0.5em; border: 2px solid #0c1a10; font-size: 0.8em; font-weight: 800; background: #fff; }
#heist .hs-card .hs-b.got { background: #7be04a; }
#heist button { font: 800 0.85em var(--f-head, system-ui, sans-serif); border: 2px solid #0c1a10; background: #1f8a3a; color: #fff; box-shadow: 2px 2px 0 #0c1a10; padding: 0.4em 0.8em; pointer-events: auto; }
#heist button.alt { background: #0c1a10; }
#heist button:disabled { opacity: 0.3; }
#heist .hs-mini { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); width: min(92vw, 30em); background: #0e1418; border: 3px solid #9fe870; color: #9fe870; padding: 0.7em 1em 0.9em; display: none; pointer-events: auto; text-align: center; box-shadow: 0 0 24px rgba(159, 232, 112, 0.35); }
#heist .hs-mini.on { display: block; }
#heist .hs-mini h3 { margin: 0 0 0.2em; letter-spacing: 0.1em; text-transform: uppercase; font-size: 1em; }
#heist .hs-mini p { margin: 0.2em 0 0.6em; font-size: 0.8em; color: #d7f5c0; }
#heist .hs-track { position: relative; height: 2.2em; background: #1b2a22; border: 2px solid #9fe870; overflow: hidden; }
#heist .hs-zone { position: absolute; top: 0; bottom: 0; background: rgba(123, 224, 74, 0.55); border-left: 2px solid #9fe870; border-right: 2px solid #9fe870; }
#heist .hs-mark { position: absolute; top: -2px; bottom: -2px; width: 0.35em; margin-left: -0.17em; background: #fff; box-shadow: 0 0 8px #fff; }
#heist .hs-mark.miss { background: #ff5a3c; box-shadow: 0 0 10px #ff5a3c; }
#heist .hs-pips { margin: 0.5em 0; font-size: 1.2em; letter-spacing: 0.3em; }
#heist .hs-mini button { background: #9fe870; color: #0e1418; border-color: #9fe870; box-shadow: none; }
#heist .hs-mini button.alt { background: #1b2a22; color: #9fe870; }
#heist .hs-bar { position: absolute; left: 50%; bottom: 24vh; transform: translateX(-50%); width: min(70vw, 22em); display: none; text-align: center; font-weight: 800; font-size: 0.85em; color: #fff; text-shadow: 1px 1px 2px #000; }
#heist .hs-bar.on { display: block; }
#heist .hs-bar div { height: 1.1em; border: 2px solid #0c1a10; background: rgba(255, 255, 255, 0.8); margin-top: 0.2em; overflow: hidden; }
#heist .hs-bar i { display: block; height: 100%; background: #7be04a; }
#heist .hs-bar.spot i { background: #ff7a2a; }
#heist .hs-fade { position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity 0.4s; }
#heist .hs-alarm { position: absolute; inset: 0; display: none; box-shadow: inset 0 0 14vmin 3vmin rgba(255, 30, 30, 0.85); animation: hs-pulse 0.7s infinite alternate; }
#heist .hs-alarm.on { display: block; }
#heist .hs-alarm.kid { box-shadow: inset 0 0 12vmin 2vmin rgba(255, 190, 40, 0.7); animation-duration: 1.6s; }
#heist .hs-banner { position: absolute; left: 50%; top: 13vh; transform: translateX(-50%); display: none; background: #c1121f; color: #fff; font-weight: 800; letter-spacing: 0.12em; padding: 0.3em 1em; border: 3px solid #0c1a10; text-align: center; font-size: 0.95em; }
#heist .hs-banner.on { display: block; }
#heist .hs-banner.kid { background: #e8a21a; color: #0c1a10; }
@keyframes hs-pulse { from { opacity: 0.25; } to { opacity: 1; } }
`;

interface Guard {
  name: string; p: Person | null; at: 'data' | 'brk' | 'gone'; path: number[][]; i: number; dir: number; wait: number;
  lx: number; lz: number; fx: number; fz: number; meter: number; cone: THREE.Mesh; cg: THREE.BufferGeometry; seen: boolean; speed: number;
}
interface Ride { kind: 'hoist' | 'chute'; t: number; dur: number; x0: number; z0: number; y0: number; x1: number; z1: number; mesh: THREE.Group }
interface Run {
  t: number; step: number; badge: 0 | 1 | 3; alarm: boolean; alarmT: number; early: boolean; escorts: number; pen: number;
  stapler: boolean; lanyard: boolean; away: number; encode: number; route: '' | 'hoist' | 'chute'; misses: number; lim: number;
  esc: { t: number; why: string } | null; ride: Ride | null; landed: Pt | null;
}
interface Spot { floor: Where; x: number; z: number; r: number; text: () => string | null; act: () => void; beacon?: THREE.Object3D }
interface Me { x: number; z: number; y: number; at: Where | null; lobby: boolean }

const tri = (u: number): number => { const k = ((u % 2) + 2) % 2; return k < 1 ? k : 2 - k; };

/** A timing game on a DOM card: a marker sweeps a bar, press (Space, Enter, G, a tap) while it is in the green. */
class Timing {
  open = false;
  round = 0; misses = 0; t = 0;
  rounds = 3; speed = 0.7; w = 0.18; c = 0.5;
  kind = '';
  private cb: ((misses: number) => void) | null = null;
  private onMiss: (() => void) | null = null;
  private flash = 0;
  private el: HTMLElement; private zone: HTMLElement; private mark: HTMLElement; private pips: HTMLElement; private title: HTMLElement; private hint: HTMLElement;
  constructor(root: HTMLElement, private readonly toggle: (open: boolean) => void, private readonly isUse: (code: string) => boolean) {
    const el = this.el = document.createElement('div'); el.className = 'hs-mini';
    el.innerHTML = '<h3></h3><p></p><div class="hs-track"><div class="hs-zone"></div><div class="hs-mark"></div></div><div class="hs-pips"></div><button data-a="stop">STOP (Space)</button> <button class="alt" data-a="quit">Step away (Esc)</button>';
    root.append(el);
    this.title = el.querySelector('h3') as HTMLElement; this.hint = el.querySelector('p') as HTMLElement;
    this.zone = el.querySelector('.hs-zone') as HTMLElement; this.mark = el.querySelector('.hs-mark') as HTMLElement; this.pips = el.querySelector('.hs-pips') as HTMLElement;
    el.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.a === 'stop') this.press(); else this.close();
      e.preventDefault();
    });
    addEventListener('keydown', (e) => {
      if (!this.open || e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter' || this.isUse(e.code)) { this.press(); e.stopImmediatePropagation(); e.preventDefault(); }
      else if (e.code === 'Escape') { this.close(); e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
  }
  start(kind: string, title: string, hint: string, rounds: number, speed: number, w: number, cb: (misses: number) => void, onMiss: (() => void) | null = null): void {
    this.kind = kind; this.rounds = rounds; this.speed = speed; this.w = w; this.cb = cb; this.onMiss = onMiss;
    this.round = 0; this.misses = 0; this.t = 0; this.open = true; this.flash = 0;
    this.title.textContent = title; this.hint.textContent = hint;
    this.el.classList.add('on'); this.aim(); this.draw(); this.toggle(true);
  }
  close(): void { if (!this.open) return; this.open = false; this.cb = null; this.el.classList.remove('on'); this.toggle(false); }
  private aim(): void { this.c = 0.2 + (Math.sin((this.round + 1) * 7.31 + this.misses * 3.7 + performance.now() * 0.001) * 0.5 + 0.5) * 0.6; }
  get pos(): number { return tri(this.t * this.speed * (1 + this.round * 0.12)); }
  inZone(): boolean { return Math.abs(this.pos - this.c) <= this.w / 2; }
  press(): boolean {
    if (!this.open) return false;
    if (this.inZone()) {
      this.round++;
      if (this.round >= this.rounds) { const cb = this.cb, m = this.misses; this.draw(); this.close(); cb?.(m); return true; }
      this.aim();
    } else { this.misses++; this.flash = 0.3; this.onMiss?.(); }
    this.draw();
    return this.inZone();
  }
  tick(dt: number): void {
    if (!this.open) return;
    this.t += dt; this.flash = Math.max(0, this.flash - dt);
    this.mark.style.left = (this.pos * 100).toFixed(1) + '%';
    this.mark.classList.toggle('miss', this.flash > 0);
  }
  private draw(): void {
    this.zone.style.left = ((this.c - this.w / 2) * 100).toFixed(1) + '%'; this.zone.style.width = (this.w * 100).toFixed(1) + '%';
    this.pips.textContent = Array.from({ length: this.rounds }, (_, i) => (i < this.round ? '●' : '○')).join('');
  }
}

export class Heist {
  prompt: string | null = null;
  target: Pt | null = null;
  targetName: string | null = null;
  readonly stats = { runs: 0, done: 0, fails: 0, escorts: 0, alarms: 0 };
  run: Run | null = null;
  readonly gate: { allow(label: string): string | null; rode(label: string): void };

  private root!: HTMLElement; private card!: HTMLElement; private bar!: HTMLElement; private barTx!: HTMLElement; private barI!: HTMLElement;
  private fade!: HTMLElement; private alarmEl!: HTMLElement; private banner!: HTMLElement;
  mini!: Timing;
  private cardKind: 'none' | 'brief' | 'report' = 'none';
  private cardT = 0;
  private props: Record<Where, THREE.Group> | null = null;
  private spots: Spot[] = [];
  private guards: Guard[] = [];
  private contact: Person | null = null;
  private contactAt: Pt = { x: 0, z: 0 };
  private landAt: Pt = { x: 0, z: 0 };
  private recheck = 0;
  private lastReport: { score: number; letter: string; time: number; line: string; bonus: string[]; fresh: boolean } | null = null;
  private balls: { m: THREE.Mesh; vx: number; vy: number; vz: number }[] = [];
  private ballT = 0; private ballFrom: Pt = { x: 0, z: 0 };
  private safeDoor: THREE.Mesh | null = null; private staplerM: THREE.Object3D | null = null;
  private spotted = 0;
  private holding = false;
  private told = new Set<string>();

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void, private readonly drop: Pt) {
    try { this.buildUi(); } catch (e) { console.warn('heist: no ui', e); }
    this.gate = {
      allow: (label) => {
        const r = this.run; if (!r) return null;
        if (r.alarm) return kid.on ? 'The Lost & Found bell is ringing: the lifts are resting. Take the stairs.' : 'LOCKDOWN. The lifts are locked while the alarm is on. Take the stairs.';
        const need = NEED[label] ?? 0;
        if (r.badge >= need) return null;
        return `ACCESS DENIED. ${FLOOR_NAME[label] ?? label} needs ${NEED_NAME[need] ?? 'a better badge'}. You have ${r.badge === 0 ? 'no badge' : 'a Visitor badge'}.`;
      },
      rode: (label) => this.rode(label),
    };
    game.on('booked', () => { if (this.run && this.run.step >= 4) this.fail(kid.on ? 'The Lost & Found desk has taken the Lanyard and the finder, with a sticker.' : 'The Harbor Patrol has the Lanyard, and you. The job is off.'); });
  }

  get busy(): boolean { return this.run !== null; }

  // ── the UI ────────────────────────────────────────────────────────────────────

  private buildUi(): void {
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const root = this.root = document.createElement('div'); root.id = 'heist';
    root.innerHTML = '<div class="hs-alarm"></div><div class="hs-banner"></div><div class="hs-bar"><span></span><div><i></i></div></div><div class="hs-card"></div><div class="hs-fade"></div>';
    document.body.append(root);
    this.card = root.querySelector('.hs-card') as HTMLElement; this.bar = root.querySelector('.hs-bar') as HTMLElement;
    this.barTx = this.bar.querySelector('span') as HTMLElement; this.barI = this.bar.querySelector('i') as HTMLElement;
    this.fade = root.querySelector('.hs-fade') as HTMLElement; this.alarmEl = root.querySelector('.hs-alarm') as HTMLElement; this.banner = root.querySelector('.hs-banner') as HTMLElement;
    this.mini = new Timing(root, (open) => this.game.input.setEnabled(!open), (c) => this.game.input.is(c, 'interact'));
    this.card.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      const a = b.dataset.a;
      if (a === 'go') this.start(); else if (a === 'close') this.closeCard();
    });
    addEventListener('keydown', (e) => {
      if (this.cardKind === 'none' || e.repeat) return;
      if (e.code === 'Escape') { this.closeCard(); e.stopImmediatePropagation(); e.preventDefault(); }
      else if ((e.code === 'Digit1' || e.code === 'Numpad1' || e.code === 'Enter') && this.cardKind !== 'report') { this.start(); e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
  }

  private showCard(kind: 'brief' | 'report', html: string, secs = 0): void { this.card.innerHTML = html; this.card.classList.add('on'); this.cardKind = kind; this.cardT = secs; }
  closeCard(): void { this.card.classList.remove('on'); this.cardKind = 'none'; this.cardT = 0; }
  private barOn(on: boolean, tx = '', pct = 0, spot = false): void {
    this.bar.classList.toggle('on', on); this.bar.classList.toggle('spot', spot);
    if (on) { this.barTx.textContent = tx; this.barI.style.width = Math.max(0, Math.min(100, pct)).toFixed(0) + '%'; }
  }

  // ── the brief ─────────────────────────────────────────────────────────────────

  private bests(): { score: number | null; time: number | null; done: number } {
    return { score: save.data.best['hs.score'] ?? null, time: save.data.best['hs.time'] ?? null, done: save.count('hs.done') };
  }

  openBrief(): void {
    const b = this.bests(), k = kid.on;
    const ready = !!hqLink.interior?.ready;
    const talk = k
      ? 'Psst. I printed badges at SpeedScan for eleven years, until the printer learned to print itself. The Founder keeps the Golden Lanyard in a safe on the 70th floor. It is mine in spirit, and I would like it back for a very nice reason. Nobody gets hurt: the guards will only politely ask you to leave.'
      : 'Psst. I printed badges at SpeedScan for eleven years, until the printer learned to print itself. The Founder keeps the Golden Lanyard in a safe on the 70th floor. It is mine in spirit. The guards are not violent, only very, very punctual.';
    const best = b.score === null ? 'Not attempted yet.' : `Best <b>${gradeOf(b.score).letter}</b> (${Math.round(b.score / 10)}%) · fastest <b>${b.time === null ? '-' : clock(b.time)}</b> · pulled off ${b.done} time${b.done === 1 ? '' : 's'}.`;
    this.showCard('brief', `<h2><small>Brenda Plonk · former badge printer</small>The Speed Scan</h2><p>${talk}</p>
<ol><li><b>Floor 12:</b> print yourself a visitor badge. (The lifts obey your badge.)</li><li><b>Floor 20, the data hall:</b> sneak past the guards to the card encoder and upgrade it. A <i>distraction</i> in the break room (28) sends them off.</li><li><b>Floor 70:</b> crack the safe in the corner office, take the Golden Lanyard.</li><li><b>Escape:</b> the alarm locks the lifts. The fire stairs and the construction hoist, or the roof and the parachute.</li><li><b>Lou's yard:</b> ${k ? 'the Lost &amp; Found escort will follow you, gently' : 'lose the Harbor Patrol'}, then hand it over.</li></ol>
<p>Bonus: <span class="hs-b">GHOST never escorted out</span><span class="hs-b">QUIET no alarm before the grab</span><span class="hs-b">STAPLER the CEO's, in jelly</span><span class="hs-b">SPEED under 8:00</span></p>
<p>${best}</p>${ready ? '' : "<p><b>This device cannot show the tower's inside. Open the game at medium or high quality on a computer.</b></p>"}
<p style="text-align:right"><button data-a="go" ${ready ? '' : 'disabled'}>${b.score === null ? 'Start' : 'Go again'} (1)</button> <button class="alt" data-a="close">Close</button></p>`);
  }

  private sidewalk(): void {
    const n = this.game.plan.nearestNode(HQ.x + 50, HQ.z + 50), ox = n.hx + 1.8, oz = n.hz + 1.8;
    this.contactAt = { x: +(n.x - ox).toFixed(1), z: +(n.z - oz).toFixed(1) };
    this.landAt = { x: +(n.x + ox).toFixed(1), z: +(n.z - oz).toFixed(1) };
  }

  // ── starting and ending ───────────────────────────────────────────────────────

  start(): boolean {
    const g = this.game, p = g.player, ix = hqLink.interior;
    if (this.run || !this.isFree() || !(p.health > 0)) return false;
    if (!ix || !ix.ready) { g.hud.toast('SpeedScan turnstiles need the full-detail lobby. Try the game at medium or high quality on a computer.', 6); return false; }
    this.closeCard();
    this.ensureProps();
    this.run = {
      t: 0, step: 0, badge: 0, alarm: false, alarmT: 0, early: false, escorts: 0, pen: 0, stapler: false, lanyard: false, away: 0, encode: 0, route: '',
      misses: 0, lim: TIME_LIMIT, esc: null, ride: null, landed: null,
    };
    this.told.clear();
    for (const gd of this.guards) this.guardHome(gd);
    this.refreshProps();
    ix.gate = this.gate;
    this.stats.runs++; save.bump('hs.runs');
    this.setBusy('heist');
    g.hud.toast(kid.on ? 'THE SPEED SCAN: a secret mission. In through the lobby, up to 12 for a badge. Nobody gets hurt. Everybody gets a sticker.' : 'THE SPEED SCAN: in through the lobby, up to 12 for a visitor badge. The lifts will not take you anywhere a badge will not.', 9);
    return true;
  }

  /** The end of a run: file the score and show the report. */
  private win(): void {
    const r = this.run; if (!r) return;
    const g = this.game, time = Math.round(r.t + r.pen);
    const got = [!r.escorts ? 'GHOST' : '', !r.early ? 'QUIET' : '', r.stapler ? 'STAPLER' : '', time <= SPEED_PAR ? 'SPEED' : ''].filter(Boolean);
    const score = Math.min(1000, 600 + got.length * 100), gr = gradeOf(score);
    const fresh = save.record('hs.score', score, false), freshT = save.record('hs.time', time, true);
    save.bump('hs.done'); this.stats.done++;
    const cash = 1200 + got.length * 300;
    g.player.money += cash;
    this.cleanup();
    const line = ['Lou weighs the Lanyard, says "huh", and pays in small bills.', 'The Founder has noticed. The Founder has issued a memo about lanyards.', 'Brenda frames a photograph of the safe, empty, and cries a little.'][this.stats.done % 3];
    this.lastReport = { score, letter: gr.letter, time, line, bonus: got, fresh: fresh || freshT };
    const tags = ['GHOST', 'QUIET', 'STAPLER', 'SPEED'].map((b) => `<span class="hs-b ${got.includes(b) ? 'got' : ''}">${b}</span>`).join('');
    this.showCard('report', `<h2><small>Brenda Plonk · debrief</small>The Speed Scan</h2><div class="hs-big">${gr.letter}</div><p style="text-align:center"><b>${Math.round(score / 10)}%</b> · time <b>${clock(time)}</b>${freshT ? ' · new best time' : ''} · paid $${cash.toLocaleString('en-US')}</p><p style="text-align:center">${tags}</p><p>${r.escorts ? `${kid.on ? 'Politely asked to leave' : 'Escorted out'} ${r.escorts} time${r.escorts === 1 ? '' : 's'} (+${r.escorts * PENALTY} s).` : 'Never noticed.'}${r.early ? ' The alarm went early.' : ''}</p><p><i>${line}</i></p><p style="text-align:right"><button data-a="go">Go again</button> <button class="alt" data-a="close">Close</button></p>`, 20);
    g.hud.stamp(`SPEED SCAN: ${gr.letter}`, `${clock(time)}${freshT ? ' · best' : ''}`);
    save.write();
  }

  private fail(why: string): void {
    if (!this.run) return;
    this.cleanup();
    this.stats.fails++;
    this.game.hud.toast(why, 6);
  }

  /** Drop the job in hand with nothing filed. */
  abandon(why: string): void { if (this.run) { this.cleanup(); this.game.hud.toast(why, 5); } }

  private cleanup(): void {
    const g = this.game;
    if (this.mini) this.mini.close();
    g.input.setEnabled(true);
    const ix = hqLink.interior; if (ix) ix.gate = null;
    if (this.run?.ride) this.run.ride.mesh.removeFromParent();
    for (const gd of this.guards) { gd.at = 'gone'; gd.cone.visible = false; if (gd.p) { g.people?.remove(gd.p); gd.p = null; } }
    this.clearBalls();
    this.run = null; this.target = null; this.targetName = null; this.holding = false; this.spotted = 0;
    g.hud.objective(null); g.hud.timer(null); this.barOn(false);
    this.alarmEl.classList.remove('on'); this.banner.classList.remove('on'); this.fade.style.opacity = '0';
    this.refreshProps();
    this.setBusy(null);
  }

  // ── props: what the floors get while the job is on ────────────────────────────

  private ensureProps(): void {
    if (this.props) return;
    const g = this.game;
    const mats = new Map<string, THREE.MeshBasicMaterial>();
    const mat = (hex: number, o: Partial<THREE.MeshBasicMaterialParameters> = {}): THREE.MeshBasicMaterial => {
      const key = `${hex}:${o.opacity ?? ''}`;
      let m = mats.get(key); if (!m) { m = new THREE.MeshBasicMaterial({ color: hex, toneMapped: false, fog: false, ...o }); mats.set(key, m); }
      return m;
    };
    const mk = (where: Where): THREE.Group => { const gr = new THREE.Group(); gr.name = 'heist-' + where; gr.position.set(HQ.x, FLOOR_Y[where], HQ.z); gr.visible = false; g.scene.add(gr); return gr; };
    const P = { print: mk('print'), data: mk('data'), brk: mk('brk'), reno: mk('reno'), ceo: mk('ceo'), roof: mk('roof') } as Record<Where, THREE.Group>;
    this.props = P;
    const box = (gr: THREE.Group, cx: number, y0: number, cz: number, w: number, h: number, d: number, hex: number, o: Partial<THREE.MeshBasicMaterialParameters> = {}): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(hex, o)); m.position.set(cx, y0 + h / 2, cz); gr.add(m); return m;
    };
    const sign = (gr: THREE.Group, text: string, x: number, y: number, z: number, ry: number, w: number, bg = '#0e1418', fg = '#9fe870'): void => {
      const ht = w / 4, cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
      const c = cv.getContext('2d')!; c.fillStyle = bg; c.fillRect(0, 0, 1024, 256); c.strokeStyle = fg; c.lineWidth = 8; c.strokeRect(6, 6, 1012, 244);
      c.fillStyle = fg; c.font = 'bold 84px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 512, 134, 960);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, ht), new THREE.MeshBasicMaterial({ map: t, toneMapped: false, fog: false })); m.position.set(x, y, z); m.rotation.y = ry; gr.add(m);
    };
    const beacon = (gr: THREE.Group, x: number, z: number, hex = 0x7be04a): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.2, 10, 1, true), mat(hex, { transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }));
      m.position.set(x, 1.7, z); gr.add(m); return m;
    };
    const solid = (where: Where, x0: number, x1: number, z0: number, z1: number, h: number): void => { g.col.addBox(HQ.x + x0, HQ.z + z0, HQ.x + x1, HQ.z + z1, FLOOR_Y[where] + h, FLOOR_Y[where]); };
    const spot = (s: Spot): void => { this.spots.push(s); };
    // 12: the visitor-badge kiosk.
    box(P.print, KIOSK.x, 0, KIOSK.z, 1.3, 1.15, 0.7, 0x2a2e33); box(P.print, KIOSK.x, 1.15, KIOSK.z + 0.05, 1.1, 0.7, 0.12, 0x0b3d1a); box(P.print, KIOSK.x, 1.2, KIOSK.z + 0.12, 0.98, 0.6, 0.02, 0x6df08a);
    box(P.print, KIOSK.x, 0.9, KIOSK.z + 0.38, 0.5, 0.05, 0.1, 0xf2f2f2); sign(P.print, 'VISITOR BADGES · TAKE A NUMBER', KIOSK.x, 2.35, KIOSK.z + 0.1, 0, 3.2);
    solid('print', KIOSK.x - 0.65, KIOSK.x + 0.65, KIOSK.z - 0.35, KIOSK.z + 0.35, 1.8);
    const bk = beacon(P.print, KIOSK.x, KIOSK.z - 0.1);
    spot({ floor: 'print', x: KIOSK.x, z: KIOSK.z + 0.9, r: 2.2, beacon: bk, text: () => (this.run && this.run.badge === 0 ? '[G] Print a visitor badge' : null), act: () => this.openPrint() });
    // 20: the card encoder.
    box(P.data, ENCODER.x, 0, ENCODER.z, 0.9, 1.1, 1.8, 0x2a2e33); box(P.data, ENCODER.x + 0.42, 1.1, ENCODER.z, 0.1, 0.8, 1.5, 0x0b2f52); box(P.data, ENCODER.x + 0.48, 1.15, ENCODER.z, 0.02, 0.7, 1.4, 0x4aa8ff);
    box(P.data, ENCODER.x + 0.5, 0.7, ENCODER.z + 0.9, 0.04, 0.1, 0.3, 0xffb020); sign(P.data, 'CARD ENCODER · STAFF ONLY', ENCODER.x + 0.5, 2.3, ENCODER.z, Math.PI / 2, 3);
    solid('data', ENCODER.x - 0.5, ENCODER.x + 0.6, ENCODER.z - 1, ENCODER.z + 1, 1.9);
    const eb = beacon(P.data, ENCODER.x, ENCODER.z);
    spot({ floor: 'data', x: ENCODER.x + 1.4, z: ENCODER.z, r: 2.2, beacon: eb, text: () => (this.run && this.run.badge === 1 && !this.holding ? '[G] Encode the badge to Executive (4 s, stay out of sight)' : null), act: () => { if (this.run) this.holding = true; } });
    // 28: the ball machine and the vending machines.
    box(P.brk, BALLS.x, 0, BALLS.z, 0.8, 1.0, 0.8, 0xe8641c); box(P.brk, BALLS.x, 1.0, BALLS.z, 0.7, 0.55, 0.7, 0xcfe9f5, { transparent: true, opacity: 0.45, depthWrite: false });
    const gm = new THREE.Mesh(new THREE.SphereGeometry(0.29, 12, 8), mat(0xffffff)); gm.position.set(BALLS.x, 1.3, BALLS.z); P.brk.add(gm);
    sign(P.brk, 'PING-PONG BALL MACHINE · FREE', BALLS.x, 2.3, BALLS.z - 0.1, 0, 2.6, '#e8641c', '#ffffff');
    solid('brk', BALLS.x - 0.45, BALLS.x + 0.45, BALLS.z - 0.45, BALLS.z + 0.45, 1.6);
    sign(P.brk, 'SHAKE FOR SNAX', VENDING.x, 2.05, -33.4, 0, 2.2, '#f2c230', '#111111');
    const bb = beacon(P.brk, BALLS.x, BALLS.z, 0xff9a3a), vb = beacon(P.brk, VENDING.x, -34.0, 0xff9a3a);
    const distractText = (what: string): string | null => (this.run && this.run.away > 0 ? 'The guards are on their way. Quick, to the lift.' : this.run && this.run.step <= 1 && this.run.badge >= 1 ? `[G] ${what}: send the guards to look` : null);
    spot({ floor: 'brk', x: BALLS.x + 1.3, z: BALLS.z + 0.6, r: 2.0, beacon: bb, text: () => distractText('Start the ball machine'), act: () => this.distract(BALLS.x, BALLS.z, 'balls') });
    spot({ floor: 'brk', x: VENDING.x, z: VENDING.z, r: 1.9, beacon: vb, text: () => distractText('Shake the vending machine'), act: () => this.distract(VENDING.x, -33.5, 'snax') });
    // 70: the safe, the stapler, the stairs.
    box(P.ceo, SAFE.x, 0, SAFE.z, 1.0, 1.3, 1.0, 0x6b7077); box(P.ceo, SAFE.x - 0.51, 0.65, SAFE.z, 0.04, 0.5, 0.5, 0x3a3f45);
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 16), mat(0xd9b04a)); dial.rotation.z = Math.PI / 2; dial.position.set(SAFE.x - 0.53, 0.8, SAFE.z); P.ceo.add(dial);
    const sd = this.safeDoor = box(P.ceo, SAFE.x - 0.52, 0.1, SAFE.z, 0.06, 1.1, 0.9, 0x555a62); sd.geometry.translate(0, 0, 0.45); sd.position.z = SAFE.z - 0.45;
    sign(P.ceo, 'DO NOT OPEN · FOUNDER', SAFE.x - 0.56, 1.6, SAFE.z, -Math.PI / 2, 1.8, '#3a1010', '#ff7a5a');
    solid('ceo', SAFE.x - 0.5, SAFE.x + 0.5, SAFE.z - 0.5, SAFE.z + 0.5, 1.3);
    const sb = beacon(P.ceo, SAFE.x, SAFE.z);
    spot({ floor: 'ceo', x: SAFE.x - 1.3, z: SAFE.z, r: 2.1, beacon: sb, text: () => (this.run && this.run.badge === 3 && !this.run.lanyard ? '[G] Crack the safe' : null), act: () => this.openSafe() });
    const st = new THREE.Group(); st.position.set(STAPLER.x, 0.78, STAPLER.z);
    const jel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.22), mat(0x7be04a, { transparent: true, opacity: 0.55, depthWrite: false })); jel.position.y = 0.1; st.add(jel);
    const sm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.05), mat(0xc1121f)); sm.position.y = 0.09; st.add(sm);
    P.ceo.add(st); this.staplerM = st;
    spot({ floor: 'ceo', x: STAPLER.x, z: STAPLER.z - 0.5, r: 1.6, text: () => (this.run && this.run.badge === 3 && !this.run.stapler ? "[G] Take the CEO's stapler (in jelly)" : null), act: () => this.stapler() });
    const door = (gr: THREE.Group, x: number, z: number, label: string): void => { box(gr, x, 0, z, 0.1, 2.1, 1.1, 0x1f8a3a); sign(gr, label, x + (x > 0 ? -0.08 : 0.08), 2.45, z, x > 0 ? -Math.PI / 2 : Math.PI / 2, 2.2, '#1f8a3a', '#ffffff'); };
    door(P.ceo, STAIRS_DOWN.x - 0.4, STAIRS_DOWN.z, 'FIRE STAIRS ▼');
    door(P.ceo, STAIRS_UP.x + 0.55, STAIRS_UP.z, 'ROOF STAIRS ▲');
    const sdb = beacon(P.ceo, STAIRS_DOWN.x - 0.2, STAIRS_DOWN.z, 0xff5a3c), sub = beacon(P.ceo, STAIRS_UP.x + 0.3, STAIRS_UP.z, 0xff5a3c);
    spot({ floor: 'ceo', x: STAIRS_DOWN.x + 0.8, z: STAIRS_DOWN.z, r: 1.8, beacon: sdb, text: () => (this.run && this.run.alarm && this.run.lanyard ? '[G] Fire stairs down to 34 (the hoist)' : null), act: () => this.stairs('reno') });
    spot({ floor: 'ceo', x: STAIRS_UP.x - 0.8, z: STAIRS_UP.z, r: 1.8, beacon: sub, text: () => (this.run && this.run.alarm && this.run.lanyard ? '[G] Roof stairs up (the parachute rig)' : null), act: () => this.stairs('roof') });
    // 34: the hoist.
    box(P.reno, HOIST.x - 0.3, 0, HOIST.z, 0.12, 3, 2.4, 0xe8a21a); box(P.reno, HOIST.x - 0.3, 0.05, HOIST.z, 0.5, 0.1, 2.4, 0x6b7077); box(P.reno, HOIST.x - 0.3, 2.9, HOIST.z, 0.5, 0.1, 2.4, 0x6b7077);
    for (const dz of [-1.2, 1.2]) box(P.reno, HOIST.x + 0.3, 0, HOIST.z + dz, 0.14, 3.2, 0.14, 0xe8a21a);
    box(P.reno, HOIST.x + 0.3, 3.0, HOIST.z, 0.14, 0.2, 2.5, 0xe8a21a);
    sign(P.reno, 'CONSTRUCTION HOIST · HARD HATS', HOIST.x + 0.3, 2.2, HOIST.z, Math.PI / 2, 2.6, '#f2c230', '#111111');
    const hb = beacon(P.reno, HOIST.x - 0.1, HOIST.z, 0xff5a3c);
    spot({ floor: 'reno', x: HOIST.x + 1.2, z: HOIST.z, r: 2.2, beacon: hb, text: () => (this.run && this.run.alarm && this.run.lanyard ? '[G] Ride the construction hoist down' : null), act: () => this.beginRide('hoist') });
    // R: the parachute rig.
    box(P.roof, CHUTE.x - 1.0, 0, 0.55, 0.12, 1.9, 0.12, 0x2a2e33); box(P.roof, CHUTE.x + 1.0, 0, 0.55, 0.12, 1.9, 0.12, 0x2a2e33); box(P.roof, CHUTE.x, 1.7, 0.55, 2.1, 0.12, 0.12, 0x2a2e33);
    box(P.roof, CHUTE.x, 0.7, 0.45, 0.8, 0.9, 0.35, 0x7be04a); box(P.roof, CHUTE.x, 0.7, 0.62, 0.7, 0.8, 0.02, 0xf2f2f2);
    sign(P.roof, 'SPEEDSCAN BRAND SHOOT · PARACHUTE (DEMO)', CHUTE.x, 2.5, 0.5, Math.PI, 3.6);
    const cb = beacon(P.roof, CHUTE.x, 0.2, 0xff5a3c);
    spot({ floor: 'roof', x: CHUTE.x, z: CHUTE.z, r: 2.4, beacon: cb, text: () => (this.run && this.run.alarm && this.run.lanyard ? '[G] Strap on the parachute and step off' : null), act: () => this.beginRide('chute') });
    // The guards: people, and a wedge of light on the floor.
    const mkGuard = (name: string, path: number[][], speed: number): Guard => {
      const cg = new THREE.BufferGeometry(), N = 15;
      cg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((N + 1) * 3), 3));
      const idx: number[] = []; for (let i = 1; i < N; i++) idx.push(0, i, i + 1);
      cg.setIndex(idx); cg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5); g.flip.geo(cg, 'position');
      const cone = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0x7be04a, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
      cone.frustumCulled = false; cone.visible = false; cone.renderOrder = 3; g.scene.add(cone);
      return { name, p: null, at: 'gone', path, i: 0, dir: 1, wait: 0, lx: path[0][0], lz: path[0][1], fx: 1, fz: 0, meter: 0, cone, cg, seen: false, speed };
    };
    this.guards = [mkGuard('Dale', [[26, -9.5], [-26, -9.5]], 1.25), mkGuard('Marge', [[-3, -20], [-27, -20]], 1.1)];
  }

  /** Props are drawn only on the floor the player is on, and only while the job is on; beacons only for what matters now. */
  private refreshProps(): void {
    if (!this.props) return;
    const r = this.run, p = this.game.player;
    for (const w of Object.keys(this.props) as Where[]) this.props[w].visible = !!r && Math.abs(p.y - FLOOR_Y[w] - 1) < 4.5;
    for (const s of this.spots) if (s.beacon) s.beacon.visible = !!r && s.text() !== null;
    if (this.safeDoor) this.safeDoor.rotation.y = r?.lanyard ? -1.9 : 0;
    if (this.staplerM) this.staplerM.visible = !!r && !r.stapler;
  }

  // ── floors and spots ──────────────────────────────────────────────────────────

  private floorOf(y: number): Where | null {
    if (Math.abs(y - Y.roof) < 3) return 'roof';
    for (const f of FLOORS) if (y > f.y - 1 && y < f.y + FLOOR_H + 1) return (f.id === 'break' ? 'brk' : f.id) as Where;
    return null;
  }

  private local(): Me {
    const p = this.game.player, x = p.x - HQ.x, z = p.z - HQ.z;
    const inside = Math.abs(x) < 36 && z > -40 && z < 9;
    return { x, z, y: p.y, at: inside ? this.floorOf(p.y) : null, lobby: inside && p.y < 15 };
  }

  private rode(label: string): void {
    const r = this.run; if (!r) return;
    this.refreshProps();
    if (label === '20' && r.step === 1) this.say('hall', kid.on ? 'The data hall hums. Two guards stroll about with flashlights. They have very kind faces.' : 'The data hall hums. Two guards walk their rounds; the green wedges on the floor are where they can see.');
    if (label === '28') this.say('break', 'The break room. A ping-pong ball machine and the vending machines. Somebody here is about to have a very distracting day.');
    if (label === '70') this.say('ceo', "The CEO's floor. Carpet like a hush. The safe is in the corner office, behind the desk.");
  }

  private say(key: string, text: string, secs = 7): void { if (this.told.has(key)) return; this.told.add(key); this.game.hud.toast(text, secs); }

  // ── the mini games ────────────────────────────────────────────────────────────

  private openPrint(): void {
    const r = this.run; if (!r || this.mini.open) return;
    this.mini.start('print', 'Visitor badge printer', 'Three passes (yellow, magenta, cyan). Stop the print head in the green. SPACE or tap STOP.', 3, 0.75, 0.2, (m) => {
      if (!this.run) return;
      this.run.badge = 1; this.run.step = Math.max(this.run.step, 1);
      this.game.hud.stamp('BADGE PRINTED', 'VISITOR · guest of nobody');
      this.game.hud.toast(`The kiosk prints "VISITOR: Mr. D. Zzyzx, guest of nobody"${m ? ` (${m} wasted ribbon${m === 1 ? '' : 's'})` : ''}. Level 1. The lifts now take you to 20, 28 and 42.`, 8);
      this.refreshProps();
    });
  }

  private openSafe(): void {
    const r = this.run; if (!r || this.mini.open) return;
    this.mini.start('safe', "The Founder's safe", 'Three tumblers. Stop the needle in the notch each time. Three misses and the alarm goes early.', 3, 0.62, 0.1, () => this.grab(), () => {
      const rr = this.run; if (!rr) return;
      rr.misses++;
      this.game.hud.toast(`Click-CLUNK. The safe grumbles (${rr.misses} of 3).`, 2);
      if (rr.misses >= 3 && !rr.alarm) { rr.early = true; this.alarmOn(true); }
    });
  }

  // ── the capers ────────────────────────────────────────────────────────────────

  private distract(x: number, z: number, what: 'balls' | 'snax'): void {
    const r = this.run; if (!r || r.away > 0) return;
    r.away = AWAY_GONE + AWAY_STAY;
    this.ballFrom = { x, z }; this.ballT = 14;
    this.spawnBalls(what);
    this.game.hud.stamp(what === 'balls' ? 'BALLS EVERYWHERE' : 'SNAX!', 'Security to the break room');
    this.game.hud.toast(what === 'balls' ? 'The ball machine has a lot to say. Over the intercom: "Security to the break room, please. There are ping-pong balls."' : 'The vending machine has paid out everything. Over the intercom: "Security to the break room, please. There is a snack situation."', 7);
    this.say('lift', 'Hurry to the lift and up to 20. The guards leave in a moment.', 6);
  }

  private spawnBalls(what: 'balls' | 'snax'): void {
    this.clearBalls();
    const P = this.props?.brk; if (!P) return;
    const geo = new THREE.SphereGeometry(0.02, 8, 6), cols = what === 'balls' ? [0xffffff, 0xffd34a] : [0xe8453c, 0xf2c230, 0x2f7de1, 0x3aa65c];
    const snax = new THREE.BoxGeometry(0.08, 0.1, 0.06);
    for (let i = 0; i < 36; i++) {
      const m = new THREE.Mesh(what === 'balls' ? geo : snax, new THREE.MeshBasicMaterial({ color: cols[i % cols.length], toneMapped: false }));
      const a = (i / 36) * Math.PI * 2 * 3.7;
      const s = what === 'balls' ? 1.6 + (i % 5) * 0.5 : 0.8 + (i % 4) * 0.35;
      m.position.set(this.ballFrom.x, what === 'balls' ? 1.4 : 1.0, this.ballFrom.z + (what === 'snax' ? 0.8 : 0));
      P.add(m); this.balls.push({ m, vx: Math.cos(a) * s, vy: 2 + (i % 4), vz: (what === 'snax' ? Math.abs(Math.sin(a)) : Math.sin(a)) * s });
    }
  }

  private clearBalls(): void { for (const b of this.balls) { b.m.removeFromParent(); (b.m.material as THREE.Material).dispose(); } this.balls.length = 0; this.ballT = 0; }

  private tickBalls(dt: number): void {
    if (!this.balls.length) return;
    this.ballT -= dt;
    for (const b of this.balls) {
      const m = b.m; b.vy -= 9.8 * dt;
      m.position.x += b.vx * dt; m.position.y += b.vy * dt; m.position.z += b.vz * dt;
      if (m.position.y < 0.04) { m.position.y = 0.04; b.vy = Math.abs(b.vy) * 0.62; b.vx *= 0.9; b.vz *= 0.9; if (b.vy < 0.4) b.vy = 0; }
      m.position.x = Math.max(-31, Math.min(31, m.position.x)); m.position.z = Math.max(-34, Math.min(5, m.position.z));
    }
    if (this.ballT <= -30) this.clearBalls();
  }

  private grab(): void {
    const r = this.run; if (!r) return;
    r.lanyard = true; r.step = 3;
    this.refreshProps();
    this.game.hud.stamp('GOT THE LANYARD', 'Golden, and a little tacky');
    if (!r.alarm) this.alarmOn(false);
    else { r.alarmT = ALARM_S; this.game.hud.toast('The Golden Lanyard is yours. The alarm is already on, so, run.', 6); }
  }

  private stapler(): void {
    const r = this.run; if (!r || r.stapler) return;
    r.stapler = true; this.refreshProps();
    this.game.hud.stamp('STAPLER', "The CEO's, in jelly");
    this.game.hud.toast("You have the CEO's stapler. It is in jelly. It will never be used again, which is the point.", 6);
  }

  private alarmOn(early: boolean): void {
    const r = this.run; if (!r || r.alarm) return;
    r.alarm = true; r.alarmT = ALARM_S; this.stats.alarms++;
    this.alarmEl.classList.toggle('kid', kid.on); this.alarmEl.classList.add('on');
    this.banner.classList.toggle('kid', kid.on); this.banner.classList.add('on');
    this.banner.textContent = kid.on ? 'THE LOST & FOUND BELL IS RINGING' : 'ALARM · LIFTS LOCKED';
    this.game.hud.toast(early ? (kid.on ? 'The bell goes early! The lifts have gone for a lie down.' : 'ALARM! The safe tripped it early. The lifts are locked.') : (kid.on ? 'The Lost & Found bell rings! The lifts are resting. Fire stairs on the west wall, roof stairs on the east.' : 'ALARM! The lifts lock. Fire stairs on the west wall lead down to the renovation (and the hoist); the roof stairs on the east wall lead up to the parachute. 100 seconds.'), 10);
  }

  private stairs(to: 'reno' | 'roof'): void {
    const r = this.run; if (!r || !r.alarm || r.esc || r.ride) return;
    this.place(to === 'reno' ? RENO_ARRIVE.x : ROOF_ARRIVE.x, to === 'reno' ? Y.reno : Y.roof, to === 'reno' ? RENO_ARRIVE.z : ROOF_ARRIVE.z, to === 'reno' ? Math.PI : 0);
    this.game.hud.toast(to === 'reno' ? 'Thirty-six flights, taken two at a time, in a building that is mostly stairwell. Floor 34, the renovation. There is a hoist on the west wall.' : 'Up the roof stairs. The wind. The city. A parachute rack, with a sign that says DEMO.', 7);
    this.refreshProps();
  }

  /** Put the player at a spot in the tower (floor-local x, z), the way the lifts do: teleport, then the floor's height. */
  private place(lx: number, y: number, lz: number, h: number): void {
    const g = this.game;
    g.player.teleport(HQ.x + lx, HQ.z + lz, h);
    g.player.person.y = y;
    g.cam.snap();
  }

  /** Escorted out (kid mode: politely asked to leave): back to the checkpoint with the badge, twenty seconds on the clock. */
  private escort(why: string): void {
    const r = this.run; if (!r || r.esc) return;
    r.esc = { t: 0, why };
    r.escorts++; r.pen += PENALTY; this.stats.escorts++;
    this.game.input.setEnabled(false);
    this.fade.style.opacity = '1';
    this.game.hud.stamp(kid.on ? 'PLEASE LEAVE' : 'ESCORTED OUT', kid.on ? 'Politely, with a sticker' : why);
    this.game.hud.toast(kid.on ? `"Excuse me, you seem to be lost. This way, please." A guard with a kind face walks you out. ${why}` : `"Sir, this is a restricted floor." Two firm hands, one lift. ${why}`, 6);
  }

  private checkpoint(): { x: number; y: number; z: number; name: string } {
    const r = this.run!;
    if (r.step >= 2) return { x: LANDING.x, y: Y.ceo, z: LANDING.z, name: 'the 70 lift lobby' };
    if (r.badge >= 1) return { x: LANDING.x, y: Y.print, z: LANDING.z, name: 'the lift lobby on 12' };
    return { x: LANDING.x, y: Y.lobby, z: LANDING.z, name: 'the lobby' };
  }

  private tickEscort(dt: number): void {
    const r = this.run!, e = r.esc!;
    e.t += dt;
    if (e.t >= 0.5 && e.t - dt < 0.5) {
      const cp = this.checkpoint();
      this.place(cp.x, cp.y, cp.z, 0);
      for (const gd of this.guards) { gd.meter = 0; if (gd.at === 'data') this.guardHome(gd); }
      this.holding = false; r.encode = 0; this.spotted = 0;
      if (r.alarm) r.alarmT = ALARM_S;
      this.game.hud.toast(kid.on ? `You are back at ${cp.name}, badge intact. Try again, quieter.` : `You are put back at ${cp.name}. Badge intact. Try that again, quieter.`, 5);
      this.refreshProps();
    }
    if (e.t >= 0.9) this.fade.style.opacity = '0';
    if (e.t >= 1.4) { r.esc = null; this.game.input.setEnabled(true); }
  }

  // ── guards ────────────────────────────────────────────────────────────────────

  private guardHome(gd: Guard): void {
    gd.at = 'data'; gd.dir = 1; gd.wait = 0; gd.meter = 0;
    gd.lx = gd.path[0][0]; gd.lz = gd.path[0][1];
    const n = gd.path[1], dx = n[0] - gd.lx, dz = n[1] - gd.lz, d = Math.hypot(dx, dz) || 1;
    gd.fx = dx / d; gd.fz = dz / d; gd.i = 1;
  }

  private ensureGuardPeople(): void {
    const ppl = this.game.people; if (!ppl) return;
    for (const gd of this.guards) {
      if (gd.p && ppl.list.includes(gd.p)) continue;
      gd.p = ppl.spawn(HQ.x + gd.lx, HQ.z + gd.lz, 0, look({ hair: gd.name === 'Dale' ? 0x2a1d12 : 0x9a9a9a, build: gd.name === 'Dale' ? 1.12 : 0.98 }));
      gd.p.visible = false;
    }
  }

  private blocked(ax: number, az: number, bx: number, bz: number): boolean {
    for (const [x0, x1, z0, z1] of BLOCKERS) {
      let t0 = 0, t1 = 1; const dx = bx - ax, dz = bz - az;
      for (const [p, q, lo, hi] of [[dx, ax, x0, x1], [dz, az, z0, z1]]) {
        if (Math.abs(p) < 1e-9) { if (q < lo || q > hi) { t0 = 2; break; } continue; }
        let a = (lo - q) / p, b = (hi - q) / p; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      }
      if (t0 <= t1) return true;
    }
    return false;
  }

  /** How far a guard's ray goes before the racks or the core stop it. */
  private rayLen(ax: number, az: number, dx: number, dz: number, max: number, floor: 'data' | 'brk'): number {
    if (floor === 'brk') return max;
    let lo = 0, hi = max;
    for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (this.blocked(ax, az, ax + dx * mid, az + dz * mid)) hi = mid; else lo = mid; }
    return lo;
  }

  private tickGuards(dt: number, me: Me): void {
    const r = this.run!;
    if (!this.props) return;
    this.ensureGuardPeople();
    // The distraction clock: they go, they look, they come back.
    if (r.away > 0) {
      r.away -= dt;
      const gone = r.away > AWAY_STAY, home = r.away <= 0;
      for (const [k, gd] of this.guards.entries()) {
        if (gd.at === 'data') { gd.at = 'gone'; gd.meter = 0; }
        if (!gone && !home && gd.at === 'gone') gd.at = 'brk';
        if (gd.at === 'brk') { gd.lx = this.ballFrom.x + (k ? 1.8 : -1.8); gd.lz = this.ballFrom.z + 2.2; gd.fx = k ? -0.6 : 0.6; gd.fz = -0.8; }
      }
      if (home) { r.away = 0; for (const gd of this.guards) this.guardHome(gd); this.game.hud.toast(kid.on ? 'The guards finish tutting at the snacks and wander back to the data hall.' : 'The guards are back at their posts in the data hall.', 5); }
    }
    let worst = 0;
    for (const gd of this.guards) {
      const floor = gd.at === 'data' ? 'data' : gd.at === 'brk' ? 'brk' : null;
      const fy = floor === 'data' ? Y.data : Y.brk;
      const here = !!floor && me.at === (floor as Where) && !r.esc && !r.ride;
      if (floor === 'data') {
        if (gd.wait > 0) gd.wait -= dt;
        else {
          const [tx, tz] = gd.path[gd.i], dx = tx - gd.lx, dz = tz - gd.lz, d = Math.hypot(dx, dz);
          if (d < 0.2) {
            gd.i += gd.dir;
            if (gd.i < 0 || gd.i >= gd.path.length) { gd.dir = -gd.dir; gd.i += gd.dir * 2; }
            gd.wait = 1.4;
            const n = gd.path[gd.i], ex = n[0] - gd.lx, ez = n[1] - gd.lz, ed = Math.hypot(ex, ez) || 1;
            gd.fx = ex / ed; gd.fz = ez / ed;
          } else { const s = Math.min(d, gd.speed * dt); gd.lx += dx / d * s; gd.lz += dz / d * s; gd.fx = dx / d; gd.fz = dz / d; }
        }
      }
      const near = !!floor && Math.abs(this.game.player.y - fy) < 6;
      const p = gd.p;
      if (p) {
        p.x = HQ.x + gd.lx; p.z = HQ.z + gd.lz; p.y = fy; p.h = Math.atan2(-gd.fx, -gd.fz);
        const walking = floor === 'data' && gd.wait <= 0;
        p.pose = walking ? 'walk' : 'stand'; p.speed = walking ? gd.speed : 0;
        p.visible = near;
      }
      gd.cone.visible = near;
      gd.seen = false;
      if (here) {
        const dx = me.x - gd.lx, dz = me.z - gd.lz, d = Math.hypot(dx, dz);
        const inCore = me.z < -3.2 && me.z > -6.6 && Math.abs(me.x) < 9.6;
        if (d < GUARD_RANGE && !inCore) {
          const inCone = (dx * gd.fx + dz * gd.fz) / (d || 1) > Math.cos(GUARD_HALF) || d < 1.8;
          if (inCone && !(floor === 'data' && this.blocked(gd.lx, gd.lz, me.x, me.z))) gd.seen = true;
        }
      }
      if (gd.seen) gd.meter = Math.min(1, gd.meter + dt / SPOT_S * (Math.hypot(me.x - gd.lx, me.z - gd.lz) < 5 ? 1.8 : 1));
      else gd.meter = Math.max(0, gd.meter - dt * 0.55);
      worst = Math.max(worst, gd.meter);
      if (near) this.drawCone(gd, floor as 'data' | 'brk', fy);
    }
    this.spotted = worst;
    if (worst >= 1 && !r.esc) this.escort(me.at === 'brk' ? 'Caught in the break room.' : 'Caught in the data hall.');
  }

  private drawCone(gd: Guard, floor: 'data' | 'brk', fy: number): void {
    const a = gd.cg.getAttribute('position') as THREE.BufferAttribute, N = 15, base = Math.atan2(gd.fz, gd.fx);
    a.setXYZ(0, HQ.x + gd.lx, fy + 0.06, HQ.z + gd.lz);
    for (let i = 0; i < N; i++) {
      const ang = base + (i / (N - 1) - 0.5) * 2 * GUARD_HALF, dx = Math.cos(ang), dz = Math.sin(ang);
      const len = this.rayLen(gd.lx, gd.lz, dx, dz, GUARD_RANGE, floor);
      a.setXYZ(i + 1, HQ.x + gd.lx + dx * len, fy + 0.06, HQ.z + gd.lz + dz * len);
    }
    a.needsUpdate = true;
    const m = gd.cone.material as THREE.MeshBasicMaterial;
    m.color.setRGB(0.48 + gd.meter * 0.52, 0.88 - gd.meter * 0.62, 0.29 - gd.meter * 0.1);
    m.opacity = 0.26 + gd.meter * 0.3;
  }

  // ── rides: the hoist and the parachute ───────────────────────────────────────

  private beginRide(kind: 'hoist' | 'chute'): void {
    const r = this.run, g = this.game; if (!r || !r.alarm || r.ride || r.esc) return;
    const cage = new THREE.Group();
    const mt = (hex: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: hex, toneMapped: false, fog: false, side: THREE.DoubleSide });
    let x0: number, z0: number, y0: number, x1: number, z1: number, dur: number;
    if (kind === 'hoist') {
      x0 = HQ.x - 36.2; z0 = HQ.z + HOIST.z; y0 = Y.reno; x1 = x0; z1 = z0; dur = 11;
      const plat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 2.4), mt(0x6b7077)); plat.position.y = -0.06; cage.add(plat);
      for (const [px, pz] of [[-1.15, -1.15], [1.15, -1.15], [-1.15, 1.15], [1.15, 1.15]]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.2, 0.08), mt(0xe8a21a)); post.position.set(px, 1.1, pz); cage.add(post); }
      const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 2.4), mt(0xe8a21a)); top.position.y = 2.2; cage.add(top);
      const rope = new THREE.Mesh(new THREE.BoxGeometry(0.04, 400, 0.04), mt(0x2a2e33)); rope.position.y = 200; cage.add(rope);
    } else {
      x0 = HQ.x + CHUTE.x; z0 = HQ.z + 2.6; y0 = Y.roof; x1 = this.landAt.x; z1 = this.landAt.z; dur = 17;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.6, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), mt(0x7be04a)); dome.scale.y = 0.62; dome.position.y = 4.4; cage.add(dome);
      const stripe = new THREE.Mesh(new THREE.SphereGeometry(2.62, 18, 8, 0, 0.9, 0, Math.PI / 2), mt(0xffffff)); stripe.scale.y = 0.62; stripe.position.y = 4.4; cage.add(stripe);
      for (const [px, pz] of [[-1.7, 0], [1.7, 0], [0, -1.7], [0, 1.7]]) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.015, 3.8, 0.015), mt(0xeeeeee)); line.position.set(px * 0.55, 2.1, pz * 0.55); line.rotation.z = px * 0.11; line.rotation.x = -pz * 0.11; cage.add(line);
      }
    }
    g.scene.add(cage);
    r.ride = { kind, t: 0, dur, x0, z0, y0, x1, z1, mesh: cage };
    r.route = kind;
    g.input.setEnabled(false);
    g.hud.toast(kind === 'hoist' ? 'The hoist shudders, remembers its job, and starts down. 129 metres. Hold your hard hat.' : "You step off a 322-metre roof wearing a promotional parachute. It opens. It is, to everyone's surprise, a good one.", 6);
  }

  private tickRide(dt: number): void {
    const r = this.run!, rd = r.ride!, g = this.game, p = g.player;
    rd.t += dt;
    const k = Math.min(1, rd.t / rd.dur), chute = rd.kind === 'chute', e = chute ? k : k * k * (3 - 2 * k);
    const h = chute ? Math.atan2(rd.x0 - rd.x1, rd.z0 - rd.z1) : Math.PI * 1.5;
    const ee = chute ? Math.pow(e, 0.8) : e;
    let x = rd.x0 + (rd.x1 - rd.x0) * ee, z = rd.z0 + (rd.z1 - rd.z0) * ee;
    if (chute) { x += Math.sin(e * 9) * 6 * (1 - e); z += Math.cos(e * 7) * 3 * (1 - e) * Math.min(1, e / 0.3); }
    const gy = groundAt(rd.x1, rd.z1);
    const y = chute ? rd.y0 + (gy - rd.y0) * (1 - Math.pow(1 - e, 1.6)) : rd.y0 + (gy - rd.y0) * e;
    p.teleport(x, z, h);
    p.person.y = Math.max(gy, y);
    rd.mesh.position.set(x, p.person.y, z);
    rd.mesh.rotation.y = chute ? Math.sin(rd.t * 1.4) * 0.3 : 0;
    g.cam.snap();
    if (k >= 1) this.land(rd);
  }

  private land(rd: Ride): void {
    const r = this.run!, g = this.game;
    rd.mesh.removeFromParent();
    r.ride = null; g.input.setEnabled(true);
    g.player.teleport(rd.x1, rd.z1, rd.kind === 'hoist' ? Math.PI / 2 : 0);
    g.cam.snap();
    r.step = 4; r.landed = { x: rd.x1, z: rd.z1 };
    this.alarmEl.classList.remove('on'); this.banner.classList.remove('on');
    const pl = g.player; pl.heat = Math.max(pl.heat, 2);
    // Brenda's getaway pickup, round the corner.
    try { g.vehicles.spawn('pickup', rd.x1 + 5, rd.z1 + 2, 0, 0xf0a202); } catch (e) { console.warn('heist: no pickup', e); }
    g.hud.stamp(kid.on ? 'LOST & FOUND' : 'ON THE RUN', "Lou's yard, The Cannery");
    g.hud.toast(kid.on ? "Down! A Lost & Found officer has spotted a gentleman with a golden lanyard and would like to escort him to the desk. Brenda's pickup is round the corner. Get the Lanyard to Lou's yard before the escort catches up." : "Down, and out. The Patrol has noticed. Brenda's pickup is round the corner. Get the Lanyard to Lou's yard at The Cannery, and lose the cruisers first.", 10);
  }

  // ── per-frame ─────────────────────────────────────────────────────────────────

  blips(out: Blip[]): void {
    const p = this.game.player, r = this.run;
    if (!r) { if (this.isFree() && this.contactAt.x !== 0 && Math.hypot(p.x - this.contactAt.x, p.z - this.contactAt.z) < 700) out.push({ x: this.contactAt.x, z: this.contactAt.z, kind: 'giver', label: 'B' }); return; }
    const me = this.local();
    if (r.step === 4) out.push({ x: this.drop.x, z: this.drop.z, kind: 'goal', label: 'L' });
    else if (!me.at && !me.lobby && !r.alarm) out.push({ x: HQ.x, z: HQ.z + 12, kind: 'goal', label: 'S' });
  }

  private objective(me: Me): { text: string; timer: [string, string, boolean] } {
    const r = this.run!, lim = Math.max(0, r.lim - r.t), g = this.game;
    const t: [string, string, boolean] = r.alarm && r.step === 3 && !r.ride ? ['Security in', clock(r.alarmT), r.alarmT < 30] : r.away > 0 ? ['Guards away', clock(r.away), r.away < 15] : ['Closing time', clock(lim), lim < 120];
    switch (r.step) {
      case 0: return { text: me.at === 'print' ? 'Floor 12: print yourself a visitor badge at the kiosk' : me.lobby || me.at ? 'Take the lift to 12, the ID card print room (G in the car, or press 1-8)' : 'Walk into SpeedScan headquarters, and take the lift to 12', timer: t };
      case 1: return { text: r.away > 0 ? 'The guards are away: lift to 20, the card encoder at the west end of the data hall' : 'Floor 20, data hall: reach the card encoder (west end), or send the guards to the break room (28) first', timer: t };
      case 2: return { text: r.badge >= 3 ? "Lift to 70: crack the safe in the CEO's corner office" : 'Upgrade the badge at the card encoder, floor 20', timer: t };
      case 3: return { text: r.ride ? 'Hold on' : 'ALARM: fire stairs (west) down to the hoist on 34, or roof stairs (east) to the parachute', timer: t };
      default: return { text: g.player.heat > 0 ? "Lose the Patrol, then get the Lanyard to Lou's yard, The Cannery" : "Get the Golden Lanyard to Lou's yard, The Cannery", timer: t };
    }
  }

  update(dt: number): void {
    const g = this.game, p = g.player;
    this.prompt = null;
    if (this.cardT > 0 && (this.cardT -= dt) <= 0 && this.cardKind === 'report') this.closeCard();
    if ((this.recheck -= dt) <= 0) {
      this.recheck = 2;
      if (this.contactAt.x === 0) { try { this.sidewalk(); } catch { /* the plan is not up yet */ } }
      this.keepContact();
    }
    const r = this.run;
    if (!r) { this.hub(); return; }
    if (!(p.health > 0)) { this.fail('You have left the job (feet first).'); return; }
    if (Math.hypot(p.x - HQ.x, p.z - HQ.z) > 3500) { this.fail('You have wandered too far from SpeedScan. Brenda gives up and goes home.'); return; }
    if (g.input.eat('reload') && !this.mini.open) { this.abandon('Job dropped. Brenda files it under "Maybe Next Quarter".'); return; }
    r.t += dt;
    const me = this.local();
    this.refreshProps();
    if (this.mini.open) { this.mini.tick(dt); this.barOn(false); }
    else if (r.esc) this.tickEscort(dt);
    else if (r.ride) this.tickRide(dt);
    else this.tickPlay(dt, me);
    this.tickBalls(dt);
    if (!this.run) return;
    const o = this.objective(me);
    g.hud.objective(o.text);
    g.hud.timer(o.timer[0], o.timer[1], o.timer[2]);
    // The ground legs: markers and the route line.
    if (r.step === 4) { this.target = this.drop; this.targetName = "Lou's yard"; this.markers.put(this.drop.x, this.drop.z, 'goal', 5, 34); }
    else if (r.step === 0 && !me.at && !me.lobby && !r.alarm) { this.target = { x: HQ.x, z: HQ.z + 12 }; this.targetName = 'SpeedScan HQ'; this.markers.put(HQ.x, HQ.z + 12, 'goal', 4, 30); }
    else { this.target = null; this.targetName = null; }
  }

  private tickPlay(dt: number, me: Me): void {
    const r = this.run!, g = this.game, p = g.player;
    if (r.t > r.lim) { this.fail('Closing time. The building locks up, and Brenda has gone to get a sandwich. The job is off.'); return; }
    this.tickGuards(dt, me);
    if (!this.run || r.esc) return;
    this.barOn(false);
    if (this.spotted > 0.02) this.barOn(true, kid.on ? 'A guard has noticed you...' : 'Spotted!', this.spotted * 100, true);
    // The alarm clock: stay in, and security walks you back.
    if (r.alarm && r.step === 3) {
      r.alarmT -= dt;
      if (r.alarmT <= 0) { if (me.at) { this.escort(kid.on ? 'The Lost & Found desk has found you.' : 'Security found you in the stairwell.'); return; } r.alarmT = 0; }
    }
    // Hold to encode.
    if (this.holding) {
      const near = me.at === 'data' && Math.hypot(me.x - (ENCODER.x + 1.4), me.z - ENCODER.z) < 3 && r.badge === 1;
      if (!near) { this.holding = false; r.encode = 0; }
      else {
        r.encode += dt; this.barOn(true, 'Encoding the badge...', r.encode / 4 * 100, this.spotted > 0.02);
        if (r.encode >= 4) {
          this.holding = false; r.encode = 0; r.badge = 3; r.step = 2;
          g.hud.stamp('LEVEL 3 BADGE', 'EXECUTIVE · the lifts will take you anywhere');
          g.hud.toast('The encoder blinks, thinks, and promotes you to Executive. The Founder would like a word with HR. The lifts now go to 34, 70 and the roof. Next: 70.', 8);
          this.refreshProps();
        }
      }
    }
    // The drop.
    if (r.step === 4) {
      const d = Math.hypot(p.x - this.drop.x, p.z - this.drop.z);
      if (d < 9) { if (p.heat > 0) this.prompt = 'The Patrol is still on you. Lose them first.'; else { this.win(); return; } }
    }
    // Spots.
    if (!me.at || p.vehicle) return;
    let best: Spot | null = null, bd = 1e9;
    for (const s of this.spots) {
      if (s.floor !== me.at) continue;
      const d = Math.hypot(me.x - s.x, me.z - s.z);
      if (d < s.r && d < bd && s.text() !== null) { best = s; bd = d; }
    }
    if (best && !this.holding) { this.prompt = best.text(); if (g.input.eat('interact')) best.act(); }
  }

  private keepContact(): void {
    const ppl = this.game.people; if (!ppl || this.contactAt.x === 0) return;
    if (this.contact && ppl.list.includes(this.contact)) return;
    const p = this.game.player;
    if (Math.hypot(p.x - this.contactAt.x, p.z - this.contactAt.z) > 400) return;
    this.contact = ppl.spawn(this.contactAt.x, this.contactAt.z, 0, look({ skin: 0xd9a37c, hair: 0x7a2f8a, top: 0x1f8a3a, bottom: 0x2a2e33, hat: null, build: 0.98 }));
    this.contact.pose = 'stand';
  }

  /** At rest: Brenda, at the corner of the HQ block. */
  private hub(): void {
    const g = this.game, p = g.player;
    if (this.contactAt.x === 0) return;
    const d = Math.hypot(p.x - this.contactAt.x, p.z - this.contactAt.z), c = this.contact;
    if (c && g.people && g.people.list.includes(c)) { c.h = Math.atan2(-(p.x - c.x), -(p.z - c.z)); c.visible = d < 150; }
    if (d < 200 && this.isFree() && g.state === 'play') this.markers.put(this.contactAt.x, this.contactAt.z, 'giver', 3.4, 24);
    if (this.cardKind === 'brief' && d > 16) this.closeCard();
    if (d > 4.5 || !this.isFree() || p.vehicle) return;
    if (this.cardKind === 'none') this.prompt = '[G] Brenda Plonk: "The Speed Scan"';
    if (this.cardKind === 'none' && g.input.eat('interact')) this.openBrief();
  }

  /** For the tests. */
  info(): Record<string, unknown> {
    const r = this.run, me = this.local();
    return {
      run: r ? { t: +r.t.toFixed(1), step: r.step, badge: r.badge, alarm: r.alarm, alarmT: +r.alarmT.toFixed(1), early: r.early, escorts: r.escorts, pen: r.pen, stapler: r.stapler, lanyard: r.lanyard, away: +r.away.toFixed(1), encode: +r.encode.toFixed(1), route: r.route, misses: r.misses, esc: !!r.esc, ride: r.ride ? { kind: r.ride.kind, t: +r.ride.t.toFixed(1) } : null, landed: r.landed } : null,
      me: { x: +me.x.toFixed(1), z: +me.z.toFixed(1), y: +me.y.toFixed(1), at: me.at, lobby: me.lobby },
      guards: this.guards.map((q) => ({ name: q.name, at: q.at, x: +q.lx.toFixed(1), z: +q.lz.toFixed(1), fx: +q.fx.toFixed(2), fz: +q.fz.toFixed(2), meter: +q.meter.toFixed(2), seen: q.seen })),
      mini: this.mini ? { open: this.mini.open, kind: this.mini.kind, round: this.mini.round, misses: this.mini.misses, pos: +this.mini.pos.toFixed(2), c: +this.mini.c.toFixed(2), w: this.mini.w, in: this.mini.inZone() } : null,
      card: this.cardKind, report: this.lastReport, contact: this.contactAt, land: this.landAt, drop: this.drop, bests: this.bests(), spotted: +this.spotted.toFixed(2), balls: this.balls.length,
      spots: this.spots.map((s) => ({ floor: s.floor, x: s.x, z: s.z, text: s.text() })), prompt: this.prompt, ...this.stats,
    };
  }

  /** For the tests: stand somewhere in the tower, as a lift or the stairs would put her. */
  warp(floor: Where | 'lobby', lx: number, lz: number, h = 0): void {
    this.place(lx, floor === 'lobby' ? Y.lobby : FLOOR_Y[floor], lz, h);
  }

  /** For the tests: put a guard at floor-local x, z facing (fx, fz), holding still. */
  setGuard(i: number, lx: number, lz: number, fx: number, fz: number): void {
    const gd = this.guards[i]; if (!gd) return;
    gd.lx = lx; gd.lz = lz; const d = Math.hypot(fx, fz) || 1; gd.fx = fx / d; gd.fz = fz / d; gd.wait = 999; gd.meter = 0;
  }
}
