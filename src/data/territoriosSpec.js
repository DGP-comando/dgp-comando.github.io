// src/data/territoriosSpec.js
//
// Especificação das camadas de TERRITÓRIOS em polígono (terras indígenas,
// quilombolas, assentamentos, UCs, regionais do IDR, associações), sem
// dependência de engine de mapa: id, nome, cor, rótulo no centroide, alcance
// do rótulo e tooltip (tipCard). Usada pelo protótipo MapLibre
// (src/maplibre/layers/territorios.js).
//
// Também as funções puras de geometria que as duas precisam: centroide do
// anel externo (âncora do rótulo) e a quebra das feições em partes.

import { fmtDate, fmtInt as fmtIntTip, fmtNum, fmtPct, tipCard } from '../maplibre/tooltipCard.js';
import { secaoCadunicoTerritorio } from './cadunicoRural.js';

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

export const areaHa = (ha) => (Number(ha) > 0 ? `${fmtInt(ha)} ha` : '');
export const nomeTi = (p) => `${String(p.nome).startsWith('TI ') ? '' : 'TI '}${p.nome}`;
const fmtFamilias = (n) => (Number(n) > 0 ? ` · ${Math.round(n).toLocaleString('pt-BR')} famílias` : '');
export const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/** Cor dos faxinais: perímetros (territorios.js) e pontos do inventário (faxinais.js). */
export const COR_FAXINAL = '#fcd34d';

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

// ------------------------------------------------------------------ tooltips
//
// Todos no formato único tipCard (src/maplibre/tooltipCard.js). O segundo
// argumento traz o contexto que a camada tem no hover:
//   { municipio: {ibge, nome} | null   // município sob o cursor
//     info: {<ibge>: {pop, areaKm2, vbp}} | null  // municipios-info.json
//     nomes: {<ibge>: nome} | null }   // nomes dos municípios (IBGE)

const MINUSCULAS = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);

const SIGLAS = /^(?:PA|PE|PDS|PAE|PAF|PCA|PAC|PRB|[IVX]+)$/;

/** "PA FAZENDA ESTRELA II" -> "PA Fazenda Estrela II"; "ORTIGUEIRA" -> "Ortigueira". */
export function tituloProprio(nome) {
  return String(nome ?? '')
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      if (SIGLAS.test(w)) return w;
      const lw = w.toLocaleLowerCase('pt-BR');
      if (i > 0 && MINUSCULAS.has(lw)) return lw;
      return lw.charAt(0).toLocaleUpperCase('pt-BR') + lw.slice(1);
    })
    .join(' ');
}

/** 1.234.567.890 -> "R$ 1,23 bi"; 45.600.000 -> "R$ 45,6 mi". */
export function fmtReais(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `R$ ${fmtNum(n / 1e9, 2)} bi`;
  if (n >= 1e6) return `R$ ${fmtNum(n / 1e6, 1)} mi`;
  return `R$ ${fmtIntTip(n)}`;
}

/** "21-03-2006" (CNUC) ou "14/08/1996" -> "21/03/2006". */
export function dataBr(v) {
  const s = String(v ?? '').trim();
  const m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? fmtDate(s.slice(0, 10)) : s;
}

/** Anos desde a data "dd/mm/aaaa" (ou "dd-mm-aaaa"), para "há N anos". */
function anosDesde(v, now = new Date()) {
  const m = /(\d{4})$/.exec(String(v ?? '').trim());
  if (!m) return '';
  const anos = now.getFullYear() - Number(m[1]);
  return anos > 0 ? ` (há ${anos} ${anos === 1 ? 'ano' : 'anos'})` : '';
}

const haTxt = (ha) => (Number(ha) > 0 ? fmtNum(ha, Number(ha) < 100 ? 1 : 0, 'ha') : '');
const kmDeHa = (ha) => (Number(ha) >= 100 ? ` · ${fmtNum(Number(ha) / 100, 1, 'km²')}` : '');
const areaTxt = (ha) => (haTxt(ha) ? `${haTxt(ha)}${kmDeHa(ha)}` : '');
const municipioCursor = (x) => x?.municipio?.nome ?? '';

/**
 * Soma dos indicadores municipais (municipios-info.json) de uma lista de
 * códigos IBGE: população, área e VBP agropecuário. Campos ausentes somem.
 */
