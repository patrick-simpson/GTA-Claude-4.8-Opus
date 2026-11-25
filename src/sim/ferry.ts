// Fun queue 2, item 11: the Calamity Shuttle, a passenger ferry between Pelican Landing (the island harbour) and Tepid Falls
// Landing (the Muddle River's west bank, below the dam). Two launches sail the route of world/ferryRoute.ts on the town clock
// (the sky's hour, like the Budget Line), so every screen has them in the same place with no messages.
//
// This is the rider's side, as sim/rail.ts is for the train: the landings' prompts (next sailing and its wait, "board" while a
// ferry stands in), the seat on a bench (seen by the others), the riding HUD, getting off at a landing, jumping off anywhere
// (the swimming and drowning rules of ent/player.ts take it from there: the lifeguard in kid mode), the route and the boats
// on the big map, and the fast-travel "Take the ferry" between the two landings.
//
// Press F on a landing while a ferry stands in ($4, free in kid mode) and sit in one of its 16 seats. F at a landing gets you
// off; at sea F says so and Space jumps. A rider says so in the ordinary state frame, like a bus rider: mode Passenger,
// `vehicle` 0, `color` = (FERRY_RIDE_BASE + ferry) << 8 | seat. FERRY_RIDE_BASE is 140 (buses 1..12, train coaches 129 and 130,
// a real driver's id is in `vehicle` and never 0), so no new event or field: protocol unchanged. Every screen seats the rider
// from its own copy of the ferry (net/ride.ts seatOthers -> seatOf here).
//
// The ferries are solid to the player's boats: a boat that runs into one is pushed off it and bounced, gently.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle, VehicleControls } from '../core/api';
import type { Boat } from '../ent/boat';
import { SPECS, type VehicleSpec } from '../ent/vehicleSpecs';
import { DOCKS, FERRIES, FERRY_RIDE_BASE, ferryPlan, ferryPose, untilDock, type FerryPose } from '../world/ferryRoute';
import { FERRY_LEN, FERRY_BEAM, FERRY_SEATS, HIPS, buildFerryDocks, ferryBody, ferryKit } from '../world/ferryBoat';
import { STREETS_NEW } from '../world/streets';
import { waterLevelAt } from '../world/mainland';
import { seaSlope, seaY } from '../world/sea';
import { PlayerMode } from '../net/protocol';
import { kid } from '../core/kid';
import { money } from '../core/util';

export const FARE = 4;
const OUT = 0.4, HOLD = 1.1, IN = 0.5;

export interface Rider { ferry: number; seat: number; id: number; from: number }

const mmss = (s: number): string => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const minutes = (sec: number): string => (sec < 45 ? 'under a minute' : `${Math.max(1, Math.round(sec / 60))} min`);

class Seat implements Partial<Vehicle> {
  x = 0; y = 0; z = 0; h = 0; pitch = 0; roll = 0; vx = 0; vy = 0; vz = 0; yawRate = 0;
  readonly hl = 0.6; readonly hw = 0.6; readonly id = 9701;
  readonly spec: VehicleSpec = SPECS.speedboat;
  ctl: VehicleControls = { accel: 0, steer: 0, handbrake: false, horn: false };
  driver: 'player' | 'ai' | null = null; color = 0; health = 100; onGround = true; airTime = 0; slip = 0; lights = false; sunk = false; held = true;
  ex = 0; ez = 0;
  get speed(): number { return Math.hypot(this.vx, this.vz); }
  doorPos(_side: -1 | 1, out: { x: number; z: number }): void { out.x = this.ex; out.z = this.ez; }
}

interface Ferry {
  i: number;
  pose: FerryPose;
  x: number; y: number; z: number; h: number; pitch: number; roll: number; vx: number; vz: number;
  group: THREE.Group;
  hull: Boat | null;
  lastX: number; lastZ: number; seen: boolean;
}

const EUL = new THREE.Euler(0, 0, 0, 'YXZ'), VEC = new THREE.Vector3();

