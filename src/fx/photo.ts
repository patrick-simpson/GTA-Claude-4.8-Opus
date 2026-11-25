// Photo mode (fun queue item 2).
//
// O (or the PHOTO key on touch) stops the world where it stands and hands over a free camera: W A S D to fly,
// E and Q up and down, Shift to hurry, drag the picture to look, the wheel or a pinch to move in and out. It may
// wander a set distance from her and never goes into a wall or under the ground or the sea. A small form on
// the right sets the lens (field of view, depth of field), the exposure, a film look, vignette, grain, the hour
// (this screen only) and whether she is in the picture; "Save photo" draws one frame at twice the window size (at
// least 3840 wide) and downloads it as port-calamity-<date-time>.png. Esc or O again puts everything back as it was.
//
// How it stops the world. Game.tick hands the frame to update() here while open: nothing is simulated, the
// camera rig is not run, the HUD is not updated. In a shared town the others carry on (the service and their own
// browsers run the town); this browser says it is paused (net/index.ts), so it is never picked to host while it
// simulates nothing. The pause guard applies too: it cannot be opened as a shield while wanted.
//
// Costs nothing while closed: the form is built on first open, the key listener is one comparison, and the post
// pass only switches to its photo composite (a second material, post.ts) while open. At the low tier there is no
// post pass: the looks and the exposure are a CSS filter on the canvas (and on the saved picture), the vignette a
// gradient, and depth of field is not offered.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Person } from '../core/api';
import { clamp } from '../core/util';
import { WATER_Y, groundAt } from '../world/plan';
import { waterLevelAt } from '../world/mainland';
import { Shots } from '../game/shots';

/** How far from her the camera may go, meters. */
const RADIUS = 45;
const SPEED = 6, FAST = 18;
const LOOKS = ['None', 'Warm', 'Cool', 'Black and white', 'Faded film', 'High contrast', 'Paperwork sepia'];
/** The low tier's stand-ins for the looks, as CSS filters (also used on the saved picture). */
const CSS_LOOK = ['', 'sepia(0.2) saturate(1.15) hue-rotate(-6deg)', 'saturate(0.9) hue-rotate(12deg) brightness(1.02)', 'grayscale(1) contrast(1.15)',
  'contrast(0.82) saturate(0.7) brightness(1.08) sepia(0.15)', 'contrast(1.35) saturate(1.25)', 'grayscale(1) sepia(0.85) contrast(1.05)'];

interface Saved {
  pos: THREE.Vector3; quat: THREE.Quaternion; fov: number; hour: number; input: boolean; hidden: Person[];
}

export class Photo {
  open = false;
  /** Today's photo challenges and the album (game/shots.ts). */
  readonly shots: Shots;
  /** For the tests: photos saved this visit, and the size of the last. */
  readonly stats = { opened: 0, saved: 0, w: 0, h: 0, refused: 0 };
  /** The settings, kept between visits. */
  readonly set = { fov: 60, focus: 10, dof: 0, exposure: 0, look: 0, vignette: 0.25, grain: 0.15, hour: 12, hide: false, panel: true };

  private root: HTMLElement | null = null;
  private pad: HTMLElement | null = null;
  private form: HTMLElement | null = null;
  private saved: Saved | null = null;
  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();
  private dolly = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v = new THREE.Vector3();

