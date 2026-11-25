// The Semester (fun queue 2, item 16): the course list, grades, GPA and the Transcript. Pure data and arithmetic, no scene:
// game/semester.ts runs the missions, the pause menu shows transcriptHtml(), the leaderboard reads gpa().
//
// What the save keeps (game/save.ts keeps any key it is given, so no format change):
//   counts['sem.enrol']  1 once enrolled at the Office of Admissions & Financial Ruin
//   counts['sem.runs']   attempts, all courses
//   counts['sem.dean']   1 once the Dean's List toast has been shown
//   best['sem.N']        the best score for course N, 0..1000 (present once attempted, even an F)
// Grades: A 900+, B 800+, C 700+, D 600+, F under that. A course is PASSED with a D or better; the next one opens on a pass.
// GPA: the mean of grade points (A 4 .. F 0) of each attempted course's best score. Dean's List: GPA 3.5 or better after 3 passes.

import { save } from './save';

export interface Course { id: number; code: string; name: string; blurb: string }

export const COURSES: readonly Course[] = [
  { id: 0, code: 'ENG 101', name: 'Late Assignment', blurb: 'Carry your essay across the quad to Professor Shrug before the bell. On foot, or by bike if you must.' },
  { id: 1, code: 'PHY ED 140', name: 'Mascot Containment', blurb: 'Maybe the Marmot has stolen the Provost\'s mortarboard. Chase him round the quad and tackle him.' },
  { id: 2, code: 'LIB 210', name: 'Overdue Run', blurb: 'Collect five overdue books from the dorms and return them to the Overdue Library before it closes.' },
  { id: 3, code: 'CHEM 220', name: 'Lab Delivery', blurb: 'Carry Specimen 7 from Smells & Bangs to Squishy Things the long way round. It does not like bumps.' },
  { id: 4, code: 'BIO 150', name: 'Pond Survey', blurb: 'Photograph the geese, Gerald and the swan at Johnson Pond. (G for a field photo, or O for photo mode.)' },
  { id: 5, code: 'HOM 300', name: 'Homecoming Parade', blurb: 'Drive the parade float slowly along Dithers Loop. The spectators are not part of the route.' },
  { id: 6, code: 'ALL 400', name: 'Finals', blurb: 'Six questions about the town, then a dash to hand the paper in at the Registrar.' },
  { id: 7, code: 'GRAD 999', name: 'Graduation', blurb: 'Pass everything, then take the stage at the Chapel of Second Thoughts. Wear a hat.' },
];
export const NCOURSES = COURSES.length;

export const PASS = 600;
export const GRADES: [number, string, number][] = [[900, 'A', 4], [800, 'B', 3], [700, 'C', 2], [600, 'D', 1], [0, 'F', 0]];
export const gradeOf = (score: number): { letter: string; points: number } => {
  for (const [min, letter, points] of GRADES) if (score >= min) return { letter, points };
  return { letter: 'F', points: 0 };
};

/** 1000 at or under `great` seconds, 700 (a C) at `ok`, 600 (a D) at `limit`; under the limit only. */
export function timeScore(t: number, great: number, ok: number, limit: number): number {
  if (t <= great) return 1000;
  if (t <= ok) return Math.round(1000 - ((t - great) / Math.max(1, ok - great)) * 300);
  if (t <= limit) return Math.round(700 - ((t - ok) / Math.max(1, limit - ok)) * 100);
  return 0;
}

export const enrolled = (): boolean => save.count('sem.enrol') > 0;
export const scoreOf = (id: number): number | null => { const v = save.data.best['sem.' + id]; return v === undefined ? null : v; };
export const passed = (id: number): boolean => (scoreOf(id) ?? -1) >= PASS;
export const passes = (): number => COURSES.filter((c) => passed(c.id)).length;
/** A course is open when the one before it is passed (the first, once enrolled). */
export const unlocked = (id: number): boolean => enrolled() && (id === 0 || passed(id - 1));
export const letterOf = (id: number): string => { const s = scoreOf(id); return s === null ? '' : gradeOf(s).letter; };
export const attempted = (): number => COURSES.filter((c) => scoreOf(c.id) !== null).length;

