// Multiplayer stage 3, step 1: the same people on the street. Headless browsers against LOCAL services.
//
//   node tools/net/people.mjs              every check, and two pictures into shots/net/
//   node tools/net/people.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/traffic.mjs does (read its header): the Node
// home on 8831 is "main" (found through a lookup stand-in on 8832) and a second copy on 8833 is reached as a plain
// `?net=` address, which the game treats as the BACKUP.
// Checks: host and guest see the same people (numbers, looks, places) on the same street; no more people than one
// game has; what 30 s of it costs; two players far apart both have people round them; a guest drives into a person
// and that person is down on both screens; a guest punches one and shoots one and both screens agree on what became
// of them; a guest fires a gun and the people run on the host's screen too; the host leaves and the people carry on
// under the same numbers; the service goes and everybody has a private crowd; on a backup style connection the
// crowd is private and no frame about people is sent.
// The test makes its own situations: the host stands a person where one is needed (Peds.stand, a test hook), so
// nothing depends on who happens to be walking where. The service moves the host's job between browsers whenever it
// likes (it does, on a machine with no video card), so every part asks who the host is and tries again, a bounded
// number of times and saying why, when the job moved in the middle.
// The pages run in real time. There is no video card here, so frames are slow and the tolerances are generous.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../pw.mjs';

const MAIN = 8831, LOOKUP = 8832, BACKUP = 8833;
const SHOTS = !process.argv.includes('--noshots');
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-people-'));
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
  // Binary frames this page sends, counted on the wire itself: by kind, and for World and ToHost frames by what they carry
  // ('2.3' is a World frame of people; '4.5', '4.6' and '4.7' are a knock, a blow and a bang told to the host).
  t.out = { n: {}, bytes: {} };
  t.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const p = f.payload;
    if (typeof p === 'string' || p.length === 0) return;
    const k = p[0] === 2 || p[0] === 4 ? `${p[0]}.${p[2]}` : String(p[0]);
    t.out.n[k] = (t.out.n[k] ?? 0) + 1; t.out.bytes[k] = (t.out.bytes[k] ?? 0) + p.length;
  }));
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.info = () => t.page.evaluate(() => window.__game.info());
  t.until = async (fn, ms = 45000) => { const end = Date.now() + ms; for (;;) { const n = await t.net(); if (fn(n)) return n; if (Date.now() > end) return null; await sleep(200); } };
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => window.__game.teleport(x, z, h), [x, z, h]);
  /** Host only: somebody stands at (x, z) facing h. Returns their number, 0 when this page is not simulating. */
  t.stand = (x, z, h = 0, secs = 150) => t.page.evaluate(([x, z, h, secs]) => {
    const g = window.__game.game;
    if (g.net.people.mode !== 'host') return 0;
    return g.systems.find((s) => s.peds && s.traffic).peds.stand(x, z, h, secs);
  }, [x, z, h, secs]);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const leave = async (t) => { open.splice(open.indexOf(t), 1); await t.close(); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (list, p, r) => list.filter((c) => dist(c, p) < r);
const both = (A, B) => Promise.all([A.net(), B.net(), A.info(), B.info()]);
/** Who is walking the town's people right now, and who is shown them? Null in the instant of a change. */
async function roles(ts) {
  const ns = await Promise.all(ts.map((t) => t.net()));
  const hi = ns.findIndex((x) => x.people.mode === 'host' && x.traffic.mode === 'host');
  if (hi < 0 || ns.some((x, i) => i !== hi && (x.people.mode !== 'guest' || x.host !== ns[hi].id))) return null;
  return { host: ts[hi], hn: ns[hi], guests: ts.filter((_, i) => i !== hi), gn: ns.filter((_, i) => i !== hi) };
}
async function rolesSoon(ts, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end;) { const r = await roles(ts); if (r) return r; await sleep(300); }
  return null;
}
/** The host's list against a guest's: numbers in common, looks that differ, and how far apart the same person is on the two screens. */
function compare(h, g) {
  const byId = new Map(h.map((c) => [c.id, c]));
  let common = 0, worst = 0, worstStill = 0, wrong = 0, poses = 0;
  for (const c of g) {
    const o = byId.get(c.id);
    if (!o) continue;
    common++;
    if (o.look !== c.look) wrong++;
    if (o.pose !== c.pose) poses++;
    const d = dist(o, c);
    if (o.pose === 'stand' && c.pose === 'stand' || o.pose === 'sit' && c.pose === 'sit') worstStill = Math.max(worstStill, d); else worst = Math.max(worst, d);
  }
  return { common, worst: +worst.toFixed(2), worstStill: +worstStill.toFixed(2), wrong, poses };
}
const who = (n, id) => n.people.people.find((p) => p.id === id);
/**
 * The host stands somebody at (x, z) and the guest waits until it is shown them there. Returns { H, G, id } or a
 * reason (a string) when it could not be set up.
 */
