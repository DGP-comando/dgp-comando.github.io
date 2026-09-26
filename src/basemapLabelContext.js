/**
 * @module basemapLabelContext
 * @description Contexto de rótulos do lugar que a câmera olha — a versão
 * MapLibre do antigo `getBasemapLabelContext(viewer)` de voice/gevActions.js
 * (que dependia do Cesium). Usado pelo resumo do HUD e disponível para a voz.
 *
 *   getBasemapLabelContext(engine) -> Promise<{placeLabels, streetLabels, nearbyPlaceLabels}>
 *
 * Fontes, na ordem em que entram:
 *   1. rótulos do MAPA BASE que estão desenhados agora (symbol layers do
 *      estilo vetorial, via `map.queryRenderedFeatures`); o mapa base Esri é
 *      raster e não tem rótulos consultáveis — então esta parte fica vazia;
 *   2. geocodificação reversa (Google Geocoding, só com
 *      `window.__GOOGLE_MAPS_API_KEY__`) do centro e de três amostras da tela;
 *   3. lugares próximos (`/api/google/nearby-places`, proxy do dev-server) de
 *      perto do chão.
 * Cada rede tem prazo curto; o que não chega a tempo vira lista vazia. Os
 * rótulos são saneados (uma linha, 120 caracteres) antes de irem para
 * qualquer prompt.
 */

import { readCameraView } from './overlays/worldGeometry.js';

const CONTEXT_WAIT_MS = 1500;
const reverseGeocodeCache = new Map();
const reverseGeocodeInFlight = new Map();
const nearbyPlacesCache = new Map();
const nearbyPlacesInFlight = new Map();

/** Amostras da tela (frações de largura/altura), centro primeiro. */
const SAMPLE_POINTS = [
  [0.5, 0.5],
  [0.25, 0.35],
  [0.75, 0.35],
  [0.25, 0.65],
  [0.75, 0.65],
  [0.5, 0.25],
  [0.5, 0.75],
];

/**
 * Normaliza um rótulo vindo de dados externos: sem quebras nem caracteres de
 * controle, espaços colapsados, no máximo 120 caracteres.
 * @param {*} value
 * @returns {string}
 */
export function sanitizeLabel(value) {
  const text = String(value ?? '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** @param {Array<*>} values */
export function uniqueLabels(values) {
  return [...new Set(values.map((value) => sanitizeLabel(value)).filter(Boolean))];
}

export const shouldReverseGeocode = (heightM) => heightM <= 750_000;
export const shouldReverseGeocodeViewport = (heightM) => heightM <= 3_000_000 && heightM > 10_000;
export const shouldFetchNearbyPlaces = (heightM) => heightM <= 25_000;

function nearbyPlacesRadiusM(heightM) {
  if (heightM <= 1000) return 500;
  if (heightM <= 5000) return 2000;
  return 5000;
}

const geocodeKey = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

/**
 * Amostras {lat, lon} da tela pelo `engine.unproject` (pontos no céu somem).
 * @param {object} engine
 */
export function sampleViewport(engine) {
  const canvas = engine?.canvas;
  const width = canvas?.clientWidth || 0;
  const height = canvas?.clientHeight || 0;
  if (!width || !height || typeof engine.unproject !== 'function') return [];
  const samples = [];
  for (const [fx, fy] of SAMPLE_POINTS) {
    const p = engine.unproject(width * fx, height * fy);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90) continue;
    samples.push({ latitude: Number(p.lat.toFixed(4)), longitude: Number(p.lon.toFixed(4)) });
  }
  return samples;
}

const TEXT_PROPS = ['name:pt', 'name_pt', 'name', 'name_en', 'name:latin', 'ref'];
const STREET_CLASSES = /street|road|highway|transportation|motorway|primary|secondary|tertiary|residential|path/i;

/**
 * Rótulos do mapa base desenhados agora (symbol layers que não são do app).
 * @param {object} engine
 * @returns {{placeLabels: string[], streetLabels: string[]}}
 */
export function renderedBasemapLabels(engine) {
  const map = engine?.map;
  const out = { placeLabels: [], streetLabels: [] };
  if (!map?.queryRenderedFeatures || !map.getStyle) return out;
  let symbolLayers = [];
  try {
    symbolLayers = (map.getStyle()?.layers ?? [])
      .filter((layer) => layer.type === 'symbol' && !layer.id.startsWith('dg-'))
      .map((layer) => layer.id);
  } catch {
    return out;
  }
  if (!symbolLayers.length) return out;
  let features = [];
  try {
    features = map.queryRenderedFeatures(undefined, { layers: symbolLayers });
  } catch {
    return out;
  }
  const places = [];
  const streets = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    const key = TEXT_PROPS.find((k) => props[k]);
    if (!key) continue;
    const text = props[key];
    const layerId = feature.layer?.id ?? '';
    const sourceLayer = feature.sourceLayer ?? feature['source-layer'] ?? '';
    if (STREET_CLASSES.test(layerId) || STREET_CLASSES.test(sourceLayer)) streets.push(text);
    else places.push(text);
  }
  out.placeLabels = uniqueLabels(places).slice(0, 24);
  out.streetLabels = uniqueLabels(streets).slice(0, 16);
  return out;
}

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWithin(promise, timeoutMs, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Geocodificação reversa (Google), com cache e deduplicação em voo. */
export async function reverseGeocode(latitude, longitude) {
  const apiKey = globalThis.window?.__GOOGLE_MAPS_API_KEY__;
  if (!apiKey || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const key = geocodeKey(latitude, longitude);
  if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);
  if (reverseGeocodeInFlight.has(key)) return reverseGeocodeInFlight.get(key);
  const request = (async () => {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${latitude},${longitude}`)}&key=${apiKey}`;
      const data = await (await fetchWithTimeout(url)).json();
      if (data.status !== 'OK' || !data.results?.length) {
        reverseGeocodeCache.set(key, null);
        return null;
      }
      const results = data.results.slice(0, 12);
      const components = Array.isArray(results[0].address_components) ? results[0].address_components : [];
      const component = (type) => components.find((item) => item.types?.includes(type))?.long_name || null;
      const place = {
        formattedAddress: results[0].formatted_address || null,
        locality: component('locality') || component('postal_town') || component('administrative_area_level_2'),
        region: component('administrative_area_level_1'),
        country: component('country'),
        labels: uniqueLabels(results.map((item) => item.formatted_address)).slice(0, 12),
        streetLabels: uniqueLabels(results.flatMap((item) => (item.address_components || [])
          .filter((entry) => entry.types?.includes('route'))
          .map((entry) => entry.long_name))).slice(0, 12),
      };
      reverseGeocodeCache.set(key, place);
      return place;
    } catch {
      return null;
    } finally {
      reverseGeocodeInFlight.delete(key);
    }
  })();
  reverseGeocodeInFlight.set(key, request);
  return request;
}

