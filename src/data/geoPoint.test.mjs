import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geoPoint, toGeoPoint, geoDistanceM } from './geoPoint.js';

test('geoPoint carries degrees and WGS84 ECEF for the same place', () => {
  const p = geoPoint(0, 0, 0);
  assert.equal(p.lon, 0);
  assert.ok(Math.abs(p.x - 6_378_137) < 1e-6);
  assert.ok(Math.abs(p.y) < 1e-6 && Math.abs(p.z) < 1e-6);
  const pole = geoPoint(10, 90, 0);
  assert.ok(Math.abs(pole.z - 6_356_752.314) < 0.01);
  assert.ok(Object.isFrozen(p));
  assert.equal(geoPoint('x', 1), null);
  assert.equal(geoPoint(1, 91), null);
});

test('toGeoPoint round-trips ECEF (legacy Cartesian3) and lon/lat shapes', () => {
  const p = geoPoint(-48.5, -25.5, 120);
  const back = toGeoPoint({ x: p.x, y: p.y, z: p.z });
  assert.ok(Math.abs(back.lon - p.lon) < 1e-9);
  assert.ok(Math.abs(back.lat - p.lat) < 1e-9);
  assert.ok(Math.abs(back.height - 120) < 1e-3);
  assert.equal(toGeoPoint({ longitude: 1, latitude: 2 }).lat, 2);
  assert.equal(toGeoPoint({ lon: 1, lat: 2, alt: 5 }).height, 5);
  assert.equal(toGeoPoint(null), null);
  assert.equal(toGeoPoint({}), null);
});

test('geoDistanceM is the straight-line distance, whatever the input shape', () => {
  const a = geoPoint(-48.5, -25.5, 0);
  const b = geoPoint(-48.5, -25.4, 0);
  const d = geoDistanceM(a, { lon: -48.5, lat: -25.4 });
  assert.ok(Math.abs(d - 11_070) < 30, `~11 km per 0.1° lat, got ${d}`);
  assert.equal(geoDistanceM(a, { x: b.x, y: b.y, z: b.z }), d);
  assert.ok(Number.isNaN(geoDistanceM(a, null)));
});
