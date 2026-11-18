// The camera: third person on foot, a chase camera at the wheel, and a slow
// flight over the harbor while the title card is up.
//
// Every view is the same thing underneath: an orbit. A pivot (her shoulders,
// the car's roof, a point over the pier), a direction and distance to sit back
// from it, and a point to look at. Each mode fills in those numbers; a change
// of mode blends the numbers, never the finished position, which is why the
// camera swings around a car instead of cutting through it. Walls shorten the
// distance, the ground lifts the camera, and the shake goes on last so it can
// never push the lens through anything.

import * as THREE from 'three';
import type { Game } from './game';
import type { CameraApi, Vehicle } from './api';
import type { Prop } from '../world/collide';
import { angleDiff, clamp, clamp01, damp, headingOf, lerp, smooth, wrapAngle } from './util';
import { WATER_Y, groundAt } from '../world/plan';

const PITCH_MIN = -0.5, PITCH_MAX = 1.2;
const FOOT_DIST = 4.6, FOOT_PITCH = 0.2, SHOULDER = 1.5;
const DRIVE_PITCH = 0.23;
/** The camera action steps through these: normal, far, close. */
const ZOOM = [1, 1.5, 0.72];
/** Seconds of quiet before the on-foot camera starts to drift behind her, and before free look at the wheel lets go. */
const FOOT_HOLD = 2, DRIVE_HOLD = 1.5;
/** How tightly the pivot follows a car, 1/s. It trails by LAG seconds of travel, so speed stretches the view a little. */
const CHASE_RATE = 14, CHASE_LAG = 0.03;
/** Stay this far off a wall, and never closer than MIN_DIST to the pivot. */
const MARGIN = 0.3, MIN_DIST = 0.15;
/** On foot, a boom shorter than this goes up over her head instead of into the back of it. */
const TIGHT = 1.1;
/** A shop awning reaches about this far out from its wall (see `duck`). */
const AWNING = 1.25;
/** Half the width of the near plane, give or take: the side rays in reach() protect the picture's corners. */
const SIDE = 0.42;
/** Keep the lens this far above the ground and the sea. */
const FLOOR = 0.3;

// The title flight: a slow arc out over the water south of Pelican Pier, back
// and forth, so the wheel, the pier and the skyline behind them are always in
// the picture. A full circle would spend half its time looking at rooftops.
const TITLE = {
  x: 10, y: 24, z: 470,         // what it looks at: where the pier meets the shore
  radius: 330,
  mid: Math.PI * 0.5 + 0.32,    // the middle of the arc, a little west of due south
  swing: 0.62,                  // radians either side of it
  period: 150,                  // seconds for there and back
  low: 60, high: 90,
  fov: 44,                      // long lens: stacks the skyline up behind the wheel
};
/** The swoop from the title flight down to her shoulder, seconds. */
const SWOOP = 1.5, BLEND = 0.6;

interface Orbit {
  /** Pivot. */
  px: number; py: number; pz: number;
  yaw: number; pitch: number; dist: number;
  /** Look this far above the pivot, as a fraction of the distance: it sets how low in the frame the subject sits. */
  lift: number;
  /** Look this far past the pivot along the ground (the chase camera looks up the road). */
  ax: number; az: number;
  fov: number;
}
const orbit = (): Orbit => ({ px: 0, py: 0, pz: 0, yaw: 0, pitch: 0, dist: FOOT_DIST, lift: 0, ax: 0, az: 0, fov: 60 });
const ease = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

type Mode = 'title' | 'foot' | 'drive';

export class CameraRig implements CameraApi {
  yaw = 0;
  pitch = FOOT_PITCH;
  readonly focus = new THREE.Vector3();
  /** True while a wall has pushed the lens into the player's head. The player hides her while it is set. */
  tooClose = false;

  private mode: Mode = 'title';
  /** What the current mode wants, what the last mode left behind, and the blend of the two that is on screen. */
  private live = orbit();
  private from = orbit();
  private out = orbit();
  private titleOut = orbit();
  private blendT = 1;
  private blendDur = BLEND;
  /** The title swoop also blends direction and zooms on a log scale; ordinary blends keep the live direction. */
  private swoop = false;
  private snapping = false;

