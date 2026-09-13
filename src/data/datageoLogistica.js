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
export function makePointsLayer({ id, name, category = CATEGORY, icon, source, url, styleFor }) {
  let _dataSource = null;
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
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      try {
        if (!_dataSource) {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const gj = await resp.json();
          _dataSource = new Cesium.CustomDataSource(id);
          for (const f of gj.features ?? []) {
            const [lon, lat] = f.geometry?.coordinates ?? [];
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            const style = styleFor(f.properties ?? {});
            if (!style) continue;
            _dataSource.entities.add({
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
          _dataSource.show = _enabled;
          await viewer.dataSources.add(_dataSource);
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
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

const fmtCap = (t) => {
  if (!t) return '';
  if (t >= 1000) return ` · ${Math.round(t / 1000)} mil t`;
  return ` · ${t} t`;
};

export const datageoArmazensLayer = makePointsLayer({
  id: 'datageo-armazens',
  name: 'Armazéns (CONAB)',
  icon: '🌾',
  source: 'CONAB/CDA 2023',
  url: '/data/armazens-conab-pr.geojson',
  styleFor: (p) => {
    if (p.kind === 'porto') {
      return {
        size: 12,
        color: cssColor('#f97316'),
        label: p.nome,
        labelMaxDist: 2_000_000,
      };
    }
    const cap = Number(p.cap_t) || 0;
    return {
      // Capacidade dita o tamanho: silos grandes saltam na visão regional.
      size: cap >= 50_000 ? 7 : cap >= 10_000 ? 5 : 3.5,
      color: cssColor('#fbbf24', 0.85),
      label: `${p.nome}${fmtCap(cap)}`,
      labelMaxDist: 45_000,
    };
  },
});

const AGRO_STYLE = {
  frigorifico: { color: '#ef4444', size: 8, rotulo: 'Frigorífico' },
  laticinio: { color: '#bfdbfe', size: 5.5, rotulo: 'Laticínio' },
  serraria: { color: '#b45309', size: 5.5, rotulo: 'Serraria' },
};

export const datageoAgroindustriasLayer = makePointsLayer({
  id: 'datageo-agroindustrias',
  name: 'Agroindústrias',
  icon: '🏭',
  source: 'SIGSIF/MAPA · OSM',
  url: '/data/agroindustrias-pr.geojson',
  styleFor: (p) => {
    const s = AGRO_STYLE[p.kind];
    if (!s) return null;
    return {
      size: s.size,
      color: cssColor(s.color, 0.9),
      label: `${s.rotulo}: ${p.nome}`,
      labelMaxDist: 120_000,
    };
  },
});

export const datageoCeasasLayer = makePointsLayer({
  id: 'datageo-ceasas',
  name: 'CEASAs',
  icon: '🥬',
  source: 'CEASA/PR',
  url: '/data/ceasas-pr.geojson',
  styleFor: (p) => ({
    size: 11,
    color: cssColor('#22c55e'),
    label: p.nome,
    // So 5 unidades: label sempre visivel na visao estadual.
    labelMaxDist: 2_500_000,
  }),
});

export const DATAGEO_LOGISTICA_LAYERS = [
  datageoArmazensLayer,
  datageoAgroindustriasLayer,
  datageoCeasasLayer,
];
