// Giant rubber duck events (fun queue item 6): now and then the duck breaks its moorings and goes for a float.
//
// When: the town clock (sky.day and sky.hour, the host's in a shared town) is cut into two-day cycles of game minutes.
// A seeded hash of the cycle's number says when in it the duck breaks loose. It is then loose for LOOSE game minutes
// (twenty minutes of play at the default rate); if nobody has pushed it home by then, it retraces its own drift back to
// the mooring over HOME minutes, sheepishly, and ties itself up.
//
// Where: the drift is a path simulated once per cycle from the same seed, a game minute at a time: a wind from offshore
// that veers, a meander, a push away from every shore and the pier, and a soft leash so it stays within about 550 m of
// home. Every screen computes the same path, so in a shared town everybody sees the same duck in the same place without
// a byte on the wire. The way home is the same path backwards, so it never crosses land.
//
// Pushing: boats (Player.boats) and cars ram it. Each hit trades momentum (the duck is heavier than a speedboat and far
// heavier than a jet ski), sets it spinning from the off-centre part of the blow and tips it over, and it glides on and
// slows in the water. That is a local offset on top of the shared path. Alone in town the offset stays where it is put;
// in a shared town the HOST owns it (net/extras.ts, Event code 20): it sends where the duck has been pushed to, a guest's
// shove is applied on the guest's screen at once and sent to the host, which applies it too; every guest eases onto the
// host's duck. The duck never goes onto land or into a wall.
//
// Home: a glowing ring on the water at the mooring while it is out. Pushed inside it, the duck re-moors: fireworks
// (fx/fireworks.ts launch), a toast and a stamp, a few hundred dollars split among the people who pushed it in the last
// minute (this browser only knows about its own player), and the "ducksReturned" count in the save.
//
// Radar: a teal "D" while it is out. Test hook: window.__duck.loose() sets it loose now, .info() reports.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle, WorldPart } from '../core/api';
import type { Blip } from '../ui/hud';
import type { Fireworks, ShellType } from '../fx/fireworks';
import { WATER_Y, PIER, PIER_HEAD, groundAt } from './plan';
import { seaSlope, seaY } from './sea';
import { DUCK, DUCK_HOME } from './duckState';
import { duckWall } from './landmarks';
import { save } from '../game/save';
import { money, pickRand } from '../core/util';

/** Cycle length, game minutes (two game days). */
const CYCLE = 2880;
/** Loose for this long before it gives up and drifts home, game minutes. */
const LOOSE = 1200;
/** The sheepish drift home, game minutes. */
const HOME = 120;
/** Drift speed on the path, m per game minute. */
const DRIFT = 0.42;
const LEASH = 550;
/** Duck body radius for pushing, m; the home ring's radius, and how far inside it counts. */
const R = 4.8;
const RING = 16;
const INSIDE = 11;
const REWARD = 300;
const PUSH_WINDOW = 60;

const DJ = 'The duck is loose. Again.';
const DJ_MORE = [
  'Harbor Authority asks boaters to return the duck to its mooring. It does not say how.',
  'Anyone with a boat and an afternoon: the duck needs you.',
  'The duck is drifting toward open water. The duck has no plan.',
];
const LATE = ['The giant duck is out in the bay. It is not supposed to be.', 'The duck is loose. You may have heard.'];
const HOMEBOUND = 'Nobody came for the duck. It is paddling home on its own. Sheepishly.';
const MOORED_SELF = 'The duck has tied itself back up. It would rather not discuss it.';
const BACK = ['The duck is home.', 'Duck returned to mooring. Paperwork filed.', 'The duck is back where it belongs. For now.'];

