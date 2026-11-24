// Claude FM: Anthropic's 24/7 live music stream on YouTube, as the first station on the car radio.
//
// The stream restarts now and then and gets a new video id, so the player is pointed at the channel's live stream,
// not at a video. OWNER DECISION (Nov 23): the player is hidden for the demo (the owner was told this goes against
// YouTube's terms for embedded players and chose it anyway). It sits in the page, 200x200, invisible and behind the
// canvas; never display:none, which can stop playback. Only the HUD's radio readout says "Claude FM".
//
// Nothing is fetched from YouTube until she first tunes to it (src/audio/radio.ts calls set(true, ...) only then),
// and the radio only exists after her first click or tap, which is what lets the iframe play with sound. If the
// script cannot be fetched, the embed is refused, the player errors, or it will not start, this gives up for the
// session and says why through onFail; the radio falls back to the first generated station. It never throws and
// never waits on anything the game needs.

/** The channel @claude. Its live stream is Claude FM. */
export const CLAUDE_FM_CHANNEL = 'UCV03SRZXJEz-hchIAogeJOg';
export const CLAUDE_FM_CALL = 'Claude FM';

// The few pieces of the IFrame Player API used here (loaded from youtube.com at run time, not bundled).
interface YTPlayer {
  playVideo(): void; pauseVideo(): void; setVolume(v: number): void; unMute(): void; mute(): void;
  getPlayerState(): number; getCurrentTime(): number; getDuration(): number; seekTo(s: number, ahead: boolean): void;
  destroy(): void;
}
interface YTNamespace { Player: new (el: HTMLElement, o: object) => YTPlayer }
type YTWindow = Window & { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };

const PLAYING = 1, BUFFERING = 3;
/**
 * How long the script and player may take to arrive, in ms, and how many tries it gets (a slow first connection or a
 * blip is not a failure); how long one play may take to become sound, and how many tries (the second and third go
 * out muted, which browsers allow where an unmuted autoplay is refused, and are unmuted the moment it plays).
 * Only embedding refused (errors 100, 101, 150) or all the tries used up is a real failure.
 */
const LOAD_MS = 12000, LOAD_TRIES = 3, START_MS = 7000, START_TRIES = 3;

export class ClaudeFM {
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  /** Why it gave up, for the notice and for tests. */
  why = '';
  player: YTPlayer | null = null;
  private host: HTMLElement | null = null;
  private want = false;
  private vol = -1;
  /** When the current play was asked for (performance.now()), or 0 once it is sounding. */
  private askedAt = 0;
  private pausedAt = 0;
  private timer = 0;
  private gen = 0;
  private loadTries = 0;
  private startTries = 1;
  private mutedByUs = false;
  private script: HTMLScriptElement | null = null;
  /** The DJ's ducking (voices.ts ClaudeFMDJ): a 0..1 factor on the volume, so the stream goes under a spoken line and comes back. */
  duck = 1;

  constructor(private readonly onFail: (why: string) => void) {}

  /** Each frame: whether it should be sounding, and at what level (0..1). Cheap when nothing changes. */
  set(want: boolean, volume: number): void {
    if (this.state === 'failed') return;
    if (want && this.state === 'idle') this.load();
    const v = Math.round(Math.max(0, Math.min(1, volume * this.duck)) * 100);
    const p = this.state === 'ready' ? this.player : null;
    if (!p) { this.want = want; return; }
    try {
      if (v !== this.vol) { p.setVolume(v); this.vol = v; }
      if (want !== this.want) {
        if (want) {
          p.unMute(); this.mutedByUs = false; this.startTries = 1;
          // Back after more than half a minute away: rejoin the broadcast, not the moment she left it.
          if (this.pausedAt && performance.now() - this.pausedAt > 30000) p.seekTo(p.getDuration(), true);
          p.playVideo();
          this.askedAt = performance.now();
        } else { p.pauseVideo(); this.pausedAt = performance.now(); this.askedAt = 0; }
      }
      this.want = want;
      if (want && this.askedAt) {
        const s = p.getPlayerState();
        if (s === PLAYING) { this.askedAt = 0; this.startTries = 1; if (this.mutedByUs) { this.mutedByUs = false; p.unMute(); } }
        else if (s !== BUFFERING && performance.now() - this.askedAt > START_MS) {
          if (this.startTries >= START_TRIES) this.fail('the stream would not start');
          else { this.startTries++; this.mutedByUs = true; p.mute(); p.playVideo(); this.askedAt = performance.now(); }
        }
      }
    } catch (e) { this.fail('player error: ' + String(e)); }
  }

