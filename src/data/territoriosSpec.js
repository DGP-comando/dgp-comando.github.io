// src/data/territoriosSpec.js
//
// Especificação das camadas de TERRITÓRIOS em polígono (terras indígenas,
// quilombolas, assentamentos, UCs, regionais do IDR, associações), sem
// dependência de engine de mapa: id, nome, cor, rótulo no centroide, alcance
// do rótulo e HTML do tooltip. Usada pela camada Cesium (datageoTerritorios.js)
// e pelo protótipo MapLibre (src/maplibre/layers/territorios.js).
//
// Também as funções puras de geometria que as duas precisam: centroide do
// anel externo (âncora do rótulo) e a quebra das feições em partes.

import { escapeHtml as esc } from './vesselTooltip.js';

/** Centroide simples do anel externo (suficiente para ancorar label). */
export function centroidOf(rings) {
  const ring = rings[0] ?? [];
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
  }
  return ring.length ? [sx / ring.length, sy / ring.length] : null;
}

/** Partes (lista de anéis) de um Polygon/MultiPolygon; [] para o resto. */
export function polygonParts(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

export const fmtHa = (ha) => (ha ? ` · ${Math.round(ha).toLocaleString('pt-BR')} ha` : '');
export const fmtInt = (v) => Math.round(Number(v)).toLocaleString('pt-BR');

/** Tooltip padrão: título, linhas "rótulo: valor" (vazias somem) e fonte. */
export function tooltipHtml(titulo, linhas, fonte) {
  const corpo = linhas
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `<div><span class="vt-dim">${esc(k)}:</span> ${esc(v)}</div>`)
    .join('');
  return `<div class="vt-nome">${esc(titulo)}</div>${corpo}<div class="vt-fontes">${esc(fonte)}</div>`;
}
export const areaHa = (ha) => (Number(ha) > 0 ? `${fmtInt(ha)} ha` : '');
export const nomeTi = (p) => `${String(p.nome).startsWith('TI ') ? '' : 'TI '}${p.nome}`;
const fmtFamilias = (n) => (Number(n) > 0 ? ` · ${Math.round(n).toLocaleString('pt-BR')} famílias` : '');
export const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/**
 * "RESERVA BIOLÓGICA DAS PEROBAS" -> "Reserva Biológica das Perobas": o CNUC
 * grava em caixa alta, e rótulo em caixa alta no globo pesa demais.
 */
export function tituloUc(nome) {
  const minusculas = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
  return String(nome ?? '')
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .map((w, i) => (i > 0 && minusculas.has(w) ? w : w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1)))
    .join(' ');
}

/** Dados da ficha regional das regionais do IDR (openFichaRegiao). */
export const fichaRegionalIdr = (p) => ({
  nome: `Regional ${p.regional}`,
  meta: `IDR-Paraná · ${plural(p.municipios.length, 'município', 'municípios')}`,
  ibges: p.municipios,
});

/**
 * Uma entrada por camada, na ordem do painel. `labelMaxDist` é a distância
 * de câmera (m) acima da qual o rótulo some; `fillAlpha` o alfa do
 * preenchimento (a borda é sempre 0.75).
 */
