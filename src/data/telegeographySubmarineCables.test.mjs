// Cabos submarinos TeleGeography na versão MapLibre:
// src/maplibre/layers/contextoGev.js (`telegeography-submarine-cables`) com as
// regras puras de submarineCableRefs.js.
//
// Migrado da camada Cesium (telegeographySubmarineCables.js, removida). Saíram
// os testes do arbitramento de rótulos por distância e do publicador do
// overlay de mundo, das hastes 3D estáticas e do sweep por moveEnd/sondas de
// movimento, da classificação das linhas por pilha de mapa (terreno/3D tiles),
// da mistura translúcida dos marcadores e das corridas de abort/destroy do
// DataSource: no MapLibre as linhas e rótulos são layers do mapa, com colisão
// nativa, e o carregamento é um único setData.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLabel,
  featureLabel,
  featureReference,
  normalizeFeatures,
} from './submarineCableRefs.js';
import contextoGev from '../maplibre/layers/contextoGev.js';

const layer = contextoGev.find((l) => l.id === 'telegeography-submarine-cables');

test('cable reference prefers the published coordinates, then the point, then the vertex mean', () => {
  assert.deepEqual(
    featureReference({ properties: { coordinates: ['-40.5', '-20'] }, geometry: { type: 'LineString', coordinates: [[0, 0], [2, 2]] } }),
    { lon: -40.5, lat: -20 },
  );
  assert.deepEqual(featureReference({ geometry: { type: 'Point', coordinates: [10, 20] } }), { lon: 10, lat: 20 });
  assert.deepEqual(
    featureReference({ geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [2, 0]], [[2, 4], [0, 4]]] } }),
    { lon: 1, lat: 2 },
  );
  assert.equal(featureReference({ geometry: { type: 'Point', coordinates: ['x', 1] } }), null);
  assert.equal(featureReference({}), null);
});

test('labels and ids: name first, stable fallback ids, long names clamped', () => {
  assert.equal(featureLabel({ properties: { name: '  SACS  ' } }), 'SACS');
  assert.equal(featureLabel({ properties: { id: 'sacs' } }), 'sacs');
  assert.deepEqual(
    normalizeFeatures({ features: [{ properties: { id: 'a' } }, { id: 7 }, {}] }, 'cable').map((f) => f.id),
    ['a', '7', 'cable-2'],
  );
  assert.deepEqual(normalizeFeatures(null, 'cable'), []);
  assert.equal(clampLabel('South   Atlantic\nCable'), 'South Atlantic Cable');
  const long = clampLabel('x'.repeat(50));
  assert.equal(long.length, 34);
  assert.ok(long.endsWith('...'));
});

async function withFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a load publishes cable lines and one reference per cable and landing point', async () => {
  const cable = {
    features: [
      { properties: { id: 'sacs', name: 'SACS', color: '#ff00aa' }, geometry: { type: 'LineString', coordinates: [[-38, -4], [13, -9]] } },
    ],
  };
  const landing = {
    features: [
      { properties: { id: 'fortaleza', name: 'Fortaleza, Brazil', is_tbd: false }, geometry: { type: 'Point', coordinates: [-38.5, -3.7] } },
      { properties: { id: 'sem-geo' } },
    ],
  };
  const data = {};
  const ctx = { setData: (id, fcol) => { data[id] = fcol; } };
  const count = await withFetch(
    async (url) => ({ ok: true, json: async () => (String(url).includes('landing') ? landing : cable) }),
    () => layer.load(ctx),
  );
  assert.equal(count, 3, 'the panel counts cables plus landing points');
  assert.equal(data['dg-cables'].features.length, 1);
  assert.equal(data['dg-cables'].features[0].properties.color, '#ff00aa');
  assert.deepEqual(data['dg-cable-refs'].features.map((f) => f.properties.kind), ['cable', 'landing-point']);
  assert.deepEqual(data['dg-cable-refs'].features[1].geometry.coordinates, [-38.5, -3.7]);
});

test('a failed dataset fetch rejects without publishing', async () => {
  const data = {};
  const ctx = { setData: (id, fcol) => { data[id] = fcol; } };
  await assert.rejects(
    withFetch(async () => ({ ok: false, status: 404 }), () => layer.load(ctx)),
    /HTTP 404/,
  );
  assert.deepEqual(data, {});
});

test('clicking a reference flies to it at the app close-up height and tilt', () => {
  const flights = [];
  const ctx = { map: { flyTo: (opts) => flights.push(opts) } };
  layer.click({ rlon: -38.5, rlat: -3.7 }, {}, ctx);
  assert.equal(flights.length, 1);
  assert.deepEqual(flights[0].center, [-38.5, -3.7]);
  assert.equal(flights[0].pitch, 52);
  layer.click({ rlon: 'x', rlat: 1 }, {}, ctx);
  assert.equal(flights.length, 1, 'a reference without coordinates does nothing');
});
