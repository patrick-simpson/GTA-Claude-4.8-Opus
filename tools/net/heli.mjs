// Multiplayer stage 3, last step: the same police helicopter for everyone. Headless browsers against LOCAL services.
//
//   node tools/net/heli.mjs              every check, and two pictures into shots/net/
//   node tools/net/heli.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/police.mjs does (read its header): the Node
// home on 8841 is "main" (found through a lookup stand-in on 8842) and a second copy on 8843 is reached as a plain
// `?net=` address, which the game treats as the BACKUP. Never run two of these tests at once.
// Checks: nothing about a helicopter is sent while none is up; a guest's copy glides between two words from the
// host (the game's own code, driven by hand on a stopped clock); a guest at four pips gets the HOST's helicopter,
// and its own screen shows the same one in the same place, lamp lit, lamp on its own player; what that costs on the
// wire; a cruiser set alight keeps its number and its car on the guest; with host and guest both at four pips the
// one helicopter stays where it is, and goes to the host when the guest loses its heat (the guest sees the lamp on
// the host); the host leaves with the helicopter up and the next host flies it on from where it was; nobody wanted,
// it flies off and is gone from both skies and from the wire; on a backup style connection it is private.
// The test makes its own situations and says where it does:
//  - WHO IS HOST is pinned as in police.mjs (the wanted browser says it cannot host, as a hidden tab does).
//  - Heat is set with the game's own test hook (setHeat), and the wanted are healed and re-wanted as the test goes,
//    so a part is not ended by the Patrol's bullets or by the search clock.
//  - It is made evening on every page (setTime), because the lamp is only lit after dark.
//  - The burning cruiser is set alight by writing its health on the host.
// The pages run in real time at a fraction of full speed (no video card here); every wait ends as soon as what it
// waits for has happened. Nothing is listened to: the sound is checked only as "the sound's code is given a level".
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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-heli-'));
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
async function visitor(tag, query, size = [480, 270], again = false) {
  const t = await boot({ start: false, query: `q=low&${query}`, width: size[0], height: size[1] });
  open.push(t);
  t.tag = tag;
  // Binary frames this page sends, counted on the wire itself: by kind, and for World, ToHost and ToPlayer frames by
  // what they carry ('2.4' is the police beat, '4.8' a guest's heat, '5.3' '5.4' '5.5' a hurt, a bust, a crime).
  t.out = { n: {}, bytes: {} };
  t.beats = []; t.tails = {};
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] === 2 || p[0] === 4 || p[0] === 5 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
    // A police beat: what is left after its shots is the helicopter (6 bytes on its way, 7 lamp on a player, 8 sweeping).
    if (k === '2.4') { const tail = p.length - 5 - 7 * p[4]; t.beats.push(tail); if (tail > 0) t.tails[tail] = (t.tails[tail] ?? 0) + 1; }
  }));
  // (A plain `?net=` page opens its socket while it boots, before anything here is listening: loaded a second time,
  // every frame it ever sends is counted.)
  if (again) {
    await t.page.reload({ waitUntil: 'load' });
    await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  }
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000, every = 200) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(every); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  t.heat = (n) => t.page.evaluate((n) => window.__game.setHeat(n), n);
  t.heal = () => t.page.evaluate(() => { const p = window.__game.game.player; if (p.health > 0) p.health = 100; });
  /** Host only: somebody stands at (x, z) facing h. Returns their number, 0 when this page is not simulating. */
  t.stand = (x, z, h = 0, secs = 150) => t.page.evaluate(([x, z, h, secs]) => {
    const g = window.__game.game;
    if (g.net.people.mode !== 'host') return 0;
    return g.systems.find((s) => s.peds && s.traffic).peds.stand(x, z, h, secs);
  }, [x, z, h, secs]);
  /** "I cannot host", as a hidden tab says it (see the header). */
  t.pin = (on) => t.page.evaluate((on) => { if (on) Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); else delete document.hidden; }, on);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wire = (t, k, what = 'n') => t.out[what][k] ?? 0;
/** Is `h` running the town's police and every one of `gs` shown them? */
async function settled(h, gs, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const [nh, ...ng] = await Promise.all([h.net(), ...gs.map((g) => g.net())]);
    if (nh.traffic.mode === 'host' && nh.police.mode === 'host' && ng.every((x) => x.traffic.mode === 'guest' && x.police.mode === 'guest' && x.host === nh.id)) return true;
    await sleep(300);
  }
  return false;
}
const lit = (n) => n.police.units.filter((u) => u.lit);
/** Meters from p to the stretch between a and b, on the map. */
function toSegment(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}
/**
 * The helicopter on the flying browser `h` and on `g`, which is shown it, over `looks` looks. worst: how far apart at
 * the same look. That is mostly time, not place: it is flying at about 20 m/s, a guest glides to each word of it over
 * the 400 ms the next takes, and here the pages draw only a frame or two a second and are read a moment apart, so
 * the figure is reported and not judged. trail: how far the shown one is from the PATH the flier took over this look
 * and the four before (straight lines between the looks): "the same helicopter on the same track, a moment behind",
 * which is what is judged. Also the worst differences in height and heading at the same look.
 */
