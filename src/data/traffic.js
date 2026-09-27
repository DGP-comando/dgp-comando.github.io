import { deriveFetchCenter, clampBoundsAroundCenter, greatCircleKm } from './trafficBounds.js';
import { fetchFlowForBounds, getFlowSessionStats, resetFlowTileCache } from './flowTiles.js';
import { matchFlowToRoads } from './flowMatch.js';
import { FLOW_BUCKET_RGBA, flowBucket, flowSpeedScale, flowDensityMult } from './trafficFlowStyle.js';
import {
  trafficStyleProfile,
  presetDotRgba,
  presetSizeDelta,
  presetDotOutline,
  trafficBucketTier,
} from './trafficPresetStyle.js';
import { queuePlatoons, locateAlongRoad } from './trafficQueue.js';
import { registerDynamicCredit, TOMTOM_CREDIT } from './dataCredits.js';
import { defineLayer, EMPTY_FC, esc, row } from '../maplibre/kit.js';
import { cameraAltitudeM } from './mapCardHost.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';

/**
 * @file Street Traffic — MapLibre version (migração do CesiumJS).
 *
 * Road geometry: OSM Overpass API via the dev proxy (`/api/overpass`). Roads
 * for the view load when the camera is below ~8 km; dots travel along them.
 *
 * Two modes (decided once per session via `/api/tomtom/status`):
 *  - `sim` (keyless default): white dots at per-road-class speeds, and the
 *    layer says SIMULATED everywhere (chip, panel meta line);
 *  - `live`: TomTom flow tiles (`flowTiles.js`, vector tiles decoded here, NOT
 *    a MapLibre source — they are matched onto the Overpass roads by
 *    `flowMatch.js`) color, slow and densify the dots by real congestion
 *    (`trafficFlowStyle.js`); closed roads get no dots; unmatched roads keep
 *    the simulated white.
 *
 * Desenho no MapLibre (o que mudou):
 *  - Malha viária: fonte GeoJSON `dg-traffic-roads` com uma linha por via,
 *    colorida pelo balde de fluxo (verde/âmbar/vermelho; branca translúcida
 *    quando simulada). No Cesium só os pontos apareciam; a linha ajuda a ler o
 *    fluxo num mapa 2D.
 *  - Veículos: fonte GeoJSON `dg-traffic-dots` (círculos) reescrita a
 *    ~12 quadros/s pelo laço de animação (no Cesium era um
 *    PointPrimitiveCollection atualizado a cada quadro). Teto de pontos
 *    MAX_DOTS = 4000 (era 6000) por custo de setData.
 *  - Heat-lines (jamViz 'heatline'/'both'): uma linha larga com blur sob as
 *    vias congestionadas, que pulsa (antes: GroundPolylinePrimitive drapeado
 *    nos 3D tiles).
 *  - Sem altura de terreno/profundidade: pontos no chão do mapa.
 *  - Instrumentação de tempo de desenvolvimento (`?trafficDebug=1`, marcas de
 *    performance ligadas ao agendamento do Cesium) foi removida;
 *    `getTrafficTimingDiagnostics()` continua existindo e reporta inerte.
 *  - `getDetectableObjects` devolve `position: {lon, lat, height}` (antes
 *    Cesium.Cartesian3) e também `lon`/`lat` no próprio objeto.
 *
 * @module data/traffic
 */

/** @const {string} Proxy endpoint for Overpass API queries */
const OVERPASS_URL = '/api/overpass';
/** @const {number} Meters — hide all traffic above this camera altitude */
const ACTIVATION_ALTITUDE = 8000;
/** @const {number} Meters — above this altitude, only major roads are fetched */
const FAST_FETCH_ALTITUDE = 4500;
/** @const {number} Milliseconds — debounce delay before fetching after camera settles */
const FETCH_DEBOUNCE = 320;
/** @const {number} Fraction (0-1) — skip re-fetch when viewport overlap exceeds this */
const OVERLAP_THRESHOLD = 0.6;
/** @const {number} Hard cap on total rendered dots (GeoJSON setData budget). */
const MAX_DOTS = 4000;
/** @const {number} Polylines longer than this are simplified by sub-sampling */
const MAX_WAYPOINTS_PER_ROAD = 80;
/** @const {number} Km — minimum viewport center shift before allowing refresh */
const MIN_CENTER_SHIFT_KM = 0.35;
/** @const {number} Km — max distance the fetch center may sit from the camera nadir. */
const MAX_LOOKAT_PULL_KM = 12;
/** @const {number} Minimum ms between dot-source rewrites (~12 fps). */
const DOT_FRAME_MS = 80;

/** @const {Object<string,number>} Speed in meters per second by highway tag */
const SPEED_MPS = {
  motorway: 25,
  trunk: 20,
  primary: 14,
  secondary: 11,
  tertiary: 8,
  residential: 5,
  unclassified: 5,
};

/** @const {Object<string,number>} Density multiplier — more dots on important roads */
const DENSITY_MULT = {
  motorway: 3.0, trunk: 2.5, primary: 2.0, secondary: 1.5,
  tertiary: 1.0, residential: 0.5, unclassified: 0.4,
};

/** @const {Object<string,number>} Dot diameter (px) per road type */
const SIZE_BY_TYPE = {
  motorway: 6, trunk: 6, primary: 5, secondary: 5,
  tertiary: 4, residential: 4, unclassified: 4,
};

/** @const {Object<string,number>} Road line width (px) per road type */
const ROAD_WIDTH_BY_TYPE = {
  motorway: 3.2, trunk: 3, primary: 2.6, secondary: 2.2,
  tertiary: 1.6, residential: 1.1, unclassified: 1,
};

