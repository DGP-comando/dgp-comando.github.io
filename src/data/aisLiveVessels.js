// src/data/aisLiveVessels.js
//
// NAVIOS AIS AO VIVO (camada GEV 'ais-live-vessels') — desenhada no MapLibre
// ==========================================================================
//
// Posições ao vivo do AISStream via proxy do dev-server (`/api/ais-live`,
// trilha em `/api/ais-live/track`). Desligada no build de produção
// (PROXY_DEPENDENT_LAYER_IDS em main.js); no dev liga e desenha no MapLibre.
//
// O que mudou na migração do Cesium (comportamento preservado):
// - chevron por tipo (vesselLabels.vesselTypeCss) girado pelo rumo verdadeiro:
//   era BillboardCollection + rotação projetada na tela; agora é um layer
//   symbol com `icon-rotate` = rumo e `icon-rotation-alignment: map` (o
//   MapLibre gira com o mapa, sem a passada de rotação por quadro);
// - cartões de rótulo (título + tipo/velocidade/rumo) eram entradas do
//   worldOverlay com declutter em grade de 118 px; agora são rótulos symbol
//   do MapLibre, com colisão nativa, prioridade (`symbol-sort-key`) e o mesmo
//   teto de linhas (labelRowLimit). O navio selecionado ganha o cartão
//   completo, sempre visível (texto dos MESMOS builders buildVesselCard /
//   buildSelectedVesselCard);
// - oclusão pelo horizonte (EllipsoidalOccluder) é feita pelo próprio globo
//   do MapLibre; o datum vertical (geoide) deixou de importar no mapa 2D —
//   vesselDatumHeightM continua exportado para quem mede altura;
// - clique: seleciona, pede a transferência de câmera à UI (requestWorldFocus,
//   enquadramento WORLD_FOCUS_FRAMING.vessel) e acompanha o navio com
//   engine.track; outro alvo acompanhado (trackedchange) solta a seleção, como
//   o trackedEntityChanged do Cesium;
// - esmaecimento de foco (focusDeemphasis.js): a mesma passada de 80 ms e o
//   mesmo applyVesselFocusDeemphasis, escrevendo o alfa em feature-state
//   (`icon-opacity`) em vez de billboard.color;
// - tooltip de hover pelo anfitrião de camadas (vesselTooltip.js);
// - trilha do navio selecionado: trailRenderer.createTrail(engine).
//
// API PÚBLICA (mesmos nomes; tipos Cesium trocados por neutros):
//   `position` agora é o ponto neutro de geoPoint.js
//   ({lon, lat, height, x, y, z} — graus + ECEF WGS84), em findByQuery,
//   getNearby, getAllPositions e getDetectableObjects. getNearby aceita o
//   centro em qualquer formato de toGeoPoint (inclusive Cartesian3 antigo).
//   init/enable/update/destroy recebem o `engine` (src/maplibre/engine.js).

import {
  registerEntityContext,
  selectEntityContext,
  clearSelectedEntityContextForLayer,
} from './contextStore.js';
import { formatKnots } from './detectionDraw.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  unregisterPickOwner,
  resolvePickId,
} from './pickRegistry.js';
import {
  accentForVesselType,
  VESSEL_CARD_FADE_DISTANCE_M,
  vesselTypeCss,
  normalizeVesselType,
} from './vesselLabels.js';
import { vesselTooltipHtml } from './vesselTooltip.js';
import { createTrail } from './trailRenderer.js';
import {
  advanceSpriteFocus,
  focusNowMs,
  focusAlphaNeedsWrite,
  focusPassIsNeeded,
  forgetSpriteFocus,
  getFocusTarget,
} from './focusDeemphasis.js';
import { requestWorldFocus } from '../worldFocus.js';
import { geoPoint, geoDistanceM, toGeoPoint } from './geoPoint.js';
import { defineLayer, EMPTY_FC, TEXT_FONT, TEXT_FONT_BOLD, zoomForHeight } from '../maplibre/kit.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';

const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;
const LAYER_ID = 'ais-live-vessels';

const DEFAULT_API_URL = '/api/ais-live';
const DEFAULT_RENDER_ROWS = 12000;
const DEFAULT_ACTIVE_LABELS = 900;
const REFRESH_MS = 60000;
/** Bounded wait for the first accepted vessel position in one enabled session. */
export const AIS_FIRST_CONNECT_GRACE_MS = 30000;
const AIS_FIRST_CONNECT_LABEL = 'awaiting first AIS position…';
/** Number of consecutive refreshes a selected-but-vanished vessel is retained. */
const SELECTED_PIN_REFRESHES = 3;
/** Trail hue for the selected vessel (PRD F4, pinned to the AIS teal-green family). */
const TRAIL_COLOR = '#39ffd5';
/** Slight lift (m) for trail vertices to avoid sea-surface z-fighting. */
const TRAIL_HEIGHT_M = 3;
/**
 * Lift (m) above the local sea surface (geoid) for vessel anchors — locked
 * height-datum principle #1: never below the visible surface, slightly above
 * is always fine (clears tide/mesh noise in the photoreal sea mesh).
 */
const VESSEL_LIFT_M = 3;
/** Combined cap on trail vertices (server backfill + live accumulation). */
const TRAIL_MAX_POINTS = 400;
/** Minimum movement (m) before a reconcile refresh appends a new trail point. */
const TRAIL_MIN_MOVE_M = 25;

const DEFAULT_AIS_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});
let _aisRuntime = DEFAULT_AIS_RUNTIME;
let _aisSessionSequence = 0;

/**
 * Human-readable reasons for a non-'open' AISStream feed status, keyed to the
 * server's `_aisStreamStatus` values (see vite.config.js). Surfaced verbatim in
 * the layer chip so a dead feed reads "feed down" instead of a healthy-looking
 * "just now · 0 vessels".
 */
const AIS_STATUS_REASON = {
  'missing-key': 'AISSTREAM_API_KEY not set',
  unsupported: 'live feed unsupported',
  connecting: 'connecting to feed…',
  closed: 'feed disconnected',
  error: 'feed down',
  idle: 'feed idle',
};

/**
 * Statuses in which fresh data is flowing. 'open' is the pre-watchdog spelling
 * and is still accepted so a cached bundle and a restarted server never
 * disagree about health.
 */
const AIS_HEALTHY_STATUSES = new Set(['live', 'open']);

/**
 * Server statuses meaning "the feed is not delivering right now". These are
 * surfaced even while cached vessels are still drawn: rows retained from
 * before the outage must never make a dead feed read as a healthy one.
 */
const AIS_DEGRADED_STATUSES = new Set(['stale', 'reconnecting', 'down', 'auth-failed']);

/**
 * Seconds until the server's next reconnect attempt, or 0 when none is
 * scheduled. Mirrors the flights layer's `retryInSec` chip affordance.
 * @returns {number}
 */
function aisRetryInSec() {
  // A rejected key is terminal until someone changes it; an hour-long
  // countdown would imply waiting is the fix.
  if (state.transportStatus === 'auth-failed') return 0;
  const at = Number(state.nextAttemptAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.max(0, Math.ceil((at - _aisRuntime.now()) / 1000));
}

/**
 * Chip text for a feed the server has reported as not delivering.
 * @param {string} status - 'stale' | 'reconnecting' | 'down'
 * @param {Object} payload - Parsed /api/ais-live JSON.
 * @returns {string}
 */
function describeDegradedAisFeed(status, payload) {
  if (status === 'auth-failed') {
    // Actionable, not a countdown: retrying cannot fix a rejected credential,
    // so the chip asks the operator to do the one thing that can.
    return 'API key rejected — check AISSTREAM_API_KEY';
  }
  if (status === 'stale') {
    const silentSec = Math.round(Number(payload?.silentForMs) / 1000);
    return Number.isFinite(silentSec) && silentSec > 0
      ? `feed silent ${silentSec}s — no AIS data`
      : 'feed silent — no AIS data';
  }
  const attempt = Number(payload?.reconnectAttempt);
  const suffix = Number.isFinite(attempt) && attempt >= 1 ? ` (attempt ${attempt})` : '';
  return status === 'down'
    ? `feed down — retrying slowly${suffix}`
    : `reconnecting to feed…${suffix}`;
}

/**
 * Derive a surfaced error string from an /api/ais-live payload, or null when the
 * feed has accepted product data. Socket transport, message receipt, and usable
 * vessel positions are separate health stages: an open socket with no message
 * or no accepted positions must not read as a fresh successful update.
 *
 * @param {Object|null|undefined} payload - Parsed /api/ais-live JSON.
 * @param {number} acceptedRowCount - Number of rows accepted by vessel normalization.
 * @returns {string|null} A short reason for the chip, or null if healthy.
 */
export function deriveAisFeedError(payload, acceptedRowCount) {
  const status = payload && typeof payload.status === 'string' ? payload.status : null;
  // A feed the server reports as not delivering outranks the row count: the
  // cached vessels on screen are exactly what makes an outage invisible.
  if (status && AIS_DEGRADED_STATUSES.has(status)) {
    return describeDegradedAisFeed(status, payload);
  }
  if (acceptedRowCount > 0) return null; // accepted rows may be stale while reconnecting, but remain usable
  if (AIS_HEALTHY_STATUSES.has(status)) {
    return payload?.lastMessageAt
      ? 'awaiting usable AIS positions…'
      : 'awaiting first AIS message…';
  }
  if (!status) return null;
  const detail = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim() : '';
  const reason = AIS_STATUS_REASON[status] || 'feed unavailable';
  return detail && !AIS_STATUS_REASON[status] ? `${reason} (${detail})` : reason;
}

/** True when a raw AIS row can enter the production vessel normalizer. */
function hasUsableVesselCoordinates(row) {
  return Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon));
}

/**
 * Classify one server snapshot before any destructive reconciliation.
 * @param {Object|null|undefined} payload - Parsed /api/ais-live payload.
 * @returns {{transportStatus: string|null, lastMessageAt: number|string|null,
 *   rawRows: Array<Object>, acceptedRows: Array<Object>, rawRowCount: number,
 *   acceptedRowCount: number, error: string|null}}
 */
