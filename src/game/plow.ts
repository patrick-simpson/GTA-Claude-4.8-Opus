// Snowplow and salt-truck jobs (fun queue 2, item 20): when snow is lying, the yard has work.
//
//   when       snow lying on the ground (Sky.snowCover, 0.2 and up: the real winter, a storm, or ?snow=1 for a test). With bare
//              streets the yard has nothing for you and says so.
//   where      the two yards: Marlowe's yard on the island and the Hillside Avenue Sandpit in Tepid Falls. In a pickup or the
//              tow truck, stopped in the yard, G takes the snowplow route (a yellow blade goes on the front). In a van, G takes
//              the salt-truck route (a hopper on the roof).
//   the route  real streets: from the yard to a corner, then on to a second corner (game/nav.ts Navigator.trace), about
//              half a kilometre to a kilometre in all. The radar and the route line lead you down it a stretch at a time.
//   progress   the route is a row of points every five metres; drive within four metres of one (the blade ahead of the
//              truck, the spreader behind it) and it is clear. The strip of road you cleared shows: dark, bare tarmac for a
//              plough, a pale salted crust for the salt truck. Ninety per cent clear ends the job and pays.
//   pay        base + distance, a speed bonus over the par time, a deeper snow pays a little more; payouts taper like every
//              job (activities.ts taper). The job's best is the leaderboard's "Best snow job".
//   leaving    G (stopped, away from the yard) calls it off for a part payment; out of the truck for 45 s, the same; if the snow
//              melts away the town pays for what you did.
//
// Everything here is this browser's own: no messages, no protocol. The cleared strips are drawn for this player only.

import * as THREE from 'three';
import { flip } from '../core/flip';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import { places } from '../world/business';
import { BUILDING_SITES } from '../world/buildings';
import { groundAt, WATER_Y } from '../world/plan';
import { progress } from '../world/progress';
import { money } from '../core/util';
import { save } from './save';
import { taper } from './activities';
import { Navigator, distText } from './nav';
import { clock, type Markers, type Pt } from './script';

export type Kind = 'plow' | 'salt';

/** Snow cover (0..1) at which the yard has work. */
const NEED = 0.2;
/** A route point is clear when the working end of the truck passes this close. */
const REACH = 4;
/** Metres between route points. */
const STEP = 5;
/** Share of the route that ends the job. */
const DONE = 0.92;
/** The yard's door: how close, stopped, G works. */
const YARD = 20;

interface Depot { name: string; x: number; z: number; land: number }
interface Route {
  kind: Kind; depot: Depot;
  xs: number[]; zs: number[]; done: Uint8Array;
  cleared: number; len: number; fare: number; par: number; t: number; cover: number;
  /** The route point the radar leads toward, and the point it was last set at. */
  lead: number; base: number;
}

const LINES = {
  plow: ['Down to the tarmac. The street remembers what it looked like.', 'That is a lane. A lane! I had forgotten.', 'Good work. The snow is somewhere else now, and it is angry.', 'The blade does the work. You take the credit.'],
  salt: ['Crunchy. That is the sound of money.', 'The street is salted. The cars will be rust by spring. That is the plan.', 'A pale crust. The pretzel lobby thanks you.', 'Salted, as ordered. Nobody ordered this much, but here we are.'],
};
const HELLO = {
  plow: 'Blade down. The streets you drive get cleared.',
  salt: 'Spreader on. The streets you drive get salted.',
};

/** What a truck of this kind can do (null: nothing). */
function jobOf(kind: string): Kind | null {
  return kind === 'pickup' || kind === 'tow' ? 'plow' : kind === 'van' ? 'salt' : null;
}

export class Plow {
  prompt: string | null = null;
  target: Pt | null = null;
  targetName: string | null = null;
  /** The job in hand (null: none). */
  run: Route | null = null;
  /** The last job's pay, for the tests. */
  last = { cash: 0, pct: 0, kind: '' };

