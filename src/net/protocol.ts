// PORT CALAMITY multiplayer protocol. ONE file, no imports, shared by the game client and by the
// message service in server/ (which imports it by relative path). Keep it dependency free and keep
// it free of DOM or Workers only types, so both sides compile it.
//
// Two kinds of WebSocket message:
//  - BINARY frames for everything frequent. Byte 0 is the kind (Frame), byte 1 is a player id. The
//    client leaves byte 1 as 0 (or the target id for Frame.ToPlayer); the service overwrites it with
//    the sender's id and forwards the SAME buffer, so a relay costs no parsing and no copy.
//    The service never looks past byte 1.
//  - JSON text for the rare control messages (presence, names, host changes, durable facts). They
//    are easy to read in a debugger and they are a few per minute, so size does not matter.
//
// Nothing a player types ever travels: names are indexes into the client's own word lists, shouts
// are numbers, durable facts are numbers.

export const PROTOCOL_VERSION = 1;

// ---- limits and rates (the service enforces the limits; the client should respect the rates) ----

/** Players per city. Player 17 is put in a second city silently. */
export const CITY_CAP = 16;
/** How many cities the Worker will try before answering 503. */
export const MAX_CITIES = 8;
/** Player state sends per second. */
export const SEND_HZ = 10;
/** Largest Frame.State / Frame.Event / Frame.ToHost / Frame.Keepalive, in bytes. */
export const MAX_PLAYER_FRAME_BYTES = 96;
/** Largest Frame.World / Frame.ToPlayer (host only), in bytes. */
export const MAX_HOST_FRAME_BYTES = 4096;
/** Largest JSON control message, in characters. */
export const MAX_TEXT_CHARS = 256;
/** Sustained messages per second allowed per connection, and the burst allowed on top. */
export const RATE_PER_SECOND = 40;
export const RATE_BURST = 80;
/** A name is 2 or 3 indexes, each 0..NAME_INDEX_MAX, into the client's fixed word lists. */
export const NAME_PARTS_MIN = 2;
export const NAME_PARTS_MAX = 3;
export const NAME_INDEX_MAX = 255;

/** Send SOMETHING at least this often while others are in the city (a Frame.Keepalive will do). */
export const KEEPALIVE_MS = 2000;
/** Report measured frame time this often (the Perf message). It also counts as a keepalive. */
export const PERF_INTERVAL_MS = 5000;
/** The host is replaced when nothing has arrived from it for this long. */
export const HOST_STALL_MS = 4000;
/** A host slower than this (ms per frame) is "struggling" and may be replaced... */
export const HOST_SLOW_MS = 25;
/** ...by a player whose frame time is at most this fraction of the host's (the hysteresis)... */
export const HOST_TAKEOVER_RATIO = 0.7;
/** ...but not within this long of the last change, so the job does not flap. */
export const HOST_MIN_TENURE_MS = 8000;
/** Frame time assumed for a player who has not reported yet. */
export const PERF_UNKNOWN_MS = 50;
/** Report this (or more) to say "do not make me host" (hidden tab, phone on battery saver). */
export const PERF_CANNOT_HOST_MS = 1000;

/** Durable facts: at most this many keys per city; a value is a number or up to FACT_MAX_NUMBERS numbers. */
export const FACT_MAX_KEYS = 32;
export const FACT_MAX_NUMBERS = 16;
export const FACT_KEY_PATTERN = /^[a-z][a-z0-9_.]{0,23}$/;
/** A fact written more often than this is held in memory and stored at most this often. */
export const FACT_FLUSH_MS = 5000;
/** Well known fact keys (the service accepts any key that matches FACT_KEY_PATTERN). */
export const FACT_CLOCK = 'clock';
export const FACT_WEATHER_SEED = 'weather.seed';
export const FACT_BRIDGE = 'bridge';

/** Close codes the service uses (4000 to 4999 are free for applications). */
export const Close = {
  TooBig: 4001,
  TooFast: 4002,
  BadMessage: 4003,
} as const;

/** HTTP status the Worker answers instead of an upgrade (a browser only sees "could not connect"). */
export const HTTP_BAD_ORIGIN = 403;
export const HTTP_BAD_HELLO = 400;
export const HTTP_ALL_FULL = 503;

/**
 * The hello is the URL itself, so a socket never exists without a valid name:
 *   new WebSocket(cityUrl('wss://port-calamity-city.<account>.workers.dev', [3, 17, 200]))
 * The first message back is the Welcome.
 */
export function cityUrl(base: string, name: NameIndexes): string {
  return `${base.replace(/\/+$/, '')}/?v=${PROTOCOL_VERSION}&name=${name.join('.')}`;
}