  /** How much a wall is currently pulling the camera in, and the ground pushing it up. */
  private squeeze = 0;
  private raise = 0;
  /** How far the camera is ducked for a wall close beside it. */
  private duck = 0;
  /** 1 while she is on the ground (knocked down, or dead): the camera looks at the road, from higher up. */
  private low = 0;
  private zoom = 0;
  private lookIdle = 0;

  // Chase camera.
  private chaseYaw = 0; private chaseVel = 0;
  private freeYaw = 0; private freePitch = 0;
  /** True while the free-look offset is one the player never asked for (the view she got in with). */
  private inherited = false;
  private slope = 0;
  private revT = 0; private fwdT = 0;
  /** The swing to and from the reversing view runs on a softer spring for this long. */
  private wasRev = false; private softT = 0;
  /** 1 while the car is off the ground. */
  private air = 0;

  private trauma = 0;
  private rumble = 0;
  private clock = 0;
  private titleT = 0;

  constructor(private game: Game) {
    game.on('impact', (e) => {
      const v = game.player.vehicle;
      if (v && (e.vehicle === v || e.other === v) && e.speed > 1.5) this.shake(clamp(e.speed / 24, 0.1, 1));
    });
    // game.start() snaps to the on-foot view and then announces the start. If the
    // title flight was really on screen, replace that cut with a swoop down from
    // it. (A test that skips the title in its first second gets the plain cut.)
    game.on('start', () => {
      if (this.titleT < 1) return;
      Object.assign(this.from, this.titleOut);
      this.blendT = 0; this.blendDur = SWOOP; this.swoop = true;
      this.squeeze = 0;
      this.place(0);
    });
    this.snap();
  }

  /** amount: 0 = nothing, 1 = the hardest hit there is. Adds up, and is gone in about half a second. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  snap(): void {
    const g = this.game;
    this.snapping = true;
    this.mode = this.wanted();
    this.blendT = 1; this.swoop = false;
    this.trauma = 0; this.rumble = 0; this.raise = 0; this.squeeze = 0;
    this.lookIdle = 0; this.inherited = false;
    this.wasRev = false; this.softT = 0;
    if (this.mode === 'title') {
      this.flyTitle(0);
    } else if (this.mode === 'drive') {
      const v = g.player.vehicle!;
      this.chaseYaw = v.h; this.chaseVel = 0;
      this.freeYaw = 0; this.freePitch = 0; this.slope = 0; this.revT = 0;
      this.chase(0, v);
    } else {
      this.pitch = FOOT_PITCH;
      this.yaw = this.openYaw(g.player.h);
      this.follow(0);
    }
    this.place(0);
    this.snapping = false;
  }

  update(dt: number): void {
    const mode = this.wanted();
    if (mode !== this.mode) this.change(mode);
    if (dt > 0) {
      this.clock += dt;
      if (mode === 'title') this.flyTitle(dt);
      else if (mode === 'drive') this.chase(dt, this.game.player.vehicle!);
      else this.follow(dt);
      if (this.blendT < 1) this.blendT = Math.min(1, this.blendT + dt / this.blendDur);
      this.trauma = Math.max(0, this.trauma - dt * 1.9);
    }
    this.place(dt);
  }

  private wanted(): Mode {
    const g = this.game;
    if (g.state === 'title' || g.state === 'loading') return 'title';
    return g.player.vehicle ? 'drive' : 'foot';
  }

  /** Start a blend from whatever is on screen now into the new mode. */
  private change(mode: Mode): void {
    Object.assign(this.from, this.out);
    this.blendT = 0; this.blendDur = BLEND; this.swoop = false;
    this.mode = mode;
    const L = this.live, p = this.game.player;
    if (mode === 'drive') {
      // Keep looking the way we were looking: the difference becomes a free-look
      // offset that eases away, so the view swings in behind the car on its own.
      const v = p.vehicle!;
      this.chaseYaw = v.h; this.chaseVel = 0;
      this.freeYaw = angleDiff(v.h, this.yaw);
      this.freePitch = this.pitch - DRIVE_PITCH;
      this.inherited = true;
      this.slope = 0; this.revT = 0;
      L.px = v.x; L.py = v.y + v.spec.height * 0.55 + 0.3; L.pz = v.z;
    } else if (mode === 'foot') {
      this.lookIdle = 0;
      this.pitch = clamp(this.pitch, PITCH_MIN, PITCH_MAX);
      L.px = p.person.x; L.py = p.person.y + SHOULDER; L.pz = p.person.z;
    } else {
      this.swoop = true;
    }
  }

