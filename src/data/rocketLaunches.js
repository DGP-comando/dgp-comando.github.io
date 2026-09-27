import {
  findSatelliteOrbitTrackInTle,
  getSatelliteOrbitTrack,
  orbitFrameLongitudeShiftDeg,
} from './satellites.js';
import {
  WGS84_A,
  add,
  boundingSphereFromPoints,
  boundingSphereUnion,
  cartesianFromDegrees,
  clamp,
  clone,
  cross,
  destination,
  distance,
  dot,
  geodeticFromCartesian,
  initialBearing,
  interpolateGreatCircle,
  lerp,
  lerpVec,
  magnitude,
  magnitudeSquared,
  mod,
  negativePiToPi,
  normalize,
  pathToLonLat,
  scale,
  sub,
  surfaceDistance,
  toDegrees,
  toRadians,
  vec,
  zeroToTwoPi,
} from './spaceGeo.js';
import { defineLayer, EMPTY_FC, esc, fc, row, TEXT_FONT_BOLD } from '../maplibre/kit.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';

/**
 * Space Missions (30d) — lançamentos recentes (Launch Library 2 via
 * /api/launches), com a trajetória de subida reconstruída, a órbita (do
 * satélite casado no catálogo do CelesTrak ou estimada), estágios/recuperação e
 * o replay animado da subida, desenhados no MapLibre.
 *
 * NO MAPLIBRE (migração do Cesium)
 * --------------------------------
 * - A geometria (subida reconstruída "RECONSTRUCTED ESTIMATE", anel orbital,
 *   reentrada de estágios) continua calculada em ECEF, agora com objetos
 *   {x, y, z} simples (src/data/spaceGeo.js) no lugar de Cesium.Cartesian3; as
 *   funções puras exportadas mantêm nomes e semântica (ângulos em radianos como
 *   antes; posições {x,y,z}; esferas {center, radius}).
 * - O desenho é no chão: pontos de lançamento, linhas (traço no solo da subida,
 *   da órbita e das trajetórias de recuperação), posição viva do satélite e
 *   rótulos são fontes GeoJSON/symbol layers. Anéis de satélites reais são
 *   realinhados ao GMST a cada segundo (deslocamento de longitude, igual à
 *   camada Satellites); anéis estimados ficam fixos, como no app Cesium.
 * - Rótulos: saem do anfitrião worldOverlay e viram symbol layers desta camada.
 *   As fábricas de entrada (createRocketMission*OverlayEntry) continuam
 *   exportadas e são a fonte do texto dos rótulos.
 * - Câmera: voos por engine.flyToCamera/flyToTarget; o replay segue o ponto
 *   subsatélite do veículo com engine.setCameraView a cada quadro (rumo de
 *   perseguição, alcance e inclinação de replayCameraView). A âncora de zoom
 *   que o Cesium prendia no local de lançamento (camera.lookAt) não existe no
 *   MapLibre: depois de focar a missão, a câmera fica livre.
 * - A zona de 500 m do pad é um polígono no chão, visível só de perto (mesma
 *   regra de launchPadZoneVisible).
 *
 * API PÚBLICA mantida: default export (módulo do DataLayerManager com
 * attachDataManager e releaseCameraOwnership) e as funções puras testadas.
 * missionMarkerColor agora devolve a cor CSS ('#rrggbb') em vez de Cesium.Color.
 */

const WINDOW_DAYS = 30;
const API_URL = '/api/launches';
const LAYER_ID = 'rocket-launches';

export const ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID = 'rocket-missions';
export const ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID = 'rocket-mission-selected';
export const ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT = 48;
export const ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY = 24;
export const ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 12,
  collisionCapacity: 0,
  moving: true,
  solveIntervalMs: 0,
});

let _engine = null;
let _host = null;
let _count = 0;
let _lastUpdate = null;
let _lastError = null;
let _orbitMatches = 0;
let _dataManager = null;
let _retryTimer = null;
let _postTleRetryCount = 0;
let _updatePromise = null;
let _updatePromiseToken = 0;
let _updateDirty = false;
let _lifecycleToken = 0;
let _enabled = false;
let _selectedLaunchId = null;
let _explicitSelection = false;
let _launches = [];
let _missionPanel = null;
let _missionRoster = null;
let _missionRosterHoverTimer = null;
let _hoveredRosterLaunchId = null;
let _replayVehicleOverlay = null;
let _replayVehicleOverlayText = '';
const _animationStarts = new Map();
const _satelliteTelemetry = new Map();
let _lastPanelTelemetryMs = 0;
let _activeTleText = null;
let _activeTlePromise = null;
let _activeTlePromiseToken = 0;
let _renderedTleText = null;
let _focusAfterActiveLookup = false;
let _satelliteStateBeforeMission = null;
let _satelliteActivationPromise = null;
let _replayRaf = null;
let _replayCameraLaunchId = null;
let _replayCameraToken = 0;
let _replayPaused = false;
let _replayPausedAtMs = null;
let _replaySpeed = 1;
const _replayTracks = new Map();
/** launchId → registro montado por buildMissionRecord (geometria + rótulos). */
const _missionRecords = new Map();
let _slowTimer = null;
let _engineListeners = [];
let _padZoneLaunchId = null;

const REPLAY_ASCENT_FALLBACK_SEC = 12;
const REPLAY_ASCENT_MIN_SEC = 8;
const REPLAY_ASCENT_MAX_SEC = 36;
const REPLAY_ORBIT_DURATION_SEC = 28;
const REPLAY_COUNTDOWN_DURATION_SEC = 10;
const REPLAY_TILE_SETTLE_DELAY_SEC = 5;
const REPLAY_INITIAL_RANGE_M = 3500;
const REPLAY_LOCAL_MAX_RANGE_M = 900000;
const REPLAY_CONTEXT_MAX_RANGE_M = 2400000;
const REPLAY_CONTEXT_ALTITUDE_END_M = 420000;
const REPLAY_ORBIT_GLOBE_RANGE_M = 18000000;
const REPLAY_ORBIT_PULLBACK_FRACTION = 0.2;
const REPLAY_ASCENT_CAMERA_OFFSET_RAD = toRadians(30);
const REPLAY_ORBIT_CAMERA_OFFSET_RAD = toRadians(45);
const REPLAY_ORBIT_FRAME_CENTER_BLEND = 0.45;
const REPLAY_SPEED_MIN = 0.25;
const REPLAY_SPEED_MAX = 4;
const REPLAY_SPEED_STEP = 0.25;
const MAX_POST_TLE_RETRIES = 1;
const POST_TLE_RETRY_DELAY_MS = 1500;
const SLOW_TICK_MS = 500;
const EARTH_ROTATION_RAD_PER_SEC = (2 * Math.PI) / 86164.0905;
const PROJECTED_ASCENT_ROTATION_SEC = 600;
const STAGE_REENTRY_ALTITUDE_M = 100000;
const MISSION_CLOSE_VIEW_RANGE_M = 180000;
const MISSION_GLOBE_VIEW_RANGE_M = 5000000;
const MISSION_FOCUS_RANGE_M = 12000;
const SATELLITE_STANDALONE_DEFAULTS = {
  catalog: 'core',
  showPoints: true,
  showOrbits: true,
};

/**
 * Derive the temporary Satellite display mode required by Space Missions.
 * @param {object|null} currentParams Complete pre-mission Satellite parameters.
 * @returns {object} Temporary mission-specific Satellite parameters.
 */
export function satelliteParamsForSpaceMissions(currentParams) {
  return {
    ...SATELLITE_STANDALONE_DEFAULTS,
    ...(currentParams || {}),
    catalog: 'dense',
    showPoints: false,
    showOrbits: false,
  };
}

/**
 * Resolve the complete Satellite parameter set restored after mission mode.
 * @param {object|null} snapshot Complete pre-mission Satellite parameters.
 * @returns {object} Standalone Satellite parameters.
 */
export function satelliteParamsAfterSpaceMissions(snapshot) {
  return {
    ...SATELLITE_STANDALONE_DEFAULTS,
    ...(snapshot || {}),
  };
}

/**
 * Failed launch records may retain a planned orbit in Launch Library, but
 * must not be represented as a live or estimated payload in orbit.
 * @param {string|null} status Normalized Launch Library status name.
 * @returns {boolean} Whether orbital visualization is allowed.
 */
export function launchStatusAllowsOrbit(status) {
  return !/\b(?:fail(?:ed|ure)?|partial failure)\b/i.test(String(status || ''));
}

/**
 * Describe only the mission paths that the selected record can actually show.
 * Launch Library may retain a target orbit after a failure, but that target is
 * not evidence of orbital insertion and cannot support a reconstructed replay.
 * @param {object|null} launch Normalized launch record.
 * @param {boolean} replayAvailable Whether a rendered ascent/orbit track exists.
 * @returns {{orbit: string|null, ascent: string, replayAvailable: boolean}}
 */
export function missionPathPresentation(launch, replayAvailable = false) {
  const orbitName = launch?.orbit?.name || (typeof launch?.orbit === 'string' ? launch.orbit : null);
  const orbitAllowed = launchStatusAllowsOrbit(launch?.status);
  const suppliedTrajectoryPoints = Array.isArray(launch?.trajectory)
    ? launch.trajectory.filter((point) => (
      Number.isFinite(Number(point?.latitude))
      && Number.isFinite(Number(point?.longitude))
    )).length
    : 0;
  return {
    orbit: orbitName ? `${orbitAllowed ? '' : 'PLANNED · '}${orbitName}` : null,
    ascent: suppliedTrajectoryPoints > 1
      ? 'SUPPLIED TRAJECTORY POINTS'
      : replayAvailable ? 'RECONSTRUCTED ESTIMATE' : 'UNAVAILABLE',
    replayAvailable: Boolean(replayAvailable),
  };
}

/**
 * Decide whether one bounded rebuild is needed after the active TLE lookup.
 * @param {object} input Retry state.
 * @returns {boolean} Whether to schedule a refresh.
 */
export function shouldRetryAfterActiveTle({
  enabled,
  retryCount,
  activeTleText,
  renderedTleText,
}) {
  return Boolean(
    enabled
    && activeTleText
    && activeTleText !== renderedTleText
    && retryCount < MAX_POST_TLE_RETRIES,
  );
}

/**
 * Release aircraft follow state through each owning flight layer before a
 * mission replay takes over the camera.
 * @param {object|null} dataManager DataLayerManager instance.
 * @returns {number} Number of owner APIs invoked.
 */
export function releaseAircraftTracking(dataManager) {
  let released = 0;
  for (const layerId of ['flights', 'military']) {
    const module = dataManager?.layers?.get(layerId)?.module;
    if (typeof module?.stopTracking !== 'function') continue;
    module.stopTracking();
    released++;
  }
  return released;
}

export const LAUNCH_PAD_ZONE_RADIUS_M = 500;
const LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M = 120000;
const LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M = 180000;

const TRAJECTORY_STAGE_COLORS = [
  '#ff9f43', '#ff66c4', '#a78bfa', '#7bed9f', '#ffd166', '#60a5fa',
];

const _pathDistanceCache = new WeakMap();

/**
 * Decide whether the selected launch-pad zone belongs in the current view.
 * Both altitude and direct camera range are bounded so an oblique close-up can
 * show the effect without leaking it into regional or globe views.
 * @param {object} input Visibility inputs.
 * @returns {boolean}
 */
export function launchPadZoneVisible({
  layerActive,
  selectedLaunchId,
  launchId,
  cameraHeightM,
  cameraDistanceM,
}) {
  return Boolean(
    layerActive
    && selectedLaunchId
    && selectedLaunchId === launchId
    && Number.isFinite(cameraHeightM)
    && cameraHeightM <= LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M
    && Number.isFinite(cameraDistanceM)
    && cameraDistanceM <= LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M,
  );
}

/**
 * Resolve whether a surface mission anchor is safely on the camera-facing
 * side of Earth. The small positive limb margin prevents labels anchored just
 * beyond the horizon from leaking through.
 * @param {{x:number,y:number,z:number}} cameraPosition Camera world (ECEF) position.
 * @param {{x:number,y:number,z:number}} markerPosition Mission anchor world position.
 * @param {number} [limbMargin] Additional normalized horizon clearance.
 * @returns {boolean} Whether the marker belongs on the visible hemisphere.
 */
export function missionAnchorHorizonVisible(cameraPosition, markerPosition, limbMargin = 0.012) {
  if (!cameraPosition || !markerPosition) return false;
  const cameraMagnitude = magnitude(cameraPosition);
  if (!Number.isFinite(cameraMagnitude) || cameraMagnitude <= WGS84_A) return false;
  const limbThreshold = WGS84_A / cameraMagnitude;
  return dot(normalize(cameraPosition), normalize(markerPosition)) > limbThreshold + limbMargin;
}

/**
 * Resolve launch-anchor visibility for overview and selected-mission views.
 * @param {{x,y,z}} cameraPosition Camera world position.
 * @param {{x,y,z}} markerPosition Mission anchor world position.
 * @param {string} markerId Mission represented by this anchor.
 * @param {string|null} selectedLaunchId Explicitly selected mission.
 * @returns {boolean} Whether the launch anchor should render.
 */
export function missionAnchorVisible(
  cameraPosition,
  markerPosition,
  markerId,
  selectedLaunchId = null,
) {
  if (selectedLaunchId && markerId !== selectedLaunchId) return false;
  return missionAnchorHorizonVisible(cameraPosition, markerPosition);
}

