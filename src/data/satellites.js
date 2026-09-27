import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { findNextIssPass } from './issPass.js';
import {
  advanceSpriteFocus,
  focusAlphaNeedsWrite,
  focusPassIsNeeded,
  nearFarScalarValueAtDistance,
} from './focusDeemphasis.js';
import {
  satelliteClassColor,
  satelliteClassLabel,
  satelliteClassLegend,
  tallySatelliteClasses,
} from './satelliteClass.js';
import {
  clearTrackedSubjectContext,
  getContextStore,
  refreshTrackedSubjectContext,
  selectTrackedSubjectContext,
} from './contextStore.js';
import { isExplicitLayerStateOrigin } from './layerState.js';
import { cartesianFromDegrees, pathToLonLat, toDegrees } from './spaceGeo.js';
import { defineLayer, EMPTY_FC, esc, fc, row, TEXT_FONT_BOLD } from '../maplibre/kit.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';

/**
 * Satellites — posições em tempo real via TLE do CelesTrak + propagação SGP4,
 * desenhadas no MapLibre.
 *
 * Carrega seis grupos do CelesTrak (~840 satélites): stations, visual, GPS,
 * GLONASS, Galileo e o cinturão geoestacionário. O modo denso
 * (setParams({catalog: 'dense'})) acrescenta a casca Starlink como pontos
 * extras. Clique num satélite para rastreá-lo (câmera segue + órbita).
 *
 * DESENHO NO MAPLIBRE (decisão da migração)
 * -----------------------------------------
 * Cada satélite é desenhado no PONTO SUBSATÉLITE (a projeção da posição no
 * chão), como um círculo numa fonte GeoJSON, e a órbita como uma LINHA no chão
 * (o traço do anel orbital projetado). A altitude real aparece no tooltip, no
 * cartão do rastreado e nas APIs. Motivo da escolha, frente a uma custom layer
 * com os pontos em altitude (como o Osiris): assim os satélites usam o mesmo
 * anfitrião de hover/tooltip/clique das outras camadas (layerHost), o
 * `engine.pick`/`engine.project` e o acompanhamento `engine.track`, sem um
 * segundo caminho de picking por GPU; e o Osiris já precisa comprimir a
 * altitude (a GEO sairia do frustum), então a "altitude real" seria uma escala
 * de exibição de qualquer forma. O anel orbital, assado num GMST fixo, é
 * realinhado ao GMST atual a cada segundo por uma rotação rígida em Z, que em
 * coordenadas geodésicas é só um deslocamento de longitude.
 *
 * A ISS mantém o destaque vermelho, o rótulo "ISS" permanente e a órbita
 * mostrada por padrão.
 *
 * API PÚBLICA (a mesma do app Cesium; tipos Cesium trocados por neutros):
 *   default export — módulo do DataLayerManager (init/enable/disable/update/
 *     destroy/getStats/getRowControls/setRowControlsListener/getParams/setParams)
 *     mais getDetectableObjects, findByQuery, getAllPositions, trackById,
 *     resolveTrackingRestoreTarget, stopTracking, cancelPendingTrackingRestore,
 *     getTrackedInfo, getTrackedLabelModel.
 *   Onde havia Cesium.Cartesian3, `position` agora é um objeto simples {x, y, z}
 *   em ECEF WGS84 (mesmo formato; contas que só leem x/y/z seguem valendo), e os
 *   registros trazem também latitude/longitude/altitudeM.
 *   getSatelliteOrbitTrack / findSatelliteOrbitTrackInTle: `orbitPath` é uma
 *   lista de {x, y, z} ECEF (anel assado em `gmstAtBake`).
 *   orbitFrameModelMatrix devolve uma matriz 4x4 (Float64Array, coluna-major,
 *   layout do Cesium.Matrix4) e orbitFrameLongitudeShiftDeg o deslocamento de
 *   longitude equivalente, que é o que o MapLibre usa.
 *   O rastreio sai do `viewer.trackedEntity` para `engine.track(alvo)`; o alvo
 *   expõe `gevTrackedId` ('satellites:<NORAD>'), `layerId` e `getPosition()`.
 */

const ISS_NORAD = 25544;
const LAYER_ID = 'satellites';
export const ISS_OVERLAY_SOURCE_ID = 'satellites-iss';
export const ISS_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
  solveIntervalMs: 125,
});
const ORBIT_PATH_STEPS = 180;  // points per orbital path
const TICK_MS = 250;           // loop cadence (tracked dot + label)
const POSITION_UPDATE_MS = 1000; // fleet re-propagation (SGP4 is smooth at this rate)
const RING_ROTATION_MS = 1000;   // re-align baked orbit rings to current GMST every 1s

/**
 * CelesTrak groups loaded as the core catalog, in dedupe-priority order:
 * a satellite that appears in multiple groups keeps the FIRST (most specific)
 * tag. `path` is the upstream GROUP name forwarded by the /api/celestrak
 * proxy; `tag` is the internal group key used for POINT_STYLES lookup.
 * Note: CelesTrak's GLONASS group is named 'glo-ops' (not
 * 'glonass-operational' — that name 404s upstream).
 */
const CATALOG_GROUPS = [
  { tag: 'stations', path: 'stations' },
  { tag: 'visual', path: 'visual' },
  { tag: 'gps-ops', path: 'gps-ops' },
  { tag: 'glonass', path: 'glo-ops' },
  { tag: 'galileo', path: 'galileo' },
  { tag: 'geo', path: 'geo' },
];

// Dense-catalog mode (setParams({ catalog: 'dense' })): Starlink shell as
// points-only extras — no labels, no detection-overlay participation, and a
// relaxed propagation budget (round-robin, one full pass every ~5 s).
const DENSE_GROUP_PATH = 'starlink';
const DENSE_REFRESH_TICKS = Math.round(5000 / TICK_MS);
const DENSE_CREATE_CHUNK = 1500;   // satrec builds per macro-task while loading

/**
 * Altitude de câmera ao começar a seguir um satélite (a câmera olha o ponto
 * subsatélite de cima). LEO: ~3 000 km, o bastante para ver um bom trecho da
 * órbita; MEO/GEO: ~12 000 km para o anel caber na tela.
 */
const TRACK_CAMERA_ALT_LEO_M = 3_000_000;
const TRACK_CAMERA_ALT_HIGH_M = 12_000_000;
const HIGH_ORBIT_ALTITUDE_M = 2000000;

/**
 * Shared per-group point styling. Colors come from `satelliteClass.js` so the
 * dot, the class label on the card, and the legend swatch on the layer row can
 * never disagree. Only radius/outline live here — those encode per-group
 * prominence, not class. `radius` is the MapLibre circle radius (≈ Cesium
 * pixelSize / 2).
 */
const POINT_STYLES = {
  // The ISS keeps its own long-standing red hero styling rather than the
  // STATION class color: it is the object most users open this layer for, it
  // carries a permanent name label, and its size/outline already set it apart.
  iss: { radius: 6, color: '#ff4444', alpha: 1, strokeWidth: 2 },
  stations: { radius: 4, color: satelliteClassColor('stations'), alpha: 1, strokeWidth: 0 },
  visual: { radius: 3, color: satelliteClassColor('visual'), alpha: 1, strokeWidth: 0 },
  // Nav constellations (GPS / GLONASS / Galileo) resolve to one shared NAV color.
  'gps-ops': { radius: 3, color: satelliteClassColor('gps-ops'), alpha: 1, strokeWidth: 0 },
  glonass: { radius: 3, color: satelliteClassColor('glonass'), alpha: 1, strokeWidth: 0 },
  galileo: { radius: 3, color: satelliteClassColor('galileo'), alpha: 1, strokeWidth: 0 },
  geo: { radius: 2.5, color: satelliteClassColor('geo'), alpha: 1, strokeWidth: 0 },
  // Dense-mode extras (Starlink): dim, small, points-only.
  dense: { radius: 1.5, color: satelliteClassColor('dense'), alpha: 0.9, strokeWidth: 0 },
};

const TRACKED_COLOR = '#ffd84d';

/**
 * Resolve the canonical point style for a satellite.
 * @param {number} noradId NORAD catalog number.
 * @param {string|undefined} group Catalog group tag (see CATALOG_GROUPS / 'dense').
 */
function _pointStyleFor(noradId, group) {
  if (noradId === ISS_NORAD) return POINT_STYLES.iss;
  return POINT_STYLES[group] || POINT_STYLES.visual;
}

// Satellite catalog: { noradId → { name, satrec, group } }
let _catalog = new Map();
/**
 * noradId → última amostra propagada {longitude, latitude, altitude (m),
 * speedMps, position ({x,y,z} ECEF)}.
 */
let _points = new Map();
/** Stable lightweight records reused by the detection overlay between updates. */
let _detectionObjects = new Map();
/** noradId → { path: [{x,y,z}] (assado em gmstAtBake), gmstAtBake, color, width } */
let _orbitPaths = new Map();
let _count = 0;
let _lastUpdate = null;
/** @type {string|null} Surfaced feed error (e.g. CelesTrak outage) for the layer chip. */
let _lastError = null;
const _activeUpdateControllers = new Set();
let _denseLoadController = null;

function _abortActiveUpdates() {
  for (const controller of _activeUpdateControllers) controller.abort();
  _activeUpdateControllers.clear();
  _denseLoadController?.abort();
  _denseLoadController = null;
}

/** @type {object|null} engine do MapLibre (src/maplibre/engine.js) */
let _engine = null;
let _tickTimer = null;
let _tickCount = 0;
let _lastPropagation = 0;
let _lastRingRotation = 0;
let _engineListeners = [];
let _enabled = false;

// Click-to-track state
let _trackedNorad = null;
let _pendingTrackingRestore = null;
let _trackingIntentGeneration = 0;
let _trackingRefreshEpoch = 0;
let _lastTrackingRefreshOutcome = {
  epoch: 0,
  status: 'unavailable',
  failedGroups: [],
};
/** Alvo entregue a engine.track() enquanto um satélite é seguido. */
let _trackTarget = null;
/** Modelo do cartão do rastreado {title, details[], accent}. */
let _trackedLabelModel = null;

// Runtime params (DataLayerManager.setLayerParams path)
let _params = { catalog: 'core', showPoints: true, showOrbits: true }; // 'core' | 'dense'
let _denseIds = [];      // norad ids of dense extras, round-robin order
let _denseCursor = 0;    // next dense id to re-propagate
let _denseLoadToken = 0; // invalidates in-flight dense loads on mode flip/reload
let _denseLoadPromise = null;

