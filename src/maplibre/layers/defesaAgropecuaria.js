// src/maplibre/layers/defesaAgropecuaria.js
//
// Grupo DEFESA AGROPECUÁRIA: cadastros da ADAPAR.
//   - Propriedades com exploração pecuária ativa: um ponto por propriedade
//     (~257 mil), cor pela DAP/CAF informada no cadastro ou, no chip
//     Atividade, pela atividade (espécies da ADAPAR de 2022 e 2024); ponto VAZADO =
//     coordenada fora do município declarado. O arquivo sobe gzipado
//     (22 MB -> 6 MB) e é descomprimido aqui.
//   - Estabelecimentos registrados (produtos veterinários, animais vivos,
//     agrotóxicos, fertilizantes, Unidades de Consolidação, indústrias de
//     produtos de origem animal): pontos de
//     makePointsLayer (energiaLogistica.js), uma camada por cadastro.
//   - Unidades da ADAPAR (escritórios regionais e locais): público, do site
//     oficial (scripts/build_adapar_unidades.py -> public/data).
//
// Bucket privado (produtor + coordenada da propriedade): sem usuário liberado
// as camadas não carregam. Estilos e tooltips: src/data/defesaAgropecuariaEstilos.js.

import { periodo } from '../../data/cafFamilias.js';
import { dgFetchData } from '../../data/datageoClient.js';
import {
  ADAPAR_CONTORNO, ADAPAR_LABEL_DIST, ATIVIDADES_CORES, AGROTOXICOS_LEGENDA, ANIMAIS_LEGENDA, CONSOLIDACAO_LEGENDA, EXPLORACOES_CORES,
  FERTILIZANTES_LEGENDA, INDUSTRIAS_LEGENDA, UNIDADES_LEGENDA, VETERINARIOS_LEGENDA, agrotoxicoEstilo, agrotoxicoTooltip, animaisVivosEstilo, animaisVivosTooltip,
  consolidacaoEstilo, consolidacaoTooltip, exploracaoTooltip, fertilizanteEstilo, fertilizanteTooltip, industriaEstilo,
  industriaTooltip, unidadeAdaparEstilo, unidadeAdaparTooltip, veterinarioEstilo, veterinarioTooltip,
} from '../../data/defesaAgropecuariaEstilos.js';
import { EMPTY_FC, defineLayer, fc, fmtInt } from '../kit.js';
import { makePointsLayer } from './energiaLogistica.js';

export const DEFESA_AGROPECUARIA = 'Defesa Agropecuária';

// ------------------------------------------------------------ propriedades

let resumoP = null; // adapar-exploracoes-municipios.json

/** Soma o resumo por município (build) nos IBGEs: {total, g, a, ...metadados}; null sem dado. */
export function resumoExploracoes(d, ibges) {
  if (!d) return null;
  const g = d.grupos.map(() => 0);
  const a = d.atividades.map(() => 0);
  for (const c of ibges ?? []) {
    const m = d.municipios?.[String(c)];
    m?.g.forEach((n, i) => { g[i] += n; });
    m?.a.forEach((n, i) => { a[i] += n; });
  }
  const { referencia, fonte_atividade: fonteAtividade, grupos, atividades } = d;
  return { total: g.reduce((x, y) => x + y, 0), g, a, referencia, fonteAtividade, grupos, atividades };
}

/** Propriedades com exploração pecuária dos municípios (ficha); null sem sessão liberada. */
export function getExploracoesMunicipios(ibges) {
  resumoP ??= dgFetchData('/privado/adapar-exploracoes-municipios.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => {
      if (!d) resumoP = null;
      return d;
    });
  return resumoP.then((d) => resumoExploracoes(d, ibges));
}

const SRC = 'dg-adapar-exploracoes';
const PT = 'dg-adapar-exploracoes-pt';

/** JSON de um corpo gzipado (o arquivo já sobe comprimido para o bucket). */
export const gunzipJson = (resp) => new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).json();