export function classifyAisFeedSnapshot(payload) {
  const rawRows = Array.isArray(payload?.rows) ? payload.rows : [];
  const acceptedRows = rawRows.filter(hasUsableVesselCoordinates);
  const transportStatus = typeof payload?.status === 'string' ? payload.status : null;
  const lastMessageAt = payload?.lastMessageAt ?? null;
  const acceptedRowCount = acceptedRows.length;
  return {
    transportStatus,
    lastMessageAt,
    rawRows,
    acceptedRows,
    rawRowCount: rawRows.length,
    acceptedRowCount,
    error: deriveAisFeedError(payload, acceptedRowCount)
      || (acceptedRowCount === 0 ? 'awaiting usable AIS positions…' : null),
  };
}

/**
 * Map one internal vessel record to a plain JSON-safe analyst record
 * (analyst query engine seam). Pure, no map-engine types. Missing/unknown
 * fields are null, never NaN/undefined. navStatus is always null: the
 * /api/ais-live proxy does not surface AIS NavigationalStatus, so it
 * cannot be derived client-side.
 * @param {Object|null|undefined} record - `state.vesselMap`/`state.vesselRecords` entry.
 * @returns {{id: string|null, mmsi: string|null, name: string|null,
 *   lat: number|null, lon: number|null, speedKts: number|null,
 *   courseDeg: number|null, shipType: string|null, destination: string|null,
 *   navStatus: null}}
 */
export function mapAnalystRecord(record) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const mmsi = text(record?.mmsi);
  const name = text(record?.name);
  return {
    id: name || mmsi,
    mmsi,
    name,
    lat: num(record?.lat),
    lon: num(record?.lon),
    speedKts: num(record?.speed),
    courseDeg: num(record?.course),
    shipType: text(record?.type),
    destination: text(record?.destination),
    navStatus: null,
  };
}

/**
 * Ellipsoidal render height (m) for a sea-surface object: the local geoid
 * undulation N plus a small lift. The sea surface ≈ the geoid, which sits
 * −106…+85 m off the WGS84 ellipsoid worldwide (Rotterdam ≈ +45 m — at
 * height 0 the tile sea mesh occludes every chevron; Houston ≈ −27 m).
 * Pure seam, exported for unit tests.
 * @param {number|null|undefined} geoidN - Undulation N (m), or null/undefined while the grid is cold.
 * @param {number} liftM - Lift above the sea surface (m).
 * @returns {number} Ellipsoidal height h = N + lift (N treated as 0 when absent).
 */
export function vesselDatumHeightM(geoidN, liftM) {
  return (Number.isFinite(geoidN) ? geoidN : 0) + liftM;
}

/**
 * Reduce one vessel-selection gesture to the layer-owned action it should
 * perform. The interaction handler reserves only vessel-record residuals and
 * trail picks as no-ops. The interaction wire also reserves sibling-owned
 * picks before this reducer so their camera action cannot mutate AIS state.
 *
 * @param {{selectedMmsi?: string|number|null, pickedMmsi?: string|number|null,
 *   gesture?: 'click'|'escape'}} input - Current selection plus owned pick.
 * @returns {{action: 'none'|'select'|'deselect'}}
 */
export function reduceVesselSelection(input = {}) {
  const selectedMmsi = normalizeSelectionMmsi(input.selectedMmsi);
  const pickedMmsi = normalizeSelectionMmsi(input.pickedMmsi);
  const gesture = input.gesture || 'click';

  if (gesture === 'escape') {
    return selectedMmsi
      ? { action: 'deselect' }
      : { action: 'none' };
  }
  if (gesture !== 'click') {
    return { action: 'none' };
  }
  if (pickedMmsi) {
    if (pickedMmsi === selectedMmsi) {
      return { action: 'none' };
    }
    return { action: 'select' };
  }
  return selectedMmsi
    ? { action: 'deselect' }
    : { action: 'none' };
}

function normalizeSelectionMmsi(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

// ---------------------------------------------------------------- MapLibre

const SRC_VESSELS = 'dg-ais-live';
const SRC_SELECTED = 'dg-ais-live-sel';
// Cards live in their own sources: a tile whose symbol layer waits on glyphs
// (font server slow/offline) must never hold back the chevrons.
const SRC_CARDS = 'dg-ais-live-cards';
const SRC_SELECTED_CARD = 'dg-ais-live-sel-card';
const LAYER_ICON = 'dg-ais-live-icon';
const LAYER_LABEL = 'dg-ais-live-label';
const LAYER_SEL_ICON = 'dg-ais-live-sel-icon';
const LAYER_SEL_LABEL = 'dg-ais-live-sel-label';
/** Layers whose features resolve to a vessel record on click (icons + cards). */
const VESSEL_PICK_LAYERS = [LAYER_SEL_ICON, LAYER_SEL_LABEL, LAYER_ICON, LAYER_LABEL];
const OWN_LAYERS = new Set(VESSEL_PICK_LAYERS);
/** Click tolerance around a chevron (px), like the old billboard pick box. */
const VESSEL_PICK_RADIUS_PX = 6;
const TRAIL_PICK_RADIUS_PX = 3;
/** Ambient cards fade out toward the old 5000 km camera-distance endpoint. */
const LABEL_FADE_END_ZOOM = zoomForHeight(VESSEL_CARD_FADE_DISTANCE_M);
/** Focus alpha samples every 80 ms (the old preRender FOCUS_UPDATE_MS). */
const FOCUS_UPDATE_MS = 80;
/** Chevron artwork size (px) before the per-vessel scale. */
const CHEVRON_PX = 32;
const CHEVRON_PREFIX = 'dg-ais-chev-';
const CHEVRON_PIXEL_RATIO = 2;
const CHEVRON_PATH = 'M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z';

/** Map image name for a vessel chevron (tinted per AIS type, white when selected). */
function chevronImageName(record, selected) {
  return selected
    ? `${CHEVRON_PREFIX}sel`
    : `${CHEVRON_PREFIX}${vesselTypeCss(record?.type).replace('#', '')}`;
}

/**
 * Rasterize the chevron synchronously (Path2D), so a missing image can be
 * re-added inside 'styleimagemissing' after a basemap switch.
 * Same artwork as the old SVG billboard: 32 px, pointing north.
 */
function rasterizeChevron(name) {
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return null;
  const selected = name === `${CHEVRON_PREFIX}sel`;
  const fill = selected ? '#ffffff' : `#${name.slice(CHEVRON_PREFIX.length)}`;
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return null;
  const size = 32 * CHEVRON_PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.scale(CHEVRON_PIXEL_RATIO, CHEVRON_PIXEL_RATIO);
  g.translate(16, 16);
  const path = new Path2D(CHEVRON_PATH);
  g.fillStyle = fill;
  g.fill(path);
  g.lineJoin = 'round';
  g.lineWidth = selected ? 1.1 : 0.7;
  g.strokeStyle = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
  g.stroke(path);
  const { data } = g.getImageData(0, 0, size, size);
  return { width: size, height: size, data };
}

function ensureChevronImage(map, name) {
  if (!map || !name || map.hasImage?.(name)) return;
  const image = rasterizeChevron(name);
  if (image) map.addImage(name, image, { pixelRatio: CHEVRON_PIXEL_RATIO });
}

const _hookedMaps = new WeakSet();
function hookChevronImages(map) {
  if (!map?.on || _hookedMaps.has(map)) return;
  _hookedMaps.add(map);
  map.on('styleimagemissing', (event) => {
    if (event?.id?.startsWith(CHEVRON_PREFIX)) ensureChevronImage(map, event.id);
  });
}

const CHEVRON_LAYOUT = Object.freeze({
  'icon-image': ['get', 'icon'],
  'icon-size': ['get', 'size'],
  'icon-rotate': ['get', 'rotate'],
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'map',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
});

const CARD_TEXT = ['format',
  ['get', 'label'], { 'text-font': ['literal', TEXT_FONT_BOLD] },
  '\n', {},
  ['get', 'detail'], { 'font-scale': 0.86 },
];

const CARD_PAINT = Object.freeze({
  'text-color': ['get', 'color'],
  'text-halo-color': 'rgba(3,10,14,0.92)',
  'text-halo-width': 1.4,
});

/** Style contract of the layer (kit.js), registered on the shared host at init. */
const vesselLayerDef = defineLayer({
  id: LAYER_ID,
  name: 'Live AIS Vessels',
  category: 'Contexto global',
  icon: '◭',
  source: 'AISStream',
  sources: {
    [SRC_VESSELS]: { type: 'geojson', data: EMPTY_FC },
    [SRC_SELECTED]: { type: 'geojson', data: EMPTY_FC },
    [SRC_CARDS]: { type: 'geojson', data: EMPTY_FC },
    [SRC_SELECTED_CARD]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      id: LAYER_ICON,
      type: 'symbol',
      source: SRC_VESSELS,
      layout: { ...CHEVRON_LAYOUT },
      // Focus de-emphasis writes per-vessel alpha into feature-state.
      paint: { 'icon-opacity': ['coalesce', ['feature-state', 'focus'], 1] },
    },
    {
      id: LAYER_LABEL,
      type: 'symbol',
      source: SRC_CARDS,
      minzoom: Math.max(0, LABEL_FADE_END_ZOOM - 0.5),
      layout: {
        'text-field': CARD_TEXT,
        'text-font': TEXT_FONT,
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 1.3],
        'text-max-width': 30,
        'text-padding': 6,
        'symbol-sort-key': ['-', 0, ['get', 'prio']],
      },
      paint: {
        ...CARD_PAINT,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], LABEL_FADE_END_ZOOM - 0.5, 0, LABEL_FADE_END_ZOOM + 0.8, 1],
      },
    },
    { id: LAYER_SEL_ICON, type: 'symbol', source: SRC_SELECTED, layout: { ...CHEVRON_LAYOUT } },
    {
      id: LAYER_SEL_LABEL,
      type: 'symbol',
      source: SRC_SELECTED_CARD,
      layout: {
        'text-field': CARD_TEXT,
        'text-font': TEXT_FONT,
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 1.4],
        'text-max-width': 40,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { ...CARD_PAINT, 'text-color': '#ffffff' },
    },
  ],
  interactive: [LAYER_SEL_ICON, LAYER_ICON],
  tooltip: (props) => {
    const html = vesselTooltipHtml({
      vesselName: props.name,
      mmsi: props.mmsi || null,
      shipType: props.typeText,
      sog: props.speed === '' || props.speed === undefined ? null : props.speed,
      destination: props.destination,
      observedAt: props.observedAt,
    });
    return html ? `<div class="vt">${html}</div>` : '';
  },
});

