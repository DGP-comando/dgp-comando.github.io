// src/maplibre/kit.js
//
// CONTRATO DAS CAMADAS DO PROTÓTIPO MAPLIBRE
// ==========================================
//
// Cada camada é um objeto simples (ver `defineLayer`). O registro
// (src/maplibre/registry.js) cuida do ciclo de vida: adiciona fontes e layers de
// estilo na primeira vez que a camada liga, alterna a visibilidade, chama
// `load` (e de novo a cada `refreshMs` enquanto ligada), mede o tempo, desenha
// a linha no painel de camadas (contagem, legenda, chips), o tooltip de hover e
// o clique.
//
//   {
//     id:        'datageo-clima'     // MESMO id da camada no app Cesium
//     name:      'Estações INMET'    // rótulo no painel (o mesmo do app)
//     category:  'Clima'             // mesmas categorias do app
//     icon, source                   // ícone e crédito curto, como no app
//     defaultOn: false
//
//     sources: { 'dg-clima': {type: 'geojson', data: EMPTY_FC} }
//     layers:  [ { id: 'dg-clima-pt', type: 'circle', source: 'dg-clima', ... } ]
//         Todo id de fonte e de layer começa com `dg-` (a troca de mapa base só
//         transplanta esses). Os layers entram escondidos; o registro liga todos
//         juntos. `minzoom`/`maxzoom` do próprio layer valem normalmente.
//         Ordem vertical: o registro encaixa cada layer numa faixa pelo tipo
//         (fill/raster/heatmap/hillshade < line < circle < symbol); para forçar
//         outra faixa use `metadata: {'dg:slot': 'fill'|'line'|'point'|'label'}`.
//
//     load:  async (ctx) => number | {count, info}
//         Busca os dados (use os MESMOS fetchers do app: datageoClient.js,
//         arquivos em /data) e chama ctx.setData(sourceId, featureCollection).
//         Devolve a contagem mostrada no painel. Fontes com `data` em URL não
//         precisam de load: o worker do MapLibre baixa e fatia sozinho, e a
//         contagem pode vir de `count: async (ctx) => n` (opcional).
//     refreshMs: 300000              // recarrega enquanto ligada (dado vivo)
//     onEnable(ctx) / onDisable(ctx) // para camadas dinâmicas (células, animação)
//
//     interactive: ['dg-clima-pt']   // layers que respondem a hover/clique
//     hoverState: 'dg-municipios'    // opcional: liga feature-state {hover:true}
//         na feição sob o cursor dessa fonte (exige id nas feições/promoteId)
//     tooltip: (props, feature, ctx) => html   // HTML já escapado (use esc/row)
//     click:   (props, feature, ctx) => void   // opcional
//
//     rowControls: (ctx) => ({ chips: [{id, label, active}], legend: [{label, color, count?}] })
//     onChip:      (chipId, ctx) => void        // o registro redesenha a linha depois
//     focusOn:     (bbox|null, ctx) => void     // município em foco (ver navigation.js):
//         camadas que se escondem por escala devem aparecer dentro do bbox
//         [w, s, e, n] qualquer que seja o zoom; null desarma.
//   }
//
// ctx = { map, setData(sourceId, data), refreshPanel(), getLayer(id), isOn(id),
//         focus: bbox|null }
//
// REGRA DE OURO: nada importado daqui pode importar 'cesium', direta ou
// indiretamente (o protótipo não carrega o Cesium; o import viraria o global
// `Cesium` indefinido). `node scripts/check-maplibre-no-cesium.mjs` verifica o
// grafo. Quando precisar de uma função pura que mora num módulo Cesium
// (tooltip, cores, parse), mova-a para um módulo novo sem Cesium e reexporte do
// original, como src/data/slicedCells.js.

export const EMPTY_FC = Object.freeze({ type: 'FeatureCollection', features: [] });

export const TEXT_FONT = ['Noto Sans Regular'];
export const TEXT_FONT_BOLD = ['Noto Sans Bold'];

/** Halo padrão dos rótulos, legível sobre satélite e OSM. */
export const LABEL_PAINT = Object.freeze({
  'text-color': '#f4f7fb',
  'text-halo-color': 'rgba(5,8,13,0.9)',
  'text-halo-width': 1.4,
});

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Linha "rótulo valor" do tooltip; some quando o valor é vazio. */
export const row = (label, value) =>
  value === null || value === undefined || value === '' ? '' : `<div><span>${esc(label)}</span> ${esc(value)}</div>`;

export const fc = (features) => ({ type: 'FeatureCollection', features });

/** Ponto GeoJSON; devolve null para coordenadas inválidas (filtre com `.filter(Boolean)`). */
export function point(lon, lat, properties = {}, id) {
  const x = Number(lon);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties };
  if (id !== undefined) f.id = id;
  return f;
}

/** `['match', ['get', prop], k1, c1, k2, c2, ..., fallback]` a partir de um objeto. */
export function matchColor(prop, table, fallback = '#94a3b8') {
  const pairs = Object.entries(table).flat();
  return pairs.length ? ['match', ['get', prop], ...pairs, fallback] : fallback;
}

/** Converte `Cesium.Color`-like {red,green,blue,alpha} (0-1) em rgba() CSS. */
export function cssColor(c) {
  if (!c) return null;
  if (typeof c === 'string') return c;
  const to255 = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  return `rgba(${to255(c.red)},${to255(c.green)},${to255(c.blue)},${Number(c.alpha ?? 1)})`;
}

/**
 * Zoom do MapLibre equivalente a uma altura de câmera do Cesium (metros), para
 * portar os tetos de escala (`maxHeight`) das camadas: minzoom = zoomForHeight(h).
 * Aproximação para a latitude do PR numa tela de ~1400 px: 100 km -> ~10.
 */
export function zoomForHeight(heightM) {
  return Math.log2(1.0e8 / Math.max(1, Number(heightM) || 1));
}

const LAYER_KEYS = new Set([
  'id', 'name', 'category', 'icon', 'source', 'detail', 'defaultOn', 'sources', 'layers', 'load', 'count',
  'refreshMs', 'onEnable', 'onDisable', 'interactive', 'hoverState', 'tooltip', 'click', 'rowControls', 'onChip',
  'focusOn',
]);

/**
 * Valida e devolve a definição (erros de contrato aparecem no carregamento do
 * módulo, não no primeiro clique).
 */
export function defineLayer(def) {
  for (const key of Object.keys(def)) {
    if (!LAYER_KEYS.has(key)) throw new Error(`[maplibre] camada ${def.id}: chave desconhecida "${key}"`);
  }
  if (!def.id || !def.name || !def.category) throw new Error(`[maplibre] camada sem id/name/category: ${def.id}`);
  for (const sid of Object.keys(def.sources ?? {})) {
    if (!sid.startsWith('dg-')) throw new Error(`[maplibre] ${def.id}: fonte "${sid}" sem prefixo dg-`);
  }
  for (const layer of def.layers ?? []) {
    if (!layer.id?.startsWith('dg-')) throw new Error(`[maplibre] ${def.id}: layer "${layer.id}" sem prefixo dg-`);
  }
  for (const lid of def.interactive ?? []) {
    if (!(def.layers ?? []).some((l) => l.id === lid)) {
      throw new Error(`[maplibre] ${def.id}: interactive "${lid}" não está em layers`);
    }
  }
  return Object.freeze({ sources: {}, layers: [], interactive: [], ...def });
}
