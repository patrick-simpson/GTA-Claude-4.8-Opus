// Shared by tools/net/hard1.mjs, hard2.mjs and hard3.mjs (multiplayer stage 5, hardening): local services, headless
// visitors and the in-page looks those tests make. Nothing here is a test by itself.
//
// The services are the Node home (server/home/main.ts) started twice: "main" (found through a lookup stand-in, as the
// real game finds the home computer behind its tunnel) and "backup" (reached as a plain `?net=` address, which the
// game treats as the backup: the stand-in for the Cloudflare Worker that the other tests use too). The real Worker is
// never touched. Each test passes its own ports, so two of them never share one; still, never run two at once (the
// pages are slow enough alone).

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
export const f1 = (v) => (+v).toFixed(1);

let failed = 0;
export const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
export const note = (what) => console.log(`NOTE  ${what}`);
export const failures = () => failed;
export async function wait(fn, ms = 30000, step = 250) { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

/** What a page may log that is the network coming and going, not the game going wrong. */
export const NOISE = /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:\d+\/main|request failed: ws/;

/** The services, the lookup and every page: one per test. */
export function services({ main, lookup: lookupPort, backup, mainAddr }) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pc-hard-'));
  const kids = [];
  const start = (port, dir) => {
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(port), PC_STATE: path.join(tmp, dir) } });
    kids.push(c);
    return c;
  };
  const stop = async (c) => { if (c && c.exitCode === null) { const gone = new Promise((r) => c.once('exit', r)); try { c.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); } };
  const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
  // Where main is, as the backup Worker answers it (the tests change it to move main, as a new tunnel address does).
  const s = { addr: mainAddr ?? `http://127.0.0.1:${main}`, lookups: 0, t0: Date.now() };
  const lookup = createServer((req, res) => {
    if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
    s.lookups++;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: s.addr }));
  }).listen(lookupPort, '127.0.0.1');
  s.home = null; s.back = null;
  s.startMain = () => { s.home = start(main, 'main'); return s.home; };
  /** Main again, at another port: the same state folder (its facts), a new address (as a new tunnel address is). */
  s.startMainAt = (port) => { s.home = start(port, 'main'); return s.home; };
  s.stopMain = () => stop(s.home);
  s.startBackup = () => { s.back = start(backup, 'backup'); return s.back; };
  s.up = up;
  s.viaMain = `net=${encodeURIComponent(`ws://127.0.0.1:${backup}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${lookupPort}`)}`;
  s.viaBackup = `net=${encodeURIComponent(`ws://127.0.0.1:${backup}`)}`;
  s.open = [];
  s.end = async () => {
    for (const t of s.open.splice(0)) await t.close().catch(() => {});
    lookup.close();
    for (const c of kids) await stop(c);
    rmSync(tmp, { recursive: true, force: true });
  };
  /** A headless visitor with the hooks every hard test uses. */
  // again: load the page a second time once listening, so that every frame it ever sends is counted (a plain `?net=`
  // page opens its socket while it boots, before anything here listens).
  s.visitor = async (tag, query, size = [480, 270], again = false) => {
    const t = await boot({ start: false, query: `q=low&${query}`, width: size[0], height: size[1] });
    s.open.push(t);
    t.tag = tag;
    // Binary frames this page sends, by kind (and for frames 2 to 5 what they carry: '2.1' traffic, '3.10' crew...).
    t.out = { n: {}, bytes: {} };
    // Also (the soak): text frames sent, and every frame received by the same key ('text' for JSON).
    t.outText = { n: 0, bytes: 0 };
    t.inn = { n: {}, bytes: {} };
    const key = (p) => p[0] >= 2 && p[0] <= 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.page.on('websocket', (ws) => {
      ws.on('framesent', (f) => {
        const p = f.payload;
        if (typeof p === 'string') { t.outText.n++; t.outText.bytes += Buffer.byteLength(p); return; }
        if (p.length === 0) return;
        const k = key(p);
        t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
      });
      ws.on('framereceived', (f) => {
        const p = f.payload, k = typeof p === 'string' ? 'text' : p.length ? key(p) : 'empty';
        t.inn.n[k] = (t.inn.n[k] ?? 0) + 1; t.inn.bytes[k] = (t.inn.bytes[k] ?? 0) + (typeof p === 'string' ? Buffer.byteLength(p) : p.length);
      });
    });
    if (again) {
      await t.page.reload({ waitUntil: 'load' });
      await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
    }
    t.net = () => t.page.evaluate(() => window.__game.net());
    t.crew = () => t.page.evaluate(() => window.__game.net().crew);
    t.until = async (fn, ms = 45000, every = 250) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
    t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const g = window.__game.game; if (g.player.vehicle) g.player.exit(); window.__game.teleport(x, z, h); }, [x, z, h]);
    /** "I cannot host", as a hidden tab says it; the service is told at once. */
    t.pin = (on) => t.page.evaluate((on) => {
      if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden;
      window.__game.game.net.perfAt = 0;
    }, on);
    t.key = (code) => t.page.keyboard.press(code, { delay: 60 });
    t.ask = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__game.game, ${JSON.stringify(arg ?? null)})`);
    t.me = () => t.page.evaluate(() => { const g = window.__game.game, p = g.player, v = p.vehicle; return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), heat: p.heat, health: p.health, state: g.state, car: v ? { kind: v.spec.kind, x: +v.x.toFixed(2), z: +v.z.toFixed(2), held: !!v.held, lent: !!v.lent } : null }; });
    t.car = () => t.page.evaluate(() => { const v = window.__game.game.player.vehicle; return v ? { kind: v.spec.kind, x: v.x, z: v.z, h: v.h, held: !!v.held, lent: !!v.lent } : null; });
    t.todo = () => t.page.evaluate(() => {
      const g = window.__game.game, td = g.todo, m = td.missions;
      return { busy: td.busy, cur: m.cur ? m.cur.id : null, failed: m.failed, want: m.want(), money: g.player.money, filed: td.save.data.missions.slice(), job: td.jobs.job ?? null };
    });
    t.mine = (tag) => t.page.evaluate((tag) => {
      const g = window.__game.game, td = g.todo, v = tag === '#towed' ? td.jobs.towed : td.missions.ents.get(tag);
      return v && v.spec ? { kind: v.spec.kind, x: +v.x.toFixed(2), z: +v.z.toFixed(2), h: v.h, driver: v.driver, held: !!v.held, wreck: !!v.wreck, shared: !!v.shared, listed: g.vehicles.list.includes(v), removed: !!v.removed } : null;
    }, tag);
    t.calm = () => t.page.evaluate(() => { const g = window.__game.game, p = g.systems.find((s) => s && s.tag === 'police'); g.player.heat = 0; if (p) p.clear(); if (g.player.health > 0) g.player.health = 100; });
    t.heat = (n) => t.page.evaluate((n) => window.__game.setHeat(n), n);
    t.heal = () => t.page.evaluate(() => { const p = window.__game.game.player; if (p.health > 0) p.health = 100; p.armor = 100; });
    t.leave = async () => { const i = s.open.indexOf(t); if (i >= 0) s.open.splice(i, 1); await t.close().catch(() => {}); };
    /** The page's own main thread held for `ms`: a frozen tab, a slow machine's long pause (nothing sent, nothing read). */
    t.freeze = (ms) => t.page.evaluate((ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* frozen */ } }, ms);
    t.errs = () => t.errors.filter((e) => !NOISE.test(e));
    await t.page.evaluate(() => window.__game.start());
    return t;
  };
  return s;
}

/** Who runs the town now (traffic, people and police all the host's), and is everybody else shown it? Null in a change. */
export async function roles(ts) {
  const ns = await Promise.all(ts.map((t) => t.net()));
  const hi = ns.findIndex((x) => x.traffic.mode === 'host' && x.people.mode === 'host' && x.police.mode === 'host');
  if (hi < 0) return null;
  if (ns.some((x, i) => i !== hi && (x.traffic.mode !== 'guest' || x.people.mode !== 'guest' || x.police.mode !== 'guest' || x.host !== ns[hi].id || x.status !== 'online'))) return null;
  return { host: ts[hi], hn: ns[hi], guests: ts.filter((_, i) => i !== hi), gn: ns.filter((_, i) => i !== hi), ns };
}
export async function rolesSoon(ts, ms = 45000) {
  for (const end = Date.now() + ms; Date.now() < end;) { const r = await roles(ts); if (r) return r; await sleep(300); }
  return null;
}
export const modes = async (ts) => (await Promise.all(ts.map((t) => t.net()))).map((n, i) => `${ts[i].tag}#${n.id} ${n.status} traffic ${n.traffic.mode}/people ${n.people.mode}/police ${n.police.mode}, host ${n.host}`).join('; ');

