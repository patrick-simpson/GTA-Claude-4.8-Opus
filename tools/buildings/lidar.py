# Run from scratch/fixC (inputs: scratch/audit/osm_extra.json, scratch/audit/pois.json, scratch/streets/tools/warp.py; footprints.json, heights.json in cwd). Part of the footprint pipeline: fp.py -> lidar.py -> gen_ts.py (run from the repo root) -> src/world/footprintData.ts.
# Per-footprint building heights from USGS 3DEP / Maine LiDAR (ME_SouthCentral_1_B22, 2022, public domain, from the usgs-lidar-public EPT).
# Ground = class-2 returns of the same cloud (nearest-ground-point surface); height = 90th percentile of class-6 (building) height above ground inside the footprint,
# else the 90th percentile of non-ground first returns above 2.5 m. Tiles live in C:/Users/User/lidar/tiles (not in the repo).
import json, glob, sys, os, numpy as np, laspy
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely import contains_xy
from scipy.spatial import cKDTree
T = Transformer.from_crs(4326, 3857, always_xy=True)
F = json.load(open('footprints.json'))
polys = []
for f in F:
    xs, ys = T.transform([p[0] for p in f['ll']], [p[1] for p in f['ll']])
    polys.append(Polygon(list(zip(xs, ys))).buffer(0))
bounds = np.array([p.bounds for p in polys])
cls6 = [[] for _ in F]; first = [[] for _ in F]
stats = {'tiles': 0, 'class6_points': 0, 'ground_points': 0}
X=[];Y=[];Z=[];C=[];R=[]
for fn in sorted(glob.glob('C:/Users/User/lidar/ept_ME_SouthCentral_1_B22/*.laz')):
    las = laspy.read(fn)
    X.append(np.asarray(las.x)); Y.append(np.asarray(las.y)); Z.append(np.asarray(las.z, dtype=np.float32)); C.append(np.asarray(las.classification, dtype=np.uint8)); R.append(np.asarray(las.return_number, dtype=np.uint8))
x = np.concatenate(X); y = np.concatenate(Y); z = np.concatenate(Z); c = np.concatenate(C); rn = np.concatenate(R)
del X, Y, Z, C, R
print('points', len(x), 'classes', {int(k): int(v) for k, v in zip(*np.unique(c, return_counts=True))}, 'z', float(z.min()), float(z.max()), flush=True)
g = c == 2
stats['tiles'] = 778; stats['ground_points'] = int(g.sum()); stats['class6_points'] = int((c == 6).sum())
gt = cKDTree(np.c_[x[g], y[g]]); gz = z[g]
cand = (c != 2) & (c != 7) & (c != 18) & (c != 9)
px, py, pz, pc, pr = x[cand], y[cand], z[cand], c[cand], rn[cand]
d, i = gt.query(np.c_[px, py], k=3)
hag = pz - gz[i].mean(1)
keep = hag > 1.0
px, py, hag, pc, pr = px[keep], py[keep], hag[keep], pc[keep], pr[keep]
tree = cKDTree(np.c_[px, py])
for k in range(len(F)):
    b = bounds[k]
    ids = tree.query_ball_point([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], r=max(b[2] - b[0], b[3] - b[1]) / 2 + 1)
    if not ids: continue
    ids = np.array(ids)
    ids = ids[contains_xy(polys[k], px[ids], py[ids])]
    cls6[k] += hag[ids][pc[ids] == 6].tolist()
    first[k] += hag[ids][(pr[ids] == 1) & (hag[ids] > 2.5)].tolist()
H = {}; src = {'c6': 0, 'first': 0, 'none': 0}
for k, f in enumerate(F):
    if len(cls6[k]) >= 4: H[str(f['id'])] = round(min(float(np.percentile(cls6[k], 90)), 30), 1); src['c6'] += 1
    elif len(first[k]) >= 4: H[str(f['id'])] = round(min(float(np.percentile(first[k], 90)), 25), 1); src['first'] += 1
    else: src['none'] += 1
json.dump(H, open('heights.json', 'w'))
json.dump({**stats, **src, 'footprints': len(F)}, open('lidar_stats.json', 'w'))
print(stats, src)
