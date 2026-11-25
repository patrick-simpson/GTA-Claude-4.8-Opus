// The Fish Log (fun queue 2, item 15): Section I of the pause menu's Progress page, a grid like Pardon's Finds ledger:
// a silhouette for every catch not yet landed, and for the others the best weight, how many, where, and the log's line.
// Icons are drawn here as inline SVG (no assets): the same drawing, ink-black and faint, is the silhouette.

import { SPECIES, SPECIES_COUNT, SPOTS, bestOz, caughtN, heaviest, spotNames, spotsOf, speciesCaught, stat, weightText, type Species } from './fishData';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function shape(s: Species, sil: boolean): string {
  const c = sil ? '#14213d' : s.color, b = sil ? '#14213d' : s.belly, ink = sil ? '#14213d' : '#14213d';
  switch (s.look) {
    case 'boot':
      return `<path d="M12 6h13v16c0 3 3 4 8 6 4 1.5 5 3 5 6v3H8V6z" fill="${c}" stroke="${ink}" stroke-width="1.6"/><path d="M8 34h30" stroke="${sil ? c : '#b8a888'}" stroke-width="2.4"/><path d="M12 11h13" stroke="${sil ? c : '#7a5a3e'}" stroke-width="1.4"/>`;
    case 'ticket':
      return `<rect x="6" y="10" width="32" height="24" rx="1.5" fill="${c}" stroke="${ink}" stroke-width="1.6" transform="rotate(-8 22 22)"/><g transform="rotate(-8 22 22)" stroke="${sil ? c : '#14213d'}" stroke-width="1.6"><path d="M11 17h22M11 22h22M11 27h14"/></g>`;
    case 'ring':
      return `<circle cx="22" cy="26" r="11" fill="none" stroke="${c}" stroke-width="5"/><circle cx="22" cy="26" r="11" fill="none" stroke="${ink}" stroke-width="1.2"/><path d="M16 11l6-5 6 5-6 7z" fill="${b}" stroke="${ink}" stroke-width="1.4"/>`;
    case 'lobster':
      return `<ellipse cx="22" cy="26" rx="6" ry="13" fill="${c}" stroke="${ink}" stroke-width="1.5"/><path d="M16 8c-4-1-8 2-6 6 2 3 6 2 7-1zM28 8c4-1 8 2 6 6-2 3-6 2-7-1z" fill="${c}" stroke="${ink}" stroke-width="1.5"/><path d="M19 38l3 4 3-4" fill="${c}" stroke="${ink}" stroke-width="1.5"/><path d="M14 22l-5 3M14 28l-5 4M30 22l5 3M30 28l5 4" stroke="${ink}" stroke-width="1.4"/>`;
    case 'eel':
      return `<path d="M3 30c6-14 10 4 17-6s10 4 20-4" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round"/><path d="M3 30c6-14 10 4 17-6s10 4 20-4" fill="none" stroke="${c}" stroke-width="5.4" stroke-linecap="round"/><circle cx="38" cy="20.6" r="1.1" fill="${sil ? c : '#f2e8cf'}"/>`;
    default: {
      const rx = 14 * s.len, ry = 8.6 * s.tall, cx = 22 + (s.len - 1) * 3, tailX = cx - rx;
      return `<path d="M${tailX + 2} 22L${tailX - 8} ${22 - ry * 0.9}L${tailX - 5} 22L${tailX - 8} ${22 + ry * 0.9}z" fill="${c}" stroke="${ink}" stroke-width="1.4" stroke-linejoin="round"/>`
        + `<ellipse cx="${cx}" cy="22" rx="${rx}" ry="${ry}" fill="${c}" stroke="${ink}" stroke-width="1.5"/>`
        + `<path d="M${cx - rx * 0.7} ${22 + ry * 0.45}Q${cx} ${22 + ry * 1.05} ${cx + rx * 0.8} ${22 + ry * 0.2}Q${cx} ${22 + ry * 0.62} ${cx - rx * 0.7} ${22 + ry * 0.45}z" fill="${b}" opacity="0.9"/>`
        + `<path d="M${cx - rx * 0.2} ${22 - ry}l5-5 4 5z" fill="${c}" stroke="${ink}" stroke-width="1.2"/>`
        + `<circle cx="${cx + rx * 0.68}" cy="${22 - ry * 0.18}" r="1.5" fill="${sil ? c : '#f2e8cf'}" stroke="${sil ? 'none' : ink}" stroke-width="0.8"/>`;
    }
  }
}

/** A catch's icon as a data URI: coloured, or an ink silhouette. */
export function fishIcon(i: number, got: boolean): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">${shape(SPECIES[i], !got)}</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/** Section I of the Progress page. */
export function fishLogHtml(): string {
  const n = speciesCaught(), hv = heaviest();
  const cells = SPECIES.map((s, i) => {
    const got = caughtN(i) > 0;
    const rar = s.w < 1 ? 'ultra' : s.w < 3 ? 'rare' : s.w < 5 ? 'uncommon' : 'common';
    const where = spotNames(spotsOf(i)).join(', ');
    const meta = got
      ? `<small><b>${s.junk ? 'Found' : 'Best'} ${s.name === 'Parking ticket' || s.name === "Class ring, Dithers '74" ? '' : weightText(bestOz(i))}</b> · ${caughtN(i)} caught · ${esc(where)}<br>${esc(s.line)}</small>`
      : `<small>${esc(s.where)}</small>`;
    return `<div class="mn-find mn-fish ${got ? 'got' : ''} r-${rar}" title="${got ? esc(s.line) : 'Not yet landed'}">
  <img alt="" width="44" height="44" src="${fishIcon(i, got)}"><b>${got ? esc(s.name) : '???'}</b>
  <em>${s.junk ? 'junk' : rar === 'ultra' ? 'LEGEND' : rar}</em>${meta}</div>`;
  }).join('');
  return `<h3>Section I · Fish Log (${n} of ${SPECIES_COUNT})</h3>
<p class="mn-note">Heaviest catch: ${hv > 0 ? weightText(hv) : 'none yet'} · Sold ${stat('sold')} (earned $${stat('cash')}) · Released ${stat('rel')}, which the pond has noted. Fishing is permitted, probably, at ${SPOTS.length} places: the pier end, the breakwater, below Tepid Falls, the river walk, Johnson Pond, and both ferry landings. Press G at a spot sign.</p>
<div class="mn-finds mn-fishes">${cells}</div>`;
}
