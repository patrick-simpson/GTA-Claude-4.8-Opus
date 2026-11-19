# Port Calamity's cars, modelled in Blender by script and exported as .glb.
#
#   blender --background --factory-startup --python tools/blender/cars.py -- sedan [--no-render] [--no-export]
#
# Writes public/models/<kind>.glb and preview stills in shots/blender/<kind>_*.png.
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
#   * All twelve vehicles are the sedan's table with overrides (VEHICLES) plus
#     a d_<kind>() of the parts only that vehicle has: bed, boom, wing, sign.
#     Run with no kind to build them all; <kind>_sheet.jpg tiles the stills.
#   * 'bolt' is the one real car (a 2017 Chevrolet Bolt EV, at the owner's request). --paint=r,g,b overrides the
#     preview colour for a run: a black car hides its own shape in a still.
# The file holds four meshes: LOD0, LOD1, WHEEL0, WHEEL1. Material names are
# the contract with src/ent/vehicleGlb.ts. Paint is always the per-instance
# colour; anything that must stay its own colour (taxi checker, cruiser door
# panel, light bars, the bus's sign) is baked into the vertex colours of
# trim / lamp_head / lamp_tail.

import bpy, bmesh, sys, os, json
from math import sin, cos, pi, radians, sqrt, hypot, asin, exp
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
MATS = ['paint', 'trim', 'chrome', 'glass', 'lamp_head', 'lamp_tail', 'interior', 'tire', 'rim']
TMP = ['tmp_grille', 'tmp_sideglass', 'tmp_amber', 'tmp_white']
REMAP = {'tmp_grille': 'trim', 'tmp_sideglass': 'glass', 'tmp_amber': 'lamp_head', 'tmp_white': 'trim'}
MI = {n: i for i, n in enumerate(MATS + TMP)}
# Linear albedo baked into the vertex colours (times occlusion).
TINT = {'paint': 1.0, 'trim': 0.022, 'chrome': 0.9, 'glass': 1.0, 'lamp_head': (0.95, 0.95, 0.9),
        'lamp_tail': (0.6, 0.015, 0.012), 'interior': 0.03, 'tire': 0.014, 'rim': 0.72,
        'tmp_grille': 0.022, 'tmp_sideglass': 1.0, 'tmp_amber': (1.0, 0.42, 0.04), 'tmp_white': 0.8}

