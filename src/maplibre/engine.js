// src/maplibre/engine.js
//
// MOTOR DE MAPA DO APP (substitui o Cesium.Viewer)
// =================================================
//
// Uma fachada fina sobre o MapLibre GL com os serviços que o resto do app
// (ui.js, sharelink, HUD, overlays, camadas) pedia ao Cesium, em termos
// neutros. Quem precisa do mapa recebe `engine` no lugar de `viewer`.
//
// Câmera em SEMÂNTICA CESIUM, para os links, cenas e voos antigos continuarem
// valendo: posição da CÂMERA (lat/lon em graus, `alt` em metros), `heading`
// (graus, 0 = norte, horário) e `pitch` (graus, -90 = olhando para baixo,
// 0 = horizonte). No MapLibre: bearing = heading, pitch = 90 + pitch Cesium.
//
//   engine.map                          o maplibregl.Map (use com parcimônia)
//   engine.container / engine.canvas
//   engine.ready                        Promise: estilo carregado
//   engine.getCameraView()              {lat, lon, alt, heading, pitch, roll, zoom, targetLat, targetLon}
//   engine.setCameraView(view)          salto instantâneo
//   engine.flyToCamera(view, opts)      voo até uma posição de câmera
//   engine.flyToTarget(target, opts)    olhar para {lat, lon} de `rangeM`, com heading/pitch
//   engine.flyToBounds(bbox, opts)      enquadrar [w, s, e, n]
//   engine.cancelFlight(), engine.isMoving()
//       opts: {duration (s), complete(), cancel(), easing}
//   engine.project(lon, lat, h?)        {x, y, visible} em px CSS do container, ou null
//   engine.unproject(x, y)              {lon, lat} ou null
//   engine.pick(x, y, {layers?})        feições renderizadas no ponto (queryRenderedFeatures)
//   engine.track(target|null)           câmera segue `target.getPosition()` ({lon, lat, alt?})
//   engine.trackedTarget                alvo atual (ou null); evento 'trackedchange'
//   engine.on(evento, fn) -> remove()   'camerachange' (a cada quadro de movimento),
//                                       'movestart', 'moveend', 'render', 'click',
//                                       'mousemove', 'trackedchange', 'basemapchange', 'resize'
//   engine.requestRender()
//   engine.getBasemap()/setBasemap(id), engine.BASEMAPS
//   engine.isGlobe()/setGlobe(bool), engine.hasTerrain()/setTerrain(bool)
//   engine.cameraHeightAboveGround()    altura aproximada acima do solo (m)

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAPS, buildBaseStyle } from './basemaps.js';
import { mapViewForSceneCamera, sceneCameraFromMap } from './cameraMath.js';

export { BASEMAPS };

/** Retângulo do Paraná [w, s, e, n]. */
export const PARANA_BBOX = Object.freeze([-54.62, -26.72, -48.02, -22.52]);

const TERRAIN_SOURCE = 'dg-terrain';
const TERRAIN_SPEC = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 14,
  attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Relevo: Mapzen/AWS Terrain Tiles</a>',
};

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Ponto a `distM` metros de (lon, lat) na direção `bearingDeg` (esfera). */
export function destinationPoint(lon, lat, bearingDeg, distM) {
  const d = distM / EARTH_RADIUS_M;
  const b = bearingDeg * DEG;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lon: ((l2 / DEG + 540) % 360) - 180, lat: p2 / DEG };
}

/** pitch Cesium (-90 = nadir) -> pitch MapLibre (0 = nadir). */
export const toMapPitch = (cesiumPitch) => Math.max(0, Math.min(85, 90 + Number(cesiumPitch ?? -90)));
/** pitch MapLibre -> pitch Cesium. */
export const toCesiumPitch = (mapPitch) => Number(mapPitch ?? 0) - 90;

/**
 * @param {object} options
 * @param {string|HTMLElement} options.container
 * @param {string} [options.basemap='esri']
 * @param {boolean} [options.esriLabels=true]
 * @param {boolean} [options.globe=true]
 * @param {boolean} [options.preserveDrawingBuffer=false]
 */
