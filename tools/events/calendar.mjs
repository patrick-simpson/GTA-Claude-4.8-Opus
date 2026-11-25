// Fun queue 2, item 19: unit check of the weekly calendar (src/game/eventCalendar.ts, pure): 28 days x 4 events. node tools/events/calendar.mjs
import { when, maine, countdown, EVENT_ORDER } from '../../src/game/eventCalendar.ts';
// 4 weeks from Mon 2026-11-23 12:00 ET: each event's weekday and the window.
const base = Date.UTC(2026, 10, 23, 17, 0, 0); // 12:00 ET Monday
const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let bad = 0;
for (let d = 0; d < 28; d++) {
  const ms = base + d * 86400000;
  const wd = maine(ms).wd;
  for (const id of EVENT_ORDER) {
    const w = when(id, ms, 19, 1 / 60, true);       // 7 pm on the game clock
    const want = { moose: 0, regatta: 3, derby: 5, fair: 6 }[id] === wd;
    if (w.open !== want) { bad++; console.log('FAIL', id, d, names[wd], w); }
  }
  // 1 am on the game clock: never open, and the next opening lands on the right weekday
  for (const id of EVENT_ORDER) {
    const w = when(id, ms, 1, 1 / 60, true);
    if (w.open) { bad++; console.log('FAIL open at 1am', id, d); }
    const at = new Date(ms + w.opensIn * 1000);
    const w2 = maine(ms + w.opensIn * 1000 + 1000).wd;
    if (w.opensIn === null || w2 !== { moose: 0, regatta: 3, derby: 5, fair: 6 }[id]) { bad++; console.log('FAIL next', id, d, names[wd], w, names[w2]); }
  }
}
console.log('fair off season:', JSON.stringify(when('fair', base, 19, 1/60, false)));
console.log('Wed 2026-11-25 8pm ET (regatta day), game 19h:', JSON.stringify(when('regatta', Date.UTC(2026,10,26,1,0,0), 19, 1/60, true)), countdown(when('regatta', Date.UTC(2026,10,26,1,0,0), 19, 1/60, true)));
console.log('Tue 2026-11-24 noon ET, game 5h:', countdown(when('regatta', Date.UTC(2026,10,24,17,0,0), 5, 1/60, true)), countdown(when('moose', Date.UTC(2026,10,24,17,0,0), 5, 1/60, true)));
console.log(bad ? 'CALENDAR FAIL ' + bad : 'CALENDAR OK (28 days x 4 events)');
process.exit(bad ? 1 : 0);
