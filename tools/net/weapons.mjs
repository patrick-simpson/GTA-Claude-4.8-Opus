// Multiplayer stage 3, step 3: weapons between players. Headless browsers against LOCAL services.
//
//   node tools/net/weapons.mjs              every check, and two pictures into shots/net/
//   node tools/net/weapons.mjs --noshots
//
// It starts everything itself and stops it again, exactly as tools/net/people.mjs does (read its header): the Node
// home on 8841 is "main" (found through a lookup stand-in on 8842) and a second copy on 8843 is reached as a plain
// `?net=` address, which the game treats as the BACKUP.
// Checks: alone, a shot sends nothing; with two in town and nobody firing, nothing about weapons is sent; a guest is
// shown the host's shots (the event, the flash and line drawn, the right weapon in the hand) and a rocket and where
// it went off; what two players holding the trigger of the automatic cost in bytes; a player shot by another loses
// health on THEIR OWN browser and the shooter is shown it; a claim from out of reach is refused and one that is too
// big is cut down to what the weapon can do; a punch knocks the other player down; a kill is seen as a death and a
// respawn on both screens; a player is run over by another player's car; a guest's rounds take the health off one
// of the town's cars on the host; a blast set off by a guest hurts a town car once, on the host; a guest's rounds
// kill one of the town's people for everybody; the shooter is wanted for it and nobody else is; on the backup shots
// are seen and players can hurt each other, with nothing sent to any host; no page errors.
// The game's own fire input is used wherever a round has to leave a weapon. Aiming a camera from a headless page is
// not what is being tested: the players are stood facing what they are to hit.
// The service moves the host's job between browsers whenever it likes (it does, on a machine with no video card), so
// every part that needs a host asks who it is and tries again, a bounded number of times and saying why.
// The pages run in real time. There is no video card here, so frames are slow and the tolerances are generous.
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

const tmp = mkdtempSync(path.join(tmpdir(), 'pc-weapons-'));
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
  // Binary frames this page sends, counted on the wire itself, by kind and by what they carry: '3.4' is an Event frame
  // of gunfire, '3.5' a rocket, '3.6' a blast, '3.7' health; '4.9' is bullets on a town car told to the host; '1' a
  // state frame; '2.x' the host's World frames.
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
  t.go = (x, z, h = 0) => t.page.evaluate(([x, z, h]) => { const g = window.__game.game; if (g.player.vehicle) g.player.exit(); window.__game.teleport(x, z, h); }, [x, z, h]);
  /** Host only: somebody stands at (x, z) facing h. Returns their number, 0 when this page is not simulating. */
  t.stand = (x, z, h = 0, secs = 200) => t.page.evaluate(([x, z, h, secs]) => {
    const g = window.__game.game;
    if (g.net.people.mode !== 'host') return 0;
    return g.systems.find((s) => s.peds && s.traffic).peds.stand(x, z, h, secs);
  }, [x, z, h, secs]);
  await t.page.evaluate(() => window.__game.start());
  return t;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
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
const who = (n, id) => n.people.people.find((p) => p.id === id);
const armOf = (n, id) => n.fight.arms.find((a) => a.id === id);
const wire = (t, k) => t.out.n[k] ?? 0, wireB = (t, k) => t.out.bytes[k] ?? 0;
const fightKinds = ['3.4', '3.5', '3.6', '3.7', '4.9'];
const fightWire = (t) => fightKinds.reduce((s, k) => s + wire(t, k), 0);
const fightWireB = (t) => fightKinds.reduce((s, k) => s + wireB(t, k), 0);