export function agregadoMunicipal(ibges, info) {
  if (!info || !Array.isArray(ibges) || !ibges.length) return null;
  let pop = 0;
  let area = 0;
  let vbp = 0;
  let popAno = '';
  let vbpAno = '';
  let n = 0;
  for (const c of ibges) {
    const m = info[String(c)];
    if (!m) continue;
    n += 1;
    pop += Number(m.pop?.valor) || 0;
    popAno ||= m.pop?.ano ?? '';
    area += Number(m.areaKm2) || 0;
    vbp += Number(m.vbp?.valB) || 0;
    vbpAno ||= m.vbp?.anoB ?? '';
  }
  if (!n) return null;
  return { n, pop, popAno, area, vbp, vbpAno };
}

/** Lista de nomes (ordem alfabética), cortada em `max` com "e mais N". */
export function listaNomes(ibges, nomes, max = 12) {
  if (!nomes || !Array.isArray(ibges)) return '';
  const lista = ibges.map((c) => nomes[String(c)]).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (!lista.length) return '';
  const resto = lista.length - max;
  return resto > 0 ? `${lista.slice(0, max).join(', ')} e mais ${resto}` : lista.join(', ');
}

function linhasAgregado(ibges, x) {
  const ag = agregadoMunicipal(ibges, x?.info);
  return [
    ['População', ag?.pop ? `${fmtIntTip(ag.pop)} hab.${ag.popAno ? ` (${ag.popAno})` : ''}` : ''],
    ['Área', ag?.area ? fmtNum(ag.area, 0, 'km²') : ''],
    [`VBP agro${ag?.vbpAno ? ` ${ag.vbpAno}` : ''}`, ag ? fmtReais(ag.vbp) : ''],
  ];
}

const ETAPA_TI_TOM = {
  Regularizada: 'ok', Homologada: 'ok', Declarada: 'info', 'Encaminhada RI': 'info', Delimitada: 'warn', 'Em estudo': 'warn',
};
const ETAPA_TI_DESC = {
  Regularizada: 'Regularizada (registrada em cartório e na SPU)',
  Homologada: 'Homologada por decreto presidencial',
  Declarada: 'Declarada (portaria do Ministério da Justiça)',
  'Encaminhada RI': 'Encaminhada como reserva indígena',
  Delimitada: 'Delimitada (relatório da FUNAI publicado)',
  'Em estudo': 'Em estudo pela FUNAI',
};

export function terraIndigenaTooltip(p, x) {
  return tipCard({
    icon: '🪶',
    title: nomeTi(p),
    subtitle: 'Terra indígena',
    badge: p.etapa ? { text: p.etapa, tone: ETAPA_TI_TOM[p.etapa] ?? 'info' } : null,
    rows: [
      ['Situação', ETAPA_TI_DESC[p.etapa] ?? p.etapa],
      ['Área', areaTxt(p.area_ha)],
      ['Município', municipioCursor(x)],
    ],
    sections: [secaoCadunicoTerritorio(x?.cadunico, x?.cadunicoRef)].filter(Boolean),
    source: 'FUNAI/CMR · DataGeo PR',
  });
}

const FASE_QUILOMBO = {
  RTID: 'RTID publicado (Relatório Técnico de Identificação e Delimitação)',
  PORTARIA: 'Portaria de reconhecimento do INCRA',
  DECRETO: 'Decreto de interesse social (desapropriação)',
  TITULADO: 'Titulado',
};
const FASE_QUILOMBO_TOM = { RTID: 'warn', PORTARIA: 'info', DECRETO: 'info', TITULADO: 'ok' };

export function quilombolaTooltip(p, x) {
  const fase = String(p.fase ?? '').trim();
  return tipCard({
    icon: '🏘️',
    title: `Território quilombola ${p.nome}`,
    subtitle: p.municipio || municipioCursor(x) || 'Comunidade remanescente de quilombo',
    badge: fase ? { text: fase.length > 4 ? tituloProprio(fase) : fase, tone: FASE_QUILOMBO_TOM[fase.toUpperCase()] ?? 'info' } : null,
    rows: [
      ['Fase', FASE_QUILOMBO[fase.toUpperCase()] ?? fase],
      ['Município', p.municipio || municipioCursor(x)],
    ],
    sections: [secaoCadunicoTerritorio(x?.cadunico, x?.cadunicoRef)].filter(Boolean),
    source: 'IBGE, Censo 2022 · INCRA',
  });
}

