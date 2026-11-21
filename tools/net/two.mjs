// Multiplayer stage 1 check: two (or three) headless browsers against a LOCAL message service.
//
//   cd server && npx wrangler dev --port 8787        (in another shell, first)
//   node tools/net/two.mjs                 the checks and the pictures
//   node tools/net/two.mjs --count         also: messages and bytes for 30 s standing still and 30 s driving
//   node tools/net/two.mjs --three         a third player joins and leaves
//   node tools/net/two.mjs --net ws://127.0.0.1:8787 --noshots
//
// Player A walks, then drives; B must see A's position follow, see on foot turn into driving, and A must see B
// join and leave. Pictures are taken FROM B'S VIEW into shots/net/. Prints PASS or FAIL per check; exits 1 on a FAIL.
// The pages run in real time (not frozen): the network does, so the smoothing has to be watched the same way.
// There is no video card here, so frames are slow and the tolerances are wide; they are distances, not timings.

import { boot } from '../pw.mjs';

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const NET = val('net', 'ws://127.0.0.1:8787');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

async function open(tag, quality = 'low', size = [480, 270]) {
  const t = await boot({ start: false, query: `net=${encodeURIComponent(NET)}&q=${quality}`, width: size[0], height: size[1] });
  t.tag = tag;
  t.net = () => t.page.evaluate(() => window.__game.net());
  t.pos = () => t.page.evaluate(() => { const i = window.__game.info(); return { x: i.x, y: i.y, z: i.z, h: i.h, speed: i.speed, vehicle: i.vehicle }; });
  /** Both ends read in one go, as close together in time as two pages allow. */
  t.until = async (fn, ms = 20000, arg) => {
    const end = Date.now() + ms;
    for (;;) {
      const n = await t.net();
      if (fn(n, arg)) return n;
      if (Date.now() > end) return null;
      await sleep(150);
    }
  };
  return t;
}
const remoteOf = (n, id) => n.remotes.find((r) => r.id === id);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Sample A's true position and B's picture of it for `ms`; the largest gap while moving. */
async function follow(A, B, ms) {
  let worst = 0, n = 0, moved = 0, first = null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [p, nb] = await Promise.all([A.pos(), B.net()]);
    const r = remoteOf(nb, A.id);
    if (r) { worst = Math.max(worst, dist(p, r)); n++; }
    first ??= p; moved = dist(first, p);
    await sleep(120);
  }
  return { worst: +worst.toFixed(2), samples: n, moved: +moved.toFixed(1) };
}
/** After A has stopped: how far B's picture of A ends up from the truth. */
async function settle(A, B, ms = 2500) {
  await sleep(ms);
  const [p, nb] = await Promise.all([A.pos(), B.net()]);
  const r = remoteOf(nb, A.id);
  return { gap: r ? +dist(p, r).toFixed(3) : 999, dy: r ? +Math.abs(p.y - r.y).toFixed(3) : 999, p, r };
}

/** Handbrake until the car is at rest (the simulation runs slower than the clock on a slow machine). */
async function stop(t) {
  await t.page.keyboard.down('Space');
  for (let i = 0; i < 80 && (await t.pos()).speed > 0.02; i++) await sleep(250);
  await t.page.keyboard.up('Space');
}

