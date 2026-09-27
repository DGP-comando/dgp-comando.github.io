import assert from 'node:assert/strict';
import test from 'node:test';

import { mapViewToSceneCamera, sceneCameraToMapView, sphericalDestination } from './sceneCamera.js';

const VIEWPORT = { viewportHeight: 850 };
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('a nadir shot centers under the camera', () => {
  const view = sceneCameraToMapView({ lat: -25.4, lon: -49.3, alt: 10_000, heading: 0, pitch: -90 }, VIEWPORT);
  close(view.center[1], -25.4, 1e-9, 'lat');
  close(view.center[0], -49.3, 1e-9, 'lon');
  assert.equal(view.pitch, 0);
});

test('a far oblique recipe shot hits the globe near the camera, not the pole', () => {
  // Global Flights Radar, shot 1 (19 000 km, 25° off nadir, heading 25).
  const view = sceneCameraToMapView({ lat: 20, lon: -30, alt: 19_000_000, heading: 25, pitch: -65 }, VIEWPORT);
  assert.ok(view.center[1] > 20 && view.center[1] < 55, `lat ${view.center[1]}`);
  assert.ok(view.zoom > 0 && view.zoom < 3, `zoom ${view.zoom}`);
  assert.ok(view.pitch <= 85);
});

test('map view <-> scene camera round-trips at city and globe scale', () => {
  for (const cam of [
    { lat: -25.43, lon: -49.27, alt: 12_000, heading: 30, pitch: -45 },
    { lat: -25.43, lon: -49.27, alt: 900, heading: 200, pitch: -20 },
    { lat: 35.68, lon: 139.76, alt: 900_000, heading: 26, pitch: -38 },
    { lat: 48.8, lon: 2.3, alt: 3_000_000, heading: 32, pitch: -58 },
  ]) {
    const view = sceneCameraToMapView(cam, VIEWPORT);
    const back = mapViewToSceneCamera({
      centerLat: view.center[1], centerLon: view.center[0], zoom: view.zoom, bearing: view.bearing, pitch: view.pitch,
    }, VIEWPORT);
    close(back.lat, cam.lat, 1e-6, 'lat');
    close(back.lon, cam.lon, 1e-6, 'lon');
    close(back.alt, cam.alt, cam.alt * 1e-6, 'alt');
    close(back.pitch, cam.pitch, 1e-6, 'pitch');
    close(back.heading, cam.heading, 1e-6, 'heading');
  }
});

test('sphericalDestination moves ~111 km per degree north', () => {
  const p = sphericalDestination(0, 0, 0, 111_195);
  close(p.lat, 1, 1e-3, 'lat');
  close(p.lon, 0, 1e-9, 'lon');
});