/**
 * Dense-load lifecycle: 'idle' → 'loading' → 'ready' | 'failed'.
 * The catalog param flips synchronously but the Starlink shell arrives over
 * seconds and can fail outright (CelesTrak 502s this feed regularly), so the
 * row chip reports THIS, not the param. An active chip must mean dense points
 * are actually on screen.
 */
let _denseStatus = 'idle';
/** @type {string|null} Why the last dense load failed, for the chip tooltip. */
let _denseError = null;
/** Bumped on every bulk catalog mutation; keys the row-legend tally cache. */
let _catalogRevision = 0;
let _classTallyCache = { revision: -1, counts: null };
/** @type {(() => void)|null} Manager callback: "this layer's row controls changed". */
let _rowControlsListener = null;

/** Tell the manager to re-render this layer's row (chip state / legend counts). */
function _notifyRowControls() {
  try {
    _rowControlsListener?.();
  } catch (error) {
    console.warn('[Data:Satellites] row-controls listener failed:', error);
  }
}

/**
 * Per-class tally for the row legend, cached against the catalog revision.
 * Without the cache this scans ~10.7k entries in dense mode on every panel
 * refresh.
 * @returns {Record<string, number>} Class key → count.
 */
function _classTally() {
  if (_classTallyCache.counts && _classTallyCache.revision === _catalogRevision) {
    return _classTallyCache.counts;
  }
  const entries = [];
  // Pass the ISS flag, not just the group: during a stations-feed outage the
  // ISS is ingested as `visual`, and the legend must file it exactly where its
  // card does (STATION) rather than letting STATION vanish from the legend.
  for (const [noradId, sat] of _catalog) {
    entries.push({ group: sat.group, isIss: noradId === ISS_NORAD });
  }
  const counts = tallySatelliteClasses(entries);
  _classTallyCache = { revision: _catalogRevision, counts };
  return counts;
}

/**
 * Satellite preferences may be restored while the layer is disabled (for
 * example, when Space Missions releases its dependency). Preferences must not
 * revive render state until the layer is explicitly enabled again.
 * @param {boolean} layerEnabled Whether the Satellite layer is enabled.
 * @param {boolean} requestedVisible Whether the current presentation requests visibility.
 * @returns {boolean} Whether a visual should be visible now.
 */
export function satelliteVisualsVisible(layerEnabled, requestedVisible) {
  return Boolean(layerEnabled) && Boolean(requestedVisible);
}

/**
 * Decide whether a valid catalog request represents a real mode transition.
 * Reapplying an already-active mode must not restart the dense TLE load.
 * @param {'core'|'dense'} currentCatalog Current catalog mode.
 * @param {string|undefined} requestedCatalog Requested catalog mode.
 * @returns {boolean} Whether the catalog mode should change.
 */
export function satelliteCatalogModeChanged(currentCatalog, requestedCatalog) {
  return (requestedCatalog === 'core' || requestedCatalog === 'dense')
    && requestedCatalog !== currentCatalog;
}

/**
 * Entrada do rótulo ambiente da ISS no formato do anfitrião de rótulos
 * (worldOverlay). Mantida para o alocador de rótulos (worldOverlayAllocation);
 * no MapLibre o rótulo "ISS" é um symbol layer desta camada.
 */
export function createIssOverlayEntry(position) {
  return {
    id: String(ISS_NORAD),
    position,
    variant: 'label',
    title: 'ISS',
    accent: '#ff4444',
    priority: 1000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    distanceScale: {
      near: 1_000_000,
      nearValue: 1,
      far: 30_000_000,
      farValue: 0.4,
    },
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Physically DOCKED vehicles are separate real tracks sharing one position: the
 * station and everything berthed to it sit within metres of each other. Their
 * ambient labels would stack underneath the tracked card. This radius is
 * deliberately tight — it must catch a docked stack and nothing else, so an
 * unrelated satellite in a similar orbit is never suppressed. Formation-flying
 * pairs are km apart; a docked stack is ~100 m.
 */
const DOCKED_COMPANION_RADIUS_M = 2000;
/** The scan is O(points), so throttle. */
const DOCKED_SCAN_INTERVAL_MS = 1000;
/** @type {Set<number>} NORAD ids co-located with the tracked satellite. */
let _dockedCompanions = new Set();
let _lastDockedScanMs = Number.NEGATIVE_INFINITY;

/**
 * Rebuild the docked-companion set for the tracked satellite.
 * @returns {boolean} true when membership changed (callers resync presentation).
 */
function _refreshDockedCompanions(nowMs) {
  const trackedPosition = _trackedNorad === null ? null : _trackedFrameGeo?.position ?? null;
  if (!trackedPosition) {
    if (_dockedCompanions.size === 0) return false;
    _dockedCompanions = new Set();
    return true;
  }
  if (nowMs - _lastDockedScanMs < DOCKED_SCAN_INTERVAL_MS) return false;
  _lastDockedScanMs = nowMs;
  const radiusSq = DOCKED_COMPANION_RADIUS_M * DOCKED_COMPANION_RADIUS_M;
  let changed = false;
  let found = 0;
  const next = new Set();
  for (const [noradId, point] of _points) {
    if (noradId === _trackedNorad || !point?.position) continue;
    const dx = point.position.x - trackedPosition.x;
    const dy = point.position.y - trackedPosition.y;
    const dz = point.position.z - trackedPosition.z;
    if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
    next.add(noradId);
    found++;
    if (!_dockedCompanions.has(noradId)) changed = true;
  }
  if (found !== _dockedCompanions.size) changed = true;
  if (changed) _dockedCompanions = next;
  return changed;
}

/** Names of the docked companions, stable-sorted so the card text never churns. */
function _dockedCompanionNames() {
  const names = [];
  for (const noradId of _dockedCompanions) {
    names.push(_catalog.get(noradId)?.name?.trim() || `SAT-${noradId}`);
  }
  return names.sort();
}

/** O rótulo ambiente "ISS" aparece? (exclusivo com o cartão do rastreado) */
function _issLabelVisible() {
  return Boolean(
    _enabled && _params.showOrbits && _params.showPoints
    && _trackedNorad !== ISS_NORAD
    && !_dockedCompanions.has(ISS_NORAD)
    && _catalog.has(ISS_NORAD) && _points.get(ISS_NORAD),
  );
}

// Amostra do rastreado compartilhada por ponto, cartão, câmera e
// getTrackedInfo: uma propagação SGP4 por "quadro" (janela de 16 ms).
let _trackedFrameMs = Number.NEGATIVE_INFINITY;
let _trackedFrameGeo = null; // { longitude, latitude, altitude, speedMps, position } or null
/** Optional deterministic clock used only by the test seams. */
let _nowForTest = null;
const _now = () => (_nowForTest ? _nowForTest() : Date.now());

/**
 * Build the rigid ECEF transform that keeps an orbit path baked at one GMST
 * aligned with live SGP4 positions propagated at another epoch.
 * @param {number} gmstAtBake GMST used when the path positions were baked.
 * @param {Date} nowDate Epoch whose rotating-Earth frame should be displayed.
 * @param {Float64Array|number[]} [result] Optional 16-element array to update in place.
 * @returns {Float64Array|number[]} Column-major 4x4 Z-rotation (Cesium.Matrix4 layout).
 */
export function orbitFrameModelMatrix(gmstAtBake, nowDate, result = new Float64Array(16)) {
  const angle = -(gstime(nowDate) - gmstAtBake);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  result[0] = c; result[1] = s; result[2] = 0; result[3] = 0;
  result[4] = -s; result[5] = c; result[6] = 0; result[7] = 0;
  result[8] = 0; result[9] = 0; result[10] = 1; result[11] = 0;
  result[12] = 0; result[13] = 0; result[14] = 0; result[15] = 1;
  return result;
}

/**
 * The same GMST re-alignment as `orbitFrameModelMatrix`, expressed as the
 * longitude shift (degrees) a rigid Z-rotation applies to every point. A point
 * fixed in inertial space keeps its right ascension, so its ECEF longitude
 * DECREASES by ΔGMST as time advances (it drifts west).
 * @param {number} gmstAtBake GMST used when the path was baked.
 * @param {Date} nowDate Current epoch.
 * @returns {number} Longitude shift in degrees.
 */
export function orbitFrameLongitudeShiftDeg(gmstAtBake, nowDate) {
  return -toDegrees(gstime(nowDate) - gmstAtBake);
}

/**
 * Parse TLE text into array of { name, line1, line2 } objects.
 */
function parseTLE(text) {
  const lines = String(text || '').trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      result.push({ name, line1, line2 });
    }
  }
  return result;
}

/**
 * Propagate satellite position at a given JS Date.
 * Returns geodetic position plus inertial speed from the same SGP4 propagation
 * epoch, or null on error.
 */
function propagatePosition(satrec, date) {
  try {
    const posVel = propagate(satrec, date);
    if (!posVel.position || typeof posVel.position === 'boolean') return null;

    const gmst = gstime(date);
    const geo = eciToGeodetic(posVel.position, gmst);
    const velocity = posVel.velocity && typeof posVel.velocity !== 'boolean'
      ? posVel.velocity
      : null;
    const speedMps = velocity
      ? Math.hypot(velocity.x, velocity.y, velocity.z) * 1000
      : null;

    return {
      longitude: degreesLong(geo.longitude),
      latitude: degreesLat(geo.latitude),
      altitude: geo.height * 1000, // km → meters
      speedMps: Number.isFinite(speedMps) ? speedMps : null,
    };
  } catch {
    return null;
  }
}

/** Amostra propagada com a posição ECEF anexada. */
function _sampleAt(satrec, date) {
  const pos = propagatePosition(satrec, date);
  if (!pos) return null;
  pos.position = cartesianFromDegrees(pos.longitude, pos.latitude, pos.altitude);
  return pos;
}

function orbitalPeriodSeconds(satrec) {
  const meanMotion = satrec.no * (1440 / (2 * Math.PI));
  return 86400 / Math.max(meanMotion, 0.1);
}

/**
 * Compute full orbital path as array of ECEF {x,y,z} positions.
 * Steps around one full orbit based on the satellite's mean motion.
 */
function computeOrbitPath(satrec, referenceDate) {
  const periodSec = orbitalPeriodSeconds(satrec);
  const stepSec = periodSec / ORBIT_PATH_STEPS;

  const positions = [];
  const baseTime = referenceDate.getTime();
  // Fix GMST to reference time so the orbital ring closes.
  // Without this, Earth rotation during the orbit period (~24° for LEO)
  // shifts the end point west of the start, leaving a visible gap.
  const fixedGmst = gstime(referenceDate);

  for (let i = 0; i <= ORBIT_PATH_STEPS; i++) {
    const t = new Date(baseTime + i * stepSec * 1000);
    try {
      const posVel = propagate(satrec, t);
      if (!posVel.position || typeof posVel.position === 'boolean') continue;
      const geo = eciToGeodetic(posVel.position, fixedGmst);
      positions.push(cartesianFromDegrees(
        degreesLong(geo.longitude),
        degreesLat(geo.latitude),
        geo.height * 1000,
      ));
    } catch { continue; }
  }

  return positions;
}

