// src/maplibre/layers/municipios.js
//
// Municípios do PR no protótipo: os 399 polígonos com divisa ciano brilhante,
// hover que destaca e mostra prefeito/VBP/cadeia (o mesmo tooltip do app),
// clique que abre a ficha municipal (src/datageoFicha.js, reaproveitada como
// está) e destaque do município selecionado.

import { openFicha } from '../../datageoFicha.js';
import { municipioTooltipHtml } from '../../data/municipioTooltip.js';
import { defineLayer, LABEL_PAINT, TEXT_FONT } from '../kit.js';

export const MUNICIPIOS_URL = '/data/municipios-pr.geojson';
const INFO_URL = '/data/municipios-info.json';

let infoPromise = null;
/** municipios-info.json (prefeito, VBP, cadeia), carregado uma vez. */
export function loadMunicipiosInfo() {
  infoPromise ??= fetch(INFO_URL)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => {
      infoPromise = null;
      return null;
    });
  return infoPromise;
}
let infoCache = null;
loadMunicipiosInfo().then((info) => {
  infoCache = info;
});

export async function openMunicipioFicha(ibge, nome) {
  const info = await loadMunicipiosInfo();
  return openFicha({ ibge: String(ibge), nome, info: info?.municipios?.[String(ibge)] });
}

const CYAN = '#22e6f0';

export const municipiosLayer = defineLayer({
  id: 'datageo-municipios',
  name: 'Municípios do Paraná',
  category: 'Limites',
  icon: '🏛️',
  source: 'TSE · IBGE/PAM · DataGeo PR',
  defaultOn: true,
  sources: {
    'dg-municipios': { type: 'geojson', data: MUNICIPIOS_URL, promoteId: 'CD_MUN' },
  },
  layers: [
    {
      id: 'dg-municipios-fill',
      type: 'fill',
      source: 'dg-municipios',
      paint: {
        'fill-color': '#00d4ff',
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 0.2,
          ['boolean', ['feature-state', 'hover'], false], 0.22,
          0.03,
        ],
      },
    },
    {
      // Brilho sob a divisa, no lugar do bloom do app Cesium.
      id: 'dg-municipios-glow',
      type: 'line',
      source: 'dg-municipios',
      paint: {
        'line-color': CYAN,
        'line-opacity': 0.3,
        'line-blur': 3,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 10, 6],
      },
    },
    {
      id: 'dg-municipios-line',
      type: 'line',
      source: 'dg-municipios',
      paint: {
        'line-color': CYAN,
        'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 1.4, 14, 2],
      },
    },
    {
      // Divisa do município selecionado, mais grossa e branca por cima.
      id: 'dg-municipios-selected',
      type: 'line',
      source: 'dg-municipios',
      paint: {
        'line-color': '#ffffff',
        'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 0],
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.95, 0],
      },
    },
    {
      id: 'dg-municipios-label',
      type: 'symbol',
      source: 'dg-municipios',
      minzoom: 7.5,
      layout: { 'text-field': ['get', 'NM_MUN'], 'text-font': TEXT_FONT, 'text-size': 11 },
      paint: LABEL_PAINT,
    },
  ],
  interactive: ['dg-municipios-fill'],
  hoverState: 'dg-municipios',
  count: async () => 399,
  tooltip: (p) => `<div class="mt">${municipioTooltipHtml(p.NM_MUN, infoCache?.municipios?.[String(p.CD_MUN)])}</div>`,
  click: (p) => {
    openMunicipioFicha(p.CD_MUN, p.NM_MUN);
  },
});
