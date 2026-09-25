// src/data/estradasConveniadasTooltip.js
//
// Parte pura da camada Estradas Rurais Conveniadas (datageoEstradasConveniadas.js):
// os três conjuntos (cor, largura, ordem), as partes desenháveis de uma feição
// e o HTML do tooltip. Sem Cesium, para ser usada também pelo protótipo
// MapLibre (src/maplibre/layers/transporte.js).

import { escapeHtml } from './vesselTooltip.js';

const DESCRICAO_MAX = 280;

export const GRUPOS = Object.freeze([
  Object.freeze({ id: 'conveniadas', label: 'Conveniadas 2026', css: '#ff4d6d', alpha: 0.95, width: 4, z: 3 }),
  Object.freeze({ id: 'protocolos', label: 'Protocolos 2025', css: '#c084fc', alpha: 1, width: 3, z: 2 }),
  Object.freeze({ id: 'automatizado', label: 'Automatizado 2025', css: '#94a3b8', alpha: 0.75, width: 2, z: 1 }),
]);
export const GRUPO_BY_ID = new Map(GRUPOS.map((g) => [g.id, g]));

/** Partes [lon, lat][] desenháveis de uma feição de linha. */
export function partesDe(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/** HTML do tooltip: título, linha de contexto e o resto dos campos. */
export function tooltipHtml(props) {
  const grupo = GRUPO_BY_ID.get(props?.grupo);
  if (!grupo) return '';
  const { grupo: _g, Trecho: trecho, 'Município': mun, Tipo: tipo, ...resto } = props;
  const contexto = [grupo.label, mun, tipo].filter(Boolean).map(escapeHtml).join(' · ');
  const linhas = Object.entries(resto).map(([k, v]) => {
    let texto = String(v);
    if (k === 'Descrição' && texto.length > DESCRICAO_MAX) texto = `${texto.slice(0, DESCRICAO_MAX)}…`;
    return `<div><span class="vt-dim">${escapeHtml(k)}:</span> ${escapeHtml(texto)}</div>`;
  }).join('');
  return `<div class="vt-nome" style="color:${grupo.css}">${escapeHtml(trecho || 'Trecho sem nome')}</div>`
    + `<div class="vt-status">${contexto}</div>${linhas}`;
}
