// Pictures of fast travel for the lead: scratch/travel/*.png. Desktop and phone (touch) layouts.
//   node tools/travel/shots.mjs
import { boot } from '../pw.mjs';

const OUT = 'scratch/travel/';
const dest = { name: 'Quorum Square', x: 131, z: -1808, nx: 0, nz: 1 };

async function session(mobile) {
  const tag = mobile ? 'phone' : 'desk';
  const t = await boot({ query: 'net=0&stage=4', mobile });
  await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(150); });
  await t.game((g) => { const G = g.game; G.player.money = 500; G.player.heat = 0; });
  // Open the map, pick a place from the list: the route card with the Travel button.
  await t.game((g) => {
    const G = g.game, td = G.todo, pl = td.places().find((p) => p.name.startsWith('Dunkless Donuts (North End)')) || td.places().find((p) => p.placed && p.z < -830);
    G.setPaused(true); td.menu.tab = 0; td.menu.setTab(0);
    const panel = td.menu.placesPanel; panel.refresh(); panel.pick(pl);
    if (g.game.input.touch) panel.el.classList.remove('fold');
    g.step(2);
  });
  await new Promise((r) => setTimeout(r, 600));
  await t.shot(`${OUT}${tag}-map-travel.png`);
  if (!mobile) {
    // The refusal on the same button: wanted.
    await t.game((g) => { g.game.player.heat = 2; g.game.todo.menu.placesPanel.refresh(); g.step(1); });
    await new Promise((r) => setTimeout(r, 300));
    await t.shot(`${OUT}desk-map-refused.png`);
    await t.game((g) => { g.game.player.heat = 0; g.game.todo.menu.placesPanel.refresh(); });
  }
  // Take the cab and photograph the card under black (phase 2), then the arrival.
  await t.game((g) => {
    const G = g.game, td = G.todo, p = td.menu.placesPanel, d = p.routeDest();
    td.travel.go(d);
    for (let i = 0; i < 40; i++) g.step(1);
  });
  await new Promise((r) => setTimeout(r, 300));
  await t.shot(`${OUT}${tag}-cab-card.png`);
  await t.game((g) => { const cab = g.game.todo.travel; for (let i = 0; cab.active && i < 600; i++) g.step(1); g.step(60); });
  await new Promise((r) => setTimeout(r, 1500));
  await t.game((g) => g.step(30));
  await t.shot(`${OUT}${tag}-arrived.png`);
  if (!mobile) {
    // The shortcut row in the pause menu.
    await t.game((g) => { const G = g.game; G.setPaused(true); G.todo.menu.setTab(1); g.step(2); });
    await new Promise((r) => setTimeout(r, 400));
    await t.shot(`${OUT}desk-pause-recent.png`);
  } else {
    await t.game((g) => { const G = g.game; G.setPaused(true); G.todo.menu.setTab(0); g.step(2); });
    await new Promise((r) => setTimeout(r, 400));
    await t.shot(`${OUT}phone-pause-recent.png`);
  }
  console.log(tag, 'errors:', t.errors.length ? t.errors.slice(0, 3) : 'none');
  await t.close();
}
await session(false);
await session(true);
void dest;
