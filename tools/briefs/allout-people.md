# Brief: go all out on the people

Read tools/briefs/common.md first and follow it. Its tool-call and image limits are raised for this
task (about 150 tool calls, 40 images); its other rules stand.

The owner has said: "Go all out on these Blender models." The people are currently smooth mannequins:
a mask face with a wedge nose, mitten hands, clothes that are tinted body surface, one roughness for
skin and cloth. Read PLAN.md "Realistic rework, step (c) people", then tools/blender/people.py,
src/ent/characterAssets.ts and src/ent/character.ts. Blender 5.2 is at
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" (headless; probe its API before
relying on an operator). Other engineers are working in src/world/ and on the cars: touch neither.

YOU OWN: tools/blender/people.py, public/models/person*.glb (and any texture files the models need),
src/ent/characterAssets.ts, src/ent/character.ts.

Make them as close to real people as a browser game can carry, in this order (each step exported,
loaded and seen walking in the game before the next):

1. HEADS AND FACES. A properly modelled head for each body: skull shape, brow ridge, eye sockets with
   separate eyeballs (iris and pupil), eyelids, a real nose with nostrils and bridge, lips with a
   philtrum, chin and jaw, cheekbones, ears with a helix. Several face variants per body (at least
   four: different jaw, nose, brow, age) selectable per person, so a crowd is not clones. Subtle
   expression at rest. Blinking and a small eye and head look-at driven from the game if the rig makes
   it cheap.
2. HANDS. Real hands with four fingers and a thumb at the near level of detail, relaxed curl, able to
   close for a fist, a grip on a steering wheel and a grip on a weapon (three hand poses is enough).
3. CLOTHING AS CLOTHING. Garments with their own silhouette and thickness instead of painted skin:
   T-shirt, button shirt with collar, hoodie, jacket, work coveralls (Dess), trousers, jeans, shorts,
   skirt, dress, boots, sneakers, with folds at elbows, knees and waist, cuffs, hems, pockets, belts,
   zips and buttons as geometry or baked detail. Mix and match per person from the Look (top, bottom,
   shoes, hat) plus a style index, so the crowd varies. Hats: cap (peak forward or back), beanie, a
   brimmed hat. Glasses for some. Bags for some.
4. HAIR. Real hairstyles built from shaped shells and hair cards: short crop, side part, long, ponytail
   (Dess), bun, curls, afro, balding, plus beard and stubble options.
5. MATERIALS AND TEXTURES. UV-unwrap the models and bake in Blender: tangent-space normal maps from a
   high-detail version (cloth folds, seams, facial detail), ambient occlusion, and where it helps a
   roughness map. Skin, cloth, leather, rubber and hair must each look like what they are (different
   roughness, a soft sheen on cloth, a little subsurface warmth on skin faked in the shader). Pack the
   maps into small atlases (keep each person type to about 1 MB of textures, shared across variants)
   and keep per-person colour tinting working through masks or vertex colours.
6. LEVELS OF DETAIL. LOD0 for close up (around 12-18k triangles with fingers and face), LOD1 for the
   middle distance (about 3-4k), LOD2 for far crowds (about 600-900) and the phone preset. The whole
   crowd must still draw in a handful of calls with the existing bone-texture skinning; measure the
   frame cost with 60 people on screen at high and with q=low and keep it close to today's.
7. MOTION. With the new bodies, redo the gait so feet plant and roll heel to toe without sliding (the
   stance foot currently drifts about a tenth of the body's travel when running), add a real walk for
   the player at low speed, natural arm swing, weight shift when standing, a proper seated pose for
   benches (not the driving pose), the knocked-down and getting-up motions, and upper-body aim.

Dess must be unmistakable: a woman in navy work coveralls with a vermilion cap and a ponytail,
competent and tired.

CHECK: Blender render sheets of each body and face variant (front, side, three-quarter, a hand close-up,
a bent elbow and knee); in the game, close-ups of Dess standing, walking, sprinting, aiming, seated on
a bench and at a wheel, swimming, and a sidewalk crowd at 2 to 20 m by day, at dusk and at night; a
frame-by-frame strip of the run to check the feet; numbers before and after (draw calls, triangles,
ms per frame, download size of the model and texture files). Judge honestly against "a person in a
good recent game", and say what still gives them away.
