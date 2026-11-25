// Fun queue 2, item 30: the townsfolk. Twelve named people of Tepid Falls who live in the town and keep a day: the baker opens
// at six, walks her rolls to the cafe and the salon, the harbor master keeps the landing, a night nurse works the clinic, the
// mayor shuttles between the civic hall and lunch, a professor crosses the quad.
//
// Where a person is, is a pure function of the town clock (sky.hour) and a fixed route (townsfolkData.ts, made by
// tools/townsfolk/gen.mjs from the real businesses and house lots): [hour they arrive, stop] entries, and between two stops a
// walk along a path routed over open ground, off the paved road but for one crossing. The same hour gives the same place on every
// screen and on every page load, so nothing travels over the net and nothing is saved. A leg takes as long as it takes to walk
// (about 1.4 m per real second; an hour of the town clock is a minute), leaving early enough to arrive on the hour of the next
// entry; a short gap makes them hurry a little.
//
// Cheap: only a person within NEAR of the player is a real Person (the game's own skinned people, the same walk cycle and look
// system as the sidewalk crowd); every other one is just a number worked out when asked (the Places list). One name tag, shared,
// follows the nearest person within 14 m. Walk up and press G for a line that depends on the hour and where they are. They
// are not hurt by anything (health is held), and a person crossing a road is listed with the drivers like any pedestrian.
//
// Off under ?streets=old (the routes lie on the new Tepid Falls ground).

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Look, Person } from '../core/api';
import { dampAngle } from '../core/util';
import { setEmote } from '../ent/character';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import type { RoadPed } from '../sim/traffic';
import { TF_ROUTES, type TfRoute } from './townsfolkData';

/** People closer than this are real, beyond NEAR + 30 they go. */
const NEAR = 130;
/** Pace of a walk, metres per hour of the town clock (1.4 m/s, a minute an hour). */
const PER_HOUR = 84;
/** G reaches this far, on foot. */
const TALK = 3.2;
/** The name tag shows inside this. */
const TAG = 14;

interface Rule { at: string; from?: number; to?: number; say: string }
export interface Folk {
  id: string; name: string; role: string; look: Look;
  rules: Rule[];
}
const r = (at: string, say: string, from?: number, to?: number): Rule => ({ at, say, from, to });

