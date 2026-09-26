/**
 * @module militaryInstallations
 * @description Camada INSTALAÇÕES MAPEADAS (id `military-installations`)
 * desenhada no MapLibre GL.
 *
 * DESLIGADA EM PRODUÇÃO: depende dos proxies do dev-server
 * (`/api/military-installations` → Overpass/OSM com cache em disco, e
 * `/api/google/text-search` → Google Places), então só é registrada no dev.
 *
 * DADOS (inalterados): a cada fim de movimento da câmera (debounce 500 ms)
 * pede o retângulo visível (≤ 10° de lado; mais que isso → "zoom-in"), refaz
 * com `exact=1` quando o bloco encaixado veio saturado, normaliza
 * (militaryInstallationData.js) e descarta o que está fora do retângulo
 * pedido. `searchNearby()` acrescenta uma busca única no Google Places.
 * Falha → "unavailable" com nova tentativa em 30 s → 240 s.
 *
 * DESENHO (MIGRAÇÃO MAPLIBRE 2026-09, substitui a CustomDataSource)
 *  - Fonte GeoJSON `dg-milinst`: polígono de pegada (preenchimento 12 %,
 *    contorno 65 % na cor da classe) e ponto de 9 px com contorno preto; o
 *    selecionado fica branco e maior (13 px). Rótulo com o nome a partir do
 *    zoom 9 (sempre no selecionado). Cores por classe: airfield #5aa9ff,
 *    naval_base #48c7d5, range #d9a85d, military_land #9ca6b0,
 *    places_candidate #c58cff.
 *  - Hover: tooltip (nome, classe, fonte, validação). Clique: seleciona e
 *    publica no contextStore (`gev:entity-selected`), que o painel CONTATOS
 *    (militaryAwareness) usa como sujeito.
 *  - No máximo 700 desenhadas (as mais próximas na ordem do feed) + a
 *    selecionada, como antes.
 *
 * O QUE ERA 3D E DEGRADA NO 2D: o encaixe dos pontos/pegadas no piso do
 * relevo (groundFloor/fireAnchors, com re-render quando o piso chegava
 * atrasado) não tem efeito num mapa 2D e saiu; `installationSurfaceHeightM`
 * continua exportada e dá a altura dos pontos neutros de `getNearby` a partir
 * do cache de piso já aquecido (0 quando frio).
 *
 * API PÚBLICA (mesmos nomes)
 *  - init(engine)/enable/disable/update/destroy/getStats, searchNearby(),
 *    focusById(id) (seleciona e voa até a instalação: engine.flyToTarget).
 *  - getNearby(center, rangeM, maxCount): `center` em qualquer formato aceito
 *    por geoPoint.toGeoPoint (neutro, {lon,lat}, ECEF); cada item traz
 *    `position` = ponto neutro {lon, lat, height, x, y, z} e `distanceM`
 *    (distância de superfície).
 *  - Exports puros: approximateSurfaceDistanceM, classifyGoogleMilitaryPlace,
 *    installationSourceLabel, installationSurfaceHeightM,
 *    installationWithinViewport, installationResponseSaturated,
 *    installationRetryDelayMs.
 */
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { cachedGroundFloor, floorAltitudeM } from './groundFloor.js';
import { normalizeMilitaryInstallations } from './militaryInstallationData.js';
import { geoPoint, toGeoPoint } from './geoPoint.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';
import { EMPTY_FC, LABEL_PAINT, TEXT_FONT, defineLayer, esc, matchColor, row } from '../maplibre/kit.js';

const LAYER_ID = 'military-installations';
const REQUEST_DEBOUNCE_MS = 500;
const MAX_VIEWPORT_DEGREES = 10;
const MAX_RENDERED = 700;
const GOOGLE_MILITARY_PLACE_TYPES = new Set(['military_base']);
const COLOR_BY_CLASS = {
  airfield: '#5aa9ff',
  naval_base: '#48c7d5',
  range: '#d9a85d',
  military_land: '#9ca6b0',
  places_candidate: '#c58cff',
};
const DEFAULT_COLOR = '#9ca6b0';
const EARTH_MEAN_RADIUS_M = 6371008.8;
const DISTANCE_PREFILTER_MARGIN_M = 5000;
/** Enquadramento do focusById: o antigo flyToBoundingSphere de raio 18 km. */
const FOCUS_RANGE_M = 40000;
const DEG = Math.PI / 180;

