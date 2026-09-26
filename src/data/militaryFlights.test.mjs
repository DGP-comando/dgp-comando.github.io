// src/data/militaryFlights.test.mjs
// Testes da camada de voos militares (MapLibre). Funções puras (registro do
// analista, propriedades de desenho, tooltip) e a máquina de poll/rastreio/
// restauração rodam sem DOM nem mapa: o engine é um dublê com a mesma API de
// src/maplibre/engine.js.
//
// MIGRAÇÃO MAPLIBRE (2026-09): o teste "real military track path creates no
// native label…" exercitava a Cesium.Entity rastreada e o host do
// worldOverlay; virou "real military track path hands a neutral target to
// engine.track…", que verifica o mesmo contrato (cartão via gevLabelModel,
// idempotência de câmera, autoridade da seleção, restauração do link) sobre o
// alvo neutro entregue ao engine.track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import militaryFlightsLayer, {
  _addMilitaryTrackingCandidateForTest,
  _applyPendingMilitaryTrackingRestoreForTest,
  _fleetFeaturesForTest,
  _pendingMilitaryTrackingRestoreForTest,
  _setMilitaryTrackingRefreshOutcomeForTest,
  _setTrackedMilitaryRefreshStateForTest,
  _tooltipHtmlForTest,
  _trackedPresentationForTest,
  mapAnalystRecord,
  militaryFeatureProps,
  militaryImageName,
  militaryMapDef,
  TRACKED_MODEL_MAX_PX,
} from './militaryFlights.js';
import { isMilitaryIcao, isMilitaryLayerActive, setMilitaryLayerActive } from './militaryRegistry.js';
import { setTr3b, clearTr3bRegistry } from './tr3bRegistry.js';

test('share-Follow absence requires an accepted adsb.lol snapshot', async () => {
  _setMilitaryTrackingRefreshOutcomeForTest({ status: 'source-unavailable' });
  assert.equal(
    (await militaryFlightsLayer.resolveTrackingRestoreTarget('ae1234')).status,
    'source-unavailable',
  );
  _setMilitaryTrackingRefreshOutcomeForTest({ status: 'accepted', ids: ['different'] });
  const missing = await militaryFlightsLayer.resolveTrackingRestoreTarget('ae1234');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.reason, 'target-absent-from-snapshot');
});

const FULL_INFO = {
  callsign: 'RCH451 ',
  registration: '05-8152',
  rawLat: 31.05,
  rawLon: -97.03,
  altitudeFt: 28000,
  speedMps: 231.5,
  track: 92.1,
  verticalRateMps: 5.08,
  onGround: false,
  klass: 'widebody',
  operator: 'United States Air Force',
};

test('military stats identify adsb.lol as the primary feed, not a fallback', () => {
  const stats = militaryFlightsLayer.getStats();
  assert.equal(stats.source, 'adsb.lol');
  assert.equal(stats.fallback, false);
});

test('military analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord('ae01ce', FULL_INFO);
  assert.deepEqual(r, {
    id: 'RCH451',
    icao24: 'ae01ce',
    callsign: 'RCH451',
    lat: 31.05,
    lon: -97.03,
    altitudeM: 28000 * 0.3048,
    speedMps: 231.5,
    heading: 92.1,
    verticalRateMps: 5.08,
    onGround: false,
    military: true,
    aircraftClass: 'widebody',
    originCountry: null,
    operator: 'United States Air Force',
    routeOrigin: null,
    routeDestination: null,
  });
});

test('military analyst record: military is ALWAYS true, routes/country always null', () => {
  const r = mapAnalystRecord('ae01ce', undefined);
  assert.equal(r.military, true);
  assert.equal(r.originCountry, null);
  assert.equal(r.routeOrigin, null);
  assert.equal(r.routeDestination, null);
});

test('military analyst record: no callsign falls back to registration, then icao24', () => {
  assert.equal(mapAnalystRecord('ae01ce', { ...FULL_INFO, callsign: '' }).id, '05-8152');
  assert.equal(mapAnalystRecord('ae01ce', { callsign: '', registration: ' ' }).id, 'ae01ce');
});

