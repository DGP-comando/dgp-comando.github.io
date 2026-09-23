// src/data/datageoEstradasConveniadas.js
//
// Estradas rurais da SEAB numa camada só, com três conjuntos que se ligam e
// desligam pelos chips da linha do painel:
//   - conveniadas: os 96 convênios de 2026 (SET, preliminar), a mensagem;
//   - protocolos:  os trechos protocolados em 2025;
//   - automatizado: a malha de 2025 traçada por rede.
// Os dois últimos são o "todas as estradas" contra o qual as conveniadas se
// leem, por isso ficam em tons frios e finos, e as conveniadas por cima.
//
// Dado estático (public/data/estradas-conveniadas-pr.geojson, via
// scripts/build_estradas_conveniadas.py), sem o CNPJ do colaborador. São
// menos de mil trechos: entidades clamped bastam, e dão o hover de graça.

import * as Cesium from 'cesium';
import { createEntityHoverTooltip } from './entityHoverTooltip.js';
import { escapeHtml } from './vesselTooltip.js';
import { governorRequestRender } from '../renderGovernor.js';
import { dgFetchData } from './datageoClient.js';

const ID = 'datageo-estradas-conveniadas';
const DATA_URL = '/privado/estradas-conveniadas-pr.geojson';
const DESCRICAO_MAX = 280;

export const GRUPOS = Object.freeze([
  Object.freeze({ id: 'conveniadas', label: 'Conveniadas 2026', css: '#ff4d6d', alpha: 0.95, width: 4, z: 3 }),
  Object.freeze({ id: 'protocolos', label: 'Protocolos 2025', css: '#c084fc', alpha: 1, width: 3, z: 2 }),
  Object.freeze({ id: 'automatizado', label: 'Automatizado 2025', css: '#94a3b8', alpha: 0.75, width: 2, z: 1 }),
]);
const GRUPO_BY_ID = new Map(GRUPOS.map((g) => [g.id, g]));

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

function createEstradasConveniadasLayer() {
  let viewer = null;
  let sources = new Map(); // grupo -> CustomDataSource
  let tooltip = null;
  let features = [];
  let loaded = false;
  let enabled = false;
  let lastUpdate = null;
  let lastError = null;
  const visivel = Object.fromEntries(GRUPOS.map((g) => [g.id, true]));
  const counts = Object.fromEntries(GRUPOS.map((g) => [g.id, 0]));

  const sync = () => {
    for (const [grupo, ds] of sources) ds.show = enabled && visivel[grupo];
    if (!enabled) tooltip?.hide();
    governorRequestRender(`${ID}:show`);
  };

  const build = () => {
    for (const ds of sources.values()) ds.entities.removeAll();
    for (const g of GRUPOS) counts[g.id] = 0;
    features.forEach((f, i) => {
      const grupo = GRUPO_BY_ID.get(f.properties?.grupo);
      const ds = grupo && sources.get(grupo.id);
      if (!ds) return;
      counts[grupo.id] += 1;
      partesDe(f.geometry).forEach((coords, j) => {
        ds.entities.add({
          id: `${ID}:${i}:${j}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(coords.flat()),
            width: grupo.width,
            material: Cesium.Color.fromCssColorString(grupo.css).withAlpha(grupo.alpha),
            clampToGround: true,
            zIndex: grupo.z,
          },
          properties: { i },
        });
      });
    });
  };

  return {
    id: ID,
    name: 'Estradas Rurais Conveniadas',
    category: 'Infraestrutura',
    icon: '🚜',
    source: 'SEAB-PR',
    updateInterval: 24 * 3600_000,

    init(v) {
      viewer = v;
      for (const g of GRUPOS) {
        const ds = new Cesium.CustomDataSource(`${ID}:${g.id}`);
        ds.show = false;
        viewer.dataSources.add(ds);
        sources.set(g.id, ds);
      }
      tooltip = createEntityHoverTooltip({
        viewer,
        idPrefix: `${ID}:`,
        render: (p) => tooltipHtml(features[p.i]?.properties),
        isActive: () => enabled,
        drill: true,
      });
    },

    enable() {
      enabled = true;
      sync();
    },

    disable() {
      enabled = false;
      sync();
    },

    async update() {
      if (loaded) return true;
      try {
        const resp = await dgFetchData(DATA_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        features = (await resp.json()).features ?? [];
      } catch (err) {
        lastError = err?.message || String(err);
        console.warn(`[Data:${ID}]`, err);
        return false;
      }
      if (!viewer) return false; // destruída durante o fetch
      build();
      loaded = true;
      lastUpdate = Date.now();
      lastError = null;
      sync();
      return true;
    },

    /** Um booleano por grupo: `{ protocolos: false }` esconde os protocolos. */
    setParams(params = {}) {
      for (const [k, v] of Object.entries(params)) {
        if (!GRUPO_BY_ID.has(k) || typeof v !== 'boolean') return false;
      }
      Object.assign(visivel, params);
      sync();
      return true;
    },

    getParams() {
      return { ...visivel };
    },

    getRowControls() {
      return {
        chips: GRUPOS.map((g) => ({
          id: g.id,
          label: g.label,
          active: visivel[g.id],
          title: `${visivel[g.id] ? 'Esconder' : 'Mostrar'} ${g.label.toLowerCase()}`,
          params: { [g.id]: !visivel[g.id] },
        })),
        legend: GRUPOS.map((g) => ({ label: g.label, color: g.css, count: counts[g.id] })),
      };
    },

    destroy(v) {
      tooltip?.destroy();
      for (const ds of sources.values()) (v ?? viewer)?.dataSources.remove(ds, true);
      sources = new Map();
      tooltip = viewer = null;
      features = [];
      loaded = false;
    },

    getStats() {
      const count = GRUPOS.reduce((n, g) => n + (visivel[g.id] ? counts[g.id] : 0), 0);
      return { count, lastUpdate, error: lastError };
    },
  };
}

export const datageoEstradasConveniadasLayer = createEstradasConveniadasLayer();
