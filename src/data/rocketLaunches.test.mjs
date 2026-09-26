import test from 'node:test';
import assert from 'node:assert/strict';
import { gstime } from 'satellite.js';
import rocketLaunchesLayer, {
  _missionFeaturesForTest,
  _replayActiveLaunchForTest,
  _setSelectedRocketMissionForTest,
  _startMissionReplayForTest,
  approximateOrbitPath,
  buildMissionPaths,
  cameraHeadingForPath,
  compactLaunchSiteName,
  createRocketMissionElementOverlayEntry,
  createRocketMissionMarkerOverlayEntry,
  formatMissionEventTime,
  LAUNCH_PAD_ZONE_RADIUS_M,
  launchPadZoneVisible,
  launchStatusAllowsOrbit,
  missionAnchorHorizonVisible,
  missionAnchorVisible,
  missionHoverPreviewRange,
  missionDataCompleteness,
  missionMarkerColor,
  missionPathPresentation,
  missionRosterEntries,
  missionZoomPitch,
  orbitProgressAtTime,
  normalizeReplaySpeed,
  normalizeRocketLaunches,
  parseMissionDurationSeconds,
  replayState,
  replayCameraView,
  replayChaseCameraHeading,
  replayOrbitFrameSphere,
  replayOrbitGlobeAnchor,
  replayOrbitCameraTarget,
  replayOrbitCameraPose,
  replayOrbitGlobeRange,
  replayOverlayMode,
  replayInitialCameraHeading,
  smoothReplayWindowPosition,
  replayAscentDurationSeconds,
  replayStartAfterPause,
  replayVehicleScreenRotation,
  releaseAircraftTracking,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  samplePath,
  satelliteParamsAfterSpaceMissions,
  satelliteParamsForSpaceMissions,
  shouldRetryAfterActiveTle,
  selectRocketMissionMarkerOverlayCohort,
  smoothReplayCameraHeading,
} from './rocketLaunches.js';
import {
  WGS84_A,
  cartesianFromDegrees,
  cross,
  distance,
  dot,
  geodeticFromCartesian,
  magnitude,
  negativePiToPi,
  normalize,
  sub,
  surfaceDistance,
  toDegrees,
  toRadians,
  vec,
} from './spaceGeo.js';
import {
  findSatelliteOrbitTrackInTle,
  orbitFrameModelMatrix,
  satelliteCatalogModeChanged,
  scoreSatelliteNameMatch,
} from './satellites.js';

const NOW = new Date('2026-07-27T00:00:00Z');
const acosClamped = (x) => Math.acos(Math.max(-1, Math.min(1, x)));

test('mission anchors are hidden behind Earth and restored on the facing hemisphere', () => {
  const camera = cartesianFromDegrees(-75, 20, 18000000);
  const front = cartesianFromDegrees(-75, 20);
  const rear = cartesianFromDegrees(105, -20);
  assert.equal(missionAnchorHorizonVisible(camera, front), true);
  assert.equal(missionAnchorHorizonVisible(camera, rear), false);
});

test('selecting one mission hides every other front-facing launch anchor', () => {
  const camera = cartesianFromDegrees(-75, 20, 18000000);
  const first = cartesianFromDegrees(-75, 20);
  const second = cartesianFromDegrees(-80, 25);

  assert.equal(missionAnchorVisible(camera, first, 'first', null), true);
  assert.equal(missionAnchorVisible(camera, second, 'second', null), true);
  assert.equal(missionAnchorVisible(camera, first, 'first', 'first'), true);
  assert.equal(missionAnchorVisible(camera, second, 'second', 'first'), false);
});

test('advances the live orbit marker between whole seconds', () => {
  assert.equal(orbitProgressAtTime(10_000, 100), 0.1);
  assert.equal(orbitProgressAtTime(10_250, 100), 0.1025);
  assert.ok(orbitProgressAtTime(10_250, 100) > orbitProgressAtTime(10_000, 100));
});

test('samples replay paths uniformly by distance rather than vertex count', () => {
  const path = [
    vec(0, 0, 0),
    vec(1, 0, 0),
    vec(101, 0, 0),
  ];
  assert.ok(Math.abs(samplePath(path, 0.5).x - 50.5) < 1e-9);
  assert.ok(Math.abs(samplePath(path, 0.75).x - 75.75) < 1e-9);
});

test('transitions selected mission zoom from globe nadir to an oblique site view', () => {
  assert.ok(Math.abs(missionZoomPitch(5000000) - toRadians(-90)) < 1e-10);
  assert.ok(Math.abs(missionZoomPitch(180000) - toRadians(-42)) < 1e-10);
  const midPitch = toDegrees(missionZoomPitch(1000000));
  assert.ok(midPitch < -42 && midPitch > -90);
});

test('pulls replay camera from close ascent tracking into a globe-scale orbit view', () => {
  const ascent = replayCameraView({ ascending: true, phaseProgress: 0.9 }, 120000);
  const contextualAscent = replayCameraView({ ascending: true, phaseProgress: 0.9 }, 420000);
  const orbitStart = replayCameraView({ ascending: false, phaseProgress: 0 }, 550000);
  const orbitMidPullback = replayCameraView({ ascending: false, phaseProgress: 0.1 }, 550000);
  const orbitGlobe = replayCameraView({ ascending: false, phaseProgress: 0.2 }, 550000);

  assert.ok(ascent.pitch < toRadians(-20));
  assert.ok(ascent.pitch > toRadians(-34));
  assert.ok(contextualAscent.range > 1000000);
  assert.equal(contextualAscent.pitch, toRadians(-34));
  assert.equal(orbitStart.pitch, toRadians(-34));
  assert.ok(orbitMidPullback.range > orbitStart.range);
  assert.ok(orbitMidPullback.pitch < orbitStart.pitch);
  assert.equal(orbitGlobe.range, 18000000);
  assert.equal(orbitGlobe.pitch, toRadians(-45));
});

test('limits replay camera yaw through heading wraps', () => {
  const previous = toRadians(359);
  const desired = toRadians(181);
  const next = smoothReplayCameraHeading(previous, desired);
  assert.ok(Math.abs(negativePiToPi(next - previous)) <= toRadians(2));

  const wrapped = smoothReplayCameraHeading(
    toRadians(359),
    toRadians(1),
  );
  assert.ok(negativePiToPi(wrapped - previous) > 0);
});

