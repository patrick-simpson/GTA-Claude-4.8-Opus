// Spectator betting (fun queue 2, item 26), single player (net=0): src/game/betting.ts, src/ui/betPanel.ts, the derby of locals.
//
//   node tools/betting/solo.mjs [--shots]
//
//  1. Odds: the pay for a winning stake is (1 - 15%) over the share, so a bet is worth less than its stake: checked for fields of
//     2 to 8 (record holder included), and by 20,000 random bets on an eight-car field.
//  2. At the Flounder Field gate Z puts on a derby of eight locals: a window with eight named, numbered cars and their odds, the
//     BETS tag on screen, the slip opens (and closes with Z / Esc).
//  3. The slip's rules: a stake under $10 or over $500, more than you hold, no driver picked, a second bet: each refused; a good
//     bet comes out of your pocket at once; Take it back gives it all back; a bet saved as held (bt.hold) comes home on a reload.
//  4. Refund: walk away from the gate, the derby is off, the stake is back.
//  5. A whole derby: bet, the window closes at the start (no late bets), the cars fight, the result pays or takes the stake as
//     the podium says; bt.won / bt.lost move by exactly that; the money adds up.
//  6. Forced results on a fresh window: a win pays floor(stake x multiple) and counts in bt.won, a loss counts in bt.lost.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-26/shots/';

