// src/maplibre/layers/monitoramento.js
//
// Grupo MONITORAMENTO do DataGeo PR no protótipo MapLibre: clima (INMET),
// rios (ANA), CEMADEN, IRTC, dengue, qualidade do ar, anomalias, incidentes,
// InfoHidro e navios (line-up APPA + AIS).
//
// Especificação: src/data/datageoLayers.js (app Cesium). As feições são
// montadas pelos builders puros de src/data/datageoMonitoramento.js (testados
// em monitoramento.test.mjs) a partir dos MESMOS fetchers de datageoClient.js.
//
// Equivalências com a fábrica createDatageoLayer do app:
// - refresh incremental por id estável: a fonte usa promoteId 'fid' e, a cada
//   poll, os ids que não estavam no poll anterior ganham feature-state
//   {novo: true} por 60 s (contorno ciano #22d3ee de 3 px), a partir do 2º
//   refresh e só nas camadas de PONTO (no app o destaque só mexe em
//   entity.point). O painel mostra "+N" como o countWithArrivals do app;
// - elipses/discos em metros (rios 9 km, IRTC 3-14 km): circle com raio em
//   `interpolate exponential 2` sobre o zoom, a partir do raio em pixels no
//   zoom 0 calculado na latitude do ponto, deitado no mapa (pitch 'map');
// - distanceDisplayCondition dos rótulos (LABEL_MAX_DISTANCE) -> minzoom via
//   zoomForHeight; rótulos se sobrepõem como no app (sem colisão);
// - navio: ícone SVG de vesselIcon.js tingido como billboard.color (multiplica
//   o branco do casco), em PIXELS acima de 12 km de câmera e em METROS abaixo
//   (LOA real, boca = LOA/6,5), girado pelo rumo em relação ao norte.

import {
  fetchClimateStations,
  fetchRiverStations,
  fetchCemadenAlerts,
  fetchIrtcScores,
  fetchDengueLatestWeek,
  fetchAirQuality,
  fetchAnomalies,
  fetchActiveIncidents,
  fetchInfohidroStations,
  fetchVessels,
  fetchPortLineup,
} from '../../data/datageoClient.js';
import { validLineup } from '../../data/portLineup.js';
import { SHIP_ICON_URI, VESSEL_METERS_MAX_DISTANCE } from '../../data/vesselIcon.js';
import { vesselTooltipHtml } from '../../data/vesselTooltip.js';
import { NEW_ARRIVAL_MS } from '../../data/newArrivalHighlight.js';
import {
  LABEL_MAX_DISTANCE,
  LINEUP_LABEL_MAX_DISTANCE,
  NEW_ARRIVAL_COLOR,
  SHIP_COLORS,
  SHIP_FAR_IMAGE_H,
  SHIP_NEAR_IMAGE_H,
  arrivals,
  buildAnomalias,
  buildAr,
  buildCemaden,
  buildClima,
  buildDengue,
  buildIncidentes,
  buildInfohidro,
  buildIrtc,
  buildMaritimo,
  buildRios,
} from '../../data/datageoMonitoramento.js';
import { EMPTY_FC, LABEL_PAINT, TEXT_FONT, defineLayer, fc, zoomForHeight } from '../kit.js';

const MAX_Z = 22;
const NOVO = ['boolean', ['feature-state', 'novo'], false];

/** Raio (px) de um disco em metros: `r0` é o raio no zoom 0 na latitude da feição. */
const metersRadius = (prop) => ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', prop], MAX_Z, ['*', ['get', prop], 2 ** MAX_Z]];

function labelLayer(key, source, maxDistance, extra = {}) {
  return {
    id: `dg-${key}-label`,
    type: 'symbol',
    source,
    minzoom: zoomForHeight(maxDistance),
    layout: {
      'text-field': ['get', 'label'],
      'text-font': TEXT_FONT,
      'text-size': 12,
      'text-offset': [0, -14 / 12],
      'text-allow-overlap': true,
      'text-max-width': 40,
      ...extra,
    },
    paint: { ...LABEL_PAINT, 'text-color': '#ffffff' },
  };
}

/**
 * Uma camada DataGeo = fetcher + builder puro (a fábrica createDatageoLayer do
 * app). `kind` 'point' desenha pontos em pixels (com destaque de chegada) e
 * 'disc' discos em metros.
 */
