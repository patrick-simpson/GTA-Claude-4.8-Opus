// Rare weather, part one (fun queue item 8): now and then a tornado comes down out of a green sky and wanders across an
// open part of the island or the mainland for a minute and a half, picking up cars, bins, benches and people, spinning
// them round and throwing them out. Rare, survivable and loud.
//
// WHEN. Absolute game time (world/stormSky.ts absHours) is cut into EP-hour episodes; a seeded hash of the episode says
// whether it has a tornado (P, about twice a real day of play), when in the episode it touches down, which open place
// it crosses, its heading and its wobble. Everything about the funnel (where it is, how far down it reaches) is a pure
// function of that clock, so in a shared town every screen has the same funnel in the same place with no messages.
// What it does to things is done by each browser to what that browser owns (its own cars, its walkers when it is the
// host or alone, its player); the rest arrives through the usual multiplayer channels.
//
// TIMELINE (game hours from touchdown; a game hour is a real minute): -0.6 the sky starts to turn green and the rain
// comes; -0.4 the sirens start and the radio's warning is read out; 0 the funnel comes down (five seconds); D it lifts
// again; D + 0.5 the sky has cleared.
//
// LOOK. Six nested shells of an open cylinder bent into a funnel in the vertex shader (narrow at the ground, flaring
// into the cloud base, leaning and snaking), each with scrolling noise in the fragment shader at its own spin; a dark
// rotating wall cloud on top; a short wide dust skirt at the ground; a ring of debris (one instanced box mesh, its
// matrices rewritten each frame and registered with core/flip.ts); and whatever it has picked up.
//
// SURVIVABLE. Nobody is killed by it: walkers are knocked down with the soft fall (never a hard one) and thrown as
// ragdolls; the player is thrown and gets up (player.knockDown hurts nobody; kid mode, core/kid.ts, keeps it so even
// when she lands). Cars go up and come down hard but the player's own car is lifted only a few metres.
//
// COST when there is no tornado: one hash on an episode change and a comparison; every mesh is hidden.
//
// Test hook: `__storm.tornado.start()` (at the player) or `.start(x, z)`; `.stop()`.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vehicle, WorldPart, Person } from '../core/api';
import type { Prop } from './collide';
import { flip } from '../core/flip';
import { kid } from '../core/kid';
import { clamp01, smooth } from '../core/util';
import { groundAt } from './plan';
import { absHours, capClimb, hash01, nudgeCar, stormSky } from './stormSky';
import { StormSound } from '../audio/storm';

/** Episode length, game hours. */
const EP = 4;
/** Chance an episode has a tornado: about 1.8 a real day of play. */
const P = 1 / 200;
const SALT = 81731;
/** On the ground this long, game hours (96 real seconds at the default rate). */
const D = 1.6;
const BUILD = 0.6, WARN = 0.4, CLEAR = 0.5;
/** Track length over the ground, m. */
const TRACK = 700;
/** Funnel height to the cloud base, its radius at the ground and at the top. */
const H = 240, R_BOT = 9, R_TOP = 70;
/** Reach on cars and props, m. */
const CAP = 30;

interface Place { name: string; x: number; z: number }
/** Open places it crosses: parks, fields, yards and meadows, and two that bring it near busy streets. */
const PLACES: Place[] = [
  { name: 'Mercy Park', x: 195, z: -120 },
  { name: 'Flounder Field', x: -480, z: -70 },
  { name: 'the suburbs', x: -150, z: -330 },
  { name: 'the container yard', x: 445, z: 290 },
  { name: 'the rail yard in Tepid Falls', x: -100, z: -1950 },
  { name: 'Lesser Tepid', x: 525, z: -1350 },
  { name: 'the Exits', x: -640, z: -1300 },
  { name: 'Main Street, Tepid Falls', x: -30, z: -1500 },
];

interface Event {
  t0: number; place: Place; dx: number; dz: number; phi: number; forced: boolean;
}

