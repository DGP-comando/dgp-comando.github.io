/**
 * World-space annotation renderer (Direction A) — MapLibre.
 *
 * Desenha as marcas como fonte/layers GeoJSON do próprio mapa (prefixo `dg-`,
 * então sobrevivem à troca de mapa base: engine.setBasemap transplanta tudo que
 * começa com `dg-`). Por estarem no mapa, acompanham a câmera, o globo e o
 * relevo sem reprojeção manual.
 *
 *   área (distrito/parque/complexo) → preenchimento + contorno (tracejado quando
 *                                     sintetizado/aproximado)
 *   prédio isolado                   → extrusão translúcida (fill-extrusion) +
 *                                     contorno na base — equivalente 2,5D do
 *                                     volume de classificação que tingia a malha
 *                                     fotorrealista no Cesium
 *   rota                             → linha-base fraca + tracejado que "corre"
 *                                     em direção ao destino (dasharray animado)
 *   seta                             → linha do ponto de origem ao destino
 *   pin/destaque                     → anel de alvo (círculo) + ponto
 *
 * Os rótulos NÃO são desenhados aqui: o renderizador híbrido os põe como
 * callouts de tela (screenAnnotationRenderer), com um estilo só. Fade (alpha
 * da marca) vai nas propriedades das feições; o pulso é um fator global
 * aplicado por quadro nas opacidades (até ~20 quadros/s, só com marcas vivas).
 *
 * Renderer contract (shared with the screen-space renderer):
 *   add(anno) / remove(anno) / sync(map) / destroy()
 */

const PALETTE = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

export const ANNOTATION_SOURCE_ID = 'dg-annotations';

/** Ids da fonte e dos layers de UMA instância (a primeira usa `dg-annotations`). */
export function annotationLayerIds(sourceId = ANNOTATION_SOURCE_ID) {
  return Object.freeze({
    fill: `${sourceId}-fill`,
    extrusion: `${sourceId}-extrusion`,
    outline: `${sourceId}-outline`,
    outlineDashed: `${sourceId}-outline-dashed`,
    routeBase: `${sourceId}-route-base`,
    routeFlow: `${sourceId}-route-flow`,
    arrow: `${sourceId}-arrow`,
    ring: `${sourceId}-ring`,
    dot: `${sourceId}-dot`,
  });
}
export const ANNOTATION_LAYER_IDS = annotationLayerIds();
// Cada renderizador tem a sua fonte: dois quadros (ex.: bancada + app) não se sobrescrevem.
let instanceCount = 0;

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const PULSE_FRAME_MS = 50;
// Sequência de tracejados que, percorrida em ordem, faz o padrão "andar" ao
// longo da linha (técnica padrão do MapLibre para linhas animadas).
const FLOW_DASHES = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

/** Anel fechado [[lon,lat],…] (primeiro vértice repetido no fim). */
function closedRing(ring) {
  const pts = ring.map(([lon, lat]) => [Number(lon), Number(lat)]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) pts.push([first[0], first[1]]);
  return pts;
}

/**
 * Feições GeoJSON de UMA marca (puro, testável). `alpha` é o fade atual.
 * @param {object} anno Marca (ou proxy do híbrido).
 * @returns {object[]} Feições com propriedades `kind`, `color`, `a`.
 */