/**
 * What one screen has within r of (x, z): its cars (own and shown), the other players' cars drawn here, the doubles
 * (two cars, not wrecks of one another, closer than 1.6 m: one car twice), fires, wrecks, and the people.
 */
export const look = (g, [x, z, r]) => {
  const near = (v) => !v.removed && !v.sunk && Math.hypot(v.x - x, v.z - z) < r;
  const list = g.vehicles.list.filter(near), ghosts = g.vehicles.ghostList.filter(near), all = [...list, ...ghosts];
  const doubles = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j], d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 1.6 && Math.abs(a.y - b.y) < 1.5) doubles.push(`${a.spec.kind}${a.shared ? '(town)' : ''}${list.includes(a) ? '' : '(player)'} and ${b.spec.kind}${b.shared ? '(town)' : ''}${list.includes(b) ? '' : '(player)'} ${d.toFixed(2)} m apart at ${a.x.toFixed(1)},${a.z.toFixed(1)}`);
  }
  const fires = g.player.weapons.burnInfo().filter((b) => Math.hypot(b.x - x, b.z - z) < r);
  return {
    cars: list.length, driven: list.filter((v) => v.driver === 'ai').length, wrecks: list.filter((v) => v.wreck).map((v) => ({ x: +v.x.toFixed(1), z: +v.z.toFixed(1) })),
    players: ghosts.length, doubles, fires: fires.length,
    people: g.people.list.filter((p) => Math.hypot(p.x - x, p.z - z) < r).length,
  };
};
export const lookText = (l) => `${l.cars} cars (${l.driven} driven, ${l.wrecks.length} wrecks), ${l.players} players' cars, ${l.fires} fires, ${l.people} people${l.doubles.length ? `, DOUBLES: ${l.doubles.join('; ')}` : ''}`;

