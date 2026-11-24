// The asset pipeline (see tools/assets/README.md). Sources stay in public/models; this makes the smaller copies the
// production build ships:
//   every .glb      -> meshopt compressed, normals / colours / texture coordinates quantized, duplicate buffers merged
//                      (positions stay float32 and no node is touched: the game reads geometry ignoring node transforms)
//                      embedded textures (none today) -> KTX2 (KHR_texture_basisu)
//   every picture   -> a .ktx2 beside it (mipmaps; UASTC for normals, masks, logos and signs, ETC1S for colour and
//                      occlusion), unless it is on the `raw` list of tools/assets/config.json (read pixel by pixel)
//   ktx.json        -> what got a .ktx2, for the loader (src/core/ktx.ts)
// Results are cached by content hash in node_modules/.cache/pc-assets, so a build only pays for what changed.
//
//   node tools/assets/optimize.mjs                         everything -> node_modules/.cache/pc-assets/models
//   node tools/assets/optimize.mjs --out some/dir --only civic --force
// vite.config.ts calls optimizeAssets() for `vite build` and copies the result over dist/models (closeBundle).
// ASSETS_OPT=0 skips all of it (the build then ships the originals).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, prune, reorder, quantize, getTextureColorSpace, listTextureSlots } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
/** Bump to throw the cache away when the settings below change. */
const VERSION = 'v1';
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const RAW = CONFIG.raw.map((s) => new RegExp(s, 'i'));
const FLIP = new RegExp(CONFIG.flip, 'i');
const ETC1S_NAMES = new RegExp(CONFIG.etc1s, 'i'), UASTC_NAMES = new RegExp(CONFIG.uastc, 'i'), SRGB_NAMES = new RegExp(CONFIG.srgb, 'i');

/** toktx: KTX_BIN, the PATH, or where the installers put it. */
function findToktx() {
  const exe = process.platform === 'win32' ? 'toktx.exe' : 'toktx';
  const dirs = [process.env.KTX_BIN, ...String(process.env.PATH || '').split(path.delimiter),
    'C:/Users/User/KTX-Software/bin', 'C:/Program Files/KTX-Software/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean);
  for (const d of dirs) { const f = path.join(d, exe); if (fs.existsSync(f)) return f; }
  return null;
}

const sha = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex').slice(0, 20); };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exit ${c}: ${err.slice(0, 400)}`))));
  });
}

/** Pool of `n` at a time. */
function pool(n) {
  let active = 0; const waiting = [];
  const next = () => { while (active < n && waiting.length) { active++; waiting.shift()(); } };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

/** Which basis mode and colour space a picture gets, from its name (standalone files) or the slot it fills (glTF). */
export function textureMode(name, slot) {
  const n = name.replace(/\.[^.]+$/, '');
  const normal = slot === 'normalTexture' || /(_n|_bn|_nrm|normal)$/i.test(n);
  const uastc = !ETC1S_NAMES.test(n) && (normal || UASTC_NAMES.test(n));
  const srgb = slot ? (slot === 'baseColorTexture' || slot === 'emissiveTexture') : SRGB_NAMES.test(n);
  return { mode: uastc ? 'uastc' : 'etc1s', srgb: normal ? false : srgb };
}

/** A picture's bytes as KTX2 with mipmaps. `png` is what toktx reads. */
async function toKtx2(toktx, pngBytes, mode, srgb, tmp) {
  const id = sha(pngBytes, mode, String(srgb));
  const inp = path.join(tmp, id + '.png'), outp = path.join(tmp, id + '.ktx2');
  fs.writeFileSync(inp, pngBytes);
  const common = ['--t2', '--genmipmap', '--assign_oetf', srgb ? 'srgb' : 'linear', '--assign_primaries', 'none', '--threads', '2'];
  const enc = mode === 'uastc' ? ['--encode', 'uastc', '--uastc_quality', '2', '--zcmp', '18'] : ['--encode', 'etc1s', '--clevel', '4', '--qlevel', '255'];
  try { await run(toktx, [...common, ...enc, outp, inp]); return fs.readFileSync(outp); } finally { fs.rmSync(inp, { force: true }); fs.rmSync(outp, { force: true }); }
}

/** Any picture (webp, png, jpg) as 8-bit PNG for toktx; alpha dropped when it is fully opaque. */
async function toPng(bytes, flip = false) {
  let img = sharp(bytes, { failOn: 'none' });
  const meta = await img.metadata();
  if (meta.hasAlpha) {
    const st = await sharp(bytes, { failOn: 'none' }).stats();
    if (st.channels[st.channels.length - 1].min === 255) img = img.removeAlpha();
  }
  return (flip ? img.flip() : img).png().toBuffer();
}

let ioPromise;
function getIO() {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready; await MeshoptEncoder.ready;
    return new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  })();
  return ioPromise;
}

