// Fun queue 2, item 27: team snowball fights, with the scores on a billboard.
//
// WHEN AND WHERE: snow lying (Sky.snowCover 0.2 and up; ?snow=1 forces it, game/plow.ts) and a field of packed snow at three
// open places: the east lawn of Mercy Park, Quorum Square (Tepid Falls) and the campus quad at Dithers College (not under
// ?streets=old). A field is 32 x 20 m, red at the west end and blue at the east, flags at the corners, snow mounds to
// scoop from, and a billboard on two poles at the north edge with the score and the clock (a canvas texture; every browser
// in town draws the same numbers from the host's frames, and an idle board says how to start).
// START: on foot on the field, stopped, G starts a round of 3 minutes (a 4 s count first); somebody else in town who
// walks onto the field sees "Join" and presses G, or taps the tag. Teams are balanced on the way in (red first). Each
// side is filled up to three with townsfolk, so one player can play: a bot walks about its half and throws at the
// nearest enemy now and then. A round holds up to four humans a side.
// PLAY: G throws along the camera aim (an arc: the camera sees it, so does everybody), R scoops three snowballs from the
// snow underfoot (about a second standing still; six at most; you start with five). A hit scores one for the thrower's team,
// splats the victim (a white flash, a camera jolt, a short wobble for a bot) and does no damage at all: nobody is hurt and
// nobody dies. Leave the field (over 34 m), get in a car, or let the snow melt, and you are out (the snow melting ends the
// round for everyone, with no prize).
// END: the higher score wins; each winner of a round of at least half a minute gets a small prize (a draw pays less, a
// loss nothing; the pay tapers like every job), and your team's score is kept as your best (sf.best in the best table).
// NET: the caller's browser is the referee. It starts the clock, assigns teams, runs the bots, steps every ball along with
// everybody (the same arc on every screen) against the players' places as it sees them (its own body, the others' State
// frames) and sends each hit. Frames ride PlayerEvent.Snow = 27 (net/snowfight.ts), relayed unread by the service:
// protocol still v6, server untouched, no new fact key. Offline it is the same round, with no frames.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { blankSnow, SnowKind, type SnowMsg } from '../net/protocol';
import { save } from './save';
import { taper } from './activities';
import type { Markers } from './script';
import { People } from './eventProps';
import { ACC } from '../core/access';

export interface SnowLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): { x: number; y: number; z: number } | null;
  onFoot(id: number): boolean;
  send(m: SnowMsg): void;
}

/** The field, metres (x by z), the round and the count, seconds. */
export const FIELD_W = 32, FIELD_D = 20;
export const ROUND_S = 180, COUNT_S = 4;
export const MAX_AMMO = 6, START_AMMO = 5, SCOOP_N = 3, SCOOP_S = 0.9;
export const PRIZE = 60, PRIZE_DRAW = 25;
/** Snow cover at which there is a fight to be had. */
const NEED = 0.2;
const PER_SIDE = 4, TEAM_MIN = 3;
const REACH = 34, START_R = 24, NEAR_SHOW = 300, SPEED = 22, G = 9.8, HIT_R = 0.65;
const ROSTER_MS = 1500, BOTS_MS = 250, SILENCE_MS = 9000;
const BALLS = 24;
const RED = 0xd9382c, BLUE = 0x2f6fd0;
export const SITE_NAMES = ['Mercy Park', 'Quorum Square', 'the campus quad'];

interface Site { id: number; name: string; x: number; z: number; on: boolean }
const SITES: Site[] = [
  { id: 0, name: 'Mercy Park', x: 245, z: -167, on: true },
  STREETS_NEW ? { id: 1, name: 'Quorum Square', x: 131, z: -1808, on: true } : { id: 1, name: 'Quorum Square', x: 20, z: -1452, on: true },
  { id: 2, name: 'the campus quad', x: -412, z: -2409, on: STREETS_NEW },
];

interface Roster { host: number; site: number; phase: number; left: number; red: number; blue: number; ids: { id: number; team: number }[]; botsR: number; botsB: number; at: number }
interface Bot { id: number; team: number; live: boolean; x: number; z: number; h: number; tx: number; tz: number; wander: number; next: number; stag: number; seq: number }
interface Ball { m: THREE.Mesh; live: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; thrower: number; seq: number; team: number; age: number }
interface Last { red: number; blue: number; winner: number; at: number }
interface Stage { group: THREE.Group; tex: THREE.CanvasTexture; cv: HTMLCanvasElement; key: string }

