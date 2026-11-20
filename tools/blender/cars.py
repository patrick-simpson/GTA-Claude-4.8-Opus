# Port Calamity's cars, modelled in Blender by script and exported as .glb.
#
#   blender --factory-startup --python tools/blender/cars.py --python-expr "import bpy; bpy.ops.wm.quit_blender()" -- sedan [--no-render] [--no-export] [--no-tex]
#   (with its window showing, never --background: the owner watches the screen)
#   blender --background --factory-startup --python tools/blender/cars.py -- --wheel-tex      (the shared tire maps)
#
# Writes public/models/<kind>.glb, its baked maps <kind>_n.webp and <kind>_o.webp (see "Textures" below; --no-tex
# leaves them and the UVs out and bakes occlusion into the vertices of every level, as before), and preview stills
# in shots/blender/<kind>_*.png. Set CARS_OUT to send a trial run's files somewhere other than public/models.
# After adding or dropping a kind's maps, keep TEX_KINDS in src/ent/vehicleAssets.ts in step.
#
# Everything is authored in the GAME's frame (x = the car's left, y = up, z =
# forward, y 0 = road, origin midway between the axles) and passed through B()
# into Blender's Z-up frame; the glTF exporter's Y-up conversion then lands it
# back exactly where it started. No assets are loaded: a car is a table of
# numbers in VEHICLES plus the recipe below.
#
# The recipe (see build()):
#   * shell(): a coarse quad cage, 9 rows round the half section by ~31
#     stations nose to tail, mirrored and subdivided once. Row 0 is the open
#     lower edge and follows the wheel arches; rows 4-8 are hood / glass /
#     roof / deck. Cage faces carry materials (glass, lamps, grille), cage
#     edges carry seams (shut-lines) and creases. After subdivision the glass
#     is inset behind a rubber seal (chrome first on the side windows), lamps
#     and grille get chrome bezels, and every seam is bevelled into a groove.
#   * bumper(): a C section swept round the plan-view superellipse of the nose
#     or tail.  underbody(), interior(), fittings(): boxes and lathes.
#   * wheel(): lathed tire and rim barrel, five twin spokes, hub, brake disc.
#     Hub at the origin, axle along X, outer face toward +X.
#   * bake(): ambient occlusion by ray casting (wheels and road included),
#     multiplied by a per-material tint and written to the vertex colours.
#     Paint and glass carry occlusion only: the game supplies their colour.
#   * LOD1 is the same recipe with the detail passes skipped and the cage
#     left unsubdivided, so lamps and glass keep their outlines.
#   * Painted bumpers swell out of the end plates in one surface (bumper(),
#     'blend'); Car.panel() lays a patch on the nose or tail by ray casting
#     onto the skin, which is how the Bolt's shield, mask and intake are made.
#   * All twelve vehicles are the sedan's table with overrides (VEHICLES) plus
#     a d_<kind>() of the parts only that vehicle has: bed, boom, wing, sign.
#     Run with no kind to build them all; <kind>_sheet.jpg tiles the stills.
#   * 'bolt' is the one real car (a 2017 Chevrolet Bolt EV, at the owner's request). --paint=r,g,b overrides the
#     preview colour for a run: a black car hides its own shape in a still.
# The file holds six meshes, LOD0..2 and WHEEL0..2 (0 the showroom car with
# its writing, lamp internals, underside and full cabin, drawn for the few
# cars nearest the camera; 1 the street car; 2 the cage, for distance and for
# phones), and four empties, HEAD_L/R and TAIL_L/R, where the glow sprites go.
# Material names are the contract with src/ent/vehicleAssets.ts: the lamp_*
# sections light separately there, 'glass' carries how opaque each pane is in
# the alpha of its vertex colour, and any other name is drawn with the
# roughness and metalness make_materials() gives it. Paint is always the per-instance
# colour; anything that must stay its own colour (taxi checker, cruiser door
# panel, light bars, the bus's sign) is baked into the vertex colours of
# trim / lamp_head / lamp_tail.

import bpy, bmesh, sys, os, json
from math import sin, cos, pi, radians, sqrt, hypot, asin, exp, atan2
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
# The lamp sections light separately in the game (src/ent/vehicleAssets.ts LAMP); 'gloss' is piano-black plastic.
MATS = ['paint', 'trim', 'chrome', 'glass', 'lamp_head', 'lamp_tail', 'interior', 'tire', 'rim',
        'lamp_brake', 'lamp_rev', 'lamp_ind', 'lamp_drl', 'gloss', 'grille', 'seat']
TMP = ['tmp_grille', 'tmp_sideglass', 'tmp_white', 'tmp_lamp']
REMAP = {'tmp_grille': 'grille', 'tmp_sideglass': 'glass', 'tmp_white': 'trim', 'tmp_lamp': 'lamp_head'}
MI = {n: i for i, n in enumerate(MATS + TMP)}
# Linear albedo baked into the vertex colours (times occlusion).
# A fourth number is alpha: how opaque a pane is in the game's near levels (the far level draws glass solid).
PANE = (1.0, 1.0, 1.0, 0.5)
TINT = {'paint': 1.0, 'trim': 0.022, 'chrome': 0.9, 'glass': PANE, 'lamp_head': (0.8, 0.8, 0.78),
        'lamp_tail': (0.5, 0.012, 0.01), 'interior': 0.03, 'tire': 0.014, 'rim': 0.86,
        'lamp_brake': (0.72, 0.02, 0.014), 'lamp_rev': (0.9, 0.9, 0.86), 'lamp_ind': (1.0, 0.42, 0.04),
        'lamp_drl': (0.92, 0.96, 1.0), 'gloss': 0.012, 'grille': 0.022, 'seat': 0.09,
        'tmp_grille': 0.022, 'tmp_sideglass': PANE, 'tmp_white': 0.8, 'tmp_lamp': (0.26, 0.26, 0.27)}

# End plates are a 5 x 3 grid of cells: a = 0 (the corner sliver) .. 4 (the centre), b = 0 (bottom) .. 2 (top band).
H_, G_, A_, T_ = 'lamp_head', 'tmp_grille', 'lamp_ind', 'lamp_tail'
FRONT = {(0, 2): A_, (1, 2): H_, (2, 2): H_, (3, 2): H_, (4, 2): G_}
REAR = {(a, 2): T_ for a in range(4)}
VERT = {(a, b): T_ for a in (1, 2) for b in (1, 2)}
# Bumper section materials, top ledge downward.
PLAIN = ['paint'] * 5 + ['trim'] * 2
CHROME = ['chrome'] * 5 + ['trim'] * 2
BLACK = ['trim'] * 7

# Lengths in meters; z stations are measured from mid-wheelbase. Every other vehicle is the sedan table with
# overrides, so a key missing below means "as the sedan". W/H/wb/track/R/tw and nose+tail match src/ent/vehicleSpecs.ts.
SEDAN = dict(
    W=1.85, H=1.45, wb=2.8, track=1.58, R=0.33, tw=0.22,
    nose=2.30, tail=2.40, sill=0.17, arch_gap=0.055, zs=1.5, n_front=4.5, n_rear=5.0,
    cowl=0.84, header=0.22, b1=-0.10, b2=-0.17, mid=-0.55, rhead=-0.90, deckf=-1.52,
    hood_cowl=0.955, hood_nose=0.785, belt=0.935, deck=1.0, deck_tail=0.975,
    xr=(0.585, 0.61, 0.59), roof=(1.425, 1.452, 1.45, 1.415), bow=(0.13, 0.09, -0.09, -0.11),
    bumper_top=(0.565, 0.62), bumper_bot=(0.19, 0.25), lift=(0.2, 0.28), paint=(0.045, 0.11, 0.24))

VEHICLES = {
    # Marlin Brougham: a three-box saloon.
    'sedan': SEDAN,
    # Pip 3-Door: short, tall, upright tail, one long door a side.
    'hatch': dict(SEDAN, W=1.7, H=1.5, wb=2.45, track=1.46, R=0.30, tw=0.20, nose=1.945, tail=1.855, arch_gap=0.05,
        zs=1.2, n_front=4.0, n_rear=5.5, cowl=0.72, header=0.18, b1=-0.42, b2=-0.49, mid=-0.80, rhead=-1.30, deckf=-1.63,
        hood_cowl=0.98, hood_nose=0.80, belt=0.96, deck=1.0, deck_tail=0.97, xr=(0.54, 0.565, 0.55),
        roof=(1.46, 1.50, 1.50, 1.455), bow=(0.11, 0.08, -0.05, -0.05), bumper_top=(0.55, 0.60), bumper_bot=(0.19, 0.24),
        lift=(0.2, 0.26), doors=[(0.72, 4), (-0.49, 4)], ends=(None, (0.62, 0.74)), rear={(1, 2): T_, (2, 2): T_}, trunk=False,
        front={(0, 2): A_, (1, 2): H_, (2, 2): H_, (3, 2): G_, (4, 2): G_},
        bumper_pm=PLAIN, plate_r_y=0.42, gate=1, chmsl=(1.44, -1.505), paint=(0.25, 0.32, 0.15)),
    # Sandpiper GT: long bonnet, low roof, one sweep of glass to a short tail.
    'coupe': dict(SEDAN, W=1.8, H=1.32, wb=2.65, track=1.55, R=0.33, tw=0.24, nose=2.225, tail=2.175, arch_gap=0.045,
        zs=1.4, n_front=3.6, n_rear=4.5, cowl=0.62, header=0.02, b1=-0.50, b2=-0.56, mid=-0.75, rhead=-0.95, deckf=-1.75,
        hood_cowl=0.915, hood_nose=0.70, belt=0.90, deck=0.97, deck_tail=0.93, xr=(0.55, 0.575, 0.55),
        roof=(1.29, 1.32, 1.315, 1.27), bow=(0.14, 0.10, -0.10, -0.12), bumper_top=(0.49, 0.60), bumper_bot=(0.17, 0.25),
        lift=(0.19, 0.28), doors=[(0.62, 4), (-0.56, 4)], cq=0.5, ends=((0.40, 0.545), None),
        front={(0, 2): A_, (1, 2): H_, (2, 2): H_, (3, 2): H_}, rear={(a, 2): T_ for a in range(5)}, plate_r_y=0.43,
        exhausts=(-0.5, 0.5), bumper_pm=PLAIN, paint=(0.023, 0.34, 0.27)),
    # Brawler Eight: blunt nose, a bonnet that goes on for ever, a scoop on it.
    'muscle': dict(SEDAN, W=1.92, H=1.35, wb=2.9, track=1.6, R=0.35, tw=0.28, nose=2.40, tail=2.55, zs=1.6, n_front=6, n_rear=6,
        cowl=0.55, header=-0.02, b1=-0.62, b2=-0.68, mid=-0.85, rhead=-1.10, deckf=-1.85, hood_cowl=0.95, hood_nose=0.86,
        belt=0.93, deck=1.0, deck_tail=1.01, xr=(0.58, 0.60, 0.58), roof=(1.31, 1.35, 1.345, 1.30),
        bow=(0.12, 0.09, -0.09, -0.10), bumper_top=(0.60, 0.70), bumper_bot=(0.22, 0.30), lift=(0.22, 0.30),
        doors=[(0.55, 4), (-0.68, 4)], cq=0.35, front={(0, 2): A_, (1, 2): H_, (2, 2): H_, (3, 2): G_, (4, 2): G_},
        rear={(1, 2): T_, (2, 2): T_, (3, 2): T_}, exhausts=(-0.55, 0.55), hood_crown=0.035, flare=0.02, caliper=(0.5, 0.03, 0.02), paint=(0.105, 0.042, 0.068)),
    # Cormorant RS: cab-forward mid-engine wedge.
    'sports': dict(SEDAN, W=1.95, H=1.18, wb=2.6, track=1.66, R=0.34, tw=0.30, nose=2.30, tail=2.05, sill=0.13, arch_gap=0.04,
        zs=1.3, n_front=3.0, n_rear=5, cowl=1.05, header=0.30, b1=-0.25, b2=-0.31, mid=-0.40, rhead=-0.62, deckf=-1.45,
        hood_cowl=0.88, hood_nose=0.56, hood_crown=-0.035, belt=0.86, deck=0.97, deck_tail=0.96, xr=(0.52, 0.55, 0.53),
        roof=(1.15, 1.18, 1.17, 1.12), bow=(0.16, 0.11, -0.06, -0.08), bumper_top=(0.38, 0.66), bumper_bot=(0.12, 0.26),
        lift=(0.14, 0.24), doors=[(0.85, 4), (-0.31, 4)], cq=0, ends=(None, (0.5, 0.78)),
        front={(1, 2): H_, (2, 2): H_}, bench=False, seat_e=-0.16, rub=False, exhausts=(-0.12, 0.12), bumper_pm=PLAIN,
        shd=0.06, flare=0.02, spokes=7, aerial=False, flap=False, caliper=(0.5, 0.03, 0.02), paint=(0.78, 0.095, 0.027)),
    # Dockhand: single cab, open bed.
    'pickup': dict(SEDAN, W=1.95, H=1.85, wb=3.3, track=1.66, R=0.40, tw=0.27, nose=2.60, tail=2.70, sill=0.36, arch_gap=0.07,
        zs=1.9, n_front=7, n_rear=7, cowl=1.02, header=0.52, b1=-0.38, b2=-0.45, mid=-0.52, rhead=-0.60, deckf=-0.70,
        hood_cowl=1.26, hood_nose=1.14, belt=1.24, deck=1.20, deck_tail=1.20, xr=(0.68, 0.70, 0.70),
        roof=(1.80, 1.85, 1.85, 1.83), bow=(0.10, 0.07, -0.02, -0.02), bumper_top=(0.74, 0.72), bumper_bot=(0.42, 0.46),
        lift=(0.40, 0.48), doors=[(1.02, 4), (-0.45, 4)], cq=0, bed=(-0.82, -2.50, 0.74), trunk=False, rear=VERT, bench=False,
        rub=False, rr=0.6, spokes=6, bumper_pm=CHROME, tuck=0.014, mirror=1.5, plate_r_y=0.59, mud=True, paint=(0.33, 0.068, 0.045)),
    # Breadbox: one tall box, cab over the front wheels.
    'van': dict(SEDAN, W=2.0, H=2.3, wb=3.2, track=1.7, R=0.36, tw=0.24, nose=2.52, tail=2.68, sill=0.30, arch_gap=0.06,
        zs=2.0, n_front=5, n_rear=8, cowl=1.80, header=1.15, b1=0.42, b2=0.35, mid=-0.85, rhead=-2.40, deckf=-2.47,
        hood_cowl=1.22, hood_nose=1.00, belt=1.22, deck=1.18, deck_tail=1.17, xr=(0.80, 0.84, 0.84),
        roof=(2.22, 2.30, 2.30, 2.27), bow=(0.10, 0.07, -0.01, -0.01), bumper_top=(0.62, 0.56), bumper_bot=(0.30, 0.32),
        lift=(0.32, 0.36), doors=[(1.80, 4), (0.35, 5), (-0.85, 5)], cq=0, sg_end=0.42, pillars=[], xc=0.06, split=True,
        trunk=False, rear=VERT, bench=False, rub=False, rr=0.6, handles=[0.52, 0.20], rake=0.015, tuck=0.012, mirror=1.6,
        bumper_pm=BLACK, plate_r_y=0.44, mud=True, aerial=False, paint=(0.89, 0.80, 0.62)),
    # Calamity Cab: the sedan, a little longer, with a sign and a checker band.
    'taxi': dict(SEDAN, H=1.5, wb=2.85, nose=2.35, tail=2.45, roof=(1.385, 1.412, 1.41, 1.375), paint=(0.87, 0.36, 0.0)),
    # Mule Wrecker: conventional truck cab, flat deck, boom.
    'tow': dict(SEDAN, W=2.2, H=2.4, wb=3.8, track=1.84, R=0.46, tw=0.30, nose=2.90, tail=3.30, sill=0.50, arch_gap=0.07,
        zs=2.2, n_front=7, n_rear=7, cowl=1.25, header=0.78, b1=-0.05, b2=-0.12, mid=-0.20, rhead=-0.30, deckf=-0.42,
        hood_cowl=1.52, hood_nose=1.40, belt=1.50, deck=1.20, deck_tail=1.20, xr=(0.80, 0.82, 0.82),
        roof=(2.0, 2.05, 2.05, 2.03), bow=(0.10, 0.07, -0.02, -0.02), bumper_top=(0.86, 0.80), bumper_bot=(0.52, 0.55),
        lift=(0.54, 0.60), doors=[(1.25, 4), (-0.12, 4)], cq=0, trunk=False, rear={(1, 2): T_, (2, 2): T_}, bench=False,
        rub=False, rr=0.58, spokes=6, bumper_pm=CHROME, tuck=0.014, mirror=1.6, mud=True, aerial=False, dual=True, paint=(0.33, 0.068, 0.045)),
    # Harbor Line No. 7: a flat-fronted city bus, doors on the kerb side (-x).
    'bus': dict(SEDAN, W=2.5, H=3.1, wb=5.6, track=2.1, R=0.50, tw=0.32, nose=5.10, tail=5.40, sill=0.34, arch_gap=0.07,
        zs=3.5, n_front=10, n_rear=10, cowl=4.88, header=4.66, b1=4.0, b2=3.9, mid=-1.0, rhead=-5.0, deckf=-5.12,
        hood_cowl=1.42, hood_nose=1.40, belt=1.40, deck=1.42, deck_tail=1.42, xr=(1.10, 1.12, 1.12),
        roof=(2.86, 2.90, 2.90, 2.88), bow=(0.04, 0.03, -0.02, -0.02), bumper_top=(0.74, 0.76), bumper_bot=(0.40, 0.44),
        lift=(0.36, 0.42), doors=[], cq=0, trunk=False, bstart=(4.7, 4.95), ends=((0.80, 1.02), (0.90, 1.20)),
        pillars=[(3.62, 3.50), (2.15, 2.05), (0.75, 0.65), (-0.20, -0.30), (-1.52, -1.62), (-2.95, -3.05), (-4.25, -4.35)],
        front={(0, 1): A_, (1, 1): H_, (2, 1): H_}, rear={(1, 1): T_, (2, 1): T_}, shd=0.34, shc=0.3, tuck=0.01, rake=0.01,
        bench=False, rub=False, rr=0.56, spokes=8, bumper_pm=BLACK, mirror=2.0, handles=[],
        flap=False, aerial=False, mud=True, dual=True, bus_doors=[(4.55, 3.66), (-0.33, -1.49)], seat_rows=[3.0 - 1.0 * i for i in range(8)], paint=(0.023, 0.34, 0.27)),
    # Harbor Patrol Interceptor: the sedan, wider and heavier, in uniform.
    'cruiser': dict(SEDAN, W=1.9, H=1.48, wb=2.9, track=1.6, R=0.34, tw=0.25, nose=2.32, tail=2.50,
        xr=(0.61, 0.635, 0.615), roof=(1.365, 1.392, 1.39, 1.355), white=(0.84, -0.90), rub=False, paint=(0.007, 0.015, 0.047)),
    # 2017 Chevrolet Bolt EV, the one real car: 4.17 x 1.77 x 1.60 m on a 2.60 m wheelbase. A tall one-box hatch: the
    # screen starts over the front axle and runs straight on from a short bonnet, the window line climbs through the
    # doors and kicks up behind the rear one into a black pillar (the floating roof), the lamps wrap both corners.
    'bolt': dict(SEDAN, W=1.77, H=1.60, wb=2.60, track=1.50, R=0.32, tw=0.215, nose=2.14, tail=2.03, sill=0.19, arch_gap=0.06,
        zs=1.35, n_front=2.7, n_rear=5.0, cowl=1.24, header=0.36, b1=-0.05, b2=-0.13, mid=-1.17, rhead=-1.55, deckf=-1.84,
        hood_cowl=1.085, hood_nose=0.80, hood_crown=0.025, belt=1.01, tuck=0.042, shc=0.9, twin=(5.0, 12.5), rise=(0.03, 0.10, 0.33), deck=1.17, deck_tail=1.14,
        xr=(0.56, 0.60, 0.585), roof=(1.50, 1.588, 1.592, 1.55), bow=(0.13, 0.08, -0.05, -0.05), rake=(0.10, 0.05),
        bumper_top=(0.625, 0.74), bumper_bot=(0.20, 0.26), lift=(0.21, 0.28), ends=((0.38, 0.655), (0.52, 0.74)),
        doors=[(0.84, 4), (-0.13, 4), (-1.10, 4)], pillars=[(0.84, 0.78), (-0.05, -0.13), (-1.10, -1.17)], cq=-0.5,
        fq_glass=True, floating=True, sweep=(1.5, -1.66), sweep_mat=(H_, T_), mirror_z=0.80, slats=False, trunk=False,
        bench=False, rub=False, gate=2, flap=False, aerial=False, chmsl=(1.516, -1.765), twotone=True, spoke_t=0.0115, rr=0.69,
        front={(0, 2): H_, (1, 2): H_, (2, 2): H_, (3, 2): H_},
        rear={(0, 2): T_, (1, 2): 'lamp_ind', (2, 2): 'lamp_brake'}, seat=(0.2, 0.2, 0.2),
        exhausts=(), bumper_pm=['paint'] * 4 + ['trim'] * 3, shd=0.085, flare=0.02, bowl=0.86,
        look={'grille': ((1, 1, 1), 0.0, 0.07, 1)}, diamond=(0.014, 0.0005), uvw={'grille': 7.0},
        crease_line=(1.5, -1.17), crease_full=True, hood_pow=1.25, paint=(0.004, 0.004, 0.005)),
    # 2015 Ford C-Max Hybrid SE, the second real car (the owner's own, in Magnetic grey): 4.41 x 1.83 x 1.61 m on a
    # 2.648 m wheelbase, 225/50R17. Nothing here is guessed: the numbers are read off the measured tables of the
    # owner's Blender model of this very car (C:/Users/User/cmax/cmax_build.py: traced from a studio profile, then
    # corrected against a photogrammetry solve of a walk-round video), with X there (nose 0, front axle 0.900, tail
    # 4.41) turned into z here as 2.224 - X.
    #   ZT, the bonnet and roof line: 0.80 at the bonnet's lip, 1.024 at the screen base (X 0.904: 'cowl' is where the
    #     screen meets the side, X 1.05, and 'bow' carries its middle forward), 1.535 at the header X 2.05, 1.61 on
    #     top, 1.52 where the spoiler leaves the roof X 3.90, 1.20 at the foot of the tailgate glass X 4.20.
    #   BELT, the window line: 1.0 at the screen base, 1.09 at the B-pillar, 1.25 at X 3.5 ('mid', where it kicks
    #     up) and 1.42 by X 3.72: the pointed rear quarter light.
    #   WTAB, half width in plan: 0.914 from X 0.9 to 3.6; nose 0.57 at X 0.1 and 0.76 at 0.31 (n_front 2.8); tail
    #     0.85 at X 4.13 and 0.76 at 4.27 (n_rear 4.5). WRF, the roof's half width: 0.64 over the doors, 0.52 at the back.
    #   label(): quarter light X 1.05-1.40, B-pillar X 2.38-2.50, rear door glass to X 3.19, quarter light X 3.27-3.70;
    #     head lamp X 0.08-0.73 (it sweeps back along the wing), tail lamp from X 3.83 at 0.97-1.19 high.
    'cmax': dict(SEDAN, W=1.83, H=1.61, wb=2.648, track=1.54, R=0.328, tw=0.225, nose=2.224, tail=2.186, sill=0.215, arch_gap=0.045,
        zs=1.32, n_front=2.8, n_rear=4.5, fkey=False, cowl=1.18, header=0.084, b1=-0.16, b2=-0.28, mid=-1.276, rhead=-1.636, deckf=-1.94,
        hood_cowl=0.995, hood_nose=0.80, hood_crown=0.03, hood_pow=1.5, belt=1.035, rise=(0.03, 0.185, 0.40), deck=1.195, deck_tail=1.19,
        xr=(0.585, 0.60, 0.50), roof=(1.535, 1.615, 1.585, 1.52), bow=(0.14, 0.09, -0.04, -0.04), rake=(0.06, 0.04),
        window_trim='trim', cab_belt=0.95, seat_e=0.12,
        # Part two, from measuring the exported file against ZT and BELT (scratch/cars4/measure.mjs). The nose: the
        # plate stands 3 cm behind the bumper, upright to 0.60 and then leaning back as 7.9 (y - 0.60)^2.45, which is
        # ZT's curve from the tip to the bonnet's lip (X 0.04 at 0.67, 0.094 at 0.74, 0.175 at 0.795, 0.24 at 0.83).
        # The glasshouse: belt 3 cm lower (the glass starts an inset above its row), the cant rail folded so the
        # glass keeps its height, the screen bowed 5 cm, the roof held at 1.61 back to X 3.1.
        proj=(0.03, 0.05), rake_curve=((0.60, 7.9, 2.45), None), screen_bulge=0.05, rail_crease=0.5, rail_drop=0.055,
        lamp_rim='trim', lamp_wall=H_, lens_rim='lamp_tail', lens_depth=0.002,
        # The owner's car has a dent at its left rear corner: a shallow dish in the quarter panel between the arch,
        # the bumper and the lamp, on the near level only (and a rust chip on the left front wing, in d_cmax).
        dents=[(1, 0.835, -1.865, 0.115, 0.017)],
        tuck=0.035, shc=0.8, shd=0.06, flare=0.018,
        bumper_top=(0.675, 0.71), bumper_bot=(0.20, 0.27), lift=(0.28, 0.31), ends=((0.40, 0.675), (0.74, 0.94)),
        doors=[(0.84, 4), (-0.28, 4), (-1.046, 4)], pillars=[(0.84, 0.79), (-0.16, -0.28), (-0.966, -1.046)], cq=-0.5,
        fq_glass=True, sweep=(1.5, -9.0), sweep_mat=(H_, T_), sweep_tip=1.6, sweep_top=1.64, mirror_z=0.78, slats=False, trunk=False,
        bench=False, rub=False, gate=2, aerial=False, flap=False, chmsl=(1.493, -1.808), spokes=15, twin=0, spoke_t=(0.006, 0.0105),
        front={(0, 2): H_, (1, 2): H_, (2, 2): H_}, rear={(0, 2): T_, (1, 2): T_, (2, 2): 'lamp_brake'},
        seat=(0.085, 0.08, 0.075), exhausts=(), bumper_pm=['paint'] * 6 + ['trim'],
        crease_line=(1.5, -1.741), crease_y=(0.84, 1.06), crease_full=True, paint=(0.0905, 0.0955, 0.0902)),
}


