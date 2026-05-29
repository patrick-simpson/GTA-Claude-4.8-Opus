import * as THREE from 'three';
import { Renderer }       from './engine/Renderer';
import { CityGenerator, CITY_HALF } from './world/CityGenerator';
import { Player }         from './entities/Player';
import { Vehicle }        from './entities/Vehicle';
import { TouchControls }  from './input/TouchControls';
import { ChaseCamera }    from './camera/ChaseCamera';
import type { GameState } from './types';

// ── DOM ──────────────────────────────────────────────────────────────────────
const canvas       = document.getElementById('game-canvas') as HTMLCanvasElement;
const speedDisplay = document.getElementById('speed-display') as HTMLElement;
const stateLabel   = document.getElementById('state-indicator') as HTMLElement;

// ── Systems ───────────────────────────────────────────────────────────────────
const engineRenderer = new Renderer(canvas);
const { scene, camera } = engineRenderer;

const controls   = new TouchControls();
const chaseCamera = new ChaseCamera(camera);

// ── World ─────────────────────────────────────────────────────────────────────
const cityGen  = new CityGenerator();
const vehicles = cityGen.generate(scene);

// ── Player ────────────────────────────────────────────────────────────────────
const SPAWN = new THREE.Vector3(8, 0, 8);
const player = new Player(scene, SPAWN);

// ── Game State ────────────────────────────────────────────────────────────────
let gameState:      GameState = 'walking';
let currentVehicle: Vehicle | null = null;
let nearestVehicle: Vehicle | null = null;

const ENTER_DIST = 4.5; // metres to trigger enter prompt

// ── Nearest parked car finder ──────────────────────────────────────────────
function findNearest(pos: THREE.Vector3): Vehicle | null {
  let best:     Vehicle | null = null;
  let bestDist: number         = ENTER_DIST;

  for (const v of vehicles) {
    if (v.isOccupied) continue;
    const d = pos.distanceTo(v.getPosition());
    if (d < bestDist) { bestDist = d; best = v; }
  }
  return best;
}

// ── Enter / Exit vehicle ───────────────────────────────────────────────────
function enterVehicle(v: Vehicle): void {
  v.setOccupied(true);
  currentVehicle = v;
  gameState      = 'driving';
  player.hide();

  // Snap camera so it doesn't swim
  chaseCamera.snapTo(v.getPosition(), v.getHeading(), true);

  speedDisplay.style.display = 'block';
  stateLabel.textContent     = 'Driving';
}

function exitVehicle(): void {
  if (!currentVehicle) return;

  // Eject player to the side of the car
  const h   = currentVehicle.getHeading();
  const pos = currentVehicle.getPosition();
  const exitOffset = new THREE.Vector3(
    Math.cos(h) * 2.8,
    0,
    -Math.sin(h) * 2.8
  );
  player.position.copy(pos).add(exitOffset);
  player.heading = h;

  currentVehicle.setOccupied(false);
  currentVehicle = null;
  gameState      = 'walking';
  player.show();

  chaseCamera.snapTo(player.position, player.heading, false);

  speedDisplay.style.display = 'none';
  stateLabel.textContent     = 'Walking';
}

// ── City boundary clamper ──────────────────────────────────────────────────
const BOUND = CITY_HALF - 4;

function clampToBounds(pos: THREE.Vector3): void {
  pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x));
  pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
}

// ── Game loop ─────────────────────────────────────────────────────────────
let lastTime  = performance.now();
let frameId   = 0;

function loop(now: number): void {
  frameId = requestAnimationFrame(loop);

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  const ctrl = controls.getState();

  // ── Handle action button ────────────────────────────────────────────────
  if (ctrl.actionPressed) {
    controls.clearAction();
    if (gameState === 'walking' && nearestVehicle) {
      enterVehicle(nearestVehicle);
    } else if (gameState === 'driving') {
      exitVehicle();
    }
  }

  // ── Walking ─────────────────────────────────────────────────────────────
  if (gameState === 'walking') {
    // Joystick → world-space movement
    // Joystick Y: negative = up on screen = forward in world (+Z)
    player.update(
      { moveX: ctrl.joystickX, moveZ: ctrl.joystickY },
      dt
    );
    clampToBounds(player.position);

    nearestVehicle = findNearest(player.position);
    controls.setActionMode(nearestVehicle ? 'enter' : 'inactive');

    chaseCamera.update(player.position, player.heading, false, dt);
  }

  // ── Driving ─────────────────────────────────────────────────────────────
  if (gameState === 'driving' && currentVehicle) {
    currentVehicle.update(
      {
        throttle: ctrl.throttle,
        brake:    ctrl.brake,
        steer:    ctrl.joystickX,
      },
      dt
    );

    clampToBounds(currentVehicle.physics.position);

    // Speed HUD  (m/s → km/h)
    const kmh = Math.abs(currentVehicle.physics.getForwardSpeed()) * 3.6;
    speedDisplay.textContent = `${Math.round(kmh)} km/h`;

    controls.setActionMode('exit');
    chaseCamera.update(currentVehicle.getPosition(), currentVehicle.getHeading(), true, dt);
  }

  engineRenderer.render();
}

// ── Init ──────────────────────────────────────────────────────────────────
chaseCamera.snapTo(player.position, player.heading, false);
controls.setActionMode('inactive');
stateLabel.textContent = 'Walking — find a car and tap ENTER';

requestAnimationFrame(loop);

// ── Cleanup on HMR / page unload ─────────────────────────────────────────
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cancelAnimationFrame(frameId);
    controls.dispose();
    engineRenderer.dispose();
  });
}
