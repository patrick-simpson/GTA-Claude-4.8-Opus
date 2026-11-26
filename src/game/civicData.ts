// Fun queue 2, item 47: the plain data of the three civic interiors (no imports, so tools can read it): which directory doors
// they are, when they open, the library's books and its late-fee jokes, the museum's plaques, the depot's windows.
// The rooms' geometry is world/civicRooms.ts, the game is game/civic.ts, the cards are ui/civicPanel.ts.
// Everything here is made up: the town, its people and its history are the game's own.

export type CivicId = 'library' | 'museum' | 'depot';

export interface CivicDef {
  id: CivicId;
  /** The directory business whose door this is (world/business.ts places it). */
  place: string;
  title: string; sub: string;
  /** Open hours on the town clock. */
  from: number; to: number;
}

export const CIVICS: Record<CivicId, CivicDef> = {
  library: { id: 'library', place: 'The Overdue Library', title: 'The Overdue Library', sub: 'Quiet, please. Your books are late.', from: 9, to: 21 },
  museum: { id: 'museum', place: 'Museum of Mild Curiosities', title: 'Museum of Mild Curiosities', sub: 'The town\'s history, mostly accurate.', from: 10, to: 20 },
  depot: { id: 'depot', place: 'Tepid Falls Depot (Trains, In Principle)', title: 'Tepid Falls Depot', sub: 'Ticket hall and waiting room. Trains in principle.', from: 5, to: 23 },
};
export const CIVIC_IDS: CivicId[] = ['library', 'museum', 'depot'];

export function openAt(d: CivicDef, hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return h >= d.from && h < d.to;
}

// ── The library ──────────────────────────────────────────────────────────────

export interface Book { id: number; title: string; by: string; text: string; late: string }

/** Ten books about the town, borrowed one shelf at a time. Each carries its own late-fee joke. */
export const BOOKS: Book[] = [
  { id: 0, title: 'A Short History of Tepid Falls', by: 'The Founding Committee', text: 'The town was founded by a committee that could not agree where to stand, so it settled wherever the mud was driest. The mud has since been outvoted, but the committee still meets.', late: 'Due 1851. Fine so far: $4,112, payable in pie.' },
  { id: 1, title: 'The Perpetual Bridge: Planning Notes', by: 'Harbor Authority', text: 'The bridge is built one span at a time, and each span is approved at a meeting that runs long enough to need its own lunch. It is not late. It is perpetual.', late: 'Due never. The library is fining the bridge anyway.' },
  { id: 2, title: 'Lackwool Mill Ledgers, Vol. 9', by: 'A. Lackwool & Daughters', text: 'The mill spun wool for the whole valley, and every bale was weighed twice, once for the customer and once for luck. The wheel still turns when nobody is watching it.', late: 'Due 1932. The mill has offered to spin the fine into a scarf.' },
  { id: 3, title: 'Weather Records, Compiled by Nobody in Particular', by: 'Anonymous', text: 'The great tornado crossed the valley in the time it takes to boil a kettle and moved a barn eleven yards to the left. The barn was reportedly pleased with the view.', late: 'Due the Tuesday of the tornado. Fine: one barn.' },
  { id: 4, title: 'Moose of the Millpond', by: 'Prof. A. Thistlewood', text: 'Moose were here before the town and have been polite about it. The council passed a resolution giving them the right of way, and the moose, unaware, kept it.', late: 'Overdue by 41,000 days. The moose does not pay fines and the librarian does not ask.' },
  { id: 5, title: 'The Budget Line: A Timetable, In Principle', by: 'Depot Staff', text: 'The train leaves at the times printed, give or take the times not printed. Passengers are advised to arrive early, and to bring a book, ideally one that is not overdue.', late: 'Due on arrival. Arrival not yet announced.' },
  { id: 6, title: 'Demolition Derby Rules (Abridged)', by: 'Flounder Field Committee', text: 'Rule one: there are no rules. Rule two: everybody signs the form. Rule three: the form is also a rule. The trophy goes to whoever is still rolling, or nearest to it.', late: 'Due after the derby, assuming the book is still a book.' },
  { id: 7, title: 'Pies of the Side Door', by: 'The Cook (Retired Twice)', text: 'The recipe is simple: more butter than seems wise, and a look of calm. Never tell the pie what is in it. It knows.', late: 'Due Thursday. Fine: one slice, no questions.' },
  { id: 8, title: 'Mayor Bascombe\'s Collected Speeches (Short Edition)', by: 'C. Bascombe', text: 'The short edition runs to four hundred pages. Volume one is mostly about ribbons: the cutting of them, the finding of them, and the scissors, which were never located.', late: 'Due at the next ribbon cutting. Please bring the scissors.' },
  { id: 9, title: 'A Guide to Not Catching Fish', by: 'Gus Marrow', text: 'Sit by the dam, hold the rod very still, and think about something else entirely. The fish are watching and take it personally. Patience is the whole technique, and the whole bait.', late: 'Due when the fish stop biting. The library is not holding its breath.' },
];

