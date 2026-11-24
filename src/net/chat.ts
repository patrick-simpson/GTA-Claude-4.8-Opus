// Safe chat on the wire (fun queue item 21; game/chat.ts is the wheel and the screens, game/chatLines.ts the words).
//
// Nothing typed ever travels. An Event frame, PlayerEvent.Chat (21), 5 bytes:
//   0 kind (Frame.Event)  1 sender id (the service writes it)  2 code 21  3 phrase index  4 place index (NO_PLACE = none)
// The receiver looks both up in its OWN built-in tables and shows only that text. An index it does not have, a place on a
// phrase that takes none, a missing place on one that does, a sender it has never heard of, a muted sender, or a sender
// over the rate limit: dropped without a word. The service relays it unread like any Event frame (nothing to redeploy; the
// protocol version stays); a page that does not know code 21 hands it on to the weapons code, which ignores codes it does not know.
//
// Rate limit, the same bucket for what a player sends and what each sender is let through here: 3 in a burst, then one
// every 1.5 s. A sender who keeps knocking after the bucket is empty (8 refused) is ignored for 20 s.

import type { Game } from '../core/game';
import { Frame, PlayerEvent, makeFrame } from './protocol';
import { NO_PLACE, PHRASES, isPlacePhrase, placeTable } from '../game/chatLines';
import type { Connection } from './conn';
import type { Remote } from './remote';

export const CHAT_BYTES = 5;
export const CHAT_BURST = 3;
export const CHAT_GAP_MS = 1500;
const FLOOD_REFUSALS = 8, FLOOD_IGNORE_MS = 20000;

export function encodeChat(phrase: number, place: number): ArrayBuffer {
  const buf = makeFrame(Frame.Event, 3);
  const u8 = new Uint8Array(buf);
  u8[2] = PlayerEvent.Chat; u8[3] = phrase & 0xff; u8[4] = place & 0xff;
  return buf;
}
export function decodeChat(buf: ArrayBuffer): { id: number; phrase: number; place: number } | null {
  if (buf.byteLength !== CHAT_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.Event || u8[2] !== PlayerEvent.Chat) return null;
  return { id: u8[1], phrase: u8[3], place: u8[4] };
}

/** A token bucket: `take` says whether one more goes through now. */
class Bucket {
  tokens = CHAT_BURST;
  at = 0;
  refused = 0;
  until = 0;
  take(now: number): boolean {
    this.tokens = Math.min(CHAT_BURST, this.tokens + (now - this.at) / CHAT_GAP_MS);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class TownChat {
  readonly stats = { sent: 0, got: 0, slow: 0, bad: 0, muted: 0, flood: 0 };
  private readonly mine = new Bucket();
  private readonly from = new Map<number, Bucket>();
  private readonly mutes = new Set<number>();

  constructor(private readonly game: Game, private readonly conn: Connection, private readonly remotes: Map<number, Remote>) {}

  /** Somebody else is in town to hear it. */
  get canSend(): boolean { return this.conn.status === 'online' && this.remotes.size > 0; }

  /** Say phrase `phrase` (and name `place`, for a phrase with a %). Returns 'ok', or why not: 'alone', 'slow', 'bad'. */
  send(phrase: number, place = NO_PLACE, now = performance.now()): 'ok' | 'alone' | 'slow' | 'bad' {
    if (!Number.isInteger(phrase) || phrase < 0 || phrase >= PHRASES.length) return 'bad';
    if (isPlacePhrase(phrase) === (place === NO_PLACE)) return 'bad';
    if (!this.canSend) return 'alone';
    if (!this.mine.take(now)) { this.stats.slow++; return 'slow'; }
    if (!this.conn.send(encodeChat(phrase, place))) return 'alone';
    this.stats.sent++;
    return 'ok';
  }

  /** An Event frame with code 21 (index.ts). */
  event(buf: ArrayBuffer, now = performance.now()): void {
    const m = decodeChat(buf);
    const r = m ? this.remotes.get(m.id) : undefined;
    if (!m || !r) { this.stats.bad++; return; }
    if (this.mutes.has(m.id)) { this.stats.muted++; return; }
    let b = this.from.get(m.id);
    if (!b) this.from.set(m.id, (b = new Bucket()));
    if (now < b.until) { this.stats.flood++; return; }
    if (!b.take(now)) {
      this.stats.flood++;
      if (++b.refused >= FLOOD_REFUSALS) { b.until = now + FLOOD_IGNORE_MS; b.refused = 0; }
      return;
    }
    if (m.phrase >= PHRASES.length || isPlacePhrase(m.phrase) === (m.place === NO_PLACE)) { this.stats.bad++; return; }
    let place = null;
    if (m.place !== NO_PLACE) {
      place = placeTable(this.game)[m.place] ?? null;
      if (!place) { this.stats.bad++; return; }
    }
    this.stats.got++;
    this.game.chat?.heard(r, m.phrase, place);
  }

  // ── Mute (the pause menu's Town section) ──
  muted(id: number): boolean { return this.mutes.has(id); }
  mute(id: number, on: boolean): void { if (on) this.mutes.add(id); else this.mutes.delete(id); }
  /** Somebody left town: their mute and their bucket go with them (an id may be given to a stranger). */
  dropped(id: number): void { this.mutes.delete(id); this.from.delete(id); }
  clear(): void { this.mutes.clear(); this.from.clear(); }

  info(): Record<string, unknown> { return { ...this.stats, mutedIds: [...this.mutes] }; }
}
