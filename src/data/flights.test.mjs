// src/data/flights.test.mjs
// Testes da camada de voos (MapLibre). As funções puras (registro do analista,
// dead reckoning, propriedades de desenho) e a máquina de rastreio/restauração
// rodam sem DOM nem mapa: o engine é um dublê com a mesma API de
// src/maplibre/engine.js.
//
// MIGRAÇÃO MAPLIBRE (2026-09): os ~40 testes "display floor" do app Cesium
// saíram junto com o código que testavam. Eles pinavam o piso de exibição que
// erguia contatos no solo acima da malha fotorrealista 3D (células de piso,
// retenção, rampa de descida…) — um problema que só existe com sprites
// depth-tested sobre terreno 3D. No MapLibre 2D o ícone é desenhado no mapa, sem
// altura, e a camada não usa mais aquele piso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import flightsLayer, {
  _addFlightTrackingCandidateForTest,
  _applyPendingFlightTrackingRestoreForTest,
  _armFlightTrackingRestoreForTest,
  _deadReckonForTest,
  _fleetFeaturesForTest,
  _militaryLayerSuppressesForTest,
  _pendingFlightTrackingRestoreForTest,
  _setFlightTrackingRefreshOutcomeForTest,
  _setTrackedFlightRefreshStateForTest,
  _tooltipHtmlForTest,
  _trackedPresentationForTest,
  _trailPositionsForTest,
  fleetFeatureProps,
  flightImageName,
  flightsMapDef,
  mapAnalystRecord,
  nearFarFactorAtZoom,
  tintRaster,
  TRACKED_MODEL_MAX_PX,
} from './flights.js';
import { setMilitaryLayerActive } from './militaryRegistry.js';
import { setTr3b, clearTr3bRegistry } from './tr3bRegistry.js';

test('share-Follow absence requires an accepted OpenSky snapshot', async () => {
  _setFlightTrackingRefreshOutcomeForTest({ status: 'source-unavailable' });
  assert.equal(
    (await flightsLayer.resolveTrackingRestoreTarget('abc123')).status,
    'source-unavailable',
  );
  _setFlightTrackingRefreshOutcomeForTest({ status: 'accepted', ids: ['different'] });
  const missing = await flightsLayer.resolveTrackingRestoreTarget('abc123');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.reason, 'target-absent-from-snapshot');
});

const FULL_INFO = {
  callsign: 'SWA696  ',
  rawLat: 30.1945,
  rawLon: -97.6699,
  altitude: 1234.5,
  velocity: 210.2,
  true_track: 187.4,
  verticalRate: -4.5,
  onGround: false,
  klass: 'airliner',
  originCountry: 'United States',
  airline: 'Southwest Airlines',
  route: { origin: { code: 'AUS' }, destination: { code: 'LAX' } },
};

test('flights analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord('a1b2c3', FULL_INFO, { military: false, routeOk: true });
  assert.deepEqual(r, {
    id: 'SWA696',
    icao24: 'a1b2c3',
    callsign: 'SWA696',
    lat: 30.1945,
    lon: -97.6699,
    altitudeM: 1234.5,
    speedMps: 210.2,
    heading: 187.4,
    verticalRateMps: -4.5,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    originCountry: 'United States',
    operator: 'Southwest Airlines',
    routeOrigin: 'AUS',
    routeDestination: 'LAX',
  });
});

test('flights analyst record: implausible route is suppressed (routeOk=false)', () => {
  const r = mapAnalystRecord('a1b2c3', FULL_INFO, { routeOk: false });
  assert.equal(r.routeOrigin, null);
  assert.equal(r.routeDestination, null);
});