/** Are all of this document's texture coordinates inside [0,1]? (Mixed types would break a merge of its geometries.) */
function uvsInRange(doc) {
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    for (const sem of p.listSemantics()) {
      if (!sem.startsWith('TEXCOORD_')) continue;
      const a = p.getAttribute(sem), mn = a.getMin([]), mx = a.getMax([]);
      if (mn.some((v) => v < 0) || mx.some((v) => v > 1)) return false;
    }
  }
  return true;
}

async function optimizeGlb(bytes, name, toktx, tmp, pend) {
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(bytes));
  const info = { textures: 0 };
  // Only accessors and textures are merged or dropped: the game finds materials, meshes and empties by name.
  await doc.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
    prune({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE], keepAttributes: true, keepLeaves: true }),
    reorder({ encoder: MeshoptEncoder }),
  );
  const pattern = uvsInRange(doc) ? /^(NORMAL|COLOR_\d|TEXCOORD_\d)$/ : /^(NORMAL|COLOR_\d)$/;
  // Positions are left alone (no 'POSITION' in the pattern): quantizing them moves the scale onto the nodes.
  await doc.transform(quantize({ pattern, quantizeNormal: 10, quantizeColor: 12, quantizeTexcoord: 16 }));
  // Embedded pictures: KTX2 by slot.
  const textures = doc.getRoot().listTextures();
  if (textures.length && toktx) {
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    for (const tex of textures) {
      const img = tex.getImage();
      if (!img || tex.getMimeType() === 'image/ktx2') continue;
      const slotName = listTextureSlots(tex)[0] ?? '';
      const m = textureMode(tex.getName() || name, slotName);
      const srgb = slotName ? m.srgb : getTextureColorSpace(tex) === 'srgb';
      pend.push(toPng(Buffer.from(img)).then((png) => toKtx2(toktx, png, m.mode, srgb, tmp)).then((k) => { tex.setImage(new Uint8Array(k)).setMimeType('image/ktx2'); info.textures++; }));
    }
    await Promise.all(pend.splice(0));
  }
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return { out: Buffer.from(await io.writeBinary(doc)), info };
}

/**
 * @param {{ src?: string, out?: string, cache?: string, only?: string, force?: boolean, log?: (s: string) => void }} o
 * @returns the manifest written to <out>/ktx.json plus totals.
 */
