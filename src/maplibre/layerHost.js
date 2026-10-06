// src/maplibre/layerHost.js
//
// Anfitrião das camadas no mapa: adiciona fontes/layers de estilo das
// definições (contrato em kit.js) encaixadas em faixas verticais, liga e
// desliga a visibilidade, e atende com UM handler o hover (tooltip,
// feature-state) e o clique de todas as camadas interativas. O ciclo de vida
// (quando carregar, refresh, painel) é do DataLayerManager (src/data/manager.js)
// via o adaptador managerAdapter.js.

// Faixas verticais: cada layer entra logo abaixo da âncora da sua faixa, então
// polígonos ficam sob linhas, linhas sob pontos e pontos sob rótulos, qualquer
// que seja a ordem em que as camadas são ligadas.
const SLOTS = ['fill', 'line', 'point', 'label'];
const SLOT_OF_TYPE = {
  fill: 'fill', 'fill-extrusion': 'fill', raster: 'fill', heatmap: 'fill', hillshade: 'fill', 'color-relief': 'fill',
  line: 'line', circle: 'point', symbol: 'label',
};
const anchorId = (slot) => `dg-slot-${slot}`;

let tooltipEl = null;
function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.getElementById('dg-tooltip');
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'dg-tooltip';
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

let activeHost = null;
/** Anfitrião criado no boot (main.js); módulos importados antes dele o pedem aqui. */
export function getActiveLayerHost() {
  return activeHost;
}