def B(x, y, z):
    """Game frame to Blender frame (a proper rotation, so winding survives)."""
    return Vector((x, -z, y))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


# ── Scene plumbing ───────────────────────────────────────────────────────────

def make_materials(paint, over=None):
    look = {'paint': (paint, 0.6, 0.28, 1), 'trim': ((1, 1, 1), 0.0, 0.6, 1), 'chrome': ((1, 1, 1), 1.0, 0.08, 1),
            'glass': ((0.02, 0.03, 0.035), 0.0, 0.03, 0.45), 'lamp_head': ((1, 1, 1), 0.9, 0.14, 1),
            'lamp_tail': ((1, 1, 1), 0.0, 0.1, 1), 'interior': ((1, 1, 1), 0.0, 0.8, 1),
            'tire': ((1, 1, 1), 0.0, 0.85, 1), 'rim': ((1, 1, 1), 0.85, 0.24, 1), 'gloss': ((1, 1, 1), 0.0, 0.06, 1),
            'grille': ((1, 1, 1), 0.0, 0.45, 1), 'seat': ((1, 1, 1), 0.0, 0.9, 1)}
    for n in ('lamp_brake', 'lamp_rev', 'lamp_ind', 'lamp_drl'): look[n] = look['lamp_tail']
    # A kind may restate a material ('look' in its table): the Bolt's grille is a closed gloss panel.
    look.update(over or {})
    for n in MATS + TMP:
        m = bpy.data.materials.new(n)
        try:
            m.use_nodes = True
        except Exception:
            pass
        col, metal, rough, alpha = look.get(n, ((1, 1, 1), 0, 0.5, 1))
        nt = m.node_tree
        bsdf = next((x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        # Preview only: vertex colour (occlusion x tint) times the material colour.
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = 'Col'
        mul = nt.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = col
        nt.links.new(at.outputs['Color'], mul.inputs[0])
        nt.links.new(mul.outputs[0], bsdf.inputs['Base Color'])
        bsdf.inputs['Metallic'].default_value = metal
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Alpha'].default_value = alpha
        if n == 'paint':
            for k, v in (('Coat Weight', 1.0), ('Coat Roughness', 0.04)):
                if k in bsdf.inputs: bsdf.inputs[k].default_value = v
        if alpha < 1:
            for k, v in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
                try: setattr(m, k, v)
                except Exception: pass
        m.use_backface_culling = True


def new_bm(verts, faces, mat='paint', mats=None):
    bm = bmesh.new()
    vs = [bm.verts.new(B(*v)) for v in verts]
    for i, f in enumerate(faces):
        try:
            face = bm.faces.new([vs[k] for k in f])
        except ValueError:
            continue
        face.material_index = MI[mats[i] if mats else mat]
    return bm


def orient(bm, hint=None, flip=False):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    bad = False
    if hint:
        if hint[0] == 'up':
            f = max(bm.faces, key=lambda f: f.calc_center_median().z); bad = f.normal.z < 0
        elif hint[0] == 'out':
            c = B(*hint[1])
            bad = sum((f.calc_center_median() - c).dot(f.normal) * f.calc_area() for f in bm.faces) < 0
        elif hint[0] == 'dir':
            bm.faces.ensure_lookup_table()
            bad = bm.faces[hint[2]].normal.dot(B(*hint[1])) < 0
    if bad != flip:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.normal_update()


def stamp(me, tint=None):
    """Per-corner albedo and a per-vertex 'dark' factor, both consumed by bake()."""
    a = me.attributes.new('tint', 'FLOAT_COLOR', 'CORNER')
    flat = []
    for p in me.polygons:
        t = tint if tint is not None else TINT[(MATS + TMP)[p.material_index]]
        t = (t, t, t) if isinstance(t, (int, float)) else t
        flat += [t[0], t[1], t[2], t[3] if len(t) > 3 else 1.0] * p.loop_total
    a.data.foreach_set('color', flat)
    if 'dark' not in me.attributes:
        me.attributes.new('dark', 'FLOAT', 'POINT')


def to_obj(bm, name, tint=None, me=None):
    if me is None:
        me = bpy.data.meshes.new(name)
        for n in MATS: me.materials.append(bpy.data.materials[n])
    bm.to_mesh(me); bm.free()
    ob = me.users and next((o for o in bpy.data.objects if o.data is me), None)
    if not ob:
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
    stamp(me, tint)
    return ob


def apply_mods(ob):
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_apply(modifier=m.name)


def join(parts, name):
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = parts[0]; ob.name = name; ob.data.name = name
    return ob


def boxv(c, s, pitch=0.0):
    vs = []
    for dx in (-.5, .5):
        for dy in (-.5, .5):
            for dz in (-.5, .5):
                y, z = dy * s[1], dz * s[2]
                if pitch: y, z = y * cos(pitch) - z * sin(pitch), y * sin(pitch) + z * cos(pitch)
                vs.append((c[0] + dx * s[0], c[1] + y, c[2] + z))
    return vs, [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


def box(name, c, s, mat, tint=None, bevel=0.0, pitch=0.0, drop=None, flip=False, segs=1):
    v, f = boxv(c, s, pitch)
    if drop is not None: f = [q for i, q in enumerate(f) if i != drop]
    bm = new_bm(v, f, mat=mat)
    if bevel: bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=segs, affect='EDGES', profile=0.5)
    orient(bm, ('out', c), flip)
    return to_obj(bm, name, tint)


def lathe(profile, segs, a0=0.0, a1=2 * pi, c=(0, 0, 0)):
    """Revolve (x, r) points about the X axis through c. Returns verts, faces and each face's band."""
    closed = abs(a1 - a0 - 2 * pi) < 1e-6
    n = segs if closed else segs + 1
    verts, rings, faces, band = [], [], [], []
    for x, r in profile:
        if r < 1e-6:
            verts.append((c[0] + x, c[1], c[2])); rings.append([len(verts) - 1] * n)
        else:
            ring = []
            for i in range(n):
                a = a0 + (a1 - a0) * i / segs
                verts.append((c[0] + x, c[1] + r * sin(a), c[2] + r * cos(a))); ring.append(len(verts) - 1)
            rings.append(ring)
    for p in range(len(profile) - 1):
        for i in range(segs):
            j = (i + 1) % n if closed else i + 1
            q = []
            for k in (rings[p][i], rings[p][j], rings[p + 1][j], rings[p + 1][i]):
                if k not in q: q.append(k)
            if len(q) >= 3: faces.append(q); band.append(p)
    return verts, faces, band


def text(name, body, c, right, up, height, mat, tint, bend=None, squeeze=1.0):
    """Flat lettering in Blender's own font: glyphs `height` tall centred on c, reading along `right`, standing
    along `up` (game frame), facing right x up. bend=(r0, x) wraps it round a wheel instead: about the X axis at
    radius r0 on the plane x, centred on c[0] radians, for the writing on a sidewall."""
    cu = bpy.data.curves.new('txt', 'FONT'); cu.body = body; cu.resolution_u = 2; cu.align_x = 'CENTER'
    tmp = bpy.data.objects.new('txt', cu); bpy.context.scene.collection.objects.link(tmp)
    src = bpy.data.meshes.new_from_object(tmp.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    k = height / 0.69; R_ = Vector(right); U_ = Vector(up); C_ = Vector(c); v = []
    for q in src.vertices:
        a, b = q.co.x * k * squeeze, (q.co.y - 0.345) * k
        if bend:
            r = bend[0] + b; t = c[0] + a / bend[0]
            v.append((bend[1], r * sin(t), r * cos(t)))
        else:
            v.append(tuple(C_ + R_ * a + U_ * b))
    f = [tuple(p.vertices) for p in src.polygons]
    bpy.data.objects.remove(tmp); bpy.data.curves.remove(cu); bpy.data.meshes.remove(src)
    bm = new_bm(v, f, mat=mat); bm.normal_update()
    n = B(1, 0, 0) if bend else B(*R_.cross(U_))
    for fc in bm.faces:
        if fc.normal.dot(n) < 0: fc.normal_flip()
    bm.normal_update()
    return to_obj(bm, name, tint)


def ring(name, c, r0, r1, depth, axis, mat, tint=None, segs=16):
    """A flat-faced ring (or a disc, r0 = 0) `depth` thick from c along +x or +z (game frame; negative depth the other way)."""
    prof = [(0, r0), (depth, r0), (depth, r1), (0, r1)] if r0 > 0 else [(depth, 0), (depth, r1), (0, r1)]
    v, f, _ = lathe(prof, segs)
    if axis == 'z': v = [(yy, zz, x) for x, yy, zz in v]
    v = [(c[0] + a, c[1] + b, c[2] + d) for a, b, d in v]
    bm = new_bm(v, f, mat=mat)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.normal_update()
    # The cap is the last band's neighbour: make it face the way the ring was pushed.
    cap = max(bm.faces, key=lambda fc: (fc.calc_center_median() - B(*c)).dot(B(*((1, 0, 0) if axis == 'x' else (0, 0, 1)))) * (1 if depth > 0 else -1))
    want = B(*((1, 0, 0) if axis == 'x' else (0, 0, 1))) * (1 if depth > 0 else -1)
    if cap.normal.dot(want) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.normal_update()
    return to_obj(bm, name, tint)


# What is written on each one: the number plate, the maker's initial for the emblem, and the name on the tail.
PLATES = {'sedan': '4MRL 207', 'hatch': 'PIP 3310', 'coupe': '7SND 451', 'muscle': 'BR8 LOUD', 'sports': 'C0R 9RS', 'pickup': 'DK 48112',
          'van': 'BRD 6094', 'taxi': 'CAB 0117', 'tow': 'MULE 22', 'bus': 'HL 0007', 'cruiser': 'HP 1911', 'bolt': '6EV 2017', 'cmax': '5CM 2015'}
BADGE = {'sedan': ('M', 'MARLIN'), 'hatch': ('P', 'PIP'), 'coupe': ('S', 'SANDPIPER'), 'muscle': ('B', 'BRAWLER'), 'sports': ('C', 'CORMORANT'),
         'pickup': ('D', 'DOCKHAND'), 'van': ('B', 'BREADBOX'), 'taxi': ('M', 'MARLIN'), 'tow': ('M', 'MULE'), 'bus': ('H', 'HARBOR LINE'),
         'cruiser': ('M', 'INTERCEPTOR'), 'bolt': (None, 'BOLT EV'), 'cmax': (None, 'C-MAX')}


# ── The body shell ───────────────────────────────────────────────────────────

class Car:
    def __init__(s, P):
        s.P = P; s.g = P.get
        s.hw = P['W'] / 2 - 0.008
        s.zF, s.zR = P['wb'] / 2, -P['wb'] / 2
        s.arch_r = P['R'] + P['arch_gap']
        # 'proj': how far the bumpers stand ahead of the end plates, (front, rear). 5 cm unless a kind says otherwise.
        pj = P.get('proj', (0.05, 0.05))
        s.zNf, s.zNr = P['nose'] - pj[0], P['tail'] - pj[1]
        # Shut-lines across the side: (z, how many rows up from the sill the cut runs).
        s.doors = P.get('doors', [(P['cowl'], 4), (P['b2'], 4), (P['rhead'], 4)])
        s.pillars = P.get('pillars', [(P['b1'], P['b2'])])
        # The side glass runs past the rear header into the C-pillar by this share: the rear quarter light.
        s.cq = P['rhead'] - P.get('cq', 0.3) * (P['rhead'] - P['deckf'])
        s.sg_end = P.get('sg_end', s.cq)
        # hi is the showroom level: everything gated on it is drawn for the few cars nearest the camera only.
        s.hi = False; s.kind = ''; s.covers = []; s.lamp_c = {}; s.lamp_cells = {}; s.skin = None; s.shell_bvh = None
        s.cells = {1: P.get('front', FRONT), -1: s.sections(P.get('rear', REAR))}

    @property
    def Rc(s):
        # One subdivision pulls a control polygon in by (6 + 2 cos(step)) / 8: the arch is cut in 30-degree steps on
        # the street car and 15 on the showroom one, where 30 showed as flats round the wheel.
        return s.arch_r / (0.99148 if s.hi else 0.9665)

    @staticmethod
    def sections(cells):
        """A tail lamp given only as T_ cells is shared out into indicator, tail, brake and reverse, corner inward
        (or brake above, indicator and reverse below, where the cells are stacked)."""
        t = sorted(k for k, v in cells.items() if v == T_)
        if not t or 'lamp_brake' in cells.values(): return cells
        out = dict(cells)
        if len({b for _, b in t}) > 1:
            lo = min(b for _, b in t); low = [k for k in t if k[1] == lo]
            for k in t: out[k] = 'lamp_brake'
            for i, k in enumerate(low): out[k] = 'lamp_ind' if i == 0 and len(low) > 1 else 'lamp_rev'
        else:
            for k in t: out[k] = 'lamp_brake'
            if len(t) >= 2: out[t[-1]] = 'lamp_rev'
            if len(t) >= 3: out[t[0]] = 'lamp_ind'
            if len(t) >= 4: out[t[1]] = T_
        return out

    def rake(s, end, y):
        """How far the end plates lean in with height; one number, or (front, rear)."""
        # 'rake_curve': (front, rear), each None or (y0, A, p): upright below y0 and leaning back by A (y - y0)^p
        # above it, for a nose that runs from an upright bumper into the bonnet in one curve (the C-Max).
        rc = s.g('rake_curve', (None, None))[0 if end > 0 else 1]
        if rc: return rc[1] * max(0.0, y - rc[0]) ** rc[2]
        rk = s.g('rake', 0.035)
        if isinstance(rk, tuple): rk = rk[0 if end > 0 else 1]
        return rk * (y - 0.2) / 0.5

    def plan(s, z):
        """Half width of the body in plan: straight sides, superellipse ends."""
        P = s.P
        zN, n = (s.zNf, P['n_front']) if z > 0 else (s.zNr, P['n_rear'])
        u = (abs(z) - P['zs']) / (zN - P['zs'])
        return s.hw if u <= 0 else s.hw * max(0.0, 1 - min(1.0, u) ** n) ** (1 / n)

    def zplan(s, x, end, zN=None, W=None):
        """How far forward (end=1) or back (end=-1) the body reaches at half width x."""
        P = s.P
        zN = zN or (s.zNf if end > 0 else s.zNr); n = P['n_front'] if end > 0 else P['n_rear']
        return end * (P['zs'] + (zN - P['zs']) * max(0.0, 1 - min(1.0, abs(x) / (W or s.hw)) ** n) ** (1 / n))

    def corner_z(s, end):
        P = s.P
        zN, n = (s.zNf, P['n_front']) if end > 0 else (s.zNr, P['n_rear'])
        return end * (P['zs'] + (zN - P['zs']) * 0.5 ** (1 / n))

    def arch_floor(s, z):
        for zc in (s.zF, s.zR):
            d = abs(z - zc)
            if d <= s.Rc + 1e-6: return s.P['R'] + sqrt(max(0.0, s.Rc ** 2 - d * d))
        return s.P['sill']

    def hood(s, w, y, crown=None):
        # A negative crown sinks the bonnet between the wing tops (the mid-engine wedge).
        c = s.g('hood_crown', 0.03) if crown is None else crown
        x3 = s.g('xc', 0.4 * w) if crown is not None and s.g('split') else 0.40 * w
        x2 = s.hw - s.P['xr'][2] + 0.02 if crown is not None and s.g('split') else 0.23
        return [(w - 0.04, y - 0.014), (w - 0.12, y), (w - x2, y + 0.010), (x3, y + c * 0.8), (0.0, y + c)]

    def cabin(s, w, belt, xr, roof):
        # 'rail_drop': how far below the roof's crown the top of the side glass (the cant rail) sits.
        return [(w - 0.055, belt), (xr + 0.055, roof - s.g('rail_drop', 0.07)), (xr, roof - 0.022), (s.g('xc', 0.34), roof - 0.005), (0.0, roof)]

    def top(s, z):
        """Rows 4-8 of the section at z, and how far its centre bows along z (screens are curved in plan)."""
        P = s.P; zc0 = s.corner_z(1); zc1 = s.corner_z(-1)
        if z >= P['cowl']:
            u = (z - P['cowl']) / (zc0 - P['cowl'])
            # 'hood_pow': 1.8 lies flat behind a falling nose; nearer 1 is a ramp that runs on into the screen.
            y = P['hood_cowl'] - (P['hood_cowl'] - P['hood_nose']) * min(1.0, u) ** s.g('hood_pow', 1.8)
            return s.hood(s.plan(z), y), P['bow'][0] * max(0.0, 1 - (z - P['cowl']) / 0.3)
        if z <= P['deckf']:
            u = (P['deckf'] - z) / (P['deckf'] - zc1)
            y = lerp(P['deck'], P['deck_tail'], min(1.0, u) ** 1.4)
            return s.hood(s.plan(z), y, 0.02), P['bow'][3] * max(0.0, 1 - (P['deckf'] - z) / 0.3)
        xr, rf, bw, belt = P['xr'], P['roof'], P['bow'], P['belt']
        # How far the window line has climbed by the B-pillar, 'mid' and the rear header. 'mid' is where it kinks.
        rise = s.g('rise', (0.002, 0.005, 0.01))
        keys = [(P['cowl'], s.hood(s.hw, P['hood_cowl']), bw[0]),
                (P['header'], s.cabin(s.hw, belt, xr[0], rf[0]), bw[1]),
                (P['b1'], s.cabin(s.hw, belt + rise[0], xr[1], rf[1]), 0.0),
                (P['b2'], s.cabin(s.hw, belt + rise[0], xr[1], rf[1]), 0.0),
                (P['mid'], s.cabin(s.hw, belt + rise[1], xr[1], rf[2]), 0.0),
                (P['rhead'], s.cabin(s.hw, belt + rise[2], xr[2], rf[3]), bw[2]),
                (P['deckf'], s.hood(s.hw, P['deck'], 0.02), bw[3])]
        for a, b in zip(keys, keys[1:]):
            if b[0] <= z <= a[0]:
                t = (a[0] - z) / (a[0] - b[0])
                rows = [(lerp(p[0], q[0], t), lerp(p[1], q[1], t)) for p, q in zip(a[1], b[1])]
                # 'screen_bulge': the screen and the pillars beside it stand this far above the straight line from
                # the cowl to the header at mid height (a real screen is a bow in profile, not a ramp).
                sb = s.g('screen_bulge')
                if sb and P['header'] < z < P['cowl']:
                    tt = (P['cowl'] - z) / (P['cowl'] - P['header']); dy = sb * 4 * tt * (1 - tt)
                    rows = rows[:1] + [(x_, y_ + dy) for x_, y_ in rows[1:]]
                return rows, lerp(a[2], b[2], t)
        raise ValueError(z)

    def stations(s):
        P = s.P; c0, c1 = s.corner_z(1), s.corner_z(-1)
        keys = [P['cowl'], (P['cowl'] + P['header']) / 2, P['header'], P['b1'], P['b2'], P['mid'], P['rhead'],
                (P['rhead'] + P['deckf']) / 2, P['deckf'], s.cq, s.zR - s.Rc - 0.235]
        # 'fkey': False leaves out the station ahead of the front arch. On a long front overhang it lands 8 cm behind
        # the corner, and the corner may only lean back as far as the station behind it (see shell): a raked nose
        # then keeps an upright fin at each corner. (On the Bolt it falls outside 'inside' and was never there.)
        if s.g('fkey', True): keys.append(s.zF + s.Rc + 0.205)
        keys += [d[0] for d in s.doors] + [z for p in s.pillars for z in p] + list(s.g('bed', ())[:2]) + [z for d in s.g('bus_doors', ()) for z in d]
        inside = lambda z: c1 + 0.045 < z < c0 - 0.045
        ks = []
        for z in keys:
            if inside(z) and all(abs(z - k) > 0.028 for k in ks): ks.append(z)
        arch = []
        for zc in (s.zF, s.zR):
            arch += [zc + s.Rc + 0.035, zc - s.Rc - 0.035] + [zc + s.Rc * cos(radians(a)) for a in range(0, 181, 15 if s.hi else 30)]
        # An arch station too close to a key one makes a sliver the glass insets cannot fit in (it threw spikes out of the
        # cruiser's rear quarter); the key station stands in for it, the arch height being exact at any z.
        return sorted([c0, c1] + ks + [z for z in arch if inside(z) and all(abs(z - k) > (0.045 if s.hi else 0.025) for k in ks)], reverse=True)

    def side(s, z, sh, end=0):
        """Rows 0-3: the open lower edge (sill or arch), the sill line, the shoulder crease and the shoulder."""
        P = s.P; a = s.arch_floor(z); w = s.plan(z)
        # The lower edge sweeps up toward both ends, under the bumpers.
        if z < s.zR - s.Rc - 0.03: a = lerp(P['sill'], P['lift'][1], smooth((s.zR - s.Rc - 0.03 - z) / 0.35))
        if z > s.zF + s.Rc + 0.03: a = lerp(P['sill'], P['lift'][0], smooth((z - s.zF - s.Rc - 0.03) / 0.3))
        tn = smooth((z - (s.zF + s.Rc + 0.04)) / 0.15); tt = smooth(((s.zR - s.Rc - 0.04) - z) / 0.2)
        te = 1.0 if end else max(tn, tt); i = 0 if z > 0 else 1
        # Past the arches the rows become the lamp band and the bumper line of the end plate.
        f1, f2 = (0.30, 0.68) if i == 0 else (0.35, 0.72)
        e = s.g('ends', (None, None))[i] or (a + (sh - a) * f1, a + (sh - a) * f2)
        # Between them row 2 is the widest point of the car, creased: the skin tucks in above it to the glass and
        # barrels under below it. Without it the side is a slab.
        yc = sh - s.g('shd', 0.075)
        # 'crease_line' (z, z) rules the crease straight between two stations instead of letting it follow the
        # window line, which sags along the front door on a body whose bonnet stands above its belt.
        cl = s.g('crease_line'); cy = s.g('crease_y')
        if cl and cl[1] < z < cl[0]:
            ya, yb = cy or (s.top(q)[0][0][1] - 0.045 - s.g('shd', 0.075) for q in cl)
            yc = lerp(ya, yb, (cl[0] - z) / (cl[0] - cl[1]))
        # 'crease_y' gives the line's two heights outright, for a body whose window line climbs away from its crease
        # at the back (the C-Max): behind the line's end the crease then holds that height until it dives to the lamps.
        elif cl and cy and z <= cl[1]: yc = cy[1]
        y2 = lerp(max(yc, a + 0.03), e[1], te)
        y1 = lerp(a + (y2 - a) * 0.2, e[0], te)
        tuck = lerp(s.g('tuck', 0.024), 0.011, te)
        rows = []
        for y in (a, y1, y2, sh):
            if y >= y2: x = w - tuck * (y - y2) / max(1e-6, sh - y2)
            else: x = w * (1 - 0.032 * min(1.0, (y2 - y) / max(0.05, y2 - P['sill'])) ** 2)
            for zc in (s.zF, s.zR):
                if abs(z - zc) < s.Rc + 0.1:
                    x += s.g('flare', 0.014) * exp(-max(0.0, hypot(z - zc, y - P['R']) - s.Rc) / 0.05)
            rows.append((x, y))
        return rows

    def xat(s, z, y):
        """Half width of the cage at (z, y), for laying things on the side."""
        rows = s.top(z)[0]; pts = s.side(z, rows[0][1] - 0.045) + rows[:2]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if y0 <= y <= y1: return lerp(x0, x1, (y - y0) / max(1e-6, y1 - y0))
        return pts[-1][0] if y > pts[-1][1] else pts[0][0]

    def shell(s, lod):
        P = s.P; st = s.stations(); NS = len(st)
        verts, faces, fm = [], [], []
        idx = [[0] * 9 for _ in st]
        CW = [0, 0, 0.35, 0.85, 1]
        info = []
        for j, z in enumerate(st):
            rows, bow = s.top(z)
            end = 1 if j == 0 else -1 if j == NS - 1 else 0
            sd = s.side(z, rows[0][1] - 0.045, end)
            info.append((sd, rows))
            for k in range(9):
                x, y = sd[k] if k < 4 else rows[k - 4]
                zz = z + bow * CW[k - 4] if k >= 4 else z
                if end and k >= 4: zz = s.zplan(x, end) - end * s.rake(end, y)
                # The corner leans back with the end plate it is the edge of. It used to stand upright, so at lamp
                # height it stood ahead of the plate (3 cm on most kinds, 9 on the Bolt, whose nose leans most): a
                # fin up each corner that boxed the lamps in and showed in the outline as a tooth. It stops 3 cm
                # short of the station behind it, so a tall tail cannot fold over.
                if end and k < 4:
                    zz = z - end * s.rake(end, y)
                    zz = max(zz, st[1] + 0.03) if end > 0 else min(zz, st[NS - 2] - 0.03)
                idx[j][k] = len(verts); verts.append((x, y, zz))
        zmid = lambda j: (st[j] + st[j + 1]) / 2
        mscr = (P['cowl'] + P['header']) / 2
        bed = s.g('bed'); white = s.g('white'); sweep = s.g('sweep'); rear_ks = (6,) if s.g('split') else (6, 7)

        def fmat(j, k):
            z = zmid(j)
            if k == 4:
                if P['cowl'] > z > mscr and not s.g('fq_glass'): return 'trim'
                if P['cowl'] > z > s.sg_end: return 'gloss' if any(a > z > b for a, b in s.pillars) else 'tmp_sideglass'
            # The floating roof: the pillar behind the side glass is black from the belt to the roof and round to the rear screen.
            if s.g('floating') and ((k == 4 and s.sg_end > z > P['deckf']) or (k == 5 and P['rhead'] > z > P['deckf'])): return 'gloss'
            # Lamps that sweep back along the wings from the end plates.
            # ('sweep_tip': from the head lamp's tail to this station only its upper band is lamp, so it ends in a point.)
            if sweep and k in (2, 3) and z > sweep[0] and (k == 3 or z > s.g('sweep_tip', -1e9)): return s.g('sweep_mat', (H_, T_))[0]
            if sweep and k in (2, 3) and z < sweep[1]: return s.g('sweep_mat', (H_, T_))[1]
            # 'sweep_top': ahead of this station the head lamp also laps over the top of the wing, as far as the bonnet's edge.
            if sweep and k == 4 and z > s.g('sweep_top', 1e9): return s.g('sweep_mat', (H_, T_))[0]
            if k in (6, 7) and P['cowl'] > z > P['header']: return 'glass'
            if k in rear_ks and P['rhead'] > z > P['deckf']: return 'glass'
            if k < 4 and white and white[0] > z > white[1]: return 'tmp_white'
            return 'paint'
        for j in range(NS - 1):
            for k in range(8):
                # An open load bed: the deck is left out between the rails and d_pickup() drops a box in.
                if bed and k >= 5 and bed[0] > zmid(j) > bed[1]: continue
                faces.append((idx[j][k], idx[j + 1][k], idx[j + 1][k + 1], idx[j][k + 1])); fm.append(fmat(j, k))
        plates = {}; Gs = {}
        for j, end in ((0, 1), (NS - 1, -1)):
            sd, rows = info[j]
            G = {}; cells = s.cells[end]
            for b in range(4):
                G[0, b] = idx[j][b]
                for a in range(1, 6):
                    x = rows[a - 1][0]; y = sd[b][1]
                    G[a, b] = len(verts); verts.append((x, y, s.zplan(x, end) - end * s.rake(end, y)))
            for b in range(3):
                for a in range(5):
                    faces.append((G[a, b], G[a + 1, b], G[a + 1, b + 1], G[a, b + 1])); fm.append(cells.get((a, b), 'paint'))
            faces.append((G[0, 3], G[1, 3], idx[j][4])); fm.append('paint')
            for a in range(1, 5):
                faces.append((G[a, 3], G[a + 1, 3], idx[j][4 + a], idx[j][3 + a])); fm.append('paint')
            gx = rows[2][0] if cells.get((3, 2)) == G_ else rows[3][0]
            plates[end] = (sd[2][1], sd[3][1], s.zplan(0, end) - end * s.rake(end, (sd[2][1] + sd[3][1]) / 2), gx)
            Gs[end] = G
            # Where each lamp section sits (the middle of its cells, on the car's left): the glow sprites go here.
            pts = {}
            for (a, b), m in cells.items():
                if m.startswith('lamp'):
                    pts.setdefault(m, []).append([sum(verts[G[a + da, b + db]][i] for da in (0, 1) for db in (0, 1)) / 4 for i in range(3)])
            s.lamp_cells[end] = [(m, cs) for m, cs in pts.items()]
            s.lamp_c[end] = {m: [sum(c[i] for c in cs) / len(cs) for i in range(3)] for m, cs in pts.items()}
        s.face = plates

        bm = new_bm(verts, faces, mats=fm)
        bm.verts.ensure_lookup_table()
        cr = bm.edges.layers.float.new('crease_edge')
        E = lambda a, b: bm.edges.get((bm.verts[a], bm.verts[b]))

        def crease(a, b, v):
            e = E(a, b)
            if e: e[cr] = v

        def seam(a, b, n=2):
            e = E(a, b)
            if e and len(e.link_faces) == n: e.seam = True
        J = lambda z: min(range(NS), key=lambda j: abs(st[j] - z))
        jc, jh, jr, jd = J(P['cowl']), J(P['header']), J(P['rhead']), J(P['deckf'])
        for j in range(jc, jr): crease(idx[j][4], idx[j + 1][4], 0.5)
        # 'rail_crease': the top of the side glass is a fold too. Left smooth, one subdivision drops that row 5 cm
        # toward the belt and the glass insets take 3 more: a side window a third shallower than the cage says.
        if s.g('rail_crease'):
            for j in range(jc, jr): crease(idx[j][5], idx[j + 1][5], s.g('rail_crease'))
        for j, c in ((jc, 0.8), (jd, 0.8), (jh, 0.4), (jr, 0.4)):
            for k in range(5, 8): crease(idx[j][k], idx[j][k + 1], c)
        between = lambda z: s.zR + s.Rc + 0.02 < z < s.zF - s.Rc - 0.02
        for j in range(NS - 1):
            crease(idx[j][3], idx[j + 1][3], 0.25)
            # The shoulder crease lives between the arches; beyond them the row dives to the lamps, uncreased.
            on = between(st[j]) and between(st[j + 1])
            # 'crease_full': the fold runs on over both arches, from the head lamp's tail to the tail lamp's tip, and
            # is shaded hard (see shade), so the band above it takes the sky and the door below it does not.
            full = s.g('crease_full') and sweep and sweep[1] < zmid(j) < sweep[0]
            if on or full: crease(idx[j][2], idx[j + 1][2], s.g('shc', 0.6))
            if full:
                e_ = E(idx[j][2], idx[j + 1][2])
                if e_: e_.smooth = False
        for j in range(0, jc): crease(idx[j][6], idx[j + 1][6], 0.3)
        if lod == 0:
            for z, km in s.doors:
                j = J(z)
                for k in range(km): seam(idx[j][k], idx[j][k + 1])
            if len(s.doors) > 1:
                for j in range(J(s.doors[0][0]), J(s.doors[-1][0])):
                    if all(abs(zmid(j) - zc) > s.Rc + 0.04 for zc in (s.zF, s.zR)): seam(idx[j][1], idx[j + 1][1])
            for j in range(0, jc): seam(idx[j][5], idx[j + 1][5])
            if s.g('trunk', True):
                for j in range(jd, NS - 1): seam(idx[j][5], idx[j + 1][5])
            gate = s.g('gate')
            if gate:
                # A tailgate: up the tail a column in from the corner (through the lamps, which is how a lamp comes
                # to be split between body and gate), along its foot above the bumper, up the pillar and over the roof.
                G = Gs[-1]
                for b in range(1, 3): seam(G[gate, b], G[gate, b + 1])
                for a in range(gate, 5): seam(G[a, 1], G[a + 1, 1])
                seam(G[gate, 3], idx[NS - 1][3 + gate])
                for j in range(jd, NS - 1): seam(idx[j][3 + gate], idx[j + 1][3 + gate])
                for j in range(jr, jd): seam(idx[j][5], idx[j + 1][5])
                for k in range(5, 8): seam(idx[jr][k], idx[jr][k + 1])
            if s.g('split'):
                # Barn doors: one cut down the middle of the tail, glass pillar to bumper.
                G = Gs[-1]
                for j in range(jr, NS - 1): seam(idx[j][8], idx[j + 1][8], 1)
                seam(idx[NS - 1][8], G[5, 3], 1)
                for b in range(3): seam(G[5, b], G[5, b + 1], 1)
        me = bpy.data.meshes.new('shell')
        for n in MATS + TMP: me.materials.append(bpy.data.materials[n])
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new('shell', me); bpy.context.scene.collection.objects.link(ob)
        m = ob.modifiers.new('mirror', 'MIRROR'); m.use_axis = (True, False, False); m.use_clip = True; m.merge_threshold = 0.0005
        # LOD1 is the cage itself: decimating the subdivided skin tore the lamps and glass into shards.
        if lod == 0: m = ob.modifiers.new('sub', 'SUBSURF'); m.levels = 1
        apply_mods(ob)

        bm = bmesh.new(); bm.from_mesh(me)
        dark = bm.verts.layers.float.new('dark')
        orient(bm, ('up',))

        def inset(mi, thick, ring, push=0.0, side=1.0):
            fs = [f for f in bm.faces if f.material_index == MI[mi]]
            if not fs: return
            r = bmesh.ops.inset_region(bm, faces=fs, thickness=thick, depth=0.0, use_boundary=True, use_even_offset=True)
            for f in r['faces']: f.material_index = MI[ring]
            if push:
                bm.normal_update()
                # 'side': how deep the housing stays where it has run round the corner onto the wing. A full-depth
                # trench there stands open in the car's outline, the clear cover a loose line 3 cm off its floor.
                for v in {v for f in bm.faces if f.material_index == MI[mi] for v in f.verts}:
                    v.co -= v.normal * push * lerp(side, 1.0, smooth((abs(v.normal.y) - 0.3) / 0.4))
            return r['faces']
        if lod == 0 and s.g('bus_doors'):
            # The bus's doorways are cut out of the kerb side, sill to cant rail; the flange pass below gives each a
            # reveal, and d_bus() hangs the leaves a hand's depth inside.
            top = max(P['roof']) - 0.2; kill = []
            for f in bm.faces:
                c = f.calc_center_median()
                if c.x < -(s.hw - 0.25) and c.z < top and any(b < -c.y < a for a, b in P['bus_doors']): kill.append(f)
            bmesh.ops.delete(bm, geom=kill, context='FACES')
        if lod == 0:
            inset('tmp_sideglass', 0.011, s.g('window_trim', 'chrome'))
            inset('tmp_sideglass', 0.016, 'trim', 0.006)
            inset('glass', 0.024, 'trim', 0.006)
            # Lamps are housings, not stickers. The front ones sink into a chrome bowl under a clear cover (the cover
            # is the skin they started as, kept aside for cover_obj); the rear ones are a red lens moulded in tiles.
            names_ = MATS + TMP; s.covers = []
            for f in bm.faces:
                n = names_[f.material_index]
                if n in ('lamp_head', 'lamp_drl'):
                    s.covers.append([(v.co.x, v.co.z, -v.co.y) for v in f.verts])
            bowl = s.g('bowl'); wall = []; lips = []
            # The indicators are lenses like the tail lamps, front ones too. The front one is the sliver that turns the
            # corner beside the head lamp: as a chrome pan under the clear cover it was narrower than its own rings
            # (4 cm against 4.6), so it folded through itself and the lamp stood open at the side, an empty chrome
            # box. As an amber lens it closes the side of the bowl.
            for m, depth in (('lamp_head', 0.034), ('lamp_drl', 0.02), ('lamp_ind', 0.008), ('lamp_tail', 0.008), ('lamp_brake', 0.008), ('lamp_rev', 0.008)):
                # Behind a clear lens the housing is black plastic, rim and walls: chrome there (and gloss black as
                # much) mirrored the sky in pale slivers where the lamp's tail faces up.
                # 'lamp_rim' names the housing's material outright; 'lens_rim' the lip round the moulded lenses, which
                # is chrome unless a kind's lamp is one unit made of several sections (then the lip is lens too).
                rim = (s.g('lamp_rim') or 'trim') if bowl and depth > 0.01 else (s.g('lamp_rim') or 'chrome') if depth > 0.01 else 'chrome'
                r1 = inset(m, 0.008 if depth > 0.01 else 0.005, rim)
                if depth < 0.01 and r1: lips += r1
                # ('lamp_wall': the bowl's wall in another material than its rim, e.g. the reflector's own, which
                # leaves the rim a thin seal instead of a 2 cm frame. 'lens_depth': how far the lenses sit in.)
                w_ = inset(m, (0.02 if bowl and m == 'lamp_head' else 0.015) if depth > 0.01 else 0.007, (s.g('lamp_wall') or rim) if depth > 0.01 else m, depth if depth > 0.01 else s.g('lens_depth', depth),
                           0.35 if sweep and depth > 0.01 else 1.0)
                if m == 'lamp_head' and bowl: wall = list(w_ or ())
                if s.hi and depth < 0.01:
                    # (Tiles only where a face is wide enough to hold one.)
                    fs = [f for f in bm.faces if f.material_index == MI[m] and min(e.calc_length() for e in f.edges) > 0.012]
                    if fs:
                        r = bmesh.ops.inset_individual(bm, faces=fs, thickness=0.004, depth=0.003)
                        for f in r['faces']:
                            for v in f.verts: v[dark] = 0.5
                        for f in fs:
                            for v in f.verts: v[dark] = 0.0
            if s.g('lens_rim'):
                for f in lips:
                    if f.is_valid: f.material_index = MI[s.g('lens_rim')]
            if bowl:
                # A clear-lens lamp ('bowl' is how dark its housing is): behind the cover a smoked bowl, not a bright
                # reflector, and along the foot of it a daytime strip, which is the bowl's own lower wall.
                bm.normal_update()
                for f in bm.faces:
                    if f.material_index == MI['lamp_head']:
                        for v in f.verts: v[dark] = bowl
                for f in wall:
                    if f.is_valid and f.normal.z > 0.3: f.material_index = MI['lamp_drl']
            inset('tmp_grille', 0.014, 'chrome', 0.02)
            seams = [e for e in bm.edges if e.seam]
            r = bmesh.ops.bevel(bm, geom=seams, offset=0.006, offset_type='OFFSET', segments=2, profile=0.5,
                                affect='EDGES', clamp_overlap=True)
            newf = set(r['faces']); bm.normal_update()
            for v in r['verts']:
                if v.is_valid and all(f in newf for f in v.link_faces):
                    v.co -= v.normal * 0.008; v[dark] = 1.0
            # A returned flange round the sills and arches, so the skin has an edge instead of ending in nothing.
            r = bmesh.ops.extrude_edge_only(bm, edges=[e for e in bm.edges if e.is_boundary])
            for v in r['geom']:
                if isinstance(v, bmesh.types.BMVert):
                    if bed and v.co.z > P['deck'] - 0.12 and -bed[0] - 0.06 < v.co.y < -bed[1] + 0.06 and abs(v.co.x) < s.hw - 0.08:
                        v.co.z -= 0.05
                    elif abs(v.co.x) > 0.3: v.co.x -= 0.024 if v.co.x > 0 else -0.024
                    else: v.co.y -= 0.02 if v.co.y > 0 else -0.02
        for e in bm.edges: e.seam = False
        orient(bm, ('up',))
        # 'dents': (side, y, z, radius, depth) dishes pressed into the finished skin of the showroom car only (one
        # car's own history, not its kind's shape). Done before the skin is measured, so bumpers still fit it.
        if s.hi:
            for sx, yd, zd, rad, dep in s.g('dents', ()):
                for v in bm.verts:
                    if v.co.x * sx < 0.3: continue
                    d = hypot(v.co.z - yd, -v.co.y - zd) / rad
                    if d < 1.0: v.co.x -= sx * dep * (1 - d * d) ** 2
        if lod and s.g('bowl'):
            for f in bm.faces:
                if f.material_index == MI['lamp_head']: f.material_index = MI['tmp_lamp']
        bm.to_mesh(me); bm.free()
        stamp(me)
        # The temporary materials have done their job (regions for the detail passes, tints for the bake).
        mi = [0] * len(me.polygons); me.polygons.foreach_get('material_index', mi)
        names = MATS + TMP
        me.polygons.foreach_set('material_index', [MI[REMAP.get(names[i], names[i])] for i in mi])
        for i in range(len(names) - 1, len(MATS) - 1, -1): me.materials.pop(index=i)
        s.shell_bvh = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [list(q.vertices) for q in me.polygons])
        return ob

    def wrap(s, pts, end=1, off=0.004):
        """Drop (x, y) points onto the nose (end=1) or the tail: the first skin a ray along the car meets, plus off."""
        out = []
        for x, y in pts:
            hit = s.skin.ray_cast(B(x, y, end * 20.0), B(0, 0, -end), 40.0) if s.skin else (None,)
            z = -hit[0].y if hit[0] is not None else end * (s.P['nose' if end > 0 else 'tail'] - 0.03)
            out.append((x, y, z + end * off))
        return out

    def panel(s, name, ys, hw, mat, tint, end=1, nx=8, off=0.004, xc=0.0, soft=0, soft_gap=0.012):
        """A patch laid on the nose or tail like a decal with thickness: rows at heights ys, each reaching hw(y)
        either side of xc(y), every vertex dropped onto the skin. hw and xc may be numbers or functions of y.
        soft: for a patch that crosses a shoulder of the skin. Rows far apart cut straight through a shoulder (the
        skin then shows through the patch in holes), so such a patch takes rows a centimetre apart, and soft is how
        many times each close-set row is then eased toward the rows above and below it, which fairs the skin's
        facets and steps into one curve so a gloss patch reflects in one piece. Easing pulls a convex shoulder in
        by a millimetre or three: give off enough to cover it."""
        fw = hw if callable(hw) else (lambda y: hw); fc = xc if callable(xc) else (lambda y: xc)
        f = []
        rows = [s.wrap([(fc(y) + fw(y) * (2 * j / nx - 1), y) for j in range(nx + 1)], end, off) for y in ys]
        for _ in range(soft):
            z = [[p[2] for p in r] for r in rows]
            for i in range(1, len(ys) - 1):
                if max(abs(ys[i - 1] - ys[i]), abs(ys[i] - ys[i + 1])) > soft_gap: continue
                rows[i] = [(p[0], p[1], 0.25 * z[i - 1][j] + 0.5 * z[i][j] + 0.25 * z[i + 1][j]) for j, p in enumerate(rows[i])]
        v = [p for r in rows for p in r]
        for i in range(len(ys) - 1):
            for j in range(nx):
                a = i * (nx + 1) + j; f.append((a, a + 1, a + nx + 2, a + nx + 1))
        bm = new_bm(v, f, mat=mat); bm.normal_update()
        want = B(0, 0, end)
        for q in bm.faces:
            if q.normal.dot(want) < 0: q.normal_flip()
        bm.normal_update()
        return to_obj(bm, name, tint)

    def cover_obj(s):
        v = [p for q in s.covers for p in q]; f = []; n = 0
        for q in s.covers: f.append(tuple(range(n, n + len(q)))); n += len(q)
        bm = new_bm(v, f, mat='glass')
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0004)
        orient(bm, ('out', (0, 0.6, 0)))
        return to_obj(bm, 'cover', (1.0, 1.0, 1.0, 0.1))

    # ── Bumpers ──────────────────────────────────────────────────────────────

    def bumper(s, end, lod):
        P = s.P; e = 0 if end > 0 else 1
        Wb = s.hw + 0.004; zN = (P['nose'] if end > 0 else P['tail']) - 0.014
        n = P['n_front'] if end > 0 else P['n_rear']; zs = P['zs']
        T = P['bumper_top'][e]; Bt = P['bumper_bot'][e]; d = T - Bt
        z0 = s.g('bstart')[e] if s.g('bstart') else abs(s.zF) + s.arch_r + 0.012
        u0 = min(0.95, max(0.03, (z0 - zs) / (zN - zs)))
        th0 = asin(u0 ** (n / 2))
        ths = [th0 + (pi / 2 - th0) * f for f in (0, 0.2, 0.38, 0.52, 0.66, 0.82, 1)]
        prof = [(-0.05, T - 0.005), (-0.002, T), (0.010, T - 0.075 * d), (0.014, T - 0.31 * d), (0.014, T - 0.44 * d),
                (0.006, T - 0.72 * d), (-0.03, Bt + 0.08 * d), (-0.09, Bt)]
        pm = s.g('bumper_pm', ['paint', 'chrome', 'paint', 'paint', 'paint', 'trim', 'trim'])
        # A painted bumper is part of the body's surfacing: its top edge is tucked just inside the skin of the end
        # plate and it swells out of it in one S, with the bright strip (if any) moved down onto the swell. Chrome and
        # black-plastic bumpers stay what they are, a separate bar with a ledge on top.
        blend = pm[0] == 'paint'
        if blend and 'chrome' in pm: pm = ['paint'] * 3 + ['chrome', 'paint', 'trim', 'trim']
        gap = zN - (s.zNf if end > 0 else s.zNr) + s.rake(end, T)
        path = [(th, 1) for th in ths] + [(th, -1) for th in reversed(ths[:-1])]
        verts, faces, fm = [], [], []
        # (See fit_bumper.) On the two near levels the top three rows are placed against the finished skin already
        # here, so the ledge the bumper makes under the lamps keeps its section round the corner and along the wing
        # instead of fading out at the corner, which read as a notch there.
        tree = s.shell_bvh if blend and lod == 0 else None

        def skin_gap(x, z, nx, nz, y):
            hit = tree.ray_cast(B(x + nx * 0.4, y, end * (z + nz * 0.4)), B(-nx, 0.0, -end * nz), 0.8)
            return None if hit[0] is None else hit[3] - 0.4
        for th, sx in path:
            cx, sn = cos(th) ** (2 / n), sin(th) ** (2 / n)
            x, z = Wb * cx, zs + (zN - zs) * sn
            nx, nz = cx ** (n - 1) / Wb, sn ** (n - 1) / (zN - zs)
            l = hypot(nx, nz); nx /= l; nz /= l
            k = 0.3 + 0.7 * smooth((th - th0) / radians(35))
            hug = 1 - smooth((th - th0) / radians(28))
            ot = -gap * sn
            pr = prof if not blend else [(ot - 0.012, T + 0.008), (ot + 0.004, T - 0.05 * d), (ot * 0.35 + 0.009, T - 0.19 * d)] + prof[3:]
            offs = [o * k if o > 0 else o for o, _ in pr]
            wf = smooth((z - z0) / 0.045) if tree else 0.0
            if wf > 0:
                g0, g1 = skin_gap(x, z, nx, nz, pr[0][1]), skin_gap(x, z, nx, nz, pr[1][1])
                if g0 is not None and g1 is not None:
                    o1 = 0.006 - g1
                    offs[0] = lerp(offs[0], -0.014 - g0, wf); offs[1] = lerp(offs[1], o1, wf)
                    offs[2] = lerp(offs[2], lerp(o1, offs[3], 0.62), wf)
            for o, (_, y) in zip(offs, pr):
                q = min(1.0, max(0.0, (T + 0.1 - y) / (T + 0.1 - P['sill'])))
                verts.append((sx * (x * (1 - hug * (0.032 * q * q - 0.004)) + nx * o), y, end * (z + nz * o)))
        np_ = len(prof)
        for i in range(len(path) - 1):
            for p in range(np_ - 1):
                faces.append((i * np_ + p, (i + 1) * np_ + p, (i + 1) * np_ + p + 1, i * np_ + p + 1)); fm.append(pm[p])
        bm = new_bm(verts, faces, mats=fm)
        bm.verts.ensure_lookup_table()
        cr = bm.edges.layers.float.new('crease_edge')
        for i in range(len(path) - 1):
            for p in range(3 if blend else 1, np_ - 2):
                e2 = bm.edges.get((bm.verts[i * np_ + p], bm.verts[(i + 1) * np_ + p]))
                if e2: e2[cr] = 0.7
        orient(bm, ('out', (0, (T + Bt) / 2, 0)))
        ob = to_obj(bm, 'bumper')
        if lod == 0:
            m = ob.modifiers.new('sub', 'SUBSURF'); m.levels = 1
            ob.data.attributes.remove(ob.data.attributes['tint'])
            apply_mods(ob); stamp(ob.data)
        if blend: s.fit_bumper(ob, end, T, d, z0, n, zs, zN, Wb, lod == 0)
        return ob

    def fit_bumper(s, ob, end, T, d, z0, n, zs, zN, Wb, exact):
        """Lay a painted bumper against the skin it grows out of. The sweep above places it against the body's plan as
        drawn, but the skin is that plan subdivided: it cuts the corners by a centimetre or two and swells round the
        arches. So the bumper's tucked top edge came out through the skin at the corner (a notch under the lamp) and
        along the wing the two surfaces lay within millimetres of each other and crossed in a zig-zag. Here every
        vertex is measured against the finished skin along the plan's normal: the top edge goes 14 mm inside it, the
        row below 5 mm outside (so the bumper leaves the body along one level line), and nothing lower down may come
        closer than 5 mm proud. Over the 45 mm next to the arch the rule fades out: there the bumper ends buried in the
        arch's flare as before. exact=False (the cage level, whose skin is too coarse to follow) only ever moves the
        top edge in and the rest out."""
        bvh = s.shell_bvh
        if bvh is None: return
        y1 = T - 0.05 * d
        for v in ob.data.vertices:
            x, y, z = abs(v.co.x), v.co.z, -end * v.co.y
            if y < T - 0.75 * d: continue
            w = smooth((z - z0) / 0.045)
            if w <= 0.0: continue
            u = max(0.0, (z - zs) / (zN - zs))
            nx, nz = (x / Wb) ** (n - 1) / Wb, u ** (n - 1) / (zN - zs)
            l = hypot(nx, nz)
            if l < 1e-9: continue
            nx /= l; nz /= l
            hit = bvh.ray_cast(B(x + nx * 0.4, y, end * (z + nz * 0.4)), B(-nx, 0.0, -end * nz), 0.8)
            if hit[0] is None: continue
            # How far the vertex stands outside the skin (negative: inside it), which is what the three rules below
            # are written for. From the 7:40 AM push of Nov 20 until the C-Max's part two this was read with the
            # other sign (0.4 - hit), so a bumper 12 cm proud of a raked end plate was pushed out by 12 cm more: the
            # Bolt came out 4.36 m long, not 4.17, and seven other kinds 13 cm over their tables.
            off = hit[3] - 0.4
            if y >= T + 0.004:
                mv = -0.014 - off
                if not exact: mv = min(0.0, mv)
            elif y >= y1 + (0.008 - 0.09 * d) / 8 - 0.002:      # (where one subdivision leaves the second row)
                mv = lerp(0.005, -0.014, min(1.0, max(0.0, (y - y1) / (T + 0.008 - y1)))) - off
                if not exact: mv = max(0.0, mv)
            else: mv = max(0.0, 0.005 - off)
            mv *= w
            v.co.x += (1.0 if v.co.x >= 0 else -1.0) * nx * mv; v.co.y -= end * nz * mv

    # ── Underbody, interior, fittings ────────────────────────────────────────

    def underbody(s, lod):
        P = s.P; out = []; y = P['sill'] + 0.012
        quads = [((-0.55, 0.55), (-(P['tail'] - 0.45), P['nose'] - 0.3))]
        if lod == 0:
            a = s.arch_r + 0.02
            for sx in (1, -1):
                xs = (0.55, s.hw - 0.03) if sx > 0 else (-(s.hw - 0.03), -0.55)
                quads += [(xs, (s.zR + a, s.zF - a)), (xs, (s.zF + a, P['nose'] - 0.3)), (xs, (-(P['tail'] - 0.45), s.zR - a))]
        v, f = [], []
        for (x0, x1), (z0, z1) in quads:
            n = len(v); v += [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]; f.append((n, n + 1, n + 2, n + 3))
        bm = new_bm(v, f, mat='trim'); orient(bm, ('dir', (0, -1, 0), 0))
        out.append(to_obj(bm, 'floor', 0.012))
        segs = 14 if lod == 0 else 5
        for zc in (s.zF, s.zR):
            for sx in (1, -1):
                r = s.arch_r + 0.03
                prof = [(0.5, 0.0), (0.5, r), (s.hw - 0.05, r)]
                v, f, _ = lathe(prof, segs, radians(-12), radians(192), (0, P['R'], zc))
                v = [(sx * x, yy, zz) for x, yy, zz in v]
                bm = new_bm(v, f, mat='trim'); orient(bm, ('out', (sx * 0.75, P['R'], zc)), flip=True)
                out.append(to_obj(bm, 'liner', 0.01))
        if s.g('dual'):
            # Twin rear wheels, the inner one of each pair: a plain tire fixed to the body. It does not turn, and
            # behind the outer wheel nobody can tell; the game draws four wheels a car.
            R = P['R']; h = P['tw'] / 2; rr = R * s.g('rr', 0.67); xc = P['track'] / 2 - P['tw'] - 0.03
            prof = [(-h, rr), (-h, R * 0.82), (-h * 0.8, R), (h * 0.8, R), (h, R * 0.82), (h, rr), (h * 0.4, rr * 0.9), (h * 0.4, 0)]
            for sx in (1, -1):
                v, f, band = lathe(prof, 20 if lod == 0 else 10, c=(xc, R, s.zR))
                bm = new_bm([(sx * x, y, z) for x, y, z in v], f, mats=['tire' if b < 5 else 'rim' for b in band])
                orient(bm, ('out', (sx * xc, R, s.zR))); out.append(to_obj(bm, 'twin'))
        if s.hi:
            # What shows when one rolls over or sits burning on its side: rails, subframes, axles, arms, struts, and
            # either an exhaust with its silencer or (no exhausts) the flat battery of an electric car.
            I = _I(out); tr = P['track'] / 2; yb = P['sill'] - 0.015; R = P['R']
            for sx in (1, -1): I('rail', (sx * 0.47, yb, 0), (0.09, 0.06, P['wb'] + 0.7), 'trim', 0.035)
            for zc in (s.zF, s.zR):
                I('subframe', (0, yb + 0.02, zc), (0.94, 0.05, 0.46), 'trim', 0.03, bevel=0.015)
                I('axle', (0, R, zc), (2 * tr - P['tw'], 0.045, 0.045), 'trim', 0.07)
                for sx in (1, -1):
                    I('arm', (sx * (tr - 0.3), R - 0.07, zc + 0.09), (0.46, 0.03, 0.1), 'trim', 0.05)
                    I('strut', (sx * (tr - 0.2), R + 0.19, zc), (0.055, 0.4, 0.055), 'trim', 0.09)
            ex = s.g('exhausts', (-0.5,))
            if ex:
                x = -0.26; z1 = -(P['tail'] - 0.4)
                I('pipe', (x, yb - 0.02, (s.zF - 0.3 + z1) / 2), (0.05, 0.05, s.zF - 0.3 - z1), 'chrome', 0.25)
                I('silencer', (x - 0.05, yb + 0.005, max(s.zR - s.arch_r - 0.26, -(P['tail'] - 0.55))), (0.4, 0.085, 0.32), 'chrome', 0.3, bevel=0.04)
                I('cat', (x, yb - 0.01, 0.25), (0.13, 0.07, 0.36), 'chrome', 0.22, bevel=0.03)
                I('sump', (0.1, yb - 0.005, s.zF + 0.05), (0.42, 0.07, 0.5), 'trim', 0.05, bevel=0.03)
                I('tank', (0.2, yb - 0.01, s.zR + s.arch_r + 0.3), (0.62, 0.09, 0.5), 'trim', 0.04, bevel=0.03)
            else:
                I('battery', (0, yb - 0.01, 0), (2 * s.hw - 0.42, 0.08, P['wb'] - 0.86), 'trim', 0.035, bevel=0.02)
        return out

    def interior(s):
        P = s.P; out = []; roof = max(P['roof']); cw = P['cowl']; k = s.hw / 0.917
        # 'cab_belt': the dashboard and the cabin's lining stand to the belt, which must not be above the bonnet at the screen.
        belt = s.g('cab_belt', P['belt'])
        # d lifts the floor with the sills, e the seats with the belt: a truck sits you higher than it stands.
        d = P['sill'] - 0.17; e = s.g('seat_e', min(belt - 0.935, d + 0.12))
        I = lambda *a, **kw: out.append(box(*a, **kw))
        zr = s.g('cab_end', P['rhead'] - 0.08); y0 = 0.28 + d; xs = 2 * (s.hw - 0.107); sx = 0.37 * k
        I('tub', (0, (y0 + belt + 0.005) / 2, (cw - 0.02 + zr) / 2), (xs, belt + 0.005 - y0, cw - 0.02 - zr), 'interior', 0.02, drop=3, flip=True)
        I('dash', (0, belt - 0.135, min(cw - 0.10, P['nose'] - 0.6)), (xs - 0.04, 0.34, 0.52), 'interior', 0.028, bevel=0.04)
        I('binnacle', (sx, belt + 0.05, cw - 0.30), (0.36, 0.07, 0.18), 'interior', 0.02, bevel=0.02)
        I('headliner', (0, min(P['roof']) - 0.085, (P['header'] + P['rhead']) / 2), (2 * P['xr'][0] - 0.2, 0.02, P['header'] - P['rhead'] - 0.2), 'interior', 0.12)
        I('console', (0, 0.48 + e, cw - 0.69), (0.2, 0.3, 0.9), 'interior', 0.025, bevel=0.02)
        seat = s.g('seat', (0.11, 0.094, 0.08))
        for x in (sx, -sx):
            I('cushion', (x, 0.44 + e, cw - 0.72), (0.5, 0.16, 0.5), 'seat', seat, bevel=0.04)
            I('back', (x, 0.78 + e, cw - 1.04), (0.48, 0.62, 0.13), 'seat', seat, bevel=0.04, pitch=radians(14))
            I('headrest', (x, 1.15 + e, cw - 1.13), (0.24, 0.17, 0.09), 'seat', seat, bevel=0.03, pitch=radians(10))
        if s.g('bench', True):
            # The parcel shelf stops short of the tail skin: on the hatch it used to poke out through the rear corners.
            zb = max(P['deckf'] - 0.1, -(P['tail'] - 0.3)); za = P['rhead'] + 0.0
            I('shelf', (0, belt - 0.03, (za + zb) / 2), (xs - 0.2, 0.05, za - zb), 'interior', 0.03)
            I('bench', (0, 0.44 + e, P['rhead'] + 0.33), (xs - 0.26, 0.16, 0.5), 'seat', seat, bevel=0.04)
            I('benchback', (0, 0.76 + e, P['rhead'] + 0.03), (xs - 0.26, 0.58, 0.13), 'seat', seat, bevel=0.04, pitch=radians(18))
            for x in (0.4 * k, -0.4 * k):
                I('headrest', (x, 1.10 + e, P['rhead'] - 0.07), (0.24, 0.15, 0.09), 'seat', seat, bevel=0.03, pitch=radians(14))
        for zrow in s.g('seat_rows', ()):
            for x in (0.72, -0.72):
                if x < 0 and any(a + 0.3 > zrow > b - 0.3 for a, b in s.g('bus_doors', ())): continue
                I('cushion', (x, 0.44 + e, zrow), (0.88, 0.12, 0.42), 'seat', seat)
                I('back', (x, 0.80 + e, zrow - 0.24), (0.88, 0.62, 0.07), 'seat', seat, pitch=radians(8))
        # Steering wheel: a rim lathed about X, then stood up in front of the driver.
        v, f, _ = lathe([(0.0, 0.19), (0.016, 0.175), (0.0, 0.16), (-0.016, 0.175), (0.0, 0.19)], 14)
        t = radians(68); c = (sx, belt + 0.045, cw - 0.44)
        v = [(c[0] + yy, c[1] + zz * sin(t) - x * cos(t), c[2] + zz * cos(t) + x * sin(t)) for x, yy, zz in v]
        bm = new_bm(v, f, mat='interior'); orient(bm, ('out', c))
        out.append(to_obj(bm, 'steering', 0.012))
        I('spoke', (sx, belt + 0.045, cw - 0.44), (0.34, 0.035, 0.03), 'interior', 0.012, pitch=radians(22))
        I('column', (sx, belt + 0.015, cw - 0.36), (0.07, 0.07, 0.2), 'interior', 0.012, pitch=radians(-22))
        if s.hi:
            for x in (sx, -sx):
                for q in (-1, 1):
                    I('bolster', (x + q * 0.235, 0.465 + e, cw - 0.72), (0.06, 0.19, 0.46), 'seat', seat, bevel=0.025)
                    I('bolster', (x + q * 0.225, 0.80 + e, cw - 1.03), (0.06, 0.5, 0.13), 'seat', seat, bevel=0.025, pitch=radians(14))
            zd = min(cw - 0.10, P['nose'] - 0.6) - 0.262; hw = s.hw
            for x in (-0.66 * k, -0.19, 0.19, 0.66 * k): I('vent', (x, belt - 0.03, zd), (0.13, 0.05, 0.012), 'interior', 0.007)
            I('screen', (0, belt + 0.075, zd + 0.02), (0.25, 0.15, 0.014), 'gloss', (0.02, 0.06, 0.1), bevel=0.004, pitch=radians(-12))
            I('gauges', (sx, belt + 0.05, cw - 0.392), (0.3, 0.05, 0.004), 'gloss', (0.03, 0.1, 0.14))
            I('wheel_hub', (sx, belt + 0.04, cw - 0.435), (0.11, 0.09, 0.05), 'interior', 0.02, bevel=0.02, pitch=radians(22))
            I('spoke_v', (sx, belt - 0.03, cw - 0.465), (0.035, 0.13, 0.03), 'interior', 0.012, pitch=radians(22))
            for q in (-1, 1): I('stalk', (sx + q * 0.15, belt + 0.03, cw - 0.38), (0.13, 0.016, 0.016), 'interior', 0.02)
            I('lever', (0, 0.67 + e, cw - 0.62), (0.03, 0.11, 0.03), 'chrome', 0.3, bevel=0.008)
            I('brake', (0.06, 0.66 + e, cw - 0.9), (0.03, 0.04, 0.22), 'interior', 0.02, pitch=radians(-10))
            I('rvm', (0, P['roof'][0] - 0.14, P['header'] + 0.12), (0.22, 0.06, 0.02), 'interior', 0.02, bevel=0.006)
            for q in (1, -1):
                I('door_card', (q * (hw - 0.122), (y0 + belt) / 2 + 0.06, (cw - 0.35 + zr) / 2), (0.03, belt - y0 - 0.16, cw - 0.45 - zr), 'interior', 0.05)
                I('armrest', (q * (hw - 0.16), belt - 0.21, cw - 0.85), (0.07, 0.05, 0.52), 'seat', seat, bevel=0.015)
                I('pull', (q * (hw - 0.14), belt - 0.1, cw - 0.62), (0.014, 0.02, 0.1), 'chrome', 0.5)
        return out

    def fittings(s, lod):
        P = s.P; out = []; hw = s.hw; belt = P['belt']; k = hw / 0.917
        I = lambda *a, **kw: out.append(box(*a, **kw))
        bv = 0.0 if lod else 1.0; ms = s.g('mirror', 1.0)
        for sx in (1, -1):
            zm = s.g('mirror_z', lerp(P['cowl'], P['header'], 0.25))
            if lod:
                # The cage level keeps a plain box on a block.
                I('mirror', (sx * (hw + 0.085), belt + 0.075 * ms, zm), (0.18, 0.115 * ms, 0.092), 'paint' if ms == 1 else 'trim')
                I('mirror_arm', (sx * (hw - 0.01), belt + 0.035, zm + 0.01), (0.12, 0.035, 0.06), 'trim')
                continue
            out += s.mirror(sx, zm, ms)
            for zh in s.g('handles', [dz + 0.16 for dz, _ in s.doors[1:]]): out += s.handle(sx, zh)
            if s.g('rub', True):
                ry = lerp(P['sill'], belt - 0.12, 0.63)
                for (z0, _), (z1, _) in zip(s.doors, s.doors[1:]):
                    I('rub', (sx * (s.xat((z0 + z1) / 2, ry) + 0.006), ry, (z0 + z1) / 2), (0.016, 0.045, z0 - z1 - 0.05), 'trim', 0.03, bevel=0.005)
        if lod: return out
        y0, y1, zf, gw = s.face[1]
        if G_ in s.cells[1].values() and s.g('slats', True):
            for i in range(4):
                I('slat', (0, lerp(y0, y1, (i + 1) / 5), zf - 0.012), (gw * 2 - 0.05, 0.012, 0.014), 'chrome')
        T = P['bumper_top'][0]; Bt = P['bumper_bot'][0]
        I('plate_f', (0, T - 0.47 * (T - Bt), P['nose'] - 0.006), (0.305, 0.152, 0.008), 'trim', (0.75, 0.75, 0.7))
        y0, y1, zr, gw = s.face[-1]
        py = s.g('plate_r_y', (y0 + y1) / 2 - 0.02); pz = -(P['tail'] - 0.004) if s.g('plate_r_y') else zr - 0.004
        I('plate_r', (0, py, pz), (0.305, 0.152, 0.008), 'trim', (0.75, 0.75, 0.7))
        I('plate_frame', (0, py, pz + 0.003), (0.34, 0.185, 0.006), 'chrome')
        for ex in s.g('exhausts', (-0.5,)):
            v, f, _ = lathe([(0, 0.0), (0, 0.022), (0.2, 0.022), (0.2, 0.028), (-0.02, 0.028)], 10)
            v = [(ex + yy, P['sill'] + 0.045 + zz, -(P['tail'] - 0.215) - x) for x, yy, zz in v]
            bm = new_bm(v, f, mat='chrome'); orient(bm, None); out.append(to_obj(bm, 'exhaust', 0.6))
        for sx, zb in ((1, 0.02), (-0.15, 0.03)):
            I('wiper', (sx * 0.36 * k, P['hood_cowl'] + 0.035, P['cowl'] + 0.075 + zb), (0.5 * k, 0.012, 0.018), 'trim', 0.01)
        return out + s.trinkets()

    def mirror(s, sx, zm, ms):
        """A door mirror: a rounded shell standing clear of the door on a stalk, its glass set back in the open end.
        The shell is rings of a soft-cornered oval, widest just ahead of the glass and closing to a dome that leans
        in toward the door. (About 200 triangles; the bevelled box it replaces took nearer 300.)"""
        P = s.P; hw = s.hw; belt = P['belt']; n = 16
        a, b = 0.095, 0.058 * ms; cx, cy, zb = hw + 0.108, belt + 0.075 * ms, zm - 0.044
        mat = 'paint' if ms == 1 else 'trim'
        sp = lambda c: (1 if c >= 0 else -1) * abs(c) ** 0.6
        oval = [(sp(cos(2 * pi * i / n)), sp(sin(2 * pi * i / n))) for i in range(n)]
        # (scale, how far ahead of the glass, how far the ring has leaned in toward the door)
        rings = [(0.84, 0.007, 0.0), (0.89, 0.0, 0.0), (1.0, 0.012, 0.0), (1.0, 0.042, 0.003), (0.93, 0.066, 0.008), (0.70, 0.084, 0.016)]
        v = [(sx * (cx + a * k * ox - ln), cy + b * k * oy, zb + dz) for k, dz, ln in rings for ox, oy in oval]
        v.append((sx * (cx - 0.02), cy, zb + 0.09))
        f = []; fm = []
        for r in range(len(rings) - 1):
            for i in range(n):
                j = (i + 1) % n
                f.append((r * n + i, r * n + j, (r + 1) * n + j, (r + 1) * n + i)); fm.append('trim' if r == 0 else mat)
        top = (len(rings) - 1) * n
        for i in range(n):
            f.append((top + i, top + (i + 1) % n, len(v) - 1)); fm.append(mat)
        bm = new_bm(v, f, mats=fm); orient(bm, ('out', (sx * cx, cy, zb + 0.04)))
        out = [to_obj(bm, 'mirror')]
        bm = new_bm(v[:n], [tuple(range(n))], mat='chrome'); orient(bm, ('dir', (0, 0, -1), 0))
        out.append(to_obj(bm, 'mirror_glass', 0.55))
        # The stalk: a tapered oval tube from the door up and out into the foot of the shell.
        m = 8; v = []
        for x, y, ry, rz in ((hw - 0.014, belt + 0.032, 0.024, 0.04), (hw + 0.05, cy - 0.45 * b, 0.016, 0.028)):
            for i in range(m):
                t = 2 * pi * i / m; v.append((sx * x, y + ry * cos(t), zm + 0.006 + rz * sin(t)))
        f = [(i, (i + 1) % m, m + (i + 1) % m, m + i) for i in range(m)]
        bm = new_bm(v, f, mat='trim'); orient(bm, ('out', (sx * (hw + 0.015), (belt + 0.03 + cy - 0.5 * b) / 2, zm + 0.006)))
        out.append(to_obj(bm, 'mirror_arm'))
        return out

    def skx(s, sx, y, z):
        """Half width of the finished skin at (y, z) on side sx (the cage's, from xat, where no skin is there)."""
        hit = s.skin.ray_cast(B(sx * 3.0, y, z), B(-sx, 0.0, 0.0), 3.0) if s.skin else (None,)
        return abs(hit[0].x) if hit[0] is not None else s.xat(z, y)

    def handle(s, sx, zh):
        """A door handle: a rounded pull over a dished recess. The door is one skin, so the recess is a dark oval laid
        a millimetre off it, vertex by vertex, not a hole cut in it; the pull is an oval bar that leaves the skin at
        one end of the recess, runs level two centimetres off it and comes back at the other. (90 triangles; the
        two bevelled boxes took about 250.)"""
        yh = s.P['belt'] - 0.068; n = 14; sp = lambda c: (1 if c >= 0 else -1) * abs(c) ** 0.8
        v = [(sx * (s.skx(sx, yh, zh) + 0.0012), yh, zh)]
        for i in range(n):
            t = 2 * pi * i / n; z = zh + 0.105 * sp(cos(t)); y = yh + 0.031 * sp(sin(t))
            v.append((sx * (s.skx(sx, y, z) + 0.0012), y, z))
        bm = new_bm(v, [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)], mat='trim'); orient(bm, ('out', (0, yh, zh)))
        out = [to_obj(bm, 'handle_cup', 0.006)]
        m = 8; us = (-1.0, -0.6, 0.0, 0.6, 1.0); v = []; yb = yh + 0.004
        for u in us:
            z = zh + u * 0.085; k = 0.75 if abs(u) == 1 else 1.0
            x = s.skx(sx, yb, z) + 0.004 + 0.016 * (1 - u ** 4)
            for i in range(m):
                t = 2 * pi * (i + 0.5) / m; v.append((sx * (x + 0.007 * k * cos(t)), yb + 0.0105 * k * sin(t), z))
        f = [(r * m + i, r * m + (i + 1) % m, (r + 1) * m + (i + 1) % m, (r + 1) * m + i) for r in range(len(us) - 1) for i in range(m)]
        f += [tuple(range(m)), tuple(range((len(us) - 1) * m, len(us) * m))]
        bm = new_bm(v, f, mat='chrome'); orient(bm, ('out', (sx * (s.skx(sx, yb, zh) + 0.016), yb, zh)))
        out.append(to_obj(bm, 'handle'))
        return out

    def trinkets(s):
        """Writing, emblems and the small lamps: what a car has that a model of one usually leaves off."""
        P = s.P; out = []; I = _I(out); hw = s.hw; belt = P['belt']; kind = s.kind; k = hw / 0.917
        T = P['bumper_top'][0]; Bt = P['bumper_bot'][0]; up = (0, 1, 0)
        fy0, fy1, zf, _ = s.face[1]; y0, y1, zr, _ = s.face[-1]
        low = s.g('plate_r_y')
        py = low or (y0 + y1) / 2 - 0.02; pz = -(P['tail'] - 0.004) if low else zr - 0.004
        fy = T - 0.47 * (T - Bt); fz = P['nose'] - 0.006
        if s.hi:
            for c, r in (((0, fy - 0.012, fz + 0.0052), (1, 0, 0)), ((0, py - 0.012, pz - 0.0052), (-1, 0, 0))):
                out.append(text('plate_no', PLATES.get(kind, 'PC 0000'), c, r, up, 0.066, 'trim', (0.02, 0.03, 0.1), squeeze=0.6))
                out.append(text('plate_top', 'PORT CALAMITY', (0, c[1] + 0.064, c[2]), r, up, 0.017, 'trim', (0.4, 0.05, 0.03), squeeze=0.85))
        letter, name = BADGE.get(kind, (None, ''))
        if letter:
            for end, zz, yy, r in ((1, zf + 0.004, s.g('emblem_y', (fy0 + fy1) / 2), 0.04), (-1, zr - 0.004, (y0 + y1) / 2, 0.034)):
                if end < 0 and (not low or s.g('bed')): continue
                out.append(ring('emblem', (0, yy, zz), 0, r, end * 0.006, 'z', 'gloss'))
                out.append(ring('emblem_ring', (0, yy, zz), r * 0.84, r * 1.06, end * 0.011, 'z', 'chrome'))
                if s.hi: out.append(text('emblem_l', letter, (0, yy, zz + end * 0.0075), (end, 0, 0), up, r * 1.0, 'chrome', None))
        if s.hi and name and not s.g('bed'):
            out.append(text('script', name, (-0.27 * k, y0 + 0.055 if low else py + 0.045, zr - 0.007), (-1, 0, 0), up, 0.026, 'chrome', None, squeeze=0.8))
        cy, cz = s.g('chmsl', (P['roof'][3] - 0.03, P['rhead'] - 0.05))
        I('chmsl', (0, cy, cz), (0.3, 0.016, 0.022), 'lamp_brake')
        zrp = s.zF - s.Rc - 0.11; yrp = belt - 0.2
        for sx in (1, -1):
            I('repeater', (sx * (s.xat(zrp, yrp) + 0.002), yrp, zrp), (0.012, 0.022, 0.055), 'lamp_ind', bevel=0.004)
        if s.g('flap', True):
            # Behind the rear arch where the tail is long enough to hold it, ahead of the arch where it is not.
            zc = s.zR - s.Rc - 0.15; yc = belt - 0.17
            if P['tail'] + zc < 0.35: zc = s.zR + s.Rc + 0.16
            x = max(s.xat(zc, yc - 0.06), s.xat(zc, yc + 0.06))
            I('flap_gap', (x - 0.0045, yc, zc), (0.012, 0.145, 0.165), 'trim', 0.008, bevel=0.004)
            I('flap', (x - 0.0025, yc, zc), (0.012, 0.132, 0.152), 'paint', bevel=0.004)
        if s.g('aerial', True):
            if s.g('trunk', True): I('aerial', (-(hw - 0.17), P['deck'] + 0.27, P['deckf'] - 0.1), (0.006, 0.52, 0.006), 'chrome', pitch=radians(-12))
            else: I('fin', (0, P['roof'][3] + 0.02, P['rhead'] + 0.2), (0.04, 0.045, 0.13), 'gloss', bevel=0.012, pitch=radians(-14))
        if s.g('mud'):
            for sx in (1, -1):
                for zc in (s.zF, s.zR):
                    I('mudflap', (sx * P['track'] / 2, P['R'] * 0.62, zc - s.arch_r - 0.035), (P['tw'] + 0.05, P['R'] * 0.95, 0.014), 'trim', 0.015)
        if s.hi or s.g('bowl'):
            # Projectors: a chromed barrel and a lens in the two biggest head lamp cells a side, back in the bowl.
            # (Where the bowl is dark they are all of the lamp that lights, so the street level has them too.)
            for m, cs in s.lamp_cells.get(1, ()):
                if m != 'lamp_head': continue
                for c in sorted(cs, key=lambda c: c[0])[:2]:
                    r = min(0.036, (fy1 - fy0) * (0.42 if s.g('bowl') else 0.36))
                    for sx in (1, -1):
                        q = (sx * c[0], c[1], c[2] - 0.036)
                        out.append(ring('proj', q, r * 0.72, r, 0.022, 'z', 'chrome', segs=12))
                        out.append(ring('proj_lens', q, 0, r * 0.72, 0.012, 'z', 'lamp_head', segs=12))
        if s.hi:
            # Calipers ride on the body, at the top of each disc: on the steering axis, so a turned wheel does not show the cheat.
            for sx in (1, -1):
                for zc in (s.zF, s.zR):
                    I('caliper', (sx * (P['track'] / 2 + P['tw'] * 0.1), P['R'] * 1.44, zc), (0.05, P['R'] * 0.2, P['R'] * 0.5), 'trim', s.g('caliper', 0.16), bevel=0.01)
        return out

    # ── Wheels ───────────────────────────────────────────────────────────────

    def wheel(s, lod):
        P = s.P; R = P['R']; h = P['tw'] / 2; rr = R * s.g('rr', 0.67); ns = s.g('spokes', 5); out = []
        if lod:
            prof = [(-h, R * 0.8), (-h * 0.8, R), (h * 0.8, R), (h, R * 0.8), (h * 0.92, rr), (h * 0.55, rr * 0.9), (h * 0.55, 0)]
            v, f, band = lathe(prof, 12)
            bm = new_bm(v, f, mats=['tire' if b < 4 else 'rim' for b in band]); orient(bm, ('dir', (1, 0, 0), len(f) - 1))
            return to_obj(bm, 'wheel1')
        ts = 40 if s.hi else 32; grooves = []
        if s.hi:
            # Three grooves round the tread, cut into the profile; the blocks between are hinted as below.
            g = h * 0.1; prof = [(-h * 0.9, rr), (-h, R * 0.8), (-h * 0.88, R * 0.976)]
            for gx in (-0.47, 0.0, 0.47):
                grooves += [len(prof) + 1, len(prof) + 2]
                prof += [(gx * h - g, R), (gx * h - g * 0.6, R - 0.009), (gx * h + g * 0.6, R - 0.009), (gx * h + g, R)]
            prof += [(h * 0.88, R * 0.976), (h, R * 0.9), (h, R * 0.77), (h * 0.9, rr)]
            edge = (2, len(prof) - 4)
        else:
            prof = [(-h * 0.9, rr), (-h, R * 0.8), (-h * 0.86, R * 0.982), (-h * 0.42, R), (h * 0.42, R), (h * 0.86, R * 0.982),
                    (h, R * 0.9), (h, R * 0.77), (h * 0.9, rr)]
            edge = (3, 4)
        v, f, band = lathe(prof, ts)
        bm = new_bm(v, f, mat='tire')
        dk = bm.verts.layers.float.new('dark')
        # Tread hint: every other vertex round the two tread edges is darker, which reads as blocks at a glance.
        bm.verts.ensure_lookup_table()
        for ring_ in edge:
            for i in range(0, ts, 2): bm.verts[ring_ * ts + i][dk] = 0.6
        for ring_ in grooves:
            for i in range(ts): bm.verts[ring_ * ts + i][dk] = 0.75
        orient(bm, ('out', (0, 0, 0))); out.append(to_obj(bm, 'tire'))
        if s.hi:
            size = '%d/%d R%d' % (round(P['tw'] * 1000 / 5) * 5, 50 if rr / R > 0.62 else 70, round(rr * 2 / 0.0254))
            for a, word in ((pi / 2, 'GRIPWELL  CALAMITY'), (-pi / 2, size + '  M+S')):
                out.append(text('sidewall', word, (a, 0, 0), (1, 0, 0), (0, 1, 0), R * 0.07, 'tire', 0.075, bend=(R * 0.835, h + 0.0015)))
            for i in range(5 if ns != 6 and ns != 8 else ns):
                a = 2 * pi * (i + 0.5) / (5 if ns != 6 and ns != 8 else ns)
                out.append(ring('nut', (h * 0.84, R * 0.085 * sin(a), R * 0.085 * cos(a)), 0, R * 0.024, 0.01, 'x', 'chrome', segs=6))
            out.append(ring('cap', (h * 0.84, 0, 0), 0, R * 0.045, 0.006, 'x', 'gloss', segs=10))
        v, f, _ = lathe([(-h * 0.9, rr), (-h * 0.9, 0)], 16)
        bm = new_bm(v, f, mat='tire'); orient(bm, ('dir', (-1, 0, 0), 0)); out.append(to_obj(bm, 'inner', 0.008))
        prof = [(h * 0.9, rr), (h * 0.97, rr * 0.955), (h * 0.8, rr * 0.9), (h * 0.05, rr * 0.86), (h * 0.05, 0)]
        v, f, _ = lathe(prof, 32)
        bm = new_bm(v, f, mat='rim'); orient(bm, ('dir', (1, 0, 0), len(f) - 1)); out.append(to_obj(bm, 'barrel'))
        v, f, _ = lathe([(h * 0.12, R * 0.53), (h * 0.3, R * 0.53), (h * 0.3, R * 0.2)], 20)
        bm = new_bm(v, f, mat='rim'); orient(bm, ('dir', (1, 0, 0), len(f) - 1)); out.append(to_obj(bm, 'disc', 0.2))
        v, f, _ = lathe([(h * 0.3, R * 0.19), (h * 0.8, R * 0.16), (h * 0.84, R * 0.12), (h * 0.84, 0)], 12)
        bm = new_bm(v, f, mat='rim'); orient(bm, ('dir', (1, 0, 0), len(f) - 1)); out.append(to_obj(bm, 'hub'))
        v, f = [], []
        # Each spoke is a pair: (half angle between the two at the hub, at the rim). The default closes toward the rim.
        # 'twin': 0 makes each a single spoke; 'spoke_t' may be (half width at the hub, at the rim).
        tw_ = s.g('twin', (75 / ns, 27.5 / ns)) or (0, 0)
        st = s.g('spoke_t', 0.012); st = st if isinstance(st, tuple) else (st, st + 0.001)
        for i in range(ns):
            for sg in ((-1, 1) if tw_[0] or tw_[1] else (1,)):
                a0 = radians(i * 360 / ns + sg * tw_[0]); a1 = radians(i * 360 / ns + sg * tw_[1])
                n = len(v)
                for r, t, xf, a in ((R * 0.12, st[0], h * 0.8, a0), (rr * 0.9, st[1], h * 0.78, a1)):
                    for q in (-1, 1):
                        y = r * sin(a) + q * t * cos(a); z = r * cos(a) - q * t * sin(a)
                        v += [(xf, y, z), (xf - 0.035, y, z)]
                f += [(n, n + 2, n + 6, n + 4), (n, n + 4, n + 5, n + 1), (n + 2, n + 3, n + 7, n + 6)]
        bm = new_bm(v, f, mat='rim')
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.normal_update()
        # Open-backed spokes: make each front face look outward and its two flanks follow.
        bm.faces.ensure_lookup_table()
        for i in range(0, len(bm.faces), 3):
            if bm.faces[i].normal.x < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[i:i + 3])
            # Machined face, painted flanks: the two-tone alloy.
            if s.g('twotone'):
                for fc in bm.faces[i + 1:i + 3]: fc.material_index = MI['gloss']
        out.append(to_obj(bm, 'spokes'))
        if s.g('twotone'):
            v, f, _ = lathe([(h * 0.34, R * 0.2), (h * 0.42, rr * 0.88)], 20)
            bm = new_bm(v, f, mat='gloss'); orient(bm, ('dir', (1, 0, 0), 0)); out.append(to_obj(bm, 'pockets', 0.03))
        return join(out, 'wheel0')


