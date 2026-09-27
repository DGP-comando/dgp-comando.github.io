// src/data/aisLiveVessels.test.mjs
// Focused tests for the AIS feed-status derivation helper (Batch 10, finding H3/AIS),
// the vessel vertical-datum seam (2026-07-27 datum pass) and the MapLibre
// interaction wire (fake engine: on/pick/flyToTarget/track, no WebGL).
// Migração MapLibre: os testes que exercitavam o BillboardCollection/worldOverlay
// do Cesium (publicação no host de cartões, pick do scene) foram substituídos
// pelos equivalentes sobre buildVesselSourceData e o motor falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIS_FIRST_CONNECT_GRACE_MS,
  deriveAisFeedError,
  classifyAisFeedSnapshot,
  buildVesselCard,
  buildSelectedVesselCard,
  cardScreenSeparated,
  reduceVesselSelection,
  vesselDatumHeightM,
  _bindVesselInteractionForTest,
  _setVesselStateForTest,
  _reconcileVesselsForTest,
  _applyAisFeedSnapshotForTest,
  _loadLivePositionsForTest,
  _beginAisSessionForTest,
  _setAisRuntimeForTest,
  _getVesselStateForTest,
  _getVesselFeedStateForTest,
  _getVesselTrackTargetForTest,
  applyVesselFocusDeemphasis,
  buildVesselSourceData,
  mapAnalystRecord,
} from './aisLiveVessels.js';
import aisLiveVesselsLayer from './aisLiveVessels.js';
import { registerEntityContext, selectEntityContext } from './contextStore.js';
import { geoPoint } from './geoPoint.js';
import { WORLD_FOCUS_REQUEST_EVENT } from '../worldFocus.js';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { applyVesselOverlayPolicy } from './vesselLabels.js';
import { layerFeedState } from './manager.js';

test('open feed with vessels is healthy (null)', () => {
  assert.equal(deriveAisFeedError({ status: 'open', lastMessageAt: 1, error: null }, 42), null);
});

test('open feed without a received message is not a fresh healthy update', () => {
  assert.equal(
    deriveAisFeedError({ status: 'open', lastMessageAt: null, error: null }, 0),
    'awaiting first AIS message…',
  );
});

test('open feed with a message but zero accepted positions stays non-fresh', () => {
  assert.equal(
    deriveAisFeedError({ status: 'open', lastMessageAt: 123, error: null }, 0),
    'awaiting usable AIS positions…',
  );
});

test('snapshot classification distinguishes raw rows from accepted vessel positions', () => {
  const payload = {
    status: 'open',
    lastMessageAt: 123,
    rows: [
      { mmsi: 'bad-lat', lat: 'not-a-number', lon: 4 },
      { mmsi: 'bad-lon', lat: 4, lon: undefined },
      { mmsi: 'valid', lat: 29.7, lon: -95.1 },
    ],
  };
  const snapshot = classifyAisFeedSnapshot(payload);
  assert.equal(snapshot.transportStatus, 'open');
  assert.equal(snapshot.lastMessageAt, 123);
  assert.equal(snapshot.rawRowCount, 3);
  assert.equal(snapshot.acceptedRowCount, 1);
  assert.deepEqual(snapshot.acceptedRows.map((row) => row.mmsi), ['valid']);
  assert.equal(snapshot.error, null);
});

test('raw rows that all fail normalization do not satisfy AIS product health', () => {
  const snapshot = classifyAisFeedSnapshot({
    status: 'open',
    lastMessageAt: 123,
    rows: [{ mmsi: 'invalid', lat: 'bad', lon: -95.1 }],
  });
  assert.equal(snapshot.rawRowCount, 1);
  assert.equal(snapshot.acceptedRowCount, 0);
  assert.equal(snapshot.error, 'awaiting usable AIS positions…');
});

test('accepted cached rows remain usable while transport reconnects', () => {
  const snapshot = classifyAisFeedSnapshot({
    status: 'connecting',
    refreshing: true,
    rows: [{ mmsi: 'cached', lat: 29.7, lon: -95.1 }],
  });
  assert.equal(snapshot.acceptedRowCount, 1);
  assert.equal(snapshot.error, null);
});

test('missing key with no rows surfaces a clean reason', () => {
  assert.equal(
    deriveAisFeedError({ status: 'missing-key', error: 'AISSTREAM_API_KEY is not set' }, 0),
    'AISSTREAM_API_KEY not set',
  );
});

test('socket error with no rows surfaces "feed down"', () => {
  assert.equal(deriveAisFeedError({ status: 'error', error: 'AISStream websocket error' }, 0), 'feed down');
});

test('closed feed with no rows surfaces "feed disconnected"', () => {
  assert.equal(deriveAisFeedError({ status: 'closed', error: null }, 0), 'feed disconnected');
});

test('non-open status but rows still flowing is treated as stale, not down (null)', () => {
  // e.g. reconnecting/refreshing while a cached buffer still serves rows.
  assert.equal(deriveAisFeedError({ status: 'connecting', error: null }, 30), null);
});

test('unknown status falls back to a generic reason and appends server detail', () => {
  assert.equal(
    deriveAisFeedError({ status: 'weird-state', error: 'something specific' }, 0),
    'feed unavailable (something specific)',
  );
});

test('missing status treated as healthy (older/other payload shapes) (null)', () => {
  assert.equal(deriveAisFeedError({ error: 'ignored' }, 0), null);
  assert.equal(deriveAisFeedError(null, 0), null);
});

// --- watchdog statuses -----------------------------------------------------
// The server reports feed health as live | stale | reconnecting | down. A
// degraded feed must stay visible even while cached vessels are still drawn.

test("'live' is the healthy status and reads exactly like the older 'open'", () => {
  assert.equal(deriveAisFeedError({ status: 'live', lastMessageAt: 1, error: null }, 42), null);
  assert.equal(
    deriveAisFeedError({ status: 'live', lastMessageAt: null, error: null }, 0),
    'awaiting first AIS message…',
  );
  assert.equal(
    deriveAisFeedError({ status: 'live', lastMessageAt: 123, error: null }, 0),
    'awaiting usable AIS positions…',
  );
});

test('a stale feed is surfaced even though cached vessels are still on screen', () => {
  assert.equal(
    deriveAisFeedError({ status: 'stale', silentForMs: 184_000, lastMessageAt: 5 }, 4_812),
    'feed silent 184s — no AIS data',
  );
});

test('a stale feed without a silence figure still says the feed is silent', () => {
  assert.equal(
    deriveAisFeedError({ status: 'stale', lastMessageAt: 5 }, 0),
    'feed silent — no AIS data',
  );
});

test('reconnecting reports which attempt is in flight, rows or no rows', () => {
  assert.equal(
    deriveAisFeedError({ status: 'reconnecting', reconnectAttempt: 2 }, 900),
    'reconnecting to feed… (attempt 2)',
  );
  assert.equal(deriveAisFeedError({ status: 'reconnecting' }, 0), 'reconnecting to feed…');
});

test('DOWN is a visible terminal state, not a silent retry', () => {
  assert.equal(
    deriveAisFeedError({ status: 'down', reconnectAttempt: 5 }, 1_200),
    'feed down — retrying slowly (attempt 5)',
  );
});

