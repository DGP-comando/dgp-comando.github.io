// src/maplibre/managerAdapter.js
//
// Transforma uma definição de camada MapLibre (contrato em kit.js) num módulo
// do DataLayerManager (src/data/manager.js): o mesmo painel CAMADAS DE DADOS,
// estados LIGAR/DESLIGADA, "há X min", erro/nova tentativa, chips e legenda,
// estado salvo e tokens de link continuam valendo sem mudança no manager.
//
// Contrato do manager atendido: id, name, category, icon, source,
// updateInterval, init/enable/disable/update/destroy, getStats,
// getRowControls, getParams/setParams, focusOn.

import { getActiveLayerHost } from './layerHost.js';

const IDLE_TIMEOUT_MS = 20000;

function waitIdle(map) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), IDLE_TIMEOUT_MS);
    map.once('idle', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * @param {object} def definição validada por defineLayer (kit.js)
 * @param {ReturnType<import('./layerHost.js').createLayerHost>} host
 */
export function toManagerModule(def, host) {
  host.register(def);
  const st = {
    count: null,
    info: null,
    error: null,
    lastUpdate: null,
    loading: false,
    loaded: false,
    firstLoadMs: null,
  };
  const ctx = host.ctx;

  // Camadas dinâmicas (células por viewport) atualizam a contagem sozinhas.
  const report = ({ count, info } = {}) => {
    if (count != null) st.count = count;
    if (info !== undefined) st.info = info;
    host.onPanelRefresh?.();
  };
  reporters.set(def.id, report);

  return {
    id: def.id,
    name: def.name,
    category: def.category,
    icon: def.icon,
    source: def.source,
    // 0 = sem refresh periódico: o manager só repinta a linha (statsRefreshInterval).
    updateInterval: Number(def.refreshMs) > 0 ? Number(def.refreshMs) : 0,
    statsRefreshInterval: 5000,
    maplibre: true,

    init() {
      host.ensureAdded(def);
      return true;
    },

    async enable() {
      host.setVisible(def.id, true);
      await def.onEnable?.(ctx);
      if (host.focus) def.focusOn?.(host.focus, ctx);
      return true;
    },

    async disable() {
      host.setVisible(def.id, false);
      await def.onDisable?.(ctx);
      return true;
    },

    async update() {
      // Dado estático já carregado: religar não baixa de novo.
      if (st.loaded && !(Number(def.refreshMs) > 0)) return true;
      const first = !st.loaded;
      const t0 = performance.now();
      st.loading = true;
      try {
        let result = null;
        if (def.load) result = await def.load(ctx);
        else if (def.count) result = await def.count(ctx);
        if (typeof result === 'number') st.count = result;
        else if (result && typeof result === 'object') {
          if (result.count != null) st.count = result.count;
          if (result.info !== undefined) st.info = result.info;
        }
        if (first) await waitIdle(ctx.map);
        st.error = null;
        st.loaded = true;
        st.lastUpdate = Date.now();
        if (first) st.firstLoadMs = performance.now() - t0;
        return true;
      } catch (err) {
        console.warn(`[maplibre:${def.id}]`, err);
        st.error = err?.message || String(err);
        return false;
      } finally {
        st.loading = false;
      }
    },

    destroy() {
      host.setVisible(def.id, false);
      return true;
    },

    getStats() {
      return {
        count: st.count ?? 0,
        lastUpdate: st.lastUpdate,
        error: st.error,
        loading: st.loading,
        source: st.info ? `${def.source ?? ''} · ${st.info}` : def.source,
        firstLoadMs: st.firstLoadMs,
      };
    },

    getRowControls() {
      if (!def.rowControls) return null;
      const controls = def.rowControls(ctx) ?? {};
      return {
        chips: (controls.chips ?? []).map((c) => ({ ...c, params: { chip: c.id } })),
        legend: (controls.legend ?? []).map((l) => ({ ...l, count: l.count ?? '' })),
      };
    },

    getParams() {
      return {};
    },

    setParams(params = {}) {
      if (params.chip != null) def.onChip?.(params.chip, ctx);
      return true;
    },

    focusOn(bbox) {
      if (host.isVisible(def.id)) def.focusOn?.(bbox ?? null, ctx);
    },
  };
}

/**
 * Igual a toManagerModule, mas liga ao anfitrião só no `init` (para módulos de
 * camada exportados como singletons e importados antes do boot criar o mapa,
 * como as camadas do GEV). `extra` acrescenta a API pública própria da camada
 * (métodos que ui.js, voz ou detecção chamam); ela recebe o ctx quando existir.
 *   export default lazyManagerModule(def, { setTrackedAircraft(id) {...} })
 */
export function lazyManagerModule(def, extra = {}) {
  let inner = null;
  const bind = () => {
    if (inner) return inner;
    const host = getActiveLayerHost();
    if (!host) throw new Error(`[maplibre:${def.id}] anfitrião de camadas ainda não existe`);
    inner = toManagerModule(def, host);
    return inner;
  };
  const proxy = {
    id: def.id,
    name: def.name,
    category: def.category,
    icon: def.icon,
    source: def.source,
    updateInterval: Number(def.refreshMs) > 0 ? Number(def.refreshMs) : 0,
    statsRefreshInterval: 5000,
    maplibre: true,
    get ctx() {
      return getActiveLayerHost()?.ctx ?? null;
    },
  };
  for (const name of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getRowControls', 'getParams', 'setParams', 'focusOn']) {
    proxy[name] = (...args) => {
      if (name === 'getStats' && !inner) return { count: 0, lastUpdate: null, error: null, loading: false, source: def.source };
      if (name === 'getRowControls' && !inner) return null;
      return bind()[name](...args);
    };
  }
  return Object.assign(proxy, extra);
}

const reporters = new Map();
/** Para camadas dinâmicas: `reportLayerStats(id, {count, info})` atualiza a linha do painel. */
export function reportLayerStats(id, stats) {
  reporters.get(id)?.(stats);
}
