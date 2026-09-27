import assert from 'node:assert/strict';
import test from 'node:test';
import { twoline2satrec } from 'satellite.js';
import {
  ISS_OVERLAY_SOURCE_OPTIONS,
  _applyPendingSatelliteTrackingRestoreForTest,
  _clearSatelliteSeedForTest,
  _issLabelVisibleForTest,
  _orbitPathIdsForTest,
  _pendingSatelliteTrackingRestoreForTest,
  _removeSatelliteTrackingCandidateForTest,
  _runSatelliteTickForTest,
  _seedSatellitesForTest,
  _setSatelliteTrackingRefreshOutcomeForTest,
  _trackedFramePositionForTest,
  createIssOverlayEntry,
  orbitFrameLongitudeShiftDeg,
  orbitFrameModelMatrix,
} from './satellites.js';
import satellitesLayer from './satellites.js';

const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const ISS_EPOCH_MS = Date.UTC(2008, 8, 20, 12, 30);

/** Motor falso: registra o alvo de engine.track() e os voos pedidos. */
function fakeEngine() {
  const engine = {
    trackedTarget: null,
    flights: [],
    track(target) { engine.trackedTarget = target || null; },
    flyToCamera(view) { engine.flights.push(view); },
  };
  return engine;
}

function seedIss(extra = {}) {
  const engine = extra.engine || fakeEngine();
  _seedSatellitesForTest({
    satellites: [{ noradId: 25544, name: 'ISS (ZARYA)', satrec: twoline2satrec(L1, L2), group: 'stations' }],
    engine,
    now: () => ISS_EPOCH_MS,
    ...extra,
  });
  return engine;
}

test('partial and dense catalogs do not make an early false missing decision', async () => {
  _setSatelliteTrackingRefreshOutcomeForTest({
    status: 'partial',
    failedGroups: ['stations.txt'],
  });
  const partial = await satellitesLayer.resolveTrackingRestoreTarget(987654);
  assert.equal(partial.status, 'source-unavailable');
  assert.match(partial.reason, /partial CelesTrak catalog/);

  let releaseDense;
  const densePromise = new Promise((resolve) => { releaseDense = resolve; });
  _setSatelliteTrackingRefreshOutcomeForTest({
    status: 'accepted',
    catalog: 'dense',
    densePromise,
  });
  let settled = false;
  const resolution = satellitesLayer.resolveTrackingRestoreTarget(987654)
    .then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false, 'dense absence must wait for the dense catalog');
  releaseDense({ status: 'ready' });
  assert.equal((await resolution).status, 'missing');
  _setSatelliteTrackingRefreshOutcomeForTest({ status: 'accepted', catalog: 'core' });
});

test('satellite first update aborts every parallel catalog request', async () => {
  const realFetch = globalThis.fetch;
  const observedSignals = [];
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    observedSignals.push(options.signal);
    options.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    const controller = new AbortController();
    const work = satellitesLayer.update({}, { signal: controller.signal });
    await Promise.resolve();
    assert.ok(observedSignals.length > 1);
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(observedSignals.every((signal) => signal?.aborted), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('selected satellite params survive delayed arrival and yield to newer explicit intent', () => {
  const engine = seedIss();
  try {
    assert.doesNotThrow(() => satellitesLayer.setParams({ selectedSatTrackingId: 25544 }));
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, 25544);
    assert.equal(engine.trackedTarget?.gevTrackedId, 'satellites:25544', 'the camera follows through engine.track');
    const followed = engine.trackedTarget.getPosition();
    assert.ok(Number.isFinite(followed.lon) && Number.isFinite(followed.lat), 'the follow target reports lon/lat');
    assert.ok(followed.alt > 300_000, 'and the real orbital altitude');

    satellitesLayer.stopTracking();
    assert.equal(engine.trackedTarget, null, 'stopping releases the camera');
    _removeSatelliteTrackingCandidateForTest(25544);
    satellitesLayer.setParams(
      { selectedSatTrackingId: 25544 },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 25544);
    seedIss({ engine, preservePending: true });
    assert.equal(_applyPendingSatelliteTrackingRestoreForTest(), true);
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, 25544);

    satellitesLayer.setParams(
      { selectedSatTrackingId: 99999 },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 99999);
    assert.equal(satellitesLayer.trackById(25544, { origin: 'user' }), true);
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), null, 'new user selection cancels stale restore');
    _applyPendingSatelliteTrackingRestoreForTest();
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, 25544);

    satellitesLayer.stopTracking();
    _removeSatelliteTrackingCandidateForTest(25544);
    satellitesLayer.setParams(
      { selectedSatTrackingId: 25544 },
      { origin: 'local-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 25544);
    satellitesLayer.stopTracking({ origin: 'user' });
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), null, 'explicit clear cancels stale restore');
    seedIss({ engine, preservePending: true });
    _applyPendingSatelliteTrackingRestoreForTest();
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, null);

    satellitesLayer.setParams(
      { selectedSatTrackingId: 50003 },
      { origin: 'share-restore' },
    );
    assert.equal(_pendingSatelliteTrackingRestoreForTest(), 50003);
    satellitesLayer.setParams({ showPoints: true }, { origin: 'tool' });
    assert.equal(
      _pendingSatelliteTrackingRestoreForTest(),
      null,
      'a newer explicit non-selection option cancels stale restore',
    );
    _applyPendingSatelliteTrackingRestoreForTest();
    assert.equal(satellitesLayer.getParams().selectedSatTrackingId, null);
  } finally {
    _clearSatelliteSeedForTest();
  }
});

