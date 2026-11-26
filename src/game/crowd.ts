// Pedestrians who notice you (fun queue 2, item 32). Local only: no network traffic, no saved state.
//
// The sidewalk people (sim/peds.ts) and the named townsfolk (game/townsfolk.ts) react to the player, near the player only:
//   - Cheer: a stunt jump landed, a street race or derby won (the 'moment' event, core/api.ts), a big jump of the
//     player's own, or a long drift: the few people within 35 m stop, turn to watch and clap or cheer (the emotes of
//     ent/character.ts), and one or two shout "Whoa!". One cheer every 5 s at most.
//   - Flinch: the player's car brushing past somebody close by (Peds.onFlinch): they hop back and shout.
//   - Gossip: two people standing or strolling together stop and one tells the other, in a speech bubble, about
//     something the player did lately (a short log of 'moment' events), or just the news of the day. One every 40 to 70 s.
//   - Gunfire already sends people running (ent/weapons.ts calls Peds.alarm): nothing is added for it here.
// Speech bubbles are a pool of three little DOM labels, shown within 40 m, on screen, for about 2.6 s each.

import type { Game } from '../core/game';
import type { Person } from '../core/api';
import type { Peds, Walker } from '../sim/peds';
import { RNG } from '../core/util';
import * as THREE from 'three';

/** Bubbles and reactions reach this far from the player. */
const NEAR = 40;
/** How far the cheering reaches, how many people cheer, and for how long. */
const CHEER_R = 35, CHEER_N = 6, CHEER_S = 3.4;
/** Most bubbles on screen at once, seconds one is shown, and the shortest gap between two new ones. */
const MAX = 3, SHOW = 2.6, GAP = 0.9;
/** The log of recent moments keeps this many, and gossip uses the ones not older than this many seconds. */
const LOG = 8, FRESH = 480;

const CHEERS = ['Whoa!', 'Do it again!', 'Did you see that?!', 'Nice one!', 'Wow!', 'Yeah!', 'Incredible!'];
const DRIFTS = ['Look at it go!', 'Smoky!', 'Whoa, sideways!', 'Nice drifting!'];
const FLINCHES = ['Hey!', 'Watch it!', 'Whoa!', 'Yikes!', 'Easy, friend!', 'Eek!'];
const FILLER = [
  "Mabel's bread sold out again.",
  'They say the promenade is nearly done.',
  'Lovely day for a walk, is it not?',
  'The bridge fund keeps growing, I hear.',
  'Did you hear the river is running high?',
];
/** What people say about a moment (kinds from the 'moment' event). Nothing real, nobody named. */
const GOSSIP: Record<string, readonly string[]> = {
  jump: ['Did you see that jump? Right off the ramp!', 'Somebody flew clean over the gap. I watched it.'],
  raceWin: ['Somebody won the street race again.', 'I hear the race was close. Somebody is fast.'],
  derbyWin: ['Someone won the derby again.', 'Derby night: somebody drove off with the trophy.'],
  busted: ['They say the police caught somebody downtown.'],
  escaped: ['Somebody gave the police the slip. Quite a getaway.'],
  wreck: ['Did you see that car? It looked flattened.'],
  fish: ['Somebody pulled a huge fish out of the water.'],
  stage: ['They say the promenade is nearly done.', 'Another bit of the promenade opened. About time!'],
  snow: ['More snow on the way. Time to find the shovel.'],
  taxi: ['The cab driver is on a roll today.'],
  delivery: ['Somebody is delivering parcels all over town.'],
  plow: ['The plough has been out. Roads look nice.'],
  coop: ['Some folks pulled off a job together. Teamwork!'],
  photo: ['Somebody is taking photos of everything. Nice hobby.'],
  duckSet: ['Somebody found all the lost ducks!'],
  receiptSet: ['Somebody is collecting every bridge receipt.'],
  eventSoon: ['There is something on in town this evening.'],
};

interface Slot { el: HTMLDivElement; p: Person | null; t: number }

