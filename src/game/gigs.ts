// Gigs (fun queue 2, item 14): delivery jobs between REAL directory businesses (world/directory.ts, doors from world/business.ts).
//
//   the board   the Gigs chip in the Places panel on the map lists orders near you with the pay; and at a business's door, in
//               a car, stopped, G takes an order from that very counter. An order comes FROM a business whose trade fits the
//               cargo, TO another business or a house.
//   cargo       pizza     (food places)            hot: a clock; the pie cools and cold pizza pays less
//               flowers   (florists and shops)     fragile: every bump bruises them
//               hardware  (hardware, auto, tyres)  heavy: the car handles sluggishly (a lower top speed, more drag)
//               pharmacy  (pharmacies)             a paper bag; mind the knocks a little
//               bakery    (bakeries, donuts)       a cake box: fragile, a little
//               furniture (Pardon's, furniture)    BIG: needs a pickup, a van or a tow truck; heavy too
//   vehicles    small orders (pizza, flowers, pharmacy, bakery) go in any car, or on a bike or scooter with a wicker basket.
//               hardware needs a car (not a cycle); furniture needs a pickup, van or tow truck: the order says so.
//   the run     accept; the route line goes to the pickup door (game/nav.ts); stop there in a vehicle that can carry it and the
//               item appears in the car (on the roof, in the bed) or the basket; the route then goes to the drop; stop at the
//               door and the customer pays, with a line in the town's humour. Fare = base + distance by road, a speed bonus
//               over the par time, times what is left of the cargo's condition (heat or bruises).
//   the shift   a new order from where you are is offered at once; G, stopped, ends the shift: summary card and best shift
//               (save.best.gig, the leaderboard's "Best delivery shift").
//
// The island has no directory (Tepid Falls is the only real town in it), so its few counters are the story's own buildings
// (the bait shop, the arcade, Marlowe's yard, the dock office) lent a trade, with a door on the curb in front.
//
// Kid mode: a cold pizza is only a joke, bumps cost a third as much and pay never falls under 80%.
// Everything is this browser's own: a personal job (the car is held like the other jobs' cars); no messages, no protocol.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import { isCycleKind, isBoatKind, type VehicleKind } from '../ent/vehicleSpecs';
import { places, ARRIVE, type Category, type Place } from '../world/business';
import { BUILDING_SITES } from '../world/buildings';
import { progress } from '../world/progress';
import { kid } from '../core/kid';
import { money } from '../core/util';
import { save } from './save';
import { taper } from './activities';
import { distText } from './nav';
import { clock, type Markers, type Pt } from './script';

export type Cargo = 'pizza' | 'flowers' | 'hardware' | 'pharmacy' | 'bakery' | 'furniture';
type Need = 'small' | 'car' | 'big';

interface CargoDef {
  id: Cargo; label: string; short: string; color: string;
  /** Strict match for a source (name), and the category fallback. */
  name: RegExp; cat: Category[];
  need: Need;
  base: number; per: number;
  /** Pizza: the pie is hot for this long past the par time, then cold (0: not a hot food). */
  hot: boolean;
  /** How hard a bump bruises it (0: not fragile); the car's sluggishness (0: none). */
  fragile: number; heavy: number;
  items: string[];
}

const CARGO: Record<Cargo, CargoDef> = {
  pizza: { id: 'pizza', label: 'Pizza', short: 'pizza', color: '#e4572e', name: /pizza|pie-zza|kitchen|grill|deli|cafe|diner|burger|buen|patties|slice/i, cat: ['food'], need: 'small', base: 16, per: 0.1, hot: true, fragile: 0, heavy: 0, items: ['a large pepperoni', 'two mediums, one regretful', 'a pie with everything but guilt', 'a family-size cheese', 'garlic knots and a pizza'] },
  flowers: { id: 'flowers', label: 'Flowers', short: 'flowers', color: '#d86c9d', name: /florist|petal|flower|garden|nursery|bloom/i, cat: [], need: 'small', base: 18, per: 0.11, hot: false, fragile: 1, heavy: 0, items: ['a dozen roses', 'a sympathy arrangement', 'a bouquet, apologetic', 'tulips, mixed', 'a corsage and a cactus'] },
  hardware: { id: 'hardware', label: 'Hardware', short: 'hardware', color: '#c9774f', name: /hardware|lumber|auto parts|tyre|garden center|agwhy|supply/i, cat: [], need: 'car', base: 26, per: 0.13, hot: false, fragile: 0, heavy: 1, items: ['a crate of lumber and a paint can', 'forty feet of chain', 'a sack of concrete mix', 'a box of fasteners, assorted', 'a snow shovel, early'] },
  pharmacy: { id: 'pharmacy', label: 'Pharmacy', short: 'pharmacy bag', color: '#2a9d8f', name: /pharmacy|apothec|drug/i, cat: [], need: 'small', base: 20, per: 0.1, hot: false, fragile: 0.35, heavy: 0, items: ['a prescription and a lollipop', 'cough drops, bulk', 'a bag of vitamins and regrets', 'bandages, assorted'] },
  bakery: { id: 'bakery', label: 'Bakery', short: 'cake box', color: '#e9a0a8', name: /bakery|donut|bagel|bread|pastr|pie\b/i, cat: [], need: 'small', base: 16, per: 0.1, hot: false, fragile: 0.7, heavy: 0, items: ['a birthday cake, three tiers', 'two dozen donuts', 'a loaf and a half', 'a sheet cake that says Sorry'] },
  furniture: { id: 'furniture', label: 'Furniture', short: 'armchair', color: '#8a4f3a', name: /furniture|pardon|drapey|mattress|surplus/i, cat: [], need: 'big', base: 40, per: 0.16, hot: false, fragile: 0, heavy: 0.8, items: ['an armchair, slightly used', 'a loveseat, very used', 'a recliner with opinions', 'a bookcase, flat-ish'] },
};
const CARGOS = Object.keys(CARGO) as Cargo[];

const NEED_TEXT: Record<Need, string> = { small: 'any vehicle, bikes and scooters too (basket)', car: 'a car (not a bike)', big: 'a pickup, van or tow truck' };

/** Can this vehicle carry that? */
export function carries(kind: VehicleKind, need: Need): boolean {
  if (isBoatKind(kind) || kind === 'train' || kind === 'bus') return false;
  if (need === 'small') return true;
  if (isCycleKind(kind)) return false;
  if (need === 'car') return true;
  return kind === 'pickup' || kind === 'van' || kind === 'tow';
}

