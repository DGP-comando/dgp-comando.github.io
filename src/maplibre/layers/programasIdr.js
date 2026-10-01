// src/maplibre/layers/programasIdr.js
//
// Grupo PROGRAMAS IDR: Unidades de Referência dos programas do IDR-Paraná
// (Grãos/UIRTs, Café, Piscicultura, Pecuária de Corte), uma camada de pontos
// por programa (makePointsLayer de energiaLogistica.js), e o uso do solo dos
// imóveis do CAR das queijarias da Rota do Queijo (polígonos por classe).
// As Agroindústrias (cadastro IDR) e as Rotas turísticas, que também são
// programas do IDR, ficam em energiaLogistica.js com a mesma categoria.
//
// Bucket privado (nome do produtor, imóvel do CAR): sem usuário liberado as
// camadas não carregam. Estilos e tooltips: src/data/programasIdrEstilos.js.

import { dgFetchData } from '../../data/datageoClient.js';
import {
  CAFE_LEGENDA, GRAOS_LEGENDA, PECUARIA_LEGENDA, PISCICULTURA_LEGENDA, UR_CONTORNO, UR_LABEL_DIST, USO_SOLO_CLASSES,
  USO_SOLO_OUTRA, cafeEstilo, cafeTooltip, graosEstilo, graosTooltip, pecuariaEstilo, pecuariaTooltip,
  pisciculturaEstilo, pisciculturaTooltip, usoSoloCor, usoSoloTooltip,
} from '../../data/programasIdrEstilos.js';
import { EMPTY_FC, defineLayer, fc, fmtNum } from '../kit.js';
import { makePointsLayer } from './energiaLogistica.js';

export const PROGRAMAS_IDR = 'Programas IDR';

const urs = (def) => makePointsLayer({ category: PROGRAMAS_IDR, labelDists: [UR_LABEL_DIST], ...def });

export const ursGraosLayer = urs({
  id: 'datageo-urs-graos',
  name: 'URs Grãos (UIRTs)',
  icon: '🌾',
  source: 'IDR-Paraná · Programa Grãos',
  url: '/privado/urs-graos-pr.geojson',
  estilo: graosEstilo,
  tooltip: graosTooltip,
  legend: GRAOS_LEGENDA,
  stroke: UR_CONTORNO.graos,
});

export const ursCafeLayer = urs({
  id: 'datageo-urs-cafe',
  name: 'URs Café',
  icon: '☕',
  source: 'IDR-Paraná · Programa Café',
  url: '/privado/urs-cafe-pr.geojson',
  estilo: cafeEstilo,
  tooltip: cafeTooltip,
  legend: CAFE_LEGENDA,
  stroke: UR_CONTORNO.cafe,
});

export const ursPisciculturaLayer = urs({
  id: 'datageo-urs-piscicultura',
  name: 'URs Piscicultura',
  icon: '🐟',
  source: 'IDR-Paraná · Programa Estadual de Piscicultura',
  url: '/privado/urs-piscicultura-pr.geojson',
  estilo: pisciculturaEstilo,
  tooltip: pisciculturaTooltip,
  legend: PISCICULTURA_LEGENDA,
  stroke: UR_CONTORNO.piscicultura,
});

export const ursPecuariaLayer = urs({
  id: 'datageo-urs-pecuaria-corte',
  name: 'URs Pecuária de Corte',
  icon: '🐂',
  source: 'IDR-Paraná · Purunã e Pecuária Moderna',
  url: '/privado/urs-pecuaria-corte-pr.geojson',
  estilo: pecuariaEstilo,
  tooltip: pecuariaTooltip,
  legend: PECUARIA_LEGENDA,
  stroke: UR_CONTORNO.pecuaria,
});

// -------------------------------------------- uso do solo das queijarias

const US_SRC = 'dg-usosolo-queijarias';
const US_FILL = 'dg-usosolo-queijarias-fill';

/** Polígonos com a cor da classe (id = índice em `props`) e legenda por classe (polígonos e ha). */
export function usoSoloFeatures(gj) {
  const props = [];
  const soma = {};
  const features = [];
  for (const f of gj?.features ?? []) {
    if (!f?.geometry) continue;
    const p = f.properties ?? {};
    const s = (soma[p.Classe] ??= { n: 0, ha: 0 });
    s.n += 1;
    s.ha += Number(p['Área (ha)']) || 0;
    features.push({ type: 'Feature', id: props.length, geometry: f.geometry, properties: { __color: usoSoloCor(p) } });
    props.push(p);
  }
  const conhecidas = USO_SOLO_CLASSES.map((c) => c.classe);
  const outras = Object.keys(soma).filter((c) => !conhecidas.includes(c));
  const legend = [...USO_SOLO_CLASSES, ...outras.map((classe) => ({ classe, color: USO_SOLO_OUTRA }))]
    .filter((c) => soma[c.classe])
    .map((c) => ({ label: `${c.classe} · ${fmtNum(soma[c.classe].ha, 1)} ha`, color: c.color, count: soma[c.classe].n }));
  return { features, props, legend };
}

let usProps = [];
let usLegend = [];

export const usoSoloQueijariasLayer = defineLayer({
  id: 'datageo-usosolo-queijarias',
  name: 'Turismo Rural: uso do solo das queijarias',
  category: PROGRAMAS_IDR,
  icon: '🌱',
  source: 'IDR-Paraná · Turismo Rural (CAR)',
  sources: { [US_SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    { id: US_FILL, type: 'fill', source: US_SRC, paint: { 'fill-color': ['get', '__color'], 'fill-opacity': 0.55 } },
    {
      id: 'dg-usosolo-queijarias-line',
      type: 'line',
      source: US_SRC,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': 'rgba(15,23,42,0.85)', 'line-width': 0.8 },
    },
  ],
  interactive: [US_FILL],
  async load(ctx) {
    const resp = await dgFetchData('/privado/usodosolo-queijarias-pr.geojson');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const built = usoSoloFeatures(await resp.json());
    usProps = built.props;
    usLegend = built.legend;
    ctx.setData(US_SRC, fc(built.features));
    const imoveis = new Set(usProps.flatMap((p) => String(p['Imóvel CAR'] ?? '').split(' · '))).size;
    return { count: built.features.length, info: `${imoveis} imóveis do CAR` };
  },
  tooltip: (_p, feature) => (usProps[feature?.id] ? usoSoloTooltip(usProps[feature.id]) : ''),
  rowControls: () => ({ legend: usLegend }),
});

export default [ursGraosLayer, ursCafeLayer, ursPisciculturaLayer, ursPecuariaLayer, usoSoloQueijariasLayer];
