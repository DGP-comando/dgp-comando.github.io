// src/maplibre/layers/energiaLogistica.js
//
// Grupo ENERGIA (classe Infraestrutura) + LOGÍSTICA AGRO do protótipo, portado
// de src/data/datageoEnergia.js, datageoDistribuicao.js e datageoLogistica.js:
//
//   - Linhas de transmissão (EPE): cor/largura por tensão, planejadas
//     tracejadas em âmbar.
//   - Linhas de distribuição (BDGD/Copel): células fatiadas por zoom, com foco
//     (src/maplibre/slicedLines.js).
//   - Subestações, usinas, armazéns, agroindústrias (SIGSIF e cadastro IDR),
//     rotas turísticas e CEASAs: os pontos de `makePointsLayer` do app. Mesma
//     cor/tamanho por ponto (energiaLogisticaEstilos.js, compartilhado com o
//     app), contorno preto, encolhendo de longe como o scaleByDistance do app,
//     rótulo acima do ponto com o mesmo teto de distância (um layer de rótulo
//     por teto, minzoom = zoomForHeight), legenda de cores com contagem por
//     grupo e o tooltip do app (nos que não têm, o próprio rótulo).
//
// Os arquivos /privado/ (agroindústrias) saem do bucket autenticado pelo
// mesmo dgFetchData do app (JWT do usuário logado).

import { dgFetchData } from '../../data/datageoClient.js';
import {
  AGRO_LEGENDA, ARMAZEM_LEGENDA, CEASA_LEGENDA, DISTRIBUICAO_KV, ENERGIA_CORES, IDR_GRUPOS, ROTA_LEGENDA,
  SUBESTACAO_LEGENDA, USINA_LEGENDA,
  agroindustriaEstilo, agroindustriaIdrEstilo, agroindustriaIdrTooltipHtml, agroindustriaTooltipHtml,
  armazemEstilo, ceasaEstilo, linhaTransmissaoClasse, rotaTuristicaEstilo, rotaTuristicaTooltipHtml,
  subestacaoEstilo, usinaEstilo,
} from '../../data/energiaLogisticaEstilos.js';
import { createSlicedLinesLayer } from '../slicedLines.js';
import { EMPTY_FC, TEXT_FONT, defineLayer, esc, fc, row, zoomForHeight } from '../kit.js';

const LOGISTICA = 'Logística agro';
const INFRA = 'Infraestrutura';

// ------------------------------------------------------------ utilitários

/** '#rrggbb' + alpha -> 'rgba(r,g,b,a)'. */
export function rgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

// scaleByDistance do app: NearFarScalar(80 km -> 1.0, 1400 km -> 0.45).
const Z_NEAR = zoomForHeight(80_000);
const Z_FAR = zoomForHeight(1_400_000);

/**
 * Features dos pontos: estilo do app por ponto (`estilo(props)` ou null para
 * ignorar), id sequencial (o tooltip busca as propriedades originais por ele,
 * sem as chaves internas) e contagem por grupo para a legenda.
 * @returns {{features: object[], counts: Record<string, number>, props: object[]}}
 */
export function pointFeatures(gj, estilo) {
  const features = [];
  const counts = {};
  const props = [];
  for (const f of gj?.features ?? []) {
    const [lon, lat] = f?.geometry?.coordinates ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = f.properties ?? {};
    const s = estilo(p);
    if (!s) continue;
    if (s.grupo) counts[s.grupo] = (counts[s.grupo] ?? 0) + 1;
    const id = props.length;
    props.push(p);
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        __size: s.size,
        __color: rgba(s.color, s.alpha ?? 1),
        __label: s.label ?? '',
        __ld: s.labelMaxDist ?? 0,
      },
    });
  }
  return { features, counts, props };
}

/** Legenda do painel: [{label, color, count}] na ordem de `legend`. */
export function legendWithCounts(legend, counts) {
  return legend.map((g) => ({ label: g.label, color: g.color, count: counts?.[g.grupo] ?? 0 }));
}

