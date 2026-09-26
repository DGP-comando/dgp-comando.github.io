/**
 * @module cctv
 *
 * CCTV camera data layer — MapLibre version (migração do CesiumJS).
 *
 * O que continua igual:
 * - Catálogo: sementes (CAMERA_SEEDS) + fontes do backend (/api/cctv/sources),
 *   pose base + calibração (store v2 em localStorage, salvar/resetar), selo
 *   CAL, saúde (/api/cctv/health), auto-hop, ciclo/seleção/foco, estado do
 *   painel (`subscribe`/`getUIState`, mesmo formato), opções do link
 *   (`lo=c.c.0|1|v`, `c.p`, `c.a` → coverageMode, showProjection, autoHop),
 *   resultado de foco (CCTV_FOCUS_RESULT) e o pedido de foco "handoff"
 *   (cctvFocusRequest.js) disparado só por clique real numa câmera.
 * - Cartões ambientes: seleção LOD (cctvLod.js), desafogo, carência de
 *   despejo e ritmo de quadros (cctvCards.js) — agora pintados como
 *   marcadores DOM (mapCardHost.js) em vez do canvas do worldOverlay.
 *
 * O que mudou no MapLibre (degradação 3D → 2D, documentada):
 * - Ícones: `symbol` com o ícone de câmera girado pelo rumo (a direção da
 *   câmera fica visível no mapa) sobre um `circle` que marca a ativa.
 * - Cobertura: o frustum 3D (5 polilinhas) e o volume do viewshed viram o
 *   POLÍGONO NO CHÃO onde o cone encontra o solo (cctvViewshed.groundFootprint):
 *   modo 'on' = contorno + eixo; modo 'viewshed' = preenchido na cor da câmera.
 * - Plano do monitor (quadro ao vivo no fim do cone, orientado no espaço)
 *   vira um cartão "monitor" ancorado no fim do eixo de visada, com o quadro
 *   (imagem) ou o vídeo da câmera ativa.
 * - Sonda de obstrução (pickFromRay contra os 3D tiles) não existe sem malha
 *   3D: o alcance nunca é encurtado (`probeClampRangeM` fica null).
 * - Altura do solo (priors elipsoidais Re:Earth, amostragem de malha): sem
 *   uso num mapa 2D; a geometria usa o solo do catálogo.
 * - Gizmo de calibração 3D → dois marcadores arrastáveis (base e mira), ver
 *   cctvGizmo.js; demais campos pelo painel numérico.
 * - Posições públicas (`record.position`, entradas de cartão, objetos de
 *   detecção) são `{lon, lat, height}` em vez de Cesium.Cartesian3.
 *
 * All mutable state is module-scoped. The exported `cctvLayer` object
 * implements the standard layer interface (init/enable/disable/update/destroy)
 * plus CCTV-specific methods (selectCamera, cycleCamera, focusNearest, etc.).
 * Nada roda na importação (worldOverlayAllocation.worker importa este módulo).
 */
import {
  CCTV_ACTIVATION_RESULT,
  activateCctvCameraFromWorldClick,
} from '../cctvFocusRequest.js';
import { bindTrackingClickGesture, isTrackingClickGesture } from './trackingClickGesture.js';
import { CITY_POIS } from '../locations.js';
import { defineLayer, EMPTY_FC, esc, row } from '../maplibre/kit.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';
import { cameraAltitudeM, getMapCardHost } from './mapCardHost.js';
import { cameraHue, viewshedColors, groundFootprint } from './cctvViewshed.js';
import { advanceSpriteFocus, focusAlphaNeedsWrite, focusPassIsNeeded } from './focusDeemphasis.js';
import { createCalibrationGizmo, GIZMO_ID_PREFIX } from './cctvGizmo.js';
import {
  CCTV_AMBIENT_CARD_MAX,
  applyEvictionGrace,
  selectCctvLod,
  staticFrameRefreshMs,
} from './cctvLod.js';
import {
  CCTV_CARD_FETCH_BURST_LIMIT,
  CCTV_CARD_FETCH_BURST_SPACING_MS,
  CCTV_FRAME_CANVAS_W,
  CCTV_FRAME_CANVAS_H,
  applyFrameResult,
  cardFetchPolicy,
  cardScaleForAltitude,
  createCctvThumbnailOverlayEntry,
  createFrameSlot,
  declutterCctvCards,
  isCctvCardAnchorSafe,
  CCTV_OVERLAY_SOURCE_ID,
  planFrameCachePrune,
  frameFetchDue,
} from './cctvCards.js';

export { GIZMO_ID_PREFIX };

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------
const FRAME_ENDPOINT = '/api/cctv/frame';
const SOURCE_ENDPOINT = '/api/cctv/sources';
const HEALTH_ENDPOINT = '/api/cctv/health';
const MEDIA_ENDPOINT = '/api/cctv/media';

// ---------------------------------------------------------------------------
// Timing / limits
// ---------------------------------------------------------------------------
const DEFAULT_UPDATE_INTERVAL_MS = 10000;
const MIN_AUTO_HOP_SEC = 8;
const MAX_AUTO_HOP_SEC = 90;
const HEALTH_SYNC_INTERVAL_MS = 7000;
const ACTIVE_FRAME_REFRESH_MS = 10000;
const IDLE_FRAME_REFRESH_MS = 60000;
const PROJECTION_CANVAS_WIDTH = 1920;
const PROJECTION_CANVAS_HEIGHT = 1080;
const PROJECTION_VERT_ASPECT = PROJECTION_CANVAS_WIDTH / PROJECTION_CANVAS_HEIGHT;
const COVERAGE_NEIGHBOR_LIMIT = 14;
const COVERAGE_NEIGHBOR_RADIUS_KM = 1.8;
// Staggered catalog "geometry" pass (drives the #cctv-sync-chip progress).
const GEO_LOAD_BATCH_SIZE = 4;
const GEO_LOAD_BATCH_DELAY_MS = 120;
const GEO_TRACKING_BATCH_SIZE = 2;
const GEO_TRACKING_BATCH_DELAY_MS = 250;
const GEO_PROGRESS_NOTIFY_INTERVAL_MS = 300;
const GEO_PROGRESS_NOTIFY_BATCH_LIMIT = 10;

// v1 key is retired dead data (wipe clean, no legacy import). Exported for the
// unit suite's "v1 is ignored" assertion; there is NO read path for this key.
export const CCTV_CALIBRATION_STORAGE_KEY_V1 = 'godsEyeView.cctv.calibration.v1';
/** v2 store key. Entries: { values: <7-field calibration offsets>, source: 'manual', savedAt: <epoch ms> }. */
export const CCTV_CALIBRATION_STORAGE_KEY_V2 = 'godsEyeView.cctv.calibration.v2';
// Far-cap clearance of the (still computed, pure) 3D frustum geometry.
export const FRUSTUM_GROUND_CLEARANCE_M = 2;
/** Public result codes for explicit CCTV camera flights. */
export const CCTV_FOCUS_RESULT = Object.freeze({
  FOCUSED: 'focused',
  NO_ACTIVE_CAMERA: 'no-active-camera',
  TRACKING_HOLDS_VIEW: 'tracking-holds-view',
  COCKPIT_ACTIVE: 'cockpit-active',
});
// Obstruction clamp constants (the pure clamp helper is kept for tests/QA;
// MapLibre has no 3D mesh to probe, so no activation ever sets a clamp).
const PROBE_CLEARANCE_M = 4;
const PROBE_MIN_RANGE_M = 12;
/** Default calibration offsets — all zeroed, range scale 1x. */
const DEFAULT_CAMERA_CALIBRATION = Object.freeze({
  offsetNorthM: 0,
  offsetEastM: 0,
  headingDeg: 0,
  pitchDeg: 0,
  fovDeg: 0,
  rangeScale: 1,
  heightM: 0,
});

// ---------------------------------------------------------------------------
// MapLibre sources/layers
// ---------------------------------------------------------------------------
const SRC_CAMS = 'dg-cctv-cams';
const SRC_COVER = 'dg-cctv-cover';
const LYR_COVER_FILL = 'dg-cctv-cover-fill';
const LYR_COVER_LINE = 'dg-cctv-cover-line';
const LYR_CAM_HALO = 'dg-cctv-cam-halo';
const LYR_CAM_ICON = 'dg-cctv-cam-icon';
const ICON_ID = 'dg-cctv-camera';

const IDLE_CAMERA_COLOR = 'rgba(107,232,255,0.88)';
const ACTIVE_CAMERA_COLOR = 'rgba(255,217,122,0.95)';
const IDLE_COVERAGE_EDGE = 'rgba(47,224,255,0.45)';
const ACTIVE_COVERAGE_EDGE = 'rgba(141,255,135,0.9)';
const ACTIVE_COVERAGE_FILL = 'rgba(141,255,135,0.10)';
const NO_FILL = 'rgba(0,0,0,0)';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let _engine = null;
let _map = null;
let _records = [];
let _recordById = new Map();
let _enabled = false;
let _activeCameraId = null;
let _coverageMode = 'on'; // 'off' | 'on' (outline) | 'viewshed' (color-coded fill)
let _showProjection = true;
let _autoHop = false;
// Set true by an explicit deselect so auto-hop does not resurrect an active
// camera; any real activation (or turning auto-hop back on) clears it.
let _autoHopSuspended = false;
let _autoHopSec = 18;
let _lastHopAt = 0;
let _lastViewContext = '';
let _count = 0;
let _lastUpdate = null;
let _lastHealthSyncAt = 0;
let _lastError = null;
let _healthById = new Map();
let _calibrationById = new Map();
let _listeners = new Set();
let _geoQueue = [];
let _geoQueueTimer = 0;
let _geoLoading = false;
let _geoLoadTotal = 0;
let _geoLoadDone = 0;
let _geoProgressNotifier = null;
let _calibrationMode = false;
let _gizmo = null;
let _lastTransientNotifyAt = 0;
let _offs = [];
let _iconImage = null;
let _projectionTimer = 0;

// Ambient card tier (cctvLod/cctvCards policies).
let _cardIds = new Set();
let _cardGraceState = new Map();
let _cardFrameSlots = new Map();
let _cardFetchTimer = 0;
let _cardFetchInFlightCount = 0;
const _cardFetchImages = new Set();
const _cardFetchPendingIds = new Set();
let _cardFetchCount = 0;
let _cardLastFetchAt = 0;
let _cardMinFetchSpacingMs = null;
let _cardFetchMode = 'steady';
const CCTV_AMBIENT_CARD_DRAIN_CAP = 16;
const CARD_FETCH_TICK_MS = CCTV_CARD_FETCH_BURST_SPACING_MS;
const CARD_VIEW_MARGIN = 0.06;
const CARD_GAP_PX = 16;
const CCTV_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: CCTV_AMBIENT_CARD_MAX,
  collisionCapacity: CCTV_AMBIENT_CARD_MAX,
  moving: true,
  solveIntervalMs: 125,
});
export const CCTV_PROJECTION_OVERLAY_SOURCE_ID = 'cctv-projection';
export const CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

// Card host: the MapLibre DOM-marker host (mapCardHost.js) once the engine
// exists; a no-op before that (and in node tests unless one is injected).
const NOOP_OVERLAY_HOST = Object.freeze({
  clearSource() {},
  hitTest: () => null,
  setEntries() {},
  setVisible() {},
});
let _cctvOverlayHostOverride = null;
function overlayHost() {
  return _cctvOverlayHostOverride || getMapCardHost(_engine) || NOOP_OVERLAY_HOST;
}
/**
 * Product presentation option. Shipped behavior keeps the active camera's
 * thumbnail absent because its monitor card is the active representation.
 */
let _activeCameraCardEnabled = false;
/** Min spacing between hover picks (event-driven, user gesture). */
const HOVER_PICK_THROTTLE_MS = 120;
/** How long the hover card lingers after the pointer leaves the icon. */
const HOVER_RELEASE_MS = 1_000;
let _hoverCardId = null;
let _hoverReleaseTimer = 0;
let _hoverLastPickAt = 0;
let _cameraMoving = false;

/** Test seam: republishes host entries through the real push path. */
export function _pushAmbientCardEntriesForTest() {
  pushAmbientCardEntries();
}

/** Test seam for exercising real layer lifecycle paths without a DOM host. */
export function _setCctvOverlayHostForTest(host = null) {
  _cctvOverlayHostOverride = host ? { ...NOOP_OVERLAY_HOST, ...host } : null;
}

/**
 * Build the protected label (and, in MapLibre, the live monitor) associated
 * with the active camera. `position` is `{lon, lat, height}` (or a function
 * returning it); `monitor` is optional ({src, video, width}).
 * @param {{cameraId: string, name: string, position: Object|Function, monitor?: Object}} input
 * @returns {Object} Shared-host presentation entry.
 */
export function createCctvProjectionOverlayEntry({ cameraId, name, position, monitor = null }) {
  return {
    id: String(cameraId),
    position,
    variant: monitor ? 'monitor' : 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER - 1,
    title: String(name || cameraId || 'CAMERA'),
    details: [],
    accent: '#6be8ff',
    interactive: false,
    gapPx: 6,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    ...(monitor ? { monitor } : {}),
  };
}

/**
 * Configures optional CCTV card presentation without changing card density.
 * @param {Object} [options]
 * @param {boolean} [options.activeCameraCardEnabled=false]
 * @returns {{activeCameraCardEnabled:boolean}}
 */
export function setCctvCardPresentationOptions({ activeCameraCardEnabled = false } = {}) {
  _activeCameraCardEnabled = activeCameraCardEnabled === true;
  if (_enabled) pushAmbientCardEntries();
  return { activeCameraCardEnabled: _activeCameraCardEnabled };
}

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function normalizeHeading(deg) {
  let v = deg % 360;
  if (v < 0) v += 360;
  return v;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Camera position of the map view ({lat, lon, alt}), or null before init. */
function viewerCameraPosition() {
  const view = _engine?.getCameraView?.();
  if (!view) return null;
  const lat = Number.isFinite(view.lat) ? view.lat : view.targetLat;
  const lon = Number.isFinite(view.lon) ? view.lon : view.targetLon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, alt: Number.isFinite(view.alt) ? view.alt : cameraAltitudeM(_engine) };
}