# End plates are a 5 x 3 grid of cells: a = 0 (the corner sliver) .. 4 (the centre), b = 0 (bottom) .. 2 (top band).
H_, G_, A_, T_ = 'lamp_head', 'tmp_grille', 'tmp_amber', 'lamp_tail'
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
        bumper_pm=PLAIN, plate_r_y=0.42, paint=(0.25, 0.32, 0.15)),
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
        rear={(1, 2): T_, (2, 2): T_, (3, 2): T_}, exhausts=(-0.55, 0.55), hood_crown=0.035, flare=0.02, paint=(0.105, 0.042, 0.068)),
    # Cormorant RS: cab-forward mid-engine wedge.
    'sports': dict(SEDAN, W=1.95, H=1.18, wb=2.6, track=1.66, R=0.34, tw=0.30, nose=2.30, tail=2.05, sill=0.13, arch_gap=0.04,
        zs=1.3, n_front=3.0, n_rear=5, cowl=1.05, header=0.30, b1=-0.25, b2=-0.31, mid=-0.40, rhead=-0.62, deckf=-1.45,
        hood_cowl=0.88, hood_nose=0.56, hood_crown=-0.035, belt=0.86, deck=0.97, deck_tail=0.96, xr=(0.52, 0.55, 0.53),
        roof=(1.15, 1.18, 1.17, 1.12), bow=(0.16, 0.11, -0.06, -0.08), bumper_top=(0.38, 0.66), bumper_bot=(0.12, 0.26),
        lift=(0.14, 0.24), doors=[(0.85, 4), (-0.31, 4)], cq=0, ends=(None, (0.5, 0.78)),
        front={(1, 2): H_, (2, 2): H_}, bench=False, seat_e=-0.16, rub=False, exhausts=(-0.12, 0.12), bumper_pm=PLAIN,
        shd=0.06, flare=0.02, spokes=7, paint=(0.78, 0.095, 0.027)),
    # Dockhand: single cab, open bed.
    'pickup': dict(SEDAN, W=1.95, H=1.85, wb=3.3, track=1.66, R=0.40, tw=0.27, nose=2.60, tail=2.70, sill=0.36, arch_gap=0.07,
        zs=1.9, n_front=7, n_rear=7, cowl=1.02, header=0.52, b1=-0.38, b2=-0.45, mid=-0.52, rhead=-0.60, deckf=-0.70,
        hood_cowl=1.26, hood_nose=1.14, belt=1.24, deck=1.20, deck_tail=1.20, xr=(0.68, 0.70, 0.70),
        roof=(1.80, 1.85, 1.85, 1.83), bow=(0.10, 0.07, -0.02, -0.02), bumper_top=(0.74, 0.72), bumper_bot=(0.42, 0.46),
        lift=(0.40, 0.48), doors=[(1.02, 4), (-0.45, 4)], cq=0, bed=(-0.82, -2.50, 0.74), trunk=False, rear=VERT, bench=False,
        rub=False, rr=0.6, spokes=6, bumper_pm=CHROME, tuck=0.014, mirror=1.5, plate_r_y=0.59, paint=(0.33, 0.068, 0.045)),
    # Breadbox: one tall box, cab over the front wheels.
    'van': dict(SEDAN, W=2.0, H=2.3, wb=3.2, track=1.7, R=0.36, tw=0.24, nose=2.52, tail=2.68, sill=0.30, arch_gap=0.06,
        zs=2.0, n_front=5, n_rear=8, cowl=1.80, header=1.15, b1=0.42, b2=0.35, mid=-0.85, rhead=-2.40, deckf=-2.47,
        hood_cowl=1.22, hood_nose=1.00, belt=1.22, deck=1.18, deck_tail=1.17, xr=(0.80, 0.84, 0.84),
        roof=(2.22, 2.30, 2.30, 2.27), bow=(0.10, 0.07, -0.01, -0.01), bumper_top=(0.62, 0.56), bumper_bot=(0.30, 0.32),
        lift=(0.32, 0.36), doors=[(1.80, 4), (0.35, 5), (-0.85, 5)], cq=0, sg_end=0.42, pillars=[], xc=0.06, split=True,
        trunk=False, rear=VERT, bench=False, rub=False, rr=0.6, handles=[0.52, 0.20], rake=0.015, tuck=0.012, mirror=1.6,
        bumper_pm=BLACK, plate_r_y=0.44, paint=(0.89, 0.80, 0.62)),
    # Calamity Cab: the sedan, a little longer, with a sign and a checker band.
    'taxi': dict(SEDAN, H=1.5, wb=2.85, nose=2.35, tail=2.45, roof=(1.385, 1.412, 1.41, 1.375), paint=(0.87, 0.36, 0.0)),
    # Mule Wrecker: conventional truck cab, flat deck, boom.
    'tow': dict(SEDAN, W=2.2, H=2.4, wb=3.8, track=1.84, R=0.46, tw=0.30, nose=2.90, tail=3.30, sill=0.50, arch_gap=0.07,
        zs=2.2, n_front=7, n_rear=7, cowl=1.25, header=0.78, b1=-0.05, b2=-0.12, mid=-0.20, rhead=-0.30, deckf=-0.42,
        hood_cowl=1.52, hood_nose=1.40, belt=1.50, deck=1.20, deck_tail=1.20, xr=(0.80, 0.82, 0.82),
        roof=(2.0, 2.05, 2.05, 2.03), bow=(0.10, 0.07, -0.02, -0.02), bumper_top=(0.86, 0.80), bumper_bot=(0.52, 0.55),
        lift=(0.54, 0.60), doors=[(1.25, 4), (-0.12, 4)], cq=0, trunk=False, rear={(1, 2): T_, (2, 2): T_}, bench=False,
        rub=False, rr=0.58, spokes=6, bumper_pm=CHROME, tuck=0.014, mirror=1.6, paint=(0.33, 0.068, 0.045)),
    # Harbor Line No. 7: a flat-fronted city bus, doors on the kerb side (-x).
    'bus': dict(SEDAN, W=2.5, H=3.1, wb=5.6, track=2.1, R=0.50, tw=0.32, nose=5.10, tail=5.40, sill=0.34, arch_gap=0.07,
        zs=3.5, n_front=10, n_rear=10, cowl=4.88, header=4.66, b1=4.0, b2=3.9, mid=-1.0, rhead=-5.0, deckf=-5.12,
        hood_cowl=1.42, hood_nose=1.40, belt=1.40, deck=1.42, deck_tail=1.42, xr=(1.10, 1.12, 1.12),
        roof=(2.86, 2.90, 2.90, 2.88), bow=(0.04, 0.03, -0.02, -0.02), bumper_top=(0.74, 0.76), bumper_bot=(0.40, 0.44),
        lift=(0.36, 0.42), doors=[], cq=0, trunk=False, bstart=(4.7, 4.95), ends=((0.80, 1.02), (0.90, 1.20)),
        pillars=[(3.62, 3.50), (2.15, 2.05), (0.75, 0.65), (-0.20, -0.30), (-1.52, -1.62), (-2.95, -3.05), (-4.25, -4.35)],
        front={(0, 1): A_, (1, 1): H_, (2, 1): H_}, rear={(1, 1): T_, (2, 1): T_}, shd=0.34, shc=0.3, tuck=0.01, rake=0.01,
        bench=False, rub=False, rr=0.56, spokes=8, bumper_pm=BLACK, mirror=2.0, handles=[],
        bus_doors=[(4.55, 3.66), (-0.33, -1.49)], seat_rows=[3.0 - 1.0 * i for i in range(8)], paint=(0.023, 0.34, 0.27)),
    # Harbor Patrol Interceptor: the sedan, wider and heavier, in uniform.
    'cruiser': dict(SEDAN, W=1.9, H=1.48, wb=2.9, track=1.6, R=0.34, tw=0.25, nose=2.32, tail=2.50,
        xr=(0.61, 0.635, 0.615), roof=(1.365, 1.392, 1.39, 1.355), white=(0.84, -0.90), rub=False, paint=(0.007, 0.015, 0.047)),
    # 2017 Chevrolet Bolt EV, the one real car: 4.17 x 1.77 x 1.60 m on a 2.60 m wheelbase. A tall one-box hatch: the
    # screen starts over the front axle and runs straight on from a short bonnet, the window line climbs through the
    # doors and kicks up behind the rear one into a black pillar (the floating roof), the lamps wrap both corners.
    'bolt': dict(SEDAN, W=1.77, H=1.60, wb=2.60, track=1.50, R=0.32, tw=0.215, nose=2.14, tail=2.03, sill=0.19, arch_gap=0.06,
        zs=1.35, n_front=3.1, n_rear=5.5, cowl=1.16, header=0.26, b1=-0.05, b2=-0.13, mid=-1.17, rhead=-1.55, deckf=-1.84,
        hood_cowl=1.05, hood_nose=0.83, hood_crown=0.02, belt=1.02, rise=(0.02, 0.06, 0.19), deck=1.17, deck_tail=1.14,
        xr=(0.56, 0.60, 0.585), roof=(1.50, 1.588, 1.592, 1.55), bow=(0.11, 0.08, -0.05, -0.05),
        bumper_top=(0.625, 0.74), bumper_bot=(0.20, 0.26), lift=(0.21, 0.28), ends=((0.38, 0.64), (0.60, 0.80)),
        doors=[(0.84, 4), (-0.13, 4), (-1.10, 4)], pillars=[(0.84, 0.78), (-0.05, -0.13), (-1.10, -1.17)], cq=-0.5,
        fq_glass=True, floating=True, sweep=(1.72, -1.72), mirror_z=0.80, slats=False, trunk=False, bench=False, rub=False,
        front={(0, 2): H_, (1, 2): H_, (2, 2): H_, (3, 2): G_, (4, 2): G_}, rear={(0, 2): T_, (1, 2): T_, (2, 2): T_},
        exhausts=(), bumper_pm=['paint'] * 4 + ['trim'] * 3, shd=0.085, flare=0.02, paint=(0.004, 0.004, 0.005)),
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