export class FerryService {
  readonly stats = { boards: 0, exits: 0, jumps: 0, paid: 0, refusedFull: 0, refusedMoney: 0, travels: 0, travelPaid: 0, bumps: 0 };
  rider: Rider | null = null;
  /** The landing she stands on (index into DOCKS) or -1. */
  zone = -1;
  /** Fast travel in hand: 1 fading out, 2 held under black, 3 fading in; 0 none. */
  phase = 0;
  readonly ferries: Ferry[] = [];
  /** Test hook: minutes added to the town clock. */
  shift = 0;
  lost = '';
  last: { from: string; to: string; fare: number } | null = null;
  private dest = -1;
  private t = 0;
  private readonly seat = new Seat();
  private readonly at = { x: 0, y: 0, z: 0 };
  private hud: HTMLDivElement | null = null;
  private card: HTMLDivElement | null = null;
  private hudText = '';
  private prompting = false;
  private promptKey = '';
  private lastNag = -9;
  private etaFor = -1; private etaAt = -9; private etaStr = '';
  private openAt = -9; private isOpen = false;
  private readonly sl = { x: 0, z: 0, vy: 0 };
  private built = false;

  constructor(private readonly game: Game) {
    if (!STREETS_NEW) return;
    try {
      buildFerryDocks(game);
      const kit = ferryKit((game.world.mats.flat as THREE.MeshStandardMaterial).envMap ?? null);
      for (let i = 0; i < FERRIES; i++) {
        const group = ferryBody(kit, game.quality.shadows);
        const root = new THREE.Group();
        root.add(group);
        game.scene.add(root);
        const f: Ferry = { i, pose: ferryPose(this.clock(), i, { x: 0, z: 0, h: 0, v: 0, state: 0, dock: 0, dir: 1, left: 0, frac: 0 }), x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0, vx: 0, vz: 0, group: root, hull: null, lastX: 0, lastZ: 0, seen: false };
        try { f.hull = game.player.boats.craft(FERRY_LEN / 2, FERRY_BEAM / 2 + 0.2); } catch (e) { console.warn('ferry wake did not build', e); }
        this.ferries.push(f);
      }
      this.built = true;
      const d = document.createElement('div');
      d.id = 'ferry-hud';
      d.style.cssText = 'position:fixed;left:50%;top:92px;transform:translateX(-50%);z-index:30;display:none;max-width:min(560px,92vw);padding:8px 14px 9px;background:rgba(233,224,200,0.94);color:#143a47;border:2px solid #143a47;border-radius:4px;font:600 13px/1.35 "IBM Plex Mono",monospace;box-shadow:0 3px 0 rgba(20,58,71,0.35);pointer-events:none;text-align:center';
      document.body.appendChild(d);
      this.hud = d;
      const c = document.createElement('div');
      c.id = 'ferry-card';
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:#000;opacity:0;pointer-events:none;color:#e9e0c8;font:600 15px/1.5 "IBM Plex Mono",monospace;text-align:center';
      document.body.appendChild(c);
      this.card = c;
      game.on('pause', (e) => { d.style.visibility = e.on ? 'hidden' : 'visible'; });
    } catch (e) { console.warn('ferry did not build', e); }
    // F belongs to the bus's and the train's rule too: a ferry rider gets off only at a landing.
    const prev = game.player.rideHold;
    game.player.rideHold = () => (this.rider ? (this.canAlight() ? (this.prepExit(false), true) : false) : prev ? prev() : true);
  }

  get on(): boolean { return this.built && !!this.hud; }
  /** The town clock in minutes (the sky's hour; the tests may shift it). */
  clock(): number { return ((this.game.sky?.hour ?? 8) * 60 + this.shift) % 1440; }
  private rate(): number { const r = (this.game.sky?.rate ?? 1 / 60) * 60; return r > 0 ? r : 1e-6; }
  /** Is the service open: the town has a way down to the river landing (the mainland is unlocked as far as Lower Main). */
  get open(): boolean {
    const g = this.game;
    if (g.time - this.openAt > 1 || g.time < this.openAt) {
      this.openAt = g.time;
      const d = DOCKS[1];
      this.isOpen = g.todo.travel.open({ name: d.name, x: d.x, z: d.z, nx: 0, nz: 0 });
    }
    return this.isOpen;
  }

  // ── The timetable, as a rider reads it ──

