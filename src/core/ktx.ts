// Compressed models and pictures (tools/assets/optimize.mjs makes them at build time; tools/assets/README.md).
//
//  - Models: every GLTFLoader gets the meshopt decoder and a KTX2 loader the first time it parses (the prototype is
//    patched once, here), so no loading site has to change. Files that are not compressed load exactly as before.
//  - Pictures: the build writes a .ktx2 beside each picture that is read as a texture and lists them in __KTX__
//    (picture file name -> .ktx2 file name; empty in the dev server, which serves the originals). `ktxUrl` says which
//    file to download and `loadKtx` turns the download into a texture on the GPU in its compressed form (BC7, ASTC
//    or ETC2, whichever the card takes: a quarter to an eighth of the video memory of the same picture as RGBA8, with
//    its mipmaps already in the file). Pictures that are read pixel by pixel (the car and flora maps) have no .ktx2.
//  - `?ktx=0` loads the original pictures; a .ktx2 that fails to decode falls back to its original, too.
//
// KTX2Loader wants a renderer only to ask which formats the card has, so a throw-away context answers instead and
// the game's own renderer is not needed here.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { assets } from './assets';

declare const __KTX__: Record<string, string> | undefined;

const MAP: Record<string, string> = typeof __KTX__ === 'object' && __KTX__ ? __KTX__ : {};
/** Pictures come as .ktx2 (false with `?ktx=0`, or when the build has none). */
export const KTX_ON = new URLSearchParams(location.search).get('ktx') !== '0' && Object.keys(MAP).length > 0;

const base = (u: string): string => u.replace(/^.*\//, '');

/** The file to download for this picture: its .ktx2 when there is one and they are on, else itself. */
export function ktxUrl(url: string): string {
  if (!KTX_ON) return url;
  const k = MAP[base(url)];
  return k ? url.slice(0, url.length - base(url).length) + k : url;
}

let loader: KTX2Loader | null | undefined;
/** The shared KTX2 loader; null if this browser cannot run its transcoder. */
export function ktx2Loader(): KTX2Loader | null {
  if (loader !== undefined) return loader;
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2');
    const has = (n: string): boolean => !!gl && (!!gl.getExtension(n) || !!gl.getExtension('WEBKIT_' + n));
    // The few lines of a renderer that detectSupport reads.
    const fake = { extensions: { has } } as unknown as THREE.WebGLRenderer;
    loader = new KTX2Loader().setTranscoderPath(new URL('basis/', document.baseURI).href).setWorkerLimit(2).detectSupport(fake);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    loader = null;
  }
  return loader;
}

interface Decoder { _createTexture(buf: ArrayBuffer): Promise<THREE.Texture> }

/**
 * A picture as a compressed texture, or null if it has no .ktx2, they are off, or it would not decode (the caller then
 * loads the original). `flip` is the vertical flip the caller's old path applied to the bitmap (a texture's rows are
 * not flipped on upload, so it is done as a sample transform instead, which gives the same picture).
 */
export async function loadKtx(url: string, o: { srgb: boolean; flip: boolean; anisotropy?: number }): Promise<THREE.Texture | null> {
  const k = ktxUrl(url);
  if (k === url) return null;
  try {
    const l = ktx2Loader();
    const buf = l && await assets.bytes(k);
    // The dev server answers a missing file with the index page, which is not a KTX2 file.
    if (!l || !buf || buf.byteLength < 80 || new Uint8Array(buf, 1, 5).join() !== '75,84,88,32,50') return null;
    const t = await (l as unknown as Decoder)._createTexture(buf);
    t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = o.anisotropy ?? 4;
    if (o.flip) { t.repeat.y = -1; t.offset.y = 1; }
    return t;
  } catch {
    return null;
  }
}

// Every GLTFLoader decodes meshopt and KTX2 without being told.
const proto = GLTFLoader.prototype as GLTFLoader & { __ktx?: boolean };
if (!proto.__ktx) {
  proto.__ktx = true;
  const parse = proto.parse;
  proto.parse = function (this: GLTFLoader, ...a: Parameters<GLTFLoader['parse']>): void {
    if (!(this as unknown as { meshoptDecoder?: unknown }).meshoptDecoder) this.setMeshoptDecoder(MeshoptDecoder);
    if (!(this as unknown as { ktx2Loader?: unknown }).ktx2Loader) { const l = ktx2Loader(); if (l) this.setKTX2Loader(l); }
    return parse.apply(this, a);
  };
}