/** The tag and the splat the page draws (ui/snowTag.ts). */
export interface SnowUi { splat(): void }

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const clockText = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class SnowFight {
  link: SnowLink | null = null;
  ui: SnowUi | null = null;
  prompt: string | null = null;
  readonly stats = { started: 0, joined: 0, thrown: 0, hits: 0, got: 0, sent: 0, ended: 0 };
  /** The last round I was in, for the tests and the tag. */
  last = { red: 0, blue: 0, winner: 0, pay: 0, mine: 0, played: 0 };

  /** The fight I am in (its host's id), 0 when none, and the one I asked to join. */
  private mine = 0;
  private asked = 0; private askedAt = 0;
  private team = 0;
  private clk = 0;
  private readonly known = new Map<number, Roster>();
  private readonly told = new Set<number>();
  private readonly results = new Map<number, Last>();
  private humans = new Map<number, number>();
  private readonly bots: Bot[] = Array.from({ length: 6 }, (_, k) => ({ id: 100 + k, team: k < 3 ? 1 : 2, live: false, x: 0, z: 0, h: 0, tx: 0, tz: 0, wander: 0, next: 0, stag: 0, seq: 0 }));
  private ammo = START_AMMO;
  private scoop = 0;
  private cool = 0;
  private seq = 0;
  private playedS = 0;
  private myHits = 0;
  private rosterAt = 0; private botsAt = 0;
  private immune = new Map<number, number>();
  private readonly stages = new Map<number, Stage>();
  private readonly balls: Ball[] = [];
  private pool: THREE.Group | null = null;
  private readonly puffs: { m: THREE.Mesh; t: number }[] = [];
  private readonly tags: { g: THREE.Group; ring: THREE.Mesh; cap: THREE.Mesh }[] = [];
  private people: [People, People] | null = null;
  private readonly mats = { red: new THREE.MeshBasicMaterial({ color: RED, toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }), blue: new THREE.MeshBasicMaterial({ color: BLUE, toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }) };
  private lastObj = '';

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    void this.markers;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** My id: the net's, or 1 when playing alone. */
  private get me(): number { return (this.link ? this.link.me() : 0) || 1; }
  private nameOf(id: number): string { return id >= 100 ? 'a townsperson' : this.link ? this.link.nameOf(id) : 'Somebody'; }
  private toast(s: string, secs = 4): void { this.game.hud.toast(s, secs); }
  get snowing(): boolean { return this.game.sky.snowCover >= NEED; }
  get active(): boolean { return this.mine !== 0; }
  get hosting(): boolean { return this.mine !== 0 && this.mine === this.me; }
  private get fight(): Roster | null { return this.mine ? this.known.get(this.mine) ?? null : null; }
  private sc(s: Site): { x: number; z: number } { return { x: s.x, z: s.z }; }
  private left(r: Roster): number { return Math.max(0, r.left - (performance.now() - r.at) / 1000); }
  private send(kind: number, patch: Partial<SnowMsg>): void {
    if (!this.link) return;
    const m = blankSnow(kind);
    Object.assign(m, { host: this.mine, site: this.fight ? this.fight.site : 0 }, patch);
    this.link.send(m);
    this.stats.sent++;
  }
  /** The site whose field I stand on (or near), or null. */
  private siteNear(r = START_R): Site | null {
    const p = this.game.player;
    let best: Site | null = null, bd = r;
    for (const s of SITES) { if (!s.on) continue; const d = Math.hypot(p.x - s.x, p.z - s.z); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  private teamOfId(id: number, r: Roster | null): number {
    if (id >= 100) return id - 100 < 3 ? 1 : 2;
    const f = r ?? this.fight;
    const h = f ? f.ids.find((x) => x.id === id) : null;
    return h ? h.team : 0;
  }
  private posOf(id: number): { x: number; y: number; z: number } | null {
    if (id === this.me) { const p = this.game.player; return p.vehicle ? null : { x: p.x, y: p.y, z: p.z }; }
    if (this.link && !this.link.onFoot(id)) return null;
    return this.link ? this.link.posOf(id) : null;
  }

  // ── What the player does ───────────────────────────────────────────────────

  /** The prompt's key (and the tag's button): throw, or start, or join. */
  press(): void {
    const p = this.game.player;
    if (this.mine) { this.throwBall(); return; }
    const s = this.siteNear();
    if (!s || !this.isFree() || p.vehicle || !(p.health > 0)) return;
    if (!this.snowing) { this.toast('The snowball fight needs snow lying on the ground. Come back when it has snowed.', 5); return; }
    const o = [...this.known.values()].find((r) => r.site === s.id);
    if (o) this.join(o, s); else this.start(s);
  }

  private start(s: Site): void {
    if ([...this.known.values()].some((r) => r.host !== this.me)) { this.toast('A snowball fight is already on in town. Join it, or wait for it to end.', 5); return; }
    this.mine = this.me; this.team = 1;
    this.humans = new Map([[this.me, 1]]);
    const r: Roster = { host: this.me, site: s.id, phase: 1, left: COUNT_S, red: 0, blue: 0, ids: [{ id: this.me, team: 1 }], botsR: 0, botsB: 0, at: performance.now() };
    this.known.set(this.me, r);
    this.begin(s);
    this.syncBots();
    this.stats.started++;
    this.sendRoster();
    this.game.hud.stamp('SNOWBALL FIGHT', `Red against blue at ${s.name} · you are RED · G throws, R scoops · 3 minutes`);
    this.toast('Others in town were asked to join. Townsfolk fill the empty places.', 5);
  }

  private join(o: Roster, s: Site): void {
    if (this.team) return;
    if (!this.link || !this.link.me()) return;
    this.asked = o.host; this.askedAt = performance.now();
    this.send(SnowKind.Join, { host: o.host, site: s.id });
    this.toast('Asking to join the snowball fight...', 3);
  }

  /** Common to the host and a joiner: busy, ammo, the aim. */
  private begin(s: Site): void {
    this.scoop = 0; this.cool = 0; this.ammo = START_AMMO; this.playedS = 0; this.myHits = 0; this.seq = 0;
    this.lastObj = '';
    this.setBusy('snowfight');
    void s;
  }

  /** Leave: tell the host (or end it, hosting) and go back to the town. */
  leave(why: string): void {
    if (!this.mine) return;
    if (this.hosting) { this.finish(this.mine, 3, true); this.toast(why, 5); return; }
    this.send(SnowKind.Leave, { host: this.mine, team: this.team });
    this.out(why);
  }

  /** Out of the round on this screen only. */
  private out(why: string): void {
    const h = this.mine;
    this.mine = 0; this.team = 0; this.asked = 0;
    this.scoop = 0;
    this.setBusy(null);
    this.game.hud.objective(null);
    this.lastObj = '';
    if (why) this.toast(why, 5);
    void h;
  }

  /** A throw along the camera, from my hand. */
  throwBall(): void {
    const g = this.game, p = g.player, f = this.fight;
    if (!f || !this.mine) return;
    if (f.phase !== 2) { this.toast('Wait for the count. You can scoop meanwhile (R).', 2); return; }
    if (this.cool > 0 || this.scoop > 0) return;
    if (this.ammo < 1) { this.toast('Out of snowballs. Scoop some (R) from the snow underfoot.', 2.5); return; }
    this.ammo--; this.cool = 0.4; this.stats.thrown++;
    const dir = new THREE.Vector3(); g.camera.getWorldDirection(dir);
    dir.y += 0.12; dir.normalize();
    const x = p.x + dir.x * 0.6, y = p.y + 1.45 + dir.y * 0.6, z = p.z + dir.z * 0.6;
    this.launch(this.me, this.seq++ & 0xff, this.team, x, y, z, dir.x * SPEED, dir.y * SPEED, dir.z * SPEED, true);
  }

  /** Scoop snow into snowballs (R, or the tag's button): about a second standing still. */
  startScoop(): void {
    if (!this.mine || this.scoop > 0) return;
    if (this.ammo >= MAX_AMMO) { this.toast('Your arms are full of snowballs.', 2); return; }
    if (this.game.player.vehicle || Math.abs(this.game.player.speed) > 2) { this.toast('Stand still to scoop.', 2); return; }
    this.scoop = SCOOP_S;
  }

  // ── Balls ──────────────────────────────────────────────────────────────────

  private ensurePool(): void {
    if (this.pool) return;
    const g = new THREE.Group(); g.name = 'snowfight-pool';
    const geo = new THREE.SphereGeometry(0.14, 8, 6), mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    for (let k = 0; k < BALLS; k++) { const m = new THREE.Mesh(geo, mat); m.visible = false; m.castShadow = false; g.add(m); this.balls.push({ m, live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, thrower: 0, seq: 0, team: 0, age: 0 }); }
    const pg = new THREE.SphereGeometry(0.5, 10, 8);
    for (let k = 0; k < 8; k++) { const m = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })); m.visible = false; g.add(m); this.puffs.push({ m, t: 0 }); }
    const rg = new THREE.RingGeometry(0.62, 0.86, 28); rg.rotateX(-Math.PI / 2);
    const cg = new THREE.SphereGeometry(0.13, 8, 6);
    for (let k = 0; k < 14; k++) {
      const tg = new THREE.Group(), ring = new THREE.Mesh(rg, this.mats.red), cap = new THREE.Mesh(cg, this.mats.red);
      cap.position.y = 2.25; tg.add(ring, cap); tg.visible = false; g.add(tg); this.tags.push({ g: tg, ring, cap });
    }
    this.game.scene.add(g);
    this.pool = g;
  }

  private launch(thrower: number, seq: number, team: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, send: boolean): void {
    this.ensurePool();
    const b = this.balls.find((k) => !k.live) ?? this.balls.reduce((a, c) => (c.age > a.age ? c : a));
    b.live = true; b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.thrower = thrower; b.seq = seq; b.team = team; b.age = 0;
    b.m.visible = true; b.m.position.set(x, y, z);
    if (send) this.send(SnowKind.Throw, { thrower, seq, x, y, z, vx, vy, vz });
  }

  private puff(x: number, y: number, z: number): void {
    this.ensurePool();
    const q = this.puffs.find((k) => k.t <= 0) ?? this.puffs[0];
    q.t = 0.5; q.m.position.set(x, y, z); q.m.visible = true;
  }

  /** Step the balls; the host judges each against the other team. */
  private flight(dt: number): void {
    if (!this.pool) return;
    const f = this.fight, judge = this.hosting && !!f && f.phase === 2;
    const targets: { id: number; team: number; x: number; y: number; z: number }[] = [];
    if (judge && f) {
      for (const h of f.ids) { const at = this.posOf(h.id); if (at && (this.immune.get(h.id) ?? 0) < this.clk) targets.push({ id: h.id, team: h.team, x: at.x, y: at.y, z: at.z }); }
      for (const b of this.bots) if (b.live && b.stag <= 0.0001) targets.push({ id: b.id, team: b.team, x: b.x, y: groundAt(b.x, b.z), z: b.z });
    }
    for (const b of this.balls) {
      if (!b.live) continue;
      b.age += dt;
      const n = Math.max(1, Math.ceil(dt / 0.02)), h = dt / n;
      for (let i = 0; i < n && b.live; i++) {
        b.vy -= G * h; b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
        if (judge) for (const t of targets) {
          if (t.team === b.team || t.id === b.thrower) continue;
          if (Math.hypot(b.x - t.x, b.z - t.z) < HIT_R && b.y > t.y - 0.1 && b.y < t.y + 1.95) { this.hit(t.id, b); break; }
        }
        if (b.live && (b.y < groundAt(b.x, b.z) + 0.05 || b.age > 5)) { b.live = false; if (b.y < groundAt(b.x, b.z) + 0.3) this.puff(b.x, groundAt(b.x, b.z) + 0.1, b.z); }
      }
      b.m.visible = b.live; if (b.live) b.m.position.set(b.x, b.y, b.z);
    }
    for (const q of this.puffs) {
      if (q.t <= 0) continue;
      q.t -= dt;
      const k = 1 - Math.max(0, q.t) / 0.5;
      q.m.scale.setScalar(0.3 + k * 0.9); (q.m.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - k);
      if (q.t <= 0) q.m.visible = false;
    }
  }

  /** The host's judgement of one hit. */
  private hit(victim: number, b: Ball): void {
    const f = this.fight;
    if (!f) return;
    if (b.team === 1) f.red++; else f.blue++;
    this.immune.set(victim, this.clk + 0.7);
    this.send(SnowKind.Hit, { victim, thrower: b.thrower, seq: b.seq, red: f.red, blue: f.blue });
    this.applyHit(victim, b.thrower, b.seq, f.red, f.blue);
  }

  private applyHit(victim: number, thrower: number, seq: number, red: number, blue: number): void {
    const f = this.fight;
    if (f) { f.red = red; f.blue = blue; }
    for (const b of this.balls) if (b.live && b.thrower === thrower && b.seq === seq) { b.live = false; b.m.visible = false; }
    const at = victim >= 100 ? { x: this.bots[victim - 100]?.x ?? 0, y: 0, z: this.bots[victim - 100]?.z ?? 0 } : this.posOf(victim);
    if (at) this.puff(at.x, (victim >= 100 ? groundAt(at.x, at.z) : at.y) + 1.3, at.z);
    if (victim >= 100 && this.bots[victim - 100]) this.bots[victim - 100].stag = 1.3;
    if (victim === this.me && this.mine) { this.ui?.splat(); this.game.cam.shake(0.45); this.toast(`Splat! ${this.nameOf(thrower)} got you. No harm done.`, 2.2); }
    if (thrower === this.me && this.mine) { this.myHits++; this.stats.hits++; save.bump('sf.hits'); this.toast('Hit! +1 for your team', 1.4); }
  }

  // ── The bots (the host's) ──────────────────────────────────────────────────

  /** Fill each side up to three, or to the larger human side. */
  private syncBots(): void {
    const f = this.fight;
    if (!f) return;
    let hr = 0, hb = 0;
    for (const h of f.ids) if (h.team === 1) hr++; else hb++;
    const size = Math.max(TEAM_MIN, hr, hb), nr = size - hr, nb = size - hb;
    f.botsR = Math.max(0, Math.min(3, nr)); f.botsB = Math.max(0, Math.min(3, nb));
    const s = SITES[f.site];
    this.bots.forEach((b, k) => {
      const want = k < 3 ? k < f.botsR : k - 3 < f.botsB;
      if (want && !b.live) { b.live = true; b.x = s.x + (b.team === 1 ? -1 : 1) * rnd(4, FIELD_W / 2 - 2); b.z = s.z + rnd(-FIELD_D / 2 + 2, FIELD_D / 2 - 2); b.tx = b.x; b.tz = b.z; b.wander = 0; b.next = this.clk + rnd(2, 4); b.stag = 0; }
      if (!want) b.live = false;
    });
  }

  private botsTick(dt: number): void {
    const f = this.fight;
    if (!f) return;
    const s = SITES[f.site];
    for (const b of this.bots) {
      if (!b.live) continue;
      if (b.stag > 0) { b.stag -= dt; continue; }
      b.wander -= dt;
      if (b.wander <= 0 || Math.hypot(b.tx - b.x, b.tz - b.z) < 0.6) {
        const side = b.team === 1 ? -1 : 1;
        b.tx = s.x + side * rnd(2.5, FIELD_W / 2 - 1.5); b.tz = s.z + rnd(-FIELD_D / 2 + 1.5, FIELD_D / 2 - 1.5); b.wander = rnd(2, 5);
      }
      const dx = b.tx - b.x, dz = b.tz - b.z, d = Math.hypot(dx, dz) || 1, v = Math.min(3.2 * dt, d);
      b.x += (dx / d) * v; b.z += (dz / d) * v;
      if (f.phase !== 2 || this.clk < b.next) { if (d > 0.7) b.h = Math.atan2(dx, dz); continue; }
      // The nearest enemy: another side's human or bot.
      let best: { x: number; y: number; z: number } | null = null, bd = 30;
      for (const h of f.ids) {
        if (h.team === b.team) continue;
        const at = this.posOf(h.id); if (!at) continue;
        const dd = Math.hypot(at.x - b.x, at.z - b.z); if (dd < bd) { bd = dd; best = at; }
      }
      for (const o of this.bots) {
        if (!o.live || o.team === b.team) continue;
        const dd = Math.hypot(o.x - b.x, o.z - b.z); if (dd < bd) { bd = dd; best = { x: o.x, y: groundAt(o.x, o.z), z: o.z }; }
      }
      b.next = this.clk + rnd(3.4, 6.4);
      if (!best) continue;
      const err = 1.2 + bd * 0.1;
      const tx = best.x + rnd(-err, err), tz = best.z + rnd(-err, err), ddx = tx - b.x, ddz = tz - b.z, dist = Math.hypot(ddx, ddz) || 1;
      const sp = 20, sIn = Math.min(1, (G * dist) / (sp * sp)), th = 0.5 * Math.asin(sIn);
      const hv = sp * Math.cos(th);
      b.h = Math.atan2(ddx, ddz);
      const gy = groundAt(b.x, b.z);
      this.launch(b.id, b.seq++ & 0xff, b.team, b.x, gy + 1.35, b.z, (ddx / dist) * hv, sp * Math.sin(th) + (best.y + 1.1 - gy - 1.35) * 0.4, (ddz / dist) * hv, true);
    }
  }

  // ── The network's ──────────────────────────────────────────────────────────

  private sendRoster(): void {
    const f = this.fight;
    if (!f || !this.hosting) return;
    this.rosterAt = performance.now();
    this.send(SnowKind.Roster, { host: this.me, site: f.site, secs: this.left(f), red: f.red, blue: f.blue, phase: f.phase, bots: (f.botsR << 4) | f.botsB, ids: f.ids });
  }

  got(from: number, m: SnowMsg): void {
    this.stats.got++;
    const now = performance.now();
    if (m.kind === SnowKind.Roster) {
      if (from !== m.host || m.site >= SITES.length) return;
      if (m.phase === 0) { if (this.asked === from) { this.asked = 0; this.toast('That snowball fight is full (four a side).', 4); } return; }
      const old = this.known.get(from);
      const r: Roster = { host: from, site: m.site, phase: m.phase, left: m.secs, red: m.red, blue: m.blue, ids: m.ids.slice(), botsR: (m.bots >> 4) & 15, botsB: m.bots & 15, at: now };
      this.known.set(from, r);
      if (!old && !this.told.has(from) && this.mine === 0) {
        this.told.add(from);
        this.toast(`${this.nameOf(from)} started a snowball fight at ${SITES[m.site].name}. Walk onto the field and press G to join.`, 8);
      }
      if (this.asked === from) {
        const me = r.ids.find((x) => x.id === this.me);
        if (me && !this.mine) { this.mine = from; this.team = me.team; this.asked = 0; this.stats.joined++; this.begin(SITES[m.site]); this.game.hud.stamp('SNOWBALL FIGHT', `You joined ${this.nameOf(from)}'s fight as ${me.team === 1 ? 'RED' : 'BLUE'} · G throws, R scoops`); }
      }
      if (this.mine === from && !this.hosting && !r.ids.some((x) => x.id === this.me)) this.out('The host took you off the field.');
      return;
    }
    if (m.kind === SnowKind.Join) {
      const f = this.fight;
      if (!this.hosting || !f || m.host !== this.me) return;
      if (!f.ids.some((x) => x.id === from)) {
        const hr = f.ids.filter((x) => x.team === 1).length, hb = f.ids.length - hr;
        if (hr >= PER_SIDE && hb >= PER_SIDE) { this.send(SnowKind.Roster, { host: this.me, site: f.site, secs: this.left(f), red: f.red, blue: f.blue, phase: 0, bots: 0, ids: [] }); return; }
        const team = hr <= hb ? 1 : 2;
        f.ids.push({ id: from, team });
        this.humans.set(from, team);
        this.toast(`${this.nameOf(from)} joined the ${team === 1 ? 'red' : 'blue'} team.`, 4);
        this.syncBots();
      }
      this.sendRoster();
      return;
    }
    if (m.kind === SnowKind.Leave) {
      const f = this.fight;
      if (!this.hosting || !f || m.host !== this.me) return;
      this.drop(from, `${this.nameOf(from)} left the snowball fight.`);
      return;
    }
    if (m.kind === SnowKind.Throw) {
      const r = m.thrower >= 100 ? this.known.get(from) : [...this.known.values()].find((k) => k.ids.some((x) => x.id === from));
      if (!r || (m.thrower < 100 && m.thrower !== from)) return;
      if (this.hosting && m.thrower < 100 && (!this.fight || this.fight.phase !== 2)) return;
      this.launch(m.thrower, m.seq, this.teamOfId(m.thrower, r), m.x, m.y, m.z, m.vx, m.vy, m.vz, false);
      return;
    }
    if (m.kind === SnowKind.Hit) {
      if (!this.known.has(from) || from !== m.host || this.hosting) return;
      this.applyHit(m.victim, m.thrower, m.seq, m.red, m.blue);
      return;
    }
    if (m.kind === SnowKind.Bots) {
      const f = this.known.get(from);
      if (!f || from !== m.host || this.hosting) return;
      let ri = 0, bi = 0;
      for (const e of m.list) {
        const blue = (e.f & 1) !== 0, k = blue ? 3 + bi++ : ri++;
        const b = this.bots[k], s = SITES[f.site];
        if (!b) continue;
        const x = s.x + e.dx, z = s.z + e.dz;
        if (!b.live) { b.x = x; b.z = z; }
        b.live = true; b.tx = x; b.tz = z; b.h = (e.h / 256) * Math.PI * 2 - Math.PI; if (e.f & 2) b.stag = Math.max(b.stag, 0.3);
      }
      this.bots.forEach((b, k) => { if (k < 3 ? k >= ri : k - 3 >= bi) b.live = false; });
      return;
    }
    if (m.kind === SnowKind.End) {
      const f = this.known.get(from);
      if (!f || from !== m.host || this.hosting) return;
      this.finish(from, m.winner, false, m.red, m.blue);
    }
  }

  private drop(id: number, why: string): void {
    const f = this.fight;
    if (!f) return;
    f.ids = f.ids.filter((x) => x.id !== id);
    this.humans.delete(id);
    if (why) this.toast(why, 4);
    this.syncBots();
    this.sendRoster();
  }

  dropped(id: number): void {
    this.asked = this.asked === id ? 0 : this.asked;
    if (this.known.has(id) && id !== this.me) {
      if (this.mine === id) this.finish(id, 3, false); else this.known.delete(id);
      return;
    }
    if (this.hosting && this.fight?.ids.some((x) => x.id === id)) this.drop(id, `${this.nameOf(id)} left town and the fight.`);
  }

  offline(): void {
    if (this.mine) this.finish(this.mine, 3, this.hosting);
    for (const [h] of this.known) if (h !== this.me) this.known.delete(h);
    this.asked = 0;
  }
  announce(): void { this.sendRoster(); }

  // ── The end ────────────────────────────────────────────────────────────────

  /** winner: 0 draw, 1 red, 2 blue, 3 called off. `tell` sends the End frame (the host). */
  private finish(host: number, winner: number, tell: boolean, red?: number, blue?: number): void {
    const f = this.known.get(host) ?? null, g = this.game;
    if (!f) { if (this.mine === host) this.out(''); return; }
    const was = this.mine === host;
    const r = red ?? f.red, b = blue ?? f.blue, mine = was ? this.team : 0, site = f.site, played = was ? this.playedS : 0;
    if (tell) this.send(SnowKind.End, { host: this.me, site, red: r, blue: b, winner });
    this.known.delete(f.host);
    this.results.set(site, { red: r, blue: b, winner, at: performance.now() });
    const score = mine === 1 ? r : b;
    let pay = 0;
    if (was && winner < 3 && played >= 30) {
      save.bump('sf.n'); this.stats.ended++;
      const won = winner === mine;
      if (won || winner === 0) {
        const n = save.count('sf.win');
        pay = Math.round((won ? PRIZE : PRIZE_DRAW) * taper(n).cash);
        g.player.money += pay; save.credit(pay); save.data.stats.earned += pay;
        if (won) save.bump('sf.win'); else save.bump('sf.draw');
      }
      save.record('sf.best', score, false);
      g.todo.saveNow();
    }
    if (was) this.last = { red: r, blue: b, winner, pay, mine, played: Math.round(played) };
    for (const k of this.bots) { k.live = false; k.stag = 0; }
    for (const q of this.balls) { q.live = false; q.m.visible = false; }
    this.immune.clear();
    this.humans = new Map();
    if (was) { this.mine = 0; this.team = 0; this.asked = 0; this.scoop = 0; this.setBusy(null); g.hud.objective(null); this.lastObj = ''; }
    const line = `RED ${r} - ${b} BLUE`;
    if (was) {
      if (winner === 3) this.toast('The snowball fight is called off.', 5);
      else if (winner === 0) g.hud.stamp('SNOWBALL FIGHT: A DRAW', `${line}${pay ? ` · $${pay} each` : ''}`);
      else if (winner === mine) g.hud.stamp('YOUR TEAM WINS', `${line}${pay ? ` · $${pay}` : played < 30 ? ' · too short a stay for a prize' : ''} · best ${save.data.best['sf.best'] ?? score}`);
      else g.hud.stamp('THE OTHER TEAM WINS', `${line} · snow in your collar, honour intact`);
    }
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  /** Settings > Accessibility > Marker colours: the end zones and the flags follow the palette (the letters RED and BLUE are always on the board). */
  private palVer = -1;
  private readonly flagMats: { m: THREE.MeshStandardMaterial; red: boolean }[] = [];
  private teamColours(): void {
    if (this.palVer === ACC.ver) return;
    this.palVer = ACC.ver;
    const d = ACC.pal === 'default';
    this.mats.red.color.setHex(d ? RED : ACC.n.red); this.mats.blue.color.setHex(d ? BLUE : ACC.n.blue);
    for (const f of this.flagMats) f.m.color.setHex(d ? (f.red ? RED : BLUE) : f.red ? ACC.n.red : ACC.n.blue);
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.clk += dt;
    this.teamColours();
    this.prompt = null;
    const g = this.game, p = g.player, now = performance.now();
    for (const [h, r] of this.known) if (h !== this.me && now - r.at > SILENCE_MS) { this.known.delete(h); if (this.mine === h) this.finish(h, 3, false); }
    if (this.asked && now - this.askedAt > 3500) { this.asked = 0; this.toast('Nobody answered. The fight may have just ended.', 3); }
    const snow = this.snowing;
    // The fields.
    for (const s of SITES) {
      if (!s.on) continue;
      const d = Math.hypot(p.x - s.x, p.z - s.z), show = snow && (d < NEAR_SHOW || this.mine > 0);
      let st = this.stages.get(s.id);
      if (show && !st) { st = this.build(s); this.stages.set(s.id, st); }
      if (st) { st.group.visible = show; if (show) this.board(s, st); }
    }
    const f = this.fight;
    if (this.mine && f) { this.round(dt, f); }
    else this.offer();
    this.flight(dt);
    this.marks();
    this.bodies(dt);
  }

  /** On the field and not in a round: the prompt. */
  private offer(): void {
    const g = this.game, p = g.player;
    if (!this.isFree() || p.vehicle || !(p.health > 0)) return;
    const s = this.siteNear();
    if (!s) return;
    if (!this.snowing) {
      if (Math.hypot(p.x - s.x, p.z - s.z) < 5) { this.prompt = '[G] Snowball fight: it needs snow lying on the ground'; if (g.input.eat('interact')) this.press(); }
      return;
    }
    const o = [...this.known.values()].find((r) => r.site === s.id);
    const slow = Math.abs(p.speed) < 3;
    if (o) this.prompt = `[G] Join the snowball fight at ${s.name}: RED ${o.red} - ${o.blue} BLUE, ${clockText(this.left(o))} left`;
    else this.prompt = `[G] Start a snowball fight at ${s.name}: red against blue, 3 minutes, townsfolk fill the sides`;
    if (g.input.eat('interact') && slow) this.press();
  }

  /** One frame of the round I am in. */
  private round(dt: number, f: Roster): void {
    const g = this.game, p = g.player, s = SITES[f.site], now = performance.now();
    if (this.hosting) {
      // The clock is the host's.
      f.left -= dt; f.at = now;
      if (f.phase === 1 && f.left <= 0) { f.phase = 2; f.left = ROUND_S; this.sendRoster(); g.hud.stamp('GO!', 'Snowballs away'); }
      else if (f.phase === 2 && f.left <= 0) { const w = f.red > f.blue ? 1 : f.blue > f.red ? 2 : 0; this.finish(this.me, w, true); return; }
      if (!this.snowing) { this.finish(this.me, 3, true); this.toast('The snow has melted. The snowball fight is called off.', 6); return; }
      if (this.link && now - this.rosterAt > ROSTER_MS) this.sendRoster();
      this.botsTick(dt);
      if (this.link && now - this.botsAt > BOTS_MS && this.link.others().length) this.sendBots(s);
    } else if (now - f.at > SILENCE_MS) { this.finish(f.host, 3, false); return; }
    // Leaving the field, or the car, or the town's end.
    if (p.vehicle || !(p.health > 0) || Math.hypot(p.x - s.x, p.z - s.z) > REACH) { this.leave(p.vehicle ? 'You got in a car and left the snowball fight.' : !(p.health > 0) ? 'You are out of the snowball fight.' : 'You left the field and the snowball fight.'); return; }
    if (f.phase === 2) this.playedS += dt;
    this.cool = Math.max(0, this.cool - dt);
    if (this.scoop > 0) {
      if (Math.abs(p.speed) > 2.2) { this.scoop = 0; this.toast('You moved: the scoop spilled.', 1.8); }
      else { this.scoop -= dt; if (this.scoop <= 0) { this.scoop = 0; this.ammo = Math.min(MAX_AMMO, this.ammo + SCOOP_N); this.toast(`Scooped. ${this.ammo} snowball${this.ammo === 1 ? '' : 's'}.`, 1.4); } }
    }
    if (g.input.eat('interact')) this.throwBall();
    if (g.input.eat('reload')) this.startScoop();
    const left = this.left(f);
    this.prompt = this.scoop > 0 ? 'Scooping snow...' : f.phase === 1 ? `Get ready: ${Math.ceil(left)}. [R] scoop now` : this.ammo ? `[G] Throw · [R] Scoop · ${this.ammo} snowball${this.ammo === 1 ? '' : 's'}` : 'Out of snowballs: [R] Scoop';
    const obj = f.phase === 1 ? `Snowball fight: get ready ${Math.ceil(left)}` : `Snowball fight  RED ${f.red} - ${f.blue} BLUE  ·  ${clockText(left)}`;
    if (obj !== this.lastObj) { this.lastObj = obj; g.hud.objective(obj); }
  }

  private sendBots(s: Site): void {
    this.botsAt = performance.now();
    const list: { dx: number; dz: number; h: number; f: number }[] = [];
    for (const b of this.bots) if (b.live) list.push({ dx: b.x - s.x, dz: b.z - s.z, h: Math.round(((b.h + Math.PI) / (Math.PI * 2)) * 256) & 255, f: (b.team === 2 ? 1 : 0) | (b.stag > 0 ? 2 : 0) });
    this.send(SnowKind.Bots, { list });
  }

  // ── What is drawn ──────────────────────────────────────────────────────────

  /** Everybody's team ring and cap, and the bots' bodies. */
  private marks(): void {
    const f = this.fight ?? [...this.known.values()].find((r) => { const s = SITES[r.site]; return Math.hypot(this.game.player.x - s.x, this.game.player.z - s.z) < NEAR_SHOW; }) ?? null;
    let n = 0;
    if (f && this.pool) {
      const put = (x: number, y: number, z: number, team: number, cap: boolean): void => {
        const t = this.tags[n++]; if (!t) return;
        const m = team === 1 ? this.mats.red : this.mats.blue;
        t.ring.material = m; t.cap.material = m; t.cap.visible = cap;
        t.g.position.set(x, y + 0.08, z); t.g.visible = true;
      };
      for (const h of f.ids) { const at = this.posOf(h.id); if (at) put(at.x, at.y, at.z, h.team, h.id !== this.me); }
      for (const b of this.bots) if (b.live) put(b.x, groundAt(b.x, b.z), b.z, b.team, true);
    }
    for (let k = n; k < this.tags.length; k++) this.tags[k].g.visible = false;
  }

  private bodies(dt: number): void {
    const any = this.bots.some((b) => b.live);
    if (!any && !this.people) return;
    if (!this.people) {
      this.people = [new People(3, [0xc2362b], 71), new People(3, [0x2f63c4], 72)];
      this.game.scene.add(this.people[0].mesh, this.people[1].mesh);
    }
    const host = this.hosting;
    for (const b of this.bots) {
      if (!b.live) continue;
      if (!host) { b.x += (b.tx - b.x) * Math.min(1, dt * 8); b.z += (b.tz - b.z) * Math.min(1, dt * 8); if (b.stag > 0) b.stag -= dt; }
    }
    this.bots.forEach((b, k) => {
      const pe = this.people as [People, People], P = b.team === 1 ? pe[0] : pe[1], i = k % 3;
      if (!b.live) { P.put(i, 0, -9999, 0, 0, 1); return; }
      const wob = b.stag > 0 ? 0.55 * Math.sin(Math.min(1, b.stag / 1.3) * Math.PI) : 0;
      P.put(i, b.x, groundAt(b.x, b.z) + (b.stag > 0 ? 0 : Math.abs(Math.sin(this.clk * 7 + k)) * 0.04), b.z, b.h, 1.0, wob);
    });
    this.people[0].commit(); this.people[1].commit();
  }

  /** The radar: a badge on each field while snow lies. */
  blips(out: Blip[]): void {
    if (!this.snowing) return;
    const p = this.game.player;
    for (const s of SITES) if (s.on && Math.hypot(p.x - s.x, p.z - s.z) < 900) out.push({ x: s.x, z: s.z, kind: 'job', label: 'S' });
  }

  // ── The fields ─────────────────────────────────────────────────────────────

  private build(s: Site): Stage {
    const group = new THREE.Group(); group.name = `snowfight-${s.id}`;
    const hw = FIELD_W / 2, hd = FIELD_D / 2;
    const ribbon = (pts: [number, number][], w: number, color: number): THREE.Mesh => {
      const pos: number[] = [], idx: number[] = [];
      let n = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1], len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / 2));
        const nx = -(bz - az) / len * (w / 2), nz = (bx - ax) / len * (w / 2);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = groundAt(x, z) + 0.07;
          pos.push(x + nx, y, z + nz, x - nx, y, z - nz);
          if (k < steps) { idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
          n += 2;
        }
        n = pos.length / 3;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.frustumCulled = false; m.renderOrder = 2;
      return m;
    };
    const X = s.x, Z = s.z;
    group.add(ribbon([[X - hw, Z - hd], [X + hw, Z - hd], [X + hw, Z + hd], [X - hw, Z + hd], [X - hw, Z - hd]], 0.45, 0x2b3f66));
    group.add(ribbon([[X, Z - hd], [X, Z + hd]], 0.4, 0xf0a202));
    const dark = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 });
    const pole = new THREE.BoxGeometry(0.09, 3.2, 0.09), flag = new THREE.BoxGeometry(1.0, 0.6, 0.04);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = X + sx * hw, z = Z + sz * hd, y = groundAt(x, z);
      const pl = new THREE.Mesh(pole, dark); pl.position.set(x, y + 1.6, z); pl.castShadow = false; group.add(pl);
      const fm = new THREE.MeshStandardMaterial({ color: sx < 0 ? RED : BLUE, roughness: 0.8 }); this.flagMats.push({ m: fm, red: sx < 0 }); this.palVer = -1;
      const fl = new THREE.Mesh(flag, fm); fl.position.set(x + (sx < 0 ? 0.5 : -0.5), y + 2.9, z); fl.castShadow = false; group.add(fl);
    }
    const mound = new THREE.SphereGeometry(1, 12, 8), snow = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 1 });
    for (const sx of [-1, 1]) for (const dz of [-6, 0, 6]) {
      const x = X + sx * (hw - 2.5), z = Z + dz, y = groundAt(x, z), m = new THREE.Mesh(mound, snow);
      m.scale.set(1.5, 0.55, 1.0); m.position.set(x, y + 0.1, z); m.castShadow = false; group.add(m);
    }
    // The billboard: two poles at the north edge, one face each way.
    const bz = Z - hd - 3, by = groundAt(X, bz);
    for (const sx of [-1, 1]) { const pl = new THREE.Mesh(new THREE.BoxGeometry(0.22, 7, 0.22), dark); pl.position.set(X + sx * 4.2, by + 3.5, bz); group.add(pl); }
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 512;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const bm = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    for (const ry of [0, Math.PI]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 4.2), bm);
      pl.position.set(X, by + 5.1, bz + (ry ? -0.13 : 0.13)); pl.rotation.y = ry; group.add(pl);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(8.6, 4.4, 0.2), dark); back.position.set(X, by + 5.1, bz); group.add(back);
    this.game.scene.add(group);
    return { group, tex, cv, key: '' };
  }

  /** Draw the billboard when its words change. */
  private board(s: Site, st: Stage): void {
    const f = this.mine && this.fight && this.fight.site === s.id ? this.fight : [...this.known.values()].find((r) => r.site === s.id) ?? null;
    const res = this.results.get(s.id);
    let red = 0, blue = 0, mid = '', sub = '', lead = 0;
    if (f) {
      red = f.red; blue = f.blue;
      const t = this.left(f);
      mid = f.phase === 1 ? `READY ${Math.ceil(t)}` : clockText(t);
      sub = `${f.ids.length} player${f.ids.length === 1 ? '' : 's'} + ${f.botsR + f.botsB} townsfolk · G to join`;
      lead = red === blue ? 0 : red > blue ? 1 : 2;
    } else if (res) {
      red = res.red; blue = res.blue; lead = res.winner === 3 ? 0 : res.winner;
      mid = res.winner === 3 ? 'OFF' : res.winner === 0 ? 'DRAW' : res.winner === 1 ? 'RED WINS' : 'BLUE WINS';
      sub = 'Last fight · stand on the field and press G for another';
    } else { mid = 'READY'; sub = 'Stand on the field and press G to start a fight'; }
    const key = `${f ? 1 : res ? 2 : 0}|${red}|${blue}|${mid}|${sub}`;
    if (key === st.key) return;
    st.key = key;
    const c = st.cv.getContext('2d') as CanvasRenderingContext2D, W = 1024, H = 512;
    c.fillStyle = '#14213d'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#f0a202'; c.lineWidth = 10; c.strokeRect(14, 14, W - 28, H - 28);
    const font = (px: number): string => `800 ${px}px "Big Shoulders Display","Arial Narrow",system-ui,sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#f2e8cf'; c.font = font(52); c.fillText(`SNOWBALL FIGHT · ${s.name.toUpperCase()}`, W / 2, 70);
    const box = (x: number, col: string, label: string, n: number, on: boolean): void => {
      c.fillStyle = col; c.fillRect(x, 130, 300, 230);
      if (on) { c.strokeStyle = '#f2e8cf'; c.lineWidth = 8; c.strokeRect(x + 4, 134, 292, 222); }
      c.fillStyle = '#f2e8cf'; c.font = font(60); c.fillText(label, x + 150, 175);
      c.font = font(150); c.fillText(String(n), x + 150, 285);
    };
    const dflt = ACC.pal === 'default';
    box(60, dflt ? '#b3262e' : ACC.c.red, 'RED', red, lead === 1); box(W - 360, dflt ? '#2a5db0' : ACC.c.blue, 'BLUE', blue, lead === 2);
    c.fillStyle = '#f0a202'; c.font = font(mid.length > 6 ? 74 : 110); c.fillText(mid, W / 2, 245);
    c.fillStyle = '#f2e8cf'; c.font = font(40); c.fillText(sub, W / 2, 430);
    st.tex.needsUpdate = true;
  }

  // ── For the tag, the Places panel and the tests ────────────────────────────

  /** What the on-screen tag shows (ui/snowTag.ts). */
  tag(): { in: boolean; ammo: number; scooping: boolean; phase: number; join: string | null; line: string } {
    const f = this.fight;
    if (this.mine && f) return { in: true, ammo: this.ammo, scooping: this.scoop > 0, phase: f.phase, join: null, line: `${this.team === 1 ? 'RED' : 'BLUE'} · ${f.red}-${f.blue}` };
    const s = this.siteNear(), o = s && this.snowing ? [...this.known.values()].find((r) => r.site === s.id) : null;
    if (o && s && this.isFree() && !this.game.player.vehicle) return { in: false, ammo: 0, scooping: false, phase: 0, join: `Snowball fight at ${s.name} · tap to join`, line: '' };
    return { in: false, ammo: 0, scooping: false, phase: 0, join: null, line: '' };
  }

  info(): Record<string, unknown> {
    const f = this.fight;
    return {
      mine: this.mine, team: this.team, hosting: this.hosting, snowing: this.snowing, ammo: this.ammo, scoop: this.scoop > 0,
      phase: f ? f.phase : 0, left: f ? Math.round(this.left(f) * 10) / 10 : 0, red: f ? f.red : 0, blue: f ? f.blue : 0,
      ids: f ? f.ids.slice() : [], botsR: f ? f.botsR : 0, botsB: f ? f.botsB : 0,
      bots: this.bots.filter((b) => b.live).map((b) => ({ id: b.id, team: b.team, x: Math.round(b.x * 10) / 10, z: Math.round(b.z * 10) / 10, stag: b.stag > 0 })),
      balls: this.balls.filter((b) => b.live).length,
      known: [...this.known.values()].map((r) => ({ host: r.host, site: r.site, red: r.red, blue: r.blue, phase: r.phase, n: r.ids.length })),
      sites: SITES.filter((s) => s.on).map((s) => ({ id: s.id, name: s.name, x: s.x, z: s.z })),
      boards: [...this.stages.entries()].map(([id, st]) => ({ id, key: st.key, visible: st.group.visible })),
      myHits: this.myHits, last: this.last, ...this.stats,
    };
  }
}
