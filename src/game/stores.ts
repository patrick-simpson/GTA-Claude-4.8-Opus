// Fun queue 2, item 25: player-run shops. Rent one of a handful of vacant Tepid Falls storefronts, stock it with the
// Pardon's finds you have catalogued (world/pardonsCatalogue.ts), set prices, and townsfolk buy from you while you play.
//
// SITES: six real shop doors of the town's own footprint buildings (the ones no business of the directory took: world/shopSigns.ts
// letters them with spare names), picked once, near the middle of town and spread out. The blade of a rented door's board is
// repainted with the shop's name; a vacant one says TO LET and the rent. Walk to the door (on foot): [G] rents it, opens your
// shop's panel, or (online, someone else's shop) browses it.
//
// MONEY (kept modest on purpose, and not farmable): the only things for sale are the finds you have filed at Pardon's, each of
// which exists once per player (30 in all, worth about $4,500 together). A find sold is gone for good (a ledger bit marks it);
// nobody can buy one cheaper than its filing from Pardon's and sell it again, because there are no more to file. Shoppers pay
// at most 1.6x an item's worth and rarely above fair; the rent is taken every game day and the shop is closed (the lease ends)
// after two missed days. Sales happen only while you play (no offline accrual at all).
//
// SHOPPERS: not people on the street, only a rate: while the shop is open (8:00 to 20:00 on the town clock), a shopper comes
// by every minute or so, more on busy streets near Quorum Square, in the lunch and afternoon hours, and during a town event.
// Each looks at one item and buys it by how its price compares with its worth.
//
// ONLINE: your shop's name and shelves are broadcast (net/stores.ts, PlayerEvent.Store = 26, relayed unread); another player
// who walks up to your door while you are in town can buy from you, the money moving by a Buy/Sold/Deny exchange.
// Nothing is stored on a server: when you go offline your shop is shut to others, and it is saved only in your browser.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Blip } from '../ui/hud';
import { money } from '../core/util';
import { save, type ShopDoc } from './save';
import { places } from '../world/business';
import { mainlandLots, TOWN_NIGHT, type Door } from '../world/mainlandBuildings';
import { STREETS_NEW } from '../world/streets';
import { FINDS, FIND_COUNT, hasFound, foundMask, type Rarity } from '../world/pardonsCatalogue';
import { groundAt } from '../world/plan';
import type { EventId } from './eventCalendar';
import type { Markers } from './script';
import { StoreKind, STORE_MAX_NAME, STORE_MAX_STOCK, type StoreMsg } from '../net/protocol';

export interface Site { id: number; x: number; z: number; nx: number; nz: number; door: Door; foot: number; rent: number; street: string }
export interface Remote { owner: number; site: number; name: string; stock: { id: number; price: number }[]; at: number }
export interface StoreLink {
  me(): number;
  others(): number[];
  nameOf(id: number): string;
  posOf(id: number): { x: number; z: number } | null;
  send(m: Omit<StoreMsg, 'id'>): void;
}

/** What a find is worth to a shopper (the fair price), by rarity. */
export const VALUE: Record<Rarity, number> = { common: 25, uncommon: 80, rare: 220, ultra: 600 };
export const valueOf = (id: number): number => VALUE[FINDS[id].rarity];
/** No shopper pays more than this times the worth; and the chance to buy falls as the price climbs. */
export const MAX_TAKE = 1.6;
export const buyChance = (price: number, value: number): number => {
  const r = price / Math.max(1, value);
  return r >= MAX_TAKE ? 0 : Math.max(0, Math.min(0.95, 1.35 - 0.8 * r));
};

/** How many storefronts, and when the shop trades (town hours). */
const SITE_COUNT = 6, OPEN_H = 8, CLOSE_H = 20, MISSED_MAX = 2;
const SQUARE = { x: 131, z: -1808 };
/** Seconds between shoppers at footfall 1, a game day's rent hours, how far from the door counts as there. */
const SHOPPER_S = 55, REACH = 4.5, BROWSE = 8;
export const NAME_MIN = 3;

// ── Names ────────────────────────────────────────────────────────────────────

