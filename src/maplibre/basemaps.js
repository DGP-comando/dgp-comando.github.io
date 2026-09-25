// src/maplibre/basemaps.js
//
// Mapas base do protótipo MapLibre. Os mesmos do seletor do app Cesium
// (Esri Satellite com os rótulos Boundaries and Places por cima, e OSM raster),
// mais o OSM vetorial do OpenFreeMap, que não pede chave e desenha rótulos
// nítidos em qualquer zoom.

const ESRI_IMAGERY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_CREDIT = 'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

// As fontes do OpenFreeMap servem também os rótulos das camadas DataGeo nos
// mapas base raster, que não trazem glyphs próprios.
export const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const TEXT_FONT = ['Noto Sans Regular'];
export const TEXT_FONT_BOLD = ['Noto Sans Bold'];

export const BASEMAPS = [
  { id: 'esri', label: 'Satélite', hint: 'Esri World Imagery' },
  { id: 'osm', label: 'OSM', hint: 'OpenStreetMap raster' },
  { id: 'osm-vector', label: 'OSM vetorial', hint: 'OpenFreeMap (vetorial)' },
];

function rasterStyle(sources, layers) {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources,
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#05080d' } }, ...layers],
  };
}

/**
 * Estilo completo do mapa base, sem as camadas DataGeo (que o protótipo
 * transplanta de um estilo para o outro na troca). O OSM vetorial volta como
 * URL: o próprio MapLibre baixa o estilo do OpenFreeMap.
 * @param {string} id
 * @param {{esriLabels?: boolean}} [opts]
 * @returns {object|string}
 */
export function buildBaseStyle(id, { esriLabels = true } = {}) {
  if (id === 'osm-vector') return OPENFREEMAP_STYLE;
  if (id === 'osm') {
    return rasterStyle(
      {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: OSM_CREDIT,
        },
      },
      [{ id: 'base-osm', type: 'raster', source: 'osm' }],
    );
  }
  return rasterStyle(
    {
      esri: { type: 'raster', tiles: [ESRI_IMAGERY_URL], tileSize: 256, maxzoom: 19, attribution: ESRI_CREDIT },
      'esri-labels': { type: 'raster', tiles: [ESRI_LABELS_URL], tileSize: 256, maxzoom: 19 },
    },
    [
      { id: 'base-esri', type: 'raster', source: 'esri' },
      {
        id: 'base-esri-labels',
        type: 'raster',
        source: 'esri-labels',
        layout: { visibility: esriLabels ? 'visible' : 'none' },
      },
    ],
  );
}
