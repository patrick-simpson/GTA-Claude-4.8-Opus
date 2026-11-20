// The paint shelf: every material the world builders share. One instance of each,
// because every extra material is one more draw call per map chunk.
//
// HOW TO USE (world builders)
//   * Everything here has vertexColors on. Batch.quad/box/walls take a hex colour and
//     a shade, and that is what tints the (deliberately pale) textures. Pass 0xffffff
//     to show a texture as painted.
//   * Geometry with no texture goes in `flat` (or `flatDouble` for thin things seen
//     from both sides: awnings, flags, leaves).
//   * Anything lying on the road or ground uses `marks` (road paint atlas) or `decal`
//     (plain colour). Both are polygon-offset, so lay them at the SAME height as the
//     surface below; do not lift them.
//   * UV conventions for each texture are in the header of textures.ts.
//   * Do not change these materials per building. setNight() owns the emissive
//     levels and the glow opacity, setWet() the roughness and tone of the ground,
//     setEnv() the reflection map.
//
// WHAT THEY ARE
//   On medium and high every surface is a MeshStandardMaterial with the roughness /
//   metalness sheet textures.ts derived from its paint (tex.pbr); high adds the normal map. Reflections
//   are the sky's own PMREM. On low (phones), and with `?pbr=0` in the address for an
//   A/B, they are the MeshLambertMaterials the game shipped M1 with: no extra maps, no
//   reflections. Builders never need to know which: both take vertex colours, a map and
//   an emissive map the same way.

import * as THREE from 'three';
import type { Quality } from '../core/api';
import type { Textures } from './textures';
import { smooth } from '../core/util';

/** Either kind of city material. Standard on medium and high, Lambert on low. */
export type Surface = THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;

/** What both kinds accept, so one description builds either. */
type Common = Pick<THREE.MeshStandardMaterialParameters,
  'side' | 'alphaTest' | 'transparent' | 'polygonOffset' | 'polygonOffsetFactor' | 'polygonOffsetUnits' | 'depthWrite' |
  'emissive' | 'emissiveMap' | 'emissiveIntensity'>;

interface Look extends Common {
  /** Roughness where there is no roughness sheet (untextured and atlas materials). */
  rough?: number;
  metal?: number;
  /** Reflection strength, as a multiple of the shelf's base level. */
  env?: number;
  /** Scale on the normal map; 0 leaves it off. */
  bump?: number;
}

// The sky's hemisphere light was tuned for materials that ignore the reflection map. A standard
// material also takes diffuse light from that map, so at full strength every wall gets its sky
// light twice and the town bleaches. This keeps the reflections and gives most of the fill back.
const ENV = 0.32;

export class CityMaterials {
  /** Wall materials for Batch.walls(..., tiles = 8): 0 glass tower, 1 brick, 2 stucco, 3 corrugated metal. Windows light up at night. */
  readonly facade: Surface[];
  /** Vertex colour only. The workhorse for untextured Batch geometry. */
  readonly flat: Surface;
  /** `flat`, visible from both sides. */
  readonly flatDouble: Surface;
  /** Ground-floor atlas (tex.kit): shopfronts, doors, garage, rowhouse, dock, awnings. Shop windows light up at night. */
  readonly kit: Surface;
  /** Sign atlas (tex.signs). Alpha-tested for the round hanging signs; gently self-lit at night so it stays readable. */
  readonly sign: Surface;

  /** 12 m street: u across the full width, v along it at 12 m per repeat. */
  readonly street: Surface;
  /** 20 m avenue: u across the full width, v along it at 12 m per repeat. */
  readonly avenue: Surface;
  /** Bare asphalt for intersections and lots. World-space uv / TILE_M.asphalt. */
  readonly asphalt: Surface;
  readonly sidewalk: Surface;
  readonly grass: Surface;
  readonly sand: Surface;
  /** Planks run along v. Pier, boardwalk, clapboard. */
  readonly wood: Surface;
  readonly cobble: Surface;
  readonly roofGravel: Surface;
  /** Terracotta barrel tile; v climbs the slope. Double-sided so open gables do not show through. */
  readonly roofTile: Surface;
  /** Asphalt shingle, pale so it tints; v climbs the slope. Double-sided. */
  readonly shingle: Surface;
  /** Corrugated sheet, ribs along v. Double-sided: sawtooth roofs, sheds, canopies. */
  readonly corrugated: Surface;
  /** Shipping container strip (CONTAINER_UV in textures.ts). Tint with the vertex colour. */
  readonly container: Surface;
  /** Stunt-ramp chevrons pointing toward +v. */
  readonly ramp: Surface;
  /** Chain link, picket and railing (FENCE_UV). Alpha-tested and double-sided. */
  readonly fence: Surface;

  /** Road paint atlas (tex.marks) as a ground decal: crosswalks, stop lines, stall lines, arrows, manholes. */
  readonly marks: Surface;
  /** Plain vertex-colour ground decal: painted boxes, court lines, puddle-dark patches. */
  readonly decal: Surface;

