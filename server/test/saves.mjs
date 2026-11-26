// Local test of the cloud saves API (src/saves.ts). From server/:
//   node test/saves.mjs            against the Node home (home/main.ts, files in a throwaway folder), port 8795
//   node test/saves.mjs --worker   against the Worker and its Durable Object (wrangler dev, no account, no network), port 8796
// Starts its own copy, restarts it once to prove the saves survive, stops it. PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = process.argv.includes('--worker');
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = WORKER ? 8796 : 8795;
const URL = `http://127.0.0.1:${PORT}/save`;
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

// ---- the logic alone, with a movable clock and a memory store: expiry, and the daily allowance ----
{
  const S = await import('../src/saves.ts');
  const { FileBackend } = await import('../home/savefile.ts');
  const mem = mkdtempSync(join(tmpdir(), 'pc-saves-mem-'));
  const st = S.newState(new FileBackend(mem), { dayOps: 12 });
  const k1 = 'a'.repeat(43), k2 = 'b'.repeat(43);
  const run = async (q, t) => S.handleSave(JSON.stringify(q), st, t);
  const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
  await run({ op: 'put', k: k1, base: 0, at: 1, doc: { save: { v: 1, when: 1 } } }, T0);
  const c = (await run({ op: 'link', k: k1 }, T0)).body.code;
  let r = await run({ op: 'claim', k: k2, code: c }, T0 + S.CODE_TTL_MS + 1000);
  check(r.status === 404, 'a code is dead after ten minutes (logic test, clock moved)', String(r.status));
  const c2 = (await run({ op: 'link', k: k1 }, T0 + 1000)).body.code;
  r = await run({ op: 'claim', k: k2, code: c2 }, T0 + S.CODE_TTL_MS - 1000);
  check(r.status === 200, 'and alive just before that');
  const c3 = (await run({ op: 'link', k: k1 }, T0 + 2000)).body;
  const c4 = (await run({ op: 'link', k: k1 }, T0 + 3000)).body;
  r = await run({ op: 'claim', k: 'c'.repeat(43), code: c3.code }, T0 + 4000);
  check(r.status === 404, 'asking for a new code kills the old one');
  let busy = 0;
  for (let i = 0; i < 8; i++) { const x = await run({ op: 'get', k: k1 }, T0 + 5000 + i * 700_000 / 8); if (x.status === 503) busy++; }
  check(busy > 0, 'past the daily allowance the service says busy (503)', String(busy));
  r = await run({ op: 'get', k: k1 }, T0 + 86_400_000);
  check(r.status === 200, 'and the next UTC day it is open again', String(r.status));
  void c4;
  rmSync(mem, { recursive: true, force: true });
}

const dir = mkdtempSync(join(tmpdir(), 'pc-saves-'));
let child = null;
async function start() {
  child = WORKER
    ? spawn(join(serverDir, 'node_modules', '.bin', 'wrangler'), ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', dir, '--show-interactive-dev-session=false'],
      { cwd: serverDir, detached: true, stdio: 'ignore', shell: process.platform === 'win32', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } })
    : spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(serverDir, 'home', 'main.ts')],
      { cwd: serverDir, stdio: 'ignore', env: { ...process.env, PC_PORT: String(PORT), PC_STATE: dir, PC_RELEASE: 'test-saves' } });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error('the service did not start');
}
async function stop() {
  if (!child) return;
  const gone = new Promise((r) => child.once('exit', r));
  try { if (WORKER && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch { /* gone */ }
  await Promise.race([gone, sleep(6000)]);
  child = null;
  await sleep(500);
}

const b64 = (u8) => Buffer.from(u8).toString('base64url');
const secret = () => b64(crypto.getRandomValues(new Uint8Array(32)));
async function call(body, { origin = ORIGIN, raw = null, headers = {} } = {}) {
  let r;
  try { r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'text/plain', ...(origin ? { origin } : {}), ...headers }, body: raw ?? JSON.stringify(body) }); } catch { return { s: 0, j: null, h: new Headers() }; }
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  return { s: r.status, j, h: r.headers };
}
const doc = (n, extra = {}) => ({ save: { v: 1, when: 1000 + n, player: { x: n, z: 0 }, ...extra }, progress: { spans: n, stage: 0, bank: 0, total: n } });

