// src/maplibre/layers/manejo.js
//
// Monitoramento fitossanitário do Manejo.App (grupo IDR-Paraná): talhões,
// coletores de esporos, armadilhas, pulverizações e pluviômetros.
// Bucket privado (produtor + coordenada exata), gravado pela Edge Function
// etl-manejo do c2. Cinza = sem ocorrência; cor = o que pede atenção.

import { temEsporo } from '../../data/coletoresEsporos.js';
import { dgFetchData } from '../../data/datageoClient.js';
import { EMPTY_FC, defineLayer, fmtInt, fmtNum, tipCard } from '../kit.js';
import { makePointsLayer } from './energiaLogistica.js';

const CATEGORIA = 'IDR-Paraná';
const FONTE = 'Manejo.App · IDR-Paraná';
const NEUTRO = '#94a3b8';
const SEM_ROTULO = [60_000];

const legenda = (cor, comOcorrencia, semOcorrencia) => [
  { grupo: 'com', label: comOcorrencia, color: cor },
  { grupo: 'sem', label: semOcorrencia, color: NEUTRO },
];
const estilo = (cor, tem) => (p) => {
  const grupo = tem(p) ? 'com' : 'sem';
  return { grupo, size: grupo === 'com' ? 8 : 6, color: grupo === 'com' ? cor : NEUTRO, alpha: 0.95 };
};
const cabecalho = (p, icon) => ({
  icon,
  title: p.produtor,
  subtitle: [p.municipio, p.hierarquia, p.safra ?? p.safras].filter(Boolean).join(' · '),
  source: FONTE,
  wide: true,
});
const pessoa = (p) => [['Cultura', p.cultura ?? p.culturas], ['Cultivar', p.cultivar], ['Responsável técnico', p.responsavel_tecnico]];

const TALHOES = { cor: '#f97316', tem: (p) => Number(p.total_ferrugem) > 0 };
const COLETORES = { cor: '#ef4444', tem: temEsporo };
const ARMADILHAS = { cor: '#a855f7', tem: (p) => Number(p.individuos) > 0 };
const PULVERIZACOES = { cor: '#14b8a6', tem: (p) => Number(p.aplicacoes) > 0 };
const PLUVIOMETROS = { cor: '#38bdf8', tem: (p) => Number(p.leituras) > 0 };

export const talhaoTooltip = (p) => tipCard({
  ...cabecalho(p, '🌱'),
  rows: [
    ...pessoa(p),
    ['Área', fmtNum(p.area, 1, 'ha')],
    ['Emergência', p.data_emergencia],
    ['Monitoramento encerrado', p.monitoramento_encerrado],
    ['Ferrugem', fmtInt(p.total_ferrugem)],
    ['Oídio', fmtInt(p.total_oidio)],
    ['Lagartas', fmtInt(p.total_lagartas)],
    ['Percevejos', fmtInt(p.total_percevejos)],
    ['Aplicações', fmtInt(p.total_aplicacoes)],
    ['Produtividade', fmtNum(p.produtividade, 1)],
  ],
});

export const coletorTooltip = (p) => tipCard({
  ...cabecalho(p, '🍄'),
  badge: p.primeiro_esporo ? { text: 'Esporo detectado', tone: 'warn' } : null,
  rows: [...pessoa(p), ['Situação', p.situacao], ['Estádio', p.estadio_fenologico], ['Instalação', p.data_instalacao], ['Primeiro esporo', p.primeiro_esporo]],
});

export const armadilhaTooltip = (p) => tipCard({
  ...cabecalho(p, '🪤'),
  rows: [...pessoa(p), ['Coletas', fmtInt(p.coletas)], ['Indivíduos', fmtInt(p.individuos)], ['Última coleta', p.ultima_coleta], ['Instalação', p.data_instalacao]],
  sections: [{ title: 'Por praga', rows: (p.pragas ?? []).map((g) => [g.praga, fmtInt(g.individuos)]) }],
});

export const pulverizacaoTooltip = (p) => tipCard({
  ...cabecalho(p, '💧'),
  rows: [...pessoa(p), ['Aplicações', fmtInt(p.aplicacoes)], ['Última aplicação', p.ultima_aplicacao]],
  sections: [{
    title: 'Registros recentes',
    rows: (p.registros ?? []).map((r) => [r.data_aplicacao, [r.produto_comercial, r.alvo].filter(Boolean).join(' · ')]),
  }],
});

