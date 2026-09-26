// src/voice/geo3d.js
//
// Geometria 3D mínima (WGS84/ECEF) que a voz, os verbos de câmera e as
// anotações usavam do Cesium. Sem dependências: vetores são objetos
// `{x, y, z}` (compatíveis por forma com Cesium.Cartesian3, então camadas que
// ainda devolvem Cartesian3 continuam funcionando) e cartográficos seguem a
// convenção do Cesium (`latitude`/`longitude` em RADIANOS, `height` em metros).
//
// A API espelha os nomes do Cesium (Cartesian3.fromDegrees, .distance, .dot,
// Cartographic.fromCartesian, WGS84.geodeticSurfaceNormal…) para o porte ser
// mecânico; parâmetros `result` são aceitos e preenchidos quando dados.

const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142451793;
const E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A); // excentricidade²
const EP2 = (WGS84_A * WGS84_A) / (WGS84_B * WGS84_B) - 1;
const DEG = Math.PI / 180;

const out = (result) => result || { x: 0, y: 0, z: 0 };
const set = (r, x, y, z) => {
  r.x = x;
  r.y = y;
  r.z = z;
  return r;
};

export const GeoMath = Object.freeze({
  toRadians: (deg) => deg * DEG,
  toDegrees: (rad) => rad / DEG,
  negativePiToPi(rad) {
    let a = ((rad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (a === -Math.PI && rad > 0) a = Math.PI;
    return a;
  },
});

export const Cartesian3 = Object.freeze({
  fromElements: (x, y, z, result) => set(out(result), x, y, z),
  clone: (v, result) => (v ? set(out(result), v.x, v.y, v.z) : undefined),
  add: (a, b, result) => set(out(result), a.x + b.x, a.y + b.y, a.z + b.z),
  subtract: (a, b, result) => set(out(result), a.x - b.x, a.y - b.y, a.z - b.z),
  multiplyByScalar: (a, s, result) => set(out(result), a.x * s, a.y * s, a.z * s),
  divideByScalar: (a, s, result) => set(out(result), a.x / s, a.y / s, a.z / s),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross(a, b, result) {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    return set(out(result), x, y, z);
  },
  magnitude: (a) => Math.hypot(a.x, a.y, a.z),
  normalize(a, result) {
    const m = Math.hypot(a.x, a.y, a.z) || 1;
    return set(out(result), a.x / m, a.y / m, a.z / m);
  },
  distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  lerp: (a, b, t, result) => set(out(result), a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t),
  /** ECEF a partir de lon/lat em graus e altura elipsoidal em metros. */
  // Assinatura do Cesium: (lon, lat, height, ellipsoid?, result?) — o elipsoide é sempre WGS84.
  fromDegrees: (lon, lat, height = 0, _ellipsoid, result) => fromRadians(lon * DEG, lat * DEG, height, result),
  fromRadians: (lon, lat, height = 0, _ellipsoid, result) => fromRadians(lon, lat, height, result),
});

function fromRadians(lon, lat, height = 0, result) {
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const h = Number(height) || 0;
  return set(out(result), (n + h) * cosLat * Math.cos(lon), (n + h) * cosLat * Math.sin(lon), (n * (1 - E2) + h) * sinLat);
}

export const Cartographic = Object.freeze({
  /** Cartográfico (radianos) de um ponto ECEF; undefined perto do centro da Terra. */
  fromCartesian(p, _ellipsoid, result) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return undefined;
    const r = Math.hypot(p.x, p.y);
    if (r < 1 && Math.abs(p.z) < 1) return undefined;
    // Bowring (uma iteração basta para precisão sub-milimétrica na superfície).
    const theta = Math.atan2(p.z * WGS84_A, r * WGS84_B);
    const lat = Math.atan2(p.z + EP2 * WGS84_B * Math.sin(theta) ** 3, r - E2 * WGS84_A * Math.cos(theta) ** 3);
    const lon = Math.atan2(p.y, p.x);
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
    const height = Math.abs(Math.cos(lat)) > 1e-10 ? r / Math.cos(lat) - n : Math.abs(p.z) - WGS84_B;
    const res = result || {};
    res.longitude = lon;
    res.latitude = lat;
    res.height = height;
    return res;
  },
  fromDegrees(lon, lat, height = 0, result) {
    const res = result || {};
    res.longitude = lon * DEG;
    res.latitude = lat * DEG;
    res.height = height;
    return res;
  },
});

export const WGS84 = Object.freeze({
  /** Normal geodésica (vetor "para cima" local) sob um ponto ECEF. */
  geodeticSurfaceNormal(p, result) {
    return Cartesian3.normalize({ x: p.x / (WGS84_A * WGS84_A), y: p.y / (WGS84_A * WGS84_A), z: p.z / (WGS84_B * WGS84_B) }, result);
  },
  geodeticSurfaceNormalCartographic(c, result) {
    const cosLat = Math.cos(c.latitude);
    return set(out(result), cosLat * Math.cos(c.longitude), cosLat * Math.sin(c.longitude), Math.sin(c.latitude));
  },
});

/** Rotação de `v` por `angle` (rad, regra da mão direita) em torno do eixo unitário `axis` (Rodrigues). */
export function rotateAboutAxis(v, axis, angle, result) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = Cartesian3.dot(axis, v) * (1 - c);
  const cx = axis.y * v.z - axis.z * v.y;
  const cy = axis.z * v.x - axis.x * v.z;
  const cz = axis.x * v.y - axis.y * v.x;
  return set(out(result), v.x * c + cx * s + axis.x * d, v.y * c + cy * s + axis.y * d, v.z * c + cz * s + axis.z * d);
}

