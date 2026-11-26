// Fun queue 2, item 47: three walk-in civic rooms, built the way item 35's diner and pub are (world/nightRooms.ts, game/nightlife.ts):
// the Overdue Library, the Museum of Mild Curiosities and the Tepid Falls Depot's ticket hall. Each is built in code the first time
// the player is at its door and stands in the sky above the door as a pocket with its own collision, so the street is untouched;
// going in and out is a teleport; inside, the world beyond 45 m is not drawn and the sun's shadows rest.
//
//   Library   9 am to 9 pm: tall shelves, reading tables with lamps, the librarian's desk. A hush (the sound of the town is turned
//             down). Ten shelves each have a gold tab: [G] borrows a book (a card of town lore and a late-fee joke); the librarian
//             talks across the desk. Borrow all ten and the Library card is stamped.
//   Museum    10 am to 8 pm: five exhibits (the Bridge, the Mill, the Great Tornado, the Moose, the Derby), a big model of the
//             island with its bridge and train, cases, a shop rack; [G] at an exhibit reads its plaque (read all five: the Museum
//             pass); the donation box takes $5 for the Millpond Promenade fund when the town project is open (item 28).
//   Depot     5 am to 11 pm: benches, a stove, a clock, a departures board showing the real next Budget Line trains from the rail
//             sim (sim/rail.ts upcoming) with live times, and a ticket window: [G] sells a ride to another station (item 8's
//             fast travel, from the hall instead of the platform), the fare as on the platform.
//   Outside   at night an open door glows (an OPEN sign, a warm panel over the door, a pool of light on the pavement).
// Local only: no protocol, no server, no fact key. What is read is kept in three numbers of the save's `best` map (civicData.ts).

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person } from '../core/api';
import { places, type Place } from '../world/business';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { ROOM_Y, neonTex } from '../world/nightRooms';
import { buildCivicRoom, type BoardRow, type CivicFolk, type CivicRoom, type Spot } from '../world/civicRooms';
import { BOARD_ROWS, BOOKS, CARD, CIVICS, CIVIC_IDS, DEPOT, DESK_LINES, DONATE, EXHIBITS, KEY_BOOKS, KEY_PLAQ, KEY_STAMP, MUSEUM_STAMP, STAMP_LIBRARY, STAMP_MUSEUM, openAt, popcount, type CivicDef, type CivicId } from './civicData';
import { fmtOpen } from './nightData';
import { nightBloom } from '../core/post';
import { dampAngle, money, smooth } from '../core/util';
import { kid } from '../core/kid';
import { save } from './save';

/** How near the door counts as at it, when a room is built, how far the street's glow reaches. */
const AT_DOOR = 2.6, BUILD = 15, NEAR_FACADE = 170, DROP_FACADE = 230, DROP_ROOM = 260;

interface Live { p: Person; spec: CivicFolk; ph: number }
interface Facade { group: THREE.Group; mats: THREE.MeshBasicMaterial[]; spill: THREE.MeshBasicMaterial; dispose(): void }
interface Venue { def: CivicDef; place: Place | null; ox: number; oz: number; room: CivicRoom | null; boxed: boolean; folk: Live[]; facade: Facade | null }
export type CivicPanelKind = 'book' | 'desk' | 'plaque' | 'ticket' | null;
export interface CivicRow { label: string; note: string; right: string; ok: boolean }
/** What the card shows. */
export interface CivicView { title: string; sub: string; body: string; foot: string; rows: CivicRow[]; msg: string; close: string }