const hash = (a: number, b: number): number => {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth01 = (x: number): number => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const rectDist = (x: number, z: number, r: { x0: number; z0: number; x1: number; z1: number }): number =>
  Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
/** Too shallow for an eight-meter duck, or dry land. */
const land = (x: number, z: number): boolean => groundAt(x, z) > WATER_Y - 1.4;

type Phase = 'moored' | 'loose' | 'homeward' | 'return';

export class DuckLoose implements WorldPart {
  readonly stats = { phase: 'moored' as Phase, cycle: -1, t0: 0, tau: 0, x: 0, z: 0, ox: 0, oz: 0, hits: 0, returned: 0, ms: 0 };
  private path = new Float32Array(0);
  private yawPath = new Float32Array(0);
  private pathKey = '';
  /** Local push offset (m) and its speed (m/s). */
  private ox = 0; private oz = 0; private ovx = 0; private ovz = 0;
  private spin = 0; private yawOff = 0;
  private tx = 0; private tz = 0; private tvx = 0; private tvz = 0;
  /** The cycle this browser saw returned home, and the test hook's own start time. */
  private returnedCycle = -1;
  private forcedT0 = -1;
  private lastPhase: Phase = 'moored';
  private announcedCycle = -1;
  private retT = 0; private retX = 0; private retZ = 0;
  private honkT = 20;
  private lastPush = -1e9;
  /** Shared town: the path's seed (which spell), when the host last sent its state, and a guest's shoves not yet sent. */
  private seed = 0;
  private sendT = 0;
  private readonly pend = [0, 0, 0, 0, 0];
  private pendT = 0;
  private now = 0;
  private hitCool = 0;
  private readonly blip: Blip = { x: DUCK_HOME.x, z: DUCK_HOME.z, kind: 'job', label: 'D' };
  private blipT = 0;
  private readonly ring: THREE.Group;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly sl = { x: 0, z: 0, vy: 0 };
  private readonly shows: { t: number; type: ShellType; x: number; z: number; h: number; c1: number; c2: number }[] = [];

  constructor(private readonly game: Game, parent: THREE.Group, private readonly fw: Fireworks | null) {
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.ring = new THREE.Group();
    this.ring.name = 'duck-home-ring';
    const torus = new THREE.Mesh(new THREE.TorusGeometry(RING, 0.32, 8, 96), this.ringMat);
    torus.rotation.x = Math.PI / 2;
    // A low curtain of light standing on the ring, brightest at the water: findable from across the bay.
    const cg = new THREE.CylinderGeometry(RING, RING, 4, 64, 1, true);
    const pos = cg.getAttribute('position'), col: number[] = [];
    for (let i = 0; i < pos.count; i++) { const k = pos.getY(i) < 0 ? 1 : 0; col.push(k, k, k); }
    cg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.glowMat.vertexColors = true;
    const curtain = new THREE.Mesh(cg, this.glowMat);
    curtain.position.y = 2;
    this.ring.add(torus, curtain);
    this.ring.position.set(DUCK_HOME.x, WATER_Y + 0.25, DUCK_HOME.z);
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    parent.add(this.ring);
    (game as unknown as { duckLoose?: DuckLoose }).duckLoose = this;
    (window as unknown as { __duck: unknown }).__duck = {
      loose: (): void => { this.forcedT0 = this.clock(); this.returnedCycle = -1; },
      info: (): Record<string, unknown> => ({ ...this.stats }),
      self: this,
    };
  }

  /** The town's clock in game minutes since its day 0. */
  private clock(): number {
    const sky = this.game.sky as unknown as { hour: number; day?: number } | undefined;
    if (!sky) return 0;
    return (sky.day ?? 0) * 1440 + sky.hour * 60;
  }

  /** Start of the loose spell in cycle k, game minutes. Pure: the same on every screen. */
  private startOf(k: number): number {
    return k * CYCLE + 240 + hash(k, 17) * (CYCLE - LOOSE - HOME - 480);
  }

  /** The drift for one spell, a sample per game minute. */
  private buildPath(seed: number): void {
    const N = LOOSE + 1, P = new Float32Array(N * 2), Y = new Float32Array(N);
    const r = (k: number): number => hash(seed, k);
    // Offshore at the mooring is +z (the pier runs out that way); the wind starts within about 60 degrees of it.
    const base = (r(1) - 0.5) * 2.1, ph1 = r(2) * 6.3, ph2 = r(3) * 6.3, ph3 = r(4) * 6.3, ph4 = r(5) * 6.3;
    let x: number = DUCK_HOME.x, z: number = DUCK_HOME.z, vx = 0, vz = 0, yaw = 0;
    P[0] = x; P[1] = z; Y[0] = 0;
    for (let i = 1; i < N; i++) {
      const a = base + 0.75 * Math.sin(i / 170 + ph1) + 0.35 * Math.sin(i / 53 + ph2);
      const sp = DRIFT * (0.75 + 0.3 * Math.sin(i / 90 + ph3));
      let tx = Math.sin(a) * sp, tz = Math.cos(a) * sp;
      // Away from shores: probe eight ways at 32 m.
      if (i % 2 === 1 || i < 4) {
        for (let k = 0; k < 8; k++) {
          const b = (k / 8) * Math.PI * 2, px = Math.sin(b), pz = Math.cos(b);
          if (land(x + px * 32, z + pz * 32)) { tx -= px * 0.3; tz -= pz * 0.3; }
        }
      }
      for (const rc of [PIER, PIER_HEAD]) {
        const d = rectDist(x, z, rc);
        if (d < 18) {
          const cx = Math.max(rc.x0, Math.min(rc.x1, x)), cz = Math.max(rc.z0, Math.min(rc.z1, z));
          const l = Math.hypot(x - cx, z - cz) || 1;
          tx += ((x - cx) / l) * 0.4; tz += ((z - cz) / l) * 0.4;
        }
      }
      const hd = Math.hypot(x - DUCK_HOME.x, z - DUCK_HOME.z);
      if (hd > LEASH) { const k = (hd - LEASH) / 120; tx -= ((x - DUCK_HOME.x) / hd) * k; tz -= ((z - DUCK_HOME.z) / hd) * k; }
      vx += (tx - vx) * 0.08; vz += (tz - vz) * 0.08;
      const nx = x + vx, nz = z + vz;
      if (!land(nx, nz)) { x = nx; z = nz; } else { vx *= -0.3; vz *= -0.3; }
      yaw += 0.006 * Math.sin(i / 41 + ph4) + 0.0015;
      P[i * 2] = x; P[i * 2 + 1] = z; Y[i] = yaw;
    }
    this.path = P; this.yawPath = Y;
  }

  /** Path position at tau game minutes into the spell (the way home is the drift backwards). */
  private pathAt(tau: number, out: { x: number; z: number; yaw: number }): void {
    let s = tau;
    if (tau >= LOOSE) s = LOOSE * (1 - smooth01((tau - LOOSE) / HOME));
    s = Math.max(0, Math.min(LOOSE, s));
    const i = Math.min(LOOSE - 1, Math.floor(s)), f = s - i, P = this.path;
    out.x = P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * f;
    out.z = P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * f;
    out.yaw = this.yawPath[i] + (this.yawPath[i + 1] - this.yawPath[i]) * f;
  }

  private readonly at = { x: 0, z: 0, yaw: 0 };

  update(dt: number): void {
    const t0p = performance.now();
    const g = this.game;
    if (!g.sky) return;
    this.now += dt;
    const T = this.clock();
    // Which spell are we in (or near)? This cycle's, or the last one's homeward tail.
    let k = Math.floor(T / CYCLE), t0 = this.startOf(k);
    if (T < t0 && k > 0 && T < this.startOf(k - 1) + LOOSE + HOME) { k--; t0 = this.startOf(k); }
    let key = `${k}`;
    if (this.forcedT0 >= 0) {
      if (T >= this.forcedT0 && T < this.forcedT0 + LOOSE + HOME) { t0 = this.forcedT0; k = -2; key = `f${Math.round(t0)}`; }
      else if (T >= this.forcedT0 + LOOSE + HOME || T < this.forcedT0 - 1) this.forcedT0 = -1;
    }
    const tau = T - t0;
    let phase: Phase = tau >= 0 && tau < LOOSE ? 'loose' : tau >= LOOSE && tau < LOOSE + HOME ? 'homeward' : 'moored';
    if (phase !== 'moored' && this.returnedCycle === k) phase = 'moored';
    if (this.retT > 0) phase = 'return';
    if (phase !== 'moored' && phase !== 'return' && key !== this.pathKey) {
      this.pathKey = key;
      this.seed = k === -2 ? Math.round(t0) * 7 + 3 : k * 7919 + 101;
      this.buildPath(this.seed);
      this.ox = this.oz = this.ovx = this.ovz = 0;
      this.yawOff = 0; this.spin = 0;
    }

    // Edges between phases: the radio, the toasts, the wall at the mooring.
    if (phase !== this.lastPhase) this.edge(this.lastPhase, phase, tau, k);
    this.lastPhase = phase;
    const s = this.stats;
    s.phase = phase; s.cycle = k; s.t0 = Math.round(t0); s.tau = Math.round(tau);

    if (phase === 'moored') {
      DUCK.loose = false; DUCK.x = DUCK_HOME.x; DUCK.z = DUCK_HOME.z; s.x = DUCK.x; s.z = DUCK.z;
      DUCK.yaw = this.yawOff; DUCK.tiltX = 0; DUCK.tiltZ = 0;
      this.ring.visible = false;
      this.tickShows();
      this.blipOff();
      s.ms = performance.now() - t0p;
      return;
    }

    let x: number, z: number;
    const at = this.at;
    if (phase === 'return') {
      // Pushed home: glide the last few meters onto the mooring and swing back to face the pier.
      this.retT = Math.max(0, this.retT - dt);
      const f = smooth01(1 - this.retT / 4);
      x = this.retX + (DUCK_HOME.x - this.retX) * f;
      z = this.retZ + (DUCK_HOME.z - this.retZ) * f;
      this.yawOff *= Math.exp(-dt * 1.2);
      this.spin = 0;
      if (this.retT <= 0) { this.ox = this.oz = 0; }
    } else {
      this.pathAt(tau, at);
      this.push(dt, at, phase);
      this.netTick(dt);
      x = at.x + this.ox; z = at.z + this.oz;
    }

    // Spin and tilt springs.
    this.spin *= Math.exp(-dt * 0.5);
    this.yawOff += this.spin * dt;
    this.tvx += (-9 * this.tx - 1.2 * this.tvx) * dt; this.tx += this.tvx * dt;
    this.tvz += (-9 * this.tz - 1.2 * this.tvz) * dt; this.tz += this.tvz * dt;
    seaSlope(x, z, this.sl);
    const tt = this.now;
    DUCK.loose = true;
    DUCK.x = x; DUCK.z = z;
    DUCK.y = seaY(x, z) + Math.sin(tt * 0.9) * 0.25 + Math.sin(tt * 2.1) * 0.06;
    DUCK.yaw = (phase === 'return' ? 0 : at.yaw) + this.yawOff;
    DUCK.tiltX = -Math.atan(this.sl.z) * 0.8 + this.tx + Math.sin(tt * 0.61) * 0.03;
    DUCK.tiltZ = Math.atan(this.sl.x) * 0.8 + this.tz + Math.sin(tt * 0.83 + 1) * 0.035;
    s.x = Math.round(x); s.z = Math.round(z); s.ox = Math.round(this.ox); s.oz = Math.round(this.oz);

    // The ring at home, pulsing; the radar marker.
    this.ring.visible = phase !== 'return' || this.retT > 1;
    const pulse = 0.5 + 0.5 * Math.sin(tt * 2.4);
    this.ringMat.opacity = 0.55 + 0.4 * pulse;
    this.glowMat.opacity = 0.14 + 0.12 * pulse;
    this.ring.position.y = WATER_Y + 0.25 + Math.sin(tt * 0.9) * 0.08;
    this.blipOn(x, z, dt);

    // A honk now and then, so it can be found by ear.
    if ((this.honkT -= dt) <= 0) {
      this.honkT = 18 + Math.random() * 35;
      g.emit('duck', { x, z });
      this.tvx += 0.08;
    }

    // Home? (Pushed inside the ring while out, or drifted in on its own way back.)
    if (phase !== 'return') {
      const hd = Math.hypot(x - DUCK_HOME.x, z - DUCK_HOME.z);
      if (phase === 'loose' && hd < INSIDE && tau > 3 && this.now - this.lastPush < PUSH_WINDOW) this.returned(k, x, z, true);
      // On its own way home, somebody who helped it in still gets the credit; otherwise it just ties itself up (edge()).
      else if (phase === 'homeward' && hd < INSIDE && this.now - this.lastPush < PUSH_WINDOW) this.returned(k, x, z, true);
    }
    this.tickShows();
    s.ms = performance.now() - t0p;
  }

  private edge(from: Phase, to: Phase, tau: number, k: number): void {
    const g = this.game, hud = g.hud;
    const box = duckWall.box;
    if (box) {
      // Out: the wall at the mooring folds away (this file pushes things off the duck instead). Home: back up.
      if (to === 'moored') { box.y0 = duckWall.y0; box.y1 = duckWall.y1; } else { box.y0 = -999; box.y1 = -998; }
    }
    if (to === 'loose' && from === 'moored' && this.announcedCycle !== k) {
      this.announcedCycle = k;
      if (g.state !== 'play') return;
      if (tau < 5) {
        hud.toast(`${DJ} Push it back to the glowing ring with a boat. There is a reward.`, 7);
        hud.subtitle('Harbor radio', `${DJ} ${pickRand(DJ_MORE)}`, 7);
      } else hud.toast(`${pickRand(LATE)} Push it back to the glowing ring off the pier for a reward.`, 6);
      g.emit('duck', { x: DUCK.x, z: DUCK.z });
    } else if (to === 'homeward' && from === 'loose' && g.state === 'play') {
      hud.toast(HOMEBOUND, 6);
    } else if (to === 'moored' && from === 'homeward' && g.state === 'play') {
      hud.toast(MOORED_SELF, 5);
    }
  }

  /** The host: say where the duck is pushed to, four times a second while it moves and every two seconds at rest. */
  private netTick(dt: number): void {
    const ex = this.game.net?.extras;
    if (!ex || !ex.hosting) return;
    this.sendT -= dt;
    if (this.sendT > 0) return;
    const moving = Math.abs(this.ovx) + Math.abs(this.ovz) > 0.03 || Math.abs(this.spin) > 0.02;
    this.sendT = moving ? 0.25 : 2;
    if (!moving && Math.abs(this.ox) + Math.abs(this.oz) < 0.01 && Math.abs(this.yawOff) < 0.01) return;
    ex.duckState(this.seed, [this.ox, this.oz, this.ovx, this.ovz, this.spin, this.yawOff]);
  }

  private get pushable(): boolean { return this.retT <= 0 && (this.lastPhase === 'loose' || this.lastPhase === 'homeward'); }

  /** A guest: the host's duck (net/extras.ts). Ease this screen's offset onto it; a long way off snaps. */
  netState(seed: number, ox: number, oz: number, vx: number, vz: number, spin: number, yaw: number): void {
    if (!this.pushable || (seed & 0xffff) !== (this.seed & 0xffff)) return;
    const far = Math.hypot(ox - this.ox, oz - this.oz) > 4;
    const k = far ? 1 : 0.5;
    this.ox += (ox - this.ox) * k; this.oz += (oz - this.oz) * k;
    this.ovx += (vx - this.ovx) * k; this.ovz += (vz - this.ovz) * k;
    this.spin += (spin - this.spin) * k;
    let dy = (yaw - this.yawOff) % (Math.PI * 2);
    if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
    this.yawOff += dy * k;
  }

  /** The host: a guest's vehicle has shoved the duck. */
  netPush(seed: number, dvx: number, dvz: number, dpx: number, dpz: number, dspin: number): void {
    if (!this.pushable || (seed & 0xffff) !== (this.seed & 0xffff)) return;
    this.ox += dpx; this.oz += dpz; this.ovx += dvx; this.ovz += dvz;
    this.spin = Math.max(-1.6, Math.min(1.6, this.spin + dspin));
    this.tvx += dvz * 0.5; this.tvz -= dvx * 0.5;
    this.sendT = 0;
  }

  /** Somebody pushed it into the ring: it is home here too, and whoever pushed it here is paid as well. */
  netHome(seed: number): void {
    if (!this.pushable || (seed & 0xffff) !== (this.seed & 0xffff)) return;
    this.returned(this.stats.cycle, DUCK.x, DUCK.z, this.now - this.lastPush < PUSH_WINDOW, true);
  }

  private returned(k: number, x: number, z: number, credit: boolean, fromNet = false): void {
    const g = this.game;
    if (!fromNet) g.net?.extras.duckHome(this.seed);
    this.returnedCycle = k;
    this.retT = 4; this.retX = x; this.retZ = z;
    this.ox = this.oz = this.ovx = this.ovz = 0;
    this.stats.returned++;
    g.emit('duck', { x, z });
    // Fireworks over the mooring: a short volley, whatever the hour.
    const types: ShellType[] = ['peony', 'chrys', 'ring', 'palm', 'heart', 'glitter', 'willow'];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      this.shows.push({ t: this.now + 0.3 + i * 0.35 + Math.random() * 0.2, type: types[i], x: DUCK_HOME.x + Math.cos(a) * 14, z: DUCK_HOME.z + Math.sin(a) * 14, h: 38 + Math.random() * 22, c1: i, c2: i + 3 });
    }
    if (!credit) { g.hud.toast(`${pickRand(BACK)} Nobody pushed it, so nobody gets paid.`, 5); return; }
    // Split among everybody who pushed in the last minute. This browser only knows its own player (see the report).
    const pushers = 1;
    const share = Math.round(REWARD / pushers);
    g.player.money += share;
    save.data.stats.earned += share;
    const n = save.bump('ducksReturned');
    g.hud.stamp('DUCK RETURNED', `${money(share)} · ducks returned: ${n}`);
    g.hud.toast(`${pickRand(BACK)} The Harbor Authority pays ${money(share)}, with visible reluctance.`, 6);
  }

  private tickShows(): void {
    if (!this.shows.length) return;
    for (let i = this.shows.length - 1; i >= 0; i--) {
      const c = this.shows[i];
      if (c.t > this.now) continue;
      this.fw?.launch(c.type, c.x, WATER_Y + 1.2, c.z, c.h, c.c1, c.c2, 0.85, true);
      this.shows.splice(i, 1);
    }
  }

  /** Boats and cars that hit the duck, the player on foot, and the glide afterwards. */
  private push(dt: number, at: { x: number; z: number }, phase: Phase): void {
    const g = this.game;
    this.hitCool -= dt;
    // The water slows it; in a shared town, the local push walks itself back to the shared path.
    const drag = Math.exp(-dt * 0.32);
    this.ovx *= drag; this.ovz *= drag;
    // On its own way home the push wears off (every screen the same); otherwise it stays where it was put.
    if (phase === 'homeward') {
      const k = Math.exp(-dt / 20);
      this.ox *= k; this.oz *= k;
    }
    const ox0 = this.ox, oz0 = this.oz, ovx0 = this.ovx, ovz0 = this.ovz, spin0 = this.spin;
    let mineHit = false;
    const px = this.ox, pz = this.oz;
    this.ox += this.ovx * dt; this.oz += this.ovz * dt;

    const dy = DUCK.y;
    const list: Vehicle[] = [];
    for (const v of g.player.boats.list) list.push(v);
    for (const v of g.vehicles.list) list.push(v);
    for (const v of list) {
      if (v.removed) continue;
      const cx = at.x + this.ox, cz = at.z + this.oz;
      const rx = v.x - cx, rz = v.z - cz;
      if (rx * rx + rz * rz > 225 || v.y < dy - 3 || v.y > dy + 7) continue;
      const sh = Math.sin(v.h), ch = Math.cos(v.h);
      // The duck's centre in the vehicle's frame; nearest point of its box; the normal from the vehicle toward the duck.
      const ox = cx - v.x, oz = cz - v.z;
      const lf = ox * sh + oz * ch, lat = -ox * ch + oz * sh;
      const ef = lf - Math.max(-v.hl, Math.min(v.hl, lf)), er = lat - Math.max(-v.hw, Math.min(v.hw, lat));
      const dd = Math.hypot(ef, er);
      let nlf: number, nlat: number, depth: number;
      if (dd > 1e-4) {
        if (dd >= R) continue;
        nlf = ef / dd; nlat = er / dd; depth = R - dd;
      } else {
        const pf = v.hl - Math.abs(lf), pr = v.hw - Math.abs(lat);
        if (pf < pr) { nlf = Math.sign(lf) || 1; nlat = 0; depth = pf + R; } else { nlf = 0; nlat = Math.sign(lat) || 1; depth = pr + R; }
      }
      const nx = nlf * sh - nlat * ch, nz = nlf * ch + nlat * sh;
      // Masses in boat units: the duck is a big balloon full of water ballast, heavier than any of them.
      const boat = 'hull' in v;
      const mb = boat ? ((v as unknown as { kind: string }).kind === 'jetski' ? 0.35 : 1) : 1.3, md = 1.6;
      const rvx = v.vx - this.ovx, rvz = v.vz - this.ovz;
      const vn = rvx * nx + rvz * nz;
      // Separate: the duck gives way more than the hull does.
      const sd = md / (mb + md);
      if (v === g.player.vehicle) mineHit = true;
      this.ox += nx * depth * (1 - sd) + nx * depth * 0.25; this.oz += nz * depth * (1 - sd) + nz * depth * 0.25;
      v.x -= nx * depth * sd; v.z -= nz * depth * sd;
      if (vn <= 0) continue;
      const j = (1.25 * vn) / (1 / mb + 1 / md);
      this.ovx += (nx * j) / md; this.ovz += (nz * j) / md;
      v.vx -= (nx * j) / mb; v.vz -= (nz * j) / mb;
      // Spin from the glancing part of the blow, and a tip over in the direction it was shoved.
      const vt = rvx * -nz + rvz * nx;
      this.spin = Math.max(-1.6, Math.min(1.6, this.spin + vt * 0.05 + (Math.hypot(rx, rz) > 0 ? (rx * nz - rz * nx) * vn * 0.004 : 0)));
      const tip = Math.min(0.12, j * 0.012);
      this.tvx += nz * tip * 6; this.tvz -= nx * tip * 6;
      this.stats.hits++;
      const mine = v === g.player.vehicle;
      if (mine && j > 0.25) this.lastPush = this.now;
      if (j > 4 && this.hitCool <= 0) {
        this.hitCool = 2.5;
        g.emit('duck', { x: cx, z: cz });
        if (mine && save.bump('duckRammed') === 1) g.hud.toast('It moves. Slowly. Keep pushing it toward the glowing ring.', 5);
      }
    }

    // A guest tells the host what its own vehicle has done to the duck (the host applies the same shove).
    if (mineHit && g.net?.extras.guest) {
      const q = this.pend;
      q[0] += this.ovx - ovx0; q[1] += this.ovz - ovz0; q[2] += this.ox - ox0; q[3] += this.oz - oz0; q[4] += this.spin - spin0;
      if (this.pendT <= 0) this.pendT = 0.1;
    }
    if (this.pendT > 0 && (this.pendT -= dt) <= 0) {
      const q = this.pend;
      if (q.some((n) => Math.abs(n) > 1e-4)) g.net?.extras.duckPush(this.seed, q);
      q.fill(0);
    }

    // On foot (swimming, or on the pier edge): the duck shoulders her aside.
    const pl = g.player;
    if (!pl.vehicle) {
      const per = pl.person;
      const cx = at.x + this.ox, cz = at.z + this.oz;
      const dx = per.x - cx, dz = per.z - cz, d = Math.hypot(dx, dz), rr = R + 0.4;
      if (d < rr && d > 1e-4 && per.y < dy + 7) { per.x = cx + (dx / d) * rr; per.z = cz + (dz / d) * rr; }
    }

    // Never onto land, under the pier or through a wall.
    const cx = at.x + this.ox, cz = at.z + this.oz;
    if (land(cx, cz)) { this.ox = px; this.oz = pz; this.ovx *= -0.3; this.ovz *= -0.3; }
    else {
      g.col.forBoxes(cx, cz, R, (b) => {
        if (b === duckWall.box || b.y1 < WATER_Y + 0.3 || b.y0 > WATER_Y + 5) return;
        const qx = Math.max(b.x0, Math.min(b.x1, cx)), qz = Math.max(b.z0, Math.min(b.z1, cz));
        const ex = cx - qx, ez = cz - qz, e = Math.hypot(ex, ez);
        if (e >= R) return;
        const nx = e > 1e-4 ? ex / e : 0, nz = e > 1e-4 ? ez / e : 1, depth = R - e;
        this.ox += nx * depth; this.oz += nz * depth;
        const vn = this.ovx * nx + this.ovz * nz;
        if (vn < 0) { this.ovx -= vn * nx * 1.3; this.ovz -= vn * nz * 1.3; }
      });
    }

  }

  private blipOn(x: number, z: number, dt: number): void {
    const nav = this.game.hud.nav;
    this.blipT -= dt;
    if (!nav.blips.includes(this.blip)) { nav.blips.push(this.blip); this.blipT = 0; }
    if (this.blipT <= 0) { this.blipT = 0.25; this.blip.x = x; this.blip.z = z; nav.rev++; }
  }

  private blipOff(): void {
    const nav = this.game.hud.nav, i = nav.blips.indexOf(this.blip);
    if (i >= 0) { nav.blips.splice(i, 1); nav.rev++; }
  }
}
