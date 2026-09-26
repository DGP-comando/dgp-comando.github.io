import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approximateSurfaceDistanceM,
  classifyGoogleMilitaryPlace,
  installationSourceLabel,
  installationResponseSaturated,
  installationSurfaceHeightM,
  installationWithinViewport,
} from './militaryInstallations.js';
import militaryInstallationsLayer, {
  _renderedInstallationsForTest,
  militaryInstallationsMapDef,
} from './militaryInstallations.js';
import {
  _clearMeshFloorCellsForTest,
  reportMeshFloorCell,
  setMeshFloorPreferred,
} from './groundFloor.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';

// MIGRAÇÃO MAPLIBRE (2026-09): o motor é um dublê com a API de
// src/maplibre/engine.js (map.getBounds, getSource().setData, on('moveend'),
// flyToTarget); as "entidades" desenhadas são os portadores de contexto que a
// camada expõe em _renderedInstallationsForTest(). O teste "a floor that lands
// after the render deadline lifts the dots off the ellipsoid" SAIU: ele fixava
// o re-render que erguia os pontos Cesium sobre o piso de relevo 3D quando o
// piso chegava atrasado — no mapa 2D os pontos não têm altura e a camada não
// aquece mais o piso.
const toRad = (deg) => (deg * Math.PI) / 180;

/** Dublê do motor: devolve `box()` como retângulo visível (null = vista global). */
function fakeEngine(box) {
  const sourceData = [];
  const flights = [];
  const map = {
    getBounds() {
      const b = typeof box === 'function' ? box() : box;
      const v = b || { south: -85, north: 85, west: -180, east: 180 };
      return { getSouth: () => v.south, getNorth: () => v.north, getWest: () => v.west, getEast: () => v.east };
    },
    getSource(id) { return id === 'dg-milinst' ? { setData(data) { sourceData.push(data); } } : null; },
    addSource() {},
    addLayer() {},
    getLayer() { return null; },
    setLayoutProperty() {},
  };
  return {
    map,
    sourceData,
    flights,
    on() { return () => {}; },
    flyToTarget(target, options) { flights.push({ target, options }); },
    getCameraView: () => ({ heading: 0 }),
    requestRender() {},
  };
}

test('cheap installation distance prefilter is local and antimeridian-safe', () => {
  const oneDegree = approximateSurfaceDistanceM(0, 0, 0, 1);
  assert.ok(oneDegree > 111000 && oneDegree < 111300);
  const acrossDateline = approximateSurfaceDistanceM(
    toRad(10),
    toRad(179.9),
    10,
    -179.9,
  );
  assert.ok(acrossDateline > 21000 && acrossDateline < 23000);
});

test('keeps generic Places hits distinct from explicitly typed military facilities', () => {
  assert.equal(classifyGoogleMilitaryPlace({ primaryType: 'military_base' }), 'military_land');
  assert.equal(classifyGoogleMilitaryPlace({ types: ['point_of_interest', 'military_base'] }), 'military_land');
  assert.equal(classifyGoogleMilitaryPlace({ name: 'Army Recruiting Office', types: ['government_office'] }), 'places_candidate');
  assert.equal(classifyGoogleMilitaryPlace({ name: 'Military Museum', types: ['museum'] }), 'places_candidate');
});

test('reports the record source instead of attributing Places records to OpenStreetMap', () => {
  assert.equal(installationSourceLabel({ sources: [{ name: 'Google Maps Places' }] }), 'Google Maps Places');
  assert.equal(installationSourceLabel({ sources: [{ name: 'OpenStreetMap' }, { name: 'OpenStreetMap' }] }), 'OpenStreetMap');
});

test('places installation anchors on the shared cached rendered floor', () => {
  setMeshFloorPreferred(true);
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(30.2, -97.7, 182.25);
  assert.equal(installationSurfaceHeightM({ latitude: 30.2, longitude: -97.7 }), 183.75);
  _clearMeshFloorCellsForTest();
});

