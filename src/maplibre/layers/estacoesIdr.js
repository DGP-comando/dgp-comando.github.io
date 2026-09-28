// src/maplibre/layers/estacoesIdr.js
//
// Estações de pesquisa (polígonos dos KML), polos de pesquisa e unidades
// florestais (ponto na sede do município) do IDR-Paraná. O tooltip lista os
// servidores lotados na unidade (servidores-idr.json, chave `unidade`).
// Os dois arquivos saem do bucket privado (scripts/build_estacoes_idr.py e a
// Edge Function datageo-servidores do c2).

import { loadServidoresIdr, servidoresDasUnidades } from '../../data/servidoresIdr.js';
import { dgFetchData } from '../../data/datageoClient.js';
import { EMPTY_FC, LABEL_PAINT, TEXT_FONT, defineLayer, tipCard, zoomForHeight } from '../kit.js';
import { makePointsLayer } from './energiaLogistica.js';

const URL = '/privado/estacoes-idr-pr.geojson';
const COR = '#facc15';
const SRC = 'dg-estacoes-idr';
const FILL = 'dg-estacoes-idr-fill';
const PT = 'dg-estacoes-idr-pt';
const MAX_NOMES = 25;

const TIPO = { estacao: 'Estação de pesquisa', polo: 'Polo de pesquisa', 'unidade-florestal': 'Unidade florestal' };

let servidores = null; // payload de servidores-idr.json; null = indisponível

/** HTML do tooltip de uma estação/polo/unidade (exportado para o teste). */
export function estacaoTooltipHtml(p, dados) {
  const lista = dados ? servidoresDasUnidades(dados, p.unidade) : null;
  const tipos = String(p.tipo ?? '').split(',').map((t) => TIPO[t] ?? t).filter(Boolean);
  const nomes = (lista ?? []).slice(0, MAX_NOMES)
    .map((s) => [s.nome, s.formacao || 'formação não informada']);
  const resto = (lista?.length ?? 0) - nomes.length;
  const semUnidade = !p.unidade;
  const fmtHa = (v) => (Number(v) > 0 ? `${Number(v).toLocaleString('pt-BR')} ha` : '');
  return tipCard({
    icon: p.tipo === 'unidade-florestal' ? '🌲' : '🔬',
    title: p.nome,
    subtitle: `IDR-Paraná · ${p.unidade_nome || tipos.join(' · ')} · ${p.municipio}`,
    badge: lista && !semUnidade ? { text: `${lista.length} servidor${lista.length === 1 ? '' : 'es'}`, tone: 'info' } : null,
    rows: [['Uso', p.uso], ['Contrato', p.contrato], ['Área', fmtHa(p.area_ha)]],
    sections: nomes.length ? [{ title: 'Servidores (SisPont)', rows: nomes }] : [],
    note: [
      !lista ? 'Lista de servidores indisponível no momento.' : '',
      semUnidade ? 'Sem unidade florestal do SisPont neste município: servidores não vinculados.' : '',
      lista && !semUnidade && !lista.length ? 'Nenhum servidor lotado nesta unidade no SisPont.' : '',
      resto > 0 ? `+ ${resto} servidores.` : '',
      p.aproximado ? 'Localização aproximada: sede do município.' : '',
    ].filter(Boolean).join(' '),
    source: 'IDR-Paraná · SisPont + Portal da Transparência PR',
    wide: true,
  });
}

