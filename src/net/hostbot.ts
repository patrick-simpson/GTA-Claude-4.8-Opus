// The host bot: a host-only mode of the game for the mini PC (server/home/hostbot.ts opens it in headless Chromium).
//
//   ?hostbot=1&bot=<pass>&net=ws://127.0.0.1:8788&q=low&glb=0&people=0&flora=0&props=0&noupdate=1&save=0
//
// It joins the main town with the mini PC's signed pass (protocol.ts BOT_PARAM; the service checks it and never lets
// it in through the tunnel), takes no seat and is never shown to anybody (room.ts tells nobody of it), and the
// service makes it the host whenever it is live. Here it has no player: the game stays on the title card, so the
// player is never simulated and no state frame is ever sent. Nothing is drawn: the display loop is replaced by a
// fixed-rate tick (BOT_HZ) with no render at all.
//
// The town is simulated round EVERY player: one of them (the first, in the order they came) stands in for this
// browser's own player (the traffic's and the crowd's "own" anchor, and the camera they keep things out of sight
// of), and the rest are the usual extra anchors (shared.ts leaves the stand-in out of those).

import type { Game } from '../core/game';
import { LOCAL_SERVICE } from './conn';

/** Simulation steps a second. Half the display rate: the shared town is sent at 10 a second anyway. */
export const BOT_HZ = 30;

/** The pass when this page is the host bot ('' for every ordinary page). Only with a local service named by ?net=. */
export function hostBotPass(): string {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('hostbot') !== '1') return '';
    const net = q.get('net') ?? '';
    if (!net.split(',').some((u) => LOCAL_SERVICE.test(u))) return '';
    const pass = q.get('bot') ?? '';
    return /^\d{10}\.[A-Za-z0-9_-]{80,90}$/.test(pass) ? pass : '';
  } catch {
    return '';
  }
}

export interface BotStats {
  status: string; host: boolean; players: number; cars: number; people: number; police: number;
  /** Mean and worst ms per tick over the last minute (since the last call). */
  tickMs: number; tickMax: number; ticks: number; mode: string; lead: number;
}

/** Runs the town with nothing drawn. Call after game.init(), instead of game.run(). */
export function runHostBot(game: Game): void {
  const net = game.net;
  game.frozen = true; // the display loop, if anything starts it, does no steps
  game.render = () => {};
  // (No camera rig either: the camera is put where the stand-in player is, every step.)
  game.cam.update = () => {};
  const p = game.player;
  p.person.visible = false;
  let last = performance.now(), sum = 0, max = 0, n = 0;
  const step = (): void => {
    const t = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
    last = t;
    if (net) follow(game);
    game.tick(dt);
    const ms = performance.now() - t;
    sum += ms; n++; if (ms > max) max = ms;
  };
  setInterval(step, 1000 / BOT_HZ);
  (window as unknown as { __hostbot: { stats(): BotStats } }).__hostbot = {
    stats(): BotStats {
      const info = net ? net.info() : null;
      const tr = info?.traffic as { mode?: string; cars?: unknown[] } | undefined;
      const pe = info?.people as { cars?: unknown[]; walkers?: unknown[]; people?: unknown[] } | undefined;
      const po = info?.police as { cars?: unknown[] } | undefined;
      const s: BotStats = {
        status: net ? net.status : 'off', host: !!net && net.conn.host !== 0 && net.conn.host === net.conn.id,
        players: net ? net.remotes.size : 0, cars: Array.isArray(tr?.cars) ? tr.cars.length : 0,
        people: Array.isArray(pe?.people) ? pe.people.length : Array.isArray(pe?.walkers) ? pe.walkers.length : 0,
        police: Array.isArray(po?.cars) ? po.cars.length : 0,
        tickMs: n ? +(sum / n).toFixed(2) : 0, tickMax: +max.toFixed(1), ticks: n, mode: tr?.mode ?? '', lead: net ? net.shared.botLead : 0,
      };
      sum = 0; max = 0; n = 0;
      return s;
    },
  };
}

/** The stand-in: this browser's own player and camera go where the first player in town is. */
function follow(game: Game): void {
  const net = game.net;
  if (!net) return;
  let lead = null;
  for (const r of net.remotes.values()) if (r.seen) { lead = r; break; }
  net.shared.botLead = lead ? lead.id : 0;
  if (!lead) return;
  const per = game.player.person, cam = game.camera.position;
  per.x = lead.x; per.z = lead.z; per.y = lead.y;
  // Their camera is not known: behind them, looking the way they face (as shared.ts guesses for the others).
  cam.x = lead.x - Math.sin(lead.h) * 6; cam.z = lead.z - Math.cos(lead.h) * 6; cam.y = lead.y + 3;
  game.cam.yaw = lead.h;
}