export function createLayerHost(engine) {
  const { map } = engine;
  const defs = new Map(); // id -> def
  const on = new Set(); // ids visíveis
  const byInteractiveLayer = new Map();
  let focus = null;

  const ctx = {
    map,
    engine,
    setData(sourceId, data) {
      map.getSource(sourceId)?.setData(data);
    },
    refreshPanel: () => host.onPanelRefresh?.(),
    getLayer: (id) => defs.get(id),
    isOn: (id) => on.has(id),
    get focus() {
      return focus;
    },
  };

  function ensureAnchors() {
    if (!map.getSource('dg-slot')) map.addSource('dg-slot', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const slot of SLOTS) {
      if (!map.getLayer(anchorId(slot))) map.addLayer({ id: anchorId(slot), type: 'circle', source: 'dg-slot' });
    }
  }

  function register(def) {
    defs.set(def.id, def);
    for (const lid of def.interactive ?? []) byInteractiveLayer.set(lid, def);
  }

  function ensureAdded(def) {
    ensureAnchors();
    for (const [id, spec] of Object.entries(def.sources ?? {})) {
      if (!map.getSource(id)) map.addSource(id, spec);
    }
    for (const layer of def.layers ?? []) {
      if (map.getLayer(layer.id)) continue;
      const slot = layer.metadata?.['dg:slot'] ?? SLOT_OF_TYPE[layer.type] ?? 'point';
      map.addLayer({ ...layer, layout: { ...layer.layout, visibility: on.has(def.id) ? 'visible' : 'none' } }, anchorId(slot));
    }
  }

  function setVisible(id, visible) {
    const def = defs.get(id);
    if (!def) return;
    if (visible) on.add(id);
    else on.delete(id);
    ensureAdded(def);
    for (const layer of def.layers ?? []) {
      if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
    if (!visible) hideTooltip();
  }

  function setFocus(bbox) {
    focus = bbox;
    for (const id of on) defs.get(id)?.focusOn?.(bbox, ctx);
  }

  // ------------------------------------------------------ tooltip e clique

  let hovered = null;
  let pending = null;
  let lastPoint = null;

  function hideTooltip() {
    if (tooltipEl) tooltipEl.hidden = true;
  }

  function interactiveIds() {
    const ids = [];
    for (const [lid, def] of byInteractiveLayer) if (on.has(def.id) && map.getLayer(lid)) ids.push(lid);
    return ids;
  }

  // Todas as camadas interativas sob o ponto, de cima para baixo, uma por
  // definição. O preenchimento dos municípios (camada-base, `underlay`) fica
  // ligado quase sempre: sem esta lista ele venceria todo pick e esconderia o
  // tooltip das camadas embaixo dele (o "drill" do app Cesium).
  function hitsAt(point) {
    const ids = interactiveIds();
    if (!ids.length) return [];
    const hits = [];
    const seen = new Set();
    for (const feature of map.queryRenderedFeatures([point.x, point.y], { layers: ids })) {
      const def = byInteractiveLayer.get(feature.layer.id);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      hits.push({ feature, def });
    }
    return hits;
  }

  /**
   * Quem responde ao hover: a camada mais alta que não é base e tem tooltip;
   * senão uma base com tooltip (grades de clima); senão a mais alta.
   */
  function hoverHit(hits) {
    return hits.find((h) => !h.def.underlay && h.def.tooltip)
      ?? hits.find((h) => !h.def.underlay)
      ?? hits.find((h) => h.def.tooltip)
      ?? hits[0]
      ?? null;
  }

  function pickDef(point) {
    return hoverHit(hitsAt(point));
  }

  function setHover(next) {
    if (hovered && (hovered.source !== next?.source || hovered.id !== next?.id)) {
      if (map.getSource(hovered.source)) map.setFeatureState(hovered, { hover: false });
      hovered = null;
    }
    if (next && !hovered) {
      hovered = next;
      map.setFeatureState(hovered, { hover: true });
    }
  }

  function updateHover() {
    pending = null;
    if (!lastPoint) return;
    const hit = pickDef(lastPoint);
    if (hit?.def.hoverState && hit.feature.id != null) setHover({ source: hit.def.hoverState, id: hit.feature.id });
    else setHover(null);
    const html = hit?.def.tooltip?.(hit.feature.properties ?? {}, hit.feature, ctx);
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
    const tip = ensureTooltip();
    if (!html) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const box = map.getContainer().getBoundingClientRect();
    const px = box.left + lastPoint.x;
    const py = box.top + lastPoint.y;
    const x = px + 16 + rect.width > window.innerWidth ? px - rect.width - 12 : px + 16;
    const y = py + 16 + rect.height > window.innerHeight ? py - rect.height - 12 : py + 16;
    tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  map.on('mousemove', (e) => {
    lastPoint = e.point;
    // Nada de pick com a câmera andando (mesma regra do app Cesium).
    if (map.isMoving()) return;
    pending ??= requestAnimationFrame(updateHover);
  });
  map.on('movestart', hideTooltip);
  map.on('mouseout', () => {
    lastPoint = null;
    setHover(null);
    hideTooltip();
  });
  map.on('styledata', () => {
    hovered = null;
  });
  map.on('click', (e) => {
    const hits = hitsAt(e.point);
    const top = hits.find((h) => !h.def.underlay && h.def.click);
    const base = hits.find((h) => h.def.underlay && h.def.click);
    const fire = (h) => h.def.click(h.feature.properties ?? {}, h.feature, ctx);
    if (top && !top.def.clickWithUnderlay) {
      fire(top);
      return;
    }
    // Ponto ou linha sem clique por cima segura o clique; polígonos sem clique
    // (terras indígenas, assentamentos...) deixam a ficha municipal abrir.
    const blocked = hits.some((h) => !h.def.underlay && !h.def.click && h.feature.layer.type !== 'fill');
    if (base && !blocked) fire(base);
    // Depois da base: o card desta camada sobrepõe a ficha do município.
    if (top) setTimeout(() => fire(top), 0);
  });

  const host = {
    ctx,
    register,
    ensureAdded,
    ensureAnchors,
    setVisible,
    isVisible: (id) => on.has(id),
    setFocus,
    get focus() {
      return focus;
    },
    hideTooltip,
    /** Definição da camada interativa sob (x, y), para quem arbitra cliques. */
    pickAt: (x, y) => pickDef({ x, y }),
    onPanelRefresh: null,
  };
  activeHost = host;
  return host;
}
