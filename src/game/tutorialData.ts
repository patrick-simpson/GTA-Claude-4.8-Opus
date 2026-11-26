// Fun queue 2, item 36: the words of the first hour (game/tutorial.ts runs it, ui/tutorialCard.ts shows it).
//
// Nine short steps, told by Lou (the watchman at your yard, The Cannery) and, once you are at Quorum Square, by Ines
// Calloway the shopkeeper (item 30). Every step has one objective line and the key or button for a keyboard and for a phone,
// by the names on the screen: GET IN / EXIT, GAS, BRAKE, USE, PHOTO, RADIO, and the pause button (II) that opens the map.

export type StepId = 'car' | 'drive' | 'map' | 'job' | 'photo' | 'shop' | 'cross' | 'square' | 'radio';

export interface Step {
  id: StepId;
  /** Who is talking. */
  who: string;
  /** What they say: one or two warm sentences. */
  say: string;
  /** The one objective line. */
  goal: string;
  /** The key (keyboard and pad) and the button (phone) that do it. */
  kb: string;
  touch: string;
  /** The same, from Lou, when Ines is not about (the old streets have no named townsfolk). */
  old?: string;
}

export const STEPS: readonly Step[] = [
  { id: 'car', who: 'Lou', say: 'Welcome to Port Calamity. First things first: everything here is better with a car.',
    goal: 'Walk up to a car and get in.', kb: 'F (pad: Y) next to a car', touch: 'GET IN button, it shows up beside a car' },
  { id: 'drive', who: 'Lou', say: 'Easy now. Take her for a little spin to the gold marker.',
    goal: 'Drive to the gold marker.', kb: 'W A S D, Space is the handbrake', touch: 'GAS and BRAKE, steer with the left thumb' },
  { id: 'map', who: 'Lou', say: 'Nobody here knows where anything is. The map does. Drop a waypoint on it.',
    goal: 'Open the map and set a waypoint.', kb: 'M or Tab, then click the map', touch: 'Pause button (II), MAP tab, tap the map' },
  { id: 'job', who: 'Lou', say: 'Folks pay for rides and for parcels. Do one quick job and keep the change.',
    goal: 'Finish one paid job: a taxi fare or a delivery.', kb: 'G in a yellow cab, or G at a shop door in a car', touch: 'USE button' },
  { id: 'photo', who: 'Lou', say: 'The town looks its best through a lens. Snap something.',
    goal: 'Open photo mode and take a picture.', kb: 'O, then Enter or Snap', touch: 'PHOTO button, then Snap' },
  { id: 'shop', who: 'Lou', say: 'Pardon\'s sells odd finds, and the water has fish. Pick whichever you like.',
    goal: 'Buy a find at Pardon\'s, or catch a fish.', kb: 'G at the counter, or G at a fishing sign', touch: 'USE button' },
  { id: 'cross', who: 'Lou', say: 'Now the big one: across the water to Tepid Falls. Everyone there is dying to meet you.',
    goal: 'Cross to Tepid Falls.', kb: 'Drive over the bridge, or F on the ferry dock', touch: 'GAS over the bridge, or GET IN on the ferry dock' },
  { id: 'square', who: 'Ines', say: 'You made it! I am Ines. Quorum Square is everybody\'s front porch. Say hello to someone.',
    goal: 'Walk to Quorum Square and say hello.', kb: 'G beside a person', touch: 'USE button',
    old: 'You made it! Quorum Square is everybody\'s front porch. Have a look around.' },
  { id: 'radio', who: 'Ines', say: 'Last one. Put Claude FM on in a car, then open the Places panel to see where everyone is.',
    goal: 'Tune in Claude FM, then open the Places panel.', kb: 'T in a car, then M and the Places list', touch: 'RADIO button in a car, then Pause (II), MAP',
    old: 'Last one. Put Claude FM on in a car, then open the Places panel to see what is where.' },
];

export const OFFER = { who: 'Lou', say: 'New in town? I can show you around the first hour. It is short, it pays a little, and you can stop whenever you like.' };
export const DONE = { who: 'Lou', say: 'There. You know your way around. Welcome to Tepid Falls.', stamp: 'WELCOME TO TEPID FALLS', sub: 'a little cash and a stamp for the file' };
export const REWARD = 250;
