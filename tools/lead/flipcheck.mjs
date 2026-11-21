// Are the two-copy instance buffers (src/core/flip.ts) ever stale? Move through a scene with the simulation
// running; every few frames draw the frame, then send EVERY registered buffer whole and draw it again without
// ticking. Two tests, and a check is bad if either fails:
//   1. pixels: the two pictures must be the same to the pixel;
//   2. buffers: after the FIRST draw, the GPU copy (read back with getBufferSubData) of every registered buffer
//      whose mesh was drawn must equal its array over the part in use. This names a stale buffer directly.
// A bad check prints what differed (how many pixels, where, which people and cars stand there, which buffer),
// whether a reflection-cube face was drawn or a car model arrived in that tick, and saves an enlarged crop
// (draw 1 | draw 2 | mask) next to the scene pictures.
//
// The check draws WITHOUT multisampling (post.setAA(0, true), the governor's "FXAA alone" step), because on a
// multisampled target two draws of the same moment are not equal even with flip switched off (Nov 20, flipdiag.mjs):
//   - the particles fade against scene depth, and on a multisampled target they read LAST frame's depth
//     (src/fx/particles.ts says so): the first draw after a tick reads depth from the old camera, the repeat from
//     the new one. Night rain: 15 and 98 checks of 160 differed with ?flip=0, none with the fade off;
//   - this GPU's multisampled picture is not repeatable: at a few spots in Gull Heights 2 to 5 of 15 identical
//     draws differ by 1 or 2 pixels with ?flip=0 and no upload between them, none of 15 without multisampling.
// `--msaa` keeps the game's own antialiasing, to see those false alarms again.
//
//   node scratch/m6/flipcheck.mjs [--q high] [--shots scratch/m6/shots] [--only nightrain,heights] [--every 7] [--msaa] [--break]
import { boot, ROOT } from '../pw.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const k = args[i].replace(/^--/, ''); opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true; }
const q = String(opt.q ?? 'high'), shots = String(opt.shots ?? 'scratch/m6/shots'), every = +(opt.every ?? 7);
const RUNS = [
  { name: 'downtown', hour: 13, path: [-30, 60, -30, -200], frames: 240 },
  { name: 'heights', hour: 13, path: [-240, -320, 300, -320], frames: 200 },
  { name: 'pier', hour: 18.5, path: [0, 520, 0, 580], frames: 120 },
  { name: 'nightrain', hour: 22, weather: 'rain', heat: 3, path: [-30, 60, -30, -120], frames: 160 },
];
const t = await boot({ query: `q=${q}&save=0${opt.query ? '&' + opt.query : ''}`, width: 1280, height: 720 });
let total = 0, totalBad = 0, pics = 0;
try {
  for (let i = 0; i < 6; i++) { await t.page.waitForTimeout(1500); await t.step(4); }
  for (const r of RUNS.filter((x) => typeof opt.only !== 'string' || opt.only.split(',').includes(x.name))) {
    await t.game((g, w) => g.setWeather(w), r.weather ?? 'clear');
    await t.game((g, h) => g.setTime(h), r.hour);
    await t.game((g, a) => g.teleport(a[0], a[1], 3.14), r.path);
    await t.game((g, n) => g.setHeat(n), r.heat ?? 0);
    await t.step(60); await t.page.waitForTimeout(300); await t.step(10);
    const res = await t.page.evaluate(([p, frames, every, brk, keepMsaa, wantPics]) => {
      const G = window.__game, g = G.game, R = g.renderer, gl = R.getContext(), V = g.vehicles;
      const gl2 = typeof gl.getBufferSubData === 'function';
      // ── once per page ──
      const F = (window.__fc ??= (() => {
        const f = { bound: null, buf: new WeakMap(), stamp: 0, aa: 'game' };
        const bb = gl.bindBuffer.bind(gl); gl.bindBuffer = (tg, b) => { if (tg === gl.ARRAY_BUFFER) f.bound = b; bb(tg, b); };
        if (g.post && !keepMsaa) { g.post.setAA(0, true); f.aa = 'none (the check)'; }
        return f;
      })());
      // --break: a deliberately wrong scheme (the twin copy is never sent its changes), to show this check can fail.
      if (brk && !g.flip.__broken) { g.flip.__broken = true; const sw = g.flip.swap.bind(g.flip); g.flip.swap = () => { const was = new Map(); for (const r of g.flip.recs.values()) was.set(r, r.b.version); sw(); for (const r of g.flip.recs.values()) r.b.version = was.get(r); }; }
      // Remember which GL buffer each copy was last sent to, and which meshes the main camera really drew.
      const owners = new Map();
      const hook = () => {
        for (const r of g.flip.recs.values()) for (const x of [r.a, r.b]) if (!x.__h) { x.__h = true; x.onUploadCallback = () => { F.buf.set(x, F.bound); }; }
        // Keyed by the registration, not the copy: swap() changes which copy hangs on the mesh inside render().
        const reg = new Map(); for (const r of g.flip.recs.values()) { reg.set(r.a, r); reg.set(r.b, r); }
        owners.clear();
        g.scene.traverse((o) => {
          if (!o.isMesh && !o.isPoints && !o.isLine) return;
          const mat = Array.isArray(o.material) ? o.material[0] : o.material, geo = o.geometry;
          const own = (x, key, used) => {
            const rec = x ? reg.get(x) : undefined;
            if (!rec) return;
            if (!owners.has(rec)) owners.set(rec, []);
            owners.get(rec).push({ o, who: `${o.name || (o.isInstancedMesh ? 'InstancedMesh' : o.type)}#${o.id}/${(mat && (mat.name || mat.type)) || '?'}.${key}`, used });
            if (!o.__fcw) { o.__fcw = true; const ob = o.onBeforeRender; o.onBeforeRender = function (rr, s, c, ...rest) { if (c === g.camera) this.__fcd = F.stamp; return ob.call(this, rr, s, c, ...rest); }; }
          };
          if (o.isInstancedMesh) { own(o.instanceMatrix, 'matrix', () => o.count * 16); own(o.instanceColor, 'color', () => o.count * 3); }
          if (geo) for (const k in geo.attributes) {
            const x = geo.attributes[k];
            own(x, k, () => !x.isInstancedBufferAttribute ? x.array.length : o.isInstancedMesh ? o.count * x.itemSize : Number.isFinite(geo.instanceCount) ? geo.instanceCount * x.itemSize : x.array.length);
          }
        });
      };
      const stale = () => {
        const bad = []; let read = 0, unread = 0;
        if (!gl2) return { bad, read, unread };
        for (const r of g.flip.recs.values()) {
          const x = r.onB ? r.b : r.a, own = (owners.get(r) ?? []).filter((w) => w.o.__fcd === F.stamp);
          if (!own.length) continue;
          const b = F.buf.get(x);
          if (!b) { unread++; continue; }
          const arr = x.array, used = Math.min(arr.length, Math.max(...own.map((w) => w.used())));
          if (used <= 0) continue;
          const got = new arr.constructor(used);
          gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, got);
          read++;
          let first = -1, n = 0;
          for (let i = 0; i < used; i++) if (arr[i] !== got[i] && !(arr[i] !== arr[i] && got[i] !== got[i])) { if (first < 0) first = i; n++; }
          if (n) bad.push({ who: own[0].who, copy: r.onB ? 'twin' : 'first', firstValue: first, values: n, inUse: used, prev: r.prev });
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return { bad, read, unread };
      };
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const grab = () => { const px = new Uint8Array(W * H * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      // One picture: the differing region (padded) enlarged four times, as draw 1 | draw 2 | mask.
      const png = (A, B, mask, box) => {
        const pad = 28, bx0 = Math.max(0, box[0] - pad), by0 = Math.max(0, box[1] - pad), bx1 = Math.min(W - 1, Math.min(box[2] + pad, bx0 + 219)), by1 = Math.min(H - 1, Math.min(box[3] + pad, by0 + 179));
        const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1, Z = 4, SW = cw * 3 + 4;
        const small = document.createElement('canvas'); small.width = SW; small.height = ch; const x = small.getContext('2d'), im = x.createImageData(SW, ch), d = im.data;
        for (let y = 0; y < ch; y++) for (let i = 0; i < cw; i++) {
          const sy = H - 1 - (by0 + y), s = (sy * W + bx0 + i) * 4, hit = mask[sy * W + bx0 + i];
          const o1 = (y * SW + i) * 4, o2 = o1 + (cw + 2) * 4, o3 = o2 + (cw + 2) * 4;
          d[o1] = A[s]; d[o1 + 1] = A[s + 1]; d[o1 + 2] = A[s + 2]; d[o1 + 3] = 255;
          d[o2] = B[s]; d[o2 + 1] = B[s + 1]; d[o2 + 2] = B[s + 2]; d[o2 + 3] = 255;
          d[o3] = hit ? 255 : A[s] * 0.35; d[o3 + 1] = hit ? 0 : A[s + 1] * 0.35; d[o3 + 2] = hit ? 255 : A[s + 2] * 0.35; d[o3 + 3] = 255;
        }
        x.putImageData(im, 0, 0);
        const c = document.createElement('canvas'); c.width = SW * Z; c.height = ch * Z; const cx = c.getContext('2d'); cx.imageSmoothingEnabled = false; cx.drawImage(small, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
      };
      // Which people and cars stand inside (or near) the differing box on screen.
      const near = (box) => {
        const outp = [], v = new (g.camera.position.constructor)();
        const test = (x, y, z, tag) => { v.set(x, y, z).project(g.camera); if (v.z > 1 || v.z < -1) return; const sx = (v.x * 0.5 + 0.5) * W, sy = (1 - (v.y * 0.5 + 0.5)) * H; if (sx > box[0] - 40 && sx < box[2] + 40 && sy > box[1] - 60 && sy < box[3] + 60) outp.push(`${tag} ${Math.hypot(x - g.camera.position.x, z - g.camera.position.z) | 0}m`); };
        for (const b of g.people.bodies ?? []) test(b.x, b.y + 1, b.z, `person${b.id}`);
        for (const c of V.list) test(c.x, c.y + 0.7, c.z, `${c.spec.kind}${c.driver ? ':' + c.driver : ''}`);
        return outp.slice(0, 6);
      };
      const h = Math.atan2(p[2] - p[0], p[3] - p[1]);
      let checks = 0, bad = 0, flips = 0, onB = 0, pixelBad = 0, bufferBad = 0, read = 0, unread = 0; const badAt = [], reports = [];
      const recs = () => [...g.flip.recs.values()];
      for (let i = 0; i < frames; i++) {
        const f = i / (frames - 1);
        g.player.teleport(p[0] + (p[2] - p[0]) * f, p[1] + (p[3] - p[1]) * f, h);
        if (i === 0) g.cam.snap();
        const check = i % every === Math.min(3, every - 1) || i === frames - 1;
        const face0 = V.envFace, models0 = V.assets ? V.assets.size : -1, recs0 = g.flip.recs.size;
        g.tick(1 / 60);
        if (check || i === 0) hook();
        const list = recs(), before = list.map((r) => r.onB);
        F.stamp++;
        g.render();
        list.forEach((r, k) => { if (r.onB !== before[k]) flips++; });
        if (check) {
          const A = grab(), st = stale();
          // Send every buffer whole, to whichever copy is hanging on the mesh, and draw the same moment again.
          for (const r of g.flip.recs.values()) { const x = r.onB ? r.b : r.a; x.clearUpdateRanges(); x.needsUpdate = true; }
          g.render();
          const B = grab();
          let nd = 0, x0 = W, x1 = -1, y0 = H, y1 = -1, mx = 0; const mask = new Uint8Array(W * H);
          for (let k = 0, j = 0; k < A.length; k += 4, j++) {
            const dd = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]));
            if (dd) { nd++; mask[j] = 1; if (dd > mx) mx = dd; const xx = j % W, yy = H - 1 - ((j / W) | 0); if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
          }
          checks++; read += st.read; unread += st.unread;
          if (nd) pixelBad++;
          if (st.bad.length) bufferBad++;
          if (nd || st.bad.length) {
            bad++; badAt.push(i);
            if (reports.length < 6) {
              const rep = { frame: i, pixels: nd, box: nd ? [x0, y0, x1, y1] : null, maxDelta: mx, standingThere: nd ? near([x0, y0, x1, y1]) : [],
                staleBuffers: st.bad.slice(0, 6), staleBufferCount: st.bad.length,
                reflectionFace: face0 === V.envFace ? 'none drawn' : `drawn (${face0} to ${V.envFace})`,
                carModels: models0 === (V.assets ? V.assets.size : -1) ? 'none arrived' : `arrived (${models0} to ${V.assets.size})`,
                registered: recs0 === g.flip.recs.size ? 'unchanged' : `${recs0} to ${g.flip.recs.size}` };
              if (nd && reports.filter((x) => x.png).length < wantPics) rep.png = png(A, B, mask, [x0, y0, x1, y1]);
              reports.push(rep);
            }
          }
        }
      }
      for (const r of g.flip.recs.values()) if (r.onB) onB++;
      return { antialiasing: F.aa, registered: g.flip.recs.size, flipsPerFrame: +(flips / frames).toFixed(1), onTwinAtEnd: onB, checks, bad, pixelBad, bufferBad, buffersRead: read, drawnButUnread: unread, badAt: badAt.slice(0, 12), reports };
    }, [r.path, r.frames, every, !!opt.break, !!opt.msaa, opt.break ? 0 : Math.max(0, 2 - pics)]);
    if (!opt.break) await t.shot(`${shots}/flip-${q}-${r.name}.png`);
    const { reports, ...head } = res;
    total += res.checks; totalBad += res.bad;
    console.log(JSON.stringify({ q, scene: r.name, ...head }));
    for (const rep of reports) {
      if (rep.png) {
        const f = `${shots}/flipbad-${q}-${r.name}-f${rep.frame}.png`;
        fs.mkdirSync(path.dirname(path.resolve(ROOT, f)), { recursive: true });
        fs.writeFileSync(path.resolve(ROOT, f), Buffer.from(rep.png.split(',')[1], 'base64'));
        rep.png = f; pics++;
      }
      console.log('  BAD ' + JSON.stringify(rep));
    }
  }
} finally {
  console.log(JSON.stringify({ q, checks: total, bad: totalBad, errors: t.errors }));
  await t.close();
}
