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

// ---- ToHost frames (any guest; the service hands them to the host unread) ----
//
// Byte 2 says what the frame asks. Stage 2, step 2 has one: "my car has just struck your car N". Step 3 adds three
// (below, "Taking and leaving cars"); a host of an older page of this version ignores a kind it does not know.
export const ToHostKind = { CarHit: 1, ParkHit: 2, Take: 3, Leave: 4, PedKnock: 5, PedHurt: 6, Bang: 7 } as const;
// CarHit, 10 bytes: 0 kind (Frame.ToHost)  1 id  2 ToHostKind.CarHit  3 car u8 (its number in the World frames)
//   4 vx i16  6 vz i16 (cm/s: how fast the two closed, pointing from the striker into the car)
//   8 rx i8  9 rz i8 (the point of contact from the car's middle, 5 cm steps)
// The guest's own screen has already stopped its car against the shown one; this is what lets the host shove and
// dent the real one. Sent at most CAR_HIT_HZ times a second, and only while touching.
export const CAR_HIT_BYTES = 10;
export const CAR_HIT_HZ = 10;
export interface CarHit { id: number; car: number; vx: number; vz: number; rx: number; rz: number }

export function encodeCarHit(car: number, vx: number, vz: number, rx: number, rz: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, CAR_HIT_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.CarHit);
  d.setUint8(3, car & 0xff);
  d.setInt16(4, clampI16(vx * 100), true);
  d.setInt16(6, clampI16(vz * 100), true);
  d.setInt8(8, clampI8(rx * 20));
  d.setInt8(9, clampI8(rz * 20));
  return buf;
}
export function decodeCarHit(buf: ArrayBuffer): CarHit | null {
  if (buf.byteLength < CAR_HIT_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.CarHit) return null;
  return { id: d.getUint8(1), car: d.getUint8(3), vx: d.getInt16(4, true) / 100, vz: d.getInt16(6, true) / 100, rx: d.getInt8(8) / 20, rz: d.getInt8(9) / 20 };
}

// ---- Taking and leaving cars (stage 2, step 3) ----
//
// A town's cars are numbered two ways. A car in the World traffic frames (driven, or left standing) has a u8 there.
// A parked car that nobody has touched is not on the wire at all: every browser parks the same cars in the same
// places from the map, and its number is its place in that list (a u16, CarClass.Parked).
export const CarClass = { Traffic: 0, Parked: 1 } as const;

// ParkHit, 11 bytes: as CarHit, for a parked car nobody has touched yet.
//   0 kind (Frame.ToHost)  1 id  2 ToHostKind.ParkHit  3 place u16  5 vx i16  7 vz i16  9 rx i8  10 rz i8
export const PARK_HIT_BYTES = 11;
export function encodeParkHit(place: number, vx: number, vz: number, rx: number, rz: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, PARK_HIT_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.ParkHit);
  d.setUint16(3, place & 0xffff, true);
  d.setInt16(5, clampI16(vx * 100), true);
  d.setInt16(7, clampI16(vz * 100), true);
  d.setInt8(9, clampI8(rx * 20));
  d.setInt8(10, clampI8(rz * 20));
  return buf;
}
export function decodeParkHit(buf: ArrayBuffer): CarHit | null {
  if (buf.byteLength < PARK_HIT_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.ParkHit) return null;
  return { id: d.getUint8(1), car: d.getUint16(3, true), vx: d.getInt16(5, true) / 100, vz: d.getInt16(7, true) / 100, rx: d.getInt8(9) / 20, rz: d.getInt8(10) / 20 };
}

// Take, 6 bytes: "I am at the door of this car and want to drive it".
//   0 kind (Frame.ToHost)  1 id  2 ToHostKind.Take  3 CarClass  4 car u16
// The host answers that player alone with a Grant, yes or no. On yes the car is gone from the host's streets and is
// the asker's own from then on, seen by the others through the asker's State frames.
export const TAKE_BYTES = 6;
export interface CarAsk { id: number; cls: number; car: number }
export function encodeTake(cls: number, car: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, TAKE_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Take);
  d.setUint8(3, cls & 0xff);
  d.setUint16(4, car & 0xffff, true);
  return buf;
}
export function decodeTake(buf: ArrayBuffer): CarAsk | null {
  if (buf.byteLength < TAKE_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Take) return null;
  return { id: d.getUint8(1), cls: d.getUint8(3), car: d.getUint16(4, true) };
}

