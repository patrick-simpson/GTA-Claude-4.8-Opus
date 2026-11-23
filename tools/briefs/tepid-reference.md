# Tepid Falls after the real downtown: reference for modellers

Written for unit 1 of tools/briefs/tepid-waterville.md. **No real place or business name goes into the game**; the
names below are the game's own. Pictures behind these notes are kept in scratch/tepid/ref/ (git-ignored) and are
never copied into public/ or src/. Sources: the National Register nomination for the town's Main Street Historic
District (2012, 67 pages; text extracted to scratch/tepid/ref/nrhp_main.txt, building-by-building descriptions in
its Section 7), and four freely licensed Wikimedia Commons street photographs (CC BY-SA 2.0/3.0/4.0 and public
domain), seen for proportion and colour only. No Street View captures were taken in unit 1.

## The arrangement, and how it maps onto the Tepid Falls map we already have

The real downtown is one long north-south Main Street of party-wall brick blocks, two to four storeys, built to the
sidewalk with diagonal parking, wide concrete walks, small street trees and decorative lamp posts on both sides.
The river (falls, mills and the old toll footbridge) lies east and downhill; a very large surface parking lot fills
the space between the backs of the east-side blocks and the riverfront street. A small square with the city
hall / opera house opens off the street near its middle, at the one cross street that leads to it. The college
stands apart on a hill to the west; wooden triple-decker neighbourhoods fill the flats south and north.

Tepid Falls already has the same bones, so the map stays and the buildings move to fit it:

| Real place | Tepid Falls (existing) | Notes |
|---|---|---|
| Main Street | **Main St** (x = 70, z -1080 to -2060) | arrival from the bridge landing at the south end (Front St, z -1080) |
| the square with city hall / opera house | **Quorum Square** + **Postponement Hall** (x -30..70, z -1505..-1400) | west of Main, as the real one; the cross street analogue is **Bobbin St** (z -1505) |
| the big lot behind the east blocks | to build: **The Holding Pattern** (interior of the i=7 blocks, x 85..165, z -1500..-1190) | unit 2 |
| riverfront street | **Water St** (x 170) | |
| the mills | **Threadbare mill** (exists, Loom Row) + to build: **Lackwool Mill** | unit 3 |
| the toll footbridge | **Exact Change Footbridge** (exists) | |
| the falls | **Threadbare Dam** (exists) | |
| the college on the hill | **Dithers College** on Dithers Hill (exists) | unit 6 |
| triple-decker flats | **The Stacks** (exists) | unit 5 |

## Main St (unit 1: built)

The real street's district runs about 400 m. Order below is south to north along each side, as now placed in Tepid
Falls between Front St and Bobbin St (`ORDER` in src/world/mainStreetAssets.ts). The east side starts with the
gabled row because it is what the player sees first on arriving; on the real street that row stands at the north
end. Colours are sRGB hex; heights in meters from the sidewalk; "bay" = one window column.

### East side (x 83.5, facing west, backs onto The Holding Pattern)

1. **Second Guess Blocks** (design `secondguess`, placed twice = the six-block row). Queen Anne, 1886-93. 3 storeys
   (4.6 / 3.8 / 3.7), six 3-bay blocks each about 7.6 m wide (row about 46 m). Dark red brick `#7d3b2d`, granite
   piers at street level continuing as brick pilasters to the cornice; granite belt course doubling as the
   second-floor sill line, another under the third floor; second floor 1/1 sash under segmental brick arches with
   brick panels over, third floor under splayed brick lintels; wooden cornice painted dark `#3b3730` across the
   whole row; over each block a closed pediment gable 2.3 m high laid with a zigzag brick panel, triangular on
   blocks 1, 3, 4, 6 and segmental-arched on 2 and 5; granite name plaques in the gables. The north end keeps a
   cast-iron storefront. Name plaques are blank in the game.
2. **Hemming & Hawing Hardware** (`hemming`). 1894. 4 storeys (4.6 / 3.6 / 3.5 / 3.5), 3 bays, about 9.8 m. Red-brown
   brick `#86432f`; each bay a PAIR of 1/1 sash under one splayed brick arch, continuous granite sills across the
   front at each floor; decorative corbelled brick cornice between two small corbelled piers. Full-height
   aluminium shopfront with double doors, a separate door to the floors above.
3. **Monotony Ward** (`monotony`). 1938 department store, Georgian Revival. 3 storeys (5.0 / 3.7 / 3.6), 7 bays, about
   24 m. Brick `#8a4332` in common bond, white trim `#f1ede2`; 6/6 sash with stone flat lintels and keystones;
   slate mansard `#4f545a` with a gabled dormer over each bay; wide display windows with recessed entries.
4. **Lukewarm Trust Co.** (`lukewarm`). 1936, the one Art Deco front. 4 storeys (5.0 / 3.6 / 3.6 / 3.6), 6 bays, about
   15.4 m. Buff brick `#cdb791` with limestone `#d8d0bd`; vertical piers running up through a stepped parapet, dark
   metal spandrel panels `#3a3f3e` between floors; storefronts in aluminium over marble bulkheads.