interface Carried {
  kind: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  a: number; r: number; h: number; t: number; fling: number; free: boolean; rest: number;
  rx: number; ry: number; rz: number; sx: number; sy: number; sz: number;
}

const FUNNEL_VERT = /* glsl */ `
uniform float uTime, uH, uRb, uRt, uScale, uLeanX, uLeanZ;
varying float vT, vAng;
varying vec3 vN, vView;
#include <common>
#include <fog_pars_vertex>
void main() {
  float t = position.y + 0.5;
  float ang = atan(position.z, position.x);
  float r = mix(uRb, uRt, pow(t, 2.4)) * uScale;
  r *= 1.0 + 0.07 * sin(ang * 3.0 + t * 9.0 - uTime * 2.3) + 0.05 * sin(ang * 5.0 - t * 14.0 + uTime * 1.7);
  vec2 off = vec2(uLeanX, uLeanZ) * pow(t, 1.5)
    + vec2(sin(t * 5.0 + uTime * 0.7), cos(t * 4.0 + uTime * 0.6)) * (1.0 - t) * 4.0;
  vec3 p = vec3(cos(ang) * r + off.x, t * uH, sin(ang) * r + off.y);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vN = vec3(cos(ang), 0.0, sin(ang));
  vView = cameraPosition - wp.xyz;
  vT = t; vAng = ang;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FUNNEL_FRAG = /* glsl */ `