const A = await open('A'), B0 = await open('B');
let B = B0, C = null;
try {
  // ── Presence ──
  let na = await A.until((n) => n.status === 'online' && n.remotes.length === 1);
  let nb = await B.until((n) => n.status === 'online' && n.remotes.length === 1);
  check(!!na && !!nb, 'both connect and each sees the other', na && nb ? `A is ${na.id} "${na.name}", B is ${nb.id} "${nb.name}"` : `A ${JSON.stringify(await A.net())}`);
  if (!na || !nb) throw new Error('no connection: is the service running on ' + NET + '?');
  A.id = na.id; B.id = nb.id;
  check(remoteOf(na, B.id)?.name === nb.name && remoteOf(nb, A.id)?.name === na.name, 'each shows the name the other chose', `${remoteOf(nb, A.id)?.name} / ${remoteOf(na, B.id)?.name}`);
  check(na.countText === '2 in town' && nb.countText === '2 in town', 'the HUD count reads "2 in town" on both', `${na.countText} / ${nb.countText}`);
  check(!remoteOf(nb, A.id).seen, 'nobody is drawn while still on the title card');

  for (const t of [A, B]) await t.page.evaluate(() => window.__game.start());
  // A on an open street facing east along it; B a few steps off, so the two are not standing inside each other.
  await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  await B.page.evaluate(() => window.__game.teleport(-36, 288, 1.57));
  nb = await B.until((n, id) => n.remotes.find((r) => r.id === id)?.seen, 15000, A.id);
  na = await A.until((n, id) => n.remotes.find((r) => r.id === id)?.seen, 15000, B.id);
  check(!!nb && !!na, 'each is drawn on the other screen once the game starts');
  let s = await settle(A, B, 1500);
  check(s.gap < 0.1 && s.dy < 0.1, 'B shows A standing where A stands', `${s.gap} m, height ${s.dy} m`);
  check(s.r.mode === 0 && s.r.pose === 'stand' && !s.r.vehicle, 'B shows A on foot, standing', `mode ${s.r.mode} pose ${s.r.pose}`);

  // ── A walks ──
  await A.page.keyboard.down('KeyW');
  await sleep(600);
  const mid = remoteOf(await B.net(), A.id);
  let f = await follow(A, B, 7000);
  const midWalk = remoteOf(await B.net(), A.id);
  await A.page.keyboard.up('KeyW');
  check(f.moved > 1.5 && f.worst < 3, 'B follows A walking', `A went ${f.moved} m; worst gap ${f.worst} m over ${f.samples} samples`);
  check(['walk', 'run'].includes(midWalk.pose) && midWalk.speed > 0.5, 'B animates A walking', `pose ${mid.pose} then ${midWalk.pose}, speed ${midWalk.speed}`);
  s = await settle(A, B);
  check(s.gap < 0.15, 'B shows A where A stopped', `${s.gap} m`);
  check(s.r.pose === 'stand', 'B shows A standing again', s.r.pose);

  // ── A drives ──
  const paint = 0x2a9d8f;
  await A.page.evaluate((c) => { const g = window.__game; g.drive('sports'); g.game.player.vehicle.color = c; }, paint);
  nb = await B.until((n, id) => n.remotes.find((r) => r.id === id)?.vehicle === 'sports', 8000, A.id);
  let r = nb && remoteOf(nb, A.id);
  check(!!r && r.mode === 2, 'B sees A change from on foot to driving', r ? `mode ${r.mode}, ${r.vehicle}` : JSON.stringify(remoteOf(await B.net(), A.id)));
  nb = await B.until((n, id) => n.remotes.find((r) => r.id === id)?.color === 0x2a9d8f, 5000, A.id);
  check(!!nb, 'B sees the right kind and colour of car', nb ? `sports, #${remoteOf(nb, A.id).color.toString(16)}` : '');
  const near = (t, p) => t.page.evaluate((p) => window.__game.game.vehicles.list.filter((v) => v.spec.kind === 'sports' && Math.hypot(v.x - p.x, v.z - p.z) < 3).length, p);
  const pa = await A.pos();
  const [ca, cb] = [await near(A, pa), await near(B, pa)];
  check(ca === 1 && cb === 0, "A's car is a drawn copy on B, not one of B's simulated cars", `simulated sports cars at that spot: ${ca} on A, ${cb} on B`);
  await A.page.keyboard.down('KeyW');
  await sleep(500);
  f = await follow(A, B, 9000);
  const midDrive = remoteOf(await B.net(), A.id);
  await A.page.keyboard.up('KeyW');
  check(f.moved > 6 && f.worst < 10, 'B follows A driving', `A went ${f.moved} m; worst gap ${f.worst} m over ${f.samples} samples; B saw speed ${midDrive.speed} m/s`);
  await stop(A);
  s = await settle(A, B, 3500);
  check(s.gap < 0.3 && s.dy < 0.15, 'B shows the car where A stopped it', `${s.gap} m, height ${s.dy} m, A speed ${s.p.speed}`);

  // ── Messages: only while something changes ──
  if (has('count')) {
    const sent = async () => (await A.net()).sent;
    let a = await sent();
    await sleep(30000);
    let b = await sent();
    console.log(`COUNT  parked in a car for 30 s: ${b.msgs - a.msgs} messages, ${b.bytes - a.bytes} bytes (${b.states - a.states} state frames)`);
    await A.page.evaluate(() => { const g = window.__game; g.game.player.exit(); });
    await sleep(3000);
    a = await sent();
    await sleep(30000);
    b = await sent();
    console.log(`COUNT  standing still on foot for 30 s: ${b.msgs - a.msgs} messages, ${b.bytes - a.bytes} bytes (${b.states - a.states} state frames)`);
    check(b.states - a.states <= 2 && b.msgs - a.msgs <= 24, 'standing still sends keepalives only');
    await A.page.evaluate(() => { const g = window.__game; g.teleport(-44, 285, -1.57); g.drive('sedan'); });
    await sleep(1000);
    a = await sent();
    // Round the block: throttle held, the wheel turned now and then.
    await A.page.keyboard.down('KeyW');
    const p0 = await A.pos(); let far = 0;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      await A.page.keyboard.down(i % 2 ? 'KeyA' : 'KeyD'); await sleep(1000); await A.page.keyboard.up(i % 2 ? 'KeyA' : 'KeyD');
      far = Math.max(far, dist(p0, await A.pos()));
    }
    await A.page.keyboard.up('KeyW');
    b = await sent();
    console.log(`COUNT  driving for 30 s: ${b.msgs - a.msgs} messages, ${b.bytes - a.bytes} bytes (${b.states - a.states} state frames; got ${far.toFixed(0)} m from the start)`);
    check(b.msgs - a.msgs <= 330, 'driving stays at ten state frames a second or under', `${((b.msgs - a.msgs) / 30).toFixed(1)} a second`);
    await stop(A);
  }

  // ── A swims ──
  await A.page.evaluate(() => { const g = window.__game; if (g.game.player.vehicle) g.game.player.exit(); g.teleport(60, 560, 0); });
  await sleep(4000);
  const sw = await A.page.evaluate(() => window.__game.info().swimming);
  nb = await B.until((n, id) => n.remotes.find((r) => r.id === id)?.pose === 'swim', 6000, A.id);
  if (sw) check(!!nb && remoteOf(nb, A.id).mode === 1, 'B sees A swimming', nb ? `pose ${remoteOf(nb, A.id).pose}, height ${remoteOf(nb, A.id).y}` : JSON.stringify(remoteOf(await B.net(), A.id)));
  else console.log('SKIP  swimming: (60, 560) is not water');
  await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
  await sleep(1500);

  // ── A third player ──
  if (has('three')) {
    C = await open('C');
    const nc = await C.until((n) => n.status === 'online' && n.remotes.length === 2);
    na = await A.until((n) => n.remotes.length === 2);
    check(!!nc && !!na && na.countText === '3 in town', 'a third player joins; the count reads "3 in town"', na?.countText);
    await C.close(); C = null;
    na = await A.until((n) => n.remotes.length === 1, 10000);
    check(!!na && na.countText === '2 in town', 'the third leaves; back to "2 in town"', na?.countText);
  }

  // ── B leaves; A must see it ──
  const before = await A.page.evaluate(() => { const g = window.__game; return { people: g.info().people, labels: g.game.scene.children.filter((o) => o.name === 'net_label').length }; });
  await B.close();
  na = await A.until((n) => n.remotes.length === 0, 10000);
  const after = await A.page.evaluate(() => { const g = window.__game; return { people: g.info().people, labels: g.game.scene.children.filter((o) => o.name === 'net_label').length }; });
  check(!!na && na.countText === '', 'A sees B leave; the count goes away', na ? `count "${na.countText}"` : '');
  check(before.labels === 1 && after.labels === 0 && after.people === before.people - 1, "B's person and name tag are taken out of A's scene", `people ${before.people} to ${after.people}, tags ${before.labels} to ${after.labels}`);

  // ── Pictures from B's view, at the high preset ──
  if (!has('noshots')) {
    B = await open('B', 'high', [1280, 720]);
    nb = await B.until((n) => n.status === 'online' && n.remotes.length === 1, 60000);
    na = await A.until((n) => n.remotes.length === 1, 10000);
    check(!!nb && !!na, 'B comes back (a new id) and A sees the join', nb ? `B is now ${nb.id}` : JSON.stringify(await B.net()).slice(0, 200));
    if (!nb || !na) throw new Error('B did not come back');
    await B.page.evaluate(() => { window.__game.start(); window.__game.setTime(14); });
    /** Put B's player near A and pin B's camera `back` m in front of A (A's own facing), `up` m high, looking at A. */
    const look = async (back, up, side = 0, aimY = 1.1) => {
      const p = await A.pos();
      await B.page.evaluate(([p, back, up, side, aimY]) => {
        const g = window.__game, s = Math.sin(p.h), c = Math.cos(p.h);
        g.teleport(p.x - c * 7 - s * 4, p.z + s * 7 - c * 4, p.h);
        g.view(p.x + s * back + c * side, p.y + up, p.z + c * back - s * side, p.x, p.y + aimY, p.z);
      }, [p, back, up, side, aimY]);
    };
    // A parked in the sports car.
    await look(6.5, 2.2, 4.5, 0.9);
    await B.until((n, id) => n.remotes.find((r) => r.id === id)?.vehicle === 'sports', 20000, A.id);
    await sleep(12000);   // the Blender models arrive a few seconds after boot
    await look(6.5, 2.2, 4.5, 0.9);
    await sleep(4000);
    console.log('shot', await B.shot('shots/net/b-sees-a-car.png'));
    // A gets out and stands.
    await A.page.evaluate(() => { const g = window.__game; g.game.player.exit(); });
    await sleep(4000);
    await look(4.2, 1.7, 1.2, 1.2);
    await sleep(5000);
    console.log('shot', await B.shot('shots/net/b-sees-a-standing.png'));
    // A walks toward the camera: the picture is taken mid-stride.
    await look(13, 1.6, 1.5, 1.1);
    await sleep(3000);
    await A.page.keyboard.down('KeyW');
    await sleep(1800);
    console.log('shot', await B.shot('shots/net/b-sees-a-walking.png'));
    await sleep(700);
    await A.page.keyboard.up('KeyW');
    const w = remoteOf(await B.net(), A.id);
    console.log('B saw A walking as', JSON.stringify({ pose: w.pose, speed: w.speed, label: w.label }));
    // A drives past the camera.
    await A.page.evaluate(() => { const g = window.__game; g.teleport(-60, 285, -1.57); g.drive('taxi'); });
    await sleep(3000);
    await look(26, 1.5, 3.2, 0.8);
    await sleep(6000);
    await A.page.keyboard.down('KeyW');
    await sleep(2600);
    console.log('shot', await B.shot('shots/net/b-sees-a-driving.png'));
    await A.page.keyboard.up('KeyW');
    await stop(A);
    const dr = remoteOf(await B.net(), A.id);
    console.log('B saw A driving as', JSON.stringify({ vehicle: dr.vehicle, color: dr.color.toString(16), label: dr.label }));
    // A swims off the pier.
    await A.page.evaluate(() => { const g = window.__game; g.game.player.exit(); g.teleport(60, 560, 0); });
    await sleep(5000);
    await look(5, 2.6, 2, 1.6);
    await sleep(7000);
    console.log('shot', await B.shot('shots/net/b-sees-a-swimming.png'));
    await A.page.evaluate(() => window.__game.teleport(-30, 285, 1.57));
    await sleep(2000);
    // After dark: the tag must still read, and not glare.
    await B.page.evaluate(() => window.__game.setTime(22.5));
    await sleep(4000);
    await look(5, 1.7, 1.5, 1.2);
    await sleep(6000);
    console.log('shot', await B.shot('shots/net/b-sees-a-night.png'));
  }
  for (const t of [A, B]) if (t.errors.length) check(false, `no console errors on ${t.tag}`, t.errors.slice(0, 3).join(' | '));
  if (!A.errors.length && !B.errors.length) check(true, 'no console errors on either page');
} catch (e) {
  check(false, 'the script ran to the end', String(e?.stack ?? e).split('\n').slice(0, 3).join(' '));
} finally {
  for (const t of [A, B, C]) if (t) await t.close().catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
