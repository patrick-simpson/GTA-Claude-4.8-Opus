// Weather that changes driving (fun queue 2, item 45): puddles on the road and black ice.
//
//   Wet        rain (Sky.wet) already costs a little grip and braking (ent/vehicle.ts). New: while the road is wet, puddles lie
//              IN the lanes near the player (the same kerb places the mud-season gutter puddles use, set into the lane), growing
//              with the rain and shrinking as it dries. A car through one throws spray (every car), and the player's car,
//              above about 20 mph, gets a brief tug on the wheel; above about 36 mph it aquaplanes: the steering goes light
//              for most of a second and the nose drifts.
//   Black ice  winter only, on cold nights and early mornings (18:30 to about 11:00) on about half the winter nights, picked by
//              the town's clock (Sky day and hour) and the town's weather seed: nothing falls from the sky then, the cold just
//              closes in. The bridge ices first, then shaded spots (about a third of the road patches), then the rest as it
//              deepens. A patch shows only as a faint dark glint. Grip on it is a seventh of normal and the brakes hardly
//              bite. Salt (and the plough) take it away: a lane the plow job (game/plow.ts) has driven has no ice. Traffic
//              slows on a wet or icy night and now and then an AI car slides.
//   Snow       packed snow's grip (1/2) is the same as before, but a plowed lane is bare tarmac (a fifth of the snow's effect)
//              and a salted one is clear.
//
// Everything is a function of the town clock, the season and the weather the sky already shows (no new message, no fact key).
// ?road=wet|ice|dry pins a state (tests; ice also holds a winter night's ice on the bridge and the patches). The HUD's weather
// word gets "· black ice" or "· wet" (ui/hud.ts reads `roads.cond`).

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { WorldPart } from '../core/api';
import { BRIDGE, groundAt, WATER_Y } from './plan';
import { season } from './season';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Share of winter nights that freeze. */
const ICE_NIGHTS = 0.55;
/** The ice level at which the bridge, shaded patches and open patches freeze. */
const T_BRIDGE = 0.12, T_SHADE = 0.35, T_OPEN = 0.8;
/** Grip left on full ice. */
export const ICE_GRIP = 0.14;
/** Seconds the steering stays light after aquaplaning starts. */
export const AQUA_S = 0.85;
const PUD_CAP = 110, ICE_CAP = 110;
const BRIDGE_Z0 = BRIDGE.z0 - 6, BRIDGE_Z1 = BRIDGE.z1 + 6;

/**
 * The ice level (0..1) the clock gives: `day` whole days since the start, `hour` 0..24, `seed` the weather seed. Winter nights
 * freeze about half the time; the cold builds from 18:30 to 22:00, holds, and the morning sun takes it away by 11.
 */
export function iceLevel(day: number, hour: number, seed: number): number {
  const night = hour >= 18.5;
  if (!night && hour >= 11) return 0;
  if (hash(night ? day : day - 1, seed, 31) > ICE_NIGHTS) return 0;
  return night ? clamp01((hour - 18.5) / 3.5) : hour < 7.5 ? 1 : clamp01(1 - (hour - 7.5) / 3.5);
}

/** The state the cars read each step, and the lookups they make. Plain numbers and typed arrays: nothing here allocates. */
export class RoadState {
  /** 0..1: how wet the roads are (rain, or ?road=wet). */
  wet = 0;
  /** 0..1: how hard the black ice has set. */
  ice = 0;
  /** 0..1 slowdown the traffic AI applies (snow, wet roads, ice). */
  ai = 0;
  /** What the HUD shows: 0 nothing, 1 wet, 2 icy. */
  cond = 0;
  /** True while any of it can matter (so a dry summer day costs the cars one comparison). */
  active = false;
  /** ?road= pin, or ''. */
  forced: '' | 'wet' | 'ice' | 'dry' = '';
  // The result of the last sample().
  grip = 1; snowK = 1; puddle = -1; onIce = false;
  /** Tests read these. */
  tugs = 0; skids = 0; splashes = 0;