  /** The next ferry to stand at dock d: real seconds until it is in (0 if standing now) and how long it stays (real seconds). */
  next(d: number): { eta: number; left: number; here: boolean; ferry: number } | null {
    if (!this.built) return null;
    const m = this.clock(), r = this.rate();
    let best: { eta: number; stay: number; ferry: number } | null = null;
    for (let i = 0; i < FERRIES; i++) { const u = untilDock(m, i, d); if (!best || u.eta < best.eta) best = { ...u, ferry: i }; }
    return best ? { eta: best.eta / r, left: best.stay / r, here: best.eta <= 0, ferry: best.ferry } : null;
  }
  etaText(d: number): string {
    if (!this.on) return 'No ferry service';
    const n = this.next(d), ps = ferryPlan();
    if (!n) return 'No ferry soon';
    const to = DOCKS[1 - d].name;
    return n.here ? `Ferry to ${to} in now, leaves in ${mmss(n.left)}` : `Next ferry to ${to} in ${mmss(n.eta)} (a ${Math.round(ps.ab.total / 60 / this.rate() * 10) / 10} min crossing)`;
  }
  nextFerryText(d: number): string {
    if (!this.on) return 'No service';
    const n = this.next(d);
    if (!n) return 'No ferry soon';
    return n.here ? 'Ferry in now' : `Next ferry in ${minutes(n.eta)}`;
  }

  // ── Frame ──

  update(dt: number): void {
    if (!this.on) return;
    this.moveFerries(dt);
    this.bumpBoats();
    this.rideFrame();
    this.platformFrame();
    this.travelFrame(dt);
  }

  private moveFerries(dt: number): void {
    const g = this.game, m = this.clock(), cam = g.camera.position, t = g.time;
    for (const f of this.ferries) {
      const p = ferryPose(m, f.i, f.pose);
      const x = p.x, z = p.z, sx = Math.sin(p.h), cz = Math.cos(p.h);
      const river = z < -860;
      const y = river ? waterLevelAt(x, z) : seaY(x, z);
      // Attitude: the swell's slope under the hull, the bow lifting with speed, a lean into the turn, a slow bob at rest.
      let pitch = 0.012 * Math.sin(t * 0.9 + f.i) + 0.05 * Math.min(1, p.v / 25), roll = 0.01 * Math.sin(t * 0.7 + f.i * 2);
      if (!river) {
        seaSlope(x, z, this.sl);
        pitch += Math.atan(this.sl.x * sx + this.sl.z * cz) * 0.8;
        roll += Math.atan(this.sl.x * cz - this.sl.z * sx) * 0.8;
      }
      // Heading rate from the last frame's, for the lean.
      const dh = dt > 0 ? Math.atan2(Math.sin(p.h - f.h), Math.cos(p.h - f.h)) / dt : 0;
      const jump = Math.hypot(x - f.x, z - f.z) > 60 + p.v * Math.max(dt, 0.05) * 2 || !f.seen;
      roll += Math.max(-0.14, Math.min(0.14, -dh * p.v * 0.012));
      const k = jump ? 1 : Math.min(1, dt * 6);
      f.pitch += (pitch - f.pitch) * k; f.roll += (roll - f.roll) * k;
      f.vx = sx * p.v; f.vz = cz * p.v;
      f.x = x; f.y = y; f.z = z; f.h = p.h;
      f.lastX = x; f.lastZ = z; f.seen = true;
      const near = Math.hypot(x - cam.x, z - cam.z) < 1400;
      f.group.visible = near;
      f.group.position.set(x, y, z);
      f.group.rotation.set(-f.pitch, p.h, f.roll, 'YXZ');
      const hl = f.hull;
      if (hl) {
        if (jump) hl.wake.cut();
        g.player.boats.ghostPose(hl, x, y, z, p.h, f.pitch, f.roll, jump ? 0 : dt);
        hl.vx = f.vx; hl.vz = f.vz; hl.wet = 1;
        hl.plane = Math.min(1, p.v / 30);
      }
    }
  }

