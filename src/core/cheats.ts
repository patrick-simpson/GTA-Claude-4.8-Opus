// Typed cheat words. No prompt, no menu: type the word while playing.
// Kept deliberately silly; none of them are needed to finish anything.

import type { Game } from './game';

type Cheat = { word: string; run: (g: Game) => string };

const CHEATS: Cheat[] = [
  { word: 'NOONISH', run: (g) => { g.sky.hour = 12; return 'The sun has been asked to hurry up.'; } },
  { word: 'NIGHTOWL', run: (g) => { g.sky.hour = 23.5; return 'Lamps on. Gulls off.'; } },
  { word: 'THREEAM', run: (g) => { g.sky.hour = 2.95; return 'Nothing good happens at 3 AM. Look toward the lighthouse.'; } },
  { word: 'PEASOUP', run: (g) => { g.sky.setWeather('fog'); return 'Fog ordered. The Harbor Authority denies everything.'; } },
  { word: 'DRIZZLE', run: (g) => { g.sky.setWeather('rain'); return 'Forecast: wet, with a chance of wetter.'; } },
  { word: 'BLUESKY', run: (g) => { g.sky.setWeather('clear'); return 'Weather cancelled due to weather.'; } },
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
  { word: 'DOOFUS', run: (g) => { g.player.money += 99.9; return 'WDOOF 99.9 thanks you for listening. Here is $99.90.'; } },
];

export class Cheats {
  /** How many cheats have been used. The pause menu reports mistakes as "0*"; this is the asterisk. */
  used = 0;
  private seen = 0;

  constructor(private game: Game) {}

  update(): void {
    const typed = this.game.input.typed;
    if (typed.length === this.seen) return;
    this.seen = typed.length;
    let s = '';
    for (const code of typed) s += code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : ' ';
    for (const c of CHEATS) {
      if (!s.endsWith(c.word)) continue;
      typed.length = 0;
      this.seen = 0;
      this.used++;
      this.game.hud.toast(c.run(this.game), 5);
      return;
    }
  }
}