  private to(a: number, b: number, rate: number, dt: number): number {
    return this.snapping ? b : damp(a, b, rate, dt);
  }

  // ── The three modes ────────────────────────────────────────────────────────

  private follow(dt: number): void {
    const g = this.game, inp = g.input, p = g.player, per = p.person, L = this.live;
    const lx = inp.lookX, ly = inp.lookY;
    if (inp.hit('camera')) this.zoom = (this.zoom + 1) % ZOOM.length;
    if (lx !== 0 || ly !== 0) {
      // Looking right turns the heading down; pulling the mouse toward you lifts the camera to look down.
      this.yaw = wrapAngle(this.yaw - lx);
      this.pitch = clamp(this.pitch + ly, PITCH_MIN, PITCH_MAX);
      this.lookIdle = 0;
    } else if (!this.snapping) {
      this.lookIdle += dt;
      if (this.lookIdle > FOOT_HOLD && p.speed > 1.2) {
        // Left alone, drift in behind where she is headed, but only while she is
        // headed more or less away from the lens. Her controls turn with the
        // camera, so following a sidestep (or a diagonal on the keys) would bend
        // a straight run into a circle. What is left is steering with a stick.
        const k = smooth((this.lookIdle - FOOT_HOLD) / 1.5) * Math.min(p.speed / 4.3, 1.3);
        const off = angleDiff(this.yaw, per.h);
        const turn = k * smooth((Math.cos(off) - 0.75) / 0.2);
        this.yaw = wrapAngle(this.yaw + off * (1 - Math.exp(-0.75 * turn * dt)));
        this.pitch = damp(this.pitch, FOOT_PITCH, 0.5 * k, dt);
      }
    }

    // Sideways she is followed tightly; in height loosely, so a jump moves her and not the whole picture.
    L.px = this.to(L.px, per.x, 20, dt);
    L.pz = this.to(L.pz, per.z, 20, dt);
    // Flat on the road she is a meter and a half lower than the place the camera
    // usually aims at: look at her, and from higher, so she is not cut off by the bottom edge.
    const down = per.pose === 'down';
    this.low = this.to(this.low, down ? 1 : 0, down ? 3 : 5, dt);
    if (down && !this.snapping && lx === 0 && ly === 0 && this.blocked(per.x, per.y + 0.45, per.z)) {
      // A tree or a lamp post between the lens and the body: walk around it.
      this.yaw = wrapAngle(this.yaw + 1.1 * dt);
    }
    const stand = lerp(SHOULDER * per.look.height, 0.45, this.low);
    L.py = this.to(L.py, p.swimming ? WATER_Y + 0.35 : per.y + stand, 8, dt);
    L.yaw = this.yaw; L.pitch = Math.min(this.pitch + 0.34 * this.low, PITCH_MAX);
    // Looking up from below, slide in along the ground rather than under it.
    const tuck = 1 - 0.42 * clamp01(-this.pitch / -PITCH_MIN);
    L.dist = this.to(L.dist, FOOT_DIST * ZOOM[this.zoom] * tuck, 7, dt);
    // On the ground she also goes in the lower part of the picture, under the stamp that says so.
    L.lift = 0.09 + 0.2 * this.low; L.ax = 0; L.az = 0;
    L.fov = this.to(L.fov, 60 + 3 * smooth((p.speed - 4.8) / 2), 4, dt);
    this.rumble = this.to(this.rumble, 0, 6, dt);
  }