export function annotationWorldFeatures(anno) {
  const color = PALETTE[anno?.color] || PALETTE.primary;
  const a = Math.max(0, Math.min(1, Number(anno?.alpha ?? 1)));
  const id = String(anno?.id ?? '');
  const props = (kind, extra = {}) => ({ annoId: id, kind, color, a, ...extra });
  const out = [];
  if (anno?.ring && anno.ring.length >= 3) {
    const ring = closedRing(anno.ring);
    if (anno.footprintKind === 'building') {
      const heightM = Math.max(18, Number(anno.buildingHeight) || 25) + 6;
      out.push({ type: 'Feature', properties: props('building', { heightM }), geometry: { type: 'Polygon', coordinates: [ring] } });
      out.push({ type: 'Feature', properties: props('outline', { width: 3 }), geometry: { type: 'LineString', coordinates: ring } });
    } else {
      out.push({
        type: 'Feature',
        properties: props('area', { fillAlpha: anno.synthesized ? 0.1 : 0.2 }),
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
      out.push({
        type: 'Feature',
        properties: props(anno.synthesized ? 'outline-dashed' : 'outline', { width: anno.synthesized ? 4 : 5 }),
        geometry: { type: 'LineString', coordinates: ring },
      });
    }
  } else if (anno?.type === 'route' && Array.isArray(anno.path) && anno.path.length >= 2) {
    const coords = anno.path.map((p) => [Number(p.lon), Number(p.lat)]);
    out.push({ type: 'Feature', properties: props('route'), geometry: { type: 'LineString', coordinates: coords } });
  } else if (anno?.type === 'arrow' && anno.to && anno.anchor) {
    out.push({
      type: 'Feature',
      properties: props('arrow'),
      geometry: { type: 'LineString', coordinates: [[anno.anchor.lon, anno.anchor.lat], [anno.to.lon, anno.to.lat]] },
    });
  } else if (anno?.anchor && Number.isFinite(anno.anchor.lon) && Number.isFinite(anno.anchor.lat)) {
    const point = { type: 'Point', coordinates: [anno.anchor.lon, anno.anchor.lat] };
    if (anno.type !== 'label') out.push({ type: 'Feature', properties: props('ring'), geometry: point });
    out.push({ type: 'Feature', properties: props('dot', { small: anno.type === 'label' ? 1 : 0 }), geometry: point });
  }
  return out;
}

/** Especificações dos layers (em ordem de desenho). `pulse` = fator 0.6..1. */
export function annotationLayerSpecs(pulse = 1, src = ANNOTATION_SOURCE_ID) {
  const L = annotationLayerIds(src);
  const byKind = (...kinds) => ['match', ['get', 'kind'], kinds, true, false];
  return [
    {
      id: L.fill, type: 'fill', source: src, filter: byKind('area'),
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['*', ['get', 'a'], ['get', 'fillAlpha'], pulse] },
    },
    {
      id: L.extrusion, type: 'fill-extrusion', source: src, filter: byKind('building'),
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'heightM'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.45 * pulse,
      },
    },
    {
      id: L.outline, type: 'line', source: src, filter: byKind('outline'),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['*', ['get', 'a'], 0.95], 'line-blur': 0.6 },
    },
    {
      id: L.outlineDashed, type: 'line', source: src, filter: byKind('outline-dashed'),
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['*', ['get', 'a'], 0.95], 'line-dasharray': [3, 2] },
    },
    {
      id: L.routeBase, type: 'line', source: src, filter: byKind('route'),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 9, 'line-opacity': ['*', ['get', 'a'], 0.22] },
    },
    {
      id: L.routeFlow, type: 'line', source: src, filter: byKind('route'),
      layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': ['*', ['get', 'a'], 0.95], 'line-dasharray': FLOW_DASHES[0] },
    },
    {
      id: L.arrow, type: 'line', source: src, filter: byKind('arrow'),
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': ['*', ['get', 'a'], 0.9] },
    },
    {
      id: L.ring, type: 'circle', source: src, filter: byKind('ring'),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 22, 18, 34],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['*', ['get', 'a'], 0.3, pulse],
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2,
        'circle-stroke-opacity': ['*', ['get', 'a'], 0.8],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: L.dot, type: 'circle', source: src, filter: byKind('dot'),
      paint: {
        'circle-radius': ['case', ['==', ['get', 'small'], 1], 4, 7],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'a'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
        'circle-stroke-opacity': ['*', ['get', 'a'], 0.95],
      },
    },
  ];
}

function pulseFactor(nowMs) {
  // 0.6 .. 1.0 sinusoid at ~0.8 Hz
  return 0.8 + 0.2 * Math.sin(nowMs * 0.005);
}

