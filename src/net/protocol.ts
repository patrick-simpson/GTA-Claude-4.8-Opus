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
// Version 5 (Nov 23, riding together: net/ride.ts): a player may sit in another player's car. The passenger's State frame
// says so (mode Passenger, `vehicle` = the driver's id, `color` = the seat) and two small Event frames (Ride, Seats) carry
// the getting in and out. An older page would draw a passenger standing in the road and, as a driver, never let them out,
// so the number went up: the Worker must be redeployed with this file (the home computer updates itself).
export const PROTOCOL_VERSION = 5;

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
 * The same for the host (and the host bot): it alone sends the town (traffic, people, police, fire... each at up to
 * 10 a second) on top of its own state. A busy host sent 44-45 a second before batching (Frame.Bundle); batched it is
 * far under 40, and this allowance is the margin, not the budget.
 */
export const RATE_HOST_PER_SECOND = 120;
export const RATE_HOST_BURST = 240;
/** Largest Frame.Bundle, in bytes (the parts inside keep their own caps). */
export const MAX_BUNDLE_BYTES = 12288;
/** Each part of a bundle costs this much of a token, on top of the one for the bundle itself. */
export const BUNDLE_PART_COST = 0.25;
/**
 * The host bot (the mini PC's dedicated host, server/home/hostbot.ts) says who it is with ?bot=<exp>.<sig>: exp is
 * seconds since 1970 when the pass runs out, sig the base64url Ed25519 signature of hostBotText(exp) by the mini PC's
 * key (server/src/mainkey.ts holds the public half). Only the home service accepts it, and never through the tunnel.
 */
export const BOT_PARAM = 'bot';
/** The longest a bot pass may run, in seconds. */
export const BOT_PASS_MAX_S = 48 * 3600;
export function hostBotText(exp: number): string {
  return `port-calamity hostbot ${exp}`;
}
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
// (What each holds is the game's business, net/town.ts: the service stores and passes numbers.)
/** Game hours (0..24) added to the town's clock. Absent: 0. The clock itself is the service's own, never sent. */
export const FACT_CLOCK = 'clock';
/** [seed, forced weather (0 none, else 1 + its index in TOWN_WEATHERS), the town hour the forcing ends]. Absent: seed 0, nothing forced. */
export const FACT_WEATHER_SEED = 'weather.seed';
/** [spans built, town stages open, points held toward the next]. Main service only. */
export const FACT_BRIDGE = 'bridge';
/** Kid-friendly mode (core/kid.ts): [on 0 or 1, the number in town of whoever flipped it (0 unknown)]. Absent: off. Both services. */
export const FACT_KID = 'kid';
/** The order of the weathers in FACT_WEATHER_SEED. Add at the end only. */
export const TOWN_WEATHERS = ['clear', 'overcast', 'fog', 'rain'] as const;

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
  /** The host bot only: a newer copy of it has connected. */
  Replaced: 4011,
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
  /**
   * Any player, only to a service whose welcome said b: 1. Several frames in one message: after the 2 byte header,
   * repeated [u16 little-endian length][that frame]. The service handles each part as if it came alone (and passes
   * them on one by one, so receivers never see a bundle). Saves the rate allowance and the backup's billed messages.
   */
  Bundle: 6,
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
//   26 pitch i16  28 roll i16 (1/10000 rad)  30 colour u24  33 pose (low 3 bits) | damage (next 4 bits; stage 3, step 4)
// The damage is the car's, in the same 16 steps as a traffic record's (see DAMAGE_BURN below): a pose never needed
// more than 3 bits, so the frame is the same size and a page that does not know the damage reads a pose it does not
// use while the sender is driving.
export const PLAYER_STATE_BYTES = 34;
export const POSE_MASK = 7;
export const STATE_DAMAGE_SHIFT = 3;

export const PlayerMode = { OnFoot: 0, Swimming: 1, Driving: 2, Passenger: 3, Down: 4 } as const;
/**
 * Bits of PlayerState.flags. The three bits from HELD_SHIFT up are the weapon the player has raised (its slot, 0 =
 * nothing up; stage 3, step 3): a page that does not know them never looks at them.
 */
export const PlayerFlag = { Braking: 1, Reversing: 2, Horn: 4, Bench: 8, Paused: 0x80 } as const;
// (Stage 4, step 5: bit 7, Paused, is the player's own pause menu: the others draw a sign over them, and nobody can hurt
// them while it is up. It rides the state frame already sent; an older page never looks at it.)
export const HELD_SHIFT = 4;
export const HELD_MASK = 0x70;
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
  /** Driving: how bent the car is, 0..15 (damageNibble). 0 on foot. */
  damage: number;
}

export function blankPlayerState(): PlayerState {
  return { id: 0, t: 0, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, mode: 0, flags: 0, vehicle: 0, steer: 0, pitch: 0, roll: 0, color: 0, pose: 0, damage: 0 };
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
  d.setUint8(33, (s.pose & POSE_MASK) | ((s.damage & 15) << STATE_DAMAGE_SHIFT));
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
  const pd = d.getUint8(33);
  s.pose = pd & POSE_MASK;
  s.damage = (pd >> STATE_DAMAGE_SHIFT) & 15;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return null;
  return s;
}

// Ragdoll tail (Nov 23): while a player's own ragdoll is flying, their state frame carries 25 more bytes after the 34.
// The service relays state frames unread up to MAX_PLAYER_FRAME_BYTES (96), and decodePlayerState only asks for at
// least 34, so an older page reads the frame as before (pose 'down') and the Worker needs no redeploy.
//   34 mark u8 (RAG_MARK)  35 centre of mass minus (x, y, z): 3 x i16 cm  41 orientation quaternion xyzw: 4 x i16 / 32767
//   49 ten limb angles i8 (1/40 rad): left arm swing, abduct, elbow, right arm the same, left leg swing, knee, right leg the same
export const RAG_MARK = 0xa7;
export const RAG_TAIL_BYTES = 25;
export const RAG_LIMBS = 10;
/** Floats in a ragdoll sample: com xyz (absolute), quaternion xyzw, RAG_LIMBS angles. */
export const RAG_FLOATS = 7 + RAG_LIMBS;

/** Write a ragdoll sample after a state frame already encoded in `buf` (PLAYER_STATE_BYTES + RAG_TAIL_BYTES long). */
export function writeRagTail(buf: ArrayBuffer, s: PlayerState, rag: ArrayLike<number>): void {
  const d = new DataView(buf), o = PLAYER_STATE_BYTES;
  d.setUint8(o, RAG_MARK);
  d.setInt16(o + 1, clampI16((rag[0] - s.x) * 100), true);
  d.setInt16(o + 3, clampI16((rag[1] - s.y) * 100), true);
  d.setInt16(o + 5, clampI16((rag[2] - s.z) * 100), true);
  for (let i = 0; i < 4; i++) d.setInt16(o + 7 + i * 2, clampI16(rag[3 + i] * 32767), true);
  for (let i = 0; i < RAG_LIMBS; i++) { const v = Math.round(rag[7 + i] * 40); d.setInt8(o + 15 + i, v > 127 ? 127 : v < -127 ? -127 : v || 0); }
}

/** A ragdoll sample from a state frame that has one (decode the state first: the com is relative to it). */
export function readRagTail(buf: ArrayBuffer, s: PlayerState, out: Float32Array): boolean {
  if (buf.byteLength < PLAYER_STATE_BYTES + RAG_TAIL_BYTES) return false;
  const d = new DataView(buf), o = PLAYER_STATE_BYTES;
  if (d.getUint8(o) !== RAG_MARK) return false;
  out[0] = s.x + d.getInt16(o + 1, true) / 100;
  out[1] = s.y + d.getInt16(o + 3, true) / 100;
  out[2] = s.z + d.getInt16(o + 5, true) / 100;
  let n = 0;
  for (let i = 0; i < 4; i++) { out[3 + i] = d.getInt16(o + 7 + i * 2, true) / 32767; n += out[3 + i] * out[3 + i]; }
  if (!(n > 0.5)) return false;
  n = 1 / Math.sqrt(n);
  for (let i = 0; i < 4; i++) out[3 + i] *= n;
  for (let i = 0; i < RAG_LIMBS; i++) out[7 + i] = d.getInt8(o + 15 + i) / 40;
  return true;
}

// Car damage tail (Nov 23): while a player drives one of the cars, their state frame carries 9 more bytes after the
// 34: a mark and ent/carDamage.ts's eight bytes (crumple of the front, rear, left and right; the glass; lamps and
// tyres; bumpers; scrapes). Like the ragdoll tail (which only rides on foot, so the two never meet), the service
// relays it unread within MAX_PLAYER_FRAME_BYTES and an older page reads the 34 it knows: no Worker redeploy.
//   34 mark u8 (DMG_MARK)  35..42 the damage
export const DMG_MARK = 0xd4;
export const DMG_TAIL_BYTES = 9;

/** Write the damage after a state frame already encoded in `buf` (PLAYER_STATE_BYTES + DMG_TAIL_BYTES long). */
export function writeDmgTail(buf: ArrayBuffer, bytes: Uint8Array): void {
  const u8 = new Uint8Array(buf, PLAYER_STATE_BYTES, DMG_TAIL_BYTES);
  u8[0] = DMG_MARK;
  u8.set(bytes.subarray(0, DMG_TAIL_BYTES - 1), 1);
}

/** The damage bytes from a state frame that has them. */
export function readDmgTail(buf: ArrayBuffer, out: Uint8Array): boolean {
  if (buf.byteLength < PLAYER_STATE_BYTES + DMG_TAIL_BYTES) return false;
  const u8 = new Uint8Array(buf, PLAYER_STATE_BYTES, DMG_TAIL_BYTES);
  if (u8[0] !== DMG_MARK) return false;
  out.set(u8.subarray(1));
  return true;
}

