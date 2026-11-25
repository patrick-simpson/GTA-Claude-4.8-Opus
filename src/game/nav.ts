// Navigation: the way to a place, along the streets, with turns.
//
// Built against the StreetGraph's API (nearestEdge, edgePts, pointAt, findPath, canLeave), never against edge ids, so it
// keeps working as the roads change. A route starts on the street nearest the player (partway along its edge, not at its
// corner), follows the graph's cheapest drive, and ends on the street nearest the door with a short straight leg to it.
// Turns are read off the polyline itself (heading before and after each junction), so they are right for any road shape.
// The route is rebuilt when the goal changes, and when she has been off it for a second and a bit.

import type { CityPlan, RoadEdge } from '../world/plan';
import type { Pt } from './script';

export type Dir = 'left' | 'right' | 'straight' | 'uturn' | 'arrive';
export interface Turn { dir: Dir; street: string; /** Metres along the route. */ at: number }
/** One street of the route: the edge, and where along it the route enters (s0) and leaves (s1), metres from the edge's a end. */
export interface Leg { e: RoadEdge; s0: number; s1: number }
export interface Guidance { dir: Dir; street: string; /** Metres to the next turn, and to the end. */ dist: number; total: number; text: string }

const FEET = 3.28084;

/** "200 ft", rounded the way a satnav says it; "0.4 mi" from a fifth of a mile. */
export function distText(m: number): string {
  const ft = m * FEET;
  if (ft < 1000) return `${Math.max(50, Math.round(ft / 50) * 50)} ft`;
  return `${(ft / 5280).toFixed(1)} mi`;
}

interface Seg { e: RoadEdge | null; s0: number; s1: number }

export class Navigator {
  /** The route, flat x,z, from the start to the goal. */
  poly: number[] = [];
  cum: number[] = [];
  turns: Turn[] = [];
  /** The streets of the route in order (the autopilot, game/autopilot.ts, drives these); a new route bumps `gen`. */
  legs: Leg[] = [];
  gen = 0;
  /** The autopilot sets this to the way the car faces, so a route never starts by turning round. null: no preference. */
  heading: { x: number; z: number } | null = null;
  total = 0;
  /** Where along the route she is, and how far to one side. */
  s = 0; off = 0;
  private seg = 0;
  private goal: Pt | null = null;
  private goalX = NaN; private goalZ = NaN;
  private tBuild = 99; private tFollow = 99; private offT = 0; private failT = 99;
  /** Whether there is a route at all (false: no road there yet). */
  ok = false;
  private pushed = '';

  /**
   * Called every frame. `to` is the goal, or null. Sets `nav.route` (and bumps its rev) and returns the guidance, or null when
   * there is nothing to say.
   */
  update(dt: number, plan: CityPlan, px: number, pz: number, to: Pt | null, name: string | null, nav: { route: number[] | null; rev: number }): Guidance | null {
    if (!to) {
      if (this.goal || nav.route) { this.goal = null; this.ok = false; this.poly = []; this.pushed = ''; if (nav.route) { nav.route = null; nav.rev++; } }
      return null;
    }
    this.tBuild += dt; this.tFollow += dt; this.failT += dt;
    const moved = !this.goal || Math.hypot(to.x - this.goalX, to.z - this.goalZ) > 0.5;
    const far = Math.hypot(px - to.x, pz - to.z);
    if (moved || (this.offT > 1.2 && this.tBuild > 1) || (!this.ok && this.failT > 3 && far > 45)) {
      this.goal = to; this.goalX = to.x; this.goalZ = to.z; this.offT = 0; this.tBuild = 0; this.tFollow = 99;
      this.ok = far > 45 ? this.build(plan, px, pz, to.x, to.z) : false;
      if (!this.ok) this.failT = 0;
      this.pushed = '';
    }
    if (!this.ok) {
      // Close, or no way yet: a straight word and no line.
      if (nav.route) { nav.route = null; nav.rev++; }
      return far <= 45 ? { dir: 'arrive', street: '', dist: far, total: far, text: `${name ?? 'Your goal'}, ${distText(far)}` } : null;
    }
    if (this.tFollow < 0.25) return this.last;
    this.tFollow = 0;
    this.follow(px, pz);
    if (this.off > 25) this.offT += 0.25; else this.offT = 0;
    // The line she sees starts under her and drops what is behind.
    const at = this.seg;
    const sig = `${at}:${Math.round(px / 4)}:${Math.round(pz / 4)}`;
    if (sig !== this.pushed) {
      this.pushed = sig;
      const r: number[] = [px, pz];
      for (let i = (at + 1) * 2; i < this.poly.length; i++) r.push(this.poly[i]);
      nav.route = r; nav.rev++;
    }
    let t: Turn | null = null;
    for (const k of this.turns) if (k.at > this.s - 4) { t = k; break; }
    const total = Math.max(0, this.total - this.s);
    const dist = t ? Math.max(0, t.at - this.s) : total;
    const dir: Dir = t ? t.dir : 'arrive', street = t ? t.street : '';
    const where = dist < 8 && dir !== 'arrive' ? 'now' : distText(dist);
    const text = dir === 'arrive' ? `${name ?? 'Your goal'} ${total < 60 ? 'ahead' : 'in ' + distText(total)}`
      : dir === 'straight' ? `Continue on ${street}, ${where}`
      : dir === 'uturn' ? `Make a U-turn on ${street}, ${where}`
      : `Turn ${dir} on ${street}, ${where}`;
    this.last = { dir, street, dist, total, text };
    return this.last;
  }
  private last: Guidance | null = null;