  private chase(dt: number, v: Vehicle): void {
    const g = this.game, inp = g.input, L = this.live;
    const sp = Math.hypot(v.vx, v.vz);
    if (inp.hit('camera')) this.zoom = (this.zoom + 1) % ZOOM.length;

    // A second of backing up swings the view around; it swings home once the car
    // rolls forward again, or has sat still long enough that the reverse is over.
    if (!this.snapping) {
      if (v.speed < -1.5) { this.revT += dt; this.fwdT = 0; }
      else { this.fwdT += dt; if (v.speed > 1 || this.fwdT > 0.7) this.revT = 0; }
    }
    let target = v.h;
    const rev = this.revT > 1;
    if (rev !== this.wasRev && !this.snapping) { this.wasRev = rev; this.softT = 1.7; }
    this.softT = Math.max(0, this.softT - dt);
    if (rev) target += Math.PI;
    else if (sp > 3 && v.speed > 0) {
      // In a slide the nose points one way and the car travels another. Sit
      // between the two, so a drift is seen from the side it is going.
      target += clamp(angleDiff(v.h, headingOf(v.vx, v.vz)), -0.7, 0.7) * 0.5 * smooth((sp - 3) / 8);
    }
    if (this.snapping) { this.chaseYaw = wrapAngle(target); this.chaseVel = 0; }
    else {
      // Critically damped spring, solved exactly so it behaves the same at any frame rate.
      // At 6/s it trails a steady turn by a third of a second, which shows the car's flank in corners.
      // Half a turn at that stiffness is a whip (the lens covers 50 m in a second),
      // so the swing round for reversing, and the one home, get a softer spring.
      const W = lerp(6, 3.4, smooth(this.softT / 0.5)), err = -angleDiff(this.chaseYaw, target);
      const tmp = (this.chaseVel + W * err) * dt, ex = Math.exp(-W * dt);
      this.chaseVel = (this.chaseVel - W * tmp) * ex;
      this.chaseYaw = wrapAngle(target + (err + tmp) * ex);
    }

    const lx = inp.lookX, ly = inp.lookY;
    if (lx !== 0 || ly !== 0) {
      this.freeYaw = wrapAngle(this.freeYaw - lx);
      this.freePitch = clamp(this.freePitch + ly, PITCH_MIN - DRIVE_PITCH, PITCH_MAX - DRIVE_PITCH);
      this.lookIdle = 0;
      this.inherited = false;
    } else if (!this.snapping) {
      this.lookIdle += dt;
      // Parked, a look around stays where it was put; only driving pulls it back.
      if (this.inherited || (this.lookIdle > DRIVE_HOLD && sp > 1)) {
        const k = this.inherited ? 1 : smooth((this.lookIdle - DRIVE_HOLD) / 0.5);
        this.freeYaw = damp(this.freeYaw, 0, 3 * k, dt);
        this.freePitch = damp(this.freePitch, 0, 3 * k, dt);
        if (Math.abs(this.freeYaw) < 0.003 && Math.abs(this.freePitch) < 0.003) {
          this.freeYaw = 0; this.freePitch = 0; this.inherited = false;
        }
      }
    }
    // Look-behind is a cut, not a swing: it is for a glance.
    this.yaw = wrapAngle(this.chaseYaw + this.freeYaw + (inp.down('lookBack') ? Math.PI : 0));

    // Follow the hill: climbing, drop down behind the car; cresting, rise to see over.
    // Measured from the ground rather than the car's own pitch, which bounces.
    let tilt: number;
    if (v.onGround) {
      const s = Math.sin(v.h), c = Math.cos(v.h), r = v.hl + 1.5;
      tilt = -Math.atan2(groundAt(v.x + s * r, v.z + c * r) - groundAt(v.x - s * r, v.z - c * r), 2 * r) * 0.7;
    } else {
      tilt = -Math.atan2(v.vy, Math.max(sp, 6)) * 0.35;
    }
    this.slope = this.to(this.slope, clamp(tilt, -0.3, 0.3), 2.5, dt);
    // A jump only reads as one if the car leaves the middle of the picture. In
    // the air the camera stops matching its height, backs off and opens up, so
    // the car climbs up the frame with the ground still in view, and comes back
    // down into it. The first tenth of a second is a curb, not a jump.
    const flying = !v.onGround && v.airTime > 0.1;
    this.air = this.to(this.air, flying ? 1 : 0, flying ? 8 : 3.5, dt);
    // And it gets down low. From above, a car in the air is a car on the road
    // with a small shadow; from its own height it is a car against the sky with
    // the ground a long way under it. Once it is coming down, the tilt above
    // takes over and looks at where it will land.
    const high = v.y - Math.max(groundAt(v.x, v.z), WATER_Y) - 1;
    const under = this.air * clamp(high * 0.07, 0, 0.3) * clamp01(0.6 + v.vy / 8);
    this.pitch = clamp(DRIVE_PITCH + this.slope + this.freePitch - under, -0.35, PITCH_MAX);

    if (this.snapping) {
      L.px = v.x - v.vx * CHASE_LAG; L.pz = v.z - v.vz * CHASE_LAG;
    } else {
      // Damped, not rigid: if the car's motion is a little uneven from frame to
      // frame, a rigid camera shakes the whole city, a damped one hides it.
      const lead = 1 / CHASE_RATE - CHASE_LAG;
      L.px = damp(L.px, v.x + v.vx * lead, CHASE_RATE, dt);
      L.pz = damp(L.pz, v.z + v.vz * lead, CHASE_RATE, dt);
    }
    const top = v.y + v.spec.height * 0.55 + 0.3;
    L.py = this.to(L.py, top, lerp(7, 1.3, this.air), dt);
    // However high the jump or long the fall, the car stays in the picture.
    L.py = clamp(L.py, top - 3.2, top + 1.7);
    L.yaw = this.yaw; L.pitch = this.pitch;
    // A bus needs far more room than a hatchback to show the road around it.
    L.dist = this.to(L.dist, (3.3 + v.spec.length * 0.92) * ZOOM[this.zoom] * (1 + 0.25 * this.air), 5, dt);
    L.lift = 0.085;
    // Look up the road, farther the faster; behind the car when the view faces backward.
    const ahead = (1.6 + Math.min(sp, 45) * 0.07) * Math.cos(angleDiff(v.h, this.yaw));
    L.ax = Math.sin(v.h) * ahead; L.az = Math.cos(v.h) * ahead;
    L.fov = this.to(L.fov, 60 + 16 * Math.pow(clamp01((sp - 5) / 50), 0.85) + 4 * this.air, 2.5, dt);
    const flatOut = smooth((sp / v.spec.topSpeed - 0.8) / 0.2);
    this.rumble = this.to(this.rumble, v.onGround ? flatOut : flatOut * 0.3, 4, dt);
  }