const FASE_PA_TOM = {
  Consolidado: 'ok', 'Em consolidação': 'info', 'Em estruturação': 'info', 'Em instalação': 'warn', Criado: 'warn',
};

export function assentamentoTooltip(p, x) {
  const fam = Number(p.familias);
  const cap = Number(p.capacidade);
  const ocup = fam > 0 && cap > 0 ? ` (${fmtPct(fam / cap, 0)})` : '';
  const familias = fam > 0 ? `${fmtIntTip(fam)}${cap > 0 ? ` de ${fmtIntTip(cap)} lotes` : ''}${ocup}` : '';
  const haFam = fam > 0 && Number(p.area_ha) > 0 ? fmtNum(Number(p.area_ha) / fam, 1, 'ha por família') : '';
  const municipio = p.municipio ? tituloProprio(p.municipio) : municipioCursor(x);
  return tipCard({
    icon: '🌾',
    title: tituloProprio(p.nome),
    subtitle: `Projeto de assentamento${municipio ? ` · ${municipio}` : ''}`,
    badge: p.fase ? { text: p.fase, tone: FASE_PA_TOM[p.fase] ?? 'info' } : null,
    rows: [
      ['Área', areaTxt(p.area_ha)],
      ['Famílias', familias, fam > 0 && cap > 0 && fam < cap ? 'warn' : null],
      ['Área média', haFam],
      ['Criação', p.criacao ? `${dataBr(p.criacao)}${anosDesde(p.criacao)}` : ''],
      ['Obtenção', p.obtencao],
      ['Código SIPRA', p.codigo],
    ],
    sections: [secaoCadunicoTerritorio(x?.cadunico, x?.cadunicoRef)].filter(Boolean),
    source: 'INCRA/SIPRA · DataGeo PR',
  });
}

const GESTOR_UC = {
  'INSTITUTO CHICO MENDES DE CONSERVAÇÃO DA BIODIVERSIDADE': 'ICMBio (Instituto Chico Mendes)',
  'INSTITUTO AMBIENTAL DO PARANÁ - PR': 'IAT (Instituto Água e Terra, antigo IAP)',
};
const PLANO_TOM = { Sim: 'ok', Não: 'warn', 'Sem informação': 'muted' };

export function ucTooltip(p, x) {
  const integral = /integral/i.test(p.grupo ?? '');
  return tipCard({
    icon: p.esfera === 'Estadual' ? '🌲' : '🌳',
    title: tituloUc(p.nome),
    subtitle: [p.categoria, p.esfera ? `UC ${String(p.esfera).toLocaleLowerCase('pt-BR')}` : ''].filter(Boolean).join(' · '),
    badge: p.grupo ? { text: integral ? 'Proteção integral' : 'Uso sustentável', tone: integral ? 'ok' : 'info' } : null,
    rows: [
      ['Área', areaTxt(p.area_ha)],
      ['Criação', p.criacao ? `${dataBr(p.criacao)}${anosDesde(p.criacao)}` : ''],
      ['Gestor', GESTOR_UC[p.gestor] ?? tituloUc(p.gestor ?? '')],
      ['Plano de manejo', p.plano_manejo, PLANO_TOM[p.plano_manejo]],
      ['Município', municipioCursor(x)],
      ['Código CNUC', p.cnuc],
    ],
    source: 'MMA/CNUC · DataGeo PR',
  });
}

const ARESUR_TOM = { Sim: 'ok', 'Em análise': 'warn' };

/** Perímetro de faxinal (IAT): território inscrito no CAR ou perímetro ARESUR. */
export function faxinalTooltip(p) {
  const resolucao = p.resolucao ? `Resolução SEMA ${p.resolucao}` : '';
  return tipCard({
    icon: '🌳',
    title: tituloProprio(p.nome),
    subtitle: `Faxinal${p.municipio ? ` · ${p.municipio}` : ''}`,
    badge: p.aresur ? { text: p.aresur === 'Sim' ? 'ARESUR' : `ARESUR ${p.aresur.toLocaleLowerCase('pt-BR')}`, tone: ARESUR_TOM[p.aresur] ?? 'info' } : null,
    rows: [
      ['Perímetro', p.base === 'CAR' ? `${p.perimetro} (CAR)` : p.perimetro],
      ['Área mapeada', areaTxt(p.area_ha)],
      ['Área na resolução', haTxt(p.area_resolucao_ha)],
      ['Imóvel no CAR', haTxt(p.area_imovel_ha)],
      ['ARESUR', resolucao || (p.aresur === 'Sim' ? 'reconhecido, sem resolução na base' : '')],
      ['Recibo do CAR', p.recibo_car],
    ],
    note: p.obs,
    source: 'IAT/GeoPR · Limites Faxinais e ARESUR (Decreto 3.446/1997)',
  });
}

