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

// Version 4 (stage 2, step 1): the host sends Frame.World with the town's moving traffic (see "World frames" below),
// and every other browser draws those cars INSTEAD of running its own. A page that does not know this would, as
// host, leave everybody else's streets empty, so the number went up: an older page is refused by a newer service
// (and a newer page by an older service), and a refused page is simply the single player game.
export const PROTOCOL_VERSION = 4;

// ---- limits and rates (the service enforces the limits; the client should respect the rates) ----

/**
 * Seats in town, in total (owner, Nov 21 2026). There is ONE city and no second copy: player 9 is told `full`,
 * plays alone, and asks again every FULL_RETRY_S or so.
 */
export const CITY_CAP = 8;
/** The retry hint sent with `full`, in seconds. The client adds a random spread and never asks sooner. */
export const FULL_RETRY_S = 180;
/** After `rest`, a client waits until the resume time plus a random part of this, so everybody does not return in the same second. */
export const REST_SPREAD_MS = 5 * 60 * 1000;
/** Player state sends per second. */
export const SEND_HZ = 10;
/** Largest Frame.State / Frame.Event / Frame.ToHost / Frame.Keepalive, in bytes. */
export const MAX_PLAYER_FRAME_BYTES = 96;
/** Largest Frame.World / Frame.ToPlayer (host only), in bytes. */
export const MAX_HOST_FRAME_BYTES = 4096;
/** Largest JSON control message, in characters. */
export const MAX_TEXT_CHARS = 256;
/** World frames per second, at most (the host only, and only on the MAIN service: the backup's messages are billed). */
export const WORLD_HZ = 10;
/** Sustained messages per second allowed per connection, and the burst allowed on top. */
export const RATE_PER_SECOND = 40;
export const RATE_BURST = 80;
/**
 * A name is 2 or 3 indexes into the client's fixed word lists (src/net/names.ts): part i is 0..NAME_LIST_SIZES[i]-1.
 * names.ts will not compile if these stop matching the lists.
 */
export const NAME_PARTS_MIN = 2;
export const NAME_PARTS_MAX = 3;
export const NAME_LIST_SIZES = [40, 40, 24] as const;

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
  /** Sent after `full`: every seat is taken. Ask again later. */
  Full: 4008,
  /** Sent after `rest`: the service has paused itself until the time it gave. Do not ask again before then. */
  Rest: 4009,
  /** Sent after `main` (the backup only): the main service is alive, go there instead. */
  Main: 4010,
} as const;

/** HTTP status the Worker answers instead of an upgrade (a browser only sees "could not connect"). */
export const HTTP_BAD_ORIGIN = 403;
export const HTTP_BAD_HELLO = 400;
// A full town and a resting service are NOT HTTP refusals (a browser cannot read those): the socket opens, carries
// one `full` or `rest` message, and closes with Close.Full or Close.Rest. The backup's "go to main" is the same
// pattern: one `main` message, then Close.Main.

/**
 * The hello is the URL itself, so a socket never exists without a valid name:
 *   new WebSocket(cityUrl('wss://port-calamity-city.<account>.workers.dev', [3, 17, 20]))
 * The first message back is the Welcome.
 * `triedMain`: said to the BACKUP by a browser that has already tried the main service in this round and could not
 * reach it (or was already sent there once). The backup then seats it instead of sending it to main again.
 */
export function cityUrl(base: string, name: NameIndexes, triedMain = false): string {
  return `${base.replace(/\/+$/, '')}/?v=${PROTOCOL_VERSION}&name=${name.join('.')}${triedMain ? `&${TRIED_MAIN_PARAM}=1` : ''}`;
}
/** The query parameter for "I tried main and it did not answer". Services that do not know it ignore it. */
export const TRIED_MAIN_PARAM = 'nm';

// ---- where the service lives ----

/**
 * The host name of the BACKUP service (the Cloudflare Worker), for example
 * 'port-calamity-city.<account>.workers.dev'. EMPTY until it is deployed: then the game connects to
 * nothing (single player, as before) and the home computer registers nowhere.
 * The game reaches the backup at wss://<this>/ and asks it where the main service is at
 * https://<this>/main; the home computer registers its address at the same place.
 */
