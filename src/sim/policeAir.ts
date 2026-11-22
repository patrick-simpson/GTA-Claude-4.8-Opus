// The parts of the Harbor Patrol that are only ever looked at: the flashing
// light bars, the helicopter and its spotlight, and the two painted frontages
// (the station and the Fresh Coat respray shop). No decisions are made here;
// src/sim/police.ts tells each of these where to be.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { TAU, clamp, damp } from '../core/util';
import { groundAt } from '../world/plan';

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Light bars as glow sprites: two per cruiser, one red and one blue, on for alternate halves of
 * a double-flash pattern. Sprites rather than the lamp material because the bar has to read from
 * three blocks away, and a 30 cm emissive strip does not.
 */
export class Beacons {
  private readonly sprites: THREE.Sprite[] = [];
  private readonly mats: THREE.SpriteMaterial[];
  private used = 0;

  constructor(private readonly game: Game) {
    const map = glowTexture();
    const mk = (color: number): THREE.SpriteMaterial => new THREE.SpriteMaterial({
      map, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this.mats = [mk(0xff2a1a), mk(0x2a62ff)];
    // Past 1 so the bloom pass picks the bar up as a light, not as paint.
    for (const m of this.mats) m.color.multiplyScalar(2.2);
  }

  begin(): void { this.used = 0; }

  /** One cruiser's bar this frame: roof position, heading, and a per-car phase so a convoy does not blink in step. */
  bar(x: number, y: number, z: number, h: number, phase: number): void {
    const t = (this.game.time * 2.1 + phase) % 1;
    // Two quick flashes a side: on for 0-0.12 and 0.2-0.32 of each half.
    const half = t < 0.5 ? 0 : 1, f = (t % 0.5) / 0.5;
    const lit = f < 0.24 || (f > 0.4 && f < 0.64);
    const size = 1.5 + 1.6 * this.game.sky.night;
    for (let k = 0; k < 2; k++) {
      let s = this.sprites[this.used];
      if (!s) {
        s = new THREE.Sprite(this.mats[k]);
        s.renderOrder = 5;
        this.sprites.push(s);
        this.game.scene.add(s);
      }
      this.used++;
      s.material = this.mats[k];
      const side = k === 0 ? -0.42 : 0.42;
      s.position.set(x - Math.cos(h) * side, y, z + Math.sin(h) * side);
      const on = lit && half === k;
      s.visible = true;
      s.scale.setScalar(on ? size : 0.35);
    }
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }
}

/** A sign and (optionally) a roller door, flat against whatever wall faces the sidewalk at (x, z). */
export function frontage(game: Game, x: number, z: number, nx: number, nz: number, title: string, sub: string, ink: string, paper: string, door: boolean): void {
  // nx, nz points from the street into the block. Find the wall; with none there, the sign stands on posts at the back of the sidewalk.
  let d = game.col.raycast(x, 2, z, nx, 0, nz, 14);
  const wall = d < 14;
  if (!wall) d = 1.6;
  const wx = x + nx * (d - 0.07), wz = z + nz * (d - 0.07);
  const yaw = Math.atan2(-nx, -nz);
  const y0 = groundAt(wx, wz);
  const grp = new THREE.Group();
  grp.position.set(wx, y0, wz);
  grp.rotation.y = yaw;

  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = paper; g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = ink; g.lineWidth = 10; g.strokeRect(14, 14, 996, 228);
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 118px "Arial Black", Impact, sans-serif';
  g.fillText(title, 512, 106, 940);
  g.font = '600 44px Arial, sans-serif';
  g.fillText(sub, 512, 204, 900);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(6.4, 1.6, 0.14),
    new THREE.MeshStandardMaterial({ map, roughness: 0.7, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.22 }),
  );
  sign.position.set(0, door ? 4.25 : 3.6, 0.08);
  grp.add(sign);

  if (door) {
    const dc = document.createElement('canvas');
    dc.width = 64; dc.height = 256;
    const dg = dc.getContext('2d')!;
    for (let i = 0; i < 16; i++) { dg.fillStyle = i % 2 ? '#59606a' : '#6d7580'; dg.fillRect(0, i * 16, 64, 16); dg.fillStyle = '#3b4048'; dg.fillRect(0, i * 16, 64, 2); }
    // Overspray along the bottom slats: the one honest advertisement on the building.
    const cols = ['#e4572e', '#f0a202', '#2a9d8f', '#f2e8cf'];
    for (let i = 0; i < 26; i++) { dg.globalAlpha = 0.35; dg.fillStyle = cols[i % 4]; dg.beginPath(); dg.arc((i * 37) % 64, 236 - ((i * 13) % 40), 5 + (i % 5), 0, TAU); dg.fill(); }
    const dmap = new THREE.CanvasTexture(dc);
    dmap.colorSpace = THREE.SRGBColorSpace;
    const shutter = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.3, 0.1), new THREE.MeshStandardMaterial({ map: dmap, roughness: 0.55, metalness: 0.5 }));
    shutter.position.set(0, 1.65, 0.05);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(5.0, 3.5, 0.06), new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8 }));
    frame.position.set(0, 1.75, 0.02);
    grp.add(frame, shutter);
  } else if (!wall) {
    for (const sx of [-2.9, 2.9]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 8), new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.6 }));
      post.position.set(sx, 1.8, 0.08);
      grp.add(post);
    }
  }
  grp.traverse((o) => { o.castShadow = false; o.receiveShadow = true; });
  game.scene.add(grp);
}

