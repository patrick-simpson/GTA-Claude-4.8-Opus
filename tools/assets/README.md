# Asset pipeline: smaller downloads, less video memory

`public/models` holds the sources (Blender exports and the pictures baked beside them). They are never touched.
`vite build` makes the copies the site ships, by `tools/assets/optimize.mjs`, and lays them over `dist/models`.

## What it does to what

| input in public/models | output in dist/models | what changes |
| --- | --- | --- |
| every `*.glb` | same name | meshopt compressed; normals 10 bit, colours 12 bit, texture coordinates 16 bit (when all of the file's UVs are inside 0..1); duplicate accessors merged. Positions stay float32 and no node, material, mesh or empty is touched or renamed. Textures embedded in a glb (none today) become KTX2 by slot: normal map UASTC, colour ETC1S sRGB, roughness/occlusion ETC1S linear, names with logo / sign / decal / label UASTC. |
| every `*.webp` `*.png` `*.jpg` not on the `raw` list | the picture stays, plus `<name>.ktx2` | KTX2 with a full mip chain. UASTC for normals (`_n _bn _nrm`), `damage`, masks, logos and signs; ETC1S (quality 255) for colour, occlusion and `_lm` lightmaps. |
| (generated) | `ktx.json` | picture name -> `.ktx2` name. The build also bakes it into the code as `__KTX__`. |

Pictures that are read pixel by pixel (the car normal/occlusion maps are packed into shared atlases, flora is merged with
its alpha mask in JS) are on the `raw` list in `config.json` and get no `.ktx2`. Anything not on that list is converted.

Nothing to register: a new `.glb` or picture in `public/models` is picked up by the next build. Results are cached by
content hash in `node_modules/.cache/pc-assets`, so only changed files cost time (a cold run is about 15 s on the laptop).

## Where the outputs go, and why

Written to a cache and laid over `dist/models` at the end of the build (same names for glbs, `.ktx2` beside the picture),
not into `public/models` and not to a parallel folder:
- the sources stay the sources (Blender scripts and other workers write there; nothing is committed twice);
- the game asks for the same `models/x.glb` URLs in dev and in production, so no loading code changes. A meshopt glb and an
  untouched one load through the same `GLTFLoader` (patched once in `src/core/ktx.ts`);
- pictures keep their `.webp` as the fallback, in dist as well, so `?ktx=0` and a browser that cannot run the transcoder
  both just load the originals.
The dev server serves the originals (no `__KTX__`, nothing swapped). `ASSETS_OPT=0 npm run build` ships the originals too.

## In the game (`src/core/ktx.ts`)

- Every `GLTFLoader` gets `MeshoptDecoder` and the KTX2 loader on first `parse` (prototype patched once; the loaders'
  own code is unchanged).
- `assets.plan()` swaps a planned picture for its `.ktx2` (`ktxUrl`), so the download queue and the title card's byte
  count follow what is really fetched (`__MODEL_BYTES__` holds the optimized sizes).
- `loadKtx(url, { srgb, flip })` returns a compressed texture, or null (no `.ktx2`, `?ktx=0`, decode failed), then the
  caller loads the original as it always did. Used by `loadTexture` (mainStreetAssets.ts; brick maps and baked
  occlusion), `carDamage.ts` and `pardonsStock.ts` (lightmap). `flip` is the bitmap flip the old code applied; it is done
  as a UV transform, which only works for textures a material samples (`map`, `normalMap`, `aoMap`). For a texture a custom shader samples,
  add the file to `flip` in `config.json` instead (the pipeline flips the rows) and pass `flip: false`.
- The transcoder (`basis_transcoder.js/.wasm`) is copied from three into `public/basis` by `vite.config.ts` on every start.
- Compressed formats the card has (BC7, ASTC, ETC2, S3TC) are picked by KTX2Loader; with none it transcodes to RGBA8.
- Do not wrap `onBeforeCompile` anywhere here; nothing in this pipeline touches materials, `warmup.ts` or `snowCover.ts`.

## Adding things

- New model: drop the `.glb` in `public/models`. Read its geometry through `.getAttribute(...).getX()` (not `.array as Float32Array`):
  normals, colours and UVs are normalized integers in the shipped copy. Reading positions as floats is still fine.
- New picture read as a texture by a material: load it with `loadTexture` (or `loadKtx`), plan it with the `.webp` name as before.
- New picture read pixel by pixel (`createImageBitmap` + canvas): add a regex to `raw` in `config.json`.
- New picture sampled by your own shader: see `flip` above.
- Rules by name live in `config.json` (`uastc`, `etc1s`, `srgb` are regexes on the name without extension). Change them, bump `VERSION` in `optimize.mjs` only if the encoder settings change (the config is part of the cache key).

## Tools

- `node tools/assets/optimize.mjs [--out dir] [--only substr] [--force] [--verify]`: run it alone; `--verify` reads every result back and compares node, material, mesh and skin counts and names with the source.
- Needs `toktx` (KTX-Software 4.4.2). Found via `KTX_BIN`, PATH, `C:/Users/User/KTX-Software/bin`, `C:/Program Files/KTX-Software/bin`, `/usr/bin`. Without it, glbs are still compressed and pictures stay webp. The deploy workflow installs it from Khronos' release `.deb`.
- `tools/assets/measure.mjs`: served-bytes, texture video memory (every upload counted) and the picture set of a dist folder.
- `tools/assets/netload.mjs`: cold load through DevTools throttling (4g: 9 Mbit/s 60 ms, f3g: Fast 3G 1.6 Mbit/s 150 ms).
- `tools/assets/rafprobe.mjs`: `tools/lead/rafprobe.mjs` on a dist folder, `--mobile` for the phone page.