/** A place an order starts or ends at: a directory place, or a made-up one (an island counter, a house). */
export type Spot = Place & { house?: boolean };

export interface Gig {
  id: number; cargo: Cargo; item: string;
  from: Spot; to: Spot;
  /** Road metres from the pickup to the drop. */
  len: number;
  /** The fare before bonus and condition. */
  fare: number;
  /** Seconds the drop should take from the pickup. */
  par: number;
}

// ── Lines ───────────────────────────────────────────────────────────────────

const L = {
  pizza: ['It is warm. Is warm a kind of hot? I am choosing yes.', 'Finally. I was about to eat the menu.', 'You are the first one this week that did not leave it with the neighbour.', 'Pepperoni! Somebody in this house will be told about it.'],
  flowers: ['They are for my mother. She will say the colour is wrong.', 'They look nothing like the picture. They look better. Do not tell the picture.', 'Roses. I am going to be in so much less trouble.', 'You carried flowers in a car. That is the most romantic thing that has happened here.'],
  hardware: ['That is heavy. I asked for heavy. I got heavy.', 'Now I can finish the project. The project is a shelf. It has been a shelf for two years.', 'Is that the right paint? It is a colour. I will allow it.', 'You delivered a hardware store to my door. I am moved.'],
  pharmacy: ['Thank you. I would offer you something for your nerves but you brought it.', 'Right on time. My cough is still not.', 'It is only a bag. It is also the best bag.', 'The lollipop was a nice touch. Not mine. The pharmacist.'],
  bakery: ['It is still standing! The cake is still standing!', 'Look at it. Look. Now I cannot eat it. Yes I can.', 'Warm donuts. This is how I will be remembered.', 'The box is only a little bit sad. That is a pass.'],
  furniture: ['You fit that in THAT? Do you want a job? You have a job. Do it more.', 'It is bigger than the doorway. We will worry about the doorway.', 'Put it in the room. Not that room. The other room. No. Back.', 'A loveseat arrived by car. It has been a day.'],
};
const L_KID = {
  pizza: ['Pizza! Is it hot? It is hot! Yay!', 'Thank you! It smells like a good day.'],
  flowers: ['They are pretty! Thank you, driver!', 'Flowers! I will put them in the big cup.'],
  hardware: ['Wow, that is a lot of stuff! Thank you!', 'Now we can build the fort!'],
  pharmacy: ['Thank you! Here is a sticker for you.', 'Thank you, driver! Feel better, everyone.'],
  bakery: ['A cake! Is it my birthday? It is now!', 'Yum. I mean, thank you.'],
  furniture: ['A big chair! Can I sit in it first?', 'Wow, it fit in the car! Thank you!'],
};
const COLD = ['This pizza is the temperature of the room. The room is cold.', 'Cold pizza is a food group, I read.', 'I will heat it. Thank you for the opportunity.'];
const COLD_KID = ['It is only a little cool. Still pizza!', 'Cool pizza is still the best pizza. Maybe.'];
const BRUISED = ['They have been through something. So have I.', 'Are they supposed to lean like that?', 'Half of them survived. I respect that.', 'It is not damage. It is character.'];
const BRUISED_KID = ['A little squished. Still lovely!', 'Squished, but with love.'];
const LATE = ['You are late, but only mathematically.', 'I had stopped waiting. It was freeing.', 'The clock was a suggestion. You listened.'];
const BUMP = ['That sounded like the goods.', 'I heard that from the passenger seat. There is no passenger.', 'Something in the back said ow.'];
const BUMP_KID = ['Oops. A bump. Careful with it!', 'Whoa, careful!'];
const PICKUP = ['Here you go. If it is wrong, we never met.', 'Careful with that. I have just put it in your hands. And your car.', 'It is all yours. Sign nothing.', 'Go. Gently, but go.'];

/** Pay never falls below this share in kid mode. */
const KID_FLOOR = 0.8;

interface Shift { orders: number; cash: number; tips: number; bumps: number; cold: number; bruised: number; best: number; t: number; late: number }
const blank = (): Shift => ({ orders: 0, cash: 0, tips: 0, bumps: 0, cold: 0, bruised: 0, best: 0, t: 0, late: 0 });

interface Run { gig: Gig; phase: 0 | 1; t: number; heat: number; cond: number; hurt: number }

const mk = (name: string, cat: Category, x: number, z: number, nx = 0, nz = 1, house = false, id = -300): Spot => ({
  id, name, cat, x, z, nx, nz, wx: x, wz: z, rx: x, rz: z, placed: true, open: false, game: true, sign: false, at: house ? 'house' : 'gig', house,
});

/** Island counters: a story building lent a trade (the site is BUILDING_SITES[site]; fallback: where it stands). */
const ISLAND: { name: string; cargo: Cargo; cat: Category; site: string; fx: number; fz: number }[] = [
  { name: 'The Arcade Slice (Strand Blvd)', cargo: 'pizza', cat: 'food', site: 'gus', fx: 34, fz: 310 },
  { name: "Finch's Bait, Tackle & Bouquets", cargo: 'flowers', cat: 'shops', site: 'finch', fx: -16, fz: 309 },
  { name: "Marlowe's Hardware & Towing", cargo: 'hardware', cat: 'auto', site: 'marlowe', fx: -397, fz: 276 },
  { name: 'Dock Seven Dispensary', cargo: 'pharmacy', cat: 'health', site: 'dockOffice', fx: 327, fz: 248 },
  { name: 'The Second Rate Bakery', cargo: 'bakery', cat: 'food', site: 'vance', fx: 60, fz: 40 },
  { name: 'Calamity Used Furniture Barn', cargo: 'furniture', cat: 'shops', site: 'room404', fx: -85, fz: 130 },
];

export class Gigs {
  prompt: string | null = null;
  target: Pt | null = null;
  targetName: string | null = null;
  readonly shift: Shift = blank();
  /** The order in hand (null: none). */
  run: Run | null = null;