// Looks: the game's own StyledLook details, fixed here so a person is recognisable every day.
const L = (o: Record<string, unknown>): Look => ({ hat: null, height: 1, build: 1, ...o }) as unknown as Look;
export const FOLK: Folk[] = [
  { id: 'mabel', name: 'Mabel Quince', role: 'Baker', look: L({ skin: 0xf3d3b8, hair: 0xe4dfd3, top: 0xf2e8cf, bottom: 0x2b3c5a, shoes: 0x7a5236, height: 0.96, build: 1.05, cut: 'bun', body: 'f', topKind: 'shirt', bottomKind: 'skirt', shoeKind: 'sneakers', face: 3, seed: 3011 }),
    rules: [
      r('shop', 'The rolls are out of the oven. Nobody has ever been disappointed by a roll. Well. Once.', 5, 10),
      r('shop', 'Afternoon rush: a pigeon, and a man who wants a muffin but not to pay for it.', 10, 19),
      r('shop', 'Crumbs Accepted. Bread is a promise, and I am a woman of my word, mostly.'),
      r('cafe', 'Delivering to Table for Maybe. They never decide how many, so I bring twelve.'),
      r('salon', 'Bad Bangs gets the day-old cinnamon ones. Nobody there is brave enough to complain.'),
      r('home', 'Oven is still warm, which is the only reason I am talking to you. Good night.', 18, 6),
      r('walk', 'Cannot stop. The dough does not know it is a weekday.'),
      r('*', 'Mind the crumbs. They are not for you. They are for the pigeons, who are union.'),
    ] },
  { id: 'harlan', name: 'Harlan Voss', role: 'Harbor Master', look: L({ skin: 0xd9a273, hair: 0xe4dfd3, top: 0x14213d, bottom: 0x2b2d33, shoes: 0x2b2d33, hat: 0xf2e8cf, height: 1.04, build: 1.12, cut: 'crop', body: 'm', topKind: 'jacket', bottomKind: 'trousers', hatKind: 'brim', shoeKind: 'boots', beard: true, face: 5, seed: 4412 }),
    rules: [
      r('jetty', 'Nothing comes ashore at this landing that I did not sign for. Mostly ducks.', 5, 12),
      r('jetty', 'Quiet afternoon on the river. That is when it is planning something.', 12, 19),
      r('depot', 'The Depot says the train is in principle. I say it is late on principle.'),
      r('pub', 'Off duty. The river will still be there tomorrow; I checked.'),
      r('home', 'Lights out soon. Fog tonight, I think. The river has opinions.', 19, 6),
      r('walk', 'On my rounds. A harbor master walks; a harbor does not.'),
      r('*', 'If it floats, I have a form for it. If it sinks, I have two.'),
    ] },
  { id: 'winnie', name: 'Winnie Aldous', role: 'Dog Walker', look: L({ skin: 0xe8b990, hair: 0x9c4326, top: 0x2a9d8f, bottom: 0x3d5a80, shoes: 0xf2e8cf, hat: 0xf0a202, height: 0.94, build: 0.95, cut: 'tail', body: 'f', topKind: 'hoodie', bottomKind: 'jeans', hatKind: 'cap', shoeKind: 'sneakers', face: 6, seed: 5521 }),
    rules: [
      r('bank', 'Biscuit is just behind that bush. He is shy of strangers and very good at hiding. I have never seen him.', 5, 13),
      r('square', 'Quorum Square at its best. The pigeons know me. The dog does not know the pigeons. Yet.'),
      r('bank', 'River Walk in the evening, my favorite. Biscuit says so too, with his whole body.'),
      r('home', 'Dinner time. His, then mine. Always in that order.', 19, 6),
      r('walk', 'Walkies! He pulls to the left. I pull to the right. We call that a plan.'),
      r('*', 'Have you seen a dog? Medium. Opinionated. Answers to nothing.'),
    ] },
  { id: 'ambrose', name: 'Prof. Ambrose Thistlewood', role: 'Dithers College', look: L({ skin: 0xf3d3b8, hair: 0x8e8d88, top: 0x8a9a6b, bottom: 0x45474d, shoes: 0x5a3a26, height: 1.03, build: 0.95, cut: 'part', body: 'm', topKind: 'jacket', bottomKind: 'trousers', shoeKind: 'boots', beard: 'stubble', glasses: true, bag: true, face: 4, seed: 6633 }),
    rules: [
      r('coffee', 'Coffee first, then ethics. The coffee has never once let me down.'),
      r('hall', 'Office hours are Tuesdays at no particular time. Do come in, and also go away.'),
      r('lunch', 'The Pennywhistle Dining Hall of Mystery Meat. I teach the mystery. The meat is self-taught.'),
      r('lecture', 'Procrastination Hall, two o\'clock. I will start on time tomorrow. I always do.'),
      r('home', 'Marking, by candlelight, because the bulb is under review.', 17, 8),
      r('walk', 'The quad is the shortest way, and also the longest. I have a paper on it.'),
      r('*', 'An interesting question. Write it down, hand it in, and I will not read it by Friday.'),
    ] },
  { id: 'gus', name: 'Gus Marrow', role: 'Fisherman', look: L({ skin: 0xc08a5c, hair: 0xe4dfd3, top: 0xf0a202, bottom: 0x45474d, shoes: 0x5a3a26, hat: 0x8a9a6b, height: 1.0, build: 1.18, cut: 'crop', body: 'm', topKind: 'jacket', bottomKind: 'trousers', hatKind: 'brim', shoeKind: 'boots', beard: true, face: 2, seed: 7744 }),
    rules: [
      r('dam', 'Old Tepid lives in that pool below the dam. Biggest fish in the county, and he knows my name.', 5, 12),
      r('dam', 'Afternoon bite is the slow bite. Stay quiet and you may be lucky. Talk, and you may be me.'),
      r('jetty', 'Smelt at the landing. Smell, mostly. Nobody has ever complained about the smell, to my face.'),
      r('home', 'Dinner is whatever I caught. So, beans.', 19, 5),
      r('walk', 'Got to see a man about a worm.'),
      r('*', 'Bring a hat, bring patience, and leave the hurry at home.'),
    ] },
  { id: 'ines', name: 'Ines Calloway', role: 'Shopkeeper', look: L({ skin: 0xa26b45, hair: 0x1d1a1a, top: 0x7fb0bd, bottom: 0x6f8fae, shoes: 0x14213d, height: 0.97, build: 0.98, cut: 'bob', body: 'f', topKind: 'dress', bottomKind: 'skirt', shoeKind: 'sneakers', glasses: true, face: 1, seed: 8855 }),
    rules: [
      r('shop', 'Lost-and-Found Consignment. Everything in here was lost, then found, and now it is priced accordingly.', 8, 18),
      r('square', 'Quorum Square at noon: pigeons, opinions, and me with a sandwich.'),
      r('bus', 'Waiting on the bus. It comes at about six. It has never said which six.'),
      r('home', 'Shop is shut, feet are up, and the kettle has started to mean it.', 18, 8),
      r('walk', 'Taking a long way round. The short way has a pigeon with a grudge.'),
      r('*', 'If you lost it, I probably have it. If you did not, I have two.'),
    ] },
  { id: 'tamsin', name: 'Tamsin Oyelaran', role: 'Night Nurse', look: L({ skin: 0x7d4d30, hair: 0x1d1a1a, top: 0x2a9d8f, bottom: 0x2b3c5a, shoes: 0xf2e8cf, height: 1.0, build: 0.98, cut: 'curls', body: 'f', topKind: 'shirt', bottomKind: 'trousers', shoeKind: 'sneakers', face: 7, seed: 9966 }),
    rules: [
      r('clinic', 'Night shift at Waiting Room Health. It is quiet. The vending machine is not.', 19, 8),
      r('clinic', 'Starting soon. Is it an emergency? No? Then it is a Tuesday.'),
      r('shop', 'Snacks for twelve hours. Do not judge the basket.'),
      r('home', 'I am off. I would tell you to get some sleep, but I know you will not.', 8, 17),
      r('walk', 'On my way in. If it is an emergency, call the clinic. I am in the middle of walking.'),
      r('*', 'Drink some water. Doctor\'s orders, and mine, and the vending machine\'s.'),
    ] },
  { id: 'cornelius', name: 'Mayor Cornelius Bascombe', role: 'Mayor', look: L({ skin: 0xd9a273, hair: 0x8e8d88, top: 0x14213d, bottom: 0x2b2d33, shoes: 0x2b2d33, height: 1.0, build: 1.14, cut: 'part', body: 'm', topKind: 'jacket', bottomKind: 'trousers', shoeKind: 'boots', face: 0, seed: 1177 }),
    rules: [
      r('hall', 'The Hall of Unfinished Toasts is open to everyone. Appointments are required.', 8, 18),
      r('cafe', 'Lunch with the people. I never leave a handshake unfinished. A toast, however, is another matter.'),
      r('tribunal', 'Mild grievances only, please. The serious ones go to a subcommittee.'),
      r('pizza', 'Off the record: the pizza is slightly burnt, and that is the endorsement.'),
      r('home', 'Re-elected on a sleepy Tuesday. Wouldn\'t have it any other way.', 21, 7),
      r('walk', 'Walking the town. A mayor who sits down is a mayor who gets a bill.'),
      r('*', 'I do not make promises. I make announcements. They are shorter.'),
    ] },
  { id: 'beppo', name: 'Beppo Lindqvist', role: 'Mail Carrier', look: L({ skin: 0xe8b990, hair: 0x3a2a20, top: 0x7fb0bd, bottom: 0x45474d, shoes: 0x2b2d33, hat: 0x14213d, height: 1.0, build: 1.0, cut: 'crop', body: 'm', topKind: 'shirt', bottomKind: 'shorts', hatKind: 'cap', shoeKind: 'sneakers', bag: true, face: 8, seed: 2288 }),
    rules: [
      r('office', 'The Dead Letter Office: where letters go to be thought about.'),
      r('clinic', 'Special delivery. Mostly bills; occasionally a get-well card, to the wrong address.'),
      r('cafe', 'Coffee break at Hush-Hush. The mail will wait. The mail always waits.'),
      r('table', 'Table for Maybe gets a postcard a week from a man who maybe lives in Florida.'),
      r('home', 'Boots off. Seventeen thousand steps, and one dog that finally respects me.', 19, 6),
      r('walk', 'Neither rain nor snow nor oh, look, rain.'),
      r('*', 'If it is addressed to you, you have it. If not, I am still thinking about it.'),
    ] },
  { id: 'lena', name: 'Lena Okafor', role: 'Barista', look: L({ skin: 0x5c3822, hair: 0x1d1a1a, top: 0xe4572e, bottom: 0x3d5a80, shoes: 0xf2e8cf, height: 0.97, build: 0.95, cut: 'afro', body: 'f', topKind: 'hoodie', bottomKind: 'jeans', shoeKind: 'sneakers', face: 6, seed: 3399 }),
    rules: [
      r('cafe', 'Brewed Under Protest: the coffee is hot, the protest is ongoing.', 6, 18),
      r('market', 'Beans for the shop. The butcher gives me a look. I give him one back, on the house.'),
      r('friend', 'Hush-Hush? I am not here. You did not see me. Two sugars, thanks.'),
      r('home', 'Smell of coffee on everything I own. It is my best feature.', 19, 6),
      r('walk', 'Delivering a flat white to a man who has been refused one. He will be pleased.'),
      r('*', 'Large, small, or "I can\'t decide"? Most people go with the last one.'),
    ] },
  { id: 'jo', name: 'Jo Ikeda', role: 'Student', look: L({ skin: 0xf3d3b8, hair: 0x1d1a1a, top: 0x9c4a3c, bottom: 0x2b3c5a, shoes: 0xe4572e, hat: 0x14213d, height: 1.0, build: 0.97, cut: 'crop', body: 'm', topKind: 'hoodie', bottomKind: 'jeans', hatKind: 'cap', capBack: true, shoeKind: 'sneakers', bag: true, face: 3, seed: 4400 }),
    rules: [
      r('books', 'Dithers Bookstore & Overpriced Hoodies. I am wearing the proof.'),
      r('lecture', 'Procrastination Hall. Late again. It is on brand, at least.'),
      r('dining', 'Mystery meat. Day three of finding out which mystery.'),
      r('library', 'The Overdue Library. I am fine. My books are the ones that are not.'),
      r('home', 'Study session. Basically. I mean, basically.', 19, 8),
      r('walk', 'Running late, by walking. It is a technique.'),
      r('*', 'Do you know what is on the final? Neither do I. We should start a study group.'),
    ] },
  { id: 'walt', name: 'Walt Dunmore', role: 'Pub Landlord', look: L({ skin: 0xe8b990, hair: 0x3a2a20, top: 0x9c4a3c, bottom: 0x2b2d33, shoes: 0x2b2d33, height: 1.02, build: 1.22, cut: 'bald', body: 'm', topKind: 'shirt', bottomKind: 'trousers', shoeKind: 'boots', beard: true, face: 5, seed: 5511 }),
    rules: [
      r('pub', 'The Hog Wallow opens at ten, closes when I say, and pours when you ask nicely.', 10, 24),
      r('grocer', 'Limes. Do not tell anybody they are for the tonic.'),
      r('home', 'Stools up, lights down, and one more song in my head that will not leave.', 23, 8),
      r('walk', 'Stepping out for supplies. The pub looks after itself. Badly.'),
      r('*', 'The first one is on the house. After that the house is on you.'),
    ] },
];