// Leave, 20 bytes: "I have got out of my car; it is yours to show the town now".
//   0 kind (Frame.ToHost)  1 id  2 ToHostKind.Leave  3 token u8 (the asker's own count, echoed in the answer)
//   4.. one traffic record (TRAFFIC_CAR_BYTES, its id byte unused)  19 health u8 (0..200 = 0..100)
// The host puts a standing car there, gives it a number and answers with Left.
export const LEAVE_BYTES = 20;
export interface CarLeft { id: number; token: number; car: TrafficCar; health: number }

// ---- ToPlayer frames (the host to one player; the service lets nobody else send them) ----
export const ToPlayerKind = { Grant: 1, Left: 2 } as const;
// Grant, 8 bytes: 0 kind (Frame.ToPlayer)  1 id (the host's)  2 ToPlayerKind.Grant  3 CarClass  4 car u16
//   6 ok u8 (0 = somebody else has it, or it has gone)  7 health u8 (0..200)
export const GRANT_BYTES = 8;
export interface CarGrant { from: number; cls: number; car: number; ok: boolean; health: number }
export function encodeGrant(to: number, cls: number, car: number, ok: boolean, health: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToPlayer, GRANT_BYTES - FRAME_HEADER_BYTES, to);
  const d = new DataView(buf);
  d.setUint8(2, ToPlayerKind.Grant);
  d.setUint8(3, cls & 0xff);
  d.setUint16(4, car & 0xffff, true);
  d.setUint8(6, ok ? 1 : 0);
  d.setUint8(7, healthByte(health));
  return buf;
}
export function decodeGrant(buf: ArrayBuffer): CarGrant | null {
  if (buf.byteLength < GRANT_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToPlayer || d.getUint8(2) !== ToPlayerKind.Grant) return null;
  return { from: d.getUint8(1), cls: d.getUint8(3), car: d.getUint16(4, true), ok: d.getUint8(6) === 1, health: d.getUint8(7) / 2 };
}
// Left, 5 bytes: 0 kind (Frame.ToPlayer)  1 id (the host's)  2 ToPlayerKind.Left  3 token  4 the car's number in the
//   traffic frames from now on (0 = there was no number to give: it stays a private car on the asker's screen)
export const LEFT_BYTES = 5;
export function encodeLeft(to: number, token: number, car: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToPlayer, LEFT_BYTES - FRAME_HEADER_BYTES, to);
  const u8 = new Uint8Array(buf);
  u8[2] = ToPlayerKind.Left; u8[3] = token & 0xff; u8[4] = car & 0xff;
  return buf;
}
export function decodeLeft(buf: ArrayBuffer): { from: number; token: number; car: number } | null {
  if (buf.byteLength < LEFT_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.ToPlayer || u8[2] !== ToPlayerKind.Left) return null;
  return { from: u8[1], token: u8[3], car: u8[4] };
}
function healthByte(h: number): number {
  const v = Math.round(h * 2);
  return v > 200 ? 200 : v > 0 ? v : 0;
}

// ---- World frames (host only; the service relays them unread) ----
//
// Byte 2 says what the frame carries, so later steps can add streams (people, police) beside these.
export const WorldKind = { Traffic: 1, Parked: 2, People: 3 } as const;

