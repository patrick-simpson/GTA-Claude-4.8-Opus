// Fun queue 2, item 8: ride the Budget Line. The passenger train (world/train.ts) runs on three of the day's four runs,
// from the town clock, so every screen has it in the same place with no messages. This is the rider's side of it: the
// platforms' prompts (next train and its wait, "board" while one stands in), the seat in a coach, the riding HUD, getting
// off at a station, the stations on the big map, and the fast-travel "Take the train" between two platforms.
//
// Stations (world/railway.ts STATIONS): Budget Gap (south terminus), the Depot, the North Halt. Press F on a platform while
// the passenger train stands in ($3, free in kid mode): you sit in one of a coach's 44 seats, seen through its windows.
// F again at a station gets you off; between stations the doors stay shut.
//
// In a town the rider says so in the ordinary state frame, the way a bus rider does: mode Passenger, `vehicle` 0,
// `color` = (TRAIN_RIDE_BASE + coach) << 8 | seat (world/coach.ts). Buses use ids 1..12, a real driver's id is in `vehicle`
// (never 0), so 129 and 130 clash with nothing; no new event or field, protocol unchanged. Every screen seats the rider
// from its own copy of the train (net/ride.ts seatOthers -> seatOf here).
//
// Fast travel: from a platform, the Places panel's "Take the train" (ui/places.ts) fades out, moves her to the other
// platform and fades back in, while the line is open (the timetable in charge of the train: not driven, not derailed).

import type { Game } from '../core/game';
import type { Vehicle, VehicleControls } from '../core/api';
import { trains, standings, RUN } from '../world/train';
import { RAILWAY, STATIONS, type RailStation } from '../world/railway';
import { STREETS_NEW } from '../world/streets';
import { buildStationMeshes, stationPoint, PLATFORM_IN, PLATFORM_W, PLATFORM_HALF } from '../world/trainStations';
import { COACH_SEATS, COACH_CUSHION, TRAIN_RIDE_BASE } from '../world/coach';
import { groundAt } from '../world/plan';
import { SPECS, type VehicleSpec } from '../ent/vehicleSpecs';
import { PlayerMode } from '../net/protocol';
import { kid } from '../core/kid';
import { money } from '../core/util';

export const FARE = 3;
/** Reach of a platform's prompt: along the line from its middle, and out from the track's centre, meters. */
const ALONG = 28, OUT_MIN = 1.4, OUT_MAX = 10.5;
/** Seconds: the fade out, the least held under black, the fade in. */
const OUT = 0.4, HOLD = 1.1, IN = 0.5;

export interface Rider { coach: number; seat: number; id: number; from: number }

const mmss = (s: number): string => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const minutes = (sec: number): string => (sec < 45 ? 'under a minute' : `${Math.max(1, Math.round(sec / 60))} min`);

/** The rider's seat as a Vehicle the way ent/player.ts wants it (like world/train.ts's Perch): moved with the coach every frame. */
class Seat implements Partial<Vehicle> {
  x = 0; y = 0; z = 0; h = 0; pitch = 0; roll = 0; vx = 0; vy = 0; vz = 0; yawRate = 0;
  readonly hl = 0.6; readonly hw = 0.6; readonly id = 9700;
  /** The train's own spec, short, so the chase camera sits a few meters behind the seat, inside the coach, not behind the whole train. */
  readonly spec: VehicleSpec = { ...SPECS.train, length: 3 };
  ctl: VehicleControls = { accel: 0, steer: 0, handbrake: false, horn: false };
  driver: 'player' | 'ai' | null = null; color = 0; health = 100; onGround = true; airTime = 0; slip = 0; lights = false; sunk = false; held = true;
  /** Where getting off puts her (set by the service just before). */
  ex = 0; ez = 0;
  get speed(): number { return Math.hypot(this.vx, this.vz); }
  doorPos(_side: -1 | 1, out: { x: number; z: number }): void { out.x = this.ex; out.z = this.ez; }
}

