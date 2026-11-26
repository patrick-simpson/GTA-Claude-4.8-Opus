// Spectating (fun queue item 16): watch another player in town through a chase camera of their own.
//
// U (or SPECTATE in the pause menu, which lists everybody in town by name) puts this screen's camera behind another
// player: smoothed from where their state frames put them (net/remote.ts), turned with their heading, set back
// further for a bigger car. Left and right arrows (A and D, Q and E, a swipe, or the arrows on the banner) go to the
// next or previous player; Esc, U or "Back" returns the camera. A banner says who is watched and what they are doing
// ("driving the C-Max · 2nd in the race · 43 mph · Old Harbor").
//
// While watching, her own character stands where she was: her controls are off, and the net says she is paused
// exactly as photo mode does (net/index.ts, two hook lines), so she cannot be hurt and is never picked to host. It
// cannot be used as a shield: the pause guard applies, and she must be standing or stopped.
//
// A race, Hot Pursuit or derby that this player is not in brings up a prompt, "Watch the race? [U]": the wire frames
// of those rounds already reach every screen (the race's checkpoint frames give the places), so they are only
// listened to here (the got() of game/race.ts, game/pursuit.ts and game/derby.ts is wrapped, nothing is sent).
// No protocol change: everything shown comes from what this browser already receives.
//
// Camera: Game.tick calls update() right after the camera rig, so the rig and the replay run as usual and this only
// overrides the lens afterwards. Photo mode still opens over it (it has the frame while open); the replay is stopped
// on entry and its key is not heard while watching. Costs nothing while off: one comparison per frame and a check of
// the round trackers every half second.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Remote } from '../net/remote';
import { nameText } from '../net/names';
import { SPECS } from '../ent/vehicleSpecs';
import { EMOTES } from '../game/emotes';
import { WATER_Y, groundAt } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import { angleDiff, clamp } from '../core/util';

const MPH = 2.23694;
/** Rounds whose frames have stopped for this long are taken to be over, ms. */
const ROUND_QUIET_MS = 180_000;
/** The prompt is offered again this long after it was put away, ms. */
const PROMPT_AGAIN_MS = 60_000;

type RoundKind = 'race' | 'pursuit' | 'derby';
interface Round {
  kind: RoundKind; caller: number; ids: number[]; cop: number; route: number;
  counts: Map<number, number>; done: Map<number, number>; out: Set<number>; last: number;
}
interface WireLike { kind: number; caller: number; route?: number; ids?: number[]; bytes?: ArrayLike<number>; a?: number; count?: number; ms?: number; how?: number }
interface Gettable { got: (from: number, m: never) => void; phase?: string }

const ord = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const NOUN: Record<RoundKind, string> = { race: 'race', pursuit: 'Hot Pursuit', derby: 'derby' };

export class Spectate {
  on = false;
  /** The player watched (a player id), and their name as it was when chosen (for "left town"). */
  id = 0;
  private name = '';
  /** For the tests. */
  readonly stats = { started: 0, switched: 0, left: 0, refused: 0, lostTarget: 0, prompts: 0 };
  banner = '';
  prompt = '';

  private root: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private pick: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private savedInput = true;
  private yaw = 0;
  private snapNext = true;
  private readonly cam = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly rounds = new Map<string, Round>();
  private promptKey = '';
  private promptHidden = new Map<string, number>();
  private checkT = 0;
  private bannerT = 0;
  private wrapped = false;
  private swipeX = 0; private swipeId = -1;

