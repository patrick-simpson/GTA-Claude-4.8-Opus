// Fishing (fun queue 2, item 15): a loaner rod at seven signed spots, a cast you hold and release, a bobber that dips, a hook
// you set on the splash, and a reel with a tension bar. The catches are fishData.ts, the log is fishLog.ts.
//
//   the spots   a sign, "FISHING PERMITTED, PROBABLY", at the pier end, the breakwater, below Tepid Falls, the River Walk bank,
//               Johnson Pond's lookout and the two ferry landings (fishData.ts SPOTS: a standing circle each). At a sign, G
//               takes the loaner rod from the honor bin ("return by never"): no purchase, nothing to carry, no shop to find.
//   the rod     G (or the big button, which is the same thing on a touch screen, or a click when the mouse is free) does it
//               all, so one thumb can play:
//                 HOLD to charge the cast (the meter swings), RELEASE to throw: 6 to 27 m toward where the camera looks. The
//                   cast is helped to the nearest water (a line landing on the bank is thrown again at the water instead).
//                 WAIT: the bobber sits; little twitches are only nibbles. When it dips with a splash, PRESS within about a
//                   second to set the hook (miss it and the fish is gone; press early and you only reel in an empty line).
//                 REEL: HOLD to raise the tension, let go to ease it; keep the needle in the green, which the fish pulls about.
//                   In the green the catch comes in; out of it the fish gains; over the red the line snaps.
//   the catch   what bites depends on the spot (the water, and the spot's luck), the hour (dawn and dusk, night for eels), the
//               season (the town has summer, autumn and winter) and the weather (rain and fog wake them, snow and glare don't).
//               Weight is drawn from the species' range, mostly small. Landed, it is filed in the Fish Log; then SELL it at the
//               honor box (F: dollars by the pound) or RELEASE it (G: "karma", which is a joke the pond keeps count of). The
//               illegal lobster can only go back; Old Tepid is a legend that lives below the dam.
//   the board   "Heaviest catch" (game/leaderboard.ts) is the heaviest real fish, ounces, in the save's best table.
//
// Personal: nothing goes over the wire (no protocol change), and other players do not see the rod. Kid mode: a longer window on the
// bite and a wider green, nothing else changes. R puts the rod away; so does walking off.
// Test hooks: `fishing.auto` plays itself, `fishing.fast` shortens the wait, `fishing.force` picks the next catch's species.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { isWater, groundAt } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import { POND_LEVEL, inPondBox, pondSD } from '../world/dithersPond';
import { seaY } from '../world/sea';
import { season } from '../world/season';
import { kid } from '../core/kid';
import { clamp, wrapAngle, money } from '../core/util';
import { save } from './save';
import { SPECIES, SPOTS, OLD_TEPID, bump, fileCatch, valueOf, weightText, type Spot, type Species } from './fishData';

type Phase = 'idle' | 'power' | 'fly' | 'wait' | 'bite' | 'fight' | 'card';

/** Where the sea, river or pond's surface is at (x, z), or null on dry ground. */
export function waterSurface(x: number, z: number): number | null {
  if (inPondBox(x, z) && pondSD(x, z) < -0.7) return POND_LEVEL;
  if (!isWater(x, z)) return null;
  return z > 0 ? seaY(x, z) : waterLevelAt(x, z);
}

const todOf = (h: number): 'dawn' | 'day' | 'dusk' | 'night' => (h >= 4.5 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 20.5 ? 'dusk' : 'night');

/** How well this species bites at this hour: its own time is best, the neighbours middling. */
function timeFactor(s: Species, tod: string): number {
  if (s.best === 'any') return 1;
  if (s.best === tod) return 2.1;
  const near: Record<string, string[]> = { dawn: ['day', 'night'], day: ['dawn', 'dusk'], dusk: ['day', 'night'], night: ['dusk', 'dawn'] };
  return near[s.best].includes(tod) ? 1 : 0.45;
}

/** The weights of every catch for a spot now (for the pick, and for the tests). */
export function catchWeights(spot: Spot, hour: number, sea: string, weather: string): number[] {
  const tod = todOf(hour);
  return SPECIES.map((s) => {
    if (!s.water.includes(spot.water)) return 0;
    let w = s.w * timeFactor(s, tod) * (s.seasons.includes(sea as 'summer') ? 1 : 0.12) * (spot.luck?.[s.name] ?? 1);
    if (!s.junk) w *= weather === 'rain' ? 1.2 : weather === 'snow' ? 0.8 : 1;
    if (weather === 'fog' && s.name === 'Old Tepid') w *= 2.2;
    // The little sea fish are about the harbour all year; the lake trout like the cold.
    if (sea === 'winter' && s.name === 'Lake trout') w *= 1.8;
    return w;
  });
}

