// Fun queue 2, item 24: convoys. One player leads, everybody who joins follows the leader's waypoint.
//
// START: set a waypoint (the big map, M, or the Places list), then press . (full stop) or, on the map's Places panel,
// "Share with town / lead a convoy". Everybody else in town gets a toast and a V on the radar (the leader's car) for as long
// as the convoy is open; . (or the Join button on the Places panel) joins the nearest one. A joiner's waypoint is the
// leader's, so the route line, the radar marker and the turn-by-turn are the same ones the game already has (todo.waypoint,
// game/nav.ts). The leader's waypoint IS the convoy's destination: set a new one on the map and every member's route
// follows, with a toast. Members are V on the radar and the big map, and have a teal ring on the road at their car.
// LEAVING: . again leaves (a member) or hands the lead to the next member (the leader; alone it ends the convoy). A leader
// who drops off the net hands the lead to the lowest-numbered member the same way on every screen.
// ARRIVING: the leader's browser judges it. With the leader at the destination and two or more members (the leader
// counts) close to it, after a trip of at least TRIP_M, every member close to it gets BONUS dollars, at most once every
// COOLDOWN_S seconds each (kept in this browser's storage); the convoy then disbands. A shorter hop disbands with no pay.
// Nothing travels but short Event frames (PlayerEvent.Convoy = 25, relayed unread by the service). Nothing is saved but the money.

import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { save } from './save';
import type { Markers, Pt } from './script';

export interface ConvoyWire { kind: number; leader: number; seq: number; x: number; z: number; flags: number; ids: number[] }
export interface ConvoyLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): Pt | null;
  send(m: ConvoyWire): void;
}
/** Most cars in one convoy (the frame carries this many ids). */
const CONVOY_MAX = 8;
export const CV = { Lead: 1, Join: 2, Leave: 3, Hand: 4, Arrive: 5, End: 6 } as const;
/** Flags: there is a destination; the arrival pays nothing (a short hop). */
const F_DEST = 1, F_NOPAY = 2;

/** The bonus for arriving together, dollars each. Kept modest. */
export const BONUS = 150;
/** At least this far (m, straight line) between where the leader chose the destination and the destination, to pay. */
export const TRIP_M = 300;
/** Once every this many seconds for one player. */
export const COOLDOWN_S = 240;
const ARRIVE_M = 35, NEAR_M = 50;
const LEAD_EVERY_MS = 3000, SILENCE_MS = 12000, OFFER_MS = 9000;
const STORE = 'pc.convoy.paid';

type Role = 'none' | 'lead' | 'member';
interface Offer { leader: number; dest: Pt | null; members: number[]; at: number }

export class Convoy {
  link: ConvoyLink | null = null;
  readonly stats = { led: 0, joined: 0, arrived: 0, paid: 0, sent: 0, got: 0 };

  private role: Role = 'none';
  private leader = 0;
  private members: number[] = [];
  private dest: Pt | null = null;
  private origin: Pt | null = null;
  private seq = 0;
  private lastLeadAt = 0;
  private sendAt = 0;
  private readonly offers = new Map<number, Offer>();
  private lastPaid = -1e12;
  private lastPay = 0;

