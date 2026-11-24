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
import { Delivery } from './delivery';
import { Pursuit } from './pursuit';
import { Derby } from './derby';
import { Shops } from './shops';
import { Menu } from '../ui/menu';

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
  /** Delivery Rush from SpeedScan HQ or Pardon's (fun queue item 14). */
  readonly delivery: Delivery;
  /** Hot Pursuit: a police chase between players (fun queue item 12). */
  readonly pursuit: Pursuit;
  /** The demolition derby at Flounder Field (fun queue item 13). */
  readonly derby: Derby;
  readonly shops: Shops;
  readonly menu: Menu;
  private wasDown = false;
  /** Set from the map: somewhere the player asked to be shown the way to. */
  waypoint: Pt | null = null;

  private prompting = false; private lastPrompt: string | null = null;
  private navT = 0; private navSig = ''; private routeT = 9; private routeTo: Pt | null = null;
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
    this.racing = new Racing(game, this.markers, () => this.jobs.races, () => this.busy === null, (id) => this.setBusy(id));
    this.pursuit = new Pursuit(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.derby = new Derby(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.delivery = new Delivery(game, this.markers, () => this.busy === null, (id) => this.setBusy(id));
    this.shops = new Shops(game, this.markers);
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
    this.tally(dt);
    this.markers.begin(dt);
    this.missions.update(dt);
    this.racing.update(dt);
    this.pursuit.update(dt);
    this.derby.update(dt);
    this.delivery.update(dt);
    this.jobs.update(dt);
    this.shops.update(dt);
    const w = this.waypoint;
    if (w) this.markers.put(w.x, w.z, 'goal', 5, 30);
    this.markers.end();
    this.say(this.missions.prompt ?? this.racing.prompt ?? this.pursuit.prompt ?? this.delivery.prompt ?? this.jobs.prompt ?? this.shops.prompt);
    // M or Tab (Back on a pad): straight to the map.
    if (g.input.eat('map')) { this.menu.tab = 0; g.setPaused(true); }
    const down = !(g.player.health > 0);
    if (down && !this.wasDown) save.data.stats.deaths++;
    this.wasDown = down;
    this.guide(dt);
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
    if ((this.navT -= dt) <= 0) {
      this.navT = 0.25;
      const out = this.blipBuf;
      out.length = 0;
      this.missions.blips(out);
      this.jobs.blips(out);
      this.delivery.blips(out);
      this.racing.blips(out);
      this.pursuit.blips(out);
      this.derby.blips(out);
      this.shops.blips(out);
      const w = this.waypoint;
      if (w) { if (Math.hypot(p.x - w.x, p.z - w.z) < 14) this.waypoint = null; else out.push({ x: w.x, z: w.z, kind: 'way' }); }
      let sig = '';
      for (const b of out) sig += `${b.kind}${b.label ?? ''}${Math.round(b.x)},${Math.round(b.z)}${b.r ? 'r' + b.r : ''};`;
      if (sig !== this.navSig) { this.navSig = sig; nav.blips = out.slice(); nav.rev++; }
    }
    const to = this.missions.target ?? this.delivery.target ?? this.jobs.target ?? this.waypoint;
    this.routeT += dt;
    if (to !== this.routeTo || this.routeT > 1) {
      this.routeTo = to; this.routeT = 0;
      let route: number[] | null = null;
      if (to && Math.hypot(p.x - to.x, p.z - to.z) > 45) {
        const plan = g.plan, ids = plan.findPath(plan.nearestNode(p.x, p.z).id, plan.nearestNode(to.x, to.z).id);
        if (ids.length > 1 || Math.hypot(p.x - to.x, p.z - to.z) < 160) {
          const n = ids.map((id) => plan.nodes[id]);
          // Drop the first corner when she is already past it, and the last when the place is short of it.
          if (n.length > 1 && Math.hypot(p.x - n[1].x, p.z - n[1].z) < Math.hypot(n[0].x - n[1].x, n[0].z - n[1].z)) n.shift();
          const k = n.length;
          if (k > 1 && Math.hypot(to.x - n[k - 2].x, to.z - n[k - 2].z) < Math.hypot(n[k - 1].x - n[k - 2].x, n[k - 1].z - n[k - 2].z)) n.pop();
          route = [p.x, p.z];
          for (const q of n) route.push(q.x, q.z);
          route.push(to.x, to.z);
        }
      }
      if (route || nav.route) { nav.route = route; nav.rev++; }
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
