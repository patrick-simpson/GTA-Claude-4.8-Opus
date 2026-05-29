import * as THREE from 'three';

// Smooth third-person chase camera with separate configs for walk / drive.
export class ChaseCamera {
  private readonly camera: THREE.PerspectiveCamera;
  private currentPos: THREE.Vector3;
  private currentTarget: THREE.Vector3;

  // Driving: further back, lower angle, lazier
  private readonly DRIVE_DIST   = 9.5;
  private readonly DRIVE_HEIGHT = 4.2;
  private readonly DRIVE_SMOOTH = 6;    // units per second (exponential)

  // Walking: closer, higher angle, snappier
  private readonly WALK_DIST    = 6;
  private readonly WALK_HEIGHT  = 5;
  private readonly WALK_SMOOTH  = 10;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera        = camera;
    this.currentPos    = camera.position.clone();
    this.currentTarget = new THREE.Vector3(0, 1, 0);
  }

  update(
    targetPos:   THREE.Vector3,
    heading:     number,
    isDriving:   boolean,
    dt:          number
  ): void {
    const dist   = isDriving ? this.DRIVE_DIST   : this.WALK_DIST;
    const height = isDriving ? this.DRIVE_HEIGHT : this.WALK_HEIGHT;
    const smooth = isDriving ? this.DRIVE_SMOOTH : this.WALK_SMOOTH;

    // Desired camera position: directly behind the target entity
    // heading = 0 → entity faces +Z → camera should be at -Z offset
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);

    const desired = new THREE.Vector3(
      targetPos.x - sinH * dist,
      targetPos.y + height,
      targetPos.z - cosH * dist
    );

    // Exponential smoothing — frame-rate independent
    const alpha = 1 - Math.exp(-smooth * dt);
    this.currentPos.lerp(desired, alpha);

    // Look-at point: slightly ahead of the entity and at chest height
    const lookAheadDist = isDriving ? 5 : 2;
    const lookHeight    = isDriving ? 1.0 : 1.5;

    const desiredTarget = new THREE.Vector3(
      targetPos.x + sinH * lookAheadDist,
      targetPos.y + lookHeight,
      targetPos.z + cosH * lookAheadDist
    );
    this.currentTarget.lerp(desiredTarget, alpha * 1.3);

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentTarget);
  }

  /** Hard-snap the camera to avoid a slow start. */
  snapTo(targetPos: THREE.Vector3, heading: number, isDriving: boolean): void {
    const dist   = isDriving ? this.DRIVE_DIST   : this.WALK_DIST;
    const height = isDriving ? this.DRIVE_HEIGHT : this.WALK_HEIGHT;
    const sinH   = Math.sin(heading);
    const cosH   = Math.cos(heading);

    this.currentPos.set(
      targetPos.x - sinH * dist,
      targetPos.y + height,
      targetPos.z - cosH * dist
    );
    this.currentTarget.set(
      targetPos.x + sinH * 2,
      targetPos.y + 1.5,
      targetPos.z + cosH * 2
    );
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentTarget);
  }
}
