import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
  unregisterSpriteCollection,
} from './spriteOrder.js';
import flightsLayer from './flights.js';
import aisLiveVesselsLayer from './aisLiveVessels.js';

const ORDER = ['cctv', 'firms', 'bikeshare', 'ais', 'military', 'flights'];

function makePrimitives(initial = []) {
  return {
    items: [...initial],
    calls: [],
    contains(collection) { return this.items.includes(collection); },
    raiseToTop(collection) {
      this.calls.push(collection.id);
      const index = this.items.indexOf(collection);
      if (index >= 0) this.items.splice(index, 1);
      this.items.push(collection);
    },
  };
}

function makeCollection(id, destroyed = false) {
  return { id, isDestroyed: () => destroyed };
}

test('restoreSpriteOrder raises live collections bottom-to-top and skips destroyed entries', () => {
  const collections = Object.fromEntries(ORDER.map((id) => [id, makeCollection(id)]));
  const destroyedFirms = makeCollection('firms', true);
  for (const id of ORDER) {
    registerSpriteCollection(id, id === 'firms' ? destroyedFirms : collections[id]);
  }
  const primitives = makePrimitives([
    collections.flights,
    collections.ais,
    collections.cctv,
    collections.bikeshare,
    collections.military,
  ]);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, ['cctv', 'bikeshare', 'ais', 'military', 'flights']);
  assert.deepEqual(primitives.items.map((item) => item.id), [
    'cctv', 'bikeshare', 'ais', 'military', 'flights',
  ]);

  for (const id of ORDER) unregisterSpriteCollection(id);
});

test('late CCTV registration still restores flights above the ambient collection', () => {
  const flights = makeCollection('flights');
  const cctv = makeCollection('cctv');
  const primitives = makePrimitives([flights]);
  const viewer = { scene: { primitives } };

  registerSpriteCollection('flights', flights);
  restoreSpriteOrder(viewer);
  primitives.items.push(cctv); // CCTV enabled after flights: it starts on top.
  registerSpriteCollection('cctv', cctv);
  primitives.calls.length = 0;

  restoreSpriteOrder(viewer);

  assert.deepEqual(primitives.calls, ['cctv', 'flights']);
  assert.deepEqual(primitives.items.map((item) => item.id), ['cctv', 'flights']);

  unregisterSpriteCollection('cctv', cctv);
  unregisterSpriteCollection('flights', flights);
});

test('restoreSpriteOrder is inert for destroyed viewers and primitive collections', () => {
  const flights = makeCollection('flights');
  const primitives = makePrimitives([flights]);
  registerSpriteCollection('flights', flights);

  restoreSpriteOrder({ isDestroyed: () => true, scene: { primitives } });
  restoreSpriteOrder({ scene: { primitives: { ...primitives, isDestroyed: () => true } } });

  assert.deepEqual(primitives.calls, []);
  unregisterSpriteCollection('flights', flights);
});

test('restoreSpriteOrder never raises a registered collection absent from scene primitives', () => {
  const flights = makeCollection('flights');
  const primitives = makePrimitives([]);
  registerSpriteCollection('flights', flights);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, []);
  assert.deepEqual(primitives.items, []);
  unregisterSpriteCollection('flights', flights);
});

// A camada FIRMS saiu desta checagem: a versão MapLibre (contextoGev.js)
// desenha os focos como layers do mapa, sem coleção de sprites Cesium.
test('flights and AIS enable paths are wired through the shared sprite restorer', () => {
  const viewer = { id: 'viewer' };
  const calls = [];
  const restoreSpy = (value) => calls.push(value);
  for (const layerId of ['flights', 'ais', 'firms']) {
    restoreSpriteOrderOnEnable(layerId, viewer, restoreSpy);
  }
  assert.deepEqual(calls, [viewer, viewer, viewer]);

  assert.match(flightsLayer.enable.toString(), /restoreSpriteOrderOnEnable\(LAYER_ID, _engine\)/);
  // Camadas já portadas ao MapLibre sem sprite order próprio (AIS) ficam fora.
  const aisEnable = aisLiveVesselsLayer.enable.toString();
  if (/restoreSpriteOrderOnEnable/.test(aisEnable)) assert.match(aisEnable, /restoreSpriteOrderOnEnable\('ais'/);
});
