// src/maplibre/layers/ottobacias.js
//
// Ottobacias (Otto Pfafstetter) em duas leituras que se complementam:
//
// - Microbacias do IDR (PROtto, IDR-Paraná): 6.210 ottobacias de ~3.000 ha,
//   o recorte de planejamento, com a grande bacia e, em 98 delas, o manancial
//   de abastecimento (Sanepar ou IDR-Paraná). Arquivo estático
//   (scripts/build_ottobacias.py); cor pelo manancial, filtrável na legenda.
// - Ottobacias por trecho (IAT/GeoPR, rede ottocodificada 2020): a área de
//   contribuição de cada um dos ~1 milhão de trechos da camada Hidrografia
//   (mesmo `cobacia` do tooltip dela). Imagem do cache do GeoPR e, a partir
//   do zoom 12, tooltip pela consulta da vista (geoprVista.js).

import { defineLayer, fmtInt, fmtNum, tipCard } from '../kit.js';
import { consultaDaVista, ringsParaGeojson } from './geoprVista.js';
import { contornoEsri, geoprSpec } from './geoprRaster.js';

const CATEGORY = 'Aspectos físicos';

// --- microbacias do IDR -------------------------------------------------------

const IDR_URL = '/data/ottobacias-idr-pr.geojson';
const IDR_SRC = 'dg-ottobacias-idr';

/** Classe de manancial (propriedade `man` das feições) -> legenda. */
export const MANANCIAL = Object.freeze([
  { key: 'sanepar', label: 'Manancial Sanepar', color: '#38bdf8' },
  { key: 'idr', label: 'Manancial IDR-Paraná', color: '#4ade80' },
  { key: 'demais', label: 'Demais ottobacias', color: '#94a3b8' },
]);
const COR = Object.fromEntries(MANANCIAL.map((m) => [m.key, m.color]));
const corMan = ['match', ['get', 'man'], ...MANANCIAL.flatMap((m) => [m.key, m.color]), '#94a3b8'];

/** Nível de Otto Pfafstetter = número de dígitos do código. */
export const nivelOtto = (cod) => String(cod ?? '').replace(/\D/g, '').length || null;

/** Contagem por classe de manancial ({sanepar, idr, demais}). */
export function contaManancial(features) {
  const n = { sanepar: 0, idr: 0, demais: 0 };
  for (const f of features ?? []) n[f.properties?.man in n ? f.properties.man : 'demais']++;
  return n;
}

export function ottobaciaIdrTooltip(p) {
  const man = MANANCIAL.find((m) => m.key === p.man);
  return tipCard({
    icon: '🗺️',
    title: `Ottobacia ${p.cod}`,
    subtitle: `Microbacia IDR · bacia do ${p.bacia || '?'}`,
    badge: p.manancial ? { text: man?.key === 'sanepar' ? 'Sanepar' : 'IDR-Paraná', tone: 'ok' } : null,
    rows: [
      ['Área', p.ha != null ? `${fmtInt(p.ha)} ha` : ''],
      ['Nível Otto', nivelOtto(p.cod) ?? ''],
      ['Manancial de abastecimento', p.manancial ? `${p.manancial} (${man?.label.replace('Manancial ', '') ?? ''})` : ''],
    ],
    source: 'IDR-Paraná · ottobacias de Otto Pfafstetter (PROtto)',
  });
}

let contagem = null;

export const ottobaciasIdrLayer = defineLayer({
  id: 'datageo-ottobacias-idr',
  name: 'Ottobacias · microbacias do IDR',
  category: CATEGORY,
  icon: '🗺️',
  source: 'IDR-Paraná · PROtto (Otto Pfafstetter), mananciais Sanepar e IDR',
  sources: { [IDR_SRC]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, generateId: true } },
  layers: [
    { id: 'dg-ottobacias-idr-fill', type: 'fill', source: IDR_SRC,
      paint: {
        'fill-color': corMan,
        'fill-opacity': ['case',
          ['boolean', ['feature-state', 'hover'], false], 0.45,
          ['==', ['get', 'man'], 'demais'], 0.04, 0.3],
      } },
    { id: 'dg-ottobacias-idr-line', type: 'line', source: IDR_SRC,
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#fde047', corMan],
        // O zoom tem que estar no topo da expressão; o realce vai dentro de cada parada.
        'line-width': ['interpolate', ['linear'], ['zoom'],
          6, ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 0.3],
          10, ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 0.9],
          13, ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.4]],
        'line-opacity': 0.85,
      } },
    { id: 'dg-ottobacias-idr-label', type: 'symbol', source: IDR_SRC, minzoom: 11,
      layout: { 'text-field': ['get', 'cod'], 'text-size': 11, 'text-font': ['Noto Sans Regular'] },
      paint: { 'text-color': '#e2e8f0', 'text-halo-color': 'rgba(5,8,13,0.9)', 'text-halo-width': 1.2 } },
  ],
  interactive: ['dg-ottobacias-idr-fill'],
  hoverState: IDR_SRC,
  legendFilter: 'man',
  async load(ctx) {
    const r = await fetch(IDR_URL);
    if (!r.ok) throw new Error(`${IDR_URL}: HTTP ${r.status}`);
    const fc = await r.json();
    ctx.setData(IDR_SRC, fc);
    contagem = contaManancial(fc.features);
    return fc.features.length;
  },
  tooltip: (p) => ottobaciaIdrTooltip(p),
  rowControls: () => ({
    legend: MANANCIAL.map((m) => ({ key: m.key, label: m.label, color: COR[m.key], count: contagem?.[m.key] ?? '' })),
  }),
});

