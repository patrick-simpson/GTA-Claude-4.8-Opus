// Cloud saves: one small JSON document per player, kept beside the town (fun queue 2, item 41).
//
// This file is the whole logic and is shared by both homes of the service: the Cloudflare Worker's Durable Object
// (savesDo.ts, SQLite) and the Node home (home/savefile.ts, a folder of files). It has no Cloudflare or Node types:
// storage comes in through SaveBackend (synchronous, like both of them), the clock as an argument. It must import
// nothing outside server/src: the home computer's self-update copies only server/home, server/src and protocol.ts.
//
// The wire: ONE endpoint, POST /save, a JSON body sent as text/plain (so the browser needs no CORS preflight), at most
// BODY_MAX bytes. Nothing is ever in a URL. `op` says what is asked:
//   get    {k}                              -> {rev, at, devices, doc}
//   put    {k, base, at, doc, force?}       -> {rev}            (409 {rev, at} when `base` is not the stored rev)
//   link   {k}                              -> {code, ttl}      (a one-time code to type on another device)
//   claim  {k, code}                        -> {rev, at}        (this device now shares the code's save)
//   unlink {k}                              -> {}               (this device leaves; the last one out deletes the save)
// `k` is the device's secret: 43 random URL-safe letters made by the browser. The server never stores it, only its
// SHA-256, so a copy of the database cannot be used to read or write anybody's save. Several devices (several
// secrets) can share one save: that is what linking does. There are no names, no addresses and no accounts; the
// save itself is the game's own document (what the player has and has done), nothing else.
//
// Limits (all answered before any storage is touched where possible): the document is at most DOC_MAX characters
// and has a fixed outline; per device 20 puts, 40 gets and 6 link codes per 10 minutes; a code is 8 characters of
// a 32-letter alphabet, lives 10 minutes, and dies on first use, right or wrong; claims are limited per device and
// across the whole service, and after 12 wrong codes in 10 minutes claims pause until the window clears; at most
// MAX_SAVES saves and 200 new ones an hour; a daily allowance of operations so the shared Cloudflare account is
// never put at risk (answered 503 "busy" past it).

export const SAVE_PATH = '/save';
/** The largest document, in characters of JSON. A real save is a few KB. */
export const DOC_MAX = 64 * 1024;
export const BODY_MAX = DOC_MAX + 2048;
export const CODE_LEN = 8;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_DEVICES = 6;

export interface SaveLimits {
  /** Operations and puts a UTC day may hold in all. */
  dayOps: number; dayPuts: number;
  /** Saves kept, and new saves an hour. */
  maxSaves: number; newPerHour: number;
  /** Per device in 10 minutes. */
  put: number; get: number; link: number; claim: number;
  /** Wrong codes in 10 minutes, service-wide, before claims pause. */
  claimFails: number;
}
export const DEFAULT_LIMITS: SaveLimits = { dayOps: 8000, dayPuts: 5000, maxSaves: 20000, newPerHour: 200, put: 20, get: 40, link: 6, claim: 5, claimFails: 12 };

export interface SaveRow { rev: number; at: number; doc: string }
export interface CodeRow { h: string; id: string; exp: number }

/** Storage, synchronous. `hash` values are SHA-256 hex; `id` is a random hex id of a save. */
export interface SaveBackend {
  deviceSave(hash: string): string | null;
  readSave(id: string): SaveRow | null;
  writeSave(id: string, row: SaveRow): void;
  addDevice(hash: string, id: string): void;
  removeDevice(hash: string): void;
  deviceCount(id: string): number;
  deleteSave(id: string): void;
  /** Store a code for `id`, replacing any other code that save had. */
  putCode(h: string, id: string, exp: number): void;
  /** Remove and return a code (single use). */
  takeCode(h: string): CodeRow | null;
  purgeCodes(now: number): void;
  countSaves(): number;
}