/** Base local leste/norte/cima em lon/lat (graus). */
export function enuAt(lonDeg, latDeg) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  return {
    east: { x: -Math.sin(lon), y: Math.cos(lon), z: 0 },
    north: { x: -Math.sin(lat) * Math.cos(lon), y: -Math.sin(lat) * Math.sin(lon), z: Math.cos(lat) },
    up: { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) },
  };
}

/**
 * Ponto geográfico "de duas caras": ECEF (`x, y, z`, para APIs que ainda
 * esperam um Cartesian3) e graus (`lon/lat`, `longitude/latitude`, `height`).
 */
export function geoPoint(lon, lat, height = 0) {
  const p = Cartesian3.fromDegrees(lon, lat, height);
  return { x: p.x, y: p.y, z: p.z, lon, lat, longitude: lon, latitude: lat, height };
}

/**
 * {lon, lat, height} em graus de qualquer forma de posição que as camadas
 * usam: {lon, lat}, {lng, lat}, {longitude, latitude} (graus) ou ECEF {x, y, z}.
 */
export function toLonLat(position) {
  if (!position || typeof position !== 'object') return null;
  const lon = position.lon ?? position.lng ?? position.longitude;
  const lat = position.lat ?? position.latitude;
  if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 360) {
    return { lon, lat, height: Number(position.height ?? position.alt ?? position.altitude ?? 0) || 0 };
  }
  const carto = Cartographic.fromCartesian(position);
  if (!carto) return null;
  return { lon: carto.longitude / DEG, lat: carto.latitude / DEG, height: carto.height };
}

/** Distância de grande círculo em km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const radiusKm = 6371.0088;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Centro e raio (m) de um conjunto de posições (qualquer forma aceita por toLonLat). */
export function boundingCircle(positions) {
  const pts = (positions || []).map(toLonLat).filter(Boolean);
  if (!pts.length) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of pts) {
    const c = Cartesian3.fromDegrees(p.lon, p.lat, 0);
    x += c.x;
    y += c.y;
    z += c.z;
  }
  const center = toLonLat({ x: x / pts.length, y: y / pts.length, z: z / pts.length });
  let radiusM = 0;
  for (const p of pts) radiusM = Math.max(radiusM, haversineKm(center.lat, center.lon, p.lat, p.lon) * 1000);
  const west = Math.min(...pts.map((p) => p.lon));
  const east = Math.max(...pts.map((p) => p.lon));
  const south = Math.min(...pts.map((p) => p.lat));
  const north = Math.max(...pts.map((p) => p.lat));
  return { lon: center.lon, lat: center.lat, radiusM, bbox: [west, south, east, north] };
}

/**
 * Pose da câmera do motor (engine.getCameraView) com a ALTITUDE garantida.
 * Se o motor não conseguir ler a altitude (no MapLibre 6 `map.transform` não é
 * público e getCameraView devolve alt NaN), ela é estimada pela geometria da
 * câmera: distância câmera→centro em px (fov vertical) × metros por px no
 * zoom/latitude do centro × cos(pitch), mais a elevação do centro com relevo.
 * @returns {object|null} {lat, lon, alt, heading, pitch, roll, zoom, …} ou null.
 */
export function cameraViewOf(engine) {
  let view = null;
  try {
    view = engine?.getCameraView?.() || null;
  } catch {
    return null;
  }
  if (!view || Number.isFinite(view.alt)) return view;
  const map = engine?.map;
  try {
    const heightPx = map.getContainer().clientHeight;
    const fov = (Number(map.getVerticalFieldOfView?.()) || 36.87) * DEG;
    const distancePx = (0.5 / Math.tan(fov / 2)) * heightPx;
    const center = map.getCenter();
    const metersPerPx = (2 * Math.PI * WGS84_A * Math.cos(center.lat * DEG)) / (512 * 2 ** map.getZoom());
    const ground = engine.hasTerrain?.() ? Number(map.queryTerrainElevation?.(center)) || 0 : 0;
    const alt = distancePx * metersPerPx * Math.cos(map.getPitch() * DEG) + ground;
    return Number.isFinite(alt) ? { ...view, alt } : view;
  } catch {
    return view;
  }
}
