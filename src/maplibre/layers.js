// src/maplibre/layers.js
//
// Camadas DataGeo do protótipo MapLibre. Cada uma declara as fontes e os
// layers de estilo que usa; o protótipo liga/desliga pela visibilidade e mede
// o tempo do clique até o mapa ficar ocioso com a camada desenhada.
//
// Os GeoJSON estáticos vão como URL: o worker do MapLibre baixa, faz o parse e
// fatia em tiles fora da thread principal, sem os remendos que a versão Cesium
// precisa (GroundPrimitive único, fatiamento em células, render governor).
//
// Todo id de fonte e de layer começa com `dg-`: é o que a troca de mapa base
// transplanta de um estilo para o outro.

import { fetchClimateStations } from '../data/datageoClient.js';
import { decodeCell, nearestCells } from '../data/slicedCells.js';
import { TEXT_FONT, TEXT_FONT_BOLD } from './basemaps.js';

const DATA = '/data';
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const row = (label, value) =>
  value === null || value === undefined || value === '' ? '' : `<div><span>${esc(label)}</span> ${esc(value)}</div>`;

const HALO = { 'text-color': '#f4f7fb', 'text-halo-color': 'rgba(5,8,13,0.9)', 'text-halo-width': 1.4 };

export const LAYERS = [
  {
    id: 'municipios',
    label: 'Municípios (399)',
    detail: 'polígonos + nomes, hover destaca',
    defaultOn: true,
    sources: {
      'dg-municipios': { type: 'geojson', data: `${DATA}/municipios-pr.geojson`, promoteId: 'CD_MUN' },
    },
    layers: [
      {
        id: 'dg-municipios-fill',
        type: 'fill',
        source: 'dg-municipios',
        paint: {
          'fill-color': '#00d4ff',
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.28, 0.02],
        },
      },
      {
        // Brilho sob a divisa, no lugar do bloom do app Cesium.
        id: 'dg-municipios-glow',
        type: 'line',
        source: 'dg-municipios',
        paint: {
          'line-color': '#2ee6d6',
          'line-opacity': 0.35,
          'line-blur': 3,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 10, 6],
        },
      },
      {
        id: 'dg-municipios-line',
        type: 'line',
        source: 'dg-municipios',
        paint: {
          'line-color': '#5ff5e4',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 1.4],
        },
      },
      {
        id: 'dg-municipios-label',
        type: 'symbol',
        source: 'dg-municipios',
        minzoom: 7.5,
        layout: { 'text-field': ['get', 'NM_MUN'], 'text-font': TEXT_FONT, 'text-size': 11 },
        paint: HALO,
      },
    ],
    hover: { layer: 'dg-municipios-fill', source: 'dg-municipios' },
    tooltip: (p) => `<strong>${esc(p.NM_MUN)}</strong>${row('IBGE', p.CD_MUN)}`,
  },
  {
    id: 'rodovias',
    label: 'Rodovias federais e estaduais',
    detail: '16 mil trechos',
    sources: {
      'dg-rod-fed': { type: 'geojson', data: `${DATA}/rodovias-federais-pr.geojson` },
      'dg-rod-est': { type: 'geojson', data: `${DATA}/rodovias-estaduais-pr.geojson` },
    },
    layers: [
      {
        id: 'dg-rod-est-line',
        type: 'line',
        source: 'dg-rod-est',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fbbf24', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 3] },
      },
      {
        id: 'dg-rod-fed-line',
        type: 'line',
        source: 'dg-rod-fed',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f43f5e', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 12, 4] },
      },
      {
        id: 'dg-rod-label',
        type: 'symbol',
        source: 'dg-rod-fed',
        minzoom: 8,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'ref'],
          'text-font': TEXT_FONT_BOLD,
          'text-size': 11,
          'symbol-spacing': 400,
        },
        paint: HALO,
      },
      {
        id: 'dg-rod-est-label',
        type: 'symbol',
        source: 'dg-rod-est',
        minzoom: 9,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'ref'],
          'text-font': TEXT_FONT_BOLD,
          'text-size': 10,
          'symbol-spacing': 400,
        },
        paint: HALO,
      },
    ],
    interactive: ['dg-rod-fed-line', 'dg-rod-est-line'],
    tooltip: (p) => `<strong>${esc(p.ref || 'Rodovia')}</strong>${row('Nome', p.name)}`,
  },
  {
    id: 'ferrovias',
    label: 'Ferrovias',
    detail: '1,8 mil trechos',
    sources: { 'dg-ferrovias': { type: 'geojson', data: `${DATA}/ferrovias-pr.geojson` } },
    layers: [
      {
        id: 'dg-ferrovias-line',
        type: 'line',
        source: 'dg-ferrovias',
        paint: {
          'line-color': '#e2e8f0',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 2.5],
          'line-dasharray': [2, 1.5],
        },
      },
    ],
    interactive: ['dg-ferrovias-line'],
    tooltip: (p) => `<strong>${esc(p.name || 'Ferrovia')}</strong>${row('Operadora', p.operator)}${row('Uso', p.usage)}`,
  },
  {
    id: 'terras-indigenas',
    label: 'Terras indígenas',
    detail: '57 polígonos',
    sources: { 'dg-ti': { type: 'geojson', data: `${DATA}/terras-indigenas-pr.geojson` } },
    layers: [
      { id: 'dg-ti-fill', type: 'fill', source: 'dg-ti', paint: { 'fill-color': '#a3e635', 'fill-opacity': 0.25 } },
      { id: 'dg-ti-line', type: 'line', source: 'dg-ti', paint: { 'line-color': '#a3e635', 'line-width': 1.5 } },
    ],
    interactive: ['dg-ti-fill'],
    tooltip: (p) =>
      `<strong>${esc(p.nome)}</strong>${row('Etapa', p.etapa)}${row('Área (ha)', p.area_ha?.toLocaleString?.('pt-BR'))}`,
  },
  {
    id: 'armazens',
    label: 'Armazéns (Conab)',
    detail: '2,5 mil pontos',
    sources: { 'dg-armazens': { type: 'geojson', data: `${DATA}/armazens-conab-pr.geojson` } },
    layers: [
      {
        id: 'dg-armazens-circle',
        type: 'circle',
        source: 'dg-armazens',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.2, 12, 6],
          'circle-color': ['match', ['get', 'kind'], 'porto', '#38bdf8', '#facc15'],
          'circle-stroke-color': '#05080d',
          'circle-stroke-width': 0.8,
        },
      },
    ],
    interactive: ['dg-armazens-circle'],
    tooltip: (p) =>
      `<strong>${esc(p.nome)}</strong>${row('Município', p.municipio)}${row('Tipo', p.tipo)}${row(
        'Capacidade (t)',
        p.cap_t ? Number(p.cap_t).toLocaleString('pt-BR') : null,
      )}`,
  },
  {
    id: 'estradas',
    label: 'Estradas municipais (OSM)',
    detail: '394 mil trechos, por célula a partir do zoom 10',
    sources: { 'dg-estradas': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'dg-estradas-rurais',
        type: 'line',
        source: 'dg-estradas',
        minzoom: 10,
        filter: ['==', ['get', 'classe'], 'rurais'],
        paint: { 'line-color': '#fde68a', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 2.2] },
      },
      {
        id: 'dg-estradas-urbanas',
        type: 'line',
        source: 'dg-estradas',
        minzoom: 12,
        filter: ['==', ['get', 'classe'], 'urbanas'],
        paint: { 'line-color': '#e5e7eb', 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 2] },
      },
    ],
    // Carregamento por viewport, ver createEstradasLoader.
    dynamic: 'estradas',
  },
  {
    id: 'clima',
    label: 'Estações meteorológicas (ao vivo)',
    detail: 'Supabase; exige login no app principal',
    sources: { 'dg-clima': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'dg-clima-circle',
        type: 'circle',
        source: 'dg-clima',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 10],
          'circle-color': [
            'interpolate', ['linear'], ['get', 'temperature'],
            0, '#60a5fa', 15, '#34d399', 25, '#facc15', 32, '#f97316', 38, '#dc2626',
          ],
          'circle-stroke-color': '#05080d',
          'circle-stroke-width': 1,
        },
      },
      {
        id: 'dg-clima-label',
        type: 'symbol',
        source: 'dg-clima',
        minzoom: 6.5,
        layout: {
          'text-field': ['concat', ['to-string', ['round', ['get', 'temperature']]], '°'],
          'text-font': TEXT_FONT_BOLD,
          'text-size': 11,
          'text-offset': [0, 1.3],
        },
        paint: HALO,
      },
    ],
    interactive: ['dg-clima-circle'],
    tooltip: (p) =>
      `<strong>${esc(p.station_name)}</strong>${row('Município', p.municipality)}${row(
        'Temperatura',
        p.temperature != null ? `${p.temperature} °C` : null,
      )}${row('Umidade', p.humidity != null ? `${p.humidity} %` : null)}${row(
        'Chuva',
        p.precipitation != null ? `${p.precipitation} mm` : null,
      )}${row('Leitura', p.observed_at ? new Date(p.observed_at).toLocaleString('pt-BR') : null)}`,
    // Dado vivo: a fonte é preenchida pelo fetcher do app principal.
    async load(map) {
      const rows = await fetchClimateStations();
      map.getSource('dg-clima')?.setData({
        type: 'FeatureCollection',
        features: rows
          .filter((r) => Number.isFinite(Number(r.temperature)))
          .map((r) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(r.longitude), Number(r.latitude)] },
            properties: { ...r, temperature: Number(r.temperature) },
          })),
      });
      return rows.length;
    },
  },
];

