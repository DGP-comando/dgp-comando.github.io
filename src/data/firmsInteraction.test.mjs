// FIRMS: identidade estável de uma detecção e as rotas de seleção da camada
// MapLibre (src/maplibre/layers/contextoGev.js, `local-firms`).
//
// Migrado da camada Cesium (firmsHeatmap.js, removida). Os testes do card
// clicável no overlay de mundo, do pick de sprite/card, do sweep de contexto e
// da evicção pelo `clearSelectedEntityContextForLayer` saíram: na versão
// MapLibre os cards são symbol layers do próprio mapa, o clique chega pelo
// layerHost e a seleção é um anel + card em fonte própria (`dg-firms-sel`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fireDetectionKey } from './firmsLabels.js';
import contextoGev, { applyFiresPayload } from '../maplibre/layers/contextoGev.js';

const firmsLayer = contextoGev.find((l) => l.id === 'local-firms');

function makeFire(overrides = {}) {
  return {
    index: 7,
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    sensor: 'VIIRS',
    acqMs: 1_753_600_000_000,
    ...overrides,
  };
}

/** Registro bruto no formato do payload (fetchFiresPayload → adaptFirmsRecords). */
function rawFire(overrides = {}) {
  return {
    lat: -24.5, lon: -51.5, frp: 50, confidence: 'h', brightness: 330, daynight: 'D',
    acqDate: '2026-09-25', acqTime: '0930', satellite: 'N20', instrument: 'VIIRS', municipality: 'Pitanga',
    ...overrides,
  };
}

/** Contexto mínimo do layerHost: fontes, filtro do card, easeTo e clique. */
function makeCtx() {
  const data = {};
  const filters = {};
  const eases = [];
  const handlers = new Set();
  let rendered = [];
  const map = {
    getLayer: () => true,
    setFilter: (id, f) => { filters[id] = f; },
    easeTo: (opts) => eases.push(opts),
    on: (type, h) => { if (type === 'click') handlers.add(h); },
    off: (type, h) => { if (type === 'click') handlers.delete(h); },
    queryRenderedFeatures: () => rendered,
  };
  return {
    data, filters, eases, map,
    setData: (id, fcol) => { data[id] = fcol; },
    setRendered: (features) => { rendered = features; },
    clickMap: () => { for (const h of handlers) h({ point: { x: 1, y: 1 } }); },
    handlerCount: () => handlers.size,
  };
}

test('fire detection key survives a refetch that renumbers the index', () => {
  const fire = makeFire();
  assert.equal(fireDetectionKey(fire), fireDetectionKey({ ...fire, index: 999 }));
  // Different pass over the same pixel is a different detection.
  assert.notEqual(fireDetectionKey(fire), fireDetectionKey({ ...fire, acqMs: fire.acqMs + 1 }));
  assert.notEqual(fireDetectionKey(fire), fireDetectionKey({ ...fire, lat: 31.0 }));
  assert.match(fireDetectionKey({}), /^firms:x:x:0:x$/);
});

test('two satellites over the same pixel at the same time stay distinct', () => {
  // The proxy merges SNPP + NOAA-20 + NOAA-21 without dedup and their orbits
  // overlap, so position and time alone are NOT unique.
  const base = makeFire({ satellite: 'N20' });
  const twin = makeFire({ satellite: 'N21' });
  const suomi = makeFire({ satellite: 'N' });
  assert.notEqual(fireDetectionKey(base), fireDetectionKey(twin));
  assert.notEqual(fireDetectionKey(base), fireDetectionKey(suomi));
  assert.notEqual(fireDetectionKey(twin), fireDetectionKey(suomi));
  // Satellite naming variants normalize to one identity, not three.
  assert.equal(fireDetectionKey(base), fireDetectionKey(makeFire({ satellite: 'NOAA-20' })));
  assert.equal(fireDetectionKey(suomi), fireDetectionKey(makeFire({ satellite: 'Suomi NPP' })));
  // A record with no satellite falls back to its sensor, not to a shared blank.
  const sensorOnly = makeFire({ satellite: '', sensor: 'MODIS' });
  assert.notEqual(fireDetectionKey(sensorOnly), fireDetectionKey(makeFire({ satellite: '', sensor: 'VIIRS' })));
});

test('co-located detections from two satellites stay two features with their own keys', () => {
  const ctx = makeCtx();
  applyFiresPayload(ctx, { fires: [rawFire({ satellite: 'N20' }), rawFire({ satellite: 'N21' })] });
  const keys = ctx.data['dg-firms'].features.map((f) => f.properties.key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2, 'co-located detections must not collapse to one feature');
});

test('clicking a fire selects it, hides its ambient card and centres the camera', () => {
  const ctx = makeCtx();
  applyFiresPayload(ctx, { fires: [rawFire(), rawFire({ lat: -24.9, frp: 120 })] });
  const target = ctx.data['dg-firms'].features[1];
  firmsLayer.click(target.properties, target, ctx);
  assert.equal(ctx.data['dg-firms-sel'].features.length, 1);
  assert.equal(ctx.data['dg-firms-sel'].features[0].properties.key, target.properties.key);
  assert.deepEqual(ctx.filters['dg-firms-label'], ['!=', ['get', 'key'], target.properties.key]);
  assert.deepEqual(ctx.eases.at(-1).center, target.geometry.coordinates);
  firmsLayer.onDisable(ctx);
});

test('a click on the map away from any fire clears the selection without moving the camera', () => {
  const ctx = makeCtx();
  firmsLayer.onEnable(ctx);
  applyFiresPayload(ctx, { fires: [rawFire()] });
  const target = ctx.data['dg-firms'].features[0];
  firmsLayer.click(target.properties, target, ctx);
  const eases = ctx.eases.length;

  ctx.setRendered([target]); // clique em cima do foco: o registro já tratou
  ctx.clickMap();
  assert.equal(ctx.data['dg-firms-sel'].features.length, 1, 'a click on the fire keeps it selected');

  ctx.setRendered([]);
  ctx.clickMap();
  assert.equal(ctx.data['dg-firms-sel'].features.length, 0);
  assert.equal(ctx.filters['dg-firms-label'], null, 'the ambient card comes back');
  assert.equal(ctx.eases.length, eases, 'clearing never moves the camera');

  firmsLayer.onDisable(ctx);
  assert.equal(ctx.handlerCount(), 0, 'disable removes the map click handler');
});

test('a refresh that drops the selected fire clears the selection; one that keeps it does not', () => {
  const ctx = makeCtx();
  const kept = rawFire({ lat: -24.1 });
  const dropped = rawFire({ lat: -24.2, satellite: 'N21' });
  applyFiresPayload(ctx, { fires: [kept, dropped] });
  const [keptF, droppedF] = ctx.data['dg-firms'].features;

  firmsLayer.click(keptF.properties, keptF, ctx);
  applyFiresPayload(ctx, { fires: [dropped, kept] }); // renumerado, mesmo foco
  assert.equal(ctx.data['dg-firms-sel'].features[0].properties.key, keptF.properties.key);

  firmsLayer.click(droppedF.properties, droppedF, ctx);
  applyFiresPayload(ctx, { fires: [kept] });
  assert.equal(ctx.data['dg-firms-sel'].features.length, 0, 'the vanished fire is no longer selected');
  firmsLayer.onDisable(ctx);
});
