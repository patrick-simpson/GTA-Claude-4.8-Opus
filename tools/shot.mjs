// One-line screenshots of the running game.
//
//   node tools/shot.mjs shots/a.png --at -30,285,1.57 --hour 14
//   node tools/shot.mjs shots/b.png --view 200,160,520,0,0,100 --hour 21 --weather rain
//   node tools/shot.mjs shots/c.png --drive sports --keys KeyW --steps 240
//   node tools/shot.mjs shots/d.png --title            (leave the title card up)
//   node tools/shot.mjs shots/e.png --mobile --dist    (phone layout, production build)
//
// --at x,z[,h]      teleport the player           --hour H        time of day (0-24)
// --view x,y,z,tx,ty,tz  pin the camera           --weather W     clear|overcast|fog|rain
// --drive [kind]    put the player in a vehicle   --keys A,B      hold these key codes while stepping
// --steps N         simulate N frames first (default 30)          --query q=low
// --wait MS         wait MS real milliseconds (after the teleport and steps) before the picture, so the Blender
//                   models have arrived. WITHOUT it the picture is taken at once, with no real time passing, and
//                   can show the box people and blocky cars that stand in until the models load.
// Prints the game's info() and any console errors; exits 1 if there were errors.

import { boot } from './pw.mjs';

const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args.shift() : 'shots/shot.png';
const opt = {};
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  opt[k] = v;
}
const nums = (s) => String(s).split(',').map(Number);

const t = await boot({ mobile: !!opt.mobile, dist: !!opt.dist, start: !opt.title, query: typeof opt.query === 'string' ? opt.query : '' });
try {
  if (!opt.title && !t.errors.length) {
    if (opt.hour !== undefined) await t.game((g, h) => g.setTime(h), Number(opt.hour));
    if (typeof opt.weather === 'string') await t.game((g, w) => g.setWeather(w), opt.weather);
    if (opt.at) await t.game((g, a) => g.teleport(a[0], a[1], a[2] ?? 0), nums(opt.at));
    if (opt.drive) await t.game((g, k) => g.drive(k || undefined), opt.drive === true ? null : opt.drive);
    const keys = typeof opt.keys === 'string' ? opt.keys.split(',') : [];
    for (const k of keys) await t.page.keyboard.down(k);
    await t.step(Number(opt.steps ?? 30));
    for (const k of keys) await t.page.keyboard.up(k);
    if (opt.wait) { await t.page.waitForTimeout(Number(opt.wait)); await t.step(2); }
    if (opt.view) { await t.game((g, a) => g.view(...a), nums(opt.view)); await t.step(1); }
  } else {
    await t.page.waitForTimeout(600);
  }
  const file = await t.shot(out);
  const info = opt.title ? {} : await t.info().catch(() => ({}));
  console.log(JSON.stringify({ file, info, errors: t.errors }, null, 1));
} finally {
  await t.close();
}
process.exit(t.errors.length ? 1 : 0);