test('another layer taking the camera does not get its follow yanked away', () => {
  const engine = seedIss();
  try {
    satellitesLayer.trackById(25544, { origin: 'user' });
    const ours = engine.trackedTarget;
    assert.ok(ours);
    // Another owner (flights, say) grabs the follow-camera.
    const theirs = { gevTrackedId: 'flights:abc', getPosition: () => ({ lon: 0, lat: 0 }) };
    engine.trackedTarget = theirs;
    satellitesLayer.stopTracking();
    assert.equal(engine.trackedTarget, theirs, 'our release never clears a foreign target');
  } finally {
    _clearSatelliteSeedForTest();
  }
});

test('a tracked docked cluster consolidates its companions onto one card', () => {
  // ISS and everything berthed to it are separate real tracks at one position,
  // so their ambient labels would stack underneath the tracked card. Product
  // decision: consolidate them as secondary info on that card, and suppress
  // only those members — never unrelated satellites that merely happen to be
  // nearby.
  let nowMs = ISS_EPOCH_MS;
  const satrec = twoline2satrec(L1, L2);
  // The tracked satellite moves ~7.6 km/s, so neighbours are defined RELATIVE
  // to wherever it is at scan time rather than pinned to a stale sample.
  const near = (metres) => () => {
    const tracked = _trackedFramePositionForTest();
    return tracked ? { x: tracked.x + metres, y: tracked.y, z: tracked.z } : { x: 0, y: 0, z: 0 };
  };
  _seedSatellitesForTest({
    satellites: [
      { noradId: 25544, name: 'ISS (ZARYA)', satrec },
      { noradId: 55555, name: 'PROGRESS-MS 34', satrec },
      { noradId: 55556, name: 'SOYUZ-MS 12', satrec },
      { noradId: 99999, name: 'UNRELATED SAT', satrec },
    ],
    engine: fakeEngine(),
    now: () => nowMs,
    positions: new Map([
      [55555, near(120)],     // berthed
      [55556, near(-90)],     // berthed
      [99999, near(50_000)],  // 50 km away
    ]),
    // Fleet propagation off, so the seeded neighbour positions stand.
    params: { showPoints: false },
  });
  try {
    satellitesLayer.trackById(25544);
    _runSatelliteTickForTest();
    // The cluster scan is throttled, so advance past its interval before the
    // tick that must observe the cluster.
    nowMs += 2000;
    _runSatelliteTickForTest();

    const { details } = satellitesLayer.getTrackedLabelModel();
    // Class leads the detail block; the altitude line follows it, and the
    // consolidated companions stay last.
    assert.equal(details[0], 'STATION · ISS', 'the class line names what this is');
    assert.match(details[1], /NORAD 25544$/, 'the altitude line is unchanged');
    assert.equal(details[2], 'DOCKED · PROGRESS-MS 34 · +1',
      'companions are consolidated, named, and counted on the tracked card');
    // THREE neighbours were seeded but only two are counted.
    assert.doesNotMatch(details[2], /UNRELATED/);
    assert.doesNotMatch(details[2], /\+2/);
    // A docked companion leaves the detection overlay; the unrelated one stays.
    satellitesLayer.setParams({ showPoints: true });
    const detectable = satellitesLayer.getDetectableObjects().map((o) => o.sourceId);
    assert.equal(detectable.includes(55555), false);
    assert.equal(detectable.includes(99999), true);
  } finally {
    _clearSatelliteSeedForTest();
  }
});