uniform float uTime, uSpin, uAlpha, uDown, uSeed, uDustH, uFloor;
uniform vec3 uCol, uDust;
uniform sampler2D uNoise;
varying float vT, vAng;
varying vec3 vN, vView;
#include <common>
#include <fog_pars_fragment>
void main() {
  float u = vAng / 6.2831853 + uTime * uSpin * (1.3 - vT * 0.8) + uSeed;
  float v = vT * 2.2 - uTime * 0.22;
  float n = texture2D(uNoise, vec2(u * 2.0, v)).r * 0.6 + texture2D(uNoise, vec2(u * 5.0 + 0.3, v * 2.7)).g * 0.4;
  float streak = texture2D(uNoise, vec2(u * 3.0 + vT * 0.6, vT * 0.15 - uTime * 0.05)).r;
  float a = mix(uFloor, 1.0, smoothstep(0.22, 0.62, n * 0.75 + streak * 0.4));
  float sil = 1.0 - abs(dot(normalize(vN), normalize(vView)));
  a *= mix(0.5, 1.0, sil);
  float bottom = (1.0 - uDown) * 0.9;
  a *= smoothstep(bottom, bottom + 0.05, vT) * (1.0 - smoothstep(0.9, 1.0, vT));
  vec3 col = mix(uDust, uCol, smoothstep(0.0, uDustH, vT));
  col *= 0.7 + 0.55 * n;
  gl_FragColor = vec4(col, a * uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const CLOUD_VERT = /* glsl */ `
varying vec2 vP;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const CLOUD_FRAG = /* glsl */ `
uniform float uTime, uAlpha, uR;
uniform vec3 uCol;
uniform sampler2D uNoise;
varying vec2 vP;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r = length(vP) / uR;
  float ang = atan(vP.y, vP.x) / 6.2831853;
  float sw = ang + uTime * 0.02 / (0.15 + r) ;
  float n = texture2D(uNoise, vec2(sw * 3.0, r * 1.6 - uTime * 0.01)).r * 0.65 + texture2D(uNoise, vec2(sw * 7.0, r * 4.0)).g * 0.35;
  float a = (1.0 - smoothstep(0.55, 1.0, r)) * smoothstep(0.25, 0.6, n + 0.25 * (1.0 - r));
  gl_FragColor = vec4(uCol * (0.7 + 0.5 * n), a * uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Sizes and colours of what it can carry: debris bits, then bin, bench, mailbox, cone. */
const KINDS = [
  { s: [0.5, 0.06, 0.4], c: 0x5a4a3a }, { s: [0.62, 0.95, 0.62], c: 0x2f4a33 }, { s: [1.8, 0.5, 0.62], c: 0x6b4a2e },
  { s: [0.5, 1.1, 0.45], c: 0x24427a }, { s: [0.38, 0.7, 0.38], c: 0xe36a1c },
];
const PROP_KIND: Partial<Record<Prop['kind'], number>> = { bin: 1, bench: 2, mailbox: 3, cone: 4 };
const MAX_CARRY = 28;

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3();

export class Tornado implements WorldPart {
  readonly stats = { active: false, phase: 0, x: 0, z: 0, place: '', cars: 0, people: 0, props: 0, ms: 0 };
  private readonly root = new THREE.Group();
  private readonly shells: THREE.Mesh[] = [];
  private readonly shellU: Record<string, THREE.IUniform>[] = [];
  private readonly skirt: THREE.Mesh;
  private readonly skirtU: Record<string, THREE.IUniform>;
  private readonly cloud: THREE.Mesh;
  private readonly cloudU: Record<string, THREE.IUniform>;
  private readonly debris: THREE.InstancedMesh;
  private readonly carryMesh: THREE.InstancedMesh;
  private readonly nDebris: number;
  private readonly carried: Carried[] = [];
  private readonly sound: StormSound;
  private ep = NaN;
  private evs: Event[] = [];
  private forced: Event | null = null;
  private warned = -1;
  private time = 0;
  private readonly caught = new Map<Vehicle, number>();
  private readonly cool = new Map<object, number>();
  private playerCool = 0;
  private flashT = 3;
  private peds: { walkers: { p: Person; mode: number }[] } | null | undefined;
  private shown = false;

  constructor(private readonly game: Game, parent: THREE.Group) {
    this.root.name = 'tornado';
    this.root.visible = false;
    parent.add(this.root);
    const low = game.quality.name === 'low';
    const noise = game.world.mats.tex.noise;
    const base = (): Record<string, THREE.IUniform> => ({
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uH: { value: H }, uRb: { value: R_BOT }, uRt: { value: R_TOP }, uScale: { value: 1 },
      uLeanX: { value: 0 }, uLeanZ: { value: 0 }, uSpin: { value: 0.3 }, uAlpha: { value: 0.6 }, uDown: { value: 1 },
      uSeed: { value: 0 }, uDustH: { value: 0.12 }, uFloor: { value: 0 }, uCol: { value: new THREE.Color(0x3a4038) }, uDust: { value: new THREE.Color(0x6a5a46) },
      uNoise: { value: noise },
    });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, low ? 24 : 40, low ? 20 : 36, true);
    const layers = low ? [[0.5, 0.9, 0.95], [0.8, 0.6, 0.7], [1.05, 0.35, 0.4]] : [[0.45, 1.0, 0.95], [0.62, 0.8, 0.85], [0.78, 0.62, 0.7], [0.92, 0.45, 0.55], [1.06, 0.3, 0.4], [1.2, 0.2, 0.28]];
    layers.forEach(([scale, spin, alpha], i) => {
      const u = base();
      u.uScale.value = scale; u.uSpin.value = spin; u.uAlpha.value = alpha; u.uSeed.value = i * 0.37; u.uFloor.value = i < 2 ? 0.55 : 0.15;
      const m = new THREE.Mesh(cyl, new THREE.ShaderMaterial({
        uniforms: u, vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG,
        fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      m.frustumCulled = false; m.renderOrder = 2 + i;
      this.shells.push(m); this.shellU.push(u); this.root.add(m);
    });
    // The dust skirt: a squat, wide cone of the same stuff, brown.
    this.skirtU = base();
    Object.assign(this.skirtU, { uH: { value: 34 }, uRb: { value: 34 }, uRt: { value: 16 }, uSpin: { value: 0.9 }, uAlpha: { value: 0.55 }, uDustH: { value: 2 } });
    this.skirt = new THREE.Mesh(cyl, new THREE.ShaderMaterial({
      uniforms: this.skirtU, vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG,
      fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.skirt.frustumCulled = false; this.skirt.renderOrder = 9;
    this.root.add(this.skirt);
    // The wall cloud the funnel hangs from.
    this.cloudU = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uAlpha: { value: 0.95 }, uR: { value: 420 }, uCol: { value: new THREE.Color(0x2a302b) }, uNoise: { value: noise },
    };
    const disc = new THREE.CircleGeometry(420, low ? 32 : 64);
    this.cloud = new THREE.Mesh(disc, new THREE.ShaderMaterial({
      uniforms: this.cloudU, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
      fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    // The disc lies in its own x-y plane (the shader reads those); turned flat here.
    this.cloud.rotation.x = -Math.PI / 2;
    this.cloud.position.y = H - 4;
    this.cloud.frustumCulled = false; this.cloud.renderOrder = 1;
    this.root.add(this.cloud);
    // The debris ring and what it has picked up.
    this.nDebris = low ? 90 : game.quality.name === 'medium' ? 200 : 320;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    this.debris = new THREE.InstancedMesh(box, mat, this.nDebris);
    this.debris.frustumCulled = false; this.debris.castShadow = false;
    const col = new THREE.Color();
    for (let i = 0; i < this.nDebris; i++) {
      const r = hash01(i, 3);
      this.debris.setColorAt(i, col.setHex(r < 0.4 ? 0x4a3d30 : r < 0.7 ? 0x5e6258 : r < 0.85 ? 0x7a6a4c : 0x3d4a32));
    }
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flip.mesh(this.debris);
    this.root.add(this.debris);
    this.carryMesh = new THREE.InstancedMesh(box, mat, MAX_CARRY);
    this.carryMesh.frustumCulled = false; this.carryMesh.count = 0;
    for (let i = 0; i < MAX_CARRY; i++) this.carryMesh.setColorAt(i, col.setHex(0xffffff));
    this.carryMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flip.mesh(this.carryMesh, true);
    parent.add(this.carryMesh);
    this.sound = new StormSound(() => this.game.audio?.core ?? null);
  }

  /** Test hook: a tornado touching down in 24 real seconds near (x, z) (the player when left out). */
  start(x?: number, z?: number): void {
    const g = this.game, pl = g.player;
    const px = x ?? pl.x, pz = z ?? pl.z, a = Math.random() * Math.PI * 2;
    const abs = absHours(g.sky.hour);
    // Start a little off so it comes towards the place.
    this.forced = { t0: abs + WARN, place: { name: 'right here', x: px, z: pz }, dx: Math.cos(a), dz: Math.sin(a), phi: Math.random() * 6, forced: true };
  }

  stop(): void { this.forced = null; this.evs = []; this.ep = NaN; }

  /** The scheduled tornado of episode e, or null. */
  private scheduled(e: number): Event | null {
    if (hash01(e, SALT) >= P) return null;
    const t0 = e * EP + 0.8 + hash01(e, SALT + 1) * (EP - D - 1.6);
    const place = PLACES[Math.floor(hash01(e, SALT + 2) * PLACES.length)];
    const a = hash01(e, SALT + 3) * Math.PI * 2;
    return { t0, place, dx: Math.cos(a), dz: Math.sin(a), phi: hash01(e, SALT + 4) * 6.28, forced: false };
  }

  /** Where the funnel's foot is at track fraction s (0..1). */
  private track(ev: Event, s: number, out: { x: number; z: number }): void {
    const along = (s - 0.5) * TRACK, side = 40 * Math.sin(s * 4.2 + ev.phi) + 12 * Math.sin(s * 11 + ev.phi * 2);
    out.x = ev.place.x + ev.dx * along - ev.dz * side;
    out.z = ev.place.z + ev.dz * along + ev.dx * side;
  }

  private readonly pos = { x: 0, z: 0 };
  private readonly pos2 = { x: 0, z: 0 };

  update(dt: number): void {
    const g = this.game, sky = g.sky;
    if (!sky || !g.vehicles) return;
    const t0 = performance.now();
    const abs = absHours(sky.hour);
    const e = Math.floor(abs / EP);
    if (e !== this.ep) {
      this.ep = e;
      // An event can run past the end of its episode: the one before may still be on.
      this.evs = [this.scheduled(e - 1), this.scheduled(e)].filter((x): x is Event => x !== null);
    }
    let ev: Event | null = this.forced;
    if (!ev) for (const c of this.evs) if (abs - c.t0 >= -BUILD && abs - c.t0 <= D + CLEAR) ev = c;
    const ph = ev ? abs - ev.t0 : -99;
    if (!ev || ph < -BUILD || ph > D + CLEAR) {
      if (this.forced && ph > D + CLEAR) this.forced = null;
      if (this.shown) this.hide();
      this.updateCarried(dt);
      this.sound.update(dt, { siren: 0, roar: 0, rain: 0 });
      this.stats.ms = performance.now() - t0;
      return;
    }
    this.shown = true;
    this.time += dt;
    const st = this.stats;
    st.active = true; st.phase = ph; st.place = ev.place.name;
    // ── Sky ──
    const storm = smooth((ph + BUILD) / (BUILD - 0.2)) * (1 - smooth((ph - D) / CLEAR));
    stormSky(g).set('tornado', { green: storm, dark: storm * 0.5, rain: storm * 0.95 });
    if (!sky.led && storm > 0.5 && sky.weather !== 'rain' && sky.weather !== 'snow') sky.setWeather('rain');
    // ── Warning ──
    const key = Math.round(ev.t0 * 100);
    if (ph > -WARN && ph < D && this.warned !== key) {
      this.warned = key;
      g.hud?.toast(`RADIO: The weather service has issued a TORNADO WARNING for ${ev.place.name}. Take shelter now. If you are already outside, it is too late to look dignified.`, 8);
      this.sound.alert(3);
    }
    // ── Funnel ──
    const s = clamp01(ph / D);
    this.track(ev, s, this.pos);
    this.track(ev, Math.min(1, s + 0.01), this.pos2);
    const fx = this.pos.x, fz = this.pos.z;
    // Velocity of the foot over the ground, m/s: metres per game hour times game hours per second.
    const tvx = ((this.pos2.x - fx) / (0.01 * D)) * sky.rate, tvz = ((this.pos2.z - fz) / (0.01 * D)) * sky.rate;
    const gy = groundAt(fx, fz);
    // Down over five seconds, up again over eight.
    const down = ph < 0 ? 0 : smooth(ph / 0.09) * (1 - smooth((ph - D + 0.14) / 0.14));
    st.x = fx; st.z = fz;
    this.root.visible = storm > 0.02;
    this.root.position.set(fx, gy - 2, fz);
    const lean = 50 + 20 * Math.sin(this.time * 0.13);
    const hemi = (sky as unknown as { hemi?: THREE.HemisphereLight }).hemi;
    const lum = hemi ? Math.max(0.05, hemi.intensity * (hemi.color.r + hemi.color.g + hemi.color.b) / 3) : 0.6;
    const k = Math.min(1.2, 0.25 + lum * 0.55);
    for (let i = 0; i < this.shellU.length; i++) {
      const u = this.shellU[i];
      u.uTime.value = this.time; u.uDown.value = down;
      u.uLeanX.value = -ev.dx * lean; u.uLeanZ.value = -ev.dz * lean;
      (u.uCol.value as THREE.Color).setRGB(0.13, 0.15, 0.135).multiplyScalar(k * (1 - i * 0.04));
      (u.uDust.value as THREE.Color).setRGB(0.36, 0.3, 0.23).multiplyScalar(k);
    }
    const su = this.skirtU;
    su.uTime.value = this.time; su.uDown.value = 1;
    su.uAlpha.value = 0.6 * smooth((down - 0.6) / 0.4);
    (su.uDust.value as THREE.Color).setRGB(0.42, 0.35, 0.26).multiplyScalar(k);
    (su.uCol.value as THREE.Color).setRGB(0.42, 0.35, 0.26).multiplyScalar(k);
    this.skirt.visible = down > 0.6;
    this.cloudU.uTime.value = this.time;
    this.cloudU.uAlpha.value = 0.95 * storm;
    (this.cloudU.uCol.value as THREE.Color).setRGB(0.16, 0.19, 0.165).multiplyScalar(k);
    this.cloud.position.set(-ev.dx * lean, H - 4, -ev.dz * lean);
    // Lightning now and then, from the clock so every screen flashes together.
    const fl = Math.floor(abs * 60 / 5);
    if (storm > 0.6 && hash01(fl, SALT + 9) < 0.35 && this.flashT !== fl) { this.flashT = fl; stormSky(g).flash = 1; }
    // ── The debris ring ──
    const cam = g.camera.position;
    const camD = Math.hypot(cam.x - fx, cam.z - fz);
    this.debris.visible = down > 0.5 && camD < 1400;
    if (this.debris.visible) this.ring(down);
    // ── What it picks up ──
    if (down > 0.5) {
      this.cars(fx, fz, gy, tvx, tvz, dt);
      this.people(fx, fz, gy, dt);
      if (camD < 700) this.props(fx, fz);
    } else this.caught.clear();
    this.updateCarried(dt, fx, fz, gy, down);
    // ── Sound ──
    const roar = down * Math.pow(clamp01(1 - camD / 900), 1.6);
    const siren = smooth((ph + WARN) / 0.05) * (1 - smooth((ph - D) / 0.2)) * (camD < 1500 ? 1 : 0.4);
    this.sound.update(dt, { siren, roar, rain: storm * 0.8 });
    if (this.playerCool > 0) this.playerCool -= dt;
    st.ms = performance.now() - t0;
  }

  private hide(): void {
    this.shown = false;
    this.root.visible = false;
    this.caught.clear();
    this.stats.active = false;
    stormSky(this.game).set('tornado', null);
  }

  /** Swirling bits: each one climbs a spiral and is spat out at the top of its climb. */
  private ring(down: number): void {
    const t = this.time, n = this.nDebris;
    for (let i = 0; i < n; i++) {
      const h0 = hash01(i, 11), h1 = hash01(i, 12), h2 = hash01(i, 13);
      const cyc = 6 + h1 * 8;
      const u = ((t / cyc + h0) % 1);
      const y = u * (20 + h2 * 70) * down;
      const r = 6 + h1 * 22 + u * u * 26;
      const a = h2 * 6.283 + t * (2.2 + 18 / r) + u * 3;
      const sc = (0.25 + h0 * h0 * 1.4) * (1 - smooth((u - 0.85) / 0.15));
      E.set(t * (1 + h0 * 4), t * (2 + h1 * 3), t * h2 * 3);
      Q.setFromEuler(E);
      V.set(Math.cos(a) * r, y + 1, Math.sin(a) * r);
      S.set(sc, sc * (0.2 + h1 * 0.6), sc * (0.4 + h2));
      M.compose(V, Q, S);
      this.debris.setMatrixAt(i, M);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }

  /** Cars: swirl, lift, spin, and after a few seconds thrown out. Only this browser's own. */
  private cars(fx: number, fz: number, gy: number, tvx: number, tvz: number, dt: number): void {
    const g = this.game, mine = g.player.vehicle;
    let n = 0;
    for (const [v, c] of this.cool) { const left = c - dt; if (left <= 0) this.cool.delete(v); else this.cool.set(v, left); }
    for (const v of g.vehicles.list) {
      if (v.shared || v.removed || v.sunk) continue;
      const dx = v.x - fx, dz = v.z - fz, r = Math.hypot(dx, dz);
      if (r > CAP || this.cool.has(v)) { if (this.caught.has(v)) this.caught.delete(v); continue; }
      const up = v.y - gy;
      if (up > 50) continue;
      n++;
      const held = (this.caught.get(v) ?? 0) + dt;
      this.caught.set(v, held);
      const nx = dx / Math.max(r, 0.1), nz = dz / Math.max(r, 0.1);
      const f = 1 - r / CAP;
      const vt = 26 * Math.min(1, r / 10) * (0.4 + 0.6 * f);
      // Counter-clockwise seen from above, as in the northern hemisphere; inflow at the ground.
      const wx = -nz * vt - nx * 7 * f + tvx, wz = nx * vt - nz * 7 * f + tvz;
      const kk = Math.min(1, (1.2 + 2.5 * f) * dt);
      v.vx += (wx - v.vx) * kk; v.vz += (wz - v.vz) * kk;
      const maxUp = v === mine ? 7 : 14 + hash01(v.id, 5) * 16;
      const lift = up < maxUp ? 9.81 * (1.05 + 1.1 * f) : 9.81 * 0.9;
      // On its wheels the ground holds it until it has been swirled a moment; then it is plucked off.
      if (v.onGround) { if (held > 0.6 + hash01(v.id, 9)) nudgeCar(v, 5 + 4 * f, 0.3); }
      else nudgeCar(v, lift * dt, 0, Math.sin(this.time * 3 + v.id) * 3 * dt);
      if (up > maxUp) capClimb(v, 1.5);
      v.yawRate = 2.5 + 3 * f;
      if (!v.onGround) v.roll += Math.cos(this.time * 2.3 + v.id) * 2 * dt;
      // Thrown out after a while, hard and high.
      if (held > (v === mine ? 2.5 : 3 + hash01(v.id, 6) * 4)) {
        const out = v === mine ? 9 : 18 + hash01(v.id, 7) * 10;
        v.vx = nx * out - nz * vt * 0.6; v.vz = nz * out + nx * vt * 0.6;
        nudgeCar(v, v === mine ? 2 : 3 + hash01(v.id, 8) * 5);
        this.caught.delete(v);
        this.cool.set(v, 6);
      }
    }
    this.stats.cars = n;
  }

  /** The player and the walkers: knocked over, lifted and thrown as ragdolls. Nobody is hurt for good. */
  private people(fx: number, fz: number, gy: number, dt: number): void {
    const g = this.game, pl = g.player, rag = g.people?.rag;
    if (!rag) return;
    void dt;
    if (!pl.vehicle && this.playerCool <= 0) {
      const dx = pl.x - fx, dz = pl.z - fz, r = Math.hypot(dx, dz);
      if (r < 22 && pl.person.y - gy < 20) {
        const nx = dx / Math.max(r, 0.1), nz = dz / Math.max(r, 0.1);
        pl.knockDown(-nz * 13 + nx * 5, nx * 13 + nz * 5, 9 + (1 - r / 22) * 4);
        this.playerCool = 5;
        this.stats.people++;
      }
    }
    // Walkers belong to this browser when it is alone or the host; their sim is found the way weapons.ts finds it.
    if (this.peds === undefined) {
      this.peds = null;
      for (const s of g.systems) { const a = s as { peds?: { walkers?: unknown } }; if (a.peds && Array.isArray(a.peds.walkers)) { this.peds = a.peds as never; break; } }
    }
    const peds = this.peds as unknown as { walkers: { p: Person }[]; fall?: (w: unknown, cvx: number, cvz: number, sp: number, by: boolean) => void } | null;
    if (!peds) return;
    let thrown = 0;
    for (const w of peds.walkers) {
      const p = w.p;
      if (!p.visible || this.cool.has(p)) continue;
      const dx = p.x - fx, dz = p.z - fz;
      if (dx * dx + dz * dz > 18 * 18) continue;
      if (thrown >= 2 || !rag.canTake(p)) continue;
      const r = Math.hypot(dx, dz), nx = dx / Math.max(r, 0.1), nz = dz / Math.max(r, 0.1);
      const cvx = -nz * 5.5, cvz = nx * 5.5;
      // The soft fall (under peds.ts HARD): down, a flight, up again.
      if (typeof peds.fall === 'function') peds.fall.call(peds, w, cvx, cvz, 5.5, false);
      rag.launch(p, -nz * 9 + nx * 4, 8 + hash01(p.id, 3) * 5, nx * 9 + nz * 4, (hash01(p.id, 4) - 0.5) * 8, 6, (hash01(p.id, 5) - 0.5) * 8, { silly: true });
      if (kid.on) p.health = Math.max(p.health, 10);
      this.cool.set(p, 8);
      thrown++;
      this.stats.people++;
    }
  }

  /** Bins, benches, mailboxes and cones in its path are torn up and carried round. */
  private props(fx: number, fz: number): void {
    const g = this.game;
    g.col.forProps(fx, fz, 20, (p) => {
      const kind = PROP_KIND[p.kind];
      // (Benches are not `breakable` by a car; a tornado takes them anyway.)
      if (kind === undefined || this.carried.length >= MAX_CARRY) return;
      if (Math.hypot(p.x - fx, p.z - fz) > 20) return;
      g.col.breakProp(p, 0, 0);
      const k = KINDS[kind];
      this.carried.push({
        kind, x: p.x, y: groundAt(p.x, p.z) + k.s[1] / 2, z: p.z, vx: 0, vy: 0, vz: 0,
        a: Math.atan2(p.z - fz, p.x - fx), r: Math.max(3, Math.hypot(p.x - fx, p.z - fz)), h: 0.5, t: 0,
        fling: 3 + Math.random() * 5, free: false, rest: 0,
        rx: 0, ry: 0, rz: 0, sx: k.s[0], sy: k.s[1], sz: k.s[2],
      });
      const col = new THREE.Color(k.c);
      this.carryMesh.setColorAt(this.carried.length - 1, col);
      this.stats.props++;
    });
  }

  private updateCarried(dt: number, fx = 0, fz = 0, gy = 0, down = 0): void {
    const list = this.carried;
    if (!list.length) { if (this.carryMesh.count) { this.carryMesh.count = 0; } return; }
    const col = new THREE.Color();
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      c.t += dt;
      if (!c.free && (c.t > c.fling || down < 0.5)) {
        c.free = true;
        const vt = 20;
        c.vx = Math.cos(c.a) * 14 - Math.sin(c.a) * vt; c.vz = Math.sin(c.a) * 14 + Math.cos(c.a) * vt; c.vy = 5;
      }
      if (!c.free) {
        c.r = Math.max(4, c.r - dt * 1.5);
        c.a += dt * (2 + 20 / c.r);
        c.h = Math.min(40, c.h + dt * 9);
        c.x = fx + Math.cos(c.a) * c.r; c.z = fz + Math.sin(c.a) * c.r; c.y = gy + c.h;
        c.rx += dt * 5; c.ry += dt * 3; c.rz += dt * 4;
      } else if (c.rest <= 0) {
        c.vy -= 9.81 * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
        c.rx += dt * 4; c.rz += dt * 3;
        const ground = groundAt(c.x, c.z) + c.sy / 2;
        if (c.y < ground) {
          c.y = ground;
          if (Math.abs(c.vy) > 4) { c.vy = -c.vy * 0.3; c.vx *= 0.6; c.vz *= 0.6; }
          else { c.rest = 0.001; c.rx = Math.PI / 2; c.rz = 0; }
        }
      } else {
        c.rest += dt;
        if (c.rest > 60) { list.splice(i, 1); continue; }
      }
    }
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      E.set(c.rx, c.ry, c.rz); Q.setFromEuler(E);
      V.set(c.x, c.y, c.z); S.set(c.sx, c.sy, c.sz);
      M.compose(V, Q, S);
      this.carryMesh.setMatrixAt(i, M);
      this.carryMesh.setColorAt(i, col.setHex(KINDS[c.kind].c));
    }
    this.carryMesh.count = list.length;
    this.carryMesh.instanceMatrix.needsUpdate = true;
    if (this.carryMesh.instanceColor) this.carryMesh.instanceColor.needsUpdate = true;
  }
}