# ── Occlusion bake ───────────────────────────────────────────────────────────

DIRS = []
for _i in range(24):
    _r = sqrt((_i + 0.5) / 24); _p = _i * 2.399963
    DIRS.append((_r * cos(_p), _r * sin(_p), sqrt(1 - _r * _r)))


def bake(ob, occluders=(), ground=True, reach=0.5, floor=0.12, rays=True):
    """rays=False writes the tints (and the hand-set 'dark') alone: the level has a baked occlusion map instead."""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me); bm.normal_update()
    gi = MI['glass']
    V = [v.co.copy() for v in bm.verts]; F = [[v.index for v in f.verts] for f in bm.faces if f.material_index != gi]
    for ome, M in occluders:
        n = len(V); V += [M @ v.co for v in ome.vertices]; F += [[n + i for i in p.vertices] for p in ome.polygons]
    if ground:
        n = len(V); V += [Vector((-30, -30, 0)), Vector((30, -30, 0)), Vector((30, 30, 0)), Vector((-30, 30, 0))]; F.append([n, n + 1, n + 2, n + 3])
    tree = BVHTree.FromPolygons(V, F)
    tint = [0.0] * (len(me.loops) * 4); me.attributes['tint'].data.foreach_get('color', tint)
    dark = [0.0] * len(me.vertices); me.attributes['dark'].data.foreach_get('value', dark)
    out = [1.0] * (len(me.loops) * 4); cache = {}
    for f in bm.faces:
        for l in f.loops:
            v = l.vert; ao = 1.0
            if f.material_index != gi:
                # Per vertex and material, not per corner: a corner-by-corner bake splits every vertex in the file.
                n = v.normal
                key = (v.index, f.material_index)
                ao = cache.get(key)
                if ao is None:
                    ao = 1.0
                    if rays:
                        t = n.orthogonal().normalized(); b = n.cross(t); o = v.co + n * 0.004; occ = 0.0
                        for dx, dy, dz in DIRS:
                            hit = tree.ray_cast(o, t * dx + b * dy + n * dz, reach)
                            if hit[0] is not None: occ += 1 - hit[3] / reach
                        ao = floor + (1 - floor) * max(0.0, 1 - occ / len(DIRS) * 1.25) ** 1.2
                        if f.material_index == 0: ao = 0.3 + 0.7 * ao
                    ao *= 1 - 0.88 * dark[v.index]
                    cache[key] = ao
            i = l.index * 4
            out[i] = tint[i] * ao; out[i + 1] = tint[i + 1] * ao; out[i + 2] = tint[i + 2] * ao; out[i + 3] = tint[i + 3]
    bm.free()
    for nme in ('tint', 'dark'): me.attributes.remove(me.attributes[nme])
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    col.data.foreach_set('color', out)
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def shade(ob, angle=50, keep=False):
    """keep: edges already marked sharp (a body crease) stay sharp whatever their angle."""
    me = ob.data
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    hard = [e.index for e in me.edges if e.use_edge_sharp] if keep else []
    me.set_sharp_from_angle(angle=radians(angle))
    for i in hard: me.edges[i].use_edge_sharp = True
    if keep: print('CREASE edges kept sharp:', len(hard))
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 50
    apply_mods(ob)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# ── Textures: unwrap, bake, save ─────────────────────────────────────────────
