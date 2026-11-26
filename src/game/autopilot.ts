// "Drive me there": the car drives itself along the navigation route (fun queue 2, item 12).
//
// Mostly for phones, where steering a long way with a thumb is a chore. It rides the same Navigator route the turn card shows
// (game/nav.ts `legs`), lays its own lane-centred path over those streets the way the town's drivers do (sim/streetTraffic.ts:
// railOff lanes, a cubic through each junction, a roundabout's circulating lane), and drives that path with a pure-pursuit
// steer and a speed plan: the cruise speed of each road class, the bends (v = sqrt(a * w / bend)), the stop line of a red or
// yellow light, a stop sign, a yielding junction, the car in front (a follow gap), and a full stop at the kerb by the door.
//
// Any steering, pedal or handbrake input from the player hands the car back at once. It is never offered on foot, on a bike,
// scooter, boat or train, with the Harbor Patrol after her, in a race, derby, pursuit or a mission, and a mission keeps its own
// driving. Taxi duty and delivery are allowed. Stuck for 5 s: it re-routes once, then hands back with a message.
//
// Player.driving() calls drive() for the pedals while `active`; ThingsToDo.update() calls update() once a frame.

import './autopilot.css';
import type { Game } from '../core/game';
import type { Vehicle, VehicleControls } from '../core/api';
import { clamp, TAU } from '../core/util';
import type { RoadEdge, RoadNode } from '../world/plan';
import { railOff } from '../sim/streetTraffic';
import type { Traffic } from '../sim/traffic';
import { roads } from '../world/roadCond';

type Kind = 'signal' | 'stop' | 'yield' | 'round' | 'merge' | 'left';

interface Junc {
  n: RoadNode; e: RoadEdge; next: RoadEdge;
  /** Path index of the lane's end, and metres along the path there. */
  idx: number; sEnd: number;
  kind: Kind; ang: number;
  /** Unit heading into the node. */
  ix: number; iz: number;
  /** Where the car joins the next street, for the merge test. */
  ox: number; oz: number;
  /** 0 approaching, 1 stopped at the line, 2 cleared to go. */
  stage: number; stopT: number; yellow: number;
}

interface Pt { x: number; z: number; tx: number; tz: number }

const padR = (n: RoadNode): number => (n.edges.length === 2 && n.control === 'none' ? n.hx : n.hx + (n.control === 'roundabout' ? 0 : 0.6));
const islandR = (n: RoadNode): number => Math.max(6, n.hx - 9);
const entryOf = (n: RoadNode): number => (n.edges.length === 2 && n.control === 'none' ? 0 : n.edges.length <= 1 ? 3 : padR(n) + 1.2);
/** Metres of path in each direction the speed plan is sampled at. */
const STEP = 3;
/** Gentle: this much deceleration in the plan, this much throttle at most. */
const DECEL = 2.3, THROTTLE = 0.62;
/** Seconds without moving (and not waiting for a reason) before it re-routes, and before it gives up. */
const STUCK_REROUTE = 5, STUCK_GIVEUP = 12, BLOCK_REROUTE = 10, BLOCK_GIVEUP = 30;
const NO_WHEEL = new Set(['speedboat', 'jetski', 'train', 'bike', 'scooter']);
/** Jobs the autopilot may drive in: a taxi fare, a courier run, Delivery Rush. Every other job, race and mission keeps the wheel. */
const OK_BUSY = new Set(['taxi', 'courier', 'rush']);

export class Autopilot {
  active = false;
  /** Whether the offer is on screen: driving a car, a route set, nothing forbidding it. */
  offer = false;
  /** Why it is not on offer right now (for the test and the button's reply), or ''. */
  why = '';
  /** Telemetry for the tests and the badge. */
  readonly info = { s: 0, total: 0, want: 0, hold: '', lat: 0, trips: 0, reroutes: 0, redRuns: 0, stopRuns: 0, giveups: 0, note: '' };

  private path: number[] = [];
  private cum: number[] = [];
  private vcap: number[] = [];
  private junc: Junc[] = [];
  private total = 0;
  private k = 0; private s = 0;
  private gen = -1;
  private heat = 0;
  private stuck = 0; private blockT = 0; private offT = 0; private noMove = 0; private rerouteN = 0; private lastReroute = -99;
  private veh: Vehicle | null = null;
  private chip: HTMLElement;
  private chipTxt: HTMLElement;
  private shown = '';
  private near: Vehicle[] = [];
  private nearT = 0;
  private endX = 0; private endZ = 0;
  private lastS = 0; private lastSAt = 0;
  private holdWhy = '';
  private backT = 0; private backCool = 0;
  private rerouteS = 0;
  private blk = '';
  private byp = 0; private bypTarget = 0; private bypObs: Vehicle | null = null; private stillT = 0;
  private t = 0;
  private prevStop = new Map<Junc, number>();

  constructor(private readonly game: Game) {
    game.on('heat', (e) => { this.heat = e.level; });
    const el = this.chip = document.createElement('div');
    el.className = 'ap-chip';
    el.innerHTML = '<span class="ap-badge">AUTOPILOT</span><span class="ap-txt"></span><button type="button" class="ap-x" aria-label="Cancel autopilot">Cancel</button>';
    this.chipTxt = el.querySelector('.ap-txt') as HTMLElement;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    el.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    document.body.appendChild(el);
    addEventListener('keydown', (e) => {
      if (!game.input.is(e.code, 'autopilot') || e.repeat || game.state !== 'play') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.toggle();
    });
  }

