// Team snowball fights (fun queue 2, item 27), single player (net=0): src/game/snowfight.ts, src/ui/snowTag.ts.
//
//   node tools/snowball/solo.mjs [--shots]
//
//  A. No snow lying: on the field the prompt says it needs snow and G is refused (no round); with the snow the round starts;
//     the snow melting mid-round calls it off with no prize.
//  B. With snow (?snow=1): at Mercy Park G starts a round: red (you) with two townsfolk against three blue townsfolk; the
//     count, then the clock; the billboard shows the score; G throws along the camera and a hit scores (on a bot, by the
//     player's own throw, and the bots score on each other and on you: a splat, no health lost); R scoops three more after
//     about a second and only standing still; out of snowballs is said; leaving the field ends it (and frees the player);
//     a second round runs to its end: the prize for the winner, sf.best in the best table, sf.n and the win counted.
//  C. Not offered in a car; the tag shows snowballs and, on touch, the buttons (a check of the markup).
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-27/shots/';

async function open(query) {
  const t = await boot({ query, width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
  await t.page.evaluate(`(async () => {
    const S = await import('/src/game/save.ts');
    const G = window.__game.game;
    window.__s = { S, G, F: G.todo.snow, toasts: [], splats: 0, stamps: [] };
    const tt = G.hud.toast.bind(G.hud); G.hud.toast = (m, s) => { window.__s.toasts.push(String(m)); return tt(m, s); };
    const ts = G.hud.stamp.bind(G.hud); G.hud.stamp = (a, b) => { window.__s.stamps.push(a + ' | ' + (b ?? '')); return ts(a, b); };
    const sp = G.todo.snowTag.splat.bind(G.todo.snowTag); G.todo.snowTag.splat = () => { window.__s.splats++; return sp(); };
  })()`);
  const run = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__s, ${JSON.stringify(arg ?? null)})`);
  const adv = (s) => t.step(Math.round(s * 30), 1 / 30);
  return { t, run, adv };
}

// ── A. No snow ──
{
  const { t, run, adv } = await open('net=0');
  await run((X) => { X.G.sky.setSnowCover(0); X.G.player.health = 100; });
  const site = await run((X) => X.F.info().sites[0]);
  await t.game((g, s) => { g.teleport(s.x, s.z, 0); g.step(20); }, site);
  await run((X) => X.G.sky.setSnowCover(0));
  await adv(0.5);
  let r = await run((X) => ({ prompt: X.F.prompt, snowing: X.F.info().snowing, boards: X.F.info().boards.length }));
  check(!r.snowing, 'no snow lying in this test', String(r.snowing));
  check(/needs snow/.test(r.prompt ?? ''), 'on the field with no snow the prompt says it needs snow', r.prompt);
  check(r.boards === 0, 'no field or billboard is built without snow', String(r.boards));
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(0.4);
  r = await run((X) => ({ mine: X.F.info().mine, toast: X.toasts.find((m) => /needs snow lying/.test(m)) }));
  check(r.mine === 0 && !!r.toast, 'G is refused with a toast, no round', r.toast);
  // With snow, a round; the snow melting calls it off.
  await run((X) => X.G.sky.setSnowCover(0.8));
  await adv(0.5);
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(0.5);
  r = await run((X) => ({ i: X.F.info(), busy: X.G.todo.busy }));
  check(r.i.mine !== 0 && r.busy === 'snowfight', 'with snow lying G starts a round (the player is busy)', JSON.stringify([r.i.mine, r.busy]));
  const money0 = await run((X) => X.G.player.money);
  await run((X) => X.G.sky.setSnowCover(0));
  await adv(0.6);
  r = await run((X) => ({ i: X.F.info(), busy: X.G.todo.busy, money: X.G.player.money, toast: X.toasts.find((m) => /snow has melted/.test(m)) }));
  check(r.i.mine === 0 && r.busy === null && !!r.toast, 'the snow melting calls the round off, the player is free', r.toast);
  check(r.money === money0, 'no prize for a called-off round', `${money0} -> ${r.money}`);
  await t.close();
  if (t.errors.length) { check(false, 'no page errors (A)', t.errors[0]); }
}

// ── B. A whole round ──
{
  const { t, run, adv } = await open('net=0&snow=1');
  await run((X) => { X.G.player.health = 100; X.S.save.data.best['sf.best'] = undefined; });
  const site = await run((X) => X.F.info().sites[0]);
  check(site.name === 'Mercy Park', 'the first field is Mercy Park', JSON.stringify(site));
  await t.game((g, s) => { g.teleport(s.x - 12, s.z, Math.PI / 2); g.step(20); }, site);
  await adv(1);
  let r = await run((X) => ({ prompt: X.F.prompt, boards: X.F.info().boards }));
  check(/\[G\] Start a snowball fight at Mercy Park/.test(r.prompt ?? ''), 'on the field the prompt offers G to start', r.prompt);
  check(r.boards.length >= 1 && r.boards[0].visible, 'the field and billboard are built and shown', JSON.stringify(r.boards));
  check(/READY/.test(r.boards[0].key), 'the idle billboard says READY', r.boards[0].key);
  if (SHOTS) { await t.game((g, a) => g.view(...a), [site.x - 30, 11, site.z + 26, site.x, 2, site.z - 4]); await t.step(2); await t.shot(SH + 'idle.png'); await t.game((g, s) => { g.teleport(s.x - 12, s.z, Math.PI / 2); g.step(5); }, site); }
  const money0 = await run((X) => X.G.player.money);
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(0.5);
  r = await run((X) => ({ i: X.F.info(), tag: document.getElementById('sf-tag').className, tagText: document.getElementById('sf-tag').textContent }));
  check(r.i.mine === 1 && r.i.team === 1 && r.i.hosting && r.i.phase === 1, 'G starts a round: you are red, the host, in the count', JSON.stringify([r.i.mine, r.i.team, r.i.phase]));
  check(r.i.botsR === 2 && r.i.botsB === 3 && r.i.bots.length === 5, 'two townsfolk join red and three make blue (3 v 3)', `${r.i.botsR} + ${r.i.botsB}`);
  check(/on/.test(r.tag) && /Snowballs/.test(r.tagText), 'the tag shows your snowballs', r.tagText);
  await adv(0.3);
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(0.2);
  r = await run((X) => ({ n: X.F.info().thrown, toast: X.toasts.find((m) => /Wait for the count/.test(m)) }));
  check(r.n === 0 && !!r.toast, 'no throwing during the count', r.toast);
  await adv(4.5);
  r = await run((X) => X.F.info());
  check(r.phase === 2 && r.left > 170 && r.left <= 180, 'the clock runs 3 minutes after the count', JSON.stringify([r.phase, r.left]));
  // Throw at the nearest blue bot, over and over, and count the player's own hits.
  const aim = () => run((X) => {
    const i = X.F.info(), p = X.G.player;
    const bots = i.bots.filter((b) => b.team === 2 && !b.stag).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    if (!bots.length) return false;
    const b = bots[0], bb = X.F.bots.find((k) => k.id === b.id); bb.tx = bb.x + 3; bb.tz = bb.z; bb.wander = 5;
    // stand a few metres off, face it
    p.teleport(b.x - 7, b.z, Math.PI / 2);
    X.G.cam.yaw = Math.PI / 2; X.G.cam.pitch = -0.02; X.G.cam.snap();
    return true;
  });
  const hits0 = (await run((X) => X.F.info().myHits));
  let throws = 0;
  for (let k = 0; k < 14 && (await run((X) => X.F.info().myHits)) === hits0; k++) {
    if (!(await run((X) => X.F.info().ammo))) { await t.page.keyboard.press('KeyR'); await adv(1.3); }
    if (await aim()) { await adv(0.1); await aim(); if (process.env.DBG) console.log(await run((X) => JSON.stringify({ me: [X.G.player.x, X.G.player.z], bots: X.F.info().bots.filter((b) => b.team === 2), ammo: X.F.info().ammo, cool: X.F.cool, ph: X.F.info().phase }))); await t.page.keyboard.press('KeyG', { delay: 40 }); throws++; await adv(0.9); }
    else await adv(0.5);
  }
  r = await run((X) => X.F.info());
  check(r.myHits > hits0, 'a snowball along the camera hit a townsperson and scored', `${throws} throws, ${r.myHits} hits, red ${r.red} blue ${r.blue}`);
  check(r.red >= 1, 'the score for red moved', `red ${r.red}`);
  // Run on: the bots throw at each other and at the player.
  await run((X) => { X.G.player.health = 100; });
  const hp0 = await run((X) => X.G.player.health);
  await adv(60);
  r = await run((X) => ({ i: X.F.info(), hp: X.G.player.health, splats: X.splats }));
  check(r.i.red + r.i.blue >= 3, 'the townsfolk score too', `red ${r.i.red} blue ${r.i.blue}`);
  check(r.splats >= 1, 'a hit on the player splats the screen', String(r.splats));
  check(r.hp === hp0 && r.hp > 0, 'no health lost, nobody dies', `${hp0} -> ${r.hp}`);
  const board = await run((X) => X.F.info().boards[0].key);
  check(new RegExp(`\\|${r.i.red}\\|${r.i.blue}\\|`).test(board), 'the billboard shows the score', board);
  if (SHOTS) {
    await t.game((g, a) => g.view(...a), [site.x - 20, 7, site.z + 20, site.x + 2, 2, site.z - 6]); await t.step(2); await t.shot(SH + 'round.png');
    await run((X) => { const s = X.F.info().sites[0]; X.G.player.teleport(s.x - 10, s.z + 4, Math.PI / 2); });
    await t.game((g, a) => g.view(...a), [site.x - 3, 5, site.z + 17, site.x, 5.2, site.z - 13]); await t.step(2); await t.shot(SH + 'board.png');
    await t.game((g) => { g.view(); });
  }
  // Refill.
  await run((X) => { X.F.ammo = 0; const p = X.G.player; const s = X.F.info().sites[0]; p.teleport(s.x - 12, s.z, Math.PI / 2); });
  await adv(0.5);
  await t.page.keyboard.press('KeyG', { delay: 40 }); await adv(0.2);
  r = await run((X) => X.toasts.slice(-3).find((m) => /Out of snowballs/.test(m)));
  check(!!r, 'out of snowballs is said', r);
  await t.page.keyboard.press('KeyR', { delay: 40 });
  await adv(0.4);
  let a = await run((X) => ({ scoop: X.F.info().scoop, ammo: X.F.info().ammo }));
  check(a.scoop && a.ammo === 0, 'R starts a scoop (nothing yet)', JSON.stringify(a));
  await adv(0.8);
  a = await run((X) => ({ scoop: X.F.info().scoop, ammo: X.F.info().ammo }));
  check(!a.scoop && a.ammo === 3, 'a second later three snowballs are in hand', JSON.stringify(a));
  // Leaving the field.
  await t.game((g, s) => { g.teleport(s.x + 60, s.z, 0); g.step(5); }, site);
  await adv(0.3);
  r = await run((X) => ({ i: X.F.info(), busy: X.G.todo.busy, toast: X.toasts.find((m) => /left the field/.test(m)) }));
  check(r.i.mine === 0 && r.busy === null && !!r.toast, 'walking off the field leaves the round and frees the player', r.toast);
  await adv(3);
  r = await run((X) => X.F.info().bots.length);
  // The round was the host's: leaving called it off, nothing is left running.
  check(r === 0, 'a called-off round leaves no townsfolk running', String(r));

  // ── The whole of a round, to the end and the prize ──
  await t.game((g, s) => { g.teleport(s.x - 12, s.z, Math.PI / 2); g.step(20); }, site);
  await adv(0.5);
  const m1 = await run((X) => X.G.player.money);
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(5);
  // Make it a win (the bots' score is not what is under test) and shorten the wait; the round itself is ordinary.
  await run((X) => { const f = X.F.known.get(X.F.me); f.red = 6; f.blue = 3; X.F.playedS = 60; f.left = 1.5; });
  await adv(3);
  r = await run((X) => ({ i: X.F.info(), last: X.F.info().last, money: X.G.player.money, best: X.S.save.data.best['sf.best'], n: X.S.save.count('sf.n'), win: X.S.save.count('sf.win'), stamps: X.stamps.slice(-2), busy: X.G.todo.busy }));
  check(r.i.mine === 0 && r.busy === null, 'the round ended and the player is free', JSON.stringify([r.i.mine, r.busy]));
  check(r.last.winner === 1 && r.last.red >= 6 && r.last.blue >= 3, 'red won (at least 6-3: the townsfolk may add)', JSON.stringify(r.last));
  check(r.last.pay > 0 && r.money - m1 === r.last.pay, 'the winner is paid a small prize', `$${r.last.pay}`);
  check(r.best >= 6 && r.n >= 1 && r.win >= 1, 'sf.best, sf.n and sf.win are kept', JSON.stringify([r.best, r.n, r.win]));
  check(r.stamps.some((s) => /YOUR TEAM WINS/.test(s)), 'a stamp says so', r.stamps.join(' / '));
  const board2 = await run((X) => X.F.info().boards[0].key);
  check(/RED WINS/.test(board2) && /\|6\|3\|/.test(board2), 'the billboard keeps the result', board2);
  // A loss and a short stay pay nothing.
  await adv(0.5);
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(5);
  const m2 = await run((X) => X.G.player.money);
  await run((X) => { const f = X.F.known.get(X.F.me); f.red = 1; f.blue = 5; X.F.playedS = 60; f.left = 1.5; });
  await adv(3);
  r = await run((X) => ({ last: X.F.info().last, money: X.G.player.money, best: X.S.save.data.best['sf.best'] }));
  check(r.last.winner === 2 && r.last.pay === 0 && r.money === m2, 'a loss pays nothing', JSON.stringify(r.last));
  check(r.best >= 6, 'a lower score does not replace the best', String(r.best));
  await adv(0.5);
  await t.page.keyboard.press('KeyG', { delay: 60 });
  await adv(5);
  const m3 = await run((X) => X.G.player.money);
  await run((X) => { const f = X.F.known.get(X.F.me); f.red = 9; f.blue = 2; X.F.playedS = 5; f.left = 1.5; });
  await adv(3);
  r = await run((X) => ({ last: X.F.info().last, money: X.G.player.money }));
  check(r.last.winner === 1 && r.last.pay === 0 && r.money === m3, 'a win after a stay of 5 seconds pays nothing', JSON.stringify(r.last));

  // ── C. Not in a car; the tag on touch ──
  await adv(0.5);
  await run((X) => X.G.player.teleport(X.F.info().sites[0].x, X.F.info().sites[0].z, 0));
  await t.game((g) => g.drive('sedan')); await adv(1);
  r = await run((X) => ({ prompt: X.F.prompt, tag: document.getElementById('sf-tag').className }));
  check(!/snowball fight/i.test(r.prompt ?? '') && !/\bon\b/.test(r.tag), 'in a car there is no offer', JSON.stringify(r));
  await t.game((g) => g.exit && g.exit());
  if (t.errors.length) check(false, 'no page errors (B)', t.errors[0]);
  else check(true, 'no page errors');
  await t.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
