// Somewhere to spend it besides the bridge: an ammunition counter and a body shop.
//
// Each is a sign on a real wall (the same frontage the Harbor Patrol station
// and Fresh Coat use) and a prompt: walk up to the counter with a weapon in
// hand, or drive a bent car onto the apron. Neither earns anything.

import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { WEAPONS } from '../ent/weapons';
import { frontage } from '../sim/policeAir';
import { money } from '../core/util';
import { kid } from '../core/kid';
import { damageOf, repairDamage } from '../ent/carDamage';
import type { Markers, Pt } from './script';

/** Rounds per purchase and the price, by weapon slot. Slot 0 is bare hands. */
const AMMO: { rounds: number; price: number }[] = [{ rounds: 0, price: 0 }, { rounds: 24, price: 60 }, { rounds: 60, price: 120 }, { rounds: 12, price: 90 }, { rounds: 2, price: 400 }];
const PISTOL_PRICE = 300;

export class Shops {
  prompt: string | null = null;
  readonly list: { at: Pt; letter: string; name: string }[] = [];
  private readonly ammo: Pt;
  private readonly body: Pt;
  private told = 0;

  constructor(private readonly game: Game, private readonly markers: Markers) {
    const plan = game.plan;
    // The north side of a Ledger District block, facing Ledger St; and the north side of a Dock Seven block, facing Tinplate St.
    const a = plan.sidewalkPoint(7, 4, 0, 0.3), b = plan.sidewalkPoint(8, 6, 0, 0.25);
    frontage(game, a.x, a.z, 0, 1, 'FORMS & ROUNDS', 'AMMUNITION COUNTER  ·  TAKE A NUMBER, THEN TAKE COVER', '#f2e8cf', '#9c4a3c', false);
    frontage(game, b.x, b.z, 0, 1, 'BENT & DENTED', 'BODY SHOP  ·  WE HAVE SEEN WORSE, AND BILLED FOR IT', '#14213d', '#8a9a6b', true);
    this.ammo = { x: a.x, z: a.z };
    this.body = { x: b.x, z: b.z - 5.4 };
    this.list.push({ at: this.ammo, letter: 'A', name: `Forms & Rounds, ${plan.streetAt(a.x, a.z - 6)}` });
    this.list.push({ at: this.body, letter: 'B', name: `Bent & Dented, ${plan.streetAt(b.x, b.z - 6)}` });
  }

  blips(out: Blip[]): void {
    const p = this.game.player;
    // (Kid-friendly mode, core/kid.ts: the ammunition counter is shut and off the radar.)
    for (const s of this.list) if ((!kid.on || s.letter !== 'A') && Math.hypot(p.x - s.at.x, p.z - s.at.z) < 260) out.push({ x: s.at.x, z: s.at.z, kind: 'job', label: s.letter });
  }

  update(dt: number): void {
    const g = this.game, p = g.player, v = p.vehicle, hud = g.hud;
    this.prompt = null;
    this.told -= dt;
    const tell = (text: string): void => { if (this.told <= 0) { this.told = 4; hud.toast(text, 4); } };
    const da = Math.hypot(p.x - this.ammo.x, p.z - this.ammo.z), db = Math.hypot(p.x - this.body.x, p.z - this.body.z);
    if (kid.on) { if (!v && da < 3.2) this.prompt = 'Forms & Rounds is shut today. A sign on the door says: GONE FISHING. CATCH AND RELEASE.'; }
    else if (da < 120) this.markers.put(this.ammo.x, this.ammo.z, 'job', 1.6, 10);
    if (db < 120) this.markers.put(this.body.x, this.body.z, 'job', 4, 10);

    if (!v && da < 3.2 && !kid.on) {
      const w = p.weapons, i = w.slot;
      if (i === 0 && !w.owned[1]) {
        this.prompt = `[G] Buy a ${WEAPONS[1].name} and ${AMMO[1].rounds} rounds: ${money(PISTOL_PRICE)}`;
        if (g.input.eat('interact')) {
          if (p.money < PISTOL_PRICE) tell(`Forms & Rounds wants ${money(PISTOL_PRICE)}. You have a form.`);
          else { p.money -= PISTOL_PRICE; w.give('pistol', AMMO[1].rounds); hud.toast(`One ${WEAPONS[1].name}. Sign here, here, and do not point it there.`, 5); }
        }
      } else if (i === 0) this.prompt = 'Forms & Rounds: draw the weapon you want rounds for (Q / E).';
      else {
        const spec = WEAPONS[i], a = AMMO[i];
        if (w.spare[i] >= spec.reserve) this.prompt = `Forms & Rounds: the ${spec.name} is carrying all it can.`;
        else {
          this.prompt = `[G] ${a.rounds} rounds for the ${spec.name}: ${money(a.price)}`;
          if (g.input.eat('interact')) {
            if (p.money < a.price) tell(`That is ${money(a.price)}. The counter does not do credit; the counter has met you.`);
            else { p.money -= a.price; w.give(spec.id, a.rounds); }
          }
        }
      }
      return;
    }
    if (v && Math.abs(p.x - this.body.x) < 5.5 && Math.abs(p.z - this.body.z) < 4.5 && p.speed < 3) {
      if (p.heat > 0) { this.prompt = 'Bent & Dented does not open the door while the Patrol is looking for you.'; return; }
      const dmg = damageOf(v);
      if (v.health >= 99.5 && (!dmg || dmg.clean())) { this.prompt = `Bent & Dented: nothing wrong with the ${v.spec.name} that they can bill for.`; return; }
      const price = 40 + Math.ceil((100 - v.health) * 3) + (dmg ? Math.ceil(dmg.wear() * 120) : 0);
      this.prompt = `[G] Repair the ${v.spec.name}: ${money(price)}`;
      if (g.input.eat('interact')) {
        if (p.money < price) tell(`Bent & Dented wants ${money(price)}. They will hold the car while you think about it. They will not.`);
        else { p.money -= price; v.health = 100; repairDamage(v); hud.toast(`Bent & Dented: ${money(price)}. Good as new, which it never was.`, 5); }
      }
    }
  }
}
