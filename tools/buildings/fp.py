# Run from scratch/fixC (inputs: scratch/audit/osm_extra.json, scratch/audit/pois.json, scratch/streets/tools/warp.py; footprints.json, heights.json in cwd). Part of the footprint pipeline: fp.py -> lidar.py -> gen_ts.py (run from the repo root) -> src/world/footprintData.ts.
import sys, json, math
sys.path.insert(0, '../streets/tools')
import numpy as np
import warp
from shapely.geometry import Polygon, Point
from shapely.strtree import STRtree
B = json.load(open('../audit/osm_extra.json'))['elements']
POI = json.load(open('../audit/pois.json'))
GX0, GX1, GZ0, GZ1 = -950, 850, -3050, -950
def w(geom): return warp.FWD(np.array([warp.ll2r(p['lat'], p['lon']) for p in geom]))
lu = []
for e in B:
    t = e.get('tags', {})
    if e['type']=='way' and 'landuse' in t and 'geometry' in e and len(e['geometry'])>=4:
        try: lu.append((t['landuse'], Polygon(w(e['geometry']))))
        except Exception: pass
print('landuse', len(lu))
HOUSE={'house','detached','residential','semidetached_house','terrace','bungalow','static_caravan','cabin','farm','dormitory'}
SKIP={'garage','garages','shed','carport','roof','service','hut','greenhouse','barn','stable','cowshed','silo','tank','transformer_tower','ruins','construction','boathouse','container'}
out=[]
pp=[p for p in (POI if isinstance(POI,list) else POI.get('pois',[]))]
print('poi sample', pp[:1])
for e in B:
    t=e.get('tags',{})
    if e['type']!='way' or 'building' not in t or 'geometry' not in e or len(e['geometry'])<4: continue
    P=w(e['geometry']); c=P.mean(0)
    if not (GX0<=c[0]<=GX1 and GZ0<=c[1]<=GZ1): continue
    rp=Polygon([warp.ll2r(p['lat'],p['lon']) for p in e['geometry']])
    if not rp.is_valid: rp=rp.buffer(0)
    poly=Polygon(P)
    if not poly.is_valid: poly=poly.buffer(0)
    if poly.is_empty or rp.is_empty or rp.area<30: continue
    rm=list(rp.minimum_rotated_rectangle.exterior.coords)[:4]
    rl0=math.hypot(rm[1][0]-rm[0][0],rm[1][1]-rm[0][1]); rl1=math.hypot(rm[2][0]-rm[1][0],rm[2][1]-rm[1][1])
    mrr=poly.minimum_rotated_rectangle
    xs=list(mrr.exterior.coords)[:4]
    e0=(xs[1][0]-xs[0][0], xs[1][1]-xs[0][1]); e1=(xs[2][0]-xs[1][0], xs[2][1]-xs[1][1])
    l0=math.hypot(*e0); l1=math.hypot(*e1)
    cx,cz=mrr.centroid.x, mrr.centroid.y
    # long axis a (length L), short b
    if l0>=l1: ax=e0
    else: ax=e1
    L,Wd=max(rl0,rl1),min(rl0,rl1)
    ang=math.atan2(ax[0],ax[1])  # heading of the long axis, forward=(sin,cos)
    b=t['building']
    lus=[k for k,p in lu if p.contains(Point(cx,cz))]
    area=rp.area
    typ='house'
    if b in SKIP: typ='skip'
    elif b in ('church','chapel','cathedral','synagogue','temple'): typ='church'
    elif b in ('school','college','university','kindergarten'): typ='school'
    elif b in ('hospital',): typ='civic'
    elif b in ('civic','public','government','fire_station','townhall'): typ='civic'
    elif b in ('industrial','warehouse','factory','manufacture'): typ='industrial'
    elif b in ('retail','commercial','supermarket','office','hotel','kiosk'): typ='shop'
    elif b=='apartments': typ='apt'
    elif b in HOUSE: typ='house'
    else:
        if 'industrial' in lus: typ='industrial'
        elif 'retail' in lus or 'commercial' in lus: typ='shop'
        elif area<260: typ='house'
        elif area<700: typ='shop' if ('retail' in lus or 'commercial' in lus) else 'apt'
        else: typ='shop'
    if typ=='shop' and area>2200: typ='bigbox'
    elif typ=='shop' and L/Wd>3.2 and area>700: typ='strip'
    if typ=='industrial' and area>1500 and (cx>380): typ='mill'
    if 'mill' in t.get('name','').lower(): typ='mill'
    if typ=='house' and area<50: typ='skip'
    if typ in('skip',): continue
    ll=[(p['lon'],p['lat']) for p in e['geometry']]
    out.append(dict(id=e['id'],cx=round(cx,1),cz=round(cz,1),L=round(L,1),W=round(Wd,1),h=round(ang,3),a=round(area),t=typ,b=b,name=t.get('name',''),ll=ll))
print(len(out))
from collections import Counter
print(Counter(o['t'] for o in out))
json.dump(out,open('footprints.json','w'))
lons=[p[0] for o in out for p in o['ll']]; lats=[p[1] for o in out for p in o['ll']]
print(min(lons),max(lons),min(lats),max(lats))
