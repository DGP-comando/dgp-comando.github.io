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
import { makePointsLayer, cssColor, cesiumStyle } from './datageoLogistica.js';
import {
  ENERGIA_CORES, SUBESTACAO_LEGENDA, USINA_LEGENDA, linhaTransmissaoClasse, subestacaoEstilo, usinaEstilo,
} from './energiaLogisticaEstilos.js';
import { datageoDistribuicaoLayer } from './datageoDistribuicao.js';

const LT_URL = '/data/linhas-transmissao-pr.geojson';

const cores = Object.fromEntries(
  Object.entries(ENERGIA_CORES).map(([k, c]) => [k, cssColor(c.css, c.alpha)]),
);

// Estilos por classe criados uma vez: as ~300 linhas compartilham o mesmo
// material, o que tambem deixa o batch de polylines clamped do Cesium agrupa-las.
let _ltStyles = null;
function ltStyles() {
  if (!_ltStyles) {
    _ltStyles = {
      planejada: {
        width: 2.2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: cores.planejada,
          dashLength: 16,
        }),
      },
      kv525: { width: 2.6, material: new Cesium.ColorMaterialProperty(cores.kv525) },
      kv230: { width: 1.8, material: new Cesium.ColorMaterialProperty(cores.kv230) },
      baixa: { width: 1.2, material: new Cesium.ColorMaterialProperty(cores.baixa) },
    };
  }
  return _ltStyles;
}

function ltStyle(props) {
  return ltStyles()[linhaTransmissaoClasse(props)];
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
  styleFor: cesiumStyle(subestacaoEstilo),
  legend: SUBESTACAO_LEGENDA,
});

// Usinas SIGEL/ANEEL por tipo + aerogeradores (energiaLogisticaEstilos.js).
export const datageoGeracaoLayer = makePointsLayer({
  id: 'datageo-geracao',
  name: 'Usinas de energia',
  category: 'Infraestrutura',
  icon: '💡',
  source: 'SIGEL/ANEEL',
  url: '/data/usinas-pr.geojson',
  styleFor: cesiumStyle(usinaEstilo),
  legend: USINA_LEGENDA,
});

export const DATAGEO_ENERGIA_LAYERS = [
  datageoLinhasTransmissaoLayer,
  datageoDistribuicaoLayer,
  datageoSubestacoesLayer,
  datageoGeracaoLayer,
];
