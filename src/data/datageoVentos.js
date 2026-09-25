// src/data/datageoVentos.js
//
// Camada de ventos estilo earth.nullschool: particulas animadas advectadas
// pelo campo de vento a 10 m, via cesium-wind-layer (render GPU) alimentado
// por uma grade Open-Meteo (gratuito, sem chave — funciona no deploy
// estatico). Grade 22x15 sobre o PR, atualizada a cada 30 min.
//
// Particulas animam TODO frame, entao a camada segura o render governor
// continuo enquanto ligada (mesmo padrao do tracking do GEV) e o libera ao
// desligar — sem isso o requestRenderMode congelaria o fluxo.

import { WindLayer } from 'cesium-wind-layer';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { fetchWindGrid } from './datageoClient.js';
import { WIND_PARTICLE_STYLE } from './ventosOptions.js';

const RENDER_HOLD_ID = 'datageo-ventos';

const WIND_OPTIONS = {
  ...WIND_PARTICLE_STYLE,
  particleHeight: 120,
};

export const datageoVentosLayer = (() => {
  let _viewer = null;
  let _windLayer = null;
  let _data = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;

  function ensureLayer() {
    if (!_viewer || !_data) return;
    if (_windLayer && !_windLayer.isDestroyed()) {
      _windLayer.updateWindData(_data);
      return;
    }
    _windLayer = new WindLayer(_viewer, _data, WIND_OPTIONS);
    _windLayer.show = _enabled;
  }

  return {
    id: 'datageo-ventos',
    name: 'Ventos',
    category: 'Clima',
    icon: '💨',
    source: 'Open-Meteo',
    updateInterval: 1_800_000,

    init(viewer) {
      _viewer = viewer;
      console.log('[Data:datageo-ventos] Initialized');
    },

    enable() {
      _enabled = true;
      holdContinuousRender(RENDER_HOLD_ID);
      if (_windLayer && !_windLayer.isDestroyed()) _windLayer.show = true;
      else if (_data) ensureLayer();
    },

    disable() {
      _enabled = false;
      releaseContinuousRender(RENDER_HOLD_ID);
      if (_windLayer && !_windLayer.isDestroyed()) _windLayer.show = false;
    },

    async update() {
      try {
        _data = await fetchWindGrid();
        ensureLayer();
        // Hora do DADO, nao do poll: a grade pode vir do localStorage.
        _lastUpdate = Number.isFinite(_data.fetchedAt) ? _data.fetchedAt : Date.now();
        _lastError = null;
        console.log(
          `[Data:datageo-ventos] grade ${_data.width}x${_data.height} atualizada`,
        );
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-ventos]', err);
        return false;
      }
    },

    destroy() {
      _enabled = false;
      releaseContinuousRender(RENDER_HOLD_ID);
      if (_windLayer && !_windLayer.isDestroyed()) _windLayer.destroy();
      _windLayer = null;
      _data = null;
      _viewer = null;
    },

    getStats() {
      return {
        count: _data ? _data.width * _data.height : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        source: _data?.stale ? 'Open-Meteo · grade salva (API indisponível)' : 'Open-Meteo',
      };
    },
  };
})();
