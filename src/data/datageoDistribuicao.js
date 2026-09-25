// src/data/datageoDistribuicao.js
//
// Rede de distribuição de média tensão da Copel (classe Infraestrutura):
// ~777 mil trechos e ~205 mil km de 13,8 e 34,5 kV, da BDGD/ANEEL via
// scripts/build_distribuicao.py.
//
// Vista do estado inteiro a rede é um borrão que cobre o mapa e custaria
// dezenas de MB; por isso ela vem FATIADA em células de 0,25° e só aparece
// perto do chão. Toda a mecânica (index, delta encadeado, carga por zoom,
// despejo de células) mora em slicedLineLayer.js, compartilhada com as
// estradas municipais do OSM; aqui ficam só a fonte e as cores por tensão.

import * as Cesium from 'cesium';
import { createSlicedLineLayer } from './slicedLineLayer.js';
import { DISTRIBUICAO_KV } from './energiaLogisticaEstilos.js';

// Reexportados porque os testes de integridade das células (e qualquer
// consumidor externo) sempre entraram por este módulo.
export { cellKey, decodeCell, nearestCells } from './slicedLineLayer.js';

// Cor e largura por tensão nominal (kV), de energiaLogisticaEstilos.js (sem Cesium).
const KV_STYLES = Object.freeze(Object.fromEntries(
  Object.entries(DISTRIBUICAO_KV).map(([kv, s]) => [
    kv, Object.freeze({ color: Cesium.Color.fromCssColorString(s.css).withAlpha(s.alpha), width: s.width }),
  ]),
));

export const datageoDistribuicaoLayer = createSlicedLineLayer({
  id: 'datageo-distribuicao',
  name: 'Linhas de distribuição',
  category: 'Infraestrutura',
  icon: '🔗',
  source: 'ANEEL/BDGD (Copel)',
  baseUrl: '/data/distribuicao',
  groupsKey: 'tensoes',
  styleFor: (kv) => KV_STYLES[kv],
  maxHeight: 70_000,
});
