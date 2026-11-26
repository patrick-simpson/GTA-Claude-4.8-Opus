// Graphics presets (fun queue 2, item 42): one tap for "smooth", "balanced" or "pretty", over the options the game
// already had. Kept per device in localStorage pc.gfx (not the game save); every default is the game as it was.
//
// The options:
//   quality   the tier (low / medium / high / auto), in the game save as before. It decides how the world is BUILT
//             (density, draw distance, materials), so a different tier takes effect on the next load.
//   res       the share of the tier's pixel ratio (100 / 80 / 60 %), live.
//   half      the sun's shadow map at half its edge, live.
//   ao        ambient occlusion, live.   aa  the multisampled scene target (off: FXAA alone), live.
//   tune      the governor (core/governor.ts) steps the picture down when frames run long, never above what is set here.
//             null = as it always was: on with quality Auto, off with a fixed tier.
//   fps       a small frame-rate readout.
// The preset shown is worked out from the options, so nothing else has to be kept: the three presets' exact values,
// else Auto (nothing changed from the device's own choice), else Custom.

import type { QualityPick } from '../game/save';

export type PresetName = 'auto' | 'smooth' | 'balanced' | 'pretty' | 'custom';
export interface Look { quality: QualityPick; res: number; half: boolean; ao: boolean; aa: boolean }

export const RES_STEPS: readonly number[] = [100, 80, 60];

/** What each tap sets. Smooth is the low tier (the phone preset) at 80% pixels with the cheap levers given up. */
export const LOOKS: Record<'auto' | 'smooth' | 'balanced' | 'pretty', Look> = {
  auto: { quality: 'auto', res: 1, half: false, ao: true, aa: true },
  smooth: { quality: 'low', res: 0.8, half: true, ao: false, aa: false },
  balanced: { quality: 'medium', res: 1, half: false, ao: true, aa: true },
  pretty: { quality: 'high', res: 1, half: false, ao: true, aa: true },
};
export const PRESET_LABEL: Record<PresetName, string> = { auto: 'Auto', smooth: 'Smooth', balanced: 'Balanced', pretty: 'Pretty', custom: 'Custom' };
export const PRESET_HINT: Record<PresetName, string> = {
  auto: 'The game picks for this device and eases the picture itself if frames run long: what it always did.',
  smooth: 'Frame rate first: fewer cars and people, nearer view, no shadows, a little softer.',
  balanced: 'A good mix: full shadows and occlusion at a medium distance.',
  pretty: 'Looks first: the longest view, the most traffic and people, sharpest picture.',
  custom: 'Your own mix of the options below.',
};

const KEY = 'pc.gfx';

class Gfx {
  res = 1;
  half = false;
  ao = true;
  aa = true;
  tune: boolean | null = null;
  fps = false;
  /** Changes whenever anything does. */
  ver = 0;
  private listeners: (() => void)[] = [];

  constructor() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null;
      if (j) {
        if (RES_STEPS.includes(Math.round(Number(j.res) * 100))) this.res = Math.round(Number(j.res) * 100) / 100;
        this.half = j.half === true;
        this.ao = j.ao !== false;
        this.aa = j.aa !== false;
        this.tune = typeof j.tune === 'boolean' ? j.tune : null;
        this.fps = j.fps === true;
      }
    } catch { /* no storage, or nothing saved: the defaults */ }
  }

  onChange(f: () => void): void { this.listeners.push(f); }

  set(p: Partial<{ res: number; half: boolean; ao: boolean; aa: boolean; tune: boolean | null; fps: boolean }>): void {
    if (p.res !== undefined && RES_STEPS.includes(Math.round(p.res * 100))) this.res = Math.round(p.res * 100) / 100;
    if (p.half !== undefined) this.half = p.half;
    if (p.ao !== undefined) this.ao = p.ao;
    if (p.aa !== undefined) this.aa = p.aa;
    if (p.tune !== undefined) this.tune = p.tune;
    if (p.fps !== undefined) this.fps = p.fps;
    this.ver++;
    try { localStorage.setItem(KEY, JSON.stringify({ res: this.res, half: this.half, ao: this.ao, aa: this.aa, tune: this.tune, fps: this.fps })); } catch { /* not kept */ }
    for (const f of this.listeners) f();
  }

  /** The governor runs: as set, else as it always did (with Auto only). */
  tuneFor(pick: QualityPick): boolean { return this.tune ?? pick === 'auto'; }

  /** The preset the options add up to. */
  preset(pick: QualityPick): PresetName {
    for (const n of ['auto', 'smooth', 'balanced', 'pretty'] as const) {
      const l = LOOKS[n];
      if (l.quality === pick && l.res === this.res && l.half === this.half && l.ao === this.ao && l.aa === this.aa) return n;
    }
    return 'custom';
  }

  /** Set every option a preset names (the tier is the caller's: it lives in the save). The governor setting is left as it was. */
  look(n: 'auto' | 'smooth' | 'balanced' | 'pretty'): Look {
    const l = LOOKS[n];
    this.set({ res: l.res, half: l.half, ao: l.ao, aa: l.aa });
    return l;
  }
}
export const gfx = new Gfx();

/** The small frame-rate readout, top middle: shown while `gfx.fps` is on. */
export function fpsReadout(game: { fps: number; gov: { ms: number } }): void {
  let el: HTMLElement | null = null;
  const sync = (): void => {
    if (gfx.fps && !el) {
      el = document.createElement('div');
      el.id = 'fps-readout';
      el.style.cssText = 'position:fixed;left:50%;top:4px;transform:translateX(-50%);z-index:20;padding:1px 7px;background:rgba(10,14,24,.55);color:#f2e8cf;font:11px/1.4 "IBM Plex Mono",monospace;pointer-events:none;border-radius:3px';
      document.body.appendChild(el);
    } else if (!gfx.fps && el) { el.remove(); el = null; }
  };
  gfx.onChange(sync);
  sync();
  setInterval(() => { if (el) el.textContent = `${Math.round(game.fps)} fps` + (game.gov.ms ? ` · ${game.gov.ms.toFixed(1)} ms` : ''); }, 500);
}
