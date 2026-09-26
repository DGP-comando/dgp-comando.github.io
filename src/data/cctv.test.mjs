// src/data/cctv.test.mjs
//
// MapLibre port: tests that exercised Cesium rendering (entity materialization,
// monitor-plane entities, scene-pick ownership) were rewritten against the
// MapLibre drawing (coverage GeoJSON, monitor card entry, host picks) or
// removed where the mechanism no longer exists; pure pose/calibration/policy
// tests are unchanged. — CCTV v2 pure frustum geometry (computeFrustumGeometry).
//
// Locks the CCTV frustum geometry described in docs/CURRENT-STATE.md:
//   - the far-cap (monitor plane) corners lie ON the plane through capCenter
//     perpendicular to the frustum view axis (ε < 0.5 m) — this is the geometric
//     invariant that welds the wireframe corner rays to the plane entity;
//   - vFov = 2·atan(tan(hFov/2) / (16/9)) (same 16:9 derivation the projection
//     frame used);
//   - far-cap center + corners clamp to ≥ groundAlt + 2 m so a fabricated pitch
//     (Austin's -24°) never buries the plane in the tiles (§6 risk);
//   - the activation obstruction probe's range clamp (§9.1) shortens the
//     effective range, never lengthens it.
//
// computeFrustumGeometry is PURE (no viewer, no scene queries) so it runs under
// plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cctvLayer, {
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  _coverageFeaturesForTest,
  _setCctvCoverageStateForTest,
  _pushAmbientCardEntriesForTest,
  _setCctvOverlayHostForTest,
  activationProbeClampRange,
  bindCctvWorldClickGesture,
  clearProbeClampOnDeactivation,
  computeFrustumGeometry,
  cctvCycleIndex,
  cctvEmptyClickDeselects,
  cctvRecordNeedsActivation,
  deactivateActiveCamera,
  CCTV_FOCUS_RESULT,
  FRUSTUM_GROUND_CLEARANCE_M,
  CCTV_CALIBRATION_STORAGE_KEY_V2,
  CCTV_CALIBRATION_STORAGE_KEY_V1,
  readCalibrationStoreV2,
  writeCalibrationStoreV2,
  deriveCalBadge,
  surfaceRegimeKey,
  calibrationPatchMovesAnchor,
  cctvGeometryDrainPacing,
  createGeometryProgressNotifier,
  normalizeCoverageMode,
  frameSignatureFromPixels,
  focusCctvRecord,
  hideCctvRecordVisuals,
  maybeAutoHop,
  prioritizeActiveCctvGeometryRecord,
  processCctvGeometryDrainBatch,
  processCctvGeometryQueueBatch,
  processGeometryBatch,
  refreshCoverageStyles,
  setCctvCardPresentationOptions,
  setActiveCamera,
} from './cctv.js';
import {
  CCTV_ACTIVATION_RESULT,
  CCTV_FOCUS_REQUEST_EVENT,
  activateCctvCameraFromWorldClick,
} from '../cctvFocusRequest.js';

const UI_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui.js'),
  'utf8',
);

const ASPECT = 16 / 9;
const toRad = (deg) => (deg * Math.PI) / 180;
const GESTURE_TYPES = {
  LEFT_DOWN: 'left-down',
  MOUSE_MOVE: 'mouse-move',
  LEFT_UP: 'left-up',
  LEFT_CLICK: 'left-click',
};

function makeGestureHandler() {
  const actions = new Map();
  return {
    setInputAction(callback, type) { actions.set(type, callback); },
    fire(type, event) { actions.get(type)?.(event); },
  };
}
// Same spherical earth radius projectPoint uses (R = 6371 km) so the
// lat/lon→metres conversion in the assertions matches the module's math.
const M_PER_DEG = (Math.PI / 180) * 6371000;

/** Local ENU metres of point b relative to point a ({lat, lon, alt}). */
function enu(a, b) {
  return {
    e: (b.lon - a.lon) * M_PER_DEG * Math.cos(toRad(a.lat)),
    n: (b.lat - a.lat) * M_PER_DEG,
    u: b.alt - a.alt,
  };
}

function dot(v, w) {
  return v.e * w.e + v.n * w.n + v.u * w.u;
}

function sub(v, w) {
  return { e: v.e - w.e, n: v.n - w.n, u: v.u - w.u };
}

function mag(v) {
  return Math.hypot(v.e, v.n, v.u);
}

/** Unit view-axis direction for a heading/pitch pose, in ENU. */
function viewDir(headingDeg, pitchDeg) {
  const h = toRad(headingDeg);
  const p = toRad(pitchDeg);
  return { e: Math.sin(h) * Math.cos(p), n: Math.cos(h) * Math.cos(p), u: Math.sin(p) };
}

// A pose whose far cap sits well above ground (no clamping) so the raw plane
// math is observable: tall mount, shallow pitch.
const UNCLAMPED_CAMERA = {
  lat: 30.2672,
  lon: -97.7431,
  headingDeg: 41,
  pitchDeg: -5,
  fovDeg: 56,
  rangeM: 210,
  mountHeightM: 100,
};
const UNCLAMPED_GROUND = 0;

// Austin's fabricated prior personality (design §1a): pitch -24° at 210 m puts
// the unclamped cap ~85 m below the mount — underground vs groundAlt 150.
const AUSTIN_FABRICATED_CAMERA = {
  lat: 30.2672,
  lon: -97.7431,
  headingDeg: 41,
  pitchDeg: -24,
  fovDeg: 56,
  rangeM: 210,
  mountHeightM: 10,
};
const AUSTIN_GROUND = 150;

