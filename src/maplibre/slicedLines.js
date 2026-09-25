// src/maplibre/slicedLines.js
//
// Camadas de LINHAS FATIADAS no protótipo MapLibre: a mesma grade estática
// (index.json + <i>_<j>.json, formato em src/data/slicedLineLayer.js) que o app
// Cesium carrega por zoom, aqui decodificada em GeoJSON e reunida numa fonte só.
//
// API
// ---
//   createSlicedLinesLayer({
//     id, name, category, icon, source,  // como no app (mesmo id)
//     baseUrl,          // '/data/estradas' (index.json + <i>_<j>.json)
//     groupsKey,        // campo do index com a lista de grupos: 'classes', 'tensoes'
//     grupos,           // valores de grupo conhecidos, na ordem de desenho (o 1º fica
//                       // por baixo); cada item é o valor ('rurais', 34.5) ou
//                       // {value, color, width, opacity?, maxHeight?, label?}
//     styleFor,         // opcional: (valor) => {color, width, opacity?, maxHeight?, label?}
//                       // cor CSS; `maxHeight` (m) é o teto próprio do grupo
//     maxHeight,        // teto da camada (m de câmera no Cesium) -> minzoom
//     maxCellsPerView = 9, maxLoadedCells = 24,
//   }) -> objeto do contrato defineLayer (kit.js), com onEnable/onDisable/focusOn/
//        rowControls (legenda com os trechos carregados por grupo).
//
// Um layer de linha por grupo (filtro na propriedade `grupo`), mais um de
// reserva para valores fora de `grupos` (estilo branco do app). Os tetos viram
// minzoom via zoomForHeight. Depois de cada movimento (moveend) carrega as
// células existentes que cruzam a vista, das mais próximas do centro para fora,
// até `maxCellsPerView`; acima de `maxLoadedCells` descarta as mais antigas fora
// da vista. FOCO: com um município em foco todos os layers da camada passam a
// valer em qualquer zoom (setLayerZoomRange 0-24) e as células carregadas são as
// do bbox do município (ainda limitadas por `maxCellsPerView`); `focusOn(null)`
// devolve os tetos. As funções puras (cellFeatures, cellsForView, groupStyles,
// layerSpecs) são exportadas para os testes.

import { decodeCell } from '../data/slicedCells.js';
import { EMPTY_FC, defineLayer, fc, zoomForHeight } from './kit.js';

const FALLBACK_STYLE = Object.freeze({ color: '#ffffff', opacity: 0.6, width: 1 });
const MAX_ZOOM = 24;

/**
 * Features de uma célula: uma MultiLineString por grupo não vazio, com
 * `grupo` (valor do index) e `cell` nas propriedades.
 */
export function cellFeatures(payload, key, index, groupsKey) {
  const groups = index?.[groupsKey] ?? [];
  const out = [];
  decodeCell(payload, key, index).forEach((lines, k) => {
    if (!lines.length) return;
    const coordinates = lines.map((flat) => {
      const coords = new Array(flat.length / 2);
      for (let n = 0; n < flat.length; n += 2) coords[n / 2] = [flat[n], flat[n + 1]];
      return coords;
    });
    out.push({
      type: 'Feature',
      properties: { grupo: groups[k] ?? k, cell: key, trechos: lines.length },
      geometry: { type: 'MultiLineString', coordinates },
    });
  });
  return out;
}

/**
 * Células existentes no index que cruzam `bounds` [w, s, e, n], ordenadas pela
 * distância do centro da célula a `center` {lat, lon}, até `limit`.
 */
export function cellsForView(index, bounds, center, limit = 9) {
  const d = index?.cell_deg;
  if (!d || !index.cells || !bounds) return [];
  let [w, s, e, n] = bounds;
  // Com a câmera muito inclinada a vista alcança o horizonte: limita a varredura
  // a 60 células para cada lado do centro (15° na grade de 0,25°).
  const span = 60 * d;
  w = Math.max(w, center.lon - span);
  e = Math.min(e, center.lon + span);
  s = Math.max(s, center.lat - span);
  n = Math.min(n, center.lat + span);
  if (!(w <= e && s <= n)) return [];
  const out = [];
  for (let i = Math.floor(s / d); i <= Math.floor(n / d); i++) {
    for (let j = Math.floor(w / d); j <= Math.floor(e / d); j++) {
      const key = `${i}_${j}`;
      if (!index.cells[key]) continue;
      const dist = ((i + 0.5) * d - center.lat) ** 2 + ((j + 0.5) * d - center.lon) ** 2;
      out.push({ key, dist });
    }
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, limit).map((c) => c.key);
}