/**
 * Returns whether a calibration patch moves the camera's ground anchor.
 * Rotational, optical, range, and manual-height edits preserve the existing
 * ground reference; only north/east translation needs a new floor.
 * @param {Object|null|undefined} patch
 * @returns {boolean}
 */
export function calibrationPatchMovesAnchor(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(patch, 'offsetNorthM') ||
    Object.prototype.hasOwnProperty.call(patch, 'offsetEastM');
}

/** Base64-encoded SVG camera icon for billboard rendering. */
const CAMERA_ICON = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <defs>
      <linearGradient id="lens" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#c9f6ff"/>
        <stop offset="45%" stop-color="#6fd9ff"/>
        <stop offset="100%" stop-color="#1a5f78"/>
      </linearGradient>
    </defs>
    <g transform="translate(4 6)">
      <rect x="0" y="8" width="20" height="9" rx="2.5" fill="#0e1720" stroke="#75e7ff" stroke-width="1.2"/>
      <rect x="17" y="10" width="10" height="5" rx="1.5" fill="#132433" stroke="#75e7ff" stroke-width="1"/>
      <circle cx="24" cy="12.5" r="3.1" fill="url(#lens)" stroke="#dbfbff" stroke-width="0.8"/>
      <rect x="6.4" y="17" width="4.2" height="8.5" rx="1.2" fill="#10212d" stroke="#75e7ff" stroke-width="1"/>
      <rect x="4.2" y="24" width="8.6" height="2.5" rx="1.1" fill="#0b151d" stroke="#4ecde7" stroke-width="0.8"/>
    </g>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
})();

/**
 * Seed camera definitions used when no live sources are available.
 * Each seed references a city from CITY_POIS and a POI index within that city,
 * plus offsets to place the camera near the POI.
 */
const CAMERA_SEEDS = [
  { id: 'nyc-midtown-w', cityId: 'nyc', poiIndex: 1, label: 'Midtown West @ 34th', offsetNorthM: 120, offsetEastM: -70, headingDeg: 206, fovDeg: 74, rangeM: 880, elevationM: 26 },
  { id: 'nyc-wtc-n', cityId: 'nyc', poiIndex: 2, label: 'WTC North Plaza', offsetNorthM: 95, offsetEastM: 34, headingDeg: 164, fovDeg: 68, rangeM: 760, elevationM: 32 },
  { id: 'nyc-times-square-ne', cityId: 'nyc', poiIndex: 1, label: 'Times Sq Northeast', offsetNorthM: 230, offsetEastM: 120, headingDeg: 218, fovDeg: 66, rangeM: 640, elevationM: 24 },

  { id: 'sf-market-5th', cityId: 'sf', poiIndex: 2, label: 'Market & 5th', offsetNorthM: -160, offsetEastM: 80, headingDeg: 320, fovDeg: 70, rangeM: 780, elevationM: 20 },
  { id: 'sf-financial-district', cityId: 'sf', poiIndex: 1, label: 'SF Financial Core', offsetNorthM: 110, offsetEastM: 52, headingDeg: 205, fovDeg: 72, rangeM: 760, elevationM: 24 },

  { id: 'tokyo-shibuya-scramble', cityId: 'tokyo', poiIndex: 4, label: 'Shibuya Crossing', offsetNorthM: 180, offsetEastM: 46, headingDeg: 18, fovDeg: 82, rangeM: 640, elevationM: 30 },
  { id: 'tokyo-ginza-core', cityId: 'tokyo', poiIndex: 0, label: 'Ginza Core', offsetNorthM: -180, offsetEastM: 150, headingDeg: 245, fovDeg: 70, rangeM: 690, elevationM: 28 },
  { id: 'tokyo-asakusa-n', cityId: 'tokyo', poiIndex: 3, label: 'Asakusa North Gate', offsetNorthM: 110, offsetEastM: -65, headingDeg: 192, fovDeg: 68, rangeM: 620, elevationM: 24 },

  { id: 'london-city-a1', cityId: 'london', poiIndex: 4, label: 'City Cluster A1', offsetNorthM: 80, offsetEastM: 65, headingDeg: 220, fovDeg: 71, rangeM: 720, elevationM: 27 },
  { id: 'london-soho-core', cityId: 'london', poiIndex: 2, label: 'Soho Core', offsetNorthM: 210, offsetEastM: 120, headingDeg: 206, fovDeg: 70, rangeM: 700, elevationM: 22 },

  { id: 'paris-rivoli', cityId: 'paris', poiIndex: 4, label: 'Rue de Rivoli', offsetNorthM: 55, offsetEastM: 85, headingDeg: 248, fovDeg: 66, rangeM: 640, elevationM: 22 },
  { id: 'paris-champs-n', cityId: 'paris', poiIndex: 1, label: 'Champs-Élysées North', offsetNorthM: 130, offsetEastM: -38, headingDeg: 175, fovDeg: 68, rangeM: 700, elevationM: 26 },

  { id: 'dc-mall-center', cityId: 'dc', poiIndex: 1, label: 'National Mall Center', offsetNorthM: 120, offsetEastM: 20, headingDeg: 258, fovDeg: 78, rangeM: 940, elevationM: 24 },
  { id: 'dc-pentagon-s', cityId: 'dc', poiIndex: 3, label: 'Pentagon South', offsetNorthM: -100, offsetEastM: 92, headingDeg: 14, fovDeg: 66, rangeM: 620, elevationM: 21 },

  { id: 'dubai-difc-loop', cityId: 'dubai', poiIndex: 4, label: 'DIFC Loop', offsetNorthM: 92, offsetEastM: -45, headingDeg: 196, fovDeg: 70, rangeM: 720, elevationM: 26 },
  { id: 'dubai-downtown-east', cityId: 'dubai', poiIndex: 0, label: 'Downtown East', offsetNorthM: -130, offsetEastM: 190, headingDeg: 322, fovDeg: 72, rangeM: 760, elevationM: 28 },

  { id: 'austin-congress-s', cityId: 'austin', poiIndex: 0, label: 'Congress Southbound', offsetNorthM: -165, offsetEastM: 40, headingDeg: 12, fovDeg: 74, rangeM: 760, elevationM: 24 },
  { id: 'austin-downtown-west', cityId: 'austin', poiIndex: 1, label: 'Downtown West', offsetNorthM: -120, offsetEastM: -160, headingDeg: 120, fovDeg: 69, rangeM: 700, elevationM: 20 },
];


/**
 * Task 5 (height-datum fix): maps the scene's `globe.show` flag to the surface
 * regime key the per-camera ground cache is keyed by (spec §2 "cache by
 * surface regime", collapsed to two keys — ion World Terrain and Re:Earth
 * globe terrain get the same handling):
 *
 *  - `google-3d`     — photoreal stack: globe hidden, the visible Google 3D
 *                      tileset IS the surface → one-shot scene sampling refines.
 *  - `terrain-globe` — any globe stack: the Re:Earth point-height prior IS the
 *                      resolution (zero scene queries).
 *
 * Only an explicit `false` (the photoreal stack hides the globe) selects
 * `google-3d`; undefined/null (no viewer / torn down) must fall to the regime
 * that never touches the scene. Pure — exported for the unit suite.
 * @param {boolean|undefined|null} globeShow - `viewer.scene.globe.show`.
 * @returns {'google-3d'|'terrain-globe'}
 */
export function surfaceRegimeKey(globeShow) {
  return globeShow === false ? 'google-3d' : 'terrain-globe';
}

/**
 * Normalizes a raw feed-type string to a canonical type (image, mjpeg, mp4, hls, webm).
 * @param {string|*} value - Raw feed type from source config.
 * @returns {string} Canonical feed type.
 */
function normalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'jpeg') return 'image';
  if (raw === 'jpg') return 'image';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  if (raw === 'png') return 'image';
  if (raw === 'gif') return 'image';
  return raw;
}

/**
 * Returns true if the feed type requires a <video> element rather than an <img>.
 * @param {string} feedType
 * @returns {boolean}
 */
function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'hls' || feedType === 'webm';
}

/**
 * Coerces a value to a finite number or returns the fallback.
 * @param {*} value
 * @param {number} [fallback=NaN]
 * @returns {number}
 */
function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Derives a deterministic heading from a camera ID string via a simple hash.
 * Produces one of 16 evenly-spaced headings (0, 22.5, 45, ..., 337.5).
 * @param {string} id
 * @returns {number} Heading in degrees [0, 360).
 */
function headingFromId(id) {
  const text = String(id || '');
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 33 + text.charCodeAt(i)) >>> 0;
  }
  return normalizeHeading((acc % 16) * 22.5);
}

/**
 * Rounds a value to the nearest multiple of `step`.
 * @param {number} value
 * @param {number} [step=0.1]
 * @returns {number}
 */
function quantize(value, step = 0.1) {
  return Math.round(value / step) * step;
}

/**
 * Sanitizes and clamps a calibration object to valid ranges.
 * Missing or non-finite fields fall back to defaults.
 * @param {Object} [value={}] - Raw calibration values.
 * @returns {{ offsetNorthM: number, offsetEastM: number, headingDeg: number, pitchDeg: number, fovDeg: number, rangeScale: number, heightM: number }}
 */
function normalizeCalibration(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    offsetNorthM: quantize(clamp(safeNumber(raw.offsetNorthM, 0), -900, 900), 0.1),
    offsetEastM: quantize(clamp(safeNumber(raw.offsetEastM, 0), -900, 900), 0.1),
    headingDeg: quantize(clamp(safeNumber(raw.headingDeg, 0), -180, 180), 0.1),
    pitchDeg: quantize(clamp(safeNumber(raw.pitchDeg, 0), -45, 45), 0.1),
    fovDeg: quantize(clamp(safeNumber(raw.fovDeg, 0), -50, 50), 0.1),
    rangeScale: quantize(clamp(safeNumber(raw.rangeScale, 1), 0.35, 3.0), 0.01),
    heightM: quantize(clamp(safeNumber(raw.heightM, 0), -120, 240), 0.1),
  };
}

/**
 * Returns true if the given calibration is effectively the default (all offsets near zero).
 * @param {Object} calibration
 * @returns {boolean}
 */
function isDefaultCalibration(calibration) {
  const probe = normalizeCalibration(calibration);
  return Object.keys(DEFAULT_CAMERA_CALIBRATION).every((key) => Math.abs(probe[key] - DEFAULT_CAMERA_CALIBRATION[key]) < 0.0001);
}

/**
 * Normalizes a coverage-mode request (viewshed design §3b). Accepts the three
 * mode strings plus booleans for `setParams({showCoverage})` back-compat
 * (true → 'on', false → 'off'); anything else keeps the current mode.
 * @param {*} value - Requested mode ('off'|'on'|'viewshed') or boolean.
 * @param {'off'|'on'|'viewshed'} current - Mode to keep when the request is invalid.
 * @returns {'off'|'on'|'viewshed'}
 */
export function normalizeCoverageMode(value, current) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value === 'off' || value === 'on' || value === 'viewshed') return value;
  return current;
}

/**
 * Converts north/east metre offsets to lat/lon degree deltas at a given latitude.
 * Uses the equirectangular approximation (111320 m/deg).
 * @param {number} latDeg - Reference latitude (degrees).
 * @param {number} northMeters - Offset northward (metres).
 * @param {number} eastMeters - Offset eastward (metres).
 * @returns {{ latOffset: number, lonOffset: number }} Degree deltas.
 */
function offsetDegrees(latDeg, northMeters, eastMeters) {
  const latOffset = northMeters / 111320;
  const lonDivisor = Math.max(0.15, Math.cos(toRad(latDeg)));
  const lonOffset = eastMeters / (111320 * lonDivisor);
  return { latOffset, lonOffset };
}

/**
 * Returns `window.localStorage` when it is safely accessible, else null.
 * Split out so store IO can be exercised under plain node:test with an
 * injected storage-like object (getItem/setItem/removeItem) instead.
 * @returns {Storage|null}
 */