test('the tracked card refreshes its altitude on each propagated tick', () => {
  const epochs = [ISS_EPOCH_MS, Date.UTC(2008, 8, 20, 13, 0)];
  let epochIndex = 0;
  seedIss({ now: () => epochs[epochIndex], params: { showPoints: false } });
  try {
    satellitesLayer.trackById(25544);
    _runSatelliteTickForTest();
    let model = satellitesLayer.getTrackedLabelModel();
    assert.equal(model.title, 'ISS (ZARYA)');
    assert.equal(model.details[0], 'STATION · ISS');
    assert.equal(model.details[1], '353 km · NORAD 25544');

    epochIndex = 1;
    _runSatelliteTickForTest();
    model = satellitesLayer.getTrackedLabelModel();
    assert.equal(model.details[1], '366 km · NORAD 25544');
    assert.equal(model.details[0], 'STATION · ISS',
      'the class line survives an altitude-only republish');
    const info = satellitesLayer.getTrackedInfo();
    assert.equal(info.noradId, 25544);
    assert.equal(Math.round(info.altitudeM / 1000), 366, 'getTrackedInfo reads the same sample as the card');
  } finally {
    _clearSatelliteSeedForTest();
  }
});

test('the ISS ambient label and the tracked card are mutually exclusive', () => {
  seedIss();
  try {
    assert.equal(_issLabelVisibleForTest(), true, 'the ISS carries its ambient label by default');
    satellitesLayer.trackById(25544);
    assert.equal(_issLabelVisibleForTest(), false, 'tracked ISS suppresses the ambient label');
    assert.ok(satellitesLayer.getTrackedLabelModel(), 'the tracked card is the only text surface');
    assert.ok(_orbitPathIdsForTest().includes(25544), 'the tracked orbit is drawn');
    satellitesLayer.stopTracking();
    assert.equal(_issLabelVisibleForTest(), true, 'untracking restores the ambient label');
    assert.ok(_orbitPathIdsForTest().includes(25544), 'the ISS keeps its default orbit after untrack');
    satellitesLayer.setParams({ showOrbits: false });
    assert.equal(_issLabelVisibleForTest(), false, 'the ambient label follows showOrbits');
  } finally {
    _clearSatelliteSeedForTest();
  }
});

test('a non-ISS selection draws and then drops its own orbit', () => {
  const satrec = twoline2satrec(L1.replace('25544', '33333'), L2.replace('25544', '33333'));
  _seedSatellitesForTest({
    satellites: [{ noradId: 33333, name: 'DRIFTER-1', satrec, group: 'visual' }],
    engine: fakeEngine(),
    now: () => ISS_EPOCH_MS,
  });
  try {
    assert.equal(satellitesLayer.trackById(33333), true);
    assert.deepEqual(_orbitPathIdsForTest(), [33333]);
    satellitesLayer.stopTracking();
    assert.deepEqual(_orbitPathIdsForTest(), []);
  } finally {
    _clearSatelliteSeedForTest();
  }
});

test('the GMST frame transform is a Z rotation equal to a longitude shift', () => {
  const bake = new Date(ISS_EPOCH_MS);
  const later = new Date(ISS_EPOCH_MS + 10 * 60_000);
  const shift = orbitFrameLongitudeShiftDeg(0, bake);
  const matrix = orbitFrameModelMatrix(0, bake);
  // Column-major Cesium.Matrix4 layout: rotating +X by the matrix lands at the shift angle.
  const angle = Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI;
  assert.ok(Math.abs(((angle - shift + 540) % 360) - 180) < 1e-9);
  // Ten minutes later a baked ring drifts WEST by ~2.5°.
  const drift = orbitFrameLongitudeShiftDeg(0, later) - orbitFrameLongitudeShiftDeg(0, bake);
  assert.ok(drift < -2.4 && drift > -2.6, `drift ${drift}`);
});

test('ISS overlay entry retains the native distance scale and source text', () => {
  const position = { x: 1, y: 2, z: 3 };
  const entry = createIssOverlayEntry(() => position);
  assert.equal(entry.title, 'ISS');
  assert.equal(entry.position(), position);
  assert.deepEqual(entry.distanceScale, {
    near: 1_000_000,
    nearValue: 1,
    far: 30_000_000,
    farValue: 0.4,
  });
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(ISS_OVERLAY_SOURCE_OPTIONS.cohortLimit, 1);
});
