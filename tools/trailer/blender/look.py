# Look development for the Blender trailer (tools/trailer/PLAN.md): photoreal materials rebuilt over the game's own
# imported ones, the sky, sun and atmosphere, street lamps, the SpeedScan tower and its stink lines as hero rebuilds,
# grass scattered near the camera, lens, motion blur, colour management and the compositor grade.
#
# Used by build_shot.py (never run on its own). Every material keeps the game's own colours (texture x vertex colour x
# instance colour, as the game draws them), so the town stays recognisably Port Calamity; what changes is the physics:
# real roughness and metalness, micro surface (bump), grime in the crevices, wet films and puddles, real glass, water,
# clear-coated car paint with flakes, emissive windows and lamps that light the scene.
#
# Presets (LOOKS) are picked per shot with the shot's "look" (tools/trailer/shots.json).

import bpy, math, random
from mathutils import Vector, Matrix

LOOKS = {
    # Late sun, warm, long shadows, light aerial haze.
    'golden': dict(haze_lum=1.4, sun_elev=9.0, sun_az=None, sun_strength=4.2, sun_angle=0.6, aerosol=2.2, air=1.0, ozone=1.0,
                   sky_strength=0.36, haze=0.00004, haze_color=(1.0, 0.86, 0.70), haze_aniso=0.7,
                   wet=0.0, night=0.0, lamps=False, exposure=-0.3, look='Medium High Contrast', bloom=0.6,
                   mist=None, grass=False, fstop=11.0, fill=0.3),
    # Mid afternoon: high clean sun, blue sky, glitter on the water.
    'afternoon': dict(haze_lum=1.6, sun_elev=38.0, sun_az=None, sun_strength=4.4, sun_angle=0.55, aerosol=1.0, air=1.0, ozone=1.0,
                      sky_strength=0.11, haze=0.00004, haze_color=(0.86, 0.92, 1.0), haze_aniso=0.6,
                      wet=0.0, night=0.0, lamps=False, exposure=-1.8, look='Punchy', bloom=0.5,
                      mist=None, grass=True, fstop=11.0, fill=0.12),
    # Clear morning (the falls): low-ish warm sun, a little haze.
    'morning': dict(haze_lum=1.4, sun_elev=16.0, sun_az=None, sun_strength=4.0, sun_angle=0.6, aerosol=1.6, air=1.0, ozone=1.0,
                    sky_strength=0.2, haze=0.00004, haze_color=(1.0, 0.92, 0.82), haze_aniso=0.7,
                    wet=0.1, night=0.0, lamps=False, exposure=-1.2, look='Medium High Contrast', bloom=0.6,
                    mist=None, grass=True, fstop=8.0, fill=0.3),
    # Blue hour after rain: wet asphalt and pavements, lamps and shop windows on, sky still faintly lit.
    'dusk_wet': dict(haze_mode='volume', sun_elev=-2.0, sun_az=None, sun_strength=0.0, sun_angle=1.0, aerosol=1.2, air=1.0, ozone=3.0,
                     sky_strength=1.6, haze=0.0011, haze_color=(0.75, 0.80, 0.92), haze_aniso=0.5,
                     wet=1.0, night=0.9, lamps=True, exposure=1.4, look='Medium High Contrast', bloom=1.0,
                     mist=None, grass=False, fstop=4.0),
    # Sunrise over the river: low sun through mist, god rays.
    'morning_mist': dict(haze_mode='volume', sun_elev=5.0, sun_az=None, sun_strength=3.4, sun_angle=0.8, aerosol=3.5, air=1.2, ozone=1.0,
                         sky_strength=0.36, haze=0.0012, haze_color=(1.0, 0.90, 0.78), haze_aniso=0.75,
                         wet=0.15, night=0.0, lamps=False, exposure=0.0, look='Medium High Contrast', bloom=0.7,
                         mist=dict(top=9.0, density=0.035), grass=True, fstop=8.0, fill=1.0),
    # Dawn over the harbour: the sun just under the horizon, thick fog on flat water, lamps still on.
    'dawn_fog': dict(haze_sky=0.6, haze_lum=0.2, sun_elev=1.5, sun_az=None, sun_strength=1.6, sun_angle=1.5, aerosol=4.0, air=1.2, ozone=1.5,
                     sky_strength=0.6, haze=0.0009, haze_color=(0.62, 0.74, 0.92), haze_aniso=0.6,
                     wet=0.1, night=0.35, lamps=True, exposure=0.6, look='Medium High Contrast', bloom=0.9,
                     mist=dict(top=22.0, density=0.012), grass=False, fstop=8.0, fill=0.3),
    # Winter morning in a snowy lane: cold, soft, misty, low sun behind haze.
    'winter_mist': dict(haze_sky=0.9, haze_lum=1.0, sun_elev=7.0, sun_az=None, sun_strength=2.2, sun_angle=2.0, aerosol=3.0, air=1.1, ozone=1.2,
                        sky_strength=0.5, haze=0.004, haze_color=(0.90, 0.94, 1.0), haze_aniso=0.7,
                        wet=0.0, night=0.0, lamps=False, exposure=-0.5, look='Medium High Contrast', bloom=1.0,
                        mist=None, grass=False, fstop=5.6, fill=0.5),
    # Tornado weather: a dark green-grey ceiling, flat light, a pale band at the horizon.
    'storm': dict(haze_lum=0.3, sun_elev=30.0, sun_az=None, sun_strength=0.0, sun_angle=5.0, aerosol=3.0, air=1.0, ozone=1.0,
                  sky_strength=0.0, haze=0.0, haze_color=(0.80, 0.84, 0.80), haze_aniso=0.3,
                  wet=0.3, night=0.0, lamps=False, exposure=0.7, look='Medium High Contrast', bloom=0.6,
                  mist=None, grass=True, fstop=8.0, ambient=(0.50, 0.55, 0.52, 0.55), horizon=(1.0, 0.93, 0.78, 1.5)),
    # Clear night: moonlight, lamps, lit windows.
    'night': dict(haze_lum=0.01, sun_elev=-12.0, sun_az=None, sun_strength=0.07, sun_angle=1.5, aerosol=1.0, air=1.0, ozone=1.0,
                  sky_strength=0.0, haze=0.0, haze_color=(0.78, 0.84, 1.0), haze_aniso=0.5,
                  wet=0.25, night=1.0, lamps=True, exposure=2.1, look='Medium High Contrast', bloom=1.1,
                  mist=None, grass=False, fstop=4.0, ambient=(0.035, 0.06, 0.13, 0.3), lamp_elev=38.0, sun_color=(0.62, 0.74, 1.0),
                  stars=True),
    # Night after rain: wet streets, lamps and police lights in the puddles, a little more haze for beams.
    'night_wet': dict(haze_lum=0.012, lamp_max=45, haze_mode='comp', sun_elev=-12.0, sun_az=None, sun_strength=0.04, sun_angle=1.5, aerosol=1.0, air=1.0, ozone=1.0,
                      sky_strength=0.0, haze=0.0, haze_color=(0.78, 0.84, 1.0), haze_aniso=0.6,
                      wet=1.0, night=1.0, lamps=True, exposure=1.3, look='Medium High Contrast', bloom=0.7,
                      mist=None, grass=False, fstop=4.0, ambient=(0.035, 0.055, 0.11, 0.3), lamp_elev=45.0, sun_color=(0.62, 0.74, 1.0)),
}

# ---------------------------------------------------------------------------------------------------------------------
# Small node helpers.

def sock(coll, name, typ=None):
    for s in coll:
        if s.name == name and (typ is None or s.type == typ) and s.enabled:
            return s
    for s in coll:
        if s.name == name and (typ is None or s.type == typ):
            return s
    raise KeyError(name)


class NB:
    """Node builder for one tree: n('ShaderNodeMath', operation='MULTIPLY'), link(a, b), math helpers taking sockets or numbers."""
    def __init__(self, nt, x=-1400):
        self.nt, self.x, self.y = nt, x, 0

    def n(self, kind, **props):
        node = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(node, k, v)
        node.location = (self.x, self.y)
        self.y -= 40
        return node

    def link(self, a, b):
        self.nt.links.new(a, b)

    def val(self, s, v):
        if isinstance(v, (int, float)):
            s.default_value = v
        elif isinstance(v, tuple):
            s.default_value = v
        else:
            self.link(v, s)

    def math(self, op, a, b=0.0, c=None, clamp=False):
        m = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.val(m.inputs[0], a)
        self.val(m.inputs[1], b)
        if c is not None:
            self.val(m.inputs[2], c)
        return m.outputs[0]

    def mixc(self, fac, a, b, blend='MIX'):
        m = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        self.val(sock(m.inputs, 'Factor', 'VALUE'), fac)
        self.val(sock(m.inputs, 'A', 'RGBA'), a)
        self.val(sock(m.inputs, 'B', 'RGBA'), b)
        return sock(m.outputs, 'Result', 'RGBA')

    def mixf(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='FLOAT')
        self.val(sock(m.inputs, 'Factor', 'VALUE'), fac)
        self.val(sock(m.inputs, 'A', 'VALUE'), a)
        self.val(sock(m.inputs, 'B', 'VALUE'), b)
        return sock(m.outputs, 'Result', 'VALUE')

    def maprange(self, v, a, b, c=0.0, d=1.0, smooth=False):
        m = self.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR', clamp=True)
        self.val(m.inputs['Value'], v)
        m.inputs['From Min'].default_value = a
        m.inputs['From Max'].default_value = b
        m.inputs['To Min'].default_value = c
        m.inputs['To Max'].default_value = d
        return m.outputs['Result']

    def noise(self, vec=None, scale=5.0, detail=4.0, rough=0.55, w=None, out='Fac'):
        t = self.n('ShaderNodeTexNoise', noise_dimensions='4D' if w is not None else '3D')
        if vec is not None:
            self.link(vec, t.inputs['Vector'])
        if w is not None:
            self.val(t.inputs['W'], w)
        t.inputs['Scale'].default_value = scale
        t.inputs['Detail'].default_value = detail
        t.inputs['Roughness'].default_value = rough
        return t.outputs[out]

    def attr(self, name, kind='GEOMETRY', out='Color'):
        a = self.n('ShaderNodeAttribute', attribute_type=kind, attribute_name=name)
        return a.outputs[out]