test('a rejected API key reads as actionable, not as a countdown', () => {
  assert.equal(
    deriveAisFeedError({ status: 'auth-failed', reconnectAttempt: 3 }, 4_000),
    'API key rejected — check AISSTREAM_API_KEY',
  );

  const runtime = makeFakeAisRuntime(1_000_000);
  _setAisRuntimeForTest(runtime.runtime);
  try {
    _applyAisFeedSnapshotForTest({}, {
      status: 'auth-failed',
      reconnectAttempt: 3,
      nextAttemptAt: 1_000_000 + 3_600_000,
      refreshing: true,
      rows: [],
    });
    assert.equal(
      aisLiveVesselsLayer.getStats().retryInSec, 0,
      'an hour-long countdown would imply waiting is the fix',
    );
  } finally {
    _setAisRuntimeForTest(null);
  }
});

test('a degraded feed reports its retry countdown to the chip', () => {
  const runtime = makeFakeAisRuntime(1_000_000);
  _setAisRuntimeForTest(runtime.runtime);
  try {
    _applyAisFeedSnapshotForTest({}, {
      status: 'reconnecting',
      reconnectAttempt: 3,
      nextAttemptAt: 1_060_000, // 60s past the fake clock
      refreshing: true,
      rows: [],
    });
    assert.equal(aisLiveVesselsLayer.getStats().retryInSec, 60);

    // A feed with nothing scheduled must not invent a countdown.
    _applyAisFeedSnapshotForTest({}, { status: 'live', lastMessageAt: 5, rows: [] });
    assert.equal(aisLiveVesselsLayer.getStats().retryInSec, 0);
  } finally {
    _setAisRuntimeForTest(null);
  }
});

test('a degraded feed keeps its reason through snapshot classification', () => {
  const snapshot = classifyAisFeedSnapshot({
    status: 'down',
    reconnectAttempt: 5,
    refreshing: true,
    rows: [{ mmsi: 'cached', lat: 29.7, lon: -95.1 }],
  });
  assert.equal(snapshot.acceptedRowCount, 1, 'the cached vessel is still drawable');
  assert.equal(snapshot.error, 'feed down — retrying slowly (attempt 5)');
});

