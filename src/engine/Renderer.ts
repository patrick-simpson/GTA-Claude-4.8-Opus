import * as THREE from 'three';

export class Renderer {
  readonly scene:    THREE.Scene;
  readonly camera:   THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private readonly _onResize: () => void;

  constructor(canvas: HTMLCanvasElement) {
    // ── Scene ─────────────────────────────────────────────────────────────────
    this.scene            = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    // Fog hides pop-in of distant geometry and helps perf on mobile
    this.scene.fog        = new THREE.Fog(0x87ceeb, 90, 220);

    // ── Camera ────────────────────────────────────────────────────────────────
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.2,
      260
    );
    this.camera.position.set(0, 8, -12);

    // ── Renderer ──────────────────────────────────────────────────────────────
    const isMobile = navigator.maxTouchPoints > 0;
    this.renderer  = new THREE.WebGLRenderer({
      canvas,
      antialias:       !isMobile,
      powerPreference: 'high-performance',
      stencil:         false,
      depth:           true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = false;

    // ── Lighting ──────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff0cc, 0.85);
    sun.position.set(60, 120, 60);
    this.scene.add(sun);

    // Subtle fill light from below / opposite side
    const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    fill.position.set(-40, 20, -40);
    this.scene.add(fill);

    // ── Resize ────────────────────────────────────────────────────────────────
    this._onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
