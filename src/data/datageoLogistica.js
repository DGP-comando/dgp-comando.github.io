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
import { escapeHtml } from './vesselTooltip.js';
import { dgFetchData } from './datageoClient.js';

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
        grupo: 'porto',
        size: 12,
        color: cssColor('#f97316'),
        label: p.nome,
        labelMaxDist: 2_000_000,
      };
    }
    const cap = Number(p.cap_t) || 0;
    return {
      grupo: 'armazem',
      // Capacidade dita o tamanho: silos grandes saltam na visão regional.
      size: cap >= 50_000 ? 7 : cap >= 10_000 ? 5 : 3.5,
      color: cssColor('#fbbf24', 0.85),
      label: `${p.nome}${fmtCap(cap)}`,
      labelMaxDist: 45_000,
    };
  },
  legend: [
    { grupo: 'armazem', label: 'Armazém', color: '#fbbf24' },
    { grupo: 'porto', label: 'Porto', color: '#f97316' },
  ],
});

const AGRO_STYLE = {
  frigorifico: { color: '#ef4444', size: 8, rotulo: 'Frigorífico', fonte: 'SIGSIF/MAPA' },
  laticinio: { color: '#bfdbfe', size: 5.5, rotulo: 'Laticínio', fonte: 'SIGSIF/MAPA' },
  serraria: { color: '#b45309', size: 5.5, rotulo: 'Serraria', fonte: 'OpenStreetMap' },
};

export function agroindustriaTooltipHtml(p) {
  const s = AGRO_STYLE[p.kind];
  if (!s) return '';
  return [
    `<div class="vt-nome">🏭 ${escapeHtml(p.nome)}</div>`,
    `<div>${s.rotulo}</div>`,
    p.municipio ? `<div>${escapeHtml(p.municipio)} - PR</div>` : '',
    `<div class="vt-fontes">Fonte: ${s.fonte}</div>`,
  ].join('');
}

// Cadastro IDR: cada propriedade do GeoJSON já é um rótulo legível
// (scripts/build_agroindustrias_idr.py), então o tooltip lista todas.
const IDR_TITULO = new Set(['id', 'Agroindústria', 'Município']);
export function agroindustriaIdrTooltipHtml(p) {
  const linhas = Object.entries(p)
    .filter(([k]) => !IDR_TITULO.has(k))
    .map(([k, v]) => `<div><span class="vt-dim">${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`);
  return `<div class="vt-nome">🧺 ${escapeHtml(p['Agroindústria'] ?? 'Agroindústria')}</div>`
    + `<div>${escapeHtml(p['Município'] ?? '')} - PR</div>`
    + `<div style="columns:2;column-gap:14px;margin-top:4px;font-size:10px">${linhas.join('')}</div>`
    + '<div class="vt-fontes">Fonte: IDR-Paraná, diagnóstico das agroindústrias 2023 e cadastro GETEC</div>';
}

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
      grupo: p.kind,
      size: s.size,
      color: cssColor(s.color, 0.9),
      label: `${s.rotulo}: ${p.nome}`,
      labelMaxDist: 120_000,
    };
  },
  tooltip: agroindustriaTooltipHtml,
  legend: Object.entries(AGRO_STYLE).map(([grupo, s]) => ({ grupo, label: s.rotulo, color: s.color })),
});

const IDR_GRUPOS = [
  { grupo: 'vegetal', label: 'Origem vegetal', color: '#4ade80' },
  { grupo: 'animal', label: 'Origem animal', color: '#f472b6' },
  { grupo: 'mista', label: 'Vegetal e animal', color: '#c084fc' },
];
const IDR_COR = Object.fromEntries(IDR_GRUPOS.map((g) => [g.grupo, g.color]));

// Matéria-prima do diagnóstico ou, no ponto só do GETEC, o tipo (Vegetal/Animal/Mista).
const idrGrupo = (mp = '') => {
  const animal = mp.includes('Animal') || mp.includes('Mista');
  const vegetal = mp.includes('Vegetal') || mp.includes('Mista');
  if (animal && vegetal) return 'mista';
  return animal ? 'animal' : 'vegetal';
};

export const datageoAgroindustriasIdrLayer = makePointsLayer({
  id: 'datageo-agroindustrias-idr',
  name: 'Agroindústrias (cadastro IDR)',
  icon: '🧺',
  source: 'IDR-Paraná 2023',
  url: '/privado/agroindustrias-idr-pr.geojson',
  styleFor: (p) => {
    const grupo = idrGrupo(p['Matéria-prima'] ?? p['GETEC · Tipo']);
    return {
      grupo,
      size: 6,
      color: cssColor(IDR_COR[grupo], 0.9),
      label: p['Agroindústria'],
      labelMaxDist: 40_000,
    };
  },
  tooltip: agroindustriaIdrTooltipHtml,
  tooltipWidth: 720,
  legend: IDR_GRUPOS,
});

const ROTA_STYLE = {
  'Rota do Queijo Paranaense': { color: '#facc15', icon: '🧀' },
  'Rota da Uva e do Vinho': { color: '#a855f7', icon: '🍇' },
};

export function rotaTuristicaTooltipHtml(p) {
  const s = ROTA_STYLE[p.rota] ?? { icon: '📍' };
  const desc = escapeHtml(p.descricao ?? '').replace(/\n/g, '<br>');
  return `<div class="vt-nome">${s.icon} ${escapeHtml(p.nome)}</div>`
    + `<div class="vt-berco">${escapeHtml(p.rota)}</div>`
    + (desc ? `<div style="margin-top:4px">${desc}</div>` : '');
}

export const datageoRotasTuristicasLayer = makePointsLayer({
  id: 'datageo-rotas-turisticas',
  name: 'Rotas turísticas',
  icon: '🧀',
  source: 'Rota do Queijo · Rota da Uva e Vinho',
  url: '/data/rotas-turisticas-pr.geojson',
  styleFor: (p) => ({
    grupo: p.rota,
    size: 9,
    color: cssColor(ROTA_STYLE[p.rota]?.color ?? '#e2e8f0'),
    label: p.nome,
    labelMaxDist: 150_000,
  }),
  tooltip: rotaTuristicaTooltipHtml,
  tooltipWidth: 420,
  legend: Object.entries(ROTA_STYLE).map(([grupo, s]) => ({ grupo, label: grupo, color: s.color })),
});

export const datageoCeasasLayer = makePointsLayer({
  id: 'datageo-ceasas',
  name: 'CEASAs',
  icon: '🥬',
  source: 'CEASA/PR',
  url: '/data/ceasas-pr.geojson',
  styleFor: (p) => ({
    grupo: 'ceasa',
    size: 11,
    color: cssColor('#22c55e'),
    label: p.nome,
    // So 5 unidades: label sempre visivel na visao estadual.
    labelMaxDist: 2_500_000,
  }),
  legend: [{ grupo: 'ceasa', label: 'CEASA', color: '#22c55e' }],
});

export const DATAGEO_LOGISTICA_LAYERS = [
  datageoArmazensLayer,
  datageoAgroindustriasLayer,
  datageoAgroindustriasIdrLayer,
  datageoRotasTuristicasLayer,
  datageoCeasasLayer,
];