function shortMissionLabel(name, maxLength = 24) {
  const text = String(name || 'Unnamed mission').replace(/\s+/g, ' ').trim().split(' | ')[0];
  const compact = text.split(' — ')[0].trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1).trimEnd()}…` : compact;
}

/**
 * Reduce generic launch-complex names to their identifying pad or area suffix.
 * @param {string|null} launchSite Launch Library pad name.
 * @returns {string|null} Compact launch-site identifier.
 */
export function compactLaunchSiteName(launchSite) {
  const text = String(launchSite || '').replace(/\s+/g, ' ').trim();
  if (!text || /^(unknown|unavailable|n\/a)$/i.test(text)) return null;
  const genericPrefix = /^(?:orbital\s+launch\s+pad|space\s+launch\s+complex|launch\s+(?:area|complex|pad|site))\s*[-·:]?\s*/i;
  const compact = text.replace(genericPrefix, '').trim();
  return compact || null;
}

/**
 * Build the source-owned launch-site marker presentation. Overview markers
 * compete in the bounded ambient-label domain; the selected mission gains the
 * launch-site detail line. In the MapLibre layer this is the source of the
 * marker's label text (title + details).
 * @param {object} launch Normalized Launch Library mission.
 * @param {*} position Display position (kept opaque).
 * @param {boolean} [selected=false] Whether the mission owns the selected view.
 * @returns {object}
 */
export function createRocketMissionMarkerOverlayEntry(launch, position, selected = false) {
  const mission = shortMissionLabel(launch?.name, 26).toUpperCase();
  const siteName = compactLaunchSiteName(launch?.launchSite);
  const launchTimeMs = Date.parse(launch?.launchTime);
  const details = selected
    ? [siteName
      ? `LAUNCH SITE · ${shortMissionLabel(siteName, 20).toUpperCase()}`
      : 'LAUNCH SITE']
    : [];
  return {
    id: `launch:${launch?.id}`,
    position,
    variant: 'label',
    title: mission,
    details,
    accent: '#22e6e6',
    priority: selected
      ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(launchTimeMs) ? Math.floor(launchTimeMs / 1000) : 0,
    selected,
    protected: selected,
    paintLane: selected ? 'selected' : 'ambient-label',
    collisionGroup: 'ambient-label',
    interactive: false,
    distanceScale: {
      near: 1000,
      nearValue: 1.08,
      far: 20_000_000,
      farValue: 0.78,
    },
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Build one protected label belonging to the selected mission's trajectory,
 * live payload position, or orbit. Newline semantics become detail rows.
 * @param {object} input
 * @returns {object}
 */
export function createRocketMissionElementOverlayEntry({
  id,
  position,
  text,
  accent,
  priority = 0,
  gapPx = 8,
}) {
  const [title, ...details] = String(text || '').split('\n');
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    details,
    accent,
    priority,
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-label',
    interactive: false,
    gapPx,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/** Keep the newest ambient mission markers with stable identity tie-breaking. */
export function selectRocketMissionMarkerOverlayCohort(
  entries,
  limit = ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.min(
    ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

/**
 * Resolve the one permitted screen-space replay overlay state.
 * @returns {'countdown'|'ascent'|'orbit'|null}
 */
export function replayOverlayMode({
  replayActive,
  ascending,
  countdownActive,
  preCountdownActive = false,
}) {
  if (!replayActive) return null;
  if (preCountdownActive) return null;
  if (countdownActive) return 'countdown';
  return ascending ? 'ascent' : 'orbit';
}

/**
 * Rotate an upright screen-space rocket so its nose follows a projected path.
 * @param {{x: number, y: number}} from Current screen point.
 * @param {{x: number, y: number}} to Forward screen point.
 * @returns {number} Clockwise CSS rotation in radians.
 */
export function replayVehicleScreenRotation(from, to) {
  const dx = Number(to?.x) - Number(from?.x);
  const dy = Number(to?.y) - Number(from?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.01) return 0;
  return Math.atan2(dx, -dy);
}

/**
 * Reduce small screen-space reprojection jitter without allowing the marker
 * to lag behind a camera jump or a phase transition.
 * @returns {{x:number,y:number}}
 */
export function smoothReplayWindowPosition(
  previous,
  next,
  alpha = 0.55,
  snapDistance = 24,
) {
  if (!previous || !next) return next;
  const dist = Math.hypot(next.x - previous.x, next.y - previous.y);
  if (!Number.isFinite(dist) || dist > snapDistance) return next;
  const amount = clamp(Number(alpha) || 0, 0, 1);
  return {
    x: lerp(previous.x, next.x, amount),
    y: lerp(previous.y, next.y, amount),
  };
}

function replayOverlayHost() {
  return _engine?.container
    || (typeof document !== 'undefined' ? document.getElementById?.('map') || document.body : null);
}

function createReplayVehicleOverlay() {
  if (_replayVehicleOverlay || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const host = replayOverlayHost();
  if (!host) return;
  _replayVehicleOverlay = document.createElement('div');
  _replayVehicleOverlay.className = 'mission-replay-vehicle-overlay';
  _replayVehicleOverlay.hidden = true;
  _replayVehicleOverlay.setAttribute('aria-hidden', 'true');
  _replayVehicleOverlay.innerHTML = `
    <div class="mission-replay-flight-symbol">
      <svg class="mission-replay-rocket" viewBox="0 0 48 72" aria-hidden="true">
        <path class="mission-replay-rocket-body" d="M24 5C16 14 14 27 15 45L9 54L18 51L24 58L30 51L39 54L33 45C34 27 32 14 24 5Z"></path>
        <circle class="mission-replay-rocket-port" cx="24" cy="29" r="3.4"></circle>
      </svg>
      <svg class="mission-replay-thrust" viewBox="0 0 72 72" aria-hidden="true">
        <ellipse style="--thrust-index:0" cx="36" cy="7" rx="5" ry="1.8"></ellipse>
        <ellipse style="--thrust-index:1" cx="36" cy="15" rx="8" ry="2.4"></ellipse>
        <ellipse style="--thrust-index:2" cx="36" cy="24" rx="11" ry="3"></ellipse>
        <ellipse style="--thrust-index:3" cx="36" cy="35" rx="15" ry="3.8"></ellipse>
        <ellipse style="--thrust-index:4" cx="36" cy="48" rx="20" ry="4.7"></ellipse>
        <ellipse style="--thrust-index:5" cx="36" cy="63" rx="26" ry="5.8"></ellipse>
      </svg>
    </div>
    <div class="mission-replay-orbit-dot" aria-hidden="true"></div>
    <div class="mission-replay-overlay-callout">
      <strong data-replay-overlay-title></strong>
      <span data-replay-overlay-detail></span>
    </div>`;
  host.appendChild(_replayVehicleOverlay);
}

function hideReplayVehicleOverlay() {
  if (!_replayVehicleOverlay) return;
  _replayVehicleOverlay.hidden = true;
  _replayVehicleOverlay.classList.remove('is-thrusting', 'is-paused');
}

function destroyReplayVehicleOverlay() {
  _replayVehicleOverlay?.remove();
  _replayVehicleOverlay = null;
  _replayVehicleOverlayText = '';
}

/**
 * Score the amount of useful mission context available for roster triage.
 * @param {object} launch Normalized launch record.
 * @returns {number} Completeness score.
 */
export function missionDataCompleteness(launch = {}) {
  let score = 0;
  const present = (value) => value !== null && value !== undefined && value !== '';
  score += present(launch.provider) ? 1 : 0;
  score += present(launch.mission) ? 2 : 0;
  score += present(launch.missionName) ? 1 : 0;
  score += present(launch.orbit?.name || launch.orbit) ? 2 : 0;
  score += Array.isArray(launch.payloads) ? Math.min(launch.payloads.length, 5) * 2 : 0;
  score += Array.isArray(launch.recoveryStages) ? Math.min(launch.recoveryStages.length, 4) * 2 : 0;
  score += Array.isArray(launch.trajectory) ? Math.min(launch.trajectory.length, 12) : 0;
  score += Array.isArray(launch.timeline) ? Math.min(launch.timeline.length, 6) : 0;
  return score;
}

/**
 * Build a data-rich roster while preserving the source-array index
 * used by mission selection and Previous/Next navigation.
 * @param {Array<object>} launches Normalized launch records.
 * @returns {Array<{launch: object, index: number}>}
 */
export function missionRosterEntries(launches) {
  return (launches || [])
    .map((launch, index) => ({ launch, index }))
    .sort((a, b) => {
      const completeness = missionDataCompleteness(b.launch) - missionDataCompleteness(a.launch);
      if (completeness !== 0) return completeness;
      const aTime = Date.parse(a.launch?.launchTime);
      const bTime = Date.parse(b.launch?.launchTime);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
      return b.index - a.index;
    });
}

/**
 * Preserve the user's globe scale for roster previews while avoiding an
 * accidental surface-level fly-to when the list is opened from a close view.
 * @param {number} cameraHeight Current camera height above the ellipsoid.
 * @returns {number} Preview range in metres.
 */
export function missionHoverPreviewRange(cameraHeight) {
  const height = Number(cameraHeight);
  return Math.max(
    MISSION_CLOSE_VIEW_RANGE_M,
    Number.isFinite(height) ? height : MISSION_GLOBE_VIEW_RANGE_M,
  );
}

/**
 * Format a mission epoch for compact on-globe replay labels.
 * @param {string|Date|null} launchTime ISO-8601 mission time or Date.
 * @returns {string} UTC timestamp or a clear unavailable state.
 */
export function formatMissionEventTime(launchTime) {
  const date = new Date(launchTime);
  if (!launchTime || !Number.isFinite(date.getTime())) return 'UNAVAILABLE';
  return `${date.toISOString().slice(0, 10)}\n${date.toISOString().slice(11, 19)} UTC`;
}

/**
 * Parse the ISO-8601 durations supplied by Launch Library timeline events.
 * @param {string|null} value ISO duration such as PT8M40S or -PT35M.
 * @returns {number|null} Signed duration in seconds.
 */
export function parseMissionDurationSeconds(value) {
  const match = String(value || '').trim().match(
    /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return null;
  const seconds = (Number(match[2] || 0) * 86400)
    + (Number(match[3] || 0) * 3600)
    + (Number(match[4] || 0) * 60)
    + Number(match[5] || 0);
  return match[1] ? -seconds : seconds;
}

function orbitInsertionOffsetSeconds(launch) {
  const events = (launch.timeline || []).filter((event) => Number.isFinite(event.offsetSeconds) && event.offsetSeconds >= 0);
  if (!events.length) return null;
  const deployment = events.filter((event) => /deploy|payload separation|spacecraft separation|orbit insertion|injection/i.test(event.name));
  if (deployment.length) return Math.max(...deployment.map((event) => event.offsetSeconds));
  const engineCutoff = events.filter((event) => /seco|second engine cutoff/i.test(event.name));
  if (engineCutoff.length) return Math.max(...engineCutoff.map((event) => event.offsetSeconds));
  return Math.max(...events.map((event) => event.offsetSeconds));
}

function estimatedOrbitPeriodSeconds(orbitPath) {
  if (!orbitPath?.length) return 5400;
  const meanRadius = orbitPath.reduce((total, point) => total + magnitude(point), 0) / orbitPath.length;
  return 2 * Math.PI * Math.sqrt((meanRadius ** 3) / 3.986004418e14);
}

/**
 * Derive a compressed but mission-specific ascent replay duration.
 * Launch Library timelines are authoritative when they expose insertion,
 * SECO, or separation timing. Sparse records fall back to the reconstructed
 * path length and a conservative ascent velocity estimate.
 * @param {object} launch Normalized launch record.
 * @param {Array<{x,y,z}>} ascentPath Reconstructed or supplied ascent.
 * @returns {number} Replay duration in seconds.
 */
export function replayAscentDurationSeconds(launch, ascentPath = []) {
  const disclosedSeconds = orbitInsertionOffsetSeconds(launch);
  let realAscentSeconds = disclosedSeconds > 0 ? disclosedSeconds : null;
  if (!realAscentSeconds && ascentPath.length > 1) {
    const pathLength = ascentPath.slice(1).reduce(
      (total, point, index) => total + distance(ascentPath[index], point),
      0,
    );
    realAscentSeconds = Math.max(180, pathLength / 9000);
  }
  if (!realAscentSeconds) realAscentSeconds = REPLAY_ASCENT_FALLBACK_SEC * 50;
  return clamp(
    REPLAY_ASCENT_FALLBACK_SEC * (realAscentSeconds / 600),
    REPLAY_ASCENT_MIN_SEC,
    REPLAY_ASCENT_MAX_SEC,
  );
}

/**
 * Clamp and snap a replay speed multiplier to the supported slider range.
 * @param {number|string} value Requested playback multiplier.
 * @returns {number} Supported multiplier between 0.25x and 4x.
 */
export function normalizeReplaySpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const clamped = clamp(numeric, REPLAY_SPEED_MIN, REPLAY_SPEED_MAX);
  return Math.round(clamped / REPLAY_SPEED_STEP) * REPLAY_SPEED_STEP;
}

/**
 * Preserve replay elapsed time when resuming after a pause.
 * @returns {number} Shifted start epoch.
 */
export function replayStartAfterPause(startedAt, pausedAt, resumedAt) {
  if (![startedAt, pausedAt, resumedAt].every(Number.isFinite)) return startedAt;
  return startedAt + Math.max(0, resumedAt - pausedAt);
}

export function replayState(
  launch,
  startedAt,
  ascentDurationSec,
  orbitDurationSec,
  orbitPeriodSec,
  speed = 1,
  nowMs = Date.now(),
  preCountdownDurationSec = 0,
  loop = true,
) {
  const animationDurationSec = ascentDurationSec + orbitDurationSec;
  const realSecondsSinceStart = (nowMs - startedAt) / 1000;
  const preCountdownDuration = Math.max(0, Number(preCountdownDurationSec) || 0);
  const preCountdownActive = preCountdownDuration > 0
    && realSecondsSinceStart < -preCountdownDuration;
  const countdownActive = realSecondsSinceStart < 0 && !preCountdownActive;
  const countdownSeconds = countdownActive ? Math.ceil(-realSecondsSinceStart) : 0;
  const elapsedSinceStart = Math.max(0, realSecondsSinceStart * normalizeReplaySpeed(speed));
  const elapsed = loop
    ? elapsedSinceStart % animationDurationSec
    : Math.min(elapsedSinceStart, Math.max(0, animationDurationSec - 1e-6));
  const insertionOffsetSec = orbitInsertionOffsetSeconds(launch);
  const ascending = elapsed < ascentDurationSec;
  const phaseProgress = ascending
    ? elapsed / ascentDurationSec
    : (elapsed - ascentDurationSec) / orbitDurationSec;
  const missionOffsetSec = insertionOffsetSec === null
    ? null
    : ascending
      ? phaseProgress * insertionOffsetSec
      : insertionOffsetSec + phaseProgress * orbitPeriodSec;
  const launchEpoch = Date.parse(launch.launchTime);
  const eventTime = Number.isFinite(launchEpoch) && missionOffsetSec !== null
    ? new Date(launchEpoch + missionOffsetSec * 1000)
    : null;
  return {
    ascending,
    phaseProgress,
    eventTime,
    elapsedSinceStart,
    countdownActive,
    preCountdownActive,
    countdownSeconds,
  };
}

/**
 * Estimated mission orbit (ECEF ring, 97 samples) for launches without a
 * catalog match: a planar circle offset downrange from the pad.
 * @param {object} launch Normalized launch record.
 * @returns {Array<{x,y,z}>|null}
 */
export function approximateOrbitPath(launch) {
  if (!launch.orbit?.name || !Number.isFinite(launch.lat) || !Number.isFinite(launch.lon)) return null;
  const orbitName = launch.orbit.name.toLowerCase();
  const altitude = orbitName.includes('geostationary') || orbitName.includes('transfer') ? 35786000
    : orbitName.includes('medium') ? 20200000 : 550000;
  const radius = WGS84_A + altitude;
  const longitude = toRadians(launch.lon);
  const latitude = toRadians(launch.lat);
  const up = vec(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
  const east = vec(-Math.sin(longitude), Math.cos(longitude), 0);
  const north = vec(
    -Math.sin(latitude) * Math.cos(longitude),
    -Math.sin(latitude) * Math.sin(longitude),
    Math.cos(latitude),
  );
  const isPolar = orbitName.includes('polar') || orbitName.includes('sun');
  const isWesternNorthAmerica = launch.lat > 20 && launch.lat < 60
    && launch.lon > -140 && launch.lon < -105;
  const launchAzimuthDeg = isPolar
    ? (launch.lat >= 0 ? 180 : 0)
    : isWesternNorthAmerica ? 190 : 90;
  const launchAzimuth = toRadians(launchAzimuthDeg);
  const forward = normalize(add(scale(north, Math.cos(launchAzimuth)), scale(east, Math.sin(launchAzimuth))));
  // A reconstructed orbit is an estimate, not a claim that the vehicle was
  // inserted directly above the pad. Offset the orbital plane downrange by a
  // small launch-to-insertion arc.
  const insertionArc = toRadians(isPolar ? 8 : 12);
  const orbitAnchor = normalize(add(scale(up, Math.cos(insertionArc)), scale(forward, Math.sin(insertionArc))));
  const planeNormal = normalize(cross(orbitAnchor, forward));
  const crossTrack = normalize(cross(planeNormal, orbitAnchor));
  return Array.from({ length: 97 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return vec(
      radius * (Math.cos(angle) * orbitAnchor.x + Math.sin(angle) * crossTrack.x),
      radius * (Math.cos(angle) * orbitAnchor.y + Math.sin(angle) * crossTrack.y),
      radius * (Math.cos(angle) * orbitAnchor.z + Math.sin(angle) * crossTrack.z),
    );
  });
}

/**
 * Sample a path uniformly by distance (not vertex count).
 * @param {Array<{x,y,z}>} path
 * @param {number} progress 0..1
 * @param {{x,y,z}} [result] Optional object written in place.
 * @returns {{x,y,z}|undefined}
 */
export function samplePath(path, progress, result) {
  if (!path?.length) return undefined;
  const writeResult = (p) => {
    if (!result) return p;
    result.x = p.x;
    result.y = p.y;
    result.z = p.z;
    return result;
  };
  // Degenerate returns clone into `result` when provided — handing back a
  // path vertex would let an in-place caller mutate the path geometry.
  if (path.length === 1) return result ? writeResult(path[0]) : path[0];
  let distances = _pathDistanceCache.get(path);
  if (!distances) {
    distances = new Float64Array(path.length);
    for (let index = 1; index < path.length; index++) {
      distances[index] = distances[index - 1] + distance(path[index - 1], path[index]);
    }
    _pathDistanceCache.set(path, distances);
  }
  const totalDistance = distances.at(-1);
  if (!(totalDistance > 0)) return result ? writeResult(path[0]) : path[0];
  const targetDistance = clamp(progress, 0, 1) * totalDistance;
  let low = 1;
  let high = distances.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (distances[middle] < targetDistance) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  const segmentDistance = distances[index + 1] - distances[index];
  const segmentProgress = segmentDistance > 0
    ? (targetDistance - distances[index]) / segmentDistance
    : 0;
  return writeResult(lerpVec(path[index], path[index + 1], segmentProgress));
}

/**
 * Resolve a continuously advancing orbit fraction from a wall-clock epoch.
 * @param {number} nowMs Wall-clock epoch in milliseconds.
 * @param {number} periodSec Orbital period in seconds.
 * @returns {number} Normalized progress in the range [0, 1).
 */
export function orbitProgressAtTime(nowMs, periodSec) {
  const period = Math.max(1, Number(periodSec) || 1);
  return mod((Number(nowMs) || 0) / 1000, period) / period;
}

/**
 * Construct one continuous estimated climb from the pad to orbit insertion.
 * Horizontal movement begins much more slowly than altitude gain, preserving
 * the near-vertical launch appearance without a hard corner at 120 km.
 * @param {{x,y,z}} launchPosition Launch-pad position.
 * @param {{x,y,z}} insertionPosition Orbit insertion position.
 * @param {number} [samples] Number of curve intervals.
 * @returns {Array<{x,y,z}>}
 */
export function reconstructedAscentPath(launchPosition, insertionPosition, samples = 512) {
  const origin = geodeticFromCartesian(launchPosition);
  const insertion = geodeticFromCartesian(insertionPosition);
  if (!origin || !insertion) return [launchPosition, insertionPosition];
  return Array.from({ length: samples + 1 }, (_, index) => {
    const progress = index / samples;
    if (index === 0) return launchPosition;
    if (index === samples) return insertionPosition;
    const horizontalProgress = progress ** 4;
    const surface = interpolateGreatCircle(origin, insertion, horizontalProgress);
    // Approximate the inertial eastward lead accumulated during a ten-minute
    // ascent. The p³ envelope keeps liftoff nearly vertical, peaks during the
    // upper climb, and returns to the fixed insertion endpoint.
    const rotationalLead = EARTH_ROTATION_RAD_PER_SEC
      * PROJECTED_ASCENT_ROTATION_SEC
      * Math.sin(Math.PI * progress ** 3);
    const lon = toDegrees(negativePiToPi(toRadians(surface.lon) + rotationalLead));
    const height = lerp(
      Math.max(0, origin.height),
      Math.max(0, insertion.height),
      Math.sin(progress * Math.PI / 2),
    );
    return cartesianFromDegrees(lon, surface.lat, height);
  });
}

function nearestOrbitIndex(orbitPath, referencePosition) {
  if (!orbitPath?.length || !referencePosition) return 0;
  const referenceDirection = normalize(referencePosition);
  let bestIndex = 0;
  let bestDot = -Number.MAX_VALUE;
  orbitPath.forEach((candidate, index) => {
    const d = dot(referenceDirection, normalize(candidate));
    if (d > bestDot) {
      bestDot = d;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function orbitPathFromInsertion(orbitPath, insertionIndex) {
  if (!orbitPath?.length) return [];
  const first = orbitPath[0];
  const last = orbitPath.at(-1);
  const isClosed = orbitPath.length > 2 && distance(first, last) < 1000;
  const core = isClosed ? orbitPath.slice(0, -1) : orbitPath.slice();
  if (!core.length) return orbitPath.slice();
  const index = mod(insertionIndex, core.length);
  const rotated = [...core.slice(index), ...core.slice(0, index)];
  rotated.push(rotated[0]);
  return rotated;
}

function surfaceSafeSegment(startPosition, endPosition) {
  const start = geodeticFromCartesian(startPosition);
  const end = geodeticFromCartesian(endPosition);
  if (!start || !end) return [startPosition, endPosition];
  // Replay advances in real time across this path. Keep the geometry
  // surface-safe, but give the animated marker and chase camera enough
  // samples that they do not visibly pause at long segment boundaries.
  const steps = clamp(Math.ceil(surfaceDistance(start, end) / 75000), 2, 256);
  const positions = [];
  for (let index = 0; index <= steps; index++) {
    const fraction = index / steps;
    const eased = fraction * fraction * (3 - 2 * fraction);
    const surface = interpolateGreatCircle(start, end, fraction);
    positions.push(cartesianFromDegrees(surface.lon, surface.lat, lerp(start.height, end.height, eased)));
  }
  positions[0] = startPosition;
  positions[positions.length - 1] = endPosition;
  return positions;
}

function surfaceSafePath(controlPositions) {
  if (!controlPositions?.length) return [];
  if (controlPositions.length === 1) return controlPositions.slice();
  const path = [];
  for (let index = 0; index < controlPositions.length - 1; index++) {
    const segment = surfaceSafeSegment(controlPositions[index], controlPositions[index + 1]);
    path.push(...(index === 0 ? segment : segment.slice(1)));
  }
  return path;
}

function blendAscentIntoOrbitTangent(ascentPath, orbitPath, insertionIndex) {
  if (!ascentPath?.length || ascentPath.length < 4 || !orbitPath?.length) return ascentPath;
  const transferEnd = orbitPath[insertionIndex];
  const nextOrbit = orbitPath[(insertionIndex + 1) % orbitPath.length];
  const tangentRaw = sub(nextOrbit, transferEnd);
  if (magnitudeSquared(tangentRaw) < 1e-16) return ascentPath;
  const orbitTangent = normalize(tangentRaw);

  // Replace a substantial final section with one cubic Bézier transition.
  // Matching both endpoint tangents avoids the short corrective hook produced
  // by locally pulling only the last few ascent samples toward the orbit.
  const blendCount = Math.min(52, ascentPath.length - 2);
  const blendStart = ascentPath.length - 1 - blendCount;
  const start = ascentPath[blendStart];
  const previous = ascentPath[Math.max(0, blendStart - 1)];
  const altitudeEnvelope = ascentPath.slice(blendStart).map((position) => Math.max(
    0,
    geodeticFromCartesian(position)?.height || 0,
  ));
  const ascentTangent = normalize(sub(start, previous));
  const chordLength = Math.max(distance(start, transferEnd), 1000);
  const handleLength = chordLength * 0.28;
  const controlA = add(start, scale(ascentTangent, handleLength));
  const controlB = add(transferEnd, scale(orbitTangent, -handleLength));
  for (let index = 0; index <= blendCount; index++) {
    const progress = index / blendCount;
    const inverse = 1 - progress;
    const point = add(
      add(scale(start, inverse ** 3), scale(controlA, 3 * inverse ** 2 * progress)),
      add(scale(controlB, 3 * inverse * progress ** 2), scale(transferEnd, progress ** 3)),
    );
    // A Cartesian Bézier is a chord in world space and can pass through the
    // ellipsoid when its orbit-tangent handle is long. Preserve the original
    // climb's smooth altitude envelope.
    const geodetic = geodeticFromCartesian(point);
    const minimumHeight = altitudeEnvelope[index] ?? 0;
    if (geodetic && geodetic.height < minimumHeight) {
      ascentPath[blendStart + index] = cartesianFromDegrees(geodetic.lon, geodetic.lat, minimumHeight);
    } else {
      ascentPath[blendStart + index] = point;
    }
  }
  ascentPath[ascentPath.length - 1] = transferEnd;
  return ascentPath;
}

/**
 * Build a globe-safe ascent ending at the nearest point on the selected orbit.
 * The returned orbit is rotated to begin at that same insertion point so the
 * animated marker cannot jump between ascent and orbital phases.
 * @param {{x,y,z}} launchPosition Launch-site position.
 * @param {Array<{x,y,z}>} trajectoryPositions Optional upstream stage fixes.
 * @param {Array<{x,y,z}>} orbitPath Selected satellite or estimated orbit.
 * @param {{x,y,z}|null} [insertionReference] Propagated or estimated insertion position.
 * @returns {{ascentPath: Array<{x,y,z}>, animatedOrbitPath: Array<{x,y,z}>, insertionIndex: number}}
 */
export function buildMissionPaths(
  launchPosition,
  trajectoryPositions,
  orbitPath,
  insertionReference = null,
) {
  const suppliedTrajectory = trajectoryPositions || [];
  const controls = [launchPosition, ...suppliedTrajectory];
  const insertionIndex = nearestOrbitIndex(
    orbitPath,
    insertionReference || controls.at(-1),
  );
  const transferEnd = orbitPath[insertionIndex];
  const ascentPath = suppliedTrajectory.length
    ? surfaceSafePath([...controls, transferEnd])
    : reconstructedAscentPath(launchPosition, transferEnd);
  blendAscentIntoOrbitTangent(ascentPath, orbitPath, insertionIndex);
  return {
    ascentPath,
    animatedOrbitPath: orbitPathFromInsertion(orbitPath, insertionIndex),
    insertionIndex,
  };
}

/** Forward path bearing (radians, 0 = north, clockwise) at `progress`. */
export function cameraHeadingForPath(path, progress, fallback = Math.PI) {
  if (!path?.length) return fallback;
  const current = geodeticFromCartesian(samplePath(path, progress));
  if (!current) return fallback;
  for (const step of [0.01, 0.025, 0.05, 0.1, 0.2]) {
    const next = geodeticFromCartesian(samplePath(path, Math.min(1, progress + step)));
    if (!next) continue;
    if (surfaceDistance(current, next) > 10) {
      // The camera sits opposite its heading (behind the vehicle), with the
      // remaining ascent receding into the scene.
      const heading = initialBearing(current, next);
      if (Number.isFinite(heading)) return zeroToTwoPi(heading);
    }
  }
  return fallback;
}

/**
 * Resolve the initial replay heading as a profile view of the path.
 * @param {Array<{x,y,z}>} path Replay path.
 * @returns {number} Heading perpendicular to the initial path direction.
 */
export function replayInitialCameraHeading(path) {
  return zeroToTwoPi(cameraHeadingForPath(path, 0, Math.PI) + Math.PI / 2);
}

/**
 * Keep ascent framing behind and slightly to one side of the vehicle, then
 * widen that rear-quarter angle as the orbit becomes visible.
 * @param {number} pathHeading Forward path bearing in radians.
 * @param {number} orbitBlend Normalized orbit-camera transition.
 * @returns {number} Camera heading (radians).
 */
export function replayChaseCameraHeading(pathHeading, orbitBlend = 0) {
  const blend = clamp(Number(orbitBlend) || 0, 0, 1);
  return zeroToTwoPi(
    pathHeading + lerp(REPLAY_ASCENT_CAMERA_OFFSET_RAD, REPLAY_ORBIT_CAMERA_OFFSET_RAD, blend),
  );
}

/**
 * Limit replay-camera yaw changes so a path heading wrap or insertion turn
 * cannot swing the chase view through the front of the vehicle.
 * @returns {number}
 */
export function smoothReplayCameraHeading(
  previous,
  desired,
  maxStepRad = toRadians(2),
) {
  if (!Number.isFinite(previous)) return zeroToTwoPi(desired);
  if (!Number.isFinite(desired)) return zeroToTwoPi(previous);
  const delta = negativePiToPi(desired - previous);
  const step = clamp(delta, -Math.abs(maxStepRad), Math.abs(maxStepRad));
  return zeroToTwoPi(previous + step);
}

/**
 * Blend from a global nadir view into an oblique local view as the user
 * approaches a selected launch site.
 * @param {number} rangeM Camera distance from the launch-site anchor.
 * @returns {number} Camera pitch in radians (-π/2 = nadir).
 */
export function missionZoomPitch(rangeM) {
  const range = Math.max(0, Number(rangeM) || 0);
  const blend = clamp(
    (Math.log(Math.max(range, MISSION_CLOSE_VIEW_RANGE_M)) - Math.log(MISSION_CLOSE_VIEW_RANGE_M))
      / (Math.log(MISSION_GLOBE_VIEW_RANGE_M) - Math.log(MISSION_CLOSE_VIEW_RANGE_M)),
    0,
    1,
  );
  return lerp(toRadians(-42), -Math.PI / 2, blend);
}

/**
 * Resolve the replay camera offset for either close ascent tracking or the
 * orbital globe pullback.
 * @param {{ascending: boolean, phaseProgress: number}} state Replay phase.
 * @param {number} altitudeM Animated vehicle altitude above the ellipsoid.
 * @returns {{range: number, pitch: number}} pitch in radians
 */
export function replayCameraView(state, altitudeM) {
  const altitude = Math.max(0, Number(altitudeM) || 0);
  const localRange = clamp(
    REPLAY_INITIAL_RANGE_M + altitude * 0.7,
    REPLAY_INITIAL_RANGE_M,
    REPLAY_LOCAL_MAX_RANGE_M,
  );
  const rawContextBlend = clamp(
    (altitude - 20000) / (REPLAY_CONTEXT_ALTITUDE_END_M - 20000),
    0,
    1,
  );
  const contextBlend = rawContextBlend * rawContextBlend * (3 - 2 * rawContextBlend);
  const contextRange = clamp(
    180000 + altitude * 3.8,
    MISSION_CLOSE_VIEW_RANGE_M,
    REPLAY_CONTEXT_MAX_RANGE_M,
  );
  const ascentRange = lerp(localRange, contextRange, contextBlend);
  const ascentPitch = lerp(toRadians(-20), toRadians(-34), contextBlend);
  if (state?.ascending) {
    return { range: ascentRange, pitch: ascentPitch };
  }
  const rawBlend = clamp(
    (Number(state?.phaseProgress) || 0) / REPLAY_ORBIT_PULLBACK_FRACTION,
    0,
    1,
  );
  const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
  return {
    range: lerp(ascentRange, REPLAY_ORBIT_GLOBE_RANGE_M, blend),
    // Keep an oblique tactical view of the complete orbit rather than ending
    // in a nadir view.
    pitch: lerp(ascentPitch, toRadians(-45), blend),
  };
}

/**
 * Move the orbit-follow target from the vehicle toward its sub-satellite
 * globe anchor, keeping Earth centered while the vehicle remains in frame.
 * @param {{x,y,z}} position Animated orbital position.
 * @param {number} orbitBlend Normalized orbit-camera transition.
 * @returns {{x,y,z}} Camera look-at target.
 */
export function replayOrbitGlobeAnchor(position, orbitBlend = 0) {
  if (!position) return position;
  const blend = clamp(Number(orbitBlend) || 0, 0, 1);
  if (blend <= 0) return clone(position);
  const geodetic = geodeticFromCartesian(position);
  if (!geodetic) return clone(position);
  const altitude = Math.max(0, geodetic.height || 0);
  return cartesianFromDegrees(geodetic.lon, geodetic.lat, lerp(altitude, altitude * 0.1, blend));
}

/**
 * Keep the orbital camera's look-at frame biased toward the moving vehicle
 * (a target at Earth's center is singular for a heading/pitch camera).
 * @returns {{x,y,z}} Stable camera look-at target.
 */
export function replayOrbitCameraTarget(vehicleAnchor, frameCenter, orbitBlend = 0) {
  if (!vehicleAnchor) return vehicleAnchor;
  if (!frameCenter) return clone(vehicleAnchor);
  const blend = clamp(Number(orbitBlend) || 0, 0, 1) * REPLAY_ORBIT_FRAME_CENTER_BLEND;
  return lerpVec(vehicleAnchor, frameCenter, blend);
}

/**
 * Build a stable orbit-relative camera pose (ECEF destination/direction/up).
 * The camera remains on one side of the orbital plane and uses the vehicle
 * radial as its visual up axis, so the forward orbit tangent always projects
 * toward screen-left. (Pure 3D math; the MapLibre replay follows the ground
 * point instead — kept for callers that frame orbits in 3D.)
 * @returns {{destination:{x,y,z}, direction:{x,y,z}, up:{x,y,z}}|null}
 */
export function replayOrbitCameraPose(
  position,
  tangentPosition,
  target,
  range,
  pitch,
) {
  if (!position || !tangentPosition || !target) return null;
  const radial = normalize(position);
  const tangentRaw = sub(tangentPosition, position);
  if (magnitudeSquared(tangentRaw) < 1) return null;
  const tangent = normalize(tangentRaw);
  const normalRaw = cross(radial, tangent);
  if (magnitudeSquared(normalRaw) < 1e-12) return null;
  const orbitNormal = normalize(normalRaw);

  const dist = Math.max(1, Number(range) || 1);
  const elevation = clamp(Math.abs(Number(pitch) || 0), toRadians(5), toRadians(80));
  const destinationPoint = add(
    add(target, scale(orbitNormal, Math.cos(elevation) * dist)),
    scale(radial, Math.sin(elevation) * dist),
  );
  const direction = normalize(sub(target, destinationPoint));
  const up = normalize(sub(radial, scale(direction, dot(radial, direction))));
  return { destination: destinationPoint, direction, up };
}

/**
 * Build one conservative frame that contains both Earth and the complete
 * selected orbit.
 * @param {Array<{x,y,z}>} orbitPath Selected orbit samples.
 * @returns {{center:{x,y,z}, radius:number}} Combined Earth/orbit frame.
 */
export function replayOrbitFrameSphere(orbitPath = []) {
  const earth = { center: vec(), radius: WGS84_A };
  if (!Array.isArray(orbitPath) || orbitPath.length < 2) return earth;
  return boundingSphereUnion(earth, boundingSphereFromPoints(orbitPath));
}

/**
 * Ensure high-altitude missions frame both the globe and selected vehicle.
 * @returns {number} Camera range in metres.
 */
export function replayOrbitGlobeRange(
  baseRange,
  altitudeM,
  orbitBlend = 0,
  frameRadiusM = 0,
) {
  const range = Math.max(0, Number(baseRange) || 0);
  const altitude = Math.max(0, Number(altitudeM) || 0);
  const frameRadius = Math.max(0, Number(frameRadiusM) || 0);
  const blend = clamp(Number(orbitBlend) || 0, 0, 1);
  const globeAndVehicleRange = Math.max(
    range,
    altitude + WGS84_A * 2.4,
    frameRadius * 3,
  );
  return lerp(range, globeAndVehicleRange, blend);
}

// ------------------------------------------------------------ câmera

/** Altura da câmera (m): a do motor, ou estimada pelo zoom. */
function cameraAltitude() {
  const view = _engine?.getCameraView?.();
  if (Number.isFinite(view?.alt)) return view.alt;
  const zoom = Number(view?.zoom);
  return Number.isFinite(zoom) ? 1.0e8 / 2 ** zoom : MISSION_GLOBE_VIEW_RANGE_M;
}

/**
 * Zoom do MapLibre em que a câmera fica a `rangeM` metros do centro da vista
 * (campo de visão vertical de 36,87°: distância câmera-centro = 1,5 × altura
 * da tela em px; metros por px = circunferência·cos(lat) / (512·2^zoom)).
 */
export function zoomForCameraRange(rangeM, latDeg, viewportHeightPx = 900) {
  const range = Math.max(1, Number(rangeM) || 1);
  const metersAtZoom0 = (1.5 * Math.max(1, viewportHeightPx) * 2 * Math.PI * WGS84_A * Math.cos(toRadians(clamp(latDeg, -85, 85)))) / 512;
  return Math.log2(metersAtZoom0 / range);
}

/** Câmera olhando para o ponto (lon, lat) no chão, de `rangeM`, com rumo e inclinação (semântica Cesium). */
function lookAtGroundPoint(lon, lat, { rangeM, headingDeg = 0, pitchDeg = -90 } = {}) {
  const map = _engine?.map;
  if (!map?.jumpTo) return;
  const height = map.getContainer?.()?.clientHeight || _engine.canvas?.clientHeight || 900;
  const minZoom = map.getMinZoom?.() ?? 0;
  map.jumpTo({
    center: [lon, lat],
    zoom: Math.max(minZoom, zoomForCameraRange(rangeM, lat, height)),
    bearing: headingDeg,
    pitch: clamp(90 + pitchDeg, 0, 85),
  });
}

function focusFullGlobe(duration = 2.4) {
  const view = _engine?.getCameraView?.();
  if (!view || typeof _engine.flyToCamera !== 'function') return;
  _engine.flyToCamera({
    lat: Number.isFinite(view.targetLat) ? view.targetLat : view.lat,
    lon: Number.isFinite(view.targetLon) ? view.targetLon : view.lon,
    alt: WGS84_A * 2.2,
    heading: view.heading || 0,
    pitch: -90,
  }, { duration });
}

function syncReplayButton() {
  const button = _missionPanel?.querySelector('[data-mission-replay]');
  const transport = _missionPanel?.querySelector('[data-mission-replay-transport]');
  const speedControl = _missionPanel?.querySelector('.mission-replay-speed-control');
  if (!button) return;
  const active = Boolean(_replayCameraLaunchId && _replayCameraLaunchId === _selectedLaunchId);
  const replayAvailable = Boolean(_selectedLaunchId && _replayTracks.has(_selectedLaunchId));
  if (speedControl) speedControl.hidden = !replayAvailable;
  button.hidden = active || !replayAvailable;
  button.disabled = !replayAvailable;
  button.textContent = 'REPLAY ASCENT';
  button.classList.remove('active');
  button.setAttribute('aria-pressed', String(active));
  button.title = 'Replay the estimated ascent with a following camera';
  if (transport) {
    transport.hidden = !active;
    transport.classList.toggle('is-paused', active && _replayPaused);
    const toggleButton = transport.querySelector('[data-mission-replay-toggle]');
    if (toggleButton) {
      toggleButton.disabled = !active;
      toggleButton.textContent = _replayPaused ? '▶' : 'Ⅱ';
      toggleButton.setAttribute('aria-label', _replayPaused ? 'Resume replay' : 'Pause replay');
      toggleButton.title = _replayPaused ? 'Resume replay' : 'Pause replay';
    }
  }
}

function syncReplayCountdownButton(state) {
  const transport = _missionPanel?.querySelector('[data-mission-replay-transport]');
  if (!transport || !_replayCameraLaunchId) return;
  const phase = state.countdownActive
    ? `T minus ${state.countdownSeconds}`
    : state.preCountdownActive
      ? 'Preparing launch site'
      : state.elapsedSinceStart < 1
        ? 'Liftoff'
        : state.ascending ? 'Ascent replay' : 'Orbit replay';
  transport.setAttribute('aria-label', `${phase}${_replayPaused ? ', paused' : ''}`);
}

function syncReplaySpeedControl() {
  const input = _missionPanel?.querySelector('[data-mission-replay-speed]');
  const output = _missionPanel?.querySelector('[data-mission-replay-speed-output]');
  if (input) {
    input.value = String(_replaySpeed);
    const progress = ((_replaySpeed - REPLAY_SPEED_MIN) / (REPLAY_SPEED_MAX - REPLAY_SPEED_MIN)) * 100;
    input.style.setProperty('--replay-speed-progress', `${progress}%`);
  }
  if (output) output.textContent = `${_replaySpeed.toFixed(_replaySpeed % 1 ? 2 : 0)}×`;
}

function setReplaySpeed(value) {
  const nextSpeed = normalizeReplaySpeed(value);
  const previousSpeed = _replaySpeed;
  if (nextSpeed === previousSpeed) {
    syncReplaySpeedControl();
    return;
  }
  const now = _replayPaused && Number.isFinite(_replayPausedAtMs)
    ? _replayPausedAtMs
    : Date.now();
  for (const [launchId, startedAt] of _animationStarts) {
    if (!Number.isFinite(startedAt)) continue;
    const elapsedMissionMs = (now - startedAt) * previousSpeed;
    _animationStarts.set(launchId, now - elapsedMissionMs / nextSpeed);
  }
  _replaySpeed = nextSpeed;
  syncReplaySpeedControl();
}

function replayClockNow(launchId) {
  if (
    _replayPaused
    && _replayCameraLaunchId === launchId
    && Number.isFinite(_replayPausedAtMs)
  ) {
    return _replayPausedAtMs;
  }
  return Date.now();
}

function pauseMissionReplay() {
  if (!_replayCameraLaunchId || _replayPaused) return false;
  _replayPausedAtMs = Date.now();
  _replayPaused = true;
  syncReplayButton();
  return true;
}

function resumeMissionReplay() {
  if (!_replayCameraLaunchId || !_replayPaused || !Number.isFinite(_replayPausedAtMs)) {
    return false;
  }
  const resumedAt = Date.now();
  const startedAt = _animationStarts.get(_replayCameraLaunchId);
  if (Number.isFinite(startedAt)) {
    _animationStarts.set(
      _replayCameraLaunchId,
      replayStartAfterPause(startedAt, _replayPausedAtMs, resumedAt),
    );
  }
  _replayPaused = false;
  _replayPausedAtMs = null;
  syncReplayButton();
  return true;
}

function stopMissionReplay() {
  const stoppedLaunchId = _replayCameraLaunchId;
  _replayCameraToken++;
  if (_replayRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_replayRaf);
  _replayRaf = null;
  if (stoppedLaunchId) _engine?.cancelFlight?.();
  _replayCameraLaunchId = null;
  _replayPaused = false;
  _replayPausedAtMs = null;
  if (stoppedLaunchId) _animationStarts.set(stoppedLaunchId, Date.now());
  hideReplayVehicleOverlay();
  syncReplayButton();
  renderMissionLayer();
}

/** Um quadro do replay: câmera de perseguição + veículo na tela. */
function replayFrame(launchId, token, track, isCameraReady) {
  _replayRaf = null;
  if (token !== _replayCameraToken || _replayCameraLaunchId !== launchId) return;
  const state = track.beginReplayFrame();
  syncReplayCountdownButton(state);
  if (isCameraReady()) {
    const path = state.ascending ? track.ascentPath : track.animatedOrbitPath;
    const position = samplePath(path, state.phaseProgress);
    const geodetic = position ? geodeticFromCartesian(position) : null;
    if (geodetic) {
      const pathHeading = cameraHeadingForPath(path, state.phaseProgress, track.lastCameraHeading);
      const orbitBlend = !state.ascending
        ? clamp((Number(state.phaseProgress) || 0) / REPLAY_ORBIT_PULLBACK_FRACTION, 0, 1)
        : 0;
      const desiredHeading = replayChaseCameraHeading(pathHeading, orbitBlend);
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const frameDurationMs = Number.isFinite(track.lastCameraUpdateMs)
        ? clamp(nowMs - track.lastCameraUpdateMs, 4, 50)
        : 1000 / 60;
      track.lastCameraUpdateMs = nowMs;
      track.lastCameraHeading = smoothReplayCameraHeading(
        track.lastCameraHeading,
        desiredHeading,
        toRadians(2) * frameDurationMs / (1000 / 60),
      );
      const altitude = Math.max(0, geodetic.height || 0);
      const cameraView = replayCameraView(state, altitude);
      const range = !state.ascending
        ? replayOrbitGlobeRange(cameraView.range, altitude, orbitBlend, track.orbitFrameSphere?.radius)
        : cameraView.range;
      // O veículo é desenhado no ponto subsatélite: a câmera centra nele.
      lookAtGroundPoint(geodetic.lon, geodetic.lat, {
        rangeM: range,
        headingDeg: toDegrees(track.lastCameraHeading),
        pitchDeg: toDegrees(cameraView.pitch),
      });
    }
    if (state.elapsedSinceStart >= track.ascentDurationSec + REPLAY_ORBIT_DURATION_SEC) {
      stopMissionReplay();
      return;
    }
  }
  updateReplayVehicleOverlay();
  if (typeof requestAnimationFrame === 'function') {
    _replayRaf = requestAnimationFrame(() => replayFrame(launchId, token, track, isCameraReady));
  }
}

function startMissionReplay(launchId) {
  const launch = _launches.find((item) => item.id === launchId);
  const track = _replayTracks.get(launchId);
  if (!_engine || !launch || !track) return false;
  if (_replayCameraLaunchId === launchId) {
    stopMissionReplay();
    return false;
  }

  stopMissionReplay();
  _replayCameraLaunchId = launchId;
  _replayPaused = false;
  _replayPausedAtMs = null;
  const token = ++_replayCameraToken;
  // Start broadside to the ascent/orbit direction so the launch profile is
  // visible. The chase heading then eases toward the path tangent.
  const initialHeading = replayInitialCameraHeading(track.ascentPath);
  track.lastCameraHeading = initialHeading;
  track.lastCameraUpdateMs = null;
  syncReplayButton();
  renderMissionLayer();
  releaseAircraftTracking(_dataManager);
  _engine.track?.(null);
  _engine.cancelFlight?.();
  _animationStarts.set(
    launchId,
    Date.now() + (REPLAY_TILE_SETTLE_DELAY_SEC + REPLAY_COUNTDOWN_DURATION_SEC) * 1000,
  );
  let cameraReady = false;
  const pad = geodeticFromCartesian(track.ascentPath[0]);
  _engine.flyToTarget?.(
    { lat: pad.lat, lon: pad.lon, height: 0 },
    {
      rangeM: REPLAY_INITIAL_RANGE_M,
      heading: toDegrees(initialHeading),
      pitch: -20,
      duration: 1.4,
      complete: () => { cameraReady = true; },
      cancel: () => {
        if (token === _replayCameraToken && _replayCameraLaunchId === launchId) stopMissionReplay();
      },
    },
  );
  if (typeof requestAnimationFrame === 'function') {
    _replayRaf = requestAnimationFrame(() => replayFrame(launchId, token, track, () => cameraReady));
  }
  return true;
}

// ------------------------------------------------------------ normalização

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePayloadFlights(launch) {
  const flights = launch.rocket?.payloads || launch.payloads || launch.mission?.payloads || [];
  if (!Array.isArray(flights)) return [];
  return flights.map((flight, index) => {
    const payload = flight.payload || flight;
    return {
      id: String(flight.id || payload.id || `payload-${index}`),
      name: payload.name || flight.name || 'Undisclosed payload',
      type: payload.type?.name || flight.type?.name || null,
      manufacturer: payload.manufacturer?.name || null,
      operator: payload.operator?.name || null,
      destination: flight.destination || payload.destination || null,
      amount: Number.isFinite(Number(flight.amount)) ? Number(flight.amount) : 1,
      massKg: Number.isFinite(Number(payload.mass)) ? Number(payload.mass) : null,
    };
  });
}

function normalizeLanding(stage, fallbackName, category, index) {
  const landing = stage?.landing;
  const location = landing?.landing_location || {};
  const launcher = stage?.launcher || stage?.spacecraft || {};
  const serial = launcher.serial_number || stage?.serial_number || null;
  const stageType = stage?.type?.name || stage?.type || category;
  const attempted = landing?.attempt === true;
  const success = landing?.success;
  const recoveryType = landing?.type?.name || null;
  const launcherStatus = launcher.status?.name || null;
  const status = success === true ? 'RECOVERED'
    : success === false ? 'LOST'
      : attempted ? 'RECOVERY ATTEMPT'
        : recoveryType ? recoveryType.toUpperCase()
          : launcherStatus ? launcherStatus.toUpperCase()
            : 'NO RECOVERY DATA';
  return {
    id: String(stage?.id || landing?.id || `${category}-${index}`),
    category,
    name: [stageType, serial].filter(Boolean).join(' · ') || fallbackName,
    serial,
    reused: stage?.reused === true,
    flightNumber: finiteCoordinate(stage?.launcher_flight_number),
    status,
    attempted,
    success: success === true ? true : success === false ? false : null,
    recoveryType,
    destination: location.name || landing?.destination || landing?.type?.name || null,
    description: landing?.description || null,
    downrangeKm: finiteCoordinate(landing?.downrange_distance),
    lat: finiteCoordinate(location.latitude ?? landing?.latitude),
    lon: finiteCoordinate(location.longitude ?? landing?.longitude),
  };
}

function normalizeRecoveryStages(launch, payloads) {
  const rocket = launch.rocket || {};
  const launcherStages = Array.isArray(rocket.launcher_stage) ? rocket.launcher_stage : [];
  const spacecraftStages = Array.isArray(rocket.spacecraft_stage) ? rocket.spacecraft_stage : [];
  const stages = [
    ...launcherStages.map((stage, index) => normalizeLanding(stage, `Launcher stage ${index + 1}`, 'LAUNCHER', index)),
    ...spacecraftStages.map((stage, index) => normalizeLanding(stage, `Spacecraft stage ${index + 1}`, 'SPACECRAFT', index)),
  ];
  const payloadFlights = rocket.payloads || launch.payloads || [];
  if (Array.isArray(payloadFlights)) {
    payloadFlights.forEach((flight, index) => {
      if (!flight?.landing) return;
      stages.push(normalizeLanding(
        { ...flight, type: payloads[index]?.type || 'Payload', serial_number: payloads[index]?.name },
        payloads[index]?.name || `Payload ${index + 1}`,
        'PAYLOAD',
        index,
      ));
    });
  }
  return stages;
}

function landingEndpoint(stage, launch, insertionPosition) {
  if (Number.isFinite(stage.lat) && Number.isFinite(stage.lon)) {
    return { lat: stage.lat, lon: stage.lon, accuracy: 'CONFIRMED' };
  }
  const recoveryIdentity = `${stage.recoveryType || ''} ${stage.destination || ''}`.toLowerCase();
  if (/return to launch site|rtls|launch site|landing zone/.test(recoveryIdentity)) {
    return { lat: launch.lat, lon: launch.lon, accuracy: 'PAD / RTLS' };
  }
  if (!(stage.downrangeKm > 0) || !insertionPosition) return null;
  const insertion = geodeticFromCartesian(insertionPosition);
  if (!insertion) return null;
  const start = { lon: launch.lon, lat: launch.lat };
  const bearing = initialBearing(start, insertion);
  const end = destination(start, bearing, stage.downrangeKm * 1000);
  return { lat: end.lat, lon: end.lon, accuracy: 'EST. DOWNRANGE' };
}

function stageReentryRecoveryPath(ascentPath, endpoint, stageIndex, stageCount) {
  if (!ascentPath?.length || !endpoint) return [];
  const progress = clamp(0.28 + (stageIndex / Math.max(stageCount, 1)) * 0.34, 0.28, 0.68);
  const separation = samplePath(ascentPath, progress);
  const target = cartesianFromDegrees(endpoint.lon, endpoint.lat, 12);
  return surfaceSafeSegment(separation, target);
}

function atmosphericReentryIndex(path) {
  if (!path?.length) return 0;
  for (let index = 1; index < path.length; index++) {
    const previousHeight = geodeticFromCartesian(path[index - 1])?.height;
    const height = geodeticFromCartesian(path[index])?.height;
    if (
      Number.isFinite(previousHeight)
      && Number.isFinite(height)
      && previousHeight > STAGE_REENTRY_ALTITUDE_M
      && height <= STAGE_REENTRY_ALTITUDE_M
    ) {
      return index;
    }
  }
  return Math.min(Math.max(Math.round(path.length * 0.55), 0), path.length - 1);
}

// ------------------------------------------------------------ painel

function missionTableRows(items, columns, emptyText) {
  if (!items.length) return `<tr><td colspan="${columns}" class="mission-table-empty">${emptyText}</td></tr>`;
  return items.map((item) => item).join('');
}

function setMissionPanelField(selector, value, title = '') {
  const output = _missionPanel?.querySelector(selector);
  if (!output) return;
  const rowEl = output.closest('[data-mission-field]');
  const available = value !== null && value !== undefined && String(value).trim() !== '';
  if (rowEl) rowEl.hidden = !available;
  if (!available) {
    output.textContent = '';
    output.removeAttribute('title');
    return;
  }
  output.textContent = value;
  if (title) output.title = title;
  else output.removeAttribute('title');
}

function renderMissionPanel() {
  if (!_missionPanel) return;
  const launch = _launches.find((item) => item.id === _selectedLaunchId);
  const index = launch ? _launches.indexOf(launch) : -1;
  _missionPanel.hidden = !launch;
  if (!launch) return;
  _missionPanel.querySelector('[data-mission-title]').textContent = shortMissionLabel(launch.name, 32).toUpperCase();
  setMissionPanelField('[data-mission-provider]', launch.provider);
  setMissionPanelField('[data-mission-status]', launch.status);
  setMissionPanelField(
    '[data-mission-site]',
    launch.launchSite && launch.launchSite !== 'Unknown launch site' ? launch.launchSite : null,
  );
  setMissionPanelField('[data-mission-time]', launch.launchTime);
  const pathPresentation = missionPathPresentation(launch, _replayTracks.has(launch.id));
  setMissionPanelField('[data-mission-orbit]', pathPresentation.orbit);
  _missionPanel.querySelector('[data-mission-ascent-source]').textContent = pathPresentation.ascent;
  const payloadRows = launch.payloads.length
    ? launch.payloads.slice(0, 5).map((payload) => {
      const detail = [
        payload.manufacturer,
        payload.operator && payload.operator !== payload.manufacturer ? payload.operator : null,
        Number.isFinite(payload.massKg) ? `${payload.massKg.toLocaleString()} KG` : null,
      ].filter(Boolean).join(' · ');
      return `<tr><td>${escapeMissionText(payload.name)}${payload.amount > 1 ? ` ×${payload.amount}` : ''}${detail ? `<small>${escapeMissionText(detail)}</small>` : ''}</td><td>${escapeMissionText(payload.type || 'UNSPECIFIED')}</td><td>${escapeMissionText(payload.destination || launch.orbit?.name || 'UNAVAILABLE')}</td></tr>`;
    })
    : [];
  if (launch.payloads.length > 5) {
    payloadRows.push(`<tr><td colspan="3" class="mission-table-empty">+${launch.payloads.length - 5} additional payload records</td></tr>`);
  }
  _missionPanel.querySelector('[data-mission-payloads]').innerHTML = missionTableRows(
    payloadRows,
    3,
    'CLASSIFIED / MULTI-PAYLOAD',
  );
  const stageRows = launch.recoveryStages.map((stage) => {
    const endpoint = stage.endpoint;
    const dest = stage.destination || (endpoint?.accuracy === 'PAD / RTLS' ? launch.launchSite : 'UNAVAILABLE');
    const position = endpoint
      ? `${endpoint.lat.toFixed(2)}, ${endpoint.lon.toFixed(2)} · ${endpoint.accuracy}`
      : stage.downrangeKm > 0 ? `${stage.downrangeKm.toLocaleString()} KM DOWNRANGE` : 'POSITION UNAVAILABLE';
    const stageDetail = [
      Number.isFinite(stage.flightNumber) ? `FLIGHT ${stage.flightNumber}` : null,
      stage.reused ? 'REUSED' : null,
      stage.recoveryType,
    ].filter(Boolean).join(' · ');
    return `<tr><td>${escapeMissionText(stage.name)}${stageDetail ? `<small>${escapeMissionText(stageDetail)}</small>` : ''}</td><td>${escapeMissionText(stage.status)}</td><td>${escapeMissionText(dest)}<small>${escapeMissionText(position)}</small></td></tr>`;
  });
  _missionPanel.querySelector('[data-mission-stages]').innerHTML = missionTableRows(
    stageRows,
    3,
    'NO STAGE RE-ENTRY / RECOVERY DATA',
  );
  const stageSection = _missionPanel.querySelector('[data-mission-stages-section]');
  if (stageSection) stageSection.hidden = stageRows.length === 0;
  updateMissionTelemetry(true);
  _missionPanel.querySelector('[data-mission-index]').textContent = `${index + 1} / ${_launches.length}`;
  _missionPanel.querySelector('[data-mission-prev]').disabled = index <= 0;
  _missionPanel.querySelector('[data-mission-next]').disabled = index < 0 || index >= _launches.length - 1;
  syncReplayButton();
  const panelScroller = _missionPanel.closest('.global-context-panel-inner');
  if (panelScroller) panelScroller.scrollTop = 0;
}

function renderMissionRoster() {
  if (!_missionRoster) return;
  const list = _missionRoster.querySelector('[data-mission-roster-list]');
  const count = _missionRoster.querySelector('[data-mission-roster-count]');
  if (count) count.textContent = `${_launches.length} / 30D`;
  if (!list) return;
  const entries = missionRosterEntries(_launches);
  if (!entries.length) {
    list.innerHTML = '<div class="space-mission-roster-empty">NO MISSIONS AVAILABLE IN THE CURRENT 30-DAY WINDOW</div>';
    return;
  }
  list.innerHTML = entries.map(({ launch, index }) => {
    const color = missionMarkerColor(launch);
    const date = launch.launchTime?.slice(0, 10) || 'DATE UNAVAILABLE';
    const provider = launch.provider || 'UNSPECIFIED OPERATOR';
    const label = shortMissionLabel(launch.name, 27).toUpperCase();
    return `<button type="button" class="space-mission-roster-item" data-mission-roster-index="${index}" aria-label="Select ${escapeMissionText(label)}"><span class="space-mission-roster-marker" style="--mission-roster-color:${color}" aria-hidden="true"></span><span class="space-mission-roster-copy"><strong>${escapeMissionText(label)}</strong><small>${escapeMissionText(provider)} · ${escapeMissionText(date)}</small></span><span class="space-mission-roster-chevron" aria-hidden="true">›</span></button>`;
  }).join('');
}

function escapeMissionText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function updateMissionTelemetry(force = false) {
  if (!_missionPanel || !_selectedLaunchId) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!force && now - _lastPanelTelemetryMs < 250) return;
  _lastPanelTelemetryMs = now;
  const record = _missionRecords.get(_selectedLaunchId);
  const live = record?.live ? record.updateLiveState() : null;
  const altitudeM = live?.altitudeM;
  setMissionPanelField(
    '[data-mission-distance]',
    Number.isFinite(altitudeM)
      ? `${Math.max(0, altitudeM / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} KM`
      : null,
  );
  const speedMps = _satelliteTelemetry.get(_selectedLaunchId)?.speedMps;
  setMissionPanelField(
    '[data-mission-speed]',
    Number.isFinite(speedMps)
      ? `${(speedMps / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KM/S`
      : null,
    Number.isFinite(speedMps)
      ? `${(speedMps * 3.6).toLocaleString(undefined, { maximumFractionDigits: 0 })} km/h`
      : '',
  );
}

function selectMissionAt(index) {
  const launch = _launches[index];
  if (!launch) return;
  setSelectedMission(launch.id, true);
  focusMission(launch);
}

function clearMissionRosterHover() {
  if (_missionRosterHoverTimer) clearTimeout(_missionRosterHoverTimer);
  _missionRosterHoverTimer = null;
  const changed = _hoveredRosterLaunchId !== null;
  _hoveredRosterLaunchId = null;
  if (changed) renderMissionLayer();
}

function previewMissionFromRoster(launch) {
  if (!_engine || !launch || _selectedLaunchId) return;
  const range = missionHoverPreviewRange(cameraAltitude());
  _engine.flyToCamera?.({ lat: launch.lat, lon: launch.lon, alt: range, heading: 0, pitch: -90 }, { duration: 0.8 });
}

function scheduleMissionRosterPreview(index) {
  const launch = _launches[index];
  if (!launch || _selectedLaunchId) return;
  if (_missionRosterHoverTimer) clearTimeout(_missionRosterHoverTimer);
  _hoveredRosterLaunchId = launch.id;
  renderMissionLayer();
  _missionRosterHoverTimer = setTimeout(() => {
    _missionRosterHoverTimer = null;
    if (_hoveredRosterLaunchId === launch.id) previewMissionFromRoster(launch);
  }, 140);
}

/** Enquadra a missão inteira (órbita incluída) de cima. */
function focusMission(launch) {
  if (!_engine || !launch) return;
  const record = _missionRecords.get(launch.id);
  // A órbita é desenhada no chão (traço no solo): enquadrar o globo inteiro
  // basta, qualquer que seja a altitude da órbita. (No Cesium o anel ficava no
  // espaço e o alcance crescia com o apogeu.)
  const range = record?.orbitPath?.length > 1 ? 18000000 : MISSION_GLOBE_VIEW_RANGE_M * 2;
  _engine.flyToCamera?.(
    { lat: launch.lat, lon: launch.lon, alt: range, heading: 0, pitch: -90 },
    { duration: 1.1 },
  );
}

function focusLaunchSite(launch) {
  if (!_engine || !launch) return;
  stopMissionReplay();
  _engine.flyToTarget?.(
    { lat: launch.lat, lon: launch.lon, height: 0 },
    { rangeM: MISSION_FOCUS_RANGE_M, heading: 0, pitch: toDegrees(missionZoomPitch(MISSION_FOCUS_RANGE_M)), duration: 1.4 },
  );
}

function createMissionPanel() {
  if (_missionPanel || typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  const host = document.getElementById('space-mission-panel-host')
    || document.getElementById('right-context-rail');
  if (!host) return;
  _missionRoster = document.getElementById('space-mission-roster');
  if (_missionRoster) {
    _missionRoster.onclick = (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-mission-roster-index]')
        : null;
      if (!button) return;
      selectMissionAt(Number(button.dataset.missionRosterIndex));
    };
    _missionRoster.onmouseover = (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-mission-roster-index]')
        : null;
      if (!button || button.contains(event.relatedTarget)) return;
      scheduleMissionRosterPreview(Number(button.dataset.missionRosterIndex));
    };
    _missionRoster.onfocusin = (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-mission-roster-index]')
        : null;
      if (button) scheduleMissionRosterPreview(Number(button.dataset.missionRosterIndex));
    };
    _missionRoster.onmouseleave = clearMissionRosterHover;
    _missionRoster.onfocusout = (event) => {
      if (!_missionRoster.contains(event.relatedTarget)) clearMissionRosterHover();
    };
  }
  _missionPanel = document.createElement('aside');
  _missionPanel.id = 'space-mission-panel';
  _missionPanel.className = 'context-space-mission-detail';
  _missionPanel.setAttribute('aria-label', 'Selected Space Mission');
  _missionPanel.innerHTML = `<div class="space-mission-view-header"><span>SELECTED SPACE MISSION</span><button type="button" data-mission-close title="Show all missions" aria-label="Deselect mission">×</button></div><div class="space-mission-detail"><strong data-mission-title>MISSION</strong><span data-mission-field data-mission-provider></span><span data-mission-field>STATUS · <b data-mission-status></b></span><span data-mission-field>LAUNCH SITE · <b data-mission-site></b></span><span data-mission-field>LAUNCH TIME · <b data-mission-time></b></span><span data-mission-field>ORBIT · <b data-mission-orbit></b></span><span>ASCENT PATH · <b data-mission-ascent-source></b></span><span data-mission-field>CURRENT DISTANCE FROM EARTH · <b data-mission-distance></b></span><span data-mission-field>SATELLITE SPEED · <b data-mission-speed></b></span></div><section class="mission-data-section"><h4>PAYLOAD</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th>NAME</th><th>TYPE</th><th>DESTINATION</th></tr></thead><tbody data-mission-payloads></tbody></table></div></section><section class="mission-data-section" data-mission-stages-section><h4>STAGE / RE-ENTRY / RECOVERY</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th>STAGE</th><th>STATUS</th><th>FINAL POSITION</th></tr></thead><tbody data-mission-stages></tbody></table></div></section><div class="mission-replay-speed-control"><div class="mission-replay-speed-header"><label for="space-mission-replay-speed">REPLAY SPEED</label><output class="gev-slider-value" for="space-mission-replay-speed" data-mission-replay-speed-output>1×</output></div><input id="space-mission-replay-speed" class="gev-quantitative-slider" type="range" min="0.25" max="4" step="0.25" value="1" data-mission-replay-speed aria-label="Replay speed multiplier"><div class="mission-replay-speed-scale" aria-hidden="true"><span>0.25×</span><span>1×</span><span>4×</span></div></div><div class="mission-action-row"><button type="button" class="mission-focus-button" data-mission-focus>FOCUS</button><button type="button" class="mission-replay-button" data-mission-replay aria-pressed="false">REPLAY ASCENT</button></div><div class="space-mission-nav"><button type="button" class="mission-nav-button" data-mission-prev title="Previous mission"><span aria-hidden="true">‹</span> PREV</button><span class="mission-nav-index" data-mission-index>—</span><button type="button" class="mission-nav-button" data-mission-next title="Next mission">NEXT <span aria-hidden="true">›</span></button></div><button type="button" class="panel-layer-toggle" data-mission-show-all>SHOW ALL / DESELECT</button>`;
  _missionPanel.querySelector('.mission-action-row').insertAdjacentHTML(
    'beforeend',
    `<div class="mission-replay-transport" data-mission-replay-transport hidden>
      <button type="button" data-mission-replay-toggle title="Pause replay" aria-label="Pause replay">Ⅱ</button>
      <button type="button" class="cancel" data-mission-replay-cancel title="Cancel replay" aria-label="Cancel replay"><span aria-hidden="true">×</span></button>
    </div>`,
  );
  host.appendChild(_missionPanel);
  _missionPanel.querySelector('[data-mission-prev]').addEventListener('click', () => selectMissionAt(_launches.findIndex((item) => item.id === _selectedLaunchId) - 1));
  _missionPanel.querySelector('[data-mission-next]').addEventListener('click', () => selectMissionAt(_launches.findIndex((item) => item.id === _selectedLaunchId) + 1));
  _missionPanel.querySelector('[data-mission-close]').addEventListener('click', () => setSelectedMission(null));
  _missionPanel.querySelector('[data-mission-show-all]').addEventListener('click', () => setSelectedMission(null));
  _missionPanel.querySelector('[data-mission-focus]').addEventListener('click', () => {
    const launch = _launches.find((item) => item.id === _selectedLaunchId);
    if (launch) focusLaunchSite(launch);
  });
  _missionPanel.querySelector('[data-mission-replay]').addEventListener('click', () => {
    if (_selectedLaunchId) startMissionReplay(_selectedLaunchId);
  });
  _missionPanel.querySelector('[data-mission-replay-toggle]').addEventListener('click', () => {
    if (_replayPaused) resumeMissionReplay();
    else pauseMissionReplay();
  });
  _missionPanel.querySelector('[data-mission-replay-cancel]').addEventListener('click', stopMissionReplay);
  _missionPanel.querySelector('[data-mission-replay-speed]').addEventListener('input', (event) => {
    setReplaySpeed(event.currentTarget.value);
  });
  syncReplaySpeedControl();
}

/** Posiciona o foguete/ponto do replay (DOM) sobre o ponto subsatélite do veículo. */
function updateReplayVehicleOverlay() {
  if (!_engine || !_replayVehicleOverlay || !_selectedLaunchId) {
    hideReplayVehicleOverlay();
    return null;
  }
  const launch = _launches.find((item) => item.id === _selectedLaunchId);
  const track = _replayTracks.get(_selectedLaunchId);
  if (!launch || !track) {
    hideReplayVehicleOverlay();
    return null;
  }
  const replayActive = _replayCameraLaunchId === launch.id;
  const state = track.getReplayState();
  const mode = replayOverlayMode({
    replayActive,
    ascending: state.ascending,
    countdownActive: state.countdownActive,
    preCountdownActive: state.preCountdownActive,
  });
  if (!mode) {
    track.lastOverlayWindowPosition = null;
    track.lastOverlayMode = null;
    hideReplayVehicleOverlay();
    return null;
  }
  const path = state.ascending ? track.ascentPath : track.animatedOrbitPath;
  const position = samplePath(path, state.phaseProgress);
  const geodetic = position ? geodeticFromCartesian(position) : null;
  const windowPosition = geodetic ? _engine.project?.(geodetic.lon, geodetic.lat) : null;
  if (!windowPosition || windowPosition.visible === false) {
    hideReplayVehicleOverlay();
    return null;
  }
  const renderedWindowPosition = !replayActive && track.lastOverlayMode === mode
    ? smoothReplayWindowPosition(track.lastOverlayWindowPosition, windowPosition)
    : windowPosition;
  track.lastOverlayWindowPosition = renderedWindowPosition;
  track.lastOverlayMode = mode;
  _replayVehicleOverlay.hidden = false;
  _replayVehicleOverlay.dataset.mode = mode;
  _replayVehicleOverlay.classList.toggle(
    'is-thrusting',
    replayActive && state.ascending && !state.countdownActive,
  );
  _replayVehicleOverlay.classList.toggle('is-paused', replayActive && _replayPaused);
  _replayVehicleOverlay.style.transform = `translate3d(${renderedWindowPosition.x}px, ${renderedWindowPosition.y}px, 0) translate(-50%, -50%)`;
  let vehicleRotation = 0;
  if (replayActive && !state.countdownActive) {
    const tangentStep = Math.max(0.002, 0.8 / Math.max(2, path.length - 1));
    const forwardProgress = Math.min(1, state.phaseProgress + tangentStep);
    const backwardProgress = Math.max(0, state.phaseProgress - tangentStep);
    const useForward = forwardProgress > state.phaseProgress;
    const tangentGeo = geodeticFromCartesian(samplePath(path, useForward ? forwardProgress : backwardProgress));
    const tangentWindowPosition = tangentGeo ? _engine.project?.(tangentGeo.lon, tangentGeo.lat) : null;
    if (tangentWindowPosition) {
      const screenDelta = Math.hypot(
        tangentWindowPosition.x - windowPosition.x,
        tangentWindowPosition.y - windowPosition.y,
      );
      if (screenDelta >= 2) {
        vehicleRotation = useForward
          ? replayVehicleScreenRotation(windowPosition, tangentWindowPosition)
          : replayVehicleScreenRotation(tangentWindowPosition, windowPosition);
        track.lastVehicleRotation = vehicleRotation;
      } else if (Number.isFinite(track.lastVehicleRotation)) {
        vehicleRotation = track.lastVehicleRotation;
      }
    }
  }
  _replayVehicleOverlay.style.setProperty('--mission-replay-rotation', `${toDegrees(vehicleRotation)}deg`);

  const mission = shortMissionLabel(launch.name, 22).toUpperCase();
  const siteName = compactLaunchSiteName(launch.launchSite);
  const siteCallout = siteName
    ? `LAUNCH SITE · ${shortMissionLabel(siteName, 20).toUpperCase()}`
    : 'LAUNCH SITE';
  let title = mission;
  let detail = siteCallout;
  if (mode === 'countdown') {
    title = `T−${String(state.countdownSeconds).padStart(2, '0')} · ${mission}`;
    detail = `LAUNCH STANDBY\n${siteCallout}`;
  } else if (mode === 'ascent') {
    title = state.elapsedSinceStart < 1
      ? `LIFTOFF · ${mission}`
      : `${launch.trajectory.length > 1 ? 'ASCENT REPLAY' : 'ASCENT ESTIMATE'} · ${mission}`;
    detail = formatMissionEventTime(state.eventTime);
  } else if (mode === 'orbit') {
    title = `ORBIT REPLAY · ${mission}`;
    detail = formatMissionEventTime(state.eventTime);
  }
  if (_replayPaused) title = `PAUSED · ${title}`;
  const nextText = `${title}\n${detail}`;
  if (nextText !== _replayVehicleOverlayText) {
    _replayVehicleOverlayText = nextText;
    _replayVehicleOverlay.querySelector('[data-replay-overlay-title]').textContent = title;
    _replayVehicleOverlay.querySelector('[data-replay-overlay-detail]').textContent = detail;
  }
  return mode;
}

/**
 * Select a stable marker color from the mission operator and payload name.
 * @param {object} launch Normalized launch record.
 * @returns {string} CSS color ('#rrggbb').
 */
export function missionMarkerColor(launch) {
  const identity = `${launch.provider || ''} ${launch.name || ''} ${launch.missionName || ''}`.toLowerCase();
  if (/nasa|national aeronautics/.test(identity)) return '#ff9f43';
  if (/starlink|spacex|space exploration/.test(identity)) return '#4cc9f0';
  if (/rocket lab/.test(identity)) return '#7bed9f';
  if (/isro|indian space/.test(identity)) return '#ff66c4';
  if (/cnsa|china national|long march/.test(identity)) return '#ffd166';
  if (/blue origin/.test(identity)) return '#a78bfa';
  if (/ula|united launch alliance/.test(identity)) return '#f97316';
  if (/arianespace|esa|european space/.test(identity)) return '#60a5fa';
  if (launch.provider) return '#c084fc';
  return '#22e6e6';
}

/**
 * Normalize a Launch Library 2 response into records suitable for the layer.
 * Trajectory points are retained only when the upstream explicitly supplies
 * them; orbital tracks must not be reconstructed from launch metadata.
 * @param {object} payload Launch Library 2-compatible response.
 * @param {Date} [now] Reference time used for the rolling window.
 * @returns {Array<object>}
 */
export function normalizeRocketLaunches(payload, now = new Date()) {
  const launches = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(launches)) return [];
  const cutoff = now.getTime() - WINDOW_DAYS * 86400000;
  return launches.map((launch) => {
    const launchTime = launch.net || launch.window_start || launch.pad?.location?.name;
    const date = Date.parse(launchTime);
    const pad = launch.pad || {};
    const location = pad.location || {};
    const coordinates = location.coordinates || '';
    const [coordinateLon, coordinateLat] = String(coordinates).split(',').map(Number);
    const lat = Number.isFinite(Number(pad.latitude)) ? Number(pad.latitude) : coordinateLat;
    const lon = Number.isFinite(Number(pad.longitude)) ? Number(pad.longitude) : coordinateLon;
    const payloads = normalizePayloadFlights(launch);
    return {
      id: String(launch.id || launch.slug || launch.name || `launch-${date}`),
      name: launch.name || 'Unnamed launch',
      status: launch.status?.name || 'Unknown',
      launchTime: Number.isFinite(date) ? new Date(date).toISOString() : null,
      launchSite: pad.name || location.name || 'Unknown launch site',
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      provider: launch.launch_service_provider?.name || null,
      mission: launch.mission?.description || null,
      missionName: launch.mission?.name || null,
      satelliteQuery: launch.mission?.name || launch.name || null,
      payloads,
      recoveryStages: normalizeRecoveryStages(launch, payloads),
      trajectory: Array.isArray(launch.trajectory) ? launch.trajectory : [],
      timeline: Array.isArray(launch.timeline)
        ? launch.timeline.map((event) => ({
          name: event.type?.abbrev || event.type?.name || event.name || 'Mission event',
          relativeTime: event.relative_time || event.relativeTime || null,
          offsetSeconds: parseMissionDurationSeconds(event.relative_time || event.relativeTime),
        }))
        : [],
      orbit: launch.mission?.orbit || launch.orbit || null,
      source: 'Launch Library 2',
      inWindow: Number.isFinite(date) && date >= cutoff && date <= now.getTime(),
    };
  }).filter((launch) => launch.inWindow && launch.lat !== null && launch.lon !== null);
}

/**
 * Monta a geometria de uma missão (antes: as entidades Cesium de
 * addLaunchEntity): âncora, trajetórias fornecidas, órbita (real ou estimada),
 * subida reconstruída, estágios/reentrada, posição viva e o trilho do replay.
 */
function buildMissionRecord(launch, activeTleText = _activeTleText) {
  const position = cartesianFromDegrees(launch.lon, launch.lat);
  const record = {
    launch,
    anchorPosition: position,
    color: missionMarkerColor(launch),
    trajectorySegments: [],
    recoveryPaths: [],
    reentryPaths: [],
    recoveryEnds: [],
    reentryLabels: [],
    orbitPath: null,
    orbitLive: false,
    gmstAtBake: null,
    ascentPath: null,
    orbitLabelPosition: null,
    satelliteTrack: null,
    live: null,
    updateLiveState: () => null,
  };
  const orbitAllowed = launchStatusAllowsOrbit(launch.status);
  const coreTrack = orbitAllowed && launch.satelliteQuery
    ? getSatelliteOrbitTrack(launch.satelliteQuery, { launchTime: launch.launchTime })
    : null;
  const satelliteTrack = coreTrack || (orbitAllowed && activeTleText && launch.satelliteQuery
    ? findSatelliteOrbitTrackInTle(
      activeTleText,
      launch.satelliteQuery,
      { launchTime: launch.launchTime },
    )
    : null);
  record.satelliteTrack = satelliteTrack;
  const orbitPath = !orbitAllowed
    ? null
    : satelliteTrack?.orbitPath?.length > 1
      ? satelliteTrack.orbitPath
      : approximateOrbitPath(launch);
  record.orbitPath = orbitPath;
  launch.recoveryStages.forEach((stage) => {
    stage.endpoint = landingEndpoint(stage, launch, orbitPath?.[0] || null);
  });
  if (satelliteTrack) _orbitMatches++;

  const points = launch.trajectory
    .filter((point) => Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)))
    .map((point) => ({
      stage: String(point.stage || point.stage_name || point.phase || point.stageName || 'trajectory'),
      position: cartesianFromDegrees(Number(point.longitude), Number(point.latitude), Number(point.altitude || 0)),
    }));
  if (points.length > 1) {
    const segments = [];
    points.forEach((point) => {
      const previous = segments.at(-1);
      if (!previous || previous.stage !== point.stage) segments.push({ stage: point.stage, positions: [] });
      segments.at(-1).positions.push(point.position);
    });
    segments.forEach((segment, index) => {
      if (segment.positions.length < 2) return;
      record.trajectorySegments.push({
        path: surfaceSafePath(segment.positions),
        stage: segment.stage,
        color: TRAJECTORY_STAGE_COLORS[index % TRAJECTORY_STAGE_COLORS.length],
      });
    });
  }

  if (orbitPath?.length > 1) {
    const orbitCurrent = satelliteTrack?.current || { longitude: launch.lon, latitude: launch.lat, altitude: 0 };
    const orbitPeriodSec = satelliteTrack?.periodSec || estimatedOrbitPeriodSeconds(orbitPath);
    const launchEpochMs = Date.parse(launch.launchTime);
    const disclosedInsertionOffsetSec = orbitInsertionOffsetSeconds(launch);
    const insertionDurationSec = Number.isFinite(disclosedInsertionOffsetSec)
      ? Math.max(0, disclosedInsertionOffsetSec)
      : 600;
    const insertionEpochMs = Number.isFinite(launchEpochMs)
      ? launchEpochMs + insertionDurationSec * 1000
      : Number.NaN;
    let insertionReference = points.at(-1)?.position || null;
    if (!insertionReference && satelliteTrack?.positionAt && Number.isFinite(insertionEpochMs)) {
      const propagatedInsertion = satelliteTrack.positionAt(new Date(insertionEpochMs));
      if (propagatedInsertion) {
        insertionReference = cartesianFromDegrees(
          propagatedInsertion.longitude,
          propagatedInsertion.latitude,
          propagatedInsertion.altitude,
        );
      }
    }
    if (!insertionReference && !satelliteTrack) {
      // A projected orbit has no authoritative historical phase. Start its
      // plane over the launch site, advance only by the estimated powered
      // ascent duration, and join the forward orbit tangent.
      const insertionProgress = clamp(insertionDurationSec / orbitPeriodSec, 1 / 96, 0.16);
      insertionReference = samplePath(orbitPath, insertionProgress);
    }
    const { ascentPath, animatedOrbitPath } = buildMissionPaths(
      position,
      points.map((point) => point.position),
      orbitPath,
      insertionReference,
    );
    record.ascentPath = ascentPath;
    const ascentDurationSec = replayAscentDurationSeconds(launch, ascentPath);
    // Camera, overlay and marker must use the exact same replay epoch in one frame.
    let replayStateForFrame = null;
    const sampleReplayState = () => replayState(
      launch,
      _animationStarts.get(launch.id) || Date.now(),
      ascentDurationSec,
      REPLAY_ORBIT_DURATION_SEC,
      orbitPeriodSec,
      _replaySpeed,
      replayClockNow(launch.id),
      REPLAY_TILE_SETTLE_DELAY_SEC,
      _replayCameraLaunchId !== launch.id,
    );
    const beginReplayFrame = () => {
      replayStateForFrame = sampleReplayState();
      return replayStateForFrame;
    };
    const getReplayState = () => {
      if (!replayStateForFrame) replayStateForFrame = sampleReplayState();
      return replayStateForFrame;
    };
    launch.recoveryStages.forEach((stage, stageIndex) => {
      stage.endpoint = landingEndpoint(stage, launch, ascentPath.at(-1));
      const path = stageReentryRecoveryPath(ascentPath, stage.endpoint, stageIndex, launch.recoveryStages.length);
      if (path.length < 2) return;
      const reentryIndex = atmosphericReentryIndex(path);
      const reentryPath = path.slice(reentryIndex);
      const color = TRAJECTORY_STAGE_COLORS[(stageIndex + 1) % TRAJECTORY_STAGE_COLORS.length];
      record.recoveryPaths.push({ path, color, stageId: stage.id, accuracy: stage.endpoint.accuracy });
      if (reentryPath.length > 1) {
        record.reentryPaths.push({ path: reentryPath, stageId: stage.id });
        record.reentryLabels.push(createRocketMissionElementOverlayEntry({
          id: `reentry:${launch.id}:${stageIndex}`,
          position: path[reentryIndex],
          text: 'STAGE RE-ENTRY',
          accent: '#ffd166',
          priority: 700_000 - stageIndex,
          gapPx: 8,
        }));
      }
      record.recoveryEnds.push({ position: path.at(-1), color, stageId: stage.id, name: stage.name });
    });
    _replayTracks.set(launch.id, {
      ascentPath,
      animatedOrbitPath,
      orbitFrameSphere: replayOrbitFrameSphere(animatedOrbitPath),
      ascentDurationSec,
      beginReplayFrame,
      getReplayState,
      lastCameraHeading: Math.PI,
      lastCameraUpdateMs: null,
      lastVehicleRotation: 0,
      lastOverlayWindowPosition: null,
      lastOverlayMode: null,
    });

    // Posição viva do satélite (real, propagada) ou estimada no anel.
    const liveTelemetry = { speedMps: null };
    _satelliteTelemetry.set(launch.id, liveTelemetry);
    const fallbackPeriodSec = estimatedOrbitPeriodSeconds(orbitPath);
    const live = {
      time: new Date(),
      lon: orbitCurrent.longitude,
      lat: orbitCurrent.latitude,
      altitudeM: orbitCurrent.altitude,
      sampledAtMs: Number.NEGATIVE_INFINITY,
    };
    record.live = live;
    record.updateLiveState = () => {
      const nowMs = Date.now();
      if (nowMs - live.sampledAtMs < 16) return live;
      live.sampledAtMs = nowMs;
      live.time = new Date(nowMs);
      if (satelliteTrack) {
        const propagated = satelliteTrack.positionAt?.(live.time) || satelliteTrack.current;
        if (propagated) {
          live.lon = propagated.longitude;
          live.lat = propagated.latitude;
          live.altitudeM = propagated.altitude;
          liveTelemetry.speedMps = Number.isFinite(propagated.speedMps) ? propagated.speedMps : null;
        }
      } else {
        const sample = geodeticFromCartesian(samplePath(orbitPath, orbitProgressAtTime(nowMs, fallbackPeriodSec)));
        if (sample) {
          live.lon = sample.lon;
          live.lat = sample.lat;
          live.altitudeM = sample.height;
        }
      }
      return live;
    };
    record.updateLiveState();
    record.orbitLive = Boolean(satelliteTrack && Number.isFinite(satelliteTrack.gmstAtBake));
    record.gmstAtBake = record.orbitLive ? satelliteTrack.gmstAtBake : null;
    record.orbitLabelPosition = ascentPath.at(-1);
  }
  return record;
}

// ------------------------------------------------------------ MapLibre

const SRC_SITES = 'dg-rocket-sites';
const SRC_PATHS = 'dg-rocket-paths';
const SRC_MARKS = 'dg-rocket-marks';
const SRC_PAD = 'dg-rocket-pad';

const PATH_KIND_TEXT = {
  trajectory: 'Trajetória fornecida (LL2)',
  transfer: 'Subida estimada (reconstruída)',
  orbit: 'Órbita do satélite (CelesTrak)',
  'orbit-est': 'Órbita estimada da missão',
  recovery: 'Reentrada / recuperação de estágio (estimada)',
  reentry: 'Interface atmosférica ~100 km (estimada)',
};

function _tooltip(props) {
  if (props.kind === 'site') {
    return `<strong>${esc(props.name)}</strong>`
      + row('Operador', props.provider)
      + row('Lançamento', props.launchTime ? String(props.launchTime).replace('T', ' ').slice(0, 16) + ' UTC' : '')
      + row('Status', props.status)
      + row('Local', props.launchSite)
      + row('Fonte', 'Launch Library 2');
  }
  if (props.kind === 'satellite') {
    return `<strong>${esc(props.title)}</strong>`
      + row('Altitude', Number.isFinite(Number(props.altKm)) ? `${Number(props.altKm).toLocaleString('pt-BR')} km` : '')
      + row('Posição', props.estimated ? 'estimada no anel projetado' : 'propagada (SGP4)');
  }
  const text = PATH_KIND_TEXT[props.kind] || props.title || '';
  return text ? `<strong>${esc(props.mission || '')}</strong>${row('Elemento', text)}` : '';
}

/** Definição de estilo da camada (contrato em src/maplibre/kit.js). */
export const ROCKET_LAUNCHES_LAYER_DEF = defineLayer({
  id: LAYER_ID,
  name: 'Space Missions (30d)',
  category: 'Espaço',
  icon: '🚀',
  source: 'Launch Library 2',
  sources: {
    [SRC_PAD]: { type: 'geojson', data: EMPTY_FC },
    [SRC_PATHS]: { type: 'geojson', data: EMPTY_FC },
    [SRC_SITES]: { type: 'geojson', data: EMPTY_FC },
    [SRC_MARKS]: { type: 'geojson', data: EMPTY_FC },
  },
  layers: [
    {
      id: 'dg-rocket-pad-fill',
      type: 'fill',
      source: SRC_PAD,
      paint: { 'fill-color': '#22e6e6', 'fill-opacity': 0.12 },
    },
    {
      id: 'dg-rocket-pad-rim',
      type: 'line',
      source: SRC_PAD,
      paint: { 'line-color': '#22e6e6', 'line-width': 2, 'line-opacity': 0.75 },
    },
    {
      id: 'dg-rocket-path',
      type: 'line',
      source: SRC_PATHS,
      filter: ['==', ['get', 'style'], 'solid'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.85 },
    },
    {
      id: 'dg-rocket-path-dash',
      type: 'line',
      source: SRC_PATHS,
      filter: ['==', ['get', 'style'], 'dash'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': 0.85,
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'dg-rocket-path-orbit',
      type: 'line',
      source: SRC_PATHS,
      filter: ['==', ['get', 'style'], 'orbit'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'width'],
        'line-opacity': 0.92,
        'line-dasharray': [1.5, 1.2],
      },
    },
    {
      id: 'dg-rocket-hover-ring',
      type: 'circle',
      source: SRC_SITES,
      filter: ['==', ['get', 'hovered'], 1],
      paint: {
        'circle-radius': 12,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#22e6e6',
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: 'dg-rocket-site',
      type: 'circle',
      source: SRC_SITES,
      paint: {
        'circle-radius': ['case', ['==', ['get', 'selected'], 1], 6, 4],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': 'rgba(5,8,13,0.85)',
        'circle-stroke-width': 1,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: 'dg-rocket-mark',
      type: 'circle',
      source: SRC_MARKS,
      filter: ['==', ['get', 'dot'], 1],
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': 'rgba(5,8,13,0.85)',
        'circle-stroke-width': 1,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: 'dg-rocket-site-label',
      type: 'symbol',
      source: SRC_SITES,
      filter: ['all', ['==', ['get', 'showLabel'], 1], ['==', ['get', 'selected'], 0]],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT_BOLD,
        'text-size': 10.5,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.9],
        'text-max-width': 30,
        'text-line-height': 1.25,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': '#22e6e6',
        'text-halo-color': 'rgba(5,8,13,0.92)',
        'text-halo-width': 1.4,
      },
    },
    {
      // Missão selecionada: rótulo protegido (nunca some por colisão).
      id: 'dg-rocket-site-label-selected',
      type: 'symbol',
      source: SRC_SITES,
      filter: ['all', ['==', ['get', 'showLabel'], 1], ['==', ['get', 'selected'], 1]],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT_BOLD,
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-max-width': 30,
        'text-line-height': 1.25,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#22e6e6',
        'text-halo-color': 'rgba(5,8,13,0.92)',
        'text-halo-width': 1.6,
      },
    },
    {
      id: 'dg-rocket-mark-label',
      type: 'symbol',
      source: SRC_MARKS,
      filter: ['has', 'label'],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT_BOLD,
        'text-size': 11,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.8],
        'text-max-width': 30,
        'text-line-height': 1.25,
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(5,8,13,0.92)',
        'text-halo-width': 1.4,
      },
    },
  ],
  interactive: ['dg-rocket-site', 'dg-rocket-mark', 'dg-rocket-path', 'dg-rocket-path-dash', 'dg-rocket-path-orbit'],
  tooltip: (props) => _tooltip(props),
  click: (props) => {
    if (!_enabled || !props.launchId) return;
    const launch = _launches.find((item) => item.id === props.launchId);
    if (!launch) return;
    setSelectedMission(launch.id);
    focusMission(launch);
  },
});

/** Última coleção desenhada por fonte (também lida pelos testes). */
const _lastFeatures = { sites: EMPTY_FC, paths: EMPTY_FC, marks: EMPTY_FC, pad: EMPTY_FC };

function _setSource(id, data) {
  const map = _engine?.map;
  if (!map || typeof map.getSource !== 'function') return;
  map.getSource(id)?.setData(data);
}

function lineFeature(coordinates, properties) {
  return coordinates.length > 1
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties }
    : null;
}

function pointFeatureFromCartesian(position, properties) {
  const g = geodeticFromCartesian(position);
  return g ? { type: 'Feature', geometry: { type: 'Point', coordinates: [g.lon, g.lat] }, properties } : null;
}

/** Deslocamento de GMST do anel de um satélite real (anéis estimados: 0). */
function orbitShiftDeg(record, nowDate) {
  return record.orbitLive ? orbitFrameLongitudeShiftDeg(record.gmstAtBake, nowDate) : 0;
}

function buildSiteFeatures() {
  const selectedRecord = _selectedLaunchId ? _missionRecords.get(_selectedLaunchId) : null;
  const records = selectedRecord ? [selectedRecord] : [..._missionRecords.values()];
  // Rótulos ambientes: só a coorte mais recente (48), mais o hover do roster.
  const entries = records.map((record) => {
    const entry = createRocketMissionMarkerOverlayEntry(record.launch, record.anchorPosition, Boolean(selectedRecord));
    if (record.launch.id === _hoveredRosterLaunchId) {
      entry.pinned = true;
      entry.priority = Number.MAX_SAFE_INTEGER - 1;
    }
    return { entry, record };
  });
  const cohort = new Set(selectRocketMissionMarkerOverlayCohort(entries.map(({ entry }) => entry)).map((entry) => entry.id));
  const hideSiteLabel = selectedRecord && _replayCameraLaunchId === selectedRecord.launch.id;
  const features = entries.map(({ entry, record }, index) => ({
    type: 'Feature',
    id: index,
    geometry: { type: 'Point', coordinates: [record.launch.lon, record.launch.lat] },
    properties: {
      kind: 'site',
      launchId: record.launch.id,
      name: record.launch.name,
      provider: record.launch.provider || '',
      status: record.launch.status || '',
      launchTime: record.launch.launchTime || '',
      launchSite: record.launch.launchSite || '',
      color: record.color,
      label: [entry.title, ...entry.details].join('\n'),
      showLabel: cohort.has(entry.id) && !hideSiteLabel ? 1 : 0,
      rank: -Math.min(entry.priority, Number.MAX_SAFE_INTEGER - 1) / 1e9,
      selected: selectedRecord ? 1 : 0,
      hovered: record.launch.id === _hoveredRosterLaunchId ? 1 : 0,
    },
  }));
  return fc(features);
}

function buildPathFeatures(nowDate = new Date()) {
  const features = [];
  for (const record of _missionRecords.values()) {
    const selected = _selectedLaunchId === record.launch.id;
    if (_selectedLaunchId && !selected) continue;
    const mission = shortMissionLabel(record.launch.name, 32);
    const base = { launchId: record.launch.id, mission };
    // Órbita: anéis de satélites reais aparecem também na visão geral (como os
    // primitivos do app Cesium); anéis estimados só com a missão selecionada.
    if (record.orbitPath?.length > 1 && (selected || record.orbitLive)) {
      features.push(lineFeature(pathToLonLat(record.orbitPath, { lonShiftDeg: orbitShiftDeg(record, nowDate) }), {
        ...base,
        kind: record.orbitLive ? 'orbit' : 'orbit-est',
        style: 'orbit',
        color: record.orbitLive ? '#22e6e6' : '#c084fc',
        width: 2.5,
      }));
    }
    if (!selected) continue;
    for (const segment of record.trajectorySegments) {
      features.push(lineFeature(pathToLonLat(segment.path), {
        ...base, kind: 'trajectory', style: 'solid', color: segment.color, width: 2, stage: segment.stage,
      }));
    }
    for (const recovery of record.recoveryPaths) {
      features.push(lineFeature(pathToLonLat(recovery.path), {
        ...base, kind: 'recovery', style: 'dash', color: recovery.color, width: 2, accuracy: recovery.accuracy,
      }));
    }
    for (const reentry of record.reentryPaths) {
      features.push(lineFeature(pathToLonLat(reentry.path), {
        ...base, kind: 'reentry', style: 'dash', color: '#ffd166', width: 2.5,
      }));
    }
    if (record.ascentPath?.length > 1) {
      features.push(lineFeature(pathToLonLat(record.ascentPath), {
        ...base, kind: 'transfer', style: 'dash', color: '#7bed9f', width: 1.8,
      }));
    }
  }
  return fc(features.filter(Boolean));
}

function buildMarkFeatures(nowDate = new Date()) {
  const record = _selectedLaunchId ? _missionRecords.get(_selectedLaunchId) : null;
  if (!record) return EMPTY_FC;
  const features = [];
  const launchId = record.launch.id;
  for (const end of record.recoveryEnds) {
    features.push(pointFeatureFromCartesian(end.position, {
      launchId, kind: 'recovery-end', dot: 1, r: 3, color: end.color, title: end.name,
    }));
  }
  for (const entry of record.reentryLabels) {
    features.push(pointFeatureFromCartesian(entry.position, {
      launchId, kind: 'reentry', dot: 0, color: entry.accent, label: [entry.title, ...entry.details].join('\n'),
    }));
  }
  if (record.live) {
    const live = record.updateLiveState();
    const track = record.satelliteTrack;
    const entry = createRocketMissionElementOverlayEntry({
      id: `payload-position:${launchId}`,
      position: null,
      text: `${track ? shortMissionLabel(track.name, 22).toUpperCase() : 'EST. ORBIT POSITION'}\n${formatMissionEventTime(live.time)}`,
      accent: track ? '#7bed9f' : '#ffd166',
      priority: 900_000,
      gapPx: 12,
    });
    if (Number.isFinite(live.lon) && Number.isFinite(live.lat)) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [live.lon, live.lat] },
        properties: {
          launchId,
          kind: 'satellite',
          dot: 1,
          r: 4,
          color: entry.accent,
          title: entry.title,
          label: [entry.title, ...entry.details].join('\n'),
          altKm: Math.round((live.altitudeM || 0) / 1000),
          estimated: track ? 0 : 1,
        },
      });
    }
  }
  if (record.orbitLabelPosition) {
    const g = geodeticFromCartesian(record.orbitLabelPosition);
    if (g) {
      const entry = createRocketMissionElementOverlayEntry({
        id: `orbit:${launchId}`,
        position: null,
        text: record.satelliteTrack ? 'ORBIT' : 'PROJECTED ORBIT',
        accent: record.satelliteTrack ? '#22e6e6' : '#c084fc',
        priority: 800_000,
      });
      const shift = orbitShiftDeg(record, nowDate);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [((g.lon + shift + 540) % 360) - 180, g.lat] },
        properties: { launchId, kind: 'orbit-label', dot: 0, color: entry.accent, label: entry.title },
      });
    }
  }
  return fc(features.filter(Boolean));
}

/** Polígono de 500 m do pad (visível só com a missão selecionada e de perto). */
function buildPadFeatures() {
  const launch = _selectedLaunchId ? _launches.find((item) => item.id === _selectedLaunchId) : null;
  if (!launch || !_engine?.getCameraView) return EMPTY_FC;
  const view = _engine.getCameraView();
  const cameraHeightM = cameraAltitude();
  const cameraPosition = cartesianFromDegrees(view.lon, view.lat, cameraHeightM);
  const visible = launchPadZoneVisible({
    layerActive: _enabled,
    selectedLaunchId: _selectedLaunchId,
    launchId: launch.id,
    cameraHeightM,
    cameraDistanceM: distance(cameraPosition, cartesianFromDegrees(launch.lon, launch.lat)),
  });
  if (!visible) return EMPTY_FC;
  const ring = [];
  for (let i = 0; i <= 72; i++) {
    const p = destination({ lon: launch.lon, lat: launch.lat }, (i / 72) * 2 * Math.PI, LAUNCH_PAD_ZONE_RADIUS_M);
    ring.push([p.lon, p.lat]);
  }
  return fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { launchId: launch.id } }]);
}

function syncPadZone() {
  const pad = _enabled ? buildPadFeatures() : EMPTY_FC;
  const key = pad.features.length ? _selectedLaunchId : null;
  if (key === _padZoneLaunchId) return;
  _padZoneLaunchId = key;
  _lastFeatures.pad = pad;
  _setSource(SRC_PAD, pad);
}

/** Redesenha as fontes da camada a partir do estado (seleção, hover, replay). */
function renderMissionLayer() {
  if (!_enabled) {
    _lastFeatures.sites = EMPTY_FC;
    _lastFeatures.paths = EMPTY_FC;
    _lastFeatures.marks = EMPTY_FC;
  } else {
    const now = new Date();
    _lastFeatures.sites = buildSiteFeatures();
    _lastFeatures.paths = buildPathFeatures(now);
    _lastFeatures.marks = buildMarkFeatures(now);
  }
  _setSource(SRC_SITES, _lastFeatures.sites);
  _setSource(SRC_PATHS, _lastFeatures.paths);
  _setSource(SRC_MARKS, _lastFeatures.marks);
  _padZoneLaunchId = undefined;
  syncPadZone();
}

/** Tick lento (500 ms): posição viva, telemetria do painel, anéis ao GMST. */
let _lastSlowPathsMs = 0;
function slowTick() {
  if (!_enabled) return;
  updateMissionTelemetry();
  const now = new Date();
  if (_selectedLaunchId) {
    _lastFeatures.marks = buildMarkFeatures(now);
    _setSource(SRC_MARKS, _lastFeatures.marks);
  }
  const hasLiveOrbits = [..._missionRecords.values()].some((record) => record.orbitLive);
  if (hasLiveOrbits && now.getTime() - _lastSlowPathsMs >= 1000) {
    _lastSlowPathsMs = now.getTime();
    _lastFeatures.paths = buildPathFeatures(now);
    _setSource(SRC_PATHS, _lastFeatures.paths);
  }
  if (!_replayCameraLaunchId) updateReplayVehicleOverlay();
}

function startSlowLoop() {
  if (_slowTimer || typeof setInterval !== 'function' || !_engine?.map) return;
  _slowTimer = setInterval(slowTick, SLOW_TICK_MS);
}

function stopSlowLoop() {
  if (_slowTimer) clearInterval(_slowTimer);
  _slowTimer = null;
}

function installEngineListeners() {
  if (!_engine?.on || _engineListeners.length) return;
  _engineListeners = [
    _engine.on('moveend', () => { if (_enabled) syncPadZone(); }),
    // Arrastar/rolar durante o replay devolve a câmera ao usuário.
    _engine.on('movestart', (event) => {
      if (_replayCameraLaunchId && event?.originalEvent) stopMissionReplay();
    }),
  ];
}

function removeEngineListeners() {
  for (const off of _engineListeners) off?.();
  _engineListeners = [];
}

function attachToEngine(engine) {
  _engine = engine || null;
  if (!_engine?.map) return;
  _host = getActiveLayerHost();
  if (!_host) {
    console.warn('[Data:RocketLaunches] anfitrião de camadas MapLibre ausente');
    return;
  }
  _host.register(ROCKET_LAUNCHES_LAYER_DEF);
  _host.ensureAdded(ROCKET_LAUNCHES_LAYER_DEF);
}

function setHostVisible(visible) {
  if (_host && _engine?.map) _host.setVisible(LAYER_ID, visible);
}

function setSelectedMission(launchId, isolate = true) {
  if (launchId) clearMissionRosterHover();
  if (_replayCameraLaunchId && _replayCameraLaunchId !== launchId) stopMissionReplay();
  _selectedLaunchId = launchId;
  _explicitSelection = Boolean(launchId && isolate);
  if (launchId) _animationStarts.set(launchId, Date.now());
  renderMissionLayer();
  renderMissionPanel();
}

// ------------------------------------------------------------ ciclo

function clearPostTleRetry() {
  if (_retryTimer) clearTimeout(_retryTimer);
  _retryTimer = null;
}

function schedulePostTleRetry(token) {
  if (_retryTimer || token !== _lifecycleToken || !shouldRetryAfterActiveTle({
    enabled: _enabled,
    retryCount: _postTleRetryCount,
    activeTleText: _activeTleText,
    renderedTleText: _renderedTleText,
  })) return;
  _postTleRetryCount++;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    if (_enabled && token === _lifecycleToken) requestMissionUpdate();
  }, POST_TLE_RETRY_DELAY_MS);
}

function ensureActiveTleLookup(token) {
  if (_activeTleText) return Promise.resolve(_activeTleText);
  if (_activeTlePromise && _activeTlePromiseToken === token) return _activeTlePromise;
  const request = fetch('/api/celestrak/active')
    .then((activeResponse) => {
      if (!activeResponse.ok) throw new Error(`HTTP ${activeResponse.status}`);
      return activeResponse.text();
    })
    .then((text) => {
      if (!_enabled || token !== _lifecycleToken) return null;
      _activeTleText = text;
      _focusAfterActiveLookup = Boolean(_selectedLaunchId);
      schedulePostTleRetry(token);
      return text;
    })
    .catch((error) => {
      if (_enabled && token === _lifecycleToken) {
        console.warn('[Data:RocketLaunches] Active satellite lookup unavailable:', error.message);
      }
      return null;
    })
    .finally(() => {
      if (_activeTlePromise === request) {
        _activeTlePromise = null;
        _activeTlePromiseToken = 0;
      }
    });
  _activeTlePromise = request;
  _activeTlePromiseToken = token;
  return request;
}

async function captureSatelliteDependency() {
  if (!_dataManager || _satelliteStateBeforeMission) return;
  _satelliteStateBeforeMission = {
    // Effective visibility: a user enable still mid-activation is intent ON —
    // capturing settled false would restore the user's enable away on exit.
    enabled: _dataManager.isEffectivelyEnabled?.('satellites')
      ?? _dataManager.isEnabled('satellites'),
    params: satelliteParamsAfterSpaceMissions(
      _dataManager.getLayerParams('satellites'),
    ),
  };
  _dataManager.setLayerParams(
    'satellites',
    satelliteParamsForSpaceMissions(_satelliteStateBeforeMission.params),
  );
  const token = _lifecycleToken;
  const activation = Promise.resolve(_dataManager.setEnabled('satellites', true));
  _satelliteActivationPromise = activation;
  try {
    const activated = await activation;
    // Space Missions without its satellite dependency is a broken replay
    // surface; fail the mission enable so the manager's fail-closed path sees
    // an honest failure instead of a silent success.
    if (
      token === _lifecycleToken
      && _enabled
      && (activated === false || !_dataManager.isEnabled('satellites'))
    ) {
      throw new Error('Space Missions requires the satellites layer, which failed to start');
    }
  } finally {
    if (token === _lifecycleToken && _satelliteActivationPromise === activation) {
      _satelliteActivationPromise = null;
    }
  }
}

async function restoreSatelliteDependency() {
  const snapshot = _satelliteStateBeforeMission;
  if (!snapshot || !_dataManager) return;
  _satelliteStateBeforeMission = null;
  _satelliteActivationPromise = null;
  _dataManager.setLayerParams(
    'satellites',
    satelliteParamsAfterSpaceMissions(snapshot.params),
  );
  const restored = await _dataManager.setEnabled('satellites', snapshot.enabled);
  if (
    restored === false
    || _dataManager.isEnabled('satellites') !== snapshot.enabled
  ) {
    throw new Error('Space Missions could not restore the satellites layer');
  }
}

async function performMissionUpdate(token) {
  try {
    ensureActiveTleLookup(token);
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const launches = normalizeRocketLaunches(await response.json());
    if (!_enabled || token !== _lifecycleToken) return;
    const activeTleText = _activeTleText;
    if (_replayCameraLaunchId) stopMissionReplay();
    _launches = launches;
    _missionRecords.clear();
    _satelliteTelemetry.clear();
    _replayTracks.clear();
    _orbitMatches = 0;
    for (const launch of launches) _missionRecords.set(launch.id, buildMissionRecord(launch, activeTleText));
    _renderedTleText = activeTleText;
    if (_renderedTleText === _activeTleText) clearPostTleRetry();
    _count = launches.length;
    renderMissionRoster();
    if (!_selectedLaunchId || !launches.some((launch) => launch.id === _selectedLaunchId)) {
      setSelectedMission(null, false);
    } else {
      setSelectedMission(_selectedLaunchId, true);
      if (_focusAfterActiveLookup) {
        focusMission(launches.find((launch) => launch.id === _selectedLaunchId));
      }
    }
    _focusAfterActiveLookup = false;
    renderMissionPanel();
    _lastUpdate = Date.now();
    _lastError = null;
  } catch (error) {
    if (_enabled && token === _lifecycleToken) {
      _lastError = error.message;
      console.warn('[Data:RocketLaunches] Fetch error:', error);
    }
  }
}

function requestMissionUpdate() {
  if (!_enabled) return Promise.resolve();
  const token = _lifecycleToken;
  _updateDirty = true;
  if (_updatePromise && _updatePromiseToken === token) return _updatePromise;
  let request;
  request = (async () => {
    while (_enabled && token === _lifecycleToken && _updateDirty) {
      _updateDirty = false;
      await performMissionUpdate(token);
    }
  })().finally(() => {
    if (_updatePromise === request) {
      _updatePromise = null;
      _updatePromiseToken = 0;
    }
  });
  _updatePromise = request;
  _updatePromiseToken = token;
  return request;
}

const rocketLaunchesLayer = {
  id: LAYER_ID,
  name: 'Space Missions (30d)',
  icon: '🚀',
  source: 'Launch Library 2',
  maplibre: true,
  updateInterval: 300000,

  /** @param {object} engine motor MapLibre (src/maplibre/engine.js) */
  init(engine) {
    _enabled = false;
    attachToEngine(engine);
    createMissionPanel();
    createReplayVehicleOverlay();
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _orbitMatches = 0;
    installEngineListeners();
  },

  async enable() {
    _enabled = true;
    _lifecycleToken++;
    _postTleRetryCount = 0;
    try {
      await this._enableBody();
    } catch (error) {
      // Enable is a transaction: a failed dependency must not leave mission
      // UI visible or the satellite snapshot retained (a retained snapshot
      // makes the next enable skip dependency capture entirely).
      try {
        await this.disable();
      } catch (cleanupError) {
        console.warn('[Missions] enable rollback failed:', cleanupError);
      }
      throw error;
    }
  },
  async _enableBody() {
    _updateDirty = false;
    setHostVisible(true);
    installEngineListeners();
    startSlowLoop();
    focusFullGlobe();
    if (typeof document !== 'undefined') document.getElementById?.('cockpit-context')?.setAttribute('hidden', '');
    if (_selectedLaunchId) setSelectedMission(_selectedLaunchId, _explicitSelection);
    else setSelectedMission(null, false);
    await captureSatelliteDependency();
  },
  async disable() {
    _enabled = false;
    _lifecycleToken++;
    _updateDirty = false;
    clearPostTleRetry();
    clearMissionRosterHover();
    stopMissionReplay();
    stopSlowLoop();
    hideReplayVehicleOverlay();
    _selectedLaunchId = null;
    renderMissionLayer();
    setHostVisible(false);
    await restoreSatelliteDependency();
    renderMissionPanel();
  },

  update() {
    return requestMissionUpdate();
  },

  /** Release only Space Mission camera ownership, preserving layer and selection state. */
  releaseCameraOwnership() {
    clearMissionRosterHover();
    stopMissionReplay();
  },

  async destroy() {
    _enabled = false;
    _lifecycleToken++;
    _updateDirty = false;
    await restoreSatelliteDependency();
    clearMissionRosterHover();
    stopMissionReplay();
    stopSlowLoop();
    clearPostTleRetry();
    removeEngineListeners();
    renderMissionLayer();
    setHostVisible(false);
    destroyReplayVehicleOverlay();
    _launches = [];
    _missionRecords.clear();
    _animationStarts.clear();
    _satelliteTelemetry.clear();
    _replayTracks.clear();
    _missionPanel?.remove();
    _missionPanel = null;
    if (_missionRoster) {
      _missionRoster.onclick = null;
      _missionRoster.onmouseover = null;
      _missionRoster.onfocusin = null;
      _missionRoster.onmouseleave = null;
      _missionRoster.onfocusout = null;
    }
    _missionRoster = null;
    _engine = null;
    _host = null;
    _count = 0;
    _orbitMatches = 0;
    _lastUpdate = null;
    _activeTleText = null;
    _activeTlePromise = null;
    _activeTlePromiseToken = 0;
    _renderedTleText = null;
    _postTleRetryCount = 0;
    _satelliteStateBeforeMission = null;
    _satelliteActivationPromise = null;
    _dataManager = null;
  },

  getStats() { return { count: _count, orbitMatches: _orbitMatches, lastUpdate: _lastUpdate, error: _lastError }; },
  attachDataManager(dataManager) { _dataManager = dataManager; },
};

/** Test seam: the GeoJSON the layer last drew, per source. */
export function _missionFeaturesForTest() {
  return {
    sites: _lastFeatures.sites,
    paths: _lastFeatures.paths,
    marks: _lastFeatures.marks,
    pad: _lastFeatures.pad,
  };
}

/** Test seam that exercises the real selection/deselection path. */
export function _setSelectedRocketMissionForTest(launchId = null) {
  setSelectedMission(launchId, Boolean(launchId));
}

/** Test seam: start the real replay path for a mission (needs an engine). */
export function _startMissionReplayForTest(launchId) {
  return startMissionReplay(launchId);
}

/** Test seam: whether a replay currently owns the camera. */
export function _replayActiveLaunchForTest() {
  return _replayCameraLaunchId;
}

export default rocketLaunchesLayer;