const aisLiveVesselsLayer = {
  id: LAYER_ID,
  name: 'Live AIS Vessels',
  icon: '◭',
  source: 'AISStream',
  updateInterval: REFRESH_MS,
  statsRefreshInterval: 1000,

  /** @param {object} engine Map engine (src/maplibre/engine.js). */
  init(engine) {
    state.engine = engine;
    attachMap(engine);
    setVisible(false);
    installInteraction(engine);
  },

  enable(engine) {
    const wasEnabled = state.enabled;
    state.enabled = true;
    if (!wasEnabled) beginAisSession();
    const activeEngine = engine || state.engine;
    if (!state.engine && activeEngine) state.engine = activeEngine;
    attachMap(activeEngine);
    installInteraction(activeEngine);
    setVisible(true);
    // Pick-ownership (H2): sibling layers recognize vessel picks by MMSI.
    registerPickOwner(LAYER_ID, (pickedId) => state.vesselMap.has(pickedId));
    installFocusPass();
    if (state.vesselRecords.length) renderVessels();
    return loadLivePositions(activeEngine);
  },

  disable() {
    state.enabled = false;
    invalidateAisSession();
    removeFocusPass();
    unregisterPickOwner(LAYER_ID);
    clearVesselInspection();
    destroySelectedVesselTrail();
    setVisible(false);
    removeVesselInteraction();
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }
    state.loading = false;
    state.loadingLabel = '';
  },

  update(engine) {
    if (!state.enabled) return Promise.resolve();
    return loadLivePositions(engine || state.engine);
  },

  destroy() {
    invalidateAisSession();
    removeFocusPass();
    if (state.abort) state.abort.abort();
    unregisterPickOwner(LAYER_ID);
    clearVesselInspection();
    destroySelectedVesselTrail();
    for (const id of [SRC_VESSELS, SRC_SELECTED, SRC_CARDS, SRC_SELECTED_CARD]) setSourceData(id, EMPTY_FC);
    setVisible(false);
    removeVesselInteraction();
    resetState();
  },

  /**
   * Find a vessel by exact MMSI or case-insensitive name substring.
   * @param {string|number} query MMSI or partial vessel name.
   * @returns {{ mmsi: string, name: string, position: import('./geoPoint.js').GeoPoint, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
   */
  findByQuery(query) {
    if (query === null || query === undefined) return null;
    const records = state.vesselRecords;
    if (!Array.isArray(records) || !records.length) return null;
    const q = String(query).trim();
    if (!q) return null;

    let record = null;
    if (/^\d+$/.test(q)) {
      record = state.vesselMap.get(q) || null;
    }
    if (!record) {
      const lower = q.toLowerCase();
      record = records.find((r) => String(r.name || '').toLowerCase().includes(lower)) || null;
    }
    if (!record) return null;

    const position = record.position;
    if (!position) return null;
    return {
      mmsi: record.mmsi,
      name: record.name,
      position,
      latitude: record.lat,
      longitude: record.lon,
      speedKt: record.speed,
      course: record.course,
      type: record.type,
    };
  },

  /**
   * Get vessels within a range of a point, sorted nearest-first.
   * @param {object} center Search center: neutral point, {lon, lat} or ECEF {x, y, z}.
   * @param {number} rangeM Max straight-line distance in meters (non-finite = unbounded).
   * @param {number} [maxCount=25] Maximum entries to return.
   * @returns {Array<{ mmsi: string, name: string, position: object, distanceM: number }>}
   */
  getNearby(center, rangeM, maxCount = 25) {
    const records = state.vesselRecords;
    const origin = toGeoPoint(center);
    if (!origin || !Array.isArray(records) || !records.length) return [];
    const range = Number.isFinite(rangeM) && rangeM > 0 ? rangeM : Infinity;
    const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 25;

    const entries = [];
    for (const record of records) {
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) continue;
      const position = record.position;
      if (!position) continue;
      const distanceM = geoDistanceM(origin, position);
      if (!Number.isFinite(distanceM) || distanceM > range) continue;
      entries.push({ mmsi: record.mmsi, name: record.name, position, distanceM });
    }
    entries.sort((a, b) => a.distanceM - b.distanceM);
    return entries.slice(0, cap);
  },

  /**
   * Whether this layer still carries a vessel, in O(1).
   *
   * Mirror of `flights.hasContact`: presence consumers must not infer absence
   * from the capped `getAllPositions` rows. `vesselMap` is MMSI-keyed.
   * A disabled layer keeps its records, so it must decline rather than answer
   * from data the user can no longer see.
   * @param {string} mmsi Vessel identifier.
   * @returns {boolean|null} Presence, or null when the layer is disabled or
   *   holds no data and therefore cannot answer.
   */
  hasContact(mmsi) {
    if (!state.enabled || !state.vesselMap || state.vesselMap.size === 0) return null;
    if (!mmsi) return false;
    return state.vesselMap.has(String(mmsi).trim());
  },

  /**
   * Get positions of all currently loaded vessels.
   * @param {number} [maxCount=800] Maximum entries to return.
   * @returns {Array<{ id: string, label: string, position: object, latitude: number, longitude: number }>}
   */
  getAllPositions(maxCount = 800) {
    const result = [];
    const records = state.vesselRecords;
    if (!Array.isArray(records)) return result;
    const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 800;

    for (const record of records) {
      if (result.length >= cap) break;
      const position = record.position;
      if (!position) continue;
      result.push({
        id: record.mmsi,
        label: record.name || record.mmsi,
        position,
        latitude: record.lat,
        longitude: record.lon,
      });
    }
    return result;
  },

  /**
   * Snapshot the layer's in-memory vessel records as plain JSON-safe
   * objects for the analyst query engine. On-demand only (called at most
   * once per spoken query) — zero per-frame cost, no listeners, no caching.
   * Returns [] while the layer is disabled or empty.
   * @param {number} [maxCount=2000] - Maximum records to return (truncation).
   * @returns {Array<Object>} See mapAnalystRecord for the record shape.
   */
  getAnalystRecords(maxCount = 2000) {
    if (!state.enabled) return [];
    const records = state.vesselRecords;
    if (!Array.isArray(records) || !records.length) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const result = [];
    for (const record of records) {
      if (result.length >= limit) break;
      result.push(mapAnalystRecord(record));
    }
    return result;
  },

  /**
   * Select a vessel by MMSI via the same path as a map click
   * (highlight + HUD update), without moving the camera.
   * @param {string|number} mmsi Vessel MMSI.
   * @returns {boolean} True if a matching vessel was selected.
   */
  selectById(mmsi) {
    if (mmsi === null || mmsi === undefined) return false;
    const target = String(mmsi).trim();
    if (!target) return false;
    const record = state.vesselMap.get(target);
    if (!record) return false;
    selectVessel(record);
    return true;
  },

  /**
   * Clear the current vessel selection and reset the HUD readout.
   * @returns {boolean} Always true.
   */
  clearSelection() {
    clearVesselInspection();
    return true;
  },

  /**
   * Get info about the currently selected vessel.
   * @returns {{ mmsi: string, name: string, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
   */
  getSelectedInfo() {
    const record = state.selectedRecord;
    if (!record) return null;
    return {
      mmsi: record.mmsi,
      name: record.name,
      latitude: record.lat,
      longitude: record.lon,
      speedKt: record.speed,
      course: record.course,
      type: record.type,
    };
  },

  /**
   * Return a subset of vessels for the universal detection overlay.
   * Deterministic stride sampling distributes selections evenly across the
   * current record list while honoring the overlay's per-layer budget.
   * @param {Object} [options={}] - Options from the detection system.
   * @param {number} [options.maxCount] - Maximum objects to return (defaults to all).
   * @param {number} [options.seed] - Seed offset for stride sampling.
   * @returns {Array<{position: object, id: string, type: string, skipLabel: boolean}>}
   */
  getDetectableObjects(options = {}) {
    if (!state.enabled || !state.visible) return [];
    const records = state.vesselRecords;
    if (!Array.isArray(records) || !records.length) return [];

    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : records.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    // Deterministic stride: evenly space selections across the record list
    const stride = Math.max(1, Math.ceil(records.length / maxCount));
    const start = seed % stride;

    const selected = state.selectedRecord;
    const result = [];
    for (let idx = 0; idx < records.length; idx += 1) {
      if (((idx - start) % stride) !== 0) continue;
      const record = records[idx];
      const position = record.position;
      if (!position) continue;
      result.push({
        position,
        sourceId: record.mmsi,
        id: record.name || record.mmsi || 'VESSEL',
        type: 'SEA',
        skipLabel: record === selected,
        klass: record.type ? String(record.type).toUpperCase().slice(0, 14) : undefined,
        metric: formatKnots(record.speed), // record.speed is knots
      });
      if (result.length >= maxCount) break;
    }
    return result;
  },

  ...(FOCUS_EVIDENCE_DEV ? {
    __focusEvidence: Object.freeze({
      setVessels: _setFocusEvidenceVessels,
      snapshot: _focusEvidenceVesselSnapshot,
    }),
  } : {}),

  getStats() {
    const waitingForFirstPosition = state.firstConnectPhase === 'loading';
    return {
      count: state.count,
      lastUpdate: state.lastUpdate,
      loading: state.loading || waitingForFirstPosition,
      loadingLabel: waitingForFirstPosition
        ? AIS_FIRST_CONNECT_LABEL
        : state.loadingLabel,
      error: state.error,
      stale: state.stale,
      status: state.firstConnectPhase === 'unavailable' ? 'unavailable' : undefined,
      transportStatus: state.transportStatus,
      lastMessageAt: state.lastMessageAt,
      rawRowCount: state.rawRowCount,
      acceptedRowCount: state.acceptedRowCount,
      // Same chip affordance the flights layer uses: when the server is
      // backing off, say how long until the next attempt instead of leaving
      // the user to guess whether anything is still happening.
      retryInSec: aisRetryInSec(),
    };
  },
};

