import * as THREE from 'three';
import { VehiclePhysics } from '../physics/VehiclePhysics';
import type { VehicleInputState } from '../types';

// Shared materials pool — created once, reused across all vehicles
const _matPool = new Map<number, THREE.MeshLambertMaterial>();

function getCarMat(hex: number): THREE.MeshLambertMaterial {
  if (!_matPool.has(hex)) {
    _matPool.set(hex, new THREE.MeshLambertMaterial({ color: hex }));
  }
  return _matPool.get(hex)!;
}

const _darkMat   = new THREE.MeshLambertMaterial({ color: 0x111111 });
const _glassMat  = new THREE.MeshLambertMaterial({ color: 0x334466 });
const _hlMat     = new THREE.MeshLambertMaterial({ color: 0xffffaa, emissive: 0x888844 });
const _tlMat     = new THREE.MeshLambertMaterial({ color: 0xff2200 });
const _rimMat    = new THREE.MeshLambertMaterial({ color: 0xbbbbbb });

export class Vehicle {
  readonly mesh: THREE.Group;
  readonly physics: VehiclePhysics;
  isOccupied = false;

  // Wheel groups for visual spin
  private readonly wheelGroups: THREE.Group[] = [];

  constructor(
    scene: THREE.Scene,
    position: THREE.Vector3,
    heading = 0,
    color = 0xff3333
  ) {
    this.physics = new VehiclePhysics(position, heading);
    this.mesh    = this._buildMesh(color);
    this._syncMesh();
    scene.add(this.mesh);
  }

  private _buildMesh(color: number): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = getCarMat(color);

    // ── Body ──────────────────────────────────────────────────────────────────
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.52, 4.6), bodyMat);
    bodyMesh.position.y = 0.36;
    g.add(bodyMesh);

    // ── Cabin ─────────────────────────────────────────────────────────────────
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.58, 2.4), bodyMat);
    cabin.position.set(0, 0.91, -0.25);
    g.add(cabin);

    // ── Windshield ────────────────────────────────────────────────────────────
    const wsFront = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.48, 0.08), _glassMat);
    wsFront.position.set(0, 0.91, 0.97);
    g.add(wsFront);

    const wsRear = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.48, 0.08), _glassMat);
    wsRear.position.set(0, 0.91, -1.46);
    g.add(wsRear);

    // ── Side windows ─────────────────────────────────────────────────────────
    for (const sx of [-1.01, 1.01]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.38, 1.6), _glassMat);
      sw.position.set(sx, 0.91, -0.25);
      g.add(sw);
    }

    // ── Headlights ────────────────────────────────────────────────────────────
    for (const hx of [-0.68, 0.68]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.08), _hlMat);
      hl.position.set(hx, 0.34, 2.35);
      g.add(hl);
    }

    // ── Tail lights ──────────────────────────────────────────────────────────
    for (const tx of [-0.68, 0.68]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.08), _tlMat);
      tl.position.set(tx, 0.34, -2.35);
      g.add(tl);
    }

    // ── Bumpers ───────────────────────────────────────────────────────────────
    const bumperF = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.2, 0.16), _darkMat);
    bumperF.position.set(0, 0.2, 2.35);
    g.add(bumperF);

    const bumperR = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.2, 0.16), _darkMat);
    bumperR.position.set(0, 0.2, -2.35);
    g.add(bumperR);

    // ── Wheels (4) ────────────────────────────────────────────────────────────
    const wheelGeom = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 10);
    const rimGeom   = new THREE.CylinderGeometry(0.22, 0.22, 0.30, 6);
    const hubGeom   = new THREE.CylinderGeometry(0.08, 0.08, 0.32, 5);

    const axlePositions = [
      { x:  1.08, z:  1.45 }, // front-right
      { x: -1.08, z:  1.45 }, // front-left
      { x:  1.08, z: -1.45 }, // rear-right
      { x: -1.08, z: -1.45 }, // rear-left
    ];

    for (const ap of axlePositions) {
      const wg = new THREE.Group();
      const tire = new THREE.Mesh(wheelGeom, _darkMat);
      tire.rotation.z = Math.PI / 2;
      wg.add(tire);

      const rim = new THREE.Mesh(rimGeom, _rimMat);
      rim.rotation.z = Math.PI / 2;
      wg.add(rim);

      const hub = new THREE.Mesh(hubGeom, _darkMat);
      hub.rotation.z = Math.PI / 2;
      wg.add(hub);

      wg.position.set(ap.x, 0.36, ap.z);
      g.add(wg);
      this.wheelGroups.push(wg);
    }

    return g;
  }

  update(input: VehicleInputState | null, dt: number): void {
    if (input) {
      this.physics.update(input, dt);
      // Visual wheel spin proportional to forward speed
      const spinRate = this.physics.getForwardSpeed() * dt * 1.5;
      for (const wg of this.wheelGroups) {
        wg.children[0].rotation.y += spinRate;
      }
    }
    this._syncMesh();
  }

  private _syncMesh(): void {
    this.mesh.position.copy(this.physics.position);
    this.mesh.position.y = 0; // keep grounded
    // heading convention: heading=0 → mesh faces +Z (Three.js default)
    // rotation.y = heading works because R_y(θ)·(0,0,1) = (sinθ, 0, cosθ)
    this.mesh.rotation.y = this.physics.heading;
  }

  getPosition(): THREE.Vector3 { return this.physics.position.clone(); }
  getHeading():  number        { return this.physics.heading; }

  setOccupied(val: boolean): void { this.isOccupied = val; }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    });
  }
}