/**
 * The Patrol's helicopter: built from primitives, flown on a circle. It arrives from over the
 * water and leaves the same way, so it is never simply there.
 */
export class Heli {
  x = 0; y = 0; z = 0;
  /** Where the spotlight is resting on the ground. */
  spotX = 0; spotZ = 0;
  /** In the sky at all (arriving, circling or leaving). */
  present = false;
  /** Close enough and settled enough to be watching. */
  onStation = false;

  private readonly body = new THREE.Group();
  private readonly rotor: THREE.Object3D;
  private readonly tailRotor: THREE.Object3D;
  private readonly cone: THREE.Mesh;
  private readonly pool: THREE.Mesh;
  private readonly coneMat: THREE.MeshBasicMaterial;
  private readonly poolMat: THREE.MeshBasicMaterial;
  private readonly strobe: THREE.Sprite;
  private ang = 0;
  /** Its heading. */
  h = 0;
  private leaving = false;
  private cx = 0; private cz = 0;
  /**
   * Multiplayer guest (src/net/police.ts): this is the host's helicopter, shown here. It is not flown: show() says
   * where the host has it a few times a second and follow() glides between.
   */
  shown = false;
  private readonly from = { x: 0, y: 0, z: 0, h: 0 };
  private readonly to = { x: 0, y: 0, z: 0, h: 0 };
  private gotAt = 0; private span = 400; private drawnAt = 0; private drawnH = 0;
  private readonly up = new THREE.Vector3(0, -1, 0);
  private readonly dir = new THREE.Vector3();

