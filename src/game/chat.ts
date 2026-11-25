// Safe chat (fun queue item 21): the quick-chat wheel, speech bubbles, the corner log and map pings.
//
// Hold Y (or tap CHAT on a phone) for a wheel of built-in lines in the game's paperwork voice; let go on one to say it.
// A group opens another ring, and a "Meet me at..." line asks for a place next. Nobody types: what travels is a phrase
// index and a place index (net/chat.ts), and every screen shows only its own table's text (game/chatLines.ts), in the
// gentler kid wording while kid mode is on here. A line with a place also drops a violet ping on everybody's radar and
// big map for PING_S seconds. The sender is rate limited and the receiver drops floods (net/chat.ts); a muted player
// never reaches heard() (pause menu, Settings, "In town").

import type { Game } from '../core/game';
import { kid } from '../core/kid';
import type { Remote } from '../net/remote';
import { nameText } from '../net/names';
import { NO_PLACE, PHRASES, PLACE_GROUPS, ROOT, isPlacePhrase, phraseText, placeTable } from './chatLines';
import type { Node, Place } from './chatLines';
import { FOLLOW_PHRASE, FOLLOW_S, FollowBeacons } from './follow';
import type { Blip } from '../ui/hud';

export const PING_S = 30;
const LOG_MAX = 5, LOG_S = 9;

const CSS = `
.chw{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(0,0,0,.35),rgba(0,0,0,.1) 70%);touch-action:none;user-select:none;-webkit-user-select:none}
.chw.on{display:flex}
.chw-ring{position:relative;width:min(94vmin,580px);height:min(94vmin,580px);border-radius:50%;background:rgba(14,18,24,.76);box-shadow:0 0 0 2px rgba(255,255,255,.12) inset,0 10px 40px rgba(0,0,0,.45);backdrop-filter:blur(4px)}
.chw-mid{position:absolute;left:50%;top:50%;width:30%;height:30%;transform:translate(-50%,-50%);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff;font:600 clamp(11px,2.4vmin,16px)/1.2 system-ui,sans-serif;background:rgba(255,255,255,.06);padding:4%}
.chw-mid small{display:block;font-weight:400;opacity:.65;font-size:.72em;margin-top:4px}
.chw-it{position:absolute;transform:translate(-50%,-50%);width:27%;padding:.4em .5em;border-radius:14px;color:#e9eef5;background:rgba(255,255,255,.09);font:600 clamp(9px,1.9vmin,13px)/1.15 system-ui,sans-serif;text-align:center;cursor:pointer;transition:background .08s,transform .08s}
.chw-it.sel{background:#b9a2f0;color:#150f24;transform:translate(-50%,-50%) scale(1.1)}
.chw-it.grp{background:rgba(185,162,240,.2)}
.chl{position:fixed;left:50%;transform:translateX(-50%);align-items:center;text-align:center;bottom:calc(11% + env(safe-area-inset-bottom,0px));z-index:40;pointer-events:none;display:flex;flex-direction:column;gap:3px;width:max-content;max-width:min(78vw,520px);font:600 13px/1.25 "IBM Plex Mono",monospace}
.chl div{padding:3px 8px;border-radius:3px;background:rgba(20,33,61,.82);color:#f2e8cf;transition:opacity .6s}
.chl b{color:#cdb8ff;font-weight:700}
`;

/** One ring of the wheel: a label for the middle and the things to pick. */
interface Ring { title: string; items: Item[] }
interface Item { label: string; grp?: boolean; go: () => void }

export class Chat {
  open = false;
  /** Pings on the radar and the big map: where somebody asked to meet, race or go (nearest first is not needed). */
  readonly pings: { id: number; x: number; z: number; who: string; until: number }[] = [];
  /** What this player has said and what was heard, for tools/net tests. */
  readonly said: string[] = [];
  readonly log: string[] = [];
  heardCount = 0;

  private sticky = false;
  private heldFor = 0;
  private sel = -1;
  private vx = 0;
  private vy = 0;
  private stack: Ring[] = [];
  private els: HTMLDivElement[] = [];
  private readonly root: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly mid: HTMLDivElement;
  private readonly logEl: HTMLDivElement;
  private readonly rows: { el: HTMLDivElement; at: number }[] = [];
  private lastSig = '';
  /** Follow me (game/follow.ts): the cars lit for others, from their line 36. */
  private readonly follow: FollowBeacons;

