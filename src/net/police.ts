// Multiplayer, stage 3, step 2: the same police for everyone.
//
// Heat stays each player's own. Every browser works out its own player's wanted level from its own deeds, exactly as
// alone (sim/police.ts), and shows it on its own screen only. The POLICE are one set in a town on the MAIN service:
// the host's browser dispatches and drives them for every wanted player out of the one budget of cars a single player
// game has (Police.budget), and everybody sees them.
//
// What travels.
//  - Each guest tells the host how wanted it is (ToHost Heat, 8 bytes, on change and every few seconds while wanted):
//    the level, whether an officer can see it right now, and where the Patrol last had it. The GUEST is the judge of
//    "seen" and so of escaping: it has its own player exactly and the same walls, and it is shown the same officers,
//    so the search clock runs there by the single player rules and nothing more is sent. The host follows.
//  - The cruisers are ordinary cars in the traffic frames (a cruiser's paint nibble says "on duty": bar lit, siren
//    on) and the officers ordinary people in the people frames (numbered from OFFICER_WID0, in uniform). So a guest
//    is rammed and blocked by cars that are already solid on its screen, and can ram, shoot and steal them by the
//    frames that already exist.
//  - What the police do to a guest the host decides and tells that guest alone (ToPlayer: Hurt, Bust, Crime); the
//    guest applies it by the single player rules (health off, booked and walked to the station, a level for an
//    officer down).
//  - The police beat (World, 5 bytes every two seconds) says "this host runs the town's police" and carries the
//    officers' shots for the others to see. A guest that hears no beat (an older host) keeps private police.
//
// Changing hands. A new host takes over the cruisers and officers it was showing where they stand; the wanted say so
// again within a moment and each car carries on after whoever is wanted and nearest. A browser that drops to single
// player or to the backup does the same and has private police again, its own heat untouched. On the backup, alone,
// and with no service nothing here is sent and the police are private, as before.

import type { Game } from '../core/game';
import type { Person, Vehicle } from '../core/api';
import { KINDS } from '../ent/vehicleSpecs';
import { Police, blankSuspect, type Cop, type Suspect, type Unit } from '../sim/police';
import {
  CRUISER_ON_DUTY, HEAT_BYTES, HEAT_HZ, HEAT_REFRESH_MS, HeatFlag, OFFICER_WID0, POLICE_BEAT_HEADER_BYTES, POLICE_BEAT_MS, POLICE_BUST_BYTES, POLICE_CRIMES,
  POLICE_CRIME_BYTES, POLICE_HURT_BYTES, POLICE_MAX_SHOTS, POLICE_SHOT_BYTES, PlayerMode, ToHostKind, ToPlayerKind, TrafficFlag,
  decodeHeat, decodePoliceBeat, decodePoliceCrime, decodePoliceHurt, encodeHeat, encodePoliceBeat, encodePoliceBust, encodePoliceCrime, encodePoliceHurt, frameSender,
  type PoliceShot,
} from './protocol';
import type { Connection } from './conn';
import type { Remote } from './remote';
import type { SharedTraffic } from './shared';
import { townLook, type TownPeople } from './people';

/** A guest that hears no police beat for this long has a host that runs none: private police. */
const STALE_MS = 6000;
/** ...and one whose host has just changed gives the new one this long to say that it does (a beat goes every two seconds). */
const CHANGE_MS = 4500;
/** A wanted player who has said nothing for this long is no longer chased. */
const HEAT_STALE_MS = 10000;
/** The host sees the others a little in the past: its cars aim this far ahead of where they are drawn. Seconds. */
const LEAD_S = 0.15;
/** Where the Patrol last had the player has to move this far to be worth telling the host again. Meters. */
const MOVED = 8;

interface Heard { at: number; seen: boolean; x: number; z: number }

export class TownPolice {
  /** local: private police (alone, the backup, or a host that runs none). host: running the town's. guest: shown the host's. */
  mode: 'local' | 'host' | 'guest' = 'local';
  readonly stats = {
    beatsSent: 0, beatBytesSent: 0, beatsGot: 0, shotsSent: 0, shotsGot: 0,
    heatsSent: 0, heatBytesSent: 0, heatsGot: 0,
    hurtsSent: 0, bustsSent: 0, crimesSent: 0, toPlayerBytes: 0, hurtsGot: 0, bustsGot: 0, crimesGot: 0,
    adopted: 0, adoptedOfficers: 0, handed: 0, takeovers: 0,
  };