test('geometry drain coalesces 40 progress ticks and always publishes the final state', () => {
  let nowMs = 0;
  const state = { loaded: 0, total: 40, loading: true };
  const coalesced = [];
  const unthrottled = [];
  let progressInvocations = 0;
  const notifier = createGeometryProgressNotifier(
    () => coalesced.push({ ...state }),
    { now: () => nowMs, intervalMs: 300, batchLimit: 10 },
  );

  const queue = Array.from({ length: state.total }, (_, index) => index + 1);
  while (queue.length) {
    processCctvGeometryQueueBatch({
      queue,
      batchSize: 1,
      visit: (loaded) => {
        state.loaded = loaded;
        nowMs += 35;
        unthrottled.push({ ...state });
      },
      progress: () => notifier.progress(),
      complete: () => {
        progressInvocations = coalesced.length;
        state.loading = false;
        notifier.finish();
      },
    });
  }

  assert.ok(
    progressInvocations >= 4 && progressInvocations <= 6,
    `expected about 4-6 progress callbacks, got ${progressInvocations}`,
  );
  assert.notEqual(progressInvocations, 40);

  assert.equal(
    coalesced.length,
    progressInvocations + 1,
    'queue completion must add one unconditional final notification',
  );
  assert.deepEqual(coalesced.at(-1), { ...unthrottled.at(-1), loading: false });

  const productionDrain = processGeometryBatch.toString();
  assert.match(productionDrain, /processCctvGeometryDrainBatch/);
  assert.match(productionDrain, /_geoProgressNotifier\?\.progress\(\)/);
  assert.match(productionDrain, /_geoProgressNotifier\?\.finish\(\)/);
  assert.doesNotMatch(productionDrain, /if \(_geoLoading\) notifyListeners\(\)/);
});

test('default COVERAGE draws ground footprints for the active camera and its visible cohort', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    camera: {
      ...UNCLAMPED_CAMERA,
      id: `cam-${index}`,
      lon: UNCLAMPED_CAMERA.lon + index * 0.002,
      groundElevationM: 0,
    },
    viewshedColors: { fill: 'rgba(1,2,3,0.12)', fillActive: 'rgba(1,2,3,0.22)', line: 'rgba(1,2,3,0.85)', lineActive: 'rgba(1,2,3,1)' },
  }));
  const activeRecord = records.at(-1);
  try {
    _setCctvCoverageStateForTest({ records, activeCameraId: activeRecord.camera.id });
    const fc = _coverageFeaturesForTest();
    const polygons = fc.features.filter((f) => f.geometry.type === 'Polygon');
    const rays = fc.features.filter((f) => f.geometry.type === 'LineString');
    assert.equal(polygons.length, 14, 'default COVERAGE ON draws the 14-camera visible cohort');
    assert.equal(rays.length, 14, 'each footprint carries its center ray');
    assert.equal(fc.features.at(-1).properties.id, activeRecord.camera.id, 'active camera paints last (on top)');
    assert.ok(polygons.some((f) => f.properties.active && f.properties.id === activeRecord.camera.id));
    assert.ok(activeRecord.footprint, 'footprint computed lazily for drawn records');

    _setCctvCoverageStateForTest({ records, activeCameraId: activeRecord.camera.id, coverageMode: 'viewshed' });
    const viewshed = _coverageFeaturesForTest().features.filter((f) => f.geometry.type === 'Polygon');
    assert.ok(viewshed.every((f) => f.properties.fill.startsWith('rgba(1,2,3,')), 'viewshed fills use the camera hue');

    _setCctvCoverageStateForTest({
      records,
      activeCameraId: activeRecord.camera.id,
      coverageMode: 'off',
      showProjection: true,
    });
    const projectionOnly = _coverageFeaturesForTest().features;
    assert.ok(projectionOnly.length > 0 && projectionOnly.every((f) => f.properties.id === activeRecord.camera.id),
      'COVERAGE OFF keeps only the active projection footprint');

    _setCctvCoverageStateForTest({ records, activeCameraId: activeRecord.camera.id, coverageMode: 'off' });
    assert.equal(_coverageFeaturesForTest().features.length, 0);
  } finally {
    _setCctvCoverageStateForTest({ enabled: false });
  }
});

test('geometry drain pacing yields to tracked and cockpit camera ownership', () => {
  assert.deepEqual(cctvGeometryDrainPacing(), { batchSize: 4, delayMs: 120 });
  assert.deepEqual(
    cctvGeometryDrainPacing({ trackedEntity: { id: 'flight-1' } }),
    { batchSize: 2, delayMs: 250 },
  );
  assert.deepEqual(
    cctvGeometryDrainPacing({ cockpitActive: true }),
    { batchSize: 2, delayMs: 250 },
  );

  const active = { id: 'active' };
  const queue = [{ id: 'near' }, { id: 'far' }, active];
  assert.equal(prioritizeActiveCctvGeometryRecord(queue, active), true);
  assert.equal(queue[0], active);
});

test('geometry drain rechecks pacing when tracking releases between batches', () => {
  let trackedEntity = { id: 'flight-1' };
  const queue = Array.from({ length: 10 }, (_, index) => index + 1);
  const visited = [];
  const runBatch = () => processCctvGeometryDrainBatch({
    queue,
    readOwnership: () => ({ trackedEntity, cockpitActive: false }),
    visit: (record) => visited.push(record),
    progress: () => {},
    complete: () => {},
  });

  const trackedBatch = runBatch();
  assert.deepEqual(trackedBatch, { hasMore: true, batchSize: 2, delayMs: 250 });
  assert.deepEqual(visited, [1, 2]);

  trackedEntity = null;
  const untrackedBatch = runBatch();
  assert.deepEqual(untrackedBatch, { hasMore: true, batchSize: 4, delayMs: 120 });
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6]);

  assert.match(processGeometryBatch.toString(), /processCctvGeometryDrainBatch/);
});

test('vFov formula: vFov = 2·atan(tan(hFov/2) / (16/9)); halfW/halfH follow', () => {
  const g = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND);
  const expectedVFovRad = 2 * Math.atan(Math.tan(toRad(56) / 2) / ASPECT);
  assert.ok(Math.abs(toRad(g.vFovDeg) - expectedVFovRad) < 1e-9, `vFovDeg=${g.vFovDeg}`);
  assert.ok(Math.abs(g.halfW - 210 * Math.tan(toRad(56) / 2)) < 1e-6, `halfW=${g.halfW}`);
  assert.ok(Math.abs(g.halfH - 210 * Math.tan(expectedVFovRad / 2)) < 1e-6, `halfH=${g.halfH}`);
});

