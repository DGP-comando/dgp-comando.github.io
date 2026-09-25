// src/maplibre/prototype.js
//
// Protótipo do DataGeo PR sobre MapLibre GL JS (a engine do Osiris), para
// comparar a fluidez com a versão CesiumJS. Aberto em /maplibre.html ou por
// /?engine=maplibre. Não substitui nada no app principal.
//
// Traz o que o app usa em produção: login, as camadas DataGeo e as de contexto
// (layers/), painel por categoria com legendas e chips, clique no município
// com a ficha, aproximar ao município (com foco nas camadas por escala), busca,
// visão do Paraná, ticker, briefing, vigilância, atalhos e link compartilhável.
// O visual (scope, estilos, título) vem de prototype.css.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './prototype.css';
import { requireLogin } from '../datageoLogin.js';
import { initDatageoTicker } from '../datageoTicker.js';
import { initDatageoBriefing } from '../datageoBriefing.js';
import { initDatageoAreaWatch } from '../datageoAreaWatch.js';
import { initDatageoShortcuts } from '../datageoShortcuts.js';
import { fetchActiveIncidents, fetchCemadenAlerts, fetchFiresPayload } from '../data/datageoClient.js';
import { BASEMAPS, buildBaseStyle } from './basemaps.js';
import { LAYERS } from './layers/index.js';
import { createRegistry } from './registry.js';
import { createNavigation, PARANA_BBOX } from './navigation.js';

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
  estilo: ESTILOS.some((e) => e.id === params.get('estilo')) ? params.get('estilo') : 'normal',
  scope: params.get('scope') !== '0',
  initialLayers: params.has('camadas')
    ? params.get('camadas').split(',').filter(Boolean)
    : LAYERS.filter((l) => l.defaultOn).map((l) => l.id),
};

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}

// Mesmo gate do app: sem sessão com acesso ao DataGeo, as camadas não leem nada.
// (Função em vez de top-level await: o alvo de build do Vite não aceita TLA.)
// `?semlogin` só no servidor de desenvolvimento, para QA de navegador sem
// credencial (as camadas do Supabase ficam vazias; as estáticas carregam).
const skipLogin = import.meta.env.DEV && params.has('semlogin');
(skipLogin ? Promise.resolve() : requireLogin()).then(boot);