/** Show the orbital path (ground track of the baked ring) for a satellite. */
function _showOrbitPath(noradId, color) {
  if (_orbitPaths.has(noradId)) return; // already showing
  const sat = _catalog.get(noradId);
  if (!sat) return;
  const bakeDate = new Date(_now());
  const path = computeOrbitPath(sat.satrec, bakeDate);
  if (path.length < 2) return;
  _orbitPaths.set(noradId, {
    path,
    // Same Date object as computeOrbitPath's internal fixedGmst → identical
    // GMST value (gstime is pure), so the shift starts at exactly 0.
    gmstAtBake: gstime(bakeDate),
    color: color || '#00ffff',
    width: noradId === ISS_NORAD ? 2.5 : 2,
  });
  _renderOrbits();
}

/** Remove orbital path for a satellite. */
function _hideOrbitPath(noradId) {
  if (_orbitPaths.delete(noradId)) _renderOrbits();
}

function _normalizeTrackedNorad(candidate) {
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : null;
}

function _emitAwarenessEvent(type, detail) {
  if (typeof window === 'undefined' || !window.dispatchEvent || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function _applyPendingTrackingRestore() {
  const pending = _pendingTrackingRestore;
  if (!pending || pending.generation !== _trackingIntentGeneration || !_enabled) return false;
  if (!_catalog.has(pending.id) || !_points.has(pending.id)) return false;
  _pendingTrackingRestore = null;
  _trackSatellite(pending.id, { origin: pending.origin });
  return _trackedNorad === pending.id;
}

function _cancelPendingTrackingRestore() {
  _trackingIntentGeneration += 1;
  _pendingTrackingRestore = null;
}

/**
 * Stop tracking the currently followed satellite.
 * @param {boolean} [skipEngineUntrack=false] - When ANOTHER layer just grabbed
 *   the follow-camera (engine 'trackedchange'), tear down our own state but do
 *   NOT clear engine.track — the new owner controls it now.
 */
function _clearTracking(skipEngineUntrack = false, { origin = 'programmatic' } = {}) {
  // Untracking dissolves the cluster: every companion returns to its own
  // ambient label on the next collection.
  _dockedCompanions = new Set();
  _lastDockedScanMs = Number.NEGATIVE_INFINITY;
  if (!_trackedNorad) {
    _renderTracked();
    return;
  }
  const clearedNorad = _trackedNorad;

  _trackedFrameMs = Number.NEGATIVE_INFINITY;
  _trackedFrameGeo = null;

  // Remove orbit path (unless ISS — keep its path)
  if (_trackedNorad !== ISS_NORAD) _hideOrbitPath(_trackedNorad);
  const target = _trackTarget;
  _trackTarget = null;
  _trackedLabelModel = null;
  if (!skipEngineUntrack && target && _engine?.trackedTarget === target) _engine.track?.(null);
  _trackedNorad = null;
  _renderTracked();
  _renderPoints();
  clearTrackedSubjectContext(LAYER_ID);
  _contextRefreshedAtMs = 0;
  _emitAwarenessEvent('gev:awareness-subject-cleared', {
    layerId: LAYER_ID, id: clearedNorad, origin,
  });
}

/**
 * Get the tracked satellite's geodetic position, propagated at most once per
 * ~16 ms "frame". All tracked-satellite consumers (camera follow, dot, card,
 * getTrackedInfo, context slot) share this single sample.
 * @returns {{ longitude: number, latitude: number, altitude: number, speedMps: number|null, position: {x,y,z} }|null}
 */
function _getTrackedFramePosition() {
  if (_trackedNorad === null) return null;
  const sat = _catalog.get(_trackedNorad);
  if (!sat) return null;

  const nowMs = _now();
  if (_trackedFrameGeo === null || Math.abs(nowMs - _trackedFrameMs) >= 16) {
    const pos = _sampleAt(sat.satrec, new Date(nowMs));
    if (!pos) return _trackedFrameGeo; // propagation hiccup — keep last good sample
    _trackedFrameGeo = pos;
    _trackedFrameMs = nowMs;
    _points.set(_trackedNorad, pos);
    // Throttled inside; membership changes are rare.
    const clusterChanged = _refreshDockedCompanions(nowMs);
    _updateTrackedSatelliteLabelModel();
    // The card and the context slot describe the same satellite — keep them
    // together so voice never narrates a fix the card has already replaced.
    _refreshTrackedSubjectContext();
    if (clusterChanged) _renderPoints();
  }
  return _trackedFrameGeo;
}

/** Epoch of the last shared-context refresh for the tracked satellite. */
let _contextRefreshedAtMs = 0;
/**
 * Shared-context refresh interval: the voice context only needs to be current
 * to about the propagation cadence.
 */
const CONTEXT_REFRESH_INTERVAL_MS = 1000;

/**
 * Describe the tracked satellite for the shared context slot the voice tools
 * read. Values come from the live propagation, not a selection-time snapshot.
 * @param {number} noradId Catalog identity.
 * @param {{latitude: number, longitude: number, altitude: number}|null} [position]
 * @returns {object|null} Context metadata, or null when the satellite is gone.
 */
function _contextSubjectMetadata(noradId, position = null) {
  const sat = _catalog.get(noradId);
  if (!sat) return null;
  const pos = position || _getTrackedFramePosition();
  if (!pos) return null;
  const name = sat.name?.trim() || `SAT-${noradId}`;
  const altitudeKm = Number.isFinite(pos.altitude) ? Math.round(pos.altitude / 1000) : null;
  return {
    id: String(noradId),
    layerId: LAYER_ID,
    layerName: 'Satellites',
    source: 'CelesTrak',
    label: name,
    latitude: pos.latitude,
    longitude: pos.longitude,
    // Flat text only: the voice payload compacts properties through a string
    // cleaner that drops nested objects.
    properties: {
      name,
      operator: '',
      noradId: String(noradId),
      class: satelliteClassLabel(sat.group, { isIss: noradId === ISS_NORAD }),
      altitude: altitudeKm === null ? '' : `${altitudeKm.toLocaleString('en-US')} km`,
    },
  };
}

/**
 * Reconcile the published subject with a freshly rebuilt catalog.
 *
 * A rebuild (dense↔core toggle, TLE refresh) clears and repopulates the
 * catalog. A surviving subject is simply re-resolved against it. A subject that
 * is GONE must release the slot — but releasing is gated on PROOF: the subject
 * is preserved unless it is absent from a catalog that is both complete
 * (`accepted`, no failed CelesTrak group) and applicable (dense settled, when
 * dense is the requested catalog). Unproven absence is not absence.
 * @returns {Promise<void>} Resolves once the applicable catalog has settled.
 */
async function _reconcileTrackedSubjectContext() {
  const subjectAtStart = _trackedNorad;
  if (subjectAtStart === null) return;
  // Dense extras land AFTER the core rebuild resolves.
  const denseSettlement = _params.catalog === 'dense' ? _denseLoadPromise : null;
  if (denseSettlement) {
    try {
      await denseSettlement;
    } catch {
      // A failed dense load proves nothing about the subject.
    }
  }
  // The operator may have moved on while we waited.
  if (_trackedNorad !== subjectAtStart) return;

  const metadata = _contextSubjectMetadata(subjectAtStart);
  if (metadata) {
    const store = getContextStore();
    const key = String(subjectAtStart);
    if (store.entities.has(key)) {
      refreshTrackedSubjectContext(metadata);
    } else if (!store.selectedEntityId) {
      // Restore only into an EMPTY slot: a satellite reappearing must never yank
      // the subject away from something the operator selected since.
      selectTrackedSubjectContext(metadata);
    }
    _contextRefreshedAtMs = Date.now();
    return;
  }

  // Absence only counts when EVERY catalog that could carry the subject
  // actually loaded (CelesTrak reclassifies satellites between groups).
  if (_catalog.size === 0) return;
  if (_lastTrackingRefreshOutcome?.status !== 'accepted') return;
  // Dense is a potential carrier whenever it was REQUESTED (read from the
  // settlement captured before the await: a failed dense load reverts the mode).
  if (denseSettlement && _denseStatus !== 'ready') return;
  clearTrackedSubjectContext(LAYER_ID);
  _contextRefreshedAtMs = 0;
}

/** Keep the shared context slot current with the tracked satellite. */
function _refreshTrackedSubjectContext() {
  if (_trackedNorad === null) return;
  const now = Date.now();
  if (now - _contextRefreshedAtMs < CONTEXT_REFRESH_INTERVAL_MS) return;
  _contextRefreshedAtMs = now;
  refreshTrackedSubjectContext(_contextSubjectMetadata(_trackedNorad));
}

/** Rebuild the tracked card model only when its text changes. */
function _updateTrackedSatelliteLabelModel(fallbackAltitudeM = null) {
  if (_trackedNorad === null) return;
  const sat = _catalog.get(_trackedNorad);
  const title = sat?.name?.trim() || `SAT-${_trackedNorad}`;
  const altitudeM = _trackedFrameGeo?.altitude ?? fallbackAltitudeM;
  const detail = `${Number.isFinite(altitudeM) ? Math.round(altitudeM / 1000) : '?'} km · NORAD ${_trackedNorad}`;
  // Class leads the detail block: it is what tells the operator WHAT they are
  // looking at.
  const details = [satelliteClassLabel(sat?.group, { isIss: _trackedNorad === ISS_NORAD }), detail];
  // Docked companions are consolidated onto the tracked card as SECONDARY info
  // instead of competing with it as separate ambient labels.
  const companions = _dockedCompanionNames();
  if (companions.length > 0) {
    const extra = companions.length - 1;
    details.push(`DOCKED · ${companions[0]}${extra > 0 ? ` · +${extra}` : ''}`);
  }
  const current = _trackedLabelModel;
  const unchanged = current?.title === title
    && current?.details?.length === details.length
    && details.every((line, index) => current.details[index] === line);
  if (unchanged) return;
  _trackedLabelModel = { title, details, accent: TRACKED_COLOR };
}

function _trackCameraAltitude(altitudeM) {
  return Number.isFinite(altitudeM) && altitudeM > HIGH_ORBIT_ALTITUDE_M
    ? TRACK_CAMERA_ALT_HIGH_M
    : TRACK_CAMERA_ALT_LEO_M;
}

function _trackSatellite(noradId, { origin = 'programmatic' } = {}) {
  _clearTracking(false, { origin });

  const sat = _catalog.get(noradId);
  if (!_points.get(noradId) || !sat) return;

  _trackedNorad = noradId;
  _trackedFrameMs = Number.NEGATIVE_INFINITY;
  _trackedFrameGeo = null;

  _showOrbitPath(noradId, TRACKED_COLOR);

  const name = sat.name.trim();
  const initialPos = _getTrackedFramePosition() || _points.get(noradId);
  _updateTrackedSatelliteLabelModel(initialPos?.altitude ?? null);

  // Alvo de acompanhamento da câmera (engine.track): o ponto subsatélite.
  const target = {
    id: `satellites:${noradId}`,
    gevTrackedId: `satellites:${noradId}`,
    gevSelectionOrigin: origin,
    layerId: LAYER_ID,
    noradId,
    releaseOnDrag: true,
    getPosition: () => {
      const pos = _getTrackedFramePosition();
      return pos ? { lon: pos.longitude, lat: pos.latitude, alt: pos.altitude } : null;
    },
    get gevLabelModel() {
      return _trackedLabelModel;
    },
  };
  _trackTarget = target;

  _emitAwarenessEvent('gev:awareness-subject-selected', {
    layerId: LAYER_ID,
    id: noradId,
    label: name,
    position: initialPos?.position ? { ...initialPos.position } : null,
    latitude: initialPos?.latitude,
    longitude: initialPos?.longitude,
    altitudeM: initialPos?.altitude,
    origin,
  });
  selectTrackedSubjectContext(_contextSubjectMetadata(noradId, initialPos));
  _contextRefreshedAtMs = Date.now();

  if (_engine?.track) {
    // Voo até ficar sobre o satélite e, a partir daí, a câmera acompanha.
    if (initialPos && typeof _engine.flyToCamera === 'function') {
      _engine.flyToCamera({
        lat: initialPos.latitude,
        lon: initialPos.longitude,
        alt: _trackCameraAltitude(initialPos.altitude),
        heading: 0,
        pitch: -90,
      }, { duration: 1.6 });
    }
    _engine.track(target);
  }
  _renderPoints();
  _renderTracked();
  console.log(`[Data:Satellites] Tracking ${name} (NORAD ${noradId})`);
}

/**
 * Propagate all CORE satellite positions (~840 sats ≈ 2 ms/pass). Dense extras
 * are excluded: they refresh on the round-robin budget in _propagateDenseChunk.
 */
function _propagateAll(date = new Date(_now())) {
  let updated = 0;
  for (const [noradId, sat] of _catalog) {
    if (sat.group === 'dense') continue;
    if (noradId === _trackedNorad) continue; // per-frame tracked path owns it
    const pos = _sampleAt(sat.satrec, date);
    if (!pos) continue;
    if (_points.has(noradId)) {
      _points.set(noradId, pos);
      updated++;
    }
  }
  return updated;
}

/**
 * Re-propagate one slice of the dense extras (round-robin): the full dense set
 * completes one pass every ~5 s, so the per-tick cost stays small even with
 * 10K+ Starlink satellites.
 */
function _propagateDenseChunk(date = new Date(_now())) {
  if (_denseIds.length === 0) return;
  const perTick = Math.max(1, Math.ceil(_denseIds.length / DENSE_REFRESH_TICKS));
  for (let i = 0; i < perTick; i++) {
    if (_denseCursor >= _denseIds.length) _denseCursor = 0;
    const noradId = _denseIds[_denseCursor++];
    if (noradId === _trackedNorad) continue;
    const sat = _catalog.get(noradId);
    if (!sat || !_points.has(noradId)) continue;
    const pos = _sampleAt(sat.satrec, date);
    if (pos) _points.set(noradId, pos);
  }
}

/**
 * Load the dense catalog extras (Starlink) as points-only satellites.
 * Chunked so ~10K twoline2satrec builds + initial propagations never block a
 * frame; a token guards against mode flips / catalog rebuilds mid-load.
 */
async function _loadDenseCatalog({ signal = null } = {}) {
  _denseLoadController?.abort();
  const resourceController = new AbortController();
  _denseLoadController = resourceController;
  const loadSignal = signal
    ? AbortSignal.any([signal, resourceController.signal])
    : resourceController.signal;
  const token = ++_denseLoadToken;
  _denseStatus = 'loading';
  _denseError = null;
  _notifyRowControls();
  try {
    loadSignal.throwIfAborted();
    const res = await fetch(`/api/celestrak/${DENSE_GROUP_PATH}`, { signal: loadSignal });
    if (!res.ok) {
      console.warn(`[Data:Satellites] Dense group '${DENSE_GROUP_PATH}' fetch failed (${res.status})`);
      _denseLoadFailed(token, `feed unavailable (${res.status})`);
      return { status: 'source-unavailable', reason: `feed unavailable (${res.status})` };
    }
    const text = await res.text();
    loadSignal.throwIfAborted();
    if (token !== _denseLoadToken || _params.catalog !== 'dense') {
      return { status: 'superseded', reason: 'dense-load-superseded' };
    }

    const entries = parseTLE(text);
    const now = new Date(_now());
    let added = 0;

    for (let start = 0; start < entries.length; start += DENSE_CREATE_CHUNK) {
      loadSignal.throwIfAborted();
      if (token !== _denseLoadToken || _params.catalog !== 'dense') {
        return { status: 'superseded', reason: 'dense-load-superseded' };
      }
      const end = Math.min(start + DENSE_CREATE_CHUNK, entries.length);
      for (let i = start; i < end; i++) {
        const entry = entries[i];
        const satrec = twoline2satrec(entry.line1, entry.line2);
        if (!satrec || satrec.error !== 0) continue;
        const noradId = Number(satrec.satnum);
        if (_catalog.has(noradId)) continue; // core catalog keeps priority
        const pos = _sampleAt(satrec, now);
        if (!pos) continue;
        _catalog.set(noradId, { name: entry.name, satrec, group: 'dense' });
        _points.set(noradId, pos);
        _denseIds.push(noradId);
        added++;
      }
      // Yield to the event loop between chunks.
      await new Promise(resolve => setTimeout(resolve, 0));
      loadSignal.throwIfAborted();
    }

    // A 200 that yields nothing usable is still a failed load — an empty body,
    // an HTML error page the proxy passed through, or a feed of TLEs the core
    // catalog already owns.
    if (added === 0) {
      console.warn(`[Data:Satellites] Dense group '${DENSE_GROUP_PATH}' returned no usable satellites`);
      _denseLoadFailed(token, 'feed returned no satellites');
      return { status: 'source-unavailable', reason: 'feed returned no satellites' };
    }

    _count = _points.size;
    _catalogRevision++;
    _denseStatus = 'ready';
    console.log(`[Data:Satellites] Dense catalog: +${added} ${DENSE_GROUP_PATH} (points only)`);
    _renderPoints();
    _notifyRowControls();
    _applyPendingTrackingRestore();
    return { status: 'ready', added };
  } catch (e) {
    if (loadSignal.aborted || e?.name === 'AbortError') {
      return { status: 'cancelled', reason: String(loadSignal.reason || 'aborted') };
    }
    console.warn('[Data:Satellites] Dense catalog load failed:', e);
    _denseLoadFailed(token, 'feed unreachable');
    return { status: 'source-unavailable', reason: 'feed unreachable' };
  } finally {
    if (_denseLoadController === resourceController) _denseLoadController = null;
  }
}

/**
 * Settle a failed dense load: drop any partial chunk, return the layer to the
 * core catalog, and leave the reason on the chip. Reverting the param is the
 * point — a chip that reads ACTIVE over an empty sky is a lie.
 */
function _denseLoadFailed(token, reason) {
  // A newer load (or a mode flip) already owns the state — say nothing.
  if (token !== _denseLoadToken) return;
  _params.catalog = 'core';
  _removeDenseCatalog();
  _denseStatus = 'failed';
  _denseError = reason;
  _notifyRowControls();
}

/** Remove all dense extras (catalog entries, points, tracking if needed). */
function _removeDenseCatalog() {
  _denseLoadController?.abort();
  _denseLoadController = null;
  _denseLoadToken++; // cancel any in-flight dense load
  if (_trackedNorad !== null && _catalog.get(_trackedNorad)?.group === 'dense') {
    _clearTracking();
  }
  for (const noradId of _denseIds) {
    _points.delete(noradId);
    _catalog.delete(noradId);
  }
  _denseIds = [];
  _denseCursor = 0;
  _count = _points.size;
  _catalogRevision++;
  _renderPoints();
}

// ------------------------------------------------------------ MapLibre

const SRC_POINTS = 'dg-sat-points';
const SRC_ORBITS = 'dg-sat-orbits';
const SRC_TRACKED = 'dg-sat-tracked';

function _tooltip(props) {
  const altKm = Number(props.altKm);
  return `<strong>${esc(props.name)}</strong>`
    + row('Classe', props.klass)
    + row('Altitude', Number.isFinite(altKm) ? `${altKm.toLocaleString('pt-BR')} km` : '')
    + row('NORAD', props.id)
    + row('Fonte', 'CelesTrak · SGP4');
}

/** Definição de estilo da camada (contrato em src/maplibre/kit.js). */
export const SATELLITES_LAYER_DEF = defineLayer({
  id: LAYER_ID,
  name: 'Satellites',
  category: 'Espaço',
  icon: '🛰️',
  source: 'CelesTrak',
  sources: {
    [SRC_ORBITS]: { type: 'geojson', data: EMPTY_FC },
    [SRC_POINTS]: { type: 'geojson', data: EMPTY_FC },
    [SRC_TRACKED]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      id: 'dg-sat-orbit-line',
      type: 'line',
      source: SRC_ORBITS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': 0.72,
      },
    },
    {
      id: 'dg-sat-pt',
      type: 'circle',
      source: SRC_POINTS,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['*', ['get', 'r'], 0.8], 6, ['*', ['get', 'r'], 1.4]],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'alpha'],
        'circle-stroke-color': 'rgba(255,255,255,0.3)',
        'circle-stroke-width': ['get', 'stroke'],
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: 'dg-sat-iss-label',
      type: 'symbol',
      source: SRC_POINTS,
      filter: ['==', ['get', 'issLabel'], 1],
      layout: {
        'text-field': 'ISS',
        'text-font': TEXT_FONT_BOLD,
        'text-size': 12,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.9],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ff6b6b',
        'text-halo-color': 'rgba(5,8,13,0.92)',
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'dg-sat-tracked-pt',
      type: 'circle',
      source: SRC_TRACKED,
      paint: {
        'circle-radius': 7,
        'circle-color': TRACKED_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: 'dg-sat-tracked-label',
      type: 'symbol',
      source: SRC_TRACKED,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT_BOLD,
        'text-size': 12,
        'text-line-height': 1.25,
        'text-max-width': 40,
        'text-anchor': 'bottom',
        'text-justify': 'center',
        'text-offset': [0, -1.1],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': TRACKED_COLOR,
        'text-halo-color': 'rgba(5,8,13,0.92)',
        'text-halo-width': 1.6,
      },
    },
  ],
  interactive: ['dg-sat-tracked-pt', 'dg-sat-pt'],
  tooltip: (props) => _tooltip(props),
  click: (props) => {
    const noradId = Number(props.id);
    if (!_enabled || !Number.isFinite(noradId) || !_catalog.has(noradId)) return;
    if (noradId === _trackedNorad) return; // clicking the tracked dot — ignore
    _cancelPendingTrackingRestore();
    _trackSatellite(noradId, { origin: 'user' });
  },
});