function datageoLayer({ key, id, name, category, icon, source, refreshMs, fetcher, build, kind = 'point' }) {
  const src = `dg-${key}`;
  const st = { prevIds: new Set(), refreshes: 0, newCount: 0, lastUpdate: 0, lit: [], timer: null };

  const clearHighlight = (map) => {
    clearTimeout(st.timer);
    st.timer = null;
    if (map.getSource(src)) for (const fid of st.lit) map.removeFeatureState({ source: src, id: fid }, 'novo');
    st.lit = [];
  };

  const circle =
    kind === 'disc'
      ? {
          id: `dg-${key}-disc`,
          type: 'circle',
          source: src,
          paint: {
            'circle-radius': metersRadius('r0'),
            'circle-color': ['get', 'color'],
            'circle-opacity': ['get', 'opacity'],
            'circle-stroke-color': ['get', 'stroke'],
            'circle-stroke-opacity': ['get', 'strokeOpacity'],
            'circle-stroke-width': ['get', 'strokeWidth'],
            'circle-pitch-scale': 'map',
            'circle-pitch-alignment': 'map',
          },
        }
      : {
          id: `dg-${key}-pt`,
          type: 'circle',
          source: src,
          paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['get', 'opacity'],
            'circle-stroke-color': ['case', NOVO, NEW_ARRIVAL_COLOR, ['get', 'stroke']],
            'circle-stroke-opacity': ['case', NOVO, 1, ['get', 'strokeOpacity']],
            'circle-stroke-width': ['case', NOVO, 3, ['get', 'strokeWidth']],
          },
        };

  return defineLayer({
    id,
    name,
    category,
    icon,
    source,
    defaultOn: false,
    sources: { [src]: { type: 'geojson', data: EMPTY_FC, promoteId: 'fid' } },
    layers: [circle, labelLayer(key, src, LABEL_MAX_DISTANCE[key])],
    refreshMs,
    async load(ctx) {
      const data = await fetcher();
      const { features, count } = build(data);
      st.refreshes += 1;
      const a = arrivals(st.prevIds, features, st.refreshes);
      clearHighlight(ctx.map);
      ctx.setData(src, fc(features));
      st.prevIds = a.ids;
      st.newCount = a.newIds.length;
      st.lastUpdate = Date.now();
      if (kind === 'point' && a.highlight) {
        st.lit = a.newIds;
        for (const fid of st.lit) ctx.map.setFeatureState({ source: src, id: fid }, { novo: true });
        st.timer = setTimeout(() => clearHighlight(ctx.map), NEW_ARRIVAL_MS);
      }
      // "+N" do countWithArrivals: não no refresh inicial.
      return { count, info: st.refreshes > 1 && st.newCount > 0 ? `+${st.newCount} novos` : '' };
    },
  });
}

// ------------------------------------------------------------------ camadas

const clima = datageoLayer({
  key: 'clima',
  id: 'datageo-clima',
  name: 'Estações de clima (INMET)',
  category: 'Clima',
  icon: '🌡️',
  source: 'INMET · DataGeo PR',
  refreshMs: 900_000,
  fetcher: fetchClimateStations,
  build: buildClima,
});

const rios = datageoLayer({
  key: 'rios',
  id: 'datageo-rios',
  name: 'Nível dos rios (ANA)',
  category: 'Hidrologia',
  icon: '🌊',
  source: 'ANA · DataGeo PR',
  refreshMs: 900_000,
  fetcher: fetchRiverStations,
  build: buildRios,
  kind: 'disc',
});

const cemaden = datageoLayer({
  key: 'cemaden',
  id: 'datageo-cemaden',
  name: 'Alertas de desastre (CEMADEN)',
  category: 'Hidrologia',
  icon: '⚠️',
  source: 'CEMADEN · DataGeo PR',
  refreshMs: 300_000,
  fetcher: fetchCemadenAlerts,
  build: buildCemaden,
});

const irtc = datageoLayer({
  key: 'irtc',
  id: 'datageo-irtc',
  name: 'Risco territorial (IRTC)',
  category: 'Riscos e alertas',
  icon: '🎯',
  source: 'IRTC · DataGeo PR',
  refreshMs: 1_800_000,
  fetcher: fetchIrtcScores,
  build: buildIrtc,
  kind: 'disc',
});

const dengue = datageoLayer({
  key: 'dengue',
  id: 'datageo-dengue',
  name: 'Dengue (InfoDengue)',
  category: 'Saúde e ar',
  icon: '🦟',
  source: 'InfoDengue · DataGeo PR',
  refreshMs: 3_600_000,
  fetcher: fetchDengueLatestWeek,
  build: buildDengue,
});

