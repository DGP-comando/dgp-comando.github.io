// src/maplibre/layers/territorios.js
//
// Territórios em polígono (terras indígenas, quilombolas, assentamentos, UCs,
// regionais do IDR, associações de municípios) e divisas do CAR, portados do
// app Cesium (src/data/datageoTerritorios.js e src/data/datageoCar.js).
//
// Territórios: preenchimento translúcido + borda pelo anel externo + rótulo no
// centroide com o alcance do app (labelMaxDist -> minzoom). Especificação
// (cores, rótulos, tooltips) em src/data/territoriosSpec.js, compartilhada com
// o app. O clique numa regional do IDR abre a ficha regional.
//
// CAR: as mesmas células estáticas (public/data/car) carregadas pela vista:
// com zoom >= teto (90 km de altura) as 9 mais próximas do centro; com um
// município em foco, as que cruzam o bbox dele (até 24), em qualquer zoom.

import { openFichaRegiao } from '../../datageoFicha.js';
import { fichaRegionalIdr, TERRITORIO_SPECS } from '../../data/territoriosSpec.js';
import { CAR_CLASSE_STYLES, CAR_MAX_HEIGHT } from '../../data/carClasses.js';
import { defineLayer, EMPTY_FC, TEXT_FONT, zoomForHeight } from '../kit.js';
import { buildTerritorioFeatures, cellFeatures, wantedCells } from './territoriosFeatures.js';

