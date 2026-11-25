// Milestone 4, "things to do": the one system Game registers. It owns the
// save, the mission runner, the jobs and the menu, and runs them in a fixed
// order each frame so they can share one prompt line, one set of radar blips
// and one pool of world markers.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import { progress } from '../world/progress';
import { capture, restore, save, type Settings } from './save';
import { season } from '../world/season';
import { Markers, Runner, type Pt } from './script';
import { story } from './missions';
import type { Blip } from '../ui/hud';
import { Activities } from './activities';
import { Racing } from './race';
import { RaceBuilder } from './raceBuilder';
import { Delivery } from './delivery';
import { Gigs } from './gigs';
import { Plow } from './plow';
import { Fishing } from './fishing';
import { Semester } from './semester';
import { Heist } from './heist';
import { Pursuit } from './pursuit';
import { Derby } from './derby';
import { TownEvents } from './events';
import { Finds } from './finds';
import { Shops } from './shops';
import { Menu } from '../ui/menu';
import { Navigator } from './nav';
import { Autopilot } from './autopilot';
import { Cab } from './travel';
import { ARRIVE, places, type Place } from '../world/business';
import { ShopSigns } from '../world/shopSigns';

/** Seconds between autosaves, on the wall clock. */
const AUTOSAVE = 10;

export class ThingsToDo {
  readonly save = save;
  /** What has the floor: a mission id, a job name, or null when she is at a loose end. Only one thing runs at a time. */
  busy: string | null = null;
  /** True when a saved game was picked up at boot. */
  readonly resumed: boolean;

  readonly markers: Markers;
  readonly missions: Runner;
  readonly jobs: Activities;
  /** Races, alone or with others in town (fun queue item 11). */
  readonly racing: Racing;
  /** The street race builder (game/raceBuilder.ts): the player's own races and the town's. */
  readonly raceBuilder: RaceBuilder;
  /** Delivery Rush from SpeedScan HQ or Pardon's (fun queue item 14). */
  readonly delivery: Delivery;
  /** Gigs: delivery orders between the directory's businesses (fun queue 2, item 14). */
  readonly gigs: Gigs;
  /** Snowplow and salt-truck routes from the yards when snow is lying (fun queue 2, item 20). */
  readonly plow: Plow;
  /** Fishing at the signed spots, with the Fish Log (fun queue 2, item 15). */
  readonly fishing: Fishing;
  /** The Semester: Dithers College courses, grades and the Transcript (fun queue 2, item 16). */
  readonly semester: Semester;
  /** "The Speed Scan": the SpeedScan HQ caper (fun queue 2, item 17). */
  readonly heist: Heist;
  /** Hot Pursuit: a police chase between players (fun queue item 12). */
  readonly pursuit: Pursuit;
  /** The demolition derby at Flounder Field (fun queue item 13). */
  readonly derby: Derby;
  /** The weekly town events: Derby Night, the Moose Festival, the Regatta, the Christmas Fair (fun queue 2, item 19). */
  readonly events: TownEvents;
  /** Lost ducks and bridge-bond receipts hidden across Tepid Falls (fun queue 2, item 22). */
  readonly finds: Finds;
  readonly shops: Shops;
  /** The Calamity Courtesy Cab: fast travel from the map (game/travel.ts). */
  readonly travel: Cab;
  readonly menu: Menu;
  private wasDown = false;
  /** Set from the map: somewhere the player asked to be shown the way to. */
  waypoint: Pt | null = null;
  /** The business the waypoint was set from (the Places list on the map): arriving at its door says its name. null for a click on the map. */
  dest: Place | null = null;
  private destWay: Pt | null = null;
  /** The way to the goal, along the streets (game/nav.ts), and the signs on the businesses' doors. */
  readonly navigator = new Navigator();
  /** "Drive me there": the car drives itself along the route (game/autopilot.ts). */
  readonly autopilot: Autopilot;
  readonly signs: ShopSigns;

  private prompting = false; private lastPrompt: string | null = null;
  private navT = 0; private navSig = '';
  private readonly blipBuf: Blip[] = [];
  private lastSave = performance.now();
  private lastX = NaN; private lastZ = 0;
  private seen = new WeakSet<Vehicle>();
  private airV: Vehicle | null = null; private airX = 0; private airZ = 0; private airT = 0;

