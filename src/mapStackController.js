import { governorRequestRender } from './renderGovernor.js';
import { BASEMAPS } from './maplibre/basemaps.js';

/**
 * MAPA BASE sobre o MapLibre (src/maplibre/engine.js).
 *
 * Os stacks são os mapas base do motor (`engine.BASEMAPS`): Satélite (Esri
 * World Imagery, com os rótulos "Boundaries and Places" por cima), OSM raster
 * e OSM vetorial (OpenFreeMap). Nenhum pede chave. Além do mapa base, o
 * controlador guarda três chaves de apresentação: rótulos do satélite,
 * globo/2D (projeção) e relevo 3D.
 *
 * Ids da era Cesium (`photoreal`, `bing-aerial`, `bing-labels`) continuam
 * aceitos — links antigos, cenas e voz — e caem em `esri`
 * (`normalizeStackId`).
 */
const SHORT_LABELS = { esri: 'SAT', osm: 'OSM', 'osm-vector': 'VET' };

export const MAP_STACKS = BASEMAPS.map((basemap) => Object.freeze({
  id: basemap.id,
  label: basemap.label,
  shortLabel: SHORT_LABELS[basemap.id] || basemap.label,
  hint: basemap.hint,
  kind: basemap.id,
  requiresIon: false,
}));

/** Ids retirados com o Cesium e o mapa base que os substitui. */
export const LEGACY_STACK_IDS = Object.freeze({
  photoreal: 'esri',
  'bing-aerial': 'esri',
  'bing-labels': 'esri',
});

/**
 * Id de stack válido para um id qualquer (inclusive os legados). Desconhecido
 * vira `esri`, o padrão.
 * @param {string} id
 * @returns {string}
 */
export function normalizeStackId(id) {
  const raw = String(id ?? '').trim();
  if (MAP_STACKS.some((stack) => stack.id === raw)) return raw;
  return LEGACY_STACK_IDS[raw] || 'esri';
}

export class MapStackController {
  constructor(engine, {
    initialStack = null,
    onChange = null,
    onError = null,
  } = {}) {
    this.viewer = engine;
    this.engine = engine;
    this._onChange = onChange;
    this._onError = onError;
    this._activeId = normalizeStackId(initialStack || engine?.getBasemap?.() || 'esri');
    this._isSwitching = false;
    this._lastError = null;
    // Monotonic switch counter: a rapid A→B switch where A resolves after B
    // must not revert the user's last choice. Each call captures a generation
    // and aborts its own commit once superseded.
    this._switchGen = 0;
  }

  getStacks() {
    return MAP_STACKS.map((stack) => {
      const available = this.isStackAvailable(stack.id);
      return {
        ...stack,
        available,
        // Why this stack can't be picked, from the ONE place that decides it.
        unavailableReason: available ? null : this._unavailableReason(stack),
      };
    });
  }

  /**
   * Human-readable reason a stack can't be activated. Shared by `getStacks()`
   * and `setStack()` so the tooltip and the toast never drift apart.
   * @param {object} stack - Stack descriptor.
   * @returns {string}
   */
  _unavailableReason(stack) {
    return stack?.requiresIon
      ? 'Chave necessária para este mapa base'
      : `${stack?.label || 'Este mapa base'} indisponível`;
  }

  getStack(id) {
    return MAP_STACKS.find((stack) => stack.id === id) || null;
  }

  getActiveId() {
    return this._activeId;
  }

  /**
   * Monotonic id of the most recently STARTED switch. Only `setStack()` moves
   * it, so a caller can tell whether the map it looks at is still the one IT
   * asked for by comparing this across its own await.
   * @returns {number}
   */
  getSwitchGeneration() {
    return this._switchGen;
  }

  getActiveStack() {
    return this.getStack(this._activeId);
  }

  isStackAvailable(id) {
    return !!this.getStack(id);
  }

  async setStack(id, { silent = false } = {}) {
    const stack = this.getStack(normalizeStackId(id));
    if (!stack) return null;

    if (!this.isStackAvailable(stack.id)) {
      const message = this._unavailableReason(stack);
      this._lastError = message;
      this._onError?.(message, stack);
      return this.getState();
    }

    const gen = ++this._switchGen;
    // Mesmo mapa base: nada a trocar (setStyle apagaria e recriaria tudo).
    if (stack.id === this._activeId && this.engine?.getBasemap?.() === stack.id) {
      this._lastError = null;
      if (!silent) this._emitChange('ready');
      return this.getState();
    }

    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');

    try {
      await this.engine.setBasemap(stack.id);
      if (gen !== this._switchGen) return this.getState();
      this._activeId = stack.id;
      governorRequestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, stack);
      if (!silent) this._emitChange('error');
    } finally {
      if (gen === this._switchGen) this._isSwitching = false;
    }

    return this.getState();
  }

  // ------------------------------------------- rótulos, globo/2D, relevo

  /** Rótulos por cima do satélite (só o mapa base Satélite tem essa camada). */
  getLabels() {
    return this.engine?.getEsriLabels?.() !== false;
  }

  setLabels(on, { silent = false } = {}) {
    this.engine?.setEsriLabels?.(Boolean(on));
    governorRequestRender('map-stack');
    if (!silent) this._emitChange('ready');
    return this.getState();
  }

  isGlobe() {
    return this.engine?.isGlobe?.() !== false;
  }

  setGlobe(on, { silent = false } = {}) {
    this.engine?.setGlobe?.(Boolean(on));
    governorRequestRender('map-stack');
    if (!silent) this._emitChange('ready');
    return this.getState();
  }

  hasTerrain() {
    return !!this.engine?.hasTerrain?.();
  }

  setTerrain(on, { silent = false } = {}) {
    try {
      this.engine?.setTerrain?.(Boolean(on));
    } catch (error) {
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, null);
    }
    governorRequestRender('map-stack');
    if (!silent) this._emitChange('ready');
    return this.getState();
  }

  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
      labels: this.getLabels(),
      globe: this.isGlobe(),
      terrain: this.hasTerrain(),
      hasCesiumIonToken: false,
    };
  }

  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }
}