// Classes .vt-* do tooltip do app (entityHoverTooltip.js), no #tooltip do protótipo.
const VT_STYLE_ID = 'dg-vt-tooltip-style';
function injectTooltipStyles() {
  if (typeof document === 'undefined' || document.getElementById(VT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VT_STYLE_ID;
  style.textContent = `
    #tooltip .vt { font: 11px/1.5 var(--font-mono, 'JetBrains Mono', monospace); color: #cbd5e1; white-space: normal; }
    #tooltip .vt .vt-nome { color: #22d3ee; font-weight: 700; letter-spacing: .08em; margin-bottom: 2px; }
    #tooltip .vt .vt-dim { color: #64748b; }
    #tooltip .vt .vt-fontes { margin-top: 6px; color: #475569; font-size: 9px; letter-spacing: .04em; }
  `;
  document.head.appendChild(style);
}

const hexAlpha = (hex, alpha) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
};

function territorioLayer(spec, { onClick = null } = {}) {
  const { id, cssColor, labelOf, labelMaxDist, tooltipOf } = spec;
  const fillAlpha = spec.fillAlpha ?? 0.25;
  const key = id.replace(/^datageo-/, '');
  const src = { fill: `dg-${key}`, border: `dg-${key}-borda`, label: `dg-${key}-rotulo` };
  const lid = { fill: `dg-${key}-fill`, border: `dg-${key}-line`, label: `dg-${key}-label` };
  let props = [];
  let loaded = null;
  const interactive = Boolean(tooltipOf || onClick);

  return defineLayer({
    id,
    name: spec.name,
    category: spec.category ?? 'Limites',
    icon: spec.icon,
    source: spec.source,
    sources: {
      [src.fill]: { type: 'geojson', data: EMPTY_FC },
      [src.border]: { type: 'geojson', data: EMPTY_FC },
      [src.label]: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      {
        id: lid.fill,
        type: 'fill',
        source: src.fill,
        paint: { 'fill-color': hexAlpha(cssColor, fillAlpha) },
      },
      {
        id: lid.border,
        type: 'line',
        source: src.border,
        layout: { 'line-join': 'round' },
        paint: { 'line-color': hexAlpha(cssColor, 0.75), 'line-width': 1.6 },
      },
      {
        // Rótulo no centroide, até a distância do app (distanceDisplayCondition).
        // Sem declutter, como os labels do Cesium.
        id: lid.label,
        type: 'symbol',
        source: src.label,
        minzoom: zoomForHeight(labelMaxDist),
        layout: {
          'text-field': ['get', 'label'],
          'text-font': TEXT_FONT,
          'text-size': 11,
          'text-max-width': 60, // linha única, como o label do Cesium
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': cssColor, 'text-halo-color': '#000000', 'text-halo-width': 1.5 },
      },
    ],
    interactive: interactive ? [lid.fill] : [],
    async load(ctx) {
      loaded ??= (async () => {
        const resp = await fetch(spec.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return buildTerritorioFeatures(await resp.json(), labelOf);
      })().catch((err) => {
        loaded = null;
        throw err;
      });
      const built = await loaded;
      props = built.props;
      ctx.setData(src.fill, built.fills);
      ctx.setData(src.border, built.borders);
      ctx.setData(src.label, built.labels);
      return built.count;
    },
    ...(tooltipOf
      ? {
        tooltip: (_p, feature) => {
          const p = props[feature.id];
          if (!p) return '';
          injectTooltipStyles();
          return `<div class="vt">${tooltipOf(p)}</div>`;
        },
      }
      : {}),
    ...(onClick
      ? {
        click: (_p, feature) => {
          const p = props[feature.id];
          if (p) onClick(p);
        },
      }
      : {}),
  });
}

// ------------------------------------------------------------------ CAR

const CAR_MINZOOM = zoomForHeight(CAR_MAX_HEIGHT);
const CAR_BASE = '/data/car';
const CAR_SOURCE = 'dg-car';
const CAR_LAYER = 'dg-car-line';
const CAR_PER_VIEW = 9; // maxCellsPerView do app
const CAR_MAX_LOADED = 24; // maxLoadedCells do app
const CAR_CLASSES = Object.keys(CAR_CLASSE_STYLES);

function createCarLoader() {
  let map = null;
  let ctxRef = null;
  let index = null;
  let indexPromise = null;
  let enabled = false;
  let focus = null;
  const cells = new Map(); // key -> {features, lines, lastSeen}
  const inflight = new Map(); // key -> Promise

  const loadIndex = () => {
    indexPromise ??= fetch(`${CAR_BASE}/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`index.json HTTP ${r.status}`);
        return r.json();
      })
      .then((ix) => {
        if (!ix?.cells || !ix.cell_deg || !ix.escala || !Array.isArray(ix.classes)) {
          throw new Error('index.json do CAR sem cells/cell_deg/escala/classes');
        }
        index = ix;
        return ix;
      })
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
    return indexPromise;
  };

  const loadCell = (key) => {
    if (cells.has(key)) return Promise.resolve();
    if (!inflight.has(key)) {
      inflight.set(key, fetch(`${CAR_BASE}/${key}.json`)
        .then((r) => {
          if (!r.ok) throw new Error(`célula ${key} HTTP ${r.status}`);
          return r.json();
        })
        .then((payload) => {
          const { features, lines } = cellFeatures(payload, key, index);
          cells.set(key, { features, lines, lastSeen: Date.now() });
        })
        .catch((err) => console.warn('[maplibre:datageo-car]', err))
        .finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  };

  const push = () => {
    const features = [];
    for (const cell of cells.values()) features.push(...cell.features);
    ctxRef?.setData(CAR_SOURCE, { type: 'FeatureCollection', features });
  };

  const focusActive = () => {
    if (!focus || !map) return false;
    const { lng, lat } = map.getCenter();
    const [w, s, e, n] = focus;
    return lng >= w && lng <= e && lat >= s && lat <= n;
  };

  async function refresh() {
    if (!enabled || !map) return;
    const emFoco = focusActive();
    if (!emFoco && map.getZoom() < CAR_MINZOOM) return;
    const ix = await loadIndex();
    const { lng, lat } = map.getCenter();
    const keys = wantedCells({ lat, lon: lng }, ix, {
      focus: emFoco ? focus : null,
      perView: CAR_PER_VIEW,
      focusCap: CAR_MAX_LOADED,
    });
    const now = Date.now();
    for (const k of keys) {
      const c = cells.get(k);
      if (c) c.lastSeen = now;
    }
    const missing = keys.filter((k) => !cells.has(k));
    await Promise.all(missing.map(loadCell));
    for (const k of keys) {
      const c = cells.get(k);
      if (c) c.lastSeen = now;
    }
    // Acima do teto de memória, sai a célula mais antiga fora da vista.
    const keep = new Set(keys);
    const limit = Math.max(CAR_MAX_LOADED, keys.length);
    const antigas = [...cells.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [k] of antigas) {
      if (cells.size <= limit) break;
      cells.delete(k);
    }
    if (enabled && (missing.length || antigas.length)) push();
  }

  const onMove = () => {
    refresh().catch((err) => console.warn('[maplibre:datageo-car]', err));
  };

  return {
    enable(ctx) {
      ctxRef = ctx;
      map = ctx.map;
      enabled = true;
      focus = ctx.focus ?? null;
      map.off('moveend', onMove);
      map.on('moveend', onMove);
      onMove();
    },
    disable(ctx) {
      enabled = false;
      ctx.map.off('moveend', onMove);
    },
    setFocus(bbox, ctx) {
      focus = bbox ?? null;
      if (ctx.map.getLayer(CAR_LAYER)) ctx.map.setLayerZoomRange(CAR_LAYER, focus ? 0 : CAR_MINZOOM, 24);
      onMove();
    },
    async count() {
      const ix = await loadIndex();
      await refresh();
      return ix.trechos;
    },
    stats() {
      let lines = 0;
      for (const c of cells.values()) lines += c.lines;
      return { cells: cells.size, lines };
    },
  };
}

const car = createCarLoader();

const carColor = ['match', ['get', 'classe']];
const carWidth = ['match', ['get', 'classe']];
for (const classe of CAR_CLASSES) {
  const { css, alpha, width } = CAR_CLASSE_STYLES[classe];
  carColor.push(classe, hexAlpha(css, alpha));
  carWidth.push(classe, width);
}
carColor.push('rgba(255,255,255,0.6)');
carWidth.push(1);

export const carLayer = defineLayer({
  id: 'datageo-car',
  name: 'CAR · imóveis ativos',
  category: 'Território',
  icon: '🌱',
  source: 'SICAR/SFB',
  sources: { [CAR_SOURCE]: { type: 'geojson', data: EMPTY_FC, tolerance: 0.2 } },
  layers: [
    {
      id: CAR_LAYER,
      type: 'line',
      source: CAR_SOURCE,
      minzoom: CAR_MINZOOM,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': carColor, 'line-width': carWidth },
    },
  ],
  async load() {
    const total = await car.count();
    // O app mostra os trechos carregados; aqui o total do índice (a contagem
    // do painel não se atualiza a cada movimento).
    return { count: total, info: 'carrega pela vista (zoom ≥ 10 ou município em foco)' };
  },
  onEnable: (ctx) => car.enable(ctx),
  onDisable: (ctx) => car.disable(ctx),
  focusOn: (bbox, ctx) => car.setFocus(bbox, ctx),
});

export const carStats = () => car.stats();

// ------------------------------------------------------------------ export

const S = TERRITORIO_SPECS;

export default [
  territorioLayer(S.terrasIndigenas),
  territorioLayer(S.quilombolas),
  territorioLayer(S.assentamentos),
  territorioLayer(S.ucsFederais),
  territorioLayer(S.ucsEstaduais),
  territorioLayer(S.regionaisIdr, { onClick: (p) => openFichaRegiao(fichaRegionalIdr(p)) }),
  territorioLayer(S.associacoes),
  carLayer,
];