/** Every weapon, full, and this one in the hand. */
const arm = (t, slot) => t.page.evaluate((slot) => { const w = window.__game.game.player.weapons; w.giveAll(); for (let i = 1; i < 5; i++) w.mags[i] = [0, 12, 30, 6, 1][i]; w.select(slot); }, slot);
const wstats = (t) => t.page.evaluate(() => ({ ...window.__game.game.player.weapons.stats }));
const hold = (t, what) => t.page.evaluate((a) => window.__game.game.input.press(a), what);
const letGo = (t, what) => t.page.evaluate((a) => window.__game.game.input.held.delete(a), what);
/** No police, no heat, full health: each part starts from quiet. */
const calm = (t) => t.page.evaluate(() => {
  const g = window.__game.game, p = g.systems.find((s) => s.tag === 'police');
  // (The Patrol takes its level from the player's heat whenever somebody else has written it.)
  g.player.heat = 0;
  if (p) p.clear();
  if (g.player.health > 0) g.player.health = 100;
});
/** One pull of the trigger through the game's own input; waits until the weapon says a round has left. Returns whether one did. */
async function pull(t, ms = 24000) {
  const s0 = (await wstats(t)).shots;
  let ok = false;
  for (const end = Date.now() + ms; Date.now() < end && !ok;) {
    // (A pull while the weapon is still coming up, or reloading, is lost: pull again.)
    await hold(t, 'fire');
    for (const soon = Date.now() + 1500; Date.now() < soon;) { if ((await wstats(t)).shots > s0) { ok = true; break; } await sleep(100); }
    await letGo(t, 'fire');
  }
  return ok;
}
/** Stop the page's own clock on the frame after the next round of somebody else's is drawn, photograph it, and let it run again. */
async function snap(t, file) {
  await t.page.evaluate(() => new Promise((res) => {
    const f = window.__game.game.net.fight, d0 = f.stats.shotsDrawn, end = performance.now() + 20000;
    const look = () => {
      if (f.stats.shotsDrawn > d0 || performance.now() > end) { window.__game.freeze(true); window.__game.step(1, 0.012); res(); return; }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }));
  await t.shot(file);
  await t.page.evaluate(() => window.__game.freeze(false));
}
/** A Fire event written by hand: one claim of `damage` on player `target` with weapon `slot`, and no rounds to draw. */
const forge = (t, slot, target, damage, flags = 0) => t.page.evaluate(([slot, target, damage, flags]) => {
  window.__game.game.net.conn.send(new Uint8Array([3, 0, 4, (slot & 7) | (1 << 6), target, damage, 64, flags]).buffer);
}, [slot, target, damage, flags]);

let home = startHome(MAIN, 'main');
const backup = startHome(BACKUP, 'backup');
try {
  if (!(await up(MAIN)) || !(await up(BACKUP))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];
  // A quiet street to stage things in (the one tools/net/people.mjs and police.mjs use).
  const LANE = { x: -340, z: 291.8 };
  const SPOT = { x: LANE.x - 20, z: LANE.z + 3 };

  // ── 1. Alone on main: a shot is nobody's business ──
  const A = await visitor('A', viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  await A.go(SPOT.x, SPOT.z, Math.PI / 2);
  await arm(A, 1);
  const fired1 = await pull(A);
  await sleep(1500);
  n = await A.net();
  check(fired1 && fightWire(A) === 0 && n.fight.bytesSent === 0 && !n.fight.on, 'alone on main: the pistol fires and nothing about it is sent', `fired ${fired1}; ${fightWire(A)} weapon frames on the wire, ${n.fight.bytesSent} bytes by the page's own count`);

  // ── 2. B joins. Nobody fires: nothing about weapons on the wire ──
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
  {
    const a0 = fightWire(A), b0 = fightWire(B), na0 = await A.net(), nb0 = await B.net();
    await sleep(12000);
    const na = await A.net(), nb = await B.net();
    const extra = (fightWire(A) - a0) + (fightWire(B) - b0), bytes = (na.fight.bytesSent - na0.fight.bytesSent) + (nb.fight.bytesSent - nb0.fight.bytesSent);
    check(extra === 0 && bytes === 0 && na.fight.on && nb.fight.on, 'two in town, nobody firing for 12 s: nothing about weapons is sent', `${extra} weapon frames on the wire, ${bytes} bytes by the pages' own counts (state frames in that time: ${na.sent.states - na0.sent.states} and ${nb.sent.states - nb0.sent.states})`);
  }

  // ── 3. The host fires; the guest is shown it: the event, the flash and line, the weapon in the hand ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0], hid = r.hn.id;
      await H.go(SPOT.x, SPOT.z, Math.PI / 2);
      await G.go(SPOT.x + 4, LANE.z - 4, Math.PI / 2);
      await arm(H, 2);
      await sleep(1500);
      const g0 = await G.net(), h0 = await H.net(), w0 = wire(H, '3.4'), wb0 = wireB(H, '3.4'), s0 = (await wstats(H)).shots;
      // The automatic, trigger held: a burst.
      await hold(H, 'fire');
      let gun = 0, armUp = 0, heldSeen = 0, drawn = 0;
      for (const end = Date.now() + 25000; Date.now() < end;) {
        const ng = await G.net(), a = armOf(ng, hid);
        if (a) { gun = Math.max(gun, a.gun === 2 ? 2 : 0); armUp = Math.max(armUp, a.arm); heldSeen = Math.max(heldSeen, a.held); }
        drawn = ng.fight.shotsDrawn - g0.fight.shotsDrawn;
        if (drawn >= 4 && gun === 2) break;
        await sleep(150);
      }
      if (SHOTS) {
        // The guest's camera on the host while the trigger is still held: the weapon up, the flash, the line.
        const hi = await H.info();
        await G.page.evaluate(([x, y, z]) => window.__game.view(x - 2.5, y + 1.9, z - 5.5, x + 6, y + 1.3, z), [hi.x, hi.y, hi.z]);
        await snap(G, 'shots/net/weapons-guest.png');
        await G.page.evaluate(() => window.__game.view());
      }
      await letGo(H, 'fire');
      await sleep(1200);
      const ng = await G.net(), nh = await H.net(), shots = (await wstats(H)).shots - s0;
      if ((await roles([A, B]))?.host !== H) { detail = 'the host changed in the middle'; continue; }
      if (shots === 0) { detail = 'the weapon did not fire'; continue; }
      done = true;
      const fires = nh.fight.firesSent - h0.fight.firesSent, sent = nh.fight.shotsSent - h0.fight.shotsSent;
      check(ng.fight.firesGot - g0.fight.firesGot >= 1 && drawn >= 1, 'the host fires the automatic: the guest gets the events and draws a flash and a line for each round', `${shots} rounds left the host's weapon in ${fires} events (${sent} rounds in them, ${wireB(H, '3.4') - wb0} bytes on the wire in ${wire(H, '3.4') - w0} frames); the guest heard ${ng.fight.firesGot - g0.fight.firesGot} events and drew ${ng.fight.shotsDrawn - g0.fight.shotsDrawn} rounds`);
      check(gun === 2 && armUp > 0.5 && heldSeen === 2, 'and is shown the right weapon in the host\'s hand, arm raised', `model ${gun} (2 = the automatic), arm ${armUp.toFixed(2)} up, the state frames said weapon ${heldSeen}`);
      check(fires <= shots && fires >= 1 && nh.fight.bytesSent - h0.fight.bytesSent === wireB(H, '3.4') - wb0, 'rounds are gathered into events, not one frame a round at worst, and the page\'s byte count is the wire\'s', `${shots} rounds, ${fires} events`);
    }
    if (!done) check(false, 'the host fires the automatic: the guest gets the events and draws a flash and a line for each round', `4 tries; the last: ${detail}`);
  }

  // ── 4. What it costs: both hold the trigger of the automatic for 15 s ──
  {
    await A.go(SPOT.x, SPOT.z, Math.PI / 2);
    await B.go(SPOT.x + 4, LANE.z - 4, Math.PI / 2);
    for (const t of [A, B]) { await calm(t); await arm(t, 2); await t.page.evaluate(() => { const w = window.__game.game.player.weapons; w.mags[2] = 30; w.spare[2] = 240; }); }
    await sleep(800);
    const b0 = [fightWireB(A), fightWireB(B)], f0 = [fightWire(A), fightWire(B)], s0 = [(await wstats(A)).shots, (await wstats(B)).shots];
    const st0 = [wireB(A, '1'), wireB(B, '1')];
    const t0 = Date.now();
    await hold(A, 'fire'); await hold(B, 'fire');
    await sleep(15000);
    await letGo(A, 'fire'); await letGo(B, 'fire');
    const secs = (Date.now() - t0) / 1000;
    await sleep(600);
    const s1 = [(await wstats(A)).shots, (await wstats(B)).shots];
    const per = [A, B].map((t, i) => ({ rounds: s1[i] - s0[i], frames: fightWire(t) - f0[i], bytes: fightWireB(t) - b0[i], state: wireB(t, '1') - st0[i] }));
    const worst = Math.max(per[0].bytes, per[1].bytes) / secs, frames = Math.max(per[0].frames, per[1].frames) / secs;
    // Ten events a second at most, each 4 bytes and 7 a round: twelve rounds a second is 124 bytes a second at full speed.
    check(per[0].rounds > 5 && per[1].rounds > 5 && frames <= 10.5 && worst <= 140, 'two players hold the trigger of the automatic: at most ten small events a second each', per.map((p, i) => `${'AB'[i]}: ${p.rounds} rounds in ${secs.toFixed(1)} s, ${p.frames} frames, ${p.bytes} bytes = ${(p.bytes / secs).toFixed(0)} bytes/s (its state frames in that time: ${(p.state / secs).toFixed(0)} bytes/s)`).join('; '));
    console.log(`INFO  gunfire bytes: ${per.map((p, i) => `${'AB'[i]} ${(p.bytes / secs).toFixed(1)} B/s over ${p.rounds} rounds (${(p.bytes / Math.max(1, p.rounds)).toFixed(1)} bytes a round)`).join(', ')}. The game runs slowly here, so rounds a second are fewer than on a real machine: at the full 12 rounds a second it is 10 events x (4 + 1.2 x 7) = 124 bytes/s a player.`);
    for (const t of [A, B]) await t.page.evaluate(() => { const g = window.__game.game; g.input.held.delete('fire'); });
  }

  // ── 5. One player shoots another: the VICTIM's browser takes the health off, and the shooter is shown it ──
  // P stands 8 m from Q, facing them. Either may be the host: this is between the two browsers.
  const P = A, Q = B;
  const pid = (await P.net()).id, qid = (await Q.net()).id;
  const faceOff = async (gap = 8) => {
    for (const t of [P, Q]) await calm(t);
    await Q.go(SPOT.x + gap, SPOT.z, -Math.PI / 2);
    await P.go(SPOT.x, SPOT.z, Math.PI / 2);
    // (Until each is shown the other standing where they now are.)
    await P.until((x) => x.remotes[0] && Math.hypot(x.remotes[0].x - (SPOT.x + gap), x.remotes[0].z - SPOT.z) < 0.6, 15000);
    await Q.until((x) => x.remotes[0] && Math.hypot(x.remotes[0].x - SPOT.x, x.remotes[0].z - SPOT.z) < 0.6, 15000);
  };
  {
    await faceOff();
    await arm(P, 1);
    const q0 = await Q.net(), p0 = await P.net(), hq0 = (await Q.info()).health;
    let rounds = 0, hq = hq0;
    for (let k = 0; k < 12 && hq >= hq0; k++) { if (await pull(P)) rounds++; await sleep(700); hq = (await Q.info()).health; }
    const nq = await Q.net();
    const np = await P.until((x) => { const a = armOf(x, qid); return !!a && a.health < 100; }, 8000) ?? await P.net();
    const seenHp = armOf(np, qid)?.health;
    check(hq < hq0 && nq.fight.claimsDone > q0.fight.claimsDone, 'a player shot by another loses health on their own browser', `${rounds} pistol rounds from ${P.tag}; ${Q.tag}'s own health ${hq0} -> ${hq}, ${nq.fight.claimsDone - q0.fight.claimsDone} claim(s) applied, ${nq.fight.claimsRefused - q0.fight.claimsRefused} refused, ${nq.fight.damageTaken - q0.fight.damageTaken} taken`);
    check(seenHp !== undefined && Math.abs(seenHp - hq) <= 0.5 + 26 && seenHp < 100 && np.fight.claimsSent > p0.fight.claimsSent, 'and the shooter is shown the health they have left', `${P.tag} is shown ${Q.tag} at ${seenHp}; ${np.fight.claimsSent - p0.fight.claimsSent} claim(s) sent, ${nq.fight.vitalsSent - q0.fight.vitalsSent} health event(s) of 5 bytes back`);
    const ip = await P.info();
    check(ip.health === 100, 'the shooter\'s own health is untouched', `${P.tag}: ${ip.health}`);
  }

  // ── 6. The limits: a claim that is too big is cut down to what the weapon does; one from out of reach is refused ──
  {
    const full = () => Q.page.evaluate(() => { const p = window.__game.game.player; if (p.health > 0) p.health = 100; });
    await faceOff();
    await full();
    await sleep(3000);
    let q0 = await Q.net(), h0 = (await Q.info()).health;
    // A pistol round that says it did 255. A pistol does 26 a round, five and a half rounds a second: a claim may carry
    // a quarter of a second of that and a quarter over (two frames of it can arrive together), which is 56.
    await forge(P, 1, qid, 255);
    let nq = await Q.until((x) => x.fight.claimsGot > q0.fight.claimsGot, 8000) ?? await Q.net();
    let h1 = (await Q.info()).health;
    check(nq.fight.claimsDone === q0.fight.claimsDone + 1 && h0 - h1 > 0 && h0 - h1 <= 56.5, 'a claim of 255 from a pistol is cut down to what a pistol can do', `health ${h0} -> ${h1.toFixed(1)} (the most at a stroke is 56)`);
    // Twenty fists at once, each saying 255, from an arm's length. A fist does 24, and 140 a minute: whatever the
    // twenty claims say, they take no more than a fist could in the time they took to arrive (30 at a stroke, then
    // 70 a second). Padding takes the blows, so nobody dies of the test. (Arrival is what the victim can time, and
    // frames are slow here, so the time allowed is from the sending to the last one heard.)
    await faceOff(1.5);
    await Q.page.evaluate(() => { const p = window.__game.game.player; p.health = 100; p.armor = 250; });
    await sleep(2500);
    q0 = await Q.net();
    const t0 = Date.now();
    await P.page.evaluate((target) => { const c = window.__game.game.net.conn; for (let k = 0; k < 20; k++) c.send(new Uint8Array([3, 0, 4, 1 << 6, target, 255, 64, 1]).buffer); }, qid);
    nq = await Q.until((x) => x.fight.claimsGot >= q0.fight.claimsGot + 20, 10000) ?? await Q.net();
    const span = (Date.now() - t0) / 1000, taken = nq.fight.damageTaken - q0.fight.damageTaken, refused = nq.fight.claimsRefused - q0.fight.claimsRefused;
    check(nq.fight.claimsGot - q0.fight.claimsGot === 20 && taken > 0 && taken <= 30 + 70 * span + 1 && refused >= 8, 'twenty claims of 255 at once from a fist take no more than a fist could in that time', `${taken.toFixed(1)} taken of the 5100 claimed, in ${span.toFixed(2)} s (a fist: 30, then 70 a second = ${(30 + 70 * span).toFixed(0)}); ${refused} of 20 refused (${nq.fight.lastRefusal})`);
    await Q.page.evaluate(() => { const p = window.__game.game.player; p.armor = 0; });
    await faceOff();
    await sleep(1500);
    // A rocket launcher has no rounds that find people.
    await full();
    q0 = await Q.net(); h0 = (await Q.info()).health;
    await forge(P, 4, qid, 150);
    nq = await Q.until((x) => x.fight.claimsGot > q0.fight.claimsGot, 8000) ?? await Q.net();
    check(nq.fight.claimsRefused === q0.fight.claimsRefused + 1 && (await Q.info()).health === h0, 'a claim with a weapon that cannot make one is refused', nq.fight.lastRefusal);
    // From further than the weapon reaches: a fist from 8 m, and a pistol from 300 m.
    q0 = nq;
    await forge(P, 0, qid, 24, 1);
    nq = await Q.until((x) => x.fight.claimsGot > q0.fight.claimsGot, 8000) ?? await Q.net();
    const why1 = nq.fight.lastRefusal, fistRefused = nq.fight.claimsRefused === q0.fight.claimsRefused + 1 && /out of reach/.test(why1);
    await P.go(SPOT.x - 300, SPOT.z, Math.PI / 2);
    await Q.until((x) => x.remotes[0] && Math.abs(x.remotes[0].x - (SPOT.x - 300)) < 2, 15000);
    q0 = await Q.net();
    await forge(P, 1, qid, 26);
    nq = await Q.until((x) => x.fight.claimsGot > q0.fight.claimsGot, 8000) ?? await Q.net();
    check(fistRefused && nq.fight.claimsRefused === q0.fight.claimsRefused + 1 && /out of reach/.test(nq.fight.lastRefusal) && (await Q.info()).health === h0, 'claims from further than the weapon reaches are refused: a fist from 8 m, a pistol from 300 m', `${why1}; ${nq.fight.lastRefusal}`);
  }

  // ── 7. A punch: the other player is knocked down, on their own browser, and the puncher sees them down ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      await faceOff(1.0);
      await Q.page.evaluate(() => { window.__game.game.player.health = 100; });
      await P.page.evaluate(() => window.__game.game.player.weapons.select(0));
      await sleep(800);
      const q0 = await Q.net(), p0 = await P.net();
      await hold(P, 'fire'); await sleep(300); await letGo(P, 'fire');
      let downQ = false, downP = false, hq = 100;
      for (const end = Date.now() + 20000; Date.now() < end;) {
        const [np, pose, h] = await Promise.all([P.net(), Q.page.evaluate(() => window.__game.game.player.person.pose), Q.info()]);
        hq = Math.min(hq, h.health);
        if (pose === 'down') downQ = true;
        if (np.remotes[0] && np.remotes[0].pose === 'down') downP = true;
        if (downQ && downP) break;
        await sleep(120);
      }
      const nq = await Q.net(), np = await P.net();
      if (np.fight.claimsSent === p0.fight.claimsSent) { detail = 'the punch did not land'; continue; }
      done = true;
      check(downQ && hq < 100 && hq >= 70 && nq.fight.swingsSeen > q0.fight.swingsSeen, 'a punch from another player: knocked down and hurt on their own browser, and the swing was seen', `${Q.tag}: down ${downQ}, health ${hq}, ${nq.fight.swingsSeen - q0.fight.swingsSeen} swing(s) seen`);
      check(downP, 'and the puncher sees them on the ground', `${P.tag} shows ${Q.tag} ${downP ? 'down' : 'standing'}`);
    }
    if (!done) check(false, 'a punch from another player: knocked down and hurt on their own browser, and the swing was seen', `4 tries; the last: ${detail}`);
  }

  // ── 8. A kill: the death and the respawn are seen on both screens ──
  {
    await sleep(2500);
    await faceOff();
    await Q.page.evaluate(() => { window.__game.game.player.health = 100; });
    await arm(P, 1);
    const p0 = await P.net(), q0 = await Q.net();
    let rounds = 0, hq = 100;
    for (let k = 0; k < 30 && hq > 0; k++) { if (await pull(P)) rounds++; await sleep(500); hq = (await Q.info()).health; if (k % 6 === 5) await arm(P, 1); }
    // Dead on Q's own browser; P is told, shows them lying there, and is given the kill.
    let np = await P.until((x) => { const a = armOf(x, qid); return !!a && a.dead && x.remotes[0].pose === 'down'; }, 15000);
    const nq1 = await Q.net();
    check(hq <= 0 && nq1.fight.deaths === q0.fight.deaths + 1, 'shot until dead: the victim dies on their own browser', `${rounds} rounds; ${Q.tag}'s health ${hq}, deaths ${nq1.fight.deaths - q0.fight.deaths}`);
    check(!!np && np.fight.kills === p0.fight.kills + 1 && armOf(np, qid).killedBy === pid, 'the shooter sees them lying dead and is given the kill', np ? `${P.tag} shows ${Q.tag} ${np.remotes[0].pose}, dead ${armOf(np, qid).dead}, killed by player ${armOf(np, qid).killedBy}; kills ${np.fight.kills - p0.fight.kills}` : 'not seen in 15 s');
    // Back at Mercy General, on both screens.
    const iq = await (async () => { for (const end = Date.now() + 90000; Date.now() < end;) { const i = await Q.info(); if (i.health === 100) return i; await sleep(300); } return await Q.info(); })();
    np = await P.until((x) => { const a = armOf(x, qid); return !!a && !a.dead && a.respawns >= 1 && x.remotes[0].pose !== 'down' && Math.hypot(x.remotes[0].x - iq.x, x.remotes[0].z - iq.z) < 3; }, 20000);
    const moved = Math.hypot(iq.x - (SPOT.x + 8), iq.z - SPOT.z);
    check(iq.health === 100 && moved > 20, 'the victim is back on their feet at Mercy General with full health', `health ${iq.health}, ${moved.toFixed(0)} m from where they fell`);
    check(!!np, 'and the shooter sees them there, alive', np ? `${P.tag} shows ${Q.tag} ${np.remotes[0].pose} at ${np.remotes[0].x.toFixed(0)}, ${np.remotes[0].z.toFixed(0)}; health ${armOf(np, qid).health}` : `not seen in 20 s (${JSON.stringify(armOf(await P.net(), qid))})`);
  }

  // ── 9. Run over by another player's car: the victim's own browser knocks them down ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      for (const t of [P, Q]) await calm(t);
      // A lane of its own each try: the car of a try that failed is left standing, and the next must not start inside it.
      const z = SPOT.z + attempt * 4.5, qx = SPOT.x + 12;
      await Q.go(qx, z, -Math.PI / 2);
      await Q.page.evaluate(() => { window.__game.game.player.health = 100; });
      await P.go(SPOT.x, z, Math.PI / 2);
      await P.page.evaluate(() => window.__game.drive('sedan'));
      // (Until the victim is shown the car, standing where it starts.)
      await Q.until((x) => x.remotes[0] && x.remotes[0].vehicle === 'sedan' && Math.abs(x.remotes[0].x - SPOT.x) < 1.5, 15000);
      const f0 = fightWire(P), q0 = await Q.net(), p0 = await P.info(), t0 = Date.now();
      // Driven at Q at a steady 9 m/s (the speed is set outright: a pedal takes too long to bite at these frame rates).
      await P.page.evaluate(() => { const g = window.__game.game; window.__push = setInterval(() => { const v = g.player.vehicle; if (v) { v.vx = Math.sin(v.h) * 9; v.vz = Math.cos(v.h) * 9; } }, 40); });
      // The game's clock runs slower than the wall's here (a frame is at most a twentieth of a second of game, however
      // long it took to draw), by a different amount every run: the wait ends when the car has gone past where they
      // stood, not after a number of seconds. (It used to end after 25 s, which a slow host did not always make.)
      let down = false, hq = 100, px = SPOT.x, seen = 0;
      for (const end = Date.now() + 120000; Date.now() < end;) {
        const [pose, h, pi, nq] = await Promise.all([Q.page.evaluate(() => window.__game.game.player.person.pose), Q.info(), P.info(), Q.net()]);
        hq = Math.min(hq, h.health); px = pi.x;
        if (nq.remotes[0]) seen = Math.max(seen, nq.remotes[0].speed);
        if (pose === 'down') down = true;
        if ((down && hq < 100) || px > qx + 10 || pi.vehicle === null) break;
        await sleep(100);
      }
      await P.page.evaluate(() => { clearInterval(window.__push); const v = window.__game.game.player.vehicle; if (v) { v.vx = 0; v.vz = 0; } });
      const nq = await Q.net(), p1 = await P.info(), wall = (Date.now() - t0) / 1000;
      if (!down) {
        detail = `the car ${px > qx ? 'passed' : 'did not reach'} them (health ${hq}): it went from x ${SPOT.x.toFixed(1)} to ${px.toFixed(1)}, they stood at ${qx.toFixed(1)}; ${wall.toFixed(0)} s on the wall was ${(p1.time - p0.time).toFixed(1)} s of the driver's game; fastest the victim was shown it: ${seen.toFixed(1)} m/s; the victim is now at ${JSON.stringify(await Q.page.evaluate(() => { const p = window.__game.game.player; return [+p.x.toFixed(1), +p.z.toFixed(1), p.person.pose]; }))}`;
        await P.go(SPOT.x, SPOT.z + 30, Math.PI / 2);
        continue;
      }
      done = true;
      check(down && hq < 100, 'run over by another player\'s car: knocked down and hurt on their own browser', `${Q.tag}: down ${down}, health ${hq} (try ${attempt + 1}; ${wall.toFixed(0)} s on the wall, ${(p1.time - p0.time).toFixed(1)} s of the driver's game)`);
      check(fightWire(P) === f0 && nq.fight.claimsGot === q0.fight.claimsGot, 'and it took no message: the car is solid and moving on the victim\'s screen', `${fightWire(P) - f0} weapon frames from the driver, ${nq.fight.claimsGot - q0.fight.claimsGot} claims`);
    }
    if (!done) check(false, 'run over by another player\'s car: knocked down and hurt on their own browser', `4 tries; the last: ${detail}`);
    await P.go(SPOT.x, SPOT.z, Math.PI / 2);
    // (The car P got out of is handed to the town; it is in nobody's way where it stopped.)
  }

  // ── 10. A rocket: the other player sees it fly, and it goes off at the same place on both screens ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      for (const t of [P, Q]) await calm(t);
      // P fires down the street away from Q, who watches from 12 m to the side.
      await P.go(SPOT.x - 40, SPOT.z, -Math.PI / 2);
      await Q.go(SPOT.x - 36, LANE.z - 5, -Math.PI / 2);
      await Q.page.evaluate(() => { window.__game.game.player.health = 100; });
      await arm(P, 4);
      await sleep(1500);
      const q0 = await Q.net(), p0 = await P.net(), wq0 = (await wstats(Q)).blasts;
      if (!(await pull(P))) { detail = 'the launcher did not fire'; continue; }
      let flying = false;
      let nq = null;
      for (const end = Date.now() + 60000; Date.now() < end;) {
        nq = await Q.net();
        if (nq.fight.rockets.some((k) => k.from === pid)) flying = true;
        if (nq.fight.blastsDone > q0.fight.blastsDone) break;
        await sleep(60);
      }
      const np = await P.net(), wq = (await wstats(Q)).blasts;
      const a = np.fight.lastBlast, b = nq.fight.lastBlast, apart = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (np.fight.blastsSent === p0.fight.blastsSent) { detail = 'the rocket never went off'; continue; }
      done = true;
      check(nq.fight.rocketsGot === q0.fight.rocketsGot + 1 && flying, 'a rocket from another player is seen in flight', `${nq.fight.rocketsGot - q0.fight.rocketsGot} launch heard (16 bytes), a rocket of player ${pid}'s in the air on ${Q.tag}'s screen: ${flying}`);
      check(nq.fight.blastsDone === q0.fight.blastsDone + 1 && wq === wq0 + 1 && b.from === pid && apart < 0.1 && nq.fight.rockets.length === 0, 'and it goes off once, at the same place on both screens', `${P.tag}: ${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)}; ${Q.tag}: ${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)} (${apart.toFixed(3)} m apart); blasts drawn on ${Q.tag}: ${wq - wq0}`);
    }
    if (!done) check(false, 'a rocket from another player is seen in flight', `3 tries; the last: ${detail}`);
  }

  // ── 11. The town's cars: a guest's rounds take the health off one on the host; a guest's blast hurts one ONCE ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0];
      for (const t of [H, G]) await calm(t);
      await H.go(SPOT.x, SPOT.z + 40, 0);
      // One of the town's parked cars that nobody has touched, as the guest is shown it: stand beside it, facing it.
      const car = await G.page.evaluate(([x, z]) => {
        const g = window.__game.game, spots = g.parkSpots;
        let best = null, bd = 1e9;
        for (let i = 0; i < spots.length; i++) {
          const s = spots[i], v = s.v;
          if (!v || !v.shared || v.health < 100 || g.net.cars.placeOf(v) !== i) continue;
          const d = Math.hypot(s.x - x, s.z - z);
          if (d > 30 && d < bd) { bd = d; best = { place: i, x: v.x, z: v.z, h: v.h, hw: v.hw }; }
        }
        return best;
      }, [SPOT.x, SPOT.z]);
      if (!car) { detail = 'no untouched parked car of the town\'s on the guest\'s screen'; await sleep(2000); continue; }
      // Is it there on the host too, whole?
      const same = await H.page.evaluate((c) => { const g = window.__game.game, v = g.net.cars.parkedAt(c.place); return !!v && Math.hypot(v.x - c.x, v.z - c.z) < 0.3 && v.health === 100; }, car);
      if (!same) { detail = 'the host does not have that car parked there'; continue; }
      // Which side is open? Try the side the kerb is not on: both, and take the one the round reaches the car from.
      const side = attempt % 2 ? 1 : -1, rx = -Math.cos(car.h) * side, rz = Math.sin(car.h) * side;
      // (Close: at 7 m the car across the street was the one struck.)
      const gx = car.x + rx * 3.2, gz = car.z + rz * 3.2;
      await G.go(gx, gz, Math.atan2(-rx, -rz));
      await arm(G, 2);
      await G.page.evaluate(() => { const w = window.__game.game.player.weapons; w.mags[2] = 30; });
      await sleep(1200);
      const h0 = await H.net(), g0 = await G.net(), c0 = (await wstats(G)).car;
      await hold(G, 'fire'); await sleep(5000); await letGo(G, 'fire');
      await sleep(1500);
      const hitCar = (await wstats(G)).car - c0;
      if (hitCar === 0) { detail = 'the guest\'s rounds did not reach the car from that side'; continue; }
      const nh = await H.until((x) => x.fight.carShotsDone > h0.fight.carShotsDone, 8000) ?? await H.net();
      // On the host: the real car, by where it stands (dented, it is one of the standing cars now, with a number).
      const hc = await H.page.evaluate((c) => { const g = window.__game.game; let best = null, bd = 3; for (const v of g.vehicles.list) { const d = Math.hypot(v.x - c.x, v.z - c.z); if (d < bd) { bd = d; best = { health: v.health, x: v.x, z: v.z, wreck: !!v.wreck }; } } return best; }, car);
      const ng = await G.net();
      if ((await roles([A, B]))?.host !== H) { detail = 'the host changed in the middle'; continue; }
      done = true;
      check(!!hc && hc.health < 100 && nh.fight.carShotsDone > h0.fight.carShotsDone, 'a guest shoots one of the town\'s parked cars: the host takes the health off the real car', hc ? `${hitCar} rounds struck it on ${G.tag}'s screen; ${ng.fight.carShotsSent - g0.fight.carShotsSent} report(s) of 7 bytes; the host applied ${nh.fight.carShotsDone - h0.fight.carShotsDone}; its health there is ${hc.health.toFixed(1)}` : 'the host has no car there any more');
      const shown = await G.until((x) => x.traffic.cars.some((k) => Math.hypot(k.x - car.x, k.z - car.z) < 3 && k.health < 100), 15000);
      check(!!shown, 'and the guest is shown it dented, as one of the host\'s standing cars', shown ? `health ${shown.traffic.cars.find((k) => Math.hypot(k.x - car.x, k.z - car.z) < 3).health} on ${G.tag}'s screen (in steps of 5)` : 'not in 15 s');

      // A blast, set off on the guest's browser 5.5 m from the car's side (the same entry a rocket landing there uses).
      if (!hc || hc.wreck) continue;
      await G.go(gx + rx * 25, gz + rz * 25, Math.atan2(-rx, -rz));
      await sleep(1500);
      const before = await H.page.evaluate((c) => { const g = window.__game.game; for (const v of g.vehicles.list) if (Math.hypot(v.x - c.x, v.z - c.z) < 3) return { health: v.health, x: v.x, z: v.z, hw: v.hw, id: v.id }; return null; }, car);
      if (!before) continue;
      const bx = before.x + rx * 5.5, bz = before.z + rz * 5.5;
      const wh0 = (await wstats(H)).blasts, wg0 = (await wstats(G)).blasts, hb0 = (await H.net()).fight.blastsDone;
      await G.page.evaluate(([x, z]) => { const g = window.__game.game; g.player.weapons.explode(x, 0.9 + g.player.y, z, 9, 150, true); }, [bx, bz]);
      await H.until((x) => x.fight.blastsDone > hb0, 10000);
      await sleep(2500);
      const after = await H.page.evaluate((id) => { const v = window.__game.game.vehicles.list.find((k) => k.id === id); return v ? { health: v.health, x: v.x, z: v.z } : null; }, before.id);
      const wh = (await wstats(H)).blasts - wh0, wg = (await wstats(G)).blasts - wg0;
      // What one blast of 150 does to a car whose side is that far off: 150 x (1 - d / 9) x 0.9.
      const d = Math.max(0, 5.5 - before.hw), want = 150 * (1 - d / 9) * 0.9;
      const took = after ? before.health - after.health : -1, shoved = after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
      check(wh === 1 && wg === 1 && !!after && Math.abs(took - Math.min(want, before.health)) < 1.5, 'a blast set off by a guest hurts a town car ONCE, on the host', after ? `drawn once on each screen (${wg} and ${wh}); the car's health on the host ${before.health.toFixed(1)} -> ${after.health.toFixed(1)}: ${took.toFixed(1)} off, and one blast from there takes ${Math.min(want, before.health).toFixed(1)} (twice would be ${Math.min(2 * want, before.health).toFixed(1)})` : 'the car is gone from the host');
      check(shoved > 0.05, 'and shoves it, on the host', `${shoved.toFixed(2)} m`);
    }
    if (!done) check(false, 'a guest shoots one of the town\'s parked cars: the host takes the health off the real car', `5 tries; the last: ${detail}`);
  }

  // ── 12. The town's people: a guest's rounds kill one for everybody; the SHOOTER is wanted, nobody else ──
  {
    let done = false, detail = '';
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      r = await rolesSoon([A, B], 30000);
      if (!r) { detail = 'nobody was the host'; continue; }
      const H = r.host, G = r.guests[0], gid = r.gn[0].id;
      for (const t of [H, G]) await calm(t);
      await H.go(LANE.x + 10, LANE.z + 16, 0);
      const px = SPOT.x - 6 - attempt * 6, pz = SPOT.z;
      // The one to be shot, and a bystander to see it done.
      const id = await H.stand(px, pz, -Math.PI / 2);
      await H.stand(px - 3, pz + 5, -Math.PI / 2);
      if (!id) { detail = 'the host changed before it could stand somebody'; continue; }
      const ok = await G.until((x) => { const p = x.people.mode === 'guest' && who(x, id); return !!p && p.pose === 'stand' && Math.hypot(p.x - px, p.z - pz) < 1; }, 15000);
      if (!ok) { detail = 'the person the host stood was not shown to the guest there'; continue; }
      await G.go(px - 6, pz, Math.PI / 2);
      await arm(G, 1);
      await sleep(800);
      const g0 = await G.until((x) => x.police.level === 0, 8000) ?? await G.net(), h0 = await H.net(), b0 = (await wstats(G)).body;
      // The pistol, through the game's own trigger, until a round has found them (26 off them: they stagger and run).
      let rounds = 0, pg = null, ph = null, hits = 0;
      for (let k = 0; k < 8 && hits === 0; k++) { if (await pull(G)) rounds++; await sleep(300); hits = (await wstats(G)).body - b0; }
      if (hits === 0) { detail = 'no round found the person'; continue; }
      const hurt = await H.until((x) => { const p = who(x, id); return !!p && p.health < 100; }, 8000);
      // Nobody on the ground is a target and nobody stands still to be shot, so the rest of the rounds are given
      // through the game's own "a round has found this person" (as tools/net/people.mjs does): the same message to the host.
      const more = await G.page.evaluate(async (id) => {
        const g = window.__game.game, me = g.player.person, s = [...g.net.people.shown.values()].find((k) => k.wid === id);
        const body = s && s.w ? s.w.p : null;
        if (!body || body === me) return 0;
        let k = 0;
        for (; k < 4; k++) { g.player.weapons.hurtPerson(body, 26, 1, 0, false); await new Promise((r) => setTimeout(r, 250)); }
        return k;
      }, id);
      for (const end = Date.now() + 30000; Date.now() < end;) {
        const [ng, nh] = await Promise.all([G.net(), H.net()]);
        pg = who(ng, id); ph = who(nh, id);
        if (pg && ph && ph.hard && pg.hard && pg.pose === 'down' && ph.pose === 'down' && pg.health === 0 && ph.health === 0) break;
        await sleep(150);
      }
      if ((await roles([A, B]))?.host !== H) { detail = 'the host changed in the middle'; continue; }
      done = true;
      const nh = await H.net();
      check(!!hurt, 'a guest fires the pistol at one of the town\'s people: the round counts on the host', hurt ? `${rounds} round(s), ${hits} found them; health on the host ${who(hurt, id).health}` : 'the host did not take any health off them');
      rounds += more;
      check(!!pg && !!ph && ph.hard && pg.hard && ph.pose === 'down' && pg.pose === 'down' && ph.health === 0 && pg.health === 0, 'a guest shoots one of the town\'s people dead: down for good on both screens', pg && ph ? `${rounds} rounds, ${hits} found them; person ${id}: on ${G.tag}'s screen ${pg.pose}, health ${pg.health}; on the host ${H.tag}'s ${ph.pose}, health ${ph.health}; the host applied ${nh.people.hurtsDone - h0.people.hurtsDone} blows` : 'the person vanished');
      const ng = await G.until((x) => x.police.level >= 1, 20000) ?? await G.net();
      const hi = await H.info(), nh2 = await H.net();
      check(g0.police.level === 0 && ng.police.level >= 1 && ng.police.crimes > g0.police.crimes, 'the shooter is wanted for it, on their own screen', `${G.tag}: level ${g0.police.level} -> ${ng.police.level}, ${ng.police.crimes - g0.police.crimes} crimes seen (last: ${ng.police.lastCrime})`);
      check(nh2.police.level === 0 && hi.heat === 0 && nh2.police.crimes === h0.police.crimes, 'and the other player, whose browser applied the hurt, is not', `${H.tag}: level ${nh2.police.level}, ${nh2.police.crimes - h0.police.crimes} crimes on its sheet`);
      void gid;
    }
    if (!done) check(false, 'a guest shoots one of the town\'s people dead: down for good on both screens', `5 tries; the last: ${detail}`);
  }

  // ── 13. The host's picture of the guest firing ──
  if (SHOTS) {
    r = await rolesSoon([A, B], 30000);
    if (r) {
      const H = r.host, G = r.guests[0];
      for (const t of [H, G]) await calm(t);
      await G.go(SPOT.x + 30, SPOT.z, Math.PI / 2);
      await H.go(SPOT.x + 34, LANE.z - 4, Math.PI / 2);
      await arm(G, 3);
      await sleep(1500);
      const gi = await G.info();
      await H.page.evaluate(([x, y, z]) => window.__game.view(x - 2.5, y + 1.9, z - 5.5, x + 6, y + 1.3, z), [gi.x, gi.y, gi.z]);
      await hold(G, 'aim');
      await sleep(1500);
      const d0 = (await H.net()).fight.shotsDrawn;
      const snapped = snap(H, 'shots/net/weapons-host.png');
      for (let k = 0; k < 3; k++) { await pull(G, 8000); if ((await H.net()).fight.shotsDrawn > d0) break; }
      await snapped;
      await letGo(G, 'aim');
      await H.page.evaluate(() => window.__game.view());
      const nh = await H.net();
      check(nh.fight.shotsDrawn > d0, 'picture: the host sees the guest fire the shotgun (shots/net/weapons-host.png, weapons-guest.png)', `${nh.fight.shotsDrawn - d0} rounds drawn on the host's screen`);
    }
  }

  {
    const errs = [...A.errors, ...B.errors].filter((e) => !/WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/.*failed|ERR_CONNECTION_REFUSED|Failed to load resource|request failed: http:\/\/127\.0\.0\.1:8842/.test(e));
    check(errs.length === 0, 'no errors from the game on either page on main', errs.slice(0, 2).join(' | ').slice(0, 300) || '"errors": []');
    for (const t of [A, B]) { open.splice(open.indexOf(t), 1); await t.close(); }
  }

  // ── 14. A backup style connection: shots are seen and players can hurt each other; no host is told anything ──
  {
    const D = await visitor('D', viaBackup), E = await visitor('E', viaBackup);
    let nd = await D.until((x) => x.status === 'online' && x.count === 2), ne = await E.until((x) => x.status === 'online' && x.count === 2);
    check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on a backup style connection', nd && ne ? `${nd.home}, ${ne.home}` : 'timed out');
    const did = nd.id;
    await D.go(SPOT.x + 8, SPOT.z, -Math.PI / 2);
    await E.go(SPOT.x, SPOT.z, Math.PI / 2);
    await E.until((x) => x.remotes[0] && x.remotes[0].seen && Math.hypot(x.remotes[0].x - (SPOT.x + 8), x.remotes[0].z - SPOT.z) < 0.6, 20000);
    await D.until((x) => x.remotes[0] && x.remotes[0].seen && Math.hypot(x.remotes[0].x - SPOT.x, x.remotes[0].z - SPOT.z) < 0.6, 20000);
    await sleep(3000);
    for (const t of [D, E]) await calm(t);
    await arm(E, 1);
    const d0 = await D.net(), hd0 = (await D.info()).health;
    let rounds = 0, hd = hd0;
    for (let k = 0; k < 12 && hd >= hd0; k++) { if (await pull(E)) rounds++; await sleep(700); hd = (await D.info()).health; }
    nd = await D.net();
    ne = await E.until((x) => { const a = armOf(x, did); return !!a && a.health < 100; }, 8000) ?? await E.net();
    check(nd.fight.firesGot > d0.fight.firesGot && nd.fight.shotsDrawn > d0.fight.shotsDrawn, 'on the backup a shot is seen by the other player', `${rounds} rounds from E; D heard ${nd.fight.firesGot - d0.fight.firesGot} events and drew ${nd.fight.shotsDrawn - d0.fight.shotsDrawn} rounds`);
    check(hd < hd0 && armOf(ne, did)?.health < 100, 'and players can hurt each other there too: the victim\'s own browser takes the health off', `D's health ${hd0} -> ${hd}; E is shown D at ${armOf(ne, did)?.health}`);
    const toHost = (t) => Object.keys(t.out.n).filter((k) => k.startsWith('2.') || k.startsWith('4.') || k === '5');
    check(toHost(D).length === 0 && toHost(E).length === 0 && nd.traffic.mode === 'local' && ne.people.mode === 'local', 'and nothing is sent to or by any host there: cars and people stay private', `kinds on the wire: ${[...new Set([...Object.keys(D.out.n), ...Object.keys(E.out.n)])].join(', ')}`);
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