export class RailService {
  readonly stations: readonly RailStation[] = STATIONS;
  readonly stats = { boards: 0, exits: 0, paid: 0, refusedFull: 0, refusedMoney: 0, travels: 0, travelPaid: 0 };
  rider: Rider | null = null;
  /** The platform she stands on (index into STATIONS) or -1: for the prompts and the fast-travel button. */
  zone = -1;
  /** Fast travel in hand: 1 fading out, 2 held under black, 3 fading in; 0 none. */
  phase = 0;
  private dest = -1;
  private t = 0;
  private readonly seat = new Seat();
  private readonly at = { x: 0, y: 0, z: 0 };
  private readonly q = { x: 0, z: 0 };
  private hud: HTMLDivElement | null = null;
  private card: HTMLDivElement | null = null;
  private hudText = '';
  private prompting = false;
  private promptKey = '';
  private claimed = false;
  private lastNag = -9;
  private etaFor = -1; private etaAt = -9; private etaStr = '';
  /** For the tests: why the last ride ended on its own. */
  lost = '';
  /** Test hook: moves the clock's reading for the timetable, game minutes (the tests set sky.hour instead; this is spare). */
  last: { from: string; to: string; fare: number } | null = null;

  constructor(private readonly game: Game) {
    if (!RAILWAY || !STREETS_NEW || !STATIONS.length) return;
    try { buildStationMeshes(game); } catch (e) { console.warn('stations did not build', e); }
    try {
      const d = document.createElement('div');
      d.id = 'rail-hud';
      d.style.cssText = 'position:fixed;left:50%;top:92px;transform:translateX(-50%);z-index:30;display:none;max-width:min(560px,92vw);padding:8px 14px 9px;background:rgba(242,232,207,0.94);color:#1f3a2a;border:2px solid #1f3a2a;border-radius:4px;font:600 13px/1.35 "IBM Plex Mono",monospace;box-shadow:0 3px 0 rgba(31,58,42,0.35);pointer-events:none;text-align:center';
      document.body.appendChild(d);
      this.hud = d;
      const c = document.createElement('div');
      c.id = 'rail-card';
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:#000;opacity:0;pointer-events:none;color:#e6dcc0;font:600 15px/1.5 "IBM Plex Mono",monospace;text-align:center';
      document.body.appendChild(c);
      this.card = c;
      game.on('pause', (e) => { d.style.visibility = e.on ? 'hidden' : 'visible'; });
    } catch { /* no document */ }
    // F belongs to the bus's rule too: a bus rider gets off only at a stop, a train rider only when the train stands.
    const prev = game.player.rideHold;
    game.player.rideHold = () => (this.rider ? (this.canAlight() ? (this.prepExit(), true) : false) : prev ? prev() : true);
  }

  get on(): boolean { return STATIONS.length > 0 && !!this.hud; }
  /** Where the rider sits, for the other screens: the heading of the coach, and the seat's place in `out`; null while this screen has no such coach. */
  seatOf(id: number, seat: number, out: { x: number; y: number; z: number }): { h: number } | null {
    const T = trains.cur, s = COACH_SEATS[seat], b = T?.coach(id - TRAIN_RIDE_BASE);
    if (!b || !s) return null;
    const sn = Math.sin(b.h), cs = Math.cos(b.h), cp = Math.cos(b.pitch), sp = Math.sin(b.pitch);
    out.x = b.x + s[0] * cs + s[1] * sn * cp; out.z = b.z - s[0] * sn + s[1] * cs * cp;
    out.y = b.y + COACH_CUSHION * cp + s[1] * sp;
    return { h: b.h };
  }
  private taken(id: number): Set<number> {
    const s = new Set<number>(), net = this.game.net;
    if (net) for (const o of net.remotes.values()) if (o.mode === PlayerMode.Passenger && o.rideOf === 0 && o.rideBus === id) s.add(o.rideSeat);
    return s;
  }

  // ── The timetable, as a rider reads it ──

  /** Is the timetable in charge of the train: no driver, nothing derailed. */
  get open(): boolean { return !!trains.cur && trains.cur.onTimetable; }

  /** The next passenger train to stand at station st going dir (0: either): real seconds until it is in (0 if standing now), seconds it stays, and which way it goes on. Null: none soon. */
  next(st: number, dir: 0 | 1 | -1 = 0): { eta: number; left: number; dir: 1 | -1; here: boolean } | null {
    const T = trains.cur;
    if (!T) return null;
    const c = T.timetableClock(), m = c.run * RUN + c.u;
    let best: { t0: number; t1: number; dir: 1 | -1 } | null = null;
    for (const w of standings(c.day, c.run - 1, 8)) {
      if (w.st !== st || w.term || w.t1 <= m || (dir && w.dir !== dir)) continue;
      if (!best || w.t0 < best.t0) best = w;
    }
    if (!best) return null;
    const rate = c.rate > 0 ? c.rate : 1e-6;
    return { eta: Math.max(0, best.t0 - m) / rate, left: (best.t1 - m) / rate, dir: best.dir, here: best.t0 <= m };
  }

