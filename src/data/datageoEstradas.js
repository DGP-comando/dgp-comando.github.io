// src/data/datageoEstradas.js
//
// Estradas municipais do PR (classe Infraestrutura), do OpenStreetMap via
// scripts/build_estradas.py. É o terceiro nível da malha viária, abaixo das
// federais (BR-xxx) e estaduais (PR/PRC-xxx) que a camada Rodovias serve
// estaticamente:
//
//   - urbanas: ruas de cidade e vila (residential, living_street, pedestrian)
//   - rurais:  estradas vicinais e de terra (unclassified, track, road)
//
// São centenas de milhares de trechos — vistos do estado inteiro cobrem o
// mapa de cinza e custariam dezenas de MB. Por isso vêm FATIADOS em células
// de 0,25° servidas como arquivos estáticos, e só aparecem perto do chão
// (slicedLineLayer.js, mesma mecânica da rede de distribuição).
//
// Os dois tetos de altura respondem às duas formas de "chegar perto":
//   - 90 km é o enquadramento de um município (flyToMunicipio, mesmo limiar
//     que as rodovias municipais usavam): selecionar um município na busca
//     ou na ficha já liga a camada.
//   - as urbanas só entram abaixo de 30 km: a malha de uma cidade vista de
//     90 km é um borrão que some o resto do mapa, e são elas que dominam a
//     contagem de trechos.
//
// Esta camada substituiu a busca ao vivo no Overpass que a Rodovias fazia
// para as municipais: mesma cobertura sem depender de um serviço público de
// terceiros no meio da navegação, e agora com as ruas urbanas e as vicinais
// rurais, que a consulta antiga (só secondary/tertiary/unclassified) não
// trazia.

import * as Cesium from 'cesium';
import { createSlicedLineLayer } from './slicedLineLayer.js';

// Contexto, não mensagem: cinza. Frio para o asfalto urbano, quente para a
// terra das vicinais — a distinção se lê sem depender só de matiz.
const CLASSE_STYLES = Object.freeze({
  urbanas: Object.freeze({
    color: Cesium.Color.fromCssColorString('#f1f5f9').withAlpha(0.5),
    width: 1.0,
    maxHeight: 30_000,
  }),
  rurais: Object.freeze({
    color: Cesium.Color.fromCssColorString('#a8a29e').withAlpha(0.55),
    width: 1.2,
  }),
});

export const datageoEstradasLayer = createSlicedLineLayer({
  id: 'datageo-estradas',
  name: 'Estradas municipais',
  category: 'Infraestrutura',
  icon: '🛤️',
  source: 'OpenStreetMap',
  baseUrl: '/data/estradas',
  groupsKey: 'classes',
  styleFor: (classe) => CLASSE_STYLES[classe],
  maxHeight: 90_000,
});
