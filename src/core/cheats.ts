// Typed cheat words. No prompt, no menu: type the word while playing.
// Kept deliberately silly; none of them are needed to finish anything.
//
// Words start with a letter that is safe to press (P would open the pause
// card, F would throw you out of the car). Every letter after the first is
// kept away from the controls: see update().

import type { Game } from './game';
import type { Action } from './input';

type Cheat = { word: string; run: (g: Game) => string };

const CHEATS: Cheat[] = [
  { word: 'NOONISH', run: (g) => { g.sky.ask(12); return 'The sun has been asked to hurry up.'; } },
  { word: 'NIGHTOWL', run: (g) => { g.sky.ask(23.5); return 'Lamps on. Gulls off.'; } },
  { word: 'THREEAM', run: (g) => { g.sky.ask(2.95); return 'Nothing good happens at 3 AM. Look toward the lighthouse.'; } },
  { word: 'SOUPY', run: (g) => { g.sky.ask(null, 'fog'); return 'Fog ordered. The Harbor Authority denies everything.'; } },
  { word: 'DRIZZLE', run: (g) => { g.sky.ask(null, 'rain'); return 'Forecast: wet, with a chance of wetter.'; } },
  { word: 'BLUESKY', run: (g) => { g.sky.ask(null, 'clear'); return 'Weather cancelled due to weather.'; } },
  {
    word: 'TOWME', run: (g) => {
      const p = g.player;
      g.vehicles.spawn('tow', p.x + Math.sin(p.h) * 9, p.z + Math.cos(p.h) * 9, p.h + Math.PI / 2);
      return 'One Mule Wrecker, slightly used.';
    },
  },
  {
    word: 'ZOOMIES', run: (g) => {
      const p = g.player;
      g.vehicles.spawn('sports', p.x + Math.sin(p.h) * 8, p.z + Math.cos(p.h) * 8, p.h + Math.PI / 2);
      return 'A Cormorant RS. Try not to bend it.';
    },
  },
  { word: 'QUACK', run: () => 'Somewhere in the harbor, something large and yellow feels seen.' },
  { word: 'BADIDEAS', run: (g) => { g.player.weapons.giveAll(); return 'Requisition approved in error. One of everything. Sign nowhere.'; } },
  { word: 'DOOFUS', run: (g) => { g.player.money += 99.9; return 'WDOOF 99.9 thanks you for listening. Here is $99.90.'; } },
];

/** One-shot controls bound to letters. Steering and walking are held keys and need no protecting. */
const LETTER_ACTIONS: Action[] = [
  'enter', 'reload', 'nextWeapon', 'prevWeapon', 'horn', 'radio', 'pause', 'map', 'interact', 'lookBack', 'camera',
];

export class Cheats {
  /** How many cheats have been used. The pause menu reports mistakes as "0*"; this is the asterisk. */
  used = 0;
  private seen = 0;

  constructor(private game: Game) {}

  /**
   * Runs before anything else reads the keys. Once the last two letters typed are the
   * start of a word, the letter just pressed belongs to the word and not to the
   * controls: typing DOOFUS in a car used to end with Dess standing in the road,
   * because F is also "get out".
   */
  update(): void {
    const input = this.game.input;
    if (input.typedN === this.seen) return;
    this.seen = input.typedN;
    const typed = input.typed;
    let s = '';
    for (const code of typed) s += code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : ' ';
    for (const c of CHEATS) {
      if (!s.endsWith(c.word)) continue;
      typed.length = 0;
      this.used++;
      this.swallow();
      this.game.hud.toast(c.run(this.game), 5);
      return;
    }
    for (const c of CHEATS) {
      for (let n = Math.min(c.word.length - 1, s.length); n >= 2; n--) {
        if (s.endsWith(c.word.slice(0, n))) { this.swallow(); return; }
      }
    }
  }

  private swallow(): void {
    for (const a of LETTER_ACTIONS) this.game.input.eat(a);
  }
}