test('a real enabled load paints points and footprints into the MapLibre source', async () => {
  const run = await runInstallationLoad({
    elements: [
      { type: 'node', id: 42, lat: 30.2, lon: -97.7, tags: { military: 'base', name: 'Runtime Installation' } },
      {
        type: 'way', id: 43, center: { lat: 30.5, lon: -97.5 }, tags: { military: 'airfield', name: 'Runtime Field' },
        geometry: [{ lat: 30.4, lon: -97.6 }, { lat: 30.4, lon: -97.4 }, { lat: 30.6, lon: -97.4 }],
      },
    ],
  });
  try {
    const entities = run.entities();
    assert.deepEqual(entities.map((entity) => entity.gevLabelModel.title), ['Runtime Installation', 'Runtime Field']);
    assert.ok(entities.every((entity) => entity.gevTrackedId.startsWith('installations:')));
    const painted = run.engine.sourceData.at(-1);
    const kinds = painted.features.map((feature) => feature.geometry.type).sort();
    assert.deepEqual(kinds, ['Point', 'Point', 'Polygon']);
    const ring = painted.features.find((feature) => feature.geometry.type === 'Polygon').geometry.coordinates[0];
    assert.deepEqual(ring[0], ring.at(-1), 'the footprint ring is closed for MapLibre');
    assert.equal(painted.features.find((f) => f.properties.rid === 'osm:way:43').properties.class, 'airfield');
    const position = entities[0].gevDisplayPosition();
    assert.equal(position.lon, -97.7);
    assert.ok(Number.isFinite(position.x), 'display positions are neutral points');
  } finally {
    run.restore();
  }
});

test('map definition follows the host contract with hover and click on points and footprints', () => {
  for (const id of Object.keys(militaryInstallationsMapDef.sources)) assert.ok(id.startsWith('dg-'));
  assert.deepEqual(
    militaryInstallationsMapDef.layers.map((layer) => layer.type),
    ['fill', 'line', 'circle', 'symbol'],
  );
  assert.deepEqual(militaryInstallationsMapDef.interactive, ['dg-milinst-pt', 'dg-milinst-fill']);
  assert.equal(typeof militaryInstallationsMapDef.tooltip, 'function');
  assert.equal(typeof militaryInstallationsMapDef.click, 'function');
});

const VIEWPORT = { south: 30, west: -98, north: 31, east: -97 };

test('Context focus past the render cap selects for real instead of flying blind', async () => {
  // Context navigation walks the FULL nearby cohort; only the first 700 records
  // get entities. Focusing item 701+ used to fly the camera, find no entity,
  // silently drop the selection, and report success — so the Context subject
  // stayed stale and NEXT offered the same installation forever.
  const elements = Array.from({ length: 760 }, (_, index) => ({
    type: 'node',
    id: 1000 + index,
    lat: 30.1 + (index % 40) * 0.002,
    lon: -97.9 + Math.floor(index / 40) * 0.002,
    tags: { military: 'base', name: `Installation ${index}` },
  }));
  const run = await runInstallationLoad({ elements });
  const flights = [];
  try {
    const renderedIds = new Set(run.entities().map((entity) => entity.id));
    assert.equal(renderedIds.size, 700, 'the ambient paint stays capped');

    const cohort = militaryInstallationsLayer.getNearby(
      { lon: -97.8, lat: 30.15 },
      Number.POSITIVE_INFINITY,
      5000,
    );
    assert.ok(cohort.length > 700, 'the cohort reaches past the render cap');
    const beyondCap = cohort.find((record) => !renderedIds.has(record.id));
    assert.ok(beyondCap, 'a cohort item exists outside the rendered window');

    const focused = militaryInstallationsLayer.focusById(beyondCap.id);
    assert.equal(focused, true, 'focus succeeds');
    // The proof: a real entity now backs the selection, so the Context subject
    // actually changes rather than the camera moving over a stale subject.
    const nowRendered = run.entities().find((entity) => entity.id === beyondCap.id);
    assert.ok(nowRendered, 'the focused record was rendered on demand');
    assert.equal(
      run.contextLabels().at(-1),
      beyondCap.name,
      'the selection reached the context store',
    );
    assert.equal(run.engine.flights.length, 1, 'and only then the camera frames it');
    assert.equal(run.engine.flights[0].target.lat, beyondCap.latitude);
  } finally {
    void flights;
    run.restore();
  }
});

/**
 * Drive one real `update()` of the layer against a stubbed proxy, and expose
 * what actually reached the map and the context store.
 */
