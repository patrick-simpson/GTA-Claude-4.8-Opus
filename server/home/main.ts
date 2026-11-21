// The MAIN home of the message service: a Node program for the owner's always-on mini PC.
// It is a thin wrapper round the SAME room as the Cloudflare backup (../src/room.ts): a WebSocket
// server (the `ws` package), a small JSON file for the durable facts, and a /health line.
// The same Origin rule, the same caps, the same 8 seats. No daily budget and no resting here: this
// home has no daily limits.
//
// Node 22.18 or newer runs this file as it is (it strips the types): there is no build step.
//
//   node main.ts          listens on 127.0.0.1 ONLY (the tunnel is the only way in)
//
// Environment (all optional):
//   PC_PORT      the port (8788)
//   PC_STATE     the folder for facts.json (./state)
//   PC_RELEASE   what /health reports as "release" (else the RELEASE file beside the code, else "dev")
//   PC_CURRENT   a symlink to the release in use; when it stops pointing at this copy, exit so that
//                systemd starts the new one (how a self-update takes effect without any privilege)
//   PC_SEATS     LOCAL TESTS ONLY: fewer seats (it can never raise the cap)
//
// Privacy: it never reads or prints a caller's address, and it logs no per-connection lines at all.

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import {
  CITY_CAP, Close, FULL_RETRY_S, HTTP_BAD_HELLO, HTTP_BAD_ORIGIN, MAX_HOST_FRAME_BYTES, PROTOCOL_VERSION, isAllowedOrigin,
} from '../../src/net/protocol.ts';
import type { FactValue, FullMsg } from '../../src/net/protocol.ts';
import { Room, parseNameParam } from '../src/room.ts';
import type { RoomEnv, RoomSocket } from '../src/room.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PC_PORT) || 8788;
const STATE = process.env.PC_STATE || join(process.cwd(), 'state');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The self-update writes the release's name in a file called RELEASE beside the code. */
function releaseName(): string {
  try {
    return process.env.PC_RELEASE || readFileSync(join(ROOT, 'RELEASE'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
}
const RELEASE = releaseName().replace(/[^\w.-]/g, '').slice(0, 40);
const CURRENT = process.env.PC_CURRENT || '';
const SEATS = Math.max(1, Math.min(CITY_CAP, Math.floor(Number(process.env.PC_SEATS)) || CITY_CAP));
const FACTS_FILE = join(STATE, 'facts.json');

/** Sockets open at once, seated or being refused. Past this the door answers 503 without an upgrade. */
const MAX_SOCKETS = 64;
/** A frame bigger than this never reaches the room (the room's own caps are far lower and close with 4001). */
const MAX_PAYLOAD = MAX_HOST_FRAME_BYTES * 4;
/** A player whose connection is this far behind is dropped rather than buffered for. */
const MAX_BUFFERED = 1 << 20;
/** WebSocket pings: they keep a quiet socket open through the tunnel and find the dead ones. */
const PING_MS = 25_000;
const CURRENT_CHECK_MS = 5_000;

const startedAt = Date.now();
function log(line: string): void {
  console.log(line); // journald adds the time
}

// ---- the room's view of the world ----

class Sock implements RoomSocket {
  alive = true;
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
  }
  send(data: string | ArrayBuffer): void {
    const ws = this.ws;
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return;
    }
    try {
      ws.send(data, { binary: typeof data !== 'string' });
    } catch { /* closing; its close event tidies up */ }
  }
  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch { /* already closed */ }
  }
}

