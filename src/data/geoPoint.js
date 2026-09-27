// src/data/geoPoint.js
//
// POSIÇÃO NEUTRA (substitui o Cesium.Cartesian3 nas APIs públicas das camadas)
// ============================================================================
//
// As camadas do GEV devolviam `position: Cesium.Cartesian3` (ECEF, metros) em
// findByQuery/getNearby/getAllPositions/getDetectableObjects. No MapLibre não
// há Cartesian3; o formato neutro é um objeto congelado com as DUAS leituras:
//
//   { lon, lat, height,   // graus WGS84 e altura elipsoidal (m)
//     x, y, z }           // o mesmo ponto em ECEF WGS84 (m)
//
// A parte geodésica é o que o MapLibre usa (engine.project(lon, lat)). A parte
// ECEF mantém funcionando, durante a migração, quem ainda mede distância em
// linha reta ou valida magnitude com x/y/z (militaryAwareness, detection,
// worldFocus), sem importar o Cesium aqui. Puro: sem DOM, sem Cesium.

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const DEG = Math.PI / 180;

/**
 * Ponto neutro a partir de graus e altura elipsoidal.
 * @param {number} lon
 * @param {number} lat
 * @param {number} [height=0]
 * @returns {Readonly<{lon:number,lat:number,height:number,x:number,y:number,z:number}>|null}
 */
export function geoPoint(lon, lat, height = 0) {
  const lo = Number(lon);
  const la = Number(lat);
  const h = Number.isFinite(Number(height)) ? Number(height) : 0;
  if (!Number.isFinite(lo) || !Number.isFinite(la) || la < -90 || la > 90) return null;
  const phi = la * DEG;
  const lambda = lo * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  return Object.freeze({
    lon: lo,
    lat: la,
    height: h,
    x: (n + h) * cosPhi * Math.cos(lambda),
    y: (n + h) * cosPhi * Math.sin(lambda),
    z: (n * (1 - WGS84_E2) + h) * sinPhi,
  });
}

/** ECEF (m) -> geodésico (Bowring, erro sub-milimétrico perto da superfície). */
function fromEcef(x, y, z) {
  const p = Math.hypot(x, y);
  if (!(p > 0) && !(Math.abs(z) > 0)) return null;
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const phi = Math.atan2(z + WGS84_EP2 * WGS84_B * sinT ** 3, p - WGS84_E2 * WGS84_A * cosT ** 3);
  const sinPhi = Math.sin(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const height = Math.abs(Math.cos(phi)) > 1e-9 ? p / Math.cos(phi) - n : Math.abs(z) - WGS84_B;
  return geoPoint(Math.atan2(y, x) / DEG, phi / DEG, height);
}

/**
 * Normaliza qualquer posição aceita pelas APIs públicas: ponto neutro,
 * `{lon, lat, height?}`, `{longitude, latitude, height?}` ou ECEF `{x, y, z}`
 * (um Cesium.Cartesian3 antigo continua servindo).
 * @param {object|null|undefined} value
 * @returns {ReturnType<typeof geoPoint>}
 */
export function toGeoPoint(value) {
  if (!value || typeof value !== 'object') return null;
  const lon = value.lon ?? value.longitude;
  const lat = value.lat ?? value.latitude;
  if (lon !== null && lat !== null && Number.isFinite(Number(lon)) && Number.isFinite(Number(lat))) {
    return geoPoint(lon, lat, value.height ?? value.alt ?? 0);
  }
  if ([value.x, value.y, value.z].every(Number.isFinite)) return fromEcef(value.x, value.y, value.z);
  return null;
}

/**
 * Distância em linha reta (m) entre duas posições em qualquer formato aceito
 * por toGeoPoint — a mesma métrica do antigo Cesium.Cartesian3.distance.
 * @returns {number} NaN quando alguma posição é inválida.
 */
export function geoDistanceM(a, b) {
  const p = toGeoPoint(a);
  const q = toGeoPoint(b);
  if (!p || !q) return Number.NaN;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}
