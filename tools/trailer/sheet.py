"""Contact sheet of the Blender trailer: one frame of each of the 19 shots (the middle, or --at 0..1), labelled with the
shot id and its time in the cut, in a grid.
   python tools/trailer/sheet.py [FRAMES_DIR] [OUT.png] [--at 0.5] [--cols 4]
Shot lengths: the same beat arithmetic as cut.mjs and export.mjs (k0 / beats on the promo's measured beat grid)."""
import json, os, sys
from PIL import Image, ImageDraw

a = [x for x in sys.argv[1:] if not x.startswith('--')]
opt = sys.argv[1:]
src = a[0] if a else 'C:/Users/User/trailer/frames'
out = a[1] if len(a) > 1 else 'C:/Users/User/trailer/final/contact_sheet.png'
frac = float(opt[opt.index('--at') + 1]) if '--at' in opt else 0.5
cols = int(opt[opt.index('--cols') + 1]) if '--cols' in opt else 4
here = os.path.dirname(os.path.abspath(__file__))
shots = [s for s in json.load(open(os.path.join(here, 'shots.json'), encoding='utf8'))['shots'] if 'k0' in s]
grid = json.load(open(os.path.join(here, '..', 'promo', 'storyboard.json'), encoding='utf8'))['music']['grid']
at = lambda k: 0.0 if k <= 0 else (60.0 if k >= len(grid) else grid[k])
tw, th = 480, 270
tiles = []
for s in shots:
    t0 = at(s['k0']); t1 = 60.0 if s.get('last') else at(s['k0'] + s['beats'])
    n = round(t1 * 24) - round(t0 * 24)
    d = os.path.join(src, s['id'])
    fs = sorted(f for f in os.listdir(d) if f.startswith('f') and f.endswith('.png') and os.path.getsize(os.path.join(d, f)) > 0) if os.path.isdir(d) else []
    im = Image.open(os.path.join(d, fs[min(len(fs) - 1, int(len(fs) * frac))])).convert('RGB').resize((tw, th), Image.LANCZOS) if fs else Image.new('RGB', (tw, th), (16, 20, 28))
    dr = ImageDraw.Draw(im)
    dr.rectangle([0, th - 20, tw, th], fill=(16, 20, 28))
    dr.text((6, th - 16), f"{s['id']}   {t0:.2f}-{t1:.2f} s   {len(fs)}/{n} frames", fill=(242, 232, 207))
    tiles.append(im)
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw + (cols + 1) * 6, rows * th + (rows + 1) * 6), (16, 20, 28))
for i, im in enumerate(tiles):
    sheet.paste(im, (6 + (i % cols) * (tw + 6), 6 + (i // cols) * (th + 6)))
os.makedirs(os.path.dirname(out), exist_ok=True)
sheet.save(out)
print(out, sheet.size)