def world_pos(nb):
    return nb.n('ShaderNodeNewGeometry').outputs['Position']


# ---------------------------------------------------------------------------------------------------------------------
# Material classification from what the exporter wrote (object extras pc.path, material extras pc).

def classify(path, info, obname):
    p = (path or '').lower()
    t = info.get('type', '')
    col = (info.get('color') or '#ffffff').lower()
    if 'stink' in p or p.endswith('sky') or p == 'sky' or 'shadow' in p or 'points' in p:
        return 'drop'
    if t == 'MeshBasicMaterial' and col in ('#000000',) and info.get('transparent'):
        return 'drop'
    # Game-only helpers: mission marker columns (teal, unlit, see-through), the flood sheet waiting under the ground.
    if (t == 'MeshBasicMaterial' and col == '#2a9d8f' and info.get('transparent')) or 'flood' in p:
        return 'drop'
    # Faint unlit sheets (the helicopter's rotor blur disc, glow cards): motion blur and bloom do that here.
    if t == 'MeshBasicMaterial' and info.get('transparent') and (1 if info.get('opacity') is None else info['opacity']) < 0.3:
        return 'drop'
    leaf = p.split('/')[-1]
    # (By the leaf name: 'riverfront-models' are the mills, not the river.)
    if leaf == 'sea' or 'pond' in leaf or (leaf.startswith('river') and 'front' not in leaf) or 'water' in leaf:
        return 'water'
    if 'falls' in p:
        # The game's falls sheets cover the whole rapids: as foam they read as snow; as river water they read right.
        return 'water'
    if 'far-hills' in p:
        return 'hills'
    # The game's own weather and effect sheets (rain streaks, light cones: custom see-through shaders) are rebuilt here.
    if leaf == 'rain' or (t == 'ShaderMaterial' and info.get('transparent') and 'speedscan' not in p):
        return 'drop'
    if 'stink' in p:
        return 'drop'
    if 'speedscan-tower' in p or 'speedscan-hq/lod' in p or 'hq_' in p:
        return 'tower'
    if info.get('transparent') and (info.get('opacity', 1) < 0.6) and (info.get('rough') is not None and info['rough'] < 0.25):
        return 'glass'
    if 'people' in p or 'person' in p:
        return 'skin'
    if t == 'MeshPhysicalMaterial' or 'vehicle' in p or 'car' in p.split('/')[-1]:
        return 'paint'
    if t == 'MeshBasicMaterial' or t == 'MeshLambertMaterial' and info.get('map'):
        return 'sign'
    if 'leaf' in p or 'flora' in p or 'tree' in p:
        return 'foliage'
    if 'lamp' in p:
        return 'lamp'
    return 'surface'


# ---------------------------------------------------------------------------------------------------------------------
# The enhanced surface: the imported base colour, made physical.

def principled(nt):
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    return None


def linked_from(s):
    return s.links[0].from_socket if s.is_linked else None


def base_texture(P):
    """The image texture colour that feeds the Base Color (through the importer's vertex-colour multiply), or None."""
    seen = set()
    stack = [P.inputs['Base Color']]
    while stack:
        s = stack.pop()
        for l in s.links:
            n = l.from_node
            if n.name in seen:
                continue
            seen.add(n.name)
            if n.type == 'TEX_IMAGE':
                return n.outputs['Color']
            stack += [i for i in n.inputs if i.is_linked]
    return None


