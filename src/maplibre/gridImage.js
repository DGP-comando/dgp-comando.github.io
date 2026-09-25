// src/maplibre/gridImage.js
//
// Grades regulares em graus (Open-Meteo 22x15, BR-DWGD 0,1°) como fonte
// `image` do MapLibre: o mesmo canvas com anel transparente que o app Cesium
// estica num `rectangle`, mais uma correção que só o MapLibre precisa.
//
// O retângulo do Cesium é equirretangular (linhas igualmente espaçadas em
// latitude); a fonte `image` do MapLibre interpola os quatro cantos em espaço
// Mercator (também no globo, que subdivide o quad em Mercator). Sem corrigir,
// as linhas do meio do PR deslizariam para o norte. Por isso o canvas final é
// reamostrado linha a linha para espaçamento Mercator antes de virar URL.
//
// As funções puras (sem DOM) ficam no topo e são testadas em
// layers/gradesClima.test.mjs; `gridImageUrl` usa canvas e só roda no browser.

import { precipRgba } from '../data/precipitacaoRamp.js';

/** PNG 1x1 transparente: fonte `image` precisa de URL já no addSource. */
export const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const DEG = Math.PI / 180;

/** y Mercator (adimensional) de uma latitude em graus. */
export function mercatorY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

export function latFromMercatorY(y) {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/**
 * Para a linha `row` (0 = topo/norte) de uma imagem com `rows` linhas que será
 * esticada em Mercator entre `south` e `north`, a posição fracionária (0 =
 * norte, 1 = sul) da mesma latitude na imagem equirretangular de origem.
 */
export function mercatorRowSource(row, rows, south, north) {
  const yN = mercatorY(north);
  const yS = mercatorY(south);
  const y = yN + ((row + 0.5) / rows) * (yS - yN);
  const lat = latFromMercatorY(y);
  return (north - lat) / (north - south);
}

/**
 * Retângulo da imagem, igual ao `fieldRectangle` do app: bounds são CENTROS
 * das células extremas e o anel transparente acrescenta `padSteps` passos.
 * (Precipitação: 1 passo; clima histórico: 1,5 = meia célula + o anel.)
 */
export function expandBounds({ bounds, width, height }, padSteps) {
  const stepLon = (bounds.east - bounds.west) / (width - 1);
  const stepLat = (bounds.north - bounds.south) / (height - 1);
  return {
    west: bounds.west - padSteps * stepLon,
    south: bounds.south - padSteps * stepLat,
    east: bounds.east + padSteps * stepLon,
    north: bounds.north + padSteps * stepLat,
  };
}

/** Cantos da fonte `image`: NO, NE, SE, SO. */
export function imageCoordinates({ west, south, east, north }) {
  return [[west, north], [east, north], [east, south], [west, south]];
}

/**
 * Grade Open-Meteo -> RGBA com anel transparente de uma célula. Linha 0 da
 * grade é o SUL (flipY false); a imagem cresce para baixo, daí `height-1-j`.
 * Mesmo desenho de buildFieldCanvas em src/data/datageoPrecipitacao.js.
 * @param {{precip: ArrayLike<number>, width: number, height: number}} grid
 */
export function precipPixels({ precip, width, height }) {
  const pad = 1;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const target = ((height - 1 - j + pad) * w + (i + pad)) * 4;
      const [r, g, b, a] = precipRgba(precip[j * width + i]);
      data[target] = r;
      data[target + 1] = g;
      data[target + 2] = b;
      data[target + 3] = a;
    }
  }
  return { data, w, h };
}

/**
 * RGBA pequeno -> data URL pronto para `updateImage`, ampliado `scale` vezes
 * (com ou sem suavização, como o app) e com as linhas em espaçamento Mercator.
 * @param {{data: Uint8ClampedArray, w: number, h: number}} pixels
 * @param {{scale: number, smooth: boolean, south: number, north: number}} opts
 */
export function gridImageUrl({ data, w, h }, { scale, smooth, south, north }) {
  const source = document.createElement('canvas');
  source.width = w;
  source.height = h;
  source.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);

  const scaled = document.createElement('canvas');
  scaled.width = w * scale;
  scaled.height = h * scale;
  const sctx = scaled.getContext('2d');
  sctx.imageSmoothingEnabled = smooth;
  if (smooth) sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(source, 0, 0, scaled.width, scaled.height);

  const out = document.createElement('canvas');
  out.width = scaled.width;
  out.height = scaled.height;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  for (let row = 0; row < out.height; row += 1) {
    const src = Math.min(scaled.height - 1, Math.max(0, Math.floor(mercatorRowSource(row, out.height, south, north) * scaled.height)));
    octx.drawImage(scaled, 0, src, scaled.width, 1, 0, row, out.width, 1);
  }
  return out.toDataURL('image/png');
}
