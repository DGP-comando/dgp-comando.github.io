// src/data/spaceGeo.js
//
// Geometria espacial neutra (sem Cesium) para satélites e missões espaciais.
//
// Os módulos src/data/satellites.js e src/data/rocketLaunches.js calculavam
// órbitas e trajetórias com Cesium.Cartesian3 / Ellipsoid / EllipsoidGeodesic.
// Com a migração para o MapLibre, as mesmas contas passam a usar objetos
// simples {x, y, z} em ECEF (metros, elipsoide WGS84) — o mesmo "formato" de um
// Cartesian3, então código que só lê .x/.y/.z continua funcionando — e
// coordenadas geodésicas {lon, lat, height} em GRAUS e metros.
//
// A geodésica é aproximada pela esfera (círculo máximo) — para desenhar e animar
// uma trajetória de subida estimada a diferença para a geodésica do elipsoide é
// desprezível.

export const WGS84_A = 6378137.0; // raio equatorial = Ellipsoid.WGS84.maximumRadius
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
export const EARTH_MEAN_RADIUS_M = 6371008.8;

export const DEG = Math.PI / 180;
export const toRadians = (deg) => deg * DEG;
export const toDegrees = (rad) => rad / DEG;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;
/** Módulo sempre positivo (Cesium.Math.mod). */
export const mod = (m, n) => ((m % n) + n) % n;
export const zeroToTwoPi = (angle) => {
  if (angle >= 0 && angle <= 2 * Math.PI) return angle;
  const value = mod(angle, 2 * Math.PI);
  return Math.abs(value) < 1e-14 && Math.abs(angle) > 1e-14 ? 2 * Math.PI : value;
};
export const negativePiToPi = (angle) => {
  if (angle >= -Math.PI && angle <= Math.PI) return angle;
  return zeroToTwoPi(angle + Math.PI) - Math.PI;
};

// ------------------------------------------------------------- vetores

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const clone = (p) => (p ? { x: p.x, y: p.y, z: p.z } : p);
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const magnitudeSquared = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const magnitude = (a) => Math.sqrt(magnitudeSquared(a));
export const normalize = (a) => {
  const m = magnitude(a);
  return m > 0 ? { x: a.x / m, y: a.y / m, z: a.z / m } : { x: 0, y: 0, z: 0 };
};
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const lerpVec = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

// ------------------------------------------------------ ECEF <-> geodésico

/** Cartesian3.fromDegrees: (lon, lat em graus, altura em m) -> ECEF WGS84. */
export function cartesianFromDegrees(lon, lat, height = 0) {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const h = Number(height) || 0;
  return {
    x: (n + h) * cosPhi * Math.cos(lambda),
    y: (n + h) * cosPhi * Math.sin(lambda),
    z: (n * (1 - WGS84_E2) + h) * sinPhi,
  };
}

/**
 * ECEF -> {lon, lat (graus), height (m)} (método de Bowring, precisão sub-métrica
 * até a órbita geoestacionária). null para entrada inválida ou a origem.
 */
export function geodeticFromCartesian(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  const { x, y, z } = p;
  const r = Math.hypot(x, y);
  if (r < 1e-9 && Math.abs(z) < 1e-9) return null;
  const lon = Math.atan2(y, x);
  const theta = Math.atan2(z * WGS84_A, r * WGS84_B);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  let lat = Math.atan2(z + WGS84_EP2 * WGS84_B * sinT ** 3, r - WGS84_E2 * WGS84_A * cosT ** 3);
  let height = 0;
  // Bowring é exato no chão; duas iterações de ponto fixo o tornam exato
  // também em altitude orbital (GEO).
  for (let i = 0; i < 3; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const cosLat = Math.cos(lat);
    height = Math.abs(cosLat) > 1e-10 ? r / cosLat - n : Math.abs(z) - WGS84_B;
    if (i < 2 && Math.abs(cosLat) > 1e-10) lat = Math.atan2(z, r * (1 - WGS84_E2 * n / (n + height)));
  }
  return { lon: lon / DEG, lat: lat / DEG, height };
}

// --------------------------------------------------- geodésica (esfera)

/** Distância angular (rad) entre dois pontos {lon, lat} em graus. */
export function angularDistance(a, b) {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dl = (b.lon - a.lon) * DEG;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distância de superfície (m) entre dois pontos {lon, lat}. */
export const surfaceDistance = (a, b) => angularDistance(a, b) * EARTH_MEAN_RADIUS_M;

/** Rumo inicial (rad, 0 = norte, horário) de a para b. */
export function initialBearing(a, b) {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dl = (b.lon - a.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/** Ponto a uma fração `f` do círculo máximo entre a e b ({lon, lat} em graus). */
export function interpolateGreatCircle(a, b, f) {
  const d = angularDistance(a, b);
  if (d < 1e-12) return { lon: a.lon, lat: a.lat };
  const p1 = a.lat * DEG;
  const l1 = a.lon * DEG;
  const p2 = b.lat * DEG;
  const l2 = b.lon * DEG;
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lon: Math.atan2(y, x) / DEG, lat: Math.atan2(z, Math.hypot(x, y)) / DEG };
}

/** Ponto a `distM` metros de {lon, lat} no rumo `bearingRad`. */
export function destination(from, bearingRad, distM) {
  const d = distM / EARTH_MEAN_RADIUS_M;
  const p1 = from.lat * DEG;
  const l1 = from.lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearingRad));
  const l2 = l1 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lon: toDegrees(negativePiToPi(l2)), lat: p2 / DEG };
}

// ----------------------------------------------------- esfera envolvente

/** Esfera envolvente simples {center, radius} (centróide + maior distância). */
export function boundingSphereFromPoints(points) {
  if (!points?.length) return { center: vec(), radius: 0 };
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  const center = { x: cx / points.length, y: cy / points.length, z: cz / points.length };
  let radius = 0;
  for (const p of points) radius = Math.max(radius, distance(center, p));
  return { center, radius };
}

/** União de duas esferas {center, radius}. */
export function boundingSphereUnion(a, b) {
  const d = distance(a.center, b.center);
  if (d + b.radius <= a.radius) return { center: clone(a.center), radius: a.radius };
  if (d + a.radius <= b.radius) return { center: clone(b.center), radius: b.radius };
  const radius = (d + a.radius + b.radius) / 2;
  const t = d > 0 ? (radius - a.radius) / d : 0;
  return { center: lerpVec(a.center, b.center, t), radius };
}

// ------------------------------------------------ linhas para o MapLibre

/**
 * Converte um caminho ECEF numa lista de [lon, lat] com longitudes
 * "desembrulhadas" (sem saltos de ±360 ao cruzar o antimeridiano), que é o que
 * o MapLibre precisa para desenhar a linha contínua (mercator e globo).
 * `lonShiftDeg` gira o caminho em torno do eixo Z (correção de GMST de um anel
 * orbital assado noutro instante: rotação rígida em Z = deslocar a longitude).
 */
export function pathToLonLat(path, { lonShiftDeg = 0 } = {}) {
  const out = [];
  let prev = null;
  for (const p of path || []) {
    const g = geodeticFromCartesian(p);
    if (!g) continue;
    let lon = g.lon + lonShiftDeg;
    if (prev !== null) {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    } else {
      lon = ((lon + 540) % 360) - 180;
    }
    out.push([lon, g.lat]);
    prev = lon;
  }
  return out;
}