const state = {
  /** Map engine (src/maplibre/engine.js) — the old Cesium viewer slot. */
  engine: null,
  /** maplibregl.Map once the layer is attached to the shared host. */
  map: null,
  host: null,
  visible: false,
  enabled: false,
  loading: false,
  loaded: false,
  stale: false,
  error: null,
  loadingLabel: '',
  lastUpdate: null,
  count: 0,
  newestPositionAt: null,
  transportStatus: null,
  /** Server epoch-ms of the next reconnect attempt while the feed is degraded. */
  nextAttemptAt: null,
  lastMessageAt: null,
  rawRowCount: 0,
  acceptedRowCount: 0,
  /** Monotonic enable/reset owner for requests and first-connect timers. */
  sessionId: 0,
  /** @type {'idle'|'loading'|'ready'|'unavailable'} */
  firstConnectPhase: 'idle',
  firstConnectStartedAt: null,
  firstConnectDeadline: null,
  firstConnectTimer: null,
  abort: null,
  /** @type {Array<Object>} Flat render list: keyed records + unkeyed records */
  vesselRecords: [],
  /** @type {Map<string, Object>} MMSI -> vessel record (identity across refreshes) */
  vesselMap: new Map(),
  /** @type {Array<Object>} Records with no MMSI — rebuilt fresh each refresh */
  unkeyedRecords: [],
  /** {destroy()} for the engine click subscription. */
  clickHandler: null,
  /** Exact EventTarget currently holding the Escape listener. */
  keyTarget: null,
  /** Exact callback registered on keyTarget. */
  keydownHandler: null,
  /** engine 'trackedchange' listener disposer. */
  trackedChangeRemover: null,
  /** Test-only key target for enable-time interaction installation. */
  interactionKeyTarget: null,
  activeLabelCount: 0,
  selectedRecord: null,
  /** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Selected-vessel fading trail */
  trail: null,
  /** @type {Array<object>} Chronological trail vertices (neutral points, oldest first) */
  trailPositions: [],
  /** @type {string|null} MMSI that owns the active selected-vessel trail. */
  trailMmsi: null,
  /** @type {number} Monotonic token — invalidates in-flight backfill responses */
  trailBackfillToken: 0,
  /** Tracking target handed to engine.track for the selected vessel. */
  trackTarget: null,
  /** 80 ms focus de-emphasis timer while enabled. */
  focusTimer: null,
  lastFocusUpdate: 0,
  /** Sprites whose animated emphasis remains outside the 1.0 deadband. */
  activeFocusCount: 0,
};

/** Replace live AIS rows through the production reconciliation path (DEV only). */
function _setFocusEvidenceVessels(rows = []) {
  if (!FOCUS_EVIDENCE_DEV || !state.engine) {
    return { ok: false, count: 0 };
  }
  clearVesselInspection();
  reconcileVessels(state.engine, Array.isArray(rows) ? rows : []);
  state.count = state.vesselRecords.length;
  state.loaded = true;
  state.error = null;
  state.stale = false;
  state.lastUpdate = Date.now();
  state.transportStatus = 'synthetic';
  state.lastMessageAt = null;
  state.rawRowCount = Array.isArray(rows) ? rows.length : 0;
  state.acceptedRowCount = state.count;
  settleFirstConnectPhase('ready');
  return { ok: true, count: state.count };
}

/** JSON-safe vessel opacity/position snapshot for the evidence report. */
function _focusEvidenceVesselSnapshot() {
  if (!FOCUS_EVIDENCE_DEV || !state.engine) return [];
  return state.vesselRecords.map((record) => {
    const screen = state.engine.project?.(record.lon, record.lat) || null;
    return {
      id: record.mmsi,
      show: state.visible && screen?.visible !== false,
      alpha: record.billboard?.color?.alpha ?? 1,
      x: screen?.x ?? null,
      y: screen?.y ?? null,
    };
  });
}

export default aisLiveVesselsLayer;

function clearFirstConnectTimer() {
  if (state.firstConnectTimer === null) return;
  _aisRuntime.clearTimeout(state.firstConnectTimer);
  state.firstConnectTimer = null;
}

function invalidateAisSession() {
  clearFirstConnectTimer();
  state.sessionId = ++_aisSessionSequence;
  state.firstConnectPhase = 'idle';
  state.firstConnectStartedAt = null;
  state.firstConnectDeadline = null;
}

function beginAisSession() {
  clearFirstConnectTimer();
  const sessionId = ++_aisSessionSequence;
  const startedAt = _aisRuntime.now();
  state.sessionId = sessionId;
  state.firstConnectPhase = 'loading';
  state.firstConnectStartedAt = startedAt;
  state.firstConnectDeadline = startedAt + AIS_FIRST_CONNECT_GRACE_MS;
  state.error = null;
  state.loadingLabel = AIS_FIRST_CONNECT_LABEL;
  scheduleFirstConnectExpiry(sessionId, AIS_FIRST_CONNECT_GRACE_MS);
}

function scheduleFirstConnectExpiry(sessionId, delayMs) {
  state.firstConnectTimer = _aisRuntime.setTimeout(() => {
    if (
      !state.enabled
      || state.sessionId !== sessionId
      || state.firstConnectPhase !== 'loading'
    ) return;
    const remainingMs = state.firstConnectDeadline - _aisRuntime.now();
    if (remainingMs > 0) {
      scheduleFirstConnectExpiry(sessionId, remainingMs);
      return;
    }
    state.firstConnectTimer = null;
    state.firstConnectPhase = 'unavailable';
    state.loadingLabel = '';
    state.error = state.lastMessageAt
      ? 'awaiting usable AIS positions…'
      : 'awaiting first AIS message…';
    state.stale = state.count > 0;
  }, delayMs);
}

function settleFirstConnectPhase(phase) {
  clearFirstConnectTimer();
  state.firstConnectPhase = phase;
  state.loadingLabel = '';
}

function isGraceEligibleTransport(status) {
  return AIS_HEALTHY_STATUSES.has(status) || status === 'connecting';
}

function isDefinitiveTransportFailure(status) {
  return Boolean(status) && !isGraceEligibleTransport(status);
}

function markAisUnavailable(reason) {
  settleFirstConnectPhase('unavailable');
  state.error = reason || 'AIS live load failed';
  state.stale = state.count > 0;
}

async function loadLivePositions(engine) {
  if (!engine || state.loading) return;
  state.loading = true;
  state.loadingLabel = state.loaded ? 'refreshing...' : 'loading...';
  const requestController = new AbortController();
  const requestSessionId = state.sessionId;
  state.abort = requestController;

  try {
    const url = liveApiUrl();
    // Combine the layer's teardown-abort with a hard timeout so a hung upstream
    // can't wedge the poll indefinitely (parity with the track fetch + flights).
    const signal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([requestController.signal, AbortSignal.timeout(10000)])
      : requestController.signal;
    const response = await fetch(url, {
      signal,
      cache: 'no-store',
    });
    if (!ownsAisRequest(requestController, requestSessionId)) return;
    if (!response.ok) {
      // The 503 key-absent / 502 stream-error bodies still carry {status,error}.
      // Prefer a clean surfaced reason over a cryptic "AIS live HTTP 503".
      let reason = `AIS live HTTP ${response.status}`;
      try {
        const errPayload = await response.json();
        if (!ownsAisRequest(requestController, requestSessionId)) return;
        reason = deriveAisFeedError(errPayload, 0)
          || (typeof errPayload?.error === 'string' && errPayload.error.trim()) || reason;
      } catch { /* non-JSON body — keep the HTTP status reason */ }
      throw new Error(reason);
    }

    const payload = await response.json();
    if (!ownsAisRequest(requestController, requestSessionId)) return;
    applyAisFeedSnapshot(engine, payload);
  } catch (error) {
    if (ownsAisRequest(requestController, requestSessionId) && error?.name !== 'AbortError') {
      markAisUnavailable(error?.message || 'AIS live load failed');
      console.warn('[Data:ais-live-vessels]', state.error, error);
    }
  } finally {
    if (state.abort === requestController && state.sessionId === requestSessionId) {
      state.loading = false;
      state.loadingLabel = state.firstConnectPhase === 'loading'
        ? AIS_FIRST_CONNECT_LABEL
        : '';
      state.abort = null;
    }
  }
}

/** True while a request still owns this enabled layer lifecycle. */
function ownsAisRequest(controller, sessionId) {
  return state.enabled
    && state.sessionId === sessionId
    && state.abort === controller
    && !controller.signal.aborted;
}

/** Apply a classified snapshot while preserving warm state on zero accepted rows. */
function applyAisFeedSnapshot(engine, payload) {
  const snapshot = classifyAisFeedSnapshot(payload);
  state.loaded = true;
  state.loadingLabel = '';
  state.transportStatus = snapshot.transportStatus;
  state.nextAttemptAt = Number(payload?.nextAttemptAt) || null;
  state.lastMessageAt = snapshot.lastMessageAt;
  state.rawRowCount = snapshot.rawRowCount;
  state.acceptedRowCount = snapshot.acceptedRowCount;

  if (snapshot.acceptedRowCount === 0) {
    state.count = state.vesselRecords.length;
    state.stale = state.count > 0 || Boolean(payload?.refreshing);
    if (isDefinitiveTransportFailure(snapshot.transportStatus)) {
      markAisUnavailable(snapshot.error);
      return { reconciled: false, ...snapshot };
    }
    if (
      state.firstConnectPhase === 'loading'
      && isGraceEligibleTransport(snapshot.transportStatus)
    ) {
      state.error = null;
      state.loadingLabel = AIS_FIRST_CONNECT_LABEL;
      return { reconciled: false, ...snapshot };
    }
    if (state.firstConnectPhase === 'loading') {
      markAisUnavailable(snapshot.error);
      return { reconciled: false, ...snapshot };
    }
    state.error = snapshot.error;
    return { reconciled: false, ...snapshot };
  }

  settleFirstConnectPhase('ready');
  reconcileVessels(engine, snapshot.acceptedRows);
  state.count = state.vesselRecords.length;
  state.stale = Boolean(payload?.refreshing);
  state.newestPositionAt = payload?.newestPositionAt || null;
  // Not unconditionally null: a degraded feed keeps its reason even though the
  // cached vessels are still drawable, so the chip cannot go quiet on an
  // outage the user is still looking at.
  state.error = snapshot.error;
  state.lastUpdate = _aisRuntime.now();
  return { reconciled: true, ...snapshot };
}

