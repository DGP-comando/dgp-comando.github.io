/**
 * @module worldGeometry
 * @description Geometria de mundo NEUTRA (sem Cesium) para os overlays de tela
 * (world overlay, detecção, leitura do alvo): posições, distância à câmera,
 * horizonte do globo e projeção pelo motor MapLibre (src/maplibre/engine.js).
 *
 * POSIÇÃO DE MUNDO aceita por todo o pipeline (WorldPosition):
 *   - `{lon, lat, height?}` em graus/metros — FORMA PREFERIDA. `alt` e
 *     `altitude` valem como sinônimos de `height`; altura ausente = 0.
 *   - `{x, y, z}` ECEF WGS84 em metros (o antigo `Cesium.Cartesian3`) — aceita
 *     durante a migração; é convertida para lon/lat/altura elipsoidal.
 *
 * Modelo interno: o MapLibre desenha uma ESFERA (raio 6 371 008,8 m) e mede a
 * altitude da câmera acima do nível do mar. Por isso distância e horizonte são
 * calculados nessa esfera (`sphereXyz`), a mesma do globo que se vê na tela.
 *
 * A projeção para a tela é a do próprio mapa: `engine.projectInto(resolved,
 * out)` quando existir (mocks de teste; recebe o objeto resolvido para não
 * encaixotar doubles), senão `engine.map.project([lon, lat])`. A altura NÃO desloca o ponto na tela —
 * o MapLibre projeta no chão, exatamente onde as camadas desenham seus
 * símbolos, então caixa/card e ícone continuam juntos.
 */

const DEG = Math.PI / 180;

/** Elipsoide WGS84 (para converter ECEF legado). */
export const WGS84 = Object.freeze({
  a: 6_378_137,
  b: 6_356_752.314245179,
  e2: 1 - (6_356_752.314245179 ** 2) / (6_378_137 ** 2),
  ep2: (6_378_137 ** 2) / (6_356_752.314245179 ** 2) - 1,
});

/** Raio da esfera do MapLibre (o mesmo do engine.js). */
export const SPHERE_RADIUS_M = 6_371_008.8;

/**
 * lon/lat/altura elipsoidal → ECEF WGS84.
 * @param {number} lonDeg @param {number} latDeg @param {number} [heightM=0]
 * @param {{x:number,y:number,z:number}} [out]
 */
export function geodeticToEcef(lonDeg, latDeg, heightM = 0, out = { x: 0, y: 0, z: 0 }) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84.a / Math.sqrt(1 - WGS84.e2 * sinLat * sinLat);
  const h = Number.isFinite(heightM) ? heightM : 0;
  out.x = (n + h) * cosLat * Math.cos(lon);
  out.y = (n + h) * cosLat * Math.sin(lon);
  out.z = (n * (1 - WGS84.e2) + h) * sinLat;
  return out;
}

/**
 * ECEF WGS84 → lon/lat/altura elipsoidal (Bowring). Devolve null para o
 * centro da Terra ou entradas não finitas.
 * @param {number} x @param {number} y @param {number} z
 * @param {{lon:number,lat:number,height:number}} [out]
 */
export function ecefToGeodetic(x, y, z, out = { lon: 0, lat: 0, height: 0 }) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const p = Math.sqrt(x * x + y * y);
  if (p === 0 && z === 0) return null;
  const { a, b, e2, ep2 } = WGS84;
  const theta = Math.atan2(z * a, p * b);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lat = Math.atan2(z + ep2 * b * sinT * sinT * sinT, p - e2 * a * cosT * cosT * cosT);
  const sinLat = Math.sin(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const height = Math.abs(lat) < Math.PI / 4
    ? p / Math.cos(lat) - n
    : z / sinLat - n * (1 - e2);
  out.lon = p === 0 ? 0 : Math.atan2(y, x) / DEG;
  out.lat = lat / DEG;
  out.height = height;
  return out;
}

/** lon/lat/altura → xyz na esfera do MapLibre. */
export function sphereXyz(lonDeg, latDeg, heightM = 0, out = { x: 0, y: 0, z: 0 }) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const r = SPHERE_RADIUS_M + (Number.isFinite(heightM) ? heightM : 0);
  const cosLat = Math.cos(lat);
  out.x = r * cosLat * Math.cos(lon);
  out.y = r * cosLat * Math.sin(lon);
  out.z = r * Math.sin(lat);
  return out;
}

function readHeight(position) {
  const h = position.height ?? position.alt ?? position.altitude;
  return h === undefined || h === null ? 0 : Number(h);
}