const t = await boot({ query: 'net=0&stage=4', width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
await t.page.evaluate(`(async () => {
  const B = await import('/src/game/betting.ts');
  const S = await import('/src/game/save.ts');
  const G = window.__game.game;
  window.__b = { B, S, G, BT: G.todo.betting, D: G.todo.derby, toasts: [] };
  const tt = G.hud.toast.bind(G.hud); G.hud.toast = (m, s) => { window.__b.toasts.push(String(m)); return tt(m, s); };
})()`);
const run = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__b, ${JSON.stringify(arg ?? null)})`);
/** Advance the frozen game by s seconds in 1/30 s steps. */
const adv = (s) => t.step(Math.round(s * 30), 1 / 30);

// ── 1. Odds ──
const od = await run((X) => {
  const out = { worst: 0, dup: 0, bad: [] };
  for (let n = 2; n <= 8; n++) for (const holder of [false, true]) {
    const ws = Array.from({ length: n }, (_, i) => (holder && i === 0 ? 1.35 : 1));
    const s = ws.reduce((a, b) => a + b, 0), ms = X.B.odds(ws);
    for (const stake of [10, 25, 50, 100, 250, 500]) {
      ws.forEach((w, i) => { out.worst = Math.max(out.worst, (w / s) * X.B.returns(stake, ms[i]) / stake); });
    }
    if (ms.some((m) => !(m > 1))) out.bad.push(n + ':' + ms.join(','));
  }
  let tot = 0, N = 20000;
  const ms = X.B.odds(Array(8).fill(1));
  for (let i = 0; i < N; i++) { const pick = Math.floor(Math.random() * 8), win = Math.floor(Math.random() * 8); if (pick === win) tot += X.B.returns(100, ms[pick]); }
  out.mc = tot / (N * 100);
  out.m8 = ms[0];
  return out;
});
check(od.worst <= 0.8501, 'whichever driver you back, a stake is worth at most 85% of itself on average, for every field of 2 to 8 and every stake', 'worst ' + od.worst.toFixed(4));
check(od.bad.length === 0, 'every pick pays more than its stake back when it wins (a multiple over 1)', JSON.stringify(od.bad));
check(od.mc < 0.93 && od.mc > 0.75, '20,000 random bets on an eight-car field return about 85 cents on the dollar', od.mc.toFixed(3));
check(Math.abs(od.m8 - 6.8) < 0.001, 'eight equal cars pay x6.8 (85% of 8)', String(od.m8));

// ── 2. The derby of locals ──
const gate = await run((X) => X.D.info().gate);
await t.game((g, gt) => { g.teleport(gt.x, gt.z, 0); g.step(20); }, gate);
await run((X) => { X.G.player.money = 2000; X.G.player.health = 100; });
const none = await run((X) => ({ open: X.BT.openList().length, prompt: X.D.prompt }));
check(none.open === 0, 'no window is open before Z');
check(/\[Z\] Bet on a derby of eight locals/.test(none.prompt ?? ''), 'at the gate the prompt offers [Z] to bet', none.prompt);
await t.page.keyboard.press('KeyZ', { delay: 60 });
await adv(0.5);
let st = await run((X) => X.BT.info());
const w0 = st.wins[0];
check(!!w0 && w0.local && w0.state === 'open' && w0.entrants.length === 8, 'Z puts on a derby of eight locals: an open window with eight cars', w0 ? `${w0.state} ${w0.entrants.length}` : 'none');
check(w0 && w0.entrants.every((e) => /^#\d$/.test(e.tag) && e.name.length > 2 && e.mult > 1) && new Set(w0.entrants.map((e) => e.name)).size === 8, 'each car has a number, its own name and a multiple', JSON.stringify(w0 && w0.entrants.slice(0, 2)));
check(w0 && w0.left > 20000 && w0.left <= 25000, 'the window runs 25 s', String(w0 && w0.left));
const d0 = await run((X) => X.D.info());
check(d0.phase === 'bets', 'the derby waits in its betting phase (nobody of ours in it)', d0.phase);
const panel = await run((X) => ({ on: document.querySelector('.bt-back').classList.contains('on'), tag: document.getElementById('bt-tag').textContent, tagOn: document.getElementById('bt-tag').classList.contains('on'), open: X.BT.panelOpen }));
check(panel.on && panel.open, 'the slip opened with Z');
await adv(0.3);
if (SHOTS) await t.shot(SH + 'slip.png');
await t.page.keyboard.press('Escape', { delay: 60 });
await adv(0.3);
const closed = await run((X) => ({ on: document.querySelector('.bt-back').classList.contains('on'), tagOn: document.getElementById('bt-tag').classList.contains('on'), tag: document.getElementById('bt-tag').textContent }));
check(!closed.on, 'Esc closes the slip');
check(closed.tagOn && /^Bets open/.test(closed.tag), 'the BETS tag shows while it is open', closed.tag);
if (SHOTS) await t.shot(SH + 'tag.png');
await t.page.keyboard.press('KeyZ', { delay: 60 }); await adv(0.2);
await t.page.keyboard.press('KeyZ', { delay: 60 }); await adv(0.2);
check(await run((X) => !X.BT.panelOpen), 'Z again puts the slip away');

// ── 3. The slip's rules ──
const id = 'derby:local';
const rules = await run((X) => {
  const m0 = X.G.player.money, out = {};
  out.low = X.BT.place('derby:local', 'a0', 9);
  out.high = X.BT.place('derby:local', 'a0', 501);
  out.frac = X.BT.place('derby:local', 'a0', 1e9);
  out.nopick = X.BT.place('derby:local', 'zz', 50);
  out.untouched = X.G.player.money === m0;
  out.ok = X.BT.place('derby:local', 'a2', 100);
  out.after = X.G.player.money;
  out.hold = X.S.save.data.best['bt.hold'];
  out.second = X.BT.place('derby:local', 'a3', 50);
  out.m0 = m0;
  return out;
});
check(rules.low !== '' && rules.high !== '', 'stakes under $10 and over $500 are refused', `${rules.low} | ${rules.high}`);
check(rules.frac !== '' && rules.nopick !== '' && rules.untouched, 'more than you hold, or no driver, is refused and nothing is taken');
check(rules.ok === '' && rules.after === rules.m0 - 100 && rules.hold === 100, 'a good bet comes out of your pocket at once and is held (bt.hold)', `${rules.m0} -> ${rules.after}, hold ${rules.hold}`);
check(rules.second !== '', 'a second bet on the same event is refused', rules.second);
const back = await run((X) => { const m = X.G.player.money; X.BT.withdraw('derby:local'); return { m, after: X.G.player.money, hold: X.S.save.data.best['bt.hold'], bet: X.BT.info().wins[0].bet }; });
check(back.after === back.m + 100 && back.hold === 0 && !back.bet, 'Take it back gives the whole stake back', `${back.m} -> ${back.after}`);
const stepper = await run((X) => { X.BT.place('derby:local', 'a1', 25); const e = X.BT.info(); const r = { money: X.G.player.money, hold: e.hold }; X.BT.withdraw('derby:local'); return r; });
check(stepper.hold === 25, 'a $25 bet is held as 25', JSON.stringify(stepper));
// A page reloaded in mid-event: the held money comes home at boot.
const reload = await run((X) => {
  X.BT.place('derby:local', 'a4', 50);
  const m = X.G.player.money, h = X.S.save.data.best['bt.hold'];
  new X.B.Betting(X.G);
  return { m, h, after: X.G.player.money, hold: X.S.save.data.best['bt.hold'] };
});
check(reload.h === 50 && reload.after === reload.m + 50 && reload.hold === 0, 'a bet held when the page was closed comes home on the next load', JSON.stringify(reload));
// Put the money-and-bet state straight (the simulated reload left the first copy's bet standing): take it back.
await run((X) => { const w = X.BT.wins.get('derby:local'); if (w && w.bet) { w.bet = null; } });

// ── 4. Refund: walk away ──
const m1 = await run((X) => { X.BT.withdraw('derby:local'); const m = X.G.player.money; X.BT.place('derby:local', 'a5', 200); return m; });
const m2 = await run((X, g) => { const m = X.G.player.money; X.G.player.teleport(g.x + 400, g.z); return m; }, gate);
await adv(1.5);
const rf = await run((X) => ({ money: X.G.player.money, hold: X.S.save.data.best['bt.hold'], phase: X.D.phase, wins: X.BT.info().wins.map((w) => w.state), toast: X.toasts.slice(-3).join(' | ') }));
check(m2 === m1 - 200, 'the $200 bet was taken', `${m1} -> ${m2}`);
check(rf.phase === 'idle' && rf.money === m1 && rf.hold === 0, 'walking away calls the derby off and the stake is back', JSON.stringify(rf));
check(/called off|walked away/.test(rf.toast) && /\$200/.test(rf.toast), 'a toast says so', rf.toast);

// ── 5. A whole derby ──
await t.game((g, gt) => { g.teleport(gt.x, gt.z, 0); g.step(20); }, gate);
await run((X) => { X.D.testRound = 24; X.G.player.money = 1000; X.G.player.health = 100; X.S.save.data.best['bt.won'] = 0; X.S.save.data.best['bt.lost'] = 0; X.toasts.length = 0; });
await t.page.keyboard.press('KeyZ', { delay: 60 });
await adv(0.5);
await t.page.keyboard.press('Escape', { delay: 60 });
const bet = await run((X) => { const err = X.BT.place('derby:local', 'a6', 100); return { err, m: X.G.player.money, bet: X.BT.info().wins[0].bet }; });
check(bet.err === '' && bet.bet && bet.bet.mult > 1 && bet.m === 900, 'a $100 bet on car #7 is placed', JSON.stringify(bet.bet));
await adv(26);
const late = await run((X) => ({ phase: X.D.phase, state: X.BT.info().wins[0].state, err: X.BT.place('derby:local', 'a0', 50), cars: X.D.info().cars.length }));
check(late.phase === 'count' || late.phase === 'fight', 'the derby started when the window ran out', late.phase);
check(late.state === 'closed' && late.err !== '', 'bets closed at the start: a late bet is refused', `${late.state}: ${late.err}`);
check(late.cars === 8, 'eight cars in the bowl, all local', String(late.cars));
if (SHOTS) { await adv(8); await t.shot(SH + 'derby.png'); }
let fin = null;
for (let i = 0; i < 40 && !fin; i++) { await adv(5); const d = await run((X) => X.D.info()); if (d.phase === 'podium') fin = d; }
check(!!fin, 'the derby ran to its podium', fin ? 'podium' : 'never');
if (fin) {
  const r = await run((X) => ({ info: X.BT.info(), money: X.G.player.money, toasts: X.toasts.slice(-3) }));
  const winner = fin.results[0], won = winner.id - 200 === 6;
  const w = r.info.wins[0];
  check(w.state === 'settled', 'the bet slip settled on the derby result', w.state + ' ' + w.result);
  const mult = bet.bet.mult, back = Math.floor(100 * mult);
  if (won) check(r.money === 900 + back && r.info.won === back - 100 && r.info.lost === 0, `car #7 won: paid $${back}, bt.won ${back - 100}`, `${r.money} won ${r.info.won}`);
  else check(r.money === 900 && r.info.lost === 100 && r.info.won === 0, `car #${winner.num} won, not #7: the $100 is gone, bt.lost 100`, `${r.money} lost ${r.info.lost}`);
  check(r.info.hold === 0 && r.toasts.some((x) => /won|did not come in/.test(x)), 'nothing left held, and a toast told the result', r.toasts.join(' | '));
  console.log('NOTE  winner ' + JSON.stringify(winner) + ' ' + w.result);
}
await adv(18);
await run((X) => { X.G.hud.toast = X.G.hud.toast; });

