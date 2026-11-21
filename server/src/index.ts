// The Worker in front of the cities. It answers one thing: a WebSocket upgrade from the game.
// It checks the Origin, checks the name, and hands the socket to city 1, or to city 2 when city 1
// is full, and so on. It never reads or logs the caller's address.

import { CITY_CAP, HTTP_ALL_FULL, HTTP_BAD_HELLO, HTTP_BAD_ORIGIN, MAX_CITIES, PROTOCOL_VERSION, isAllowedOrigin, isValidName } from '../../src/net/protocol';
import { CITY_FULL_STATUS, parseNameParam } from './city';

export { City } from './city';

export interface Env {
  CITY: DurableObjectNamespace;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return plain(200, `port-calamity-city v${PROTOCOL_VERSION}, ${CITY_CAP} per city\n`);
    }
    if (!isAllowedOrigin(request.headers.get('Origin'))) return plain(HTTP_BAD_ORIGIN, 'origin not allowed\n');

    const url = new URL(request.url);
    if (url.searchParams.get('v') !== String(PROTOCOL_VERSION)) return plain(HTTP_BAD_HELLO, 'wrong protocol version\n');
    const name = parseNameParam(url.searchParams.get('name'));
    if (!isValidName(name)) return plain(HTTP_BAD_HELLO, 'bad name\n');

    for (let n = 1; n <= MAX_CITIES; n++) {
      const stub = env.CITY.get(env.CITY.idFromName(`city-${n}`));
      // A fresh, minimal request: nothing of the caller's headers (address included) reaches the city.
      const res = await stub.fetch(`https://city/?city=${n}&name=${name.join('.')}`, { headers: { Upgrade: 'websocket' } });
      if (res.status !== CITY_FULL_STATUS) return res;
    }
    return plain(HTTP_ALL_FULL, 'every city is full\n');
  },
} satisfies ExportedHandler<Env>;
