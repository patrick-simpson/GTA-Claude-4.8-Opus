// The cards of fun queue 2, item 47 (game/civic.ts holds the rules): a borrowed book, the librarian, a museum plaque and the
// depot's ticket window. One card over the town; input is switched off while it is up, like the order card (ui/nightPanel.ts,
// whose look it shares). Esc or G puts it away; the ticket card takes a digit, a click or a tap.

import './nightPanel.css';
import './civicPanel.css';
import type { Game } from '../core/game';
import type { Civic } from '../game/civic';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export class CivicPanel {
  private readonly back: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private rev = -1;
  private shown: string | null = null;

  constructor(private readonly game: Game, private readonly cv: Civic) {
    this.back = document.createElement('div'); this.back.className = 'nl-back cv-back';
    this.card = document.createElement('div'); this.card.className = 'nl-card cv-card';
    this.back.appendChild(this.card);
    document.body.appendChild(this.back);
    game.input.addNav(this.back);
    this.card.addEventListener('click', (e) => this.click(e));
    this.back.addEventListener('click', (e) => { if (e.target === this.back) this.cv.closePanel(); });
    addEventListener('keydown', (e) => {
      if (!this.cv.panel) return;
      const k = e.code;
      if (k === 'Escape' || this.game.input.is(k, 'interact') || k === 'Enter' || k === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); this.cv.closePanel(); return; }
      if (this.cv.panel === 'ticket' && /^Digit[1-9]$/.test(k)) { e.preventDefault(); e.stopImmediatePropagation(); this.cv.buy(Number(k.slice(5)) - 1); }
    }, true);
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
    if (!t) return;
    const a = t.dataset.a as string;
    if (a === 'close') this.cv.closePanel();
    else if (a.startsWith('r')) this.cv.buy(Number(a.slice(1)));
  }

  /** Each frame the town runs: open or close the card, redraw on change. */
  update(): void {
    const cv = this.cv, g = this.game;
    if (cv.panel && g.state !== 'play') cv.closePanel();
    if (cv.panel !== this.shown) {
      this.shown = cv.panel;
      if (cv.panel) { g.input.unlock(); g.input.setEnabled(false); this.back.classList.add('on'); this.rev = -1; }
      else {
        this.back.classList.remove('on');
        // A ticket bought: the train's own fade has taken the input and gives it back.
        if (!g.rail.phase) g.input.setEnabled(true);
      }
    }
    if (cv.panel && cv.rev !== this.rev) this.render();
  }

  private render(): void {
    const cv = this.cv, v = cv.view, g = this.game;
    this.rev = cv.rev;
    const rows = v.rows.map((r, i) => `<button class="nl-row${r.ok ? '' : ' cv-no'}" data-a="r${i}"><kbd>${i + 1}</kbd><b>${esc(r.label)}</b><small>${esc(r.note)}</small><i>${esc(r.right)}</i></button>`).join('');
    const body = v.body ? `<p class="cv-text">${esc(v.body)}</p>` : '';
    const foot = v.foot ? `<p class="cv-fine">${esc(v.foot)}</p>` : '';
    void g;
    this.card.innerHTML = `<h2>${esc(v.title)}</h2><div class="nl-sub">${esc(v.sub)}</div>${body}${rows}${foot}<div class="nl-msg">${esc(v.msg)}</div><div class="nl-bar"><span></span><button class="nl-btn alt" data-a="close">${esc(v.close)} · G</button></div>`;
  }
}
