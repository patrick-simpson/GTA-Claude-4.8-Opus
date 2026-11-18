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
//     levels and the glow opacity.

import * as THREE from 'three';
import type { Quality } from '../core/api';
import type { Textures } from './textures';
import { smooth } from '../core/util';

type Lambert = THREE.MeshLambertMaterial;

function lambert(map: THREE.Texture | null, extra: THREE.MeshLambertMaterialParameters = {}): Lambert {
  return new THREE.MeshLambertMaterial({ map, vertexColors: true, fog: true, ...extra });
}

/** A map plus its night-glow twin. The emissive level starts at zero; setNight() raises it. */
function lit(map: THREE.Texture, glow: THREE.Texture, extra: THREE.MeshLambertMaterialParameters = {}): Lambert {
  return lambert(map, { emissive: 0xffffff, emissiveMap: glow, emissiveIntensity: 0, ...extra });
}

export class CityMaterials {
  /** Wall materials for Batch.walls(..., tiles = 8): 0 glass tower, 1 brick, 2 stucco, 3 corrugated metal. Windows light up at night. */
  readonly facade: Lambert[];
  /** Vertex colour only. The workhorse for untextured Batch geometry. */
  readonly flat: Lambert;
  /** `flat`, visible from both sides. */
  readonly flatDouble: Lambert;
  /** Ground-floor atlas (tex.kit): shopfronts, doors, garage, rowhouse, dock, awnings. Shop windows light up at night. */
  readonly kit: Lambert;
  /** Sign atlas (tex.signs). Alpha-tested for the round hanging signs; gently self-lit at night so it stays readable. */
  readonly sign: Lambert;

  /** 12 m street: u across the full width, v along it at 12 m per repeat. */
  readonly street: Lambert;
  /** 20 m avenue: u across the full width, v along it at 12 m per repeat. */
  readonly avenue: Lambert;
  /** Bare asphalt for intersections and lots. World-space uv / TILE_M.asphalt. */
  readonly asphalt: Lambert;
  readonly sidewalk: Lambert;
  readonly grass: Lambert;
  readonly sand: Lambert;
  /** Planks run along v. Pier, boardwalk, clapboard. */
  readonly wood: Lambert;
  readonly cobble: Lambert;
  readonly roofGravel: Lambert;
  /** Terracotta barrel tile; v climbs the slope. Double-sided so open gables do not show through. */
  readonly roofTile: Lambert;
  /** Asphalt shingle, pale so it tints; v climbs the slope. Double-sided. */
  readonly shingle: Lambert;
  /** Corrugated sheet, ribs along v. Double-sided: sawtooth roofs, sheds, canopies. */
  readonly corrugated: Lambert;
  /** Shipping container strip (CONTAINER_UV in textures.ts). Tint with the vertex colour. */
  readonly container: Lambert;
  /** Stunt-ramp chevrons pointing toward +v. */
  readonly ramp: Lambert;
  /** Chain link, picket and railing (FENCE_UV). Alpha-tested and double-sided. */
  readonly fence: Lambert;

  /** Road paint atlas (tex.marks) as a ground decal: crosswalks, stop lines, stall lines, arrows, manholes. */
  readonly marks: Lambert;
  /** Plain vertex-colour ground decal: painted boxes, court lines, puddle-dark patches. */
  readonly decal: Lambert;

  /**
   * Additive glow sprite for lamp halos and light pools. The vertex colour is the lamp
   * colour; it is invisible by day and setNight() fades it in. Not fogged, not depth-written.
   */
  readonly glow: THREE.MeshBasicMaterial;

  /** Last value given to setNight: 0 day .. 1 night. */
  night = 0;

  constructor(readonly tex: Textures, readonly quality: Quality) {
    this.facade = tex.facade.map((f) => lit(f.map, f.glow));
    this.flat = lambert(null);
    this.flatDouble = lambert(null, { side: THREE.DoubleSide });
    this.kit = lit(tex.kit.tex, tex.kit.glow);
    // The sign lights itself with its own picture, so a lit sign keeps its colours.
    this.sign = lit(tex.signs.tex, tex.signs.tex, { alphaTest: 0.5 });

    this.street = lambert(tex.street);
    this.avenue = lambert(tex.avenue);
    this.asphalt = lambert(tex.asphalt);
    this.sidewalk = lambert(tex.sidewalk);
    this.grass = lambert(tex.grass);
    this.sand = lambert(tex.sand);
    this.wood = lambert(tex.wood);
    this.cobble = lambert(tex.cobble);
    this.roofGravel = lambert(tex.roofGravel);
    this.roofTile = lambert(tex.roofTile, { side: THREE.DoubleSide });
    this.shingle = lambert(tex.shingle, { side: THREE.DoubleSide });
    this.corrugated = lambert(tex.corrugated, { side: THREE.DoubleSide });
    this.container = lambert(tex.container);
    this.ramp = lambert(tex.ramp);
    // A low threshold keeps the wire from vanishing as soon as the mipmaps thin it out.
    this.fence = lambert(tex.fence, { alphaTest: 0.28, side: THREE.DoubleSide });

    // Decals sit exactly on the surface under them and win the depth test by offset,
    // which holds at any distance; lifting them a few centimeters flickers far away.
    const onGround: THREE.MeshLambertMaterialParameters = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false };
    this.marks = lambert(tex.marks.tex, { transparent: true, ...onGround });
    this.decal = lambert(null, onGround);

    this.glow = new THREE.MeshBasicMaterial({
      map: tex.glow, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, fog: false, opacity: 0,
    });
    this.glow.visible = false;
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
    this.glow.opacity = smooth(n * 1.2);
    // An invisible material costs no draw calls, so lamps are free by day.
    this.glow.visible = n > 0.01;
  }

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