/**
 * Estradas municipais: as mesmas células estáticas da camada Cesium
 * (public/data/estradas), decodificadas e reunidas numa fonte GeoJSON só.
 * Com a vista em zoom >= 10 carrega as células mais próximas do centro;
 * acima de `maxCells` descarta as mais antigas fora da vista.
 */
export function createEstradasLoader(map, { maxCells = 48, perView = 12, onStats } = {}) {
  let index = null;
  let enabled = false;
  const cells = new Map(); // key -> features[]
  const pending = new Set();
  let trechos = 0;

  const push = () => {
    const features = [];
    trechos = 0;
    for (const list of cells.values()) {
      for (const f of list) {
        features.push(f);
        trechos += f.geometry.coordinates.length;
      }
    }
    map.getSource('dg-estradas')?.setData({ type: 'FeatureCollection', features });
    onStats?.({ cells: cells.size, trechos });
  };

  async function refresh() {
    if (!enabled || map.getZoom() < 10) return;
    index ??= await fetch(`${DATA}/estradas/index.json`).then((r) => r.json());
    const { lat, lng } = map.getCenter();
    const wanted = nearestCells(lat, lng, index, perView, 3).filter((k) => !cells.has(k) && !pending.has(k));
    if (!wanted.length) return;
    await Promise.all(
      wanted.map(async (key) => {
        pending.add(key);
        try {
          const payload = await fetch(`${DATA}/estradas/${key}.json`).then((r) => r.json());
          const porClasse = decodeCell(payload, key, index);
          cells.set(
            key,
            porClasse.map((lines, g) => ({
              type: 'Feature',
              properties: { classe: index.classes[g] },
              geometry: {
                type: 'MultiLineString',
                coordinates: lines.map((flat) => {
                  const coords = [];
                  for (let n = 0; n < flat.length; n += 2) coords.push([flat[n], flat[n + 1]]);
                  return coords;
                }),
              },
            })),
          );
        } finally {
          pending.delete(key);
        }
      }),
    );
    // Descarta as mais antigas (ordem de inserção do Map).
    for (const key of cells.keys()) {
      if (cells.size <= maxCells) break;
      cells.delete(key);
    }
    push();
  }

  map.on('moveend', () => refresh().catch((e) => console.warn('[maplibre:estradas]', e)));
  return {
    async setEnabled(value) {
      enabled = value;
      if (value) await refresh();
    },
    stats: () => ({ cells: cells.size, trechos }),
  };
}
