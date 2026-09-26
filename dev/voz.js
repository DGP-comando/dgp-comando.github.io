// dev/voz.js — bancada das ferramentas da voz, dos verbos de câmera e das
// anotações sobre o motor MapLibre, sem a interface inteira e sem o proxy
// OpenAI. Só no servidor de desenvolvimento.
//
//   /dev/voz.html[?vista=zoom/lat/lon][&base=esri|osm|vector]
//
// Expõe window.__engine, __dgMap, __annotations e __voz:
//   await __voz.run('move_camera', { motion: 'orbit', mode: 'continuous' })
//   await __voz.run('annotate_map', { annotations: [...] })
//   __voz.verbs.getActiveCameraMotion()
// Os managers são dublês mínimos (sem camadas registradas): servem para
// exercitar câmera, anotações e leitura de contexto.

import { createEngine } from '../src/maplibre/engine.js';
import { createLayerHost } from '../src/maplibre/layerHost.js';
import { initAnnotations } from '../src/annotations/index.js';
import { createGevActionRunner, getBasemapLabelContext } from '../src/voice/gevActions.js';
import * as verbs from '../src/cameraVerbs.js';
import { createHybridAnnotationRenderer } from '../src/annotations/hybridAnnotationRenderer.js';

const params = new URLSearchParams(location.search);
const logEl = document.getElementById('log');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[QA]', line);
  logEl.textContent += `${line}\n`;
};

const engine = createEngine({ container: 'map', basemap: params.get('base') || 'esri', preserveDrawingBuffer: true });
createLayerHost(engine);
window.__engine = engine;
window.__dgMap = engine.map;
await engine.ready;
const vista = params.get('vista');
if (vista) {
  const [zoom, lat, lon] = vista.split('/').map(Number);
  engine.map.jumpTo({ center: [lon, lat], zoom });
}

const annotations = initAnnotations({ engine });
window.__annotations = annotations;

const styleManager = {
  activeStyle: 'normal',
  runImmediateNavigation(noun, navigate, releaseOptions) {
    verbs.interruptCameraMotion(`nav:${noun}`);
    engine.track(null);
    if (!releaseOptions?.preserveCameraFlight) engine.cancelFlight();
    return navigate();
  },
  getControlState: () => null,
  getDetectionState: () => ({ detectionMode: 'OFF' }),
  setDetection: () => ({ ok: true }),
};
const dataManager = { layers: new Map(), getAll: () => [], isEnabled: () => false, setLayerParams: () => true };
const runner = createGevActionRunner({ viewer: engine, styleManager, dataManager, annotations });

window.__voz = {
  verbs,
  async run(name, args = {}) {
    const result = await runner(name, args);
    log(name, result);
    return result;
  },
  labels: () => getBasemapLabelContext(engine),
  /** Desenha direto no renderizador híbrido (sem geocodificar). */
  renderer: () => createHybridAnnotationRenderer(engine),
  log,
};
log('bancada da voz pronta');