function makeFakeAisRuntime(startMs = 1000) {
  let nowMs = startMs;
  let nextId = 0;
  const scheduled = [];
  const runtime = {
    now: () => nowMs,
    setTimeout(callback, delayMs) {
      const timer = {
        id: ++nextId,
        callback,
        dueAt: nowMs + delayMs,
        cleared: false,
        fired: false,
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
  return {
    runtime,
    scheduled,
    get nowMs() { return nowMs; },
    advance(deltaMs) {
      nowMs += deltaMs;
      let fired;
      do {
        fired = false;
        for (const timer of scheduled) {
          if (timer.cleared || timer.fired || timer.dueAt > nowMs) continue;
          timer.fired = true;
          timer.callback();
          fired = true;
        }
      } while (fired);
    },
    fireIgnoringClear(timer) {
      timer.callback();
    },
    activeCount() {
      return scheduled.filter((timer) => !timer.cleared && !timer.fired).length;
    },
  };
}

test('zero accepted rows preserve warm vessel selection, trail, and freshness timestamp', () => {
  const record = makeRecord();
  const trail = makeTrailSpy();
  _setVesselStateForTest({
    viewer: {},
    records: [record],
    selectedRecord: record,
    trail,
    trailMmsi: record.mmsi,
    trailPositions: [POS],
    loaded: true,
    lastUpdate: 456,
    transportStatus: 'open',
    lastMessageAt: 123,
  });
  try {
    const result = _applyAisFeedSnapshotForTest({}, {
      status: 'open',
      lastMessageAt: 789,
      rows: [{ mmsi: 'invalid', lat: 'bad', lon: 4 }],
    });
    assert.equal(result.reconciled, false);
    assert.deepEqual(_getVesselFeedStateForTest(), {
      count: 1,
      loaded: true,
      loading: false,
      loadingLabel: '',
      stale: true,
      error: 'awaiting usable AIS positions…',
      status: undefined,
      lastUpdate: 456,
      transportStatus: 'open',
      lastMessageAt: 789,
      rawRowCount: 1,
      acceptedRowCount: 0,
      selectedMmsi: record.mmsi,
      trailMmsi: record.mmsi,
      trailPositionCount: 1,
      sessionId: _getVesselFeedStateForTest().sessionId,
      firstConnectPhase: 'idle',
      firstConnectStartedAt: null,
      firstConnectDeadline: null,
    });
    assert.equal(trail.clearCalls, 0);
  } finally {
    _setVesselStateForTest({ enabled: false });
  }
});

test('open first load stays LOADING for one bounded first-connect grace period', () => {
  const clock = makeFakeAisRuntime();
  _setAisRuntimeForTest(clock.runtime);
  _setVesselStateForTest({ viewer: {}, records: [] });
  try {
    _beginAisSessionForTest();
    const result = _applyAisFeedSnapshotForTest({}, {
      status: 'open',
      lastMessageAt: null,
      rows: [],
    });
    assert.equal(result.reconciled, false);
    const feed = _getVesselFeedStateForTest();
    assert.equal(feed.loaded, true);
    assert.equal(feed.count, 0);
    assert.equal(feed.lastUpdate, null);
    assert.equal(feed.stale, false);
    assert.equal(feed.loading, true);
    assert.equal(feed.loadingLabel, 'awaiting first AIS position…');
    assert.equal(feed.error, null);
    assert.equal(feed.status, undefined);
    assert.equal(feed.firstConnectPhase, 'loading');
    assert.equal(feed.firstConnectStartedAt, 1000);
    assert.equal(feed.firstConnectDeadline, 1000 + AIS_FIRST_CONNECT_GRACE_MS);
    assert.equal(layerFeedState(aisLiveVesselsLayer.getStats()), 'loading');
    assert.equal(feed.transportStatus, 'open');
    assert.equal(feed.lastMessageAt, null);
    assert.equal(feed.rawRowCount, 0);
    assert.equal(feed.acceptedRowCount, 0);

    clock.advance(AIS_FIRST_CONNECT_GRACE_MS - 1);
    assert.equal(_getVesselFeedStateForTest().loading, true);
    clock.advance(1);
    const expired = _getVesselFeedStateForTest();
    assert.equal(expired.loading, false);
    assert.equal(expired.error, 'awaiting first AIS message…');
    assert.equal(expired.status, 'unavailable');
    assert.equal(expired.firstConnectPhase, 'unavailable');
    assert.equal(layerFeedState(aisLiveVesselsLayer.getStats()), 'unavailable');
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});

test('open and connecting polls do not restart the first-connect deadline', () => {
  const clock = makeFakeAisRuntime(5000);
  _setAisRuntimeForTest(clock.runtime);
  _setVesselStateForTest({ viewer: {}, records: [] });
  try {
    _beginAisSessionForTest();
    const initial = _getVesselFeedStateForTest();
    clock.advance(12000);
    _applyAisFeedSnapshotForTest({}, { status: 'connecting', rows: [] });
    _applyAisFeedSnapshotForTest({}, { status: 'open', lastMessageAt: 9, rows: [] });
    const afterPolls = _getVesselFeedStateForTest();
    assert.equal(afterPolls.firstConnectStartedAt, initial.firstConnectStartedAt);
    assert.equal(afterPolls.firstConnectDeadline, initial.firstConnectDeadline);
    assert.equal(clock.activeCount(), 1);
    assert.equal(afterPolls.loading, true);
    assert.equal(afterPolls.error, null);
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});

test('definitive AIS transport failures end grace immediately', () => {
  const clock = makeFakeAisRuntime();
  _setAisRuntimeForTest(clock.runtime);
  _setVesselStateForTest({ viewer: {}, records: [] });
  try {
    _beginAisSessionForTest();
    _applyAisFeedSnapshotForTest({}, {
      status: 'missing-key',
      error: 'AISSTREAM_API_KEY is not set',
      rows: [],
    });
    const feed = _getVesselFeedStateForTest();
    assert.equal(feed.loading, false);
    assert.equal(feed.status, 'unavailable');
    assert.equal(feed.error, 'AISSTREAM_API_KEY not set');
    assert.equal(feed.firstConnectPhase, 'unavailable');
    assert.equal(clock.activeCount(), 0);
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});

test('first accepted position ends grace and warm data survives later open silence', () => {
  const clock = makeFakeAisRuntime(7000);
  const record = makeRecord();
  _setAisRuntimeForTest(clock.runtime);
  _setVesselStateForTest({ viewer: {}, records: [record] });
  try {
    _beginAisSessionForTest();
    const accepted = _applyAisFeedSnapshotForTest({}, {
      status: 'open',
      lastMessageAt: 12,
      rows: [{
        mmsi: record.mmsi,
        name: record.name,
        lat: 51.93,
        lon: 4.05,
      }],
    });
    assert.equal(accepted.reconciled, true);
    let feed = _getVesselFeedStateForTest();
    assert.equal(feed.loading, false);
    assert.equal(feed.firstConnectPhase, 'ready');
    assert.equal(feed.lastUpdate, 7000);
    assert.equal(feed.error, null);
    assert.equal(clock.activeCount(), 0);

    clock.advance(5000);
    const silent = _applyAisFeedSnapshotForTest({}, {
      status: 'open',
      lastMessageAt: 13,
      rows: [],
    });
    assert.equal(silent.reconciled, false);
    feed = _getVesselFeedStateForTest();
    assert.equal(feed.count, 1);
    assert.equal(feed.lastUpdate, 7000);
    assert.equal(feed.loading, false);
    assert.equal(feed.firstConnectPhase, 'ready');
    assert.equal(feed.stale, true);
    assert.equal(feed.error, 'awaiting usable AIS positions…');
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});

test('superseded first-connect timer cannot expire its replacement session', () => {
  const clock = makeFakeAisRuntime(11000);
  _setAisRuntimeForTest(clock.runtime);
  _setVesselStateForTest({ viewer: {}, records: [] });
  try {
    _beginAisSessionForTest();
    const oldTimer = clock.scheduled[0];
    const oldSessionId = _getVesselFeedStateForTest().sessionId;

    _setVesselStateForTest({ viewer: {}, records: [] });
    _beginAisSessionForTest();
    const replacement = _getVesselFeedStateForTest();
    assert.notEqual(replacement.sessionId, oldSessionId);
    assert.equal(replacement.firstConnectPhase, 'loading');

    clock.fireIgnoringClear(oldTimer);
    const afterStaleTimer = _getVesselFeedStateForTest();
    assert.equal(afterStaleTimer.sessionId, replacement.sessionId);
    assert.equal(afterStaleTimer.firstConnectPhase, 'loading');
    assert.equal(afterStaleTimer.firstConnectDeadline, replacement.firstConnectDeadline);
    assert.equal(afterStaleTimer.error, null);
  } finally {
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});

function deferredFetchResponse() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

test('HTTP rejection ends first-connect grace without waiting for its deadline', async () => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  const priorWarn = console.warn;
  const clock = makeFakeAisRuntime();
  globalThis.window = { location: { origin: 'http://localhost:4173' } };
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      status: 'missing-key',
      error: 'AISSTREAM_API_KEY is not set',
    }),
  });
  console.warn = () => {};
  _setAisRuntimeForTest(clock.runtime);
  _setVesselStateForTest({ viewer: {}, records: [] });
  try {
    _beginAisSessionForTest();
    await _loadLivePositionsForTest({});
    const feed = _getVesselFeedStateForTest();
    assert.equal(feed.loading, false);
    assert.equal(feed.status, 'unavailable');
    assert.equal(feed.error, 'AISSTREAM_API_KEY not set');
    assert.equal(feed.firstConnectPhase, 'unavailable');
    assert.equal(clock.activeCount(), 0);
  } finally {
    globalThis.fetch = priorFetch;
    console.warn = priorWarn;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
    _setVesselStateForTest({ enabled: false });
    _setAisRuntimeForTest();
  }
});

test('superseded AIS response cannot mutate or finalize a replacement request', async () => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  const first = deferredFetchResponse();
  const second = deferredFetchResponse();
  const queue = [first, second];
  globalThis.window = { location: { origin: 'http://localhost:4173' } };
  globalThis.fetch = () => queue.shift().promise;
  const oldRecord = makeRecord({ name: 'OLD' });
  const replacement = makeRecord({ name: 'REPLACEMENT' });
  const replacementTrail = makeTrailSpy();
  try {
    _setVesselStateForTest({ viewer: {}, records: [oldRecord], loaded: true, lastUpdate: 100 });
    const oldLoad = _loadLivePositionsForTest({});

    // Simulate destroy/re-init replacement. The old fetch intentionally ignores abort.
    _setVesselStateForTest({
      viewer: {},
      records: [replacement],
      selectedRecord: replacement,
      trail: replacementTrail,
      trailMmsi: replacement.mmsi,
      trailPositions: [POS],
      loaded: true,
      lastUpdate: 200,
    });
    const replacementLoad = _loadLivePositionsForTest({});

    first.resolve(jsonResponse({
      status: 'open',
      lastMessageAt: 1000,
      rows: [{ mmsi: oldRecord.mmsi, name: 'STALE RESPONSE', lat: 1, lon: 2 }],
    }));
    await oldLoad;
    let feed = _getVesselFeedStateForTest();
    assert.equal(feed.loading, true, 'old finally must not clear replacement loading ownership');
    assert.equal(feed.lastUpdate, 200, 'old response must not advance replacement freshness');
    assert.equal(feed.selectedMmsi, replacement.mmsi);

    second.resolve(jsonResponse({ status: 'open', lastMessageAt: null, rows: [] }));
    await replacementLoad;
    feed = _getVesselFeedStateForTest();
    assert.equal(feed.loading, false);
    assert.equal(feed.lastUpdate, 200);
    assert.equal(feed.error, 'awaiting first AIS message…');
    assert.equal(feed.stale, true);
    assert.equal(feed.selectedMmsi, replacement.mmsi);
    assert.equal(feed.trailMmsi, replacement.mmsi);
    assert.equal(replacementTrail.clearCalls, 0);
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
    _setVesselStateForTest({ enabled: false });
  }
});

test('disable and destroy make abort-ignoring AIS responses inert', async () => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  const windowTarget = new EventTarget();
  windowTarget.location = { origin: 'http://localhost:4173' };
  globalThis.window = windowTarget;
  globalThis.document = { getElementById: () => null };
  try {
    const disableResponse = deferredFetchResponse();
    globalThis.fetch = () => disableResponse.promise;
    const record = makeRecord();
    _setVesselStateForTest({ viewer: {}, records: [record], loaded: true, lastUpdate: 300 });
    const disabledLoad = _loadLivePositionsForTest({});
    aisLiveVesselsLayer.disable();
    disableResponse.resolve(jsonResponse({
      status: 'open',
      lastMessageAt: 1000,
      rows: [{ mmsi: record.mmsi, lat: 1, lon: 2 }],
    }));
    await disabledLoad;
    let feed = _getVesselFeedStateForTest();
    assert.equal(feed.lastUpdate, 300);
    assert.equal(feed.loading, false);

    const destroyResponse = deferredFetchResponse();
    globalThis.fetch = () => destroyResponse.promise;
    const viewer = { scene: { primitives: { remove() {} } } };
    _setVesselStateForTest({ viewer, records: [record], loaded: true, lastUpdate: 400 });
    const destroyedLoad = _loadLivePositionsForTest(viewer);
    aisLiveVesselsLayer.destroy(viewer);
    destroyResponse.resolve(jsonResponse({
      status: 'open',
      lastMessageAt: 2000,
      rows: [{ mmsi: record.mmsi, lat: 3, lon: 4 }],
    }));
    await destroyedLoad;
    feed = _getVesselFeedStateForTest();
    assert.equal(feed.count, 0);
    assert.equal(feed.lastUpdate, null);
    assert.equal(feed.transportStatus, null);
    assert.equal(feed.loading, false);
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
    if (hadDocument) globalThis.document = priorDocument;
    else delete globalThis.document;
    _setVesselStateForTest({ enabled: false });
  }
});

test('vessel focus wire animates alpha with deadband and restores after tracking ends', () => {
  let writes = 0;
  const makeColor = (alpha) => ({ alpha, withAlpha: (next) => makeColor(next) });
  let color = makeColor(1);
  const billboard = {
    position: { x: 1, y: 2, z: 3 },
    show: true,
    get color() { return color; },
    set color(next) { writes += 1; color = next; },
  };
  const records = [{ position: billboard.position, billboard }];
  const target = {
    screenRect: { left: 40, top: 40, right: 60, bottom: 60 },
    paddingPx: 0,
    cameraDistance: 1000,
  };
  const params = {
    paddingPx: 0,
    dimFloor: 0.25,
    nearerBehavior: 'allow',
    hysteresisPx: 6,
    distanceHysteresisRatio: 0.08,
    attackMs: 300,
    releaseMs: 600,
    writeEpsilon: 0.005,
  };
  let activeCount = 0;
  const apply = (nowMs, focusTarget) => {
    const result = applyVesselFocusDeemphasis({
      records,
      target: focusTarget,
      previousActiveCount: activeCount,
      nowMs,
      screenPositionFor: () => ({ x: 50, y: 50 }),
      cameraDistanceFor: () => 1200,
      params,
    });
    activeCount = result.activeCount;
    return result;
  };

  assert.equal(apply(0, target).writes, 0);
  assert.equal(apply(150, target).writes, 1);
  assert.ok(color.alpha > 0.25 && color.alpha < 1);
  assert.equal(apply(150, target).writes, 0, 'same timestamp stays inside deadband');
  assert.equal(apply(300, target).writes, 1);
  assert.equal(color.alpha, 0.25);
  assert.equal(apply(300, null).writes, 0, 'release starts continuously from the floor');
  assert.equal(apply(600, null).writes, 1);
  assert.ok(color.alpha > 0.25 && color.alpha < 1);
  assert.equal(apply(900, null).writes, 1);
  assert.equal(color.alpha, 1);
  assert.equal(apply(901, null).writes, 0, 'settled restoration causes no churn');
  assert.equal(writes, 4);
});

test('vessel focus wire performs no alpha writes when nothing has been tracked', () => {
  let writes = 0;
  const billboard = {
    position: { x: 0, y: 0, z: 0 },
    show: true,
    get color() { return { alpha: 1 }; },
    set color(_next) { writes += 1; },
  };
  const result = applyVesselFocusDeemphasis({
    records: [{ position: billboard.position, billboard }],
    target: null,
    nowMs: 100,
    screenPositionFor: () => ({ x: 50, y: 50 }),
    cameraDistanceFor: () => 1200,
  });
  assert.deepEqual(result, {
    writes: 0,
    transitioning: false,
    activeCount: 0,
    ran: false,
  });
  assert.equal(writes, 0);
});

test('vessel focus wire restores a hidden sprite before releasing the active pass', () => {
  const makeColor = (alpha) => ({ alpha, withAlpha: (next) => makeColor(next) });
  const billboard = {
    position: { x: 1, y: 2, z: 3 },
    show: true,
    color: makeColor(1),
  };
  const records = [{ billboard }];
  const target = {
    screenRect: { left: 40, top: 40, right: 60, bottom: 60 },
    paddingPx: 0,
    cameraDistance: 1000,
  };
  const params = {
    paddingPx: 0,
    dimFloor: 0.25,
    nearerBehavior: 'allow',
    attackMs: 300,
    releaseMs: 600,
    writeEpsilon: 0.005,
  };
  const pass = (nowMs, focusTarget, previousActiveCount) => applyVesselFocusDeemphasis({
    records,
    target: focusTarget,
    previousActiveCount,
    nowMs,
    screenPositionFor: () => ({ x: 50, y: 50 }),
    cameraDistanceFor: () => 1200,
    params,
  });

  pass(0, target, 0);
  const dimmed = pass(params.attackMs, target, 0);
  assert.equal(dimmed.activeCount, 1);
  assert.equal(billboard.color.alpha, params.dimFloor);

  billboard.show = false;
  const releaseStart = pass(params.attackMs, null, dimmed.activeCount);
  const restored = pass(params.attackMs + params.releaseMs, null, releaseStart.activeCount);
  assert.equal(restored.ran, true);
  assert.equal(restored.activeCount, 0);
  assert.equal(restored.writes, 1);
  assert.equal(billboard.color.alpha, 1);
});

// --- Selection gestures (FB-1) ---------------------------------------------

test('vessel selection: empty-space click requests deselection', () => {
  assert.deepEqual(
    reduceVesselSelection({ selectedMmsi: '353136000', gesture: 'click' }),
    { action: 'deselect' },
  );
});

test('vessel selection: no selection plus empty-space click is a no-op', () => {
  assert.deepEqual(
    reduceVesselSelection({ selectedMmsi: null, pickedMmsi: null, gesture: 'click' }),
    { action: 'none' },
  );
});

test('vessel selection: Escape deselects only when this layer owns a selection', () => {
  assert.deepEqual(
    reduceVesselSelection({ selectedMmsi: 353136000, gesture: 'escape' }),
    { action: 'deselect' },
  );
  assert.deepEqual(
    reduceVesselSelection({ gesture: 'escape' }),
    { action: 'none' },
  );
});

test('vessel selection: another vessel replaces selection; same vessel is a no-op', () => {
  assert.deepEqual(
    reduceVesselSelection({
      selectedMmsi: '353136000',
      pickedMmsi: '367123450',
      gesture: 'click',
    }),
    { action: 'select' },
  );
  assert.deepEqual(
    reduceVesselSelection({
      selectedMmsi: '353136000',
      pickedMmsi: '353136000',
      gesture: 'click',
    }),
    { action: 'none' },
  );
});

// ─── canvas-card builders (LabelCollection → canvas-card migration) ──────────
// Card models are pure: they read a vessel record and return a vesselLabels
// entry ({position, gapPx, accent, title, details, selected}). Positions pass
// through untouched (height-datum caveat: vessels anchor at their current
// rendered positions — no datum work here).

const POS = geoPoint(4.05, 51.93, 3);

function makeRecord(overrides = {}) {
  return {
    name: 'EVER GIVEN',
    mmsi: '353136000',
    type: 'Container Ship',
    destination: '',
    speed: 14.53,
    course: 230.6,
    heading: 231.2,
    lastPositionUtc: '',
    missedRefreshes: 0,
    lat: 51.93,
    lon: 4.05,
    position: POS,
    ...overrides,
  };
}

function makeTrailSpy() {
  return {
    id: 'dg-trail-test-line',
    clearCalls: 0,
    clear() { this.clearCalls += 1; },
    setPositions() {},
    destroy() {},
  };
}

function makeClassList(...initial) {
  const classes = new Set(initial);
  return {
    add(value) { classes.add(value); },
    remove(value) { classes.delete(value); },
    contains(value) { return classes.has(value); },
  };
}

const OWN_ICON = 'dg-ais-live-icon';
const OWN_LABEL = 'dg-ais-live-label';
const OWN_TRAIL = 'dg-trail-test-line';

/** MapLibre-like rendered feature (what engine.pick returns). */
function feature(layerId, properties = {}) {
  return { layer: { id: layerId }, properties };
}

/**
 * Fake map engine: the subset of src/maplibre/engine.js the layer uses.
 * `pick` filters the scripted features by `layers`, like queryRenderedFeatures.
 */
function makeFakeEngine(features = []) {
  const listeners = new Map();
  const engine = {
    features,
    trackedTarget: null,
    flights: [],
    tracks: [],
    added: { click: 0, trackedchange: 0 },
    removed: { click: 0, trackedchange: 0 },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      if (type in engine.added) engine.added[type] += 1;
      return () => {
        if (listeners.get(type)?.delete(fn) && type in engine.removed) engine.removed[type] += 1;
      };
    },
    emit(type, payload) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(payload);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    pick(_x, _y, { layers } = {}) {
      return engine.features.filter((f) => !layers || layers.includes(f.layer.id));
    },
    getCameraView: () => ({ heading: 15 }),
    flyToTarget(target, options) {
      engine.flights.push({ target, options });
    },
    track(target) {
      engine.trackedTarget = target || null;
      engine.tracks.push(target || null);
      engine.emit('trackedchange', engine.trackedTarget);
    },
    click() {
      engine.emit('click', { x: 10, y: 20 });
    },
  };
  return engine;
}

