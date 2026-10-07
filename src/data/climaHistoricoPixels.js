// src/data/climaHistoricoPixels.js
//
// Pintura da grade do clima historico em pixels RGBA, sem Cesium: usada pela
// camada do app (datageoClimaHistorico.js, que reexporta) e pelo prototipo
// MapLibre (src/maplibre/layers/gradesClima.js).

import { corDe, indiceDe, maiorModulo } from './climaHistoricoRamp.js';

/**
 * Pinta um indicador num canvas com anel transparente de uma celula. Linha 0 da
 * grade e o SUL (mesma convencao da grade Open-Meteo); o canvas cresce para
 * baixo, dai o `height - 1 - j`.
 * @param {{width: number, height: number}} grade
 * @param {Array<number|null>} valores
 * @param {object} ind
 * @param {number[]} quebras
 * @param {Set<string>} [ocultos] classes (indice na rampa, como texto)
 *   escondidas pela legenda: ficam transparentes
 */
export function pintarPixels(grade, valores, ind, quebras, ocultos = new Set()) {
  const { width, height } = grade;
  const pad = 1;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  const maxAbs = maiorModulo(valores);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const target = ((height - 1 - j + pad) * w + (i + pad)) * 4;
      const v = valores[j * width + i];
      if (ocultos.size && ocultos.has(String(indiceDe(v, ind, quebras, maxAbs)))) continue;
      const [r, g, b, a] = corDe(v, ind, quebras, maxAbs);
      data[target] = r;
      data[target + 1] = g;
      data[target + 2] = b;
      data[target + 3] = a;
    }
  }
  return { data, w, h };
}