const CSS = `
.pc-say-root { position: fixed; inset: 0; z-index: 9; pointer-events: none; overflow: hidden; }
.pc-say { position: absolute; left: 0; top: 0; display: none; max-width: 15em; padding: 0.3em 0.6em; border: 2px solid var(--ink, #14213d);
  border-radius: 0.9em; background: var(--bone, #f2e8cf); color: var(--ink, #14213d); box-shadow: 0.15em 0.15em 0 rgba(20, 33, 61, 0.45);
  font: 700 0.85em/1.2 var(--f-head, 'Arial Narrow', sans-serif); text-align: center; will-change: transform; }
`;

export class Crowd {
  readonly stats = { cheers: 0, flinches: 0, gossips: 0, said: 0 };
  /** The last line shown (for tests). */
  last = '';
  /** Seconds until the next cheer and the next gossip are allowed (tests set these). */
  cheerCool = 0; gossipCool = 0;

  private readonly rng = new RNG(32032);
  private peds: Peds | null = null;
  private readonly slots: Slot[] = [];
  private root: HTMLDivElement | null = null;
  private readonly log: { kind: string; t: number }[] = [];
  private t = 0; private gap = 0; private scan = 1;
  private airMax = 0; private driftT = 0; private lines = 0;
  private readonly v3 = new THREE.Vector3();

  constructor(private readonly game: Game) {
    game.on('moment', (e) => this.moment(e.kind));
  }

  /** A moment the player made: logged for gossip, and the big ones draw a cheer. */
  private moment(kind: string): void {
    // Kinds with nothing to say (the Town Notice's counters, game/notice.ts) stay out of the log of the last few moments.
    if (!GOSSIP[kind] && kind !== 'raceLose') return;
    const l = this.log;
    if (!(l.length && l[l.length - 1].kind === kind && this.t - l[l.length - 1].t < 5)) {
      if (l.length >= LOG) l.shift();
      l.push({ kind, t: this.t });
    }
    if (kind === 'jump' || kind === 'raceWin' || kind === 'derbyWin') this.cheer(CHEERS);
  }

  /** The crowd round the player turns to watch and cheers. Returns how many people cheered. */
  cheer(says: readonly string[]): number {
    const pk = this.find();
    if (!pk || this.cheerCool > 0) return 0;
    const g = this.game, pl = g.player;
    this.cheerCool = 5;
    const n = pk.cheerAt(pl.x, pl.z, CHEER_R, CHEER_N, CHEER_S) + (g.todo?.townsfolk.cheer(pl.x, pl.z, CHEER_R, CHEER_S) ?? 0);
    if (n > 0) this.stats.cheers++;
    const c = pk.cheerers;
    // Somebody in view shouts: one, sometimes two.
    let said = 0;
    for (let i = 0; i < c.length && said < 2; i++) {
      if ((said === 0 || this.rng.chance(0.5)) && this.say(c[i].p, says[(this.lines++ + i * 3) % says.length])) said++;
    }
    return n;
  }

  /** Show a speech bubble over a person, if there is a free one and they are close. */
  say(p: Person, text: string): boolean {
    if (this.gap > 0) return false;
    const pl = this.game.player;
    if (Math.hypot(p.x - pl.x, p.z - pl.z) > NEAR || !this.project(p)) return false;
    let free: Slot | null = null;
    for (const s of this.slots) {
      if (s.p === p) return false;
      if (!s.p && !free) free = s;
    }
    if (!free) {
      if (this.slots.length >= MAX) return false;
      if (!this.root) {
        const st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
        this.root = document.createElement('div');
        this.root.className = 'pc-say-root';
        document.body.appendChild(this.root);
      }
      const el = document.createElement('div');
      el.className = 'pc-say';
      this.root.appendChild(el);
      this.slots.push((free = { el, p: null, t: 0 }));
    }
    free.p = p; free.t = SHOW; free.el.textContent = text;
    this.gap = GAP; this.last = text; this.stats.said++;
    return true;
  }

  /** Where the person's head is on screen (in this.v3, NDC), or false when out of view. */
  private project(p: Person): boolean {
    const v = this.v3.set(p.x, p.y + 2.15, p.z).project(this.game.camera);
    return v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
  }

  /** Bubbles up now (for tests). */
  get shown(): number { let n = 0; for (const s of this.slots) if (s.p) n++; return n; }

