// src/data/datageoCar.js
//
// Imóveis do Cadastro Ambiental Rural, APENAS ATIVOS (classe Território):
// ~533 mil divisas declaradas no PR, do WFS público do SICAR via
// scripts/fetch_car.py + scripts/build_car.py. Pendentes, suspensos e
// cancelados não entram.
//
// Cada divisa é desenhada como LINHA (os anéis do polígono), não como
// polígono preenchido: meio milhão de preenchimentos clamped fecharia o mapa
// e esconderia a imagem de satélite, que é justamente o que se quer comparar
// com a divisa declarada. Vem fatiado em células de 0,25° carregadas por zoom
// (slicedLineLayer.js, a mesma mecânica das estradas e da distribuição).
//
// A cor é a CLASSE DE MÓDULOS FISCAIS, a mesma partição que a ficha municipal
// mostra em barras: o mapa responde "onde estão os imóveis grandes" e a ficha
// responde "quanto eles pesam em número e em área". Porte é codificado duas
// vezes, em cor E em espessura — a distinção não pode depender só de matiz.
//
// O que esta camada NÃO é: cadastro fundiário. O CAR é declaratório (o
// proprietário desenha o próprio imóvel), e as divisas aqui estão
// generalizadas a 30 m para caber no Pages. Serve para ver onde e de que
// porte; não serve para medir divisa nem para instruir processo.

import * as Cesium from 'cesium';
import { createSlicedLineLayer } from './slicedLineLayer.js';

// Escala sequencial por porte: claro e fino nos pequenos (que são a maioria e
// virariam uma mancha se tivessem o mesmo peso), forte e grosso nos grandes.
const CLASSE_STYLES = Object.freeze({
  '0-4': Object.freeze({
    color: Cesium.Color.fromCssColorString('#fef08a').withAlpha(0.45), width: 0.8,
  }),
  '4-10': Object.freeze({
    color: Cesium.Color.fromCssColorString('#fde047').withAlpha(0.55), width: 1.0,
  }),
  '10-20': Object.freeze({
    color: Cesium.Color.fromCssColorString('#fb923c').withAlpha(0.65), width: 1.2,
  }),
  '20-50': Object.freeze({
    color: Cesium.Color.fromCssColorString('#f97316').withAlpha(0.75), width: 1.4,
  }),
  '>50': Object.freeze({
    color: Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.85), width: 1.8,
  }),
});

export const datageoCarLayer = createSlicedLineLayer({
  id: 'datageo-car',
  name: 'CAR · imóveis ativos',
  category: 'Território',
  icon: '🌱',
  source: 'SICAR/SFB',
  baseUrl: '/data/car',
  groupsKey: 'classes',
  styleFor: (classe) => CLASSE_STYLES[classe],
  // Mesmo teto das estradas rurais: 90 km é o enquadramento de um município,
  // então escolher um município já traz as divisas junto.
  maxHeight: 90_000,
});
