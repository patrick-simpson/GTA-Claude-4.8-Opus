// Fun queue 2, item 17: "The Speed Scan" check. node tools/heist/solo.mjs [dist] [--noshots] [--mobile]
//   - Brenda's brief; the lifts obey the badge (none, Visitor, Executive); the badge print game; the data hall guards (vision
//     cones, racks block sight, caught = escorted out with a checkpoint retry, the break-room distraction); the safe; the alarm
//     and both escapes (fire stairs + hoist, roof stairs + parachute); the drop; kid mode; the leaderboard row; normal visits.
// Prints PASS/FAIL per check; exits 1 on a FAIL. Tests use net=0.
import { boot } from '../pw.mjs';
const SHOTS = !process.argv.includes('--noshots'), dist = process.argv.includes('dist'), mobile = process.argv.includes('--mobile');
let failed = 0;
const check = (ok, what, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${d ? '  [' + d + ']' : ''}`); if (!ok) failed++; };
const OUT = 'scratch/q2-17/shots/';
const opts = { query: 'net=0&stage=4', width: mobile ? 844 : 1280, height: mobile ? 390 : 720, dist };
if (mobile) opts.mobile = true;
const t = await boot(opts);
await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.stage(4); });
const H = (f, a) => t.page.evaluate(`(${f.toString()})(window.__game.game.todo.heist, window.__game, ${JSON.stringify(a ?? null)})`);
const info = () => t.game((g) => g.game.todo.heist.info());
const key = async (k, ms = 4) => { await t.page.keyboard.down(k); await t.step(ms); await t.page.keyboard.up(k); await t.step(4); };
// (The HUD's stamps fade in real time: let them go before the picture.)
const shot = async (n) => { if (SHOTS) { await t.page.waitForTimeout(/briefing|contact|report/.test(n) ? 300 : 4500); await t.step(2); await t.shot(OUT + n + '.png'); } };
const view = async (a) => { await t.game((g, v) => g.view(...v), a); await t.step(3); };
const clearView = () => t.game((g) => { g.game.view = null; }).catch(() => {});
await t.page.evaluate(() => { const h = window.__game.game.hud, o = h.toast.bind(h); window.__toasts = []; h.toast = (x, n) => { window.__toasts.push(String(x)); return o(x, n); }; });
const toast = () => t.page.evaluate(() => window.__toasts.slice(-4).join(' || '));
const clearToasts = () => t.page.evaluate(() => { window.__toasts.length = 0; });
const warp = (floor, x, z, h = 0) => H((s, g, a) => s.warp(a[0], a[1], a[2], a[3]), [floor, x, z, h]);
const tp = (x, z, h = 0) => t.game((g, a) => { g.teleport(a.x, a.z, a.h); }, { x, z, h });
const HQ = { x: 27, z: 32 };
const wait = async (ms) => { await t.step(30); await t.page.waitForTimeout(ms); await t.step(30); };
/** Play a timing game: step until the marker is in the green, press. */
const play = async (rounds) => {
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < 400; k++) { const m = (await info()).mini; if (!m.open || m.in) break; await t.step(1); }
    await H((s) => s.mini.press());
    await t.step(2);
  }
};
const closeCard = () => H((s) => s.closeCard());
const toWorld = (lx, lz) => ({ x: HQ.x + lx, z: HQ.z + lz });

// ── wait for the tower's inside ───────────────────────────────────────────────
let I = await info();
await tp(I.contact.x || HQ.x, (I.contact.z || HQ.z + 60) + 2, 0);
await t.step(30);
I = await info();
await tp(I.contact.x + 1.5, I.contact.z + 2.5, Math.PI);
for (let k = 0; k < 40; k++) { const ready = await t.page.evaluate(async () => !!(await import('/src/world/speedscanInterior.ts')).hqLink.interior?.ready); if (ready) break; await t.step(30); await t.page.waitForTimeout(500); }
const ready = await t.page.evaluate(async () => !!(await import('/src/world/speedscanInterior.ts')).hqLink.interior?.ready);
check(ready || mobile, 'the tower interior is built (not on phones)', String(ready));
if (mobile) {
  // A phone: the brief says it cannot be done here, and the game goes on.
  await H((s) => s.openBrief());
  const ok = await H((s) => s.start());
  check(!ok, 'phones are turned away politely');
  console.log(failed ? 'FAILED' : 'ALL PASSED'); await t.close(); process.exit(failed ? 1 : 0);
}

// ── the contact and the brief ─────────────────────────────────────────────────
I = await info();
check(I.contact && Math.hypot(I.contact.x - (HQ.x + 50), I.contact.z - (HQ.z + 50)) < 40, 'Brenda stands at the corner of the HQ block', JSON.stringify(I.contact));
await t.step(60); await t.page.waitForTimeout(1500); await t.step(20);
const pr = await t.game((g) => g.game.hud.promptText);
check(typeof pr === 'string' && /Brenda/.test(pr), 'the hub prompt offers the brief', String(pr));
if (SHOTS) { await view([I.contact.x + 6, 3.2, I.contact.z + 7, I.contact.x, 1.6, I.contact.z]); await shot('contact'); await clearView(); }
await key('KeyG', 4);
I = await info();
check(I.card === 'brief', 'G opens the briefing', I.card);
await t.step(3); await shot('briefing');
await closeCard();

// ── start; the lifts obey the badge ──────────────────────────────────────────
check(await H((s) => s.start()), 'start the job');
await warp('lobby', 4.125, -1.0, Math.PI);
await t.step(40); await t.page.waitForTimeout(1200); await t.step(10);
await t.game((g) => { g.game.todo.heist.run.t = 0; });
// Into the car on the right, and press 3 (floor 20): no badge, so denied.
await warp('lobby', 4.125, -4.4, 0);
await t.step(40);
await clearToasts(); await key('Digit3', 3); await t.step(10);
let tx = await toast();
check(/ACCESS DENIED/.test(tx) && /20/.test(tx), 'no badge: floor 20 is denied on the panel', tx.slice(0, 90));
I = await info(); check(I.me.y < 5, 'still in the lobby after the denied press', String(I.me.y));
await key('Digit2', 3); await t.step(60 * 7);
I = await info();
check(Math.abs(I.me.y - 45.6) < 1.5 && I.me.at === 'print', 'no badge: the lift does take you to 12', JSON.stringify(I.me));
await t.step(60 * 6);

// ── floor 12: the badge printer ──────────────────────────────────────────────
await warp('print', 14, -8.0, Math.PI);
await t.step(20); await t.page.waitForTimeout(1500); await t.step(20);
I = await info();
const kioskSpot = I.spots.find((s) => s.floor === 'print');
check(kioskSpot && /Print a visitor badge/.test(kioskSpot.text || ''), 'the kiosk offers a visitor badge', JSON.stringify(kioskSpot));
if (SHOTS) { await view([HQ.x + 14 + 4, 45.6 + 1.9, HQ.z - 5.4, HQ.x + 14, 45.6 + 1.2, HQ.z - 9.5]); await shot('kiosk'); await clearView(); await t.step(3); }
await key('KeyG', 4);
I = await info();
check(I.mini.open && I.mini.kind === 'print', 'G opens the badge print game', JSON.stringify(I.mini));
// A miss first (the marker is not in the green at once).
for (let k = 0; k < 400; k++) { const m = (await info()).mini; if (!m.in) break; await t.step(1); }
await H((s) => s.mini.press());
I = await info(); check(I.mini.misses === 1 && I.mini.round === 0, 'a miss counts and does not advance', JSON.stringify(I.mini));
await t.step(60 * 4); await shot('badge_print');
await play(3);
I = await info();
check(!I.mini.open && I.run.badge === 1 && I.run.step === 1, 'three hits print the Visitor badge (level 1)', JSON.stringify(I.run));
// The lifts now: 20 opens, 70 does not.
await warp('print', 4.125, -4.4, 0); await t.step(40);
await clearToasts(); await key('Digit7', 3); await t.step(10);
tx = await toast();
check(/ACCESS DENIED/.test(tx) && /Executive/.test(tx), 'Visitor badge: floor 70 is denied (needs Executive)', tx.slice(0, 100));
await key('Digit3', 3); await t.step(60 * 7);
I = await info();
check(Math.abs(I.me.y - 76) < 1.5 && I.me.at === 'data', 'Visitor badge: the lift takes you to 20', JSON.stringify(I.me));
await t.step(60 * 5);

// ── floor 20: the guards ─────────────────────────────────────────────────────
await warp('data', 4.125, -1.4, Math.PI);
await t.step(40); await t.page.waitForTimeout(2500); await t.step(30);
I = await info();
check(I.guards.every((q) => q.at === 'data'), 'two guards on the data hall beat', JSON.stringify(I.guards.map((q) => [q.name, q.x, q.z])));
// A guard walks.
const g0 = I.guards[0]; await t.step(120);
I = await info(); check(Math.hypot(I.guards[0].x - g0.x, I.guards[0].z - g0.z) > 1, 'the guard walks his beat');
// Cones through the racks: Marge in the aisle, player behind the rack row.
await H((s) => { s.setGuard(0, 24, -9.5, 1, 0); s.setGuard(1, -15, -20, 1, 0); });
await warp('data', -15, -11.0, 0);   // between the core and the rack row: the racks are between them and Marge
await t.step(60);
I = await info();
check(!I.guards[1].seen && I.guards[1].meter === 0, 'racks block a guard\'s sight', JSON.stringify(I.guards[1]));
// Caught: player in front of Dale's cone.
await H((s) => { s.setGuard(0, -20, -9.5, 1, 0); s.setGuard(1, 20, -20, 1, 0); });
await warp('data', -13.5, -9.5, Math.PI / 2);
await t.step(40);
I = await info();
check(I.guards[0].seen && I.guards[0].meter > 0.3 && I.spotted > 0, 'a guard in range sees you: the meter fills', JSON.stringify(I.guards[0]));
if (SHOTS) { await view([HQ.x - 4, 76 + 2.4, HQ.z - 11.6, HQ.x - 17, 76 + 0.6, HQ.z - 9.6]); await t.step(2); await shot('guard_cone'); await clearView(); await t.step(2); }
await t.step(70);
I = await info();
check(I.run.escorts === 1 && (I.run.esc || I.me.at === 'print'), 'spotted long enough: escorted out', JSON.stringify([I.run.escorts, I.run.esc, I.me.at]));
await t.step(100);
I = await info();
check(I.me.at === 'print' && I.run.badge === 1 && !I.run.esc && I.run.pen === 20, 'retry from the checkpoint: back on 12, badge kept, +20 s', JSON.stringify([I.me, I.run.badge, I.run.pen]));
// The lifts still work from there (Visitor badge to 20), and a guard is in the data hall again.
await warp('print', 4.125, -4.4, 0); await t.step(40);
await key('Digit3', 3); await t.step(60 * 7);
I = await info(); check(I.me.at === 'data', 'back up to 20 by lift', JSON.stringify(I.me));
await t.step(60 * 4);

// ── the sneak: a guard far off, the encoder ──────────────────────────────────
await H((s) => { s.setGuard(0, 24, -9.5, 1, 0); s.setGuard(1, -17, -20, 1, 0); });
await warp('data', -29.8, -20, Math.PI / 2);
await t.step(30); await t.page.waitForTimeout(1200); await t.step(30);
I = await info();
check(I.guards.every((q) => !q.seen), 'at the encoder, out of both cones');
await shot('encoder_sneak');
if (SHOTS) { await t.step(60 * 5); await view([HQ.x - 21, 76 + 2.5, HQ.z - 19.2, HQ.x - 31, 76 + 0.9, HQ.z - 20]); await t.step(2); await shot('encoder_sneak_view'); await clearView(); await t.step(2); }
await key('KeyG', 4);
await t.step(60 * 2); I = await info();
check(I.run.encode > 1 && I.run.badge === 1, 'holding G: the encoder fills', String(I.run.encode));
await t.step(60 * 3);
I = await info();
check(I.run.badge === 3 && I.run.step === 2 && I.run.escorts === 1, 'four seconds unseen: Executive badge (level 3)', JSON.stringify(I.run));

// ── the distraction (a second run) ───────────────────────────────────────────
await H((s) => s.abandon('test'));
I = await info(); check(!I.run, 'R/abandon ends the job');
await H((s) => s.start());
await H((s) => { s.run.badge = 1; s.run.step = 1; });
await warp('brk', -11.5, -25.6, 0);
await t.step(30); await t.page.waitForTimeout(1500); await t.step(20);
await key('KeyG', 4);
I = await info();
check(I.run.away > 60 && I.balls === 36, 'the ball machine: the guards are sent to look', JSON.stringify([I.run.away, I.balls]));
await t.step(30);
if (SHOTS) { await view([HQ.x - 11.5, 106.4 + 3.2, HQ.z - 22.5, HQ.x - 12.5, 106.4 + 0.8, HQ.z - 27]); await t.step(40); await shot('distraction_balls'); await clearView(); await t.step(2); }
await t.step(60 * 16);
I = await info();
check(I.guards.every((q) => q.at === 'brk'), 'the guards leave the data hall for the break room', JSON.stringify(I.guards.map((q) => q.at)));
await warp('data', -29.8, -20, Math.PI / 2);
await t.step(60);
I = await info(); check(I.guards.every((q) => !q.seen) && I.spotted === 0, 'the data hall is empty while they are away');
await t.step(60 * 60);
I = await info();
check(I.run.away === 0 && I.guards.every((q) => q.at === 'data'), 'and they are back on their beat afterwards', JSON.stringify([I.run.away, I.guards.map((q) => q.at)]));
// Vending machine too.
await H((s) => s.setGuard(0, 26, -9.5, 1, 0));
await warp('brk', 9.2, -31.4, 0); await t.step(30);
await key('KeyG', 4);
I = await info(); check(I.run.away > 60, 'the vending machine works as a distraction too', String(I.run.away));
await H((s) => s.abandon('test'));

// ── the real lift with an Executive badge; floor 70; the safe ───────────────
await H((s) => s.start());
await H((s) => { s.run.badge = 3; s.run.step = 2; });
await warp('data', 4.125, -4.4, 0); await t.step(40);
await key('Digit7', 3); await t.step(60 * 9);
I = await info(); check(Math.abs(I.me.y - 266) < 1.5 && I.me.at === 'ceo', 'Executive badge: the lift takes you to 70', JSON.stringify(I.me));
await t.step(60 * 6);
await warp('ceo', 22.0, -17.5, -Math.PI / 2);
await t.step(30); await t.page.waitForTimeout(2000); await t.step(20);
I = await info();
const safeSpot = I.spots.find((s) => s.floor === 'ceo' && /safe/i.test(s.text || ''));
check(!!safeSpot, 'the safe is offered with an Executive badge', JSON.stringify(safeSpot));
if (SHOTS) { await view([HQ.x + 18.5, 266 + 2.2, HQ.z - 12.5, HQ.x + 23.4, 266 + 0.9, HQ.z - 17.5]); await t.step(2); await shot('safe_prop'); await clearView(); await t.step(2); }
await key('KeyG', 4);
I = await info(); check(I.mini.open && I.mini.kind === 'safe', 'G opens the safe-cracking game');
await t.step(60 * 5); await shot('safe_crack');
// Miss twice (a click each), then crack.
for (let n = 0; n < 2; n++) { for (let k = 0; k < 400; k++) { const m = (await info()).mini; if (!m.in) break; await t.step(1); } await H((s) => s.mini.press()); await t.step(2); }
I = await info(); check(I.run.misses === 2 && !I.run.alarm, 'two misses: not yet an alarm', JSON.stringify([I.run.misses, I.run.alarm]));
await play(3);
I = await info();
check(I.run.lanyard && I.run.alarm && I.run.step === 3 && !I.run.early, 'the safe opens: the Lanyard, and the alarm', JSON.stringify(I.run));
await t.step(60 * 5); await t.page.waitForTimeout(800); await t.step(10);
await shot('alarm');
// The stapler (bonus).
await warp('ceo', 16.9, -18.3, 0); await t.step(30);
await key('KeyG', 4); I = await info(); check(I.run.stapler, "the CEO's stapler (bonus)");
// Lifts locked during the alarm.
await warp('ceo', 4.125, -4.4, 0); await t.step(40);
await clearToasts(); await key('Digit1', 3); await t.step(8);
tx = await toast(); I = await info();
check(/LOCKDOWN|locked/i.test(tx) && I.me.y > 200, 'during the alarm the lifts are locked', tx.slice(0, 80));

// ── escape A: fire stairs, the renovation floor, the hoist ──────────────────
await warp('ceo', -23.6, -10, Math.PI / 2); await t.step(30);
await key('KeyG', 4); await t.step(10);
I = await info(); check(I.me.at === 'reno' && Math.abs(I.me.y - 129.2) < 1, 'fire stairs: down to the renovation floor (34)', JSON.stringify(I.me));
await t.step(20); await t.page.waitForTimeout(1500); await t.step(20);
await warp('reno', -29.3, -16, Math.PI / 2); await t.step(20);
if (SHOTS) { await t.step(60 * 5); await view([HQ.x - 23, 129.2 + 2.2, HQ.z - 19.5, HQ.x - 30.4, 129.2 + 1.2, HQ.z - 16]); await t.step(2); await shot('hoist_floor'); await clearView(); await t.step(2); }
await key('KeyG', 4); await t.step(30);
I = await info(); check(I.run.ride && I.run.ride.kind === 'hoist', 'the hoist ride starts', JSON.stringify(I.run.ride));
if (SHOTS) { await t.step(60 * 4); await view([HQ.x - 36.2 + 10, await t.game((g) => g.game.player.y + 2), HQ.z - 16 + 8, HQ.x - 36.2, await t.game((g) => g.game.player.y), HQ.z - 16]); await t.step(2); await shot('hoist_ride'); await clearView(); }
await t.step(60 * 12);
I = await info();
check(!I.run.ride && I.run.step === 4 && I.run.route === 'hoist' && I.me.y < 3, 'the hoist lands you on the ground, on the run', JSON.stringify([I.run.step, I.run.route, I.me.y]));
const heat = await t.game((g) => g.game.player.heat);
check(heat >= 2, 'the Harbor Patrol has noticed (heat >= 2)', String(heat));
await t.step(30);
// Not stuck: walk a bit.
const p0 = await t.game((g) => [g.game.player.x, g.game.player.z]);
await t.page.keyboard.down('KeyW'); await t.step(90); await t.page.keyboard.up('KeyW');
const p1 = await t.game((g) => [g.game.player.x, g.game.player.z]);
check(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 3, 'free to walk after the landing', String(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]).toFixed(1)));
// The drop: with heat on, no; with heat off, yes.
I = await info();
await tp(I.drop.x, I.drop.z + 3, 0); await t.step(20);
I = await info(); check(I.run && /Lose them/.test(I.prompt || ''), 'at the drop with the Patrol on you: lose them first', String(I.prompt));
await t.game((g) => { g.game.player.heat = 0; }); await t.step(40);
I = await info();
check(!I.run && I.report && I.report.letter && I.report.bonus.includes('STAPLER'), 'delivered: the report card', JSON.stringify(I.report));
await shot('report');
check(I.bests.score !== null && I.bests.time !== null && I.done === 1, 'best score and time are kept', JSON.stringify(I.bests));
await closeCard();

// ── escape B: roof stairs and the parachute; alarm timeout ──────────────────
await H((s) => s.start());
await H((s) => { s.run.badge = 3; s.run.step = 2; });
await warp('ceo', 22.0, -17.5, -Math.PI / 2); await t.step(30);
await H((s) => s.mini.start('x', 'x', 'x', 0, 1, 1, () => {})); await H((s) => s.mini.close());
await key('KeyG', 4);
for (let n = 0; n < 3; n++) { for (let k = 0; k < 400; k++) { const m = (await info()).mini; if (m.open && m.in) break; await t.step(1); } await H((s) => s.mini.press()); await t.step(2); }
I = await info(); check(I.run.lanyard && I.run.alarm, 'second run: safe cracked, alarm on');
// Alarm timeout: staying in the building for 100 s gets you walked back to 70.
await H((s) => { s.run.alarmT = 0.2; });
await warp('ceo', -10, -12, 0); await t.step(30);
I = await info(); check(I.run.escorts === 1, 'alarm ran out inside: security walks you back (escorted)', JSON.stringify([I.run.escorts, I.run.esc]));
await t.step(100);
I = await info(); check(I.me.at === 'ceo' && I.run.alarmT > 90 && I.run.lanyard, 'back at the 70 lift lobby with the Lanyard, alarm clock restarted', JSON.stringify([I.me.at, I.run.alarmT]));
await warp('ceo', 23.6, -4, -Math.PI / 2); await t.step(30);
await key('KeyG', 4); await t.step(10);
I = await info(); check(I.me.at === 'roof', 'roof stairs: up to the roof deck', JSON.stringify(I.me));
await t.step(30); await t.page.waitForTimeout(1500); await t.step(20);
await warp('roof', -14, -1.9, Math.PI); await t.step(20);
if (SHOTS) { await t.step(60 * 5); await view([HQ.x - 6, 322.1 + 1.9, HQ.z - 2.4, HQ.x - 14, 322.1 + 1.0, HQ.z + 0.3]); await t.step(2); await shot('roof_rig'); await clearView(); await t.step(2); }
await key('KeyG', 4); await t.step(30);
I = await info(); check(I.run.ride && I.run.ride.kind === 'chute', 'the parachute ride starts', JSON.stringify(I.run.ride));
if (SHOTS) {
  await t.step(60 * 5);
  const pos = await t.game((g) => [g.game.player.x, g.game.player.y, g.game.player.z]);
  await view([pos[0] + 16, pos[1] + 6, pos[2] + 16, pos[0], pos[1] + 3.5, pos[2]]); await t.step(2); await shot('roof_escape');
  await clearView(); await t.step(60 * 3);
  const pos2 = await t.game((g) => [g.game.player.x, g.game.player.y, g.game.player.z]);
  await view([pos2[0] + 12, pos2[1] + 4, pos2[2] + 12, pos2[0], pos2[1] + 3, pos2[2]]); await t.step(2); await shot('roof_escape_low'); await clearView();
}
await t.step(60 * 20);
I = await info();
check(!I.run.ride && I.run.step === 4 && I.run.route === 'chute' && I.me.y < 3, 'the parachute lands you at the corner', JSON.stringify([I.run.step, I.run.route, I.me.y]));
await tp(I.drop.x, I.drop.z + 3, 0);
await t.game((g) => { g.game.player.heat = 0; }); await t.step(40);
I = await info();
check(!I.run && I.report && I.report.bonus.includes('GHOST') === false && I.done === 2, 'roof route delivered too (one escort: no GHOST)', JSON.stringify(I.report));
await closeCard();

// ── early alarm: three misses ───────────────────────────────────────────────
await H((s) => s.start());
await H((s) => { s.run.badge = 3; s.run.step = 2; });
await warp('ceo', 22.0, -17.5, -Math.PI / 2); await t.step(30); await key('KeyG', 4);
for (let n = 0; n < 3; n++) { for (let k = 0; k < 400; k++) { const m = (await info()).mini; if (!m.in) break; await t.step(1); } await H((s) => s.mini.press()); await t.step(2); }
I = await info(); check(I.run.alarm && I.run.early, 'three misses trip the alarm early (no QUIET bonus)', JSON.stringify([I.run.alarm, I.run.early]));
await H((s) => s.abandon('test'));

// ── kid mode ─────────────────────────────────────────────────────────────────
await t.page.evaluate(async () => { (await import('/src/core/kid.ts')).kid.set(true, null); });
await H((s) => s.openBrief()); await t.step(3);
const kidCard = await t.page.evaluate(() => document.querySelector('#heist .hs-card')?.textContent ?? '');
check(/politely ask you to leave/.test(kidCard) && /Lost &|Lost and|Lost & Found/.test(kidCard), 'kid mode: the brief says politely, and Lost & Found');
await shot('briefing_kid'); await closeCard();
await H((s) => s.start());
await H((s) => { s.run.badge = 1; s.run.step = 1; });
await warp('data', 4.125, -1.4, Math.PI); await t.step(40);
await H((s) => { s.setGuard(0, -20, -9.5, 1, 0); s.setGuard(1, 20, -20, 1, 0); });
await clearToasts(); await warp('data', -13.5, -9.5, Math.PI / 2); await t.step(120);
tx = await toast(); I = await info();
check(I.run.escorts === 1 && /kind face|lost/i.test(tx), 'kid mode: the guard politely walks you out (no violence words)', tx.slice(0, 100));
check(!/firm hands|restricted/i.test(tx), 'kid mode: no harsh line');
await t.step(100);
await H((s) => { s.run.badge = 3; s.run.step = 2; });
await warp('ceo', 22.0, -17.5, -Math.PI / 2); await t.step(30); await key('KeyG', 4);
await clearToasts(); await play(3);
await t.step(10); await shot('alarm_kid');
tx = await toast(); check(/Lost & Found bell/.test(tx), 'kid mode: the alarm is the Lost & Found bell', tx.slice(0, 80));
await H((s) => s.abandon('test'));
await t.page.evaluate(async () => { (await import('/src/core/kid.ts')).kid.set(false, null); });

// ── leaderboard and normal visits ────────────────────────────────────────────
const lb = await t.page.evaluate(async () => {
  const m = await import('/src/game/leaderboard.ts');
  const i = m.CAT.speedscan, g = window.__game.game;
  return { n: m.CATEGORIES.length, i, key: m.CATEGORIES[i].key, gpa: m.CAT.gpa, fmt: m.CATEGORIES[i].fmt(3600 - 305), mine: m.myBest(g, i), title: m.CATEGORIES[i].title };
});
check(lb.i === lb.gpa + 1 && lb.key === 'speedscan' && lb.title === 'Fastest Speed Scan', 'leaderboard row appended after gpa', JSON.stringify(lb));
check(lb.fmt === '5:05' && lb.mine !== null && lb.mine > 3000, 'the row shows a time (5:05) and holds this player\'s best', JSON.stringify([lb.fmt, lb.mine]));
// A normal visit: no job, every floor open, no props, no gate.
await warp('data', 4.125, -4.4, 0); await t.step(30);
await t.game((g) => { g.game.todo.heist.run; });
I = await info();
await warp('lobby', 4.125, -4.4, 0); await t.step(40);
await key('Digit7', 3); await t.step(60 * 9);
I = await info();
check(!I.run && I.me.at === 'ceo', 'normal visit: the lift goes straight to 70 with no badge', JSON.stringify(I.me));
const vis = await t.page.evaluate(() => { const o = []; window.__game.game.scene.traverse((x) => { if (x.name.startsWith('heist-') && x.visible) o.push(x.name); }); return o; });
check(vis.length === 0, 'no heist props show on a normal visit', JSON.stringify(vis));
await t.step(60 * 5);
await key('Digit8', 3); await t.step(60 * 9);
I = await info(); check(I.me.at === 'roof', 'normal visit: and on up to the roof', JSON.stringify(I.me));
check(t.errors.length === 0, 'no page errors', JSON.stringify(t.errors.slice(0, 3)));
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await t.close();
process.exit(failed ? 1 : 0);