/** Long unambiguous fragments, matched in the squashed name. */
const BAD_FRAG = ['fuck', 'shit', 'bitch', 'cunt', 'pussy', 'nigg', 'fagg', 'retard', 'whore', 'slut', 'rape', 'nazi', 'hitler', 'porn', 'penis', 'vagina', 'bastard', 'asshole', 'dildo', 'cumshot', 'kkk', 'jihad'];
/** Short words, matched as whole words only. */
const BAD_WORD = ['ass', 'cock', 'dick', 'sex', 'tit', 'tits', 'anal', 'xxx', 'cum', 'fag', 'damn', 'crap', 'piss', 'booty'];
/** Real brands and chains: no shop may read as one (squashed, matched anywhere). */
const BRANDS = ['walmart', 'mcdonald', 'starbucks', 'dunkin', 'costco', 'amazon', 'google', 'nike', 'adidas', 'pepsi', 'cocacola', 'kfc', 'burgerking', 'wendys', 'homedepot', 'lowes', 'walgreens', 'cvs', 'ikea', 'ebay', 'disney', 'microsoft', 'tesla', 'toyota', 'chevrolet', 'samsung', 'nintendo', 'spotify', 'netflix', 'fedex', 'bestbuy', 'gamestop', '7eleven', 'sheetz', 'wawa', 'hannaford', 'llbean', 'applebees', 'chipotle', 'taco bell', 'tacobell', 'pizzahut', 'dominos', 'subway', 'apple', 'target', 'sears', 'macys', 'kmart', 'petco', 'staples', 'walmart', 'facebook', 'tiktok', 'instagram', 'youtube', 'playstation', 'xbox', 'lego', 'rolex', 'gucci', 'prada', 'chanel', 'ferrari', 'porsche', 'hyundai', 'volkswagen', 'harley', 'moxie'];
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** Why a name is refused, or '' if it will do. */
export function nameProblem(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN) return `Give the shop a name of at least ${NAME_MIN} letters.`;
  if (name.length > STORE_MAX_NAME) return `Keep it to ${STORE_MAX_NAME} characters.`;
  if (/[^A-Za-z0-9 &'.,!-]/.test(name)) return 'Letters, numbers and & \' . , ! - only.';
  if (!/[A-Za-z]{2}/.test(name)) return 'A name needs some letters in it.';
  const spaced = name.toLowerCase().replace(/[0-9@$!]/g, (c) => LEET[c] ?? c).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ');
  const squash = spaced.replace(/ /g, '');
  for (const w of spaced.split(' ')) if (BAD_WORD.includes(w)) return 'That name will not go over the door in this town.';
  for (const f of BAD_FRAG) if (squash.includes(f)) return 'That name will not go over the door in this town.';
  // A brand of five letters or fewer is only caught as a word of its own ("Lego", not "Passable Goods"); longer ones anywhere in the name,
  // and by their consonants (so "Starbocks" is no way round "Starbucks").
  const skel = (s: string): string => s.replace(/[aeiouy]/g, '');
  const words = spaced.split(' '), sq = skel(squash);
  for (const b0 of BRANDS) {
    const b = b0.replace(/ /g, '');
    if (b.length <= 5 ? words.includes(b) : squash.includes(b) || (skel(b).length >= 5 && sq.includes(skel(b)))) return 'That reads like a real brand. Pick something of your own.';
  }
  return '';
}
/** A name cleaned for the sign, or the default if it will not do (what arrives over the wire is passed through this). */
export function cleanName(raw: string, dflt = 'A Shop'): string {
  const n = raw.replace(/[^ -~]/g, '').replace(/\s+/g, ' ').trim().slice(0, STORE_MAX_NAME);
  return nameProblem(n) === '' ? n : dflt;
}
const NAME_IDEAS = ['Odds & Ends', 'Loose Change Goods', 'The Fine Print', 'Second Wind Treasures', 'Bits & Bobs', 'Half Price Never', 'Found Things', 'The Back Room'];

export class Stores {
  link: StoreLink | null = null;
  /** True only in the new Tepid Falls (?streets=old has none of these doors). */
  readonly on = STREETS_NEW;
  readonly stats = { rented: 0, sold: 0, shoppers: 0, rentPaid: 0, evicted: 0, boughtOnline: 0, soldOnline: 0, sent: 0, got: 0 };
  readonly remote = new Map<number, Remote>();
  /** Opened by the player at this site (the panel reads it), and why. */
  panelSite = -1;
  /** For the UI: bumped on every change so the panel redraws. */
  rev = 0;
  prompt: string | null = null;
  /** Set by the panel while it has the screen. */
  panelOpen = false;
  open: ((site: number) => void) | null = null;

  private sites: Site[] | null = null;
  private mesh: THREE.Mesh | null = null;
  private cv: HTMLCanvasElement | null = null;
  private tex: THREE.CanvasTexture | null = null;
  private dirty = true;
  private arrive = 0;
  private told = 0;
  private sendAt = 0;
  private sendDirty = true;
  private pending: { owner: number; item: number; price: number; at: number } | null = null;
  private lastSite = -2;

  constructor(private readonly game: Game, private readonly markers: Markers) {
    void this.markers;
  }

  // ── The sites ──────────────────────────────────────────────────────────────

  /** The storefronts, built once the town is. Empty off the new streets. */
  list(): Site[] {
    if (this.sites) return this.sites;
    const out: Site[] = [];
    this.sites = out;
    if (!this.on) return out;
    const g = this.game, taken = new Set<Door>();
    for (const p of places(g.plan)) if (p.placed && p.fascia) taken.add(p.fascia);
    const cand: { d: Door; dist: number }[] = [];
    for (const l of mainlandLots(g.plan)) for (const d of l.doors ?? []) {
      if (taken.has(d) || d.opt || d.sw < 1.6 || d.sh < 0.3) continue;
      const x = d.x + d.nx * 2.5, z = d.z + d.nz * 2.5;
      if (g.plan.streetAt(x, z) === '') continue;
      cand.push({ d, dist: Math.hypot(x - SQUARE.x, z - SQUARE.z) });
    }
    cand.sort((a, b) => a.dist - b.dist || a.d.x - b.d.x || a.d.z - b.d.z);
    // The first few from the middle of town outward, each well apart from the others, and on different streets.
    const picked: { d: Door; dist: number }[] = [];
    const streets = new Set<string>();
    for (const c of cand) {
      if (c.dist > 700 || picked.length >= SITE_COUNT) break;
      const x = c.d.x + c.d.nx * 2.5, z = c.d.z + c.d.nz * 2.5, st = g.plan.streetAt(x, z);
      if (streets.has(st) && picked.length < SITE_COUNT - 1 && cand.length > 40) continue;
      if (picked.some((q) => Math.hypot(q.d.x - c.d.x, q.d.z - c.d.z) < 75)) continue;
      picked.push(c); streets.add(st);
    }
    // Fewer than six far apart: fill from what is left.
    for (const c of cand) {
      if (picked.length >= SITE_COUNT) break;
      if (!picked.includes(c) && !picked.some((q) => Math.hypot(q.d.x - c.d.x, q.d.z - c.d.z) < 30)) picked.push(c);
    }
    picked.forEach((c, i) => {
      const x = c.d.x + c.d.nx * 2.5, z = c.d.z + c.d.nz * 2.5;
      const foot = Math.max(0.65, Math.min(1.6, 1.65 - c.dist / 450));
      out.push({ id: i, x, z, nx: c.d.nx, nz: c.d.nz, door: c.d, foot, rent: Math.round((40 + 45 * foot) / 5) * 5, street: g.plan.streetAt(x, z) });
    });
    return out;
  }

  site(id: number): Site | null { return this.list()[id] ?? null; }
  /** The shop owner of a site: 'me', a remote id, or 0 (vacant). */
  tenant(id: number): number {
    const s = save.data.shop;
    if (s && s.site === id) return -1;
    for (const r of this.remote.values()) if (r.site === id) return r.owner;
    return 0;
  }
  get mine(): ShopDoc | null { return save.data.shop; }

  // ── The player's collection ────────────────────────────────────────────────

  private soldMask(): number { return save.data.best['sh.sold'] ?? 0; }
  /** A find the player has filed, still has (not sold, not on a shelf). */
  owns(id: number): boolean {
    if (!hasFound(id) || (this.soldMask() & (1 << id))) return false;
    const s = save.data.shop;
    return !(s && s.stock.some((e) => e.id === id));
  }
  /** Finds that could go on the shelves. */
  inventory(): number[] { const out: number[] = []; for (let i = 0; i < FIND_COUNT; i++) if (this.owns(i)) out.push(i); return out; }

  // ── What the player does ───────────────────────────────────────────────────

  private toast(s: string, secs = 5): void { this.game.hud.toast(s, secs); }
  private changed(): void { this.rev++; this.sendDirty = true; this.dirty = true; save.write(); }

  /** Rent a vacant storefront. Returns '' or why not. */
  rentSite(id: number, name: string): string {
    const s = this.site(id), g = this.game;
    if (!s) return 'No such storefront.';
    if (save.data.shop) return 'You already run a shop.';
    if (this.tenant(id) !== 0) return 'Somebody has that storefront.';
    const bad = nameProblem(name);
    if (bad) return bad;
    if (g.player.money < s.rent) return `The first day's rent is ${money(s.rent)}, up front.`;
    g.player.money -= s.rent;
    save.data.shop = { site: id, name: name.replace(/\s+/g, ' ').trim(), stock: [], till: 0, owed: 0, acc: 0, sales: 0, earned: 0 };
    this.stats.rented++;
    this.changed();
    this.toast(`${save.data.shop.name} is open at ${s.street}. Rent ${money(s.rent)} a day, taken from the till or your pocket. Stock it from your finds.`, 7);
    return '';
  }

  rename(name: string): string {
    const sh = save.data.shop;
    if (!sh) return 'No shop.';
    const bad = nameProblem(name);
    if (bad) return bad;
    sh.name = name.replace(/\s+/g, ' ').trim();
    this.changed();
    return '';
  }

  stock(id: number, price?: number): string {
    const sh = save.data.shop;
    if (!sh) return 'No shop.';
    if (!this.owns(id)) return 'You do not have that one.';
    if (sh.stock.length >= STORE_MAX_STOCK) return `The shelves hold ${STORE_MAX_STOCK}.`;
    sh.stock.push({ id, price: Math.round(price ?? valueOf(id)) });
    this.changed();
    return '';
  }
  unstock(id: number): void {
    const sh = save.data.shop;
    if (!sh) return;
    const i = sh.stock.findIndex((e) => e.id === id);
    if (i >= 0) { sh.stock.splice(i, 1); this.changed(); }
  }
  setPrice(id: number, price: number): void {
    const e = save.data.shop?.stock.find((q) => q.id === id);
    if (!e || !Number.isFinite(price)) return;
    e.price = Math.max(1, Math.min(9999, Math.round(price)));
    this.changed();
  }
  /** Take the till into your pocket. Returns the amount. */
  collect(): number {
    const sh = save.data.shop;
    if (!sh || sh.till <= 0) return 0;
    const n = sh.till;
    sh.till = 0;
    this.game.player.money += n;
    save.credit(n);
    this.changed();
    return n;
  }
  /** Pay missed rent from your pocket. */
  payOwed(): string {
    const sh = save.data.shop;
    if (!sh || sh.owed <= 0) return '';
    const n = Math.min(sh.owed, Math.floor(this.game.player.money));
    if (n <= 0) return 'No cash on you.';
    this.game.player.money -= n; sh.owed -= n; this.stats.rentPaid += n;
    this.changed();
    return '';
  }
  /** Give the storefront up: the till comes to you, the stock stays yours. */
  giveUp(why = ''): void {
    const sh = save.data.shop;
    if (!sh) return;
    const n = Math.max(0, sh.till - sh.owed);
    this.game.player.money += n;
    save.credit(n);
    save.data.shop = null;
    this.sendClose();
    this.changed();
    this.toast(why || `The lease is up. ${n > 0 ? money(n) + ' from the till comes home with you. ' : ''}Your finds are back in your collection.`, 6);
  }

  /** Game hours until the next rent day ends, for the panel. */
  hoursToRent(): number { const sh = save.data.shop; return sh ? Math.max(0, 24 - sh.acc) : 0; }
  rentOf(): number { const sh = save.data.shop; return sh ? (this.site(sh.site)?.rent ?? 0) : 0; }

  // ── Trading ────────────────────────────────────────────────────────────────

  private footfall(site: Site): number {
    let f = site.foot;
    const ev = this.game.todo.events;
    if ((['derby', 'moose', 'regatta', 'fair'] as EventId[]).some((e) => ev.on(e))) f *= 1.5;
    const h = this.game.sky.hour;
    // Lunch and the afternoon are busiest; the first and last hour are quiet.
    const shape = h < OPEN_H || h >= CLOSE_H ? 0 : h < 9 || h >= 19 ? 0.5 : h >= 11.5 && h < 17.5 ? 1.25 : 0.9;
    return f * shape;
  }
  /** Shoppers a game hour at the shop right now, for the panel (and the tests). */
  footfallNow(): number { const sh = save.data.shop, s = sh ? this.site(sh.site) : null; return s ? this.footfall(s) : 0; }

  private sellTo(npc: boolean): boolean {
    const sh = save.data.shop;
    if (!sh || !sh.stock.length) return false;
    const e = sh.stock[Math.floor(Math.random() * sh.stock.length)];
    if (npc && Math.random() >= buyChance(e.price, valueOf(e.id))) return false;
    this.complete(e.id, e.price);
    return true;
  }
  /** Book a sale of a listed item: it leaves the shelf for good, the money goes in the till. */
  private complete(id: number, price: number): void {
    const sh = save.data.shop;
    if (!sh) return;
    const i = sh.stock.findIndex((q) => q.id === id);
    if (i < 0) return;
    sh.stock.splice(i, 1);
    save.data.best['sh.sold'] = this.soldMask() | (1 << id);
    sh.till += price; sh.earned += price; sh.sales++;
    save.data.best['sh.earn'] = (save.data.best['sh.earn'] ?? 0) + price;
    this.stats.sold++;
    this.changed();
  }

  /** The rent day turns over: pay from the till, then the pocket; two missed days and the lease goes. */
  private rentDay(): void {
    const sh = save.data.shop, g = this.game;
    if (!sh) return;
    const rent = this.rentOf() + sh.owed;
    let due = rent;
    const fromTill = Math.min(sh.till, due); sh.till -= fromTill; due -= fromTill;
    const fromPocket = Math.min(Math.floor(g.player.money), due); g.player.money -= fromPocket; due -= fromPocket;
    this.stats.rentPaid += rent - due;
    sh.owed = due;
    if (due > 0 && due >= this.rentOf() * MISSED_MAX) { this.stats.evicted++; this.giveUp(`${sh.name} is shut: ${MISSED_MAX} days of rent missed. The landlord changed the lock. Your finds are back in your collection.`); return; }
    this.toast(due > 0 ? `${sh.name}: rent due, ${money(due)} still owing. Sell something or open your wallet.` : `${sh.name}: day's rent ${money(rent)} paid. ${sh.sales} sold so far.`, 5);
    this.changed();
  }

  // ── Online ─────────────────────────────────────────────────────────────────

  private online(): boolean { return !!this.link && this.link.me() > 0; }
  private wire(kind: number, extra: Partial<StoreMsg> = {}): void {
    if (!this.link || !this.link.me()) return;
    const sh = save.data.shop;
    this.link.send({ kind, owner: this.link.me(), buyer: 0, site: sh?.site ?? 0, reason: 0, item: 0, price: 0, name: sh?.name ?? '', stock: [], ...extra });
    this.stats.sent++;
  }
  private sendOpen(): void {
    const sh = save.data.shop;
    if (!sh || !this.link || !this.link.me() || !this.link.others().length) return;
    this.sendAt = performance.now(); this.sendDirty = false;
    this.wire(StoreKind.Open, { stock: sh.stock.map((e) => ({ item: e.id, price: e.price })) });
  }
  private sendClose(): void { if (this.online() && this.link!.others().length) this.wire(StoreKind.Close, {}); }
  /** Somebody new came to town: say it again so they see the shop. */
  announce(): void { this.sendDirty = true; }
  dropped(id: number): void { if (this.remote.delete(id)) this.changed2(); }
  offline(): void { if (this.remote.size) { this.remote.clear(); this.changed2(); } this.pending = null; }
  private changed2(): void { this.rev++; this.dirty = true; }

  /** A frame from another player (net/stores.ts has checked who sent it). */
  got(from: number, m: StoreMsg): void {
    this.stats.got++;
    const me = this.link?.me() ?? 0;
    if (m.kind === StoreKind.Open) {
      if (m.site >= SITE_COUNT || m.owner !== from) return;
      const stock: { id: number; price: number }[] = [];
      for (const e of m.stock) if (e.item < FIND_COUNT && e.price >= 1 && !stock.some((q) => q.id === e.item)) stock.push({ id: e.item, price: e.price });
      const had = this.remote.get(from);
      this.remote.set(from, { owner: from, site: m.site, name: cleanName(m.name), stock, at: performance.now() });
      // Two players took one storefront: the lower id keeps it.
      if (save.data.shop && save.data.shop.site === m.site && from < me) { this.giveUp(`${cleanName(m.name)} got that storefront first. Your lease is cancelled and your till refunded.`); }
      if (!had || had.name !== cleanName(m.name) || had.stock.length !== stock.length || had.site !== m.site) this.changed2();
      else this.rev++;
      return;
    }
    if (m.kind === StoreKind.Close) { if (this.remote.delete(from)) this.changed2(); return; }
    if (m.kind === StoreKind.Buy && m.owner === me && save.data.shop) {
      const sh = save.data.shop, e = sh.stock.find((q) => q.id === m.item), s = this.site(sh.site), at = this.link?.posOf(from);
      const deny = (reason: number): void => this.wire(StoreKind.Deny, { buyer: from, item: m.item, price: m.price, reason });
      if (!e) { deny(1); return; }
      if (e.price !== m.price) { deny(2); return; }
      if (!s || !at || Math.hypot(at.x - s.x, at.z - s.z) > BROWSE + 14) { deny(3); return; }
      this.complete(e.id, e.price);
      this.stats.soldOnline++;
      this.wire(StoreKind.Sold, { buyer: from, item: m.item, price: m.price });
      this.toast(`${this.link?.nameOf(from) ?? 'A customer'} bought ${FINDS[m.item].name} for ${money(m.price)}.`, 5);
      return;
    }
    if ((m.kind === StoreKind.Sold || m.kind === StoreKind.Deny) && m.buyer === me && this.pending && this.pending.owner === from && this.pending.item === m.item) {
      const p = this.pending;
      this.pending = null;
      if (m.kind === StoreKind.Sold) {
        save.data.best['pf.found'] = foundMask() | (1 << p.item);
        save.data.best['sh.sold'] = this.soldMask() & ~(1 << p.item);
        this.stats.boughtOnline++;
        this.changed();
        this.toast(`Bought ${FINDS[p.item].name} for ${money(p.price)}. It is in your collection now.`, 6);
      } else {
        this.game.player.money += p.price;
        this.toast(['The shop turned you away.', 'Somebody beat you to it.', 'The price changed. Look again.', 'Too far from the counter.', 'The shop is closed.'][Math.min(4, Math.max(0, m.reason))], 4);
        this.rev++;
      }
    }
  }

  /** Buy a listed item from another player's shop. Returns '' or why not. */
  buyRemote(owner: number, item: number): string {
    const r = this.remote.get(owner), g = this.game;
    if (!r || !this.online()) return 'That shop is closed.';
    const e = r.stock.find((q) => q.id === item);
    if (!e) return 'It is gone.';
    if (this.pending) return 'One moment, the last sale is still on the counter.';
    if (hasFound(item) && !(this.soldMask() & (1 << item))) return 'You already have that one in your collection.';
    if (g.player.money < e.price) return `That is ${money(e.price)}.`;
    g.player.money -= e.price;
    this.pending = { owner, item, price: e.price, at: performance.now() };
    this.link!.send({ kind: StoreKind.Buy, owner, buyer: this.link!.me(), site: r.site, reason: 0, item, price: e.price, name: '', stock: [] });
    this.stats.sent++;
    this.rev++;
    return '';
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  /** Radar badges: the storefronts within 220 m, S for to let (or yours). */
  blips(out: Blip[]): void {
    if (!this.on) return;
    const p = this.game.player;
    for (const s of this.list()) if (Math.hypot(p.x - s.x, p.z - s.z) < 220) out.push({ x: s.x, z: s.z, kind: 'job', label: 'S' });
  }

  update(dt: number): void {
    const g = this.game, p = g.player, now = performance.now();
    this.prompt = null;
    if (!this.on) return;
    const sites = this.list();
    if (!sites.length) return;
    if (this.dirty) this.paint();
    this.told -= dt;

    // Remote shops go quiet after 14 s without a word.
    for (const [id, r] of this.remote) if (now - r.at > 14000) { this.remote.delete(id); this.changed2(); }
    if (this.pending && now - this.pending.at > 6000) { g.player.money += this.pending.price; this.pending = null; this.toast('The shop did not answer. Your money is back.', 4); this.rev++; }

    const sh = save.data.shop;
    if (g.state === 'play') {
      if (sh) {
        const s = this.site(sh.site);
        // The day's rent turns over by game time at the shop.
        const rate = g.sky.rate > 0 ? g.sky.rate : 1 / 60;
        sh.acc += rate * dt;
        if (sh.acc >= 24) { sh.acc -= 24; this.rentDay(); }
        if (s && save.data.shop) {
          const f = this.footfall(s);
          if (f > 0 && save.data.shop.stock.length) {
            this.arrive += dt * f / SHOPPER_S;
            while (this.arrive >= 1) {
              this.arrive -= 1; this.stats.shoppers++;
              const was = save.data.shop?.stock.length ?? 0;
              if (this.sellTo(true) && was && this.told <= 0) { this.told = 6; this.toast(`${save.data.shop?.name ?? 'Your shop'}: a sale. Till ${money(save.data.shop?.till ?? 0)}.`, 3.5); }
            }
          }
        }
        if (this.sendDirty || now - this.sendAt > 5000) this.sendOpen();
      }
    }

    // The nearest door, on foot.
    this.lastSite = -2;
    if (g.state !== 'play' || p.seated || this.panelOpen) return;
    let best = -1, bd = 1e9;
    for (const s of sites) { const d = Math.hypot(p.x - s.x, p.z - s.z); if (d < bd) { bd = d; best = s.id; } }
    if (best < 0 || bd > REACH) return;
    this.lastSite = best;
    const s = sites[best], who = this.tenant(best);
    if (who === -1) this.prompt = `[G] Open your shop: ${save.data.shop?.name}`;
    else if (who > 0) {
      const r = this.remote.get(who);
      this.prompt = r ? `[G] Browse ${r.name} (${r.stock.length} for sale)` : null;
    } else if (save.data.shop) this.prompt = `To let on ${s.street}: ${money(s.rent)} a day. (You already run a shop.)`;
    else this.prompt = `[G] Rent this storefront on ${s.street}: ${money(s.rent)} a day`;
    if (this.prompt && g.input.eat('interact') && this.open) this.open(best);
  }

  // ── The signs ──────────────────────────────────────────────────────────────

  private cellText(i: number): { name: string; rent: number; mine: boolean; vacant: boolean } {
    const t = this.tenant(i), s = this.site(i) as Site;
    if (t === -1) return { name: save.data.shop?.name ?? '', rent: s.rent, mine: true, vacant: false };
    if (t > 0) return { name: this.remote.get(t)?.name ?? 'A Shop', rent: s.rent, mine: false, vacant: false };
    return { name: 'TO LET', rent: s.rent, mine: false, vacant: true };
  }

  /** Build the board mesh the first time, and redraw its canvas when a name or a tenant changes. */
  private paint(): void {
    this.dirty = false;
    const sites = this.list(), g = this.game, CW = 256, CH = 64, SC = g.quality.lean ? 0.5 : 1;
    if (!this.cv) {
      const cv = this.cv = document.createElement('canvas');
      cv.width = CW * SC; cv.height = CH * SC * sites.length;
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      sites.forEach((s, i) => {
        const d = s.door, tx = d.nz, tz = -d.nx, b = pos.length / 3, o = 0.05, w = d.sw, h = d.sh;
        const cx = d.sx + d.nx * o, cz = d.sz + d.nz * o, v0 = 1 - (i + 1) / sites.length, v1 = 1 - i / sites.length;
        pos.push(cx - tx * w / 2, d.sy, cz - tz * w / 2, cx + tx * w / 2, d.sy, cz + tz * w / 2, cx + tx * w / 2, d.sy + h, cz + tz * w / 2, cx - tx * w / 2, d.sy + h, cz - tz * w / 2);
        uv.push(0, v0, 1, v0, 1, v1, 0, v1);
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const tex = this.tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
      const m = this.mesh = new THREE.Mesh(geo, mat);
      m.name = 'store-signs'; m.matrixAutoUpdate = false;
      m.onBeforeRender = () => { const k = 1 - 0.3 * TOWN_NIGHT.value; if (mat.color.r !== k) mat.color.setRGB(k, k, k); };
      g.scene.add(m);
      void document.fonts?.ready.then(() => { this.dirty = true; });
    }
    const c = this.cv.getContext('2d') as CanvasRenderingContext2D;
    c.setTransform(SC, 0, 0, SC, 0, 0);
    sites.forEach((_s, i) => {
      const t = this.cellText(i), oy = i * CH;
      const bg = t.vacant ? '#f4f2ea' : t.mine ? '#1d2f4f' : '#22392d', fg = t.vacant ? '#a3211c' : '#f3efe0', rule = t.vacant ? '#a3211c' : '#e8c770';
      c.fillStyle = bg; c.fillRect(0, oy, CW, CH);
      c.strokeStyle = rule; c.lineWidth = 2; c.strokeRect(5, oy + 5, CW - 10, CH - 10);
      c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
      const font = (px: number): string => `700 ${px}px "Barlow Semi Condensed", "Arial Narrow", sans-serif`;
      if (t.vacant) {
        c.font = font(30); c.fillText('TO LET', CW / 2, oy + 24);
        c.font = font(20); c.fillText(`${money(t.rent)} A DAY  ·  RENT IT`, CW / 2, oy + 47);
        return;
      }
      const text = t.name.toUpperCase(), maxW = CW - 28;
      let px = 34;
      for (; px >= 14; px--) { c.font = font(px); if (c.measureText(text).width <= maxW) break; }
      c.fillText(text, CW / 2, oy + CH / 2 + 1);
    });
    if (this.tex) this.tex.needsUpdate = true;
  }

  /** Default name ideas for the rent form. */
  idea(): string { return NAME_IDEAS[Math.floor(Math.random() * NAME_IDEAS.length)]; }
  groundHere(s: Site): number { return groundAt(s.x, s.z); }

  /** For tests and the panel. */
  info(): Record<string, unknown> {
    const sh = save.data.shop;
    return {
      on: this.on, sites: this.sites ? this.sites.map((s) => ({ id: s.id, x: +s.x.toFixed(1), z: +s.z.toFixed(1), rent: s.rent, foot: +s.foot.toFixed(2), street: s.street })) : [],
      shop: sh ? { ...sh, stock: sh.stock.slice() } : null, remote: [...this.remote.values()].map((r) => ({ owner: r.owner, site: r.site, name: r.name, n: r.stock.length })),
      stats: { ...this.stats }, pending: !!this.pending, prompt: this.prompt, nearSite: this.lastSite, inventory: this.on ? this.inventory().length : 0, sold: this.soldMask(), footfall: +this.footfallNow().toFixed(2),
    };
  }
}