test('starts replay camera broadside to the ascent path', () => {
  const path = [
    cartesianFromDegrees(-120, 34, 0),
    cartesianFromDegrees(-120, 35, 1000),
  ];
  const chaseHeading = cameraHeadingForPath(path, 0);
  const heading = replayInitialCameraHeading(path);
  assert.ok(Math.abs(negativePiToPi(chaseHeading)) < 0.02);
  assert.ok(Math.abs(negativePiToPi(heading - toRadians(90))) < 0.02);
});

test('keeps the chase camera in a rear-quarter view of the forward path', () => {
  assert.ok(Math.abs(
    negativePiToPi(replayChaseCameraHeading(0, 0) - toRadians(30)),
  ) < 1e-10);
  assert.ok(Math.abs(
    negativePiToPi(replayChaseCameraHeading(0, 1) - toRadians(45)),
  ) < 1e-10);
});

test('centers orbit follow on a globe-side anchor while retaining vehicle clearance', () => {
  const position = cartesianFromDegrees(20, 10, 550000);
  const anchor = replayOrbitGlobeAnchor(position, 1);
  const anchorHeight = geodeticFromCartesian(anchor).height;
  assert.ok(Math.abs(anchorHeight - 55000) < 1);
  const target = replayOrbitCameraTarget(anchor, vec(), 1);
  assert.ok(magnitude(target) > WGS84_A * 0.3);
  assert.ok(distance(target, anchor) > 0);
  assert.ok(distance(target, anchor) < magnitude(anchor));
  assert.equal(replayOrbitGlobeRange(18000000, 550000, 1), 18000000);
  assert.ok(replayOrbitGlobeRange(18000000, 35786000, 1) > 50000000);
});

test('keeps the forward orbit tangent moving toward screen-left', () => {
  const earthRadius = WGS84_A;
  const position = vec(earthRadius + 550000, 0, 0);
  const tangentPosition = vec(earthRadius + 550000, 10000, 0);
  const target = vec(earthRadius * 0.35, 0, 0);
  const pose = replayOrbitCameraPose(
    position,
    tangentPosition,
    target,
    18000000,
    toRadians(-45),
  );
  assert.ok(pose);
  const screenRight = normalize(
    cross(pose.direction, pose.up),
  );
  const tangent = normalize(
    sub(
      tangentPosition,
      position,
    ),
  );
  assert.ok(dot(screenRight, tangent) < -0.999);
  assert.ok(Math.abs(
    distance(pose.destination, target) - 18000000,
  ) < 1e-5);
});

test('frames the complete high-apogee orbit together with Earth', () => {
  const earthRadius = WGS84_A;
  const orbit = [
    vec(earthRadius + 300000, 0, 0),
    vec(0, earthRadius + 35786000, 0),
    vec(-(earthRadius + 300000), 0, 0),
    vec(0, -(earthRadius + 35786000), 0),
  ];
  const frame = replayOrbitFrameSphere(orbit);
  const range = replayOrbitGlobeRange(18000000, 300000, 1, frame.radius);
  assert.ok(frame.radius > earthRadius + 30000000);
  assert.ok(range >= frame.radius * 3);
});

test('holds the completed replay on its final orbit frame instead of wrapping to launch', () => {
  const launch = { launchTime: '2026-07-01T00:00:00Z', timeline: [] };
  const completed = replayState(
    launch,
    0,
    12,
    28,
    5400,
    1,
    40000,
    0,
    false,
  );
  assert.equal(completed.ascending, false);
  assert.ok(completed.phaseProgress > 0.999);
});

test('smooths small replay marker reprojection jitter but snaps camera jumps', () => {
  const smoothed = smoothReplayWindowPosition({ x: 100, y: 100 }, { x: 104, y: 103 });
  assert.ok(smoothed.x > 100 && smoothed.x < 104);
  assert.deepEqual(
    smoothReplayWindowPosition({ x: 100, y: 100 }, { x: 140, y: 100 }),
    { x: 140, y: 100 },
  );
});

test('shows the screen-space rocket only while replay is active', () => {
  assert.equal(replayOverlayMode({
    replayActive: false,
    closeSelected: false,
    ascending: true,
    countdownActive: false,
  }), null);
  assert.equal(replayOverlayMode({
    replayActive: false,
    closeSelected: true,
    ascending: false,
    countdownActive: false,
  }), null);
  assert.equal(replayOverlayMode({
    replayActive: true,
    closeSelected: false,
    ascending: true,
    countdownActive: true,
  }), 'countdown');
  assert.equal(replayOverlayMode({
    replayActive: true,
    closeSelected: false,
    ascending: true,
    countdownActive: false,
  }), 'ascent');
  assert.equal(replayOverlayMode({
    replayActive: true,
    closeSelected: false,
    ascending: false,
    countdownActive: false,
  }), 'orbit');
});

test('aligns the replay rocket nose to the projected path tangent', () => {
  assert.equal(replayVehicleScreenRotation({ x: 10, y: 10 }, { x: 10, y: 0 }), 0);
  assert.ok(Math.abs(
    replayVehicleScreenRotation({ x: 10, y: 10 }, { x: 20, y: 10 })
      - Math.PI / 2,
  ) < 1e-10);
  assert.ok(Math.abs(
    replayVehicleScreenRotation({ x: 10, y: 10 }, { x: 0, y: 10 })
      + Math.PI / 2,
  ) < 1e-10);
});

test('clamps and snaps ascent replay speed to supported quarter steps', () => {
  assert.equal(normalizeReplaySpeed(0.1), 0.25);
  assert.equal(normalizeReplaySpeed(0.62), 0.5);
  assert.equal(normalizeReplaySpeed('1.75'), 1.75);
  assert.equal(normalizeReplaySpeed(8), 4);
  assert.equal(normalizeReplaySpeed('invalid'), 1);
});

test('shifts replay start time so pause duration does not advance the mission', () => {
  assert.equal(replayStartAfterPause(1000, 4000, 9500), 6500);
  assert.equal(replayStartAfterPause(1000, 9500, 4000), 1000);
  assert.equal(replayStartAfterPause(1000, Number.NaN, 9500), 1000);
});