  constructor(private readonly game: Game, private readonly markers: Markers) {
    try { const v = Number(localStorage.getItem(STORE)); if (Number.isFinite(v)) this.lastPaid = v; } catch { /* no storage */ }
    addEventListener('keydown', (e) => {
      if (e.code !== 'Period' || e.repeat || this.game.state !== 'play' || this.game.photo?.open) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.press();
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private get me(): number { return this.link ? this.link.me() : 0; }
  private nameOf(id: number): string { return this.link ? this.link.nameOf(id) : 'Somebody'; }
  private street(p: Pt): string { return this.game.plan.streetAt(p.x, p.z); }
  private toast(s: string, secs = 5): void { this.game.hud.toast(s, secs); }
  private send(m: Partial<ConvoyWire> & { kind: number }): void {
    if (!this.link) return;
    this.link.send({ leader: this.leader, seq: this.seq, x: this.dest ? this.dest.x : 0, z: this.dest ? this.dest.z : 0, flags: this.dest ? F_DEST : 0, ids: [], ...m });
    this.stats.sent++;
  }
  private sendLead(): void {
    if (this.role !== 'lead') return;
    this.sendAt = performance.now();
    this.send({ kind: CV.Lead, ids: this.members });
  }
  private place(id: number): Pt | null {
    if (id === this.me) { const p = this.game.player, v = p.vehicle; return v ? { x: v.x, z: v.z } : { x: p.x, z: p.z }; }
    return this.link ? this.link.posOf(id) : null;
  }
  private reset(): void { this.role = 'none'; this.leader = 0; this.members = []; this.dest = null; this.origin = null; }
  private follow(p: Pt): void { this.dest = { x: p.x, z: p.z }; this.game.todo.follow(this.dest); }

  /** True while in a convoy, leading or following. */
  get active(): boolean { return this.role !== 'none'; }
  get leading(): boolean { return this.role === 'lead'; }

  // ── What the player does ───────────────────────────────────────────────────

  /** The key and the Places buttons: join the nearest open convoy, else lead one to the waypoint; in one, leave it. */
  press(): void {
    const t = this.game.todo, link = this.link;
    if (this.role === 'lead') { this.stepDown(); return; }
    if (this.role === 'member') { this.leave(); return; }
    if (!link || !link.me()) { this.toast('A convoy needs other players in town. You are offline.', 5); return; }
    let best: Offer | null = null, bd = Infinity;
    const p = this.game.player;
    for (const o of this.offers.values()) {
      const at = link.posOf(o.leader), d = at ? Math.hypot(at.x - p.x, at.z - p.z) : 1e9;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { this.join(best); return; }
    if (!link.others().length) { this.toast('A convoy needs other players in town. Come back with friends.', 5); return; }
    if (!t.waypoint) { this.toast('Set a waypoint first (M for the map), then press . to lead a convoy there.', 6); return; }
    this.lead(t.waypoint);
  }

  /** What the button on the Places panel should say, or null when there is nothing to offer. */
  label(): string | null {
    if (this.role === 'lead') return this.members.length > 1 ? 'Hand over the convoy and leave' : 'End the convoy';
    if (this.role === 'member') return 'Leave the convoy';
    if (!this.link || !this.link.me()) return null;
    const o = [...this.offers.values()][0];
    if (o) return `Join ${this.nameOf(o.leader)}'s convoy`;
    if (this.link.others().length && this.game.todo.waypoint) return 'Share with town / lead a convoy';
    return null;
  }

  /** A line for the Places panel about the convoy in hand, or null. */
  status(): string | null {
    if (this.role === 'none') {
      const o = [...this.offers.values()][0];
      return o ? `${this.nameOf(o.leader)} is leading a convoy${o.dest ? ' to ' + this.street(o.dest) : ''}.` : null;
    }
    const names = this.members.map((id) => id === this.me ? 'you' : this.nameOf(id)).join(', ');
    return `${this.role === 'lead' ? 'You lead' : this.nameOf(this.leader) + ' leads'} a convoy of ${this.members.length}${this.dest ? ' to ' + this.street(this.dest) : ''}: ${names}.`;
  }

  /** The members, for the big map. */
  roster(): { x: number; z: number; name: string; lead: boolean; me: boolean }[] {
    const out: { x: number; z: number; name: string; lead: boolean; me: boolean }[] = [];
    if (this.role === 'none') return out;
    for (const id of this.members) { const at = this.place(id); if (at) out.push({ x: at.x, z: at.z, name: this.nameOf(id), lead: id === this.leader, me: id === this.me }); }
    return out;
  }

  private lead(w: Pt): void {
    this.role = 'lead'; this.leader = this.me; this.members = [this.me];
    this.dest = { x: w.x, z: w.z }; this.seq = 1;
    const p = this.place(this.me);
    this.origin = p ? { x: p.x, z: p.z } : null;
    this.stats.led++;
    this.sendLead();
    this.game.hud.stamp('CONVOY', `You lead a convoy to ${this.street(this.dest)} · others in town were asked to join · press . to hand over`);
  }

  private join(o: Offer): void {
    this.offers.clear();
    this.role = 'member'; this.leader = o.leader; this.members = o.members.length ? o.members.slice() : [o.leader];
    if (!this.members.includes(this.me)) this.members.push(this.me);
    this.seq = -1; this.lastLeadAt = performance.now();
    this.stats.joined++;
    this.leaderSend({ kind: CV.Join });
    if (o.dest) this.follow(o.dest);
    this.game.hud.stamp('CONVOY', `You joined ${this.nameOf(o.leader)}'s convoy${o.dest ? ' to ' + this.street(o.dest) : ''} · your route is theirs · press . to leave`);
  }

  private leaderSend(m: Partial<ConvoyWire> & { kind: number }): void { this.send({ ...m, leader: this.leader }); }

  private leave(): void {
    this.leaderSend({ kind: CV.Leave });
    this.toast('You left the convoy.', 4);
    this.reset();
  }

  /** The leader leaves: the lead goes to the next member, or the convoy ends when nobody else is in it. */
  private stepDown(): void {
    const rest = this.members.filter((x) => x !== this.me);
    if (!rest.length) { this.send({ kind: CV.End }); this.toast('You ended the convoy.', 4); this.reset(); return; }
    this.send({ kind: CV.Hand, leader: rest[0], ids: rest });
    this.toast(`You left the convoy. ${this.nameOf(rest[0])} leads it now.`, 5);
    this.reset();
  }

  // ── The network's ──────────────────────────────────────────────────────────

  got(from: number, m: ConvoyWire): void {
    this.stats.got++;
    const now = performance.now();
    const dest: Pt | null = m.flags & F_DEST ? { x: m.x, z: m.z } : null;
    if (m.kind === CV.Lead) {
      if (from !== m.leader) return;
      if (this.role === 'none') {
        const old = this.offers.get(from);
        this.offers.set(from, { leader: from, dest, members: m.ids, at: now });
        if (!old) this.toast(`${this.nameOf(from)} is leading a convoy${dest ? ' to ' + this.street(dest) : ''}. Press . (or open the map, M) to join.`, 8);
        return;
      }
      if (this.role !== 'member' || from !== this.leader) return;
      this.lastLeadAt = now;
      this.members = m.ids.length ? m.ids.slice() : this.members;
      if (!this.members.includes(this.me)) { this.members.push(this.me); this.leaderSend({ kind: CV.Join }); }
      if (dest && (m.seq !== this.seq || !this.dest || Math.hypot(dest.x - this.dest.x, dest.z - this.dest.z) > 3)) {
        const first = this.seq === -1;
        this.seq = m.seq;
        this.follow(dest);
        if (!first) this.toast(`${this.nameOf(from)} changed the destination: ${this.street(dest)}. Your route follows.`, 6);
      }
      return;
    }
    if (m.kind === CV.End) {
      this.offers.delete(from);
      if (this.role === 'member' && from === this.leader) { this.toast(`${this.nameOf(from)} ended the convoy.`, 5); this.reset(); }
      return;
    }
    if (m.kind === CV.Join) {
      if (this.role !== 'lead' || m.leader !== this.me) return;
      if (!this.members.includes(from) && this.members.length < CONVOY_MAX) { this.members.push(from); this.toast(`${this.nameOf(from)} joined the convoy.`, 4); }
      this.sendLead();
      return;
    }
    if (m.kind === CV.Leave) {
      if (this.role === 'lead' && m.leader === this.me && this.members.includes(from)) {
        this.members = this.members.filter((x) => x !== from);
        this.toast(`${this.nameOf(from)} left the convoy.`, 4);
        this.sendLead();
      }
      return;
    }
    if (m.kind === CV.Hand) {
      this.offers.delete(from);
      if (this.role === 'none' || from !== this.leader) return;
      this.members = m.ids.slice();
      if (!this.members.includes(this.me)) this.members.push(this.me);
      this.becomeLeader(m.leader, `${this.nameOf(from)} left the convoy.`);
      return;
    }
    if (m.kind === CV.Arrive) {
      if (this.role !== 'member' || from !== this.leader) return;
      this.arrived(m.ids.includes(this.me), (m.flags & F_NOPAY) !== 0, m.ids.length);
    }
  }

  /** `next` leads now (the old leader handed it over or dropped off the net). */
  private becomeLeader(next: number, why: string): void {
    this.leader = next;
    if (next === this.me) {
      this.role = 'lead'; this.seq = (this.seq + 1) & 0xff;
      const p = this.place(this.me);
      if (this.dest && p) this.origin = { x: p.x, z: p.z };
      this.stats.led++;
      this.toast(`${why} You lead the convoy now.`, 6);
      this.sendLead();
    } else {
      this.role = 'member'; this.lastLeadAt = performance.now();
      this.toast(`${why} ${this.nameOf(next)} leads it now.`, 5);
    }
  }

  dropped(id: number): void {
    this.offers.delete(id);
    if (this.role === 'none' || !this.members.includes(id)) return;
    this.members = this.members.filter((x) => x !== id);
    if (id !== this.leader) {
      if (this.role === 'lead') { this.toast(`${this.nameOf(id)} left town and the convoy.`, 4); this.sendLead(); }
      return;
    }
    // The leader went: every screen picks the same next one, the lowest number still in.
    const next = Math.min(...this.members);
    this.becomeLeader(next, `${this.nameOf(id)} left town.`);
  }

  offline(): void { this.offers.clear(); this.reset(); }
  announce(): void { this.sendLead(); }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(_dt: number): void {
    const now = performance.now(), t = this.game.todo;
    for (const [id, o] of this.offers) if (now - o.at > OFFER_MS) this.offers.delete(id);
    if (this.role === 'none') return;
    if (this.role === 'member' && now - this.lastLeadAt > SILENCE_MS) { this.toast('The convoy leader went quiet. The convoy is over.', 5); this.reset(); return; }
    if (this.role === 'lead') {
      // The leader's waypoint is the convoy's destination.
      const w = t.waypoint;
      if (w && (!this.dest || Math.hypot(w.x - this.dest.x, w.z - this.dest.z) > 3)) {
        this.dest = { x: w.x, z: w.z }; this.seq = (this.seq + 1) & 0xff;
        const p = this.place(this.me);
        this.origin = p ? { x: p.x, z: p.z } : null;
        this.toast(`Convoy destination: ${this.street(this.dest)}. Your members' routes follow.`, 5);
        this.sendLead();
      } else if (now - this.sendAt > LEAD_EVERY_MS) this.sendLead();
      this.judge();
    }
    // A teal ring on the road at each other member's car.
    const p = this.game.player;
    for (const id of this.members) {
      if (id === this.me) continue;
      const at = this.link ? this.link.posOf(id) : null;
      if (at && Math.hypot(at.x - p.x, at.z - p.z) < 400) this.markers.put(at.x, at.z, 'job', 3.4, 9);
    }
  }

  /** The leader's judgement of the arrival. */
  private judge(): void {
    const d = this.dest, me = this.place(this.me);
    if (!d || !me || Math.hypot(me.x - d.x, me.z - d.z) > ARRIVE_M) return;
    const near: number[] = [this.me];
    for (const id of this.members) {
      if (id === this.me) continue;
      const at = this.place(id);
      if (at && Math.hypot(at.x - d.x, at.z - d.z) <= NEAR_M) near.push(id);
    }
    if (near.length < 2) return;
    const far = !!this.origin && Math.hypot(d.x - this.origin.x, d.z - this.origin.z) >= TRIP_M;
    this.send({ kind: CV.Arrive, ids: near, flags: F_DEST | (far ? 0 : F_NOPAY) });
    this.arrived(true, !far, near.length);
  }

  /** Every screen: the convoy has arrived. */
  private arrived(inside: boolean, nopay: boolean, count: number): void {
    const g = this.game, now = Date.now();
    this.stats.arrived++;
    this.reset();
    this.lastPay = 0;
    if (!inside) { this.toast('The convoy arrived, but you were not close enough to the destination together.', 6); return; }
    if (nopay) { this.toast(`The convoy arrived: ${count} together. A short hop pays nothing.`, 6); return; }
    if (now - this.lastPaid < COOLDOWN_S * 1000) {
      const mins = Math.ceil((COOLDOWN_S * 1000 - (now - this.lastPaid)) / 60000);
      this.toast(`The convoy arrived: ${count} together. The bonus is paid once every few minutes (about ${mins} more).`, 7);
      return;
    }
    this.lastPaid = now; this.lastPay = BONUS;
    try { localStorage.setItem(STORE, String(now)); } catch { /* no storage */ }
    g.player.money += BONUS; save.credit(BONUS); save.data.stats.earned += BONUS;
    this.stats.paid++;
    g.hud.stamp('CONVOY ARRIVED', `${count} cars together · +$${BONUS} each`);
  }

  /** The radar: the members' cars, and an open convoy's leader. */
  blips(out: Blip[]): void {
    if (this.role === 'none') {
      for (const o of this.offers.values()) { const at = this.link ? this.link.posOf(o.leader) : null; if (at) out.push({ x: at.x, z: at.z, kind: 'job', label: 'V' }); }
      return;
    }
    for (const id of this.members) {
      if (id === this.me) continue;
      const at = this.link ? this.link.posOf(id) : null;
      if (at) out.push({ x: at.x, z: at.z, kind: 'job', label: 'V' });
    }
  }

  info(): Record<string, unknown> {
    return {
      role: this.role, leader: this.leader, members: this.members.slice(), seq: this.seq,
      dest: this.dest ? { x: Math.round(this.dest.x), z: Math.round(this.dest.z) } : null,
      offers: [...this.offers.values()].map((o) => ({ leader: o.leader, dest: o.dest })),
      lastPay: this.lastPay, ...this.stats,
    };
  }

  /** For the tests: forget the pay cooldown. */
  testResetCooldown(): void { this.lastPaid = -1e12; }
}