export async function optimizeAssets(o = {}) {
  const src = o.src ?? path.join(ROOT, 'public', 'models');
  const out = o.out ?? path.join(ROOT, 'node_modules', '.cache', 'pc-assets', 'models');
  const cache = o.cache ?? path.join(ROOT, 'node_modules', '.cache', 'pc-assets', 'store');
  const log = o.log ?? ((s) => console.log(s));
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ktx-'));
  const toktx = findToktx();
  if (!toktx) log('assets: toktx not found (set KTX_BIN or install KTX-Software): pictures stay as they are, models are still compressed');
  const files = fs.readdirSync(src).filter((f) => fs.statSync(path.join(src, f)).isFile()).filter((f) => !o.only || f.includes(o.only));
  // Anything an earlier run left in the output that no longer has a source.
  for (const f of fs.readdirSync(out)) if (/\.(glb|ktx2)$/.test(f) && !files.some((s) => s === f || s.replace(/\.[^.]+$/, '.ktx2') === f) && !o.only) fs.rmSync(path.join(out, f), { force: true });
  const limit = pool(Math.max(2, Math.floor(os.cpus().length / 2)));
  const manifest = { version: 1, files: {} };
  const tot = { glbIn: 0, glbOut: 0, texIn: 0, texOut: 0, cached: 0, made: 0 };
  const t0 = Date.now();
  await Promise.all(files.map((f) => limit(async () => {
    const full = path.join(src, f), ext = path.extname(f).toLowerCase();
    const bytes = fs.readFileSync(full);
    if (ext === '.glb') {
      const key = sha(bytes, VERSION, toktx ? 'k' : 'n', JSON.stringify(CONFIG)), cf = path.join(cache, `${f}.${key}`);
      let buf;
      if (!o.force && fs.existsSync(cf)) { buf = fs.readFileSync(cf); tot.cached++; }
      else {
        const r = await optimizeGlb(bytes, f, toktx, tmp, []);
        buf = r.out; fs.writeFileSync(cf, buf); tot.made++;
        for (const old of fs.readdirSync(cache)) if (old.startsWith(f + '.') && old !== path.basename(cf)) fs.rmSync(path.join(cache, old), { force: true });
      }
      fs.writeFileSync(path.join(out, f), buf);
      tot.glbIn += bytes.length; tot.glbOut += buf.length;
    } else if (toktx && /\.(webp|png|jpe?g)$/.test(ext) && !RAW.some((r) => r.test(f))) {
      const { mode, srgb } = textureMode(f);
      const key = sha(bytes, VERSION, mode, String(srgb)), cf = path.join(cache, `${f}.${key}.ktx2`);
      let buf;
      if (!o.force && fs.existsSync(cf)) { buf = fs.readFileSync(cf); tot.cached++; }
      else {
        buf = await toKtx2(toktx, await toPng(bytes, FLIP.test(f)), mode, srgb, tmp); fs.writeFileSync(cf, buf); tot.made++;
        for (const old of fs.readdirSync(cache)) if (old.startsWith(f + '.') && old !== path.basename(cf)) fs.rmSync(path.join(cache, old), { force: true });
      }
      const kf = f.replace(/\.[^.]+$/, '.ktx2');
      fs.writeFileSync(path.join(out, kf), buf);
      manifest.files[f] = { ktx2: kf, mode, srgb, flipped: FLIP.test(f), bytes: buf.length };
      tot.texIn += bytes.length; tot.texOut += buf.length;
    }
  })));
  fs.writeFileSync(path.join(out, 'ktx.json'), JSON.stringify(manifest));
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`assets: ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s (${tot.made} made, ${tot.cached} cached); glb ${(tot.glbIn / 1e6).toFixed(1)} -> ${(tot.glbOut / 1e6).toFixed(1)} MB; pictures with a .ktx2 ${(tot.texIn / 1e6).toFixed(1)} -> ${(tot.texOut / 1e6).toFixed(1)} MB`);
  return { manifest, out, ...tot };
}

/** Copy an optimize result over a built models folder (dist/models): glbs replaced, .ktx2 and ktx.json added. */
export function overlay(out, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(dest, f));
}

/** Copy three's Basis transcoder to public/basis (the game's KTX2 loader reads it from there). */
export function copyTranscoder(root = ROOT) {
  const from = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis'), to = path.join(root, 'public', 'basis');
  fs.mkdirSync(to, { recursive: true });
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    const a = path.join(from, f), b = path.join(to, f);
    if (!fs.existsSync(b) || fs.statSync(a).size !== fs.statSync(b).size) fs.copyFileSync(a, b);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = {};
  for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ''); opt[k] = a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[++i] : true; }
  copyTranscoder();
  const r = await optimizeAssets({ out: typeof opt.out === 'string' ? path.resolve(opt.out) : undefined, only: typeof opt.only === 'string' ? opt.only : undefined, force: !!opt.force });
  if (opt.verify) {
    // Read every result back: it must decode, and keep every node and material name of its source.
    const io = await getIO();
    for (const f of fs.readdirSync(r.out).filter((x) => x.endsWith('.glb'))) {
      const a2 = await io.read(path.join(r.out, f)), b2 = await io.read(path.join(ROOT, 'public', 'models', f));
      const names = (d) => [d.getRoot().listNodes().map((n) => n.getName()).sort().join('|'), d.getRoot().listMaterials().map((n) => n.getName()).sort().join('|'), d.getRoot().listMeshes().length, d.getRoot().listSkins().length].join('#');
      if (names(a2) !== names(b2)) { console.log('MISMATCH', f); process.exitCode = 1; }
    }
    console.log('verify done');
  }
}
