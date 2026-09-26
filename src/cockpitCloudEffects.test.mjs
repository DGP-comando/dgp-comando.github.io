import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cockpitCameraPoint,
  cockpitCloudRenderSize,
  cockpitWeatherRefreshDue,
  cockpitWeatherEnabledFromStoredValue,
} from './cockpitCloudEffects.js';

test('cockpit cloud framebuffer stays low resolution on large displays', () => {
  assert.deepEqual(cockpitCloudRenderSize(2048, 1152), { width: 520, height: 293 });
  assert.deepEqual(cockpitCloudRenderSize(1280, 720), { width: 520, height: 293 });
});

test('cockpit cloud framebuffer never upscales or collapses to zero', () => {
  assert.deepEqual(cockpitCloudRenderSize(640, 360), { width: 269, height: 151 });
  assert.deepEqual(cockpitCloudRenderSize(0, Number.NaN), { width: 1, height: 1 });
});

test('cockpit weather defaults off and enables only from an explicit saved opt-in', () => {
  assert.equal(cockpitWeatherEnabledFromStoredValue(null), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue(''), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue('0'), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue('1'), true);
});

test('cockpit weather refreshes after time or meaningful movement', () => {
  const anchor = { latitude: 30, longitude: -97 };
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 1000,
    fetchedAt: 500,
    anchor,
    point: anchor,
    hasWeather: false,
  }), true);
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 60_000,
    fetchedAt: 0,
    anchor,
    point: { latitude: 30.01, longitude: -97 },
    hasWeather: true,
  }), false);
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 5 * 60_000,
    fetchedAt: 0,
    anchor,
    point: anchor,
    hasWeather: true,
  }), true);
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 60_000,
    fetchedAt: 0,
    anchor,
    point: { latitude: 30.3, longitude: -97 },
    hasWeather: true,
  }), true);
});

test('cockpit weather point comes from the MapLibre engine camera', () => {
  const engine = { getCameraView: () => ({ lat: -25.4, lon: -49.3, alt: 3200, heading: 0, pitch: -8 }) };
  assert.deepEqual(cockpitCameraPoint(engine), { latitude: -25.4, longitude: -49.3, altitudeM: 3200 });
  assert.deepEqual(
    cockpitCameraPoint({ getCameraView: () => ({ lat: 1, lon: 2, alt: NaN }) }),
    { latitude: 1, longitude: 2, altitudeM: 0 },
  );
  assert.equal(cockpitCameraPoint(null), null);
  assert.equal(cockpitCameraPoint({ getCameraView: () => { throw new Error('not ready'); } }), null);
});
