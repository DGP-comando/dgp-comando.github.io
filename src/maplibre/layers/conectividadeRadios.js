// src/maplibre/layers/conectividadeRadios.js
//
// Conectividade (ERBs + área sem 3G+) e Rádios ao vivo no protótipo MapLibre.
// Especificação: src/data/datageoConectividade.js e src/data/datageoRadios.js.
//
// - Conectividade: a mancha ardósia da área sem cobertura, as 5,8 mil torres
//   coloridas pela geração mais alta (encolhendo com a distância, como o
//   NearFarScalar do app), legenda por geração e, no hover de uma torre, os
//   anéis de alcance NOMINAL de cada geração (torreCobertura.js).
// - Rádios: um ponto por município (tamanho pela raiz da contagem, verde se
//   algo toca, cinza se só no dial), tooltip com contato, e o clique abre o
//   MESMO player do app (src/data/radioPlayer.js, DOM puro) já tocando.

import { dgFetchData } from '../../data/datageoClient.js';
import { centroidByIbge } from '../../data/prCentroids.js';
import { isLive, placeTooltipHtml } from '../../data/radioContact.js';
import { GREEN, createPlayer, dotSize } from '../../data/radioPlayer.js';
import { aneisDeCobertura, chaveDeSite, torreTooltipHtml } from '../../data/torreCobertura.js';
import { EMPTY_FC, defineLayer, fc, point, zoomForHeight } from '../kit.js';

// ------------------------------------------------------------ conectividade

const TORRES_URL = '/data/conectividade-torres.json';
const COBERTURA_URL = '/data/conectividade-sem-cobertura.geojson';
const ANEL_PONTOS = 96;

/** Mesmas classes e cores do app (geração mais alta da torre). */
export const TEC_CLASSES = Object.freeze([
  Object.freeze({ key: '5G', bit: 8, label: '5G', color: '#a3e635' }),
  Object.freeze({ key: '4G', bit: 4, label: '4G', color: '#4ade80' }),
  Object.freeze({ key: '3G', bit: 2, label: '3G', color: '#15803d' }),
  Object.freeze({ key: '2G', bit: 1, label: '2G', color: '#71717a' }),
]);
const TEC_INDEFINIDA = Object.freeze({ key: 'na', label: 'SEM INFO', color: '#52525b' });
const TEC_COR = Object.freeze({ '5G': '#a3e635', '4G': '#4ade80', '3G': '#15803d', '2G': '#71717a' });

export function classeDaTorre(mask) {
  const bits = Number(mask) || 0;
  return TEC_CLASSES.find((k) => bits & k.bit) ?? TEC_INDEFINIDA;
}

export function conectividadeLegend(counts) {
  return [...TEC_CLASSES, TEC_INDEFINIDA]
    .filter((k) => (counts?.[k.key] || 0) > 0)
    .map((k) => ({ label: k.label, color: k.color, count: counts[k.key] }));
}

/**
 * conectividade-torres.json -> pontos GeoJSON (id = índice) + as propriedades
 * do tooltip por índice (arrays não sobrevivem ao queryRenderedFeatures).
 */
export function buildTorres(data, lookup = centroidByIbge) {
  const operadoras = data?.operadoras ?? [];
  const torres = data?.torres ?? [];
  const vintage = data?.geradoDe ?? null;
  const porSite = new Map();
  for (const [lat, lon, op] of torres) {
    const key = chaveDeSite(lat, lon);
    if (!porSite.has(key)) porSite.set(key, []);
    porSite.get(key).push(operadoras[op] ?? '—');
  }
  const counts = {};
  const props = [];
  const features = [];
  torres.forEach(([lat, lon, op, mask, ibge], i) => {
    const klass = classeDaTorre(mask);
    counts[klass.key] = (counts[klass.key] || 0) + 1;
    const operadora = operadoras[op] ?? '—';
    const vizinhas = [...new Set(porSite.get(chaveDeSite(lat, lon)))].filter((o) => o !== operadora);
    props[i] = { operadora, mask, lat, lon, vizinhas, vintage, municipio: lookup(ibge)?.name ?? '' };
    const f = point(lon, lat, { k: klass.key }, i);
    if (f) features.push(f);
  });
  return { fc: fc(features), props, counts, legend: conectividadeLegend(counts), vintage };
}

/** Linha do painel, como o getStats do app: área sem 3G+ e DATA do levantamento. */
export function conectividadeInfo(areaKm2, vintage) {
  const partes = [];
  if (areaKm2) partes.push(`${Math.round(areaKm2).toLocaleString('pt-BR')} km² sem 3G+`);
  if (vintage) partes.push(`levantamento ${vintage}`);
  return partes.join(' · ');
}

