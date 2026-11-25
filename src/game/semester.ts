// The Semester (fun queue 2, item 16): Dithers College as a run of short, replayable campus missions.
//
//   enrol     the cream beam by Fumble House is the Office of Admissions & Financial Ruin. G: enrol (tuition: deferred, forever), and
//             after that G opens the Course Catalogue: eight courses, each unlocked by passing the one before.
//   courses   0 Late Assignment    an essay to Professor Shrug before the bell (on foot, or on a campus bike)
//             1 Mascot Containment Maybe the Marmot (a costumed runner) has the Provost's mortarboard: chase and tackle him, twice
//             2 Overdue Run        five books from five dorms back to the Overdue Library before it closes
//             3 Lab Delivery       Specimen 7 from Smells & Bangs to Squishy Things the long way: it jiggles, don't jog like a fool
//             4 Pond Survey        photograph the geese, Gerald and the swan at Johnson Pond (G for a field photo, or photo mode)
//             5 Homecoming Parade  the float, slowly, along Dithers Loop, past spectators who are not part of the route
//             6 Finals             six funny questions about the town, then a dash to hand the paper in at the Registrar
//             7 Graduation         at the Chapel of Second Thoughts: a ceremony, the Class of 2026 photograph, a diploma
//   grades    a score of 0..1000 per course from time and quality: A 900, B 800, C 700, D 600; under 600 is an F (also the clock
//             running out). A D passes. The best score of each course is kept (game/semesterData.ts); the GPA is the mean grade
//             point of every course tried; GPA 3.5 after three passes earns a Dean's List toast. The Transcript is Section J of
//             the pause menu's Progress page, and "Best GPA" is a leaderboard row.
//
// Personal: nothing goes over the wire (no protocol change); other players just see someone running about. The marmot, geese,
// spectators and float are this browser's own. Kid mode: a tackle is a hug, spectators hop out of the way and cost nothing.
// R drops the course you are in. Test hooks: info(), answer(i), `Semester.auto`.

import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Look, Person, Vehicle } from '../core/api';
import type { Blip } from '../ui/hud';
import { groundAt } from '../world/plan';
import { campusFree } from '../world/dithersPlan';
import { POND_LEVEL } from '../world/dithersPond';
import { kid } from '../core/kid';
import { isCycleKind } from '../ent/vehicleSpecs';
import { save } from './save';
import { clock, type Markers, type Pt } from './script';
import { COURSES, NCOURSES, QUESTIONS, deanList, enrolled, gpa, gpaText, gradeOf, passed, passes, scoreOf, timeScore, unlocked, PASS, type Question } from './semesterData';

const HUB: Pt = { x: -354.5, z: -2362.5 };
const QUAD: Pt = { x: -428, z: -2388 };

// Where things are (building centres from world/dithersPlan.ts; the doors are found at run time on the open ground beside them).
const SHRUG: Pt = { x: -392, z: -2251.1 };
const LIBRARY: Pt = { x: -473.1, z: -2424.9 };
const CHAPEL: Pt = { x: -472, z: -2334.4 };
/** The Chapel's steps face this way (the portico is the second rect of the building, toward +x +z); the class stands 22 m out. */
const CHAPEL_FRONT: Pt = { x: -465, z: -2308 };
const PORTICO: Pt = { x: -464.9, z: -2324.2 };
const SMELLS: Pt = { x: -433.3, z: -2439.2 };
const SQUISHY: Pt = { x: -415.9, z: -2433 };
const HEAPING: Pt = { x: -427.3, z: -2362.1 };
const REBUTTAL: Pt = { x: -462.8, z: -2534.7 };
const DORMS: { name: string; at: Pt }[] = [
  { name: 'Doting Apartments', at: { x: -517.7, z: -2308.6 } }, { name: 'Craving Hall', at: { x: -479.9, z: -2396.6 } },
  { name: 'Ponder Hall 1', at: { x: -509.9, z: -2408.4 } }, { name: 'Ponder Hall 2', at: { x: -509.5, z: -2449 } },
  { name: 'The Hesitant Heights', at: { x: -475.4, z: -2279.8 } },
];
/** The Loop, east end to west end (streetData.ts: Dithers Loop), with gates on the long last leg. */
const LOOP: Pt[] = [
  { x: -299.4, z: -2576.2 }, { x: -313.4, z: -2594.6 }, { x: -348, z: -2617.3 }, { x: -371.2, z: -2623.3 }, { x: -411.4, z: -2623.6 }, { x: -443.9, z: -2613.2 },
  { x: -479.9, z: -2583.2 }, { x: -515.9, z: -2553.1 }, { x: -551.9, z: -2523 }, { x: -587.9, z: -2492.8 },
];
/** The geese, Gerald and the swan: shore points of Johnson Pond (the pond's outline is in dithersPlan.ts CAMPUS_POND). */
const SUBJECTS: { name: string; at: Pt; n: number; swim: boolean }[] = [
  { name: 'the geese', at: { x: -541, z: -2518 }, n: 6, swim: false },
  { name: 'Gerald', at: { x: -572.5, z: -2471 }, n: 1, swim: false },
  { name: 'the swan', at: { x: -548, z: -2482 }, n: 1, swim: true },
];

const free = (x: number, z: number, m = 2): boolean => campusFree(x, z, m);
const near = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);
const cache = new Map<string, Pt>();
/** The open ground beside a building, on the side nearest `from`. */
function freeNear(c: Pt, from: Pt, r0 = 6, r1 = 18): Pt {
  const key = `${c.x},${c.z},${from.x >> 3},${from.z >> 3}`, hit = cache.get(key);
  if (hit) return hit;
  let best: Pt | null = null, bd = 1e9;
  for (let r = r0; r <= r1; r += 2) for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2, x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
    if (!free(x, z, 2.4)) continue;
    const d = Math.hypot(x - from.x, z - from.z) + r * 3;
    if (d < bd) { bd = d; best = { x: +x.toFixed(1), z: +z.toFixed(1) }; }
  }
  const out = best ?? c;
  cache.set(key, out);
  return out;
}

const LINES = {
  A: ['Straight As. The Provost wants to know what you did to the curve.', 'Exceptional. Suspiciously so.', 'An A. We will need to see the paperwork on that.'],
  B: ['A solid B. Nobody gets hurt by a B.', 'Good work. Not good enough to be annoying.'],
  C: ['A C. The C stands for Completed.', 'Passing is a kind of winning, if you squint.'],
  D: ['A D. D is for Diploma, in the right light.', 'Barely. But barely is a tense, and you are in it.'],
  F: ['An F. The professor would like a word, and then another.', 'Incomplete. The college will remember this fondly.', 'F. It does not have to be the end. It is the end of this attempt.'],
};
const pickLine = (letter: string, n: number): string => { const a = LINES[letter as 'A'] ?? LINES.F; return a[n % a.length]; };