  /** Ask for a fresh route from where she is now (the next update builds it). */
  reroute(): void { this.offT = 2; this.tBuild = 2; }

  /** Forget the route (the goal went away). */
  clear(): void { this.goal = null; this.ok = false; this.poly = []; this.last = null; }

  // ── Building ────────────────────────────────────────────────────────────

  private build(plan: CityPlan, fx: number, fz: number, tx: number, tz: number): boolean {
    this.turns = []; this.poly = []; this.cum = []; this.total = 0; this.seg = 0; this.s = 0; this.off = 0; this.legs = []; this.gen++;
    const G = plan.streets;
    const segs: Seg[] = [];
    if (G) {
      const open = (e: RoadEdge): boolean => !e.closed;
      const a = G.nearestEdge(fx, fz, open), b = G.nearestEdge(tx, tz, open);
      const A = a.edge, B = b.edge;
      if (A.closed || B.closed) return false;
      let best = Infinity;
      let bestSegs: Seg[] | null = null;
      // Same street, goal ahead of her (or the street runs both ways): straight along it.
      const hd = this.heading;
      // Which way the car faces along its street: +1 toward b, -1 toward a, 0 when it does not matter.
      let face = 0;
      if (hd) { const q = G.pointAt(A, a.s), dd = q.dx * hd.x + q.dz * hd.z; face = dd > 0.2 ? 1 : dd < -0.2 ? -1 : 0; }
      if (A === B && (b.s >= a.s || !A.oneWay) && (face === 0 || (b.s >= a.s ? 1 : -1) === face)) { best = Math.abs(b.s - a.s); bestSegs = [{ e: A, s0: a.s, s1: b.s }]; }
      const starts = [...(face >= 0 ? [{ n: A.b, c: A.len - a.s }] : []), ...(A.oneWay || face > 0 ? [] : [{ n: A.a, c: a.s }])];
      if (!starts.length) starts.push({ n: A.b, c: A.len - a.s });
      const ends = [{ n: B.a, c: b.s }, ...(B.oneWay ? [] : [{ n: B.b, c: B.len - b.s }])];
      for (const st of starts) for (const en of ends) {
        const ids = st.n === en.n ? [st.n] : G.findPath(st.n, en.n);
        if (ids.length < 2 && st.n !== en.n) continue;
        const mid: Seg[] = [];
        let len = 0, bad = false;
        for (let i = 0; i + 1 < ids.length; i++) {
          let pick: RoadEdge | null = null;
          for (const eid of G.nodes[ids[i]].edges) { const e = G.edges[eid]; if (G.other(e, ids[i]) === ids[i + 1] && G.canLeave(e, ids[i]) && !e.closed && (!pick || e.len < pick.len)) pick = e; }
          if (!pick) { bad = true; break; }
          const fwd = pick.a === ids[i];
          mid.push({ e: pick, s0: fwd ? 0 : pick.len, s1: fwd ? pick.len : 0 }); len += pick.len;
        }
        if (bad) continue;
        const c = st.c + len + en.c;
        if (c >= best) continue;
        best = c;
        bestSegs = [{ e: A, s0: a.s, s1: st.n === A.b ? A.len : 0 }, ...mid, { e: B, s0: en.n === B.a ? 0 : B.len, s1: b.s }];
      }
      if (!bestSegs) return false;
      for (const s of bestSegs) if (Math.abs(s.s1 - s.s0) > 0.4) segs.push(s);
      this.legs = segs.map((s) => ({ e: s.e as RoadEdge, s0: s.s0, s1: s.s1 }));
      // The way in: from where she stands to the street, then the streets, then the last steps to the door.
      const pts: number[] = [fx, fz];
      const mark: number[] = []; // polyline vertex index where each segment starts
      const names: string[] = [];
      const push = (x: number, z: number): void => { const n = pts.length; if (Math.hypot(pts[n - 2] - x, pts[n - 1] - z) > 0.3) pts.push(x, z); };
      for (const s of segs) {
        const e = s.e as RoadEdge, ep = G.edgePts(e), cum = e.cum ?? [0, e.len];
        const p0 = G.pointAt(e, s.s0);
        push(p0.x, p0.z);
        mark.push(pts.length / 2 - 1); names.push(e.name);
        if (s.s1 >= s.s0) { for (let k = 0; k < cum.length; k++) if (cum[k] > s.s0 + 0.2 && cum[k] < s.s1 - 0.2) push(ep[2 * k], ep[2 * k + 1]); }
        else for (let k = cum.length - 1; k >= 0; k--) if (cum[k] < s.s0 - 0.2 && cum[k] > s.s1 + 0.2) push(ep[2 * k], ep[2 * k + 1]);
        const p1 = G.pointAt(e, s.s1);
        push(p1.x, p1.z);
      }
      push(tx, tz);
      this.poly = pts;
      this.index();
      // Turns: heading in and out of each junction between segments.
      for (let i = 1; i < mark.length; i++) {
        const at = this.cum[mark[i]];
        const a0 = this.pointAt(at - 9), a1 = this.pointAt(at), b1 = this.pointAt(at + 9);
        const ix = a1.x - a0.x, iz = a1.z - a0.z, ox = b1.x - a1.x, oz = b1.z - a1.z;
        const li = Math.hypot(ix, iz), lo = Math.hypot(ox, oz);
        if (li < 1 || lo < 1) continue;
        const ang = (Math.atan2(ix * oz - iz * ox, ix * ox + iz * oz) * 180) / Math.PI;
        const dir: Dir = Math.abs(ang) > 150 ? 'uturn' : Math.abs(ang) > 32 ? (ang > 0 ? 'right' : 'left') : 'straight';
        if (dir === 'straight' && names[i] === names[i - 1]) continue;
        this.turns.push({ dir, street: names[i], at });
      }
      // The end of the streets: the last bit to the door is a straight word, not a turn.
      return this.poly.length >= 4;
    }
    // ?streets=old: the old grid. Node to node, no partial edges.
    const ids = plan.findPath(plan.nearestNode(fx, fz).id, plan.nearestNode(tx, tz).id);
    if (ids.length < 2) return false;
    const pts = [fx, fz];
    for (const id of ids) pts.push(plan.nodes[id].x, plan.nodes[id].z);
    pts.push(tx, tz);
    this.poly = pts; this.index();
    return true;
  }

