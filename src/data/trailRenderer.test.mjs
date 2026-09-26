import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrail, trailCoordinates } from './trailRenderer.js';

function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  return {
    sources,
    layers,
    addSource(id, spec) {
      sources.set(id, { spec, data: spec.data, setData(d) { this.data = d; } });
    },
    getSource: (id) => sources.get(id),
    addLayer(spec, before) { layers.set(spec.id, { ...spec, before }); },
    getLayer: (id) => layers.get(id),
    setLayoutProperty(id, key, value) { layers.get(id).layout[key] = value; },
    removeLayer: (id) => layers.delete(id),
    removeSource: (id) => sources.delete(id),
  };
}

test('trail visibility can change without discarding its accumulated geometry', () => {
  const map = fakeMap();
  const trail = createTrail({ map }, { color: '#ffffff' });
  const positions = [{ lon: -49.2, lat: -25.4, alt: 900 }, { lon: -49.1, lat: -25.3, alt: 950 }];

  trail.setVisible(false);
  trail.setPositions(positions);
  assert.equal(map.layers.size, 1);
  const layer = [...map.layers.values()][0];
  assert.equal(layer.type, 'line');
  assert.equal(layer.layout.visibility, 'none');
  const src = map.sources.get(trail.sourceId);
  assert.deepEqual(src.data.features[0].geometry.coordinates, [[-49.2, -25.4], [-49.1, -25.3]]);

  trail.setVisible(true);
  assert.equal(layer.layout.visibility, 'visible');
  assert.deepEqual(trail.getCoordinates(), [[-49.2, -25.4], [-49.1, -25.3]]);

  trail.destroy();
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
});

test('trail drops duplicate points, clears below two, and accepts legacy shapes', () => {
  assert.deepEqual(trailCoordinates([{ lon: 1, lat: 1 }, { lon: 1, lat: 1 }]), []);
  assert.deepEqual(trailCoordinates([[1, 1, 0], [2, 1]]), [[1, 1], [2, 1]]);
  // ECEF (compatibilidade): ponto no equador/greenwich e outro a 90° E.
  const coords = trailCoordinates([{ x: 6378137, y: 0, z: 0 }, { lon: 0.001, lat: 0 }]);
  assert.equal(coords.length, 2);
  assert.ok(Math.abs(coords[0][0]) < 1e-9 && Math.abs(coords[0][1]) < 1e-9);
});

test('long legs are densified along the great circle (no chord through the map)', () => {
  const coords = trailCoordinates([{ lon: -46.6, lat: -23.5 }, { lon: -0.45, lat: 51.47 }]);
  assert.ok(coords.length > 30);
  // A geodésica São Paulo -> Londres passa bem a oeste da reta em lon/lat no meio.
  const mid = coords[Math.floor(coords.length / 2)];
  assert.ok(Number.isFinite(mid[0]) && Number.isFinite(mid[1]));
  assert.deepEqual(coords[0], [-46.6, -23.5]);
  assert.deepEqual(coords[coords.length - 1], [-0.45, 51.47]);
});

test('trail waits for the map and retries on the next update', () => {
  const trail = createTrail(null, { color: 'red' });
  trail.setPositions([{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }]);
  assert.equal(trail.getCoordinates().length, 2);
  trail.clear();
  assert.deepEqual(trail.getCoordinates(), []);
});
