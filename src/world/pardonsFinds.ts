// Pardon's Finds, the hunt (fun queue 2, item 13; the list is pardonsCatalogue.ts, the models pardonsItems.ts).
//
// Each UTC day 3 to 5 finds are hidden in Pardon's: on shelves, up on top of the tall gondolas, in the rug bins, under the
// furniture tables, at the foot of the clothing racks and on the sofas. Where is a pure function of the date and the
// store's fixture layout (models/pardons_stock.json), so every player in the town sees the same set in the same places.
// A faint sparkle shows within a few metres; walk up and press F to file it for $2. Each player's own save keeps what
// they have filed (pardonsCatalogue.ts), a find already catalogued is not put out again for that player.
//
// Cost: the finds' group is a child of the stock group, so it is drawn only when the stock is (inside, or right at the
// glass). Nothing runs per frame except a distance check over at most five finds, and the sparkle sprites of those within
// a few metres. The day is re-read once a minute so a store left open across midnight UTC changes its set.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { PD } from './pardonsSite';
import { bakedLight } from './pardonsStock';
import { findGeometry } from './pardonsItems';
import { FINDS, FIND_PRICE, RARITY_LABEL, dailyIds, dayRng, findsDay, hasFound, markFound, FIND_COUNT } from './pardonsCatalogue';

export type SpotKind = 'shelf' | 'top' | 'bin' | 'under' | 'rack' | 'sofa';
/** Store frame: where a find sits, how it faces, and a spot in the aisle to stand at (for tests). */
export interface Spot { kind: SpotKind; x: number; y: number; z: number; rot: number; stand: [number, number] }
export interface Placed { id: number; spot: Spot }
interface Layout { runs: number[][]; fx: [string, number, number, number, number][] }

const SHELF_LEVELS = [0.15, 0.55, 0.95, 1.35];
const KIND_WEIGHT: [SpotKind, number][] = [['shelf', 8], ['top', 4], ['bin', 1.5], ['under', 1.5], ['rack', 1.5], ['sofa', 1.2]];
const MIN_APART = 5;
export const REACH = 2.1;

function pickSpot(r: () => number, L: Layout): Spot {
  let t = r() * KIND_WEIGHT.reduce((s, k) => s + k[1], 0), kind: SpotKind = 'shelf';
  for (const [k, w] of KIND_WEIGHT) { t -= w; if (t <= 0) { kind = k; break; } }
  const of = (k: string): [string, number, number, number, number][] => L.fx.filter((f) => f[0] === k);
  const q = (v: number): number => Math.round(v * 20) / 20;
  const run = (): number[] => L.runs[Math.floor(r() * L.runs.length)];
  switch (kind) {
    case 'top': {
      const rn = run(), side = r() < 0.5 ? -1 : 1, z = q(rn[1] + 0.5 + r() * (rn[2] - rn[1] - 1));
      return { kind, x: rn[0] + side * 0.2, y: rn[4], z, rot: r() * 6.28, stand: [rn[0] + side * 1.5, z] };
    }
    case 'bin': {
      const f = of('pk_rugbin'); if (!f.length) break;
      const b = f[Math.floor(r() * f.length)];
      return { kind, x: q(b[1] + (r() - 0.5) * 1.4), y: 1.62, z: b[2], rot: r() * 6.28, stand: [b[1], b[2] + 1.05] };
    }
    case 'under': {
      const f = of('pk_table'); if (!f.length) break;
      const b = f[Math.floor(r() * f.length)], sx = r() < 0.5 ? -1 : 1, sz = r() < 0.5 ? -1 : 1;
      return { kind, x: b[1] + sx * 0.45, y: 0.02, z: b[2] + sz * 0.45, rot: r() * 6.28, stand: [b[1] + sx * 1.6, b[2] + sz * 0.45] };
    }
    case 'rack': {
      const f = of('pk_rround'); if (!f.length) break;
      const b = f[Math.floor(r() * f.length)];
      return { kind, x: q(b[1] + (r() - 0.5) * 0.6), y: 0.02, z: q(b[2] + (r() - 0.5) * 0.6), rot: r() * 6.28, stand: [b[1], b[2] + 1.5] };
    }
    case 'sofa': {
      const f = of('pk_sofa'); if (!f.length) break;
      const b = f[Math.floor(r() * f.length)], sx = r() < 0.5 ? -1 : 1;
      return { kind, x: b[1] + sx * 0.5, y: 0.46, z: b[2], rot: b[3], stand: [b[1] + sx * 0.5, b[2] + 1.3] };
    }
  }
  const rn = run(), side = r() < 0.5 ? -1 : 1, lv = SHELF_LEVELS[Math.floor(r() * SHELF_LEVELS.length)];
  const z = q(rn[1] + 0.5 + r() * (rn[2] - rn[1] - 1));
  // The low fabric tables have no shelves to hide on: it sits on top of the bolts.
  if (rn[4] < 1.5) return { kind: 'top', x: rn[0] + side * 0.25, y: rn[4], z, rot: r() * 6.28, stand: [rn[0] + side * 1.5, z] };
  return { kind: 'shelf', x: rn[0] + side * 0.57, y: lv, z, rot: side > 0 ? Math.PI / 2 : -Math.PI / 2, stand: [rn[0] + side * 1.5, z] };
}