// Player event: 4 bytes. [kind, id, code, arg]
export const PLAYER_EVENT_BYTES = 4;
// (Stage 3, step 3 adds longer events with the same first four bytes: see "Weapons between players" below. A page that
// does not know a code ignores the event, so they needed no new version.)
export const PlayerEvent = { Horn: 1, Wave: 2, Shout: 3, Fire: 4, Rocket: 5, Blast: 6, Vital: 7, Prop: 8, Held: 9, Crew: 10, Job: 11, Ride: 12, Seats: 13, Look: 14, Emote: 15, Race: 16, Pursuit: 17, Derby: 18, Chat: 21 } as const;
// Emote (4 bytes): [kind, id, 15, emote id] (game/emotes.ts EMOTES; 0 = stopped). Sent when a player starts or stops one,
// and again every few seconds while a looping one runs, for anybody who arrives. Relayed unread by the service; a page
// that does not know code 15 hands it to the weapons code, which ignores codes it does not know: no new version.

// ---- Looks (fun queue item 10; game/looks.ts) ----
// Look (3 + LOOK_BYTES = 27 bytes): [kind, id, 14, the player's look descriptor]. Sent on arriving, when somebody else
// arrives, and when the player changes their look or car in the Wardrobe. The service relays it unread like any Event,
// and a page that does not know code 14 ignores it (it keeps drawing its own made-up look), so no new version.
export const LOOK_EVENT_BYTES = 3 + 24;
export function encodeLookEvent(look: Uint8Array): ArrayBuffer {
  const buf = makeFrame(Frame.Event, 1 + look.length);
  const u8 = new Uint8Array(buf);
  u8[2] = PlayerEvent.Look;
  u8.set(look, 3);
  return buf;
}
export function decodeLookEvent(buf: ArrayBuffer): { id: number; look: Uint8Array } | null {
  if (buf.byteLength < LOOK_EVENT_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.Event || u8[2] !== PlayerEvent.Look) return null;
  return { id: u8[1], look: u8.slice(3, LOOK_EVENT_BYTES) };
}

// ---- Riding together (version 5; net/ride.ts) ----
// Ride (5 bytes, from a passenger): [kind, id, 12, driver id, seat]. Seat RIDE_OUT: they got out (driver id then says
// whose car). Sent on getting in and out; the passenger's State frames say the same while they sit (mode Passenger,
// `vehicle` = driver id, `color` = seat), for anybody who arrives later.
// Seats (4 + 2n bytes, from a driver, the car's authority): [kind, id, 13, why, (passenger id, seat) x n]: who sits where
// in this driver's car. Sent at once when it changes, when a Ride comes in, and to somebody who arrives. A passenger
// missing from it (after their Ride went) gets out; `why` says how: SeatsWhy.
export const RIDE_BYTES = 5;
export const RIDE_OUT = 255;
export const SEATS_MAX = 12;
export const SeatsWhy = { Seated: 0, Out: 1, Thrown: 2 } as const;
export function encodeRide(driver: number, seat: number): ArrayBuffer {
  const buf = makeFrame(Frame.Event, 3);
  const u8 = new Uint8Array(buf);
  u8[2] = PlayerEvent.Ride; u8[3] = driver & 0xff; u8[4] = seat & 0xff;
  return buf;
}
export function decodeRide(buf: ArrayBuffer): { id: number; driver: number; seat: number } | null {
  if (buf.byteLength < RIDE_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.Event || u8[2] !== PlayerEvent.Ride) return null;
  return { id: u8[1], driver: u8[3], seat: u8[4] };
}
export function encodeSeats(why: number, list: readonly (readonly [number, number])[]): ArrayBuffer {
  const n = Math.min(list.length, SEATS_MAX);
  const buf = makeFrame(Frame.Event, 2 + 2 * n);
  const u8 = new Uint8Array(buf);
  u8[2] = PlayerEvent.Seats; u8[3] = why & 0xff;
  for (let i = 0; i < n; i++) { u8[4 + 2 * i] = list[i][0] & 0xff; u8[5 + 2 * i] = list[i][1] & 0xff; }
  return buf;
}
export function decodeSeats(buf: ArrayBuffer): { id: number; why: number; list: [number, number][] } | null {
  if (buf.byteLength < 4 || (buf.byteLength & 1) !== 0) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.Event || u8[2] !== PlayerEvent.Seats) return null;
  const list: [number, number][] = [];
  for (let i = 4; i + 1 < u8.length && list.length < SEATS_MAX; i += 2) list.push([u8[i], u8[i + 1]]);
  return { id: u8[1], why: u8[3], list };
}

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
export const ToHostKind = { CarHit: 1, ParkHit: 2, Take: 3, Leave: 4, PedKnock: 5, PedHurt: 6, Bang: 7, Heat: 8, CarShot: 9, Give: 10, Mine: 11, Kid: 12, Season: 13 } as const;  // Season: net/townSeason.ts (its codec and fact are there)

// The town's bridge (stage 4, step 1; net/town.ts). The durable fact FACT_BRIDGE is [spans, stage, bank]: only the host
// can write a fact, so a guest tells the host what should go into it. Still version 4: the service passes both unread.
// Give, 7 bytes: "I have earned this much toward the bridge; count it for the town too".
//   0 kind (Frame.ToHost)  1 id  2 ToHostKind.Give  3 points u32 (hundredths of a point)
// Mine, 9 bytes: "what I have (saved, or on my screen) is further along than the town's: take it up".
//   0 kind  1 id  2 ToHostKind.Mine  3 spans u8  4 stage u8  5 bank u32 (whole points)
export const GIVE_BYTES = 7;
export const MINE_BYTES = 9;
/** The most one Give may carry, points: far above any payment the game makes, far below nonsense. */
export const GIVE_MAX_POINTS = 100000;
export function encodeGive(points: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, GIVE_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Give);
  d.setUint32(3, Math.max(0, Math.min(GIVE_MAX_POINTS * 100, Math.round(points * 100))), true);
  return buf;
}
export function decodeGive(buf: ArrayBuffer): { id: number; points: number } | null {
  if (buf.byteLength < GIVE_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Give) return null;
  const p = d.getUint32(3, true) / 100;
  return p > 0 && p <= GIVE_MAX_POINTS ? { id: d.getUint8(1), points: p } : null;
}
export function encodeMine(spans: number, stage: number, bank: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, MINE_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Mine);
  d.setUint8(3, spans & 0xff); d.setUint8(4, stage & 0xff);
  d.setUint32(5, Math.max(0, Math.min(0xffffffff, Math.floor(bank))), true);
  return buf;
}
export function decodeMine(buf: ArrayBuffer): { id: number; spans: number; stage: number; bank: number } | null {
  if (buf.byteLength < MINE_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Mine) return null;
  return { id: d.getUint8(1), spans: d.getUint8(3), stage: d.getUint8(4), bank: d.getUint32(5, true) };
}
// Kid, 4 bytes: "switch kid-friendly mode on (1) or off (0) for the whole town" (net/town.ts). Anyone may flip it; only the
// host can write FACT_KID, so a guest asks. A host of an older page ignores it and the asker's screen goes back to the town's.
//   0 kind  1 id  2 ToHostKind.Kid  3 on u8
export const KID_BYTES = 4;
export function encodeKid(on: boolean): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, KID_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Kid);
  d.setUint8(3, on ? 1 : 0);
  return buf;
}
export function decodeKid(buf: ArrayBuffer): { id: number; on: boolean } | null {
  if (buf.byteLength < KID_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Kid) return null;
  return { id: d.getUint8(1), on: d.getUint8(3) === 1 };
}
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
export const ToPlayerKind = { Grant: 1, Left: 2, Hurt: 3, Bust: 4, Crime: 5 } as const;
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
export const WorldKind = { Traffic: 1, Parked: 2, People: 3, Police: 4, Props: 5 } as const;

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