export const BACKUP_HOST: string = 'port-calamity-city.patricksimpson-fx.workers.dev';
/** The Worker's "where is main" path: GET answers {u: address or null}; POST is the home computer's signed registration. */
export const MAIN_PATH = '/main';

/** The only shape a main address may have: a free Cloudflare quick tunnel, https, nothing after the host. */
export function isMainAddress(u: unknown): u is string {
  return typeof u === 'string' && u.length <= 90 && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(u);
}

/** A connection check: the service answers PONG_TEXT. It counts as a message like any other. */
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

// Player state: 34 bytes. The service does not read it, so the layout may change with
// PROTOCOL_VERSION without touching the service.
//   0 kind  1 id  2 t u16 (sender's clock ms, low 16 bits)  4 x f32  8 y f32  12 z f32  16 yaw u16
//   18 vx i16 (cm/s)  20 vz i16 (cm/s)  22 mode u8  23 flags u8  24 vehicle u8  25 steer i8
//   26 pitch i16  28 roll i16 (1/10000 rad)  30 colour u24  33 pose u8
export const PLAYER_STATE_BYTES = 34;

export const PlayerMode = { OnFoot: 0, Swimming: 1, Driving: 2, Passenger: 3, Down: 4 } as const;
/** Bits of PlayerState.flags. */
export const PlayerFlag = { Braking: 1, Reversing: 2, Horn: 4, Bench: 8 } as const;
/** PlayerState.pose is an index into this (the game's own Pose names, in a fixed order). */
export const POSES = ['stand', 'walk', 'run', 'jump', 'fall', 'swim', 'down', 'sit'] as const;

export interface PlayerState {
  /** Sender id (filled in by decode; ignored by encode). */
  id: number;
  /** Sender's own clock in ms, low 16 bits; for ordering and smoothing. */
  t: number;
  /** On foot: the feet. Driving: the middle of the car at road level. */
  x: number;
  y: number;
  z: number;
  /** Radians, any range. */
  yaw: number;
  /** Metres per second, clamped to about +-327. */
  vx: number;
  vz: number;
  mode: number;
  /** PlayerFlag bits. */
  flags: number;
  /** Vehicle kind index + 1 when driving, else 0. */
  vehicle: number;
  /** Driving: steering input, -1 full left .. +1 full right. */
  steer: number;
  /** Driving: the car's pitch and roll, radians (about +-3.2). */
  pitch: number;
  roll: number;
  /** Driving: paint, 0xRRGGBB. */
  color: number;
  /** Index into POSES. */
  pose: number;
}

export function blankPlayerState(): PlayerState {
  return { id: 0, t: 0, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, mode: 0, flags: 0, vehicle: 0, steer: 0, pitch: 0, roll: 0, color: 0, pose: 0 };
}

const TAU = Math.PI * 2;
function clampI16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v) || 0;
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
  d.setUint8(24, s.vehicle & 0xff);
  const st = Math.round((s.steer || 0) * 127);
  d.setInt8(25, st > 127 ? 127 : st < -127 ? -127 : st);
  d.setInt16(26, clampI16(s.pitch * 10000), true);
  d.setInt16(28, clampI16(s.roll * 10000), true);
  const c = s.color >>> 0;
  d.setUint8(30, (c >> 16) & 0xff);
  d.setUint8(31, (c >> 8) & 0xff);
  d.setUint8(32, c & 0xff);
  d.setUint8(33, s.pose & 0xff);
  return buf;
}