  /** "Next train in 3 min" and the like, for the Places panel and the platform's prompt. */
  etaText(st: number): string {
    if (!this.open) return 'Service suspended while the train is off its timetable';
    const parts: { eta: number; text: string }[] = [];
    for (const d of (st === 0 ? [1] : st === STATIONS.length - 1 ? [-1] : [1, -1]) as (1 | -1)[]) {
      const n = this.next(st, d), way = d > 0 ? 'north' : 'south';
      if (n) parts.push({ eta: n.eta, text: n.here ? `${way}bound train in now` : `${way} in ${mmss(n.eta)}` });
    }
    if (!parts.length) return 'No train soon';
    return parts.sort((x, y) => x.eta - y.eta).map((x) => x.text).join(' · ');
  }
  /** "Next train in X min": the soonest either way. */
  nextTrainText(st: number): string {
    if (!this.open) return 'Service suspended';
    const n = this.next(st);
    if (!n) return 'No train soon';
    return n.here ? 'Train in now' : `Next train in ${minutes(n.eta)}`;
  }

  // ── Frame ──

  update(dt: number): void {
    if (!this.on) return;
    const T = trains.cur;
    if (T) T.aboard = this.rider !== null;
    this.rideFrame();
    this.platformFrame();
    this.travelFrame(dt);
  }

  /** Which platform she stands on, if any. */
  private where(x: number, z: number, y: number): number {
    const sts = STATIONS;
    for (let i = 0; i < sts.length; i++) {
      const st = sts[i], dx = x - st.x, dz = z - st.z, s = Math.sin(st.h), c = Math.cos(st.h);
      const u = dx * s + dz * c, w = (dx * c - dz * s) * st.side;
      if (Math.abs(u) < ALONG && w > OUT_MIN && w < OUT_MAX && Math.abs(y - groundAt(x, z)) < 3) return i;
    }
    return -1;
  }

  private platformFrame(): void {
    const g = this.game, p = g.player, h = g.hud, T = trains.cur;
    const can = g.state === 'play' && !this.rider && !p.vehicle && !p.riding && p.health > 0 && !p.goingTo && !p.swimming && this.phase === 0;
    this.zone = can ? this.where(p.person.x, p.person.z, p.person.y) : -1;
    const z = this.zone;
    if (z < 0) { if (this.prompting) { h.prompt(null); this.prompting = false; this.promptKey = ''; } this.unclaim(); return; }
    const st = STATIONS[z], leg = T?.leg();
    const standing = !!T && !!leg && !leg.moving && leg.st === z && !leg.term && leg.left / leg.rate > 1.5 && !!T.coach(1) && Math.hypot(T.coach(1)!.vx, T.coach(1)!.vz) < 0.5;
    let text: string;
    if (standing && leg) {
      const n = this.next(z, 0);
      const dir = n?.dir ?? (z === STATIONS.length - 1 ? -1 : 1);
      text = `[F] Board the Budget Line (${dir > 0 ? 'northbound' : 'southbound'}), ${kid.on ? 'free' : money(FARE)}. Leaves in ${Math.ceil(leg.left / leg.rate)} s`;
      const b = T!.coach(1);
      if (b) { p.rideNear = b as unknown as Vehicle; this.claimed = true; }
    } else {
      this.unclaim();
      // (The wait changes by the second; the timetable is not worth reading every frame.)
      if (this.etaFor !== z || g.time - this.etaAt > 0.5 || g.time < this.etaAt) { this.etaFor = z; this.etaAt = g.time; this.etaStr = this.etaText(z); }
      text = `${st.name}. ${this.etaStr}`;
    }
    if (text !== this.promptKey) { h.prompt(text); this.promptKey = text; }
    this.prompting = true;
    if (standing && g.input.hit('enter')) { g.input.eat('enter'); this.board(z); }
  }

  private unclaim(): void { if (this.claimed) { this.game.player.rideNear = null; this.claimed = false; } }

  // ── Boarding, riding and getting off ──

