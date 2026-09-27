/**
 * @module flights
 * @description Camada TRÁFEGO AÉREO (id `flights`) desenhada no MapLibre GL.
 *
 * FONTE DOS DADOS (inalterada)
 *  - Produção (build estático): tabela `aviation_traffic` do Supabase via
 *    `fetchAviationStates` (datageoClient.js), crédito "DataGeo PR ·
 *    etl-aviacao", cobertura "Paraná · raio 250 NM", já no formato
 *    OpenSky /states/all.
 *  - Dev: proxy /api/opensky (com fallback adsb.lol no próprio Vite), tipo e
 *    rota em /api/adsbdb (enriquecimento) e histórico em /api/opensky-track
 *    (rastro do alvo). No build de produção esses dois últimos não existem, então
 *    o enriquecimento e o preenchimento do rastro só rodam no dev.
 *
 * DESENHO (MIGRAÇÃO MAPLIBRE 2026-09, substitui a BillboardCollection do Cesium)
 *  - Uma fonte GeoJSON `dg-flights` com um ponto por aeronave, redesenhada pelo
 *    "fleet tick" (~12 Hz; mais espaçado com milhares de contatos). Cada ponto
 *    é um ícone da classe (aircraftIcons.js / aircraftClass.js) tingido como
 *    o billboard.color do Cesium (branco; âmbar #FFB800 militar; ciano no alvo;
 *    #DCEEFF pip de cockpit), girado pelo rumo exibido (`icon-rotate` com
 *    `icon-rotation-alignment: map`), com o tamanho por distância do Cesium
 *    (NearFarScalar 1000 m→3×, 8000 km→0,5×) convertido em interpolação por
 *    zoom, escala por classe e ×0,8 no solo. Duas faixas de raster (64 px longe,
 *    192 px perto) mantêm o glifo nítido, como o "two-tier raster" antigo.
 *  - Movimento: o mesmo modelo de antes — o mapa mostra "agora − 30 s" e
 *    INTERPOLA entre dois fixes conhecidos (sem ir e voltar a cada poll);
 *    quando não há par, extrapola em arco de curva constante (motionModel.js),
 *    com rumo suavizado (limitCourseStep) e retenção em pairado.
 *  - Contato sem poll: 45 % de opacidade (STALE) e remoção após 3 polls
 *    perdidos (1 para o "pousou e sumiu").
 *  - Alvo rastreado: sai da fonte da frota e vira dois maplibregl.Marker (DOM)
 *    movidos a cada quadro (requestAnimationFrame) — o ícone ciano de 28 px
 *    girado pelo rumo e, sob ele, o cartão (callsign · FL · kts / companhia ·
 *    tipo / ORIG → DEST, STALE quando em coast). O marcador anda no mesmo
 *    quadro em que o engine centraliza a câmera, sem tremer. Rastro do alvo
 *    (trailRenderer → layer `line`), com o segmento da cabeça ligado ao ícone a
 *    cada quadro.
 *  - Hover: tooltip do anfitrião (layerHost) com identificação, altitude,
 *    velocidade, tipo e rota. Clique: rastrear (câmera segue o alvo via
 *    `engine.track`); clique limpo em área vazia ou Esc: soltar a câmera no
 *    lugar (sem voo de volta).
 *  - Desfoque de foco: sprites que caem sobre o alvo rastreado e estão mais
 *    longe da câmera esmaecem (focusDeemphasis.js), como antes.
 *
 * O QUE ERA 3D E DEGRADA NO 2D
 *  - Modelos glTF (frota e alvo), "IR boost" dos modelos, encaixe no solo
 *    (groundSnap / piso de malha) e oclusão pelo horizonte do elipsoide não
 *    existem no MapLibre: a aeronave é sempre o ícone. As opções continuam
 *    aceitas e persistidas no link (`lo=f.e.1`, `f.m.p|a`) e em getParams/
 *    setParams (`models3d`, `models3dMode`, `irBoost`), mas não mudam o
 *    desenho — exceto `irBoost`, que ainda troca o glifo TR-3B pela variante
 *    térmica, como antes.
 *  - Altura: posições trazem `alt` (m, geo_altitude quando reportada, senão
 *    baro) só como dado; o mapa 2D desenha no chão.
 *
 * API PÚBLICA (mesmos nomes; tipos Cesium trocados por objetos neutros)
 *  - Posições (`position` em findByQuery, getNearby, getAllPositions,
 *    getDetectableObjects, getTrackedSubject e no evento
 *    `gev:awareness-subject-selected`) passam a ser o ponto neutro de
 *    geoPoint.js: `{lon, lat, height, x, y, z}` congelado (graus, metros
 *    elipsoidais, e o mesmo ponto em ECEF para quem ainda mede distância em
 *    linha reta). `getNearby(center, …)` aceita o centro em qualquer formato
 *    (neutro, {lon,lat}, ECEF).
 *  - Alvo do `engine.track`: objeto `{id, layerId:'flights', icao24,
 *    gevTrackedId, getPosition(), gevDisplayPosition(), gevVisualPosition(),
 *    getHeading(), getPose(), gevLabelModel, gevSelectionOrigin,
 *    releaseOnDrag:false, mapLabel:true, viewFrom}`; `getPosition()` devolve a
 *    posição interpolada deste quadro {lon, lat, alt, height}. `mapLabel: true`
 *    avisa que o cartão já é desenhado por esta camada (o leitor de alvo do
 *    worldOverlay/trackedReadout não deve duplicá-lo). Arrastar o mapa NÃO
 *    solta o alvo (no Cesium o arrasto orbitava em volta dele); Esc ou clique
 *    limpo no vazio soltam.
 *  - Para o cockpit (câmera de perseguição): `getTrackedPose()` →
 *    {icao24, lon, lat, alt, altitudeM, heading, speedMps, verticalRateMps,
 *    onGround, stale} na posição exibida deste quadro, e `getTrackedTarget()`.
 *  - Demais: init/enable/disable/update/destroy/getStats, setParams/getParams,
 *    getDetectableObjects, findByQuery, getNearby, hasContact, getAllPositions,
 *    getAnalystRecords, trackById, resolveTrackingRestoreTarget,
 *    refocusTrackedById, stopTracking, cancelPendingTrackingRestore,
 *    getTrackedInfo, getTrackedSubject, refreshTr3b; exports
 *    `mapAnalystRecord`, `TRACKED_MODEL_MAX_PX`.
 *  - Link: `lo=f.t.<icao>` restaura o rastreio (a expiração de 90 s é do
 *    layerState.js, que chama `resolveTrackingRestoreTarget`); `f.u.<id>` é do
 *    militar (opção espelhada); `f.e.1` / `f.m.p|a` como acima.
 */
import { aircraftIncludedInNearby } from './aircraftNearbyPolicy.js';
import { restoreSpriteOrderOnEnable, registerSpriteCollection } from './spriteOrder.js';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';
import { createTrail } from './trailRenderer.js';
import { isExplicitLayerStateOrigin } from './layerState.js';
import { fetchAviationStates } from './datageoClient.js';
import { stickyText, stickyNumber } from './aircraftMeta.js';
import { classifyAircraft, CLASS_SCALE_2D } from './aircraftClass.js';
import { aircraftIcon, TRACKED_ICON_PX } from './aircraftIcons.js';
import { isTr3b, tr3bAircraftClass, tr3bIconKind, tr3bTypeLabel } from './tr3bRegistry.js';
import { cockpitContactDotImageData } from './cockpitContactDot.js';
import { nextCockpitNearContacts } from './cockpitAirLod.js';
import { applyTrackedCameraFrame } from './trackedCamera.js';
import {
  limitCourseStep, turnRateFromFixHistory, arcOffsetEnu,
  lerpAngleDeg, speedRamp, courseSlewCapDps, displayedKinematics, staleCoastLimitSeconds,
  synthesizeForwardKinematicsFix, norm360,
  COURSE_HOLD_SPEED_MPS,
} from './motionModel.js';
import { routePlausible } from './routePlausible.js';
import {
  isMilitaryIcao, isMilitaryLayerActive, refreshMilitaryRegistryIfStale, onMilitaryLayerActiveChange,
} from './militaryRegistry.js';
import { formatFlightLevel } from './detectionDraw.js';
import {
  advanceProjectedSpriteFocus,
  clearFocusTarget,
  focusNowMs,
  getFocusTarget,
  publishFocusTargetFromCachedPosition,
} from './focusDeemphasis.js';
import { trackedLabelModelFromText } from './trackedReadout.js';
import {
  clearTrackedSubjectContext,
  refreshTrackedSubjectContext,
  selectTrackedSubjectContext,
} from './contextStore.js';
import { CONTACT_MATCH_TIER, contactMatchWins, rankContactMatch } from './contactMatch.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { geoPoint, geoDistanceM, toGeoPoint } from './geoPoint.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';
import { EMPTY_FC, defineLayer, esc, row } from '../maplibre/kit.js';

const IS_DEV = import.meta.env?.DEV === true;
const LAYER_ID = 'flights';

// ---------------------------------------------------------------------------
// Constantes de apresentação
// ---------------------------------------------------------------------------

/** Mantido por compatibilidade (teto do modelo 3D do alvo no Cesium). */
export const TRACKED_MODEL_MAX_PX = 200;

/** Ícones no solo um pouco menores (o "×0,8" do app). */
const GROUND_SCALE = 0.8;
/** Largura CSS base do ícone da frota (px), como o billboard de 20 px. */
const FLEET_ICON_PX = 20;
/** Largura CSS do ícone do alvo (px), como a entidade rastreada de 28 px. */
const TRACKED_ICON_CSS_PX = 28;
/** Cor do cartão/rastro do alvo. */
const TRACKED_ACCENT = '#39d0ff';
const TRAIL_COLOR = '#00d4ff';
const TRAIL_MAX_POINTS = 400;

/** Tintas (multiplicam o branco do glifo, como billboard.color). */
const TINTS = Object.freeze({
  w: [255, 255, 255, 1], // frota civil
  m: [255, 184, 0, 1], // militar conhecido (#FFB800)
  c: [0, 255, 255, 1], // alvo rastreado (Cesium.Color.CYAN)
  k: [220, 238, 255, 1], // pip de cockpit civil (#DCEEFF)
});
const ICON_KINDS = Object.freeze([
  'airliner', 'widebody', 'quadjet', 'turboprop', 'light', 'glider',
  'helicopter', 'fastjet', 'bizjet', 'uav', 'tr3b', 'tr3bHot',
]);
/** Rasters: [nome, px do SVG]; pixelRatio 2 → tamanho CSS intrínseco = px/2. */
const RASTERS = Object.freeze({ lo: 64, hi: TRACKED_ICON_PX });
const IMAGE_PIXEL_RATIO = 2;
const IMAGE_PREFIX = 'dg-ac-';
/** Zoom a partir do qual o raster de 192 px substitui o de 64 px. */
const HI_RASTER_MIN_ZOOM = 6.5;

/**
 * NearFarScalar(1000 m → 3,0; 8000 km → 0,5) do Cesium avaliado na altura de
 * câmera equivalente a cada zoom (kit.zoomForHeight) — a curva é a mesma do
 * shader do Cesium (t^0,2 sobre a distância ao quadrado).
 */
const NEAR_FAR_STOPS = Object.freeze([
  [3.6, 0.5], [5, 1.31], [6.6, 1.91], [8.4, 2.32], [10, 2.56], [12, 2.76], [16.6, 3.0],
]);

/** Fator de tamanho por zoom (mesma curva da expressão), para a matemática de foco. */
export function nearFarFactorAtZoom(zoom) {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return 1;
  if (z <= NEAR_FAR_STOPS[0][0]) return NEAR_FAR_STOPS[0][1];
  for (let i = 1; i < NEAR_FAR_STOPS.length; i++) {
    const [z1, v1] = NEAR_FAR_STOPS[i];
    const [z0, v0] = NEAR_FAR_STOPS[i - 1];
    if (z <= z1) return v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
  }
  return NEAR_FAR_STOPS[NEAR_FAR_STOPS.length - 1][1];
}

/** icon-size para um raster de `rasterPx`: base CSS × fator por zoom × ['get','s']. */
function iconSizeExpr(rasterPx) {
  const intrinsicCss = rasterPx / IMAGE_PIXEL_RATIO;
  const k = FLEET_ICON_PX / intrinsicCss;
  const out = ['interpolate', ['linear'], ['zoom']];
  for (const [z, v] of NEAR_FAR_STOPS) out.push(z, ['*', v * k, ['get', 's']]);
  return out;
}

// ---------------------------------------------------------------------------
// Fonte e tempos
// ---------------------------------------------------------------------------

const API_URL = '/api/opensky';
const SOURCE_STALE_MS = 120_000;
const BACKOFF_INTERVAL = 45000;
const ERROR_BACKOFF_INTERVAL = 20000;
const POSITION_HISTORY_LIMIT = 5;
/** O mapa mostra "agora − 30 s" (uma janela de poll): interpola entre fixes. */
const RENDER_DELAY_SEC = 30;
const MISSING_POLL_LIMIT = 3;
const LANDED_ALT_MAX_M = 150;
const LANDED_SPEED_MAX_MPS = 23;
const LANDED_MISSING_POLL_LIMIT = 1;
/** Intervalo do fleet tick (ms), ~12 Hz. Cresce com a frota (ver _tickIntervalMs). */
const FLEET_DR_INTERVAL_MS = 80;
const FLEET_SMOOTH_MAX = 1500;
const COURSE_MAX_DPS = 60;
const COURSE_SLEW_DT_MAX_SEC = 0.25;
/** Correção de descontinuidade do alvo (troca aquecimento→interpolação etc.). */
const DR_CORRECTION_MS = 900;
const METRES_PER_DEG = 111_320;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** @type {object|null} engine (src/maplibre/engine.js) */
let _engine = null;
let _host = null;
let _defRegistered = false;
/** Camada ligada (substitui `_billboardCollection.show`). */
let _enabled = false;
let _initialized = false;