/** Null when the frame is not a well formed player state. Fills `out` if given. */
export function decodePlayerState(buf: ArrayBuffer, out?: PlayerState): PlayerState | null {
  if (buf.byteLength < PLAYER_STATE_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.State) return null;
  const s: PlayerState = out ?? blankPlayerState();
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
  s.vehicle = d.getUint8(24);
  s.steer = d.getInt8(25) / 127;
  s.pitch = d.getInt16(26, true) / 10000;
  s.roll = d.getInt16(28, true) / 10000;
  s.color = (d.getUint8(30) << 16) | (d.getUint8(31) << 8) | d.getUint8(32);
  s.pose = d.getUint8(33);
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

// ---- World frames (host only; the service relays them unread) ----
//
// Byte 2 says what the frame carries, so later steps can add streams (parked cars, people, police) beside this one.
export const WorldKind = { Traffic: 1 } as const;

// Traffic: every car with an imaginary driver, as the host simulates it. One frame is the WHOLE list:
//   0 kind (Frame.World)  1 id  2 WorldKind.Traffic  3 t u16 (host's clock ms, low 16 bits)  5 n u8
//   6.. n records of TRAFFIC_CAR_BYTES, for the cars that have moved or changed since they were last sent
//   then one byte each: the ids of the cars that are still exactly where their last record put them
// A car in neither part is gone. A record:
//   0 id u8 (1..255, the same for the car's whole life)  1 kind (low 4 bits) | paint (high 4 bits)
//   2 x u16  4 z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)  6 y i16 (cm)  8 yaw u16
//   10 speed i8 (1/4 m/s along the nose)  11 steer i8  12 pitch i8  13 roll i8 (1/200 rad)  14 flags u8
// kind is an index into the game's vehicle roster and paint an index into that kind's colours: both are the
// client's own tables, which every page of one protocol version shares.
export const TRAFFIC_HEADER_BYTES = 6;
export const TRAFFIC_CAR_BYTES = 15;
/** The most cars one frame may carry (it must fit MAX_HOST_FRAME_BYTES with room to spare). */
export const TRAFFIC_MAX_CARS = 96;
/** The corner positions are measured from, and the size of a step: the whole map with both lands fits in 16 bits. */
export const TRAFFIC_X0 = -1640;
export const TRAFFIC_Z0 = -2400;
export const TRAFFIC_STEP = 0.05;
/** Bits of TrafficCar.flags. Driverless: left standing by a driver who got out. */
export const TrafficFlag = { Braking: 1, Reversing: 2, Horn: 4, Driverless: 8 } as const;

export interface TrafficCar {
  id: number;
  /** Index into the roster (0..15) and into that kind's colours (0..15). */
  kind: number;
  paint: number;
  /** The middle of the car at road level. */
  x: number; y: number; z: number;
  yaw: number;
  /** Signed, along the nose, m/s (about +-31). */
  speed: number;
  /** -1 full left .. +1 full right. */
  steer: number;
  pitch: number; roll: number;
  flags: number;
}
export function blankTrafficCar(): TrafficCar {
  return { id: 0, kind: 0, paint: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, steer: 0, pitch: 0, roll: 0, flags: 0 };
}
function clampI8(v: number): number {
  return v > 127 ? 127 : v < -127 ? -127 : Math.round(v) || 0;
}
function clampU16(v: number): number {
  return v > 65535 ? 65535 : v < 0 ? 0 : Math.round(v) || 0;
}

/**
 * The first `nFull` of `cars` go in whole; `still` (the first `nStill` of it) are ids only. Writes into `out`, which
 * must hold TRAFFIC_HEADER_BYTES + nFull * TRAFFIC_CAR_BYTES + nStill bytes, and returns the bytes used.
 */
export function encodeTraffic(t: number, cars: readonly TrafficCar[], nFull: number, still: ArrayLike<number>, nStill: number, out: Uint8Array): number {
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  d.setUint8(0, Frame.World);
  d.setUint8(1, 0);
  d.setUint8(2, WorldKind.Traffic);
  d.setUint16(3, t & 0xffff, true);
  d.setUint8(5, nFull);
  let o = TRAFFIC_HEADER_BYTES;
  for (let i = 0; i < nFull; i++, o += TRAFFIC_CAR_BYTES) {
    const c = cars[i];
    d.setUint8(o, c.id & 0xff);
    d.setUint8(o + 1, (c.kind & 15) | ((c.paint & 15) << 4));
    d.setUint16(o + 2, clampU16((c.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 4, clampU16((c.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setInt16(o + 6, clampI16(c.y * 100), true);
    const turn = (((c.yaw % TAU) + TAU) % TAU) / TAU;
    d.setUint16(o + 8, Math.round(turn * 65535) & 0xffff, true);
    d.setInt8(o + 10, clampI8(c.speed * 4));
    d.setInt8(o + 11, clampI8(c.steer * 127));
    d.setInt8(o + 12, clampI8(c.pitch * 200));
    d.setInt8(o + 13, clampI8(c.roll * 200));
    d.setUint8(o + 14, c.flags & 0xff);
  }
  for (let i = 0; i < nStill; i++) d.setUint8(o++, still[i] & 0xff);
  return o;
}

export interface TrafficFrame {
  /** Host's clock, ms, low 16 bits. */
  t: number;
  /** Whole records: the first `n` of `cars` (the rest are spares kept for the next frame). */
  n: number;
  cars: TrafficCar[];
  /** Ids only: the first `nStill` of `still`. */
  nStill: number;
  still: number[];
}
export function blankTrafficFrame(): TrafficFrame {
  return { t: 0, n: 0, cars: [], nStill: 0, still: [] };
}

/** False when the frame is not a well formed traffic frame. Fills `out` (reuse one to avoid garbage). */
export function decodeTraffic(buf: ArrayBuffer, out: TrafficFrame): boolean {
  const len = buf.byteLength;
  if (len < TRAFFIC_HEADER_BYTES) return false;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.World || d.getUint8(2) !== WorldKind.Traffic) return false;
  const n = d.getUint8(5);
  if (n > TRAFFIC_MAX_CARS || TRAFFIC_HEADER_BYTES + n * TRAFFIC_CAR_BYTES > len) return false;
  out.t = d.getUint16(3, true);
  out.n = n;
  let o = TRAFFIC_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += TRAFFIC_CAR_BYTES) {
    const c = out.cars[i] ?? (out.cars[i] = blankTrafficCar());
    c.id = d.getUint8(o);
    const kp = d.getUint8(o + 1);
    c.kind = kp & 15; c.paint = kp >> 4;
    c.x = d.getUint16(o + 2, true) * TRAFFIC_STEP + TRAFFIC_X0;
    c.z = d.getUint16(o + 4, true) * TRAFFIC_STEP + TRAFFIC_Z0;
    c.y = d.getInt16(o + 6, true) / 100;
    c.yaw = (d.getUint16(o + 8, true) / 65535) * TAU;
    c.speed = d.getInt8(o + 10) / 4;
    c.steer = d.getInt8(o + 11) / 127;
    c.pitch = d.getInt8(o + 12) / 200;
    c.roll = d.getInt8(o + 13) / 200;
    c.flags = d.getUint8(o + 14);
  }
  const ns = Math.min(len - o, TRAFFIC_MAX_CARS);
  out.nStill = ns;
  for (let i = 0; i < ns; i++) out.still[i] = d.getUint8(o + i);
  return true;
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
  /** Always 1: there is one city. */
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
/** Instead of a welcome: every seat is taken. `retry` is a hint in seconds; `seats` is the size of the town. */
export interface FullMsg { t: 'full'; retry: number; seats: number; }
/**
 * Instead of a welcome, or to everybody at once: the service has paused itself for the day. `until` is when it
 * resumes and `now` is the service's clock at the time of sending, both in ms since 1970 (UTC), so a browser whose
 * own clock is wrong can still wait the right length of time.
 */
export interface RestMsg { t: 'rest'; until: number; now: number; }
/**
 * Instead of a welcome, from the BACKUP only: the main service is alive at `u` (https, see isMainAddress), so this
 * browser is not seated here; everybody belongs in the one town on main. A browser that cannot reach `u` asks the
 * backup again with TRIED_MAIN_PARAM and is seated. (A game older than this message just sees a lost socket.)
 */
export interface MainMsg { t: 'main'; u: string; }
export type ServerMsg = WelcomeMsg | JoinMsg | LeaveMsg | RenameMsg | HostMsg | FactEchoMsg | FullMsg | RestMsg | MainMsg;

// ---- validation (used by the service on everything a client sends; total, never throws) ----

export function isValidName(v: unknown): v is NameIndexes {
  if (!Array.isArray(v) || v.length < NAME_PARTS_MIN || v.length > NAME_PARTS_MAX) return false;
  for (let i = 0; i < v.length; i++) {
    const n: unknown = v[i];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= NAME_LIST_SIZES[i]) return false;
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