  private board(st: number): void {
    const g = this.game, p = g.player, T = trains.cur;
    if (!T) return;
    let best = -1, bd = 1e9, coach = 0;
    for (const ci of [1, 2]) {
      if (!T.coach(ci)) continue;
      const used = this.taken(TRAIN_RIDE_BASE + ci);
      for (let i = 0; i < COACH_SEATS.length; i++) {
        if (used.has(i) || !this.seatOf(TRAIN_RIDE_BASE + ci, i, this.at)) continue;
        const d = Math.hypot(this.at.x - p.person.x, this.at.z - p.person.z);
        if (d < bd) { bd = d; best = i; coach = ci; }
      }
    }
    if (best < 0) { this.stats.refusedFull++; g.hud.toast('The train is full. Standing room is not offered on the Budget Line.', 3); return; }
    const fare = kid.on ? 0 : FARE;
    if (fare > p.money) { this.stats.refusedMoney++; g.hud.toast(`Fare ${money(FARE)}. You have ${money(p.money)}. The conductor has seen this before.`, 4); return; }
    p.money -= fare; this.stats.paid += fare;
    this.rider = { coach, seat: best, id: TRAIN_RIDE_BASE + coach, from: st };
    this.seatNow();
    p.ride(this.seat as unknown as Vehicle);
    this.stats.boards++;
    g.hud.prompt(null); this.prompting = false; this.unclaim();
    g.hud.toast(fare === 0 ? 'Boarded the Budget Line. Kid mode rides free.' : `Boarded the Budget Line. Fare ${money(fare)}, no change given.`, 4);
  }

  /** The seat's place and the rider's, from the coach this frame. False if the coach is gone. */
  private seatNow(): boolean {
    const R = this.rider, T = trains.cur;
    if (!R || !T) return false;
    const b = T.coach(R.coach), r = this.seatOf(R.id, R.seat, this.at);
    if (!b || !r) return false;
    const S = this.seat;
    S.x = this.at.x; S.y = this.at.y; S.z = this.at.z; S.h = b.h; S.pitch = b.pitch; S.roll = 0; S.vx = b.vx; S.vz = b.vz;
    return true;
  }

  private canAlight(): boolean {
    const b = trains.cur?.coach(this.rider?.coach ?? 1);
    return !b || Math.hypot(b.vx, b.vz) < 1;
  }

  private rideFrame(): void {
    const R = this.rider, g = this.game, p = g.player;
    if (!R) { this.showHud(null); return; }
    const T = trains.cur;
    if (!p.riding || p.riding !== (this.seat as unknown as Vehicle) || !T || !this.seatNow()) {
      // Out by another way (a teleport, a reset, a hospital) or the coach went away: she is out already.
      this.lost = `${!p.riding ? 'not riding' : p.riding !== (this.seat as unknown as Vehicle) ? 'riding another' : !T ? 'no train' : 'no coach'}`;
      this.rider = null; this.stats.exits++;
      if (p.riding === (this.seat as unknown as Vehicle)) p.exit(true);
      this.showHud(null);
      return;
    }
    const per = p.person, S = this.seat;
    per.x = S.x; per.y = S.y; per.z = S.z; per.h = S.h; per.pose = 'sit'; per.bench = true; per.speed = 0; per.visible = true;
    const leg = T.leg();
    if (leg && leg.term) { g.hud.toast('All change. This train terminates here.', 4); this.leave(); return; }
    if (T.mode === 'derail') { g.hud.toast('The train has left the rails. You are thrown clear.', 4); this.rider = null; this.stats.exits++; p.exit(false); this.showHud(null); return; }
    const moving = !this.canAlight();
    if (g.input.hit('enter') && moving && g.time - this.lastNag > 1.2) {
      this.lastNag = g.time;
      g.hud.toast(leg ? `The doors open at stations only. Next: ${STATIONS[leg.st].name}, ${mmss(leg.left / leg.rate)}.` : 'The doors open at stations only.', 3);
    }
    let line: string;
    if (!moving) { const st = leg && !leg.moving ? STATIONS[leg.st] : null; line = st ? `At ${st.name}. Press F to get off.` : 'The train is standing. Press F to get off.'; }
    else if (leg && leg.moving) line = `Next station: ${STATIONS[leg.st].name} in ${mmss(leg.left / leg.rate)}. Press F at a station to get off.`;
    else line = 'Press F at a station to get off.';
    this.showHud(`<b style="color:#2a7a45">&#9632;</b> <b>THE BUDGET LINE</b><br><span>${line}</span>`, line);
  }

  private showHud(html: string | null, text = ''): void {
    const d = this.hud;
    this.hudText = html === null ? '' : `Budget Line | ${text}`;
    if (!d) return;
    if (html === null) { if (d.style.display !== 'none') d.style.display = 'none'; return; }
    if (d.dataset.t !== html) { d.innerHTML = html; d.dataset.t = html; }
    d.style.display = this.game.state === 'play' && !this.game.photo?.open ? 'block' : 'none';
  }
  /** The riding HUD's text, for the tests and the pictures. */
  hudLine(): string { return this.hudText; }

