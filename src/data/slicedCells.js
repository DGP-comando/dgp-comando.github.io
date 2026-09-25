// src/data/slicedCells.js
//
// Formato das camadas de LINHAS FATIADAS (index.json + <i>_<j>.json, ver o
// cabeçalho de slicedLineLayer.js), sem dependência de engine de mapa: usado
// pela camada Cesium e pelo protótipo MapLibre (src/maplibre/).

/**
 * Chave "<i>_<j>" da célula que contém (lat, lon).
 * @param {number} lat
 * @param {number} lon
 * @param {number} cellDeg
 */
export function cellKey(lat, lon, cellDeg) {
  return `${Math.floor(lat / cellDeg)}_${Math.floor(lon / cellDeg)}`;
}

/**
 * Decodifica o payload de uma célula (delta encadeado, ver o cabeçalho) em
 * trechos com graus planos [lon0, lat0, lon1, lat1, ...], agrupados por
 * índice de grupo.
 * @param {{t: number[][][]}} payload
 * @param {string} key "<i>_<j>"
 * @param {{cell_deg: number, escala: number}} index
 * @returns {number[][][]}
 */
export function decodeCell(payload, key, index) {
  const [i, j] = key.split('_').map(Number);
  const { cell_deg: cellDeg, escala } = index;
  const originX = Math.round(j * cellDeg * escala);
  const originY = Math.round(i * cellDeg * escala);
  return (payload?.t ?? []).map((lines) => {
    let px = originX;
    let py = originY;
    const out = [];
    for (const enc of lines ?? []) {
      if (!Array.isArray(enc) || enc.length < 4 || enc.length % 2 !== 0) continue;
      const flat = new Array(enc.length);
      for (let n = 0; n < enc.length; n += 2) {
        px += enc[n];
        py += enc[n + 1];
        flat[n] = px / escala;
        flat[n + 1] = py / escala;
      }
      out.push(flat);
    }
    return out;
  });
}

/**
 * Células existentes mais próximas de (lat, lon), num raio de `rings` células.
 * @returns {string[]}
 */
export function nearestCells(lat, lon, index, limit = 9, rings = 2) {
  const cellDeg = index.cell_deg;
  const ci = Math.floor(lat / cellDeg);
  const cj = Math.floor(lon / cellDeg);
  const candidates = [];
  for (let di = -rings; di <= rings; di++) {
    for (let dj = -rings; dj <= rings; dj++) {
      const key = `${ci + di}_${cj + dj}`;
      if (!index.cells?.[key]) continue;
      const cLat = (ci + di + 0.5) * cellDeg;
      const cLon = (cj + dj + 0.5) * cellDeg;
      candidates.push({ key, d: (cLat - lat) ** 2 + (cLon - lon) ** 2 });
    }
  }
  return candidates.sort((a, b) => a.d - b.d).slice(0, limit).map((c) => c.key);
}
