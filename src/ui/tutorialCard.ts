// Fun queue 2, item 36: the first-hour card (game/tutorial.ts). A small paper card under the objective strip: who is
// talking, what they say, the one thing to do and the key for a keyboard and the button for a phone, with Skip step and
// End tour buttons for a tap. It never blocks play: only its own buttons take the pointer, and a keyboard player uses the
// comma key (tap: skip the step, or say yes to the offer; hold: end the tour, or say no thanks).

import './tutorialCard.css';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export interface CardView {
  who: string; say: string;
  /** Step number and count, or null for the offer and the last card. */
  n: number | null; of: number;
  goal: string; kb: string; touch: string;
  /** What the tap button and the key say. */
  mode: 'offer' | 'step' | 'done';
  /** A phone: only the phone line, compact. */
  phone?: boolean;
}

export interface CardActions { yes(): void; no(): void; skip(): void; end(): void; close(): void }

export class TutorialCard {
  private readonly el: HTMLDivElement;
  private key = '';

  constructor(private readonly act: CardActions) {
    this.el = document.createElement('div');
    this.el.id = 'tut-card';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const a = b.dataset.act;
      if (a === 'yes') this.act.yes(); else if (a === 'no') this.act.no(); else if (a === 'skip') this.act.skip(); else if (a === 'end') this.act.end(); else if (a === 'close') this.act.close();
    });
  }

  get shown(): boolean { return this.el.classList.contains('on'); }

  hide(): void { this.el.classList.remove('on'); this.key = ''; }

  show(v: CardView): void {
    const k = JSON.stringify(v);
    if (k === this.key && this.shown) return;
    this.key = k;
    const head = v.mode === 'step' && v.n !== null ? `${esc(v.who)} <span>step ${v.n} of ${v.of}</span>` : esc(v.who);
    let body = `<p class="tt-say">${esc(v.say)}</p>`;
    let foot: string;
    if (v.mode === 'step') {
      body += `<p class="tt-goal">${esc(v.goal)}</p>`
        + `<p class="tt-key"><b>Keyboard</b> ${esc(v.kb)}</p><p class="tt-key"><b>Phone</b> ${esc(v.touch)}</p>`;
      foot = '<button type="button" data-act="skip">Skip step</button><button type="button" data-act="end">End tour</button><small>, skip · hold , end</small>';
    } else if (v.mode === 'offer') {
      foot = '<button type="button" class="go" data-act="yes">Show me</button><button type="button" data-act="no">No thanks</button><small>, yes · hold , no</small>';
    } else {
      foot = '<button type="button" class="go" data-act="close">Thanks, Lou</button>';
    }
    this.el.innerHTML = `<div class="tt-hd">${head}</div>${body}<div class="tt-ft">${foot}</div>`;
    this.el.classList.toggle('tch', !!v.phone);
    this.el.classList.add('on');
  }
}