  private readonly police: Police | null;
  // Host.
  private readonly suspects = new Map<number, Suspect>();
  private readonly heard = new Map<number, Heard>();
  private readonly shots: PoliceShot[] = [];
  private beatAt = 0;
  private readonly out = new Uint8Array(POLICE_BEAT_HEADER_BYTES + POLICE_MAX_SHOTS * POLICE_SHOT_BYTES);
  private nextOfficer = OFFICER_WID0;
  // Guest.
  private gotBeatAt = -1e9;
  private beatFrom = 0;
  private heatAt = -1e9;
  private heatHost = 0;
  private readonly told = { level: 0, flags: 0, x: 0, z: 0 };
  private readonly seenCars = new Set<Vehicle>();
  private readonly bodies = new Map<number, Person | null>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>, private readonly shared: SharedTraffic, private readonly people: TownPeople) {
    const police = this.police = game.systems.find((s): s is Police => s instanceof Police) ?? null;
    if (!police) return;
    shared.police = {
      each: (fn) => {
        if (this.mode !== 'host') return;
        const tr = shared.sim;
        for (const u of police.units) {
          if (u.shown || u.v.driver !== 'ai' || u.v.sunk) continue;
          if (!u.wid && tr) u.wid = tr.takeWid();
          if (u.wid) fn(u.wid, u.v, false, u.state === 'leave' ? 0 : CRUISER_ON_DUTY);
        }
      },
      adopt: (v, wid, paint, host) => {
        if (v.spec.kind !== 'cruiser' || paint !== CRUISER_ON_DUTY || v.driver !== 'ai') return false;
        const tr = shared.sim;
        police.adoptUnit(v, host && tr && tr.holdWid(wid) ? wid : 0);
        this.stats.adopted++;
        return true;
      },
      give: (v) => this.mode === 'host' && police.giveUnit(v),
      handOver: (fn) => {
        police.handOver((u) => { if (u.wid) { fn(u.wid, u.v, false, u.state === 'leave' ? 0 : CRUISER_ON_DUTY); this.stats.handed++; } else game.vehicles.remove(u.v); });
        // Still in town: the new host's police are this browser's too, as soon as it says it runs any.
        this.set('guest');
        this.gotBeatAt = performance.now();
        this.beatFrom = conn.host;
      },
    };
    people.police = {
      each: (fn) => {
        if (this.mode !== 'host') return;
        for (const c of police.cops) {
          if (c.shown) continue;
          if (!c.wid) { c.wid = this.officerWid(police); if (c.wid) c.p.look = townLook(game, c.wid); }
          if (c.wid) fn(c.wid, c.p, c.dead);
        }
      },
      hurt: (wid, by, dmg, dx, dz, fist, shove) => { if (this.mode === 'host') police.copHurt(wid, by, dmg, dx, dz, fist, shove); },
      struck: (wid, by, speed) => { if (this.mode === 'host') police.copStruck(wid, by, speed); },
      takeOver: (wid, x, z, h, down, health) => {
        const c = police.adoptCop(wid, x, z, h, down, health);
        c.p.look = townLook(game, wid);
        this.stats.adoptedOfficers++;
      },
    };
    police.onUnitGone = (u) => { if (u.wid && !u.shown) shared.sim?.freeWid(u.wid); };
    police.onHurt = (id, dmg, carDmg) => { if (this.mode === 'host' && conn.send(encodePoliceHurt(id, dmg, carDmg))) { this.stats.hurtsSent++; this.stats.toPlayerBytes += POLICE_HURT_BYTES; } };
    police.onBust = (id) => { if (this.mode === 'host' && conn.send(encodePoliceBust(id))) { this.stats.bustsSent++; this.stats.toPlayerBytes += POLICE_BUST_BYTES; } };
    police.onCrime = (id, kind, x, z, weight) => {
      const which = (POLICE_CRIMES as readonly string[]).indexOf(kind);
      if (this.mode === 'host' && which >= 0 && conn.send(encodePoliceCrime(id, which, weight, x, z))) { this.stats.crimesSent++; this.stats.toPlayerBytes += POLICE_CRIME_BYTES; }
    };
    police.onShot = (c, _mx, _my, _mz, tx, ty, tz) => { if (c.wid && this.shots.length < POLICE_MAX_SHOTS) this.shots.push({ officer: c.wid, x: tx, y: ty, z: tz }); };
  }

  private officerWid(police: Police): number {
    for (let k = 0; k < 32; k++) {
      const w = this.nextOfficer;
      this.nextOfficer = w >= 255 ? OFFICER_WID0 : w + 1;
      if (!police.cops.some((c) => c.wid === w)) return w;
    }
    return 0;
  }

  // ── Who runs the police ─────────────────────────────────────────────────────

  private set(mode: 'local' | 'host' | 'guest'): void {
    const police = this.police as Police, was = this.mode;
    if (mode === was) return;
    this.mode = police.mode = mode;
    const tr = this.shared.sim;
    if (was === 'guest') {
      // Whatever was shown and has not been taken over is the host's still (or gone with it).
      police.dropShown();
      this.seenCars.clear(); this.bodies.clear();
      this.stats.takeovers++;
    }
    if (was === 'host') {
      // Nobody to run them for: the cars stay, as this browser's private police, without numbers.
      for (const u of police.units) if (u.wid) { tr?.freeWid(u.wid); u.wid = 0; }
      for (const c of police.cops) c.wid = 0;
      police.others.length = 0;
      this.suspects.clear(); this.heard.clear(); this.shots.length = 0;
    }
    if (mode === 'guest') {
      // The host's police are the police now. (Any private ones go at once: the host sends its own after the wanted.)
      police.clear();
      this.told.level = -1;
    } else if (mode === 'host') {
      this.beatAt = 0;
      // (An officer taken over keeps their number; private ones get theirs when first sent.)
    } else {
      for (const u of police.units) if (u.wid) { tr?.freeWid(u.wid); u.wid = 0; }
      for (const c of police.cops) c.wid = 0;
    }
  }

  private sync(now: number): void {
    const sm = this.shared.mode;
    if (sm === 'host') this.set('host');
    else if (sm === 'guest') {
      const fresh = now - this.gotBeatAt < STALE_MS && (this.beatFrom === this.conn.host || now - this.gotBeatAt < CHANGE_MS);
      if (this.mode === 'host') this.set('local');
      if (fresh) this.set('guest'); else if (this.mode === 'guest') this.set('local');
    } else this.set('local');
  }

  // ── Host ───────────────────────────────────────────────────────────────────

  private suspect(id: number): Suspect {
    let s = this.suspects.get(id);
    if (!s) this.suspects.set(id, s = blankSuspect(id));
    return s;
  }

  private host(now: number): void {
    const police = this.police as Police, g = this.game, list = police.others;
    list.length = 0;
    for (const id of this.suspects.keys()) if (!this.remotes.has(id)) { this.suspects.delete(id); this.heard.delete(id); }
    for (const r of this.remotes.values()) {
      if (!r.seen) continue;
      const s = this.suspect(r.id), h = this.heard.get(r.id);
      s.vx = r.vx; s.vz = r.vz;
      s.x = r.x + r.vx * LEAD_S; s.y = r.y; s.z = r.z + r.vz * LEAD_S;
      s.speed = Math.hypot(r.vx, r.vz);
      s.vehicle = r.vehicle;
      s.out = r.mode === PlayerMode.Down;
      if (s.level > 0 && (!h || now - h.at > HEAT_STALE_MS)) s.level = 0;
      if (h && s.level > 0) {
        // Their browser is the judge of whether they are in sight; while they are, where they are is where they were last seen.
        if (h.seen) { s.lastSeen = g.time; s.kx = s.x; s.kz = s.z; } else { s.kx = h.x; s.kz = h.z; }
      }
      s.radius = s.level > 0 ? (100 + 25 * s.level) * 0.7 : 0;
      list.push(s);
    }
    const shots = this.shots;
    if (now - this.beatAt >= POLICE_BEAT_MS || (shots.length > 0 && now - this.beatAt >= 100)) {
      let duty = 0;
      for (const u of police.units) if (u.state !== 'leave') duty++;
      const len = encodePoliceBeat(duty, shots, shots.length, this.out);
      if (this.conn.send(this.out.subarray(0, len))) {
        this.stats.beatsSent++; this.stats.beatBytesSent += len; this.stats.shotsSent += shots.length;
        this.beatAt = now;
      }
      shots.length = 0;
    }
  }

  /** Host: a ToHost frame about heat. Returns whether it was one. */
  toHost(buf: ArrayBuffer, now: number): boolean {
    if (buf.byteLength < 3 || new Uint8Array(buf, 2, 1)[0] !== ToHostKind.Heat) return false;
    const m = decodeHeat(buf), police = this.police;
    if (!m || !police || this.mode !== 'host' || !this.remotes.has(m.id)) return true;
    this.stats.heatsGot++;
    const s = this.suspect(m.id), g = this.game;
    // Just booked here, and their browser has not heard yet.
    if (m.level > 0 && g.time < s.quiet) return true;
    if (m.level > s.level) { s.lastSeen = g.time; s.spawnT = Math.min(s.spawnT, s.level === 0 ? 2 : 0.6); }
    s.level = m.level;
    s.incognito = (m.flags & HeatFlag.Incognito) !== 0;
    if (m.level === 0) { s.hold = 0; s.incognito = false; }
    let h = this.heard.get(m.id);
    if (!h) this.heard.set(m.id, h = { at: now, seen: false, x: m.x, z: m.z });
    h.at = now; h.seen = (m.flags & HeatFlag.Seen) !== 0; h.x = m.x; h.z = m.z;
    if (h.seen) s.lastSeen = g.time;
    s.kx = m.x; s.kz = m.z;
    return true;
  }

  // ── Guest ──────────────────────────────────────────────────────────────────

  /** A World frame from the host about its police: the beat, and any shots. */
  world(buf: ArrayBuffer, now: number): void {
    if (!this.police || this.shared.mode !== 'guest' || frameSender(buf) !== this.conn.host) return;
    const b = decodePoliceBeat(buf);
    if (!b) return;
    this.stats.beatsGot++;
    this.gotBeatAt = now; this.beatFrom = b.from;
    if (b.shots.length === 0) return;
    const g = this.game;
    for (const s of b.shots) {
      const p = this.bodies.get(s.officer);
      this.stats.shotsGot++;
      if (!p) continue;
      const dx = s.x - p.x, dz = s.z - p.z, d = Math.hypot(dx, dz) || 1;
      const mx = p.x + dx / d * 0.55, my = p.y + 1.38, mz = p.z + dz / d * 0.55;
      g.fx.emitters.muzzleFlash(mx, my, mz, dx / d, 0, dz / d);
      g.fx.emitters.tracer({ x: mx, y: my, z: mz }, { x: s.x, y: s.y, z: s.z });
      g.emit('gunshot', { x: mx, z: mz, by: 'patrol' });
    }
  }

  /** A ToPlayer frame from the host's police. Returns whether it was one. */
  toPlayer(buf: ArrayBuffer): boolean {
    if (buf.byteLength < 3) return false;
    const what = new Uint8Array(buf, 2, 1)[0];
    if (what !== ToPlayerKind.Hurt && what !== ToPlayerKind.Bust && what !== ToPlayerKind.Crime) return false;
    const police = this.police;
    if (!police || this.mode !== 'guest' || frameSender(buf) !== this.conn.host) return true;
    if (what === ToPlayerKind.Hurt) {
      const m = decodePoliceHurt(buf);
      if (m) { this.stats.hurtsGot++; police.hurtMe(m.dmg, m.carDmg); }
    } else if (what === ToPlayerKind.Bust) {
      this.stats.bustsGot++;
      police.bookMe();
      // (The host has stood its cars down already: say so at once, whatever the last frame said.)
      this.told.level = -1;
    } else {
      const m = decodePoliceCrime(buf), kind = m ? POLICE_CRIMES[m.which] : undefined;
      if (m && kind) { this.stats.crimesGot++; police.credit(kind, m.x, m.z, m.weight); }
    }
    return true;
  }

  private guest(now: number): void {
    const police = this.police as Police, g = this.game, me = police.me;
    // The host's cruisers on duty, as the Patrol's code here knows them: watched and lit, not driven.
    const cars = this.seenCars;
    cars.clear();
    this.shared.eachShown((wid, v, kind, paint, flags) => {
      if (KINDS[kind] !== 'cruiser' || paint !== CRUISER_ON_DUTY || (flags & TrafficFlag.Driverless) !== 0) return;
      cars.add(v);
      if (!police.units.some((u) => u.v === v)) police.showUnit(v, wid);
    });
    for (let i = police.units.length - 1; i >= 0; i--) { const u: Unit = police.units[i]; if (u.shown && !cars.has(u.v)) police.unshow(u); }
    const bodies = this.bodies;
    bodies.clear();
    this.people.eachOfficer((wid, body) => bodies.set(wid, body));
    for (let i = police.cops.length - 1; i >= 0; i--) {
      const c: Cop = police.cops[i];
      if (!c.shown) continue;
      const b = bodies.get(c.wid);
      if (!b) police.unshow(c); else c.p = b;
    }
    for (const [wid, b] of bodies) if (b && !police.cops.some((c) => c.shown && c.wid === wid)) police.showCop(b, wid);

    // How wanted this player is, told to the host when it changes.
    const t = this.told, pl = g.player;
    const level = me.level;
    const flags = level > 0 ? (police.status.seen ? HeatFlag.Seen : 0) | (me.incognito ? HeatFlag.Incognito : 0) | (pl.person.pose === 'down' && !pl.vehicle ? HeatFlag.Out : 0) : 0;
    if (this.heatHost !== this.conn.host) { this.heatHost = this.conn.host; t.level = -1; }
    if (level === 0 && t.level === 0) return;
    const moved = level > 0 && (flags & HeatFlag.Seen) === 0 && Math.abs(me.kx - t.x) + Math.abs(me.kz - t.z) > MOVED;
    const changed = level !== t.level || flags !== t.flags || moved;
    if (!(changed && now - this.heatAt >= 1000 / HEAT_HZ) && now - this.heatAt < HEAT_REFRESH_MS) return;
    if (!this.conn.send(encodeHeat(level, flags, me.kx, me.kz))) return;
    t.level = level; t.flags = flags; t.x = me.kx; t.z = me.kz;
    this.heatAt = now;
    this.stats.heatsSent++; this.stats.heatBytesSent += HEAT_BYTES;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(now: number): void {
    if (!this.police) return;
    this.sync(now);
    if (this.mode === 'host') this.host(now);
    else if (this.mode === 'guest') this.guest(now);
  }

  /** For the tests (window.__game.net().police). */
  info(): Record<string, unknown> {
    const police = this.police, r2 = (v: number): number => +v.toFixed(2);
    if (!police) return { mode: this.mode };
    const me = police.me, mine = this.conn.id;
    return {
      mode: this.mode, ...this.stats, budget: police.budget(),
      // This browser's own player: the level on its own screen, and whether an officer can see them.
      level: me.level, seen: police.status.seen, searching: police.status.searching, booked: police.stats.booked, bookedOthers: police.stats.bookedOthers,
      spawned: police.stats.spawned, shots: police.stats.shots, hits: police.stats.hits, crimes: police.stats.crimes, lastCrime: police.stats.lastCrime,
      // Host: everybody else and how wanted the host believes them.
      // share: this player's own share of the budget of cars; wanted[].cars: each other player's.
      share: me.wantP + me.wantB,
      wanted: police.others.map((s) => ({ id: s.id, level: s.level, cars: s.wantP + s.wantB })),
      // after: whom a car or an officer is chasing, by their number in town (a guest does not know: 0).
      units: police.units.map((u) => ({ id: u.wid, x: r2(u.v.x), z: r2(u.v.z), h: r2(u.v.h), speed: r2(u.v.speed), state: u.state, role: u.role, lit: u.state !== 'leave', shown: u.shown, sees: u.sees, crew: u.crew.length, after: u.shown ? 0 : u.target.id || mine })),
      officers: police.cops.map((c) => ({ id: c.wid, x: r2(c.p.x), z: r2(c.p.z), pose: c.p.pose, health: Math.round(c.p.health), shown: c.shown, sees: c.sees, mode: c.mode, car: c.unit ? c.unit.wid || -1 : 0, after: c.shown ? 0 : c.target.id || mine })),
      sirens: police.status.sirens,
    };
  }
}
