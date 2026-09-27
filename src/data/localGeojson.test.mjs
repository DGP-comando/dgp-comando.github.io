// Infraestrutura local (datacenters e barragens) na versão MapLibre:
// src/maplibre/layers/contextoGev.js (localInfraLayer) + localInfraLabels.js.
//
// Migrado da camada Cesium (localGeojson.js / localLayers.js, removidas).
// Saíram os testes do publicador do overlay de mundo (entradas, coorte por
// grade, ciclo add/remove/visibilidade), das hastes 3D e seus CallbackProperty,
// da amostragem de altura do terreno com o render governor ocioso e do rollback
// do DataSource na cena: no MapLibre os cards são symbol layers com colisão
// nativa e os pontos ficam no chão, sem haste nem amostragem de relevo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localInfrastructureCopyFromPlain } from './localInfraLabels.js';
import { layerFeedState } from './manager.js';
import contextoGev from '../maplibre/layers/contextoGev.js';

const datacenters = contextoGev.find((l) => l.id === 'local-datacenters');
const dams = contextoGev.find((l) => l.id === 'local-dams');

function makeCtx() {
  const data = {};
  return { data, setData: (id, fcol) => { data[id] = fcol; } };
}

async function loadWith(layer, response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  const ctx = makeCtx();
  try {
    return { ctx, count: await layer.load(ctx) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('local infrastructure card copy uses the validated source fields', () => {
  assert.deepEqual(localInfrastructureCopyFromPlain({
    tags: {
      name: 'DFW-1',
      operator: 'Example Cloud',
      'capacity:it_load': '27 MW',
    },
  }, 'local-datacenters'), {
    title: 'DFW-1',
    details: ['Example Cloud · 27 MW'],
  });

  assert.deepEqual(localInfrastructureCopyFromPlain({
    name: 'Barrage Bin el Ouidane',
    tags: { associated_river: 'El Abid' },
  }, 'local-dams'), {
    title: 'Barrage Bin el Ouidane',
    details: ['El Abid'],
  });

  assert.deepEqual(localInfrastructureCopyFromPlain({
    tags: { name: 'Amazon Web Services', operator: 'Amazon Web Services' },
  }, 'local-datacenters'), {
    title: 'Amazon Web Services',
    details: [],
  });
});

test('a loaded dataset publishes points, labels and polygons and counts entities', async () => {
  const lines = [
    { type: 'Feature', id: 'a', properties: { tags: { name: 'AUS-1', operator: 'Example Cloud' } }, geometry: { type: 'Point', coordinates: [-97.7, 30.2] } },
    { type: 'Feature', id: 'b', properties: { name: 'Campus' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } },
  ].map((f) => JSON.stringify(f)).join('\n');
  const { ctx, count } = await loadWith(datacenters, { ok: true, status: 200, text: async () => `${lines}\n\n` });
  assert.equal(count, 2);
  const pts = ctx.data['dg-local-datacenters'].features;
  assert.deepEqual(pts.map((f) => f.properties.title), ['AUS-1', 'Campus']);
  assert.equal(pts[0].properties.detail, 'Example Cloud');
  assert.deepEqual(pts[1].geometry.coordinates, [1, 1], 'a polygon is marked at its centre');
  assert.equal(ctx.data['dg-local-datacenters-lbl'], ctx.data['dg-local-datacenters']);
  assert.equal(ctx.data['dg-local-datacenters-poly'].features.length, 1);
});

test('a missing dataset reports UNAVAILABLE instead of a silent empty layer', async () => {
  await assert.rejects(
    loadWith(dams, { ok: false, status: 404, text: async () => '<!DOCTYPE html>' }),
    (err) => {
      assert.equal(err.message, 'dataset unavailable (HTTP 404)');
      assert.equal(layerFeedState({ count: 0, lastUpdate: null, error: err.message }), 'unavailable');
      return true;
    },
  );
});

test('a corrupt dataset line reports malformed rather than parsing into nothing', async () => {
  await assert.rejects(
    loadWith(dams, { ok: true, status: 200, text: async () => '{"type":"Feature"\n' }),
    /^Error: dataset is malformed$/,
  );
});