try {
  await start();
  const A = secret(), B = secret(), C = secret();

  let r = await call({ op: 'get', k: A });
  check(r.s === 404 && r.j.err === 'unknown', 'an unknown device gets 404 on get');
  r = await call({ op: 'put', k: A, base: 0, at: 1000, doc: doc(1) });
  check(r.s === 200 && r.j.rev === 1, 'first put creates the save at rev 1', JSON.stringify(r.j));
  check(r.h.get('access-control-allow-origin') === ORIGIN, 'CORS echoes the allowed origin');
  r = await call({ op: 'get', k: A });
  check(r.s === 200 && r.j.rev === 1 && r.j.doc.save.player.x === 1 && r.j.devices === 1, 'get returns the document', JSON.stringify(r.j).slice(0, 120));
  r = await call({ op: 'put', k: A, base: 1, at: 2000, doc: doc(2) });
  check(r.s === 200 && r.j.rev === 2, 'put at the current rev advances it');
  r = await call({ op: 'put', k: A, base: 1, at: 2500, doc: doc(3) });
  check(r.s === 409 && r.j.rev === 2, 'put at a stale rev is a 409 with the stored rev');
  r = await call({ op: 'put', k: A, base: 1, at: 2500, doc: doc(3), force: true });
  check(r.s === 200 && r.j.rev === 3, 'force overwrites');
  r = await call({ op: 'put', k: C, base: 4, at: 1, doc: doc(1) });
  check(r.s === 404, 'a never-seen device cannot put with a rev above 0');

  // sizes and shapes
  const big = { save: { v: 1, when: 1, pad: 'x'.repeat(70000) } };
  r = await call({ op: 'put', k: A, base: 3, at: 1, doc: big });
  check(r.s === 413, 'an oversize document is refused (413)', String(r.s));
  r = await call(null, { raw: 'x'.repeat(200000) });
  check(r.s === 413 || r.s === 400 || r.s === 0, 'an oversize body is refused before parsing (or the connection is cut)', String(r.s));
  r = await call({ op: 'put', k: A, base: 3, at: 1, doc: { save: 'no' } });
  check(r.s === 400, 'a document with the wrong outline is refused');
  r = await call({ op: 'put', k: A, base: 3, at: 1, doc: { save: { v: 1, when: 1 }, extra: 1 } });
  check(r.s === 400, 'a document with extra top-level keys is refused');
  r = await call({ op: 'get', k: 'short' });
  check(r.s === 400, 'a malformed secret is refused');
  r = await call(null, { raw: '{nope' });
  check(r.s === 400, 'not JSON is refused');
  r = await call({ op: 'get', k: A }, { origin: 'https://evil.example' });
  check(r.s === 403, 'a foreign origin is refused (403)');
  r = await call({ op: 'get', k: A }, { origin: null });
  check(r.s === 403, 'no origin is refused');
  r = await fetch(URL, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
  check(r.status === 204, 'a preflight is answered');
  r = await fetch(URL, { method: 'GET', headers: { origin: ORIGIN } });
  check(r.status === 405, 'GET /save is 405');

  // linking
  r = await call({ op: 'link', k: A });
  const code = r.j && r.j.code;
  check(r.s === 200 && /^[A-HJ-NP-Z2-9]{8}$/.test(code) && r.j.ttl === 600, 'link gives an 8-letter code, ten minutes', code);
  r = await call({ op: 'claim', k: B, code: 'ZZZZZZZZ' });
  check(r.s === 404 && r.j.err === 'badcode', 'a wrong code fails');
  r = await call({ op: 'claim', k: B, code: code.slice(0, 4).toLowerCase() + '-' + code.slice(4) });
  check(r.s === 200 && r.j.rev === 3, 'the right code (lower case, with a dash) links B', JSON.stringify(r.j));
  r = await call({ op: 'claim', k: C, code });
  check(r.s === 404 && r.j.err === 'badcode', 'the same code cannot be used twice');
  r = await call({ op: 'get', k: B });
  check(r.s === 200 && r.j.doc.save.player.x === 3 && r.j.devices === 2, 'B reads the shared save', JSON.stringify(r.j).slice(0, 100));
  r = await call({ op: 'put', k: B, base: 3, at: 5000, doc: doc(7) });
  check(r.s === 200 && r.j.rev === 4, 'B writes');
  r = await call({ op: 'get', k: A });
  check(r.s === 200 && r.j.rev === 4 && r.j.doc.save.player.x === 7, 'A sees what B wrote');
  r = await call({ op: 'get', k: C });
  check(r.s === 404, 'a device that was never linked sees nothing of it');
  r = await call({ op: 'claim', k: C, code: null });
  check(r.s === 404, 'a missing code fails cleanly');

  // restart keeps it
  await stop();
  if (!WORKER) check(readdirSync(join(dir, 'saves')).filter((n) => n.endsWith('.json')).length === 1, 'one file per save on disk');
  if (!WORKER) {
    const text = readdirSync(join(dir, 'saves')).map((n) => readFileSync(join(dir, 'saves', n), 'utf8')).join('');
    check(!text.includes(A) && !text.includes(B), 'the files hold no device secret, only hashes');
  }
  await start();
  r = await call({ op: 'get', k: B });
  check(r.s === 200 && r.j.rev === 4 && r.j.doc.save.player.x === 7 && r.j.devices === 2, 'after a restart the save and both devices are still there');

  // an expired code (the home's clock cannot be moved, so only the Node home can be asked for a short life: skipped for the Worker)
  // unlink
  r = await call({ op: 'unlink', k: B });
  check(r.s === 200, 'B unlinks');
  r = await call({ op: 'get', k: B });
  check(r.s === 404, 'B no longer sees the save');
  r = await call({ op: 'get', k: A });
  check(r.s === 200 && r.j.devices === 1, 'A still has it');
  r = await call({ op: 'unlink', k: A });
  r = await call({ op: 'get', k: A });
  check(r.s === 404, 'the last device out deletes the save');
  if (!WORKER) check(readdirSync(join(dir, 'saves')).filter((n) => n.endsWith('.json')).length === 0, 'its file is gone');

  // claim moves a device that had its own save
  const D = secret(), E = secret();
  await call({ op: 'put', k: D, base: 0, at: 1, doc: doc(1) });
  await call({ op: 'put', k: E, base: 0, at: 1, doc: doc(9) });
  r = await call({ op: 'link', k: D });
  r = await call({ op: 'claim', k: E, code: r.j.code });
  check(r.s === 200 && r.j.rev === 1, 'a device with its own save can claim another\'s code');
  r = await call({ op: 'get', k: E });
  check(r.j.doc.save.player.x === 1 && r.j.devices === 2, 'and then shares that one');

  // rate limits: put 20 per 10 minutes per device
  const F = secret();
  let rev = 0, limited = 0;
  for (let i = 0; i < 25; i++) { const x = await call({ op: 'put', k: F, base: rev, at: i, doc: doc(i) }); if (x.s === 200) rev = x.j.rev; else if (x.s === 429) limited++; }
  check(rev === 20 && limited === 5, 'a device is held to 20 puts in 10 minutes', `${rev} ok, ${limited} limited`);

  // link attempts: 12 wrong codes pause all claims
  const G = secret();
  const codes = [];
  for (let i = 0; i < 16; i++) { const x = await call({ op: 'claim', k: secret(), code: 'ABCDEFG' + 'HJKLMNPQRSTUVWXYZ'[i] }); codes.push(x.s); }
  const n404 = codes.filter((s) => s === 404).length;
  check(n404 === 12 && codes.slice(0, n404).every((s) => s === 404) && codes.slice(n404).every((s) => s === 429), 'after 12 wrong codes claims pause (429)', codes.join(','));
  r = await call({ op: 'link', k: D });
  check(r.s === 200, 'making a code still works while claims are paused');
  r = await call({ op: 'claim', k: G, code: r.j.code });
  check(r.s === 429, 'but a correct code cannot be claimed during the pause either');
} catch (e) {
  check(false, 'the test ran to the end', String((e && e.stack) || e).slice(0, 500));
} finally {
  await stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