let _host = null;
function _setSource(id, data) {
  const map = _engine?.map;
  if (!map || typeof map.getSource !== 'function') return;
  map.getSource(id)?.setData(data);
}

function _pointFeatures() {
  if (!satelliteVisualsVisible(_enabled, _params.showPoints)) return EMPTY_FC;
  const issLabel = _issLabelVisible();
  const features = [];
  for (const [noradId, pos] of _points) {
    if (noradId === _trackedNorad) continue; // the tracked dot draws on its own source
    if (!pos || !Number.isFinite(pos.longitude) || !Number.isFinite(pos.latitude)) continue;
    const sat = _catalog.get(noradId);
    const style = _pointStyleFor(noradId, sat?.group);
    features.push({
      type: 'Feature',
      id: noradId,
      geometry: { type: 'Point', coordinates: [pos.longitude, pos.latitude] },
      properties: {
        id: noradId,
        name: sat?.name?.trim() || `SAT-${noradId}`,
        klass: satelliteClassLabel(sat?.group, { isIss: noradId === ISS_NORAD }),
        altKm: Math.round((pos.altitude || 0) / 1000),
        color: style.color,
        alpha: style.alpha,
        r: style.radius,
        stroke: style.strokeWidth,
        issLabel: noradId === ISS_NORAD && issLabel ? 1 : 0,
      },
    });
  }
  // Pontos maiores por cima (a ordem das feições é a ordem de desenho).
  features.sort((a, b) => a.properties.r - b.properties.r);
  return fc(features);
}