  /**
   * Additive glow sprite for lamp halos and light pools. The vertex colour is the lamp
   * colour; it is invisible by day and setNight() fades it in. Not fogged, not depth-written.
   */
  readonly glow: THREE.MeshBasicMaterial;

  /** Last value given to setNight: 0 day .. 1 night. */
  night = 0;
  /** Last value given to setWet: 0 dry .. 1 soaked. */
  wet = 0;
  /** True when the shelf is physically based (medium and high). */
  readonly pbr: boolean;

  /** Ground that rain soaks: [material, dry roughness, soaked roughness, how much it darkens, dry reflection level, dry tone]. */
  private soak: [THREE.MeshStandardMaterial, number, number, number, number, number][] = [];
  /** 0..1 for the puddle shader on the roads; one object shared by every program that reads it. */
  private wetU = { value: 0 };
  private std: THREE.MeshStandardMaterial[] = [];

  constructor(readonly tex: Textures, readonly quality: Quality) {
    this.pbr = quality.name !== 'low' && new URLSearchParams(location.search).get('pbr') !== '0';

    // Glass wants the whole sky in it; brick and plaster only a breath of it.
    const wallEnv = [2.9, 1.2, 1.2, 1.7];
    this.facade = tex.facade.map((f, i) => this.mat(f.map, { emissive: 0xffffff, emissiveMap: f.glow, emissiveIntensity: 0, env: wallEnv[i] }));
    this.flat = this.mat(null, { rough: 0.78 });
    this.flatDouble = this.mat(null, { rough: 0.78, side: THREE.DoubleSide });
    this.kit = this.mat(tex.kit.tex, { emissive: 0xffffff, emissiveMap: tex.kit.glow, emissiveIntensity: 0, env: 2.1 });
    // The sign lights itself with its own picture, so a lit sign keeps its colours.
    this.sign = this.mat(tex.signs.tex, { emissive: 0xffffff, emissiveMap: tex.signs.tex, emissiveIntensity: 0, alphaTest: 0.5, rough: 0.55 });

    this.street = this.mat(tex.street);
    this.avenue = this.mat(tex.avenue);
    this.asphalt = this.mat(tex.asphalt);
    this.sidewalk = this.mat(tex.sidewalk);
    this.grass = this.mat(tex.grass, { env: 0.8 });
    this.sand = this.mat(tex.sand);
    this.wood = this.mat(tex.wood);
    this.cobble = this.mat(tex.cobble);
    this.roofGravel = this.mat(tex.roofGravel);
    this.roofTile = this.mat(tex.roofTile, { side: THREE.DoubleSide });
    this.shingle = this.mat(tex.shingle, { side: THREE.DoubleSide });
    this.corrugated = this.mat(tex.corrugated, { side: THREE.DoubleSide, env: 1.8 });
    this.container = this.mat(tex.container, { env: 1.6 });
    this.ramp = this.mat(tex.ramp);
    // A low threshold keeps the wire from vanishing as soon as the mipmaps thin it out.
    this.fence = this.mat(tex.fence, { alphaTest: 0.28, side: THREE.DoubleSide, rough: 0.6 });

    // Decals sit exactly on the surface under them and win the depth test by offset,
    // which holds at any distance; lifting them a few centimeters flickers far away.
    const onGround: Common = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false };
    this.marks = this.mat(tex.marks.tex, { transparent: true, rough: 0.5, ...onGround });
    this.decal = this.mat(null, { rough: 0.8, ...onGround });

    this.glow = new THREE.MeshBasicMaterial({
      map: tex.glow, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, fog: false, opacity: 0,
    });
    // Through the post pass a bulb may be brighter than white, which is what lets the bloom find the Ferris wheel's
    // bulbs and the pier's lamps; low has no such range.
    if (quality.name !== 'low') this.glow.color.setScalar(1.5);
    this.glow.visible = false;