test('restores the complete standalone Satellite style after mission mode', () => {
  const standalone = {
    catalog: 'core',
    showPoints: true,
    showOrbits: true,
    labelDensity: 'operator',
  };
  assert.deepEqual(satelliteParamsForSpaceMissions(standalone), {
    ...standalone,
    catalog: 'dense',
    showPoints: false,
    showOrbits: false,
  });
  assert.deepEqual(satelliteParamsAfterSpaceMissions(standalone), standalone);
  assert.deepEqual(satelliteParamsAfterSpaceMissions(null), {
    catalog: 'core',
    showPoints: true,
    showOrbits: true,
  });
});

test('suppresses every orbital representation for failed launches', () => {
  assert.equal(launchStatusAllowsOrbit('Launch Successful'), true);
  assert.equal(launchStatusAllowsOrbit('Go for Launch'), true);
  assert.equal(launchStatusAllowsOrbit('Launch Failure'), false);
  assert.equal(launchStatusAllowsOrbit('Partial Failure'), false);
  assert.equal(launchStatusAllowsOrbit('Failed'), false);
});

test('keeps failed-launch mission details truthful without inventing paths', () => {
  assert.deepEqual(missionPathPresentation({
    status: 'Launch Failure',
    orbit: { name: 'Geostationary Transfer Orbit' },
    trajectory: [],
  }, false), {
    orbit: 'PLANNED · Geostationary Transfer Orbit',
    ascent: 'UNAVAILABLE',
    replayAvailable: false,
  });
  assert.deepEqual(missionPathPresentation({
    status: 'Partial Failure',
    orbit: { name: 'Low Earth Orbit' },
    trajectory: [
      { latitude: 28.5, longitude: -80.5 },
      { latitude: 29, longitude: -79.5 },
    ],
  }, false), {
    orbit: 'PLANNED · Low Earth Orbit',
    ascent: 'SUPPLIED TRAJECTORY POINTS',
    replayAvailable: false,
  });
});

test('describes only renderable successful mission paths', () => {
  assert.deepEqual(missionPathPresentation({
    status: 'Launch Successful',
    orbit: { name: 'Low Earth Orbit' },
    trajectory: [],
  }, true), {
    orbit: 'Low Earth Orbit',
    ascent: 'RECONSTRUCTED ESTIMATE',
    replayAvailable: true,
  });
  assert.deepEqual(missionPathPresentation({
    status: 'Launch Successful',
    orbit: null,
    trajectory: [{ latitude: 28.5, longitude: -80.5 }],
  }, false), {
    orbit: null,
    ascent: 'UNAVAILABLE',
    replayAvailable: false,
  });
});

test('bounds the post-TLE refresh to one resolved-catalog rebuild', () => {
  const base = {
    enabled: true,
    retryCount: 0,
    activeTleText: 'ACTIVE TLE',
    renderedTleText: null,
  };
  assert.equal(shouldRetryAfterActiveTle(base), true);
  assert.equal(shouldRetryAfterActiveTle({ ...base, retryCount: 1 }), false);
  assert.equal(shouldRetryAfterActiveTle({ ...base, activeTleText: null }), false);
  assert.equal(shouldRetryAfterActiveTle({ ...base, renderedTleText: 'ACTIVE TLE' }), false);
  assert.equal(shouldRetryAfterActiveTle({ ...base, enabled: false }), false);
});

test('replay releases aircraft tracking through both owning layer APIs', () => {
  const calls = [];
  const dataManager = {
    layers: new Map([
      ['flights', { module: { stopTracking: () => calls.push('flights') } }],
      ['military', { module: { stopTracking: () => calls.push('military') } }],
      ['satellites', { module: { stopTracking: () => calls.push('satellites') } }],
    ]),
  };
  assert.equal(releaseAircraftTracking(dataManager), 2);
  assert.deepEqual(calls, ['flights', 'military']);
});

test('uses the core GMST frame transform for mission orbit primitives', () => {
  const bakeDate = new Date('2026-07-20T10:00:00Z');
  const nowDate = new Date('2026-07-20T10:10:00Z');
  const gmstAtBake = gstime(bakeDate);
  const matrix = orbitFrameModelMatrix(gmstAtBake, nowDate);
  // Column-major 4x4 (Cesium.Matrix4 layout): the image of +X is column 0.
  const actual = { x: matrix[0], y: matrix[1], z: matrix[2] };
  const expectedAngle = -(gstime(nowDate) - gmstAtBake);
  assert.ok(Math.abs(actual.x - Math.cos(expectedAngle)) < 1e-12);
  assert.ok(Math.abs(actual.y - Math.sin(expectedAngle)) < 1e-12);
  assert.ok(Math.abs(actual.z) < 1e-12);
});

test('treats an already-active Satellite catalog mode as idempotent', () => {
  assert.equal(satelliteCatalogModeChanged('dense', 'dense'), false);
  assert.equal(satelliteCatalogModeChanged('core', 'core'), false);
  assert.equal(satelliteCatalogModeChanged('core', 'dense'), true);
  assert.equal(satelliteCatalogModeChanged('dense', 'core'), true);
  assert.equal(satelliteCatalogModeChanged('core', undefined), false);
});

test('holds replay at the pad for a real-time countdown independent of replay speed', () => {
  const launch = { launchTime: '2026-07-20T10:00:00Z', timeline: [] };
  const tilePreparation = replayState(launch, 115000, 12, 28, 5400, 4, 100000, 5);
  assert.equal(tilePreparation.preCountdownActive, true);
  assert.equal(tilePreparation.countdownActive, false);
  const countdown = replayState(launch, 110000, 12, 28, 5400, 4, 100000);
  assert.equal(countdown.countdownActive, true);
  assert.equal(countdown.countdownSeconds, 10);
  assert.equal(countdown.elapsedSinceStart, 0);
  assert.equal(countdown.phaseProgress, 0);

  const liftoff = replayState(launch, 110000, 12, 28, 5400, 4, 110500);
  assert.equal(liftoff.countdownActive, false);
  assert.equal(liftoff.countdownSeconds, 0);
  assert.equal(liftoff.elapsedSinceStart, 2);
  assert.ok(liftoff.phaseProgress > 0);
});

