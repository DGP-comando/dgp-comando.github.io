// src/maplibre/layers/cnpjAgro.js
//
// CNPJs ligados ao agro no PR (Receita Federal, jul/2026): 35 mil
// estabelecimentos ativos com CNAE agro (lavouras, pecuária, apoio, florestal,
// pesca, crédito rural) como atividade principal ou secundária, geocodificados
// (rua, CEP ou centro do município). Arquivo do bucket privado
// (scripts/build_cnpj_agro.py), gzipado; tooltip com todos os campos da
// Receita, CPF de MEI na razão social inclusive (autorizado: plataforma com
// login e termo). Ponto VAZADO = posição aproximada (CEP ou município);
// pontos empilhados no mesmo lugar vêm espalhados em espiral pelo build.

import { dgFetchData } from '../../data/datageoClient.js';
import { EMPTY_FC, defineLayer, fc, fmtInt, fmtNum, tipCard } from '../kit.js';
import { gunzipJson } from './defesaAgropecuaria.js';

const SRC = 'dg-cnpj-agro';
const PT = `${SRC}-pt`;
const CORES = ['#84cc16', '#f97316', '#38bdf8', '#15803d', '#06b6d4', '#a78bfa', '#94a3b8'];
const PRECISAO = { rua: 'endereço (rua)', cep: 'CEP (aproximada)', municipio: 'centro do município (aproximada)' };

let dados = null;
let legenda = [];

/** Features (id = índice em `p`) e contagem por classe. */
export function cnpjFeatures(d) {
  const counts = new Array(d?.classes?.length ?? 0).fill(0);
  const features = (d?.p ?? []).map((r, id) => {
    counts[r.c] = (counts[r.c] ?? 0) + 1;
    return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [r.x, r.y] }, properties: { c: r.c, aprox: r.prec > 0 ? 1 : 0 } };
  });
  return { features, counts };
}

export const fmtCnpj = (c) => (String(c).length === 14 ? String(c).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : String(c ?? ''));
const cnaeTxt = (cod, cnaes) => `${cod} ${cnaes?.[cod] ?? ''}`.trim();
const simNao = (v, desde, ate) => (v == null ? '' : v ? `Sim${desde ? `, desde ${desde}` : ''}` : `Não${ate ? ` (excluído em ${ate})` : ''}`);
const brl = (v) => (v == null ? '' : `R$ ${fmtNum(v, 2)}`);

export function cnpjTooltip(r, d) {
  if (!r) return '';
  const sec = r.sec ?? [];
  const MAX_SEC = 12;
  return tipCard({
    icon: '🏢',
    title: r.fantasia || r.razao || fmtCnpj(r.cnpj),
    subtitle: `${fmtCnpj(r.cnpj)} · ${r.mf}`,
    badge: { text: d?.classes?.[r.c] ?? '', tone: 'info' },
    wide: true,
    rows: [
      ['Razão social', r.razao],
      ['Situação', [r.situacao, r.dtSituacao ? `desde ${r.dtSituacao}` : '', r.motivo].filter(Boolean).join(' · '), r.situacao === 'Ativa' ? null : 'warn'],
      ['Situação especial', [r.sitEspecial, r.dtSitEspecial].filter(Boolean).join(' · ')],
      ['Início da atividade', r.inicio],
      ['CNAE principal', cnaeTxt(r.cnae, d?.cnaes)],
      ['Natureza jurídica', r.natureza],
      ['Porte', r.porte],
      ['Capital social', brl(r.capital)],
      ['Optante do Simples', simNao(r.simples, r.dtSimples, r.dtSimplesExcl)],
      ['MEI', simNao(r.mei, r.dtMei, r.dtMeiExcl)],
      ['Qualificação do responsável', r.qualResp],
      ['Ente federativo', r.enteFed],
    ],
    sections: [
      { title: 'Endereço e contato', rows: [
        ['Endereço', r.end],
        ['Complemento', r.compl],
        ['Bairro', r.bairro],
        ['Município · CEP', [r.mun, r.cep].filter(Boolean).join(' · ')],
        ['Telefone', (r.tel ?? []).join(' · ')],
        ['Fax', r.fax],
        ['E-mail', r.email],
        ['Posição no mapa', `${PRECISAO[d?.precisao?.[r.prec]] ?? ''}${r.esp ? ' · espalhado (vários no mesmo ponto)' : ''}`, r.prec > 0 ? 'warn' : null],
      ] },
      ...(sec.length ? [{
        title: `CNAEs secundários (${fmtInt(sec.length)})`,
        rows: sec.slice(0, MAX_SEC).map((c) => [c, d?.cnaes?.[c] ?? ''])
          .concat(sec.length > MAX_SEC ? [['…', `mais ${fmtInt(sec.length - MAX_SEC)}`]] : []),
      }] : []),
    ],
    source: d?.fonte ?? 'Receita Federal · CNPJ',
  });
}

export const cnpjAgroLayer = defineLayer({
  id: 'datageo-cnpj-agro',
  name: 'Empresas do agro (CNPJ)',
  category: 'Logística agro',
  icon: '🏢',
  source: 'Receita Federal · CNPJ (jul/2026)',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [{
    id: PT,
    type: 'circle',
    source: SRC,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 10, 3.5, 14, 6.5],
      'circle-color': ['case', ['==', ['get', 'aprox'], 1], 'rgba(0,0,0,0)',
        ['match', ['get', 'c'], ...CORES.flatMap((cor, i) => [i, cor]), '#94a3b8']],
      'circle-stroke-color': ['case', ['==', ['get', 'aprox'], 1],
        ['match', ['get', 'c'], ...CORES.flatMap((cor, i) => [i, cor]), '#94a3b8'], 'rgba(0,0,0,0.55)'],
      'circle-stroke-width': ['case', ['==', ['get', 'aprox'], 1], 1.3, 0.5],
      'circle-opacity': 0.9,
    },
  }],
  interactive: [PT],
  legendFilter: 'c',
  async load(ctx) {
    const resp = await dgFetchData('/privado/cnpj-agro-pr.json.gz');
    if (!resp.ok) throw new Error(resp.status < 500 ? 'acesso restrito: entre com usuário liberado' : `HTTP ${resp.status}`);
    dados = await gunzipJson(resp);
    const { features, counts } = cnpjFeatures(dados);
    legenda = counts.map((count, i) => ({ key: i, label: dados.classes[i], color: CORES[i], count }));
    ctx.setData(SRC, fc(features));
    const aprox = dados.p.filter((r) => r.prec > 0).length;
    return { count: features.length, info: `${fmtInt(aprox)} com posição aproximada (CEP ou centro do município), vazados` };
  },
  tooltip: (_p, feature) => cnpjTooltip(dados?.p?.[feature?.id], dados),
  rowControls: () => ({ legend: legenda }),
});

export default [cnpjAgroLayer];
