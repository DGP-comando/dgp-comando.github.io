// dev/hud.js — bancada do HUD, detecção, world overlay, leitura do alvo e
// créditos sobre o motor MapLibre, sem a interface inteira. Só no dev-server.
//
//   /dev/hud.html[?hud=tactical|operator|minimal][&detect=DENSE][&track=1][&globe=1][&vista=zoom/lat/lon]
//
// Sobe engine + layerHost, liga `local-firms` com focos de exemplo, uma fonte
// falsa de aeronaves para a detecção, um alvo rastreado com card, e o HUD.
// Expõe window.__engine / __dgMap / __hud / __detection para o QA.

import { createEngine } from '../src/maplibre/engine.js';
import { createLayerHost } from '../src/maplibre/layerHost.js';
import contextLayers, { applyFiresPayload } from '../src/maplibre/layers/contextoGev.js';
import { IntelHUD } from '../src/hud.js';
import { initWorldOverlay, getWorldOverlayDiagnostics } from '../src/overlays/worldOverlay.js';
import * as detection from '../src/data/detection.js';
import { initTrackedReadout } from '../src/data/trackedReadout.js';
import { registerDataCredits } from '../src/data/dataCredits.js';

const params = new URLSearchParams(location.search);
const logEl = document.getElementById('qa-log');
const log = (...a) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  console.log('[QA]', line);
  logEl.textContent += `${line}\n`;
};

const engine = createEngine({ container: 'map', basemap: params.get('base') || 'esri', globe: params.get('globe') === '1' });
window.__engine = engine;
window.__dgMap = engine.map;
await engine.ready;
const [zoom, lat, lon] = (params.get('vista') || '8.2/-25.2/-50.2').split('/').map(Number);
engine.map.jumpTo({ center: [lon, lat], zoom });

registerDataCredits(engine);

// Focos de calor de exemplo na camada MapLibre `local-firms`.
const host = createLayerHost(engine);
const firms = contextLayers.find((d) => d.id === 'local-firms');
host.register(firms);
host.setVisible('local-firms', true);
const now = Date.now();
const fires = Array.from({ length: 40 }, (_, i) => ({
  lat: -25.2 + Math.sin(i * 1.7) * 0.9,
  lon: -50.2 + Math.cos(i * 2.3) * 1.4,
  frp: 3 + ((i * 37) % 160),
  confidence: 'h',
  acq_ms: now - i * 3_600_000,
  satellite: 'N20',
  municipality: `Município ${i}`,
}));
applyFiresPayload(host.ctx, { fetchedAt: now, stale: false, fires });

// Fonte falsa de aeronaves (o contrato de getDetectableObjects).
const planes = Array.from({ length: 25 }, (_, i) => ({
  sourceId: `plane-${i}`,
  id: `TAM${3000 + i * 7}`,
  metric: `FL${String(120 + i * 10).padStart(3, '0')}`,
  type: 'AIR',
  position: { lon: -50.2 + Math.sin(i * 0.9) * 1.3, lat: -25.2 + Math.cos(i * 1.3) * 0.8, height: 3000 + i * 300 },
}));
const flightsLayer = { id: 'flights', getDetectableObjects: () => planes };

initWorldOverlay(engine);
detection.initDetection(engine, [flightsLayer], (mode) => log('detection mode', mode));
initTrackedReadout(engine);
detection.setDetectionTuning({ densityPct: 75 });
if (params.get('detect')) detection.setMode(params.get('detect'));

if (params.get('track') === '1') {
  const target = planes[0];
  engine.track({
    gevTrackedId: 'flights:plane-0',
    gevLabelModel: { title: target.id, details: [`${target.metric} · 451 kts`, 'A320 · LATAM'], accent: '#39d0ff' },
    getPosition: () => target.position,
  });
}

const hud = new IntelHUD(engine);
hud.setVariant(params.get('hud') || 'tactical');
if (params.get('hud')) hud.setMode('on');
window.__hud = hud;
window.__detection = detection;
window.__overlayDiag = getWorldOverlayDiagnostics;
log('pronto', { detect: detection.getMode(), hud: hud.getMode() });