/** Chave dos chips: DAP/CAF (g) ou atividade (a); `rotulos` é o campo do arquivo com os nomes. */
export const EXPLORACOES_MODOS = Object.freeze([
  { id: 'dap', chip: 'DAP/CAF', prop: 'g', rotulos: 'grupos', cores: EXPLORACOES_CORES },
  { id: 'atividade', chip: 'Atividade', prop: 'a', rotulos: 'atividades', cores: ATIVIDADES_CORES },
]);

/** Features dos pontos (id = índice da linha em `p`) e contagem por grupo e por atividade. */
export function exploracoesFeatures(d) {
  const counts = new Array(d?.grupos?.length ?? 0).fill(0);
  const countsA = new Array(d?.atividades?.length ?? 0).fill(0);
  const features = (d?.p ?? []).map(([lon, lat, , g, fora, , , , , a], id) => {
    counts[g] = (counts[g] ?? 0) + 1;
    if (a != null) countsA[a] = (countsA[a] ?? 0) + 1;
    return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { g, fora, a } };
  });
  return { features, counts, countsA };
}

/** Legenda de um modo, key = índice da classe (valor de `modo.prop` na feição). */
export const exploracoesLegenda = (counts, rotulos, cores = EXPLORACOES_CORES) => counts
  .map((count, i) => ({ key: i, label: rotulos[i], color: cores[i], count }));

const corDo = (modo) => ['match', ['get', modo.prop], ...modo.cores.flatMap((c, i) => [i, c]), '#94a3b8'];
const vazado = ['==', ['get', 'fora'], 1];
const pintura = (modo) => ({
  'circle-color': ['case', vazado, 'rgba(0,0,0,0)', corDo(modo)],
  'circle-stroke-color': ['case', vazado, corDo(modo), 'rgba(0,0,0,0.55)'],
});

let dados = null; // adapar-exploracoes.json
let contagens = {}; // modo.id -> [n por classe]
let modo = EXPLORACOES_MODOS[0];

export const exploracoesLayer = defineLayer({
  id: 'datageo-adapar-exploracoes',
  name: 'Propriedades com exploração pecuária',
  category: DEFESA_AGROPECUARIA,
  icon: '🐄',
  source: 'ADAPAR',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [{
    id: PT,
    type: 'circle',
    source: SRC,
    // DAP/CAF ativa (grupo 0) por cima do cinza de quem não informou.
    layout: { 'circle-sort-key': ['-', 0, ['get', 'g']] },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 10, 3, 14, 6],
      ...pintura(modo),
      'circle-stroke-width': ['case', vazado, 1.4, 0.5],
      'circle-opacity': 0.9,
    },
  }],
  interactive: [PT],
  async load(ctx) {
    const resp = await dgFetchData('/privado/adapar-exploracoes.json.gz');
    if (!resp.ok) throw new Error(resp.status < 500 ? 'acesso restrito: entre com usuário liberado' : `HTTP ${resp.status}`);
    dados = await gunzipJson(resp);
    const { features, counts, countsA } = exploracoesFeatures(dados);
    contagens = { dap: counts, atividade: countsA };
    ctx.setData(SRC, fc(features));
    return {
      count: features.length,
      info: `${periodo(dados.referencia)} · ${fmtInt(dados.sem_coordenada)} propriedades sem coordenada fora do mapa`,
    };
  },
  tooltip: (_p, feature) => exploracaoTooltip(dados?.p?.[feature?.id], dados),
  rowControls: () => ({
    chips: EXPLORACOES_MODOS.map((m) => ({ id: `modo-${m.id}`, label: m.chip, active: m === modo })),
    legend: dados ? exploracoesLegenda(contagens[modo.id] ?? [], dados[modo.rotulos] ?? [], modo.cores) : [],
  }),
  onChip(chipId, ctx) {
    const novo = EXPLORACOES_MODOS.find((m) => `modo-${m.id}` === chipId);
    if (!novo || novo === modo) return;
    modo = novo;
    // As chaves mudam com o modo: zera os ocultos (o anfitrião chama onLegend).
    ctx.setLegendHidden('datageo-adapar-exploracoes', []);
  },
  onLegend(ocultos, { map }) {
    if (!map.getLayer(PT)) return;
    for (const [k, v] of Object.entries(pintura(modo))) map.setPaintProperty(PT, k, v);
    map.setFilter(PT, ocultos.size ? ['!', ['in', ['to-string', ['get', modo.prop]], ['literal', [...ocultos]]]] : null);
  },
});