export const pluviometroTooltip = (p) => tipCard({
  ...cabecalho(p, '🌧️'),
  rows: [
    ...pessoa(p),
    ['Leituras', fmtInt(p.leituras)],
    ['Chuva acumulada', fmtNum(p.chuva_total_mm, 1, 'mm')],
    ['Acumulado no mês', fmtNum(p.acumulado_mensal_mm, 1, 'mm')],
    ['Dias sem chuva', fmtInt(p.dias_sem_chuva)],
    ['Última leitura', p.ultima_leitura],
  ],
});

const camada = (slug, name, icon, { cor, tem }, rotulos, tooltip) => makePointsLayer({
  id: `datageo-manejo-${slug}`,
  name,
  category: CATEGORIA,
  icon,
  source: FONTE,
  url: `/privado/manejo-${slug}.geojson`,
  estilo: estilo(cor, tem),
  legend: legenda(cor, ...rotulos),
  labelDists: SEM_ROTULO,
  tooltip,
});

export const LIMITES = Object.freeze([
  { key: 'propriedade', label: 'Propriedade', color: '#fde68a' },
  { key: 'talhao', label: 'Talhão', color: '#f97316' },
]);
const LIMITES_SRC = 'dg-manejo-limites';
const COR_LIMITE = ['match', ['get', 'tipo'], ...LIMITES.flatMap((l) => [l.key, l.color]), NEUTRO];
const EM_HOVER = ['boolean', ['feature-state', 'hover'], false];
let contagemLimites = {};

export const limiteTooltip = (p) => tipCard({
  ...cabecalho(p, p.tipo === 'talhao' ? '🌾' : '🏡'),
  rows: [['Limite', LIMITES.find((l) => l.key === p.tipo)?.label], ...pessoa(p)],
});

const limitesLayer = defineLayer({
  id: 'datageo-manejo-limites',
  name: 'Manejo: limites de talhão e propriedade',
  category: CATEGORIA,
  icon: '🗺️',
  source: FONTE,
  sources: { [LIMITES_SRC]: { type: 'geojson', data: EMPTY_FC, generateId: true } },
  layers: [
    { id: `${LIMITES_SRC}-fill`, type: 'fill', source: LIMITES_SRC,
      paint: { 'fill-color': COR_LIMITE, 'fill-opacity': ['case', EM_HOVER, 0.45, ['==', ['get', 'tipo'], 'talhao'], 0.25, 0.05] } },
    { id: `${LIMITES_SRC}-line`, type: 'line', source: LIMITES_SRC,
      paint: { 'line-color': ['case', EM_HOVER, '#fde047', COR_LIMITE], 'line-width': ['case', EM_HOVER, 3, 1.5] } },
  ],
  interactive: [`${LIMITES_SRC}-fill`],
  hoverState: LIMITES_SRC,
  async load(ctx) {
    const resp = await dgFetchData('/privado/manejo-limites.geojson');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const gj = await resp.json();
    contagemLimites = Object.fromEntries(LIMITES.map((l) => [l.key, gj.features.filter((f) => f.properties.tipo === l.key).length]));
    ctx.setData(LIMITES_SRC, gj);
    return gj.features.length;
  },
  tooltip: (p) => limiteTooltip(p),
  rowControls: () => ({ legend: LIMITES.map((l) => ({ ...l, count: contagemLimites[l.key] ?? '' })) }),
});

export default [
  limitesLayer,
  camada('talhoes', 'Manejo: talhões monitorados', '🌱', TALHOES, ['Com ferrugem', 'Sem ferrugem'], talhaoTooltip),
  camada('coletores', 'Manejo: coletores de esporos', '🍄', COLETORES, ['Esporo detectado', 'Sem esporo'], coletorTooltip),
  camada('armadilhas', 'Manejo: armadilhas', '🪤', ARMADILHAS, ['Com indivíduos', 'Sem indivíduos'], armadilhaTooltip),
  camada('pulverizacoes', 'Manejo: pulverizações', '💧', PULVERIZACOES, ['Com aplicação', 'Sem aplicação'], pulverizacaoTooltip),
  camada('pluviometros', 'Manejo: pluviômetros', '🌧️', PLUVIOMETROS, ['Com leitura', 'Sem leitura'], pluviometroTooltip),
];
