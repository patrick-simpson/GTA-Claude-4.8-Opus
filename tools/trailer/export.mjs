// Trailer scene export (Blender trailer, phase 1): boots the real game, sets a shot up exactly as the promo capture
// does (tools/promo/capture.mjs), runs the shot frame by frame, and writes what Blender needs to rebuild it:
//
//   node tools/trailer/export.mjs --shot P1_tower                  one shot from tools/trailer/shots.json
//   node tools/trailer/export.mjs --shot P1_tower --probe          only count what would be exported
//   options: --out C:/Users/User/trailer/export  --fps 24  --radius 650  --shots FILE  --refs (game frames as JPEGs)
//
// Run it on the RTX (PW_GPU=high). Output, in <out>/<shot id>/:
//   scene.glb   every visible mesh, point cloud and line near the camera path, as the GAME draws them at frame 0, through
//               three's GLTFExporter: world matrices baked on flat nodes, materials as glTF PBR (custom shaders become
//               plain standard materials, with what they were in extras), the source textures as PNG, vertex colours as
//               COLOR_0 (RGBA where the game packs a class in alpha, e.g. the SpeedScan tower's windows), custom vertex
//               attributes as _NAME. THREE.LOD always exports level 0 (the nearest), whatever the camera distance.
//               InstancedMesh: the base mesh once, with its instance matrices and colours in inst.bin (see anim.json).
//               Every node carries extras.pc = { i, path, kind, dyn, mat: [{ type, name, ... }] }.
//   anim.json   { fps, frames, dur, camera: [[px,py,pz, tx,ty,tz, fovY], ...], actors: { i: { m: [16 per frame], vis } },
//                 inst: { i: { count, offset, colors } }, sky: { hour, night, wet, weather, sunDir, sun, season }, fx }
//               All in the game's frame (y up, metres). Blender's importer turns glTF into z-up; blender/build_shot.py
//               does the same for anim.json: (x, y, z) -> (x, -z, y).
//   inst.bin    float32 instance matrices (16 each, column-major, local to the node), then colours (3 each) if any.
//   ref/f00000.jpg  (with --refs) the game's own frame, for the side by side stills.
//
// Actors: nothing is declared. Every candidate's world matrix is compared with its frame-0 matrix on every frame, and
// whatever moved (cars, the train, the helicopter, people as rigid parts, the tornado's root) gets per-frame matrices.
// NOT captured (noted in PLAN.md): vertex-shader motion (stink lines, flags, water waves: Blender rebuilds those),
// skinned deformation (people's limbs), objects created after frame 0 (fireworks shells), instance buffers rewritten
// per frame beyond the --instcap budget.

import { boot } from '../pw.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { timeline } from '../promo/timeline.mjs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const SHOTS = String(opt.shots ?? path.join(here, 'shots.json'));
const OUT = String(opt.out ?? 'C:/Users/User/trailer/export');
const FPS = +(opt.fps ?? 24);
const board = JSON.parse(fs.readFileSync(SHOTS, 'utf8'));
const shot = board.shots.find((s) => s.id === opt.shot);
if (!shot) { console.log('no such shot: ' + opt.shot + '; have ' + board.shots.map((s) => s.id).join(', ')); process.exit(1); }
const R = +(opt.radius ?? shot.radius ?? 650);
// Duration: shot.dur (seconds) wins; else whole beats on the music grid, as the promo (tools/promo/timeline.mjs).
let dur = shot.dur, framesAuto = 0, beatsRel = [];
if (!dur && shot.k0 != null) {
  // Trailer shots: k0 (first beat) and beats on the promo's measured grid; cuts on whole frames, 1440 in all.
  const grid = JSON.parse(fs.readFileSync(path.join(here, '../promo/storyboard.json'), 'utf8')).music.grid, LEN = 60;
  const at = (k) => (k <= 0 ? 0 : k >= grid.length ? LEN : grid[k]);
  const a = at(shot.k0), b = shot.last ? LEN : at(shot.k0 + shot.beats);
  framesAuto = Math.round(b * FPS) - Math.round(a * FPS); dur = framesAuto / FPS;
  for (let k = shot.k0; k <= shot.k0 + shot.beats + (shot.last ? 3 : 0); k++) if (k < grid.length) beatsRel.push(+(Math.max(0, grid[k] - a)).toFixed(4));
  if (shot.k0 === 0) beatsRel[0] = 0;
} else if (!dur) { const tl = timeline(board).find((x) => x.id === shot.id); dur = tl.dur; }
const frames = opt.frames ? +opt.frames : framesAuto || Math.round(dur * FPS);
const query = ['q=high', 'net=0', 'ktx=0', shot.query].filter(Boolean).join('&');
const dir = path.join(OUT, shot.id);
fs.mkdirSync(dir, { recursive: true });
console.log(`export ${shot.id}: ${frames} frames @${FPS} (${dur.toFixed(2)} s), radius ${R} m, ${query}`);

