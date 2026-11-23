// Emotes and taunts (fun queue item 9). Hold N (or tap EMOTE on a phone) for a wheel: on foot, waves, dances and the
// rest, drawn on the skinned body by ent/character.ts (emotePose); at the wheel of a car, tunes on the car's own horn
// (audio/vehicles.ts tune) and flashing the headlights (ent/vehicle.ts flash).
//
// Moving, jumping, firing or getting in cancels an emote. One-shots end by themselves.
//
// Other players: the emote id goes in a 4 byte Event frame (net/protocol.ts PlayerEvent.Emote, net/index.ts emote()),
// on starting and stopping, and again every few seconds while a looping one runs so somebody who arrives sees it.
// Here, each remote's last id (net/remote.ts emote) is played on their body, or on their car's horn and lamps.
// The service relays the frame unread: nothing to redeploy. Kid mode: everything here is fine.

import type { Game } from '../core/game';
import type { Vehicle } from '../core/api';
import type { VehicleKind } from '../ent/vehicleSpecs';
import type { Remote } from '../net/remote';
import { EMOTE_LEN, emoteOf, setEmote } from '../ent/character';

export interface EmoteDef { id: number; name: string; car?: boolean; toast?: string }

/** Every emote, in wheel order. Ids travel between players: never renumber, only add. */
export const EMOTES: readonly EmoteDef[] = [
  { id: 1, name: 'Wave' },
  { id: 2, name: 'Disco' },
  { id: 3, name: 'The robot' },
  { id: 4, name: 'Bounce' },
  { id: 5, name: 'Clap' },
  { id: 6, name: 'Cheer' },
  { id: 7, name: 'Shrug' },
  { id: 8, name: 'Facepalm' },
  { id: 9, name: 'Point' },
  { id: 10, name: 'Salute' },
  { id: 11, name: 'Sit down' },
  { id: 12, name: 'Lie down' },
  { id: 13, name: 'Flex' },
  { id: 14, name: 'Air guitar' },
  { id: 15, name: 'Be a lamppost', toast: 'You are a lamppost now. Nobody suspects a thing.' },
  { id: 32, name: 'Shave and a haircut', car: true },
  { id: 33, name: 'Fanfare', car: true },
  { id: 34, name: 'La Cucaracha', car: true },
  { id: 35, name: 'Charge!', car: true },
  { id: 36, name: 'Sad horn', car: true, toast: 'Wah wah wah waaah.' },
  { id: 40, name: 'Flash the lights', car: true },
];
export const FLASH = 40;

/** Horn tunes: [start s, length s, semitones from the horn's own note]. */
export const TUNES: Record<number, readonly (readonly [number, number, number])[]> = {
  // Shave and a haircut ... two bits.
  32: [[0, 0.26, 0], [0.32, 0.13, -5], [0.48, 0.13, -5], [0.64, 0.26, -3], [0.96, 0.28, -5], [1.6, 0.24, -1], [1.92, 0.42, 0]],
  // Three short and a long, down a step and up to the top.
  33: [[0, 0.13, 0], [0.18, 0.13, 0], [0.36, 0.13, 0], [0.54, 0.55, 7], [1.2, 0.2, 5], [1.45, 0.2, 7], [1.7, 0.75, 12]],
  // La cu-ca-ra-cha, la cu-ca-ra-cha.
  34: [[0, 0.12, 0], [0.17, 0.12, 0], [0.34, 0.12, 0], [0.51, 0.36, 5], [0.95, 0.4, 9],
    [1.55, 0.12, 0], [1.72, 0.12, 0], [1.89, 0.12, 0], [2.06, 0.36, 5], [2.5, 0.55, 9]],
  // The stadium charge: da da da DAAH, da DAAAH.
  35: [[0, 0.11, -5], [0.15, 0.11, 0], [0.3, 0.11, 4], [0.45, 0.35, 7], [0.95, 0.12, 4], [1.12, 0.7, 7]],
  // Wah wah wah waaah.
  36: [[0, 0.38, 0], [0.48, 0.38, -1], [0.96, 0.38, -2], [1.44, 1.1, -3]],
};
const tuneLen = (id: number): number => { const n = TUNES[id]; if (!n) return 0; const l = n[n.length - 1]; return l[0] + l[1]; };

/** A looping emote is told again this often, for anybody who arrived after it started. */
const RESEND_S = 4;

