// Fun queue 2, item 48: the daily Town Notice. Each real day in Maine (noticeData.maineDay: the same for every player,
// nothing sent) the town posts three quick challenges from a pool of 32 (noticeData.ts), picked among the ones that are
// possible right now: no snow work without snow, no ferry without a ferry, a photo subject only when it is on today's photo
// list. Progress counts from numbers that only go up (the save's stats, its counts, and this file's own counters kept in
// the best table as nt.k.*, fed by the 'moment' events of core/api.ts, which the DJ and the crowd read too and which both
// ignore kinds they have no lines for). All three done pays a purse: $300, +$50 for every consecutive day of the streak
// after the first, up to day 7 ($600). Saved in the best table: nt.day, nt.a/b/c (the pool index + 1 of today's three),
// nt.ba/bb/bc (the source when each was posted), nt.m (done bits), nt.paid, nt.streak, nt.last, nt.total, nt.fm (the
// townsfolk said hello to today). The card is the Places panel's Notice chip; a pinned notice board stands at Quorum Square
// in Tepid Falls and by Mercy Park's lawn on the island (drawn only when its numbers change); a toast says when one is done.
// Local only: no protocol bump, no server change, no new fact key.

import * as THREE from 'three';
import type { Game } from '../core/game';
import { groundAt } from '../world/plan';
import { STREETS_NEW } from '../world/streets';
import { money } from '../core/util';
import { save } from './save';
import { POOL, maineDay, pickThree, rewardFor, secondsLeft, REWARD, type Challenge } from './noticeData';

export interface NoticeRow { id: string; text: string; have: number; goal: number; done: boolean; level: string; label: string }

/** Where the boards stand: x, z and the way the face looks (yaw). Quorum Square's, and one on the island. */
export const BOARDS: readonly { x: number; z: number; yaw: number; name: string }[] = [
  { x: 148, z: -1797, yaw: 0, name: 'Quorum Square' },
  { x: 200, z: -17, yaw: 0, name: 'Mercy Park' },
];

const popcount = (n: number): number => { let c = 0; n = n | 0; while (n) { c += n & 1; n >>>= 1; } return c; };
const dayLabel = (day: number): string => new Date(day * 86400000).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

export class Notice {
  /** For tests: pretend it is this Maine day. */
  dayOverride: number | null = null;
  readonly stats = { done: 0, paid: 0, redraws: 0 };
  private t = 0;
  private lastBooked = -1e9; private escapeAt = 0; private heatWas = 0;
  private fast = false;
  private readonly last: Record<string, number> = {};
  private board: THREE.Group[] = [];
  private cv!: HTMLCanvasElement; private tex!: THREE.CanvasTexture;
  private boardKey = '';
  private built = false;

  constructor(private readonly game: Game) {
    const g = game;
    g.on('moment', (e) => this.moment(e.kind, e.n, e.id));
    g.on('booked', () => { this.lastBooked = performance.now(); });
    g.on('heat', (e) => {
      if (e.level === 0 && this.heatWas > 0) this.escapeAt = performance.now() + 1500;
      this.heatWas = e.level;
    });
  }

  get day(): number { return this.dayOverride ?? maineDay(Date.now()); }
  private get best(): Record<string, number> { return save.data.best; }

  // ── What counts ──

  private bump(key: string, n = 1): void { this.best['nt.k.' + key] = (this.best['nt.k.' + key] ?? 0) + n; }

  private moment(kind: string, n?: number, id?: string): void {
    switch (kind) {
      case 'catch': this.bump('catch'); if ((n ?? 0) >= 48) this.bump('fish3'); break;
      case 'air': if ((n ?? 0) >= 30) this.bump('jump30'); break;
      case 'shot': if (id) this.bump('shot.' + id); break;
      case 'book': this.bump('book'); break;
      case 'meal': if (id === 'pie') this.bump('pie'); break;
      case 'plow': this.bump('plow'); break;
      case 'folk': if (n !== undefined && n >= 0 && n < 30) this.best['nt.fm'] = ((this.best['nt.fm'] ?? 0) | (1 << n)); break;
      default: break;
    }
  }

