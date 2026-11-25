// Fun queue 2, item 35: night life on Main St. The plain data of the two walk-in rooms (no imports, so tools can read it):
// which directory doors they are, when they open, what is on the menus, the band's nights and the darts' rules.
// The rooms' geometry is world/nightRooms.ts, the game is game/nightlife.ts.

export type VenueId = 'diner' | 'pub';

export interface MenuItem { id: string; name: string; price: number; heal: number; note: string }

export interface VenueDef {
  id: VenueId;
  /** The directory business whose door this is (world/business.ts). */
  place: string;
  /** What the sign inside says, and the line under it. */
  title: string; sub: string;
  /** Open hours on the town clock; to may pass midnight (26 = 2 am). */
  from: number; to: number;
  menu: MenuItem[];
  /** The free coffee (diner only) and the order panel's heading. */
  heading: string;
}

export const VENUES: Record<VenueId, VenueDef> = {
  diner: {
    id: 'diner', place: 'Side Door Restaurant', title: 'The Side Door Diner', sub: 'Counter, booths, pie. Open early, open late.',
    from: 5.5, to: 23, heading: 'Counter menu',
    menu: [
      { id: 'coffee', name: 'Bottomless coffee', price: 2, heal: 8, note: 'refills are free' },
      { id: 'pie', name: 'Slice of pie', price: 3, heal: 20, note: 'ask what is in the case' },
      { id: 'pancakes', name: 'Short stack', price: 5, heal: 30, note: 'with real syrup' },
      { id: 'burger', name: 'Cheeseburger plate', price: 7, heal: 50, note: 'fries and a pickle' },
      { id: 'meatloaf', name: 'Meatloaf and mash', price: 9, heal: 80, note: 'the cook\'s own' },
    ],
  },
  pub: {
    id: 'pub', place: 'The Hog Wallow Pub', title: 'The Hog Wallow', sub: 'A family pub. Root beer on tap. Darts in the corner.',
    from: 17, to: 26, heading: 'Bar menu',
    menu: [
      { id: 'ginger', name: 'Ginger ale', price: 2, heal: 8, note: 'cold' },
      { id: 'rootbeer', name: 'Root beer float', price: 3, heal: 15, note: 'from the tap' },
      { id: 'pretzel', name: 'Soft pretzel', price: 4, heal: 22, note: 'with mustard' },
      { id: 'pie', name: 'Shepherd\'s pie', price: 8, heal: 65, note: 'Walt\'s mother\'s' },
    ],
  },
};
export const VENUE_IDS: VenueId[] = ['diner', 'pub'];

/** Is it open at a town-clock hour (0..24)? */
export function openAt(v: VenueDef, hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return v.to <= 24 ? h >= v.from && h < v.to : h >= v.from || h < v.to - 24;
}

/** The clock time it next opens, for the closed sign. */
export function fmtOpen(h: number): string {
  const t = ((h % 24) + 24) % 24, hh = Math.floor(t), mm = Math.round((t - hh) * 60);
  const ap = hh >= 12 ? 'pm' : 'am', h12 = hh % 12 === 0 ? 12 : hh % 12;
  return mm ? `${h12}:${String(mm).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

/** The pub's band: Thursday, Friday and Saturday evenings (Sunday is 0), 19:00 to 23:30, in step with the evening window of the town's events. */
export const BAND = { name: 'The Muddy River Three', days: [4, 5, 6], from: 19, to: 23.5 } as const;
export function bandPlays(weekday: number, hour: number, force = false): boolean {
  if (force) return true;
  const h = ((hour % 24) + 24) % 24;
  return (BAND.days as readonly number[]).includes(weekday) && h >= BAND.from && h < BAND.to;
}

/** Outside, at night: how many people stand about each door, and between which hours. */
export const CROWD = { diner: 2, pub: 4, from: 18.5, to: 26 };

/** Darts: the stake, the prize, the dial. Scores by how far from the middle a dart lands (0 is the bull, 1 the board's edge). */
export const DARTS = { stake: 5, prize: 12, rings: [[0.08, 50], [0.2, 25], [0.5, 12], [0.95, 5]] as [number, number][], opponent: 'Bram' };
export function dartScore(r: number): number {
  for (const [edge, pts] of DARTS.rings) if (r <= edge) return pts;
  return 0;
}