  constructor(private readonly game: Game) {
    this.shots = new Shots(game);
    // Capture on the window: while open every key stops here, so nothing else (the replay key, the fireworks key,
    // the controls) hears it. A slider keeps its own arrow keys.
    const onKey = (e: KeyboardEvent, down: boolean): void => {
      if (!this.open) {
        if (down && e.code === 'KeyO' && !e.repeat && game.state === 'play' && !typing(e)) this.enter();
        return;
      }
      if (typing(e) || (e.target as HTMLElement | null)?.tagName === 'INPUT' && e.code.startsWith('Arrow')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (down) {
        if (e.repeat) return;
        if (e.code === 'Escape' || e.code === 'KeyO') { this.leave(); return; }
        if (e.code === 'Enter' || e.code === 'KeyF') { void this.snap(); return; }
        if (e.code === 'KeyH') { this.set.panel = !this.set.panel; this.sync(); return; }
        this.keys.add(e.code);
      } else this.keys.delete(e.code);
    };
    addEventListener('keydown', (e) => onKey(e, true), true);
    addEventListener('keyup', (e) => onKey(e, false), true);
    addEventListener('blur', () => this.keys.clear());
  }

  toggle(): void { if (this.open) this.leave(); else this.enter(); }

  enter(): void {
    const g = this.game;
    if (this.open || g.state !== 'play') return;
    const why = g.pauseGuard ? g.pauseGuard() : null;
    if (why) { this.stats.refused++; g.hud.toast(why.replace(/paus(e|ing)/gi, 'photo mode'), 3); return; }
    const rp = g.cam.replay;
    if (rp.playing) rp.stop();
    this.build();
    const cam = g.camera;
    const inp = g.input as unknown as { enabled?: boolean };
    this.saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov, hour: g.sky.hour, input: inp.enabled !== false, hidden: [] };
    g.input.setEnabled(false);
    g.input.unlock();
    this.euler.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = this.euler.y; this.pitch = this.euler.x;
    this.set.fov = Math.round(cam.fov);
    this.set.hour = Math.round(g.sky.hour * 4) / 4;
    this.set.exposure = 0;
    // Focus starts on her.
    this.set.focus = Math.round(clamp(cam.position.distanceTo(this.v.set(g.player.x, g.player.y + 1, g.player.z)), 1, 200) * 10) / 10;
    this.keys.clear(); this.pointers.clear(); this.dolly = 0;
    this.open = true;
    this.stats.opened++;
    document.body.classList.add('pc-photo');
    this.sync();
    this.apply();
  }

  leave(): void {
    if (!this.open) return;
    const g = this.game, s = this.saved;
    this.open = false;
    document.body.classList.remove('pc-photo');
    if (g.post) g.post.photo = null;
    g.canvas.style.filter = '';
    if (s) {
      g.camera.position.copy(s.pos); g.camera.quaternion.copy(s.quat); g.camera.fov = s.fov; g.camera.updateProjectionMatrix();
      this.setHour(s.hour);
      this.showPeople(s, true);
      if (g.state === 'play') g.input.setEnabled(s.input);
    }
    this.saved = null;
    this.keys.clear(); this.pointers.clear();
  }

  // ── Every frame while open (from Game.tick, instead of the simulation) ─────

