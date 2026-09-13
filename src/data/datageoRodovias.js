// src/data/datageoRodovias.js
//
// Malha rodoviaria do PR em tres niveis:
//   - FEDERAIS (BR-xxx)  — GeoJSON estatico, ambar, sempre visiveis.
//   - ESTADUAIS (PR/PRC) — GeoJSON estatico, azul-claro, sempre visiveis.
//   - MUNICIPAIS         — SO aparecem com zoom no nivel de municipio:
//     buscadas em runtime no Overpass (CORS aberto) por bbox da camera,
//     em celulas de grade cacheadas, e descartadas ao afastar o zoom.
//     Estaticamente a malha municipal do estado inteiro seria dezenas de
//     MB — inviavel no Pages e inutil vista de longe.
//
// Os estaticos vem de scripts/build_rodovias.py (Overpass, coordenadas
// arredondadas/decimadas).
//
// Performance: os ~16 mil trechos NAO sao entidades. Cada nivel estatico vira
// UM GroundPolylinePrimitive com um GeometryInstance por trecho (mesma cor,
// largura, arco RHUMB e classificacao BOTH que o GeoJsonDataSource usava), e
// cada celula municipal carregada vira outro primitive. Isso tira 16 mil
// entidades do loop de visualizers e evita rebatch global a cada celula nova.
// Ninguem faz pick em rodovia, entao allowPicking=false poupa memoria de GPU.
// Se o contexto nao suportar ground polylines, cai no caminho antigo de
// entidades (visual identico).

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { createReadyPump } from './entityDiff.js';

const FED_URL = '/data/rodovias-federais-pr.geojson';
const EST_URL = '/data/rodovias-estaduais-pr.geojson';
// Espelhos Overpass com CORS aberto; o principal limita a ~2 conexoes,
// entao as celulas sao buscadas EM SERIE e o espelho gira a cada 429/504.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const FED_COLOR = Cesium.Color.fromCssColorString('#fbbf24').withAlpha(0.85);
const EST_COLOR = Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.6);
const MUN_COLOR = Cesium.Color.fromCssColorString('#f8fafc').withAlpha(0.65);

// Estilos por nivel. Os estaticos vinham do GeoJsonDataSource (arco RHUMB);
// as municipais eram polylines de entidade sem arcType (GEODESIC).
const FED_STYLE = Object.freeze({ color: FED_COLOR, width: 2.4, arcType: Cesium.ArcType.RHUMB });
const EST_STYLE = Object.freeze({ color: EST_COLOR, width: 1.6, arcType: Cesium.ArcType.RHUMB });
const MUN_STYLE = Object.freeze({ color: MUN_COLOR, width: 1.4, arcType: Cesium.ArcType.GEODESIC });

// Altura de camera abaixo da qual "entrou no municipio" e as municipais
// carregam (~um municipio medio na tela).
const MUNICIPAL_MAX_HEIGHT = 90_000;
// Grade de cache das buscas municipais (graus). ~0.25° ≈ 27 km.
const CELL_DEG = 0.25;
// Bbox do PR — fora dele nao ha o que buscar.
const PR_BBOX = { south: -26.75, north: -22.5, west: -54.65, east: -48.0 };
const MAX_CELLS_PER_VIEW = 12;

/**
 * Trechos [lon, lat][] utilizaveis de um GeoJSON de linhas: LineString e
 * MultiLineString, com pelo menos dois vertices finitos e distintos.
 * @param {object} geojson
 * @returns {Array<Array<[number, number]>>}
 */
export function lineStringsFromGeojson(geojson) {
  const lines = [];
  for (const feature of geojson?.features ?? []) {
    const geom = feature?.geometry;
    if (!geom) continue;
    const parts = geom.type === 'LineString'
      ? [geom.coordinates]
      : geom.type === 'MultiLineString' ? geom.coordinates : [];
    for (const coords of parts ?? []) {
      if (isDrawableLine(coords)) lines.push(coords);
    }
  }
  return lines;
}

