// Fun queue 2, item 7: the Harbor Line. The service: three named loops (sim/busRoutes.ts), two buses on each, run by the
// shared signal clock so every screen shows the same bus in the same place with no messages.
//
// A bus is a pose computed from the clock. Only buses near the camera are given a body (a solid ghost car, the same kind
// the other players' cars are, placed every frame); the rest cost nothing until they are asked about. Traffic gives way
// to them (Traffic.transit), pedestrians dodge them, and a ghost never knocks anybody down.
//
// Riding: walk to a shelter, the prompt says which bus is next and when; press F while one stands there ($2, free in
// kid mode) and sit in a seat. F again only at a stop. In a town the rider says so in the ordinary state frame (mode
// Passenger, `vehicle` 0 = a bus, `color` = bus id << 8 | seat; no new event, no new field), and every screen puts
// them in that seat of that bus from the clock (net/ride.ts seatOthers -> seatOf here).

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { LINES, buildRoute, lapTime, poseAt, standing, untilStop, type Pose, type Route, type Stop } from './busRoutes';
import { STREETS_NEW } from '../world/streets';
import { signalState } from '../world/signals';
import { seatSpot } from '../ent/occupants';
import { PASSENGER_SEATS } from '../ent/vehicleSpecs';
import { PlayerMode } from '../net/protocol';
import { kid } from '../core/kid';
import { money } from '../core/util';
import { Ambient } from './ambient';
import { buildStations, type Station } from '../world/busStops';

export const FARE = 2;
/** A bus nearer than this to the camera has a body; farther than FAR it loses it. */
const NEAR = 260, FAR = 320;
/** Reach of a shelter's prompt, meters. */
const REACH = 11;

interface Live { v: Vehicle; r: number; k: number; lastSpeed: number }

export interface Rider { r: number; k: number; seat: number; id: number; from: string }

const mmss = (s: number): string => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hexNum = (c: string): number => parseInt(c.slice(1), 16);

export class BusService {
  readonly routes: Route[] = [];
  readonly stations: Station[] = [];
  /** The live bodies, for traffic (it gives way) and the people (they dodge). Same array for ever. */
  readonly vehicles: Vehicle[] = [];
  /** Is it running: new streets, and the line's streets open. */
  readonly open: boolean[] = [];
  rider: Rider | null = null;
  readonly stats = { boards: 0, exits: 0, refusedFull: 0, refusedMoney: 0, bodies: 0, paid: 0 };
  private readonly live = new Map<number, Live>();
  private readonly pose: Pose = { x: 0, y: 0, z: 0, h: 0, pitch: 0, steer: 0, speed: 0, s: 0, tau: 0 };
  private readonly at = { x: 0, y: 0, z: 0 };
  private checkAt = -9;
  private prompting = false;
  private promptKey = '';
  private lastNag = -9;
  private claimed = false;
  private readonly hud: HTMLDivElement | null = null;
  private hudText = '';
  /** Test hook: added to the shared clock (seconds), so a test can stand at a stop at a chosen moment. */
  shift = 0;

  constructor(private readonly game: Game) {
    if (!STREETS_NEW || !game.plan.streets) return;
    const G = game.plan.streets;
    const amb = game.systems.find((s) => s instanceof Ambient) as Ambient | undefined;
    const rails = amb?.traffic.rails ?? null;
    const light = (e: import('../world/plan').RoadEdge, nodeId: number, t: number): 'green' | 'yellow' | 'red' =>
      e.id < G.isle.edges || !rails ? signalState(G.nodes[nodeId], e.horiz, t) : rails.lightAt(e, nodeId, t);
    for (const def of LINES) {
      const r = buildRoute(G, def, light);
      this.routes.push(r);
      this.open.push(r.ok);
      if (!r.ok) console.warn(`bus line ${def.n}: ${r.why}`);
    }
    if (amb) amb.traffic.transit = this.vehicles;
    this.stations = buildStations(game, this.routes);
    try {
      const d = document.createElement('div');
      d.id = 'bus-hud';
      d.style.cssText = 'position:fixed;left:50%;top:92px;transform:translateX(-50%);z-index:30;display:none;max-width:min(560px,92vw);padding:8px 14px 9px;background:rgba(242,232,207,0.94);color:#14213d;border:2px solid #14213d;border-radius:4px;font:600 13px/1.35 "IBM Plex Mono",monospace;box-shadow:0 3px 0 rgba(20,33,61,0.35);pointer-events:none;text-align:center';
      document.body.appendChild(d);
      this.hud = d;
      game.on('pause', (e) => { d.style.visibility = e.on ? 'hidden' : 'visible'; });
    } catch { /* no document */ }
    game.player.rideHold = () => (this.rider ? this.stoppedAt() !== null : true);
  }

