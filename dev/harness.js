// dev/harness.js — bancada para testar UM módulo de camada no motor MapLibre
// sem a interface inteira. Só no servidor de desenvolvimento.
//
//   /dev/harness.html?module=/src/data/flights.js[&export=default][&vista=zoom/lat/lon]
//
// Sobe o engine + layerHost, importa o módulo, e roda init -> enable -> update
// como o DataLayerManager faria. Expõe window.__engine, __host e __module; os
// logs do ciclo vão para o canto da tela e para o console ([QA] ...).

import { createEngine } from '../src/maplibre/engine.js';
import { createLayerHost } from '../src/maplibre/layerHost.js';

const params = new URLSearchParams(location.search);
const logEl = document.getElementById('log');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[QA]', line);
  logEl.textContent += `${line}\n`;
};

const engine = createEngine({ container: 'map', basemap: params.get('base') || 'esri' });
const host = createLayerHost(engine);
window.__engine = engine;
window.__host = host;

await engine.ready;
const vista = params.get('vista');
if (vista) {
  const [zoom, lat, lon] = vista.split('/').map(Number);
  engine.map.jumpTo({ center: [lon, lat], zoom });
}

const path = params.get('module');
if (!path) {
  log('passe ?module=/src/data/<arquivo>.js');
} else {
  const mod = await import(/* @vite-ignore */ path);
  const layer = mod[params.get('export') || 'default'];
  window.__module = layer;
  const t0 = performance.now();
  try {
    log('init', await layer.init?.(engine));
    log('enable', await layer.enable?.(engine));
    log('update', await layer.update?.(engine));
    log('stats', layer.getStats?.());
    log(`pronto em ${Math.round(performance.now() - t0)} ms`);
  } catch (err) {
    log('ERRO', err?.stack || String(err));
  }
}