  update(dt: number): void {
    const g = this.game, cam = g.camera, k = this.keys;
    if (g.state !== 'play') { this.leave(); return; }
    const sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? FAST : SPEED) * dt;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const u = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('ControlLeft') ? 1 : 0);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), spt = Math.sin(this.pitch);
    // Forward along the view (so W climbs when looking up), right level, up straight up; the wheel and the pinch dolly.
    const fw = f * sp + this.dolly;
    this.dolly = 0;
    const dx = -sy * cp * fw + cy * r * sp, dz = -cy * cp * fw - sy * r * sp, dyy = spt * fw + u * sp;
    this.move(cam.position, dx, dyy, dz);
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(this.euler);
    if (cam.fov !== this.set.fov) { cam.fov = this.set.fov; cam.updateProjectionMatrix(); }
  }

  /** One step, slid along walls, kept inside the circle round her and above the ground and the water. */
  private move(p: THREE.Vector3, dx: number, dy: number, dz: number): void {
    const g = this.game, col = g.col;
    const blocked = (x: number, y: number, z: number): boolean => {
      const m = 0.35;
      return col.pointBlocked(x, z, y) || col.pointBlocked(x + m, z, y) || col.pointBlocked(x - m, z, y)
        || col.pointBlocked(x, z + m, y) || col.pointBlocked(x, z - m, y);
    };
    if (!blocked(p.x + dx, p.y, p.z)) p.x += dx;
    if (!blocked(p.x, p.y, p.z + dz)) p.z += dz;
    if (!blocked(p.x, p.y + dy, p.z)) p.y += dy;
    const px = g.player.x, py = g.player.y + 1, pz = g.player.z;
    this.v.set(p.x - px, p.y - py, p.z - pz);
    const d = this.v.length();
    if (d > RADIUS) { this.v.multiplyScalar(RADIUS / d); p.set(px + this.v.x, py + this.v.y, pz + this.v.z); }
    const floor = Math.max(groundAt(p.x, p.z), WATER_Y, waterLevelAt(p.x, p.z)) + 0.35;
    if (p.y < floor) p.y = floor;
  }

  // ── Settings into the game ────────────────────────────────────────────────

  private apply(): void {
    const g = this.game, s = this.set;
    if (!this.open) return;
    const exp = Math.pow(2, s.exposure);
    if (g.post) {
      g.post.photo = { focus: s.focus, dof: s.dof, exposure: exp, look: s.look, vignette: s.vignette, grain: s.grain, px: 1 };
      g.canvas.style.filter = '';
    } else {
      g.canvas.style.filter = this.cssFilter();
    }
    if (Math.abs(g.sky.hour - s.hour) > 1e-3) this.setHour(s.hour);
    if (this.saved) this.showPeople(this.saved, !s.hide);
    if (this.root) this.root.style.setProperty('--pv', g.post ? '0' : String(s.vignette));
  }

  private cssFilter(): string {
    const s = this.set, exp = Math.pow(2, s.exposure);
    return `${CSS_LOOK[s.look] ?? ''} brightness(${exp.toFixed(3)})`.trim();
  }

  /** The hour on this screen only: the clock is not running while open, and it is put back on leaving. */
  private setHour(h: number): void {
    const g = this.game;
    g.sky.hour = ((h % 24) + 24) % 24;
    g.sky.update(0);
    g.world.setNight(g.sky.night);
  }

  /** Her on foot, or her in the driver's seat. */
  private showPeople(s: Saved, show: boolean): void {
    const g = this.game;
    if (show) {
      if (!s.hidden.length) return;
      for (const p of s.hidden) p.visible = true;
      s.hidden.length = 0;
    } else {
      if (s.hidden.length) return;
      const her = g.player.person;
      if (her.visible) s.hidden.push(her);
      const v = g.player.seated;
      const seats = (g.occupants as unknown as { seats?: Map<unknown, { p: Person }> }).seats;
      const seat = v && seats ? seats.get(v) : undefined;
      if (seat && seat.p.visible && v && v.driver === 'player') s.hidden.push(seat.p);
      for (const p of s.hidden) p.visible = false;
    }
    g.people.update(0);
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  /** Draw one frame big and download it. Resolves with the file name. */
  async save(): Promise<string> {
    const g = this.game, r = g.renderer;
    const size = r.getSize(new THREE.Vector2()), ratio = r.getPixelRatio();
    const gl = r.getContext();
    const most = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, g.input.touch ? 4096 : 8192);
    let k = Math.max(2, 3840 / size.x);
    k = Math.min(k, most / Math.max(size.x, size.y));
    const W = Math.floor(size.x * k), H = Math.floor(size.y * k);
    const name = `port-calamity-${stamp()}.png`;
    let pending: Promise<Blob | null> = Promise.resolve(null);
    let thumb = '';
    try {
      r.setPixelRatio(k);
      r.setSize(size.x, size.y, false);
      g.post?.setSize(size.x, size.y, k);
      if (g.post?.photo) g.post.photo.px = k / ratio;
      // Drawn straight, not through Game.render: the instance buffers have not changed, so there is nothing to flip.
      if (g.post) g.post.render();
      else { r.setRenderTarget(null); r.render(g.scene, g.camera); }
      // toBlob copies the picture now; the canvas is free to go back to its size before the file is made.
      if (g.post) { thumb = this.thumb(g.canvas); pending = toBlob(g.canvas); }
      else {
        // The low tier's look is a CSS filter: put it into the picture by drawing through a 2D canvas.
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const x = c.getContext('2d');
        if (x) {
          x.filter = this.cssFilter() || 'none';
          x.drawImage(g.canvas, 0, 0, W, H);
          x.filter = 'none';
          const v = this.set.vignette;
          if (v > 0) {
            const gr = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2);
            gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${(0.75 * v).toFixed(3)})`);
            x.fillStyle = gr; x.fillRect(0, 0, W, H);
          }
          thumb = this.thumb(c);
          pending = toBlob(c);
        }
      }
    } finally {
      r.setPixelRatio(ratio);
      r.setSize(size.x, size.y, false);
      g.post?.setSize(size.x, size.y, ratio);
      if (g.post?.photo) g.post.photo.px = 1;
    }
    const blob = await pending;
    if (!blob) { g.hud.toast('The photo did not come out. Try again.', 3); return ''; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.stats.saved++; this.stats.w = W; this.stats.h = H;
    this.flash(`Saved ${W} x ${H}`);
    this.judge(thumb);
    return name;
  }

  /** The shutter without a file: one frame at the window's size into the album and the day's challenges. */
  async snap(): Promise<void> {
    if (!this.open) return;
    const g = this.game, r = g.renderer;
    if (g.post) g.post.render(); else { r.setRenderTarget(null); r.render(g.scene, g.camera); }
    let img = '';
    if (g.post) img = this.thumb(g.canvas);
    else {
      const c = document.createElement('canvas'); c.width = g.canvas.width; c.height = g.canvas.height;
      const x = c.getContext('2d');
      if (x) { x.filter = this.cssFilter() || 'none'; x.drawImage(g.canvas, 0, 0); x.filter = 'none'; img = this.thumb(c); }
    }
    this.flash('Click');
    this.judge(img);
  }

  /** A small JPEG of a drawn frame, for the album. */
  private thumb(src: HTMLCanvasElement): string {
    try {
      const c = document.createElement('canvas'); c.width = 192; c.height = 108;
      const x = c.getContext('2d');
      if (!x || !src.width) return '';
      const k = Math.max(192 / src.width, 108 / src.height), w = src.width * k, h = src.height * k;
      x.drawImage(src, (192 - w) / 2, (108 - h) / 2, w, h);
      return c.toDataURL('image/jpeg', 0.6);
    } catch { return ''; }
  }

  /** Test today's subjects against this frame and show how it went. */
  private judge(img: string): void {
    const lines = this.shots.take(img);
    const res = this.root?.querySelector<HTMLElement>('.ph-res');
    if (res) res.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
    this.sync();
  }

  // ── The form ──────────────────────────────────────────────────────────────

  private build(): void {
    if (this.root) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.append(st);
    const root = this.root = document.createElement('div');
    root.id = 'pc-photo';
    const lowTier = !this.game.post;
    const slider = (key: string, label: string, min: number, max: number, step: number, note = ''): string =>
      `<label class="ph-row"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}"><output data-o="${key}"></output>${note}</label>`;
    root.innerHTML = `<div class="ph-pad"></div><div class="ph-vig"></div>
<div class="ph-form">
  <div class="ph-hd"><b>PHOTO PERMIT</b><span>Form P-2</span></div>
  <div class="ph-ch"></div><div class="ph-res"></div>
  ${slider('fov', 'Field of view', 15, 100, 1)}
  ${lowTier ? '<div class="ph-note">Depth of field needs quality Medium or High.</div>' : `${slider('dof', 'Depth of field', 0, 1, 0.05)}${slider('focus', 'Focus distance', 0, 1, 0.005)}`}
  ${slider('exposure', 'Exposure', -2, 2, 0.1)}
  <label class="ph-row"><span>Film look</span><select data-k="look">${LOOKS.map((l, i) => `<option value="${i}">${l}</option>`).join('')}</select></label>
  ${slider('vignette', 'Vignette', 0, 1, 0.05)}
  ${lowTier ? '' : slider('grain', 'Grain', 0, 1, 0.05)}
  ${slider('hour', 'Time of day', 0, 23.75, 0.25)}
  <label class="ph-row ph-check"><span>Hide Dess</span><input type="checkbox" data-k="hide"></label>
  <div class="ph-album"></div>
  <div class="ph-btns"><button class="ph-snap">Snap</button><button class="ph-save">Save photo</button><button class="ph-done">Done</button></div>
  <div class="ph-ft">WASD fly, E/Q up and down, drag to look, wheel or pinch to move, Enter or F snaps, H hides this form, Esc leaves.</div>
</div>
<button class="ph-show">Form</button><div class="ph-flash"></div>`;
    document.body.append(root);
    this.pad = root.querySelector('.ph-pad');
    this.form = root.querySelector('.ph-form');
    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const k = el.dataset.k as keyof Photo['set'] | undefined;
      if (!k) return;
      const s = this.set as Record<string, number | boolean>;
      if (el.type === 'checkbox') s[k] = el.checked;
      else if (k === 'focus') s.focus = Math.round(focusOf(Number(el.value)) * 10) / 10;
      else s[k] = Number(el.value);
      this.sync(); this.apply();
    });
    root.querySelector('.ph-snap')?.addEventListener('click', () => { void this.snap(); });
    root.querySelector('.ph-save')?.addEventListener('click', () => { void this.save(); });
    root.querySelector('.ph-done')?.addEventListener('click', () => this.leave());
    root.querySelector('.ph-show')?.addEventListener('click', () => { this.set.panel = true; this.sync(); });
    // Looking and moving with a pointer: drag looks; two fingers pinch in and out.
    const pad = this.pad as HTMLElement;
    pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.pinch = 0; });
    pad.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.clientX; p.y = e.clientY;
        const after = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch) this.dolly += (after - before) * 0.04;
        this.pinch = 1;
        return;
      }
      const k = (e.pointerType === 'touch' ? 0.006 : 0.004) * (this.set.fov / 60);
      this.yaw -= (e.clientX - p.x) * k;
      this.pitch = clamp(this.pitch - (e.clientY - p.y) * k, -1.5, 1.5);
      p.x = e.clientX; p.y = e.clientY;
    });
    const up = (e: PointerEvent): void => { this.pointers.delete(e.pointerId); this.pinch = 0; };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('wheel', (e) => { e.preventDefault(); this.dolly -= Math.sign(e.deltaY) * 1.2; }, { passive: false });
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** The form shows the settings. */
  private sync(): void {
    const root = this.root, s = this.set as Record<string, number | boolean>;
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]'))) {
      const k = el.dataset.k as string;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!s[k];
      else if (k === 'focus') el.value = String(sliderOf(this.set.focus));
      else el.value = String(s[k]);
    }
    for (const o of Array.from(root.querySelectorAll<HTMLOutputElement>('[data-o]'))) {
      const k = o.dataset.o as string, v = s[k] as number;
      o.textContent = k === 'fov' ? `${v}°` : k === 'focus' ? `${Math.round(v * 3.28084)} ft` : k === 'exposure' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}`
        : k === 'hour' ? clock(v) : k === 'dof' && v === 0 ? 'Off' : `${Math.round(v * 100)}%`;
    }
    root.classList.toggle('ph-hidden', !this.set.panel);
    const ch = root.querySelector('.ph-ch');
    if (ch) {
      ch.innerHTML = '<b>Today\'s shots</b>' + this.shots.rows().map((r) =>
        `<div class="ph-c${r.done ? ' on' : ''}" title="${esc(r.hint)}">${r.done ? '✓' : '□'} ${esc(r.title)} <i>$${r.pay}${r.ribbon ? '' : ' +ribbon'}</i></div>`).join('');
    }
    const al = root.querySelector('.ph-album');
    if (al) al.innerHTML = this.shots.album().map((a) => `<img alt="" width="64" height="36" src="${esc(a.img)}" title="${esc(a.got.join(', '))}">`).join('');
  }

  private flash(text: string): void {
    const el = this.root?.querySelector<HTMLElement>('.ph-flash');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const typing = (e: KeyboardEvent): boolean => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'));
};
/** The focus slider runs 1 to 200 m on a log scale. */
const focusOf = (t: number): number => Math.exp(Math.log(1) + t * (Math.log(200) - Math.log(1)));
const sliderOf = (m: number): number => Math.log(clamp(m, 1, 200)) / Math.log(200);
const clock = (h: number): string => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const stamp = (): string => {
  const d = new Date(), p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const toBlob = (c: HTMLCanvasElement): Promise<Blob | null> => new Promise((res) => c.toBlob((b) => res(b), 'image/png'));

const CSS = `
body.pc-photo #hud,body.pc-photo #touch,body.pc-photo #pc-replay{visibility:hidden}
#pc-photo{display:none;position:fixed;inset:0;z-index:40;font:12px/1.3 'Courier New',ui-monospace,monospace;color:#14213d;--pv:0}
body.pc-photo #pc-photo{display:block}
#pc-photo .ph-pad{position:absolute;inset:0;cursor:grab;touch-action:none}
#pc-photo .ph-pad:active{cursor:grabbing}
#pc-photo .ph-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 45%,rgba(0,0,0,calc(var(--pv)*0.75)) 100%)}
#pc-photo .ph-form{position:absolute;right:12px;top:12px;width:304px;max-height:calc(100% - 24px);overflow:auto;background:#f2e8cf;border:2px solid #14213d;box-shadow:4px 4px 0 rgba(20,33,61,.45);padding:8px 10px}
#pc-photo .ph-hd{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #14213d;margin-bottom:6px;padding-bottom:3px}
#pc-photo .ph-hd b{letter-spacing:.12em}
#pc-photo .ph-hd span{font-size:10px;opacity:.7}
#pc-photo .ph-row{display:grid;grid-template-columns:116px 1fr 56px;align-items:center;gap:6px;margin:4px 0}
#pc-photo .ph-row input[type=range]{width:100%;accent-color:#e4572e}
#pc-photo .ph-row output{text-align:right;font-size:11px}
#pc-photo .ph-row select{grid-column:2/4;font:inherit;background:#fffaf0;border:1px solid #14213d;color:#14213d}
#pc-photo .ph-check input{justify-self:start;accent-color:#e4572e}
#pc-photo .ph-note{font-size:11px;opacity:.75;margin:4px 0}
#pc-photo .ph-btns{display:flex;gap:8px;margin-top:8px}
#pc-photo button{font:inherit;font-weight:bold;letter-spacing:.06em;border:2px solid #14213d;background:#fffaf0;color:#14213d;padding:6px 10px;cursor:pointer}
#pc-photo .ph-save{flex:1;background:#e4572e;color:#f2e8cf}
#pc-photo .ph-ch{margin:2px 0 4px}#pc-photo .ph-c{font-size:11px;padding:1px 0}#pc-photo .ph-c.on{opacity:.55;text-decoration:line-through}#pc-photo .ph-c i{float:right;font-style:normal;opacity:.75}#pc-photo .ph-res{font-size:11px;color:#9a2a10;margin:2px 0 4px}
#pc-photo .ph-album{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}#pc-photo .ph-album img{width:64px;height:36px;border:1px solid #14213d;object-fit:cover}
#pc-photo .ph-ft{font-size:10px;opacity:.7;margin-top:6px}
#pc-photo .ph-show{display:none;position:absolute;right:12px;top:12px}
#pc-photo.ph-hidden .ph-form{display:none}
#pc-photo.ph-hidden .ph-show{display:block;opacity:.6}
#pc-photo .ph-flash{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);background:#14213d;color:#f2e8cf;padding:6px 12px;opacity:0;pointer-events:none}
#pc-photo .ph-flash.on{animation:phf 2.2s ease-out}
@keyframes phf{0%{opacity:1}70%{opacity:1}100%{opacity:0}}
body.touch #pc-photo .ph-ft{display:none}
@media (max-width:700px),(max-height:500px){#pc-photo .ph-form{width:230px;right:8px;top:8px;max-height:calc(100% - 16px);padding:6px 8px}#pc-photo .ph-row{grid-template-columns:84px 1fr 44px;margin:2px 0}}
`;