test('military analyst record: empty info yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord('ae01ce', {});
  assert.equal(r.altitudeM, null);
  assert.equal(r.onGround, false);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('military analyst record: output is JSON-safe', () => {
  const r = mapAnalystRecord('ae01ce', FULL_INFO);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('military first update forwards caller cancellation into the feed request', async () => {
  const realFetch = globalThis.fetch;
  let observedSignal = null;
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    options.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    const controller = new AbortController();
    const work = militaryFlightsLayer.update(null, { signal: controller.signal });
    await Promise.resolve();
    assert.ok(observedSignal);
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(observedSignal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('nonempty adsb.lol payload with zero usable rows cannot prove share target absence', async () => {
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'ae1234',
    meta: { rawLat: 31, rawLon: -97, onGround: false },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ac: [null, {}, { hex: 'ae1234' }] }),
  });
  try {
    await militaryFlightsLayer.update(null);
    const resolution = await militaryFlightsLayer.resolveTrackingRestoreTarget('ae1234');
    assert.equal(resolution.status, 'source-unavailable');
    assert.match(militaryFlightsLayer.getStats().error, /Malformed adsb\.lol aircraft rows/);
    assert.equal(militaryFlightsLayer.getAnalystRecords().length, 1, 'warm aircraft data is preserved');
  } finally {
    globalThis.fetch = realFetch;
    militaryFlightsLayer.stopTracking();
  }
});

test('military poll refreshes tracked callsign/altitude/kts and marks a missed poll STALE', async () => {
  const icao24 = 'ae01ce';
  _setTrackedMilitaryRefreshStateForTest({
    icao24,
    position: { lon: -97.0, lat: 31.0, alt: 8_000 },
    meta: {
      callsign: 'OLD2', type: 'C17', klass: 'widebody', registration: '05-8152', operator: 'USAF',
      altitudeFt: 25_000, renderAltitudeM: 7_650, speedMps: 180, track: 80, onGround: false,
      wasAirborne: true, turnRateDps: 0, rawLat: 31.0, rawLon: -97.0,
    },
  });
  const target = militaryFlightsLayer.getTrackedTarget();
  assert.ok(target, 'the seed arms a tracked target');

  const realFetch = globalThis.fetch;
  let poll = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ac: poll++ === 0 ? [{
        hex: icao24, lon: -96.9, lat: 31.1, alt_baro: 28_000, alt_geom: 28_100, track: 95, gs: 400,
        seen: 0, seen_pos: 0, flight: 'RCH451 ', t: 'C17', r: '05-8152', ownOp: 'United States Air Force',
      }] : [],
    }),
  });
  try {
    await militaryFlightsLayer.update(null);
    assert.equal(target.gevLabelModel.title, 'RCH451');
    assert.match(target.gevLabelModel.details.join(' · '), /28000 ft/);
    assert.match(target.gevLabelModel.details.join(' · '), /400 kt/);
    assert.match(target.gevLabelModel.details.join(' · '), /United States Air Force/);
    assert.ok(isMilitaryIcao(icao24), 'the poll feeds the shared military registry');

    await militaryFlightsLayer.update(null);
    assert.match(target.gevLabelModel.title, /STALE/);
  } finally {
    globalThis.fetch = realFetch;
    militaryFlightsLayer.stopTracking();
  }
});