  /** The number a challenge reads (it only goes up). */
  private read(src: string): number {
    const i = src.indexOf(':'), kind = i < 0 ? src : src.slice(0, i), key = i < 0 ? '' : src.slice(i + 1);
    if (kind === 'stat') return ((save.data.stats as unknown as Record<string, number>)[key] ?? 0);
    if (kind === 'cnt') return save.count(key);
    if (kind === 'k') return Math.floor(this.best['nt.k.' + key] ?? 0);
    if (kind === 'folk') return popcount(this.best['nt.fm'] ?? 0);
    return 0;
  }

  /** Is it possible right now? */
  private possible(c: Challenge): boolean {
    const g = this.game, need = c.need;
    if (!need) return true;
    const snow = g.sky.snowCover >= 0.2;
    switch (need) {
      case 'fish': return true;
      case 'finds': return g.todo.finds.on && save.count('fd.found') + c.goal <= 50;
      case 'ferry': return g.ferry.ferries.length > 0;
      case 'bus': return g.bus.on;
      case 'rail': return g.rail.on;
      case 'diner': return g.todo.nightlife.on;
      case 'library': return g.todo.civic.on;
      case 'folk': return g.todo.townsfolk.on;
      case 'snow': return snow;
      case 'snowfield': return snow && STREETS_NEW;
      default:
        if (need.startsWith('shot:')) return !!g.photo && g.photo.shots.today().includes(need.slice(5));
        return true;
    }
  }

  // ── The day ──

  private keys = ['a', 'b', 'c'] as const;

  /** Today's three (pool indices), posting a new day when the date has moved on. */
  private ensure(): void {
    const b = this.best, day = this.day;
    if (b['nt.day'] === day && b['nt.a'] && b['nt.b'] && b['nt.c']) return;
    b['nt.fm'] = 0;
    const ok = POOL.filter((c) => this.possible(c)).map((c) => c.id);
    const ids = pickThree(day, ok);
    for (let i = 0; i < 3; i++) {
      const c = POOL.find((q) => q.id === ids[i]);
      const k = this.keys[i];
      b['nt.' + k] = c ? POOL.indexOf(c) + 1 : 0;
      b['nt.b' + k] = c ? this.read(c.src) : 0;
    }
    b['nt.day'] = day; b['nt.m'] = 0;
    this.boardKey = '';
  }

  private slot(i: number): Challenge | null {
    const n = this.best['nt.' + this.keys[i]] ?? 0;
    return n > 0 ? POOL[n - 1] ?? null : null;
  }

  rows(): NoticeRow[] {
    this.ensure();
    const out: NoticeRow[] = [], m = this.best['nt.m'] ?? 0;
    for (let i = 0; i < 3; i++) {
      const c = this.slot(i);
      if (!c) continue;
      const done = (m & (1 << i)) !== 0;
      const have = done ? c.goal : Math.min(c.goal, Math.max(0, this.read(c.src) - (this.best['nt.b' + this.keys[i]] ?? 0)));
      const show = (n: number): string => c.unit === 'm' ? (n / 1000).toFixed(1) + ' of ' + (c.goal / 1000) + ' km' : c.unit === '$' ? '$' + n + ' of $' + c.goal : n + ' of ' + c.goal;
      out.push({ id: c.id, text: c.text, have, goal: c.goal, done, level: c.level, label: done ? 'done' : show(have) });
    }
    return out;
  }

  /** The streak that is alive: the last day all three were done was today or yesterday. */
  streak(): number {
    const b = this.best, last = b['nt.last'] ?? 0;
    return last >= this.day - 1 && last > 0 ? (b['nt.streak'] ?? 0) : 0;
  }
  doneToday(): boolean { return (this.best['nt.m'] ?? 0) === 7; }
  /** What tomorrow's purse would be, and today's. */
  purse(): number { const s = this.streak(), last = this.best['nt.last'] ?? 0; return rewardFor(last === this.day ? s : s + 1); }
  /** Real seconds left of today's notice. */
  left(): number { return this.dayOverride !== null ? 86400 : secondsLeft(Date.now()); }
  dateText(): string { return dayLabel(this.day); }

