import fs from 'node:fs';
const names = process.argv.slice(2);
for (const n of names) {
  const rows = JSON.parse(fs.readFileSync(n + '.json', 'utf8'));
  const passes = []; let cur = null;
  for (const r of rows) { if (!cur || cur.k !== r.k) { cur = { k: r.k, sz: r.sz, nout: r.nout, draws: 0, tris: 0, ms: 0, first: r.e }; passes.push(cur); } if (r.fl & 2 || r.idx) { cur.draws++; cur.tris += (r.idx / 3) * (r.inst || 1); } cur.ms += r.d * 1000; }
  const tot = passes.reduce((a, p) => a + p.ms, 0), draws = passes.reduce((a, p) => a + p.draws, 0);
  console.log(`== ${n}: ${draws} draws, ${passes.length} passes, ${tot.toFixed(2)} ms`);
  // merge passes with same key
  const m = new Map(); for (const p of passes) { const o = m.get(p.k) || { ...p, ms: 0, draws: 0, tris: 0, n: 0 }; o.ms += p.ms; o.draws += p.draws; o.tris += p.tris; o.n++; m.set(p.k, o); }
  [...m.values()].sort((a, b) => b.ms - a.ms).slice(0, 9).forEach((p) => console.log(`  ${p.sz.padEnd(10)} out=${p.nout} x${p.n} draws=${String(p.draws).padStart(4)} tris=${String(Math.round(p.tris / 1000)).padStart(5)}k ${p.ms.toFixed(2)}ms ${(100 * p.ms / tot).toFixed(0)}%  ev${p.first}`));
  rows.filter((r) => r.d > 0).sort((a, b) => b.d - a.d).slice(0, 4).forEach((r) => console.log(`  draw ev${r.e} ${r.sz} ${(r.d * 1000).toFixed(2)}ms idx=${r.idx} inst=${r.inst} ${r.n.slice(0, 50)}`));
}