test('hands replay directly from ascent into orbit', () => {
  const launch = { launchTime: '2026-07-20T10:00:00Z', timeline: [] };
  const orbit = replayState(launch, 0, 12, 28, 5400, 1, 16_000);
  assert.equal(orbit.ascending, false);
  assert.equal(orbit.phaseProgress, 4 / 28);
});

test('shows launch-pad zone only for the selected close-range mission', () => {
  assert.equal(LAUNCH_PAD_ZONE_RADIUS_M, 500);
  const closeSelected = {
    layerActive: true,
    selectedLaunchId: 'mission-a',
    launchId: 'mission-a',
    cameraHeightM: 12000,
    cameraDistanceM: 14000,
  };
  assert.equal(launchPadZoneVisible(closeSelected), true);
  assert.equal(launchPadZoneVisible({ ...closeSelected, layerActive: false }), false);
  assert.equal(launchPadZoneVisible({ ...closeSelected, selectedLaunchId: 'mission-b' }), false);
  assert.equal(launchPadZoneVisible({ ...closeSelected, cameraHeightM: 120001 }), false);
  assert.equal(launchPadZoneVisible({ ...closeSelected, cameraDistanceM: 180001 }), false);
});

test('orders mission roster newest-first without losing navigation indices', () => {
  const entries = missionRosterEntries([
    { id: 'oldest', launchTime: '2026-07-01T00:00:00Z' },
    { id: 'newest', launchTime: '2026-07-20T00:00:00Z' },
    { id: 'middle', launchTime: '2026-07-10T00:00:00Z' },
  ]);
  assert.deepEqual(entries.map((entry) => entry.launch.id), ['newest', 'middle', 'oldest']);
  assert.deepEqual(entries.map((entry) => entry.index), [1, 2, 0]);
});

test('prioritizes data-rich missions before newer sparse records', () => {
  const entries = missionRosterEntries([
    { id: 'rich', launchTime: '2026-07-01T00:00:00Z', provider: 'Agency', mission: 'Detailed mission', orbit: { name: 'LEO' }, payloads: [{ name: 'Payload' }], timeline: [{ name: 'Liftoff' }] },
    { id: 'sparse-new', launchTime: '2026-07-20T00:00:00Z' },
  ]);
  assert.ok(missionDataCompleteness(entries[0].launch) > missionDataCompleteness(entries[1].launch));
  assert.equal(entries[0].launch.id, 'rich');
});

test('preserves globe scale for roster hover previews', () => {
  assert.equal(missionHoverPreviewRange(18178265), 18178265);
  assert.equal(missionHoverPreviewRange(12000), 180000);
  assert.equal(missionHoverPreviewRange(Number.NaN), 5000000);
});

test('assigns distinct stable colors to mission operators', () => {
  assert.equal(missionMarkerColor({ provider: 'NASA', name: 'Science Flight' }), '#ff9f43');
  assert.equal(missionMarkerColor({ provider: 'SpaceX', name: 'Starlink Group' }), '#4cc9f0');
  assert.equal(missionMarkerColor({ provider: 'Private Launch Co.', name: 'Test Flight' }), '#c084fc');
});

test('normalizes recent launches and preserves supplied trajectory/orbit data', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'recent-1',
    name: 'Test Flight',
    net: '2026-07-20T10:00:00Z',
    status: { name: 'Launch Successful' },
    pad: { name: 'Pad A', location: { name: 'Test Range', coordinates: '12.5,45.5' } },
    trajectory: [{ latitude: 45.5, longitude: 12.5, altitude: 0 }],
    timeline: [{ type: { abbrev: 'SECO-1' }, relative_time: 'PT8M40S' }],
    mission: { description: 'Payload test', orbit: { name: 'LEO' } },
  }] }, NOW);

  assert.equal(launches.length, 1);
  assert.equal(launches[0].lat, 45.5);
  assert.equal(launches[0].lon, 12.5);
  assert.equal(launches[0].orbit.name, 'LEO');
  assert.equal(launches[0].trajectory.length, 1);
  assert.equal(launches[0].timeline[0].offsetSeconds, 520);
});

test('uses Launch Library 2 pad latitude/longitude fields', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'pad-fields',
    net: '2026-07-20T10:00:00Z',
    pad: { latitude: '34.632', longitude: '-120.611', location: { name: 'Vandenberg' } },
  }] }, NOW);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].lat, 34.632);
  assert.equal(launches[0].lon, -120.611);
});

test('normalizes detailed payload and stage recovery records', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'recovery-details',
    name: 'Falcon 9 | Test Payload',
    net: '2026-07-20T10:00:00Z',
    pad: { latitude: '28.608', longitude: '-80.604', name: 'LC-39A' },
    rocket: {
      payloads: [{
        id: 501,
        destination: 'Low Earth Orbit',
        amount: 2,
        payload: {
          id: 91,
          name: 'TestSat',
          type: { name: 'Earth Observation Satellite' },
          manufacturer: { name: 'Example Space' },
          operator: { name: 'Example Operator' },
          mass: 420,
        },
      }],
      launcher_stage: [{
        id: 77,
        type: 'Core',
        reused: true,
        launcher_flight_number: 8,
        launcher: { serial_number: 'B1099' },
        landing: {
          attempt: true,
          success: true,
          downrange_distance: 610,
          type: { name: 'Autonomous Spaceport Drone Ship' },
          landing_location: {
            name: 'A Shortfall of Gravitas',
            latitude: '30.1',
            longitude: '-76.2',
          },
        },
      }],
    },
    mission: { orbit: { name: 'Low Earth Orbit' } },
  }] }, NOW);

  assert.equal(launches[0].payloads[0].name, 'TestSat');
  assert.equal(launches[0].payloads[0].amount, 2);
  assert.equal(launches[0].payloads[0].massKg, 420);
  assert.equal(launches[0].recoveryStages[0].name, 'Core · B1099');
  assert.equal(launches[0].recoveryStages[0].status, 'RECOVERED');
  assert.equal(launches[0].recoveryStages[0].downrangeKm, 610);
  assert.equal(launches[0].recoveryStages[0].lat, 30.1);
  assert.equal(launches[0].recoveryStages[0].lon, -76.2);
});