def enhance(mat, info, cls, L, ctx):
    """Rewire an imported material in place. ctx: {'inst_col': bool, 'pbr': bool (has _APBR), 'kind': ...}."""
    nt = mat.node_tree
    P = principled(nt)
    if P is None:
        return
    # Blender's default emission colour is white: only the game's own emissive may glow.
    if not P.inputs['Emission Color'].is_linked and (info.get('emissive') or '#000000') == '#000000':
        P.inputs['Emission Strength'].default_value = 0.0
    nb = NB(nt)
    base_in = P.inputs['Base Color']
    base = linked_from(base_in) or tuple(base_in.default_value)
    # Instance colour (three's instanceColor multiplies the material colour). Missing attribute -> alpha 0 -> white.
    if ctx.get('inst_col'):
        ic = nb.n('ShaderNodeAttribute', attribute_type='INSTANCER', attribute_name='inst_col')
        icm = nb.mixc(ic.outputs['Alpha'], (1, 1, 1, 1), ic.outputs['Color'])
        base = nb.mixc(1.0, base, icm, 'MULTIPLY')
    rough_src = linked_from(P.inputs['Roughness'])
    rough = rough_src if rough_src is not None else P.inputs['Roughness'].default_value
    metal = 0.0
    if ctx.get('pbr'):
        pb = nb.n('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name='_APBR')
        sep = nb.n('ShaderNodeSeparateXYZ'); nb.link(pb.outputs['Vector'], sep.inputs[0])
        rough = sep.outputs['X']; metal = sep.outputs['Y']
    elif cls in ('paint',):
        metal = P.inputs['Metallic'].default_value if not P.inputs['Metallic'].is_linked else 0.4
    # The game packs other data in metalness on world surfaces: never trust it there.
    for l in list(P.inputs['Metallic'].links):
        nt.links.remove(l)
    pos = world_pos(nb)
    # Micro surface: fine noise bump plus a broader undulation, scaled to the surface type.
    bump_k = {'surface': 1.0, 'paint': 0.0, 'glass': 0.0, 'sign': 0.25, 'foliage': 0.6, 'lamp': 0.2, 'skin': 0.2, 'tower': 0.4}.get(cls, 0.6)
    normal = None
    if bump_k > 0:
        fine = nb.noise(pos, scale=55.0, detail=8.0, rough=0.6)
        broad = nb.noise(pos, scale=3.0, detail=3.0, rough=0.5)
        h = nb.math('ADD', nb.math('MULTIPLY', fine, 0.6), nb.math('MULTIPLY', broad, 0.4))
        bump = nb.n('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.12 * bump_k
        bump.inputs['Distance'].default_value = 0.02
        nb.link(h, bump.inputs['Height'])
        nrm_src = linked_from(P.inputs['Normal'])
        if nrm_src is not None:
            nb.link(nrm_src, bump.inputs['Normal'])
        normal = bump.outputs['Normal']
    # Grime: darker in crevices (ambient occlusion) and with large-scale weathering variation.
    if cls in ('surface', 'tower', 'sign', 'lamp'):
        ao = nb.n('ShaderNodeAmbientOcclusion', samples=8); ao.inputs['Distance'].default_value = 0.6
        aok = nb.maprange(ao.outputs['AO'], 0.0, 1.0, 0.72, 1.0)
        weather = nb.maprange(nb.noise(pos, scale=0.35, detail=5.0, rough=0.6), 0.3, 0.7, 0.88, 1.06)
        k = nb.math('MULTIPLY', aok, weather)
        kc = nb.n('ShaderNodeCombineXYZ'); nb.link(k, kc.inputs[0]); nb.link(k, kc.inputs[1]); nb.link(k, kc.inputs[2])
        base = nb.mixc(1.0, base, kc.outputs[0], 'MULTIPLY')
        # Roughness varies a little with the same weathering.
        rough = nb.math('ADD', rough, nb.maprange(nb.noise(pos, scale=1.7, detail=4.0), 0.3, 0.7, -0.08, 0.08), clamp=True)
    # Windows painted into the game's facade textures: dark or bluish texels become real glazing (smooth, reflective,
    # darker body), and at night a share of them light up warm, window by window.
    tex = base_texture(P) if cls == 'surface' else None
    win = None
    em_src0 = linked_from(P.inputs['Emission Color'])
    alpha_win = None
    if cls == 'surface':
        # buildings.py models: vertex alpha strictly between 0 and 1 marks a window (the game lights them at night).
        al = nb.attr('_ALPHA', out='Fac')
        alpha_win = nb.math('MULTIPLY', nb.math('GREATER_THAN', al, 0.02), nb.math('LESS_THAN', al, 0.98))
        if ctx.get('no_alpha_win'):
            # The riverfront models (the mills) do not follow that contract: read as glazing, a whole mill became a
            # black mirror. Their windows come from the texture alone.
            alpha_win = nb.math('MULTIPLY', alpha_win, 0.0)
    if tex is not None and not isinstance(base, tuple):
        # Judge the colour as drawn (texture x vertex colour), not the raw texture (the brick maps are grey).
        sepc = nb.n('ShaderNodeSeparateColor'); nb.link(base, sepc.inputs[0])
        r_, g_, b_ = sepc.outputs[0], sepc.outputs[1], sepc.outputs[2]
        lum = nb.math('ADD', nb.math('MULTIPLY', r_, 0.3), nb.math('ADD', nb.math('MULTIPLY', g_, 0.59), nb.math('MULTIPLY', b_, 0.11)))
        blue = nb.maprange(nb.math('SUBTRACT', b_, r_), 0.04, 0.14, 0.0, 1.0, smooth=True)
        dark = nb.maprange(lum, 0.012, 0.03, 1.0, 0.0, smooth=True)
        win = nb.math('MAXIMUM', nb.math('MAXIMUM', blue, nb.math('MULTIPLY', dark, 0.6)), alpha_win)
        rough = nb.mixf(win, rough, 0.04)
        base = nb.mixc(win, base, nb.mixc(1.0, base, (0.35, 0.35, 0.37, 1), 'MULTIPLY'))
        night = L.get('night', 0.0)
        if night > 0:
            vor = nb.n('ShaderNodeTexVoronoi'); vor.inputs['Scale'].default_value = 0.42
            nb.link(pos, vor.inputs['Vector'])
            vs = nb.n('ShaderNodeSeparateColor'); nb.link(vor.outputs['Color'], vs.inputs[0])
            lit = nb.math('GREATER_THAN', vs.outputs[0], 0.45)
            tint = nb.mixc(vs.outputs[1], (1.0, 0.62, 0.32, 1), (1.0, 0.85, 0.65, 1))
            P.inputs['Emission Strength'].default_value = 1.0
            ew = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.math('MAXIMUM', alpha_win, nb.math('GREATER_THAN', blue, 0.5)), lit), 2.2 * night)
            ec = nb.n('ShaderNodeCombineXYZ'); [nb.link(ew, ec.inputs[k]) for k in range(3)]
            nb.link(nb.mixc(1.0, tint, ec.outputs[0], 'MULTIPLY'), P.inputs['Emission Color'])
    # Wet: a water film on everything facing up (puddles in the dips), streaks on walls.
    W = L.get('wet', 0.0)
    coat = 0.0
    if W > 0 and cls in ('surface', 'tower', 'sign', 'lamp', 'paint', 'foliage'):
        geo = nb.n('ShaderNodeNewGeometry')
        sep = nb.n('ShaderNodeSeparateXYZ'); nb.link(geo.outputs['Normal'], sep.inputs[0])
        up = nb.maprange(sep.outputs['Z'], 0.55, 0.92, 0.0, 1.0, smooth=True)
        puddle = nb.maprange(nb.noise(pos, scale=0.22, detail=6.0, rough=0.62), 0.47, 0.56, 0.0, 1.0, smooth=True)
        wall = nb.math('MULTIPLY', nb.math('SUBTRACT', 1.0, up), 0.35)
        wetmask = nb.math('MULTIPLY', nb.math('ADD', nb.math('MULTIPLY', up, nb.math('ADD', 0.55, nb.math('MULTIPLY', puddle, 0.45))), wall, clamp=True), W)
        dark = nb.maprange(wetmask, 0.0, 1.0, 1.0, 0.55)
        dk = nb.n('ShaderNodeCombineXYZ'); nb.link(dark, dk.inputs[0]); nb.link(dark, dk.inputs[1]); nb.link(dark, dk.inputs[2])
        base = nb.mixc(1.0, base, dk.outputs[0], 'MULTIPLY')
        # Wet asphalt stays fairly rough (0.3); standing water in the dips is a mirror (clear coat, flat normal).
        rough = nb.mixf(wetmask, rough, nb.mixf(puddle, 0.3, 0.02))
        coat = nb.math('MULTIPLY', nb.math('MULTIPLY', wetmask, puddle), up)
        if normal is not None:
            # Standing water is flat: the bump fades out in puddles.
            g2 = nb.n('ShaderNodeNewGeometry')
            nmix = nb.n('ShaderNodeMix', data_type='VECTOR')
            nb.link(nb.math('MULTIPLY', puddle, up), sock(nmix.inputs, 'Factor', 'VALUE'))
            nb.link(normal, sock(nmix.inputs, 'A', 'VECTOR')); nb.link(g2.outputs['Normal'], sock(nmix.inputs, 'B', 'VECTOR'))
            normal = sock(nmix.outputs, 'Result', 'VECTOR')
    # Per class.
    if cls == 'paint':
        rough = 0.32 if not ctx.get('pbr') else rough
        P.inputs['Coat Weight'].default_value = 1.0
        P.inputs['Coat Roughness'].default_value = 0.025
        flake = nb.n('ShaderNodeTexVoronoi'); flake.inputs['Scale'].default_value = 2600.0
        nb.link(world_pos(nb), flake.inputs['Vector'])
        fb = nb.n('ShaderNodeBump'); fb.inputs['Strength'].default_value = 0.18; fb.inputs['Distance'].default_value = 0.001
        nb.link(flake.outputs['Distance'], fb.inputs['Height'])
        normal = fb.outputs['Normal']
        if isinstance(metal, float):
            metal = max(metal, 0.45)
    if cls == 'glass':
        P.inputs['Transmission Weight'].default_value = 1.0
        P.inputs['IOR'].default_value = 1.5
        rough = 0.03
        metal = 0.0
        P.inputs['Alpha'].default_value = 1.0
        for l in list(P.inputs['Alpha'].links):
            nt.links.remove(l)
        base = (0.82, 0.88, 0.9, 1.0)
    if cls == 'foliage':
        P.inputs['Subsurface Weight'].default_value = 0.0
        # Leaves pass light: translucency mixed in at the output.
    if cls == 'skin':
        P.inputs['Subsurface Weight'].default_value = 0.15
        rough = 0.55
    # Emission: lamps and lit windows at night; signs glow a little; game emissive maps drive window glow.
    night = L.get('night', 0.0)
    em_src = em_src0 if cls == 'surface' else linked_from(P.inputs['Emission Color'])
    if win is not None and L.get('night', 0.0) > 0:
        pass
    elif cls == 'sign':
        P.inputs['Emission Strength'].default_value = 0.15 + 2.2 * night
        if em_src is None:
            nb.link(base if not isinstance(base, tuple) else nb.mixc(0, base, base), P.inputs['Emission Color'])
    elif cls == 'lamp':
        # Posts and heads share one material: no glow here (the lamp heads get real lights and bulbs).
        P.inputs['Emission Strength'].default_value = 0.0
    elif em_src is not None or (info.get('emissive') or '#000000') != '#000000':
        # The game's emissive (lit windows, lamp lenses) scaled by night; by day a faint residual.
        P.inputs['Emission Strength'].default_value = 0.02 + 1.2 * night
    # Write back.
    nb.val(base_in, base) if not isinstance(base, tuple) else setattr(base_in, 'default_value', base)
    for l in list(P.inputs['Roughness'].links):
        nt.links.remove(l)
    nb.val(P.inputs['Roughness'], rough)
    nb.val(P.inputs['Metallic'], metal)
    if not isinstance(coat, float) or coat > 0:
        nb.val(P.inputs['Coat Weight'], coat)
        P.inputs['Coat Roughness'].default_value = 0.02
    if normal is not None:
        nb.link(normal, P.inputs['Normal'])
    if cls == 'foliage':
        out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
        tr = nb.n('ShaderNodeBsdfTranslucent')
        nb.val(tr.inputs['Color'], base)
        mix = nb.n('ShaderNodeMixShader'); mix.inputs[0].default_value = 0.3
        nb.link(P.outputs[0], mix.inputs[1]); nb.link(tr.outputs[0], mix.inputs[2])
        # Keep the leaf cut-outs: transparency through the alpha.
        alpha_src = linked_from(P.inputs['Alpha'])
        if alpha_src is not None:
            trn = nb.n('ShaderNodeBsdfTransparent')
            m2 = nb.n('ShaderNodeMixShader'); nb.link(alpha_src, m2.inputs[0]); nb.link(trn.outputs[0], m2.inputs[1]); nb.link(mix.outputs[0], m2.inputs[2])
            nb.link(m2.outputs[0], out.inputs['Surface'])
        else:
            nb.link(mix.outputs[0], out.inputs['Surface'])


# ---------------------------------------------------------------------------------------------------------------------
# Hero materials.