test('mount altitude = groundAlt + mountHeightM', () => {
  const g = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND);
  assert.equal(g.mount.alt, 100);
  const g2 = computeFrustumGeometry(AUSTIN_FABRICATED_CAMERA, AUSTIN_GROUND);
  assert.equal(g2.mount.alt, 160);
});

test('cap center sits rangeM along the view axis from the mount (ε < 0.5 m)', () => {
  const g = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND);
  const d = viewDir(41, -5);
  const cap = enu(g.mount, g.capCenter);
  const expected = { e: d.e * 210, n: d.n * 210, u: d.u * 210 };
  assert.ok(mag(sub(cap, expected)) < 0.5, `cap offset error ${mag(sub(cap, expected))} m`);
});

test('corner/plane coincidence: all 4 corners lie on the far-cap plane (ε < 0.5 m)', () => {
  const g = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND);
  const d = viewDir(41, -5);
  const capEnu = enu(g.mount, g.capCenter);
  for (const key of ['tl', 'tr', 'br', 'bl']) {
    const cornerEnu = enu(g.mount, g.corners[key]);
    const offAxis = Math.abs(dot(sub(cornerEnu, capEnu), d));
    assert.ok(offAxis < 0.5, `${key} is ${offAxis.toFixed(3)} m off the cap plane`);
    // Each corner is the half-diagonal away from the cap center.
    const diag = Math.hypot(g.halfW, g.halfH);
    const dist = mag(sub(cornerEnu, capEnu));
    assert.ok(Math.abs(dist - diag) < 0.5, `${key} corner-to-center ${dist} vs diag ${diag}`);
  }
});

test('cap rectangle spans 2·halfW × 2·halfH (ε < 0.5 m)', () => {
  const g = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND);
  const m = g.mount;
  const width = mag(sub(enu(m, g.corners.tr), enu(m, g.corners.tl)));
  const height = mag(sub(enu(m, g.corners.tl), enu(m, g.corners.bl)));
  assert.ok(Math.abs(width - 2 * g.halfW) < 0.5, `top width ${width} vs ${2 * g.halfW}`);
  assert.ok(Math.abs(height - 2 * g.halfH) < 0.5, `left height ${height} vs ${2 * g.halfH}`);
  // Bottom edge too — the rectangle is a rectangle, not a trapezoid.
  const widthBottom = mag(sub(enu(m, g.corners.br), enu(m, g.corners.bl)));
  assert.ok(Math.abs(widthBottom - 2 * g.halfW) < 0.5, `bottom width ${widthBottom}`);
});

test('unclamped pose: corners keep their true plane altitudes (no clamp applied)', () => {
  const g = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND);
  const floor = UNCLAMPED_GROUND + FRUSTUM_GROUND_CLEARANCE_M;
  for (const key of ['tl', 'tr', 'br', 'bl']) {
    assert.ok(g.corners[key].alt > floor + 1, `${key} alt ${g.corners[key].alt}`);
  }
  assert.ok(g.corners.tl.alt > g.corners.bl.alt, 'top corners sit above bottom corners');
});

test('ground clamp lifts the CAP CENTER only — the rectangle stays rigid (true pyramid)', () => {
  const g = computeFrustumGeometry(AUSTIN_FABRICATED_CAMERA, AUSTIN_GROUND);
  const floor = AUSTIN_GROUND + FRUSTUM_GROUND_CLEARANCE_M;
  // Unclamped cap alt would be 160 + 210·sin(-24°) ≈ 74.6 m — far underground.
  assert.equal(g.capCenter.alt, floor, 'cap center clamps exactly to the floor');
  // Corners derive rigidly from the lifted center: alt = floor ± cos(pitch)·halfH.
  // The bottom pair sits BELOW the floor (tiles occlude it) — per-corner clamping
  // is what flattened the wireframe into a fan (field test 2026-07-04).
  const upVert = Math.cos(toRad(-24)) * g.halfH;
  for (const key of ['tl', 'tr']) {
    assert.ok(Math.abs(g.corners[key].alt - (floor + upVert)) < 1e-6, `${key} alt ${g.corners[key].alt}`);
  }
  for (const key of ['bl', 'br']) {
    assert.ok(Math.abs(g.corners[key].alt - (floor - upVert)) < 1e-6, `${key} alt ${g.corners[key].alt}`);
  }
});

test('clamped pose keeps corner/plane coincidence and the rigid 2·halfW × 2·halfH span', () => {
  // The wireframe corner rays must terminate exactly on the monitor plane's
  // corners AT THE DEFAULT AUSTIN POSE — this is the case that diverged by
  // ~47.5 m under per-corner clamping (field test 2026-07-04).
  const g = computeFrustumGeometry(AUSTIN_FABRICATED_CAMERA, AUSTIN_GROUND);
  const d = viewDir(41, -24);
  const capEnu = enu(g.mount, g.capCenter);
  const diag = Math.hypot(g.halfW, g.halfH);
  for (const key of ['tl', 'tr', 'br', 'bl']) {
    const cornerEnu = enu(g.mount, g.corners[key]);
    const offAxis = Math.abs(dot(sub(cornerEnu, capEnu), d));
    assert.ok(offAxis < 0.5, `${key} is ${offAxis.toFixed(3)} m off the cap plane`);
    const dist = mag(sub(cornerEnu, capEnu));
    assert.ok(Math.abs(dist - diag) < 0.5, `${key} corner-to-center ${dist} vs diag ${diag}`);
  }
  const width = mag(sub(enu(g.mount, g.corners.tr), enu(g.mount, g.corners.tl)));
  const height = mag(sub(enu(g.mount, g.corners.tl), enu(g.mount, g.corners.bl)));
  assert.ok(Math.abs(width - 2 * g.halfW) < 0.5, `width ${width} vs ${2 * g.halfW}`);
  assert.ok(Math.abs(height - 2 * g.halfH) < 0.5, `height ${height} vs ${2 * g.halfH}`);
});