let wakeTimer: NodeJS.Timeout | null = null;
const env: RoomEnv = {
  now: () => Date.now(),
  loadFacts(): Record<string, FactValue> {
    try {
      const v: unknown = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, FactValue>;
    } catch { /* no file yet, or a damaged one: start with no facts */ }
    return {};
  },
  saveFacts(rows: [string, FactValue][]): void {
    // The file holds every fact (there are at most 32 small ones): read, merge, write beside, rename.
    const all = env.loadFacts();
    for (const [k, v] of rows) all[k] = v;
    try {
      mkdirSync(STATE, { recursive: true });
      writeFileSync(FACTS_FILE + '.tmp', JSON.stringify(all));
      renameSync(FACTS_FILE + '.tmp', FACTS_FILE);
    } catch (e) {
      log(`facts not stored: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  },
  wakeAt(at: number): void {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      room.wake();
    }, Math.max(0, at - Date.now()));
  },
  saveSeat(): void { /* this wrapper never loses its memory */ },
};
const room = new Room(env, SEATS);

// ---- the door ----

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
const open = new Set<WebSocket>();
let joins = 0;
let messages = 0;

function plain(status: number, text: string, extra: Record<string, string> = {}): [number, Record<string, string>, string] {
  return [status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }, text];
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'cache-control': 'no-store' }).end();
  } else if (path === '/health') {
    // Nothing private: no names, no addresses, nothing about the machine.
    const body = JSON.stringify({
      ok: true, service: 'port-calamity-home', v: PROTOCOL_VERSION, release: RELEASE,
      uptime: Math.round((Date.now() - startedAt) / 1000), seats: room.seats, players: room.size,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body + '\n');
  } else {
    const [status, headers, text] = plain(200, `port-calamity-home v${PROTOCOL_VERSION}, ${room.seats} seats\n`);
    res.writeHead(status, headers).end(text);
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: text/plain; charset=utf-8\r\ncache-control: no-store\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  socket.on('error', () => {});
  const origin = req.headers.origin;
  if (!isAllowedOrigin(typeof origin === 'string' ? origin : null)) return refuseUpgrade(socket, HTTP_BAD_ORIGIN, 'origin not allowed\n');
  let q: URLSearchParams;
  try {
    q = new URL(req.url ?? '/', 'http://x').searchParams;
  } catch {
    return refuseUpgrade(socket, HTTP_BAD_HELLO, 'bad request\n');
  }
  if (q.get('v') !== String(PROTOCOL_VERSION)) return refuseUpgrade(socket, HTTP_BAD_HELLO, 'wrong protocol version\n');
  const name = parseNameParam(q.get('name'));
  if (!name) return refuseUpgrade(socket, HTTP_BAD_HELLO, 'bad name\n');
  if (open.size >= MAX_SOCKETS) return refuseUpgrade(socket, 503, 'busy\n');

  wss.handleUpgrade(req, socket, head, (ws) => {
    open.add(ws);
    ws.on('error', () => {});
    if (room.full) {
      // A browser cannot read a refused upgrade: the socket opens, says one thing and closes.
      const full: FullMsg = { t: 'full', retry: FULL_RETRY_S, seats: room.seats };
      ws.on('close', () => open.delete(ws));
      ws.send(JSON.stringify(full));
      ws.close(Close.Full, 'full');
      return;
    }
    const s = new Sock(ws);
    ws.binaryType = 'arraybuffer';
    ws.on('pong', () => { s.alive = true; });
    ws.on('message', (data: ArrayBuffer, isBinary: boolean) => {
      messages++;
      room.message(s, isBinary ? data : Buffer.from(data).toString('utf8'));
    });
    ws.on('close', () => {
      open.delete(ws);
      clearInterval(beat);
      room.leave(s);
    });
    const beat = setInterval(() => {
      if (!s.alive) return ws.terminate();
      s.alive = false;
      try {
        ws.ping();
      } catch { /* closing */ }
    }, PING_MS);
    joins++;
    room.join(s, name);
  });
});

// ---- running ----

let stopping = false;
function stop(why: string): void {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why}); ${joins} joins and ${messages} messages since the start`);
  room.wake(); // store any facts still waiting
  for (const ws of open) {
    try {
      ws.close(1001, 'restarting');
    } catch { /* gone */ }
  }
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => stop('asked to'));
process.on('SIGINT', () => stop('asked to'));
// A bug must not leave a half-alive process: say what it was (no addresses are ever in these) and let systemd restart it.
process.on('uncaughtException', (e) => {
  log(`crashed: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});

if (CURRENT) {
  // A self-update switches the "current" link to a new copy of the code. This copy then steps aside.
  const mine = realpathSync(ROOT);
  setInterval(() => {
    let now = mine;
    try {
      now = realpathSync(CURRENT);
    } catch { /* mid-switch: look again next time */ }
    if (now !== mine) stop('a newer version is installed');
  }, CURRENT_CHECK_MS).unref();
}

setInterval(() => {
  if (joins > 0 || messages > 0) log(`hour: ${room.size} of ${room.seats} seats taken now; ${joins} joins and ${messages} messages since the start`);
}, 3_600_000).unref();

server.on('error', (e) => {
  log(`cannot listen on loopback port ${PORT}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => log(`port-calamity-home release ${RELEASE}, protocol ${PROTOCOL_VERSION}, ${room.seats} seats, listening on loopback port ${PORT}`));
