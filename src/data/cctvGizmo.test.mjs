// src/data/cctvGizmo.test.mjs — pure drag math for the CCTV calibration gizmo
// documented in docs/CURRENT-STATE.md.
//
// Locks:
//   - closestParamOnAxis returns the metre-parameter along the AXIS of the
//     point nearest the mouse ray (the workhorse for arrow/range drags), and
//     refuses near-parallel configurations instead of exploding;
//   - rayPlaneIntersect refuses grazing rays (|dir·normal| < 0.08 — spec §5
//     precision guard) and behind-origin hits;
//   - ringAngle/signedAngleDelta give quadrant-correct, wrap-safe angles for
//     the heading/pitch ring drags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aimDistanceM,
  aimPatchFor,
  bearingDeg,
  closestParamOnAxis,
  localDistanceM,
  mountOffsetsForPosition,
  rayPlaneIntersect,
  ringAngle,
  signedAngleDelta,
} from './cctvGizmo.js';

// Plain {x, y, z} vectors (the MapLibre port dropped Cesium.Cartesian3).
const c3 = (x, y, z) => ({ x, y, z });
const norm = (v) => {
  const m = Math.hypot(v.x, v.y, v.z);
  return c3(v.x / m, v.y / m, v.z / m);
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('closestParamOnAxis: perpendicular ray hits the axis at its own offset', () => {
  // Axis along +X from origin. Ray shooting straight down (-Z) from (10, 0, 5):
  // nearest axis point is x=10 → t=10.
  const t = closestParamOnAxis(c3(10, 0, 5), c3(0, 0, -1), c3(0, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 10) < 1e-9, `expected 10, got ${t}`);
});

test('closestParamOnAxis: skew ray resolves to the geometric closest point', () => {
  // Axis +X. Ray from (0, 10, 0) toward (1, -1, 0)/√2 passes closest to the
  // axis around x=10 (it reaches y=0 at x=10).
  const dir = norm(c3(1, -1, 0));
  const t = closestParamOnAxis(c3(0, 10, 0), dir, c3(0, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 10) < 1e-6, `expected ~10, got ${t}`);
});

test('closestParamOnAxis: axis origin offset shifts the parameter', () => {
  const t = closestParamOnAxis(c3(10, 0, 5), c3(0, 0, -1), c3(4, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 6) < 1e-9, `expected 6, got ${t}`);
});

test('closestParamOnAxis: near-parallel ray/axis returns null', () => {
  assert.equal(closestParamOnAxis(c3(0, 1, 0), c3(1, 0, 0), c3(0, 0, 0), c3(1, 0, 0)), null);
  const nearly = norm(c3(1, 1e-9, 0));
  assert.equal(closestParamOnAxis(c3(0, 1, 0), nearly, c3(0, 0, 0), c3(1, 0, 0)), null);
});

test('rayPlaneIntersect: straight-on hit lands at the expected point', () => {
  const hit = rayPlaneIntersect(c3(0, 0, 10), c3(0, 0, -1), c3(0, 0, 0), c3(0, 0, 1));
  assert.ok(hit, 'expected a hit');
  assert.ok(dist(hit, c3(0, 0, 0)) < 1e-9);
});

test('rayPlaneIntersect: oblique hit resolves correctly', () => {
  const dir = norm(c3(1, 0, -1));
  const hit = rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1));
  assert.ok(hit);
  assert.ok(dist(hit, c3(5, 0, 0)) < 1e-9, `got ${hit}`);
});

test('rayPlaneIntersect: grazing ray (|dir·n| < 0.08) returns null', () => {
  // dir almost in-plane: z component 0.05 < 0.08 threshold.
  const dir = norm(c3(1, 0, -0.05));
  assert.equal(rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1)), null);
});

test('rayPlaneIntersect: plane behind the ray origin returns null', () => {
  assert.equal(rayPlaneIntersect(c3(0, 0, 10), c3(0, 0, 1), c3(0, 0, 0), c3(0, 0, 1)), null);
});

test('ringAngle: quadrant sweep in the (basisA, basisB) frame', () => {
  const center = c3(0, 0, 0);
  const a = c3(1, 0, 0);
  const b = c3(0, 1, 0);
  assert.ok(Math.abs(ringAngle(c3(5, 0, 0), center, a, b) - 0) < 1e-9);
  assert.ok(Math.abs(ringAngle(c3(0, 5, 0), center, a, b) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(ringAngle(c3(-5, 0, 0), center, a, b)) - Math.PI) < 1e-9);
  assert.ok(Math.abs(ringAngle(c3(0, -5, 0), center, a, b) + Math.PI / 2) < 1e-9);
});

test('signedAngleDelta: shortest-path wrap', () => {
  const d2r = (d) => (d * Math.PI) / 180;
  assert.ok(Math.abs(signedAngleDelta(d2r(170), d2r(-170)) - d2r(20)) < 1e-9);
  assert.ok(Math.abs(signedAngleDelta(d2r(-170), d2r(170)) - d2r(-20)) < 1e-9);
  assert.ok(Math.abs(signedAngleDelta(d2r(10), d2r(30)) - d2r(20)) < 1e-9);
});

// ─── 2D gizmo helpers (MapLibre: base + aim markers) ───────────────────────

test('bearingDeg: cardinal directions', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 1e-9);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 1e-9);
  assert.ok(Math.abs(bearingDeg(0, 0, -1, 0) - 180) < 1e-9);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, -1) - 270) < 1e-9);
});

test('mountOffsetsForPosition inverts cctv.js offsetDegrees (111 320 m/deg, cos floor)', () => {
  const base = { lat: -25.43, lon: -49.27 };
  const north = 120;
  const east = -75;
  const lat = base.lat + north / 111320;
  const lon = base.lon + east / (111320 * Math.max(0.15, Math.cos((base.lat * Math.PI) / 180)));
  const out = mountOffsetsForPosition(base, lat, lon);
  assert.ok(Math.abs(out.offsetNorthM - north) < 1e-6);
  assert.ok(Math.abs(out.offsetEastM - east) < 1e-6);
});

test('aimPatchFor: heading follows the mount→aim bearing, range scales with distance', () => {
  const camera = { lat: -25.43, lon: -49.27, pitchDeg: -20 };
  const basePose = { headingDeg: 350, rangeM: 300 };
  const reach = aimDistanceM(basePose.rangeM, camera.pitchDeg);
  // Aim due east at twice the base horizontal reach.
  const aimLon = camera.lon + (2 * reach) / (111320 * Math.cos((camera.lat * Math.PI) / 180));
  const patch = aimPatchFor({ basePose, camera, aimLat: camera.lat, aimLon });
  assert.ok(Math.abs(patch.headingDeg - 100) < 0.01, `heading offset ${patch.headingDeg}`);
  assert.ok(Math.abs(patch.rangeScale - 2) < 0.01, `rangeScale ${patch.rangeScale}`);
  assert.ok(Math.abs(localDistanceM(0, 0, 0, 0)) < 1e-12);
});