  constructor(private readonly game: Game) {
    this.follow = new FollowBeacons(game.scene);
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root = document.createElement('div');
    this.root.className = 'chw';
    this.ring = document.createElement('div');
    this.ring.className = 'chw-ring';
    this.mid = document.createElement('div');
    this.mid.className = 'chw-mid';
    this.ring.appendChild(this.mid);
    this.root.appendChild(this.ring);
    document.body.appendChild(this.root);
    this.logEl = document.createElement('div');
    this.logEl.className = 'chl';
    document.body.appendChild(this.logEl);
    this.root.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const t = (e.target as HTMLElement).closest('.chw-it') as HTMLElement | null;
      if (t) this.pick(Number(t.dataset.i));
      else if (e.target === this.root) this.close();
    });
    this.root.addEventListener('pointermove', (e) => {
      const t = (e.target as HTMLElement).closest('.chw-it') as HTMLElement | null;
      if (t) this.highlight(Number(t.dataset.i));
    });
  }

  // ── The wheel's rings ──
  private text(i: number, place: Place | null = null): string { return phraseText(i, place, kid.on); }
  private rootRing(): Ring {
    return { title: 'Quick chat', items: ROOT.map((n) => this.itemOf(n)) };
  }
  private itemOf(n: Node): Item {
    if (n.kids) return { label: n.label, grp: true, go: () => this.push({ title: n.label, items: n.kids!.map((k) => this.itemOf(k)) }) };
    if (n.phrase !== undefined) { const p = n.phrase; return { label: this.text(p), go: () => this.say(p, NO_PLACE) }; }
    const p = n.more ?? 0;
    return { label: n.label, grp: true, go: () => this.push(this.placeGroups(p, n.label)) };
  }
  private placeGroups(phrase: number, title: string): Ring {
    const table = placeTable(this.game);
    const items: Item[] = [];
    for (const g of PLACE_GROUPS) {
      const list: Item[] = [];
      for (let i = g.from; i <= g.to; i++) { const pl = table[i]; if (pl) list.push({ label: pl.name, go: () => this.say(phrase, i) }); }
      if (list.length) items.push({ label: g.label, grp: true, go: () => this.push({ title: this.text(phrase, null).replace(/%.*$/, '').trim() || title, items: list }) });
    }
    return { title, items };
  }
  private push(r: Ring): void {
    this.stack.push(r);
    this.sticky = true; // a group is picked by clicking or tapping
    this.build();
  }
  private build(): void {
    const ring = this.stack[this.stack.length - 1];
    const items: Item[] = this.stack.length > 1 ? [{ label: '‹ Back', go: () => { this.stack.pop(); this.build(); } }, ...ring.items] : ring.items;
    this.cur = items;
    this.sel = -1; this.vx = 0; this.vy = 0;
    for (const el of this.els) el.remove();
    this.els = items.map((it, i) => {
      const a = (i / items.length) * Math.PI * 2 - Math.PI / 2, r = items.length > 7 ? 39 : 37;
      const el = document.createElement('div');
      el.className = 'chw-it' + (it.grp ? ' grp' : '');
      el.dataset.i = String(i);
      el.textContent = it.label;
      el.style.left = `${50 + r * Math.cos(a)}%`;
      el.style.top = `${50 + r * Math.sin(a)}%`;
      this.ring.appendChild(el);
      return el;
    });
    this.highlight(-1);
  }
  private cur: Item[] = [];

  show(): void {
    if (this.open) return;
    this.open = true; this.heldFor = 0; this.sticky = false;
    this.stack = [this.rootRing()];
    this.build();
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
    const ring = this.stack[this.stack.length - 1];
    this.mid.innerHTML = i >= 0 ? this.cur[i].label : `${ring.title}<small>${this.game.input.touch ? 'Tap one' : 'Move the mouse, let go of Y'}</small>`;
  }
  private pick(i: number): void {
    const it = this.cur[i];
    if (!it) return;
    if (it.grp || it.label.startsWith('‹')) { it.go(); return; }
    this.close();
    it.go();
  }

  /** Say phrase `phrase` (naming `place`): to the others, and in this player's own log. */
  say(phrase: number, place: number): void {
    const g = this.game;
    const r = g.net.chat.send(phrase, place);
    if (r === 'slow') { g.hud.toast('One form at a time, please.', 2); return; }
    if (r === 'bad') return;
    const pl = place === NO_PLACE ? null : placeTable(g)[place] ?? null;
    const line = this.text(phrase, pl);
    if (r === 'alone') { g.hud.toast('Nobody else is in town to hear that.', 2.5); return; }
    this.said.push(line);
    this.addLog('You', line);
    if (phrase === FOLLOW_PHRASE) g.hud.toast(`${g.player.vehicle ? 'Your car' : 'You'} ${g.player.vehicle ? 'is' : 'are'} lit up for everybody in town for ${FOLLOW_S} s.`, 3);
  }

  /** A built-in phrase from another player, already validated and not muted (net/chat.ts): a bubble, a log line, and a ping. */
  heard(r: Remote, phrase: number, place: Place | null): void {
    const line = this.text(phrase, place);
    if (!line) return;
    this.heardCount++;
    r.showSay(line, performance.now());
    const who = nameText(r.name);
    this.addLog(who, line);
    if (phrase === FOLLOW_PHRASE) this.follow.start(r, performance.now());
    if (place && isPlacePhrase(phrase)) {
      const i = this.pings.findIndex((p) => p.id === r.id);
      const ping = { id: r.id, x: place.x, z: place.z, who, until: performance.now() + PING_S * 1000 };
      if (i >= 0) this.pings[i] = ping; else this.pings.push(ping);
      this.syncPings(true);
    }
  }

  private addLog(who: string, line: string): void {
    this.log.push(`${who}: ${line}`);
    if (this.log.length > 40) this.log.shift();
    const el = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = who + ': ';
    el.appendChild(b);
    el.appendChild(document.createTextNode(line));
    this.logEl.appendChild(el);
    this.rows.push({ el, at: performance.now() });
    while (this.rows.length > LOG_MAX) this.rows.shift()!.el.remove();
  }

  private syncPings(force = false): void {
    const nav = this.game.hud.nav;
    const sig = this.pings.map((p) => `${p.id}:${p.x | 0}:${p.z | 0}`).join(',');
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    nav.pings = this.pings.map((p) => ({ x: p.x, z: p.z, who: p.who }));
    nav.rev++;
  }

  update(_dt: number): void {
    const g = this.game, inp = g.input, dt = _dt;
    const now = performance.now();
    // The log fades and goes; pings run out; a sender who left takes their ping with them.
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const age = now - this.rows[i].at;
      if (age > LOG_S * 1000) { this.rows[i].el.remove(); this.rows.splice(i, 1); }
      else if (age > (LOG_S - 1.5) * 1000) this.rows[i].el.style.opacity = '0';
    }
    if (this.pings.length) {
      const here = new Set(g.net.peers.map((r) => r.id));
      for (let i = this.pings.length - 1; i >= 0; i--) if (now > this.pings[i].until || !here.has(this.pings[i].id)) this.pings.splice(i, 1);
      this.syncPings();
    } else if (this.lastSig) { this.lastSig = ''; g.hud.nav.pings = []; g.hud.nav.rev++; }
    this.follow.update(now, g.net.peers.map((r) => r.id));

    const playing = g.state === 'play';
    if (!playing) this.close();
    else if (inp.hit('chat')) { if (this.open && this.sticky) this.close(); else this.show(); }
    if (!this.open) return;
    this.heldFor += dt;
    if (inp.pointerLocked) {
      this.vx += inp.lookX * 120; this.vy += inp.lookY * 120;
      const m = Math.hypot(this.vx, this.vy);
      if (m > 60) { this.vx *= 60 / m; this.vy *= 60 / m; }
      if (m > 18) {
        const a = Math.atan2(this.vy, this.vx) + Math.PI / 2;
        const n = this.cur.length, i = ((Math.round((a / (Math.PI * 2)) * n) % n) + n) % n;
        if (i !== this.sel) this.highlight(i);
      }
      inp.lookX = 0; inp.lookY = 0;
    }
    if (!inp.down('chat') && !this.sticky) {
      // Let go: do the one pointed at (a group opens and waits for a click); a quick tap with nothing chosen leaves the wheel up.
      if (this.sel >= 0) this.pick(this.sel);
      else if (this.heldFor < 0.35) this.sticky = true;
      else this.close();
    }
  }

  /** The radar's F badges for the cars lit by Follow me (called from the navigation pass in game/index.ts). */
  blips(out: Blip[]): void { this.follow.blips(out); }

  /** For tests (tools/net tests, scratch scripts). */
  info(): Record<string, unknown> {
    return { open: this.open, phrases: PHRASES.length, beacons: this.follow.info(), pings: this.pings.map((p) => ({ who: p.who, x: Math.round(p.x), z: Math.round(p.z) })), said: this.said, log: this.log, heard: this.heardCount };
  }
}