// -------------------------------------------------------- estabelecimentos

const estabelecimentos = (def) => makePointsLayer({
  category: DEFESA_AGROPECUARIA, source: 'ADAPAR', labelDists: [ADAPAR_LABEL_DIST], ...def,
});

export const veterinariosLayer = estabelecimentos({
  id: 'datageo-adapar-veterinarios',
  name: 'Comércio de produtos veterinários',
  icon: '💉',
  url: '/privado/adapar-veterinarios-pr.geojson',
  estilo: veterinarioEstilo,
  tooltip: veterinarioTooltip,
  legend: VETERINARIOS_LEGENDA,
  stroke: ADAPAR_CONTORNO.veterinarios,
});

export const animaisVivosLayer = estabelecimentos({
  id: 'datageo-adapar-animais-vivos',
  name: 'Comércio de animais vivos',
  icon: '🐥',
  url: '/privado/adapar-animais-vivos-pr.geojson',
  estilo: animaisVivosEstilo,
  tooltip: animaisVivosTooltip,
  legend: ANIMAIS_LEGENDA,
  stroke: ADAPAR_CONTORNO.animais,
});

export const agrotoxicosLayer = estabelecimentos({
  id: 'datageo-adapar-agrotoxicos',
  name: 'Comércio de agrotóxicos',
  icon: '🧪',
  url: '/privado/adapar-agrotoxicos-pr.geojson',
  estilo: agrotoxicoEstilo,
  tooltip: agrotoxicoTooltip,
  legend: AGROTOXICOS_LEGENDA,
  stroke: ADAPAR_CONTORNO.agrotoxicos,
});

export const fertilizantesLayer = estabelecimentos({
  id: 'datageo-adapar-fertilizantes',
  name: 'Comércio de fertilizantes',
  icon: '🌿',
  url: '/privado/adapar-fertilizantes-pr.geojson',
  estilo: fertilizanteEstilo,
  tooltip: fertilizanteTooltip,
  legend: FERTILIZANTES_LEGENDA,
  stroke: ADAPAR_CONTORNO.fertilizantes,
});

export const consolidacaoLayer = estabelecimentos({
  id: 'datageo-adapar-unidades-consolidacao',
  name: 'Unidades de Consolidação (UC)',
  icon: '📦',
  url: '/privado/adapar-unidades-consolidacao-pr.geojson',
  estilo: consolidacaoEstilo,
  tooltip: consolidacaoTooltip,
  legend: CONSOLIDACAO_LEGENDA,
  stroke: ADAPAR_CONTORNO.consolidacao,
});

export const industriasLayer = estabelecimentos({
  id: 'datageo-adapar-industrias-poa',
  name: 'Indústrias de produtos de origem animal',
  icon: '🥩',
  url: '/privado/adapar-industrias-poa-pr.geojson',
  estilo: industriaEstilo,
  tooltip: industriaTooltip,
  legend: INDUSTRIAS_LEGENDA,
  stroke: ADAPAR_CONTORNO.industrias,
});

// ---------------------------------------------------------------- unidades

export const unidadesAdaparLayer = makePointsLayer({
  id: 'datageo-adapar-unidades',
  name: 'Unidades da ADAPAR (escritórios)',
  category: DEFESA_AGROPECUARIA,
  icon: '🏢',
  source: 'ADAPAR',
  url: '/data/adapar-unidades-pr.geojson',
  estilo: unidadeAdaparEstilo,
  tooltip: unidadeAdaparTooltip,
  legend: UNIDADES_LEGENDA,
  labelDists: [1_200_000, ADAPAR_LABEL_DIST * 4],
  stroke: { color: '#7c2d12', width: 1.5 },
});

// Escritórios primeiro no painel: é a rede da ADAPAR; os cadastros vêm depois.
export default [
  unidadesAdaparLayer, exploracoesLayer, veterinariosLayer, animaisVivosLayer, agrotoxicosLayer, fertilizantesLayer,
  consolidacaoLayer, industriasLayer,
];