  /** The ferry as a solid for the player's boats: pushed off the hull, bounced a little, never stopped dead. */
  private bumpBoats(): void {
    const boats = this.game.player.boats.list;
    for (const b of boats) {
      if (b.driver === null && Math.hypot(b.vx, b.vz) < 0.2) continue;
      for (const f of this.ferries) {
        if (!f.group.visible || Math.abs(b.y - f.y) > 4 || Math.hypot(b.x - f.x, b.z - f.z) > 16) continue;
        const sh = Math.sin(f.h), ch = Math.cos(f.h);
        for (const end of [1, -1]) {
          const along = end * (b.hl - b.hw * 0.8), px = b.x + Math.sin(b.h) * along, pz = b.z + Math.cos(b.h) * along;
          const dx = px - f.x, dz = pz - f.z;
          const al = dx * sh + dz * ch, ac = dx * ch - dz * sh, r = b.hw * 0.9;
          const ox = FERRY_BEAM / 2 + r - Math.abs(ac), oz = FERRY_LEN / 2 + r - Math.abs(al);
          if (ox <= 0 || oz <= 0) continue;
          // Out along the shallower overlap, in the ferry's frame, then back to the world's.
          let nl = 0, nc = 0, pen = 0;
          if (ox < oz) { nc = Math.sign(ac) || 1; pen = ox; } else { nl = Math.sign(al) || 1; pen = oz; }
          const nx = nl * sh + nc * ch, nz = nl * ch - nc * sh;
          b.x += nx * pen; b.z += nz * pen;
          const into = (b.vx - f.vx) * nx + (b.vz - f.vz) * nz;
          if (into < 0) {
            const j = Math.min(9, -into * 1.35);
            b.vx += nx * j; b.vz += nz * j;
            if (this.game.time - (this.lastBump) > 0.4) { this.lastBump = this.game.time; this.stats.bumps++; if (b.driver === 'player') this.game.cam.shake(Math.min(0.4, -into / 30)); }
          }
        }
      }
    }
  }
  private lastBump = -9;

  /** Which landing she stands on, if any. */
  private where(x: number, z: number, y: number): number {
    for (let i = 0; i < DOCKS.length; i++) {
      const d = DOCKS[i], zn = d.zone;
      if (x > zn.x0 && x < zn.x1 && z > zn.z0 && z < zn.z1 && Math.abs(y - d.ey) < 2.6) return i;
    }
    return -1;
  }

  /** The ferry standing at landing d with time to board, or -1. */
  private standing(d: number): number {
    for (const f of this.ferries) if (f.pose.state === 0 && f.pose.dock === d && f.pose.left / this.rate() > 2) return f.i;
    return -1;
  }

  private platformFrame(): void {
    const g = this.game, p = g.player, h = g.hud;
    const can = g.state === 'play' && !this.rider && !p.vehicle && !p.riding && p.health > 0 && !p.goingTo && !p.swimming && this.phase === 0 && this.open;
    this.zone = can ? this.where(p.person.x, p.person.z, p.person.y) : -1;
    const z = this.zone;
    if (z < 0) { if (this.prompting) { h.prompt(null); this.prompting = false; this.promptKey = ''; } return; }
    const d = DOCKS[z], fi = this.standing(z);
    let text: string;
    if (fi >= 0) {
      const f = this.ferries[fi];
      text = `[F] Board the Calamity Shuttle to ${DOCKS[1 - z].name}, ${kid.on ? 'free' : money(FARE)}. Leaves in ${Math.ceil(f.pose.left / this.rate())} s`;
    } else {
      if (this.etaFor !== z || g.time - this.etaAt > 0.5 || g.time < this.etaAt) { this.etaFor = z; this.etaAt = g.time; this.etaStr = this.etaText(z); }
      text = `${d.name}. ${this.etaStr}`;
    }
    if (text !== this.promptKey) { h.prompt(text); this.promptKey = text; }
    this.prompting = true;
    if (fi >= 0 && g.input.hit('enter')) { g.input.eat('enter'); this.board(z, fi); }
  }

  // ── Boarding, riding and getting off ──

  /** Where seat `seat` of ferry id (FERRY_RIDE_BASE + i) is now, and the way it faces; null while this screen has no such ferry. */
  seatOf(id: number, seat: number, out: { x: number; y: number; z: number }): { h: number } | null {
    const f = this.ferries[id - FERRY_RIDE_BASE], s = FERRY_SEATS[seat];
    if (!f || !s) return null;
    EUL.set(-f.pitch, f.h, f.roll, 'YXZ');
    VEC.set(s[0], HIPS, s[1]).applyEuler(EUL);
    out.x = f.x + VEC.x; out.y = f.y + VEC.y; out.z = f.z + VEC.z;
    return { h: f.h };
  }
  private taken(id: number): Set<number> {
    const s = new Set<number>(), net = this.game.net;
    if (net) for (const o of net.remotes.values()) if (o.mode === PlayerMode.Passenger && o.rideOf === 0 && o.rideBus === id) s.add(o.rideSeat);
    return s;
  }