/** Círculo fechado de raio `km` (aproximação local plana, como no app). */
export function circuloGraus(lat, lon, km, pontos = ANEL_PONTOS) {
  const out = [];
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= pontos; i++) {
    const a = (i / pontos) * 2 * Math.PI;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

/** Anéis de alcance nominal da torre, do maior para o menor (o menor por cima). */
export function aneisFc(t) {
  if (!t) return EMPTY_FC;
  return fc(aneisDeCobertura(t.mask).map(({ tec, km }) => ({
    type: 'Feature',
    properties: { tec, km },
    geometry: { type: 'Polygon', coordinates: [circuloGraus(t.lat, t.lon, km)] },
  })));
}

// NearFarScalar(2e4 m -> 1,6; 1,2e6 m -> 0,45) sobre pixelSize 4 (diâmetro).
const Z_NEAR = zoomForHeight(2.0e4);
const Z_FAR = zoomForHeight(1.2e6);

const conectividade = (() => {
  let props = [];
  let legend = [];
  let hoveredIdx = null;
  let handlers = null;

  const showRings = (ctx, idx) => {
    if (idx === hoveredIdx) return;
    hoveredIdx = idx;
    ctx.setData('dg-conect-aneis', idx == null ? EMPTY_FC : aneisFc(props[idx]));
  };

  return defineLayer({
    id: 'datageo-conectividade',
    name: 'Conectividade',
    category: 'Infraestrutura',
    icon: '📡',
    source: 'IDR-PR · ANATEL',
    sources: {
      'dg-conect-cobertura': { type: 'geojson', data: EMPTY_FC },
      'dg-conect-aneis': { type: 'geojson', data: EMPTY_FC },
      'dg-conect-torres': { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      {
        // Vazio, não fenômeno: ardósia neutra translúcida, sem contorno (o
        // outline do polígono clamped nunca era desenhado no app).
        id: 'dg-conect-cobertura',
        type: 'fill',
        source: 'dg-conect-cobertura',
        paint: { 'fill-color': '#64748b', 'fill-opacity': 0.22 },
      },
      {
        id: 'dg-conect-aneis-fill',
        type: 'fill',
        source: 'dg-conect-aneis',
        paint: { 'fill-color': ['match', ['get', 'tec'], ...Object.entries(TEC_COR).flat(), '#71717a'], 'fill-opacity': 0.12 },
      },
      {
        id: 'dg-conect-aneis-line',
        type: 'line',
        source: 'dg-conect-aneis',
        paint: {
          'line-color': ['match', ['get', 'tec'], ...Object.entries(TEC_COR).flat(), '#71717a'],
          'line-opacity': 0.85,
          'line-width': 2,
        },
      },
      {
        id: 'dg-conect-torres',
        type: 'circle',
        source: 'dg-conect-torres',
        paint: {
          'circle-color': ['match', ['get', 'k'], ...[...TEC_CLASSES, TEC_INDEFINIDA].flatMap((k) => [k.key, k.color]), '#52525b'],
          'circle-opacity': 0.9,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], Z_FAR, 2 * 0.45, Z_NEAR, 2 * 1.6],
          'circle-stroke-width': 0,
        },
      },
    ],
    interactive: ['dg-conect-torres'],
    // Acervo estático: o app repole a cada 24 h.
    refreshMs: 24 * 3600_000,

    async load(ctx) {
      const [torresResp, cobResp] = await Promise.all([fetch(TORRES_URL), fetch(COBERTURA_URL)]);
      if (!torresResp.ok) throw new Error(`torres HTTP ${torresResp.status}`);
      if (!cobResp.ok) throw new Error(`cobertura HTTP ${cobResp.status}`);
      const [torres, cobertura] = await Promise.all([torresResp.json(), cobResp.json()]);
      const built = buildTorres(torres);
      props = built.props;
      legend = built.legend;
      ctx.setData('dg-conect-torres', built.fc);
      ctx.setData('dg-conect-cobertura', cobertura);
      return { count: torres.torres.length, info: conectividadeInfo(Number(cobertura.areaKm2) || null, built.vintage) };
    },

    onEnable(ctx) {
      // Anéis da torre sob o cursor (o tooltip vem do registro).
      handlers = {
        move: (e) => showRings(ctx, e.features?.[0]?.id ?? null),
        leave: () => showRings(ctx, null),
      };
      ctx.map.on('mousemove', 'dg-conect-torres', handlers.move);
      ctx.map.on('mouseleave', 'dg-conect-torres', handlers.leave);
    },

    onDisable(ctx) {
      if (handlers) {
        ctx.map.off('mousemove', 'dg-conect-torres', handlers.move);
        ctx.map.off('mouseleave', 'dg-conect-torres', handlers.leave);
        handlers = null;
      }
      showRings(ctx, null);
    },

    tooltip: (p, feature) => {
      const t = props[feature.id];
      return t ? `<div class="dgx-vt">${torreTooltipHtml(t)}</div>` : '';
    },

    rowControls: () => ({ chips: [], legend }),
  });
})();