5. **The Bleached Block** (`bleached`). About 1912, blonde brick `#d2bf96`, 3 storeys, 3 bays, about 10.2 m, flat roof;
   plain Commercial Style, stone band cornice; storefront of granite bulkheads and a recessed entry.

### West side (x 56.5, facing east toward the river)

1. **Overdue Row** (`overdue`, placed as halves of the real twelve-bay row). 1836 Greek Revival, raised to 4 storeys
   with a flat roof in 1924 (4.4 / 3.4 / 3.3 / 3.2), 6 bays per half, about 15.6 m. Brick `#91503b`, granite flat
   lintels and sills, plain stone cornice; concrete "name blocks" between the third and fourth floors.
2. **The Chaperone Block** (`chaperone`). 1909. 4 storeys, 3 bays, about 8.8 m. Brick `#9a5640`; 1/1 sash with
   concrete sills and splayed brick lintels, a decorative brick belt course between floors; narrow brick piers up
   the sides; corbelled cornice.
3. **Pressed-for-Time Block** (`pressed`, three sections side by side). 1883 Romanesque Revival by a Portland firm.
   3 storeys (4.5 / 3.7 / 3.7), three sections of 3 bays each, about 9 m per section. Pressed red brick `#7a2c22` with
   grey sandstone trim `#9d998d`; flat-headed second floor, round-arched third floor with stone voussoirs; recessed
   entries in each storefront.
4. **Grid & Bear It Building** (`gridbear`). 1911 Commercial Style. 3 storeys, about 10.4 m: five bays of pressed
   sheet-metal framing `#55625a` set in a grid between two wide brick piers (`#8e4a38`), raised panels between the
   floors; porcelain-enamel panels on the shopfront piers.
5. **Jack-of-Some-Trades Co.** (`jack`). 1912 Colonial Revival. 2 storeys (4.6 / 3.8), 4 bays, about 10 m. Brick
   `#8c4637`, white trim; a deep steel beam with cast bolt-head ornaments over a wide shopfront with a central
   recessed entry and a retractable canvas awning.
6. **Scraping-the-Barrel Block** (`barrel`). 1850 north half Greek Revival, 1874 south half Italianate. 3 storeys, 6 bays,
   about 13.8 m. Brick `#8f4e3a`; 12/12 sash (9/9 flanking) with granite sills and cast-iron lintels with anthemion
   ornaments (north); arched brick hoods (south, not yet modelled).
7. **Small Change Five-and-Ten** (`smallchange`). About 1950. 2 storeys (4.8 / 3.6), about 19.6 m. Buff brick `#cbb68c`;
   a band of high display windows, a very wide signboard, a soldier course under small paired 1/1 sash upstairs.

Not yet placed (for unit 4, civic): the **Hush-Hush Lodge Block** (1890 Romanesque Masonic block on the square's cross
street: 4 storeys, symmetrical, three storefronts between rusticated granite piers carrying granite lintels, six
bays narrowing outward), and the **Middling Block** (3 storeys, cast-iron columns dividing six storefront bays with
leaded transoms, arched multi-pane windows).

Street furniture seen on the real street: black decorative lamp posts with globe heads and hanging flower baskets,
small maples and lindens in the walk, flags on the lamp posts, benches, blue post-office-style drop boxes, diagonal
parking marked in white, a raised island at the square.

## For the later units (numbers to start from; check against Street View before modelling)

- **The Holding Pattern** (the big lot): about 300 m x 80 m of asphalt in rows of diagonal stalls with planted islands,
  lamp standards every 30 m, the plain brick backs of the east-side blocks along one edge with rear doors, fire
  escapes and service sheds; pedestrian alleys through to Main St.
- **Lackwool Mill** (the large riverside mill): five storeys, 300 m long, red brick `#8a4433`, regular bays of tall
  segmental-arched windows (12/12) about 2.2 m apart, a central stair tower with a pyramidal roof, low-pitched roof,
  stone foundation on the riverbank. **Threadbare mill** (exists) follows the shirt factory: 4-5 storeys, brick with
  a square tower and a tall round chimney.
- **Churches**: **Our Lady of Perpetual Hesitation** (large twin-towered brick and granite church, about 45 m towers);
  **First Church of the Lukewarm** (white clapboard, tall steeple with a clock stage, about 40 m); **St. Dither's**
  (stone Gothic Revival, one corner tower).
- **Postponement Hall** (exists, the city hall / opera house, 1902): 3 storeys, red brick and limestone, Colonial
  Revival, central pedimented pavilion, a cupola with a clock; faces the square.
- **The Dead Letter Office** (the 1911 federal post office): Beaux-Arts, granite or marble, one tall storey over a
  raised basement, a colonnade between end pavilions, broad steps.
- **The Stacks** (triple-deckers, exists): 3 storeys of wood, flat or low hip roof, stacked full-width porches on
  turned posts, clapboard in `#e8e4d8`, `#97a685`, `#c7a544`, `#6f7d8c`, `#8a3b2e`; colonials and capes with maples.
- **Dithers College** (exists): Georgian Revival red brick `#8a3f30` quadrangles with white trim and slate roofs, a
  library with a tall white spire (about 60 m, the town's landmark from the bridge) and the **Chapel of Second
  Thoughts** with its own white spire; the library should carry the name **The Overdue Library**.