test('keeps payload and recovery collections empty when LL2 does not disclose them', () => {
  const launches = normalizeRocketLaunches({ results: [{
    id: 'undisclosed',
    net: '2026-07-20T10:00:00Z',
    pad: { latitude: '28.608', longitude: '-80.604' },
    rocket: {},
  }] }, NOW);
  assert.deepEqual(launches[0].payloads, []);
  assert.deepEqual(launches[0].recoveryStages, []);
});

test('excludes launches outside the rolling 30-day window and missing coordinates', () => {
  const launches = normalizeRocketLaunches({ results: [
    { id: 'old', net: '2026-06-26T00:00:00Z', pad: { location: { coordinates: '1,1' } } },
    { id: 'no-coordinates', net: '2026-07-20T00:00:00Z', pad: { location: {} } },
    { id: 'future', net: '2026-07-28T00:00:00Z', pad: { location: { coordinates: '1,1' } } },
  ] }, NOW);

  assert.deepEqual(launches, []);
});

test('accepts an array payload for proxy and fixture flexibility', () => {
  const launches = normalizeRocketLaunches([
    { id: 'array-1', net: '2026-07-01T00:00:00Z', pad: { location: { coordinates: '2,3' } } },
  ], NOW);
  assert.equal(launches[0].id, 'array-1');
});

test('builds a surface-safe ascent that meets the orbit without a phase jump', () => {
  const launch = cartesianFromDegrees(-120.61, 34.63, 0);
  const orbit = Array.from({ length: 37 }, (_, index) => {
    const longitude = -180 + index * 10;
    const latitude = Math.sin(toRadians(longitude)) * 35;
    return cartesianFromDegrees(longitude, latitude, 550000);
  });
  const paths = buildMissionPaths(launch, [], orbit);

  assert.ok(paths.ascentPath.length > 2);
  assert.equal(paths.ascentPath.at(-1), orbit[paths.insertionIndex]);
  assert.equal(paths.animatedOrbitPath[0], orbit[paths.insertionIndex]);
  assert.equal(paths.animatedOrbitPath.at(-1), paths.animatedOrbitPath[0]);
  const launchCartographic = geodeticFromCartesian(paths.ascentPath[0]);
  const verticalCartographic = geodeticFromCartesian(paths.ascentPath[12]);
  const earlyHorizontalDistance = surfaceDistance(launchCartographic, verticalCartographic);
  assert.ok(earlyHorizontalDistance < 2000);
  assert.ok(verticalCartographic.height > launchCartographic.height + 10000);
  const maximumTurn = Math.max(...paths.ascentPath.slice(1, -13).map((position, index) => {
    const incoming = normalize(
      sub(position, paths.ascentPath[index]),
    );
    const outgoing = normalize(
      sub(paths.ascentPath[index + 2], position),
    );
    return acosClamped(dot(incoming, outgoing));
  }));
  assert.ok(toDegrees(maximumTurn) < 5);
  const ascentTangent = normalize(
    sub(paths.ascentPath.at(-1), paths.ascentPath.at(-2)),
  );
  const orbitTangent = normalize(
    sub(paths.animatedOrbitPath[1], paths.animatedOrbitPath[0]),
  );
  assert.ok(dot(ascentTangent, orbitTangent) > 0.7);
  for (const position of paths.ascentPath) {
    assert.ok(geodeticFromCartesian(position).height >= -1);
  }
});

test('keeps a tangent-blended inclined ascent outside the globe', () => {
  const launch = cartesianFromDegrees(80, -60, 0);
  const radius = WGS84_A + 200000;
  const inclination = toRadians(30);
  const orbit = Array.from({ length: 97 }, (_, index) => {
    const angle = (index / 96) * (2 * Math.PI);
    return vec(
      radius * Math.cos(angle),
      radius * Math.sin(angle) * Math.cos(inclination),
      radius * Math.sin(angle) * Math.sin(inclination),
    );
  });
  const paths = buildMissionPaths(launch, [], orbit);
  const minimumHeight = Math.min(
    ...paths.ascentPath.map((position) => geodeticFromCartesian(position).height),
  );

  assert.ok(minimumHeight >= -1);
  assert.equal(paths.ascentPath.at(-1), orbit[paths.insertionIndex]);
});

test('uses a propagated insertion reference instead of the radial nearest orbit point', () => {
  const launch = cartesianFromDegrees(-80.6, 28.5, 0);
  const orbit = approximateOrbitPath({
    lat: 28.5,
    lon: -80.6,
    orbit: { name: 'Low Earth Orbit' },
  });
  const targetIndex = 42;
  const paths = buildMissionPaths(launch, [], orbit, orbit[targetIndex]);
  assert.equal(paths.insertionIndex, targetIndex);
  assert.equal(paths.ascentPath.at(-1), orbit[targetIndex]);
  const finalAscent = normalize(
    sub(paths.ascentPath.at(-1), paths.ascentPath.at(-2)),
  );
  const firstOrbit = normalize(
    sub(paths.animatedOrbitPath[1], paths.animatedOrbitPath[0]),
  );
  assert.ok(dot(finalAscent, firstOrbit) > 0.7);
});

test('estimated mission orbit is a smooth planar ring', () => {
  const orbit = approximateOrbitPath({
    lat: 34.63,
    lon: -120.61,
    orbit: { name: 'Polar Orbit' },
  });
  const normal = normalize(
    cross(orbit[0], orbit[24]),
  );
  const maximumPlaneResidual = Math.max(...orbit.map((position) => Math.abs(
    dot(
      normal,
      normalize(position),
    ),
  )));
  assert.ok(maximumPlaneResidual < 1e-12);
  assert.ok(distance(orbit[0], orbit.at(-1)) < 1e-6);
});

test('projects a west-coast ascent forward into orbit without reversing course', () => {
  const launchInfo = {
    lat: 34.63,
    lon: -120.61,
    orbit: { name: 'Low Earth Orbit' },
  };
  const launch = cartesianFromDegrees(launchInfo.lon, launchInfo.lat, 0);
  const orbit = approximateOrbitPath(launchInfo);
  const firstDownrange = geodeticFromCartesian(orbit[1]);
  assert.ok(firstDownrange.lat < launchInfo.lat);
  assert.ok(firstDownrange.lon < launchInfo.lon);

  const paths = buildMissionPaths(launch, [], orbit, orbit[10]);
  const minimumDirectionContinuity = Math.min(
    ...paths.ascentPath.slice(1, -1).map((position, index) => {
      const incoming = normalize(
        sub(position, paths.ascentPath[index]),
      );
      const outgoing = normalize(
        sub(paths.ascentPath[index + 2], position),
      );
      return dot(incoming, outgoing);
    }),
  );
  assert.ok(minimumDirectionContinuity > Math.cos(toRadians(5)));
});