const CSS = `
#fishing { position: fixed; left: 0; right: 0; top: 0; bottom: 0; z-index: 30; pointer-events: none; font-family: var(--f-head, system-ui, sans-serif); color: #14213d; display: none; }
#fishing.on { display: block; }
#fishing .fh-top { position: absolute; left: 50%; bottom: calc(27vh + 4.2em); transform: translateX(-50%); background: #f2e8cf; border: 2px solid #14213d; box-shadow: 2px 2px 0 #14213d; padding: 0.25em 0.8em; font-size: 0.82em; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap; max-width: 92vw; overflow: hidden; text-overflow: ellipsis; }
#fishing .fh-msg { position: absolute; left: 50%; bottom: calc(27vh + 1.3em); transform: translateX(-50%); min-width: 14em; max-width: 92vw; text-align: center; background: #14213d; color: #f2e8cf; padding: 0.35em 1em; font-size: 1.02em; font-weight: 700; }
#fishing .fh-msg.hot { background: #e4572e; color: #fff; animation: fhpulse 0.28s infinite alternate; }
@keyframes fhpulse { from { transform: translateX(-50%) scale(1); } to { transform: translateX(-50%) scale(1.07); } }
#fishing .fh-meter { position: absolute; left: 50%; bottom: calc(27vh - 1.2em); transform: translateX(-50%); width: min(86vw, 34em); display: none; }
#fishing .fh-meter.on { display: block; }
#fishing .fh-prog { height: 0.5em; background: rgba(20, 33, 61, 0.35); border: 2px solid #14213d; margin-bottom: 0.3em; }
#fishing .fh-prog i { display: block; height: 100%; width: 0; background: #2a9d8f; }
#fishing .fh-bar { position: relative; height: 1.7em; background: #f2e8cf; border: 2px solid #14213d; box-shadow: 2px 2px 0 #14213d; overflow: hidden; }
#fishing .fh-red { position: absolute; top: 0; bottom: 0; left: 90%; right: 0; background: rgba(228, 87, 46, 0.55); }
#fishing .fh-zone { position: absolute; top: 0; bottom: 0; background: rgba(42, 157, 143, 0.75); border-left: 2px solid #1f6f66; border-right: 2px solid #1f6f66; }
#fishing .fh-needle { position: absolute; top: -2px; bottom: -2px; width: 0.45em; margin-left: -0.22em; background: #14213d; border: 1px solid #f2e8cf; }
#fishing .fh-btn { position: absolute; right: 5vw; bottom: 11vh; width: 6.2em; height: 6.2em; border-radius: 50%; border: 3px solid #14213d; background: #f0a202; color: #14213d; font: 800 0.95em var(--f-head, system-ui, sans-serif); letter-spacing: 0.04em; box-shadow: 3px 3px 0 #14213d; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; line-height: 1.1; padding: 0.4em; }
#fishing .fh-btn.down { background: #e4572e; color: #fff; transform: translate(2px, 2px); box-shadow: 1px 1px 0 #14213d; }
#fishing .fh-away { pointer-events: auto; margin-left: 0.7em; background: #14213d; border: 0; color: #f2e8cf; font: 700 0.85em var(--f-head, system-ui, sans-serif); padding: 0.2em 0.6em; }
#fishing .fh-card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -54%); width: min(92vw, 26em); background: #f2e8cf; border: 3px solid #14213d; box-shadow: 4px 4px 0 #14213d; padding: 0.9em 1em 1em; text-align: center; display: none; pointer-events: auto; }
#fishing .fh-card.on { display: block; }
#fishing .fh-card img { width: 88px; height: 88px; }
#fishing .fh-card h4 { margin: 0.1em 0; font-size: 1.3em; }
#fishing .fh-card .fh-w { font: 700 1.5em var(--f-mono, monospace); color: #e4572e; }
#fishing .fh-card p { margin: 0.4em 0; font-size: 0.9em; line-height: 1.3; }
#fishing .fh-card .fh-tag { display: inline-block; background: #e4572e; color: #fff; font-weight: 800; font-size: 0.75em; padding: 0.1em 0.5em; margin: 0 0.2em; letter-spacing: 0.06em; }
#fishing .fh-card .fh-row { display: flex; gap: 0.6em; justify-content: center; margin-top: 0.6em; }
#fishing .fh-card button { flex: 1; padding: 0.6em 0.4em; font: 800 0.9em var(--f-head, system-ui, sans-serif); border: 2px solid #14213d; background: #2a9d8f; color: #fff; box-shadow: 2px 2px 0 #14213d; }
#fishing .fh-card button.rel { background: #14213d; }
#fishing .fh-card button:disabled { opacity: 0.35; }
@media (max-width: 720px) { #fishing .fh-btn { bottom: 15vh; } }
`;

