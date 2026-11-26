// The Unlocks page of the pause menu (fun queue 2, item 49): Form U-1, the places found, then every unlock as a
// card: earned ones with what they are and a button (call the car, wear the outfit), the others with the hint and
// how far along it is. All text is made here from game/unlocksData.ts; the menu wires the clicks.

import './unlocksPage.css';
import type { Unlocks } from '../game/unlocks';
import { KIND_NAME, type UnlockKind } from '../game/unlocksData';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const KINDS: UnlockKind[] = ['car', 'outfit', 'paint', 'station'];

export function unlocksHtml(u: Unlocks, msg: string): string {
  const n = u.foundCount(), tot = u.total(), items = u.list(), got = items.filter((i) => i.on).length;
  const places = u.defs().map((d) => u.isFound(d.id)
    ? `<li class="ul-pl on"><i>&#10003;</i><b>${esc(d.name)}</b></li>`
    : `<li class="ul-pl"><i>?</i><b>${esc(d.hint)}</b></li>`).join('');
  const card = (it: (typeof items)[number]): string => {
    const d = it.u, sw = d.paint !== undefined ? `<span class="ul-sw" style="--c:${hex(d.paint)}"></span>` : d.car ? `<span class="ul-sw ul-car" style="--c:${hex(d.car.color)}"></span>` : '';
    if (!it.on) {
      const pct = Math.round((it.have / Math.max(1, it.goal)) * 100);
      return `<div class="ul-card lock" data-ul="${d.id}">${sw}<b>${esc(d.name)}</b><em>locked</em><small>${esc(d.hint)}</small><span class="mn-bar"><i style="transform:scaleX(${pct / 100})"></i></span><small class="ul-prog">${it.have} of ${it.goal}</small></div>`;
    }
    const act = d.car ? `<button type="button" class="mn-btn ul-act" data-call="${d.id}">Bring it round</button>`
      : d.outfit ? `<button type="button" class="mn-btn ul-act" data-wear="${d.id}">Wear it</button>` : '';
    return `<div class="ul-card on" data-ul="${d.id}">${sw}<b>${esc(d.name)}</b><em>earned</em><small>${esc(d.note)}</small>${act}</div>`;
  };
  const secs = KINDS.map((k) => {
    const list = items.filter((i) => i.u.kind === k);
    return list.length ? `<div class="mn-sec mn-wide"><h3>${KIND_NAME[k]} (${list.filter((i) => i.on).length} of ${list.length})</h3><div class="ul-grid">${list.map(card).join('')}</div></div>` : '';
  }).join('');
  return `<div class="mn-sec mn-wide"><h3>Form U-1 · Places found (${n} of ${tot}) · Unlocks earned (${got} of ${items.length})</h3>
<span class="mn-bar"><i style="transform:scaleX(${tot ? n / tot : 0})"></i></span>
<p class="mn-note">Walk or drive through a district or a landmark to find it. The big map fogs the places you have not found and ticks the rest. Unlocks only add things: nothing you had is ever taken away.${msg ? ` <b class="ul-msg">${esc(msg)}</b>` : ''}</p>
<ul class="ul-places">${places}</ul></div>${secs}`;
}