/** Interseção de dois bbox [w, s, e, n], ou null. */
export function intersectBbox(a, b) {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w <= e && s <= n ? [w, s, e, n] : null;
}

/** Estilo resolvido de cada grupo: {value, color, opacity, width, minzoom, label}. */
export function groupStyles({ grupos = [], styleFor, maxHeight }) {
  const layerMin = zoomForHeight(maxHeight);
  return grupos.map((g) => {
    const value = g && typeof g === 'object' ? g.value : g;
    const style = { ...FALLBACK_STYLE, ...(g && typeof g === 'object' ? g : {}), ...(styleFor?.(value) ?? {}) };
    const gate = Number.isFinite(style.maxHeight) ? zoomForHeight(style.maxHeight) : layerMin;
    return {
      value,
      color: style.color,
      opacity: style.opacity ?? 1,
      width: style.width,
      minzoom: Math.max(layerMin, gate),
      label: style.label ?? String(value),
    };
  });
}

/** Source e layers de estilo da camada (um por grupo + reserva). */
export function layerSpecs(slug, styles, layerMin) {
  const sourceId = `dg-${slug}`;
  const layers = styles.map((st, k) => ({
    id: `dg-${slug}-${k}`,
    type: 'line',
    source: sourceId,
    minzoom: st.minzoom,
    filter: ['==', ['get', 'grupo'], st.value],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': st.color, 'line-opacity': st.opacity, 'line-width': st.width },
  }));
  layers.unshift({
    id: `dg-${slug}-outros`,
    type: 'line',
    source: sourceId,
    minzoom: layerMin,
    filter: ['!', ['in', ['get', 'grupo'], ['literal', styles.map((s) => s.value)]]],
    paint: { 'line-color': FALLBACK_STYLE.color, 'line-opacity': FALLBACK_STYLE.opacity, 'line-width': FALLBACK_STYLE.width },
  });
  return { sourceId, layers };
}

