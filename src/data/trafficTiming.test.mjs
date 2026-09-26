// src/data/trafficTiming.test.mjs
//
// The Cesium build carried a dev-only causal timing trace (`?trafficDebug=1`)
// wired to Cesium's camera.changed/moveEnd/postRender scheduling. The MapLibre
// port removed it (its anchors no longer exist); the tests that drove it
// through a Vite SSR server and a fake Cesium scene went with it. What stays
// is the public contract: the diagnostic export exists and reports inert, and
// the layer installs no performance marks.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getTrafficTimingDiagnostics } from './traffic.js';

test('traffic timing diagnostics stay inert and install no marks', () => {
  assert.deepEqual(getTrafficTimingDiagnostics(), {
    enabled: false,
    marksInstalled: 0,
    traceObjectsCreated: 0,
    uncorrelatedTracesDropped: 0,
  });
  assert.equal(
    performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith('traffic:')).length,
    0,
  );
});
