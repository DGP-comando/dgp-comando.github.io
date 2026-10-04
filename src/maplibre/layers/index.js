// src/maplibre/layers/index.js
//
// Todas as camadas do protótipo, na MESMA ordem do painel do app Cesium
// (ordem de registro em src/main.js: DataGeo primeiro, contexto do GEV no fim).

import { municipiosLayer } from './municipios.js';
import territorios from './territorios.js';
import estacoesIdr from './estacoesIdr.js';
import monitoramento from './monitoramento.js';
import transporte from './transporte.js';
import energiaLogistica from './energiaLogistica.js';
import protecaoSocial from './protecaoSocial.js';
import conectividadeRadios from './conectividadeRadios.js';
import gradesClima from './gradesClima.js';
import contextoGev from './contextoGev.js';
import outorgas from './outorgas.js';
import caf from './caf.js';
import cafPj from './cafPj.js';
import fontesProtegidas from './fontesProtegidas.js';
import faxinais from './faxinais.js';
import programasIdr from './programasIdr.js';
import defesaAgropecuaria from './defesaAgropecuaria.js';

export const LAYER_ORDER = [
  'datageo-municipios',
  'datageo-terras-indigenas', 'datageo-quilombolas', 'datageo-assentamentos', 'datageo-faxinais-territorios',
  'datageo-faxinais', 'datageo-ucs-federais',
  'datageo-ucs-estaduais', 'datageo-outorgas', 'datageo-fontes-protegidas', 'datageo-regionais-idr', 'datageo-estacoes-idr', 'datageo-unidades-idr',
  'datageo-associacoes', 'datageo-equipamentos-suas',
  'datageo-car', 'datageo-caf', 'datageo-caf-pj',
  'datageo-clima', 'datageo-rios', 'datageo-cemaden', 'datageo-irtc', 'datageo-dengue', 'datageo-ar',
  'datageo-anomalias', 'datageo-incidentes', 'datageo-infohidro', 'datageo-maritimo',
  'datageo-ferrovias', 'datageo-rodovias', 'datageo-estradas', 'datageo-estradas-conveniadas',
  'datageo-transmissao', 'datageo-distribuicao', 'datageo-subestacoes', 'datageo-geracao',
  'datageo-agroindustrias-idr', 'datageo-urs-graos', 'datageo-urs-cafe', 'datageo-urs-piscicultura',
  'datageo-urs-pecuaria-corte', 'datageo-rotas-turisticas',
  'datageo-adapar-exploracoes', 'datageo-adapar-veterinarios', 'datageo-adapar-animais-vivos',
  'datageo-adapar-agrotoxicos', 'datageo-adapar-fertilizantes', 'datageo-adapar-unidades-consolidacao',
  'datageo-adapar-industrias-poa', 'datageo-adapar-unidades', // escritórios por cima dos cadastros
  'datageo-armazens', 'datageo-agroindustrias', 'datageo-ceasas',
  'datageo-conectividade',
  'datageo-clima-historico', 'datageo-precipitacao', 'datageo-ventos',
  'datageo-radios',
  'earthquakes', 'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms',
];

const all = [
  municipiosLayer,
  ...territorios,
  ...estacoesIdr,
  ...monitoramento,
  ...transporte,
  ...energiaLogistica,
  ...protecaoSocial,
  ...conectividadeRadios,
  ...gradesClima,
  ...contextoGev,
  ...outorgas,
  ...caf,
  ...cafPj,
  ...fontesProtegidas,
  ...faxinais,
  ...programasIdr,
  ...defesaAgropecuaria,
];

const rank = (id) => {
  const i = LAYER_ORDER.indexOf(id);
  return i < 0 ? LAYER_ORDER.length : i;
};

export const LAYERS = all.sort((a, b) => rank(a.id) - rank(b.id));
