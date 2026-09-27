import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELESTIAL_PLANE_EPSILON,
  GLOBE_ENTER_CLEARANCE_PX,
  GLOBE_EXIT_CLEARANCE_PX,
  celestialScreenAngle,
  circularAngleDistance,
  earthDiscScreenRadius,
  getKeyholeFadeTuning,
  getKeyholeGeometry,
  isCelestialRingStyleSupported,
  isFullGlobeInsideKeyhole,
  keyholeLabelAlpha,
  normalizeAngle,
  setKeyholeFadeTuning,
} from './celestialRing.js';

function geometry(clearance, offset = 0) {
  const keyholeRadius = 500;
  const earthRadius = keyholeRadius - offset - clearance;
  return {
    earthCenterX: 500 + offset,
    earthCenterY: 500,
    earthRadius,
    keyholeCenterX: 500,
    keyholeCenterY: 500,
    keyholeRadius,
  };
}

test('full globe enters only with the larger clearance', () => {
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_ENTER_CLEARANCE_PX), false), true);
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_ENTER_CLEARANCE_PX - 0.1), false), false);
});

test('visible globe uses the smaller exit clearance for hysteresis', () => {
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_EXIT_CLEARANCE_PX), true), true);
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_EXIT_CLEARANCE_PX - 0.1), true), false);
});

test('off-center globe containment includes center offset', () => {
  const centered = geometry(30, 0);
  const shifted = { ...centered, earthCenterX: centered.earthCenterX + 20 };
  assert.equal(isFullGlobeInsideKeyhole(centered, false), true);
  assert.equal(isFullGlobeInsideKeyhole(shifted, false), false);
});

test('invalid or clipped Earth discs are rejected', () => {
  assert.equal(isFullGlobeInsideKeyhole(null, false), false);
  assert.equal(isFullGlobeInsideKeyhole({ ...geometry(30), earthRadius: -1 }, false), false);
  assert.equal(isFullGlobeInsideKeyhole(geometry(-2), true), false);
});

test('Earth-disc projection radius rejects local and invalid camera geometry', () => {
  const earthRadius = 6_378_137;
  assert.equal(earthDiscScreenRadius(earthRadius, 800, Math.PI / 3), null);
  assert.equal(earthDiscScreenRadius(earthRadius * 2, 0, Math.PI / 3), null);
  assert.equal(earthDiscScreenRadius(earthRadius * 2, 800, 0), null);
  assert.ok(earthDiscScreenRadius(earthRadius * 2, 800, Math.PI / 3) > 0);
});

test('camera-plane projection maps right, up, left, and down to canvas angles', () => {
  assert.ok(Math.abs(celestialScreenAngle(1, 0).angle - 0) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(0, 1).angle - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(-1, 0).angle - Math.PI) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(0, -1).angle - Math.PI * 0.5) < 1e-9);
});

test('unstable camera-axis projection retains the last bearing and fades', () => {
  const last = 1.25;
  const projected = celestialScreenAngle(CELESTIAL_PLANE_EPSILON * 0.2, 0, last);
  assert.equal(projected.stable, false);
  assert.equal(projected.angle, last);
  assert.ok(projected.opacity > 0 && projected.opacity < 1);
});

test('angle normalization wraps both directions', () => {
  assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(Math.PI * 5) - Math.PI) < 1e-9);
});

test('circular angle distance remains small across the wrap point', () => {
  assert.ok(Math.abs(circularAngleDistance(0.04, Math.PI * 2 - 0.03) - 0.07) < 1e-9);
  assert.ok(Math.abs(circularAngleDistance(0, Math.PI) - Math.PI) < 1e-9);
});

test('celestial ring is available only in Normal style', () => {
  assert.equal(isCelestialRingStyleSupported('normal'), true);
  for (const style of ['retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']) {
    assert.equal(isCelestialRingStyleSupported(style), false);
  }
});

test('sun and moon bearings are independent rather than forced opposite', () => {
  const sun = celestialScreenAngle(1, 0).angle;
  const moon = celestialScreenAngle(0.6, -0.8).angle;
  assert.notEqual(normalizeAngle(moon - sun), Math.PI);
});