test('flights analyst record: empty info yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord('abc123', undefined);
  assert.equal(r.id, 'abc123'); // callsign fallback
  assert.equal(r.callsign, null);
  assert.equal(r.onGround, false);
  assert.equal(r.military, false);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('flights analyst record: no callsign falls back to registration, then icao24', () => {
  const r = mapAnalystRecord('abc123', { ...FULL_INFO, callsign: '   ' });
  assert.equal(r.id, 'abc123'); // FULL_INFO carries no registration
  assert.equal(r.callsign, null);
  assert.equal(mapAnalystRecord('abc123', { ...FULL_INFO, callsign: '', registration: 'N123AB' }).id, 'N123AB');
  assert.equal(mapAnalystRecord('abc123', { callsign: '', registration: ' ' }).id, 'abc123');
});

test('flights analyst record: NaN kinematics become null, military flag passes through', () => {
  const r = mapAnalystRecord('ae01ce', {
    ...FULL_INFO, velocity: NaN, true_track: undefined, verticalRate: null,
  }, { military: true });
  assert.equal(r.speedMps, null);
  assert.equal(r.heading, null);
  assert.equal(r.verticalRateMps, null);
  assert.equal(r.military, true);
});


// ---------------------------------------------------------------------------
// Ciclo de poll
// ---------------------------------------------------------------------------

const NO_ENGINE = { getCameraView: () => ({ targetLat: NaN, targetLon: NaN }) };

test('flights first update forwards caller cancellation into the feed request', async () => {
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
    const work = flightsLayer.update(NO_ENGINE, { signal: controller.signal });
    await Promise.resolve();
    assert.ok(observedSignal);
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(observedSignal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('dev proxy URL is anchored at the map view centre', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/opensky')) seen ??= String(url);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: 0, states: [] }) };
  };
  try {
    await flightsLayer.update({ getCameraView: () => ({ targetLat: -25.43, targetLon: -49.27 }) });
    assert.equal(seen, '/api/opensky?lat=-25.4300&lon=-49.2700');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('nonempty OpenSky payload with zero usable rows cannot prove share target absence', async () => {
  _setTrackedFlightRefreshStateForTest({
    icao24: 'abc123',
    meta: { rawLat: 30.2, rawLon: -97.7, onGround: false },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ states: [null, {}, ['abc123', null, null, null, null, null, null]] }),
  });
  try {
    await flightsLayer.update(NO_ENGINE);
    const resolution = await flightsLayer.resolveTrackingRestoreTarget('abc123');
    assert.equal(resolution.status, 'source-unavailable');
    assert.match(flightsLayer.getStats().error, /Malformed OpenSky aircraft rows/);
    assert.equal(flightsLayer.getAnalystRecords().length, 1, 'warm aircraft data is preserved');
  } finally {
    globalThis.fetch = realFetch;
    flightsLayer.stopTracking();
  }
});

test('flights poll refreshes tracked callsign/FL/kts and marks a missed poll STALE', async () => {
  const icao24 = 'a1b2c3';
  _setTrackedFlightRefreshStateForTest({
    icao24,
    position: { lon: -97.7, lat: 30.2, alt: 9_000 },
    meta: {
      callsign: 'OLD1', altitude: 9_000, renderAltitudeM: 9_050, velocity: 180, true_track: 80,
      klass: 'airliner', onGround: false, wasAirborne: true, turnRateDps: 0, rawLat: 30.2, rawLon: -97.7,
    },
  });
  const target = flightsLayer.getTrackedTarget();
  assert.ok(target, 'the seeded contact is tracked');

  const realFetch = globalThis.fetch;
  const nowSec = Math.floor(Date.now() / 1000);
  let openskyPoll = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/api/opensky')) return { ok: true, status: 200, json: async () => ({ ac: [] }) };
    const states = openskyPoll++ === 0
      ? [[icao24, 'DAL123 ', 'United States', nowSec, nowSec, -97.6, 30.3, 10_668, false, 250, 95, 5, null, 10_700, null, null, null, 5]]
      : [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: nowSec, states }) };
  };
  try {
    await flightsLayer.update(NO_ENGINE);
    assert.equal(target.gevLabelModel.title, 'DAL123');
    assert.match(target.gevLabelModel.details.join(' · '), /FL350/);
    assert.match(target.gevLabelModel.details.join(' · '), /486 kts/);
    assert.deepEqual(_trailPositionsForTest().at(-1), { lon: -97.6, lat: 30.3, alt: 10_700 },
      'a new fix of the tracked contact joins its trail (geo_altitude as height)');

    await flightsLayer.update(NO_ENGINE);
    assert.match([target.gevLabelModel.title, ...target.gevLabelModel.details].join(' · '), /STALE/);
  } finally {
    globalThis.fetch = realFetch;
    flightsLayer.stopTracking();
  }
});

// ---------------------------------------------------------------------------
// Rastreio sobre o engine
// ---------------------------------------------------------------------------

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