const rgbaCss = ([r, g, b, a]) => `rgba(${r},${g},${b},${a})`;
/** Live-flow bucket colors (CSS): green / amber / red at 0.9 alpha. */
const FLOW_BUCKET_COLORS = {
  free: rgbaCss(FLOW_BUCKET_RGBA.free),
  slow: rgbaCss(FLOW_BUCKET_RGBA.slow),
  jam: rgbaCss(FLOW_BUCKET_RGBA.jam),
};
const SIM_DOT_COLOR = 'rgba(255,255,255,0.85)';
const SIM_ROAD_COLOR = 'rgba(255,255,255,0.16)';

/** @const {number} Max congested roads drawn as heat-lines. */
const HEAT_LINE_CAP = 400;
const HEAT_JAM_BASE_ALPHA = 0.55;
const HEAT_JAM_PULSE_ALPHA = 0.2;
/** Stop-and-go creep (jam-viz density prototype). */
const CREEP_BURST = 2.2;
const CREEP_MOVE_MS = [1200, 3000];
const CREEP_STOP_MS = [1500, 5000];
const STYLED_MIN_BASE_PX = 5;

const SRC_ROADS = 'dg-traffic-roads';
const SRC_DOTS = 'dg-traffic-dots';
const LYR_HEAT = 'dg-traffic-heat';
const LYR_ROADS = 'dg-traffic-roads-line';
const LYR_DOTS = 'dg-traffic-dots-pt';

// ─── Module State ──────────────────────────────────────────
let _engine = null;
let _map = null;
/** Active animated dots ({road, lonlat waypoints, segIdx, t, mps, ...}). */
let _dots = [];
/** Parsed roads ({coords:[lon,lat][], type, oneway, segmentDist:number[], flow?}). */
let _roads = [];
let _enabled = false;
let _offs = [];
let _fetchTimeout = null;
let _lastBounds = null;
let _fetching = false;
let _count = 0;
let _lastUpdate = null;
let _loadGeneration = 0;
let _activeFetchAbort = null;
let _densityScale = 1.0;
let _speedScale = 1.0;
let _lastViewCenter = null;
let _liveMode = false;
/** Short user-facing reason live flow is unavailable (live mode only), or null. */
let _flowError = null;
/** True when `/api/tomtom/status` itself could not be reached. */
let _flowStatusUnavailable = false;
/** Flow requests this layer still owns (counted: loads can overlap). */
let _flowPending = 0;
let _bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
let _closedRoads = 0;
/** @type {'sim'|'hide'} Live-mode treatment of roads without flow data. */
let _uncoveredMode = 'sim';
/** @type {'none'|'density'|'heatline'|'both'} */
let _jamViz = 'density';
let _heatLineCount = 0;
let _lastRenderAltitude = 0;
/** Active post-FX style (StyleManager preset name). */
let _stylePreset = 'normal';
/** @type {'on'|'off'} Kill switch for preset-aware dot styling. */
let _presetDots = 'on';
let _styleListenerBound = false;
let _activeBucketColors = { ...FLOW_BUCKET_COLORS };
let _flowStatusPromise = null;
let _enableKickTimer = null;
let _flowCoveragePct = 0;
let _raf = 0;
let _lastAnimTime = 0;
let _lastDotWrite = 0;

/** @returns {boolean} A non-normal preset profile is active and enabled. */
function presetProfileActive() {
  return _presetDots === 'on' && trafficStyleProfile(_stylePreset) !== 'normal';
}

function activeSizeDelta(bucket) {
  return _presetDots === 'on' ? presetSizeDelta(_stylePreset, bucket) : 0;
}

function baseDotSize(roadType, bucket) {
  const base = SIZE_BY_TYPE[roadType] || 4;
  return (bucket && presetProfileActive()) ? Math.max(base, STYLED_MIN_BASE_PX) : base;
}

function refreshBucketColors() {
  for (const bucket of ['free', 'slow', 'jam']) {
    const rgba = _presetDots === 'on' ? presetDotRgba(_stylePreset, bucket) : null;
    _activeBucketColors[bucket] = rgba ? rgbaCss(rgba) : FLOW_BUCKET_COLORS[bucket];
  }
}

/** Dot paint (color/size/outline) for a bucket and road class. */
function dotStyle(roadType, bucket) {
  const size = baseDotSize(roadType, bucket) + (bucket === 'jam' ? 1 : 0) + activeSizeDelta(bucket);
  const outline = bucket && _presetDots === 'on' ? presetDotOutline(_stylePreset, bucket) : null;
  return {
    color: bucket ? _activeBucketColors[bucket] : SIM_DOT_COLOR,
    radius: size / 2,
    stroke: outline ? rgbaCss(outline.rgba) : 'rgba(0,0,0,0)',
    strokeWidth: outline ? outline.width : 0,
  };
}

function restyleDotsInPlace() {
  refreshBucketColors();
  for (const dot of _dots) dot.style = dotStyle(dot.road?.type, dot.bucket);
  renderRoadLines();
  writeDots(true);
}

function setStylePreset(name) {
  const next = (typeof name === 'string' && name) ? name : 'normal';
  if (next === _stylePreset) return;
  _stylePreset = next;
  restyleDotsInPlace();
}

const jamDensityOn = () => _jamViz === 'density' || _jamViz === 'both';
const heatlineOn = () => _jamViz === 'heatline' || _jamViz === 'both';

/**
 * Development timing counters. The Cesium-era `?trafficDebug=1` causal
 * timing was tied to Cesium's camera/render scheduling and was removed in the
 * MapLibre port; this stays as an inert diagnostic for callers/harnesses.
 * @returns {{enabled:boolean, marksInstalled:number, traceObjectsCreated:number,
 *   uncorrelatedTracesDropped:number}}
 */
export function getTrafficTimingDiagnostics() {
  return {
    enabled: false,
    marksInstalled: 0,
    traceObjectsCreated: 0,
    uncorrelatedTracesDropped: 0,
  };
}