async function sameSky(h, g, looks, wanted, every = 400) {
  const r = { looks: 0, both: 0, lit: 0, worst: 0, trail: 0, y: 0, h: 0, speed: 0, each: '' }, was = [], each = [];
  const read = (t) => t.page.evaluate(() => ({ n: window.__game.net(), at: Date.now(), frame: window.__game.game.frame }));
  for (let k = 0; k < looks; k++) {
    const [rh, rg] = await Promise.all([read(h), read(g)]);
    const nh = rh.n, ng = rg.n, a = nh.police.heli, b = ng.police.heli;
    r.looks++;
    // (How far apart, how fast the flier was going by the wall clock since the last look, how long after the flier
    // the shown one was read, and how old its last word was.)
    const last = was[was.length - 1], speed = last && rh.at > last.at ? Math.hypot(a.x - last.x, a.z - last.z) / ((rh.at - last.at) / 1000) : 0;
    a.at = rh.at;
    if (speed > 0) r.speed = Math.max(r.speed, speed);
    each.push(`${f1(Math.hypot(a.x - b.x, a.z - b.z))} m apart, flier at ${f1(speed)} m/s, read ${rg.at - rh.at} ms later, word ${b.age} ms old, frames drawn so far ${rh.frame} and ${rg.frame}`);
    was.push(a);
    if (a.present && b.present && b.shown) {
      r.both++;
      r.worst = Math.max(r.worst, Math.hypot(a.x - b.x, a.z - b.z)); r.y = Math.max(r.y, Math.abs(a.y - b.y));
      const path = was.slice(-5);
      let near = Math.hypot(a.x - b.x, a.z - b.z);
      for (let i = 1; i < path.length; i++) near = Math.min(near, toSegment(b, path[i - 1], path[i]));
      // (The first looks have no track behind them to measure against.)
      if (was.length >= 4) r.trail = Math.max(r.trail, near);
      let dh = a.h - b.h; dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI; r.h = Math.max(r.h, Math.abs(dh));
      if (a.lit && b.lit) r.lit++;
    }
    await keep(...wanted);
    await sleep(every);
  }
  r.each = each.join('; ');
  return r;
}
const f1 = (v) => (+v).toFixed(1);
const say = (h) => h ? `${h.present ? 'up' : 'not up'}${h.shown ? ' (the host\'s, shown)' : ''}${h.onStation ? ', on station' : h.away ? ', leaving' : h.present ? ', on its way' : ''}${h.lit ? ', lamp lit' : ''} at ${f1(h.x)}, ${f1(h.y)}, ${f1(h.z)}; lamp at ${f1(h.spotX)}, ${f1(h.spotZ)}; after ${h.after}${h.tracks ? ' (in sight)' : ''}` : 'no helicopter in info()';
/** Evening on a page: the first quarter hour after six at which the game calls it night enough for the lamp. Returns the hour. */
async function evening(t, hour) {
  if (hour !== undefined) { await t.page.evaluate((h) => window.__game.setTime(h), hour); return hour; }
  for (let h = 18; h <= 23; h += 0.25) {
    await t.page.evaluate((h) => window.__game.setTime(h), h);
    await sleep(700);
    if (await t.page.evaluate(() => window.__game.game.sky.night) > 0.45) return h;
  }
  return 23;
}
/** Keep `ts` alive and at `level` pips (each [page, level]) for one look. */
async function keep(...ts) {
  for (const [t, level] of ts) {
    await t.heal();
    if (level > 0) { const n = await t.net(); if (n.police.level < level) await t.heat(level); }
  }
}
/** Wait on page `t` for fn(net), keeping the wanted alive meanwhile. */
async function untilKept(t, fn, ms, wanted, every = 500) {
  for (const end = Date.now() + ms; ;) {
    const n = await t.net();
    if (fn(n)) return n;
    if (Date.now() > end) return null;
    await keep(...wanted);
    await sleep(every);
  }
}

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  // ── 1. Host and guest on main ──
  const size = SHOTS ? [960, 540] : [480, 270];
  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await visitor('B', viaMain, size);
  await B.pin(true);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}, ${n.count} in town` : 'timed out');
  const H = A, G = B;
  let ok = await settled(H, [G], 90000);
  let nh = await H.net(), ng = await G.net();
  check(ok, 'A runs the police for the town; B is shown them', `A ${nh.police.mode}, B ${ng.police.mode}`);
  if (!ok) throw new Error('no shared police');
  const gid = ng.id, hid = nh.id;
  const hour = await evening(H);
  // (The game makes no sound until a key or a click. This is the least of those: a pointer let go, on the guest's page.)
  await G.page.evaluate(() => window.dispatchEvent(new Event('pointerup')));
  await evening(G, hour);

  // The quiet street tools/net/police.mjs uses: the guest on it, the host a little way off.
  const LANE = { x: -340, z: 291.8 };
  const spot = { x: LANE.x - 20, z: LANE.z + 3 };
  const hostAt = { x: LANE.x + 10, z: LANE.z + 16 };
  await H.go(hostAt.x, hostAt.z, 0);
  await G.go(spot.x - 1, spot.z, Math.PI / 2);
  await sleep(2000);

  // ── 2. Nobody wanted: no helicopter anywhere, and none on the wire ──
  let idle = null;
  {
    const b0 = H.beats.length, [a0, g0] = await Promise.all([H.net(), G.net()]);
    await sleep(12000);
    const [a1, g1] = await Promise.all([H.net(), G.net()]);
    const beats = H.beats.slice(b0), bytes = beats.reduce((s, t) => s + 5 + Math.max(0, t), 0);
    idle = { beats: beats.length, bytes, all: (a1.sent.bytes - a0.sent.bytes) / 12, msgs: (a1.sent.msgs - a0.sent.msgs) / 12 };
    check(beats.length >= 3 && beats.every((t) => t === 0) && !a1.police.heli.present && !g1.police.heli.present && a1.police.heliSent === 0 && g1.police.heliGot === 0 && G.beats.length === 0,
      'nobody wanted: no helicopter in either sky, and the police beat carries none', `12 s: ${beats.length} beats of 5 bytes from the host = ${f1(bytes / 12)} bytes/s (tails: ${beats.join(',')}); the guest sent ${G.beats.length}; host: ${say(a1.police.heli)}`);
    console.log(`  idle, two in town, 12 s: the host sent ${f1(idle.all)} bytes/s in ${f1(idle.msgs)} messages/s of everything; the guest ${f1((g1.sent.bytes - g0.sent.bytes) / 12)} bytes/s`);
  }

  // ── 3. The glide itself, by hand on a stopped clock: the guest's copy is drawn BETWEEN two words from the host ──
  {
    const r = await G.page.evaluate(() => {
      const g = window.__game.game, heli = g.systems.find((s) => s.tag === 'police').heli, real = performance.now;
      let t = 100000;
      const out = [];
      try {
        performance.now = () => t;
        heli.show(t, 100, 60, 200, 0, false, 400);            // the first word: taken as it stands
        out.push([heli.x, heli.y, heli.z]);
        t += 400; heli.show(t, 108, 62, 200, 0.4, false, 400);  // the second, 400 ms on: 8 m east, 2 m up, turned 0.4
        for (const ms of [100, 100, 200, 100]) { t += ms; heli.follow(0.016, 0, 0, false); out.push([heli.x, heli.y, heli.z, heli.h]); }
        t += 2000; heli.follow(0.016, 0, 0, false); out.push([heli.x, heli.y, heli.z, heli.h]);
        // A page that draws less often than the words come: three more words 400 ms apart, each 8 m on, and one
        // frame drawn just after each (as happens when a word lands at the end of a long frame).
        heli.hide();
        heli.show(t, 200, 60, 200, 0, false, 400);
        for (let k = 1; k <= 3; k++) { t += 400; heli.show(t, 200 + 8 * k, 60, 200, 0, false, 400); t += 5; heli.follow(0.016, 0, 0, false); t -= 5; out.push([heli.x]); }
      } finally { performance.now = real; heli.hide(); }
      return out;
    });
    const near = (a, b) => Math.abs(a - b) < 0.02;
    const good = near(r[0][0], 100) && near(r[1][0], 102) && near(r[2][0], 104) && near(r[3][0], 108) && near(r[3][1], 62) && near(r[3][3], 0.4) && near(r[1][3], 0.1)
      && near(r[4][0], 110) && near(r[5][0], 111.2) && near(r[5][3], 0.4)
      // (Each of those frames finds it within a few cm of the word before: one word behind, never further.)
      && Math.abs(r[6][0] - 200.1) < 0.05 && Math.abs(r[7][0] - 208.1) < 0.2 && Math.abs(r[8][0] - 216.1) < 0.2;
    check(good, 'a guest\'s copy glides between two words from the host, and only a little past the last', `told x 100 then 108 (400 ms apart): drawn at ${r.slice(1, 5).map((p) => f1(p[0])).join(', ')} after 100, 200, 400, 500 ms, heading ${r[1][3].toFixed(2)} to ${r[3][3].toFixed(2)}; with no further word it stops at ${f1(r[5][0])} (40% past); a page that draws one frame a word, just after each of 208, 216, 224 arrives, draws it at ${r.slice(6).map((p) => f1(p[0])).join(', ')} (one word behind, no further)`);
  }

  // ── 4. The guest at four pips: the HOST flies a helicopter out for it, and the guest is shown that one ──
  const wantG = [[G, 4]], t4 = Date.now();
  await G.heal();
  await G.heat(4);
  {
    nh = await untilKept(H, (x) => x.police.heli.present && x.police.heli.after === gid, 60000, wantG, 250);
    check(!!nh && !nh.police.heli.shown && nh.police.level === 0, 'the host calls the helicopter out for the wanted guest (the host itself is not wanted)', nh ? `host: ${say(nh.police.heli)}; ${f1(Math.hypot(nh.police.heli.x - spot.x, nh.police.heli.z - spot.z))} m from the guest; host level ${nh.police.level}` : `none in 60 s: ${say((await H.net()).police.heli)}; the host has the guest at level ${(await H.net()).police.wanted.find((w) => w.id === gid)?.level}`);
    ng = await untilKept(G, (x) => x.police.heli.present && x.police.heli.shown, 20000, wantG, 250);
    const own = ng ? ng.police.spawned : -1;
    check(!!ng && ng.police.mode === 'guest', 'the guest is shown it: the helicopter in its sky is the host\'s, not one of its own', ng ? `guest: ${say(ng.police.heli)}; ${ng.police.heliGot} words of it heard` : `not shown in 20 s: ${say((await G.net()).police.heli)}`);
    check((H.tails[6] ?? 0) >= 1 && G.beats.length === 0, 'on its way in it is 6 bytes on the end of the police beat (place, height, heading), and only the host sends it', `host beats with a tail so far: ${JSON.stringify(H.tails)} (by tail length); guest beats ${G.beats.length}; cars made by the guest's own Patrol: ${own}`);
  }

  // ── 5. On station: the same place on both screens, lamp lit on both, lamp on the guest ──
  {
    nh = await untilKept(H, (x) => x.police.heli.onStation && x.police.heli.after === gid, 500000, wantG);
    check(!!nh, 'it flies in and takes up station over the guest', nh ? `after ${((Date.now() - t4) / 1000).toFixed(0)} s on the wall; host: ${say(nh.police.heli)}` : `not on station after 500 s: ${say((await H.net()).police.heli)}`);
    const sky = await sameSky(H, G, 14, wantG, 500);
    console.log(`  look by look: ${sky.each}`);
    check(sky.both === sky.looks && sky.trail < 12 && sky.y < 4, 'the guest\'s screen has it where the host has it', `${sky.both} of ${sky.looks} looks with it on both screens; never more than ${f1(sky.trail)} m off the track the host flew over the last four looks; ${f1(sky.worst)} m apart at the same look (not judged: it is flying, at up to ${f1(sky.speed)} m/s by the wall clock here, and the guest is shown it a moment in the past); ${f1(sky.y)} m in height, ${sky.h.toFixed(2)} rad in heading at the same look${sky.trail < 12 ? '' : '. Each look: ' + sky.each}`);
    check(sky.lit >= sky.looks - 3, 'after dark its lamp is lit on both screens', `lit on both at ${sky.lit} of ${sky.looks} looks; it is ${hour} hours by the game's clock on both pages`);

    // The lamp is on the wanted guest: by the host's reckoning (in sight), and on each screen where that screen has the guest.
    let got = null;
    for (const end = Date.now() + 300000; Date.now() < end && !got;) {
      const [a, b, gi] = await Promise.all([H.net(), G.net(), G.info()]);
      const seenAt = a.remotes.find((r) => r.id === gid);
      const dh = seenAt ? Math.hypot(a.police.heli.spotX - seenAt.x, a.police.heli.spotZ - seenAt.z) : 99, dg = Math.hypot(b.police.heli.spotX - gi.x, b.police.heli.spotZ - gi.z);
      if (a.police.heli.tracks && a.police.heli.after === gid && b.police.heli.after === gid && dh < 9 && dg < 9) got = { a, b, dh, dg };
      else { await keep(...wantG); await sleep(400); }
    }
    [nh, ng] = await Promise.all([H.net(), G.net()]);
    check(!!got, 'its crew gets the guest in sight and the lamp is on the guest, on the host\'s screen and on the guest\'s own', got ? `the lamp rests ${f1(got.dh)} m from the guest as the host shows it and ${f1(got.dg)} m from the guest on its own screen; the guest was told "the lamp is on player ${got.b.police.heli.after}" (its own number is ${gid})` : `not in 300 s. host: ${say(nh.police.heli)}; guest: ${say(ng.police.heli)}`);
    check((H.tails[7] ?? 0) >= 1, 'a lamp on a player is one more byte: that player\'s number (7 in all)', `host beats by tail length: ${JSON.stringify(H.tails)}`);
    ng = await untilKept(G, (x) => x.police.seen && x.police.heli.tracks, 60000, wantG, 250);
    check(!!ng, 'and the guest counts itself seen (its own reckoning, as with officers)', ng ? `seen ${ng.police.seen}, level ${ng.police.level}; ${lit(ng).length} cruisers on duty shown to it as well, so this does not prove the helicopter alone did it` : 'not seen in 60 s');

    // The sound's own code is given a level for it on the guest (nothing is listened to; with no sound device this is as far as it goes).
    const snd = await G.page.evaluate(() => { const a = window.__game.game.audio, t = a && a.trouble; return t && t.heli ? { level: t.heli.level, state: a.ctx ? a.ctx.state : (a.core && a.core.ctx ? a.core.ctx.state : '?') } : null; });
    if (snd && snd.level > 0) check(true, 'the guest\'s sound code is playing the helicopter (a level above nothing; not listened to)', `level ${snd.level.toFixed(3)} of 1; audio context ${snd.state}`);
    else console.log(`NOTE  the helicopter's sound on the guest could not be checked here: ${snd ? `level ${snd.level}, audio ${snd.state}` : 'the sound has not been started on a page nobody has clicked'}. The sound reads the same helicopter object that is drawn.`);

    // Drawn frames against words from the host, on the guest.
    const fr = await G.page.evaluate(() => new Promise((res) => {
      const g = window.__game.game, heli = g.systems.find((s) => s.tag === 'police').heli, st = g.net.police.stats;
      const t0 = performance.now(), w0 = st.heliGot;
      let frames = 0, moved = 0, path = 0, big = 0, lx = heli.x, lz = heli.z;
      const tick = () => {
        const d = Math.hypot(heli.x - lx, heli.z - lz);
        frames++; if (d > 0.001) moved++; path += d; big = Math.max(big, d); lx = heli.x; lz = heli.z;
        if (performance.now() - t0 < 8000) requestAnimationFrame(tick); else res({ frames, moved, path, big, words: st.heliGot - w0 });
      };
      requestAnimationFrame(tick);
    }));
    if (fr.frames >= fr.words * 2) check(fr.moved > fr.words * 1.5 && fr.big < 3 * (fr.path / Math.max(1, fr.moved)) + 1.5, 'between words it keeps moving on the guest\'s screen, with no jumps', `8 s: ${fr.words} words from the host, ${fr.frames} frames drawn, it moved in ${fr.moved} of them; ${f1(fr.path)} m flown, the longest single step ${fr.big.toFixed(2)} m`);
    else console.log(`NOTE  smoothness on the guest's screen could not be judged at this speed: ${fr.frames} frames drawn against ${fr.words} words from the host in 8 s (it moved in ${fr.moved}; longest step ${fr.big.toFixed(2)} m). Check 3 is the proof of the glide.`);

    // ── Pictures: the helicopter and its lamp, from the same place on both screens ──
    if (SHOTS) {
      nh = await H.net();
      const a = nh.police.heli, d = Math.max(1, Math.hypot(a.x - a.spotX, a.z - a.spotZ)), ux = (a.x - a.spotX) / d, uz = (a.z - a.spotZ) / d;
      const view = [a.spotX - ux * 62, 30, a.spotZ - uz * 62, (a.x + a.spotX) / 2, a.y * 0.5, (a.z + a.spotZ) / 2];
      for (const t of [H, G]) await t.page.evaluate((v) => window.__game.view(...v), view);
      await sleep(3500);
      const shots = await Promise.all([H.shot('shots/net/heli-host.png'), G.shot('shots/net/heli-guest.png')]);
      [nh, ng] = await Promise.all([H.net(), G.net()]);
      for (const t of [H, G]) await t.page.evaluate(() => window.__game.view());
      console.log('shots', shots.join(' '), `(host: ${say(nh.police.heli)}; guest: ${say(ng.police.heli)}; camera 62 m back from the lamp's pool at 30 m up, looking at the middle of the beam)`);
    }
  }

  // ── 6. What it costs while it is up ──
  {
    await keep(...wantG);
    const b0 = H.beats.length, w0 = { ...H.out.bytes }, [a0, g0] = await Promise.all([H.net(), G.net()]);
    for (let k = 0; k < 10; k++) { await sleep(2000); await keep(...wantG); }
    const [a1, g1] = await Promise.all([H.net(), G.net()]);
    const beats = H.beats.slice(b0), withHeli = beats.filter((t) => t >= 6), tailBytes = withHeli.reduce((s, t) => s + t, 0), beatBytes = (H.out.bytes['2.4'] ?? 0) - (w0['2.4'] ?? 0);
    console.log(`  helicopter up, 20 s: ${beats.length} police beats = ${beatBytes} bytes = ${f1(beatBytes / 20)} bytes/s, ${f1(beats.length / 20)} a second (idle was ${f1(idle.bytes / 12)} bytes/s); ${withHeli.length} carried the helicopter, ${tailBytes} bytes of it = ${f1(tailBytes / 20)} bytes/s; officers' shots ride the same frames (${a1.police.shotsSent - a0.police.shotsSent} shots in that time, 7 bytes each)`);
    console.log(`  everything the host sent in that time: ${f1((a1.sent.bytes - a0.sent.bytes) / 20)} bytes/s in ${f1((a1.sent.msgs - a0.sent.msgs) / 20)} messages/s (traffic ${f1(((H.out.bytes['2.1'] ?? 0) - (w0['2.1'] ?? 0)) / 20)}, people ${f1(((H.out.bytes['2.3'] ?? 0) - (w0['2.3'] ?? 0)) / 20)} bytes/s: a level 4 chase is on, ${a1.police.units.length} cruisers and ${a1.police.officers.length} officers out); the guest ${f1((g1.sent.bytes - g0.sent.bytes) / 20)} bytes/s`);
    check(withHeli.length >= 20 && withHeli.length <= 75 && tailBytes / 20 <= 25, 'the helicopter adds at most 25 bytes a second of its own, and the beat goes at most three or so times a second for it', `${withHeli.length} beats with it in 20 s (one every 400 ms would be 50); ${f1(tailBytes / 20)} bytes/s of helicopter; the whole beat ${f1(beatBytes / 20)} bytes/s`);
    check((a1.sent.msgs - a0.sent.msgs) / 20 < 40, 'the host stays inside the rate limit (40 messages a second)', `${f1((a1.sent.msgs - a0.sent.msgs) / 20)} a second`);
  }

  // ── 7. A cruiser set alight: the same car under the same number on the guest (not taken away and redrawn) ──
  {
    let done = false, detail = 'no cruiser on duty was on both screens in 240 s';
    for (const end = Date.now() + 240000; Date.now() < end && !done;) {
      [nh, ng] = await Promise.all([H.net(), G.net()]);
      const u = nh.police.units.find((x) => x.lit && !x.shown && x.id && ng.police.units.some((y) => y.shown && y.id === x.id));
      if (!u) { await keep(...wantG); await sleep(700); continue; }
      const id = u.id;
      const marked = await G.page.evaluate((id) => { const s = window.__game.game.net.shared.cars.get(id); if (!s) return false; s.v.__heliTest = id; return true; }, id);
      const lit0 = await H.page.evaluate((id) => { const g = window.__game.game, u = g.systems.find((s) => s.tag === 'police').units.find((x) => x.wid === id && !x.shown); if (!u) return false; u.v.health = 12; return true; }, id);
      if (!marked || !lit0) { detail = `cruiser ${id} left one of the screens before it could be lit`; continue; }
      // The crew runs from it: it is no longer the Patrol's, and goes on in the frames as a standing car.
      nh = await untilKept(H, (x) => !x.police.units.some((y) => y.id === id) && x.traffic.cars.some((c) => c.id === id && c.driver === null), 60000, wantG, 300);
      const hc = nh ? nh.traffic.cars.find((c) => c.id === id) : null;
      const gc = await untilKept(G, (x) => { const c = x.traffic.cars.find((y) => y.id === id); return !!c && c.driver === null && c.health < 20 && !x.police.units.some((y) => y.id === id); }, 30000, wantG, 300);
      const same = await G.page.evaluate((id) => { const s = window.__game.game.net.shared.cars.get(id); return s ? { same: s.v.__heliTest === id, kind: s.v.spec.kind, health: s.v.health, wreck: !!s.v.wreck, others: window.__game.game.vehicles.list.filter((v) => v.__heliTest === id).length } : null; }, id);
      done = true;
      check(!!hc && hc.kind === 'cruiser', 'a cruiser set alight on the host is let go by the Patrol and stays in the town\'s frames under the number it had', nh ? `cruiser ${id}: on the host no longer a unit, in the traffic list as a ${hc.kind} with nobody in it, health ${hc.health}` : `60 s: host units ${(await H.net()).police.units.map((x) => x.id).join(',')}; traffic has ${id}: ${(await H.net()).traffic.cars.some((c) => c.id === id)}`);
      check(!!gc && !!same && same.same && same.kind === 'cruiser' && same.others === 1, 'the guest goes on showing the SAME car under that number, now alight (it is not taken away and drawn again)', same ? `number ${id} on the guest: ${same.same ? 'the very car that was marked before the fire' : 'a different car'}, a ${same.kind}, health ${f1(same.health)}${same.wreck ? ', burnt out' : ''}; marked cars on its street: ${same.others}` : `number ${id} is not on the guest's street`);
    }
    if (!done) { check(false, 'a cruiser set alight on the host is let go by the Patrol and stays in the town\'s frames under the number it had', detail); }
  }

  // ── 8. Host and guest both at four pips: ONE helicopter, and it stays where it is; then the guest loses its heat ──
  {
    await H.heal(); await H.heat(4);
    const both = [[G, 4], [H, 4]];
    let stayed = 0, looks = 0, hl = 0, one = true;
    for (let k = 0; k < 10; k++) {
      await keep(...both);
      await sleep(800);
      [nh, ng] = await Promise.all([H.net(), G.net()]);
      looks++; hl = Math.max(hl, nh.police.level);
      if (nh.police.heli.present && nh.police.heli.after === gid) stayed++;
      if (ng.police.heli.present && !ng.police.heli.shown) one = false;
    }
    check(hl >= 4 && stayed === looks && one, 'the host is wanted at four pips too: the one helicopter stays with the guest it is on', `host level ${hl}; over the guest at ${stayed} of ${looks} looks; the guest has ${one ? 'no helicopter of its own' : 'a private one as well'}`);
    await G.heat(0);
    const wantH = [[H, 4]];
    nh = await untilKept(H, (x) => x.police.heli.present && x.police.heli.after === hid, 30000, wantH, 250);
    check(!!nh, 'the guest loses its heat: the helicopter goes over to the host, who is still wanted', nh ? `host: ${say(nh.police.heli)}; the host has the guest at level ${nh.police.wanted.find((w) => w.id === gid)?.level}` : `not in 30 s: ${say((await H.net()).police.heli)}`);
    let got = null;
    for (const end = Date.now() + 300000; Date.now() < end && !got;) {
      const [a, b, hi, gi] = await Promise.all([H.net(), G.net(), H.info(), G.info()]);
      const hostAsShown = b.remotes.find((r) => r.id === hid);
      const d = hostAsShown ? Math.hypot(b.police.heli.spotX - hostAsShown.x, b.police.heli.spotZ - hostAsShown.z) : 99, own = Math.hypot(b.police.heli.spotX - gi.x, b.police.heli.spotZ - gi.z);
      if (a.police.heli.tracks && b.police.heli.after === hid && d < 9 && Math.hypot(a.police.heli.spotX - hi.x, a.police.heli.spotZ - hi.z) < 9) got = { d, own, apart: Math.hypot(hi.x - gi.x, hi.z - gi.z), lvl: b.police.level };
      else { await keep(...wantH); await sleep(400); }
    }
    [nh, ng] = await Promise.all([H.net(), G.net()]);
    check(!!got && got.lvl === 0, 'and the guest, no longer wanted, sees the lamp on the host (as its own screen shows the host)', got ? `on the guest's screen the lamp rests ${f1(got.d)} m from the host and ${f1(got.own)} m from the guest itself (they stand ${f1(got.apart)} m apart); guest level ${got.lvl}` : `not in 300 s. host: ${say(nh.police.heli)}; guest: ${say(ng.police.heli)}`);
    await H.heat(0);
    await G.heal(); await G.heat(4);
  }

  // ── 9. The host leaves with the helicopter up: the next host flies it on from where it was ──
  let C = null;
  {
    C = await visitor('C', viaMain);
    await C.pin(true);
    n = await C.until((x) => x.status === 'online' && x.count === 3);
    check(!!n, 'a third browser joins', n ? `${n.count} in town` : 'timed out');
    await evening(C, hour);
    ok = await settled(H, [G, C], 90000);
    if (!ok) throw new Error('three browsers: the police did not settle on A');
    await keep(...wantG);
    nh = await untilKept(H, (x) => x.police.heli.present && x.police.heli.onStation && x.police.heli.after === gid, 300000, wantG);
    let nc = await untilKept(C, (x) => x.police.heli.present && x.police.heli.shown, 20000, wantG);
    check(!!nh && !!nc, 'the helicopter is up over the wanted guest again, and the third browser is shown it too', nh && nc ? `host: ${say(nh.police.heli)}; third: ${say(nc.police.heli)}` : `host: ${say((await H.net()).police.heli)}; third: ${say((await C.net()).police.heli)}`);
    await keep(...wantG);
    const before = (await C.net()).police.heli;
    await C.pin(false);
    await C.page.evaluate(() => { window.__game.game.net.perfAt = 0; });
    const tl = Date.now();
    await leave(H);
    // The guest's sky, watched through the change: is there ever no helicopter in it?
    let gaps = 0, glooks = 0;
    for (const end = Date.now() + 60000; Date.now() < end;) {
      const [c, g] = await Promise.all([C.net(), G.net()]);
      glooks++; if (!g.police.heli.present) gaps++;
      if (c.police.mode === 'host' && g.police.mode === 'guest' && g.host === c.id && c.traffic.mode === 'host') break;
      await sleep(250);
    }
    nc = await C.net();
    const took = (Date.now() - tl) / 1000, a = nc.police.heli;
    check(nc.police.mode === 'host' && a.present && !a.shown && !a.away, 'the host (A) leaves: the third browser runs the police, and the helicopter it was showing is its own to fly', `C ${nc.police.mode} ${took.toFixed(1)} s after A was closed; ${say(a)}`);
    check(Math.hypot(a.x - before.x, a.z - before.z) < 30 + took * 8 && Math.abs(a.y - before.y) < 15, 'from where it was, not from over the water again', `${f1(Math.hypot(a.x - before.x, a.z - before.z))} m from where C last showed it under the old host, ${f1(Math.abs(a.y - before.y))} m in height, ${took.toFixed(1)} s on`);
    nc = await untilKept(C, (x) => x.police.heli.present && x.police.heli.after === gid && !x.police.heli.away, 30000, wantG, 250);
    check(!!nc, 'it is out for the same wanted guest under the new host', nc ? say(nc.police.heli) : `not in 30 s: ${say((await C.net()).police.heli)}; C has the guest at level ${(await C.net()).police.wanted.find((w) => w.id === gid)?.level}`);
    ng = await untilKept(G, (x) => x.police.mode === 'guest' && x.police.heli.present && x.police.heli.shown, 20000, wantG, 250);
    const sky = ng ? await sameSky(C, G, 11, wantG, 400) : null;
    if (sky) console.log(`  after the change, look by look: ${sky.each}`);
    check(!!sky && sky.both >= sky.looks - 1 && sky.trail < 12, 'and the guest goes on being shown it, now from the new host, on the same track', sky ? `${sky.both} of ${sky.looks} looks with it on both screens; never more than ${f1(sky.trail)} m off the track the new host flew over the last four looks; ${f1(sky.worst)} m apart at the same look (not judged; it was flying at up to ${f1(sky.speed)} m/s by the wall clock); during the change the guest's sky was without it at ${gaps} of ${glooks} looks${sky.trail < 12 ? '' : '. Each look: ' + sky.each}` : `not shown: ${say((await G.net()).police.heli)}`);
  }

  // ── 10. Nobody wanted: it flies off, and is gone from both skies and from the wire ──
  {
    await G.heat(0);
    let nc = await C.until((x) => x.police.heli.away || !x.police.heli.present, 30000, 250);
    const left = !!nc && nc.police.heli.away;
    ng = await G.until((x) => x.police.heli.present && x.police.heli.shown, 5000);
    check(left, 'nobody is wanted: it turns for home (it does not blink out)', nc ? `host: ${say(nc.police.heli)}; the guest is ${ng ? 'still shown it flying off' : 'no longer shown it'}` : 'still on station after 30 s');
    nc = await C.until((x) => !x.police.heli.present, 400000, 500);
    ng = await G.until((x) => !x.police.heli.present, 15000, 250);
    check(!!nc && !!ng, 'and is gone from both skies', nc && ng ? `host: ${say(nc.police.heli)}; guest: ${say(ng.police.heli)}` : `host: ${say((await C.net()).police.heli)}; guest: ${say((await G.net()).police.heli)}`);
    await sleep(1500);
    const b0 = C.beats.length;
    await sleep(8000);
    const beats = C.beats.slice(b0);
    check(beats.length >= 2 && beats.length <= 6 && beats.every((t) => t === 0), 'the police beat is back to its slow pace with nothing on the end', `8 s: ${beats.length} beats, helicopter tails ${beats.filter((t) => t >= 6 && t <= 8).length}`);
    const errs = [...G.errors, ...C.errors, ...A.errors].filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8842/.test(e));
    check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await leave(G); await leave(C);
  }

  // ── 11. A backup style connection: the helicopter is private, as the police are, and nothing of it is on the wire ──
  {
    const D = await visitor('D', viaBackup, [480, 270], true), E = await visitor('E', viaBackup, [480, 270], true);
    let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
    check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
    const id0 = await D.info();
    await E.go(id0.x + 4, id0.z + 1.5, id0.h);
    await sleep(2000);
    await E.heat(4);
    ne = await untilKept(E, (x) => x.police.heli.present, 30000, [[E, 4]], 250);
    await sleep(4000);
    [nd, ne] = await Promise.all([D.net(), E.net()]);
    check(ne.police.mode === 'local' && ne.police.heli.present && !ne.police.heli.shown && ne.police.heli.after === ne.id, 'on the backup a player at four pips has a private helicopter, as before', `E: police ${ne.police.mode}; ${say(ne.police.heli)}`);
    check(nd.police.mode === 'local' && !nd.police.heli.present, 'and the other player\'s sky is empty', `D: ${say(nd.police.heli)}`);
    const kinds = [...new Set([...Object.keys(D.out.n), ...Object.keys(E.out.n)])];
    check(kinds.includes('1') && kinds.every((k) => k === '0' || k === '1' || k === '3') && D.beats.length + E.beats.length === 0 && ne.police.heliSent === 0 && nd.police.heliGot === 0, 'nothing about it is sent there: only the frames of stage 1', `kinds on the wire: ${kinds.join(', ') || 'none'} (0 keepalive, 1 state, 3 event); police beats ${D.beats.length + E.beats.length}`);
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
