import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPHERE_RADIUS_M,
  createHorizonOccluder,
  createWorldProjector,
  ecefToGeodetic,
  geodeticToEcef,
  isWorldPositionLike,
  resolveWorldPosition,
  sphereXyz,
} from './worldGeometry.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const resolved = () => ({ lon: 0, lat: 0, height: 0, x: 0, y: 0, z: 0 });

test('ECEF ↔ geodetic round-trips across latitudes and heights', () => {
  for (const [lon, lat, h] of [[-49.27, -25.43, 900], [0, 0, 0], [139.69, 35.69, 12_000], [10, 89.9, -400], [-120, -70, 35_786_000]]) {
    const ecef = geodeticToEcef(lon, lat, h);
    const back = ecefToGeodetic(ecef.x, ecef.y, ecef.z);
    near(back.lon, lon, 1e-6, 'lon');
    near(back.lat, lat, 1e-6, 'lat'); // Bowring: ~1e-7° even at GEO
    near(back.height, h, 0.05, 'height');
  }
  assert.equal(ecefToGeodetic(0, 0, 0), null);
  assert.equal(ecefToGeodetic(Number.NaN, 0, 0), null);
});

test('resolveWorldPosition accepts lon/lat (with height aliases) and legacy ECEF', () => {
  const out = resolved();
  assert.equal(resolveWorldPosition({ lon: -49.27, lat: -25.43, alt: 1000 }, out), true);
  assert.equal(out.height, 1000);
  const expected = sphereXyz(-49.27, -25.43, 1000);
  near(out.x, expected.x, 1e-6, 'x');
  near(out.z, expected.z, 1e-6, 'z');

  const ecef = geodeticToEcef(-49.27, -25.43, 1000);
  assert.equal(resolveWorldPosition(ecef, out), true);
  near(out.lon, -49.27, 1e-9, 'legacy lon');
  near(out.lat, -25.43, 1e-9, 'legacy lat');
  near(out.height, 1000, 1e-3, 'legacy height');

  assert.equal(resolveWorldPosition({ longitude: 1, latitude: 2 }, out), true);
  assert.equal(out.height, 0);
  for (const bad of [null, {}, { lon: 1 }, { lon: Number.NaN, lat: 0 }, { lon: 0, lat: 0, height: Number.NaN }, { x: 1, y: 2 }]) {
    assert.equal(resolveWorldPosition(bad, out), false, JSON.stringify(bad));
    assert.equal(isWorldPositionLike(bad), false, JSON.stringify(bad));
  }
});

test('the horizon occluder hides the far side of the globe and nothing on a flat map', () => {
  const occluder = createHorizonOccluder();
  const cam = sphereXyz(0, 0, 10_000_000);
  occluder.setCamera(cam.x, cam.y, cam.z);
  const out = resolved();
  occluder.enabled = true;
  resolveWorldPosition({ lon: 10, lat: 5 }, out);
  assert.equal(occluder.isResolvedVisible(out), true, 'near side');
  resolveWorldPosition({ lon: 180, lat: 0 }, out);
  assert.equal(occluder.isResolvedVisible(out), false, 'antipode');
  assert.equal(occluder.isPointVisible({ lon: 180, lat: 0 }), false);
  // A satellite high above the limb stays visible even past the ground horizon.
  assert.equal(occluder.isPointVisible({ lon: 95, lat: 0, height: 40_000_000 }), true);
  occluder.enabled = false;
  assert.equal(occluder.isPointVisible({ lon: 180, lat: 0 }), true, 'flat map: no horizon');
});

test('the projector reads the camera once per frame and projects through the map', () => {
  const calls = [];
  const engine = {
    globe: true,
    getCameraView: () => ({ lon: -49, lat: -25, alt: 2_000_000, heading: 0, pitch: -90, zoom: 4 }),
    isGlobe() { return this.globe; },
    map: { project([lon, lat]) { calls.push([lon, lat]); return { x: lon * 10, y: lat * -10 }; } },
  };
  const projector = createWorldProjector(engine);
  const camera = projector.beginFrame();
  assert.equal(camera.alt, 2_000_000);
  assert.equal(projector.occluder.enabled, true);
  const p = resolved();
  const screen = { x: 0, y: 0 };
  resolveWorldPosition({ lon: -49, lat: -25 }, p);
  assert.equal(projector.project(p, screen), true);
  assert.deepEqual(screen, { x: -490, y: 250 });
  near(projector.distanceTo(p), 2_000_000, 1e-3, 'distance to the ground below the camera');
  resolveWorldPosition({ lon: 131, lat: 25 }, p); // antipode
  assert.equal(projector.project(p, screen), false, 'behind the globe');
  assert.equal(projector.project(p, screen, false), true, 'horizonCull=false projects anyway');
  engine.globe = false;
  projector.beginFrame();
  assert.equal(projector.project(p, screen), true, 'flat map never culls');
  assert.ok(SPHERE_RADIUS_M > 6_300_000);
});