function isDrawableLine(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const [lon0, lat0] = coords[0] ?? [];
  let distinct = false;
  for (const point of coords) {
    const [lon, lat] = point ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (lon !== lon0 || lat !== lat0) distinct = true;
  }
  return distinct;
}

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
  // Caminho em lote (padrao): colecoes dentro de scene.groundPrimitives.
  let _staticCollection = null;
  let _munCollection = null;
  let _staticLineCount = 0;
  let _munLineCount = 0;
  let _pump = null;
  // Caminho de fallback (sem suporte a ground polylines): entidades.
  let _useEntities = false;
  let _staticSources = [];
  let _munSource = null; // CustomDataSource das municipais
  let _loaded = false;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _cameraListener = null;
  let _debounce = null;
  let _loadedCells = new Set();
  let _queuedCells = new Set();
  let _queue = [];
  let _draining = false;
  let _mirrorIdx = 0;
  let _munVisible = false;

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
    const collections = [_staticCollection, _munCollection];
    for (const collection of collections) {
      if (!collection || collection.isDestroyed?.() || !collection.show) continue;
      for (let i = 0; i < collection.length; i++) {
        const primitive = collection.get(i);
        if (primitive && !primitive.isDestroyed?.() && !primitive.ready) return true;
      }
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

  function cellsInView() {
    const rect = _viewer.camera.computeViewRectangle();
    if (!rect) return [];
    const south = Math.max(Cesium.Math.toDegrees(rect.south), PR_BBOX.south);
    const north = Math.min(Cesium.Math.toDegrees(rect.north), PR_BBOX.north);
    const west = Math.max(Cesium.Math.toDegrees(rect.west), PR_BBOX.west);
    const east = Math.min(Cesium.Math.toDegrees(rect.east), PR_BBOX.east);
    if (south >= north || west >= east) return [];
    const cells = [];
    for (let lat = Math.floor(south / CELL_DEG) * CELL_DEG; lat < north; lat += CELL_DEG) {
      for (let lon = Math.floor(west / CELL_DEG) * CELL_DEG; lon < east; lon += CELL_DEG) {
        cells.push([+lat.toFixed(2), +lon.toFixed(2)]);
      }
    }
    return cells;
  }

  function municipalLinesFromOverpass(osm) {
    const lines = [];
    for (const el of osm?.elements ?? []) {
      const ref = el.tags?.ref ?? '';
      if (/^(BR|PRC?)-/.test(ref)) continue; // ja coberta pelos estaticos
      const coords = (el.geometry ?? []).map((p) => [p.lon, p.lat]);
      if (isDrawableLine(coords)) lines.push({ id: el.id, coords });
    }
    return lines;
  }

  function addMunicipalLines(lines) {
    if (_useEntities) {
      if (!_munSource) return 0;
      for (const { id, coords } of lines) {
        _munSource.entities.add({
          id: `rodovia-mun:${id}`,
          polyline: {
            positions: coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
            clampToGround: true,
            width: MUN_STYLE.width,
            material: new Cesium.ColorMaterialProperty(MUN_COLOR),
          },
        });
      }
      return lines.length;
    }
    if (!_munCollection || _munCollection.isDestroyed?.()) return 0;
    const primitive = createLineBatch(lines.map((l) => l.coords), MUN_STYLE);
    if (!primitive) return 0;
    _munCollection.add(primitive);
    _munLineCount += lines.length;
    startPump();
    return lines.length;
  }

  async function fetchCell(cell) {
    const key = cell.join(',');
    const [s, w] = cell;
    const bbox = `${s},${w},${(s + CELL_DEG).toFixed(2)},${(w + CELL_DEG).toFixed(2)}`;
    // Vias municipais: secundarias/terciarias/nao-classificadas SEM ref
    // BR/PR (as com ref ja estao nos estaticos).
    const query = `[out:json][timeout:25];way["highway"~"^(secondary|tertiary|unclassified)$"](${bbox});out geom 800;`;
    for (let attempt = 0; attempt < OVERPASS_MIRRORS.length; attempt += 1) {
      const mirror = OVERPASS_MIRRORS[_mirrorIdx % OVERPASS_MIRRORS.length];
      try {
        const resp = await fetch(mirror, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
        const osm = await resp.json();
        if (!_loaded) return; // destruida durante o fetch
        const added = addMunicipalLines(municipalLinesFromOverpass(osm));
        _loadedCells.add(key);
        if (added) requestFrame('municipais');
        return;
      } catch (err) {
        console.warn(`[Data:datageo-rodovias] celula ${key} em ${mirror}:`, err?.message);
        _mirrorIdx += 1; // proxima celula (e o retry) usam o outro espelho
      }
    }
  }

  // Fila serial: o Overpass principal limita conexoes simultaneas (429 com
  // fan-out paralelo). Uma celula por vez, com respiro entre elas.
  async function drainQueue() {
    if (_draining) return;
    _draining = true;
    try {
      while (_queue.length > 0 && _enabled && _munVisible) {
        const cell = _queue.shift();
        _queuedCells.delete(cell.join(','));
        await fetchCell(cell);
        await new Promise((r) => setTimeout(r, 700));
      }
    } finally {
      _queue = [];
      _queuedCells.clear();
      _draining = false;
    }
  }

  function setMunicipalShow(show) {
    if (_munSource) _munSource.show = show;
    if (_munCollection && !_munCollection.isDestroyed?.()) _munCollection.show = show;
  }

  function setStaticShow(show) {
    for (const ds of _staticSources) ds.show = show;
    if (_staticCollection && !_staticCollection.isDestroyed?.()) _staticCollection.show = show;
  }

  function syncMunicipais() {
    if (!_enabled || !_viewer || !_loaded) return;
    const height = _viewer.camera.positionCartographic?.height ?? Infinity;
    const zoomedIn = height < MUNICIPAL_MAX_HEIGHT;
    if (zoomedIn !== _munVisible) {
      _munVisible = zoomedIn;
      setMunicipalShow(zoomedIn);
      if (zoomedIn) startPump();
      requestFrame('municipais-visibilidade');
    }
    if (!zoomedIn) return;
    const cells = cellsInView();
    if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return;
    for (const cell of cells) {
      const key = cell.join(',');
      if (_loadedCells.has(key) || _queuedCells.has(key)) continue;
      _queuedCells.add(key);
      _queue.push(cell);
    }
    void drainQueue();
  }

  function onCameraIdle() {
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(syncMunicipais, 400);
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
    const munCollection = new Cesium.PrimitiveCollection();
    munCollection.show = false;
    viewer.scene.groundPrimitives.add(staticCollection);
    viewer.scene.groundPrimitives.add(munCollection);
    _staticCollection = staticCollection;
    _munCollection = munCollection;
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
    _munSource = new Cesium.CustomDataSource('datageo-rodovias-municipais');
    _munSource.show = false;
    for (const ds of _staticSources) {
      ds.show = _enabled;
      await viewer.dataSources.add(ds);
    }
    await viewer.dataSources.add(_munSource);
  }

  function currentCount() {
    if (_useEntities) {
      return _staticSources.reduce((n, ds) => n + ds.entities.values.length, 0)
        + (_munSource?.entities.values.length ?? 0);
    }
    return _staticLineCount + _munLineCount;
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
      if (!_cameraListener && _viewer) {
        _cameraListener = onCameraIdle;
        _viewer.camera.changed.addEventListener(_cameraListener);
      }
      syncMunicipais();
      requestFrame('enable');
    },

    disable() {
      _enabled = false;
      stopPump();
      setStaticShow(false);
      setMunicipalShow(false);
      _munVisible = false;
      if (_cameraListener && _viewer) {
        _viewer.camera.changed.removeEventListener(_cameraListener);
        _cameraListener = null;
      }
      if (_debounce) {
        clearTimeout(_debounce);
        _debounce = null;
      }
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
        console.log(`[Data:datageo-rodovias] ${_count} trechos (estaticos + municipais em cache)`);
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
      for (const collection of [_staticCollection, _munCollection]) {
        if (!collection || collection.isDestroyed?.()) continue;
        try {
          // groundPrimitives destroi a colecao (e seus primitives) ao remover.
          if (scene?.groundPrimitives?.contains?.(collection)) scene.groundPrimitives.remove(collection);
          else collection.destroy();
        } catch (err) {
          console.warn('[Data:datageo-rodovias] remover primitives:', err);
        }
      }
      _staticCollection = null;
      _munCollection = null;
      _staticLineCount = 0;
      _munLineCount = 0;
      for (const ds of _staticSources) viewer.dataSources.remove(ds, true);
      _staticSources = [];
      if (_munSource) {
        viewer.dataSources.remove(_munSource, true);
        _munSource = null;
      }
      _loaded = false;
      _useEntities = false;
      _loadedCells = new Set();
      _queue = [];
      _queuedCells = new Set();
      _viewer = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
})();