  constructor(private readonly game: Game) {
    const navy = new THREE.MeshStandardMaterial({ color: 0x14213d, roughness: 0.35, metalness: 0.5 });
    const bone = new THREE.MeshStandardMaterial({ color: 0xf2e8cf, roughness: 0.5, metalness: 0.1 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.08, metalness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.6, metalness: 0.4 });
    const b = this.body;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = b): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const cabin = add(new THREE.SphereGeometry(1, 20, 14), navy, 0, 0, 0);
    cabin.scale.set(1.05, 1.0, 2.1);
    const nose = add(new THREE.SphereGeometry(1, 18, 12, 0, TAU, 0, Math.PI * 0.55), glass, 0, 0.12, 0.62);
    nose.scale.set(0.97, 0.9, 1.62);
    nose.rotation.x = Math.PI / 2;
    const stripe = add(new THREE.BoxGeometry(2.14, 0.22, 2.2), bone, 0, -0.18, -0.35);
    stripe.castShadow = false;
    const boom = add(new THREE.CylinderGeometry(0.34, 0.12, 4.6, 10), navy, 0, 0.25, -3.9);
    boom.rotation.x = Math.PI / 2;
    add(new THREE.BoxGeometry(0.1, 1.5, 0.8), navy, 0, 0.85, -6.0).rotation.x = -0.35;
    add(new THREE.BoxGeometry(1.7, 0.07, 0.5), navy, 0, 0.3, -5.5);
    add(new THREE.CylinderGeometry(0.42, 0.5, 0.5, 10), dark, 0, 1.12, -0.2);
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), dark, 0, 1.5, -0.2);
    for (const sx of [-0.95, 0.95]) {
      add(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 6), dark, sx, -1.35, 0.1).rotation.x = Math.PI / 2;
      for (const sz of [-0.8, 0.9]) add(new THREE.CylinderGeometry(0.04, 0.04, 0.75, 5), dark, sx * 0.86, -1.02, sz).rotation.z = sx > 0 ? 0.3 : -0.3;
    }
    // The lamp under the chin.
    add(new THREE.CylinderGeometry(0.2, 0.26, 0.3, 10), dark, 0, -1.0, 1.2);

    this.rotor = new THREE.Group();
    this.rotor.position.set(0, 1.76, -0.2);
    const blade = new THREE.BoxGeometry(10.6, 0.04, 0.3);
    add(blade, dark, 0, 0, 0, this.rotor).castShadow = false;
    const b2 = add(blade, dark, 0, 0, 0, this.rotor);
    b2.rotation.y = Math.PI / 2; b2.castShadow = false;
    // A faint disc so the rotor still reads when the blades strobe against the frame rate.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.3, 28), new THREE.MeshBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2;
    this.rotor.add(disc);
    b.add(this.rotor);

    this.tailRotor = new THREE.Group();
    this.tailRotor.position.set(0.16, 0.95, -6.05);
    add(new THREE.BoxGeometry(0.03, 1.5, 0.14), dark, 0, 0, 0, this.tailRotor).castShadow = false;
    add(new THREE.BoxGeometry(0.03, 0.14, 1.5), dark, 0, 0, 0, this.tailRotor).castShadow = false;
    b.add(this.tailRotor);

    this.strobe = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff3020, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.strobe.position.set(0, -1.25, -1.0);
    b.add(this.strobe);

    const cg = new THREE.ConeGeometry(1, 1, 28, 1, true);
    cg.translate(0, -0.5, 0);
    this.coneMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.cone = new THREE.Mesh(cg, this.coneMat);
    this.cone.renderOrder = 4;
    this.cone.frustumCulled = false;
    this.poolMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const pg = new THREE.CircleGeometry(1, 36);
    pg.rotateX(-Math.PI / 2);
    this.pool = new THREE.Mesh(pg, this.poolMat);
    this.pool.renderOrder = 4;
    b.visible = this.cone.visible = this.pool.visible = false;
    game.scene.add(b, this.cone, this.pool);
  }

  /** Call it out over the player. It starts half a kilometer off and flies in. */
  summon(px: number, pz: number): void {
    if (this.present && !this.leaving) return;
    if (!this.present) {
      this.ang = (this.game.time * 0.37) % TAU;
      this.x = px + Math.sin(this.ang) * 520; this.z = pz + Math.cos(this.ang) * 520; this.y = 110;
      this.cx = px; this.cz = pz;
      this.spotX = this.x; this.spotZ = this.z;
    }
    this.present = true; this.leaving = false;
  }

  dismiss(): void { if (this.present) this.leaving = true; }

  /** (px, pz): the player. track: the crew can see the player, so the lamp follows; otherwise it sweeps where they were last seen (kx, kz). */
  update(dt: number, px: number, pz: number, track: boolean, kx: number, kz: number): void {
    if (!this.present) return;
    const R = 40, ALT = 46;
    this.onStation = false;
    let tx: number, tz: number, ty: number;
    if (this.leaving) {
      // Straight out along whatever bearing it is on, climbing.
      tx = this.x + Math.sin(this.h) * 100; tz = this.z + Math.cos(this.h) * 100; ty = 120;
      const dx = this.x - px, dz = this.z - pz;
      if (dx * dx + dz * dz > 560 * 560) { this.hide(); return; }
    } else {
      this.cx = damp(this.cx, px, 1.2, dt); this.cz = damp(this.cz, pz, 1.2, dt);
      const dx = this.x - this.cx, dz = this.z - this.cz, d = Math.hypot(dx, dz);
      if (d < R + 25) {
        this.onStation = true;
        this.ang = Math.atan2(dx, dz) + 0.5;
      } else this.ang = Math.atan2(dx, dz);
      // On station it holds the circle; closing in from outside it flies straight at the middle.
      const rr = this.onStation ? R : Math.min(d, R);
      tx = this.cx + Math.sin(this.ang) * rr; tz = this.cz + Math.cos(this.ang) * rr;
      ty = groundAt(this.cx, this.cz) + ALT;
    }
    const ddx = tx - this.x, ddz = tz - this.z, dd = Math.hypot(ddx, ddz) || 1;
    const sp = this.leaving ? 60 : clamp(dd * 1.1, 8, 62);
    this.x += (ddx / dd) * Math.min(dd, sp * dt); this.z += (ddz / dd) * Math.min(dd, sp * dt);
    this.y = damp(this.y, ty, 0.9, dt);
    let dh = Math.atan2(ddx, ddz) - this.h;
    dh -= Math.round(dh / TAU) * TAU;
    const turn = clamp(dh, -1.6 * dt, 1.6 * dt);
    this.h += turn;
    this.pose(dt, turn / Math.max(dt, 1e-4));

    // The lamp: quick to follow someone it can see, a slow sweep when it cannot.
    const sweep = this.game.time * 0.9;
    const gx = track ? px : kx + Math.sin(sweep) * 16, gz = track ? pz : kz + Math.cos(sweep * 0.83) * 16;
    this.lamp(dt, gx, gz, track ? 34 : 14);
  }

  /** The airframe where (x, y, z, h) says, banked for `rate` rad/s of turn; blades and strobe a frame on. */
  private pose(dt: number, rate: number): void {
    const b = this.body;
    b.visible = true;
    b.position.set(this.x, this.y, this.z);
    b.rotation.set(0.12, this.h, 0, 'YXZ');
    b.rotation.z = clamp(-rate * 0.22, -0.4, 0.4);
    this.rotor.rotation.y += dt * 31;
    this.tailRotor.rotation.x += dt * 47;
    this.strobe.scale.setScalar((this.game.time * 1.3) % 1 < 0.12 ? 2.4 : 0.01);
  }

  /** Walk the lamp toward (gx, gz) at `speed` m/s and draw the beam (at night, on station). */
  private lamp(dt: number, gx: number, gz: number, speed: number): void {
    const night = this.game.sky.night;
    if (!this.onStation) {
      // In transit the lamp is off and rides underneath, so it comes on pointing down, not at wherever it was last.
      this.spotX = this.x; this.spotZ = this.z;
    } else {
      const sx = gx - this.spotX, sz = gz - this.spotZ, sd = Math.hypot(sx, sz) || 1;
      const sv = Math.min(sd, speed * dt);
      this.spotX += (sx / sd) * sv; this.spotZ += (sz / sd) * sv;
    }
    const lit = night > 0.25 && this.onStation;
    this.cone.visible = this.pool.visible = lit;
    if (lit) {
      const gy = groundAt(this.spotX, this.spotZ) + 0.12;
      const ox = this.x + Math.sin(this.h) * 1.2, oy = this.y - 1.1, oz = this.z + Math.cos(this.h) * 1.2;
      this.dir.set(this.spotX - ox, gy - oy, this.spotZ - oz);
      const len = this.dir.length();
      this.dir.multiplyScalar(1 / len);
      this.cone.position.set(ox, oy, oz);
      this.cone.quaternion.setFromUnitVectors(this.up, this.dir);
      const r = 6.5;
      this.cone.scale.set(r, len, r);
      this.pool.position.set(this.spotX, gy, this.spotZ);
      this.pool.scale.setScalar(r);
      this.coneMat.opacity = 0.085 * night;
      this.poolMat.opacity = 0.2 * night;
    }
  }

  /** The lamp's beam is drawn (for the tests). */
  get lit(): boolean { return this.present && this.cone.visible; }
  /** Flying off. */
  get away(): boolean { return this.present && this.leaving; }
  /** The middle of the circle it is flying, or making for. */
  get midX(): number { return this.cx; }
  get midZ(): number { return this.cz; }

  // ── Multiplayer (src/net/police.ts) ─────────────────────────────────────────

  /**
   * Guest: the host has it here (`now`: performance.now(); `every`: ms between two words of it). The first word is
   * taken as it stands; after that it glides to each new one in the time the next should take to come. (Not in the
   * time the last one took: a late word would then be flown to slowly as well, and it would fall further behind.)
   */
  show(now: number, x: number, y: number, z: number, h: number, onStation: boolean, every: number): void {
    if (!this.present || !this.shown) {
      // (A private one that was in this sky is not flown across town to meet it.)
      this.x = x; this.y = y; this.z = z; this.h = h;
      this.spotX = x; this.spotZ = z;
      this.drawnAt = now; this.drawnH = h;
    } else this.glide(now);
    // From where the glide has got to by now, drawn or not: a page that draws less often than the words come
    // (each one landing just before a frame) would otherwise start every glide again from where it last drew, and
    // never get anywhere.
    const a = this.from, b = this.to;
    a.x = this.x; a.y = this.y; a.z = this.z; a.h = this.h;
    b.x = x; b.y = y; b.z = z; b.h = h;
    this.gotAt = now; this.span = every;
    this.present = true; this.shown = true; this.leaving = false; this.onStation = onStation;
  }

  /** Where the glide is at `now`: a little past the last word if the next is late, so it does not stop dead in the air. */
  private glide(now: number): void {
    const a = this.from, b = this.to;
    const f = Math.min((now - this.gotAt) / this.span, 1.4);
    this.x = a.x + (b.x - a.x) * f; this.y = a.y + (b.y - a.y) * f; this.z = a.z + (b.z - a.z) * f;
    let dh = b.h - a.h;
    dh -= Math.round(dh / TAU) * TAU;
    this.h = a.h + dh * Math.min(f, 1);
  }

  /** Guest, every frame: glide on toward where the host last had it, lamp on (gx, gz). fast: the lamp is on somebody, not sweeping. */
  follow(dt: number, gx: number, gz: number, fast: boolean): void {
    if (!this.present) return;
    // By the wall clock, as the frames arrive by it.
    const now = performance.now();
    this.glide(now);
    let turn = this.h - this.drawnH;
    turn -= Math.round(turn / TAU) * TAU;
    const wall = Math.max(0.004, (now - this.drawnAt) / 1000);
    this.drawnAt = now; this.drawnH = this.h;
    this.pose(dt, clamp(turn / wall, -1.6, 1.6));
    this.lamp(dt, gx, gz, fast ? 34 : 18);
  }

  /** Becoming a guest: whatever is in the sky here is the host's from now on, if the host has one (hide() if not). */
  lend(now: number): void {
    if (!this.present) return;
    const a = this.from, b = this.to;
    a.x = b.x = this.x; a.y = b.y = this.y; a.z = b.z = this.z; a.h = b.h = this.h;
    this.gotAt = this.drawnAt = now; this.drawnH = this.h;
    this.shown = true; this.leaving = false;
  }

  /** No longer a guest: the helicopter shown here is this browser's to fly, from where it is. */
  takeOver(): void {
    if (!this.shown) return;
    this.shown = false; this.leaving = false;
    if (!this.present) return;
    // On station the lamp is on whoever it was after; on the way in, they are somewhere ahead.
    if (this.onStation) { this.cx = this.spotX; this.cz = this.spotZ; }
    else { this.cx = this.x + Math.sin(this.h) * 120; this.cz = this.z + Math.cos(this.h) * 120; }
  }

  /** Gone from this sky at once (guest: the host has none). */
  hide(): void {
    this.present = this.onStation = this.shown = this.leaving = false;
    this.body.visible = this.cone.visible = this.pool.visible = false;
  }
}
