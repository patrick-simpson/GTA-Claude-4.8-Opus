// Snow lying on everything that faces the sky: roofs, ground, lawns, tree crowns, parked cars, benches, the tops of
// lamp posts. No geometry changes and no per-object work: one term in the lit shaders of every standard, Lambert and
// Phong material, from the surface's world normal (with its normal map) and the one accumulation value the sky keeps
// (Sky.snowCover, 0 bare to 1 deep). The term sits behind a uniform branch, so on a day without snow it costs one
// comparison a pixel.
//
// How it reaches every material without touching the files that make them: Material.prototype.onBeforeCompile
// becomes an accessor. A material that sets its own hook (materials.ts, floraAssets.ts, vehicle.ts ...) stores it
// through the setter and the getter hands three a wrapper that runs that hook and then this one. The default program
// cache key is replaced to match (the material's own hook's text, so two materials with different hooks never share
// a program); a material with its own customProgramCacheKey keeps it, and its programs still get the term because
// the term's text does not change.
//
// Opt out: material.userData.noSnow = true (the snowbanks, which are snow already). Roads: userData.snowRoad, a
// slushier, patchier cover that traffic keeps thin. Interiors that face up would take snow too: mark their floors noSnow.

import * as THREE from 'three';

/** x: cover 0..1. y: 1 on the presets that can afford the noise, else 0. */
export const SNOW_U = { value: new THREE.Vector2(0, 1) };

const SNOW_FRAG = /* glsl */ `
#ifndef SNOW_SKIP
if ( uSnow.x > 0.003 ) {
  vec3 sN = inverseTransformDirection( normal, viewMatrix );
  vec3 sW = ( - vViewPosition - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
  vec2 sp = sW.xz * 0.37;
  vec2 si = floor( sp ), sf = fract( sp );
  sf = sf * sf * ( 3.0 - 2.0 * sf );
  float sn = mix( mix( snowHash( si ), snowHash( si + vec2( 1.0, 0.0 ) ), sf.x ), mix( snowHash( si + vec2( 0.0, 1.0 ) ), snowHash( si + vec2( 1.0, 1.0 ) ), sf.x ), sf.y );
  {
    vec2 sq = sW.xz * 1.9 + 7.3, sqi = floor( sq ), sqf = fract( sq );
    sqf = sqf * sqf * ( 3.0 - 2.0 * sqf );
    float sn2 = mix( mix( snowHash( sqi ), snowHash( sqi + vec2( 1.0, 0.0 ) ), sqf.x ), mix( snowHash( sqi + vec2( 0.0, 1.0 ) ), snowHash( sqi + vec2( 1.0, 1.0 ) ), sqf.x ), sqf.y );
    sn = mix( 0.5, sn * 0.7 + 0.3 * sn2, uSnow.y );
  }
  float c = uSnow.x;
  #ifdef SNOW_ROAD
    c *= 0.62;
  #endif
  // Steeper faces hold snow only once it is deep; patchy at first, from the noise.
  float up = sN.y + ( sn - 0.5 ) * 0.5 * ( 1.2 - c );
  float s = smoothstep( 1.02 - 0.72 * c, 1.12 - 0.55 * c, up ) * smoothstep( 0.0, 0.18, c ) * step( -0.6, sW.y );
  #ifdef SNOW_ROAD
    // Ploughed and driven on: grey slush in the patches the noise leaves thin.
    vec3 sCol = mix( vec3( 0.42, 0.44, 0.47 ), vec3( 0.80, 0.83, 0.88 ), smoothstep( 0.35, 0.75, sn + c * 0.25 ) );
  #else
    vec3 sCol = vec3( 0.84, 0.87, 0.93 ) * ( 0.94 + 0.06 * sn );
  #endif
  diffuseColor.rgb = mix( diffuseColor.rgb, sCol, s );
  #ifdef STANDARD
    roughnessFactor = mix( roughnessFactor, 0.72, s );
    metalnessFactor = mix( metalnessFactor, 0.0, s );
  #endif
  normal = normalize( mix( normal, nonPerturbedNormal, s * 0.8 ) );
  totalEmissiveRadiance *= 1.0 - s;
}
#endif
`;

const SNOW_HEAD = /* glsl */ `
uniform vec2 uSnow;
float snowHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
`;

const POINTS = ['#include <lights_physical_fragment>', '#include <lights_lambert_fragment>', '#include <lights_phong_fragment>'];

type Hook = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;
interface Hooked { _obc?: Hook; _obcW?: Hook; userData: Record<string, unknown> }

function snowHook(this: THREE.Material, sh: THREE.WebGLProgramParametersWithUniforms): void {
  const m = this as unknown as Hooked & THREE.Material;
  if (m.userData.noSnow || !enabled) return;
  if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial
    && !(m as THREE.MeshPhongMaterial).isMeshPhongMaterial) return;
  const f = sh.fragmentShader;
  const at = POINTS.find((p) => f.includes(p));
  if (!at || !f.includes('#include <normal_fragment_begin>') && !f.includes('nonPerturbedNormal')) return;
  sh.uniforms.uSnow = SNOW_U;
  sh.fragmentShader = (m.userData.snowRoad ? '#define SNOW_ROAD\n' : '') + SNOW_HEAD
    + f.replace(at, SNOW_FRAG + at);
}

let installed = false;
let enabled = true;

/** Once, before any material compiles. `on` false (a preset that cannot afford it): the hook adds nothing. */
export function installSnowCover(on: boolean): void {
  enabled = on;
  if (installed) return;
  installed = true;
  const proto = THREE.Material.prototype as unknown as Hooked & { customProgramCacheKey(): string };
  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    get(this: Hooked): Hook {
      const own = this._obc;
      if (!own) return snowHook as unknown as Hook;
      if (!this._obcW) {
        const self = this as unknown as THREE.Material;
        this._obcW = (sh, r) => { own.call(self, sh, r); snowHook.call(self, sh); };
      }
      return this._obcW;
    },
    set(this: Hooked, fn: Hook) { this._obc = fn; this._obcW = undefined; },
  });
  proto.customProgramCacheKey = function (this: Hooked): string {
    return (this._obc ? this._obc.toString() : '') + (this.userData.snowRoad ? '|snowR' : '|snow');
  };
}