/**
 * Contatos desenhados (o antigo mapa de billboards):
 * icao24 -> {position: {lon, lat, alt}, show: boolean, course: number|null, alpha: number}
 * @type {Map<string, {position: {lon:number, lat:number, alt:number}, show: boolean, course: number|null, alpha: number}>}
 */
let _contacts = new Map();
let _detectionObjects = new Map();
/** @type {Map<string, object>} icao24 -> metadados do poll (callsign, altitude, velocity…) */
let _flightData = new Map();
/** @type {Map<string, Array<{time:number, epochMs:number, position:{lon,lat,alt}, velocity:number, track:number}>>} */
let _positionHistory = new Map();
const _displayCourse = new Map();
let _missingPolls = new Map();

let _count = 0;
let _lastUpdate = null;
let _backoff = false;
let _retryAt = 0;
let _lastError = null;
let _lastStatus = null;
let _lastSource = 'OpenSky Network';
let _lastCoverage = 'worldwide upstream snapshot';
const _activeUpdateControllers = new Set();

let _models3dEnabled = true;
let _models3dMode = 'proximity';
let _irBoost = false;

// Rastreio
let _trackedIcao = null;
/** @type {object|null} alvo entregue ao engine.track */
let _trackedTarget = null;
let _trackedCameraFrameStop = null;
let _pendingTrackingRestore = null;
let _trackingIntentGeneration = 0;
let _trackingRefreshEpoch = 0;
let _lastTrackingRefreshOutcome = {
  epoch: 0, status: 'unavailable', ids: new Set(), source: 'OpenSky Network', coverage: null,
};
let _selfTrackChange = false;

// Cockpit
let _cockpitContactMode = false;
let _cockpitNearContacts = new Set();
let _cockpitSubjectId = null;
let _cockpitModeListener = null;

// Ciclo de vida
let _clickUnbind = null;
let _trackedChangeRemove = null;
let _moveEndRemove = null;
let _milActiveChangeUnsub = null;
let _tickTimer = null;
let _trackedRaf = null;
let _lastFleetTickMs = 0;
let _dataDirty = true;

// Rastro
let _trail = null;
let _trailHead = null;
let _trailPositions = [];
let _trailBackfillToken = 0;

// Dead reckoning: saídas do último _deadReckon (sem alocação por contato).
let _drCourseDeg = null;
let _drSpeedMps = null;
let _drCourseHold = false;
let _drExtrapolating = false;
const _scratchArc = { east: 0, north: 0, endCourseDeg: 0 };

// Cache por quadro do alvo rastreado + reconciliação de saltos.
let _trackedCache = null; // {icao, atMs, pos, course, speed, hold}
const _drCorr = { lon: 0, lat: 0, alt: 0, startMs: 0 };
let _drPrevRaw = null;
let _drPrevDisplay = null;
let _drPrevMs = 0;
let _drReconcileIcao = null;
let _trackedCourse = null;
let _trackedCourseMs = 0;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function _emitAwarenessEvent(type, detail) {
  if (typeof window === 'undefined' || !window.dispatchEvent || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function _toLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function _toCleanText(value) {
  return String(value || '').trim();
}

/** Convenção única de rótulo: callsign → matrícula → hex ICAO. */
function _contactLabel(icao24, info) {
  return _toCleanText(info?.callsign) || _toCleanText(info?.registration) || icao24;
}

function _normalizeTrackedIcao(candidate) {
  const normalized = String(candidate ?? '').trim().toLowerCase();
  return normalized || null;
}

function _isUsableOpenSkyState(state) {
  if (!Array.isArray(state) || typeof state[0] !== 'string' || !_normalizeTrackedIcao(state[0])) return false;
  return Number.isFinite(state[5]) && Number.isFinite(state[6]);
}

function _deriveOpenSkyAuthError({ detail, authMode, authReason }) {
  const reason = _toLowerText(authReason);
  const mode = _toLowerText(authMode);
  if (reason === 'oauth_invalid_or_missing') return 'OpenSky OAuth client missing/invalid';
  if (reason === 'oauth_invalid_credentials') return 'OpenSky OAuth rejected credentials';
  if (reason === 'basic_invalid_credentials') return 'OpenSky username/password rejected';
  if (reason === 'missing_basic_creds' || reason === 'missing_oauth_and_basic_creds') return 'OpenSky auth missing';
  if (reason === 'auth_required') return 'OpenSky auth required';
  if (reason.startsWith('oauth_') || reason.startsWith('basic_')) return 'OpenSky auth invalid';
  if (reason === 'forced_anonymous' || mode === 'anon') return 'OpenSky auth required';
  if (detail) return detail;
  return 'OpenSky auth failed';
}

function _approxDistanceM(a, b) {
  const dLat = (b.lat - a.lat) * METRES_PER_DEG;
  let dLonDeg = b.lon - a.lon;
  if (dLonDeg > 180) dLonDeg -= 360;
  if (dLonDeg < -180) dLonDeg += 360;
  const dLon = dLonDeg * METRES_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
  return Math.hypot(dLat, dLon, (b.alt || 0) - (a.alt || 0));
}

/** Rumo (graus) da corda a→b no plano local; null abaixo de `minChordM`. */
function _chordCourse(a, b, minChordM = 25) {
  let dLonDeg = b.lon - a.lon;
  if (dLonDeg > 180) dLonDeg -= 360;
  if (dLonDeg < -180) dLonDeg += 360;
  const e = dLonDeg * METRES_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const n = (b.lat - a.lat) * METRES_PER_DEG;
  if (e * e + n * n < minChordM * minChordM) return null;
  return norm360(Math.atan2(e, n) / DEG);
}

function _lerpPos(a, b, t) {
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  let lon = a.lon + dLon * t;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lon, lat: a.lat + (b.lat - a.lat) * t, alt: (a.alt || 0) + ((b.alt || 0) - (a.alt || 0)) * t };
}

function _offsetPos(p, east, north) {
  const cosLat = Math.max(Math.cos(p.lat * DEG), 1e-6);
  let lon = p.lon + east / (METRES_PER_DEG * cosLat);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lon, lat: Math.max(-89.999, Math.min(89.999, p.lat + north / METRES_PER_DEG)), alt: p.alt || 0 };
}

const _neutral = (p) => (p ? geoPoint(p.lon, p.lat, p.alt || 0) : null);

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * Produção (deploy estático): os estados vêm da tabela aviation_traffic do
 * Supabase (etl-aviacao, pg_cron 1 min, fonte adsb.lol), já no formato
 * /states/all; um Response sintético mantém o mesmo pipeline de status/headers.
 */
async function _fetchStatesPayload(engine, signal) {
  if (import.meta.env?.DEV !== false) {
    return fetch(_flightApiUrl(engine), { signal });
  }
  const payload = await fetchAviationStates();
  signal?.throwIfAborted();
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // "adsb.lol" no rótulo dispararia a heurística de FALLBACK do manager.
      'x-flight-source': 'DataGeo PR · etl-aviacao',
      'x-flight-coverage': 'Paraná · raio 250 NM',
    },
  });
}

/** URL do proxy de dev ancorada no centro da vista (o proxy regional usa lat/lon). */
function _flightApiUrl(engine) {
  let view = null;
  try { view = engine?.getCameraView?.() ?? null; } catch { view = null; }
  const latitude = view?.targetLat ?? view?.lat;
  const longitude = view?.targetLon ?? view?.lon;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return API_URL;
  const params = new URLSearchParams({ lat: latitude.toFixed(4), lon: longitude.toFixed(4) });
  return `${API_URL}?${params}`;
}

function _abortActiveUpdates() {
  for (const controller of _activeUpdateControllers) controller.abort();
  _activeUpdateControllers.clear();
}

// ---------------------------------------------------------------------------
// Enriquecimento (adsbdb, só no dev: o proxy /api/adsbdb não existe no build)
// ---------------------------------------------------------------------------

const ENRICH_ENABLED = IS_DEV;
const ENRICH_MAX_INFLIGHT = 4;
const ENRICH_DISPATCH_GAP_MS = 200;
const ENRICH_AMBIENT_BUDGET_CEIL = 300;
const ENRICH_AMBIENT_REFILL_TOKENS = 150;
const ENRICH_AMBIENT_REFILL_WINDOW_MS = 5 * 60 * 1000;
const ENRICH_AMBIENT_PER_SWEEP = 150;
let _enrichActive = 0;
let _enrichLastDispatchMs = 0;
let _enrichDripTimer = null;
const _enrichQueue = [];
const _enrichSeen = new Set();
let _enrichAmbientBudget = ENRICH_AMBIENT_BUDGET_CEIL;
let _enrichAmbientRefillAnchorMs = 0;

function _enqueueEnrich(key, url, onData, priority = false) {
  if (!ENRICH_ENABLED || _enrichSeen.has(key)) return;
  _enrichSeen.add(key);
  const job = { url, onData };
  if (priority) _enrichQueue.unshift(job); else _enrichQueue.push(job);
  _drainEnrich();
}

function _drainEnrich() {
  while (_enrichActive < ENRICH_MAX_INFLIGHT && _enrichQueue.length) {
    const wait = ENRICH_DISPATCH_GAP_MS - (Date.now() - _enrichLastDispatchMs);
    if (wait > 0) {
      if (!_enrichDripTimer) _enrichDripTimer = setTimeout(() => { _enrichDripTimer = null; _drainEnrich(); }, wait);
      return;
    }
    _enrichLastDispatchMs = Date.now();
    const job = _enrichQueue.shift();
    _enrichActive += 1;
    fetch(job.url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data && data.found) job.onData(data); })
      .catch(() => { /* enriquecimento nunca mostra erro */ })
      .finally(() => { _enrichActive -= 1; _drainEnrich(); });
  }
}

function _requestTypeEnrichment(icao24, priority = false) {
  if (!/^[0-9a-f]{6}$/i.test(icao24)) return;
  _enqueueEnrich(`t:${icao24}`, `/api/adsbdb/type/${icao24.toLowerCase()}`, (data) => {
    const meta = _flightData.get(icao24);
    if (!meta) return;
    meta.typeCode = data.typeCode || meta.typeCode;
    meta.typeName = data.typeName || meta.typeName;
    meta.registration = data.registration || meta.registration;
    if (meta.typeCode) meta.klass = classifyAircraft({ typeCode: meta.typeCode, category: meta.category });
    _dataDirty = true;
    if (icao24 === _trackedIcao) _updateTrackedLabelModel(icao24);
  }, priority);
}

function _requestRouteEnrichment(icao24) {
  const cs = String(_flightData.get(icao24)?.callsign || '').trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return;
  _enqueueEnrich(`r:${cs}`, `/api/adsbdb/route/${encodeURIComponent(cs)}`, (data) => {
    const meta = _flightData.get(icao24);
    if (!meta) return;
    meta.airline = data.airline || meta.airline;
    if (data.origin && data.destination) meta.route = { origin: data.origin, destination: data.destination };
    if (icao24 === _trackedIcao) _updateTrackedLabelModel(icao24);
  }, true);
}

function _ambientBudgetKnobs() {
  const o = (typeof window !== 'undefined' && window.__GEV_ENRICH_AMBIENT_QA) || null;
  return {
    ceil: Number.isFinite(o?.ceil) && o.ceil > 0 ? o.ceil : ENRICH_AMBIENT_BUDGET_CEIL,
    refillTokens: Number.isFinite(o?.refillTokens) && o.refillTokens > 0 ? o.refillTokens : ENRICH_AMBIENT_REFILL_TOKENS,
    windowMs: Number.isFinite(o?.windowMs) && o.windowMs > 0 ? o.windowMs : ENRICH_AMBIENT_REFILL_WINDOW_MS,
  };
}

function _refillAmbientBudget(nowMs) {
  const { ceil, refillTokens, windowMs } = _ambientBudgetKnobs();
  if (!_enrichAmbientRefillAnchorMs) { _enrichAmbientRefillAnchorMs = nowMs; return; }
  const windows = Math.floor((nowMs - _enrichAmbientRefillAnchorMs) / windowMs);
  if (windows <= 0) return;
  _enrichAmbientBudget = Math.min(ceil, _enrichAmbientBudget + windows * refillTokens);
  _enrichAmbientRefillAnchorMs += windows * windowMs;
}

/** Varredura ambiente: contatos NA TELA (bounds do mapa), mais perto do centro primeiro. */
function _sweepAmbientEnrichment() {
  if (!ENRICH_ENABLED) return;
  _refillAmbientBudget(Date.now());
  const map = _engine?.map;
  if (_enrichAmbientBudget <= 0 || !map || !_enabled) return;
  try {
    const b = map.getBounds();
    const c = map.getCenter();
    const cand = [];
    for (const [icao24, contact] of _contacts) {
      if (_enrichSeen.has(`t:${icao24}`) || !/^[0-9a-f]{6}$/i.test(icao24)) continue;
      if (_flightData.get(icao24)?.onGround) continue;
      const p = contact.position;
      if (!p || !b.contains([p.lon, p.lat])) continue;
      cand.push([icao24, (p.lon - c.lng) ** 2 + (p.lat - c.lat) ** 2]);
    }
    cand.sort((x, y) => x[1] - y[1]);
    const n = Math.min(cand.length, ENRICH_AMBIENT_PER_SWEEP, _enrichAmbientBudget);
    for (let i = 0; i < n; i++) {
      _enrichAmbientBudget -= 1;
      _requestTypeEnrichment(cand[i][0]);
    }
  } catch { /* melhor esforço */ }
}

// ---------------------------------------------------------------------------
// Dead reckoning (posições neutras {lon, lat, alt})
// ---------------------------------------------------------------------------

/**
 * Posição exibida de uma aeronave: "agora − RENDER_DELAY_SEC", interpolando
 * entre o par de fixes que cerca esse instante; sem par, extrapola em arco
 * (para trás no aquecimento, para frente no coast, limitado por
 * staleCoastLimitSeconds). Escreve rumo/velocidade em _dr*.
 * @param {string} icao24
 * @param {number} [nowMs]
 * @returns {{lon:number, lat:number, alt:number}|null}
 */
