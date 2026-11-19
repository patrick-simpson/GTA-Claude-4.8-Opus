// The story: who hands out work, where they stand, and the thirteen missions.
//
// Ten on the island, in order, each one teaching a thing the game can do; then
// three in Tepid Falls that open as the town does (a mill job, a college job, a
// thruway job). The island ten pay 2,430 points between them, about half of
// the 4,800 the Perpetual Bridge costs: the rest is jobs, ducks, the fund box
// and plain mileage, which is the slow, continual part.
//
// Voices. DESS: tired, exact, has read the form. FINCH: fishing metaphors that
// do not survive contact with the sentence. GUS: an accountant; everything is
// a line item. VANCE: every answer is a stump speech. LOU: the Harbor
// Authority's watchman, who is sorry and has a clipboard. The Gull Syndicate
// take seabird names and themselves very seriously.

import type { Game } from '../core/game';
import type { Look } from '../core/api';
import { BUILDING_SITES } from '../world/buildings';
import { XS, ZS } from '../world/plan';
import { streetRoute, type Giver, type Mission, type Pt, type Step } from './script';

const P = (x: number, z: number): Pt => ({ x, z });
/** The intersection of north-south street i and east-west street j. */
const N = (i: number, j: number): Pt => ({ x: XS[i], z: ZS[j] });
const say = (who: string, text: string, bg = false): Step => ({ t: 'say', who, text, bg });

const look = (o: Partial<Look>): Look => ({ skin: 0xc68e6a, hair: 0x2b1d17, top: 0x6b705c, bottom: 0x2f3e46, shoes: 0x2a2320, hat: null, height: 1, build: 1, ...o });
/** Unit vector out of a facade, by the side it faces: 0 north, 1 east, 2 south, 3 west. */
const OUT = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const H_OUT = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];

const GULL = 0x1b1b1f;

