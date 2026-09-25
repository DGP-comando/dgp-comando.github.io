// src/data/datageoRodovias.js
//
// Malha rodoviaria do PR em dois niveis, ambos GeoJSON estatico:
//   - FEDERAIS (BR-xxx)  — ambar.
//   - ESTADUAIS (PR/PRC) — azul-claro.
// Os dois vem de scripts/build_rodovias.py (Overpass, coordenadas
// arredondadas/decimadas) e ficam sempre visiveis com a camada ligada.
//
// As MUNICIPAIS sairam daqui: eram buscadas em runtime no Overpass por bbox
// da camera, o que dependia de um servico publico de terceiros no meio da
// navegacao (fila serial, 429/504, troca de espelho) e so trazia
// secondary/tertiary/unclassified — sem as ruas urbanas nem as vicinais
// rurais. Agora sao a camada datageoEstradas, servida como celulas estaticas
// (OSM via scripts/build_estradas.py), com o mesmo gatilho de zoom.
//
// Performance: os ~16 mil trechos NAO sao entidades. Cada nivel vira UM
// GroundPolylinePrimitive com um GeometryInstance por trecho (mesma cor,
// largura, arco RHUMB e classificacao BOTH que o GeoJsonDataSource usava).
// Isso tira 16 mil entidades do loop de visualizers. Ninguem faz pick em
// rodovia, entao allowPicking=false poupa memoria de GPU. Se o contexto nao
// suportar ground polylines, cai no caminho antigo de entidades (visual
// identico).

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { createReadyPump } from './entityDiff.js';
import { lineStringsFromGeojson } from './geojsonLines.js';

const FED_URL = '/data/rodovias-federais-pr.geojson';
const EST_URL = '/data/rodovias-estaduais-pr.geojson';

const FED_COLOR = Cesium.Color.fromCssColorString('#fbbf24').withAlpha(0.85);
const EST_COLOR = Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.6);

// Estilos por nivel, herdados do GeoJsonDataSource original (arco RHUMB).
const FED_STYLE = Object.freeze({ color: FED_COLOR, width: 2.4, arcType: Cesium.ArcType.RHUMB });
const EST_STYLE = Object.freeze({ color: EST_COLOR, width: 1.6, arcType: Cesium.ArcType.RHUMB });

// lineStringsFromGeojson mora no modulo puro geojsonLines.js (tambem usado
// pelo prototipo MapLibre); reexportada para quem sempre importou daqui.
export { lineStringsFromGeojson };

function toFlatDegrees(coords) {
  const flat = new Array(coords.length * 2);
  for (let i = 0; i < coords.length; i++) {
    flat[i * 2] = coords[i][0];
    flat[i * 2 + 1] = coords[i][1];
  }
  return flat;
}

/**
 * Um GroundPolylinePrimitive com todos os trechos de um nivel.
 * @param {Array<Array<[number, number]>>} lines
 * @param {{color: Cesium.Color, width: number, arcType: Cesium.ArcType}} style
 * @returns {Cesium.GroundPolylinePrimitive|null}
 */
function createLineBatch(lines, style) {
  if (!lines.length) return null;
  const geometryInstances = lines.map((coords) => new Cesium.GeometryInstance({
    geometry: new Cesium.GroundPolylineGeometry({
      positions: Cesium.Cartesian3.fromDegreesArray(toFlatDegrees(coords)),
      width: style.width,
      arcType: style.arcType,
    }),
  }));
  return new Cesium.GroundPolylinePrimitive({
    geometryInstances,
    appearance: new Cesium.PolylineMaterialAppearance({
      material: Cesium.Material.fromType('Color', { color: style.color }),
    }),
    classificationType: Cesium.ClassificationType.BOTH,
    allowPicking: false,
    asynchronous: true,
  });
}

async function fetchGeojson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.json();
}