/** A sign's face: a board of paperwork. */
function signTexture(spot: Spot): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 384;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#f2e8cf'; c.fillRect(0, 0, 512, 384);
  c.strokeStyle = '#14213d'; c.lineWidth = 12; c.strokeRect(10, 10, 492, 364);
  c.fillStyle = '#e4572e'; c.fillRect(24, 24, 464, 92);
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = '800 42px sans-serif';
  c.fillText('FISHING PERMITTED,', 256, 70); c.fillText('PROBABLY', 256, 108);
  c.fillStyle = '#14213d'; c.font = '700 40px sans-serif';
  const words = spot.name.split(' '); let line = '', y = 170;
  for (const w of words) { if ((line + ' ' + w).length > 17 && line) { c.fillText(line, 256, y); line = w; y += 46; } else line = line ? line + ' ' + w : w; }
  c.fillText(line, 256, y);
  c.font = '600 25px sans-serif'; c.fillText('Loaner rod in the honor bin.', 256, 296);
  c.font = '600 22px sans-serif'; c.fillText('Press G. Fish sold at your own risk.', 256, 336);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Fishing {
  /** The line the town's prompt strip shows (game/index.ts): the invitation to fish, else null. */
  prompt: string | null = null;
  active = false;
  phase: Phase = 'idle';
  spot: Spot | null = null;
  spotIdx = -1;
  // test hooks
  auto = false; fast = false; force = -1;
  readonly stats = { casts: 0, bites: 0, missed: 0, snapped: 0, lost: 0, landed: 0, sold: 0, released: 0 };

  private readonly root = new THREE.Group();
  private readonly rod = new THREE.Group();
  private readonly bobber = new THREE.Group();
  private readonly ripple: THREE.Mesh;
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly line: THREE.Line;
  private readonly signs: THREE.Group[] = [];
  private el!: HTMLElement;
  private ui: Record<string, HTMLElement> = {};
  private btnDown = false;
  private actPrev = false;
  private t = 0;
  private yaw = 0;
  private power = 0;
  private powerDir = 1;
  private castFrom = new THREE.Vector3();
  private target = { x: 0, z: 0, y: 0 };
  private bob = new THREE.Vector3();
  private waitT = 0;
  private nibbles: number[] = [];
  private biteT = 0;
  private cur: { i: number; oz: number; d: number } | null = null;
  // the reel
  private m = 0.4; private prog = 0.3; private fightT = 0; private kick = 0; private kickT = 0;
  private ph = [0, 0, 0, 0];
  private zoneW = 0.15; private rate = 0.2; private amp = 0.3;
  private lastCatch: { i: number; oz: number; value: number } | null = null;
  private msgT = 0;
  private told = false;

  constructor(private readonly game: Game, private readonly isFree: () => boolean) {
    this.root.name = 'fishing';
    // The rod: a long thin cone and a little reel.
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.019, 2.3, 6, 1), new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.6 }));
    rod.position.y = 1.15; this.rod.add(rod);
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 10), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.4 }));
    reel.rotation.z = Math.PI / 2; reel.position.set(0.05, 0.25, 0); this.rod.add(reel);
    this.rod.visible = false;
    // The bobber: red over white, with a ring where it sits on the water.
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe4382e, roughness: 0.5 }));
    top.position.y = 0.08;
    const bot = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf4f4ee, roughness: 0.6 }));
    bot.position.y = -0.04;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.26, 4), new THREE.MeshBasicMaterial({ color: 0xffd23a }));
    stick.position.y = 0.27;
    this.bobber.add(top, bot, stick); this.bobber.visible = false;
    this.ripple = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    this.ripple.rotation.x = -Math.PI / 2; this.ripple.visible = false;
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(14 * 3), 3));
    this.line = new THREE.Line(this.lineGeo, new THREE.LineBasicMaterial({ color: 0xf2f2ec, transparent: true, opacity: 0.8 }));
    this.line.frustumCulled = false; this.line.visible = false;
    this.root.add(this.rod, this.bobber, this.ripple, this.line);
    game.scene.add(this.root);
    try { this.buildSigns(); } catch (e) { console.warn('fishing: no signs', e); }
    try { this.buildUi(); } catch (e) { console.warn('fishing: no ui', e); }
  }

  // ── the world: signs ──────────────────────────────────────────────────────

  private buildSigns(): void {
    const post = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 });
    for (const s of SPOTS) {
      // Beside the middle of the area, a little back from the water, facing away from it.
      const px = s.x - Math.cos(s.face) * 2.6 - Math.sin(s.face) * 1.2, pz = s.z + Math.sin(s.face) * 2.6 - Math.cos(s.face) * 1.2;
      const g = new THREE.Group(); g.name = 'fishing-sign-' + s.id;
      const y = groundAt(px, pz);
      g.position.set(px, y, pz);
      g.rotation.y = s.face + Math.PI;
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), post); a.position.set(-0.55, 1.15, 0);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.3, 0.1), post); b.position.set(0.55, 1.15, 0);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.05), new THREE.MeshStandardMaterial({ map: signTexture(s), roughness: 0.8 }));
      board.position.set(0, 1.75, 0.07);
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.05, 0.06), post); back.position.set(0, 1.75, 0);
      g.add(a, b, back, board);
      this.signs.push(g); this.root.add(g);
    }
  }

  // ── the overlay ───────────────────────────────────────────────────────────

  private buildUi(): void {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'fishing';
    el.innerHTML = `<div class="fh-top"><span class="fh-ttl"></span><button type="button" class="fh-away">Rod away [R]</button></div><div class="fh-msg"></div>
<div class="fh-meter"><div class="fh-prog"><i></i></div><div class="fh-bar"><div class="fh-red"></div><div class="fh-zone"></div><div class="fh-needle"></div></div></div>
<button type="button" class="fh-btn">HOLD<br>TO CAST</button>
<div class="fh-card"><img alt=""><h4></h4><div class="fh-w"></div><div class="fh-tags"></div><p class="fh-line"></p><p class="fh-hint"></p>
<div class="fh-row"><button type="button" class="sell">Sell [F]</button><button type="button" class="rel">Release [G]</button></div></div>`;
    document.body.appendChild(el); this.el = el;
    const q = (s: string): HTMLElement => el.querySelector(s) as HTMLElement;
    this.ui = { top: q('.fh-top'), ttl: q('.fh-ttl'), msg: q('.fh-msg'), meter: q('.fh-meter'), prog: q('.fh-prog i'), zone: q('.fh-zone'), needle: q('.fh-needle'), red: q('.fh-red'), btn: q('.fh-btn'), away: q('.fh-away'),
      card: q('.fh-card'), img: q('.fh-card img'), name: q('.fh-card h4'), w: q('.fh-card .fh-w'), tags: q('.fh-tags'), cline: q('.fh-line'), hint: q('.fh-hint'), sell: q('.sell'), rel: q('.rel') };
    const b = this.ui.btn;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.btnDown = true; b.classList.add('down'); try { b.setPointerCapture(e.pointerId); } catch { /* fine */ } });
    const up = (): void => { this.btnDown = false; b.classList.remove('down'); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    this.ui.away.addEventListener('click', () => this.stop('The rod goes back in the bin. The bin does not say thank you.'));
    this.ui.sell.addEventListener('click', () => this.choose(true));
    this.ui.rel.addEventListener('click', () => this.choose(false));
  }

  private say(text: string, hot = false): void {
    if (!this.ui.msg) return;
    this.ui.msg.textContent = text; this.ui.msg.classList.toggle('hot', hot);
  }

  // ── the session ───────────────────────────────────────────────────────────

  private conditions(): { hour: number; tod: string; weather: string; season: string } {
    const sky = this.game.sky;
    return { hour: sky.hour, tod: todOf(sky.hour), weather: sky.weather, season: season.now };
  }

  private spotAt(x: number, z: number): number {
    let best = -1, bd = 1e9;
    for (let i = 0; i < SPOTS.length; i++) {
      const s = SPOTS[i], d = Math.hypot(x - s.x, z - s.z);
      if (d <= s.r && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Take the loaner rod at the spot the player stands in. */
  start(spotIdx: number): void {
    const g = this.game, p = g.player;
    this.spotIdx = spotIdx; this.spot = SPOTS[spotIdx];
    this.active = true; this.phase = 'idle'; this.cur = null;
    this.actPrev = true; this.yaw = g.cam.yaw;
    this.rod.visible = true; this.el?.classList.add('on');
    this.ui.card?.classList.remove('on');
    if (!this.told) { this.told = true; g.hud.toast('Loaner rod from the honor bin. Return by never. Hold G to cast, press G on the splash, hold G to reel.', 7); }
    this.say(g.input.touch ? 'Hold the button to cast' : 'Hold G to cast');
    this.setBtn('HOLD<br>TO CAST'); this.showMeter(false);
    g.hud.prompt(null);
    void p;
  }

  stop(why?: string): void {
    if (!this.active) return;
    if (this.phase === 'card' && this.lastCatch) this.choose(false, true);
    this.active = false; this.phase = 'idle'; this.cur = null; this.spot = null; this.spotIdx = -1;
    this.rod.visible = false; this.bobber.visible = false; this.ripple.visible = false; this.line.visible = false;
    this.el?.classList.remove('on'); this.btnDown = false;
    if (why) this.game.hud.toast(why, 4);
  }

  private setBtn(html: string): void { if (this.ui.btn) this.ui.btn.innerHTML = html; }
  private showMeter(on: boolean): void { this.ui.meter?.classList.toggle('on', on); }

  /** The green, the needle and the progress bar, all as percentages of the bar. */
  private paintMeter(needle: number, zoneC: number | null, zoneW: number, prog: number | null): void {
    const u = this.ui;
    u.needle.style.left = `${clamp(needle, 0, 1) * 100}%`;
    u.zone.style.display = zoneC === null ? 'none' : 'block';
    if (zoneC !== null) { u.zone.style.left = `${clamp(zoneC - zoneW, 0, 1) * 100}%`; u.zone.style.width = `${Math.min(1, zoneW * 2) * 100}%`; }
    u.red.style.display = zoneC === null ? 'none' : 'block';
    (u.prog as HTMLElement).style.width = `${(prog ?? 0) * 100}%`;
    (u.prog.parentElement as HTMLElement).style.visibility = prog === null ? 'hidden' : 'visible';
  }

  // ── casting ───────────────────────────────────────────────────────────────

  private tipPos(out: THREE.Vector3, flex = 0): THREE.Vector3 {
    const p = this.game.player, yaw = this.yaw, f = 2.25;
    const sx = Math.sin(yaw), sz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const bx = p.x + sx * 0.35 + rx * 0.28, by = p.y + 1.0, bz = p.z + sz * 0.35 + rz * 0.28;
    const pitch = 0.95 - flex * 0.55;
    out.set(bx + sx * Math.cos(pitch) * f, by + Math.sin(pitch) * f, bz + sz * Math.cos(pitch) * f);
    return out;
  }

  /** Where a cast of distance `dist` toward `yaw` would land, helped to the nearest water within 90 degrees (and the spot's own facing as a last try). */
  private aim(dist: number): { x: number; z: number; y: number } | null {
    const p = this.game.player, sp = this.spot;
    const offs = [0, 0.18, -0.18, 0.4, -0.4, 0.7, -0.7, 1.0, -1.0, 1.35, -1.35, 1.6, -1.6];
    const ys = [this.yaw, ...(sp ? [sp.face] : [])];
    for (let yi = 0; yi < ys.length; yi++) {
      for (const o of offs) {
        if (yi > 0 && o !== 0 && Math.abs(o) > 0.7) continue;
        const a = ys[yi] + o;
        for (const k of [1, 0.85, 1.2, 0.7, 1.45, 0.55, 1.7, 0.4]) {
          const d = dist * k, x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d, y = waterSurface(x, z);
          if (y !== null && d >= 3 && d <= 33) return { x, z, y };
        }
      }
    }
    return null;
  }

  private cast(): void {
    const dist = 6 + 21 * this.power, tgt = this.aim(dist), g = this.game;
    this.showMeter(false); this.stats.casts++;
    if (!tgt) { this.say('No water in reach. Face the water and try again.'); this.phase = 'idle'; this.msgT = 2.4; this.setBtn('HOLD<br>TO CAST'); return; }
    this.target = tgt; this.t = 0; this.phase = 'fly';
    this.tipPos(this.castFrom);
    this.bobber.visible = true; this.line.visible = true; this.ripple.visible = false;
    this.bob.copy(this.castFrom);
    this.say('...'); this.setBtn('WAIT');
    void g;
  }

  private landed(): void {
    const g = this.game, c = this.conditions();
    this.bob.set(this.target.x, this.target.y, this.target.z);
    g.emit('splash', { x: this.target.x, z: this.target.z, big: false });
    this.phase = 'wait'; this.t = 0;
    const sky = c.weather, base = 3.2 + Math.random() * 5;
    const wm = sky === 'rain' ? 0.75 : sky === 'snow' ? 1.3 : sky === 'fog' ? 0.9 : 1;
    const tm = c.tod === 'dawn' || c.tod === 'dusk' ? 0.72 : c.tod === 'night' ? 0.95 : 1;
    this.waitT = base * wm * tm * (c.season === 'winter' ? 1.2 : 1) * (this.fast ? 0.18 : 1);
    this.nibbles = [];
    const nn = Math.floor(Math.random() * 3);
    for (let k = 0; k < nn; k++) this.nibbles.push(this.waitT * (0.2 + 0.6 * Math.random()));
    this.say('Wait for the splash...'); this.setBtn('WAIT<br>(tap to reel in)');
  }

  // ── the catch ─────────────────────────────────────────────────────────────

  private pick(): { i: number; oz: number; d: number } {
    const c = this.conditions(), sp = this.spot!;
    let i = this.force;
    if (i < 0 || i >= SPECIES.length) {
      const w = catchWeights(sp, c.hour, c.season, c.weather);
      let t = Math.random() * w.reduce((a, b) => a + b, 0);
      i = w.findIndex((x) => x > 0);
      for (let k = 0; k < w.length; k++) { t -= w[k]; if (t <= 0 && w[k] > 0) { i = k; break; } }
    }
    this.force = -1;
    const s = SPECIES[i];
    let u = Math.random();
    // A dawn or dusk fish of its own hour runs a little bigger.
    if (s.best === c.tod) u = Math.pow(u, 0.85);
    const oz = s.lo === s.hi ? s.lo : Math.round(s.lo + (s.hi - s.lo) * Math.pow(u, 2.4));
    const d = s.junk ? 0.1 : clamp(0.2 + 0.8 * Math.sqrt(oz / 480), 0.2, 1);
    return { i, oz, d };
  }

  private bite(): void {
    const g = this.game;
    this.cur = this.pick(); this.stats.bites++;
    this.phase = 'bite'; this.biteT = (kid.on ? 1.6 : 1.1) + (g.input.touch ? 0.3 : 0);
    g.emit('splash', { x: this.target.x, z: this.target.z, big: true });
    this.say('BITE! Press now!', true); this.setBtn('HOOK<br>IT!');
  }

  private beginFight(): void {
    const c = this.cur!, d = c.d;
    this.phase = 'fight'; this.fightT = 0; this.m = 0.4; this.prog = 0.32; this.kick = 0; this.kickT = 1.5 + Math.random() * 1.5;
    this.zoneW = (0.2 - 0.1 * d) + (kid.on ? 0.05 : 0);
    this.rate = 0.34 - 0.2 * d;
    this.amp = 0.2 + 0.14 * d;
    this.ph = [Math.random() * 6.28, Math.random() * 6.28, 0.9 + 0.7 * d, 1.7 + 0.9 * d];
    this.showMeter(true); this.say(c.d < 0.15 && SPECIES[c.i].junk ? 'Something heavy. Not very lively.' : 'On! Keep the needle in the green!', true);
    this.setBtn('HOLD<br>TO REEL');
  }

  private center(): number {
    const a = this.amp, t = this.fightT;
    const base = 0.5 + a * (0.62 * Math.sin(t * this.ph[2] + this.ph[0]) + 0.38 * Math.sin(t * this.ph[3] + this.ph[1]));
    return clamp(base + this.kick, 0.14, 0.86);
  }

  private fightEnd(win: boolean, why: string): void {
    const g = this.game, c = this.cur!;
    this.showMeter(false);
    this.bobber.visible = false; this.line.visible = false; this.ripple.visible = false;
    if (!win) {
      if (why === 'snap') this.stats.snapped++; else this.stats.lost++;
      this.cur = null; this.phase = 'idle'; this.setBtn('HOLD<br>TO CAST');
      this.say(why === 'snap' ? 'SNAP! Too much tension. The line goes, and so does the fish.' : 'It spat the hook. It is laughing, probably.');
      this.msgT = 3.2; g.emit('splash', { x: this.target.x, z: this.target.z, big: true });
      return;
    }
    this.stats.landed++;
    const s = SPECIES[c.i];
    const flags = fileCatch(c.i, c.oz, this.spotIdx);
    const value = valueOf(c.i, c.oz);
    this.lastCatch = { i: c.i, oz: c.oz, value };
    this.phase = 'card';
    const u = this.ui;
    (u.img as HTMLImageElement).src = '';
    import('./fishLog').then((m) => { (u.img as HTMLImageElement).src = m.fishIcon(c.i, true); }).catch(() => { /* no icon */ });
    u.name.textContent = s.name;
    u.w.textContent = s.junk && s.lo === s.hi ? '' : weightText(c.oz);
    u.tags.innerHTML = (flags.newSpecies ? '<span class="fh-tag">NEW IN THE LOG</span>' : '') + (flags.heaviest ? '<span class="fh-tag">HEAVIEST CATCH</span>' : flags.best ? '<span class="fh-tag">PERSONAL BEST</span>' : '') + (c.i === OLD_TEPID ? '<span class="fh-tag">THE LEGEND</span>' : '');
    u.cline.textContent = s.line;
    u.hint.textContent = s.illegal ? 'Marine Patrol says it goes back. You say it goes back.' : value > 0 ? `The honor box pays ${money(value)}.` : s.junk ? 'The honor box pays nothing, but it will take it.' : '';
    (u.sell as HTMLButtonElement).disabled = !!s.illegal;
    u.sell.textContent = s.illegal ? 'Illegal' : value > 0 ? `Sell ${money(value)} [F]` : 'Hand it over [F]';
    u.card.classList.add('on');
    this.say(`Landed: ${s.name}!`); this.setBtn('F: sell<br>G: release');
    g.hud.toast(`${flags.newSpecies ? 'New in the Fish Log: ' : 'Landed: '}${s.name}${s.junk && s.lo === s.hi ? '' : ', ' + weightText(c.oz)}.`, 4);
    if (!s.junk && !s.illegal && (flags.heaviest || flags.newSpecies || value >= 60)) g.emit('moment', { kind: 'fish' });
  }

  /** The honor box, or back into the water. `quiet`: the fish went on its own (walked away). */
  choose(sell: boolean, quiet = false): void {
    const g = this.game, l = this.lastCatch;
    if (this.phase !== 'card' || !l) return;
    const s = SPECIES[l.i];
    if (sell && s.illegal) sell = false;
    if (sell) {
      if (l.value > 0) { g.player.money += l.value; save.credit(l.value); }
      bump('sold'); bump('cash', l.value); this.stats.sold++;
      const lines = s.junk
        ? ['The honor box accepts it, and says nothing.', 'Recycled. The box almost looked pleased.']
        : [`Sold. The honor box pays ${money(l.value)} and does not ask about the weight.`, `${money(l.value)} in the honor box's slot. A raccoon watches, taking notes.`, `Sold for ${money(l.value)}. The receipt is a leaf.`];
      if (!quiet) g.hud.toast(lines[Math.floor(Math.random() * lines.length)], 4.5);
    } else {
      bump('rel'); this.stats.released++;
      const lines = s.illegal ? ['Back it goes. Marine Patrol, somewhere, nods.', 'Released. The lobster files a complaint about the hook.'] : s.junk ? ['Thrown back. The pond is now a little more parking ticket.', 'Released. Littering, technically. Karma: unknown.'] : ['Released. Karma +1, non-transferable.', 'Released. It will tell the others about you, and they will not care.', 'Back in. The pond has noted this, kindly.'];
      if (!quiet) g.hud.toast(lines[Math.floor(Math.random() * lines.length)], 4.5);
      if (this.target) g.emit('splash', { x: this.target.x, z: this.target.z, big: false });
    }
    this.lastCatch = null; this.ui.card.classList.remove('on'); this.cur = null;
    this.phase = 'idle'; this.say(g.input.touch ? 'Hold the button to cast' : 'Hold G to cast'); this.setBtn('HOLD<br>TO CAST');
    this.actPrev = true;
  }

  // ── each frame ────────────────────────────────────────────────────────────

  update(dt: number, taken: boolean): void {
    const g = this.game, p = g.player, inp = g.input;
    this.prompt = null;
    const ok = g.state === 'play' && !p.seated && p.health > 0 && !p.swimming;
    if (!this.active) {
      if (!ok || !this.isFree() || taken) return;
      const si = this.spotAt(p.x, p.z);
      if (si < 0) return;
      this.prompt = `[G] Fish at ${SPOTS[si].name}: take the loaner rod`;
      if (inp.eat('interact')) this.start(si);
      return;
    }
    if (!ok || !this.spot || Math.hypot(p.x - this.spot.x, p.z - this.spot.z) > this.spot.r + 5) { this.stop('You wander off. The rod goes back in the bin by itself, as it does.'); return; }
    if (inp.eat('reload')) { this.stop('The rod goes back in the bin. The bin does not say thank you.'); return; }
    // The one control: G (hold), the button, a touch on the Use key; or the test's player.
    let act = inp.down('interact') || this.btnDown;
    inp.eat('interact');
    if (this.auto) act = this.autoAct();
    const press = act && !this.actPrev, release = !act && this.actPrev;
    this.actPrev = act;
    // Face the water she is casting at.
    const per = p.person;
    if (Math.abs(inp.moveX) + Math.abs(inp.moveY) < 0.1 && this.phase !== 'card') {
      this.yaw = wrapAngle(this.yaw + wrapAngle(g.cam.yaw - this.yaw) * (1 - Math.exp(-6 * dt)));
      per.h = wrapAngle(per.h + wrapAngle(this.yaw - per.h) * (1 - Math.exp(-10 * dt)));
    } else this.yaw = per.h;
    if (this.msgT > 0 && (this.msgT -= dt) <= 0 && this.phase === 'idle') this.say(inp.touch ? 'Hold the button to cast' : 'Hold G to cast');
    this.t += dt;
    const c = this.conditions();
    this.ui.ttl.textContent = `${this.spot.name} · ${c.tod[0].toUpperCase()}${c.tod.slice(1)} · ${c.weather} · ${c.season}`;
    let flex = 0;
    switch (this.phase) {
      case 'idle':
        if (press) { this.phase = 'power'; this.power = 0; this.powerDir = 1; this.showMeter(true); this.paintMeter(0, null, 0, null); this.say('Release to throw!'); this.setBtn('RELEASE<br>TO CAST'); }
        break;
      case 'power':
        this.power += this.powerDir * dt / 0.95;
        if (this.power >= 1) { this.power = 1; this.powerDir = -1; } else if (this.power <= 0) { this.power = 0; this.powerDir = 1; }
        this.paintMeter(this.power, null, 0, null);
        flex = -0.4 * this.power;
        if (release) this.cast();
        break;
      case 'fly': {
        const k = Math.min(1, this.t / 0.75), e = 1 - (1 - k) * (1 - k);
        this.tipPos(this.castFrom);
        this.bob.set(this.castFrom.x + (this.target.x - this.castFrom.x) * e, this.castFrom.y + (this.target.y - this.castFrom.y) * e + Math.sin(k * Math.PI) * (2 + 0.12 * Math.hypot(this.target.x - this.castFrom.x, this.target.z - this.castFrom.z)), this.castFrom.z + (this.target.z - this.castFrom.z) * e);
        if (k >= 1) this.landed();
        break;
      }
      case 'wait': {
        for (let n = this.nibbles.length - 1; n >= 0; n--) if (this.t >= this.nibbles[n] && this.t < this.nibbles[n] + 0.3) { this.bob.y = this.target.y - 0.05 * Math.sin((this.t - this.nibbles[n]) * 21); flex = 0.15; }
        if (press) { this.bobber.visible = false; this.line.visible = false; this.ripple.visible = false; this.phase = 'idle'; this.say('You reel in an empty line. The fish was never there. Neither was patience.'); this.msgT = 3; this.setBtn('HOLD<br>TO CAST'); break; }
        if (this.t >= this.waitT) this.bite();
        break;
      }
      case 'bite': {
        this.biteT -= dt;
        this.bob.y = this.target.y - 0.22 + 0.04 * Math.sin(this.t * 40);
        flex = 0.5;
        if (press) { this.beginFight(); break; }
        if (this.biteT <= 0) {
          this.stats.missed++; this.cur = null; this.bobber.visible = false; this.line.visible = false; this.ripple.visible = false; this.phase = 'idle';
          this.say('Too slow. It took the worm and left a review.'); this.msgT = 3; this.setBtn('HOLD<br>TO CAST');
        }
        break;
      }
      case 'fight': {
        this.fightT += dt;
        this.kickT -= dt;
        if (this.kickT <= 0) { this.kickT = 2 + Math.random() * 2.4; this.kick += (Math.random() < 0.5 ? -1 : 1) * (0.1 + 0.12 * this.cur!.d); }
        this.kick *= Math.exp(-dt / 0.7);
        this.m = clamp(this.m + (act ? 0.78 : -0.55) * dt, 0, 1.02);
        const cc = this.center(), inZone = Math.abs(this.m - cc) <= this.zoneW;
        this.prog = clamp(this.prog + (inZone ? this.rate : -this.rate * 0.7) * dt, 0, 1);
        this.paintMeter(this.m, cc, this.zoneW, this.prog);
        this.ui.msg.textContent = inZone ? 'Reeling in...' : this.m < cc ? 'Slack! Reel harder!' : 'Too tight! Ease off!';
        flex = 0.3 + 0.7 * this.m;
        // Bobber thrashing, and the line coming in.
        const k = 1 - this.prog;
        this.bob.set(this.target.x + (this.castFrom.x - this.target.x) * (1 - k) * 0.8 + Math.sin(this.fightT * 9) * 0.25 * k, this.target.y + 0.02, this.target.z + (this.castFrom.z - this.target.z) * (1 - k) * 0.8 + Math.cos(this.fightT * 7) * 0.25 * k);
        if (this.m >= 1) this.fightEnd(false, 'snap');
        else if (this.prog <= 0 && this.fightT > 1.5) this.fightEnd(false, 'lost');
        else if (this.prog >= 1) this.fightEnd(true, '');
        break;
      }
      case 'card':
        if (inp.eat('enter')) this.choose(true);
        else if (press) this.choose(false);
        break;
    }
    this.drawGear(dt, flex);
  }

  /** The test's thumb: charge a little, hook on the splash, hold the needle against the green. */
  private autoAct(): boolean {
    switch (this.phase) {
      case 'idle': return !this.actPrev;
      case 'power': return this.power < 0.62;
      case 'bite': return true;
      case 'fight': return this.m < this.center();
      default: return false;
    }
  }

  private readonly tmp = new THREE.Vector3();
  private drawGear(dt: number, flex: number): void {
    const p = this.game.player;
    const tip = this.tipPos(this.tmp, flex);
    // The rod: its base at her hand, pointing at the tip.
    const base = new THREE.Vector3(tip.x, tip.y, tip.z);
    const yaw = this.yaw, bx = p.x + Math.sin(yaw) * 0.35 + Math.cos(yaw) * 0.28, by = p.y + 1.0, bz = p.z + Math.cos(yaw) * 0.35 - Math.sin(yaw) * 0.28;
    this.rod.position.set(bx, by, bz);
    const dir = base.set(tip.x - bx, tip.y - by, tip.z - bz);
    const len = dir.length();
    this.rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.rod.scale.y = len / 2.3;
    if (this.phase === 'idle' || this.phase === 'power' || this.phase === 'card') { this.line.visible = false; this.bobber.visible = false; this.ripple.visible = false; return; }
    this.bobber.visible = true; this.line.visible = true;
    this.bobber.position.copy(this.bob);
    const onWater = this.phase !== 'fly';
    this.ripple.visible = onWater;
    if (onWater) {
      this.ripple.position.set(this.bob.x, this.target.y + 0.03, this.bob.z);
      const s = 1 + 0.35 * Math.sin(this.t * (this.phase === 'bite' || this.phase === 'fight' ? 9 : 2.2)) + (this.phase === 'bite' ? 0.8 : 0);
      this.ripple.scale.setScalar(s); (this.ripple.material as THREE.MeshBasicMaterial).opacity = 0.5 - 0.2 * Math.sin(this.t * 2.2);
    }
    // The line, with a sag that tightens with the tension.
    const pos = this.lineGeo.getAttribute('position') as THREE.BufferAttribute, n = pos.count;
    const tense = this.phase === 'fight' ? this.m : 0.25, sag = (1 - tense) * 0.8 * Math.min(1, Math.hypot(this.bob.x - tip.x, this.bob.z - tip.z) / 8);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      pos.setXYZ(i, tip.x + (this.bob.x - tip.x) * u, tip.y + (this.bob.y - tip.y) * u - Math.sin(u * Math.PI) * sag, tip.z + (this.bob.z - tip.z) * u);
    }
    pos.needsUpdate = true;
    void dt;
  }

  /** For the tests. */
  info(): Record<string, unknown> {
    return {
      active: this.active, phase: this.phase, spot: this.spot?.id ?? null, m: +this.m.toFixed(2), c: +this.center().toFixed(2), w: +this.zoneW.toFixed(2), prog: +this.prog.toFixed(2),
      cur: this.cur ? { ...this.cur, name: SPECIES[this.cur.i].name } : null, ...this.stats, signs: this.signs.length,
    };
  }
}
