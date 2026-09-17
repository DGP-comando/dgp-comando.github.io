// src/data/slicedLineLayer.js
//
// Máquina das camadas de LINHAS FATIADAS: malhas grandes demais para um
// GeoJSON único (centenas de milhares de trechos, dezenas de MB) servidas
// como uma grade de arquivos estáticos que o front carrega por zoom.
//
// Nasceu dentro de datageoDistribuicao.js (rede de média tensão da Copel) e
// foi extraída quando as estradas municipais do OSM passaram a precisar
// exatamente do mesmo comportamento. Os dois builds (scripts/slice_grid.py)
// escrevem o MESMO formato:
//
//   index.json: {cell_deg, escala, <grupos>: [...], fonte, trechos, cells}
//   <i>_<j>.json: {"t": [[trecho, ...] por índice de grupo]}
//     i = floor(lat / cell_deg), j = floor(lon / cell_deg)
//     trecho = [dx0, dy0, dx1, dy1, ...] em inteiros de graus * escala,
//     delta ENCADEADO: o 1º vértice é relativo ao último do trecho anterior
//     (o primeiro de cada grupo, à origem SW da célula).
//
// Ciclo de vida: com a câmera abaixo de `maxHeight` carrega as células mais
// próximas do centro da vista (até `maxCellsPerView`), cada uma virando UMA
// PrimitiveCollection com um GroundPolylinePrimitive por grupo (sem pick);
// acima de `maxLoadedCells` as mais antigas fora da vista são destruídas,
// para a memória de GPU não crescer num passeio pelo estado.

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { createReadyPump } from './entityDiff.js';

/**
 * Chave "<i>_<j>" da célula que contém (lat, lon).
 * @param {number} lat
 * @param {number} lon
 * @param {number} cellDeg
 */
export function cellKey(lat, lon, cellDeg) {
  return `${Math.floor(lat / cellDeg)}_${Math.floor(lon / cellDeg)}`;
}

/**
 * Decodifica o payload de uma célula (delta encadeado, ver o cabeçalho) em
 * trechos com graus planos [lon0, lat0, lon1, lat1, ...], agrupados por
 * índice de grupo.
 * @param {{t: number[][][]}} payload
 * @param {string} key "<i>_<j>"
 * @param {{cell_deg: number, escala: number}} index
 * @returns {number[][][]}
 */
export function decodeCell(payload, key, index) {
  const [i, j] = key.split('_').map(Number);
  const { cell_deg: cellDeg, escala } = index;
  const originX = Math.round(j * cellDeg * escala);
  const originY = Math.round(i * cellDeg * escala);
  return (payload?.t ?? []).map((lines) => {
    let px = originX;
    let py = originY;
    const out = [];
    for (const enc of lines ?? []) {
      if (!Array.isArray(enc) || enc.length < 4 || enc.length % 2 !== 0) continue;
      const flat = new Array(enc.length);
      for (let n = 0; n < enc.length; n += 2) {
        px += enc[n];
        py += enc[n + 1];
        flat[n] = px / escala;
        flat[n + 1] = py / escala;
      }
      out.push(flat);
    }
    return out;
  });
}

/**
 * Células existentes mais próximas de (lat, lon), num raio de `rings` células.
 * @returns {string[]}
 */
export function nearestCells(lat, lon, index, limit = 9, rings = 2) {
  const cellDeg = index.cell_deg;
  const ci = Math.floor(lat / cellDeg);
  const cj = Math.floor(lon / cellDeg);
  const candidates = [];
  for (let di = -rings; di <= rings; di++) {
    for (let dj = -rings; dj <= rings; dj++) {
      const key = `${ci + di}_${cj + dj}`;
      if (!index.cells?.[key]) continue;
      const cLat = (ci + di + 0.5) * cellDeg;
      const cLon = (cj + dj + 0.5) * cellDeg;
      candidates.push({ key, d: (cLat - lat) ** 2 + (cLon - lon) ** 2 });
    }
  }
  return candidates.sort((a, b) => a.d - b.d).slice(0, limit).map((c) => c.key);
}