export const TERRITORIO_SPECS = Object.freeze({
  terrasIndigenas: {
    id: 'datageo-terras-indigenas',
    name: 'Terras indígenas',
    icon: '🪶',
    source: 'FUNAI/CMR',
    url: '/data/terras-indigenas-pr.geojson',
    cssColor: '#fb923c',
    // O nome da FUNAI ja vem prefixado ("TI Marrecas") — nao duplicar.
    labelOf: (p) => `${nomeTi(p)}${fmtHa(p.area_ha)}`,
    labelMaxDist: 600_000,
    tooltipOf: (p) => tooltipHtml(nomeTi(p), [
      ['Etapa', p.etapa],
      ['Área', areaHa(p.area_ha)],
    ], 'FUNAI/CMR'),
  },
  quilombolas: {
    id: 'datageo-quilombolas',
    name: 'Territórios quilombolas',
    icon: '🏘️',
    source: 'IBGE Censo 2022',
    url: '/data/quilombolas-pr.geojson',
    cssColor: '#c084fc',
    labelOf: (p) => `TQ ${p.nome}${p.fase ? ` (${p.fase})` : ''}`,
    labelMaxDist: 1_600_000,
    tooltipOf: (p) => tooltipHtml(`Território quilombola ${p.nome}`, [
      ['Município', p.municipio],
      ['Fase', p.fase],
    ], 'IBGE, Censo 2022'),
  },
  assentamentos: {
    id: 'datageo-assentamentos',
    name: 'Assentamentos (INCRA)',
    icon: '🌾',
    source: 'INCRA/SIPRA',
    url: '/data/assentamentos-incra-pr.geojson',
    cssColor: '#a3e635',
    // 311 projetos no PR: rótulo só perto para não virar tapete de texto.
    labelOf: (p) => `${p.nome}${fmtFamilias(p.familias)}`,
    tooltipOf: (p) => tooltipHtml(p.nome, [
      ['Município', p.municipio],
      ['Área', areaHa(p.area_ha)],
      ['Famílias', Number(p.familias) > 0 ? `${fmtInt(p.familias)} de ${fmtInt(p.capacidade)} de capacidade` : ''],
      ['Fase', p.fase],
      ['Criação', p.criacao],
      ['Obtenção', p.obtencao],
      ['Código SIPRA', p.codigo],
    ], 'INCRA/SIPRA'),
    labelMaxDist: 80_000,
  },
  ucsFederais: {
    id: 'datageo-ucs-federais',
    name: 'Unidades de conservação federais',
    icon: '🌳',
    source: 'MMA/CNUC · ICMBio',
    url: '/data/ucs-federais-pr.geojson',
    cssColor: '#34d399',
    category: 'Ambiente',
    labelOf: (p) => `${tituloUc(p.nome)}${fmtHa(p.area_ha)}`,
    labelMaxDist: 400_000,
  },
  ucsEstaduais: {
    id: 'datageo-ucs-estaduais',
    name: 'Unidades de conservação estaduais',
    icon: '🌲',
    source: 'MMA/CNUC · IAT',
    url: '/data/ucs-estaduais-pr.geojson',
    cssColor: '#2dd4bf',
    category: 'Ambiente',
    labelOf: (p) => `${tituloUc(p.nome)}${fmtHa(p.area_ha)}`,
    labelMaxDist: 400_000,
  },
  regionaisIdr: {
    id: 'datageo-regionais-idr',
    name: 'Regionais do IDR',
    icon: '🗺️',
    source: 'IDR-Paraná',
    url: '/data/regionais-idr-pr.geojson',
    cssColor: '#34d399',
    fillAlpha: 0.12,
    labelOf: (p) => `IDR ${p.regional}`,
    labelMaxDist: 1_800_000,
    tooltipOf: (p) => tooltipHtml(`Regional ${p.regional}`, [
      ['Municípios', fmtInt(p.municipios.length)],
      ['Ficha', 'clique para abrir a ficha regional'],
    ], 'IDR-Paraná'),
  },
  // Quase só contorno: 27 municípios estão em duas associações, e os polígonos
  // se sobrepõem; preenchimento empilhado ficaria ilegível. O alfa mínimo existe
  // para o polígono ser "pickado" pelo tooltip.
  associacoes: {
    id: 'datageo-associacoes',
    name: 'Associações de municípios',
    icon: '🤝',
    source: 'SECID-PR',
    url: '/data/associacoes-pr.geojson',
    cssColor: '#f472b6',
    fillAlpha: 0.02,
    labelOf: (p) => p.sigla,
    labelMaxDist: 1_800_000,
    tooltipOf: (p) => tooltipHtml(p.sigla, [
      ['Nome', p.nome],
      ['Municípios', fmtInt(p.municipios.length)],
    ], 'SECID-PR'),
  },
});