/** Names for the stops that are points, not businesses (the data names them by id). */
const SPOT_NAME: Record<string, string> = { jetty: 'the landing jetty', dam: 'the dam', bank: 'the River Walk bank', bus: 'the Quorum Square bus stop', home: 'home' };

/** Where a person is at an hour: at a stop (until `until`) or walking a leg. */
export interface Where {
  x: number; z: number; h: number;
  /** Index into the route's stops when standing at one, else -1. */
  stop: number;
  stopId: string;
  moving: boolean;
  /** At a stop: the hour they leave. Walking: the hour they arrive. Both on the 0..48 scale, so use fmtHour. */
  until: number;
  /** Walking: the stop they are heading for. */
  to: number;
  /** m/s while walking (for the stride). */
  speed: number;
}

interface Plan { route: TfRoute; folk: Folk; len: number[]; cum: number[][]; arrive: number[]; dur: number[]; depart: number[] }
const PLANS: Plan[] = [];
for (const folk of FOLK) {
  const route = TF_ROUTES.find((q) => q.id === folk.id);
  if (!route) continue;
  const n = route.sched.length;
  const len: number[] = [], cum: number[][] = [];
  for (const f of route.legs) {
    const c = [0];
    for (let k = 0; k + 3 < f.length; k += 2) c.push(c[c.length - 1] + Math.hypot(f[k + 2] - f[k], f[k + 3] - f[k + 1]));
    cum.push(c); len.push(c[c.length - 1]);
  }
  const arrive = route.sched.map((s) => s[0]);
  const dur: number[] = [], depart: number[] = [];
  for (let k = 0; k < n; k++) {
    const a1 = k + 1 < n ? arrive[k + 1] : arrive[0] + 24;
    const gap = a1 - arrive[k];
    const d = len[k] < 0.5 ? 0 : Math.max(0.05, Math.min(len[k] / PER_HOUR, gap - 0.1));
    dur.push(d); depart.push(a1 - d);
  }
  PLANS.push({ route, folk, len, cum, arrive, dur, depart });
}