// ── 6. Forced results ──
const forced = await run((X) => {
  const out = {};
  X.BT.wins.clear();
  X.S.save.data.best['bt.won'] = 0; X.S.save.data.best['bt.lost'] = 0;
  X.G.player.money = 1000;
  // A win.
  X.BT.openLocalDerby(5, 8);
  let w = X.BT.wins.get('derby:local');
  const mult = X.BT.multOf(w, 'a3');
  X.BT.place('derby:local', 'a3', 250);
  X.BT.derbyEnd(-1, 203);
  out.win = { money: X.G.player.money, expect: 750 + Math.floor(250 * mult), won: X.S.save.data.best['bt.won'], expectWon: Math.floor(250 * mult) - 250, state: w.state, hold: X.S.save.data.best['bt.hold'] };
  // A loss.
  X.BT.wins.clear();
  X.BT.openLocalDerby(6, 8);
  X.BT.place('derby:local', 'a1', 300);
  const before = X.G.player.money;
  X.BT.derbyEnd(-1, 205);
  out.loss = { money: X.G.player.money, before, lost: X.S.save.data.best['bt.lost'], hold: X.S.save.data.best['bt.hold'] };
  // Called off by the caller's word.
  X.BT.wins.clear();
  X.BT.openLocalDerby(7, 8);
  const m3 = X.G.player.money;
  X.BT.place('derby:local', 'a2', 40);
  X.BT.voidLocal('The derby was called off.');
  out.off = { m3, money: X.G.player.money, hold: X.S.save.data.best['bt.hold'] };
  // Stats persist in the save document.
  X.S.save.write();
  const doc = JSON.parse(localStorage.getItem('portcalamity.save.v1') ?? 'null');
  out.doc = doc && doc.best ? { won: doc.best['bt.won'], lost: doc.best['bt.lost'], n: doc.best['bt.n'] } : null;
  return out;
});
check(forced.win.money === forced.win.expect && forced.win.won === forced.win.expectWon && forced.win.state === 'settled' && forced.win.hold === 0, 'a win pays floor(stake x multiple) and counts in bt.won', JSON.stringify(forced.win));
check(forced.loss.money === forced.loss.before && forced.loss.lost === 300 && forced.loss.hold === 0, 'a loss costs the stake and counts in bt.lost', JSON.stringify(forced.loss));
check(forced.off.money === forced.off.m3 && forced.off.hold === 0, 'a called-off event refunds', JSON.stringify(forced.off));
check(!!forced.doc && forced.doc.won === forced.win.expectWon && forced.doc.lost === 300 && forced.doc.n >= 3, 'bt.won, bt.lost and bt.n are in the saved document', JSON.stringify(forced.doc));

console.log('ERRORS ' + JSON.stringify(t.errors));
check(t.errors.length === 0, 'no page errors');
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