// Parked (stage 2, step 3): which of the town's parked cars are no longer in their places. Sent only when one
// changes, whole when somebody arrives, and whole again every PARKED_REFRESH_MS in case anything was missed.
//   0 kind (Frame.World)  1 id  2 WorldKind.Parked  3 n u8
//   4.. n changes of 3 bytes: place u16, then the number the car now has in the traffic frames (it was pushed or
//       dented, and is one of the host's standing cars now) or 0 (taken, sunk, towed: simply gone from its place)
//   then, in a whole frame, one bit per place to the end of the frame: 1 = not in its place
export const PARKED_HEADER_BYTES = 4;
export const PARKED_CHANGE_BYTES = 3;
export const PARKED_MAX_CHANGES = 255;
export const PARKED_REFRESH_MS = 20000;
/** The share of kerb places that hold a car in a shared town, whatever each browser's own quality setting. */
export const PARKED_TOWN_SHARE = 0.55;

// Traffic: every car with an imaginary driver, as the host simulates it. One frame is the WHOLE list:
//   0 kind (Frame.World)  1 id  2 WorldKind.Traffic  3 t u16 (the host's TOWN clock ms, low 16 bits: the clock its
//     traffic signals run on, so a guest's lamps can show what the host's drivers obey; see shared.ts)  5 n u8
//   6.. n records of TRAFFIC_CAR_BYTES, for the cars that have moved or changed since they were last sent
//   then one byte each: the ids of the cars that are still exactly where their last record put them
// A car in neither part is gone. A record:
//   0 id u8 (1..255, the same for the car's whole life)  1 kind (low 4 bits) | paint (high 4 bits)
//   2 x u16  4 z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)  6 y i16 (cm)  8 yaw u16
//   10 speed i8 (1/4 m/s along the nose)  11 steer i8  12 pitch i8  13 roll i8 (1/200 rad)
//   14 flags (low 4 bits, TrafficFlag) | damage (high 4 bits: 0 = showroom .. 15 = finished; stage 2, step 2)
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
/** Bits of TrafficCar.flags. Driverless: left standing by a driver who got out. The high 4 bits are the damage. */
export const TrafficFlag = { Braking: 1, Reversing: 2, Horn: 4, Driverless: 8 } as const;
export const TRAFFIC_DAMAGE_SHIFT = 4;
/** Health (100 = showroom) to the 16 steps on the wire: any dent at all is at least one step. */
export function damageStep(health: number): number {
  const s = Math.ceil((100 - health) * 0.15 - 1e-6);
  return s > 15 ? 15 : s > 0 ? s : 0;
}

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
  for (let i = 0; i < nFull; i++, o += TRAFFIC_CAR_BYTES) putCar(d, o, cars[i]);
  for (let i = 0; i < nStill; i++) d.setUint8(o++, still[i] & 0xff);
  return o;
}
function putCar(d: DataView, o: number, c: TrafficCar): void {
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
function getCar(d: DataView, o: number, c: TrafficCar): void {
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

export function encodeLeave(token: number, car: TrafficCar, health: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, LEAVE_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Leave);
  d.setUint8(3, token & 0xff);
  putCar(d, 4, car);
  d.setUint8(19, healthByte(health));
  return buf;
}
export function decodeLeave(buf: ArrayBuffer): CarLeft | null {
  if (buf.byteLength < LEAVE_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Leave) return null;
  const car = blankTrafficCar();
  getCar(d, 4, car);
  return { id: d.getUint8(1), token: d.getUint8(3), car, health: d.getUint8(19) / 2 };
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
    getCar(d, o, out.cars[i] ?? (out.cars[i] = blankTrafficCar()));
  }
  const ns = Math.min(len - o, TRAFFIC_MAX_CARS);
  out.nStill = ns;
  for (let i = 0; i < ns; i++) out.still[i] = d.getUint8(o + i);
  return true;
}

