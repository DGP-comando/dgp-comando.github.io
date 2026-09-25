// src/data/datageoLogistica.js
//
// Conjunto "Logística agro": infraestrutura de escoamento e processamento
// da produção do PR, em GeoJSONs estáticos gerados por
// scripts/build_logistica.py (fontes já LGPD-clean do projeto
// valor-de-terras + Overpass/fallback):
//   - Armazéns CONAB (cadastro CDA 2023-11, ~2,4k pontos + porto de
//     Paranaguá, capacidade em t)
//   - Agroindústrias SIGSIF/MAPA (frigoríficos, laticínios) + serrarias OSM
//   - CEASAs (5 unidades da CEASA/PR)
//
// Todos são pontos ESTÁTICOS (contrato do earthquakes.js: nada de
// CallbackProperty por frame). Labels com distanceDisplayCondition para o
// painel não virar poluição na visão estadual.

import * as Cesium from 'cesium';
import { createCachedFactory } from './entityDiff.js';
import { createEntityHoverTooltip } from './entityHoverTooltip.js';
import { dgFetchData } from './datageoClient.js';
import {
  AGRO_LEGENDA, ARMAZEM_LEGENDA, CEASA_LEGENDA, IDR_GRUPOS, ROTA_LEGENDA,
  agroindustriaEstilo, agroindustriaIdrEstilo, agroindustriaIdrTooltipHtml, agroindustriaTooltipHtml,
  armazemEstilo, ceasaEstilo, rotaTuristicaEstilo, rotaTuristicaTooltipHtml,
} from './energiaLogisticaEstilos.js';

const CATEGORY = 'Logística agro';

/**
 * Cesium.Color a partir de CSS + alpha, memoizada. Milhares de pontos com a
 * mesma cor passam a compartilhar uma instancia (Cesium nao muta as cores das
 * graphics, entao compartilhar e seguro). Exportada para energia/conectividade.
 * @param {string} css Cor CSS (#rrggbb).
 * @param {number} [alpha=1]
 * @returns {Cesium.Color}
 */
export const cssColor = createCachedFactory(
  (css, alpha = 1) => Cesium.Color.fromCssColorString(css).withAlpha(alpha),
  (css, alpha = 1) => `${css}|${alpha}`,
);

// Valores imutaveis iguais para todos os pontos: uma instancia so.
const POINT_OUTLINE = Cesium.Color.BLACK.withAlpha(0.55);
const POINT_SCALE = new Cesium.NearFarScalar(80_000, 1.0, 1_400_000, 0.45);
const LABEL_FILL = cssColor('#e2e8f0');
const LABEL_OFFSET = new Cesium.Cartesian2(0, -14);
const labelCondition = createCachedFactory(
  (maxDist) => new Cesium.DistanceDisplayCondition(0, maxDist),
  (maxDist) => String(maxDist),
);