// ------------------------------------------------------------------ rádios

const RADIOS_URL = '/privado/radios-pr.json';
const DIAL = '#94a3b8';

/** Um ponto por município com rádio, no centroide (como o app). */
export function radiosFc(places, lookup = centroidByIbge) {
  return fc(places.map((place) => {
    const c = lookup(place.ibge);
    if (!c) return null;
    return point(c.lon, c.lat, {
      ibge: String(place.ibge),
      size: dotSize(place.stations.length),
      live: place.stations.some(isLive),
    });
  }).filter(Boolean));
}

export const stationCount = (places) => places.reduce((sum, p) => sum + p.stations.length, 0);

const radios = (() => {
  let places = [];
  let player = null;
  let selected = null;
  let mapRef = null;

  const setSelected = (ibge) => {
    const map = mapRef;
    if (map?.getSource('dg-radios')) {
      if (selected) map.setFeatureState({ source: 'dg-radios', id: selected }, { selected: false });
      if (ibge) map.setFeatureState({ source: 'dg-radios', id: String(ibge) }, { selected: true });
    }
    selected = ibge ? String(ibge) : null;
  };

  const ensurePlayer = () => {
    player ??= createPlayer({ onSelectionChange: setSelected });
    return player;
  };

  const sel = ['boolean', ['feature-state', 'selected'], false];

  return defineLayer({
    id: 'datageo-radios',
    name: 'Rádios ao vivo',
    category: 'Infraestrutura',
    icon: '📻',
    source: 'Anatel · radio.garden · Radio Browser',
    sources: {
      'dg-radios': { type: 'geojson', data: EMPTY_FC, promoteId: 'ibge' },
    },
    layers: [
      {
        id: 'dg-radios-pt',
        type: 'circle',
        source: 'dg-radios',
        paint: {
          'circle-radius': ['/', ['get', 'size'], 2],
          'circle-color': ['case', sel, '#ffffff', ['get', 'live'], GREEN, DIAL],
          'circle-stroke-width': 4,
          'circle-stroke-color': ['case', sel, 'rgba(61,220,132,0.6)', ['get', 'live'], 'rgba(61,220,132,0.3)', 'rgba(148,163,184,0.3)'],
        },
      },
    ],
    interactive: ['dg-radios-pt'],
    refreshMs: 24 * 3600_000,

    async load(ctx) {
      mapRef = ctx.map;
      const resp = await dgFetchData(RADIOS_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      places = (await resp.json()).places ?? [];
      ensurePlayer().setPlaces(places);
      ctx.setData('dg-radios', radiosFc(places));
      if (selected) setSelected(selected);
      return stationCount(places);
    },

    onEnable(ctx) {
      mapRef = ctx.map;
      ensurePlayer();
    },

    onDisable() {
      player?.close(); // camada desligada não segue tocando
    },

    tooltip: (p) => {
      const place = places.find((pl) => String(pl.ibge) === String(p.ibge));
      return place ? `<div class="dgx-vt">${placeTooltipHtml(place)}</div>` : '';
    },

    click: (p) => {
      const place = places.find((pl) => String(pl.ibge) === String(p.ibge));
      if (place) ensurePlayer().openPlace(place.ibge);
    },
  });
})();

// Tooltip do protótipo: as classes vt-/rt- dos tooltips do app.
if (typeof document !== 'undefined' && !document.getElementById('dgx-vt-style')) {
  const style = document.createElement('style');
  style.id = 'dgx-vt-style';
  style.textContent = `
    #tooltip .dgx-vt { font: 11px/1.5 var(--font-mono, ui-monospace, monospace); color: #cbd5e1; white-space: normal; }
    #tooltip .dgx-vt .vt-nome { color: #22d3ee; font-weight: 700; letter-spacing: .04em; margin-bottom: 4px; }
    #tooltip .dgx-vt .vt-dim { color: #64748b; font-size: 10px; }
    #tooltip .dgx-vt .rt-st { margin-top: 6px; }
    #tooltip .dgx-vt .rt-st b { color: #e2e8f0; }
    #tooltip .dgx-vt .rt-tag, #tooltip .dgx-vt .rt-det { color: #94a3b8; font-size: 10px; }
    /* Player acima da barra LOCALIZAÇÃO/estilos do protótipo (bottom 42 px). */
    body #dg-radio { bottom: 116px; z-index: 120; }
  `;
  document.head.appendChild(style);
}

export default [conectividade, radios];