  get on(): boolean { return this.routes.length > 0; }
  get T(): number { return this.game.signalTime + this.shift; }

  /** Bus id as sent on the wire: line * 4 + bus + 1. */
  idOf(r: number, k: number): number { return r * 4 + k + 1; }
  /** The body of bus (line r, bus k) if it has one. */
  bodyOf(r: number, k: number): Vehicle | null { return this.live.get(this.idOf(r, k))?.v ?? null; }

  /** Where seat `seat` of bus `id` is on this screen, and the bus that holds it (null: no body here, so nobody to draw). */
  seatOf(id: number, seat: number, out: { x: number; y: number; z: number }): Vehicle | null {
    const l = this.live.get(id);
    if (!l || !seatSpot(l.v, seat, out)) return null;
    return l.v;
  }

  /** Is this bus's seat taken (by another player, as this screen knows it)? */
  private taken(id: number): Set<number> {
    const s = new Set<number>();
    const net = this.game.net;
    if (net) for (const o of net.remotes.values()) if (o.mode === PlayerMode.Passenger && o.rideOf === 0 && o.rideBus === id) s.add(o.rideSeat);
    return s;
  }

  // ── The stop the rider is at, and the next one ──

  private stoppedAt(): Stop | null {
    const R = this.rider;
    if (!R) return null;
    const r = this.routes[R.r], tau = lapTime(r, R.k, this.T);
    for (let j = 0; j < r.stops.length; j++) if (standing(r, j, tau) >= 0) return r.stops[j];
    return null;
  }

  private nextStop(r: Route, k: number): { st: Stop; eta: number } {
    const tau = lapTime(r, k, this.T);
    for (let j = 1; j < r.stops.length; j++) if (r.stops[j].arr > tau + 0.01) return { st: r.stops[j], eta: r.stops[j].arr - tau };
    return { st: r.stops[0], eta: r.stops[0].arr - tau };
  }

  /** The riding HUD's text, for the tests and the pictures. */
  hudLine(): string { return this.hudText; }

  // ── Frame ──

