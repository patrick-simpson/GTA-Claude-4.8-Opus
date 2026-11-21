// "Where is main": the home computer's address changes whenever its free tunnel restarts, so it tells
// the backup Worker where it is, and the game asks the Worker. This file is what both ends agree on:
// the numbers, the signed message and its check. No Cloudflare types and no Node types (it uses only
// WebCrypto, which both have), so the Worker, the home computer and the tests all import it.
//
// There is NO shared secret. The home computer signs each registration with an Ed25519 private key
// that never leaves it; the Worker checks the signature against the public key committed in
// mainkey.ts. A registration is { u, t, n, sig }: the address, the sender's clock, a counter that
// only goes up, and the signature over all three. The Worker refuses a bad signature, a clock more
// than MAIN_STALE_MS away from its own, a counter it has already seen (both together stop a replay),
// and any address that is not https://<name>.trycloudflare.com.

import { isMainAddress } from '../../src/net/protocol.ts';

/**
 * The home computer registers when its address changes and, otherwise, this often. Each one costs
 * the backup 1 Worker request, 1 Durable Object request, 2 rows written and (as budget.ts estimates
 * it, an upper bound) 1.28 GB-s. At 30 minutes that is 48 a day: 0.12% of the 40,000 request pause
 * lines, 0.24% of the row line and 1.2% of the 5,200 GB-s line.
 */
export const MAIN_HEARTBEAT_MS = 30 * 60_000;
/** No heartbeat for this long (two missed, and some slack): the Worker forgets the address. */
export const MAIN_OVERDUE_MS = 70 * 60_000;
/** A registration whose clock is further than this from the Worker's is refused. */
export const MAIN_STALE_MS = 5 * 60_000;
/** How long a Worker isolate answers "where is main" from its own memory before asking the town again. */
export const MAIN_MEMO_MS = 60_000;
/** How long a browser may reuse the answer without asking at all (Cache-Control max-age, seconds). */
export const MAIN_CACHE_S = 60;
/** A registration is a few hundred characters; anything longer is not read. */
export const MAIN_BODY_MAX = 600;

export interface Registration {
  u: string;
  t: number;
  n: number;
  /** Ed25519 over registrationText(u, t, n), base64url. */
  sig: string;
}

/** Exactly the bytes that are signed. */
export function registrationText(u: string, t: number, n: number): string {
  return `port-calamity-main-v1\n${u}\n${t}\n${n}`;
}

/** A raw Ed25519 public key as base64url is 43 characters. The placeholder in mainkey.ts is not. */
export function isRealKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The shape only (types, sizes, the address rule). Null for anything else. */
export function parseRegistration(text: string): Registration | null {
  if (text.length > MAIN_BODY_MAX) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.u !== 'string' || typeof r.sig !== 'string' || r.sig.length !== 86) return null;
  if (!Number.isSafeInteger(r.t) || !Number.isSafeInteger(r.n) || (r.t as number) <= 0 || (r.n as number) <= 0) return null;
  if (!isMainAddress(r.u)) return null;
  return { u: r.u, t: r.t as number, n: r.n as number, sig: r.sig };
}

/** True when `r` was signed by the holder of the private half of `key`. Never throws. */
export async function verifyRegistration(key: string, r: Registration): Promise<boolean> {
  const pub = isRealKey(key) ? fromBase64Url(key) : null;
  const sig = fromBase64Url(r.sig);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const k = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, k, sig, new TextEncoder().encode(registrationText(r.u, r.t, r.n)));
  } catch {
    return false;
  }
}
