import * as THREE from 'three';
import type { VehicleInputState } from '../types';

// Arcade bicycle-model vehicle physics with momentum drift.
export class VehiclePhysics {
  position: THREE.Vector3;
  heading: number; // radians; 0 = facing world +Z, increases clockwise
  velocity: THREE.Vector3 = new THREE.Vector3();

  private steerAngle = 0; // current steering angle (radians)

  // ── Tuning ────────────────────────────────────────────────────────────────
  private readonly MAX_SPEED        = 28;    // m/s  (~100 km/h)
  private readonly MAX_REVERSE      = 8;     // m/s
  private readonly ACCELERATION     = 14;    // m/s²
  private readonly BRAKE_FORCE      = 22;    // m/s²
  private readonly ROLL_FRICTION    = 3.5;   // m/s²   (passive drag)
  private readonly ENGINE_BRAKE     = 5;     // m/s²   (lift throttle)
  private readonly MAX_STEER        = 0.65;  // radians  (~37°)
  private readonly STEER_SPEED      = 3.5;   // rad/s  (how fast wheel turns)
  private readonly STEER_RETURN     = 5;     // rad/s  (self-centering)
  private readonly WHEELBASE        = 2.8;   // metres
  private readonly GRIP             = 9;     // lateral friction coefficient
  private readonly UNDERSTEER       = 0.045; // speed-based turn-rate reduction
  // ─────────────────────────────────────────────────────────────────────────

  constructor(startPosition: THREE.Vector3, startHeading = 0) {
    this.position = startPosition.clone();
    this.heading  = startHeading;
  }

  update(input: VehicleInputState, dt: number): void {
    dt = Math.min(dt, 0.05); // clamp to avoid explosion

    // ── Decompose velocity into forward / lateral components ────────────────
    const fwd   = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));

    let vFwd = this.velocity.dot(fwd);
    let vLat = this.velocity.dot(right);

    // ── Throttle / Brake ────────────────────────────────────────────────────
    if (input.throttle > 0) {
      if (vFwd < -0.3) {
        // Counter-braking: fight reverse motion
        vFwd += this.BRAKE_FORCE * input.throttle * dt;
      } else {
        // Normal acceleration with exponential top-speed curve
        const speedRatio  = Math.abs(vFwd) / this.MAX_SPEED;
        const accelFactor = 1 - speedRatio * speedRatio * 0.6;
        vFwd = Math.min(
          this.MAX_SPEED,
          vFwd + this.ACCELERATION * accelFactor * input.throttle * dt
        );
      }
    }

    if (input.brake > 0) {
      if (vFwd > 0.3) {
        // Hard braking
        vFwd = Math.max(0, vFwd - this.BRAKE_FORCE * input.brake * dt);
      } else {
        // Reverse
        vFwd = Math.max(
          -this.MAX_REVERSE,
          vFwd - this.ACCELERATION * 0.5 * input.brake * dt
        );
      }
    }

    // ── Rolling friction (when no input) ────────────────────────────────────
    if (input.throttle === 0 && input.brake === 0) {
      const friction = (this.ENGINE_BRAKE + this.ROLL_FRICTION) * dt;
      vFwd = Math.abs(vFwd) <= friction
        ? 0
        : vFwd - Math.sign(vFwd) * friction;
    }

    // ── Steering ─────────────────────────────────────────────────────────────
    const steerTarget = input.steer * this.MAX_STEER;
    if (Math.abs(input.steer) > 0.01) {
      this.steerAngle += (steerTarget - this.steerAngle) * Math.min(1, this.STEER_SPEED * dt);
    } else {
      this.steerAngle *= Math.max(0, 1 - this.STEER_RETURN * dt);
    }

    // ── Heading update (bicycle model) ───────────────────────────────────────
    if (Math.abs(vFwd) > 0.4) {
      // Angular velocity = forward_speed * tan(steer) / wheelbase
      const rawTurn   = vFwd * Math.tan(this.steerAngle) / this.WHEELBASE;
      const understeer = 1 / (1 + Math.abs(vFwd) * this.UNDERSTEER);
      this.heading   += rawTurn * understeer * dt;
    }

    // ── Lateral grip (creates and dissipates drift) ──────────────────────────
    // Grip blends lateral speed toward zero; low grip = more drift
    const gripForce = Math.min(1, this.GRIP * dt);
    vLat *= (1 - gripForce);

    // ── Recompose velocity in new heading frame ──────────────────────────────
    const newFwd   = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const newRight = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));

    this.velocity
      .copy(newFwd).multiplyScalar(vFwd)
      .addScaledVector(newRight, vLat);

    this.position.addScaledVector(this.velocity, dt);
  }

  getForwardSpeed(): number {
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    return this.velocity.dot(fwd);
  }

  getForwardDirection(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  reset(position: THREE.Vector3, heading = 0): void {
    this.position.copy(position);
    this.heading = heading;
    this.velocity.set(0, 0, 0);
    this.steerAngle = 0;
  }
}