  // Where the puddles and ice patches are near the player (RoadFx fills these), and the centre they were made for.
  cx = 1e9; cz = 1e9;
  pn = 0; readonly px = new Float32Array(PUD_CAP); readonly pz = new Float32Array(PUD_CAP); readonly pr = new Float32Array(PUD_CAP);
  readonly pLast = new Float32Array(PUD_CAP);
  inn = 0; readonly ix = new Float32Array(ICE_CAP); readonly iz = new Float32Array(ICE_CAP); readonly ir = new Float32Array(ICE_CAP);

  // Lanes the plow job has driven (3 m cells; 1 plowed, 2 salted).
  private readonly mkKey = new Int32Array(32768).fill(-1);
  private readonly mkVal = new Uint8Array(32768);
  private mkN = 0;
  /** Cells marked since the start (a change refills the ice patches). */
  marks = 0;

  private static cell(x: number, z: number): number { return (Math.floor(x / 3) + 4096) * 8192 + (Math.floor(z / 3) + 4096); }

  /** The plow or salt truck passed (x, z) with a blade or spreader hw wide. */
  mark(x: number, z: number, hw: number, kind: 1 | 2): void {
    for (let dx = -hw; dx <= hw + 0.01; dx += 3) for (let dz = -hw; dz <= hw + 0.01; dz += 3) {
      const k = RoadState.cell(x + dx, z + dz);
      let i = (Math.imul(k, 0x9e3779b1) >>> 17) & 32767, n = 0;
      while (this.mkKey[i] !== -1 && this.mkKey[i] !== k && n++ < 64) i = (i + 1) & 32767;
      if (this.mkKey[i] === k) { if (kind > this.mkVal[i]) { this.mkVal[i] = kind; this.marks++; } continue; }
      if (this.mkKey[i] !== -1 || this.mkN > 20000) continue;
      this.mkKey[i] = k; this.mkVal[i] = kind; this.mkN++; this.marks++;
    }
  }

  /** Forget every mark (a new plow job starts on a fresh road). */
  clearMarks(): void { this.mkKey.fill(-1); this.mkVal.fill(0); this.mkN = 0; this.marks++; }

  /** 0 nothing, 1 plowed, 2 salted at (x, z). */
  markAt(x: number, z: number): number {
    if (this.mkN === 0) return 0;
    const k = RoadState.cell(x, z);
    let i = (Math.imul(k, 0x9e3779b1) >>> 17) & 32767, n = 0;
    while (this.mkKey[i] !== -1 && n++ < 64) { if (this.mkKey[i] === k) return this.mkVal[i]; i = (i + 1) & 32767; }
    return 0;
  }

  /** The bridge deck (the Perpetual Bridge's road). */
  static onBridge(x: number, z: number): boolean { return Math.abs(x - BRIDGE.x) <= BRIDGE.hw + 1 && z <= BRIDGE_Z0 && z >= BRIDGE_Z1; }

  /**
   * What the road under (x, z) does to a tire: fills grip (1 normal, ICE_GRIP on full ice, a little under 1 in a puddle),
   * snowK (how much of the snow's slipperiness is here: plowed and salted lanes have little) and puddle (index, or -1).
   */
  sample(x: number, z: number): void {
    this.grip = 1; this.snowK = 1; this.puddle = -1; this.onIce = false;
    const mk = this.markAt(x, z);
    if (mk !== 0) this.snowK = mk === 2 ? 0 : 0.2;
    if (this.ice > 0.05 && mk === 0) {
      let k = 0;
      if (this.ice >= T_BRIDGE && RoadState.onBridge(x, z)) k = 1;
      else {
        for (let i = 0; i < this.inn; i++) {
          const dx = x - this.ix[i], dz = z - this.iz[i], r = this.ir[i];
          if (dx > r || dx < -r || dz > r || dz < -r) continue;
          const d2 = (dx * dx + dz * dz) / (r * r);
          if (d2 < 1) { const e = d2 < 0.5 ? 1 : 2 - 2 * d2; if (e > k) k = e; }
        }
      }
      if (k > 0) {
        const lev = clamp01(this.ice * 1.5);
        this.grip = 1 - (1 - ICE_GRIP) * k * lev;
        this.onIce = this.grip < 0.8;
      }
    }
    if (this.wet > 0.25 && this.pn > 0) {
      for (let i = 0; i < this.pn; i++) {
        const dx = x - this.px[i], dz = z - this.pz[i], r = this.pr[i];
        if (dx > r || dx < -r || dz > r || dz < -r) continue;
        if (dx * dx + dz * dz < r * r) { this.puddle = i; this.grip *= 0.93; break; }
      }
    }
  }
}

