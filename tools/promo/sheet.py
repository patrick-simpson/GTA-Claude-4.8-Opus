"""Contact sheet: the middle frame of each shot (or --at 0..1), labelled with id and timing, in a grid.
   python tools/promo/sheet.py FRAMES_DIR OUT.png [--at 0.5] [--cols 4]"""
import json, os, sys
from PIL import Image, ImageDraw
a = sys.argv[1:]
src, out = a[0], a[1]
frac = float(a[a.index('--at') + 1]) if '--at' in a else 0.5
cols = int(a[a.index('--cols') + 1]) if '--cols' in a else 4
board = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'storyboard.json'), encoding='utf8'))
m = board.get('music', {}); grid = m.get('grid'); beat = 60 / board['bpm']; length = m.get('length', 60)
def at(k):  # mirrors tools/promo/timeline.mjs
    if not grid: return k * beat
    if k <= 0: return 0.0
    return grid[k] if k < len(grid) else length
tw, th = 400, 225
tiles, t, k = [], 0.0, 0
for s in board['shots']:
    d = os.path.join(src, s['id'])
    fs = sorted(f for f in os.listdir(d) if f.endswith('.png')) if os.path.isdir(d) else []
    im = Image.open(os.path.join(d, fs[min(len(fs) - 1, int(len(fs) * frac))])).convert('RGB').resize((tw, th), Image.LANCZOS) if fs else Image.new('RGB', (tw, th), (20, 33, 61))
    dr = ImageDraw.Draw(im)
    k += s['beats']; e = length if s is board['shots'][-1] else at(k)
    lab = f"{s['id']}  {t:.2f}-{e:.2f}s  {s['beats']}b" + (f"  [{s['card']['line']}]" if s.get('card') else '')
    dr.rectangle([0, th - 20, tw, th], fill=(20, 33, 61)); dr.text((6, th - 16), lab, fill=(242, 232, 207))
    tiles.append(im); t = e
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw + (cols + 1) * 6, rows * th + (rows + 1) * 6), (242, 232, 207))
for i, im in enumerate(tiles):
    sheet.paste(im, (6 + (i % cols) * (tw + 6), 6 + (i // cols) * (th + 6)))
sheet.save(out); print(out, sheet.size)