function boot() {

// O worker do MapLibre 6 é servido de public/vendor (scripts/prepare-maplibre-worker.mjs).
maplibregl.setWorkerUrl(`/vendor/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);

const map = new maplibregl.Map({
  container: 'map',
  style: buildBaseStyle(state.base, { esriLabels: state.esriLabels }),
  bounds: PARANA_BBOX,
  fitBoundsOptions: { padding: 40 },
  maxPitch: 80,
  hash: 'vista',
  attributionControl: { compact: true, customAttribution: 'Dados: DataGeo PR' },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// Projeção e atmosfera valem para qualquer mapa base, então são reaplicadas a
// cada estilo carregado em vez de embutidas no estilo.
map.on('style.load', () => {
  map.setProjection({ type: state.globe ? 'globe' : 'mercator' });
  map.setSky({ 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] });
});

// ---------------------------------------------------------------------------
// Camadas e navegação

const registry = createRegistry(map, LAYERS, {
  tooltipEl: $('#tooltip'),
  panelEl: $('#layers'),
  onChange: () => syncUrl(),
});
const nav = createNavigation(map, registry, { toast });

// ---------------------------------------------------------------------------
// Mapa base, projeção e relevo

async function setBase(id) {
  state.base = id;
  syncUrl();
  renderControls();
  const t0 = performance.now();
  map.setStyle(buildBaseStyle(id, { esriLabels: state.esriLabels }), {
    // Transplanta as camadas DataGeo (e o relevo) para o estilo novo.
    transformStyle: (prev, style) => {
      const sources = { ...style.sources };
      for (const [sid, spec] of Object.entries(prev?.sources ?? {})) if (sid.startsWith('dg-')) sources[sid] = spec;
      const layers = [...style.layers, ...(prev?.layers ?? []).filter((l) => l.id.startsWith('dg-'))];
      return { ...style, sources, layers, terrain: prev?.terrain };
    },
  });
  await new Promise((resolve) => map.once('idle', resolve));
  $('#base-ms').textContent = `${Math.round(performance.now() - t0)} ms`;
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
  renderControls();
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
  renderControls();
}

function setEstilo(id) {
  state.estilo = id;
  document.body.dataset.estilo = id;
  $('#active-style-name').textContent = ESTILOS.find((e) => e.id === id).label.toUpperCase();
  syncUrl();
  renderControls();
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

// ---------------------------------------------------------------------------
// Link compartilhável: camadas pelos MESMOS ids do app; vista no hash.

function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.set('base', state.base);
  q.set('camadas', registry.enabledIds().join(','));
  state.globe ? q.delete('proj') : q.set('proj', '2d');
  state.terrain ? q.set('relevo', '1') : q.delete('relevo');
  state.esriLabels ? q.delete('rotulos') : q.set('rotulos', '0');
  state.estilo === 'normal' ? q.delete('estilo') : q.set('estilo', state.estilo);
  state.scope ? q.delete('scope') : q.set('scope', '0');
  q.delete('engine');
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
}

// ---------------------------------------------------------------------------
// Controles

function renderControls() {
  $('#bases').innerHTML = BASEMAPS.map(
    (b) => `<button type="button" data-base="${b.id}" class="${b.id === state.base ? 'on' : ''}" title="${b.hint}">${b.label}</button>`,
  ).join('');
  $('#esri-labels').closest('label').hidden = state.base !== 'esri';
  $('#esri-labels').checked = state.esriLabels;
  $('#globe').checked = state.globe;
  $('#terrain').checked = state.terrain;
  $('#scope-toggle').checked = state.scope;
  $('#estilos').innerHTML = ESTILOS.map(
    (e, i) => `<button type="button" data-estilo="${e.id}" class="${e.id === state.estilo ? 'on' : ''}">${e.label}<kbd>${i + 1}</kbd></button>`,
  ).join('');
}

$('#bases').addEventListener('click', (e) => {
  const id = e.target.closest('[data-base]')?.dataset.base;
  if (id && id !== state.base) setBase(id).catch((err) => toast(`Mapa base: ${err.message}`));
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
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  const estilo = ESTILOS[Number(e.key) - 1];
  if (estilo) setEstilo(estilo.id);
});

$('#act-clear').addEventListener('click', async () => {
  const ids = registry.enabledIds();
  await Promise.all(ids.map((id) => registry.setEnabled(id, false)));
  toast(ids.length ? `${ids.length} camada(s) desligada(s)` : 'Nenhuma camada ligada');
});
$('#act-share').addEventListener('click', async () => {
  syncUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copiado');
  } catch {
    toast('Não foi possível copiar o link');
  }
});
$('#act-globe').addEventListener('click', () => {
  map.flyTo({ center: [-51.5, -18], zoom: 1.6, pitch: 0, bearing: 0, duration: 2600, essential: true });
});
$('#engine-version').textContent = `MAPLIBRE GL ${maplibregl.getVersion()} · PROTÓTIPO`;

// FPS: quadros realmente desenhados pelo MapLibre (o mapa só redesenha quando algo muda).
let frames = 0;
map.on('render', () => frames++);
setInterval(() => {
  $('#fps').textContent = `${frames} quadros/s`;
  frames = 0;
}, 1000);

// ---------------------------------------------------------------------------
// Chrome do DataGeo reaproveitado do app: ticker, briefing, vigilância, atalhos.

initDatageoTicker();
initDatageoBriefing();
const areaWatch = initDatageoAreaWatch({
  fetchers: {
    fires: () => fetchFiresPayload().then((payload) => payload.fires),
    cemaden: fetchCemadenAlerts,
    incidents: fetchActiveIncidents,
  },
});
window.__dgpAreaWatch = areaWatch;
initDatageoShortcuts({
  actions: {
    resetCamera: () => nav.flyToParana(),
    toggleWatch: () => areaWatch.toggle(),
    openSearch: () => nav.openSearch(),
    toggleLayers: () => {
      const panel = $('#panel');
      panel.hidden = !panel.hidden;
    },
  },
});

renderControls();
registry.renderPanel();
setEstilo(state.estilo);
paintScope();
$('#loading-screen').classList.add('hidden');

map.once('load', async () => {
  $('#boot-ms').textContent = `${Math.round(performance.now())} ms`;
  if (state.terrain) setTerrain(true);
  const known = new Set(LAYERS.map((l) => l.id));
  await Promise.all(state.initialLayers.filter((id) => known.has(id)).map((id) => registry.setEnabled(id, true)));
  $('#ready-ms').textContent = `${Math.round(performance.now())} ms`;
});

// Ganchos de depuração, no mesmo espírito do __gevViewer do app Cesium.
window.__dgMap = map;
window.__dgRegistry = registry;
}
