// Taxi missions (fun queue 2, item 10): drive the Calamity Courtesy Cab for fares. Owned and run by game/activities.ts, which
// keeps the floor (ThingsToDo.busy), the cab (held while the shift runs) and the multiplayer view (net/jobs.ts).
//
//   on duty    in any taxi, stopped, press G (the cab ranks: yellow cabs parked downtown, at the Depot and at both landings).
//   hail       a pedestrian waves from the kerb, 70 to 300 m off by road: stop beside them and they get in the back
//              (drawn in the rear seat: ent/occupants.ts demo list alone; net/jobs.ts seats them in a shared town).
//   the ride   a REAL business from the directory, by its punny name (world/directory.ts, placed against the buildings by
//              world/business.ts), and the way there is the route line and turn card of game/nav.ts (Activities.target).
//   the meter  fare = base + distance by road. A speed bonus melts away over the par time. The tip rides on smoothness: it
//              starts full and drops with every knock, near miss and red light; a rough ride (under 25%) pays no tip at all.
//   reactions  speech lines in the game's dry humour (the subtitle) and, where one fits, the townsfolk's voice barks
//              (audio/voices.ts: bump, near, cheer) from the cab.
//   the shift  chain fares; G (stopped) or leaving the cab for good ends it with a summary card and the best shift is kept
//              (save.best.taxi, the leaderboard's "Best taxi shift").
//
// Kid mode: knocks cost half as much, a ride is never rough (the tip never falls under a third) and the lines are gentle.
// Everything here is this browser's own: the passenger is a local pedestrian; the others see the fare waiting and then
// aboard through the existing job frame (no protocol change).

import type { Game } from '../core/game';
import type { Look, Person, Vehicle } from '../core/api';
import { places, type Place } from '../world/business';
import { signalState } from '../world/signals';
import { seatSpot } from '../ent/occupants';
import { PASSENGER_SEATS } from '../ent/vehicleSpecs';
import { kid } from '../core/kid';
import { money } from '../core/util';
import { save } from './save';
import { distText } from './nav';
import { clock, type Pt } from './script';

/** What the job needs from the Activities that own it. */
export interface TaxiHost {
  corner(from: Pt, lo: number, hi: number): { at: Pt; len: number } | null;
  pay(key: string, cash: number, points: number): { cash: number; points: number };
  stop(why?: string): void;
  shared(): boolean;
  look(seed: number): Look;
}

const HELLO = [
  'Do you know the island? No? Good, neither do I.', 'Take the scenic route. I am billing someone.', 'I left the oven on. This is unrelated to where we are going.',
  'My last driver went off the pier. Five stars.', 'Drive like the meter is somebody else\'s.', 'Is this cab insured? Is anything?',
];
const HELLO_KID = ['Hello! Is the cab warm? I like warm cabs.', 'Take your time. I brought a snack.', 'I have never been in a taxi before. Is it always this yellow?'];
const BUMP = ['That was my good spine.', 'I felt that in my deposit.', 'Was that a person or a policy?', 'I will be mentioning that in the review.', 'The tip saw that.'];
const BUMP_KID = ['Oops! That was a bump.', 'Whoa. Gently, please.', 'My hat went somewhere.'];
const NEAR = ['I have seen my life flash before me. It was mostly waiting rooms.', 'That was close. I could read their lips.', 'Do we need to be this fast? I will pay for slow.', 'Mind the pedestrians. They are the ones who vote.'];
const NEAR_KID = ['That was close! Slow down a little.', 'Ooh. Careful, driver.'];
const RED = ['Is that a red light or a suggestion?', 'Green means go. Red means, apparently, also go.', 'The light was red. I am just a witness. A paying one.', 'Officer, I would like it noted that I was in the back.'];
const RED_KID = ['That light was red! Stopping is the fun part.', 'Red means stop. I learned that today.'];
const GOOD = ['Smooth as a lawyer. Keep the change. There is no change.', 'Best ride of the week. The week was bad.', 'You should do this for a living. Somebody should.', 'I did not scream once. Put that on the board.'];
const OK = ['I have had worse. I was driving.', 'Fine. I am fine. The cab is fine. We are all fine.', 'Here. Do not thank me, I resent it.'];
const ROUGH = ['I am walking home. Next time.', 'No tip. I need it for therapy.', 'I will be writing to the Harbor Authority. In crayon, from the ground.'];
const GOOD_KID = ['That was lovely! Thank you, driver.', 'What a nice ride. Do you give stickers?', 'Wheee. I mean, thank you.'];
const OK_KID = ['Thank you! That was fun, mostly.', 'Nice driving. A little wobbly.'];

