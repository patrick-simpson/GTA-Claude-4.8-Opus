// Fun queue 2, item 35: night life on Main St, Tepid Falls. Two walk-in rooms behind real directory doors: the Side Door Diner
// (counter, booths, jukebox, pie case) and the Hog Wallow Pub (bar, stage, darts), and a little life on the street outside them.
//
// OUTSIDE: on foot at either door [G] goes in while it is open (diner 5:30 am to 11 pm, pub 5 pm to 2 am, the town clock);
// at night the facade glows (two warm window panels, an OPEN neon, a pool of light on the pavement) and a few people stand about
// the door. All of it exists only while the player is within about 170 m, and a room is built only when she is at the door.
// INSIDE: the room (world/nightRooms.ts) stands in the sky above the door, so nothing in the street is cut for it; going in
// and out is a teleport. Inside, the world beyond 45 m is not drawn and the sun's shadows are left as they were.
//   Stools and booths: [G] sit and order from a short menu (a few dollars, health back); coffee refills are free.
//   Jukebox (diner): [G] the next station, heard on foot.   Darts (pub): [G] against Bram for $5, a timing bar, three darts
//   each, $12 for a win.   The band plays Thursday, Friday and Saturday evenings (the pub's stage), staff and regulars as always.
// Local only: no protocol, no server, no fact key, no save key.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person } from '../core/api';
import { places, type Place } from '../world/business';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { buildRoom, neonTex, ROOM_Y, type FolkSpec, type Room, type SeatSpec } from '../world/nightRooms';
import { BAND, CROWD, DARTS, VENUES, VENUE_IDS, bandPlays, dartScore, fmtOpen, openAt, type MenuItem, type VenueDef, type VenueId } from './nightData';
import { maine } from './eventCalendar';
import { nightBloom } from '../core/post';
import { dampAngle, money, smooth } from '../core/util';
import type { Townsfolk } from './townsfolk';

/** How near the door counts as at it, how near a spot in the room, how far the street's life reaches. */
const AT_DOOR = 2.6, BUILD = 15, NEAR_FACADE = 170, DROP_FACADE = 230, DROP_ROOM = 260, CROWD_R = 100;

interface Live { p: Person; spec: FolkSpec; i: number; wait: number; ph: number }
interface Facade { group: THREE.Group; mats: THREE.MeshBasicMaterial[]; spill: THREE.MeshBasicMaterial; dispose(): void }
interface Venue {
  def: VenueDef; place: Place | null; ox: number; oz: number;
  room: Room | null; boxed: boolean; folk: Live[]; facade: Facade | null; crowd: Person[]; crowdAt: [number, number, number][];
}
export type Panel = 'menu' | 'darts' | null;
export interface DartsState { phase: 'aim' | 'done'; n: number; mine: number[]; reg: number[]; marks: { x: number; y: number }[]; t: number; pos: number; msg: string; won: boolean | null }

export class Nightlife {
  /** True only in the new Tepid Falls: the two doors are its own. */
  readonly on: boolean;
  prompt: string | null = null;
  /** Which venue the player is in, or null. */
  inside: VenueId | null = null;
  panel: Panel = null;
  /** Bumped on every change so the panel redraws. */
  rev = 0;
  msg = '';
  darts: DartsState | null = null;
  /** A test may fix the darts: scores for each of the three throws of each side. */
  rig: { me?: number[]; reg?: number[] } | null = null;
  readonly stats = { meals: 0, spent: 0, healed: 0, refills: 0, juke: 0, darts: 0, dartsWon: 0, entered: 0 };
  /** The last station the jukebox chose (for the tests). */
  station = '';
  private readonly v: Record<VenueId, Venue>;
  private cups = 0;
  private sit: SeatSpec | null = null;
  private culled = false;
  private farWas = 0;
  private bloomOff = false;
  private wd = 0; private wdT = 0; private band = false;
  private forceBand = false;
  private recheck = 0;
  private t = 0;
  private spillTex: THREE.CanvasTexture | null = null;

  constructor(private readonly game: Game, private readonly folks: Townsfolk, private readonly idle: () => boolean) {
    this.on = STREETS_NEW;
    this.forceBand = new URLSearchParams(location.search).get('band') === '1';
    const mk = (id: VenueId): Venue => ({ def: VENUES[id], place: null, ox: 0, oz: 0, room: null, boxed: false, folk: [], facade: null, crowd: [], crowdAt: [] });
    this.v = { diner: mk('diner'), pub: mk('pub') };
  }