export function createSlicedLinesLayer(config) {
  const {
    id, name, category, icon, source, baseUrl, groupsKey, maxHeight,
    maxCellsPerView = 9,
    maxLoadedCells = 24,
  } = config;
  const slug = id.replace(/^datageo-/, '');
  const log = `[maplibre:${id}]`;
  const styles = groupStyles(config);
  const layerMin = zoomForHeight(maxHeight);
  const { sourceId, layers } = layerSpecs(slug, styles, layerMin);
  const minzoomOf = new Map(layers.map((l) => [l.id, l.minzoom]));

  let index = null;
  let indexPromise = null;
  const cells = new Map(); // key -> {features, lastSeen}
  const inflight = new Set();
  let enabled = false;
  let focus = null;
  let ctxRef = null;
  let onMoveEnd = null;
  let debounce = null;
  let lastError = null;

  function loadIndex() {
    indexPromise ??= fetch(`${baseUrl}/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`index.json HTTP ${r.status}`);
        return r.json();
      })
      .then((idx) => {
        if (!idx?.cells || !idx.cell_deg || !idx.escala || !Array.isArray(idx[groupsKey])) {
          throw new Error(`index.json de ${id} sem cells/cell_deg/escala/${groupsKey}`);
        }
        index = idx;
        return idx;
      })
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
    return indexPromise;
  }

  function counts() {
    const byGroup = new Map();
    let total = 0;
    for (const cell of cells.values()) {
      for (const f of cell.features) {
        byGroup.set(f.properties.grupo, (byGroup.get(f.properties.grupo) ?? 0) + f.properties.trechos);
        total += f.properties.trechos;
      }
    }
    return { total, byGroup };
  }

  function push() {
    const features = [];
    for (const cell of cells.values()) features.push(...cell.features);
    ctxRef?.setData(sourceId, fc(features));
    ctxRef?.refreshPanel();
  }

  async function loadCell(key) {
    if (cells.has(key) || inflight.has(key)) return false;
    inflight.add(key);
    try {
      const r = await fetch(`${baseUrl}/${key}.json`);
      if (!r.ok) throw new Error(`célula ${key} HTTP ${r.status}`);
      cells.set(key, { features: cellFeatures(await r.json(), key, index, groupsKey), lastSeen: Date.now() });
      return true;
    } catch (err) {
      lastError = err?.message || String(err);
      console.warn(log, err);
      return false;
    } finally {
      inflight.delete(key);
    }
  }

  function evict(keep) {
    if (cells.size <= maxLoadedCells) return;
    const antigas = [...cells.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key] of antigas) {
      if (cells.size <= maxLoadedCells) break;
      cells.delete(key);
    }
  }

  /** Bbox e centro de onde carregar agora, ou null se a camada está acima do teto. */
  function viewTarget(map) {
    const b = map.getBounds();
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const c = map.getCenter();
    let center = { lat: c.lat, lon: c.lng };
    if (focus) {
      const inside = center.lon >= focus[0] && center.lon <= focus[2] && center.lat >= focus[1] && center.lat <= focus[3];
      if (!inside) center = { lat: (focus[1] + focus[3]) / 2, lon: (focus[0] + focus[2]) / 2 };
      return { bounds: intersectBbox(view, focus) ?? focus, center };
    }
    if (map.getZoom() < layerMin) return null;
    return { bounds: view, center };
  }

  async function sync() {
    if (!enabled || !ctxRef) return;
    const target = viewTarget(ctxRef.map);
    if (!target) return;
    await loadIndex();
    const keys = cellsForView(index, target.bounds, target.center, maxCellsPerView);
    const now = Date.now();
    for (const key of keys) {
      const cell = cells.get(key);
      if (cell) cell.lastSeen = now;
    }
    const loaded = await Promise.all(keys.map(loadCell));
    const before = cells.size;
    evict(new Set(keys));
    if (enabled && (loaded.some(Boolean) || cells.size !== before)) push();
  }

  function schedule(ms = 120) {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      sync().catch((err) => {
        lastError = err?.message || String(err);
        console.warn(log, err);
      });
    }, ms);
  }

  function applyZoomRanges(map) {
    for (const [lid, min] of minzoomOf) {
      if (map.getLayer(lid)) map.setLayerZoomRange(lid, focus ? 0 : min, MAX_ZOOM);
    }
  }

  return defineLayer({
    id,
    name,
    category,
    icon,
    source,
    sources: { [sourceId]: { type: 'geojson', data: EMPTY_FC } },
    layers,

    async onEnable(ctx) {
      ctxRef = ctx;
      enabled = true;
      applyZoomRanges(ctx.map);
      if (!onMoveEnd) {
        onMoveEnd = () => schedule();
        ctx.map.on('moveend', onMoveEnd);
      }
      if (cells.size) push();
    },

    onDisable(ctx) {
      enabled = false;
      clearTimeout(debounce);
      if (onMoveEnd) ctx.map.off('moveend', onMoveEnd);
      onMoveEnd = null;
    },

    async load() {
      await loadIndex();
      await sync();
      // Total da malha (o index sabe); os trechos carregados por grupo ficam na
      // legenda, que o registro redesenha a cada célula (refreshPanel).
      const total = Number(index?.trechos) || counts().total;
      return { count: total, info: `por célula a partir do zoom ${layerMin.toFixed(1)}` };
    },

    focusOn(bbox, ctx) {
      ctxRef = ctx;
      focus = bbox ?? null;
      applyZoomRanges(ctx.map);
      schedule(0);
    },

    rowControls() {
      const { byGroup } = counts();
      return {
        legend: styles.map((st) => ({ label: st.label, color: st.color, count: byGroup.get(st.value) ?? 0 })),
      };
    },
  });
}
