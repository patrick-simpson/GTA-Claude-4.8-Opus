// Multiplayer stage 3, step 4: fire, wrecks, visible damage and breakable props. Headless browsers against LOCAL services.
//
//   node tools/net/fire.mjs              every check, and two pictures into shots/net/
//   node tools/net/fire.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/weapons.mjs does (read its header): the Node
// home on 8841 is "main" (found through a lookup stand-in on 8842) and a second copy on 8843 is reached as a plain
// `?net=` address, which the game treats as the BACKUP.
// Checks: with two in town and nothing burning or broken, nothing about fire or props is on the wire (and what IS
// sent, in bytes a second, is printed); a parked town car set alight on the host is shown alight to the guest, goes
// up once, and stays on both screens as a wreck; a moving traffic car does the same under the number it had; what
// the host sends while that happens, in bytes a second; another player's own car is shown dented, steaming, alight
// and burnt out, whoever owns it (guest or host), the wreck stays for the town and is not blown up twice; a town car
// set alight by a guest's rounds names the guest when it goes up, and the guest alone gets the crime; a prop knocked
// over by a guest or by the host is down for the other, with no echo; a guest's car really knocks one over; somebody
// who joins later gets the props that are down and the wrecks that are standing; a wreck is cleared for everybody
// once nobody is near, and not before; a guest far from a fire lights none for it; on the backup a player's own car still shows its damage and fire, and props
// and wrecks stay private with nothing sent; no page errors.
// Nothing here depends on driving or aiming: health is set on the browser that counts it, places are set outright,
// and where a guest's rounds are needed the frame they would have sent is sent by hand.
// The service moves the host's job between browsers whenever it likes (it does, on a machine with no video card), so
// every part that needs a host asks who it is and tries again, a bounded number of times and saying why.
// The pages run in real time. There is no video card here, so the game runs slower than the clock on the wall: the
// waits are long, and they end on what happened, not on a guess at how long it takes.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8841, LOOKUP = 8842, BACKUP = 8843;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const note = (what) => console.log(`NOTE  ${what}`);

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-fire-'));
const kids = [];
const up = async (port) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return true; } catch { /* not yet */ } await sleep(300); } return false; };
function startHome(port, dir) {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(serverDir, 'home', 'main.ts')], { stdio: 'ignore', env: { ...process.env, PC_PORT: String(port), PC_STATE: path.join(tmp, dir) } });
  kids.push(c);
  return c;
}
const stop = async (c) => { if (c.exitCode === null) { const gone = new Promise((r) => c.once('exit', r)); try { c.kill('SIGTERM'); } catch { /* gone */ } await Promise.race([gone, sleep(5000)]); } };

const lookup = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/main') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': req.headers.origin ?? '*' }).end(JSON.stringify({ u: `http://127.0.0.1:${MAIN}` }));
}).listen(LOOKUP, '127.0.0.1');

const viaMain = `net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}&netmain=${encodeURIComponent(`http://127.0.0.1:${LOOKUP}`)}`;
const viaBackup = `net=${encodeURIComponent(`ws://127.0.0.1:${BACKUP}`)}`;
const open = [];
async function visitor(tag, query, size = [480, 270]) {
  const t = await boot({ start: false, query: `q=low&${query}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  // Binary frames this page sends, counted on the wire itself, by kind and by what they carry: '1' a state frame;
  // '2.1' the host's traffic, '2.2' parked places, '2.3' people, '2.4' police, '2.5' the list of props that are down;
  // '3.6' a blast, '3.8' props knocked over; '4.x' things asked of the host ('4.4' a car handed over); '0' a keepalive.
  t.out = { n: {}, bytes: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] === 2 || p[0] === 3 || p[0] === 4 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
  /** Wait for something only the page can see: fn runs in the page with the hooks and one argument. Returns its first truthy answer, or null. */
  t.when = async (fn, arg, ms = 45000) => { const end = Date.now() + ms; for (;;) { const v = await t.page.evaluate(`(${fn.toString()})(window.__game.game, ${JSON.stringify(arg ?? null)})`); if (v) return v; if (Date.now() > end) return null; await sleep(250); } };
  t.ask = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__game.game, ${JSON.stringify(arg ?? null)})`);
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const g = window.__game.game; if (g.player.vehicle) g.player.exit(); window.__game.teleport(x, z, h); }, [x, z, h]);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
/** Who is running the town right now, and who is shown it? Null in the instant of a change. */
async function roles(ts) {
  const ns = await Promise.all(ts.map((t) => t.net()));
  const hi = ns.findIndex((x) => x.people.mode === 'host' && x.traffic.mode === 'host');
  if (hi < 0 || ns.some((x, i) => i !== hi && (x.people.mode !== 'guest' || x.traffic.mode !== 'guest' || x.host !== ns[hi].id))) return null;
  return { host: ts[hi], hn: ns[hi], guests: ts.filter((_, i) => i !== hi), gn: ns.filter((_, i) => i !== hi) };
}
async function rolesSoon(ts, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end;) { const r = await roles(ts); if (r) return r; await sleep(300); }
  return null;
}
const wire = (t, k) => t.out.n[k] ?? 0, wireB = (t, k) => t.out.bytes[k] ?? 0;
const snapWire = (t) => ({ n: { ...t.out.n }, bytes: { ...t.out.bytes } });
/** What a page put on the wire since `was`, as "kind: frames/bytes" and in total. */
function since(t, was) {
  const parts = [], nOf = {}, bOf = {}; let bytes = 0, frames = 0;
  for (const k of Object.keys(t.out.n).sort()) {
    const n = t.out.n[k] - (was.n[k] ?? 0), b = t.out.bytes[k] - (was.bytes[k] ?? 0);
    if (n > 0) { parts.push(`${k}: ${n} frames ${b} B`); bytes += b; frames += n; nOf[k] = n; bOf[k] = b; }
  }
  // (Counted now: the page goes on sending while the caller looks at this.)
  return { text: parts.join(', ') || 'nothing', bytes, frames, of: (k) => nOf[k] ?? 0, bytesOf: (k) => bOf[k] ?? 0 };
}
/** No police, no heat, full health: each part starts from quiet. */
const calm = (t) => t.page.evaluate(() => {
  const g = window.__game.game, p = g.systems.find((s) => s.tag === 'police');
  g.player.heat = 0;
  if (p) p.clear();
  if (g.player.health > 0) g.player.health = 100;
});
const WRECK = 0x15130f;

// ── Things asked inside a page (g = window.__game.game) ──

