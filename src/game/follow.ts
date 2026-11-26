// Follow me (fun queue 2, item 29): the wheel line 36 lights the sender's car (or the sender on foot) for everybody
// else in town for FOLLOW_S seconds: a pulsing gold halo and a ring on the ground, and a radar badge F. Nothing new
// travels: a receiver sees the phrase index (game/chat.ts heard) and starts its own beacon for that sender. A page that
// does not know line 36 drops it like any other unknown index, so an older page simply shows no beacon.

import * as THREE from 'three';
import type { Remote } from '../net/remote';
import type { Blip } from '../ui/hud';
import { ACC } from '../core/access';

export const FOLLOW_PHRASE = 36;
export const FOLLOW_S = 20;
const FADE_MS = 2000;
const GOLD = '#ffd166';

interface Beacon { id: number; r: Remote; until: number; halo: THREE.Sprite; ring: THREE.Mesh }

function haloTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,240,190,1)');
  grd.addColorStop(0.3, 'rgba(255,209,102,0.7)');
  grd.addColorStop(1, 'rgba(255,209,102,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class FollowBeacons {
  private readonly list: Beacon[] = [];
  private readonly tex: THREE.CanvasTexture;
  private readonly ringGeo = new THREE.RingGeometry(0.8, 1.2, 48);

  constructor(private readonly scene: THREE.Scene) {
    this.tex = haloTexture();
  }

  /** A player said Follow me: light them (or renew the light, if they are already lit). */
  start(r: Remote, now: number): void {
    const until = now + FOLLOW_S * 1000;
    const old = this.list.find((b) => b.id === r.id);
    if (old) { old.until = until; return; }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    halo.name = 'net_follow';
    halo.renderOrder = 22;
    halo.material.color.set(ACC.pal === 'default' ? '#ffffff' : ACC.c.follow);
    this.scene.add(halo);
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: ACC.pal === 'default' ? GOLD : ACC.c.follow, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false }));
    ring.name = 'net_follow_ring';
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 22;
    this.scene.add(ring);
    this.list.push({ id: r.id, r, until, halo, ring });
  }

  /** Each frame: move the lights with their cars, pulse them, and take them down when the time is up or they leave town. */
  private palVer = -1;
  update(now: number, peers: readonly number[]): void {
    // Settings > Accessibility > Marker colours: the light follows the palette (the default is the gold it always was).
    if (this.palVer !== ACC.ver) {
      this.palVer = ACC.ver;
      for (const b of this.list) {
        (b.ring.material as THREE.MeshBasicMaterial).color.set(ACC.pal === 'default' ? GOLD : ACC.c.follow);
        (b.halo.material as THREE.SpriteMaterial).color.set(ACC.pal === 'default' ? '#ffffff' : ACC.c.follow);
      }
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      if (now >= b.until || !peers.includes(b.id) || !b.r.seen) { this.drop(b); this.list.splice(i, 1); continue; }
      const left = b.until - now;
      const pulse = 0.5 + 0.5 * Math.sin(now / 1000 * Math.PI * 2 * 1.2);
      const fade = Math.min(1, left / FADE_MS);
      const r = b.r;
      const h = r.kind ? 3.4 : 2.7;
      b.halo.position.set(r.x, r.y + h, r.z);
      const s = 3.2 + 0.8 * pulse;
      b.halo.scale.set(s, s, 1);
      (b.halo.material as THREE.SpriteMaterial).opacity = (0.5 + 0.4 * pulse) * fade;
      b.ring.position.set(r.x, r.y + 0.35, r.z);
      const rs = 2.2 + 0.6 * pulse;
      b.ring.scale.set(rs, rs, 1);
      (b.ring.material as THREE.MeshBasicMaterial).opacity = (0.35 + 0.45 * pulse) * fade;
    }
  }

  /** The radar: each lit car is an F badge (the mustard one, which the radar keeps for the business in hand). */
  blips(out: Blip[]): void {
    for (const b of this.list) out.push({ x: b.r.x, z: b.r.z, kind: 'goal', label: 'F' });
  }

  info(): { id: number; x: number; z: number; left: number }[] {
    const now = performance.now();
    return this.list.map((b) => ({ id: b.id, x: Math.round(b.r.x), z: Math.round(b.r.z), left: Math.max(0, Math.round((b.until - now) / 100) / 10) }));
  }

  private drop(b: Beacon): void {
    this.scene.remove(b.halo, b.ring);
    (b.halo.material as THREE.SpriteMaterial).dispose();
    (b.ring.material as THREE.MeshBasicMaterial).dispose();
  }
}