def make_materials(paint):
    look = {'paint': (paint, 0.6, 0.28, 1), 'trim': ((1, 1, 1), 0.0, 0.6, 1), 'chrome': ((1, 1, 1), 1.0, 0.08, 1),
            'glass': ((0.02, 0.03, 0.035), 0.0, 0.03, 0.45), 'lamp_head': ((1, 1, 1), 0.0, 0.08, 1),
            'lamp_tail': ((1, 1, 1), 0.0, 0.1, 1), 'interior': ((1, 1, 1), 0.0, 0.8, 1),
            'tire': ((1, 1, 1), 0.0, 0.85, 1), 'rim': ((1, 1, 1), 0.9, 0.25, 1)}
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
        flat += [t[0], t[1], t[2], 1.0] * p.loop_total
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


def box(name, c, s, mat, tint=None, bevel=0.0, pitch=0.0, drop=None, flip=False):
    v, f = boxv(c, s, pitch)
    if drop is not None: f = [q for i, q in enumerate(f) if i != drop]
    bm = new_bm(v, f, mat=mat)
    if bevel: bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=1, affect='EDGES', profile=0.5)
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


# ── The body shell ───────────────────────────────────────────────────────────

class Car:
    def __init__(s, P):
        s.P = P; s.g = P.get
        s.hw = P['W'] / 2 - 0.008
        s.zF, s.zR = P['wb'] / 2, -P['wb'] / 2
        s.arch_r = P['R'] + P['arch_gap']
        # One subdivision pulls a 30-degree control polygon in by this factor.
        s.Rc = s.arch_r / 0.9665
        s.zNf, s.zNr = P['nose'] - 0.05, P['tail'] - 0.05
        # Shut-lines across the side: (z, how many rows up from the sill the cut runs).
        s.doors = P.get('doors', [(P['cowl'], 4), (P['b2'], 4), (P['rhead'], 4)])
        s.pillars = P.get('pillars', [(P['b1'], P['b2'])])
        # The side glass runs past the rear header into the C-pillar by this share: the rear quarter light.
        s.cq = P['rhead'] - P.get('cq', 0.3) * (P['rhead'] - P['deckf'])
        s.sg_end = P.get('sg_end', s.cq)
        s.cells = {1: P.get('front', FRONT), -1: P.get('rear', REAR)}

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
        return [(w - 0.055, belt), (xr + 0.055, roof - 0.07), (xr, roof - 0.022), (s.g('xc', 0.34), roof - 0.005), (0.0, roof)]

    def top(s, z):
        """Rows 4-8 of the section at z, and how far its centre bows along z (screens are curved in plan)."""
        P = s.P; zc0 = s.corner_z(1); zc1 = s.corner_z(-1)
        if z >= P['cowl']:
            u = (z - P['cowl']) / (zc0 - P['cowl'])
            y = P['hood_cowl'] - (P['hood_cowl'] - P['hood_nose']) * min(1.0, u) ** 1.8
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
                return [(lerp(p[0], q[0], t), lerp(p[1], q[1], t)) for p, q in zip(a[1], b[1])], lerp(a[2], b[2], t)
        raise ValueError(z)

    def stations(s):
        P = s.P; c0, c1 = s.corner_z(1), s.corner_z(-1)
        keys = [P['cowl'], (P['cowl'] + P['header']) / 2, P['header'], P['b1'], P['b2'], P['mid'], P['rhead'],
                (P['rhead'] + P['deckf']) / 2, P['deckf'], s.cq, s.zF + s.Rc + 0.205, s.zR - s.Rc - 0.235]
        keys += [d[0] for d in s.doors] + [z for p in s.pillars for z in p] + list(s.g('bed', ())[:2])
        inside = lambda z: c1 + 0.045 < z < c0 - 0.045
        ks = []
        for z in keys:
            if inside(z) and all(abs(z - k) > 0.028 for k in ks): ks.append(z)
        arch = []
        for zc in (s.zF, s.zR):
            arch += [zc + s.Rc + 0.035, zc - s.Rc - 0.035] + [zc + s.Rc * cos(radians(a)) for a in range(0, 181, 30)]
        return sorted([c0, c1] + ks + [z for z in arch if inside(z) and all(abs(z - k) > 0.025 for k in ks)], reverse=True)

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
        y2 = lerp(max(sh - s.g('shd', 0.075), a + 0.03), e[1], te)
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
        rk = s.g('rake', 0.035)
        rake = lambda y: rk * (y - 0.2) / 0.5
        info = []
        for j, z in enumerate(st):
            rows, bow = s.top(z)
            end = 1 if j == 0 else -1 if j == NS - 1 else 0
            sd = s.side(z, rows[0][1] - 0.045, end)
            info.append((sd, rows))
            for k in range(9):
                x, y = sd[k] if k < 4 else rows[k - 4]
                zz = z + bow * CW[k - 4] if k >= 4 else z
                if end and k >= 4: zz = s.zplan(x, end) - end * rake(y)
                idx[j][k] = len(verts); verts.append((x, y, zz))
        zmid = lambda j: (st[j] + st[j + 1]) / 2
        mscr = (P['cowl'] + P['header']) / 2
        bed = s.g('bed'); white = s.g('white'); sweep = s.g('sweep'); rear_ks = (6,) if s.g('split') else (6, 7)

        def fmat(j, k):
            z = zmid(j)
            if k == 4:
                if P['cowl'] > z > mscr and not s.g('fq_glass'): return 'trim'
                if P['cowl'] > z > s.sg_end: return 'trim' if any(a > z > b for a, b in s.pillars) else 'tmp_sideglass'
            # The floating roof: the pillar behind the side glass is black from the belt to the roof and round to the rear screen.
            if s.g('floating') and ((k == 4 and s.sg_end > z > P['deckf']) or (k == 5 and P['rhead'] > z > P['deckf'])): return 'trim'
            # Lamps that sweep back along the wings from the end plates.
            if sweep and k in (2, 3) and z > sweep[0]: return 'lamp_head'
            if sweep and k in (2, 3) and z < sweep[1]: return 'lamp_tail'
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
                    G[a, b] = len(verts); verts.append((x, y, s.zplan(x, end) - end * rake(y)))
            for b in range(3):
                for a in range(5):
                    faces.append((G[a, b], G[a + 1, b], G[a + 1, b + 1], G[a, b + 1])); fm.append(cells.get((a, b), 'paint'))
            faces.append((G[0, 3], G[1, 3], idx[j][4])); fm.append('paint')
            for a in range(1, 5):
                faces.append((G[a, 3], G[a + 1, 3], idx[j][4 + a], idx[j][3 + a])); fm.append('paint')
            gx = rows[2][0] if cells.get((3, 2)) == G_ else rows[3][0]
            plates[end] = (sd[2][1], sd[3][1], s.zplan(0, end) - end * rake((sd[2][1] + sd[3][1]) / 2), gx)
            Gs[end] = G
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
        for j, c in ((jc, 0.8), (jd, 0.8), (jh, 0.4), (jr, 0.4)):
            for k in range(5, 8): crease(idx[j][k], idx[j][k + 1], c)
        between = lambda z: s.zR + s.Rc + 0.02 < z < s.zF - s.Rc - 0.02
        for j in range(NS - 1):
            crease(idx[j][3], idx[j + 1][3], 0.25)
            # The shoulder crease lives between the arches; beyond them the row dives to the lamps, uncreased.
            if between(st[j]) and between(st[j + 1]): crease(idx[j][2], idx[j + 1][2], s.g('shc', 0.6))
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

        def inset(mi, thick, ring, push=0.0):
            fs = [f for f in bm.faces if f.material_index == MI[mi]]
            if not fs: return
            r = bmesh.ops.inset_region(bm, faces=fs, thickness=thick, depth=0.0, use_boundary=True, use_even_offset=True)
            for f in r['faces']: f.material_index = MI[ring]
            if push:
                bm.normal_update()
                for v in {v for f in bm.faces if f.material_index == MI[mi] for v in f.verts}: v.co -= v.normal * push
        if lod == 0:
            inset('tmp_sideglass', 0.011, 'chrome')
            inset('tmp_sideglass', 0.016, 'trim', 0.006)
            inset('glass', 0.024, 'trim', 0.006)
            inset('lamp_head', 0.012, 'chrome')
            inset('lamp_head', 0.026, 'chrome', 0.012)
            inset('lamp_tail', 0.010, 'chrome')
            inset('lamp_tail', 0.014, 'lamp_tail', 0.008)
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
        bm.to_mesh(me); bm.free()
        stamp(me)
        # The temporary materials have done their job (regions for the detail passes, tints for the bake).
        mi = [0] * len(me.polygons); me.polygons.foreach_get('material_index', mi)
        names = MATS + TMP
        me.polygons.foreach_set('material_index', [MI[REMAP.get(names[i], names[i])] for i in mi])
        for i in range(len(names) - 1, len(MATS) - 1, -1): me.materials.pop(index=i)
        return ob

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
        path = [(th, 1) for th in ths] + [(th, -1) for th in reversed(ths[:-1])]
        verts, faces, fm = [], [], []
        for th, sx in path:
            cx, sn = cos(th) ** (2 / n), sin(th) ** (2 / n)
            x, z = Wb * cx, zs + (zN - zs) * sn
            nx, nz = cx ** (n - 1) / Wb, sn ** (n - 1) / (zN - zs)
            l = hypot(nx, nz); nx /= l; nz /= l
            k = 0.3 + 0.7 * smooth((th - th0) / radians(35))
            hug = 1 - smooth((th - th0) / radians(28))
            for o, y in prof:
                o = o * k if o > 0 else o
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
            for p in range(1, np_ - 2):
                e2 = bm.edges.get((bm.verts[i * np_ + p], bm.verts[(i + 1) * np_ + p]))
                if e2: e2[cr] = 0.7
        orient(bm, ('out', (0, (T + Bt) / 2, 0)))
        ob = to_obj(bm, 'bumper')
        if lod == 0:
            m = ob.modifiers.new('sub', 'SUBSURF'); m.levels = 1
            ob.data.attributes.remove(ob.data.attributes['tint'])
            apply_mods(ob); stamp(ob.data)
        return ob

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
        return out

    def interior(s):
        P = s.P; out = []; belt = P['belt']; roof = max(P['roof']); cw = P['cowl']; k = s.hw / 0.917
        # d lifts the floor with the sills, e the seats with the belt: a truck sits you higher than it stands.
        d = P['sill'] - 0.17; e = s.g('seat_e', min(belt - 0.935, d + 0.12))
        I = lambda *a, **kw: out.append(box(*a, **kw))
        zr = s.g('cab_end', P['rhead'] - 0.08); y0 = 0.28 + d; xs = 2 * (s.hw - 0.107); sx = 0.37 * k
        I('tub', (0, (y0 + belt + 0.005) / 2, (cw - 0.02 + zr) / 2), (xs, belt + 0.005 - y0, cw - 0.02 - zr), 'interior', 0.02, drop=3, flip=True)
        I('dash', (0, belt - 0.135, min(cw - 0.10, P['nose'] - 0.6)), (xs - 0.04, 0.34, 0.52), 'interior', 0.028, bevel=0.04)
        I('binnacle', (sx, belt + 0.05, cw - 0.30), (0.36, 0.07, 0.18), 'interior', 0.02, bevel=0.02)
        I('headliner', (0, min(P['roof']) - 0.085, (P['header'] + P['rhead']) / 2), (2 * P['xr'][0] - 0.2, 0.02, P['header'] - P['rhead'] - 0.2), 'interior', 0.12)
        I('console', (0, 0.48 + e, cw - 0.69), (0.2, 0.3, 0.9), 'interior', 0.025, bevel=0.02)
        seat = (0.075, 0.062, 0.05)
        for x in (sx, -sx):
            I('cushion', (x, 0.44 + e, cw - 0.72), (0.5, 0.16, 0.5), 'interior', seat, bevel=0.04)
            I('back', (x, 0.78 + e, cw - 1.04), (0.48, 0.62, 0.13), 'interior', seat, bevel=0.04, pitch=radians(14))
            I('headrest', (x, 1.15 + e, cw - 1.13), (0.24, 0.17, 0.09), 'interior', seat, bevel=0.03, pitch=radians(10))
        if s.g('bench', True):
            # The parcel shelf stops short of the tail skin: on the hatch it used to poke out through the rear corners.
            zb = max(P['deckf'] - 0.1, -(P['tail'] - 0.3)); za = P['rhead'] + 0.0
            I('shelf', (0, belt - 0.03, (za + zb) / 2), (xs - 0.2, 0.05, za - zb), 'interior', 0.03)
            I('bench', (0, 0.44 + e, P['rhead'] + 0.33), (xs - 0.26, 0.16, 0.5), 'interior', seat, bevel=0.04)
            I('benchback', (0, 0.76 + e, P['rhead'] + 0.03), (xs - 0.26, 0.58, 0.13), 'interior', seat, bevel=0.04, pitch=radians(18))
            for x in (0.4 * k, -0.4 * k):
                I('headrest', (x, 1.10 + e, P['rhead'] - 0.07), (0.24, 0.15, 0.09), 'interior', seat, bevel=0.03, pitch=radians(14))
        for zrow in s.g('seat_rows', ()):
            for x in (0.72, -0.72):
                if x < 0 and any(a + 0.3 > zrow > b - 0.3 for a, b in s.g('bus_doors', ())): continue
                I('cushion', (x, 0.44 + e, zrow), (0.88, 0.12, 0.42), 'interior', seat)
                I('back', (x, 0.80 + e, zrow - 0.24), (0.88, 0.62, 0.07), 'interior', seat, pitch=radians(8))
        # Steering wheel: a rim lathed about X, then stood up in front of the driver.
        v, f, _ = lathe([(0.0, 0.19), (0.016, 0.175), (0.0, 0.16), (-0.016, 0.175), (0.0, 0.19)], 14)
        t = radians(68); c = (sx, belt + 0.045, cw - 0.44)
        v = [(c[0] + yy, c[1] + zz * sin(t) - x * cos(t), c[2] + zz * cos(t) + x * sin(t)) for x, yy, zz in v]
        bm = new_bm(v, f, mat='interior'); orient(bm, ('out', c))
        out.append(to_obj(bm, 'steering', 0.012))
        I('spoke', (sx, belt + 0.045, cw - 0.44), (0.34, 0.035, 0.03), 'interior', 0.012, pitch=radians(22))
        I('column', (sx, belt + 0.015, cw - 0.36), (0.07, 0.07, 0.2), 'interior', 0.012, pitch=radians(-22))
        return out

    def fittings(s, lod):
        P = s.P; out = []; hw = s.hw; belt = P['belt']; k = hw / 0.917
        I = lambda *a, **kw: out.append(box(*a, **kw))
        bv = 0.0 if lod else 1.0; ms = s.g('mirror', 1.0)
        for sx in (1, -1):
            zm = s.g('mirror_z', lerp(P['cowl'], P['header'], 0.25))
            I('mirror', (sx * (hw + 0.085), belt + 0.075 * ms, zm), (0.18, 0.115 * ms, 0.085), 'paint' if ms == 1 else 'trim', bevel=0.03 * bv)
            I('mirror_arm', (sx * (hw - 0.01), belt + 0.035, zm + 0.01), (0.12, 0.035, 0.06), 'trim', bevel=0.008 * bv)
            if lod: continue
            I('mirror_glass', (sx * (hw + 0.085), belt + 0.075 * ms, zm - 0.0435), (0.145, 0.115 * ms - 0.03, 0.004), 'chrome', 0.55)
            for zh in s.g('handles', [dz + 0.16 for dz, _ in s.doors[1:]]):
                I('handle', (sx * (s.xat(zh, belt - 0.07) + 0.008), belt - 0.07, zh), (0.022, 0.024, 0.15), 'chrome', bevel=0.007)
            if s.g('rub', True):
                ry = lerp(P['sill'], belt - 0.12, 0.63)
                for (z0, _), (z1, _) in zip(s.doors, s.doors[1:]):
                    I('rub', (sx * (s.xat((z0 + z1) / 2, ry) + 0.006), ry, (z0 + z1) / 2), (0.016, 0.045, z0 - z1 - 0.05), 'trim', 0.03, bevel=0.005)
        if lod: return out
        y0, y1, zf, gw = s.face[1]
        if G_ in s.cells[1].values() and s.g('slats', True):
            for i in range(4):
                I('slat', (0, lerp(y0, y1, (i + 1) / 5), zf - 0.012), (gw * 2 - 0.05, 0.012, 0.014), 'chrome')
            I('badge', (0, y1 + 0.022, zf - 0.03), (0.07, 0.03, 0.01), 'chrome', bevel=0.004)
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
        return out

    # ── Wheels ───────────────────────────────────────────────────────────────

    def wheel(s, lod):
        P = s.P; R = P['R']; h = P['tw'] / 2; rr = R * s.g('rr', 0.67); ns = s.g('spokes', 5); out = []
        if lod:
            prof = [(-h, R * 0.8), (-h * 0.8, R), (h * 0.8, R), (h, R * 0.8), (h * 0.92, rr), (h * 0.55, rr * 0.9), (h * 0.55, 0)]
            v, f, band = lathe(prof, 12)
            bm = new_bm(v, f, mats=['tire' if b < 4 else 'rim' for b in band]); orient(bm, ('dir', (1, 0, 0), len(f) - 1))
            return to_obj(bm, 'wheel1')
        prof = [(-h * 0.9, rr), (-h, R * 0.8), (-h * 0.86, R * 0.982), (-h * 0.42, R), (h * 0.42, R), (h * 0.86, R * 0.982),
                (h, R * 0.9), (h, R * 0.77), (h * 0.9, rr)]
        v, f, band = lathe(prof, 32)
        bm = new_bm(v, f, mat='tire')
        dk = bm.verts.layers.float.new('dark')
        # Tread hint: every other vertex round the two tread edges is darker, which reads as blocks at a glance.
        bm.verts.ensure_lookup_table()
        for ring in (3, 4):
            for i in range(0, 32, 2): bm.verts[ring * 32 + i][dk] = 0.6
        orient(bm, ('out', (0, 0, 0))); out.append(to_obj(bm, 'tire'))
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
        for i in range(ns):
            for sg in (-1, 1):
                a0 = radians(i * 360 / ns + sg * 75 / ns); a1 = radians(i * 360 / ns + sg * 27.5 / ns)
                n = len(v)
                for r, t, xf, a in ((R * 0.12, 0.012, h * 0.8, a0), (rr * 0.9, 0.013, h * 0.78, a1)):
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
        out.append(to_obj(bm, 'spokes'))
        return join(out, 'wheel0')