  /** Check what is done, pay when all three are. Called twice a second. */
  private check(): void {
    const g = this.game, b = this.best;
    this.ensure();
    let m = b['nt.m'] ?? 0;
    for (let i = 0; i < 3; i++) {
      const c = this.slot(i);
      if (!c || (m & (1 << i))) continue;
      if (this.read(c.src) - (b['nt.b' + this.keys[i]] ?? 0) < c.goal) continue;
      m |= 1 << i; b['nt.m'] = m; this.stats.done++;
      const n = popcount(m);
      g.hud.toast(`Town Notice: ${c.text}. Done, ${n} of 3${n === 3 ? '' : '.'}`, 5);
      this.boardKey = '';
      g.todo.saveNow();
    }
    if (m === 7 && b['nt.paid'] !== this.day) this.pay();
  }

  private pay(): void {
    const g = this.game, b = this.best, day = this.day;
    const streak = (b['nt.last'] ?? 0) === day - 1 ? (b['nt.streak'] ?? 0) + 1 : 1;
    b['nt.streak'] = streak; b['nt.last'] = day; b['nt.paid'] = day; b['nt.total'] = (b['nt.total'] ?? 0) + 1;
    const cash = rewardFor(streak);
    g.player.money += cash; save.credit(cash);
    this.stats.paid += cash;
    g.hud.stamp('TOWN NOTICE', `All three done. ${money(cash)}${streak > 1 ? ` and a streak of ${streak} day${streak === 1 ? '' : 's'}` : ''}${streak >= REWARD.cap ? ' (the top of the scale)' : ''}.`);
    g.hud.toast(`Town Notice: all three done. ${money(cash)}, streak ${streak}. A new notice goes up at midnight.`, 7);
    this.boardKey = '';
    g.todo.saveNow();
  }

  // ── Each frame ──

  update(dt: number): void {
    const g = this.game, p = g.player;
    if (g.state !== 'play') return;
    this.t += dt;
    const v = p.vehicle;
    // The dashboard view: metres driven with the lens inside the cab.
    if (v && !v.sunk && g.cam.hiddenDriver() === v) this.bump('dash', Math.abs(v.speed) * dt);
    // Seventy-five mph, once per run at it.
    if (v) { const s = Math.abs(v.speed); if (s >= 33.5 && !this.fast) { this.fast = true; this.bump('fast'); } else if (s < 28) this.fast = false; } else this.fast = false;
    if (this.escapeAt && performance.now() > this.escapeAt) {
      this.escapeAt = 0;
      if (performance.now() - this.lastBooked > 8000) this.bump('escape');
    }
    this.poll('rideFerry', g.ferry.stats.boards);
    this.poll('rideBus', g.bus.stats.boards);
    this.poll('rideTrain', g.rail.stats.boards);
    if (this.t >= 0.5) { this.t = 0; this.check(); this.drawBoard(); }
    if (!this.built && STREETS_NEW) this.build();
  }

  /** A counter someone else keeps for this visit: add its rises to ours. */
  private poll(key: string, now: number): void {
    const was = this.last[key];
    this.last[key] = now;
    if (was !== undefined && now > was) this.bump(key, now - was);
  }

  // ── The boards ──