const t = await boot({ width: 1280, height: 720, query, timeout: 180000 });
t.page.on('console', (m) => { const s = m.text(); if (/^(promo|export|GLTFExporter)/.test(s)) console.log('  page: ' + s.slice(0, 300)); });
if (t.errors.length) console.log('boot errors:', t.errors.slice(0, 3));

// The camera path, as capture.mjs places it (keys with Catmull-Rom and easing, follow, ref), recording instead of drawing.
await t.page.evaluate((b) => { window.__beats = b; }, beatsRel);
await t.page.evaluate(() => {
  const g = window.__game, game = g.game;
  const P = (window.__promo = window.__promo || {});
  P.beats = window.__beats || [];
  const style = document.createElement('style');
  style.textContent = 'body > :not(#c) { display: none !important; }';
  document.head.appendChild(style);
  game.gov.enabled = false; game.gov.force(0);
  const V = (a) => new (game.camera.position.constructor)(a[0], a[1], a[2]);
  const ease = (x) => x * x * (3 - 2 * x);
  const cr = (p0, p1, p2, p3, u) => p1.map((_, i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * u
    + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u * u + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u * u * u));
  P.place = (cam, s) => {
    let pos, at, fov = cam.fov ?? 55;
    if (cam.follow && !P[cam.follow]) return;
    if (cam.follow) {
      const v = P[cam.follow];
      const o = cam.offset ?? [0, 3, 9], l = cam.look ?? [0, 1, 12];
      const h = cam.world ? 0 : v.h ?? 0, fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
      const vx = v.x ?? v.pos?.x, vy = v.y ?? v.pos?.y ?? 0, vz = v.z ?? v.pos?.z;
      pos = [vx + rx * o[0] - fx * o[2], vy + o[1], vz + rz * o[0] - fz * o[2]];
      at = [vx + rx * l[0] + fx * l[2], vy + l[1], vz + rz * l[0] + fz * l[2]];
    } else {
      const k = cam.keys;
      let i = 0;
      while (i < k.length - 2 && s > k[i + 1].t) i++;
      const a = k[i], b = k[Math.min(i + 1, k.length - 1)];
      const u = b.t > a.t ? ease(Math.min(1, Math.max(0, (s - a.t) / (b.t - a.t)))) : 0;
      const a0 = k[Math.max(0, i - 1)], b1 = k[Math.min(k.length - 1, i + 2)];
      pos = cr(a0.pos, a.pos, b.pos, b1.pos, u);
      at = cr(a0.at, a.at, b.at, b1.at, u);
      fov = (a.fov ?? fov) + ((b.fov ?? fov) - (a.fov ?? fov)) * u;
      if (cam.ref && P[cam.ref]) { const r = P[cam.ref], o = [r.x ?? 0, r.y ?? 0, r.z ?? 0]; pos = pos.map((x, j) => x + o[j]); at = at.map((x, j) => x + o[j]); }
    }
    game.view = { pos: V(pos), target: V(at) };
    game.camera.fov = fov;
    game.camera.updateProjectionMatrix();
  };
  P.placeDefault = P.place;
});

const bad = await t.page.evaluate(`(async () => { const g = window.__game, P = window.__promo;
  g.game.view = null; try { ${shot.setup ?? ''} } catch (e) { return String(e); } return ''; })()`);
if (bad) console.log('setup failed: ' + bad);
if (shot.keys) await t.page.focus('#c').catch(() => {});
if (!shot.keysLate) for (const k of shot.keys ?? []) await t.page.keyboard.down(k);
const warm = Math.round((shot.warm ?? 1) * 60);
for (let i = 0; i < warm; i += 30) await t.step(Math.min(30, warm - i));
// Put the camera where the shot starts and let the streamed models arrive (they load by distance from the view).
await t.page.evaluate((cam) => { const P = window.__promo; P.place(cam, 0); window.__game.game.render(); }, shot.cam);
await t.page.waitForTimeout(shot.wait ?? 6000);
await t.page.evaluate(() => { window.__promo.t = 0; });
if (shot.preroll) {
  const e = await t.page.evaluate(`(() => { const g = window.__game, P = window.__promo; try { ${shot.preroll} } catch (e) { return String(e); } return ''; })()`);
  if (e) console.log('preroll failed: ' + e);
}
if (shot.keysLate) for (const k of shot.keys ?? []) await t.page.keyboard.down(k);
await t.step(2);
await t.page.evaluate(() => { const P = window.__promo; if (P.each) try { P.each(0); } catch (e) { console.warn('export each0: ' + e); } window.__game.game.tick(1e-4); });
if (shot.nearWarm) {
  // The game draws the four cars nearest the camera (within 13 m) from a separate, finer set of meshes that only exists
  // once a car has been that near. A car that comes that near DURING the shot would vanish from the export (its far
  // set empties, its near set was not in the frame-0 census): bring the camera to the player's car once, now.
  for (let k = 0; k < 3; k++) {
    await t.page.evaluate(() => { const g = window.__game, game = g.game, v = game.player.vehicle; if (!v) return; const V = game.camera.position.constructor; game.view = { pos: new V(v.x + 4, v.y + 2, v.z + 4), target: new V(v.x, v.y + 0.5, v.z) }; game.render(); game.tick(1e-4); game.render(); });
    await t.page.waitForTimeout(1200);
  }
  await t.page.evaluate((cam) => { const P = window.__promo; P.place(cam, 0); window.__game.game.render(); window.__game.game.tick(1e-4); window.__game.game.render(); }, shot.cam);
}
await t.page.evaluate((cam) => { const P = window.__promo; P.place(cam, 0); window.__game.game.render(); }, shot.cam);
await t.page.waitForTimeout(1500);

