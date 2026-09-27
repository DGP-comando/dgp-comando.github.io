// src/data/earthquakeStyle.js
//
// Regras puras (sem Cesium) da camada de terremotos USGS: corte de magnitude,
// faixa de cor por profundidade e raio do disco. Compartilhadas pelo app
// Cesium (earthquakes.js) e pelo protótipo MapLibre.

/** Micro-sismos abaixo disto ficam fora (feed all_day do USGS). */
export const EARTHQUAKE_MIN_MAG = 2.5;
/** A partir desta magnitude o disco fica mais opaco e com borda mais grossa. */
export const EARTHQUAKE_SIGNIFICANT_MAG = 5.0;

/** Cores CSS equivalentes a Cesium.Color.RED / ORANGE / YELLOW. */
export const EARTHQUAKE_DEPTH_CSS = Object.freeze({
  red: '#ff0000',
  orange: '#ffa500',
  yellow: '#ffff00',
});

/**
 * Faixa de profundidade: rasa (<70 km) vermelha, intermediária (70-300 km)
 * laranja, profunda (>300 km) amarela.
 * @param {number} depthKm
 * @returns {'red'|'orange'|'yellow'}
 */
export function earthquakeDepthBand(depthKm) {
  if (depthKm < 70) return 'red';
  if (depthKm < 300) return 'orange';
  return 'yellow';
}

/** Raio do disco no chão, em metros: 2^mag km. */
export function earthquakeRadiusM(mag) {
  return Math.pow(2, mag) * 1000;
}
