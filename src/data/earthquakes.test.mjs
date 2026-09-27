// src/data/earthquakes.test.mjs
// Camada de terremotos (USGS) na versão MapLibre: src/maplibre/layers/contextoGev.js.
//
// Migrado da camada Cesium (earthquakes.js, removida). Saíram:
// - os testes de `mapAnalystRecord` (registros para o motor de consulta do
//   analista): a versão MapLibre não expõe getAnalystRecords;
// - a entrada/coorte do overlay de mundo e o ciclo de vida com rótulos no host:
//   os rótulos "M4.5" agora são um symbol layer (corte e prioridade cobertos
//   em src/maplibre/layers/contextoGev.test.mjs);
// - discos estáticos sem CallbackProperty e o render governor em modo ocioso:
//   o MapLibre redesenha sozinho a cada setData, sem laço de render do Cesium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import contextoGev from '../maplibre/layers/contextoGev.js';

const layer = contextoGev.find((l) => l.id === 'earthquakes');

function makeCtx() {
  const data = {};
  return { data, setData: (id, fcol) => { data[id] = fcol; } };
}

async function withFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a quake poll feeds the map source and counts only events at or above M2.5', async () => {
  const ctx = makeCtx();
  const count = await withFetch(async () => ({
    ok: true,
    json: async () => ({
      features: [
        { id: 'us-1', geometry: { coordinates: [-122.4, 37.79, 8.2] }, properties: { mag: 4.2, place: 'One', time: 1 } },
        { id: 'us-2', geometry: { coordinates: [-122.5, 37.7, 5] }, properties: { mag: 1.1, place: 'Tiny', time: 2 } },
        { id: 'us-3', geometry: { coordinates: [142, 38, 350] }, properties: { mag: 6.1, place: 'Deep', time: 3 } },
      ],
    }),
  }), () => layer.load(ctx));
  assert.equal(count, 2);
  assert.deepEqual(ctx.data['dg-earthquakes'].features.map((f) => f.properties.id), ['us-1', 'us-3']);
  const legend = layer.rowControls().legend;
  assert.deepEqual(legend.map((l) => l.count), [1, 0, 1], 'legend counts by depth band');
});

test('earthquake refresh reports failure and leaves the last good data untouched', async () => {
  const ctx = makeCtx();
  await assert.rejects(
    withFetch(async () => ({ ok: false, status: 503 }), () => layer.load(ctx)),
    /USGS HTTP 503/,
  );
  await assert.rejects(
    withFetch(async () => ({ ok: true, json: async () => ({ type: 'oops' }) }), () => layer.load(ctx)),
    /Malformed USGS response/,
  );
  assert.equal(ctx.data['dg-earthquakes'], undefined, 'a failed poll never publishes');

  const count = await withFetch(async () => ({ ok: true, json: async () => ({ features: [] }) }), () => layer.load(ctx));
  assert.equal(count, 0);
  assert.deepEqual(ctx.data['dg-earthquakes'].features, []);
});