test('real civil track path hands a neutral target to engine.track and keeps restore semantics', async () => {
  const icao24 = 'civ001';
  const engine = fakeEngine();
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const selectionEvents = [];
  globalThis.window.addEventListener('gev:awareness-subject-selected', (event) => selectionEvents.push(event.detail));
  try {
    _setTrackedFlightRefreshStateForTest({
      icao24,
      engine,
      tracked: false,
      position: { lon: -97.6699, lat: 30.1945, alt: 10_700 },
      history: [{ time: Date.now(), epochMs: Date.now(), position: { lon: -97.6699, lat: 30.1945, alt: 10_700 }, velocity: 250, track: 95 }],
      meta: {
        callsign: 'N12345', altitude: 10_668, renderAltitudeM: 10_700, velocity: 250, true_track: 95, verticalRate: 0,
        klass: 'airliner', onGround: false, wasAirborne: true, turnRateDps: 0, rawLat: 30.1945, rawLon: -97.6699,
        airline: 'TEST AIR', typeName: 'A320',
        route: { origin: { code: 'AUS', lat: 30.1975, lon: -97.6664 }, destination: { code: 'LAX', lat: 33.9416, lon: -118.4085 } },
      },
    });
    assert.equal(flightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    const target = engine.trackedTarget;
    assert.ok(target, 'trackById hands a target to engine.track');
    assert.equal(target, flightsLayer.getTrackedTarget());
    assert.equal(target.id, `flights:${icao24}`);
    assert.equal(target.gevTrackedId, `flights:${icao24}`);
    assert.equal(target.releaseOnDrag, false);
    assert.deepEqual(target.gevLabelModel, {
      title: 'N12345 · FL350 · 486 kts',
      details: ['TEST AIR · A320', 'AUS → LAX'],
      accent: '#39d0ff',
    });
    const pos = target.getPosition();
    assert.ok(Number.isFinite(pos.lon) && Number.isFinite(pos.lat), 'getPosition returns the interpolated {lon, lat}');
    assert.equal(target.gevDisplayPosition(), target.getPosition(), 'the same frame reuses one cached position');
    const pose = flightsLayer.getTrackedPose();
    assert.equal(pose.icao24, icao24);
    assert.ok(Number.isFinite(pose.heading) && Number.isFinite(pose.alt));
    assert.equal(pose.altitudeM, 10_668);
    // Enquadramento inicial: um voo de câmera olhando o alvo.
    assert.equal(engine.calls.fly.length, 1);
    assert.ok(engine.calls.fly[0][0].pitch < 0);
    assert.ok(Math.abs(selectionEvents.at(-1)?.position?.lon - pos.lon) < 1e-3, 'selection event carries the neutral point');
    assert.equal(typeof selectionEvents.at(-1)?.position?.x, 'number', 'with ECEF for legacy consumers');

    const cancels = engine.calls.cancel;
    assert.equal(flightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(engine.calls.cancel, cancels, 'ordinary repeated tracking stays camera-idempotent');
    assert.equal(selectionEvents.at(-1)?.origin, 'user', 'same-target selection upgrades durable authority');
    assert.equal(target.gevSelectionOrigin, 'user');
    assert.equal(flightsLayer.refocusTrackedById('different-flight'), false);
    assert.equal(flightsLayer.refocusTrackedById(icao24, { origin: 'voice' }), true);
    assert.equal(selectionEvents.at(-1)?.origin, 'voice');
    assert.equal(engine.trackedTarget, target, 'refocus keeps the exact tracked target');
    assert.equal(engine.calls.fly.length, 2, 'refocus reapplies the frame once');

    // Outra camada pega a câmera: esta solta o alvo sem mexer no engine.
    const other = { id: 'military:x', getPosition: () => ({ lon: 0, lat: 0 }) };
    engine.track(other);
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, null);
    assert.equal(engine.trackedTarget, other);
    assert.equal(flightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(engine.trackedTarget, flightsLayer.getTrackedTarget());

    // Restauração do link (f.t.<id>): pendências e cancelamentos.
    flightsLayer.setParams({ selectedFlightsTrackingId: 'late001' }, { origin: 'share-restore' });
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late001');
    assert.equal(flightsLayer.trackById(icao24, { origin: 'user' }), true);
    assert.equal(_pendingFlightTrackingRestoreForTest(), null, 'new user selection cancels stale restore');
    _addFlightTrackingCandidateForTest({ icao24: 'late001', meta: { ...FULL_INFO, callsign: 'LATE1', rawLat: 30.4, rawLon: -97.5 } });
    _applyPendingFlightTrackingRestoreForTest();
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, icao24);

    flightsLayer.stopTracking();
    assert.equal(engine.trackedTarget, null, 'stopTracking releases the camera in place');
    flightsLayer.setParams({ selectedFlightsTrackingId: 'late002' }, { origin: 'local-restore' });
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late002');
    flightsLayer.stopTracking({ origin: 'user' });
    assert.equal(_pendingFlightTrackingRestoreForTest(), null, 'explicit clear cancels stale restore');
    _addFlightTrackingCandidateForTest({ icao24: 'late002', meta: { ...FULL_INFO, callsign: 'LATE2', rawLat: 30.5, rawLon: -97.4 } });
    _applyPendingFlightTrackingRestoreForTest();
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, null);

    flightsLayer.setParams({ selectedFlightsTrackingId: 'late003' }, { origin: 'share-restore' });
    flightsLayer.setParams({ models3d: false }, { origin: 'user' });
    assert.equal(_pendingFlightTrackingRestoreForTest(), null, 'a newer explicit non-selection option cancels stale restore');
    assert.equal(flightsLayer.getParams().models3d, false, 'the 3D option is still accepted (degrades to icons)');
    flightsLayer.setParams({ models3d: true, models3dMode: 'all' }, { origin: 'programmatic' });
    assert.equal(flightsLayer.getParams().models3dMode, 'all');

    flightsLayer.setParams({ selectedFlightsTrackingId: 'late004' }, { origin: 'local-restore' });
    _addFlightTrackingCandidateForTest({ icao24: 'late004', meta: { ...FULL_INFO, callsign: 'LATE4', rawLat: 30.7, rawLon: -97.2 } });
    assert.equal(_applyPendingFlightTrackingRestoreForTest(), true);
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, 'late004');

    flightsLayer.setParams({ selectedFlightsTrackingId: 'late005' }, { origin: 'share-restore' });
    assert.equal(flightsLayer.trackById(icao24, { origin: 'programmatic' }), true);
    assert.equal(_pendingFlightTrackingRestoreForTest(), 'late005',
      'passive autofocus cannot revoke the shared target still waiting for its feed row');
    _addFlightTrackingCandidateForTest({ icao24: 'late005', meta: { ...FULL_INFO, callsign: 'LATE5', rawLat: 30.8, rawLon: -97.1 } });
    assert.equal(_applyPendingFlightTrackingRestoreForTest(), true);
    assert.equal(flightsLayer.getParams().selectedFlightsTrackingId, 'late005');
  } finally {
    flightsLayer.stopTracking();
    globalThis.window = realWindow;
  }
});