export function createWorldAnnotationRenderer(viewer) {
  const engine = viewer;
  const map = engine?.map || null;
  const marks = new Map(); // anno (ou proxy) -> true, na ordem de chegada
  let raf = null;
  let lastPulseMs = 0;
  let flowStep = 0;
  let destroyed = false;
  const sourceId = instanceCount === 0 ? ANNOTATION_SOURCE_ID : `${ANNOTATION_SOURCE_ID}-${instanceCount}`;
  instanceCount += 1;
  const L = annotationLayerIds(sourceId);

  function ensureLayers() {
    if (!map || destroyed) return false;
    try {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: EMPTY });
      }
      for (const spec of annotationLayerSpecs(1, sourceId)) {
        // Sem beforeId: por cima das camadas de dados (que entram sob as âncoras do layerHost).
        if (!map.getLayer(spec.id)) map.addLayer(spec);
      }
      return true;
    } catch {
      return false; // estilo ainda carregando
    }
  }

  function writeData() {
    if (!ensureLayers()) return;
    const features = [];
    for (const anno of marks.keys()) features.push(...annotationWorldFeatures(anno));
    try {
      map.getSource(sourceId)?.setData({ type: 'FeatureCollection', features });
    } catch { /* estilo trocando */ }
    engine.requestRender?.();
  }

  function applyPulse(nowMs) {
    if (!map) return;
    const pulse = pulseFactor(nowMs);
    try {
      if (map.getLayer(L.fill)) map.setPaintProperty(L.fill, 'fill-opacity', ['*', ['get', 'a'], ['get', 'fillAlpha'], pulse]);
      if (map.getLayer(L.extrusion)) map.setPaintProperty(L.extrusion, 'fill-extrusion-opacity', 0.45 * pulse);
      if (map.getLayer(L.ring)) map.setPaintProperty(L.ring, 'circle-opacity', ['*', ['get', 'a'], 0.3, pulse]);
      if (map.getLayer(L.routeFlow)) {
        flowStep = (flowStep + 1) % FLOW_DASHES.length;
        map.setPaintProperty(L.routeFlow, 'line-dasharray', FLOW_DASHES[flowStep]);
      }
    } catch { /* estilo trocando */ }
  }

  function loop(nowMs) {
    raf = null;
    if (destroyed || !marks.size) return;
    if (!(nowMs - lastPulseMs < PULSE_FRAME_MS)) {
      lastPulseMs = nowMs;
      applyPulse(nowMs);
    }
    raf = globalThis.requestAnimationFrame?.(loop) ?? null;
  }

  function startLoop() {
    if (raf == null && marks.size && typeof globalThis.requestAnimationFrame === 'function') {
      raf = globalThis.requestAnimationFrame(loop);
    }
  }

  // Troca de mapa base: o engine transplanta `dg-*`, mas refaz se faltar algo.
  const removeBasemapListener = typeof engine?.on === 'function'
    ? engine.on('basemapchange', () => { if (marks.size) writeData(); })
    : () => {};

  function add(anno) {
    marks.set(anno, true);
    writeData();
    startLoop();
  }

  function remove(anno) {
    if (!marks.delete(anno)) return;
    writeData();
    if (!marks.size && raf != null) {
      globalThis.cancelAnimationFrame?.(raf);
      raf = null;
    }
  }

  function sync() {
    // Fade (alpha) mudou: reescreve as propriedades das feições.
    if (marks.size) writeData();
  }

  function destroy() {
    destroyed = true;
    if (raf != null) globalThis.cancelAnimationFrame?.(raf);
    raf = null;
    marks.clear();
    try { removeBasemapListener(); } catch { /* ok */ }
    if (!map) return;
    try {
      for (const spec of annotationLayerSpecs(1, sourceId).reverse()) if (map.getLayer(spec.id)) map.removeLayer(spec.id);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch { /* mapa desmontado */ }
  }

  return { add, remove, sync, destroy };
}
