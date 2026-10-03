// src/maplibre/layers/territorios.js
//
// Territórios em polígono (terras indígenas, quilombolas, assentamentos, UCs,
// regionais do IDR, associações de municípios) e divisas do CAR, portados do
// app Cesium (src/data/datageoTerritorios.js e src/data/datageoCar.js).
//
// Territórios: preenchimento translúcido + borda pelo anel externo + rótulo no
// centroide com o alcance do app (labelMaxDist -> minzoom). Especificação
// (cores, rótulos, tooltips tipCard) em src/data/territoriosSpec.js. O tooltip
// recebe o município sob o cursor e, nas regionais/associações, a soma dos
// indicadores municipais (municipios-info.json). O clique numa regional do IDR
// abre a ficha regional.
//
// CAR: as mesmas células estáticas (public/data/car) carregadas pela vista:
// com zoom >= teto (90 km de altura) as 9 mais próximas do centro; com um
// município em foco, as que cruzam o bbox dele (até 24), em qualquer zoom.
// Hover por uma linha invisível larga; o tooltip mostra a classe de módulos
// fiscais do trecho e o agregado do CAR (car-municipios.json) do município sob
// o cursor e do estado.

import { openFichaRegiao } from '../../datageoFicha.js';
import { fichaRegionalIdr, TERRITORIO_SPECS } from '../../data/territoriosSpec.js';
import { CAR_CLASSE_STYLES, CAR_MAX_HEIGHT, carTooltip } from '../../data/carClasses.js';
import { loadCarMunicipios } from '../../data/carMunicipios.js';
import { loadCadunicoRural } from '../../data/cadunicoRural.js';
import { defineLayer, EMPTY_FC, TEXT_FONT, zoomForHeight } from '../kit.js';
import { loadMunicipiosInfo, MUNICIPIOS_URL } from './municipios.js';
import {
  anelQueContem, buildTerritorioFeatures, cellFeatures, createCursorMunicipio, wantedCells,
} from './territoriosFeatures.js';

// Contexto dos tooltips: município sob o cursor (UCs, TIs, CAR) e, nas
// camadas que agregam municípios (regionais, associações), os indicadores de
// municipios-info.json e os nomes do GeoJSON dos municípios.
const cursor = createCursorMunicipio();

let nomesPromise = null;
/** {<CD_MUN>: NM_MUN} do GeoJSON dos municípios (o mesmo da camada-base, em cache). */
function loadNomesMunicipios() {
  nomesPromise ??= fetch(MUNICIPIOS_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((gj) => Object.fromEntries((gj?.features ?? []).map((f) => [String(f.properties?.CD_MUN), f.properties?.NM_MUN])))
    .catch(() => {
      nomesPromise = null;
      return null;
    });
  return nomesPromise;
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
  let info = null;
  let nomes = null;
  let cadunico = null; // {porChave, referencia} das famílias do CadÚnico (bucket privado)
  const interactive = Boolean(tooltipOf || onClick);

  return defineLayer({
    id,
    name: spec.name,
    category: spec.category ?? 'Territórios e povos',
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
      const [built, inf, nms, cad] = await Promise.all([
        loaded,
        spec.agregaMunicipios ? loadMunicipiosInfo() : null,
        spec.agregaMunicipios ? loadNomesMunicipios() : null,
        spec.cadunico ? loadCadunicoRural() : null,
      ]);
      cadunico = cad ? { porChave: cad[spec.cadunico.grupo] ?? {}, referencia: cad.referencia } : null;
      info = inf?.municipios ?? null;
      nomes = nms;
      props = built.props;
      ctx.setData(src.fill, built.fills);
      ctx.setData(src.border, built.borders);
      ctx.setData(src.label, built.labels);
      return built.count;
    },
    onEnable: (ctx) => cursor.attach(ctx.map),
    ...(tooltipOf
      ? {
        tooltip: (_p, feature) => {
          const p = props[feature.id];
          if (!p) return '';
          const cad = cadunico && cadunico.porChave[spec.cadunico.chave(p)];
          return tooltipOf(p, { municipio: cursor.get(), info, nomes, cadunico: cad, cadunicoRef: cadunico?.referencia });
        },
      }
      : {}),
    ...(onClick
      ? {
        click: (_p, feature) => {
          const p = props[feature.id];
          if (p) onClick(p);
        },
        // Como no app Cesium: a ficha do município abre e o card da camada fica por cima.
        clickWithUnderlay: true,
      }
      : {}),
  });
}