export function story(game: Game): { givers: Record<string, Giver>; missions: Mission[] } {
  const plan = game.plan;
  /** A spot on the sidewalk in front of a named building, `d` meters out from its wall. */
  const front = (name: string, d: number, fx: number, fz: number, side: number): { at: Pt; h: number; side: number } => {
    const s = BUILDING_SITES[name] ?? { x: fx, z: fz, side };
    return { at: P(s.x + OUT[s.side][0] * d, s.z + OUT[s.side][1] * d), h: H_OUT[s.side], side: s.side };
  };
  /** The south-east corner of a mainland intersection: somewhere to stand that is not the road. */
  const corner = (x: number, z: number): Pt => { const n = plan.nearestNode(x, z); return P(n.x + n.hx + 1.7, n.z + n.hz + 1.7); };

  const lou = front('marlowe', 2.1, -396.7, 275.9, 2);
  const finch = front('finch', 1.8, -16.1, 309.4, 3);
  const gus = front('gus', 1.7, 35.5, 303.9, 0);
  const vance = front('vance', 1.9, 69.3, -53.9, 1);
  /** In the curb lane outside each of them. */
  const road = (f: { at: Pt; side: number }, d: number): Pt => P(f.at.x + OUT[f.side][0] * d, f.at.z + OUT[f.side][1] * d);
  const louRd = road(lou, 6), finchRd = road(finch, 6), gusRd = road(gus, 6.5), vanceRd = road(vance, 6);

  const millAt = corner(170, -1295), deanAt = corner(-480, -1620), margeAt = corner(-590, -1180);

  const givers: Record<string, Giver> = {
    lou: { name: 'LOU', letter: 'L', short: 'Talk to Lou', at: lou.at, h: lou.h, look: look({ top: 0x14213d, bottom: 0x14213d, hat: 0x14213d, hair: 0x8d8d8d, skin: 0xe0b08c, build: 1.12 }) },
    finch: { name: 'FINCH', letter: 'F', short: 'Talk to Finch', at: finch.at, h: finch.h, look: look({ top: 0xf0a202, bottom: 0x3d5a56, hat: 0x2a9d8f, hair: 0xd9d4c7, skin: 0xb9805c, height: 0.95 }) },
    gus: { name: 'GUS', letter: 'G', short: 'Talk to Gus', at: gus.at, h: gus.h, look: look({ top: 0xf2e8cf, bottom: 0x4a3f35, hair: 0x1b1b1b, skin: 0x8d5a3b, build: 1.14, height: 0.97 }) },
    vance: { name: 'VANCE', letter: 'V', short: 'Talk to Councilwoman Vance', at: vance.at, h: vance.h, look: look({ top: 0xe4572e, bottom: 0x14213d, hair: 0x14110f, skin: 0xa9744f, height: 1.03, build: 0.95 }) },
    mill: { name: 'ODILE', letter: 'M', short: 'Talk to Odile Thrum', at: millAt, h: 0, look: look({ top: 0x7a5c43, bottom: 0x39424e, hat: 0x9c4a3c, hair: 0x5c4033, skin: 0xe3b594, build: 1.08 }) },
    dean: { name: 'DEAN FENWICK-OHM', letter: 'D', short: 'Talk to the Dean', at: deanAt, h: 0, look: look({ top: 0x4a4e69, bottom: 0x22223b, hair: 0xe5e5e5, skin: 0xf0c8a8, height: 1.05, build: 0.92 }) },
    marge: { name: 'MARGE', letter: 'T', short: 'Talk to Marge', at: margeAt, h: 0, look: look({ top: 0xf0a202, bottom: 0x2f3e46, hat: 0xf0a202, hair: 0x7b4b2a, skin: 0xcf9a76 }) },
  };

  const bridgeFoot = P(XS[5] + 3, ZS[0] + 8);
  const coat = P(-428.6, 76);

  const missions: Mission[] = [
    // 1 ── driving, and where everybody is ──
    {
      id: 'm01', title: 'Repossession Is Nine-Tenths', giver: 'lou', reward: 150, points: 120,
      intro: 'The yard is seized. The truck was not on the form.',
      unlocks: 'Barnacle Finch has work. He is the F on the radar, outside the bait shop.',
      steps: [
        say('LOU', 'Morning, Dess. I chained your gate at six. The regulations ask me to feel nothing about it, and I am trying.'),
        say('DESS', 'And the truck?'),
        say('LOU', 'The form only had room for the yard. So the truck is, legally, a rumor. I would drive the rumor somewhere else.'),
        { t: 'getVehicle', kind: 'tow', text: 'Get in a tow truck. Yours is on Strand Blvd, where the paperwork missed it.' },
        say('DESS', 'Finch owes me for a winch job. That is rent on a gate I cannot open.', true),
        { t: 'checkpoint' },
        { t: 'goto', at: finchRd, r: 9, kind: 'tow', stop: true, text: "Drive the truck to Barnacle Finch's bait shop: Calamity Ave, south of Strand Blvd." },
        say('FINCH', 'Dess Marlowe! A tow truck is a net with wheels. You cast it wide and the fish climb in by themselves. That is the saying.'),
        say('DESS', 'That is not a saying.'),
        say('FINCH', 'It is going to be. Here is what I owe you, and here is a way to be owed more.'),
      ],
    },
    // 2 ── collecting, the clock, getting out of the car ──
    {
      id: 'm02', title: 'Catch and Release', giver: 'finch', needs: ['m01'], reward: 200, points: 150,
      intro: 'Five crates of bait went for a walk. Finch would like them back before they are evidence.',
      unlocks: 'Gus, the accountant at the back of the arcade, has heard you are punctual.',
      steps: [
        say('FINCH', 'My delivery boy dropped five crates between here and the sea wall. He panicked. A herring panics; a professional floats.'),
        say('DESS', 'What is in the crates?'),
        say('FINCH', 'Bait. And you know what they say about bait: do not ask what is in the bait.'),
        { t: 'timer', secs: 200, label: 'Crates noticed in' },
        { t: 'collect', r: 3.5, text: 'Pick up the five crates around the Strand before anyone official does.', items: [P(-22, 345), P(-30, 394), P(26, 393), P(74, 352), P(73, 318)] },
        { t: 'timer', secs: 0 },
        { t: 'checkpoint' },
        say('DESS', 'Five. One of them is ticking.', true),
        { t: 'goto', at: P(finch.at.x - 1.6, finch.at.z), r: 4.5, mode: 'foot', text: 'Carry them to Finch, on foot. He will not sign for a truck.' },
        say('FINCH', 'That one is a clock. For the fish. Fish are very punctual, which is how you catch them.'),
        say('DESS', 'Pay me, Finch.'),
      ],
    },
    // 3 ── a particular vehicle, delivered ──
    {
      id: 'm03', title: 'Double-Entry', giver: 'gus', needs: ['m02'], reward: 250, points: 180,
      intro: 'A van of arcade prizes is on the books twice. Gus needs it to exist once, here.',
      unlocks: 'Councilwoman Vance has opened an office on Gannet St and would like a word. Several, in fact.',
      steps: [
        say('GUS', 'There is a van at the Dock Seven office. It is full of plush lobsters. On paper there are two vans. Bring me the one that is real.'),
        say('DESS', 'What happens to the other van?'),
        say('GUS', 'It depreciates. Quietly. Over five years.'),
        { t: 'spawnVehicle', tag: 'van', kind: 'van', at: P(313.5, 262), h: 0, color: 0xf2e8cf },
        { t: 'getVehicle', tag: 'van', text: 'Take the white van outside the Dock Seven office on Ironbound Ave.' },
        { t: 'checkpoint' },
        say('DESS', 'It smells like a carnival that has been to sea.', true),
        { t: 'timer', secs: 170, label: 'Audit begins in' },
        { t: 'deliver', tag: 'van', at: gusRd, r: 9, text: "Bring the van to Gus's Arcade on Strand Blvd before the audit. Do not bend it." },
        { t: 'timer', secs: 0 },
        say('GUS', 'One van, received. I can pay two hundred and fifty in cash and the balance in tokens.'),
        { t: 'money', amount: 0, note: 'Gus paid the balance in arcade tokens: 40. They are not legal tender. He knows.' },
        say('DESS', 'There is no balance, Gus.'),
        say('GUS', 'Then the tokens are a gift. I will need a receipt for the gift.'),
      ],
    },
    // 4 ── on foot to the giver's door, then checkpoints against par ──
    {
      id: 'm04', title: 'A Fine Day for It', giver: 'vance', needs: ['m03'], reward: 300, points: 200,
      intro: 'The campaign bus must be seen in six places. The councilwoman will be in none of them.',
      unlocks: 'Finch has seen birds on the pier. He means the Gull Syndicate. He has made it confusing.',
      steps: [
        say('VANCE', 'Ms. Marlowe. I opposed the seizure of your yard. I also voted for it. That is called balance, and the voters love it.'),
        say('DESS', 'I want my gate open.'),
        say('VANCE', 'And I want a bus seen at every corner of the Ledger District by lunch. One of us is closer to her dream. Shall we help each other?'),
        { t: 'spawnVehicle', tag: 'bus', kind: 'bus', at: P(XS[6] + 3.2, -86), h: Math.PI, color: 0xe4572e },
        { t: 'getVehicle', tag: 'bus', text: 'Board the campaign bus on Gannet St. It is the red one saying VANCE on every surface.' },
        { t: 'checkpoint' },
        say('DESS', 'It handles like a filing cabinet.', true),
        { t: 'race', par: 190, r: 12, mode: 'car', text: 'Be seen: drive the bus through every checkpoint before the lunch crowd goes back in.', cps: [N(6, 2), N(5, 2), N(5, 4), N(4, 4), N(4, 5), N(6, 5), P(XS[6], -60)] },
        { t: 'despawn', tag: 'bus' },
        say('VANCE', 'Wonderful. Four people waved. One of them was hailing a cab, but we will count her.'),
        say('DESS', 'My gate.'),
        say('VANCE', 'Is under review. Everything good is.'),
      ],
    },
    // 5 ── tailing ──
    {
      id: 'm05', title: 'Birdwatching', giver: 'finch', needs: ['m04'], reward: 350, points: 220,
      intro: 'A black sedan has been seen at the pier. Follow it home. Not too close; they are sensitive.',
      unlocks: 'Gus has a problem that cannot be written down. He would like you to make it worse first.',
      steps: [
        say('FINCH', 'The Gull Syndicate is leaning on the pier. A man called Kittiwake bought all my worms and then did not fish. That is a threat, Dess.'),
        say('DESS', 'That is a man with worms.'),
        say('FINCH', 'Follow his car. Find the nest. But gently: you do not chase a pelican, you let the pelican believe it is alone.'),
        { t: 'spawnVehicle', tag: 'gull', kind: 'sedan', at: P(-26.6, 318), h: Math.PI, color: GULL },
        { t: 'spawnActor', tag: 'kit', at: P(-18.6, 316), h: -Math.PI / 2, look: { top: GULL, bottom: GULL, hat: 0xf2e8cf } },
        { t: 'goto', at: P(-26.6, 366), r: 10, mode: 'car', stop: true, text: 'Pull up on Calamity Ave below the bait shop, in anything with wheels, behind the black sedan.' },
        { t: 'checkpoint' },
        say('KITTIWAKE', 'The Syndicate thanks the pier for its cooperation. The Syndicate was never here.'),
        { t: 'despawn', tag: 'kit' },
        { t: 'tail', tag: 'gull', speed: 10.5, near: 13, far: 115, text: "Follow Kittiwake's sedan to wherever the Gulls roost. Stay back, but keep it in sight.", route: [P(-26.6, 318), ...streetRoute(plan, N(5, 7), N(1, 6))] },
        say('DESS', 'The old Tinplate cannery. Of course they roost in a cannery.'),
        { t: 'despawn', tag: 'gull' },
        { t: 'goto', at: finchRd, r: 10, text: 'Tell Finch where the nest is.' },
        say('FINCH', 'A cannery! The one place a gull is in a tin. There is a saying in that. Give me a week.'),
      ],
    },
    // 6 ── heat, and how to lose it ──
    {
      id: 'm06', title: 'Heat Rash', giver: 'gus', needs: ['m05'], reward: 300, points: 220,
      intro: 'Gus needs the Harbor Patrol looking at somebody else for ten minutes. You are somebody else.',
      unlocks: 'Finch has decided the Gulls need a message. He has also found a rocket launcher, somewhere.',
      steps: [
        say('GUS', 'I am moving a ledger tonight. I have told the Harbor Patrol that a tow-truck driver did something. I did not say what. They filled it in themselves.'),
        say('DESS', 'You reported me.'),
        say('GUS', 'I expensed you. Lose them, and it comes back as income. Fresh Coat on Bollard St resprays anything, including the truth.'),
        { t: 'checkpoint' },
        { t: 'heat', level: 2 },
        say('DESS', 'Two cars for a rumor. They must be bored.', true),
        { t: 'loseHeat', text: 'Lose the Harbor Patrol: get out of sight until they give up, or drive into Fresh Coat on Bollard St ($200).' },
        say('DESS', 'Clean. Or at least a different colour.', true),
        { t: 'goto', at: gusRd, r: 10, text: 'Go back to Gus at the arcade.' },
        say('GUS', 'The ledger moved. You were a very convincing distraction. I have filed you under entertainment.'),
      ],
    },
    // 7 ── weapons, destroying things, then the consequences ──
    {
      id: 'm07', title: 'Feathers', giver: 'finch', needs: ['m06'], reward: 400, points: 260,
      intro: 'Three Syndicate vans are parked at the cannery. Finch feels they have been parked long enough.',
      unlocks: 'Councilwoman Vance is holding a public meeting and expects it to go badly. She has asked for you by name.',
      steps: [
        say('FINCH', 'I found this in a crate of squid. It is either a launcher or a very committed flare gun. Take it to the cannery.'),
        say('DESS', 'You want me to blow up three vans.'),
        say('FINCH', 'I want the tide to go out on them. You are the moon, Dess. The moon with a launcher.'),
        { t: 'give', weapon: 'launcher', ammo: 5 },
        { t: 'give', weapon: 'shotgun', ammo: 24 },
        { t: 'spawnVehicle', tag: 'g1', kind: 'van', at: P(XS[1] - 3.4, 196), h: 0, color: GULL },
        { t: 'spawnVehicle', tag: 'g2', kind: 'van', at: P(XS[1] - 3.4, 214), h: 0, color: GULL },
        { t: 'spawnVehicle', tag: 'g3', kind: 'van', at: P(XS[1] + 3.4, 240), h: Math.PI, color: GULL },
        { t: 'goto', at: P(XS[1], 150), r: 14, text: 'Go to the Gull cannery on Bilge St, south of Tinplate St.' },
        { t: 'checkpoint' },
        say('DESS', 'Three black vans, parked in a row like an opinion.', true),
        { t: 'destroy', tags: ['g1', 'g2', 'g3'], text: 'Wreck all three Syndicate vans. E selects the launcher; stand well back.' },
        say('DESS', 'That will have been heard.', true),
        { t: 'checkpoint' },
        { t: 'loseHeat', text: 'Lose whoever is coming, then go and tell Finch.' },
        { t: 'goto', at: finchRd, r: 10, text: 'Tell Finch the tide went out.' },
        say('FINCH', 'I heard it from here. So did the worms. You are a natural disaster, Dess, and I mean that as a compliment to nature.'),
      ],
    },
    // 8 ── surviving a clock ──
    {
      id: 'm08', title: 'Public Comment Period', giver: 'vance', needs: ['m07'], reward: 450, points: 280,
      intro: 'The meeting is at Mercy Park. The public has comments. Some of the comments are the Harbor Patrol.',
      unlocks: 'Lou wants to see you at the yard. He says he has found a sub-clause.',
      steps: [
        say('VANCE', 'I have called a meeting about the bridge. The Harbor Authority has called it an unlawful assembly, and the Gulls have called it theirs.'),
        say('DESS', 'And what do you call it?'),
        say('VANCE', 'Engagement. I need someone visible in Mercy Park for a minute and a quarter, so that I can be somewhere else, concerned.'),
        { t: 'goto', at: N(6, 3), r: 16, text: 'Go to the Mercy Park gate at Gannet St and Mercy Ln.' },
        { t: 'checkpoint' },
        { t: 'heat', level: 2 },
        say('DESS', 'Seventy-five seconds. I have towed cars that took longer to regret.', true),
        { t: 'survive', secs: 75, at: P(135, -150), r: 115, text: 'Stay in and around Mercy Park until the meeting is adjourned. Keep moving.' },
        say('VANCE', 'Adjourned! I am told it was spirited. I was at a ribbon cutting, so I cannot be quoted.', true),
        { t: 'loseHeat', text: 'The meeting is over. Lose the Harbor Patrol.' },
        { t: 'goto', at: vanceRd, r: 10, text: "Report to the councilwoman's office on Gannet St." },
        say('VANCE', 'You have a gift for turnout, Ms. Marlowe. The bridge fund noticed. So did I, and I notice for a living.'),
      ],
    },
    // 9 ── the truck earns its keep ──
    {
      id: 'm09', title: 'Tow the Line', giver: 'lou', needs: ['m08'], reward: 500, points: 300,
      intro: 'Four seizure notices went out this morning. Lou would not mind if they came back in.',
      unlocks: 'The councilwoman has rivets for the bridge and nobody she trusts to drive them. So she called you.',
      steps: [
        say('LOU', 'Sub-clause nine. A seizure notice not posted by noon is "deemed aspirational". There are four gates in town with notices on them, Dess. Yours is one.'),
        say('DESS', 'And you cannot take them down.'),
        say('LOU', 'I cannot. I can read a newspaper very thoroughly while somebody in a tow truck does.'),
        { t: 'getVehicle', kind: 'tow', text: 'Get in a tow truck. The notices are zip-tied; you will want the winch.' },
        { t: 'checkpoint' },
        { t: 'timer', secs: 260, label: 'Noon in' },
        say('DESS', 'Four gates, one truck, and a watchman doing the crossword.', true),
        { t: 'collect', r: 6, mode: 'car', text: 'Pull down the four seizure notices before noon, from the truck.', items: [P(XS[2] + 4, 130), P(XS[4] - 4, -70), P(XS[7] + 4, 130), P(XS[8] + 6, 230)] },
        { t: 'timer', secs: 0 },
        { t: 'heat', level: 1 },
        say('DESS', 'Somebody saw the last one. Somebody always sees the last one.', true),
        { t: 'checkpoint' },
        { t: 'loseHeat', text: 'Lose the Harbor Patrol before you go anywhere near the yard.' },
        { t: 'goto', at: louRd, r: 10, kind: 'tow', stop: true, text: 'Take the truck back to Marlowe Towing on Strand Blvd.' },
        say('LOU', 'I see no notices. I see a gate with a chain on it and no reason for the chain. I will write that up. It takes eight weeks.'),
        say('DESS', 'I have waited longer for parts.'),
      ],
    },
    // 10 ── the finale, at the foot of the bridge ──
    {
      id: 'm10', title: 'Span of Attention', giver: 'vance', needs: ['m09'], reward: 1200, points: 500,
      intro: 'One pickup of rivets, one unfinished bridge, and everyone who would rather it stayed that way.',
      unlocks: 'The island is square with you, for now. The rest of the bridge is jobs, ducks and patience. Tepid Falls is hiring when you get there.',
      steps: [
        say('VANCE', 'The Perpetual Bridge has been unfinished for eleven years. It polls beautifully that way. But the crew will bolt a span today if the rivets arrive.'),
        say('DESS', 'Where are the rivets?'),
        say('VANCE', 'Dock Seven, in a pickup. The Gulls want them in the Sound and the Authority wants them in triplicate. I want them at the bridge. Today I mean it.'),
        { t: 'spawnVehicle', tag: 'rivets', kind: 'pickup', at: P(XS[9] + 3.2, 236), h: Math.PI, color: 0xf0a202 },
        { t: 'getVehicle', tag: 'rivets', text: 'Take the yellow pickup on Jetsam St in Dock Seven.' },
        { t: 'checkpoint' },
        { t: 'heat', level: 2 },
        { t: 'timer', secs: 240, label: 'Crew goes home in' },
        say('DESS', 'A ton of rivets and the whole Harbor Patrol. It is like towing, with witnesses.', true),
        { t: 'deliver', tag: 'rivets', at: bridgeFoot, r: 11, text: 'Drive the rivets to the foot of the Perpetual Bridge: north end of Calamity Ave.' },
        { t: 'timer', secs: 0 },
        { t: 'checkpoint' },
        say('FOREMAN', 'Rivets! Right. Forty-five seconds to bolt it down. Nobody touch the truck. Nobody arrest the truck.'),
        { t: 'survive', secs: 45, at: bridgeFoot, r: 70, text: 'Hold the foot of the bridge while the crew bolts the span down.' },
        say('VANCE', 'A span! I am told I was instrumental. Ms. Marlowe, the Authority has found your gate to be "administratively ajar".', true),
        { t: 'loseHeat', text: 'It is done. Lose the Harbor Patrol one more time.' },
        say('DESS', 'Ajar. Eleven years for a bridge, one week for a gate. I will take ajar.'),
      ],
    },

    // ── Tepid Falls ──
    {
      id: 't01', title: 'Run of the Mill', giver: 'mill', stage: 1, reward: 600, points: 350,
      intro: 'The Threadbare mill lost five bolts of cloth off the back of a cart. In Tepid Falls this is news.',
      unlocks: 'Loom Row knows your truck now. There is more work up the hill when the college opens.',
      steps: [
        say('ODILE', 'You are from the island. We heard it had a bridge now. We had a vote on whether to be pleased.'),
        say('DESS', 'How did it go?'),
        say('ODILE', 'Tied. Five bolts of worsted fell off a cart between here and the dam. Bring them back and I will break the tie myself.'),
        { t: 'timer', secs: 240, label: 'Shift ends in' },
        { t: 'collect', r: 5, text: 'Collect the five bolts of cloth around Loom Row before the shift ends.', items: [P(173, -1500), P(173, -1404), P(167, -1184), P(73, -1291), P(73, -1184)] },
        { t: 'timer', secs: 0 },
        { t: 'checkpoint' },
        say('DESS', 'Worsted. It even sounds like how the day went.', true),
        { t: 'goto', at: P(170, -1289), r: 10, text: 'Bring the cloth back to Odile at Bobbin St.' },
        say('ODILE', 'All five, and dry. Motion carries: we are pleased. Do not let it go to your head; we may reconsider.'),
      ],
    },
    {
      id: 't02', title: 'Extra Credit', giver: 'dean', stage: 3, reward: 800, points: 450,
      intro: 'Somebody is selling the answers to an exam nobody has written yet. The Dean wants to know who, discreetly.',
      unlocks: 'Dithers College has made you an honorary Fellow of Vehicular Studies. There is no stipend.',
      steps: [
        say('DEAN FENWICK-OHM', 'Dithers College has an honor code, Ms. Marlowe. Nobody has read it, which is how we know it is working.'),
        say('DESS', 'And you need a tow-truck driver because.'),
        say('DEAN FENWICK-OHM', 'Because the Provost drives a hatchback full of exam papers off campus every afternoon, and I cannot follow him. I have tenure, not a licence.'),
        { t: 'spawnVehicle', tag: 'prov', kind: 'hatch', at: P(-347, -1512), h: Math.PI, color: 0x4a4e69 },
        { t: 'goto', at: P(-353, -1470), r: 12, mode: 'car', stop: true, text: 'Wait in a vehicle on Chapel Hill Rd, below the Provost\'s grey hatchback.' },
        { t: 'checkpoint' },
        { t: 'tail', tag: 'prov', speed: 10, near: 13, far: 120, text: 'Follow the Provost. Academics check their mirrors more than you would think.', route: streetRoute(plan, P(-350, -1505), P(-590, -1840)) },
        say('DESS', 'He is selling them out of the boot at the Thruway exit. Entrepreneurial, for a classicist.'),
        { t: 'despawn', tag: 'prov' },
        { t: 'race', par: 120, r: 12, mode: 'car', text: 'Get back up Dithers Hill before the faculty meeting ends.', cps: [P(-590, -1840), P(-480, -1840), P(-480, -1735), P(-480, -1626)] },
        say('DEAN FENWICK-OHM', 'The Thruway exit! We shall form a committee. He will chair it, naturally; he has the experience.'),
      ],
    },
    {
      id: 't03', title: 'Exit Strategy', giver: 'marge', stage: 4, reward: 1000, points: 600,
      intro: 'The Thruway has three exits and one toll collector, who has no booth and a great many opinions.',
      unlocks: 'That is every job in the file. The Harbor Authority has run out of forms for you, which has never happened before.',
      steps: [
        say('MARGE', 'They built the Thruway and forgot the booth. So I stand here. I have collected four dollars since March, all of it from people who felt sorry.'),
        say('DESS', 'What do you need?'),
        say('MARGE', 'A record. Somebody drives the whole Thruway, end to end, fast enough that the county has to admit it goes somewhere. Then they will build my booth.'),
        { t: 'getVehicle', text: 'Get in something quick.' },
        { t: 'checkpoint' },
        { t: 'race', par: 150, r: 14, mode: 'car', text: 'Drive the whole Thruway, south to north, inside the time.', cps: [P(-700, -1080), P(-700, -1295), P(-700, -1505), P(-700, -1735), P(-700, -1955), P(-700, -2060), P(-590, -2060)] },
        { t: 'heat', level: 2 },
        say('DESS', 'And there is the county, admitting it.', true),
        { t: 'checkpoint' },
        { t: 'loseHeat', text: 'That was noticed. Lose the patrol.' },
        { t: 'goto', at: P(-590, -1174), r: 12, text: 'Go back to Marge at Offramp Rd.' },
        say('MARGE', 'End to end! I timed it on my good watch. The county says the booth is "under review". That is the nicest thing they have ever said to me.'),
      ],
    },
  ];
  return { givers, missions };
}