/** Smoothness at or under which the tip is gone. */
const ROUGH_AT = 25;
const TIP_SHARE = 0.55;
const BONUS_SHARE = 0.35;
const REACH = 9;
const DROP = 16;

interface Shift { fares: number; cash: number; tips: number; bonus: number; bumps: number; near: number; reds: number; best: number; smooth: number; t: number; rough: number }
const blank = (): Shift => ({ fares: 0, cash: 0, tips: 0, bonus: 0, bumps: 0, near: 0, reds: 0, best: 0, smooth: 0, t: 0, rough: 0 });

export class Taxi {
  /** 0: waiting to pick someone up; 1: somebody is in the back. */
  phase = 0;
  /** The fare standing at the kerb (phase 0). */
  rider: Person | null = null;
  riderSeed = 0;
  /** Where the next stop is, and what it is called (a business's name once the fare is aboard). */
  dest: Pt | null = null;
  destName = '';
  prompt: string | null = null;
  readonly shift: Shift = blank();
  /** The meter of the ride in hand (for the tests and the meter). */
  readonly ride = { fare: 0, len: 0, par: 0, t: 0, smooth: 100, bonus: 0, tip: 0 };

  private seated: Person | null = null;
  private demo: { v: Vehicle; seat: number; p: Person } | null = null;
  private lines = 0;
  private hitCool = 0; private nearCool = 0; private redCool = 0; private scanT = 0; private inLight = -1;
  private meter: HTMLDivElement | null = null; private meterKey = '';
  private card: HTMLDivElement | null = null; private cardT = 0;
  private on = false;

  constructor(private readonly game: Game, private readonly host: TaxiHost) {
    game.on('impact', (e) => {
      const pv = game.player.vehicle;
      if (!this.on || this.phase !== 1 || e.speed < 4 || !pv || (e.vehicle !== pv && e.other !== pv) || this.hitCool > 0) return;
      this.hitCool = 0.8;
      this.hurt(Math.min(40, 6 + e.speed * 1.3), 'bump');
    });
  }

  // ── Duty ───────────────────────────────────────────────────────────────────

  /** On duty: the first fare. False if nobody wants a cab. */
  begin(): boolean {
    Object.assign(this.shift, blank());
    this.closeCard();
    this.on = true; this.lines = 0;
    if (!this.nextFare()) { this.on = false; return false; }
    this.game.hud.toast('On duty. Wave-down fares appear on the radar. Stop beside one, then follow the route to the address. A smooth ride tips; a rough one does not. G (stopped) goes off duty.', 8);
    return true;
  }

  /** End the shift (Activities.stop calls this first). */
  end(card: boolean): void {
    const g = this.game, s = this.shift;
    if (this.rider) { g.people.remove(this.rider); this.rider = null; }
    this.unseat();
    this.phase = 0; this.dest = null; this.destName = ''; this.prompt = null; this.on = false;
    this.clearMeter();
    g.hud.timer(null);
    if (!card || s.fares === 0) return;
    const record = save.record('taxi', s.cash, false);
    const avg = Math.round(s.smooth / s.fares);
    this.showCard([
      ['Fares delivered', String(s.fares)], ['Best fare', money(s.best)], ['Tips', money(s.tips)], ['Speed bonuses', money(s.bonus)],
      ['Smoothness', `${avg}%${s.rough ? ` · ${s.rough} rough` : ''}`], ['Bumps · near misses · red lights', `${s.bumps} · ${s.near} · ${s.reds}`],
      ['On duty', clock(s.t)], ['Earned this shift', money(s.cash)], ['Best shift', `${money(save.data.best.taxi ?? s.cash)}${record ? ' · NEW' : ''}`],
    ], s.fares >= 5 ? 'GREAT SHIFT' : s.fares >= 2 ? 'OFF DUTY' : 'ONE FARE');
  }

  // ── Fares ──────────────────────────────────────────────────────────────────