function installWireHarness(features = [], stateOverrides = {}) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const windowTarget = new EventTarget();
  windowTarget.location = { origin: 'http://localhost:4173' };
  const keyTarget = {
    keydown: null,
    added: [],
    removed: [],
    addEventListener(type, callback) {
      if (type !== 'keydown') return;
      this.added.push({ type, callback });
      this.keydown = callback;
    },
    removeEventListener(type, callback) {
      if (type !== 'keydown') return;
      this.removed.push({ type, callback });
      if (this.keydown === callback) this.keydown = null;
    },
    dispatch(event) { this.keydown?.(event); },
  };
  const engine = makeFakeEngine(features);
  const requests = [];
  windowTarget.addEventListener(WORLD_FOCUS_REQUEST_EVENT, (event) => requests.push(event.detail));
  const record = makeRecord();
  const trail = makeTrailSpy();
  const hud = {
    textContent: `AIS: ${record.name}`,
    classList: makeClassList('active'),
  };

  globalThis.window = windowTarget;
  globalThis.document = {
    getElementById: (id) => (id === 'hud-ais-vessel' ? hud : null),
  };
  _setVesselStateForTest({
    engine,
    records: [record],
    selectedRecord: record,
    trail,
    trailMmsi: record.mmsi,
    trailPositions: [POS],
    interactionKeyTarget: keyTarget,
    ...stateOverrides,
  });
  _bindVesselInteractionForTest(engine, keyTarget);

  return {
    engine,
    requests,
    keyTarget,
    record,
    trail,
    hud,
    windowTarget,
    cleanup() {
      aisLiveVesselsLayer.destroy();
      if (hadWindow) globalThis.window = priorWindow;
      else delete globalThis.window;
      if (hadDocument) globalThis.document = priorDocument;
      else delete globalThis.document;
    },
  };
}