  private ride: Vehicle | null = null;
  private awayT = 0; private idleT = 0;
  private nextId = 1;
  private cache: { x: number; z: number; t: number; list: Gig[] } | null = null;
  private island: Spot[] | null = null;
  private on = false;
  private hitCool = 0;
  private lines = 0;
  private meter: HTMLDivElement | null = null; private meterKey = '';
  private card: HTMLDivElement | null = null; private cardT = 0;
  private load: THREE.Group | null = null; private loadFor: Vehicle | null = null; private loadCargo: Cargo | null = null;
  private mats: Record<string, THREE.Material> | null = null;
  private box: THREE.BufferGeometry | null = null;
  private scanT = 0;
  private person: { p: import('../core/api').Person; t: number } | null = null;
  private offerSpot: (Spot & { c?: Cargo }) | null = null;

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    game.on('impact', (e) => {
      const pv = game.player.vehicle, r = this.run;
      if (!r || r.phase !== 1 || !pv || e.speed < 4 || (e.vehicle !== pv && e.other !== pv) || this.hitCool > 0) return;
      this.hitCool = 0.7;
      this.bump(e.speed);
    });
    game.on('booked', () => this.stop('The Harbor Patrol has ended your shift for you.'));
  }

  get busy(): boolean { return this.on; }

  // ── The sources ────────────────────────────────────────────────────────────

  private plan() { const g = this.game; return g.plan.streets ?? g.plan; }

  /** The point in the curb lane of the street nearest (x, z), on the side toward (tx, tz). */
  private curb(x: number, z: number, tx: number, tz: number): Pt {
    const plan = this.game.plan, ne = plan.nearestEdge(x, z), e = ne.edge;
    const p = e.pts, c = e.cum;
    let qx: number, qz: number, dx: number, dz: number;
    if (p && c && p.length >= 4) {
      let k = 0;
      while (k < c.length - 2 && c[k + 1] < ne.s) k++;
      const ax = p[k * 2], az = p[k * 2 + 1], bx = p[k * 2 + 2], bz = p[k * 2 + 3], seg = Math.max(1e-3, c[k + 1] - c[k]), f = Math.min(1, Math.max(0, (ne.s - c[k]) / seg)), Ln = Math.hypot(bx - ax, bz - az) || 1;
      qx = ax + (bx - ax) * f; qz = az + (bz - az) * f; dx = (bx - ax) / Ln; dz = (bz - az) / Ln;
    } else {
      const A = plan.nodes[e.a];
      qx = e.horiz ? A.x + ne.s : A.x; qz = e.horiz ? A.z : A.z + ne.s; dx = e.horiz ? 1 : 0; dz = e.horiz ? 0 : 1;
    }
    const nx = -dz, nz = dx, side = (tx - qx) * nx + (tz - qz) * nz >= 0 ? 1 : -1, o = Math.max(1.5, Math.min(e.hw - 3.2, e.hw * 0.55));
    return { x: +(qx + nx * side * o).toFixed(2), z: +(qz + nz * side * o).toFixed(2) };
  }

  /** The island's lent counters, with a door on the curb in front. */
  private islandSpots(): Spot[] {
    if (this.island) return this.island;
    const out: Spot[] = [];
    ISLAND.forEach((s, i) => {
      const b = BUILDING_SITES[s.site], x = b ? b.x : s.fx, z = b ? b.z : s.fz;
      const c = this.curb(x, z, x, z);
      const sp = mk(s.name, s.cat, c.x, c.z, 0, 1, false, -300 - i);
      (sp as Spot & { cargo?: Cargo }).cargo = s.cargo;
      out.push(sp);
    });
    return (this.island = out);
  }

  /** Every counter that sells a cargo: the directory's by trade, and the island's lent ones. */
  private sources(c: Cargo, strict: boolean): Spot[] {
    const d = CARGO[c], g = this.game;
    const out: Spot[] = [];
    for (const p of places(g.plan)) {
      if (!p.placed || p.open) continue;
      if (c === 'pizza' && /bakery|donut|bagel/i.test(p.name) && !/pizza|pie-zza/i.test(p.name)) continue;
      if (d.name.test(p.name) && (c !== 'pizza' || p.cat === 'food') && (c !== 'bakery' || p.cat === 'food')) out.push(p);
      else if (!strict && d.cat.includes(p.cat) && !(c === 'pizza' && /bakery|donut|bagel/i.test(p.name))) out.push(p);
    }
    for (const s of this.islandSpots()) if ((s as Spot & { cargo?: Cargo }).cargo === c) out.push(s);
    return out;
  }

  private landOf(x: number, z: number): number { return this.plan().nearestNode(x, z).land; }

  /** Road metres from a to b, or -1. */
  private road(a: Pt, b: Pt): number {
    const plan = this.plan(), na = plan.nearestNode(a.x, a.z), nb = plan.nearestNode(b.x, b.z);
    if (na.land !== nb.land || na.id === nb.id) return -1;
    const ids = plan.findPath(na.id, nb.id);
    if (ids.length < 2) return -1;
    let len = 0;
    for (let k = 1; k < ids.length; k++) len += Math.hypot(plan.nodes[ids[k]].x - plan.nodes[ids[k - 1]].x, plan.nodes[ids[k]].z - plan.nodes[ids[k - 1]].z);
    return len;
  }

  /** A house: the kerb at a street corner on the pickup's side, with an address. */
  private house(from: Pt): Spot | null {
    const g = this.game, plan = this.plan(), a = plan.nearestNode(from.x, from.z), pool = plan.nodes.filter((n) => {
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      return d > 160 && d < 800 && n.land === a.land && n.edges.some((e) => !plan.edges[e].closed && !plan.edges[e].deck);
    });
    for (let tries = 0; tries < 14 && pool.length; tries++) {
      const n = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const at = { x: n.x + (Math.random() < 0.5 ? -1 : 1) * (n.hx + 1.8), z: n.z + (Math.random() < 0.5 ? -1 : 1) * (n.hz + 1.8) };
      const len = this.road(from, at);
      if (len < 150 || len > 1100) continue;
      return mk(`${3 + Math.floor(Math.random() * 196)} ${g.plan.streetAt(at.x, at.z)}`, 'civic', at.x, at.z, 0, 1, true, -400);
    }
    return null;
  }

  /** One order from a counter, or null if no drop can be found. */
  make(cargo: Cargo, from: Spot): Gig | null {
    const g = this.game, d = CARGO[cargo];
    const biz = places(g.plan).filter((p) => p.placed && !p.open && p !== from && p.name !== from.name);
    const island = this.islandSpots().filter((p) => p !== from);
    let to: Spot | null = null, len = -1;
    for (let tries = 0; tries < 24 && !to; tries++) {
      const useHouse = Math.random() < 0.4;
      let cand: Spot | null = null;
      if (useHouse) cand = this.house(from);
      else {
        const pool = [...biz, ...island], q = pool[Math.floor(Math.random() * pool.length)];
        if (q && Math.hypot(q.x - from.x, q.z - from.z) > 140 && Math.hypot(q.x - from.x, q.z - from.z) < 800) cand = q;
      }
      if (!cand) continue;
      const l = this.road(from, cand);
      if (l >= 160 && l <= 1100) { to = cand; len = l; }
    }
    if (!to) return null;
    return { id: this.nextId++, cargo, item: d.items[Math.floor(Math.random() * d.items.length)], from, to, len, fare: Math.round(d.base + len * d.per), par: Math.round(len / 8.5 + 22) };
  }

  /** Orders near a point, nearest pickup first: a handful, a mix of cargo (new ones every half minute). */
  board(): Gig[] {
    const p = this.game.player, c = this.cache;
    if (c && Math.hypot(c.x - p.x, c.z - p.z) < 120 && performance.now() - c.t < 30_000) return c.list;
    const land = this.landOf(p.x, p.z), list: Gig[] = [];
    for (const cargo of CARGOS) {
      const src = this.sources(cargo, false).filter((s) => this.landOf(s.x, s.z) === land && Math.hypot(s.x - p.x, s.z - p.z) < 1800).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      if (!src.length) continue;
      for (let k = 0; k < (cargo === 'furniture' ? 1 : 2) && src.length > k; k++) {
        const s = src[Math.min(src.length - 1, k + Math.floor(Math.random() * 2))], gg = this.make(cargo, s);
        if (gg && !list.some((q) => q.from === gg.from && q.cargo === gg.cargo)) list.push(gg);
      }
    }
    list.sort((a, b) => Math.hypot(a.from.x - p.x, a.from.z - p.z) - Math.hypot(b.from.x - p.x, b.from.z - p.z));
    this.cache = { x: p.x, z: p.z, t: performance.now(), list };
    return list;
  }

  /** Pay shown on the board and on the card: the fare, and what a quick run could add. */
  payText(g: Gig): string { return `${money(g.fare)} · up to ${money(Math.round(g.fare * 1.3))}`; }
  needText(g: Gig): string { return NEED_TEXT[CARGO[g.cargo].need]; }
  cargoDef(c: Cargo): CargoDef { return CARGO[c]; }

  // ── Accepting and ending ───────────────────────────────────────────────────

  /** Take an order (the panel, or a counter's G). False if something else has the floor. */
  accept(gig: Gig): boolean {
    const g = this.game;
    if (!this.isFree() || this.on) return false;
    if (g.player.health <= 0) return false;
    Object.assign(this.shift, blank());
    this.closeCard();
    this.on = true; this.awayT = 0; this.idleT = 0; this.lines = 0;
    this.setBusy('gig');
    this.begin(gig);
    g.hud.toast(`Order: ${CARGO[gig.cargo].label.toLowerCase()} from ${gig.from.name}. Follow the route to the door; ${this.needText(gig)}. G (stopped, off the route) ends the shift.`, 8);
    return true;
  }

  private begin(gig: Gig): void {
    this.run = { gig, phase: 0, t: 0, heat: 100, cond: 100, hurt: 0 };
    this.target = { x: gig.from.x, z: gig.from.z }; this.targetName = gig.from.name;
    this.cache = null;
  }

  /** End the shift (the panel's Cancel, G, leaving the vehicle, or the Harbor Patrol). */
  stop(why?: string, card = true): void {
    if (!this.on) return;
    const g = this.game, s = this.shift;
    this.on = false; this.run = null;
    if (this.ride) { this.ride.held = false; this.ride = null; }
    this.target = null; this.targetName = null;
    this.syncLoad(null);
    this.clearMeter();
    g.hud.objective(null); g.hud.timer(null);
    if (why) g.hud.toast(why, 5);
    this.setBusy(null);
    if (card && s.orders > 0) {
      const record = save.record('gig', s.cash, false);
      this.showCard([
        ['Orders delivered', String(s.orders)], ['Best order', money(s.best)], ['Speed bonuses and tips', money(s.tips)],
        ['Cold or squashed', `${s.cold} cold · ${s.bruised} bruised`], ['Bumps · late', `${s.bumps} · ${s.late}`],
        ['On shift', clock(s.t)], ['Earned this shift', money(s.cash)], ['Best shift', `${money(save.data.best.gig ?? s.cash)}${record ? ' · NEW' : ''}`],
      ], s.orders >= 5 ? 'GREAT SHIFT' : s.orders >= 2 ? 'SHIFT OVER' : 'ONE ORDER');
    }
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  blips(out: Blip[]): void {
    const r = this.run;
    if (this.on && r) { out.push({ x: this.target?.x ?? 0, z: this.target?.z ?? 0, kind: 'goal', label: r.phase === 0 ? 'P' : 'D' }); return; }
    if (!this.isFree()) return;
    // The nearby counters that take orders, a small teal G on the radar.
    const p = this.game.player;
    for (const c of CARGOS) for (const s of this.sources(c, true)) if (Math.hypot(s.x - p.x, s.z - p.z) < 250) out.push({ x: s.x, z: s.z, kind: 'job', label: 'G' });
  }

  update(dt: number, taken: boolean): void {
    const g = this.game, p = g.player, v = p.vehicle;
    this.prompt = null;
    this.hitCool = Math.max(0, this.hitCool - dt);
    this.tickCard(dt);
    this.tickPerson(dt);
    if (!this.on) { this.target = null; this.syncLoad(null); if (this.isFree() && !taken) this.offer(dt, v); return; }
    if (!this.run) { this.stop(undefined, false); return; }
    const r = this.run as Run;
    if (!(p.health > 0)) { this.stop('Shift over. Mercy General does not take pizza.'); return; }
    this.shift.t += dt; r.t += dt;
    const d = r.gig, need = CARGO[d.cargo].need;
    const ok = !!v && carries(v.spec.kind, need);
    // Carrying: out of a vehicle that can take it, a grace period, then the order is returned. (Any such vehicle will do.)
    if (r.phase === 1 && !(v && carries(v.spec.kind, need))) {
      this.awayT += dt;
      this.syncLoad(null);
      g.hud.objective(`Get back in ${NEED_TEXT[need]}: the ${CARGO[d.cargo].short} is waiting, or the order goes back.`);
      if (this.awayT > 45) this.stop('The order went back to the counter. They will remember this.');
      return;
    }
    this.awayT = 0;
    if (r.phase === 1 && v) { this.hold(v); this.syncLoad(v); this.effects(dt, v, r); }
    else this.syncLoad(null);
    const t = this.target as Pt;
    this.markers.put(t.x, t.z, 'job', r.phase === 0 ? 7 : 8, 28);
    const slow = !!v && Math.abs(v.speed) < 3;
    if (r.phase === 0) {
      g.hud.objective(`Pick up ${d.item} at ${d.from.name}, ${g.plan.streetAt(t.x, t.z)}.${ok ? '' : ` Needs ${NEED_TEXT[need]}.`}`);
      g.hud.timer(null);
      this.drawMeter(null);
      const near = v ? Math.hypot(v.x - t.x, v.z - t.z) < ARRIVE + 2 : Math.hypot(p.x - t.x, p.z - t.z) < 6;
      if (v && !ok && near && slow && this.scanT <= 0) { g.hud.toast(`${d.from.name} needs ${NEED_TEXT[need]} for this one.`, 4); this.scanT = 6; }
      this.scanT = Math.max(0, this.scanT - dt);
      if (v && ok && near && slow) { this.pickup(v); return; }
      if (slow && !near && this.shift.t > 2) {
        this.prompt = '[G] End the shift';
        if (g.input.eat('interact') && this.shift.t > 1.5) this.stop();
      }
      return;
    }
    // Carrying.
    const vv = v as Vehicle;
    const def = CARGO[d.cargo], eta = Math.max(0, d.par - r.t);
    g.hud.objective(`Deliver ${d.item} to ${d.to.name}${d.to.house ? '' : ', ' + g.plan.streetAt(t.x, t.z)}.`);
    const pay = this.pay(r);
    g.hud.timer(def.hot ? 'Pizza heat' : 'Order', def.hot ? `${Math.round(r.heat)}% · ${money(pay.total)}` : `${money(pay.total)} · ${eta > 0 ? clock(Math.round(eta)) : 'late'}`, (def.hot && r.heat < 35 && !kid.on) || (!def.hot && eta <= 0 && !kid.on));
    this.drawMeter(vv);
    if (Math.hypot(vv.x - t.x, vv.z - t.z) < ARRIVE + 1 && Math.abs(vv.speed) < 3) this.arrive(vv);
  }

  /** The cargo's own physics while it rides: the pie cools, the heavy load drags. */
  private effects(dt: number, v: Vehicle, r: Run): void {
    const def = CARGO[r.gig.cargo];
    if (def.hot) r.heat = Math.max(0, 100 * (1 - r.t / (r.gig.par * 1.25)));
    if (def.heavy > 0) {
      const k = def.heavy, cap = v.spec.topSpeed * (1 - 0.3 * k), sp = Math.hypot(v.vx, v.vz);
      if (sp > cap) { const f = cap / sp; v.vx *= f; v.vz *= f; }
      else { const f = Math.max(0, 1 - 0.18 * k * dt); v.vx *= f; v.vz *= f; }
      v.yawRate *= Math.max(0, 1 - 1.4 * k * dt);
    }
  }

  private hold(v: Vehicle): void {
    if (this.ride === v) return;
    if (this.ride) this.ride.held = false;
    this.ride = v; v.held = true;
  }

  private pickup(v: Vehicle): void {
    const g = this.game, r = this.run as Run;
    r.phase = 1; r.t = 0; r.heat = 100; r.cond = 100;
    this.target = { x: r.gig.to.x, z: r.gig.to.z }; this.targetName = r.gig.to.name;
    this.hold(v);
    this.hitCool = 0.6;
    g.hud.toast(`Picked up ${r.gig.item} at ${r.gig.from.name}. ${this.carriedAs(v, r.gig)}`, 5);
    g.hud.subtitle('CLERK', PICKUP[this.lines++ % PICKUP.length], 4);
    this.syncLoad(v);
    this.person = null;
  }

  private carriedAs(v: Vehicle, d: Gig): string {
    const def = CARGO[d.cargo], k = v.spec.kind;
    if (isCycleKind(k)) return `It rides in the basket. ${def.fragile ? 'Mind the bumps.' : def.hot ? 'Go before it cools.' : ''}`;
    if (def.heavy > 0) return `Heavy: the ${v.spec.name.toLowerCase().includes('van') ? 'van' : 'car'} will handle sluggishly.`;
    if (def.hot) return 'Go before it cools.';
    return def.fragile ? 'Mind the bumps.' : 'Off you go.';
  }

  // ── Pay ────────────────────────────────────────────────────────────────────

  private pay(r: Run): { fare: number; bonus: number; k: number; total: number } {
    const d = r.gig, def = CARGO[d.cargo], fare = d.fare;
    const bonus = Math.round(fare * 0.3 * Math.max(0, 1 - r.t / d.par));
    let k = 1;
    if (def.hot) k = kid.on ? 0.85 + 0.15 * r.heat / 100 : 0.5 + 0.5 * r.heat / 100;
    if (def.fragile > 0) k = Math.min(k, kid.on ? KID_FLOOR + (1 - KID_FLOOR) * r.cond / 100 : 0.35 + 0.65 * r.cond / 100);
    return { fare, bonus, k, total: Math.round((fare + bonus) * k) };
  }

  private bump(speed: number): void {
    const r = this.run as Run, def = CARGO[r.gig.cargo];
    this.shift.bumps++;
    if (def.fragile > 0) r.cond = Math.max(0, r.cond - Math.min(40, 5 + speed * 1.6) * def.fragile * (kid.on ? 0.35 : 1));
    this.game.hud.subtitle('CARGO', (kid.on ? BUMP_KID : BUMP)[this.lines++ % (kid.on ? BUMP_KID : BUMP).length], 3);
  }

  private arrive(v: Vehicle): void {
    const g = this.game, hud = g.hud, r = this.run as Run, s = this.shift, d = r.gig, def = CARGO[d.cargo];
    const pay = this.pay(r), late = r.t > d.par;
    const tp = taper(save.count('gig'));
    save.bump('gig');
    const cash = Math.round(pay.total * tp.cash), pts = Math.round(11 * tp.points);
    g.player.money += cash; save.credit(cash); save.data.stats.earned += cash;
    progress.add(pts);
    s.orders++; s.cash += cash; s.best = Math.max(s.best, cash); s.tips += Math.round(pay.bonus * pay.k * tp.cash);
    if (late) s.late++;
    const cold = def.hot && r.heat < 40, bruised = def.fragile > 0 && r.cond < 70;
    if (cold) s.cold++;
    if (bruised) s.bruised++;
    const bits = [`fare ${money(Math.round(pay.fare * pay.k * tp.cash))}`];
    if (pay.bonus >= 1) bits.push(`speed +${money(Math.round(pay.bonus * pay.k * tp.cash))}`);
    if (def.hot) bits.push(`${Math.round(r.heat)}% hot`);
    if (def.fragile > 0 && r.cond < 95) bits.push(`${Math.round(r.cond)}% fresh`);
    hud.toast(`${d.to.name}: ${money(cash)} (${bits.join(' · ')}). ${pts} toward the bridge.`, 6);
    const pool = cold ? (kid.on ? COLD_KID : COLD) : bruised ? (kid.on ? BRUISED_KID : BRUISED) : late && !kid.on ? LATE : (kid.on ? L_KID : L)[d.cargo];
    hud.subtitle('CUSTOMER', pool[this.lines++ % pool.length], 5);
    this.customer(d.to, v);
    this.target = null; this.targetName = null; this.run = null;
    this.syncLoad(null);
    hud.timer(null); this.clearMeter();
    // Chain: the next order from the nearest counter that can use this vehicle.
    const next = this.nextFor(v);
    if (next) { this.begin(next); hud.toast(`Next order: ${CARGO[next.cargo].label.toLowerCase()} from ${next.from.name}, ${distText(Math.hypot(next.from.x - v.x, next.from.z - v.z))} off.`, 6); }
    else this.stop('That was the last order in town.');
  }

  /** The next order after a drop: a counter near the vehicle whose cargo it can carry. */
  private nextFor(v: Vehicle): Gig | null {
    const order = CARGOS.filter((c) => carries(v.spec.kind, CARGO[c].need));
    for (let tries = 0; tries < 12 && order.length; tries++) {
      const c = order[Math.floor(Math.random() * order.length)];
      const land = this.landOf(v.x, v.z);
      const src = this.sources(c, false).filter((q) => this.landOf(q.x, q.z) === land && Math.hypot(q.x - v.x, q.z - v.z) < 900 && Math.hypot(q.x - v.x, q.z - v.z) > 30)
        .sort((a, b) => Math.hypot(a.x - v.x, a.z - v.z) - Math.hypot(b.x - v.x, b.z - v.z));
      if (!src.length) continue;
      const gg = this.make(c, src[Math.floor(Math.random() * Math.min(3, src.length))]);
      if (gg) return gg;
    }
    return null;
  }

  private customer(at: Spot, v: Vehicle): void {
    try {
      const g = this.game;
      const dx = at.x - v.x, dz = at.z - v.z, d = Math.hypot(dx, dz) || 1;
      const p = g.people.spawn(at.x + dz / d * 3, at.z - dx / d * 3, Math.atan2(v.x - at.x, v.z - at.z));
      p.pose = 'stand';
      if (this.person) g.people.remove(this.person.p);
      this.person = { p, t: 6 };
    } catch { /* a missing customer is fine */ }
  }

  private tickPerson(dt: number): void {
    if (!this.person) return;
    this.person.t -= dt;
    if (this.person.t <= 0) { this.game.people.remove(this.person.p); this.person = null; }
  }

  // ── At a counter ───────────────────────────────────────────────────────────

  /** A counter at hand, in a vehicle, stopped: G takes an order from it. */
  private offer(dt: number, v: Vehicle | null): void {
    const g = this.game, p = g.player;
    this.idleT += dt;
    if (!v || Math.abs(v.speed) > 3 || p.heat > 0 || isBoatKind(v.spec.kind) || v.spec.kind === 'train' || v.spec.kind === 'bus') { this.offerSpot = null; return; }
    const k = v.spec.kind;
    // (The taxi, the van and the tow truck have their own offers at a stop; their orders are taken from the panel.)
    if (k === 'taxi' || k === 'tow' || k === 'van') { this.offerSpot = null; return; }
    if (this.idleT > 0.4 || !this.offerSpot) {
      this.idleT = 0; this.offerSpot = null;
      outer: for (const c of CARGOS) {
        if (!carries(k, CARGO[c].need)) continue;
        for (const s of this.sources(c, true)) if (Math.hypot(v.x - s.x, v.z - s.z) < ARRIVE + 4) { this.offerSpot = { ...s, c } as Spot; break outer; }
      }
    }
    const s = this.offerSpot;
    if (!s || !s.c || Math.hypot(v.x - s.x, v.z - s.z) > ARRIVE + 6) return;
    this.prompt = `[G] Take a ${CARGO[s.c].short} order from ${s.name}`;
    if (g.input.eat('interact')) {
      const gg = this.make(s.c, s);
      if (!gg) { g.hud.toast('No orders come in. The phone is ringing in somebody else\'s town.', 4); return; }
      this.offerSpot = null;
      this.accept(gg);
    }
  }

  // ── The load ───────────────────────────────────────────────────────────────

  private kit(): Record<string, THREE.Material> {
    if (this.mats) return this.mats;
    const m = (color: number, rough = 0.8, extra: object = {}): THREE.Material => new THREE.MeshStandardMaterial({ color, roughness: rough, ...extra });
    this.box = new THREE.BoxGeometry(1, 1, 1);
    return (this.mats = {
      cream: m(0xf1e6cf, 0.9), red: m(0xd2342a, 0.7), wood: m(0xb98d5a, 0.95), dark: m(0x6b4a2b, 0.9), wicker: m(0x9a6a3a, 0.95),
      pink: m(0xe9a0a8, 0.8), white: m(0xf4f4ee, 0.9), green: m(0x2f8f5b, 0.7), stem: m(0x3f7a3a, 0.8), paint: m(0xe4572e, 0.5, { metalness: 0.3 }),
      sofa: m(0x8a4f3a, 0.85), steel: m(0xc9ccd0, 0.35, { metalness: 0.8 }), petal1: m(0xd86c9d, 0.6), petal2: m(0xf0a202, 0.6), petal3: m(0xe4572e, 0.6), petal4: m(0xf2e8cf, 0.6),
    });
  }

  private part(parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0): THREE.Mesh {
    const me = new THREE.Mesh(this.box as THREE.BufferGeometry, mat);
    me.scale.set(sx, sy, sz); me.position.set(x, y, z); me.rotation.y = ry; me.castShadow = true;
    parent.add(me);
    return me;
  }

  /** One order's goods, origin at the bottom middle. */
  private item(c: Cargo): THREE.Group {
    const m = this.kit(), grp = new THREE.Group();
    if (c === 'pizza') {
      for (let i = 0; i < 3; i++) this.part(grp, m.cream, 0.44, 0.05, 0.44, 0, 0.03 + i * 0.055, 0, i * 0.12);
      this.part(grp, m.red, 0.46, 0.02, 0.1, 0, 0.19, 0);
    } else if (c === 'flowers') {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 10, 1, true), new THREE.MeshStandardMaterial({ color: 0xf4efe0, roughness: 0.9, side: THREE.DoubleSide }));
      cone.rotation.x = Math.PI; cone.position.y = 0.25; cone.castShadow = true; grp.add(cone);
      const heads = [m.petal1, m.petal2, m.petal3, m.petal4, m.petal1, m.petal3, m.petal2];
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * Math.PI * 2, rr = i === 0 ? 0 : 0.11;
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), heads[i]); s.position.set(Math.cos(a) * rr, 0.62 + (i % 3) * 0.04, Math.sin(a) * rr); s.castShadow = true; grp.add(s);
        this.part(grp, m.stem, 0.015, 0.3, 0.015, Math.cos(a) * rr * 0.6, 0.5, Math.sin(a) * rr * 0.6);
      }
    } else if (c === 'hardware') {
      this.part(grp, m.wood, 0.72, 0.4, 0.5, 0, 0.2, 0);
      this.part(grp, m.dark, 0.74, 0.04, 0.52, 0, 0.42, 0);
      this.part(grp, m.wood, 1.5, 0.06, 0.12, 0.05, 0.47, 0.12); this.part(grp, m.wood, 1.4, 0.06, 0.12, -0.1, 0.47, -0.1);
      const can = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.2, 12), m.paint); can.position.set(0.2, 0.55, 0.0); can.castShadow = true; grp.add(can);
    } else if (c === 'pharmacy') {
      this.part(grp, m.white, 0.3, 0.36, 0.18, 0, 0.18, 0);
      this.part(grp, m.green, 0.14, 0.04, 0.012, 0, 0.2, 0.095); this.part(grp, m.green, 0.04, 0.14, 0.012, 0, 0.2, 0.095);
      this.part(grp, m.white, 0.3, 0.04, 0.05, 0, 0.37, 0);
    } else if (c === 'bakery') {
      this.part(grp, m.pink, 0.44, 0.2, 0.44, 0, 0.1, 0);
      this.part(grp, m.white, 0.46, 0.012, 0.03, 0, 0.206, 0); this.part(grp, m.white, 0.03, 0.012, 0.46, 0, 0.206, 0);
    } else {
      this.part(grp, m.sofa, 0.9, 0.42, 0.85, 0, 0.21, 0);
      this.part(grp, m.sofa, 0.9, 0.6, 0.2, 0, 0.65, -0.33);
      this.part(grp, m.sofa, 0.16, 0.3, 0.85, -0.4, 0.55, 0); this.part(grp, m.sofa, 0.16, 0.3, 0.85, 0.4, 0.55, 0);
      this.part(grp, m.steel, 0.9, 0.04, 0.04, 0, 0.45, 0.2);
    }
    return grp;
  }

  private buildLoad(v: Vehicle, c: Cargo): void {
    this.load?.removeFromParent();
    const grp = new THREE.Group(), sp = v.spec, H = sp.height, Ln = sp.length, m = this.kit();
    const it = this.item(c);
    const k = sp.kind, cycle = isCycleKind(k), bed = k === 'pickup' || k === 'tow';
    if (cycle) {
      // A wicker basket on the front (the handlebars on a bike, the stem on a scooter), the goods inside it.
      const by = H * 0.55, bz = Ln * (k === 'bike' ? 0.34 : 0.3);
      this.part(grp, m.wicker, 0.4, 0.03, 0.32, 0, by, bz);
      this.part(grp, m.wicker, 0.4, 0.2, 0.025, 0, by + 0.1, bz + 0.16); this.part(grp, m.wicker, 0.4, 0.2, 0.025, 0, by + 0.1, bz - 0.16);
      this.part(grp, m.wicker, 0.025, 0.2, 0.32, 0.2, by + 0.1, bz); this.part(grp, m.wicker, 0.025, 0.2, 0.32, -0.2, by + 0.1, bz);
      it.position.set(0, by + 0.03, bz); it.scale.setScalar(c === 'flowers' ? 0.6 : c === 'pizza' ? 0.66 : 0.78);
    } else if (bed) it.position.set(0, 0.98, -Ln * 0.28);
    else it.position.set(0, H + 0.02, c === 'furniture' ? 0.1 : -0.1);
    if (!cycle && !bed && (c === 'hardware' || c === 'furniture')) it.rotation.y = Math.PI / 2 * 0;
    grp.add(it);
    this.game.scene.add(grp);
    this.load = grp; this.loadFor = v; this.loadCargo = c;
  }

  /** Keep the goods on the vehicle while the order rides (or take them off). */
  private syncLoad(v: Vehicle | null): void {
    const r = this.run;
    if (!v || !r || r.phase !== 1) { if (this.load) { this.load.removeFromParent(); this.load = null; this.loadFor = null; this.loadCargo = null; } return; }
    if (this.loadFor !== v || !this.load || this.loadCargo !== r.gig.cargo) this.buildLoad(v, r.gig.cargo);
    const grp = this.load as THREE.Group;
    const e = new THREE.Euler(-v.pitch, v.h, v.roll, 'YXZ');
    grp.quaternion.setFromEuler(e);
    grp.position.set(v.x, v.y, v.z);
  }

  // ── The meter ──────────────────────────────────────────────────────────────

  private drawMeter(v: Vehicle | null): void {
    const r = this.run;
    if (!v || !r || r.phase !== 1) { this.clearMeter(); return; }
    const g = this.game, s = this.shift, d = r.gig, def = CARGO[d.cargo], t = this.target as Pt;
    if (g.state !== 'play') { if (this.meter) this.meter.style.visibility = 'hidden'; return; }
    const pay = this.pay(r), left = Math.hypot(v.x - t.x, v.z - t.z), eta = Math.round(d.par - r.t);
    const level = def.hot ? r.heat : def.fragile > 0 ? r.cond : 100, lvName = def.hot ? 'Heat' : def.fragile > 0 ? 'Condition' : def.heavy > 0 ? 'Load' : 'Order';
    const key = `${pay.total}|${Math.round(level)}|${distText(left)}|${s.cash}|${eta}`;
    let el = this.meter;
    if (!el) {
      el = this.meter = document.createElement('div');
      el.className = 'gig-meter';
      el.style.cssText = 'position:fixed;' + (innerHeight < 520 ? 'right:0.9em;top:30%;' : 'right:15em;bottom:1em;') + 'z-index:12;width:13em;box-sizing:border-box;padding:0.55em 0.8em 0.6em;pointer-events:none;'
        + 'background:rgba(20,33,61,0.86);color:#f2e8cf;border-left:0.4em solid #2a9d8f;border-radius:0.2em;font:500 clamp(11px,1.35vw,14px)/1.3 var(--f-body,system-ui),sans-serif;box-shadow:0 0.3em 1.2em rgba(0,0,0,0.35);';
      document.body.appendChild(el);
    }
    el.style.visibility = 'visible';
    if (key === this.meterKey) return;
    this.meterKey = key;
    const row = (a: string, b: string, c = ''): string => `<div style="white-space:nowrap;display:flex;justify-content:space-between;gap:0.8em;opacity:0.95"><span style="opacity:0.7">${a}</span><b style="font:600 1em var(--f-mono,monospace);${c}">${b}</b></div>`;
    const col = level >= 70 ? '#8fd16a' : level >= 35 ? '#e8b92c' : '#e4572e';
    const bar = def.hot || def.fragile > 0 ? `<div style="margin:0.3em 0 0.2em;height:0.45em;background:rgba(255,255,255,0.15);border-radius:0.25em;overflow:hidden"><div style="width:${Math.round(level)}%;height:100%;background:${col}"></div></div>` : '<div style="height:0.3em"></div>';
    const short = innerHeight < 520;
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font:900 0.75em var(--f-head,'Arial Narrow'),sans-serif;letter-spacing:0.12em;color:#2a9d8f">${def.label.toUpperCase()}</span><b style="font:600 1.7em/1 var(--f-mono,monospace)">${money(pay.total)}</b></div>` + bar
      + (short ? row('To go', distText(left))
        : row('To', d.to.name.length > 22 ? d.to.name.slice(0, 21) + '…' : d.to.name) + (def.hot || def.fragile > 0 ? row(lvName, `${Math.round(level)}%`, `color:${col}`) : def.heavy > 0 ? row('Handling', 'heavy', 'color:#e8b92c') : '')
          + row('Speed bonus', `+${money(Math.round(pay.bonus * pay.k))}`, pay.bonus > 0 ? 'color:#8fd16a' : 'opacity:0.5') + row('To go', `${distText(left)} · ${eta > 0 ? clock(eta) : 'late'}`)
          + `<div style="margin-top:0.25em;padding-top:0.2em;border-top:1px solid rgba(255,255,255,0.18)">${row('Shift', `${money(s.cash)} · ${s.orders}`)}</div>`);
  }

  private clearMeter(): void { if (this.meter) { this.meter.remove(); this.meter = null; this.meterKey = ''; } }

  // ── The shift summary ──────────────────────────────────────────────────────

  private showCard(rows: [string, string][], title: string): void {
    this.closeCard();
    const el = document.createElement('div');
    el.className = 'rush-card gig-card';
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;width:min(30em,92vw);max-height:86vh;overflow:auto;box-sizing:border-box;'
      + 'padding:1em 1.3em 1.1em;background:var(--bone,#f2e8cf);color:var(--ink,#14213d);font:500 clamp(11px,1.5vw,15px)/1.3 var(--f-body,system-ui),sans-serif;'
      + 'box-shadow:0 0.6em 2.4em rgba(20,33,61,0.45);border-top:0.45em solid #2a9d8f;cursor:pointer;pointer-events:auto;';
    const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    el.innerHTML = `<div style="display:flex;justify-content:space-between;font:600 0.8em var(--f-mono,monospace);letter-spacing:0.08em;text-transform:uppercase;opacity:0.7"><span>Gigs · delivery log</span><span>Shift</span></div>`
      + `<div style="font:900 3.1em/0.95 var(--f-head,'Arial Narrow'),sans-serif;letter-spacing:0.02em;margin:0.2em 0 0.35em">${esc(title)}</div>`
      + rows.map(([a, b]) => `<div style="display:flex;justify-content:space-between;gap:1em;padding:0.32em 0;border-top:1px solid rgba(20,33,61,0.25)"><span style="opacity:0.72">${esc(a)}</span><b style="font:600 1.05em var(--f-mono,monospace);text-align:right">${esc(b)}</b></div>`).join('')
      + `<div style="margin-top:0.6em;font-size:0.82em;opacity:0.6">Tap or press G to close.</div>`;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.closeCard(); });
    document.body.appendChild(el);
    this.card = el; this.cardT = 14;
  }

  tickCard(dt: number): void {
    if (!this.card) return;
    this.cardT -= dt;
    if (this.cardT <= 0 || (this.cardT < 13.5 && this.game.input.eat('interact'))) this.closeCard();
  }
  closeCard(): void { if (this.card) { this.card.remove(); this.card = null; } }
  get cardOpen(): boolean { return !!this.card; }

  /** For the tests: the order in hand. */
  info(): { cargo: Cargo; phase: number; heat: number; cond: number; from: string; to: string; t: number } | null {
    const r = this.run;
    return r ? { cargo: r.gig.cargo, phase: r.phase, heat: r.heat, cond: r.cond, from: r.gig.from.name, to: r.gig.to.name, t: r.t } : null;
  }
}