/** Where the day's finds sit: a pure function of the date and the layout. */
export function placeDay(day: string, L: Layout): Placed[] {
  const { ids } = dailyIds(day);
  let seed = 7; for (let i = 0; i < day.length; i++) seed = Math.imul(seed ^ day.charCodeAt(i), 2654435761) >>> 0;
  const r = dayRng(seed ^ 0xf1d5), out: Placed[] = [];
  for (const id of ids) {
    let spot = pickSpot(r, L);
    for (let tries = 0; tries < 40 && out.some((o) => Math.hypot(o.spot.x - spot.x, o.spot.z - spot.z) < MIN_APART); tries++) spot = pickSpot(r, L);
    out.push({ id, spot });
  }
  return out;
}

let sparkTex: THREE.CanvasTexture | null = null;
function sparkle(): THREE.CanvasTexture {
  if (sparkTex) return sparkTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,250,220,1)'); g.addColorStop(0.18, 'rgba(255,230,150,0.55)'); g.addColorStop(1, 'rgba(255,220,120,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  c.fillStyle = 'rgba(255,248,215,0.95)';
  c.beginPath(); c.moveTo(32, 2); c.lineTo(35, 29); c.lineTo(62, 32); c.lineTo(35, 35); c.lineTo(32, 62); c.lineTo(29, 35); c.lineTo(2, 32); c.lineTo(29, 29); c.closePath(); c.fill();
  sparkTex = new THREE.CanvasTexture(cv); sparkTex.colorSpace = THREE.SRGBColorSpace;
  return sparkTex;
}

interface Live { id: number; spot: Spot; mesh: THREE.Mesh; spark: THREE.Sprite; gone: boolean }

/** The store's finds, for tests and the menu (null until the store's interior has loaded). */
export let activeFinds: PardonsFinds | null = null;

export class PardonsFinds {
  /** In the store frame; a child of the stock group. */
  readonly group = new THREE.Group();
  /** The day's finds as placed (also the ones this player already has). */
  placed: Placed[] = [];
  private live: Live[] = [];
  private layout: Layout | null = null;
  private day = '';
  private dayT = 0;
  private mat: THREE.MeshBasicMaterial;
  private near = -1;
  private prompting = false;
  readonly stats = { filed: 0, shown: 0 };