function _deadReckon(icao24, nowMs = Date.now()) {
  const info = _flightData.get(icao24);
  const history = _positionHistory.get(icao24);
  if (!history || history.length === 0) {
    _drCourseDeg = null; _drSpeedMps = null; _drCourseHold = false; _drExtrapolating = false;
    return null;
  }
  const renderMs = nowMs - RENDER_DELAY_SEC * 1000;

  for (let i = history.length - 1; i >= 1; i--) {
    const a = history[i - 1];
    const b = history[i];
    if (a.epochMs <= renderMs && renderMs <= b.epochMs) {
      const span = (b.epochMs - a.epochMs) / 1000;
      const t = span > 0 ? (renderMs - a.epochMs) / 1000 / span : 1;
      const chordLenM = _approxDistanceM(a.position, b.position);
      const segSpeed = span > 0 ? chordLenM / span : ((info && info.velocity) || 0);
      const fallbackTrack = (info && info.true_track) || 0;
      const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
      const trackTo = Number.isFinite(b.track) ? b.track : trackFrom;
      const trackCourse = lerpAngleDeg(trackFrom, trackTo, t);
      const w = (info && info.klass === 'helicopter') ? 0 : speedRamp(segSpeed);
      const chordCourse = w > 0 ? _chordCourse(a.position, b.position) : null;
      _drCourseDeg = chordCourse != null ? lerpAngleDeg(trackCourse, chordCourse, w) : trackCourse;
      _drSpeedMps = segSpeed;
      _drCourseHold = segSpeed < COURSE_HOLD_SPEED_MPS;
      _drExtrapolating = false;
      return _lerpPos(a.position, b.position, t);
    }
  }

  const newest = history[history.length - 1];
  const elapsedSec = (renderMs - newest.epochMs) / 1000;
  if (elapsedSec <= 0) {
    // Aquecimento: extrapola o fix MAIS ANTIGO para trás até o instante exibido.
    const oldest = history[0];
    const lookbackSec = (oldest.epochMs - renderMs) / 1000;
    return _extrapolateFix(oldest, info, -Math.min(lookbackSec, 60), (info && info.turnRateDps) || 0);
  }
  const coastLimitSec = staleCoastLimitSeconds({
    fixEpochMs: newest.epochMs,
    lastContactEpochMs: info?.lastContactEpochMs,
    minimumSec: 60,
    maximumSec: 300,
  });
  return _extrapolateFix(newest, info, Math.min(elapsedSec, coastLimitSec), (info && info.turnRateDps) || 0);
}

function _extrapolateFix(fix, info, dt, turnRateDps = 0) {
  const speed = Number.isFinite(fix.velocity) ? fix.velocity : ((info && info.velocity) || 0);
  const heading = Number.isFinite(fix.track) ? fix.track : ((info && info.true_track) || 0);
  _drSpeedMps = speed;
  _drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
  _drExtrapolating = true;
  if (speed === 0 || dt === 0) {
    _drCourseDeg = heading;
    return { lon: fix.position.lon, lat: fix.position.lat, alt: fix.position.alt || 0 };
  }
  arcOffsetEnu(speed, heading, turnRateDps, dt, _scratchArc);
  _drCourseDeg = _scratchArc.endCourseDeg;
  return _offsetPos(fix.position, _scratchArc.east, _scratchArc.north);
}

/** True enquanto o instante exibido do alvo antecede todo o histórico real. */
function _isTrackWarmingUp(nowMs = Date.now()) {
  if (!_trackedIcao) return false;
  const history = _positionHistory.get(_trackedIcao);
  if (!history || history.length === 0) return true;
  return nowMs - RENDER_DELAY_SEC * 1000 < history[0].epochMs;
}

// ---------------------------------------------------------------------------
// Alvo rastreado: posição por quadro com reconciliação de saltos
// ---------------------------------------------------------------------------

function _resetTrackedDisplay() {
  _trackedCache = null;
  _drPrevRaw = null;
  _drPrevDisplay = null;
  _drPrevMs = 0;
  _drReconcileIcao = null;
  _drCorr.lon = 0; _drCorr.lat = 0; _drCorr.alt = 0; _drCorr.startMs = 0;
  _trackedCourse = null;
  _trackedCourseMs = 0;
}

/**
 * Posição exibida do alvo neste quadro (cache de ~1 quadro compartilhado pelo
 * ícone, câmera, rastro e cartão). Saltos do dead reckoning bruto (troca
 * aquecimento→interpolação, fix corrigido) viram um deslocamento que decai a
 * zero em DR_CORRECTION_MS, então ícone e câmera nunca pulam.
 */
function _trackedDisplayPosition(nowMs = Date.now()) {
  const icao24 = _trackedIcao;
  if (!icao24) return null;
  if (_trackedCache && _trackedCache.icao === icao24 && nowMs - _trackedCache.atMs < 8) return _trackedCache.pos;
  const raw = _deadReckon(icao24, nowMs) || _contacts.get(icao24)?.position || null;
  const course = _drCourseDeg;
  const speed = _drSpeedMps;
  const hold = _drCourseHold;
  if (!raw) {
    _trackedCache = { icao: icao24, atMs: nowMs, pos: null, course, speed, hold };
    return null;
  }
  const sameTrack = _drReconcileIcao === icao24 && _drPrevRaw && _drPrevDisplay;
  if (sameTrack) {
    const dtSec = Math.max(0.001, (nowMs - _drPrevMs) / 1000);
    const expectedStepM = Math.max(30, (speed || 0) * dtSec * 3 + 15);
    const stepM = _approxDistanceM(_drPrevRaw, raw);
    if (stepM > expectedStepM && stepM < 50_000) {
      // Salto: absorve na correção (o que estava na tela − novo bruto).
      _drCorr.lon = _drPrevDisplay.lon - raw.lon;
      _drCorr.lat = _drPrevDisplay.lat - raw.lat;
      _drCorr.alt = (_drPrevDisplay.alt || 0) - (raw.alt || 0);
      _drCorr.startMs = nowMs;
    }
  } else {
    _drCorr.lon = 0; _drCorr.lat = 0; _drCorr.alt = 0; _drCorr.startMs = 0;
  }
  const k = _corrDecay(nowMs);
  const pos = k > 0
    ? { lon: raw.lon + _drCorr.lon * k, lat: raw.lat + _drCorr.lat * k, alt: (raw.alt || 0) + _drCorr.alt * k }
    : { lon: raw.lon, lat: raw.lat, alt: raw.alt || 0 };
  pos.height = pos.alt;
  _drPrevRaw = raw;
  _drPrevDisplay = pos;
  _drPrevMs = nowMs;
  _drReconcileIcao = icao24;

  // Rumo exibido suavizado (mesmo limitador da frota).
  const info = _flightData.get(icao24);
  const rawCourse = course != null ? course : ((info && info.true_track) || 0);
  const dt = _trackedCourseMs ? Math.min(COURSE_SLEW_DT_MAX_SEC, (nowMs - _trackedCourseMs) / 1000) : 0.016;
  _trackedCourse = (hold && _trackedCourse != null)
    ? _trackedCourse
    : limitCourseStep(_trackedCourse, rawCourse, courseSlewCapDps(speed != null ? speed : (info?.velocity ?? NaN), COURSE_MAX_DPS), dt);
  _trackedCourseMs = nowMs;

  _trackedCache = { icao: icao24, atMs: nowMs, pos, course, speed, hold };
  return pos;
}

function _corrDecay(nowMs) {
  if (!_drCorr.startMs) return 0;
  const f = 1 - (nowMs - _drCorr.startMs) / DR_CORRECTION_MS;
  return f > 0 ? f : 0;
}

/** Posição do alvo sem recalcular (o valor que a câmera e o ícone já usaram). */
function _trackedDisplayCached() {
  if (!_trackedIcao) return null;
  if (_trackedCache?.icao === _trackedIcao && _trackedCache.pos) return _trackedCache.pos;
  return _trackedDisplayPosition();
}

function _trackedDisplayCourse() {
  if (_trackedCourse != null) return _trackedCourse;
  const info = _flightData.get(_trackedIcao);
  return info?.true_track || 0;
}

// ---------------------------------------------------------------------------
// Imagens (glifos tingidos) — rasterizados uma vez, re-adicionados de forma
// síncrona no 'styleimagemissing' (troca de mapa base).
// ---------------------------------------------------------------------------

/** @type {Map<string, {width:number, height:number, data:Uint8ClampedArray}>} base branca por `${res}-${kind}` */
const _baseRasters = new Map();
let _rastersPromise = null;
let _dotBase = null;
const _hookedMaps = new WeakSet();

export function flightImageName(res, kind, tint) {
  return `${IMAGE_PREFIX}${res}-${kind}-${tint}`;
}

function _decodeSvg(uri, px) {
  return new Promise((resolve, reject) => {
    const img = new Image(px, px);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = px;
      canvas.height = px;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, px, px);
      const d = g.getImageData(0, 0, px, px);
      resolve({ width: px, height: px, data: d.data });
    };
    img.onerror = () => reject(new Error('glifo de aeronave não carregou'));
    img.src = uri;
  });
}

function _loadRasters() {
  if (typeof document === 'undefined') return Promise.resolve();
  _rastersPromise ??= Promise.all(Object.entries(RASTERS).flatMap(([res, px]) => ICON_KINDS.map(async (kind) => {
    _baseRasters.set(`${res}-${kind}`, await _decodeSvg(aircraftIcon(kind, px), px));
  }))).then(() => {
    const dot = cockpitContactDotImageData();
    if (dot) _dotBase = { width: dot.width, height: dot.height, data: dot.data };
  });
  return _rastersPromise;
}

/** Multiplica o branco do glifo pela tinta (billboard.color do Cesium). */
export function tintRaster(base, tint) {
  const [r, g, b, a] = TINTS[tint] || TINTS.w;
  const data = new Uint8ClampedArray(base.data);
  if (r !== 255 || g !== 255 || b !== 255 || a !== 1) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (data[i] * r) / 255;
      data[i + 1] = (data[i + 1] * g) / 255;
      data[i + 2] = (data[i + 2] * b) / 255;
      data[i + 3] *= a;
    }
  }
  return { width: base.width, height: base.height, data };
}

function _addImageByName(map, name) {
  if (!name?.startsWith(IMAGE_PREFIX) || map.hasImage(name)) return;
  const [res, kind, tint] = name.slice(IMAGE_PREFIX.length).split('-');
  if (kind === 'dot') {
    if (!_dotBase) return;
    // O pip (16 px) entra com o pixelRatio que o faz ter o mesmo tamanho CSS
    // intrínseco do raster da faixa, para a mesma expressão de icon-size servir.
    const css = RASTERS[res] / IMAGE_PIXEL_RATIO;
    map.addImage(name, tintRaster(_dotBase, tint), { pixelRatio: _dotBase.width / css });
    return;
  }
  const base = _baseRasters.get(`${res}-${kind}`);
  if (!base) return;
  map.addImage(name, tintRaster(base, tint), { pixelRatio: IMAGE_PIXEL_RATIO });
}

function _hookImages(map) {
  if (_hookedMaps.has(map)) return;
  _hookedMaps.add(map);
  map.on('styleimagemissing', (e) => {
    if (e.id?.startsWith(IMAGE_PREFIX)) _addImageByName(map, e.id);
  });
}

// ---------------------------------------------------------------------------
// Apresentação por contato
// ---------------------------------------------------------------------------

const _iconKind = (icao24, klass) => tr3bIconKind(icao24, klass || 'airliner', { hot: _irBoost }) || 'airliner';

function _fleetTint(icao24) {
  return isMilitaryIcao(icao24) ? 'm' : 'w';
}

/** Escala da frota: por classe, ×0,8 no solo. */
function _fleetScale(icao24, klass) {
  return (CLASS_SCALE_2D[klass] || 1) * (_flightData.get(icao24)?.onGround ? GROUND_SCALE : 1);
}

/** Pip de cockpit: tamanho equivalente a ~6 px no fator 1. */
const COCKPIT_DOT_SCALE = 0.3;

function _refreshCockpitNearContacts() {
  if (!_cockpitContactMode || !_engine) {
    if (_cockpitNearContacts.size) _cockpitNearContacts = new Set();
    return;
  }
  let cam = null;
  try {
    const v = _engine.getCameraView();
    cam = { lon: v.lon, lat: v.lat, alt: v.alt };
  } catch { cam = null; }
  if (!cam || !Number.isFinite(cam.lon)) return;
  const distancesSquared = [];
  for (const [icao24, c] of _contacts) {
    if (icao24 === _trackedIcao || !c.position) continue;
    const d = _approxDistanceM(cam, c.position);
    distancesSquared.push([icao24, d * d]);
  }
  const addM = _models3dMode === 'all' ? 60_000 : 30_000;
  _cockpitNearContacts = nextCockpitNearContacts(_cockpitNearContacts, distancesSquared, addM, addM * 1.25);
}

function _setCockpitContactMode(active) {
  const next = active === true;
  if (_cockpitContactMode === next) return;
  _cockpitContactMode = next;
  if (next) _refreshCockpitNearContacts();
  else _cockpitNearContacts = new Set();
  _trail?.setVisible(!next);
  _trailHead?.setVisible(!next);
  _dataDirty = true;
  _lastFleetTickMs = 0;
}

function _applyCockpitState(detail = {}) {
  const active = detail?.active === true;
  _cockpitSubjectId = active ? String(detail?.subjectId || '').trim().toLowerCase() || null : null;
  _setCockpitContactMode(active);
}

