// The Race Builder on the big map (fun queue 2, item 18): drop 3 to 12 checkpoints on streets, choose laps and a made-up
// name, see the route along the streets and its length, save up to 5 races, publish them to the town, run one alone or
// call a race. A panel like the Places panel; while its Build page is open a tap on the map drops a checkpoint instead of
// setting a waypoint (ui/menu.ts asks `active`). Nothing is typed: names come from a list. Big buttons for phones.
// The race itself is game/raceBuilder.ts (turning checkpoints into a race) and game/race.ts (running it).

import './raceBuilder.css';
import type { Game } from '../core/game';
import type { ThingsToDo } from '../game/index';
import { distText, Navigator } from '../game/nav';
import { MAX_PERSONAL, MIN_LAP_M, cellPoint, cellX, cellZ, raceNameText, snapPoint, type Built, type TownEntry } from '../game/raceBuilder';
import { BUILT_MAX_PINS, BUILT_MIN_PINS, BUILT_NAMES, type BuiltSpec } from '../net/protocol';
import { nameText } from '../net/names';
import type { RaceDef } from '../game/activities';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const clock = (s: number): string => { const t = Math.round(s * 10), m = Math.floor(t / 600), r = (t % 600) / 10; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };
type Page = 'build' | 'mine' | 'town';

export interface RaceBuilderView {
  focus(x: number, z: number, k: number): void;
  redraw(): void;
  /** Close the menu and go back to the game. */
  resume(): void;
}
export interface RbColors { ink: string; mustard: string; bone: string; teal: string }

export class RaceBuilderPanel {
  readonly el: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly body: HTMLElement;
  private page: Page = 'build';
  private open = false;
  private pins: { x: number; z: number; ix: number; iz: number }[] = [];
  private legs: number[][] = [];
  private closing: number[] | null = null;
  private laps = 1;
  private back = false;
  private name = Math.floor(Math.random() * BUILT_NAMES);
  private msg = '';
  private sel = -1;
  private rev = -1;
  private readonly nav = new Navigator();