# ── Occlusion bake ───────────────────────────────────────────────────────────

DIRS = []
for _i in range(24):
    _r = sqrt((_i + 0.5) / 24); _p = _i * 2.399963
    DIRS.append((_r * cos(_p), _r * sin(_p), sqrt(1 - _r * _r)))


def bake(ob, occluders=(), ground=True, reach=0.5, floor=0.12):
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
                    t = n.orthogonal().normalized(); b = n.cross(t); o = v.co + n * 0.004; occ = 0.0
                    for dx, dy, dz in DIRS:
                        hit = tree.ray_cast(o, t * dx + b * dy + n * dz, reach)
                        if hit[0] is not None: occ += 1 - hit[3] / reach
                    ao = floor + (1 - floor) * max(0.0, 1 - occ / len(DIRS) * 1.25) ** 1.2
                    if f.material_index == 0: ao = 0.3 + 0.7 * ao
                    ao *= 1 - 0.88 * dark[v.index]
                    cache[key] = ao
            i = l.index * 4
            out[i] = tint[i] * ao; out[i + 1] = tint[i + 1] * ao; out[i + 2] = tint[i + 2] * ao
    bm.free()
    for nme in ('tint', 'dark'): me.attributes.remove(me.attributes[nme])
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    col.data.foreach_set('color', out)
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def shade(ob, angle=50):
    me = ob.data
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=radians(angle))
    m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); m.keep_sharp = True; m.weight = 50
    apply_mods(ob)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


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
    return out