export const estacoesIdrLayer = defineLayer({
  id: 'datageo-estacoes-idr',
  name: 'Estações e polos de pesquisa (IDR)',
  category: 'Limites',
  icon: '🔬',
  source: 'IDR-Paraná',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: FILL,
      type: 'fill',
      source: SRC,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'fill-color': COR, 'fill-opacity': 0.35 },
    },
    {
      id: 'dg-estacoes-idr-line',
      type: 'line',
      source: SRC,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'line-color': COR, 'line-width': 1.6 },
    },
    {
      id: PT,
      type: 'circle',
      source: SRC,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': COR,
        'circle-radius': 6,
        'circle-stroke-color': 'rgba(0,0,0,0.6)',
        'circle-stroke-width': 1,
      },
    },
    {
      // Estações são pequenas (poucos km²): rótulo só de perto.
      id: 'dg-estacoes-idr-label',
      type: 'symbol',
      source: SRC,
      minzoom: zoomForHeight(250_000),
      layout: {
        'text-field': ['get', 'nome'],
        'text-font': TEXT_FONT,
        'text-size': 11,
        'text-max-width': 14,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
      },
      paint: { ...LABEL_PAINT, 'text-color': COR },
    },
  ],
  interactive: [FILL, PT],
  async load(ctx) {
    const [gj, dados] = await Promise.all([
      dgFetchData(URL).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      loadServidoresIdr().catch((err) => {
        console.warn('[DataGeo] servidores IDR indisponíveis:', err?.message);
        return null;
      }),
    ]);
    servidores = dados;
    ctx.setData(SRC, gj);
    return gj.features?.length ?? 0;
  },
  tooltip: (p) => estacaoTooltipHtml(p, servidores),
});

// ------------------------------------------------ unidades (endereços)
//
// 447 unidades (UMEs, regionais, estações, polos, sede) com endereço do site
// do IDR (scripts/build_unidades_idr.py). Ponto que não fechava com o
// município foi para a sede municipal e vem marcado `aproximado`.

export const UNIDADE_LEGENDA = Object.freeze([
  { grupo: 'ume', label: 'Unidade municipal', color: '#38bdf8' },
  { grupo: 'regional', label: 'Unidade regional', color: '#f97316' },
  { grupo: 'pesquisa', label: 'Estação / polo de pesquisa', color: COR },
  { grupo: 'sede', label: 'Sede', color: '#f43f5e' },
]);
const UNIDADE_COR = Object.fromEntries(UNIDADE_LEGENDA.map((g) => [g.grupo, g.color]));
const UNIDADE_ROTULO = { ume: 'Unidade municipal de extensão', regional: 'Unidade regional de extensão',
  estacao: 'Estação de pesquisa', polo: 'Polo de pesquisa', sede: 'Sede' };

export function unidadeEstilo(p) {
  const grupo = p.tipo === 'estacao' || p.tipo === 'polo' ? 'pesquisa' : p.tipo;
  if (!UNIDADE_COR[grupo]) return null;
  const grande = grupo !== 'ume';
  return { grupo, size: grande ? 9 : 6, color: UNIDADE_COR[grupo], alpha: 0.95,
    label: String(p.nome ?? '').split(' · ').pop(), labelMaxDist: grande ? 400_000 : 60_000 };
}

export function unidadeTooltipHtml(p) {
  return tipCard({
    icon: '🏢',
    title: p.nome,
    subtitle: `IDR-Paraná · ${UNIDADE_ROTULO[p.tipo] ?? p.tipo}${p.regional ? ` · Regional ${p.regional}` : ''}`,
    rows: [['Endereço', p.endereco], ['Telefone', p.telefone], ['E-mail', p.email]],
    note: [
      p.aproximado ? 'Localização aproximada (sede do município): o ponto da base não fechava com o endereço.' : '',
      p.no_site === false ? 'Não consta em "Endereços e Contatos" do site do IDR.' : '',
    ].filter(Boolean).join(' '),
    source: 'IDR-Paraná · Endereços e Contatos (28/09/2026)',
  });
}

export const unidadesIdrLayer = makePointsLayer({
  id: 'datageo-unidades-idr',
  name: 'Unidades do IDR (endereços)',
  category: 'Limites',
  icon: '🏢',
  source: 'IDR-Paraná',
  url: '/privado/unidades-idr-pr.geojson',
  estilo: unidadeEstilo,
  tooltip: unidadeTooltipHtml,
  legend: UNIDADE_LEGENDA,
  labelDists: [400_000, 60_000],
});

export default [estacoesIdrLayer, unidadesIdrLayer];