test('a grounded readsb row renders on the ground instead of the 3 km airborne default', async () => {
  _setTrackedMilitaryRefreshStateForTest({ icao24: 'seed00', tracked: false, meta: { rawLat: 0, rawLon: 0 } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ac: [{ hex: 'AE74B5', lon: -149.8, lat: 61.2, alt_baro: 'ground', gs: 6, track: 278, t: 'H60', r: '22-21233' }] }),
  });
  try {
    await militaryFlightsLayer.update(null);
    const [record] = militaryFlightsLayer.getAnalystRecords().filter((r) => r.icao24 === 'ae74b5');
    assert.ok(record, 'hex is normalized to lowercase');
    assert.equal(record.onGround, true);
    const [row] = militaryFlightsLayer.getAllPositions(10).filter((r) => r.id === 'ae74b5');
    assert.equal(row.altitudeM, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function fakeEngine() {
  const listeners = new Map();
  const calls = { track: [], fly: [], jump: [], cancel: 0 };
  const engine = {
    calls,
    trackedTarget: null,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) { for (const fn of listeners.get(type) ?? []) fn(payload); },
    track(target) {
      if (engine.trackedTarget === target) return;
      engine.trackedTarget = target || null;
      calls.track.push(target || null);
      engine.emit('trackedchange', engine.trackedTarget);
    },
    cancelFlight() { calls.cancel += 1; },
    cameraLookingAt(target, orbit) { return { lat: target.lat, lon: target.lon, alt: orbit.rangeM, heading: orbit.heading, pitch: orbit.pitch }; },
    flyToCamera(view, opts) { calls.fly.push([view, opts]); },
    setCameraView(view) { calls.jump.push(view); },
    getCameraView: () => ({ lon: -97.7, lat: 30.1, alt: 20_000, heading: 0, pitch: -60, zoom: 9, targetLat: 30.2, targetLon: -97.7 }),
    project: () => null,
  };
  return engine;
}

test('real military track path hands a neutral target to engine.track and keeps restore semantics', () => {
  const icao24 = 'ae01ce';
  const engine = fakeEngine();
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const selectionEvents = [];
  const clearEvents = [];
  globalThis.window.addEventListener('gev:awareness-subject-selected', (event) => selectionEvents.push(event.detail));
  globalThis.window.addEventListener('gev:awareness-subject-cleared', (event) => clearEvents.push(event.detail));
  try {
    _setTrackedMilitaryRefreshStateForTest({
      icao24,
      engine,
      tracked: false,
      position: { lon: -97.03, lat: 31.05, alt: 8_534.4 },
      history: [{ time: Date.now(), epochMs: Date.now(), position: { lon: -97.03, lat: 31.05, alt: 8_534.4 }, velocity: 231.5, track: 92 }],
      meta: { ...FULL_INFO, type: 'C17', turnRateDps: 0, wasAirborne: true },
    });
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    const target = engine.trackedTarget;
    assert.ok(target, 'trackById hands a target to engine.track');
    assert.equal(target, militaryFlightsLayer.getTrackedTarget());
    assert.equal(target.gevTrackedId, `military:${icao24}`);
    assert.equal(target.layerId, 'military');
    assert.equal(target.mapLabel, true, 'the card is this layer\'s own map marker');
    assert.equal(target.releaseOnDrag, false);
    assert.deepEqual(target.gevLabelModel, {
      title: 'RCH451',
      details: ['C17 · 05-8152', 'United States Air Force · 28000 ft · 450 kt'],
      accent: '#ffd166',
    });
    const pos = target.getPosition();
    assert.ok(Number.isFinite(pos.lon) && Number.isFinite(pos.lat), 'getPosition returns the interpolated {lon, lat}');
    assert.equal(target.gevDisplayPosition(), target.getPosition(), 'the same frame reuses one cached position');
    const pose = militaryFlightsLayer.getTrackedPose();
    assert.equal(pose.icao24, icao24);
    assert.ok(Math.abs(pose.altitudeM - 28000 * 0.3048) < 1e-6);
    const info = militaryFlightsLayer.getTrackedInfo();
    assert.equal(info.icao24, icao24);
    assert.equal(info.registration, '05-8152');
    assert.equal(engine.calls.fly.length, 1, 'initial follow frame is one camera flight');
    assert.equal(typeof selectionEvents.at(-1)?.position?.x, 'number', 'selection event carries the neutral point with ECEF');
    assert.equal(selectionEvents.at(-1)?.layerId, 'military');

    const cancels = engine.calls.cancel;
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(engine.calls.cancel, cancels, 'ordinary repeated tracking stays camera-idempotent');
    assert.equal(selectionEvents.at(-1)?.origin, 'user', 'same-target selection upgrades durable authority');
    assert.equal(target.gevSelectionOrigin, 'user');
    assert.equal(militaryFlightsLayer.refocusTrackedById('different-flight'), false);
    assert.equal(militaryFlightsLayer.refocusTrackedById(icao24, { origin: 'voice' }), true);
    assert.equal(selectionEvents.at(-1)?.origin, 'voice');
    assert.equal(engine.trackedTarget, target, 'refocus keeps the exact tracked target');
    assert.equal(engine.calls.fly.length, 2, 'refocus reapplies the frame once');

    // Outra camada pega a câmera: esta solta o alvo sem mexer no engine.
    const other = { id: 'flights:x', gevSelectionOrigin: 'user', getPosition: () => ({ lon: 0, lat: 0 }) };
    engine.track(other);
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, null);
    assert.equal(engine.trackedTarget, other);
    assert.equal(clearEvents.at(-1)?.reason, 'deliberate');
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'user' }), true);

    // Restauração do link: pendências e cancelamentos.
    militaryFlightsLayer.setParams({ selectedMilitaryTrackingId: 'late001' }, { origin: 'share-restore' });
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), 'late001');
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), null, 'new user selection cancels stale restore');
    _addMilitaryTrackingCandidateForTest({ icao24: 'late001', meta: { ...FULL_INFO, callsign: 'LATE1', rawLat: 31.1, rawLon: -96.9 } });
    _applyPendingMilitaryTrackingRestoreForTest();
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, icao24);

    militaryFlightsLayer.stopTracking();
    assert.equal(engine.trackedTarget, null, 'stopTracking releases the camera in place');
    militaryFlightsLayer.setParams({ selectedMilitaryTrackingId: 'late002' }, { origin: 'local-restore' });
    militaryFlightsLayer.stopTracking({ origin: 'user' });
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), null, 'explicit clear cancels stale restore');

    militaryFlightsLayer.setParams({ selectedMilitaryTrackingId: 'late003' }, { origin: 'local-restore' });
    militaryFlightsLayer.setParams({ models3d: false }, { origin: 'voice' });
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), null, 'a newer explicit non-selection option cancels stale restore');
    assert.equal(militaryFlightsLayer.getParams().models3d, false, 'the 3D option is still accepted (degrades to icons)');

    militaryFlightsLayer.setParams({ selectedMilitaryTrackingId: 'late004' }, { origin: 'local-restore' });
    _addMilitaryTrackingCandidateForTest({ icao24: 'late004', meta: { ...FULL_INFO, callsign: 'LATE4', rawLat: 30.7, rawLon: -97.2 } });
    assert.equal(_applyPendingMilitaryTrackingRestoreForTest(), true);
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, 'late004');

    militaryFlightsLayer.setParams({ selectedMilitaryTrackingId: 'late005' }, { origin: 'share-restore' });
    assert.equal(militaryFlightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    assert.equal(_pendingMilitaryTrackingRestoreForTest(), 'late005',
      'passive autofocus cannot revoke the restored target still waiting for its feed row');
    _addMilitaryTrackingCandidateForTest({ icao24: 'late005', meta: { ...FULL_INFO, callsign: 'LATE5', rawLat: 31.4, rawLon: -96.6 } });
    assert.equal(_applyPendingMilitaryTrackingRestoreForTest(), true);
    assert.equal(militaryFlightsLayer.getParams().selectedMilitaryTrackingId, 'late005');
  } finally {
    militaryFlightsLayer.stopTracking();
    globalThis.window = realWindow;
  }
});

