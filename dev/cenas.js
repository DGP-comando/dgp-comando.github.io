// dev/cenas.js — bancada do diretor de cenas e da câmera do cockpit no motor
// MapLibre, sem a interface inteira. Só no servidor de desenvolvimento.
//
//   /dev/cenas.html              diretor de cenas real (src/scenes/director.js)
//                                com dublês de styleManager/dataManager
//   /dev/cenas.html?cockpit=1    + aeronave simulada e câmera de perseguição
//                                (cockpitChaseMapView) com engine.track ligado,
//                                relevo e nuvens do cockpit
//
// Expõe window.__engine, __dgMap, __director, __clouds, __bench.

import { createEngine } from '../src/maplibre/engine.js';
import { SceneDirector } from '../src/scenes/director.js';
import { cockpitChaseMapView, slewHeading } from '../src/cockpitMath.js';
import { initCockpitCloudEffects } from '../src/cockpitCloudEffects.js';

const params = new URLSearchParams(location.search);
const logEl = document.getElementById('log');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[QA]', line);
  logEl.textContent += `${line}\n`;
};

const engine = createEngine({ container: 'map', basemap: params.get('base') || 'esri' });
window.__engine = engine;
window.__dgMap = engine.map;
await engine.ready;

// --- dublês mínimos do StyleManager e do DataLayerManager -----------------
const layers = new Map([['municipios', { id: 'municipios', enabled: false }], ['flights', { id: 'flights', enabled: false }]]);
const safeFrame = document.getElementById('safe-frame-overlay');
const styleManager = {
  _visual: { style: 'normal' },
  getVisualState() { return { ...this._visual }; },
  async applyVisualState(visual) { this._visual = { ...(visual || {}) }; return true; },
  runImmediateNavigation: (_noun, navigate) => navigate(),
  getContextModeState: () => ({ mode: null, entering: null }),
  async setContextMode() { return { ok: true }; },
  setRecordingMode(enabled, { safeFrame: ratio = '16:9' } = {}) {
    document.body.classList.toggle('recording-mode', !!enabled);
    safeFrame.classList.remove('ratio-9-16', 'ratio-16-9');
    safeFrame.classList.toggle('active', !!enabled);
    if (enabled) safeFrame.classList.add(ratio === '9:16' ? 'ratio-9-16' : 'ratio-16-9');
    log('setRecordingMode', !!enabled);
  },
};
const dataManager = {
  getAll: () => [...layers.values()],
  getLayerParams: () => null,
  async setEnabled(id, enabled) {
    const layer = layers.get(id);
    if (!layer) return false;
    layer.enabled = !!enabled;
    return true;
  },
  setLayerParams() {},
};

const director = new SceneDirector(engine, styleManager, dataManager);
window.__director = director;
log('diretor pronto; cenas:', director._project.scenes.map((s) => `${s.title}(${s.shots.length})`).join(', '));

// --- cockpit: aeronave simulada + câmera de perseguição -------------------
const clouds = initCockpitCloudEffects(engine);
window.__clouds = clouds;

if (params.get('cockpit')) {
  const plane = { lat: -25.535, lon: -49.176, alt: Number(params.get('alt')) || 2500, track: 300, speed: 140 };
  engine.map.addSource('dg-bench-plane', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  engine.map.addLayer({
    id: 'dg-bench-plane', type: 'circle', source: 'dg-bench-plane',
    paint: { 'circle-radius': 7, 'circle-color': '#ffd400', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 },
  });
  engine.setTerrain(true, { exaggeration: 1 });
  document.body.classList.add('cockpit-mode');
  window.dispatchEvent(new CustomEvent('gev:cockpit-mode-changed', { detail: { active: true } }));
  // Alvo rastreado como a camada de voos publica: o laço do motor centra nele.
  engine.track({ id: 'bench', gevTrackedId: 'flights:bench', releaseOnDrag: false, getPosition: () => ({ lon: plane.lon, lat: plane.lat, alt: plane.alt }) });
  let heading = plane.track;
  let last = performance.now();
  const hud = document.getElementById('cockpit-bench-hud');
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // "Feed": a aeronave avança pelo rumo e vira devagar.
    plane.track = (plane.track + 3 * dt) % 360;
    const r = plane.track * Math.PI / 180;
    plane.lat += (Math.cos(r) * plane.speed * dt) / 111_320;
    plane.lon += (Math.sin(r) * plane.speed * dt) / (111_320 * Math.cos(plane.lat * Math.PI / 180));
    engine.map.getSource('dg-bench-plane')?.setData({ type: 'Point', coordinates: [plane.lon, plane.lat] });
    heading = slewHeading(heading, plane.track, 28 * dt);
    const ground = engine.map.queryTerrainElevation?.([plane.lon, plane.lat]) ?? 0;
    const view = cockpitChaseMapView({
      lat: plane.lat, lon: plane.lon, altitudeM: plane.alt, groundM: ground, headingDeg: heading,
      viewportHeight: engine.map.getContainer().clientHeight, fovDeg: engine.map.getVerticalFieldOfView(),
    });
    engine.map.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch });
    const cam = engine.getCameraView();
    hud.textContent = `HDG ${Math.round(heading)}°  ALT ${Math.round(plane.alt)} m  GND ${Math.round(ground)} m  CAM ${Math.round(cam.alt)} m  PITCH ${engine.map.getPitch().toFixed(1)}  BRG ${engine.map.getBearing().toFixed(1)}`;
    window.__bench = { plane: { ...plane }, view, cam, tracked: !!engine.trackedTarget };
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  log('cockpit bancada ativo');
}