function _renderPoints() {
  if (!_engine?.map) return;
  _setSource(SRC_POINTS, _pointFeatures());
}

function _renderOrbits(nowDate = new Date(_now())) {
  if (!_engine?.map) return;
  if (!satelliteVisualsVisible(_enabled, _params.showOrbits)) {
    _setSource(SRC_ORBITS, EMPTY_FC);
    return;
  }
  const features = [];
  for (const [noradId, orbit] of _orbitPaths) {
    const coordinates = pathToLonLat(orbit.path, {
      lonShiftDeg: orbitFrameLongitudeShiftDeg(orbit.gmstAtBake, nowDate),
    });
    if (coordinates.length < 2) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { id: noradId, color: orbit.color, width: orbit.width },
    });
  }
  _setSource(SRC_ORBITS, fc(features));
}

function _renderTracked() {
  if (!_engine?.map) return;
  const pos = _trackedNorad !== null ? _trackedFrameGeo : null;
  if (!_enabled || !pos || !_trackedLabelModel) {
    _setSource(SRC_TRACKED, EMPTY_FC);
    return;
  }
  const sat = _catalog.get(_trackedNorad);
  _setSource(SRC_TRACKED, fc([{
    type: 'Feature',
    id: _trackedNorad,
    geometry: { type: 'Point', coordinates: [pos.longitude, pos.latitude] },
    properties: {
      id: _trackedNorad,
      name: _trackedLabelModel.title,
      klass: satelliteClassLabel(sat?.group, { isIss: _trackedNorad === ISS_NORAD }),
      altKm: Math.round((pos.altitude || 0) / 1000),
      label: [_trackedLabelModel.title, ..._trackedLabelModel.details].join('\n'),
    },
  }]));
}

/**
 * Laço da camada (substitui o scene.preRender do Cesium):
 * - frota core re-propagada a cada 1 s,
 * - extras densos num orçamento round-robin (passada completa a cada ~5 s),
 * - rastreado e seu cartão a cada tick (250 ms),
 * - anéis orbitais realinhados ao GMST a cada ~1 s.
 */
function _tick() {
  if (!_enabled) return;
  const nowMs = _now();
  const date = new Date(nowMs);
  _tickCount++;
  let pointsDirty = false;
  if (_params.showPoints && nowMs - _lastPropagation >= POSITION_UPDATE_MS) {
    _propagateAll(date);
    _lastPropagation = nowMs;
    pointsDirty = true;
  }
  if (_params.showPoints && _denseIds.length) {
    _propagateDenseChunk(date);
    pointsDirty = true;
  }
  if (_trackedNorad !== null) {
    _getTrackedFramePosition();
    _renderTracked();
  }
  if (pointsDirty && nowMs - _lastPointsRender >= POSITION_UPDATE_MS) {
    _lastPointsRender = nowMs;
    _renderPoints();
  }
  if (_params.showOrbits && _orbitPaths.size && nowMs - _lastRingRotation >= RING_ROTATION_MS) {
    _renderOrbits(date);
    _lastRingRotation = nowMs;
  }
}
let _lastPointsRender = 0;

function _startLoop() {
  if (_tickTimer || typeof setInterval !== 'function' || !_engine?.map) return;
  _tickTimer = setInterval(_tick, TICK_MS);
}

function _stopLoop() {
  if (_tickTimer) clearInterval(_tickTimer);
  _tickTimer = null;
}

function _onKeyDown(e) {
  if (_enabled && e.key === 'Escape' && _trackedNorad) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin: 'user' });
  }
}

/** Clique no vazio desmarca; clique noutra camada não mexe no nosso rastreio. */
function _onEngineClick(event) {
  if (!_enabled || !_trackedNorad || !_engine) return;
  const hit = _host?.pickAt?.(event.x, event.y);
  if (hit) return; // um satélite (tratado pelo click da definição) ou outra camada
  let features = [];
  try {
    features = _engine.pick?.(event.x, event.y, { radius: 4 }) || [];
  } catch {
    features = [];
  }
  // Feições de outra camada do app (prefixo dg-) = não é "espaço vazio".
  if (features.some((f) => String(f?.layer?.id || '').startsWith('dg-') && !String(f.layer.id).startsWith('dg-slot'))) return;
  _cancelPendingTrackingRestore();
  _clearTracking(false, { origin: 'user' });
}

/** Outra camada assumiu a câmera: largamos o nosso rastreio sem mexer no dela. */
function _onTrackedChange(target) {
  if (!_enabled || !_trackedNorad || !_trackTarget) return;
  if (target && target !== _trackTarget) {
    _clearTracking(true, { origin: target.gevSelectionOrigin || 'programmatic' });
  }
}

function _installInteraction() {
  if (!_engine?.on || _engineListeners.length) return;
  _engineListeners = [
    _engine.on('click', _onEngineClick),
    _engine.on('trackedchange', _onTrackedChange),
  ];
  if (typeof document !== 'undefined') document.addEventListener('keydown', _onKeyDown);
}

function _removeInteraction() {
  for (const off of _engineListeners) off?.();
  _engineListeners = [];
  if (typeof document !== 'undefined') document.removeEventListener('keydown', _onKeyDown);
}

function _attachToEngine(engine) {
  _engine = engine || null;
  if (!_engine?.map) return;
  _host = getActiveLayerHost();
  if (!_host) {
    console.warn('[Data:Satellites] anfitrião de camadas MapLibre ausente');
    return;
  }
  _host.register(SATELLITES_LAYER_DEF);
  _host.ensureAdded(SATELLITES_LAYER_DEF);
}

function _setHostVisible(visible) {
  if (_host && _engine?.map) _host.setVisible(LAYER_ID, visible);
}

function _renderAll() {
  _renderPoints();
  _renderOrbits();
  _renderTracked();
}

// ------------------------------------------------------------ test seams

/**
 * Seed the minimum state a dense-catalog load needs, so a test can exercise the
 * real async load/settle/fail path (and the row-control states it drives)
 * without a map.
 * @param {{ catalog?: 'core'|'dense', showPoints?: boolean }} [options]
 */
export function _setDenseCatalogStateForTest({ catalog = 'core', showPoints = true } = {}) {
  _engine = null;
  _host = null;
  _catalog = new Map();
  _points = new Map();
  _detectionObjects = new Map();
  _orbitPaths = new Map();
  _denseIds = [];
  _denseCursor = 0;
  _denseLoadToken++;
  _denseStatus = 'idle';
  _denseError = null;
  _catalogRevision++;
  _trackedNorad = null;
  _trackTarget = null;
  _trackedLabelModel = null;
  _cancelPendingTrackingRestore();
  _params = { catalog, showPoints, showOrbits: false };
  _enabled = true;
}

/** Tear the dense seam back down so ordering cannot leak into other tests. */
export function _clearDenseCatalogStateForTest() {
  _rowControlsListener = null;
  _orbitPaths = new Map();
  _engine = null;
  _host = null;
  _catalog = new Map();
  _points = new Map();
  _denseIds = [];
  _denseLoadToken++;
  _denseStatus = 'idle';
  _denseError = null;
  _params = { catalog: 'core', showPoints: true, showOrbits: true };
  _cancelPendingTrackingRestore();
  _enabled = false;
}

/** Catalog group tag recorded for a satellite, for ingestion-path assertions. */
export function _catalogGroupForTest(noradId) {
  return _catalog.get(Number(noradId))?.group;
}

/**
 * Seed a catalog (and optional fake engine) while retaining the production
 * tracking, label and context paths.
 * @param {object} state
 * @param {Array<{noradId:number,name:string,satrec:object,group?:string}>} state.satellites
 * @param {object} [state.engine] Fake engine ({track, trackedTarget, flyToCamera}).
 * @param {() => number} [state.now] Deterministic clock (ms).
 * @param {boolean} [state.preservePending]
 * @param {Map<number, {x:number,y:number,z:number}>|null} [state.positions]
 *   Optional fixed ECEF positions (neighbours of a docked cluster); a getter
 *   function per id is also accepted so a test can place a point relative to
 *   the tracked sample.
 */
