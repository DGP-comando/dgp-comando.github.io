// src/maplibre/layers/cnesSaude.js
//
// Estabelecimentos de saúde do PR (CNES/DATASUS): 32 mil ativos com
// coordenada, por família de tipo (UBS, hospitais, pronto atendimento, CAPS,
// clínicas, diagnóstico, farmácias, gestão, outros). Arquivo do bucket privado
// (scripts/build_cnes_saude.py), gzipado; tooltip com todos os campos do
// cadastro e os leitos da CGHID/MS. Consultório isolado de pessoa física traz
// nome e contato (autorizado: plataforma com login e termo).

import { dgFetchData } from '../../data/datageoClient.js';
import { EMPTY_FC, defineLayer, fc, fmtInt, tipCard } from '../kit.js';
import { gunzipJson } from './defesaAgropecuaria.js';

const SRC = 'dg-cnes-saude';
const PT = `${SRC}-pt`;
const CORES = ['#22c55e', '#ef4444', '#f97316', '#a78bfa', '#38bdf8', '#06b6d4', '#facc15', '#f472b6', '#94a3b8'];
// Hospital e pronto atendimento maiores: são os que importam de longe.
const RAIO = [1, 1.8, 1.6, 1.2, 0.8, 0.9, 0.8, 1, 0.8];

let dados = null;
let legenda = [];

/** Features (id = índice em `p`) e contagem por classe. */
export function cnesFeatures(d) {
  const counts = new Array(d?.classes?.length ?? 0).fill(0);
  const features = (d?.p ?? []).map((r, id) => {
    counts[r.c] = (counts[r.c] ?? 0) + 1;
    return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [r.x, r.y] }, properties: { c: r.c } };
  });
  return { features, counts };
}

const leitosTxt = (l) => (l ? `${fmtInt(l[0])} (${fmtInt(l[1])} SUS)` : '');
const utiTxt = (l) => (l?.[2] ? `${fmtInt(l[2])} (${fmtInt(l[3])} SUS)` : '');

export function cnesTooltip(r, d) {
  if (!r) return '';
  return tipCard({
    icon: '🏥',
    title: r.fantasia || r.razao || `CNES ${r.cnes}`,
    subtitle: `CNES ${r.cnes} · ${r.tipo}`,
    badge: { text: d?.classes?.[r.c] ?? '', tone: 'info' },
    wide: true,
    rows: [
      ['Razão social', r.razao],
      ['Atende SUS', r.sus ? 'Sim' : 'Não', r.sus ? null : 'warn'],
      ['Leitos', leitosTxt(r.leitos)],
      ['Leitos de UTI', utiTxt(r.leitos)],
      ['Serviços', (r.servicos ?? []).join(', ')],
      ['Turno de atendimento', r.turno],
      ['Atividade de ensino', r.ensino],
      ['Esfera administrativa', r.esfera],
      ['Gestão', r.gestao],
      ['Natureza jurídica', r.natureza],
      ['CNPJ', r.cnpj],
      ['CNPJ da mantenedora', r.mantenedora],
    ],
    sections: [{ title: 'Endereço e contato', rows: [
      ['Endereço', r.end],
      ['Bairro', r.bairro],
      ['Município · CEP', [r.mun, r.cep].filter(Boolean).join(' · ')],
      ['Região de saúde', r.rs],
      ['Telefone', r.tel],
      ['E-mail', r.email],
      ['Posição no mapa', r.esp ? 'espalhado (vários no mesmo ponto)' : ''],
    ] }],
    source: d?.fonte ?? 'CNES/DATASUS',
  });
}

export const cnesSaudeLayer = defineLayer({
  id: 'datageo-cnes-saude',
  name: 'Estabelecimentos de saúde (CNES)',
  category: 'Saúde e proteção social',
  icon: '🏥',
  source: 'CNES/DATASUS',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [{
    id: PT,
    type: 'circle',
    source: SRC,
    paint: {
      // zoom só pode ficar no interpolate de fora; o fator por classe vai em cada parada.
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        ...[[6, 1.8], [10, 3.5], [14, 6.5]].flatMap(([z, r]) => [z, ['*', r, ['match', ['get', 'c'], ...RAIO.flatMap((k, i) => [i, k]), 1]]])],
      'circle-color': ['match', ['get', 'c'], ...CORES.flatMap((cor, i) => [i, cor]), '#94a3b8'],
      'circle-stroke-color': 'rgba(0,0,0,0.55)',
      'circle-stroke-width': 0.5,
      'circle-opacity': 0.9,
    },
  }],
  interactive: [PT],
  legendFilter: 'c',
  async load(ctx) {
    const resp = await dgFetchData('/privado/cnes-saude-pr.json.gz');
    if (!resp.ok) throw new Error(resp.status < 500 ? 'acesso restrito: entre com usuário liberado' : `HTTP ${resp.status}`);
    dados = await gunzipJson(resp);
    const { features, counts } = cnesFeatures(dados);
    legenda = counts.map((count, i) => ({ key: i, label: dados.classes[i], color: CORES[i], count }));
    ctx.setData(SRC, fc(features));
    return { count: features.length };
  },
  tooltip: (_p, feature) => cnesTooltip(dados?.p?.[feature?.id], dados),
  rowControls: () => ({ legend: legenda }),
});

export default [cnesSaudeLayer];