const CSS = `
#semester { position: fixed; left: 0; right: 0; top: 0; bottom: 0; z-index: 31; pointer-events: none; font-family: var(--f-head, system-ui, sans-serif); color: #14213d; }
#semester .sm-card { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); width: min(94vw, 33em); max-height: 88vh; overflow-y: auto; background: #f2e8cf; border: 3px solid #14213d; box-shadow: 4px 4px 0 #14213d; padding: 0.8em 1em 1em; display: none; pointer-events: auto; }
#semester .sm-card.on { display: block; }
#semester .sm-card h2 { margin: 0 0 0.2em; font-size: 1.15em; letter-spacing: 0.06em; text-transform: uppercase; }
#semester .sm-card h2 small { display: block; font-size: 0.6em; letter-spacing: 0.1em; color: #e4572e; }
#semester .sm-card p { margin: 0.4em 0; font-size: 0.88em; line-height: 1.3; }
#semester .sm-row { display: flex; align-items: center; gap: 0.6em; padding: 0.35em 0; border-top: 1px dashed rgba(20, 33, 61, 0.35); font-size: 0.85em; }
#semester .sm-row.lock { opacity: 0.45; }
#semester .sm-row .sm-n { flex: 1; line-height: 1.2; }
#semester .sm-row .sm-n i { display: block; font-style: normal; font-size: 0.82em; opacity: 0.75; }
#semester .sm-g { font: 800 1.15em var(--f-mono, monospace); min-width: 1.4em; text-align: center; }
#semester .sm-A { color: #2a9d8f; } #semester .sm-B { color: #4a8f3a; } #semester .sm-C { color: #b8860b; } #semester .sm-D { color: #d9822b; } #semester .sm-F { color: #e4572e; }
#semester button { font: 800 0.85em var(--f-head, system-ui, sans-serif); border: 2px solid #14213d; background: #2a9d8f; color: #fff; box-shadow: 2px 2px 0 #14213d; padding: 0.4em 0.8em; pointer-events: auto; }
#semester button.alt { background: #14213d; }
#semester button:disabled { opacity: 0.3; }
#semester .sm-big { font: 800 4.2em var(--f-mono, monospace); line-height: 1; text-align: center; }
#semester .sm-q button { display: block; width: 100%; text-align: left; margin: 0.35em 0; background: #fff8e6; color: #14213d; font-weight: 700; }
#semester .sm-q button.right { background: #2a9d8f; color: #fff; } #semester .sm-q button.wrong { background: #e4572e; color: #fff; }
#semester .sm-meter { position: absolute; left: 50%; bottom: calc(24vh); transform: translateX(-50%); width: min(70vw, 22em); display: none; text-align: center; font-weight: 800; font-size: 0.85em; }
#semester .sm-meter.on { display: block; }
#semester .sm-meter .sm-bar { height: 1.2em; border: 2px solid #14213d; background: #f2e8cf; box-shadow: 2px 2px 0 #14213d; margin-top: 0.2em; overflow: hidden; }
#semester .sm-meter .sm-bar i { display: block; height: 100%; background: #6bd13a; transition: width 0.12s; }
#semester .sm-bars { position: absolute; inset: 0; display: none; }
#semester .sm-bars.on { display: block; }
#semester .sm-bars::before, #semester .sm-bars::after { content: ''; position: absolute; left: 0; right: 0; height: 11vh; background: #000; }
#semester .sm-bars::before { top: 0; } #semester .sm-bars::after { bottom: 0; }
#semester .sm-cap { position: absolute; left: 50%; bottom: 14vh; transform: translateX(-50%); color: #f2e8cf; font-weight: 800; font-size: 1.15em; text-align: center; max-width: 80vw; text-shadow: 1px 1px 3px #000; z-index: 2; }
#semester .sm-flash { position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity 0.5s; }
#semester .sm-dip { border: 4px double #14213d; padding: 0.8em; text-align: center; background: #fffaf0; }
#semester .sm-dip b { font-size: 1.3em; }
@media (max-width: 720px) { #semester .sm-meter { bottom: 30vh; } }
`;

interface Mascot { p: Person; head: THREE.Group; x: number; z: number; h: number; downT: number; burstT: number; burst: number; steerT: number; ang: number }
interface Goose { g: THREE.Group; c: Pt; ph: number; swim: boolean }
interface Spec { p: Person; x: number; z: number; hitT: number; hopT: number; hx: number; hz: number }

interface Run {
  id: number; t: number; step: number; lim: number;
  target: Pt | null; targetName: string | null;
  // 0
  // 1
  mascot?: Mascot; tackles?: number;
  // 2
  books?: { at: Pt; got: boolean; name: string }[];
  // 3
  stab?: number; gates?: Pt[]; gi?: number; wasAir?: boolean; bumps?: number;
  // 4
  shots?: boolean[]; framing?: number[]; saved0?: number;
  // 5
  float?: Vehicle; hits?: number; strikes?: number; over?: number; gi5?: number; started?: number; specs?: Spec[];
  // 6
  qs?: Question[]; qi?: number; right?: number; quizScore?: number;
}

export class Semester {
  prompt: string | null = null;
  target: Pt | null = null;
  targetName: string | null = null;
  /** Test hook: the float is driven along the Loop for the test (a real drive is done by hand). */
  auto = false;
  readonly stats = { runs: 0, passes: 0, fails: 0, tackles: 0, photos: 0, hits: 0 };
  run: Run | null = null;

  private root!: HTMLElement;
  private card!: HTMLElement;
  private meter!: HTMLElement; private meterTx!: HTMLElement; private meterBar!: HTMLElement;
  private bars!: HTMLElement; private cap!: HTMLElement; private flash!: HTMLElement;
  private cardKind: 'none' | 'catalogue' | 'report' | 'quiz' | 'diploma' = 'none';
  private cardT = 0;
  private kinds = 0;
  private jelly: THREE.Group | null = null;
  private floatDeco: THREE.Group | null = null;
  private geese: Goose[] = [];
  private grads: Person[] = [];
  private gradT = 0;
  private cine: { t: number; beat: number; f: Pt; d: Pt } | null = null;
  private savedSaved = 0;
  private lastReport: { id: number; score: number; letter: string; gpa: string; line: string; fresh: boolean } | null = null;
  private lastShots = 0;
  private readonly ray = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private hitCool = 0;
  private wasAirP = false;

  constructor(private readonly game: Game, private readonly markers: Markers, private readonly isFree: () => boolean, private readonly setBusy: (id: string | null) => void) {
    try { this.buildUi(); } catch (e) { console.warn('semester: no ui', e); }
    game.on('booked', () => { if (this.run) this.drop('The Harbor Patrol has dismissed you from class.'); });
    game.on('impact', (e) => {
      const r = this.run, pv = game.player.vehicle;
      if (!r || r.id !== 3 || !pv || e.speed < 3 || (e.vehicle !== pv && e.other !== pv) || this.hitCool > 0) return;
      this.hitCool = 0.7;
      this.shake(Math.min(40, 6 + e.speed * 2.2), 'A bump. Specimen 7 said something rude.');
    });
    addEventListener('keydown', (e) => this.key(e), true);
  }

  get busy(): boolean { return this.run !== null; }

  // ── the UI ────────────────────────────────────────────────────────────────────