/** Tile cache keyed by "s,w,n,e" (major-only and full road sets). */
const _tileCache = new Map();
const TILE_CACHE_MAX_ENTRIES = 64;

// ─── Overpass API ──────────────────────────────────────────

/**
 * Build an Overpass QL query for road ways within a bounding box.
 * @returns {string} Overpass QL query body.
 */
export function buildOverpassQuery(south, west, north, east, { majorOnly = false, timeoutSec = 25 } = {}) {
  const regex = majorOnly
    ? '^(motorway|trunk|primary|secondary)$'
    : '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$';
  return `[out:json][timeout:${timeoutSec}];(way["highway"~"${regex}"](${south},${west},${north},${east}););out geom qt;`;
}

async function fetchRoads(south, west, north, east, { majorOnly = false, timeoutSec = 25, signal } = {}) {
  const query = buildOverpassQuery(south, west, north, east, { majorOnly, timeoutSec });
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!response.ok) throw new Error(`Overpass API returned ${response.status}`);
  return response.json();
}

/** Metres between two [lon, lat] points (haversine). */
function segmentMeters(a, b) {
  return greatCircleKm(a[1], a[0], b[1], b[0]) * 1000;
}

/**
 * Parse an Overpass `out geom;` JSON response into internal road objects:
 * `{coords: [lon, lat][], type, oneway, segmentDist: metres[]}`.
 * @param {Object} overpassData
 * @returns {Array}
 */
export function parseRoads(overpassData) {
  if (!overpassData || !overpassData.elements) return [];
  const roads = [];
  for (const el of overpassData.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const rawCoords = el.geometry.map((g) => [g.lon, g.lat]);
    const simplifyStep = rawCoords.length > MAX_WAYPOINTS_PER_ROAD
      ? Math.ceil(rawCoords.length / MAX_WAYPOINTS_PER_ROAD)
      : 1;
    const coords = [];
    for (let i = 0; i < rawCoords.length; i += simplifyStep) coords.push(rawCoords[i]);
    const last = rawCoords[rawCoords.length - 1];
    const tail = coords[coords.length - 1];
    if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) coords.push(last);
    if (coords.length < 2) continue;

    const type = el.tags?.highway || 'unclassified';
    // One-way roads: dots travel the legal direction only.
    const onewayTag = el.tags?.oneway;
    const oneway = (onewayTag === 'yes' || onewayTag === '1' || onewayTag === 'true' || el.tags?.junction === 'roundabout')
      ? 1
      : (onewayTag === '-1' ? -1 : 0);
    const segmentDist = [];
    for (let i = 0; i < coords.length - 1; i++) segmentDist.push(segmentMeters(coords[i], coords[i + 1]));
    roads.push({ id: el.id, name: el.tags?.name || '', coords, type, oneway, segmentDist });
  }
  return roads;
}

// ─── Dot budget ────────────────────────────────────────────

function estimateRoadLengthM(road) {
  let len = 0;
  for (const d of road.segmentDist) len += d;
  return len;
}

function computeDotCount(road, altitude) {
  const flow = _liveMode ? road.flow : null;
  if (flow?.closure) return 0;
  if (_liveMode && !flow && _uncoveredMode === 'hide') return 0;
  const lengthM = estimateRoadLengthM(road);
  let spacing;
  if (altitude < 1000) spacing = 30;
  else if (altitude < 3000) spacing = 80;
  else if (altitude < 5000) spacing = 150;
  else spacing = 250;
  const mult = (DENSITY_MULT[road.type] || 1)
    * _densityScale
    * (flow ? flowDensityMult(flow.level, { jamBoost: jamDensityOn() }) : 1);
  return Math.max(1, Math.floor((lengthM / spacing) * mult));
}

/**
 * Distribute a fixed dot budget fairly across roads (fairness seed, then
 * proportional, then largest remainder).
 * @returns {number[]} Per-road dot budgets.
 */
function allocateRoadDotBudgets(roads, altitude, dotCap) {
  const planned = roads.map((road) => computeDotCount(road, altitude));
  const budgets = new Array(roads.length).fill(0);
  let remaining = Math.max(0, dotCap);
  const firstPassOrder = planned
    .map((count, index) => ({ count, index }))
    .sort((a, b) => b.count - a.count);
  for (const entry of firstPassOrder) {
    if (remaining <= 0) break;
    if (entry.count <= 0) continue;
    budgets[entry.index] = 1;
    remaining -= 1;
  }
  if (remaining <= 0) return budgets;
  let totalRemainder = 0;
  for (let i = 0; i < planned.length; i++) totalRemainder += Math.max(0, planned[i] - budgets[i]);
  if (totalRemainder <= 0) return budgets;
  const residuals = [];
  let assigned = 0;
  for (let i = 0; i < planned.length; i++) {
    const cap = Math.max(0, planned[i] - budgets[i]);
    if (cap <= 0) continue;
    const ideal = (cap / totalRemainder) * remaining;
    const add = Math.min(cap, Math.floor(ideal));
    budgets[i] += add;
    assigned += add;
    residuals.push({ index: i, residual: ideal - add });
  }
  let leftover = remaining - assigned;
  if (leftover > 0 && residuals.length > 0) {
    residuals.sort((a, b) => b.residual - a.residual);
    let cursor = 0;
    while (leftover > 0 && residuals.length > 0) {
      const idx = residuals[cursor % residuals.length].index;
      if (budgets[idx] < planned[idx]) {
        budgets[idx] += 1;
        leftover -= 1;
      }
      cursor += 1;
      if (cursor > residuals.length * 3 && leftover > 0) break;
    }
  }
  return budgets;
}