/**
 * Distância esférica sem alocação, usada só como pré-filtro conservador.
 * (latitude/longitude A em RADIANOS; B em graus.)
 */
export function approximateSurfaceDistanceM(latitudeARad, longitudeARad, latitudeBDeg, longitudeBDeg) {
  const latitudeBRad = latitudeBDeg * DEG;
  const longitudeBRad = longitudeBDeg * DEG;
  const latitudeDelta = latitudeBRad - latitudeARad;
  const longitudeDelta = Math.atan2(
    Math.sin(longitudeBRad - longitudeARad),
    Math.cos(longitudeBRad - longitudeARad),
  );
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const haversine = sinLatitude * sinLatitude
    + Math.cos(latitudeARad) * Math.cos(latitudeBRad) * sinLongitude * sinLongitude;
  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

/**
 * Distância de superfície no elipsoide WGS84 (Vincenty inverso, com recuo
 * para a esférica quando não converge). Substitui o Cesium.EllipsoidGeodesic.
 */
export function ellipsoidSurfaceDistanceM(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const L = (lon2Deg - lon1Deg) * DEG;
  const U1 = Math.atan((1 - f) * Math.tan(lat1Deg * DEG));
  const U2 = Math.atan((1 - f) * Math.tan(lat2Deg * DEG));
  const sinU1 = Math.sin(U1); const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2); const cosU2 = Math.cos(U2);
  let lambda = L;
  let iter = 0;
  let sinSigma; let cosSigma; let sigma; let cosSqAlpha; let cos2SigmaM;
  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const prev = lambda;
    lambda = L + (1 - C) * f * sinAlpha
      * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  } while (++iter < 200);
  if (iter >= 200) return approximateSurfaceDistanceM(lat1Deg * DEG, lon1Deg * DEG, lat2Deg, lon2Deg);
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = B * sinSigma * (cos2SigmaM + (B / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
    - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - deltaSigma);
}