function createLineBatch(lines, style) {
  if (!lines.length) return null;
  return new Cesium.GroundPolylinePrimitive({
    geometryInstances: lines.map((flat) => new Cesium.GeometryInstance({
      geometry: new Cesium.GroundPolylineGeometry({
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width: style.width,
      }),
    })),
    appearance: new Cesium.PolylineMaterialAppearance({
      material: Cesium.Material.fromType('Color', { color: style.color }),
    }),
    classificationType: Cesium.ClassificationType.BOTH,
    allowPicking: false,
    asynchronous: true,
  });
}

/**
 * Monta uma camada de linhas fatiadas.
 *
 * @param {object} config
 * @param {string} config.id id da camada (share link / manager)
 * @param {string} config.name rótulo no painel
 * @param {string} config.category classe do painel
 * @param {string} config.icon
 * @param {string} config.source crédito curto
 * @param {string} config.baseUrl diretório das células (index.json + <i>_<j>.json)
 * @param {string} config.groupsKey campo do index com a lista de grupos ('tensoes', 'classes')
 * @param {(grupo: any) => {color: Cesium.Color, width: number, maxHeight?: number}} config.styleFor
 *   estilo por valor de grupo; `maxHeight` opcional esconde o grupo acima dessa
 *   altura de câmera (ruas urbanas viram borrão muito antes das estradas rurais).
 * @param {number} config.maxHeight altura de câmera acima da qual a camada some
 * @param {number} [config.maxCellsPerView=9]
 * @param {number} [config.maxLoadedCells=24]
 * @param {number} [config.updateInterval]
 */