  private on = false;
  private ride: Vehicle | null = null;
  private awayT = 0;
  private depotsCache: Depot[] | null = null;
  private readonly force: number;
  private forced = false;
  private scanT = 0;
  private lines = 0;
  private rig: THREE.Group | null = null; private rigFor: Vehicle | null = null; private rigKind: Kind | null = null;
  private readonly eul = new THREE.Euler(0, 0, 0, 'YXZ');
  private strips: Cleared | null = null;

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    // ?snow=1 (or ?snow=0.6): snow lying at that depth all the time, so the job can be tried on a summer day.
    let f = 0;
    try {
      const q = new URLSearchParams(location.search).get('snow');
      if (q !== null && q !== '0') { const n = q === '' ? 1 : parseFloat(q); f = Number.isFinite(n) ? Math.min(1, Math.max(0.3, n)) : 1; }
    } catch { /* no URL, no test */ }
    this.force = f;
    game.on('booked', () => this.stop('The Harbor Patrol has ended your shift for you.'));
  }

  get busy(): boolean { return this.on; }

  /** Snow lying deep enough to work. */
  get snowing(): boolean { return this.game.sky.snowCover >= NEED; }

  // ── The yards ──────────────────────────────────────────────────────────────

  /** The street's centreline nearest a point. */
  private snap(x: number, z: number): Pt {
    const plan = this.game.plan, S = plan.streets;
    if (S) { const ne = S.nearestEdge(x, z, (e) => !e.deck), q = S.pointAt(ne.edge, ne.s); return { x: q.x, z: q.z }; }
    const ne = plan.nearestEdge(x, z), A = plan.nodes[ne.edge.a];
    return ne.edge.horiz ? { x: A.x + ne.s, z: A.z } : { x: A.x, z: A.z + ne.s };
  }

  private landOf(x: number, z: number): number { const g = this.game; return (g.plan.streets ?? g.plan).nearestNode(x, z).land; }

  depots(): Depot[] {
    if (this.depotsCache) return this.depotsCache;
    const g = this.game, out: Depot[] = [];
    const m = BUILDING_SITES.marlowe, isl = this.snap(m ? m.x : -397, m ? m.z : 276);
    out.push({ name: "Marlowe's yard", x: isl.x, z: isl.z, land: this.landOf(isl.x, isl.z) });
    const sp = places(g.plan).find((p) => p.placed && /sandpit/i.test(p.name));
    if (sp) { const q = this.snap(sp.x, sp.z); out.push({ name: sp.name, x: q.x, z: q.z, land: this.landOf(q.x, q.z) }); }
    return (this.depotsCache = out);
  }

  /** The yard the vehicle is standing in, if any. */
  private yardAt(x: number, z: number): Depot | null {
    for (const d of this.depots()) if (Math.hypot(d.x - x, d.z - z) < YARD) return d;
    return null;
  }

  // ── The route ──────────────────────────────────────────────────────────────

  /** A route of real streets from the yard: to a corner, then on to another. Null if none is found. */
  private route(kind: Kind, d: Depot): Route | null {
    const g = this.game, plan = g.plan, G = plan.streets ?? plan, nav = new Navigator();
    const ok = G.nodes.filter((n) => n.land === d.land && n.edges.some((e) => !G.edges[e].closed && !G.edges[e].deck));
    const near = (a: Pt, lo: number, hi: number) => ok.filter((n) => { const q = Math.hypot(n.x - a.x, n.z - a.z); return q > lo && q < hi; });
    for (let tries = 0; tries < 16; tries++) {
      const pa = near(d, 200, 650);
      if (!pa.length) return null;
      const A = pa[Math.floor(Math.random() * pa.length)];
      const t1 = nav.trace(plan, d.x, d.z, A.x, A.z);
      if (!t1 || t1.total < 220 || t1.total > 1000) continue;
      const pb = near(A, 160, 500).filter((n) => Math.hypot(n.x - d.x, n.z - d.z) > 120);
      if (!pb.length) continue;
      const B = pb[Math.floor(Math.random() * pb.length)];
      const t2 = nav.trace(plan, A.x, A.z, B.x, B.z);
      if (!t2 || t2.total < 150 || t2.total > 700) continue;
      const poly = [...t1.poly, ...t2.poly.slice(2)];
      // A point every STEP metres; a street driven twice counts once.
      const xs: number[] = [], zs: number[] = [];
      const add = (x: number, z: number): void => {
        for (let i = xs.length - 1; i >= 0 && i >= xs.length - 400; i--) if ((xs[i] - x) * (xs[i] - x) + (zs[i] - z) * (zs[i] - z) < 9) return;
        xs.push(x); zs.push(z);
      };
      add(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) {
        const x0 = poly[i - 2], z0 = poly[i - 1], x1 = poly[i], z1 = poly[i + 1], L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / STEP));
        for (let k = 1; k <= n; k++) add(x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n);
      }
      if (xs.length < 40) continue;
      const len = xs.length * STEP, cover = g.sky.snowCover;
      return { kind, depot: d, xs, zs, done: new Uint8Array(xs.length), cleared: 0, len, fare: Math.round((kind === 'plow' ? 40 : 36) + len * 0.1), par: Math.round(len / 8 + 28), t: 0, cover, lead: -1, base: 0 };
    }
    return null;
  }

  // ── Taking and ending the job ──────────────────────────────────────────────

  /** Take the route for the truck the player is in, at a yard (the G prompt; tests call it too). False if it cannot. */
  accept(): boolean {
    const g = this.game, v = g.player.vehicle;
    if (!this.isFree() || this.on || !v || g.player.health <= 0) return false;
    const kind = jobOf(v.spec.kind), d = this.yardAt(v.x, v.z);
    if (!kind || !d || !this.snowing) return false;
    const r = this.route(kind, d);
    if (!r) { g.hud.toast('The yard has nothing that needs clearing from here. The snow is on a break.', 4); return false; }
    this.run = r; this.on = true; this.awayT = 0; this.lines = 0;
    this.setBusy('plow');
    this.hold(v);
    this.setLead(true);
    this.cleared().clear();
    g.hud.toast(`${kind === 'plow' ? 'Snowplow' : 'Salt truck'}: ${distText(r.len)} of streets from ${d.name}. ${HELLO[kind]} G (stopped, away from the yard) calls it off.`, 8);
    return true;
  }

  /** End the job. pay: how to settle (a finished job, a called-off one, or nothing). */
  stop(why?: string, settle: 'none' | 'part' | 'full' = 'none'): void {
    if (!this.on) return;
    const g = this.game, r = this.run;
    this.on = false; this.run = null;
    if (this.ride) { this.ride.held = false; this.ride = null; }
    this.target = null; this.targetName = null;
    this.rigOff();
    this.strips?.end();
    g.hud.objective(null); g.hud.timer(null);
    this.setBusy(null);
    if (r && settle !== 'none') this.settle(r, settle === 'full', why);
    else if (why) g.hud.toast(why, 5);
  }

  private pct(r: Route): number { return r.cleared / r.done.length; }

  /** The pay for what is done: the fare, a speed bonus, the depth of the snow. */
  private pay(r: Route, full: boolean): number {
    const f = this.pct(r), share = full ? 1 : Math.min(0.6, f * 0.6);
    const bonus = full ? r.fare * 0.25 * Math.max(0, 1 - r.t / r.par) : 0;
    return Math.round((r.fare * Math.min(1, f / DONE) + bonus) * share * (0.85 + 0.3 * r.cover));
  }

  private settle(r: Route, full: boolean, why?: string): void {
    const g = this.game, hud = g.hud, f = this.pct(r);
    if (f < 0.12) { hud.toast(why ?? 'Called off. The street has not noticed.', 5); this.last = { cash: 0, pct: Math.round(f * 100), kind: r.kind }; return; }
    const tp = taper(save.count('plow')), cash = Math.round(this.pay(r, full) * tp.cash), pts = full ? Math.round(10 * tp.points) : 0;
    save.bump('plow');
    g.player.money += cash; save.credit(cash); save.data.stats.earned += cash;
    if (pts) progress.add(pts);
    const record = save.record('plow', cash, false);
    this.last = { cash, pct: Math.round(f * 100), kind: r.kind };
    const what = r.kind === 'plow' ? 'PLOWED' : 'SALTED';
    if (full) {
      hud.stamp(`ROUTE ${what}`, `${money(cash)} for ${distText(r.len)} in ${clock(Math.round(r.t))}${record ? ' · a new best snow job' : ''}. The yard says it is the best ${r.kind === 'plow' ? 'plowing' : 'salting'} since the last one.`);
      hud.toast(`${money(cash)} from the yard${pts ? `. ${pts} toward the bridge` : ''}.`, 6);
      g.emit('moment', { kind: 'plow' });
    } else hud.toast(`${why ? why + ' ' : ''}${Math.round(f * 100)}% done: the yard pays ${money(cash)}.`, 6);
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  blips(out: Blip[]): void {
    if (this.on && this.run) { out.push({ x: this.target?.x ?? 0, z: this.target?.z ?? 0, kind: 'goal', label: this.run.kind === 'plow' ? 'P' : 'S' }); return; }
    if (!this.isFree() || !this.snowing) return;
    const p = this.game.player;
    for (const d of this.depots()) if (Math.hypot(d.x - p.x, d.z - p.z) < 420) out.push({ x: d.x, z: d.z, kind: 'job', label: 'S' });
  }

  update(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle;
    this.prompt = null;
    if (this.force > 0) {
      if (!this.forced) { this.forced = true; g.sky.setWeather('snow', true); }
      if (g.sky.snowCover < this.force) g.sky.setSnowCover(this.force);
    }
    const cl = this.strips;
    if (cl) cl.show(g.sky.snowCover > 0.03);
    if (!this.on || !this.run) { this.target = null; this.rigOff(); if (this.on) this.stop(undefined); if (this.isFree()) this.offer(v); return; }
    const r = this.run;
    if (!(p.health > 0)) { this.stop('Shift over. Mercy General does not take salt.', 'part'); return; }
    if (g.sky.snowCover < 0.03) { this.stop('The snow has melted. The town pays for what you did.', this.pct(r) >= DONE ? 'full' : 'part'); return; }
    r.t += dt;
    const mine = !!v && jobOf(v.spec.kind) === r.kind;
    if (!mine) {
      this.awayT += dt; this.rigOff();
      g.hud.objective(`Get back in ${r.kind === 'plow' ? 'a pickup or the tow truck' : 'the van'}: the route is waiting, or the job is off.`);
      if (this.awayT > 45) this.stop('The yard took the job back. The snow did not move.', 'part');
      return;
    }
    this.awayT = 0;
    const veh = v as Vehicle;
    this.hold(veh); this.syncRig(veh, r.kind);
    this.work(dt, veh, r);
    if (!this.run) return;
    // The radar leads a stretch at a time.
    if (r.lead < 0 || this.first(r) >= r.base + 14 || r.done[r.lead]) this.setLead(false);
    const t = this.target as Pt;
    this.markers.put(t.x, t.z, 'job', 7, 26);
    const f = this.pct(r), left = Math.max(0, r.par - r.t), street = g.plan.streetAt(t.x, t.z);
    g.hud.objective(`${r.kind === 'plow' ? 'Plow' : 'Salt'} ${street}: ${Math.round(f * 100)}% clear. Drive the route line.`);
    g.hud.timer(r.kind === 'plow' ? 'Snowplow' : 'Salt truck', `${Math.round(f * 100)}% · ${money(this.pay(r, true))} · ${left > 0 ? clock(Math.round(left)) : 'slow'}`, false);
    if (f >= DONE) { this.stop(undefined, 'full'); return; }
    // Calling it off: stopped, away from the yard.
    if (Math.abs(veh.speed) < 3 && !this.yardAt(veh.x, veh.z) && r.t > 3) {
      this.prompt = `[G] Call it off (${money(this.pay(r, false))} for what is done)`;
      if (g.input.eat('interact') && r.t > 2) this.stop('Called off.', 'part');
    }
  }

  /** The first route point not yet clear. */
  private first(r: Route): number { const d = r.done; for (let i = Math.max(0, r.base - 2); i < d.length; i++) if (!d[i]) return i; return d.length - 1; }

  private setLead(initial: boolean): void {
    const r = this.run as Route, f = this.first(r);
    r.base = f;
    r.lead = Math.min(r.done.length - 1, f + 30);
    this.target = { x: r.xs[r.lead], z: r.zs[r.lead] };
    this.targetName = `the ${r.kind === 'plow' ? 'plow' : 'salt'} route${initial ? '' : ''}`;
  }

  /** Mark the route points the working end of the truck passes; lay the cleared strip. */
  private work(dt: number, v: Vehicle, r: Route): void {
    const sp = v.spec, s = Math.sin(v.h), c = Math.cos(v.h), moving = Math.abs(v.speed) > 1.2;
    // The blade is ahead of the plough; the spreader is behind the salt truck.
    const off = r.kind === 'plow' ? sp.length * 0.5 + 1 : -sp.length * 0.5 - 0.5;
    const wx = v.x + s * off, wz = v.z + c * off;
    if (moving) {
      const R2 = REACH * REACH;
      for (let i = 0; i < r.xs.length; i++) {
        if (r.done[i]) continue;
        const dx = r.xs[i] - wx, dz = r.zs[i] - wz;
        if (dx * dx + dz * dz < R2) { r.done[i] = 1; r.cleared++; }
      }
      // A heavy blade slows the truck a little (the plough only).
      if (r.kind === 'plow') {
        const q = Math.hypot(v.vx, v.vz), cap = Math.min(sp.topSpeed * 0.8, 17);
        if (q > cap) { const k = cap / q; v.vx *= k; v.vz *= k; }
      }
    }
    if (moving && v.onGround && !v.sunk && v.y > WATER_Y) this.cleared().lay(wx, wz, v.y, r.kind === 'plow' ? 2.0 : 1.7, r.kind);
    else this.strips?.end();
    this.scanT += dt;
    if (this.scanT > 22) { this.scanT = 0; this.game.hud.subtitle('YARD', LINES[r.kind][this.lines++ % LINES[r.kind].length], 4); }
  }

  private hold(v: Vehicle): void {
    if (this.ride === v) return;
    if (this.ride) this.ride.held = false;
    this.ride = v; v.held = true;
  }

  // ── At the yard ────────────────────────────────────────────────────────────

  private offer(v: Vehicle | null): void {
    const g = this.game;
    if (!v || Math.abs(v.speed) > 3 || g.player.heat > 0 || g.player.health <= 0) return;
    const kind = jobOf(v.spec.kind);
    if (!kind || !this.yardAt(v.x, v.z)) return;
    if (!this.snowing) { this.prompt = 'Public works: nothing to clear while the streets are bare. Come back when it snows.'; return; }
    this.prompt = kind === 'plow' ? '[G] Take a snowplow route' : '[G] Take a salt-truck route';
    if (g.input.eat('interact')) this.accept();
  }

  // ── The rig on the truck ───────────────────────────────────────────────────

  private buildRig(v: Vehicle, kind: Kind): void {
    this.rig?.removeFromParent();
    const grp = new THREE.Group(), sp = v.spec, L = sp.length, W = sp.width, H = sp.height;
    const box = (m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0): THREE.Mesh => {
      const me = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); me.position.set(x, y, z); me.rotation.x = rx; me.castShadow = true; grp.add(me); return me;
    };
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.5, metalness: 0.2 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.5, metalness: 0.6 });
    const amber = new THREE.MeshBasicMaterial({ color: 0xffb020, fog: true });
    yellow.userData.noSnow = true; steel.userData.noSnow = true;
    if (kind === 'plow') {
      // A broad blade, leaning forward at the top, on two arms to the bumper; a curved edge strip below.
      box(yellow, W + 0.55, 0.78, 0.1, 0, 0.62, L * 0.5 + 0.55, -0.25);
      box(steel, W + 0.55, 0.06, 0.16, 0, 0.22, L * 0.5 + 0.62);
      box(steel, 0.12, 0.12, 0.8, W * 0.3, 0.45, L * 0.5 + 0.2); box(steel, 0.12, 0.12, 0.8, -W * 0.3, 0.45, L * 0.5 + 0.2);
    } else {
      // A hopper on the roof, with a spinner plate at the back.
      box(yellow, W * 0.82, 0.55, L * 0.5, 0, H + 0.3, -L * 0.1);
      box(steel, W * 0.6, 0.06, L * 0.46, 0, H + 0.62, -L * 0.1);
      box(steel, 0.5, 0.05, 0.5, 0, 0.45, -L * 0.5 - 0.3);
    }
    box(amber, 0.7, 0.14, 0.2, 0, H + (kind === 'salt' ? 0.9 : 0.14), kind === 'salt' ? L * 0.12 : L * 0.05);
    this.game.scene.add(grp);
    this.rig = grp; this.rigFor = v; this.rigKind = kind;
  }

  private syncRig(v: Vehicle, kind: Kind): void {
    if (this.rigFor !== v || !this.rig || this.rigKind !== kind) this.buildRig(v, kind);
    const grp = this.rig as THREE.Group;
    this.eul.set(-v.pitch, v.h, v.roll, 'YXZ');
    grp.quaternion.setFromEuler(this.eul);
    grp.position.set(v.x, v.y, v.z);
  }

  private rigOff(): void { if (this.rig) { this.rig.removeFromParent(); this.rig = null; this.rigFor = null; this.rigKind = null; } }

  private cleared(): Cleared { return this.strips ?? (this.strips = new Cleared(this.game)); }

  /** For the tests. */
  info(): { kind: Kind; pct: number; cleared: number; points: number; len: number; fare: number; par: number; t: number; start: Pt; end: Pt; depot: string; strips: number } | null {
    const r = this.run;
    return r ? { kind: r.kind, pct: this.pct(r), cleared: r.cleared, points: r.done.length, len: r.len, fare: r.fare, par: r.par, t: r.t, start: { x: r.xs[0], z: r.zs[0] }, end: { x: r.xs[r.xs.length - 1], z: r.zs[r.zs.length - 1] }, depot: r.depot.name, strips: this.strips?.count ?? 0 } : null;
  }
  /** For the tests: the route's points. */
  points(): [number, number][] { const r = this.run; return r ? r.xs.map((x, i) => [x, r.zs[i]] as [number, number]) : []; }
}