test('public positions are neutral points and getNearby accepts any centre format', () => {
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'ae0001',
    tracked: false,
    position: { lon: -97.0, lat: 31.0, alt: 3000 },
    meta: { ...FULL_INFO, type: 'C130', rawLat: 31.0, rawLon: -97.0 },
  });
  const [near] = militaryFlightsLayer.getNearby({ lon: -97.0, lat: 31.05 }, 50_000, 5);
  assert.equal(near.icao24, 'ae0001');
  assert.equal(near.type, 'C130');
  assert.equal(near.operator, 'United States Air Force');
  assert.ok(near.distance > 5000 && near.distance < 7000);
  assert.ok(Object.isFrozen(near.position) && Number.isFinite(near.position.x), 'neutral {lon,lat,height,x,y,z}');
  const ecef = militaryFlightsLayer.getNearby(near.position, 1, 5);
  assert.equal(ecef[0]?.icao24, 'ae0001', 'an ECEF-shaped centre still resolves');
  const [detected] = militaryFlightsLayer.getDetectableObjects({ maxCount: 5 });
  assert.equal(detected.tier, 'military');
  assert.equal(detected.klass, 'C130');
  assert.equal(detected.metric, 'FL280');
  assert.equal(militaryFlightsLayer.hasContact('AE0001'), true);
  assert.equal(militaryFlightsLayer.hasContact('ffffff'), false);
});

