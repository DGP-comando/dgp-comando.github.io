import test from 'node:test';
const v = (x, y, z) => ({ x, y, z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const mag = (a) => Math.hypot(a.x, a.y, a.z);
import assert from 'node:assert/strict';
import {
  applyTrackedCameraFrame,
  viewFromToOrbit,
  clampTrackedCameraPosition,
  trackedDisplayPositionForCamera,
  trackedModelScaleForPixelCap,
} from './trackedCamera.js';

test('tracked camera origin crossing returns to the prior side at the minimum range', () => {
  const camera = {
    position: v(0, 500, -300),
    direction: v(0, -1, 0),
  };
  const previous = v(0, -1000, 600);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(dot(camera.position, previous) > 0);
  assert.ok(Math.abs(mag(camera.position) - 150) < 1e-9);
});

test('tracked camera clamps a too-close approach along the current sight line', () => {
  const camera = {
    position: v(0, -80, 0),
    direction: v(0, 1, 0),
  };
  const previous = v(0, -200, 0);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Math.abs(camera.position.x) === 0);
  assert.equal(camera.position.y, -150);
  assert.ok(Math.abs(camera.position.z) === 0);
});

test('tracked camera leaves a safe approach unchanged', () => {
  const camera = {
    position: v(0, -800, 500),
    direction: v(0, 800 / Math.hypot(800, 500), -500 / Math.hypot(800, 500)),
  };
  const previous = { ...camera.position };
  const before = { ...camera.position };
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), false);
  assert.deepEqual(camera.position, before);
});

test('tracked model keeps calibrated scale when it projects below the pixel cap', () => {
  const scale = trackedModelScaleForPixelCap({
    baseScale: 24,
    nativeRadiusM: 1.43,
    rangeM: 1000,
    viewportHeightPx: 800,
    fovyRad: Math.PI / 3,
    maximumPixelSize: 104,
  });
  assert.equal(scale, 24);
});

test('tracked model shrinks smoothly when close enough to exceed the pixel cap', () => {
  const scale = trackedModelScaleForPixelCap({
    baseScale: 24,
    nativeRadiusM: 1.43,
    rangeM: 150,
    viewportHeightPx: 800,
    fovyRad: Math.PI / 3,
    maximumPixelSize: 104,
  });
  const focalLengthPx = 800 / (2 * Math.tan(Math.PI / 6));
  const projectedDiameterPx = (2 * 1.43 * scale * focalLengthPx) / 150;
  assert.ok(scale < 24);
  assert.ok(Math.abs(projectedDiameterPx - 104) < 1e-9);
});

test('tracked camera prefers the already-rendered display cache', () => {
  let callbackReads = 0;
  const cached = { lon: 1, lat: 2, alt: 3 };
  const entity = {
    gevDisplayPosition: () => cached,
    position: {
      getValue: () => {
        callbackReads += 1;
        return { lon: 4, lat: 5, alt: 6 };
      },
    },
  };
  const result = trackedDisplayPositionForCamera(entity, Date.now(), {});
  assert.deepEqual(result, cached);
  assert.notEqual(result, cached);
  assert.equal(callbackReads, 0);
});

test('viewFrom (ENU offset) becomes an orbit looking back at the target', () => {
  const o = viewFromToOrbit(v(0, -1000, 1000));
  assert.ok(Math.abs(o.rangeM - Math.hypot(1000, 1000)) < 1e-9);
  assert.ok(Math.abs(o.heading) < 1e-9 || Math.abs(o.heading - 360) < 1e-9); // câmera ao sul olha para o norte
  assert.ok(Math.abs(o.pitch + 45) < 1e-9);
  assert.equal(viewFromToOrbit(v(0, 0, 0)), null);
  assert.equal(viewFromToOrbit({ rangeM: 10 }).rangeM, 150);
});

test('applyTrackedCameraFrame hands following to engine.track and frames once', () => {
  const calls = [];
  const engine = {
    trackedTarget: null,
    track(t) { this.trackedTarget = t; calls.push(['track', t]); },
    cameraLookingAt(target, orbit) { return { ...target, ...orbit }; },
    flyToCamera(view, opts) { calls.push(['fly', view, opts]); },
    setCameraView(view) { calls.push(['jump', view]); },
    cancelFlight() {},
  };
  const target = { getPosition: () => ({ lon: -49, lat: -25, alt: 3000 }) };
  const stop = applyTrackedCameraFrame(engine, target, v(0, -500, 500), { duration: 0 });
  assert.equal(engine.trackedTarget, target);
  assert.equal(calls[1][0], 'jump');
  assert.equal(calls[1][1].height, 3000);
  assert.equal(typeof stop, 'function');
});
