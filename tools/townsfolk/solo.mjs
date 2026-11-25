// Townsfolk (fun queue 2, item 30), single player (net=0): src/game/townsfolk.ts, src/game/townsfolkData.ts, the Places "Townsfolk" chip.
//
//   node tools/townsfolk/solo.mjs [--shots]
//
// 1. Every person, every half hour of the day: standing or walking on dry ground outside every wall; standing is never in a road
//    lane; a walk crosses the paved road only briefly (a crossing, not a stroll down the middle). Every stop and every 0.5 m of
//    every leg is checked as well.
// 2. The same hour gives the same places on two page loads (nothing random, nothing saved), and a person is where the
//    pure schedule says in the running game.
// 3. Only people within range are real people; far ones cost nothing.
// 4. G beside a person gives the right line for the hour and the place (a stop, and on the move), a name tag shows close up,
//    and G is not used when driving.
// 5. The Places panel has a Townsfolk chip whose rows match where each person is now (and a waypoint on a tap).

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

async function open() {
  const t = await boot({ query: 'net=0&stage=4' + (process.env.TF_QUERY ? '&' + process.env.TF_QUERY : ''), width: 1100, height: 620 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(10); });
  await t.page.evaluate(`(async () => {
    const G = window.__game.game, P = await import('/src/world/plan.ts'), T = await import('/src/game/townsfolk.ts'), D = await import('/src/game/townsfolkData.ts');
    window.__tf = { G, P, T, D, F: G.todo.townsfolk, toasts: [] };
    const tt = G.hud.toast.bind(G.hud); G.hud.toast = (m, s) => { window.__tf.toasts.push(String(m)); return tt(m, s); };
  })()`);
  return t;
}

const t = await open();
const names = await t.game(() => window.__tf.T.FOLK.map((f) => f.id));
check(names.length === 12, 'twelve townsfolk', names.join(','));

// ── 1. Ground ──
{
  const r = await t.game(() => {
    const X = window.__tf, G = X.G, P = X.P, sg = G.plan.streets, F = X.F, bad = [], stats = { checked: 0, moving: 0, roadSamples: 0 };
    const wall = (x, z) => { const y = P.groundAt(x, z); return G.col.pointBlocked(x, z, y + 0.4) || G.col.pointBlocked(x, z, y + 1.0) || G.col.pointBlocked(x, z, y + 1.7); };
    const lane = (x, z) => { if (sg.clearOfRoads(x, z, 0.1)) return false; const n = sg.nearestEdge(x, z); return n.d < n.edge.hw + 0.1; };
    const why = (x, z, moving) => {
      const y = P.groundAt(x, z), w = [];
      if (P.isWater(x, z) || y < P.WATER_Y + 0.3) w.push('wet');
      if (wall(x, z)) w.push('in a wall');
      if (!moving && lane(x, z)) w.push('in a road lane');
      if (z > -900) w.push('not in Tepid Falls');
      return w.join(', ');
    };
    const road = {}, tot = {};
    for (const id of X.T.FOLK.map((f) => f.id)) {
      for (let h = 0; h < 24; h += 0.5) {
        const w = F.whereIs(id, h); stats.checked++;
        if (w.moving) stats.moving++;
        const m = why(w.x, w.z, w.moving);
        if (m) bad.push(`${id}@${h} ${m} (${w.x.toFixed(1)},${w.z.toFixed(1)})`);
      }
    }
    // Every 0.5 m of every leg: no walls or water; count the metres on the paved road.
    for (const rt of X.D.TF_ROUTES) {
      rt.legs.forEach((f, k) => {
        let roadM = 0, run = 0, longest = 0;
        for (let i = 0; i + 3 < f.length; i += 2) {
          const dx = f[i + 2] - f[i], dz = f[i + 3] - f[i + 1], L = Math.hypot(dx, dz), n = Math.max(1, Math.ceil(L / 0.5));
          for (let q = 0; q <= n; q++) {
            const x = f[i] + dx * q / n, z = f[i + 1] + dz * q / n, y = P.groundAt(x, z);
            if (P.isWater(x, z) || y < P.WATER_Y + 0.3 || wall(x, z)) { bad.push(`${rt.id} leg ${k} at ${x.toFixed(1)},${z.toFixed(1)} wall or water`); q = n; i = f.length; break; }
            if (lane(x, z)) { roadM += L / n; run += L / n; longest = Math.max(longest, run); } else run = 0;
          }
        }
        stats.roadSamples++;
        road[rt.id + k] = Math.round(longest); tot[rt.id + k] = Math.round(roadM);
      });
    }
    return { bad: bad.slice(0, 12), nbad: bad.length, stats, maxRoad: Math.max(...Object.values(road)), road: Object.entries(road).filter(([, v]) => v > 17).map(([k, v]) => k + '=' + v) };
  });
  check(r.nbad === 0, `all ${r.stats.checked} sampled positions (${r.stats.moving} walking) and every leg are on walkable ground, standing is never in a lane`, r.bad.join(' | '));
  check(r.maxRoad <= 32, 'no walk stays more than 32 m on the paved road at a time (a crossing, not a stroll)', `max ${r.maxRoad} m ${r.road.join(' ')}`);
}

