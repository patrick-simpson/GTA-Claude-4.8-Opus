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
import { DOCKS } from '../world/ferryRoute';
import { STREETS_NEW } from '../world/streets';
import type { Gig } from '../game/gigs';
import type { EventRow } from '../game/events';
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
  /** The chip "Ferry" is on: the list is the Calamity Shuttle's two landings, with when the next sailing is in. */
  private ferry = false;
  private ferryList: Place[] = [];
  /** The chip "Gigs" is on: the list is the delivery orders on the board (game/gigs.ts), each from a real counter to a real door. */
  private gigs = false;
  private gigList: Gig[] = [];
  private gigSel: Gig | null = null;
  /** The chip "Events" is on: this week's town events with their countdowns (game/events.ts). */
  private events = false;
  private evList: EventRow[] = [];
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
    this.chips.innerHTML = [`<button type="button" class="pl-chip on" data-cat="">All</button>`, `<button type="button" class="pl-chip pl-gigchip" data-cat="gigs"><i style="background:#2a9d8f"></i>Gigs</button>`, `<button type="button" class="pl-chip pl-evchip" data-cat="events"><i style="background:#b3262e"></i>Events</button>`, `<button type="button" class="pl-chip pl-hubchip" data-cat="hubs"><i style="background:#e4572e"></i>Cab stops</button>`, ...(STATIONS.length ? [`<button type="button" class="pl-chip pl-railchip" data-cat="rail"><i style="background:#2a7a45"></i>Train stations</button>`] : []), ...(STREETS_NEW ? [`<button type="button" class="pl-chip pl-ferrychip" data-cat="ferry"><i style="background:#1d5566"></i>Ferry</button>`] : []), ...CATEGORIES.map((c) => `<button type="button" class="pl-chip" data-cat="${c}"><i style="background:${CAT_COLOR[c]}"></i>${esc(CATEGORY_NAME[c])}</button>`)].join('');

    (el.querySelector('.pl-tab') as HTMLElement).addEventListener('click', () => this.fold(!el.classList.contains('fold')));
    this.foot.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.pl-ant')) { this.todo.events.setWearing(!this.todo.events.wearingAntlers); this.refresh(); } });
    // The Events list counts down on the wall clock, paused or not.
    window.setInterval(() => { if (this.events && el.offsetParent) this.refresh(); }, 1000);
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
      this.ferry = b.dataset.cat === 'ferry';
      this.gigs = b.dataset.cat === 'gigs';
      this.events = b.dataset.cat === 'events';
      this.gigSel = null;
      this.cat = this.hub || this.rail || this.ferry || this.gigs || this.events ? null : ((b.dataset.cat || null) as Category | null);
      this.chips.querySelectorAll('.pl-chip').forEach((c) => c.classList.toggle('on', c === b));
      this.refresh();
    });
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (li && this.gigs) { this.pickGig(this.gigList[Number(li.dataset.i)]); return; }
      if (li && this.events) { this.pickEvent(this.evList[Number(li.dataset.i)]); return; }
      if (li) this.pick(this.shown[Number(li.dataset.i)]);
    });
    this.sel.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.pl-gigacc') && this.gigSel) { const gg = this.gigSel; if (this.todo.gigs.accept(gg)) { this.gigSel = null; this.todo.go(null); this.refresh(); this.view.redraw(); } return; }
      if (t.closest('.pl-gigcancel')) { this.todo.gigs.stop('Order cancelled. The counter shrugs.'); this.refresh(); this.view.redraw(); return; }
      if (t.closest('.pl-clear')) { this.todo.go(null); this.refresh(); this.view.redraw(); return; }
      const tr = t.closest<HTMLButtonElement>('.pl-train');
      if (tr && !tr.disabled) { const i = Number(tr.dataset.st); if (this.game.rail.travel(i) === '') this.refresh(); return; }
      const fy = t.closest<HTMLButtonElement>('.pl-ferry');
      if (fy && !fy.disabled) { const i = Number(fy.dataset.dk); if (this.game.ferry.travel(i) === '') this.refresh(); return; }
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
    if (this.gigs) { this.refreshGigs(); return; }
    if (this.events) { this.refreshEvents(); return; }
    const placed = all.filter((x) => x.placed);
    const found = this.ferry ? this.ferryPlaces().filter((x) => findPlaces([x], this.q.value, null).length > 0) : this.rail ? this.railPlaces().filter((x) => findPlaces([x], this.q.value, null).length > 0) : this.hub ? this.hubPlaces().filter((x) => findPlaces([x], this.q.value, null).length > 0) : findPlaces(all, this.q.value, this.cat);
    if (!this.hub && !this.rail && !this.ferry) found.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    this.shown = found.slice(0, 80);
    this.list.innerHTML = this.shown.map((x, i) => {
      const d = Math.hypot(x.x - p.x, x.z - p.z);
      const fare = this.todo.travel.fareTo(x), on = this.todo.dest === x || ((this.hub || this.rail || this.ferry) && this.todo.dest?.name === x.name);
      if (this.ferry) return `<li><button type="button" class="pl-row${on ? ' on' : ''}" data-i="${i}"><i style="background:#1d5566"></i><span class="pl-nm">${esc(x.name)}</span><span class="pl-sub">Ferry landing · ${distText(d)} · ${esc(this.game.ferry.nextFerryText(-200 - x.id))}</span></button></li>`;
      if (this.rail) return `<li><button type="button" class="pl-row${on ? ' on' : ''}" data-i="${i}"><i style="background:#2a7a45"></i><span class="pl-nm">${esc(x.name)}</span><span class="pl-sub">Train station · ${distText(d)} · ${esc(this.game.rail.nextTrainText(-100 - x.id))}</span></button></li>`;
      return `<li><button type="button" class="pl-row${on ? ' on' : ''}" data-i="${i}"><i style="background:${CAT_COLOR[x.cat]}"></i><span class="pl-nm">${esc(x.name)}</span><span class="pl-sub">${esc(this.hub ? 'Cab stop' : CATEGORY_NAME[x.cat])} · ${distText(d)} · cab ${fare === 0 ? 'free' : '$' + fare}</span></button></li>`;
    }).join('') || `<li class="pl-none">Nothing by that name. Try a kind of place: pizza, bank, church, bakery.</li>`;
    this.foot.textContent = `${found.length > 80 ? 'Nearest 80 of ' : ''}${found.length} of ${placed.length} places in town` + (all.length > placed.length ? ` · ${all.length - placed.length} more not built yet` : '');
    this.showSel();
  }

  /** This week's town events: the next to open first, with the countdown; picking one sets the waypoint to it. */
  private refreshEvents(): void {
    const p = this.game.player, ev = this.todo.events;
    this.shown = [];
    this.evList = ev.rows();
    this.list.innerHTML = this.evList.map((x, i) => {
      const d = Math.hypot(x.x - p.x, x.z - p.z);
      return `<li><button type="button" class="pl-row${x.when.open ? ' on' : ''}" data-i="${i}"><i style="background:#b3262e"></i><span class="pl-nm">${esc(x.title)} · ${esc(x.day)}</span><span class="pl-sub">${esc(x.where)} · ${distText(d)} · ${esc(x.text)}</span></button></li>`;
    }).join('');
    this.foot.innerHTML = `Evenings, 5 pm to 11 pm on the town clock · the same for everyone · a toast tells you when one opens nearby${ev.hasAntlers ? ` · <button type="button" class="pl-ant">Antlers: ${ev.wearingAntlers ? 'on' : 'off'}</button>` : ''}`;
    this.sel.innerHTML = ''; this.sel.classList.remove('on');
  }

  private pickEvent(x: EventRow | undefined): void {
    if (!x) return;
    this.todo.waypoint = { x: x.x, z: x.z };
    this.todo.dest = null;
    this.view.focus(x.x, x.z, 1.3);
    this.refresh();
    this.view.redraw();
  }

  /** The Gigs list: orders near her, nearest pickup first, with the pay; picking one sets the route to its pickup door. */
  private refreshGigs(): void {
    const p = this.game.player, gg = this.todo.gigs;
    this.shown = [];
    if (gg.busy) {
      const i = gg.info();
      this.gigList = [];
      this.list.innerHTML = `<li class="pl-none">${i ? `On an order: ${esc(gg.cargoDef(i.cargo).label)} from ${esc(i.from)} to ${esc(i.to)}.` : 'On shift.'}</li>`;
      this.foot.textContent = 'The route to it is on the map and the radar.';
      this.showSel();
      return;
    }
    this.gigList = gg.board();
    this.list.innerHTML = this.gigList.map((x, i) => {
      const d = Math.hypot(x.from.x - p.x, x.from.z - p.z), c = gg.cargoDef(x.cargo), on = this.gigSel === x;
      return `<li><button type="button" class="pl-row${on ? ' on' : ''}" data-i="${i}"><i style="background:${c.color}"></i><span class="pl-nm">${esc(c.label)}: ${esc(x.from.name)} to ${esc(x.to.name)}</span><span class="pl-sub">${esc(gg.payText(x))} · pickup ${distText(d)} · ${distText(x.len)} run</span></button></li>`;
    }).join('') || `<li class="pl-none">No orders on the board near here. Try the other side of the river, or wait a minute for the phone.</li>`;
    this.foot.textContent = `${this.gigList.length} order${this.gigList.length === 1 ? '' : 's'} near you · or stop at a pizza place, florist, hardware store or pharmacy door and press G`;
    this.showSel();
  }

  private pickGig(x: Gig | undefined): void {
    if (!x) return;
    this.gigSel = x;
    this.todo.go(x.from);
    this.view.focus(x.from.x, x.from.z, 1.3);
    this.refresh();
    this.view.redraw();
  }

  private showSel(): void {
    if (this.events) { this.sel.innerHTML = ''; this.sel.classList.remove('on'); return; }
    if (this.gigs) {
      const gg = this.todo.gigs, x = this.gigSel, act = gg.busy ? gg.info() : null;
      if (act) { this.sel.classList.add('on'); this.sel.innerHTML = `<b>On an order</b><span>${esc(act.phase === 0 ? 'Pickup: ' + act.from : 'Drop: ' + act.to)}</span><div class="pl-btns"><button type="button" class="pl-go pl-gigcancel">Cancel the order</button></div>`; return; }
      if (!x) { this.sel.innerHTML = ''; this.sel.classList.remove('on'); return; }
      const c = gg.cargoDef(x.cargo), nv = this.todo.navigator, p = this.game.player;
      const how = nv.ok ? `${distText(nv.total)} by road to the pickup` : `${distText(Math.hypot(x.from.x - p.x, x.from.z - p.z))} to the pickup`;
      this.sel.classList.add('on');
      this.sel.innerHTML = `<b>${esc(c.label)}: ${esc(x.item)}</b><span>${esc(x.from.name)} to ${esc(x.to.name)}${x.to.house ? ' (a house)' : ''}</span><span>${esc(gg.payText(x))} · ${esc(how)} · ${esc(gg.needText(x))}</span><div class="pl-btns"><button type="button" class="pl-go pl-gigacc">Accept this order</button><button type="button" class="pl-go pl-clear" style="background:var(--ink)">Clear</button></div>`;
      return;
    }
    const d = this.routeDest(), nv = this.todo.navigator;
    if (!d || this.todo.waypoint === null) { this.sel.innerHTML = ''; this.sel.classList.remove('on'); return; }
    const turns = nv.turns.filter((t) => t.dir !== 'straight').length;
    const p = this.game.player, how = d.custom ? `${distText(Math.hypot(d.x - p.x, d.z - p.z))} away` : nv.ok ? `${distText(nv.total)} by road, ${turns} turn${turns === 1 ? '' : 's'}` : 'No road there yet';
    const cab = this.todo.travel.label(d);
    // A station: when its next train is in, and the train from the platform she stands on.
    const si = STATIONS.findIndex((s) => s.name === d.name);
    const rail = si >= 0 ? this.game.rail.status(si) : null;
    const extra = si >= 0 ? `<span>${esc(this.game.rail.etaText(si))}</span>` : '';
    const fi = DOCKS.findIndex((s) => s.name === d.name);
    const fer = fi >= 0 ? this.game.ferry.status(fi) : null;
    const ferExtra = fi >= 0 ? `<span>${esc(this.game.ferry.etaText(fi))}</span>` : '';
    const ferry = fer ? `<button type="button" class="pl-go pl-ferry" data-dk="${fi}" ${fer.ok ? '' : 'disabled'} title="The Calamity Shuttle">${esc(fer.text)}</button>` : '';
    const train = rail ? `<button type="button" class="pl-go pl-train" data-st="${si}" ${rail.ok ? '' : 'disabled'} title="The Budget Line">${esc(rail.text)}</button>` : '';
    this.sel.classList.add('on');
    this.sel.innerHTML = `<b>${esc(d.name)}</b><span>${esc(how)}</span>${extra}${ferExtra}<div class="pl-btns">${train}${ferry}<button type="button" class="pl-go" ${cab.ok ? '' : 'disabled'} title="Calamity Courtesy Cab">${esc(cab.text)}</button><button type="button" class="pl-clear">Clear route</button></div>`;
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
  /** The ferry landings as places (ids -200 and below). */
  private ferryPlaces(): Place[] {
    if (!this.ferryList.length) this.ferryList = DOCKS.map((h, i) => ({ id: -200 - i, name: h.name, cat: 'civic' as Category, x: h.ex, z: h.ez, nx: 0, nz: 0, wx: h.ex, wz: h.ez, rx: h.ex, rz: h.ez, placed: true, open: false, game: true, sign: false, at: 'ferry landing' }));
    return this.ferryList;
  }

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