// --- ottobacias por trecho (GeoPR) --------------------------------------------

const AREAS = 'rede_otto_areas_drena_2020_iat';
const AREAS_SRC = 'dg-ottobacias-trecho-areas';
const AREAS_MINZOOM = 12;

/** Área de contribuição do ArcGIS (rings) -> feição GeoJSON com id. */
export function areaFeature(f) {
  const geometry = ringsParaGeojson(f?.geometry?.rings);
  if (!geometry) return null;
  const a = f.attributes ?? {};
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    type: 'Feature',
    id: Number(a.objectid),
    geometry,
    properties: {
      cobacia: String(a.cobacia ?? '').trim(),
      areaKm2: num(a.nuareacont),
      nivel: num(a.nunivotto),
      curso: String(a.cocursodag ?? '').trim(),
      trecho: num(a.cotrecho),
    },
  };
}

export function areaTooltip(p) {
  const km2 = p.areaKm2;
  return tipCard({
    icon: '💧',
    title: `Ottobacia ${p.cobacia}`,
    subtitle: 'Área de contribuição de um trecho · IAT 2020',
    rows: [
      ['Área de contribuição', km2 == null ? '' : km2 < 1 ? `${fmtNum(km2 * 100, 1)} ha` : `${fmtNum(km2, 2)} km²`],
      ['Nível Otto', p.nivel ?? nivelOtto(p.cobacia) ?? ''],
      ['Curso d’água (código)', p.curso],
      ['Trecho', p.trecho ?? ''],
    ],
    source: 'IAT/GeoPR · rede ottocodificada 2020 (áreas de drenagem), consulta ao vivo',
  });
}

const areas = consultaDaVista({
  src: AREAS_SRC,
  servico: AREAS,
  campos: ['objectid', 'cobacia', 'nuareacont', 'nunivotto', 'cocursodag', 'cotrecho'],
  minzoom: AREAS_MINZOOM,
  feicao: areaFeature,
  tooltip: (p) => areaTooltip(p),
  oQue: 'áreas',
  rotulo: 'datageo-ottobacias-trecho',
  layers: [
    // Alvo do hover: o polígono inteiro, invisível.
    { id: `${AREAS_SRC}-hit`, type: 'fill', source: AREAS_SRC, minzoom: AREAS_MINZOOM,
      paint: { 'fill-color': '#000000', 'fill-opacity': 0 } },
    { id: `${AREAS_SRC}-realce`, type: 'line', source: AREAS_SRC, minzoom: AREAS_MINZOOM,
      paint: {
        'line-color': '#fde047',
        'line-width': 2.5,
        'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0],
      } },
  ],
});

// O cache do GeoPR (zoom 7 a 14) vem com preenchimento azul opaco, que apaga
// o satélite: fica de fundo, translúcido, só do 9 ao 11. Do 11 em diante, o
// export desenha só o contorno (~1,5 s por tile; no 8 seriam 15 s). Um milhão
// de áreas no estado inteiro vira borrão, por isso nada antes do 9.
const areasSpec = geoprSpec({
  id: 'datageo-ottobacias-trecho',
  category: CATEGORY,
  sufixo: 'ottobacias-trecho',
  name: 'Ottobacias por trecho · IAT 2020',
  icon: '💧',
  source: 'IAT/GeoPR · rede_otto_areas_drena_2020_iat, ao vivo · a partir do zoom 9',
  fontes: [
    { servico: AREAS, cache: 14, minzoom: 9, maxzoom: 11, opacity: 0.3 },
    { servico: AREAS, minzoom: 11, simbolo: contornoEsri([56, 189, 248]) },
  ],
});

export const ottobaciasTrechoLayer = defineLayer({
  ...areasSpec,
  sources: { ...areasSpec.sources, ...areas.sources },
  layers: [...areasSpec.layers, ...areas.layers],
  interactive: areas.interactive,
  hoverState: areas.hoverState,
  tooltip: areas.tooltip,
  onEnable: (ctx) => areas.ligar(ctx),
  onDisable: (ctx) => areas.desligar(ctx),
  rowControls: () => ({ legend: areas.legenda() }),
});

export default [ottobaciasIdrLayer, ottobaciasTrechoLayer];
