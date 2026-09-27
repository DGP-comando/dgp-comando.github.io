import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPickedGeoPosition, isPickedWorldPosition } from './scenePick.js';
import { ecefToGeodetic, geodeticToEcef } from '../overlays/worldGeometry.js';

// Neutral stand-ins for the old Cesium helpers (the app no longer ships Cesium).
const Cesium = {
  Cartesian3: Object.assign(function Cartesian3(x, y, z) { return { x, y, z }; }, {
    fromDegrees: (lon, lat, h = 0) => geodeticToEcef(lon, lat, h),
    magnitude: (p) => Math.hypot(p.x, p.y, p.z),
  }),
};
const toCartographic = (p) => ecefToGeodetic(p.x, p.y, p.z);

const describe = (position) => (position
  ? `(${position.x}, ${position.y}, ${position.z})`
  : String(position));

test('a degenerate depth pick is rejected before it reaches Cesium', () => {
  // These are the shapes `scene.pickPosition()` can produce when the depth read
  // over empty sky is meaningless. Each one is a MISSED pick, not a place.
  const degenerate = [
    null,
    undefined,
    Cesium.Cartesian3(Number.NaN, Number.NaN, Number.NaN),
    Cesium.Cartesian3(0, 0, 0),
    Cesium.Cartesian3(Number.POSITIVE_INFINITY, 0, 0),
    Cesium.Cartesian3(0, Number.NEGATIVE_INFINITY, 0),
    Cesium.Cartesian3(1, Number.NaN, 1),
    Cesium.Cartesian3(0.2, -0.3, 0.1),
  ];
  for (const position of degenerate) {
    assert.equal(isPickedWorldPosition(position), false, `must reject ${describe(position)}`);
  }
});

test('the guard is an Earth-sized band, not just a non-zero check', () => {
  // Finiteness alone is not validation. A pick has to land in the shell the
  // Earth actually occupies, because the values BETWEEN "zero" and "the globe"
  // are the ones that fail quietly.
  const belowTheFloor = [
    // the regression probe: finite, non-zero, and 6,378 km underground. A bare
    // non-zero check accepts it, and the shipped path then reverse-geocodes
    // 0°, 0° as if the operator were looking at the Gulf of Guinea.
    Cesium.Cartesian3(500, 0, 0),
    Cesium.Cartesian3(0, 1_000_000, 0),
    Cesium.Cartesian3(0, 0, 5_999_999),
  ];
  for (const position of belowTheFloor) {
    assert.equal(isPickedWorldPosition(position), false, `must reject ${describe(position)}`);
    // Each one converts WITHOUT complaint — that is exactly what makes it dangerous.
    const carto = toCartographic(position);
    assert.ok(carto, `${describe(position)} converts without complaint`);
    assert.ok(carto.height < -300_000, 'and puts the "target" hundreds of km underground');
  }

  const aboveTheCeiling = [
    Cesium.Cartesian3(1_000_000_001, 0, 0),
    Cesium.Cartesian3(0, 1e12, 0),
    // Large enough to overflow Cesium's geodetic iteration into NaN.
    Cesium.Cartesian3(1e155, 0, 0),
  ];
  for (const position of aboveTheCeiling) {
    assert.equal(isPickedWorldPosition(position), false, `must reject ${describe(position)}`);
  }

  // Both edges of the band are inclusive, and both are real magnitudes.
  assert.equal(isPickedWorldPosition(Cesium.Cartesian3(6_000_000, 0, 0)), true);
  assert.equal(isPickedWorldPosition(Cesium.Cartesian3(1_000_000_000, 0, 0)), true);
});

test('a real picked position is accepted', () => {
  const real = [
    // Ground, a cruising airliner, and the deepest surface point on the globe.
    Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0),
    Cesium.Cartesian3.fromDegrees(139.6917, 35.6895, 12_000),
    Cesium.Cartesian3.fromDegrees(0, -89.9, -400),
    Cesium.Cartesian3.fromDegrees(142.2, 11.35, -10_935),
    // A tall structure: pickPosition returns the mesh, not the terrain.
    Cesium.Cartesian3.fromDegrees(55.2744, 25.1972, 828),
    // The polar surface is the smallest magnitude the globe can produce.
    Cesium.Cartesian3.fromDegrees(0, 90, 0),
    // Satellites are real contacts too, up to geostationary.
    Cesium.Cartesian3.fromDegrees(0, 0, 550_000),
    Cesium.Cartesian3.fromDegrees(0, 0, 35_786_000),
  ];
  for (const position of real) {
    assert.equal(isPickedWorldPosition(position), true, `must accept ${describe(position)}`);
  }

  // The floor has real margin under the smallest legitimate magnitude, so no
  // plausible pick sits anywhere near the boundary.
  const polarSurface = Cesium.Cartesian3.magnitude(Cesium.Cartesian3.fromDegrees(0, 90, -10_935));
  assert.ok(polarSurface > 6_300_000, `smallest real magnitude was ${polarSurface}`);
});

test('degenerate picks are rejected and accepted ones convert to the right place', () => {
  for (const position of [
    Cesium.Cartesian3(Number.NaN, Number.NaN, Number.NaN),
    Cesium.Cartesian3(Number.POSITIVE_INFINITY, 0, 0),
    Cesium.Cartesian3(1, Number.NaN, 1),
    Cesium.Cartesian3(0, 0, 0),
    Cesium.Cartesian3(0.2, -0.3, 0.1),
  ]) {
    assert.equal(isPickedWorldPosition(position), false);
  }
  const accepted = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 250);
  assert.equal(isPickedWorldPosition(accepted), true);
  const carto = toCartographic(accepted);
  assert.ok(Math.abs(carto.lon + 97.7431) < 1e-6);
  assert.ok(Math.abs(carto.lat - 30.2672) < 1e-6);
  assert.ok(Math.abs(carto.height - 250) < 1e-3);
});

test('MapLibre unproject results are validated as lon/lat', () => {
  assert.equal(isPickedGeoPosition({ lon: -49.27, lat: -25.43 }), true);
  assert.equal(isPickedGeoPosition({ lon: 400, lat: 10 }), true, 'unwrapped world copy');
  for (const bad of [null, undefined, {}, { lon: Number.NaN, lat: 0 }, { lon: 0, lat: 91 }, { lon: 999, lat: 0 }]) {
    assert.equal(isPickedGeoPosition(bad), false, JSON.stringify(bad));
  }
});
