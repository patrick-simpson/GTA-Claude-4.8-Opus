// The Places panel on the big map: every business and landmark in Tepid Falls, by category and by name.
// Picking one centres the map on its door and sets the waypoint (the route and the turns come from game/nav.ts).
// Works by touch: big rows, chips that scroll sideways, a tab that folds the panel away on a phone.

import './places.css';
import type { Game } from '../core/game';
import type { ThingsToDo } from '../game/index';
import { distText } from '../game/nav';
import { CATEGORIES, CATEGORY_NAME, findPlaces, type Category, type Place } from '../world/business';
import { CAT_COLOR } from '../world/shopSigns';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export interface MapView {
  /** Centre the map on a point, zooming in to at least `k` (pixels per metre). */
  focus(x: number, z: number, k: number): void;
  redraw(): void;
}

export class PlacesPanel {
  readonly el: HTMLElement;
  private readonly q: HTMLInputElement;
  private readonly chips: HTMLElement;
  private readonly list: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly sel: HTMLElement;
  private cat: Category | null = null;
  private shown: Place[] = [];
  private decided = false;

  constructor(host: HTMLElement, private readonly game: Game, private readonly todo: ThingsToDo, private readonly view: MapView) {
    const el = document.createElement('div');
    el.className = 'pl';
    el.innerHTML = `<button type="button" class="pl-tab" aria-expanded="true">Places</button>
<div class="pl-pane">
  <input class="pl-q" type="search" placeholder="Search by name or kind" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" aria-label="Search places">
  <div class="pl-chips" role="tablist"></div>
  <div class="pl-sel"></div>
  <ul class="pl-list"></ul>
  <div class="pl-foot"></div>
</div>`;
    host.appendChild(el);
    this.el = el;
    this.q = el.querySelector('.pl-q') as HTMLInputElement;
    this.chips = el.querySelector('.pl-chips') as HTMLElement;
    this.list = el.querySelector('.pl-list') as HTMLElement;
    this.foot = el.querySelector('.pl-foot') as HTMLElement;
    this.sel = el.querySelector('.pl-sel') as HTMLElement;
    this.chips.innerHTML = [`<button type="button" class="pl-chip on" data-cat="">All</button>`, ...CATEGORIES.map((c) => `<button type="button" class="pl-chip" data-cat="${c}"><i style="background:${CAT_COLOR[c]}"></i>${esc(CATEGORY_NAME[c])}</button>`)].join('');

    (el.querySelector('.pl-tab') as HTMLElement).addEventListener('click', () => this.fold(!el.classList.contains('fold')));
    // Typing here is not steering the map: keep the menu's and the game's key handlers out of it (Escape still reaches them).
    const keep = (e: KeyboardEvent): void => { if (e.code !== 'Escape') e.stopPropagation(); };
    this.q.addEventListener('keydown', (e) => { keep(e); if (e.code === 'Enter') { e.preventDefault(); this.pick(this.shown[0]); this.q.blur(); } });
    this.q.addEventListener('keyup', keep);
    this.q.addEventListener('input', () => this.refresh());
    this.chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.pl-chip');
      if (!b) return;
      this.cat = (b.dataset.cat || null) as Category | null;
      this.chips.querySelectorAll('.pl-chip').forEach((c) => c.classList.toggle('on', c === b));
      this.refresh();
    });
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (li) this.pick(this.shown[Number(li.dataset.i)]);
    });
    this.sel.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.pl-clear')) { this.todo.go(null); this.refresh(); this.view.redraw(); }
    });
  }

  private fold(on: boolean): void {
    this.el.classList.toggle('fold', on);
    (this.el.querySelector('.pl-tab') as HTMLElement).setAttribute('aria-expanded', String(!on));
  }

  /** The places that are on the map: placed ones only. */
  all(): Place[] { return this.todo.places().filter((p) => p.placed); }

  /** Rebuild the list: for the query and category, nearest first. */
  refresh(): void {
    // A phone starts with the panel folded (the map is the page); known only once the menu is first opened.
    if (!this.decided) { this.decided = true; this.fold(this.game.input.touch); }
    const p = this.game.player, all = this.todo.places();
    const placed = all.filter((x) => x.placed);
    const found = findPlaces(all, this.q.value, this.cat);
    found.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    this.shown = found.slice(0, 80);
    this.list.innerHTML = this.shown.map((x, i) => {
      const d = Math.hypot(x.x - p.x, x.z - p.z);
      return `<li><button type="button" class="pl-row${this.todo.dest === x ? ' on' : ''}" data-i="${i}"><i style="background:${CAT_COLOR[x.cat]}"></i><span class="pl-nm">${esc(x.name)}</span><span class="pl-sub">${esc(CATEGORY_NAME[x.cat])} · ${distText(d)}</span></button></li>`;
    }).join('') || `<li class="pl-none">Nothing by that name. Try a kind of place: pizza, bank, church, bakery.</li>`;
    this.foot.textContent = `${found.length > 80 ? 'Nearest 80 of ' : ''}${found.length} of ${placed.length} places in town` + (all.length > placed.length ? ` · ${all.length - placed.length} more not built yet` : '');
    this.showSel();
  }

  private showSel(): void {
    const d = this.todo.dest, nv = this.todo.navigator;
    if (!d || this.todo.waypoint === null) { this.sel.innerHTML = ''; this.sel.classList.remove('on'); return; }
    const turns = nv.turns.filter((t) => t.dir !== 'straight').length;
    const how = nv.ok ? `${distText(nv.total)} by road, ${turns} turn${turns === 1 ? '' : 's'}` : 'No road there yet';
    this.sel.classList.add('on');
    this.sel.innerHTML = `<b>${esc(d.name)}</b><span>${esc(how)}</span><button type="button" class="pl-clear">Clear route</button>`;
  }

  /** Choose a place: centre the map on its door, set the waypoint, say how far. */
  pick(p: Place | undefined): void {
    if (!p) return;
    this.todo.go(p);
    this.view.focus(p.x, p.z, 1.3);
    this.refresh();
    this.view.redraw();
  }
}