def d_muscle(s, lod):
    P = s.P; out = []; I = _I(out); bv = 0 if lod else 1
    yc = s.top(1.15)[0][4][1]
    I('scoop', (0, yc + 0.005, 1.15), (0.46, 0.10, 0.56), 'paint', bevel=0.03 * bv)
    I('scoop_mouth', (0, yc + 0.02, 1.15 + 0.275), (0.36, 0.045, 0.02), 'trim', 0.008)
    I('ducktail', (0, P['deck_tail'] + 0.022, -(P['tail'] - 0.16)), (1.56, 0.035, 0.18), 'paint', bevel=0.012 * bv, pitch=radians(13))
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
        I('engine_vent', (0, P['deck'] + 0.03, P['deckf'] - 0.2), (0.9, 0.012, 0.24), 'trim', 0.008)
    return out


def d_pickup(s, lod):
    P = s.P; out = []; I = _I(out)
    z0, z1, fy = P['bed']; top = P['deck'] - 0.03
    I('bed', (0, (fy + top) / 2, (z0 + z1) / 2), (2 * (s.hw - 0.13), top - fy, z0 - z1 + 0.02), 'paint', drop=3, flip=True)
    if not lod:
        y0, y1, zr, _ = s.face[-1]
        I('gate_handle', (0, y1 - 0.09, zr - 0.006), (0.22, 0.05, 0.014), 'trim', 0.03, bevel=0.005)
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
    z0, z1 = P['b2'] - 0.25, P['rhead'] + 0.06
    I('cargo', (0, (belt + roof - 0.09) / 2, (z0 + z1) / 2), (2 * P['xr'][1] - 0.04, roof - 0.09 - belt, z0 - z1), 'interior', 0.035, flip=True)
    return out