  private find(): Peds | null {
    if (this.peds) return this.peds;
    for (const s of this.game.systems) {
      const a = s as { peds?: Peds };
      if (a.peds && Array.isArray(a.peds.walkers)) {
        this.peds = a.peds;
        a.peds.onFlinch = (w) => this.flinched(w);
        break;
      }
    }
    return this.peds;
  }

  private flinched(w: Walker): void {
    this.stats.flinches++;
    if (this.rng.chance(0.75)) this.say(w.p, FLINCHES[this.lines++ % FLINCHES.length]);
  }

  /** What to say about the latest thing, or the news of the day. */
  private gossip(): string | null {
    const l = this.log;
    let kinds = 0;
    const pick: string[] = [];
    for (let i = l.length - 1; i >= 0 && kinds < 3; i--) {
      if (this.t - l[i].t > FRESH || !GOSSIP[l[i].kind]) continue;
      pick.push(l[i].kind); kinds++;
    }
    if (!pick.length) return this.rng.chance(0.3) ? FILLER[this.lines++ % FILLER.length] : null;
    const set = GOSSIP[pick[this.rng.int(0, pick.length - 1)]];
    return set[this.lines++ % set.length];
  }

  update(dt: number): void {
    const g = this.game, pl = g.player, ft = Math.min(dt, 0.1);
    this.t += ft;
    if (this.cheerCool > 0) this.cheerCool -= ft;
    if (this.gossipCool > 0) this.gossipCool -= ft;
    if (this.gap > 0) this.gap -= ft;
    const pk = this.find();

    // The player's own stunts: a big jump landed, a long drift.
    const v = pl.vehicle;
    if (v && pk) {
      if (!v.onGround) { if (v.airTime > this.airMax) this.airMax = v.airTime; }
      else { if (this.airMax >= 1.1 && !v.sunk) this.moment('jump'); this.airMax = 0; }
      if (v.slip > 0.45 && Math.abs(v.speed) > 8 && v.onGround) {
        this.driftT += ft;
        if (this.driftT >= 3) { this.driftT = -6; this.cheer(DRIFTS); }
      } else if (this.driftT > 0) this.driftT = Math.max(0, this.driftT - ft * 2);
      else if (this.driftT < 0) this.driftT = Math.min(0, this.driftT + ft);
    } else { this.airMax = 0; this.driftT = 0; }

    // Gossip: now and then, between two people close by.
    if (pk && this.gossipCool <= 0 && (this.scan -= ft) <= 0) {
      this.scan = 2;
      const line = this.gossip();
      if (line) {
        const a = pk.chatterNear(pl.x, pl.z, NEAR - 6);
        // One of the two must be where it can be seen, or nothing is said (and they try again in a moment).
        if (a) {
          const b = pk.partner as Walker;
          const first = this.rng.chance(0.5) ? a : b;
          if (this.say(first.p, line) || this.say((first === a ? b : a).p, line)) {
            pk.converse(a, b, 5);
            this.gossipCool = this.rng.range(40, 70);
            this.stats.gossips++;
          } else this.gossipCool = 3;
        }
      }
    }

    // Bubbles follow heads.
    if (!this.slots.length) return;
    const cam = g.camera, w = innerWidth, h = innerHeight, p3 = this.v3;
    for (const s of this.slots) {
      if (!s.p) continue;
      const p = s.p;
      s.t -= ft;
      const d = Math.hypot(p.x - pl.x, p.z - pl.z);
      p3.set(p.x, p.y + 2.15, p.z).project(cam);
      if (s.t <= 0 || d > NEAR + 6 || !p.visible || p3.z > 1 || p3.z < -1 || Math.abs(p3.x) > 1.15 || Math.abs(p3.y) > 1.15) {
        s.p = null; s.el.style.display = 'none';
        continue;
      }
      const st = s.el.style;
      st.display = 'block';
      st.opacity = s.t < 0.4 ? String(s.t / 0.4) : '1';
      st.transform = `translate(${Math.round((p3.x * 0.5 + 0.5) * w)}px, ${Math.round((-p3.y * 0.5 + 0.5) * h)}px) translate(-50%, -100%)`;
    }
  }
}