const CSS = `
.emw{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(0,0,0,.35),rgba(0,0,0,.1) 70%);touch-action:none;user-select:none;-webkit-user-select:none}
.emw.on{display:flex}
.emw-ring{position:relative;width:min(84vmin,460px);height:min(84vmin,460px);border-radius:50%;background:rgba(14,18,24,.72);box-shadow:0 0 0 2px rgba(255,255,255,.12) inset,0 10px 40px rgba(0,0,0,.45);backdrop-filter:blur(4px)}
.emw-mid{position:absolute;left:50%;top:50%;width:34%;height:34%;transform:translate(-50%,-50%);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff;font:600 clamp(12px,2.6vmin,17px)/1.2 system-ui,sans-serif;background:rgba(255,255,255,.06)}
.emw-mid small{display:block;font-weight:400;opacity:.65;font-size:.72em;margin-top:4px}
.emw-it{position:absolute;transform:translate(-50%,-50%);min-width:13%;padding:.45em .7em;border-radius:999px;color:#e9eef5;background:rgba(255,255,255,.08);font:600 clamp(10px,2.1vmin,14px)/1.1 system-ui,sans-serif;text-align:center;white-space:nowrap;cursor:pointer;transition:background .08s,transform .08s}
.emw-it.sel{background:#f2b632;color:#14110a;transform:translate(-50%,-50%) scale(1.12)}
`;

export class Emotes {
  /** The emote this player is doing on foot (0 none), and seconds since it was last told to the others. */
  mine = 0;
  private told = 0;
  /** A horn tune still playing: seconds left (no second tune over the first). */
  private tuneLeft = 0;
  /** Counts, for tools/net/emotes.mjs. */
  started = 0;
  tunesPlayed = 0;
  flashes = 0;
  remoteTunes = 0;

  open = false;
  private car = false;
  private heldFor = 0;
  private sticky = false;
  private sel = -1;
  private vx = 0;
  private vy = 0;
  private items: EmoteDef[] = [];
  private readonly root: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly mid: HTMLDivElement;
  private els: HTMLDivElement[] = [];
  private readonly heard = new Map<Remote, number>();