async function runInstallationLoad({
  elements = [],
  saturated = false,
  exactElements = null,
  exactSaturated = false,
  legacyPayload = false,
  failWith = null,
}) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const contextEvents = [];
  _resetRenderGovernorForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = {
    dispatchEvent(event) {
      if (event?.detail?.label) contextEvents.push(event.detail.label);
    },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    requests.push(href);
    if (failWith) {
      return { ok: false, status: 503, json: async () => ({ error: failWith }) };
    }
    const exact = href.includes('exact=1');
    const payload = {
      status: 'fresh',
      retrievedAt: '2026-08-18T00:00:00.000Z',
      elements: exact && exactElements ? exactElements : elements,
      elementCap: 700,
    };
    // A pre-fix cached entry carries no `saturated` field at all.
    if (!legacyPayload) payload.saturated = exact ? exactSaturated : saturated;
    return { ok: true, status: 200, json: async () => payload };
  };
  const engine = fakeEngine(VIEWPORT);

  militaryInstallationsLayer.init(engine);
  installRenderGovernor(engine);
  militaryInstallationsLayer.enable();
  await militaryInstallationsLayer.update();

  return {
    requests,
    engine,
    entities: () => _renderedInstallationsForTest(),
    contextLabels: () => contextEvents,
    stats: () => militaryInstallationsLayer.getStats(),
    renderRequests: () => getRenderGovernorDiagnostics().recentRequests.map((item) => item.reason),
    restore() {
      militaryInstallationsLayer.destroy();
      _resetRenderGovernorForTest();
      globalThis.fetch = originalFetch;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('viewport membership keeps intersecting footprints and drops the snap ring', () => {
  const inside = { osmType: 'node', latitude: 30.5, longitude: -97.5, footprint: null };
  const outside = { osmType: 'node', latitude: 30.5, longitude: -96.5, footprint: null };
  assert.equal(installationWithinViewport(inside, VIEWPORT), true);
  assert.equal(installationWithinViewport(outside, VIEWPORT), false);

  // A large base whose CENTRE sits just outside but whose footprint overlaps
  // was always returned by the bbox query and must keep rendering.
  const straddling = {
    osmType: 'way',
    latitude: 30.5,
    longitude: -96.95,
    footprint: [[-97.05, 30.4], [-96.9, 30.4], [-96.9, 30.6], [-97.05, 30.6]],
  };
  assert.equal(installationWithinViewport(straddling, VIEWPORT), true);

  const farWithFootprint = {
    osmType: 'way',
    latitude: 30.5,
    longitude: -96.5,
    footprint: [[-96.6, 30.4], [-96.4, 30.4], [-96.4, 30.6], [-96.6, 30.6]],
  };
  assert.equal(installationWithinViewport(farWithFootprint, VIEWPORT), false);
  assert.equal(installationWithinViewport(null, VIEWPORT), false);
  assert.equal(installationWithinViewport(inside, null), false);
});

test('extended features with unknown extent are kept, not centre-tested', () => {
  // Relations carry geometry on their members and ways over MAX_FOOTPRINT_POINTS
  // are normalized without one, so their true extent is unknown here. Overpass
  // already proved they intersect the queried bbox; centre-testing them would
  // erase exactly the biggest installations.
  const relation = { osmType: 'relation', latitude: 30.5, longitude: -96.99, footprint: null };
  const hugeWay = { osmType: 'way', latitude: 29.5, longitude: -97.5, footprint: null };
  assert.equal(installationWithinViewport(relation, VIEWPORT), true);
  assert.equal(installationWithinViewport(hugeWay, VIEWPORT), true);
  // A node IS its geometry, so excluding it on centre loses nothing.
  assert.equal(
    installationWithinViewport({ osmType: 'node', latitude: 30.5, longitude: -96.99, footprint: null }, VIEWPORT),
    false,
  );
  // Unknown provenance is treated inclusively, same as an extended feature.
  assert.equal(installationWithinViewport({ latitude: 30.5, longitude: -96.99, footprint: null }, VIEWPORT), true);
});

test('a footprint-less relation just outside the viewport still renders', async () => {
  const harness = await runInstallationLoad({
    elements: [
      // A relation whose CENTER sits outside the viewport and whose geometry
      // lives on members Overpass did not inline. It was returned because it
      // intersects the queried bbox, so it must survive the viewport filter.
      { type: 'relation', id: 91, center: { lat: 30.5, lon: -96.995 }, tags: { military: 'range', name: 'Straddling Range' } },
      // A NODE at the same off-view spot has no extent and must still be cut.
      { type: 'node', id: 92, lat: 30.5, lon: -96.995, tags: { military: 'range', name: 'Off View Node' } },
    ],
  });
  try {
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Straddling Range'],
    );
  } finally {
    harness.restore();
  }
});

test('a legacy cached response with no saturation flag still triggers the exact retry', () => {
  const atCap = { elements: new Array(700).fill({ type: 'node' }), elementCap: 700 };
  assert.equal(installationResponseSaturated(atCap), true, 'derived from the reported cap');
  assert.equal(
    installationResponseSaturated({ elements: new Array(699).fill({ type: 'node' }), elementCap: 700 }),
    false,
  );
  // An explicit flag always wins over the derivation.
  assert.equal(installationResponseSaturated({ ...atCap, saturated: false }), false);
  assert.equal(installationResponseSaturated({ elements: [], saturated: true }), true);
  // Nothing to derive from: do not invent saturation.
  assert.equal(installationResponseSaturated({ elements: new Array(700).fill({}) }), false);
  assert.equal(installationResponseSaturated(null), false);
});

test('a legacy-shaped payload at the cap fires the exact-viewport retry end to end', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    elements.push({ type: 'node', id: 3000 + index, lat: 30.5, lon: -96.2, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({
    elements,
    // Pre-fix cache shape: no `saturated` field at all, but at the cap.
    legacyPayload: true,
    exactElements: [
      { type: 'node', id: 8, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'Rescued From Legacy' } },
    ],
  });
  try {
    assert.equal(harness.requests.length, 2, 'a legacy entry must not skip the retry');
    assert.equal(harness.requests[1].includes('exact=1'), true);
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Rescued From Legacy'],
    );
  } finally {
    harness.restore();
  }
});