/** The grade point average (0..4), 0 before any course. */
export function gpa(): number {
  let sum = 0, n = 0;
  for (const c of COURSES) { const s = scoreOf(c.id); if (s !== null) { sum += gradeOf(s).points; n++; } }
  return n ? sum / n : 0;
}
/** For the leaderboard: GPA times 100, or 0. */
export const gpaBoard = (): number => Math.round(gpa() * 100);
export const deanList = (): boolean => passes() >= 3 && gpa() >= 3.5;
export const gpaText = (): string => (attempted() ? gpa().toFixed(2) : '—');

// ── Finals ────────────────────────────────────────────────────────────────────

export interface Question { q: string; a: string[]; ok: number }
export const QUESTIONS: readonly Question[] = [
  { q: 'What is the Budget Line?', a: ['A diet', 'The passenger train', 'A tax bracket', 'A rumour'], ok: 1 },
  { q: 'Who is the watchman at your yard, The Cannery?', a: ['Lou', 'Lew', 'Louis, Tuesdays only', 'Nobody has ever been watching'], ok: 0 },
  { q: 'Which pond is on the Dithers campus?', a: ['Johnson Pond', 'Pond Johnson', 'Dithers Puddle', 'The Sea of Doubt'], ok: 0 },
  { q: 'What do the signs at the fishing spots say?', a: ['NO FISHING (probably)', 'FISHING PERMITTED, PROBABLY', 'BEWARE OF TROUT', 'FISH AT WILL'], ok: 1 },
  { q: 'When is the loaner rod due back?', a: ['Friday', 'Noon', 'Never', 'The 4th'], ok: 2 },
  { q: 'What does the Harbor Authority have on file about you?', a: ['Everything', 'No record, which is how it likes you', 'A parking ticket', 'Your shoe size'], ok: 1 },
  { q: 'Which chapel is on campus?', a: ['The Chapel of Second Thoughts', 'The Chapel of Fast Decisions', 'St. Maybe\'s', 'The Church of the Free Refill'], ok: 0 },
  { q: 'How many overdue books were on the Overdue Run?', a: ['Two', 'Five', 'Nine hundred', 'The library will not say'], ok: 1 },
  { q: 'What is the college mascot?', a: ['The Wolverine', 'Maybe the Marmot', 'A Concerned Moose', 'The Provost'], ok: 1 },
  { q: 'What is the Calamity Courtesy Cab?', a: ['A taxi you can fare', 'A type of bridge', 'A legal term', 'A cab, but courteous'], ok: 0 },
  { q: 'Where does the Department of Smells & Bangs send its experiments?', a: ['Squishy Things', 'The pond', 'The moon', 'Nowhere, ever'], ok: 0 },
  { q: 'What does the Provost wear on his head?', a: ['A mortarboard', 'Nothing since Tuesday', 'A traffic cone', 'A mortarboard, when he can find it'], ok: 3 },
];

// ── The Transcript (the pause menu, Progress page, Section J) ───────────────────

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export function transcriptHtml(): string {
  const row = (label: string, value: string): string => `<div class="mn-row"><span class="mn-lbl">${label}</span><span>${value}</span></div>`;
  if (!enrolled()) {
    return `<h3>Section J · Transcript</h3><p class="mn-note">Not enrolled. The Office of Admissions &amp; Financial Ruin, Dithers College, will have you: eight short courses, one after another, a GPA, and a graduation. Look for the cream beam by Fumble House.</p>`;
  }
  const rows = COURSES.map((c) => {
    const s = scoreOf(c.id);
    const g = s === null ? (unlocked(c.id) ? 'open' : 'locked') : `<b class="sem-g sem-${gradeOf(s).letter}">${gradeOf(s).letter}</b> ${Math.round(s / 10)}%`;
    return row(`${c.code} · ${esc(c.name)}`, g);
  }).join('');
  const dean = deanList();
  return `<h3>Section J · Transcript, Dithers College</h3>
${row('Grade point average', `<b class="sem-gpa">${gpaText()}</b>${dean ? ' · <b>Dean\'s List</b>' : ''}`)}
${row('Courses passed', `${passes()} of ${NCOURSES}`)}
${rows}
${passed(NCOURSES - 1) ? '<p class="mn-note">Graduated. The Class of 2026 photograph is on file, and so is the fine for the hat.</p>' : '<p class="mn-note">Courses open one after another. A D passes; an F means the professor wants a word. Report to the Office of Admissions &amp; Financial Ruin for the catalogue.</p>'}`;
}