const mmss = (s: number): string => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class Civic {
  readonly on: boolean;
  prompt: string | null = null;
  inside: CivicId | null = null;
  panel: CivicPanelKind = null;
  rev = 0;
  view: CivicView = { title: '', sub: '', body: '', foot: '', rows: [], msg: '', close: 'Done' };
  readonly stats = { entered: 0, books: 0, plaques: 0, desk: 0, tickets: 0, donated: 0, stamps: 0 };
  /** The last departures drawn on the board (for the tests). */
  board: BoardRow[] = [];
  private readonly v: Record<CivicId, Venue>;
  private culled = false;
  private farWas = 0;
  private bloomOff = false;
  private hushed = false;
  private hushT = 0;
  private recheck = 0;
  private t = 0;
  private boardT = 0;
  private boardSig = '';
  private clockMin = -1;
  private spillTex: THREE.CanvasTexture | null = null;
  private deskI = 0;
  private spot: Spot | null = null;
  private ptxt = '';
  /** The prompt is rebuilt only when what it is about, or what it says, changes: the thing, and a counter that moves with the card, the board and the clock. */
  private pwhat: unknown = null;
  private pver = -1;
  private ver = 0;
  private doorText = '';

  constructor(private readonly game: Game, private readonly idle: () => boolean) {
    this.on = STREETS_NEW;
    const mk = (id: CivicId): Venue => ({ def: CIVICS[id], place: null, ox: 0, oz: 0, room: null, boxed: false, folk: [], facade: null });
    this.v = { library: mk('library'), museum: mk('museum'), depot: mk('depot') };
  }

  // ── What there is ──────────────────────────────────────────────────────────

  private resolve(): void {
    if (!this.on) return;
    const first = this.v.library;
    if (first.place && this.v.museum.place && this.v.depot.place) return;
    const list = places(this.game.plan);
    for (const id of CIVIC_IDS) {
      const vn = this.v[id];
      if (vn.place) continue;
      const pl = list.find((q) => q.name === vn.def.place && q.placed);
      if (!pl) continue;
      vn.place = pl; vn.ox = pl.x; vn.oz = pl.z;
    }
  }

  venue(id: CivicId): Venue { return this.v[id]; }
  isOpen(id: CivicId): boolean { return openAt(this.v[id].def, this.game.sky.hour); }
  where(id: CivicId): { x: number; z: number } | null { const p = this.v[id].place; return p ? { x: p.x, z: p.z } : null; }
  books(): number { return (save.data.best[KEY_BOOKS] ?? 0) | 0; }
  plaques(): number { return (save.data.best[KEY_PLAQ] ?? 0) | 0; }
  stampMask(): number { return (save.data.best[KEY_STAMP] ?? 0) | 0; }
  /** The station index of the depot in the rail's list, or -1. */
  depotStation(): number { return this.game.rail.stations.findIndex((s) => s.name === DEPOT.station); }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.prompt = null;
    if (!this.on) return;
    this.resolve();
    const g = this.game, ft = Math.min(dt, 0.1);
    this.t += ft;
    const p = g.player;
    if (this.inside) {
      if (!(p.y > ROOM_Y - 30) || !(p.health > 0) || g.state !== 'play') this.out(true);
      else { this.indoors(ft); this.bloom(true); return; }
    }
    this.bloom(false);
    this.street();
  }

  private bloom(inside: boolean): void {
    if (inside) { this.bloomOff = true; return; }
    if (this.bloomOff) { nightBloom.scale = 1; this.bloomOff = false; }
  }

  private street(): void {
    const g = this.game, p = g.player, hr = g.sky.hour, night = g.sky.night;
    for (const id of CIVIC_IDS) {
      const vn = this.v[id], pl = vn.place;
      if (!pl) continue;
      const d = Math.hypot(p.x - pl.x, p.z - pl.z), open = openAt(vn.def, hr);
      if (d < NEAR_FACADE && night > 0.1 && open) { if (!vn.facade) vn.facade = this.makeFacade(vn); this.glow(vn, night); }
      else if (vn.facade && (d > DROP_FACADE || night < 0.05 || !open)) { vn.facade.dispose(); vn.facade = null; }
      if (d < BUILD && !vn.room) this.build(vn);
      else if (vn.room && d > DROP_ROOM) this.drop(vn);
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
  }

  // ── The street ─────────────────────────────────────────────────────────────

  private makeFacade(vn: Venue): Facade {
    const pl = vn.place as Place, g = this.game;
    const group = new THREE.Group(); group.name = 'hall-facade-' + vn.def.id;
    const gy = groundAt(pl.wx, pl.wz);
    group.position.set(pl.wx + pl.nx * 0.09, gy, pl.wz + pl.nz * 0.09);
    group.rotation.y = Math.atan2(pl.nx, pl.nz);
    const glowCol = vn.def.id === 'library' ? '#3cd870' : vn.def.id === 'museum' ? '#ff9a3c' : '#4aa8ff';
    const open = neonTex('OPEN', '#fff6dc', glowCol);
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 48;
    const c = cv.getContext('2d') as CanvasRenderingContext2D, gr = c.createLinearGradient(0, 0, 0, 48);
    gr.addColorStop(0, '#fff2c8'); gr.addColorStop(1, '#ffc27a');
    c.fillStyle = gr; c.fillRect(0, 0, 128, 48); c.fillStyle = 'rgba(70,40,20,0.5)'; c.fillRect(62, 0, 4, 48);
    const trans = new THREE.CanvasTexture(cv); trans.colorSpace = THREE.SRGBColorSpace;
    const quad = new THREE.PlaneGeometry(1, 1);
    const mats: THREE.MeshBasicMaterial[] = [];
    const add = (tex: THREE.Texture, x: number, y: number, w: number, h: number, k: number): void => {
      const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      m.userData.k = k; mats.push(m);
      const mesh = new THREE.Mesh(quad, m); mesh.position.set(x, y, 0); mesh.scale.set(w, h, 1); mesh.renderOrder = 4; group.add(mesh);
    };
    add(trans, 0, 2.95, 1.7, 0.6, 1.4); add(open, 1.9, 2.25, 1.0, 0.31, 1.5);
    if (!this.spillTex) {
      const s = document.createElement('canvas'); s.width = s.height = 64;
      const sc = s.getContext('2d') as CanvasRenderingContext2D, sg = sc.createRadialGradient(32, 32, 2, 32, 32, 32);
      sg.addColorStop(0, 'rgba(255,200,120,0.85)'); sg.addColorStop(0.55, 'rgba(255,170,80,0.28)'); sg.addColorStop(1, 'rgba(255,150,60,0)');
      sc.fillStyle = sg; sc.fillRect(0, 0, 64, 64);
      this.spillTex = new THREE.CanvasTexture(s); this.spillTex.colorSpace = THREE.SRGBColorSpace;
    }
    const spill = new THREE.MeshBasicMaterial({ map: this.spillTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const sp = new THREE.Mesh(quad, spill); sp.rotation.x = -Math.PI / 2; sp.position.set(0, 0.07, 3.0); sp.scale.set(8, 6, 1); sp.renderOrder = 3;
    group.add(sp);
    g.scene.add(group);
    return { group, mats, spill, dispose: () => { g.scene.remove(group); for (const m of mats) m.dispose(); spill.dispose(); quad.dispose(); open.dispose(); trans.dispose(); } };
  }

  private glow(vn: Venue, night: number): void {
    const f = vn.facade as Facade, k = smooth((night - 0.1) / 0.5);
    for (const m of f.mats) { m.color.setScalar((m.userData.k as number) * (0.7 + 0.3 * k)); m.opacity = k; }
    f.spill.opacity = 0.9 * k;
  }

  // ── The rooms ──────────────────────────────────────────────────────────────

  private build(vn: Venue): void {
    const g = this.game, room = buildCivicRoom(vn.def.id), s = room.spec;
    vn.room = room;
    room.group.position.set(vn.ox, ROOM_Y, vn.oz);
    room.group.visible = false;
    g.scene.add(room.group);
    if (!vn.boxed) {
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
    const g = this.game, room = vn.room as CivicRoom;
    for (const l of vn.folk) g.people.remove(l.p);
    vn.folk = [];
    room.spec.folk.forEach((f, i) => {
      const x = vn.ox + f.u, z = vn.oz + f.v, p = g.people.spawn(x, z, f.h, g.people.randomLook());
      p.y = ROOM_Y + f.y - (f.pose === 'sit' ? 0.03 : 0); p.pose = f.pose; p.bench = f.pose === 'sit'; p.visible = false; p.health = 100; p.speed = 0;
      vn.folk.push({ p, spec: f, ph: i * 1.3 });
    });
  }

  /** Staff turn to the player when she is near; readers read. */
  private people(vn: Venue, dt: number): void {
    const pl = this.game.player;
    for (const l of vn.folk) {
      const p = l.p, f = l.spec;
      p.visible = true;
      if (f.pose === 'sit') continue;
      const dx = pl.x - p.x, dz = pl.z - p.z, near = Math.hypot(dx, dz) < 4.2;
      if (f.role === 'librarian' || f.role === 'docent' || f.role === 'clerk') p.h = dampAngle(p.h, near ? Math.atan2(dx, dz) : f.h, 4, dt);
      else p.h = dampAngle(p.h, f.h + Math.sin(this.t * 0.4 + l.ph) * 0.2, 2, dt);
    }
  }

  // ── Inside ─────────────────────────────────────────────────────────────────

  private enter(vn: Venue): void {
    const g = this.game, p = g.player;
    if (!vn.room) this.build(vn);
    const room = vn.room as CivicRoom, e = room.spec.entry;
    this.inside = vn.def.id;
    this.stats.entered++;
    p.teleport(vn.ox + e.u, vn.oz + e.v, e.h);
    p.person.y = ROOM_Y;
    g.cam.snap();
    room.group.visible = true;
    this.cull(true);
    this.boardSig = ''; this.boardT = 0; this.clockMin = -1; this.pwhat = null; this.doorText = `[G] Leave ${vn.def.title}`;
    if (vn.def.id === 'library') { this.hush(true); g.hud.toast('The Overdue Library. Shh. Gold tabs on the shelves are books to borrow.', 5); }
    else if (vn.def.id === 'museum') g.hud.toast('Museum of Mild Curiosities. Walk up to an exhibit to read its plaque.', 5);
    else g.hud.toast('Tepid Falls Depot. The board shows the next Budget Line trains; tickets are at the window.', 5);
  }

  private out(forced = false): void {
    const g = this.game, p = g.player, vn = this.inside ? this.v[this.inside] : null;
    if (this.panel) this.closePanel();
    this.inside = null;
    this.spot = null;
    this.cull(false);
    this.hush(false);
    if (vn && vn.room) vn.room.group.visible = false;
    if (vn && vn.place && !forced) {
      const pl = vn.place;
      p.teleport(pl.x, pl.z, Math.atan2(pl.nx, pl.nz));
      g.cam.snap();
    }
  }
  /** Leave by the street door (for the tests and the card). */
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

  /** The library's hush: the town's sounds turned down while she is in, back to the sliders when she leaves. */
  private hush(on: boolean): void {
    const core = this.game.audio.core, s = save.data.settings;
    if (!core) { this.hushed = false; return; }
    if (on) { core.setVolumes({ master: s.volMaster, music: s.volMusic * 0.35, sfx: s.volSfx * 0.45, ambience: s.volAmbience * 0.3 }); this.hushed = true; }
    else if (this.hushed) { this.game.audio.applySettings(); this.hushed = false; }
  }

  private indoors(dt: number): void {
    const g = this.game, p = g.player, vn = this.v[this.inside as CivicId], room = vn.room;
    if (!room) { this.out(true); return; }
    const s = room.spec;
    if (this.inside === 'library' && !this.hushed && (this.hushT -= dt) <= 0) { this.hushT = 1; this.hush(true); }
    this.people(vn, dt);
    if (this.inside === 'depot') this.depotLive(vn, dt);
    if ((this.recheck -= dt) <= 0) { this.recheck = 2; const f0 = vn.folk[0]; if (f0 && !g.people.list.includes(f0.p)) this.spawnFolk(vn); }
    const u = p.x - vn.ox, v = p.z - vn.oz;
    if (Math.abs(u) > s.w / 2 + 0.3 || v < -0.3 || v > s.d + 0.3) { p.teleport(vn.ox + s.entry.u, vn.oz + s.entry.v, s.entry.h); p.person.y = ROOM_Y; }
    if (this.panel) return;
    if (!this.idle() || p.health <= 0) return;
    if (Math.hypot(u - s.door.u, v - s.door.v) < 1.4) {
      this.say(this.doorText, null);
      if (g.input.eat('interact')) this.out();
      return;
    }
    // The nearest thing to do within its reach.
    let best: Spot | null = null, bd = 1e9;
    for (const sp of s.spots) { const d = Math.hypot(u - sp.u, v - sp.v); if (d < sp.r && d < bd) { bd = d; best = sp; } }
    this.spot = best;
    if (!best) return;
    this.say(null, best);
    if (g.input.eat('interact')) this.use(best);
  }

  /** The prompt line, rebuilt only when its key changes (nothing is built per frame). */
  private say(door: string | null, sp: Spot | null): void {
    const what = sp ?? door;
    if (what !== this.pwhat || this.pver !== this.ver) {
      this.pwhat = what; this.pver = this.ver;
      if (sp) { const t = this.spotText(sp); this.ptxt = typeof t === 'function' ? t() : t; } else this.ptxt = door as string;
    }
    this.prompt = this.ptxt;
  }

  private spotText(sp: Spot): string | (() => string) {
    switch (sp.kind) {
      case 'shelf': { const b = BOOKS[sp.id], read = (this.books() >> sp.id & 1) === 1; return `[G] ${read ? 'Read again' : 'Borrow'}: ${b.title}`; }
      case 'desk': return '[G] Speak to the librarian';
      case 'plaque': { const e = EXHIBITS[sp.id]; return `[G] Read the plaque: ${e.title}`; }
      case 'ticket': return '[G] Ticket window: buy a ride on the Budget Line';
      case 'board': return () => `[G] Departures: ${this.boardLine()}`;
      case 'clock': return () => `[G] The waiting-room clock: ${this.clockText()}`;
      case 'box': return () => this.game.todo.project.open ? `[G] Donation box: ${money(DONATE)} for the Millpond Promenade` : '[G] Donation box';
    }
  }

  private use(sp: Spot): void {
    const g = this.game;
    switch (sp.kind) {
      case 'shelf': this.borrow(sp.id); break;
      case 'desk': this.askLibrarian(); break;
      case 'plaque': this.readPlaque(sp.id); break;
      case 'ticket': this.openTicket(); break;
      case 'board': g.hud.toast(`Departures: ${this.boardLine()}`, 6); break;
      case 'clock': g.hud.toast(`${this.clockText()} The clock is right about twice a day, and the depot says that is plenty.`, 5); break;
      case 'box': this.donate(); break;
    }
  }

  // ── The library ────────────────────────────────────────────────────────────

  private borrow(i: number): void {
    const g = this.game, b = BOOKS[i], best = save.data.best, was = this.books();
    const now = was | (1 << i), fresh = now !== was;
    if (fresh) { best[KEY_BOOKS] = now; this.stats.books++; }
    const n = popcount(now);
    const all = n >= CARD.all, stamped = (this.stampMask() & STAMP_LIBRARY) !== 0;
    let msg = fresh ? `Borrowed. ${n} of ${CARD.all} books for the card.` : `You have read this one. ${n} of ${CARD.all} books for the card.`;
    if (all && !stamped) {
      best[KEY_STAMP] = this.stampMask() | STAMP_LIBRARY; this.stats.stamps++;
      msg = `That is all ${CARD.all}. The librarian stamps your Library card with great ceremony.`;
      g.hud.stamp(CARD.name.toUpperCase(), 'All ten books borrowed. Your fines are, as always, enormous.');
    }
    if (fresh) g.todo.saveNow();
    this.view = { title: b.title, sub: `by ${b.by}`, body: b.text, foot: b.late, rows: [], msg, close: 'Put it back' };
    this.openPanel('book');
  }

  private askLibrarian(): void {
    const n = popcount(this.books()), stamped = (this.stampMask() & STAMP_LIBRARY) !== 0;
    this.stats.desk++;
    const line = DESK_LINES[this.deskI++ % DESK_LINES.length];
    this.view = {
      title: 'The Librarian', sub: 'The Overdue Library',
      body: line,
      foot: stamped ? 'Library card: stamped. The librarian pretends not to be proud.' : `Library card: ${n} of ${CARD.all} books borrowed. ${n === 0 ? 'Try the shelves with the gold tabs.' : 'Keep going, the stamp is for all of them.'}`,
      rows: [], msg: '', close: 'Shh. Thanks',
    };
    this.openPanel('desk');
  }

  // ── The museum ─────────────────────────────────────────────────────────────

  private readPlaque(i: number): void {
    const g = this.game, e = EXHIBITS[i], best = save.data.best, was = this.plaques();
    const now = was | (1 << i), fresh = now !== was;
    if (fresh) { best[KEY_PLAQ] = now; this.stats.plaques++; }
    const n = popcount(now), all = n >= EXHIBITS.length, stamped = (this.stampMask() & STAMP_MUSEUM) !== 0;
    let msg = `Plaques read: ${n} of ${EXHIBITS.length}.`;
    if (all && !stamped) {
      best[KEY_STAMP] = this.stampMask() | STAMP_MUSEUM; this.stats.stamps++;
      msg = 'That is every plaque. The docent stamps your pass.';
      g.hud.stamp(MUSEUM_STAMP.toUpperCase(), 'Every exhibit read. You know the town better than most of its committees.');
    }
    if (fresh) g.todo.saveNow();
    this.view = { title: e.title, sub: e.years, body: e.text, foot: '', rows: [], msg, close: 'Done' };
    this.openPanel('plaque');
  }

  private donate(): void {
    const g = this.game, pr = g.todo.project;
    if (!pr.open) { g.hud.toast('The donation box is empty and a little hopeful. The Promenade fund opens once Tepid Falls is fully open.', 5); return; }
    const say = pr.donate(DONATE);
    if (say) { this.stats.donated += DONATE; g.hud.toast(`${say}. The docent writes it in the book, in cursive.`, 5); }
    else g.hud.toast('The box takes cash, and the fund has all it needs for now. Thank you anyway.', 4);
  }

  // ── The depot ──────────────────────────────────────────────────────────────

  /** The departures, soonest first: where, when, and whether the train stands in now. */
  boardRows(): BoardRow[] {
    const rail = this.game.rail, st = this.depotStation(), out: BoardRow[] = [];
    if (st < 0 || !rail.on) return out;
    if (!rail.open) { out.push({ to: 'SERVICE SUSPENDED', when: '--', here: false }); return out; }
    const stn = rail.stations;
    for (const t of rail.upcoming(st, BOARD_ROWS)) out.push({ to: (t.dir > 0 ? stn[stn.length - 1] : stn[0]).name, when: t.here ? 'NOW' : mmss(t.eta), here: t.here });
    return out;
  }
  private boardLine(): string { return this.board.length ? this.board.slice(0, 2).map((r) => `${r.to} ${r.when}`).join(' · ') : 'no train soon'; }
  private clockText(): string {
    const h = ((this.game.sky.hour % 24) + 24) % 24, hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ap = hh >= 12 ? 'pm' : 'am', h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm).padStart(2, '0')} ${ap}.`;
  }

  /** The board and the clock: redrawn when what they say changes (the board twice a second at most). */
  private depotLive(vn: Venue, dt: number): void {
    const room = vn.room;
    if (!room) return;
    if ((this.boardT -= dt) <= 0) {
      this.boardT = 0.5;
      const rows = this.boardRows(), sig = rows.map((r) => r.to + r.when).join('|');
      this.board = rows;
      if (sig !== this.boardSig) { this.boardSig = sig; this.ver++; room.drawBoard?.(rows, this.game.rail.open ? 'Times are live. Trains run in principle.' : 'The train is off its timetable.'); }
    }
    const min = Math.floor(this.game.sky.hour * 60);
    if (min !== this.clockMin) { this.clockMin = min; this.ver++; room.drawClock?.(this.game.sky.hour); }
  }

  private openTicket(): void {
    this.view = this.ticketView('');
    this.openPanel('ticket');
  }

  private ticketView(msg: string): CivicView {
    const rail = this.game.rail, from = this.depotStation(), rows: CivicRow[] = [];
    rail.stations.forEach((st, i) => {
      if (i === from) return;
      const s = rail.status(i, from), ok = s.ok;
      rows.push({ label: st.name, note: ok ? rail.etaText(i) : s.why, right: s.fare ? money(s.fare) : 'free', ok });
    });
    return { title: 'Ticket window', sub: `${DEPOT.name} · you have ${money(this.game.player.money)}${kid.on ? ' · kid mode rides free' : ''}`, body: '', foot: 'The clerk stamps it twice, once for luck.', rows, msg: msg || 'Where to?', close: 'Not today' };
  }

  /** Buy the nth row of the ticket card: out through the door and onto the train (item 8's fast travel). Returns the refusal, or ''. */
  buy(n: number): string {
    const rail = this.game.rail, from = this.depotStation();
    let k = -1, to = -1;
    for (let i = 0; i < rail.stations.length; i++) { if (i === from) continue; if (++k === n) { to = i; break; } }
    if (to < 0 || this.panel !== 'ticket') return '';
    const s = rail.status(to, from);
    if (!s.ok) { this.view = this.ticketView(s.why); this.rev++; return s.why; }
    this.stats.tickets++;
    this.out();
    return rail.travel(to, from);
  }

  // ── The card ───────────────────────────────────────────────────────────────

  private openPanel(k: CivicPanelKind): void { this.panel = k; this.rev++; this.ver++; }
  closePanel(): void {
    if (!this.panel) return;
    this.panel = null; this.rev++; this.ver++;
  }

  // ── Info ───────────────────────────────────────────────────────────────────

  info(): Record<string, unknown> {
    const o = (id: CivicId): Record<string, unknown> => { const v = this.v[id]; return { placed: !!v.place, room: !!v.room, facade: !!v.facade, folk: v.folk.length, open: this.on && this.isOpen(id) }; };
    return { on: this.on, inside: this.inside, panel: this.panel, library: o('library'), museum: o('museum'), depot: o('depot'), books: this.books(), plaques: this.plaques(), stamps: this.stampMask(), stats: this.stats, board: this.board };
  }
}