function liveApiUrl() {
  const base = import.meta.env?.VITE_AIS_LIVE_API_URL || DEFAULT_API_URL;
  const url = new URL(base, window.location.origin);
  url.searchParams.set('maxRows', String(renderRowLimit()));
  return url.toString();
}

function renderRowLimit() {
  const configured = Number(import.meta.env?.VITE_AIS_LIVE_MAX_ROWS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(500, Math.min(50000, Math.round(configured)));
  }
  return DEFAULT_RENDER_ROWS;
}

function labelRowLimit() {
  const configured = Number(import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.max(0, Math.min(renderRowLimit(), Math.round(configured)));
  }
  return Math.min(DEFAULT_ACTIVE_LABELS, renderRowLimit());
}

/**
 * Attach the style contract to the shared layer host (created at boot by
 * main.js / the dev harness). Without a host or a real map (unit tests,
 * fakes) the layer keeps its full data/selection lifecycle and draws nothing.
 * @param {object} engine
 */
function attachMap(engine) {
  if (state.map || !engine?.map) return;
  const host = getActiveLayerHost();
  if (!host) return;
  host.register(vesselLayerDef);
  hookChevronImages(engine.map);
  try {
    host.ensureAdded(vesselLayerDef);
  } catch (error) {
    console.warn('[Data:ais-live-vessels] style not ready', error);
    return;
  }
  state.map = engine.map;
  state.host = host;
}

function setSourceData(sourceId, data) {
  try {
    state.map?.getSource?.(sourceId)?.setData(data);
  } catch (error) {
    console.warn('[Data:ais-live-vessels] setData', sourceId, error);
  }
}

function setVisible(show) {
  state.visible = Boolean(show);
  if (state.host) state.host.setVisible(LAYER_ID, state.visible);
}

function shipScale(record) {
  const speed = Number(record.speed || 0);
  if (speed >= 18) return 0.78;
  if (speed >= 8) return 0.68;
  return 0.6;
}

/**
 * Best available real-world direction of travel for a vessel, degrees
 * clockwise from north (true heading preferred, course-over-ground fallback).
 * With `icon-rotation-alignment: map` this IS the icon rotation.
 * @param {Object} record - Vessel record.
 * @returns {number} Course in degrees (0 when unknown).
 */
function vesselCourseDeg(record) {
  const direction = record.heading ?? record.course;
  return Number.isFinite(direction) ? direction : 0;
}

/** GeoJSON feature for one vessel; `card` supplies the label text (or none). */
function vesselFeature(record, { selected = false, card = null, id } = {}) {
  const icon = chevronImageName(record, selected);
  ensureChevronImage(state.map, icon);
  return {
    type: 'Feature',
    ...(id !== undefined ? { id } : {}),
    geometry: { type: 'Point', coordinates: [record.lon, record.lat] },
    properties: {
      mmsi: record.mmsi || '',
      pickId: record.mmsi || '',
      name: displayVesselName(record),
      typeText: normalizeVesselType(record.type) || '',
      speed: record.speed ?? '',
      destination: record.destination || '',
      observedAt: record.lastPositionUtc || '',
      icon,
      size: shipScale(record) * (selected ? 1.2 : 1),
      rotate: vesselCourseDeg(record),
      label: card?.title || '',
      detail: card ? card.details.join('\n') : '',
      color: card ? `rgb(${card.accent})` : '#ffffff',
      prio: card?.priority ?? 0,
    },
  };
}

/**
 * GeoJSON for the two vessel sources: every record gets a chevron; the best
 * `maxLabels` records by labelPriority get an ambient card (MapLibre collision
 * then declutters them on screen, highest `prio` first); the selected vessel
 * leaves the ambient source and is drawn on top with its full-detail card.
 * Exported for tests (no map needed).
 * @param {Array<Object>} records
 * @param {Object|null} selected
 * @param {number} maxLabels
 * @returns {{vessels: object, selected: object, labelCount: number}}
 */
export function buildVesselSourceData(records, selected, maxLabels) {
  const labeled = new Set();
  if (maxLabels > 0) {
    const ranked = (records || [])
      .filter((record) => record !== selected)
      .map((record) => ({ record, score: labelPriority(record, selected) }))
      .sort((a, b) => b.score - a.score);
    for (let i = 0; i < ranked.length && i < maxLabels; i += 1) labeled.add(ranked[i].record);
  }
  const features = [];
  for (const record of records || []) {
    if (record === selected) continue;
    // Numeric feature id = feature-state handle for the focus alpha.
    const id = features.length;
    record.featureId = id;
    features.push(vesselFeature(record, { id, card: labeled.has(record) ? buildVesselCard(record) : null }));
  }
  return {
    vessels: { type: 'FeatureCollection', features },
    selected: selected
      ? { type: 'FeatureCollection', features: [vesselFeature(selected, { selected: true, card: buildSelectedVesselCard(selected) })] }
      : EMPTY_FC,
    labelCount: labeled.size + (selected ? 1 : 0),
  };
}

/** Push the current records/selection into the map sources. */
function renderVessels() {
  if (!state.map) {
    state.activeLabelCount = state.selectedRecord ? 1 : 0;
    return;
  }
  const data = buildVesselSourceData(state.vesselRecords, state.selectedRecord, labelRowLimit());
  setSourceData(SRC_VESSELS, data.vessels);
  // Feature ids were reassigned: re-apply the current focus alpha.
  for (const record of state.vesselRecords) {
    const alpha = record.billboard?.color?.alpha;
    if (record.featureId != null && Number.isFinite(alpha) && alpha < 1) {
      try {
        state.map.setFeatureState({ source: SRC_VESSELS, id: record.featureId }, { focus: alpha });
      } catch { /* style swapping */ }
    }
  }
  setSourceData(SRC_SELECTED, data.selected);
  setSourceData(SRC_CARDS, {
    type: 'FeatureCollection',
    features: data.vessels.features.filter((f) => f.properties.label !== ''),
  });
  setSourceData(SRC_SELECTED_CARD, data.selected);
  state.activeLabelCount = data.labelCount;
}

// ------------------------------------------------------- focus de-emphasis

/** Minimal billboard-shaped sprite: focusDeemphasis keys its state on it. */
function alphaColor(alpha) {
  return { alpha, withAlpha: (next) => alphaColor(next) };
}

function vesselSprite(record) {
  return {
    position: record.position,
    show: true,
    width: CHEVRON_PX,
    height: CHEVRON_PX,
    scale: shipScale(record),
    color: alphaColor(1),
  };
}

function installFocusPass() {
  if (state.focusTimer) return;
  state.focusTimer = setInterval(() => runFocusPass(), FOCUS_UPDATE_MS);
}

function removeFocusPass() {
  if (state.focusTimer) clearInterval(state.focusTimer);
  state.focusTimer = null;
}

/** Camera position for focus distances ({lon, lat, alt} from the engine). */
function cameraGeo(engine) {
  const view = engine?.getCameraView?.();
  if (!view) return null;
  const alt = Number.isFinite(view.alt) && view.alt > 0
    ? view.alt
    : (Number.isFinite(view.zoom) ? 1.0e8 / 2 ** view.zoom : Number.NaN);
  return geoPoint(view.lon, view.lat, alt);
}

/** One 80 ms focus pass; alpha writes land in feature-state. */
function runFocusPass() {
  if (!state.enabled || !state.engine) return;
  const target = getFocusTarget();
  if (!focusPassIsNeeded(target, state.activeFocusCount)) {
    state.activeFocusCount = 0;
    return;
  }
  const nowMs = focusNowMs(performance.now());
  state.lastFocusUpdate = nowMs;
  const engine = state.engine;
  const camera = cameraGeo(engine);
  const result = applyVesselFocusDeemphasis({
    records: state.vesselRecords.filter((record) => record !== state.selectedRecord),
    target,
    previousActiveCount: state.activeFocusCount,
    nowMs,
    screenPositionFor: (position) => {
      const p = engine.project?.(position.lon, position.lat);
      return p?.visible ? { x: p.x, y: p.y } : null;
    },
    cameraDistanceFor: (position) => (camera ? geoDistanceM(camera, position) : Number.NaN),
    onWrite: (record, alpha) => {
      if (record.featureId == null || !state.map) return;
      try {
        state.map.setFeatureState({ source: SRC_VESSELS, id: record.featureId }, { focus: alpha });
      } catch { /* style swapping */ }
    },
  });
  state.activeFocusCount = result.activeCount;
}

/**
 * Apply focus alpha to vessel sprites. Kept as a production wire seam so the
 * animation/deadband contract can be tested without a map. On MapLibre the
 * write also goes to `onWrite(record, alpha)` (feature-state `focus`).
 * @param {object} input
 * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
 */
export function applyVesselFocusDeemphasis({
  records,
  target,
  previousActiveCount = 0,
  nowMs,
  screenPositionFor,
  cameraDistanceFor,
  params,
  onWrite,
}) {
  if (!focusPassIsNeeded(target, previousActiveCount)) {
    return { writes: 0, transitioning: false, activeCount: 0, ran: false };
  }
  let writes = 0;
  let transitioning = false;
  let activeCount = 0;
  for (const record of records || []) {
    const bb = record?.billboard;
    const position = bb?.position || record?.position;
    if (!bb || !position) continue;
    const focus = advanceSpriteFocus(bb, {
      // Hidden/far-side sprites still finish any pending release so the active
      // count remains truthful and they cannot reappear with stale dim alpha.
      screenPosition: bb.show === false ? null : screenPositionFor(position),
      cameraDistance: cameraDistanceFor(position),
      nowMs,
      target,
      params,
      // Vessel artwork is 32 px before the chevron scale. Including the
      // ambient chevron's own rendered extent prevents edge-overlap misses.
      spriteHalfWidthPx: (bb.width || CHEVRON_PX) * (bb.scale || 1) * 0.5,
      spriteHalfHeightPx: (bb.height || CHEVRON_PX) * (bb.scale || 1) * 0.5,
    });
    transitioning ||= focus.transitioning;
    if (focus.active) activeCount += 1;
    if (focusAlphaNeedsWrite(bb.color?.alpha, focus.factor, params)) {
      // Narrow always-visible amendment: the chevron remains present at the
      // non-zero floor while it competes with the tracked target, keeping the
      // sprite's existing base color.
      const baseColor = bb.color || alphaColor(1);
      bb.color = baseColor.withAlpha(focus.factor);
      onWrite?.(record, focus.factor);
      writes += 1;
    }
  }
  return { writes, transitioning, activeCount, ran: true };
}