export function _seedSatellitesForTest({
  satellites,
  engine = null,
  now = null,
  preservePending = false,
  positions = null,
  params = {},
}) {
  _engine = engine;
  _host = null;
  _nowForTest = now;
  _catalog = new Map();
  _points = new Map();
  _orbitPaths = new Map();
  _detectionObjects = new Map();
  const date = new Date(_now());
  for (const sat of satellites) {
    _catalog.set(sat.noradId, { name: sat.name, satrec: sat.satrec, group: sat.group || 'stations' });
    const fixed = positions?.get(sat.noradId);
    if (fixed) {
      const record = { longitude: 0, latitude: 0, altitude: 0, speedMps: null };
      Object.defineProperty(record, 'position', {
        get: typeof fixed === 'function' ? fixed : () => fixed,
        enumerable: true,
      });
      _points.set(sat.noradId, record);
    } else {
      const pos = _sampleAt(sat.satrec, date);
      if (pos) _points.set(sat.noradId, pos);
    }
  }
  _dockedCompanions = new Set();
  _lastDockedScanMs = Number.NEGATIVE_INFINITY;
  _trackedNorad = null;
  _trackTarget = null;
  _trackedLabelModel = null;
  if (!preservePending) _cancelPendingTrackingRestore();
  _trackedFrameMs = Number.NEGATIVE_INFINITY;
  _trackedFrameGeo = null;
  _enabled = true;
  _params = { catalog: 'core', showPoints: true, showOrbits: true, ...params };
}

/** Seed catalog authority and optional dense settlement for share-Follow tests. */
export function _setSatelliteTrackingRefreshOutcomeForTest({
  status = 'accepted',
  failedGroups = [],
  catalog = 'core',
  densePromise = null,
} = {}) {
  const epoch = ++_trackingRefreshEpoch;
  _lastTrackingRefreshOutcome = { epoch, status, failedGroups: [...failedGroups] };
  _params.catalog = catalog;
  _denseLoadPromise = densePromise || Promise.resolve({ status: 'not-requested' });
}

/** Run one tick of the layer loop (propagation, tracked sample, card). */
export function _runSatelliteTickForTest() {
  _tick();
}

/** The tracked satellite's current ECEF sample (what the docked scan measures against). */
export function _trackedFramePositionForTest() {
  return _trackedFrameGeo?.position ?? null;
}

/** Whether the ambient "ISS" label would be drawn now. */
export function _issLabelVisibleForTest() {
  return _issLabelVisible();
}

/** Current orbit rings (noradId list) — which rings the layer would draw. */
export function _orbitPathIdsForTest() {
  return [..._orbitPaths.keys()];
}

/** Return the deferred restore target held by the production tracker. */
export function _pendingSatelliteTrackingRestoreForTest() {
  return _pendingTrackingRestore?.id ?? null;
}

/** Exercise the production deferred-restore retry after a simulated catalog refresh. */
export function _applyPendingSatelliteTrackingRestoreForTest() {
  return _applyPendingTrackingRestore();
}

/** Remove a cached catalog row so tests can model a target arriving later. */
export function _removeSatelliteTrackingCandidateForTest(noradId) {
  const id = Number(noradId);
  _catalog.delete(id);
  _points.delete(id);
}

/** Exercise production untrack and reset the seeded state. */
export function _clearSatelliteSeedForTest() {
  _clearTracking();
  _enabled = false;
  _engine = null;
  _nowForTest = null;
  _catalog = new Map();
  _points = new Map();
  _orbitPaths = new Map();
}

/**
 * Apply the gated satellite-point focus pass through the production color path.
 * Pure (callbacks injected): no MapLibre dependency. Kept for the shared
 * focus-resume gate tests; the MapLibre render does not dim points around the
 * tracked satellite.
 * @param {object} input
 * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
 */
export function applySatellitePointFocusDeemphasis({
  points,
  trackedId,
  target,
  previousActiveCount = 0,
  nowMs,
  screenPositionFor,
  cameraDistanceFor,
  baseColorFor,
  params,
}) {
  if (!focusPassIsNeeded(target, previousActiveCount)) {
    return { writes: 0, transitioning: false, activeCount: 0, ran: false };
  }
  let writes = 0;
  let transitioning = false;
  let activeCount = 0;
  for (const [noradId, point] of points || []) {
    if (noradId === trackedId || !point?.position) continue;
    const cameraDistance = cameraDistanceFor(point.position);
    const distanceScale = nearFarScalarValueAtDistance(point.scaleByDistance, cameraDistance);
    const halfExtentPx = (point.pixelSize || 5) * distanceScale * 0.5;
    const focus = advanceSpriteFocus(point, {
      screenPosition: point.show === false ? null : screenPositionFor(point.position),
      cameraDistance,
      nowMs,
      target,
      params,
      spriteHalfWidthPx: halfExtentPx,
      spriteHalfHeightPx: halfExtentPx,
    });
    transitioning ||= focus.transitioning;
    if (focus.active) activeCount += 1;
    const base = baseColorFor(noradId);
    const alpha = base.alpha * focus.factor;
    if (focusAlphaNeedsWrite(point.color?.alpha, alpha, params)) {
      point.color = base.withAlpha(alpha);
      writes += 1;
    }
  }
  return { writes, transitioning, activeCount, ran: true };
}

// ------------------------------------------------------------ o módulo