// ---------------------------------------------------------------------------
// Convenção de rótulo: callsign → matrícula → icao24
// ---------------------------------------------------------------------------

const LABEL_ICAO = 'ae1fa4';
const LABEL_POSITION = { lon: -97.71, lat: 30.21, alt: 10_668 };

function seedLabelContact({ callsign, registration, tracked = false }) {
  _setTrackedFlightRefreshStateForTest({
    icao24: LABEL_ICAO,
    tracked,
    position: LABEL_POSITION,
    meta: {
      callsign, registration, altitude: 10_668, renderAltitudeM: 10_700, velocity: 250, true_track: 95,
      verticalRate: 0, klass: 'airliner', onGround: false, wasAirborne: true, turnRateDps: 0, rawLat: 30.21, rawLon: -97.71,
    },
  });
}

function labelsFor({ callsign, registration }) {
  seedLabelContact({ callsign, registration, tracked: false });
  const nearby = flightsLayer.getNearby(LABEL_POSITION, 250_000, 50)[0];
  const detected = flightsLayer.getDetectableObjects({ maxCount: 50 })[0];
  const all = flightsLayer.getAllPositions(50)[0];
  seedLabelContact({ callsign, registration, tracked: true });
  const subject = flightsLayer.getTrackedSubject();
  return {
    getNearby: nearby?.id,
    getDetectableObjects: detected?.id,
    getAllPositions: all?.label,
    getTrackedSubject: subject?.label,
    analyst: mapAnalystRecord(LABEL_ICAO, { callsign, registration }).id,
    _identity: { nearby: nearby?.icao24, detected: detected?.sourceId, all: all?.id, subject: subject?.id },
  };
}

