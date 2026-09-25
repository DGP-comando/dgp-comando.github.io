// src/maplibre/prototype.js
//
// Protótipo do DataGeo PR sobre MapLibre GL JS (a engine do Osiris), para
// comparar com a versão CesiumJS. Aberto em /maplibre.html ou por
// /?engine=maplibre. Não substitui nada no app principal.
//
// O que cobre: mapa base Satélite (Esri + rótulos) / OSM raster / OSM vetorial,
// globo ou plano, relevo 3D opcional, e algumas camadas DataGeo representativas
// (polígonos, linhas pesadas, pontos, células de estradas, dado vivo do
// Supabase). O painel mede quanto cada camada leva do clique até o mapa ficar
// ocioso com ela desenhada.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './prototype.css';
import { BASEMAPS, buildBaseStyle } from './basemaps.js';
import { LAYERS, createEstradasLoader } from './layers.js';

// Tempos medidos desde o início da navegação (performance.now() zera nela),
// para incluir o download do bundle.
const T0 = 0;
const params = new URLSearchParams(location.search);
const $ = (sel) => document.querySelector(sel);

// Os mesmos sete estilos do dock ESTILOS VISUAIS do app (teclas 1-7). Aqui são
// filtros CSS no canvas + uma camada de efeito (prototype.css), não shaders.
const ESTILOS = [
  { id: 'normal', label: 'Normal' },
  { id: 'retro', label: 'CRT' },
  { id: 'surveillance', label: 'NVG' },
  { id: 'thermal', label: 'FLIR' },
  { id: 'anime', label: 'Anime' },
  { id: 'noir', label: 'Noir' },
  { id: 'snow', label: 'Snow' },
];

const TERRAIN_SOURCE = 'dg-terrain';
const TERRAIN_SPEC = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 14,
  attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Relevo: Mapzen/AWS Terrain Tiles</a>',
};

const state = {
  base: BASEMAPS.some((b) => b.id === params.get('base')) ? params.get('base') : 'esri',
  esriLabels: params.get('rotulos') !== '0',
  globe: params.get('proj') !== '2d',
  terrain: params.get('relevo') === '1',
  on: new Set(
    params.has('camadas')
      ? params.get('camadas').split(',').filter(Boolean)
      : LAYERS.filter((l) => l.defaultOn).map((l) => l.id),
  ),
  timings: new Map(), // id -> {ms, info, error}
  estilo: ESTILOS.some((e) => e.id === params.get('estilo')) ? params.get('estilo') : 'normal',
  scope: params.get('scope') !== '0',
};