function safeWindowLocalStorage() {
  if (typeof window === 'undefined') return null;
  try {
    // NB: the window.localStorage property ACCESS itself throws SecurityError
    // under "block all cookies", so it has to live inside the try (M11).
    return window.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Loads all persisted per-camera calibration overrides from the v2 store.
 *
 * v2 entries carry provenance: `{ values: <7-field offsets>, source: 'manual',
 * savedAt: <epoch ms> }`. The v1 key (`CCTV_CALIBRATION_STORAGE_KEY_V1`) is
 * NEVER read here — product rule #3 (§9.3): wipe clean, no legacy import.
 *
 * @param {{getItem:function}|null} [storage] - Injectable storage (defaults
 *   to `window.localStorage`); lets the unit suite test this pure of a DOM.
 * @returns {Map<string, {values:Object, source:string, savedAt:number}>}
 */
export function readCalibrationStoreV2(storage = safeWindowLocalStorage()) {
  const map = new Map();
  if (!storage) return map;
  try {
    const raw = storage.getItem(CCTV_CALIBRATION_STORAGE_KEY_V2);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return map;
    for (const [cameraId, entry] of Object.entries(parsed)) {
      if (!cameraId || !entry || typeof entry !== 'object') continue;
      if (!entry.values || typeof entry.values !== 'object') continue;
      // 'manual' is the only provenance v2 knows (§9.3 killed 'legacy'); a
      // malformed/foreign source string still normalizes to 'manual' rather
      // than surfacing an unrecognized value into the badge logic.
      map.set(cameraId, {
        values: normalizeCalibration(entry.values),
        source: 'manual',
        savedAt: safeNumber(entry.savedAt, 0),
      });
    }
    return map;
  } catch {
    return map;
  }
}

/**
 * Persists a calibration map to the v2 store.
 * @param {Map<string, {values:Object, source:string, savedAt:number}>} map
 * @param {{setItem:function}|null} [storage] - Injectable storage (defaults
 *   to `window.localStorage`).
 */
export function writeCalibrationStoreV2(map, storage = safeWindowLocalStorage()) {
  if (!storage) return;
  try {
    const payload = {};
    for (const [cameraId, entry] of map.entries()) {
      payload[cameraId] = {
        values: normalizeCalibration(entry.values),
        source: 'manual',
        savedAt: safeNumber(entry.savedAt, Date.now()),
      };
    }
    storage.setItem(CCTV_CALIBRATION_STORAGE_KEY_V2, JSON.stringify(payload));
  } catch {
    // storage unavailable
  }
}

/**
 * Loads the v2 calibration store. `_calibrationById` holds these entries
 * directly (`{values, source:'manual', savedAt}`) — never bare offset values
 * — so it round-trips straight back through `writeCalibrationStoreV2`.
 * @returns {Map<string, {values:Object, source:string, savedAt:number}>}
 */
function loadCalibrationStore() {
  return readCalibrationStoreV2();
}

/** Persists the in-memory calibration entries (values + provenance) to the v2 store. */
function saveCalibrationStore() {
  writeCalibrationStoreV2(_calibrationById);
}

/**
 * Derives the panel CAL badge state for a camera (design §3b, as amended by
 * the LOCKED §9.2 — panel-only, no in-world tint).
 *
 * Three states:
 *  - 'calibrated' — a human explicitly saved a v2 calibration (`source:'manual'`).
 *  - 'curated'    — no manual save, but the catalog entry was hand-authored
 *                   (`poseSource:'curated'`, file/env sources only).
 *  - 'raw-prior'  — everything else (all Austin Open Data today).
 *
 * Pure — no scoring math, no raycasts. `confidenceFromScore` and score-based
 * quality seeding are retired; this replaces them.
 * @param {{calSource?: string|null, poseSource?: string|null}} camera
 * @returns {'calibrated'|'curated'|'raw-prior'}
 */
export function deriveCalBadge(camera) {
  if (camera?.calSource === 'manual') return 'calibrated';
  if (camera?.poseSource === 'curated') return 'curated';
  return 'raw-prior';
}

/**
 * Initializes or recomputes a camera's derived pose fields from its base pose
 * and calibration offsets. Also sets intrinsics, extrinsics, and anchor.
 *
 * On first call for a camera, captures the raw values as `basePose`.
 * Subsequent calls re-derive lat/lon/heading/pitch/fov/range by applying
 * calibration deltas to the frozen base pose.
 *
 * Note: the old score-based quality system (`confidenceFromScore`, seeded
 * `camera.quality.score`) is retired — panel trust signal is now the 3-state
 * CAL badge (`deriveCalBadge`, driven by `calSource`/`poseSource`), not a
 * fabricated confidence score.
 *
 * @param {Object} camera - Mutable camera record.
 */
function ensureCameraPose(camera) {
  if (!camera) return;
  if (!camera.basePose) {
    camera.basePose = {
      lat: safeNumber(camera.lat, 0),
      lon: safeNumber(camera.lon, 0),
      headingDeg: normalizeHeading(safeNumber(camera.headingDeg, 0)),
      pitchDeg: clamp(safeNumber(camera.pitchDeg, -17), -70, 10),
      fovDeg: clamp(safeNumber(camera.fovDeg, 74), 20, 130),
      rangeM: clamp(safeNumber(camera.rangeM, 700), 120, 5000),
      mountHeightM: clamp(safeNumber(camera.mountHeightM, 24), 2, 240),
    };
  }

  const nextCalibration = normalizeCalibration(camera.calibration || DEFAULT_CAMERA_CALIBRATION);
  camera.calibration = nextCalibration;

  const base = camera.basePose;
  const offsets = offsetDegrees(base.lat, nextCalibration.offsetNorthM, nextCalibration.offsetEastM);
  camera.lat = base.lat + offsets.latOffset;
  camera.lon = base.lon + offsets.lonOffset;
  camera.headingDeg = normalizeHeading(base.headingDeg + nextCalibration.headingDeg);
  camera.pitchDeg = clamp(base.pitchDeg + nextCalibration.pitchDeg, -70, 10);
  camera.fovDeg = clamp(base.fovDeg + nextCalibration.fovDeg, 20, 130);
  camera.rangeM = clamp(base.rangeM * nextCalibration.rangeScale, 120, 5000);
  camera.mountHeightM = clamp(base.mountHeightM + nextCalibration.heightM, 2, 240);

  camera.intrinsics = {
    fovDeg: camera.fovDeg,
    principalPoint: [0.5, 0.5],
  };
  camera.extrinsics = {
    headingDeg: camera.headingDeg,
    pitchDeg: camera.pitchDeg,
    rollDeg: 0,
    heightM: camera.mountHeightM,
  };
  camera.anchor = {
    lat: camera.lat,
    lon: camera.lon,
    elevM: safeNumber(camera.groundElevationM, 0),
    targetLatLon: camera.anchor?.targetLatLon || null,
  };
}

/**
 * Projects a point along a bearing from a given lat/lon by a distance.
 * Uses the spherical-earth direct geodesic formula (R = 6371 km).
 * @param {number} latDeg - Origin latitude (degrees).
 * @param {number} lonDeg - Origin longitude (degrees).
 * @param {number} bearingDeg - Azimuth from north (degrees).
 * @param {number} distanceM - Distance in metres.
 * @returns {{ lat: number, lon: number }} Destination in degrees.
 */
function projectPoint(latDeg, lonDeg, bearingDeg, distanceM) {
  const angular = distanceM / 6371000;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(latDeg);
  const lon1 = toRad(lonDeg);

  const sinLat2 = Math.sin(lat1) * Math.cos(angular)
    + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(sinLat2);

  const y = Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1);
  const x = Math.cos(angular) - Math.sin(lat1) * sinLat2;
  const lon2 = lon1 + Math.atan2(y, x);

  return {
    lat: toDeg(lat2),
    lon: toDeg(lon2),
  };
}

/**
 * V2 core geometry (design §2a): computes the pitched frustum pyramid — mount
 * point, far-cap (monitor plane) center, and the 4 far-plane corners — purely
 * from the calibrated pose + a caller-supplied ground altitude. ZERO scene
 * queries: ground sampling happens in the caller (one-shot snap), and the
 * obstruction probe passes its clamp in as `rangeOverrideM`.
 *
 * Math (spherical small-angle offsets; sub-centimetre at ≤2.2 km ranges):
 *   mountAlt  = groundAltM + mountHeightM
 *   capCenter = projectPoint(heading, R·cos(pitch)) @ alt mountAlt + R·sin(pitch)
 *   halfW     = R·tan(hFov/2)
 *   vFov      = 2·atan(tan(hFov/2) / (16/9))   → halfH = R·tan(vFov/2)
 *   upOffset  = cos(pitch)·halfH vertical + (−sin(pitch))·halfH along heading
 *   corners   = (capCenter ∓ halfW toward heading∓90°) ± upOffset
 * The cap CENTER altitude clamps to ≥ groundAltM + 2 m (§6 risk: fabricated
 * pitch must never bury the plane's anchor); corners derive rigidly from the
 * clamped center so the wireframe rays always terminate on the plane's
 * corners — the bottom pair may dip below ground (tiles occlude it).
 *
 * @param {Object} camera - Pose: lat, lon, headingDeg, pitchDeg, fovDeg,
 *   rangeM, mountHeightM.
 * @param {number} groundAltM - Ground altitude at the mount (metres).
 * @param {number|null} [rangeOverrideM=null] - Obstruction-probe clamp: caps the
 *   effective range (never lengthens it).
 * @returns {{ rangeM: number, vFovDeg: number, halfW: number, halfH: number,
 *   mount: {lat:number,lon:number,alt:number},
 *   capCenter: {lat:number,lon:number,alt:number},
 *   corners: { tl: Object, tr: Object, br: Object, bl: Object },
 *   topCenter: {lat:number,lon:number,alt:number}, groundAltM: number }}
 */
export function computeFrustumGeometry(camera, groundAltM, rangeOverrideM = null) {
  const ground = safeNumber(groundAltM, 0);
  const poseRange = Math.max(1, safeNumber(camera.rangeM, 700));
  const override = safeNumber(rangeOverrideM, NaN);
  const R = Number.isFinite(override) && override > 0 ? Math.min(poseRange, override) : poseRange;
  const pitch = toRad(clamp(safeNumber(camera.pitchDeg, -17), -89, 89));
  const hFov = toRad(clamp(safeNumber(camera.fovDeg, 74), 8, 160));
  const heading = safeNumber(camera.headingDeg, 0);
  const mountAlt = ground + safeNumber(camera.mountHeightM, 24);

  const horiz = R * Math.cos(pitch);
  const vert = R * Math.sin(pitch);
  const capLL = projectPoint(camera.lat, camera.lon, heading, horiz);
  const capAlt = mountAlt + vert;

  const halfW = R * Math.tan(hFov / 2);
  const vFovRad = 2 * Math.atan(Math.tan(hFov / 2) / PROJECTION_VERT_ASPECT);
  const halfH = R * Math.tan(vFovRad / 2);

  // In-plane "up" of the pitched cap, decomposed into a vertical part and a
  // horizontal part along the heading (pitch < 0 tilts the cap's top forward).
  const upVert = Math.cos(pitch) * halfH;
  const upHoriz = -Math.sin(pitch) * halfH;

  const capL = projectPoint(capLL.lat, capLL.lon, heading - 90, halfW);
  const capR = projectPoint(capLL.lat, capLL.lon, heading + 90, halfW);
  // Ground clamp (§6 risk): lift the CAP CENTER once so a fabricated pitch
  // never buries the plane's anchor — then derive the corners RIGIDLY from the
  // lifted center. Clamping each corner independently flattened the wireframe
  // into a ground-hugging fan while the rigid plane kept its height (owner
  // field test 2026-07-04): the corner rays must always terminate exactly on
  // the monitor plane's corners. The bottom pair may dip below ground; the 3D
  // tiles occlude that portion, exactly as they do for the plane itself.
  const minAlt = ground + FRUSTUM_GROUND_CLEARANCE_M;
  const capAltClamped = Math.max(minAlt, capAlt);
  const corner = (base, sign) => {
    const ll = projectPoint(base.lat, base.lon, heading, sign * upHoriz);
    return { lat: ll.lat, lon: ll.lon, alt: capAltClamped + sign * upVert };
  };

  const topCenter = corner(capLL, 1);
  return {
    rangeM: R,
    vFovDeg: toDeg(vFovRad),
    halfW,
    halfH,
    mount: { lat: camera.lat, lon: camera.lon, alt: mountAlt },
    capCenter: { lat: capLL.lat, lon: capLL.lon, alt: capAltClamped },
    corners: {
      tl: corner(capL, 1),
      tr: corner(capR, 1),
      br: corner(capR, -1),
      bl: corner(capL, -1),
    },
    topCenter,
    groundAltM: ground,
  };
}

/**
 * Resolves the obstruction probe's effective-range clamp just short of a hit,
 * with the field-derived 12 m floor used by the original H6 monitor.
 * @param {number} rangeM Nominal camera range.
 * @param {number} hitDistanceM Distance to the first obstruction.
 * @returns {number|null} Clamp range, or null when the hit does not shorten it.
 */
export function activationProbeClampRange(rangeM, hitDistanceM) {
  const nominalRange = Number(rangeM);
  const hitDistance = Number(hitDistanceM);
  if (!Number.isFinite(nominalRange) || nominalRange <= 0) return null;
  if (!Number.isFinite(hitDistance) || hitDistance <= 0 || hitDistance >= nominalRange) return null;
  return Math.max(PROBE_MIN_RANGE_M, hitDistance - PROBE_CLEARANCE_M);
}

/**
 * Computes the great-circle distance between two points using the haversine formula.
 * @param {number} lat1 - Latitude of point 1 (degrees).
 * @param {number} lon1 - Longitude of point 1 (degrees).
 * @param {number} lat2 - Latitude of point 2 (degrees).
 * @param {number} lon2 - Longitude of point 2 (degrees).
 * @returns {number} Distance in kilometres.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Computes the area of a circular sector (camera FOV wedge).
 * @param {number} rangeM - Radius in metres.
 * @param {number} fovDeg - Field of view in degrees.
 * @returns {number} Area in km^2.
 */
function sectorAreaKm2(rangeM, fovDeg) {
  const theta = toRad(clamp(fovDeg, 12, 170));
  const areaM2 = 0.5 * rangeM * rangeM * theta;
  return areaM2 / 1_000_000;
}

/**
 * Returns a coarse grid key describing the viewer's current position and zoom
 * level. Used to detect meaningful view changes for auto-hop camera switching.
 * @returns {string} Grid key in the form "zoomBucket:latGrid:lonGrid".
 */
function currentViewContext() {
  const view = viewerCameraPosition();
  if (!view) return 'none';
  const { lat, lon } = view;
  const alt = view.alt || 0;
  const zoomBucket = alt < 1500 ? 'street'
    : alt < 12000 ? 'city'
      : alt < 75000 ? 'regional'
        : 'global';
  const grid = zoomBucket === 'street' ? 0.045
    : zoomBucket === 'city' ? 0.24
      : zoomBucket === 'regional' ? 1.0
        : 4.5;
  return `${zoomBucket}:${Math.floor(lat / grid)}:${Math.floor(lon / grid)}`;
}

/**
 * Builds the initial camera catalog from CAMERA_SEEDS definitions.
 * Each seed is resolved against its city's POI coordinates, offset, and
 * passed through ensureCameraPose to populate derived fields.
 * @returns {Object[]} Array of fully-initialized camera objects.
 */
function seedCatalog() {
  const catalog = [];
  for (const seed of CAMERA_SEEDS) {
    const city = CITY_POIS[seed.cityId];
    const poi = city?.pois?.[seed.poiIndex];
    if (!city || !poi) continue;
    const { latOffset, lonOffset } = offsetDegrees(
      poi.lat,
      seed.offsetNorthM || 0,
      seed.offsetEastM || 0
    );
    const camera = {
      id: seed.id,
      name: seed.label,
      cityId: seed.cityId,
      city: city.name,
      provider: 'OSM Camera Grid',
      sourceKind: 'seed',
      feedType: 'image',
      feedConfigured: false,
      headingConfidence: 'medium',
      lat: poi.lat + latOffset,
      lon: poi.lon + lonOffset,
      headingDeg: normalizeHeading(seed.headingDeg ?? poi.heading ?? 0),
      fovDeg: clamp(seed.fovDeg ?? 70, 20, 120),
      rangeM: clamp(seed.rangeM ?? 700, 260, 1800),
      mountHeightM: clamp(seed.elevationM ?? 22, 8, 80),
      groundElevationM: Number(city.groundElevation) || 0,
      absoluteHeightM: (Number(city.groundElevation) || 0) + clamp(seed.elevationM ?? 22, 8, 80),
      pitchDeg: clamp(seed.pitchDeg ?? -17, -40, -4),
    };
    ensureCameraPose(camera);
    catalog.push(camera);
  }
  return catalog;
}

/**
 * Looks up a city ID from CITY_POIS by exact or partial name match.
 * @param {string} cityName
 * @returns {string|null} Matching city ID or null.
 */
function cityIdByName(cityName) {
  const probe = String(cityName || '').trim().toLowerCase();
  if (!probe) return null;
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    if (city.name.toLowerCase() === probe) return cityId;
  }
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    if (city.name.toLowerCase().includes(probe) || probe.includes(city.name.toLowerCase())) return cityId;
  }
  return null;
}