  // ── Asking ───────────────────────────────────────────────────────────────

  /** null when it may drive, else the reason it may not. */
  refusal(): string | null {
    const g = this.game, p = g.player, v = p.vehicle, todo = g.todo;
    if (!v || v.driver !== 'player') return 'Autopilot drives a car. Get in one first.';
    if (NO_WHEEL.has(v.spec.kind) || v.sunk) return 'Autopilot only drives cars on the road.';
    if (this.heat > 0) return 'Autopilot is off while the Harbor Patrol is after you.';
    const busy = todo.busy;
    if (busy !== null && !OK_BUSY.has(busy)) return 'This one needs your own driving.';
    if (todo.travel.active) return 'The cab is driving.';
    const nav = todo.navigator;
    if (!nav.ok || nav.legs.length === 0) return 'Pick a place on the map first, then Drive me there.';
    if (p.speed > 45) return 'Slow down first.';
    return null;
  }

  toggle(): void {
    if (this.active) { this.cancel('Autopilot off. Your wheel.'); return; }
    const r = this.refusal();
    if (r) { this.game.hud.toast(r, 4); return; }
    this.start();
  }

  start(): boolean {
    const g = this.game, v = g.player.vehicle, nav = g.todo.navigator;
    if (!v) return false;
    nav.heading = { x: Math.sin(v.h), z: Math.cos(v.h) };
    nav.reroute();
    g.todo.navigator.update(0, g.plan, v.x, v.z, g.todo.target(), null, g.hud.nav);
    if (!this.build(v)) { nav.heading = null; g.hud.toast('Autopilot could not find a way from here.', 4); return false; }
    this.active = true; this.veh = v;
    this.stuck = this.blockT = this.offT = this.noMove = 0; this.rerouteN = 0; this.lastReroute = -99;
    this.lastS = this.s; this.lastSAt = this.t;
    this.info.trips++;
    const taxi = g.todo.busy === 'taxi';
    g.hud.toast(taxi ? 'Autopilot on. Autopilot fares tip less. Touch the wheel to take over.' : 'Autopilot on. Touch the wheel or a pedal to take over.', 4);
    this.sync();
    return true;
  }

  cancel(msg?: string): void {
    if (!this.active) return;
    this.active = false;
    const nav = this.game.todo.navigator;
    nav.heading = null;
    const v = this.veh; this.veh = null;
    if (v) { v.ctl.accel = 0; v.ctl.steer = 0; v.ctl.handbrake = false; v.ctl.horn = false; }
    if (msg) this.game.hud.toast(msg, 4);
    this.sync();
  }

