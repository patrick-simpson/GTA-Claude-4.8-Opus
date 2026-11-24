// Dess: on foot, in the water, at the wheel, and the moments in between.
//
// On foot she is a circle with a height. Each frame the input becomes a wanted
// velocity relative to the camera, the circle is moved and pushed out of walls
// and cars, and the ground under the new spot decides what happens next: a
// small rise is stepped up, a tall one is a wall, a small drop is stepped down,
// a big one is a fall, and deep water is a swim. Everything else in this file
// (doors, bail-outs, the hospital) is a short scripted move on top of that.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person, PlayerApi, Vehicle } from '../core/api';
import { myLook, onMyLook, toStyled } from '../game/looks';
import type { Box } from '../world/collide';
import { clamp, clamp01, damp, dampAngle, headingOf, lerp, money, smooth } from '../core/util';
import { groundAt, setGroundHint } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import { nearestShore } from '../world/shore';
import { Weapons } from './weapons';
import { kid } from '../core/kid';
import { Boats, type Boat } from './boat';

const RADIUS = 0.35;
const WALK = 1.8, JOG = 4.3, SPRINT = 7;
const SWIM = 1.7, SWIM_FAST = 2.6;
// Over twice real gravity. A 1.1 m hop at 9.8 hangs for a full second and
// reads as the moon; at 22 it is over in 0.63 s and reads as a jump.
const GRAVITY = 22;
// Aimed a little high: stepped at 60 Hz the arc tops out about 6 cm short of the formula.
const JUMP_V = Math.sqrt(2 * GRAVITY * 1.16);
/** Tallest rise in the ground she walks straight up: curbs, ramp lips, deck edges. */
const STEP_UP = 0.5;
/** Collision boxes lower than this are stairs, not walls (see advance()). */
const STEP_BOX = 0.3;
/** Ground farther than this below her feet is a fall, not a step down. */
const DROP = 0.4;
/** How far under the surface her feet hang while she swims: head and shoulders stay out. */
const FLOAT = 1.3;
/** Where she floats at (x, z): the mill pond on the mainland sits above sea level, so the water line is not one number. */
const swimY = (x: number, z: number): number => waterLevelAt(x, z) - FLOAT;
/** Gap between her and a car body at which the door is within reach. */
const REACH = 3.2;
/** Seconds she stays at the wheel of a car that has gone into the water, so the splash is seen from the chase camera. */
const SINK_HOLD = 0.3;
/** Leaving a car faster than this is a bail-out, not an exit. */
const BAIL_SPEED = 6;
/** Landing speed (m/s) where it starts to hurt: a drop of about 3.8 m, just more than the tallest ramp. */
const HARD_LANDING = 13;
/** The start point, and where Mercy General sends her home to: block (5, 6), south sidewalk. */
const HOME = [5, 6, 2, 0.45] as const;
/** With a weapon up she walks: slower than a jog, so the sights stay somewhere near the target. */
const AIM_PACE = 2.6;
const START_MONEY = 250;

// Drowning (owner, Nov 24). Swimming keeps her up, so nothing below changes how a swim feels: only stopping, or swimming
// until she is spent, ever takes her under.
/** Seconds of treading water with no input before she starts to go down. */
const TREAD = 4;
/** How far she sinks at most (m below her floating depth), and how fast (m/s) when she gives up / when she kicks back up. */
const SINK_MAX = 1.7, SINK_RATE = 0.45, RISE_RATE = 1.5;
/** Her head is under once she has sunk this far. */
const HEAD_UNDER = 0.45;
/** Seconds of air a full breath lasts underwater, and how quickly it comes back at the surface. */
const BREATH_SECS = 12, BREATH_BACK = 2.2;
/** Stamina: seconds of steady swimming / of sprint swimming from fresh to spent, and seconds of treading to recover fully. */
const STAMINA_SWIM = 110, STAMINA_SPRINT = 45, STAMINA_REST = 45;
/** Below this stamina she is tired: slower strokes, and a stopped swimmer sinks faster. */
const TIRED = 0.25;
/** Seconds of air left to a car's occupant when it has gone under. */
const CAR_BREATH = 8;
/** The drowned sequence: seconds of limp float and fade, when she is put ashore, when control returns, when the veil is gone. */
const WASH_FADE = 1.7, WASH_PUT = 2.7, WASH_FREE = 3.3;
/** Kid-friendly mode: seconds of treading in deep water before the lifeguard's whistle. */
const KID_TREAD = 5;
/** A drowned swimmer's bill for being fished out, as a share of her cash (the hospital's is 10%). */
const FISH_FEE = 0.05;


const NAGS = [
  'The Harbor Authority has not approved swimming to the mainland.',
  'Mainland swims require Form 12-B, a witness and a lifeguard. You have none of these.',
  'The mainland is farther than it looks. It is also not hiring.',
  'The tide has filed an objection. Turning back.',
];
const LAST_WORDS = [
  'Shift ended early.',
  'Please hold for Mercy General.',
  'The harbor wins this round.',
  'Paperwork to follow.',
];

type Mode = 'foot' | 'enter' | 'drive' | 'ride' | 'leave' | 'hoist' | 'tumble' | 'dead' | 'wash';

export class Player implements PlayerApi {
  readonly person: Person;
  health = 100;
  armor = 0;
  money = START_MONEY;
  heat = 0;
  /** What she is carrying and everything it does. Registered in game.systems, so it runs after people and vehicles each frame. */
  readonly weapons: Weapons;
  /** game.time of the last thing that hurt her, how much, and the heading it came from (NaN if from nowhere in particular). The HUD's edge flash reads these. */
  hurtT = -9; hurtAmount = 0; hurtFrom = NaN;
  /** Every car she has sat in, so a reset knows which ones she left lying about. */
  private used = new WeakSet<Vehicle>();
  swimming = false;
  nearVehicle: Vehicle | null = null;
  /** Multiplayer (net/ride.ts): another player's car she is close enough to ride in. While set, F rides instead of taking a car. */
  rideNear: Vehicle | null = null;

  private mode: Mode = 'foot';
  /** The vehicle she is seated in. */
  private car: Vehicle | null = null;
  /** Another player's car she sits in as a passenger (net/ride.ts places her in the seat every frame). */
  private rideCar: Vehicle | null = null;
  /** The vehicle she is walking to the door of. */
  private goal: Vehicle | null = null;
  private side: -1 | 1 = -1;
  /** How far it was to the door when she set off for it. */
  private run = 0;
  private sinkT = 0;

  private vx = 0; private vy = 0; private vz = 0;
  private grounded = true;
  private airT = 0;
  /** Jump presses are remembered for a moment, and so is the ground after she leaves it. */
  private jumpBuf = 0; private coyote = 0;
  private wet = false;

