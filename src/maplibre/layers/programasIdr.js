// src/maplibre/layers/programasIdr.js
//
// Grupo PROGRAMAS IDR: Unidades de Referência dos programas do IDR-Paraná
// (Grãos/UIRTs, Café, Piscicultura, Pecuária de Corte), uma camada de pontos
// por programa (makePointsLayer de energiaLogistica.js).
// As Agroindústrias (cadastro IDR) e as Rotas turísticas, que também são
// programas do IDR, ficam em energiaLogistica.js com a mesma categoria.
//
// Bucket privado (nome do produtor): sem usuário liberado as camadas não
// carregam. Estilos e tooltips: src/data/programasIdrEstilos.js.

import {
  CAFE_LEGENDA, GRAOS_LEGENDA, PECUARIA_LEGENDA, PISCICULTURA_LEGENDA, UR_CONTORNO, UR_LABEL_DIST,
  cafeEstilo, cafeTooltip, graosEstilo, graosTooltip, pecuariaEstilo, pecuariaTooltip,
  pisciculturaEstilo, pisciculturaTooltip,
} from '../../data/programasIdrEstilos.js';
import { makePointsLayer } from './energiaLogistica.js';

export const PROGRAMAS_IDR = 'IDR-Paraná';

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

export default [ursGraosLayer, ursCafeLayer, ursPisciculturaLayer, ursPecuariaLayer];
