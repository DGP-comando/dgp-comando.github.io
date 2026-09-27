// src/data/traffic.test.mjs
// Feed-state honesty for the traffic layer (roadmap L7).
//
// A launch-day stranger runs a keyless build. The layer then simulates
// traffic, and every surface it drives — the toggle chip, the panel meta
// line, the traffic sync chip — has to say so. The two pure helpers below own
// that contract; the layer's getStats() is a thin caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import trafficLayer, {
  deriveTrafficFlowError,
  trafficFeedPresentation,
} from './traffic.js';
import { DataLayerManager, layerFeedState } from './manager.js';

/**
 * The app's live markers. Case-SENSITIVE on purpose: uppercase LIVE/GPS is
 * how this UI asserts a real feed ("LIVE · TomTom flow", the old "initiating
 * global GPS sync"), while lowercase "add TomTom key for live" names the
 * remedy without claiming one.
 */
const LIVE_CLAIM = /\bLIVE\b|\bGPS\b|\breal[- ]?time\b/;

test('a superseded flow fetch is not an outage', () => {
  assert.equal(deriveTrafficFlowError({ name: 'AbortError', message: 'aborted' }), null);
  assert.equal(deriveTrafficFlowError(null), null);
  assert.equal(deriveTrafficFlowError(undefined), null);
});

test('flow failures map onto short, specific reasons', () => {
  const reason = (message) => deriveTrafficFlowError(new Error(message));
  assert.equal(reason('flow tile 12/1/1: HTTP 503'), 'TomTom key unavailable');
  assert.equal(reason('flow tile 12/1/1: HTTP 429'), 'TomTom daily budget reached');
  assert.equal(reason('flow tile 12/1/1: HTTP 502'), 'TomTom upstream unreachable');
  assert.equal(reason('flow tile 12/1/1: HTTP 504'), 'TomTom upstream unreachable');
  assert.equal(reason('flow tile 12/1/1: HTTP 418'), 'TomTom flow error (HTTP 418)');
  assert.equal(reason('flow fetch failed'), 'TomTom flow unavailable');
});

test('keyless traffic names the mode and the remedy, loading or idle', () => {
  const idle = trafficFeedPresentation({ liveMode: false, fetching: false });
  const loading = trafficFeedPresentation({ liveMode: false, fetching: true });
  assert.equal(idle.mode, 'sim');
  assert.equal(loading.mode, 'sim');
  // Keyless is a designed fallback, not a fault — no error, or every keyless
  // build would boot with a red chip.
  assert.equal(idle.error, null);
  assert.equal(loading.error, null);
  // One terse line in both states; the chip's progress text carries "working".
  assert.equal(idle.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(loading.loadingLabel, 'SIMULATED — add TomTom key for live');
});

test('no keyless label ever implies a live feed', () => {
  const labels = [
    trafficFeedPresentation({ liveMode: false, fetching: false }),
    trafficFeedPresentation({ liveMode: false, fetching: true }),
    trafficFeedPresentation({ statusUnavailable: true }),
    trafficFeedPresentation({ liveMode: true, flowError: 'TomTom flow unavailable' }),
    trafficFeedPresentation({ liveMode: true, fetching: true, flowError: 'TomTom flow unavailable' }),
  ].map((feed) => feed.loadingLabel);
  for (const label of labels) {
    assert.ok(!LIVE_CLAIM.test(label), `label implies live data: ${label}`);
    assert.ok(label.startsWith('SIMULATED'), `fallback label must lead with the mode: ${label}`);
  }
});

test('simulating because the status probe failed reads differently from keyless by design', () => {
  const probeDown = trafficFeedPresentation({ statusUnavailable: true });
  assert.equal(probeDown.mode, 'sim');
  assert.equal(probeDown.loadingLabel, 'SIMULATED — traffic service unreachable');
});

test('a healthy keyed layer reports live flow with its real coverage', () => {
  const idle = trafficFeedPresentation({ liveMode: true, coveragePct: 87 });
  assert.deepEqual(idle, {
    mode: 'live',
    error: null,
    loadingLabel: 'LIVE · TomTom flow · 87% cov',
  });
  assert.equal(
    trafficFeedPresentation({ liveMode: true, fetching: true }).loadingLabel,
    'syncing LIVE traffic flow',
  );
});

test('a mid-session flow outage degrades instead of reporting stale live coverage', () => {
  const down = trafficFeedPresentation({
    liveMode: true,
    flowError: 'TomTom daily budget reached',
    coveragePct: 87, // last-good number — must not be presented as current
  });
  // error and loadingLabel are ONE string: the manager's error branch renders
  // `error` and drops `loadingLabel`, so the copy has to live in both.
  assert.equal(down.error, 'SIMULATED — TomTom daily budget reached');
  assert.equal(down.loadingLabel, down.error);
  assert.ok(!down.loadingLabel.includes('87'));
  const busy = trafficFeedPresentation({
    liveMode: true,
    fetching: true,
    flowError: 'TomTom daily budget reached',
  });
  assert.deepEqual(busy, down, 'the degraded state reads the same whether or not a load is in flight');
});

test('the rendered steady-state meta line carries the SIMULATED copy', () => {
  const mgr = new DataLayerManager({});
  const stats = (feed) => ({ count: 544, lastUpdate: Date.now(), ...feed });
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({ liveMode: false })),
    }),
    'RESERVA · OpenStreetMap · SIMULATED — add TomTom key for live',
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({
        liveMode: true,
        flowError: 'TomTom daily budget reached',
      })),
    }),
    'DEGRADADA · OpenStreetMap · SIMULATED — TomTom daily budget reached',
  );
});