/**
 * Fetches configured camera sources from the backend.
 * @returns {Promise<Object[]>} Array of raw source objects, or empty on failure.
 */
async function loadCameraSources() {
  try {
    const resp = await fetch(SOURCE_ENDPOINT, { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data?.sources)) return [];
    return data.sources;
  } catch {
    return [];
  }
}

/**
 * Merges raw backend sources with seed data to produce the final camera catalog.
 * Seeds provide fallback values for heading, FOV, range, etc. when not specified
 * by the source. Each camera is passed through ensureCameraPose.
 * @param {Object[]} rawSources - Raw source objects from the backend.
 * @returns {Object[]} Array of fully-initialized camera objects.
 */
function buildCatalogFromSources(rawSources) {
  const sources = Array.isArray(rawSources) ? rawSources : [];
  if (!sources.length) return [];

  const seeded = seedCatalog();
  const seedById = new Map(seeded.map((camera) => [camera.id, camera]));

  const catalog = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const id = String(source.id || '').trim();
    if (!id) continue;
    const seed = seedById.get(id);
    const cityId = String(source.cityId || '').trim() || cityIdByName(source.city) || seed?.cityId || '';
    const city = cityId && CITY_POIS[cityId] ? CITY_POIS[cityId] : null;

    const lat = safeNumber(source.lat, seed?.lat ?? NaN);
    const lon = safeNumber(source.lon, seed?.lon ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const sourceHeading = safeNumber(source.headingDeg, NaN);
    const headingDeg = normalizeHeading(
      Number.isFinite(sourceHeading)
        ? sourceHeading
        : (seed?.headingDeg ?? headingFromId(id))
    );
    const fovDeg = clamp(safeNumber(source.fovDeg, seed?.fovDeg ?? 74), 20, 125);
    const rangeM = clamp(safeNumber(source.rangeM, seed?.rangeM ?? 700), 220, 2200);
    const mountHeightM = clamp(safeNumber(source.mountHeightM, seed?.mountHeightM ?? 24), 6, 120);
    const pitchDeg = clamp(safeNumber(source.pitchDeg, seed?.pitchDeg ?? -17), -55, -2);
    const groundElevationM = safeNumber(source.groundElevationM, city?.groundElevation ?? seed?.groundElevationM ?? 0);
    const feedType = normalizeFeedType(source.feedType || source.type || 'image');
    const headingConfidence = String(source.headingConfidence || (seed ? 'high' : 'low')).toLowerCase();
    // CAL badge input (design §3b passthrough): hand-authored file/env source
    // entries may carry poseSource:'curated'. Austin Open Data rows never set
    // this — they stay RAW PRIOR until a human manually calibrates them.
    const poseSource = source.poseSource === 'curated' ? 'curated' : (seed?.poseSource || null);

    const camera = {
      id,
      name: String(source.name || seed?.name || id),
      cityId,
      city: String(source.city || city?.name || seed?.city || 'Global'),
      provider: String(source.provider || seed?.provider || 'Configured CCTV Source'),
      sourceKind: String(source.sourceKind || source.kind || (source.url ? 'configured' : 'seed')).toLowerCase(),
      feedType,
      feedConfigured: typeof source.url === 'string' && !!source.url.trim(),
      lat,
      lon,
      headingDeg,
      headingConfidence,
      fovDeg,
      rangeM,
      mountHeightM,
      groundElevationM,
      absoluteHeightM: groundElevationM + mountHeightM,
      pitchDeg,
      license: String(source.license || source.licenseNote || ''),
      poseSource,
    };
    ensureCameraPose(camera);
    catalog.push(camera);
  }

  return catalog;
}


/**
 * FNV-1a over the RGB channels of a downsampled frame. Pure (takes the raw
 * pixel buffer, no DOM) so it is unit-testable.
 *
 * Alpha is skipped deliberately — CCTV stills are opaque, so hashing it would
 * cost a third more work to mix in a constant.
 *
 * @param {Uint8ClampedArray|number[]} data - RGBA pixels, 4 bytes per pixel.
 * @returns {number|null} Unsigned 32-bit signature, or null for empty input.
 */
export function frameSignatureFromPixels(data) {
  if (!data || typeof data.length !== 'number' || data.length < 4) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 4) {
    hash = Math.imul(hash ^ data[i], 0x01000193);
    hash = Math.imul(hash ^ data[i + 1], 0x01000193);
    hash = Math.imul(hash ^ data[i + 2], 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Builds the URL for fetching a camera frame image from the backend.
 * Includes a tick parameter to control cache invalidation cadence.
 * @param {Object} camera - Camera object.
 * @param {number} [refreshMs=ACTIVE_FRAME_REFRESH_MS] - Refresh interval used for tick bucketing.
 * @returns {string} Frame URL.
 */
function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(1000, safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS));
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}

/**
 * Builds the URL for fetching a camera's video/media stream.
 * @param {Object} camera - Camera object.
 * @returns {string} Media URL.
 */
function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}


/**
 * Creates the notification coalescer used by a staggered geometry drain.
 * Progress emits after roughly 300 ms or ten batches, whichever comes first;
 * finish always emits once even when the last progress tick just fired.
 *
 * @param {Function} notify Notification callback.
 * @param {Object} [options={}] Testable timing options.
 * @param {() => number} [options.now] Monotonic clock returning milliseconds.
 * @param {number} [options.intervalMs] Maximum progress-notification cadence.
 * @param {number} [options.batchLimit] Maximum batches between progress ticks.
 * @returns {{ progress: () => boolean, finish: () => void }} Drain notifier.
 */
export function createGeometryProgressNotifier(notify, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(0, options.intervalMs)
    : GEO_PROGRESS_NOTIFY_INTERVAL_MS;
  const batchLimit = Number.isFinite(options.batchLimit)
    ? Math.max(1, Math.floor(options.batchLimit))
    : GEO_PROGRESS_NOTIFY_BATCH_LIMIT;
  let lastNotifyAt = now();
  let batchesSinceNotify = 0;

  return {
    progress() {
      batchesSinceNotify += 1;
      const current = now();
      if (current - lastNotifyAt < intervalMs && batchesSinceNotify < batchLimit) {
        return false;
      }
      batchesSinceNotify = 0;
      lastNotifyAt = current;
      notify?.();
      return true;
    },
    finish() {
      batchesSinceNotify = 0;
      lastNotifyAt = now();
      notify?.();
    },
  };
}

/**
 * Processes one geometry-queue batch and routes progress/completion through
 * the callbacks shared by production and the unit drain harness.
 *
 * @param {Object} options Batch inputs.
 * @param {Object[]} options.queue Mutable record queue.
 * @param {number} options.batchSize Maximum records to visit.
 * @param {(record: Object) => void} options.visit Per-record geometry work.
 * @param {() => void} options.progress Coalesced progress publication.
 * @param {() => void} options.complete Unconditional completion publication.
 * @returns {boolean} True when more records remain.
 */
export function processCctvGeometryQueueBatch({
  queue,
  batchSize,
  visit,
  progress,
  complete,
}) {
  const safeQueue = Array.isArray(queue) ? queue : [];
  const take = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;
  const batch = safeQueue.splice(0, take);
  for (const record of batch) visit?.(record);
  if (safeQueue.length) {
    progress?.();
    return true;
  }
  complete?.();
  return false;
}

/**
 * Selects per-batch geometry-drain pacing from current camera ownership.
 * Called for every batch so releasing tracking immediately restores normal
 * throughput without restarting the queue.
 *
 * @param {Object} [ownership={}] Current camera-ownership state.
 * @param {*} [ownership.trackedEntity] Alvo acompanhado pelo motor (engine.trackedTarget), se houver.
 * @param {boolean} [ownership.cockpitActive] Whether cockpit owns the camera.
 * @returns {{ batchSize: number, delayMs: number }} Drain pacing.
 */
export function cctvGeometryDrainPacing({ trackedEntity = null, cockpitActive = false } = {}) {
  if (trackedEntity || cockpitActive) {
    return { batchSize: GEO_TRACKING_BATCH_SIZE, delayMs: GEO_TRACKING_BATCH_DELAY_MS };
  }
  return { batchSize: GEO_LOAD_BATCH_SIZE, delayMs: GEO_LOAD_BATCH_DELAY_MS };
}

/**
 * Processes one tracking-aware geometry-drain batch. Ownership is read inside
 * every call so a mid-drain tracking/cockpit transition changes the very next
 * batch's size and delay.
 *
 * @param {Object} options Batch inputs.
 * @param {Object[]} options.queue Mutable record queue.
 * @param {() => Object} [options.readOwnership] Current camera ownership.
 * @param {(record: Object) => void} options.visit Per-record geometry work.
 * @param {() => void} options.progress Coalesced progress publication.
 * @param {() => void} options.complete Unconditional completion publication.
 * @returns {{ hasMore: boolean, batchSize: number, delayMs: number }} Batch result and pacing.
 */
export function processCctvGeometryDrainBatch({
  queue,
  readOwnership,
  visit,
  progress,
  complete,
}) {
  const pacing = cctvGeometryDrainPacing(readOwnership?.() || {});
  const hasMore = processCctvGeometryQueueBatch({
    queue,
    batchSize: pacing.batchSize,
    visit,
    progress,
    complete,
  });
  return { hasMore, ...pacing };
}

/**
 * Moves the current active record to the front of a live drain queue.
 * @param {Object[]} queue Mutable geometry queue.
 * @param {Object|null} activeRecord Current active CCTV record.
 * @returns {boolean} Whether the queue order changed.
 */
export function prioritizeActiveCctvGeometryRecord(queue, activeRecord) {
  if (!Array.isArray(queue) || !activeRecord) return false;
  const index = queue.indexOf(activeRecord);
  if (index <= 0) return false;
  queue.splice(index, 1);
  queue.unshift(activeRecord);
  return true;
}


/**
 * Determines which camera coverage overlays should be visible based on
 * proximity to the active camera. Limits visibility to
 * COVERAGE_NEIGHBOR_LIMIT cameras within COVERAGE_NEIGHBOR_RADIUS_KM.
 * @param {Object|null} activeRecord - The active camera record.
 * @returns {Set<string>} Set of visible camera IDs.
 */
function buildCoverageVisibleSet(activeRecord) {
  if (!_records.length) return new Set();
  // Coverage emphasis is relative to a selected camera. Without one, do not
  // invent an arbitrary catalog-order cohort.
  if (!activeRecord) return new Set();

  const ranked = _records.map((record) => {
    if (record === activeRecord) {
      return { record, distKm: -1 };
    }
    return {
      record,
      distKm: haversineKm(
        activeRecord.camera.lat,
        activeRecord.camera.lon,
        record.camera.lat,
        record.camera.lon
      ),
    };
  });

  ranked.sort((a, b) => a.distKm - b.distKm);

  const primary = ranked.filter((entry) => entry.distKm <= COVERAGE_NEIGHBOR_RADIUS_KM || entry.distKm === -1);
  const fallback = ranked;
  const chosen = (primary.length >= COVERAGE_NEIGHBOR_LIMIT ? primary : fallback)
    .slice(0, COVERAGE_NEIGHBOR_LIMIT)
    .map((entry) => entry.record.camera.id);
  return new Set(chosen);
}


/**
 * Counts how many other cameras have overlapping coverage with the target.
 * Overlap is approximated by comparing inter-camera distance against the
 * combined range of both cameras (scaled by 0.92).
 * @param {Object} targetRecord - Camera record to check.
 * @returns {number} Number of overlapping neighbors.
 */
function coverageNeighborCount(targetRecord) {
  if (!targetRecord) return 0;
  let count = 0;
  for (const record of _records) {
    if (record === targetRecord) continue;
    const dKm = haversineKm(
      targetRecord.camera.lat,
      targetRecord.camera.lon,
      record.camera.lat,
      record.camera.lon
    );
    const overlapKm = (targetRecord.camera.rangeM + record.camera.rangeM) / 1000 * 0.92;
    if (dKm <= overlapKm) count++;
  }
  return count;
}

/**
 * Builds a single-line summary string for the active camera, including city,
 * heading, FOV, coverage area, overlap count, projection mode, alignment
 * confidence, source type, and view context.
 * @returns {string} Summary text separated by mid-dots.
 */