// Classes vt-* dos tooltips do app (entityHoverTooltip.js), só dentro de .dg-vt.
// `tooltipWidth` do app vira max-width do #tooltip enquanto ele mostra o nosso.
const VT_STYLE_ID = 'dg-energia-logistica-vt';
function ensureVtStyle() {
  if (typeof document === 'undefined' || document.getElementById(VT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VT_STYLE_ID;
  style.textContent = `
    #tooltip .dg-vt { font: 11px/1.5 'JetBrains Mono', monospace; color: #cbd5e1; white-space: normal; }
    #tooltip .dg-vt .vt-nome { color: #22d3ee; font-weight: 700; letter-spacing: .08em; margin-bottom: 2px; }
    #tooltip .dg-vt .vt-berco { color: #fbbf24; }
    #tooltip .dg-vt .vt-dim, #tooltip .dg-vt span.vt-dim { color: #64748b; }
    #tooltip .dg-vt .vt-fontes { margin-top: 6px; color: #475569; font-size: 9px; letter-spacing: .04em; }
    #tooltip:has(.dg-vt-w420) { max-width: 420px; }
    #tooltip:has(.dg-vt-w720) { max-width: 720px; }
  `;
  document.head.appendChild(style);
}

/** Envolve o HTML (já escapado) do tooltip do app. */
export function vtWrap(html, width) {
  ensureVtStyle();
  return html ? `<div class="dg-vt${width ? ` dg-vt-w${width}` : ''}">${html}</div>` : '';
}

/** Tooltip padrão dos pontos sem tooltip no app: o rótulo do ponto. */
const labelTooltip = (label) => (label ? `<div class="vt-nome">${esc(label)}</div>` : '');

// ------------------------------------------------------------------ pontos

/**
 * Camada de pontos equivalente ao `makePointsLayer` do app.
 * `labelDists`: todos os `labelMaxDist` que `estilo` pode devolver (um layer
 * de rótulo por teto; o teste confere contra os dados reais).
 */
export function makePointsLayer({
  id, name, category = LOGISTICA, icon, source, url, estilo, legend, labelDists, tooltip, tooltipWidth,
}) {
  const slug = id.replace(/^datageo-/, '');
  const sourceId = `dg-${slug}`;
  const circleId = `dg-${slug}-pt`;
  let counts = {};
  let props = [];

  const labelLayers = [...new Set(labelDists)].sort((a, b) => b - a).map((d) => ({
    id: `dg-${slug}-label-${Math.round(d / 1000)}k`,
    type: 'symbol',
    source: sourceId,
    minzoom: Math.max(0, zoomForHeight(d)),
    filter: ['==', ['get', '__ld'], d],
    layout: {
      'text-field': ['get', '__label'],
      'text-font': TEXT_FONT,
      'text-size': 11,
      'text-anchor': 'bottom',
      'text-offset': [0, -0.75],
      'text-max-width': 18,
      // Pontos maiores (usinas grandes, porto) ganham a disputa de espaço.
      'symbol-sort-key': ['-', 0, ['get', '__size']],
    },
    paint: { 'text-color': '#e2e8f0', 'text-halo-color': 'rgba(0,0,0,0.95)', 'text-halo-width': 1.4 },
  }));

  return defineLayer({
    id,
    name,
    category,
    icon,
    source,
    sources: { [sourceId]: { type: 'geojson', data: EMPTY_FC } },
    layers: [
      {
        id: circleId,
        type: 'circle',
        source: sourceId,
        layout: { 'circle-sort-key': ['get', '__size'] },
        paint: {
          'circle-color': ['get', '__color'],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            Z_FAR, ['*', ['get', '__size'], 0.45 / 2],
            Z_NEAR, ['*', ['get', '__size'], 0.5],
          ],
          'circle-stroke-color': 'rgba(0,0,0,0.55)',
          'circle-stroke-width': 1,
        },
      },
      ...labelLayers,
    ],
    interactive: [circleId],
    async load(ctx) {
      const resp = await dgFetchData(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const built = pointFeatures(await resp.json(), estilo);
      counts = built.counts;
      props = built.props;
      ctx.setData(sourceId, fc(built.features));
      return built.features.length;
    },
    tooltip: (p, feature) => {
      const original = props[feature?.id];
      if (tooltip) return vtWrap(original ? tooltip(original) : '', tooltipWidth);
      return vtWrap(labelTooltip(p.__label));
    },
    rowControls: () => ({ legend: legendWithCounts(legend, counts) }),
  });
}

// ----------------------------------------------------- linhas de transmissão

const LT_URL = '/data/linhas-transmissao-pr.geojson';
const LT_WIDTH = { kv525: 2.6, kv230: 1.8, baixa: 1.2, planejada: 2.2 };
// Cesium: PolylineDash com dashLength 16 px (metade traço, metade vão); no
// MapLibre o tracejado é medido em larguras de linha.
const LT_DASH = 8 / LT_WIDTH.planejada;

/**
 * Trechos das linhas de transmissão com a classe do app em `__classe`.
 * `count` segue o app: uma entidade por LineString (MultiLineString conta
 * cada parte).
 */
export function transmissaoFeatures(gj) {
  const features = [];
  let count = 0;
  for (const f of gj?.features ?? []) {
    const geom = f?.geometry;
    if (!geom) continue;
    const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
    const valid = lines.filter((c) => c && c.length >= 2);
    if (!valid.length) continue;
    count += valid.length;
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: valid },
      properties: { ...(f.properties ?? {}), __classe: linhaTransmissaoClasse(f.properties ?? {}) },
    });
  }
  return { features, count };
}

