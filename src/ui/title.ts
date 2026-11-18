// The title card: a travel poster for a town that should not be advertising.
//
// Two pieces. The picture (sun, light, harbor) covers the canvas while the
// world is still being built, then slides up out of the way; the navy band
// with the lettering stays as the lower third over the live title flight.
// Everything that moves does so by transform and opacity only.

import './title.css';
import type { Game } from '../core/game';
import type { Weather } from '../core/api';
import { RNG } from '../core/util';

const INK = '#14213d', BONE = '#f2e8cf', VERMILION = '#e4572e', MUSTARD = '#f0a202', TEAL = '#2a9d8f';
const BRICK = '#9c4a3c', TERRACOTTA = '#c8744f', SAGE = '#8a9a6b', DEEP = '#1f7f76', WHITE = '#fbf5e4';

/** Picture space. The horizon sits low so a wide, short phone still keeps the lamp of the light. */
const W = 1600, H = 700, SEA = 500;

/** A band of water from y to the bottom whose top edge is a row of scallops, the way posters draw waves. */
function waves(y: number, step: number, lift: number, shift: number, fill: string): string {
  let d = `M${-step + shift} ${y}`;
  for (let x = -step + shift; x < W + step; x += step) d += `q${step / 2} ${-lift} ${step} 0`;
  return `<path d="${d}V${H}H${-step}z" fill="${fill}"/>`;
}

