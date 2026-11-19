# Brief: go all out on the cars

Read tools/briefs/common.md first and follow it. Its tool-call and image limits are raised for this
task (about 160 tool calls, 44 images); its other rules stand.

The owner has said: "Go all out on these Blender models." Read PLAN.md "Realistic rework, step (b)"
and "Owner requests, Nov 19 morning", then tools/blender/cars.py (twelve vehicles from one parameter
table plus a d_<kind>() detail function each), src/ent/vehicleAssets.ts (the loader: LOD0, LOD1,
WHEEL0, WHEEL1, materials by name, baked AO in vertex colours, no UVs today) and the drawing code in
src/ent/vehicle.ts. Blender 5.2 is at "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"
(headless; probe its API before relying on an operator). Other engineers are working on the mainland
buildings, the people and the vegetation: touch none of their files.

YOU OWN: tools/blender/cars.py, public/models/<kind>.glb (and any texture files the cars need),
src/ent/vehicleAssets.ts, src/ent/vehicleModels.ts, and the drawing code in src/ent/vehicle.ts
(not its physics).

Honest state today: smooth, correct silhouettes, but lamps are flat coloured panels, bumpers read as
separate tubs, the bus doors are slabs, no shut-lines on tailgates, no badges, rims render dark,
paint reads satin, glow sprites sit off the lenses, the detail mesh casts no shadow, and LOD1 is the
plain cage. The 2017 Chevy Bolt (kind `bolt`, the one real car, by the owner's request) is "not yet a
faithful likeness": nose too blunt and upright, tail lamps too short, window-line kink too gentle.

Make them as close to real cars as a browser game can carry, in this order (each step exported,
loaded and looked at in the game before the next; do the Bolt FIRST in every step, then the
high-traffic kinds: sedan, hatch, pickup, van, taxi, then the rest):

1. THE BOLT, FAITHFULLY. Rework it into a recognisable 2017 Chevrolet Bolt EV: the rounder, lower nose
   with the shield-shaped closed panel and slim swept-back headlamps reaching into the wings, the
   short bonnet flowing into a far-forward windscreen, the floating roof with a pronounced upswept
   kink at the rear door, tall tail lamps split between body and tailgate, black cladding and arch
   trims, bright machined five-spoke two-tone alloys, roof rails, the correct stance. It is black, so
   it needs reflections and trim contrast (gloss black paint, satin black cladding, chrome window
   surround, bright lamp internals) to read.
2. BODYWORK. Panels with real shut-lines (doors, bonnet, boot or tailgate, fuel or charge flap) as
   modelled grooves, bumpers that are part of the body's surfacing with proper joins, wheel-arch
   lips, sills, window surrounds and seals, wipers, door handles and mirrors with housings and glass,
   aerials, roof rails or racks where the type has them, tow hooks, number plates front and rear with
   invented Port Calamity plate text, and invented maker badges (each invented make gets a small
   emblem; the Bolt keeps its bowtie).
3. LAMPS. Housings with depth: reflector bowls, projector lenses, separate indicator, reverse and
   brake sections, clear and red lens covers with internal ribbing, daytime running strips where the
   type would have them, a third brake light, side repeaters. In the game each section lights
   independently (headlamps, tail, brake, reverse, indicators blinking when the AI or player turns if
   that is cheap), and the glow sprites sit exactly on the lenses.
4. WHEELS AND UNDERSIDE. Tires with tread and sidewall lettering (invented), rims per kind with real
   spoke designs, brake discs and calipers visible behind them, wheel nuts and centre caps, mud flaps
   on the trucks; a believable underside (floor pan, exhaust and silencer where there is an engine,
   axles, suspension arms) so cars look right when they roll, jump or burn. Dual rear wheels on the tow
   truck and bus if the loader is extended to carry a second wheel node.
5. INTERIORS. Dashboard with instrument binnacle and vents, steering wheel with spokes and column,
   seats with bolsters and headrests, door cards, centre console, gear lever or stalk, rear shelf,
   floor; the bus with rows of seats, grab poles and a driver's cab; the van's cargo bay; the tow
   truck's cab and its deck gear (winch drum, cable, hook, light bar, toolboxes, stowed chains); the
   taxi's partition and meter; the cruiser's cage and radio. Seen through glass that is properly
   transparent at the near level of detail, with tint and reflections.
6. THE WEAK ONES. Bus: real recessed glazed bi-fold doors, a kneeling front step, mirrors on arms, a
   route display, roof air-conditioning pods, under 450 kB. Van: a lit cab, ribbed sides, barn doors
   with hinges and handles. Coupe: give it features of its own so it is not mistaken for the muscle
   car. Muscle and sports: proper scoops, intakes, diffuser and wing rather than boxes.
7. MATERIALS AND TEXTURES. UV-unwrap and bake in Blender from a high-detail version: tangent-space
   normal maps (panel gaps, grille mesh, vents, tread, fabric), ambient occlusion, roughness and
   metalness where it helps, packed into small atlases shared across kinds where possible (aim for
   about 1 MB of textures per vehicle or less; say what the total download becomes). In the game: car
   paint with clearcoat and metallic flake that actually reads glossy under the sky (fix the satin
   look; check the environment map intensity and the sun highlight), chrome, satin and gloss plastics,
   rubber, glass with correct reflections and tint, emissive lamp sections, bright machined rims.
   Dirt and wear as a per-instance amount (clean showroom to dusty) if a mask makes it cheap.
8. LEVELS OF DETAIL AND COST. LOD0 for close up (about 40-60k triangles including interior and wheels),
   LOD1 for the middle distance (about 8-12k, close to today's LOD0), LOD2 far and for the phone preset
   (about 1.5-2.5k, with lamps and glass that survive). Switch by distance with hysteresis, at most a
   few LOD0 cars at once (the player's and the nearest), and keep draw calls per kind low (merge by
   material; the detail mesh must cast shadows at LOD0). A street of thirty parked cars must not cost
   more frame time than today at high, and the phone preset must not get slower: measure both before
   and after, with numbers.

CHECK: Blender render sheets for every vehicle (front, rear and side three-quarters, interior, a wheel
close-up); in the game, the Bolt and each kind at 3 m and 15 m by day, at golden hour and at night
with every lamp section working, the chase-camera view, a parked row, a traffic queue at a red light,
and one car burning and one wrecked to confirm those states still look right; numbers before and
after (draw calls, triangles, ms per frame on a busy street at high and with q=low, download size).
Judge honestly against a good recent game's traffic cars, and for the Bolt against the real car; say
what still gives each one away.