// ---- The same people on the street (stage 3, step 1) ----
//
// The host's pedestrians, in World frames of their own (WorldKind.People). The version stays at 4: the service relays
// World and ToHost frames unread, an older page ignores a kind it does not know (as a guest it keeps its private
// crowd, exactly as before), and a newer guest whose host is an older page hears no people frames and so keeps its
// private crowd too.
//   0 kind (Frame.World)  1 id  2 WorldKind.People  3 flags u8 (1 = whole: anybody not in this frame has gone)  4 n u8
//   5.. n records of PED_BYTES
// A record is sent only when the person is no longer where the last one says they would be by now (walking on the
// way they faced at the speed they had), or looks different; a whole frame goes every PEOPLE_WHOLE_MS and when
// somebody arrives. So a person standing still, or walking straight down a pavement, costs almost nothing.
//   0 id u8 (1..255, the same for the person's whole life; the LOOK is made from it, see net/people.ts)
//   1 x u16  3 z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0; the height is the ground's)
//   5 heading u8 (1/256 turn: the way they move, or face when still)  6 speed u8 (1/32 m/s)
//   7 pose (low 3 bits, index into PED_POSES; PED_GONE = left the street) | PedFlag.Bench | PedFlag.Hard | health (high 3 bits, 0 = none .. 7 = full)
export const PEOPLE_HZ = 10;
export const PEOPLE_WHOLE_MS = 3000;
export const PEOPLE_HEADER_BYTES = 5;
export const PED_BYTES = 8;
export const PEOPLE_MAX = 96;
export const PED_POSES = ['stand', 'walk', 'run', 'down', 'sit'] as const;
export const PED_GONE = 7;
/** Bench: sitting on a bench. Hard: down and not getting up. */
export const PedFlag = { Bench: 8, Hard: 16 } as const;
export const PED_HEALTH_SHIFT = 5;
export interface PedRec { id: number; x: number; z: number; h: number; speed: number; flags: number }
export function blankPed(): PedRec { return { id: 0, x: 0, z: 0, h: 0, speed: 0, flags: 0 }; }
/** Health (0..100) as the 3 bits on the wire: 0 only when there is none left. */
export function pedHealthBits(health: number): number {
  const s = Math.ceil(health * 0.07 - 1e-6);
  return s > 7 ? 7 : s > 0 ? s : 0;
}
/** Round a record to what the wire carries, in place (the host predicts from exactly what the guests were told). */
export function quantPed(r: PedRec): void {
  r.x = clampU16((r.x - TRAFFIC_X0) / TRAFFIC_STEP) * TRAFFIC_STEP + TRAFFIC_X0;
  r.z = clampU16((r.z - TRAFFIC_Z0) / TRAFFIC_STEP) * TRAFFIC_STEP + TRAFFIC_Z0;
  r.h = ((Math.round((((r.h % TAU) + TAU) % TAU) / TAU * 256) & 255) / 256) * TAU;
  const sp = Math.round(r.speed * 32);
  r.speed = (sp > 255 ? 255 : sp > 0 ? sp : 0) / 32;
}
/** `recs` must already be rounded (quantPed). Returns the bytes used. */
export function encodePeople(whole: boolean, recs: readonly PedRec[], n: number, out: Uint8Array): number {
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  d.setUint8(0, Frame.World); d.setUint8(1, 0); d.setUint8(2, WorldKind.People);
  d.setUint8(3, whole ? 1 : 0); d.setUint8(4, n);
  let o = PEOPLE_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += PED_BYTES) {
    const r = recs[i];
    d.setUint8(o, r.id & 0xff);
    d.setUint16(o + 1, clampU16((r.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 3, clampU16((r.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setUint8(o + 5, Math.round((((r.h % TAU) + TAU) % TAU) / TAU * 256) & 255);
    const sp = Math.round(r.speed * 32);
    d.setUint8(o + 6, sp > 255 ? 255 : sp > 0 ? sp : 0);
    d.setUint8(o + 7, r.flags & 0xff);
  }
  return o;
}
export interface PeopleFrame { whole: boolean; n: number; recs: PedRec[] }
export function decodePeople(buf: ArrayBuffer, out: PeopleFrame): boolean {
  const len = buf.byteLength;
  if (len < PEOPLE_HEADER_BYTES) return false;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.World || d.getUint8(2) !== WorldKind.People) return false;
  const n = d.getUint8(4);
  if (n > PEOPLE_MAX || PEOPLE_HEADER_BYTES + n * PED_BYTES > len) return false;
  out.whole = (d.getUint8(3) & 1) !== 0;
  out.n = n;
  let o = PEOPLE_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += PED_BYTES) {
    const r = out.recs[i] ?? (out.recs[i] = blankPed());
    r.id = d.getUint8(o);
    r.x = d.getUint16(o + 1, true) * TRAFFIC_STEP + TRAFFIC_X0;
    r.z = d.getUint16(o + 3, true) * TRAFFIC_STEP + TRAFFIC_Z0;
    r.h = (d.getUint8(o + 5) / 256) * TAU;
    r.speed = d.getUint8(o + 6) / 32;
    r.flags = d.getUint8(o + 7);
  }
  return true;
}

// What a guest does to one of the host's people, told to the host (ToHost), which applies it for everybody.
// PedKnock, 8 bytes: "my car has just run into person N".  0 kind  1 id  2 ToHostKind.PedKnock  3 person u8  4 vx i16  6 vz i16 (the car's velocity, cm/s)
// PedHurt, 8 bytes: "I have punched or shot person N".  0 kind  1 id  2 ToHostKind.PedHurt  3 person u8  4 damage u8
//   5 heading u8 (the way the blow travelled)  6 flags u8 (1 = a fist)  7 shove u8 (tenths)
// Bang, 8 bytes: "a shot, a blast or a crash here: people within r meters run".  0 kind  1 id  2 ToHostKind.Bang  3 x u16  5 z u16  7 r u8
export const PED_ASK_BYTES = 8;
export const BANG_HZ = 2;
export interface PedKnock { id: number; ped: number; vx: number; vz: number }
export function encodePedKnock(ped: number, vx: number, vz: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, PED_ASK_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.PedKnock); d.setUint8(3, ped & 0xff);
  d.setInt16(4, clampI16(vx * 100), true); d.setInt16(6, clampI16(vz * 100), true);
  return buf;
}
export function decodePedKnock(buf: ArrayBuffer): PedKnock | null {
  if (buf.byteLength < PED_ASK_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.PedKnock) return null;
  return { id: d.getUint8(1), ped: d.getUint8(3), vx: d.getInt16(4, true) / 100, vz: d.getInt16(6, true) / 100 };
}
export interface PedHurt { id: number; ped: number; damage: number; h: number; fist: boolean; shove: number }
export function encodePedHurt(ped: number, damage: number, h: number, fist: boolean, shove: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, PED_ASK_BYTES - FRAME_HEADER_BYTES);
  const u8 = new Uint8Array(buf);
  u8[2] = ToHostKind.PedHurt; u8[3] = ped & 0xff;
  u8[4] = Math.max(0, Math.min(255, Math.round(damage)));
  u8[5] = Math.round((((h % TAU) + TAU) % TAU) / TAU * 256) & 255;
  u8[6] = fist ? 1 : 0;
  u8[7] = Math.max(0, Math.min(255, Math.round(shove * 10)));
  return buf;
}
export function decodePedHurt(buf: ArrayBuffer): PedHurt | null {
  if (buf.byteLength < PED_ASK_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.ToHost || u8[2] !== ToHostKind.PedHurt) return null;
  return { id: u8[1], ped: u8[3], damage: u8[4], h: (u8[5] / 256) * TAU, fist: (u8[6] & 1) !== 0, shove: u8[7] / 10 };
}
export interface Bang { id: number; x: number; z: number; r: number }
export function encodeBang(x: number, z: number, r: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, PED_ASK_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Bang);
  d.setUint16(3, clampU16((x - TRAFFIC_X0) / TRAFFIC_STEP), true);
  d.setUint16(5, clampU16((z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
  d.setUint8(7, Math.max(0, Math.min(255, Math.round(r))));
  return buf;
}
export function decodeBang(buf: ArrayBuffer): Bang | null {
  if (buf.byteLength < PED_ASK_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Bang) return null;
  return { id: d.getUint8(1), x: d.getUint16(3, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(5, true) * TRAFFIC_STEP + TRAFFIC_Z0, r: d.getUint8(7) };
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