/** Text the service answers without waking the city (use for a lone player's connection check). */
export const PING_TEXT = 'ping';
export const PONG_TEXT = 'pong';

// ---- binary frames ----

export const Frame = {
  /** Any player, 1 byte. Says "I am alive" and nothing else; not relayed. */
  Keepalive: 0,
  /** Any player, SEND_HZ. Own character or car. Relayed to everyone else. */
  State: 1,
  /** Host only. Shared world (traffic, pedestrians, police...). Relayed to everyone else. */
  World: 2,
  /** Any player, rare. Horn, wave, canned shout (numbers only). Relayed to everyone else. */
  Event: 3,
  /** Any player. A request to the host ("I hit car 12"). Delivered to the host only. */
  ToHost: 4,
  /** Host only. Byte 1 = target player id. Delivered to that player only (join snapshot), byte 1 becomes the host's id. */
  ToPlayer: 5,
} as const;
export type FrameKind = (typeof Frame)[keyof typeof Frame];

/** Every binary frame except Keepalive starts with [kind, playerId]. */
export const FRAME_HEADER_BYTES = 2;

export function frameKind(buf: ArrayBuffer): number {
  return buf.byteLength > 0 ? new Uint8Array(buf, 0, 1)[0] : -1;
}
/** The sender's id, as stamped by the service (0 on frames that have not been through it). */
export function frameSender(buf: ArrayBuffer): number {
  return buf.byteLength > 1 ? new Uint8Array(buf, 1, 1)[0] : 0;
}
/** A frame of `kind` with room for `payloadBytes` after the header. */
export function makeFrame(kind: FrameKind, payloadBytes: number, target = 0): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payloadBytes);
  const u8 = new Uint8Array(buf);
  u8[0] = kind;
  u8[1] = target;
  return buf;
}
export const KEEPALIVE_FRAME: Uint8Array = new Uint8Array([Frame.Keepalive]);

// Player state: 26 bytes. The service does not read it, so the layout may change with
// PROTOCOL_VERSION without touching the service.
//   0 kind  1 id  2 t u16 (clock ms, low 16 bits)  4 x f32  8 y f32  12 z f32  16 yaw u16
//   18 vx i16 (cm/s)  20 vz i16 (cm/s)  22 mode u8  23 flags u8  24 vehicle u16
export const PLAYER_STATE_BYTES = 26;

export const PlayerMode = { OnFoot: 0, Swimming: 1, Driving: 2, Passenger: 3, Down: 4 } as const;

export interface PlayerState {
  /** Sender id (filled in by decode; ignored by encode). */
  id: number;
  /** Sender's shared clock in ms, low 16 bits; for ordering and smoothing. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** Radians, any range. */
  yaw: number;
  /** Metres per second, clamped to about +-327. */
  vx: number;
  vz: number;
  mode: number;
  /** Free bits for the client (running, crouching, lights on, siren...). */
  flags: number;
  /** Vehicle model index + 1 when driving, else 0. */
  vehicle: number;
}

const TAU = Math.PI * 2;
function clampI16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
}

/** Writes into `out` if given (reuse one buffer per client to avoid garbage). */
export function encodePlayerState(s: PlayerState, out?: ArrayBuffer): ArrayBuffer {
  const buf = out ?? new ArrayBuffer(PLAYER_STATE_BYTES);
  const d = new DataView(buf);
  d.setUint8(0, Frame.State);
  d.setUint8(1, 0);
  d.setUint16(2, s.t & 0xffff, true);
  d.setFloat32(4, s.x, true);
  d.setFloat32(8, s.y, true);
  d.setFloat32(12, s.z, true);
  const turn = (((s.yaw % TAU) + TAU) % TAU) / TAU;
  d.setUint16(16, Math.round(turn * 65535) & 0xffff, true);
  d.setInt16(18, clampI16(s.vx * 100), true);
  d.setInt16(20, clampI16(s.vz * 100), true);
  d.setUint8(22, s.mode & 0xff);
  d.setUint8(23, s.flags & 0xff);
  d.setUint16(24, s.vehicle & 0xffff, true);
  return buf;
}

/** Null when the frame is not a well formed player state. Fills `out` if given. */
export function decodePlayerState(buf: ArrayBuffer, out?: PlayerState): PlayerState | null {
  if (buf.byteLength < PLAYER_STATE_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.State) return null;
  const s: PlayerState = out ?? { id: 0, t: 0, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, mode: 0, flags: 0, vehicle: 0 };
  s.id = d.getUint8(1);
  s.t = d.getUint16(2, true);
  s.x = d.getFloat32(4, true);
  s.y = d.getFloat32(8, true);
  s.z = d.getFloat32(12, true);
  s.yaw = (d.getUint16(16, true) / 65535) * TAU;
  s.vx = d.getInt16(18, true) / 100;
  s.vz = d.getInt16(20, true) / 100;
  s.mode = d.getUint8(22);
  s.flags = d.getUint8(23);
  s.vehicle = d.getUint16(24, true);
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return null;
  return s;
}