  private build(): void {
    this.built = true;
    const g = this.game;
    try {
      this.cv = document.createElement('canvas');
      this.cv.width = 768; this.cv.height = 512;
      this.tex = new THREE.CanvasTexture(this.cv);
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.tex.anisotropy = 4;
      const wood = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 });
      const faceM = new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      const W = 2.6, H = 1.75;
      for (const bd of BOARDS) {
        const y = groundAt(bd.x, bd.z);
        const grp = new THREE.Group();
        grp.position.set(bd.x, y, bd.z);
        grp.rotation.y = bd.yaw;
        // Two posts, a frame and the face; the pinned papers are drawn on the face.
        for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.9, 0.14), wood); post.position.set(s * (W / 2 + 0.05), 1.45, 0); post.castShadow = g.quality.shadows; grp.add(post); }
        const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.2, H + 0.2, 0.1), wood); frame.position.set(0, 1.55 + H / 2, -0.03); frame.castShadow = g.quality.shadows; grp.add(frame);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), faceM); face.position.set(0, 1.55 + H / 2, 0.03); grp.add(face);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, 0.08, 0.5), wood); roof.position.set(0, 3.35, 0.05); grp.add(roof);
        g.scene.add(grp);
        this.board.push(grp);
        const sx = Math.cos(bd.yaw), sz = -Math.sin(bd.yaw);
        for (const s of [-1, 1]) g.col.addProp(bd.x + sx * s * (W / 2 + 0.05), bd.z + sz * s * (W / 2 + 0.05), 0.14, y + 3, 'post', false).hard = true;
      }
      this.drawBoard(true);
    } catch (e) { console.warn('notice board did not build', e); }
  }

  private drawBoard(force = false): void {
    if (!this.built || !this.cv) return;
    const rows = this.rows(), streak = this.streak();
    const key = `${this.day}|${rows.map((r) => r.done ? 'd' : r.have).join(',')}|${streak}|${this.best['nt.last'] ?? 0}`;
    if (!force && key === this.boardKey) return;
    this.boardKey = key; this.stats.redraws++;
    const c = this.cv.getContext('2d') as CanvasRenderingContext2D, W = 768, H = 512;
    const ink = '#14213d', paper = '#f2e8cf', verm = '#e4572e', green = '#2f5d4a';
    c.fillStyle = '#b79f73'; c.fillRect(0, 0, W, H);
    // The sheet, pinned.
    c.fillStyle = paper; c.fillRect(18, 14, W - 36, H - 28);
    c.fillStyle = verm; c.fillRect(18, 14, W - 36, 78);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = paper;
    c.font = '900 64px "Big Shoulders Display", "Arial Narrow", sans-serif';
    c.fillText('TOWN NOTICE', W / 2, 54);
    c.fillStyle = ink; c.font = '600 26px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    c.fillText(`${this.dateText()} · three jobs for the town`, W / 2, 120);
    c.textAlign = 'left';
    rows.forEach((r, i) => {
      const y = 180 + i * 78;
      c.strokeStyle = ink; c.lineWidth = 5; c.strokeRect(40, y - 22, 44, 44);
      if (r.done) { c.fillStyle = green; c.fillRect(46, y - 16, 32, 32); }
      c.fillStyle = ink; c.font = `${r.done ? 500 : 700} 38px "Big Shoulders Display", "Arial Narrow", sans-serif`;
      c.fillText(r.text, 104, y - 8, W - 150);
      c.fillStyle = r.done ? green : '#6b6250'; c.font = '600 24px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
      c.fillText(r.done ? 'DONE' : r.label, 104, y + 20);
    });
    c.textAlign = 'center'; c.fillStyle = ink; c.font = '700 28px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    const all = rows.length === 3 && rows.every((r) => r.done);
    c.fillText(all ? `All done. Streak ${streak} day${streak === 1 ? '' : 's'}. Back at midnight.` : `All three pays ${money(this.purse())} · streak ${streak} day${streak === 1 ? '' : 's'}`, W / 2, 440);
    c.font = '600 20px "Barlow Semi Condensed", "Arial Narrow", sans-serif'; c.fillStyle = '#6b6250';
    c.fillText('Maine date · the same for the whole town', W / 2, 474);
    this.tex.needsUpdate = true;
  }

  info(): Record<string, unknown> {
    return {
      day: this.day, rows: this.rows(), streak: this.streak(), done: this.doneToday(), purse: this.purse(), total: this.best['nt.total'] ?? 0,
      boards: this.board.length, board: this.boardKey, fm: this.best['nt.fm'] ?? 0, stats: { ...this.stats },
    };
  }
}