test('a failed load buys the frame its status change needs', async () => {
  const harness = await runInstallationLoad({ failWith: 'Installation feed HTTP 503' });
  try {
    assert.equal(harness.stats().status, 'unavailable');
    assert.ok(
      harness.renderRequests().some((reason) => reason === 'installations-status'),
      'an idle governor would otherwise leave the last healthy readout on screen',
    );
  } finally {
    harness.restore();
  }
});

test('off-viewport records from the snapped superset never render or enter context', async () => {
  const harness = await runInstallationLoad({
    // The snapped bbox reaches ~5.5 km beyond the viewport; this node sits a
    // full degree outside it.
    elements: [
      { type: 'node', id: 1, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'In View' } },
      { type: 'node', id: 2, lat: 30.5, lon: -96.2, tags: { military: 'range', name: 'Off View' } },
    ],
  });
  try {
    const titles = harness.entities().map((entity) => entity.gevLabelModel?.title);
    assert.deepEqual(titles, ['In View'], 'only the in-viewport site renders');
    assert.equal(harness.contextLabels().includes('Off View'), false, 'and none enters context');
    assert.equal(harness.stats().count, 1);
  } finally {
    harness.restore();
  }
});

test('a saturated snapped tile refetches the exact viewport before rendering', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    // A saturated snapped response full of OFF-viewport sites: the in-view ones
    // were crowded out upstream.
    elements.push({ type: 'node', id: 1000 + index, lat: 30.5, lon: -96.2, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({
    elements,
    saturated: true,
    exactElements: [
      { type: 'node', id: 7, lat: 30.5, lon: -97.5, tags: { military: 'range', name: 'Rescued' } },
    ],
  });
  try {
    assert.equal(harness.requests.length, 2, 'saturation triggers exactly one retry');
    assert.equal(harness.requests[0].includes('exact=1'), false, 'first ask uses the shared snapped tile');
    assert.equal(harness.requests[1].includes('exact=1'), true, 'retry opts out of the snap');
    assert.deepEqual(
      harness.entities().map((entity) => entity.gevLabelModel?.title),
      ['Rescued'],
      'the in-viewport site is no longer starved by off-view ones',
    );
  } finally {
    harness.restore();
  }
});

test('an unsaturated response never pays for a second upstream ask', async () => {
  const harness = await runInstallationLoad({
    elements: [{ type: 'node', id: 3, lat: 30.5, lon: -97.5, tags: { military: 'range' } }],
  });
  try {
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.stats().saturated, false);
  } finally {
    harness.restore();
  }
});

test('a still-saturated exact viewport is reported honestly instead of implied complete', async () => {
  const elements = [];
  for (let index = 0; index < 700; index += 1) {
    elements.push({ type: 'node', id: 2000 + index, lat: 30.5, lon: -97.5, tags: { military: 'range' } });
  }
  const harness = await runInstallationLoad({ elements, saturated: true, exactSaturated: true });
  try {
    assert.equal(harness.stats().saturated, true);
    assert.match(harness.stats().error, /Too many mapped sites/);
  } finally {
    harness.restore();
  }
});

