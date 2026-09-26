/**
 * @module detectionMapSources
 * @description Fontes de alvos da DETECÇÃO lidas direto do mapa MapLibre,
 * para camadas desenhadas por estilo (src/maplibre/layers/*) que não têm um
 * módulo com `getDetectableObjects()`.
 *
 * Cada fonte aqui é um "layer-like" com o mesmo contrato que detection.js
 * espera de uma camada:
 *
 *   { id, getDetectableObjects({mode, maxCount, seed}) -> DetectableObject[] }
 *
 * e lê as feições da fonte GeoJSON `dg-...` com `map.querySourceFeatures`
 * (tiles carregados — a vista e arredores; o recorte fino é da detecção),
 * apenas enquanto a camada está visível. A consulta fica em cache por
 * `QUERY_TTL_MS` e é refeita no próximo 'sourcedata'/'moveend', para a
 * detecção (que puxa candidatos a cada quadro pintado) não varrer as tiles a
 * cada quadro.
 */

/** Idade máxima da consulta em cache (ms). */
export const QUERY_TTL_MS = 400;

/**
 * @typedef {object} MapSourceDetectionSpec
 * @property {string} id Id da camada no painel (o `_layerId` da detecção).
 * @property {string} sourceId Fonte GeoJSON do MapLibre.
 * @property {string[]} visibilityLayers Layers de estilo; a fonte só conta
 *   quando ao menos um deles está no estilo e visível.
 * @property {function(object, object):void} fill Preenche o objeto detectável
 *   reaproveitado a partir de (feature, objeto).
 * @property {function(object):string} key Identidade estável da feição.
 * @property {function(object, object):number} [compare] Ordem (maior primeiro).
 */

function layerVisible(map, layerId) {
  try {
    if (!map.getLayer?.(layerId)) return false;
    return map.getLayoutProperty?.(layerId, 'visibility') !== 'none';
  } catch {
    return false;
  }
}

/**
 * Cria uma fonte de detecção sobre uma fonte GeoJSON do mapa.
 * @param {object} engine Motor (usa `engine.map` e `engine.on`).
 * @param {MapSourceDetectionSpec} spec
 */
export function createMapSourceDetectionLayer(engine, spec) {
  const objects = new Map(); // key -> objeto detectável reaproveitado
  let cache = [];
  let cachedAt = Number.NEGATIVE_INFINITY;
  let dirty = true;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const invalidate = () => { dirty = true; };
  const offMove = engine?.on?.('moveend', invalidate);
  const map = engine?.map;
  const onSourceData = (event) => {
    if (event?.sourceId === spec.sourceId) dirty = true;
  };
  map?.on?.('sourcedata', onSourceData);

  function refresh() {
    const next = [];
    if (!map || !spec.visibilityLayers.some((id) => layerVisible(map, id))) {
      cache = next;
      return;
    }
    let features = [];
    try {
      features = map.querySourceFeatures?.(spec.sourceId) ?? [];
    } catch {
      features = [];
    }
    const seen = new Set();
    for (const feature of features) {
      const coords = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
      const key = spec.key(feature);
      if (!key || seen.has(key)) continue; // a mesma feição aparece em várias tiles
      seen.add(key);
      let object = objects.get(key);
      if (!object) {
        object = { sourceId: key, position: { lon: 0, lat: 0, height: 0 } };
        objects.set(key, object);
      }
      object.position.lon = coords[0];
      object.position.lat = coords[1];
      spec.fill(feature, object);
      next.push(object);
    }
    for (const key of objects.keys()) if (!seen.has(key)) objects.delete(key);
    if (spec.compare) next.sort(spec.compare);
    cache = next;
  }

  return {
    id: spec.id,
    /** @param {{maxCount?: number}} [options] */
    getDetectableObjects(options = {}) {
      const t = now();
      if (dirty || t - cachedAt > QUERY_TTL_MS) {
        refresh();
        cachedAt = t;
        dirty = false;
      }
      const max = Number.isFinite(options.maxCount) ? Math.max(1, Math.floor(options.maxCount)) : cache.length;
      return cache.length > max ? cache.slice(0, max) : cache;
    },
    destroy() {
      offMove?.();
      map?.off?.('sourcedata', onSourceData);
      objects.clear();
      cache = [];
    },
  };
}

/** Focos de calor (camada MapLibre `local-firms`, fonte `dg-firms`). */
export const LOCAL_FIRMS_DETECTION_SPEC = Object.freeze({
  id: 'local-firms',
  sourceId: 'dg-firms',
  visibilityLayers: ['dg-firms-heat', 'dg-firms-glow'],
  key: (feature) => String(feature?.properties?.key ?? feature?.id ?? ''),
  fill(feature, object) {
    const p = feature.properties || {};
    const frp = Number(p.frp);
    object.type = 'FIRE';
    object.id = Number.isFinite(frp) ? `FIRE ${frp >= 100 ? Math.round(frp) : frp.toFixed(1)} MW` : 'FIRE';
    object.metric = String(p.sev || '').toUpperCase();
    object.frp = Number.isFinite(frp) ? frp : 0;
  },
  compare: (a, b) => b.frp - a.frp,
});

/**
 * Fontes de detecção que vêm do próprio mapa. Hoje: focos de calor.
 * @param {object} engine
 * @returns {Array<ReturnType<typeof createMapSourceDetectionLayer>>}
 */
export function createMapDetectionSources(engine) {
  if (!engine?.map) return [];
  return [createMapSourceDetectionLayer(engine, LOCAL_FIRMS_DETECTION_SPEC)];
}
