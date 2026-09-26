/**
 * @module scenes/sceneCamera
 *
 * Conversão entre a câmera dos shots (SEMÂNTICA CESIUM: posição da câmera
 * lat/lon/alt em metros, heading, pitch -90 = nadir) e a câmera do MapLibre
 * (centro, zoom, bearing, pitch a partir da vertical no centro), sobre a
 * esfera — sem Cesium e sem maplibre-gl, para rodar também em node --test.
 *
 * Por que esfera: os shots das receitas ficam a milhares de km de altura.
 * Numa conversão plana (mercator), olhar 25° fora do nadir a 19 000 km
 * "acerta o chão" 8 000 km adiante, no polo; na esfera o raio encontra o
 * globo bem mais perto, que é o que o Cesium mostrava.
 *
 * Escala: o MapLibre usa 512 px por tile e mpp = 2πR·cos(lat)/(512·2^zoom)
 * no centro, com a câmera a `0.5·H / tan(fov/2)` px do centro.
 */

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const TILE_PX = 512;
const DEFAULT_FOV_DEG = 36.86989764584402;

/** Ponto a `distM` metros de (lat, lon) na direção `bearingDeg` (esfera). */
export function sphericalDestination(lat, lon, bearingDeg, distM) {
  const d = distM / EARTH_RADIUS_M;
  const b = bearingDeg * DEG;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: ((l2 / DEG + 540) % 360) - 180 };
}

/** Rumo inicial (graus) do grande círculo de (lat1, lon1) até (lat2, lon2). */
export function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Distância câmera→centro em px, como o MapLibre calcula. */
export function cameraToCenterPx(viewportHeight, fovDeg = DEFAULT_FOV_DEG) {
  const h = Math.max(1, Number(viewportHeight) || 1);
  return (0.5 * h) / Math.tan((Number(fovDeg) || DEFAULT_FOV_DEG) * DEG / 2);
}

function metersPerPixel(lat, zoom) {
  return (2 * Math.PI * EARTH_RADIUS_M * Math.max(1e-6, Math.cos(lat * DEG))) / (TILE_PX * 2 ** zoom);
}

/**
 * Câmera de shot (semântica Cesium) -> opções de câmera do MapLibre.
 * @param {{lat:number, lon:number, alt:number, heading?:number, pitch?:number}} camera
 * @param {{viewportHeight:number, fovDeg?:number, maxPitch?:number, minZoom?:number, maxZoom?:number}} viewport
 * @returns {{center:[number, number], zoom:number, bearing:number, pitch:number}|null}
 */
export function sceneCameraToMapView(camera, { viewportHeight, fovDeg = DEFAULT_FOV_DEG, maxPitch = 85, minZoom = -2, maxZoom = 22 } = {}) {
  const lat = Number(camera?.lat);
  const lon = Number(camera?.lon);
  const alt = Math.max(1, Number(camera?.alt) || 0);
  if (![lat, lon, alt].every(Number.isFinite)) return null;
  const heading = ((Number(camera?.heading) || 0) % 360 + 360) % 360;
  const R = EARTH_RADIUS_M;
  const D = R + alt;
  // Ângulo do raio de visada a partir do nadir, limitado para ainda tocar o globo.
  // Se o raio passa acima do horizonte (o Cesium mostrava o globo na parte de
  // baixo da tela), o MapLibre não centra no espaço: a visada desce até 60%
  // do ângulo do horizonte, que mantém o globo inteiro no quadro.
  let offNadir = Math.max(0, Math.min(89, 90 + (Number.isFinite(Number(camera?.pitch)) ? Number(camera.pitch) : -90)));
  const horizon = Math.asin(R / D) / DEG;
  if (offNadir > horizon * 0.95) offNadir = horizon * 0.6;
  const a = offNadir * DEG;
  const disc = R * R - D * D * Math.sin(a) ** 2;
  const s = D * Math.cos(a) - Math.sqrt(Math.max(0, disc));
  const theta = Math.asin(Math.min(1, (s * Math.sin(a)) / R));
  const target = sphericalDestination(lat, lon, heading, R * theta);
  const pitch = Math.min(maxPitch, (a + theta) / DEG);
  // O "para cima" da tela no centro é o rumo FINAL do grande círculo câmera→alvo.
  const bearing = theta > 1e-9
    ? (initialBearing(target.lat, target.lon, lat, lon) + 180) % 360
    : heading;
  const mpp = s / cameraToCenterPx(viewportHeight, fovDeg);
  const zoomRaw = Math.log2((2 * Math.PI * R * Math.max(1e-6, Math.cos(target.lat * DEG))) / (TILE_PX * mpp));
  const zoom = Math.max(minZoom, Math.min(maxZoom, zoomRaw));
  return { center: [target.lon, target.lat], zoom, bearing, pitch };
}

/**
 * Câmera do MapLibre (centro/zoom/bearing/pitch) -> câmera de shot (semântica Cesium).
 * @param {{centerLat:number, centerLon:number, zoom:number, bearing?:number, pitch?:number}} view
 * @param {{viewportHeight:number, fovDeg?:number}} viewport
 * @returns {{lat:number, lon:number, alt:number, heading:number, pitch:number, roll:number}|null}
 */
export function mapViewToSceneCamera({ centerLat, centerLon, zoom, bearing = 0, pitch = 0 }, { viewportHeight, fovDeg = DEFAULT_FOV_DEG } = {}) {
  if (![centerLat, centerLon, zoom].every(Number.isFinite)) return null;
  const R = EARTH_RADIUS_M;
  const s = cameraToCenterPx(viewportHeight, fovDeg) * metersPerPixel(centerLat, zoom);
  const beta = Math.max(0, Math.min(89.9, Number(pitch) || 0)) * DEG;
  const D = Math.sqrt(R * R + s * s + 2 * R * s * Math.cos(beta));
  const theta = Math.atan2(s * Math.sin(beta), R + s * Math.cos(beta));
  const mapBearing = ((Number(bearing) || 0) % 360 + 360) % 360;
  const cam = sphericalDestination(centerLat, centerLon, (mapBearing + 180) % 360, R * theta);
  const heading = theta > 1e-9 ? initialBearing(cam.lat, cam.lon, centerLat, centerLon) : mapBearing;
  const offNadir = (beta - theta) / DEG;
  return { lat: cam.lat, lon: cam.lon, alt: D - R, heading, pitch: offNadir - 90, roll: 0 };
}

/** Câmera atual do mapa MapLibre como câmera de shot, ou null. */
export function sceneCameraFromMap(map) {
  if (!map?.getCenter) return null;
  try {
    const c = map.getCenter();
    return mapViewToSceneCamera(
      { centerLat: c.lat, centerLon: c.lng, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() },
      { viewportHeight: map.getContainer().clientHeight, fovDeg: map.getVerticalFieldOfView?.() },
    );
  } catch {
    return null;
  }
}

/** Opções de câmera do MapLibre para um shot, no mapa dado, ou null. */
export function mapViewForSceneCamera(map, camera) {
  if (!map?.getContainer) return null;
  return sceneCameraToMapView(camera, {
    viewportHeight: map.getContainer().clientHeight,
    fovDeg: map.getVerticalFieldOfView?.(),
    maxPitch: map.getMaxPitch?.() ?? 85,
    minZoom: map.getMinZoom?.() ?? -2,
    maxZoom: map.getMaxZoom?.() ?? 22,
  });
}
