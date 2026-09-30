// src/data/equipamentosSuasEstilos.js
//
// Estilo e tooltip dos equipamentos da assistência social (CRAS, CREAS,
// Centro POP, postos do CadÚnico) e da segurança alimentar (restaurantes
// populares, cozinhas comunitárias, bancos de alimentos) do Mapa Social do
// MDS (scripts/build_equipamentos_suas.py). Mesmo contrato de
// energiaLogisticaEstilos.js: `estilo(props)` -> {grupo, size, color, ...}.

import { tipCard } from '../maplibre/tooltipCard.js';

const TIPOS = Object.freeze({
  cras: { curto: 'CRAS', nome: 'Centro de Referência de Assistência Social', legenda: 'grupo' },
  creas: { curto: 'CREAS', nome: 'Centro de Referência Especializado de Assistência Social', legenda: 'grupo' },
  pop: { curto: 'Centro POP', nome: 'Centro de Referência para População em Situação de Rua', legenda: 'grupo' },
  cadunico: { curto: 'Posto CadÚnico', nome: 'Posto de cadastramento do Cadastro Único', legenda: 'grupo' },
  restaurante: { curto: 'Restaurante popular', nome: 'Restaurante popular', legenda: 'san' },
  cozinha: { curto: 'Cozinha comunitária', nome: 'Cozinha comunitária', legenda: 'san' },
  banco: { curto: 'Banco de alimentos', nome: 'Banco de alimentos', legenda: 'san' },
});

export const SUAS_LEGENDA = Object.freeze([
  { grupo: 'cras', label: 'CRAS', color: '#f472b6' },
  { grupo: 'creas', label: 'CREAS', color: '#c084fc' },
  { grupo: 'pop', label: 'Centro POP', color: '#fb923c' },
  { grupo: 'cadunico', label: 'Posto do CadÚnico', color: '#94a3b8' },
  { grupo: 'san', label: 'Segurança alimentar', color: '#fbbf24' },
]);
const COR = Object.fromEntries(SUAS_LEGENDA.map((g) => [g.grupo, g.color]));

export function equipamentoSuasEstilo(p) {
  const t = TIPOS[p.grupo];
  if (!t) return null;
  const grupo = t.legenda === 'san' ? 'san' : p.grupo;
  return {
    grupo,
    size: grupo === 'cras' || grupo === 'cadunico' ? 7 : 9,
    color: COR[grupo],
    alpha: 1,
    label: `${t.curto} ${p.municipio ?? ''}`.trim(),
    labelMaxDist: 40_000,
  };
}

/** Nome da API só diz algo além do tipo? ("CRAS - Centro de Referência..." não diz.) */
function nomeProprio(nome, t) {
  const resto = String(nome ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/CENTRO DE REFERENCIA( ESPECIALIZADO)? D[AE] ASSISTENCIA SOCIAL/g, '')
    .replace(t.curto.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), '')
    .replace(/[\s\-/()]+/g, '');
  return resto ? nome : '';
}

export function equipamentoSuasTooltipHtml(p) {
  const t = TIPOS[p.grupo];
  if (!t) return '';
  const local = [p.endereco, p.bairro].filter(Boolean).join(' · ');
  const parado = p.situacao && !/FUNCIONAMENTO/i.test(p.situacao);
  return tipCard({
    icon: t.legenda === 'san' ? '🍲' : '🤝',
    title: `${t.curto} ${p.municipio ?? ''}`.trim(),
    subtitle: t.nome,
    badge: parado ? { text: p.situacao.toLowerCase(), tone: 'warn' } : null,
    rows: [
      ['Nome', nomeProprio(p.nome, t)],
      ['Endereço', local],
      ['Município', p.municipio ? `${p.municipio} - PR` : ''],
    ],
    source: 'MDS · Mapa Social (SAGI)',
  });
}