export function createSlicedLineLayer(config) {
  const {
    id, name, category, icon, source, baseUrl, groupsKey, styleFor, maxHeight,
    maxCellsPerView = 9,
    maxLoadedCells = 24,
    updateInterval = 24 * 3600_000,
  } = config;
  const FALLBACK_STYLE = Object.freeze({ color: Cesium.Color.WHITE.withAlpha(0.6), width: 1 });
  const log = `[Data:${id}]`;

  let _viewer = null;
  let _index = null;
  let _root = null; // PrimitiveCollection em scene.groundPrimitives
  const _cells = new Map(); // key -> { collection, groups, lines, lastSeen }
  const _inflight = new Set();
  let _enabled = false;
  let _visible = false;
  let _cameraListener = null;
  let _debounce = null;
  let _pump = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastHeight = Infinity;

  function requestFrame(reason) {
    governorRequestRender(`${id}:${reason}`);
  }

  function hasPending() {
    if (!_root || _root.isDestroyed?.() || !_root.show) return false;
    for (const { collection } of _cells.values()) {
      for (let n = 0; n < collection.length; n++) {
        const p = collection.get(n);
        if (p && !p.isDestroyed?.() && !p.ready) return true;
      }
    }
    return false;
  }

  function startPump() {
    if (!_enabled) return;
    if (!_pump) {
      _pump = createReadyPump({
        isReady: () => !hasPending(),
        requestRender: () => requestFrame('ground-ready'),
      });
    }
    _pump.start();
  }

  /** Aplica o teto de altura de cada GRUPO (só os que têm `maxHeight` próprio). */
  function applyGroupGates(cell) {
    for (const group of cell.groups) {
      const gate = group.style.maxHeight;
      const show = !Number.isFinite(gate) || _lastHeight < gate;
      if (group.primitive.show !== show) group.primitive.show = show;
    }
  }

  async function loadIndex() {
    if (_index) return _index;
    const resp = await fetch(`${baseUrl}/index.json`);
    if (!resp.ok) throw new Error(`index.json HTTP ${resp.status}`);
    const index = await resp.json();
    if (!index?.cells || !index.cell_deg || !index.escala || !Array.isArray(index[groupsKey])) {
      throw new Error(`index.json de ${id} sem cells/cell_deg/escala/${groupsKey}`);
    }
    _index = index;
    return index;
  }

  async function loadCell(key) {
    if (_cells.has(key) || _inflight.has(key)) return;
    _inflight.add(key);
    try {
      const resp = await fetch(`${baseUrl}/${key}.json`);
      if (!resp.ok) throw new Error(`célula ${key} HTTP ${resp.status}`);
      const payload = await resp.json();
      if (!_root || _root.isDestroyed?.()) return; // destruída durante o fetch
      const porGrupo = decodeCell(payload, key, _index);
      const collection = new Cesium.PrimitiveCollection();
      const groups = [];
      let lines = 0;
      porGrupo.forEach((flatLines, k) => {
        const style = styleFor(_index[groupsKey][k]) ?? FALLBACK_STYLE;
        const primitive = createLineBatch(flatLines, style);
        if (primitive) {
          collection.add(primitive);
          groups.push({ primitive, style });
        }
        lines += flatLines.length;
      });
      const cell = { collection, groups, lines, lastSeen: Date.now() };
      applyGroupGates(cell);
      _root.add(collection);
      _cells.set(key, cell);
      startPump();
      requestFrame('celula');
    } catch (err) {
      _lastError = err?.message || String(err);
      console.warn(log, err);
    } finally {
      _inflight.delete(key);
    }
  }

  function evict(keep) {
    if (_cells.size <= maxLoadedCells) return;
    const antigas = [..._cells.entries()]
      .filter(([key]) => !keep.has(key))
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key, cell] of antigas) {
      if (_cells.size <= maxLoadedCells) break;
      _root.remove(cell.collection); // destroyPrimitives: destrói a célula
      _cells.delete(key);
    }
  }

  function setVisible(visible) {
    if (visible === _visible) return;
    _visible = visible;
    if (_root && !_root.isDestroyed?.()) _root.show = visible;
    if (visible) startPump();
    requestFrame('visibilidade');
  }

  async function sync() {
    if (!_enabled || !_viewer || !_root) return;
    const carto = _viewer.camera.positionCartographic;
    _lastHeight = carto?.height ?? Infinity;
    setVisible(_lastHeight < maxHeight);
    if (!_visible) return;
    for (const cell of _cells.values()) applyGroupGates(cell);
    const index = await loadIndex();
    // Centro da vista: o ponto do globo no meio da tela (câmera inclinada
    // olha longe da própria posição); sem interseção, a posição da câmera.
    const canvas = _viewer.scene.canvas;
    const center = _viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    const target = center ? Cesium.Cartographic.fromCartesian(center) : carto;
    const keys = nearestCells(
      Cesium.Math.toDegrees(target.latitude),
      Cesium.Math.toDegrees(target.longitude),
      index,
      maxCellsPerView,
    );
    const now = Date.now();
    for (const key of keys) {
      const cell = _cells.get(key);
      if (cell) cell.lastSeen = now;
    }
    evict(new Set(keys));
    await Promise.all(keys.map(loadCell));
  }

  function onCameraChanged() {
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      sync().catch((err) => {
        _lastError = err?.message || String(err);
        console.warn(log, err);
      });
    }, 400);
  }

  return {
    id,
    name,
    category,
    icon,
    source,
    updateInterval,

    init(viewer) {
      _viewer = viewer;
      console.log(`${log} Initialized`);
    },

    enable() {
      _enabled = true;
      if (!_cameraListener && _viewer) {
        _cameraListener = onCameraChanged;
        _viewer.camera.changed.addEventListener(_cameraListener);
      }
      onCameraChanged();
    },

    disable() {
      _enabled = false;
      _pump?.stop();
      setVisible(false);
      if (_cameraListener && _viewer) {
        _viewer.camera.changed.removeEventListener(_cameraListener);
        _cameraListener = null;
      }
      if (_debounce) {
        clearTimeout(_debounce);
        _debounce = null;
      }
    },

    async update(viewer) {
      try {
        if (!Cesium.GroundPolylinePrimitive.isSupported(viewer.scene)) {
          throw new Error('GroundPolylinePrimitive sem suporte neste contexto WebGL');
        }
        if (!_root) {
          _root = new Cesium.PrimitiveCollection();
          _root.show = _visible;
          viewer.scene.groundPrimitives.add(_root);
        }
        await loadIndex();
        if (_enabled) await sync();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn(log, err);
        return false;
      }
    },

    destroy(viewer) {
      this.disable();
      _pump = null;
      const scene = (viewer ?? _viewer)?.scene;
      if (_root && !_root.isDestroyed?.()) {
        if (scene?.groundPrimitives?.contains?.(_root)) scene.groundPrimitives.remove(_root);
        else _root.destroy();
      }
      _root = null;
      _cells.clear();
      _inflight.clear();
      _visible = false;
      _viewer = null;
    },

    getStats() {
      let count = 0;
      for (const cell of _cells.values()) count += cell.lines;
      return { count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}