// Exportada: datageoEnergia.js reusa a mesma factory para as subestacoes.
// `tooltip(props)` opcional devolve o HTML (já escapado) do hover do ponto.
// `legend` opcional, [{ grupo, label, color }]: vira a legenda de cores na
// linha do painel; `styleFor` diz o `grupo` de cada ponto, e a contagem sai
// dos pontos carregados.
export function makePointsLayer({ id, name, category = CATEGORY, icon, source, url, styleFor, tooltip, tooltipWidth, legend }) {
  let _dataSource = null;
  let _tooltip = null;
  let _counts = {};
  let _onRowControls = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  return {
    id,
    name,
    category,
    icon,
    source,
    updateInterval: 24 * 3600_000,

    init() {
      console.log(`[Data:${id}] Initialized`);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      _tooltip?.hide();
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      try {
        if (!_dataSource) {
          const resp = await dgFetchData(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const gj = await resp.json();
          _dataSource = new Cesium.CustomDataSource(id);
          let n = 0;
          const counts = {};
          for (const f of gj.features ?? []) {
            const [lon, lat] = f.geometry?.coordinates ?? [];
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            const style = styleFor(f.properties ?? {});
            if (!style) continue;
            if (style.grupo) counts[style.grupo] = (counts[style.grupo] ?? 0) + 1;
            _dataSource.entities.add({
              id: tooltip ? `${id}:${n++}` : undefined,
              properties: tooltip ? f.properties : undefined,
              position: Cesium.Cartesian3.fromDegrees(lon, lat),
              point: {
                pixelSize: style.size,
                color: style.color,
                outlineColor: POINT_OUTLINE,
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: POINT_SCALE,
              },
              label: style.label
                ? {
                    text: style.label,
                    font: '11px "JetBrains Mono", monospace',
                    fillColor: LABEL_FILL,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: LABEL_OFFSET,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    distanceDisplayCondition: labelCondition(style.labelMaxDist),
                  }
                : undefined,
            });
          }
          _counts = counts;
          _onRowControls?.();
          _dataSource.show = _enabled;
          await viewer.dataSources.add(_dataSource);
          if (tooltip && typeof document !== 'undefined') {
            _tooltip = createEntityHoverTooltip({
              viewer,
              idPrefix: `${id}:`,
              render: tooltip,
              isActive: () => _enabled,
              maxWidth: tooltipWidth,
            });
          }
        }
        _count = _dataSource.entities.values.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:${id}] ${_count} pontos`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn(`[Data:${id}]`, err);
        return false;
      }
    },

    destroy(viewer) {
      _tooltip?.destroy();
      _tooltip = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },

    ...(legend && {
      setRowControlsListener(fn) {
        _onRowControls = fn;
      },
      getRowControls() {
        return {
          chips: [],
          legend: legend.map((g) => ({ label: g.label, color: g.color, count: _counts[g.grupo] ?? 0 })),
        };
      },
    }),
  };
}

// Estilo e tooltip de cada ponto moram em energiaLogisticaEstilos.js (sem
// Cesium, compartilhado com o protótipo MapLibre); aqui só a cor vira Cesium.
export { agroindustriaTooltipHtml, agroindustriaIdrTooltipHtml, rotaTuristicaTooltipHtml };

/** Adapta um `*Estilo` puro (cor CSS + alpha) ao `styleFor` de makePointsLayer. */
export const cesiumStyle = (estilo) => (p) => {
  const s = estilo(p);
  return s && { ...s, color: cssColor(s.color, s.alpha) };
};

export const datageoArmazensLayer = makePointsLayer({
  id: 'datageo-armazens',
  name: 'Armazéns (CONAB)',
  icon: '🌾',
  source: 'CONAB/CDA 2023',
  url: '/data/armazens-conab-pr.geojson',
  styleFor: cesiumStyle(armazemEstilo),
  legend: ARMAZEM_LEGENDA,
});

export const datageoAgroindustriasLayer = makePointsLayer({
  id: 'datageo-agroindustrias',
  name: 'Agroindústrias',
  icon: '🏭',
  source: 'SIGSIF/MAPA · OSM',
  url: '/privado/agroindustrias-pr.geojson',
  styleFor: cesiumStyle(agroindustriaEstilo),
  tooltip: agroindustriaTooltipHtml,
  legend: AGRO_LEGENDA,
});

export const datageoAgroindustriasIdrLayer = makePointsLayer({
  id: 'datageo-agroindustrias-idr',
  name: 'Agroindústrias (cadastro IDR)',
  icon: '🧺',
  source: 'IDR-Paraná 2023',
  url: '/privado/agroindustrias-idr-pr.geojson',
  styleFor: cesiumStyle(agroindustriaIdrEstilo),
  tooltip: agroindustriaIdrTooltipHtml,
  tooltipWidth: 720,
  legend: IDR_GRUPOS,
});

export const datageoRotasTuristicasLayer = makePointsLayer({
  id: 'datageo-rotas-turisticas',
  name: 'Rotas turísticas',
  icon: '🧀',
  source: 'Rota do Queijo · Rota da Uva e Vinho',
  url: '/data/rotas-turisticas-pr.geojson',
  styleFor: cesiumStyle(rotaTuristicaEstilo),
  tooltip: rotaTuristicaTooltipHtml,
  tooltipWidth: 420,
  legend: ROTA_LEGENDA,
});

export const datageoCeasasLayer = makePointsLayer({
  id: 'datageo-ceasas',
  name: 'CEASAs',
  icon: '🥬',
  source: 'CEASA/PR',
  url: '/data/ceasas-pr.geojson',
  styleFor: cesiumStyle(ceasaEstilo),
  legend: CEASA_LEGENDA,
});

export const DATAGEO_LOGISTICA_LAYERS = [
  datageoArmazensLayer,
  datageoAgroindustriasLayer,
  datageoAgroindustriasIdrLayer,
  datageoRotasTuristicasLayer,
  datageoCeasasLayer,
];
