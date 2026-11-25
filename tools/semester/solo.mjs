// Fun queue 2, item 16: Semester check. node tools/semester/solo.mjs [dist] [--noshots] [--mobile]
//   - enrol at the Office of Admissions & Financial Ruin (G), fail one course (an F), then pass every course with at least a C;
//   - the Transcript, the GPA, the leaderboard row "Best GPA" and the save across a reload; pictures.
// Prints PASS/FAIL per check; exits 1 on a FAIL. Tests use net=0.
import { boot } from '../pw.mjs';
const SHOTS = !process.argv.includes('--noshots'), dist = process.argv.includes('dist'), mobile = process.argv.includes('--mobile');
let failed = 0;
const check = (ok, what, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${d ? '  [' + d + ']' : ''}`); if (!ok) failed++; };
const OUT = 'scratch/q2-16/shots/';
const opts = { query: 'net=0&stage=4', width: mobile ? 844 : 1280, height: mobile ? 390 : 720, dist };
if (mobile) opts.mobile = true;
const t = await boot(opts);
await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.stage(4); });
const sem = (f, a) => t.page.evaluate(`(${f.toString()})(window.__game.game.todo.semester, window.__game, ${JSON.stringify(a ?? null)})`);
const info = () => t.game((g) => g.game.todo.semester.info());
const key = async (k, ms = 4) => { await t.page.keyboard.down(k); await t.step(ms); await t.page.keyboard.up(k); await t.step(4); };
const tp = (x, z, h = 0) => t.game((g, a) => { g.teleport(a.x, a.z, a.h); }, { x, z, h });
const shot = async (n) => { if (SHOTS) await t.shot(OUT + n + '.png'); };
const clearView = () => t.game((g) => { g.game.view = null; }).catch(() => {});
const report = async () => (await info()).report;
const calm = async () => { await sem((s) => s.closeCard()); await t.step(60 * 6); await t.page.waitForTimeout(4000); };
const run = async (id) => { const ok = await sem((s, g, a) => s.start(a), id); await t.step(8); return ok; };
const goTarget = async () => { const q = await info(); if (q.target) await tp(q.target.x, q.target.z, 0); await t.step(8); };

// ── enrol ─────────────────────────────────────────────────────────────────────
let I = await info();
await tp(I.hub.x, I.hub.z + 2, Math.PI);
await t.step(40); await t.page.waitForTimeout(2500); await t.step(10);
await t.page.keyboard.press('KeyK'); await t.step(5);
const pr = await t.game((g) => g.game.hud.promptText);
check(typeof pr === 'string' && /Enrol/.test(pr), 'hub prompt offers enrolment', String(pr));
if (SHOTS) { await t.game((g) => { const p = g.game.player; g.view(p.x + 7, p.y + 3.4, p.z + 9, p.x, p.y + 4, p.z - 2); }); await t.step(3); await t.shot(OUT + 'hub_beam.png'); await clearView(); await t.step(3); }
check(!(await sem((s) => s.start(0))), 'cannot start a course before enrolling');
await key('KeyG', 4);
I = await info();
check(I.enrolled && I.card === 'catalogue', 'G enrols and opens the catalogue', JSON.stringify([I.enrolled, I.card]));
await t.step(3); await shot('enrol_catalogue');
await sem((s) => s.closeCard());
check(!(await sem((s) => s.start(1))), 'course 2 is locked before course 1 is passed');

// ── an F: the bell rings ──────────────────────────────────────────────────────
check(await run(0), 'start ENG 101');
await tp(I.hub.x, I.hub.z + 3, Math.PI);
await t.step(120);
I = await info(); check(I.run && I.run.id === 0 && I.run.t > 1, 'the run ticks', JSON.stringify(I.run));
if (SHOTS) await t.shot(OUT + 'late_hud.png');
await t.step(60 * 95);
I = await info();
check(!I.run && I.report && I.report.letter === 'F' && I.report.score === 0, 'standing still: the bell rings, an F', JSON.stringify(I.report));
check(!(await sem((s) => s.start(1))), 'an F does not open course 2');
await sem((s) => s.closeCard());
const best0 = await t.page.evaluate(async () => (await import('/src/game/save.ts')).save.data.best['sem.0']);
check(best0 === 0, 'the F is on the record', String(best0));

// ── ENG 101 again, passing ────────────────────────────────────────────────────
await run(0);
await tp(I.hub.x, I.hub.z + 3, Math.PI);
await t.step(60 * 6);
await goTarget(); await t.step(10);
let rp = await report();
check(rp && rp.id === 0 && rp.score >= 700, 'Late Assignment passed with at least a C', JSON.stringify(rp));
await sem((s) => s.closeCard());

// ── Mascot Containment ───────────────────────────────────────────────────────
await tp(I.hub.x, I.hub.z + 3, Math.PI);
await calm();
check(await run(1), 'start PHY ED 140');
I = await info();
const m0 = { ...I.mascot };
await t.step(60 * 3);
I = await info();
check(Math.hypot(I.mascot.x - m0.x, I.mascot.z - m0.z) > 6, 'the marmot runs away', `${Math.hypot(I.mascot.x - m0.x, I.mascot.z - m0.z).toFixed(1)} m in 3 s`);
if (SHOTS) {
  await t.game((g) => { const m = g.game.todo.semester.info().mascot; g.teleport(m.x + 12, m.z, -Math.PI / 2); g.step(3); });
  I = await info();
  const py = await t.game((g) => g.game.player.y);
  await t.game((g, a) => g.view(a.x + 7, a.y + 3.2, a.z + 7, a.x, a.y + 1.7, a.z), { x: I.mascot.x, y: py, z: I.mascot.z });
  await t.step(3); await t.shot(OUT + 'mascot_chase.png'); await clearView(); await t.step(3);
}
for (let k = 0; k < 40 && (await info()).run; k++) {
  await t.game((g) => { const m = g.game.todo.semester.info().mascot; if (m) g.teleport(m.x - 1.0, m.z, 0); });
  await t.step(12);
}
rp = await report();
check(rp && rp.id === 1 && rp.score >= 700, 'Mascot Containment passed (two tackles)', JSON.stringify(rp));
const tk = await t.game((g) => g.game.todo.semester.info().tackles);
check(tk >= 2, 'tackles counted', String(tk));
await sem((s) => s.closeCard());

// ── Overdue Run ──────────────────────────────────────────────────────────────
check(await run(2), 'start LIB 210');
I = await info();
for (const b of I.book) { await tp(b.x, b.z, 0); await t.step(6); }
I = await info(); check(I.run && I.run.got === 5, 'five books collected', String(I.run && I.run.got));
await goTarget(); await t.step(6);
rp = await report();
check(rp && rp.id === 2 && rp.score >= 700, 'Overdue Run passed', JSON.stringify(rp));
await sem((s) => s.closeCard());

// ── Lab Delivery ─────────────────────────────────────────────────────────────
await calm();
check(await run(3), 'start CHEM 220');
await goTarget();
I = await info();
check(I.run && I.run.gi === 1, 'Specimen 7 picked up at Smells & Bangs', JSON.stringify(I.run));
const s0 = I.run.stab;
await t.page.keyboard.down('ShiftLeft'); await t.page.keyboard.down('KeyW'); await t.step(90); await t.page.keyboard.up('KeyW'); await t.page.keyboard.up('ShiftLeft'); await t.step(10);
I = await info();
check(I.run && I.run.stab < s0 - 3, 'sprinting shakes Specimen 7', `${s0} -> ${I.run && I.run.stab}`);
if (SHOTS) {
  await t.game((g) => { const p = g.game.player; g.view(p.x + 2.6, p.y + 1.8, p.z + 3.2, p.x, p.y + 1.2, p.z); }); await t.step(3); await t.shot(OUT + 'lab_delivery.png'); await clearView(); await t.step(3);
}
for (let k = 0; k < 4 && (await info()).run; k++) await goTarget();
rp = await report();
check(rp && rp.id === 3 && rp.score >= 600, 'Lab Delivery passed (a D or better after the sprint)', JSON.stringify(rp));
await sem((s) => s.closeCard());
await calm();
check(await run(3), 'replay CHEM 220');
for (let k = 0; k < 5 && (await info()).run; k++) await goTarget();
const rp3 = await report();
check(rp3 && rp3.score >= 900, 'a gentle delivery earns an A', JSON.stringify(rp3));
await sem((s) => s.closeCard());

// ── Pond Survey ──────────────────────────────────────────────────────────────
await calm();
check(await run(4), 'start BIO 150');
I = await info(); check(I.geese === 8, 'the geese, Gerald and the swan are out', String(I.geese));
for (let i = 0; i < I.subjects.length; i++) {
  const s = I.subjects[i];
  await t.game((g, a) => {
    g.teleport(a.x + 14, a.z + 5, 0); g.step(30);
    g.game.cam.yaw = Math.atan2(a.x - g.game.player.x, a.z - g.game.player.z); g.game.cam.pitch = 0.0; g.step(40);
  }, s);
  if (SHOTS && i === 0) { await t.step(10); await t.shot(OUT + 'pond_geese.png'); await t.game((g, a) => { const py = g.game.player.y; g.view(a.x + 6, py + 1.8, a.z + 6, a.x, py + 0.5, a.z); }, s); await t.step(3); await t.shot(OUT + 'pond_geese_close.png'); await clearView(); await t.step(3); }
  await key('KeyG', 4);
  await t.step(6);
}
rp = await report();
if (!rp || rp.id !== 4) { I = await info(); console.log('pond state', JSON.stringify(I.run)); }
check(rp && rp.id === 4 && rp.score >= 600, 'Pond Survey passed (three field photos)', JSON.stringify(rp));
await sem((s) => s.closeCard());

// ── Homecoming Parade ────────────────────────────────────────────────────────
await calm();
check(await run(5), 'start HOM 300');
I = await info();
check(I.specs >= 16, 'spectators line the Loop', String(I.specs));
check(await t.game((g) => !!g.game.player.vehicle), 'the player is at the wheel of the float');
const loop = I.loop;
const place = (a, b) => t.game((g, q) => { const v = g.game.player.vehicle; v.x = q.a.x; v.z = q.a.z; v.h = Math.atan2(q.b.x - q.a.x, q.b.z - q.a.z); g.step(4); }, { a, b });
await place(loop[0], loop[1]);
await t.step(30);
I = await info(); check(I.run && I.run.gi === 1, 'the parade starts at the first gate', JSON.stringify(I.run));
if (SHOTS) { await t.game((g) => { const v = g.game.player.vehicle; g.view(v.x - Math.sin(v.h) * 9 + 4, v.y + 4, v.z - Math.cos(v.h) * 9, v.x, v.y + 1.4, v.z); }); await t.step(3); await t.shot(OUT + 'parade_float.png'); await clearView(); await t.step(3); }
// The float is carried along the Loop at 7 m/s in hops of one frame (a real drive is the player's own, by hand).
const drive = async (pts) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(len / (7 / 60));
    for (let k = 0; k < n; k += 3) await t.game((g, q) => { const v = g.game.player.vehicle; if (!v) return; const f = q.k / q.n; v.x = q.a.x + (q.b.x - q.a.x) * f; v.z = q.a.z + (q.b.z - q.a.z) * f; v.h = Math.atan2(q.b.x - q.a.x, q.b.z - q.a.z); v.vx = Math.sin(v.h) * 7; v.vz = Math.cos(v.h) * 7; g.step(3); }, { a, b, k, n });
  }
};
await drive(loop);
await t.step(20);
rp = await report();
check(rp && rp.id === 5 && rp.score >= 700, 'Homecoming Parade passed with no spectators hit', JSON.stringify(rp));
await sem((s) => s.closeCard());
await calm();
check(await run(5), 'replay HOM 300');
await place(loop[0], loop[1]); await t.step(30);
const sp0 = await t.game((g) => { const r = g.game.todo.semester.run; return r && r.specs[0] ? { x: r.specs[0].p.x, z: r.specs[0].p.z } : null; });
for (let k = 0; k < 24; k++) await t.game((g, a) => { const v = g.game.player.vehicle; v.x = a.x - 3 + a.k * 0.25; v.z = a.z; v.h = Math.PI / 2; v.vx = 4; v.vz = 0; g.step(2); }, { x: sp0.x, z: sp0.z, k });
I = await info();
check(I.run && I.run.hits >= 1, 'hitting a spectator is counted', JSON.stringify(I.run));
await sem((s) => s.drop('test'));
await sem((s) => s.closeCard());
// kid mode: spectators step aside and nothing counts
await t.page.evaluate(async () => { (await import('/src/core/kid.ts')).kid.set(true, null); });
check(await run(5), 'kid mode: replay HOM 300');
await place(loop[0], loop[1]); await t.step(30);
const sp1 = await t.game((g) => { const r = g.game.todo.semester.run; return r && r.specs[0] ? { x: r.specs[0].p.x, z: r.specs[0].p.z } : null; });
for (let k = 0; k < 24; k++) await t.game((g, a) => { const v = g.game.player.vehicle; v.x = a.x - 3 + a.k * 0.25; v.z = a.z; v.h = Math.PI / 2; v.vx = 4; v.vz = 0; g.step(2); }, { x: sp1.x, z: sp1.z, k });
I = await info();
const sp1b = await t.game((g) => { const r = g.game.todo.semester.run; return { x: r.specs[0].p.x, z: r.specs[0].p.z }; });
check(I.run && I.run.hits === 0 && Math.hypot(sp1b.x - sp1.x, sp1b.z - sp1.z) > 0.4, 'kid mode: spectators step aside, no hit counted', JSON.stringify([I.run && I.run.hits, +Math.hypot(sp1b.x - sp1.x, sp1b.z - sp1.z).toFixed(2)]));
await sem((s) => s.drop('test'));
await t.page.evaluate(async () => { (await import('/src/core/kid.ts')).kid.set(false, null); });
await sem((s) => s.closeCard());

// ── Finals ───────────────────────────────────────────────────────────────────
check(await run(6), 'start ALL 400');
await t.step(4);
if (SHOTS) await t.shot(OUT + 'finals_quiz.png');
for (let q = 0; q < 6; q++) {
  I = await info();
  if (I.card !== 'quiz') { check(false, 'quiz card is up', JSON.stringify(I.run)); break; }
  await t.game((g, a) => g.game.todo.semester.answer(a), I.run.qok);
  await t.page.waitForTimeout(1100); await t.step(4);
}
I = await info();
check(I.run && I.run.step === 1 && I.run.right === 6, 'six right answers, now the dash', JSON.stringify(I.run));
await goTarget(); await t.step(6);
rp = await report();
check(rp && rp.id === 6 && rp.score >= 900, 'Finals passed with an A', JSON.stringify(rp));
await sem((s) => s.closeCard());

// ── Graduation ───────────────────────────────────────────────────────────────
await calm();
check(await run(7), 'start GRAD 999');
await goTarget(); await t.step(60);
I = await info(); check(I.cine !== null && I.grads === 15, 'the ceremony begins, the class is in rows', JSON.stringify([I.cine, I.grads]));
await t.step(60 * 4);
if (SHOTS) { await t.page.waitForTimeout(800); await t.shot(OUT + 'grad_sweep.png'); }
await t.step(60 * 9.4);
if (SHOTS) { await t.page.waitForTimeout(500); await t.shot(OUT + 'grad_class_photo.png'); }
await t.step(60 * 3);
I = await info();
check(!I.run && I.card === 'diploma', 'the diploma card is up', JSON.stringify([I.card, I.report && I.report.letter]));
if (SHOTS) { await t.step(10); await t.shot(OUT + 'grad_diploma.png'); }
const gr = (await info()).report;
check(gr && gr.id === 7 && gr.score >= 600, 'Graduation passed', JSON.stringify(gr));
await sem((s) => s.closeCard());

// ── the record ───────────────────────────────────────────────────────────────
const fin = await t.page.evaluate(async () => {
  const d = await import('/src/game/semesterData.ts'), s = await import('/src/game/save.ts'), b = await import('/src/game/leaderboard.ts');
  window.__game.game.todo.saveNow();
  const pg = b.board.current.pages().find((p) => p.title === 'Best GPA');
  return { gpa: d.gpa(), passes: d.passes(), scores: d.COURSES.map((c) => d.scoreOf(c.id)), dean: d.deanList(), row: !!pg, mine: pg ? pg.mine : null, fmt: pg ? pg.fmt(pg.mine || 0) : '', ncat: b.CATEGORIES.length, keep: Object.fromEntries(Object.entries(s.save.data.best).filter(([k]) => k.startsWith('sem.'))), counts: Object.fromEntries(Object.entries(s.save.data.counts).filter(([k]) => k.startsWith('sem.'))) };
});
check(fin.passes === 8, 'all eight courses passed', JSON.stringify(fin.scores));
check(fin.scores.every((x) => x >= 700), 'every course at least a C', JSON.stringify(fin.scores));
check(fin.gpa > 3 && fin.row && fin.mine === Math.round(fin.gpa * 100), 'leaderboard row "Best GPA"', JSON.stringify({ gpa: fin.gpa, row: fin.row, mine: fin.mine, fmt: fin.fmt, ncat: fin.ncat }));
check(fin.dean && fin.counts['sem.dean'] === 1, "Dean's List shown once", JSON.stringify(fin.counts));
if (SHOTS) {
  await t.game((g) => { g.game.todo.menu.tab = 1; g.game.setPaused(true); }).catch(() => {});
  await t.step(6);
  await t.page.evaluate(() => { const el = [...document.querySelectorAll('.mn-sec h3')].find((h) => /Transcript/.test(h.textContent)); if (el) el.scrollIntoView({ block: 'start' }); });
  await t.step(2); await t.shot(OUT + 'transcript.png');
  await t.game((g) => g.game.setPaused(false)).catch(() => {});
}
await t.page.reload();
await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 120000 }).catch(() => {});
await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
const after = await t.page.evaluate(async () => { const s = await import('/src/game/save.ts'), d = await import('/src/game/semesterData.ts'); return { best: Object.fromEntries(Object.entries(s.save.data.best).filter(([k]) => k.startsWith('sem.'))), gpa: d.gpa(), enrol: d.enrolled() }; });
check(JSON.stringify(after.best) === JSON.stringify(fin.keep) && after.enrol && Math.abs(after.gpa - fin.gpa) < 1e-9, 'transcript and save persist across a reload', `gpa ${after.gpa.toFixed(2)}`);
console.log('errors:', JSON.stringify(t.errors).slice(0, 400));
check(!t.errors.length, 'no page errors');
await t.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
