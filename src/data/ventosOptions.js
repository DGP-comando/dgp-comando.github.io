// src/data/ventosOptions.js
//
// Aparencia das particulas de vento (opcoes do cesium-wind-layer), sem Cesium:
// lida pela camada do app (datageoVentos.js) e pelo campo de particulas do
// prototipo MapLibre (src/maplibre/windParticles.js), para os dois casarem.
// A altura das particulas (particleHeight) fica em datageoVentos.js, junto do
// invariante com a precipitacao (precipitacaoRamp.test.mjs le de la).

export const WIND_PARTICLE_STYLE = {
  particlesTextureSize: 64, // 4096 particulas
  lineWidth: { min: 1, max: 2.4 },
  lineLength: { min: 30, max: 120 },
  speedFactor: 1.2,
  dropRate: 0.003,
  colors: ['#7dd3fc', '#22d3ee', '#a5f3fc', '#e0f2fe'],
  flipY: false,
};