function buildSummaryText() {
  const active = getActiveRecord();
  if (!active) {
    return _records.length
      ? `${_records.length} CAMERAS STANDING BY · NO CAMERA SELECTED · CLICK A CAMERA TO ACTIVATE`
      : 'No cameras available in catalog.';
  }

  const area = sectorAreaKm2(active.camera.rangeM, active.camera.fovDeg);
  const overlapCount = coverageNeighborCount(active);
  const viewKey = currentViewContext();
  const viewBand = viewKey.split(':')[0] || 'global';
  const health = _healthById.get(active.camera.id) || null;
  const calBadge = deriveCalBadge(active.camera);

  return [
    `${active.camera.city.toUpperCase()} CCTV`,
    `${active.camera.name.toUpperCase()}`,
    `HDG ${Math.round(active.camera.headingDeg)}°`,
    `FOV ${Math.round(active.camera.fovDeg)}°`,
    `COVERAGE ${area.toFixed(2)}km²`,
    overlapCount > 0 ? `OVERLAP ${overlapCount} cams` : 'ISOLATED VIEW',
    `PROJ ${_showProjection ? 'MONITOR' : 'OFF'}`,
    _coverageMode === 'viewshed' ? 'VIEWSHED' : null,
    `CAL ${calBadge.replace('-', ' ').toUpperCase()}`,
    health?.sourceKind ? `SRC ${String(health.sourceKind).toUpperCase()}` : `SRC ${String(active.camera.feedType || 'image').toUpperCase()}`,
    `${viewBand.toUpperCase()} CONTEXT`,
  ].filter(Boolean).join(' · ');
}

/**
 * Builds a public-facing camera state object for UI consumption.
 * Includes all pose, calibration, CAL badge, projection, and feed metadata.
 * @param {Object} record - Camera record.
 * @param {string|null} [activeId=null] - Active camera ID for the `active` flag.
 * @returns {Object} Public camera state.
 */
function getPublicCameraState(record, activeId = null) {
  const resolvedActiveId = activeId || getActiveRecord()?.camera.id || null;
  const camera = record.camera;
  const health = _healthById.get(camera.id) || null;
  const isActive = camera.id === resolvedActiveId;
  const refreshMs = isActive ? ACTIVE_FRAME_REFRESH_MS : IDLE_FRAME_REFRESH_MS;
  return {
    id: camera.id,
    name: camera.name,
    city: camera.city,
    provider: camera.provider,
    lat: camera.lat,
    lon: camera.lon,
    headingDeg: camera.headingDeg,
    pitchDeg: camera.pitchDeg,
    fovDeg: camera.fovDeg,
    rangeM: camera.rangeM,
    elevationM: camera.absoluteHeightM,
    mountHeightM: camera.mountHeightM,
    active: isActive,
    feedType: camera.feedType,
    sourceKind: health?.sourceKind || camera.sourceKind || (camera.feedConfigured ? 'configured' : 'seed'),
    sourceStatus: health?.status || 'unknown',
    sourceMessage: health?.message || '',
    sourceLabel: health?.label || camera.provider || '',
    calibration: { ...normalizeCalibration(camera.calibration) },
    // Save-gated persistence (design §3e): true while the live pose carries
    // edits that have not been SAVEd (or RESET). Drives the CAL · EDITED chip.
    calDirty: !!record.calDirty,
    // Deterministic QA seam: counts commit-grade anchor resolutions (E/N drag
    // release, numeric E/N edit, or reset), never transient gizmo moves.
    groundResolveCount: record.calibrationGroundResolveCount || 0,
    // Per-record QA seam for proving transient gizmo moves never enter the
    // shared mesh-floor sampler while unrelated catalog cells finish.
    groundMeshSampleRequestCount: record.groundMeshSampleRequestCount || 0,
    // Datum QA seam: expose the immutable Re:Earth ellipsoidal prior
    // separately from the currently applied frustum ground. Google-3D may
    // legitimately refine the latter to the rendered mesh, so callers must
    // not infer the prior by subtracting mount height from live geometry.
    groundPriorM: Number.isFinite(record.groundPrior?.ellipsoid)
      ? record.groundPrior.ellipsoid
      : null,
    intrinsics: camera.intrinsics ? { ...camera.intrinsics } : null,
    extrinsics: camera.extrinsics ? { ...camera.extrinsics } : null,
    anchor: camera.anchor ? { ...camera.anchor } : null,
    // Panel-only trust signal (design §3b, amended by LOCKED §9.2/§9.3): no
    // in-world rendering reads this, no score-based quality math backs it.
    calBadge: deriveCalBadge(camera),
    poseSource: camera.poseSource || null,
    basePose: camera.basePose ? { ...camera.basePose } : null,
    frameUrl: frameUrlFor(camera, refreshMs),
    mediaUrl: mediaUrlFor(camera),
  };
}

/**
 * Assembles the full UI state payload containing layer toggles, camera list,
 * active camera details, summary text, and error state.
 * @returns {Object} Complete UI state for subscribers.
 */
function uiState() {
  const active = getActiveRecord();
  const activeId = active?.camera.id || null;
  const payload = {
    enabled: _enabled,
    // Compat boolean + the full tri-state (viewshed design §3b).
    showCoverage: _coverageMode !== 'off',
    coverageMode: _coverageMode,
    showProjection: _showProjection,
    calibrationMode: _calibrationMode,
    autoHop: _autoHop,
    autoHopSuspended: _autoHopSuspended,
    autoHopSec: _autoHopSec,
    count: _count,
    lastUpdate: _lastUpdate,
    error: _lastError,
    loading: {
      active: _geoLoading,
      loaded: Math.min(_geoLoadDone, _geoLoadTotal),
      total: _geoLoadTotal,
    },
    // Ambient card tier telemetry (QA harnesses assert the fetch pacing —
    // minFrameFetchSpacingMs reads together with fetchMode: cold-fill bursts
    // legitimately reach ~250 ms, steady state stays >=1000 ms).
    ambientCards: {
      count: _cardIds.size,
      limit: CCTV_AMBIENT_CARD_MAX,
      frameFetches: _cardFetchCount,
      minFrameFetchSpacingMs: _cardMinFetchSpacingMs,
      fetchMode: _cardFetchMode,
      fetchesInFlight: _cardFetchInFlightCount,
      // Item B QA seam: the hover-summoned pinned card, if any.
      hoverId: _hoverCardId,
    },
    activeCameraId: activeId,
    activeCamera: active ? getPublicCameraState(active, activeId) : null,
    cameras: _records.map((record) => getPublicCameraState(record, activeId)),
    summary: buildSummaryText(),
  };
  return payload;
}

/** Dispatches the current UI state to all registered subscriber callbacks. */
function notifyListeners() {
  const payload = uiState();
  for (const callback of _listeners) {
    try {
      callback(payload);
    } catch (error) {
      console.warn('[Data:CCTV] listener error:', error);
    }
  }
}

/**
 * Throttled notifyListeners for transient (mid-drag) calibration patches —
 * the panel re-render is DOM-heavy, so live gizmo drags publish state at
 * ≤10 Hz while the in-world geometry still tracks every processed move.
 */
function notifyListenersThrottled() {
  const now = Date.now();
  if (now - _lastTransientNotifyAt < 100) return;
  _lastTransientNotifyAt = now;
  notifyListeners();
}


/**
 * Advances to the next camera if auto-hop is enabled and the hop interval
 * has elapsed. If the viewer has panned to a new region since the last hop,
 * snaps to the nearest camera instead of cycling sequentially.
 * @param {number} nowMs - Current timestamp in milliseconds.
 */
export function maybeAutoHop(nowMs) {
  if (!_autoHop || _autoHopSuspended || !_enabled || _records.length < 2) return;
  if (nowMs - _lastHopAt < _autoHopSec * 1000) return;

  const viewKey = currentViewContext();
  const viewChanged = viewKey !== _lastViewContext;
  _lastViewContext = viewKey;

  if (viewChanged) {
    const nearest = nearestCameraIdToViewer();
    if (nearest && nearest !== _activeCameraId) {
      // Use setActiveCamera so the full activation path runs (obstruction
      // probe, projection runtime, geometry rewrite) — previously bypassed
      // with a bare assignment
      setActiveCamera(nearest);
      _lastHopAt = nowMs;
      return;
    }
  }

  const nextIdx = cctvCycleIndex(
    _records.findIndex((record) => record.camera.id === _activeCameraId),
    1,
    _records.length,
  );
  setActiveCamera(_records[nextIdx].camera.id);
  _lastHopAt = nowMs;
}

/**
 * Resolves a catalog cycle target, including the explicit no-selection state.
 * NEXT from null selects the first record; PREV selects the last.
 * @param {number} currentIdx
 * @param {number} step
 * @param {number} count
 * @returns {number}
 */
export function cctvCycleIndex(currentIdx, step, count) {
  const total = Number.isFinite(count) ? Math.floor(count) : 0;
  if (total <= 0) return -1;
  const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
  if (!Number.isFinite(currentIdx) || currentIdx < 0) {
    return delta < 0 ? total - 1 : 0;
  }
  return (((Math.floor(currentIdx) + delta) % total) + total) % total;
}

/**
 * Fetches per-camera health status from the backend and updates _healthById.
 * Rate-limited to HEALTH_SYNC_INTERVAL_MS unless forced.
 * @param {boolean} [force=false] - Bypass the interval check.
 */
async function syncHealthState(force = false) {
  const now = Date.now();
  if (!force && now - _lastHealthSyncAt < HEALTH_SYNC_INTERVAL_MS) return;
  _lastHealthSyncAt = now;

  try {
    const resp = await fetch(HEALTH_ENDPOINT, { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();
    const rows = Array.isArray(data?.cameras) ? data.cameras : [];
    const next = new Map();
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!id) continue;
      next.set(id, {
        status: String(row.status || '').toLowerCase() || 'unknown',
        sourceKind: String(row.sourceKind || row.feedType || '').toLowerCase(),
        label: String(row.label || row.provider || ''),
        message: String(row.message || ''),
        updatedAt: safeNumber(row.updatedAt, now),
      });
    }
    _healthById = next;
  } catch {
    // keep previous health map
  }
}



// ---------------------------------------------------------------------------
// Geometry (pure recompute per record; no scene queries in MapLibre)
// ---------------------------------------------------------------------------

/** Ground under the mount: the catalog's ground elevation (no 3D sampling). */
function groundAltFor(record) {
  return safeNumber(record?.camera?.groundElevationM, 0);
}

/**
 * Recomputes a record's derived geometry from its current pose: the pure 3D
 * frustum (kept for QA/API parity) and the ground footprint that MapLibre
 * draws. Updates `record.position` ({lon, lat, height}).
 * @param {Object} record
 */
function applyFrustumGeometry(record) {
  if (!record?.camera) return;
  const camera = record.camera;
  const ground = groundAltFor(record);
  camera.absoluteHeightM = ground + camera.mountHeightM;
  record.position = { lon: camera.lon, lat: camera.lat, height: camera.mountHeightM };
  record.frustumGeometry = computeFrustumGeometry(camera, ground, record.probeClampRangeM);
  record.footprint = groundFootprint(camera, { rangeOverrideM: record.probeClampRangeM });
  record.geometryReady = true;
}

/** Kept for API parity: the MapLibre build has no 3D mesh to probe. */
function runActivationObstructionProbe(record) {
  if (record) record.probeClampRangeM = null;
}

/**
 * Clears a deactivated camera's temporary obstruction clamp and rewrites its
 * geometry through the normal single-range path.
 * @param {Object|null} record Camera runtime record being deactivated.
 * @param {(record: Object) => void} rewriteGeometry Nominal geometry rewrite.
 * @returns {boolean} Whether a clamp was cleared.
 */
export function clearProbeClampOnDeactivation(record, rewriteGeometry) {
  if (!record || !Number.isFinite(record.probeClampRangeM)) return false;
  record.probeClampRangeM = null;
  rewriteGeometry?.(record);
  return true;
}

/**
 * Reports whether selecting a record must run the full activation path.
 * @param {string} cameraId Requested camera ID.
 * @param {string|null} activeCameraId Current active camera ID.
 * @param {Object|null} record Requested camera runtime record.
 * @returns {boolean}
 */
export function cctvRecordNeedsActivation(cameraId, activeCameraId, record) {
  return cameraId !== activeCameraId || record?.activationDone !== true;
}

/**
 * Bind CCTV activation to clean taps on a Cesium-style input handler (kept
 * for API parity; MapLibre's own `click` already ignores drags, which is what
 * the layer uses at runtime).
 * @param {Object} handler - Input handler ({setInputAction}).
 * @param {(click: Object) => void} onClick - Accepted CCTV click callback.
 * @param {Object} [options] - Gesture test seams and optional onMouseMove hook.
 */
export function bindCctvWorldClickGesture(handler, onClick, options = {}) {
  bindTrackingClickGesture(handler, (click, gesture) => {
    if (!isTrackingClickGesture(gesture)) return;
    onClick(click);
  }, options);
}

// ---------------------------------------------------------------------------
// Staggered catalog pass (chip "LOADING FRAMES n/N")
// ---------------------------------------------------------------------------

function readDrainOwnership() {
  return {
    trackedEntity: _engine?.trackedTarget || null,
    cockpitActive: typeof document !== 'undefined'
      && Boolean(document.body?.classList?.contains('cockpit-mode')),
  };
}

function stopGeometryLoadQueue(clearProgress = true) {
  if (_geoQueueTimer) {
    clearTimeout(_geoQueueTimer);
    _geoQueueTimer = 0;
  }
  _geoQueue = [];
  _geoProgressNotifier = null;
  _geoLoading = false;
  if (clearProgress) {
    _geoLoadTotal = 0;
    _geoLoadDone = 0;
  }
}

/** Processes one drain batch and schedules the next (exported for tests). */
export function processGeometryBatch() {
  _geoQueueTimer = 0;
  if (!_enabled) {
    stopGeometryLoadQueue();
    return;
  }
  const { hasMore, delayMs } = processCctvGeometryDrainBatch({
    queue: _geoQueue,
    readOwnership: readDrainOwnership,
    visit: (record) => {
      applyFrustumGeometry(record);
      _geoLoadDone += 1;
    },
    progress: () => {
      renderCoverage();
      _geoProgressNotifier?.progress();
    },
    complete: () => {
      _geoLoading = false;
      renderCoverage();
      refreshAmbientCards();
      _geoProgressNotifier?.finish();
    },
  });
  if (hasMore) _geoQueueTimer = setTimeout(processGeometryBatch, delayMs);
}