export function transmissaoTooltipHtml(p) {
  const kv = p.tensao != null && p.tensao !== '' ? `${p.tensao} kV` : '';
  const situacao = p.planejada ? `Planejada${p.ano ? ` (${p.ano})` : ''}` : `Em operação${p.ano ? ` desde ${p.ano}` : ''}`;
  return `<strong>${esc(p.nome || 'Linha de transmissão')}</strong>${row('Tensão', kv)}${row('Situação', situacao)}`;
}

const ltColor = ['match', ['get', '__classe'],
  ...Object.entries(ENERGIA_CORES).flatMap(([k, c]) => [k, rgba(c.css, c.alpha)]),
  rgba(ENERGIA_CORES.baixa.css, ENERGIA_CORES.baixa.alpha)];
const ltWidth = ['match', ['get', '__classe'], ...Object.entries(LT_WIDTH).flat(), 1.2];

const transmissaoLayer = defineLayer({
  id: 'datageo-transmissao',
  name: 'Linhas de transmissão',
  category: INFRA,
  icon: '⚡',
  source: 'EPE (operação + planejadas)',
  sources: { 'dg-transmissao': { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: 'dg-transmissao-line',
      type: 'line',
      source: 'dg-transmissao',
      filter: ['!=', ['get', '__classe'], 'planejada'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ltColor, 'line-width': ltWidth },
    },
    {
      id: 'dg-transmissao-planejada',
      type: 'line',
      source: 'dg-transmissao',
      filter: ['==', ['get', '__classe'], 'planejada'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': rgba(ENERGIA_CORES.planejada.css, ENERGIA_CORES.planejada.alpha),
        'line-width': LT_WIDTH.planejada,
        'line-dasharray': [LT_DASH, LT_DASH],
      },
    },
  ],
  interactive: ['dg-transmissao-line', 'dg-transmissao-planejada'],
  async load(ctx) {
    const resp = await fetch(LT_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { features, count } = transmissaoFeatures(await resp.json());
    ctx.setData('dg-transmissao', fc(features));
    return count;
  },
  tooltip: (p) => transmissaoTooltipHtml(p),
});

// ---------------------------------------------------- linhas de distribuição

const distribuicaoLayer = createSlicedLinesLayer({
  id: 'datageo-distribuicao',
  name: 'Linhas de distribuição',
  category: INFRA,
  icon: '🔗',
  source: 'ANEEL/BDGD (Copel)',
  baseUrl: '/data/distribuicao',
  groupsKey: 'tensoes',
  // Mesma ordem do index (13,8 por baixo, 34,5 por cima).
  grupos: [13.8, 34.5].map((kv) => ({
    value: kv,
    color: DISTRIBUICAO_KV[kv].css,
    opacity: DISTRIBUICAO_KV[kv].alpha,
    width: DISTRIBUICAO_KV[kv].width,
    label: `${String(kv).replace('.', ',')} kV`,
  })),
  maxHeight: 70_000,
});

// ------------------------------------------------------------------ pontos

const subestacoesLayer = makePointsLayer({
  id: 'datageo-subestacoes',
  name: 'Subestações',
  category: INFRA,
  icon: '🔌',
  source: 'EPE',
  url: '/data/subestacoes-pr.geojson',
  estilo: subestacaoEstilo,
  legend: SUBESTACAO_LEGENDA,
  labelDists: [900_000, 250_000],
});

const geracaoLayer = makePointsLayer({
  id: 'datageo-geracao',
  name: 'Usinas de energia',
  category: INFRA,
  icon: '💡',
  source: 'SIGEL/ANEEL',
  url: '/data/usinas-pr.geojson',
  estilo: usinaEstilo,
  legend: USINA_LEGENDA,
  labelDists: [1_500_000, 400_000, 130_000, 60_000],
});

const armazensLayer = makePointsLayer({
  id: 'datageo-armazens',
  name: 'Armazéns (CONAB)',
  icon: '🌾',
  source: 'CONAB/CDA 2023',
  url: '/data/armazens-conab-pr.geojson',
  estilo: armazemEstilo,
  legend: ARMAZEM_LEGENDA,
  labelDists: [2_000_000, 45_000],
});

const agroindustriasLayer = makePointsLayer({
  id: 'datageo-agroindustrias',
  name: 'Agroindústrias',
  icon: '🏭',
  source: 'SIGSIF/MAPA · OSM',
  url: '/privado/agroindustrias-pr.geojson',
  estilo: agroindustriaEstilo,
  tooltip: agroindustriaTooltipHtml,
  legend: AGRO_LEGENDA,
  labelDists: [120_000],
});

const agroindustriasIdrLayer = makePointsLayer({
  id: 'datageo-agroindustrias-idr',
  name: 'Agroindústrias (cadastro IDR)',
  icon: '🧺',
  source: 'IDR-Paraná 2023',
  url: '/privado/agroindustrias-idr-pr.geojson',
  estilo: agroindustriaIdrEstilo,
  tooltip: agroindustriaIdrTooltipHtml,
  tooltipWidth: 720,
  legend: IDR_GRUPOS,
  labelDists: [40_000],
});

const rotasTuristicasLayer = makePointsLayer({
  id: 'datageo-rotas-turisticas',
  name: 'Rotas turísticas',
  icon: '🧀',
  source: 'Rota do Queijo · Rota da Uva e Vinho',
  url: '/data/rotas-turisticas-pr.geojson',
  estilo: rotaTuristicaEstilo,
  tooltip: rotaTuristicaTooltipHtml,
  tooltipWidth: 420,
  legend: ROTA_LEGENDA,
  labelDists: [150_000],
});

const ceasasLayer = makePointsLayer({
  id: 'datageo-ceasas',
  name: 'CEASAs',
  icon: '🥬',
  source: 'CEASA/PR',
  url: '/data/ceasas-pr.geojson',
  estilo: ceasaEstilo,
  legend: CEASA_LEGENDA,
  labelDists: [2_500_000],
});

export default [
  transmissaoLayer,
  distribuicaoLayer,
  subestacoesLayer,
  geracaoLayer,
  armazensLayer,
  agroindustriasLayer,
  agroindustriasIdrLayer,
  rotasTuristicasLayer,
  ceasasLayer,
];