  private index(): void {
    const p = this.poly, c = [0];
    for (let i = 2; i < p.length; i += 2) c.push(c[c.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
    this.cum = c; this.total = c[c.length - 1];
  }

  /** The point at distance s along the route (clamped). */
  pointAt(s: number): { x: number; z: number } {
    const c = this.cum, p = this.poly;
    s = Math.max(0, Math.min(this.total, s));
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const L = c[hi] - c[lo] || 1, t = (s - c[lo]) / L;
    return { x: p[2 * lo] + (p[2 * hi] - p[2 * lo]) * t, z: p[2 * lo + 1] + (p[2 * hi + 1] - p[2 * lo + 1]) * t };
  }

  /** Where she is on the route: the nearest stretch, looking a little behind and well ahead of where she was. */
  private follow(px: number, pz: number): void {
    const p = this.poly, n = p.length / 2 - 1;
    let bd = Infinity, bi = this.seg, bs = this.s;
    const lo = Math.max(0, this.seg - 3), hi = Math.min(n - 1, this.seg + 60);
    for (let i = lo; i <= hi; i++) {
      const ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * i + 2], bz = p[2 * i + 3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
      const d = Math.hypot(px - ax - dx * t, pz - az - dz * t);
      if (d < bd - 0.01) { bd = d; bi = i; bs = this.cum[i] + t * Math.sqrt(l2); }
    }
    // Far from where she was supposed to be: look along the whole route.
    if (bd > 40) for (let i = 0; i < n; i++) {
      const ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * i + 2], bz = p[2 * i + 3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
      const d = Math.hypot(px - ax - dx * t, pz - az - dz * t);
      if (d < bd - 0.01) { bd = d; bi = i; bs = this.cum[i] + t * Math.sqrt(l2); }
    }
    this.seg = bi; this.s = bs; this.off = bd;
  }
}

/** The arrow for a turn: a stroked SVG path in a 24 x 24 box. */
export const ARROW: Record<Dir, string> = {
  left: 'M17 21v-8a3 3 0 0 0-3-3H6 M10 5l-5 5 5 5',
  right: 'M7 21v-8a3 3 0 0 1 3-3h8 M14 5l5 5-5 5',
  straight: 'M12 21V5 M6 11l6-6 6 6',
  uturn: 'M7 21V10a5 5 0 0 1 10 0v4 M13 11l4 4 4-4',
  arrive: 'M6 21V3 M6 4h12l-3 4.5 3 4.5H6',
};