/** The car nearest (x, z) within r: what this browser has there. */
const carAt = (g, [x, z, r, wreckOnly]) => {
  let best = null, bd = r;
  for (const v of g.vehicles.list) {
    if (wreckOnly && !v.wreck) continue;
    const d = Math.hypot(v.x - x, v.z - z);
    if (d < bd) { bd = d; best = v; }
  }
  if (!best) return null;
  const sh = g.net.shared, wid = sh.mode === 'guest' ? sh.widOf(best) : (sh.sim.orphanWid.get(best) ?? sh.sim.byVeh.get(best)?.wid ?? 0);
  return { x: +best.x.toFixed(2), z: +best.z.toFixed(2), y: +best.y.toFixed(2), health: +best.health.toFixed(1), wreck: !!best.wreck, shared: !!best.shared, color: best.color, driver: best.driver, wid, kind: best.spec.kind, d: +bd.toFixed(2) };
};
/** Is there a fire burning within r of (x, z) on this screen? Its record, or null. */
const fireAt = (g, [x, z, r]) => g.player.weapons.burnInfo().find((b) => Math.hypot(b.x - x, b.z - z) < r) ?? null;
/** Every wreck this browser has within r of (x, z). */
const wrecksNear = (g, [x, z, r]) => g.vehicles.list.filter((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < r).map((v) => ({ x: +v.x.toFixed(1), z: +v.z.toFixed(1), shared: !!v.shared }));
/** Guest: one of the town's parked cars that nobody has touched, between `near` and `far` meters from (x, z), not one of `skip`. */
const pickParked = (g, [x, z, near, far, skip]) => {
  const spots = g.parkSpots;
  let best = null, bd = 1e9;
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i], v = s.v;
    if (!v || !v.shared || v.health < 100 || g.net.cars.placeOf(v) !== i || skip.includes(i)) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d > near && d < far && d < bd) { bd = d; best = { place: i, x: v.x, z: v.z, h: v.h }; }
  }
  return best;
};
/** Host: is that parked car there here too, whole? */
const parkedSame = (g, c) => { const v = g.net.cars.parkedAt(c.place); return !!v && Math.hypot(v.x - c.x, v.z - c.z) < 0.3 && v.health === 100; };
/** Breakable street furniture near (x, z) that is still standing: [{x, z, kind}], nearest first, none within 4 m of `keep` points. */
const propsNear = (g, [x, z, r, keep]) => {
  const out = [];
  g.col.forProps(x, z, r, (p) => {
    if (!p.breakable) return;
    for (const k of keep) if (Math.hypot(p.x - k[0], p.z - k[1]) < 4) return;
    out.push({ x: p.x, z: p.z, kind: p.kind, d: Math.hypot(p.x - x, p.z - z) });
  });
  return out.sort((a, b) => a.d - b.d);
};
/** Knock over the prop standing at (x, z), exactly as a car does (ent/vehicle.ts calls this). Returns whether one stood there. */
const knock = (g, [x, z, vx, vz]) => {
  let hit = null;
  g.col.forProps(x, z, 0.2, (p) => { if (Math.hypot(p.x - x, p.z - z) < 0.05) hit = p; });
  if (!hit) return false;
  g.col.breakProp(hit, vx, vz);
  return true;
};
const downAt = (g, [x, z]) => g.net.props.isDownAt(x, z);

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];
  // A quiet street to stage things in (the one tools/net/people.mjs, police.mjs and weapons.mjs use).
  const LANE = { x: -340, z: 291.8 };
  const SPOT = { x: LANE.x - 20, z: LANE.z + 3 };
  // Somewhere else entirely (the pier), for "nobody is near".
  const AWAY = { x: 0, z: 300 };

  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', viaMain, size);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}, ${n.count} in town` : 'timed out');
  await A.go(SPOT.x, SPOT.z, Math.PI / 2);
  await B.go(SPOT.x + 4, LANE.z - 4, Math.PI / 2);
  let r = await rolesSoon([A, B], 60000);
  if (!r) throw new Error('two browsers, no host');
  await A.until((x) => x.remotes.length === 1 && x.remotes[0].seen, 20000);
  await B.until((x) => x.remotes.length === 1 && x.remotes[0].seen, 20000);
  for (const t of [A, B]) await calm(t);

  // ── 1. Two in town, nothing burning, nothing broken: nothing about either on the wire ──
  let idleHost = 0;
  {
    await sleep(4000);
    const a0 = snapWire(A), b0 = snapWire(B), SECS = 15;
    const r0 = await roles([A, B]);
    await sleep(SECS * 1000);
    const r1 = await roles([A, B]);
    const sa = since(A, a0), sb = since(B, b0);
    const na = await A.net(), nb = await B.net();
    const extra = ['3.6', '3.8', '2.5', '4.4'].reduce((s, k) => s + sa.of(k) + sb.of(k), 0);
    check(extra === 0 && na.props.sent === 0 && nb.props.sent === 0 && na.props.listsSent === 0 && nb.props.listsSent === 0, `two in town, standing still for ${SECS} s: no blast, no prop and no wreck frame is sent`, `${extra} such frames; props by the pages' own counts: ${na.props.sent + nb.props.sent} events, ${na.props.listsSent + nb.props.listsSent} lists`);
    const same = r0 && r1 && r0.host === r1.host;
    const H = r1 ? r1.host : A, G = H === A ? B : A, sh = H === A ? sa : sb, sg = H === A ? sb : sa;
    idleHost = sh.bytes / SECS;
    note(`idle, two in town${same ? '' : ' (the host changed during the count)'}: the host ${H.tag} sent ${(sh.bytes / SECS).toFixed(0)} B/s (${sh.text}); the guest ${G.tag} sent ${(sg.bytes / SECS).toFixed(1)} B/s (${sg.text})`);
  }

  // The places used so far, so that each part takes a car of its own.
  const used = [];
  let wreckAt = null;

  // ── 2. A parked town car set alight on the host: the guest sees the fire, one blast, and the wreck that is left ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0], hid = r.hn.id;
      for (const t of [H, G]) await calm(t);
      const car = await G.ask(pickParked, [SPOT.x, SPOT.z, 16, 70, used]);
      if (!car) { detail = 'no untouched parked car of the town\'s on the guest\'s screen'; await sleep(2500); continue; }
      used.push(car.place);
      if (!(await H.ask(parkedSame, car))) { detail = `the host does not have the car of place ${car.place} parked there`; continue; }
      // Both stand back from it, out of the blast (9 m), on the street side.
      const ux = SPOT.x - car.x, uz = SPOT.z - car.z, ul = Math.hypot(ux, uz) || 1, sx = car.x + ux / ul * 15, sz = car.z + uz / ul * 15;
      const face = Math.atan2(car.x - sx, car.z - sz);
      await H.go(sx, sz, face);
      await G.go(sx - uz / ul * 4, sz + ux / ul * 4, face);
      await sleep(2500);
      // What the host sends from here with nothing alight, to hold the fire against: the same place, the same traffic.
      const q0 = snapWire(H), QUIET = 10;
      await sleep(QUIET * 1000);
      const quiet = since(H, q0);
      const g0 = await G.net(), h0 = await H.net(), w0 = snapWire(H), t0 = Date.now();
      // Alight: under 20 health, on the browser that counts it.
      const lit = await H.ask((g, c) => { const v = g.net.cars.parkedAt(c.place); if (!v) return false; v.health = 15; return true; }, car);
      if (!lit) { detail = 'the host lost the car before it could be lit'; continue; }
      // The guest: the same car, now one of the standing cars with a number, shown under 20 health with a fire on it.
      const seen = await G.when((g, c) => {
        let best = null, bd = 3;
        for (const v of g.vehicles.list) { const d = Math.hypot(v.x - c.x, v.z - c.z); if (d < bd) { bd = d; best = v; } }
        const f = g.player.weapons.burnInfo().find((b) => Math.hypot(b.x - c.x, b.z - c.z) < 4);
        return best && best.shared && best.health < 20 && !best.wreck && f && f.told ? { health: +best.health.toFixed(1), wid: g.net.shared.widOf(best), color: best.color } : null;
      }, car, 25000);
      if (!seen) {
        const gc = await G.ask(carAt, [car.x, car.z, 6, false]), hc = await H.ask(carAt, [car.x, car.z, 6, false]);
        if ((await roles([A, B]))?.host !== H) { detail = 'the host changed while the car was catching'; continue; }
        done = true;
        check(false, 'a parked town car alight on the host is shown alight to the guest', `guest's car there: ${JSON.stringify(gc)}; host's: ${JSON.stringify(hc)}; fire on the guest: ${JSON.stringify(await G.ask(fireAt, [car.x, car.z, 6]))}`);
        break;
      }
      const hf = await H.ask(fireAt, [car.x, car.z, 4]);
      if (SHOTS) {
        for (const t of [H, G]) await t.page.evaluate(([x, y, z, ex, ez]) => window.__game.view(ex, y + 3.2, ez, x, y + 0.8, z), [car.x, 0, car.z, car.x + ux / ul * 9 + (t === G ? -uz / ul * 3 : 0), car.z + uz / ul * 9 + (t === G ? ux / ul * 3 : 0)]);
        await sleep(1500);
        await H.shot('shots/net/fire-host.png'); await G.shot('shots/net/fire-guest.png');
      }
      // It goes up on the host (the fuse runs on the host's game clock, which is slow here).
      const hw = await H.when((g, c) => g.vehicles.list.find((v) => v.wreck && Math.hypot(v.x - c.x, v.z - c.z) < 14) ? true : null, car, 150000);
      for (const t of [H, G]) await t.page.evaluate(() => window.__game.view());
      if (!hw) { detail = `it never went up on the host (host's car: ${JSON.stringify(await H.ask(carAt, [car.x, car.z, 14, false]))})`; continue; }
      const gw = await G.when((g, c) => { const v = g.vehicles.list.find((o) => o.wreck && Math.hypot(o.x - c.x, o.z - c.z) < 14); return v ? { shared: !!v.shared, color: v.color, lights: v.lights, wid: g.net.shared.widOf(v), x: v.x, z: v.z } : null; }, car, 20000);
      const tFire = (Date.now() - t0) / 1000, sw = since(H, w0);
      await sleep(4000);
      const g1 = await G.net(), h1 = await H.net();
      const hWrecks = await H.ask(wrecksNear, [car.x, car.z, 16]), gWrecks = await G.ask(wrecksNear, [car.x, car.z, 16]);
      done = true;
      check(true, 'a parked town car alight on the host is shown alight to the guest, with the fire on it', `place ${car.place}; the guest shows it at ${seen.health} health under number ${seen.wid}, fire told by the host: yes; the host's own fire: ${hf ? 'burning' : 'none'}`);
      check(g1.fight.blastsDone === g0.fight.blastsDone + 1 && g1.fight.lastBlast.from === hid && g1.fight.blasts === g0.fight.blasts + 1 && h1.fight.blasts === h0.fight.blasts + 1,
        'it goes up once on each screen: the host\'s blast, told to the guest', `blasts drawn: host ${h1.fight.blasts - h0.fight.blasts}, guest ${g1.fight.blasts - g0.fight.blasts} (from player ${g1.fight.lastBlast.from}; the host is ${hid})`);
      check(!!gw && gw.shared && gw.color === WRECK && gw.wid === seen.wid && hWrecks.length === 1 && gWrecks.length === 1 && Math.hypot(hWrecks[0].x - gWrecks[0].x, hWrecks[0].z - gWrecks[0].z) < 1.5,
        'and what is left is a burnt wreck on both screens, the same car in the same place', gw ? `guest: number ${gw.wid} (was ${seen.wid}), paint ${gw.color.toString(16)}, shared ${gw.shared}; wrecks there: host ${JSON.stringify(hWrecks)}, guest ${JSON.stringify(gWrecks)}` : `the guest never showed a wreck there: ${JSON.stringify(await G.ask(carAt, [car.x, car.z, 14, false]))}`);
      const fire = sw.bytes / tFire;
      check(sw.of('3.6') === 1 && sw.of('2.5') === 0 && sw.of('3.8') === 0, 'the fire cost one blast event of 12 bytes and no frame of a new kind', `the host over the ${tFire.toFixed(0)} s from lighting it to the wreck: ${sw.text}`);
      note(`from lighting the car to the wreck (${tFire.toFixed(0)} s) the host sent ${fire.toFixed(0)} B/s in all; in the ${QUIET} s before, standing in the same place with nothing alight, ${(quiet.bytes / QUIET).toFixed(0)} B/s (and ${idleHost.toFixed(0)} B/s in the first idle count). Of the fire's: the blast ${sw.bytesOf('3.6')} B once, the parked places ${sw.bytesOf('2.2')} B once, traffic frames ${(sw.bytesOf('2.1') / tFire).toFixed(0)} B/s against ${(quiet.bytesOf('2.1') / QUIET).toFixed(0)} B/s before (${sw.of('2.1')} frames against ${quiet.of('2.1')})`);
      if (gw) wreckAt = { x: gWrecks[0]?.x ?? car.x, z: gWrecks[0]?.z ?? car.z };
    }
    if (!done) check(false, 'a parked town car alight on the host is shown alight to the guest', `5 tries; the last: ${detail}`);
  }

  // ── 3. A moving traffic car alight on the host: the guest goes on seeing the SAME car, alight, then burnt out ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0];
      const gi = await G.info();
      // One the traffic is driving, near the guest, that the guest is shown.
      const pick = await H.ask((g, [x, z]) => {
        const tr = g.net.shared.sim;
        let best = null, bd = 130;
        for (const d of tr.drivers) {
          const v = d.v;
          if (!v || v.driver !== 'ai' || !d.wid || v.health < 100) continue;
          const dd = Math.hypot(v.x - x, v.z - z);
          if (dd > 25 && dd < bd) { bd = dd; best = { wid: d.wid, d: +dd.toFixed(0), kind: v.spec.kind }; }
        }
        return best;
      }, [gi.x, gi.z]);
      if (!pick) { detail = 'no traffic car between 25 and 130 m of the guest'; await sleep(4000); continue; }
      const shown = await G.ask((g, w) => !!g.net.shared.cars.get(w), pick.wid);
      if (!shown) { detail = `the guest is not shown car ${pick.wid}`; await sleep(1500); continue; }
      const g0 = await G.net();
      const lit = await H.ask((g, w) => { const d = g.net.shared.sim.drivers.find((o) => o.wid === w && o.v); if (!d) return false; d.v.health = 10; return true; }, pick.wid);
      if (!lit) { detail = `car ${pick.wid} had gone before it could be lit`; continue; }
      const alight = await G.when((g, w) => { const s = g.net.shared.cars.get(w); if (!s) return null; const f = g.player.weapons.burnInfo().find((b) => Math.hypot(b.x - s.v.x, b.z - s.v.z) < 4); return s.v.health < 20 && f && s.v.driver === null ? { health: +s.v.health.toFixed(1) } : null; }, pick.wid, 25000);
      if (!alight) {
        if ((await roles([A, B]))?.host !== H) { detail = 'the host changed while the car was catching'; continue; }
        const st = await G.ask((g, w) => { const s = g.net.shared.cars.get(w); return s ? { health: s.v.health, driver: s.v.driver, wreck: !!s.v.wreck } : 'not shown any more'; }, pick.wid);
        const hs = await H.ask((g, w) => { const tr = g.net.shared.sim; let o = null; tr.eachShared((id, v, dl) => { if (id === w) o = { health: v.health, driver: v.driver, driverless: dl }; }); return o ?? 'not in the frames'; }, pick.wid);
        done = true;
        check(false, 'a traffic car alight on the host stays on the guest\'s screen under its number, alight and driverless', `car ${pick.wid}: guest ${JSON.stringify(st)}; host ${JSON.stringify(hs)}`);
        break;
      }
      const burnt = await G.when((g, w) => { const s = g.net.shared.cars.get(w); return s && s.v.wreck ? { color: s.v.color } : null; }, pick.wid, 150000);
      const g1 = await G.net();
      if (!burnt && (await roles([A, B]))?.host !== H) { detail = 'the host changed while the car burnt'; continue; }
      done = true;
      check(true, 'a traffic car alight on the host stays on the guest\'s screen under its number, alight and driverless', `a ${pick.kind}, number ${pick.wid}, ${pick.d} m from the guest: shown at ${alight.health} health with a fire on it`);
      check(!!burnt && burnt.color === WRECK && g1.fight.blastsDone > g0.fight.blastsDone, 'and it goes up and is left as a wreck under the same number', burnt ? `number ${pick.wid}: wreck, paint ${burnt.color.toString(16)}; ${g1.fight.blastsDone - g0.fight.blastsDone} blast(s) told` : `not a wreck after 150 s: ${JSON.stringify(await G.ask((g, w) => { const s = g.net.shared.cars.get(w); return s ? { health: s.v.health, wreck: !!s.v.wreck } : 'not shown'; }, pick.wid))}`);
    }
    if (!done) check(false, 'a traffic car alight on the host stays on the guest\'s screen under its number, alight and driverless', `6 tries; the last: ${detail}`);
  }

  // ── 4. A player's own car: dented, steaming, alight and burnt out on the other player's screen, whoever owns it ──
  const ownCar = async (who) => {
    let done = false, detail = '';
    const what = `${who}'s own car`;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const O = who === 'a guest' ? r.guests[0] : r.host, W = O === r.host ? r.guests[0] : r.host;
      const oid = (await O.net()).id;
      for (const t of [O, W]) await calm(t);
      // Along the street, well clear of the earlier wreck.
      const ox = SPOT.x + 60 + attempt * 16 + (who === 'a guest' ? 0 : 100), oz = SPOT.z;
      await W.go(ox, oz + 15, Math.PI);
      await O.go(ox, oz, Math.PI / 2);
      await O.page.evaluate(() => { window.__game.drive('sedan'); const g = window.__game.game; g.player.vehicle.ctl.handbrake = true; });
      const there = await W.until((x) => x.remotes[0] && x.remotes[0].vehicle === 'sedan' && x.remotes[0].damage === 0 && x.remotes[0].carHealth === 100, 20000);
      if (!there) { detail = `${W.tag} was not shown the car whole: ${JSON.stringify((await W.net()).remotes[0])}`; continue; }
      // (Full health and a vest: alone, too, going up with the car takes 164 off whoever is in it, which is the end of anybody without one.)
      const setH = (h) => O.page.evaluate((h) => { const g = window.__game.game; if (g.player.vehicle) g.player.vehicle.health = h; g.player.health = 100; g.player.armor = 100; }, h);
      // Dented: health 62 is 6 steps of the 16.
      await setH(62);
      const dent = await W.until((x) => x.remotes[0] && x.remotes[0].damage === 6, 15000);
      // Steaming: under 50, the engine gives off steam, and the other screen makes it from the same health.
      await setH(40);
      const steam = await W.until((x) => x.remotes[0] && x.remotes[0].damage === 9 && x.remotes[0].carHealth < 50, 15000);
      const steams = await W.when((g, id) => { const c = g.net.remotes.get(id)?.vehicle; const st = c && g.fx.cars.get(c); return st ? { eng: st.eng } : null; }, oid, 15000);
      check(!!dent && !!steam && !!steams, `${what} is shown dented, then steaming, on the other screen`, `${W.tag} shows ${O.tag}'s sedan: 62 health -> step ${dent ? 6 : JSON.stringify((await W.net()).remotes[0]?.damage)}; 40 health -> ${steam ? `step 9, shown at ${steam.remotes[0].carHealth}` : 'not seen'}; the engine smoke is being made for it there: ${!!steams}`);
      const w0 = await W.net(), o0 = await O.net(), ow0 = snapWire(O);
      // Alight.
      await setH(15);
      const fire = await W.when((g, id) => { const c = g.net.remotes.get(id)?.vehicle; if (!c || c.health >= 20) return null; const f = g.player.weapons.burnInfo().find((b) => Math.hypot(b.x - c.x, b.z - c.z) < 4); return f && f.told && !f.wreck ? { health: +c.health.toFixed(1) } : null; }, oid, 20000);
      check(!!fire, `${what} alight is shown alight on the other screen`, fire ? `${W.tag} shows it at ${fire.health} health with a fire on it` : `${W.tag}: ${JSON.stringify((await W.net()).remotes[0])}, fires ${JSON.stringify((await W.net()).fight.burns)}`);
      // It goes up under them, on their own browser; they are thrown out alive.
      const up2 = await O.when((g) => { const p = g.player; return !p.vehicle && g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - p.x, v.z - p.z) < 30) ? { health: p.health } : null; }, null, 150000);
      if (!up2) { detail = `it never went up on ${O.tag} (${JSON.stringify(await O.info())})`; continue; }
      done = true;
      const w1 = await W.until((x) => x.fight.blastsDone > w0.fight.blastsDone, 15000) ?? await W.net();
      // What is left is the town's: handed to the host as a wreck, standing on both screens, and not blown up again.
      const oi = { x: ox, z: oz };
      const ww = await W.when((g, [x, z]) => { const v = g.vehicles.list.find((o) => o.wreck && Math.hypot(o.x - x, o.z - z) < 25); return v ? { x: +v.x.toFixed(1), z: +v.z.toFixed(1), shared: !!v.shared, color: v.color } : null; }, [oi.x, oi.z], 30000);
      await sleep(9000);
      const w2 = await W.net(), o2 = await O.net(), so = since(O, ow0);
      await O.page.evaluate(() => { window.__game.game.player.armor = 0; });
      // (10 m, not 25: a passing traffic car that caught the blast can leave a second wreck nearby, which both screens agree on.)
      const own = await O.ask(wrecksNear, [oi.x, oi.z, 10]), theirs = await W.ask(wrecksNear, [oi.x, oi.z, 10]);
      check(w1.fight.blastsDone === w0.fight.blastsDone + 1 && w1.fight.lastBlast.from === oid && up2.health > 0, `${what} goes up on its owner's browser, and the other is told of the blast`, `${O.tag} thrown clear with ${up2.health} health; ${W.tag} heard ${w1.fight.blastsDone - w0.fight.blastsDone} blast from player ${w1.fight.lastBlast.from} (${O.tag} is ${oid})`);
      check(!!ww && ww.color === WRECK && own.length === 1 && theirs.length === 1 && Math.hypot(own[0].x - theirs[0].x, own[0].z - theirs[0].z) < 2,
        `and the wreck of ${what} stays on both screens, in the same place`, `${O.tag}: ${JSON.stringify(own)}; ${W.tag}: ${JSON.stringify(theirs)}${who === 'a guest' ? `; handed to the host in ${so.of('4.4')} frame of ${so.bytesOf('4.4')} bytes` : ''}`);
      check(w2.fight.blasts === w0.fight.blasts + 1 && o2.fight.blasts === o0.fight.blasts + 1, 'and it is not blown up a second time by whoever was handed it', `blasts drawn since it was lit: ${O.tag} ${o2.fight.blasts - o0.fight.blasts}, ${W.tag} ${w2.fight.blasts - w0.fight.blasts}`);
    }
    if (!done) check(false, `${what} is shown alight and then burnt out on the other screen`, `4 tries; the last: ${detail}`);
  };
  await ownCar('a guest');
  await ownCar('the host');

  // ── 5. A town car set alight by a GUEST's rounds: when it goes up the guest is named, and the crime is the guest's ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0], gid = r.gn[0].id;
      for (const t of [H, G]) await calm(t);
      await G.go(SPOT.x - 30, SPOT.z, Math.PI / 2);
      await H.go(SPOT.x - 30, SPOT.z + 5, Math.PI / 2);
      await sleep(2500);
      const gi = await G.info();
      const car = await G.ask(pickParked, [gi.x, gi.z, 18, 80, used]);
      if (!car) { detail = 'no untouched parked car of the town\'s on the guest\'s screen'; await sleep(2500); continue; }
      used.push(car.place);
      if (!(await H.ask(parkedSame, car))) { detail = `the host does not have the car of place ${car.place} parked there`; continue; }
      await H.until((x) => x.remotes[0] && x.remotes[0].seen && Math.hypot(x.remotes[0].x - gi.x, x.remotes[0].z - gi.z) < 3, 15000);
      const h0 = await H.net(), g0 = await G.net();
      // The frames the guest's rounds would have sent (CarShot, 7 bytes): 30 health off it, three times, a second apart.
      const shoot = (cls, num) => G.page.evaluate(([cls, num]) => window.__game.game.net.conn.send(new Uint8Array([4, 0, 9, cls, num & 255, num >> 8, 120]).buffer), [cls, num]);
      await shoot(1, car.place);
      // Dented, it is one of the standing cars now, with a number: the rest go to that.
      const wid = await G.when((g, c) => { for (const v of g.vehicles.list) if (v.shared && Math.hypot(v.x - c.x, v.z - c.z) < 2) { const w = g.net.shared.widOf(v); if (w) return w; } return null; }, car, 15000);
      if (!wid) { detail = `the first rounds did not reach the car of place ${car.place} (host heard ${(await H.net()).fight.carShotsGot - h0.fight.carShotsGot}, applied ${(await H.net()).fight.carShotsDone - h0.fight.carShotsDone})`; continue; }
      await sleep(1200); await shoot(0, wid);
      await sleep(1200); await shoot(0, wid);
      const hh = await H.when((g, c) => { for (const v of g.vehicles.list) if (Math.hypot(v.x - c.x, v.z - c.z) < 3) return { health: v.health }; return null; }, car, 5000);
      const h1 = await H.until((x) => x.fight.blamesSent > h0.fight.blamesSent, 150000);
      if (!h1) {
        if ((await roles([A, B]))?.host !== H) { detail = 'the host changed while the car burnt'; continue; }
        done = true;
        check(false, 'a town car set alight by a guest\'s rounds names the guest when it goes up', `car of place ${car.place}, number ${wid}: on the host ${JSON.stringify(await H.ask(carAt, [car.x, car.z, 14, false]))} after ${(await H.net()).fight.carShotsDone - h0.fight.carShotsDone} of 3 frames applied (health then ${JSON.stringify(hh)})`);
        break;
      }
      done = true;
      const g1 = await G.until((x) => x.fight.blamesGot > g0.fight.blamesGot, 15000) ?? await G.net();
      const h2 = await H.net();
      check(h1.fight.blamesSent === h0.fight.blamesSent + 1 && g1.fight.blamesGot === g0.fight.blamesGot + 1, 'a town car set alight by a guest\'s rounds names the guest when it goes up', `car number ${wid}: ${h2.fight.carShotsDone - h0.fight.carShotsDone} frames of rounds applied by the host; its blast named player ${gid} (${G.tag}); ${G.tag} heard itself named ${g1.fight.blamesGot - g0.fight.blamesGot} time`);
      check(g1.fight.crimes > g0.fight.crimes && h2.fight.crimes === h0.fight.crimes, 'and the explosion is the guest\'s crime, not the host\'s', `crimes on the sheet since: ${G.tag} ${g1.fight.crimes - g0.fight.crimes}, ${H.tag} ${h2.fight.crimes - h0.fight.crimes}`);
    }
    if (!done) check(false, 'a town car set alight by a guest\'s rounds names the guest when it goes up', `5 tries; the last: ${detail}`);
  }

  // ── 6. Props: down for one is down for the other, either way, and nothing is said twice ──
  const felled = [];
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0];
      for (const t of [H, G]) await calm(t);
      await G.go(SPOT.x, SPOT.z, Math.PI / 2);
      await H.go(SPOT.x + 4, LANE.z - 4, Math.PI / 2);
      await H.until((x) => x.remotes[0] && Math.hypot(x.remotes[0].x - SPOT.x, x.remotes[0].z - SPOT.z) < 2, 15000);
      const list = (await G.ask(propsNear, [SPOT.x, SPOT.z, 70, [[SPOT.x, SPOT.z], [SPOT.x + 4, LANE.z - 4]]])).filter((p) => !felled.some((f) => Math.hypot(f.x - p.x, f.z - p.z) < 1));
      // Two that both browsers have standing.
      const both = [];
      for (const p of list) { if (both.length >= 2) break; if ((await H.ask(downAt, [p.x, p.z])) === false) both.push(p); }
      if (both.length < 2) { detail = `fewer than two breakable props standing on both screens near the spot (${list.length} on the guest's)`; continue; }
      const [p1, p2] = both;
      const g0 = await G.net(), h0 = await H.net(), gw0 = snapWire(G), hw0 = snapWire(H);
      // The guest's car knocks one over (the call its car makes).
      if (!(await G.ask(knock, [p1.x, p1.z, 6, 0]))) { detail = 'the guest lost its prop'; continue; }
      const onHost = await H.when(downAt, [p1.x, p1.z], 15000);
      if (!onHost && (await roles([A, B]))?.host !== H) { detail = 'the host changed'; felled.push(p1); continue; }
      // The host knocks the other over (as its traffic does).
      await H.ask(knock, [p2.x, p2.z, 0, -6]);
      const onGuest = await G.when(downAt, [p2.x, p2.z], 15000);
      await sleep(2500);
      const g1 = await G.net(), h1 = await H.net(), sg = since(G, gw0), sh = since(H, hw0);
      done = true; felled.push(p1, p2);
      check(onHost === true && h1.props.felled === h0.props.felled + 1, 'a prop knocked over by a guest is down on the host', `a ${p1.kind} ${p1.d.toFixed(0)} m from the guest: down on the host ${onHost === true}; the host knocked over ${h1.props.felled - h0.props.felled} for it`);
      check(onGuest === true && g1.props.felled === g0.props.felled + 1, 'a prop knocked over on the host is down for the guest', `a ${p2.kind}: down on the guest ${onGuest === true}; the guest knocked over ${g1.props.felled - g0.props.felled} for it`);
      check(sg.of('3.8') === 1 && sg.bytesOf('3.8') === 10 && sh.of('3.8') === 1 && sh.bytesOf('3.8') === 10 && sg.of('2.5') + sh.of('2.5') === 0, 'each cost one event of 10 bytes, and neither browser told the other what it had just been told', `guest: ${sg.of('3.8')} event(s), ${sg.bytesOf('3.8')} B; host: ${sh.of('3.8')} event(s), ${sh.bytesOf('3.8')} B; lists: ${sg.of('2.5') + sh.of('2.5')}`);
    }
    if (!done) check(false, 'a prop knocked over by a guest is down on the host', `4 tries; the last: ${detail}`);
  }

  // ── 7. The real thing: a guest drives a car through a prop; it goes over on both screens ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0];
      for (const t of [H, G]) await calm(t);
      const list = (await G.ask(propsNear, [SPOT.x, SPOT.z, 90, []])).filter((p) => !felled.some((f) => Math.hypot(f.x - p.x, f.z - p.z) < 1));
      const p = list[Math.floor(attempt / 2)];
      if (!p) { detail = 'no more props to try'; break; }
      if ((await H.ask(downAt, [p.x, p.z])) !== false) { felled.push(p); detail = 'the host has no such prop standing'; continue; }
      // Along the street one way, then the other: 5 m short of it, pointing at it.
      const h = attempt % 2 ? -Math.PI / 2 : Math.PI / 2, sx = p.x - Math.sin(h) * 5;
      await G.go(sx, p.z, h);
      await G.page.evaluate(() => window.__game.drive('sedan'));
      // Held at 8 m/s along its nose (set outright: a pedal takes too long to bite at these frame rates).
      await G.page.evaluate(() => { const g = window.__game.game; window.__push = setInterval(() => { const v = g.player.vehicle; if (v) { v.vx = Math.sin(v.h) * 8; v.vz = Math.cos(v.h) * 8; } }, 30); });
      // Until it is down, or the car is past it, or stopped by something else.
      let down = false, past = false, at = null;
      for (const end = Date.now() + 60000; Date.now() < end && !down && !past;) {
        at = await G.info();
        down = (await G.ask(downAt, [p.x, p.z])) === true;
        past = (at.x - p.x) * Math.sin(h) > 6;
        await sleep(150);
      }
      await G.page.evaluate(() => { clearInterval(window.__push); const v = window.__game.game.player.vehicle; if (v) { v.vx = 0; v.vz = 0; v.ctl.handbrake = true; } });
      if (!down) { detail = `the ${p.kind} at ${p.x.toFixed(1)}, ${p.z.toFixed(1)} was not struck going ${attempt % 2 ? 'west' : 'east'} (the car got to ${at ? at.x.toFixed(1) + ', ' + at.z.toFixed(1) : '?'}, past it: ${past})`; await G.go(SPOT.x, SPOT.z, 0); continue; }
      const onHost = await H.when(downAt, [p.x, p.z], 15000);
      felled.push(p);
      if (!onHost && (await roles([A, B]))?.host !== H) { detail = 'the host changed'; await G.go(SPOT.x, SPOT.z, 0); continue; }
      done = true;
      check(onHost === true, 'a guest\'s car drives through a prop: it goes over on the host\'s screen too', `a ${p.kind}, struck at 8 m/s on try ${attempt + 1}; down on the host: ${onHost === true}`);
      await G.go(SPOT.x, SPOT.z, 0);
    }
    if (!done) check(false, 'a guest\'s car drives through a prop: it goes over on the host\'s screen too', `the last: ${detail}`);
  }

  // ── 8. Somebody who joins later: the props that are down, and the wrecks that are standing ──
  {
    for (const t of [A, B]) await calm(t);
    await A.go(SPOT.x, SPOT.z, Math.PI / 2);
    await B.go(SPOT.x + 4, LANE.z - 4, Math.PI / 2);
    await sleep(2000);
    const a0 = await A.net(), b0 = await B.net(), wa0 = snapWire(A), wb0 = snapWire(B);
    const C = await visitor('C', viaMain);
    const nc = await C.until((x) => x.status === 'online' && x.count === 3, 90000);
    check(!!nc && nc.home === 'main', 'C joins the town later', nc ? `${nc.status} on ${nc.home}, ${nc.count} in town` : 'timed out');
    await C.go(SPOT.x + 2, SPOT.z + 4, Math.PI / 2);
    // Every prop the others knocked over is down for C, and went down quietly.
    let all = false, state = [];
    for (const end = Date.now() + 60000; Date.now() < end && !all;) {
      state = [];
      for (const p of felled) state.push(await C.ask(downAt, [p.x, p.z]));
      all = felled.length > 0 && state.every((s) => s === true);
      if (!all) await sleep(500);
    }
    const c1 = await C.net(), a1 = await A.net(), b1 = await B.net(), sa = since(A, wa0), sb = since(B, wb0);
    const lists = sa.of('2.5') + sb.of('2.5'), listB = sa.bytesOf('2.5') + sb.bytesOf('2.5');
    check(all && c1.props.listsGot >= 1 && c1.props.listFelled >= felled.length && c1.props.felled === 0, 'the props knocked over before C came are down on C\'s screen, quietly', `${felled.length} props: ${JSON.stringify(state)}; C heard ${c1.props.listsGot} list(s), ${c1.props.listFelled} went down for it without a sound and ${c1.props.felled} with one`);
    check(lists >= 1 && lists <= 2, 'told by the host in one frame of 4 bytes a prop, when C arrived', `${lists} list frame(s), ${listB} bytes for ${a1.props.down} props down on A and ${b1.props.down} on B (lists sent before C: ${a0.props.listsSent + b0.props.listsSent})`);
    // The wrecks: C is shown what the host has standing.
    r = await rolesSoon([A, B, C], 60000);
    if (!r) check(false, 'the wrecks standing in town are on C\'s screen', 'nobody was the host of three');
    else {
      // (The service may have made C the host by now: then C is running the wrecks it was shown, which is the same proof.
      // So C is held against A, who was there for every one of them.)
      const H = r.host;
      const hw = await A.ask(wrecksNear, [SPOT.x, SPOT.z, 400]);
      const cw = await C.when((g, [x, z, want]) => { const l = g.vehicles.list.filter((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 400); return l.length >= want && want > 0 ? l.map((v) => ({ x: +v.x.toFixed(1), z: +v.z.toFixed(1) })) : null; }, [SPOT.x, SPOT.z, hw.length], 30000);
      const match = !!cw && cw.length === hw.length && hw.every((w) => cw.some((c) => Math.hypot(c.x - w.x, c.z - w.z) < 2));
      check(hw.length > 0 && match, 'the wrecks standing in town are on C\'s screen', `A has ${hw.length}: ${JSON.stringify(hw.map((w) => [w.x, w.z]))}; C: ${JSON.stringify((cw ?? await C.ask(wrecksNear, [SPOT.x, SPOT.z, 400])).map((w) => [w.x, w.z]))}; the host of the three is ${H.tag}`);
    }
    const errs = C.errors.filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8842/.test(e));
    check(errs.length === 0, 'no errors from the game on C\'s page', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    open.splice(open.indexOf(C), 1); await C.close();
    await A.until((x) => x.count === 2, 30000); await B.until((x) => x.count === 2, 30000);
  }

  // ── 9. A wreck is tidied away for everybody once nobody is near it, and not while somebody is ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      r = await rolesSoon([A, B], 60000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0];
      for (const t of [H, G]) await calm(t);
      await G.go(SPOT.x, SPOT.z, Math.PI / 2);
      await sleep(1500);
      const before = await H.ask(wrecksNear, [SPOT.x, SPOT.z, 140]);
      if (before.length === 0) { detail = 'no wreck left within 140 m of the spot on the host'; break; }
      // The host walks off; the guest is still standing among them.
      await H.go(AWAY.x, AWAY.z, 0);
      await H.until((x) => x.remotes[0] && Math.hypot(x.remotes[0].x - SPOT.x, x.remotes[0].z - SPOT.z) < 3, 15000);
      await sleep(8000);
      const kept = await H.ask(wrecksNear, [SPOT.x, SPOT.z, 140]), keptG = await G.ask(wrecksNear, [SPOT.x, SPOT.z, 140]);
      if ((await roles([A, B]))?.host !== H) { detail = 'the host changed'; continue; }
      // Then the guest leaves too.
      await G.go(AWAY.x + 20, AWAY.z, 0);
      const gone = await H.when((g, [x, z]) => g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 140) ? null : true, [SPOT.x, SPOT.z], 60000);
      const goneG = await G.when((g, [x, z]) => g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 140) ? null : true, [SPOT.x, SPOT.z], 20000);
      if (!gone && (await roles([A, B]))?.host !== H) { detail = 'the host changed'; continue; }
      done = true;
      check(kept.length === before.length && keptG.length === before.length, 'with the host far away and a guest still near, the wrecks stay', `${before.length} wreck(s) near the spot; 8 s after the host left: host ${kept.length}, guest ${keptG.length}`);
      check(gone === true && goneG === true, 'once nobody is near they are tidied away, on both screens', `host: ${gone === true ? 'gone' : JSON.stringify(await H.ask(wrecksNear, [SPOT.x, SPOT.z, 140]))}; guest: ${goneG === true ? 'gone' : JSON.stringify(await G.ask(wrecksNear, [SPOT.x, SPOT.z, 140]))}`);
    }
    if (!done) check(false, 'a wreck is tidied away once nobody is near', `the last: ${detail}`);
  }

  // ── 9b. A guest far from a fire does not pay for it: the car is shown for what it is, and no fire is lit there ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      r = await rolesSoon([A, B], 60000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0];
      for (const t of [H, G]) await calm(t);
      await G.go(AWAY.x + 20, AWAY.z, 0);
      const car = await G.ask(pickParked, [SPOT.x, SPOT.z, 16, 70, used]);
      if (!car) { detail = 'no untouched parked car of the town\'s near the spot on the guest\'s screen'; await sleep(2500); continue; }
      used.push(car.place);
      if (!(await H.ask(parkedSame, car))) { detail = `the host does not have the car of place ${car.place} parked there`; continue; }
      const ux = SPOT.x - car.x, uz = SPOT.z - car.z, ul = Math.hypot(ux, uz) || 1;
      await H.go(car.x + ux / ul * 15, car.z + uz / ul * 15, Math.atan2(-ux, -uz));
      await sleep(2000);
      const gi = await G.info(), far = Math.hypot(gi.x - car.x, gi.z - car.z);
      if (!(await H.ask((g, c) => { const v = g.net.cars.parkedAt(c.place); if (!v) return false; v.health = 15; return true; }, car))) { detail = 'the host lost the car before it could be lit'; continue; }
      const hf = await H.when(fireAt, [car.x, car.z, 4], 20000);
      const shown = await G.when((g, c) => { for (const v of g.vehicles.list) if (v.shared && Math.hypot(v.x - c.x, v.z - c.z) < 3 && v.health < 20) return { health: +v.health.toFixed(1) }; return null; }, car, 20000);
      if (!shown && (await roles([A, B]))?.host !== H) { detail = 'the host changed'; continue; }
      await sleep(1500);
      const gf = await G.ask(fireAt, [car.x, car.z, 6]), fires = (await G.net()).fight.burns.length;
      done = true;
      check(!!hf && !!shown && !gf && fires === 0, 'a guest far from a burning car is shown its state and lights no fire for it', `the guest is ${far.toFixed(0)} m away: it shows the car at ${shown ? shown.health : '?'} health and has ${fires} fire(s) burning; the host, beside it, has its fire: ${!!hf}`);
    }
    if (!done) check(false, 'a guest far from a burning car is shown its state and lights no fire for it', `4 tries; the last: ${detail}`);
  }

  {
    const errs = [...A.errors, ...B.errors].filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8842/.test(e));
    check(errs.length === 0, 'no errors from the game on either page on main', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    for (const t of [A, B]) { open.splice(open.indexOf(t), 1); await t.close(); }
  }

  // ── 10. A backup style connection: a player's own car still shows; props and wrecks stay private; no host is told ──
  {
    const D = await visitor('D', viaBackup), E = await visitor('E', viaBackup);
    let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
    check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
    const did = nd.id;
    await E.go(SPOT.x, SPOT.z + 15, Math.PI);
    await D.go(SPOT.x, SPOT.z, Math.PI / 2);
    for (const t of [D, E]) await calm(t);
    // A prop goes over on D: it is D's own business.
    const list = await D.ask(propsNear, [SPOT.x, SPOT.z, 70, [[SPOT.x, SPOT.z], [SPOT.x, SPOT.z + 15]]]);
    let p = null;
    for (const c of list) { if ((await E.ask(downAt, [c.x, c.z])) === false) { p = c; break; } }
    if (p) await D.ask(knock, [p.x, p.z, 6, 0]);
    // D's own car, alight: the damage rides in the state frames D sends anyway.
    await D.page.evaluate(() => { window.__game.drive('sedan'); const g = window.__game.game; g.player.vehicle.ctl.handbrake = true; });
    await E.until((x) => x.remotes[0] && x.remotes[0].vehicle === 'sedan', 20000);
    await D.page.evaluate(() => { const g = window.__game.game; g.player.vehicle.health = 40; });
    const steam = await E.until((x) => x.remotes[0] && x.remotes[0].damage === 9, 15000);
    await D.page.evaluate(() => { const g = window.__game.game; g.player.vehicle.health = 15; g.player.health = 100; });
    const fire = await E.when((g, id) => { const c = g.net.remotes.get(id)?.vehicle; if (!c || c.health >= 20) return null; const f = g.player.weapons.burnInfo().find((b) => Math.hypot(b.x - c.x, b.z - c.z) < 4); return f && f.told ? { health: +c.health.toFixed(1) } : null; }, did, 20000);
    check(!!steam && !!fire, 'on the backup another player\'s own car is still shown steaming, then alight', `E shows D's sedan: 40 health -> ${steam ? 'step 9' : 'not seen'}; 15 health -> ${fire ? `${fire.health} with a fire on it` : JSON.stringify((await E.net()).remotes[0])}`);
    const e0 = await E.net();
    const up2 = await D.when((g) => { const pl = g.player; return !pl.vehicle && g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - pl.x, v.z - pl.z) < 30) ? true : null; }, null, 150000);
    const e1 = await E.until((x) => x.fight.blastsDone > e0.fight.blastsDone, 15000) ?? await E.net();
    await sleep(5000);
    const ew = await E.ask(wrecksNear, [SPOT.x, SPOT.z, 60]), dw = await D.ask(wrecksNear, [SPOT.x, SPOT.z, 60]);
    check(!!up2 && e1.fight.blastsDone === e0.fight.blastsDone + 1, 'it goes up on its owner\'s browser and the other sees the blast', `went up on D: ${!!up2}; E heard ${e1.fight.blastsDone - e0.fight.blastsDone} blast`);
    const nd2 = await D.net(), ne2 = await E.net();
    const pe = p ? await E.ask(downAt, [p.x, p.z]) : null;
    check(!!p && pe === false && nd2.props.sent === 0 && ne2.props.got === 0, 'a prop knocked over there stays private', p ? `a ${p.kind} down on D: ${await D.ask(downAt, [p.x, p.z])}, on E: ${pe}; prop events sent by D: ${nd2.props.sent}` : 'no prop standing on both screens to try');
    check(dw.length === 1 && ew.length === 0, 'and so does the wreck: it is left on its owner\'s screen alone', `wrecks: D ${JSON.stringify(dw)}, E ${JSON.stringify(ew)}`);
    const toHost = (t) => Object.keys(t.out.n).filter((k) => k.startsWith('2.') || k.startsWith('4.') || k === '5' || k === '3.8');
    check(toHost(D).length === 0 && toHost(E).length === 0 && nd2.traffic.mode === 'local' && ne2.people.mode === 'local', 'and nothing is sent to or by any host there', `kinds on the wire: ${[...new Set([...Object.keys(D.out.n), ...Object.keys(E.out.n)])].join(', ')}`);
    const errs2 = [...D.errors, ...E.errors];
    check(errs2.length === 0, 'no errors on the backup pages', errs2.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
  }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  for (const t of open.splice(0)) await t.close().catch(() => {});
  lookup.close();
  await stop(home); await stop(backup);
  for (const c of kids) await stop(c);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