function spawnDotsForRoad(road, altitude, budgetCount = null) {
  const flow = _liveMode ? road.flow : null;
  if (flow?.closure) return;
  if (_liveMode && !flow && _uncoveredMode === 'hide') return;
  const count = Number.isFinite(budgetCount) ? Math.max(0, Math.floor(budgetCount)) : computeDotCount(road, altitude);
  const numSegments = road.coords.length - 1;
  if (numSegments < 1 || count <= 0) return;

  const baseMps = SPEED_MPS[road.type] || 5;
  const bucket = flow ? flowBucket(flow.level) : null;
  const style = dotStyle(road.type, bucket);
  const flowSpeed = flow ? flowSpeedScale(flow.level) : 1;
  const now = Date.now();

  let placements = null;
  if (bucket === 'jam' && jamDensityOn()) {
    const platoons = queuePlatoons(estimateRoadLengthM(road), count);
    if (platoons.length) {
      placements = [];
      for (let p = 0; p < platoons.length; p++) {
        const dir = road.oneway ? road.oneway : ((p % 2 === 0) ? 1 : -1);
        for (const s of platoons[p]) {
          const { segIdx, t } = locateAlongRoad(road.segmentDist, s);
          placements.push({ segIdx, t, direction: dir });
        }
      }
    }
  }

  for (let i = 0; i < count; i++) {
    if (_dots.length >= MAX_DOTS) return;
    const placement = placements?.[i];
    const segIdx = placement ? placement.segIdx : Math.floor(Math.random() * numSegments);
    const t = placement ? placement.t : Math.random();
    const noisedMps = baseMps * _speedScale * (0.7 + Math.random() * 0.6);
    const direction = placement
      ? placement.direction
      : (road.oneway ? road.oneway : ((i % 2 === 0) ? 1 : -1));
    _bucketCounts[bucket || 'sim'] += 1;
    _dots.push({
      road,
      bucket,
      style,
      segIdx: Math.min(segIdx, numSegments - 1),
      t,
      numSegments,
      mps: noisedMps * flowSpeed,
      baseMps: noisedMps,
      direction,
      stoppedUntil: 0,
      creep: (bucket === 'jam' && jamDensityOn())
        ? { moving: Math.random() < 0.4, until: now + Math.random() * 2000 }
        : null,
    });
  }
}

/** Current [lon, lat] of a dot (linear interpolation along its segment). */
function dotLonLat(dot) {
  const a = dot.road.coords[dot.segIdx];
  const b = dot.road.coords[dot.segIdx + 1] || a;
  return [a[0] + (b[0] - a[0]) * dot.t, a[1] + (b[1] - a[1]) * dot.t];
}

// ─── Animation ─────────────────────────────────────────────

function advanceDots(now, dt) {
  for (let i = 0; i < _dots.length; i++) {
    const dot = _dots[i];
    if (now < dot.stoppedUntil) continue;
    let burst = 1;
    if (dot.creep) {
      if (now >= dot.creep.until) {
        dot.creep.moving = !dot.creep.moving;
        const [lo, hi] = dot.creep.moving ? CREEP_MOVE_MS : CREEP_STOP_MS;
        dot.creep.until = now + lo + Math.random() * (hi - lo);
      }
      if (!dot.creep.moving) continue;
      burst = CREEP_BURST;
    }
    const segLen = dot.road.segmentDist[dot.segIdx] || 1;
    dot.t += ((dot.mps * burst * dt) / segLen) * dot.direction;
    if (dot.t >= 1.0) {
      dot.t -= 1.0;
      dot.segIdx++;
      if (dot.segIdx >= dot.numSegments) {
        dot.segIdx = 0;
        dot.t = Math.random() * 0.3;
      }
      maybeStopLight(dot, now);
    } else if (dot.t <= 0.0) {
      dot.t += 1.0;
      dot.segIdx--;
      if (dot.segIdx < 0) {
        dot.segIdx = dot.numSegments - 1;
        dot.t = 1.0 - Math.random() * 0.3;
      }
      maybeStopLight(dot, now);
    }
    dot.t = Math.min(1, Math.max(0, dot.t));
  }
}

function maybeStopLight(dot, now) {
  const nearEnd = dot.segIdx <= 1 || dot.segIdx >= dot.numSegments - 2;
  if (nearEnd && Math.random() < 0.008) dot.stoppedUntil = now + 2000 + Math.random() * 4000;
}

function writeDots(force = false) {
  const now = performance.now();
  if (!force && now - _lastDotWrite < DOT_FRAME_MS) return;
  _lastDotWrite = now;
  const features = new Array(_dots.length);
  for (let i = 0; i < _dots.length; i++) {
    const dot = _dots[i];
    features[i] = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: dotLonLat(dot) },
      properties: {
        c: dot.style.color,
        r: dot.style.radius,
        sc: dot.style.stroke,
        sw: dot.style.strokeWidth,
        b: dot.bucket || 'sim',
      },
    };
  }
  _map?.getSource(SRC_DOTS)?.setData({ type: 'FeatureCollection', features });
  if (heatlineOn() && _heatLineCount && _map?.getLayer(LYR_HEAT)) {
    const alpha = HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA * Math.sin(Date.now() / 260);
    _map.setPaintProperty(LYR_HEAT, 'line-opacity', Math.max(0.2, alpha + 0.2));
  }
}

function animate() {
  _raf = 0;
  if (!_enabled) return;
  const now = Date.now();
  const dt = _lastAnimTime ? Math.min((now - _lastAnimTime) / 1000, 0.1) : 0.016;
  _lastAnimTime = now;
  if (_dots.length && typeof document !== 'undefined' && !document.hidden) {
    advanceDots(now, dt);
    writeDots();
  }
  _raf = requestAnimationFrame(animate);
}

function startAnimation() {
  if (!_raf && typeof requestAnimationFrame === 'function') {
    _lastAnimTime = 0;
    _raf = requestAnimationFrame(animate);
  }
}

