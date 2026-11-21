// The tunnel's supervisor, on the home computer. It is the PARENT of `cloudflared`: it starts a free
// quick tunnel to the game service on this machine, reads the temporary address the tunnel was given
// (https://<name>.trycloudflare.com, different after every restart), checks the game really answers
// through it, and tells the backup Worker "main is here", signed, now and as a slow heartbeat.
// If the tunnel dies or stops carrying traffic it exits, and systemd starts a fresh one.
//
//   node tunnel.ts          run the tunnel and keep it registered
//   node tunnel.ts --key    make the key pair if there is none, print the PUBLIC key, and stop
//
// The key pair (Ed25519) is made here on first use. The private half stays in PC_KEYDIR, readable
// by the service user only; the public half is what the owner passes to the lead. See ../src/where.ts.
//
// Environment:
//   PC_PORT         the local game service (8788)
//   PC_KEYDIR       where main.key, main.pub and the counter live (./state/key)
//   PC_CLOUDFLARED  the cloudflared program ("cloudflared")
//   PC_CURRENT      the "current release" link; when what it points at differs in anything this
//                   program depends on, exit so the new one starts (a self-update)
//   PC_REGISTER     LOCAL TESTS ONLY: register at this address instead (http://127.0.0.1:<port> and
//                   nothing else is accepted), and check the game locally instead of through the tunnel
//
// Privacy: cloudflared's own output is never passed on (it names servers by number). The few lines
// printed here hold no address but the tunnel's public name.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_HOST, MAIN_PATH, isMainAddress } from '../../src/net/protocol.ts';
import { MAIN_HEARTBEAT_MS, registrationText } from '../src/where.ts';
import type { Registration } from '../src/where.ts';

const PORT = Number(process.env.PC_PORT) || 8788;
const KEYDIR = process.env.PC_KEYDIR || join(process.cwd(), 'state', 'key');
const CLOUDFLARED = process.env.PC_CLOUDFLARED || 'cloudflared';
const CURRENT = process.env.PC_CURRENT || '';
const TEST_REGISTER = /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(process.env.PC_REGISTER ?? '') ? String(process.env.PC_REGISTER) : '';
const REGISTER_URL = TEST_REGISTER ? TEST_REGISTER + MAIN_PATH : BACKUP_HOST ? `https://${BACKUP_HOST}${MAIN_PATH}` : '';
const LOCAL = `http://127.0.0.1:${PORT}`;

/** cloudflared has this long to print an address, and the address this long to start carrying traffic. */
const ADDRESS_WAIT_MS = 90_000;
const REACH_WAIT_MS = 120_000;
/** The tunnel is looked through this often; this many failures in a row (with the game itself up) and it is replaced. */
const CHECK_MS = 5 * 60_000;
const CHECK_FAILS = 3;
/** A registration that fails is tried again after these waits (then at the last one until the next heartbeat). */
const RETRY_MS = [30_000, 60_000, 300_000];
const CURRENT_CHECK_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const KEY_ONLY = process.argv.includes('--key');
function log(line: string): void {
  if (KEY_ONLY) console.error(line); // --key prints the key and nothing else
  else console.log(line);
}

// ---- the key pair ----

const KEY_FILE = join(KEYDIR, 'main.key');
const PUB_FILE = join(KEYDIR, 'main.pub');
const COUNTER_FILE = join(KEYDIR, 'counter');

/** The private key, made on first use. Also (re)writes main.pub, the public half as 43 characters. */
function loadKey() {
  mkdirSync(KEYDIR, { recursive: true, mode: 0o700 });
  let pem: string;
  try {
    pem = readFileSync(KEY_FILE, 'utf8');
  } catch {
    pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(KEY_FILE, pem, { mode: 0o600, flag: 'wx' });
    log('made a new key pair');
  }
  chmodSync(KEY_FILE, 0o600);
  const key = createPrivateKey(pem);
  const pub = String(createPublicKey(key).export({ format: 'jwk' }).x);
  writeFileSync(PUB_FILE, pub + '\n', { mode: 0o644 });
  return { key, pub };
}

/** A counter that only goes up, even if its file is lost: never below the clock. */
function nextCounter(): number {
  let last = 0;
  try {
    last = Number(readFileSync(COUNTER_FILE, 'utf8')) || 0;
  } catch { /* first time */ }
  const n = Math.max(last + 1, Date.now());
  try {
    writeFileSync(COUNTER_FILE + '.tmp', String(n));
    renameSync(COUNTER_FILE + '.tmp', COUNTER_FILE);
  } catch { /* the clock keeps it rising anyway */ }
  return n;
}

const { key, pub } = loadKey();
if (KEY_ONLY) {
  console.log(pub);
  process.exit(0);
}

// ---- small checks ----