# The two near levels of a car share one unwrap and two maps, public/models/<kind>_n.webp (tangent-space normals:
# lens fluting, reflector facets, grille mesh, seat channels, cabin grain, baked from procedural relief on the
# materials) and <kind>_o.webp (ambient occlusion per texel, the whole car, wheels and road as occluders). Tires of
# every kind share cars_wheel_n/_o.webp, baked from modelled tread blocks; it repeats WREP times round the wheel.
# Share of the atlas by what is on the face: lamps need their ribs resolved, glass is never sampled.

TEXN, TEXO, WREP = 1024, 1024, 8
UVW = {'lamp': 5.0, 'grille': 3.0, 'seat': 1.0, 'paint': 1.0, 'glass': 0.04, 'interior': 0.6, 'under': 0.25, 'rest': 0.8}
# CARS_OUT sends a trial run somewhere else: the game must never see model files its loader is not ready for.
MODELS = os.environ.get('CARS_OUT') or os.path.join(ROOT, 'public', 'models')


def _only(obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]


def relief(P=None):
    """Procedural height on the materials that have a texture in life, in object space (meters), for the normal bake."""
    def bump(name, fn, dist):
        m = bpy.data.materials[name]; nt = m.node_tree
        bsdf = next(x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED')
        tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Object'], sep.inputs[0])

        def M(op, a, b=None):
            nd = nt.nodes.new('ShaderNodeMath'); nd.operation = op
            for i, v in enumerate((a, b)):
                if v is None: continue
                if isinstance(v, (int, float)): nd.inputs[i].default_value = v
                else: nt.links.new(v, nd.inputs[i])
            return nd.outputs[0]
        h = fn(sep.outputs[0], sep.outputs[1], sep.outputs[2], M, nt, tc)
        bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = 1.0; bp.inputs['Distance'].default_value = dist
        nt.links.new(h, bp.inputs['Height']); nt.links.new(bp.outputs['Normal'], bsdf.inputs['Normal'])
    w = lambda pitch: 2 * pi / pitch
    # Blender's frame here: x across the car, y along it (tail positive), z up.
    flutes = lambda x, y, z, M, nt, tc: M('SINE', M('MULTIPLY', M('ADD', x, M('MULTIPLY', y, 0.8)), w(0.009)))
    facets = lambda x, y, z, M, nt, tc: M('MULTIPLY', M('SINE', M('MULTIPLY', M('ADD', x, M('MULTIPLY', y, 0.8)), w(0.014))), M('SINE', M('MULTIPLY', z, w(0.014))))
    # A lattice standing proud of its holes: one minus the product of two crossed half-waves.
    mesh = lambda x, y, z, M, nt, tc: M('SUBTRACT', 1.0, M('MULTIPLY', M('ABSOLUTE', M('SINE', M('MULTIPLY', M('ADD', M('ADD', x, M('MULTIPLY', y, 0.8)), z), pi / 0.021))),
                                                           M('ABSOLUTE', M('SINE', M('MULTIPLY', M('SUBTRACT', M('ADD', x, M('MULTIPLY', y, 0.8)), z), pi / 0.021)))))
    channels = lambda x, y, z, M, nt, tc: M('POWER', M('ABSOLUTE', M('SINE', M('MULTIPLY', M('ADD', y, z), pi / 0.075))), 0.5)

    def grain(x, y, z, M, nt, tc):
        nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 32.0; nz.inputs['Detail'].default_value = 2.0
        nt.links.new(tc.outputs['Object'], nz.inputs['Vector']); return nz.outputs[0]
    for n in ('lamp_tail', 'lamp_brake', 'lamp_rev', 'lamp_ind'): bump(n, flutes, 0.0009)
    # The reflector's facets are a sparkle, not a texture: at 1.2 mm deep they read as chain mail from three meters.
    for n in ('lamp_head', 'lamp_drl'): bump(n, facets, 0.0002)
    # 'diamond' (pitch, depth) makes the grille a closed panel of shallow pillows instead of an open lattice.
    dm = (P or {}).get('diamond')
    pillows = lambda x, y, z, M, nt, tc: M('MULTIPLY', M('ABSOLUTE', M('SINE', M('MULTIPLY', M('ADD', M('ADD', x, M('MULTIPLY', y, 0.8)), z), pi / dm[0]))),
                                                    M('ABSOLUTE', M('SINE', M('MULTIPLY', M('SUBTRACT', M('ADD', x, M('MULTIPLY', y, 0.8)), z), pi / dm[0]))))
    if dm: bump('grille', pillows, dm[1])
    else: bump('grille', mesh, 0.004)
    bump('seat', channels, 0.007); bump('interior', grain, 0.0016)


def unwrap(obs, sill, uvw=None):
    """One shared layout for the given bodies: projected a material group at a time (so no island spans two
    groups), brought to one texel density, scaled by UVW (and 0.5 for every body after the first), packed together."""
    import numpy as np
    W = dict(UVW, **(uvw or {}))
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    for oi, ob in enumerate(obs):
        me = ob.data
        while me.uv_layers: me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap')
        gid = []
        for p in me.polygons:
            n = MATS[p.material_index]
            gid.append('lamp' if n.startswith('lamp') else n if n in ('grille', 'seat', 'paint', 'glass', 'interior')
                       else 'under' if (p.center.z < sill + 0.04 and p.normal.z < -0.3) else 'rest')
        _only([ob]); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE')
        for g in UVW:
            bpy.ops.mesh.select_all(action='DESELECT')
            bm = bmesh.from_edit_mesh(me); bm.faces.ensure_lookup_table(); k = 0
            for f in bm.faces:
                if gid[f.index] == g: f.select_set(True); k += 1
            bmesh.update_edit_mesh(me)
            if k: bpy.ops.uv.smart_project(angle_limit=radians(66), island_margin=0.0)
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.average_islands_scale()
        bpy.ops.object.mode_set(mode='OBJECT')
        uv = np.empty(len(me.loops) * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
        wl = np.empty(len(me.loops), np.float32); a2 = a3 = 0.0
        for p, g in zip(me.polygons, gid):
            q = uv[p.loop_start:p.loop_start + p.loop_total]; x, y = q[:, 0], q[:, 1]
            a2 += abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2; a3 += p.area
            wl[p.loop_start:p.loop_start + p.loop_total] = W[g] * (0.5 if oi else 1.0)
        uv *= (sqrt(a3 / max(a2, 1e-12)) * wl)[:, None]
        me.uv_layers.active.data.foreach_set('uv', uv.ravel())
    _only(obs); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=0.002, shape_method='CONCAVE')
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
    bpy.ops.object.mode_set(mode='OBJECT')
    lo, hi, area, a3, pa = [9, 9], [-9, -9], 0.0, 0.0, 0.0
    for oi, ob in enumerate(obs):
        me = ob.data
        uv = np.empty(len(me.loops) * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
        lo = [min(lo[i], float(uv[:, i].min())) for i in (0, 1)]; hi = [max(hi[i], float(uv[:, i].max())) for i in (0, 1)]
        for p in me.polygons:
            q = uv[p.loop_start:p.loop_start + p.loop_total]; x, y = q[:, 0], q[:, 1]
            a = abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2; area += a
            if oi == 0 and MATS[p.material_index] == 'paint': a3 += p.area; pa += a
    # mm of paint per texel on the nearest level: what the occlusion map resolves.
    return {'uv_lo': [round(v, 3) for v in lo], 'uv_hi': [round(v, 3) for v in hi], 'fill': round(area, 3),
            'mm_per_texel': round(1000 * sqrt(a3 / max(pa, 1e-9)) / TEXN, 1)}


def _bake_setup(samples_dist=0.6):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try: sc.cycles.device = 'CPU'; sc.cycles.use_denoising = False
    except Exception: pass
    w = bpy.data.worlds.new('bakeworld'); sc.world = w
    try: w.light_settings.distance = samples_dist
    except Exception: pass
    return sc


def _target(mats, img):
    for m in mats:
        nt = m.node_tree
        nd = nt.nodes.get('bake_target') or nt.nodes.new('ShaderNodeTexImage')
        nd.name = 'bake_target'; nd.image = img
        for x in nt.nodes: x.select = False
        nd.select = True; nt.nodes.active = nd


def _save(img, path, quality):
    img.filepath_raw = path; img.file_format = 'WEBP'; img.save(quality=quality)
    return round(os.path.getsize(path) / 1000)


def bake_maps(kind, sets, P):
    sc = _bake_setup()
    imgN = bpy.data.images.new(kind + '_n', TEXN, TEXN, alpha=False); imgN.generated_color = (0.5, 0.5, 1.0, 1.0)
    imgO = bpy.data.images.new(kind + '_o', TEXO, TEXO, alpha=False); imgO.generated_color = (1.0, 1.0, 1.0, 1.0)
    for im in (imgN, imgO): im.colorspace_settings.name = 'Non-Color'
    mats = [bpy.data.materials[n] for n in MATS]
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    gme = bpy.data.meshes.new('bakeground'); bm.to_mesh(gme); bm.free()
    ground = bpy.data.objects.new('bakeground', gme); sc.collection.objects.link(ground)
    for b, w in sets: b.hide_render = True; w.hide_render = True
    gi = MI['glass']
    for level in (0, 1):
        body, wheel = sets[level]
        dup = body.copy(); dup.data = body.data.copy(); sc.collection.objects.link(dup); dup.hide_render = False
        bm = bmesh.new(); bm.from_mesh(dup.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == gi], context='FACES')
        bm.to_mesh(dup.data); bm.free()
        insts = []
        for sxn in (1, -1):
            for z in (P['wb'] / 2, -P['wb'] / 2):
                o = bpy.data.objects.new('bw', wheel.data); sc.collection.objects.link(o)
                o.location = B(sxn * P['track'] / 2, P['R'], z)
                if sxn < 0: o.rotation_euler = (0, 0, pi)
                insts.append(o)
        _only([dup])
        for img, typ, smp, margin in ((imgN, 'NORMAL', 2, 2), (imgO, 'AO', 48, 2)):
            _target(mats, img); sc.cycles.samples = smp
            bpy.ops.object.bake(type=typ, normal_space='TANGENT', margin=margin, use_clear=False)
        for o in insts + [dup]: bpy.data.objects.remove(o)
    bpy.data.objects.remove(ground)
    for b, w in sets: b.hide_render = False; w.hide_render = False
    # The relief has done its job; the exporter should not go looking at it.
    for m in mats:
        nt = m.node_tree
        for l in list(nt.links):
            if l.to_socket.name == 'Normal' and l.to_node.type == 'BSDF_PRINCIPLED': nt.links.remove(l)
    return {'n_kB': _save(imgN, os.path.join(MODELS, kind + '_n.webp'), 90), 'o_kB': _save(imgO, os.path.join(MODELS, kind + '_o.webp'), 80)}


def wheel_uv(ob, P, s):
    """Tires onto the shared strip: u round the wheel (WREP repeats), v across the tread (0.02-0.70) or up the
    sidewall (0.76-0.99). Everything else sits on the flat gap between the two."""
    me = ob.data; R = P['R']; h = P['tw'] / 2; rr = R * s.g('rr', 0.67); ti = MI['tire']
    uvl = me.uv_layers.new(name='UVMap').data
    for p in me.polygons:
        if p.material_index != ti:
            for li in p.loop_indices: uvl[li].uv = (0.5, 0.74)
            continue
        c = p.center; ac = atan2(c.z, -c.y); tread = hypot(c.z, c.y) > R * 0.96
        for li in p.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            a = atan2(v.z, -v.y)
            if a - ac > pi: a -= 2 * pi
            if a - ac < -pi: a += 2 * pi
            if tread: vv = 0.02 + 0.68 * min(1.0, max(0.0, v.x / h * 0.5 + 0.5))
            else: vv = 0.76 + 0.23 * min(1.0, max(0.0, (hypot(v.z, v.y) - rr) / (R - rr)))
            uvl[li].uv = (a / (2 * pi) * WREP, vv)


def wheel_texture():
    """cars_wheel_n/_o.webp: a strip of real tread blocks and sidewall mouldings baked down onto a flat square.
    One unit is a quarter of a meter; x is round the tire (the strip repeats), y across it."""
    sc = _bake_setup(0.12)
    bm = bmesh.new()
    def blk(cx, cy, sx, sy, hgt, rot=0.0, taper=0.75):
        for dx in (-1, 0, 1):
            vs = []
            for zt, k in ((0.0, 1.0), (hgt, taper)):
                for ax, ay in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    x = ax * sx / 2 * (k if sx < 0.9 else 1.0); y = ay * sy / 2 * k
                    vs.append(bm.verts.new((cx + dx + x * cos(rot) - y * sin(rot), cy + x * sin(rot) + y * cos(rot), zt)))
            for i in range(4): bm.faces.new((vs[i], vs[(i + 1) % 4], vs[4 + (i + 1) % 4], vs[4 + i]))
            bm.faces.new(vs[4:8])
    bm.faces.new([bm.verts.new(q) for q in ((-1.5, -0.5, 0), (2.5, -0.5, 0), (2.5, 1.5, 0), (-1.5, 1.5, 0))])
    for i in range(5):
        blk(i * 0.2 + 0.1, 0.075, 0.15, 0.125, 0.032, 0.12); blk(i * 0.2, 0.645, 0.15, 0.125, 0.032, -0.12)
    for i in range(4):
        blk(i * 0.25 + 0.06, 0.27, 0.2, 0.115, 0.032, 0.38); blk(i * 0.25 + 0.185, 0.45, 0.2, 0.115, 0.032, -0.38)
        # A sipe's worth of relief on each centre block.
        blk(i * 0.25 + 0.06, 0.27, 0.09, 0.02, 0.04, 0.38 + pi / 2, 0.5); blk(i * 0.25 + 0.185, 0.45, 0.09, 0.02, 0.04, -0.38 + pi / 2, 0.5)
    blk(0.5, 0.785, 1.0, 0.035, 0.014, 0.0, 0.4); blk(0.5, 0.885, 1.0, 0.012, 0.006, 0.0, 0.5)
    for i in range(16): blk((i + 0.5) / 16, 0.945, 0.02, 0.07, 0.009, 0.0, 0.6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    hme = bpy.data.meshes.new('treadhi'); bm.to_mesh(hme); bm.free()
    hi = bpy.data.objects.new('treadhi', hme); sc.collection.objects.link(hi)
    lme = bpy.data.meshes.new('treadlo'); lme.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    uvl = lme.uv_layers.new(name='UVMap').data
    for i, q in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))): uvl[i].uv = q
    lo = bpy.data.objects.new('treadlo', lme); sc.collection.objects.link(lo)
    m = bpy.data.materials.new('treadmat')
    try: m.use_nodes = True
    except Exception: pass
    lme.materials.append(m)
    out = {}
    for tag, typ, smp, q in (('n', 'NORMAL', 4, 92), ('o', 'AO', 96, 85)):
        img = bpy.data.images.new('wheel_' + tag, 512, 512, alpha=False); img.colorspace_settings.name = 'Non-Color'
        _target([m], img); sc.cycles.samples = smp
        bpy.ops.object.select_all(action='DESELECT'); hi.select_set(True); lo.select_set(True); bpy.context.view_layer.objects.active = lo
        bpy.ops.object.bake(type=typ, normal_space='TANGENT', margin=0, use_clear=True, use_selected_to_active=True, cage_extrusion=0.2, max_ray_distance=0.5)
        out[tag + '_kB'] = _save(img, os.path.join(MODELS, 'cars_wheel_' + tag + '.webp'), q)
    print('STATS ' + json.dumps({'wheeltex': out}))