function startGeometryLoadQueue() {
  stopGeometryLoadQueue();
  _geoQueue = _records.slice();
  prioritizeActiveCctvGeometryRecord(_geoQueue, getActiveRecord());
  _geoLoadTotal = _geoQueue.length;
  _geoLoadDone = 0;
  if (!_geoQueue.length) return;
  _geoLoading = true;
  _geoProgressNotifier = createGeometryProgressNotifier(() => notifyListeners());
  _geoQueueTimer = setTimeout(processGeometryBatch, 0);
}

function getActiveRecord() {
  if (!_activeCameraId) return null;
  if (_recordById.has(_activeCameraId)) return _recordById.get(_activeCameraId);
  // Sync _activeCameraId when falling back to first record to prevent ID mismatch
  const fallback = _records[0] || null;
  if (fallback && fallback.camera?.id) _activeCameraId = fallback.camera.id;
  return fallback;
}

// ---------------------------------------------------------------------------
// MapLibre rendering
// ---------------------------------------------------------------------------

const CCTV_LAYER_DEF = defineLayer({
  id: 'cctv',
  name: 'CCTV',
  category: 'Contexto',
  icon: '📹',
  source: 'CCTV + Street View fallback',
  sources: {
    [SRC_COVER]: { type: 'geojson', data: EMPTY_FC },
    [SRC_CAMS]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      id: LYR_COVER_FILL,
      type: 'fill',
      source: SRC_COVER,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'fill'], 'fill-antialias': false },
    },
    {
      id: LYR_COVER_LINE,
      type: 'line',
      source: SRC_COVER,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['get', 'line'],
        'line-width': ['get', 'width'],
        'line-dasharray': ['literal', [1, 0]],
      },
    },
    {
      id: LYR_CAM_HALO,
      type: 'circle',
      source: SRC_CAMS,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['get', 'active'], 5, 2.5], 14, ['case', ['get', 'active'], 13, 8]],
        'circle-color': ['case', ['get', 'active'], ACTIVE_CAMERA_COLOR, 'rgba(8,24,32,0.75)'],
        'circle-stroke-color': ['case', ['get', 'active'], ACTIVE_CAMERA_COLOR, IDLE_CAMERA_COLOR],
        'circle-stroke-width': ['case', ['get', 'active'], 2, 1.2],
      },
    },
    {
      id: LYR_CAM_ICON,
      type: 'symbol',
      source: SRC_CAMS,
      minzoom: 11,
      layout: {
        'icon-image': ICON_ID,
        // The icon's lens points east (+x): rotate by heading − 90 so it looks
        // along the camera heading (the 2D stand-in for the 3D gizmo axes).
        'icon-rotate': ['-', ['get', 'heading'], 90],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, ['case', ['get', 'active'], 1.0, 0.8]],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
  ],
  interactive: [LYR_CAM_HALO, LYR_CAM_ICON],
  tooltip: (props) => {
    const record = _recordById.get(props.id);
    const cam = record?.camera;
    if (!cam) return '';
    const health = _healthById.get(cam.id);
    return `<b>${esc(cam.name)}</b>${row('Cidade', cam.city)}${row('Fonte', cam.provider)}`
      + `${row('Rumo', `${Math.round(cam.headingDeg)}° · FOV ${Math.round(cam.fovDeg)}°`)}`
      + `${row('Status', health?.status && health.status !== 'unknown' ? health.status : '')}`;
  },
  click: (props) => {
    if (!_enabled || _calibrationMode) return;
    if (props?.id && _recordById.has(props.id)) {
      activateCctvCameraFromWorldClick(props.id, setActiveCamera);
    }
  },
});

function setSourceData(id, data) {
  _map?.getSource?.(id)?.setData(data);
}

function cameraFeatures() {
  const activeId = _activeCameraId;
  const features = [];
  for (const record of _records) {
    const cam = record.camera;
    if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [cam.lon, cam.lat] },
      properties: { id: cam.id, heading: cam.headingDeg, active: cam.id === activeId },
    });
  }
  // Active camera last so it paints on top.
  features.sort((a, b) => Number(a.properties.active) - Number(b.properties.active));
  return { type: 'FeatureCollection', features };
}

function coverageFeatures() {
  const features = [];
  if (!_enabled) return { type: 'FeatureCollection', features };
  const activeRecord = getActiveRecord();
  const activeId = activeRecord?.camera.id || null;
  const coverageOn = _coverageMode !== 'off';
  const viewshedOn = _coverageMode === 'viewshed';
  const visible = coverageOn ? buildCoverageVisibleSet(activeRecord) : new Set();
  const projectionActive = _showProjection && activeId;
  for (const record of _records) {
    const id = record.camera.id;
    const isActive = id === activeId;
    if (!(visible.has(id) || (isActive && projectionActive))) continue;
    if (!record.footprint) applyFrustumGeometry(record);
    const fp = record.footprint;
    if (!fp) continue;
    const hue = viewshedOn ? record.viewshedColors : null;
    const fill = hue ? (isActive ? hue.fillActive : hue.fill) : (isActive ? ACTIVE_COVERAGE_FILL : NO_FILL);
    const line = hue ? (isActive ? hue.lineActive : hue.line) : (isActive ? ACTIVE_COVERAGE_EDGE : IDLE_COVERAGE_EDGE);
    const width = isActive ? 2 : 1;
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [fp.ring] },
      properties: { id, fill, line, width, active: isActive },
    });
    // Center ray (mount → far edge): the axis of the old frustum.
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[record.camera.lon, record.camera.lat], [fp.axisEnd.lon, fp.axisEnd.lat]] },
      properties: { id, line, width: isActive ? 1.4 : 0.8, active: isActive },
    });
  }
  // Active last (on top).
  features.sort((a, b) => Number(a.properties.active) - Number(b.properties.active));
  return { type: 'FeatureCollection', features };
}

function renderCameras() {
  setSourceData(SRC_CAMS, _enabled ? cameraFeatures() : EMPTY_FC);
}

function renderCoverage() {
  setSourceData(SRC_COVER, coverageFeatures());
}

/** Active camera's monitor card: live frame (or video) at the end of its view axis. */
function renderProjection() {
  const host = overlayHost();
  const active = getActiveRecord();
  if (!_enabled || !_showProjection || !active) {
    clearProjectionOverlay();
    return;
  }
  if (!active.footprint) applyFrustumGeometry(active);
  const cam = active.camera;
  const video = isVideoFeedType(normalizeFeedType(cam.feedType));
  const anchor = active.footprint?.axisEnd || { lat: cam.lat, lon: cam.lon };
  host.setVisible(CCTV_PROJECTION_OVERLAY_SOURCE_ID, true);
  host.setEntries(
    CCTV_PROJECTION_OVERLAY_SOURCE_ID,
    [createCctvProjectionOverlayEntry({
      cameraId: cam.id,
      name: cam.name,
      position: { lon: anchor.lon, lat: anchor.lat, height: 0 },
      monitor: { src: video ? mediaUrlFor(cam) : frameUrlFor(cam, ACTIVE_FRAME_REFRESH_MS), video, width: 280 },
    })],
    CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  );
}

function clearProjectionOverlay() {
  const host = overlayHost();
  host.clearSource(CCTV_PROJECTION_OVERLAY_SOURCE_ID);
  host.setVisible(CCTV_PROJECTION_OVERLAY_SOURCE_ID, false);
}

/**
 * Hides a record set's visuals and re-arms the active camera's activation
 * (a disable→enable never re-enters the activation path by itself). The
 * second argument (Cesium volume destroyer) is kept for call compatibility
 * and ignored: MapLibre redraws coverage from the GeoJSON source.
 */
// eslint-disable-next-line no-unused-vars
export function hideCctvRecordVisuals(records, _destroyVolume = null, activeCameraId = null) {
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue;
    record.probeClampRangeM = null;
    if (record.camera?.id === activeCameraId) record.activationDone = false;
  }
}

function hideCctvVisuals() {
  hideCctvRecordVisuals(_records, null, _activeCameraId);
  clearProjectionOverlay();
  renderCameras();
  renderCoverage();
}

/** Applies coverage visibility/style state (footprints, icons, monitor). */
export function refreshCoverageStyles() {
  renderCameras();
  renderCoverage();
  renderProjection();
}

/*
 * Focus de-emphasis (ícones que cedem perto do alvo acompanhado): a função
 * pura continua exportada com o mesmo contrato (focusResumeGate.test.mjs),
 * sobre registros com `billboard` {position, color.withAlpha, show, width,
 * height, scale}. A camada MapLibre ainda não aplica o esmaecimento aos
 * ícones (pendência documentada: exigiria feature-state por câmera).
 */
/**
 * Apply the gated CCTV focus pass through the production color path.
 * @param {object} input
 * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
 */
