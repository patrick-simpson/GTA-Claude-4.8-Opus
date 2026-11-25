// The Places panel on the big map: every business and landmark in Tepid Falls, by category and by name.
// Picking one centres the map on its door and sets the waypoint (the route and the turns come from game/nav.ts).
// Works by touch: big rows, chips that scroll sideways, a tab that folds the panel away on a phone.

import './places.css';
import type { Game } from '../core/game';
import type { ThingsToDo } from '../game/index';
import { distText } from '../game/nav';
import { CATEGORIES, CATEGORY_NAME, findPlaces, type Category, type Place } from '../world/business';
import { CAT_COLOR } from '../world/shopSigns';
import { asDest, hubs, type Dest } from '../game/travel';
import { STATIONS } from '../world/railway';
import { stationPoint, PLATFORM_IN, PLATFORM_W } from '../world/trainStations';

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
  /** The chip "Cab stops" is on: the list is the Courtesy Cab's hub stops. */
  private hub = false;
  private hubList: Place[] = [];
  /** The chip "Stations" is on: the list is the Budget Line's three stations, with when the next train is in. */
  private rail = false;
  private railList: Place[] = [];
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
    this.chips.innerHTML = [`<button type="button" class="pl-chip on" data-cat="">All</button>`, `<button type="button" class="pl-chip pl-hubchip" data-cat="hubs"><i style="background:#e4572e"></i>Cab stops</button>`, ...(STATIONS.length ? [`<button type="button" class="pl-chip pl-railchip" data-cat="rail"><i style="background:#2a7a45"></i>Train stations</button>`] : []), ...CATEGORIES.map((c) => `<button type="button" class="pl-chip" data-cat="${c}"><i style="background:${CAT_COLOR[c]}"></i>${esc(CATEGORY_NAME[c])}</button>`)].join('');

    (el.querySelector('.pl-tab') as HTMLElement).addEventListener('click', () => this.fold(!el.classList.contains('fold')));
    // Typing here is not steering the map: keep the menu's and the game's key handlers out of it (Escape still reaches them).
    const keep = (e: KeyboardEvent): void => { if (e.code !== 'Escape') e.stopPropagation(); };
    this.q.addEventListener('keydown', (e) => { keep(e); if (e.code === 'Enter') { e.preventDefault(); this.pick(this.shown[0]); this.q.blur(); } });
    this.q.addEventListener('keyup', keep);
    this.q.addEventListener('input', () => this.refresh());
    this.chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.pl-chip');
      if (!b) return;
      this.hub = b.dataset.cat === 'hubs';
      this.rail = b.dataset.cat === 'rail';
      this.cat = this.hub || this.rail ? null : ((b.dataset.cat || null) as Category | null);
      this.chips.querySelectorAll('.pl-chip').forEach((c) => c.classList.toggle('on', c === b));
      this.refresh();
    });
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (li) this.pick(this.shown[Number(li.dataset.i)]);
    });
    this.sel.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.pl-clear')) { this.todo.go(null); this.refresh(); this.view.redraw(); return; }
      const tr = t.closest<HTMLButtonElement>('.pl-train');
      if (tr && !tr.disabled) { const i = Number(tr.dataset.st); if (this.game.rail.travel(i) === '') this.refresh(); return; }
      const go = t.closest<HTMLButtonElement>('.pl-go');
      if (go && !go.disabled) { const d = this.routeDest(); if (d) this.todo.travel.go(d); }
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
    const found = this.rail ? this.railPlaces().filter((x) => findPlaces([x], this.q.value, null).length > 0) : this.hub ? this.hubPlaces().filter((x) => findPlaces([x], this.q.value, null).length > 0) : findPlaces(all, this.q.value, this.cat);
    if (!this.hub && !this.rail) found.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    this.shown = found.slice(0, 80);
    this.list.innerHTML = this.shown.map((x, i) => {
      const d = Math.hypot(x.x - p.x, x.z - p.z);
      const fare = this.todo.travel.fareTo(x), on = this.todo.dest === x || ((this.hub || this.rail) && this.todo.dest?.name === x.name);
      if (this.rail) return `<li><button type="button" class="pl-row${on ? ' on' : ''}" data-i="${i}"><i style="background:#2a7a45"></i><span class="pl-nm">${esc(x.name)}</span><span class="pl-sub">Train station · ${distText(d)} · ${esc(this.game.rail.nextTrainText(-100 - x.id))}</span></button></li>`;
      return `<li><button type="button" class="pl-row${on ? ' on' : ''}" data-i="${i}"><i style="background:${CAT_COLOR[x.cat]}"></i><span class="pl-nm">${esc(x.name)}</span><span class="pl-sub">${esc(this.hub ? 'Cab stop' : CATEGORY_NAME[x.cat])} · ${distText(d)} · cab ${fare === 0 ? 'free' : '$' + fare}</span></button></li>`;
    }).join('') || `<li class="pl-none">Nothing by that name. Try a kind of place: pizza, bank, church, bakery.</li>`;
    this.foot.textContent = `${found.length > 80 ? 'Nearest 80 of ' : ''}${found.length} of ${placed.length} places in town` + (all.length > placed.length ? ` · ${all.length - placed.length} more not built yet` : '');
    this.showSel();
  }

  private showSel(): void {
    const d = this.routeDest(), nv = this.todo.navigator;
    if (!d || this.todo.waypoint === null) { this.sel.innerHTML = ''; this.sel.classList.remove('on'); return; }
    const turns = nv.turns.filter((t) => t.dir !== 'straight').length;
    const p = this.game.player, how = d.custom ? `${distText(Math.hypot(d.x - p.x, d.z - p.z))} away` : nv.ok ? `${distText(nv.total)} by road, ${turns} turn${turns === 1 ? '' : 's'}` : 'No road there yet';
    const cab = this.todo.travel.label(d);
    // A station: when its next train is in, and the train from the platform she stands on.
    const si = STATIONS.findIndex((s) => s.name === d.name);
    const rail = si >= 0 ? this.game.rail.status(si) : null;
    const extra = si >= 0 ? `<span>${esc(this.game.rail.etaText(si))}</span>` : '';
    const train = rail ? `<button type="button" class="pl-go pl-train" data-st="${si}" ${rail.ok ? '' : 'disabled'} title="The Budget Line">${esc(rail.text)}</button>` : '';
    this.sel.classList.add('on');
    this.sel.innerHTML = `<b>${esc(d.name)}</b><span>${esc(how)}</span>${extra}<div class="pl-btns">${train}<button type="button" class="pl-go" ${cab.ok ? '' : 'disabled'} title="Calamity Courtesy Cab">${esc(cab.text)}</button><button type="button" class="pl-clear">Clear route</button></div>`;
  }

  /** Where the route card's Travel button would go: the place picked from the list or the map, or a waypoint set by hand. */
  routeDest(): (Dest & { custom?: boolean }) | null {
    const w = this.todo.waypoint;
    if (!w) return null;
    const d = this.todo.dest;
    if (d && Math.hypot(w.x - d.x, w.z - d.z) < 1) return asDest(d);
    return { name: `Waypoint on ${this.game.plan.streetAt(w.x, w.z)}`, x: w.x, z: w.z, nx: 0, nz: 0, custom: true };
  }

  /** The hub stops as places, so that picking one sets a route like any other. */
  private hubPlaces(): Place[] {
    if (!this.hubList.length) this.hubList = hubs(this.game).map((h, i) => ({ id: -1 - i, name: h.name, cat: 'civic' as Category, x: h.x, z: h.z, nx: h.nx, nz: h.nz, wx: h.x, wz: h.z, rx: h.x, rz: h.z, placed: true, open: false, game: true, sign: false, at: 'cab stop' }));
    return this.hubList;
  }

  /** The Budget Line's stations as places (ids -100 and below), so that picking one sets a route like any other. */
  private railPlaces(): Place[] {
    if (!this.railList.length) this.railList = STATIONS.map((h, i) => { const q = stationPoint(h, 0, PLATFORM_IN + PLATFORM_W / 2, { x: 0, z: 0 }); return { id: -100 - i, name: h.name, cat: 'civic' as Category, x: q.x, z: q.z, nx: 0, nz: 0, wx: q.x, wz: q.z, rx: q.x, rz: q.z, placed: true, open: false, game: true, sign: false, at: 'train station' }; });
    return this.railList;
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