test('formats the launch epoch for ascent and orbit replay labels', () => {
  assert.equal(
    formatMissionEventTime('2026-06-29T02:25:00Z'),
    '2026-06-29\n02:25:00 UTC',
  );
  assert.equal(formatMissionEventTime(null), 'UNAVAILABLE');
});

test('reduces generic launch-site names to their identifying suffix', () => {
  assert.equal(compactLaunchSiteName('Orbital Launch Pad 2'), '2');
  assert.equal(compactLaunchSiteName('Space Launch Complex 4E'), '4E');
  assert.equal(compactLaunchSiteName('Launch Area 130'), '130');
  assert.equal(
    compactLaunchSiteName('Satish Dhawan Space Centre First Launch Pad'),
    'Satish Dhawan Space Centre First Launch Pad',
  );
  assert.equal(compactLaunchSiteName('Unknown'), null);
});

test('mission overlay factories preserve all four source-formatted label roles and lane policy', () => {
  const position = cartesianFromDegrees(-80.604, 28.608);
  const launch = {
    id: 'mission-1',
    name: 'Falcon 9 | Gauntlet Payload',
    launchSite: 'Space Launch Complex 39A',
    launchTime: '2026-07-20T10:00:00Z',
  };
  const ambient = createRocketMissionMarkerOverlayEntry(launch, position);
  assert.deepEqual({
    title: ambient.title,
    details: ambient.details,
    paintLane: ambient.paintLane,
    protected: ambient.protected,
    edgeFade: ambient.edgeFade,
  }, {
    title: 'FALCON 9',
    details: [],
    paintLane: 'ambient-label',
    protected: false,
    edgeFade: 'keyhole',
  });

  const selected = createRocketMissionMarkerOverlayEntry(launch, position, true);
  assert.equal(selected.title, 'FALCON 9');
  assert.deepEqual(selected.details, ['LAUNCH SITE · 39A']);
  assert.equal(selected.paintLane, 'selected');
  assert.equal(selected.protected, true);

  const roles = [
    ['reentry', 'STAGE RE-ENTRY', '#ffd166', ['STAGE RE-ENTRY', []]],
    ['payload', 'EST. ORBIT POSITION\n2026-07-20\n10:00:00 UTC', '#ffd166', [
      'EST. ORBIT POSITION',
      ['2026-07-20', '10:00:00 UTC'],
    ]],
    ['orbit', 'PROJECTED ORBIT', '#c084fc', ['PROJECTED ORBIT', []]],
  ];
  for (const [id, text, accent, [title, details]] of roles) {
    const entry = createRocketMissionElementOverlayEntry({ id, position, text, accent });
    assert.equal(entry.title, title);
    assert.deepEqual(entry.details, details);
    assert.equal(entry.accent, accent);
    assert.equal(entry.paintLane, 'selected');
    assert.equal(entry.protected, true);
    assert.equal(entry.edgeFade, 'keyhole');
  }

  const surplus = Array.from(
    { length: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT + 12 },
    (_, index) => ({ id: `mission-${String(index).padStart(3, '0')}`, priority: index }),
  );
  const cohort = selectRocketMissionMarkerOverlayCohort(surplus);
  assert.equal(cohort.length, ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, 'mission-059');
  assert.equal(cohort.at(-1).id, 'mission-012');
});

test('parses signed Launch Library timeline durations', () => {
  assert.equal(parseMissionDurationSeconds('PT1H1M46S'), 3706);
  assert.equal(parseMissionDurationSeconds('-PT35M'), -2100);
  assert.equal(parseMissionDurationSeconds('P0D'), 0);
  assert.equal(parseMissionDurationSeconds('unknown'), null);
});

test('derives replay ascent duration from mission timing instead of a fixed constant', () => {
  const path = [
    cartesianFromDegrees(-120, 34, 0),
    cartesianFromDegrees(-116, 34, 200000),
  ];
  const fast = replayAscentDurationSeconds({
    timeline: [{ name: 'SECO-1', offsetSeconds: 360 }],
  }, path);
  const slow = replayAscentDurationSeconds({
    timeline: [{ name: 'Orbit insertion', offsetSeconds: 1200 }],
  }, path);
  assert.ok(slow > fast);
  assert.ok(fast >= 8 && slow <= 36);
});

test('matches compact payload identifiers without accepting an arbitrary constellation member', () => {
  assert.ok(scoreSatelliteNameMatch('Sirius SXM-11', 'SXM-11') >= 200);
  assert.ok(scoreSatelliteNameMatch('Starlink Group 17-40', 'STARLINK-1008') < 12);
});

test('finds a newly launched payload in the active TLE fallback catalog', () => {
  const tle = `SXM-11
1 69728U 26148A   26208.65166678  .00000015  00000+0  00000+0 0  9990
2 69728   0.0784 264.9826 0001797 240.4588 273.9506  1.00271527   440`;
  const track = findSatelliteOrbitTrackInTle(tle, 'Sirius SXM-11', {
    launchTime: '2026-06-29T02:25:00Z',
  });
  assert.equal(track?.noradId, 69728);
  assert.equal(track?.name, 'SXM-11');
  assert.ok(track?.orbitPath.length > 100);
  assert.ok(track?.periodSec > 80000);
  assert.ok(track?.current.speedMps > 1000);
  assert.ok(track?.current.speedMps < 12000);
  assert.equal(typeof track?.positionAt, 'function');
});

