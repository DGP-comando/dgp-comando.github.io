// src/data/datageoEnergia.js
//
// Transmissão de energia (classe Infraestrutura), do backlog §8:
//   - Linhas de transmissão: EPE em operação (248) + PLANEJADAS (49, com
//     ano no horizonte 2025-2037). Cor por tensão; planejadas tracejadas
//     em âmbar — o "o que vem aí" é o que mais interessa numa sala de
//     situação.
//   - Subestações: EPE operação (83) + planejadas (10), label com nome e
//     tensão gated por distância.
//
// GeoJSONs de scripts/build_energia.py (fonte: projeto energy local, raw
// EPE). Estático, contrato earthquakes (sem CallbackProperty).

import * as Cesium from 'cesium';
import { makePointsLayer } from './datageoLogistica.js';

const LT_URL = '/data/linhas-transmissao-pr.geojson';

const cores = {
  kv525: Cesium.Color.fromCssColorString('#c084fc').withAlpha(0.9),
  kv230: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.75),
  baixa: Cesium.Color.fromCssColorString('#94a3b8').withAlpha(0.55),
  planejada: Cesium.Color.fromCssColorString('#fbbf24').withAlpha(0.9),
};

function ltStyle(props) {
  if (props.planejada) {
    return {
      width: 2.2,
      material: new Cesium.PolylineDashMaterialProperty({
        color: cores.planejada,
        dashLength: 16,
      }),
    };
  }
  const kv = Number(props.tensao) || 0;
  if (kv >= 500) return { width: 2.6, material: new Cesium.ColorMaterialProperty(cores.kv525) };
  if (kv >= 230) return { width: 1.8, material: new Cesium.ColorMaterialProperty(cores.kv230) };
  return { width: 1.2, material: new Cesium.ColorMaterialProperty(cores.baixa) };
}

export const datageoLinhasTransmissaoLayer = (() => {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  return {
    id: 'datageo-transmissao',
    name: 'Linhas de transmissão',
    category: 'Infraestrutura',
    icon: '⚡',
    source: 'EPE (operação + planejadas)',
    updateInterval: 24 * 3600_000,

    init() {
      console.log('[Data:datageo-transmissao] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      try {
        if (!_dataSource) {
          const resp = await fetch(LT_URL);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const gj = await resp.json();
          _dataSource = new Cesium.CustomDataSource('datageo-transmissao');
          for (const f of gj.features ?? []) {
            const geom = f.geometry;
            if (!geom) continue;
            const lines = geom.type === 'LineString'
              ? [geom.coordinates]
              : geom.type === 'MultiLineString' ? geom.coordinates : [];
            const style = ltStyle(f.properties ?? {});
            for (const coords of lines) {
              if (!coords || coords.length < 2) continue;
              _dataSource.entities.add({
                polyline: {
                  positions: coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
                  clampToGround: true,
                  width: style.width,
                  material: style.material,
                },
              });
            }
          }
          _dataSource.show = _enabled;
          await viewer.dataSources.add(_dataSource);
        }
        _count = _dataSource.entities.values.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:datageo-transmissao] ${_count} trechos`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-transmissao]', err);
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
})();

export const datageoSubestacoesLayer = makePointsLayer({
  id: 'datageo-subestacoes',
  name: 'Subestações',
  category: 'Infraestrutura',
  icon: '🔌',
  source: 'EPE',
  url: '/data/subestacoes-pr.geojson',
  styleFor: (p) => ({
    size: p.planejada ? 9 : 7,
    color: p.planejada ? cores.planejada : cores.kv230.withAlpha(1),
    label: p.planejada
      ? `${p.nome} (prevista ${p.ano ?? '?'}) · ${p.tensao ?? ''} kV`
      : `${p.nome} · ${p.tensao ?? ''} kV`,
    labelMaxDist: p.planejada ? 900_000 : 250_000,
  }),
});

export const DATAGEO_ENERGIA_LAYERS = [
  datageoLinhasTransmissaoLayer,
  datageoSubestacoesLayer,
];