  /** Stop at once (the game paused, the tab hid). set() starts it again. */
  pause(): void {
    if (this.state !== 'ready' || !this.player || !this.want) return;
    try { this.player.pauseVideo(); } catch { /* gone */ }
    this.want = false; this.pausedAt = performance.now(); this.askedAt = 0;
  }

  /** True when the player says it is playing. */
  get playing(): boolean {
    try { return this.state === 'ready' && !!this.player && this.player.getPlayerState() === PLAYING; } catch { return false; }
  }

  private load(): void {
    this.state = 'loading'; this.loadTries++;
    const gen = ++this.gen;
    const w = window as YTWindow;
    this.timer = window.setTimeout(() => this.retry('YouTube did not answer'), LOAD_MS);
    const host = this.host = document.body.appendChild(document.createElement('div'));
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden;';
    const slot = host.appendChild(document.createElement('div'));
    const make = (): void => {
      if (gen !== this.gen || this.state !== 'loading' || !w.YT?.Player) return;
      try {
        this.player = new w.YT.Player(slot, {
          width: 200, height: 200, videoId: 'live_stream',
          playerVars: { channel: CLAUDE_FM_CHANNEL, autoplay: 0, controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0, iv_load_policy: 3, origin: location.origin },
          events: {
            onReady: () => {
              if (gen !== this.gen || this.state !== 'loading') return;
              clearTimeout(this.timer);
              this.state = 'ready';
              const want = this.want; this.want = false; this.vol = -1;
              this.set(want, 0);
            },
            onError: (e: { data: number }) => {
              if (gen !== this.gen) return;
              const why = 'YouTube error ' + e.data + (e.data === 101 || e.data === 150 ? ' (embedding refused)' : '');
              if (e.data === 100 || e.data === 101 || e.data === 150) this.fail(why); else this.retry(why);
            },
          },
        });
      } catch (e) { this.fail('player error: ' + String(e)); }
    };
    if (w.YT?.Player) { make(); return; }
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { prev?.(); make(); };
    this.script?.remove();
    const s = this.script = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { if (gen === this.gen) this.retry('YouTube could not be reached'); };
    document.head.appendChild(s);
  }

  /** The player or the script did not arrive: start over a couple of times, a little later each time, before giving up. */
  private retry(why: string): void {
    if (this.state !== 'loading' && this.state !== 'ready') return;
    clearTimeout(this.timer);
    if (this.loadTries >= LOAD_TRIES) { this.fail(why); return; }
    console.warn('Claude FM: ' + why + ', trying again');
    this.gen++;
    try { this.player?.destroy(); } catch { /* already gone */ }
    this.player = null; this.host?.remove(); this.host = null;
    this.state = 'loading'; this.askedAt = 0; this.vol = -1;
    this.timer = window.setTimeout(() => this.load(), 1500 * this.loadTries);
  }

  private fail(why: string): void {
    if (this.state === 'failed') return;
    this.state = 'failed'; this.why = why; this.want = false;
    clearTimeout(this.timer);
    try { this.player?.destroy(); } catch { /* already gone */ }
    this.player = null;
    this.host?.remove(); this.host = null;
    this.onFail(why);
  }
}
