/**
 * One-click camera transfer for layer-owned world targets.
 *
 * `position` pode vir em graus `{lon, lat, height?}` (forma nova, das camadas
 * MapLibre) ou em ECEF `{x, y, z}` (forma Cesium, das camadas ainda não
 * portadas); os dois viram lon/lat antes do voo do motor MapLibre.
 */
const WGS84_A = 6378137;
const WGS84_B = 6356752.314245179;
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A) / (WGS84_B * WGS84_B) - 1;
const DEG = 180 / Math.PI;

/**
 * Posição do alvo em graus, ou null. Pura — exportada para testes.
 * @param {{lon?:number, lat?:number, height?:number, x?:number, y?:number, z?:number}} position
 * @returns {{lon:number, lat:number, height:number}|null}
 */
export function worldTargetLonLat(position) {
  if (!position || typeof position !== 'object') return null;
  if (Number.isFinite(position.lon) && Number.isFinite(position.lat)) {
    if (Math.abs(position.lat) > 90 || Math.abs(position.lon) > 540) return null;
    return { lon: position.lon, lat: position.lat, height: Number(position.height) || 0 };
  }
  const { x, y, z } = position;
  if (![x, y, z].every(Number.isFinite)) return null;
  const p = Math.hypot(x, y);
  const magnitude = Math.hypot(p, z);
  // Superfície da Terra: um ponto perto da origem ECEF não é voável.
  if (!(magnitude >= WGS84_B * 0.95)) return null;
  // Bowring (erro sub-milimétrico perto da superfície).
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * Math.sin(theta) ** 3,
    p - WGS84_E2 * WGS84_A * Math.cos(theta) ** 3,
  );
  const lon = Math.atan2(y, x);
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const height = p / Math.cos(lat) - n;
  return { lon: lon * DEG, lat: lat * DEG, height: Number.isFinite(height) ? height : 0 };
}

export const WORLD_FOCUS_REQUEST_EVENT = 'gev:world-request-focus';
export const WORLD_CLICK_FOCUS_DURATION_SEC = 1.9;

export const WORLD_FOCUS_FRAMING = Object.freeze({
  vessel: Object.freeze({ radiusM: 150, rangeM: 1200, pitchDeg: -30 }),
  fire: Object.freeze({ radiusM: 400, rangeM: 3000, pitchDeg: -35 }),
});

/** Validate a layer-owned focus target before camera policy can release tracking. */
export function isValidWorldFocusTarget(detail) {
  if (!detail || !WORLD_FOCUS_FRAMING[detail.kind]) return false;
  if (!String(detail.id || '').trim()) return false;
  return worldTargetLonLat(detail.position) !== null;
}

/** Announce a valid user-click focus request. */
export function requestWorldFocus(detail, eventTarget = globalThis.window) {
  if (!isValidWorldFocusTarget(detail)) return false;
  if (typeof eventTarget?.dispatchEvent !== 'function') return false;
  eventTarget.dispatchEvent(new CustomEvent(WORLD_FOCUS_REQUEST_EVENT, { detail }));
  return true;
}

/** Register one listener and return an idempotent disposer. */
export function registerWorldFocusRequestListener(eventTarget, listener) {
  if (!eventTarget?.addEventListener || !eventTarget?.removeEventListener
    || typeof listener !== 'function') return () => {};
  eventTarget.addEventListener(WORLD_FOCUS_REQUEST_EVENT, listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    eventTarget.removeEventListener(WORLD_FOCUS_REQUEST_EVENT, listener);
  };
}

/** Route a valid request through the UI-owned camera policy. */
export function routeWorldFocusRequest(event, runExplicitFocus, fly) {
  const detail = event?.detail;
  if (!isValidWorldFocusTarget(detail)) return false;
  if (typeof runExplicitFocus !== 'function' || typeof fly !== 'function') return false;
  return runExplicitFocus(detail, () => fly(detail));
}

/** Fly to a world target after ownership has been released. */
export function flyToWorldTarget(engine, target = {}) {
  const framing = WORLD_FOCUS_FRAMING[target.kind];
  if (!engine?.flyToTarget || !framing || !isValidWorldFocusTarget(target)) return false;
  const where = worldTargetLonLat(target.position);
  const view = engine.getCameraView?.();
  const heading = Number.isFinite(view?.heading) ? view.heading : 0;
  const duration = target.durationSec > 0
    ? target.durationSec
    : WORLD_CLICK_FOCUS_DURATION_SEC;
  engine.cancelFlight?.();
  // O raio de enquadramento (`radiusM`) era a esfera do Cesium; aqui a
  // distância `rangeM` já enquadra o alvo com folga.
  engine.flyToTarget(
    { lon: where.lon, lat: where.lat, height: 0 },
    {
      rangeM: framing.rangeM,
      heading,
      pitch: framing.pitchDeg,
      duration,
    },
  );
  return true;
}
