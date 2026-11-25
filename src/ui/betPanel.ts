// The bet slip (fun queue 2, item 26; the betting is game/betting.ts). One card over the town, opened with Z or by tapping the
// BETS tag that shows while a window is open: pick a driver (with what each pays), pick a stake from $10 to $500, place the bet.
// Your bet and its result stay on the card; before the start you can take a bet back. Play money only. Input is switched off
// while it is up (the town goes on behind it); Esc or Close puts it away.

import './betPanel.css';
import type { Game } from '../core/game';
import { BET_MAX, BET_MIN, STAKES, multText, returns, type Betting, type Win } from '../game/betting';
import { money } from '../core/util';
import { save } from '../game/save';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export class BetPanel {
  private readonly back: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly tag: HTMLDivElement;
  private sel = '';
  private pick = '';
  private stake = 25;
  private msg = '';
  private rev = -1;
  private drawn = 0;
  private tagText = '';

  constructor(private readonly game: Game, private readonly bets: Betting) {
    this.back = document.createElement('div');
    this.back.className = 'bt-back';
    this.card = document.createElement('div');
    this.card.className = 'bt-card';
    this.back.appendChild(this.card);
    document.body.appendChild(this.back);
    this.tag = document.createElement('div');
    this.tag.id = 'bt-tag';
    document.body.appendChild(this.tag);
    bets.show = () => this.openCard();
    this.tag.addEventListener('click', () => this.openCard());
    this.back.addEventListener('click', (e) => { if (e.target === this.back) this.close(); });
    this.card.addEventListener('click', (e) => this.click(e));
    addEventListener('keydown', (e) => { if (this.bets.panelOpen && (e.code === 'Escape' || e.code === 'KeyZ')) { e.preventDefault(); e.stopImmediatePropagation(); this.close(); } }, true);
  }

  openCard(): void {
    const b = this.bets, g = this.game;
    if (b.panelOpen || g.state !== 'play') return;
    b.panelOpen = true;
    g.input.unlock();
    g.input.setEnabled(false);
    this.back.classList.add('on');
    this.msg = '';
    this.sel = '';
    this.rev = -1;
    this.render();
  }

  close(): void {
    const b = this.bets;
    if (!b.panelOpen) return;
    b.panelOpen = false;
    this.back.classList.remove('on');
    this.game.input.setEnabled(true);
  }

  /** Each frame the town runs: the tag, and the card redrawn when something changed (or once a second for the clocks). */
  update(): void {
    const b = this.bets, now = performance.now();
    if (b.panelOpen) {
      if (this.game.state !== 'play') { this.close(); return; }
      if (b.rev !== this.rev || now - this.drawn > 1000) this.render();
    }
    // The tag: the soonest open window, or a bet in play.
    let text = '';
    const open = b.openList();
    if (open.length) { const w = open[0]; text = `Bets open · ${w.title} · ${Math.max(0, Math.ceil(b.left(w) / 1000))} s · Z`; }
    else {
      for (const w of b.wins.values()) if (w.bet && (w.state === 'open' || w.state === 'closed')) { text = `Your bet is on · ${w.bet.name} · Z`; break; }
    }
    if (text !== this.tagText) { this.tagText = text; this.tag.textContent = text; }
    this.tag.classList.toggle('on', !!text && !b.panelOpen);
  }

  /** The windows worth showing: open ones, ones holding a bet, ones settled with a result for you. */
  private list(): Win[] {
    return [...this.bets.wins.values()].filter((w) => w.state === 'open' || w.bet || w.result !== '').sort((a, b) => a.until - b.until);
  }

  private render(): void {
    const b = this.bets, g = this.game;
    this.rev = b.rev; this.drawn = performance.now();
    const ws = this.list();
    if (!ws.find((w) => w.id === this.sel)) { this.sel = ws[0]?.id ?? ''; this.pick = ''; }
    const w = ws.find((x) => x.id === this.sel) ?? null;
    const rec = save.data.best;
    let h = `<h2>Pick the winner</h2><div class="bt-sub">Friendly bets with play money only. Back a driver; if they win you are paid. ${money(BET_MIN)} to ${money(BET_MAX)} a bet, one bet on each event, and no betting on one you are in.</div>`;
    if (ws.length > 1) h += '<div class="bt-tabs">' + ws.map((x) => `<button class="bt-tab${x.id === this.sel ? ' on' : ''}" data-act="tab" data-id="${esc(x.id)}">${esc(x.title)}</button>`).join('') + '</div>';
    if (!w) h += '<h3>Nothing to bet on</h3><div class="bt-sub">Bets open when somebody calls a street race or a derby in town and you are not in it. At the Flounder Field gate, Z puts on a derby of eight locals to bet on.</div>';
    else {
      const why = b.blocked(w), left = Math.max(0, Math.ceil(b.left(w) / 1000));
      const status = w.state === 'open' ? `Open · closes in ${left} s` : w.state === 'closed' ? 'Closed · underway' : w.state === 'settled' ? 'Finished' : 'Called off';
      h += `<h3>${esc(w.title)} <small>· ${status}</small></h3>`;
      if (w.bet) {
        const bet = w.bet;
        h += `<div class="bt-ok">Your bet: ${money(bet.stake)} on ${esc(bet.tag ? bet.tag + ' ' : '')}${esc(bet.name)} at ${multText(bet.mult)}. Pays ${money(returns(bet.stake, bet.mult))} if they win; refunded if it is called off.</div>`;
        if (w.state === 'open') h += `<div class="bt-bar"><button class="bt-btn alt" data-act="back">Take it back</button></div>`;
      } else if (w.state === 'open' && !why) {
        if (!w.entrants.some((e) => e.key === this.pick)) this.pick = '';
        h += '<div class="bt-sub">Pick a driver:</div>';
        for (const e of w.entrants) {
          const m = b.multOf(w, e.key);
          h += `<div class="bt-row${e.key === this.pick ? ' on' : ''}" data-act="pick" data-key="${esc(e.key)}"><input type="radio" ${e.key === this.pick ? 'checked' : ''} tabindex="-1"><b>${esc(e.tag ? e.tag + ' ' : '')}${esc(e.name)}</b><small>pays</small><i>${multText(m)}</i></div>`;
        }
        if (w.entrants.length < 2) h += '<div class="bt-sub">Waiting for more drivers to join.</div>';
        h += '<div class="bt-sub">Your stake:</div><div class="bt-chips">'
          + STAKES.map((s) => `<button class="bt-chip${s === this.stake ? ' on' : ''}" data-act="stake" data-n="${s}"${g.player.money < s ? ' disabled' : ''}>${money(s)}</button>`).join('') + '</div>';
        const pe = w.entrants.find((e) => e.key === this.pick);
        h += `<div class="bt-bar"><span>${pe ? `Pays ${money(returns(this.stake, b.multOf(w, pe.key)))} if ${esc(pe.name)} wins` : 'Pick a driver'}</span>`
          + `<button class="bt-btn" data-act="place"${pe && g.player.money >= this.stake ? '' : ' disabled'}>Place bet</button></div>`;
      } else if (why) h += `<div class="bt-sub">${esc(why)}</div>`;
      if (w.result) h += `<div class="bt-ok">${esc(w.result)}</div>`;
    }
    h += `<div class="bt-msg">${esc(this.msg)}</div>`;
    h += `<div class="bt-bar"><span>You have ${money(Math.max(0, g.player.money))} · won ${money(rec['bt.won'] ?? 0)} · lost ${money(rec['bt.lost'] ?? 0)}</span><button class="bt-btn alt" data-act="close">Close</button></div>`;
    h += '<div class="bt-note">The odds come from how many are in it and who holds the record; the house keeps a share of every bet, so it is for fun, not for profit.</div>';
    this.card.innerHTML = h;
  }

  private click(e: Event): void {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.act, b = this.bets;
    if (act === 'close') { this.close(); return; }
    if (act === 'tab') { this.sel = el.dataset.id ?? ''; this.pick = ''; this.msg = ''; }
    else if (act === 'pick') this.pick = el.dataset.key ?? '';
    else if (act === 'stake') this.stake = Number(el.dataset.n) || this.stake;
    else if (act === 'place') this.msg = b.place(this.sel, this.pick, this.stake);
    else if (act === 'back') { b.withdraw(this.sel); this.msg = ''; }
    this.render();
  }
}