const satellitesLayer = {
  id: LAYER_ID,
  name: 'Satellites',
  icon: '🛰️',
  source: 'CelesTrak',
  maplibre: true,
  updateInterval: 0, // real-time updates come from the layer loop, not interval polling
  refreshInterval: 5 * 60 * 1000, // Catalog data refresh; propagation remains loop-owned.

  /** @param {object} engine motor MapLibre (src/maplibre/engine.js) */
  async init(engine) {
    _abortActiveUpdates();
    _catalog = new Map();
    _points = new Map();
    _detectionObjects = new Map();
    _orbitPaths = new Map();
    _count = 0;
    _lastUpdate = null;
    _trackedNorad = null;
    _trackTarget = null;
    _trackedLabelModel = null;
    _cancelPendingTrackingRestore();
    _trackedFrameMs = Number.NEGATIVE_INFINITY;
    _trackedFrameGeo = null;
    _nowForTest = null;
    _enabled = false;
    // Dense extras rebuild via update() when _params.catalog === 'dense'
    // (the catalog-mode preference itself is sticky across init/destroy).
    _denseIds = [];
    _denseCursor = 0;
    _denseLoadPromise = null;
    _denseLoadToken++;
    _denseStatus = 'idle';
    _denseError = null;
    _catalogRevision++;
    _attachToEngine(engine);
    _installInteraction();
    console.log('[Data:Satellites] Initialized');
  },

  enable(engine) {
    if (engine && engine !== _engine) _attachToEngine(engine);
    _enabled = true;
    _setHostVisible(true);
    _installInteraction();
    // Pick-ownership: satellite ids are numeric NORAD catalog numbers.
    registerPickOwner(LAYER_ID, (pickedId) => {
      const norad = Number(pickedId);
      return Number.isFinite(norad) && _points.has(norad);
    });
    _renderAll();
    _startLoop();
    _applyPendingTrackingRestore();
  },

  disable() {
    _abortActiveUpdates();
    _cancelPendingTrackingRestore();
    _clearTracking();
    _enabled = false;
    _stopLoop();
    _removeInteraction();
    unregisterPickOwner(LAYER_ID);
    _renderAll();
    _setHostVisible(false);
  },

  async update(engine, { signal = null } = {}) {
    const trackingRefreshEpoch = ++_trackingRefreshEpoch;
    _lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch,
      status: 'source-unavailable',
      failedGroups: [],
    };
    const resourceController = new AbortController();
    _activeUpdateControllers.add(resourceController);
    const updateSignal = signal
      ? AbortSignal.any([signal, resourceController.signal])
      : resourceController.signal;
    try {
      updateSignal.throwIfAborted();
      // Load all core groups in parallel; a failed/empty group degrades
      // gracefully (parseTLE of an upstream error body yields []).
      const results = await Promise.all(CATALOG_GROUPS.map(async (groupDef) => {
        try {
          const res = await fetch(`/api/celestrak/${groupDef.path}`, { signal: updateSignal });
          if (!res.ok) return { ...groupDef, entries: [], ok: false };
          const entries = parseTLE(await res.text());
          updateSignal.throwIfAborted();
          return { ...groupDef, entries, ok: entries.length > 0 };
        } catch (error) {
          if (updateSignal.aborted || error?.name === 'AbortError') throw error;
          return { ...groupDef, entries: [], ok: false };
        }
      }));
      updateSignal.throwIfAborted();

      const failed = results.filter(r => !r.ok).map(r => r.path);
      if (failed.length > 0) {
        console.warn(`[Data:Satellites] Groups failed or empty: ${failed.join(', ')}`);
      }
      console.log(`[Data:Satellites] Loaded ${results.map(r => `${r.tag}:${r.entries.length}`).join(' ')}`);

      // CelesTrak outage guard: if EVERY group failed, bail BEFORE clearing —
      // keep the existing (stale) catalog on screen and surface the outage
      // instead; do NOT stamp _lastUpdate.
      if (results.every(r => !r.ok)) {
        _lastError = 'CelesTrak unreachable';
        console.warn('[Data:Satellites] All CelesTrak groups failed — keeping existing catalog, surfacing outage');
        return;
      }

      _lastError = failed.length
        ? `${failed.length} CelesTrak group${failed.length === 1 ? '' : 's'} unavailable`
        : null;

      // Clear existing (the tracked subject survives: same NORAD re-resolved below)
      _points.clear();
      _orbitPaths.clear();
      _catalog.clear();
      // The detection overlay caches one record per satellite and stamps its
      // id/class at creation only; the cache must go with the catalog.
      _detectionObjects.clear();
      _denseIds = [];
      _denseCursor = 0;
      _denseLoadController?.abort();
      _denseLoadController = null;
      _denseLoadToken++; // cancel any in-flight dense load against the old catalog

      const now = new Date(_now());

      // Process all TLE entries in CATALOG_GROUPS order
      const allEntries = [];
      for (const r of results) {
        for (const e of r.entries) allEntries.push({ ...e, group: r.tag });
      }

      // Deduplicate by NORAD ID — first (most specific) group tag wins
      const seen = new Set();
      for (const entry of allEntries) {
        const satrec = twoline2satrec(entry.line1, entry.line2);
        if (!satrec || satrec.error !== 0) continue;
        const noradId = Number(satrec.satnum);
        if (seen.has(noradId)) continue;
        seen.add(noradId);
        _catalog.set(noradId, { name: entry.name, satrec, group: entry.group });
        const pos = _sampleAt(satrec, now);
        if (!pos) continue;
        _points.set(noradId, pos);
      }

      // Show ISS orbital path by default (and the tracked one, if it survived)
      if (_catalog.has(ISS_NORAD)) _showOrbitPath(ISS_NORAD, POINT_STYLES.iss.color);
      if (_trackedNorad !== null && _catalog.has(_trackedNorad)) {
        _trackedFrameGeo = null;
        _showOrbitPath(_trackedNorad, TRACKED_COLOR);
      }

      _count = _points.size;
      _catalogRevision++;
      _lastUpdate = Date.now();
      _lastPropagation = _now();
      _lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: failed.length ? 'partial' : 'accepted',
        failedGroups: [...failed],
      };
      console.log(`[Data:Satellites] ${_count} satellites active, ISS path shown`);
      _renderAll();

      // Re-apply dense mode after a full catalog rebuild (fire-and-forget —
      // _loadDenseCatalog handles its own errors and token invalidation).
      _denseLoadPromise = _params.catalog === 'dense'
        ? _loadDenseCatalog({ signal: updateSignal })
        : Promise.resolve({ status: 'not-requested' });
      // Re-resolve the published voice subject, or release the slot if it
      // provably did not survive. Not awaited: it waits on dense settlement.
      void _reconcileTrackedSubjectContext();
      _applyPendingTrackingRestore();
    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Satellite update aborted', 'AbortError');
      }
      console.warn('[Data:Satellites] Fetch error:', e);
    } finally {
      _activeUpdateControllers.delete(resourceController);
    }
  },

  destroy() {
    _abortActiveUpdates();
    _enabled = false;
    _clearTracking();
    _cancelPendingTrackingRestore();
    _stopLoop();
    _removeInteraction();
    unregisterPickOwner(LAYER_ID);
    _points.clear();
    _detectionObjects.clear();
    _orbitPaths.clear();
    _catalog.clear();
    _renderAll();
    _setHostVisible(false);
    _denseIds = [];
    _denseCursor = 0;
    _denseLoadToken++;
    _denseStatus = 'idle';
    _denseError = null;
    _catalogRevision++;
    _rowControlsListener = null;
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _trackingRefreshEpoch += 1;
    _lastTrackingRefreshOutcome = {
      epoch: _trackingRefreshEpoch,
      status: 'destroyed',
      failedGroups: [],
    };
    _engine = null;
    _host = null;
  },

  /**
   * Objetos para o overlay de detecção. `position` é {x,y,z} ECEF; também
   * trazem lon/lat/alt (graus, metros).
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || !_params.showPoints) return [];
    // Dense extras are points-only: excluded from the detection overlay.
    const eligibleCount = Math.max(1, _points.size - _denseIds.length);
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : eligibleCount;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(eligibleCount / maxCount));
    const start = seed % stride;

    const result = [];
    let idx = 0;
    for (const [noradId, point] of _points) {
      if (_denseIds.length > 0 && _catalog.get(noradId)?.group === 'dense') continue;
      const shouldTake = ((idx - start) % stride) === 0;
      idx++;
      if (!shouldTake) continue;
      if (!point.position) continue;
      const isTracked = noradId === _trackedNorad;
      // A docked companion sits at the tracked subject's own position; it is
      // listed on that card instead.
      if (!isTracked && _dockedCompanions.has(noradId)) continue;
      const cat = _catalog.get(noradId);
      let object = _detectionObjects.get(noradId);
      if (!object) {
        object = {
          sourceId: noradId,
          id: cat?.name || `SAT-${noradId}`,
          type: 'SAT',
          // Human class ("NAV · GPS"), not the raw CelesTrak tag ("GPS-OPS").
          klass: satelliteClassLabel(cat?.group, { isIss: noradId === ISS_NORAD }),
        };
        _detectionObjects.set(noradId, object);
      }
      object.position = point.position;
      object.lon = point.longitude;
      object.lat = point.latitude;
      object.alt = point.altitude;
      object.skipLabel = isTracked;
      result.push(object);
      if (result.length >= maxCount) break;
    }
    return result;
  },

  /**
   * Find a satellite by exact NORAD id (numeric string) or case-insensitive
   * name substring. Position is freshly propagated via SGP4.
   * @param {string|number} query NORAD id or partial name.
   * @returns {{ noradId: number, name: string, position: {x,y,z}, latitude: number, longitude: number, altitudeM: number }|null}
   */
  findByQuery(query) {
    if (query === null || query === undefined || !_catalog || _catalog.size === 0) return null;
    const q = String(query).trim();
    if (!q) return null;

    let noradId = null;
    if (/^\d+$/.test(q) && _catalog.has(Number(q))) {
      noradId = Number(q);
    } else {
      const lower = q.toLowerCase();
      for (const [id, sat] of _catalog) {
        if (sat.name.toLowerCase().includes(lower)) {
          noradId = id;
          break;
        }
      }
    }
    if (noradId === null) return null;

    const sat = _catalog.get(noradId);
    const pos = _sampleAt(sat.satrec, new Date(_now()));
    if (!pos) return null;

    return {
      noradId,
      name: sat.name.trim(),
      position: pos.position,
      latitude: pos.latitude,
      longitude: pos.longitude,
      altitudeM: pos.altitude,
    };
  },

  /**
   * Get positions of currently rendered satellites from per-point state
   * (no SGP4 re-propagation).
   * @param {number} [maxCount=300] Maximum entries to return.
   * @returns {Array<{ id: number, label: string, position: {x,y,z}, latitude: number, longitude: number, altitudeM: number }>}
   */
  getAllPositions(maxCount = 300) {
    const result = [];
    if (!_points || _points.size === 0) return result;
    const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 300;

    for (const [noradId, point] of _points) {
      if (result.length >= cap) break;
      if (!point.position) continue;
      // Dense extras are points-only — keep voice/framing lists to the core catalog.
      if (_denseIds.length > 0 && _catalog.get(noradId)?.group === 'dense') continue;
      const sat = _catalog.get(noradId);
      result.push({
        id: noradId,
        label: sat ? sat.name.trim() : String(noradId),
        position: point.position,
        latitude: point.latitude,
        longitude: point.longitude,
        altitudeM: point.altitude,
      });
    }
    return result;
  },

  /**
   * Track a satellite by NORAD id (camera follow + orbit path + highlight),
   * same path as clicking its point.
   * @param {string|number} noradId NORAD catalog number.
   * @returns {boolean} True if tracking started.
   */
  trackById(noradId, { origin = 'programmatic' } = {}) {
    const id = Number(noradId);
    if (!Number.isFinite(id) || !_catalog.has(id) || !_points.has(id)) return false;
    _cancelPendingTrackingRestore();
    _trackSatellite(id, { origin });
    return _trackedNorad === id;
  },

  /**
   * Resolve a shared Follow target only after the applicable CelesTrak
   * catalog has settled. A partial catalog can prove presence, never absence.
   */
  async resolveTrackingRestoreTarget(noradId, {
    signal = null,
    origin = 'share-restore',
  } = {}) {
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const id = _normalizeTrackedNorad(noradId);
    if (id === null) return { status: 'missing', reason: 'invalid-target' };
    const outcome = _lastTrackingRefreshOutcome;
    const found = () => _catalog.has(id) && _points.has(id);
    const follow = () => {
      if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
      return this.trackById(id, { origin })
        ? { status: 'found', refreshEpoch: outcome.epoch }
        : { status: 'source-unavailable', reason: 'target-not-renderable', refreshEpoch: outcome.epoch };
    };

    if (found()) return follow();
    if (outcome.status !== 'accepted' && outcome.status !== 'partial') {
      return {
        status: 'source-unavailable',
        reason: 'CelesTrak catalog unavailable',
        refreshEpoch: outcome.epoch,
      };
    }

    if (_params.catalog === 'dense') {
      const dense = await (_denseLoadPromise || Promise.resolve({ status: 'source-unavailable' }));
      if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
      if (_lastTrackingRefreshOutcome.epoch !== outcome.epoch) {
        return { status: 'superseded', reason: 'newer-catalog-refresh' };
      }
      if (found()) return follow();
      if (dense?.status !== 'ready') {
        return {
          status: 'source-unavailable',
          reason: dense?.reason || 'dense catalog unavailable',
          refreshEpoch: outcome.epoch,
        };
      }
    }

    if (outcome.status === 'partial') {
      return {
        status: 'source-unavailable',
        reason: 'partial CelesTrak catalog cannot prove absence',
        refreshEpoch: outcome.epoch,
        failedGroups: [...outcome.failedGroups],
      };
    }
    return {
      status: 'missing',
      reason: 'target-absent-from-catalog',
      refreshEpoch: outcome.epoch,
    };
  },

  /**
   * Stop tracking the currently tracked satellite (no-op if none).
   * @returns {boolean} Always true.
   */
  stopTracking({ origin = 'programmatic' } = {}) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin });
    return true;
  },

  cancelPendingTrackingRestore() {
    _cancelPendingTrackingRestore();
  },

  /**
   * Get info about the currently tracked satellite.
   * @returns {{ noradId: number, name: string, latitude: number, longitude: number, altitudeM: number }|null}
   */
  getTrackedInfo() {
    if (_trackedNorad === null || !_catalog.has(_trackedNorad)) return null;
    const sat = _catalog.get(_trackedNorad);
    const pos = _getTrackedFramePosition();
    if (!pos) return null;
    return {
      noradId: _trackedNorad,
      name: sat.name.trim(),
      latitude: pos.latitude,
      longitude: pos.longitude,
      altitudeM: pos.altitude,
    };
  },

  /** Cartão do rastreado {title, details[], accent} (antes: entity.gevLabelModel). */
  getTrackedLabelModel() {
    if (_trackedNorad === null) return null;
    _getTrackedFramePosition();
    return _trackedLabelModel ? { ..._trackedLabelModel, details: [..._trackedLabelModel.details] } : null;
  },

  /**
   * Runtime params (DataLayerManager.setLayerParams path).
   * catalog: 'core' (default, ~840 sats) | 'dense' (adds the Starlink shell
   * as points-only extras on a relaxed propagation budget).
   * @param {{ catalog?: 'core'|'dense', showPoints?: boolean, showOrbits?: boolean, selectedSatTrackingId?: number|null }} [params]
   */
  setParams(params = {}, { origin = 'programmatic' } = {}) {
    if (isExplicitLayerStateOrigin(origin)
        && !Object.hasOwn(params, 'selectedSatTrackingId')) {
      _cancelPendingTrackingRestore();
    }
    const catalog = params.catalog;
    if (catalog !== undefined && catalog !== 'core' && catalog !== 'dense') return false;
    const catalogChanged = satelliteCatalogModeChanged(_params.catalog, catalog);
    if (catalogChanged) {
      _params.catalog = catalog;
    }
    if (params.showPoints !== undefined) {
      _params.showPoints = params.showPoints !== false;
      _renderPoints();
    }
    if (params.showOrbits !== undefined) {
      _params.showOrbits = params.showOrbits !== false;
      _renderOrbits();
      _renderPoints(); // the ambient ISS label follows showOrbits
    }
    if (catalogChanged && catalog === 'dense') {
      _denseLoadPromise = _loadDenseCatalog();
    } else if (catalog === 'core') {
      if (catalogChanged) _removeDenseCatalog();
      // Any explicit request for core clears the error, even when the mode did
      // NOT change (a failed dense load already reverted the param to core).
      _denseStatus = 'idle';
      _denseError = null;
    }
    if (catalogChanged) console.log(`[Data:Satellites] Catalog mode: ${catalog}`);
    if (Object.hasOwn(params, 'selectedSatTrackingId')) {
      const requested = _normalizeTrackedNorad(params.selectedSatTrackingId);
      if (requested === _trackedNorad) {
        _pendingTrackingRestore = null;
      } else if (requested === null) {
        _cancelPendingTrackingRestore();
        if (_trackedNorad !== null) _clearTracking(false, { origin });
      } else {
        const generation = ++_trackingIntentGeneration;
        _pendingTrackingRestore = { id: requested, generation, origin };
        if (_trackedNorad !== null) _clearTracking(false, { origin });
        _applyPendingTrackingRestore();
      }
    }
    return true;
  },

  /** @returns {{ catalog: string, showPoints: boolean, showOrbits: boolean, selectedSatTrackingId: number|null }} */
  getParams() {
    return {
      catalog: _params.catalog,
      showPoints: _params.showPoints,
      showOrbits: _params.showOrbits,
      selectedSatTrackingId: _trackedNorad,
    };
  },

  /**
   * Layer-row sub-controls (DataLayerManager row-controls contract): the DENSE
   * catalog chip plus a class legend so the point colors are learnable.
   *
   * The chip is stateless — it declares the params to apply and the manager
   * owns the write. It reports the dense LOAD state, not the catalog param:
   * ACTIVE means "dense points are on screen" and nothing less.
   * @returns {{ chips: Array<object>, legend: Array<object> }} Row controls.
   */
  getRowControls() {
    // A dependency owner (Space Missions) borrows this layer for TLE lookup
    // with showPoints:false. Nothing is rendered, so surrender the row.
    if (!_params.showPoints) return { chips: [], legend: [] };

    const loading = _denseStatus === 'loading';
    const failed = _denseStatus === 'failed';
    const active = _params.catalog === 'dense' && _denseStatus === 'ready';
    let title = 'Add the full Starlink broadband shell (thousands of extra points)';
    if (loading) title = 'Loading the Starlink shell…';
    else if (failed) title = `Starlink ${_denseError || 'load failed'} — click to retry`;
    else if (active) title = 'Showing the full Starlink shell — click for the core catalog only';
    return {
      chips: [{
        id: 'catalog',
        label: loading ? 'DENSE ···' : (failed ? 'DENSE ✕' : 'DENSE'),
        active,
        busy: loading,
        disabled: loading,
        state: loading ? 'loading' : (failed ? 'error' : (active ? 'active' : 'idle')),
        title,
        params: { catalog: active ? 'core' : 'dense' },
      }],
      legend: satelliteClassLegend(_classTally()),
    };
  },

  /**
   * Install the manager's "row controls changed" callback. The dense load is
   * asynchronous, so completion and failure have to push a re-render.
   * @param {(() => void)|null} listener Callback, or null to detach.
   */
  setRowControlsListener(listener) {
    _rowControlsListener = typeof listener === 'function' ? listener : null;
  },

  getStats() {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      stale: false,
      status: _lastError === 'CelesTrak unreachable'
        ? 'unavailable'
        : (_lastError ? 'degraded' : 'nominal'),
      error: _lastError,
    };
  },
};