test('fleet features carry the amber military glyph, class scale, heading and STALE fade', () => {
  const props = militaryFeatureProps('ae0002', { klass: 'helicopter', onGround: false }, { course: 370, alpha: 0.45 });
  assert.equal(props.img, 'helicopter-m');
  assert.equal(props.r, 10);
  assert.equal(props.a, 0.45);
  const ground = militaryFeatureProps('ae0002', { klass: 'helicopter', onGround: true }, {});
  assert.ok(Math.abs(ground.s / props.s - 0.8) < 1e-9, 'ground contacts draw ×0.8');
  const dot = militaryFeatureProps('ae0002', { klass: 'widebody' }, { cockpitDot: true });
  assert.equal(dot.img, 'dot-m', 'cockpit far band draws the amber pip');
  assert.equal(dot.r, 0);
  assert.equal(militaryImageName('lo', 'fastjet', 'm'), 'dg-mil-lo-fastjet-m');
  assert.equal(TRACKED_MODEL_MAX_PX, 200);

  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'ae0003',
    tracked: false,
    position: { lon: 10, lat: 50, alt: 1000 },
    meta: { ...FULL_INFO, klass: 'fastjet', rawLat: 50, rawLon: 10 },
  });
  const fc = _fleetFeaturesForTest(Date.now());
  assert.equal(fc.features.length, 1);
  assert.deepEqual(fc.features[0].geometry.coordinates, [10, 50]);
  assert.equal(fc.features[0].properties.img, 'fastjet-m');
});

test('a TR-3B conversion swaps the glyph, its IR variant and every type label', () => {
  clearTr3bRegistry();
  try {
    _setTrackedMilitaryRefreshStateForTest({
      icao24: 'ae0004',
      tracked: true,
      position: { lon: 10, lat: 50, alt: 1000 },
      meta: { ...FULL_INFO, type: 'C17', rawLat: 50, rawLon: 10 },
    });
    setTr3b('ae0004', true);
    militaryFlightsLayer.refreshTr3b('ae0004');
    assert.equal(militaryFeatureProps('ae0004', { klass: 'widebody' }).img, 'tr3b-m');
    militaryFlightsLayer.setParams({ irBoost: true });
    assert.equal(militaryFeatureProps('ae0004', { klass: 'widebody' }).img, 'tr3bHot-m');
    assert.equal(_trackedPresentationForTest().kind, 'tr3bHot');
    assert.match(militaryFlightsLayer.getTrackedTarget().gevLabelModel.details[0], /TR-3B/);
    assert.equal(mapAnalystRecord('ae0004', { klass: 'widebody' }).aircraftClass, 'tr3b');
  } finally {
    militaryFlightsLayer.setParams({ irBoost: false });
    militaryFlightsLayer.stopTracking();
    clearTr3bRegistry();
  }
});

test('map definition follows the host contract and the tooltip escapes feed text', () => {
  assert.equal(militaryMapDef.id, 'military');
  for (const id of Object.keys(militaryMapDef.sources)) assert.ok(id.startsWith('dg-'));
  for (const layer of militaryMapDef.layers) {
    assert.ok(layer.id.startsWith('dg-'));
    assert.equal(layer.type, 'symbol');
  }
  assert.deepEqual(militaryMapDef.interactive, militaryMapDef.layers.map((l) => l.id));
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'ae0005',
    tracked: false,
    meta: { ...FULL_INFO, callsign: '<b>X</b>', type: 'F16', rawLat: 1, rawLon: 1 },
  });
  const html = _tooltipHtmlForTest('ae0005');
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  assert.match(html, /F16/);
  assert.match(html, /28\.000 ft|28,000 ft|28000 ft/);
  assert.equal(_tooltipHtmlForTest('nope'), '');
});