function stopAnimation() {
  if (_raf) cancelAnimationFrame(_raf);
  _raf = 0;
}

// ─── Camera / view ─────────────────────────────────────────

function getCameraAltitude() {
  return cameraAltitudeM(_engine);
}

function getViewBounds() {
  const b = _map?.getBounds?.();
  if (!b) return null;
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

/**
 * Fetch center = the map's look-at point (view center), pulled back toward
 * the camera nadir when it is far away (oblique/horizon views).
 */
function getFetchCenter() {
  const view = _engine?.getCameraView?.();
  if (!view) return null;
  return deriveFetchCenter({
    nadirLat: Number.isFinite(view.lat) ? view.lat : view.targetLat,
    nadirLon: Number.isFinite(view.lon) ? view.lon : view.targetLon,
    hitLat: view.targetLat,
    hitLon: view.targetLon,
    maxPullKm: MAX_LOOKAT_PULL_KM,
  });
}

function getBoundsCenter(bounds) {
  return { lat: (bounds.south + bounds.north) / 2, lon: (bounds.west + bounds.east) / 2 };
}

function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * 111;
  const avgLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLon = (a.lon - b.lon) * 111 * Math.cos(avgLat);
  return Math.sqrt((dLat * dLat) + (dLon * dLon));
}

function boundsOverlap(a, b, threshold) {
  const overlapS = Math.max(a.south, b.south);
  const overlapN = Math.min(a.north, b.north);
  const overlapW = Math.max(a.west, b.west);
  const overlapE = Math.min(a.east, b.east);
  if (overlapN <= overlapS || overlapE <= overlapW) return false;
  const overlapArea = (overlapN - overlapS) * (overlapE - overlapW);
  const aArea = (a.north - a.south) * (a.east - a.west);
  return aArea > 0 && (overlapArea / aArea) >= threshold;
}

function clampBounds(bounds) {
  return clampBoundsAroundCenter(bounds, getBoundsCenter(bounds));
}

/** Camera-settle handler: gate by altitude, skip small moves, debounce the load. */
function onCameraChanged() {
  if (!_enabled || !_engine) return;
  const alt = getCameraAltitude();
  if (alt > ACTIVATION_ALTITUDE) {
    clearDots();
    _lastBounds = null;
    _lastViewCenter = null;
    return;
  }
  const bounds = getViewBounds();
  if (!bounds) return;
  const fetchCenter = getFetchCenter();
  const clamped = fetchCenter ? clampBoundsAroundCenter(bounds, fetchCenter) : clampBounds(bounds);
  const center = getBoundsCenter(clamped);
  if (
    _lastBounds
    && _lastViewCenter
    && boundsOverlap(clamped, _lastBounds, OVERLAP_THRESHOLD)
    && distanceKm(center, _lastViewCenter) < MIN_CENTER_SHIFT_KM
  ) {
    return;
  }
  clearTimeout(_fetchTimeout);
  _fetchTimeout = setTimeout(() => loadRoadsForBounds(clamped, alt), FETCH_DEBOUNCE);
}

function cancelActiveFetch() {
  if (_activeFetchAbort) {
    _activeFetchAbort.abort();
    _activeFetchAbort = null;
  }
}

// ─── Live Flow (TomTom) ────────────────────────────────────

/**
 * Map a failed flow fetch onto one short, honest user-facing reason.
 * @param {Error|{name?:string, message?:string}|null|undefined} error
 * @returns {string|null} Short reason, or null for an aborted (superseded) fetch.
 */
export function deriveTrafficFlowError(error) {
  if (!error || error.name === 'AbortError') return null;
  const message = String(error.message || error);
  const status = Number(message.match(/HTTP (\d{3})/)?.[1]);
  if (status === 503) return 'TomTom key unavailable';
  if (status === 429) return 'TomTom daily budget reached';
  if (status === 502 || status === 504) return 'TomTom upstream unreachable';
  if (Number.isFinite(status)) return `TomTom flow error (HTTP ${status})`;
  return 'TomTom flow unavailable';
}

/**
 * Derive the layer's honest feed presentation from its live-flow state:
 * keyless → `mode:'sim'` (FALLBACK chip) with a label that never claims live
 * data; live and healthy → LIVE with real coverage; live but flow-down → an
 * `error` string saying the colors on screen are simulated.
 * @returns {{mode:'live'|'sim', error:string|null, loadingLabel:string}}
 */
export function trafficFeedPresentation({
  liveMode = false,
  fetching = false,
  flowError = null,
  coveragePct = 0,
  statusUnavailable = false,
} = {}) {
  const mode = liveMode ? 'live' : 'sim';
  if (liveMode && flowError) {
    const degraded = `SIMULATED — ${flowError}`;
    return { mode, error: degraded, loadingLabel: degraded };
  }
  if (liveMode) {
    return {
      mode,
      error: null,
      loadingLabel: fetching
        ? 'syncing LIVE traffic flow'
        : `LIVE · TomTom flow · ${coveragePct}% cov`,
    };
  }
  return {
    mode,
    error: null,
    loadingLabel: statusUnavailable
      ? 'SIMULATED — traffic service unreachable'
      : 'SIMULATED — add TomTom key for live',
  };
}

/** Check `/api/tomtom/status` once per session and cache the result. */
function ensureFlowStatus() {
  if (!_flowStatusPromise) {
    _flowStatusPromise = fetch('/api/tomtom/status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((status) => {
        _liveMode = Boolean(status?.hasKey);
        _flowStatusUnavailable = false;
        if (_liveMode) {
          console.log('[Data:Traffic] TomTom key present — live flow mode');
          registerDynamicCredit(_engine, TOMTOM_CREDIT);
        }
      })
      .catch((e) => {
        _liveMode = false;
        _flowStatusUnavailable = true;
        console.warn('[Data:Traffic] TomTom status unreachable — simulated traffic:', e?.message || e);
      });
  }
  return _flowStatusPromise;
}