/**
 * Reconcile the incoming AIS rows against the MMSI-keyed record map.
 * Existing records are updated in place (position/heading/label) so identity
 * and selection survive refreshes; new vessels are added; vanished vessels are
 * removed — except the selected vessel, which is pinned for up to
 * SELECTED_PIN_REFRESHES consecutive misses with a stale HUD readout.
 * Rows without an MMSI are rendered unkeyed and rebuilt fresh each refresh.
 * @param {object} engine - Map engine (unused beyond attachment).
 * @param {Array<Object>} rows - Raw AIS rows from the live API.
 */
function reconcileVessels(engine, rows) {
  attachMap(engine || state.engine);

  // Unkeyed (no-MMSI) records cannot be diffed — drop and rebuild them.
  state.unkeyedRecords = [];

  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const next = normalizeVessel(rows[index]);
    if (!next) continue;

    if (!next.mmsi) {
      next.billboard = vesselSprite(next);
      state.unkeyedRecords.push(next);
      continue;
    }
    if (seen.has(next.mmsi)) continue; // defensive: dedupe payload rows
    seen.add(next.mmsi);

    const existing = state.vesselMap.get(next.mmsi);
    if (existing) {
      updateRecordInPlace(existing, next);
    } else {
      next.billboard = vesselSprite(next);
      state.vesselMap.set(next.mmsi, next);
    }
  }

  // Remove vanished vessels, pinning the selected one for a few refreshes.
  for (const [mmsi, record] of state.vesselMap) {
    if (seen.has(mmsi)) continue;
    if (record === state.selectedRecord) {
      record.missedRefreshes = (record.missedRefreshes || 0) + 1;
      if (record.missedRefreshes <= SELECTED_PIN_REFRESHES) {
        updateSelectedVesselHud(record); // re-render with STALE marker
        continue;
      }
      // Aged out of the feed after exhausting its pin — not a deselect.
      clearVesselInspection({ evicted: true });
    }
    if (record.billboard) forgetSpriteFocus(record.billboard);
    state.vesselMap.delete(mmsi);
    // Defensive lifecycle closure: a trail may outlive selection state during
    // asynchronous handoff/refresh ordering, but never its owning record.
    if (state.trailMmsi === mmsi) clearSelectedVesselTrail();
  }

  state.vesselRecords = [...state.vesselMap.values(), ...state.unkeyedRecords];
  renderVessels();
}

/**
 * Update an existing record from a freshly normalized row, preserving object
 * identity so selection and the MMSI pick key stay valid.
 * @param {Object} record - Existing vessel record in state.vesselMap.
 * @param {Object} next - Freshly normalized record for the same MMSI.
 */
function updateRecordInPlace(record, next) {
  const selected = record === state.selectedRecord;
  record.lat = next.lat;
  record.lon = next.lon;
  record.name = next.name;
  record.imo = next.imo;
  record.type = next.type;
  record.destination = next.destination;
  record.speed = next.speed;
  record.course = next.course;
  record.heading = next.heading;
  record.lastPositionUtc = next.lastPositionUtc;
  record.lastPositionEpoch = next.lastPositionEpoch;
  record.position = next.position;
  record.missedRefreshes = 0;
  if (record.billboard) {
    record.billboard.position = record.position;
    record.billboard.scale = shipScale(record);
  }

  if (record.mmsi === state.trailMmsi) {
    appendSelectedVesselTrailFix(record);
  }
  if (selected) {
    updateSelectedVesselHud(record);
    registerSelectedContext(record);
  }
}

function normalizeVessel(row) {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    name: String(row.name || row.input_name || row.mmsi || row.input_identifier || 'VESSEL'),
    mmsi: String(row.mmsi || row.input_identifier || '').trim(),
    imo: String(row.imo || ''),
    type: String(row.type_specific || row.type || ''),
    destination: String(row.destination || ''),
    speed: finiteNumber(row.speed),
    course: finiteNumber(row.course),
    heading: finiteNumber(row.heading),
    lastPositionUtc: String(row.last_position_UTC || ''),
    lastPositionEpoch: finiteNumber(row.last_position_epoch),
    // Neutral point (degrees + ECEF). A small lift above the sea surface keeps
    // the old contract (never below the visible surface) for height readers.
    position: geoPoint(lon, lat, VESSEL_LIFT_M),
    missedRefreshes: 0,
    /** Focus-state sprite (alpha); see vesselSprite. */
    billboard: null,
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function labelPriority(record, selected) {
  if (record === selected) return 100000;
  let score = 0;
  if (hasUsefulName(record)) score += 1000;
  if (record.speed !== null) score += Math.min(400, Math.max(0, record.speed) * 20);
  if (record.heading !== null || record.course !== null) score += 80;
  if (record.type) score += 40;
  return score;
}

function hasUsefulName(record) {
  const text = String(record.name || '').trim();
  return Boolean(text && text !== 'VESSEL' && !/^MMSI\s*\d+$/i.test(text) && text !== record.mmsi);
}

// ------------------------------------------------------------- interaction

function installInteraction(engine) {
  if (state.clickHandler || !engine?.on) return;
  const keyTarget = state.interactionKeyTarget
    || (typeof document !== 'undefined' ? document : null);
  bindVesselInteraction(engine, keyTarget);
}

/** Canonical pick ids a rendered MapLibre feature may carry. */
function featurePickIds(feature) {
  const props = feature?.properties || {};
  return [props.pickId, props.id, feature?.id]
    .map((id) => resolvePickId({ id }))
    .filter(Boolean);
}

function bindVesselInteraction(engine, keyTarget) {
  const removeClick = engine.on('click', (click) => handleVesselClick(engine, click));
  state.clickHandler = { destroy: () => removeClick?.() };
  if (keyTarget?.addEventListener) {
    state.keyTarget = keyTarget;
    state.keydownHandler = onVesselKeyDown;
    keyTarget.addEventListener('keydown', state.keydownHandler);
  }
  // Vessels only track their own selected record, so any other tracked
  // target belongs to another layer and takes interaction ownership.
  state.trackedChangeRemover = engine.on('trackedchange', (target) => {
    if (target && target.layerId !== LAYER_ID && state.selectedRecord) clearVesselInspection();
  }) || null;
}

function handleVesselClick(engine, click) {
  if (!state.enabled) return;
  const x = Number(click?.x);
  const y = Number(click?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const hits = engine.pick?.(x, y, { layers: VESSEL_PICK_LAYERS, radius: VESSEL_PICK_RADIUS_PX }) || [];
  const hit = hits.find((feature) => feature?.properties && 'mmsi' in feature.properties)
    || nearestVesselFeatureOnScreen(engine, x, y);
  const pickedMmsi = hit ? String(hit.properties.mmsi || '').trim() : null;
  const record = pickedMmsi ? state.vesselMap.get(pickedMmsi) || null : null;

  // An own-layer feature without a live map key (unkeyed row or a vessel
  // evicted since the last paint) is a strict no-op (FB-1 residual).
  if (hit && !record) return;
  // The selected vessel's trail hugs its contact: clicking it is a no-op.
  const trailLayer = state.trail?.id;
  if (!record && trailLayer
    && (engine.pick?.(x, y, { layers: [trailLayer], radius: TRAIL_PICK_RADIUS_PX }) || []).length) return;

  if (record) {
    // A valid chevron or card click always transfers the camera exactly once,
    // including a second click on the already-selected vessel.
    selectAndFocusVessel(record);
    return;
  }

  // A sibling layer already owns this click. Preserve the current vessel
  // selection and do not compete with its camera command.
  const others = engine.pick?.(x, y, { radius: TRAIL_PICK_RADIUS_PX }) || [];
  for (const feature of others) {
    if (OWN_LAYERS.has(feature?.layer?.id) || feature?.layer?.id === trailLayer) continue;
    if (featurePickIds(feature).some((id) => isOwnedByOtherLayer(LAYER_ID, id))) return;
  }

  const transition = reduceVesselSelection({
    selectedMmsi: state.selectedRecord?.mmsi,
    pickedMmsi: null,
    gesture: 'click',
  });
  if (transition.action === 'deselect') clearVesselInspection();
}

/**
 * Screen-space fallback for chevrons the rendered-feature query misses (the
 * MapLibre globe query is unreliable away from the view center): the nearest
 * record within the pick radius, shaped like a picked feature.
 */
function nearestVesselFeatureOnScreen(engine, x, y) {
  if (typeof engine?.project !== 'function') return null;
  const limit = VESSEL_PICK_RADIUS_PX + 6;
  let best = null;
  let bestDistance = limit * limit;
  const consider = (record) => {
    const p = engine.project(record.lon, record.lat);
    if (!p?.visible) return;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bestDistance) {
      bestDistance = d;
      best = record;
    }
  };
  if (state.selectedRecord) consider(state.selectedRecord);
  if (!best) for (const record of state.vesselRecords) consider(record);
  return best ? { layer: { id: LAYER_ICON }, properties: { mmsi: best.mmsi || '' } } : null;
}

/** Target handed to engine.track while the selected vessel is followed. */
function vesselTrackTarget(record) {
  const mmsi = record.mmsi;
  return {
    kind: 'vessel',
    layerId: LAYER_ID,
    id: mmsi,
    label: displayVesselName(record),
    getPosition: () => {
      const live = state.vesselMap.get(mmsi);
      return live ? { lon: live.lon, lat: live.lat, alt: 0 } : null;
    },
  };
}

function releaseVesselTracking() {
  const engine = state.engine;
  const tracked = engine?.trackedTarget;
  if (tracked && tracked === state.trackTarget) engine.track?.(null);
  state.trackTarget = null;
}

/**
 * Select one live vessel, request one UI-owned camera transfer
 * (requestWorldFocus -> ui.js -> flyToWorldTarget) and follow it with
 * engine.track (the follow waits for the flight: engine.track only recenters
 * while the camera is not moving).
 */
function selectAndFocusVessel(record) {
  if (!record?.mmsi) return false;
  const transition = reduceVesselSelection({
    selectedMmsi: state.selectedRecord?.mmsi,
    pickedMmsi: record.mmsi,
    gesture: 'click',
  });
  if (transition.action === 'select') selectVessel(record);
  requestWorldFocus({
    kind: 'vessel',
    id: record.mmsi,
    label: record.name || record.mmsi,
    position: record.position,
  });
  trackSelectedVessel(record);
  return true;
}

function trackSelectedVessel(record) {
  const engine = state.engine;
  if (!engine?.track || state.selectedRecord !== record) return;
  if (state.trackTarget && engine.trackedTarget === state.trackTarget) return;
  state.trackTarget = vesselTrackTarget(record);
  engine.track(state.trackTarget);
}

function removeVesselInteraction() {
  if (state.clickHandler) {
    state.clickHandler.destroy();
    state.clickHandler = null;
  }
  if (state.keyTarget && state.keydownHandler) {
    state.keyTarget.removeEventListener('keydown', state.keydownHandler);
  }
  state.keyTarget = null;
  state.keydownHandler = null;
  if (state.trackedChangeRemover) {
    state.trackedChangeRemover();
    state.trackedChangeRemover = null;
  }
}

function onVesselKeyDown(event) {
  if (!state.enabled || event.key !== 'Escape') return;
  const transition = reduceVesselSelection({
    selectedMmsi: state.selectedRecord?.mmsi,
    gesture: 'escape',
  });
  if (transition.action === 'deselect') {
    clearVesselInspection();
  }
}

function selectVessel(record) {
  if (!record?.mmsi) return;
  const reuseTrail = state.trailMmsi === record.mmsi;
  clearSelection({ preserveTrail: reuseTrail });
  state.selectedRecord = record;
  record.missedRefreshes = 0;
  // Rebuild the sources immediately so the full-detail card appears on the click.
  renderVessels();
  updateSelectedVesselHud(record);
  if (registerSelectedContext(record)) {
    selectEntityContext(record);
  }
  // Track-history trail (PRD F3/F4): seed with the current position + async
  // backfill from the server-side per-MMSI ring buffer.
  if (reuseTrail) {
    appendSelectedVesselTrailFix(record);
  } else {
    startSelectedVesselTrail(record);
  }
}

// ------------------------------------------------------------------- trail

/**
 * Trail vertex for a vessel record — a neutral point TRAIL_HEIGHT_M above the
 * sea surface (the old z-fighting lift; ignored by the 2D line).
 * @param {Object} record - Vessel record with lat/lon.
 * @returns {object|null} Neutral point, or null without a fix.
 */
function vesselTrailPosition(record) {
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon)) return null;
  return geoPoint(record.lon, record.lat, TRAIL_HEIGHT_M);
}