# ── What makes each one itself ───────────────────────────────────────────────
# d_<kind>(car, lod) returns extra parts for the body. Silhouette pieces are built at both LODs, trinkets at LOD0 only.

def _I(out):
    return lambda *a, **kw: out.append(box(*a, **kw))


def d_hatch(s, lod):
    P = s.P; out = []; I = _I(out)
    I('spoiler', (0, P['roof'][3] - 0.004, P['rhead'] - 0.10), (2 * P['xr'][2] - 0.1, 0.028, 0.2), 'paint', bevel=0 if lod else 0.01, pitch=radians(-6))
    if not lod: I('wiper_r', (0.14, P['deck'] + 0.075, P['deckf'] + 0.035), (0.36, 0.012, 0.018), 'trim', 0.01)
    return out


def d_coupe(s, lod):
    P = s.P; out = []; I = _I(out)
    I('lip', (0, P['deck_tail'] + 0.012, -(P['tail'] - 0.17)), (1.34, 0.028, 0.14), 'paint', bevel=0 if lod else 0.01, pitch=radians(10))
    # What the muscle car does not have: black louvres down the fastback, round driving lamps, a bright sill strip.
    n = 6; sl = (P['roof'][3] - P['deck']) / (P['rhead'] - P['deckf'])
    for i in range(n):
        t = (i + 0.7) / (n + 0.4); z = lerp(P['rhead'], P['deckf'], t); y = lerp(P['roof'][3], P['deck'], t) + 0.028
        I('louvre', (0, y, z), (2 * lerp(P['xr'][2], s.hw - 0.16, t) - 0.16, 0.012, 0.105), 'trim', 0.03, pitch=radians(-6))
    if lod: return out
    T, Bt = P['bumper_top'][0], P['bumper_bot'][0]
    for sx in (1, -1):
        for nm, r0, r1, d, m in (('fog_rim', 0.045, 0.058, 0.02, 'chrome'), ('fog', 0, 0.045, 0.012, 'lamp_drl')):
            out.append(ring(nm, (sx * 0.52, Bt + 0.1, s.zplan(0.52, 1) - 0.01), r0, r1, d, 'z', m, segs=12))
        I('sill_strip', (sx * (s.xat(0, P['sill'] + 0.05) + 0.004), P['sill'] + 0.05, 0), (0.012, 0.03, P['wb'] - 2 * s.arch_r - 0.12), 'chrome', bevel=0.004)
    return out