  // ── Per frame ────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.t += dt;
    const g = this.game, p = g.player;
    if (this.active) {
      const r = this.veh !== p.vehicle || !this.veh || this.veh.driver !== 'player' ? 'gone' : this.refusal();
      // The route going away is not a reason in itself (arriving clears it): `lost` below decides that.
      if (r === 'gone') this.cancel();
      else if (r && !r.startsWith('Pick a place')) { this.cancel(r); this.info.giveups++; }
    }
    let off = false;
    if (!this.active) { const r = this.refusal(); this.why = r ?? ''; off = r === null; }
    this.offer = off;
    this.sync();
  }

  private sync(): void {
    const sig = this.active ? 'on' : this.offer && !this.game.input.touch ? 'offer' : '';
    this.chip.dataset.s = sig;
    if (sig === this.shown) return;
    this.shown = sig;
    this.chip.classList.toggle('on', sig === 'on');
    this.chip.classList.toggle('offer', sig === 'offer');
    this.chipTxt.textContent = sig === 'on' ? 'Driving you there' : 'I  Drive me there';
    (this.chip.querySelector('.ap-x') as HTMLElement).style.display = sig === 'on' ? '' : 'none';
  }

  /**
   * Writes the pedals for this frame. False: it is not driving (or the player has just taken over), so the caller reads her input.
   */
  drive(c: VehicleControls, dt: number): boolean {
    const g = this.game, inp = g.input, v = this.veh;
    if (!this.active || !v) return false;
    if (v !== g.player.vehicle) { this.cancel(); return false; }
    if (inp.moveX !== 0 || inp.moveY !== 0 || inp.padTrig !== 0 || inp.down('handbrake') || inp.down('jump')) {
      this.cancel('You have the wheel.');
      return false;
    }
    const nav = g.todo.navigator;
    if (nav.gen !== this.gen && nav.legs.length) { if (!this.build(v)) { this.cancel('Autopilot lost the way. Over to you.'); this.info.giveups++; return false; } }
    // The goal was taken away (cleared on the map) while still far from the end: stop.
    if (!nav.ok && Math.hypot(v.x - this.endX, v.z - this.endZ) > 70) { this.cancel('Route cleared. Over to you.'); return false; }
    this.step(c, v, dt);
    return this.active;
  }

  // ── The path ─────────────────────────────────────────────────────────────

  private lanePt(e: RoadEdge, dir: number, t: number, off: number, o: Pt): Pt {
    const G = this.game.plan.streets!;
    const p = G.pointAt(e, dir > 0 ? t : e.len - t), tx = p.dx * dir, tz = p.dz * dir;
    o.x = p.x - tz * off; o.z = p.z + tx * off; o.tx = tx; o.tz = tz;
    return o;
  }

  private cubic(out: number[], a: Pt, b: Pt, hl: number): void {
    const x1 = a.x + a.tx * hl, z1 = a.z + a.tz * hl, x2 = b.x - b.tx * hl, z2 = b.z - b.tz * hl;
    const n = 10;
    for (let i = 1; i <= n; i++) {
      const u = i / n, w = 1 - u, k0 = w * w * w, k1 = 3 * w * w * u, k2 = 3 * w * u * u, k3 = u * u * u;
      out.push(k0 * a.x + k1 * x1 + k2 * x2 + k3 * b.x, k0 * a.z + k1 * z1 + k2 * z2 + k3 * b.z);
    }
  }

  /** Lane (0 inner .. n-1 kerb) a street is driven in: the kerb lane, but the inner one when the street ends in a left turn. */
  private laneFor(e: RoadEdge, left: boolean): number {
    const n = Math.max(1, e.lanes);
    if (n < 2) return 0;
    return left && !e.divided ? 0 : n - 1;
  }

  private build(v: Vehicle): boolean {
    const g = this.game, nav = g.todo.navigator, G = g.plan.streets;
    const legs = nav.legs;
    if (!G || legs.length === 0) return false;
    const P: number[] = [], cr: number[] = [], jn: Junc[] = [], tmp: Pt = { x: 0, z: 0, tx: 0, tz: 0 };
    const put = (x: number, z: number, c: number): void => {
      const m = P.length;
      if (m >= 2 && Math.hypot(P[m - 2] - x, P[m - 1] - z) < 0.05) return;
      P.push(x, z); cr.push(c);
    };
    const dest = g.todo.target();
    const last = legs.length - 1;
    let prev: Pt | null = null;
    let prevLeg = -1;
    let startOff = 0;
    const cruiseOf = (e: RoadEdge): number => {
      const top = v.spec.topSpeed;
      const k = e.kind;
      const c = k === 'highway' ? 23 : k === 'ramp' ? 13 : k === 'arterial' || k === 'bridge' ? 12.5 : k ? 10 : e.hw >= 7 ? 12 : 10;
      return Math.min(c, top * 0.55 * (k === 'highway' ? 1.25 : 1));
    };
    for (let i = 0; i <= last; i++) {
      const L = legs[i], e = L.e;
      const dir = L.s1 >= L.s0 ? 1 : -1;
      const t0 = dir > 0 ? L.s0 : e.len - L.s0, t1 = dir > 0 ? L.s1 : e.len - L.s1;
      const nS = G.nodes[dir > 0 ? e.a : e.b], nE = G.nodes[dir > 0 ? e.b : e.a];
      // Does the street after this one turn left? Its heading is read off the next leg's first stretch.
      let leftNext = false;
      if (i < last) {
        const N = legs[i + 1], nd = N.s1 >= N.s0 ? 1 : -1, ts = nd > 0 ? N.s0 : N.e.len - N.s0;
        const a = this.lanePt(e, dir, Math.max(0, e.len - 1), 0, { x: 0, z: 0, tx: 0, tz: 0 });
        const b = this.lanePt(N.e, nd, Math.min(N.e.len, ts + 1), 0, { x: 0, z: 0, tx: 0, tz: 0 });
        leftNext = -(b.tx * a.tz) + b.tz * a.tx < -0.5;
      }
      const lane = this.laneFor(e, leftNext);
      let off = railOff(e, lane);
      // The kerb by the door: the side of the street the door is on, over the last stretch.
      let kerb = off;
      if (i === last && dest) {
        const q = this.lanePt(e, dir, t1, 0, tmp);
        const lat = (dest.x - q.x) * -q.tz + (dest.z - q.z) * q.tx;
        const edge = Math.max(off, e.hw - 1.9);
        kerb = lat >= 0 || e.divided ? edge : e.oneWay ? -(e.hw - 1.9) : -(e.hw - 1.9);
        if (e.divided) kerb = Math.max(off, railOff(e, Math.max(1, e.lanes) - 1));
      }
      if (i === 0) {
        const q = this.lanePt(e, dir, t0, 0, tmp);
        startOff = clamp((v.x - q.x) * -q.tz + (v.z - q.z) * q.tx, -(e.hw - 1.2), e.hw - 1.2);
      }
      const entS = i === 0 ? t0 : Math.min(t1, Math.max(t0, Math.min(entryOf(nS), e.len * 0.5)));
      const entE = i === last ? t1 : Math.max(entS, Math.min(t1, e.len - entryOf(nE)));
      const span = entE - entS;
      const n = Math.max(1, Math.ceil(span / STEP));
      const sm = (u: number): number => u * u * (3 - 2 * u);
      const cs = cruiseOf(e);
      for (let k = 0; k <= n; k++) {
        const t = entS + (span * k) / n;
        let o = off;
        if (i === 0) o = off + (startOff - off) * (1 - sm(clamp((t - t0) / 16, 0, 1)));
        if (i === last) o = o + (kerb - o) * sm(clamp((t - (t1 - 38)) / 30, 0, 1));
        const q = this.lanePt(e, dir, t, o, { x: 0, z: 0, tx: 0, tz: 0 });
        if (k === 0 && prev) {
          // The junction between the last street and this one.
          const pe = legs[prevLeg].e;
          this.junction(P, cr, jn, pe, e, prev, q, cruiseOf(pe), cs);
        } else put(q.x, q.z, cs);
        prev = q; prevLeg = i;
      }
    }
    if (P.length < 6) return false;
    // Arc lengths, junction positions, and the speed plan.
    const np = P.length / 2;
    const cum = [0];
    for (let i = 1; i < np; i++) cum.push(cum[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]));
    const vcap: number[] = new Array(np);
    const hd = (i: number): number => Math.atan2(P[2 * Math.min(np - 1, i + 1)] - P[2 * Math.max(0, i - 1)], P[2 * Math.min(np - 1, i + 1) + 1] - P[2 * Math.max(0, i - 1) + 1]);
    const slick = roads.ai;
    for (let i = 0; i < np; i++) {
      // The bend within about 5 m either side.
      let a = i, b = i;
      while (a > 0 && cum[i] - cum[a] < 5) a--;
      while (b < np - 1 && cum[b] - cum[i] < 5) b++;
      let bend = hd(b) - hd(a);
      bend -= Math.round(bend / TAU) * TAU;
      bend = Math.abs(bend);
      const w = Math.max(1, cum[b] - cum[a]);
      let cap = cr[i] * (1 - 0.3 * slick);
      if (bend > 0.04) cap = Math.min(cap, Math.max(4, Math.sqrt((2.4 - 1.2 * slick) * w / bend)));
      vcap[i] = cap;
    }
    vcap[np - 1] = 1.4;
    for (const j of jn) {
      j.sEnd = cum[j.idx];
      // Through the pad: slow for a turn. Walk the connector (the next ~14 m) and cap it.
      const vt = j.kind === 'round' ? 6.5 : j.ang > 0.5 ? 5 : j.ang < -0.5 ? 6 : 99;
      if (vt < 99) for (let i = j.idx; i < np && cum[i] - j.sEnd < 14; i++) vcap[i] = Math.min(vcap[i], vt);
    }
    for (let i = np - 2; i >= 0; i--) vcap[i] = Math.min(vcap[i], Math.sqrt(vcap[i + 1] * vcap[i + 1] + 2 * DECEL * (cum[i + 1] - cum[i])));
    this.path = P; this.cum = cum; this.vcap = vcap; this.junc = jn; this.total = cum[np - 1];
    this.gen = nav.gen; this.k = 0; this.s = 0;
    this.endX = P[2 * np - 2]; this.endZ = P[2 * np - 1];
    this.prevStop.clear(); this.byp = 0; this.bypTarget = 0; this.bypObs = null; this.stillT = 0;
    this.info.total = this.total;
    return true;
  }

  /** Lay the way through the junction from the end of one street's lane (a) to the start of the next's (b). */
  private junction(P: number[], cr: number[], jn: Junc[], e: RoadEdge, c: RoadEdge, a: Pt, b: Pt, ce: number, cc: number): void {
    const G = this.game.plan.streets!;
    // The node the two streets share.
    const nid = e.a === c.a || e.a === c.b ? e.a : e.b;
    const n = G.nodes[nid];
    const idx = P.length / 2 - 1;
    const cs = Math.min(ce, cc);
    const out: number[] = [];
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const rightness = -b.tx * a.tz + b.tz * a.tx, fwd = a.tx * b.tx + a.tz * b.tz;
    const ang = Math.atan2(rightness, fwd);
    let kind: Kind | null = null;
    const land = n.land === 1 && n.control !== undefined;
    if (n.control === 'roundabout') {
      const rc = (islandR(n) + n.hx) / 2;
      const ta = Math.atan2(a.z - n.z, a.x - n.x) - 0.5, tb = Math.atan2(b.z - n.z, b.x - n.x) + 0.5;
      let span = ta - tb;
      span = ((span % TAU) + TAU) % TAU;
      if (span < 0.25) this.cubic(out, a, b, dist * 0.39);
      else {
        const A: Pt = { x: n.x + Math.cos(ta) * rc, z: n.z + Math.sin(ta) * rc, tx: Math.sin(ta), tz: -Math.cos(ta) };
        const B: Pt = { x: n.x + Math.cos(ta - span) * rc, z: n.z + Math.sin(ta - span) * rc, tx: Math.sin(ta - span), tz: -Math.cos(ta - span) };
        this.cubic(out, a, A, Math.hypot(A.x - a.x, A.z - a.z) * 0.39);
        const steps = Math.max(2, Math.ceil(span / 0.18));
        for (let i = 1; i < steps; i++) { const t = ta - (span * i) / steps; out.push(n.x + Math.cos(t) * rc, n.z + Math.sin(t) * rc); }
        out.push(B.x, B.z);
        const tail: number[] = [];
        this.cubic(tail, B, b, Math.hypot(b.x - B.x, b.z - B.z) * 0.39);
        for (const q of tail) out.push(q);
      }
      kind = 'round';
    } else if (Math.abs(ang) > 2.5) this.cubic(out, a, b, 9);
    else this.cubic(out, a, b, dist * 0.39);
    // How the junction is run.
    if (n.edges.length > 2 || n.control === 'signal' || n.hasLight || n.control === 'stop' || n.control === 'roundabout') {
      if (!kind) {
        if (land ? n.control === 'signal' : n.hasLight) kind = 'signal';
        else if (e.kind === 'ramp' && c.kind === 'highway') kind = 'merge';
        else if (land && n.control === 'stop') kind = 'stop';
        else if (ang < -0.5) kind = 'left';
        else kind = n.edges.length > 2 ? 'yield' : null;
      }
    }
    if (kind) {
      jn.push({ n, e, next: c, idx, sEnd: 0, kind, ang, ix: a.tx, iz: a.tz, ox: b.tx, oz: b.tz, stage: 0, stopT: 0, yellow: 0 });
    }
    for (let i = 0; i < out.length; i += 2) {
      const m = P.length;
      if (Math.hypot(P[m - 2] - out[i], P[m - 1] - out[i + 1]) < 0.05) continue;
      P.push(out[i], out[i + 1]); cr.push(cs);
    }
  }

  // ── The drive ────────────────────────────────────────────────────────────

  private nearby(v: Vehicle): Vehicle[] {
    if (this.nearT > this.t - 0.12) return this.near;
    this.nearT = this.t;
    const g = this.game, out = this.near;
    out.length = 0;
    const take = (list: readonly Vehicle[]): void => {
      for (const o of list) {
        if (o === v) continue;
        const dx = o.x - v.x, dz = o.z - v.z;
        if (dx > 110 || dx < -110 || dz > 110 || dz < -110) continue;
        out.push(o);
      }
    };
    take(g.vehicles.list);
    take(g.vehicles.ghostList);
    return out;
  }

  private traffic(): Traffic | null {
    for (const s of this.game.systems) { const t = (s as { traffic?: Traffic }).traffic; if (t && typeof t.roadPeds === 'function') return t; }
    return null;
  }
  private trafficRef: Traffic | null | undefined;

  private signalOf(j: Junc): 'green' | 'yellow' | 'red' {
    const g = this.game;
    if (this.trafficRef === undefined) this.trafficRef = this.traffic();
    const rails = this.trafficRef?.rails;
    if (j.e.land === 1 && rails) return rails.lightFor(j.e, j.n.id);
    return g.world.signal(j.n.id, j.e.horiz);
  }

  private step(c: VehicleControls, v: Vehicle, dt: number): void {
    const g = this.game, P = this.path, cum = this.cum, np = P.length / 2;
    const sp = v.speed, spa = Math.abs(sp);
    // Where on the path.
    let bd = Infinity, bi = this.k;
    const lo = Math.max(0, this.k - 4), hi = Math.min(np - 2, this.k + 40);
    const seek = (a: number, b: number): void => {
      for (let i = a; i <= b; i++) {
        const ax = P[2 * i], az = P[2 * i + 1], bx = P[2 * i + 2], bz = P[2 * i + 3];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = clamp(((v.x - ax) * dx + (v.z - az) * dz) / l2, 0, 1);
        const d = Math.hypot(v.x - ax - dx * t, v.z - az - dz * t);
        if (d < bd - 0.01) { bd = d; bi = i; this.s = cum[i] + t * Math.sqrt(l2); }
      }
    };
    seek(lo, hi);
    if (bd > 25) seek(0, np - 2);
    this.k = bi;
    const s = this.s, rem = this.total - s;
    this.info.s = s; this.info.lat = bd;
    // Pushed or slid out of the lane: slow while steering back; far off for long: ask for a new route.
    if (bd > 12) this.offT += dt; else this.offT = Math.max(0, this.offT - dt);
    if (this.offT > 3) { this.reroute('Autopilot lost the lane.'); this.offT = 0; return; }

    // The aim point: a lookahead down the path.
    const look = clamp(2.6 + 0.6 * spa, 3.6, 20);
    let aj = bi;
    while (aj < np - 1 && cum[aj] - s < look) aj++;
    let cx = P[2 * aj], cz = P[2 * aj + 1];
    // Going round a car standing in the lane (a parked one): the aim point sits to one side of the path.
    if (Math.abs(this.byp) > 0.05) {
      const dx0 = cx - v.x, dz0 = cz - v.z, l0 = Math.hypot(dx0, dz0) || 1;
      cx += (-dz0 / l0) * this.byp; cz += (dx0 / l0) * this.byp;
    }
    let err = Math.atan2(cx - v.x, cz - v.z) - v.h;
    err -= Math.round(err / TAU) * TAU;
    let want = this.vcap[Math.min(np - 1, bi + 1)];
    want *= 1 - 0.5 * Math.min(1, Math.abs(err) * 1.0);
    if (bd > 2.2) want = Math.min(want, Math.max(3, 9 - bd));
    const sh = Math.sin(v.h), ch = Math.cos(v.h);
    // Where the nose is going: the aim line, in a turn.
    const ax = cx - v.x, az = cz - v.z, al = Math.hypot(ax, az) || 1;
    const fx = ax / al, fz = az / al;
    const near = this.nearby(v);

    // The junctions ahead.
    let hold = false; this.holdWhy = '';
    for (const j of this.junc) {
      const dEnd = j.sEnd - s;
      if (dEnd < -14 || dEnd > 75) continue;
      const stopD = j.sEnd + (j.kind === 'signal' ? -2.2 : 0.2) - v.hl - s;
      const R = padR(j.n);
      let h = false;
      if (j.kind === 'signal') {
        const sg = this.signalOf(j);
        if (sg === 'green') j.yellow = 0;
        else if (sg === 'yellow' && j.yellow === 0) j.yellow = stopD > spa * spa / 9 + 0.5 ? 1 : 2;
        if (sg === 'red' || (sg === 'yellow' && j.yellow === 1)) h = stopD > -0.6 || j.stage === 1;
        else if (j.ang < -0.5 && stopD < 10 && stopD > -6 && this.coming(j, v, near, 4.5, 1)) h = true;
        const prev = this.prevStop.get(j) ?? 99;
        if (prev > -0.9 && stopD <= -0.9 && prev < 20 && spa > 1.5 && sg === 'red') { this.info.redRuns++; this.info.note += `red n${j.n.id} sp${spa.toFixed(1)};`; }
        this.prevStop.set(j, stopD);
        if (h) this.holdWhy = 'signal';
      } else if (j.kind === 'round') {
        if (stopD < 12 && stopD > -2) {
          const rails = this.trafficRef?.rails;
          const ta = Math.atan2(P[2 * j.idx + 1] - j.n.z, P[2 * j.idx] - j.n.x);
          if (rails && rails.circling(j.n, v, near, ta)) { h = true; this.holdWhy = 'roundabout'; }
        }
      } else if (j.kind === 'merge') {
        if (stopD < 25 && stopD > -2 && this.coming(j, v, near, 3.2, 2)) { h = true; this.holdWhy = 'merge'; }
        if (stopD < 40) want = Math.min(want, 9 + Math.max(0, stopD) * 0.25);
      } else if (j.kind === 'stop') {
        const rails = this.trafficRef?.rails;
        const must = rails ? rails.mustStop(j.n, j.e) : true;
        if (must && stopD < 30) want = Math.min(want, 2 + Math.sqrt(3.2 * Math.max(0, stopD)));
        if (!must) { if (j.ang < -0.5 && stopD < 10 && stopD > -6 && this.coming(j, v, near, 4.5, 1)) { h = true; this.holdWhy = 'give way'; } }
        else if (j.stage === 0) {
          h = stopD > -0.6;
          this.holdWhy = 'stop sign';
          if (stopD < 2.2 && spa < 0.6) { j.stopT += dt; if (j.stopT > 0.6) { j.stage = 1; j.stopT = 0; } } else j.stopT = 0;
        } else if (j.stage === 1) {
          h = true; this.holdWhy = 'give way';
          j.stopT += dt;
          const busy = rails ? rails.padBusy(j.n, v, near, (R - 0.5) * (R - 0.5)) : false;
          if ((!busy && !this.coming(j, v, near, 4.2, 0)) || j.stopT > 14) { j.stage = 2; h = false; }
        }
        if (must && j.stage === 0 && !h && stopD < -0.6 && stopD > -3 && spa > 1) { this.info.stopRuns++; this.info.note += `stop n${j.n.id};`; j.stage = 2; }
      } else {
        // 'yield' (an unsignalled crossing) and 'left' (a left turn at a through road): slow, and let cross traffic by.
        if (j.kind === 'yield' && stopD < 28) want = Math.min(want, 5.5 + Math.max(0, stopD) * 0.25);
        if (stopD < 12 && stopD > -6) {
          const rails = this.trafficRef?.rails;
          const busy = rails ? rails.padBusy(j.n, v, near, (R - 0.5) * (R - 0.5)) && dEnd > 1.5 : false;
          if (this.coming(j, v, near, j.kind === 'left' ? 4.5 : 3.5, j.kind === 'left' ? 1 : 0) || busy) {
            j.stopT += dt;
            if (j.stopT < 12) { h = true; this.holdWhy = 'give way'; }
          }
        }
      }
      if (h) {
        hold = true;
        want = Math.min(want, stopD < 0.6 ? 0 : Math.sqrt((4.2 - 1.8 * roads.ai) * stopD));
      }
    }

    // The car in front, and people in the road.
    let blocked = false, onFoot = false, stillCar: Vehicle | null = null, stillLat = 0, stillW = 0;
    const byp = this.byp;
    const reach = 40 + spa * 1.5;
    for (const o of near) {
      if (Math.abs(o.y - v.y) > 3) continue;
      const ox = o.x - v.x, oz = o.z - v.z;
      const lf = ox * fx + oz * fz;
      if (lf <= 0 || lf > reach) continue;
      const lat = -ox * fz + oz * fx;
      const hdg = fx * Math.sin(o.h) + fz * Math.cos(o.h), cc = Math.abs(hdg), sn = Math.sqrt(Math.max(0, 1 - cc * cc));
      const oF = o.vx * fx + o.vz * fz;
      const rch = o.hw * cc + o.hl * sn;
      const band = hdg < -0.5 && oF < -1 ? v.hw + rch + 0.1 : v.hw + rch + 0.4;
      if (Math.abs(lat - byp) > band) continue;
      const gap = lf - v.hl - (o.hl * cc + o.hw * sn);
      const keep = 2.6 + Math.max(0, sp) * 0.45;
      const of = Math.max(0, oF), room = Math.max(0, gap - keep);
      let lim = Math.min(Math.sqrt(4 * room) + of, Math.max(0, of + (gap - keep - 0.9 * Math.max(0, sp)) * 0.9));
      if (gap < keep && of < 1) lim = 0;
      if (lim < want) { want = lim; if (lim < 0.6) { blocked = true; this.blk = `${o.spec.kind} lf${lf.toFixed(1)} lat${lat.toFixed(1)} gap${gap.toFixed(1)} v${Math.hypot(o.vx, o.vz).toFixed(1)} drv${o.driver} y${(o.y - v.y).toFixed(1)}`; if (of < 0.5 && Math.abs(o.vx) + Math.abs(o.vz) < 0.5) { stillCar = o; stillLat = lat; stillW = o.hw * cc + o.hl * sn; } } }
    }
    this.bypass(v, near, hold, stillCar, stillLat, stillW, fx, fz, dt);
    const tr = this.trafficRef ?? (this.trafficRef = this.traffic());
    const peds = tr ? tr.roadPeds() : [];
    const reachP = 7 + Math.max(0, sp) * 1.9;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i], ox = p.x - v.x, oz = p.z - v.z;
      if (ox > 40 || ox < -40 || oz > 40 || oz < -40) continue;
      const lf = ox * fx + oz * fz - v.hl, lat = -ox * fz + oz * fx;
      if (lf < -1 || lf > reachP) continue;
      const lat2 = lat + (-p.vx * fz + p.vz * fx) * 1.2, w = v.hw + 0.9;
      if (Math.abs(lat) > w && Math.abs(lat2) > w && lat * lat2 > 0) continue;
      const lim = lf < 2.6 ? 0 : Math.sqrt(4 * (lf - 2.6));
      if (lim < want) { want = lim; if (lim < 0.6) { blocked = true; onFoot = true; } }
    }
    this.info.want = want; this.info.hold = this.holdWhy || (blocked ? (onFoot ? 'ped' : 'car') : '');

    // Stuck: a blocked lane, or no progress for a while that is not a light or a give-way.
    const waiting = hold && this.holdWhy !== '';
    if (blocked && !onFoot && !waiting && spa < 0.5) this.blockT += dt; else this.blockT = Math.max(0, this.blockT - dt * 2);
    // A parked car where the kerb is: stop behind it, near enough.
    if (rem < 35 && blocked && spa < 0.4 && this.blockT > 1.5) { c.accel = 0; c.steer = 0; c.handbrake = true; this.cancel('Autopilot has parked you as near as it could.'); v.ctl.handbrake = true; return; }
    if (!waiting && !blocked && spa < 0.3 && want > 1.5) this.stuck += dt; else if (spa > 1) this.stuck = 0;
    // Standing still for a reason (a light, a give-way, somebody crossing) or moving is not stuck.
    if (waiting || onFoot || spa > 0.3 || rem < 4) this.lastSAt = this.t;
    const noProg = !waiting && !onFoot && rem > 4 && this.t - this.lastSAt > 5;
    // Honest progress buys back the re-route allowance.
    if (this.s - this.rerouteS > 150) { this.rerouteN = 0; this.rerouteS = this.s; }
    if (this.blockT > BLOCK_REROUTE || this.stuck > STUCK_REROUTE || (noProg && !blocked)) {
      if (this.blockT > BLOCK_GIVEUP || this.stuck > STUCK_GIVEUP || (!blocked && this.t - this.lastSAt > STUCK_GIVEUP)) {
        this.info.note += `giveup blk${this.blockT.toFixed(1)} stk${this.stuck.toFixed(1)} np${(this.t - this.lastSAt).toFixed(1)} wait${waiting} hold${this.holdWhy} blocked${blocked} blk[${this.blk}] j[${this.junc.filter((j) => Math.abs(j.sEnd - this.s) < 70).map((j) => j.kind + Math.round(j.sEnd - this.s)).join(',')}] s${this.s.toFixed(0)} sp${spa.toFixed(1)};`;
        this.info.giveups++; this.cancel('Autopilot is stuck. Over to you.'); return;
      }
      if (this.t - this.lastReroute > 6) { this.reroute(blocked ? 'Something is in the way. Trying another way.' : 'Stuck. Trying another way.'); return; }
    }
    if (blocked && this.blockT > 2.5 && spa < 0.3) c.horn = this.blockT % 4 < 0.4; else c.horn = false;

    // Arrived: stopped at the kerb by the door.
    if (rem < 1.6 && spa < 1.3 || (rem < 0.6)) {
      c.accel = 0; c.steer = 0; c.handbrake = true;
      this.cancel('Autopilot has parked you at the kerb.');
      v.ctl.handbrake = true;
      return;
    }

    // Nose to nose or bumper to bumper with a standing car: back off a little so the way round has room.
    if (this.backT > 0) {
      this.backT -= dt;
      c.accel = -0.6; c.steer = 0; c.handbrake = false;
      return;
    }
    if (this.backCool > 0) this.backCool -= dt;
    if (blocked && !onFoot && !waiting && this.blockT > 3.5 && spa < 0.3 && this.backCool <= 0) {
      let room = true;
      for (const o of near) {
        const ox = o.x - v.x, oz = o.z - v.z, lf = ox * sh + oz * ch;
        if (lf >= 0 || lf < -(v.hl + o.hl + 5) || Math.abs(-ox * ch + oz * sh) > v.hw + o.hw + 0.5) continue;
        room = false; break;
      }
      if (room) { this.backT = 1.4; this.backCool = 8; }
    }
    // Pedals.
    let steer = clamp(-err * 1.9 / (1 + spa / 16), -1, 1);
    if (Math.abs(err) > 1.2 && sp < 3) steer = Math.sign(-err);
    c.steer = steer;
    if (want < 0.25 && spa < 0.8) { c.accel = 0; c.handbrake = true; return; }
    c.handbrake = false;
    const dv = want - sp;
    c.accel = dv > 0 ? Math.min(THROTTLE, dv * 0.4 + 0.06) : dv < -0.7 && sp > 0.5 ? Math.max(-0.9, dv * 0.45) : 0;
  }

  /**
   * A parked car in the lane: after a moment, round it if nothing comes the other way and no junction is near; back into the lane
   * once it is behind.
   */
  private bypass(v: Vehicle, near: readonly Vehicle[], hold: boolean, still: Vehicle | null, lat: number, w: number, fx: number, fz: number, dt: number): void {
    const s = this.s;
    let target = this.bypTarget;
    if (this.bypObs) {
      const o = this.bypObs, ox = o.x - v.x, oz = o.z - v.z, lf = ox * fx + oz * fz;
      if (lf < -(v.hl + o.hl + 2.5) || Math.abs(o.vx) + Math.abs(o.vz) > 1.2) { this.bypObs = null; target = 0; }
    }
    if (!this.bypObs && still && !hold && Math.abs(v.speed) < 0.6) {
      this.stillT += dt;
      let junc = false;
      for (const j of this.junc) if (j.sEnd - s > -8 && j.sEnd - s < 55) junc = true;
      const parked = still.driver === null;
      if (this.stillT > (parked ? 1.2 : 6) && (parked || !junc) && this.total - s > 12) {
        const t = lat - (lat >= 0 ? 1 : -1) * 0 + (lat >= 0 ? -1 : 1) * (w + v.hw + 0.9);
        // Clear on the far side: nothing moving toward her in the strip alongside, for 45 m.
        let clear = true;
        for (const o of near) {
          const ox = o.x - v.x, oz = o.z - v.z, lf = ox * fx + oz * fz, la = -ox * fz + oz * fx;
          if (lf < -6 || lf > 45 || o === still) continue;
          if (Math.abs(la - t) < v.hw + o.hw + 0.8 && Math.abs(o.vx) + Math.abs(o.vz) > 0.4) { clear = false; this.blk = 'oncoming ' + o.spec.kind; break; }
          if (Math.abs(la - t) < v.hw + o.hw + 0.8 && lf > 0 && lf < (parked ? 7 : 25) && Math.abs(lf - (still.x - v.x) * fx - (still.z - v.z) * fz) > 3) { clear = false; this.blk = 'strip ' + o.spec.kind; break; }
        }
        if (clear) { this.bypObs = still; target = t; this.info.note += 'pass;'; this.stillT = 0; }
      }
    } else if (!still) this.stillT = Math.max(0, this.stillT - dt);
    this.bypTarget = target;
    this.byp += clamp(target - this.byp, -1.6 * dt, 1.6 * dt);
  }

  /** Cross traffic and oncoming cars (the town's own tests, which need no street graph of their own). */
  private coming(j: Junc, v: Vehicle, near: readonly Vehicle[], eta: number, mode: 0 | 1 | 2): boolean {
    const rails = this.trafficRef?.rails;
    if (rails) return rails.coming(j.n, v, near, j.ix, j.iz, eta, mode, j.ox, j.oz);
    // ?streets=old: no rails; the same test by hand for cars close to the pad.
    const n = j.n, R = padR(n);
    for (const o of near) {
      const rx = o.x - n.x, rz = o.z - n.z, dist = Math.hypot(rx, rz);
      if (dist < 0.5 || dist > 60) continue;
      const ux = rx / dist, uz = rz / dist;
      if (-(ux * j.ix + uz * j.iz) > 0.9) continue;
      if (mode === 1 && ux * j.ix + uz * j.iz < 0.6) continue;
      const close = -(o.vx * ux + o.vz * uz);
      if (dist < R + 1) { if (Math.hypot(o.vx, o.vz) > 0.5) return true; continue; }
      if (close > 1.5 && (dist - R) / close < eta) return true;
    }
    return false;
  }

  private reroute(msg: string): void {
    const g = this.game, nav = g.todo.navigator, v = this.veh;
    if (!v) return;
    this.info.note += `rr ${msg.slice(0, 10)} s${this.s.toFixed(0)}/${this.total.toFixed(0)} blk${this.blockT.toFixed(1)} stk${this.stuck.toFixed(1)} np${(this.t - this.lastSAt).toFixed(1)} h${this.info.hold} blk[${this.blk}] by${this.byp.toFixed(1)};`;
    this.lastReroute = this.t; this.lastSAt = this.t; this.blockT = 0; this.stuck = 0; this.rerouteS = 0;
    if (this.total - this.s < 60) { v.ctl.handbrake = true; this.cancel('Autopilot has parked you as near as it could.'); v.ctl.handbrake = true; return; }
    if (++this.rerouteN > 4) { this.info.giveups++; this.cancel('Autopilot cannot find a way through. Over to you.'); return; }
    this.info.reroutes++;
    nav.heading = { x: Math.sin(v.h), z: Math.cos(v.h) };
    nav.reroute();
    nav.update(0, g.plan, v.x, v.z, g.todo.target(), null, g.hud.nav);
    if (!nav.ok || !nav.legs.length || !this.build(v)) { this.info.giveups++; this.cancel('Autopilot lost the way. Over to you.'); return; }
    g.hud.toast(msg, 3);
  }
}