  constructor(private game: Game) {
    this.group.name = 'pardons-finds'; activeFinds = this;
    this.mat = bakedLight(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }), 'obj');
  }

  /** The stock's fixture layout has loaded: put out today's finds. */
  setLayout(L: Layout): void { this.layout = L; this.refresh(); }

  /** The fixture layout the finds are placed against (for tests). */
  layoutForTest(): Layout | null { return this.layout; }

  /** Items still on the floor for this player. */
  get left(): number { return this.live.filter((l) => !l.gone).length; }
  get current(): readonly Live[] { return this.live; }

  /** Rebuild today's set (the day changed, the layout arrived, a test changed the date). */
  refresh(): void {
    if (!this.layout) return;
    this.day = findsDay();
    for (const l of this.live) { this.group.remove(l.mesh, l.spark); (l.spark.material as THREE.Material).dispose(); }
    this.live = []; this.near = -1;
    this.placed = placeDay(this.day, this.layout);
    for (const { id, spot } of this.placed) {
      if (hasFound(id)) continue;
      const mesh = new THREE.Mesh(findGeometry(id), this.mat);
      mesh.position.set(spot.x, spot.y + 0.012, spot.z); mesh.rotation.y = spot.rot; mesh.name = 'pardons-find-' + id;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkle(), color: 0xfff0c0, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
      spark.renderOrder = 5;
      const rad = findGeometry(id).boundingSphere!;
      spark.position.set(spot.x, spot.y + rad.center.y + 0.1, spot.z); spark.scale.setScalar(0.36); spark.visible = false; spark.name = 'pardons-spark';
      this.group.add(mesh, spark);
      this.live.push({ id, spot, mesh, spark, gone: false });
    }
    this.stats.shown = this.live.length;
  }

  private setPrompt(text: string | null): void {
    if (text !== null) { this.game.hud.prompt(text); this.prompting = true; }
    else if (this.prompting) { this.game.hud.prompt(null); this.prompting = false; }
  }

  /**
   * Each frame the stock is drawn: (px, pz) is the player in the store frame. Sparkle for finds within 7 m, the prompt and
   * the filing for the nearest within reach.
   */
  update(shown: boolean, inside: boolean, px: number, pz: number): void {
    const g = this.game, now = performance.now();
    if (now - this.dayT > 60000) { this.dayT = now; if (findsDay() !== this.day) this.refresh(); }
    if (!shown || !this.live.length) { this.setPrompt(null); return; }
    const t = now / 1000;
    let best = -1, bd = 1e9;
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      if (l.gone) continue;
      const d = Math.hypot(l.spot.x - px, l.spot.z - pz);
      const on = inside && d < 7;
      if (on) {
        l.spark.visible = true;
        (l.spark.material as THREE.SpriteMaterial).opacity = 0.8 * Math.min(1, (7 - d) / 3) * (0.55 + 0.45 * Math.sin(t * 3.1 + l.id));
        l.spark.scale.setScalar(0.3 + 0.06 * Math.sin(t * 4.3 + l.id * 2));
      } else if (l.spark.visible) l.spark.visible = false;
      if (d < bd) { bd = d; best = i; }
    }
    const can = inside && g.state === 'play' && !g.player.seated && best >= 0 && bd <= REACH;
    if (!can) { this.near = -1; this.setPrompt(null); return; }
    this.near = best;
    const f = FINDS[this.live[best].id];
    this.setPrompt(`[F] File it: ${f.name} ($${FIND_PRICE})`);
    if (g.input.hit('enter')) { g.input.eat('enter'); this.file(best); }
  }

  /** Pay the token price and catalogue the find. */
  file(i: number): boolean {
    const g = this.game, l = this.live[i];
    if (!l || l.gone) return false;
    const f = FINDS[l.id];
    if (g.player.money < FIND_PRICE) { g.hud.toast(`$${FIND_PRICE}, cash only. Pardon's does not do IOUs. Come back with the money.`, 4); return false; }
    g.player.money -= FIND_PRICE;
    const n = markFound(l.id);
    l.gone = true; l.mesh.visible = false; l.spark.visible = false;
    this.stats.filed++;
    this.near = -1; this.setPrompt(null);
    const tag = f.rarity === 'common' ? '' : `${RARITY_LABEL[f.rarity]}! `;
    g.hud.toast(`${tag}Filed: ${f.name}. ${f.line} ($${FIND_PRICE}. Pardon's, everything must go.) ${n} of ${FIND_COUNT} catalogued.`, f.rarity === 'ultra' ? 8 : 6);
    return true;
  }
}