test('range override (activation probe clamp) shortens but never lengthens the range', () => {
  const clamped = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND, 100);
  assert.equal(clamped.rangeM, 100);
  // halfW scales with the effective range.
  assert.ok(Math.abs(clamped.halfW - 100 * Math.tan(toRad(56) / 2)) < 1e-6);
  const longer = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND, 5000);
  assert.equal(longer.rangeM, 210, 'an override beyond the pose range is ignored');
  const none = computeFrustumGeometry(UNCLAMPED_CAMERA, UNCLAMPED_GROUND, null);
  assert.equal(none.rangeM, 210);
});

test('activation obstruction clamp uses the field-derived 12 m floor', () => {
  assert.equal(activationProbeClampRange(210, 8), 12);
  assert.equal(activationProbeClampRange(210, 150), 146);
  assert.equal(activationProbeClampRange(210, 210), null);
  assert.equal(activationProbeClampRange(210, 250), null);
});

test('deactivation clears the probe clamp and restores nominal frustum geometry', () => {
  const record = {
    camera: { ...UNCLAMPED_CAMERA },
    probeClampRangeM: 105,
  };
  let rewrittenRange = null;

  assert.equal(clearProbeClampOnDeactivation(record, (deactivated) => {
    rewrittenRange = computeFrustumGeometry(
      deactivated.camera,
      UNCLAMPED_GROUND,
      deactivated.probeClampRangeM,
    ).rangeM;
  }), true);
  assert.equal(record.probeClampRangeM, null);
  assert.equal(rewrittenRange, 210);
});

test('CCTV disable hide sweep clears probe clamps and re-arms only the active camera', () => {
  const records = [
    { camera: { id: 'a' }, activationDone: true, probeClampRangeM: 105 },
    { camera: { id: 'b' }, activationDone: true, probeClampRangeM: 146 },
  ];
  hideCctvRecordVisuals(records, null, 'a');
  assert.deepEqual(records.map((record) => record.probeClampRangeM), [null, null]);
  assert.deepEqual(records.map((record) => record.activationDone), [false, true]);
});

test('active camera publishes one protected monitor card at the end of its view axis', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const record = {
    camera: {
      ...UNCLAMPED_CAMERA,
      id: 'runtime-projection',
      name: 'Congress & 6th Monitor',
      city: 'Austin',
      feedType: 'image',
      groundElevationM: UNCLAMPED_GROUND,
    },
  };
  _setCctvOverlayHostForTest(overlayHost);
  try {
    _setCctvCoverageStateForTest({
      records: [record],
      activeCameraId: record.camera.id,
      enabled: true,
      coverageMode: 'off',
      showProjection: true,
    });
    refreshCoverageStyles();
    const publication = calls.find(([type, sourceId]) => (
      type === 'entries' && sourceId === 'cctv-projection'
    ));
    assert.ok(publication, 'active projection must publish its monitor card');
    assert.deepEqual(publication[3], CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS);
    assert.equal(publication[2].length, 1);
    const entry = publication[2][0];
    assert.equal(entry.title, 'Congress & 6th Monitor');
    assert.equal(entry.variant, 'monitor');
    assert.equal(entry.protected, true);
    assert.equal(entry.paintLane, 'selected');
    assert.match(entry.monitor.src, /^\/api\/cctv\/frame\/runtime-projection\?/);
    assert.equal(entry.monitor.video, false);
    assert.ok(Math.abs(entry.position.lat - record.footprint.axisEnd.lat) < 1e-12, 'anchored at the far edge');
    assert.ok(Math.abs(entry.position.lon - record.footprint.axisEnd.lon) < 1e-12);

    _setCctvCoverageStateForTest({
      records: [record],
      activeCameraId: null,
      enabled: false,
      coverageMode: 'off',
      showProjection: false,
    });
    refreshCoverageStyles();
    assert.deepEqual(calls.slice(-2), [
      ['clear', 'cctv-projection'],
      ['visible', 'cctv-projection', false],
    ]);
  } finally {
    _setCctvCoverageStateForTest({ enabled: false });
    _setCctvOverlayHostForTest();
  }
});

test('CCTV disable→enable defers the active-camera re-probe until its next activation', () => {
  const record = {
    camera: { id: 'active', rangeM: 210 },
    activationDone: true,
    probeClampRangeM: 105,
    coverageEntities: [],
  };
  let probeCalls = 0;
  const probe = () => {
    probeCalls += 1;
    record.probeClampRangeM = activationProbeClampRange(record.camera.rangeM, 150);
  };
  const setActiveCamera = () => {
    if (!cctvRecordNeedsActivation('active', 'active', record)) return;
    probe();
    record.activationDone = true;
  };

  hideCctvRecordVisuals([record], () => {}, 'active');
  assert.equal(record.probeClampRangeM, null);
  assert.equal(record.activationDone, false);
  assert.equal(cctvRecordNeedsActivation('active', 'active', record), true);
  assert.doesNotMatch(
    cctvLayer.enable.toString(),
    /setActiveCamera|runActivationObstructionProbe|pickFromRay/,
    'enable must restore nominal visuals without entering the activation probe path',
  );
  assert.equal(probeCalls, 0, 'enable performs zero obstruction probes');

  setActiveCamera();

  assert.equal(probeCalls, 1);
  assert.equal(record.probeClampRangeM, 146);
  assert.equal(cctvRecordNeedsActivation('active', 'active', record), false);

  setActiveCamera();
  assert.equal(probeCalls, 1, 're-selecting the activated camera remains a no-op');
});

function makeFocusEngine(trackedTarget = null) {
  const flights = [];
  return {
    trackedTarget,
    flights,
    flyToTarget(target, options) { flights.push({ target, options }); },
  };
}

test('CCTV focus distinguishes tracking ownership from a missing active camera', () => {
  const engine = makeFocusEngine({ id: 'tracked-flight' });
  const record = { camera: { ...UNCLAMPED_CAMERA, rangeM: 210, headingDeg: 41 } };
  const originalDebug = console.debug;
  console.debug = () => {};
  try {
    assert.equal(focusCctvRecord(engine, record, 1.9), CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW);
  } finally {
    console.debug = originalDebug;
  }
  assert.equal(engine.flights.length, 0);
  assert.equal(focusCctvRecord(engine, null, 1.9), CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA);
  assert.equal(focusCctvRecord(null, record, 1.9), CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA);
});

