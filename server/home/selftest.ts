// The self-update's check of a new version BEFORE it is switched to: the candidate is started on a
// spare port, and this joins it as a player would. Exit 0 = it seats a player and answers; 1 = not.
//
//   node selftest.ts <port> [release]

import WebSocket from 'ws';
import { KEEPALIVE_FRAME, PING_TEXT, PONG_TEXT, PROTOCOL_VERSION, cityUrl } from '../../src/net/protocol.ts';

const port = Number(process.argv[2]);
const release = process.argv[3] ?? '';
function fail(why: string): never {
  console.log(`selftest failed: ${why}`);
  process.exit(1);
}
setTimeout(() => fail('timed out'), 15_000);

const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
const health = res && res.ok ? await res.json() as { ok?: boolean; v?: number; release?: string; seats?: number } : null;
if (!health || health.ok !== true || health.v !== PROTOCOL_VERSION || !(Number(health.seats) >= 1)) fail('/health did not answer as expected');
if (release && health.release !== release) fail('/health names another release');

const ws = new WebSocket(cityUrl(`ws://127.0.0.1:${port}`, [1, 2]), { origin: 'https://gta.doofus.live' });
ws.on('error', () => fail('could not connect'));
ws.on('unexpected-response', () => fail('the join was refused'));
let welcomed = false;
ws.on('message', (data, isBinary) => {
  const text = isBinary ? '' : data.toString();
  if (!welcomed) {
    let m: { t?: string; v?: number; id?: number } = {};
    try {
      m = JSON.parse(text);
    } catch { /* fails below */ }
    if (m.t !== 'welcome' || m.v !== PROTOCOL_VERSION || !(Number(m.id) >= 1)) fail('no welcome');
    welcomed = true;
    ws.send(KEEPALIVE_FRAME);
    ws.send(PING_TEXT);
  } else if (text === PONG_TEXT) {
    ws.close(1000);
    console.log('selftest passed');
    process.exit(0);
  }
});
