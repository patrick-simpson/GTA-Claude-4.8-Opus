// The Calamity Courtesy Cab's paperwork: a black veil and Form FT-1 (game/travel.ts drives the fade every tick, so the
// frozen test harness sees the same thing the player does).

import './travel.css';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export class CabCard {
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  /** Last veil value, for the tests. */
  veil = 0;

  constructor() {
    const el = document.createElement('div');
    el.id = 'cab';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="cab-card"><div class="cab-lbl">Calamity Courtesy Cab · Form FT-1</div><div class="cab-t">TRANSFER AUTHORISED</div><div class="cab-body"></div><div class="cab-sm">Please keep your hands inside the paperwork.</div></div>';
    document.body.appendChild(el);
    this.el = el;
    this.body = el.querySelector('.cab-body') as HTMLElement;
  }

  open(from: string, to: string, fare: number): void {
    this.body.innerHTML = `<dl><dt>From</dt><dd>${esc(from)}</dd><dt>To</dt><dd>${esc(to)}</dd><dt>Fare</dt><dd>${fare === 0 ? 'Waived (kid-friendly mode)' : '$' + fare}</dd></dl>`;
    this.el.classList.add('on');
    this.fade(0);
  }

  /** v: how black the screen is, 0..1. The card shows from a third of the way in and goes before the veil lifts. */
  fade(v: number, leaving = false): void {
    this.veil = v;
    this.el.style.setProperty('--veil', v.toFixed(3));
    const c = leaving ? Math.max(0, (v - 0.4) / 0.6) : Math.max(0, (v - 0.35) / 0.65);
    this.el.style.setProperty('--card', c.toFixed(3));
  }

  close(): void { this.el.classList.remove('on'); this.veil = 0; }
}