export function applyCctvFocusDeemphasis({
  records,
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
  for (const record of records || []) {
    const bb = record.billboard;
    if (!bb) continue;
    const position = bb.position;
    // CCTV never publishes a tracked focus target, so every icon is ambient.
    const focus = advanceSpriteFocus(bb, {
      // Keep hidden icons in the state/release pass so the active count cannot
      // drop while a stale dim alpha remains waiting to reappear.
      screenPosition: bb.show === false || !position ? null : screenPositionFor(position),
      cameraDistance: position ? cameraDistanceFor(position) : Number.NaN,
      nowMs,
      target,
      params,
      spriteHalfWidthPx: (bb.width || 24) * (bb.scale || 1) * 0.5,
      spriteHalfHeightPx: (bb.height || 24) * (bb.scale || 1) * 0.5,
    });
    transitioning ||= focus.transitioning;
    if (focus.active) activeCount += 1;
    const base = baseColorFor(record);
    const alpha = base.alpha * focus.factor;
    if (focusAlphaNeedsWrite(bb.color?.alpha, alpha, params)) {
      // Order-independent narrow amendment to always-visible icons: CCTV
      // contacts retain a non-zero floor while yielding near the tracked target.
      bb.color = base.withAlpha(alpha);
      writes += 1;
    }
  }
  return { writes, transitioning, activeCount, ran: true };
}

// ---------------------------------------------------------------------------
// Ambient cards
// ---------------------------------------------------------------------------

function ensureCardFrameSlot(cameraId) {
  let slot = _cardFrameSlots.get(cameraId);
  if (!slot) {
    slot = createFrameSlot();
    _cardFrameSlots.set(cameraId, slot);
  }
  return slot;
}

function viewportSize() {
  const el = _engine?.container;
  return { width: el?.clientWidth || 0, height: el?.clientHeight || 0 };
}

function viewerHeightM() {
  return cameraAltitudeM(_engine);
}

function refreshAmbientCards() {
  if (!_enabled || !_engine || !_records.length) {
    overlayHost().setEntries(CCTV_OVERLAY_SOURCE_ID, [], CCTV_OVERLAY_SOURCE_OPTIONS);
    return;
  }
  const viewer = viewerCameraPosition();
  const viewerLat = viewer?.lat ?? 0;
  const viewerLon = viewer?.lon ?? 0;
  const activeId = _activeCameraId;
  const { width, height } = viewportSize();
  const marginX = width * CARD_VIEW_MARGIN;
  const marginY = height * CARD_VIEW_MARGIN;
  const cameraHeightM = viewerHeightM();

  const candidates = [];
  const screenById = new Map();
  for (const record of _records) {
    const id = record.camera.id;
    if (id === activeId) continue;
    let inView = false;
    let sx = NaN;
    let sy = NaN;
    const screen = _engine.project(record.camera.lon, record.camera.lat);
    if (screen?.visible
      && screen.x >= -marginX && screen.x <= width + marginX
      && screen.y >= -marginY && screen.y <= height + marginY) {
      inView = true;
      sx = screen.x;
      sy = screen.y;
      screenById.set(id, { sx, sy });
    }
    candidates.push({
      id,
      distanceKm: haversineKm(viewerLat, viewerLon, record.camera.lat, record.camera.lon),
      inView,
      isVideo: isVideoFeedType(normalizeFeedType(record.camera.feedType)),
      sx,
      sy,
    });
  }

  const { cardIds, budgets } = selectCctvLod(candidates, {
    cameraHeightM,
    incumbentIds: _cardIds,
    viewW: width,
    viewH: height,
  });
  const cardLimit = _geoLoading
    ? Math.min(budgets.cardLimit, CCTV_AMBIENT_CARD_DRAIN_CAP)
    : budgets.cardLimit;
  const decluttered = declutterCctvCards(
    cardIds
      .filter((id) => screenById.has(id) && isCctvCardAnchorSafe({ sy: screenById.get(id).sy, viewH: height }))
      .slice(0, cardLimit)
      .map((id, index) => ({ id, ...screenById.get(id), distanceKm: index })),
    { limit: cardLimit },
  );
  if (activeId) {
    _cardIds.delete(activeId);
    _cardGraceState.delete(activeId);
  }
  const retention = applyEvictionGrace({
    selectedIds: decluttered,
    builtIds: [..._cardIds],
    graceState: _cardGraceState,
    nowMs: Date.now(),
    cardLimit: budgets.cardLimit,
  });
  _cardIds = new Set(retention.keepIds);
  _cardGraceState = retention.graceState;

  const keepFrames = new Set(_cardIds);
  if (_hoverCardId) keepFrames.add(_hoverCardId);
  if (_activeCameraCardEnabled && _activeCameraId) keepFrames.add(_activeCameraId);
  const drops = planFrameCachePrune(
    [..._cardFrameSlots].map(([id, slot]) => ({ id, stamp: slot.stamp })),
    keepFrames,
  );
  for (const id of drops) _cardFrameSlots.delete(id);

  overlayHost().setSourceStyle?.(CCTV_OVERLAY_SOURCE_ID, cardScaleForAltitude(cameraHeightM));
  pushAmbientCardEntries();
}

function pushAmbientCardEntries() {
  const entries = [];
  let rank = 0;
  const push = (id, { pinned = false, active = false } = {}) => {
    const record = _recordById.get(id);
    if (!record) return;
    const position = record.position || { lon: record.camera.lon, lat: record.camera.lat, height: 0 };
    entries.push(createCctvThumbnailOverlayEntry({
      id,
      position,
      gapPx: CARD_GAP_PX,
      title: record.camera.name,
      frameSlot: ensureCardFrameSlot(id),
      rank: rank++,
      pinned,
      active,
    }));
  };
  for (const id of _cardIds) push(id, { pinned: id === _hoverCardId });
  if (_hoverCardId && !_cardIds.has(_hoverCardId) && _hoverCardId !== _activeCameraId) {
    push(_hoverCardId, { pinned: true });
  }
  if (_activeCameraCardEnabled && _activeCameraId) push(_activeCameraId, { active: true });
  overlayHost().setEntries(CCTV_OVERLAY_SOURCE_ID, entries, CCTV_OVERLAY_SOURCE_OPTIONS);
}

function handleHoverMove(point) {
  if (!_enabled || _cameraMoving || _calibrationMode || !point || !_engine) return;
  const now = Date.now();
  if (now - _hoverLastPickAt < HOVER_PICK_THROTTLE_MS) return;
  _hoverLastPickAt = now;
  let cameraId = null;
  try {
    const [hit] = _engine.pick(point.x, point.y, { layers: [LYR_CAM_ICON, LYR_CAM_HALO], radius: 3 });
    cameraId = hit?.properties?.id ?? null;
  } catch {
    cameraId = null;
  }
  if (cameraId && cameraId === _hoverCardId) {
    cancelHoverRelease();
    return;
  }
  const record = cameraId ? _recordById.get(cameraId) : null;
  const eligible = !!record
    && cameraId !== _activeCameraId
    && !_cardIds.has(cameraId)
    && !isVideoFeedType(normalizeFeedType(record.camera.feedType));
  if (eligible) {
    cancelHoverRelease();
    _hoverCardId = cameraId;
    pushAmbientCardEntries();
    hoverFetchCardFrame(record);
  } else if (_hoverCardId) {
    scheduleHoverRelease();
  }
}

function cancelHoverRelease() {
  if (_hoverReleaseTimer) {
    clearTimeout(_hoverReleaseTimer);
    _hoverReleaseTimer = 0;
  }
}

function scheduleHoverRelease() {
  if (_hoverReleaseTimer) return;
  _hoverReleaseTimer = setTimeout(() => {
    _hoverReleaseTimer = 0;
    _hoverCardId = null;
    pushAmbientCardEntries();
  }, HOVER_RELEASE_MS);
}

function clearHoverCard() {
  cancelHoverRelease();
  _hoverCardId = null;
  _hoverLastPickAt = 0;
}

function hoverFetchCardFrame(record) {
  const cameraId = record.camera.id;
  if (_cardFetchPendingIds.has(cameraId)) return;
  if (_cardFetchInFlightCount >= CCTV_CARD_FETCH_BURST_LIMIT) return;
  const slot = ensureCardFrameSlot(cameraId);
  const refreshMs = staticFrameRefreshMs(record.camera);
  if (!frameFetchDue(slot, refreshMs, Date.now())) return;
  fetchCardFrame(record, slot, refreshMs, { userGesture: true });
}

function cardFrameTick() {
  if (!_enabled || (!_cardIds.size && !(_activeCameraCardEnabled && _activeCameraId))) return;
  const now = Date.now();
  let frameless = null;
  let stalest = null;
  let coldFill = false;
  const consider = (id) => {
    const record = _recordById.get(id);
    if (!record) return;
    const slot = ensureCardFrameSlot(id);
    if (_cardFetchPendingIds.has(id)) {
      if (!(slot.stamp > 0)) coldFill = true;
      return;
    }
    const refreshMs = staticFrameRefreshMs(record.camera);
    if (!frameFetchDue(slot, refreshMs, now)) return;
    if (!(slot.stamp > 0)) {
      coldFill = true;
      if (!frameless) frameless = { record, slot, refreshMs };
      return;
    }
    if (!stalest || slot.stamp < stalest.slot.stamp) stalest = { record, slot, refreshMs };
  };
  if (_activeCameraCardEnabled && _activeCameraId) consider(_activeCameraId);
  for (const id of _cardIds) consider(id);
  const policy = cardFetchPolicy({
    coldFill: coldFill && !_geoLoading,
    inFlight: _cardFetchInFlightCount,
    sinceLastLaunchMs: _cardLastFetchAt > 0 ? now - _cardLastFetchAt : Infinity,
  });
  _cardFetchMode = policy.mode;
  if (!policy.launch) return;
  const pick = frameless || stalest;
  if (pick) fetchCardFrame(pick.record, pick.slot, pick.refreshMs);
}

function fetchCardFrame(record, slot, refreshMs, { userGesture = false } = {}) {
  if (typeof document !== 'undefined' && document.hidden && !userGesture) return;
  const now = Date.now();
  const cameraId = record.camera.id;
  _cardFetchInFlightCount += 1;
  _cardFetchPendingIds.add(cameraId);
  if (_cardLastFetchAt > 0 && !userGesture) {
    const spacing = now - _cardLastFetchAt;
    _cardMinFetchSpacingMs = _cardMinFetchSpacingMs == null ? spacing : Math.min(_cardMinFetchSpacingMs, spacing);
  }
  _cardLastFetchAt = now;
  _cardFetchCount += 1;

  const image = new Image();
  _cardFetchImages.add(image);
  const settle = (ok) => {
    image.onload = null;
    image.onerror = null;
    if (_cardFetchImages.delete(image)) {
      _cardFetchInFlightCount = Math.max(0, _cardFetchInFlightCount - 1);
      _cardFetchPendingIds.delete(cameraId);
    }
    let frame = null;
    if (ok) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = CCTV_FRAME_CANVAS_W;
        canvas.height = CCTV_FRAME_CANVAS_H;
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        frame = canvas;
      } catch {
        frame = null;
      }
    }
    Object.assign(slot, applyFrameResult(slot, { ok: !!frame, frame }, Date.now()));
    // Repaint the card that shows this slot (the host diff redraws it).
    if (frame && _enabled && (_cardIds.has(cameraId) || _hoverCardId === cameraId
      || (_activeCameraCardEnabled && _activeCameraId === cameraId))) {
      pushAmbientCardEntries();
    }
  };
  image.onload = () => settle(true);
  image.onerror = () => settle(false);
  image.src = frameUrlFor(record.camera, refreshMs);
}

function startCardFrameLoop() {
  if (_cardFetchTimer) return;
  _cardFetchTimer = setInterval(cardFrameTick, CARD_FETCH_TICK_MS);
}

function abortCardFetches() {
  for (const image of _cardFetchImages) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute?.('src');
  }
  _cardFetchImages.clear();
  _cardFetchPendingIds.clear();
  _cardFetchInFlightCount = 0;
}

function stopCardFrameLoop() {
  if (_cardFetchTimer) {
    clearInterval(_cardFetchTimer);
    _cardFetchTimer = 0;
  }
  abortCardFetches();
  _cardFetchMode = 'steady';
}

function teardownAmbientCards() {
  stopCardFrameLoop();
  const host = overlayHost();
  host.clearSource(CCTV_OVERLAY_SOURCE_ID);
  host.setVisible(CCTV_OVERLAY_SOURCE_ID, false);
  clearHoverCard();
  _cameraMoving = false;
  _cardIds = new Set();
  _cardGraceState = new Map();
  _cardFrameSlots = new Map();
  _cardFetchCount = 0;
  _cardLastFetchAt = 0;
  _cardMinFetchSpacingMs = null;
}

// ---------------------------------------------------------------------------
// Selection, calibration, focus
// ---------------------------------------------------------------------------

function nearestCameraIdToViewer() {
  const view = viewerCameraPosition();
  if (!view || !_records.length) return null;
  let best = null;
  for (const record of _records) {
    const distKm = haversineKm(view.lat, view.lon, record.camera.lat, record.camera.lon);
    if (!best || distKm < best.distKm) best = { id: record.camera.id, distKm };
  }
  return best?.id || null;
}

/**
 * Applies a calibration patch to a record's IN-MEMORY pose (save-gated
 * persistence: only the explicit `calibration.save` action persists).
 * Transient grade (gizmo mid-drag) recomputes geometry with a throttled notify.
 * @param {Object} record
 * @param {Object} patch - Partial 7-field calibration (absolute offset values).
 * @param {{transient?: boolean}} [options]
 * @returns {boolean}
 */
function applyCalibrationPatch(record, patch, options = {}) {
  if (!record || !patch || typeof patch !== 'object') return false;
  record.camera.calibration = normalizeCalibration({ ...record.camera.calibration, ...patch });
  ensureCameraPose(record.camera);
  if ('rangeScale' in patch) record.probeClampRangeM = null;
  record.calDirty = true;
  applyFrustumGeometry(record);
  if (options.transient === true) {
    renderCameras();
    renderCoverage();
    notifyListenersThrottled();
    return true;
  }
  return true;
}

function ensureGizmo() {
  if (_gizmo || !_engine) return;
  const liveRecord = (record) => (
    record && _recordById.get(record.camera?.id) === record ? record : null
  );
  _gizmo = createCalibrationGizmo({
    engine: _engine,
    getActiveRecord: () => (_enabled && _calibrationMode ? getActiveRecord() : null),
    applyPatch: (patch, draggedRecord) => {
      const record = _enabled && _calibrationMode ? liveRecord(draggedRecord) : null;
      if (record) applyCalibrationPatch(record, patch, { transient: true });
    },
    endPatch: (draggedRecord) => {
      const record = liveRecord(draggedRecord);
      if (!record) return;
      applyFrustumGeometry(record);
      refreshCoverageStyles();
      notifyListeners();
    },
  });
}

/**
 * Sets the active camera by ID and refreshes its footprint, monitor and styles.
 * @param {string} cameraId
 * @returns {'activated'|'unchanged'|'not-found'}
 */
export function setActiveCamera(cameraId) {
  if (!cameraId || !_recordById.has(cameraId)) return CCTV_ACTIVATION_RESULT.NOT_FOUND;
  const record = _recordById.get(cameraId);
  const previousActiveRecord = getActiveRecord();
  if (!cctvRecordNeedsActivation(cameraId, _activeCameraId, record)) {
    return CCTV_ACTIVATION_RESULT.UNCHANGED;
  }
  _activeCameraId = cameraId;
  _autoHopSuspended = false;
  if (previousActiveRecord && previousActiveRecord !== record) {
    clearProbeClampOnDeactivation(previousActiveRecord, applyFrustumGeometry);
  }
  _cardIds.delete(cameraId);
  _cardGraceState.delete(cameraId);
  if (_hoverCardId === cameraId) clearHoverCard();
  prioritizeActiveCctvGeometryRecord(_geoQueue, record);
  runActivationObstructionProbe(record);
  applyFrustumGeometry(record);
  record.activationDone = true;
  refreshCoverageStyles();
  refreshAmbientCards();
  _gizmo?.refresh();
  notifyListeners();
  return CCTV_ACTIVATION_RESULT.ACTIVATED;
}

/**
 * Clears the active CCTV camera in place without moving the map or disabling
 * the layer.
 * @returns {boolean} True when a camera was deactivated.
 */
export function deactivateActiveCamera() {
  const record = _activeCameraId ? _recordById.get(_activeCameraId) : null;
  if (!record) return false;
  _activeCameraId = null;
  _autoHopSuspended = true;
  record.activationDone = false;
  clearProbeClampOnDeactivation(record, applyFrustumGeometry);
  refreshCoverageStyles();
  refreshAmbientCards();
  _gizmo?.refresh();
  notifyListeners();
  return true;
}

/**
 * True only for a click that is empty from CCTV's perspective: an active
 * camera exists, ADJUST does not own the pointer, and the click hit nothing
 * identified. `picked` is the layer host's hit (`{feature, def}`) or any
 * object carrying an `id`/`primitive.id` (Cesium-era shape, still honored).
 * @param {Object|null} picked
 * @param {{activeCameraId?: string|null, calibrationMode?: boolean}} [context]
 * @returns {boolean}
 */
export function cctvEmptyClickDeselects(picked, {
  activeCameraId = null,
  calibrationMode = false,
} = {}) {
  if (!activeCameraId || calibrationMode) return false;
  if (!picked) return true;
  if (picked.feature || picked.def) return false;
  if (picked.id !== undefined && picked.id !== null) return false;
  if (picked.primitive?.id !== undefined && picked.primitive?.id !== null) return false;
  return true;
}

/**
 * Flies the map to frame the specified CCTV camera, looking along its heading
 * from above (MapLibre: `engine.flyToTarget`).
 * @param {Object|null} engine Motor MapLibre (antes: Cesium.Viewer).
 * @param {Object|null} record CCTV camera runtime record.
 * @param {number} [duration=2.2] - Flight duration in seconds.
 * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'}
 */