  private board(d: number, fi: number): void {
    const g = this.game, p = g.player, id = FERRY_RIDE_BASE + fi, used = this.taken(id);
    let best = -1, bd = 1e9;
    for (let i = 0; i < FERRY_SEATS.length; i++) {
      if (used.has(i) || !this.seatOf(id, i, this.at)) continue;
      const dd = Math.hypot(this.at.x - p.person.x, this.at.z - p.person.z);
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best < 0) { this.stats.refusedFull++; g.hud.toast('The Calamity Shuttle is full. Standing is not a form of seating.', 3); return; }
    const fare = kid.on ? 0 : FARE;
    if (fare > p.money) { this.stats.refusedMoney++; g.hud.toast(`Fare ${money(FARE)}. You have ${money(p.money)}. The deckhand has seen this before.`, 4); return; }
    p.money -= fare; this.stats.paid += fare;
    this.rider = { ferry: fi, seat: best, id, from: d };
    this.seatNow();
    p.ride(this.seat as unknown as Vehicle);
    this.stats.boards++;
    g.hud.prompt(null); this.prompting = false;
    g.hud.toast(fare === 0 ? 'Boarded the Calamity Shuttle. Kid mode rides free.' : `Boarded the Calamity Shuttle. Fare ${money(fare)}, no change given.`, 4);
  }

  private seatNow(): boolean {
    const R = this.rider, f = R ? this.ferries[R.ferry] : null;
    if (!R || !f || !this.seatOf(R.id, R.seat, this.at)) return false;
    const S = this.seat;
    S.x = this.at.x; S.y = this.at.y; S.z = this.at.z; S.h = f.h; S.pitch = f.pitch; S.roll = f.roll; S.vx = f.vx; S.vz = f.vz;
    return true;
  }

  private canAlight(): boolean {
    const R = this.rider, f = R ? this.ferries[R.ferry] : null;
    return !f || (f.pose.state === 0 && f.pose.dock >= 0);
  }

  private rideFrame(): void {
    const R = this.rider, g = this.game, p = g.player;
    if (!R) { this.showHud(null); return; }
    const f = this.ferries[R.ferry];
    if (!p.riding || p.riding !== (this.seat as unknown as Vehicle) || !f || !this.seatNow()) {
      this.lost = `${!p.riding ? 'not riding' : p.riding !== (this.seat as unknown as Vehicle) ? 'riding another' : 'no ferry'}`;
      this.rider = null; this.stats.exits++;
      if (p.riding === (this.seat as unknown as Vehicle)) p.exit(true);
      this.showHud(null);
      return;
    }
    const per = p.person, S = this.seat;
    per.x = S.x; per.y = S.y; per.z = S.z; per.h = S.h; per.pose = 'sit'; per.bench = true; per.speed = 0; per.visible = true;
    const moving = !this.canAlight(), pz = f.pose;
    // Space: over the side (the water, the swimming rules and the lifeguard do the rest).
    if (g.input.hit('jump')) { g.input.eat('jump'); this.jumpOff(); return; }
    if (g.input.hit('enter') && moving && g.time - this.lastNag > 1.2) {
      this.lastNag = g.time;
      const to = DOCKS[pz.dir > 0 ? 1 : 0];
      g.hud.toast(`The deckhand will not stop for you. Next: ${to.name}, ${mmss(pz.left / this.rate())}.`, 3);
    }
    let line: string;
    if (!moving) line = `At ${DOCKS[Math.max(0, pz.dock)].name}. Press F to get off.`;
    else line = `Next landing: ${DOCKS[pz.dir > 0 ? 1 : 0].name} in ${mmss(pz.left / this.rate())}. F at a landing to get off. Space jumps over the side.`;
    this.showHud(`<b style="color:#1d5566">&#9632;</b> <b>THE CALAMITY SHUTTLE</b><br><span>${line}</span>`, line);
  }

