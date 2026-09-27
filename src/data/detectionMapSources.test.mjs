import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_FIRMS_DETECTION_SPEC,
  createMapDetectionSources,
  createMapSourceDetectionLayer,
} from './detectionMapSources.js';

function fire(key, lon, lat, frp, sev = 'red') {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { key, frp, sev } };
}

function mockEngine(features, { visible = true } = {}) {
  const handlers = new Map();
  let queries = 0;
  const map = {
    getLayer: (id) => (id === 'dg-firms-heat' ? { id } : null),
    getLayoutProperty: () => (visible ? 'visible' : 'none'),
    querySourceFeatures(sourceId) {
      queries++;
      assert.equal(sourceId, 'dg-firms');
      return features;
    },
    on(type, fn) { handlers.set(type, fn); },
    off(type) { handlers.delete(type); },
  };
  const moveEnd = new Set();
  return {
    map,
    on(type, fn) {
      if (type === 'moveend') moveEnd.add(fn);
      return () => moveEnd.delete(fn);
    },
    get queries() { return queries; },
    fireSourceData: (sourceId) => handlers.get('sourcedata')?.({ sourceId }),
    moveEnd,
  };
}

test('local-firms targets come from the dg-firms source, deduplicated and strongest first', () => {
  const engine = mockEngine([
    fire('a', -50, -25, 12.5),
    fire('b', -51, -24, 180),
    fire('a', -50, -25, 12.5), // same fire in a neighbouring tile
  ]);
  const [firms] = createMapDetectionSources(engine);
  assert.equal(firms.id, 'local-firms');
  const objects = firms.getDetectableObjects({ mode: 'DENSE', maxCount: 10 });
  assert.deepEqual(objects.map((o) => o.sourceId), ['b', 'a']);
  assert.deepEqual(objects[0].position, { lon: -51, lat: -24, height: 0 });
  assert.equal(objects[0].type, 'FIRE');
  assert.equal(objects[0].id, 'FIRE 180 MW');
  assert.equal(objects[1].id, 'FIRE 12.5 MW');
  assert.equal(objects[0].metric, 'RED');
  assert.equal(firms.getDetectableObjects({ maxCount: 1 }).length, 1);
  firms.destroy();
  assert.equal(engine.moveEnd.size, 0);
});

test('the source query is cached between frames and refreshed on data or camera changes', () => {
  const features = [fire('a', 0, 0, 5)];
  const engine = mockEngine(features);
  const layer = createMapSourceDetectionLayer(engine, LOCAL_FIRMS_DETECTION_SPEC);
  layer.getDetectableObjects();
  layer.getDetectableObjects();
  assert.equal(engine.queries, 1, 'a second paint in the same instant reuses the query');
  features.push(fire('c', 1, 1, 50));
  engine.fireSourceData('dg-firms');
  assert.equal(layer.getDetectableObjects().length, 2);
  for (const fn of engine.moveEnd) fn();
  layer.getDetectableObjects();
  assert.equal(engine.queries, 3);
});

test('a hidden local-firms layer contributes no targets', () => {
  const engine = mockEngine([fire('a', 0, 0, 5)], { visible: false });
  const [firms] = createMapDetectionSources(engine);
  assert.deepEqual(firms.getDetectableObjects(), []);
  assert.equal(engine.queries, 0);
  assert.deepEqual(createMapDetectionSources({}), [], 'no map, no map sources');
});
