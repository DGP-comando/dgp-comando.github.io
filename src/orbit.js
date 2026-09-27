import { holdContinuousRender, releaseContinuousRender } from './renderGovernor.js';

/**
 * OrbitController — órbita suave em volta de um ponto (tecla O).
 *
 * Sobre o MapLibre: a câmera olha para o alvo (`{lat, lon, height?}`) a uma
 * distância `radius` (m) e inclinação `pitch` (graus, semântica Cesium:
 * -90 = nadir), girando o heading continuamente a `speed` graus/s. Cada
 * quadro é um `engine.setCameraView` a partir de `engine.cameraLookingAt`,
 * independente da taxa de quadros. Arrastar/rolar o mapa encerra a órbita
 * (o usuário retoma o controle). Para ao trocar de cidade/POI.
 */
export class OrbitController {
  constructor(engine) {
    this.viewer = engine;
    this.engine = engine;
    this.active = false;
    this.target = null;
    this.radius = 500;
    this.pitch = -30;
    this.speed = 6; // graus/s → volta completa em ~60 s
    this.angle = 0;
    this._raf = null;
    this._removeInterrupt = null;
  }

  /**
   * Começa a orbitar o alvo.
   * @param {{lat:number, lon:number, height?:number}} target
   * @param {{radius?:number, pitch?:number, speed?:number}} options
   */
  start(target, options = {}) {
    if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return;
    this.stop();
    this.target = target;
    this.radius = options.radius || this.radius;
    this.pitch = options.pitch || this.pitch;
    this.speed = options.speed || 6;
    this.active = true;
    holdContinuousRender('camera-orbit');

    // Parte do heading atual da câmera: transição sem salto de rumo.
    const view = this.engine.getCameraView?.();
    this.angle = Number.isFinite(view?.heading) ? view.heading : 0;
    this.engine.cancelFlight?.();

    let lastTime = performance.now();
    const step = (now) => {
      if (!this.active) return;
      const dt = Math.min(0.5, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      this.angle = (this.angle + this.speed * dt) % 360;
      const cam = this.engine.cameraLookingAt(
        { lat: this.target.lat, lon: this.target.lon, height: this.target.height || 0 },
        { rangeM: this.radius, heading: this.angle, pitch: this.pitch },
      );
      try {
        this.engine.map?.jumpTo(
          this.engine.map.calculateCameraOptionsFromCameraLngLatAltRotation(
            [cam.lon, cam.lat], Math.max(1, cam.alt), cam.heading, 90 + cam.pitch, 0,
          ),
        );
      } catch {
        this.engine.setCameraView?.(cam);
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);

    // Gesto do usuário (arrastar, rolar) devolve o controle.
    const map = this.engine.map;
    if (map?.on) {
      const interrupt = (e) => {
        if (e?.originalEvent) this.stop();
      };
      map.on('dragstart', interrupt);
      map.on('wheel', interrupt);
      map.on('rotatestart', interrupt);
      map.on('pitchstart', interrupt);
      this._removeInterrupt = () => {
        map.off('dragstart', interrupt);
        map.off('wheel', interrupt);
        map.off('rotatestart', interrupt);
        map.off('pitchstart', interrupt);
      };
    }
  }

  /** Para a órbita; a câmera fica onde está e o usuário retoma o controle. */
  stop() {
    const wasActive = this.active;
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._removeInterrupt?.();
    this._removeInterrupt = null;
    if (wasActive) releaseContinuousRender('camera-orbit');
    if (wasActive) this.onStop?.();
  }

  /**
   * Liga/desliga a órbita.
   * @param {{lat:number, lon:number, height?:number}} target obrigatório ao ligar
   * @param {object} options repassado a start()
   * @returns {boolean} se a órbita ficou ativa
   */
  toggle(target, options) {
    if (this.active) {
      this.stop();
    } else {
      this.start(target, options);
    }
    return this.active;
  }
}