  // Scripted moves (door, step out, climb out of the water): a timer and two end points.
  private t = 0; private dur = 1;
  private fx = 0; private fy = 0; private fz = 0;
  private tx = 0; private ty = 0; private tz = 0;

  /** Set by advance(): the car she touched, and the ledge that stopped her. */
  private bumped: Vehicle | null = null;
  private ledge = false; private ledgeX = 0; private ledgeY = 0; private ledgeZ = 0;
  private pushT = 0;
  private restT = 0;
  /** Seconds during which cars cannot knock her down (just left one, just got up). */
  private safeT = 0;
  /** Out-of-bounds: seconds left of being steered home, toast cool-down, which line is next. */
  private turnT = 0; private nagT = 0; private nag = 0;
  private deaths = 0;
  /** Drowning (see the constants above): lungs and strength 0..1, seconds of treading, how far under she has sunk, the bubble clock. */
  breath = 1; stamina = 1;
  private tread = 0; private sink = 0; private bubT = 0; private wasUnder = false;
  /** The drowned sequence: its clock and kind, and the black veil over the screen (0 clear, 1 black). */
  private washT = 0; private washKind: 'drown' | 'rescue' = 'drown'; private washed = false;
  veil = 0;
  /** This frame's swim input (set in onFoot), which is what keeps her up. */
  private inM = 0; private inSprint = false;

  // Scratch values, so nothing is allocated per frame.
  private p = { x: 0, z: 0 };
  private door = { x: 0, z: 0 };
  private qx = 0; private qy = 0; private qz = 0; private qTop = 0;

  /** The runabout and the jet ski at the Pelican Pier dock (ent/boat.ts). Moved here, at the top of update(), so she is drawn on the boat where it is this frame. */
  readonly boats: Boats;

  constructor(private game: Game) {
    // The player's own look (game/looks.ts): the same descriptor every other screen draws them with.
    this.person = game.people.spawn(0, 0, 0, toStyled(myLook()));
    onMyLook((l) => { this.person.look = toStyled(l); });
    this.weapons = new Weapons(game);
    this.boats = new Boats(game);
    this.person.health = this.health;
  }

  get vehicle(): Vehicle | null { return this.car; }
  /** The car she rides in as a passenger, or null (net/ride.ts). */
  get riding(): Vehicle | null { return this.rideCar; }
  /** The car she is sitting in, at the wheel or not: what the chase camera, the radio and a drive-by go by. */
  get seated(): Vehicle | null { return this.car ?? this.rideCar; }
  get x(): number { return this.car ? this.car.x : this.person.x; }
  get y(): number { return this.car ? this.car.y : this.person.y; }
  get z(): number { return this.car ? this.car.z : this.person.z; }
  get h(): number { return this.car ? this.car.h : this.person.h; }
  get speed(): number {
    if (this.rideCar) return Math.hypot(this.rideCar.vx, this.rideCar.vz);
    return this.car ? Math.hypot(this.car.vx, this.car.vz) : Math.hypot(this.vx, this.vz);
  }

  /** Holding a weapon up and looking down it: the camera comes in over her shoulder and she turns with it. */
  get aiming(): boolean { return this.weapons.aiming; }
  /** On her feet, on dry land, in control: able to throw a punch or fire. */
  get canFight(): boolean { return this.mode === 'foot' && !this.swimming && this.health > 0; }

  // ── Public controls ────────────────────────────────────────────────────────

  /**
   * Somebody hurt her: a bullet, a blast, a baton. Armor first, then health; the
   * screen edge flashes and the camera takes a knock. `from` is where it came
   * from, if anywhere. Nothing grows back: health returns at Mercy General.
   */
  hurt(amount: number, from?: { x: number; z: number } | null): void {
    if (amount <= 0 || this.mode === 'dead' || this.mode === 'wash' || kid.on) return;
    this.damage(amount);
    this.hurtT = this.game.time; this.hurtAmount = amount;
    this.hurtFrom = from ? headingOf(from.x - this.x, from.z - this.z) : NaN;
    this.game.cam.shake(clamp(amount / 60, 0.12, 0.6));
  }