// Frame 0: the candidates (every drawable in the scene graph that is visible, LODs forced to level 0), their matrices.
const census = await t.page.evaluate(() => {
  const g = window.__game, game = g.game, X = (window.__ex = {});
  const list = [];
  const forced = new Set();
  game.scene.updateMatrixWorld(true);
  const walk = (o, vis, pathNames, lodLevel = false) => {
    if (o.isLOD && o.levels.length) {
      forced.add(o);
      o.levels.forEach((l, k) => { if (k === 0) walk(l.object, vis && o.visible, pathNames.concat(o.name || 'lod'), true); });
      return;
    }
    const v = vis && (o.visible || lodLevel);
    if (!v) return;
    const kind = o.isInstancedMesh ? 'inst' : o.isSkinnedMesh ? 'skin' : o.isMesh ? 'mesh' : o.isPoints ? 'points' : (o.isLine || o.isLineSegments) ? 'line' : o.isSprite ? 'sprite' : null;
    if (kind && kind !== 'sprite' && o.geometry && o.geometry.attributes.position) {
      list.push({ o, kind, path: pathNames.concat(o.name || o.type).slice(-4).join('/') });
    }
    for (const c of o.children) walk(c, v, pathNames.concat(o.name || ''));
  };
  for (const c of game.scene.children) walk(c, true, []);
  // Matrices at frame 0, and for instanced meshes a copy of the instance buffer.
  X.list = list;
  X.m0 = new Float32Array(list.length * 16);
  list.forEach((e, i) => {
    X.m0.set(e.o.matrixWorld.elements, i * 16);
    if (e.kind === 'inst') {
      e.im0 = e.o.instanceMatrix.array.slice(0, e.o.count * 16); e.ic0 = e.o.instanceColor ? e.o.instanceColor.array.slice(0, e.o.count * 3) : null;
      // Per-instance attributes (a car's paint finish, dust, lamps, damage): copied as floats, written beside the matrices.
      e.ia0 = {};
      for (const [name, a] of Object.entries(e.o.geometry.attributes)) if (a.isInstancedBufferAttribute) {
        const n = Math.min(a.count, e.o.count), s = a.itemSize, arr = new Float32Array(n * s);
        for (let k = 0; k < n; k++) for (let j = 0; j < s; j++) arr[k * s + j] = a.getComponent(k, j);
        e.ia0[name] = { s, arr };
      }
    }
    const geo = e.o.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const s = geo.boundingSphere.clone();
    if (e.kind === 'inst') { if (!e.o.boundingSphere) e.o.computeBoundingSphere(); s.copy(e.o.boundingSphere); }
    s.applyMatrix4(e.o.matrixWorld);
    e.sphere = [s.center.x, s.center.y, s.center.z, s.radius];
  });
  // Instanced meshes rewritten every frame (cars, wheels, boats): tracked per frame, up to CAP instances each.
  X.CAP = 96; X.idyn = new Map(); X.icnt = new Map();
  list.forEach((e) => { e.dynOk = e.kind === 'inst' && e.o.count <= X.CAP && e.o.name !== 'people' && !/flora|tree|ground|christmas/i.test(e.path); });
  // People: skinned in the vertex shader from a float texture; skinned here on the CPU, per frame (people.bin).
  X.ppl = [];
  try {
    const pp = game.people, skins = pp.skins || [], tex = pp.tex, W = tex.image.width, D = tex.image.data;
    let PAL0 = 0;
    if (skins.length) {
      const sh = { vertexShader: '#include <common>\n#include <color_vertex>\n#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>\n#include <normal_fragment_maps>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <lights_fragment_end>', uniforms: {} };
      skins[0].material.onBeforeCompile(sh);
      PAL0 = +(/ivec2\((\d+) \+ int\(aSkin\.w/.exec(sh.vertexShader) || [0, 0])[1];
    }
    X.pplInfo = { W, PAL0, D };
    const cp = game.view && game.view.pos ? game.view.pos : game.camera.position;
    skins.forEach((m, idx) => {
      const g = m.geometry, n = g.instanceCount || 0, rows = g.attributes.aRow.array;
      for (let k = 0; k < n; k++) {
        const r = Math.round(rows[k]);
        // Where is this person? The hips bone's translation (bone 0, texels 0..2, w).
        const x = D[(r * W + 0) * 4 + 3], y = D[(r * W + 1) * 4 + 3], z = D[(r * W + 2) * 4 + 3];
        const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
        const base = idx - (idx % 3), gm = skins[base + (d < 40 ? 0 : 1)] || m;
        X.ppl.push({ r, geo: gm.geometry, d, nv: gm.geometry.attributes.position.count });
      }
    });
    X.ppl.sort((a, b) => a.d - b.d);
    console.log('export: people ' + X.ppl.length + ' PAL0 ' + PAL0 + ' W ' + W);
  } catch (e) { console.warn('export people: ' + e); }
  X.skinPeople = (list2) => {
    const { W, PAL0, D } = X.pplInfo; let nv = 0; for (const p of list2) nv += p.nv;
    const out = new Float32Array(nv * 3); let o = 0;
    for (const p of list2) {
      const g = p.geo, PA = g.attributes.position, S = g.attributes.aSkin.array, r0 = p.r * W;
      for (let v = 0; v < p.nv; v++) {
        const a = (r0 + Math.round(S[v * 4]) * 3) * 4, b = (r0 + Math.round(S[v * 4 + 1]) * 3) * 4, w = S[v * 4 + 2];
        const sc = D[(r0 + PAL0 + Math.round(S[v * 4 + 3])) * 4 + 3];
        const x = PA.getX(v), y = PA.getY(v), z = PA.getZ(v);
        for (let k = 0; k < 3; k++) {
          const ia = a + k * 4, ib = b + k * 4;
          const m0 = D[ib] + (D[ia] - D[ib]) * w, m1 = D[ib + 1] + (D[ia + 1] - D[ib + 1]) * w, m2 = D[ib + 2] + (D[ia + 2] - D[ib + 2]) * w, m3 = D[ib + 3] + (D[ia + 3] - D[ib + 3]) * w;
          out[o++] = (m0 * x + m1 * y + m2 * z + m3) * sc;
        }
      }
    }
    return out;
  };
  X.veh = []; X.rec = [];
  X.dyn = new Map();      // i -> Float32Array(frames * 16)
  X.vis = new Map();      // i -> Uint8Array(frames)
  X.cam = [];
  const tally = {};
  for (const e of list) tally[e.kind] = (tally[e.kind] || 0) + 1;
  return { n: list.length, tally, lods: forced.size, people: X.ppl.length };
});
// People kept: the nearest, within --pplr metres of the camera, at most --pplmax.
const PPLR = +(opt.pplr ?? shot.pplR ?? 160), PPLMAX = +(opt.pplmax ?? shot.pplMax ?? 60);
const nppl = await t.page.evaluate(([r, mx]) => { const X = window.__ex; X.ppl = X.ppl.filter((p) => p.d < r).slice(0, mx); return X.ppl.length; }, [PPLR, PPLMAX]);
const pplFd = nppl && !opt.probe ? fs.openSync(path.join(dir, 'people.bin'), 'w') : 0;
console.log('candidates:', JSON.stringify(census));

// Run the shot: tick, place the camera, render (so render-time updates run), compare matrices.
const t0 = Date.now();
const refs = !!opt.refs;
if (refs) fs.mkdirSync(path.join(dir, 'ref'), { recursive: true });
for (let f = 0; f < frames; f++) {
  const jpg = await t.page.evaluate(async ([cam, f, frames, fps, ts, wantRef]) => {
    const g = window.__game, game = g.game, P = window.__promo, X = window.__ex;
    const dt = (ts ?? 1) / fps;
    if (f > 0) {
      game.tick(dt);
      P.t = (P.t ?? 0) + dt;
      if (P.each) try { P.each(dt); } catch (e) { P.each = null; console.warn('export each: ' + e); }
    }
    P.place(cam, (f + 0.5) / frames);
    game.render();
    const c = game.camera, v = game.view;
    const tgt = v && v.target ? v.target : c.getWorldDirection(new c.position.constructor()).add(c.position);
    const pos = v && v.pos ? v.pos : c.position;
    X.cam.push([pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, c.fov]);
    const L = X.list;
    for (let i = 0; i < L.length; i++) {
      const o = L[i].o, me = o.matrixWorld.elements;
      let moved = false;
      for (let k = 0; k < 16; k++) if (Math.abs(me[k] - X.m0[i * 16 + k]) > 1e-4) { moved = true; break; }
      let seen = true;
      for (let p = o; p; p = p.parent) if (!p.visible && !(p.parent && p.parent.isLOD)) { seen = false; break; }
      if (moved && !X.dyn.has(i)) { const a = new Float32Array(frames * 16); for (let q = 0; q < f; q++) a.set(X.m0.subarray(i * 16, i * 16 + 16), q * 16); X.dyn.set(i, a); }
      if (X.dyn.has(i)) X.dyn.get(i).set(me, f * 16);
      if (!seen && !X.vis.has(i)) { const a = new Uint8Array(frames).fill(1); X.vis.set(i, a); }
      if (X.vis.has(i)) X.vis.get(i)[f] = seen ? 1 : 0;
    }
    for (let i = 0; i < L.length; i++) {
      const e = L[i]; if (!e.dynOk) continue;
      const o = e.o, n = Math.min(o.count, X.CAP), a = o.instanceMatrix.array;
      let ch = X.idyn.has(i);
      if (!ch) { if (o.count !== e.im0.length / 16) ch = true; else for (let k = 0; k < n * 16; k++) if (Math.abs(a[k] - e.im0[k]) > 1e-4) { ch = true; break; } }
      if (!ch) continue;
      if (!X.idyn.has(i)) {
        const buf = new Float32Array(frames * X.CAP * 16), cnt = new Uint16Array(frames), n0 = Math.min(e.im0.length / 16, X.CAP);
        for (let q = 0; q < f; q++) { buf.set(e.im0.subarray(0, n0 * 16), q * X.CAP * 16); cnt[q] = n0; }
        X.idyn.set(i, buf); X.icnt.set(i, cnt);
      }
      X.idyn.get(i).set(a.subarray(0, n * 16), f * X.CAP * 16); X.icnt.get(i)[f] = n;
    }
    {
      const r5 = (x) => +(+x || 0).toFixed(3);
      X.veh.push(game.vehicles.list.filter((v) => Math.hypot(v.x - pos.x, v.z - pos.z) < 700).map((v) => [v.id, v.spec.kind, r5(v.x), r5(v.y), r5(v.z), r5(v.h), r5(v.spec.length), r5(v.spec.width), r5(v.spec.height), v === game.player.vehicle ? 1 : 0, r5(Math.hypot(v.vx || 0, v.vz || 0)), v.onGround === false ? 0 : 1]));
      let rec = null; if (P.rec) try { rec = P.rec(); } catch (e) { rec = null; }
      const st = game.systems.find((s) => s.tag === 'police'), H = st && st.heli;
      X.rec.push({ ...(rec || {}), heli: H && H.present ? [r5(H.x), r5(H.y), r5(H.z), r5(H.h)] : null, pl: [r5(game.player.x), r5(game.player.y), r5(game.player.z)] });
    }
    if (X.ppl.length) { const fa = X.skinPeople(X.ppl); if (f === 0) X.pplFirst = fa; X.pplFrame = new Uint8Array(fa.buffer); }
    if (!wantRef) return '';
    const url = game.canvas.toDataURL('image/jpeg', 0.92);
    return url.slice(url.indexOf(',') + 1);
  }, [shot.cam, f, frames, FPS, shot.timeScale, refs && (f === 0 || f === frames >> 1 || f === frames - 1)]);
  if (jpg) fs.writeFileSync(path.join(dir, 'ref', `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(jpg, 'base64'));
  if (pplFd) {
    const n = await t.page.evaluate(() => window.__ex.pplFrame.length);
    for (let a = 0; a < n; a += 6 << 20) {
      const b64 = await t.page.evaluate(([a, m]) => { const u = window.__ex.pplFrame.subarray(a, a + m); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }, [a, 6 << 20]);
      fs.writeSync(pplFd, Buffer.from(b64, 'base64'));
    }
  }
}
if (pplFd) fs.closeSync(pplFd);
console.log(`ran ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Keep what is near the camera path; build the export scene; serialise.
const res = await t.page.evaluate(async ([R, probe]) => {
  const g = window.__game, game = g.game, X = window.__ex;
  const THREE_URL = '/node_modules/three/build/three.module.js';
  const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
  const T = await import(THREE_URL);
  const cams = X.cam.filter((_, k) => k % 4 === 0 || k === X.cam.length - 1);
  const near = (s) => { for (const c of cams) { const d = Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) - s[3]; if (d < R) return true; } return false; };
  const keep = [];
  X.list.forEach((e, i) => {
    if (near(e.sphere)) { keep.push(i); return; }
    if (X.idyn.has(i)) { keep.push(i); return; }
    const d = X.dyn.get(i);
    if (d) for (let f = 0; f < d.length / 16; f += 4) { const s = [d[f * 16 + 12], d[f * 16 + 13], d[f * 16 + 14], e.sphere[3]]; if (near(s)) { keep.push(i); return; } }
  });
  const stat = { kept: keep.length, dyn: [...X.dyn.keys()].filter((i) => keep.includes(i)).length, tris: 0, byKind: {}, mats: {}, shader: {} };
  for (const i of keep) {
    const e = X.list[i], geo = e.o.geometry;
    const tri = (geo.index ? geo.index.count : geo.attributes.position.count) / 3 * (e.kind === 'inst' ? e.o.count : 1);
    stat.tris += tri; stat.byKind[e.kind] = (stat.byKind[e.kind] || 0) + 1;
    for (const m of [].concat(e.o.material)) { stat.mats[m.type] = (stat.mats[m.type] || 0) + 1; if (m.isShaderMaterial || m.onBeforeCompile?.toString().length > 20) stat.shader[e.path] = m.type; }
  }
  stat.tris = Math.round(stat.tris);
  if (probe) { stat.shader = Object.keys(stat.shader).slice(0, 60); return { stat }; }

  // Geometry: float32 copies of every attribute (meshopt leaves quantised ints), colour kept with its alpha.
  const geoCache = new Map();
  const cleanGeo = (src) => {
    if (geoCache.has(src)) return geoCache.get(src);
    const out = new T.BufferGeometry();
    for (const [name, a] of Object.entries(src.attributes)) {
      if (a.isInstancedBufferAttribute || /^(instance|skinIndex|skinWeight)/.test(name)) continue;
      // glTF needs every attribute as long as the positions (three tolerates a short one; Blender's importer does not).
      if (name !== 'position' && a.count !== src.attributes.position.count) continue;
      const n = a.count, s = a.itemSize, arr = new Float32Array(n * s);
      for (let k = 0; k < n; k++) for (let j = 0; j < s; j++) arr[k * s + j] = a.getComponent ? a.getComponent(k, j) : [a.getX, a.getY, a.getZ, a.getW][j].call(a, k);
      out.setAttribute(name, new T.BufferAttribute(arr, s));
    }
    // The colour's alpha again as a plain float (_ALPHA): the game packs classes in it (the SpeedScan tower's glass).
    const ca = src.attributes.color;
    if (ca && ca.itemSize === 4 && ca.count === src.attributes.position.count) { const al = new Float32Array(ca.count); for (let k = 0; k < ca.count; k++) al[k] = ca.getW(k); out.setAttribute('alpha', new T.BufferAttribute(al, 1)); }
    if (src.index) out.setIndex(new T.BufferAttribute(Uint32Array.from(src.index.array.subarray(0, src.index.count)), 1));
    for (const gr of src.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
    if (src.drawRange && src.drawRange.count !== Infinity && src.index) {
      // A trimmed draw range: export only what is drawn.
      const a = src.drawRange.start, b = Math.min(src.index.count, a + src.drawRange.count);
      out.setIndex(new T.BufferAttribute(Uint32Array.from(src.index.array.subarray(a, b)), 1));
    }
    if (!out.attributes.normal && out.index) out.computeVertexNormals();
    geoCache.set(src, out);
    return out;
  };
  // Textures the exporter can draw: plain images, canvases, bitmaps and 8-bit data. Others are dropped (named in extras).
  const texOk = (tx) => {
    if (!tx) return false;
    if (tx.isRenderTargetTexture || tx.isCompressedTexture || tx.isCubeTexture || tx.isVideoTexture || tx.isDepthTexture) return false;
    const im = tx.image;
    if (!im || !(im.width > 0)) return false;
    if (tx.isDataTexture && !(im.data instanceof Uint8Array || im.data instanceof Uint8ClampedArray)) return false;
    return true;
  };
  const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
  const hex = (c) => (c && c.isColor ? '#' + c.getHexString() : undefined);
  const matCache = new Map();
  const convMat = (m) => {
    if (matCache.has(m)) return matCache.get(m);
    const info = { type: m.type, name: m.name || '', transparent: !!m.transparent, opacity: m.opacity, side: m.side,
      vc: !!m.vertexColors, custom: !!(m.onBeforeCompile && m.onBeforeCompile.toString().length > 20) || !!m.isShaderMaterial,
      color: hex(m.color), emissive: hex(m.emissive), ei: m.emissiveIntensity, rough: m.roughness, metal: m.metalness, dropped: [] };
    let out;
    if (m.isMeshStandardMaterial || m.isMeshBasicMaterial) {
      out = m.clone();
      out.onBeforeCompile = () => {};
      out.envMap = null; out.lightMap = null;
    } else {
      // Phong, Lambert, Toon, custom shaders, points and lines: a standard material that keeps what can be read.
      const u = m.uniforms || {};
      const col = m.color || (u.uColor && u.uColor.value && u.uColor.value.isColor ? u.uColor.value : null) || (u.diffuse && u.diffuse.value) || new T.Color(0xffffff);
      out = new T.MeshStandardMaterial({ color: col.clone ? col.clone() : col, vertexColors: !!m.vertexColors, transparent: !!m.transparent, opacity: m.opacity ?? 1, side: m.side ?? 0,
        roughness: m.roughness ?? (m.shininess != null ? Math.max(0.05, 1 - Math.sqrt(m.shininess / 100)) : 0.8), metalness: m.metalness ?? 0 });
      const map = m.map || (u.map && u.map.value) || (u.uMap && u.uMap.value) || (u.tDiffuse && u.tDiffuse.value);
      if (map) out.map = map;
      if (m.emissive) { out.emissive = m.emissive.clone(); out.emissiveIntensity = m.emissiveIntensity ?? 1; }
      if (m.normalMap) out.normalMap = m.normalMap;
      if (m.alphaMap) out.alphaMap = m.alphaMap;
      if (m.isShaderMaterial) {
        info.uniforms = {};
        for (const [k, v] of Object.entries(u)) { const x = v && v.value; if (typeof x === 'number') info.uniforms[k] = +x.toFixed(4); else if (x && x.isColor) info.uniforms[k] = hex(x); else if (x && x.isVector3) info.uniforms[k] = [x.x, x.y, x.z].map((n) => +n.toFixed(3)); }
      }
    }
    for (const s of SLOTS) if (out[s] && !texOk(out[s])) { info.dropped.push(s); out[s] = null; }
    for (const s of SLOTS) if (out[s]) info[s] = out[s].name || (out[s].image && out[s].image.src ? String(out[s].image.src).replace(/^.*\//, '') : 'canvas' + out[s].id);
    out.name = (m.name || m.type) + '#' + m.id;
    out.userData = { pc: info };
    matCache.set(m, out);
    return out;
  };

  const scene = new T.Scene();
  const inst = {}; const instBufs = []; let instOff = 0;
  const actors = {};
  for (const i of keep) {
    const e = X.list[i], src = e.o;
    const geo = cleanGeo(src.geometry);
    const mats = Array.isArray(src.material) ? src.material.map(convMat) : convMat(src.material);
    const node = e.kind === 'points' ? new T.Points(geo, mats) : e.kind === 'line' ? new T.LineSegments(geo, mats) : new T.Mesh(geo, mats);
    node.name = `${i}|${(src.name || '').slice(0, 40)}`;
    node.matrixAutoUpdate = false;
    node.matrix.fromArray(X.m0, i * 16);
    node.matrix.decompose(node.position, node.quaternion, node.scale);
    const ex = { i, path: e.path, kind: e.kind, dyn: X.dyn.has(i), cast: !!src.castShadow };
    ex.mat = [].concat(src.material).map((m) => convMat(m).userData.pc);
    if (e.kind === 'inst') {
      // The count and buffers as they were at frame 0 (a pool may have grown or shrunk since).
      const n = Math.floor(e.im0.length / 16), cols = e.ic0 && e.ic0.length >= n * 3 ? e.ic0.subarray(0, n * 3) : null;
      const im = new Float32Array(e.im0.subarray(0, n * 16));
      instBufs.push(im); if (cols) instBufs.push(new Float32Array(cols));
      inst[i] = { count: n, offset: instOff, colors: cols ? instOff + n * 16 * 4 : -1 };
      instOff += n * 16 * 4 + (cols ? n * 3 * 4 : 0);
      inst[i].attrs = {};
      for (const [name, { s, arr }] of Object.entries(e.ia0 || {})) { const a = arr.subarray(0, Math.min(arr.length, n * s)); instBufs.push(a); inst[i].attrs[name] = { size: s, offset: instOff, count: a.length / s }; instOff += a.byteLength; }
      ex.inst = n;
      if (X.idyn.has(i)) {
        const cnt = X.icnt.get(i), mx = Math.max(1, ...cnt), src2 = X.idyn.get(i), F = cnt.length;
        const buf = new Float32Array(F * mx * 16);
        for (let q = 0; q < F; q++) buf.set(src2.subarray(q * X.CAP * 16, q * X.CAP * 16 + mx * 16), q * mx * 16);
        instBufs.push(buf); inst[i].dyn = { offset: instOff, max: mx, counts: Array.from(cnt) }; instOff += buf.byteLength;
      }
    }
    if (X.dyn.has(i)) actors[i] = { m: Array.from(X.dyn.get(i), (x) => +x.toFixed(5)) };
    if (X.vis.has(i)) (actors[i] = actors[i] || {}).vis = Array.from(X.vis.get(i));
    node.userData = { pc: ex };
    scene.add(node);
  }
  // People: one mesh each, in the frame-0 pose, colours with their palette; people.bin carries every frame.
  const pplMeta = [];
  if (X.ppl.length && X.pplFirst) {
    const { W, PAL0, D } = X.pplInfo; let voff = 0;
    const first = X.pplFirst;
    const pm = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }); pm.name = 'people-skin'; pm.userData = { pc: { type: 'MeshStandardMaterial', name: 'people-skin', vc: true, rough: 0.8, metal: 0, dropped: [] } };
    X.ppl.forEach((p, k) => {
      const g = p.geo, nv = p.nv, geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(first.slice(voff * 3, (voff + nv) * 3), 3));
      const C = g.attributes.color, S = g.attributes.aSkin.array, I = g.attributes.aInfo.array, col = new Float32Array(nv * 3), cls = new Float32Array(nv);
      for (let v = 0; v < nv; v++) {
        const pal = (p.r * W + PAL0 + Math.round(S[v * 4 + 3])) * 4, keepc = I[v * 3 + 1];
        for (let j = 0; j < 3; j++) col[v * 3 + j] = (C ? C.getComponent(v, j) : 1) * (D[pal + j] + (1 - D[pal + j]) * keepc);
        cls[v] = I[v * 3];
      }
      geo.setAttribute('color', new T.BufferAttribute(col, 3));
      geo.setAttribute('_CLS', new T.BufferAttribute(cls, 1));
      geo.setIndex(new T.BufferAttribute(Uint32Array.from(g.index.array), 1));
      geo.computeVertexNormals();
      const node = new T.Mesh(geo, pm); node.name = `ppl${k}|person`;
      node.userData = { pc: { i: 900000 + k, path: 'people/skin', kind: 'mesh', dyn: false, cast: true, ppl: { off: voff, nv }, mat: [pm.userData.pc] } };
      scene.add(node); pplMeta.push({ off: voff, nv }); voff += nv;
    });
    stat.people = X.ppl.length; stat.peopleVerts = voff;
  }
  stat.textures = 0;
  const exporter = new GLTFExporter();
  const t0 = performance.now();
  const glb = await exporter.parseAsync(scene, { binary: true, onlyVisible: false, maxTextureSize: 4096, includeCustomExtensions: false });
  stat.exportMs = Math.round(performance.now() - t0);
  X.glb = new Uint8Array(glb);
  const ib = new Uint8Array(instOff); let o = 0; for (const b of instBufs) { ib.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), o); o += b.byteLength; }
  X.inst = ib;
  const sky = game.sky;
  const fx = [];
  for (const i of keep) { const e = X.list[i]; if (/stink|tornado|smoke|fire|spark|rain|snow|water|sea|river/i.test(e.path)) fx.push({ i, path: e.path, kind: e.kind }); }
  // Street lamp heads (ground.ts keeps them as 'halos', x y z triples): real lights in Blender.
  const lamps = [];
  // (ground.ts builds them into one Points cloud of halos and then empties the array: read the cloud.)
  for (const e of X.list) {
    if (e.kind !== 'points' || !/ground/.test(e.path)) continue;
    const pa = e.o.geometry.attributes.position, mw = e.o.matrixWorld, v = new T.Vector3();
    for (let k = 0; k < pa.count; k++) { v.fromBufferAttribute(pa, k).applyMatrix4(mw); if (near([v.x, v.y, v.z, 0])) lamps.push([+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]); }
  }
  stat.lamps = lamps.length;
  X.anim = { lamps, fps: 0, frames: X.cam.length, camera: X.cam.map((c) => c.map((x) => +x.toFixed(4))), actors, inst,
    sky: { hour: sky.hour, night: sky.night, wet: sky.wet, weather: sky.weather, sunDir: [sky.sunDir.x, sky.sunDir.y, sky.sunDir.z],
      sun: '#' + sky.sun.color.getHexString(), sunI: sky.sun.intensity, hemi: '#' + sky.hemi.color.getHexString(), hemiG: '#' + sky.hemi.groundColor.getHexString(),
      fog: game.scene.fog ? { color: '#' + game.scene.fog.color.getHexString(), density: game.scene.fog.density } : null,
      season: new URLSearchParams(location.search).get('season') || 'auto' },
    fx, stat, veh: X.veh, rec: X.rec, people: pplMeta };
  return { stat, bytes: X.glb.length, inst: ib.length };
}, [R, !!opt.probe]);
{ const s = { ...res.stat }; s.shader = Object.keys(s.shader || {}).length; console.log(JSON.stringify(s)); }
if (!opt.probe) {
  // Pull the GLB out in slices (a single huge string through the protocol is slow and can fail).
  const fd = fs.openSync(path.join(dir, 'scene.glb'), 'w');
  const CH = 8 << 20;
  for (let a = 0; a < res.bytes; a += CH) {
    const b64 = await t.page.evaluate(([a, n]) => { const u = window.__ex.glb.subarray(a, a + n); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }, [a, CH]);
    fs.writeSync(fd, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(fd);
  const ib = await t.page.evaluate(() => { const u = window.__ex.inst; let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); });
  fs.writeFileSync(path.join(dir, 'inst.bin'), Buffer.from(ib, 'base64'));
  const anim = await t.page.evaluate(() => window.__ex.anim);
  anim.fps = FPS; anim.dur = dur; anim.beats = beatsRel; anim.timeScale = shot.timeScale ?? 1; anim.shot = { id: shot.id, look: shot.look ?? null, move: shot.move };
  fs.writeFileSync(path.join(dir, 'anim.json'), JSON.stringify(anim));
  console.log(`wrote ${dir}: scene.glb ${(res.bytes / 1e6).toFixed(1)} MB, inst.bin ${(res.inst / 1e6).toFixed(1)} MB, ${Object.keys(anim.actors).length} actors`);
}
if (t.errors.length) console.log('page errors:', t.errors.slice(0, 5));
await t.close();