const state = {
  engine: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  /** id -> portador de contexto (substitui a Cesium.Entity) */
  entities: new Map(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  status: 'idle',
  stale: false,
  /** Se o upstream truncou no teto de elementos para a vista atual. */
  saturated: false,
  loading: false,
  abort: null,
  /** Nova tentativa agendada enquanto o status é 'unavailable'. */
  retryTimer: null,
  /** Passo atual do backoff; 0 = a próxima falha começa no mínimo. */
  retryDelayMs: 0,
  moveEndRemove: null,
  timer: null,
  googleSearchRequested: false,
  host: null,
  defRegistered: false,
};

/**
 * Classifica um resultado do Places sem transformar um nome em "terreno
 * militar": sem tipo militar documentado, fica como candidato visualmente
 * distinto.
 * @param {object} place Resultado do Google Places.
 * @returns {string}
 */
export function classifyGoogleMilitaryPlace(place) {
  const types = new Set([
    place?.primaryType,
    ...(Array.isArray(place?.types) ? place.types : []),
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  return [...types].some((type) => GOOGLE_MILITARY_PLACE_TYPES.has(type))
    ? 'military_land'
    : 'places_candidate';
}

/** @param {object} record @returns {string} Atribuição legível da fonte. */
export function installationSourceLabel(record) {
  const names = [...new Set((Array.isArray(record?.sources) ? record.sources : [])
    .map((source) => String(source?.name || '').trim())
    .filter(Boolean))];
  return names.join(' + ') || 'Unknown mapped source';
}

/**
 * Altura de superfície (m) de uma instalação a partir do cache de piso
 * compartilhado (0 quando frio). No 2D é só o `height` do ponto neutro.
 * @param {{latitude:number, longitude:number}} record
 * @returns {number}
 */
export function installationSurfaceHeightM(record) {
  return floorAltitudeM(
    null,
    cachedGroundFloor(record?.latitude, record?.longitude),
  ) ?? 0;
}

/**
 * Se um registro pertence ao retângulo PEDIDO (o proxy devolve um superconjunto
 * encaixado na grade do cache): nó por centro; com pegada, por sobreposição
 * de caixas; way/relation sem pegada é mantido (extensão desconhecida).
 * @param {{latitude:number, longitude:number, footprint:?Array, osmType:?string}} record
 * @param {{south:number, west:number, north:number, east:number}} box
 * @returns {boolean}
 */
export function installationWithinViewport(record, box) {
  if (!record || !box) return false;
  const { latitude, longitude, footprint } = record;
  const centreInside = latitude >= box.south && latitude <= box.north
    && longitude >= box.west && longitude <= box.east;
  if (centreInside) return true;
  if (Array.isArray(footprint) && footprint.length) {
    let minLat = Infinity; let maxLat = -Infinity;
    let minLon = Infinity; let maxLon = -Infinity;
    for (const [lon, lat] of footprint) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return maxLat >= box.south && minLat <= box.north
      && maxLon >= box.west && minLon <= box.east;
  }
  return record.osmType !== 'node';
}

/**
 * Se a resposta foi truncada no teto do upstream (flag explícita, ou derivada
 * da contagem contra o teto informado para entradas antigas do cache).
 * @param {{saturated?: boolean, elements?: Array, elementCap?: number}} payload
 * @returns {boolean}
 */
export function installationResponseSaturated(payload) {
  if (typeof payload?.saturated === 'boolean') return payload.saturated;
  const cap = Number(payload?.elementCap);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Array.isArray(payload?.elements) && payload.elements.length >= cap;
}

/** Registra a transição de status e pede o quadro que ela precisa. */
function setInstallationStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('installations-status');
}

/** Retângulo visível {south, west, north, east}, ou null (vista global / antimeridiano). */
function viewportBox(engine) {
  let bounds = null;
  try { bounds = engine?.map?.getBounds?.() ?? null; } catch { bounds = null; }
  if (!bounds) return null;
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  if (!Number.isFinite(south + north + west + east) || east <= west || west < -180 || east > 180
    || north - south > MAX_VIEWPORT_DEGREES || east - west > MAX_VIEWPORT_DEGREES) return null;
  return { south, west, north, east };
}

// ---------------------------------------------------------------------------
// MapLibre
// ---------------------------------------------------------------------------

const SRC = 'dg-milinst';
const L_FILL = 'dg-milinst-fill';
const L_LINE = 'dg-milinst-line';
const L_PT = 'dg-milinst-pt';
const L_LABEL = 'dg-milinst-label';
const CLASS_COLOR = matchColor('class', COLOR_BY_CLASS, DEFAULT_COLOR);
const IS_POLY = ['==', ['geometry-type'], 'Polygon'];
const IS_POINT = ['==', ['geometry-type'], 'Point'];

function tooltipHtml(props) {
  const record = state.recordById.get(props?.rid);
  if (!record) return '';
  return `<div><strong>⌖ ${esc(record.name || 'Instalação mapeada')}</strong>`
    + row('Classe', String(record.class || 'installation').replaceAll('_', ' '))
    + row('Fonte', installationSourceLabel(record))
    + row('Validação', record.validation)
    + '</div>';
}

/** Definição da camada no contrato do anfitrião (kit.js). */
export const militaryInstallationsMapDef = defineLayer({
  id: LAYER_ID,
  name: 'Mapped Installations',
  category: 'Infraestrutura',
  icon: '⌖',
  source: 'OpenStreetMap + optional Google Maps Places',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: L_FILL, type: 'fill', source: SRC, filter: IS_POLY,
      paint: { 'fill-color': CLASS_COLOR, 'fill-opacity': ['case', ['get', 'sel'], 0.22, 0.12] },
    },
    {
      id: L_LINE, type: 'line', source: SRC, filter: IS_POLY,
      paint: { 'line-color': ['case', ['get', 'sel'], '#ffffff', CLASS_COLOR], 'line-opacity': 0.65, 'line-width': 1.2 },
    },
    {
      id: L_PT, type: 'circle', source: SRC, filter: IS_POINT,
      paint: {
        'circle-radius': ['case', ['get', 'sel'], 6.5, 4.5],
        'circle-color': ['case', ['get', 'sel'], '#ffffff', CLASS_COLOR],
        'circle-stroke-color': 'rgba(0,0,0,0.8)',
        'circle-stroke-width': 1,
      },
    },
    {
      id: L_LABEL, type: 'symbol', source: SRC,
      filter: ['all', IS_POINT, ['any', ['get', 'sel'], ['>=', ['zoom'], 9]]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': TEXT_FONT,
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-max-width': 12,
        'text-optional': true,
      },
      paint: { ...LABEL_PAINT },
    },
  ],
  interactive: [L_PT, L_FILL],
  tooltip: (props) => tooltipHtml(props),
  click: (props) => {
    if (!state.enabled) return;
    if (props?.rid && state.recordById.has(props.rid)) selectRecord(props.rid);
  },
});