def water_material(name, L, river=False):
    m = bpy.data.materials.new(name)
    nt = m.node_tree if m.use_nodes else None
    m.use_nodes = True
    nt = m.node_tree
    P = principled(nt)
    nb = NB(nt)
    P.inputs['Base Color'].default_value = (0.010, 0.030, 0.028, 1) if not river else (0.018, 0.030, 0.020, 1)
    P.inputs['Roughness'].default_value = 0.025
    P.inputs['IOR'].default_value = 1.333
    P.inputs['Specular IOR Level'].default_value = 0.5
    # Waves: two scales of 4D noise moving with time, as a bump.
    tm = nb.n('ShaderNodeValue'); tm.outputs[0].default_value = 0.0
    fc = tm.outputs[0].driver_add('default_value') if False else None
    pos = world_pos(nb)
    mapping = nb.n('ShaderNodeMapping'); mapping.inputs['Scale'].default_value = (1.0, 1.0, 4.0)
    nb.link(pos, mapping.inputs['Vector'])
    w_driver = nb.n('ShaderNodeValue')
    d = w_driver.outputs[0].driver_add('default_value').driver
    d.expression = 'frame / 24.0 * 0.35'
    big = nb.noise(mapping.outputs[0], scale=0.6, detail=3.0, rough=0.5, w=w_driver.outputs[0])
    small = nb.noise(mapping.outputs[0], scale=7.0, detail=6.0, rough=0.55, w=nb.math('MULTIPLY', w_driver.outputs[0], 2.3))
    h = nb.math('ADD', nb.math('MULTIPLY', big, 0.7), nb.math('MULTIPLY', small, 0.3))
    bump = nb.n('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.5 if not river else 0.2
    bump.inputs['Distance'].default_value = 0.12 if not river else 0.05
    nb.link(h, bump.inputs['Height'])
    nb.link(bump.outputs['Normal'], P.inputs['Normal'])
    return m


def falls_material(name):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; P = principled(nt); nb = NB(nt)
    pos = world_pos(nb)
    wd = nb.n('ShaderNodeValue'); wd.outputs[0].driver_add('default_value').driver.expression = 'frame / 24.0'
    mp = nb.n('ShaderNodeMapping'); nb.link(pos, mp.inputs['Vector'])
    loc = nb.n('ShaderNodeCombineXYZ'); nb.link(nb.math('MULTIPLY', wd.outputs[0], 3.0), loc.inputs['Z'])
    nb.link(loc.outputs[0], mp.inputs['Location']); mp.inputs['Scale'].default_value = (2.0, 2.0, 0.4)
    foam = nb.noise(mp.outputs[0], scale=3.0, detail=10.0, rough=0.7)
    c = nb.maprange(foam, 0.35, 0.75, 0.55, 0.95)
    cc = nb.n('ShaderNodeCombineXYZ'); [nb.link(c, cc.inputs[i]) for i in range(3)]
    nb.link(cc.outputs[0], P.inputs['Base Color'])
    P.inputs['Roughness'].default_value = 0.35
    P.inputs['Subsurface Weight'].default_value = 0.4
    P.inputs['Transmission Weight'].default_value = 0.2
    return m


def tower_material(name, L):
    """SpeedScan tower: the game's alpha-coded vertex colour (windows 0.3-0.7, lobby 0.75-0.95, lamps > 0.97)."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; P = principled(nt); nb = NB(nt)
    vc = nb.n('ShaderNodeVertexColor'); vc.layer_name = 'Color'
    a = nb.attr('_ALPHA', out='Fac')
    win = nb.math('MULTIPLY', nb.math('GREATER_THAN', a, 0.3), nb.math('LESS_THAN', a, 0.7))
    lobby = nb.math('MULTIPLY', nb.math('GREATER_THAN', a, 0.75), nb.math('LESS_THAN', a, 0.95))
    lamp = nb.math('GREATER_THAN', a, 0.97)
    geo = nb.n('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']; nrm = geo.outputs['Normal']
    sp = nb.n('ShaderNodeSeparateXYZ'); nb.link(pos, sp.inputs[0])
    sn = nb.n('ShaderNodeSeparateXYZ'); nb.link(nrm, sn.inputs[0])
    # Game frame: x = X, z = -Y, y = Z. Panels 3 m along the face, 3.8 m floors.
    along = nb.mixf(nb.math('GREATER_THAN', nb.math('ABSOLUTE', sn.outputs['X']), nb.math('ABSOLUTE', sn.outputs['Y'])), sp.outputs['X'], nb.math('MULTIPLY', sp.outputs['Y'], -1.0))
    cu = nb.math('FLOOR', nb.math('DIVIDE', along, 3.0)); cv = nb.math('FLOOR', nb.math('DIVIDE', sp.outputs['Z'], 3.8))
    fu = nb.math('FRACT', nb.math('DIVIDE', along, 3.0)); fv = nb.math('FRACT', nb.math('DIVIDE', sp.outputs['Z'], 3.8))
    side = nb.math('LESS_THAN', nb.math('ABSOLUTE', sn.outputs['Z']), 0.5)
    mull = nb.math('MULTIPLY', nb.math('MULTIPLY', win, side), nb.math('ADD', nb.math('ADD', nb.math('LESS_THAN', fu, 0.03), nb.math('GREATER_THAN', fu, 0.97)), nb.math('LESS_THAN', fv, 0.16), clamp=True))
    glass = nb.math('MULTIPLY', win, nb.math('SUBTRACT', 1.0, mull))
    cell = nb.n('ShaderNodeCombineXYZ'); nb.link(cu, cell.inputs[0]); nb.link(cv, cell.inputs[1])
    wn = nb.n('ShaderNodeTexWhiteNoise', noise_dimensions='3D'); nb.link(cell.outputs[0], wn.inputs['Vector'])
    # Each pane tilted a hair: broken, believable reflections.
    tilt = nb.n('ShaderNodeVectorMath', operation='SUBTRACT'); nb.link(wn.outputs['Color'], tilt.inputs[0]); tilt.inputs[1].default_value = (0.5, 0.5, 0.5)
    tsc = nb.n('ShaderNodeVectorMath', operation='SCALE'); nb.link(tilt.outputs[0], tsc.inputs[0]); tsc.inputs['Scale'].default_value = 0.018
    nadd = nb.n('ShaderNodeVectorMath', operation='ADD'); nb.link(nrm, nadd.inputs[0]); nb.link(tsc.outputs[0], nadd.inputs[1])
    nn = nb.n('ShaderNodeVectorMath', operation='NORMALIZE'); nb.link(nadd.outputs[0], nn.inputs[0])
    nmix = nb.n('ShaderNodeMix', data_type='VECTOR'); nb.link(glass, sock(nmix.inputs, 'Factor', 'VALUE'))
    nb.link(nrm, sock(nmix.inputs, 'A', 'VECTOR')); nb.link(nn.outputs[0], sock(nmix.inputs, 'B', 'VECTOR'))
    # Colours: stone/concrete from the vertex colour, glass a deep blue-grey, mullions dark anodised metal.
    pane = nb.mixc(wn.outputs['Value'], (0.035, 0.05, 0.065, 1), (0.06, 0.075, 0.09, 1))
    col = nb.mixc(glass, vc.outputs['Color'], pane)
    col = nb.mixc(mull, col, (0.03, 0.032, 0.035, 1))
    stone_bump = nb.noise(pos, scale=18.0, detail=6.0)
    bmp = nb.n('ShaderNodeBump'); bmp.inputs['Strength'].default_value = 0.08; nb.link(stone_bump, bmp.inputs['Height'])
    nb.link(sock(nmix.outputs, 'Result', 'VECTOR'), bmp.inputs['Normal'])
    nb.link(col, P.inputs['Base Color'])
    nb.link(nb.mixf(glass, nb.mixf(mull, 0.62, 0.32), 0.02), P.inputs['Roughness'])
    nb.link(nb.mixf(mull, nb.mixf(glass, 0.0, 0.25), 1.0), P.inputs['Metallic'])
    nb.link(bmp.outputs['Normal'], P.inputs['Normal'])
    # Lit offices at night (two in five), the lobby glowing, lamp bands.
    night = L.get('night', 0.0)
    lit = nb.math('GREATER_THAN', nb.n('ShaderNodeTexWhiteNoise', noise_dimensions='2D').outputs['Value'], 0.6)
    wn2 = nb.n('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
    cell2 = nb.n('ShaderNodeVectorMath', operation='SCALE'); nb.link(cell.outputs[0], cell2.inputs[0]); cell2.inputs['Scale'].default_value = 1.7
    nb.link(cell2.outputs[0], wn2.inputs['Vector'])
    lit = nb.math('GREATER_THAN', wn2.outputs['Value'], 0.6)
    emi = nb.math('ADD', nb.math('MULTIPLY', nb.math('MULTIPLY', glass, lit), 4.0 * night), nb.math('ADD', nb.math('MULTIPLY', lobby, 0.6 + 8.0 * night), nb.math('MULTIPLY', lamp, 1.0 + 25.0 * night)))
    P.inputs['Emission Color'].default_value = (1.0, 0.78, 0.5, 1)
    nb.link(emi, P.inputs['Emission Strength'])
    return m


def stink_lines(L, hq=(27.0, 32.0), t0=5.0):
    """The nine stink lines over the tower's crown (speedscanHQ.ts STINK), rebuilt as glowing green vapour tubes whose
    shape follows the game's vertex shader exactly, animated by Scene Time (geometry nodes)."""
    STINK = [[0, 350, -15, 150], [9, 349, -9, 130], [-9, 349, -21, 140], [10, 349, -22, 120], [-10, 349, -8, 135],
             [22, 323, -2, 95], [-22, 323, -28, 100], [22, 323, -28, 90], [-22, 323, -2, 105]]
    SEG = 60
    cd = bpy.data.curves.new('stink', 'CURVE'); cd.dimensions = '3D'
    for li, (x, y, z, ln) in enumerate(STINK):
        sp = cd.splines.new('POLY'); sp.points.add(SEG)
        for s in range(SEG + 1):
            sp.points[s].co = (hq[0] + x, -(hq[1] + z), y, 1.0)
    ob = bpy.data.objects.new('stink-lines', cd)
    bpy.context.scene.collection.objects.link(ob)
    # Attributes: t along the line, phase, length (per point; curves keep point attributes).
    me_attr = cd.attributes if hasattr(cd, 'attributes') else None
    gn = bpy.data.node_groups.new('stink-gn', 'GeometryNodeTree')
    gn.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    gn.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nt = gn.nodes; nb = NB(gn, x=-1600)
    gi = nb.n('NodeGroupInput'); go = nb.n('NodeGroupOutput')
    # t = point index within spline / SEG; line index = spline index.
    pi = nb.n('GeometryNodeSplineParameter')
    t = pi.outputs['Factor']
    sidx = nb.n('GeometryNodeInputIndex')
    # Spline index for a point: Interpolate from spline domain.
    capt = nb.n('GeometryNodeFieldOnDomain', domain='CURVE', data_type='INT')
    nb.link(sidx.outputs[0], capt.inputs[0])
    li = capt.outputs[0]
    # Per-line constants from small lookup: phase = li * 1.618 mod 1, len from a switch via math on li.
    ph = nb.math('FRACT', nb.math('MULTIPLY', li, 1.618))
    lens = [s[3] for s in STINK]
    ln = None
    for k, v in enumerate(lens):
        term = nb.math('MULTIPLY', nb.math('COMPARE', li, float(k), 0.5), float(v))
        ln = term if ln is None else nb.math('ADD', ln, term)
    tm = nb.n('GeometryNodeInputSceneTime')
    w = nb.math('ADD', tm.outputs['Seconds'], t0)
    y = nb.math('MULTIPLY', t, ln)
    amp = nb.math('ADD', 1.5, nb.math('MULTIPLY', t, 11.0))
    sx = nb.math('SINE', nb.math('ADD', nb.math('SUBTRACT', nb.math('MULTIPLY', y, 0.075), nb.math('MULTIPLY', w, 1.6)), nb.math('MULTIPLY', ph, 6.28)))
    sz = nb.math('SINE', nb.math('ADD', nb.math('SUBTRACT', nb.math('MULTIPLY', y, 0.058), nb.math('MULTIPLY', w, 1.15)), nb.math('ADD', nb.math('MULTIPLY', ph, 9.0), 1.3)))
    drift = nb.math('MULTIPLY', nb.math('MULTIPLY', nb.math('MULTIPLY', t, t), 38.0), nb.math('ADD', 0.75, nb.math('MULTIPLY', 0.25, nb.math('SINE', nb.math('ADD', nb.math('MULTIPLY', w, 0.13), nb.math('MULTIPLY', ph, 4.0))))))
    ox = nb.math('ADD', nb.math('MULTIPLY', sx, amp), nb.math('MULTIPLY', drift, 0.8))
    oz = nb.math('ADD', nb.math('MULTIPLY', sz, amp), nb.math('MULTIPLY', drift, 0.45))
    off = nb.n('ShaderNodeCombineXYZ'); nb.link(ox, off.inputs[0]); nb.link(nb.math('MULTIPLY', oz, -1.0), off.inputs[1]); nb.link(y, off.inputs[2])
    setp = nb.n('GeometryNodeSetPosition'); nb.link(gi.outputs[0], setp.inputs['Geometry']); nb.link(off.outputs[0], setp.inputs['Offset'])
    # Radius: the game's core is ~0.35 of its half width (mix(2.6, 1.0, t) * 2.2); the vapour reaches a little further.
    rad = nb.math('MULTIPLY', nb.mixf(t, 2.6, 1.0), 2.2 * 0.85)
    setr = nb.n('GeometryNodeSetCurveRadius'); nb.link(setp.outputs[0], setr.inputs['Curve']); nb.link(rad, setr.inputs['Radius'])
    # A real volume grid: points along each line (radius from the curve), turned into soft density.
    rs = nb.n('GeometryNodeResampleCurve'); nb.link(setr.outputs[0], rs.inputs['Curve'])
    try:
        rs.inputs['Count'].default_value = 260
    except Exception:
        pass
    c2p = nb.n('GeometryNodeCurveToPoints'); nb.link(rs.outputs[0], c2p.inputs['Curve'])
    try:
        c2p.mode = 'EVALUATED'
    except Exception:
        pass
    p2v = nb.n('GeometryNodePointsToVolume')
    nb.link(c2p.outputs['Points'], p2v.inputs['Points'])
    for nm, v in (('Density', 1.0), ('Voxel Size', 0.45)):
        try:
            p2v.inputs[nm].default_value = v
        except Exception:
            pass
    for nm, v in (('Resolution Mode', 'Size'), ('Resolution Mode', 'VOXEL_SIZE')):
        try:
            p2v.inputs[nm].default_value = v; break
        except Exception:
            try:
                p2v.resolution_mode = 'VOXEL_SIZE'; break
            except Exception:
                pass
    rr = nb.n('GeometryNodeInputRadius')
    nb.link(rr.outputs[0], p2v.inputs['Radius'])
    setm = nb.n('GeometryNodeSetMaterial'); nb.link(p2v.outputs[0], setm.inputs['Geometry'])
    nb.link(setm.outputs[0], go.inputs[0])
    mod = ob.modifiers.new('stink', 'NODES'); mod.node_group = gn
    # Material: a glowing volume (green vapour, denser at the core, fading at the ends) plus a faint surface sheen.
    m = bpy.data.materials.new('stink-vapour'); m.use_nodes = True
    mt = m.node_tree; mnb = NB(mt)
    out = [n for n in mt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    for n in list(mt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            mt.nodes.remove(n)
    # Volumes cannot read mesh attributes (the shading point is inside, not on the surface): t from height instead.
    zs = mnb.n('ShaderNodeSeparateXYZ'); mnb.link(world_pos(mnb), zs.inputs[0])
    ta = mnb.maprange(zs.outputs['Z'], 330.0, 470.0, 0.0, 1.0)
    ends = mnb.math('MULTIPLY', mnb.maprange(ta, 0.0, 0.05, 0.0, 1.0, smooth=True), mnb.maprange(ta, 0.62, 1.0, 1.0, 0.0, smooth=True))
    col = mnb.mixc(mnb.maprange(ta, 0.0, 0.9, 0.0, 1.0, smooth=True), (0.64 ** 2.2, 0.90 ** 2.2, 0.21 ** 2.2, 1), (0.09 ** 2.2, 0.64 ** 2.2, 0.29 ** 2.2, 1))
    pos = world_pos(mnb)
    wd = mnb.n('ShaderNodeValue'); wd.outputs[0].driver_add('default_value').driver.expression = 'frame / 24.0 * 0.6'
    wisp = mnb.noise(pos, scale=0.09, detail=6.0, rough=0.62, w=wd.outputs[0])
    grid = mnb.attr('density', out='Fac')
    dens = mnb.math('MULTIPLY', mnb.math('MULTIPLY', mnb.maprange(wisp, 0.25, 0.65, 0.25, 1.0), ends), grid)
    vol = mnb.n('ShaderNodeVolumePrincipled')
    mnb.link(col, vol.inputs['Color'])
    mnb.link(mnb.math('MULTIPLY', dens, 0.55), vol.inputs['Density'])
    mnb.link(col, vol.inputs['Emission Color'])
    mnb.link(mnb.math('MULTIPLY', dens, L.get('stink', 4.5 + 2.0 * L.get('night', 0.0))), vol.inputs['Emission Strength'])
    mnb.link(vol.outputs[0], out.inputs['Volume'])
    trn = mnb.n('ShaderNodeBsdfTransparent')
    mnb.link(trn.outputs[0], out.inputs['Surface'])
    ob.data.materials.append(m)
    setm.inputs['Material'].default_value = m
    return ob


# ---------------------------------------------------------------------------------------------------------------------
# Grass: blades scattered by geometry nodes on green ground near the camera.

def grass_blade_object():
    if 'grass-clump' in bpy.data.objects:
        return bpy.data.objects['grass-clump']
    import bmesh
    me = bpy.data.meshes.new('grass-clump')
    bm = bmesh.new()
    rnd = random.Random(7)
    for b in range(14):
        a = rnd.uniform(0, math.tau); r = rnd.uniform(0, 0.07)
        bx, by = math.cos(a) * r, math.sin(a) * r
        h = rnd.uniform(0.25, 0.55); w = rnd.uniform(0.008, 0.014)
        lean = rnd.uniform(0.05, 0.25); la = rnd.uniform(0, math.tau)
        tw = rnd.uniform(0, math.pi)
        prev = None
        for s in range(5):
            f = s / 4.0
            cx = bx + math.cos(la) * lean * f * f * h; cy = by + math.sin(la) * lean * f * f * h
            ww = w * (1 - f * 0.9)
            v1 = bm.verts.new((cx + math.cos(tw) * ww, cy + math.sin(tw) * ww, f * h))
            v2 = bm.verts.new((cx - math.cos(tw) * ww, cy - math.sin(tw) * ww, f * h))
            if prev:
                bm.faces.new((prev[0], prev[1], v2, v1))
            prev = (v1, v2)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('grass-clump', me)
    bpy.context.scene.collection.objects.link(ob)
    ob.hide_render = True; ob.hide_viewport = True
    m = bpy.data.materials.new('grass-blade'); m.use_nodes = True
    nt = m.node_tree; P = principled(nt); nb = NB(nt)
    oi = nb.n('ShaderNodeObjectInfo')
    c = nb.mixc(oi.outputs['Random'], (0.045, 0.075, 0.018, 1), (0.13, 0.12, 0.035, 1))
    nb.link(c, P.inputs['Base Color'])
    P.inputs['Roughness'].default_value = 0.45
    P.inputs['Subsurface Weight'].default_value = 0.0
    out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    tr = nb.n('ShaderNodeBsdfTranslucent'); nb.link(c, tr.inputs['Color'])
    mx = nb.n('ShaderNodeMixShader'); mx.inputs[0].default_value = 0.35
    nb.link(P.outputs[0], mx.inputs[1]); nb.link(tr.outputs[0], mx.inputs[2]); nb.link(mx.outputs[0], out.inputs['Surface'])
    me.materials.append(m)
    return ob


def scatter_grass(ground_objs, cam_points, radius=70.0, density=60.0):
    """Mark green, gentle, near-camera ground (vertex attribute 'grassmask') and instance clumps there."""
    import numpy as np
    blade = grass_blade_object()
    cams = np.array(cam_points, dtype=np.float32)
    gn = bpy.data.node_groups.get('grass-gn')
    if gn is None:
        gn = bpy.data.node_groups.new('grass-gn', 'GeometryNodeTree')
        gn.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
        gn.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
        nb = NB(gn, x=-1200)
        gi = nb.n('NodeGroupInput'); go = nb.n('NodeGroupOutput')
        na = nb.n('GeometryNodeInputNamedAttribute', data_type='FLOAT'); na.inputs['Name'].default_value = 'grassmask'
        dist = nb.n('GeometryNodeDistributePointsOnFaces', distribute_method='RANDOM')
        nb.link(gi.outputs[0], dist.inputs['Mesh'])
        # Random mode: Density is itself a field (the mask times the blades per square metre).
        nb.link(nb.math('MULTIPLY', na.outputs['Attribute'], density), sock(dist.inputs, 'Density'))
        oi = nb.n('GeometryNodeObjectInfo'); oi.inputs['Object'].default_value = blade
        rv = nb.n('FunctionNodeRandomValue', data_type='FLOAT'); rv.inputs['Min'].default_value = 0.0; rv.inputs['Max'].default_value = 6.283
        rot = nb.n('ShaderNodeCombineXYZ'); nb.link(rv.outputs[0], rot.inputs['Z'])
        # Blades stand up in world space, whatever the ground's tilt: align to world Z (rotation from the euler).
        rs = nb.n('FunctionNodeRandomValue', data_type='FLOAT'); rs.inputs['Min'].default_value = 0.6; rs.inputs['Max'].default_value = 1.35
        rs.inputs['Seed'].default_value = 3
        iop = nb.n('GeometryNodeInstanceOnPoints')
        nb.link(dist.outputs['Points'], iop.inputs['Points']); nb.link(oi.outputs['Geometry'], iop.inputs['Instance'])
        nb.link(rot.outputs[0], iop.inputs['Rotation']); nb.link(rs.outputs[0], iop.inputs['Scale'])
        join = nb.n('GeometryNodeJoinGeometry')
        nb.link(iop.outputs[0], join.inputs[0]); nb.link(gi.outputs[0], join.inputs[0])
        nb.link(join.outputs[0], go.inputs[0])
    n_marked = 0
    for ob in ground_objs:
        me = ob.data
        if 'Color' not in me.color_attributes:
            continue
        nv = len(me.vertices)
        co = np.empty(nv * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        mw = np.array(ob.matrix_world, dtype=np.float32)
        wco = co @ mw[:3, :3].T + mw[:3, 3]
        # Distance to the nearest camera sample (2D).
        d = np.full(nv, 1e9, np.float32)
        for c in cams[:: max(1, len(cams) // 12)]:
            d = np.minimum(d, np.hypot(wco[:, 0] - c[0], wco[:, 1] - c[1]))
        near = np.clip(1.0 - (d - radius * 0.5) / (radius * 0.5), 0, 1)
        ca = me.color_attributes['Color']
        cols = np.empty(len(ca.data) * 4, np.float32); ca.data.foreach_get('color', cols); cols = cols.reshape(-1, 4)
        if ca.domain == 'CORNER':
            vi = np.empty(len(me.loops), np.int32); me.loops.foreach_get('vertex_index', vi)
            vc = np.zeros((nv, 4), np.float32); vc[vi] = cols
        else:
            vc = cols
        r, g, b = vc[:, 0], vc[:, 1], vc[:, 2]
        green = np.clip((g - np.maximum(r, b) * 1.02) * 12.0, 0, 1)
        nrm = np.empty(nv * 3, np.float32); me.vertices.foreach_get('normal', nrm); nrm = nrm.reshape(-1, 3) @ mw[:3, :3].T
        flat = np.clip((nrm[:, 2] / (np.linalg.norm(nrm, axis=1) + 1e-6) - 0.75) * 5, 0, 1)
        mask = green * near * flat
        if mask.max() <= 0.01:
            continue
        at = me.attributes.get('grassmask') or me.attributes.new('grassmask', 'FLOAT', 'POINT')
        at.data.foreach_set('value', mask.astype(np.float32))
        mod = ob.modifiers.new('grass', 'NODES'); mod.node_group = gn
        n_marked += 1
    return n_marked


# ---------------------------------------------------------------------------------------------------------------------
# Sky, sun, atmosphere.

def setup_world(L, sun_dir_b, cam_fwd=None):
    sc = bpy.context.scene
    w = bpy.data.worlds.new('trailer-sky'); sc.world = w; w.use_nodes = True
    nt = w.node_tree; nb = NB(nt)
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nb.n('ShaderNodeOutputWorld')
    sky = nb.n('ShaderNodeTexSky')
    types = [e.identifier for e in sky.bl_rna.properties['sky_type'].enum_items]
    sky.sky_type = 'MULTIPLE_SCATTERING' if 'MULTIPLE_SCATTERING' in types else ('NISHITA' if 'NISHITA' in types else types[0])
    # Direction: the game's sun azimuth unless the look sets one; the look sets the elevation.
    # Blender's sky: rotation is a compass azimuth (0 = +Y, 90 = +X), dir = (sin r, cos r); checked on renders.
    az = math.atan2(sun_dir_b.x, sun_dir_b.y) if L.get('sun_az') is None else math.radians(L['sun_az'])
    el = math.radians(L['sun_elev'])
    for k, v in (('sun_elevation', el), ('sun_rotation', az), ('sun_disc', True), ('sun_size', math.radians(0.545)), ('sun_intensity', 1.0),
                 ('air_density', L['air']), ('aerosol_density', L['aerosol']), ('dust_density', L['aerosol']), ('ozone_density', L['ozone']), ('altitude', 30.0)):
        if hasattr(sky, k):
            try:
                setattr(sky, k, v)
            except Exception:
                pass
    bg = nb.n('ShaderNodeBackground'); bg.inputs['Strength'].default_value = L['sky_strength']
    nb.link(sky.outputs['Color'], bg.inputs['Color'])
    surf = bg.outputs[0]
    if L.get('ambient'):
        am = L['ambient']
        col = (am[0], am[1], am[2], 1)
        tc = nb.n('ShaderNodeTexCoord')
        sp = nb.n('ShaderNodeSeparateXYZ'); nb.link(tc.outputs['Generated'], sp.inputs[0])
        if L.get('horizon'):
            hz = L['horizon']
            band = nb.maprange(nb.math('ABSOLUTE', sp.outputs['Z']), 0.0, 0.16, 1.0, 0.0, smooth=True)
            cloud = nb.maprange(nb.noise(tc.outputs['Generated'], scale=3.0, detail=6.0, rough=0.6), 0.3, 0.75, 0.55, 1.15)
            cc = nb.n('ShaderNodeCombineXYZ'); [nb.link(cloud, cc.inputs[k]) for k in range(3)]
            col = nb.mixc(nb.math('MULTIPLY', band, band), nb.mixc(1.0, col, cc.outputs[0], 'MULTIPLY'), (hz[0] * hz[3], hz[1] * hz[3], hz[2] * hz[3], 1))
        if L.get('stars'):
            vor = nb.n('ShaderNodeTexVoronoi'); vor.inputs['Scale'].default_value = 260.0
            nb.link(tc.outputs['Generated'], vor.inputs['Vector'])
            st = nb.maprange(vor.outputs['Distance'], 0.0, 0.035, 1.0, 0.0)
            tw = nb.n('ShaderNodeSeparateColor'); nb.link(vor.outputs['Color'], tw.inputs[0])
            st = nb.math('MULTIPLY', nb.math('MULTIPLY', st, nb.math('POWER', tw.outputs[0], 6.0)), nb.maprange(sp.outputs['Z'], 0.02, 0.3, 0.0, 26.0))
            sc3 = nb.n('ShaderNodeCombineXYZ'); [nb.link(st, sc3.inputs[k]) for k in range(3)]
            col = nb.mixc(1.0, col if not isinstance(col, tuple) else nb.mixc(0.0, col, col), sc3.outputs[0], 'ADD')
        b2 = nb.n('ShaderNodeBackground'); b2.inputs['Strength'].default_value = am[3]
        nb.val(b2.inputs['Color'], col)
        add = nb.n('ShaderNodeAddShader'); nb.link(surf, add.inputs[0]); nb.link(b2.outputs[0], add.inputs[1])
        surf = add.outputs[0]
    nb.link(surf, out.inputs['Surface'])
    # Aerial haze lives in a big box around the camera (haze_box below): a world volume would swallow the sky and
    # the sun completely, since rays to infinity cross an infinite amount of it.
    # The sun lamp, aimed the same way as the sky's sun.
    if L.get('lamp_elev') is not None:
        el = math.radians(L['lamp_elev'])
    sd = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    ld = bpy.data.lights.new('sun', 'SUN'); ld.energy = L['sun_strength']; ld.angle = math.radians(L['sun_angle'])
    # Warm low sun, white high sun (the sky texture colours the sky; the lamp needs its own colour).
    warm = max(0.0, min(1.0, (15.0 - L['sun_elev']) / 15.0))
    ld.color = L.get('sun_color') or (1.0, 1.0 - 0.32 * warm, 1.0 - 0.62 * warm)
    try:
        ld.volume_factor = 1.0
    except Exception:
        pass
    ob = bpy.data.objects.new('sun', ld); sc.collection.objects.link(ob)
    ob.rotation_euler = (-sd).to_track_quat('-Z', 'Y').to_euler()
    if L['sun_strength'] <= 0:
        ob.hide_render = True
    # Fill: a broad, soft, shadowless light from the camera's side, so backlit facades keep their detail
    # (the mill was a black block in the proof). Cool, like sky bounce; strength relative to the look.
    if L.get('fill') and cam_fwd is not None:
        fd = bpy.data.lights.new('fill', 'SUN'); fd.energy = L['fill']; fd.angle = math.radians(60)
        fd.color = L.get('fill_color', (0.80, 0.88, 1.0))
        try:
            fd.use_shadow = False
        except Exception:
            pass
        fo = bpy.data.objects.new('fill', fd); sc.collection.objects.link(fo)
        f = Vector((cam_fwd[0], cam_fwd[1], 0.0))
        if f.length < 1e-3:
            f = Vector((0, 1, 0))
        f.normalize()
        d = Vector((f.x, f.y, -0.45)).normalized()      # shining along the view, from a little above
        fo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        try:
            fo.visible_glossy = False
        except Exception:
            pass
    return sd


def make_box(name, loc):
    import bmesh
    me = bpy.data.meshes.new(name); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); ob.location = loc
    return ob


def haze_box(L, center, size=5000.0, height=700.0):
    """Aerial perspective and god rays: a homogeneous scattering volume in a box around the camera path."""
    if L.get('haze', 0) <= 0 or L.get('haze_mode', 'comp') != 'volume':
        return None
    ob = make_box('haze', (center[0], center[1], height * 0.5 - 50.0))
    ob.scale = (size, size, height)
    m = bpy.data.materials.new('haze'); m.use_nodes = True
    nt = m.node_tree; nb = NB(nt)
    out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    for n in list(nt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            nt.nodes.remove(n)
    vol = nb.n('ShaderNodeVolumePrincipled')
    vol.inputs['Density'].default_value = L['haze']
    vol.inputs['Color'].default_value = (*L['haze_color'], 1)
    vol.inputs['Anisotropy'].default_value = L['haze_aniso']
    nb.link(vol.outputs[0], out.inputs['Volume'])
    ob.data.materials.append(m)
    try:
        ob.visible_shadow = True
    except Exception:
        pass
    return ob


def ground_mist(L, center, size=900.0):
    """A low mist layer (river morning): a flat box of volume, densest at the water, thinning by mist['top'] metres."""
    mi = L.get('mist')
    if not mi:
        return None
    ob = make_box('mist', (center[0], center[1], mi.get('base', 0.0) + mi['top'] * 0.5))
    ob.scale = (size, size, mi['top'])
    m = bpy.data.materials.new('mist'); m.use_nodes = True
    nt = m.node_tree; nb = NB(nt)
    out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'][0]
    for n in list(nt.nodes):
        if n.type == 'BSDF_PRINCIPLED':
            nt.nodes.remove(n)
    pos = world_pos(nb)
    sp = nb.n('ShaderNodeSeparateXYZ'); nb.link(pos, sp.inputs[0])
    base = mi.get('base', 0.0)
    hk = nb.maprange(sp.outputs['Z'], base, base + mi['top'], 1.0, 0.0, smooth=True)
    wd = nb.n('ShaderNodeValue'); wd.outputs[0].driver_add('default_value').driver.expression = 'frame / 24.0 * 0.05'
    nz = nb.maprange(nb.noise(pos, scale=0.02, detail=4.0, rough=0.55, w=wd.outputs[0]), 0.35, 0.7, 0.2, 1.0)
    dens = nb.math('MULTIPLY', nb.math('MULTIPLY', hk, nz), mi['density'])
    vol = nb.n('ShaderNodeVolumePrincipled'); vol.inputs['Color'].default_value = (1, 1, 1, 1); vol.inputs['Anisotropy'].default_value = 0.6
    nb.link(dens, vol.inputs['Density']); nb.link(vol.outputs[0], out.inputs['Volume'])
    ob.data.materials.append(m)
    ob.visible_shadow = False if hasattr(ob, 'visible_shadow') else None
    return ob


def lens_mesh():
    me = bpy.data.meshes.get('lamp-lens')
    if me:
        return me
    import bmesh
    me = bpy.data.meshes.new('lamp-lens'); bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.28, radius2=0.22, depth=0.06)
    bm.to_mesh(me); bm.free()
    m = bpy.data.materials.new('lamp-lens'); m.use_nodes = True
    P = principled(m.node_tree); P.inputs['Base Color'].default_value = (1, 0.9, 0.75, 1)
    P.inputs['Emission Color'].default_value = (1.0, 0.82, 0.6, 1); P.inputs['Emission Strength'].default_value = 60.0
    me.materials.append(m)
    return me


def add_lamp_lights(lamp_points, L, cam_pts=None):
    """Street lamps as real lights (warm sodium-white LEDs) at the lamp heads."""
    if not L.get('lamps'):
        return 0
    n = 0
    # Real lights only near the camera (the far ones are a lit lens: cheaper, and it does not show).
    near = None
    if cam_pts:
        import numpy as np
        cp = np.array(cam_pts[:: max(1, len(cam_pts) // 8)], dtype=np.float32)
        lp = np.array(lamp_points, dtype=np.float32).reshape(-1, 3)
        d = np.sqrt(((lp[:, None, :] - cp[None, :, :]) ** 2).sum(-1)).min(1) if len(lp) else np.zeros(0)
        order = np.argsort(d)
        near = set(int(i) for i in order[: int(L.get('lamp_max', 90))] if d[i] < float(L.get('lamp_dist', 220.0)))
    for li, p in enumerate(lamp_points):
        if near is not None and li not in near:
            bulb = bpy.data.objects.new('lamp-lens', lens_mesh()); bpy.context.scene.collection.objects.link(bulb)
            bulb.location = (p[0], p[1], p[2] + 0.05)
            continue
        # A cobra head: a wide spot aimed down (no light thrown up the facades), a small visible source.
        ld = bpy.data.lights.new('lamp', 'SPOT'); ld.energy = 650.0 * L.get('night', 1.0); ld.shadow_soft_size = 0.15
        ld.spot_size = math.radians(140); ld.spot_blend = 0.6
        ld.color = (1.0, 0.80, 0.55)
        ob = bpy.data.objects.new('lamp', ld); bpy.context.scene.collection.objects.link(ob)
        ob.location = p
        # The lit lens under the head, seen by the camera and in reflections.
        bulb = bpy.data.objects.new('lamp-lens', lens_mesh()); bpy.context.scene.collection.objects.link(bulb)
        bulb.location = (p[0], p[1], p[2] + 0.05)
        n += 1
    return n


# ---------------------------------------------------------------------------------------------------------------------
# Camera, colour management, compositor, render settings.

def camera_look(cam, L, shake=0.0, focus=None):
    cd = cam.data
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = L.get('fstop', 4.0)
    cd.dof.aperture_blades = 7
    cd.dof.aperture_ratio = 1.0
    if focus is not None and cd.animation_data and cd.animation_data.action:
        # A fixed focus distance: drop the keyed one.
        act = cd.animation_data.action
        try:
            fcs = list(act.fcurves)
        except Exception:
            fcs = [fc for layer in act.layers for strip in layer.strips for cb in strip.channelbags for fc in cb.fcurves]
        for fc in fcs:
            if fc.data_path == 'dof.focus_distance':
                for kp in fc.keyframe_points:
                    kp.co[1] = focus
                    kp.handle_left[1] = focus; kp.handle_right[1] = focus
                fc.update()
        cd.dof.focus_distance = focus
    if shake > 0 and cam.animation_data and cam.animation_data.action:
        act = cam.animation_data.action
        fcs = []
        try:
            fcs = [fc for fc in act.fcurves if fc.data_path == 'rotation_euler']
        except Exception:
            for layer in getattr(act, 'layers', []):
                for strip in layer.strips:
                    for cb in strip.channelbags:
                        fcs += [fc for fc in cb.fcurves if fc.data_path == 'rotation_euler']
        for fc in fcs:
            mod = fc.modifiers.new('NOISE')
            mod.scale = 18.0 + fc.array_index * 5
            mod.strength = shake * (0.004 if fc.array_index != 1 else 0.0015)
            mod.phase = 3.0 + fc.array_index * 11.0


def color_and_comp(L):
    sc = bpy.context.scene
    vs = sc.view_settings
    for vt in ('AgX', 'Filmic'):
        try:
            vs.view_transform = vt
            break
        except Exception:
            pass
    for lk in (L.get('look', 'Medium High Contrast'), 'AgX - ' + L.get('look', 'Medium High Contrast'), 'None'):
        try:
            vs.look = lk
            break
        except Exception:
            pass
    vs.exposure = L.get('exposure', 0.0)
    # Compositor (5.x: a node group on the scene).
    ng = bpy.data.node_groups.new('trailer-grade', 'CompositorNodeTree')
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    nb = NB(ng, x=-600)
    rl = nb.n('CompositorNodeRLayers')
    go = nb.n('NodeGroupOutput')
    img = rl.outputs['Image']
    gl = nb.n('CompositorNodeGlare')
    def setin(node, name, vals):
        for v in vals:
            try:
                node.inputs[name].default_value = v
                return True
            except Exception:
                continue
        return False
    setin(gl, 'Type', ['Bloom', 'BLOOM', 'Fog Glow', 'FOG_GLOW'])
    setin(gl, 'Quality', ['High', 'HIGH'])
    setin(gl, 'Threshold', [1.0])
    setin(gl, 'Strength', [L.get('bloom', 0.6) * 0.5])
    setin(gl, 'Size', [0.6, 7])
    if L.get('haze', 0) > 0 and L.get('haze_mode', 'comp') == 'comp':
        # Aerial haze from the mist pass (depth), not a volume: the same fade with distance at a fraction of the cost.
        # (Shots that need light shafts or beams keep the real volume: haze_mode 'volume'.)
        D = 4000.0
        w = sc.world
        if w:
            w.mist_settings.start = 0.0; w.mist_settings.depth = D; w.mist_settings.falloff = 'LINEAR'
        for vl in sc.view_layers:
            vl.use_pass_mist = True
        mist = rl.outputs['Mist']
        # The pass is not denoised (and is noisy through glass and volumes): denoise it; the sky (mist 1) takes a fixed share.
        try:
            ds = nb.n('CompositorNodeDespeckle'); nb.link(mist, ds.inputs['Image']); mist = ds.outputs['Image']
        except Exception as e:
            print('mist despeckle skipped:', e)
        try:
            dn = nb.n('CompositorNodeDenoise'); nb.link(mist, dn.inputs['Image']); mist = dn.outputs['Image']
        except Exception as e:
            print('mist denoise skipped:', e)
        ex = nb.math('EXPONENT', nb.math('MULTIPLY', mist, -D * L['haze'] * L.get('haze_k', 1.0)))
        fac = nb.math('SUBTRACT', 1.0, ex)
        if L.get('haze_sky') is not None:
            # Fog looks: the sky keeps a fixed share (the fog bank is not infinitely deep). Not for thin haze: an edge
            # pixel's blended depth must fall between its two neighbours' or foreground objects get a fringe.
            sky = nb.math('GREATER_THAN', mist, 0.995)
            fac = nb.mixf(sky, fac, L['haze_sky'])
        hl = L.get('haze_lum', 1.0); hc = L['haze_color']
        mxh = nb.n('ShaderNodeMix', data_type='RGBA', blend_type='MIX')
        nb.link(fac, sock(mxh.inputs, 'Factor', 'VALUE')); nb.link(img, sock(mxh.inputs, 'A', 'RGBA'))
        sock(mxh.inputs, 'B', 'RGBA').default_value = (hc[0] * hl, hc[1] * hl, hc[2] * hl, 1.0)
        img = sock(mxh.outputs, 'Result', 'RGBA')
    nb.link(img, gl.inputs['Image']); img = gl.outputs['Image']
    ld = nb.n('CompositorNodeLensdist')
    setin(ld, 'Distortion', [-0.006]); setin(ld, 'Dispersion', [0.012])
    nb.link(img, ld.inputs['Image']); img = ld.outputs['Image']
    # Vignette: an elliptical mask, blurred, multiplied in.
    try:
        em = nb.n('CompositorNodeEllipseMask')
        setin(em, 'Size', [(0.92, 0.78)]); setin(em, 'Width', [0.92]); setin(em, 'Height', [0.78])
        bl = nb.n('CompositorNodeBlur')
        setin(bl, 'Size', [(220, 220)])
        nb.link(em.outputs[0], bl.inputs['Image'])
        mr = nb.n('CompositorNodeMapRange')
        setin(mr, 'To Min', [0.72])
        nb.link(bl.outputs[0], mr.inputs[0])
        mx = nb.n('CompositorNodeMixRGB') if hasattr(bpy.types, 'CompositorNodeMixRGB') else nb.n('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY')
        if mx.bl_idname == 'CompositorNodeMixRGB':
            mx.blend_type = 'MULTIPLY'; nb.link(img, mx.inputs[1]); nb.link(mr.outputs[0], mx.inputs[2]); img = mx.outputs[0]
        else:
            sock(mx.inputs, 'Factor', 'VALUE').default_value = 1.0
            nb.link(img, sock(mx.inputs, 'A', 'RGBA')); nb.link(mr.outputs[0], sock(mx.inputs, 'B', 'RGBA')); img = sock(mx.outputs, 'Result', 'RGBA')
    except Exception as e:
        print('vignette skipped:', e)
    nb.link(img, go.inputs[0])
    if hasattr(sc, 'compositing_node_group'):
        sc.compositing_node_group = ng
    try:
        sc.render.use_compositing = True
    except Exception:
        pass


def enable_gpu():
    """OptiX on the RTX, for this session. The device choice lives in the user preferences, not in the .blend: every
    Blender that renders must call this, or Cycles silently renders on the CPU (four to five times slower here)."""
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    n = 0
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
        n += d.use
    bpy.context.scene.cycles.device = 'GPU'
    return n


def render_settings(engine, samples=None, res=(1280, 720), pct=100, fps=24, mblur=True, threshold=0.02, shutter=0.3):
    sc = bpy.context.scene
    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = res[0], res[1], pct
    r.fps = fps
    r.use_motion_blur = mblur
    if hasattr(r, 'motion_blur_shutter'):
        r.motion_blur_shutter = shutter
    try:
        r.motion_blur_position = 'START'
    except Exception:
        pass
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_depth = '16' if False else '8'
    r.use_persistent_data = True
    r.film_transparent = False
    if engine == 'CYCLES':
        r.engine = 'CYCLES'
        c = sc.cycles
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        c.device = 'GPU'
        c.samples = samples or 128
        c.use_adaptive_sampling = True
        c.adaptive_threshold = threshold
        c.adaptive_min_samples = 32
        c.use_denoising = True
        try:
            c.denoiser = 'OPENIMAGEDENOISE'
            c.denoising_use_gpu = True
            c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
            c.denoising_prefilter = 'ACCURATE'
        except Exception:
            c.denoiser = 'OPTIX'
        c.max_bounces = 6; c.diffuse_bounces = 3; c.glossy_bounces = 3; c.transmission_bounces = 6
        c.volume_bounces = 1; c.transparent_max_bounces = 16
        c.caustics_reflective = False; c.caustics_refractive = False
        c.sample_clamp_indirect = 10.0
        c.sample_clamp_direct = 0.0
        c.blur_glossy = 1.0
        c.use_light_tree = True
        c.volume_step_rate = 4.0 if hasattr(c, 'volume_step_rate') else None
        c.texture_limit_render = 'OFF'
    else:
        r.engine = 'BLENDER_EEVEE'
        e = sc.eevee
        e.taa_render_samples = samples or 96
        e.use_raytracing = True
        try:
            e.ray_tracing_method = 'SCREEN'
            e.ray_tracing_options.resolution_scale = '2'
            e.ray_tracing_options.use_denoise = True
        except Exception:
            pass
        e.use_fast_gi = True
        e.fast_gi_method = 'GLOBAL_ILLUMINATION'
        e.use_shadows = True; e.shadow_ray_count = 2; e.shadow_step_count = 8
        e.volumetric_tile_size = '4'; e.volumetric_samples = 96; e.use_volumetric_shadows = True
        e.volumetric_end = 2500.0
        e.motion_blur_steps = 2