  // ── What there is ──────────────────────────────────────────────────────────

  private resolve(): void {
    if (this.v.diner.place || this.v.pub.place || !this.on) return;
    const list = places(this.game.plan);
    for (const id of VENUE_IDS) {
      const vn = this.v[id], pl = list.find((q) => q.name === vn.def.place && q.placed);
      if (!pl) continue;
      vn.place = pl;
      // The room's own corner: the door's spot (the pocket is in the sky over it).
      vn.ox = pl.x; vn.oz = pl.z;
    }
  }

  venue(id: VenueId): Venue { return this.v[id]; }
  isOpen(id: VenueId): boolean { return openAt(this.v[id].def, this.game.sky.hour); }
  /** True when the pub's band is on (a Thursday to Saturday evening in Maine, or ?band=1). */
  bandOn(): boolean { return this.band; }
  menu(): MenuItem[] {
    const v = this.inside ? this.v[this.inside] : null;
    if (!v) return [];
    const m = v.def.menu.slice();
    if (v.def.id === 'diner' && this.cups > 0) m.splice(1, 0, { id: 'refill', name: 'Coffee refill', price: 0, heal: 4, note: `free · ${this.cups} left in the pot` });
    return m;
  }
  where(id: VenueId): { x: number; z: number } | null { const p = this.v[id].place; return p ? { x: p.x, z: p.z } : null; }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.prompt = null;
    if (!this.on) return;
    this.resolve();
    const g = this.game, ft = Math.min(dt, 0.1);
    this.t += ft;
    if ((this.wdT -= ft) <= 0) { this.wdT = 1; this.wd = maine(Date.now()).wd; }
    this.band = bandPlays(this.wd, g.sky.hour, this.forceBand);
    const p = g.player;
    if (this.inside) {
      // Respawned, or sent somewhere else (a ride, a fall): out of the room.
      if (!(p.y > ROOM_Y - 30) || !(p.health > 0) || g.state !== 'play') { this.out(true); }
      else { this.indoors(ft); this.bloom(true); return; }
    }
    this.bloom(false);
    this.street(ft);
  }

  private bloom(inside: boolean): void {
    if (inside) { this.bloomOff = true; return; }
    if (this.bloomOff) { nightBloom.scale = 1; this.bloomOff = false; }
  }

  private street(dt: number): void {
    const g = this.game, p = g.player, hr = g.sky.hour, night = g.sky.night;
    for (const id of VENUE_IDS) {
      const vn = this.v[id], pl = vn.place;
      if (!pl) continue;
      const d = Math.hypot(p.x - pl.x, p.z - pl.z), open = openAt(vn.def, hr);
      // The facade's glow and the people at the door: only near, only at night.
      if (d < NEAR_FACADE && night > 0.1 && open) { if (!vn.facade) vn.facade = this.makeFacade(vn); this.glow(vn, night); }
      else if (vn.facade && (d > DROP_FACADE || night < 0.05 || !open)) { vn.facade.dispose(); vn.facade = null; }
      const h = ((hr % 24) + 24) % 24, late = h >= CROWD.from || h < CROWD.to - 24;
      if (d < CROWD_R && late && open && night > 0.3) this.crowd(vn, dt); else if (vn.crowd.length) this.crowdOff(vn);
      // The room: built at the door, dropped when far.
      if (d < BUILD && !vn.room) this.build(vn);
      else if (vn.room && d > DROP_ROOM) this.drop(vn);
      // The prompt at the door.
      if (d < AT_DOOR && !p.vehicle && p.health > 0 && this.idle()) {
        if (open) {
          this.prompt = `[G] Go in: ${vn.def.title}`;
          if (g.input.eat('interact')) this.enter(vn);
        } else {
          this.prompt = `${vn.def.title} is closed. Open ${fmtOpen(vn.def.from)} to ${fmtOpen(vn.def.to)}.`;
          if (g.input.eat('interact')) g.hud.toast(`${vn.def.title}: closed until ${fmtOpen(vn.def.from)}.`, 4);
        }
      }
    }
    void dt;
  }

  // ── The street ─────────────────────────────────────────────────────────────

  private makeFacade(vn: Venue): Facade {
    const pl = vn.place as Place, g = this.game;
    const group = new THREE.Group(); group.name = 'night-facade-' + vn.def.id;
    const gy = groundAt(pl.wx, pl.wz);
    group.position.set(pl.wx + pl.nx * 0.09, gy, pl.wz + pl.nz * 0.09);
    group.rotation.y = Math.atan2(pl.nx, pl.nz);
    const warm = vn.def.id === 'diner';
    const win = (() => {
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 96;
      const c = cv.getContext('2d') as CanvasRenderingContext2D;
      const gr = c.createLinearGradient(0, 0, 0, 96);
      gr.addColorStop(0, warm ? '#fff2c8' : '#ffc27a'); gr.addColorStop(1, warm ? '#ffd68a' : '#ff9a4a');
      c.fillStyle = gr; c.fillRect(0, 0, 128, 96);
      c.fillStyle = 'rgba(70,40,20,0.55)'; c.fillRect(62, 0, 4, 96); c.fillRect(0, 44, 128, 4);
      c.fillStyle = 'rgba(40,20,10,0.35)'; c.fillRect(0, 0, 128, 5); c.fillRect(0, 91, 128, 5); c.fillRect(0, 0, 5, 96); c.fillRect(123, 0, 5, 96);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const open = neonTex('OPEN', warm ? '#fff3d0' : '#e9ffe9', warm ? '#ff7a2a' : '#3cd870');
    const quad = new THREE.PlaneGeometry(1, 1);
    const mats: THREE.MeshBasicMaterial[] = [];
    const add = (tex: THREE.Texture, x: number, y: number, w: number, h: number, k: number): void => {
      const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      m.userData.k = k; mats.push(m);
      const mesh = new THREE.Mesh(quad, m); mesh.position.set(x, y, 0); mesh.scale.set(w, h, 1); mesh.renderOrder = 4; group.add(mesh);
    };
    add(win, -3.2, 1.75, 2.1, 1.3, 1.5); add(win, 3.2, 1.75, 2.1, 1.3, 1.5); add(open, 1.7, 2.0, 0.95, 0.3, 1.5);
    // A pool of light on the pavement in front of the door.
    if (!this.spillTex) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const c = cv.getContext('2d') as CanvasRenderingContext2D, gr = c.createRadialGradient(32, 32, 2, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,200,120,0.85)'); gr.addColorStop(0.55, 'rgba(255,170,80,0.28)'); gr.addColorStop(1, 'rgba(255,150,60,0)');
      c.fillStyle = gr; c.fillRect(0, 0, 64, 64);
      this.spillTex = new THREE.CanvasTexture(cv); this.spillTex.colorSpace = THREE.SRGBColorSpace;
    }
    const spill = new THREE.MeshBasicMaterial({ map: this.spillTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const sp = new THREE.Mesh(quad, spill); sp.rotation.x = -Math.PI / 2; sp.position.set(0, 0.07, 3.0); sp.scale.set(9, 6, 1); sp.renderOrder = 3;
    group.add(sp);
    g.scene.add(group);
    return { group, mats, spill, dispose: () => { g.scene.remove(group); for (const m of mats) m.dispose(); spill.dispose(); quad.dispose(); win.dispose(); open.dispose(); } };
  }

  private glow(vn: Venue, night: number): void {
    const f = vn.facade as Facade, k = smooth((night - 0.1) / 0.5);
    for (const m of f.mats) { m.color.setScalar((m.userData.k as number) * (0.7 + 0.3 * k)); m.opacity = k; }
    f.spill.opacity = 0.9 * k;
  }

  private crowd(vn: Venue, dt: number): void {
    const g = this.game, pl = vn.place as Place;
    if (!vn.crowd.length) {
      const n = vn.def.id === 'pub' ? CROWD.pub : CROWD.diner, tx = -pl.nz, tz = pl.nx;
      const spots: [number, number][] = vn.def.id === 'pub' ? [[-2.4, 1.0], [-1.5, 1.6], [2.2, 1.1], [3.2, 1.7]] : [[-2.0, 1.2], [-1.1, 1.8]];
      const sg = g.plan.streets;
      for (let i = 0; i < n; i++) {
        const [t, s] = spots[i];
        const x = pl.wx + tx * t + pl.nx * (s + 0.6), z = pl.wz + tz * t + pl.nz * (s + 0.6);
        if (sg && !sg.clearOfRoads(x, z, 0.6)) continue;
        const partner = spots[i ^ 1] ?? spots[0];
        const px = pl.wx + tx * partner[0] + pl.nx * (partner[1] + 0.6), pz = pl.wz + tz * partner[0] + pl.nz * (partner[1] + 0.6);
        const per = g.people.spawn(x, z, Math.atan2(px - x, pz - z), g.people.randomLook());
        per.y = groundAt(x, z); per.pose = 'stand'; per.speed = 0; per.visible = true; per.health = 100;
        vn.crowd.push(per); vn.crowdAt.push([x, z, Math.atan2(px - x, pz - z)]);
      }
    }
    for (let i = 0; i < vn.crowd.length; i++) {
      const per = vn.crowd[i], a = vn.crowdAt[i];
      per.h = dampAngle(per.h, a[2] + Math.sin(this.t * 0.6 + i * 2.1) * 0.35, 3, dt);
    }
    if ((this.recheck -= dt) <= 0) {
      this.recheck = 2;
      const f = vn.crowd[0];
      if (f && !g.people.list.includes(f)) { vn.crowd = []; vn.crowdAt = []; }
    }
  }
  private crowdOff(vn: Venue): void { for (const p of vn.crowd) this.game.people.remove(p); vn.crowd = []; vn.crowdAt = []; }

  // ── The rooms ──────────────────────────────────────────────────────────────

  private build(vn: Venue): void {
    const g = this.game, room = buildRoom(vn.def.id), s = room.spec;
    vn.room = room;
    room.group.position.set(vn.ox, ROOM_Y, vn.oz);
    room.group.visible = false;
    g.scene.add(room.group);
    if (!vn.boxed) {
      // The pocket's solids, once: the floor, four walls, the ceiling, then the furniture.
      vn.boxed = true;
      const c = g.col, x0 = vn.ox - s.w / 2, x1 = vn.ox + s.w / 2, z0 = vn.oz, z1 = vn.oz + s.d, Y = ROOM_Y;
      c.addBox(x0 - 1, z0 - 1, x1 + 1, z1 + 1, Y, Y - 3);
      c.addBox(x0 - 0.5, z0 - 0.5, x1 + 0.5, z0, Y + s.h + 1, Y - 1); c.addBox(x0 - 0.5, z1, x1 + 0.5, z1 + 0.5, Y + s.h + 1, Y - 1);
      c.addBox(x0 - 0.5, z0, x0, z1, Y + s.h + 1, Y - 1); c.addBox(x1, z0, x1 + 0.5, z1, Y + s.h + 1, Y - 1);
      c.addBox(x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5, Y + s.h + 0.6, Y + s.h);
      for (const [u0, u1, v0, v1, y0, y1] of s.boxes) c.addBox(vn.ox + u0, vn.oz + v0, vn.ox + u1, vn.oz + v1, Y + y1, Y + y0);
    }
    this.spawnFolk(vn);
  }

  private drop(vn: Venue): void {
    const room = vn.room;
    if (!room) return;
    for (const l of vn.folk) this.game.people.remove(l.p);
    vn.folk = [];
    this.game.scene.remove(room.group);
    room.dispose();
    vn.room = null;
  }

  private spawnFolk(vn: Venue): void {
    const g = this.game, room = vn.room as Room;
    for (const l of vn.folk) g.people.remove(l.p);
    vn.folk = [];
    const walt = this.folks.def('walt');
    room.spec.folk.forEach((f, i) => {
      const look = f.role === 'landlord' && walt ? walt.look : g.people.randomLook();
      const x = vn.ox + f.u, z = vn.oz + f.v, p = g.people.spawn(x, z, f.h, look);
      p.y = ROOM_Y + f.y - (f.pose === 'sit' ? 0.03 : 0); p.pose = f.pose; p.bench = f.pose === 'sit'; p.visible = false; p.health = 100; p.speed = 0;
      vn.folk.push({ p, spec: f, i: 0, wait: i * 1.7, ph: i * 1.3 });
    });
  }

  /** Everyone in the room: waiters walk, the band is there only on its nights. */
  private people(vn: Venue, dt: number): void {
    for (const l of vn.folk) {
      const p = l.p, f = l.spec;
      p.visible = f.band ? this.band : true;
      if (!p.visible) continue;
      if (f.path) {
        if (l.wait > 0) { l.wait -= dt; p.pose = 'stand'; p.speed = 0; continue; }
        const [tu, tv] = f.path[(l.i + 1) % f.path.length], dx = vn.ox + tu - p.x, dz = vn.oz + tv - p.z, d = Math.hypot(dx, dz);
        if (d < 0.12) { l.i = (l.i + 1) % f.path.length; l.wait = 1.5 + (l.i & 1) * 2.5; continue; }
        const s = Math.min(d, 1.1 * dt);
        p.x += dx / d * s; p.z += dz / d * s; p.h = Math.atan2(dx, dz); p.pose = 'walk'; p.speed = 1.1;
      } else if (f.role === 'band' || f.role === 'cook') {
        p.h = f.h + Math.sin(this.t * (f.role === 'cook' ? 0.8 : 1.6) + l.ph) * (f.role === 'cook' ? 0.5 : 0.12);
      } else if (f.role === 'landlord' || f.role === 'regular') {
        // Turn to the player when she is close, else keep to the work.
        const pl = this.game.player, dx = pl.x - p.x, dz = pl.z - p.z, near = Math.hypot(dx, dz) < 4.2;
        p.h = dampAngle(p.h, near ? Math.atan2(dx, dz) : f.h, 4, dt);
      }
    }
  }

  // ── Inside ─────────────────────────────────────────────────────────────────

  private enter(vn: Venue): void {
    const g = this.game, p = g.player;
    if (!vn.room) this.build(vn);
    const room = vn.room as Room, e = room.spec.entry;
    this.inside = vn.def.id;
    this.stats.entered++;
    this.cups = 0;
    this.msg = '';
    p.teleport(vn.ox + e.u, vn.oz + e.v, e.h);
    p.person.y = ROOM_Y;
    g.cam.snap();
    room.group.visible = true;
    this.cull(true);
    const radio = g.audio.radio;
    if (radio) radio.juke = true;
    const pub = vn.def.id === 'pub';
    if (pub && this.band) {
      g.hud.toast(`${BAND.name} are on stage tonight.`, 5);
      if (radio && radio.station < 1) this.jukeStep();
    } else g.hud.toast(`${vn.def.title}. ${vn.def.sub}`, 4);
  }

  private out(forced = false): void {
    const g = this.game, p = g.player, vn = this.inside ? this.v[this.inside] : null;
    if (forced) this.sit = null;
    if (this.panel) this.closePanel(true);
    this.inside = null;
    this.sit = null;
    this.cull(false);
    const radio = g.audio.radio;
    if (radio) radio.juke = false;
    if (vn && vn.room) vn.room.group.visible = false;
    if (vn && vn.place && !forced) {
      const pl = vn.place;
      p.teleport(pl.x, pl.z, Math.atan2(pl.nx, pl.nz));
      g.cam.snap();
    }
  }
  /** Leave by the street door (for the tests and the panel). */
  leave(): void { if (this.inside) this.out(); }

  private cull(on: boolean): void {
    if (on === this.culled) return;
    const g = this.game, cam = g.camera as THREE.PerspectiveCamera, r = g.renderer;
    if (on) { this.farWas = cam.far; cam.far = Math.min(cam.far, 45); } else if (this.farWas) cam.far = this.farWas;
    r.shadowMap.autoUpdate = !on;
    if (!on) r.shadowMap.needsUpdate = true;
    cam.updateProjectionMatrix();
    this.culled = on;
  }

  private indoors(dt: number): void {
    const g = this.game, p = g.player, vn = this.v[this.inside as VenueId], room = vn.room;
    if (!room) { this.out(true); return; }
    const s = room.spec;
    const radio = g.audio.radio;
    if (radio && !radio.juke) radio.juke = true;     // the sound may have woken after she came in
    this.people(vn, dt);
    // Starting or restarting the game clears the crowd: put ours back when they have gone.
    if ((this.recheck -= dt) <= 0) { this.recheck = 2; const f0 = vn.folk[0]; if (f0 && !g.people.list.includes(f0.p)) this.spawnFolk(vn); }
    // Keep her in the room (the solids do it; this is the belt).
    const u = p.x - vn.ox, v = p.z - vn.oz;
    if (Math.abs(u) > s.w / 2 + 0.3 || v < -0.3 || v > s.d + 0.3) { p.teleport(vn.ox + s.entry.u, vn.oz + s.entry.v, s.entry.h); p.person.y = ROOM_Y; }
    if (this.panel) {
      if (this.panel === 'darts') this.dartsTick(dt);
      // Seated: held on the seat while the card is up.
      if (this.sit) {
        const per = p.person;
        per.x = vn.ox + this.sit.u; per.z = vn.oz + this.sit.v; per.y = ROOM_Y + this.sit.y - 0.03; per.h = this.sit.h; per.pose = 'sit'; per.bench = true; per.speed = 0;
      }
      return;
    }
    if (!this.idle() || p.health <= 0) return;
    // What is within reach, nearest first: the door, the jukebox, the darts, a free seat.
    const px = u, pz = v;
    if (Math.hypot(px - s.door.u, pz - s.door.v) < 1.4) {
      this.prompt = `[G] Leave ${vn.def.title}`;
      if (g.input.eat('interact')) this.out();
      return;
    }
    if (s.juke && Math.hypot(px - s.juke.u, pz - s.juke.v) < 1.5) {
      this.prompt = `[G] Jukebox: change the music${this.station ? ' (now ' + this.station + ')' : ''}`;
      if (g.input.eat('interact')) this.jukeStep();
      return;
    }
    if (s.darts && Math.hypot(px - s.darts.u, pz - s.darts.v) < 1.3) {
      this.prompt = `[G] Play darts against ${DARTS.opponent}: ${money(DARTS.stake)} a game, ${money(DARTS.prize)} to win`;
      if (g.input.eat('interact')) this.startDarts();
      return;
    }
    let best: SeatSpec | null = null, bd = 1.25;
    for (const q of s.seats) {
      if (q.taken) continue;
      const d = Math.hypot(px - q.u, pz - q.v);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) {
      this.prompt = `[G] Sit ${best.kind === 'booth' ? 'in the booth' : vn.def.id === 'diner' ? 'at the counter' : 'down'} and order`;
      if (g.input.eat('interact')) this.sitDown(best);
    }
  }

  private sitDown(q: SeatSpec): void {
    this.sit = q;
    this.msg = '';
    this.openPanel('menu');
  }

  private standUp(): void {
    const q = this.sit, vn = this.inside ? this.v[this.inside] : null;
    this.sit = null;
    if (!q || !vn) return;
    const p = this.game.player.person;
    let u = q.u - Math.sin(q.h) * 0.85, v = q.v - Math.cos(q.h) * 0.85;
    if (q.kind === 'booth') { u = q.u + (q.u > 0 ? -1.5 : 1.5); v = q.v; }
    p.x = vn.ox + u; p.z = vn.oz + v; p.y = ROOM_Y; p.pose = 'stand'; p.bench = false;
    this.game.player.teleport(vn.ox + u, vn.oz + v, q.h + Math.PI);
    p.y = ROOM_Y;
  }

  // ── The card ───────────────────────────────────────────────────────────────

  private openPanel(k: Panel): void {
    this.panel = k; this.rev++;
  }
  closePanel(silent = false): void {
    if (!this.panel) return;
    this.panel = null; this.darts = null; this.rev++;
    this.standUp();
    void silent;
  }

  /** Order the nth item of the menu. Returns the line said. */
  order(i: number): string {
    const g = this.game, p = g.player, m = this.menu(), it = m[i];
    if (!it || !this.inside) return '';
    if (it.id === 'pie' && this.inside === 'diner') g.emit('moment', { kind: 'meal', id: 'pie' });
    let say = '';
    if (p.health >= 100) say = `You could not eat another bite. The ${it.name.toLowerCase()} will keep.`;
    else if (it.price > 0 && p.money < it.price) say = `${it.name} is ${money(it.price)}. You have ${money(p.money)}. The cook is sympathetic, not generous.`;
    else {
      const before = p.health;
      p.money -= it.price;
      p.health = Math.min(100, p.health + it.heal);
      p.person.health = p.health;
      this.stats.meals++; this.stats.spent += it.price; this.stats.healed += p.health - before;
      if (it.id === 'refill') { this.cups--; this.stats.refills++; }
      else if (it.id === 'coffee') this.cups = 3;
      say = it.price > 0 ? `${it.name}: ${money(it.price)}. Health ${Math.round(before)} to ${Math.round(p.health)}.` : `${it.name}: on the house. Health ${Math.round(before)} to ${Math.round(p.health)}.`;
    }
    this.msg = say; this.rev++;
    return say;
  }

  private jukeStep(): void {
    const radio = this.game.audio.radio;
    this.stats.juke++;
    if (!radio) { this.station = 'the jukebox hums'; this.game.hud.toast('The jukebox hums. Press a key to wake the sound.', 3); return; }
    const s = radio.jukeNext();
    this.station = `${s.call} ${s.name}`.trim();
    this.game.hud.toast(`Jukebox: ${this.station}`, 3);
  }

  // ── Darts ──────────────────────────────────────────────────────────────────

  private startDarts(): void {
    const p = this.game.player;
    if (p.money < DARTS.stake) { this.game.hud.toast(`${DARTS.opponent} wants ${money(DARTS.stake)} on the board. You have ${money(p.money)}.`, 4); return; }
    p.money -= DARTS.stake;
    this.stats.darts++;
    this.darts = { phase: 'aim', n: 0, mine: [], reg: [], marks: [], t: 0, pos: 0.5, msg: `${DARTS.opponent} chalks the stakes. Throw when the marker crosses the middle.`, won: null };
    this.sit = null;
    // Face the board.
    const vn = this.v[this.inside as VenueId], s = vn.room?.spec;
    if (s?.darts) this.game.player.teleport(vn.ox + s.darts.u, vn.oz + s.darts.v, s.darts.h);
    this.game.player.person.y = ROOM_Y;
    this.openPanel('darts');
  }

  private dartsTick(dt: number): void {
    const d = this.darts;
    if (!d || d.phase !== 'aim') return;
    d.t += dt;
    d.pos = 0.5 + 0.5 * Math.sin(d.t * (3.1 + d.n * 0.5));
  }

  /** Throw the next dart at the marker's place. */
  throwDart(): void {
    const d = this.darts, g = this.game;
    if (!d || d.phase !== 'aim') return;
    const dx = (d.pos - 0.5) * 2, dy = (Math.random() - 0.5) * 0.3, r = Math.hypot(dx, dy);
    const rigged = this.rig?.me?.[d.n];
    const score = rigged !== undefined ? rigged : dartScore(r);
    d.mine.push(score); d.marks.push({ x: dx, y: dy }); d.n++;
    d.msg = score >= 50 ? 'Bullseye!' : score >= 25 ? 'Inner ring, nicely done.' : score >= 12 ? 'On the board.' : score > 0 ? 'Barely on the board.' : 'Into the wall. Walt winces.';
    if (d.n >= 3) this.finishDarts();
    this.rev++;
    void g;
  }

  private finishDarts(): void {
    const d = this.darts as DartsState, p = this.game.player;
    for (let k = 0; k < 3; k++) {
      const rig = this.rig?.reg?.[k];
      d.reg.push(rig !== undefined ? rig : dartScore(Math.abs((Math.random() + Math.random() + Math.random() - 1.5) * 0.9) + 0.02));
    }
    const a = d.mine.reduce((x, y) => x + y, 0), b = d.reg.reduce((x, y) => x + y, 0);
    d.phase = 'done';
    if (a > b) { p.money += DARTS.prize; d.won = true; this.stats.dartsWon++; d.msg = `${a} to ${b}. You win ${money(DARTS.prize)}. ${DARTS.opponent} buys himself a root beer.`; this.game.hud.toast(`Darts: ${a} to ${b}. You won ${money(DARTS.prize)}.`, 4); }
    else if (a === b) { p.money += DARTS.stake; d.won = null; d.msg = `${a} each. A draw: your ${money(DARTS.stake)} comes back.`; }
    else { d.won = false; d.msg = `${a} to ${b}. ${DARTS.opponent} takes it. Best of luck next game.`; }
  }

  // ── Info ───────────────────────────────────────────────────────────────────

  info(): Record<string, unknown> {
    const o = (id: VenueId): Record<string, unknown> => { const v = this.v[id]; return { placed: !!v.place, room: !!v.room, facade: !!v.facade, crowd: v.crowd.length, folk: v.folk.length, open: this.on && this.isOpen(id) }; };
    return { on: this.on, inside: this.inside, panel: this.panel, band: this.band, diner: o('diner'), pub: o('pub'), stats: this.stats };
  }
}