test('civil label chain: a callsign wins on every label surface', () => {
  const labels = labelsFor({ callsign: 'SWA696 ', registration: 'N123AB' });
  for (const [surface, value] of Object.entries(labels)) {
    if (surface === '_identity') continue;
    assert.equal(value, 'SWA696', `${surface} must show the callsign`);
  }
});

test('civil label chain: a blank callsign falls back to the registration, not the ICAO hex', () => {
  const labels = labelsFor({ callsign: '   ', registration: 'N123AB ' });
  for (const [surface, value] of Object.entries(labels)) {
    if (surface === '_identity') continue;
    assert.equal(value, 'N123AB', `${surface} must show the registration, not ${LABEL_ICAO}`);
  }
});

test('civil label chain: no callsign and no registration still reads as the ICAO hex', () => {
  for (const registration of [undefined, null, '   ']) {
    const labels = labelsFor({ callsign: null, registration });
    for (const [surface, value] of Object.entries(labels)) {
      if (surface === '_identity') continue;
      assert.equal(value, LABEL_ICAO, `${surface} must fall through to the hex`);
    }
  }
});

test('civil label chain: the cockpit descriptor exposes a trimmed registration', () => {
  seedLabelContact({ callsign: '  ', registration: ' N123AB ', tracked: true });
  assert.equal(flightsLayer.getTrackedInfo()?.registration, 'N123AB');
  seedLabelContact({ callsign: '  ', registration: '   ', tracked: true });
  assert.equal(flightsLayer.getTrackedInfo()?.registration, null);
});

test('civil label chain: identity stays icao24 while the label moves', () => {
  for (const fixture of [
    { callsign: 'SWA696', registration: 'N123AB' },
    { callsign: '   ', registration: 'N123AB' },
    { callsign: null, registration: null },
  ]) {
    const { _identity } = labelsFor(fixture);
    for (const [key, value] of Object.entries(_identity)) {
      assert.equal(value, LABEL_ICAO, `${key} identity must remain the ICAO hex`);
    }
  }
});

function selectionEventFor({ callsign, registration }) {
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const events = [];
  globalThis.window.addEventListener('gev:awareness-subject-selected', (event) => events.push(event.detail));
  try {
    seedLabelContact({ callsign, registration, tracked: true });
    flightsLayer.trackById(LABEL_ICAO, { origin: 'user' });
    return events.at(-1) || null;
  } finally {
    globalThis.window = realWindow;
  }
}

test('civil label chain: the awareness selection EVENT uses the canonical chain', () => {
  for (const [fixture, expected] of [
    [{ callsign: 'SWA696 ', registration: 'N123AB' }, 'SWA696'],
    [{ callsign: '   ', registration: ' N123AB ' }, 'N123AB'],
    [{ callsign: null, registration: 'N123AB' }, 'N123AB'],
    [{ callsign: null, registration: null }, LABEL_ICAO],
    [{ callsign: '  ', registration: '   ' }, LABEL_ICAO],
  ]) {
    const detail = selectionEventFor(fixture);
    assert.ok(detail, `no selection event for ${JSON.stringify(fixture)}`);
    assert.equal(detail.label, expected);
    assert.equal(detail.id, LABEL_ICAO, 'selection event identity stays the ICAO hex');
    assert.equal(detail.layerId, 'flights');
  }
});

test('civil tracked readout: a callsign-less enriched contact reads as its registration', async () => {
  seedLabelContact({ callsign: '  ', registration: ' N123AB ', tracked: true });
  const target = flightsLayer.getTrackedTarget();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: 0, states: [] }) });
  try {
    await flightsLayer.update(NO_ENGINE);
    assert.match(target.gevLabelModel.title, /^N123AB\b/);
    assert.doesNotMatch([target.gevLabelModel.title, ...target.gevLabelModel.details].join(' · '), /ae1fa4/);
    assert.equal(_trackedPresentationForTest().title, target.gevLabelModel.title, 'the map card shows the same model');
  } finally {
    globalThis.fetch = realFetch;
    flightsLayer.stopTracking();
  }
});