test('CCTV focus reports when the camera flight starts and looks along the camera heading', () => {
  const engine = makeFocusEngine();
  const record = { camera: { ...UNCLAMPED_CAMERA, rangeM: 210, headingDeg: 41 } };
  assert.equal(focusCctvRecord(engine, record, 1.9), CCTV_FOCUS_RESULT.FOCUSED);
  assert.equal(engine.flights.length, 1);
  const { target, options } = engine.flights[0];
  assert.equal(options.heading, 41);
  assert.equal(options.duration, 1.9);
  assert.ok(options.rangeM >= 280);
  assert.ok(options.pitch < 0);
  assert.ok(Number.isFinite(target.lat) && Number.isFinite(target.lon));
});

test('CCTV focus refuses camera flights while cockpit owns the view', () => {
  const originalDocument = globalThis.document;
  const engine = makeFocusEngine();
  const record = { camera: { ...UNCLAMPED_CAMERA, rangeM: 210, headingDeg: 41 } };
  const originalDebug = console.debug;
  console.debug = () => {};
  globalThis.document = {
    body: { classList: { contains: (name) => name === 'cockpit-mode' } },
  };
  try {
    assert.equal(focusCctvRecord(engine, record, 1.9), CCTV_FOCUS_RESULT.COCKPIT_ACTIVE);
  } finally {
    console.debug = originalDebug;
    globalThis.document = originalDocument;
  }
  assert.equal(engine.flights.length, 0);
});

test('CCTV repeated in-world clicks dispatch focus only for the one real activation', () => {
  const target = new EventTarget();
  const activated = [];
  const requests = [];
  const results = [
    CCTV_ACTIVATION_RESULT.ACTIVATED,
    CCTV_ACTIVATION_RESULT.UNCHANGED,
    CCTV_ACTIVATION_RESULT.UNCHANGED,
  ];
  target.addEventListener(CCTV_FOCUS_REQUEST_EVENT, (event) => requests.push(event.detail));

  const activate = (cameraId) => {
    activated.push(cameraId);
    return results.shift();
  };
  assert.deepEqual([
    activateCctvCameraFromWorldClick('atx-cam-3', activate, target),
    activateCctvCameraFromWorldClick('atx-cam-3', activate, target),
    activateCctvCameraFromWorldClick('atx-cam-3', activate, target),
  ], [true, false, false]);

  assert.deepEqual(activated, ['atx-cam-3', 'atx-cam-3', 'atx-cam-3']);
  assert.deepEqual(requests, [{ cameraId: 'atx-cam-3' }]);
});

// ─── Empty-space deselection and stable null-active state ──────────────────

function makeDeselectEngine() {
  const view = { lat: 30.2672, lon: -97.7431, alt: 4_000, heading: 23, pitch: -40, roll: 0 };
  return {
    view,
    trackedTarget: { id: 'sibling-track-owner' },
    container: { clientWidth: 1200, clientHeight: 800 },
    getCameraView: () => ({ ...view, targetLat: view.lat, targetLon: view.lon }),
    cameraHeightAboveGround: () => view.alt,
    project: () => null,
    flyToTarget() { this.flyCalls = (this.flyCalls || 0) + 1; },
  };
}

function makeDeselectRecord(id, index = 0) {
  return {
    camera: {
      ...UNCLAMPED_CAMERA,
      id,
      name: `Camera ${id}`,
      city: 'Austin',
      lon: UNCLAMPED_CAMERA.lon + index * 0.002,
      groundElevationM: UNCLAMPED_GROUND,
    },
    activationDone: true,
  };
}

test('CCTV empty-click gate excludes every identified scene object, ADJUST, and null-active clicks', () => {
  assert.equal(cctvEmptyClickDeselects(null, { activeCameraId: 'cam-1' }), true);
  assert.equal(cctvEmptyClickDeselects(null, {
    activeCameraId: 'cam-1',
    calibrationMode: true,
  }), false);
  assert.equal(cctvEmptyClickDeselects(null, { activeCameraId: null }), false);
  assert.equal(cctvEmptyClickDeselects({ id: 'registered-sibling' }, {
    activeCameraId: 'cam-1',
  }), false);
  assert.equal(cctvEmptyClickDeselects({ id: { id: 'unregistered-local-entity' } }, {
    activeCameraId: 'cam-1',
  }), false);
  assert.equal(cctvEmptyClickDeselects({ primitive: { id: 'unregistered-primitive' } }, {
    activeCameraId: 'cam-1',
  }), false);
  assert.equal(cctvEmptyClickDeselects({ id: '' }, {
    activeCameraId: 'cam-1',
  }), false, 'an empty-string scene ID is still identified rather than empty space');
  assert.equal(cctvEmptyClickDeselects({ primitive: {} }, {
    activeCameraId: 'cam-1',
  }), true, 'an ID-less surface pick remains true empty space');

  assert.equal(cctvEmptyClickDeselects({ feature: {}, def: { id: 'traffic' } }, {
    activeCameraId: 'cam-1',
  }), false, 'a layer-host hit (any MapLibre layer) is never empty space');
});