const ar = datageoLayer({
  key: 'ar',
  id: 'datageo-ar',
  name: 'Qualidade do ar',
  category: 'Saúde e ar',
  icon: '🌫️',
  source: 'AQICN · DataGeo PR',
  refreshMs: 1_800_000,
  fetcher: fetchAirQuality,
  build: buildAr,
});

const anomalias = datageoLayer({
  key: 'anomalias',
  id: 'datageo-anomalias',
  name: 'Anomalias estatísticas',
  category: 'Riscos e alertas',
  icon: '📈',
  source: 'DataGeo PR',
  refreshMs: 900_000,
  fetcher: fetchAnomalies,
  build: buildAnomalias,
});

const incidentes = datageoLayer({
  key: 'incidentes',
  id: 'datageo-incidentes',
  name: 'Incidentes ativos',
  category: 'Riscos e alertas',
  icon: '🚨',
  source: 'DataGeo PR',
  refreshMs: 300_000,
  fetcher: fetchActiveIncidents,
  build: buildIncidentes,
});

const infohidro = datageoLayer({
  key: 'infohidro',
  id: 'datageo-infohidro',
  name: 'Telemetria hídrica (InfoHidro)',
  category: 'Hidrologia',
  icon: '📡',
  source: 'SIMEPAR · DataGeo PR',
  refreshMs: 3_600_000,
  fetcher: fetchInfohidroStations,
  build: buildInfohidro,
});

// ------------------------------------------------------------------ marítimo

/** Mesmo fetcher combinado do app: line-up + AIS, erro só se as duas falharem. */
export async function fetchMaritimo() {
  const [lineup, ais] = await Promise.allSettled([fetchPortLineup(), fetchVessels()]);
  const payload = lineup.status === 'fulfilled' ? validLineup(lineup.value) : null;
  const vessels = ais.status === 'fulfilled' ? ais.value : [];
  if (!payload && vessels.length === 0) {
    if (lineup.status === 'rejected') throw lineup.reason;
    if (ais.status === 'rejected') throw ais.reason;
  }
  return { lineup: payload, vessels };
}

const SHIP_SWITCH_Z = zoomForHeight(VESSEL_METERS_MAX_DISTANCE);
const SHIP_PREFIX = 'dg-ship-';
const shipImageName = (variant, colorKey) => `${SHIP_PREFIX}${variant}-${colorKey}`;

// Imagens rasterizadas uma vez (ImageData), para poderem ser re-adicionadas de
// forma SÍNCRONA no 'styleimagemissing' depois de uma troca de mapa base.
let shipImages = null; // Map(nome -> {width, height, data})
let shipImagesPromise = null;
const PIXEL_RATIO = 2;

function loadShipImages() {
  shipImagesPromise ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('ícone de navio não carregou'));
    img.src = SHIP_ICON_URI;
  }).then((img) => {
    const out = new Map();
    for (const [variant, h] of [['far', SHIP_FAR_IMAGE_H], ['near', SHIP_NEAR_IMAGE_H]]) {
      const w = 40 * PIXEL_RATIO;
      const hh = h * PIXEL_RATIO;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hh;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, hh); // "near" estica para a proporção LOA/boca 6,5
      const base = g.getImageData(0, 0, w, hh);
      for (const color of Object.values(SHIP_COLORS)) {
        // billboard.color do Cesium: multiplica a textura pela cor.
        const data = new Uint8ClampedArray(base.data);
        const [r, gg, b] = color.rgb;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = (data[i] * r) / 255;
          data[i + 1] = (data[i + 1] * gg) / 255;
          data[i + 2] = (data[i + 2] * b) / 255;
          data[i + 3] *= color.alpha;
        }
        out.set(shipImageName(variant, color.key), { width: w, height: hh, data });
      }
    }
    shipImages = out;
    return out;
  });
  return shipImagesPromise;
}

function addShipImage(map, name) {
  const image = shipImages?.get(name);
  if (!image || map.hasImage(name)) return;
  map.addImage(name, image, { pixelRatio: PIXEL_RATIO });
}

const hookedMaps = new WeakSet();
function hookShipImages(map) {
  if (hookedMaps.has(map)) return;
  hookedMaps.add(map);
  map.on('styleimagemissing', (e) => {
    if (e.id?.startsWith(SHIP_PREFIX)) addShipImage(map, e.id);
  });
}