test('vessel interaction wire: trail pick does not deselect', () => {
  const harness = installWireHarness([feature(OWN_TRAIL)]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.trail.clearCalls, 0);
    assert.equal(_getVesselStateForTest().trailMmsi, harness.record.mmsi);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: only the layer trail receives the trail no-op', () => {
  const harness = installWireHarness([feature('dg-other-line', { id: 'gev-trailing-contact' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.equal(harness.trail.clearCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: flights-owned pick preserves vessel selection', () => {
  registerPickOwner('flights', (pickedId) => pickedId === 'a1b2c3');
  const harness = installWireHarness([feature('dg-flights-icon', { pickId: 'a1b2c3' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.trail.clearCalls, 0);
  } finally {
    harness.cleanup();
    unregisterPickOwner('flights');
  }
});

test('vessel interaction wire: CCTV-owned pick preserves vessel selection', () => {
  registerPickOwner('cctv', (pickedId) => pickedId === 'atx-cam-3');
  const harness = installWireHarness([feature('dg-cctv-point', { id: 'atx-cam-3' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.trail.clearCalls, 0);
  } finally {
    harness.cleanup();
    unregisterPickOwner('cctv');
  }
});

test('vessel interaction wire: own-layer unkeyed record pick does not deselect', () => {
  const harness = installWireHarness([feature(OWN_ICON, { mmsi: '' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.trail.clearCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: own-shaped evicted record pick does not deselect', () => {
  const harness = installWireHarness([feature(OWN_ICON, { mmsi: '999999999' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.trail.clearCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: id-less basemap pick deselects and resets the HUD', () => {
  const harness = installWireHarness([feature('base-esri', {})]);
  const cleared = [];
  try {
    registerEntityContext(harness.record, {
      id: `ais-${harness.record.mmsi}`,
      layerId: 'ais-live-vessels',
      label: harness.record.name,
    });
    selectEntityContext(harness.record);
    harness.windowTarget.addEventListener('gev:entity-selection-cleared', (event) => {
      cleared.push(event.detail);
    });

    harness.engine.click();

    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.equal(harness.hud.textContent, 'AIS: --');
    assert.equal(harness.hud.classList.contains('active'), false);
    // Clicking away is a deliberate deselect, not the vessel aging out of the
    // feed. Consumers that keep a readout on screen (the Cockpit Contact
    // panel) tear down on 'deliberate' and hold last-known on 'evicted'.
    assert.deepEqual(cleared, [{ layerId: 'ais-live-vessels', reason: 'deliberate' }]);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: empty pick deselects and emits gev:entity-selection-cleared', () => {
  const harness = installWireHarness([]);
  const cleared = [];
  try {
    registerEntityContext(harness.record, {
      id: `ais-${harness.record.mmsi}`,
      layerId: 'ais-live-vessels',
      label: harness.record.name,
    });
    selectEntityContext(harness.record);
    harness.windowTarget.addEventListener('gev:entity-selection-cleared', (event) => {
      cleared.push(event.detail);
    });

    harness.engine.click();

    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.equal(harness.hud.textContent, 'AIS: --');
    assert.equal(harness.hud.classList.contains('active'), false);
    // Empty pick is a deliberate deselect — see the note above.
    assert.deepEqual(cleared, [{ layerId: 'ais-live-vessels', reason: 'deliberate' }]);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: Escape deselects the selected vessel', () => {
  const harness = installWireHarness([]);
  try {
    harness.keyTarget.dispatch({ key: 'Escape' });
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.equal(harness.hud.textContent, 'AIS: --');
    assert.equal(harness.hud.classList.contains('active'), false);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: another layer taking engine.track clears the selection', () => {
  const harness = installWireHarness([]);
  try {
    harness.engine.track(null);
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.trail.clearCalls, 0);

    harness.engine.track({ id: 'tracked-flight', layerId: 'flights', getPosition: () => null });
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.equal(harness.trail.clearCalls, 1);

    harness.engine.track({ id: 'tracked-flight-2', layerId: 'flights', getPosition: () => null });
    assert.equal(harness.trail.clearCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction lifecycle: destroy removes the exact bound keydown listener', () => {
  const harness = installWireHarness([]);
  try {
    const added = harness.keyTarget.added[0];
    aisLiveVesselsLayer.destroy();

    assert.equal(harness.engine.removed.click, 1);
    assert.equal(harness.engine.listenerCount('click'), 0);
    assert.equal(harness.keyTarget.removed.length, 1);
    assert.equal(harness.keyTarget.removed[0].type, 'keydown');
    assert.strictEqual(harness.keyTarget.removed[0].callback, added.callback);
    assert.equal(harness.keyTarget.keydown, null);
    assert.equal(harness.engine.removed.trackedchange, 1);
    assert.equal(harness.engine.listenerCount('trackedchange'), 0);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction lifecycle: disable detaches input and enable reinstalls it', async () => {
  const harness = installWireHarness([]);
  const priorFetch = globalThis.fetch;
  try {
    const disabledKeydown = harness.keyTarget.keydown;
    aisLiveVesselsLayer.disable();

    assert.equal(harness.engine.listenerCount('click'), 0);
    assert.equal(harness.keyTarget.keydown, null);
    assert.equal(harness.keyTarget.removed.length, 1);
    assert.strictEqual(harness.keyTarget.removed[0].callback, disabledKeydown);
    assert.equal(harness.engine.listenerCount('trackedchange'), 0);

    _setVesselStateForTest({
      engine: harness.engine,
      records: [harness.record],
      selectedRecord: harness.record,
      enabled: false,
      trail: harness.trail,
      trailMmsi: harness.record.mmsi,
      trailPositions: [POS],
      interactionKeyTarget: harness.keyTarget,
    });
    harness.engine.click();
    disabledKeydown({ key: 'Escape' });
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'open', rows: [] }),
    });
    await aisLiveVesselsLayer.enable(harness.engine);

    assert.equal(harness.engine.added.click, 2);
    assert.equal(harness.engine.listenerCount('click'), 1);
    assert.equal(harness.keyTarget.added.length, 2);
    assert.equal(harness.engine.added.trackedchange, 2);
    assert.equal(harness.engine.listenerCount('trackedchange'), 1);
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);

    assert.equal(aisLiveVesselsLayer.selectById(harness.record.mmsi), true);
    harness.keyTarget.dispatch({ key: 'Escape' });
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
  } finally {
    globalThis.fetch = priorFetch;
    harness.cleanup();
  }
});

test('enable owns one grace timer and disable/re-enable starts a new session', async () => {
  const harness = installWireHarness([], { enabled: false });
  const priorFetch = globalThis.fetch;
  const clock = makeFakeAisRuntime(20000);
  _setAisRuntimeForTest(clock.runtime);
  globalThis.fetch = async () => jsonResponse({ status: 'open', rows: [] });
  try {
    await aisLiveVesselsLayer.enable(harness.engine);
    const first = _getVesselFeedStateForTest();
    assert.equal(first.firstConnectPhase, 'loading');
    assert.equal(clock.activeCount(), 1);

    clock.advance(5000);
    await aisLiveVesselsLayer.enable(harness.engine);
    const duplicateEnable = _getVesselFeedStateForTest();
    assert.equal(duplicateEnable.sessionId, first.sessionId);
    assert.equal(duplicateEnable.firstConnectStartedAt, first.firstConnectStartedAt);
    assert.equal(duplicateEnable.firstConnectDeadline, first.firstConnectDeadline);
    assert.equal(clock.activeCount(), 1);

    aisLiveVesselsLayer.disable();
    assert.equal(clock.activeCount(), 0);
    await aisLiveVesselsLayer.enable(harness.engine);
    const replacement = _getVesselFeedStateForTest();
    assert.notEqual(replacement.sessionId, first.sessionId);
    assert.equal(replacement.firstConnectStartedAt, 25000);
    assert.equal(replacement.firstConnectDeadline, 25000 + AIS_FIRST_CONNECT_GRACE_MS);
    assert.equal(replacement.firstConnectPhase, 'loading');
    assert.equal(clock.activeCount(), 1);
  } finally {
    globalThis.fetch = priorFetch;
    harness.cleanup();
    _setAisRuntimeForTest();
  }
});

test('vessel trail lifecycle: deselect clears the selected-vessel trail', () => {
  const harness = installWireHarness([]);
  try {
    aisLiveVesselsLayer.clearSelection();
    assert.equal(harness.trail.clearCalls, 1);
    assert.deepEqual(_getVesselStateForTest(), {
      trailMmsi: null,
      trailPositionCount: 0,
      vesselCount: 1,
    });
  } finally {
    harness.cleanup();
  }
});

test('vessel trail lifecycle: reconciliation eviction clears an orphaned trail', () => {
  const record = makeRecord();
  const trail = makeTrailSpy();
  _setVesselStateForTest({
    records: [record],
    trail,
    trailMmsi: record.mmsi,
    trailPositions: [POS],
  });
  try {
    _reconcileVesselsForTest({}, []);
    assert.equal(trail.clearCalls, 1);
    assert.deepEqual(_getVesselStateForTest(), {
      trailMmsi: null,
      trailPositionCount: 0,
      vesselCount: 0,
    });
  } finally {
    _setVesselStateForTest({ enabled: false });
  }
});

test('buildVesselCard: name title + type/speed/heading detail line', () => {
  const card = buildVesselCard(makeRecord());
  assert.equal(card.title, 'EVER GIVEN');
  assert.deepEqual(card.details, ['CONTAINER SHIP · 14.5KT · 231°']);
  assert.equal(card.accent, '57, 213, 255');
  assert.equal(card.selected, false);
  assert.equal(card.position, POS);
  assert.equal(card.id, 'vessel:353136000');
  assert.ok(card.priority > 0);
  assert.ok(Number.isFinite(card.gapPx) && card.gapPx > 0);
});

test('buildVesselCard: heading falls back to course; missing parts are omitted', () => {
  const card = buildVesselCard(makeRecord({ heading: null, type: '', speed: null }));
  assert.deepEqual(card.details, ['231°']);
  const bare = buildVesselCard(makeRecord({ heading: null, course: null, type: '', speed: null }));
  assert.deepEqual(bare.details, []);
});

test('buildVesselCard: unnamed vessels title as MMSI; long names truncate', () => {
  const unnamed = buildVesselCard(makeRecord({ name: 'VESSEL' }));
  assert.equal(unnamed.title, 'MMSI 353136000');
  const long = buildVesselCard(makeRecord({ name: 'A'.repeat(40) }));
  assert.ok(long.title.length <= 26, `title too long: ${long.title.length}`);
});

test('buildVesselCard: anchors to the record neutral position', () => {
  const rendered = geoPoint(-48.5, -25.5, 3);
  const card = buildVesselCard(makeRecord({ position: rendered }));
  assert.equal(card.position, rendered);
  assert.equal(card.position.lon, -48.5);
  assert.ok(Number.isFinite(card.position.x), 'ECEF view kept for legacy consumers');
});

test('buildVesselCard: tanker types carry the amber accent', () => {
  const card = buildVesselCard(makeRecord({ type: 'Crude Oil Tanker' }));
  assert.equal(card.accent, '255, 179, 71');
});

test('buildVesselCard: numeric AIS type codes read as family names, not digits', () => {
  const card = buildVesselCard(makeRecord({ type: '84' }));
  assert.deepEqual(card.details, ['TANKER · 14.5KT · 231°']);
  assert.equal(card.accent, '255, 179, 71');
});

test('cardScreenSeparated: rejects candidates inside the min separation radius', () => {
  const accepted = [{ x: 400, y: 300 }];
  assert.equal(cardScreenSeparated(accepted, { x: 400 + 149, y: 300 }, 150), false);
  assert.equal(cardScreenSeparated(accepted, { x: 400 + 151, y: 300 }, 150), true);
  assert.equal(cardScreenSeparated(accepted, { x: 400, y: 300 + 100 }, 150), false);
  assert.equal(cardScreenSeparated([], { x: 0, y: 0 }, 150), true);
});

test('buildSelectedVesselCard: full detail card with MMSI + position time', () => {
  const card = buildSelectedVesselCard(makeRecord({
    lastPositionUtc: '2026-07-27T11:22:33Z',
  }));
  assert.equal(card.selected, true);
  assert.equal(card.id, 'vessel:353136000');
  assert.equal(card.priority, 100000);
  assert.equal(card.title, 'EVER GIVEN');
  assert.deepEqual(card.details, [
    'CONTAINER SHIP · 14.5KT · 231°',
    'MMSI 353136000 · POS: 11:22:33Z',
  ]);
});

test('vessel sources: labels go to the highest-priority records, capped, selection on top', () => {
  const low = makeRecord({ mmsi: '100', name: 'VESSEL', speed: 1, lat: 1, lon: 2 });
  const winner = makeRecord({ mmsi: '200', name: 'NAMED WINNER', speed: 16, lat: 1.1, lon: 2.1 });
  const other = makeRecord({ mmsi: '300', name: 'SEPARATED', speed: 3, lat: 1.2, lon: 2.2 });
  const selected = makeRecord({ mmsi: '400', name: 'CHOSEN', speed: 8, lat: 1.3, lon: 2.3, destination: 'PARANAGUA' });
  const unkeyed = makeRecord({ mmsi: '', name: 'NO KEY', speed: 0, lat: 1.4, lon: 2.4 });
  const data = buildVesselSourceData([low, winner, other, selected, unkeyed], selected, 2);

  const byMmsi = new Map(data.vessels.features.map((f) => [f.properties.mmsi, f]));
  assert.equal(data.vessels.features.length, 4, 'the selected vessel leaves the ambient source');
  assert.equal(byMmsi.has('400'), false);
  assert.equal(byMmsi.get('200').properties.label, 'NAMED WINNER');
  assert.equal(byMmsi.get('300').properties.label, 'SEPARATED');
  assert.equal(byMmsi.get('100').properties.label, '', 'over the cap: chevron only');
  assert.ok(byMmsi.get('200').properties.prio > byMmsi.get('300').properties.prio);
  assert.deepEqual(byMmsi.get('200').geometry.coordinates, [2.1, 1.1]);
  // Chevron: tinted per type, rotated by heading (course fallback), speed-scaled.
  assert.equal(byMmsi.get('200').properties.icon, 'dg-ais-chev-39d5ff');
  assert.equal(byMmsi.get('200').properties.rotate, 231.2);
  assert.equal(byMmsi.get('200').properties.size, 0.68);
  assert.equal(byMmsi.get('').properties.mmsi, '', 'unkeyed rows render but carry no pick key');

  const [sel] = data.selected.features;
  assert.equal(sel.properties.mmsi, '400');
  assert.equal(sel.properties.icon, 'dg-ais-chev-sel');
  assert.equal(sel.properties.size, 0.68 * 1.2);
  assert.equal(sel.properties.label, 'CHOSEN');
  assert.match(sel.properties.detail, /PARANAGUA/);
  assert.match(sel.properties.detail, /MMSI 400/);
  assert.equal(data.labelCount, 3);

  const none = buildVesselSourceData([low], null, 0);
  assert.equal(none.selected.features.length, 0);
  assert.equal(none.vessels.features[0].properties.label, '');
});

test('vessel lifecycle without a map keeps state and tears down cleanly', () => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: () => null };
  const record = makeRecord();
  const engine = makeFakeEngine([]);
  _setVesselStateForTest({ engine, records: [record], selectedRecord: record });
  try {
    assert.equal(aisLiveVesselsLayer.getDetectableObjects().length, 1);
    assert.equal(aisLiveVesselsLayer.getAllPositions()[0].position, POS);
    aisLiveVesselsLayer.disable();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.deepEqual(aisLiveVesselsLayer.getDetectableObjects(), []);
    aisLiveVesselsLayer.destroy();
    assert.equal(_getVesselStateForTest().vesselCount, 0);
  } finally {
    _setVesselStateForTest({ enabled: false });
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
    globalThis.document = priorDocument;
  }
});

test('getNearby accepts neutral, lon/lat and legacy ECEF centers alike', () => {
  const near = makeRecord({ mmsi: '1', lat: -25.5, lon: -48.5, position: geoPoint(-48.5, -25.5, 3) });
  const far = makeRecord({ mmsi: '2', lat: -25.5, lon: -47.5, position: geoPoint(-47.5, -25.5, 3) });
  _setVesselStateForTest({ records: [far, near] });
  try {
    const center = geoPoint(-48.49, -25.5, 0);
    for (const c of [center, { lon: -48.49, lat: -25.5 }, { x: center.x, y: center.y, z: center.z }]) {
      const rows = aisLiveVesselsLayer.getNearby(c, 50_000, 5);
      assert.deepEqual(rows.map((r) => r.mmsi), ['1']);
      assert.ok(Math.abs(rows[0].distanceM - 1005) < 30, `distance ${rows[0].distanceM}`);
    }
    assert.deepEqual(aisLiveVesselsLayer.getNearby(center, Infinity, 5).map((r) => r.mmsi), ['1', '2']);
    assert.deepEqual(aisLiveVesselsLayer.getNearby(null, 1000), []);
  } finally {
    _setVesselStateForTest({ enabled: false });
  }
});

test('buildSelectedVesselCard: destination line + STALE marker; placeholders for missing data', () => {
  const card = buildSelectedVesselCard(makeRecord({
    type: 'Tanker',
    speed: null,
    heading: null,
    course: null,
    destination: 'ROTTERDAM',
    missedRefreshes: 2,
  }));
  assert.deepEqual(card.details, [
    'TANKER · --KT · --°',
    '→ ROTTERDAM',
    'MMSI 353136000 · POS: LIVE · STALE',
  ]);
});

// --- Vertical datum (h = N + lift) ------------------------------------------

test('vesselDatumHeightM falls back to lift alone while the geoid grid is cold', () => {
  assert.equal(vesselDatumHeightM(null, 3), 3);
  assert.equal(vesselDatumHeightM(undefined, 2), 2);
  assert.equal(vesselDatumHeightM(NaN, 3), 3);
});

test('vesselDatumHeightM ADDS the undulation N (sign convention: h = N + lift)', () => {
  // The classic datum bug is subtracting N. Rotterdam N ≈ +45 must land the
  // anchor ~48 m ABOVE the ellipsoid; Houston N ≈ −27 lands it ~24 m below.
  assert.equal(vesselDatumHeightM(45.2, 3), 48.2);
  assert.equal(vesselDatumHeightM(-27.3, 3), -24.3);
});

test('EGM96 N pins the field finding: Rotterdam sea sits ~45 m ABOVE the ellipsoid, Houston ~27 m below', async () => {
  // Confirmed live 2026-07-28: chevrons at ellipsoid height 0 are occluded by
  // the Rotterdam sea mesh (N positive) but visible at Houston (N negative).
  // These bands also fed scripts/qa-vessel-datum.mjs (retired with Cesium).
  await ensureGeoidReady();
  const rotterdam = geoidHeight(51.93, 4.05);
  const houston = geoidHeight(29.72, -95.08);
  assert.ok(rotterdam > 40 && rotterdam < 50, `N(rotterdam) = ${rotterdam}, expected ≈ +45`);
  assert.ok(houston > -32 && houston < -22, `N(houston) = ${houston}, expected ≈ −27`);
});

// One-click transfer (pre-launch defect #4): clicking a vessel gives it the
// camera, whether the camera was free or tracking something else. The layer
// only announces the click — the UI owns the flight (src/worldFocus.js) — and
// follows the vessel with engine.track.
test('vessel interaction wire: selecting a vessel by click requests a camera transfer and tracks it', () => {
  const harness = installWireHarness([], { selectedRecord: null });
  harness.engine.features = [feature(OWN_ICON, { mmsi: harness.record.mmsi })];
  try {
    harness.engine.trackedTarget = { id: 'old', layerId: 'flights' };
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].kind, 'vessel');
    assert.equal(harness.requests[0].id, harness.record.mmsi);
    assert.equal(harness.requests[0].position, POS);
    assert.equal(harness.engine.flights.length, 0, 'the layer never flies the camera itself');

    const tracked = harness.engine.trackedTarget;
    assert.equal(tracked, _getVesselTrackTargetForTest());
    assert.equal(tracked.layerId, 'ais-live-vessels');
    assert.equal(tracked.id, harness.record.mmsi);
    assert.deepEqual(tracked.getPosition(), { lon: 4.05, lat: 51.93, alt: 0 });
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi, 'own track keeps selection');

    aisLiveVesselsLayer.clearSelection();
    assert.equal(harness.engine.trackedTarget, null, 'deselect releases the follow');
    assert.equal(harness.requests.length, 1, 'deselect never requests a flight');
  } finally {
    harness.cleanup();
  }
});

// Card clicks: the ambient and selected cards are MapLibre symbol labels in
// the layer's own label layers, so a card hit resolves exactly like a sprite.
test('vessel interaction wire: clicking a card selects and transfers, like the sprite', () => {
  const harness = installWireHarness([], { selectedRecord: null });
  harness.engine.features = [feature(OWN_LABEL, { mmsi: harness.record.mmsi })];
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.requests.length, 1);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: clicking the selected vessel card refocuses exactly once', () => {
  const harness = installWireHarness([]);
  harness.engine.features = [feature('dg-ais-live-sel-label', { mmsi: harness.record.mmsi })];
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.trail.clearCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: an unknown card id preserves selection and never flies', () => {
  const harness = installWireHarness([feature(OWN_LABEL, { mmsi: '999999999' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.requests.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('vessel interaction wire: a sibling-owned pick wins without selection mutation', () => {
  registerPickOwner('flights', (pickedId) => pickedId === 'a1b2c3');
  const harness = installWireHarness([feature('dg-flights-icon', { pickId: 'a1b2c3' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo()?.mmsi, harness.record.mmsi);
    assert.equal(harness.requests.length, 0);
  } finally {
    harness.cleanup();
    unregisterPickOwner('flights');
  }
});

test('vessel card policy: only MMSI-keyed cards publish a hit rect', () => {
  const keyed = applyVesselOverlayPolicy(buildVesselCard(makeRecord()));
  assert.equal(keyed.interactive, true);
  const unkeyed = applyVesselOverlayPolicy(buildVesselCard(makeRecord({ mmsi: '' })));
  assert.equal(unkeyed.interactive, false, 'an unkeyed card has no record to select');
});

test('vessel interaction wire: deselecting never moves the camera', () => {
  const harness = installWireHarness([feature('base-esri', { id: 'gev-empty-space' })]);
  try {
    harness.engine.click();
    assert.equal(aisLiveVesselsLayer.getSelectedInfo(), null);
    assert.equal(harness.requests.length, 0);
    harness.keyTarget.dispatch({ key: 'Escape' });
    assert.equal(harness.requests.length, 0);
  } finally {
    harness.cleanup();
  }
});

test('a vessel analyst record carries the MMSI the tracker keys on', () => {
  // `id` is a DISPLAY label — the vessel name when it has one — while
  // selection keys on MMSI. The compact voice payload must carry both, or the
  // analyst → track_entity handoff hands over a name and nothing resolvable.
  const named = mapAnalystRecord({
    mmsi: '366999123', name: 'EVER GIVEN', lat: 37.8, lon: -122.4, speed: 12, type: 'Cargo',
  });
  assert.equal(named.id, 'EVER GIVEN');
  assert.equal(named.mmsi, '366999123', 'the key rides along with the label');

  // A nameless vessel falls back to its MMSI for display; the key is still
  // present in its own field, so the payload never depends on that collapse.
  const nameless = mapAnalystRecord({ mmsi: '366999124', name: null, lat: 37.9, lon: -122.5 });
  assert.equal(nameless.id, '366999124');
  assert.equal(nameless.mmsi, '366999124');
});
