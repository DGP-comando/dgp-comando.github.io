// src/data/carClasses.js
//
// Estilo das divisas do CAR por CLASSE DE MÓDULOS FISCAIS (ver o cabeçalho de
// datageoCar.js), sem dependência de engine de mapa: usado pela camada Cesium
// e pelo protótipo MapLibre (src/maplibre/layers/territorios.js).
//
// Escala sequencial por porte: claro e fino nos pequenos (que são a maioria e
// virariam uma mancha se tivessem o mesmo peso), forte e grosso nos grandes.
// `width` em pixels de tela.

export const CAR_CLASSE_STYLES = Object.freeze({
  '0-4': Object.freeze({ css: '#fef08a', alpha: 0.45, width: 0.8 }),
  '4-10': Object.freeze({ css: '#fde047', alpha: 0.55, width: 1.0 }),
  '10-20': Object.freeze({ css: '#fb923c', alpha: 0.65, width: 1.2 }),
  '20-50': Object.freeze({ css: '#f97316', alpha: 0.75, width: 1.4 }),
  '>50': Object.freeze({ css: '#ef4444', alpha: 0.85, width: 1.8 }),
});

/** Teto de altura de câmera (m) da camada: o enquadramento de um município. */
export const CAR_MAX_HEIGHT = 90_000;