  constructor(private readonly game: Game) {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!this.on) {
        if (game.input.is(e.code, 'spectate') && !e.repeat && game.state === 'play' && !game.photo?.open) { e.preventDefault(); this.quick(); }
        return;
      }
      // Watching: every key stops here (nothing else hears it, as in photo mode), except photo mode's own key.
      if (game.input.is(e.code, 'photo')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Escape' || game.input.is(e.code, 'spectate') || e.code === 'Backspace') this.stop();
      else if (e.code === 'ArrowRight' || e.code === 'KeyD' || e.code === 'KeyE' || e.code === 'Tab') this.next(1);
      else if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'KeyQ') this.next(-1);
    };
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', (e) => { if (this.on && !game.input.is(e.code, 'photo')) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    // The pause menu gets a SPECTATE button while anybody else is in town.
    game.on('pause', (e) => { if (e.on) this.menuButton(); else this.closePick(); });
  }

  // ── Who is there ───────────────────────────────────────────────────────────

  private remotes(): Map<number, Remote> | null {
    const n = (this.game as unknown as { net?: { remotes?: Map<number, Remote> } }).net;
    return n?.remotes ?? null;
  }

  /** Everybody this screen can watch, in id order. */
  others(): Remote[] {
    const m = this.remotes();
    return m ? [...m.values()].filter((r) => r.seen).sort((a, b) => a.id - b.id) : [];
  }

  private me(): number {
    const t = this.todo();
    const link = (t?.racing as unknown as { link?: { me(): number } | null } | undefined)?.link;
    return link ? link.me() : 0;
  }

  private todo(): Record<string, unknown> | null {
    return (this.game as unknown as { todo?: Record<string, unknown> }).todo ?? null;
  }

  // ── Starting and stopping ──────────────────────────────────────────────────

  /** Why spectating may not start now, or null. */
  private why(): string | null {
    const g = this.game;
    if (g.state !== 'play') return 'Not now.';
    if (!this.others().length) return 'Nobody else is in town to watch.';
    const guard = g.pauseGuard ? g.pauseGuard() : null;
    if (guard) return guard.replace(/paus(e|ing)/gi, 'spectating');
    const v = g.player.seated;
    if (v && Math.hypot(v.vx ?? 0, v.vz ?? 0) > 2) return 'Stop the car first to spectate.';
    return null;
  }

  /** U: watch the round on offer if there is one, else the nearest player. */
  private quick(): void {
    const r = this.offered();
    if (r) { const ids = this.order(r); const id = ids.find((x) => this.remotes()?.get(x)?.seen); if (id) { this.start(id); return; } }
    const g = this.game, list = this.others();
    if (!list.length) { this.start(0); return; }
    list.sort((a, b) => Math.hypot(a.x - g.player.x, a.z - g.player.z) - Math.hypot(b.x - g.player.x, b.z - g.player.z));
    this.start(list[0].id);
  }

  /** Start watching player `id` (0: the first in town). Returns whether it started. */
  start(id = 0): boolean {
    const g = this.game;
    const why = this.why();
    if (why) { this.stats.refused++; g.hud.toast(why, 3); return false; }
    const list = this.others();
    const r = list.find((x) => x.id === id) ?? list[0];
    if (this.on) { this.watch(r); return true; }
    const rp = g.cam.replay as unknown as { playing?: boolean; stop?: () => void };
    if (rp.playing && rp.stop) rp.stop();
    this.build();
    const inp = g.input as unknown as { enabled?: boolean };
    this.savedInput = inp.enabled !== false;
    g.input.setEnabled(false);
    g.input.unlock();
    this.on = true;
    this.stats.started++;
    document.body.classList.add('pc-spectate');
    this.hidePrompt();
    this.watch(r);
    return true;
  }

  stop(): void {
    if (!this.on) return;
    const g = this.game;
    this.on = false;
    this.id = 0;
    this.banner = '';
    document.body.classList.remove('pc-spectate');
    if (g.state === 'play') {
      g.input.setEnabled(this.savedInput);
      if (!g.input.touch) g.input.lock();
    }
    g.cam.snap();
    this.stats.left++;
  }

  /** The next (+1) or previous (-1) player. */
  next(dir: number): void {
    if (!this.on) return;
    const list = this.others();
    if (!list.length) { this.stop(); return; }
    const i = list.findIndex((r) => r.id === this.id);
    const r = list[((i < 0 ? 0 : i + dir) % list.length + list.length) % list.length];
    if (r.id !== this.id) { this.stats.switched++; this.watch(r); }
  }

  private watch(r: Remote): void {
    this.id = r.id;
    this.name = nameText(r.name);
    this.snapNext = true;
    this.bannerT = 0;
  }

  // ── Every frame (Game.tick, after the camera rig) ──────────────────────────

  update(dt: number): void {
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.5; this.wrap(); this.offer(); }
    if (!this.on) return;
    const g = this.game;
    if (g.state !== 'play') { this.stop(); return; }
    let r = this.remotes()?.get(this.id);
    if (!r || !r.seen) {
      // They left: the next one, or back home.
      const gone = this.name;
      this.stats.lostTarget++;
      const list = this.others();
      if (!list.length) { this.stop(); g.hud.toast(`${gone} left town. Back to you.`, 4); return; }
      g.hud.toast(`${gone} left town. Watching ${nameText(list[0].name).replace(/\.$/, '')}.`, 4);
      this.watch(list[0]);
      r = list[0];
    }
    this.place(r, dt);
    this.bannerT -= dt;
    if (this.bannerT <= 0) { this.bannerT = 0.25; this.drawBanner(r); }
  }

  /** Their own chase camera: behind them, turned with their heading, set back for the size of their car. */
  private place(r: Remote, dt: number): void {
    const g = this.game, v = r.vehicle, cam = g.camera;
    const spec = r.kind ? SPECS[r.kind] : null;
    const px = v ? v.x : r.x, pz = v ? v.z : r.z, py = v ? v.y : r.y;
    const h = v ? v.h : r.h;
    const len = spec ? (spec as unknown as { length?: number }).length ?? 4.5 : 0;
    const hgt = spec ? spec.height : 0;
    const dist = spec ? 4.2 + len * 0.55 : 4.2;
    const up = spec ? 1.5 + hgt * 0.55 : 1.55;
    const pivotY = py + (spec ? hgt * 0.6 + 0.3 : 1.45);
    // The heading is followed on a spring: tightly in a car going forward, loosely on foot, not at all reversing.
    const moving = spec ? r.speed > 1 : r.speed > 0.8;
    if (this.snapNext) this.yaw = h;
    else if (moving) this.yaw += angleDiff(this.yaw, h) * (1 - Math.exp(-(spec ? 3.5 : 2.2) * dt));
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let dx = -fx * dist, dy = up, dz = -fz * dist;
    // A wall between them and the lens pulls the lens in.
    const want = Math.hypot(dx, dy, dz);
    const col = g.col as unknown as { raycast?: (x: number, y: number, z: number, dx: number, dy: number, dz: number, max: number) => number };
    if (col.raycast) {
      const d = col.raycast(px, pivotY, pz, dx / want, dy / want, dz / want, want + 0.4);
      if (d < want + 0.4) { const k = clamp((d - 0.4) / want, 0.25, 1); dx *= k; dy *= k; dz *= k; }
    }
    const tx = px + dx, tz = pz + dz;
    let ty = pivotY + dy;
    const floor = Math.max(groundAt(tx, tz), WATER_Y, waterLevelAt(tx, tz)) + 0.5;
    if (ty < floor) ty = floor;
    if (this.snapNext) { this.cam.set(tx, ty, tz); this.snapNext = false; }
    else {
      const k = 1 - Math.exp(-10 * dt);
      this.cam.x += (tx - this.cam.x) * k; this.cam.y += (ty - this.cam.y) * k; this.cam.z += (tz - this.cam.z) * k;
    }
    this.look.set(px + fx * 2.5, pivotY + 0.2, pz + fz * 2.5);
    cam.position.copy(this.cam);
    cam.lookAt(this.look);
  }

  /** What they are doing, in words. */
  doing(r: Remote): string {
    const bits: string[] = [];
    const spec = r.kind ? SPECS[r.kind] : null;
    if (spec) bits.push(`driving the ${spec.name}`);
    else if (r.rideOf) { const o = this.remotes()?.get(r.rideOf); bits.push(r.rideOf === this.me() ? 'riding with you' : `riding with ${o ? nameText(o.name) : 'a friend'}`); }
    else if (r.pose === 'swim') bits.push('swimming');
    else if (r.speed > 3.2) bits.push('running');
    else if (r.speed > 0.6) bits.push('walking');
    else bits.push('on foot');
    const rd = this.roundOf(r.id);
    if (rd) {
      if (rd.kind === 'race') {
        const place = this.order(rd).indexOf(r.id) + 1;
        bits.push(rd.done.has(r.id) ? `finished the race ${ord(place)}` : `${ord(place)} in the race`);
      } else if (rd.kind === 'pursuit') bits.push(rd.cop === r.id ? 'the cop in Hot Pursuit' : rd.out.has(r.id) ? 'busted' : 'wanted');
      else bits.push(rd.out.has(r.id) ? 'out of the derby' : 'in the derby');
    }
    const now = performance.now();
    if (r.emote && now - r.emoteAt < 8000) { const e = EMOTES.find((x) => x.id === r.emote); if (e) bits.push(`emoting: ${e.name.toLowerCase()}`); }
    if (r.paused) bits.push('paused');
    else if (r.job) bits.push(r.job);
    return bits.join(' · ');
  }

  private drawBanner(r: Remote): void {
    const g = this.game;
    const mph = Math.round(Math.abs(r.speed) * MPH);
    const where = g.plan.placeName(r.x, r.z);
    this.banner = `Watching ${nameText(r.name)} · ${this.doing(r)} · ${mph} mph · ${where}`;
    if (this.bar) {
      const n = this.others().length;
      (this.bar.querySelector('.sp-who') as HTMLElement).textContent = `Watching ${nameText(r.name)}`;
      (this.bar.querySelector('.sp-what') as HTMLElement).textContent = `${this.doing(r)} · ${mph} mph · ${where}`;
      const touch = g.input.touch || !!document.querySelector('#touch.show');
      (this.bar.querySelector('.sp-n') as HTMLElement).textContent = touch ? (n > 1 ? `${n} in town · swipe or ◀ ▶ to switch` : '')
        : n > 1 ? `${n} in town · ← → to switch · Esc to return` : 'Esc to return';
    }
  }

  // ── Rounds that this player is not in ─────────────────────────────────────

  /** Listen to the wire frames of races, Hot Pursuit and derbies (once their trackers exist). */
  private wrap(): void {
    if (this.wrapped) return;
    const t = this.todo();
    if (!t) return;
    this.wrapped = true;
    const hook = (o: unknown, kind: RoundKind): void => {
      const x = o as Gettable | undefined;
      if (!x || typeof x.got !== 'function') return;
      const orig = x.got.bind(x) as (from: number, m: WireLike) => void;
      (x as unknown as { got: (from: number, m: WireLike) => void }).got = (from: number, m: WireLike): void => {
        try { this.heard(kind, from, m); } catch { /* a tracker that changed shape is only not watched */ }
        orig(from, m);
      };
    };
    hook(t.racing, 'race');
    hook(t.pursuit, 'pursuit');
    hook(t.derby, 'derby');
  }

  private heard(kind: RoundKind, from: number, m: WireLike): void {
    const key = kind + ':' + m.caller, now = performance.now();
    let r = this.rounds.get(key);
    // Kinds: race Go 3, Cp 4, Done 5, Off 6; pursuit Go 3, Bust 6, Done 7, Off 8; derby Go 3, Done 8, End 7, Off 9.
    if (m.kind === 3) {
      const ids = kind === 'derby' ? Array.from(m.bytes ?? []) : (m.ids ?? []).slice();
      if (kind === 'derby' && from !== m.caller) return;
      r = { kind, caller: m.caller, ids, cop: kind === 'pursuit' ? m.a ?? 0 : 0, route: m.route ?? 0, counts: new Map(), done: new Map(), out: new Set(), last: now };
      this.rounds.set(key, r);
      return;
    }
    if (!r) return;
    r.last = now;
    const off = kind === 'race' ? 6 : kind === 'pursuit' ? 8 : 9;
    if (m.kind === off || (kind === 'derby' && m.kind === 7)) { this.rounds.delete(key); return; }
    if (kind === 'race') {
      if (m.kind === 4) r.counts.set(from, Math.max(r.counts.get(from) ?? 0, m.count ?? 0));
      else if (m.kind === 5) r.done.set(from, m.how === 1 ? m.ms ?? 1e9 : 1e12);
    } else if (kind === 'pursuit') {
      if (m.kind === 6) r.out.add(from);
      else if (m.kind === 7) r.done.set(from, 1);
    } else if (m.kind === 8) r.out.add(from);
    if (r.done.size >= r.ids.length) r.last = Math.min(r.last, now - ROUND_QUIET_MS + 15_000);
  }

  /** The round player `id` is in, if any. */
  private roundOf(id: number): Round | null {
    for (const r of this.rounds.values()) if (r.ids.includes(id)) return r;
    return null;
  }

  /** The racers in order: finished by time, then checkpoints passed, then nearness to the next one. */
  private order(r: Round): number[] {
    if (r.kind !== 'race') return r.ids.filter((id) => id !== r.cop).concat(r.cop ? [r.cop] : []);
    const races = ((this.todo()?.jobs as { races?: { idx: number; cps: { x: number; z: number }[] }[] } | undefined)?.races) ?? [];
    const def = races.find((d) => d.idx === r.route);
    const rem = this.remotes();
    const dist = (id: number): number => {
      const p = rem?.get(id), n = r.counts.get(id) ?? 0;
      if (!p || !def || !def.cps.length) return 9999;
      const c = def.cps[n % def.cps.length];
      return Math.hypot(p.x - c.x, p.z - c.z);
    };
    return r.ids.slice().sort((a, b) => {
      const da = r.done.get(a), db = r.done.get(b);
      if (da !== undefined || db !== undefined) return da !== undefined && db !== undefined ? da - db : da !== undefined ? -1 : 1;
      return (r.counts.get(b) ?? 0) - (r.counts.get(a) ?? 0) || dist(a) - dist(b);
    });
  }

  /** The round to offer: running, this player not in it, somebody in it here to watch. */
  private offered(): Round | null {
    const now = performance.now(), me = this.me(), rem = this.remotes();
    for (const [k, r] of this.rounds) {
      if (now - r.last > ROUND_QUIET_MS || !r.ids.some((id) => rem?.has(id))) { this.rounds.delete(k); continue; }
      if (r.ids.includes(me)) continue;
      return r;
    }
    return null;
  }

  private offer(): void {
    const g = this.game;
    const r = this.on || g.state !== 'play' ? null : this.offered();
    const key = r ? r.kind + ':' + r.caller : '';
    const hiddenAt = this.promptHidden.get(key) ?? -1e9;
    if (!r || performance.now() - hiddenAt < PROMPT_AGAIN_MS) { if (this.prompt) this.hidePrompt(false); return; }
    if (key === this.promptKey) return;
    this.promptKey = key;
    this.prompt = `Watch the ${NOUN[r.kind]}? [U]`;
    this.stats.prompts++;
    this.build();
    const el = this.promptEl as HTMLElement;
    const touch = g.input.touch || !!document.querySelector('#touch.show');
    (el.querySelector('.sp-pt') as HTMLElement).textContent = touch ? `Watch the ${NOUN[r.kind]}?` : this.prompt;
    el.classList.toggle('touch', touch);
    el.classList.add('on');
  }

  /** Put the prompt away (true: for a while, for this round). */
  private hidePrompt(forAWhile = true): void {
    if (forAWhile && this.promptKey) this.promptHidden.set(this.promptKey, performance.now());
    this.prompt = ''; this.promptKey = '';
    this.promptEl?.classList.remove('on');
  }

  // ── The pause menu's list ─────────────────────────────────────────────────

  private menuButton(): void {
    const ft = document.querySelector('#menu .mn-ft');
    if (!ft) return;
    let b = ft.querySelector<HTMLButtonElement>('.mn-spec');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button'; b.className = 'mn-btn mn-spec'; b.textContent = 'Spectate';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.openPick(); });
      ft.insertBefore(b, ft.querySelector('.mn-new'));
    }
    b.style.display = this.others().length ? '' : 'none';
  }

  /** The list of everybody in town, over the pause menu. */
  openPick(): void {
    this.build();
    const el = this.pick as HTMLElement, list = this.others();
    const rows = list.map((r) => `<button type="button" class="sp-row" data-id="${r.id}"><b>${esc(nameText(r.name))}</b><span>${esc(this.doing(r))} · ${esc(this.game.plan.placeName(r.x, r.z))}</span></button>`).join('');
    el.innerHTML = `<div class="sp-card"><div class="sp-lbl">Form S-16 · Request to observe</div><div class="sp-t">SPECTATE</div>
      ${rows || '<p>Nobody else is in town.</p>'}<button type="button" class="sp-cancel">Cancel</button></div>`;
    el.classList.add('on');
  }

  private closePick(): void { this.pick?.classList.remove('on'); }

  private choose(id: number): void {
    this.closePick();
    const g = this.game;
    if (g.state === 'paused') g.setPaused(false);
    this.start(id);
  }

  // ── The page ───────────────────────────────────────────────────────────────

  private build(): void {
    if (this.root) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    const root = document.createElement('div');
    root.id = 'pc-spectate';
    root.innerHTML = `<div class="sp-pad"></div>
      <div class="sp-bar"><button type="button" class="sp-prev" aria-label="Previous player">◀</button>
        <div class="sp-mid"><div class="sp-who"></div><div class="sp-what"></div><div class="sp-n"></div></div>
        <button type="button" class="sp-next" aria-label="Next player">▶</button><button type="button" class="sp-back">Back</button></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.bar = root.querySelector('.sp-bar');
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.sp-prev')) this.next(-1);
      else if (t.closest('.sp-next')) this.next(1);
      else if (t.closest('.sp-back')) this.stop();
    });
    // A swipe across the picture switches player.
    const pad = root.querySelector('.sp-pad') as HTMLElement;
    pad.addEventListener('pointerdown', (e) => { this.swipeX = e.clientX; this.swipeId = e.pointerId; });
    pad.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.swipeId) return;
      this.swipeId = -1;
      const d = e.clientX - this.swipeX;
      if (Math.abs(d) > 50) this.next(d < 0 ? 1 : -1);
    });

    const pick = document.createElement('div');
    pick.id = 'pc-spectate-pick';
    document.body.appendChild(pick);
    this.pick = pick;
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = e.target as HTMLElement, row = t.closest<HTMLElement>('.sp-row');
      if (row) this.choose(Number(row.dataset.id));
      else if (t.closest('.sp-cancel') || t === pick) this.closePick();
    });

    const pr = document.createElement('div');
    pr.id = 'pc-spectate-prompt';
    pr.innerHTML = '<span class="sp-pt"></span><button type="button" class="sp-go">Watch</button><button type="button" class="sp-no" aria-label="No thanks">×</button>';
    document.body.appendChild(pr);
    this.promptEl = pr;
    // On pointerdown, not click: a tap here must not wait for (or lose) the click the touch controls' fingers make.
    pr.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      e.preventDefault(); e.stopPropagation();
      if (t.closest('.sp-go')) this.quick();
      else if (t.closest('.sp-no')) this.hidePrompt();
    });
  }

  /** For the tests. */
  info(): Record<string, unknown> {
    return { on: this.on, id: this.id, name: this.name, banner: this.banner, prompt: this.prompt, others: this.others().map((r) => r.id),
      rounds: [...this.rounds.values()].map((r) => ({ kind: r.kind, caller: r.caller, ids: r.ids, order: this.order(r) })), ...this.stats };
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const CSS = `
body.pc-spectate #touch,body.pc-spectate #pc-replay{visibility:hidden}
#pc-spectate{display:none;position:fixed;inset:0;z-index:38;font:12px/1.3 'Courier New',ui-monospace,monospace;color:#f2e8cf}
body.pc-spectate #pc-spectate{display:block}
body.pc-photo #pc-spectate{display:none}
#pc-spectate .sp-pad{position:absolute;inset:0;touch-action:none}
#pc-spectate .sp-bar{position:absolute;left:50%;top:14px;transform:translateX(-50%);display:flex;align-items:stretch;max-width:calc(100% - 32px);
  background:#14213d;border-bottom:3px solid #e4572e;box-shadow:3px 3px 0 rgba(0,0,0,.35)}
#pc-spectate .sp-mid{padding:7px 14px;min-width:0;flex:1}
#pc-spectate button{flex-shrink:0}
#pc-spectate .sp-who{font:700 17px/1.1 'Arial Narrow','Roboto Condensed',sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#f0a202}
#pc-spectate .sp-what{margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pc-spectate .sp-n{margin-top:3px;font-size:10px;opacity:.7}
#pc-spectate button{font:inherit;color:#f2e8cf;background:none;border:0;border-left:1px solid rgba(242,232,207,.25);padding:0 12px;cursor:pointer;min-width:38px}
#pc-spectate .sp-prev{border-left:0;border-right:1px solid rgba(242,232,207,.25)}
#pc-spectate button:hover{background:rgba(242,232,207,.12)}
@media (max-height:500px){
  #pc-spectate .sp-bar{top:8px;max-width:calc(100% - 500px);min-width:300px}
  #pc-spectate .sp-mid{padding:5px 8px}
  #pc-spectate .sp-who{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #pc-spectate .sp-what{font-size:10px;white-space:normal;max-height:2.6em}
  #pc-spectate .sp-n{font-size:9px}
  #pc-spectate button{padding:0 9px;min-width:34px}
}
#pc-spectate .sp-back{color:#f0a202;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
#pc-spectate-pick{display:none;position:fixed;inset:0;z-index:60;background:rgba(20,33,61,.55);align-items:center;justify-content:center;font:13px/1.3 'Courier New',ui-monospace,monospace;color:#14213d}
#pc-spectate-pick.on{display:flex}
#pc-spectate-pick .sp-card{background:#f2e8cf;border:2px solid #14213d;box-shadow:5px 5px 0 rgba(20,33,61,.5);padding:14px 16px;width:min(420px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto}
#pc-spectate-pick .sp-lbl{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
#pc-spectate-pick .sp-t{font:700 26px/1.1 'Arial Narrow','Roboto Condensed',sans-serif;letter-spacing:.06em;border-bottom:3px solid #e4572e;margin:2px 0 10px;padding-bottom:4px}
#pc-spectate-pick .sp-row{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;border-bottom:1px dashed rgba(20,33,61,.4);padding:9px 4px;cursor:pointer}
#pc-spectate-pick .sp-row:hover,#pc-spectate-pick .sp-row:focus{background:rgba(42,157,143,.18)}
#pc-spectate-pick .sp-row b{display:block;font-size:15px}
#pc-spectate-pick .sp-row span{font-size:11px;opacity:.75}
#pc-spectate-pick .sp-cancel{margin-top:12px;font:inherit;font-weight:700;color:#14213d;background:none;border:2px solid #14213d;padding:6px 14px;cursor:pointer}
#pc-spectate-prompt{display:none;position:fixed;right:16px;top:38%;z-index:30;align-items:center;gap:0;background:#14213d;color:#f2e8cf;border-left:3px solid #e4572e;
  font:13px/1.2 'Courier New',ui-monospace,monospace;box-shadow:3px 3px 0 rgba(0,0,0,.3)}
#pc-spectate-prompt.on{display:flex}
#pc-spectate-prompt.touch{right:auto;left:50%;top:auto;bottom:14px;transform:translateX(-50%);z-index:45;font-size:15px}
#pc-spectate-prompt.touch button{padding:12px 14px}
body.pc-spectate #pc-spectate-prompt,body.pc-photo #pc-spectate-prompt{display:none}
#pc-spectate-prompt .sp-pt{padding:8px 10px}
#pc-spectate-prompt button{font:inherit;color:#f0a202;background:none;border:0;border-left:1px solid rgba(242,232,207,.25);padding:8px 10px;cursor:pointer;font-weight:700}
`;