test('CCTV deselect publishes one null state and leaves the map camera unchanged', () => {
  const engine = makeDeselectEngine();
  const record = { ...makeDeselectRecord('deselect-me'), probeClampRangeM: 150 };
  const publications = [];
  const calls = [];
  _setCctvOverlayHostForTest({
    setEntries(sourceId) { calls.push(['entries', sourceId]); },
    setVisible() {},
    clearSource(sourceId) { calls.push(['clear', sourceId]); },
    hitTest: () => null,
  });
  try {
    _setCctvCoverageStateForTest({
      engine,
      records: [record],
      activeCameraId: record.camera.id,
      enabled: true,
      coverageMode: 'off',
      showProjection: true,
    });
    refreshCoverageStyles();
    assert.ok(calls.some(([type, id]) => type === 'entries' && id === 'cctv-projection'));
    const unsubscribe = cctvLayer.subscribe((state) => publications.push(state));
    const baselinePublications = publications.length;
    const pose = { ...engine.view };

    assert.equal(deactivateActiveCamera(), true);
    assert.equal(deactivateActiveCamera(), false, 'repeat deselect is idempotent');
    assert.equal(publications.length, baselinePublications + 1);
    assert.equal(publications.at(-1).activeCameraId, null);
    assert.equal(publications.at(-1).activeCamera, null);
    assert.equal(publications.at(-1).enabled, true);
    assert.ok(calls.some(([type, id]) => type === 'clear' && id === 'cctv-projection'), 'monitor card removed');
    assert.equal(_coverageFeaturesForTest().features.length, 0);
    assert.equal(record.probeClampRangeM, null);
    assert.equal(record.activationDone, false);
    assert.deepEqual(engine.view, pose);
    assert.equal(engine.flyCalls || 0, 0);
    unsubscribe();
  } finally {
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
});

test('CCTV null-active coverage, auto-hop, cycling, and panel targets stay honest', () => {
  const engine = makeDeselectEngine();
  const records = Array.from({ length: 3 }, (_, index) => makeDeselectRecord(`cam-${index}`, index));
  _setCctvOverlayHostForTest({ setEntries() {}, setVisible() {}, clearSource() {} });
  try {
    _setCctvCoverageStateForTest({
      engine,
      records,
      activeCameraId: records[0].camera.id,
      enabled: true,
      coverageMode: 'on',
    });
    cctvLayer.setParams({ autoHop: true, autoHopSec: 8 });
    assert.equal(deactivateActiveCamera(), true);
    refreshCoverageStyles();
    assert.equal(cctvLayer.getUIState().activeCameraId, null);
    assert.equal(_coverageFeaturesForTest().features.length, 0, 'no active camera → no coverage cohort');
    maybeAutoHop(1_000_000);
    assert.equal(cctvLayer.getUIState().activeCameraId, null, 'elapsed auto-hop stays suspended');

    assert.equal(cctvCycleIndex(-1, 1, records.length), 0);
    assert.equal(cctvCycleIndex(-1, -1, records.length), records.length - 1);
    assert.equal(cctvCycleIndex(2, 1, records.length), 0);
    assert.equal(cctvCycleIndex(0, -1, records.length), records.length - 1);

    const renderer = UI_SOURCE.match(/_renderCctvState\(state\) \{[\s\S]*?\n  \}\n/);
    assert.ok(renderer, '_renderCctvState is missing');
    assert.match(renderer[0], /else if \(!activeId\)[\s\S]*?selectedIndex = -1/);
    assert.match(renderer[0], /_cctvFocusBtn\.disabled = !enabled \|\| cameras\.length === 0 \|\| !activeId/);
  } finally {
    cctvLayer.setParams({ autoHop: false });
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
});

test('CCTV disable clears and hides its shared-host source through the real layer lifecycle', () => {
  const calls = [];
  _setCctvOverlayHostForTest({
    clearSource(sourceId) { calls.push(['clear', sourceId]); },
    setVisible(sourceId, visible) { calls.push(['visible', sourceId, visible]); },
  });
  try {
    _setCctvCoverageStateForTest({ enabled: true });
    cctvLayer.disable();
    assert.deepEqual(calls, [
      ['clear', 'cctv'],
      ['visible', 'cctv', false],
      ['clear', 'cctv-projection'],
      ['visible', 'cctv-projection', false],
    ]);
  } finally {
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
});

test('pristine module default publishes no active-camera card (shipped behavior needs no setter call)', () => {
  // Deliberately never calls setCardPresentationOptions: this test must run
  // before any test that does, so a flipped `_activeCameraCardEnabled`
  // default (the P4 round-1 product inversion) fails here even though every
  // explicit-option test still passes.
  const publications = [];
  const activeRecord = {
    camera: { id: 'default-active-camera', name: 'DEFAULT ACTIVE' },
    position: { x: 1, y: 2, z: 3 },
  };
  _setCctvOverlayHostForTest({
    setEntries(sourceId, entries) {
      publications.push({ sourceId, entries });
    },
  });
  try {
    _setCctvCoverageStateForTest({
      records: [activeRecord],
      activeCameraId: activeRecord.camera.id,
      enabled: true,
    });
    _pushAmbientCardEntriesForTest();
    assert.deepEqual(
      publications.at(-1),
      { sourceId: 'cctv', entries: [] },
      'active camera must not publish a host card under the untouched default',
    );
  } finally {
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
});

test('active CCTV camera is absent from host by default and protected only when opted in', () => {
  const publications = [];
  const activeRecord = {
    camera: { id: 'active-camera', name: 'ACTIVE CAMERA' },
    position: { x: 1, y: 2, z: 3 },
  };
  _setCctvOverlayHostForTest({
    setEntries(sourceId, entries) {
      publications.push({ sourceId, entries });
    },
  });
  try {
    _setCctvCoverageStateForTest({
      records: [activeRecord],
      activeCameraId: activeRecord.camera.id,
      enabled: true,
    });

    assert.deepEqual(
      cctvLayer.setCardPresentationOptions({ activeCameraCardEnabled: false }),
      { activeCameraCardEnabled: false },
    );
    assert.deepEqual(publications.at(-1), { sourceId: 'cctv', entries: [] });

    assert.deepEqual(
      cctvLayer.setCardPresentationOptions({ activeCameraCardEnabled: true }),
      { activeCameraCardEnabled: true },
    );
    const activeEntry = publications.at(-1).entries.find(({ id }) => id === activeRecord.camera.id);
    assert.ok(activeEntry, 'opt-in republishes the active camera into the host');
    assert.equal(activeEntry.active, true);
    assert.equal(activeEntry.protected, true);
  } finally {
    setCctvCardPresentationOptions({ activeCameraCardEnabled: false });
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
});

test('CCTV drag-then-release over a camera is inert, while a clean tap activates and dispatches', () => {
  let timeMs = 0;
  let activationCalls = 0;
  const handler = makeGestureHandler();
  const target = new EventTarget();
  const requests = [];
  target.addEventListener(CCTV_FOCUS_REQUEST_EVENT, (event) => requests.push(event.detail));
  bindCctvWorldClickGesture(handler, () => {
    activateCctvCameraFromWorldClick('atx-cam-3', () => {
      activationCalls += 1;
      return CCTV_ACTIVATION_RESULT.ACTIVATED;
    }, target);
  }, {
    now: () => timeMs,
    eventTypes: GESTURE_TYPES,
  });

  handler.fire(GESTURE_TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  timeMs = 20;
  handler.fire(GESTURE_TYPES.MOUSE_MOVE, { endPosition: { x: 14, y: 10 } });
  timeMs = 40;
  handler.fire(GESTURE_TYPES.MOUSE_MOVE, { endPosition: { x: 10, y: 10 } });
  timeMs = 60;
  handler.fire(GESTURE_TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  handler.fire(GESTURE_TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  assert.equal(activationCalls, 0);
  assert.deepEqual(requests, []);

  timeMs = 100;
  handler.fire(GESTURE_TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  timeMs = 180;
  handler.fire(GESTURE_TYPES.LEFT_UP, { position: { x: 11, y: 11 } });
  handler.fire(GESTURE_TYPES.LEFT_CLICK, { position: { x: 11, y: 11 } });
  assert.equal(activationCalls, 1);
  assert.deepEqual(requests, [{ cameraId: 'atx-cam-3' }]);
});

test('CCTV auto-hop remains activation-only and never dispatches a focus request', () => {
  assert.doesNotMatch(
    maybeAutoHop.toString(),
    /activateCctvCameraFromWorldClick|gev:cctv-request-focus|dispatchEvent/,
  );
});

test('heading wrap: heading 350° produces a symmetric cap (left/right corners equidistant)', () => {
  const camera = { ...UNCLAMPED_CAMERA, headingDeg: 350 };
  const g = computeFrustumGeometry(camera, UNCLAMPED_GROUND);
  const m = g.mount;
  const dTL = mag(enu(m, g.corners.tl));
  const dTR = mag(enu(m, g.corners.tr));
  assert.ok(Math.abs(dTL - dTR) < 0.5, `tl ${dTL} vs tr ${dTR}`);
});

// ---------------------------------------------------------------------------
// Task 5 — calibration v2 store + CAL badge (design §3b/§3c as amended by the
// LOCKED product rules §9.2/§9.3: wipe-clean v2 store, panel-only badge).
// ---------------------------------------------------------------------------

/** Minimal in-memory localStorage stand-in for pure store-IO unit tests. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _dump: () => Object.fromEntries(map.entries()),
  };
}

test('calibration v2 round-trip: writeCalibrationStoreV2 → readCalibrationStoreV2 preserves values/source/savedAt', () => {
  const storage = fakeStorage();
  const savedAt = 1782800000000;
  const entry = new Map([
    ['austin-42', {
      values: { offsetNorthM: 12.5, offsetEastM: -3.0, headingDeg: 41.0, pitchDeg: 4.0, fovDeg: -8.0, rangeScale: 1.35, heightM: 6.0 },
      source: 'manual',
      savedAt,
    }],
  ]);
  writeCalibrationStoreV2(entry, storage);

  const raw = JSON.parse(storage.getItem(CCTV_CALIBRATION_STORAGE_KEY_V2));
  assert.equal(raw['austin-42'].source, 'manual');
  assert.equal(raw['austin-42'].savedAt, savedAt);
  assert.equal(raw['austin-42'].values.offsetNorthM, 12.5);

  const restored = readCalibrationStoreV2(storage);
  assert.ok(restored instanceof Map);
  const cam = restored.get('austin-42');
  assert.equal(cam.source, 'manual');
  assert.equal(cam.savedAt, savedAt);
  assert.deepEqual(cam.values, entry.get('austin-42').values);
});

test('calibration v2: removing an entry (reset) then re-writing produces an empty store', () => {
  const storage = fakeStorage();
  const entry = new Map([
    ['sf-market-5th', { values: { offsetNorthM: 5, offsetEastM: 0, headingDeg: 0, pitchDeg: 0, fovDeg: 0, rangeScale: 1, heightM: 0 }, source: 'manual', savedAt: 1000 }],
  ]);
  writeCalibrationStoreV2(entry, storage);
  assert.ok(readCalibrationStoreV2(storage).has('sf-market-5th'));

  // Reset removes the entry from the map, then persists the now-empty map —
  // this is the shape setParams({calibration:{reset:true}}) drives.
  entry.delete('sf-market-5th');
  writeCalibrationStoreV2(entry, storage);

  const restored = readCalibrationStoreV2(storage);
  assert.equal(restored.size, 0, 'reset entry must be gone, base pose restored');
});

test('calibration v2: malformed/partial entries are dropped defensively', () => {
  const storage = fakeStorage({
    [CCTV_CALIBRATION_STORAGE_KEY_V2]: JSON.stringify({
      'ok-cam': { values: { offsetNorthM: 1, offsetEastM: 2, headingDeg: 3, pitchDeg: 4, fovDeg: 5, rangeScale: 1.1, heightM: 6 }, source: 'manual', savedAt: 42 },
      'no-values': { source: 'manual', savedAt: 42 },
      'junk': 'not-an-object',
    }),
  });
  const restored = readCalibrationStoreV2(storage);
  assert.ok(restored.has('ok-cam'));
  assert.equal(restored.get('ok-cam').values.offsetNorthM, 1);
});

test('calibration v2: a corrupt v1 key never leaks into the v2 store (v1 is dead data, never read)', () => {
  const storage = fakeStorage({
    [CCTV_CALIBRATION_STORAGE_KEY_V1]: JSON.stringify({
      'austin-42': { offsetNorthM: 999, offsetEastM: 999, headingDeg: 999, pitchDeg: 0, fovDeg: 0, rangeScale: 1, heightM: 0 },
    }),
  });
  // v2 key is untouched/empty — v1's presence must have zero effect.
  const restored = readCalibrationStoreV2(storage);
  assert.equal(restored.size, 0, 'v2 store must start empty — no legacy import (product rule #3, §9.3)');
  assert.ok(!restored.has('austin-42'));
});

test('deriveCalBadge: CALIBRATED when the camera carries a manual v2 calibration', () => {
  const camera = { calSource: 'manual', poseSource: 'curated' };
  // Manual calibration wins over curated — a human explicitly tuned this pose.
  assert.equal(deriveCalBadge(camera), 'calibrated');
});

test('deriveCalBadge: CURATED for a hand-authored catalog prior with no manual save', () => {
  const camera = { calSource: null, poseSource: 'curated' };
  assert.equal(deriveCalBadge(camera), 'curated');
});

test('deriveCalBadge: RAW PRIOR for everything else (all Austin Open Data today)', () => {
  const camera = { calSource: null, poseSource: null };
  assert.equal(deriveCalBadge(camera), 'raw-prior');
  assert.equal(deriveCalBadge({}), 'raw-prior');
});

// ---------------------------------------------------------------------------
// Task 5 (height-datum fix): regime-aware ground resolution pure helpers.
// the height-datum contract in docs/CURRENT-STATE.md.
// ---------------------------------------------------------------------------

test('surfaceRegimeKey: globe hidden (photoreal) → google-3d; globe visible → terrain-globe', () => {
  assert.equal(surfaceRegimeKey(false), 'google-3d');
  assert.equal(surfaceRegimeKey(true), 'terrain-globe');
});

test('surfaceRegimeKey: unknown globe state (no viewer / no scene) defaults to terrain-globe (never samples)', () => {
  // Only an explicit globe.show === false means the visible surface is the
  // Google tileset. undefined/null (torn-down viewer) must fall to the
  // regime that takes ZERO scene queries.
  assert.equal(surfaceRegimeKey(undefined), 'terrain-globe');
  assert.equal(surfaceRegimeKey(null), 'terrain-globe');
});

test('calibrationPatchMovesAnchor: only north/east translation re-resolves ground', () => {
  assert.equal(calibrationPatchMovesAnchor({ offsetNorthM: 10 }), true);
  assert.equal(calibrationPatchMovesAnchor({ offsetEastM: -5 }), true);
  assert.equal(calibrationPatchMovesAnchor({ headingDeg: 20 }), false);
  assert.equal(calibrationPatchMovesAnchor({ pitchDeg: -2, fovDeg: 5 }), false);
  assert.equal(calibrationPatchMovesAnchor({ rangeScale: 1.2, heightM: 8 }), false);
  assert.equal(calibrationPatchMovesAnchor(null), false);
});

// Coverage tri-state (viewshed design §3b): normalizeCoverageMode
// ---------------------------------------------------------------------------

test('normalizeCoverageMode: passes through the three valid modes', () => {
  assert.equal(normalizeCoverageMode('off', 'on'), 'off');
  assert.equal(normalizeCoverageMode('on', 'off'), 'on');
  assert.equal(normalizeCoverageMode('viewshed', 'off'), 'viewshed');
});

test('normalizeCoverageMode: boolean back-compat (showCoverage semantics)', () => {
  assert.equal(normalizeCoverageMode(true, 'off'), 'on');
  assert.equal(normalizeCoverageMode(false, 'viewshed'), 'off');
});

test('normalizeCoverageMode: garbage keeps the current mode', () => {
  assert.equal(normalizeCoverageMode('sideways', 'viewshed'), 'viewshed');
  assert.equal(normalizeCoverageMode(undefined, 'on'), 'on');
  assert.equal(normalizeCoverageMode(null, 'off'), 'off');
  assert.equal(normalizeCoverageMode(3, 'on'), 'on');
});

// Unchanged-frame signature (white-flash fix, field test 2026-07-30)
// ---------------------------------------------------------------------------

/** Builds an RGBA buffer from [r,g,b] triples. */
function rgba(triples) {
  const out = new Uint8ClampedArray(triples.length * 4);
  triples.forEach(([r, g, b], i) => {
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  });
  return out;
}

test('frameSignatureFromPixels: identical pixels hash identically', () => {
  const a = rgba([[1, 2, 3], [250, 128, 7], [0, 0, 0]]);
  const b = rgba([[1, 2, 3], [250, 128, 7], [0, 0, 0]]);
  assert.equal(frameSignatureFromPixels(a), frameSignatureFromPixels(b));
});

test('frameSignatureFromPixels: a single changed channel changes the hash', () => {
  const base = rgba([[10, 20, 30], [40, 50, 60]]);
  const tweak = rgba([[10, 20, 31], [40, 50, 60]]);
  assert.notEqual(frameSignatureFromPixels(base), frameSignatureFromPixels(tweak));
});

test('frameSignatureFromPixels: order matters (a swap is not a collision)', () => {
  const ab = rgba([[1, 2, 3], [9, 8, 7]]);
  const ba = rgba([[9, 8, 7], [1, 2, 3]]);
  assert.notEqual(frameSignatureFromPixels(ab), frameSignatureFromPixels(ba));
});

test('frameSignatureFromPixels: alpha is deliberately ignored', () => {
  const opaque = new Uint8ClampedArray([5, 6, 7, 255]);
  const clear = new Uint8ClampedArray([5, 6, 7, 0]);
  assert.equal(frameSignatureFromPixels(opaque), frameSignatureFromPixels(clear));
});

test('frameSignatureFromPixels: returns an unsigned 32-bit value', () => {
  const sig = frameSignatureFromPixels(rgba([[255, 255, 255], [0, 0, 0]]));
  assert.ok(Number.isInteger(sig) && sig >= 0 && sig <= 0xffffffff, `got ${sig}`);
});

test('frameSignatureFromPixels: empty or junk input yields null (always redraw)', () => {
  assert.equal(frameSignatureFromPixels(new Uint8ClampedArray(0)), null);
  assert.equal(frameSignatureFromPixels(null), null);
  assert.equal(frameSignatureFromPixels(undefined), null);
  assert.equal(frameSignatureFromPixels({}), null);
});
