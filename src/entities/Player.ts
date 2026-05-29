import * as THREE from 'three';
import type { WalkInputState } from '../types';

const WALK_SPEED   = 6;   // m/s
const TURN_SPEED   = 8;   // rad/s (heading turn speed)
const BOB_FREQ     = 9;   // rad/s (walk animation)

const _bodyMat = new THREE.MeshLambertMaterial({ color: 0xff6b35 });
const _headMat = new THREE.MeshLambertMaterial({ color: 0xf4a261 });
const _legMat  = new THREE.MeshLambertMaterial({ color: 0x264653 });
const _armMat  = new THREE.MeshLambertMaterial({ color: 0xff6b35 });

export class Player {
  readonly mesh: THREE.Group;
  position: THREE.Vector3;
  heading = 0;   // radians; 0 = facing +Z

  private bobTime   = 0;
  private isMoving  = false;

  // Limb references for walk animation
  private readonly leftLeg:  THREE.Mesh;
  private readonly rightLeg: THREE.Mesh;
  private readonly leftArm:  THREE.Mesh;
  private readonly rightArm: THREE.Mesh;

  constructor(scene: THREE.Scene, startPosition: THREE.Vector3) {
    this.position = startPosition.clone();

    const g = new THREE.Group();

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), _headMat);
    head.position.y = 1.68;
    g.add(head);

    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.72, 0.28), _bodyMat);
    body.position.y = 1.1;
    g.add(body);

    // Arms
    const armGeom = new THREE.BoxGeometry(0.18, 0.62, 0.18);
    const lArm = new THREE.Mesh(armGeom, _armMat);
    lArm.position.set(-0.39, 1.09, 0);
    g.add(lArm);
    this.leftArm = lArm;

    const rArm = new THREE.Mesh(armGeom, _armMat);
    rArm.position.set(0.39, 1.09, 0);
    g.add(rArm);
    this.rightArm = rArm;

    // Legs
    const legGeom = new THREE.BoxGeometry(0.2, 0.6, 0.2);
    const lLeg = new THREE.Mesh(legGeom, _legMat);
    lLeg.position.set(-0.16, 0.48, 0);
    g.add(lLeg);
    this.leftLeg = lLeg;

    const rLeg = new THREE.Mesh(legGeom, _legMat);
    rLeg.position.set(0.16, 0.48, 0);
    g.add(rLeg);
    this.rightLeg = rLeg;

    this.mesh = g;
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
  }

  update(input: WalkInputState, dt: number): void {
    const dx = input.moveX;
    const dz = input.moveZ;
    const mag = Math.sqrt(dx * dx + dz * dz);
    this.isMoving = mag > 0.08;

    if (this.isMoving) {
      const targetHeading = Math.atan2(dx, -dz);
      // Shortest angle interpolation
      let diff = targetHeading - this.heading;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading += diff * Math.min(1, TURN_SPEED * dt);

      const speed = Math.min(1, mag) * WALK_SPEED;
      this.position.x += Math.sin(this.heading) * speed * dt;
      this.position.z += Math.cos(this.heading) * speed * dt;
    }

    this._animate(dt);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.heading;
  }

  private _animate(dt: number): void {
    if (this.isMoving) {
      this.bobTime += BOB_FREQ * dt;
    } else {
      // Damp bob back to rest
      this.bobTime *= 0.85;
      if (Math.abs(this.bobTime) < 0.01) this.bobTime = 0;
    }

    const swing = Math.sin(this.bobTime) * 0.45;
    this.leftLeg.rotation.x  =  swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x  = -swing * 0.6;
    this.rightArm.rotation.x =  swing * 0.6;
  }

  show(): void { this.mesh.visible = true;  }
  hide(): void { this.mesh.visible = false; }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.traverse(child => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
  }
}