// ── 2. The same hour, the same places ──
const HOURS = [0.3, 5.9, 7.77, 9.1, 12.4, 16.6, 19.05, 22.2];
const snap = (id, h) => `${id}@${h}`;
const readAll = async (tt) => tt.game((g, hs) => { const F = window.__tf.F, out = {}; for (const h of hs) for (const id of window.__tf.T.FOLK.map((f) => f.id)) { const w = F.whereIs(id, h); out[id + '@' + h] = [Math.round(w.x * 100) / 100, Math.round(w.z * 100) / 100, w.moving, w.stopId]; } return out; }, HOURS);
const first = await readAll(t);
// The running game agrees with the pure schedule: set the clock and look at the real people near them.
{
  const r = await t.game((g) => {
    const X = window.__tf, F = X.F; g.setTime(9.1); const w = F.whereIs('mabel', 9.1);
    g.teleport(w.x + 3, w.z + 3, 0); g.step(40);
    const p = X.G.people.list.find((q) => Math.hypot(q.x - w.x, q.z - w.z) < 2 && F.info().real.includes('mabel'));
    return { w, found: !!p, real: F.info().real };
  });
  check(r.found, 'at 9.1 h a real person stands where the schedule puts Mabel (within 2 m)', JSON.stringify(r.real));
}
await t.close();
const t2 = await open();
const second = await readAll(t2);
let diff = 0, first2 = '';
for (const k of Object.keys(first)) if (JSON.stringify(first[k]) !== JSON.stringify(second[k])) { diff++; if (!first2) first2 = k; }
check(diff === 0 && Object.keys(first).length === names.length * HOURS.length, `two page loads give the same place for all ${Object.keys(first).length} person-hours`, first2);
// ... and the day is not static: people move between hours.
let moved = 0; for (const id of names) if (first[snap(id, 7.77)][0] !== first[snap(id, 16.6)][0] || first[snap(id, 7.77)][1] !== first[snap(id, 16.6)][1]) moved++;
check(moved >= 10, 'people are in different places at 7:46 and 16:36', `${moved} of 12`);
// Mabel's sample: the shop at 6:30 am, the cafe area at 10.
{
  const r = await t2.game(() => { const F = window.__tf.F; return { a: F.whereIs('mabel', 6.5), b: F.whereIs('mabel', 9.6), c: F.whereIs('tamsin', 2), d: F.whereIs('tamsin', 12) }; });
  check(r.a.stopId === 'shop' && !r.a.moving, 'Mabel is at the bakery at 6:30', r.a.stopId);
  check(r.b.stopId === 'cafe', 'Mabel is at the cafe at 9:36', r.b.stopId);
  check(r.c.stopId === 'clinic' && r.d.stopId === 'home', 'Tamsin works the clinic at 2 am and is home at noon', `${r.c.stopId} ${r.d.stopId}`);
}