/** What the librarian says across the desk, in turn. */
export const DESK_LINES: string[] = [
  'Shh. That was a whisper, and I heard it.',
  'Late fees are one cent a day. Your account is, in theory, fine. The library\'s account is not.',
  'Overdue books may be returned at any time. Overdue by how much is, strictly speaking, none of your business.',
  'We do not have a lost-and-found. We have a found-and-lost, and it is mostly umbrellas.',
  'If the book is overdue, it is the book\'s fault. We have discussed it with the book.',
  'The Overdue Library is open nine to nine. The "nine" is an average.',
  'Yes, the fine is enormous. No, nobody has ever paid it. It is more of a tradition.',
];

/** Reading all of them stamps the library card. */
export const CARD = { name: 'Library card', all: BOOKS.length };

// ── The museum ───────────────────────────────────────────────────────────────

export interface Exhibit { id: number; title: string; years: string; short: string; text: string }

export const EXHIBITS: Exhibit[] = [
  { id: 0, title: 'The Perpetual Bridge', years: 'Begun long ago. Continuing.', short: 'A bridge that is always about to open.', text: 'The Perpetual Bridge crosses the channel to the island, one approved span at a time. Each span took a vote, a second vote about the first vote, and a picnic. Visitors may walk across it, and are asked to hurry the town up politely.' },
  { id: 1, title: 'Lackwool Mill', years: 'Spinning since the first wool.', short: 'The wheel that outlasted the wool.', text: 'The Lackwool Mill spun the valley\'s wool into yarn so lukewarm that the town took its name from it. The wheel turned on the millpond for generations, and a number of scarves from the first run are still, reportedly, finishing.' },
  { id: 2, title: 'The Great Tornado', years: 'One afternoon, a good while back.', short: 'Eleven yards to the left.', text: 'The great tornado crossed the valley in about the time it takes to boil a kettle. It lifted a barn, set it down eleven yards to the left, and left the cow exactly where she had been standing. The barn was later moved back by committee.' },
  { id: 3, title: 'The Moose of the Millpond', years: 'Here before the town.', short: 'The oldest resident, politely.', text: 'The moose were here first, and every autumn the town holds a festival in their honor, though nobody has been able to invite them. The council\'s resolution gives them the right of way on every road. Cars are advised to wait and be impressed.' },
  { id: 4, title: 'The Demolition Derby', years: 'Every Friday night, weather permitting.', short: 'The loudest tradition in town.', text: 'The Flounder Field Demolition Derby began as a disagreement over a parking space and grew into the town\'s favorite evening. The trophy is a dented hubcap on a plinth. Winners are whoever is still rolling when the whistle goes.' },
];
export const MUSEUM_STAMP = 'Museum pass';

/** The donation box feeds the town's Promenade fund, in these dollars. */
export const DONATE = 5;

// ── The depot ────────────────────────────────────────────────────────────────

export const DEPOT = { station: 'Tepid Falls Depot', name: 'The Budget Line' };
/** The departure board shows this many trains. */
export const BOARD_ROWS = 4;

// ── Local save (the best map; no new save structure) ─────────────────────────

export const KEY_BOOKS = 'cv.books';
export const KEY_PLAQ = 'cv.plaq';
export const KEY_STAMP = 'cv.stamp';
/** Stamp bits: the library card, the museum pass. */
export const STAMP_LIBRARY = 1, STAMP_MUSEUM = 2;

export const popcount = (n: number): number => { let c = 0; n = n | 0; while (n) { c += n & 1; n >>>= 1; } return c; };