/**
 * Normaliza uma WorldPosition em `out` = {lon, lat, height, x, y, z}, onde
 * x/y/z é o ponto na esfera do MapLibre. Sem alocação quando `out` é
 * reaproveitado. Devolve false para posição inválida.
 * @param {object} position WorldPosition (ver cabeçalho)
 * @param {{lon:number,lat:number,height:number,x:number,y:number,z:number}} out
 * @returns {boolean}
 */
export function resolveWorldPosition(position, out) {
  if (!position || typeof position !== 'object') return false;
  const lon = position.lon ?? position.longitude;
  const lat = position.lat ?? position.latitude;
  if (lon !== undefined && lat !== undefined) {
    const height = readHeight(position);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height)) return false;
    out.lon = lon;
    out.lat = lat;
    out.height = height;
  } else {
    const { x, y, z } = position;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    if (!ecefToGeodetic(x, y, z, out)) return false;
  }
  // sphereXyz, inlined: this runs per entry per frame, and doubles passed
  // across a non-inlined call boundary are boxed (heap allocation).
  const latRad = out.lat * DEG;
  const lonRad = out.lon * DEG;
  const r = SPHERE_RADIUS_M + out.height;
  const cosLat = Math.cos(latRad);
  out.x = r * cosLat * Math.cos(lonRad);
  out.y = r * cosLat * Math.sin(lonRad);
  out.z = r * Math.sin(latRad);
  return true;
}

