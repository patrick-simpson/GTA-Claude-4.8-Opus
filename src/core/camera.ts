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
const MARGIN = 0.3, MIN_DIST = 0.7;
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
  private zoom = 0;
  private lookIdle = 0;

  // Chase camera.
  private chaseYaw = 0; private chaseVel = 0;
  private freeYaw = 0; private freePitch = 0;
  /** True while the free-look offset is one the player never asked for (the view she got in with). */
  private inherited = false;
  private slope = 0;
  private revT = 0; private fwdT = 0;

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
        // Left alone, drift in behind where she is headed. Not when she is running
        // at the lens: turning then would turn her controls with it, in a circle.
        const k = smooth((this.lookIdle - FOOT_HOLD) / 1.5) * Math.min(p.speed / 4.3, 1.3);
        const off = angleDiff(this.yaw, per.h);
        if (Math.abs(off) < 2.4) this.yaw = wrapAngle(this.yaw + off * (1 - Math.exp(-1.1 * k * dt)));
        this.pitch = damp(this.pitch, FOOT_PITCH, 0.5 * k, dt);
      }
    }

    // Sideways she is followed tightly; in height loosely, so a jump moves her and not the whole picture.
    L.px = this.to(L.px, per.x, 20, dt);
    L.pz = this.to(L.pz, per.z, 20, dt);
    L.py = this.to(L.py, p.swimming ? WATER_Y + 0.35 : per.y + SHOULDER * per.look.height, 8, dt);
    L.yaw = this.yaw; L.pitch = this.pitch;
    // Looking up from below, slide in along the ground rather than under it.
    const tuck = 1 - 0.42 * clamp01(-this.pitch / -PITCH_MIN);
    L.dist = this.to(L.dist, FOOT_DIST * ZOOM[this.zoom] * tuck, 7, dt);
    L.lift = 0.09; L.ax = 0; L.az = 0;
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
    if (this.revT > 1) target += Math.PI;
    else if (sp > 3 && v.speed > 0) {
      // In a slide the nose points one way and the car travels another. Sit
      // between the two, so a drift is seen from the side it is going.
      target += clamp(angleDiff(v.h, headingOf(v.vx, v.vz)), -0.7, 0.7) * 0.5 * smooth((sp - 3) / 8);
    }
    if (this.snapping) { this.chaseYaw = wrapAngle(target); this.chaseVel = 0; }
    else {
      // Critically damped spring, solved exactly so it behaves the same at any frame rate.
      // At 6/s it trails a steady turn by a third of a second, which shows the car's flank in corners.
      const W = 6, err = -angleDiff(this.chaseYaw, target);
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
    this.pitch = clamp(DRIVE_PITCH + this.slope + this.freePitch, -0.35, PITCH_MAX);

    if (this.snapping) {
      L.px = v.x - v.vx * CHASE_LAG; L.pz = v.z - v.vz * CHASE_LAG;
    } else {
      // Damped, not rigid: if the car's motion is a little uneven from frame to
      // frame, a rigid camera shakes the whole city, a damped one hides it.
      const lead = 1 / CHASE_RATE - CHASE_LAG;
      L.px = damp(L.px, v.x + v.vx * lead, CHASE_RATE, dt);
      L.pz = damp(L.pz, v.z + v.vz * lead, CHASE_RATE, dt);
    }
    L.py = this.to(L.py, v.y + v.spec.height * 0.55 + 0.3, 7, dt);
    L.yaw = this.yaw; L.pitch = this.pitch;
    // A bus needs far more room than a hatchback to show the road around it.
    L.dist = this.to(L.dist, (3.3 + v.spec.length * 0.92) * ZOOM[this.zoom], 5, dt);
    L.lift = 0.085;
    // Look up the road, farther the faster; behind the car when the view faces backward.
    const ahead = (1.6 + Math.min(sp, 45) * 0.07) * Math.cos(angleDiff(v.h, this.yaw));
    L.ax = Math.sin(v.h) * ahead; L.az = Math.cos(v.h) * ahead;
    L.fov = this.to(L.fov, 60 + 16 * Math.pow(clamp01((sp - 5) / 50), 0.85), 2.5, dt);
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
    for (let i = 0; i < 8; i++) {
      // 0, +45, -45, +90, -90 ... 180 degrees.
      const yaw = h + Math.ceil(i / 2) * (Math.PI / 4) * (i % 2 ? 1 : -1);
      const r = this.reach(p.x, py, p.z, yaw, FOOT_PITCH, want);
      if (r > want * 0.95) return wrapAngle(yaw);
      if (r > room) { room = r; best = yaw; }
    }
    return wrapAngle(best);
  }

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
    const pull = O.dist - limit;
    this.squeeze = pull >= this.squeeze || this.snapping ? pull : damp(this.squeeze, pull, 4, dt);
    const d = O.dist - this.squeeze;

    const cp = Math.cos(O.pitch);
    const cx = O.px - Math.sin(O.yaw) * cp * d, cz = O.pz - Math.cos(O.yaw) * cp * d;
    let cy = O.py + Math.sin(O.pitch) * d;
    // The ground (and the sea) lift it straight up, and let it settle back gently.
    const need = Math.max(0, Math.max(groundAt(cx, cz), WATER_Y) + FLOOR - cy);
    this.raise = need >= this.raise || this.snapping ? need : damp(this.raise, need, 5, dt);
    cy += this.raise;

    cam.position.set(cx, cy, cz);
    cam.lookAt(O.px + O.ax, O.py + O.lift * d, O.pz + O.az);

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
    // Backed into a corner the lens ends up inside her head; better to see through her than into her.
    else if (this.mode === 'foot' && d < 0.9) g.player.person.visible = false;
  }
}
