// Shader warm-up: compile every material's program in the background before it is first seen, instead of in the
// frame that first draws it.
//
// three compiles a program the first time a material is drawn, and on ANGLE/D3D11 (every Windows Chrome) each one
// costs 50-150 ms of the main thread. With the snow-cover term in every lit shader, the SpeedScan tower's LODs, Pardon's
// and Tepid Falls all streaming in, a drive downtown on Nov 23 met 13 new programs in one frame (1.1 s frozen) and 7 more
// a few seconds later (0.85 s), on the RTX as on the Iris Xe (scratch/perf/progs.mjs). Here, about once a second, the
// scene is scanned for materials not seen before (or changed since: needsUpdate bumps the version); the objects that
// carry them go to renderer.compileAsync, which with KHR_parallel_shader_compile compiles and links on the browser's
// own threads and only reports back when they are ready. Without that extension (some phones), it does nothing: a
// synchronous compile up front would just move the stall.
//
// The programs must match what the frame will ask for, so the compile runs with the scene's own lights, fog and
// environment, and with the render target the scene is drawn into (Post's linear target, or the screen without Post):
// tone mapping and colour space are part of a program's key.

import * as THREE from 'three';
import type { Game } from './game';

const EVERY_MS = 1000;

/** What of an object goes into its program's key besides the material (three's WebGLPrograms.getParameters). */
function variant(o: THREE.Object3D): number {
  const x = o as THREE.InstancedMesh & THREE.SkinnedMesh & { isBatchedMesh?: boolean };
  const g = x.geometry as THREE.BufferGeometry | undefined, a = g?.attributes, mo = g?.morphAttributes;
  return (x.isInstancedMesh ? 1 : 0) | (x.instanceColor ? 2 : 0) | (x.isSkinnedMesh ? 4 : 0) | (x.isBatchedMesh ? 8 : 0)
    | (mo?.position ? 16 : 0) | (mo?.normal ? 32 : 0) | (mo?.color ? 64 : 0) | (a?.color ? (a.color.itemSize === 4 ? 128 : 256) : 0)
    | (a?.uv1 ? 512 : 0) | (a?.uv2 ? 1024 : 0) | (a?.uv3 ? 2048 : 0) | (a?.tangent ? 4096 : 0) | ((o as THREE.Points).isPoints ? 8192 : 0) | ((o as THREE.Sprite).isSprite ? 16384 : 0);
}

export class ShaderWarmup {
  private readonly seen = new WeakMap<THREE.Material, { v: number; s: number[] }>();
  private readonly root = new THREE.Object3D();
  private readonly list: THREE.Object3D[] = [];
  private readonly ok: boolean;
  private busy = false;
  private next = 0;
  private scans = 0;
  /** For the tests: programs asked for so far, and batches sent. */
  asked = 0;
  batches = 0;
  /** Main-thread time spent here, ms. */
  ms = 0;

  constructor(private readonly game: Game) {
    let on = false;
    try { on = !!game.renderer.getContext().getExtension('KHR_parallel_shader_compile') && new URLSearchParams(location.search).get('warm') !== '0'; } catch { /* no context */ }
    this.ok = on;
  }

  update(): void {
    if (!this.ok || this.busy) return;
    const now = performance.now();
    if (now < this.next) return;
    // Once a second while the town streams in, then every three (a scan of the whole scene is a few ms).
    this.next = now + (this.scans++ < 60 ? EVERY_MS : 3 * EVERY_MS);
    const list = this.list;
    list.length = 0;
    const t0 = now;
    this.game.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m || !((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite)) return;
      // One material on a plain mesh and an instanced one, or on geometries with and without vertex alpha, needs a
      // program for each: the variants of each material are told apart by what of the object goes into the key.
      const s = variant(o);
      let n = false;
      if (Array.isArray(m)) { for (const x of m) if (this.fresh(x, s)) n = true; } else n = this.fresh(m, s);
      if (n) list.push(o);
    });
    if (list.length) this.compile(list);
    this.ms += performance.now() - t0;
  }

  /** True the first time this material is met in this variant (or again after its version changed). */
  private fresh(m: THREE.Material, s: number): boolean {
    let e = this.seen.get(m);
    if (!e || e.v !== m.version) { e = { v: m.version, s: [] }; this.seen.set(m, e); }
    if (e.s.includes(s)) return false;
    e.s.push(s);
    return true;
  }

  private compile(objs: THREE.Object3D[]): void {
    const g = this.game, r = g.renderer;
    // A stand-in parent that lists the objects without adopting them (compile only walks children).
    const root = this.root;
    root.children = objs.map((o) => { const c = Object.create(o) as THREE.Object3D; c.children = []; return c; });
    const before = r.getRenderTarget();
    const post = g.post as unknown as { enabled?: boolean; sceneRT?: THREE.WebGLRenderTarget } | null;
    r.setRenderTarget(post?.enabled && post.sceneRT ? post.sceneRT : null);
    this.busy = true;
    this.batches++;
    this.asked += objs.length;
    let p: Promise<unknown>;
    try { p = r.compileAsync(root, g.camera, g.scene); } catch { p = Promise.resolve(); }
    r.setRenderTarget(before);
    root.children = [];
    const done = (): void => { this.busy = false; };
    p.then(done, done);
  }
}