    // Rain: asphalt goes dark and glossy, concrete and stone less so, planks and paint in between.
    // The roads also sit a shade darker than their paint: that was mixed pale for a material that
    // took no light from the sky, and under this one it bleached to concrete.
    for (const road of [this.street, this.avenue, this.asphalt]) this.soaks(road, 0.5, 0.3, 0.84, true);
    this.soaks(this.sidewalk, 0.42, 0.27); this.soaks(this.cobble, 0.36, 0.3); this.soaks(this.wood, 0.5, 0.25);
    this.soaks(this.marks, 0.36, 0.12); this.soaks(this.decal, 0.45, 0.2); this.soaks(this.ramp, 0.5, 0.15);
  }

  private mat(map: THREE.Texture | null, look: Look = {}): Surface {
    const { rough = 0.85, metal = 0, env = 1, bump = 1, ...common } = look;
    if (!this.pbr) return new THREE.MeshLambertMaterial({ map, vertexColors: true, fog: true, ...common });
    const twins = map ? this.tex.pbr.get(map) : undefined;
    const m = new THREE.MeshStandardMaterial({
      map, vertexColors: true, fog: true, ...common,
      // With a sheet, the sheet is the roughness and these scale it; setWet() turns the ground's down.
      roughness: twins ? 1 : rough, metalness: twins ? 1 : metal,
      envMapIntensity: ENV * env,
    });
    if (twins) {
      m.roughnessMap = twins.orm; m.metalnessMap = twins.orm;
      // Medium keeps the roughness sheet (glass against wall, wet against dry: one cheap sample) and
      // drops the relief, which is the dearer half of what these materials cost a weak GPU.
      if (bump > 0 && this.quality.name === 'high') { m.normalMap = twins.normal; m.normalScale.setScalar(bump); }
    }
    this.std.push(m);
    return m;
  }

  private soaks(s: Surface, wetRough: number, darken: number, tone = 1, puddles = false): void {
    if (!(s instanceof THREE.MeshStandardMaterial)) return;
    this.soak.push([s, s.roughness, s.roughness * wetRough, darken, s.envMapIntensity, tone]);
    s.color.setScalar(tone);
    if (!puddles) return;
    // Water does not lie evenly. Wherever the road's roughness sheet says the surface is closed and
    // smooth (tire ruts, tar, paint, the broad polished patches) it stands as a film: flat, dark
    // and mirror-smooth. The wetter the road, the further up the sheet the water reaches. All
    // three roads share one program because the hook's text is the same.
    const wet = this.wetU;
    s.onBeforeCompile = (sh) => {
      sh.uniforms.uWet = wet;
      sh.fragmentShader = 'uniform float uWet;\n' + sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          float puddle = 0.0;
          #ifdef USE_ROUGHNESSMAP
            float pLo = mix( 0.3, 0.82, uWet );
            puddle = uWet * ( 1.0 - smoothstep( pLo, pLo + 0.1, texelRoughness.g ) );
            roughnessFactor = mix( roughnessFactor, 0.035, puddle );
            diffuseColor.rgb *= 1.0 - 0.3 * puddle;
          #endif`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          normal = normalize( mix( normal, nonPerturbedNormal, puddle ) );`);
    };
  }

  /** n: 0 = full day, 1 = full night. Raises window glow, sign self-illumination and lamp halos. */
  setNight(n: number): void {
    this.night = n;
    // Windows come on a little ahead of full dark, the way a town does at dusk.
    const w = smooth(n * 1.35);
    // Levels are for the sky's night exposure (1.22): at the paint shop's 1.05 / 0.95 a shop window
    // beside the camera burned out to a blank cream card and lost the shelves drawn in it.
    for (const f of this.facade) f.emissiveIntensity = w * 0.92;
    this.kit.emissiveIntensity = w * 0.66;
    this.sign.emissiveIntensity = n * 0.32;
    // Lawns are the most saturated thing in town and stayed postcard green under the moon.
    this.grass.color.setRGB(1 - 0.42 * n, 1 - 0.34 * n, 1 - 0.24 * n);
    this.glow.opacity = smooth(n * 1.2);
    // An invisible material costs no draw calls, so lamps are free by day.
    this.glow.visible = n > 0.01;
  }

  /**
   * w: 0 = dry, 1 = soaked (sky.wet). Wet ground is darker, because water fills the pores that
   * scatter light, and smoother, so it picks up the sky and the lamps. Does nothing on low.
   */
  setWet(w: number): void {
    w = Math.max(0, Math.min(1, w));
    if (Math.abs(w - this.wet) < 0.004 && (w > 0) === (this.wet > 0)) return;
    this.wet = w;
    // Roads look wet almost as soon as rain starts and take their time to dry.
    const k = smooth(Math.min(1, w * 1.6));
    this.wetU.value = k;
    for (const [m, dry, soaked, darken, env, tone] of this.soak) {
      m.roughness = dry + (soaked - dry) * k;
      m.color.setScalar(tone * (1 - darken * k));
      m.envMapIntensity = env * (1 + 1.5 * k);
    }
  }

  /**
   * Hand every material the sky's reflection map (scene.environment). A material only obeys its
   * own envMapIntensity for a map of its own; left to the scene's, three.js lights them all at
   * the scene's single level. Cheap to call every frame: it does nothing until the map changes.
   */
  setEnv(env: THREE.Texture | null): void {
    if (this.env === env) return;
    this.env = env;
    for (const m of this.std) m.envMap = env;
  }
  private env: THREE.Texture | null = null;

  /** Every material, for a pass that needs to touch them all (the bug bash's wireframe toggle, disposal). */
  get all(): THREE.Material[] {
    return [
      ...this.facade, this.flat, this.flatDouble, this.kit, this.sign, this.street, this.avenue, this.asphalt,
      this.sidewalk, this.grass, this.sand, this.wood, this.cobble, this.roofGravel, this.roofTile, this.shingle,
      this.corrugated, this.container, this.ramp, this.fence, this.marks, this.decal, this.glow,
    ];
  }
}

export function makeMaterials(tex: Textures, q: Quality): CityMaterials {
  return new CityMaterials(tex, q);
}