  private showHud(html: string | null, text = ''): void {
    const d = this.hud;
    this.hudText = html === null ? '' : `Calamity Shuttle | ${text}`;
    if (!d) return;
    if (html === null) { if (d.style.display !== 'none') d.style.display = 'none'; return; }
    if (d.dataset.t !== html) { d.innerHTML = html; d.dataset.t = html; }
    d.style.display = this.game.state === 'play' && !this.game.photo?.open ? 'block' : 'none';
  }
  hudLine(): string { return this.hudText; }

  /** Where getting off puts her: the landing's deck (at a dock), or over the side, a few strides out from the hull. */
  private prepExit(over: boolean): void {
    const R = this.rider, f = R ? this.ferries[R.ferry] : null;
    if (!R || !f) return;
    const S = this.seat;
    if (!over && f.pose.dock >= 0) {
      const d = DOCKS[f.pose.dock];
      S.ex = d.ex; S.ez = d.ez; S.x = d.ex; S.z = d.ez; S.y = d.ey + 0.45; S.vx = S.vz = 0;
    } else {
      const side = FERRY_SEATS[R.seat][0] >= 0 ? 1 : -1, o = FERRY_BEAM / 2 + 2.4;
      S.ex = f.x + Math.cos(f.h) * o * side; S.ez = f.z - Math.sin(f.h) * o * side;
      S.x = S.ex; S.z = S.ez; S.vx = S.vz = 0;
    }
  }

  private jumpOff(): void {
    const p = this.game.player;
    if (!this.rider) return;
    this.prepExit(true);
    this.rider = null; this.stats.exits++; this.stats.jumps++;
    if (p.riding) p.exit(true);
    this.showHud(null);
    this.game.hud.toast('Man overboard. Swim for it, or wave.', 3);
  }

  // ── Fast travel ──

  status(to: number): { ok: boolean; fare: number; why: string; text: string } {
    const g = this.game, p = g.player, fare = kid.on ? 0 : FARE;
    const no = (why: string): { ok: boolean; fare: number; why: string; text: string } => ({ ok: false, fare, why, text: why });
    if (!this.on) return no('There is no ferry here.');
    if (this.phase) return no('A trip is already in progress.');
    if (g.state !== 'play' && g.state !== 'paused') return no('Not now.');
    if (!(p.health > 0)) return no('The Calamity Shuttle does not carry the deceased.');
    if (p.heat > 0) return no('The Calamity Shuttle does not carry fugitives.');
    if (g.todo.busy !== null) return no('Not during a mission, job or race.');
    if (this.zone < 0) return no('Walk out onto a ferry landing to take the ferry.');
    if (to === this.zone) return no('You are already at that landing.');
    if (!this.open) return no('The ferry is not running: the town is not open down to the river yet.');
    if (fare > p.money) return no(`Fare ${money(fare)}: you have ${money(p.money)}.`);
    return { ok: true, fare, why: '', text: fare === 0 ? `Take the ferry to ${DOCKS[to].name}, free` : `Take the ferry to ${DOCKS[to].name}, ${money(fare)}` };
  }

  travel(to: number): string {
    const s = this.status(to), g = this.game;
    if (!s.ok) { g.hud.toast(s.why, 4); return s.why; }
    this.dest = to; this.phase = 1; this.t = 0;
    this.last = { from: DOCKS[this.zone].name, to: DOCKS[to].name, fare: s.fare };
    g.input.setEnabled(false);
    if (g.state === 'paused') { g.setPaused(false); if (!g.input.touch) g.input.lock(); g.input.setEnabled(false); }
    const c = this.card;
    if (c) {
      c.innerHTML = `<div><div style="letter-spacing:.2em;font-size:12px;opacity:.7">THE CALAMITY SHUTTLE</div><div style="font:800 38px 'Big Shoulders Display',sans-serif;margin:6px 0">${DOCKS[to].sign}</div><div>${this.last.from} &rarr; ${this.last.to}</div><div style="opacity:.7;margin-top:6px">${s.fare === 0 ? 'Fare waived (kid-friendly mode)' : 'Fare ' + money(s.fare)}. The deckhand has pocketed it.</div></div>`;
      c.style.display = 'flex';
    }
    return '';
  }