def d_muscle(s, lod):
    P = s.P; out = []; I = _I(out); bv = 0 if lod else 1
    yc = s.top(1.15)[0][4][1]
    I('scoop', (0, yc + 0.005, 1.15), (0.46, 0.10, 0.56), 'paint', bevel=0.03 * bv)
    I('scoop_mouth', (0, yc + 0.02, 1.15 + 0.275), (0.36, 0.045, 0.02), 'trim', 0.008)
    I('ducktail', (0, P['deck_tail'] + 0.022, -(P['tail'] - 0.16)), (1.56, 0.035, 0.18), 'paint', bevel=0.012 * bv, pitch=radians(13))
    Bt = P['bumper_bot'][0]
    I('chin', (0, Bt - 0.02, P['nose'] - 0.2), (1.5, 0.05, 0.3), 'trim', 0.02, bevel=0.012 * bv)
    if lod: return out
    for sx in (1, -1):
        I('scoop_side', (sx * 0.2, yc + 0.03, 1.17), (0.03, 0.075, 0.5), 'trim', 0.02, bevel=0.008)
        I('pin', (sx * 0.62, s.top(1.9)[0][2][1] + 0.012, 1.9), (0.03, 0.012, 0.03), 'chrome', bevel=0.005)
        I('side_pipe', (sx * (s.hw - 0.02), P['sill'] - 0.01, -0.2), (0.07, 0.07, 1.5), 'chrome', 0.6, bevel=0.02)
    return out


def d_sports(s, lod):
    P = s.P; out = []; I = _I(out); bv = 0 if lod else 1
    zw = -(P['tail'] - 0.27); yt = P['deck_tail']
    for sx in (0.56, -0.56):
        I('wing_post', (sx, yt + 0.085, zw), (0.03, 0.17, 0.15), 'trim', 0.03)
    I('wing', (0, yt + 0.185, zw - 0.02), (1.72, 0.026, 0.27), 'paint', bevel=0.01 * bv, pitch=radians(8))
    for sx in (1, -1):
        I('wing_end', (sx * 0.86, yt + 0.17, zw - 0.02), (0.02, 0.10, 0.29), 'paint')
        # The side intake ahead of the rear wheel: a dark mouth standing just proud of the skin.
        I('intake', (sx * (s.xat(-0.70, 0.54) - 0.004), 0.54, -0.70), (0.03, 0.25, 0.36), 'trim', 0.006, bevel=0.012 * bv)
    Bt = P['bumper_bot'][0]
    I('splitter', (0, Bt + 0.005, P['nose'] - 0.13), (1.2, 0.02, 0.24), 'trim', 0.02)
    if not lod:
        I('mouth', (0, Bt + 0.105, P['nose'] - 0.002), (0.95, 0.10, 0.012), 'trim', 0.006)
        for i in range(5): I('engine_slat', (0, P['deck'] + 0.038, P['deckf'] - 0.1 - i * 0.05), (0.86, 0.008, 0.02), 'gloss')
        Br = P['bumper_bot'][1]
        I('diffuser', (0, Br + 0.02, -(P['tail'] - 0.16)), (1.3, 0.03, 0.34), 'trim', 0.02, pitch=radians(-9))
        for x in (-0.48, -0.24, 0.0, 0.24, 0.48): I('fin', (x, Br + 0.04, -(P['tail'] - 0.14)), (0.014, 0.1, 0.3), 'trim', 0.03, pitch=radians(-9))
        for sx in (1, -1):
            I('corner_intake', (sx * 0.66, Bt + 0.11, s.zplan(0.66, 1) - 0.02), (0.26, 0.1, 0.03), 'gloss', bevel=0.01)
            I('wing_stay', (sx * 0.56, yt + 0.16, zw - 0.02), (0.06, 0.02, 0.2), 'trim', 0.03)
    return out


def d_pickup(s, lod):
    P = s.P; out = []; I = _I(out)
    z0, z1, fy = P['bed']; top = P['deck'] - 0.03
    I('bed', (0, (fy + top) / 2, (z0 + z1) / 2), (2 * (s.hw - 0.13), top - fy, z0 - z1 + 0.02), 'paint', drop=3, flip=True)
    if not lod:
        y0, y1, zr, _ = s.face[-1]
        I('gate_handle', (0, y1 - 0.035, zr - 0.006), (0.22, 0.04, 0.014), 'trim', 0.03, bevel=0.005)
        if s.hi: out.append(text('gate_name', 'DOCKHAND', (0, (y0 + y1) / 2 - 0.02, zr - 0.012), (-1, 0, 0), (0, 1, 0), 0.085, 'chrome', None, squeeze=1.25))
        I('bed_rail', (0, P['deck'] + 0.012, P['bed'][0] - 0.03), (2 * s.hw - 0.2, 0.03, 0.05), 'trim', 0.03)
        for sx in (1, -1):
            I('tub_l', (sx * (s.hw - 0.27), fy + 0.12, s.zR), (0.28, 0.24, 0.95), 'paint', bevel=0.03)
            I('step', (sx * (s.hw - 0.03), P['sill'] - 0.03, 0.2), (0.16, 0.03, 1.5), 'trim', 0.03)
    return out


def d_van(s, lod):
    P = s.P; out = []; I = _I(out); belt = P['belt']; roof = max(P['roof'])
    if lod: return out
    for sx in (1, -1):
        # The sliding door's track, let into the rear quarter at the belt.
        I('track', (sx * (s.xat(-1.6, belt - 0.02) + 0.003), belt - 0.02, -1.58), (0.014, 0.028, 1.42), 'trim', 0.015)
    y0, y1, zr, _ = s.face[-1]
    for sx in (0.075, -0.075):
        I('barn_handle', (sx, y1 - 0.12, zr - 0.008), (0.03, 0.13, 0.02), 'chrome', bevel=0.006)
    I('step_r', (0, P['bumper_top'][1] + 0.006, -(P['tail'] - 0.07)), (1.3, 0.012, 0.12), 'trim', 0.05)
    za, zb = P['mid'] - 0.12, P['rhead'] + 0.1
    for sx in (1, -1):
        # Three pressed ribs along the load space: a slab side with nothing on it reads as cardboard.
        for y in (1.02, 1.56, 1.8):
            I('rib', (sx * (s.xat((za + zb) / 2, y) + 0.001), y, (za + zb) / 2), (0.014, 0.05, za - zb), 'paint', bevel=0.006)
        for y in (y0 + 0.04, y1 - 0.03):
            xh = s.hw - 0.2; I('hinge', (sx * xh, y, s.zplan(xh, -1) + s.rake(-1, y) - 0.006), (0.09, 0.035, 0.022), 'trim', 0.04, bevel=0.006)
    z0, z1 = P['b2'] - 0.25, P['rhead'] + 0.06
    I('cargo', (0, (belt + roof - 0.09) / 2, (z0 + z1) / 2), (2 * P['xr'][1] - 0.04, roof - 0.09 - belt, z0 - z1), 'interior', 0.035, flip=True)
    return out


def d_taxi(s, lod):
    P = s.P; out = []; I = _I(out); roof = max(P['roof']); z = P['b1'] + 0.05
    I('sign', (0, roof + 0.045, z), (0.52, 0.085, 0.17), 'trim', (0.95, 0.85, 0.35), bevel=0 if lod else 0.02)
    if not lod:
        I('sign_base', (0, roof + 0.004, z), (0.6, 0.016, 0.22), 'trim', 0.03)
        zp = P['cowl'] - 1.23; xs = 2 * (s.hw - 0.13)
        I('partition_lo', (0, 0.66, zp), (xs, 0.56, 0.035), 'interior', 0.035)
        I('partition', (0, 1.1, zp), (xs - 0.06, 0.34, 0.01), 'glass', (1.0, 1.0, 1.0, 0.22))
        I('partition_bar', (0, 0.945, zp), (xs, 0.03, 0.04), 'chrome', 0.5)
        I('meter', (-0.02, P['belt'] + 0.085, P['cowl'] - 0.42), (0.1, 0.055, 0.05), 'interior', 0.02, bevel=0.008)
        I('meter_face', (-0.02, P['belt'] + 0.085, P['cowl'] - 0.447), (0.08, 0.035, 0.004), 'lamp_tail', (0.9, 0.08, 0.02))
        if s.hi: out.append(text('sign_txt', 'TAXI', (0, roof + 0.045, z - 0.087), (-1, 0, 0), (0, 1, 0), 0.05, 'trim', 0.02))
        if s.hi: out.append(text('sign_txt', 'TAXI', (0, roof + 0.045, z + 0.087), (1, 0, 0), (0, 1, 0), 0.05, 'trim', 0.02))
    # Two rows of checker along the doors, as flat decals a few millimetres off the skin. The far level, which is all
    # a phone draws, has the same band for 84 triangles: one dark quad a side (the cage is flat there) under the pale squares.
    c = 0.08; z0 = P['cowl'] - 0.05; n = int((z0 - P['rhead'] - 0.04) / c); yb = 0.61
    for tone, tint in ((0, 0.03), (1, 0.8)):
        v, f = [], []; off = 0.008 + 0.006 * tone if lod else 0.005
        cells = [(0, n, 0, 2)] if lod and tone == 0 else [(i, i + 1, r, r + 1) for i in range(n) for r in (0, 1) if (i + r) % 2 == tone]
        for sx in (1, -1):
            for i0, i1, r0, r1 in cells:
                    za, zb, ya, yc = z0 - i0 * c, z0 - i1 * c, yb + r0 * c, yb + r1 * c
                    q = len(v)
                    v += [(sx * (s.xat(zz, yy) + off), yy, zz) for zz, yy in ((za, ya), (zb, ya), (zb, yc), (za, yc))]
                    f.append((q, q + 1, q + 2, q + 3))
        bm = new_bm(v, f, mat='trim'); bm.normal_update()
        for fc in bm.faces:
            if fc.normal.x * fc.calc_center_median().x < 0: fc.normal_flip()
        bm.normal_update()
        out.append(to_obj(bm, 'checker', tint))
    return out