// Player event: 4 bytes. [kind, id, code, arg]
export const PLAYER_EVENT_BYTES = 4;
export const PlayerEvent = { Horn: 1, Wave: 2, Shout: 3 } as const;

export function encodePlayerEvent(code: number, arg = 0): ArrayBuffer {
  const buf = makeFrame(Frame.Event, 2);
  const u8 = new Uint8Array(buf);
  u8[2] = code & 0xff;
  u8[3] = arg & 0xff;
  return buf;
}
export function decodePlayerEvent(buf: ArrayBuffer): { id: number; code: number; arg: number; } | null {
  if (buf.byteLength < PLAYER_EVENT_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.Event) return null;
  return { id: u8[1], code: u8[2], arg: u8[3] };
}

// ---- JSON control messages ----

/** 2 or 3 indexes into the client's word lists. */
export type NameIndexes = number[];
/** A durable fact: a number, or a short list of numbers. Never text. */
export type FactValue = number | number[];
/** [id, ...name indexes] */
export type PlayerEntry = number[];

// client to service
export interface NameMsg { t: 'name'; name: NameIndexes; }
export interface PerfMsg { t: 'perf'; ms: number; }
/** Host only; ignored from anyone else. */
export interface FactMsg { t: 'fact'; k: string; v: FactValue; }
export type ClientMsg = NameMsg | PerfMsg | FactMsg;

// service to client
export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  /** Your id for this session (1..255). */
  id: number;
  /** Which copy of the city (1 unless the first is full). */
  city: number;
  /** Current host id (your own id if you are it). */
  host: number;
  /** Everyone present, including you. */
  players: PlayerEntry[];
  facts: Record<string, FactValue>;
  /** Service wall clock, ms since 1970, for clock agreement. */
  now: number;
}
export interface JoinMsg { t: 'join'; id: number; name: NameIndexes; }
export interface LeaveMsg { t: 'leave'; id: number; }
export interface RenameMsg { t: 'name'; id: number; name: NameIndexes; }
export interface HostMsg { t: 'host'; id: number; }
export interface FactEchoMsg { t: 'fact'; k: string; v: FactValue; }
export type ServerMsg = WelcomeMsg | JoinMsg | LeaveMsg | RenameMsg | HostMsg | FactEchoMsg;

// ---- validation (used by the service on everything a client sends; total, never throws) ----

export function isValidName(v: unknown): v is NameIndexes {
  if (!Array.isArray(v) || v.length < NAME_PARTS_MIN || v.length > NAME_PARTS_MAX) return false;
  for (let i = 0; i < v.length; i++) {
    const n: unknown = v[i];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > NAME_INDEX_MAX) return false;
  }
  return true;
}

export function isValidFactKey(k: unknown): k is string {
  return typeof k === 'string' && FACT_KEY_PATTERN.test(k);
}

export function isValidFactValue(v: unknown): v is FactValue {
  if (typeof v === 'number') return Number.isFinite(v);
  if (!Array.isArray(v) || v.length > FACT_MAX_NUMBERS) return false;
  for (let i = 0; i < v.length; i++) {
    const n: unknown = v[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

/** Parses and validates a client control message. Null for anything malformed. */
export function parseClientMsg(text: string): ClientMsg | null {
  if (text.length > MAX_TEXT_CHARS) return null;
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'name':
      return isValidName(o.name) ? { t: 'name', name: o.name.slice() } : null;
    case 'perf':
      return typeof o.ms === 'number' && Number.isFinite(o.ms) && o.ms > 0
        ? { t: 'perf', ms: Math.min(Math.round(o.ms * 10) / 10, 60000) }
        : null;
    case 'fact':
      return isValidFactKey(o.k) && isValidFactValue(o.v)
        ? { t: 'fact', k: o.k, v: typeof o.v === 'number' ? o.v : o.v.slice() }
        : null;
    default:
      return null;
  }
}

/** Parses a service message on the client. The service is trusted, so this only guards JSON. */
export function parseServerMsg(text: string): ServerMsg | null {
  try {
    const m = JSON.parse(text) as ServerMsg;
    return typeof m === 'object' && m !== null && typeof m.t === 'string' ? m : null;
  } catch {
    return null;
  }
}

export function encodeMsg(m: ClientMsg | ServerMsg): string {
  return JSON.stringify(m);
}

/** True for the origins allowed to connect: the live site, and any localhost or 127.0.0.1 port. */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (origin === 'https://gta.doofus.live') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}