  constructor(private readonly game: Game) {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root = document.createElement('div');
    this.root.className = 'emw';
    this.ring = document.createElement('div');
    this.ring.className = 'emw-ring';
    this.mid = document.createElement('div');
    this.mid.className = 'emw-mid';
    this.ring.appendChild(this.mid);
    this.root.appendChild(this.ring);
    document.body.appendChild(this.root);
    // A tap or click on the dim outside closes it; on an item, plays it.
    this.root.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const t = (e.target as HTMLElement).closest('.emw-it') as HTMLElement | null;
      if (t) this.pick(Number(t.dataset.i));
      else if (e.target === this.root) this.close();
    });
    this.root.addEventListener('pointermove', (e) => {
      const t = (e.target as HTMLElement).closest('.emw-it') as HTMLElement | null;
      if (t) this.highlight(Number(t.dataset.i));
    });
  }

  /** The wheel's choices right now: horn tunes at the wheel of a car, the body's emotes on foot. */
  private choices(): EmoteDef[] {
    const inCar = !!this.game.player.vehicle;
    return EMOTES.filter((e) => !!e.car === inCar);
  }

  show(): void {
    if (this.open) return;
    this.open = true; this.sel = -1; this.vx = 0; this.vy = 0; this.heldFor = 0; this.sticky = false;
    this.items = this.choices();
    this.car = !!this.game.player.vehicle;
    for (const el of this.els) el.remove();
    this.els = this.items.map((it, i) => {
      const a = (i / this.items.length) * Math.PI * 2 - Math.PI / 2, r = 39;
      const el = document.createElement('div');
      el.className = 'emw-it';
      el.dataset.i = String(i);
      el.textContent = it.name;
      el.style.left = `${50 + r * Math.cos(a)}%`;
      el.style.top = `${50 + r * Math.sin(a)}%`;
      this.ring.appendChild(el);
      return el;
    });
    this.highlight(-1);
    this.root.classList.add('on');
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('on');
  }

  private highlight(i: number): void {
    this.sel = i;
    this.els.forEach((el, j) => el.classList.toggle('sel', j === i));
    const touch = this.game.input.touch;
    this.mid.innerHTML = i >= 0 ? this.items[i].name : `${this.car ? 'Horn tunes' : 'Emotes'}<small>${touch ? 'Tap one' : 'Move the mouse, let go of N'}</small>`;
  }

  private pick(i: number): void {
    const it = this.items[i];
    this.close();
    if (it) this.play(it.id);
  }

  /** Start emote `id` for this player (and tell the others). Returns whether it started. */
  play(id: number): boolean {
    const g = this.game, def = EMOTES.find((e) => e.id === id);
    if (!def) return false;
    const v = g.player.vehicle;
    if (def.car) {
      if (!v) return false;
      if (id === FLASH) {
        (v as Vehicle & { flash: number }).flash = 2.2;
        this.flashes++;
      } else {
        if (this.tuneLeft > 0) return false;
        g.audio?.cars?.tune(hornOf(v), TUNES[id], null);
        this.tuneLeft = tuneLen(id) + 0.2;
        this.tunesPlayed++;
      }
      g.net.emote(id);
      if (def.toast) g.hud.toast(def.toast, 2.5);
      return true;
    }
    if (v || !g.player.canFight) { g.hud.toast('Not now.', 1.5); return false; }
    setEmote(g.player.person, id);
    this.mine = id; this.told = 0; this.started++;
    g.net.emote(id);
    if (def.toast) g.hud.toast(def.toast, 3);
    return true;
  }

  /** Stop this player's emote (and tell the others). */
  stop(): void {
    if (!this.mine) return;
    setEmote(this.game.player.person, 0);
    this.mine = 0;
    this.game.net.emote(0);
  }

  update(dt: number): void {
    const g = this.game, inp = g.input;
    this.tuneLeft = Math.max(0, this.tuneLeft - dt);
    const playing = g.state === 'play';

    // ── The wheel ──
    if (!playing) this.close();
    else if (inp.hit('emote')) {
      if (this.open && this.sticky) this.close(); else this.show();
    }
    if (this.open) {
      // Whichever way the car or her feet went since: the wheel shows what fits now.
      if (!!g.player.vehicle !== this.car) { this.close(); this.show(); }
      this.heldFor += dt;
      // The mouse picks by direction, and the camera stays put while it does.
      if (inp.pointerLocked) {
        this.vx += inp.lookX * 120; this.vy += inp.lookY * 120;
        const m = Math.hypot(this.vx, this.vy);
        if (m > 60) { this.vx *= 60 / m; this.vy *= 60 / m; }
        if (m > 18) {
          const a = Math.atan2(this.vy, this.vx) + Math.PI / 2;
          const n = this.items.length, i = ((Math.round((a / (Math.PI * 2)) * n) % n) + n) % n;
          if (i !== this.sel) this.highlight(i);
        }
        inp.lookX = 0; inp.lookY = 0;
      }
      if (!inp.down('emote') && !this.sticky) {
        // Let go: play the one pointed at; a quick tap with nothing chosen leaves the wheel up to click or tap on.
        if (this.sel >= 0) this.pick(this.sel);
        else if (this.heldFor < 0.35) this.sticky = true;
        else this.close();
      }
    }

    // ── Her own emote ──
    const per = g.player.person;
    if (this.mine) {
      const moved = Math.abs(inp.moveX) > 0.1 || Math.abs(inp.moveY) > 0.1 || inp.hit('jump') || inp.hit('fire') || inp.hit('aim') || inp.hit('enter');
      if (moved || !playing || g.player.vehicle || !g.player.canFight) this.stop();
      else if (emoteOf(per) !== this.mine) this.mine = 0; // a one-shot that has finished
      else if (EMOTE_LEN[this.mine] === 0 && (this.told += dt) >= RESEND_S) { this.told = 0; g.net.emote(this.mine); }
    }

    // ── Everybody else's ──
    for (const r of g.net.peers) {
      const n = this.heard.get(r);
      if (n !== r.emoteN) {
        this.heard.set(r, r.emoteN);
        if (n !== undefined || r.emote !== 0) this.heardFrom(r, r.emote);
      }
      // They set off: whatever the stop frame did, the emote is over here too.
      const b = r.body;
      if (b && emoteOf(b) && (b.pose !== 'stand' || b.speed > 0.6)) { setEmote(b, 0); r.emote = 0; }
    }
    if (this.heard.size > g.net.peers.length) for (const r of this.heard.keys()) if (!g.net.peers.includes(r)) this.heard.delete(r);
  }

  private heardFrom(r: Remote, id: number): void {
    const v = r.vehicle;
    if (TUNES[id]) {
      if (v && this.game.audio?.cars?.tune(hornOf(v), TUNES[id], v)) { r.tunes++; this.remoteTunes++; }
      else if (v) r.tunes++;
      return;
    }
    if (id === FLASH) { if (v) (v as Vehicle & { flash: number }).flash = 2.2; return; }
    const b = r.body;
    if (!b) return;
    // A looping emote told again is the same one going on: leave it running.
    if (id === 0) setEmote(b, 0);
    else if (emoteOf(b) !== id) setEmote(b, id);
  }

  /** For tests (tools/net/emotes.mjs). */
  info(): Record<string, unknown> {
    const p = this.game.player.person;
    return { open: this.open, mine: this.mine, body: emoteOf(p), started: this.started, tunes: this.tunesPlayed, flashes: this.flashes, remoteTunes: this.remoteTunes, items: this.items.map((i) => i.name) };
  }
}

function hornOf(v: Vehicle): VehicleKind {
  return ((v as Vehicle & { hornKind?: VehicleKind | null }).hornKind ?? v.spec.kind) as VehicleKind;
}