/** Motor MapLibre falso: registra setData por fonte, voos e o alvo seguido. */
function fakeEngine() {
  const data = new Map();
  const calls = [];
  const engine = {
    data,
    calls,
    trackedTarget: null,
    map: {
      getSource: (id) => ({ setData: (fcData) => data.set(id, fcData) }),
    },
    getCameraView: () => ({ lat: 28.6, lon: -80.6, alt: 18_000_000, heading: 0, pitch: -90, zoom: 1, targetLat: 28.6, targetLon: -80.6 }),
    cameraLookingAt: (target, opts) => ({ ...target, ...opts }),
    flyToCamera: (view, opts) => calls.push(['flyToCamera', view, opts]),
    flyToTarget: (target, opts) => calls.push(['flyToTarget', target, opts]),
    setCameraView: (view) => calls.push(['setCameraView', view]),
    cancelFlight: () => calls.push(['cancelFlight']),
    track: (target) => { engine.trackedTarget = target; calls.push(['track', target]); },
    project: () => ({ x: 100, y: 100, visible: true }),
    on: () => () => {},
  };
  return engine;
}

test('real mission build, select, replay, refresh, deselect, disable and destroy paths draw the expected MapLibre features', async () => {
  const realDocument = globalThis.document;
  const realFetch = globalThis.fetch;
  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.dataset = {};
      this.hidden = false;
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      this.parentElement = null;
    }
    setAttribute() {}
    querySelector() { return { textContent: '' }; }
  }
  const body = new FakeElement('body');
  globalThis.document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: () => null,
  };
  const launchTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let launchName = 'Falcon 9 | Gauntlet Payload';
  const launchPayload = () => ({ results: [{
    id: 'mission-runtime',
    name: launchName,
    net: launchTime,
    status: { name: 'Launch Successful' },
    pad: {
      latitude: '28.608',
      longitude: '-80.604',
      name: 'Space Launch Complex 39A',
    },
    rocket: {
      launcher_stage: [{
        id: 'booster-1',
        type: 'Core',
        landing: {
          attempt: true,
          success: true,
          downrange_distance: 600,
          landing_location: { latitude: '30.1', longitude: '-76.2' },
        },
      }],
    },
    mission: {
      name: 'Gauntlet Payload',
      orbit: { name: 'Low Earth Orbit' },
    },
  }] });
  globalThis.fetch = async (url) => {
    if (url === '/api/celestrak/active') return { ok: true, text: async () => '' };
    assert.equal(url, '/api/launches');
    return { ok: true, json: async () => launchPayload() };
  };
  const engine = fakeEngine();
  const warn = console.warn;
  console.warn = () => {};
  let initialized = false;
  try {
    rocketLaunchesLayer.init(engine);
    initialized = true;
    await rocketLaunchesLayer.enable();
    assert.ok(engine.calls.some(([name, view]) => name === 'flyToCamera' && view.pitch === -90),
      'enabling frames the whole globe from above');
    await rocketLaunchesLayer.update();

    // Overview: one launch marker, labelled, no mission paths (the estimated
    // orbit belongs to the selected view only).
    let features = _missionFeaturesForTest();
    assert.equal(features.sites.features.length, 1);
    const site = features.sites.features[0];
    assert.deepEqual(site.geometry.coordinates, [-80.604, 28.608]);
    assert.equal(site.properties.label, 'FALCON 9');
    assert.equal(site.properties.showLabel, 1);
    assert.equal(site.properties.launchId, 'mission-runtime');
    assert.equal(features.paths.features.length, 0);
    assert.equal(engine.data.get('dg-rocket-sites'), features.sites, 'the drawn collection reaches the MapLibre source');

    _setSelectedRocketMissionForTest('mission-runtime');
    features = _missionFeaturesForTest();
    assert.equal(features.sites.features[0].properties.label, 'FALCON 9\nLAUNCH SITE · 39A');
    const kinds = features.paths.features.map((f) => f.properties.kind).sort();
    assert.deepEqual(kinds, ['orbit-est', 'recovery', 'reentry', 'transfer']);
    for (const line of features.paths.features) {
      assert.ok(line.geometry.coordinates.length > 1);
      for (const [lon, lat] of line.geometry.coordinates) {
        assert.ok(Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90);
      }
      // Unwrapped longitudes: no ±360 jumps between consecutive vertices.
      for (let i = 1; i < line.geometry.coordinates.length; i++) {
        assert.ok(Math.abs(line.geometry.coordinates[i][0] - line.geometry.coordinates[i - 1][0]) < 180);
      }
    }
    const transfer = features.paths.features.find((f) => f.properties.kind === 'transfer');
    const [padLon, padLat] = transfer.geometry.coordinates[0];
    assert.ok(Math.abs(padLon + 80.604) < 1e-6 && Math.abs(padLat - 28.608) < 1e-6, 'the ascent starts at the pad');
    const labels = features.marks.features.filter((f) => f.properties.label).map((f) => f.properties.label.split('\n')[0]);
    assert.deepEqual(labels, ['STAGE RE-ENTRY', 'EST. ORBIT POSITION', 'PROJECTED ORBIT']);
    const payload = features.marks.features.find((f) => f.properties.kind === 'satellite');
    assert.match(payload.properties.label.split('\n')[1], /^\d{4}-\d{2}-\d{2}$/);
    assert.match(payload.properties.label.split('\n')[2], /^\d{2}:\d{2}:\d{2} UTC$/);
    assert.ok(payload.properties.altKm > 300, 'the estimated payload sits on its LEO ring');
    assert.ok(features.marks.features.some((f) => f.properties.kind === 'recovery-end'));

    // Replay: releases other follows, flies to the pad, owns the camera.
    engine.calls.length = 0;
    assert.equal(_startMissionReplayForTest('mission-runtime'), true);
    assert.equal(_replayActiveLaunchForTest(), 'mission-runtime');
    assert.ok(engine.calls.some(([name, target]) => name === 'track' && target === null), 'replay releases the follow camera');
    const replayFlight = engine.calls.find(([name]) => name === 'flyToTarget');
    assert.ok(replayFlight, 'replay flies to the pad');
    assert.ok(Math.abs(replayFlight[1].lat - 28.608) < 1e-6);
    assert.equal(replayFlight[2].rangeM, 3500);
    assert.equal(_missionFeaturesForTest().sites.features[0].properties.showLabel, 0,
      'the replay callout replaces the site label');

    launchName = 'Mission Refresh | Gauntlet Payload';
    await rocketLaunchesLayer.update();
    assert.equal(_replayActiveLaunchForTest(), null, 'a data refresh stops the replay');
    assert.equal(_missionFeaturesForTest().sites.features[0].properties.label, 'MISSION REFRESH\nLAUNCH SITE · 39A');

    _setSelectedRocketMissionForTest(null);
    features = _missionFeaturesForTest();
    assert.equal(features.sites.features[0].properties.label, 'MISSION REFRESH');
    assert.equal(features.paths.features.length, 0);
    assert.equal(features.marks.features.length, 0);

    await rocketLaunchesLayer.disable();
    features = _missionFeaturesForTest();
    assert.equal(features.sites.features.length, 0, 'disable clears the markers');
    assert.equal(engine.data.get('dg-rocket-sites').features.length, 0);
    await rocketLaunchesLayer.destroy();
    initialized = false;
  } finally {
    if (initialized) await rocketLaunchesLayer.destroy();
    console.warn = warn;
    globalThis.fetch = realFetch;
    globalThis.document = realDocument;
  }
});

