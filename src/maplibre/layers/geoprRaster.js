// src/maplibre/layers/geoprRaster.js
//
// Camadas de imagem do GeoPR (IAT): cache de tiles onde o serviço tem, e
// MapServer/export (com filtro `where` opcional) onde não tem. Usado pela aba
// Aspectos físicos (aspectosFisicos.js) e pelas ottobacias (ottobacias.js).

import { BASE } from './iatPontos.js';

const FONTE_IAT = 'IAT/GeoPR';

export const tileCache = (servico) => `${BASE}/${servico}/MapServer/tile/{z}/{y}/{x}`;
// `where` (SQL do ArcGIS) filtra a camada 0 no servidor (layerDefs). O JSON vai
// codificado: as chaves dele não se confundem com o {bbox-epsg-3857} do MapLibre.
// `simbolo` (símbolo esri) troca o desenho padrão do serviço por um renderizador
// simples na camada 0 (dynamicLayers), ex.: só o contorno de polígonos.
export const tileExport = (servico, where = null, simbolo = null) => `${BASE}/${servico}/MapServer/export?bbox={bbox-epsg-3857}` +
  '&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image' +
  (simbolo
    ? `&dynamicLayers=${encodeURIComponent(JSON.stringify([{
      id: 0,
      source: { type: 'mapLayer', mapLayerId: 0 },
      ...(where ? { definitionExpression: where } : {}),
      drawingInfo: { renderer: { type: 'simple', symbol: simbolo } },
    }]))}`
    : `&layers=show:0${where ? `&layerDefs=${encodeURIComponent(JSON.stringify({ 0: where }))}` : ''}`);

/** Símbolo esri de polígono só com contorno (sem preenchimento). */
export const contornoEsri = ([r, g, b, a = 220], width = 0.8) => ({
  type: 'esriSFS', style: 'esriSFSNull',
  outline: { type: 'esriSLS', style: 'esriSLSSolid', color: [r, g, b, a], width },
});

/**
 * Camada só de imagem do GeoPR: fontes [{servico, cache, minzoom, maxzoom, simbolo, opacity}]
 * empilhadas. `cache` é o último nível do cache de tiles do serviço (o maxScale
 * dele): acima disso o GeoPR devolve 404, então a fonte para ali e o MapLibre
 * amplia o último tile. Sem `cache`, MapServer/export (sem teto, mais lento).
 */
export function geoprSpec({ id, sufixo, fontes, opacity = 1, legend = null, ...rest }) {
  const src = (i) => `dg-${sufixo}${i ? `-${i}` : ''}`;
  return {
    id,
    ...rest,
    sources: Object.fromEntries(fontes.map((f, i) => [src(i), {
      type: 'raster',
      tiles: [f.cache ? tileCache(f.servico) : tileExport(f.servico, null, f.simbolo ?? null)],
      tileSize: f.cache ? 256 : 512,
      maxzoom: f.cache ?? 22,
      ...(i === 0 ? { attribution: FONTE_IAT } : {}),
    }])),
    layers: fontes.map((f, i) => ({
      id: `${src(i)}-img`,
      type: 'raster',
      source: src(i),
      ...(f.minzoom ? { minzoom: f.minzoom } : {}),
      ...(f.maxzoom ? { maxzoom: f.maxzoom } : {}),
      paint: { 'raster-opacity': f.opacity ?? opacity, 'raster-fade-duration': 0 },
    })),
    ...(legend ? { rowControls: () => ({ legend }) } : {}),
  };
}