/** Position of a plan at the town clock `hour` (0..24). Pure: the same hour is the same place, for everyone. */
export function whereAt(pl: Plan, hour: number, out: Where): Where {
  const n = pl.arrive.length;
  let h = ((hour % 24) + 24) % 24;
  if (h < pl.arrive[0]) h += 24;
  let k = n - 1;
  for (let i = 0; i < n; i++) { const a1 = i + 1 < n ? pl.arrive[i + 1] : pl.arrive[0] + 24; if (h >= pl.arrive[i] && h < a1) { k = i; break; } }
  const st = pl.route.stops[pl.route.sched[k][1]];
  const nxt = pl.route.sched[(k + 1) % n][1];
  if (h < pl.depart[k] || pl.len[k] < 0.5) {
    out.x = st.x; out.z = st.z; out.h = st.face; out.stop = pl.route.sched[k][1]; out.stopId = st.id; out.moving = false;
    out.until = pl.depart[k]; out.to = nxt; out.speed = 0;
    return out;
  }
  const f = pl.route.legs[k], c = pl.cum[k];
  const s = Math.min(pl.len[k], (h - pl.depart[k]) / pl.dur[k] * pl.len[k]);
  let i = 0;
  while (i + 2 < c.length && c[i + 1] < s) i++;
  const seg = Math.max(1e-6, c[i + 1] - c[i]), u = (s - c[i]) / seg;
  const ax = f[2 * i], az = f[2 * i + 1], bx = f[2 * i + 2], bz = f[2 * i + 3];
  out.x = ax + (bx - ax) * u; out.z = az + (bz - az) * u; out.h = Math.atan2(bx - ax, bz - az);
  out.stop = -1; out.stopId = 'walk'; out.moving = true; out.until = k + 1 < n ? pl.arrive[k + 1] : pl.arrive[0] + 24;
  out.to = nxt;
  // Real metres per real second at the nominal clock; a hurry shows.
  out.speed = Math.min(2.4, pl.len[k] / pl.dur[k] / 60);
  return out;
}