  constructor(host: HTMLElement, private readonly game: Game, private readonly todo: ThingsToDo, private readonly view: RaceBuilderView) {
    const el = document.createElement('div');
    el.className = 'rb';
    el.innerHTML = `<button type="button" class="rb-tab" aria-expanded="false">Race Builder</button>
<div class="rb-pane">
  <div class="rb-pages" role="tablist"></div>
  <div class="rb-body"></div>
</div>`;
    host.appendChild(el);
    this.el = el;
    this.pane = el.querySelector('.rb-pane') as HTMLElement;
    this.body = el.querySelector('.rb-body') as HTMLElement;
    (el.querySelector('.rb-tab') as HTMLElement).addEventListener('click', () => this.toggle(!this.open));
    (el.querySelector('.rb-pages') as HTMLElement).addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
      if (!b) return;
      this.page = b.dataset.page as Page; this.sel = -1; this.msg = ''; this.render(); this.view.redraw();
    });
    this.body.addEventListener('click', (e) => this.onClick(e.target as HTMLElement));
  }

  private get builder() { return this.todo.raceBuilder; }
  /** The map should treat a tap as a checkpoint. */
  get active(): boolean { return this.open && this.page === 'build'; }

  toggle(on: boolean): void {
    this.open = on;
    this.el.classList.toggle('open', on);
    host(this.el).classList.toggle('rb-on', on);
    (this.el.querySelector('.rb-tab') as HTMLElement).setAttribute('aria-expanded', String(on));
    if (on) this.render();
    this.view.redraw();
  }
  /** The menu opened or closed: start with the panel folded. */
  reset(): void { if (this.open) this.toggle(false); }

  // ── The map ────────────────────────────────────────────────────────────────

  /** A tap on the map at a world point (menu.ts, only while `active`). */
  click(x: number, z: number): void {
    if (this.pins.length >= BUILT_MAX_PINS) { this.say(`That is the most: ${BUILT_MAX_PINS} checkpoints.`); return; }
    const s1 = snapPoint(this.game, x, z);
    if (typeof s1 === 'string') { this.say(s1); return; }
    // Quantised and snapped again, as every page that gets this race will have it.
    const ix = cellX(s1.x), iz = cellZ(s1.z), q = cellPoint(ix, iz), s2 = snapPoint(this.game, q.x, q.z);
    if (typeof s2 === 'string') { this.say(s2); return; }
    const prev = this.pins[this.pins.length - 1];
    if (prev && Math.hypot(prev.x - s2.x, prev.z - s2.z) < 40) { this.say('Too close to the last checkpoint. Tap further along.'); return; }
    if (prev) {
      const t = this.nav.trace(this.game.plan, prev.x, prev.z, s2.x, s2.z);
      if (!t) { this.say(`No drivable way there from checkpoint ${this.pins.length}. It may be across water or behind a closed street.`); return; }
      this.legs.push(t.poly);
    }
    this.pins.push({ x: s2.x, z: s2.z, ix, iz });
    this.closeLeg();
    this.msg = '';
    this.render(); this.view.redraw();
  }

  private say(m: string): void { this.msg = m; this.render(); }

  private closeLeg(): void {
    this.closing = null;
    if (!(this.back || this.laps > 1) || this.pins.length < 2) return;
    const a = this.pins[this.pins.length - 1], b = this.pins[0];
    const t = this.nav.trace(this.game.plan, a.x, a.z, b.x, b.z);
    this.closing = t ? t.poly : null;
  }

  private lengthM(): number {
    let n = 0;
    for (const p of [...this.legs, ...(this.closing ? [this.closing] : [])]) for (let i = 2; i < p.length; i += 2) n += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    return n;
  }

  /** The overlay on the chart: the route being built, or the race picked from a list. */
  draw(c: CanvasRenderingContext2D, X: (x: number) => number, Z: (z: number) => number, col: RbColors): void {
    if (!this.open) return;
    const line = (p: number[], w: number, color: string): void => {
      if (p.length < 4) return;
      c.beginPath(); c.moveTo(X(p[0]), Z(p[1]));
      for (let i = 2; i < p.length; i += 2) c.lineTo(X(p[i]), Z(p[i + 1]));
      c.lineJoin = 'round'; c.lineCap = 'round'; c.strokeStyle = color; c.lineWidth = w; c.stroke();
    };
    const pin = (x: number, z: number, label: string, start: boolean): void => {
      const px = X(x), py = Z(z), r = 11;
      c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fillStyle = start ? col.teal : col.mustard; c.fill();
      c.strokeStyle = col.ink; c.lineWidth = 2.5; c.stroke();
      c.fillStyle = start ? col.bone : col.ink; c.font = '900 13px "Big Shoulders Display", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, px, py + 0.5);
    };
    if (this.page === 'build') {
      for (const p of this.legs) { line(p, 7, col.ink); }
      if (this.closing) line(this.closing, 7, col.ink);
      for (const p of this.legs) { line(p, 4, col.mustard); }
      if (this.closing) line(this.closing, 4, col.mustard);
      this.pins.forEach((p, i) => pin(p.x, p.z, i === 0 ? 'S' : String(i + 1), i === 0));
      return;
    }
    const e = this.entry(this.sel);
    const b = e ? this.builder.peek(e) : undefined;
    if (!b || typeof b === 'string') return;
    line(b.poly, 7, col.ink); line(b.poly, 4, col.mustard);
    b.pins.forEach((p, i) => pin(p.x, p.z, i === 0 ? 'S' : String(i + 1), i === 0));
  }

  // ── The panel ──────────────────────────────────────────────────────────────

  private entry(i: number): BuiltSpec | null {
    if (i < 0) return null;
    if (this.page === 'mine') return this.builder.personal[i] ?? null;
    if (this.page === 'town') return (this.builder.link?.entries() ?? [])[i]?.spec ?? null;
    return null;
  }

  /** Redraw the panel's DOM when anything it shows has changed (menu.ts calls this while the map is open). */
  refresh(): void { if (this.open && this.rev !== this.builder.rev) this.render(); }

  private render(): void {
    this.rev = this.builder.rev;
    const town = this.builder.link?.entries() ?? [];
    const pages = this.el.querySelector('.rb-pages') as HTMLElement;
    pages.innerHTML = ([['build', 'Build'], ['mine', `My races ${this.builder.personal.length}/${MAX_PERSONAL}`], ['town', `Town Races ${town.length}`]] as [Page, string][])
      .map(([k, t]) => `<button type="button" class="pl-chip${this.page === k ? ' on' : ''}" data-page="${k}">${esc(t)}</button>`).join('');
    if (this.page === 'build') this.renderBuild();
    else this.renderList();
  }

  private renderBuild(): void {
    const n = this.pins.length, len = this.lengthM(), loop = this.back || this.laps > 1;
    const lenText = n >= 2 ? `${distText(len)} per lap${len < MIN_LAP_M && n >= BUILT_MIN_PINS ? ` · needs ${distText(MIN_LAP_M)}` : ''}` : 'tap the map';
    const ok = n >= BUILT_MIN_PINS && len >= MIN_LAP_M;
    this.body.innerHTML = `<div class="rb-help">Tap the map to drop checkpoints on streets. The first one (S) is the start line. ${BUILT_MIN_PINS} to ${BUILT_MAX_PINS}.</div>
<div class="rb-stat"><b>${n} of ${BUILT_MAX_PINS}</b> checkpoints · ${esc(lenText)}${n >= 2 && len > 0 ? ` · par ${clock((len * this.laps) / 11.5)}` : ''}</div>
<div class="rb-row"><span>Laps</span>${[1, 2, 3].map((l) => `<button type="button" class="rb-seg${this.laps === l ? ' on' : ''}" data-laps="${l}">${l}</button>`).join('')}</div>
<div class="rb-row"><span>Finish</span><button type="button" class="rb-seg${loop ? ' on' : ''}" data-back="1">Back at the start</button><button type="button" class="rb-seg${loop ? '' : ' on'}" data-back="0" ${this.laps > 1 ? 'disabled' : ''}>At the last one</button></div>
<div class="rb-row rb-nm"><b>${esc(raceNameText(this.name))}</b><button type="button" class="rb-seg" data-act="name">Another name</button></div>
<div class="rb-btns"><button type="button" class="rb-btn" data-act="undo" ${n ? '' : 'disabled'}>Undo</button><button type="button" class="rb-btn" data-act="clear" ${n ? '' : 'disabled'}>Clear</button><button type="button" class="rb-btn rb-go" data-act="save" ${ok ? '' : 'disabled'}>Save race</button></div>
<div class="rb-msg">${esc(this.msg)}</div>`;
  }

  private rowText(spec: BuiltSpec): { name: string; sub: string; def: RaceDef | null; built: Built | string | undefined } {
    const built = this.builder.peek(spec), def = this.builder.defOf(spec);
    const nm = raceNameText(spec.name);
    if (typeof built === 'string') return { name: nm, sub: `Cannot run here: ${built}`, def: null, built };
    if (!built) return { name: nm, sub: 'working out the streets...', def: null, built };
    const mine = def ? this.builder.best(def) : undefined;
    return { name: nm, sub: `${spec.laps} lap${spec.laps > 1 ? 's' : ''} · ${distText(built.length)} · ${spec.cells.length / 2} checkpoints${mine !== undefined ? ` · your best ${clock(mine)}` : ''}`, def, built };
  }

  private renderList(): void {
    const mine = this.page === 'mine';
    const town = this.builder.link?.entries() ?? [];
    const specs: { spec: BuiltSpec; e?: TownEntry }[] = mine ? this.builder.personal.map((spec) => ({ spec })) : town.map((e) => ({ spec: e.spec, e }));
    const rows = specs.map((o, i) => {
      const t = this.rowText(o.spec);
      const by = o.e ? `${o.e.by ? ` · by ${esc(nameText(o.e.by))}` : ''}${o.e.slot < 0 ? ' · this visit only' : ''}${o.e.best > 0 && o.e.bestBy ? ` · town best ${clock(o.e.best / 10)} (${esc(nameText(o.e.bestBy))})` : ''}` : (this.builder.published(o.spec) ? ' · published' : '');
      return `<li><button type="button" class="pl-row${this.sel === i ? ' on' : ''}" data-i="${i}"><i style="background:#2a9d8f"></i><span class="pl-nm">${esc(t.name)}</span><span class="pl-sub">${esc(t.sub)}${by}</span></button></li>`;
    }).join('') || `<li class="pl-none">${mine ? 'No races saved yet. Build one on the Build page.' : this.builder.link?.online() ? 'Nobody has published a race yet. Publish yours from My races.' : 'You are playing alone: the town has no races to show. Yours are in My races.'}</li>`;
    const cur = this.sel >= 0 ? specs[this.sel] : null;
    let card = '';
    if (cur) {
      const t = this.rowText(cur.spec), ok = !!t.def;
      const pub = this.builder.published(cur.spec);
      card = `<div class="rb-sel"><b>${esc(t.name)}</b><span>${esc(t.sub)}</span><div class="rb-btns">
<button type="button" class="rb-btn rb-go" data-act="drive" ${ok ? '' : 'disabled'}>Drive it</button>
<button type="button" class="rb-btn" data-act="call" ${ok ? '' : 'disabled'}>Call a race</button>
${mine ? `<button type="button" class="rb-btn" data-act="publish" ${ok && !pub ? '' : 'disabled'}>${pub ? 'Published' : 'Publish to town'}</button><button type="button" class="rb-btn" data-act="delete">Delete</button>` : ''}</div></div>`;
    }
    this.body.innerHTML = `${card}<ul class="pl-list rb-list">${rows}</ul><div class="rb-msg">${esc(this.msg)}</div>`;
  }

  private onClick(t: HTMLElement): void {
    const row = t.closest<HTMLElement>('[data-i]');
    if (row) {
      this.sel = Number(row.dataset.i); this.msg = '';
      const s = this.entry(this.sel), b = s ? this.builder.peek(s) : undefined;
      this.render();
      if (b && typeof b !== 'string') this.view.focus(b.pins[0].x, b.pins[0].z, 0.5);
      this.view.redraw();
      return;
    }
    const seg = t.closest<HTMLButtonElement>('[data-laps],[data-back],[data-act]');
    if (!seg || seg.disabled) return;
    if (seg.dataset.laps) { this.laps = Number(seg.dataset.laps); if (this.laps > 1) this.back = true; this.closeLeg(); this.render(); this.view.redraw(); return; }
    if (seg.dataset.back !== undefined) { this.back = seg.dataset.back === '1'; this.closeLeg(); this.render(); this.view.redraw(); return; }
    const act = seg.dataset.act;
    if (act === 'name') { this.name = (this.name + 1 + Math.floor(Math.random() * (BUILT_NAMES - 1))) % BUILT_NAMES; this.render(); return; }
    if (act === 'undo') { this.pins.pop(); this.legs.pop(); this.closeLeg(); this.msg = ''; this.render(); this.view.redraw(); return; }
    if (act === 'clear') { this.pins = []; this.legs = []; this.closing = null; this.msg = ''; this.render(); this.view.redraw(); return; }
    if (act === 'save') {
      const spec: BuiltSpec = { name: this.name, laps: this.laps, back: this.back || this.laps > 1, cells: this.pins.flatMap((p) => [p.ix, p.iz]) };
      const why = this.builder.addPersonal(spec);
      if (why) { this.say(why); return; }
      this.pins = []; this.legs = []; this.closing = null; this.name = Math.floor(Math.random() * BUILT_NAMES);
      this.page = 'mine'; this.sel = this.builder.personal.length - 1;
      this.msg = 'Saved. Drive it, or publish it so the town can race it.';
      this.render(); this.view.redraw();
      return;
    }
    const spec = this.entry(this.sel);
    if (!spec) return;
    if (act === 'delete') { this.builder.removePersonal(this.sel); this.sel = -1; this.msg = 'Deleted.'; this.render(); this.view.redraw(); return; }
    if (act === 'publish') {
      const why = this.builder.publish(spec);
      this.msg = why ?? 'Published. The town sees it in Town Races.';
      this.render(); return;
    }
    if (act === 'drive' || act === 'call') {
      let def = this.builder.defOf(spec);
      if (!def) return;
      if (act === 'call' && def.idx >= 80) {
        // A race the town does not have yet: share it first (publishing, if it can be), then it can be called.
        const why = this.builder.publish(spec);
        if (why) { this.say(`To call a race, it has to be in the town first: ${why}`); return; }
        def = this.builder.defOf(spec) ?? def;
        if (def.idx >= 80) { this.say('Sent to the town. Give it a moment, then pick it in Town Races and choose Call a race.'); return; }
      }
      this.builder.goTo(def);
      this.game.hud.toast(act === 'call'
        ? `Drive to the start of "${def.name}" (the waypoint) and press G: everybody in town gets the call and the grid forms at the lights.`
        : `Drive to the start of "${def.name}" (the waypoint) and press G for a time trial.`, 8);
      this.view.resume();
    }
  }
}

function host(el: HTMLElement): HTMLElement { return el.parentElement as HTMLElement; }