def d_taxi(s, lod):
    P = s.P; out = []; I = _I(out); roof = max(P['roof']); z = P['b1'] + 0.05
    I('sign', (0, roof + 0.045, z), (0.52, 0.085, 0.17), 'trim', (0.95, 0.85, 0.35), bevel=0 if lod else 0.02)
    if lod: return out
    I('sign_base', (0, roof + 0.004, z), (0.6, 0.016, 0.22), 'trim', 0.03)
    # Two rows of checker along the doors, as flat decals a few millimetres off the skin.
    c = 0.08; z0 = P['cowl'] - 0.05; n = int((z0 - P['rhead'] - 0.04) / c); yb = 0.61
    for tone, tint in ((0, 0.03), (1, 0.8)):
        v, f = [], []
        for sx in (1, -1):
            for i in range(n):
                for r in (0, 1):
                    if (i + r) % 2 != tone: continue
                    za, zb, ya, yc = z0 - i * c, z0 - (i + 1) * c, yb + r * c, yb + (r + 1) * c
                    q = len(v)
                    v += [(sx * (s.xat(zz, yy) + 0.005), yy, zz) for zz, yy in ((za, ya), (zb, ya), (zb, yc), (za, yc))]
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
    return out


def d_bus(s, lod):
    P = s.P; out = []; I = _I(out); roof = max(P['roof']); hw = s.hw; bv = 0 if lod else 1
    yb = P['sill'] + 0.06; yt = roof - 0.30
    for z0, z1 in P['bus_doors']:
        zc = (z0 + z1) / 2; x = -(hw + 0.002)
        I('door', (x, (yb + yt) / 2, zc), (0.035, yt - yb, z0 - z1), 'trim', 0.03)
        for q in (-1, 1):
            I('door_glass', (x - 0.019, lerp(yb, yt, 0.6), zc + q * (z0 - z1) / 4), (0.006, (yt - yb) * 0.66, (z0 - z1) / 2 - 0.09), 'glass')
    I('dest', (0, roof - 0.21, P['header'] + 0.11), (1.7, 0.26, 0.12), 'trim', 0.025, bevel=0.02 * bv)
    I('dest_sign', (0, roof - 0.21, P['header'] + 0.172), (1.45, 0.17, 0.006), 'lamp_head', (1.0, 0.5, 0.05))
    I('hvac', (0, roof + 0.085, -2.6), (1.7, 0.2, 2.3), 'trim', 0.45, bevel=0.05 * bv)
    I('hatch', (0, roof + 0.03, 1.6), (0.9, 0.07, 0.9), 'trim', 0.45, bevel=0.02 * bv)
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
    rk = lambda y: 0.035 * (y - 0.2) / 0.5
    # The closed 'grille': a blank panel with a raised pattern, no slats. Dashes follow the curve of the nose.
    y0, y1, zf, gw = s.face[1]
    for r in range(3):
        y = lerp(y0, y1, (r + 1) / 4); m = 7 - r % 2
        for i in range(m):
            x = (i - (m - 1) / 2) * 0.115
            if abs(x) < 0.09 and r == 1: continue
            I('dash', (x, y, s.zplan(x, 1) - rk(y) - 0.016), (0.07, 0.014, 0.012), 'trim', 0.09)
    T, Bt = P['bumper_top'][0], P['bumper_bot'][0]
    # The panel runs on below the lamps, narrower: the real one is a shield, deeper than the lamps beside it.
    I('grille_low', (0, T - 0.062, P['nose'] - 0.008), (0.78, 0.105, 0.02), 'trim', 0.022, bevel=0.006)
    for i in range(6):
        I('dash', ((i - 2.5) * 0.115, T - 0.062, P['nose'] + 0.003), (0.07, 0.014, 0.008), 'trim', 0.09)
    # The slim intake under it, and the upright daytime lamps at the corners of the bumper.
    I('mouth', (0, Bt + 0.075, P['nose'] - 0.004), (0.64, 0.06, 0.014), 'trim', 0.006, bevel=0.004)
    zN = P['nose'] - 0.014; nf = P['n_front']
    for sx in (1, -1):
        x = 0.68
        z = P['zs'] + (zN - P['zs']) * (1 - (x / (hw + 0.004)) ** nf) ** (1 / nf)
        I('drl', (sx * x, lerp(Bt, T, 0.52), z + 0.002), (0.04, 0.16, 0.03), 'lamp_head', bevel=0.006)
    # Gold bowties, front and rear: a long bar and a short thick one across its middle.
    yb = lerp(y0, y1, 0.5); zb = zf - 0.012
    I('bowtie', (0, yb, zb), (0.125, 0.024, 0.02), 'trim', GOLD); I('bowtie', (0, yb, zb), (0.062, 0.042, 0.022), 'trim', GOLD)
    y0, y1, zr, _ = s.face[-1]
    yb = y1 - 0.035; zb = zr + rk(yb) - rk((y0 + y1) / 2) + 0.002
    I('bowtie', (0, yb, zb), (0.11, 0.022, 0.016), 'trim', GOLD); I('bowtie', (0, yb, zb), (0.055, 0.038, 0.018), 'trim', GOLD)
    # The charge port: a flap on the driver's front wing, between the arch and the door.
    zc, yc = 1.0, P['belt'] - 0.15
    x = max(s.xat(zc, yc - 0.07), s.xat(zc, yc + 0.07))
    I('port_gap', (x - 0.004, yc, zc), (0.012, 0.165, 0.185), 'trim', 0.01, bevel=0.004)
    I('port', (x - 0.002, yc, zc), (0.012, 0.15, 0.17), 'paint', bevel=0.004)
    # The rear seat, which the shared interior would put under the tailgate glass on a body this cab-forward.
    seat = (0.075, 0.062, 0.05); xs = 2 * (hw - 0.107); e = min(P['belt'] - 0.935, sill - 0.17 + 0.12)
    I('bench', (0, 0.44 + e, -0.62), (xs - 0.26, 0.16, 0.5), 'interior', seat, bevel=0.04)
    I('benchback', (0, 0.76 + e, -0.92), (xs - 0.26, 0.58, 0.13), 'interior', seat, bevel=0.04, pitch=radians(18))
    I('shelf', (0, P['belt'] + 0.02, -1.38), (xs - 0.2, 0.04, 0.72), 'interior', 0.03)
    return out