  private flyTitle(dt: number): void {
    const L = this.live, T = TITLE;
    this.titleT += dt;
    const t = this.titleT * (Math.PI * 2 / T.period);
    const a = T.mid + T.swing * Math.sin(t - 1.1);
    const x = T.x + Math.cos(a) * T.radius, z = T.z + Math.sin(a) * T.radius;
    const y = lerp(T.low, T.high, 0.5 + 0.5 * Math.sin(t * 1.7 + 0.6));
    L.px = T.x; L.py = T.y; L.pz = T.z;
    L.yaw = headingOf(T.x - x, T.z - z);
    L.pitch = Math.atan2(y - T.y, T.radius);
    L.dist = Math.hypot(T.radius, y - T.y);
    L.lift = 0; L.ax = 0; L.az = 0;
    L.fov = T.fov;
    this.rumble = 0;
  }

  // ── Putting the camera somewhere ───────────────────────────────────────────

  /** How far back along (yaw, pitch) the camera can sit from a pivot before a building is in the way. */
  private reach(px: number, py: number, pz: number, yaw: number, pitch: number, want: number): number {
    const col = this.game.col;
    const sy = Math.sin(yaw), cy = Math.cos(yaw), cp = Math.cos(pitch), up = Math.sin(pitch);
    const dx = -sy * cp, dz = -cy * cp;
    let d = col.raycast(px, py, pz, dx, up, dz, want + MARGIN);
    // One ray down the middle is not enough: the picture has width, and a wall
    // that misses the center can still slice through a corner of it.
    for (let side = -1; side <= 1; side += 2) {
      const ex = dx * want - cy * SIDE * side, ey = up * want, ez = dz * want + sy * SIDE * side;
      const len = Math.hypot(ex, ey, ez);
      const t = col.raycast(px, py, pz, ex / len, ey / len, ez / len, len + MARGIN);
      if (t < d) d = t;
    }
    return Math.max(Math.min(MIN_DIST, want), Math.min(want, d - MARGIN));
  }

  /** The direction nearest to "behind heading h" from which she can be seen at full distance. */
  private openYaw(h: number): number {
    const p = this.game.player.person;
    const py = p.y + SHOULDER * p.look.height, want = FOOT_DIST * ZOOM[this.zoom];
    let best = h, room = 0;
    for (let i = 0; i < 16; i++) {
      // 0, -22, +22, -45, +45 ... 180 degrees.
      const yaw = h + Math.ceil(i / 2) * (Math.PI / 8) * (i % 2 ? -1 : 1);
      const r = this.reach(p.x, py, p.z, yaw, FOOT_PITCH, want);
      // Straight behind her is worth a shorter boom: it is the view the level
      // was laid out for, and the camera eases back out as soon as she moves.
      if (r > want * (i ? 0.95 : 0.38)) return wrapAngle(yaw);
      if (r > room) { room = r; best = yaw; }
    }
    return wrapAngle(best);
  }