function ensureMapLayers() {
  const map = state.engine?.map;
  if (!map) return false;
  state.host = state.host || getActiveLayerHost();
  try {
    if (state.host) {
      if (!state.defRegistered || !state.host.ctx?.getLayer?.(LAYER_ID)) {
        state.host.register(militaryInstallationsMapDef);
        state.defRegistered = true;
      }
      state.host.ensureAdded(militaryInstallationsMapDef);
    } else if (typeof map.addSource === 'function') {
      for (const [id, spec] of Object.entries(militaryInstallationsMapDef.sources)) if (!map.getSource(id)) map.addSource(id, spec);
      for (const layer of militaryInstallationsMapDef.layers) if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    return true;
  } catch (err) {
    console.warn('[Data:Installations] layers', err);
    return false;
  }
}

function setMapVisible(visible) {
  const map = state.engine?.map;
  if (!map) return;
  if (state.host) {
    state.host.setVisible(LAYER_ID, visible);
    return;
  }
  for (const layer of militaryInstallationsMapDef.layers) {
    if (map.getLayer?.(layer.id)) map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
  }
}

function setSourceData(data) {
  try { state.engine?.map?.getSource?.(SRC)?.setData(data); } catch { /* estilo trocando */ }
}

function clearRendered() {
  state.entities = new Map();
  setSourceData(EMPTY_FC);
  removeEntityContextsForLayer(LAYER_ID);
}

/** As 700 primeiras + a selecionada quando fica fora dessa janela. */
function renderableRecords() {
  const rendered = state.records.slice(0, MAX_RENDERED);
  if (!state.selectedId) return rendered;
  if (rendered.some((record) => record.id === state.selectedId)) return rendered;
  const selected = state.recordById.get(state.selectedId);
  return selected ? [...rendered, selected] : rendered;
}

function recordPosition(record) {
  return geoPoint(record.longitude, record.latitude, installationSurfaceHeightM(record));
}

function renderRecords() {
  governorRequestRender('installations-render');
  clearRendered();
  const features = [];
  const polygons = [];
  for (const record of renderableRecords()) {
    const selected = record.id === state.selectedId;
    const props = {
      rid: record.id,
      name: record.name || '',
      class: record.class || 'military_land',
      sel: selected,
    };
    if (Array.isArray(record.footprint) && record.footprint.length >= 3) {
      const ring = record.footprint.map(([lon, lat]) => [lon, lat]);
      const [fx, fy] = ring[0];
      const [lx, ly] = ring[ring.length - 1];
      if (fx !== lx || fy !== ly) ring.push([fx, fy]);
      polygons.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: props });
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [record.longitude, record.latitude] }, properties: props });

    const displayPosition = recordPosition(record);
    // Portador de contexto (o que era a Cesium.Entity): identidade, rótulo e
    // posição que o contextStore, o leitor de alvo e CONTATOS consultam.
    const entity = {
      id: record.id,
      show: true,
      gevTrackedId: `installations:${record.id}`,
      gevDisplayPosition: () => displayPosition,
      gevLabelModel: {
        title: record.name || 'MAPPED INSTALLATION',
        details: [String(record.class || 'installation').replaceAll('_', ' ').toUpperCase()],
        accent: COLOR_BY_CLASS[record.class] || DEFAULT_COLOR,
      },
    };
    state.entities.set(record.id, entity);
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: record.kind === 'place_candidate'
        ? 'Military Site Search Candidates'
        : 'Mapped Military Installations',
      source: installationSourceLabel(record),
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        class: record.class,
        primaryType: record.primaryType || null,
        placeTypes: Array.isArray(record.placeTypes) ? record.placeTypes : [],
        validation: record.validation,
        retrievedAt: record.retrievedAt,
      },
    });
  }
  // Polígonos antes dos pontos (o selecionado por último, por cima).
  features.sort((a, b) => Number(a.properties.sel) - Number(b.properties.sel));
  setSourceData({ type: 'FeatureCollection', features: [...polygons, ...features] });
  const selectedEntity = state.selectedId ? state.entities.get(state.selectedId) : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

function selectRecord(id) {
  const record = state.recordById.get(id);
  if (!record || !state.engine) return false;
  state.selectedId = id;
  renderRecords();
  return state.selectedId === id;
}

/**
 * Progressão do backoff do estado 'unavailable': 30 s, dobrando até 240 s.
 */