DETAIL = {'bolt': d_bolt, 'hatch': d_hatch, 'coupe': d_coupe, 'muscle': d_muscle, 'sports': d_sports, 'pickup': d_pickup, 'van': d_van,
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
    out = np.concatenate([np.concatenate(cells[2:4], axis=1), np.concatenate(cells[0:2], axis=1)], axis=0)
    h, w, _ = out.shape
    im = bpy.data.images.new('sheet', w, h, alpha=False)
    im.pixels.foreach_set(out.ravel())
    im.filepath_raw = os.path.join(d, f'{kind}_sheet.jpg'); im.file_format = 'JPEG'; im.save()
    bpy.data.images.remove(im)


def render(kind, P, sets, extra=False):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
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
        for name, pos in views.items():
            if lod and name != 'front34': continue
            co.location = B(pos[0] * k, pos[1] * max(1.0, P['H'] / 1.45 * 0.85), pos[2] * k)
            sc.render.filepath = os.path.join(ROOT, 'shots', 'blender', f'{kind}_{name}{"_lod1" if lod else ""}.png')
            bpy.ops.render.render(write_still=True)
        for o in insts: bpy.data.objects.remove(o)
    try:
        sheet(kind, ['front34', 'rear34', 'side', 'front34_lod1'])
    except Exception as ex:
        print('SHEET FAILED', ex)


# ── Build one vehicle ────────────────────────────────────────────────────────

def build(kind, do_render=True, do_export=True, extra=False):
    P = VEHICLES[kind]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials(P['paint'])
    car = Car(P); sets = []; stats = {}
    for lod in (0, 1):
        parts = [car.shell(lod), car.bumper(1, lod), car.bumper(-1, lod)] + car.underbody(lod) + car.fittings(lod)
        if kind in DETAIL: parts += DETAIL[kind](car, lod)
        if lod == 0: parts += car.interior()
        body = join(parts, f'LOD{lod}')
        wheel = car.wheel(lod); wheel.name = wheel.data.name = f'WHEEL{lod}'
        M = []
        for sx in (1, -1):
            for z in (P['wb'] / 2, -P['wb'] / 2):
                M.append((wheel.data, Matrix.Translation(B(sx * P['track'] / 2, P['R'], z)) @ (Matrix.Rotation(pi, 4, 'Z') if sx < 0 else Matrix.Identity(4))))
        bake(body, M)
        bake(wheel, ground=False, reach=0.25, floor=0.2)
        shade(body); shade(wheel, 40)
        sets.append((body, wheel))
        stats[f'LOD{lod}'] = tris(body); stats[f'WHEEL{lod}'] = tris(wheel)
    lo = [min(v.co[i] for v in sets[0][0].data.vertices) for i in range(3)]
    hi = [max(v.co[i] for v in sets[0][0].data.vertices) for i in range(3)]
    stats['WLH'] = [round(hi[0] - lo[0], 2), round(hi[1] - lo[1], 2), round(hi[2], 2)]
    if do_export:
        out = os.path.join(ROOT, 'public', 'models'); os.makedirs(out, exist_ok=True)
        path = os.path.join(out, kind + '.glb')
        bpy.ops.object.select_all(action='DESELECT')
        for b, w in sets: b.select_set(True); w.select_set(True)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                                  export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
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


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    kinds = [a for a in argv if not a.startswith('--')] or list(VEHICLES)
    for a in argv:
        if a.startswith('--paint='):
            for k in kinds: VEHICLES[k] = dict(VEHICLES[k], paint=tuple(float(x) for x in a[8:].split(',')))
    for k in kinds:
        try:
            build(k, '--no-render' not in argv, '--no-export' not in argv, '--all-views' in argv)
        except Exception:
            import traceback
            print('FAILED ' + k); traceback.print_exc()
