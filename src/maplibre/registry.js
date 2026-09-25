// src/maplibre/registry.js
//
// Ciclo de vida das camadas do protótipo (contrato em kit.js) e o painel
// CAMADAS DE DADOS: grupos por categoria na ordem do app, contagem, tempo de
// carga, legenda e chips por linha. Um único handler de mousemove/click
// atende o tooltip e o clique de todas as camadas.

import { esc } from './kit.js';

// Faixas verticais: cada layer entra logo abaixo da âncora da sua faixa, então
// polígonos ficam sob linhas, linhas sob pontos e pontos sob rótulos, qualquer
// que seja a ordem em que as camadas são ligadas.
const SLOTS = ['fill', 'line', 'point', 'label'];
const SLOT_OF_TYPE = {
  fill: 'fill', 'fill-extrusion': 'fill', raster: 'fill', heatmap: 'fill', hillshade: 'fill',
  line: 'line', circle: 'point', symbol: 'label',
};
const anchorId = (slot) => `dg-slot-${slot}`;

export function createRegistry(map, defs, { tooltipEl, panelEl, onChange } = {}) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const state = new Map(); // id -> {on, added, loading, ms, count, info, error, timer}
  const byInteractiveLayer = new Map();
  for (const def of defs) {
    state.set(def.id, { on: false, added: false });
    for (const lid of def.interactive) byInteractiveLayer.set(lid, def);
  }
  let focus = null;

  const ctx = {
    map,
    setData(sourceId, data) {
      map.getSource(sourceId)?.setData(data);
    },
    refreshPanel: () => renderPanel(),
    getLayer: (id) => byId.get(id),
    isOn: (id) => Boolean(state.get(id)?.on),
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

  function ensureAdded(def) {
    ensureAnchors();
    for (const [id, spec] of Object.entries(def.sources)) {
      if (!map.getSource(id)) map.addSource(id, spec);
    }
    for (const layer of def.layers) {
      if (map.getLayer(layer.id)) continue;
      const slot = layer.metadata?.['dg:slot'] ?? SLOT_OF_TYPE[layer.type] ?? 'point';
      map.addLayer({ ...layer, layout: { ...layer.layout, visibility: 'none' } }, anchorId(slot));
    }
    state.get(def.id).added = true;
  }

  // Ocioso = fontes e tiles desenhados. Teto de 20 s para uma rede ruim de
  // mapa base não prender a contagem da camada em "carregando".
  const idle = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20000);
      map.once('idle', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  async function runLoad(def, { first }) {
    const st = state.get(def.id);
    const t0 = performance.now();
    if (first) st.loading = true;
    renderPanel();
    try {
      let result = null;
      if (def.load) result = await def.load(ctx);
      else if (def.count) result = await def.count(ctx);
      if (first && !(await idle())) st.info = 'tiles ainda carregando';
      if (typeof result === 'number') st.count = result;
      else if (result && typeof result === 'object') {
        if (result.count != null) st.count = result.count;
        if (result.info != null) st.info = result.info;
      }
      st.error = null;
      if (first) st.ms = performance.now() - t0;
    } catch (err) {
      console.warn(`[maplibre:${def.id}]`, err);
      st.error = err?.message || String(err);
    } finally {
      st.loading = false;
      renderPanel();
    }
  }

  async function setEnabled(id, on) {
    const def = byId.get(id);
    const st = state.get(id);
    if (!def || st.on === on) return;
    st.on = on;
    const first = on && !st.added;
    if (on) ensureAdded(def);
    for (const layer of def.layers) {
      if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', on ? 'visible' : 'none');
    }
    clearInterval(st.timer);
    st.timer = null;
    onChange?.();
    if (on) {
      try {
        await def.onEnable?.(ctx);
        if (focus) def.focusOn?.(focus, ctx);
      } catch (err) {
        console.warn(`[maplibre:${id}] onEnable`, err);
      }
      const needsLoad = first || def.refreshMs;
      if (needsLoad) await runLoad(def, { first });
      if (def.refreshMs && st.on) {
        st.timer = setInterval(() => {
          if (!document.hidden) runLoad(def, { first: false });
        }, def.refreshMs);
      }
    } else {
      try {
        await def.onDisable?.(ctx);
      } catch (err) {
        console.warn(`[maplibre:${id}] onDisable`, err);
      }
      tooltipEl.hidden = true;
    }
    renderPanel();
  }

  function setFocus(bbox) {
    focus = bbox;
    for (const def of defs) {
      if (def.focusOn && state.get(def.id).on) def.focusOn(bbox, ctx);
    }
  }

  // ------------------------------------------------------------------ painel

  function metaHtml(def, st) {
    if (st.loading) return 'carregando…';
    if (st.error) return `<span class="err">erro: ${esc(st.error)}</span>`;
    const parts = [];
    if (st.count != null) parts.push(`${Number(st.count).toLocaleString('pt-BR')}`);
    if (st.ms != null) parts.push(`<b>${Math.round(st.ms)} ms</b>`);
    if (st.info) parts.push(esc(st.info));
    return parts.length ? parts.join(' · ') : esc(def.source ?? '');
  }

  function controlsHtml(def) {
    if (!def.rowControls || !state.get(def.id).on) return '';
    let controls;
    try {
      controls = def.rowControls(ctx) ?? {};
    } catch (err) {
      console.warn(`[maplibre:${def.id}] rowControls`, err);
      return '';
    }
    const chips = (controls.chips ?? [])
      .map((c) => `<button type="button" class="chip ${c.active ? 'on' : ''}" data-chip="${esc(c.id)}" data-layer="${esc(def.id)}">${esc(c.label)}</button>`)
      .join('');
    const legend = (controls.legend ?? [])
      .map(
        (l) => `<span class="legend-item"><i style="background:${esc(l.color)}"></i>${esc(l.label)}${
          l.count != null ? ` <em>${Number(l.count).toLocaleString('pt-BR')}</em>` : ''
        }</span>`,
      )
      .join('');
    return `${chips ? `<div class="chips">${chips}</div>` : ''}${legend ? `<div class="legend">${legend}</div>` : ''}`;
  }

  function renderPanel() {
    if (!panelEl) return;
    const groups = new Map();
    for (const def of defs) {
      if (!groups.has(def.category)) groups.set(def.category, []);
      groups.get(def.category).push(def);
    }
    const open = new Set([...panelEl.querySelectorAll('details[open]')].map((d) => d.dataset.cat));
    const firstRender = !panelEl.childElementCount;
    panelEl.innerHTML = [...groups.entries()]
      .map(([cat, list]) => {
        const nOn = list.filter((d) => state.get(d.id).on).length;
        const isOpen = firstRender ? nOn > 0 || cat === 'Limites' : open.has(cat);
        return `<details data-cat="${esc(cat)}" ${isOpen ? 'open' : ''}>
          <summary>${esc(cat)}<span class="n">${nOn ? `${nOn}/` : ''}${list.length}</span></summary>
          ${list
            .map((def) => {
              const st = state.get(def.id);
              return `<div class="layer ${st.on ? 'on' : ''}">
                <label><input type="checkbox" data-layer="${esc(def.id)}" ${st.on ? 'checked' : ''}/>
                <span><span class="name">${def.icon ? `<span class="ic">${esc(def.icon)}</span>` : ''}${esc(def.name)}</span>
                <span class="meta">${metaHtml(def, st)}</span></span></label>
                ${controlsHtml(def)}
              </div>`;
            })
            .join('')}
        </details>`;
      })
      .join('');
  }

  panelEl?.addEventListener('change', (e) => {
    const id = e.target.dataset?.layer;
    if (id && e.target.type === 'checkbox') setEnabled(id, e.target.checked);
  });
  panelEl?.addEventListener('click', (e) => {
    const chip = e.target.closest?.('[data-chip]');
    if (!chip) return;
    const def = byId.get(chip.dataset.layer);
    Promise.resolve(def?.onChip?.(chip.dataset.chip, ctx)).finally(renderPanel);
  });

  // ------------------------------------------------------ tooltip e clique

  let hovered = null;
  let pending = null;
  let lastPoint = null;

  function interactiveIds() {
    const ids = [];
    for (const [lid, def] of byInteractiveLayer) {
      if (state.get(def.id).on && map.getLayer(lid)) ids.push(lid);
    }
    return ids;
  }

  function pick(point) {
    const ids = interactiveIds();
    if (!ids.length) return null;
    const [feature] = map.queryRenderedFeatures(point, { layers: ids });
    return feature ? { feature, def: byInteractiveLayer.get(feature.layer.id) } : null;
  }

  function setHover(next) {
    if (hovered && (hovered.source !== next?.source || hovered.id !== next?.id)) {
      map.setFeatureState(hovered, { hover: false });
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
    const hit = pick(lastPoint);
    if (hit?.def.hoverState && hit.feature.id != null) {
      setHover({ source: hit.def.hoverState, id: hit.feature.id });
    } else setHover(null);
    const html = hit?.def.tooltip?.(hit.feature.properties ?? {}, hit.feature, ctx);
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
    if (!html) {
      tooltipEl.hidden = true;
      return;
    }
    tooltipEl.innerHTML = html;
    tooltipEl.hidden = false;
    const { innerWidth: w, innerHeight: h } = window;
    const rect = tooltipEl.getBoundingClientRect();
    const x = lastPoint.x + 16 + rect.width > w ? lastPoint.x - rect.width - 12 : lastPoint.x + 16;
    const y = lastPoint.y + 16 + rect.height > h ? lastPoint.y - rect.height - 12 : lastPoint.y + 16;
    tooltipEl.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  map.on('mousemove', (e) => {
    lastPoint = e.point;
    // Nada de pick com a câmera andando (mesma regra do app Cesium).
    if (map.isMoving()) return;
    pending ??= requestAnimationFrame(updateHover);
  });
  map.on('movestart', () => {
    tooltipEl.hidden = true;
  });
  map.on('mouseout', () => {
    lastPoint = null;
    setHover(null);
    tooltipEl.hidden = true;
  });
  map.on('styledata', () => {
    hovered = null;
  });
  map.on('click', (e) => {
    const hit = pick(e.point);
    if (hit?.def.click) hit.def.click(hit.feature.properties ?? {}, hit.feature, ctx);
  });

  return {
    ctx,
    defs,
    setEnabled,
    setFocus,
    isOn: (id) => Boolean(state.get(id)?.on),
    enabledIds: () => defs.filter((d) => state.get(d.id).on).map((d) => d.id),
    ensureAnchors,
    renderPanel,
    stats: (id) => ({ ...state.get(id) }),
  };
}
