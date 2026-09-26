// src/data/bikeshare.test.mjs — selected-station card (MapLibre port).
//
// The Cesium build selected a station by hiding its PointPrimitive and adding
// a highlight Entity; the MapLibre build highlights it with a filtered circle
// layer and publishes the same selected card entry to the card host. The card
// contract (copy + protected-lane policy) is unchanged; positions are now
// neutral `{lon, lat, height}`.
import test from 'node:test';
import assert from 'node:assert/strict';
import bikeshareLayer, {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  _clearBikeshareSelectionForTest,
  _selectBikeshareStationForTest,
  _selectedBikeshareKeyForTest,
  _setBikeshareSelectionStateForTest,
  createBikeshareSelectedOverlayEntry,
} from './bikeshare.js';

function makeRecord() {
  return {
    key: 'austin-capmetro:3790',
    stationId: '3790',
    stationName: 'Congress & 6th',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: false,
    isReturning: true,
    position: { lon: -97.7431, lat: 30.2672, height: 0 },
  };
}

test('selected bikeshare entry preserves source copy and protected-lane policy', () => {
  const record = makeRecord();
  const entry = createBikeshareSelectedOverlayEntry('austin-capmetro:3790', record);
  assert.equal(entry.position, record.position);
  assert.equal(entry.title, 'Congress & 6th');
  assert.deepEqual(entry.details, [
    '🚲 7 avail · 4 docks · 11 cap',
    '⚠️ Not renting',
  ]);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});

test('legacy record shape (point.position) is still accepted; no position → no entry', () => {
  const legacy = { ...makeRecord(), position: undefined, point: { position: { lon: 1, lat: 2 } } };
  assert.deepEqual(createBikeshareSelectedOverlayEntry('k', legacy).position, { lon: 1, lat: 2 });
  assert.equal(createBikeshareSelectedOverlayEntry('k', { ...makeRecord(), position: null }), null);
  assert.equal(createBikeshareSelectedOverlayEntry('', makeRecord()), null);
});

test('real station select/clear path publishes one card and highlights via the layer filter', () => {
  const calls = [];
  const filters = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const engine = {
    map: {
      getLayer: (id) => id === 'dg-bikeshare-selected',
      setFilter: (id, filter) => filters.push([id, filter]),
    },
  };
  const key = 'austin-capmetro:3790';
  const record = makeRecord();
  _setBikeshareSelectionStateForTest({ engine, key, record, overlayHost });
  try {
    _selectBikeshareStationForTest(key);
    assert.equal(_selectedBikeshareKeyForTest(), key);
    assert.deepEqual(filters.at(-1), ['dg-bikeshare-selected', ['==', ['get', 'key'], key]]);

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'bikeshare-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.position);
    assert.deepEqual(publication[3], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    _clearBikeshareSelectionForTest();
    assert.equal(_selectedBikeshareKeyForTest(), null);
    assert.deepEqual(filters.at(-1), ['dg-bikeshare-selected', ['==', ['get', 'key'], '']]);
    assert.deepEqual(calls.at(-1), ['clear', 'bikeshare-selected']);
  } finally {
    _clearBikeshareSelectionForTest();
  }
});

test('disabled layer reports empty detection and idle stats without a map', () => {
  assert.deepEqual(bikeshareLayer.getDetectableObjects({ maxCount: 5 }), []);
  const stats = bikeshareLayer.getStats();
  assert.equal(stats.loading, false);
  assert.equal(typeof stats.count, 'number');
});