// ── The cleared strips ───────────────────────────────────────────────────────

const QUADS = 4200;
/** Height above the surface; polygonOffset does the rest. */
const LIFT = 0.03;

/**
 * What the truck has cleared: one preallocated mesh of ribbon quads, a ring (the oldest go first), laid as the truck moves.
 * Dark, bare tarmac for a plough; a pale salted crust for the salt truck. A material that opts out of the snow cover
 * (userData.noSnow) so the road shows through the snow lying around it. Per-frame buffers go through game.flip.
 */
class Cleared {
  private readonly pos = new Float32Array(QUADS * 12);
  private readonly col = new Float32Array(QUADS * 12);
  private readonly aPos: THREE.BufferAttribute;
  private readonly aCol: THREE.BufferAttribute;
  private readonly mesh: THREE.Mesh;
  private head = 0;
  private n = 0;
  private on = false;
  private cx = 0; private cz = 0; private edge = false;
  private lx = 0; private ly = 0; private lz = 0; private rx = 0; private ry = 0; private rz = 0;

  constructor(game: Game) {
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    const nrm = new Float32Array(QUADS * 12);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    flip.geo(geo, 'position'); flip.geo(geo, 'color');
    const idx = new Uint16Array(QUADS * 6);
    for (let i = 0; i < QUADS; i++) { const v = i * 4, o = i * 6; idx[o] = v; idx[o + 1] = v + 2; idx[o + 2] = v + 1; idx[o + 3] = v + 2; idx[o + 4] = v + 3; idx[o + 5] = v + 1; }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    mat.userData.noSnow = true;
    // Its own program: the shared cache key (world/snowCover.ts) does not look at noSnow, and a vertex-colour material that does take snow would be reused.
    mat.customProgramCacheKey = (): string => 'cleared-road';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.name = 'cleared-road';
    game.scene.add(this.mesh);
  }