/** The one road state (this page). */
export const roads = new RoadState();

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);

export class RoadFx implements WorldPart {
  /** Tests. */
  readonly stats = { puddles: 0, patches: 0, level: 0, ms: 0 };
  private readonly group = new THREE.Group();
  private pud: THREE.InstancedMesh | null = null;
  private icy: THREE.InstancedMesh | null = null;
  private readonly kb = new Float32Array(1200);
  private lastWetQ = -1; private lastIceQ = -1; private lastMarks = -1;
  private warned = -1;

  constructor(private readonly game: Game, parent: THREE.Group) {
    this.group.name = 'roadCond';
    parent.add(this.group);
    let f: '' | 'wet' | 'ice' | 'dry' = '';
    try { const q = new URLSearchParams(location.search).get('road'); if (q === 'wet' || q === 'ice' || q === 'dry') f = q; } catch { /* no URL, no test */ }
    roads.forced = f;
    (window as unknown as { __roads?: unknown }).__roads = { roads, fx: this };
  }

  /** The ice the clock gives now, 0 when snow is falling or lying thick (the snow is the hazard then). */
  private clockIce(): number {
    const g = this.game, sky = g.sky;
    if (season.now !== 'winter') return 0;
    const net = g.net as unknown as { town?: { weatherSeed?: number } } | undefined;
    const seed = net?.town?.weatherSeed ?? 0;
    const lv = iceLevel(sky.dayNo, sky.hour, seed);
    if (lv <= 0) return 0;
    return lv * (1 - sky.slick) * (sky.weather === 'snow' || sky.weather === 'rain' ? 0 : 1);
  }

  update(dt: number): void {
    const g = this.game, sky = g.sky;
    if (!sky) return;
    const t0 = performance.now();
    const r = roads;
    let wet = sky.wet, ice = this.clockIce();
    const fo = r.forced;
    if (fo === 'wet') { wet = 1; ice = 0; } else if (fo === 'ice') { wet = 0.2; ice = 1; } else if (fo === 'dry') { wet = 0; ice = 0; }
    r.wet = wet; r.ice = ice;
    r.ai = Math.max(sky.slick, wet * 0.22, ice * 0.8);
    r.cond = ice > 0.2 ? 2 : wet > 0.3 ? 1 : 0;
    r.active = wet > 0.05 || ice > 0.05 || sky.slick > 0.05 || r.marks > 0;
    this.stats.level = ice;
    // The bulletin: once a freezing night begins and the player is on the road.
    const ep = ice > 0.3 ? Math.floor(sky.dayNo) + (sky.hour < 12 ? -1 : 0) : -1;
    if (ep >= 0 && ep !== this.warned && g.player.seated) { this.warned = ep; g.hud.toast('Claude FM traffic: black ice reported on the bridges tonight. Easy on the brakes.', 6); }
    else if (ep < 0 && ice < 0.05) this.warned = -1;
    if (r.wet > 0.25 || r.ice > 0.05) {
      if (!this.pud) this.build();
      const cam = g.camera.position;
      const wq = Math.round(r.wet * 6), iq = Math.round(r.ice * 8);
      if (wq !== this.lastWetQ || iq !== this.lastIceQ || r.marks !== this.lastMarks || (cam.x - r.cx) ** 2 + (cam.z - r.cz) ** 2 > 100) {
        this.lastWetQ = wq; this.lastIceQ = iq; this.lastMarks = r.marks;
        this.fill(cam.x, cam.z, g.quality.name === 'low' ? 55 : 80);
      }
      this.splashes();
    } else if (r.pn > 0 || r.inn > 0) {
      r.pn = 0; r.inn = 0; this.lastWetQ = this.lastIceQ = -1;
      if (this.pud) this.pud.count = 0;
      if (this.icy) this.icy.count = 0;
      this.stats.puddles = 0; this.stats.patches = 0;
    }
    this.stats.ms = performance.now() - t0;
    void dt;
  }