  /** Set her down on landing d's deck (a solid box, which teleport() alone would not find: it would leave her in the water beside it), facing h. */
  placeOn(d: number, h = 0): void {
    const k = DOCKS[d], p = this.game.player;
    p.teleport(k.ex, k.ez, h);
    p.person.y = k.ey + 0.02; p.swimming = false;
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
        const d = DOCKS[this.dest], fare = kid.on ? 0 : FARE;
        p.money -= fare; this.stats.travelPaid += fare; this.stats.travels++;
        // Onto the landing's deck, facing the water where the ferry lies.
        const toWater = Math.atan2(d.x - d.ex, d.z - d.ez);
        this.placeOn(this.dest, toWater);
        g.cam.yaw = toWater; g.cam.snap();
        g.warmup.flush();
      }
    } else if (this.phase === 2) {
      this.fade(1);
      if (this.t >= HOLD) { this.phase = 3; this.t = 0; g.hud.toast(`${this.last?.to ?? 'The landing'}. Mind the gap.`, 4); }
    } else {
      this.fade(Math.max(0, 1 - this.t / IN));
      if (this.t >= IN) { this.phase = 0; if (this.card) this.card.style.display = 'none'; g.input.setEnabled(true); }
    }
  }

  // ── The big map ──

  drawChart(c: CanvasRenderingContext2D, X: (x: number) => number, Z: (z: number) => number, k: number, w: number, h: number, ink: string, bone: string): void {
    if (!this.on) return;
    const P = ferryPlan(), a = P.ab, n = a.n, step = Math.max(2, Math.round((k < 0.12 ? 60 : k < 0.3 ? 30 : 14) / a.ds));
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath();
    for (let i = 0; i < n; i += step) { const x = X(a.x[i]), y = Z(a.z[i]); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); }
    c.lineTo(X(a.x[n - 1]), Z(a.z[n - 1]));
    c.strokeStyle = '#1d5566'; c.lineWidth = 2.6; c.globalAlpha = 0.85; c.setLineDash([7, 5]); c.stroke();
    c.setLineDash([]); c.globalAlpha = 1;
    const R = Math.max(4, Math.min(7, 3 + k * 4));
    for (const d of DOCKS) {
      const x = X(d.x), y = Z(d.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fillStyle = bone; c.fill(); c.strokeStyle = ink; c.lineWidth = 2; c.stroke();
      c.fillStyle = '#1d5566'; c.beginPath(); c.arc(x, y, R * 0.5, 0, Math.PI * 2); c.fill();
      if (k >= 0.2) {
        c.font = '700 11px "Barlow Semi Condensed", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 3; c.strokeStyle = 'rgba(242,232,207,0.9)'; c.strokeText(d.name, x, y + R + 9); c.fillStyle = ink; c.fillText(d.name, x, y + R + 9);
      }
    }
    for (const f of this.ferries) {
      const x = X(f.x), y = Z(f.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      c.save(); c.translate(x, y); c.rotate(-f.h + Math.PI);
      c.fillStyle = '#1d5566'; c.strokeStyle = ink; c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, 8); c.lineTo(5, 2); c.lineTo(5, -7); c.lineTo(-5, -7); c.lineTo(-5, 2); c.closePath(); c.fill(); c.stroke();
      c.restore();
      c.fillStyle = '#fff'; c.font = '800 8px "Big Shoulders Display", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('CS', x, y - 1);
    }
    c.restore();
  }

  /** For the tests (window.__game.game.ferry.info()). */
  info(): Record<string, unknown> {
    const P = this.on ? ferryPlan() : null;
    return {
      on: this.on, open: this.on ? this.open : false, zone: this.zone, phase: this.phase, rider: this.rider, hud: this.hudText, lost: this.lost, stats: { ...this.stats },
      plan: P ? { vmax: P.vmax, dwell: +P.dwell.toFixed(1), abT: +P.ab.total.toFixed(1), baT: +P.ba.total.toFixed(1), abLen: Math.round(P.ab.len), baLen: Math.round(P.ba.len) } : null,
      ferries: this.ferries.map((f) => ({ i: f.i, x: +f.x.toFixed(1), z: +f.z.toFixed(1), y: +f.y.toFixed(2), h: +f.h.toFixed(3), state: f.pose.state, dock: f.pose.dock, dir: f.pose.dir, left: +f.pose.left.toFixed(1), v: +f.pose.v.toFixed(1) })),
      eta: DOCKS.map((_, i) => this.etaText(i)),
    };
  }
}