// ---------------------------------------------------------------------------
// Supressão militar
// ---------------------------------------------------------------------------

const MIL_HEX = 'ae1234';

test('military suppression exempts the contact this layer is still restoring', () => {
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    _armFlightTrackingRestoreForTest(null);
    setMilitaryLayerActive(false);
    assert.equal(_militaryLayerSuppressesForTest(MIL_HEX), false, 'nothing is suppressed while the Military layer is off');
    setMilitaryLayerActive(true);
    assert.equal(_militaryLayerSuppressesForTest(MIL_HEX), true, 'an ordinary mil-registry duplicate is suppressed');
    _armFlightTrackingRestoreForTest(MIL_HEX);
    assert.equal(_militaryLayerSuppressesForTest(MIL_HEX), false, 'a contact held on the restore latch must still render in this layer');
    assert.equal(_militaryLayerSuppressesForTest('bb9999'), true, 'the exemption is scoped to the pending target only');
    _armFlightTrackingRestoreForTest(null);
    assert.equal(_militaryLayerSuppressesForTest(MIL_HEX), true);
  } finally {
    setMilitaryLayerActive(false);
    _armFlightTrackingRestoreForTest(null);
    globalThis.window = realWindow;
  }
});

// ---------------------------------------------------------------------------
// Movimento (dead reckoning com 30 s de atraso)
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const fix = (sec, lon, lat, track = 90, velocity = 200) => ({
  time: T0 + sec * 1000, epochMs: T0 + sec * 1000, position: { lon, lat, alt: 9000 }, velocity, track,
});

test('the fleet renders 30 s behind and interpolates between two known fixes', () => {
  _setTrackedFlightRefreshStateForTest({
    icao24: 'dr0001',
    tracked: false,
    meta: { velocity: 200, true_track: 90, klass: 'airliner', onGround: false, rawLat: 0, rawLon: 0 },
    history: [fix(0, 0, 0), fix(30, 0.054, 0)],
  });
  // Instante exibido = agora − 30 s = T0 + 15 s → meio do caminho.
  const mid = _deadReckonForTest('dr0001', T0 + 45_000);
  assert.ok(Math.abs(mid.lon - 0.027) < 1e-9);
  assert.equal(mid.extrapolating, false);
  assert.ok(Math.abs(mid.course - 90) < 1e-6);
  // Depois do último fix: coast em arco a partir do mais novo, sem voltar.
  const coast = _deadReckonForTest('dr0001', T0 + 70_000);
  assert.equal(coast.extrapolating, true);
  assert.ok(coast.lon > 0.054, 'coasting keeps moving forward along the track');
  // Aquecimento: antes do primeiro fix, extrapola o mais antigo PARA TRÁS.
  const warm = _deadReckonForTest('dr0001', T0 + 20_000);
  assert.ok(warm.lon < 0, 'warm-up renders behind the first fix, never ahead of it');
});

test('fleet features carry icon, tint, class scale, heading and STALE fade', () => {
  clearTr3bRegistry();
  _setTrackedFlightRefreshStateForTest({
    icao24: 'fe0001',
    tracked: false,
    meta: { velocity: 200, true_track: 45, klass: 'widebody', onGround: false, rawLat: -25, rawLon: -49 },
    history: [fix(0, -49, -25, 45)],
  });
  const data = _fleetFeaturesForTest(T0 + 30_000);
  assert.equal(data.features.length, 1);
  const f = data.features[0];
  assert.deepEqual(f.geometry.coordinates, [-49, -25]);
  assert.equal(f.properties.icao, 'fe0001');
  assert.equal(f.properties.img, 'widebody-w');
  assert.equal(f.properties.s, 1.3);
  assert.equal(f.properties.r, 45);
  assert.equal(f.properties.a, 1);

  const ground = fleetFeatureProps('fe0002', { klass: 'light', onGround: true }, { course: 370 });
  assert.equal(ground.r, 10, 'rotation is normalized to [0, 360)');
  assert.equal(ground.img, 'light-w');
  assert.equal(fleetFeatureProps('fe0003', { klass: 'airliner' }, { alpha: 0.45 }).a, 0.45);
  assert.equal(fleetFeatureProps('fe0003', { klass: 'airliner' }, { cockpitDot: true }).img, 'dot-k');
  setTr3b('fe0004', true);
  assert.equal(fleetFeatureProps('fe0004', { klass: 'airliner' }).img, 'tr3b-w', 'a TR-3B conversion swaps only the glyph');
  clearTr3bRegistry();
});

