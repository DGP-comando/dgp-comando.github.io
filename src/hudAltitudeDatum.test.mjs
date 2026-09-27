// The HUD's ALT readout datum. Field report (2026-08-22, cockpit parked at
// SFO): the bottom-right OSD read "ALT: -15M". Cesium reported the camera's
// height against the WGS84 ELLIPSOID, so the HUD had to take the EGM96 geoid
// undulation back out (data/geoid.js). The number a viewer reads as "ALT" is
// MSL.
//
// The MapLibre engine measures the camera altitude above SEA LEVEL already
// (the DEM's orthometric zero), so the HUD now prints the engine altitude as
// is. Re-applying the geoid there would reintroduce the very error, sign
// flipped. This file pins that: the readouts are the engine's MSL altitude,
// the two ALT strings agree, and hud.js no longer loads the EGM96 grid.
//
// hud.js imports `mgrs`, a CommonJS package whose named exports Node's ESM
// loader cannot see, so the live half installs a module hook that swaps that
// one specifier for a stub. The import also has to happen BEFORE any DOM
// globals exist: Cesium's widget bundle probes for a real `document` at module
// scope and a partial stub sends it down the browser path. Hence hook →
// import → install DOM, in that order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

const source = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
const has = (pattern) => pattern.test(source);

/** SFO runway 28R touchdown area — the field report's coordinates. */
const SFO = { latDeg: 37.616, lonDeg: -122.368 };

/**
 * Minimal DOM + engine the HUD's telemetry tick actually touches. `intel-hud`
 * is deliberately absent so `_buildDOM` bails and the readouts stay the plain
 * text sinks this test reads.
 */
function installHudEnvironment({ lat = SFO.latDeg, lon = SFO.lonDeg, alt = 17 } = {}) {
  const elements = new Map(
    ['hud-alt', 'hud-summary', 'hud-mgrs', 'hud-latlon', 'hud-bottom-line', 'hud-gsd', 'hud-coll', 'hud-ona', 'hud-mode']
      .map((id) => [id, { textContent: '' }]),
  );
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const moveEnd = new Set();
  const view = { lat, lon, alt, heading: 0, pitch: -90, roll: 0, zoom: 15, targetLat: lat, targetLon: lon };
  const engine = {
    view,
    getCameraView: () => ({ ...view }),
    on(type, fn) {
      if (type !== 'moveend') return () => {};
      moveEnd.add(fn);
      return () => moveEnd.delete(fn);
    },
    moveEnd,
  };
  return {
    elements,
    engine,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

test('hud.js reads the MSL camera altitude from the engine and never re-datums it', () => {
  assert.equal(has(/from 'cesium'/), false, 'hud.js must not import Cesium');
  assert.equal(has(/from '\.\/data\/geoid\.js'/), false, 'the engine altitude is MSL already: no EGM96 grid in the HUD');
  assert.equal(has(/ellipsoidalToMslDisplayM/), false, 'no ellipsoid → MSL conversion of an MSL height');
  assert.equal(has(/readCameraView\(this\.engine\)/), true, 'telemetry comes from the engine camera (readCameraView)');
  assert.equal(has(/`ALT: \$\{Math\.round\(altMslM\)\}m/), true, 'the #hud-alt line prints altMslM');
  assert.equal(
    has(/const altDisplayM = Number\.isFinite\(m\.altMslM\) \? m\.altMslM : m\.altM;/),
    true,
    'the summary altitude tag uses the same datum as the corner readout',
  );
});

test('the corner and summary ALT readouts print the engine altitude at SFO', () => {
  const env = installHudEnvironment({ alt: 17 });
  let hud;
  try {
    hud = new IntelHUD(env.engine);
    hud._updateCameraData();
    const alt = env.elements.get('hud-alt').textContent;
    const summary = env.elements.get('hud-summary').textContent;
    assert.match(alt, /^ALT: 17m/, `corner readout, got ${alt}`);
    assert.match(summary, /\| ALT 17M \|/, `summary tag, got ${summary}`);
    assert.match(env.elements.get('hud-mgrs').textContent, /^MGRS: 10S EG 5577 6339$/);
    assert.match(env.elements.get('hud-ona').textContent, /^ONA: 0\.0°/);
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('London 100 m stays 100 m: no geoid sign flip on the MapLibre datum', () => {
  const env = installHudEnvironment({ lat: 51.5072, lon: -0.1275, alt: 100 });
  let hud;
  try {
    hud = new IntelHUD(env.engine);
    hud._updateCameraData();
    assert.match(env.elements.get('hud-alt').textContent, /^ALT: 100m/);
    assert.match(env.elements.get('hud-summary').textContent, /\| ALT 100M \|/);
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('pitch maps to off-nadir angle and the HUD releases its moveend listener', () => {
  const env = installHudEnvironment({ alt: 5000 });
  env.engine.view.pitch = -60;
  let hud;
  try {
    hud = new IntelHUD(env.engine);
    assert.equal(env.engine.moveEnd.size, 1, 'the HUD listens to the engine moveend');
    hud._updateCameraData();
    assert.match(env.elements.get('hud-ona').textContent, /^ONA: 30\.0°/);
    assert.match(env.elements.get('hud-gsd').textContent, /^GSD: 1\.88m/);
    hud.destroy();
    assert.equal(env.engine.moveEnd.size, 0, 'destroy removes the engine listener');
    hud = null;
  } finally {
    hud?.destroy();
    env.restore();
  }
});