/** Propriedades de desenho de um contato da frota (exportada para teste). */
export function fleetFeatureProps(icao24, info, { course = 0, alpha = 1, cockpitDot = false, focus = 1 } = {}) {
  const tint = cockpitDot ? (isMilitaryIcao(icao24) ? 'm' : 'k') : _fleetTint(icao24);
  const kind = cockpitDot ? 'dot' : _iconKind(icao24, info?.klass);
  return {
    icao: icao24,
    img: `${kind}-${tint}`,
    s: cockpitDot ? COCKPIT_DOT_SCALE : _fleetScale(icao24, info?.klass),
    r: cockpitDot ? 0 : Math.round(norm360(course) * 10) / 10,
    a: Math.round(Math.max(0.05, Math.min(1, alpha * focus)) * 1000) / 1000,
    g: info?.onGround === true,
  };
}

// ---------------------------------------------------------------------------
// Fontes e layers MapLibre
// ---------------------------------------------------------------------------

const SRC_FLEET = 'dg-flights';
const L_LO = 'dg-flights-lo';
const L_HI = 'dg-flights-hi';

const ICON_LAYOUT = {
  'icon-rotate': ['get', 'r'],
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'viewport',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'symbol-sort-key': ['case', ['get', 'g'], 0, 1],
};

function _tooltipHtml(props) {
  const icao24 = props?.icao;
  const info = icao24 ? _flightData.get(icao24) : null;
  if (!info) return '';
  const altFt = Math.round((info.altitude || 0) * 3.28084);
  const alt = info.onGround ? 'no solo' : (altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt.toLocaleString('pt-BR')} ft`);
  const spd = Number.isFinite(info.velocity) && info.velocity > 0 ? `${Math.round(info.velocity * 1.944)} kt` : '';
  const hdg = Number.isFinite(info.true_track) ? `${Math.round(info.true_track)}°` : '';
  const ident = isTr3b(icao24) ? tr3bTypeLabel(icao24) : [info.airline, info.typeName || info.typeCode].filter(Boolean).join(' · ');
  const route = info.route && _routeIsPlausible(icao24, info.route)
    ? `${info.route.origin.code} → ${info.route.destination.code}` : '';
  const stale = _missingPolls.get(icao24) || _backoff;
  return `<div class="dg-tt-flight"><strong>✈️ ${esc(_contactLabel(icao24, info))}</strong>${stale ? ' <em>(desatualizado)</em>' : ''}`
    + row('Altitude', alt)
    + row('Velocidade', spd)
    + row('Rumo', hdg)
    + row('Aeronave', ident)
    + row('Rota', route)
    + row('Matrícula', _toCleanText(info.registration) && _toCleanText(info.callsign) ? _toCleanText(info.registration) : '')
    + row('ICAO', icao24)
    + '</div>';
}

/** Definição da camada no contrato do anfitrião (kit.js): fontes, layers, hover. */
export const flightsMapDef = defineLayer({
  id: LAYER_ID,
  name: 'Tráfego aéreo',
  category: 'Infraestrutura',
  icon: '✈️',
  source: 'OpenSky Network',
  sources: {
    [SRC_FLEET]: { type: 'geojson', data: EMPTY_FC, promoteId: 'icao' },
  },
  layers: [
    {
      id: L_LO,
      type: 'symbol',
      source: SRC_FLEET,
      maxzoom: HI_RASTER_MIN_ZOOM,
      layout: { ...ICON_LAYOUT, 'icon-image': ['concat', `${IMAGE_PREFIX}lo-`, ['get', 'img']], 'icon-size': iconSizeExpr(RASTERS.lo) },
      paint: { 'icon-opacity': ['get', 'a'] },
    },
    {
      id: L_HI,
      type: 'symbol',
      source: SRC_FLEET,
      minzoom: HI_RASTER_MIN_ZOOM,
      layout: { ...ICON_LAYOUT, 'icon-image': ['concat', `${IMAGE_PREFIX}hi-`, ['get', 'img']], 'icon-size': iconSizeExpr(RASTERS.hi) },
      paint: { 'icon-opacity': ['get', 'a'] },
    },
  ],
  interactive: [L_LO, L_HI],
  tooltip: (props) => _tooltipHtml(props),
});

const _INTERACTIVE_LAYERS = [L_LO, L_HI];

function _map() {
  return _engine?.map ?? null;
}

function _ensureMapLayers() {
  const map = _map();
  if (!map) return false;
  _host = _host || getActiveLayerHost();
  try {
    if (_host) {
      if (!_defRegistered || !_host.ctx?.getLayer?.(LAYER_ID)) {
        _host.register(flightsMapDef);
        _defRegistered = true;
      }
      _host.ensureAdded(flightsMapDef);
    } else {
      // Sem anfitrião (bancada mínima): adiciona direto, visível.
      for (const [id, spec] of Object.entries(flightsMapDef.sources)) if (!map.getSource(id)) map.addSource(id, spec);
      for (const layer of flightsMapDef.layers) if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    _hookImages(map);
    registerSpriteCollection(LAYER_ID, _INTERACTIVE_LAYERS);
    return true;
  } catch (err) {
    console.warn('[Data:Flights] layers', err);
    return false;
  }
}

function _setMapVisible(visible) {
  const map = _map();
  if (!map) return;
  if (_host) {
    _host.setVisible(LAYER_ID, visible);
    return;
  }
  for (const layer of flightsMapDef.layers) {
    if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * setData com no máximo UMA atualização em voo por fonte: enquanto o worker
 * do MapLibre processa a anterior, só a mais nova fica guardada. Sem isso, o
 * alvo (atualizado a cada quadro) nunca terminava de carregar os tiles da
 * fonte e não aparecia.
 */
const _inflight = new Map(); // sourceId -> {busy, pending}
function _setSourceData(sourceId, data) {
  const map = _map();
  if (!map) return;
  let slot = _inflight.get(sourceId);
  if (!slot) {
    slot = { busy: false, pending: null, map };
    _inflight.set(sourceId, slot);
  }
  if (slot.map !== map) { slot.map = map; slot.busy = false; }
  if (slot.busy) {
    slot.pending = data;
    return;
  }
  let src = null;
  try { src = map.getSource(sourceId); } catch { src = null; }
  if (!src) return;
  slot.busy = true;
  slot.pending = null;
  let result;
  try { result = src.setData(data); } catch { result = null; }
  const done = () => {
    slot.busy = false;
    if (slot.pending) {
      const next = slot.pending;
      slot.pending = null;
      _setSourceData(sourceId, next);
    }
  };
  if (result && typeof result.then === 'function') {
    result.then(() => map.once('sourcedata', () => {}) && null).catch(() => {}).finally(() => setTimeout(done, 0));
  } else {
    done();
  }
}

// ---------------------------------------------------------------------------
// Fleet tick
// ---------------------------------------------------------------------------

/**
 * Intervalo do próximo passo da frota. O MapLibre só fica "ocioso" (evento
 * idle, que outras camadas e a bancada esperam) entre dois setData, então o
 * passo acompanha o que é visível: o suficiente para a aeronave mais rápida
 * andar ~0,75 px por passo no zoom atual (80 ms perto, até 2 s no estado
 * inteiro), e mais espaçado com milhares de contatos.
 */
function _tickIntervalMs() {
  let ms = FLEET_DR_INTERVAL_MS;
  const map = _map();
  if (map) {
    try {
      const z = map.getZoom();
      const lat = map.getCenter().lat;
      const mpp = (40_075_016.7 * Math.cos(lat * DEG)) / (512 * 2 ** z);
      ms = Math.max(ms, Math.min(2000, (1000 * 0.75 * mpp) / 260));
    } catch { /* mapa indisponível */ }
  }
  const n = _contacts.size;
  if (n > FLEET_SMOOTH_MAX) ms = Math.max(ms, Math.min(2000, (FLEET_DR_INTERVAL_MS * n) / FLEET_SMOOTH_MAX));
  return Math.round(ms);
}

function _scheduleTick() {
  if (_tickTimer || !_enabled) return;
  _tickTimer = setTimeout(() => {
    _tickTimer = null;
    if (!_enabled) return;
    try { _fleetTick(); } catch (err) { console.warn('[Data:Flights] tick', err); }
    _scheduleTick();
  }, _tickIntervalMs());
}

/**
 * Um passo da frota: dead reckoning, rumo suavizado, opacidade (STALE × foco)
 * e o GeoJSON da fonte. O alvo rastreado fica de fora (tem fonte própria e
 * anda a cada quadro).
 */
function _fleetTick(nowOverrideMs) {
  if (!_enabled) return;
  const nowMs = focusNowMs(nowOverrideMs ?? Date.now());
  const tickDtSec = _lastFleetTickMs ? Math.min(COURSE_SLEW_DT_MAX_SEC, (nowMs - _lastFleetTickMs) / 1000) : 0.08;
  _lastFleetTickMs = nowMs;
  if (_cockpitContactMode) _refreshCockpitNearContacts();

  const focusTarget = getFocusTarget();
  let camView = null;
  let nf = 1;
  if (_engine && (focusTarget || _focusActive > 0)) {
    try {
      const v = _engine.getCameraView();
      camView = { lon: v.lon, lat: v.lat, alt: v.alt };
      nf = nearFarFactorAtZoom(v.zoom);
    } catch { camView = null; }
  }
  let focusActive = 0;

  const features = [];
  for (const [icao24, contact] of _contacts) {
    const info = _flightData.get(icao24);
    const dr = _deadReckon(icao24, nowMs);
    if (dr) contact.position = dr;
    if (icao24 === _trackedIcao) continue;

    const rawCourse = _drCourseDeg != null ? _drCourseDeg : ((info && info.true_track) || 0);
    const prevCourse = _displayCourse.get(icao24);
    const course = (_drCourseHold && prevCourse != null)
      ? prevCourse
      : limitCourseStep(
        prevCourse, rawCourse,
        courseSlewCapDps(_drSpeedMps != null ? _drSpeedMps : ((info && info.velocity) ?? NaN), COURSE_MAX_DPS),
        tickDtSec,
      );
    _displayCourse.set(icao24, course);
    contact.course = course;

    let focus = 1;
    if (camView) {
      const s = _fleetScale(icao24, info?.klass);
      const half = FLEET_ICON_PX * s * nf * 0.5;
      const res = advanceProjectedSpriteFocus(contact, contact.position, _engine, camView, nowMs, focusTarget, undefined, half, half);
      focus = res.factor;
      if (res.active || res.transitioning) focusActive += 1;
    }
    contact.alpha = _missingPolls.get(icao24) ? 0.45 : 1;
    const cockpitDot = _cockpitContactMode && !_cockpitNearContacts.has(icao24);
    const p = contact.position;
    features.push({
      type: 'Feature',
      id: icao24,
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: fleetFeatureProps(icao24, info, { course, alpha: contact.alpha, cockpitDot, focus }),
    });
  }
  _focusActive = focusActive;
  _dataDirty = false;
  _setSourceData(SRC_FLEET, { type: 'FeatureCollection', features });
}
let _focusActive = 0;

// ---------------------------------------------------------------------------
// Laço por quadro do alvo rastreado (ícone, rótulo, rastro, foco)
// ---------------------------------------------------------------------------

// O alvo é desenhado com dois maplibregl.Marker (DOM): o ícone ciano girado
// pelo rumo e o cartão sob ele. Um marcador acompanha o mapa no MESMO quadro
// em que a câmera o centraliza (engine.track), sem o atraso do worker de uma
// fonte GeoJSON atualizada a 60 Hz (que tremia e, com texto, nem terminava de
// carregar), e o clique nele não "cai" no mapa como área vazia.

let _trackedIconMarker = null;
let _trackedCardMarker = null;
let _trackedIconImg = null;
let _trackedCardEl = null;
let _trackedIconKey = '';
let _trackedCardKey = '';
const _tintedUriCache = new Map();

/** Data URI do glifo tingido (raster de 192 px), ou o SVG branco enquanto os rasters carregam. */
function _tintedIconUri(kind, tint) {
  const key = `${kind}-${tint}`;
  if (_tintedUriCache.has(key)) return _tintedUriCache.get(key);
  const base = _baseRasters.get(`hi-${kind}`);
  if (!base || typeof document === 'undefined') return aircraftIcon(kind, TRACKED_ICON_PX);
  const canvas = document.createElement('canvas');
  canvas.width = base.width;
  canvas.height = base.height;
  const t = tintRaster(base, tint);
  canvas.getContext('2d').putImageData(new ImageData(t.data, t.width, t.height), 0, 0);
  const uri = canvas.toDataURL('image/png');
  _tintedUriCache.set(key, uri);
  return uri;
}

function _injectTrackedStyle() {
  if (typeof document === 'undefined' || document.getElementById('dg-flights-style')) return;
  const style = document.createElement('style');
  style.id = 'dg-flights-style';
  style.textContent = `
    .dg-flight-tracked-icon { pointer-events: auto; cursor: pointer; line-height: 0; }
    .dg-flight-tracked-icon img { display: block; width: 100%; height: 100%; filter: drop-shadow(0 0 3px rgba(0,212,255,.55)); }
    .dg-flight-card { pointer-events: none; font: 11px/1.35 'JetBrains Mono', ui-monospace, monospace; color: #cfe9f3;
      background: rgba(6,10,16,.84); border: 1px solid rgba(57,208,255,.55); border-radius: 6px; padding: 4px 7px;
      white-space: nowrap; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,.45); }
    .dg-flight-card b { color: ${TRACKED_ACCENT}; font-weight: 700; letter-spacing: .04em; }
    .dg-flight-card div { color: #9fb7c4; }
    #dg-tooltip .dg-tt-flight em { color: #fbbf24; font-style: normal; }
  `;
  document.head.appendChild(style);
}

function _ensureTrackedMarkers() {
  const ml = _engine?.maplibregl;
  const map = _map();
  if (!ml?.Marker || !map || typeof document === 'undefined') return false;
  _injectTrackedStyle();
  if (!_trackedIconMarker) {
    const el = document.createElement('div');
    el.className = 'dg-flight-tracked-icon';
    _trackedIconImg = document.createElement('img');
    _trackedIconImg.alt = '';
    _trackedIconImg.draggable = false;
    el.appendChild(_trackedIconImg);
    // O clique no próprio alvo não chega ao mapa (não desseleciona).
    for (const type of ['click', 'dblclick']) el.addEventListener(type, (e) => e.stopPropagation());
    _trackedIconMarker = new ml.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' });
  }
  if (!_trackedCardMarker) {
    _trackedCardEl = document.createElement('div');
    _trackedCardEl.className = 'dg-flight-card';
    _trackedCardMarker = new ml.Marker({ element: _trackedCardEl, anchor: 'top', pitchAlignment: 'viewport', rotationAlignment: 'viewport' });
  }
  return true;
}

function _removeTrackedMarkers() {
  _trackedIconMarker?.remove();
  _trackedCardMarker?.remove();
  _trackedIconKey = '';
  _trackedCardKey = '';
}

/** Propriedades de desenho do alvo (ícone/cartão), exportadas para teste. */
function _trackedPresentation(pos) {
  const icao24 = _trackedIcao;
  const info = _flightData.get(icao24);
  const model = _trackedTarget?.gevLabelModel || { title: icao24, details: [] };
  let zoom = 8;
  try { zoom = _map()?.getZoom() ?? 8; } catch { /* */ }
  const sizePx = TRACKED_ICON_CSS_PX * (CLASS_SCALE_2D[info?.klass] || 1) * nearFarFactorAtZoom(zoom);
  return {
    icao: icao24,
    lon: pos.lon,
    lat: pos.lat,
    kind: _iconKind(icao24, info?.klass),
    rotation: Math.round(norm360(_trackedDisplayCourse()) * 10) / 10,
    sizePx,
    title: model.title || icao24,
    details: Array.isArray(model.details) ? model.details : [],
  };
}

function _trackedFrame() {
  _trackedRaf = null;
  if (!_trackedIcao || !_enabled) return;
  const nowMs = Date.now();
  const pos = _trackedDisplayPosition(nowMs);
  if (pos && _ensureTrackedMarkers()) {
    const map = _map();
    const pres = _trackedPresentation(pos);
    const iconKey = `${pres.kind}|${_baseRasters.size}`;
    if (iconKey !== _trackedIconKey) {
      _trackedIconImg.src = _tintedIconUri(pres.kind, 'c');
      _trackedIconKey = iconKey;
    }
    const el = _trackedIconMarker.getElement();
    const px = `${Math.round(pres.sizePx)}px`;
    if (el.style.width !== px) { el.style.width = px; el.style.height = px; }
    _trackedIconMarker.setLngLat([pos.lon, pos.lat]).setRotation(pres.rotation);
    if (!_trackedIconMarker._map) _trackedIconMarker.addTo(map);
    const cardKey = `${pres.title}\n${pres.details.join('\n')}`;
    if (cardKey !== _trackedCardKey) {
      _trackedCardEl.innerHTML = `<b>${esc(pres.title)}</b>${pres.details.map((d) => `<div>${esc(d)}</div>`).join('')}`;
      _trackedCardKey = cardKey;
    }
    _trackedCardMarker.setOffset([0, Math.round(pres.sizePx / 2 + 6)]).setLngLat([pos.lon, pos.lat]);
    if (!_trackedCardMarker._map && !_cockpitContactMode) _trackedCardMarker.addTo(map);
    if (_cockpitContactMode && _trackedCardMarker._map) _trackedCardMarker.remove();
    // Cabeça do rastro: último ponto do corpo → ícone (nada no aquecimento).
    if (_trailHead) {
      if (_trailPositions.length >= 2 && !_isTrackWarmingUp(nowMs)) {
        _trailHead.setPositions([_trailPositions[_trailPositions.length - 2], pos]);
      } else {
        _trailHead.setPositions([]);
      }
    }
    if (!_cockpitContactMode) {
      publishFocusTargetFromCachedPosition({
        ownerLayer: LAYER_ID,
        id: _trackedIcao,
        scene: _engine,
        camera: _cameraGeoForFocus(),
        displayPosition: pos,
        widthPx: pres.sizePx,
        heightPx: pres.sizePx,
      });
    }
  }
  _trackedRaf = _raf(_trackedFrame);
}

function _cameraGeoForFocus() {
  try {
    const v = _engine.getCameraView();
    return { lon: v.lon, lat: v.lat, alt: v.alt };
  } catch {
    return _engine;
  }
}

const _raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const _cancelRaf = (id) => {
  if (id == null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
};

function _startTrackedLoop() {
  if (_trackedRaf == null && _trackedIcao && _enabled && _engine) _trackedRaf = _raf(_trackedFrame);
}

function _stopTrackedLoop() {
  _cancelRaf(_trackedRaf);
  _trackedRaf = null;
}

// ---------------------------------------------------------------------------
// Rastro do alvo
// ---------------------------------------------------------------------------

function _appendTrailFix(position) {
  _trailPositions.push({ lon: position.lon, lat: position.lat, alt: position.alt || 0 });
  if (_trailPositions.length > TRAIL_MAX_POINTS) _trailPositions.shift();
  _refreshTrailDisplay();
}

/** Corpo do rastro = fixes acumulados MENOS o mais novo (que está à frente do ícone atrasado). */
function _refreshTrailDisplay() {
  if (!_trail) return;
  _trail.setPositions(_trailPositions.length > 1 ? _trailPositions.slice(0, -1) : _trailPositions);
}

function _startTrail(icao24) {
  _trailBackfillToken += 1;
  _trailPositions = [];
  const history = _positionHistory.get(icao24) || [];
  const seedMs = Date.now() - RENDER_DELAY_SEC * 1000;
  for (const fix of history) {
    if (fix.epochMs <= seedMs) _trailPositions.push({ ...fix.position });
  }
  if (_engine) {
    if (!_trail) _trail = createTrail(_engine, { color: TRAIL_COLOR, width: 2.5 });
    if (!_trailHead) _trailHead = createTrail(_engine, { color: TRAIL_COLOR, width: 2.5 });
  }
  _trail?.setVisible(!_cockpitContactMode);
  _trailHead?.setVisible(!_cockpitContactMode);
  _refreshTrailDisplay();
  const oldestFixEpochSec = history.length ? history[0].epochMs / 1000 : Infinity;
  void _backfillTrail(icao24, _trailBackfillToken, oldestFixEpochSec);
}

/** Histórico OpenSky /tracks (só dev): pontos mais antigos que o 1º fix entram antes do rastro local. */
async function _backfillTrail(icao24, token, oldestFixEpochSec) {
  if (!IS_DEV) return;
  let path = null;
  try {
    const response = await fetch(`/api/opensky-track?icao24=${encodeURIComponent(icao24)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const data = await response.json();
    path = Array.isArray(data?.path) ? data.path : null;
  } catch {
    return;
  }
  if (!path || token !== _trailBackfillToken || icao24 !== _trackedIcao) return;
  const older = [];
  let lastAlt = null;
  for (const waypoint of path) {
    if (!Array.isArray(waypoint)) continue;
    const [time, lat, lon, baroAlt] = waypoint;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(time) || time >= oldestFixEpochSec) continue;
    const alt = Number.isFinite(baroAlt) ? baroAlt : (lastAlt ?? 0);
    lastAlt = alt;
    older.push({ lon, lat, alt });
  }
  if (!older.length) return;
  _trailPositions = older.concat(_trailPositions);
  if (_trailPositions.length > TRAIL_MAX_POINTS) _trailPositions = _trailPositions.slice(_trailPositions.length - TRAIL_MAX_POINTS);
  _refreshTrailDisplay();
}