/**
 * Start (or restart) the selected vessel's trail: seed with the current
 * position, render, then fire-and-forget the server ring-buffer backfill.
 * @param {Object} record - Freshly selected vessel record.
 */
function startSelectedVesselTrail(record) {
  state.trailBackfillToken += 1;
  state.trailMmsi = record.mmsi;
  state.trailPositions = [];
  const current = vesselTrailPosition(record);
  if (current) state.trailPositions.push(current);
  if (!state.trail && state.map) state.trail = createTrail(state.engine, { color: TRAIL_COLOR, width: 2.5 });
  if (state.trail) state.trail.setPositions(state.trailPositions);
  backfillVesselTrail(record.mmsi, state.trailBackfillToken);
}

/**
 * Fire-and-forget backfill from the server-side per-MMSI ring buffer
 * (PRD F3 — "recent path" since server boot, not voyage history). Older
 * samples are spliced AHEAD of the live accumulation, capped at
 * TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/malformed)
 * silently keeps the live-only trail.
 * @param {string} mmsi - MMSI of the selected vessel.
 * @param {number} token - Backfill token captured at request time.
 * @returns {Promise<void>}
 */
async function backfillVesselTrail(mmsi, token) {
  let samples = null;
  try {
    const response = await fetch('/api/ais-live/track?mmsi=' + encodeURIComponent(mmsi), {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const payload = await response.json();
    samples = Array.isArray(payload?.samples) ? payload.samples : null;
  } catch {
    return; // silent — keep the live-accumulated trail
  }
  if (!samples || token !== state.trailBackfillToken) return;
  if (state.trailMmsi !== mmsi) return;

  const older = [];
  for (const sample of samples) {
    const point = geoPoint(sample?.lon, sample?.lat, TRAIL_HEIGHT_M);
    if (point) older.push(point);
  }
  if (!older.length) return;

  state.trailPositions = older.concat(state.trailPositions);
  if (state.trailPositions.length > TRAIL_MAX_POINTS) {
    state.trailPositions = state.trailPositions.slice(state.trailPositions.length - TRAIL_MAX_POINTS);
  }
  if (state.trail) state.trail.setPositions(state.trailPositions);
}

/**
 * Append the selected vessel's refreshed position to its trail when it has
 * moved more than TRAIL_MIN_MOVE_M from the last trail vertex.
 * @param {Object} record - Selected vessel record after an in-place update.
 */
function appendSelectedVesselTrailFix(record) {
  if (!state.trail) return;
  const next = vesselTrailPosition(record);
  if (!next) return;
  const last = state.trailPositions[state.trailPositions.length - 1];
  if (last && geoDistanceM(last, next) <= TRAIL_MIN_MOVE_M) return;
  state.trailPositions.push(next);
  if (state.trailPositions.length > TRAIL_MAX_POINTS) state.trailPositions.shift();
  state.trail.setPositions(state.trailPositions);
}

/**
 * Clear the rendered trail and accumulation; invalidate pending backfills.
 */
function clearSelectedVesselTrail() {
  state.trailBackfillToken += 1;
  state.trailMmsi = null;
  state.trailPositions = [];
  if (state.trail) state.trail.clear();
}

/**
 * Destroy the trail entirely (layer disable/teardown).
 */
function destroySelectedVesselTrail() {
  clearSelectedVesselTrail();
  if (state.trail) {
    state.trail.destroy();
    state.trail = null;
  }
}

/**
 * Register (or refresh) the selected vessel in the shared context store so
 * the realtime/voice layer can describe what the user has selected.
 * @param {Object} record - Selected vessel record.
 * @returns {Object|null} The context record, or null if registration failed.
 */
function registerSelectedContext(record) {
  if (!record?.mmsi) return null;
  try {
    return registerEntityContext(record, {
      id: `ais-${record.mmsi}`,
      layerId: 'ais-live-vessels',
      layerName: 'Live AIS Vessels',
      source: 'AISStream',
      label: displayVesselName(record),
      latitude: record.lat,
      longitude: record.lon,
      properties: {
        mmsi: record.mmsi,
        type: record.type,
        speedKt: record.speed,
        course: record.course,
        destination: record.destination,
      },
    });
  } catch (error) {
    console.warn('[Data:ais-live-vessels] context register failed', error);
    return null;
  }
}

function clearSelection({ preserveTrail = false, evicted = false } = {}) {
  const record = state.selectedRecord;
  state.selectedRecord = null;
  // The camera follow belongs to the selection: releasing the vessel releases
  // engine.track (never a camera move — the view stays where it is).
  releaseVesselTracking();
  // Drop the full-detail card right away (no-op when the layer is disabled —
  // disable() clears the sources itself).
  if (record && state.enabled) renderVessels();
  if (!preserveTrail) clearSelectedVesselTrail();
  try {
    clearSelectedEntityContextForLayer('ais-live-vessels', { evicted });
  } catch (error) {
    console.warn('[Data:ais-live-vessels] context clear failed', error);
  }
}

/**
 * @param {object} [options] Clear origin.
 * @param {boolean} [options.evicted=false] The vessel aged out of the feed
 *   rather than being deselected.
 */
function clearVesselInspection({ evicted = false } = {}) {
  clearSelection({ evicted });
  resetSelectedVesselHud();
}

function updateSelectedVesselHud(record) {
  const el = document.getElementById('hud-ais-vessel');
  if (!el) return;

  // Pinned vessels missing from recent refreshes get a stale marker
  const stale = (record.missedRefreshes || 0) > 0;
  el.classList.add('active');
  el.textContent = [
    `AIS: ${trimHudValue(record.name, 32)}`,
    `${trimHudValue(record.type || 'VESSEL', 24)}  SPD: ${formatSpeed(record.speed)}  HDG: ${formatHeading(record.heading ?? record.course)}`,
    `MMSI: ${record.mmsi || '--'}  ${formatPositionTime(record)}${stale ? '  · STALE' : ''}`,
  ].join('\n');
}

function resetSelectedVesselHud() {
  const el = document.getElementById('hud-ais-vessel');
  if (!el) return;
  el.classList.remove('active');
  el.textContent = 'AIS: --';
}

function trimHudValue(value, maxLength) {
  const text = String(value || '--').trim() || '--';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

/**
 * Card model for an ambient (decluttered-in) vessel — name title plus one
 * compact type/speed/heading detail line, anchored at the record's current
 * rendered position (height-datum caveat: no datum work here). Pure —
 * exported for unit tests.
 * @param {Object} record - Vessel record.
 * @returns {Object} vesselLabels entry.
 */
export function buildVesselCard(record) {
  const parts = [];
  const type = vesselTypeShort(record);
  if (type) parts.push(type);
  if (record.speed !== null && record.speed !== undefined) parts.push(formatSpeed(record.speed));
  const direction = record.heading ?? record.course;
  if (Number.isFinite(direction)) parts.push(`${Math.round(direction)}°`);
  return {
    id: vesselOverlayEntryId(record),
    actionable: Boolean(record?.mmsi),
    position: record.position,
    gapPx: 10,
    accent: accentForVesselType(record.type),
    title: trimHudValue(displayVesselName(record), 26),
    details: parts.length ? [parts.join(' · ')] : [],
    selected: false,
    priority: labelPriority(record, null),
  };
}

/**
 * Card model for the click-selected vessel — the full-detail card, drawn last
 * (on top) and never distance-faded by the overlay. Pinned-but-vanished
 * vessels carry a STALE marker (mirrors the HUD readout). Pure — exported
 * for unit tests.
 * @param {Object} record - Selected vessel record.
 * @returns {Object} vesselLabels entry.
 */
export function buildSelectedVesselCard(record) {
  const direction = record.heading ?? record.course;
  const details = [[
    vesselTypeShort(record) || 'VESSEL',
    formatSpeed(record.speed),
    Number.isFinite(direction) ? `${Math.round(direction)}°` : '--°',
  ].join(' · ')];
  const destination = String(record.destination || '').trim();
  if (destination) details.push(`→ ${trimHudValue(destination, 24)}`);
  const stale = (record.missedRefreshes || 0) > 0;
  details.push(`MMSI ${record.mmsi || '--'} · ${formatPositionTime(record)}${stale ? ' · STALE' : ''}`);
  return {
    id: vesselOverlayEntryId(record),
    actionable: Boolean(record?.mmsi),
    position: record.position,
    gapPx: 12,
    accent: accentForVesselType(record.type),
    title: trimHudValue(displayVesselName(record), 32),
    details,
    selected: true,
    priority: 100000,
  };
}

/** Stable overlay identity for MMSI-keyed and source-retained unkeyed rows. */
function vesselOverlayEntryId(record) {
  const mmsi = String(record?.mmsi || '').trim();
  if (mmsi) return `vessel:${mmsi}`;
  const name = String(record?.name || 'VESSEL').trim() || 'VESSEL';
  const lat = Number.isFinite(record?.lat) ? record.lat.toFixed(5) : 'x';
  const lon = Number.isFinite(record?.lon) ? record.lon.toFixed(5) : 'x';
  return `vessel:unkeyed:${name}:${lat}:${lon}`;
}

/** Uppercased, card-width-bounded AIS type (empty string when unknown). */
function vesselTypeShort(record) {
  return normalizeVesselType(record.type).toUpperCase().slice(0, 14);
}

/**
 * True when `screen` is at least `minSepPx` away from every accepted screen
 * position (greedy card-declutter accept test, mirroring the FIRMS pass).
 * Exported for unit tests.
 * @param {Array<{x: number, y: number}>} accepted - Accepted card positions.
 * @param {{x: number, y: number}} screen - Candidate window coordinates.
 * @param {number} minSepPx - Minimum separation in pixels.
 * @returns {boolean}
 */
export function cardScreenSeparated(accepted, screen, minSepPx) {
  const minSq = minSepPx * minSepPx;
  for (let i = 0; i < accepted.length; i += 1) {
    const dx = screen.x - accepted[i].x;
    const dy = screen.y - accepted[i].y;
    if (dx * dx + dy * dy < minSq) return false;
  }
  return true;
}

function displayVesselName(record) {
  const name = String(record.name || '').trim();
  if (name && name !== 'VESSEL' && name !== record.mmsi) return name;
  return record.mmsi ? `MMSI ${record.mmsi}` : 'VESSEL';
}

function formatSpeed(speed) {
  return speed === null ? '--KT' : `${speed.toFixed(1)}KT`;
}

function formatHeading(heading) {
  return Number.isFinite(heading) ? `${Math.round(heading)}DEG` : '--DEG';
}

function formatPositionTime(record) {
  if (!record.lastPositionUtc) return 'POS: LIVE';
  const date = new Date(record.lastPositionUtc);
  if (Number.isNaN(date.getTime())) return 'POS: LIVE';
  return `POS: ${date.toISOString().slice(11, 19)}Z`;
}

function resetState() {
  clearFirstConnectTimer();
  state.engine = null;
  state.map = null;
  state.host = null;
  state.visible = false;
  state.enabled = false;
  state.loading = false;
  state.loaded = false;
  state.stale = false;
  state.error = null;
  state.loadingLabel = '';
  state.lastUpdate = null;
  state.count = 0;
  state.newestPositionAt = null;
  state.transportStatus = null;
  state.nextAttemptAt = null;
  state.lastMessageAt = null;
  state.rawRowCount = 0;
  state.acceptedRowCount = 0;
  state.sessionId = ++_aisSessionSequence;
  state.firstConnectPhase = 'idle';
  state.firstConnectStartedAt = null;
  state.firstConnectDeadline = null;
  state.firstConnectTimer = null;
  state.abort = null;
  state.vesselRecords = [];
  state.vesselMap = new Map();
  state.unkeyedRecords = [];
  state.clickHandler = null;
  state.keyTarget = null;
  state.keydownHandler = null;
  state.trackedChangeRemover = null;
  state.interactionKeyTarget = null;
  state.activeLabelCount = 0;
  state.selectedRecord = null;
  state.trail = null;
  state.trailPositions = [];
  state.trailMmsi = null;
  state.trailBackfillToken = 0;
  state.trackTarget = null;
  removeFocusPass();
  state.lastFocusUpdate = 0;
  state.activeFocusCount = 0;
}

/**
 * Bind the production interaction callbacks to a mockable engine surface.
 * Test-only seam; behavior is shared with installInteraction().
 * @param {Object} engine - Engine-like object with on(type, fn) -> remover and
 *   pick(x, y, {layers?, radius?}) -> MapLibre-like features.
 * @param {Object} keyTarget - EventTarget-like object with add/removeEventListener().
 * @returns {void}
 */
export function _bindVesselInteractionForTest(engine, keyTarget) {
  bindVesselInteraction(engine, keyTarget);
}

/**
 * Prime the minimum live state needed by interaction/lifecycle wire tests.
 * @param {Object} [options={}] - Test state values.
 * @returns {void}
 */
export function _setVesselStateForTest(options = {}) {
  resetState();
  const records = Array.isArray(options.records) ? options.records : [];
  state.engine = options.engine || options.viewer || null;
  state.enabled = options.enabled !== false;
  state.visible = state.enabled;
  state.loaded = options.loaded === true;
  state.loading = options.loading === true;
  state.stale = options.stale === true;
  state.error = options.error || null;
  state.lastUpdate = options.lastUpdate ?? null;
  state.vesselRecords = records;
  state.count = records.length;
  state.vesselMap = new Map(
    records.filter((record) => record?.mmsi).map((record) => [record.mmsi, record])
  );
  state.selectedRecord = options.selectedRecord || null;
  state.trail = options.trail || null;
  state.trailMmsi = options.trailMmsi || null;
  state.trailPositions = Array.isArray(options.trailPositions) ? [...options.trailPositions] : [];
  state.transportStatus = options.transportStatus || null;
  state.lastMessageAt = options.lastMessageAt ?? null;
  state.rawRowCount = Number.isFinite(options.rawRowCount) ? options.rawRowCount : 0;
  state.acceptedRowCount = Number.isFinite(options.acceptedRowCount) ? options.acceptedRowCount : records.length;
  state.firstConnectPhase = options.firstConnectPhase || 'idle';
  state.firstConnectStartedAt = options.firstConnectStartedAt ?? null;
  state.firstConnectDeadline = options.firstConnectDeadline ?? null;
  state.interactionKeyTarget = options.interactionKeyTarget || null;
}

/**
 * Reconcile AIS rows through the production lifecycle. Test-only seam.
 * @param {Object} engine - Engine-like object.
 * @param {Array<Object>} rows - Raw AIS rows.
 * @returns {void}
 */
export function _reconcileVesselsForTest(engine, rows) {
  reconcileVessels(engine, rows);
}

/** Apply one server snapshot through the production pre-reconcile health gate. */
export function _applyAisFeedSnapshotForTest(engine, payload) {
  return applyAisFeedSnapshot(engine, payload);
}

/** Exercise the request-owned live loader with a test-controlled fetch. */
export function _loadLivePositionsForTest(engine) {
  return loadLivePositions(engine);
}

/** Start the production first-connect grace state without installing UI. */
export function _beginAisSessionForTest() {
  beginAisSession();
}

/** Inject a deterministic clock/scheduler; null restores production runtime. */
export function _setAisRuntimeForTest(runtime = null) {
  clearFirstConnectTimer();
  _aisRuntime = runtime
    ? {
      now: runtime.now,
      setTimeout: runtime.setTimeout,
      clearTimeout: runtime.clearTimeout,
    }
    : DEFAULT_AIS_RUNTIME;
}

/** Read feed-health fields without exposing mutable production state. */
export function _getVesselFeedStateForTest() {
  const stats = aisLiveVesselsLayer.getStats();
  return {
    count: state.count,
    loaded: state.loaded,
    loading: stats.loading,
    loadingLabel: stats.loadingLabel,
    stale: state.stale,
    error: state.error,
    status: stats.status,
    lastUpdate: state.lastUpdate,
    transportStatus: state.transportStatus,
    lastMessageAt: state.lastMessageAt,
    rawRowCount: state.rawRowCount,
    acceptedRowCount: state.acceptedRowCount,
    selectedMmsi: state.selectedRecord?.mmsi || null,
    trailMmsi: state.trailMmsi,
    trailPositionCount: state.trailPositions.length,
    sessionId: state.sessionId,
    firstConnectPhase: state.firstConnectPhase,
    firstConnectStartedAt: state.firstConnectStartedAt,
    firstConnectDeadline: state.firstConnectDeadline,
  };
}

/**
 * Read lifecycle ownership state without exposing the mutable state object.
 * Test-only seam.
 * @returns {{trailMmsi: string|null, trailPositionCount: number, vesselCount: number}}
 */
export function _getVesselStateForTest() {
  return {
    trailMmsi: state.trailMmsi,
    trailPositionCount: state.trailPositions.length,
    vesselCount: state.vesselMap.size,
  };
}

/** Engine follow target currently owned by this layer (test-only). */
export function _getVesselTrackTargetForTest() {
  return state.trackTarget;
}
