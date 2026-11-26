// The order card and the darts board of fun queue 2, item 35 (game/nightlife.ts holds the rules). One card over the town:
// at a stool or booth, the short menu (click, tap, or press 1-5; Esc or G to leave the seat); at the dartboard, the timing bar
// and the three throws (G, Space, Enter or the Throw button). Input is switched off while it is up, like the bet slip.

import './nightPanel.css';
import type { Game } from '../core/game';
import type { Nightlife } from '../game/nightlife';
import { DARTS } from '../game/nightData';
import { money } from '../core/util';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export class NightPanel {
  private readonly back: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private rev = -1;
  private shown: string | null = null;
  private marker: HTMLElement | null = null;
  private board: HTMLCanvasElement | null = null;

  constructor(private readonly game: Game, private readonly nl: Nightlife) {
    this.back = document.createElement('div'); this.back.className = 'nl-back';
    this.card = document.createElement('div'); this.card.className = 'nl-card';
    this.back.appendChild(this.card);
    document.body.appendChild(this.back);
    game.input.addNav(this.back);
    this.card.addEventListener('click', (e) => this.click(e));
    this.back.addEventListener('click', (e) => { if (e.target === this.back) this.nl.closePanel(); });
    addEventListener('keydown', (e) => {
      if (!this.nl.panel) return;
      const k = e.code;
      if (k === 'Escape' || (this.game.input.is(k, 'interact') && this.nl.panel === 'menu')) { e.preventDefault(); e.stopImmediatePropagation(); this.nl.closePanel(); return; }
      if (this.nl.panel === 'menu' && /^Digit[1-9]$/.test(k)) { e.preventDefault(); e.stopImmediatePropagation(); this.nl.order(Number(k.slice(5)) - 1); return; }
      if (this.nl.panel === 'darts' && (this.game.input.is(k, 'interact') || k === 'Space' || k === 'Enter') && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); this.act(); }
    }, true);
  }

  private act(): void {
    const d = this.nl.darts;
    if (!d) return;
    if (d.phase === 'aim') this.nl.throwDart(); else this.nl.closePanel();
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!t) return;
    const a = t.dataset.a as string;
    if (a === 'close') this.nl.closePanel();
    else if (a === 'throw') this.act();
    else if (a.startsWith('o')) this.nl.order(Number(a.slice(1)));
  }

  /** Each frame the town runs: open or close the card, redraw on change, move the darts marker. */
  update(): void {
    const nl = this.nl, g = this.game;
    if (nl.panel && g.state !== 'play') nl.closePanel();
    if (nl.panel !== this.shown) {
      this.shown = nl.panel;
      if (nl.panel) { g.input.unlock(); g.input.setEnabled(false); this.back.classList.add('on'); this.rev = -1; }
      else { this.back.classList.remove('on'); g.input.setEnabled(true); this.marker = null; this.board = null; }
    }
    if (!nl.panel) return;
    if (nl.rev !== this.rev) this.render();
    if (nl.panel === 'darts' && this.marker && nl.darts) this.marker.style.left = (nl.darts.pos * 100).toFixed(1) + '%';
  }

  private render(): void {
    const nl = this.nl, g = this.game;
    this.rev = nl.rev;
    const p = g.player;
    if (nl.panel === 'menu' && nl.inside) {
      const v = nl.venue(nl.inside);
      const rows = nl.menu().map((m, i) => `<button class="nl-row" data-a="o${i}"><kbd>${i + 1}</kbd><b>${esc(m.name)}</b><small>${esc(m.note)} · +${m.heal} health</small><i>${m.price ? money(m.price) : 'free'}</i></button>`).join('');
      this.card.innerHTML = `<h2>${esc(v.def.heading)}</h2><div class="nl-sub">${esc(v.def.title)} · you have <span class="nl-wallet">${money(p.money)}</span> · health ${Math.round(p.health)}</div>${rows}<div class="nl-msg">${esc(nl.msg || 'What can I get you?')}</div><div class="nl-bar"><span></span><button class="nl-btn alt" data-a="close">Done · G</button></div>`;
    } else if (nl.panel === 'darts' && nl.darts) {
      const d = nl.darts, a = d.mine.reduce((x, y) => x + y, 0), b = d.reg.reduce((x, y) => x + y, 0);
      const done = d.phase === 'done';
      this.card.innerHTML = `<h2>Darts: you v ${esc(DARTS.opponent)}</h2><div class="nl-sub">${money(DARTS.stake)} on the board, ${money(DARTS.prize)} to the winner · three darts each</div>
<div class="nl-board"><canvas width="180" height="180"></canvas><div class="nl-scores">You: ${d.mine.length ? d.mine.join(' + ') + ' = ' + a : '-'}<br>${esc(DARTS.opponent)}: ${done ? d.reg.join(' + ') + ' = ' + b : '?'}<br>Dart ${Math.min(3, d.n + (done ? 0 : 1))} of 3</div></div>
${done ? '' : '<div class="nl-timing"><div class="mk" style="left:50%"></div></div>'}
<div class="nl-msg">${esc(d.msg)}</div><div class="nl-bar"><button class="nl-btn alt" data-a="close">${done ? 'Done' : 'Walk off'}</button>${done ? '' : '<button class="nl-btn" data-a="throw">Throw · G</button>'}</div>`;
      this.marker = this.card.querySelector('.mk');
      this.board = this.card.querySelector('canvas');
      this.drawBoard(d.marks);
    }
  }

  private drawBoard(marks: { x: number; y: number }[]): void {
    const c = this.board?.getContext('2d');
    if (!c) return;
    const R = 88, cx = 90, cy = 90;
    c.fillStyle = '#1b1410'; c.beginPath(); c.arc(cx, cy, 90, 0, 7); c.fill();
    const rings: [number, string][] = [[1, '#16130f'], [0.95, '#2e8b4a'], [0.85, '#e8d9a8'], [0.5, '#2e8b4a'], [0.4, '#e8d9a8'], [0.2, '#2e8b4a'], [0.08, '#c0352b']];
    for (const [r, col] of rings) { c.fillStyle = col; c.beginPath(); c.arc(cx, cy, R * r, 0, 7); c.fill(); }
    c.fillStyle = '#fff'; c.strokeStyle = '#14213d';
    for (const m of marks) { c.beginPath(); c.arc(cx + m.x * R, cy + m.y * R, 4, 0, 7); c.fill(); c.stroke(); }
  }
}