def d_cruiser(s, lod):
    P = s.P; out = []; I = _I(out); roof = max(P['roof']); z = P['b1']; bv = 0 if lod else 1
    I('bar_base', (0, roof + 0.008, z), (1.12, 0.024, 0.2), 'trim', 0.03)
    # Red to the driver's side, blue to the kerb: tints on the two lamp materials, since there is no third.
    for sx, mat, tint in ((1, 'lamp_tail', (0.85, 0.02, 0.02)), (-1, 'lamp_head', (0.04, 0.12, 0.95))):
        I('bar', (sx * 0.31, roof + 0.05, z), (0.5, 0.066, 0.17), mat, tint, bevel=0.015 * bv)
    I('bar_mid', (0, roof + 0.046, z), (0.12, 0.058, 0.18), 'chrome')
    T, Bt = P['bumper_top'][0], P['bumper_bot'][0]; zf = P['nose'] + 0.045
    for sx in (0.32, -0.32):
        I('push_post', (sx, (T + 0.2 + Bt + 0.06) / 2, zf), (0.07, T + 0.14 - Bt, 0.06), 'trim', 0.03, bevel=0.012 * bv)
    for y in (T + 0.13, T - 0.08):
        I('push_bar', (0, y, zf), (0.7, 0.05, 0.045), 'trim', 0.03, bevel=0.01 * bv)
    if not lod:
        I('spot', (s.hw - 0.02, P['belt'] + 0.16, lerp(P['cowl'], P['header'], 0.3)), (0.09, 0.09, 0.1), 'chrome', bevel=0.02)
        zp = P['cowl'] - 1.23; xs = 2 * (s.hw - 0.13)
        I('cage_lo', (0, 0.66, zp), (xs, 0.56, 0.03), 'interior', 0.03)
        for y in (0.95, 1.27): I('cage_rail', (0, y, zp), (xs, 0.025, 0.025), 'trim', 0.05)
        for i in range(11): I('cage_bar', ((i - 5) * xs / 11, 1.11, zp), (0.012, 0.32, 0.012), 'trim', 0.05)
        I('radio', (0, P['belt'] - 0.06, P['cowl'] - 0.47), (0.17, 0.06, 0.12), 'gloss', bevel=0.008)
        I('laptop', (-0.12, P['belt'] + 0.03, P['cowl'] - 0.5), (0.26, 0.17, 0.012), 'gloss', (0.03, 0.08, 0.12), pitch=radians(-15))
        I('shotgun', (0.02, 0.9, P['cowl'] - 1.15), (0.03, 0.62, 0.03), 'trim', 0.03, pitch=radians(-8))
        if s.hi:
            for sx in (1, -1):
                out.append(text('door_txt', 'HARBOR PATROL', (sx * (s.xat(-0.05, 0.78) + 0.004), 0.78, -0.05), (0, 0, -sx), (0, 1, 0), 0.075, 'trim', (0.01, 0.02, 0.07), squeeze=0.9))
    return out


def d_tow(s, lod):
    P = s.P; out = []; I = _I(out); dk = P['deck'] + 0.02; roof = max(P['roof']); bv = 0 if lod else 1; hw = s.hw
    I('headboard', (0, dk + 0.42, P['deckf'] - 0.14), (1.9, 0.84, 0.06), 'trim', 0.05)
    I('beacon', (0, roof + 0.05, P['b1']), (1.25, 0.085, 0.18), 'lamp_head', (1.0, 0.45, 0.03), bevel=0.02 * bv)
    for sx in (1, -1):
        I('toolbox', (sx * (hw - 0.27), dk + 0.15, -1.3), (0.46, 0.30, 1.4), 'paint', bevel=0.015 * bv)
        # The boom: two beams from the winch up and back over the tail, propped on a post each.
        I('boom', (sx * 0.2, 1.93, -2.07), (0.1, 0.13, 2.08), 'trim', 0.06, pitch=0.398)
        I('boom_post', (sx * 0.2, (dk + 2.02) / 2, -2.3), (0.08, 2.02 - dk, 0.08), 'trim', 0.06)
    I('boom_head', (0, 2.33, -3.02), (0.56, 0.1, 0.12), 'trim', 0.06)
    I('winch', (0, dk + 0.2, -0.98), (0.62, 0.40, 0.42), 'trim', 0.05, bevel=0.03 * bv)
    I('cable', (0, 1.88, -3.03), (0.02, 0.86, 0.02), 'chrome', 0.3)
    I('hook', (0, 1.40, -3.03), (0.07, 0.14, 0.11), 'chrome', bevel=0.02 * bv)
    I('wheel_lift', (0, 0.62, -(P['tail'] - 0.22)), (1.5, 0.08, 0.36), 'trim', 0.04)
    if not lod:
        v, f, _ = lathe([(-0.26, 0.0), (-0.26, 0.16), (0.26, 0.16), (0.26, 0.0)], 12, c=(0, dk + 0.46, -0.98))
        bm = new_bm(v, f, mat='chrome'); orient(bm, ('out', (0, dk + 0.46, -0.98))); out.append(to_obj(bm, 'drum', 0.35))
        for sx in (1, -1):
            I('stack', (sx * (hw - 0.1), 1.62, P['deckf'] - 0.05), (0.09, 1.0, 0.09), 'chrome', bevel=0.02)
            I('step', (sx * (hw - 0.02), P['sill'] - 0.06, 0.55), (0.2, 0.04, 1.0), 'trim', 0.04)
            I('chain_box', (sx * 0.62, dk + 0.07, -2.75), (0.3, 0.14, 0.4), 'trim', 0.035, bevel=0.01)
            for i in range(6): I('chain', (sx * (0.55 + 0.03 * (i % 2)), dk + 0.155, -2.62 - i * 0.05), (0.05, 0.02, 0.035), 'chrome', 0.4)
            I('work_lamp', (sx * 0.7, dk + 0.9, P['deckf'] - 0.19), (0.12, 0.09, 0.05), 'lamp_rev', bevel=0.01)
        for i in range(5): I('cable_wrap', (0, dk + 0.46, -0.98), (0.5 - 0.02 * i, 0.33, 0.33), 'chrome', 0.2 + 0.03 * i, bevel=0.08)
        if s.hi:
            for sx in (1, -1):
                out.append(text('door_txt', 'MULE RECOVERY', (sx * (s.xat(0.55, 1.15) + 0.004), 1.15, 0.55), (0, 0, -sx), (0, 1, 0), 0.07, 'trim', 0.75, squeeze=0.85))
    return out


def d_bus(s, lod):
    P = s.P; out = []; I = _I(out); roof = max(P['roof']); hw = s.hw; bv = 0 if lod else 1
    yb = P['sill'] + 0.06; yt = roof - 0.30
    for di, (z0, z1) in enumerate(P['bus_doors']):
        zc = (z0 + z1) / 2; x = -(hw + 0.002); w = z0 - z1; hg = yt - yb; ym = (yb + yt) / 2
        if lod:
            I('door', (x, ym, zc), (0.035, hg, w), 'trim', 0.03)
            for q in (-1, 1): I('door_glass', (x - 0.019, lerp(yb, yt, 0.6), zc + q * w / 4), (0.006, hg * 0.66, w / 2 - 0.09), 'glass')
            continue
        # The shell is cut here (Car.shell): a lintel closes the opening above the leaves, and the two glazed leaves
        # hang a hand's depth inside it, each folding on a rubber centre line.
        xi = x + 0.06; top = roof - 0.2
        I('lintel', (x + 0.035, (yt + top) / 2 + 0.03, zc), (0.07, top - yt + 0.12, w + 0.02), 'gloss', bevel=0.01)
        for q in (-1, 1): I('jamb', (x + 0.035, ym, zc + q * (w / 2 - 0.012)), (0.07, hg, 0.03), 'gloss')
        I('well', (xi + 0.012, ym, zc), (0.02, hg, w), 'trim', 0.012)
        for q in (-1, 1):
            zl = zc + q * w / 4; lw = w / 2 - 0.02
            I('leaf', (xi, ym, zl), (0.014, hg - 0.03, lw), 'trim', 0.035, bevel=0.004)
            for f2 in (-1, 1):
                I('leaf_glass', (xi - 0.009, lerp(yb, yt, 0.63), zl + f2 * lw / 4), (0.006, hg * 0.58, lw / 2 - 0.05), 'glass', (1.0, 1.0, 1.0, 0.75))
                I('kick_glass', (xi - 0.009, lerp(yb, yt, 0.17), zl + f2 * lw / 4), (0.006, hg * 0.2, lw / 2 - 0.05), 'glass', (1.0, 1.0, 1.0, 0.75))
            I('fold', (xi - 0.01, ym, zl), (0.008, hg - 0.05, 0.016), 'gloss')
            I('grab', (xi - 0.018, lerp(yb, yt, 0.5), zl - q * (lw / 2 - 0.035)), (0.016, hg * 0.4, 0.016), 'chrome', (0.8, 0.65, 0.08))
        I('seal', (xi - 0.011, ym, zc), (0.012, hg - 0.03, 0.03), 'gloss')
        # The step it kneels to, with its yellow nosing.
        I('step', (x - 0.035, yb - 0.035, zc), (0.11, 0.035, w + 0.04), 'trim', 0.03)
        I('nosing', (x - 0.088, yb - 0.03, zc), (0.012, 0.03, w), 'trim', (0.75, 0.55, 0.04))
    I('dest', (0, roof - 0.21, P['header'] + 0.11), (1.7, 0.26, 0.12), 'trim', 0.025, bevel=0.02 * bv)
    I('dest_sign', (0, roof - 0.21, P['header'] + 0.172), (1.45, 0.17, 0.006), 'gloss' if s.hi else 'lamp_head', None if s.hi else (1.0, 0.5, 0.05))
    if s.hi:
        out.append(text('route', '7  PELICAN PIER', (0, roof - 0.21, P['header'] + 0.1765), (1, 0, 0), (0, 1, 0), 0.1, 'lamp_head', (1.0, 0.5, 0.05), squeeze=0.9))
        for sx in (1, -1):
            out.append(text('line', 'HARBOR LINE', (sx * (s.xat(2.6, 1.05) + 0.004), 1.05, 2.6 if sx > 0 else 2.2), (0, 0, -sx), (0, 1, 0), 0.16, 'trim', 0.85, squeeze=0.9))
    # Two air-conditioning pods and a roof hatch, not one slab.
    for zc, ln, wd in ((-3.1, 1.5, 1.7), (0.3, 1.2, 1.5)):
        I('hvac', (0, roof + 0.08, zc), (wd, 0.19, ln), 'trim', 0.45, bevel=0.06 * bv)
        if not lod:
            for i in range(5): I('hvac_slat', (0, roof + 0.178, zc + (i - 2) * ln * 0.14), (wd * 0.7, 0.008, ln * 0.07), 'trim', 0.08)
    I('hatch', (0, roof + 0.03, 2.2), (0.9, 0.07, 0.9), 'trim', 0.45, bevel=0.02 * bv)
    if not lod:
        zm = lerp(P['cowl'], P['header'], 0.25)
        for sx in (1, -1):
            # Mirrors on arms: a tube out from the pillar and down to the head.
            I('mirror_stay', (sx * (hw + 0.07), P['belt'] + 0.42, zm + 0.03), (0.2, 0.024, 0.024), 'chrome', 0.5)
            I('mirror_drop', (sx * (hw + 0.16), P['belt'] + 0.32, zm + 0.03), (0.024, 0.22, 0.024), 'chrome', 0.5)
        # Inside: stanchions and ceiling rails in yellow, the driver's screen, the fare box.
        yel = (0.75, 0.6, 0.06)
        for sx in (1, -1): I('ceiling_rail', (sx * 0.3, roof - 0.33, -0.6), (0.03, 0.03, 8.4), 'chrome', yel)
        for z in (3.5, 1.5, -0.4, -1.4, -3.0):
            for sx in (1, -1): I('stanchion', (sx * 0.3, (0.52 + roof - 0.33) / 2, z), (0.03, roof - 0.33 - 0.52, 0.03), 'chrome', yel)
        I('cab_screen', (0.72, 1.55, 3.5), (0.95, 0.9, 0.012), 'glass', (1.0, 1.0, 1.0, 0.25))
        I('cab_wall', (0.72, 0.8, 3.5), (0.95, 0.6, 0.03), 'interior', 0.05)
        I('farebox', (-0.15, 0.95, 4.15), (0.2, 0.55, 0.2), 'chrome', 0.35, bevel=0.02)
    if not lod:
        I('engine_grille', (0, 0.72, -(P['tail'] - 0.012)), (1.3, 0.3, 0.012), 'trim', 0.012)
        for sx in (1, -1):
            I('skirt', (sx * (s.xat(0, 0.9) + 0.004), 0.9, 0.0), (0.012, 0.03, 4.2), 'trim', 0.03)
    return out


def d_bolt(s, lod):
    P = s.P; out = []; I = _I(out); bv = 0 if lod else 1; hw = s.hw; R = P['R']; sill = P['sill']
    GOLD = (0.78, 0.52, 0.08); CLAD = 0.016

    def strip(name, quads, tint, want):
        # Loose quads laid just off the skin; want(centre) is the way each one should face.
        v = [p for q in quads for p in q]; f = [tuple(range(i * 4, i * 4 + 4)) for i in range(len(quads))]
        bm = new_bm(v, f, mat='trim'); bm.normal_update()
        for fc in bm.faces:
            if fc.normal.dot(B(*want(fc.calc_center_median()))) < 0: fc.normal_flip()
        bm.normal_update(); out.append(to_obj(bm, name, tint))

    I('spoiler', (0, P['roof'][3] - 0.012, P['rhead'] - 0.10), (2 * P['xr'][2] - 0.07, 0.03, 0.22), 'paint', bevel=0.01 * bv, pitch=radians(-9))
    # Black cladding: a band along the sills and a lip round each arch. It is half of what makes this a crossover.
    z0, z1 = s.zF - s.arch_r - 0.045, s.zR + s.arch_r + 0.045
    for sx in (1, -1):
        I('clad', (sx * (s.xat(0, sill + 0.09) - 0.006), sill + 0.05, (z0 + z1) / 2), (0.036, 0.13, z0 - z1), 'trim', CLAD, bevel=0.008 * bv)
        n = 5 if lod else 14; ri, ro = s.arch_r - 0.004, s.arch_r + 0.05
        for zc in (s.zF, s.zR):
            ring = []
            for i in range(n + 1):
                a = radians(lerp(-22, 202, i / n)); ca = cos(a); sa = sin(a)
                # Below the axle the opening drops straight to the sill, and so does its trim.
                pt = lambda r: (zc + r * (ca if 0 <= sa else (1 if ca > 0 else -1)), R + (r * sa if sa >= 0 else s.arch_r * sa))
                (zi, yi), (zo, yo) = pt(ri), pt(ro)
                # The skin flares toward the arch edge, so each edge of the trim finds its own width.
                xo = s.xat(zo, max(yo, sill + 0.02)) + 0.009; xi = max(xo, s.xat(zi, max(yi, sill + 0.02)) + 0.011)
                ring.append(((sx * xo, yo, zo), (sx * xi, yi, zi), (sx * (xi - 0.04), yi, zi)))
            face = [(a[0], b[0], b[1], a[1]) for a, b in zip(ring, ring[1:])]
            strip('arch', face, CLAD, lambda c, sx=sx: (sx, 0, 0))
            if not lod:
                lip = [(a[1], b[1], b[2], a[2]) for a, b in zip(ring, ring[1:])]
                # c is in Blender's frame (x, -z, y): the lip faces the hub.
                strip('arch_lip', lip, CLAD, lambda c, zc=zc: (0, R - c.z, zc + c.y))
    if lod: return out
    I('fin', (0, P['roof'][3] + 0.035, P['rhead'] + 0.22), (0.05, 0.05, 0.15), 'trim', 0.02, bevel=0.012, pitch=radians(-14))
    I('wiper_r', (0.12, P['deck'] + 0.07, P['deckf'] + 0.03), (0.34, 0.012, 0.018), 'trim', 0.01)
    # The face. Between the lamps a closed panel, not a grille: a shield, square-shouldered under the bonnet edge and
    # rounding in to a blunt point above the number plate, patterned (the 'grille' relief in the normal map), with a
    # bright bar across its top carrying the bowtie. All of it is laid on the skin by Car.panel.
    T, Bt = P['bumper_top'][0], P['bumper_bot'][0]
    shield = lambda y: 0.335 if y > 0.63 else 0.335 * max(0.0, 1 - ((0.63 - y) / 0.2) ** 2.4) ** (1 / 2.4)
    out.append(s.panel('shield', [0.752, 0.72, 0.68, 0.64, 0.60, 0.56, 0.52, 0.485, 0.455], shield, 'grille', 0.012, off=0.005))
    out.append(s.panel('shield_bar', [0.752, 0.737, 0.722], 0.335, 'chrome', None, off=0.009))
    # The black mask: from the inner end of each head lamp a gloss-black blade runs down and out across the bumper to
    # the lamp pod at its corner, so lamp, blade and pod read as one dark shape either side of the shield.
    bx = lambda y: 0.47 + 0.20 * smooth((0.665 - y) / 0.24)
    bw = lambda y: 0.062 - 0.012 * smooth((0.665 - y) / 0.3)
    # The blade crosses the bumper's shoulder, where the skin turns from a 45 degree ramp to upright inside 3 cm: rows
    # 5 cm apart went straight through it (the shoulder showed through the blade in holes and cut its end off ragged),
    # so down to the black of the pod the rows are 8 mm apart and faired (Car.panel, soft).
    mask_ys = [0.672 - 0.008 * i for i in range(30)] + [0.43, 0.37, 0.31, 0.275]
    for sx in (1, -1):
        out.append(s.panel('mask', mask_ys, bw, 'gloss', None, nx=4, off=0.008, xc=lambda y, sx=sx: sx * bx(y), soft=2))
        # The turn signal: an upright amber strip in the foot of the blade (the daytime strip is in the head lamp).
        # (It stands 6 mm proud of the blade it lies on: closer than that and the blade shows through it in notches.)
        out.append(s.panel('signal', [0.455, 0.43, 0.40, 0.37, 0.345, 0.31, 0.30], 0.012, 'lamp_ind', (0.5, 0.17, 0.015), nx=1, off=0.014, xc=lambda y, sx=sx: sx * (bx(y) + 0.004)))
    # The low intake, the only opening in the face: a wide dark mouth between the two pods, three bars across it.
    mouth = lambda y: 0.52 - 0.5 * (0.365 - y)
    out.append(s.panel('mouth', [0.365, 0.33, 0.29, 0.255, 0.235], mouth, 'trim', 0.006, off=0.004))
    for yb_ in (0.335, 0.297, 0.262):
        out.append(s.panel('bar', [yb_ + 0.007, yb_ - 0.007], lambda y: mouth(y) - 0.025, 'trim', 0.07, off=0.009))
    zN = P['nose'] - 0.014; nf = P['n_front']
    # Gold bowties, front and rear: a long bar and a short thick one across its middle.
    yb = 0.737; zb = s.wrap([(0, yb)], 1, 0.004)[0][2]
    I('bowtie', (0, yb, zb), (0.125, 0.024, 0.02), 'trim', GOLD); I('bowtie', (0, yb, zb), (0.062, 0.042, 0.022), 'trim', GOLD)
    y0, y1, zr, _ = s.face[-1]
    yb = y1 - 0.035; zb = zr + s.rake(-1, yb) - s.rake(-1, (y0 + y1) / 2) + 0.002
    I('bowtie', (0, yb, zb), (0.11, 0.022, 0.016), 'trim', GOLD); I('bowtie', (0, yb, zb), (0.055, 0.038, 0.018), 'trim', GOLD)
    # Roof rails: a satin bar a side, following the roof, standing on a foot at each end.
    for sx in (1, -1):
        v = []; f = []; n = 10; za, zb_ = P['header'] - 0.1, P['rhead'] + 0.1
        for i in range(n + 1):
            z = lerp(za, zb_, i / n); x, y = s.top(z)[0][2]; x -= 0.03
            y += 0.004 + 0.03 * min(1.0, sin(pi * i / n) * 3.2)
            v += [(sx * (x - 0.013), y - 0.009, z), (sx * (x + 0.013), y - 0.009, z), (sx * (x + 0.011), y + 0.012, z), (sx * (x - 0.011), y + 0.012, z)]
        for i in range(n):
            q = i * 4
            f += [(q + a, q + (a + 1) % 4, q + 4 + (a + 1) % 4, q + 4 + a) for a in range(4)]
        f += [(0, 1, 2, 3), (4 * n, 4 * n + 1, 4 * n + 2, 4 * n + 3)]
        bm = new_bm(v, f, mat='chrome'); orient(bm, ('out', (sx * (P['xr'][1] - 0.03), max(P['roof']) + 0.01, (za + zb_) / 2)))
        out.append(to_obj(bm, 'rail', 0.5))
    # In the rear bumper: reversing lamps and reflectors, which the real car needs because its lamps ride on the gate.
    Tr, Br = P['bumper_top'][1], P['bumper_bot'][1]
    for sx in (1, -1):
        I('rev', (sx * 0.5, lerp(Br, Tr, 0.4), -(P['tail'] - 0.012)), (0.2, 0.035, 0.012), 'lamp_rev', bevel=0.004)
        I('reflector', (sx * 0.5, lerp(Br, Tr, 0.27), -(P['tail'] - 0.014)), (0.2, 0.022, 0.012), 'lamp_tail', bevel=0.004)
    # The charge port: a flap on the driver's front wing, between the arch and the door.
    zc, yc = 1.0, P['belt'] - 0.215
    x = max(s.xat(zc, yc - 0.07), s.xat(zc, yc + 0.07))
    I('port_gap', (x - 0.004, yc, zc), (0.012, 0.165, 0.185), 'trim', 0.01, bevel=0.004)
    I('port', (x - 0.002, yc, zc), (0.012, 0.15, 0.17), 'paint', bevel=0.004)
    # The rear seat, which the shared interior would put under the tailgate glass on a body this cab-forward.
    seat = (0.075, 0.062, 0.05); xs = 2 * (hw - 0.107); e = min(P['belt'] - 0.935, sill - 0.17 + 0.12)
    I('bench', (0, 0.44 + e, -0.62), (xs - 0.26, 0.16, 0.5), 'seat', seat, bevel=0.04)
    I('benchback', (0, 0.76 + e, -0.92), (xs - 0.26, 0.58, 0.13), 'seat', seat, bevel=0.04, pitch=radians(18))
    I('shelf', (0, P['belt'] + 0.02, -1.38), (xs - 0.2, 0.04, 0.72), 'interior', 0.03)
    return out