test('the tracked contact leaves the fleet source and is drawn as its own cyan marker', () => {
  _setTrackedFlightRefreshStateForTest({
    icao24: 'tk0001',
    tracked: true,
    meta: { callsign: 'GLO1234', altitude: 10_000, velocity: 230, true_track: 120, klass: 'airliner', onGround: false, rawLat: -25.5, rawLon: -49.2 },
    history: [fix(-60, -49.2, -25.5, 120, 230)],
  });
  assert.equal(_fleetFeaturesForTest(Date.now()).features.length, 0);
  const pres = _trackedPresentationForTest();
  assert.equal(pres.icao, 'tk0001');
  assert.equal(pres.kind, 'airliner');
  assert.equal(pres.title, 'GLO1234');
  assert.match(pres.details.join(' · '), /^FL328 · 447 kts/);
  assert.ok(pres.sizePx > 0);
  flightsLayer.stopTracking();
});

// ---------------------------------------------------------------------------
// Desenho MapLibre
// ---------------------------------------------------------------------------

test('map definition follows the host contract (dg- ids, symbol icons, hover)', () => {
  assert.equal(flightsMapDef.id, 'flights');
  for (const id of Object.keys(flightsMapDef.sources)) assert.ok(id.startsWith('dg-'));
  const ids = flightsMapDef.layers.map((l) => l.id);
  assert.deepEqual(flightsMapDef.interactive, ['dg-flights-lo', 'dg-flights-hi']);
  for (const layer of flightsMapDef.layers) {
    assert.equal(layer.type, 'symbol');
    assert.equal(layer.layout['icon-rotation-alignment'], 'map');
    assert.deepEqual(layer.layout['icon-rotate'], ['get', 'r']);
  }
  assert.ok(ids.includes('dg-flights-lo') && ids.includes('dg-flights-hi'));
  assert.equal(typeof flightsMapDef.tooltip, 'function');
  assert.equal(flightImageName('hi', 'airliner', 'c'), 'dg-ac-hi-airliner-c');
});

test('size by zoom reproduces the Cesium NearFarScalar(1000 m→3, 8000 km→0.5)', () => {
  assert.equal(nearFarFactorAtZoom(2), 0.5);
  assert.equal(nearFarFactorAtZoom(16.6), 3);
  assert.ok(nearFarFactorAtZoom(6.6) > 1.8 && nearFarFactorAtZoom(6.6) < 2);
  for (let z = 3; z < 17; z += 0.5) assert.ok(nearFarFactorAtZoom(z + 0.5) >= nearFarFactorAtZoom(z), 'monotonic');
  assert.equal(TRACKED_MODEL_MAX_PX, 200);
});

test('glyph tint multiplies the white silhouette like billboard.color', () => {
  const base = { width: 1, height: 2, data: new Uint8ClampedArray([255, 255, 255, 255, 40, 40, 40, 128]) };
  const amber = tintRaster(base, 'm');
  assert.deepEqual([...amber.data], [255, 184, 0, 255, 40, 29, 0, 128]);
  assert.deepEqual([...tintRaster(base, 'w').data], [...base.data]);
  assert.notEqual(tintRaster(base, 'w').data, base.data, 'never mutates the shared base raster');
});

test('hover tooltip describes the contact with escaped text', () => {
  _setTrackedFlightRefreshStateForTest({
    icao24: 'tt0001',
    tracked: false,
    meta: {
      callsign: '<b>X</b>', altitude: 10_668, velocity: 250, true_track: 95, klass: 'airliner', onGround: false,
      rawLat: -25, rawLon: -49, airline: 'Azul', typeName: 'A320',
    },
  });
  const html = _tooltipHtmlForTest('tt0001');
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  assert.match(html, /FL350/);
  assert.match(html, /486 kt/);
  assert.match(html, /Azul · A320/);
  assert.equal(_tooltipHtmlForTest('nope00'), '');
});