async function applyFlowToRoads(roads, clamped, generation) {
  _flowPending += 1;
  try {
    if (!_flowStatusPromise) return;
    await _flowStatusPromise;
    if (!_liveMode || !_enabled) return;
    if (generation !== _loadGeneration) return;
    if (!Array.isArray(roads) || roads.length === 0) return;
    try {
      if (!_activeFetchAbort) _activeFetchAbort = new AbortController();
      const segments = await fetchFlowForBounds(clamped, { signal: _activeFetchAbort.signal });
      if (generation !== _loadGeneration) return;
      const { matches, matchedCount, candidateCount } = matchFlowToRoads(roads, segments);
      for (let i = 0; i < roads.length; i++) roads[i].flow = matches[i];
      _flowCoveragePct = candidateCount > 0 ? Math.round((matchedCount / candidateCount) * 100) : 0;
      _flowError = null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (generation !== _loadGeneration || !_enabled) return;
      _flowError = deriveTrafficFlowError(e);
      _flowCoveragePct = 0;
      console.warn('[Data:Traffic] Flow fetch failed (sim colors remain):', e?.message || e);
    }
  } finally {
    _flowPending -= 1;
  }
}

/** Ms the first paint waits for flow; late flow recolors in place. */
const FLOW_RENDER_RACE_MS = 250;

async function applyFlowThenRender(roads, clamped, generation, altitude, label) {
  const flowJob = applyFlowToRoads(roads, clamped, generation);
  const outcome = await Promise.race([
    flowJob.then(() => 'flow'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), FLOW_RENDER_RACE_MS)),
  ]);
  if (generation !== _loadGeneration) return false;
  renderRoadsForAltitude(roads, altitude, label);
  if (outcome === 'timeout') {
    flowJob.then(() => {
      if (generation !== _loadGeneration) return;
      recolorDotsInPlace(label);
    }).catch(() => { /* applyFlowToRoads settles its own failures */ });
  }
  return true;
}

function recolorDotsInPlace(label) {
  if (!_liveMode || !_dots.length) return;
  _bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
  const now = Date.now();
  const kept = [];
  for (const dot of _dots) {
    const flow = dot.road ? dot.road.flow : null;
    if (flow?.closure) continue;
    const bucket = flow ? flowBucket(flow.level) : null;
    dot.bucket = bucket;
    dot.style = dotStyle(dot.road?.type, bucket);
    dot.mps = dot.baseMps * (flow ? flowSpeedScale(flow.level) : 1);
    if (bucket === 'jam' && jamDensityOn()) {
      if (!dot.creep) dot.creep = { moving: Math.random() < 0.4, until: now + Math.random() * 2000 };
    } else {
      dot.creep = null;
    }
    _bucketCounts[bucket || 'sim'] += 1;
    kept.push(dot);
  }
  _dots = kept;
  _count = _dots.length;
  _closedRoads = _roads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0);
  renderRoadLines();
  writeDots(true);
  console.log(`[Data:Traffic] Flow recolor (${label}): ${_dots.length} dots`);
}

function visibleRoadsForAltitude(roads, altitude) {
  return altitude > 5000
    ? roads.filter((r) => r.type === 'motorway' || r.type === 'trunk' || r.type === 'primary')
    : roads;
}

/** Road network lines (+ heat-lines for congested roads in heatline mode). */
function renderRoadLines() {
  const roads = visibleRoadsForAltitude(_roads, _lastRenderAltitude);
  const features = [];
  let heat = 0;
  for (const road of roads) {
    const flow = _liveMode ? road.flow : null;
    const bucket = flow ? (flow.closure ? 'closed' : flowBucket(flow.level)) : null;
    if (_liveMode && !flow && _uncoveredMode === 'hide') continue;
    const color = bucket === 'closed'
      ? 'rgba(20,20,20,0.85)'
      : bucket ? _activeBucketColors[bucket] : SIM_ROAD_COLOR;
    const isHeat = heatlineOn() && (bucket === 'jam' || bucket === 'slow') && heat < HEAT_LINE_CAP;
    if (isHeat) heat += 1;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: road.coords },
      properties: {
        c: color,
        w: ROAD_WIDTH_BY_TYPE[road.type] || 1,
        b: bucket || 'sim',
        t: road.type,
        n: road.name || '',
        heat: isHeat ? (bucket === 'jam' ? 9 : 4) : 0,
        hc: bucket === 'jam' ? FLOW_BUCKET_COLORS.jam : 'rgba(240,178,62,0.35)',
      },
    });
  }
  _heatLineCount = heat;
  _map?.getSource(SRC_ROADS)?.setData({ type: 'FeatureCollection', features });
}

function renderRoadsForAltitude(roads, altitude, label) {
  clearDots();
  _roads = roads;
  _lastRenderAltitude = altitude;
  const filteredRoads = visibleRoadsForAltitude(roads, altitude);
  _closedRoads = _liveMode ? filteredRoads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0) : 0;
  const roadBudgets = allocateRoadDotBudgets(filteredRoads, altitude, MAX_DOTS);
  for (let i = 0; i < filteredRoads.length; i++) {
    const budget = roadBudgets[i] || 0;
    if (budget <= 0) continue;
    spawnDotsForRoad(filteredRoads[i], altitude, budget);
    if (_dots.length >= MAX_DOTS) break;
  }
  renderRoadLines();
  writeDots(true);
  _count = _dots.length;
  _lastUpdate = Date.now();
  console.log(`[Data:Traffic] ${label}: ${_count} dots (roads=${roads.length}, alt=${Math.round(altitude)}m)`);
}