async function stage(ts, x, z, h) {
  const r = await rolesSoon(ts, 20000);
  if (!r) return 'nobody was the host';
  const H = r.host, G = r.guests[0];
  const id = await H.stand(x, z, h);
  if (!id) return 'the host changed before it could stand somebody';
  const ok = await G.until((n) => { const p = n.people.mode === 'guest' && who(n, id); return !!p && p.pose === 'stand' && Math.hypot(p.x - x, p.z - z) < 1; }, 15000);
  if (!ok) return 'the person the host stood was not shown to the guest there';
  return { H, G, id };
}
const walkOut = (t) => t.page.evaluate(() => { const p = window.__game.game.player; if (p.vehicle) p.exit(); });

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');

  // ── 1. Alone on main: a private crowd, nothing sent ──
  const size = SHOTS ? [960, 540] : [480, 270];
  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  await sleep(4000);
  n = await A.net();
  const alone = n.people.people.length, cast = n.people.cast;
  check(n.people.mode === 'local' && n.people.framesSent === 0 && !A.out.n['2.3'] && alone > 0, 'alone on main: its own crowd, and no frame about people sent', `mode ${n.people.mode}, ${alone} people out of a cast of ${cast}, ${A.out.n['2.3'] ?? 0} people frames`);

  // ── 2. B joins: one walks the people, the other is shown them ──
  const B = await visitor('B', viaMain, size);
  n = await B.until((x) => x.status === 'online' && x.count === 2);
  check(!!n && n.home === 'main', 'B is online on main with A', n ? `${n.status} on ${n.home}, ${n.count} in town` : 'timed out');
  const spot = await A.info();
  await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  let r = null;
  for (const end = Date.now() + 60000; Date.now() < end;) { r = await roles([A, B]); if (r && r.gn[0].people.people.length >= 5) break; r = null; await sleep(400); }
  check(!!r, 'one of the two walks the people and the other is shown them', r ? `${r.host.tag} hosts (player ${r.hn.id}); ${r.guests[0].tag} is shown ${r.gn[0].people.people.length} people` : 'no host, or the guest was shown fewer than 5 people in 60 s');
  if (!r) throw new Error('no shared people');
  {
    const [gi, shownNow] = await r.guests[0].page.evaluate(() => {
      const g = window.__game.game, peds = g.systems.find((s) => s.peds && s.traffic).peds;
      return [{ drawn: peds.walkers.filter((w) => w.p.visible).length, walking: peds.walkers.filter((w) => w.active).length, guest: peds.guest }, window.__game.net().people];
    });
    // (The bodies of the guest's own cast: each one drawn is lent to one of the host's people, and none is being walked here.)
    check(gi.guest && gi.walking === 0 && gi.drawn === shownNow.people.length && shownNow.unbodied === 0, 'the guest walks no crowd of its own: everybody it draws is one of the host\'s', `${gi.walking} of its own cast being walked, ${gi.drawn} of its bodies drawn, ${shownNow.people.length} shown people`);
    check(r.hn.people.people.length <= r.hn.people.cast && r.hn.people.people.length <= 60, 'no more people in total than a single player game has', `${r.hn.people.people.length} in town; the host's cast is ${r.hn.people.cast}, and ${alone} were out when A was alone`);
  }

  // The same street, several looks: the same numbers and looks, and each person in the same place.
  await sleep(3000);
  {
    let worst = 0, worstStill = 0, wrong = 0, missing = 0, looks = 0, seen = 0, kinds = new Set();
    for (let k = 0; k < 14; k++) {
      r = await roles([A, B]);
      if (!r) { await sleep(300); continue; }
      const c = compare(r.hn.people.people, r.gn[0].people.people);
      worst = Math.max(worst, c.worst); worstStill = Math.max(worstStill, c.worstStill); wrong += c.wrong;
      missing = Math.max(missing, Math.max(r.hn.people.people.length, r.gn[0].people.people.length) - c.common);
      seen = Math.max(seen, c.common); looks++;
      for (const p of r.gn[0].people.people) kinds.add(p.look);
      await sleep(400);
    }
    check(looks >= 8 && seen >= 5 && missing <= 3, 'host and guest have the same people by number', `${seen} people in common, at most ${missing} on one screen only at any look (${looks} looks)`);
    check(wrong === 0 && kinds.size >= Math.min(5, seen), 'each with the same look on both screens', `${wrong} mismatches; ${kinds.size} different looks among them`);
    // (A walker is drawn a moment behind on the guest, and the two pages are read a moment apart, with slow frames.)
    check(worst < 5 && worstStill < 0.6, 'each person is in the same place on both screens', `people on the move at most ${worst} m apart, people standing ${worstStill} m`);
  }

  // ── Pictures: the same pavement, the same moment, from both players' screens ──
  if (SHOTS) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      r = await rolesSoon([A, B]);
      if (!r) continue;
      // Wherever the most people are walking near the two players; three more are stood there by the host, so the
      // picture has people in it whatever the street is doing.
      const list = near(r.gn[0].people.people, spot, 90).filter((p) => p.pose === 'walk');
      const at = list.sort((p, q) => near(list, q, 14).length - near(list, p, 14).length)[0];
      if (!at) { await sleep(2000); continue; }
      const s = Math.sin(at.h), co = Math.cos(at.h);
      const ids = [];
      for (const k of [-2.4, 0, 2.4]) ids.push(await r.host.stand(at.x + s * k + co * 0.5, at.z + co * k - s * 0.5, at.h + Math.PI / 2));
      if (ids.some((id) => !id)) continue;
      const view = [at.x + co * 9, spot.y + 2.6, at.z - s * 9, at.x, spot.y + 1, at.z];
      for (const t of [A, B]) await t.page.evaluate((v) => window.__game.view(...v), view);
      const ok = await r.guests[0].until((x) => ids.every((id) => who(x, id)?.pose === 'stand'), 15000);
      await sleep(3000);
      const shots = await Promise.all([A.shot('shots/net/people-a.png'), B.shot('shots/net/people-b.png')]);
      const q = await roles([A, B]);
      console.log('shots', shots.join(' '), q ? `(${q.host.tag} was the host; people ${ids.join(', ')} were stood there)` : '', ok ? '' : '(the stood people were not all shown)');
      done = !!ok && !!q;
    }
    for (const t of [A, B]) await t.page.evaluate(() => window.__game.view());
    check(done, 'pictures of the same pavement from both screens', done ? 'shots/net/people-a.png and people-b.png' : 'could not be set up in 3 tries');
  }

  // ── 3. Thirty seconds of an ordinary town: what the people cost ──
  {
    const wire = (what) => (A.out[what]['2.3'] ?? 0) + (B.out[what]['2.3'] ?? 0);
    const w0a = wire('n'), wb0 = wire('bytes'), [a0, b0, ia0, ib0] = await both(A, B), w0b = wire('n');
    await sleep(30000);
    const w1a = wire('n'), [a1, b1, ia1, ib1] = await both(A, B), w1b = wire('n'), wb1 = wire('bytes');
    const d = (f) => f(a1) - f(a0) + f(b1) - f(b0);
    const frames = d((x) => x.people.framesSent), bytes = d((x) => x.people.bytesSent), got = d((x) => x.people.framesGot), recs = d((x) => x.people.recsSent), whole = d((x) => x.people.wholeSent);
    const changes = d((x) => x.people.takeovers);
    const sentM = d((x) => x.sent.msgs), sentB = d((x) => x.sent.bytes);
    const town = Math.max(a1.people.people.length, b1.people.people.length);
    const moving = (a1.people.mode === 'host' ? a1 : b1).people.people.filter((p) => p.pose === 'walk' || p.pose === 'run').length;
    console.log(`  30 s, two players, ${town} people in town (${moving} walking at the end): ${frames} people frames, ${bytes} bytes sent by the host = ${(bytes / 30).toFixed(0)} bytes/s (${(wb1 - wb0)} bytes on the wire), ${(frames / 30).toFixed(1)} frames/s, ${recs} records (${(recs / 30 / Math.max(1, town)).toFixed(2)} a second per person), ${whole} whole frames; the host changed ${changes} time(s)`);
    // Frames are slow here, so the host's game ran well under full speed and its people did less in 30 s than they would
    // on a real machine. Records are sent when somebody changes course, so the fair figure counts them per second of GAME time.
    const hostIsA = a1.people.mode === 'host', gameS = hostIsA ? ia1.time - ia0.time : ib1.time - ib0.time;
    const perS = (recs - whole * town) / Math.max(1, gameS) / Math.max(1, town);
    console.log(`  the host's game ran ${gameS.toFixed(1)} s in those 30 s. Per second of game time: ${perS.toFixed(2)} records a person. At full speed that is about ${Math.round(town * perS * 8 + 10 * 5 + town * 8 / 3)} bytes/s for these ${town} people, and ${Math.round(54 * perS * 8 + 10 * 5 + 54 * 8 / 3)} bytes/s for a full cast of 54 (8 bytes a record, a 5 byte header ten times a second, a whole frame every 3 s)`);
    console.log(`  everything, both players together: ${sentM} messages and ${sentB} bytes sent (${(sentM / 30).toFixed(1)} messages/s, ${(sentB / 30).toFixed(0)} bytes/s)`);
    check(frames > 0 && frames <= 30 * 10 + 5 && w1b - w0a <= 30 * 10 + 5 && frames >= w1a - w0b && frames <= w1b - w0a, 'people frames: ten a second or fewer, and the page\'s count is the wire\'s', `${frames} in 30 s by the host's count; between ${w1a - w0b} and ${w1b - w0a} seen on the wire in that time`);
    check(got >= frames * 0.9, 'and the guest receives them', `${got} of ${frames}`);
    check(bytes / 30 < 4000, 'under 4 kB a second for the town\'s people', `${(bytes / 30).toFixed(0)} bytes/s for ${town} people`);
    check(sentM / 30 < 40, 'both players together stay inside one player\'s rate limit (40 messages a second)', `${(sentM / 30).toFixed(1)} a second`);
  }

  // ── 4. A player far from the host still has people round it ──
  // (Two busy parts of town: the first is where the game starts, the second is found by looking for sidewalks there.)
  const farSpot = await A.page.evaluate(() => {
    const g = window.__game.game, p = g.player;
    let best = null, bd = 0;
    for (const b of g.plan.blocks) {
      if (b.district !== 'downtown' && b.district !== 'midtown' && b.district !== 'oldtown' && b.district !== 'strand') continue;
      const cx = (b.rect.x0 + b.rect.x1) / 2, cz = (b.rect.z0 + b.rect.z1) / 2, d = Math.hypot(cx - p.x, cz - p.z);
      if (d > bd && d < 900 && b.road[0]) { bd = d; best = { x: cx, z: b.rect.z0 - 3 }; }
    }
    return best;
  });
  {
    const hi0 = await A.info();
    await B.go(farSpot.x, farSpot.z, 1.5708);
    let na, nb, ia, ib, roundA = 0, roundB = 0, total = 0, hostTag = '?', apart = 0;
    for (const end = Date.now() + 90000; Date.now() < end;) {
      [na, nb, ia, ib] = await both(A, B);
      apart = dist(ia, ib);
      // Each on their own screen.
      roundA = near(na.people.people, ia, 125).length; roundB = near(nb.people.people, ib, 125).length;
      total = Math.max(na.people.people.length, nb.people.people.length);
      hostTag = na.people.mode === 'host' ? 'A' : nb.people.mode === 'host' ? 'B' : '?';
      if (roundA >= 4 && roundB >= 4 && hostTag !== '?' && (na.people.mode === 'guest' || nb.people.mode === 'guest')) break;
      await sleep(500);
    }
    check(apart > 250 && roundA >= 4 && roundB >= 4, 'two players far apart both have people round them', `${apart.toFixed(0)} m apart, ${roundA} within 125 m of A and ${roundB} of B, each on their own screen; ${hostTag} is the host (A stayed at ${hi0.x.toFixed(0)}, ${hi0.z.toFixed(0)})`);
    check(total <= cast, 'out of the same cast as one player has', `${total} in all (a cast of ${cast})`);
    await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  }

  // A quiet lane to stage things in: the one tools/net/traffic.mjs drives along.
  const LANE = { x: -340, z: 291.8 };
  await A.go(LANE.x - 6, LANE.z + 14, 0);
  await B.go(LANE.x, LANE.z, Math.PI / 2);
  await sleep(1500);

  // ── 5. A guest drives into a person: down on both screens ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const px = LANE.x + 18 + attempt * 9, pz = LANE.z;
      const st = await stage([A, B], px, pz, -Math.PI / 2);
      if (typeof st === 'string') { detail = st; continue; }
      const { H, G, id } = st;
      await G.go(px - 13, pz, Math.PI / 2);
      await G.page.evaluate(() => window.__game.drive('sedan'));
      const g0 = await G.net(), h0 = await H.net();
      await G.page.keyboard.down('KeyW');
      let onG = null, onH = null, guessed = false, top = 0, lost = false, past = 0;
      for (const end = Date.now() + 150000; Date.now() < end;) {
        const [ng, nh, ig] = await Promise.all([G.net(), H.net(), G.info()]);
        if (ng.people.mode !== 'guest' || nh.people.mode !== 'host') { lost = true; break; }
        top = Math.max(top, ig.speed);
        const pg = who(ng, id), ph = who(nh, id);
        if (pg && pg.pose === 'down') { onG = pg; guessed = guessed || pg.guess; }
        if (ph && ph.pose === 'down') onH = ph;
        if (onG && onH) break;
        // (Past the person and still nothing: a few more looks, for the host's word to come back, then give up.)
        if (ig.x > px + 25 && ++past > 12) break;
        await sleep(120);
      }
      await G.page.keyboard.up('KeyW');
      const g1 = await G.net(), h1 = await H.net();
      await walkOut(G);
      if (lost) { detail = 'the host changed in the middle'; continue; }
      if (!onG && !onH && g1.people.knocksSent === g0.people.knocksSent) { detail = `the guest's car missed the person (top speed ${top.toFixed(1)} m/s)`; continue; }
      done = true;
      check(!!onG && !!onH, 'a guest drives into a person: down on both screens', `${G.tag} hit person ${id} at up to ${top.toFixed(1)} m/s; on ${G.tag}'s screen ${onG ? 'down' : 'NOT down'}, on the host ${H.tag}'s ${onH ? `down (health ${onH.health}${onH.hard ? ', not getting up' : ''})` : 'NOT down'}`);
      check(g1.people.knocksSent > g0.people.knocksSent && h1.people.knocksDone > h0.people.knocksDone && (G.out.n['4.5'] ?? 0) >= 1, 'the guest told the host in a small frame, and the host applied it', `${g1.people.knocksSent - g0.people.knocksSent} knock(s) of 8 bytes sent, ${h1.people.knocksDone - h0.people.knocksDone} applied; the guest's screen showed the fall ${guessed ? 'at once, before the host confirmed it' : 'when the host confirmed it'}`);
    }
    if (!done) check(false, 'a guest drives into a person: down on both screens', `6 tries; the last: ${detail}`);
  }

  // ── 6. A guest punches a person, and shoots another: both screens agree on what became of them ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const px = LANE.x - 20 - attempt * 7, pz = LANE.z + 3;
      const st = await stage([A, B], px, pz, -Math.PI / 2);
      if (typeof st === 'string') { detail = st; continue; }
      const { H, G, id } = st;
      await walkOut(G);
      // An arm's length in front of them, facing them, bare hands; the game's own fire input from there on.
      await G.go(px - 1.0, pz, Math.PI / 2);
      await sleep(600);
      const g0 = await G.net(), h0 = await H.net();
      await G.page.evaluate(() => { const g = window.__game.game; g.player.weapons.select(0); g.input.press('fire'); });
      let onG = false, onH = false, hp = 100, lost = false, upG = false, upH = false, guessed = false;
      // (Getting up takes 2.6 s of game time, and the game runs slowly here.)
      for (const end = Date.now() + 150000; Date.now() < end;) {
        const [ng, nh] = await Promise.all([G.net(), H.net()]);
        if (ng.people.mode !== 'guest' || nh.people.mode !== 'host') { lost = true; break; }
        const pg = who(ng, id), ph = who(nh, id);
        if (pg && pg.pose === 'down') { onG = true; guessed = guessed || pg.guess; }
        if (ph && ph.pose === 'down') { onH = true; hp = ph.health; }
        // A punch puts them down for a moment; then they are up and away, on both screens.
        if (onG && pg && pg.pose !== 'down') upG = true;
        if (onH && ph && ph.pose !== 'down') upH = true;
        if (upG && upH) break;
        await sleep(120);
      }
      const g1 = await G.net(), h1 = await H.net();
      if (lost) { detail = 'the host changed in the middle'; continue; }
      if (g1.people.hurtsSent === g0.people.hurtsSent) { detail = 'the punch did not land on the person'; continue; }
      done = true;
      check(onG && onH && upG && upH && hp < 100, 'a guest punches a person: knocked down, then up again, on both screens', `person ${id}: down on ${G.tag}'s screen ${onG}${guessed ? ' (at once)' : ''}, down on the host ${H.tag}'s ${onH} with health ${hp}; up again ${upG} and ${upH}`);
      check(h1.people.hurtsDone > h0.people.hurtsDone, 'the host applied the blow it was told of', `${g1.people.hurtsSent - g0.people.hurtsSent} sent, ${h1.people.hurtsDone - h0.people.hurtsDone} applied`);
    }
    if (!done) check(false, 'a guest punches a person: knocked down, then up again, on both screens', `6 tries; the last: ${detail}`);

    done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const px = LANE.x - 24 - attempt * 7, pz = LANE.z - 4;
      const st = await stage([A, B], px, pz, -Math.PI / 2);
      if (typeof st === 'string') { detail = st; continue; }
      const { H, G, id } = st;
      await walkOut(G);
      await G.go(px - 9, pz, Math.PI / 2);
      await sleep(600);
      // Four pistol rounds into them (26 each), through the game's own "a bullet has hit this person". Aiming the
      // camera from a headless page is not what is being tested.
      const hit = await G.page.evaluate(async ([x, z]) => {
        const g = window.__game.game, me = g.player.person;
        const body = g.people.list.find((p) => p !== me && p.visible && Math.hypot(p.x - x, p.z - z) < 1);
        if (!body) return 0;
        let k = 0;
        for (; k < 4; k++) { g.player.weapons.hurtPerson(body, 26, 1, 0, false); await new Promise((r) => setTimeout(r, 250)); }
        return k;
      }, [px, pz]);
      if (!hit) { detail = 'the person was not on the guest\'s screen to be shot'; continue; }
      let pg = null, ph = null, lost = false;
      for (const end = Date.now() + 30000; Date.now() < end;) {
        const [ng, nh] = await Promise.all([G.net(), H.net()]);
        if (ng.people.mode !== 'guest' || nh.people.mode !== 'host') { lost = true; break; }
        pg = who(ng, id); ph = who(nh, id);
        if (pg && ph && ph.hard && pg.hard && pg.pose === 'down' && ph.pose === 'down' && pg.health === 0 && ph.health === 0) break;
        await sleep(150);
      }
      if (lost) { detail = 'the host changed in the middle'; continue; }
      done = true;
      check(!!pg && !!ph && ph.hard && pg.hard && pg.pose === 'down' && ph.pose === 'down' && ph.health === 0 && pg.health === 0, 'a guest shoots a person four times: down for good, with no health, on both screens', pg && ph ? `person ${id}: on ${G.tag}'s screen ${pg.pose}, health ${pg.health}, staying down ${pg.hard}; on the host ${H.tag}'s ${ph.pose}, health ${ph.health}, staying down ${ph.hard}` : 'the person vanished');
    }
    if (!done) check(false, 'a guest shoots a person four times: down for good, with no health, on both screens', `6 tries; the last: ${detail}`);
  }

  // ── 7. A guest fires a gun: the people round it run, on the host's screen too ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const px = LANE.x + 10 + attempt * 6, pz = LANE.z + 3;
      let r7 = await rolesSoon([A, B], 20000);
      if (!r7) { detail = 'nobody was the host'; continue; }
      const H = r7.host, G = r7.guests[0];
      await walkOut(G);
      await G.go(px, pz, Math.PI / 2);
      const ids = [];
      for (const [dx, dz] of [[9, 0], [-8, 5], [4, -9]]) ids.push(await H.stand(px + dx, pz + dz, 0));
      if (ids.some((id) => !id)) { detail = 'the host changed before it could stand somebody'; continue; }
      const shown = await G.until((x) => x.people.mode === 'guest' && ids.every((id) => who(x, id)?.pose === 'stand'), 15000);
      if (!shown) { detail = 'the people the host stood were not shown to the guest'; continue; }
      const g0 = await G.net(), h0 = await H.net();
      const fired = await G.page.evaluate(async () => {
        const g = window.__game.game, w = g.player.weapons, s0 = w.stats.shotEvents;
        w.give('pistol', 60); w.select(1);
        for (let k = 0; k < 8 && w.stats.shotEvents === s0; k++) { g.input.press('fire'); await new Promise((r) => setTimeout(r, 400)); }
        return w.stats.shotEvents - s0;
      });
      if (!fired) { detail = 'the gun did not fire'; continue; }
      let ranH = 0, ranG = 0, lost = false;
      const sawH = new Set(), sawG = new Set();
      for (const end = Date.now() + 40000; Date.now() < end;) {
        const [ng, nh] = await Promise.all([G.net(), H.net()]);
        if (ng.people.mode !== 'guest' || nh.people.mode !== 'host') { lost = true; break; }
        for (const id of ids) { const ph = who(nh, id), pg = who(ng, id); if (ph && (ph.flee > 0 || ph.pose === 'run')) sawH.add(id); if (pg && pg.pose === 'run') sawG.add(id); }
        ranH = sawH.size; ranG = sawG.size;
        if (ranH === ids.length && ranG === ids.length) break;
        await sleep(120);
      }
      const g1 = await G.net(), h1 = await H.net();
      await G.page.evaluate(() => window.__game.game.player.weapons.select(0));
      if (lost) { detail = 'the host changed in the middle'; continue; }
      done = true;
      check(ranH === ids.length && ranG === ids.length, 'a guest fires a gun: the people near it run, on the host\'s screen and on its own', `${fired} shot(s) by ${G.tag}; of the ${ids.length} people stood within 10 m, ${ranH} ran on the host ${H.tag}'s screen and ${ranG} on ${G.tag}'s`);
      check(g1.people.bangsSent > g0.people.bangsSent && h1.people.bangsDone > h0.people.bangsDone, 'told to the host in a small frame', `${g1.people.bangsSent - g0.people.bangsSent} sent (8 bytes each), ${h1.people.bangsDone - h0.people.bangsDone} applied`);
    }
    if (!done) check(false, 'a guest fires a gun: the people near it run, on the host\'s screen and on its own', `6 tries; the last: ${detail}`);
  }

  // ── 8. The host leaves: another browser carries the same people on, and a third sees them ──
  await A.go(spot.x, spot.z, spot.h); await B.go(spot.x + 4, spot.z + 1.5, spot.h);
  const C = await visitor('C', viaMain, size);
  await C.until((x) => x.status === 'online' && x.count === 3);
  await C.go(spot.x - 4, spot.z + 1.5, spot.h);
  let nc = await C.until((x) => x.people.mode !== 'local' && x.people.people.length >= 5, 60000);
  check(!!nc, 'a third browser joins and is shown the people', nc ? `${nc.people.people.length} people` : 'timed out');
  await sleep(6000);
  r = await rolesSoon([A, B, C], 40000);
  if (!r) throw new Error('three browsers, no host');
  {
    const gone = r.host, goneId = r.hn.id, rest = r.guests, lists = r.gn.map((x) => x.people.people), took = r.gn.map((x) => x.people.adopted);
    await leave(gone);
    let r2 = null;
    for (const end = Date.now() + 30000; Date.now() < end && !r2;) { const q = await roles(rest); if (q && q.hn.host !== goneId && q.hn.count === 2) r2 = q; else await sleep(150); }
    check(!!r2, `the host (${gone.tag}) left: one of the others walks the people now and the other is shown them`, r2 ? `${r2.host.tag} hosts, ${r2.guests[0].tag} is its guest` : 'timed out');
    if (!r2) throw new Error('nobody took over');
    const H = r2.host, G = r2.guests[0], hi = rest.indexOf(H), was = lists[hi];
    const now = r2.hn.people.people;
    const kept = now.filter((c) => was.some((o) => o.id === c.id && o.look === c.look && dist(o, c) < 25)).length;
    const adopted = r2.hn.people.adopted - took[hi];
    check(adopted >= was.length * 0.8 && kept >= was.length * 0.8, 'the new host carries on the people it was showing, where they were, under the same numbers', `${adopted} taken over, ${kept} of ${was.length} still there with the same number and look`);
    await sleep(8000);
    let cmp = { common: 0, wrong: 0, worst: 99, worstStill: 99 }, walking = 0, count = 0;
    for (let k = 0; k < 20; k++) {
      const q = await roles([H, G]);
      if (!q) { await sleep(300); continue; }
      cmp = compare(q.hn.people.people, q.gn[0].people.people);
      walking = q.hn.people.people.filter((c) => c.pose === 'walk' || c.pose === 'run').length; count = q.hn.people.people.length;
      break;
    }
    check(cmp.common >= 5 && cmp.wrong === 0 && cmp.worst < 5 && cmp.worstStill < 0.6, 'and the guest goes on seeing the same people, now from the new host', `${cmp.common} in common, ${cmp.wrong} looks differ, on the move at most ${cmp.worst} m apart, standing ${cmp.worstStill} m`);
    check(walking >= 3 && count >= was.length * 0.6, 'the people are still walking after the change', `${walking} of ${count} walking 8 s later`);

    // ── 9. The service goes away: everybody has a private crowd again ──
    const q9 = await rolesSoon([H, G], 20000);
    if (!q9) throw new Error('two browsers, no host');
    const G9 = q9.guests[0], H9 = q9.host, shownG = q9.gn[0].people.people, took9 = q9.gn[0].people.adopted;
    await stop(home);
    let ng = await G9.until((x) => x.status !== 'online' && x.people.mode === 'local', 20000);
    const nh = await H9.until((x) => x.status !== 'online' && x.people.mode === 'local', 20000);
    await sleep(1000);
    ng = ng && await G9.net();
    const keptG = ng ? ng.people.people.filter((c) => shownG.some((o) => o.id === c.id && o.look === c.look && dist(o, c) < 25)).length : 0;
    check(!!ng && !!nh && ng.people.adopted - took9 >= shownG.length * 0.8 && keptG >= shownG.length * 0.7 && nh.people.people.length > 0, 'service gone: both are single player, and the guest walks the people it was showing as its own', ng ? `${G9.tag} took over ${ng.people.adopted - took9} of ${shownG.length} (${keptG} still where they were); the old host has ${nh ? nh.people.people.length : 0}` : 'timed out');
    const p0 = ng ? ng.people.people : [];
    await sleep(15000);
    ng = await G9.net();
    const movedOn = ng.people.people.filter((c) => { const o = p0.find((k) => k.id === c.id); return o && dist(o, c) > 0.5; }).length;
    check(movedOn >= 3, 'and they are walking', `${movedOn} people moved in 15 s (of slow frames)`);
    const errs = [...H.errors, ...G.errors].filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8832/.test(e));
    check(errs.length === 0, 'no errors from the game on either page', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    await leave(H); await leave(G);
  }

  // ── 10. A backup style connection: a private crowd each, and nothing about people on the wire ──
  {
    const D = await visitor('D', viaBackup), E = await visitor('E', viaBackup);
    let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
    check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
    const id0 = await D.info();
    await E.go(id0.x + 4, id0.z + 1.5, id0.h);
    // A shot on the backup: the shooter's own crowd runs, and nobody is told.
    await sleep(6000);
    await E.page.evaluate(async () => {
      const g = window.__game.game, w = g.player.weapons, s0 = w.stats.shotEvents;
      w.give('pistol', 60); w.select(1);
      for (let k = 0; k < 8 && w.stats.shotEvents === s0; k++) { g.input.press('fire'); await new Promise((r) => setTimeout(r, 400)); }
    });
    await sleep(4000);
    [nd, ne] = await Promise.all([D.net(), E.net()]);
    const ids = (x) => x.people.people.map((p) => `${p.id}:${p.look.length}:${p.x}`).join();
    check(nd.people.mode === 'local' && ne.people.mode === 'local' && nd.people.people.length > 0 && ne.people.people.length > 0 && ids(nd) !== ids(ne), 'on the backup each keeps a private crowd', `D ${nd.people.mode} with ${nd.people.people.length} people, E ${ne.people.mode} with ${ne.people.people.length}`);
    const wire = (t) => Object.keys(t.out.n).filter((k) => k === '2.3' || k === '4.5' || k === '4.6' || k === '4.7' || k.startsWith('2.'));
    const quiet = (x) => x.people.framesSent === 0 && x.people.framesGot === 0 && x.people.knocksSent === 0 && x.people.hurtsSent === 0 && x.people.bangsSent === 0 && x.people.bangsGot === 0;
    check(wire(D).length === 0 && wire(E).length === 0 && quiet(nd) && quiet(ne), 'and nothing about people is sent or received there, a gunshot included', `by each page's own counts, and on the wire (kinds seen there: ${[...new Set([...Object.keys(D.out.n), ...Object.keys(E.out.n)])].join(', ') || 'none'})`);
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