  private buildUi(): void {
    const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
    const root = this.root = document.createElement('div'); root.id = 'semester';
    root.innerHTML = '<div class="sm-bars"></div><div class="sm-flash"></div><div class="sm-cap"></div><div class="sm-meter"><span></span><div class="sm-bar"><i></i></div></div><div class="sm-card"></div>';
    document.body.append(root);
    this.card = root.querySelector('.sm-card') as HTMLElement;
    this.meter = root.querySelector('.sm-meter') as HTMLElement;
    this.meterTx = this.meter.querySelector('span') as HTMLElement;
    this.meterBar = this.meter.querySelector('i') as HTMLElement;
    this.bars = root.querySelector('.sm-bars') as HTMLElement;
    this.cap = root.querySelector('.sm-cap') as HTMLElement;
    this.flash = root.querySelector('.sm-flash') as HTMLElement;
    this.card.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      const a = b.dataset.a ?? '';
      if (a === 'enrol') this.enrol();
      else if (a === 'close') this.closeCard();
      else if (a === 'start') this.start(Number(b.dataset.i));
      else if (a === 'ans') this.answer(Number(b.dataset.i));
    });
  }

  private key(e: KeyboardEvent): void {
    if (this.cardKind === 'none' || e.repeat) return;
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (e.code === 'Escape' && this.cardKind !== 'quiz') { this.closeCard(); e.stopImmediatePropagation(); e.preventDefault(); return; }
    if (!m) return;
    const n = Number(m[1]) - 1;
    if (this.cardKind === 'quiz') this.answer(n);
    else if (this.cardKind === 'catalogue') this.start(n);
    else return;
    e.stopImmediatePropagation(); e.preventDefault();
  }

  private showCard(kind: 'catalogue' | 'report' | 'quiz' | 'diploma', html: string, secs = 0): void {
    this.card.innerHTML = html; this.card.classList.add('on'); this.cardKind = kind; this.cardT = secs;
  }
  closeCard(): void { this.card.classList.remove('on'); this.cardKind = 'none'; this.cardT = 0; }

  private meterOn(on: boolean, tx = '', pct = 100, col = '#6bd13a'): void {
    this.meter.classList.toggle('on', on);
    if (!on) return;
    this.meterTx.textContent = tx; this.meterBar.style.width = Math.max(0, Math.min(100, pct)).toFixed(0) + '%'; this.meterBar.style.background = col;
  }

  // ── the hub ───────────────────────────────────────────────────────────────────

  private enrol(): void {
    if (enrolled()) { this.openCatalogue(); return; }
    save.bump('sem.enrol');
    save.write();
    this.game.hud.stamp('ENROLLED', 'Tuition deferred, forever');
    this.game.hud.toast('Welcome to Dithers College. Your tuition has been deferred, which the Office of Admissions & Financial Ruin says is the most beautiful word in the language. Eight courses; pass one to open the next.', 9);
    this.openCatalogue();
  }

  openCatalogue(): void {
    const rows = COURSES.map((c) => {
      const s = scoreOf(c.id), open = unlocked(c.id), g = s === null ? '' : gradeOf(s).letter;
      return `<div class="sm-row ${open ? '' : 'lock'}"><span class="sm-g sm-${g}">${g || (open ? '·' : '🔒')}</span><span class="sm-n"><b>${c.code} · ${c.name}</b><i>${open ? c.blurb : 'Locked: pass the course before.'}</i></span><button data-a="start" data-i="${c.id}" ${open ? '' : 'disabled'}>${s === null ? 'Start' : 'Retake'} ${c.id + 1}</button></div>`;
    }).join('');
    this.showCard('catalogue', `<h2><small>Dithers College · Office of Admissions &amp; Financial Ruin</small>Course Catalogue</h2><p>GPA <b>${gpaText()}</b> · ${passes()} of ${NCOURSES} passed${deanList() ? " · <b>Dean's List</b>" : ''}. Press 1-8 or click. Esc to leave.</p>${rows}<p style="text-align:right"><button class="alt" data-a="close">Close</button></p>`);
  }

  // ── starting and ending ───────────────────────────────────────────────────────

  /** Start course `id` from the catalogue. */
  start(id: number): boolean {
    const g = this.game, p = g.player;
    if (this.run || !this.isFree() || !(p.health > 0) || !Number.isInteger(id) || id < 0 || id >= NCOURSES) return false;
    if (!enrolled() || !unlocked(id)) return false;
    this.closeCard();
    const from: Pt = { x: p.x, z: p.z };
    const r: Run = { id, t: 0, step: 0, lim: 120, target: null, targetName: null };
    this.run = r; this.stats.runs++; save.bump('sem.runs');
    this.setBusy('semester');
    const c = COURSES[id], hud = g.hud;
    switch (id) {
      case 0: {
        r.lim = 90; r.target = freeNear(SHRUG, from, 6, 14); r.targetName = 'Professor Shrug, Shrug Hall';
        hud.toast('ENG 101: your essay is due at Shrug Hall. It was due a while ago. The bell is a clock that does not care. On foot or on a bike; sprint if you have the legs.', 8);
        break;
      }
      case 1: {
        r.lim = 200; r.tackles = 0; r.target = null;
        const s = freeNear({ x: -412, z: -2392 }, from, 8, 20);
        this.mkMascot(r, s);
        hud.toast("PHY ED 140: Maybe the Marmot, the college mascot, has taken the Provost's mortarboard and is running about the quad. Catch him on foot or by bike, and tackle him. Gently.", 8);
        break;
      }
      case 2: {
        r.lim = 240;
        r.books = DORMS.map((d) => ({ at: freeNear(d.at, from, 7, 18), got: false, name: d.name }));
        hud.toast('LIB 210: five overdue books are out in the dorms. Collect them all and bring them to the Overdue Library before it closes. The fine is already enormous.', 8);
        break;
      }
      case 3: {
        r.lim = 300; r.stab = 100; r.bumps = 0; r.gi = 0;
        const door = freeNear(SMELLS, from, 5, 14);
        r.gates = [freeNear(CHAPEL, door, 8, 18), freeNear(HEAPING, CHAPEL, 12, 24), freeNear(SQUISHY, HEAPING, 6, 14)];
        r.target = door; r.targetName = 'Smells & Bangs, front door';
        this.buildJelly();
        hud.toast('CHEM 220: take Specimen 7 from Smells & Bangs to Squishy Things the long way round (the direct door is closed for reasons). Jog, do not sprint, do not jump, do not fall. It jiggles.', 9);
        break;
      }
      case 4: {
        r.lim = 270; r.shots = SUBJECTS.map(() => false); r.framing = []; r.saved0 = g.photo.stats.saved; this.savedSaved = r.saved0; this.lastShots = 0;
        this.spawnGeese();
        r.target = freeNear({ x: -565, z: -2486 }, from, 3, 12); r.targetName = 'Johnson Pond';
        hud.toast('BIO 150: photograph the geese, Gerald and the swan at Johnson Pond. G is a field photo toward where the camera looks; photo mode (O, then Save photo) counts too. Centre them for a better grade.', 9);
        break;
      }
      case 5: {
        r.lim = 330; r.hits = 0; r.strikes = 0; r.over = 0; r.gi5 = 0; r.started = -1;
        const at = freeNear(HUB, from, 6, 14);
        const h = Math.atan2(LOOP[0].x - at.x, LOOP[0].z - at.z);
        const v = g.vehicles.spawn('pickup', at.x, at.z, h, 0xf0a202);
        v.held = true; r.float = v;
        this.buildFloat();
        if (p.vehicle) p.exit();
        p.enter(v, true);
        this.spawnSpectators(r);
        r.target = LOOP[0]; r.targetName = 'the start of the parade, Dithers Loop';
        hud.toast('HOM 300: you are driving the Homecoming float. Take it to the start of the parade on Dithers Loop, then go SLOWLY (under 20 mph) past every gate, and do not hit the spectators. They are lined up on both sides.', 10);
        break;
      }
      case 6: {
        r.lim = 140; r.step = 0; r.qi = 0; r.right = 0;
        const pool = QUESTIONS.map((q, i) => ({ q, k: Math.sin((save.count('sem.runs') + 1) * 12.9898 + i * 78.233) })).sort((a, b) => a.k - b.k).slice(0, 6).map((o) => o.q);
        r.qs = pool;
        this.askQuestion();
        hud.toast('ALL 400: six questions about the town. Press 1-4. There is no penalty for being wrong, only for being right slowly.', 7);
        break;
      }
      case 7: {
        r.lim = 240;
        r.target = freeNear(CHAPEL_FRONT, from, 0, 6); r.targetName = 'the Chapel of Second Thoughts';
        hud.toast('GRAD 999: the Class of 2026 is gathering at the Chapel of Second Thoughts. Make your way there. Wear the hat.', 7);
        break;
      }
    }
    void c;
    this.target = r.target; this.targetName = r.targetName;
    return true;
  }

  /** The end of a run: file the score, show the report card, give the floor back. */
  private finish(score: number, note: string): void {
    const r = this.run; if (!r) return;
    const g = this.game, id = r.id;
    score = Math.max(0, Math.min(1000, Math.round(score)));
    const before = scoreOf(id), fresh = save.record('sem.' + id, score, false);
    const gr = gradeOf(score), ok = score >= PASS;
    if (ok) this.stats.passes++; else this.stats.fails++;
    const opened = ok && before === null || (before !== null && before < PASS && ok);
    this.cleanup();
    this.run = null; this.target = null; this.targetName = null;
    g.hud.objective(null); g.hud.timer(null); this.meterOn(false);
    this.setBusy(null);
    const line = pickLine(gr.letter, save.count('sem.runs'));
    this.lastReport = { id, score, letter: gr.letter, gpa: gpaText(), line, fresh };
    const next = id + 1 < NCOURSES && ok && opened ? `<p><b>Next:</b> ${COURSES[id + 1].code} ${COURSES[id + 1].name} is open.</p>` : '';
    this.showCard('report', `<h2><small>${COURSES[id].code} · Report card</small>${COURSES[id].name}</h2><div class="sm-big sm-${gr.letter}">${gr.letter}</div><p style="text-align:center"><b>${Math.round(score / 10)}%</b>${fresh && before !== null ? ' · new best' : ''} · GPA <b>${gpaText()}</b></p><p>${note}</p><p><i>${line}</i></p>${next}<p style="text-align:right"><button data-a="start" data-i="${id}" ${id === NCOURSES - 1 && ok ? 'disabled' : ''}>Retake</button> <button class="alt" data-a="close">Close</button></p>`, 14);
    save.write();
    if (!ok) g.hud.stamp('INCOMPLETE', COURSES[id].name);
    else if (id < NCOURSES - 1) g.hud.stamp(`GRADE: ${gr.letter}`, COURSES[id].name);
    if (deanList() && save.count('sem.dean') === 0) {
      save.bump('sem.dean');
      g.hud.toast(`DEAN'S LIST. GPA ${gpa().toFixed(2)} after ${passes()} courses. The Provost has been told, and has lost the letter.`, 9);
      save.write();
    }
  }

  /** Drop the course in hand with nothing filed (R, a long way off, the Harbor Patrol). */
  drop(why: string): void {
    if (!this.run) return;
    this.cleanup();
    this.run = null; this.target = null; this.targetName = null;
    const g = this.game;
    g.hud.objective(null); g.hud.timer(null); this.meterOn(false);
    this.setBusy(null);
    g.hud.toast(why, 5);
  }

  /** Everything a run put in the world. */
  private cleanup(): void {
    const r = this.run, g = this.game;
    if (r?.mascot) { g.people.remove(r.mascot.p); g.scene.remove(r.mascot.head); r.mascot = undefined; }
    if (r?.specs) { for (const s of r.specs) g.people.remove(s.p); r.specs = undefined; }
    if (r?.float) {
      const v = r.float;
      if (g.player.vehicle === v) g.player.exit();
      v.held = false; g.vehicles.remove(v); r.float = undefined;
    }
    if (this.floatDeco) { g.scene.remove(this.floatDeco); this.floatDeco = null; }
    if (this.jelly) { g.scene.remove(this.jelly); this.jelly = null; }
    for (const go of this.geese) g.scene.remove(go.g);
    this.geese.length = 0;
    if (this.cine) this.endCine();
  }

  // ── characters and props ──────────────────────────────────────────────────────

  private mkMascot(r: Run, at: Pt): void {
    const g = this.game;
    const look: Look = { skin: 0xb98a5a, hair: 0x6b4a2b, top: 0x6b4a2b, bottom: 0x6b4a2b, shoes: 0xf0a202, hat: null, height: 1.05, build: 1.18 };
    const p = g.people.spawn(at.x, at.z, 0, look);
    const head = new THREE.Group(); head.name = 'marmot';
    const fur = new THREE.MeshStandardMaterial({ color: 0x8a5e34, roughness: 0.95 }), pale = new THREE.MeshStandardMaterial({ color: 0xe8d3a8, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.6 }), hat = new THREE.MeshStandardMaterial({ color: 0x5c606b, roughness: 0.8 });
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 10), fur); skull.scale.set(1, 0.95, 1.05);
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), pale); snout.position.set(0, -0.1, 0.4); snout.scale.set(1.1, 0.85, 1.1);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), dark); nose.position.set(0, -0.02, 0.6);
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.04), new THREE.MeshStandardMaterial({ color: 0xffffff })); teeth.position.set(0, -0.2, 0.58);
    head.add(skull, snout, nose, teeth);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffffff })); eye.position.set(s * 0.18, 0.12, 0.36);
      const pup = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), dark); pup.position.set(s * 0.18, 0.12, 0.43);
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), fur); ear.position.set(s * 0.34, 0.38, -0.02); ear.scale.set(1, 1, 0.5);
      head.add(eye, pup, ear);
    }
    // The Provost's mortarboard, slightly flat.
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.62), hat); cap.position.y = 0.5; cap.rotation.z = 0.12;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.14, 10), hat); crown.position.y = 0.42;
    const tassel = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), new THREE.MeshStandardMaterial({ color: 0xf0a202 })); tassel.position.set(0.28, 0.43, 0.2);
    head.add(cap, crown, tassel);
    g.scene.add(head);
    r.mascot = { p, head, x: at.x, z: at.z, h: 0, downT: 0, burstT: 4, burst: 0, steerT: 0, ang: 0 };
  }

  private buildJelly(): void {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: 0x6bd13a, emissive: 0x2c6a12, roughness: 0.2, transparent: true, opacity: 0.88 });
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), m);
    const flask = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.18, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xcfe8f0, transparent: true, opacity: 0.4 }));
    flask.position.y = -0.16;
    g.add(blob, flask); g.name = 'specimen7';
    this.jelly = g; this.game.scene.add(g);
  }

  private buildFloat(): void {
    const g = new THREE.Group(); g.name = 'float';
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 192;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#14213d'; c.fillRect(0, 0, 512, 192);
    c.strokeStyle = '#f0a202'; c.lineWidth = 10; c.strokeRect(8, 8, 496, 176);
    c.fillStyle = '#f2e8cf'; c.textAlign = 'center'; c.font = '800 54px sans-serif'; c.fillText('HOMECOMING', 256, 84);
    c.fillStyle = '#f0a202'; c.font = '800 30px sans-serif'; c.fillText('DITHERS COLLEGE · GO MAYBE!', 256, 140);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.98), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    board.position.set(0, 2.55, -0.3);
    const back = board.clone(); back.rotation.y = Math.PI; back.position.z = -0.32;
    g.add(back);
    const post = new THREE.MeshStandardMaterial({ color: 0x5a4632 });
    for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), post); p.position.set(s * 1.2, 1.9, -0.3); g.add(p); }
    g.add(board);
    const cols = [0xe4572e, 0x2a9d8f, 0xf0a202, 0xd86c9d, 0x4a6fa5];
    for (let i = 0; i < 9; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.3 }));
      b.position.set(-1.2 + (i % 5) * 0.6, 1.45 + (i % 3) * 0.28, 0.9 - (i % 2) * 1.8); g.add(b);
    }
    this.floatDeco = g; this.game.scene.add(g);
  }

  private mkGoose(white: number): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: white, roughness: 0.85 }), dark = new THREE.MeshStandardMaterial({ color: 0x3a3a3a }), beak = new THREE.MeshStandardMaterial({ color: 0xf0a202 });
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), body); b.scale.set(0.8, 0.7, 1.35); b.position.y = 0.42;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.5, 6), white === 0xffffff ? body : dark); neck.position.set(0, 0.78, 0.3); neck.rotation.x = -0.35;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), white === 0xffffff ? body : dark); head.position.set(0, 1.03, 0.38);
    const bk = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.16, 6), beak); bk.rotation.x = Math.PI / 2; bk.position.set(0, 1.01, 0.5);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 6), body); tail.rotation.x = -Math.PI / 2.3; tail.position.set(0, 0.5, -0.42);
    g.add(b, neck, head, bk, tail);
    return g;
  }

  private spawnGeese(): void {
    const g = this.game;
    SUBJECTS.forEach((s, si) => {
      for (let k = 0; k < s.n; k++) {
        const a = k * 2.4 + si, r = s.n > 1 ? 1.2 + (k % 3) * 0.9 : 0;
        const x = s.at.x + Math.cos(a) * r, z = s.at.z + Math.sin(a) * r;
        const grp = this.mkGoose(si === 2 ? 0xffffff : si === 1 ? 0xd8d2c0 : 0xb9a98a);
        if (si === 2) grp.scale.setScalar(1.45);
        if (si === 1) grp.scale.setScalar(1.15);
        const y = Math.max(groundAt(x, z), s.swim ? POND_LEVEL : -99);
        grp.position.set(x, s.swim ? POND_LEVEL : y, z); grp.rotation.y = a + 1.2;
        g.scene.add(grp);
        this.geese.push({ g: grp, c: { x, z }, ph: Math.random() * 6, swim: s.swim });
      }
    });
  }

  private spawnSpectators(r: Run): void {
    const g = this.game, out: Spec[] = [];
    let k = 0;
    // Both sides of the Loop from the start's first gate on, every ~34 m of road, one or two in a clump.
    for (let i = 0; i + 1 < LOOP.length; i++) {
      const a = LOOP[i], b = LOOP[i + 1], len = near(a, b), dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
      for (let s = 12; s < len - 4; s += 34) {
        for (const side of [-1, 1]) {
          const lat = 5.4 + (k % 3) * 0.6, x = a.x + dx * s - dz * side * lat, z = a.z + dz * s + dx * side * lat;
          const p = g.people.spawn(x, z, Math.atan2(dz * side, -dx * side), g.people.randomLook());
          p.pose = 'stand'; p.y = groundAt(x, z);
          out.push({ p, x, z, hitT: 0, hopT: 0, hx: x, hz: z });
          k++;
        }
      }
    }
    r.specs = out;
  }

  // ── per-frame ─────────────────────────────────────────────────────────────────

  blips(out: Blip[]): void {
    const p = this.game.player, r = this.run;
    if (!r) {
      if (this.isFree() && Math.hypot(p.x - HUB.x, p.z - HUB.z) < 700) out.push({ x: HUB.x, z: HUB.z, kind: 'giver', label: 'D' });
      return;
    }
    if (r.id === 1 && r.mascot) out.push({ x: r.mascot.x, z: r.mascot.z, kind: 'goal', label: 'M' });
    else if (r.id === 2 && r.books) { const open = r.books.filter((b) => !b.got); if (open.length) for (const b of open) out.push({ x: b.at.x, z: b.at.z, kind: 'job', label: 'B' }); else if (r.target) out.push({ x: r.target.x, z: r.target.z, kind: 'goal' }); }
    else if (r.id === 4 && r.shots) SUBJECTS.forEach((s, i) => { if (!r.shots![i]) out.push({ x: s.at.x, z: s.at.z, kind: 'job', label: 'G' }); });
    else if (r.target) out.push({ x: r.target.x, z: r.target.z, kind: 'goal' });
  }

  update(dt: number): void {
    const g = this.game, p = g.player;
    this.prompt = null;
    this.hitCool -= dt;
    if (this.cardT > 0 && (this.cardT -= dt) <= 0 && this.cardKind === 'report') this.closeCard();
    if (this.grads.length && (this.gradT -= dt) <= 0) this.clearGrads();
    const r = this.run;
    if (!r) {
      this.hub(dt);
      return;
    }
    if (!(p.health > 0)) { this.drop('You have left the course (feet first).'); return; }
    if (Math.hypot(p.x - HUB.x, p.z - HUB.z) > 1400) { this.drop('You have wandered out of the Dithers catchment area. The course is dropped.'); return; }
    if (this.cine) { this.runCine(dt); g.hud.timer(null); g.hud.objective(null); return; }
    if (g.input.eat('reload') && r.id !== 6) { this.drop('Course dropped. The registrar has filed it under "Later".'); return; }
    r.t += dt;
    switch (r.id) {
      case 0: this.tickLate(r); break;
      case 1: this.tickMascot(r, dt); break;
      case 2: this.tickBooks(r); break;
      case 3: this.tickLab(r, dt); break;
      case 4: this.tickPond(r, dt); break;
      case 5: this.tickParade(r, dt); break;
      case 6: this.tickFinals(r); break;
      case 7: this.tickGrad(r); break;
    }
    if (!this.run) return;
    this.target = r.target; this.targetName = r.targetName;
    if (r.target && r.id !== 1) this.markers.put(r.target.x, r.target.z, 'goal', 4, 34);
  }

  /** At rest: the beam by Fumble House. */
  private hub(dt: number): void {
    void dt;
    const g = this.game, p = g.player, d = Math.hypot(p.x - HUB.x, p.z - HUB.z);
    if (d < 200 && this.isFree() && g.state === 'play') this.markers.put(HUB.x, HUB.z, 'giver', 3.6, 24);
    if (this.cardKind === 'catalogue' && d > 16) this.closeCard();
    if (d > 5.5 || !this.isFree() || p.vehicle && !isCycleKind(p.vehicle.spec.kind)) { return; }
    if (this.cardKind === 'none') this.prompt = enrolled() ? '[G] Course Catalogue, Dithers College' : '[G] Enrol at the Office of Admissions & Financial Ruin';
    if (this.cardKind === 'none' && g.input.eat('interact')) { if (enrolled()) this.openCatalogue(); else this.enrol(); }
  }

  private objective(r: Run, text: string, timer?: [string, number]): void {
    const hud = this.game.hud;
    hud.objective(text);
    if (timer) hud.timer(timer[0], clock(timer[1]), timer[1] < 15); else hud.timer(null);
    void r;
  }

  private tickLate(r: Run): void {
    const p = this.game.player, t = r.target as Pt, left = r.lim - r.t;
    this.objective(r, `Get the essay to Professor Shrug at Shrug Hall before the bell. ${Math.round(near(p, t))} m to go.`, ['Bell in', left]);
    if (left <= 0) { this.finish(0, 'The bell rang. Professor Shrug accepts it anyway, with a shrug, and a grade you will not like.'); return; }
    if (near(p, t) < 6) {
      const score = timeScore(r.t, 38, 70, r.lim);
      this.finish(score, `Handed in at ${clock(r.t)}, ${clock(left)} before the bell. "Late? I stopped looking at the clock in 1994."`);
    }
  }

  private tickMascot(r: Run, dt: number): void {
    const g = this.game, p = g.player, m = r.mascot as Mascot, left = r.lim - r.t;
    this.objective(r, `Tackle Maybe the Marmot (${r.tackles ?? 0} of 2). ${Math.round(near(p, m))} m away.`, ['Provost out', left]);
    this.moveMascot(m, dt, r);
    this.markers.put(m.x, m.z, 'goal', 1.6, 8, 2.5);
    if (left <= 0) { this.finish(0, 'The marmot got away with the hat. The Provost has chosen to wear a traffic cone.'); return; }
    const v = p.vehicle;
    if (m.downT <= 0 && near(p, m) < 2 && (!v || isCycleKind(v.spec.kind))) {
      r.tackles = (r.tackles ?? 0) + 1; this.stats.tackles++;
      m.downT = 1.6; m.p.pose = 'down'; g.cam.shake(0.4);
      const second = r.tackles >= 2;
      if (!second) g.hud.toast(kid.on ? 'A big marmot hug! The hat is... a fez. That is not the Provost\'s hat. He is off again!' : 'WHUMP. You have the marmot. The hat is a fez. That is not the Provost\'s hat. He is off again, faster!', 5);
      else g.hud.toast(kid.on ? 'A second marmot hug! The mortarboard is yours. The marmot would like a hat too.' : 'WHUMP. The mortarboard is yours, slightly flat. The marmot lies there, a hero.', 6);
      if (second) this.finish(timeScore(r.t, 45, 100, r.lim), `Two tackles in ${clock(r.t)}. The mortarboard goes back to the Provost, who says it is not the one he lost, and wears it.`);
    }
  }

  private moveMascot(m: Mascot, dt: number, r: Run): void {
    const g = this.game, p = g.player, tk = r.tackles ?? 0;
    if (m.downT > 0) { m.downT -= dt; m.p.pose = 'down'; if (m.downT <= 0) m.p.pose = 'run'; }
    else {
      m.burstT -= dt; if (m.burstT <= 0) { m.burst = 1.3; m.burstT = 6.5; }
      if (m.burst > 0) m.burst -= dt;
      const base = 5.2 + 0.7 * tk, sp = base * (m.burst > 0 ? 1.18 : 1);
      // Pick the heading every quarter second: away from her, inside the quad, not into a wall or the pond.
      if ((m.steerT -= dt) <= 0) {
        m.steerT = 0.22;
        const cur = m.ang, d0 = near(m, p);
        let best = -1e9, bang = cur;
        for (let k = 0; k < 20; k++) {
          const a = (k / 20) * Math.PI * 2, step = 4.5, nx = m.x + Math.sin(a) * step, nz = m.z + Math.cos(a) * step, mx = m.x + Math.sin(a) * 1.6, mz = m.z + Math.cos(a) * 1.6;
          if (!free(nx, nz, 1.2) || !free(mx, mz, 1.2)) continue;
          const far = Math.hypot(nx - p.x, nz - p.z) - d0, home = -Math.max(0, Math.hypot(nx - QUAD.x, nz - QUAD.z) - 75) * 0.35;
          const turn = -Math.abs(Math.atan2(Math.sin(a - cur), Math.cos(a - cur))) * 0.5;
          const sc = far * 2 + home + turn;
          if (sc > best) { best = sc; bang = a; }
        }
        m.ang = bang;
      }
      const nx = m.x + Math.sin(m.ang) * sp * dt, nz = m.z + Math.cos(m.ang) * sp * dt;
      if (free(nx, nz, 0.9)) { m.x = nx; m.z = nz; } else m.steerT = 0;
      m.h = m.ang; m.p.pose = 'run'; m.p.speed = sp;
    }
    m.p.x = m.x; m.p.z = m.z; m.p.h = m.h; m.p.y = groundAt(m.x, m.z);
    m.head.position.set(m.x, m.p.y + (m.downT > 0 ? 0.35 : 1.82), m.z);
    m.head.rotation.y = m.h;
    m.head.rotation.x = m.downT > 0 ? -1.2 : Math.sin(r.t * 14) * 0.05;
  }

  private tickBooks(r: Run): void {
    const g = this.game, p = g.player, books = r.books as { at: Pt; got: boolean; name: string }[], left = r.lim - r.t;
    const got = books.filter((b) => b.got).length;
    for (const b of books) if (!b.got) this.markers.put(b.at.x, b.at.z, 'item', 3, 16);
    if (got < books.length) {
      const nb = books.filter((b) => !b.got).sort((a, c) => near(a.at, p) - near(c.at, p))[0];
      r.target = null; r.targetName = null;
      this.objective(r, `Collect the overdue books (${got} of ${books.length}). The nearest is at ${nb.name}.`, ['Library closes in', left]);
      for (const b of books) if (!b.got && near(b.at, p) < 3.4) { b.got = true; g.hud.toast(`Overdue book collected from ${b.name}. It is ${100 + Math.floor(Math.random() * 3000)} days late and unashamed. (${got + 1} of ${books.length})`, 4); }
      this.target = nb.at;
    } else {
      if (!r.target) { r.target = freeNear(LIBRARY, p, 7, 18); r.targetName = 'The Overdue Library'; g.hud.toast('All five. Take them back to the Overdue Library, quickly.', 4); }
      this.objective(r, 'Return the books to the Overdue Library.', ['Library closes in', left]);
      if (near(p, r.target) < 6) {
        const score = timeScore(r.t, 85, 150, r.lim);
        this.finish(score, `Five books back in ${clock(r.t)}. The librarian stamped each one and charged you for the stamp.`);
        return;
      }
    }
    if (left <= 0) this.finish(0, 'The Overdue Library closed, which it does every day, at a time it will not disclose.');
  }

  /** Specimen 7 is carried at her side, wobbling more as it is shaken. */
  private shake(amount: number, line: string | null): void {
    const r = this.run; if (!r || r.id !== 3 || r.stab === undefined) return;
    r.stab -= amount; r.bumps = (r.bumps ?? 0) + 1;
    if (line) this.game.hud.toast(line, 3);
    this.game.cam.shake(0.2);
  }

  private tickLab(r: Run, dt: number): void {
    const g = this.game, p = g.player, gates = r.gates as Pt[], left = r.lim - r.t;
    const v = p.vehicle;
    const sp = p.speed, gentle = v ? 5.5 : 4.9;
    const air = v ? !v.onGround : p.person.pose === 'jump' || p.person.pose === 'fall';
    if (air && !this.wasAirP) this.shake(v ? 10 : 12, 'Whoa. That was a jump. Specimen 7 does not do jumps.');
    this.wasAirP = air;
    if (sp > gentle) r.stab = (r.stab as number) - (sp - gentle) * 6.5 * dt;
    // It settles a little when she is steady.
    else if (sp < 3) r.stab = Math.min(100, (r.stab as number) + 1.2 * dt);
    const stab = Math.max(0, r.stab as number);
    this.meterOn(true, stab > 55 ? 'Specimen 7: calm-ish' : stab > 25 ? 'Specimen 7: wobbling' : 'Specimen 7: ABOUT TO GO', stab, stab > 55 ? '#6bd13a' : stab > 25 ? '#f0a202' : '#e4572e');
    if (this.jelly) {
      const t = r.t, w = 1 + (1 - stab / 100) * 0.9;
      this.jelly.position.set(p.x + Math.cos(p.h) * 0.45, p.y + 1.05 + Math.sin(t * 9 * w) * 0.03 * w, p.z - Math.sin(p.h) * 0.45);
      this.jelly.scale.set(1 + Math.sin(t * 13 * w) * 0.14 * w, 1 + Math.cos(t * 11 * w) * 0.16 * w, 1 + Math.sin(t * 12 * w) * 0.14 * w);
      ((this.jelly.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(stab > 55 ? 0x6bd13a : stab > 25 ? 0xd8d63a : 0xe4572e);
    }
    if (stab <= 0) {
      this.game.hud.toast(kid.on ? 'Specimen 7 sneezed a little rainbow and went to bed. Nobody is hurt.' : 'BANG. Specimen 7 has gone, along with your eyebrows. Nobody is hurt, and the lab is mostly pleased.', 6);
      this.finish(0, 'The specimen did not survive the trip. The Department of Smells & Bangs counts this as a success.');
      return;
    }
    const gi = r.gi as number;
    if (gi === 0) {
      const door = r.target as Pt;
      this.objective(r, 'Pick up Specimen 7 at the Department of Smells & Bangs.', ['Class ends in', left]);
      if (near(p, door) < 4.5) { r.gi = 1; r.target = gates[0]; r.targetName = 'the Chapel steps'; r.t = 0; g.hud.toast('Specimen 7 is in your hands. It is warm, and it is thinking about it. Now: the Chapel steps, then Heaping Union, then Squishy Things.', 6); }
    } else {
      const to = gates[gi - 1], name = ['the Chapel steps', 'Heaping Union', 'the Department of Squishy Things'][gi - 1];
      r.target = to; r.targetName = name;
      this.objective(r, `Carry Specimen 7 gently to ${name}. ${Math.round(near(p, to))} m. Jog; do not sprint or jump.`, ['Class ends in', Math.max(0, r.lim - r.t)]);
      if (near(p, to) < 5) {
        if (gi < 3) { r.gi = gi + 1; g.hud.toast(gi === 1 ? 'Chapel steps. Specimen 7 whispered something at the stained glass.' : 'Heaping Union. Specimen 7 has made a friend, and is leaving it.', 3); }
        else {
          const sc = Math.round(1000 * (0.75 * stab / 100 + 0.25 * timeScore(r.t, 60, 150, r.lim) / 1000));
          this.finish(r.t > r.lim ? 0 : sc, `Delivered in ${clock(r.t)} with Specimen 7 at ${Math.round(stab)}% composure (${r.bumps} bump${r.bumps === 1 ? '' : 's'}). Squishy Things signed for it, and did not look.`);
          return;
        }
      }
      if (r.t >= r.lim) this.finish(0, 'Class ended with the specimen still in your hands. It has had a long day.');
    }
  }

  /** What a camera sees: the subjects inside its cone, with how well they are centred (1 centred .. 0 at the edge). */
  private frame(limit: number): { i: number; q: number }[] {
    const cam = this.game.camera, out: { i: number; q: number }[] = [];
    cam.getWorldDirection(this.dir);
    SUBJECTS.forEach((s, i) => {
      const y = (s.swim ? POND_LEVEL : groundAt(s.at.x, s.at.z)) + 0.6;
      this.ray.set(s.at.x - cam.position.x, y - cam.position.y, s.at.z - cam.position.z);
      const d = this.ray.length();
      if (d < 3 || d > 75) return;
      const ang = this.ray.normalize().angleTo(this.dir);
      if (ang < limit) out.push({ i, q: 1 - ang / limit });
    });
    return out;
  }

  private snap(r: Run, limit: number, how: string): void {
    const hud = this.game.hud, shots = r.shots as boolean[], seen = this.frame(limit);
    this.stats.photos++;
    const fresh = seen.filter((s) => !shots[s.i]);
    if (!fresh.length) { hud.toast(seen.length ? 'Already on file. The geese are unimpressed.' : `${how}: nothing worth filing in that. Look at the geese, Gerald or the swan.`, 3); return; }
    for (const s of fresh) { shots[s.i] = true; (r.framing as number[]).push(Math.max(0.05, s.q)); hud.toast(`Filed: ${SUBJECTS[s.i].name}, framing ${Math.round(s.q * 100)}%. (${shots.filter(Boolean).length} of ${SUBJECTS.length})`, 4); }
  }

  /** Photos taken while photo mode was open (Save photo) and field photos (G). */
  private tickPond(r: Run, dt: number): void {
    const g = this.game, p = g.player, left = r.lim - r.t, shots = r.shots as boolean[];
    const n = shots.filter(Boolean).length;
    this.objective(r, `Photograph the geese, Gerald and the swan at Johnson Pond (${n} of ${SUBJECTS.length}).`, ['Light fails in', left]);
    for (const go of this.geese) {
      const w = Math.sin(r.t * 1.3 + go.ph);
      go.g.position.y += 0; go.g.rotation.z = Math.sin(r.t * 4 + go.ph) * 0.05 * (go.swim ? 0.3 : 1);
      go.g.rotation.y += Math.sin(r.t * 0.6 + go.ph) * 0.004 * w * (dt * 60);
    }
    for (let i = 0; i < SUBJECTS.length; i++) if (!shots[i]) this.markers.put(SUBJECTS[i].at.x, SUBJECTS[i].at.z, 'job', 2.4, 10);
    if (g.photo.stats.saved > this.savedSaved) { this.savedSaved = g.photo.stats.saved; this.snap(r, 0.45, 'Photo mode'); }
    if (!g.photo.open) {
      const nearPond = SUBJECTS.some((s, i) => !shots[i] && near(p, s.at) < 70);
      if (nearPond) this.prompt = `[G] Field photo (${n} of ${SUBJECTS.length}): centre the geese, Gerald or the swan`;
      if (nearPond && g.input.eat('interact')) { this.snap(r, 0.42, 'Field photo'); this.game.hud.stamp('CLICK', 'Johnson Pond survey'); }
    }
    if (left <= 0) { this.finish(0, 'The light failed before the survey did. The geese are still there. They will always be there.'); return; }
    if (n >= SUBJECTS.length) {
      const f = (r.framing as number[]).reduce((a, b) => a + b, 0) / Math.max(1, (r.framing as number[]).length);
      this.finish(Math.round(0.55 * (400 + 600 * f) + 0.45 * timeScore(r.t, 70, 160, r.lim)), `Three subjects filed in ${clock(r.t)}, framing ${Math.round(f * 100)}%. Gerald asked for a copy.`);
    }
  }

  private tickParade(r: Run, dt: number): void {
    const g = this.game, p = g.player, v = r.float as Vehicle, left = r.lim - r.t;
    const specs = r.specs ?? [];
    const gi = r.gi5 as number;
    if (this.floatDeco) { this.floatDeco.position.set(v.x, v.y, v.z); this.floatDeco.rotation.y = v.h; }
    if (v.removed) { this.drop('The float has gone. The parade goes on without you, as parades do.'); return; }
    if (p.vehicle !== v) {
      this.objective(r, 'Get back in the Homecoming float (F near it).', ['Parade ends in', left]);
      r.target = { x: v.x, z: v.z };
      if (left <= 0) this.finish(0, 'The parade left without its float.');
      return;
    }
    // The spectators: a clump on each side. The float is two circles.
    const hl = v.hl * 0.55, cx = Math.sin(v.h), cz = Math.cos(v.h), pts: [number, number][] = [[v.x + cx * hl, v.z + cz * hl], [v.x - cx * hl, v.z - cz * hl]], rad = v.hw + 0.42;
    for (const s of specs) {
      if (s.hitT > 0) { s.hitT -= dt; if (s.hitT <= 0) { s.p.pose = 'stand'; } continue; }
      if (s.hopT > 0) { s.hopT -= dt; if (s.hopT <= 0) s.p.pose = 'stand'; }
      for (const [x, z] of pts) {
        const d = Math.hypot(s.p.x - x, s.p.z - z);
        if (kid.on && d < rad + 3 && Math.abs(v.speed) > 1) {
          // Kid mode: a step back, a hop, nothing counts.
          const k = (rad + 3.2 - d) * 0.5, ux = (s.p.x - x) / Math.max(0.1, d), uz = (s.p.z - z) / Math.max(0.1, d);
          s.p.x += ux * k; s.p.z += uz * k; s.p.pose = 'jump'; s.hopT = 0.6;
        } else if (!kid.on && d < rad && Math.abs(v.speed) > 0.8 && s.hitT <= 0) {
          s.hitT = 2.2; s.p.pose = 'down'; r.hits = (r.hits as number) + 1; this.stats.hits++;
          g.hud.toast(r.hits === 1 ? 'A spectator has been struck. He says it is fine, then says it is not.' : r.hits === 2 ? 'Another spectator. The parade committee is taking notes.' : 'That is three. The insurance people have started to cheer, for different reasons.', 4);
          g.cam.shake(0.3);
        }
      }
    }
    // The pace: under 20 mph (9 m/s). Over it for a moment is a strike.
    if (gi > 0) {
      if (Math.abs(v.speed) > 9.6) { r.over = (r.over as number) + dt; if ((r.over as number) > 1.2) { r.strikes = (r.strikes as number) + 1; r.over = -4; g.hud.toast('Slow down: it is a parade, not a getaway. The grand marshal has dinged you.', 4); } }
      else if ((r.over as number) > 0) r.over = Math.max(0, (r.over as number) - dt);
      else r.over = Math.min(0, (r.over as number) + dt);
    }
    const goal = LOOP[Math.min(gi, LOOP.length - 1)];
    if (gi === 0) { r.target = LOOP[0]; r.targetName = 'the start of the parade'; this.objective(r, 'Drive the float to the start of the parade on Dithers Loop.', ['Parade ends in', left]); if (near(v, LOOP[0]) < 9) { r.gi5 = 1; r.started = r.t; g.hud.toast('The parade begins. Slowly, under 20 mph. Wave, if you have a free hand, which you do not.', 5); } }
    else {
      r.target = goal; r.targetName = 'the parade route';
      this.objective(r, `Parade: keep it slow, miss the spectators. Gate ${gi} of ${LOOP.length - 1}. Hits ${r.hits}, dings ${r.strikes}.`, ['Parade ends in', left]);
      if (near(v, goal) < 9) {
        if (gi < LOOP.length - 1) r.gi5 = gi + 1;
        else {
          const run = r.t - (r.started as number);
          const score = 1000 - 220 * (r.hits as number) - 90 * (r.strikes as number) - (1000 - timeScore(run, 110, 200, r.lim)) * 0.3;
          this.finish((r.hits as number) >= 3 ? Math.min(score, 590) : score, `${LOOP.length - 1} gates in ${clock(run)}; ${r.hits} spectator${r.hits === 1 ? '' : 's'} struck, ${r.strikes} ding${r.strikes === 1 ? '' : 's'}. The Provost, on the reviewing stand, waved with the wrong hand.`);
          return;
        }
      }
    }
    if (left <= 0) this.finish(0, 'The parade ran out of afternoon. The float is still on the Loop.');
  }

  private askQuestion(): void {
    const r = this.run as Run, qs = r.qs as Question[], i = r.qi as number, q = qs[i];
    this.showCard('quiz', `<div class="sm-q"><h2><small>ALL 400 · Finals · Question ${i + 1} of ${qs.length}</small>${q.q}</h2>${q.a.map((a, k) => `<button data-a="ans" data-i="${k}">${k + 1}. ${a}</button>`).join('')}</div>`);
  }

  /** Answer the question on the card (1-4 keys, a click, or the tests). */
  answer(i: number): void {
    const r = this.run; if (!r || r.id !== 6 || r.step !== 0 || !r.qs) return;
    const q = r.qs[r.qi as number];
    if (!q || i < 0 || i >= q.a.length) return;
    const ok = i === q.ok;
    if (ok) r.right = (r.right as number) + 1;
    const btns = this.card.querySelectorAll('button[data-a="ans"]');
    btns.forEach((b, k) => { (b as HTMLElement).classList.toggle('right', k === q.ok); (b as HTMLElement).classList.toggle('wrong', k === i && !ok); (b as HTMLButtonElement).disabled = true; });
    r.step = 3;
    setTimeout(() => {
      if (this.run !== r) return;
      r.qi = (r.qi as number) + 1;
      if ((r.qi as number) >= (r.qs as Question[]).length) this.endQuiz(r); else { r.step = 0; this.askQuestion(); }
    }, Math.min(900, 300 + (ok ? 0 : 400)));
  }

  private endQuiz(r: Run): void {
    const g = this.game, n = (r.qs as Question[]).length, right = r.right as number;
    r.quizScore = (right / n) * 1000; r.step = 1; r.t = 0; r.lim = 110;
    this.closeCard();
    r.target = freeNear(REBUTTAL, { x: g.player.x, z: g.player.z }, 8, 20); r.targetName = 'the Registrar, Rebuttal Union';
    g.hud.toast(`${right} of ${n} correct. Now hand the paper in at the Registrar, in Rebuttal Union. Run. The ink is still wet and so is the Registrar's patience.`, 7);
  }

  private tickFinals(r: Run): void {
    const g = this.game, p = g.player, left = r.lim - r.t;
    if (r.step !== 1) { this.objective(r, `Finals: question ${(r.qi as number) + 1} of ${(r.qs as Question[]).length}. Press 1-4.`); g.hud.timer(null); r.t = 0; if (g.input.eat('reload')) { /* no dropping mid-paper */ } return; }
    const t = r.target as Pt;
    this.objective(r, `Hand the paper in at the Registrar, Rebuttal Union. ${Math.round(near(p, t))} m.`, ['Registrar closes in', left]);
    if (left <= 0) { this.finish(0, 'The Registrar closed. The paper is now a letter to the Registrar, apologising.'); return; }
    if (near(p, t) < 6) {
      const right = r.right as number, n = (r.qs as Question[]).length;
      this.finish(0.7 * (r.quizScore as number) + 0.3 * timeScore(r.t, 40, 80, r.lim), `${right} of ${n} right, and the dash took ${clock(r.t)}. The Registrar read the first line, nodded, and stamped it.`);
    }
  }

  // ── graduation ────────────────────────────────────────────────────────────────

  private tickGrad(r: Run): void {
    const g = this.game, p = g.player, t = r.target as Pt, left = r.lim - r.t;
    const all = COURSES.slice(0, NCOURSES - 1).every((c) => passed(c.id));
    if (!all) { this.finish(0, 'The Registrar checked the file. There are courses missing. The Chapel is closed to you, politely.'); return; }
    this.objective(r, 'Make your way to the Chapel of Second Thoughts for graduation.', ['Ceremony in', left]);
    if (left <= 0) { this.finish(0, 'The ceremony went ahead without you. They read your name, and then read it again.'); return; }
    if (near(p, t) < 7 && !(p.vehicle && !isCycleKind(p.vehicle.spec.kind) && Math.abs(p.speed) > 6)) this.beginCine(r, t);
  }

  private beginCine(r: Run, spot: Pt): void {
    const g = this.game, p = g.player;
    const dx = spot.x - PORTICO.x, dz = spot.z - PORTICO.z, l = Math.hypot(dx, dz) || 1, d = { x: dx / l, z: dz / l };
    const f: Pt = { x: PORTICO.x + d.x * (l + 2), z: PORTICO.z + d.z * (l + 2) };
    if (p.vehicle) p.exit();
    p.teleport(f.x + d.x * 2.2, f.z + d.z * 2.2, Math.atan2(d.x, d.z));
    g.cam.snap();
    g.input.setEnabled(false);
    this.cine = { t: 0, beat: 0, f, d };
    g.hud.timer(null); g.hud.objective(null);
    this.bars.classList.add('on'); this.clearGrads();
    const rng = (k: number): number => { const s = Math.sin(k * 12.9898) * 43758.5453; return s - Math.floor(s); };
    const px = -d.z, pz = d.x;
    for (let row = 0; row < 3; row++) for (let k = 0; k < 5; k++) {
      const off = (k - 2) * 1.35 + (rng(row * 5 + k) - 0.5) * 0.3, back = -(row + 1) * 1.5 - 0.3;
      const x = f.x + px * off + d.x * back, z = f.z + pz * off + d.z * back;
      const look = { ...g.people.randomLook(), hat: 0x1a1a22 as number | null };
      const pe = g.people.spawn(x, z, Math.atan2(d.x, d.z), look);
      pe.pose = 'stand'; pe.y = groundAt(x, z);
      this.grads.push(pe);
    }
    this.gradT = 90;
    r.step = 5;
  }

  private caption(tx: string): void { this.cap.textContent = tx; }

  private runCine(dt: number): void {
    const g = this.game, c = this.cine as NonNullable<typeof this.cine>, r = this.run as Run;
    c.t += dt;
    const { f, d } = c, px = -d.z, pz = d.x;
    const gy = groundAt(f.x, f.z);
    const beats: [number, string][] = [[0, 'Dithers College. Class of 2026.'], [3.6, 'The Provost has a speech. It is the one from last year.'], [7.2, '"Congratulations. We are not sure on what, but congratulations."'], [10.4, 'Hats up on three. We will not be counting.'], [13.4, '']];
    for (let i = beats.length - 1; i >= 0; i--) if (c.t >= beats[i][0] && c.beat <= i) { c.beat = i + 1; this.caption(beats[i][1]); if (i === 4) { this.flash.style.transition = 'none'; this.flash.style.opacity = '1'; requestAnimationFrame(() => { this.flash.style.transition = 'opacity 1.1s'; this.flash.style.opacity = '0'; }); g.hud.stamp('CLICK', 'The Class of 2026'); } break; }
    // A slow sweep round the Class, then the front-on class photograph.
    const k = Math.min(1, c.t / 13.2), a = -0.9 + 0.9 * k * 1.0;
    const R = 13 - 3.5 * k, hgt = 5.2 - 3.2 * k;
    const cxp = f.x + (d.x * Math.cos(a) + px * Math.sin(a)) * R, czp = f.z + (d.z * Math.cos(a) + pz * Math.sin(a)) * R;
    const camY = Math.max(groundAt(cxp, czp) + 1.6, gy + hgt);
    g.view = { pos: new THREE.Vector3(cxp, camY, czp), target: new THREE.Vector3(f.x - d.x * 1.8, gy + 1.7, f.z - d.z * 1.8) };
    if (c.t > 13.2) c.beat = 99;
    if (c.t >= 15.4) this.graduate();
  }

  private endCine(): void {
    this.cine = null;
    this.game.view = null;
    this.game.input.setEnabled(true);
    this.bars.classList.remove('on'); this.cap.textContent = '';
  }

  private clearGrads(): void { for (const p of this.grads) this.game.people.remove(p); this.grads.length = 0; }

  private graduate(): void {
    const r = this.run as Run, g = this.game;
    this.endCine();
    const mean = (() => { let s = 0; for (let i = 0; i < NCOURSES - 1; i++) s += gradeOf(scoreOf(i) ?? 0).points; return s / (NCOURSES - 1); })();
    const score = Math.min(1000, Math.round(mean * 250 + (mean >= 3.5 ? 0 : 0)));
    const honors = mean >= 3.8 ? 'summa cum laude (barely)' : mean >= 3.5 ? 'cum laude' : mean >= 3 ? 'with moderate distinction' : mean >= 2 ? 'with a straight face' : 'by the skin of the Provost\'s teeth';
    this.finish(score, 'The diploma is in your hand. The fine for the hat is in the other.');
    void r;
    g.hud.toast(`DIPLOMA: Bachelor of Maybe, Dithers College, ${honors}. GPA ${gpa().toFixed(2)}.`, 10);
    this.showCard('diploma', `<div class="sm-dip"><small>DITHERS COLLEGE · CLASS OF 2026</small><br><b>Bachelor of Maybe</b><p>This certifies that the bearer, having passed seven courses, a pond, a parade and the Provost's mood, is awarded the degree <i>${honors}</i>, and is asked to stop running on the quad.</p><p>GPA <b>${gpa().toFixed(2)}</b> · Class photograph on file${deanList() ? " · <b>Dean's List</b>" : ''}</p></div><p style="text-align:right"><button class="alt" data-a="close">Close</button></p>`, 25);
    this.cardKind = 'diploma';
  }

  /** For the tests. */
  info(): Record<string, unknown> {
    const r = this.run;
    return {
      run: r ? { id: r.id, t: +r.t.toFixed(1), step: r.step, stab: r.stab !== undefined ? +r.stab.toFixed(1) : null, tackles: r.tackles ?? null, got: r.books?.filter((b) => b.got).length ?? null, gi: r.gi ?? r.gi5 ?? null, hits: r.hits ?? null, strikes: r.strikes ?? null, shots: r.shots ?? null, qi: r.qi ?? null, right: r.right ?? null, qok: r.qs && r.qs[r.qi as number] ? r.qs[r.qi as number].ok : null } : null,
      target: this.target, mascot: r?.mascot ? { x: r.mascot.x, z: r.mascot.z, down: r.mascot.downT > 0 } : null, book: r?.books?.map((b) => b.at) ?? null,
      gates: r?.gates ?? null, specs: r?.specs?.length ?? 0, card: this.cardKind, report: this.lastReport, gpa: gpa(), enrolled: enrolled(), grads: this.grads.length, cine: this.cine ? this.cine.beat : null,
      float: r?.float ? { x: r.float.x, z: r.float.z, h: r.float.h } : null, loop: LOOP, hub: HUB, ...this.stats, subjects: SUBJECTS.map((s) => s.at), geese: this.geese.length,
    };
  }
}