test('shared keyhole geometry is centered and height-derived', () => {
  const landscape = getKeyholeGeometry(1200, 800);
  const portrait = getKeyholeGeometry(800, 1200);
  assert.equal(landscape.centerX, 600);
  assert.equal(landscape.centerY, 400);
  assert.equal(landscape.radius, 420);
  assert.equal(portrait.centerX, 400);
  assert.equal(portrait.centerY, 600);
  assert.equal(portrait.radius, 630);
});

test('label alpha stays opaque inside and fades monotonically outside', () => {
  setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0 });
  const geometry = getKeyholeGeometry(1200, 800);
  const y = geometry.centerY;
  assert.equal(keyholeLabelAlpha(geometry.centerX, y, 1200, 800), 1);
  assert.equal(keyholeLabelAlpha(geometry.centerX + geometry.radius, y, 1200, 800), 1);
  const quarter = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.25, y, 1200, 800,
  );
  const middle = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.5, y, 1200, 800,
  );
  const threeQuarter = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.75, y, 1200, 800,
  );
  assert.ok(quarter > middle && middle > threeQuarter);
  assert.ok(Math.abs(quarter - 0.75) < 1e-12);
  assert.ok(Math.abs(middle - 0.5) < 1e-12);
  assert.ok(Math.abs(threeQuarter - 0.25) < 1e-12);
  assert.equal(keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx, y, 1200, 800,
  ), 0);
});

test('fade tuning scales with keyhole radius and supports outside opacity', () => {
  setKeyholeFadeTuning({ fadeRatio: 0.2, outsideOpacity: 0.3 });
  const small = getKeyholeGeometry(800, 600);
  const large = getKeyholeGeometry(1600, 1200);
  assert.equal(large.featherPx, small.featherPx * 2);
  assert.deepEqual(getKeyholeFadeTuning(), { fadeRatio: 0.2, outsideOpacity: 0.3 });
  assert.equal(keyholeLabelAlpha(
    small.centerX + small.radius + small.featherPx,
    small.centerY,
    800,
    600,
  ), 0.3);
  setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0.05 });
});

// ── MapLibre port: globe disc, ephemeris and camera axes (no Cesium) ─────────

import {
  cameraScreenAxesFixed,
  globeDiscFromTransform,
  moonDirectionFixed,
  projectEarthDiscToViewport,
  sunDirectionFixed,
  zoomForGlobeDiscRadius,
} from './celestialRing.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('globe disc at nadir is centred and matches the MapLibre globe radius', () => {
  const f = 1200; // cameraToCenterDistance for a 900 px tall viewport, fov ≈ 36.9°
  const worldSize = 512 * 2 ** 1.5;
  const disc = globeDiscFromTransform({ worldSize, centerLat: 0, cameraToCenterDistance: f, pitchDeg: 0, width: 1600, height: 900 });
  assert.equal(disc.earthCenterX, 800);
  assert.equal(disc.earthCenterY, 450);
  const R = worldSize / (2 * Math.PI);
  near(disc.earthRadius, (f * R) / Math.sqrt(f * f + 2 * f * R), 1e-9, 'limb radius');
  assert.ok(disc.earthRadius < R, 'perspective limb is smaller than the equatorial radius');
});

test('pitch pushes the earth centre below the screen centre; bearing never moves it', () => {
  const base = { worldSize: 1024, centerLat: -25, cameraToCenterDistance: 1200, width: 1000, height: 800 };
  const nadir = globeDiscFromTransform({ ...base, pitchDeg: 0 });
  const tilted = globeDiscFromTransform({ ...base, pitchDeg: 40 });
  assert.ok(tilted.earthCenterY > nadir.earthCenterY);
  assert.equal(tilted.earthCenterX, nadir.earthCenterX);
  assert.equal(globeDiscFromTransform({ ...base, worldSize: 0 }), null);
  assert.equal(globeDiscFromTransform({ ...base, width: 0 }), null);
});

