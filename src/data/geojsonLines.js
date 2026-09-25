// src/data/geojsonLines.js
//
// Trechos desenháveis de um GeoJSON de linhas, sem Cesium: usado pela camada
// Rodovias do app (datageoRodovias.js, que o reexporta) e pelo protótipo
// MapLibre (src/maplibre/layers/transporte.js) para a mesma contagem.

/**
 * Trechos [lon, lat][] utilizaveis de um GeoJSON de linhas: LineString e
 * MultiLineString, com pelo menos dois vertices finitos e distintos.
 * @param {object} geojson
 * @returns {Array<Array<[number, number]>>}
 */
export function lineStringsFromGeojson(geojson) {
  const lines = [];
  for (const feature of geojson?.features ?? []) {
    const geom = feature?.geometry;
    if (!geom) continue;
    const parts = geom.type === 'LineString'
      ? [geom.coordinates]
      : geom.type === 'MultiLineString' ? geom.coordinates : [];
    for (const coords of parts ?? []) {
      if (isDrawableLine(coords)) lines.push(coords);
    }
  }
  return lines;
}

export function isDrawableLine(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const [lon0, lat0] = coords[0] ?? [];
  let distinct = false;
  for (const point of coords) {
    const [lon, lat] = point ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (lon !== lon0 || lat !== lat0) distinct = true;
  }
  return distinct;
}