  /**
   * Start over: back to the start point on foot, as on the first morning. Full
   * health, starting money, no heat, no weapons, 8 AM and fair weather. Wrecks,
   * and cars she has bent or left within a block of the start, are towed.
   */
  reset(): void {
    const g = this.game, home = g.plan.sidewalkPoint(...HOME);
    if (this.car) this.release(this.car);
    if (this.rideCar) this.release(this.rideCar);
    this.goal = null;
    this.put(home.x, home.z + 0.9, 0);
    this.health = 100; this.armor = 0; this.money = START_MONEY; this.heat = 0;
    this.hurtT = -9; this.safeT = 1;
    this.weapons.clear();
    g.sky.hour = 8;
    g.sky.setWeather('clear', true);
    const list = g.vehicles.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i];
      if (v.driver === 'ai') continue;
      const near = Math.abs(v.x - home.x) < 90 && Math.abs(v.z - home.z) < 90;
      if (v.wreck || (near && (v.health < 100 || this.used.has(v)))) g.vehicles.remove(v);
    }
    g.cam.snap();
    g.hud.toast('Start over granted. The paperwork says none of that happened.', 5);
  }

  teleport(x: number, z: number, h?: number): void {
    this.game.people.rag?.drop(this.person);
    if (this.car) this.release(this.car);
    if (this.rideCar) this.release(this.rideCar);
    this.goal = null;
    this.put(x, z, h ?? this.person.h);
  }

  enter(v: Vehicle, instant = false): void {
    if (this.car === v) return;
    // A boat is boarded where she stands (from the dock, the pier or the water): no walk round to a door.
    if (this.boats.has(v)) { if (instant || this.mode === 'foot') { if (this.car) this.release(this.car); this.seat(v); } return; }
    if (this.car) this.release(this.car);
    if (this.rideCar) this.release(this.rideCar);
    if (instant) { this.seat(v); return; }
    if (this.mode !== 'foot' || this.swimming) return;
    const per = this.person, d = this.door;
    // The nearer door, not always the driver's: running round the hood to
    // reach the far side looks worse than sliding across the seats would.
    // Unless the nearer one is against a wall, and then it is the other.
    const p = this.p;
    v.doorPos(-1, d);
    const left = Math.hypot(d.x - per.x, d.z - per.z);
    p.x = d.x; p.z = d.z;
    const leftOk = this.clear(p, v);
    v.doorPos(1, d);
    const right = Math.hypot(d.x - per.x, d.z - per.z);
    p.x = d.x; p.z = d.z;
    const rightOk = this.clear(p, v);
    this.side = leftOk !== rightOk ? (leftOk ? -1 : 1) : left <= right + 0.4 ? -1 : 1;
    this.run = this.side < 0 ? left : right;
    this.goal = v;
    this.mode = 'enter';
    this.t = 0;
    this.dur = clamp(this.run / 5, 0.3, 0.9);
    this.nearVehicle = null;
  }

  /**
   * Sit in another player's car as a passenger (net/ride.ts): she is drawn in the seat, the chase camera follows the car,
   * and F gets her out. The car is never hers: nothing here moves it.
   */
  ride(v: Vehicle): void {
    if (this.car) this.release(this.car);
    const per = this.person;
    this.rideCar = v;
    this.goal = null;
    this.mode = 'ride';
    per.pose = 'sit'; per.bench = true; per.speed = 0; per.visible = true;
    this.vx = this.vy = this.vz = 0;
    this.swimming = false; this.wet = false; this.grounded = true;
    this.nearVehicle = null; this.rideNear = null;
  }

  /** safe: out beside the car at walking pace, whatever its speed (the driver went away; nobody is thrown by that). */
  exit(safe = false): void {
    if (this.mode === 'enter') { this.mode = 'foot'; this.goal = null; return; }
    const v = this.car ?? this.rideCar;
    if (!v) return;
    if (this.boats.has(v) && v === this.car) { this.leaveBoat(v); return; }
    const per = this.person, p = this.p;
    const sp = safe ? 0 : Math.hypot(v.vx, v.vz);
    this.pickExit(v);
    const outX = p.x, outZ = p.z;
    this.release(v);
    per.x = outX; per.z = outZ; per.h = v.h;
    this.safeT = 1;

    const g = this.support(outX, outZ, v.y + STEP_UP);
    if (v.sunk || g < swimY(per.x, per.z)) {
      // The car is on its way to the bottom; she surfaces beside it.
      per.y = swimY(per.x, per.z); this.swimming = true; this.grounded = false; this.wet = true;
      this.mode = 'foot';
      this.game.emit('splash', { x: outX, z: outZ, big: false });
      return;
    }
    if (sp > BAIL_SPEED) {
      // Out of a moving car: she keeps its speed, minus whatever the road takes.
      let ox = outX - v.x, oz = outZ - v.z;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol; oz /= ol;
      per.y = Math.max(v.y, g);
      this.damage(4 + (sp - BAIL_SPEED) * 1.5);
      this.knockDown(v.vx * 0.92 + ox * 1.6, v.vz * 0.92 + oz * 1.6, v.onGround ? 2.2 : v.vy);
      this.game.cam.shake(clamp(sp / 40, 0.15, 0.6));
      return;
    }
    if (g < v.y - DROP) {
      // Parked on the edge of something: no step out, just the drop.
      per.y = v.y; this.grounded = false; this.vy = 0; this.mode = 'foot';
      return;
    }
    // A short step away from the door instead of appearing a meter out.
    per.y = g; this.grounded = true;
    this.mode = 'leave';
    this.t = 0; this.dur = 0.22;
    this.tx = outX; this.ty = g; this.tz = outZ;
    this.fx = lerp(outX, v.x, 0.3); this.fy = g; this.fz = lerp(outZ, v.z, 0.3);
    per.x = this.fx; per.z = this.fz;
  }

  /** Take damage: armor first, then health. Death is noticed on the next update. */
  damage(amount: number): void {
    // Kid-friendly mode (core/kid.ts): knocked over, dusted off, never hurt.
    if (amount <= 0 || this.mode === 'dead' || kid.on) return;
    const a = Math.min(this.armor, amount);
    this.armor -= a;
    this.health = Math.max(0, this.health - (amount - a));
    // Anything that hurts flashes the screen edge, whoever dealt it; hurt() adds where it came from and the knock.
    this.hurtT = this.game.time; this.hurtAmount = amount; this.hurtFrom = NaN;
  }

  /** Throw her to the ground with a velocity. She slides to a stop and gets up on her own. */
  knockDown(vx: number, vz: number, vy = 2.2, car: { vx: number; vz: number } | null = null): void {
    if (this.car || this.rideCar || this.mode === 'dead') return;
    this.vx = vx; this.vz = vz;
    if (vy > 0 || !this.grounded) { this.vy = vy; this.grounded = false; }
    this.mode = 'tumble';
    this.goal = null;
    this.restT = 0;
    this.nearVehicle = null;
    // Anything bigger than a shove is a ragdoll (ent/ragdoll.ts): run down, thrown out of a car, blown over.
    // It moves her until it lands; tumbling() just waits for it.
    if (this.swimming || (Math.hypot(vx, vz) < 3 && vy < 2.5 && !car)) return;
    const rag = this.game.people.rag;
    const done = (): void => { this.vx = this.vz = this.vy = 0; this.grounded = true; this.restT = 0; };
    if (car) rag.hitByCar(this.person, car.vx, car.vz, { always: true, silly: false, onDone: done });
    else rag.throwOut(this.person, vx, vy, vz, { always: true, silly: false, onDone: done });
  }

  /** In the air (or rolling) as a ragdoll: her position is its business until it lands. */
  get ragdolled(): boolean { return this.game.people.rag.flying(this.person); }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.boats.update(dt);
    // Anyone may write `health`; whoever brought it to zero, this is where it counts.
    // (Kid-friendly mode: whatever wrote it, she is fine; and anybody lying there from before gets up.)
    if (kid.on && !(this.health > 0)) this.health = 100;
    if (this.health <= 0 && this.mode !== 'dead') this.die();
    if (this.safeT > 0) this.safeT -= dt;
    if (this.nagT > 0) this.nagT -= dt;
    // Squeezed against a wall the camera ends up inside her head; it says so, and she steps out of the picture.
    if (this.mode !== 'drive') this.person.visible = !this.game.cam.tooClose;

    switch (this.mode) {
      case 'foot': this.onFoot(dt); break;
      case 'enter': this.toDoor(dt); break;
      case 'drive': this.driving(dt); break;
      case 'ride': if (!this.rideCar) this.mode = 'foot'; else if (this.game.input.eat('enter')) this.exit(); break;
      case 'leave': case 'hoist': this.scripted(dt); break;
      case 'tumble': this.tumbling(dt); break;
      case 'dead': this.lying(dt); break;
      case 'wash': this.washing(dt); break;
    }
    this.lungs(dt);
    this.person.health = this.health;
  }

  private onFoot(dt: number): void {
    const g = this.game, inp = g.input, per = this.person;

    let mx = inp.moveX, my = inp.moveY;
    let m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; m = 1; }
    // Camera-relative: forward on the stick is away from the lens.
    const yaw = g.cam.yaw, s = Math.sin(yaw), c = Math.cos(yaw);
    let wx = s * my - c * mx, wz = c * my + s * mx;
    const aim = this.weapons.aiming;
    let sprint = inp.down('sprint') && !aim;
    if (this.turnT > 0) {
      // Past the edge of the map the tide does the steering for a couple of seconds.
      this.turnT -= dt;
      const l = Math.hypot(per.x, per.z) || 1;
      wx = -per.x / l; wz = -per.z / l; m = 1; sprint = true;
    }

    let want: number;
    if (this.swimming) {
      // Spent, she cannot sprint and her strokes slow; above TIRED a swim is exactly what it always was.
      if (this.stamina <= 0.02) sprint = false;
      want = (sprint ? SWIM_FAST : SWIM) * m * (this.stamina < TIRED ? 0.55 + 0.45 * (this.stamina / TIRED) : 1);
    } else {
      // A light push on the stick is a walk; past 60% it ramps up to the jog.
      want = m <= 0.6 ? WALK * (m / 0.6) : lerp(WALK, sprint ? SPRINT : JOG, (m - 0.6) / 0.4);
      // Wading: the deeper the water, the slower the legs.
      if (this.wet) want *= 1 - 0.6 * clamp01((waterLevelAt(per.x, per.z) - per.y) / FLOAT);
      if (aim) want = Math.min(want, AIM_PACE);
    }
    this.inM = m; this.inSprint = sprint;
    const rate = this.swimming ? 3.5 : this.grounded ? (m > 0.05 ? 11 : 15) : 2;
    const k = m > 1e-4 ? want / m : 0;
    this.vx = damp(this.vx, wx * k, rate, dt);
    this.vz = damp(this.vz, wz * k, rate, dt);
    // Aiming, she faces where the camera looks and sidesteps; otherwise she faces where she is going.
    if (aim) per.h = dampAngle(per.h, yaw, 22, dt);
    else if (m > 0.05) per.h = dampAngle(per.h, headingOf(wx, wz), this.swimming ? 5 : this.grounded ? 13 : 7, dt);

    if (inp.hit('jump')) this.jumpBuf = 0.12; else this.jumpBuf -= dt;
    if (this.grounded) this.coyote = 0.1; else this.coyote -= dt;
    if (this.jumpBuf > 0 && this.coyote > 0 && !this.swimming && per.y > waterLevelAt(per.x, per.z) - 0.6) {
      this.vy = JUMP_V;
      this.grounded = false;
      this.jumpBuf = 0; this.coyote = 0; this.airT = 0;
    }

    const landed = this.advance(dt);
    if (landed > HARD_LANDING) {
      const hurt = (landed - HARD_LANDING) * 5.5;
      this.damage(hurt);
      g.cam.shake(clamp(hurt / 60, 0.12, 0.7));
      if (hurt > 20) this.knockDown(this.vx * 0.6, this.vz * 0.6, 0);
    }

    // A car that drives into her knocks her over; one she walks into is just a wall.
    const car = this.bumped;
    if (car && !kid.on && this.safeT <= 0 && this.mode === 'foot') {
      let nx = per.x - car.x, nz = per.z - car.z;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      // Only the car's own speed counts. Her run is not in it: sprinting into a parked car is her problem.
      const closing = car.vx * nx + car.vz * nz;
      if (closing > 4) {
        this.damage((closing - 3) * 3.2);
        this.knockDown(car.vx * 0.8 + nx * 2, car.vz * 0.8 + nz * 2, 2.6, car);
        g.cam.shake(clamp(closing / 30, 0.15, 0.7));
      }
    }

    // Swimming into the side of a deck: lean on it for a moment (or jump) and she climbs out.
    // Without this, falling off the end of the pier is a four-minute swim to the beach.
    if (this.swimming && this.ledge && m > 0.3 && this.ledgeY - waterLevelAt(per.x, per.z) < 1.5 && this.mode === 'foot') {
      this.pushT += dt;
      if (this.pushT > 0.25 || inp.hit('jump')) this.hoist();
    } else {
      this.pushT = 0;
    }

    this.fence();
    if (this.mode !== 'foot') return;

    const sp = Math.hypot(this.vx, this.vz);
    per.speed = sp;
    if (this.swimming) per.pose = 'swim';
    else if (!this.grounded) {
      // Stepping off a curb is airborne for a frame or two; that is not worth a pose.
      if (this.vy > 0) per.pose = 'jump';
      else if (this.airT > 0.12) per.pose = 'fall';
    } else per.pose = sp < 0.25 ? 'stand' : sp < 3 ? 'walk' : 'run';

    // A swimmer can climb aboard a boat alongside; nothing else.
    this.nearVehicle = this.swimming ? this.boats.nearest(per.x, per.y + FLOAT, per.z, 1.4) : !this.grounded || this.rideNear ? null : this.findVehicle();
    if (this.nearVehicle && inp.hit('enter')) {
      inp.eat('enter');
      this.enter(this.nearVehicle);
    }
  }

  /**
   * Move by the current velocity and settle the height. Handles walls, cars,
   * steps, ledges, gravity and water. Returns the downward speed of a landing
   * on solid ground this frame, else 0.
   */
  private advance(dt: number): number {
    const per = this.person, p = this.p, g = this.game;
    const ox = per.x, oz = per.z;
    p.x = ox + this.vx * dt;
    p.z = oz + this.vz * dt;
    // Feet are passed a little high on purpose: boxes up to STEP_BOX tall then
    // do not push her away, and support() below lets her step onto them.
    let hit = g.col.resolveCircle(p, RADIUS, per.y + STEP_BOX);
    this.bumped = g.vehicles.resolveCircle(p, RADIUS, per.y);
    if (this.bumped) hit = true;

    // A rise too tall to step up is a wall. Each axis is tried on its own so
    // she slides along it instead of sticking to it.
    const limit = per.y + (this.grounded ? STEP_UP : 0.25);
    let gy = this.support(p.x, p.z, per.y);
    this.ledge = false;
    if (gy > limit) {
      this.ledge = true; this.ledgeX = p.x; this.ledgeY = gy; this.ledgeZ = p.z;
      const gx = this.support(p.x, oz, per.y), gz = this.support(ox, p.z, per.y);
      if (gx <= limit && (gz > limit || Math.abs(p.x - ox) >= Math.abs(p.z - oz))) { p.z = oz; gy = gx; }
      else if (gz <= limit) { p.x = ox; gy = gz; }
      else { p.x = ox; p.z = oz; gy = this.support(ox, oz, per.y); }
      hit = true;
    }
    if (hit && dt > 0) {
      // Report the speed she actually made, so she does not run on the spot against a wall.
      const ax = (p.x - ox) / dt, az = (p.z - oz) / dt;
      if (ax * ax + az * az < this.vx * this.vx + this.vz * this.vz) { this.vx = ax; this.vz = az; }
    }
    per.x = p.x; per.z = p.z;

    const fallV = this.vy;
    let landed = 0;
    if (this.swimming) {
      if (gy >= swimY(per.x, per.z)) {
        // The seabed has come up to meet her feet: wade from here.
        this.swimming = false; this.grounded = true; this.vy = 0; per.y = gy;
      } else {
        // A soft spring to the floating depth, so a dive bobs back up instead of stopping dead.
        this.vy += ((Math.max(swimY(per.x, per.z) - this.sink, gy + 0.05) - per.y) * 30 - this.vy * 9) * dt;
        per.y += this.vy * dt;
      }
    } else if (this.grounded) {
      // Deep water under her is a swim only if she waded into it. Off the edge of a deck it is a fall first.
      if (gy < swimY(per.x, per.z) && per.y <= swimY(per.x, per.z) + 0.3) { this.swimming = true; this.grounded = false; this.vy = 0; }
      else if (gy < per.y - DROP) { this.grounded = false; this.vy = 0; this.airT = 0; }
      // Eased rather than snapped, so a curb is a step and not a jolt in the camera.
      else per.y = Math.abs(gy - per.y) < 0.004 ? gy : Math.max(damp(per.y, gy, 26, dt), gy - 0.22);
    } else {
      this.vy -= GRAVITY * dt;
      per.y += this.vy * dt;
      this.airT += dt;
      if (gy < swimY(per.x, per.z)) {
        if (per.y <= swimY(per.x, per.z)) { this.swimming = true; this.vy *= 0.3; }
      } else if (per.y <= gy) {
        landed = -this.vy;
        per.y = gy; this.vy = 0; this.grounded = true; this.airT = 0;
      }
    }

    const wet = gy < waterLevelAt(per.x, per.z) - 0.35 && per.y < waterLevelAt(per.x, per.z) - 0.25;
    if (wet && !this.wet) g.emit('splash', { x: per.x, z: per.z, big: fallV < -4 });
    this.wet = wet;
    return landed;
  }

  /** Height of what she would stand on at (x, z): the ground, or the top of a box her feet could reach. */
  private support(x: number, z: number, y: number): number {
    this.qx = x; this.qy = y; this.qz = z;
    setGroundHint(y);
    this.qTop = groundAt(x, z);
    setGroundHint();
    this.game.col.forBoxes(x, z, 0.05, this.boxTop);
    return this.qTop;
  }
  // A field, not a method, so forBoxes gets the same function every frame instead of a fresh closure.
  private boxTop = (b: Box): void => {
    if (this.qx > b.x0 && this.qx < b.x1 && this.qz > b.z0 && this.qz < b.z1
      && b.y1 <= this.qy + STEP_UP && b.y1 > this.qTop) this.qTop = b.y1;
  };

  /** Keep her inside the map: a hard stop at the line, and a firm turn for home before it. */
  private fence(): void {
    const per = this.person, b = this.game.plan.bounds, M = 40;
    if (per.x > b.x0 + M && per.x < b.x1 - M && per.z > b.z0 + M && per.z < b.z1 - M) return;
    per.x = clamp(per.x, b.x0 + 2, b.x1 - 2);
    per.z = clamp(per.z, b.z0 + 2, b.z1 - 2);
    if (this.turnT > 0) return;
    this.turnT = 2.5;
    if (this.nagT <= 0) {
      this.nagT = 12;
      this.game.hud.toast(NAGS[this.nag++ % NAGS.length], 5);
    }
  }

  private hoist(): void {
    const per = this.person;
    let dx = this.ledgeX - per.x, dz = this.ledgeZ - per.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const tx = this.ledgeX + dx * 0.5, tz = this.ledgeZ + dz * 0.5;
    const top = this.support(tx, tz, this.ledgeY);
    if (Math.abs(top - this.ledgeY) > 0.3 || this.game.col.pointBlocked(tx, tz, top + 0.9)) return;
    this.mode = 'hoist';
    this.t = 0; this.dur = 0.7;
    this.fx = per.x; this.fy = per.y; this.fz = per.z;
    this.tx = tx; this.ty = top; this.tz = tz;
    this.vx = this.vy = this.vz = 0;
    this.pushT = 0;
    // Out of the water from here on, as far as the camera is concerned: it follows her up.
    this.swimming = false;
    per.h = headingOf(dx, dz);
  }

  /** The step out of a car and the climb out of the water: a timed move between two points. */
  private scripted(dt: number): void {
    const per = this.person;
    this.t += dt;
    const k = clamp01(this.t / this.dur);
    if (this.mode === 'hoist') {
      // All the way up first, arms on the edge, and only then over it: started
      // any sooner, she goes through the planks at the waist.
      const over = smooth((k - 0.6) / 0.4);
      per.y = lerp(this.fy, this.ty, smooth(k / 0.6));
      per.x = lerp(this.fx, this.tx, over); per.z = lerp(this.fz, this.tz, over);
      if (k < 0.6) { per.pose = 'jump'; per.speed = 0; } else { per.pose = 'walk'; per.speed = 2; }
    } else {
      const a = smooth(k);
      per.x = lerp(this.fx, this.tx, a); per.z = lerp(this.fz, this.tz, a); per.y = this.ty;
      per.pose = 'walk'; per.speed = 2;
    }
    if (k < 1) return;
    this.mode = 'foot';
    this.grounded = true; this.swimming = false; this.wet = false;
    this.vx = this.vy = this.vz = 0;
  }

  // ── Vehicles ───────────────────────────────────────────────────────────────

  /** Closest car whose bodywork (not its center: a bus is long) is within reach. */
  private findVehicle(): Vehicle | null {
    const per = this.person, list = this.game.vehicles.list;
    let best: Vehicle | null = null, bd = REACH;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      // (A car that is the town's is asked for at its door: toDoor. Where nobody can be asked it has no door.)
      if (v.sunk || v.wreck || (v.shared && !this.game.takeShared)) continue;
      const dx = per.x - v.x, dz = per.z - v.z;
      const far = REACH + v.hl + v.hw;
      if (dx * dx + dz * dz > far * far || Math.abs(v.y - per.y) > 2.5) continue;
      const s = Math.sin(v.h), c = Math.cos(v.h);
      const along = Math.abs(dx * s + dz * c) - v.hl, across = Math.abs(dz * s - dx * c) - v.hw;
      const d = Math.hypot(Math.max(along, 0), Math.max(across, 0));
      if (d < bd) { bd = d; best = v; }
    }
    return this.boats.nearest(per.x, per.y, per.z, bd) ?? best;
  }

  /** The car she is on her way to the door of, if any. */
  get goingTo(): Vehicle | null { return this.mode === 'enter' ? this.goal : null; }

  private listed(v: Vehicle): boolean { return this.game.vehicles.list.indexOf(v) >= 0 || this.boats.has(v); }

  private toDoor(dt: number): void {
    const per = this.person, v = this.goal, d = this.door;
    if (!v || v.sunk || !this.listed(v)) { this.mode = 'foot'; this.goal = null; return; }
    this.t += dt;
    // The door is asked for every frame: the car may still be rolling.
    v.doorPos(this.side, d);
    const left = Math.hypot(d.x - per.x, d.z - per.z);
    if (left > 9) { this.mode = 'foot'; this.goal = null; return; }   // it drove off without her
    // The second test is the way out when something she cannot get round is in the way.
    if (left < 0.3 || this.t > this.dur + 0.8) {
      if (v.shared) {
        // The town's car, kept in another browser: ask for it, and stand at the door until the answer is in.
        const ask = this.game.takeShared, say = ask ? ask(v) : 'no';
        if (say === 'no') { this.mode = 'foot'; this.goal = null; return; }
        per.speed = 0; per.pose = 'stand';
        return;
      }
      this.seat(v);
      return;
    }

    // Standing in front of the bumper or behind the trunk, the straight line to
    // a door cuts the corner of the car. Go to a point off that corner first.
    const s = Math.sin(v.h), c = Math.cos(v.h);
    const rx = per.x - v.x, rz = per.z - v.z;
    const along = rx * s + rz * c, across = rx * c - rz * s;
    let tx = d.x, tz = d.z;
    if (Math.abs(along) > v.hl && Math.abs(across) < v.hw + RADIUS) {
      const a = Math.sign(along) * (v.hl + 0.5);
      const b = Math.sign((d.x - v.x) * c - (d.z - v.z) * s) * (v.hw + 0.6);
      tx = v.x + s * a + c * b; tz = v.z + c * a - s * b;
    }
    const far = Math.hypot(tx - per.x, tz - per.z) || 1;
    const speed = Math.max(this.run / this.dur, 3.5);
    const step = Math.min(far, speed * dt);
    const p = this.p;
    p.x = per.x + (tx - per.x) / far * step;
    p.z = per.z + (tz - per.z) / far * step;
    // Walls and lamp posts still count on the way to a door.
    this.game.col.resolveCircle(p, RADIUS, per.y + STEP_BOX);
    // Run at the door, then turn to face the car for the last few steps.
    const face = left > 0.9 ? headingOf(p.x - per.x, p.z - per.z) : headingOf(v.x - d.x, v.z - d.z);
    per.h = dampAngle(per.h, face, 14, dt);
    per.x = p.x; per.z = p.z;
    per.y = damp(per.y, Math.max(groundAt(per.x, per.z), per.y - 0.5), 20, dt);
    per.speed = speed;
    per.pose = speed < 3 ? 'walk' : 'run';
  }

  private seat(v: Vehicle): void {
    const per = this.person;
    this.car = v;
    this.used.add(v);
    this.goal = null;
    this.sinkT = 0;
    this.mode = 'drive';
    v.driver = 'player';
    // Hidden rather than sat inside: the roof of the lowest car is below her cap. On a boat she is out in the open.
    const boat = this.boats.has(v);
    per.visible = boat;
    per.bench = boat;
    per.pose = 'sit';
    per.speed = 0;
    per.x = v.x; per.y = v.y; per.z = v.z; per.h = v.h;
    this.vx = this.vy = this.vz = 0;
    this.swimming = false; this.wet = false; this.grounded = true;
    this.nearVehicle = null;
    this.game.emit('enter', { vehicle: v });
  }

  private driving(dt: number): void {
    const v = this.car!, inp = this.game.input, per = this.person, c = v.ctl;
    if (!this.listed(v) || inp.eat('enter')) { this.exit(); return; }
    if (v.sunk) {
      // Not out the instant it touches the water: the car is still carrying its
      // speed, and she would surface alone a car's length behind it, having
      // missed the splash. A moment at the wheel, then up beside the door.
      this.sinkT += dt;
      c.accel = 0; c.steer = 0; c.handbrake = false; c.horn = false;
      per.x = v.x; per.y = v.y; per.z = v.z; per.h = v.h;
      // Not out the instant: the cabin is filling. F gets her out; lungs() drowns her if she waits. Kid mode pops her up.
      if (kid.on && this.sinkT >= SINK_HOLD) this.exit();
      return;
    }
    c.steer = inp.moveX;
    // A gamepad's triggers win over its stick; keys and touch pedals arrive as moveY.
    c.accel = inp.padActive && inp.padTrig !== 0 ? inp.padTrig : inp.moveY;
    c.handbrake = inp.down('jump') || inp.down('handbrake');
    c.horn = inp.down('horn');
    if (this.boats.has(v)) {
      // At the helm or astride the saddle, where the hull is this frame (Boats.update ran first).
      const q = v.seatPos(0, this.seatV);
      per.x = q.x; per.y = q.y; per.z = q.z; per.h = v.h;
      per.visible = !this.game.cam.tooClose; per.pose = 'sit'; per.bench = true;
      return;
    }
    // Kept with the car so anything that reads the person (the map, the camera) is never stale.
    per.x = v.x; per.y = v.y; per.z = v.z; per.h = v.h;
  }
  private readonly seatV = new THREE.Vector3();

  /**
   * Off a boat: onto the dock, the pier or a beach if one is within a step of either side (or the bow or stern), and
   * into the water beside it if not. A fast boat throws her off like a car would.
   */
  private leaveBoat(v: Boat): void {
    const per = this.person, p = this.p, s = Math.sin(v.h), c = Math.cos(v.h);
    const sp = Math.hypot(v.vx, v.vz);
    this.release(v);
    per.h = v.h; per.bench = false; this.safeT = 1;
    const tries: [number, number][] = [[-1, 0], [1, 0], [0, 1], [0, -1]];
    for (const [side, end] of tries) {
      const off = side * (v.hw + 0.7), along = end * (v.hl + 0.6);
      p.x = v.x + c * off + s * along; p.z = v.z - s * off + c * along;
      const g = this.support(p.x, p.z, v.y + 2.2);
      if (g < swimY(p.x, p.z) + FLOAT - 0.25 || g > v.y + 2.2 || this.game.col.pointBlocked(p.x, p.z, g + 0.9)) continue;
      if (sp > BAIL_SPEED) break;
      per.x = p.x; per.z = p.z; per.y = g;
      this.grounded = true; this.swimming = false; this.vy = 0; this.mode = 'foot';
      return;
    }
    v.doorPos(-1, p);
    per.x = p.x; per.z = p.z;
    per.y = swimY(per.x, per.z); this.swimming = true; this.grounded = false; this.wet = true;
    this.vx = v.vx * 0.5; this.vz = v.vz * 0.5; this.vy = 0;
    this.mode = 'foot';
    this.game.emit('splash', { x: per.x, z: per.z, big: false });
  }

  /** Hand the car back: nobody at the wheel, pedals up. */
  private release(v: Vehicle): void {
    if (v === this.rideCar) {
      // A passenger hands nothing back: the car is its driver's.
      this.rideCar = null;
      this.person.bench = false;
      this.person.visible = true;
      if (this.mode === 'ride') this.mode = 'foot';
      return;
    }
    v.driver = null;
    v.ctl.accel = 0; v.ctl.steer = 0; v.ctl.handbrake = false; v.ctl.horn = false;
    this.car = null;
    this.person.visible = true;
    this.person.bench = false;
    this.game.emit('exit', { vehicle: v });
  }

  /** Leaves the place to get out in this.p: driver's door, passenger door, behind, in front. */
  private pickExit(v: Vehicle): void {
    const p = this.p, s = Math.sin(v.h), c = Math.cos(v.h), back = v.hl + 0.9;
    v.doorPos(-1, p);
    if (this.clear(p, v)) return;
    v.doorPos(1, p);
    if (this.clear(p, v)) return;
    p.x = v.x - s * back; p.z = v.z - c * back;
    if (this.clear(p, v)) return;
    p.x = v.x + s * back; p.z = v.z + c * back;
    if (this.clear(p, v)) return;
    // Boxed in on every side. Take the driver's door anyway; the walls will push her somewhere.
    v.doorPos(-1, p);
  }

  /** Could she stand at p after getting out of v? May nudge p away from a lamp post. */
  private clear(p: { x: number; z: number }, v: Vehicle): boolean {
    const col = this.game.col;
    const g = groundAt(p.x, p.z);
    if (g > v.y + 0.7) return false;
    const feet = g > v.y - DROP ? g : v.y;
    const x0 = p.x, z0 = p.z;
    col.resolveCircle(p, RADIUS, feet + STEP_BOX);
    const moved = (p.x - x0) * (p.x - x0) + (p.z - z0) * (p.z - z0);
    if (moved > 0.36 || col.pointBlocked(p.x, p.z, feet + 0.9)) return false;
    // A fence between the seat and the spot counts, however free the spot itself is.
    if (!col.lineOfSight(v.x, feet + 0.9, v.z, p.x, feet + 0.9, p.z)) return false;
    const list = this.game.vehicles.list;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === v || Math.abs(o.y - v.y) > 2) continue;
      const dx = p.x - o.x, dz = p.z - o.z;
      const s = Math.sin(o.h), c = Math.cos(o.h);
      if (Math.abs(dx * s + dz * c) < o.hl + 0.3 && Math.abs(dz * s - dx * c) < o.hw + 0.3) return false;
    }
    return true;
  }

  // ── Down, out, and back ────────────────────────────────────────────────────

  /** Sliding along the road after a bail-out or a knock: no control until she has stopped. */
  private slide(dt: number): number {
    const sp = Math.hypot(this.vx, this.vz);
    if (this.swimming) {
      this.vx = damp(this.vx, 0, 3, dt); this.vz = damp(this.vz, 0, 3, dt);
    } else if (this.grounded && sp > 0) {
      // Road rash: a steady scrub plus a share of the speed, so fast slides do not go on forever.
      const k = Math.max(0, sp - (7 + sp * 0.7) * dt) / sp;
      this.vx *= k; this.vz *= k;
    }
    const before = Math.hypot(this.vx, this.vz);
    const landed = this.advance(dt);
    const after = Math.hypot(this.vx, this.vz);
    // Meeting a wall mid-slide hurts in proportion to the speed it took away.
    if (before - after > 5) this.damage((before - after - 5) * 1.5);
    if (landed > HARD_LANDING) this.damage((landed - HARD_LANDING) * 5.5);
    this.person.speed = after;
    return after;
  }

  private tumbling(dt: number): void {
    const per = this.person;
    if (this.ragdolled) { per.speed = 0; return; }
    const sp = this.slide(dt);
    this.fence();
    if (this.swimming) { this.mode = 'foot'; per.pose = 'swim'; return; }   // the water breaks the fall
    per.pose = 'down';
    if (this.grounded && sp < 0.6) this.restT += dt; else this.restT = 0;
    if (this.restT > 0.7 && this.health > 0) {
      this.mode = 'foot';
      this.vx = this.vz = 0;
      this.safeT = 0.6;
    }
  }

  private die(): void {
    const g = this.game;
    if (this.car || this.rideCar) this.exit();
    this.mode = 'dead';
    this.goal = null;
    this.nearVehicle = null;
    this.health = 0;
    this.t = 0;
    this.person.visible = true;
    g.hud.stamp('CLOCKED OUT', LAST_WORDS[this.deaths++ % LAST_WORDS.length]);
  }

  // ── Drowning ───────────────────────────────────────────────────────────────

  /**
   * Breath and strength, every frame. Swimming (any stroke at all) keeps her up; stand still in deep water and she treads for
   * TREAD seconds, then sinks, and her breath runs out BREATH_SECS after her head goes under. A car on the bottom is the same
   * clock with CAR_BREATH. Kid-friendly mode never drowns: stop swimming and the lifeguard comes (rescue).
   */
  private lungs(dt: number): void {
    const per = this.person, g = this.game;
    if (this.mode === 'wash' || this.mode === 'dead') return;
    const car = this.mode === 'drive' ? this.car : null;
    if (car && car.sunk && !this.boats.has(car)) {
      if (kid.on) return;
      this.breath = Math.max(0, this.breath - dt / CAR_BREATH);
      this.bubT -= dt;
      if (this.bubT <= 0) { this.bubT = 0.5; g.emit('water', { kind: 'bubbles', x: per.x, z: per.z, amount: 1 - this.breath }); }
      if (this.breath <= 0) this.beginWash('drown');
      return;
    }
    if (this.mode !== 'foot' || !this.swimming) {
      // Dry, or wading: lungs and legs fill back up.
      this.sink = Math.max(0, this.sink - RISE_RATE * dt); this.tread = 0;
      this.breath = Math.min(1, this.breath + dt * BREATH_BACK / BREATH_SECS);
      this.stamina = Math.min(1, this.stamina + dt / 12);
      this.wasUnder = false;
      return;
    }
    const moving = this.inM > 0.1;
    if (moving) this.tread = 0; else this.tread += dt;
    if (kid.on) {
      this.sink = 0; this.breath = 1; this.stamina = 1;
      if (this.tread > KID_TREAD) this.beginWash('rescue');
      return;
    }
    if (moving) {
      this.sink = Math.max(0, this.sink - RISE_RATE * dt);
      this.stamina = Math.max(0, this.stamina - dt / (this.inSprint ? STAMINA_SPRINT : STAMINA_SWIM));
    } else {
      this.stamina = Math.min(1, this.stamina + dt / STAMINA_REST);
      const tired = this.stamina < TIRED;
      if (this.tread > (tired ? TREAD * 0.4 : TREAD)) this.sink = Math.min(SINK_MAX, this.sink + SINK_RATE * (tired ? 1.8 : 1) * dt);
    }
    if (this.sink > HEAD_UNDER) {
      this.wasUnder = true;
      this.breath = Math.max(0, this.breath - dt / BREATH_SECS);
      this.bubT -= dt;
      if (this.bubT <= 0) { this.bubT = 0.6 + this.breath * 0.8; g.emit('water', { kind: 'bubbles', x: per.x, z: per.z, amount: 1 - this.breath }); }
      if (this.breath <= 0) this.beginWash('drown');
    } else {
      if (this.wasUnder) {
        this.wasUnder = false;
        if (this.breath < 0.7) g.emit('water', { kind: 'gasp', x: per.x, z: per.z, amount: 1 - this.breath });
      }
      this.breath = Math.min(1, this.breath + dt * BREATH_BACK / BREATH_SECS);
    }
  }

  /** Out of air (or, in kid-friendly mode, whistled out): the fade, the card, and a new place to stand. */
  private beginWash(kind: 'drown' | 'rescue'): void {
    const g = this.game, per = this.person;
    if (this.car || this.rideCar) this.exit();
    this.mode = 'wash';
    this.washKind = kind; this.washT = 0; this.washed = false;
    this.goal = null; this.nearVehicle = null;
    this.vx = this.vz = 0; this.vy = 0;
    this.sink = 0; this.breath = kind === 'drown' ? 0 : 1;
    per.visible = true; per.speed = 0;
    if (kind === 'rescue') g.emit('water', { kind: 'whistle', x: per.x, z: per.z, amount: 1 });
  }

  /** The drowned sequence, see WASH_*: float limp, fade to black, set down on the nearest shore (or at Mercy General), fade up. */
  private washing(dt: number): void {
    const g = this.game, per = this.person;
    this.washT += dt;
    const t = this.washT;
    this.veil = t < WASH_FADE ? t / WASH_FADE : t < WASH_PUT ? 1 : Math.max(0, 1 - (t - WASH_PUT) / (WASH_FREE - WASH_PUT));
    if (!this.washed) {
      per.speed = 0; this.vx = this.vz = 0;
      if (this.washKind === 'drown') {
        // Face down at the surface, rolling a little with the swell.
        per.pose = 'down';
        per.y = waterLevelAt(per.x, per.z) - 0.3 + Math.sin(t * 2.1) * 0.04;
      } else {
        per.pose = 'swim';
        per.y = swimY(per.x, per.z);
      }
      if (t < WASH_PUT) return;
      this.washed = true;
      const ox = per.x, oz = per.z;
      const sh = nearestShore(ox, oz, 600, (x, z, gy) => !g.col.pointBlocked(x, z, gy + 0.9));
      if (sh) {
        this.put(sh.x, sh.z, Math.atan2(sh.x - ox, sh.z - oz));
        if (this.washKind === 'drown') {
          const bill = Math.floor(this.money * FISH_FEE);
          this.money -= bill;
          g.hud.toast(bill > 0 ? `The Harbor Authority fished you out and billed you ${money(bill)}. Dripping is not covered.` : 'The Harbor Authority fished you out and found nothing to bill.', 6);
        }
      } else {
        const home = g.plan.sidewalkPoint(...HOME);
        this.put(home.x, home.z, home.h);
        this.health = 100; this.heat = 0;
        const bill = Math.floor(this.money * 0.1);
        this.money -= bill;
        g.hud.toast(bill > 0 ? `Mercy General billed you ${money(bill)}. They validated parking.` : 'Mercy General found nothing to bill. They validated parking anyway.', 6);
      }
      this.mode = 'wash';
      this.veil = 1;
      per.pose = 'down';
      if (this.washKind === 'drown') g.hud.stamp('WASHED UP', 'Harbor Authority Form W-4: you were wet, and then you were not.');
      else g.hud.stamp('FISHED OUT', 'A lifeguard has placed you on the beach and filed the paperwork.');
      g.cam.snap();
      return;
    }
    per.pose = t < WASH_PUT + 0.35 ? 'down' : 'stand';
    per.speed = 0;
    if (t >= WASH_FREE) { this.mode = 'foot'; this.veil = 0; this.safeT = 1; per.pose = 'stand'; }
  }

  private lying(dt: number): void {
    // Kid-friendly mode switched on while she lay there: she gets up where she is, no bill.
    if (kid.on) { this.health = 100; this.mode = 'tumble'; this.restT = 0; return; }
    if (!this.ragdolled) this.slide(dt);
    this.person.pose = this.swimming ? 'swim' : 'down';
    this.t += dt;
    if (this.t < 3) return;
    this.game.people.rag.drop(this.person);

    const g = this.game, home = g.plan.sidewalkPoint(...HOME);
    this.put(home.x, home.z, home.h);
    this.health = 100;
    this.heat = 0;
    const bill = Math.floor(this.money * 0.1);
    this.money -= bill;
    g.hud.toast(bill > 0
      ? `Mercy General billed you ${money(bill)}. They validated parking.`
      : 'Mercy General found nothing to bill. They validated parking anyway.', 6);
    g.cam.snap();
  }

  /** Stand her at ground level at (x, z), or afloat if that is open water. */
  private put(x: number, z: number, h: number): void {
    const per = this.person;
    const g = groundAt(x, z);
    per.x = x; per.z = z; per.h = h;
    this.swimming = g < swimY(per.x, per.z);
    per.y = this.swimming ? swimY(per.x, per.z) : g;
    this.wet = g < waterLevelAt(per.x, per.z) - 0.35;
    this.grounded = !this.swimming;
    this.vx = this.vy = this.vz = 0;
    this.airT = 0; this.jumpBuf = 0; this.turnT = 0;
    this.breath = 1; this.stamina = 1; this.sink = 0; this.tread = 0; this.wasUnder = false; this.veil = 0;
    this.mode = 'foot';
    this.nearVehicle = null;
    per.visible = true;
    per.pose = this.swimming ? 'swim' : 'stand';
    per.speed = 0;
  }
}