/** A sliding count of events by key, in memory (a restart forgets it, which only ever lets one more through). */
export class Limiter {
  private readonly m = new Map<string, number[]>();
  /** Count one event now; false when `max` have already happened in the last `ms`. */
  hit(key: string, max: number, ms: number, now: number): boolean {
    const a = (this.m.get(key) ?? []).filter((t) => now - t < ms);
    if (a.length >= max) { this.m.set(key, a); return false; }
    a.push(now);
    this.m.set(key, a);
    if (this.m.size > 6000) this.sweep(now, ms);
    return true;
  }
  count(key: string, ms: number, now: number): number { return (this.m.get(key) ?? []).filter((t) => now - t < ms).length; }
  private sweep(now: number, ms: number): void {
    for (const [k, a] of this.m) if (!a.some((t) => now - t < ms)) this.m.delete(k);
  }
}

export interface SaveState {
  backend: SaveBackend;
  limiter: Limiter;
  limits: SaveLimits;
  day: string; ops: number; puts: number;
}
export function newState(backend: SaveBackend, limits: Partial<SaveLimits> = {}): SaveState {
  return { backend, limiter: new Limiter(), limits: { ...DEFAULT_LIMITS, ...limits }, day: '', ops: 0, puts: 0 };
}

export interface SaveReply { status: number; body: Record<string, unknown> }
const fail = (status: number, err: string, extra: Record<string, unknown> = {}): SaveReply => ({ status, body: { ok: 0, err, ...extra } });
const ok = (body: Record<string, unknown> = {}): SaveReply => ({ status: 200, body: { ok: 1, ...body } });

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const TEN_MIN = 10 * 60_000;

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}
/** Equal-length strings compared without stopping at the first difference. */
export function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function randomHex(bytes: number): string {
  const u = new Uint8Array(bytes);
  crypto.getRandomValues(u);
  let s = '';
  for (const b of u) s += b.toString(16).padStart(2, '0');
  return s;
}
export function makeCode(): string {
  const u = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(u);
  let s = '';
  for (const b of u) s += CODE_ALPHABET[b & 31];
  return s;
}
/** What a person typed, made into a code: upper case, spaces and dashes dropped. Null when it cannot be one. */
export function cleanCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 24) return null;
  const c = v.toUpperCase().replace(/[\s-]/g, '');
  return c.length === CODE_LEN && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The outline of a document: {save: {v, when, ...}, progress?: {...}} and nothing else at the top. Anything inside `save` the game itself sanitizes. */
function goodDoc(d: unknown): d is { save: Record<string, unknown>; progress?: Record<string, unknown> } {
  if (!isObj(d)) return false;
  for (const k of Object.keys(d)) if (k !== 'save' && k !== 'progress') return false;
  const s = d.save;
  if (!isObj(s) || typeof s.v !== 'number' || !Number.isFinite(s.v) || typeof s.when !== 'number' || !Number.isFinite(s.when)) return false;
  if (d.progress !== undefined && !isObj(d.progress)) return false;
  return true;
}