function gull(x: number, y: number, s: number): string {
  return `<path d="M${x - 20 * s} ${y - 3 * s}q${11 * s} ${-9 * s} ${20 * s} ${3 * s}q${9 * s} ${-12 * s} ${20 * s} ${-3 * s}" fill="none" stroke="${INK}" stroke-width="${3.4 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function picture(): string {
  const rng = new RNG(1907);
  const sx = 560;
  let s = `<rect width="${W}" height="${H}" fill="${BONE}"/>`;

  // Rays: flat wedges a shade under the paper, fanned from the sun.
  let rays = '';
  for (let i = 0; i < 13; i++) {
    const a = Math.PI * (1.02 + (i / 13) * 0.96), b = a + 0.034, r = 1500;
    rays += `M${sx} ${SEA}L${sx + Math.cos(a) * r} ${SEA + Math.sin(a) * r}L${sx + Math.cos(b) * r} ${SEA + Math.sin(b) * r}z`;
  }
  s += `<path d="${rays}" fill="#ead9b0"/>`;
  s += `<circle cx="${sx}" cy="${SEA}" r="318" fill="#f5d58c"/><circle cx="${sx}" cy="${SEA}" r="262" fill="${MUSTARD}"/><circle cx="${sx}" cy="${SEA}" r="200" fill="${VERMILION}"/>`;

  // The lamp's beam, laid over the sky as one flat tint.
  s += `<path d="M1262 268L-40 150V330z" fill="${WHITE}" opacity="0.55"/>`;

  // The Perpetual Bridge leaves the frame on the left and stops when the money did.
  s += `<path d="M-10 398H232V412H-10z" fill="${INK}"/><path d="M60 412h14V${SEA}H60zM176 412h14V${SEA}H176z" fill="${INK}"/>`;
  s += `<path d="M-10 398Q60 330 67 330Q125 398 183 330Q200 352 232 398" fill="none" stroke="${INK}" stroke-width="5"/>`;
  s += `<path d="M232 392h22v8h-22z" fill="${VERMILION}"/>`;

  // The headland and the town on it.
  s += `<path d="M150 ${SEA}Q330 428 560 446T1010 ${SEA}z" fill="${SAGE}"/>`;
  const tones = [BRICK, TERRACOTTA, INK, BRICK, INK, TERRACOTTA];
  for (let x = 268, i = 0; x < 900; i++) {
    const w = rng.range(20, 46), h = rng.range(22, 78) * (1 - Math.abs(x - 590) / 620);
    const base = SEA - 26 - 26 * Math.sin(((x - 150) / 860) * Math.PI);
    s += `<rect x="${x.toFixed(0)}" y="${(base - h).toFixed(0)}" width="${w.toFixed(0)}" height="${(h + 40).toFixed(0)}" fill="${tones[i % tones.length]}"/>`;
    x += w + rng.range(-4, 9);
  }
  // One tower with a clock nobody trusts, and two port cranes.
  s += `<rect x="640" y="338" width="34" height="140" fill="${INK}"/><path d="M634 338h46l-23-34z" fill="${VERMILION}"/><circle cx="657" cy="362" r="9" fill="${BONE}"/>`;
  s += `<path d="M850 478V392h-58v10h44M850 392l30 22M930 482V408h-52v9h40" fill="none" stroke="${INK}" stroke-width="7"/>`;
  s += `<path d="M150 ${SEA}Q330 470 560 474T1010 ${SEA}z" fill="${SAGE}"/>`;

  // Water, back to front, each band a little darker and a little bigger.
  s += `<rect y="${SEA}" width="${W}" height="${H - SEA}" fill="${TEAL}"/>`;
  // The sun's road on the water: bars that widen toward the viewer.
  for (let i = 0; i < 5; i++) {
    const w = 250 - i * 38, y = SEA + 10 + i * 17;
    s += `<rect x="${sx - w / 2 + (i % 2 ? 14 : -10)}" y="${y}" width="${w}" height="7" fill="${i < 2 ? MUSTARD : '#f5d58c'}"/>`;
  }
  s += waves(SEA + 96, 76, 15, 0, DEEP);

  // The duck. It is larger than it looks; it is a long way off.
  s += `<g transform="translate(985 ${SEA + 52})"><ellipse cx="0" cy="0" rx="25" ry="13" fill="${MUSTARD}"/><circle cx="17" cy="-17" r="11.5" fill="${MUSTARD}"/><path d="M26-19l15 4-15 5z" fill="${VERMILION}"/><circle cx="19" cy="-20" r="2" fill="${INK}"/><path d="M-25-2q-9-12-13-17q11 0 22 9z" fill="${MUSTARD}"/></g>`;
  // A sail.
  s += `<path d="M352 ${SEA + 40}l34-74v74z" fill="${WHITE}"/><path d="M392 ${SEA + 40}v-58l26 58z" fill="${VERMILION}"/><path d="M336 ${SEA + 46}h96l-12 13h-72z" fill="${INK}"/>`;

  // Last Light: rock, breakwater, tower, lamp.
  s += `<path d="M1150 ${SEA + 26}L1182 ${SEA - 22}L1226 ${SEA - 40}H1330L1372 ${SEA - 18}L1400 ${SEA - 20}H${W + 10}V${SEA + 26}z" fill="${INK}"/>`;
  s += `<path d="M1232 ${SEA - 40}L1248 302H1304L1320 ${SEA - 40}z" fill="${WHITE}"/>`;
  s += `<path d="M1236.9 400L1241 350H1311L1315.100 400z" fill="${VERMILION}"/><path d="M1233.200 ${SEA - 54}L1232 ${SEA - 40}H1320L1318.800 ${SEA - 54}z" fill="${VERMILION}"/>`;
  s += `<rect x="1267" y="420" width="18" height="26" fill="${INK}"/>`;
  s += `<path d="M1232 ${SEA - 40}L1248 302H1304L1320 ${SEA - 40}" fill="none" stroke="${INK}" stroke-width="5"/>`;
  s += `<rect x="1234" y="292" width="84" height="11" fill="${INK}"/><rect x="1254" y="246" width="44" height="46" fill="${MUSTARD}" stroke="${INK}" stroke-width="5"/>`;
  s += `<path d="M1276 246v46" stroke="${INK}" stroke-width="4"/><path d="M1242 247h68l-34-34z" fill="${VERMILION}" stroke="${INK}" stroke-width="5" stroke-linejoin="miter"/><path d="M1276 213v-20" stroke="${INK}" stroke-width="5"/>`;

  s += waves(SEA + 142, 112, 21, -40, INK);

  s += gull(1010, 262, 1.5) + gull(1104, 316, 0.95) + gull(900, 330, 0.8) + gull(236, 286, 1.1) + gull(318, 244, 0.7) + gull(1440, 356, 0.85);
  return `<svg class="tt-art" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">${s}</svg>`;
}

export class Title {
  private root: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  private shownF = -1;
  private shownLabel = '';
  private isReady = false;
  private gone = false;
  private band: HTMLElement;
  /** What the sky was doing before the title posed it, to be put back on start. */
  private held: { hour: number; rate: number; weather: Weather } | null = null;
  private onResize = (): void => this.frame(1);