test('zoomForGlobeDiscRadius inverts the nadir disc radius', () => {
  const f = 1100;
  for (const lat of [0, -25, 60]) {
    const zoom = zoomForGlobeDiscRadius(290, f, lat);
    const disc = globeDiscFromTransform({ worldSize: 512 * 2 ** zoom, centerLat: lat, cameraToCenterDistance: f, width: 1000, height: 900 });
    near(disc.earthRadius, 290, 1e-6, `lat ${lat}`);
  }
  assert.equal(zoomForGlobeDiscRadius(0, f, 0), null);
});

test('projectEarthDiscToViewport reads a MapLibre engine and adds the keyhole', () => {
  const engine = {
    isGlobe: () => true,
    map: {
      transform: { worldSize: 1024, cameraToCenterDistance: 1200, centerOffset: { x: 0, y: 0 } },
      getCenter: () => ({ lng: -51, lat: -24 }),
      getPitch: () => 0,
    },
  };
  const disc = projectEarthDiscToViewport(engine, 1000, 800);
  assert.equal(disc.keyholeRadius, 400 * 1.05);
  assert.ok(isFullGlobeInsideKeyhole(disc, false), 'a zoom-1 globe fits the keyhole');
  assert.equal(projectEarthDiscToViewport({ ...engine, isGlobe: () => false }, 1000, 800), null, 'flat map has no disc');
});

test('sun direction: March equinox noon UTC points at lon 0 on the equator', () => {
  const sun = sunDirectionFixed(new Date(Date.UTC(2026, 2, 20, 12, 0, 0)));
  near(Math.hypot(sun.x, sun.y, sun.z), 1, 1e-12, 'unit');
  near(sun.x, 1, 0.01, 'x');
  near(Math.asin(sun.z) * 180 / Math.PI, 0, 0.5, 'declination');
  const june = sunDirectionFixed(new Date(Date.UTC(2026, 5, 21, 12, 0, 0)));
  near(Math.asin(june.z) * 180 / Math.PI, 23.44, 0.1, 'June solstice declination');
});

test('moon direction is a unit vector within the lunar declination band', () => {
  for (let d = 0; d < 28; d += 3) {
    const m = moonDirectionFixed(new Date(Date.UTC(2026, 8, 1 + d)));
    near(Math.hypot(m.x, m.y, m.z), 1, 1e-12, 'unit');
    assert.ok(Math.abs(Math.asin(m.z) * 180 / Math.PI) < 29.5);
  }
});

test('camera screen axes are orthonormal; north-up nadir puts up = north', () => {
  const { right, up } = cameraScreenAxesFixed({ lat: 0, lon: 0, bearingDeg: 0, pitchDeg: 0 });
  near(up.z, 1, 1e-12, 'up is north at the equator');
  near(right.y, 1, 1e-12, 'right is east');
  const r2 = cameraScreenAxesFixed({ lat: -24, lon: -51, bearingDeg: 73, pitchDeg: 30 });
  near(r2.right.x * r2.up.x + r2.right.y * r2.up.y + r2.right.z * r2.up.z, 0, 1e-12, 'orthogonal');
  near(Math.hypot(r2.up.x, r2.up.y, r2.up.z), 1, 1e-12, 'unit up');
});

import { cameraAltitudeFromTransform, engineCameraAltitude } from './celestialRing.js';

test('camera altitude falls back to the transform when the engine reports none', () => {
  const t = { worldSize: 512 * 2 ** 9, cameraToCenterDistance: 950, center: { lat: -25 } };
  const alt = cameraAltitudeFromTransform({ worldSize: t.worldSize, centerLat: -25, cameraToCenterDistance: 950 });
  assert.ok(alt > 100_000 && alt < 300_000, `zoom 9 is a regional altitude: ${alt}`);
  const engine = {
    getCameraView: () => ({ alt: NaN }),
    map: { _camera: { transform: t }, getCenter: () => ({ lat: -25 }), getPitch: () => 0 },
  };
  assert.equal(engineCameraAltitude(engine), alt, 'MapLibre 6 keeps the transform in map._camera');
  assert.equal(engineCameraAltitude({ getCameraView: () => ({ alt: 1234 }) }), 1234, 'engine value wins');
});