/** Forma rápida: a posição tem coordenadas utilizáveis? (sem converter) */
export function isWorldPositionLike(position) {
  if (!position || typeof position !== 'object') return false;
  const lon = position.lon ?? position.longitude;
  const lat = position.lat ?? position.latitude;
  if (lon !== undefined && lat !== undefined) {
    return Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(readHeight(position));
  }
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

/**
 * Oclusor de horizonte na esfera (o algoritmo do `EllipsoidalOccluder` do
 * Cesium, em espaço escalado pelo raio). `enabled=false` (mapa plano) deixa
 * tudo visível.
 */
export function createHorizonOccluder() {
  const cv = { x: 0, y: 0, z: 0 };
  let vhMagnitudeSquared = 0;
  const scratch = { lon: 0, lat: 0, height: 0, x: 0, y: 0, z: 0 };
  const occluder = {
    enabled: false,
    cameraPosition: { x: 0, y: 0, z: 0 },
    /** Atualiza a câmera (xyz na esfera). */
    setCamera(x, y, z) {
      this.cameraPosition.x = x;
      this.cameraPosition.y = y;
      this.cameraPosition.z = z;
      cv.x = x / SPHERE_RADIUS_M;
      cv.y = y / SPHERE_RADIUS_M;
      cv.z = z / SPHERE_RADIUS_M;
      vhMagnitudeSquared = cv.x * cv.x + cv.y * cv.y + cv.z * cv.z - 1;
    },
    /** Ponto já resolvido (x/y/z na esfera) visível do lado de cá do globo? */
    isResolvedVisible(p) {
      if (!this.enabled) return true;
      const tx = p.x / SPHERE_RADIUS_M - cv.x;
      const ty = p.y / SPHERE_RADIUS_M - cv.y;
      const tz = p.z / SPHERE_RADIUS_M - cv.z;
      const vtDotVc = -(tx * cv.x + ty * cv.y + tz * cv.z);
      const occluded = vhMagnitudeSquared < 0
        ? vtDotVc > 0
        : vtDotVc > vhMagnitudeSquared
          && (vtDotVc * vtDotVc) / (tx * tx + ty * ty + tz * tz) > vhMagnitudeSquared;
      return !occluded;
    },
    /** WorldPosition qualquer (compatível com o antigo `occluder.isPointVisible`). */
    isPointVisible(position) {
      if (!this.enabled) return isWorldPositionLike(position);
      if (!resolveWorldPosition(position, scratch)) return false;
      return this.isResolvedVisible(scratch);
    },
  };
  return occluder;
}

const MAPLIBRE_EARTH_CIRCUMFERENCE_M = 2 * Math.PI * SPHERE_RADIUS_M;
const DEFAULT_FOV_DEG = 36.8699;

/**
 * Câmera do motor em semântica Cesium, garantida: `engine.getCameraView()`,
 * completado a partir do estado público do mapa quando a posição da câmera
 * não vem (o `map.transform` que o motor consulta não é acessível no
 * MapLibre 6.7, e a altitude chegava `NaN`). Mesma conta do
 * `transform.getCameraAltitude()` do MapLibre: distância câmera→centro em px
 * (pela FOV vertical) × metros por pixel no centro, projetada pelo pitch.
 * @param {object} engine
 * @returns {{lat:number, lon:number, alt:number, heading:number, pitch:number, roll:number, zoom:number, targetLat:number, targetLon:number}|null}
 */
export function readCameraView(engine) {
  let view = null;
  try {
    view = engine?.getCameraView?.() ?? null;
  } catch {
    view = null;
  }
  if (view && Number.isFinite(view.alt) && Number.isFinite(view.lat) && Number.isFinite(view.lon)) return view;
  const map = engine?.map;
  if (!map?.getCenter || !map.getZoom) return view;
  try {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const pitchDeg = map.getPitch?.() ?? 0;
    const bearing = map.getBearing?.() ?? 0;
    const height = map.getContainer?.()?.clientHeight || map.getCanvas?.()?.clientHeight || 0;
    const fov = (map.getVerticalFieldOfView?.() ?? DEFAULT_FOV_DEG) * DEG;
    if (!(height > 0) || !Number.isFinite(zoom)) return view;
    const cameraToCenterPx = (0.5 * height) / Math.tan(fov / 2);
    const worldSize = 512 * 2 ** zoom;
    const metersPerPixel = (MAPLIBRE_EARTH_CIRCUMFERENCE_M * Math.cos(center.lat * DEG)) / worldSize;
    const distance = cameraToCenterPx * metersPerPixel;
    const pitch = pitchDeg * DEG;
    const elevation = Number(map.getCenterElevation?.()) || 0;
    const offset = distance * Math.sin(pitch);
    // Camera ground point: `offset` metres from the centre, opposite the bearing.
    const d = offset / SPHERE_RADIUS_M;
    const b = ((bearing + 180) % 360) * DEG;
    const p1 = center.lat * DEG;
    const l1 = center.lng * DEG;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return {
      ...(view || {}),
      lat: p2 / DEG,
      lon: ((l2 / DEG + 540) % 360) - 180,
      alt: elevation + distance * Math.cos(pitch),
      heading: (bearing + 360) % 360,
      pitch: pitchDeg - 90,
      roll: view?.roll ?? 0,
      zoom,
      targetLat: center.lat,
      targetLon: center.lng,
    };
  } catch {
    return view;
  }
}

/**
 * Projetor por quadro sobre o motor. `beginFrame()` lê a câmera UMA vez
 * (engine.getCameraView) e arma o oclusor; `project(resolved, out)` escreve
 * `out.x/out.y` (px CSS do container) e devolve false quando o ponto está atrás
 * do globo ou a projeção falha.
 * @param {object} engine Motor (src/maplibre/engine.js) ou um mock com
 *   getCameraView/projectInto|project|map.project/isGlobe.
 */
export function createWorldProjector(engine) {
  const occluder = createHorizonOccluder();
  const camera = {
    lon: 0, lat: 0, alt: Number.NaN, heading: 0, pitch: -90, zoom: 0,
    x: 0, y: 0, z: 0,
  };
  const lngLat = [0, 0];
  const projector = {
    engine,
    occluder,
    camera,
    beginFrame() {
      const view = readCameraView(engine);
      camera.lon = Number(view?.lon) || 0;
      camera.lat = Number(view?.lat) || 0;
      camera.alt = Number.isFinite(view?.alt) ? view.alt : Number.NaN;
      camera.heading = Number(view?.heading) || 0;
      camera.pitch = Number.isFinite(view?.pitch) ? view.pitch : -90;
      camera.zoom = Number(view?.zoom) || 0;
      sphereXyz(camera.lon, camera.lat, Number.isFinite(camera.alt) ? camera.alt : 0, camera);
      occluder.setCamera(camera.x, camera.y, camera.z);
      let globe = false;
      try {
        globe = engine?.isGlobe?.() === true;
      } catch {
        globe = false;
      }
      occluder.enabled = globe && Number.isFinite(camera.alt) && camera.alt > 0;
      return camera;
    },
    /** Distância em linha reta câmera → ponto resolvido (m). */
    distanceTo(p) {
      const dx = camera.x - p.x;
      const dy = camera.y - p.y;
      const dz = camera.z - p.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    /**
     * @param {{lon:number,lat:number,height:number,x:number,y:number,z:number}} p resolvido
     * @param {{x:number,y:number}} out
     * @param {boolean} [horizonCull=true]
     */
    project(p, out, horizonCull = true) {
      if (horizonCull && !occluder.isResolvedVisible(p)) return false;
      if (typeof engine.projectInto === 'function') {
        return engine.projectInto(p, out) !== false
          && Number.isFinite(out.x) && Number.isFinite(out.y);
      }
      let screen = null;
      try {
        if (engine.map?.project) {
          lngLat[0] = p.lon;
          lngLat[1] = p.lat;
          screen = engine.map.project(lngLat);
        } else if (typeof engine.project === 'function') {
          screen = engine.project(p.lon, p.lat, p.height);
        }
      } catch {
        screen = null;
      }
      if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return false;
      out.x = screen.x;
      out.y = screen.y;
      return true;
    },
  };
  return projector;
}
