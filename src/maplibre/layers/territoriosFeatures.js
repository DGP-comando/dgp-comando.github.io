// src/maplibre/layers/territoriosFeatures.js
//
// Funções puras (sem DOM nem MapLibre) que montam as feições das camadas de
// territórios e do CAR no protótipo: polígonos, bordas pelo anel externo e
// rótulo no centroide (a mesma geometria da camada Cesium), células do CAR em
// MultiLineString por classe e a escolha de células para a vista/foco.

import { centroidOf, polygonParts } from '../../data/territoriosSpec.js';
import { decodeCell, nearestCells } from '../../data/slicedCells.js';

/**
 * GeoJSON de territórios -> três coleções (preenchimento, borda, rótulo) e a
 * lista de propriedades originais, indexada pelo `id` numérico de cada feição.
 * As propriedades ficam fora do GeoJSON do MapLibre porque ele serializa
 * arrays (ex.: `municipios`) em string no queryRenderedFeatures.
 *
 * Como na camada Cesium: partes com anel externo de menos de 4 vértices são
 * ignoradas; a borda é só o anel externo de cada parte; o rótulo fica no
 * centroide da primeira parte válida; a contagem é de feições com geometria.
 */
export function buildTerritorioFeatures(gj, labelOf) {
  const fills = [];
  const borders = [];
  const labels = [];
  const props = [];
  for (const f of gj?.features ?? []) {
    if (!f?.geometry) continue;
    const p = f.properties ?? {};
    const id = props.length;
    props.push(p);
    const parts = polygonParts(f.geometry).filter((rings) => rings?.[0] && rings[0].length >= 4);
    if (!parts.length) continue;
    const base = { i: id };
    fills.push({ type: 'Feature', id, properties: base, geometry: { type: 'MultiPolygon', coordinates: parts } });
    borders.push({
      type: 'Feature',
      id,
      properties: base,
      geometry: {
        type: 'MultiLineString',
        coordinates: parts.map((rings) => {
          const outer = rings[0];
          const [a] = outer;
          const b = outer[outer.length - 1];
          return a[0] === b[0] && a[1] === b[1] ? outer : [...outer, a];
        }),
      },
    });
    const c = centroidOf(parts[0]);
    if (c) {
      labels.push({
        type: 'Feature',
        id,
        properties: { label: String(labelOf(p) ?? '') },
        geometry: { type: 'Point', coordinates: c },
      });
    }
  }
  const fcOf = (features) => ({ type: 'FeatureCollection', features });
  return { fills: fcOf(fills), borders: fcOf(borders), labels: fcOf(labels), props, count: props.length };
}

/** Anéis planos [lon0, lat0, lon1, lat1, ...] -> coordenadas de MultiLineString. */
export function flatToCoords(flat) {
  const coords = [];
  for (let n = 0; n + 1 < flat.length; n += 2) coords.push([flat[n], flat[n + 1]]);
  return coords;
}

/**
 * Payload de uma célula fatiada -> uma feição MultiLineString por grupo
 * (classe) não vazio, com `properties[groupProp]` = valor do grupo, e a
 * contagem de trechos.
 */
export function cellFeatures(payload, key, index, groupsKey = 'classes', groupProp = 'classe') {
  const porGrupo = decodeCell(payload, key, index);
  const features = [];
  let lines = 0;
  porGrupo.forEach((flatLines, g) => {
    lines += flatLines.length;
    if (!flatLines.length) return;
    features.push({
      type: 'Feature',
      properties: { [groupProp]: index[groupsKey]?.[g] ?? null },
      geometry: { type: 'MultiLineString', coordinates: flatLines.map(flatToCoords) },
    });
  });
  return { features, lines };
}

/**
 * Células existentes que cruzam o bbox [w, s, e, n], das mais próximas do
 * centro do bbox (ou de `center` = [lon, lat]) para as mais distantes, até `cap`.
 */
export function cellsInBbox(bbox, index, cap = 24, center = null) {
  const [w, s, e, n] = bbox;
  const d = index.cell_deg;
  const [cx, cy] = center ?? [(w + e) / 2, (s + n) / 2];
  const out = [];
  for (let i = Math.floor(s / d); i <= Math.floor(n / d); i++) {
    for (let j = Math.floor(w / d); j <= Math.floor(e / d); j++) {
      const key = `${i}_${j}`;
      if (!index.cells?.[key]) continue;
      out.push({ key, dist: ((i + 0.5) * d - cy) ** 2 + ((j + 0.5) * d - cx) ** 2 });
    }
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, cap).map((c) => c.key);
}

/**
 * Células a carregar: com foco e o centro dentro do bbox, as do bbox (até
 * `focusCap`); senão as `perView` mais próximas do centro (mesma regra da
 * camada Cesium: nearestCells num raio de 2 células).
 */
export function wantedCells({ lat, lon }, index, { focus = null, perView = 9, focusCap = 24 } = {}) {
  if (focus) return cellsInBbox(focus, index, focusCap, [lon, lat]);
  return nearestCells(lat, lon, index, perView);
}