/**
 * Next ISS pass for an observer. Requires the catalog to have loaded (the
 * satellites layer enabled at least once this session).
 * @returns {{status:'no-tle'}|{status:'none'}|{status:'ok', pass:{riseMs:number,setMs:number,maxElevDeg:number,maxElevMs:number,riseAzDeg:number}}}
 */
export function getNextIssPass({ latDeg, lonDeg, minElevDeg = 10 }) {
  const sat = _catalog.get(ISS_NORAD);
  if (!sat || !sat.satrec) return { status: 'no-tle' };
  const pass = findNextIssPass({
    satrec: sat.satrec, latDeg, lonDeg, fromMs: Date.now(), minElevDeg,
  });
  return pass ? { status: 'ok', pass } : { status: 'none' };
}

/**
 * Score a mission-to-catalog name match. Compact identifier containment handles
 * names such as "Sirius SXM-11" → "SXM-11", while weak generic matches such as
 * "Starlink Group 17-40" → an arbitrary "STARLINK-1008" remain below the
 * acceptance threshold.
 * @param {string} query Mission or payload name.
 * @param {string} catalogName Satellite catalog name.
 * @returns {number} Match score; 0 means no useful relationship.
 */
export function scoreSatelliteNameMatch(query, catalogName) {
  const q = String(query || '').trim().toLowerCase();
  const name = String(catalogName || '').trim().toLowerCase();
  if (!q || !name) return 0;
  const qCompact = q.replace(/[^a-z0-9]/g, '');
  const nameCompact = name.replace(/[^a-z0-9]/g, '');
  if (qCompact === nameCompact) return 1000;
  let score = 0;
  if (
    Math.min(qCompact.length, nameCompact.length) >= 5
    && (qCompact.includes(nameCompact) || nameCompact.includes(qCompact))
  ) {
    score += 200 + Math.min(qCompact.length, nameCompact.length);
  }
  const ignored = new Set(['group', 'block', 'mission', 'launch', 'falcon', 'rocket']);
  const tokens = q.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !ignored.has(token));
  score += tokens.reduce((total, token) => total + (name.includes(token) ? token.length : 0), 0);
  return score;
}

function internationalDesignatorYear(satrec) {
  const match = String(satrec?.intldesg || '').match(/^(\d{2})/);
  if (!match) return null;
  const shortYear = Number(match[1]);
  return shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
}

let _lookupTleText = null;
let _lookupTleEntries = [];

function lookupTleEntries(tleText) {
  if (tleText !== _lookupTleText) {
    _lookupTleText = tleText;
    _lookupTleEntries = parseTLE(tleText);
  }
  return _lookupTleEntries;
}

function tleLineLaunchYear(line1) {
  const shortYear = Number(String(line1 || '').slice(9, 11));
  if (!Number.isFinite(shortYear)) return null;
  return shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
}

function orbitTrackFromRecord(name, satrec) {
  const referenceDate = new Date();
  const current = propagatePosition(satrec, referenceDate);
  if (!current) return null;
  return {
    noradId: Number(satrec.satnum),
    name: String(name || '').trim(),
    current,
    periodSec: orbitalPeriodSeconds(satrec),
    orbitPath: computeOrbitPath(satrec, referenceDate),
    gmstAtBake: gstime(referenceDate),
    positionAt: (date) => propagatePosition(satrec, date),
  };
}

/**
 * Find and propagate a mission payload directly from a TLE catalog.
 * This supports newly launched payloads that are present in CelesTrak's active
 * feed but have not yet moved into a narrower operational group.
 * @param {string} tleText Three-line-element catalog text.
 * @param {string} query Mission or payload name.
 * @param {{launchTime?: string|null}} [options] Optional launch epoch for namesake rejection.
 * @returns {{noradId:number,name:string,current:object,periodSec:number,orbitPath:Array<{x:number,y:number,z:number}>,gmstAtBake:number,positionAt:function(Date):object|null}|null}
 */
export function findSatelliteOrbitTrackInTle(tleText, query, options = {}) {
  const launchYear = Number.isFinite(Date.parse(options.launchTime))
    ? new Date(options.launchTime).getUTCFullYear()
    : null;
  let bestEntry = null;
  let bestScore = 0;
  const catalogText = String(tleText || '');
  for (const entry of lookupTleEntries(catalogText)) {
    const designatorYear = tleLineLaunchYear(entry.line1);
    if (launchYear !== null && designatorYear !== null && designatorYear !== launchYear) continue;
    const score = scoreSatelliteNameMatch(query, entry.name);
    if (score > bestScore) {
      bestEntry = entry;
      bestScore = score;
    }
  }
  if (!bestEntry || bestScore < 12) return null;
  const satrec = twoline2satrec(bestEntry.line1, bestEntry.line2);
  if (!satrec || satrec.error !== 0) return null;
  return orbitTrackFromRecord(bestEntry.name, satrec);
}

/**
 * Return the current propagated position and one-orbit path for a catalog satellite.
 * @param {string|number} query NORAD id or mission/payload name.
 * @param {{launchTime?: string|null}} [options] Optional launch epoch used to reject namesakes from another launch year.
 * @returns {{noradId:number,name:string,current:object,periodSec:number,orbitPath:Array<{x:number,y:number,z:number}>,gmstAtBake:number,positionAt:function(Date):object|null}|null}
 */
export function getSatelliteOrbitTrack(query, options = {}) {
  if (query === null || query === undefined || !_catalog?.size) return null;
  const q = String(query).trim().toLowerCase();
  let noradId = /^\d+$/.test(q) ? Number(q) : null;
  if (noradId === null || !_catalog.has(noradId)) {
    noradId = null;
    const launchYear = Number.isFinite(Date.parse(options.launchTime))
      ? new Date(options.launchTime).getUTCFullYear()
      : null;
    let bestScore = 0;
    for (const [id, sat] of _catalog) {
      const designatorYear = internationalDesignatorYear(sat.satrec);
      if (launchYear !== null && designatorYear !== null && designatorYear !== launchYear) continue;
      const score = scoreSatelliteNameMatch(q, sat.name);
      if (score > bestScore) { bestScore = score; noradId = id; }
    }
    if (bestScore < 12) noradId = null;
  }
  if (noradId === null) return null;
  const sat = _catalog.get(noradId);
  return orbitTrackFromRecord(sat.name, sat.satrec);
}

export default satellitesLayer;