export function focusCctvRecord(engine, record, duration = 2.2) {
  if (!engine || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
  if (typeof document !== 'undefined'
    && document.body?.classList?.contains('cockpit-mode')) {
    console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
    return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
  }
  if (engine.trackedTarget) {
    console.debug('[Data:CCTV] focus ignored while a tracked target owns the camera');
    return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
  }
  const { camera } = record;
  const range = Math.max(280, camera.rangeM * 1.18);
  // Aim at the middle of the view cone so camera and footprint share the frame.
  const mid = projectPoint(camera.lat, camera.lon, camera.headingDeg, (record.footprint?.farM ?? camera.rangeM) * 0.4);
  engine.flyToTarget({ lat: mid.lat, lon: mid.lon, height: 0 }, {
    rangeM: range,
    heading: camera.headingDeg,
    pitch: -40,
    duration: Math.max(0.2, duration || 0),
  });
  return CCTV_FOCUS_RESULT.FOCUSED;
}

function focusCamera(cameraId, duration = 2.2) {
  return focusCctvRecord(_engine, _recordById.get(cameraId), duration);
}

// ---------------------------------------------------------------------------
// Runtime wiring (map events)
// ---------------------------------------------------------------------------

function loadIconImage() {
  if (_iconImage || typeof Image === 'undefined') return Promise.resolve(_iconImage);
  return new Promise((resolve) => {
    const img = new Image(36, 36);
    img.onload = () => {
      _iconImage = img;
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = CAMERA_ICON;
  });
}

function ensureIcon() {
  if (!_map || !_iconImage) return;
  if (!_map.hasImage?.(ICON_ID)) _map.addImage(ICON_ID, _iconImage, { pixelRatio: 1 });
}

function wireMapEvents() {
  if (_offs.length || !_engine) return;
  _offs.push(_engine.on('moveend', () => {
    _cameraMoving = false;
    refreshAmbientCards();
  }));
  _offs.push(_engine.on('movestart', () => {
    _cameraMoving = true;
  }));
  _offs.push(_engine.on('mousemove', (e) => handleHoverMove(e)));
  _offs.push(_engine.on('click', (e) => {
    if (!_enabled) return;
    const host = getActiveLayerHost();
    const hit = host?.pickAt?.(e.x, e.y) ?? null;
    if (cctvEmptyClickDeselects(hit, {
      activeCameraId: _activeCameraId,
      calibrationMode: _calibrationMode,
    })) {
      deactivateActiveCamera();
    }
  }));
  // Basemap swaps drop style images; re-add the camera icon on demand.
  const onMissing = (e) => {
    if (e?.id === ICON_ID) ensureIcon();
  };
  _map.on('styleimagemissing', onMissing);
  _offs.push(() => _map?.off('styleimagemissing', onMissing));
  overlayHost().onActivate?.(CCTV_OVERLAY_SOURCE_ID, (cameraId) => {
    if (_enabled && _recordById.has(cameraId)) activateCctvCameraFromWorldClick(cameraId, setActiveCamera);
  });
}

function unwireMapEvents() {
  for (const off of _offs) {
    try {
      off?.();
    } catch {
      // listener already gone
    }
  }
  _offs = [];
}

function clearRuntimeState() {
  stopGeometryLoadQueue();
  teardownAmbientCards();
  clearProjectionOverlay();
  _records = [];
  _recordById = new Map();
  _healthById = new Map();
  _count = 0;
  _lastUpdate = null;
  _lastHealthSyncAt = 0;
  _lastError = null;
}

/**
 * Primes the minimum module state needed to exercise the production paths in
 * unit tests.
 * @param {Object} [options={}]
 */
export function _setCctvCoverageStateForTest({
  engine = null,
  viewer = null,
  records = [],
  activeCameraId = null,
  enabled = true,
  coverageMode = 'on',
  showProjection = false,
} = {}) {
  _engine = engine || viewer;
  _map = _engine?.map || null;
  _records = Array.isArray(records) ? records : [];
  _recordById = new Map(
    _records
      .filter((record) => record?.camera?.id)
      .map((record) => [record.camera.id, record]),
  );
  _activeCameraId = activeCameraId;
  _autoHopSuspended = false;
  _enabled = !!enabled;
  _coverageMode = normalizeCoverageMode(coverageMode, 'on');
  _showProjection = !!showProjection;
}

/** Test seam: the coverage GeoJSON the layer would draw right now. */
export function _coverageFeaturesForTest() {
  return coverageFeatures();
}

// ---------------------------------------------------------------------------
// Exported layer object — standard layer interface + CCTV-specific methods
// ---------------------------------------------------------------------------

const cctvLayer = {
  id: 'cctv',
  name: 'CCTV',
  icon: '📹',
  source: 'CCTV + Street View fallback',
  updateInterval: DEFAULT_UPDATE_INTERVAL_MS,

  /**
   * Loads camera sources, builds the catalog, restores calibration and adds
   * the MapLibre sources/layers (hidden until enable).
   * @param {Object} engine - Motor MapLibre (src/maplibre/engine.js).
   */
  async init(engine) {
    _engine = engine;
    _map = engine?.map || null;
    clearRuntimeState();
    _enabled = false;
    _activeCameraId = null;
    _autoHopSuspended = false;
    _lastHopAt = 0;
    _lastViewContext = '';
    _calibrationById = loadCalibrationStore();

    const host = getActiveLayerHost();
    host?.register(CCTV_LAYER_DEF);
    await loadIconImage();
    ensureIcon();
    host?.ensureAdded(CCTV_LAYER_DEF);

    const sources = await loadCameraSources();
    const catalogFromSources = buildCatalogFromSources(sources);
    const catalog = catalogFromSources.length ? catalogFromSources : seedCatalog();

    // Viewshed color identity: golden-angle hue over the id-SORTED catalog index.
    const hueIndexById = new Map(
      catalog.map((camera) => camera.id).sort().map((id, index) => [id, index]),
    );

    for (const camera of catalog) {
      const savedEntry = _calibrationById.get(camera.id);
      if (savedEntry) {
        camera.calibration = normalizeCalibration(savedEntry.values);
        camera.calSource = savedEntry.source;
      }
      ensureCameraPose(camera);
      const record = {
        camera,
        position: { lon: camera.lon, lat: camera.lat, height: camera.mountHeightM },
        frustumGeometry: null,
        footprint: null,
        probeClampRangeM: null,
        viewshedColors: viewshedColors(cameraHue(hueIndexById.get(camera.id) ?? 0)),
      };
      _records.push(record);
      _recordById.set(camera.id, record);
    }

    _count = _records.length;
    if (_records.length > 0) _activeCameraId = _records[0].camera.id;

    wireMapEvents();
    await syncHealthState(true);
    notifyListeners();
    console.log('[Data:CCTV] Initialized with', _count, 'cameras');
    return true;
  },

  /** Shows the layer, starts the staggered catalog pass and the card pacer. */
  enable() {
    _enabled = true;
    _lastUpdate = Date.now();
    getActiveLayerHost()?.setVisible(CCTV_LAYER_DEF.id, true);
    if (!_activeCameraId && _records.length) {
      _activeCameraId = _records[0].camera.id;
      _autoHopSuspended = false;
    }
    const active = getActiveRecord();
    if (active) applyFrustumGeometry(active);
    startGeometryLoadQueue();
    refreshCoverageStyles();
    const host = overlayHost();
    host.setVisible(CCTV_OVERLAY_SOURCE_ID, true);
    startCardFrameLoop();
    refreshAmbientCards();
    clearInterval(_projectionTimer);
    _projectionTimer = setInterval(() => {
      if (_enabled && _showProjection) renderProjection();
    }, ACTIVE_FRAME_REFRESH_MS);
    notifyListeners();
    return true;
  },

  /** Hides the layer, stops the card pacer and the catalog pass. */
  disable() {
    _enabled = false;
    _calibrationMode = false;
    _gizmo?.setEnabled(false);
    clearInterval(_projectionTimer);
    _projectionTimer = 0;
    stopGeometryLoadQueue();
    teardownAmbientCards();
    hideCctvVisuals();
    getActiveLayerHost()?.setVisible(CCTV_LAYER_DEF.id, false);
    notifyListeners();
    return true;
  },

  /** Periodic tick: health sync, auto-hop, panel state. */
  async update() {
    if (!_enabled) return true;
    const now = Date.now();
    _lastUpdate = now;
    await syncHealthState();
    maybeAutoHop(now);
    notifyListeners();
    return true;
  },

  /** Tears down listeners, markers, sources state and subscribers. */
  destroy() {
    this.disable();
    unwireMapEvents();
    if (_gizmo) {
      _gizmo.destroy();
      _gizmo = null;
    }
    clearRuntimeState();
    _engine = null;
    _map = null;
    _activeCameraId = null;
    _autoHopSuspended = false;
    _listeners.clear();
    return true;
  },

  /**
   * Runtime parameters: coverage/projection toggles, auto-hop, selection and
   * calibration (patch/save/reset), ADJUST mode, focus. Same keys as before.
   * @param {Object} [params={}]
   */
  setParams(params = {}) {
    if (typeof params.showCoverage === 'boolean') {
      _coverageMode = normalizeCoverageMode(params.showCoverage, _coverageMode);
    }
    if (typeof params.coverageMode === 'string') {
      _coverageMode = normalizeCoverageMode(params.coverageMode, _coverageMode);
    }
    if (typeof params.showProjection === 'boolean') {
      _showProjection = params.showProjection;
    }
    if (typeof params.autoHop === 'boolean') {
      _autoHop = params.autoHop;
      if (params.autoHop) _autoHopSuspended = false;
    }
    if (typeof params.autoHopSec === 'number' && Number.isFinite(params.autoHopSec)) {
      _autoHopSec = clamp(Math.round(params.autoHopSec), MIN_AUTO_HOP_SEC, MAX_AUTO_HOP_SEC);
    }
    if (typeof params.selectedCameraId === 'string' && _recordById.has(params.selectedCameraId)) {
      setActiveCamera(params.selectedCameraId);
    }
    if (params.calibration && typeof params.calibration === 'object') {
      const calibrationCfg = params.calibration;
      const targetCameraId = typeof calibrationCfg.cameraId === 'string' && calibrationCfg.cameraId
        ? calibrationCfg.cameraId
        : _activeCameraId;
      const targetRecord = targetCameraId ? _recordById.get(targetCameraId) : null;
      if (targetRecord) {
        if (calibrationCfg.reset) {
          targetRecord.camera.calibration = normalizeCalibration(DEFAULT_CAMERA_CALIBRATION);
          targetRecord.camera.calSource = null;
          targetRecord.calDirty = false;
          ensureCameraPose(targetRecord.camera);
          _calibrationById.delete(targetCameraId);
          saveCalibrationStore();
          applyFrustumGeometry(targetRecord);
        }
        if (calibrationCfg.patch && typeof calibrationCfg.patch === 'object') {
          applyCalibrationPatch(targetRecord, calibrationCfg.patch);
        }
        if (calibrationCfg.save) {
          if (isDefaultCalibration(targetRecord.camera.calibration)) {
            targetRecord.camera.calSource = null;
            _calibrationById.delete(targetCameraId);
          } else {
            targetRecord.camera.calSource = 'manual';
            _calibrationById.set(targetCameraId, {
              values: { ...targetRecord.camera.calibration },
              source: 'manual',
              savedAt: Date.now(),
            });
          }
          targetRecord.calDirty = false;
          saveCalibrationStore();
        }
      }
    }
    if (typeof params.calibrationMode === 'boolean') {
      _calibrationMode = params.calibrationMode;
      if (_calibrationMode) {
        ensureGizmo();
        _gizmo?.setEnabled(true);
      } else {
        _gizmo?.setEnabled(false);
      }
    }
    if (params.focusSelected && _activeCameraId) {
      focusCamera(_activeCameraId, Number(params.focusDurationSec) || 1.8);
    }
    refreshCoverageStyles();
    _gizmo?.refresh();
    notifyListeners();
    return true;
  },

  /** @returns {Object} Current runtime parameters (link options included). */
  getParams() {
    const active = getActiveRecord();
    return {
      showCoverage: _coverageMode !== 'off',
      coverageMode: _coverageMode,
      showProjection: _showProjection,
      calibrationMode: _calibrationMode,
      autoHop: _autoHop,
      autoHopSec: _autoHopSec,
      selectedCameraId: active?.camera.id || null,
      calibration: active?.camera ? {
        cameraId: active.camera.id,
        values: { ...normalizeCalibration(active.camera.calibration) },
      } : null,
    };
  },

  /**
   * Sampled camera positions for the detection overlay.
   * @returns {{position:{lon:number,lat:number,height:number}, lon:number, lat:number, height:number, sourceId:string, id:string, type:string}[]}
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || _records.length === 0) return [];
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : _records.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(_records.length / maxCount));
    const start = seed % stride;
    const objects = [];
    for (let i = start; i < _records.length; i += stride) {
      const camera = _records[i].camera;
      const position = { lon: camera.lon, lat: camera.lat, height: camera.mountHeightM };
      objects.push({
        position,
        lon: position.lon,
        lat: position.lat,
        height: position.height,
        sourceId: camera.id,
        id: `CAM-${camera.id}`,
        type: 'CAM',
      });
      if (objects.length >= maxCount) break;
    }
    return objects;
  },

  /** @returns {{count:number, lastUpdate:number|null, error:string|null, loading:boolean, loadingLoaded:number, loadingTotal:number}} */
  getStats() {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _lastError,
      loading: _geoLoading,
      loadingLoaded: Math.min(_geoLoadDone, _geoLoadTotal),
      loadingTotal: _geoLoadTotal,
    };
  },

  /** Registers a UI-state listener (called immediately). @returns {Function} unsubscribe */
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    _listeners.add(callback);
    callback(uiState());
    return () => {
      _listeners.delete(callback);
    };
  },

  getUIState() {
    return uiState();
  },

  setCardPresentationOptions(options = {}) {
    return setCctvCardPresentationOptions(options);
  },

  selectCamera(cameraId, options = {}) {
    const result = setActiveCamera(cameraId);
    if (result === CCTV_ACTIVATION_RESULT.NOT_FOUND) return false;
    if (options.focus) focusCamera(cameraId, options.durationSec || 1.8);
    return true;
  },

  focusCamera(cameraId, durationSec = 2.2) {
    return focusCamera(cameraId, durationSec);
  },

  cycleCamera(step = 1, options = {}) {
    if (!_records.length) return null;
    const current = getActiveRecord();
    const nextIdx = cctvCycleIndex(
      _records.findIndex((record) => record === current),
      step,
      _records.length,
    );
    const nextId = _records[nextIdx].camera.id;
    setActiveCamera(nextId);
    if (options.focus) focusCamera(nextId, options.durationSec || 1.8);
    return nextId;
  },

  focusNearest(options = {}) {
    const nearest = nearestCameraIdToViewer();
    if (!nearest) return null;
    setActiveCamera(nearest);
    if (options.focus !== false) focusCamera(nearest, options.durationSec || 1.8);
    return nearest;
  },
};

export default cctvLayer;
