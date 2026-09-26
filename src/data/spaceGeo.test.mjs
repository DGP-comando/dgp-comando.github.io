import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WGS84_A,
  cartesianFromDegrees,
  geodeticFromCartesian,
  interpolateGreatCircle,
  negativePiToPi,
  pathToLonLat,
  surfaceDistance,
  zeroToTwoPi,
} from './spaceGeo.js';

test('ECEF and geodetic conversions round-trip from the ground to GEO', () => {
  for (const [lon, lat, h] of [[0, 0, 0], [-49.27, -25.43, 900], [139.7, 35.7, 420_000], [-80.6, 28.6, 35_786_000], [10, 89.9, 1000]]) {
    const g = geodeticFromCartesian(cartesianFromDegrees(lon, lat, h));
    assert.ok(Math.abs(g.lon - lon) < 1e-9, `lon ${lon}`);
    assert.ok(Math.abs(g.lat - lat) < 1e-9, `lat ${lat}`);
    assert.ok(Math.abs(g.height - h) < 1e-3, `height ${h}: ${g.height}`);
  }
  assert.ok(Math.abs(cartesianFromDegrees(0, 0, 0).x - WGS84_A) < 1e-6);
});

test('great-circle helpers match known distances', () => {
  const d = surfaceDistance({ lon: 0, lat: 0 }, { lon: 90, lat: 0 });
  assert.ok(Math.abs(d - 10_007_543) < 5_000);
  const mid = interpolateGreatCircle({ lon: 0, lat: 0 }, { lon: 90, lat: 0 }, 0.5);
  assert.ok(Math.abs(mid.lon - 45) < 1e-9 && Math.abs(mid.lat) < 1e-9);
});

test('angle wrapping follows the Cesium conventions', () => {
  assert.equal(zeroToTwoPi(0.5), 0.5);
  assert.ok(Math.abs(zeroToTwoPi(-0.5) - (2 * Math.PI - 0.5)) < 1e-12);
  assert.ok(Math.abs(negativePiToPi(3 * Math.PI / 2) + Math.PI / 2) < 1e-12);
});

test('paths crossing the antimeridian stay continuous for MapLibre', () => {
  const path = [170, 175, 179.5, -179.5, -175].map((lon) => cartesianFromDegrees(lon, 10, 400_000));
  const coords = pathToLonLat(path);
  for (let i = 1; i < coords.length; i++) assert.ok(Math.abs(coords[i][0] - coords[i - 1][0]) < 10);
  assert.ok(coords.at(-1)[0] > 180, 'unwrapped past +180 instead of jumping to -175');
  const shifted = pathToLonLat(path.slice(0, 1), { lonShiftDeg: -2.5 });
  assert.ok(Math.abs(shifted[0][0] - 167.5) < 1e-9);
});