  constructor(private game: Game) {
    const root = (document.getElementById('title') ?? document.body.appendChild(document.createElement('div'))) as HTMLElement;
    root.id = 'title';
    this.root = root;
    root.innerHTML = `
<div class="tt-pic">${picture()}
  <div class="tt-tab"><span>Harbor Authority of Port Calamity</span><span>Visitor information, sheet 1 of 1</span></div>
</div>
<div class="tt-band">
  <div class="tt-over"><span>Visit scenic</span><i></i><span>Pop. disputed</span></div>
  <h1 class="tt-name">Port Calamity</h1>
  <div class="tt-foot">
    <div class="tt-copy">
      <p class="tt-tag">Come for the sea air. Stay because the bridge isn&rsquo;t finished.</p>
      <p class="tt-credit">An original open-world town. Any resemblance to a functioning municipality is coincidental.</p>
    </div>
    <div class="tt-slot">
      <div class="tt-load"><div class="tt-load-tx">Unfolding the map</div><div class="tt-rule"><i></i></div></div>
      <div class="tt-go"><span class="tt-go-key">Press any key</span><span class="tt-go-tap">Tap to start</span></div>
    </div>
  </div>
</div>`;
    this.fill = root.querySelector('.tt-rule i') as HTMLElement;
    this.label = root.querySelector('.tt-load-tx') as HTMLElement;
    this.band = root.querySelector('.tt-band') as HTMLElement;

    addEventListener('keydown', (e) => {
      // Browser business (reload, dev tools, tabbing away) is not "any key".
      if (e.ctrlKey || e.metaKey || e.altKey || /^(F\d+|Tab|Meta|Control|Alt|Shift|CapsLock)/.test(e.key)) return;
      this.go(true);
    });
    root.addEventListener('pointerdown', (e) => this.go(e.pointerType === 'mouse'));
    game.on('start', () => this.leave());
  }

  /** f: 0..1. The label is whatever the loader is doing, in its own words. */
  progress(f: number, label: string): void {
    const pct = Math.round(Math.min(1, Math.max(0, f)) * 200) / 200;
    if (pct !== this.shownF) { this.shownF = pct; this.fill.style.transform = `scaleX(${pct})`; }
    if (label !== this.shownLabel) { this.shownLabel = label; this.label.textContent = label; }
  }

  /** The world exists: lift the picture off the live city and ask for a key. */
  ready(): void {
    if (this.isReady || this.gone) return;
    this.isReady = true;
    this.progress(1, this.shownLabel);
    this.root.classList.add('ready');
    // Tests call start() before ready(); the card must not come back for them.
    if (this.game.state !== 'title') { this.leave(); return; }
    this.pose();
  }

  /**
   * The flight under the lettering is the first look anyone gets at the town,
   * and the real opening hour is a hazy morning that flattens it to grey-green.
   * So the title shows the town at its best: clear, late afternoon, the clock
   * stopped. The real morning is put back the moment the game starts.
   */
  private pose(): void {
    const sky = this.game.sky;
    this.held = { hour: sky.hour, rate: sky.rate, weather: sky.weather };
    sky.hour = 17.25;
    sky.rate = 0;
    sky.setWeather('clear', true);
    this.frame(1);
    addEventListener('resize', this.onResize);
  }

  /**
   * The band covers the bottom of the screen, where the flight keeps the pier.
   * Shift the lens (not the camera) so the picture's middle is the middle of
   * the part still showing. k: 1 = fully shifted, 0 = the plain view.
   */
  private frame(k: number): void {
    const cam = this.game.camera, w = innerWidth, h = innerHeight;
    if (k <= 0) cam.clearViewOffset();
    else cam.setViewOffset(w, h, 0, Math.round(this.band.offsetHeight * 0.5 * k), w, h);
  }

  private go(lock: boolean): void {
    if (!this.isReady || this.gone || this.game.state !== 'title') return;
    this.game.start();
    // Still inside the key or click that started the game, so the browser allows the lock.
    if (lock) this.game.input.lock();
  }

  private leave(): void {
    if (this.gone) return;
    this.gone = true;
    const root = this.root, t0 = performance.now();
    root.classList.add('leave');
    const held = this.held;
    this.held = null;
    if (held) {
      const sky = this.game.sky;
      sky.hour = held.hour;
      sky.rate = held.rate;
      sky.setWeather(held.weather, true);
      removeEventListener('resize', this.onResize);
    }
    // Remove the card when its exit is over. A test that freezes the clock is
    // about to take a screenshot, so for it the card goes at once.
    const watch = (): void => {
      const f = (performance.now() - t0) / 480;
      if (this.game.frozen || f >= 1) {
        root.classList.add('gone');
        if (held) this.frame(0);
        return;
      }
      // The lens shift eases out with the band, so the swoop down to Dess starts from the picture that was on screen.
      if (held) this.frame((1 - f) * (1 - f));
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }
}