async function loadRoadsForBounds(bounds, altitude) {
  const generation = ++_loadGeneration;
  cancelActiveFetch();
  const clamped = clampBounds(bounds);
  const cacheKey = `${clamped.south.toFixed(4)},${clamped.west.toFixed(4)},${clamped.north.toFixed(4)},${clamped.east.toFixed(4)}`;

  // Live mode: warm the flow-tile cache concurrently with the road fetch.
  ensureFlowStatus().then(() => {
    if (_liveMode && _enabled && generation === _loadGeneration) {
      fetchFlowForBounds(clamped, {}).catch(() => { /* warm-up only */ });
    }
  });

  _fetching = true;
  // Commit the overlap gate only if something renders (a failed fetch must
  // not stop a parked user from retrying).
  const prevBounds = _lastBounds;
  const prevViewCenter = _lastViewCenter;
  _lastBounds = clamped;
  _lastViewCenter = getBoundsCenter(clamped);
  let renderedSomething = false;

  try {
    let cache = _tileCache.get(cacheKey);
    if (!cache) {
      if (_tileCache.size >= TILE_CACHE_MAX_ENTRIES) _tileCache.delete(_tileCache.keys().next().value);
      cache = { major: null, full: null };
      _tileCache.set(cacheKey, cache);
    }
    if (cache.full) {
      renderedSomething = await applyFlowThenRender(cache.full, clamped, generation, altitude, 'Cache full');
      return;
    }
    if (cache.major) {
      if (!await applyFlowThenRender(cache.major, clamped, generation, altitude, 'Cache major')) return;
      renderedSomething = true;
    } else {
      _activeFetchAbort = new AbortController();
      const majorData = await fetchRoads(
        clamped.south, clamped.west, clamped.north, clamped.east,
        { majorOnly: true, timeoutSec: 12, signal: _activeFetchAbort.signal },
      );
      if (generation !== _loadGeneration) return;
      cache.major = parseRoads(majorData);
      if (!await applyFlowThenRender(cache.major, clamped, generation, altitude, 'Loaded major')) return;
      renderedSomething = true;
    }
    if (altitude > FAST_FETCH_ALTITUDE) return;
    _activeFetchAbort = new AbortController();
    const fullData = await fetchRoads(
      clamped.south, clamped.west, clamped.north, clamped.east,
      { majorOnly: false, timeoutSec: 20, signal: _activeFetchAbort.signal },
    );
    if (generation !== _loadGeneration) return;
    cache.full = parseRoads(fullData);
    if (!await applyFlowThenRender(cache.full, clamped, generation, altitude, 'Loaded full')) return;
    renderedSomething = true;
  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.warn('[Data:Traffic] Fetch error:', e);
  } finally {
    if (generation === _loadGeneration) {
      _fetching = false;
      if (!renderedSomething) {
        _lastBounds = prevBounds;
        _lastViewCenter = prevViewCenter;
      }
    }
    _activeFetchAbort = null;
  }
}

function clearDots() {
  _dots = [];
  _roads = [];
  _count = 0;
  _bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
  _closedRoads = 0;
  _heatLineCount = 0;
  _map?.getSource(SRC_DOTS)?.setData(EMPTY_FC);
  _map?.getSource(SRC_ROADS)?.setData(EMPTY_FC);
}

// ─── MapLibre layer definition ─────────────────────────────

const TRAFFIC_LAYER_DEF = defineLayer({
  id: 'traffic',
  name: 'Street Traffic',
  category: 'Contexto',
  icon: '🚗',
  source: 'OpenStreetMap',
  sources: {
    [SRC_ROADS]: { type: 'geojson', data: EMPTY_FC, attribution: '© OpenStreetMap (Overpass)' },
    [SRC_DOTS]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      id: LYR_HEAT,
      type: 'line',
      source: SRC_ROADS,
      filter: ['>', ['get', 'heat'], 0],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'hc'], 'line-width': ['get', 'heat'], 'line-blur': 3, 'line-opacity': 0.75 },
    },
    {
      id: LYR_ROADS,
      type: 'line',
      source: SRC_ROADS,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['get', 'c'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['*', ['get', 'w'], 0.6], 17, ['*', ['get', 'w'], 1.8]],
        'line-opacity': ['case', ['==', ['get', 'b'], 'sim'], 1, 0.7],
      },
    },
    {
      id: LYR_DOTS,
      type: 'circle',
      source: SRC_DOTS,
      paint: {
        'circle-color': ['get', 'c'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, ['*', ['get', 'r'], 0.6], 17, ['*', ['get', 'r'], 1.4]],
        'circle-stroke-color': ['get', 'sc'],
        'circle-stroke-width': ['get', 'sw'],
      },
    },
  ],
  interactive: [LYR_ROADS],
  tooltip: (props) => {
    const bucket = props.b;
    const state = bucket === 'sim'
      ? (_liveMode ? 'sem dado de fluxo (simulado)' : 'simulado (sem chave TomTom)')
      : { free: 'fluxo livre', slow: 'lento', jam: 'congestionado', closed: 'interditada' }[bucket] || bucket;
    return `<b>${esc(props.n || props.t)}</b>${row('Via', props.t)}${row('Tráfego', state)}`;
  },
});

// ─── Data Layer Interface ──────────────────────────────────

/**
 * Traffic data layer (same interface as before; `engine` in place of `viewer`).
 * Self-updating: loads are camera-driven, no external tick (`updateInterval: 0`).
 */