  /** Is a tree, a lamp post or the like standing between the lens and a point? Thin props do not stop the boom, so this is only asked when it matters. */
  private blocked(x: number, y: number, z: number): boolean {
    const c = this.game.camera.position;
    this.bx0 = c.x; this.bz0 = c.z; this.bx1 = x; this.bz1 = z;
    this.by0 = c.y; this.by1 = y;
    this.bHit = false;
    const half = Math.hypot(x - c.x, z - c.z) * 0.5;
    this.game.col.forProps((x + c.x) * 0.5, (z + c.z) * 0.5, half + 1, this.propTest);
    return this.bHit;
  }
  private bx0 = 0; private by0 = 0; private bz0 = 0; private bx1 = 0; private by1 = 0; private bz1 = 0; private bHit = false;
  // A field, so forProps gets the same function every time instead of a fresh closure.
  private propTest = (o: Prop): void => {
    if (!o.alive || o.h < 1) return;
    const dx = this.bx1 - this.bx0, dz = this.bz1 - this.bz0;
    const t = ((o.x - this.bx0) * dx + (o.z - this.bz0) * dz) / (dx * dx + dz * dz || 1);
    // Not the last stretch: a post right beside her is not in front of her.
    if (t < 0.05 || t > 0.85 || lerp(this.by0, this.by1, t) > o.h) return;
    const ex = this.bx0 + dx * t - o.x, ez = this.bz0 + dz * t - o.z, w = o.r + 0.3;
    if (ex * ex + ez * ez < w * w) this.bHit = true;
  };