// Estilos do tooltip de navio (classes .vt-* de vesselTooltip.js), os mesmos
// do tooltip de entidade do app (entityHoverTooltip.js).
function injectVesselTooltipStyle() {
  if (typeof document === 'undefined' || document.getElementById('dg-vt-style')) return;
  const style = document.createElement('style');
  style.id = 'dg-vt-style';
  style.textContent = `
    #tooltip .vt { font: 11px/1.5 'JetBrains Mono', monospace; color: #cbd5e1; max-width: 340px; white-space: normal; }
    #tooltip .vt span { color: inherit; }
    #tooltip .vt .vt-nome { color: #22d3ee; font-weight: 700; letter-spacing: .08em; margin-bottom: 2px; }
    #tooltip .vt .vt-status { margin-bottom: 4px; }
    #tooltip .vt .vt-berco { color: #fbbf24; }
    #tooltip .vt .vt-fundeio { color: #94a3b8; }
    #tooltip .vt .vt-ais { color: #7dd3fc; }
    #tooltip .vt .vt-dim { color: #64748b; }
    #tooltip .vt .vt-fontes { margin-top: 6px; color: #475569; font-size: 9px; letter-spacing: .04em; }
  `;
  document.head.appendChild(style);
}

const SHIP_ICON_LAYOUT = {
  'icon-rotate': ['get', 'rotate'],
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'viewport',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
};

const maritimoState = { prevIds: new Set(), refreshes: 0 };

const maritimo = defineLayer({
  id: 'datageo-maritimo',
  name: 'Navios (Porto de Paranaguá)',
  category: 'Infraestrutura',
  icon: '🚢',
  source: 'APPA line-up · AISStream',
  defaultOn: false,
  sources: { 'dg-maritimo': { type: 'geojson', data: EMPTY_FC, promoteId: 'fid' } },
  layers: [
    {
      // Longe (> 12 km de câmera): tamanho em pixels (farIconPixels).
      id: 'dg-maritimo-far',
      type: 'symbol',
      source: 'dg-maritimo',
      maxzoom: SHIP_SWITCH_Z,
      layout: {
        ...SHIP_ICON_LAYOUT,
        'icon-image': ['concat', `${SHIP_PREFIX}far-`, ['get', 'shipImage']],
        'icon-size': ['get', 'farSize'],
      },
    },
    {
      // Perto: tamanho real em metros (LOA × boca estimada).
      id: 'dg-maritimo-near',
      type: 'symbol',
      source: 'dg-maritimo',
      minzoom: SHIP_SWITCH_Z,
      layout: {
        ...SHIP_ICON_LAYOUT,
        'icon-image': ['concat', `${SHIP_PREFIX}near-`, ['get', 'shipImage']],
        'icon-size': [
          'interpolate', ['exponential', 2], ['zoom'],
          SHIP_SWITCH_Z, ['*', ['get', 'nearSize0'], 2 ** SHIP_SWITCH_Z],
          MAX_Z, ['*', ['get', 'nearSize0'], 2 ** MAX_Z],
        ],
      },
    },
    {
      ...labelLayer('maritimo-ais', 'dg-maritimo', LABEL_MAX_DISTANCE.maritimo),
      filter: ['==', ['get', 'labelKind'], 'ais'],
    },
    {
      ...labelLayer('maritimo-lineup', 'dg-maritimo', LINEUP_LABEL_MAX_DISTANCE, {
        'text-size': 11,
        // labelAbove alterna o lado: -22 px (acima) ou +26 px (abaixo).
        'text-offset': ['case', ['<', ['get', 'labelDy'], 0], ['literal', [0, -22 / 11]], ['literal', [0, 26 / 11]]],
      }),
      filter: ['==', ['get', 'labelKind'], 'lineup'],
    },
  ],
  refreshMs: 600_000,
  async onEnable(ctx) {
    injectVesselTooltipStyle();
    hookShipImages(ctx.map);
    await loadShipImages();
    for (const name of shipImages.keys()) addShipImage(ctx.map, name);
  },
  async load(ctx) {
    const data = await fetchMaritimo();
    const { features, count } = buildMaritimo(data);
    maritimoState.refreshes += 1;
    const a = arrivals(maritimoState.prevIds, features, maritimoState.refreshes);
    ctx.setData('dg-maritimo', fc(features));
    maritimoState.prevIds = a.ids;
    return { count, info: a.highlight ? `+${a.newIds.length} novos` : '' };
  },
  interactive: ['dg-maritimo-far', 'dg-maritimo-near'],
  tooltip: (p) => {
    const html = vesselTooltipHtml(p);
    return html ? `<div class="vt">${html}</div>` : '';
  },
});

export default [clima, rios, cemaden, irtc, dengue, ar, anomalias, incidentes, infohidro, maritimo];