function _clearTrail() {
  _trailBackfillToken += 1;
  _trailPositions = [];
  _trail?.clear();
  _trailHead?.clear();
}

function _destroyTrail() {
  _clearTrail();
  _trail?.destroy();
  _trailHead?.destroy();
  _trail = null;
  _trailHead = null;
}

// ---------------------------------------------------------------------------
// Rastreio
// ---------------------------------------------------------------------------

function _routeIsPlausible(icao24, route) {
  const info = _flightData.get(icao24);
  const pos = _contacts.get(icao24)?.position;
  if (!info || !pos) return true;
  return routePlausible({
    latDeg: pos.lat,
    lonDeg: pos.lon,
    altitudeM: info.altitude ?? null,
    verticalRateMps: info.verticalRate ?? null,
    origin: route.origin,
    destination: route.destination,
  });
}

/** Texto do cartão do alvo: "CS · FL · kts[ · STALE]" / "Companhia · Tipo" / "ORIG → DEST". */
function _trackedLabelText(icao24) {
  const info = _flightData.get(icao24);
  if (!info) return icao24;
  const cs = _contactLabel(icao24, info);
  const altFt = Math.round((info.altitude || 0) * 3.28084);
  const fl = altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt} ft`;
  const spd = info.velocity ? `${Math.round(info.velocity * 1.944)} kts` : '';
  const stale = (_missingPolls.get(icao24) || _backoff) ? 'STALE' : '';
  const lines = [[cs, fl, spd, stale].filter(Boolean).join(' · ')];
  const ident = isTr3b(icao24)
    ? tr3bTypeLabel(icao24)
    : [info.airline, info.typeName || info.typeCode].filter(Boolean).join(' · ');
  if (ident) lines.push(ident);
  if (info.route && _routeIsPlausible(icao24, info.route)) {
    lines.push(`${info.route.origin.code} → ${info.route.destination.code}`);
  }
  return lines.join('\n');
}

function _updateTrackedLabelModel(icao24) {
  if (!_trackedTarget || icao24 !== _trackedIcao) return;
  _trackedTarget.gevLabelModel = trackedLabelModelFromText(_trackedLabelText(icao24), TRACKED_ACCENT);
  refreshTrackedSubjectContext(_contextSubjectMetadata(icao24));
}

function _contextSubjectMetadata(icao24) {
  const described = _describeFlight(icao24);
  if (!described) return null;
  const altFt = Math.round((described.altitudeM || 0) * 3.28084);
  const route = described.route && _routeIsPlausible(icao24, described.route)
    ? `${described.route.origin.code} → ${described.route.destination.code}`
    : null;
  return {
    id: icao24,
    layerId: LAYER_ID,
    layerName: 'Live Flights',
    source: 'OpenSky Network',
    label: _contactLabel(icao24, _flightData.get(icao24)),
    latitude: described.latitude,
    longitude: described.longitude,
    properties: {
      name: _contactLabel(icao24, _flightData.get(icao24)),
      operator: described.airline || '',
      callsign: described.callsign || '',
      registration: described.registration || '',
      type: described.typeName || described.typeCode || '',
      altitude: described.onGround ? 'on ground' : `${altFt.toLocaleString('en-US')} ft`,
      speed: Number.isFinite(described.velocityMps) ? `${Math.round(described.velocityMps * 1.944)} kt` : '',
      heading: Number.isFinite(described.track) ? `${Math.round(described.track)}°` : '',
      route: route || '',
      icao24,
      status: described.stale ? 'stale (missed polls)' : 'live',
    },
  };
}

function _publishTrackedSelection(icao24, origin = 'programmatic') {
  const contact = _contacts.get(icao24);
  const info = _flightData.get(icao24);
  if (!contact?.position || !info) return false;
  if (_trackedTarget) _trackedTarget.gevSelectionOrigin = origin;
  const pos = (icao24 === _trackedIcao && _trackedDisplayCached()) || contact.position;
  _emitAwarenessEvent('gev:awareness-subject-selected', {
    layerId: LAYER_ID,
    id: icao24,
    label: _contactLabel(icao24, info),
    position: _neutral(pos),
    origin,
  });
  selectTrackedSubjectContext(_contextSubjectMetadata(icao24));
  return true;
}

function _isExplicitTrackingOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

/** Pose do alvo (para a câmera de perseguição do cockpit). */
function _trackedPose() {
  if (!_trackedIcao) return null;
  const pos = _trackedDisplayCached();
  if (!pos) return null;
  const info = _flightData.get(_trackedIcao);
  const speed = _trackedCache?.speed;
  return {
    icao24: _trackedIcao,
    lon: pos.lon,
    lat: pos.lat,
    alt: pos.alt || 0,
    altitudeM: Number.isFinite(info?.altitude) ? info.altitude : (pos.alt || 0),
    heading: _trackedDisplayCourse(),
    speedMps: Number.isFinite(speed) ? speed : (info?.velocity ?? null),
    verticalRateMps: info?.verticalRate ?? null,
    onGround: info?.onGround === true,
    stale: Boolean(_missingPolls.get(_trackedIcao) || _backoff),
  };
}

function _makeTrackedTarget(icao24, origin) {
  const target = {
    id: `flights:${icao24}`,
    layerId: LAYER_ID,
    icao24,
    gevTrackedId: `flights:${icao24}`,
    gevSelectionOrigin: origin,
    gevLabelModel: trackedLabelModelFromText(_trackedLabelText(icao24), TRACKED_ACCENT),
    /** Arrastar o mapa não solta o alvo (no Cesium o arrasto orbitava em volta dele). */
    releaseOnDrag: false,
    /** O cartão já é um rótulo MapLibre desta camada. */
    mapLabel: true,
    getPosition: () => (_trackedIcao === icao24 ? _trackedDisplayPosition() : null),
    gevDisplayPosition: () => (_trackedIcao === icao24 ? _trackedDisplayCached() : null),
    gevVisualPosition: () => (_trackedIcao === icao24 ? _trackedDisplayCached() : null),
    getHeading: () => (_trackedIcao === icao24 ? _trackedDisplayCourse() : null),
    getPose: () => (_trackedIcao === icao24 ? _trackedPose() : null),
  };
  // Distância de enquadramento: atrás e acima, proporcional à altitude (3–30 km),
  // como o viewFrom da entidade no Cesium (ENU: x leste, y norte, z cima).
  const info = _flightData.get(icao24);
  const followRange = Math.min(Math.max((info?.altitude || 1500) * 1.1 + 2500, 3000), 30000);
  target.viewFrom = { x: 0, y: -followRange * 0.8, z: followRange * 0.55 };
  return target;
}

function _trackFlight(icao24, { origin = 'programmatic' } = {}) {
  _clearTracking(false, { origin });
  const contact = _contacts.get(icao24);
  const info = _flightData.get(icao24);
  if (!contact || !info) return;

  _trackedIcao = icao24;
  _resetTrackedDisplay();
  _trackedCourse = _displayCourse.get(icao24) ?? null;
  contact.show = false;
  _trackedTarget = _makeTrackedTarget(icao24, origin);

  if (_engine) {
    _ensureTrackedChangeListener(_engine);
    _selfTrackChange = true;
    try {
      _engine.cancelFlight?.();
      _trackedCameraFrameStop = applyTrackedCameraFrame(_engine, _trackedTarget, _trackedTarget.viewFrom) || null;
      if (_engine.trackedTarget !== _trackedTarget) _engine.track?.(_trackedTarget);
    } finally {
      _selfTrackChange = false;
    }
  }
  _requestTypeEnrichment(icao24, true);
  _requestRouteEnrichment(icao24);
  _startTrail(icao24);
  _dataDirty = true;
  _startTrackedLoop();
  if (_enabled) _fleetTick();
  _publishTrackedSelection(icao24, origin);
  console.log(`[Data:Flights] Tracking ${_contactLabel(icao24, info)} (${icao24})`);
}

/**
 * Solta o alvo. `skipEngineUntrack`: outra camada acabou de pegar a câmera —
 * limpa só o estado desta. A câmera fica onde está (sem voo de volta).
 */
function _clearTracking(skipEngineUntrack = false, { evicted = false, origin = 'programmatic' } = {}) {
  _trackedCameraFrameStop?.();
  _trackedCameraFrameStop = null;
  if (!_trackedIcao) {
    clearFocusTarget(LAYER_ID);
    return;
  }
  const clearedIcao = _trackedIcao;
  clearFocusTarget(LAYER_ID, clearedIcao);
  const contact = _contacts.get(clearedIcao);
  if (contact) contact.show = true;
  if (_trackedCourse != null) _displayCourse.set(clearedIcao, _trackedCourse);
  const target = _trackedTarget;
  _trackedIcao = null;
  _trackedTarget = null;
  if (_engine && !skipEngineUntrack && _engine.trackedTarget === target) {
    _selfTrackChange = true;
    try { _engine.track?.(null); } finally { _selfTrackChange = false; }
  }
  _stopTrackedLoop();
  _removeTrackedMarkers();
  clearTrackedSubjectContext(LAYER_ID);
  _emitAwarenessEvent('gev:awareness-subject-cleared', {
    layerId: LAYER_ID,
    id: clearedIcao,
    origin,
    reason: evicted ? 'evicted' : 'deliberate',
  });
  _resetTrackedDisplay();
  _clearTrail();
  _dataDirty = true;
  if (_enabled) _fleetTick();
}

function _militaryLayerSuppresses(icao24) {
  if (!isMilitaryLayerActive()) return false;
  if (icao24 === _trackedIcao) return false;
  if (icao24 === _pendingTrackingRestore?.id) return false;
  return true;
}

function _applyPendingTrackingRestore() {
  const pending = _pendingTrackingRestore;
  if (!pending || pending.generation !== _trackingIntentGeneration) return false;
  if (!_enabled || !_contacts.has(pending.id)) return false;
  _pendingTrackingRestore = null;
  _trackFlight(pending.id, { origin: pending.origin });
  return true;
}

function _cancelPendingTrackingRestore() {
  _trackingIntentGeneration += 1;
  _pendingTrackingRestore = null;
}

function _removeContact(icao24) {
  _contacts.delete(icao24);
  _flightData.delete(icao24);
  _positionHistory.delete(icao24);
  _displayCourse.delete(icao24);
  _missingPolls.delete(icao24);
  _detectionObjects.delete(icao24);
}

function _onMilitaryActiveChange(active) {
  if (!_engine) return;
  if (active) {
    for (const icao24 of [..._contacts.keys()]) {
      if (!isMilitaryIcao(icao24) || icao24 === _trackedIcao) continue;
      _removeContact(icao24);
    }
    _count = _contacts.size;
    _dataDirty = true;
    if (_enabled) _fleetTick();
  } else if (_enabled) {
    void flightsLayer.update(_engine).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Descritores públicos
// ---------------------------------------------------------------------------

/**
 * Descritor de uma aeronave na posição de dead reckoning (dado, não pixel).
 * `position` é o ponto neutro {lon, lat, height, x, y, z}.
 */
function _describeFlight(icao24) {
  const info = _flightData.get(icao24);
  const contact = _contacts.get(icao24);
  const basePos = _deadReckon(icao24) || contact?.position || null;
  if (!basePos) return null;
  const displayed = displayedKinematics({
    derivedSpeedMps: _drSpeedMps,
    derivedTrackDeg: _drCourseDeg,
    reportedSpeedMps: info?.velocity,
    reportedTrackDeg: info?.true_track,
  });
  const height = Number.isFinite(basePos.alt) ? basePos.alt : 0;
  return {
    icao24,
    callsign: String(info?.callsign || '').trim() || null,
    position: geoPoint(basePos.lon, basePos.lat, height),
    latitude: basePos.lat,
    longitude: basePos.lon,
    altitudeM: Number.isFinite(info?.altitude) ? info.altitude : height,
    renderAltitudeM: Number.isFinite(info?.renderAltitudeM) ? info.renderAltitudeM : height,
    onGround: info?.onGround === true,
    velocityMps: displayed.speedMps,
    track: displayed.trackDeg,
    stale: Boolean(_missingPolls.get(icao24) || _backoff),
    airline: info?.airline ?? null,
    typeName: tr3bTypeLabel(icao24, info?.typeName ?? null),
    typeCode: tr3bTypeLabel(icao24, info?.typeCode ?? null),
    registration: _toCleanText(info?.registration) || null,
    origin: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.origin.code : null,
    destination: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.destination.code : null,
    route: info?.route && _routeIsPlausible(icao24, info.route) ? {
      origin: { ...info.route.origin },
      destination: { ...info.route.destination },
    } : null,
  };
}

/**
 * Registro JSON-seguro para o motor de consultas do analista. Puro.
 * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
 *   lon: number|null, altitudeM: number|null, speedMps: number|null,
 *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
 *   military: boolean, aircraftClass: string|null, originCountry: string|null,
 *   operator: string|null, routeOrigin: string|null, routeDestination: string|null}}
 */
export function mapAnalystRecord(icao24, info, { military = false, routeOk = false } = {}) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const callsign = text(info?.callsign);
  return {
    id: callsign || text(info?.registration) || icao24,
    icao24,
    callsign,
    lat: num(info?.rawLat),
    lon: num(info?.rawLon),
    altitudeM: num(info?.altitude),
    speedMps: num(info?.velocity),
    heading: num(info?.true_track),
    verticalRateMps: num(info?.verticalRate),
    onGround: info?.onGround === true,
    military,
    aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
    originCountry: text(info?.originCountry),
    operator: text(info?.airline),
    routeOrigin: routeOk ? text(info?.route?.origin?.code) : null,
    routeDestination: routeOk ? text(info?.route?.destination?.code) : null,
  };
}

function _likelyLanded(icao24) {
  const info = _flightData.get(icao24);
  if (!info) return false;
  if (info.wasAirborne !== true) return false;
  if (info.onGround) return true;
  return Number.isFinite(info.altitude) && info.altitude < LANDED_ALT_MAX_M
    && Number.isFinite(info.velocity) && info.velocity < LANDED_SPEED_MAX_MPS;
}

// ---------------------------------------------------------------------------
// Clique e teclado
// ---------------------------------------------------------------------------

function _onKeyDown(e) {
  if (e.key === 'Escape' && _trackedIcao) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin: 'user' });
  }
}

/** Aeronave desta camada sob (x, y) px do container, ou null. */
function _pickContact(x, y) {
  if (!_engine?.pick) return null;
  let hits = [];
  try { hits = _engine.pick(x, y, { layers: _INTERACTIVE_LAYERS, radius: 3 }); } catch { hits = []; }
  for (const f of hits) {
    const icao = f?.properties?.icao;
    if (icao && (_contacts.has(icao) || icao === _trackedIcao)) return icao;
  }
  return null;
}

function _onMapClick(click, gesture) {
  if (!isTrackingSelectionGesture(gesture)) return;
  if (typeof document !== 'undefined' && document.body?.classList.contains('cockpit-mode')) return;
  const x = click?.position?.x;
  const y = click?.position?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const icao = _pickContact(x, y);
  if (icao) {
    if (icao === _trackedIcao) return;
    _cancelPendingTrackingRestore();
    _trackFlight(icao, { origin: 'user' });
    return;
  }
  // Feição de outra camada interativa (militar, navio, estação…) não é "vazio".
  const other = _host?.pickAt?.(x, y);
  if (other && other.def?.id !== LAYER_ID) return;
  if (!isTrackingClickGesture(gesture)) return;
  if (_trackedIcao) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin: 'user' });
  }
}

/** Outra camada pegou a câmera (engine.track): solta o nosso alvo sem mexer no engine. */
function _ensureTrackedChangeListener(engine) {
  if (_trackedChangeRemove || typeof engine?.on !== 'function') return;
  _trackedChangeRemove = engine.on('trackedchange', (next) => {
    if (_selfTrackChange || !_trackedIcao || next === _trackedTarget) return;
    _clearTracking(true, { origin: next?.gevSelectionOrigin || 'programmatic' });
  });
}

function _installInput(engine) {
  if (!_clickUnbind && engine && (engine.canvas || engine.container) && typeof engine.on === 'function') {
    try { _clickUnbind = bindTrackingClickGesture(engine, _onMapClick); } catch (err) { console.warn('[Data:Flights] clique', err); }
  }
  _ensureTrackedChangeListener(engine);
  if (!_moveEndRemove && typeof engine?.on === 'function') {
    _moveEndRemove = engine.on('moveend', () => {
      // Zoom mudou: reprograma o passo com o novo intervalo.
      if (_enabled && _tickTimer) {
        clearTimeout(_tickTimer);
        _tickTimer = null;
        _fleetTick();
        _scheduleTick();
      }
    });
  }
  if (typeof document !== 'undefined') document.addEventListener('keydown', _onKeyDown);
}

function _removeInput() {
  _clickUnbind?.();
  _clickUnbind = null;
  _trackedChangeRemove?.();
  _trackedChangeRemove = null;
  _moveEndRemove?.();
  _moveEndRemove = null;
  if (typeof document !== 'undefined') document.removeEventListener('keydown', _onKeyDown);
}

// ---------------------------------------------------------------------------
// Módulo do DataLayerManager
// ---------------------------------------------------------------------------

const flightsLayer = {
  id: LAYER_ID,
  name: 'Tráfego aéreo',
  category: 'Infraestrutura',
  icon: '✈️',
  source: 'OpenSky Network',
  /** @type {number} Intervalo (ms) entre polls. */
  updateInterval: 30000,
  maplibre: true,
  /** Definição MapLibre (contrato kit.js), para depuração e testes. */
  mapDef: flightsMapDef,

  /** @param {object} engine engine do app (src/maplibre/engine.js) */
  init(engine) {
    clearFocusTarget(LAYER_ID);
    _engine = engine || null;
    _host = getActiveLayerHost();
    _contacts = new Map();
    _detectionObjects = new Map();
    _flightData = new Map();
    _positionHistory = new Map();
    _displayCourse.clear();
    _missingPolls = new Map();
    _count = 0;
    _lastUpdate = null;
    _backoff = false;
    _retryAt = 0;
    _lastError = null;
    _lastStatus = null;
    _lastSource = 'OpenSky Network';
    _lastCoverage = 'worldwide upstream snapshot';
    _trackedIcao = null;
    _trackedTarget = null;
    _resetTrackedDisplay();
    _cockpitSubjectId = null;
    _cockpitContactMode = typeof document !== 'undefined' && document.body?.classList.contains('cockpit-mode') === true;
    _cockpitNearContacts = new Set();
    if (!_cockpitModeListener && typeof window !== 'undefined') {
      _cockpitModeListener = (event) => _applyCockpitState(event?.detail);
      window.addEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
    }
    _enrichAmbientBudget = _ambientBudgetKnobs().ceil;
    _enrichAmbientRefillAnchorMs = 0;
    if (!_milActiveChangeUnsub) _milActiveChangeUnsub = onMilitaryLayerActiveChange(_onMilitaryActiveChange);
    _ensureMapLayers();
    _initialized = true;
    console.log('[Data:Flights] Initialized (MapLibre)');
    return true;
  },

  async enable(engine) {
    if (engine) _engine = engine;
    if (!_initialized) this.init(_engine);
    _enabled = true;
    holdContinuousRender(LAYER_ID);
    _setCockpitContactMode(typeof document !== 'undefined' && document.body?.classList.contains('cockpit-mode'));
    _ensureMapLayers();
    _setMapVisible(true);
    _installInput(_engine);
    restoreSpriteOrderOnEnable(LAYER_ID, _engine);
    _lastFleetTickMs = 0;
    _fleetTick();
    _scheduleTick();
    _startTrackedLoop();
    // Os glifos carregam em paralelo; quando prontos, força o re-layout.
    _loadRasters()
      .then(() => {
        const map = _map();
        if (!map) return;
        for (const res of Object.keys(RASTERS)) {
          for (const tint of Object.keys(TINTS)) {
            for (const kind of ICON_KINDS) _addImageByName(map, flightImageName(res, kind, tint));
            _addImageByName(map, flightImageName(res, 'dot', tint));
          }
        }
        _dataDirty = true;
        if (_enabled) _fleetTick();
      })
      .catch((err) => console.warn('[Data:Flights] glifos', err));
    return true;
  },

  disable() {
    _abortActiveUpdates();
    _cancelPendingTrackingRestore();
    _clearTracking();
    _destroyTrail();
    _enabled = false;
    releaseContinuousRender(LAYER_ID);
    clearTimeout(_tickTimer);
    _tickTimer = null;
    _stopTrackedLoop();
    _setMapVisible(false);
    _removeInput();
    return true;
  },

  /**
   * Busca os estados (OpenSky/adsb.lol no dev, Supabase na produção) e
   * reconcilia os contatos. Mesmo tratamento de erro/backoff de antes.
   */
  async update(engine, { signal = null } = {}) {
    const nowMs = Date.now();
    const trackingRefreshEpoch = ++_trackingRefreshEpoch;
    _lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch, status: 'source-unavailable', ids: new Set(), source: _lastSource, coverage: _lastCoverage,
    };
    if (_retryAt && nowMs < _retryAt) {
      _backoff = true;
      return;
    }
    const resourceController = new AbortController();
    _activeUpdateControllers.add(resourceController);
    const updateSignal = signal ? AbortSignal.any([signal, resourceController.signal]) : resourceController.signal;
    try {
      updateSignal.throwIfAborted();
      const response = await _fetchStatesPayload(engine || _engine, updateSignal);
      _lastStatus = response.status;
      const responseSource = response.headers.get('x-flight-source');
      const responseCoverage = response.headers.get('x-flight-coverage');
      const authMode = _toLowerText(response.headers.get('x-opensky-auth-mode-used') || response.headers.get('x-opensky-auth'));
      const authReason = _toLowerText(response.headers.get('x-opensky-auth-reason'));

      if (response.status === 429) {
        console.warn('[Data:Flights] Rate limited, backing off');
        _backoff = true;
        _retryAt = nowMs + BACKOFF_INTERVAL;
        _lastError = authMode && authMode !== 'anon' ? 'OpenSky rate limited' : 'OpenSky rate limited (anonymous)';
        return;
      }
      if (response.status === 401 || response.status === 403) {
        console.warn(`[Data:Flights] OpenSky unavailable (${response.status}), backing off`);
        _backoff = true;
        _retryAt = nowMs + BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = typeof body?.error === 'string' ? body.error.trim() : '';
        } catch { detail = ''; }
        _lastError = _deriveOpenSkyAuthError({ detail, authMode, authReason });
        return;
      }
      if (!response.ok) {
        console.warn(`[Data:Flights] API returned ${response.status}`);
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = typeof body?.error === 'string' ? body.error.trim() : '';
        } catch { detail = ''; }
        _lastError = detail || `OpenSky HTTP ${response.status}`;
        return;
      }

      const data = await response.json();
      updateSignal.throwIfAborted();
      if (!data || !Array.isArray(data.states)) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed OpenSky response';
        return;
      }
      const usableStates = data.states.filter(_isUsableOpenSkyState);
      if (data.states.length > 0 && usableStates.length === 0) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed OpenSky aircraft rows';
        return;
      }

      const sourceEpochMs = Number.isFinite(Number(data.time)) && Number(data.time) > 0 ? Number(data.time) * 1000 : null;
      const sourceAgeMs = sourceEpochMs == null ? 0 : Math.max(0, Date.now() - sourceEpochMs);
      const sourceStale = sourceAgeMs > SOURCE_STALE_MS;
      _backoff = sourceStale;
      _retryAt = 0;
      _lastError = sourceStale ? `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old` : null;
      _lastSource = responseSource || 'OpenSky Network';
      _lastCoverage = responseCoverage || 'worldwide upstream snapshot';
      const currentIcaos = new Set();
      const acceptedSnapshotIcaos = new Set();
      refreshMilitaryRegistryIfStale();

      // [0] icao24, [1] callsign, [2] origin_country, [3] time_position,
      // [4] last_contact, [5] lon, [6] lat, [7] baro_altitude, [8] on_ground,
      // [9] velocity, [10] true_track, [11] vertical_rate, [12] sensors,
      // [13] geo_altitude, …, [17] categoria (extended=1)
      for (const state of usableStates) {
        const [rawIcao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, true_track, , , geo_alt] = state;
        const icao24 = _normalizeTrackedIcao(rawIcao24);
        const category = Number.isFinite(state[17]) ? state[17] : null;
        const vertical_rate = Number.isFinite(state[11]) ? state[11] : null;
        acceptedSnapshotIcaos.add(icao24);
        const onGround = on_ground === true;

        // Militar conhecido: a camada militar é dona enquanto ligada.
        if (isMilitaryIcao(icao24) && _militaryLayerSuppresses(icao24)) {
          if (_contacts.has(icao24)) _removeContact(icao24);
          continue;
        }

        currentIcaos.add(icao24);
        _missingPolls.delete(icao24);
        const prevMeta = _flightData.get(icao24);
        // `altitude` = campo de AVIAÇÃO (baro/MSL) lido por rótulos e FL.
        const alt = stickyNumber(baro_alt, prevMeta?.altitude, onGround ? 0 : 10000);
        const geoAltitudeM = Number.isFinite(geo_alt) ? geo_alt : null;
        // Altura do ponto (só dado no 2D): geo_altitude > baro > anterior > default.
        const renderAltitudeM = onGround
          ? (geoAltitudeM ?? (Number.isFinite(baro_alt) ? baro_alt : prevMeta?.renderAltitudeM ?? 0))
          : (geoAltitudeM ?? (Number.isFinite(baro_alt) ? baro_alt : (prevMeta?.renderAltitudeM ?? alt)));
        const position = { lon, lat, alt: renderAltitudeM };
        const groundFlipped = !!prevMeta && (prevMeta.onGround === true) !== onGround;
        const cat = stickyNumber(category, prevMeta?.category, null);
        const meta = {
          callsign: stickyText(callsign, prevMeta?.callsign),
          altitude: alt,
          geoAltitudeM,
          renderAltitudeM,
          onGround,
          wasAirborne: prevMeta?.wasAirborne === true || !onGround,
          velocity: stickyNumber(velocity, prevMeta?.velocity, 0),
          true_track: stickyNumber(true_track, prevMeta?.true_track, 0),
          category: cat,
          klass: classifyAircraft({ typeCode: prevMeta?.typeCode ?? null, category: cat }),
          turnRateDps: prevMeta?.turnRateDps || 0,
          verticalRate: stickyNumber(vertical_rate, prevMeta?.verticalRate, null),
          originCountry: stickyText(origin_country, prevMeta?.originCountry) || null,
          lastContactEpochMs: stickyNumber(Number.isFinite(last_contact) ? last_contact * 1000 : null, prevMeta?.lastContactEpochMs, null),
          typeCode: prevMeta?.typeCode ?? null,
          typeName: prevMeta?.typeName ?? null,
          registration: prevMeta?.registration ?? null,
          airline: prevMeta?.airline ?? null,
          route: prevMeta?.route ?? null,
          rawLat: lat,
          rawLon: lon,
        };
        _flightData.set(icao24, meta);
        const isTracked = icao24 === _trackedIcao;

        // Histórico carimbado com o instante do FIX da fonte (time_position).
        const fixEpochMs = Number.isFinite(time_position) && time_position > 0 ? time_position * 1000 : Date.now();
        if (!_positionHistory.has(icao24)) _positionHistory.set(icao24, []);
        const history = _positionHistory.get(icao24);
        const newest = history[history.length - 1];
        if (!newest || fixEpochMs > newest.epochMs) {
          history.push({ time: fixEpochMs, epochMs: fixEpochMs, position, velocity: meta.velocity, track: meta.true_track });
          if (history.length > POSITION_HISTORY_LIMIT) history.shift();
          meta.turnRateDps = turnRateFromFixHistory(history);
          if (isTracked) _appendTrailFix(position);
        } else {
          // Mesma posição com cinemática nova: só um fix sintético À FRENTE.
          const kinematicsChanged = newest.velocity !== meta.velocity || newest.track !== meta.true_track;
          if (kinematicsChanged) {
            const synthetic = synthesizeForwardKinematicsFix(newest, {
              epochMs: Date.now(), velocity: meta.velocity, track: meta.true_track, turnRateDps: meta.turnRateDps,
            });
            if (synthetic) {
              history.push(synthetic);
              if (history.length > POSITION_HISTORY_LIMIT) history.shift();
              meta.turnRateDps = turnRateFromFixHistory(history);
              if (isTracked) _appendTrailFix(synthetic.position);
            }
          }
        }

        if (!_contacts.has(icao24)) {
          _contacts.set(icao24, { position: { ...position }, show: !isTracked, course: null, alpha: 1 });
        }
        if (isTracked && groundFlipped && !meta.onGround) _startTrail(icao24);
        if (isTracked) _updateTrackedLabelModel(icao24);
      }

      // Remoção só depois de MISSING_POLL_LIMIT ausências seguidas (1 para "pousou").
      for (const icao24 of [..._contacts.keys()]) {
        if (currentIcaos.has(icao24)) continue;
        const misses = (_missingPolls.get(icao24) || 0) + 1;
        const limit = _likelyLanded(icao24) ? LANDED_MISSING_POLL_LIMIT : MISSING_POLL_LIMIT;
        if (misses < limit) {
          _missingPolls.set(icao24, misses);
          if (icao24 === _trackedIcao) _updateTrackedLabelModel(icao24);
          continue;
        }
        _missingPolls.delete(icao24);
        if (icao24 === _trackedIcao) _clearTracking(false, { evicted: true });
        _removeContact(icao24);
      }

      _sweepAmbientEnrichment();
      _count = _contacts.size;
      _lastUpdate = sourceEpochMs ?? Date.now();
      _lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch, status: 'accepted', ids: acceptedSnapshotIcaos, source: _lastSource, coverage: _lastCoverage,
      };
      _dataDirty = true;
      if (_enabled) _fleetTick();
      console.log(`[Data:Flights] Updated: ${_count} aircraft`);
      _applyPendingTrackingRestore();
    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Flights update aborted', 'AbortError');
      }
      console.warn('[Data:Flights] Fetch error:', e);
      _backoff = true;
      _retryAt = Date.now() + ERROR_BACKOFF_INTERVAL;
      _lastError = 'OpenSky network error';
    } finally {
      _activeUpdateControllers.delete(resourceController);
    }
  },

  destroy() {
    _abortActiveUpdates();
    releaseContinuousRender(LAYER_ID);
    _clearTracking();
    _destroyTrail();
    _cancelPendingTrackingRestore();
    _enabled = false;
    clearTimeout(_tickTimer);
    _tickTimer = null;
    _stopTrackedLoop();
    _removeInput();
    if (_milActiveChangeUnsub) { _milActiveChangeUnsub(); _milActiveChangeUnsub = null; }
    if (_cockpitModeListener && typeof window !== 'undefined') {
      window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
      _cockpitModeListener = null;
    }
    _setMapVisible(false);
    _setSourceData(SRC_FLEET, EMPTY_FC);
    _removeTrackedMarkers();
    _contacts.clear();
    _detectionObjects.clear();
    _flightData.clear();
    _positionHistory.clear();
    _displayCourse.clear();
    _enrichQueue.length = 0;
    _enrichSeen.clear();
    if (_enrichDripTimer) { clearTimeout(_enrichDripTimer); _enrichDripTimer = null; }
    _missingPolls.clear();
    _count = 0;
    _lastUpdate = null;
    _cockpitContactMode = false;
    _cockpitNearContacts = new Set();
    _cockpitSubjectId = null;
    _trackingRefreshEpoch += 1;
    _lastTrackingRefreshOutcome = {
      epoch: _trackingRefreshEpoch, status: 'destroyed', ids: new Set(), source: _lastSource, coverage: _lastCoverage,
    };
    _initialized = false;
    _engine = null;
    return true;
  },

  /**
   * Parâmetros vivos. `models3d`/`models3dMode` são aceitos e persistidos
   * (link `f.e`, `f.m`) mas não há modelo 3D no MapLibre: degradam para o
   * ícone. `irBoost` troca o glifo TR-3B pela variante térmica.
   * `selectedFlightsTrackingId` arma/aplica o rastreio restaurado.
   */
  setParams(params = {}, { origin = 'programmatic' } = {}) {
    if (isExplicitLayerStateOrigin(origin) && !Object.hasOwn(params, 'selectedFlightsTrackingId')) {
      _cancelPendingTrackingRestore();
    }
    if (typeof params.models3d === 'boolean') _models3dEnabled = params.models3d;
    if (params.models3dMode === 'proximity' || params.models3dMode === 'all') {
      _models3dMode = params.models3dMode;
      if (_cockpitContactMode) { _refreshCockpitNearContacts(); _dataDirty = true; }
    }
    if (typeof params.irBoost === 'boolean' && params.irBoost !== _irBoost) {
      _irBoost = params.irBoost;
      _dataDirty = true;
      if (_enabled) _fleetTick();
    }
    if (Object.hasOwn(params, 'selectedFlightsTrackingId')) {
      const requested = _normalizeTrackedIcao(params.selectedFlightsTrackingId);
      if (requested === _trackedIcao) {
        _pendingTrackingRestore = null;
      } else if (requested === null) {
        _cancelPendingTrackingRestore();
        if (_trackedIcao) _clearTracking(false, { origin });
      } else {
        const generation = ++_trackingIntentGeneration;
        _pendingTrackingRestore = { id: requested, generation, origin };
        if (_trackedIcao) _clearTracking(false, { origin });
        _applyPendingTrackingRestore();
      }
    }
    return true;
  },

  getParams() {
    return {
      models3d: _models3dEnabled,
      models3dMode: _models3dMode,
      irBoost: _irBoost,
      selectedFlightsTrackingId: _trackedIcao,
    };
  },

  /** Redesenha um contato cuja conversão TR-3B mudou (easter egg). */
  refreshTr3b(icao24) {
    const id = _normalizeTrackedIcao(icao24);
    if (!id || !_contacts.has(id)) return false;
    _dataDirty = true;
    if (_enabled) _fleetTick();
    if (id === _trackedIcao) _updateTrackedLabelModel(id);
    return true;
  },

  /**
   * Subamostra de aeronaves para a sobreposição de detecção. `position` é o
   * ponto neutro {lon, lat, height, x, y, z}.
   * @returns {Array<{position: object, id: string, sourceId: string, type: string, skipLabel: boolean, metric: string}>}
   */
  getDetectableObjects(options = {}) {
    if (!_enabled) return [];
    const maxCount = Number.isFinite(options.maxCount) ? Math.max(1, Math.floor(options.maxCount)) : _contacts.size;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(_contacts.size / maxCount));
    const start = seed % stride;
    const result = [];
    let idx = 0;
    for (const [icao24, contact] of _contacts) {
      const shouldTake = ((idx - start) % stride) === 0;
      idx++;
      if (!shouldTake) continue;
      if (_cockpitContactMode && icao24.toLowerCase() === _cockpitSubjectId) continue;
      const isTracked = icao24 === _trackedIcao;
      if (!isTracked && !contact.show) continue;
      const info = _flightData.get(icao24);
      const raw = isTracked ? (_trackedDisplayCached() || contact.position) : contact.position;
      if (!raw) continue;
      let object = _detectionObjects.get(icao24);
      if (!object) {
        object = { sourceId: icao24, type: 'AIR' };
        _detectionObjects.set(icao24, object);
      }
      object.position = geoPoint(raw.lon, raw.lat, raw.alt || 0);
      object.skipLabel = isTracked;
      const id = _contactLabel(icao24, info);
      if (object.id !== id) object.id = id;
      const altitude = info?.altitude;
      if (object._altitude !== altitude) {
        object._altitude = altitude;
        object.metric = formatFlightLevel(altitude);
      }
      result.push(object);
      if (result.length >= maxCount) break;
    }
    if (_detectionObjects.size > _contacts.size + 512) {
      for (const icao24 of _detectionObjects.keys()) if (!_contacts.has(icao24)) _detectionObjects.delete(icao24);
    }
    return result;
  },

  /** Uma aeronave por texto livre (hex, callsign, matrícula). */
  findByQuery(query) {
    if (!_flightData || _flightData.size === 0) return null;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    let best = null;
    for (const [icao24, info] of _flightData) {
      const candidate = {
        tier: rankContactMatch({ query: q, hex: icao24, callsign: info?.callsign, registration: info?.registration }),
        id: icao24,
      };
      if (!contactMatchWins(candidate, best)) continue;
      best = candidate;
      if (candidate.tier === CONTACT_MATCH_TIER.HEX_EXACT) break;
    }
    return best ? _describeFlight(best.id) : null;
  },

  /**
   * Aeronaves perto de `center` (qualquer formato: neutro, {lon,lat,height}, ECEF),
   * ordenadas pela distância em linha reta (m).
   */
  getNearby(center, range, maxCount = 50, { includeHidden = false } = {}) {
    if (!center || !_enabled) return [];
    const c = toGeoPoint(center);
    if (!c) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 50;
    const maxRange = Number.isFinite(range) && range > 0 ? range : Number.POSITIVE_INFINITY;
    const nearby = [];
    for (const [icao24, contact] of _contacts) {
      const isTracked = icao24 === _trackedIcao;
      if (!aircraftIncludedInNearby({ isTracked, billboardShown: contact.show, modelRendering: false, includeHidden })) continue;
      const raw = isTracked ? (_trackedDisplayCached() || contact.position) : contact.position;
      if (!raw) continue;
      const pos = geoPoint(raw.lon, raw.lat, raw.alt || 0);
      const distance = geoDistanceM(c, pos);
      if (!(distance <= maxRange)) continue;
      const info = _flightData.get(icao24);
      nearby.push({
        id: _contactLabel(icao24, info),
        icao24,
        callsign: info?.callsign?.trim() || null,
        position: pos,
        distance,
        aircraftClass: tr3bAircraftClass(icao24, String(info?.klass || '').trim().toLowerCase() || null),
        altitudeM: info?.altitude ?? null,
        velocityMps: info?.velocity ?? null,
        track: info?.true_track ?? null,
      });
    }
    nearby.sort((a, b) => a.distance - b.distance);
    return nearby.slice(0, limit);
  },

  /** Presença de um contato em O(1); null quando a camada está desligada/vazia. */
  hasContact(icao24) {
    if (!_enabled || _contacts.size === 0) return null;
    if (!icao24) return false;
    const id = String(icao24).trim();
    return _contacts.has(id) || _contacts.has(id.toLowerCase());
  },

  /** id/rótulo/posição de até maxCount aeronaves (posição neutra). */
  getAllPositions(maxCount = 500) {
    if (_contacts.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 500;
    const result = [];
    for (const [icao24, contact] of _contacts) {
      const p = contact.position;
      if (!p) continue;
      const info = _flightData.get(icao24);
      const routeOk = info?.route && _routeIsPlausible(icao24, info.route);
      result.push({
        id: icao24,
        label: _contactLabel(icao24, info),
        position: geoPoint(p.lon, p.lat, p.alt || 0),
        latitude: p.lat,
        longitude: p.lon,
        altitudeM: p.alt || 0,
        airline: info?.airline ?? null,
        typeName: info?.typeName ?? null,
        typeCode: info?.typeCode ?? null,
        registration: info?.registration ?? null,
        origin: routeOk ? info.route.origin.code : null,
        destination: routeOk ? info.route.destination.code : null,
      });
      if (result.length >= limit) break;
    }
    return result;
  },

  getAnalystRecords(maxCount = 2000) {
    if (!_enabled || _flightData.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const result = [];
    for (const [icao24, info] of _flightData) {
      const routeOk = !!info?.route && _routeIsPlausible(icao24, info.route);
      result.push(mapAnalystRecord(icao24, info, { military: isMilitaryIcao(icao24), routeOk }));
      if (result.length >= limit) break;
    }
    return result;
  },

  trackById(icao24, { origin = 'programmatic' } = {}) {
    if (!icao24) return false;
    let id = String(icao24).trim();
    if (!_contacts.has(id)) id = id.toLowerCase();
    if (!_contacts.has(id)) return false;
    if (_isExplicitTrackingOrigin(origin)) _cancelPendingTrackingRestore();
    if (_trackedIcao === id) return _publishTrackedSelection(id, origin);
    _trackFlight(id, { origin });
    return true;
  },

  /** Resolve um Follow compartilhado contra o último snapshot aceito. */
  async resolveTrackingRestoreTarget(icao24, { signal = null, origin = 'share-restore' } = {}) {
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const id = _normalizeTrackedIcao(icao24);
    if (!id) return { status: 'missing', reason: 'invalid-target' };
    const outcome = _lastTrackingRefreshOutcome;
    if (outcome.status !== 'accepted') {
      return {
        status: 'source-unavailable', reason: 'OpenSky snapshot unavailable',
        refreshEpoch: outcome.epoch, source: outcome.source, coverage: outcome.coverage,
      };
    }
    if (!outcome.ids.has(id)) {
      return {
        status: 'missing', reason: 'target-absent-from-snapshot',
        refreshEpoch: outcome.epoch, source: outcome.source, coverage: outcome.coverage,
      };
    }
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const followed = this.trackById(id, { origin });
    return followed
      ? { status: 'found', refreshEpoch: outcome.epoch, source: outcome.source, coverage: outcome.coverage }
      : { status: 'source-unavailable', reason: 'target-not-renderable', refreshEpoch: outcome.epoch };
  },

  /** Reaplica o enquadramento do alvo atual sem recriá-lo. */
  refocusTrackedById(icao24, { origin = 'programmatic' } = {}) {
    if (!icao24 || _cockpitContactMode || !_engine || !_trackedTarget) return false;
    let id = String(icao24).trim();
    if (!_contacts.has(id)) id = id.toLowerCase();
    if (id !== _trackedIcao) return false;
    _trackedCameraFrameStop?.();
    _selfTrackChange = true;
    try {
      _engine.cancelFlight?.();
      _trackedCameraFrameStop = applyTrackedCameraFrame(_engine, _trackedTarget, _trackedTarget.viewFrom) || null;
      if (_engine.trackedTarget !== _trackedTarget) _engine.track?.(_trackedTarget);
    } finally {
      _selfTrackChange = false;
    }
    _publishTrackedSelection(id, origin);
    return true;
  },

  stopTracking({ origin = 'programmatic' } = {}) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin });
    return true;
  },

  cancelPendingTrackingRestore() {
    _cancelPendingTrackingRestore();
  },

  /** Alvo rastreado na posição de dead reckoning (sem `position`). */
  getTrackedInfo() {
    if (!_trackedIcao) return null;
    const described = _describeFlight(_trackedIcao);
    if (!described) return null;
    const { position, ...rest } = described;
    void position;
    return rest;
  },

  /** Alvo como sujeito de Contexto: {layerId, id, label, position (neutra)}. */
  getTrackedSubject() {
    if (!_trackedIcao) return null;
    const described = _describeFlight(_trackedIcao);
    if (!described?.position) return null;
    return {
      layerId: LAYER_ID,
      id: described.icao24,
      label: described.callsign || _toCleanText(described.registration) || described.icao24,
      position: described.position,
    };
  },

  /**
   * Pose do alvo na posição EXIBIDA neste quadro, para a câmera de perseguição
   * do cockpit: {icao24, lon, lat, alt, altitudeM, heading, speedMps,
   * verticalRateMps, onGround, stale}, ou null.
   */
  getTrackedPose() {
    return _trackedPose();
  },

  /** O objeto entregue ao engine.track (ou null). */
  getTrackedTarget() {
    return _trackedTarget;
  },

  getStats() {
    const retryInSec = _retryAt ? Math.max(0, Math.ceil((_retryAt - Date.now()) / 1000)) : 0;
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      stale: _backoff,
      error: _lastError,
      status: _lastStatus,
      retryInSec,
      source: _lastSource,
      coverage: _lastCoverage,
    };
  },
};

// ---------------------------------------------------------------------------
// Pontos de teste (node --test e bancada)
// ---------------------------------------------------------------------------

/**
 * Semeia um contato (e opcionalmente o alvo) sem rede.
 * @param {{icao24: string, meta: object, position?: {lon,lat,alt}, history?: Array,
 *   tracked?: boolean, enabled?: boolean, engine?: object|null, target?: object|null,
 *   show?: boolean}} opts
 */
export function _setTrackedFlightRefreshStateForTest({
  icao24, meta, position = null, history = null, tracked = true, enabled = true, engine = null, target = undefined,
  show = undefined,
} = {}) {
  _stopTrackedLoop();
  _engine = engine;
  _enabled = enabled;
  _contacts = new Map();
  _flightData = new Map([[icao24, { ...meta }]]);
  const pos = position || { lon: meta?.rawLon ?? 0, lat: meta?.rawLat ?? 0, alt: meta?.renderAltitudeM ?? meta?.altitude ?? 0 };
  _contacts.set(icao24, { position: { ...pos }, show: show ?? !tracked, course: null, alpha: 1 });
  _positionHistory = new Map([[icao24, (history || []).map((h) => ({ ...h }))]]);
  _missingPolls = new Map();
  _backoff = false;
  _retryAt = 0;
  _resetTrackedDisplay();
  _trackedIcao = tracked ? icao24 : null;
  _trackedTarget = tracked ? (target === undefined ? _makeTrackedTarget(icao24, 'programmatic') : target) : null;
}

export function _setFlightTrackingRefreshOutcomeForTest({ status = 'accepted', ids = [], source = 'OpenSky Network', coverage = null } = {}) {
  _lastTrackingRefreshOutcome = { epoch: ++_trackingRefreshEpoch, status, ids: new Set(ids), source, coverage };
}

export function _addFlightTrackingCandidateForTest({ icao24, meta, position = null, history = [] }) {
  _flightData.set(icao24, { ...meta });
  const pos = position || { lon: meta?.rawLon ?? 0, lat: meta?.rawLat ?? 0, alt: meta?.altitude ?? 0 };
  _contacts.set(icao24, { position: { ...pos }, show: true, course: null, alpha: 1 });
  _positionHistory.set(icao24, history.map((h) => ({ ...h })));
}

export function _militaryLayerSuppressesForTest(icao24) {
  return _militaryLayerSuppresses(icao24);
}

export function _armFlightTrackingRestoreForTest(id, origin = 'share-restore') {
  const generation = ++_trackingIntentGeneration;
  _pendingTrackingRestore = id ? { id, generation, origin } : null;
}

export function _pendingFlightTrackingRestoreForTest() {
  return _pendingTrackingRestore?.id ?? null;
}

export function _applyPendingFlightTrackingRestoreForTest() {
  return _applyPendingTrackingRestore();
}

export function _deadReckonForTest(icao24, nowMs) {
  const pos = _deadReckon(icao24, nowMs);
  return pos ? { ...pos, course: _drCourseDeg, speedMps: _drSpeedMps, extrapolating: _drExtrapolating } : null;
}

export function _fleetFeaturesForTest(nowMs) {
  let captured = null;
  const prevEngine = _engine;
  const fakeMap = { getSource: () => ({ setData: (d) => { captured = d; } }) };
  _engine = { map: fakeMap, getCameraView: () => ({ lon: 0, lat: 0, alt: 1e6, zoom: 6 }), project: () => null };
  const wasEnabled = _enabled;
  _enabled = true;
  try {
    _fleetTick(nowMs);
  } finally {
    _engine = prevEngine;
    _enabled = wasEnabled;
  }
  return captured;
}

export function _trackedPresentationForTest() {
  const pos = _trackedDisplayPosition();
  return pos ? _trackedPresentation(pos) : null;
}

export function _trailPositionsForTest() {
  return _trailPositions.map((p) => ({ ...p }));
}

export function _tooltipHtmlForTest(icao24) {
  return _tooltipHtml({ icao: icao24 });
}

export default flightsLayer;