export function regionalIdrTooltip(p, x) {
  const ibges = p.municipios ?? [];
  return tipCard({
    icon: '🗺️',
    title: `Regional ${p.regional}`,
    subtitle: `IDR-Paraná · ${plural(ibges.length, 'município', 'municípios')}`,
    rows: [
      ...linhasAgregado(ibges, x),
      ['Municípios', listaNomes(ibges, x?.nomes) || fmtIntTip(ibges.length)],
    ],
    note: 'Clique para abrir a ficha regional.',
    source: 'IDR-Paraná · IBGE · SEAB/DERAL',
  });
}

export function associacaoTooltip(p, x) {
  const ibges = p.municipios ?? [];
  return tipCard({
    icon: '🤝',
    title: p.sigla,
    subtitle: p.nome,
    rows: [
      ['Municípios', fmtIntTip(ibges.length)],
      ...linhasAgregado(ibges, x),
      ['Membros', listaNomes(ibges, x?.nomes, 20)],
    ],
    source: 'SECID-PR · IBGE · SEAB/DERAL',
  });
}

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
    tooltipOf: terraIndigenaTooltip,
    // Famílias do CadÚnico casadas ao território (bucket privado; chave = nome).
    cadunico: { grupo: 'terras_indigenas', chave: (p) => p.nome },
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
    tooltipOf: quilombolaTooltip,
    cadunico: { grupo: 'quilombos', chave: (p) => p.nome },
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
    tooltipOf: assentamentoTooltip,
    labelMaxDist: 80_000,
    cadunico: { grupo: 'assentamentos', chave: (p) => p.codigo },
  },
  // Perímetros do IAT: os 30 territórios do CAR (com a situação na ARESUR) e
  // os perímetros ARESUR sem território correspondente (build_faxinais.py).
  faxinais: {
    id: 'datageo-faxinais-territorios',
    name: 'Faxinais · territórios (IAT)',
    icon: '🌳',
    source: 'IAT/GeoPR · ARESUR',
    url: '/data/faxinais-territorios-pr.geojson',
    cssColor: COR_FAXINAL,
    labelOf: (p) => `${tituloProprio(p.nome)}${fmtHa(p.area_ha)}`,
    labelMaxDist: 120_000,
    tooltipOf: faxinalTooltip,
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
    tooltipOf: ucTooltip,
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
    tooltipOf: ucTooltip,
  },
  regionaisIdr: {
    id: 'datageo-regionais-idr',
    category: 'Limites e regiões',
    name: 'Regionais do IDR',
    icon: '🗺️',
    source: 'IDR-Paraná',
    url: '/data/regionais-idr-pr.geojson',
    cssColor: '#34d399',
    fillAlpha: 0.12,
    labelOf: (p) => `IDR ${p.regional}`,
    labelMaxDist: 1_800_000,
    tooltipOf: regionalIdrTooltip,
    agregaMunicipios: true,
  },
  // Quase só contorno: 27 municípios estão em duas associações, e os polígonos
  // se sobrepõem; preenchimento empilhado ficaria ilegível. O alfa mínimo existe
  // para o polígono ser "pickado" pelo tooltip.
  associacoes: {
    id: 'datageo-associacoes',
    category: 'Limites e regiões',
    name: 'Associações de municípios',
    icon: '🤝',
    source: 'SECID-PR',
    url: '/data/associacoes-pr.geojson',
    cssColor: '#f472b6',
    fillAlpha: 0.02,
    labelOf: (p) => p.sigla,
    labelMaxDist: 1_800_000,
    tooltipOf: associacaoTooltip,
    agregaMunicipios: true,
  },
});
