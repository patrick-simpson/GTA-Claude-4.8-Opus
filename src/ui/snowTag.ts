// The snowball fight's tag (fun queue 2, item 27; the fight is game/snowfight.ts): your snowballs in hand and, on a phone,
// Throw and Scoop buttons (G throws and R scoops on a keyboard); before you are in, a Join tap while a fight is on at the
// field you stand on. And the white splat when you are hit.

import './snowTag.css';
import type { Game } from '../core/game';
import { MAX_AMMO, type SnowFight } from '../game/snowfight';

export class SnowTag {
  private readonly tag: HTMLDivElement;
  private readonly splatEl: HTMLDivElement;
  private shown = '';

  constructor(private readonly game: Game, private readonly fight: SnowFight) {
    this.tag = document.createElement('div');
    this.tag.id = 'sf-tag';
    document.body.appendChild(this.tag);
    this.splatEl = document.createElement('div');
    this.splatEl.id = 'sf-splat';
    document.body.appendChild(this.splatEl);
    fight.ui = this;
    this.tag.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      e.preventDefault();
      if (b.classList.contains('throw')) this.fight.throwBall();
      else if (b.classList.contains('scoop')) this.fight.startScoop();
      else if (b.classList.contains('join')) this.fight.press();
    });
  }

  splat(): void {
    this.splatEl.classList.remove('on');
    void this.splatEl.offsetWidth;
    this.splatEl.classList.add('on');
  }

  /** Once a frame the town runs. */
  update(): void {
    const t = this.fight.tag(), touch = this.game.input.touch;
    const key = `${t.in}|${t.ammo}|${t.scooping}|${t.phase}|${t.join ?? ''}|${t.line}|${touch}`;
    if (key === this.shown) return;
    this.shown = key;
    const on = t.in || !!t.join;
    this.tag.classList.toggle('on', on);
    this.tag.classList.toggle('red', t.in && t.line.startsWith('RED'));
    this.tag.classList.toggle('blue', t.in && t.line.startsWith('BLUE'));
    if (!on) { this.tag.textContent = ''; return; }
    if (t.join) { this.tag.innerHTML = `<button type="button" class="join">${t.join.replace(/[<>&]/g, '')}</button>`; return; }
    let balls = '';
    for (let i = 0; i < MAX_AMMO; i++) balls += `<i class="${i < t.ammo ? '' : 'off'}"></i>`;
    const btns = touch ? `<button type="button" class="throw"${t.phase === 2 && t.ammo ? '' : ' disabled'}>Throw</button><button type="button" class="scoop"${t.ammo >= MAX_AMMO || t.scooping ? ' disabled' : ''}>Scoop</button>` : '';
    this.tag.innerHTML = `<span class="sf-balls">${balls}</span><span>${t.scooping ? 'Scooping...' : 'Snowballs'}</span>${btns}`;
  }
}