// ── 3. Cheap: only the near ones are real ──
{
  const r = await t2.game((g) => {
    const X = window.__tf, G = X.G; g.setTime(9.1);
    G.player.teleport(-60, -400, 0); g.step(30);                       // the island: nobody
    const far = X.F.info().real.length;
    const w = X.F.whereIs('mabel', 9.1);
    G.player.teleport(w.x, w.z + 40, 0); g.step(30);
    const near = X.F.info().real.slice();
    return { far, near };
  });
  check(r.far === 0, 'far from everyone (the island) nobody is a real person', String(r.far));
  check(r.near.includes('mabel') && r.near.length <= 6, 'near Mabel she is real and not everyone is', r.near.join(','));
}

// ── 4. G ──
async function greet(tt, id, hour, drive = false) {
  await tt.game((g, a) => {
    const X = window.__tf; g.setTime(a.hour); X.toasts.length = 0; X.F.last = null;
    const w = X.F.whereIs(a.id, a.hour);
    g.teleport(w.x + Math.sin(w.h) * 2, w.z + Math.cos(w.h) * 2, w.h + Math.PI); g.step(30);
    if (a.drive) { g.drive('sports'); g.step(5); }
  }, { id, hour, drive });
  const prompt = await tt.game(() => window.__tf.F.prompt);
  await tt.page.keyboard.press('KeyG', { delay: 70 });
  await tt.step(8);
  return tt.game((g, a) => { const X = window.__tf, f = X.T.FOLK.find((q) => q.id === a.id), w = X.F.whereIs(a.id, a.hour); return { toast: X.toasts.find((m) => m.startsWith(f.name + ':')) ?? '', last: X.F.last, want: X.T.lineFor(f, w.moving ? 'walk' : w.stopId, a.hour), prompt: window.__tf.F.prompt }; }, { id, hour }).then((r) => ({ ...r, prompt }));
}
{
  let r = await greet(t2, 'mabel', 6.5);
  check(/Greet Mabel Quince, Baker/.test(r.prompt ?? ''), 'standing by Mabel, the prompt offers G', r.prompt);
  check(r.toast.includes('rolls are out of the oven') && r.toast.includes(r.want), 'G at the bakery at 6:30 gives the morning line', r.toast.slice(0, 90));
  r = await greet(t2, 'mabel', 13);
  check(r.toast.includes('Afternoon rush'), 'G at the bakery at 1 pm gives the afternoon line', r.toast.slice(0, 90));
  r = await greet(t2, 'mabel', 8.5);
  check(r.toast.includes('dough does not know') && r.last && r.last.id === 'mabel', 'G on the move gives the walking line', r.toast.slice(0, 90));
  r = await greet(t2, 'tamsin', 2);
  check(r.toast.includes('Night shift'), 'G at the clinic at 2 am gives the night-shift line', r.toast.slice(0, 90));
  r = await greet(t2, 'tamsin', 12);
  check(r.toast.includes('I am off'), 'G at her home at noon gives the off-duty line', r.toast.slice(0, 90));
  r = await greet(t2, 'ambrose', 12);
  check(r.toast.includes('Mystery Meat'), 'G at the dining hall gives its line', r.toast.slice(0, 90));
  // Every person has at least two lines that are different and a fallback; all twelve answer at some hour.
  const each = await t2.game(() => { const X = window.__tf, out = []; for (const f of X.T.FOLK) { const set = new Set(); for (let h = 0; h < 24; h += 0.5) { const w = X.F.whereIs(f.id, h); set.add(X.T.lineFor(f, w.moving ? 'walk' : w.stopId, h)); } out.push(f.id + '=' + set.size); } return out; });
  check(each.every((s) => Number(s.split('=')[1]) >= 2 && Number(s.split('=')[1]) <= 8), 'each person has between 2 and 8 different lines over a day', each.join(' '));
  r = await greet(t2, 'gus', 7, true);
  check(r.toast === '' && (r.prompt ?? '') === '', 'no greeting (and no prompt) while driving', r.toast.slice(0, 60));
  await t2.game((g) => { g.walk?.(); window.__tf.G.player.exit?.(); });
  const tag = await t2.game(() => window.__tf.F.info());
  console.log('NOTE  info', JSON.stringify(tag));
}
// The tag: on foot near Gus.
{
  await t2.game((g) => { const X = window.__tf; X.G.player.exit?.(); g.setTime(7); const w = X.F.whereIs('gus', 7); g.teleport(w.x + 5, w.z, 0); g.step(40); });
  const near = await t2.game(() => window.__tf.F.info().tag);
  await t2.game((g) => { const X = window.__tf, w = X.F.whereIs('gus', 7); g.teleport(w.x + 60, w.z, 0); g.step(40); });
  const far = await t2.game(() => window.__tf.F.info().tag);
  check(near === true && far === false, 'a name tag shows within 14 m and not at 60 m', `${near} ${far}`);
}

