// src/maplibre/layers/transporte.js
//
// Grupo TRANSPORTE do protótipo (categoria Infraestrutura), portado do app:
//   - datageo-ferrovias      (src/data/datageoLayers.js)
//   - datageo-rodovias       (src/data/datageoRodovias.js)
//   - datageo-estradas       (src/data/datageoEstradas.js + slicedLineLayer.js)
//   - datageo-estradas-conveniadas (src/data/datageoEstradasConveniadas.js)
// Cores, larguras (px, como as ground polylines do app), tetos de escala e
// tooltip seguem o código Cesium. Ferrovias, rodovias e estradas não têm pick
// no app (allowPicking=false / sem handler), então não têm tooltip aqui.

import { dgFetchData } from '../../data/datageoClient.js';
import { GRUPOS, tooltipHtml } from '../../data/estradasConveniadasTooltip.js';
import { lineStringsFromGeojson } from '../../data/geojsonLines.js';
import { createSlicedLinesLayer } from '../slicedLines.js';
import { EMPTY_FC, defineLayer, fc } from '../kit.js';

const LINE_LAYOUT = Object.freeze({ 'line-cap': 'round', 'line-join': 'round' });

async function fetchJson(url, fetcher = fetch) {
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ ferrovias

export const FERROVIAS_URL = '/data/ferrovias-pr.geojson';

export const ferroviasLayer = defineLayer({
  id: 'datageo-ferrovias',
  name: 'Ferrovias',
  category: 'Infraestrutura',
  icon: '🚆',
  source: 'OpenStreetMap',
  sources: { 'dg-ferrovias': { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: 'dg-ferrovias-line',
      type: 'line',
      source: 'dg-ferrovias',
      layout: LINE_LAYOUT,
      paint: { 'line-color': '#f59e0b', 'line-opacity': 0.65, 'line-width': 2 },
    },
  ],
  // O app conta as entidades do GeoJsonDataSource: uma por feição.
  async load(ctx) {
    const geo = await fetchJson(FERROVIAS_URL);
    ctx.setData('dg-ferrovias', geo);
    return geo.features?.length ?? 0;
  },
});

// ------------------------------------------------------------------ rodovias

export const RODOVIAS_FED_URL = '/data/rodovias-federais-pr.geojson';
export const RODOVIAS_EST_URL = '/data/rodovias-estaduais-pr.geojson';

export const RODOVIAS_STYLE = Object.freeze({
  federais: Object.freeze({ color: '#fbbf24', opacity: 0.85, width: 2.4, label: 'Federais (BR)' }),
  estaduais: Object.freeze({ color: '#7dd3fc', opacity: 0.6, width: 1.6, label: 'Estaduais (PR/PRC)' }),
});

const rodoviaPaint = (st) => ({ 'line-color': st.color, 'line-opacity': st.opacity, 'line-width': st.width });

export const rodoviasLayer = defineLayer({
  id: 'datageo-rodovias',
  name: 'Rodovias',
  category: 'Infraestrutura',
  icon: '🛣️',
  source: 'OSM · DNIT/DER-PR',
  sources: {
    'dg-rodovias-fed': { type: 'geojson', data: EMPTY_FC },
    'dg-rodovias-est': { type: 'geojson', data: EMPTY_FC },
  },
  // Mesma ordem de desenho do app: federais primeiro, estaduais por cima.
  layers: [
    { id: 'dg-rodovias-fed-line', type: 'line', source: 'dg-rodovias-fed', layout: LINE_LAYOUT, paint: rodoviaPaint(RODOVIAS_STYLE.federais) },
    { id: 'dg-rodovias-est-line', type: 'line', source: 'dg-rodovias-est', layout: LINE_LAYOUT, paint: rodoviaPaint(RODOVIAS_STYLE.estaduais) },
  ],
  // Contagem do app: trechos desenháveis (lineStringsFromGeojson) dos dois níveis.
  async load(ctx) {
    const [fed, est] = await Promise.all([fetchJson(RODOVIAS_FED_URL), fetchJson(RODOVIAS_EST_URL)]);
    ctx.setData('dg-rodovias-fed', fed);
    ctx.setData('dg-rodovias-est', est);
    return lineStringsFromGeojson(fed).length + lineStringsFromGeojson(est).length;
  },
});

// ------------------------------------------------------------------ estradas municipais

// datageoEstradas.js: frio para o asfalto urbano, quente para a terra das
// vicinais; urbanas só abaixo de 30 km, a camada toda abaixo de 90 km.
export const ESTRADAS_GRUPOS = Object.freeze([
  Object.freeze({ value: 'urbanas', label: 'Urbanas', color: '#f1f5f9', opacity: 0.5, width: 1.0, maxHeight: 30_000 }),
  Object.freeze({ value: 'rurais', label: 'Rurais', color: '#a8a29e', opacity: 0.55, width: 1.2 }),
]);

export const estradasLayer = createSlicedLinesLayer({
  id: 'datageo-estradas',
  name: 'Estradas municipais',
  category: 'Infraestrutura',
  icon: '🛤️',
  source: 'OpenStreetMap',
  baseUrl: '/data/estradas',
  groupsKey: 'classes',
  grupos: ESTRADAS_GRUPOS,
  maxHeight: 90_000,
});

// ------------------------------------------------------------------ estradas conveniadas

export const CONVENIADAS_URL = '/privado/estradas-conveniadas-pr.geojson';
const CONV_SRC = 'dg-estradas-conveniadas';
const CONV_HIT = 'dg-estradas-conveniadas-hit';

/** Layer de linha de um conjunto (grupo de GRUPOS). */
export function conveniadaLayerSpec(g) {
  return {
    id: `dg-estradas-conveniadas-${g.id}`,
    type: 'line',
    source: CONV_SRC,
    filter: ['==', ['get', 'grupo'], g.id],
    layout: LINE_LAYOUT,
    paint: { 'line-color': g.css, 'line-opacity': g.alpha, 'line-width': g.width },
  };
}

/** Filtro do layer de hover: só os conjuntos visíveis. */
export const conveniadasHitFilter = (visivel) => ['in', ['get', 'grupo'], ['literal', GRUPOS.filter((g) => visivel[g.id]).map((g) => g.id)]];

/** Contagem de feições por conjunto (a legenda do app). */
export function contarPorGrupo(features) {
  const counts = Object.fromEntries(GRUPOS.map((g) => [g.id, 0]));
  for (const f of features ?? []) {
    if (f?.properties?.grupo in counts) counts[f.properties.grupo] += 1;
  }
  return counts;
}

/**
 * Tooltip do app num invólucro com estilo inline (o CSS do protótipo não tem
 * as classes .vt-* do app).
 */
export function conveniadaTooltip(props) {
  const html = tooltipHtml(props);
  if (!html) return '';
  return `<div class="vt" style="font:11px/1.5 var(--font-mono, monospace);color:#cbd5e1;white-space:normal;overflow-wrap:anywhere">${html
    .replace('class="vt-nome" style="', 'class="vt-nome" style="font-weight:700;margin-bottom:2px;')
    .replace('class="vt-status"', 'class="vt-status" style="color:#94a3b8;margin-bottom:4px"')}</div>`;
}

export const estradasConveniadasLayer = (() => {
  const visivel = Object.fromEntries(GRUPOS.map((g) => [g.id, true]));
  let counts = Object.fromEntries(GRUPOS.map((g) => [g.id, 0]));
  // z do app: automatizado por baixo, conveniadas por cima.
  const porZ = [...GRUPOS].sort((a, b) => a.z - b.z);

  function applyVisibility(map) {
    for (const g of GRUPOS) {
      const lid = conveniadaLayerSpec(g).id;
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', visivel[g.id] ? 'visible' : 'none');
    }
    if (map.getLayer(CONV_HIT)) map.setFilter(CONV_HIT, conveniadasHitFilter(visivel));
  }

  return defineLayer({
    id: 'datageo-estradas-conveniadas',
    name: 'Estradas Rurais Conveniadas',
    category: 'Infraestrutura',
    icon: '🚜',
    source: 'SEAB-PR',
    sources: { [CONV_SRC]: { type: 'geojson', data: EMPTY_FC } },
    layers: [
      ...porZ.map(conveniadaLayerSpec),
      {
        // Faixa invisível de 12 px para o hover pegar as linhas finas.
        id: CONV_HIT,
        type: 'line',
        source: CONV_SRC,
        filter: conveniadasHitFilter(visivel),
        paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 12 },
      },
    ],
    interactive: [CONV_HIT],
    // O registro liga todos os layers juntos; os chips desligados voltam a sumir.
    onEnable(ctx) {
      applyVisibility(ctx.map);
    },
    async load(ctx) {
      const geo = await fetchJson(CONVENIADAS_URL, dgFetchData);
      const features = geo.features ?? [];
      counts = contarPorGrupo(features);
      ctx.setData(CONV_SRC, fc(features));
      return GRUPOS.reduce((n, g) => n + (visivel[g.id] ? counts[g.id] : 0), 0);
    },
    tooltip: (props) => conveniadaTooltip(props),
    rowControls: () => ({
      chips: GRUPOS.map((g) => ({ id: g.id, label: g.label, active: visivel[g.id] })),
      legend: GRUPOS.map((g) => ({ label: g.label, color: g.css, count: counts[g.id] })),
    }),
    onChip(chipId, ctx) {
      if (!(chipId in visivel)) return;
      visivel[chipId] = !visivel[chipId];
      applyVisibility(ctx.map);
    },
  });
})();

export default [ferroviasLayer, rodoviasLayer, estradasLayer, estradasConveniadasLayer];
