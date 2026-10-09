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
import licenciamento from './licenciamento.js';
import caf from './caf.js';
import cafPj from './cafPj.js';
import fontesProtegidas from './fontesProtegidas.js';
import faxinais from './faxinais.js';
import programasIdr from './programasIdr.js';
import defesaAgropecuaria from './defesaAgropecuaria.js';
import aspectosFisicos from './aspectosFisicos.js';
import ottobacias from './ottobacias.js';
import geologia from './geologia.js';
import redeCopel from './redeCopel.js';
import pivos from './pivos.js';

export const LAYER_ORDER = [
  'datageo-municipios',
  'datageo-terras-indigenas', 'datageo-quilombolas', 'datageo-assentamentos', 'datageo-faxinais-territorios',
  'datageo-faxinais', 'datageo-ucs-federais',
  'datageo-ucs-estaduais', 'datageo-outorgas', 'datageo-pivos', 'datageo-licenciamento', 'datageo-regionais-idr',
  // Grupo IDR-Paraná: unidades (escritórios) primeiro, estações de pesquisa em seguida.
  'datageo-unidades-idr', 'datageo-estacoes-idr', 'datageo-fontes-protegidas',
  'datageo-associacoes', 'datageo-equipamentos-suas',
  'datageo-car', 'datageo-caf', 'datageo-caf-pj',
  'datageo-clima', 'datageo-rios', 'datageo-cemaden', 'datageo-irtc', 'datageo-dengue', 'datageo-ar',
  'datageo-anomalias', 'datageo-incidentes', 'datageo-infohidro', 'datageo-maritimo',
  'datageo-ferrovias', 'datageo-rodovias', 'datageo-estradas', 'datageo-estradas-conveniadas',
  'datageo-transmissao', 'datageo-distribuicao', 'datageo-copel-transformadores', 'datageo-copel-postes',
  'datageo-subestacoes', 'datageo-geracao',
  'datageo-agroindustrias-idr', 'datageo-urs-graos', 'datageo-urs-cafe', 'datageo-urs-piscicultura',
  'datageo-urs-pecuaria-corte', 'datageo-rotas-turisticas',
  // Grupo Defesa Agropecuária: escritórios da ADAPAR primeiro, cadastros depois.
  'datageo-adapar-unidades', 'datageo-adapar-exploracoes', 'datageo-adapar-veterinarios', 'datageo-adapar-animais-vivos',
  'datageo-adapar-agrotoxicos', 'datageo-adapar-fertilizantes', 'datageo-adapar-unidades-consolidacao',
  'datageo-adapar-industrias-poa',
  'datageo-armazens', 'datageo-agroindustrias', 'datageo-ceasas',
  'datageo-conectividade',
  'datageo-altimetria', 'datageo-declividade', 'datageo-hidrografia', 'datageo-ottobacias-idr', 'datageo-ottobacias-trecho',
  'datageo-nascentes', 'datageo-curvas-nivel',
  'datageo-litologia', 'datageo-estruturas-geologicas', 'datageo-geomorfologia',
  'datageo-processos-minerarios', 'datageo-ocorrencias-minerais',
  'datageo-uso-solo',
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
  ...licenciamento,
  ...caf,
  ...cafPj,
  ...fontesProtegidas,
  ...faxinais,
  ...programasIdr,
  ...defesaAgropecuaria,
  ...aspectosFisicos,
  ...ottobacias,
  ...geologia,
  ...redeCopel,
  ...pivos,
];

const rank = (id) => {
  const i = LAYER_ORDER.indexOf(id);
  return i < 0 ? LAYER_ORDER.length : i;
};

export const LAYERS = all.sort((a, b) => rank(a.id) - rank(b.id));