export const datageoRodoviasLayer = (() => {
  let _viewer = null;
  // Caminho em lote (padrao): uma colecao dentro de scene.groundPrimitives.
  let _staticCollection = null;
  let _staticLineCount = 0;
  let _pump = null;
  // Caminho de fallback (sem suporte a ground polylines): entidades.
  let _useEntities = false;
  let _staticSources = [];
  let _loaded = false;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  function requestFrame(reason) {
    governorRequestRender(`datageo-rodovias:${reason}`);
  }

  function groundPolylinesSupported(viewer) {
    try {
      return Boolean(viewer?.scene?.groundPrimitives)
        && Cesium.GroundPolylinePrimitive.isSupported(viewer.scene);
    } catch {
      return false;
    }
  }

  /** True enquanto algum primitive VISIVEL ainda esta sendo montado. */
  function hasPendingVisiblePrimitives() {
    const collection = _staticCollection;
    if (!collection || collection.isDestroyed?.() || !collection.show) return false;
    for (let i = 0; i < collection.length; i++) {
      const primitive = collection.get(i);
      if (primitive && !primitive.isDestroyed?.() && !primitive.ready) return true;
    }
    return false;
  }

  // Ground polylines ficam prontas de forma assincrona e so progridem quando
  // ha frames; no requestRenderMode do governor alguem precisa pedi-los.
  function startPump() {
    if (_useEntities || !_enabled) return;
    if (!_pump) {
      _pump = createReadyPump({
        isReady: () => !hasPendingVisiblePrimitives(),
        requestRender: () => requestFrame('ground-ready'),
      });
    }
    _pump.start();
  }

  function stopPump() {
    _pump?.stop();
  }

  function setStaticShow(show) {
    for (const ds of _staticSources) ds.show = show;
    if (_staticCollection && !_staticCollection.isDestroyed?.()) _staticCollection.show = show;
  }

  async function loadStaticAsPrimitives(viewer) {
    const [fedGeojson, estGeojson] = await Promise.all([fetchGeojson(FED_URL), fetchGeojson(EST_URL)]);
    if (!_viewer || !viewer?.scene?.groundPrimitives) throw new Error('viewer destruido durante o carregamento');
    const fedLines = lineStringsFromGeojson(fedGeojson);
    const estLines = lineStringsFromGeojson(estGeojson);
    const staticCollection = new Cesium.PrimitiveCollection();
    staticCollection.show = _enabled;
    // Mesma ordem de desenho do caminho antigo: federais antes das estaduais.
    const fed = createLineBatch(fedLines, FED_STYLE);
    const est = createLineBatch(estLines, EST_STYLE);
    if (fed) staticCollection.add(fed);
    if (est) staticCollection.add(est);
    viewer.scene.groundPrimitives.add(staticCollection);
    _staticCollection = staticCollection;
    _staticLineCount = fedLines.length + estLines.length;
  }

  async function loadStaticAsEntities(viewer) {
    const [fed, est] = await Promise.all([
      Cesium.GeoJsonDataSource.load(FED_URL, {
        clampToGround: true,
        stroke: FED_COLOR,
        strokeWidth: FED_STYLE.width,
      }),
      Cesium.GeoJsonDataSource.load(EST_URL, {
        clampToGround: true,
        stroke: EST_COLOR,
        strokeWidth: EST_STYLE.width,
      }),
    ]);
    _staticSources = [fed, est];
    for (const ds of _staticSources) {
      ds.show = _enabled;
      await viewer.dataSources.add(ds);
    }
  }

  function currentCount() {
    if (_useEntities) {
      return _staticSources.reduce((n, ds) => n + ds.entities.values.length, 0);
    }
    return _staticLineCount;
  }

  return {
    id: 'datageo-rodovias',
    name: 'Rodovias',
    category: 'Infraestrutura',
    icon: '🛣️',
    source: 'OSM · DNIT/DER-PR',
    updateInterval: 24 * 3600_000,

    init(viewer) {
      _viewer = viewer;
      console.log('[Data:datageo-rodovias] Initialized');
    },

    enable() {
      _enabled = true;
      setStaticShow(true);
      startPump();
      requestFrame('enable');
    },

    disable() {
      _enabled = false;
      stopPump();
      setStaticShow(false);
      requestFrame('disable');
    },

    async update(viewer) {
      try {
        if (!_loaded) {
          _useEntities = !groundPolylinesSupported(viewer);
          if (_useEntities) {
            console.warn('[Data:datageo-rodovias] GroundPolylinePrimitive sem suporte: usando entidades');
            await loadStaticAsEntities(viewer);
          } else {
            await loadStaticAsPrimitives(viewer);
          }
          _loaded = true;
          setStaticShow(_enabled);
          startPump();
        }
        _count = currentCount();
        _lastUpdate = Date.now();
        _lastError = null;
        requestFrame('update');
        console.log(`[Data:datageo-rodovias] ${_count} trechos federais e estaduais`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-rodovias]', err);
        return false;
      }
    },

    destroy(viewer) {
      this.disable();
      _pump = null;
      const scene = (viewer ?? _viewer)?.scene;
      if (_staticCollection && !_staticCollection.isDestroyed?.()) {
        try {
          // groundPrimitives destroi a colecao (e seus primitives) ao remover.
          if (scene?.groundPrimitives?.contains?.(_staticCollection)) {
            scene.groundPrimitives.remove(_staticCollection);
          } else {
            _staticCollection.destroy();
          }
        } catch (err) {
          console.warn('[Data:datageo-rodovias] remover primitives:', err);
        }
      }
      _staticCollection = null;
      _staticLineCount = 0;
      for (const ds of _staticSources) viewer.dataSources.remove(ds, true);
      _staticSources = [];
      _loaded = false;
      _useEntities = false;
      _viewer = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
})();