  private build(): void {
    const g = this.game, low = g.quality.name === 'low';
    const mk = (color: number, opacity: number, rough: number, env: number, order: number, name: string, cap: number): THREE.InstancedMesh => {
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: rough, metalness: 0, envMapIntensity: env, transparent: true, opacity, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -4,
      });
      mat.userData.noSnow = true;
      mat.customProgramCacheKey = (): string => 'roadcond-' + name;
      const geo = new THREE.CircleGeometry(1, low ? 12 : 20);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      g.flip.mesh(m);
      m.count = 0; m.frustumCulled = false; m.renderOrder = order; m.name = name;
      this.group.add(m);
      return m;
    };
    // Rain water: dark and mirror-smooth. Black ice: nearly clear, a cold glint and no more.
    this.pud = mk(0x2b2f35, 0.78, 0.04, 1.2, 3, 'roadPuddles', PUD_CAP);
    this.icy = mk(0x16202c, 0.2, 0.03, 1.6, 3, 'blackIce', ICE_CAP);
  }

  /** The puddles and ice patches near (x, z): the lane side of the kerb places the gutter puddles use, picked by a hash of the place. */
  private fill(x: number, z: number, R: number): void {
    const g = this.game, r = roads, sf = g.sky.snowfall, SG = g.plan.streets;
    r.cx = x; r.cz = z;
    const pud = this.pud as THREE.InstancedMesh, icy = this.icy as THREE.InstancedMesh;
    let np = 0, ni = 0;
    const wetF = r.wet > 0.25 ? clamp01((r.wet - 0.2) / 0.7) : 0;
    const kn = sf && SG && (wetF > 0 || r.ice > 0.05) ? sf.kerbs(x, z, R, this.kb) : 0;
    for (let i = 0; i < kn; i++) {
      const bx = this.kb[i * 3], bz = this.kb[i * 3 + 1], a = this.kb[i * 3 + 2];
      const ix = Math.floor(bx * 0.5), iz = Math.floor(bz * 0.5);
      const hp = hash(ix, iz, 71), hi = hash(ix, iz, 72);
      const wantP = wetF > 0 && np < PUD_CAP && hp < 0.3 * wetF + 0.02;
      const shade = hash(Math.floor(bx / 24), Math.floor(bz / 24), 73) < 0.4;
      const wantI = r.ice > 0.05 && ni < ICE_CAP && hi < 0.35 && r.ice >= (shade ? T_SHADE : T_OPEN);
      if (!wantP && !wantI) continue;
      // Which way is the road? Toward the centre line of the street this kerb belongs to.
      const sg = SG as NonNullable<typeof SG>, n = sg.nearestEdge(bx, bz, (e) => !e.deck), p = sg.project(n.edge, bx, bz), c = sg.pointAt(n.edge, p.s);
      const dx = c.x - bx, dz = c.z - bz, d = Math.hypot(dx, dz) || 1;
      if (d > 14) continue;
      const ux = dx / d, uz = dz / d;
      if (wantP) {
        const off = 1.6 + 2.2 * hash(ix, iz, 74), px = bx + ux * off, pz = bz + uz * off, y = groundAt(px, pz);
        if (y > WATER_Y + 0.1) {
          const rr = (0.7 + 1.0 * hash(ix, iz, 75)) * (0.55 + 0.45 * wetF), rz = rr * 0.7;
          _q.setFromAxisAngle(_y, a);
          pud.setMatrixAt(np, _m.compose(_v.set(px, y + 0.035, pz), _q, _s.set(rr * 1.5, 1, rz)));
          r.px[np] = px; r.pz[np] = pz; r.pr[np] = Math.max(0.6, rr * 1.2); r.pLast[np] = 0;
          np++;
        }
      }
      if (wantI) {
        const off = 2.4, px = bx + ux * off, pz = bz + uz * off, y = groundAt(px, pz);
        if (y > WATER_Y + 0.1 && r.markAt(px, pz) === 0) {
          const rr = 3.2 + 2.6 * hash(ix, iz, 76);
          _q.setFromAxisAngle(_y, a);
          icy.setMatrixAt(ni, _m.compose(_v.set(px, y + 0.045, pz), _q, _s.set(rr, 1, rr * 0.75)));
          r.ix[ni] = px; r.iz[ni] = pz; r.ir[ni] = rr;
          ni++;
        }
      }
    }
    // The bridge: bands of ice the width of the deck, kept to what is near.
    if (r.ice >= T_BRIDGE && Math.abs(x - BRIDGE.x) < R + 20) {
      for (let zz = BRIDGE_Z0 - 8; zz > BRIDGE_Z1 && ni < ICE_CAP; zz -= 14) {
        if (Math.abs(zz - z) > R + 10) continue;
        if (r.markAt(BRIDGE.x, zz) !== 0) continue;
        const y = groundAt(BRIDGE.x, zz);
        icy.setMatrixAt(ni, _m.compose(_v.set(BRIDGE.x, y + 0.045, zz), _q.identity(), _s.set(BRIDGE.hw * 0.96, 1, 8.6)));
        // Not a sampling patch (the bridge is tested whole), so park it far away.
        r.ix[ni] = 1e9; r.iz[ni] = 1e9; r.ir[ni] = 0.01;
        ni++;
      }
    }
    r.pn = np; r.inn = ni;
    pud.count = np; icy.count = ni;
    this.stats.puddles = np; this.stats.patches = ni;
    const pm = pud.material as THREE.MeshStandardMaterial, im = icy.material as THREE.MeshStandardMaterial;
    const env = g.scene.environment;
    if (pm.envMap !== env) { pm.envMap = env; pm.needsUpdate = true; im.envMap = env; im.needsUpdate = true; }
    im.opacity = 0.12 + 0.2 * clamp01(r.ice);
    if (np) pud.instanceMatrix.needsUpdate = true;
    if (ni) icy.instanceMatrix.needsUpdate = true;
  }

  /** Cars through puddles throw spray; the player's tug and the AI's skids are in ent/vehicle.ts. */
  private splashes(): void {
    const g = this.game, r = roads, cars = g.vehicles.list, cam = g.camera.position, now = performance.now() / 1000;
    if (r.pn === 0 || r.wet < 0.25) return;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i], v2 = c.vx * c.vx + c.vz * c.vz;
      if (v2 < 6 || !c.onGround) continue;
      const dx0 = c.x - cam.x, dz0 = c.z - cam.z;
      if (dx0 * dx0 + dz0 * dz0 > 3600) continue;
      for (let k = 0; k < r.pn; k++) {
        const dx = c.x - r.px[k], dz = c.z - r.pz[k], rr = r.pr[k] + c.hw * 0.4;
        if (dx > rr + c.hl || dx < -rr - c.hl || dz > rr + c.hl || dz < -rr - c.hl) continue;
        if (dx * dx + dz * dz > rr * rr || now - r.pLast[k] < 0.7) continue;
        r.pLast[k] = now;
        r.splashes++;
        g.fx.emitters.splash(c.x, c.z, v2 > 81);
      }
    }
  }
}