export function createEngine({
  container,
  basemap = 'esri',
  esriLabels = true,
  globe = true,
  preserveDrawingBuffer = false,
} = {}) {
  // O worker do MapLibre 6 é servido de public/vendor (scripts/prepare-maplibre-worker.mjs).
  maplibregl.setWorkerUrl(`/vendor/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);

  const state = {
    basemap: BASEMAPS.some((b) => b.id === basemap) ? basemap : 'esri',
    esriLabels,
    globe,
    terrain: false,
    tracked: null,
    flight: null, // {complete, cancel} do voo em curso
  };

  const map = new maplibregl.Map({
    container,
    style: buildBaseStyle(state.basemap, { esriLabels }),
    bounds: PARANA_BBOX,
    fitBoundsOptions: { padding: 40 },
    maxPitch: 85,
    attributionControl: { compact: true, customAttribution: 'Dados: DataGeo PR' },
    canvasContextAttributes: preserveDrawingBuffer ? { preserveDrawingBuffer: true } : undefined,
  });

  const listeners = new Map();
  function emit(type, payload) {
    for (const fn of listeners.get(type) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.warn(`[engine] listener ${type}`, err);
      }
    }
  }
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }

  map.on('style.load', () => {
    map.setProjection({ type: state.globe ? 'globe' : 'mercator' });
    map.setSky({ 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] });
  });
  const ready = new Promise((resolve) => {
    if (map.isStyleLoaded()) resolve();
    else map.once('style.load', () => resolve());
  });

  map.on('move', () => emit('camerachange'));
  map.on('movestart', (e) => {
    // Só depois do movestart DESTE voo o moveend significa "chegou": o
    // flyTo/fitBounds para o movimento anterior e dispara um moveend antes.
    if (state.flight) state.flight.started = true;
    emit('movestart', e);
  });
  map.on('moveend', (e) => {
    emit('moveend', e);
    if (state.flight?.started && !map.isMoving()) finishFlight();
  });
  function finishFlight() {
    const flight = state.flight;
    if (!flight) return;
    state.flight = null;
    flight.complete?.();
  }
  map.on('render', () => emit('render'));
  map.on('resize', () => emit('resize'));
  map.on('click', (e) => emit('click', { x: e.point.x, y: e.point.y, lon: e.lngLat.lng, lat: e.lngLat.lat, originalEvent: e.originalEvent }));
  map.on('mousemove', (e) => emit('mousemove', { x: e.point.x, y: e.point.y, lon: e.lngLat.lng, lat: e.lngLat.lat, originalEvent: e.originalEvent }));

  // Interação do usuário cancela voo programático e acompanhamento (como o
  // Cesium, onde arrastar interrompia o flyTo e o trackedEntity).
  const userInterrupt = (e) => {
    if (!e?.originalEvent) return;
    if (state.flight) {
      const { cancel } = state.flight;
      state.flight = null;
      cancel?.();
    }
  };
  map.on('dragstart', userInterrupt);
  map.on('wheel', userInterrupt);

  // ------------------------------------------------------------- câmera

  // Câmera em semântica Cesium <-> centro/zoom/pitch/bearing, sobre a ESFERA
  // (cameraMath.js): a conversão plana do MapLibre erra longe da superfície
  // (a 19 000 km, 25° fora do nadir "acertava" o polo).
  function getCameraView() {
    const cam = sceneCameraFromMap(map);
    const center = map.getCenter();
    const ground = state.terrain ? (map.queryTerrainElevation?.(center) ?? 0) : 0;
    return {
      lat: cam?.lat ?? center.lat,
      lon: cam?.lon ?? center.lng,
      alt: (cam?.alt ?? NaN) + ground,
      heading: cam ? (cam.heading + 360) % 360 : (map.getBearing() + 360) % 360,
      pitch: cam?.pitch ?? toCesiumPitch(map.getPitch()),
      roll: map.getRoll?.() ?? 0,
      zoom: map.getZoom(),
      targetLat: center.lat,
      targetLon: center.lng,
    };
  }

  function cameraOptionsFor({ lat, lon, alt, heading = 0, pitch = -90 }) {
    const view = mapViewForSceneCamera(map, { lat: Number(lat), lon: Number(lon), alt: Number(alt), heading, pitch });
    if (!view) throw new Error('câmera inválida');
    return view;
  }

  function beginFlight({ complete, cancel } = {}) {
    if (state.flight) {
      const prev = state.flight;
      state.flight = null;
      prev.cancel?.();
    }
    const flight = { complete, cancel, started: false };
    state.flight = flight;
    // Destino igual à vista atual: o MapLibre não se move e não há movestart.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.flight === flight && !flight.started && !map.isMoving()) finishFlight();
    }));
  }

  function setCameraView(view) {
    cancelFlight();
    map.jumpTo(cameraOptionsFor(view));
  }

  function flyToCamera(view, { duration = 3, complete, cancel, easing } = {}) {
    const opts = cameraOptionsFor(view);
    if (!(duration > 0)) {
      cancelFlight();
      map.jumpTo(opts);
      queueMicrotask(() => complete?.());
      return;
    }
    beginFlight({ complete, cancel });
    map.flyTo({ ...opts, duration: duration * 1000, essential: true, ...(easing ? { easing } : {}) });
  }

  /** Olhar para `target` de uma distância `rangeM` (metros em linha reta). */
  function cameraLookingAt({ lat, lon, height = 0 }, { rangeM = 20_000, heading = 0, pitch = -60 } = {}) {
    const p = Math.max(-90, Math.min(-5, Number(pitch)));
    const horizontal = rangeM * Math.cos(-p * DEG);
    const vertical = rangeM * Math.sin(-p * DEG);
    const cam = destinationPoint(lon, lat, (heading + 180) % 360, horizontal);
    return { lat: cam.lat, lon: cam.lon, alt: height + vertical, heading, pitch: p };
  }

  function flyToTarget(target, { rangeM, heading, pitch, duration = 3, complete, cancel } = {}) {
    flyToCamera(cameraLookingAt(target, { rangeM, heading, pitch }), { duration, complete, cancel });
  }

  function flyToBounds(bbox, { pitch = -90, heading = 0, padding = 60, duration = 2.6, complete, cancel, maxZoom = 16 } = {}) {
    beginFlight({ complete, cancel });
    map.fitBounds(bbox, {
      padding,
      pitch: toMapPitch(pitch),
      bearing: heading,
      duration: Math.max(0, duration) * 1000,
      essential: true,
      maxZoom,
    });
  }

  function cancelFlight() {
    if (state.flight) {
      const { cancel } = state.flight;
      state.flight = null;
      map.stop();
      cancel?.();
    }
  }

  // ---------------------------------------------------------- projeção

  function project(lon, lat, height = 0) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const p = map.project([lon, lat]);
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return null;
    let visible = true;
    if (state.globe && map.getZoom() < 7) {
      // Atrás do horizonte no globo: ângulo central entre o centro da vista e o ponto.
      const c = map.getCenter();
      const cosD =
        Math.sin(c.lat * DEG) * Math.sin(lat * DEG) + Math.cos(c.lat * DEG) * Math.cos(lat * DEG) * Math.cos((lon - c.lng) * DEG);
      if (cosD < 0.05) visible = false;
    }
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    if (p.x < -w || p.x > 2 * w || p.y < -h || p.y > 2 * h) visible = false;
    return { x: p.x, y: p.y, visible, height };
  }

  function unproject(x, y) {
    try {
      const ll = map.unproject([x, y]);
      return ll ? { lon: ll.lng, lat: ll.lat } : null;
    } catch {
      return null;
    }
  }

  function pick(x, y, { layers, radius = 0 } = {}) {
    const geom = radius > 0 ? [[x - radius, y - radius], [x + radius, y + radius]] : [x, y];
    const opts = layers ? { layers: layers.filter((id) => map.getLayer(id)) } : undefined;
    if (opts && !opts.layers.length) return [];
    return map.queryRenderedFeatures(geom, opts);
  }

  // ------------------------------------------------------- acompanhamento

  let trackRaf = null;
  function trackLoop() {
    trackRaf = null;
    const target = state.tracked;
    if (!target) return;
    const pos = target.getPosition?.();
    if (pos && Number.isFinite(pos.lon) && Number.isFinite(pos.lat) && !map.isMoving()) {
      map.jumpTo({ center: [pos.lon, pos.lat] });
    }
    trackRaf = requestAnimationFrame(trackLoop);
  }
  function track(target) {
    if (state.tracked === target) return;
    state.tracked = target || null;
    if (trackRaf) cancelAnimationFrame(trackRaf);
    trackRaf = null;
    if (state.tracked) trackRaf = requestAnimationFrame(trackLoop);
    emit('trackedchange', state.tracked);
  }
  map.on('dragstart', (e) => {
    if (e?.originalEvent && state.tracked && state.tracked.releaseOnDrag !== false) track(null);
  });

  // ---------------------------------------------- mapa base, globo, relevo

  function setBasemap(id, { esriLabels = state.esriLabels } = {}) {
    if (!BASEMAPS.some((b) => b.id === id)) return Promise.resolve(false);
    state.basemap = id;
    state.esriLabels = esriLabels;
    map.setStyle(buildBaseStyle(id, { esriLabels }), {
      // Transplanta tudo que é do app (fontes e layers `dg-`, relevo) para o estilo novo.
      transformStyle: (prev, style) => {
        const sources = { ...style.sources };
        for (const [sid, spec] of Object.entries(prev?.sources ?? {})) if (sid.startsWith('dg-')) sources[sid] = spec;
        const layers = [...style.layers, ...(prev?.layers ?? []).filter((l) => l.id.startsWith('dg-'))];
        return { ...style, sources, layers, terrain: prev?.terrain };
      },
    });
    return new Promise((resolve) =>
      map.once('style.load', () => {
        emit('basemapchange', { id });
        resolve(true);
      }),
    );
  }

  function setEsriLabels(visible) {
    state.esriLabels = Boolean(visible);
    if (map.getLayer('base-esri-labels')) map.setLayoutProperty('base-esri-labels', 'visibility', visible ? 'visible' : 'none');
  }

  function setGlobe(on) {
    state.globe = Boolean(on);
    map.setProjection({ type: state.globe ? 'globe' : 'mercator' });
  }

  function setTerrain(on, { exaggeration = 1.5 } = {}) {
    state.terrain = Boolean(on);
    if (on) {
      if (!map.getSource(TERRAIN_SOURCE)) map.addSource(TERRAIN_SOURCE, TERRAIN_SPEC);
      map.setTerrain({ source: TERRAIN_SOURCE, exaggeration });
    } else {
      map.setTerrain(null);
    }
  }

  function cameraHeightAboveGround() {
    const view = getCameraView();
    const ground = state.terrain ? map.queryTerrainElevation?.(map.getCenter()) ?? 0 : 0;
    return Number.isFinite(view.alt) ? Math.max(0, view.alt - ground) : NaN;
  }

  const engine = {
    kind: 'maplibre',
    map,
    maplibregl,
    get container() {
      return map.getContainer();
    },
    get canvas() {
      return map.getCanvas();
    },
    ready,
    BASEMAPS,
    getCameraView,
    setCameraView,
    flyToCamera,
    flyToTarget,
    flyToBounds,
    cameraLookingAt,
    cancelFlight,
    isMoving: () => map.isMoving(),
    project,
    unproject,
    pick,
    track,
    get trackedTarget() {
      return state.tracked;
    },
    on,
    requestRender: () => map.triggerRepaint(),
    getBasemap: () => state.basemap,
    setBasemap,
    getEsriLabels: () => state.esriLabels,
    setEsriLabels,
    isGlobe: () => state.globe,
    setGlobe,
    hasTerrain: () => state.terrain,
    setTerrain,
    cameraHeightAboveGround,
  };
  return engine;
}