const trafficLayer = {
  id: 'traffic',
  name: 'Street Traffic',
  icon: '🚗',
  source: 'OpenStreetMap',
  updateInterval: 0,

  /** Adds the (hidden) MapLibre sources/layers. @param {Object} engine */
  init(engine) {
    _engine = engine;
    _map = engine?.map || null;
    const host = getActiveLayerHost();
    host?.register(TRAFFIC_LAYER_DEF);
    host?.ensureAdded(TRAFFIC_LAYER_DEF);
    _dots = [];
    _roads = [];
    _count = 0;
    _lastUpdate = null;
    _lastBounds = null;
    _fetching = false;
    if (typeof document !== 'undefined') {
      setStylePreset(document.documentElement?.dataset?.gevStyle);
    }
    if (!_styleListenerBound && typeof window !== 'undefined') {
      window.addEventListener('gev:style-change', (event) => {
        setStylePreset(event?.detail?.style);
      });
      _styleListenerBound = true;
    }
    refreshBucketColors();
    return true;
  },

  /** Shows the layer, starts the animation and the camera-driven loads. */
  enable() {
    _enabled = true;
    getActiveLayerHost()?.setVisible(TRAFFIC_LAYER_DEF.id, true);
    ensureFlowStatus();
    startAnimation();
    if (!_offs.length && _engine) {
      _offs.push(_engine.on('moveend', onCameraChanged));
    }
    onCameraChanged();
    // Boot-order guard: retry until the first load commits (the persisted
    // state can re-enable traffic during the intro flight, above the gate).
    clearInterval(_enableKickTimer);
    _enableKickTimer = setInterval(() => {
      if (!_enabled || _lastUpdate) {
        clearInterval(_enableKickTimer);
        _enableKickTimer = null;
        return;
      }
      if (!_fetching) onCameraChanged();
    }, 1500);
    return true;
  },

  /** Hides the layer, cancels loads, clears dots and listeners. */
  disable() {
    _enabled = false;
    clearTimeout(_fetchTimeout);
    clearInterval(_enableKickTimer);
    _enableKickTimer = null;
    cancelActiveFetch();
    _loadGeneration++;
    stopAnimation();
    clearDots();
    _lastBounds = null;
    _lastViewCenter = null;
    _flowError = null;
    for (const off of _offs) off?.();
    _offs = [];
    getActiveLayerHost()?.setVisible(TRAFFIC_LAYER_DEF.id, false);
    return true;
  },

  /** No-op — traffic updates are camera-driven. */
  async update() {
    return true;
  },

  /**
   * @param {Object} [params]
   * @param {number} [params.densityScale] - 0.2–2.5
   * @param {number} [params.speedScale] - 0.3–3.0
   * @param {'sim'|'hide'} [params.uncoveredRoads]
   * @param {'none'|'density'|'heatline'|'both'} [params.jamViz]
   * @param {'on'|'off'} [params.presetDots]
   */
  setParams(params = {}) {
    if (typeof params.densityScale === 'number') {
      _densityScale = Math.max(0.2, Math.min(2.5, params.densityScale));
    }
    if (typeof params.speedScale === 'number') {
      _speedScale = Math.max(0.3, Math.min(3.0, params.speedScale));
    }
    if (params.uncoveredRoads === 'sim' || params.uncoveredRoads === 'hide') {
      _uncoveredMode = params.uncoveredRoads;
    }
    if (['none', 'density', 'heatline', 'both'].includes(params.jamViz)) {
      _jamViz = params.jamViz;
      renderRoadLines();
    }
    if (params.presetDots === 'on' || params.presetDots === 'off') {
      if (params.presetDots !== _presetDots) {
        _presetDots = params.presetDots;
        restyleDotsInPlace();
      }
    }
    return true;
  },

  getParams() {
    return {
      densityScale: _densityScale,
      speedScale: _speedScale,
      uncoveredRoads: _uncoveredMode,
      jamViz: _jamViz,
      presetDots: _presetDots,
    };
  },

  /**
   * Sub-sampled dot positions for the detection overlay.
   * @returns {Array<{position:{lon:number,lat:number,height:number}, lon:number, lat:number, id:string, type:string, tier?:string}>}
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || _dots.length === 0) return [];
    const maxCount = Number.isFinite(options.maxCount) ? Math.max(1, Math.floor(options.maxCount)) : _dots.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(_dots.length / maxCount));
    const start = seed % stride;
    const result = [];
    for (let i = start; i < _dots.length; i += stride) {
      const [lon, lat] = dotLonLat(_dots[i]);
      const entry = {
        position: { lon, lat, height: 0 },
        lon,
        lat,
        id: `VEH-${String(i).padStart(4, '0')}`,
        type: 'VEH',
      };
      if (_liveMode) {
        const tier = trafficBucketTier(_dots[i].bucket || 'sim');
        if (tier) entry.tier = tier;
      }
      result.push(entry);
      if (result.length >= maxCount) break;
    }
    return result;
  },

  destroy() {
    this.disable();
    _tileCache.clear();
    resetFlowTileCache();
    _count = 0;
    _lastUpdate = null;
    return true;
  },

  /**
   * Layer statistics for the panel and the traffic sync chip. `mode` is the
   * CONFIGURED source ('live' key present / 'sim' keyless → FALLBACK chip);
   * `error` carries this instant's health.
   */
  getStats() {
    const loading = _fetching || _flowPending > 0;
    const feed = trafficFeedPresentation({
      liveMode: _liveMode,
      fetching: loading,
      flowError: _flowError,
      coveragePct: _flowCoveragePct,
      statusUnavailable: _flowStatusUnavailable,
    });
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      loading,
      mode: feed.mode,
      error: feed.error,
      flowCoveragePct: _flowCoveragePct,
      tilesFetched: getFlowSessionStats().tilesFetched,
      flowBuckets: { ..._bucketCounts },
      closedRoads: _closedRoads,
      heatLines: _heatLineCount,
      jamViz: _jamViz,
      stylePreset: _stylePreset,
      styleProfile: _presetDots === 'on' ? trafficStyleProfile(_stylePreset) : 'normal',
      loadingLabel: feed.loadingLabel,
    };
  },
};

export default trafficLayer;
