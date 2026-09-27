// src/maplibre/layers/index.js
//
// Todas as camadas do protótipo, na MESMA ordem do painel do app Cesium
// (ordem de registro em src/main.js: DataGeo primeiro, contexto do GEV no fim).

import { municipiosLayer } from './municipios.js';
import territorios from './territorios.js';
import monitoramento from './monitoramento.js';
import transporte from './transporte.js';
import energiaLogistica from './energiaLogistica.js';
import conectividadeRadios from './conectividadeRadios.js';
import gradesClima from './gradesClima.js';
import contextoGev from './contextoGev.js';

export const LAYER_ORDER = [
  'datageo-municipios',
  'datageo-terras-indigenas', 'datageo-quilombolas', 'datageo-assentamentos', 'datageo-ucs-federais',
  'datageo-ucs-estaduais', 'datageo-regionais-idr', 'datageo-associacoes',
  'datageo-car',
  'datageo-clima', 'datageo-rios', 'datageo-cemaden', 'datageo-irtc', 'datageo-dengue', 'datageo-ar',
  'datageo-anomalias', 'datageo-incidentes', 'datageo-infohidro', 'datageo-maritimo',
  'datageo-ferrovias', 'datageo-rodovias', 'datageo-estradas', 'datageo-estradas-conveniadas',
  'datageo-transmissao', 'datageo-distribuicao', 'datageo-subestacoes', 'datageo-geracao',
  'datageo-armazens', 'datageo-agroindustrias', 'datageo-agroindustrias-idr', 'datageo-rotas-turisticas', 'datageo-ceasas',
  'datageo-conectividade',
  'datageo-clima-historico', 'datageo-precipitacao', 'datageo-ventos',
  'datageo-radios',
  'earthquakes', 'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms',
];

const all = [
  municipiosLayer,
  ...territorios,
  ...monitoramento,
  ...transporte,
  ...energiaLogistica,
  ...conectividadeRadios,
  ...gradesClima,
  ...contextoGev,
];

const rank = (id) => {
  const i = LAYER_ORDER.indexOf(id);
  return i < 0 ? LAYER_ORDER.length : i;
};

export const LAYERS = all.sort((a, b) => rank(a.id) - rank(b.id));