  get count(): number { return this.n; }

  show(v: boolean): void { this.mesh.visible = v && this.n > 0; }

  /** Forget every strip (a new job starts on a fresh road). */
  clear(): void { this.pos.fill(0); this.aPos.needsUpdate = true; this.n = 0; this.head = 0; this.on = false; this.edge = false; this.mesh.visible = false; }

  end(): void { this.on = false; this.edge = false; }

  private height(x: number, z: number, carY: number): number {
    const gy = groundAt(x, z);
    return (Math.abs(gy - carY) < 0.5 ? gy : carY) + LIFT;
  }

  lay(x: number, z: number, carY: number, hw: number, kind: Kind): void {
    if (!this.on) { this.on = true; this.edge = false; this.cx = x; this.cz = z; return; }
    const dx = x - this.cx, dz = z - this.cz, d2 = dx * dx + dz * dz;
    if (d2 < 1.2 * 1.2) return;
    // Metres in one frame is a teleport, not a drive.
    if (d2 > 36) { this.end(); return; }
    const d = Math.sqrt(d2), ux = dx / d, uz = dz / d, px = -uz * hw, pz = ux * hw;
    if (!this.edge) {
      this.lx = this.cx + px; this.lz = this.cz + pz; this.ly = this.height(this.lx, this.lz, carY);
      this.rx = this.cx - px; this.rz = this.cz - pz; this.ry = this.height(this.rx, this.rz, carY);
      this.edge = true;
    }
    const nlx = x + px, nlz = z + pz, nly = this.height(nlx, nlz, carY), nrx = x - px, nrz = z - pz, nry = this.height(nrx, nrz, carY);
    const i = this.head, o = i * 12, p = this.pos, c = this.col;
    this.head = i + 1 === QUADS ? 0 : i + 1;
    this.n = Math.min(QUADS, this.n + 1);
    p[o] = this.lx; p[o + 1] = this.ly; p[o + 2] = this.lz; p[o + 3] = this.rx; p[o + 4] = this.ry; p[o + 5] = this.rz;
    p[o + 6] = nlx; p[o + 7] = nly; p[o + 8] = nlz; p[o + 9] = nrx; p[o + 10] = nry; p[o + 11] = nrz;
    // Plough: wet dark tarmac. Salt: the same, with a pale crust and a speckle (a little different on each quad).
    for (let k = 0; k < 4; k++) {
      let r: number, g: number, b: number;
      if (kind === 'plow') { r = 0.075; g = 0.078; b = 0.085; }
      else { const w = 0.22 + 0.2 * ((i * 7 + k * 3) % 5) / 5; r = w; g = w + 0.01; b = w + 0.03; }
      c[o + k * 3] = r; c[o + k * 3 + 1] = g; c[o + k * 3 + 2] = b;
    }
    this.aPos.addUpdateRange(o, 12); this.aPos.needsUpdate = true;
    this.aCol.addUpdateRange(o, 12); this.aCol.needsUpdate = true;
    this.lx = nlx; this.ly = nly; this.lz = nlz; this.rx = nrx; this.ry = nry; this.rz = nrz;
    this.cx = x; this.cz = z;
    this.mesh.visible = true;
  }
}
