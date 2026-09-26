// src/data/cctvViewshed.test.mjs — viewshed hue assignment + frustum volume
// geometry documented in docs/CURRENT-STATE.md.
//
// Locks:
//   - cameraHue is golden-angle spaced and deterministic (color identity is
//     stable across sessions for a stable catalog);
//   - nearby catalog indices get well-separated hues (the whole point: a local
//     cluster of neighbor cameras must be tellable-apart);
//   - frustumVolumeGeometryData is welded BY CONSTRUCTION to the wireframe:
//     its 5 vertices are exactly the caller's frustumCartesians positions and
//     its 18 indices only reference those 5 vertices (4 side faces + 2 cap
//     triangles) — no independent geometry recompute anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraHue,
  viewshedColors,
  frustumVolumeGeometryData,
  groundFootprint,
  groundFootprintExtent,
  offsetLatLon,
} from './cctvViewshed.js';

/** Parses `rgba(r,g,b,a)` into numbers. */
function parseRgba(css) {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(css);
  assert.ok(m, `not an rgba() string: ${css}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) };
}
const c3 = (x, y, z) => ({ x, y, z });

const GOLDEN_ANGLE = 137.50776405003785;

function circularDeltaDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

test('cameraHue: deterministic golden-angle spacing in [0, 360)', () => {
  assert.equal(cameraHue(0), 0);
  assert.ok(Math.abs(cameraHue(1) - GOLDEN_ANGLE) < 1e-9);
  for (let i = 0; i < 300; i++) {
    const hue = cameraHue(i);
    assert.ok(hue >= 0 && hue < 360, `hue ${hue} out of range at index ${i}`);
    assert.equal(hue, cameraHue(i), 'must be pure/deterministic');
  }
});

// NB: 20 points on a 360° wheel cap the best-possible min pairwise gap at 18°
// (pigeonhole), so "≥20°" is unachievable for any assignment. Golden-angle
// gives 12.4° min over the first 20 (measured) — assert ≥12° so a regression
// to a worse spacing scheme (e.g. raw id-hash clustering) fails loudly, and
// separately assert CONSECUTIVE indices (the likeliest co-visible neighbors)
// stay far apart.
test('cameraHue: first 20 indices pairwise separated by >= 12 degrees', () => {
  const hues = Array.from({ length: 20 }, (_, i) => cameraHue(i));
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const delta = circularDeltaDeg(hues[i], hues[j]);
      assert.ok(delta >= 12, `hue(${i})=${hues[i].toFixed(1)} vs hue(${j})=${hues[j].toFixed(1)} only ${delta.toFixed(1)}° apart`);
    }
  }
});

test('cameraHue: consecutive indices separated by >= 80 degrees', () => {
  for (let i = 0; i < 40; i++) {
    const delta = circularDeltaDeg(cameraHue(i), cameraHue(i + 1));
    assert.ok(delta >= 80, `consecutive hues ${i}/${i + 1} only ${delta.toFixed(1)}° apart`);
  }
});

test('viewshedColors: CSS fill/line pairs with the designed alphas (MapLibre paint)', () => {
  const colors = viewshedColors(210);
  const fill = parseRgba(colors.fill);
  const fillActive = parseRgba(colors.fillActive);
  const line = parseRgba(colors.line);
  const lineActive = parseRgba(colors.lineActive);
  assert.ok(Math.abs(fill.a - 0.12) < 1e-6);
  assert.ok(Math.abs(fillActive.a - 0.22) < 1e-6);
  assert.ok(Math.abs(line.a - 0.85) < 1e-6);
  assert.ok(Math.abs(lineActive.a - 1.0) < 1e-6);
  // Same hue family: fill and line of the same hue must not be gray.
  assert.ok(line.r !== line.g || line.g !== line.b);
  // Hue 210 is a blue: blue channel dominates.
  assert.ok(line.b > line.r && line.b > line.g);
  assert.equal(colors.hue, 210);
});

/** Minimal frustumCartesians-shaped fixture. */
function positionsFixture() {
  return {
    mount: c3(1000, 2000, 3000),
    tl: c3(1100, 2100, 3050),
    tr: c3(1200, 2050, 3050),
    br: c3(1200, 2050, 2950),
    bl: c3(1100, 2100, 2950),
  };
}

test('frustumVolumeGeometryData: 5 vertices are exactly the input Cartesians', () => {
  const positions = positionsFixture();
  const { positions: flat, indices } = frustumVolumeGeometryData(positions);
  assert.equal(flat.length, 15);
  assert.equal(indices.length, 18);
  const order = [positions.mount, positions.tl, positions.tr, positions.br, positions.bl];
  order.forEach((p, i) => {
    assert.equal(flat[i * 3], p.x);
    assert.equal(flat[i * 3 + 1], p.y);
    assert.equal(flat[i * 3 + 2], p.z);
  });
});

test('frustumVolumeGeometryData: indices form 4 side faces + 2 cap triangles over the 5 vertices', () => {
  const { indices } = frustumVolumeGeometryData(positionsFixture());
  const counts = new Map();
  for (const idx of indices) {
    assert.ok(idx >= 0 && idx <= 4, `index ${idx} out of vertex range`);
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }
  // Apex (0) appears in exactly the 4 side triangles; every corner in >= 2.
  assert.equal(counts.get(0), 4, 'apex must appear in exactly 4 side triangles');
  for (const corner of [1, 2, 3, 4]) {
    assert.ok(counts.get(corner) >= 2, `corner ${corner} underused`);
  }
  // 6 triangles, none degenerate (three distinct vertices each).
  for (let t = 0; t < indices.length; t += 3) {
    const tri = new Set([indices[t], indices[t + 1], indices[t + 2]]);
    assert.equal(tri.size, 3, `triangle at ${t} is degenerate`);
  }
});

test('frustumVolumeGeometryData: no NaN for a tight (probe-clamped) pyramid', () => {
  const near = {
    mount: c3(0, 0, 0),
    tl: c3(12, 1, 1),
    tr: c3(12, -1, 1),
    br: c3(12, -1, -1),
    bl: c3(12, 1, -1),
  };
  const { positions: flat } = frustumVolumeGeometryData(near);
  for (const v of flat) assert.ok(Number.isFinite(v));
});

// ─── Ground footprint (the MapLibre stand-in for the 3D volume) ─────────────

const CAM = {
  lat: -25.43,
  lon: -49.27,
  headingDeg: 90,
  pitchDeg: -18,
  fovDeg: 60,
  rangeM: 400,
  mountHeightM: 10,
};

test('groundFootprintExtent: bottom and top rays meet flat ground in order, capped by range', () => {
  const ext = groundFootprintExtent(CAM);
  const vFov = 2 * Math.atan(Math.tan((60 * Math.PI) / 360) / (16 / 9)) * (180 / Math.PI);
  assert.ok(Math.abs(ext.vFovDeg - vFov) < 1e-9);
  const expectNear = 10 / Math.tan(((18 + vFov / 2) * Math.PI) / 180);
  const expectFar = Math.min(400, 10 / Math.tan(((18 - vFov / 2) * Math.PI) / 180));
  assert.ok(Math.abs(ext.nearM - expectNear) < 1e-6, `near ${ext.nearM}`);
  assert.ok(Math.abs(ext.farM - expectFar) < 1e-6, `far ${ext.farM}`);
  assert.ok(ext.nearM < ext.farM);
  assert.equal(ext.halfAngleDeg, 30);
});

test('groundFootprintExtent: a top ray at/above the horizon reaches the range; override only shortens', () => {
  const level = groundFootprintExtent({ ...CAM, pitchDeg: -2 });
  assert.equal(level.farM, 400);
  assert.equal(groundFootprintExtent({ ...CAM, pitchDeg: -2 }, 150).farM, 150);
  assert.equal(groundFootprintExtent({ ...CAM, pitchDeg: -2 }, 5000).farM, 400);
  const skyward = groundFootprintExtent({ ...CAM, pitchDeg: 20 });
  assert.equal(skyward.nearM, 0, 'no downward bottom ray → footprint starts at the mount');
  assert.equal(skyward.farM, 400);
});

test('groundFootprint: closed ring symmetric about the heading, axis end at the far edge', () => {
  const fp = groundFootprint(CAM, { segments: 8 });
  assert.ok(fp);
  assert.deepEqual(fp.ring[0], fp.ring.at(-1), 'ring must be closed');
  assert.equal(fp.ring.length, 2 * (8 + 1) + 1);
  const expected = offsetLatLon(CAM.lat, CAM.lon, 90, fp.farM);
  assert.ok(Math.abs(fp.axisEnd.lat - expected.lat) < 1e-12);
  assert.ok(Math.abs(fp.axisEnd.lon - expected.lon) < 1e-12);
  // Heading 90° (east): the footprint lies east of the mount and is
  // mirror-symmetric in latitude about it.
  for (const [lon] of fp.ring) assert.ok(lon > CAM.lon);
  const lats = fp.ring.slice(0, -1).map(([, lat]) => lat - CAM.lat);
  assert.ok(Math.abs(Math.max(...lats) + Math.min(...lats)) < 1e-6);
});

test('groundFootprint: apex at the mount when the near edge collapses, null without coordinates', () => {
  const fp = groundFootprint({ ...CAM, pitchDeg: 25 });
  assert.deepEqual(fp.ring[0], [CAM.lon, CAM.lat]);
  assert.equal(groundFootprint({ ...CAM, lat: NaN }), null);
});
