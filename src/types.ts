export type GameState = 'walking' | 'driving';

export interface VehicleInputState {
  throttle: number; // 0–1
  brake: number;    // 0–1
  steer: number;    // -1 (left) to +1 (right)
}

export interface WalkInputState {
  moveX: number; // -1 to +1
  moveZ: number; // -1 to +1  (negative = forward)
}

export interface ControlState {
  joystickX: number;
  joystickY: number;
  throttle: number;
  brake: number;
  actionPressed: boolean;
}