// ── 5. Places ──
{
  await t2.game((g) => { const X = window.__tf; X.G.player.exit?.(); g.setTime(9.1); g.teleport(150, -2300, 0); g.step(10); X.G.todo.menu.tab = 0; X.G.setPaused(true); g.step(2); });
  const n = await t2.page.evaluate(`document.querySelectorAll('.pl-tfchip').length`);
  check(n === 1, 'the Places panel has a Townsfolk chip', String(n));
  const txt = await t2.page.evaluate(`(() => { const c = document.querySelector('.pl-tfchip'); if (!c) return ''; c.click(); return JSON.stringify([...document.querySelectorAll('.pl-list .pl-row')].map((r) => r.innerText)); })()`);
  const rows = JSON.parse(txt || '[]');
  const want = await t2.game(() => window.__tf.F.rows().map((r) => r.name + ' ' + r.role + ' ' + r.where));
  check(rows.length === 12 && want.every((w) => rows.some((r) => r.replace(/\s+/g, ' ').includes(w.split(' ')[0]) && r.replace(/\s+/g, ' ').includes(w.replace(/^.*?(at |walking)/, '$1').split(' · ')[0]))), 'the list has twelve rows that match where each person is right now', rows.slice(0, 2).join(' | ').replace(/\s+/g, ' '));
  const nearestFirst = await t2.game(() => { const rr = window.__tf.F.rows(); return rr.every((r, i) => i === 0 || rr[i - 1].dist <= r.dist); });
  check(nearestFirst, 'rows are nearest first');
  // The hour moves, the list follows.
  await t2.game((g) => { g.setTime(21); g.step(2); });
  const txt2 = await t2.page.evaluate(`(() => { document.querySelector('.pl-tfchip').click(); return [...document.querySelectorAll('.pl-list .pl-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')).join('|'); })()`);
  const mabel = txt2.split('|').find((r) => r.startsWith('Mabel')) ?? '';
  check(/at home|walking/.test(mabel), 'at 9 pm Mabel is listed at home or on her way', mabel);
  await t2.page.evaluate(`document.querySelector('.pl-list .pl-row').click()`);
  await t2.step(3);
  const wp = await t2.game(() => { const w = window.__tf.G.todo.waypoint; const rr = window.__tf.F.rows()[0]; return w ? Math.hypot(w.x - rr.x, w.z - rr.z) : -1; });
  check(wp >= 0 && wp < 40, 'tapping a row sets the waypoint at that person', String(wp));
  if (SHOTS) await t2.page.screenshot({ path: 'scratch/q2-30/shots/places.png' });
}

console.log(t2.errors.length ? 'ERRORS ' + JSON.stringify(t2.errors) : 'no page errors');
check(t2.errors.length === 0, 'no page errors');
await t2.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