async function getJson(url: string, ms: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'error', headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    const v: unknown = await res.json();
    return v && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
/** Is this the game's own /health line? */
async function isHome(base: string): Promise<boolean> {
  const h = await getJson(base + '/health', 10_000);
  return !!h && h.service === 'port-calamity-home';
}

/** Everything this program depends on, as one short string: when "current" gives a different one, restart. */
function fingerprint(root: string): string {
  const h = createHash('sha256');
  for (const f of ['server/home/tunnel.ts', 'server/src/where.ts', 'src/net/protocol.ts']) h.update(readFileSync(join(root, f)));
  let cf = CLOUDFLARED;
  try {
    cf = realpathSync(CLOUDFLARED);
  } catch { /* found on the PATH, or not there: its name stands for it */ }
  return h.update(cf).digest('hex').slice(0, 16);
}

// ---- cloudflared ----

let child: ChildProcess | null = null;
let ending = false;
function end(code: number, why: string): void {
  if (ending) return;
  ending = true;
  log(`stopping: ${why}`);
  const c = child;
  if (c && c.exitCode === null) {
    c.kill('SIGTERM');
    setTimeout(() => c.kill('SIGKILL'), 4000).unref();
    c.once('exit', () => process.exit(code));
    setTimeout(() => process.exit(code), 5000);
  } else process.exit(code);
}
process.on('SIGTERM', () => end(0, 'asked to'));
process.on('SIGINT', () => end(0, 'asked to'));
process.on('uncaughtException', (e) => {
  log(`crashed: ${e && e.stack ? e.stack : String(e)}`);
  end(1, 'a bug');
});

/** Starts the quick tunnel and resolves with its address, or null if none was printed in time. */
function startTunnel(): Promise<string | null> {
  return new Promise((resolve) => {
    const c = child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', LOCAL], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    let found = false;
    const timer = setTimeout(() => resolve(null), ADDRESS_WAIT_MS);
    c.stderr!.setEncoding('utf8');
    c.stderr!.on('data', (d: string) => {
      if (found) return; // after the address nothing it prints is kept, or shown
      tail = (tail + d).slice(-4000);
      for (const m of tail.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)) {
        if (m[0] === 'https://api.trycloudflare.com' || !isMainAddress(m[0])) continue;
        found = true;
        tail = '';
        clearTimeout(timer);
        resolve(m[0]);
        return;
      }
    });
    c.on('error', (e) => end(1, `cloudflared could not be started (${(e as NodeJS.ErrnoException).code ?? 'error'})`));
    c.on('exit', (code) => end(1, `cloudflared stopped (exit ${code ?? 'by signal'})`));
  });
}

// ---- registering ----

/** One signed "main is here". 204 when the Worker took it; its refusal otherwise; 0 when it could not be reached. */
async function register(u: string): Promise<number> {
  const t = Date.now();
  const n = nextCounter();
  const reg: Registration = { u, t, n, sig: sign(null, Buffer.from(registrationText(u, t, n)), key).toString('base64url') };
  try {
    const res = await fetch(REGISTER_URL, { method: 'POST', body: JSON.stringify(reg), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (res.status === 204) return 204;
    const said = (await res.text()).replace(/[^\w :.,-]/g, ' ').trim().slice(0, 80);
    log(`registration refused (${res.status}${said ? ': ' + said : ''})${res.status === 401 ? '; is this computer\'s clock right?' : ''}`);
    return res.status;
  } catch {
    log('registration not delivered (the backup could not be reached)');
    return 0;
  }
}

async function keepRegistered(u: string): Promise<void> {
  if (!REGISTER_URL) {
    log('not registering: this version of the game has no backup address yet (nothing to do; an update will bring it)');
    return;
  }
  let said = false;
  for (;;) {
    let status = await register(u);
    // 403 = the backup has no public key yet (the lead has not pasted it in): asking sooner than the heartbeat is waste.
    for (let i = 0; status !== 204 && status !== 403; i++) {
      await sleep(RETRY_MS[Math.min(i, RETRY_MS.length - 1)]);
      status = await register(u);
    }
    if (status === 204 && !said) {
      log('registered with the backup: the game can now find this computer');
      said = true;
    }
    await sleep(MAIN_HEARTBEAT_MS);
  }
}

// ---- main ----

log(`public key: ${pub}`);
// The game service first: there is no point in a tunnel to nothing.
for (let i = 0; !(await isHome(LOCAL)); i++) {
  if (i === 0) log('waiting for the game service on this computer');
  await sleep(5000);
}
const address = await startTunnel();
if (!address) end(1, 'cloudflared gave no address');
else {
  const through = TEST_REGISTER ? LOCAL : address;
  const until = Date.now() + REACH_WAIT_MS;
  let reached = false;
  while (!reached && Date.now() < until) {
    reached = await isHome(through);
    if (!reached) await sleep(4000);
  }
  if (!reached) end(1, 'the tunnel has an address but carries nothing');
  else {
    log(`tunnel up: ${address}`);
    void keepRegistered(address);

    // Is the tunnel still carrying traffic? (Quick tunnels do die quietly.) The game being down is not the tunnel's fault.
    let fails = 0;
    setInterval(async () => {
      if (await isHome(through)) fails = 0;
      else if (await isHome(LOCAL)) {
        if (++fails >= CHECK_FAILS) end(1, 'the tunnel stopped carrying traffic');
      }
    }, CHECK_MS);

    if (CURRENT) {
      const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
      const mine = fingerprint(root);
      setInterval(() => {
        let now = mine;
        try {
          now = fingerprint(realpathSync(CURRENT));
        } catch { /* mid-switch: look again next time */ }
        if (now !== mine) end(0, 'a newer version is installed');
      }, CURRENT_CHECK_MS);
    }
  }
}