// O worker do MapLibre 6 é servido de public/vendor (scripts/prepare-maplibre-worker.mjs).
maplibregl.setWorkerUrl(`/vendor/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);

const map = new maplibregl.Map({
  container: 'map',
  style: buildBaseStyle(state.base, { esriLabels: state.esriLabels }),
  center: [-51.45, -24.65],
  zoom: 6.2,
  maxPitch: 80,
  hash: 'vista',
  attributionControl: { compact: true, customAttribution: 'Dados: DataGeo PR / IDR-Paraná' },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// Projeção e atmosfera valem para qualquer mapa base, então são reaplicadas a
// cada estilo carregado em vez de embutidas no estilo.
map.on('style.load', () => {
  map.setProjection({ type: state.globe ? 'globe' : 'mercator' });
  // Atmosfera só na visão de globo; some ao aproximar.
  map.setSky({ 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] });
});

// ---------------------------------------------------------------------------
// Camadas DataGeo

const estradas = createEstradasLoader(map, {
  onStats: ({ cells, trechos }) => {
    const t = state.timings.get('estradas') ?? {};
    state.timings.set('estradas', { ...t, info: `${cells} células · ${trechos.toLocaleString('pt-BR')} trechos` });
    renderPanel();
  },
});

function ensureAdded(def) {
  for (const [id, spec] of Object.entries(def.sources)) {
    if (!map.getSource(id)) map.addSource(id, spec);
  }
  for (const layer of def.layers) {
    if (!map.getLayer(layer.id)) map.addLayer({ ...layer, layout: { ...layer.layout, visibility: 'none' } });
  }
}

const idle = () => new Promise((resolve) => map.once('idle', resolve));

async function setLayer(def, on) {
  on ? state.on.add(def.id) : state.on.delete(def.id);
  syncUrl();
  const firstTime = on && !state.timings.has(def.id);
  const t0 = performance.now();
  if (firstTime) state.timings.set(def.id, { loading: true });
  renderPanel();
  ensureAdded(def);
  for (const layer of def.layers) map.setLayoutProperty(layer.id, 'visibility', on ? 'visible' : 'none');
  if (def.dynamic === 'estradas') {
    if (on && map.getZoom() < 10) state.timings.set(def.id, { info: 'aproxime até o zoom 10' });
    await estradas.setEnabled(on);
  }
  if (!firstTime) return renderPanel();
  try {
    const count = def.load ? await def.load(map) : null;
    await idle();
    const prev = state.timings.get(def.id) ?? {};
    state.timings.set(def.id, {
      ...prev,
      loading: false,
      ms: performance.now() - t0,
      info: prev.info ?? (count != null ? `${count} registros` : null),
    });
  } catch (err) {
    const hint = def.id === 'clima' ? ' (entre no app principal para liberar os dados)' : '';
    state.timings.set(def.id, { loading: false, error: `${err?.message || err}${hint}` });
  }
  renderPanel();
}

// ---------------------------------------------------------------------------
// Mapa base, projeção e relevo

async function setBase(id) {
  state.base = id;
  syncUrl();
  renderPanel();
  const t0 = performance.now();
  map.setStyle(buildBaseStyle(id, { esriLabels: state.esriLabels }), {
    // Transplanta as camadas DataGeo (e o relevo) para o estilo novo.
    transformStyle: (prev, style) => {
      const keepSource = (sid) => sid.startsWith('dg-');
      const sources = { ...style.sources };
      for (const [sid, spec] of Object.entries(prev?.sources ?? {})) if (keepSource(sid)) sources[sid] = spec;
      const layers = [...style.layers, ...(prev?.layers ?? []).filter((l) => l.id.startsWith('dg-'))];
      return { ...style, sources, layers, terrain: prev?.terrain };
    },
  });
  await idle();
  $('#base-ms').textContent = `troca em ${Math.round(performance.now() - t0)} ms`;
}

function setEsriLabels(on) {
  state.esriLabels = on;
  syncUrl();
  if (map.getLayer('base-esri-labels')) map.setLayoutProperty('base-esri-labels', 'visibility', on ? 'visible' : 'none');
}

function setGlobe(on) {
  state.globe = on;
  syncUrl();
  map.setProjection({ type: on ? 'globe' : 'mercator' });
  renderPanel();
}

function setTerrain(on) {
  state.terrain = on;
  syncUrl();
  if (on) {
    if (!map.getSource(TERRAIN_SOURCE)) map.addSource(TERRAIN_SOURCE, TERRAIN_SPEC);
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1.5 });
    if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 900 });
  } else {
    map.setTerrain(null);
  }
  renderPanel();
}

function setEstilo(id) {
  state.estilo = id;
  document.body.dataset.estilo = id;
  $('#active-style-name').textContent = ESTILOS.find((e) => e.id === id).label.toUpperCase();
  syncUrl();
  renderPanel();
}

// ---------------------------------------------------------------------------
// Máscara circular (scope), mesma geometria do src/scopeMask.js do app:
// raio = 0,5 × altura × 1,05, feather de 11 % do raio centrado na borda, fora
// preto da página a 94 % na vista de globo inteiro e opaco ao aproximar.

const SCOPE_RADIUS = 1.05;
const SCOPE_FEATHER = 0.11;
let scopeKey = '';

function paintScope() {
  document.body.classList.toggle('scope-off', !state.scope);
  if (!state.scope) return;
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const r = h * 0.5 * SCOPE_RADIUS;
  const half = r * SCOPE_FEATHER * 0.5;
  // Zoom 2 ~ globo inteiro (10 Mm no Cesium); zoom 3 ~ 7 Mm, já opaco.
  const t = Math.min(1, Math.max(0, map.getZoom() - 2));
  const alpha = (0.94 + 0.06 * t).toFixed(3);
  const key = `${w}x${h}:${alpha}`;
  if (key === scopeKey) return;
  scopeKey = key;
  $('#scope').style.background = `radial-gradient(circle at 50% 50%, rgba(5,5,8,0) ${r - half}px, rgba(5,5,8,${alpha}) ${r + half}px)`;
}

function setScope(on) {
  state.scope = on;
  scopeKey = '';
  paintScope();
  syncUrl();
}

map.on('resize', paintScope);
map.on('zoom', paintScope);

function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.set('base', state.base);
  q.set('camadas', [...state.on].join(','));
  state.globe ? q.delete('proj') : q.set('proj', '2d');
  state.terrain ? q.set('relevo', '1') : q.delete('relevo');
  state.esriLabels ? q.delete('rotulos') : q.set('rotulos', '0');
  state.estilo === 'normal' ? q.delete('estilo') : q.set('estilo', state.estilo);
  state.scope ? q.delete('scope') : q.set('scope', '0');
  q.delete('engine');
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
}

// ---------------------------------------------------------------------------
// Tooltip e hover

const tooltip = $('#tooltip');
const byLayerId = new Map();
for (const def of LAYERS) {
  for (const lid of def.interactive ?? (def.hover ? [def.hover.layer] : [])) byLayerId.set(lid, def);
}
let hovered = null; // {source, id}

function clearHover() {
  if (hovered) map.setFeatureState(hovered, { hover: false });
  hovered = null;
}

map.on('mousemove', (e) => {
  const ids = [...byLayerId.keys()].filter((id) => map.getLayer(id) && state.on.has(byLayerId.get(id).id));
  const [feature] = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : [];
  const def = feature && byLayerId.get(feature.layer.id);
  if (def?.hover && feature.id != null) {
    const next = { source: def.hover.source, id: feature.id };
    if (hovered?.id !== next.id || hovered?.source !== next.source) {
      clearHover();
      hovered = next;
      map.setFeatureState(hovered, { hover: true });
    }
  } else {
    clearHover();
  }
  if (!def?.tooltip) {
    tooltip.hidden = true;
    map.getCanvas().style.cursor = '';
    return;
  }
  map.getCanvas().style.cursor = 'pointer';
  tooltip.innerHTML = def.tooltip(feature.properties);
  tooltip.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
  tooltip.hidden = false;
});
map.on('mouseout', () => {
  clearHover();
  tooltip.hidden = true;
});
// A troca de estilo apaga os feature-states.
map.on('styledata', () => {
  hovered = null;
});

// ---------------------------------------------------------------------------
// Painel

function renderPanel() {
  $('#bases').innerHTML = BASEMAPS.map(
    (b) =>
      `<button type="button" data-base="${b.id}" class="${b.id === state.base ? 'on' : ''}" title="${b.hint}">${b.label}</button>`,
  ).join('');
  $('#esri-labels').closest('label').hidden = state.base !== 'esri';
  $('#esri-labels').checked = state.esriLabels;
  $('#globe').checked = state.globe;
  $('#scope-toggle').checked = state.scope;
  $('#estilos').innerHTML = ESTILOS.map(
    (e, i) => `<button type="button" data-estilo="${e.id}" class="${e.id === state.estilo ? 'on' : ''}">${e.label}<kbd>${i + 1}</kbd></button>`,
  ).join('');
  $('#terrain').checked = state.terrain;
  $('#layers').innerHTML = LAYERS.map((def) => {
    const t = state.timings.get(def.id);
    let meta = def.detail;
    if (t?.loading) meta = 'carregando…';
    else if (t?.error) meta = `<span class="err">erro: ${t.error}</span>`;
    else if (t && (t.ms != null || t.info)) {
      meta = [t.ms != null ? `<b>${Math.round(t.ms)} ms</b>` : '', t.info ?? ''].filter(Boolean).join(' · ');
    }
    return `<label class="layer"><input type="checkbox" data-layer="${def.id}" ${state.on.has(def.id) ? 'checked' : ''}/>
      <span><span class="name">${def.label}</span><span class="meta">${meta}</span></span></label>`;
  }).join('');
}

$('#bases').addEventListener('click', (e) => {
  const id = e.target.closest('[data-base]')?.dataset.base;
  if (id && id !== state.base) setBase(id).catch((err) => ($('#base-ms').textContent = `erro: ${err.message}`));
});
$('#layers').addEventListener('change', (e) => {
  const def = LAYERS.find((l) => l.id === e.target.dataset.layer);
  if (def) setLayer(def, e.target.checked);
});
$('#esri-labels').addEventListener('change', (e) => setEsriLabels(e.target.checked));
$('#globe').addEventListener('change', (e) => setGlobe(e.target.checked));
$('#terrain').addEventListener('change', (e) => setTerrain(e.target.checked));
$('#scope-toggle').addEventListener('change', (e) => setScope(e.target.checked));
$('#estilos').addEventListener('click', (e) => {
  const id = e.target.closest('[data-estilo]')?.dataset.estilo;
  if (id) setEstilo(id);
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea')) return;
  const estilo = ESTILOS[Number(e.key) - 1];
  if (estilo) setEstilo(estilo.id);
});
$('#engine-version').textContent = `MAPLIBRE GL ${maplibregl.getVersion()} · PROTÓTIPO`;

// FPS: quadros realmente desenhados pelo MapLibre (o mapa só redesenha quando algo muda).
let frames = 0;
map.on('render', () => frames++);
setInterval(() => {
  $('#fps').textContent = `${frames} quadros/s`;
  frames = 0;
}, 1000);

setEstilo(state.estilo);
paintScope();
map.once('load', async () => {
  $('#boot-ms').textContent = `${Math.round(performance.now() - T0)} ms`;
  if (state.terrain) setTerrain(true);
  await Promise.all(LAYERS.filter((d) => state.on.has(d.id)).map((d) => setLayer(d, true)));
  $('#ready-ms').textContent = `${Math.round(performance.now() - T0)} ms`;
});

// Ganchos de depuração, no mesmo espírito do __gevViewer do app Cesium.
window.__dgMap = map;