export function installationRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/**
 * "Temporariamente indisponível" tem de ser temporário: com a câmera parada
 * não há moveend, então, enquanto ligada e indisponível, tenta de novo em
 * 30 s → 240 s; sucesso, carga do usuário, afastar o zoom ou desligar cancelam.
 */
function scheduleUnavailableRetry() {
  if (!state.enabled) return;
  clearTimeout(state.retryTimer);
  state.retryDelayMs = installationRetryDelayMs(state.retryDelayMs);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.enabled && !state.loading) loadInstallations();
  }, state.retryDelayMs);
}

function clearUnavailableRetry({ resetBackoff = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (resetBackoff) state.retryDelayMs = 0;
}

function scheduleLoad() {
  if (!state.enabled) return;
  // Uma carga do usuário substitui a nova tentativa (mantendo o passo do backoff).
  clearUnavailableRetry({ resetBackoff: false });
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { loadInstallations(); }, REQUEST_DEBOUNCE_MS);
}

async function loadInstallations() {
  if (!state.enabled || !state.engine) return;
  const box = viewportBox(state.engine);
  if (!box) {
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    clearUnavailableRetry();
    setInstallationStatus('zoom-in', 'Zoom in to load mapped installation context');
    return;
  }
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  state.loading = true;
  try {
    const fetchInstallations = async (exact) => {
      const query = new URLSearchParams(Object.entries(box).map(([key, value]) => [key, value.toFixed(5)]));
      if (exact) query.set('exact', '1');
      const response = await fetch(`/api/military-installations?${query}`, { signal: requestAbort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Installation feed HTTP ${response.status}`);
      return body;
    };

    let payload = await fetchInstallations(false);
    // Bloco encaixado SATURADO: refaz para o retângulo exato antes de desenhar.
    let saturated = installationResponseSaturated(payload);
    if (saturated) {
      payload = await fetchInstallations(true);
      saturated = installationResponseSaturated(payload);
    }
    const normalized = normalizeMilitaryInstallations(payload, payload.retrievedAt || new Date().toISOString());
    const records = normalized.records.filter((record) => installationWithinViewport(record, box));
    let placesError = null;
    if (state.googleSearchRequested) {
      state.googleSearchRequested = false;
      const latitude = (box.south + box.north) / 2;
      const longitude = (box.west + box.east) / 2;
      const radiusM = Math.min(50000, Math.max(1000, Math.round(Math.max(box.north - box.south, box.east - box.west) * 55_000)));
      try {
        const placesResponse = await fetch(`/api/google/text-search?${new URLSearchParams({
          q: 'military installation', lat: latitude.toFixed(5), lon: longitude.toFixed(5), radiusM: String(radiusM),
        })}`, { signal: requestAbort.signal });
        const placesPayload = await placesResponse.json();
        if (!placesResponse.ok) throw new Error(placesPayload?.error || `Google Places HTTP ${placesResponse.status}`);
        const seen = new Set(records.map((record) => `${record.name.toLowerCase()}|${record.latitude.toFixed(3)}|${record.longitude.toFixed(3)}`));
        for (const place of Array.isArray(placesPayload?.places) ? placesPayload.places : []) {
          if (!place?.id || !place?.name || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
          const placeClass = classifyGoogleMilitaryPlace(place);
          const signature = `${String(place.name).toLowerCase()}|${place.latitude.toFixed(3)}|${place.longitude.toFixed(3)}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          const retrievedAt = new Date().toISOString();
          records.push({
            id: `google:${place.id}`,
            kind: placeClass === 'military_land' ? 'installation' : 'place_candidate',
            class: placeClass,
            name: String(place.name).trim(),
            latitude: place.latitude,
            longitude: place.longitude,
            footprint: null,
            primaryType: place.primaryType || null,
            placeTypes: Array.isArray(place.types) ? place.types : [],
            sources: [{ name: 'Google Maps Places', id: place.id, retrievedAt }],
            validation: 'unreviewed',
            retrievedAt,
          });
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
        placesError = 'Google Places search unavailable; showing mapped sites';
      }
    }
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    state.records = records;
    state.recordById = new Map(state.records.map((record) => [record.id, record]));
    state.lastUpdate = Date.now();
    state.stale = payload.status === 'stale';
    // Mesmo o pedido exato pode saturar numa área densa: dizer isso.
    state.saturated = saturated;
    clearUnavailableRetry();
    setInstallationStatus(
      state.records.length ? (state.stale ? 'stale' : 'ready') : 'empty',
      payload.status === 'stale'
        ? 'Serving cached mapped context'
        : (saturated ? 'Too many mapped sites in view to list them all' : placesError),
    );
    renderRecords();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setInstallationStatus('unavailable', error?.message || 'Installation context unavailable');
    scheduleUnavailableRetry();
  } finally {
    // Um pedido antigo abortado não limpa o "ocupado" de um mais novo.
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const militaryInstallationsLayer = {
  id: LAYER_ID,
  name: 'Mapped Installations',
  icon: '⌖',
  source: 'OpenStreetMap + optional Google Maps Places',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  maplibre: true,
  /** Definição MapLibre (contrato kit.js), para depuração e testes. */
  mapDef: militaryInstallationsMapDef,
  /** @param {object} engine motor do app (src/maplibre/engine.js) */
  init(engine) {
    state.engine = engine || null;
    state.host = getActiveLayerHost();
    state.moveEndRemove?.();
    state.moveEndRemove = typeof engine?.on === 'function' ? engine.on('moveend', scheduleLoad) : null;
    ensureMapLayers();
  },
  enable() {
    state.enabled = true;
    ensureMapLayers();
    setMapVisible(true);
    // O DataLayerManager chama update() logo depois de enable(); ele é dono
    // do primeiro pedido.
  },
  disable() {
    state.enabled = false;
    clearUnavailableRetry();
    clearTimeout(state.timer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    setMapVisible(false);
    for (const entity of state.entities.values()) entity.show = false;
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  },
  update() { return loadInstallations(); },
  /** Pede uma busca única no Google Maps Places em volta da vista atual. */
  searchNearby() {
    state.googleSearchRequested = true;
    return loadInstallations();
  },
  destroy() {
    this.disable();
    state.moveEndRemove?.();
    state.moveEndRemove = null;
    clearRendered();
    state.engine = null;
  },
  /**
   * Instalações (não candidatos do Places) a até `rangeM` de `center`
   * (qualquer formato aceito por toGeoPoint), por distância de superfície.
   */
  getNearby(center, rangeM, maxCount = 50) {
    if (!center) return [];
    const c = toGeoPoint(center);
    if (!c) return [];
    const range = Number.isFinite(rangeM) ? rangeM : Infinity;
    const latRad = c.lat * DEG;
    const lonRad = c.lon * DEG;
    const approximateLimit = Number.isFinite(range) ? range * 1.03 + DISTANCE_PREFILTER_MARGIN_M : Infinity;
    const nearby = [];
    for (const record of state.records) {
      if (record.kind !== 'installation') continue;
      if (approximateSurfaceDistanceM(latRad, lonRad, record.latitude, record.longitude) > approximateLimit) continue;
      const distanceM = ellipsoidSurfaceDistanceM(c.lat, c.lon, record.latitude, record.longitude);
      if (!Number.isFinite(distanceM) || distanceM > range) continue;
      nearby.push({ ...record, position: recordPosition(record), distanceM });
    }
    nearby.sort((a, b) => a.distanceM - b.distanceM);
    return nearby.slice(0, Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 50);
  },
  /**
   * Seleciona e enquadra uma instalação a partir de outra interface (CONTATOS).
   * @param {string} id
   * @returns {boolean} true quando a instalação foi de fato selecionada.
   */
  focusById(id) {
    const record = state.recordById.get(String(id));
    if (!record || !state.engine) return false;
    // Sem voo sem seleção real (NEXT ficaria preso nesta instalação).
    if (!selectRecord(record.id)) return false;
    let heading = 0;
    try { heading = state.engine.getCameraView?.()?.heading ?? 0; } catch { heading = 0; }
    state.engine.flyToTarget?.(
      { lat: record.latitude, lon: record.longitude, height: installationSurfaceHeightM(record) },
      { rangeM: FOCUS_RANGE_M, heading, pitch: -90, duration: 1.4 },
    );
    return true;
  },
  getStats() {
    return {
      count: state.records.length,
      lastUpdate: state.lastUpdate,
      stale: state.stale,
      saturated: state.saturated,
      error: state.error,
      status: state.status,
      loading: state.loading,
      loadingLabel: state.loading ? 'loading mapped installation context' : '',
    };
  },
};

/** Portadores de contexto desenhados (na ordem de desenho), para testes. */
export function _renderedInstallationsForTest() {
  return [...state.entities.values()];
}

export default militaryInstallationsLayer;