  update(dt: number): void {
    if (!this.routes.length) return;
    const g = this.game, T = this.T, p = g.player;
    // Lines open and close with the bridge and the stages (a second's check is plenty).
    if (g.time - this.checkAt > 1 || g.time < this.checkAt) {
      this.checkAt = g.time;
      const G = g.plan.streets!;
      for (let i = 0; i < this.routes.length; i++) {
        const r = this.routes[i];
        this.open[i] = r.ok && r.edges.every((id) => !G.edges[id].closed);
      }
    }
    const eye = g.view ? g.view.pos : g.camera.position;
    const px = p.person.x, pz = p.person.z;
    const pose = this.pose;
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i];
      for (let k = 0; k < r.def.buses; k++) {
        const id = this.idOf(i, k);
        let l = this.live.get(id);
        const mine = this.rider !== null && this.rider.id === id;
        if (!this.open[i]) { if (l) this.drop(id, l); continue; }
        poseAt(r, lapTime(r, k, T), pose);
        const dx = pose.x - eye.x, dz = pose.z - eye.z, d2 = dx * dx + dz * dz;
        const qx = pose.x - px, qz = pose.z - pz, q2 = qx * qx + qz * qz;
        const near = Math.min(d2, q2);
        if (!l) {
          if (near > NEAR * NEAR && !mine) continue;
          const v = g.vehicles.ghost('bus', hexNum(r.def.color));
          l = { v, r: i, k, lastSpeed: pose.speed };
          this.live.set(id, l); this.vehicles.push(v);
        } else if (near > FAR * FAR && !mine) { this.drop(id, l); continue; }
        const braking = pose.speed < 0.15 || pose.speed < l.lastSpeed - 0.02;
        l.lastSpeed = pose.speed;
        g.vehicles.ghostPose(l.v, pose.x, pose.y, pose.z, pose.h, pose.pitch, 0, pose.steer, pose.speed, braking, false, dt);
      }
    }
    this.stats.bodies = this.live.size;
    this.rideFrame();
    this.stopFrame();
  }

  private drop(id: number, l: Live): void {
    this.game.vehicles.unghost(l.v);
    const i = this.vehicles.indexOf(l.v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.live.delete(id);
    if (this.rider && this.rider.id === id) this.leave(true);
  }

  // ── Riding ──

  private rideFrame(): void {
    const R = this.rider, g = this.game, p = g.player;
    if (!R) { this.showHud(null); return; }
    const l = this.live.get(R.id);
    if (!p.riding || !l) {
      // Got out by another way (a teleport, a reset, a hospital) or the bus went away: she is out already.
      this.rider = null;
      this.stats.exits++;
      if (p.riding) p.exit(true);
      this.showHud(null);
      return;
    }
    if (p.riding !== l.v) p.ride(l.v);
    if (seatSpot(l.v, R.seat, this.at)) { const per = p.person; per.x = this.at.x; per.y = this.at.y; per.z = this.at.z; per.h = l.v.h; per.pose = 'sit'; per.bench = true; per.speed = 0; }
    const r = this.routes[R.r], st = this.stoppedAt();
    if (g.input.hit('enter') && !st && g.time - this.lastNag > 1.2) {
      this.lastNag = g.time;
      const n = this.nextStop(r, R.k);
      g.hud.toast(`The doors open at stops only. Next: ${n.st.name}, ${mmss(n.eta)}.`, 3);
    }
    let line: string;
    if (st) line = `At ${st.name}. Press F to get off.`;
    else { const n = this.nextStop(r, R.k); line = `Next stop: ${n.st.name} in ${mmss(n.eta)}. Press F at a stop to get off.`; }
    this.showHud(`<b style="color:${r.def.color}">&#9632;</b> <b>${r.def.name.toUpperCase()}</b><br><span>${line}</span>`, line);
  }

  private showHud(html: string | null, text = ''): void {
    const d = this.hud;
    this.hudText = html === null ? '' : `${this.routes[this.rider?.r ?? 0].def.name} | ${text}`;
    if (!d) return;
    if (html === null) { if (d.style.display !== 'none') d.style.display = 'none'; return; }
    if (d.dataset.t !== html) { d.innerHTML = html; d.dataset.t = html; }
    // (Not over the pause menu or a photograph.)
    d.style.display = this.game.state === 'play' && !this.game.photo?.open ? 'block' : 'none';
  }

  /** Step off. `safe`: beside the bus at walking pace. */
  private leave(safe: boolean): void {
    const R = this.rider, p = this.game.player;
    this.rider = null;
    if (!R) return;
    if (p.riding) p.exit(safe);
    this.stats.exits++;
  }

  private board(r: number, k: number, st: Stop): void {
    const g = this.game, p = g.player, l = this.live.get(this.idOf(r, k));
    if (!l) return;
    const id = this.idOf(r, k), used = this.taken(id), n = PASSENGER_SEATS.bus.length;
    let seat = -1, bd = 1e9;
    for (let i = 0; i < n; i++) {
      if (used.has(i) || !seatSpot(l.v, i, this.at)) continue;
      const d = Math.hypot(this.at.x - p.person.x, this.at.z - p.person.z);
      if (d < bd) { bd = d; seat = i; }
    }
    if (seat < 0) { this.stats.refusedFull++; g.hud.toast('The bus is full. Standing room is not offered on this line.', 3); return; }
    const fare = kid.on ? 0 : FARE;
    if (fare > p.money) { this.stats.refusedMoney++; g.hud.toast(`Fare ${money(FARE)}. You have ${money(p.money)}. The driver has seen this before.`, 4); return; }
    p.money -= fare; this.stats.paid += fare;
    p.ride(l.v);
    this.rider = { r, k, seat, id, from: st.name };
    this.stats.boards++;
    g.hud.prompt(null); this.prompting = false;
    if (this.claimed) { p.rideNear = null; this.claimed = false; }
    g.hud.toast(fare === 0 ? `Boarded ${this.routes[r].def.name}. Kid mode rides free.` : `Boarded ${this.routes[r].def.name}. Fare ${money(fare)}, no change given.`, 4);
  }

  // ── The stop prompt ──

  private stopFrame(): void {
    const g = this.game, p = g.player, h = g.hud;
    const can = g.state === 'play' && !this.rider && !p.vehicle && !p.riding && p.health > 0 && !p.goingTo && !p.swimming;
    let best: Station | null = null, bd = REACH * REACH;
    if (can) for (const s of this.stations) {
      const dx = s.x - p.person.x, dz = s.z - p.person.z, d = dx * dx + dz * dz;
      if (d < bd && Math.abs(s.y - p.person.y) < 4) { bd = d; best = s; }
    }
    if (!best) { if (this.prompting) { h.prompt(null); this.prompting = false; this.promptKey = ''; } if (this.claimed) { p.rideNear = null; this.claimed = false; } return; }
    const T = this.T;
    let boardable: { r: number; k: number; j: number; left: number } | null = null;
    const parts: { eta: number; text: string }[] = [];
    for (const it of best.items) {
      if (!this.open[it.r]) continue;
      const r = this.routes[it.r];
      let soon = 1e9, k0 = 0;
      for (let k = 0; k < r.def.buses; k++) {
        const tau = lapTime(r, k, T), left = standing(r, it.j, tau);
        if (left >= 0) {
          const body = this.live.get(this.idOf(it.r, k));
          if (body && Math.hypot(body.v.x - best.x, body.v.z - best.z) < 14 && (!boardable || left > boardable.left)) boardable = { r: it.r, k, j: it.j, left };
        }
        const e = untilStop(r, k, it.j, T);
        if (e < soon) { soon = e; k0 = k; }
      }
      void k0;
      parts.push({ eta: soon, text: soon <= 0 ? `${r.def.name} is here` : `${r.def.name} in ${mmss(soon)}` });
    }
    parts.sort((a, b) => a.eta - b.eta);
    // F belongs to the bus while one stands here (not to a car parked beside the stop: Player reads rideNear for that).
    if (boardable) { const bv = this.live.get(this.idOf(boardable.r, boardable.k)); if (bv) { p.rideNear = bv.v; this.claimed = true; } } else if (this.claimed) { p.rideNear = null; this.claimed = false; }
    let text: string;
    if (boardable) {
      const r = this.routes[boardable.r];
      text = `[F] Board ${r.def.name}, ${kid.on ? 'free' : money(FARE)} (leaves in ${Math.ceil(boardable.left)} s)`;
    } else if (!parts.length) text = `${best.name}. Service suspended: the street is not finished.`;
    else text = `${best.name}. ${parts.slice(0, 2).map((x) => x.text).join(' · ')}`;
    if (text !== this.promptKey) { h.prompt(text); this.promptKey = text; }
    this.prompting = true;
    if (boardable && g.input.hit('enter')) { g.input.eat('enter'); this.board(boardable.r, boardable.k, this.routes[boardable.r].stops[boardable.j]); }
  }

  // ── The big map ──

  /** Lines, stops, buses and the legend on the chart (ui/menu.ts drawMap). X and Z turn world meters into screen pixels. */
  drawChart(c: CanvasRenderingContext2D, X: (x: number) => number, Z: (z: number) => number, k: number, w: number, h: number, ink: string, bone: string): void {
    if (!this.routes.length) return;
    const T = this.T, step = k < 0.12 ? 8 : k < 0.3 ? 4 : 2;
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round';
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i];
      if (!this.open[i]) continue;
      const off = (i - 1) * 2.4;
      const trace = (): void => {
        c.beginPath();
        for (let q = 0; q <= r.N; q += step) {
          const a = Math.max(0, q - step), b = Math.min(r.N, q + step), nx = Z(r.pz[b]) - Z(r.pz[a]), nz = -(X(r.px[b]) - X(r.px[a])), l = Math.hypot(nx, nz) || 1;
          const x = X(r.px[q]) + nx / l * off, y = Z(r.pz[q]) + nz / l * off;
          if (q === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.closePath();
      };
      trace(); c.strokeStyle = ink; c.lineWidth = 6; c.globalAlpha = 0.85; c.stroke();
      trace(); c.strokeStyle = r.def.color; c.lineWidth = 3.4; c.globalAlpha = 1; c.stroke();
    }
    const R = Math.max(4, Math.min(7, 3 + k * 4));
    for (const s of this.stations) {
      const x = X(s.x), y = Z(s.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fillStyle = bone; c.fill(); c.strokeStyle = ink; c.lineWidth = 2; c.stroke();
      c.beginPath(); c.arc(x, y, R * 0.45, 0, Math.PI * 2); c.fillStyle = this.routes[s.items[0].r].def.color; c.fill();
      if (k >= 0.5) {
        c.font = '700 11px "Barlow Semi Condensed", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineWidth = 3; c.strokeStyle = 'rgba(242,232,207,0.9)'; c.strokeText(s.name, x, y + R + 9); c.fillStyle = ink; c.fillText(s.name, x, y + R + 9);
      }
    }
    const pose = this.pose;
    for (let i = 0; i < this.routes.length; i++) {
      if (!this.open[i]) continue;
      const r = this.routes[i];
      for (let b = 0; b < r.def.buses; b++) {
        poseAt(r, lapTime(r, b, T), pose);
        const x = X(pose.x), y = Z(pose.z);
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
        c.fillStyle = r.def.color; c.strokeStyle = ink; c.lineWidth = 2;
        c.beginPath(); c.roundRect(x - 8, y - 6, 16, 12, 3); c.fill(); c.stroke();
        c.fillStyle = '#fff'; c.font = '800 10px "Big Shoulders Display", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(r.def.n), x, y + 0.5);
      }
    }
    // The legend.
    if (w >= 520) {
      const rows = this.routes.map((r, i) => ({ r, i })).filter((q) => q.r.ok);
      const lh = 17, bw = 262, bh = 26 + rows.length * lh, bx = 10, by = h - 44 - bh - 8;
      c.fillStyle = bone; c.strokeStyle = ink; c.lineWidth = 2;
      c.fillRect(bx, by, bw, bh); c.strokeRect(bx, by, bw, bh);
      c.fillStyle = ink; c.textAlign = 'left'; c.textBaseline = 'middle'; c.font = '800 12px "Big Shoulders Display", sans-serif';
      c.fillText('THE HARBOR LINE  ·  $2, NO CHANGE GIVEN', bx + 8, by + 12);
      c.font = '600 11px "IBM Plex Mono", monospace';
      rows.forEach(({ r, i }, n) => {
        const y = by + 26 + n * lh;
        c.fillStyle = this.open[i] ? r.def.color : '#999'; c.fillRect(bx + 8, y - 3, 22, 6); c.strokeStyle = ink; c.lineWidth = 1; c.strokeRect(bx + 8, y - 3, 22, 6);
        c.fillStyle = ink; c.fillText(`${r.def.name.replace(/^Route /, 'R')}${this.open[i] ? '' : ' (not yet)'}`, bx + 38, y);
      });
    }
    c.restore();
  }

  /** For the tests (window.__game.game.bus.info()). */
  info(): Record<string, unknown> {
    return {
      on: this.on, open: [...this.open], stats: { ...this.stats }, bodies: this.live.size, stations: this.stations.length,
      rider: this.rider, hud: this.hudText,
      routes: this.routes.map((r) => ({ n: r.def.n, ok: r.ok, why: r.why, ...r.info, period: r.period, offs: r.offs, stops: r.stops.map((s) => ({ name: s.name, s: Math.round(s.s), arr: s.arr, dep: s.dep })) })),
    };
  }
}