// Stage 3, step 4: the top of the same 16 steps says more than "bent", so that a fire and a wreck cost no new bytes.
// A car under 20 health burns (ent/weapons.ts), and damageStep() of anything under 20 is 13 or more: so 13 and 14 are
// "alight", and 15 is kept for "burnt out", which health alone cannot say (a car at 0 may still be burning).
export const DAMAGE_BURN = 13;
export const DAMAGE_WRECK = 15;
/** What goes on the wire for a car: its health in steps, 15 only for a wreck. */
export function damageNibble(health: number, wreck: boolean): number {
  if (wreck) return DAMAGE_WRECK;
  const s = damageStep(health);
  return s >= DAMAGE_WRECK ? DAMAGE_WRECK - 1 : s;
}
/** The health to show for a step: the middle of the band damageStep() gives it, so it smokes and burns when the real one does. */
export function stepHealth(step: number): number {
  return step <= 0 ? 100 : step >= DAMAGE_WRECK ? 0 : 100 - (step - 0.5) / 0.15;
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

// ---- The same police for everyone (stage 3, step 2) ----
//
// Heat stays each player's own: every browser works out its own player's wanted level from its own deeds, as alone.
// The POLICE are one set, run by the host and seen by everybody. The version stays at 4: every frame below is a kind
// that an older page ignores (as a guest it keeps private police; as a host it sends no police beat, and a newer
// guest that hears none keeps private police too).
//
// The cars are ordinary records in the traffic frames. A cruiser's paint nibble is not paint (they are all navy):
// CRUISER_ON_DUTY there means one of the Patrol's own, bar lit and siren going. The officers are ordinary records in
// the people frames, numbered from OFFICER_WID0 up, and wear the uniform instead of the look their number would give.
export const CRUISER_ON_DUTY = 1;
export const OFFICER_WID0 = 224;
//
// Heat (ToHost), 8 bytes: "this is how wanted I am". Sent when it changes, at most HEAT_HZ a second, and again every
// HEAT_REFRESH_MS while wanted (a new host has to learn it from somewhere).
//   0 kind  1 id  2 ToHostKind.Heat  3 level (low 3 bits) | HeatFlag  4 x u16  6 z u16 (where the Patrol last had them:
//   the search is centred there; 5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)
// Seen: an officer the player's browser is shown can see them right now (it is the judge of that: it has the walls
// and its own player exactly). Incognito: in a car nobody saw them take. Out: lying in the road.
export const HEAT_BYTES = 8;
export const HEAT_HZ = 2;
export const HEAT_REFRESH_MS = 3000;
export const HeatFlag = { Seen: 8, Incognito: 16, Out: 32 } as const;
export interface HeatMsg { id: number; level: number; flags: number; x: number; z: number }
export function encodeHeat(level: number, flags: number, x: number, z: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, HEAT_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.Heat);
  d.setUint8(3, (level & 7) | (flags & 0xf8));
  d.setUint16(4, clampU16((x - TRAFFIC_X0) / TRAFFIC_STEP), true);
  d.setUint16(6, clampU16((z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
  return buf;
}
export function decodeHeat(buf: ArrayBuffer): HeatMsg | null {
  if (buf.byteLength < HEAT_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.Heat) return null;
  const b = d.getUint8(3);
  return { id: d.getUint8(1), level: Math.min(5, b & 7), flags: b & 0xf8, x: d.getUint16(4, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(6, true) * TRAFFIC_STEP + TRAFFIC_Z0 };
}
// What the host's police do to a player, told to that player alone (ToPlayer); their own browser applies it by the
// single player rules.
// Hurt, 5 bytes: an officer's round found you.  0 kind  1 id  2 ToPlayerKind.Hurt  3 health off you u8  4 off your car u8 (tenths)
// Bust, 3 bytes: held long enough; you are booked.  0 kind  1 id  2 ToPlayerKind.Bust
// Crime, 9 bytes: something you did to the Patrol that only the host could judge (an officer you hurt has died, or
//   was run down).  0 kind  1 id  2 ToPlayerKind.Crime  3 which (index into POLICE_CRIMES)  4 weight u8 (tenths of a level)  5 x u16  7 z u16
export const POLICE_HURT_BYTES = 5;
export const POLICE_BUST_BYTES = 3;
export const POLICE_CRIME_BYTES = 9;
export const POLICE_CRIMES = ['officerDown'] as const;
export function encodePoliceHurt(to: number, dmg: number, carDmg: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToPlayer, POLICE_HURT_BYTES - FRAME_HEADER_BYTES, to);
  const u8 = new Uint8Array(buf);
  u8[2] = ToPlayerKind.Hurt;
  u8[3] = Math.max(0, Math.min(255, Math.round(dmg * 10)));
  u8[4] = Math.max(0, Math.min(255, Math.round(carDmg * 10)));
  return buf;
}
export function decodePoliceHurt(buf: ArrayBuffer): { from: number; dmg: number; carDmg: number } | null {
  if (buf.byteLength < POLICE_HURT_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.ToPlayer || u8[2] !== ToPlayerKind.Hurt) return null;
  return { from: u8[1], dmg: u8[3] / 10, carDmg: u8[4] / 10 };
}
export function encodePoliceBust(to: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToPlayer, POLICE_BUST_BYTES - FRAME_HEADER_BYTES, to);
  new Uint8Array(buf)[2] = ToPlayerKind.Bust;
  return buf;
}
export function encodePoliceCrime(to: number, which: number, weight: number, x: number, z: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToPlayer, POLICE_CRIME_BYTES - FRAME_HEADER_BYTES, to);
  const d = new DataView(buf);
  d.setUint8(2, ToPlayerKind.Crime); d.setUint8(3, which & 0xff);
  d.setUint8(4, Math.max(0, Math.min(255, Math.round(weight * 10))));
  d.setUint16(5, clampU16((x - TRAFFIC_X0) / TRAFFIC_STEP), true);
  d.setUint16(7, clampU16((z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
  return buf;
}
export function decodePoliceCrime(buf: ArrayBuffer): { from: number; which: number; weight: number; x: number; z: number } | null {
  if (buf.byteLength < POLICE_CRIME_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToPlayer || d.getUint8(2) !== ToPlayerKind.Crime) return null;
  return { from: d.getUint8(1), which: d.getUint8(3), weight: d.getUint8(4) / 10, x: d.getUint16(5, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(7, true) * TRAFFIC_STEP + TRAFFIC_Z0 };
}
// The police beat (World): "this host runs the town's police", and the shots its officers have fired since the last.
// Sent every POLICE_BEAT_MS, and at once when there is a shot to show.
//   0 kind (Frame.World)  1 id  2 WorldKind.Police  3 cars on duty u8  4 n u8
//   5.. n shots of POLICE_SHOT_BYTES: 0 officer u8 (their number in the people frames)  1 x u16  3 z u16  5 y i16 (cm): where the round went
//
// The helicopter (stage 3, last step) is a tail on the same frame, after the shots, and only while it is in the sky.
// While it is, the beat goes every HELI_MS instead (the guests smooth between two of them); the first beat without
// the tail says it has gone. The version stays at 4: an older guest reads the shots by their count and never looks
// at what follows them; an older host sends no tail and its guests are shown no helicopter. (It is not in the traffic
// frames, which go more often, because everything after a traffic frame's records is a list of car numbers: an
// older page would take the tail for cars.) The tail's LENGTH says what the lamp is doing:
//   0 x u16  2 z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)  4 y u8 (meters)  5 heading u8 (1/256 turn)
//       6 bytes: on its way in or out, lamp off
//   6 who u8: 7 bytes, on station with its lamp on that player (their number in town). Every browser points the lamp
//       at that player as it shows them itself, so the light is on them on every screen and costs one byte.
//   6 dx i8  7 dz i8 (meters from the helicopter): 8 bytes, on station and sweeping: where the lamp rests on the ground
export const POLICE_BEAT_MS = 2000;
export const POLICE_BEAT_HEADER_BYTES = 5;
export const POLICE_SHOT_BYTES = 7;
export const POLICE_MAX_SHOTS = 16;
export const HELI_MS = 400;
export const HELI_MAX_BYTES = 8;
/** What the lamp is doing: off (in transit), on a player, or sweeping the ground. */
export const HeliLamp = { Off: 0, Track: 1, Sweep: 2 } as const;
export interface HeliRec { x: number; y: number; z: number; h: number; lamp: number; who: number; sx: number; sz: number }
export function blankHeli(): HeliRec { return { x: 0, y: 0, z: 0, h: 0, lamp: 0, who: 0, sx: 0, sz: 0 }; }
export interface PoliceShot { officer: number; x: number; y: number; z: number }
/** `out` must hold POLICE_BEAT_HEADER_BYTES + n * POLICE_SHOT_BYTES + HELI_MAX_BYTES. Returns the bytes used. */
export function encodePoliceBeat(units: number, shots: readonly PoliceShot[], n: number, out: Uint8Array, heli: HeliRec | null = null): number {
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  d.setUint8(0, Frame.World); d.setUint8(1, 0); d.setUint8(2, WorldKind.Police);
  d.setUint8(3, Math.min(255, units)); d.setUint8(4, n);
  let o = POLICE_BEAT_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += POLICE_SHOT_BYTES) {
    const s = shots[i];
    d.setUint8(o, s.officer & 0xff);
    d.setUint16(o + 1, clampU16((s.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 3, clampU16((s.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setInt16(o + 5, clampI16(s.y * 100), true);
  }
  if (heli) {
    const qx = clampU16((heli.x - TRAFFIC_X0) / TRAFFIC_STEP), qz = clampU16((heli.z - TRAFFIC_Z0) / TRAFFIC_STEP);
    d.setUint16(o, qx, true); d.setUint16(o + 2, qz, true);
    d.setUint8(o + 4, Math.max(0, Math.min(255, Math.round(heli.y))));
    d.setUint8(o + 5, Math.round(((((heli.h % TAU) + TAU) % TAU) / TAU) * 256) & 0xff);
    o += 6;
    if (heli.lamp === HeliLamp.Track) d.setUint8(o++, heli.who & 0xff);
    else if (heli.lamp === HeliLamp.Sweep) {
      // (Measured from the place the guests will be told, so the rounding of the one is not added to the other.)
      d.setInt8(o++, clampI8(heli.sx - (qx * TRAFFIC_STEP + TRAFFIC_X0)));
      d.setInt8(o++, clampI8(heli.sz - (qz * TRAFFIC_STEP + TRAFFIC_Z0)));
    }
  }
  return o;
}
export function decodePoliceBeat(buf: ArrayBuffer): { from: number; units: number; shots: PoliceShot[]; heli: HeliRec | null } | null {
  const len = buf.byteLength;
  if (len < POLICE_BEAT_HEADER_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.World || d.getUint8(2) !== WorldKind.Police) return null;
  const n = d.getUint8(4);
  if (n > POLICE_MAX_SHOTS || POLICE_BEAT_HEADER_BYTES + n * POLICE_SHOT_BYTES > len) return null;
  const shots: PoliceShot[] = [];
  let o = POLICE_BEAT_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += POLICE_SHOT_BYTES) {
    shots.push({ officer: d.getUint8(o), x: d.getUint16(o + 1, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(o + 3, true) * TRAFFIC_STEP + TRAFFIC_Z0, y: d.getInt16(o + 5, true) / 100 });
  }
  let heli: HeliRec | null = null;
  const tail = len - o;
  if (tail >= 6 && tail <= HELI_MAX_BYTES) {
    heli = blankHeli();
    heli.x = d.getUint16(o, true) * TRAFFIC_STEP + TRAFFIC_X0; heli.z = d.getUint16(o + 2, true) * TRAFFIC_STEP + TRAFFIC_Z0;
    heli.y = d.getUint8(o + 4); heli.h = (d.getUint8(o + 5) / 256) * TAU;
    heli.sx = heli.x; heli.sz = heli.z;
    if (tail === 7) { heli.lamp = HeliLamp.Track; heli.who = d.getUint8(o + 6); }
    else if (tail === 8) { heli.lamp = HeliLamp.Sweep; heli.sx = heli.x + d.getInt8(o + 6); heli.sz = heli.z + d.getInt8(o + 7); }
  }
  return { from: d.getUint8(1), units: d.getUint8(3), shots, heli };
}

// ---- Weapons between players (stage 3, step 3) ----
//
// A shot is an EVENT, not state: nothing here is sent while nobody fires. The version stays at 4: all of it is new
// Event codes and one new ToHost kind, the service relays both unread (up to MAX_PLAYER_FRAME_BYTES), and an older
// page ignores a code or a kind it does not know (it then neither sees the shots nor is hurt by them).
// Every browser stays the judge of its own player and its own car; the host of the town's people and cars.
//
// Fire (Event), 4 + 7 per round + 4 per hit bytes: what this player's weapon has done in the last FIRE_MS. Sent at
//   most FIRE_HZ times a second, so a held trigger is a few rounds to a frame, not a frame to a round.
//   0 kind (Frame.Event)  1 id  2 PlayerEvent.Fire
//   3 slot (low 3 bits: the weapon, the game's own table; 0 = fists, and then the event is a swing of the arm)
//       | rounds (next 3 bits, 0..FIRE_MAX_SHOTS) | hits (high 2 bits, 0..FIRE_MAX_HITS)
//   4.. per round, 7 bytes: 0 what it met (ShotEnd)  1 x u16  3 z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)  5 y i16 (cm):
//       where it went. Where it came from is not sent: the muzzle is wherever the others are shown the shooter.
//   then per hit, 4 bytes: 0 the player it found (their id)  1 damage u8  2 the way the blow travelled u8 (1/256 turn)
//       3 HitFlag (Fist: a punch. Car: it struck the car they are driving, not them)
// A hit is a CLAIM. The player named applies it on their own browser, within limits: the shooter is shown near enough
// for that weapon to reach, and no more damage than that weapon can do in the time since their last claim.
// Everybody else uses the event only to draw the flash, the line and the mark.
export const FIRE_HZ = 10;
export const FIRE_MAX_SHOTS = 7;
export const FIRE_MAX_HITS = 3;
export const FIRE_HEADER_BYTES = 4;
export const FIRE_SHOT_BYTES = 7;
export const FIRE_HIT_BYTES = 4;
/** What a round met, so the others can draw the right mark there. */
export const ShotEnd = { None: 0, Wall: 1, Ground: 2, Water: 3, Car: 4, Body: 5 } as const;
export const HitFlag = { Fist: 1, Car: 2 } as const;
export interface FireShot { end: number; x: number; y: number; z: number }
export interface FireHit { target: number; damage: number; h: number; flags: number }
export interface FireMsg { id: number; slot: number; shots: FireShot[]; hits: FireHit[] }
export function encodeFire(slot: number, shots: readonly FireShot[], nShots: number, hits: readonly FireHit[], nHits: number): ArrayBuffer {
  const ns = Math.min(nShots, FIRE_MAX_SHOTS), nh = Math.min(nHits, FIRE_MAX_HITS);
  const buf = makeFrame(Frame.Event, 2 + ns * FIRE_SHOT_BYTES + nh * FIRE_HIT_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Fire);
  d.setUint8(3, (slot & 7) | (ns << 3) | (nh << 6));
  let o = FIRE_HEADER_BYTES;
  for (let i = 0; i < ns; i++, o += FIRE_SHOT_BYTES) {
    const s = shots[i];
    d.setUint8(o, s.end & 0xff);
    d.setUint16(o + 1, clampU16((s.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 3, clampU16((s.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setInt16(o + 5, clampI16(s.y * 100), true);
  }
  for (let i = 0; i < nh; i++, o += FIRE_HIT_BYTES) {
    const h = hits[i];
    d.setUint8(o, h.target & 0xff);
    d.setUint8(o + 1, Math.max(0, Math.min(255, Math.round(h.damage))));
    d.setUint8(o + 2, Math.round((((h.h % TAU) + TAU) % TAU) / TAU * 256) & 255);
    d.setUint8(o + 3, h.flags & 0xff);
  }
  return buf;
}
export function decodeFire(buf: ArrayBuffer): FireMsg | null {
  const len = buf.byteLength;
  if (len < FIRE_HEADER_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.Event || d.getUint8(2) !== PlayerEvent.Fire) return null;
  const b = d.getUint8(3), ns = (b >> 3) & 7, nh = b >> 6;
  if (FIRE_HEADER_BYTES + ns * FIRE_SHOT_BYTES + nh * FIRE_HIT_BYTES > len) return null;
  const shots: FireShot[] = [], hits: FireHit[] = [];
  let o = FIRE_HEADER_BYTES;
  for (let i = 0; i < ns; i++, o += FIRE_SHOT_BYTES) {
    shots.push({ end: d.getUint8(o), x: d.getUint16(o + 1, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(o + 3, true) * TRAFFIC_STEP + TRAFFIC_Z0, y: d.getInt16(o + 5, true) / 100 });
  }
  for (let i = 0; i < nh; i++, o += FIRE_HIT_BYTES) {
    hits.push({ target: d.getUint8(o), damage: d.getUint8(o + 1), h: (d.getUint8(o + 2) / 256) * TAU, flags: d.getUint8(o + 3) });
  }
  return { id: d.getUint8(1), slot: b & 7, shots, hits };
}

// Rocket (Event), 16 bytes: "I have launched one from here, going this way". The others fly a picture of it by the
//   same arithmetic; where it goes off is the Blast that follows, not theirs to work out.
//   0 kind  1 id  2 PlayerEvent.Rocket  3 unused  4 x u16  6 z u16  8 y i16 (cm)  10 vx i16  12 vy i16  14 vz i16 (cm/s)
export const ROCKET_BYTES = 16;
export interface RocketMsg { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
export function encodeRocket(x: number, y: number, z: number, vx: number, vy: number, vz: number): ArrayBuffer {
  const buf = makeFrame(Frame.Event, ROCKET_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Rocket);
  d.setUint16(4, clampU16((x - TRAFFIC_X0) / TRAFFIC_STEP), true);
  d.setUint16(6, clampU16((z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
  d.setInt16(8, clampI16(y * 100), true);
  d.setInt16(10, clampI16(vx * 100), true); d.setInt16(12, clampI16(vy * 100), true); d.setInt16(14, clampI16(vz * 100), true);
  return buf;
}
export function decodeRocket(buf: ArrayBuffer): RocketMsg | null {
  if (buf.byteLength < ROCKET_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.Event || d.getUint8(2) !== PlayerEvent.Rocket) return null;
  return {
    id: d.getUint8(1), x: d.getUint16(4, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(6, true) * TRAFFIC_STEP + TRAFFIC_Z0, y: d.getInt16(8, true) / 100,
    vx: d.getInt16(10, true) / 100, vy: d.getInt16(12, true) / 100, vz: d.getInt16(14, true) / 100,
  };
}

// Blast (Event), 12 bytes: "something has blown up here" (this player's rocket, the car this player was burning in,
//   or, from the host, one of the town's cars). Sent by the ONE browser on which it went off. Everybody draws it; every
//   browser takes what it does to its own player and its own car; the HOST alone takes what it does to the town's
//   cars and people, and they reach everybody through the frames that already carry them. So each thing is hurt once.
//   0 kind  1 id  2 PlayerEvent.Blast  3 by u8  4 x u16  6 z u16  8 y i16 (cm)  10 radius u8 (1/4 m)  11 damage u8
//   by (stage 3, step 4; the byte was unused, so 0 from an older page): the player whose rounds or rocket set the car
//   alight that has now gone up on the sender's browser, when that was not the sender. Their own browser makes it
//   their crime, as it would have been alone. 0 = nobody else's doing.
export const BLAST_BYTES = 12;
export interface BlastMsg { id: number; by: number; x: number; y: number; z: number; radius: number; damage: number }
export function encodeBlast(x: number, y: number, z: number, radius: number, damage: number, by = 0): ArrayBuffer {
  const buf = makeFrame(Frame.Event, BLAST_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Blast);
  d.setUint8(3, by & 0xff);
  d.setUint16(4, clampU16((x - TRAFFIC_X0) / TRAFFIC_STEP), true);
  d.setUint16(6, clampU16((z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
  d.setInt16(8, clampI16(y * 100), true);
  d.setUint8(10, Math.max(0, Math.min(255, Math.round(radius * 4))));
  d.setUint8(11, Math.max(0, Math.min(255, Math.round(damage))));
  return buf;
}
export function decodeBlast(buf: ArrayBuffer): BlastMsg | null {
  if (buf.byteLength < BLAST_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.Event || d.getUint8(2) !== PlayerEvent.Blast) return null;
  return { id: d.getUint8(1), by: d.getUint8(3), x: d.getUint16(4, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(6, true) * TRAFFIC_STEP + TRAFFIC_Z0, y: d.getInt16(8, true) / 100, radius: d.getUint8(10) / 4, damage: d.getUint8(11) };
}

// Vital (Event), 5 bytes: "this is the health I have left". Sent only when another player's claim has just been
//   applied (at most VITAL_HZ a second: it is how the shooter and the town see that the round counted), when this
//   player dies (health 0, at once, whatever killed them) and when they are back on their feet (full health).
//   0 kind  1 id  2 PlayerEvent.Vital  3 health u8 (0..200 = 0..100)  4 the player whose doing it was (their id; 0 = nobody's)
export const VITAL_BYTES = 5;
export const VITAL_HZ = 4;
export function encodeVital(health: number, by: number): ArrayBuffer {
  const buf = makeFrame(Frame.Event, VITAL_BYTES - FRAME_HEADER_BYTES);
  const u8 = new Uint8Array(buf);
  u8[2] = PlayerEvent.Vital; u8[3] = healthByte(health); u8[4] = by & 0xff;
  return buf;
}
export function decodeVital(buf: ArrayBuffer): { id: number; health: number; by: number } | null {
  if (buf.byteLength < VITAL_BYTES) return null;
  const u8 = new Uint8Array(buf);
  if (u8[0] !== Frame.Event || u8[2] !== PlayerEvent.Vital) return null;
  return { id: u8[1], health: u8[3] / 2, by: u8[4] };
}

// CarShot (ToHost), 7 bytes: "my rounds have struck your car N" (a guest's, on one of the town's cars: the knocks of
//   stage 2 are for bumpers, this is for bullets). The host takes the health off the real car, and everybody sees the
//   result in the traffic frames. Summed over FIRE_MS, like the rounds themselves.
//   0 kind (Frame.ToHost)  1 id  2 ToHostKind.CarShot  3 CarClass  4 car u16 (its number, or its place when parked)
//   6 health off it u8 (quarters of a point)
export const CAR_SHOT_BYTES = 7;
export interface CarShot { id: number; cls: number; car: number; damage: number }
export function encodeCarShot(cls: number, car: number, damage: number): ArrayBuffer {
  const buf = makeFrame(Frame.ToHost, CAR_SHOT_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, ToHostKind.CarShot);
  d.setUint8(3, cls & 0xff);
  d.setUint16(4, car & 0xffff, true);
  d.setUint8(6, Math.max(0, Math.min(255, Math.round(damage * 4))));
  return buf;
}
export function decodeCarShot(buf: ArrayBuffer): CarShot | null {
  if (buf.byteLength < CAR_SHOT_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.ToHost || d.getUint8(2) !== ToHostKind.CarShot) return null;
  return { id: d.getUint8(1), cls: d.getUint8(3), car: d.getUint16(4, true), damage: d.getUint8(6) / 4 };
}

// ---- Fire, wrecks and breakable props (stage 3, step 4) ----
//
// Fire and wrecks add no frame of their own: see DAMAGE_BURN (the traffic records and the state frames) and the `by`
// of a Blast. A wreck a player is thrown out of is handed to the host with the Leave it would have sent on getting
// out, its damage saying "burnt out".
//
// Props (hydrants, bins, cones, posts, mailboxes, benches, lamps, signals): the street furniture a car knocks over.
// Only in a town on the MAIN service. A prop has no number: every browser builds the same street from the same map,
// so where it stands (to 5 cm) says which one it is, and a browser that never built that one loses nothing.
// Breaking cannot be argued over (down is down, and nothing stands one up again), so nobody has to say yes: the
// browser whose car knocked one over says so, and everybody knocks theirs over.
//
// Prop (Event), 6 + 4 per prop bytes: "my car (or, from the host, one of the town's) has just knocked these down".
//   Gathered for PROP_MS, so a car through a row of cones is one frame, not six.
//   0 kind (Frame.Event)  1 id  2 PlayerEvent.Prop  3 n u8 (1..PROP_EVENT_MAX)
//   4 vx i8  5 vz i8 (half m/s: the way the car was going, for the way they fall and what flies off)
//   6.. per prop: x u16  z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)
// Props (World, WorldKind.Props), 5 + 4 per prop bytes: everything down in town, from the host, to somebody who was
//   not there to see it fall. Sent once when somebody arrives (and never while nothing in town is broken); the props
//   in it go down quietly, with no noise and nothing flying.
//   0 kind (Frame.World)  1 id  2 WorldKind.Props  3 n u16  5.. per prop: x u16  z u16
export const PROP_MS = 100;
export const PROP_EVENT_MAX = 22;
export const PROP_EVENT_HEADER_BYTES = 6;
export const PROP_BYTES = 4;
export const PROPS_HEADER_BYTES = 5;
/** The most a town remembers (the newest): one World frame holds them all. */
export const PROPS_MAX = 1000;
/** A prop's place as the wire carries it: x in the high 16 bits, z in the low. */
export function propKey(x: number, z: number): number {
  return (clampU16((x - TRAFFIC_X0) / TRAFFIC_STEP) << 16 | clampU16((z - TRAFFIC_Z0) / TRAFFIC_STEP)) >>> 0;
}
export function propKeyX(k: number): number { return (k >>> 16) * TRAFFIC_STEP + TRAFFIC_X0; }
export function propKeyZ(k: number): number { return (k & 0xffff) * TRAFFIC_STEP + TRAFFIC_Z0; }
export interface PropMsg { id: number; vx: number; vz: number; keys: number[] }
export function encodeProp(keys: readonly number[], n: number, vx: number, vz: number): ArrayBuffer {
  const m = Math.min(n, PROP_EVENT_MAX);
  const buf = makeFrame(Frame.Event, PROP_EVENT_HEADER_BYTES - FRAME_HEADER_BYTES + m * PROP_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Prop); d.setUint8(3, m);
  d.setInt8(4, clampI8(vx * 2)); d.setInt8(5, clampI8(vz * 2));
  for (let i = 0, o = PROP_EVENT_HEADER_BYTES; i < m; i++, o += PROP_BYTES) d.setUint32(o, keys[i] >>> 0, false);
  return buf;
}
export function decodeProp(buf: ArrayBuffer): PropMsg | null {
  const len = buf.byteLength;
  if (len < PROP_EVENT_HEADER_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.Event || d.getUint8(2) !== PlayerEvent.Prop) return null;
  const n = d.getUint8(3);
  if (n > PROP_EVENT_MAX || PROP_EVENT_HEADER_BYTES + n * PROP_BYTES > len) return null;
  const keys: number[] = [];
  for (let i = 0, o = PROP_EVENT_HEADER_BYTES; i < n; i++, o += PROP_BYTES) keys.push(d.getUint32(o, false));
  return { id: d.getUint8(1), vx: d.getInt8(4) / 2, vz: d.getInt8(5) / 2, keys };
}
/** Returns the bytes used. `out` must hold PROPS_HEADER_BYTES + n * PROP_BYTES. */
export function encodeProps(keys: readonly number[], n: number, out: Uint8Array): number {
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  d.setUint8(0, Frame.World); d.setUint8(1, 0); d.setUint8(2, WorldKind.Props);
  d.setUint16(3, n, true);
  let o = PROPS_HEADER_BYTES;
  for (let i = 0; i < n; i++, o += PROP_BYTES) d.setUint32(o, keys[i] >>> 0, false);
  return o;
}
export function decodeProps(buf: ArrayBuffer): number[] | null {
  const len = buf.byteLength;
  if (len < PROPS_HEADER_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.World || d.getUint8(2) !== WorldKind.Props) return null;
  const n = d.getUint16(3, true);
  if (n > PROPS_MAX || PROPS_HEADER_BYTES + n * PROP_BYTES > len) return null;
  const keys: number[] = [];
  for (let i = 0, o = PROPS_HEADER_BYTES; i < n; i++, o += PROP_BYTES) keys.push(d.getUint32(o, false));
  return keys;
}

// ---- Cars a script holds for its player (stage 4, step 2; net/held.ts) ----
//
// A mission's cars and a job's cars stay their runner's for as long as the script holds them. Only in a town on the
// MAIN service. The runner's browser is the one that simulates them; the others are told where they stand, so that
// they can show them (drawn, solid, nobody else's to get into), with one Event frame holding the WHOLE list. It is
// sent when the list or a car in it changes (at most SEND_HZ times a second), once more when somebody arrives, and
// never while the cars stand still. The car the runner is driving is not in it: the State frames show that one.
// Still version 4: the service passes an Event unread, and a page that does not know the code ignores it.
//
// Held (Event), 4 + 15 per car bytes:
//   0 kind (Frame.Event)  1 id  2 PlayerEvent.Held  3 n u8 (0..HELD_MAX; 0 = "none any more")
//   4.. per car: slot (low 3 bits: the same car keeps its slot) | damage (high 4 bits, the 16 steps of DAMAGE_BURN)
//     kind u8  colour u24 (a mission paints its cars as it likes)  x u16  z u16 (5 cm steps from TRAFFIC_X0,
//     TRAFFIC_Z0)  y i16 (cm)  yaw u16  pitch i8  roll i8 (1/200 rad)
export const HELD_MAX = 6;
export const HELD_HEADER_BYTES = 4;
export const HELD_CAR_BYTES = 15;
export interface HeldCar { slot: number; damage: number; kind: number; color: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number }
export function blankHeldCar(): HeldCar { return { slot: 0, damage: 0, kind: 0, color: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }; }
export function encodeHeld(cars: readonly HeldCar[], n: number): ArrayBuffer {
  const m = Math.min(n, HELD_MAX);
  const buf = makeFrame(Frame.Event, HELD_HEADER_BYTES - FRAME_HEADER_BYTES + m * HELD_CAR_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Held); d.setUint8(3, m);
  for (let i = 0, o = HELD_HEADER_BYTES; i < m; i++, o += HELD_CAR_BYTES) {
    const c = cars[i], col = c.color >>> 0;
    d.setUint8(o, (c.slot & 7) | ((c.damage & 15) << 4));
    d.setUint8(o + 1, c.kind & 0xff);
    d.setUint8(o + 2, (col >> 16) & 0xff); d.setUint8(o + 3, (col >> 8) & 0xff); d.setUint8(o + 4, col & 0xff);
    d.setUint16(o + 5, clampU16((c.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 7, clampU16((c.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setInt16(o + 9, clampI16(c.y * 100), true);
    const turn = (((c.yaw % TAU) + TAU) % TAU) / TAU;
    d.setUint16(o + 11, Math.round(turn * 65535) & 0xffff, true);
    d.setInt8(o + 13, clampI8(c.pitch * 200));
    d.setInt8(o + 14, clampI8(c.roll * 200));
  }
  return buf;
}
/** Null when the frame is not a well formed list of held cars. */
export function decodeHeld(buf: ArrayBuffer): { id: number; cars: HeldCar[] } | null {
  const len = buf.byteLength;
  if (len < HELD_HEADER_BYTES) return null;
  const d = new DataView(buf);
  if (d.getUint8(0) !== Frame.Event || d.getUint8(2) !== PlayerEvent.Held) return null;
  const n = d.getUint8(3);
  if (n > HELD_MAX || HELD_HEADER_BYTES + n * HELD_CAR_BYTES > len) return null;
  const cars: HeldCar[] = [];
  for (let i = 0, o = HELD_HEADER_BYTES; i < n; i++, o += HELD_CAR_BYTES) {
    const sd = d.getUint8(o);
    cars.push({
      slot: sd & 7, damage: sd >> 4, kind: d.getUint8(o + 1),
      color: (d.getUint8(o + 2) << 16) | (d.getUint8(o + 3) << 8) | d.getUint8(o + 4),
      x: d.getUint16(o + 5, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(o + 7, true) * TRAFFIC_STEP + TRAFFIC_Z0,
      y: d.getInt16(o + 9, true) / 100, yaw: (d.getUint16(o + 11, true) / 65535) * TAU,
      pitch: d.getInt8(o + 13) / 200, roll: d.getInt8(o + 14) / 200,
    });
  }
  return { id: d.getUint8(1), cars };
}

// ---- Missions done together (stage 4, step 3; net/crew.ts) ----
//
// All Event frames (byte 2 PlayerEvent.Crew), so a guest who starts a mission can speak to the others: only the host
// may send a ToPlayer. Byte 3 says which. Nothing in them is text: an objective is the mission's number and a step's,
// and every browser reads the words from its own copy of the story. Still version 4: the service relays an Event
// unread (up to MAX_PLAYER_FRAME_BYTES), and a page that does not know the code ignores it.
//
// Team, 6 + n:  3 CrewKind.Team  4 mission u8 (1 + its index in the story; 0 = none any more)  5 n u8  6.. n ids u8
//   The starter's crew. Sent when the mission begins (a retry is a beginning) and when the crew changes.
// Show, 14 + 6 per mark:  3 CrewKind.Show  4 mission u8  5 step u8  6 what u8 (CrewObj)  7 arg u8
//   8 timer label u8 (CrewLabel, or below CrewLabel.Step the step whose label it is)  9 timer mode u8 (CrewTimer)
//   10 urgent u8  11 value u16 (tenths of a second, or whole meters)  13 n u8
//   per mark: x u16  z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0)  r u8 (half meters)  look u8 (bits 0-1 CrewMark,
//   bit 2 a radar blip, bit 3 the place the route goes to, bits 4-7 the column's height in 4 m)
// End, 6:  3 CrewKind.End  4 mission u8  5 how u8 (CrewEnd: 1 passed, 2 failed, 3 set aside)  6 why u8 (1 + index in FAILS, 0 none)
// Reply, 6:  3 CrewKind.Reply  4 starter u8  5 yes u8   (a drafted player: in, or busy with something of their own)
// Ask, 6:  3 CrewKind.Ask  4 starter u8  5 slot u8   (a helper at the door of the starter's held car in that slot)
// Lend, 8:  3 CrewKind.Lend  4 to u8  5 slot u8  6 yes u8  7 health u8
// Back, 26:  3 CrewKind.Back  4 starter u8  5 flags u8 (1 burnt out, 2 sunk)  6 health u8  7 kind u8
//   8 x f32  12 y f32  16 z f32  20 yaw u16  22 vx i16  24 vz i16 (cm/s)   (a helper out of the car: it goes back)
// Reclaim, 6:  3 CrewKind.Reclaim  4 to u8  5 keep u8   (1: the mission is over and the car is theirs, an ordinary
//   car; 0: the script has taken it away)
// (Stage 4, step 3, second piece.) In Show, byte 10 is now: bit 0 urgent; bit 1 "the clock's rate follows"; bits 2-7
//   the rate the starter's mission clock runs at against the wall clock, q / 62 (63: exactly 1; 0 with bit 1: paused).
//   A Show without bit 1 (an older page) is read as the wall clock, as before.
// Things, 6 + 7 per person:  3 CrewKind.Things  4 mission u8  5 n u8  per person: step u8 (the `spawnActor` step that
//   made them: every browser reads the look and the tag from its own copy of the story)  x u16  z u16 (5 cm steps from
//   TRAFFIC_X0, TRAFFIC_Z0)  yaw u8 (256ths of a turn)  flags u8 (bit 0 down)   (the mission's people, on change)
// (Stage 4, step 5.) Hit, 9:  3 CrewKind.Hit  4 starter u8  5 slot u8 (the starter's held car, as in its Held list)
//   6 how u8 (CrewHitHow: 1 rounds or a fist, 2 a ram)  7 damage u16 (hundredths of health)   (a helper's claim on a
//   target: the starter's browser, which owns the car, applies it within reach and the rate a helper could do it)
export const CrewKind = { Team: 1, Show: 2, End: 3, Reply: 4, Ask: 5, Lend: 6, Back: 7, Reclaim: 8, Things: 9, Hit: 10 } as const;
export const CrewHitHow = { Rounds: 1, Ram: 2 } as const;
export const CREW_HIT_BYTES = 9;
export function encodeCrewHit(starter: number, slot: number, how: number, damage: number): ArrayBuffer {
  const [buf, d] = crewFrame(CrewKind.Hit, CREW_HIT_BYTES);
  d.setUint8(4, starter & 0xff); d.setUint8(5, slot & 0xff); d.setUint8(6, how & 0xff);
  d.setUint16(7, clampU16(damage * 100), true);
  return buf;
}
export function decodeCrewHit(buf: ArrayBuffer): { id: number; starter: number; slot: number; how: number; damage: number } | null {
  if (buf.byteLength < CREW_HIT_BYTES) return null;
  const d = new DataView(buf);
  return { id: d.getUint8(1), starter: d.getUint8(4), slot: d.getUint8(5), how: d.getUint8(6), damage: d.getUint16(7, true) / 100 };
}
export const CrewObj = { None: 0, Step: 1, GetBackIn: 2, Ring: 3 } as const;
export const CrewTimer = { None: 0, Running: 1, Still: 2, Meters: 3 } as const;
/** Timer labels that are not a step's own. A smaller number is the index of the `timer` step whose label it is. */
export const CrewLabel = { Step: 240, PastDue: 249, Following: 250, Losing: 251, TooClose: 252, HoldOut: 253, Par: 254 } as const;
export const CrewMark = { Goal: 0, Item: 1, None: 2 } as const;
export const CrewEnd = { Passed: 1, Failed: 2, Aside: 3 } as const;
export const CREW_HEADER_BYTES = 4;
export const CREW_SHOW_BYTES = 14;
export const CREW_MARK_BYTES = 6;
/** (96 - 14) / 6: as many marks as one frame holds. */
export const CREW_MARKS_MAX = 13;
export const CREW_BACK_BYTES = 26;
export interface CrewMarkRec { x: number; z: number; r: number; kind: number; blip: boolean; target: boolean; tall: number }
export interface CrewShowRec { mission: number; step: number; what: number; arg: number; label: number; mode: number; urgent: boolean; value: number; marks: CrewMarkRec[]; rate: number }
export const CREW_THING_BYTES = 7;
/** Mission people in one Things frame (the stories have one at a time; (96 - 6) / 7 would be 12). */
export const CREW_THINGS_MAX = 8;
export interface CrewThingRec { step: number; x: number; z: number; yaw: number; down: boolean }
export function encodeCrewThings(mission: number, things: readonly CrewThingRec[], n: number): ArrayBuffer {
  n = Math.min(n, things.length, CREW_THINGS_MAX);
  const [buf, d] = crewFrame(CrewKind.Things, 6 + n * CREW_THING_BYTES);
  d.setUint8(4, mission & 0xff); d.setUint8(5, n);
  for (let i = 0, o = 6; i < n; i++, o += CREW_THING_BYTES) {
    const t = things[i];
    d.setUint8(o, t.step & 0xff);
    d.setUint16(o + 1, clampU16((t.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 3, clampU16((t.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setUint8(o + 5, Math.round(((((t.yaw % TAU) + TAU) % TAU) / TAU) * 256) & 0xff);
    d.setUint8(o + 6, t.down ? 1 : 0);
  }
  return buf;
}
export function decodeCrewThings(buf: ArrayBuffer): { id: number; mission: number; things: CrewThingRec[] } | null {
  if (buf.byteLength < 6) return null;
  const d = new DataView(buf), n = d.getUint8(5);
  if (n > CREW_THINGS_MAX || 6 + n * CREW_THING_BYTES > buf.byteLength) return null;
  const things: CrewThingRec[] = [];
  for (let i = 0, o = 6; i < n; i++, o += CREW_THING_BYTES) {
    things.push({
      step: d.getUint8(o), x: d.getUint16(o + 1, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(o + 3, true) * TRAFFIC_STEP + TRAFFIC_Z0,
      yaw: (d.getUint8(o + 5) / 256) * TAU, down: (d.getUint8(o + 6) & 1) === 1,
    });
  }
  return { id: d.getUint8(1), mission: d.getUint8(4), things };
}
export interface CrewBackRec { flags: number; health: number; kind: number; x: number; y: number; z: number; yaw: number; vx: number; vz: number }

function crewFrame(kind: number, bytes: number): [ArrayBuffer, DataView] {
  const buf = makeFrame(Frame.Event, bytes - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Crew); d.setUint8(3, kind);
  return [buf, d];
}
/** The sender's id and which crew frame it is; null when it is not one. */
export function crewKindOf(buf: ArrayBuffer): { id: number; kind: number } | null {
  if (buf.byteLength < CREW_HEADER_BYTES) return null;
  const u = new Uint8Array(buf, 0, 4);
  return u[0] === Frame.Event && u[2] === PlayerEvent.Crew ? { id: u[1], kind: u[3] } : null;
}
export function encodeCrewTeam(mission: number, ids: readonly number[]): ArrayBuffer {
  const n = Math.min(ids.length, MAX_PLAYER_FRAME_BYTES - 6);
  const [buf, d] = crewFrame(CrewKind.Team, 6 + n);
  d.setUint8(4, mission & 0xff); d.setUint8(5, n);
  for (let i = 0; i < n; i++) d.setUint8(6 + i, ids[i] & 0xff);
  return buf;
}
export function decodeCrewTeam(buf: ArrayBuffer): { id: number; mission: number; ids: number[] } | null {
  if (buf.byteLength < 6) return null;
  const d = new DataView(buf), n = d.getUint8(5);
  if (6 + n > buf.byteLength) return null;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(d.getUint8(6 + i));
  return { id: d.getUint8(1), mission: d.getUint8(4), ids };
}
export function encodeCrewShow(s: CrewShowRec): ArrayBuffer {
  const n = Math.min(s.marks.length, CREW_MARKS_MAX);
  const [buf, d] = crewFrame(CrewKind.Show, CREW_SHOW_BYTES + n * CREW_MARK_BYTES);
  d.setUint8(4, s.mission & 0xff); d.setUint8(5, s.step & 0xff); d.setUint8(6, s.what & 0xff); d.setUint8(7, s.arg & 0xff);
  d.setUint8(8, s.label & 0xff); d.setUint8(9, s.mode & 0xff);
  const q = s.rate >= 0.995 ? 63 : Math.max(0, Math.min(62, Math.round(s.rate * 62)));
  d.setUint8(10, (s.urgent ? 1 : 0) | 2 | (q << 2));
  d.setUint16(11, clampU16(s.value), true); d.setUint8(13, n);
  for (let i = 0, o = CREW_SHOW_BYTES; i < n; i++, o += CREW_MARK_BYTES) {
    const m = s.marks[i];
    d.setUint16(o, clampU16((m.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
    d.setUint16(o + 2, clampU16((m.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
    d.setUint8(o + 4, Math.max(0, Math.min(255, Math.round(m.r * 2))));
    d.setUint8(o + 5, (m.kind & 3) | (m.blip ? 4 : 0) | (m.target ? 8 : 0) | (Math.max(0, Math.min(15, Math.round(m.tall / 4))) << 4));
  }
  return buf;
}
export function decodeCrewShow(buf: ArrayBuffer): (CrewShowRec & { id: number }) | null {
  if (buf.byteLength < CREW_SHOW_BYTES) return null;
  const d = new DataView(buf), n = d.getUint8(13);
  if (n > CREW_MARKS_MAX || CREW_SHOW_BYTES + n * CREW_MARK_BYTES > buf.byteLength) return null;
  const marks: CrewMarkRec[] = [];
  for (let i = 0, o = CREW_SHOW_BYTES; i < n; i++, o += CREW_MARK_BYTES) {
    const l = d.getUint8(o + 5);
    marks.push({
      x: d.getUint16(o, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(o + 2, true) * TRAFFIC_STEP + TRAFFIC_Z0,
      r: d.getUint8(o + 4) / 2, kind: l & 3, blip: !!(l & 4), target: !!(l & 8), tall: (l >> 4) * 4,
    });
  }
  return {
    id: d.getUint8(1), mission: d.getUint8(4), step: d.getUint8(5), what: d.getUint8(6), arg: d.getUint8(7),
    label: d.getUint8(8), mode: d.getUint8(9), urgent: (d.getUint8(10) & 1) === 1, value: d.getUint16(11, true), marks,
    rate: rateOf(d.getUint8(10)),
  };
}
function rateOf(b: number): number { if (!(b & 2)) return 1; const q = b >> 2; return q === 63 ? 1 : q / 62; }
/** End, Reply, Ask and Reclaim: three small numbers after the kind. */
export function encodeCrewSmall(kind: number, a: number, b = 0, c = 0): ArrayBuffer {
  const [buf, d] = crewFrame(kind, kind === CrewKind.End ? 7 : 6);
  d.setUint8(4, a & 0xff); d.setUint8(5, b & 0xff);
  if (kind === CrewKind.End) d.setUint8(6, c & 0xff);
  return buf;
}
export function decodeCrewSmall(buf: ArrayBuffer): { id: number; kind: number; a: number; b: number; c: number } | null {
  if (buf.byteLength < 6) return null;
  const u = new Uint8Array(buf);
  return { id: u[1], kind: u[3], a: u[4], b: u[5], c: buf.byteLength > 6 ? u[6] : 0 };
}
export function encodeCrewLend(to: number, slot: number, yes: boolean, health: number): ArrayBuffer {
  const [buf, d] = crewFrame(CrewKind.Lend, 8);
  d.setUint8(4, to & 0xff); d.setUint8(5, slot & 0xff); d.setUint8(6, yes ? 1 : 0); d.setUint8(7, Math.max(0, Math.min(255, Math.round(health))));
  return buf;
}
export function decodeCrewLend(buf: ArrayBuffer): { id: number; to: number; slot: number; yes: boolean; health: number } | null {
  if (buf.byteLength < 8) return null;
  const u = new Uint8Array(buf);
  return { id: u[1], to: u[4], slot: u[5], yes: u[6] === 1, health: u[7] };
}
export function encodeCrewBack(starter: number, r: CrewBackRec): ArrayBuffer {
  const [buf, d] = crewFrame(CrewKind.Back, CREW_BACK_BYTES);
  d.setUint8(4, starter & 0xff); d.setUint8(5, r.flags & 0xff); d.setUint8(6, Math.max(0, Math.min(255, Math.round(r.health)))); d.setUint8(7, r.kind & 0xff);
  d.setFloat32(8, r.x, true); d.setFloat32(12, r.y, true); d.setFloat32(16, r.z, true);
  d.setUint16(20, Math.round(((((r.yaw % TAU) + TAU) % TAU) / TAU) * 65535) & 0xffff, true);
  d.setInt16(22, clampI16(r.vx * 100), true); d.setInt16(24, clampI16(r.vz * 100), true);
  return buf;
}
export function decodeCrewBack(buf: ArrayBuffer): (CrewBackRec & { id: number; starter: number }) | null {
  if (buf.byteLength < CREW_BACK_BYTES) return null;
  const d = new DataView(buf);
  const r = {
    id: d.getUint8(1), starter: d.getUint8(4), flags: d.getUint8(5), health: d.getUint8(6), kind: d.getUint8(7),
    x: d.getFloat32(8, true), y: d.getFloat32(12, true), z: d.getFloat32(16, true), yaw: (d.getUint16(20, true) / 65535) * TAU,
    vx: d.getInt16(22, true) / 100, vz: d.getInt16(24, true) / 100,
  };
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z) ? r : null;
}

// ---- Jobs shown to the others (stage 4, step 5; net/jobs.ts) ----
//
// Job, 14: an Event frame (byte 2 PlayerEvent.Job), sent by the player running a job, only when something the others
// are shown changes (and once to somebody who arrives). The runner's browser is the authority; jobs stay personal.
//   3 job u8 (JobKind: 0 none)  4 state u8 (taxi: JobRider; courier: parcels still in the van; tow: 1 on the hook)
//   5 x u16  7 z u16 (5 cm steps from TRAFFIC_X0, TRAFFIC_Z0: the waiting rider)  9 yaw u8 (256ths of a turn)
//   10 look u8 (the rider's look, a seed every browser turns into the same person)  11 slot u8 (tow: the towed car's
//   slot in the runner's Held list; 255 none)  12 total u8 (courier: parcels the run began with)  13 spare
export const JobKind = { None: 0, Taxi: 1, Courier: 2, Tow: 3 } as const;
export const JobRider = { None: 0, Waiting: 1, Aboard: 2 } as const;
export const JOB_BYTES = 14;
export interface JobRec { job: number; state: number; x: number; z: number; yaw: number; look: number; slot: number; total: number }
export function blankJob(): JobRec { return { job: 0, state: 0, x: 0, z: 0, yaw: 0, look: 0, slot: 255, total: 0 }; }
export function encodeJob(r: JobRec): ArrayBuffer {
  const buf = makeFrame(Frame.Event, JOB_BYTES - FRAME_HEADER_BYTES);
  const d = new DataView(buf);
  d.setUint8(2, PlayerEvent.Job); d.setUint8(3, r.job & 0xff); d.setUint8(4, r.state & 0xff);
  d.setUint16(5, clampU16((r.x - TRAFFIC_X0) / TRAFFIC_STEP), true);
  d.setUint16(7, clampU16((r.z - TRAFFIC_Z0) / TRAFFIC_STEP), true);
  d.setUint8(9, Math.round(((((r.yaw % TAU) + TAU) % TAU) / TAU) * 256) & 0xff);
  d.setUint8(10, r.look & 0xff); d.setUint8(11, r.slot & 0xff); d.setUint8(12, r.total & 0xff);
  return buf;
}
export function decodeJob(buf: ArrayBuffer): (JobRec & { id: number }) | null {
  if (buf.byteLength < JOB_BYTES) return null;
  const d = new DataView(buf);
  return {
    id: d.getUint8(1), job: d.getUint8(3), state: d.getUint8(4),
    x: d.getUint16(5, true) * TRAFFIC_STEP + TRAFFIC_X0, z: d.getUint16(7, true) * TRAFFIC_STEP + TRAFFIC_Z0,
    yaw: (d.getUint8(9) / 256) * TAU, look: d.getUint8(10), slot: d.getUint8(11), total: d.getUint8(12),
  };
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
  /** 1 when the service takes Frame.Bundle (older services leave it out: then frames go one by one). */
  b?: number;
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

// ---- Races between players (fun queue item 11; net/race.ts, game/race.ts) ----
//
// All Event frames (byte 2 PlayerEvent.Race), relayed unread by both services; a page from before races ignores code 16
// (index.ts hands codes it does not know to fight.ts, which does nothing with them). Still protocol v5.
//   3 kind (RaceKind)  4 caller u8 (whose race: the player who called it)  5 route u8 (index in Activities.races)
//   Call, 9 + n:  6 laps u8  7 seconds left to join u8  8 n u8  9.. n ids u8 (the caller first, then who joined)
//   Join, 7:      6 in u8 (1 joined, 0 left before the start)
//   Go, 10 + n:   6 laps u8  7..8 ms until GO u16  9 n u8  10.. n ids u8 in grid order (slot 0 on pole)
//   Cp, 11:       6 checkpoints passed u8  7..10 ms since GO u32
//   Done, 15:     6 how u8 (1 finished, 2 out)  7..10 race ms u32  11..14 best lap ms u32
//   Off, 6:       the caller called it off before the start
// The record of a route is a durable fact, written by the host only: RACE_FACT_PREFIX + route =
//   [lap tenths, lap holder's name 3 numbers (-1 = no third word), race tenths, race holder's name 3 numbers, laps].
export const RaceKind = { Call: 1, Join: 2, Go: 3, Cp: 4, Done: 5, Off: 6 } as const;
export const RACE_FACT_PREFIX = 'race.';
export const RACE_MAX = 8;
export interface RaceMsg { id: number; kind: number; caller: number; route: number; laps: number; secs: number; ms: number; lap: number; count: number; how: number; ids: number[] }
export function blankRace(): RaceMsg { return { id: 0, kind: 0, caller: 0, route: 0, laps: 0, secs: 0, ms: 0, lap: 0, count: 0, how: 0, ids: [] }; }

export function encodeRace(m: RaceMsg): ArrayBuffer {
  const ids = m.ids.slice(0, RACE_MAX);
  const len = m.kind === RaceKind.Call ? 9 + ids.length : m.kind === RaceKind.Join ? 7 : m.kind === RaceKind.Go ? 10 + ids.length
    : m.kind === RaceKind.Cp ? 11 : m.kind === RaceKind.Done ? 15 : 6;
  const buf = makeFrame(Frame.Event, len - FRAME_HEADER_BYTES);
  const d = new DataView(buf), u = new Uint8Array(buf);
  u[2] = PlayerEvent.Race; u[3] = m.kind & 0xff; u[4] = m.caller & 0xff; u[5] = m.route & 0xff;
  const u32 = (v: number): number => Math.max(0, Math.min(0xffffffff, Math.round(v)));
  if (m.kind === RaceKind.Call) { u[6] = m.laps & 0xff; u[7] = Math.max(0, Math.min(255, Math.round(m.secs))); u[8] = ids.length; ids.forEach((v, i) => { u[9 + i] = v & 0xff; }); }
  else if (m.kind === RaceKind.Join) u[6] = m.how ? 1 : 0;
  else if (m.kind === RaceKind.Go) { u[6] = m.laps & 0xff; d.setUint16(7, clampU16(m.ms), true); u[9] = ids.length; ids.forEach((v, i) => { u[10 + i] = v & 0xff; }); }
  else if (m.kind === RaceKind.Cp) { u[6] = m.count & 0xff; d.setUint32(7, u32(m.ms), true); }
  else if (m.kind === RaceKind.Done) { u[6] = m.how & 0xff; d.setUint32(7, u32(m.ms), true); d.setUint32(11, u32(m.lap), true); }
  return buf;
}

export function decodeRace(buf: ArrayBuffer): RaceMsg | null {
  if (buf.byteLength < 6) return null;
  const d = new DataView(buf), u = new Uint8Array(buf);
  if (u[0] !== Frame.Event || u[2] !== PlayerEvent.Race) return null;
  const m = blankRace();
  m.id = u[1]; m.kind = u[3]; m.caller = u[4]; m.route = u[5];
  const n = buf.byteLength;
  if (m.kind === RaceKind.Call) { if (n < 9) return null; m.laps = u[6]; m.secs = u[7]; for (let i = 0; i < Math.min(u[8], RACE_MAX) && 9 + i < n; i++) m.ids.push(u[9 + i]); }
  else if (m.kind === RaceKind.Join) { if (n < 7) return null; m.how = u[6]; }
  else if (m.kind === RaceKind.Go) { if (n < 10) return null; m.laps = u[6]; m.ms = d.getUint16(7, true); for (let i = 0; i < Math.min(u[9], RACE_MAX) && 10 + i < n; i++) m.ids.push(u[10 + i]); }
  else if (m.kind === RaceKind.Cp) { if (n < 11) return null; m.count = u[6]; m.ms = d.getUint32(7, true); }
  else if (m.kind === RaceKind.Done) { if (n < 15) return null; m.how = u[6]; m.ms = d.getUint32(7, true); m.lap = d.getUint32(11, true); }
  else if (m.kind !== RaceKind.Off) return null;
  return m;
}

// ---- Hot Pursuit: police chase between players (fun queue item 12; net/pursuit.ts, game/pursuit.ts) ----
//
// Event frames (byte 2 PlayerEvent.Pursuit), relayed unread by both services, like races; a page from before Hot
// Pursuit hands code 17 to fight.ts, which does nothing with it. Still protocol v5, no service change. One layout for
// every kind, 15 + n bytes:
//   3 kind (PursuitKind)  4 caller u8 (whose round)  5 station u8 (0 island, 1 mainland)
//   6 a u8  7 b u8  8..9 c u16  10..13 ms u32  14 n u8  15.. n ids u8
//   Call:  a seconds left to join, b 1 = the cop is drawn at random, ids who is in (the caller first)
//   Join:  a 1 joined, 0 left before the start
//   Go:    a the cop's id, b head start s, c round s (after the head start), ids every player in the round
//   Siren: a 1 on, 0 off (the cop)
//   Hold:  a how full the wanted player's BUSTED bar is, 0..255 (the wanted player, while it changes)
//   Bust:  ms since the cop was let go (the wanted player: their own screen judged it)
//   Done:  a role (1 cop, 2 escaped, 3 busted), b busts (the cop's), ms survived as wanted
//   Off:   the caller called it off
// Town records are durable facts written by the host only: PURSUIT_FACT_BUSTS = [busts, holder's name 3 numbers],
// PURSUIT_FACT_ESCAPE = [seconds survived as wanted, holder's name 3 numbers] (-1 = no third word).
export const PursuitKind = { Call: 1, Join: 2, Go: 3, Siren: 4, Hold: 5, Bust: 6, Done: 7, Off: 8 } as const;
export const PURSUIT_FACT_BUSTS = 'pursuit.busts';
export const PURSUIT_FACT_ESCAPE = 'pursuit.escape';
export const PURSUIT_MAX = 8;
export interface PursuitMsg { id: number; kind: number; caller: number; station: number; a: number; b: number; c: number; ms: number; ids: number[] }

export function encodePursuit(m: PursuitMsg): ArrayBuffer {
  const ids = m.ids.slice(0, PURSUIT_MAX);
  const buf = makeFrame(Frame.Event, 15 + ids.length - FRAME_HEADER_BYTES);
  const d = new DataView(buf), u = new Uint8Array(buf);
  u[2] = PlayerEvent.Pursuit; u[3] = m.kind & 0xff; u[4] = m.caller & 0xff; u[5] = m.station & 0xff;
  u[6] = Math.max(0, Math.min(255, Math.round(m.a))); u[7] = Math.max(0, Math.min(255, Math.round(m.b)));
  d.setUint16(8, clampU16(m.c), true);
  d.setUint32(10, Math.max(0, Math.min(0xffffffff, Math.round(m.ms))), true);
  u[14] = ids.length; ids.forEach((v, i) => { u[15 + i] = v & 0xff; });
  return buf;
}

export function decodePursuit(buf: ArrayBuffer): PursuitMsg | null {
  if (buf.byteLength < 15) return null;
  const d = new DataView(buf), u = new Uint8Array(buf);
  if (u[0] !== Frame.Event || u[2] !== PlayerEvent.Pursuit || u[3] < 1 || u[3] > 8) return null;
  const m: PursuitMsg = { id: u[1], kind: u[3], caller: u[4], station: u[5], a: u[6], b: u[7], c: d.getUint16(8, true), ms: d.getUint32(10, true), ids: [] };
  for (let i = 0; i < Math.min(u[14], PURSUIT_MAX) && 15 + i < buf.byteLength; i++) m.ids.push(u[15 + i]);
  return m;
}

// ---- Demolition derby at Flounder Field (fun queue item 13; net/derby.ts, game/derby.ts) ----
//
// Event frames (byte 2 PlayerEvent.Derby), relayed unread by both services, like races and Hot Pursuit; a page from
// before the derby hands code 18 to fight.ts, which does nothing with it. Still protocol v5, no service change. Event
// frames are capped at MAX_PLAYER_FRAME_BYTES (96), so one layout, 14 + n bytes:
//   3 kind (DerbyKind)  4 caller u8 (whose derby)  5 a u8  6 b u8  7..8 c u16  9..12 ms u32  13 n u8  14.. n bytes
//   Call:  a seconds left to join, bytes: who is in (the caller first)
//   Join:  a 1 joined, 0 left before the start
//   Go:    a AI drivers, b seed, c round s, bytes: players in grid order (AI ids are DERBY_AI + k, after them)
//   Cars:  the caller's AI cars, DERBY_CAR_BYTES each: id, x i16 and z i16 (cm*5 from the bowl's middle), heading u8,
//          speed i8 (m/s*2), steer i8 (*100), hp u8, hits u8, out u8 (1 out)
//   Dents: the caller's AI cars' damage, 1 + 8 bytes each (id, CarDamage.pack)
//   Stat:  a player's own car: a hp, b 1 out, c hits
//   End:   the caller: the order (winner first), then each one's hits, n = 2 x cars
//   Done:  each player at the podium: a their wins (career, this one counted), c hits this derby (for the records)
//   Off:   the caller called it off
// Town records are durable facts written by the host only: DERBY_FACT_WINS = [wins, holder's name 3 numbers],
// DERBY_FACT_HITS = [hits in one derby, holder's name 3 numbers].
export const DerbyKind = { Call: 1, Join: 2, Go: 3, Cars: 4, Dents: 5, Stat: 6, End: 7, Done: 8, Off: 9 } as const;
export const DERBY_FACT_WINS = 'derby.wins';
export const DERBY_FACT_HITS = 'derby.hits';
export const DERBY_AI = 200;
export const DERBY_CAR_BYTES = 10;
export const DERBY_HEADER = 14;
export const DERBY_MAX_BYTES = MAX_PLAYER_FRAME_BYTES - DERBY_HEADER;
export interface DerbyMsg { id: number; kind: number; caller: number; a: number; b: number; c: number; ms: number; bytes: number[] }

export function encodeDerby(m: DerbyMsg): ArrayBuffer {
  const b = m.bytes.slice(0, DERBY_MAX_BYTES);
  const buf = makeFrame(Frame.Event, DERBY_HEADER + b.length - FRAME_HEADER_BYTES);
  const d = new DataView(buf), u = new Uint8Array(buf);
  u[2] = PlayerEvent.Derby; u[3] = m.kind & 0xff; u[4] = m.caller & 0xff;
  u[5] = Math.max(0, Math.min(255, Math.round(m.a))); u[6] = Math.max(0, Math.min(255, Math.round(m.b)));
  d.setUint16(7, clampU16(m.c), true);
  d.setUint32(9, Math.max(0, Math.min(0xffffffff, Math.round(m.ms))), true);
  u[13] = b.length; b.forEach((v, i) => { u[DERBY_HEADER + i] = v & 0xff; });
  return buf;
}

export function decodeDerby(buf: ArrayBuffer): DerbyMsg | null {
  if (buf.byteLength < DERBY_HEADER) return null;
  const d = new DataView(buf), u = new Uint8Array(buf);
  if (u[0] !== Frame.Event || u[2] !== PlayerEvent.Derby || u[3] < 1 || u[3] > 9) return null;
  const m: DerbyMsg = { id: u[1], kind: u[3], caller: u[4], a: u[5], b: u[6], c: d.getUint16(7, true), ms: d.getUint32(9, true), bytes: [] };
  for (let i = 0; i < u[13] && DERBY_HEADER + i < buf.byteLength; i++) m.bytes.push(u[DERBY_HEADER + i]);
  return m;
}