  /** Where getting off puts her (ent/player.ts asks the seat's door): the platform beside the coach, or a stride out from it. */
  private prepExit(): void {
    const R = this.rider, T = trains.cur;
    if (!R) return;
    const S = this.seat, b = T?.coach(R.coach);
    if (b) {
      // The platform nearest the coach: her place along it, out to its middle. Otherwise the coach's left, a stride out.
      let near = -1, bd = 40;
      for (let i = 0; i < STATIONS.length; i++) { const d = Math.hypot(STATIONS[i].x - b.x, STATIONS[i].z - b.z); if (d < bd) { bd = d; near = i; } }
      if (near >= 0) {
        const st = STATIONS[near], u = Math.max(-PLATFORM_HALF + 1, Math.min(PLATFORM_HALF - 1, (b.x - st.x) * Math.sin(st.h) + (b.z - st.z) * Math.cos(st.h)));
        stationPoint(st, u, PLATFORM_IN + PLATFORM_W / 2, this.q);
      } else { this.q.x = b.x + Math.cos(b.h) * 4.2; this.q.z = b.z - Math.sin(b.h) * 4.2; }
      S.ex = this.q.x; S.ez = this.q.z; S.x = this.q.x; S.z = this.q.z; S.y = groundAt(this.q.x, this.q.z) + 0.45; S.vx = S.vz = 0;
    }
  }

  /** Step off now (the doors are open: the train stands, or ends its run). */
  private leave(): void {
    const p = this.game.player;
    if (!this.rider) return;
    this.prepExit();
    this.rider = null;
    if (p.riding) p.exit(true);
    this.stats.exits++;
    this.showHud(null);
  }

  // ── Fast travel ──

  /** Whether she can take the train from the platform she is on to station `to` now, and what the button says. */
  status(to: number): { ok: boolean; fare: number; why: string; text: string } {
    const g = this.game, p = g.player, fare = kid.on ? 0 : FARE;
    const no = (why: string): { ok: boolean; fare: number; why: string; text: string } => ({ ok: false, fare, why, text: why });
    if (!this.on) return no('There is no railway here.');
    if (this.phase) return no('A trip is already in progress.');
    if (g.state !== 'play' && g.state !== 'paused') return no('Not now.');
    if (!(p.health > 0)) return no('The Budget Line does not carry the deceased.');
    if (p.heat > 0) return no('The Budget Line does not carry fugitives.');
    if (g.todo.busy !== null) return no('Not during a mission, job or race.');
    if (this.zone < 0) return no('Walk to a station platform to take the train.');
    if (to === this.zone) return no('You are already at that station.');
    if (!this.open) return no('The line is closed: the train is off its timetable.');
    const d = STATIONS[to];
    if (!g.todo.travel.open({ name: d.name, x: d.x, z: d.z, nx: 0, nz: 0 })) return no('No road to that station yet: the line is not open there.');
    if (fare > p.money) return no(`Fare ${money(fare)}: you have ${money(p.money)}.`);
    return { ok: true, fare, why: '', text: fare === 0 ? `Take the train to ${d.name}, free` : `Take the train to ${d.name}, ${money(fare)}` };
  }

  /** Book it: the fare, a fade, the other platform. Returns the refusal, or ''. */
  travel(to: number): string {
    const s = this.status(to), g = this.game;
    if (!s.ok) { g.hud.toast(s.why, 4); return s.why; }
    this.dest = to; this.phase = 1; this.t = 0;
    this.last = { from: STATIONS[this.zone].name, to: STATIONS[to].name, fare: s.fare };
    g.input.setEnabled(false);
    if (g.state === 'paused') { g.setPaused(false); if (!g.input.touch) g.input.lock(); g.input.setEnabled(false); }
    const c = this.card;
    if (c) {
      c.innerHTML = `<div><div style="letter-spacing:.2em;font-size:12px;opacity:.7">THE TEPID FALLS &amp; BUDGET GAP</div><div style="font:800 38px 'Big Shoulders Display',sans-serif;margin:6px 0">${STATIONS[to].sign}</div><div>${this.last.from} &rarr; ${this.last.to}</div><div style="opacity:.7;margin-top:6px">${s.fare === 0 ? 'Fare waived (kid-friendly mode)' : 'Fare ' + money(s.fare)}. The conductor has stamped it.</div></div>`;
      c.style.display = 'flex';
    }
    return '';
  }