async function fetchNearbyPlaces(latitude, longitude, heightM) {
  const radiusM = nearbyPlacesRadiusM(heightM);
  const key = `${geocodeKey(latitude, longitude)},${radiusM}`;
  if (nearbyPlacesCache.has(key)) return nearbyPlacesCache.get(key);
  if (nearbyPlacesInFlight.has(key)) return nearbyPlacesInFlight.get(key);
  const request = (async () => {
    try {
      const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude), radiusM: String(radiusM) });
      const response = await fetchWithTimeout(`/api/google/nearby-places?${params}`);
      const data = await response.json().catch(() => null);
      const places = response.ok && Array.isArray(data?.places)
        ? data.places.filter((place) => place?.name).slice(0, 12)
        : [];
      nearbyPlacesCache.set(key, places);
      return places;
    } catch {
      return [];
    } finally {
      nearbyPlacesInFlight.delete(key);
    }
  })();
  nearbyPlacesInFlight.set(key, request);
  return request;
}

async function reverseGeocodeViewport(samples, heightM) {
  if (!shouldReverseGeocodeViewport(heightM) || !samples.length) return [];
  const places = await Promise.all(samples.slice(0, 3).map((s) => reverseGeocode(s.latitude, s.longitude)));
  return places.filter(Boolean);
}

/**
 * Contexto de rótulos do que a câmera enxerga.
 * @param {object} engine Motor MapLibre (getCameraView, unproject, canvas, map).
 * @returns {Promise<{placeLabels: string[], streetLabels: string[], nearbyPlaceLabels: string[]}>}
 */
export async function getBasemapLabelContext(engine) {
  const empty = { placeLabels: [], streetLabels: [], nearbyPlaceLabels: [] };
  const view = readCameraView(engine);
  const latitude = Number(view?.targetLat ?? view?.lat);
  const longitude = Number(view?.targetLon ?? view?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return empty;
  const heightM = Number.isFinite(view?.alt) ? view.alt : Number.POSITIVE_INFINITY;
  const rendered = renderedBasemapLabels(engine);
  const samples = sampleViewport(engine);
  const lat = Number(latitude.toFixed(6));
  const lon = Number(longitude.toFixed(6));
  const [viewportPlaces, place, nearby] = await Promise.all([
    resolveWithin(reverseGeocodeViewport(samples, heightM), CONTEXT_WAIT_MS, []),
    resolveWithin(shouldReverseGeocode(heightM) ? reverseGeocode(lat, lon) : null, CONTEXT_WAIT_MS, null),
    resolveWithin(shouldFetchNearbyPlaces(heightM) ? fetchNearbyPlaces(lat, lon, heightM) : [], CONTEXT_WAIT_MS, []),
  ]);
  return {
    placeLabels: uniqueLabels([
      place?.formattedAddress,
      place?.locality,
      place?.region,
      place?.country,
      ...(place?.labels || []),
      ...viewportPlaces.flatMap((p) => p.labels || []),
      ...rendered.placeLabels,
    ]).slice(0, 24),
    streetLabels: uniqueLabels([
      ...(place?.streetLabels || []),
      ...viewportPlaces.flatMap((p) => p.streetLabels || []),
      ...rendered.streetLabels,
    ]).slice(0, 16),
    nearbyPlaceLabels: uniqueLabels((nearby || []).flatMap((p) => [p.name, p.address])).slice(0, 24),
  };
}