  private place(dt: number): void {
    const g = this.game, cam = g.camera, O = this.out, L = this.live, F = this.from;
    const e = this.blendT >= 1 ? 1 : ease(this.blendT);
    if (e >= 1) Object.assign(O, L);
    else {
      O.px = lerp(F.px, L.px, e); O.py = lerp(F.py, L.py, e); O.pz = lerp(F.pz, L.pz, e);
      O.lift = lerp(F.lift, L.lift, e); O.ax = lerp(F.ax, L.ax, e); O.az = lerp(F.az, L.az, e);
      O.fov = lerp(F.fov, L.fov, e);
      if (this.swoop) {
        O.yaw = F.yaw + angleDiff(F.yaw, L.yaw) * e;
        O.pitch = lerp(F.pitch, L.pitch, e);
        // Distance is blended below, on a log scale: 300 m to 5 m at a steady
        // rate would spend the whole move far away and arrive in a blink.
        O.dist = L.dist;
      } else {
        O.yaw = L.yaw; O.pitch = L.pitch;
        O.dist = lerp(F.dist, L.dist, e);
      }
    }

    // Walls pull the camera in at once and let it back out slowly. The far-off
    // title views are left alone: over the rooftops there is nothing to hide behind.
    let limit = O.dist;
    if (this.swoop && e < 1) {
      // On the way down from the title flight only the landing spot is tested, and
      // the move aims at the tested distance, so nothing jumps as it arrives. The
      // hump keeps the flight above the boardwalk roofs until the last moment.
      const land = this.mode === 'title' ? L.dist : this.reach(L.px, L.py, L.pz, L.yaw, L.pitch, L.dist);
      O.dist = limit = Math.exp(lerp(Math.log(F.dist), Math.log(land), e));
      O.py += Math.sin(Math.PI * e) * 14;
    } else if (this.mode !== 'title') {
      limit = this.reach(O.px, O.py, O.pz, O.yaw, O.pitch, O.dist);
    }
    const foot = this.mode === 'foot' && e >= 1;
    const pull = O.dist - limit;
    let soft = pull;
    if (foot && !this.snapping) {
      // Feelers either side of the boom: a wall the view is about to swing into
      // starts drawing the camera in before it gets there, so turning past a
      // corner is a slide inward and not a jump of a meter and a half.
      for (let i = 0; i < 4; i++) {
        const a = (i < 2 ? 0.17 : 0.34) * (i % 2 ? 1 : -1);
        const r = this.reach(O.px, O.py, O.pz, O.yaw + a, O.pitch, O.dist);
        soft = Math.max(soft, (O.dist - r) * (i < 2 ? 0.7 : 0.38));
      }
    }
    // The wall itself pulls the camera in at once; the feelers quickly; and it is let back out slowly.
    if (pull >= this.squeeze || this.snapping) this.squeeze = pull;
    else this.squeeze = Math.max(pull, damp(this.squeeze, soft, soft > this.squeeze ? 14 : 4, dt));
    const d = O.dist - this.squeeze;

    const cp = Math.cos(O.pitch);
    const cx = O.px - Math.sin(O.yaw) * cp * d, cz = O.pz - Math.cos(O.yaw) * cp * d;
    let cy = O.py + Math.sin(O.pitch) * d;
    // Close in front of a shopfront the lens is under its awning, and the top of
    // the picture is the underside of one. Awnings are not in the collision
    // world, so: with a wall that close on any side, the camera keeps to head height.
    let duck = 0;
    if (foot && cy > O.py + 0.3) {
      for (let i = 0; i < 8 && !duck; i++) {
        const a = i * (Math.PI / 4);
        if (g.col.pointBlocked(cx + Math.sin(a) * AWNING, cz + Math.cos(a) * AWNING, cy)) duck = 1;
      }
    }
    this.duck = this.snapping ? duck : damp(this.duck, duck, 6, dt);
    const head = O.py + 0.3;
    if (cy > head) cy = lerp(cy, head, this.duck);
    // No room behind her at all: go up and look over her cap, rather than sit
    // inside her head (or, as it used to, inside the wall). A car gets the same
    // treatment in proportion, and is looked at over its roof.
    const tight = foot ? 1 - smooth((d - 0.3) / (TIGHT - 0.3)) : 0;
    const hop = foot ? tight * 0.62 : this.mode === 'drive' ? clamp01(this.squeeze / Math.max(O.dist, 1)) * 1.3 : 0;
    if (hop > 0 && !g.col.pointBlocked(cx, cz, cy + hop)) cy += hop;
    // The ground (and the sea) lift it straight up, and let it settle back gently.
    const need = Math.max(0, Math.max(groundAt(cx, cz), WATER_Y) + FLOOR - cy);
    this.raise = need >= this.raise || this.snapping ? need : damp(this.raise, need, 5, dt);
    cy += this.raise;

    cam.position.set(cx, cy, cz);
    // Over her head there is nothing to look at but the way she is facing.
    const fwd = tight * 2.6;
    cam.lookAt(O.px + O.ax + Math.sin(O.yaw) * fwd, O.py + O.lift * d + tight * 0.12, O.pz + O.az + Math.cos(O.yaw) * fwd);

    const hit = this.trauma * this.trauma, hum = this.rumble;
    if (hit > 0.0004 || hum > 0.002) {
      // Sums of sines instead of random numbers: smooth, and the same at any frame rate.
      const t = this.clock;
      const a = 0.5 * (Math.sin(t * 43.1) + Math.sin(t * 27.7 + 1.3));
      const b = 0.5 * (Math.sin(t * 38.3 + 2.1) + Math.sin(t * 22.9 + 0.7));
      const c = 0.5 * (Math.sin(t * 33.7 + 4.2) + Math.sin(t * 51.3 + 2.9));
      cam.rotateX((hit * 0.035 + hum * 0.0028) * a);
      cam.rotateY((hit * 0.03 + hum * 0.0016) * b);
      cam.rotateZ((hit * 0.045 + hum * 0.002) * c);
      cam.position.y += (hit * 0.1 + hum * 0.008) * Math.abs(b);
    }

    if (Math.abs(cam.fov - O.fov) > 0.02) { cam.fov = O.fov; cam.updateProjectionMatrix(); }
    this.focus.set(O.px, O.py, O.pz);
    if (this.mode === 'title') Object.assign(this.titleOut, O);
    // Only if even the view over her cap had no room (a ceiling) is the lens in her head; better to see through her than into her.
    // Only a flag: this runs after the people are drawn, so the player applies it at the start of the next frame.
    this.tooClose = this.mode === 'foot' && d < 0.9 && cy < O.py + 0.3;
  }
}