  private nextFare(): boolean {
    const g = this.game, p = g.player;
    const c = this.host.corner({ x: p.x, z: p.z }, 70, 300) ?? this.host.corner({ x: p.x, z: p.z }, 30, 700);
    if (!c) return false;
    this.phase = 0; this.dest = c.at; this.destName = '';
    // (In a shared town the fare's look comes from a seed the others are told, so they draw the same person.)
    this.riderSeed = Math.floor(Math.random() * 256);
    this.rider = g.people.spawn(c.at.x, c.at.z, Math.atan2(p.x - c.at.x, p.z - c.at.z), this.host.shared() ? this.host.look(this.riderSeed) : undefined);
    this.rider.pose = 'stand';
    return true;
  }

  /** A real business a sensible way off by road, from the directory. Null when the directory has nothing there. */
  private pickPlace(from: Pt): { pl: Place; len: number } | null {
    const g = this.game, plan = g.plan.streets ?? g.plan, a = plan.nearestNode(from.x, from.z);
    const pool = places(g.plan).filter((q) => q.placed && !q.open && Math.hypot(q.x - from.x, q.z - from.z) > 160 && Math.hypot(q.x - from.x, q.z - from.z) < 800);
    for (let tries = 0; tries < 40 && pool.length; tries++) {
      const pl = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const b = plan.nearestNode(pl.x, pl.z);
      if (b.land !== a.land || b.id === a.id) continue;
      const ids = plan.findPath(a.id, b.id);
      if (ids.length < 2) continue;
      let len = 0;
      for (let k = 1; k < ids.length; k++) len += Math.hypot(plan.nodes[ids[k]].x - plan.nodes[ids[k - 1]].x, plan.nodes[ids[k]].z - plan.nodes[ids[k - 1]].z);
      if (len >= 260 && len <= 1000) return { pl, len };
    }
    return null;
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  tick(dt: number, v: Vehicle): void {
    const g = this.game, hud = g.hud, d = this.dest as Pt;
    this.prompt = null;
    this.hitCool = Math.max(0, this.hitCool - dt); this.nearCool = Math.max(0, this.nearCool - dt); this.redCool = Math.max(0, this.redCool - dt);
    this.shift.t += dt;
    this.tickCard(dt);
    const slow = Math.abs(v.speed) < 3;
    // Off duty: G, stopped. (Not while a stop is within reach: the fare is the point of the shift.)
    if (slow) {
      this.prompt = '[G] Go off duty';
      if (g.input.eat('interact') && this.shift.t > 1.5) { this.host.stop(); return; }
    }
    this.markers(d);
    const here = Math.hypot(v.x - d.x, v.z - d.z) < (this.phase === 0 ? REACH : DROP) && Math.abs(v.speed) < (this.phase === 0 ? 2 : 2.5);
    if (this.phase === 0) {
      hud.objective(`Pick up the fare waving on ${g.plan.streetAt(d.x, d.z)}. Stop beside them.`);
      this.drawMeter(null);
      if (this.rider) this.rider.h = Math.atan2(v.x - this.rider.x, v.z - this.rider.z);
      if (!here) return;
      if (this.rider) { g.people.remove(this.rider); this.rider = null; }
      const q = this.pickPlace(d);
      const c = q ? null : this.host.corner(d, 280, 900);
      if (!q && !c) { this.host.stop('The fare changed their mind. So did the town.'); return; }
      const len = q ? q.len : (c as { len: number }).len;
      this.dest = q ? { x: q.pl.x, z: q.pl.z } : (c as { at: Pt }).at;
      this.destName = q ? q.pl.name : g.plan.placeName(this.dest.x, this.dest.z);
      this.phase = 1;
      const r = this.ride;
      r.len = len; r.fare = Math.round(12 + len * 0.19); r.par = len / 9.5 + 14; r.t = 0; r.smooth = 100; r.bonus = 0; r.tip = 0;
      this.hitCool = this.nearCool = this.redCool = 0.5; this.inLight = -1;
      this.say(kid.on ? HELLO_KID : HELLO, 4.5);
      return;
    }
    const r = this.ride;
    r.t += dt;
    this.seat(v);
    this.scan(dt, v);
    r.bonus = Math.round(r.fare * BONUS_SHARE * Math.max(0, 1 - r.t / r.par));
    r.tip = this.tipOf(r.smooth, r.fare);
    this.drawMeter(v);
    hud.objective(`Take the fare to ${this.destName}, ${g.plan.streetAt(d.x, d.z)}.`);
    hud.timer('Meter', `${money(r.fare + r.bonus + r.tip)}`, r.smooth < ROUGH_AT + 15 && !kid.on);
    if (!here) return;
    this.arrive(v);
  }

  private tipOf(smooth: number, fare: number): number {
    const full = fare * TIP_SHARE;
    if (kid.on) return Math.round(full * Math.max(1 / 3, smooth / 100));
    return smooth < ROUGH_AT ? 0 : Math.round(full * smooth / 100);
  }

  private arrive(v: Vehicle): void {
    const g = this.game, hud = g.hud, r = this.ride, s = this.shift;
    const total = r.fare + r.bonus + r.tip;
    const paid = this.host.pay('taxi', total, 14);
    const k = total > 0 ? paid.cash / total : 1;
    save.data.stats.fares++;
    s.fares++; s.cash += paid.cash; s.tips += Math.round(r.tip * k); s.bonus += Math.round(r.bonus * k); s.best = Math.max(s.best, paid.cash);
    s.smooth += r.smooth;
    const rough = !kid.on && r.smooth < ROUGH_AT;
    if (rough) s.rough++;
    const bits = [`fare ${money(Math.round(r.fare * k))}`];
    if (r.bonus >= 1) bits.push(`speed +${money(Math.round(r.bonus * k))}`);
    bits.push(r.tip >= 1 ? `tip +${money(Math.round(r.tip * k))}` : 'no tip');
    hud.toast(`${this.destName}: ${money(paid.cash)} (${bits.join(' · ')}). ${paid.points} toward the bridge.`, 6);
    g.emit('moment', { kind: 'taxi' });
    const odd = this.riderSeed & 1;
    if (rough) this.say(ROUGH, 4.5);
    else if (r.smooth >= 80) { this.say(kid.on ? GOOD_KID : GOOD, 4.5); this.bark('cheer', v, odd, 0.4); }
    else this.say(kid.on ? OK_KID : OK, 4);
    this.unseat();
    this.phase = 0; this.dest = null; this.destName = '';
    hud.timer(null);
    if (!this.nextFare()) this.host.stop('That was the last fare in town.');
  }

  /** A knock, a near miss or a red light: the ride loses smoothness, the passenger says so. */
  private hurt(pts: number, what: 'bump' | 'near' | 'red'): void {
    const r = this.ride, s = this.shift, v = this.game.player.vehicle;
    r.smooth = Math.max(0, r.smooth - pts * (kid.on ? 0.5 : 1));
    const odd = this.riderSeed & 1;
    if (what === 'bump') { s.bumps++; this.say(kid.on ? BUMP_KID : BUMP, 3.5); if (v) this.bark('bump', v, odd, 0.15); }
    else if (what === 'near') { s.near++; this.say(kid.on ? NEAR_KID : NEAR, 3.5); if (v) this.bark('near', v, odd, 0.1); }
    else { s.reds++; this.say(kid.on ? RED_KID : RED, 4); if (v) this.bark('near', v, odd, 0.1); }
  }

  private say(pool: readonly string[], secs: number): void { this.game.hud.subtitle('FARE', pool[this.lines++ % pool.length], secs); }

  private bark(cat: string, v: Vehicle, odd: number, delay: number): void {
    try { this.game.audio.voices?.bark(cat, v.x, v.z, odd, delay); } catch { /* no sound is fine */ }
  }

  // ── Watching the driving ───────────────────────────────────────────────────

  /** Red lights run and people or cars missed by a hair, ten times a second. */
  private scan(dt: number, v: Vehicle): void {
    this.scanT += dt;
    if (this.scanT < 0.1) return;
    this.scanT = 0;
    const g = this.game, plan = g.plan.streets ?? g.plan, sp = Math.abs(v.speed);
    // Red light: entering a signalled junction's box at speed while its lamp for this heading is red.
    const n = plan.nearestNode(v.x, v.z);
    const inside = n.hasLight && Math.abs(v.x - n.x) < Math.max(n.hx, 6) + 1.5 && Math.abs(v.z - n.z) < Math.max(n.hz, 6) + 1.5;
    if (inside && this.inLight !== n.id) {
      this.inLight = n.id;
      if (sp > 5 && this.redCool <= 0 && signalState(n, Math.abs(Math.sin(v.h)) > Math.abs(Math.cos(v.h)), g.signalTime) === 'red') { this.redCool = 4; this.hurt(18, 'red'); }
    } else if (!inside) this.inLight = -1;
    if (sp < 9 || this.nearCool > 0 || this.hitCool > 0) return;
    // Near miss: somebody on foot, or another car under way, within a body's width without a touch.
    const lim = v.hw + 0.9;
    let hit = false;
    for (const p of g.people.list) {
      if (!p.visible || p === g.player.person || p === this.seated || p.occupant || p.health <= 0 || p.pose === 'down' || p.pose === 'sit') continue;
      const dx = p.x - v.x, dz = p.z - v.z;
      if (dx * dx + dz * dz < (lim + 1.4) * (lim + 1.4) && this.alongSide(v, dx, dz) < lim) { hit = true; break; }
    }
    if (!hit) for (const o of g.vehicles.list) {
      if (o === v || o.removed || (o.driver === null && Math.abs(o.speed) < 2)) continue;
      const dx = o.x - v.x, dz = o.z - v.z;
      if (dx * dx + dz * dz < 9 * 9 && this.alongSide(v, dx, dz) < v.hw + o.hw + 0.35 && Math.abs(dx * Math.sin(v.h) + dz * Math.cos(v.h)) < v.hl + o.hl) { hit = true; break; }
    }
    if (hit) { this.nearCool = 4; this.hurt(8, 'near'); }
  }

  /** Sideways distance of (dx, dz) from the line the car is heading along, and only for things ahead or beside it. */
  private alongSide(v: Vehicle, dx: number, dz: number): number {
    const fx = Math.sin(v.h), fz = Math.cos(v.h), ahead = dx * fx + dz * fz;
    if (ahead < -v.hl - 0.5 || ahead > v.hl + 4) return 99;
    return Math.abs(dx * fz - dz * fx);
  }

  // ── The passenger in the back ──────────────────────────────────────────────

  /** Single player: the fare sits in the rear seat, placed with the other riders (ent/occupants.ts demo). In a shared town net/jobs.ts seats them. */
  private seat(v: Vehicle): void {
    const g = this.game, occ = g.occupants;
    if (this.host.shared()) { this.unseat(); return; }
    const n = PASSENGER_SEATS[v.spec.kind].length, at = { x: v.x, y: v.y, z: v.z };
    if (!n || !seatSpot(v, Math.min(2, n - 1), at)) return;
    if (!this.seated) this.seated = g.people.spawn(at.x, at.z, v.h);
    if (!this.demo) { this.demo = { v, seat: Math.min(2, n - 1), p: this.seated }; occ.demo.push(this.demo); }
    this.demo.v = v;
    this.seated.occupant = true;
  }

  private unseat(): void {
    const g = this.game;
    if (this.demo) { const i = g.occupants.demo.indexOf(this.demo); if (i >= 0) g.occupants.demo.splice(i, 1); this.demo = null; }
    if (this.seated) { g.people.remove(this.seated); this.seated = null; }
  }

  private markers(d: Pt): void { this.game.todo.markers.put(d.x, d.z, 'job', this.phase === 0 ? 6 : 8, 28); }

  // ── The meter ──────────────────────────────────────────────────────────────

  private drawMeter(v: Vehicle | null): void {
    if (!v || this.phase !== 1) { this.clearMeter(); return; }
    const g = this.game, r = this.ride, s = this.shift, d = this.dest as Pt;
    if (g.state !== 'play') { if (this.meter) this.meter.style.visibility = 'hidden'; return; }
    const left = Math.hypot(v.x - d.x, v.z - d.z);
    const key = `${r.fare}|${r.bonus}|${r.tip}|${Math.round(r.smooth)}|${distText(left)}|${s.cash}|${Math.round(r.par - r.t)}`;
    let el = this.meter;
    if (!el) {
      el = this.meter = document.createElement('div');
      el.className = 'taxi-meter';
      el.style.cssText = 'position:fixed;' + (innerHeight < 520 ? 'right:0.9em;top:30%;' : 'right:15em;bottom:1em;') + 'z-index:12;width:13em;box-sizing:border-box;padding:0.55em 0.8em 0.6em;pointer-events:none;'
        + 'background:rgba(20,33,61,0.86);color:#f2e8cf;border-left:0.4em solid #e8b92c;border-radius:0.2em;font:500 clamp(11px,1.35vw,14px)/1.3 var(--f-body,system-ui),sans-serif;'
        + 'box-shadow:0 0.3em 1.2em rgba(0,0,0,0.35);';
      document.body.appendChild(el);
    }
    el.style.visibility = 'visible';
    if (key === this.meterKey) return;
    this.meterKey = key;
    const row = (a: string, b: string, c = ''): string => `<div style="white-space:nowrap;display:flex;justify-content:space-between;gap:0.8em;opacity:0.95"><span style="opacity:0.7">${a}</span><b style="font:600 1em var(--f-mono,monospace);${c}">${b}</b></div>`;
    const sm = Math.round(r.smooth), col = sm >= 80 ? '#8fd16a' : sm >= ROUGH_AT ? '#e8b92c' : '#e4572e';
    const ppar = Math.max(0, Math.round(r.par - r.t));
    const short = innerHeight < 520;
    const bar = `<div style="margin:0.3em 0 0.2em;height:0.45em;background:rgba(255,255,255,0.15);border-radius:0.25em;overflow:hidden"><div style="width:${sm}%;height:100%;background:${col}"></div></div>`;
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font:900 0.75em var(--f-head,'Arial Narrow'),sans-serif;letter-spacing:0.12em;color:#e8b92c">CAB METER</span>`
      + `<b style="font:600 1.7em/1 var(--f-mono,monospace)">${money(r.fare + r.bonus + r.tip)}</b></div>` + bar
      + (short ? row('To go', distText(left))
        : row('Fare', money(r.fare)) + row('Speed bonus', `+${money(r.bonus)}`, r.bonus > 0 ? 'color:#8fd16a' : 'opacity:0.5')
          + row('Tip', r.tip > 0 ? `+${money(r.tip)}` : 'none', r.tip > 0 ? 'color:#8fd16a' : 'color:#e4572e')
          + row('Smooth ride', `${sm}%`, `color:${col}`) + row('To go', `${distText(left)} · ${ppar > 0 ? clock(ppar) : 'late'}`)
          + `<div style="margin-top:0.25em;padding-top:0.2em;border-top:1px solid rgba(255,255,255,0.18)">${row('Shift', `${money(s.cash)} · ${s.fares}`)}</div>`);
  }

  private clearMeter(): void { if (this.meter) { this.meter.remove(); this.meter = null; this.meterKey = ''; } }

  // ── The shift summary ──────────────────────────────────────────────────────

  private showCard(rows: [string, string][], title: string): void {
    this.closeCard();
    const el = document.createElement('div');
    el.className = 'rush-card taxi-card';
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;width:min(30em,92vw);max-height:86vh;overflow:auto;box-sizing:border-box;'
      + 'padding:1em 1.3em 1.1em;background:var(--bone,#f2e8cf);color:var(--ink,#14213d);font:500 clamp(11px,1.5vw,15px)/1.3 var(--f-body,system-ui),sans-serif;'
      + 'box-shadow:0 0.6em 2.4em rgba(20,33,61,0.45);border-top:0.45em solid #e8b92c;cursor:pointer;pointer-events:auto;';
    const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    el.innerHTML = `<div style="display:flex;justify-content:space-between;font:600 0.8em var(--f-mono,monospace);letter-spacing:0.08em;text-transform:uppercase;opacity:0.7">`
      + `<span>Calamity Courtesy Cab · driver\'s log</span><span>Shift</span></div>`
      + `<div style="font:900 3.1em/0.95 var(--f-head,'Arial Narrow'),sans-serif;letter-spacing:0.02em;margin:0.2em 0 0.35em">${esc(title)}</div>`
      + rows.map(([a, b]) => `<div style="display:flex;justify-content:space-between;gap:1em;padding:0.32em 0;border-top:1px solid rgba(20,33,61,0.25)"><span style="opacity:0.72">${esc(a)}</span><b style="font:600 1.05em var(--f-mono,monospace);text-align:right">${esc(b)}</b></div>`).join('')
      + `<div style="margin-top:0.6em;font-size:0.82em;opacity:0.6">Tap or press G to close.</div>`;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.closeCard(); });
    document.body.appendChild(el);
    this.card = el; this.cardT = 14;
  }

  /** Called every frame by Activities, on or off duty, so the card closes by itself. */
  tickCard(dt: number): void {
    if (!this.card) return;
    this.cardT -= dt;
    if (this.cardT <= 0 || (this.cardT < 13.5 && this.game.input.eat('interact'))) this.closeCard();
  }

  closeCard(): void { if (this.card) { this.card.remove(); this.card = null; } }
  get cardOpen(): boolean { return !!this.card; }
}
