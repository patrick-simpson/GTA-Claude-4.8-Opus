// The shop panel (fun queue 2, item 25; the shops are game/stores.ts). One card over the town:
//   a vacant storefront  -> name it, pay the day's rent, open;
//   your shop            -> name, rent due, the till, what is on the shelves and its price (with the fair price and what the
//                           price does to your chances), and what is in your collection to stock;
//   another player's     -> what they have, the price, a Buy button.
// Input is switched off while it is up (the town goes on behind it); Esc or the Close button puts it away.

import './storePanel.css';
import type { Game } from '../core/game';
import type { Stores } from '../game/stores';
import { NAME_MIN, buyChance, valueOf } from '../game/stores';
import { FINDS, RARITY_LABEL } from '../world/pardonsCatalogue';
import { STORE_MAX_NAME } from '../net/protocol';
import { money } from '../core/util';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export class StorePanel {
  private readonly back: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private site = -1;
  private rev = -1;
  private msg = '';
  private typing = false;
  private draft = '';

  constructor(private readonly game: Game, private readonly stores: Stores) {
    this.back = document.createElement('div');
    this.back.className = 'sp-back';
    this.card = document.createElement('div');
    this.card.className = 'sp-card';
    this.back.appendChild(this.card);
    document.body.appendChild(this.back);
    stores.open = (s) => this.show(s);
    this.back.addEventListener('click', (e) => { if (e.target === this.back) this.close(); });
    this.card.addEventListener('click', (e) => this.click(e));
    this.card.addEventListener('change', (e) => this.change(e));
    this.card.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.classList.contains('sp-name')) { this.draft = t.value; this.typing = true; } });
    addEventListener('keydown', (e) => { if (this.isOpen && e.code === 'Escape') { e.preventDefault(); this.close(); } }, true);
  }

  get isOpen(): boolean { return this.stores.panelOpen; }

  show(site: number): void {
    const g = this.game, st = this.stores;
    if (st.panelOpen) return;
    this.site = site; this.msg = ''; this.typing = false; this.draft = st.mine && st.mine.site === site ? st.mine.name : st.idea();
    st.panelOpen = true; st.panelSite = site;
    g.input.unlock();
    g.input.setEnabled(false);
    this.back.classList.add('on');
    this.rev = -1;
    this.render();
  }

  close(): void {
    const st = this.stores;
    if (!st.panelOpen) return;
    st.panelOpen = false; st.panelSite = -1;
    this.back.classList.remove('on');
    this.game.input.setEnabled(true);
  }

  /** Called each frame the town runs: redraw when the shop changed, close if the player is no longer playing. */
  update(): void {
    const st = this.stores;
    if (!st.panelOpen) return;
    if (this.game.state !== 'play') { this.close(); return; }
    if (st.rev !== this.rev && !this.typing) this.render();
    // Walk away (the town goes on while the panel is up): leave when the door is far.
    const s = st.site(this.site), p = this.game.player;
    if (s && Math.hypot(p.x - s.x, p.z - s.z) > 14) this.close();
  }

  private render(): void {
    const st = this.stores, s = st.site(this.site);
    this.rev = st.rev;
    if (!s) { this.card.innerHTML = '<h2>No storefront</h2>'; return; }
    const who = st.tenant(this.site), mine = st.mine;
    const msg = `<div class="sp-msg">${esc(this.msg)}</div>`;
    if (who === 0) {
      this.card.innerHTML = `<h2>Storefront to let</h2><p class="sp-sub">${esc(s.street)}. ${money(s.rent)} a day (a game day is about 24 minutes of play), the first day up front. After that it comes out of your till, then your pocket; two missed days and the landlord changes the lock. You sell what you have filed at Pardon's.</p>
<h3>Shop name</h3><input class="sp-name" type="text" maxlength="${STORE_MAX_NAME}" value="${esc(this.draft)}" aria-label="Shop name" autocomplete="off" spellcheck="false">
<p class="sp-sub">${NAME_MIN} to ${STORE_MAX_NAME} characters. No real brands, no rude words.</p>${msg}
<div class="sp-bar"><button class="sp-btn" data-a="rent">Rent it for ${money(s.rent)}</button><button class="sp-btn alt" data-a="close">Not now</button></div>`;
      return;
    }
    if (who === -1 && mine) {
      const rows = mine.stock.map((e) => {
        const f = FINDS[e.id], v = valueOf(e.id), ch = Math.round(buyChance(e.price, v) * 100);
        return `<div class="sp-row"><b>${esc(f.name)}<span class="sp-tag ${f.rarity}">${RARITY_LABEL[f.rarity]}</span><small>Fair price ${money(v)} · ${ch}% of shoppers who look will buy at ${money(e.price)}</small></b>
<input type="number" min="1" max="9999" step="1" value="${e.price}" data-price="${e.id}" aria-label="Price"><button class="sp-btn alt" data-a="unstock" data-id="${e.id}">Take down</button></div>`;
      }).join('') || '<p class="sp-sub">The shelves are empty. Stock something from your collection below.</p>';
      const inv = st.inventory().map((id) => {
        const f = FINDS[id];
        return `<div class="sp-row"><b>${esc(f.name)}<span class="sp-tag ${f.rarity}">${RARITY_LABEL[f.rarity]}</span><small>Worth about ${money(valueOf(id))}</small></b><button class="sp-btn" data-a="stock" data-id="${id}">Put on a shelf at ${money(valueOf(id))}</button></div>`;
      }).join('') || '<p class="sp-sub">Nothing left in your collection. File finds at Pardon\'s Surplus &amp; Salvage (each one only once), then stock them here.</p>';
      const left = Math.max(1, Math.round(st.hoursToRent()));
      const ff = st.footfallNow();
      this.card.innerHTML = `<h2>${esc(mine.name)}</h2><p class="sp-sub">${esc(s.street)} · rent ${money(st.rentOf())} a day, next in about ${left} game hour${left === 1 ? '' : 's'}${mine.owed > 0 ? ` · <b>${money(mine.owed)} owing</b>` : ''} · footfall ${ff > 0 ? ff.toFixed(1) + 'x' : 'closed (open 8 to 20)'} · ${mine.sales} sold, ${money(mine.earned)} taken in total</p>
<div class="sp-bar"><span><b>Till: ${money(mine.till)}</b></span><span><button class="sp-btn" data-a="collect" ${mine.till > 0 ? '' : 'disabled'}>Take the till</button> ${mine.owed > 0 ? '<button class="sp-btn alt" data-a="pay">Pay what is owing</button>' : ''}</span></div>
<h3>Shop name</h3><div class="sp-row"><input class="sp-name" type="text" maxlength="${STORE_MAX_NAME}" value="${esc(this.draft)}" aria-label="Shop name" autocomplete="off" spellcheck="false"><button class="sp-btn alt" data-a="rename">Repaint the sign</button></div>${msg}
<h3>On the shelves (${mine.stock.length} of 20)</h3>${rows}
<h3>In your collection</h3>${inv}
<div class="sp-bar"><button class="sp-btn alt" data-a="giveup">Give up the lease</button><button class="sp-btn" data-a="close">Close</button></div>`;
      return;
    }
    const r = st.remote.get(who);
    if (!r) { this.card.innerHTML = `<h2>Closed</h2><p class="sp-sub">Nobody is minding this shop right now.</p><div class="sp-bar"><button class="sp-btn" data-a="close">Close</button></div>`; return; }
    const rows = r.stock.map((e) => {
      const f = FINDS[e.id];
      return `<div class="sp-row"><b>${esc(f.name)}<span class="sp-tag ${f.rarity}">${RARITY_LABEL[f.rarity]}</span><small>${esc(f.line)}</small></b><span>${money(e.price)}</span><button class="sp-btn" data-a="buy" data-id="${e.id}">Buy</button></div>`;
    }).join('') || '<p class="sp-sub">Nothing on the shelves just now.</p>';
    this.card.innerHTML = `<h2>${esc(r.name)}</h2><p class="sp-sub">${esc(s.street)} · run by ${esc(st.link?.nameOf(r.owner) ?? 'a neighbour')} · you have ${money(this.game.player.money)}</p>${msg}${rows}<div class="sp-bar"><span></span><button class="sp-btn" data-a="close">Close</button></div>`;
  }

  private nameInput(): string { return (this.card.querySelector<HTMLInputElement>('.sp-name')?.value ?? this.draft); }

  private click(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
    if (!b || b.disabled) return;
    const st = this.stores, a = b.dataset.a, id = Number(b.dataset.id);
    this.typing = false;
    switch (a) {
      case 'close': this.close(); return;
      case 'rent': { const n = this.nameInput(); this.draft = n; this.msg = st.rentSite(this.site, n); break; }
      case 'rename': { const n = this.nameInput(); this.draft = n; this.msg = st.rename(n); break; }
      case 'stock': this.msg = st.stock(id); break;
      case 'unstock': st.unstock(id); this.msg = ''; break;
      case 'collect': { const n = st.collect(); this.msg = ''; if (n > 0) this.game.hud.toast(`${money(n)} from the till.`, 3); break; }
      case 'pay': this.msg = st.payOwed(); break;
      case 'giveup': if (confirm('Give up this storefront? The till comes home with you and your finds go back in your collection.')) st.giveUp(); break;
      case 'buy': this.msg = st.buyRemote(st.tenant(this.site), id); break;
    }
    this.render();
  }

  private change(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.price) { this.stores.setPrice(Number(t.dataset.price), Number(t.value)); this.typing = false; this.render(); }
  }
}