def d_cmax(s, lod):
    """2015 Ford C-Max: the parts only this car has, placed from the owner's measured model (see VEHICLES['cmax'])."""
    P = s.P; out = []; I = _I(out); bv = 0 if lod else 1; hw = s.hw
    BAR = 0.085      # satin dark grey: as chrome the five bars mirrored the sky in coloured stripes

    def flank(name, zs_, lo, hi_, mat, tint=None, off=0.007, ny=2):
        # A patch on each side of the body: columns at the stations zs_, each from lo(z) up to hi_(z), every vertex
        # dropped onto the skin along x (as Car.panel does along z for the nose and tail).
        for sx in (1, -1):
            v = []; f = []
            for z in zs_:
                for j in range(ny + 1):
                    y = lerp(lo(z), hi_(z), j / ny)
                    hit = s.skin.ray_cast(B(2.0, y, z), B(-1, 0, 0), 3.0) if s.skin else (None,)
                    x = (hit[0].x if hit[0] is not None else s.xat(z, y)) + off
                    v.append((sx * x, y, z))
            for i in range(len(zs_) - 1):
                for j in range(ny):
                    a = i * (ny + 1) + j; f.append((a, a + ny + 1, a + ny + 2, a + 1))
            bm = new_bm(v, f, mat=mat); bm.normal_update()
            for q in bm.faces:
                if q.normal.dot(B(sx, 0, 0)) < 0: q.normal_flip()
            bm.normal_update(); out.append(to_obj(bm, name, tint))

    # The roof spoiler: the roof runs on 17 cm past the tailgate glass, with the stop lamp in its edge (chmsl).
    I('spoiler', (0, P['roof'][3] - 0.014, P['rhead'] - 0.085), (2 * P['xr'][2] + 0.02, 0.03, 0.17), 'paint', bevel=0.01 * bv, pitch=radians(-9))
    # Tail lamps. Across the tail they are cells of the end plate; along the flank the lens runs forward to a point
    # at X 3.83, which the cage cannot draw (its rows there follow the window line up the pillar), so it is laid on.
    zt = [-1.60, -1.80, -1.975] if lod else [-1.60, -1.70, -1.80, -1.87, -1.93, -1.975, -2.0]
    flank('tail_side', zt, lambda z: lerp(1.035, 0.945, smooth((-1.60 - z) / 0.34)), lambda z: lerp(1.07, 1.135, smooth((-1.60 - z) / 0.28)),
          'lamp_tail', off=0.008 if lod else 0.007)
    # The face: one big six-sided mouth low in the bumper, widest a third of the way down and narrowing to the lip.
    mouth = lambda y: (0.55 - 0.10 * ((y - 0.51) / 0.065) ** 2) if y > 0.51 else 0.55 - 0.19 * ((0.51 - y) / 0.23) ** 1.3
    out.append(s.panel('mouth', [0.575, 0.51, 0.40, 0.28] if lod else [0.575, 0.56, 0.535, 0.51, 0.45, 0.40, 0.35, 0.31, 0.28],
                       mouth, 'grille', 0.012, nx=4 if lod else 8, off=0.006 if lod else 0.004))
    if lod: return out
    # Five satin bars across it.
    for yb_ in (0.535, 0.478, 0.421, 0.364, 0.312):
        out.append(s.panel('bar', [yb_ + 0.009, yb_ - 0.009], lambda y: mouth(y) - 0.022, 'trim', BAR, off=0.011))
    # The slim slot between the head lamps, a bright bar in it, and a blank oval on the bonnet's lip above (no badge).
    slot = lambda y: 0.365 + 0.6 * (y - 0.694)
    out.append(s.panel('slot', [0.73, 0.712, 0.694], slot, 'trim', 0.006, off=0.004))
    out.append(s.panel('slot_bar', [0.718, 0.706], lambda y: slot(y) - 0.02, 'chrome', None, off=0.008))
    yo = 0.776; zo = s.wrap([(0, yo)], 1, 0.002)[0][2]
    for nm, r0, r1, d, m_, t_ in (('oval', 0, 0.023, 0.006, 'gloss', (0.004, 0.012, 0.07)), ('oval_ring', 0.0205, 0.0255, 0.009, 'chrome', None)):
        o = ring(nm, (0, yo, zo), r0, r1, d, 'z', m_, t_, segs=20)
        for v_ in o.data.vertices: v_.co.x *= 2.45
        out.append(o)
    # No fog lamps on an SE: a blank black bezel low at each corner of the bumper.
    for sx in (1, -1):
        out.append(s.panel('fog_blank', [0.435, 0.40, 0.36, 0.335], lambda y: 0.075 - 0.25 * (0.435 - y), 'trim', 0.014, nx=3, off=0.005,
                           xc=lambda y, sx=sx: sx * (0.665 - 0.2 * (0.435 - y))))
        # The tail lamp's inner end rides on the tailgate: the reversing lamp. And a reflector low in the bumper.
        # (above it the indicator, behind a red lens.)
        out.append(s.panel('ind_r', [1.125, 1.07, 1.0], 0.058, 'lamp_ind', (0.5, 0.04, 0.012), end=-1, nx=2, off=0.006, xc=lambda y, sx=sx: sx * 0.487))
        out.append(s.panel('rev', [1.0, 0.975, 0.95], lambda y: 0.058 - 0.3 * (1.0 - y), 'lamp_rev', None, end=-1, nx=2, off=0.006,
                           xc=lambda y, sx=sx: sx * (0.487 + 0.3 * (1.0 - y))))
        Tr, Br = P['bumper_top'][1], P['bumper_bot'][1]
        out.append(s.panel('reflector', [lerp(Br, Tr, 0.44), lerp(Br, Tr, 0.36)], 0.085, 'lamp_tail', None, end=-1, nx=2, off=0.005,
                           xc=lambda y, sx=sx: sx * 0.60))
    I('wiper_r', (0.11, P['deck'] + 0.075, P['deckf'] + 0.0), (0.30, 0.012, 0.018), 'trim', 0.01)
    if s.hi:
        # The owner's own car: a rust chip on the left front wing, a hand above the arch's lip behind the wheel (the
        # dent at the left rear corner is 'dents' in the table). A ragged brown patch 5 cm long, dark in its middle.
        zc, yc = 1.035, 0.665
        for nm, k_, tint_, off_ in (('rust_chip', 1.0, (0.16, 0.062, 0.026), 0.0025), ('rust_pit', 0.45, (0.045, 0.02, 0.012), 0.0035)):
            v = []
            for a_, r_ in ((0, 0), (0.2, 0.027), (1.25, 0.015), (2.1, 0.019), (3.0, 0.03), (4.0, 0.013), (5.1, 0.018)):
                dz, dy = k_ * r_ * cos(a_), k_ * r_ * sin(a_)
                hit = s.skin.ray_cast(B(2.0, yc + dy, zc + dz), B(-1, 0, 0), 3.0) if s.skin else (None,)
                v.append(((hit[0].x if hit[0] is not None else s.xat(zc + dz, yc + dy)) + off_, yc + dy, zc + dz))
            bm = new_bm(v, [(0, i, i % 6 + 1) for i in range(1, 7)], mat='trim'); bm.normal_update()
            for q in bm.faces:
                if q.normal.dot(B(1, 0, 0)) < 0: q.normal_flip()
            bm.normal_update(); out.append(to_obj(bm, nm, tint_))
    # The aerial: a short black mast raked back off the rear of the roof.
    I('aerial_base', (0, 1.545, -1.556), (0.045, 0.022, 0.07), 'trim', 0.02, bevel=0.007)
    I('aerial', (0, 1.668, -1.642), (0.007, 0.30, 0.007), 'trim', 0.02, pitch=radians(-35))
    # The rear seat and the load cover, which the shared interior would put under the tailgate glass on a body this tall.
    seat = P['seat']; xs = 2 * (hw - 0.107); e = P['seat_e']
    I('bench', (0, 0.44 + e, -0.70), (xs - 0.26, 0.16, 0.5), 'seat', seat, bevel=0.04)
    I('benchback', (0, 0.76 + e, -1.0), (xs - 0.26, 0.58, 0.13), 'seat', seat, bevel=0.04, pitch=radians(18))
    I('shelf', (0, 1.0, -1.47), (xs - 0.2, 0.04, 0.78), 'interior', 0.03)
    # The door linings above the cabin's tub, which stops at the bonnet's height while the window line climbs 30 cm.
    for sx in (1, -1): I('liner', (sx * (xs / 2 - 0.006), 1.02, -0.48), (0.012, 0.2, 2.5), 'interior', 0.02, pitch=radians(6))
    return out


DETAIL = {'cmax': d_cmax, 'bolt': d_bolt, 'hatch': d_hatch, 'coupe': d_coupe, 'muscle': d_muscle, 'sports': d_sports, 'pickup': d_pickup, 'van': d_van,
          'taxi': d_taxi, 'cruiser': d_cruiser, 'tow': d_tow, 'bus': d_bus}


# ── Preview stills ───────────────────────────────────────────────────────────

def sheet(kind, names):
    """Tile the stills 2 x 2 into one <kind>_sheet.jpg: the whole car at a glance."""
    import numpy as np
    d = os.path.join(ROOT, 'shots', 'blender'); cells = []
    for n in names:
        im = bpy.data.images.load(os.path.join(d, f'{kind}_{n}.png'))
        w, h = im.size; a = np.empty(w * h * 4, dtype=np.float32); im.pixels.foreach_get(a)
        cells.append(a.reshape(h, w, 4)); bpy.data.images.remove(im)
    out = np.concatenate([np.concatenate(cells[3:6], axis=1), np.concatenate(cells[0:3], axis=1)], axis=0)
    h, w, _ = out.shape
    im = bpy.data.images.new('sheet', w, h, alpha=False)
    im.pixels.foreach_set(out.ravel())
    im.filepath_raw = os.path.join(d, f'{kind}_sheet.jpg'); im.file_format = 'JPEG'; im.save()
    bpy.data.images.remove(im)


def render(kind, P, sets, extra=False):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1100, 620
    try:
        sc.eevee.taa_render_samples = 32; sc.eevee.use_raytracing = True
    except Exception:
        pass
    w = bpy.data.worlds.new('w'); sc.world = w
    try: w.use_nodes = True
    except Exception: pass
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == 'BACKGROUND')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sx = nt.nodes.new('ShaderNodeSeparateXYZ'); mp = nt.nodes.new('ShaderNodeMapRange')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    mp.inputs[1].default_value = -1; mp.inputs[2].default_value = 1
    nt.links.new(tc.outputs['Generated'], sx.inputs[0]); nt.links.new(sx.outputs['Z'], mp.inputs[0])
    nt.links.new(mp.outputs[0], ramp.inputs[0]); nt.links.new(ramp.outputs[0], bg.inputs['Color'])
    e = ramp.color_ramp.elements
    e[0].position = 0.0; e[0].color = (0.12, 0.12, 0.12, 1); e[1].position = 1.0; e[1].color = (0.18, 0.38, 0.8, 1)
    for pos, c in ((0.49, (0.25, 0.25, 0.25, 1)), (0.51, (0.9, 0.92, 0.95, 1)), (0.62, (0.45, 0.65, 0.9, 1))):
        el = e.new(pos); el.color = c
    sun = bpy.data.lights.new('sun', 'SUN'); sun.energy = 4.0; sun.angle = radians(2)
    so = bpy.data.objects.new('sun', sun); sc.collection.objects.link(so); so.rotation_euler = (radians(50), 0, radians(35))
    gm = bpy.data.materials.new('ground')
    try: gm.use_nodes = True
    except Exception: pass
    gb = next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    gb.inputs['Base Color'].default_value = (0.09, 0.09, 0.095, 1); gb.inputs['Roughness'].default_value = 0.8
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    gme = bpy.data.meshes.new('ground'); bm.to_mesh(gme); bm.free(); gme.materials.append(gm)
    sc.collection.objects.link(bpy.data.objects.new('ground', gme))
    # The sedan's camera, pushed back in proportion for anything longer or taller.
    k = max(0.9, (P['nose'] + P['tail']) / 4.7, P['H'] / 1.85)
    tgt = bpy.data.objects.new('tgt', None); sc.collection.objects.link(tgt); tgt.location = B(0, 0.43 * max(P['H'], 1.3), 0)
    cam = bpy.data.cameras.new('cam'); cam.lens = 45
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    c = co.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    views = {'front34': (3.4, 1.35, 5.2), 'rear34': (-3.3, 1.5, -5.4), 'side': (7.6, 1.0, 0.0)}
    if extra: views.update({'top': (2.2, 5.5, 2.5), 'low': (2.2, 0.5, 4.2)})
    os.makedirs(os.path.join(ROOT, 'shots', 'blender'), exist_ok=True)
    hw = P['W'] / 2; zF = P['wb'] / 2
    close = {'cabin': ((0.35, P['H'] + 0.75, P['cowl'] + 1.5), (0.2, P['belt'] - 0.1, P['cowl'] - 0.9)),
             'wheel': ((hw + 1.0, P['R'] + 0.25, zF + 0.75), (hw - 0.1, P['R'], zF))}
    for lod, (body, wheel) in enumerate(sets):
        insts = []
        for sxn in (1, -1):
            for z in (P['wb'] / 2, -P['wb'] / 2):
                o = bpy.data.objects.new('pv', wheel.data); sc.collection.objects.link(o)
                o.location = B(sxn * P['track'] / 2, P['R'], z)
                if sxn < 0: o.rotation_euler = (0, 0, pi)
                insts.append(o)
        for b2, w2 in sets:
            b2.hide_render = b2 is not body; w2.hide_render = True
        for name, pos in list(views.items()) + list(close.items()):
            if lod == 1 or (lod and name != 'front34'): continue
            if name in close:
                co.location = B(*pos[0]); tgt.location = B(*pos[1])
            else:
                co.location = B(pos[0] * k, pos[1] * max(1.0, P['H'] / 1.45 * 0.85), pos[2] * k); tgt.location = B(0, 0.43 * max(P['H'], 1.3), 0)
            sc.render.filepath = os.path.join(ROOT, 'shots', 'blender', f'{kind}_{name}{"_lod2" if lod else ""}.png')
            bpy.ops.render.render(write_still=True)
        for o in insts: bpy.data.objects.remove(o)
    try:
        sheet(kind, ['front34', 'rear34', 'side', 'cabin', 'wheel', 'front34_lod2'])
    except Exception as ex:
        print('SHEET FAILED', ex)


# ── Build one vehicle ────────────────────────────────────────────────────────

def _ctx():
    """Blender runs with its window showing, and there operators (join, bake, unwrap) poll false from a start-up
    script unless they are told which window and 3D view they are in. Without a window this overrides nothing."""
    kw = {}; wm = bpy.context.window_manager
    win = wm.windows[0] if wm and len(wm.windows) else None
    if win:
        kw['window'] = win; kw['screen'] = win.screen
        area = next((a for a in win.screen.areas if a.type == 'VIEW_3D'), None)
        if area:
            kw['area'] = area
            reg = next((r for r in area.regions if r.type == 'WINDOW'), None)
            if reg: kw['region'] = reg
    return bpy.context.temp_override(**kw)


def build(kind, *a):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with _ctx(): _build(kind, *a)


def _build(kind, do_render=True, do_export=True, extra=False, do_tex=True):
    P = VEHICLES[kind]
    make_materials(P['paint'], P.get('look'))
    if do_tex: relief(P)
    car = Car(P); car.kind = kind; sets = []; stats = {}
    # Three levels: 0 the showroom car (everything), 1 the street car (the same recipe without the hi-only parts),
    # 2 the unsubdivided cage for distance and for phones. The functions below still take the old two-way flag.
    for level in (0, 1, 2):
        lod = 1 if level == 2 else 0; car.hi = level == 0
        parts = [car.shell(lod), car.bumper(1, lod), car.bumper(-1, lod)]
        # The skin, for anything that has to lie on it (Car.wrap).
        V = []; F = []
        for ob in parts:
            n = len(V); V += [v.co.copy() for v in ob.data.vertices]; F += [[n + i for i in q.vertices] for q in ob.data.polygons]
        car.skin = BVHTree.FromPolygons(V, F)
        parts += car.underbody(lod) + car.fittings(lod)
        if kind in DETAIL: parts += DETAIL[kind](car, lod)
        if lod == 0: parts += car.interior()
        if lod == 0 and car.covers: parts.append(car.cover_obj())
        body = join(parts, f'LOD{level}')
        wheel = car.wheel(lod); wheel.name = wheel.data.name = f'WHEEL{level}'
        M = []
        for sx in (1, -1):
            for z in (P['wb'] / 2, -P['wb'] / 2):
                M.append((wheel.data, Matrix.Translation(B(sx * P['track'] / 2, P['R'], z)) @ (Matrix.Rotation(pi, 4, 'Z') if sx < 0 else Matrix.Identity(4))))
        # The two near levels get their occlusion from a baked map (bake_maps), the far one keeps it in its vertices.
        bake(body, M, rays=level == 2 or not do_tex)
        bake(wheel, ground=False, reach=0.25, floor=0.5)
        shade(body, keep=bool(P.get('crease_full'))); shade(wheel, 40)
        if do_tex and level < 2: wheel_uv(wheel, P, car)
        sets.append((body, wheel))
        if level == 0:
            # A shard check: skin (paint, glass, gloss) has no business above the roof or beyond the mirrors.
            bad = []
            for q in body.data.polygons:
                if MATS[q.material_index] in ('paint', 'glass', 'gloss'):
                    for vi in q.vertices:
                        c = body.data.vertices[vi].co
                        if c.z > max(P['roof']) + 0.06 or abs(c.x) > P['W'] / 2 + 0.26:
                            bad.append((MATS[q.material_index], round(c.x, 2), round(c.z, 2), round(-c.y, 2))); break
            stats['shards'] = [len(bad)] + bad[:6]
        stats[f'LOD{level}'] = tris(body); stats[f'WHEEL{level}'] = tris(wheel)
    if do_tex:
        stats['uv'] = unwrap([sets[0][0], sets[1][0]], P['sill'], P.get('uvw'))
        if do_export: stats['tex'] = bake_maps(kind, sets, P)
    marks = []
    hd = car.lamp_c.get(1, {}).get('lamp_head'); tl = car.lamp_c.get(-1, {}); tl = tl.get('lamp_brake') or tl.get('lamp_tail')
    for nm, q in (('HEAD', hd), ('TAIL', tl)):
        for side, sx in (('L', 1), ('R', -1)):
            if q:
                o = bpy.data.objects.new(f'{nm}_{side}', None); o.location = B(sx * q[0], q[1], q[2])
                bpy.context.scene.collection.objects.link(o); marks.append(o)
    lo = [min(v.co[i] for v in sets[0][0].data.vertices) for i in range(3)]
    hi = [max(v.co[i] for v in sets[0][0].data.vertices) for i in range(3)]
    stats['WLH'] = [round(hi[0] - lo[0], 2), round(hi[1] - lo[1], 2), round(hi[2], 2)]
    if do_export:
        out = MODELS; os.makedirs(out, exist_ok=True)
        path = os.path.join(out, kind + '.glb')
        bpy.ops.object.select_all(action='DESELECT')
        for b, w in sets: b.select_set(True); w.select_set(True)
        for o in marks: o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                                  export_texcoords=do_tex, export_normals=True, export_tangents=False, export_materials='EXPORT',
                                  export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                                  export_active_vertex_color_when_no_material=True, export_animations=False,
                                  export_skins=False, export_morph=False, export_extras=False)
        stats['kB'] = round(os.path.getsize(path) / 1000)
        import struct
        with open(path, 'rb') as fh:
            fh.seek(12); n, _ = struct.unpack('<II', fh.read(8)); g = json.loads(fh.read(n))
        stats['nodes'] = sorted(x['name'] for x in g['nodes']); stats['mats'] = len(g['materials'])
        stats['verts'] = sum(g['accessors'][p['attributes']['POSITION']]['count'] for m in g['meshes'] for p in m['primitives'])
    print('STATS ' + json.dumps({kind: stats}))
    if do_render: render(kind, P, sets, extra)


def pack_far():
    """public/models/cars_far.glb: every kind's far level (its last LODn, the wheel that goes with it and the lamp
    marks), lifted byte for byte out of that kind's own <kind>.glb and named <kind>_LOD2, <kind>_WHEEL2,
    <kind>_HEAD_L and so on. Phones draw only the far level, so this one small file is all they fetch; the other
    presets show it until a kind's full file has arrived (src/ent/vehicleAssets.ts). Nothing is rebuilt and the full
    files are only read, so the two cannot differ in shape. It runs after every export; `-- --far` runs it alone."""
    import struct
    out = {'asset': {'version': '2.0', 'generator': 'tools/blender/cars.py pack_far'}, 'scene': 0,
           'scenes': [{'name': 'Scene', 'nodes': []}], 'nodes': [], 'meshes': [], 'materials': [], 'accessors': [],
           'bufferViews': [], 'buffers': [{}]}
    blob = bytearray(); ext = set(); mat_at = {}; stats = {}
    for kind in VEHICLES:
        path = os.path.join(MODELS, kind + '.glb')
        if not os.path.exists(path): continue
        with open(path, 'rb') as fh: data = fh.read()
        n = struct.unpack_from('<I', data, 12)[0]; g = json.loads(data[20:20 + n]); b0 = 20 + n + 8
        at = {x.get('name', ''): i for i, x in enumerate(g['nodes'])}
        lods = [i for i in range(3) if f'LOD{i}' in at]
        if not lods: continue
        keep = [f'LOD{lods[-1]}'] + [w for w in (f'WHEEL{i}' for i in range(lods[-1], -1, -1)) if w in at][:1]
        keep += sorted(k for k, i in at.items() if 'mesh' not in g['nodes'][i] and k.split('_')[0] in ('HEAD', 'TAIL', 'SEAT', 'BEACON'))
        views = {}; accs = {}; before = len(blob)

        def view(i):
            if i not in views:
                v = g['bufferViews'][i]; s = b0 + v.get('byteOffset', 0)
                while len(blob) % 4: blob.append(0)
                nv = {k: x for k, x in v.items() if k not in ('buffer', 'byteOffset')}
                nv['buffer'] = 0; nv['byteOffset'] = len(blob)
                blob.extend(data[s:s + v['byteLength']])
                views[i] = len(out['bufferViews']); out['bufferViews'].append(nv)
            return views[i]

        def acc(i):
            if i not in accs:
                a = dict(g['accessors'][i]); a['bufferView'] = view(a['bufferView'])
                accs[i] = len(out['accessors']); out['accessors'].append(a)
            return accs[i]

        def mat(i):
            m = g['materials'][i]; key = json.dumps(m, sort_keys=True)
            if key not in mat_at:
                mat_at[key] = len(out['materials']); out['materials'].append(m); ext.update(m.get('extensions', {}))
            return mat_at[key]

        for name in keep:
            src = g['nodes'][at[name]]
            node = {k: x for k, x in src.items() if k in ('translation', 'rotation', 'scale', 'matrix')}
            node['name'] = f'{kind}_{name}'
            if 'mesh' in src:
                prims = []
                for p in g['meshes'][src['mesh']]['primitives']:
                    q = {'attributes': {k: acc(i) for k, i in p['attributes'].items()}}
                    if 'indices' in p: q['indices'] = acc(p['indices'])
                    if 'material' in p: q['material'] = mat(p['material'])
                    if 'mode' in p: q['mode'] = p['mode']
                    prims.append(q)
                node['mesh'] = len(out['meshes']); out['meshes'].append({'name': f'{kind}_{name}', 'primitives': prims})
            out['scenes'][0]['nodes'].append(len(out['nodes'])); out['nodes'].append(node)
        stats[kind] = [keep[0], keep[1] if len(keep) > 1 else None, len(blob) - before]
    while len(blob) % 4: blob.append(0)
    out['buffers'][0]['byteLength'] = len(blob)
    if ext: out['extensionsUsed'] = sorted(ext)
    js = json.dumps(out, separators=(',', ':')).encode('utf-8')
    js += b' ' * (-len(js) % 4)
    path = os.path.join(MODELS, 'cars_far.glb')
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        fh.write(struct.pack('<II', len(js), 0x4E4F534A)); fh.write(js)
        fh.write(struct.pack('<II', len(blob), 0x004E4942)); fh.write(bytes(blob))
    print('STATS ' + json.dumps({'cars_far': {'kB': round(os.path.getsize(path) / 1000), 'kinds': stats, 'mats': len(out['materials'])}}))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--wheel-tex' in argv:
        # As build(): reset first, then run inside the window and 3D-view override the bake needs.
        bpy.ops.wm.read_factory_settings(use_empty=True)
        with _ctx(): wheel_texture()
        sys.exit(0)
    kinds = [a for a in argv if not a.startswith('--')] or list(VEHICLES)
    for a in argv:
        if a.startswith('--paint='):
            for k in kinds: VEHICLES[k] = dict(VEHICLES[k], paint=tuple(float(x) for x in a[8:].split(',')))
    # `-- --far` builds nothing: it only gathers the far levels of the files already in public/models.
    for k in ([] if '--far' in argv else kinds):
        try:
            build(k, '--no-render' not in argv, '--no-export' not in argv, '--all-views' in argv, '--no-tex' not in argv)
        except Exception:
            import traceback
            print('FAILED ' + k); traceback.print_exc()
    # The far levels as one file, always from what is on disk now, so it cannot fall out of step with the full files.
    if '--no-export' not in argv:
        try:
            pack_far()
        except Exception:
            import traceback
            print('FAILED cars_far'); traceback.print_exc()
