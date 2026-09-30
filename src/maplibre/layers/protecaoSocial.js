// src/maplibre/layers/protecaoSocial.js
//
// Equipamentos da assistência social e da segurança alimentar (MDS · Mapa
// Social): pontos pela mesma fábrica das camadas de logística.

import { SUAS_LEGENDA, equipamentoSuasEstilo, equipamentoSuasTooltipHtml } from '../../data/equipamentosSuasEstilos.js';
import { makePointsLayer } from './energiaLogistica.js';

const equipamentosSuasLayer = makePointsLayer({
  id: 'datageo-equipamentos-suas',
  name: 'CRAS, CREAS e segurança alimentar',
  category: 'Proteção social',
  icon: '🤝',
  source: 'MDS · Mapa Social',
  url: '/data/equipamentos-suas-pr.geojson',
  estilo: equipamentoSuasEstilo,
  tooltip: equipamentoSuasTooltipHtml,
  legend: SUAS_LEGENDA,
  labelDists: [40_000],
});

export default [equipamentosSuasLayer];