/** Breakable street furniture still standing within r of (x, z), nearest first. */
export const propsNear = (g, [x, z, r]) => {
  const out = [];
  g.col.forProps(x, z, r, (p) => { if (p.breakable) out.push({ x: p.x, z: p.z, kind: p.kind, d: Math.hypot(p.x - x, p.z - z) }); });
  return out.sort((a, b) => a.d - b.d);
};
/** Knock over the prop standing at (x, z), as a car does. */
export const knock = (g, [x, z, vx, vz]) => {
  let hit = null;
  g.col.forProps(x, z, 0.2, (p) => { if (Math.hypot(p.x - x, p.z - z) < 0.05) hit = p; });
  if (!hit) return false;
  g.col.breakProp(hit, vx, vz);
  return true;
};
export const downAt = (g, [x, z]) => g.net.props.isDownAt(x, z);
/** One of the town's parked cars, whole and untouched, between near and far m from (x, z), not one of `skip`. */
export const pickParked = (g, [x, z, near, far, skip]) => {
  const spots = g.parkSpots;
  let best = null, bd = 1e9;
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i], v = s.v;
    if (!v || v.health < 100 || v.wreck || g.net.cars.placeOf(v) !== i || skip.includes(i)) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d > near && d < far && d < bd) { bd = d; best = { place: i, x: +v.x.toFixed(2), z: +v.z.toFixed(2), h: v.h }; }
  }
  return best;
};
/** The car nearest (x, z) within r on this screen. */
export const carAt = (g, [x, z, r]) => {
  let best = null, bd = r;
  for (const v of g.vehicles.list) { if (v.removed) continue; const d = Math.hypot(v.x - x, v.z - z); if (d < bd) { bd = d; best = v; } }
  return best ? { x: +best.x.toFixed(2), z: +best.z.toFixed(2), health: +best.health.toFixed(1), wreck: !!best.wreck, shared: !!best.shared, held: !!best.held, kind: best.spec.kind, d: +bd.toFixed(2) } : null;
};

/** A car of this player's own, made beside them, and them at its wheel. */
export const ownCar = (t, kind = 'sedan') => t.page.evaluate((kind) => { const g = window.__game.game, p = g.player, v = g.vehicles.spawn(kind, p.x + 4, p.z, p.h); p.enter(v, true); return !!g.player.vehicle; }, kind);
export const onFoot = async (t) => { if (await t.car()) { await t.key('KeyF'); await wait(async () => !(await t.car()), 15000); await sleep(1500); } };
export const STORY = (upTo) => (t) => t.page.evaluate((upTo) => { const d = window.__game.game.todo.save.data.missions; d.length = 0; for (let k = 1; k <= upTo; k++) d.push(`m0${k}`); }, upTo);
export async function startM(t, id, filed) {
  await STORY(filed)(t);
  await t.page.evaluate((id) => { const td = window.__game.game.todo; td.missions.start(td.missions.missions.find((m) => m.id === id)); }, id);
}
/** Press through a mission's talking until it wants something done. */
export async function read(t, tries = 60) {
  for (let k = 0; k < tries; k++) {
    const s = await t.todo();
    if (!s.cur || s.failed || (s.want && s.want.t !== 'say')) return s;
    await t.key('KeyG');
    await sleep(350);
  }
  return t.todo();
}
/** On page t: the other players' held car nearest (x, z) drawn here. */
export const shownHeld = (t, x, z) => t.page.evaluate(([x, z]) => {
  const n = window.__game.game.net, list = n.held.list();
  let best = null, bd = 1e9;
  for (const v of list) { const d = Math.hypot(v.x - x, v.z - z); if (d < bd) { bd = d; best = v; } }
  return best ? { x: +best.x.toFixed(1), z: +best.z.toFixed(1), d: +bd.toFixed(1), shared: !!best.shared, kind: best.spec.kind } : null;
}, [x, z]);
/** The town cars (not held, not a player's) the HOST's traffic frames carry within r of (x, z). */
export const townCarsNear = (n, x, z, r) => (n.traffic.cars ?? []).filter((c) => Math.hypot(c.x - x, c.z - z) < r);