// ------------------------------------------------------------------ CAR

const CAR_MINZOOM = zoomForHeight(CAR_MAX_HEIGHT);
const CAR_BASE = '/data/car';
const CAR_SOURCE = 'dg-car';
const CAR_LAYER = 'dg-car-line';
// Divisa fina demais para o hover: linha invisível mais larga só para o pick.
const CAR_HIT = 'dg-car-hit';
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
      for (const lid of [CAR_LAYER, CAR_HIT]) {
        if (ctx.map.getLayer(lid)) ctx.map.setLayerZoomRange(lid, focus ? 0 : CAR_MINZOOM, 24);
      }
      onMove();
    },
    async count() {
      const ix = await loadIndex();
      await refresh();
      return ix.trechos;
    },
    /**
     * Imóvel do CAR que contém (lon, lat), carregando sob demanda a célula do
     * ponto e as vizinhas (o anel mora na célula do seu vértice central).
     */
    async imovelEm(lon, lat) {
      const ix = await loadIndex();
      const i = Math.floor(lat / ix.cell_deg);
      const j = Math.floor(lon / ix.cell_deg);
      const keys = [];
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) if (ix.cells[`${i + di}_${j + dj}`]) keys.push(`${i + di}_${j + dj}`);
      }
      await Promise.all(keys.map(loadCell));
      return anelQueContem(keys.flatMap((k) => cells.get(k)?.features ?? []), lon, lat);
    },
    stats() {
      let lines = 0;
      for (const c of cells.values()) lines += c.lines;
      return { cells: cells.size, lines };
    },
  };
}

const car = createCarLoader();
let carStatsAgg = null; // car-municipios.json: imóveis e área por classe (estado e município)

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
  category: 'Agricultura familiar e CAR',
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
    {
      id: CAR_HIT,
      type: 'line',
      source: CAR_SOURCE,
      minzoom: CAR_MINZOOM,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.01 },
    },
  ],
  interactive: [CAR_HIT],
  async load() {
    carStatsAgg = await loadCarMunicipios().catch(() => null);
    const total = await car.count();
    // O app mostra os trechos carregados; aqui o total do índice (a contagem
    // do painel não se atualiza a cada movimento).
    return { count: total, info: 'carrega pela vista (zoom ≥ 10 ou município em foco)' };
  },
  onEnable: (ctx) => {
    cursor.attach(ctx.map);
    car.enable(ctx);
  },
  onDisable: (ctx) => car.disable(ctx),
  focusOn: (bbox, ctx) => car.setFocus(bbox, ctx),
  tooltip: (p) => (p.classe ? carTooltip(p.classe, { stats: carStatsAgg, municipio: cursor.get() }) : ''),
});

export const carStats = () => car.stats();
/** Imóvel do CAR (menor anel) que contém o ponto, ou null. */
export const carImovelEm = (lon, lat) => car.imovelEm(lon, lat);

// ------------------------------------------------------------------ export

const S = TERRITORIO_SPECS;

export default [
  territorioLayer(S.terrasIndigenas),
  territorioLayer(S.quilombolas),
  territorioLayer(S.assentamentos),
  territorioLayer(S.faxinais),
  territorioLayer(S.ucsFederais),
  territorioLayer(S.ucsEstaduais),
  territorioLayer(S.regionaisIdr, { onClick: (p) => openFichaRegiao(fichaRegionalIdr(p)) }),
  territorioLayer(S.associacoes),
  carLayer,
];
