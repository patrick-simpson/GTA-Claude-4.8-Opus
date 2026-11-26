# Subtitle text for the spoken clips (fun queue 2, item 40): src/audio/subtitleText.json, from the scripts that made the audio.
#   python tools/access/gen-subs.py          (run from the repo root; needs scratch/voices/lines.py and scratch/fmdj/lines.py)
# pack name -> { clip id -> text }; the barks are { category -> [text] } (the clip id is category + index + m|f).
# The reactive Claude FM lines are not copied: they are already in src/audio/fmReactLines.json (clip id kind#i).
import sys, json
import importlib.util
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
V = load('voicelines', 'scratch/voices/lines.py'); F = load('fmlines', 'scratch/fmdj/lines.py')
out = {}
for key, row in V.DJ.items():
    texts = row[7]
    out['dj-' + key] = {('%s%d' % ('i' if t.startswith('*') else 'l', i)): t.lstrip('*') for i, t in enumerate(texts)}
out['ads'] = {cid: t for cid, v, t in V.ADS}
out['police'] = {cid: t for cid, kind, t in V.POLICE}
out['dj-claudefm'] = {cid: t for cid, kind, t in F.LINES}
out['barks'] = {cat: list(t) for cat, t in V.BARKS.items()}
json.dump(out, open('src/audio/subtitleText.json', 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=0, separators=(',', ': '))
print({k: len(v) for k, v in out.items()})
