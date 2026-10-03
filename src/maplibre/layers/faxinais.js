// src/maplibre/layers/faxinais.js
//
// Inventário dos faxinais do Paraná (IAT/ZEE-PR, 2010, a partir do mapeamento
// social da Rede Puxirão): um ponto por comunidade, cor pela situação do uso
// comum. Os perímetros (territórios do CAR e ARESUR) são a camada de polígonos
// em territorios.js.
// Dado público: public/data/faxinais-pr.geojson (scripts/build_faxinais.py).

import { COR_FAXINAL } from '../../data/territoriosSpec.js';
import { tipCard } from '../kit.js';
import { makePointsLayer } from './energiaLogistica.js';

// Campo `situacao`: o serviço não traz domínio. É a classificação do
// Mapeamento Situacional dos Faxinais (Meira, Vandresen e Souza, em Almeida e
// Souza (orgs.), Terras de Faxinais, UEA, 2009, p. 120), que a camada reproduz
// (227 faxinais; os de Irati conferidos um a um). Onde o livro dá dois códigos
// ("3 e 4"), a camada guarda o primeiro. Do mais ao menos comunal: cor do
// claro (criador aberto) ao escuro (sem uso comum).
export const SITUACAO_FAXINAL = Object.freeze({
  1: { label: 'Uso comum · criador aberto', color: '#fef08a' },
  2: { label: 'Uso comum · criador cercado', color: COR_FAXINAL },
  3: { label: 'Uso comum restrito · criação grossa', color: '#f59e0b' },
  4: { label: 'Sem uso comum · mangueirões e potreiros', color: '#a16207' },
});

const SEM_SITUACAO = '#94a3b8';

export function faxinalPontoEstilo(p) {
  const s = SITUACAO_FAXINAL[p.situacao];
  return {
    grupo: s ? p.situacao : 'sem',
    // ARESUR (reconhecido em decreto) um pouco maior.
    size: p.tipo === 'ARESUR' ? 10 : 8,
    color: s?.color ?? SEM_SITUACAO,
    alpha: 0.95,
    label: p.nome,
    labelMaxDist: 90_000,
  };
}

export const FAXINAL_LEGENDA = Object.freeze([
  ...Object.entries(SITUACAO_FAXINAL).map(([grupo, s]) => ({ grupo, label: s.label, color: s.color })),
  { grupo: 'sem', label: 'Sem situação', color: SEM_SITUACAO },
]);

const TIPO_TXT = { Faxinal: 'Faxinal', ARESUR: 'Faxinal ARESUR (Decreto 3.446/1997)' };

export function faxinalPontoTooltip(p) {
  return tipCard({
    icon: '🌳',
    title: p.nome,
    subtitle: `Faxinal · ${p.municipio}`,
    badge: p.tipo === 'ARESUR' ? { text: 'ARESUR', tone: 'ok' } : null,
    rows: [
      // 36 pontos vêm com o tipo em branco no serviço: a linha some.
      ['Tipo', TIPO_TXT[p.tipo] ?? ''],
      ['Situação (2009)', SITUACAO_FAXINAL[p.situacao]?.label ?? ''],
      ['Nº no levantamento', p.nro],
    ],
    source: 'IAT/GeoPR · ZEE-PR (2010) · situação: Meira, Vandresen e Souza (2009)',
  });
}

export const faxinaisLayer = makePointsLayer({
  id: 'datageo-faxinais',
  name: 'Faxinais · inventário 2010 (IAT)',
  category: 'Territórios e povos',
  icon: '🌳',
  source: 'IAT/GeoPR · ZEE-PR',
  url: '/data/faxinais-pr.geojson',
  estilo: faxinalPontoEstilo,
  tooltip: faxinalPontoTooltip,
  legend: FAXINAL_LEGENDA,
  labelDists: [90_000],
});

export default [faxinaisLayer];