const inWindow = (h: number, a: number, b: number): boolean => (a <= b ? h >= a && h < b : h >= a || h < b);

/** The line a person says at a place and hour: the first rule that matches ('walk' on the move), else the '*' one. */
export function lineFor(folk: Folk, at: string, hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  for (const q of folk.rules) if (q.at === at && (q.from === undefined || inWindow(h, q.from, q.to ?? 24))) return q.say;
  return (folk.rules.find((q) => q.at === '*') as Rule).say;
}

export function fmtHour(h: number): string {
  const t = ((h % 24) + 24) % 24, hh = Math.floor(t), mm = Math.floor((t - hh) * 60 / 5) * 5;
  const ap = hh >= 12 ? 'pm' : 'am', h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

export interface FolkRow { id: string; name: string; role: string; where: string; x: number; z: number; dist: number; moving: boolean }

interface Live { pl: Plan; at: Where; p: Person | null; cur: number; cool: number; talk: number; inRoad: boolean; road: RoadPed; roadT: number }

export class Townsfolk {
  readonly on = STREETS_NEW && PLANS.length > 0;
  prompt: string | null = null;
  readonly stats = { greeted: 0 };
  private readonly live: Live[] = [];
  private t = 0;
  private tag: THREE.Sprite | null = null;
  private tagCv: HTMLCanvasElement | null = null;
  private tagTex: THREE.CanvasTexture | null = null;
  private tagFor = '';
  private tagAspect = 6;
  /** The last person greeted, and the line (for tests and the Places panel). */
  last: { id: string; line: string } | null = null;

  constructor(private readonly game: Game, private readonly idle: () => boolean) {
    for (const pl of PLANS) this.live.push({ pl, at: blank(), p: null, cur: 0, cool: 0, talk: 0, inRoad: false, road: { x: 0, z: 0, vx: 0, vz: 0 }, roadT: 0 });
  }

  get count(): number { return this.live.length; }
  def(id: string): Folk | undefined { return FOLK.find((f) => f.id === id); }

  /** Where each person is at an hour (default: now), for the Places list and the tests. */
  whereIs(id: string, hour = this.game.sky.hour): Where | null {
    const l = this.live.find((q) => q.pl.folk.id === id);
    return l ? whereAt(l.pl, hour, blank()) : null;
  }

  /** What a stop is called in a sentence. */
  stopName(pl: Plan, stop: number): string {
    const s = pl.route.stops[stop];
    return SPOT_NAME[s.id] ?? s.name;
  }

  private text(l: Live, w: Where): string {
    const pl = l.pl;
    if (!w.moving) {
      const s = pl.route.stops[w.stop];
      const where = s.id === 'home' ? 'at home' : `at ${SPOT_NAME[s.id] ?? s.name}`;
      return `${where} until ${fmtHour(w.until)}`;
    }
    return `walking ${pl.route.stops[w.to].id === 'home' ? 'home' : 'to ' + this.stopName(pl, w.to)}, there by ${fmtHour(w.until)}`;
  }

  /** The Places panel's rows: everyone, nearest first, with where they usually are right now. */
  rows(): FolkRow[] {
    if (!this.on) return [];
    const p = this.game.player, hr = this.game.sky.hour, w = blank();
    const out: FolkRow[] = this.live.map((l) => {
      whereAt(l.pl, hr, w);
      return { id: l.pl.folk.id, name: l.pl.folk.name, role: l.pl.folk.role, where: this.text(l, w), x: w.x, z: w.z, dist: Math.hypot(w.x - p.x, w.z - p.z), moving: w.moving };
    });
    return out.sort((a, b) => a.dist - b.dist);
  }

  private spawn(l: Live): void {
    const g = this.game;
    l.p = g.people.spawn(l.at.x, l.at.z, l.at.h, l.pl.folk.look);
    l.cur = l.at.h;
  }
  private despawn(l: Live): void {
    if (l.p) { this.game.people.remove(l.p); l.p = null; }
    l.inRoad = false;
  }

  update(dt: number): void {
    this.prompt = null;
    if (!this.on) return;
    const g = this.game, pl = g.player, hr = g.sky.hour, ft = Math.min(dt, 0.1);
    this.t += ft;
    let near: Live | null = null, nd = 1e9;
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      whereAt(l.pl, hr, l.at);
      const w = l.at, d = Math.hypot(w.x - pl.x, w.z - pl.z);
      if (d > NEAR + 30) { if (l.p) this.despawn(l); continue; }
      if (!l.p) { if (d > NEAR) continue; this.spawn(l); }
      const p = l.p as Person;
      p.x = w.x; p.z = w.z; p.y = groundAt(w.x, w.z);
      p.health = 100; p.visible = true;
      if (w.moving) {
        l.cur = dampAngle(l.cur, w.h, 8, ft);
        p.pose = w.speed > 2 ? 'run' : 'walk'; p.speed = w.speed;
        l.talk = 0;
      } else {
        let want = w.h + Math.sin(this.t * 0.35 + i * 1.7) * 0.3;
        if (l.talk > 0) { l.talk -= ft; want = Math.atan2(pl.x - w.x, pl.z - w.z); }
        l.cur = dampAngle(l.cur, want, 4, ft);
        p.pose = 'stand'; p.speed = 0;
      }
      p.h = l.cur;
      if (d < nd) { nd = d; near = l; }
    }
    this.label(near, nd);
    // Talk: on foot, close, nothing else holding the prompt.
    if (near && nd < TALK && !pl.vehicle && pl.health > 0 && this.idle()) {
      const f = near.pl.folk;
      this.prompt = `[G] Greet ${f.name}, ${f.role}`;
      if (g.input.eat('interact')) this.greet(near);
    }
  }

  /** Fun queue 2, item 32: named people standing about within `r` metres of (x, z) turn to the player and clap or cheer. Returns how many. */
  cheer(x: number, z: number, r: number, secs: number): number {
    if (!this.on) return 0;
    let n = 0;
    for (const l of this.live) {
      if (!l.p || l.at.moving || Math.hypot(l.at.x - x, l.at.z - z) > r) continue;
      l.talk = secs; setEmote(l.p, (n & 1) ? 6 : 5); n++;
    }
    return n;
  }

  /** The line for a person right now, and say it. */
  private greet(l: Live): void {
    const f = l.pl.folk, w = l.at, line = lineFor(f, w.moving ? 'walk' : w.stopId, this.game.sky.hour);
    this.game.hud.toast(`${f.name}: "${line}"`, 7);
    this.stats.greeted++;
    this.last = { id: f.id, line };
    l.talk = 6;
  }

  /** The shared name tag: over the nearest person within TAG metres. */
  private label(l: Live | null, d: number): void {
    const show = !!l && !!l.p && d < TAG;
    if (!show) { if (this.tag && this.tag.visible) this.tag.visible = false; return; }
    const f = (l as Live).pl.folk, p = (l as Live).p as Person;
    if (!this.tag) {
      this.tagCv = document.createElement('canvas');
      this.tagCv.width = 512; this.tagCv.height = 72;
      this.tagTex = new THREE.CanvasTexture(this.tagCv);
      this.tagTex.colorSpace = THREE.SRGBColorSpace;
      this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      this.tag.name = 'townsfolk_tag';
      this.tag.renderOrder = 20;
      this.game.scene.add(this.tag);
    }
    if (this.tagFor !== f.id) {
      this.tagFor = f.id;
      const g = (this.tagCv as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D, W = 512, H = 72;
      g.clearRect(0, 0, W, H);
      const text = `${f.name} · ${f.role}`;
      g.font = '600 30px system-ui, Segoe UI, Arial, sans-serif';
      const w = Math.min(W - 8, Math.ceil(g.measureText(text).width) + 40), x0 = (W - w) / 2;
      g.fillStyle = '#14213d'; g.fillRect(x0, 4, w, H - 8);
      g.fillStyle = '#f2e8cf'; g.fillRect(x0 + 4, 8, w - 8, H - 16);
      g.fillStyle = '#e4572e'; g.fillRect(x0 + 4, 8, w - 8, 7);
      g.fillStyle = '#14213d'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, W / 2, H / 2 + 6, w - 20);
      (this.tagTex as THREE.CanvasTexture).needsUpdate = true;
      this.tagAspect = W / H;
    }
    const top = 2.05 * f.look.height;
    this.tag.position.set(p.x, p.y + top, p.z);
    const hgt = 0.34;
    this.tag.scale.set(hgt * this.tagAspect, hgt, 1);
    this.tag.visible = true;
  }

  /** People crossing a road, for the drivers (called by sim/ambient.ts after the walkers have been listed). */
  roads(out: RoadPed[]): void {
    if (!this.on) return;
    const sg = this.game.plan.streets;
    if (!sg) return;
    for (const l of this.live) {
      if (!l.p) continue;
      if ((l.roadT -= 1 / 30) <= 0) { l.roadT = 0.3; l.inRoad = l.at.moving && l.at.z < -900 && !sg.clearOfRoads(l.at.x, l.at.z, 0.6); }
      if (l.inRoad) {
        const sp = l.at.speed, rp = l.road;
        rp.x = l.at.x; rp.z = l.at.z; rp.vx = Math.sin(l.at.h) * sp; rp.vz = Math.cos(l.at.h) * sp;
        out.push(rp);
      }
    }
  }

  info(): Record<string, unknown> {
    return { on: this.on, people: this.live.length, real: this.live.filter((l) => l.p).map((l) => l.pl.folk.id), greeted: this.stats.greeted, tag: this.tag?.visible ?? false };
  }
}

function blank(): Where { return { x: 0, z: 0, h: 0, stop: -1, stopId: '', moving: false, until: 0, to: 0, speed: 0 }; }
