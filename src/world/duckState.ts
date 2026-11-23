// Where the giant rubber duck is right now. One small shared object, so the duck's model (world/landmarks.ts), the
// ragdolls that bounce off it (ent/ragdoll.ts), its honk (audio/world.ts) and the event that sets it loose
// (world/duckLoose.ts) all agree without importing each other. Moored, it sits at HOME and nothing here moves.

/** The duck's mooring, dead ahead of the pier ramp. */
export const DUCK_HOME = { x: 0, z: 689 } as const;

export const DUCK = {
  x: DUCK_HOME.x as number,
  z: DUCK_HOME.z as number,
  /** Loose: duckLoose.ts drives y, yaw and the tilts below; moored, landmarks.ts bobs it in place as it always has. */
  loose: false,
  y: 0,
  /** Extra heading on top of the slow moored turn, radians. */
  yaw: 0,
  /** Extra pitch and roll from the swell and from being rammed, radians. */
  tiltX: 0,
  tiltZ: 0,
};