test('the manager reads keyless as FALLBACK and an outage as DEGRADED', () => {
  const settled = { count: 4200, lastUpdate: Date.now() };
  assert.equal(
    layerFeedState({ ...settled, ...trafficFeedPresentation({ liveMode: false }) }),
    'fallback',
  );
  assert.equal(
    layerFeedState({ ...settled, ...trafficFeedPresentation({ liveMode: true }) }),
    'nominal',
  );
  assert.equal(
    layerFeedState({
      ...settled,
      ...trafficFeedPresentation({ liveMode: true, flowError: 'TomTom flow unavailable' }),
    }),
    'degraded',
  );
});

test('the shipped layer boots keyless-honest before any status check', () => {
  const stats = trafficLayer.getStats();
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.ok(!LIVE_CLAIM.test(stats.loadingLabel), `boot label implies live data: ${stats.loadingLabel}`);
  assert.equal(layerFeedState(stats), 'fallback');
});

// ─── MapLibre port: road parsing and query shape (pure) ─────────────────────

test('Overpass query keeps the major/full highway filters and inline geometry', async () => {
  const { buildOverpassQuery } = await import('./traffic.js');
  const major = buildOverpassQuery(-25.44, -49.28, -25.42, -49.26, { majorOnly: true, timeoutSec: 12 });
  assert.match(major, /^\[out:json\]\[timeout:12\];/);
  assert.match(major, /\^\(motorway\|trunk\|primary\|secondary\)\$/);
  assert.match(major, /\(-25\.44,-49\.28,-25\.42,-49\.26\)/);
  assert.match(major, /out geom qt;$/);
  const full = buildOverpassQuery(0, 0, 1, 1);
  assert.match(full, /residential\|unclassified/);
});

test('parseRoads builds lon/lat polylines with metre segment lengths and one-way direction', async () => {
  const { parseRoads } = await import('./traffic.js');
  const roads = parseRoads({
    elements: [
      {
        type: 'way',
        id: 1,
        tags: { highway: 'primary', oneway: 'yes', name: 'Av. Sete de Setembro' },
        geometry: [{ lat: -25.44, lon: -49.28 }, { lat: -25.44, lon: -49.27 }, { lat: -25.43, lon: -49.27 }],
      },
      { type: 'way', id: 2, tags: { highway: 'residential', oneway: '-1' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] },
      { type: 'way', id: 3, tags: { highway: 'tertiary' }, geometry: [{ lat: 0, lon: 0 }] },
      { type: 'node', id: 4 },
    ],
  });
  assert.equal(roads.length, 2, 'single-vertex ways and non-ways are dropped');
  const [a, b] = roads;
  assert.deepEqual(a.coords[0], [-49.28, -25.44]);
  assert.equal(a.type, 'primary');
  assert.equal(a.oneway, 1);
  assert.equal(a.name, 'Av. Sete de Setembro');
  assert.equal(a.segmentDist.length, 2);
  // 0.01° of longitude at 25.44° S ≈ 1005 m; 0.01° of latitude ≈ 1112 m.
  assert.ok(Math.abs(a.segmentDist[0] - 1005) < 10, `lon segment ${a.segmentDist[0]}`);
  assert.ok(Math.abs(a.segmentDist[1] - 1112) < 10, `lat segment ${a.segmentDist[1]}`);
  assert.equal(b.oneway, -1);
  assert.equal(b.type, 'residential');
  assert.deepEqual(parseRoads(null), []);
});

test('long ways are sub-sampled but keep their true endpoint', async () => {
  const { parseRoads } = await import('./traffic.js');
  const geometry = Array.from({ length: 401 }, (_, i) => ({ lat: 0, lon: i * 0.0001 }));
  const [road] = parseRoads({ elements: [{ type: 'way', id: 9, tags: { highway: 'trunk' }, geometry }] });
  assert.ok(road.coords.length <= 82, `coords ${road.coords.length}`);
  assert.deepEqual(road.coords.at(-1), [0.04, 0]);
});

test('detection objects carry a neutral {lon, lat} position, never a Cesium type', () => {
  // Disabled layer: no objects (and no throw) — the detection loop polls it.
  assert.deepEqual(trafficLayer.getDetectableObjects({ maxCount: 10 }), []);
});
