/**
 * @module trailRenderer
 * @description Rastro (histórico de posições) compartilhado pelas camadas de
 * objetos móveis (voos civis, militares, AIS).
 *
 * MIGRAÇÃO MAPLIBRE (2026-09): um rastro = UMA fonte GeoJSON + UM layer `line`
 * no mapa do motor (src/maplibre/engine.js), no lugar da entidade polyline do
 * Cesium. A regra de produto continua: o traço inteiro com uma opacidade
 * legível (0,85), sem esmaecer a cauda. Em 2D não existe "segmento abaixo da
 * malha fotorrealista", então a `depthFailMaterial` (0,4) não tem equivalente.
 * Segmentos longos são desenhados como geodésicas: o MapLibre projeta cada
 * segmento reto em Mercator, então pontos intermediários são inseridos em
 * trechos acima de ~50 km (o equivalente ao ArcType.GEODESIC do Cesium).
 *
 * Assinatura mantida: `createTrail(engine, {color, width})` — o primeiro
 * argumento é o `engine` (ou um `maplibregl.Map`; aceita-se também qualquer
 * objeto com `.map`). As posições de `setPositions` são objetos NEUTROS
 * `{lon, lat, alt?}` (também aceita `[lon, lat, alt?]` e ECEF `{x, y, z}` por
 * compatibilidade com código ainda não portado).
 *
 * O layer não é interativo (não entra em `interactive` de nenhuma camada), então
 * clicar num rastro nunca seleciona nem desseleciona nada.
 */
import { toGeo } from './motionModel.js';

/** @type {number} Uniquifier for trail source/layer ids. */
let _trailSeq = 0;

/** @constant {number} Alpha of the trail line. */
export const TRAIL_ALPHA = 0.85;
/** @constant {number} Degrees below which consecutive points are merged (~1 cm). */
const MIN_SEGMENT_DEG = 1e-7;
/** @constant {number} Segments longer than this (degrees of arc, ~220 km) are densified. */
const GEODESIC_STEP_DEG = 2;

const DEG = Math.PI / 180;

/** Interpolação na esfera (slerp) entre dois pontos lon/lat, `n` passos. */
function greatCircleInsert(a, b, out) {
  const p1 = a[1] * DEG;
  const l1 = a[0] * DEG;
  const p2 = b[1] * DEG;
  const l2 = b[0] * DEG;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
  ));
  const n = Math.ceil(d / DEG / GEODESIC_STEP_DEG);
  if (!(d > 0) || n < 2) return;
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / DEG;
    // Continuidade na antimeridiana: segue o lado do ponto anterior.
    const prev = out[out.length - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, Math.atan2(z, Math.hypot(x, y)) / DEG]);
  }
}

/**
 * Normaliza uma lista de posições (qualquer formato) em coordenadas GeoJSON,
 * removendo duplicatas consecutivas e densificando segmentos longos.
 * Exportada para teste.
 * @param {Array<object>} positions
 * @returns {number[][]} [[lon, lat], ...] (vazio quando < 2 pontos distintos)
 */
export function trailCoordinates(positions) {
  const out = [];
  for (const position of Array.isArray(positions) ? positions : []) {
    const g = toGeo(position);
    if (!g) continue;
    const last = out[out.length - 1];
    let lon = g.lon;
    if (last) {
      while (lon - last[0] > 180) lon -= 360;
      while (lon - last[0] < -180) lon += 360;
      if (Math.abs(lon - last[0]) < MIN_SEGMENT_DEG && Math.abs(g.lat - last[1]) < MIN_SEGMENT_DEG) continue;
      greatCircleInsert(last, [lon, g.lat], out);
    }
    out.push([lon, g.lat]);
  }
  return out.length >= 2 ? out : [];
}

function mapOf(target) {
  if (!target) return null;
  if (typeof target.addLayer === 'function') return target;
  return target.map ?? null;
}

/**
 * Create an always-visible polyline trail bound to the map engine.
 * @param {object} engine - `engine` do app (ou um maplibregl.Map).
 * @param {object} options - Trail options.
 * @param {string} options.color - CSS color string for the trail hue.
 * @param {number} [options.width=2.5] - Line width in pixels.
 * @returns {{setPositions: function(Array<object>): void, setVisible: function(boolean): void,
 *   clear: function(): void, destroy: function(): void, id: string, getCoordinates: function(): number[][]}}
 */
export function createTrail(engine, { color, width = 2.5 } = {}) {
  const seq = ++_trailSeq;
  const sourceId = `dg-trail-${seq}`;
  const layerId = `dg-trail-${seq}-line`;
  let coords = [];
  let destroyed = false;
  let visible = true;
  let added = false;

  const data = () => ({
    type: 'FeatureCollection',
    features: coords.length >= 2
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }]
      : [],
  });

  function ensureLayer() {
    const map = mapOf(engine);
    if (!map || destroyed) return null;
    try {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: data() });
      }
      if (!map.getLayer(layerId)) {
        // Faixa das linhas do anfitrião (sob pontos e rótulos) quando existir.
        const before = map.getLayer('dg-slot-line') ? 'dg-slot-line' : undefined;
        map.addLayer({
          id: layerId,
          type: 'line',
          source: sourceId,
          layout: { 'line-cap': 'round', 'line-join': 'round', visibility: visible ? 'visible' : 'none' },
          paint: { 'line-color': color || '#ffffff', 'line-width': width, 'line-opacity': TRAIL_ALPHA },
        }, before);
      }
      added = true;
      return map;
    } catch {
      // Estilo ainda carregando (troca de mapa base): tenta de novo no próximo setPositions.
      return null;
    }
  }

  function push() {
    const map = ensureLayer();
    if (!map) return;
    try { map.getSource(sourceId)?.setData(data()); } catch { /* estilo trocando */ }
  }

  return {
    id: layerId,
    sourceId,
    /**
     * Replace the trail geometry with a chronological position list
     * (oldest first). Fewer than 2 distinct positions clears the trail.
     * @param {Array<{lon:number, lat:number, alt?:number}>} positions
     */
    setPositions(positions) {
      if (destroyed) return;
      coords = trailCoordinates(positions);
      push();
    },

    /** Temporarily hide/show the trail without discarding accumulated history. */
    setVisible(nextVisible) {
      visible = nextVisible !== false;
      const map = mapOf(engine);
      if (added && map?.getLayer(layerId)) {
        try { map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none'); } catch { /* */ }
      }
    },

    /** Empty the trail without removing the layer (cheap re-arm). */
    clear() {
      coords = [];
      if (added) push();
    },

    /** Coordenadas atuais [[lon, lat], ...] (teste e depuração). */
    getCoordinates() {
      return coords.map((c) => c.slice());
    },

    get visible() {
      return visible;
    },

    /** Remove the layer and source permanently (layer disable/teardown). */
    destroy() {
      destroyed = true;
      coords = [];
      const map = mapOf(engine);
      if (!map) return;
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch { /* mapa destruído */ }
      added = false;
    },
  };
}