test('enable/disable hands military ownership to and back from the flights layer', async () => {
  const engine = fakeEngine();
  militaryFlightsLayer.init(engine);
  await militaryFlightsLayer.enable(engine);
  try {
    assert.equal(isMilitaryLayerActive(), true, 'flights suppresses its military duplicates while this layer draws them');
  } finally {
    militaryFlightsLayer.disable();
    militaryFlightsLayer.destroy();
  }
  assert.equal(isMilitaryLayerActive(), false);
  setMilitaryLayerActive(false);
});

/**
 * The tool instructions tell the model to look a contact up with analyst_query
 * and then hand that identity to track_entity. The analyst's `id` is a DISPLAY
 * label — callsign, else registration, else hex — so a callsign-less contact
 * must be findable by the tail number the app displays.
 */
test('a callsign-less contact is findable by the tail number the app displays', () => {
  const icao24 = 'ae7f01';
  _addMilitaryTrackingCandidateForTest({
    icao24,
    meta: {
      callsign: null, registration: '6606', type: 'UH60', operator: 'US Army', altitudeFt: 550,
      speedMps: 67, track: 210, klass: 'helicopter', onGround: false, rawLat: 40.71, rawLon: -74.01,
    },
  });
  const analystId = mapAnalystRecord(icao24, {
    callsign: null, registration: '6606', rawLat: 40.71, rawLon: -74.01,
  }).id;
  assert.equal(analystId, '6606', 'the analyst names a callsign-less contact by its tail');
  const found = militaryFlightsLayer.findByQuery(analystId);
  assert.equal(found?.icao24, icao24, 'and the tracker must resolve that same identity');
  assert.equal(militaryFlightsLayer.findByQuery('660')?.icao24, icao24, 'prefix match too');
  assert.equal(militaryFlightsLayer.findByQuery(icao24)?.icao24, icao24, 'hex still wins outright');
});

test('the analyst record carries the hex key the tracker keys on', () => {
  const record = mapAnalystRecord('ae7f01', {
    callsign: null, registration: '6606', rawLat: 40.71, rawLon: -74.01,
  });
  assert.equal(record.icao24, 'ae7f01', 'a resolvable key must ride along with the display label');
});

test('a registration never outranks another contact’s exact callsign', () => {
  const base = {
    type: 'C17', operator: 'USAF', altitudeFt: 25000, speedMps: 180,
    track: 90, klass: 'widebody', onGround: false,
  };
  _addMilitaryTrackingCandidateForTest({
    icao24: 'ae0aa1',
    meta: { ...base, callsign: null, registration: 'ZULU777', rawLat: 31.0, rawLon: -97.0 },
  });
  _addMilitaryTrackingCandidateForTest({
    icao24: 'ae0bb2',
    meta: { ...base, callsign: 'ZULU777', registration: '05-9999', rawLat: 31.2, rawLon: -97.2 },
  });
  assert.equal(militaryFlightsLayer.findByQuery('ZULU777')?.icao24, 'ae0bb2',
    'the contact whose CALLSIGN is ZULU777 wins, not the one listed first');
  assert.equal(militaryFlightsLayer.findByQuery('059999')?.icao24, 'ae0bb2',
    'and a separator-free registration still resolves');
});

test('two contacts matching at the same strength resolve deterministically', () => {
  const base = {
    type: 'C130', operator: 'USAF', altitudeFt: 21000, speedMps: 150,
    track: 45, klass: 'turboprop', onGround: false,
  };
  _addMilitaryTrackingCandidateForTest({
    icao24: 'aef002',
    meta: { ...base, callsign: null, registration: 'QQ7-222', rawLat: 32.0, rawLon: -98.0 },
  });
  _addMilitaryTrackingCandidateForTest({
    icao24: 'aef001',
    meta: { ...base, callsign: null, registration: 'QQ7-111', rawLat: 32.1, rawLon: -98.1 },
  });
  const first = militaryFlightsLayer.findByQuery('QQ7')?.icao24;
  const second = militaryFlightsLayer.findByQuery('qq7')?.icao24;
  assert.equal(first, 'aef001', 'the stable key (lowest hex) wins, not the feed order');
  assert.equal(second, first, 'and the same query resolves the same way every time');
});