test('enable is transactional: a failed satellites dependency rolls the module back and a retry recaptures', async (t) => {
  const calls = [];
  let satellitesEnabled = false;
  let failNextActivation = true;
  const fakeManager = {
    isEnabled: (id) => (id === 'satellites' ? satellitesEnabled : false),
    getLayerParams: () => ({}),
    setLayerParams: () => {},
    setEnabled: (id, enabled) => {
      calls.push(['setEnabled', id, enabled]);
      if (id === 'satellites' && enabled && failNextActivation) {
        return Promise.resolve(false); // activation refused/failed
      }
      if (id === 'satellites') satellitesEnabled = enabled;
      return Promise.resolve(true);
    },
  };
  const priorDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  rocketLaunchesLayer.attachDataManager(fakeManager);
  t.after(() => {
    globalThis.document = priorDocument;
    rocketLaunchesLayer.attachDataManager(null);
  });

  // First enable: dependency activation fails -> enable() must reject and the
  // module must roll itself back (satellite snapshot restored AND cleared).
  await assert.rejects(() => rocketLaunchesLayer.enable(), /satellites layer/);
  const restoreCall = calls.filter(([, id, enabled]) => id === 'satellites' && enabled === false);
  assert.ok(restoreCall.length >= 1, 'rollback restored the pre-mission satellites state');

  // Retry with a healthy dependency: capture must run AGAIN (a retained
  // snapshot would skip it) and enable must succeed.
  calls.length = 0;
  failNextActivation = false;
  await rocketLaunchesLayer.enable();
  assert.deepEqual(
    calls.filter(([, id, enabled]) => id === 'satellites' && enabled === true).length >= 1,
    true,
    'retry recaptured the satellites dependency',
  );
  await rocketLaunchesLayer.disable();
});

test('disable reports a semantic failure while restoring the satellites dependency', async (t) => {
  let satellitesEnabled = false;
  let failRestore = false;
  const fakeManager = {
    isEnabled: (id) => (id === 'satellites' ? satellitesEnabled : false),
    isEffectivelyEnabled: (id) => (id === 'satellites' ? satellitesEnabled : false),
    getLayerParams: () => ({}),
    setLayerParams: () => {},
    setEnabled: (id, enabled) => {
      if (id === 'satellites' && !enabled && failRestore) return Promise.resolve(false);
      if (id === 'satellites') satellitesEnabled = enabled;
      return Promise.resolve(true);
    },
  };
  const priorDocument = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  rocketLaunchesLayer.attachDataManager(fakeManager);
  t.after(() => {
    globalThis.document = priorDocument;
    rocketLaunchesLayer.attachDataManager(null);
  });

  await rocketLaunchesLayer.enable();
  failRestore = true;
  await assert.rejects(
    () => rocketLaunchesLayer.disable(),
    /could not restore the satellites layer/,
  );
});

test('a mission matched in the active TLE catalog draws its live, GMST-aligned orbit', async () => {
  const realDocument = globalThis.document;
  const realFetch = globalThis.fetch;
  globalThis.document = {
    body: { appendChild() {} },
    createElement: () => ({
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {},
      setAttribute() {},
      remove() {},
      querySelector: () => ({ textContent: '' }),
    }),
    getElementById: () => null,
  };
  const launchTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const shortYear = String(new Date(launchTime).getUTCFullYear()).slice(2);
  const activeTle = [
    'GAUNTLET-1',
    `1 69728U ${shortYear}148A   26208.65166678  .00000015  00000+0  00000+0 0  9990`,
    '2 69728  53.0000 264.9826 0001797 240.4588 273.9506 15.20000000   440',
  ].join('\n');
  globalThis.fetch = async (url) => {
    if (url === '/api/celestrak/active') return { ok: true, text: async () => activeTle };
    return {
      ok: true,
      json: async () => ({ results: [{
        id: 'live-mission',
        name: 'Falcon 9 | Gauntlet-1',
        net: launchTime,
        status: { name: 'Launch Successful' },
        pad: { latitude: '28.608', longitude: '-80.604', name: 'SLC-40' },
        mission: { name: 'Gauntlet-1', orbit: { name: 'Low Earth Orbit' } },
      }] }),
    };
  };
  const engine = fakeEngine();
  const warn = console.warn;
  console.warn = () => {};
  try {
    rocketLaunchesLayer.init(engine);
    await rocketLaunchesLayer.enable();
    await rocketLaunchesLayer.update();
    // The active catalog arrives asynchronously; the next rebuild uses it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await rocketLaunchesLayer.update();
    assert.equal(rocketLaunchesLayer.getStats().orbitMatches, 1);
    const overview = _missionFeaturesForTest().paths.features;
    assert.deepEqual(overview.map((f) => f.properties.kind), ['orbit'],
      'a real satellite ring shows in the overview, like the Cesium orbit primitive');
    _setSelectedRocketMissionForTest('live-mission');
    const payload = _missionFeaturesForTest().marks.features.find((f) => f.properties.kind === 'satellite');
    assert.equal(payload.properties.label.split('\n')[0], 'GAUNTLET-1');
    assert.equal(payload.properties.estimated, 0);
    assert.ok(payload.properties.altKm > 300 && payload.properties.altKm < 700);
    await rocketLaunchesLayer.disable();
    await rocketLaunchesLayer.destroy();
  } finally {
    console.warn = warn;
    globalThis.fetch = realFetch;
    globalThis.document = realDocument;
  }
});