test('reports bounded installation requests as loading and clears on settlement', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let resolveInstallations;
  const installationsResponse = new Promise((resolve) => { resolveInstallations = resolve; });
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    return installationsResponse;
  };
  const viewer = fakeEngine({ south: 30, west: -98, north: 31, east: -97 });


  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    const update = militaryInstallationsLayer.update();
    assert.equal(militaryInstallationsLayer.getStats().loading, true);
    assert.equal(
      militaryInstallationsLayer.getStats().loadingLabel,
      'loading mapped installation context',
    );
    resolveInstallations({
      ok: true,
      status: 200,
      json: async () => ({ status: 'fresh', elements: [] }),
    });
    await update;
    assert.equal(militaryInstallationsLayer.getStats().loading, false);
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('zoom-out aborts an active installation request and returns non-loading guidance', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let globalView = false;
  let observedSignal;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (_url, options = {}) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const viewer = fakeEngine(() => (globalView ? null : { south: 30, west: -98, north: 31, east: -97 }));


  try {
    militaryInstallationsLayer.init(viewer);
    militaryInstallationsLayer.enable();
    const pending = militaryInstallationsLayer.update();
    assert.equal(militaryInstallationsLayer.getStats().loading, true);
    globalView = true;
    await militaryInstallationsLayer.update();
    await pending;
    assert.equal(observedSignal.aborted, true);
    assert.equal(militaryInstallationsLayer.getStats().loading, false);
    assert.equal(militaryInstallationsLayer.getStats().status, 'zoom-in');
  } finally {
    militaryInstallationsLayer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

// The unavailable-state retry: 'temporarily unavailable' must mean temporarily.
// Fetches otherwise fire only on enable and on camera moveEnd, so a parked
// camera whose first request failed stayed unavailable forever while the proxy
// sat healthy — observed in the field as a layer stuck reporting unavailable
// while its own endpoint served hundreds of features. The backoff progression
// is a pure exported helper so it pins without booting the layer (the full
// layer needs an engine and interaction handlers); the wiring is pinned
// by source probes against the shipped file, the same technique the HUD datum
// tests use where a full boot is impractical.
import { installationRetryDelayMs } from './militaryInstallations.js';
import fs from 'node:fs';

const installationsSource = fs.readFileSync(
  new URL('./militaryInstallations.js', import.meta.url), 'utf8');

test('the unavailable retry backs off 30s to a 240s ceiling and restarts clean', () => {
  assert.equal(installationRetryDelayMs(0), 30000, 'first failure retries in 30s');
  assert.equal(installationRetryDelayMs(undefined), 30000, 'no prior delay means the minimum');
  assert.equal(installationRetryDelayMs(30000), 60000, 'each failure doubles');
  assert.equal(installationRetryDelayMs(60000), 120000);
  assert.equal(installationRetryDelayMs(120000), 240000, 'the ceiling is four minutes');
  assert.equal(installationRetryDelayMs(240000), 240000, 'and it stays there');
  assert.equal(installationRetryDelayMs(-5), 30000, 'garbage restarts at the minimum');
});

test('the retry is wired to every lifecycle edge, not just declared', () => {
  assert.match(installationsSource,
    /setInstallationStatus\('unavailable',[^]*?\);\n\s*scheduleUnavailableRetry\(\);/,
    'a failed load schedules the retry immediately after reporting unavailable');
  assert.match(installationsSource,
    /clearUnavailableRetry\(\);\n\s*setInstallationStatus\(\n?\s*state\.records\.length/,
    'a successful load clears the pending retry and resets the backoff');
  assert.match(installationsSource,
    /clearUnavailableRetry\(\);\n\s*setInstallationStatus\('zoom-in'/,
    'zooming out of range cancels the retry — moveEnd owns re-entry there');
  assert.match(installationsSource, /disable\(\) \{[^]*?clearUnavailableRetry\(\);/,
    'disabling the layer cancels the retry');
  assert.match(installationsSource,
    /function scheduleLoad\(\) \{[^]*?clearUnavailableRetry\(\{ resetBackoff: false \}\)/,
    'a user-driven load supersedes the retry without resetting the backoff step');
  assert.match(installationsSource,
    /state\.enabled && !state\.loading\) loadInstallations\(\)/,
    'the fired retry re-checks enablement and never races an in-flight load');
});
