// Kid-friendly mode (owner, Nov 23): "a toggle that would take effect for all players that makes the game kid friendly,
// no shooting, no killing people". A switch in the pause menu's settings that anyone can flip.
//
// `kid.on` is what every system obeys, read directly where it matters (no events):
//  - ent/weapons.ts: nothing can be drawn or fired (guns, the launcher, fists), the crates are gone, blasts hurt nobody.
//  - ent/player.ts: nothing takes health off her; she is knocked over and gets up. No CLOCKED OUT, no hospital bill.
//  - sim/peds.ts: a car never puts anybody down for good. sim/police.ts: officers never draw; a hold is a ticket.
//  - game/shops.ts (the counter is shut), game/script.ts (the van mission is a shove, not a blast), ui/menu.ts, ui/touch.ts.
//
// Alone it is this browser's own choice, saved here. In a town it is the town's (net/town.ts, the fact FACT_KID): a flip
// asks the town, and everybody there is switched at once, including the host's police and crowd.

const KEY = 'portcalamity.kid';

export const KID_ON_LINE = 'Kid-friendly mode is on. Nobody gets hurt in Port Calamity today.';
export const KID_OFF_LINE = 'Kid-friendly mode is off. Port Calamity is back to its usual self.';

class Kid {
  /** What the game obeys right now. */
  on = false;
  /** This browser's own saved choice (what it is alone). */
  own = false;
  /** Set by net/town.ts while in a town: a flip goes to the town. True when it took the flip. */
  ask: ((on: boolean) => boolean) | null = null;
  /** Set by whoever can show a toast (net/town.ts). */
  tell: ((line: string) => void) | null = null;
  /** Bumped on every change, for anything that redraws (the menu). */
  changes = 0;

  constructor() {
    try { this.own = localStorage.getItem(KEY) === '1'; } catch { /* no storage: off */ }
    try { const q = new URLSearchParams(location.search).get('kid'); if (q === '1' || q === '0') this.own = q === '1'; } catch { /* fine */ }
    this.on = this.own;
  }

  /** The menu's switch, at this keyboard. */
  flip(on: boolean): void {
    this.own = on;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* fine */ }
    if (this.ask?.(on)) return;
    this.set(on, on ? KID_ON_LINE : KID_OFF_LINE);
  }

  /** Change what the game obeys; `line` is said if it changed (null: quietly). */
  set(on: boolean, line: string | null): void {
    if (on === this.on) return;
    this.on = on;
    this.changes++;
    if (line) this.tell?.(line);
  }
}

export const kid = new Kid();