  constructor(private readonly game: Game) {
    this.applySettings();
    this.resumed = restore(game);
    if (this.resumed && game.player.vehicle) this.seen.add(game.player.vehicle);
    this.markers = new Markers(game);
    const st = story(game);
    this.missions = new Runner(game, this.markers, st.givers, st.missions, (id) => this.setBusy(id), () => this.busy === null);
    this.jobs = new Activities(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.raceBuilder = new RaceBuilder(game);
    this.racing = new Racing(game, this.markers, () => this.raceBuilder.all(this.jobs.races), () => this.busy === null, (id) => this.setBusy(id));
    this.pursuit = new Pursuit(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.derby = new Derby(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.events = new TownEvents(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.finds = new Finds(game);
    this.delivery = new Delivery(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.gigs = new Gigs(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.plow = new Plow(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.fishing = new Fishing(game, () => this.busy === null);
    this.semester = new Semester(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.heist = new Heist(game, this.markers, () => this.busy === null, (id) => this.setBusy(id), st.givers.lou.at);
    this.shops = new Shops(game, this.markers);
    this.signs = new ShopSigns(game);
    this.travel = new Cab(game, this);
    this.autopilot = new Autopilot(game);
    this.menu = new Menu(game, this);

    game.on('enter', (e) => {
      if (this.seen.has(e.vehicle)) return;
      this.seen.add(e.vehicle);
      save.data.stats.cars++;
    });
    game.on('booked', () => { save.data.stats.booked++; });
    // A stranger's first minute: say where the work is.
    game.on('start', () => { if (!save.data.missions.length) game.hud.toast('Lou, the watchman at your yard, wants a word. He is the L on the radar: The Cannery, Strand Blvd.', 9); });
    // The tab is going away (closed, reloaded, sent to the background on a phone): this is the write that matters.
    addEventListener('pagehide', () => this.saveNow());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.saveNow(); });
  }

  /** A mission or a job takes the floor, or gives it back. While it is held the saved player stays where she took it up. */
  setBusy(id: string | null): void {
    if (id !== null) { capture(this.game); save.hold = true; this.busy = id; this.waypoint = null; return; }
    this.busy = null;
    save.hold = false;
    this.saveNow();
  }

  /** Write the document now, whatever the clock says. */
  saveNow(): void {
    if (this.game.state === 'play' || this.game.state === 'paused') capture(this.game);
    save.write();
    progress.save();
    this.lastSave = performance.now();
  }

  /** Push the saved settings into the systems that act on them. The menu calls this after every change. */
  applySettings(): void {
    const s: Settings = save.data.settings, g = this.game;
    g.input.sensitivity = s.sens;
    g.input.invertY = s.invertY;
    document.body.classList.toggle('reduced-motion', s.reducedMotion);
    season.pick = s.season;
    // "Full screen on tap" lives in ui/title.ts, which asks the document element. With the setting off the
    // request is answered here and goes nowhere; with it on, the browser's own method shows through again.
    const el = document.documentElement as unknown as Record<string, unknown>;
    if (s.fsTap) delete el.requestFullscreen;
    else el.requestFullscreen = (): Promise<void> => Promise.resolve();
  }

  /** A full new game: the save, the bridge and the town stages all go, and she is back on the Strand on the first morning. */
  newGame(): void {
    const g = this.game;
    this.missions.abandon();
    this.jobs.stop();
    this.delivery.stop();
    this.gigs.stop(undefined, false);
    this.plow.stop();
    this.semester.drop('New game.');
    this.heist.abandon('New game.');
    this.busy = null;
    save.hold = false;
    this.waypoint = null;
    save.wipe();
    progress.reset();
    g.player.reset();
    this.jobs.resetDucks();
    this.lastX = NaN;
    this.saveNow();
    g.hud.toast('New game. The Harbor Authority has no record of you, which is how it likes you.', 6);
  }

  /** Hold Backspace: out of wherever she is wedged, onto the nearest street corner. Nothing is wiped, nothing is paid. */
  unstick(): void {
    const g = this.game, p = g.player;
    if (!(p.health > 0)) return;
    const n = g.plan.nearestNode(p.x, p.z);
    const sx = p.x < n.x ? -1 : 1, sz = p.z < n.z ? -1 : 1;
    p.teleport(n.x + sx * (n.hx + 1.6), n.z + sz * (n.hz + 1.6));
    g.cam.snap();
    this.lastX = NaN;
    g.hud.toast(`Unstuck. You were always at ${g.plan.streetAt(p.x, p.z)}, according to the file.`, 5);
  }

  update(dt: number): void {
    const g = this.game;
    if (g.state !== 'play') return;
    this.travel.update(dt);
    this.tally(dt);
    this.markers.begin(dt);
    this.missions.update(dt);
    this.semester.update(dt);
    this.heist.update(dt);
    this.raceBuilder.tick();
    this.racing.update(dt);
    this.pursuit.update(dt);
    this.derby.update(dt);
    this.events.update(dt);
    this.finds.update(dt);
    this.delivery.update(dt);
    this.plow.update(dt);
    this.jobs.update(dt);
    this.gigs.update(dt, !!(this.delivery.prompt || this.jobs.prompt || this.plow.prompt));
    this.shops.update(dt);
    this.fishing.update(dt, !!(this.missions.prompt || this.semester.prompt || this.heist.prompt || this.racing.prompt || this.pursuit.prompt || this.delivery.prompt || this.jobs.prompt || this.plow.prompt || this.gigs.prompt || this.shops.prompt));
    const w = this.waypoint;
    if (w) this.markers.put(w.x, w.z, 'goal', 5, 30);
    this.markers.end();
    this.say(this.missions.prompt ?? this.semester.prompt ?? this.heist.prompt ?? this.racing.prompt ?? this.pursuit.prompt ?? this.delivery.prompt ?? this.plow.prompt ?? this.jobs.prompt ?? this.gigs.prompt ?? this.shops.prompt ?? this.events.prompt ?? this.fishing.prompt);
    // M or Tab (Back on a pad): straight to the map.
    if (g.input.eat('map')) { this.menu.tab = 0; g.setPaused(true); }
    const down = !(g.player.health > 0);
    if (down && !this.wasDown) save.data.stats.deaths++;
    this.wasDown = down;
    this.guide(dt);
    this.autopilot.update(dt);
    if (performance.now() - this.lastSave >= AUTOSAVE * 1000) this.saveNow();
  }

  /** One prompt line between everything in here; nobody else's prompt is cleared by it. */
  private say(text: string | null): void {
    if (text === this.lastPrompt) return;
    this.lastPrompt = text;
    if (text !== null) { this.game.hud.prompt(text); this.prompting = true; }
    else if (this.prompting) { this.game.hud.prompt(null); this.prompting = false; }
  }

  /** The radar: who has work, where the business in hand is, and the streets to take to it. */
  private guide(dt: number): void {
    const g = this.game, nav = g.hud.nav, p = g.player;
    this.arrive();
    if ((this.navT -= dt) <= 0) {
      this.navT = 0.25;
      const out = this.blipBuf;
      out.length = 0;
      this.missions.blips(out);
      this.semester.blips(out);
      this.heist.blips(out);
      this.jobs.blips(out);
      this.delivery.blips(out);
      this.gigs.blips(out);
      this.plow.blips(out);
      this.racing.blips(out);
      this.pursuit.blips(out);
      this.derby.blips(out);
      this.events.blips(out);
      this.finds.blips(out);
      this.shops.blips(out);
      const w = this.waypoint;
      if (w) { if (Math.hypot(p.x - w.x, p.z - w.z) < 14) this.waypoint = null; else out.push({ x: w.x, z: w.z, kind: 'way' }); }
      let sig = '';
      for (const b of out) sig += `${b.kind}${b.label ?? ''}${Math.round(b.x)},${Math.round(b.z)}${b.r ? 'r' + b.r : ''};`;
      if (sig !== this.navSig) { this.navSig = sig; nav.blips = out.slice(); nav.rev++; }
    }
    const to = this.target();
    const named = to === this.waypoint && this.dest ? this.dest.name : to === this.jobs.target ? this.jobs.targetName : to === this.gigs.target ? this.gigs.targetName : to === this.plow.target ? this.plow.targetName : null;
    g.hud.turn(this.navigator.update(dt, g.plan, p.x, p.z, to, named, nav));
  }

  /** Where the route line is going now: the mission, delivery or job in hand, else the waypoint. */
  target(): Pt | null { return this.missions.target ?? this.semester.target ?? this.heist.target ?? this.delivery.target ?? this.jobs.target ?? this.gigs.target ?? this.plow.target ?? this.waypoint; }

  /** Set the waypoint to a business's door (the Places list, a marker on the map) and work out the way at once, paused or not. */
  go(pl: Place | null): void {
    if (!pl) { this.waypoint = null; this.dest = null; this.destWay = null; return; }
    this.dest = pl; this.destWay = this.waypoint = { x: pl.x, z: pl.z };
    this.navT = 0; this.guide(1);
  }

  /** Every place in the town's directory, placed against the buildings as they stand now. */
  places(): Place[] { return places(this.game.plan); }

  /** Arrived at the door of the place she asked to be shown the way to: say where she is, and take the waypoint away. */
  private arrive(): void {
    const d = this.dest, p = this.game.player;
    if (!d) return;
    if (this.waypoint !== this.destWay) { this.dest = null; this.destWay = null; return; }
    if (Math.hypot(p.x - d.x, p.z - d.z) < ARRIVE) {
      this.game.hud.toast(`You have arrived: ${d.name}.`, 6);
      this.waypoint = null; this.dest = null; this.destWay = null;
    }
  }

  /** The statistics: distance by wheel and by foot, top speed, the longest flight. */
  private tally(dt: number): void {
    const p = this.game.player, st = save.data.stats, v = p.vehicle;
    st.played += dt;
    if (!Number.isNaN(this.lastX)) {
      const d = Math.hypot(p.x - this.lastX, p.z - this.lastZ);
      // Anything faster than 90 m/s was a teleport, not travel.
      if (d < 90 * dt + 0.5) { if (v) st.driven += d; else if (!p.swimming) st.walked += d; }
    }
    this.lastX = p.x; this.lastZ = p.z;
    if (v && p.speed > st.topSpeed && p.speed < 90) st.topSpeed = p.speed;

    if (v !== this.airV) { this.airV = v; this.airT = 0; }
    if (v && !v.sunk) {
      if (!v.onGround) {
        if (this.airT === 0) { this.airX = v.x; this.airZ = v.z; }
        this.airT = Math.max(this.airT, v.airTime, 0.001);
      } else if (this.airT > 0) {
        if (this.airT > st.airtime) { st.airtime = this.airT; st.airDist = Math.hypot(v.x - this.airX, v.z - this.airZ); }
        this.airT = 0;
      }
    }
  }
}