  private fade(v: number): void { if (this.card) this.card.style.opacity = v.toFixed(3); }

  private travelFrame(dt: number): void {
    if (!this.phase) return;
    const g = this.game, p = g.player;
    this.t += dt;
    if (this.phase === 1) {
      this.fade(Math.min(1, this.t / OUT));
      if (this.t >= OUT) {
        this.phase = 2; this.t = 0;
        const st = STATIONS[this.dest], fare = kid.on ? 0 : FARE;
        p.money -= fare; this.stats.travelPaid += fare; this.stats.travels++;
        stationPoint(st, -4, PLATFORM_IN + PLATFORM_W / 2, this.q);
        const h = Math.atan2(-Math.cos(st.h) * st.side, Math.sin(st.h) * st.side);
        p.teleport(this.q.x, this.q.z, h);
        g.cam.yaw = h; g.cam.snap();
        g.warmup.flush();
      }
    } else if (this.phase === 2) {
      this.fade(1);
      if (this.t >= HOLD) { this.phase = 3; this.t = 0; g.hud.toast(`${this.last?.to ?? 'The next station'}. Everybody out.`, 4); }
    } else {
      this.fade(Math.max(0, 1 - this.t / IN));
      if (this.t >= IN) { this.phase = 0; if (this.card) this.card.style.display = 'none'; g.input.setEnabled(true); }
    }
  }

  // ── The big map ──

  /** The line, its stations and the train on the chart (ui/menu.ts drawMap). */
  drawChart(c: CanvasRenderingContext2D, X: (x: number) => number, Z: (z: number) => number, k: number, w: number, h: number, ink: string, bone: string): void {
    if (!RAILWAY || !STATIONS.length) return;
    const m = RAILWAY.main, n = m.length / 2, step = k < 0.12 ? 24 : k < 0.3 ? 12 : 6;
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'butt';
    const trace = (): void => { c.beginPath(); for (let i = 0; i < n; i += step) { const x = X(m[2 * i]), y = Z(m[2 * i + 1]); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); } c.lineTo(X(m[2 * n - 2]), Z(m[2 * n - 1])); };
    trace(); c.strokeStyle = ink; c.lineWidth = 3.4; c.globalAlpha = 0.9; c.setLineDash([]); c.stroke();
    trace(); c.strokeStyle = bone; c.lineWidth = 1.6; c.globalAlpha = 1; c.setLineDash([5, 5]); c.stroke();
    c.setLineDash([]);
    const R = Math.max(4, Math.min(7, 3 + k * 4));
    for (const st of STATIONS) {
      const x = X(st.x), y = Z(st.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      c.beginPath(); c.roundRect(x - R, y - R, R * 2, R * 2, 2); c.fillStyle = bone; c.fill(); c.strokeStyle = ink; c.lineWidth = 2; c.stroke();
      c.fillStyle = '#2a7a45'; c.fillRect(x - R * 0.45, y - R * 0.45, R * 0.9, R * 0.9);
      if (k >= 0.35) {
        c.font = '700 11px "Barlow Semi Condensed", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 3; c.strokeStyle = 'rgba(242,232,207,0.9)'; c.strokeText(st.name, x, y + R + 9); c.fillStyle = ink; c.fillText(st.name, x, y + R + 9);
      }
    }
    const t = trains.cur?.marker();
    if (t) {
      const x = X(t.x), y = Z(t.z);
      if (x > -20 && y > -20 && x < w + 20 && y < h + 20) {
        c.fillStyle = t.passenger ? '#2a7a45' : '#8a2a1a'; c.strokeStyle = ink; c.lineWidth = 2;
        c.beginPath(); c.roundRect(x - 7, y - 5, 14, 10, 3); c.fill(); c.stroke();
        c.fillStyle = '#fff'; c.font = '800 9px "Big Shoulders Display", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(t.passenger ? 'BL' : 'F', x, y + 0.5);
      }
    }
    c.restore();
  }

  /** For the tests (window.__game.game.rail.info()). */
  info(): Record<string, unknown> {
    const T = trains.cur;
    return {
      lost: this.lost, on: this.on, open: this.open, zone: this.zone, phase: this.phase, rider: this.rider, hud: this.hudText, stats: { ...this.stats },
      kind: T?.kind ?? null, leg: T?.leg() ?? null, eta: STATIONS.map((_, i) => this.etaText(i)),
      stations: STATIONS.map((s) => ({ name: s.name, s: Math.round(s.s), x: Math.round(s.x), z: Math.round(s.z) })),
    };
  }
}