/** Answer one request body. `text` is already read and bounded by the caller (BODY_MAX); this re-checks anyway. */
export async function handleSave(text: string, st: SaveState, now: number): Promise<SaveReply> {
  if (text.length > BODY_MAX) return fail(413, 'too big');
  let q: unknown;
  try { q = JSON.parse(text); } catch { return fail(400, 'not json'); }
  if (!isObj(q) || typeof q.op !== 'string' || typeof q.k !== 'string' || !SECRET.test(q.k)) return fail(400, 'bad request');
  const L = st.limits, B = st.backend, lim = st.limiter;

  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== st.day) { st.day = day; st.ops = 0; st.puts = 0; }
  if (st.ops >= L.dayOps) return fail(503, 'busy');
  st.ops++;

  const dev = await sha256Hex('pc-device:' + q.k);
  const id = B.deviceSave(dev);

  switch (q.op) {
    case 'get': {
      if (!lim.hit('get:' + dev, L.get, TEN_MIN, now)) return fail(429, 'slow down');
      if (!id) return fail(404, 'unknown');
      const row = B.readSave(id);
      if (!row) return fail(404, 'unknown');
      return ok({ rev: row.rev, at: row.at, devices: B.deviceCount(id), doc: JSON.parse(row.doc) });
    }
    case 'put': {
      if (!lim.hit('put:' + dev, L.put, TEN_MIN, now)) return fail(429, 'slow down');
      if (!goodDoc(q.doc)) return fail(400, 'bad document');
      const docText = JSON.stringify(q.doc);
      if (docText.length > DOC_MAX) return fail(413, 'too big');
      const at = typeof q.at === 'number' && Number.isFinite(q.at) ? Math.max(0, Math.min(q.at, now + 86_400_000)) : now;
      const base = typeof q.base === 'number' && Number.isInteger(q.base) && q.base >= 0 ? q.base : -1;
      if (base < 0) return fail(400, 'bad request');
      if (st.puts >= L.dayPuts) return fail(503, 'busy');
      if (!id) {
        if (base !== 0) return fail(404, 'unknown');
        if (B.countSaves() >= L.maxSaves || !lim.hit('new', L.newPerHour, 3_600_000, now)) return fail(503, 'busy');
        const nid = randomHex(16);
        st.puts++;
        B.writeSave(nid, { rev: 1, at, doc: docText });
        B.addDevice(dev, nid);
        return ok({ rev: 1 });
      }
      const row = B.readSave(id);
      if (!row) return fail(404, 'unknown');
      if (q.force !== true && base !== row.rev) return fail(409, 'changed', { rev: row.rev, at: row.at });
      st.puts++;
      B.writeSave(id, { rev: row.rev + 1, at, doc: docText });
      return ok({ rev: row.rev + 1 });
    }
    case 'link': {
      B.purgeCodes(now);
      if (!lim.hit('link:' + dev, L.link, TEN_MIN, now)) return fail(429, 'slow down');
      if (!id) return fail(404, 'unknown');
      if (B.deviceCount(id) >= MAX_DEVICES) return fail(409, 'full');
      const code = makeCode();
      B.putCode(await sha256Hex('pc-code:' + code), id, now + CODE_TTL_MS);
      return ok({ code, ttl: CODE_TTL_MS / 1000 });
    }
    case 'claim': {
      B.purgeCodes(now);
      if (!lim.hit('claim:' + dev, L.claim, TEN_MIN, now) || !lim.hit('claim-all', L.claim * 40, TEN_MIN, now)) return fail(429, 'slow down');
      if (lim.count('claim-fail', TEN_MIN, now) >= L.claimFails) return fail(429, 'slow down');
      const code = cleanCode(q.code);
      const h = code ? await sha256Hex('pc-code:' + code) : null;
      const row = h ? B.takeCode(h) : null;
      if (!row || !h || !safeEq(row.h, h) || row.exp < now) {
        lim.hit('claim-fail', 1e9, TEN_MIN, now);
        return fail(404, 'badcode');
      }
      const target = B.readSave(row.id);
      if (!target) return fail(404, 'badcode');
      if (id === row.id) return ok({ rev: target.rev, at: target.at });
      if (B.deviceCount(row.id) >= MAX_DEVICES) return fail(409, 'full');
      B.addDevice(dev, row.id);
      if (id && B.deviceCount(id) === 0) B.deleteSave(id);
      return ok({ rev: target.rev, at: target.at });
    }
    case 'unlink': {
      if (id) {
        B.removeDevice(dev);
        if (B.deviceCount(id) === 0) B.deleteSave(id);
      }
      return ok();
    }
    default:
      return fail(400, 'bad request');
  }
}

/** CORS headers for an allowed origin (the caller has checked it): the answer is for that page alone. */
export function corsHeaders(origin: string): Record<string, string> {
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
}
