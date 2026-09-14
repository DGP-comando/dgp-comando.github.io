// src/data/datageoDistribuicao.js
//
// Rede de distribuição de média tensão da Copel (classe Infraestrutura):
// ~777 mil trechos e ~205 mil km de 13,8 e 34,5 kV, da BDGD/ANEEL via
// scripts/build_distribuicao.py.
//
// Vista do estado inteiro a rede é um borrão que cobre o mapa e custaria
// dezenas de MB; por isso ela vem FATIADA em células de 0,25° e só aparece
// perto do chão (mesma lógica das rodovias municipais, mas lendo arquivos
// estáticos em vez do Overpass):
//   - index.json diz quais células existem (nenhum 404 fora da área Copel);
//   - com a câmera abaixo de MAX_HEIGHT, carrega as células mais próximas do
//     centro da vista, até MAX_CELLS_PER_VIEW;
//   - cada célula vira UMA PrimitiveCollection com um GroundPolylinePrimitive
//     por tensão (mesmo lote barato das rodovias, sem pick);
//   - acima de MAX_LOADED_CELLS as células mais antigas fora da vista são
//     destruídas, para a memória de GPU não crescer num passeio pelo estado.

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { createReadyPump } from './entityDiff.js';

const BASE_URL = '/data/distribuicao';
const MAX_HEIGHT = 70_000;
const MAX_CELLS_PER_VIEW = 9;
const MAX_LOADED_CELLS = 24;

// Cor e largura por tensão nominal (kV), na ordem de `tensoes` do index.
const KV_STYLES = Object.freeze({
  34.5: Object.freeze({ color: Cesium.Color.fromCssColorString('#fb7185').withAlpha(0.8), width: 1.6 }),
  13.8: Object.freeze({ color: Cesium.Color.fromCssColorString('#34d399').withAlpha(0.7), width: 1.1 }),
});
const FALLBACK_STYLE = Object.freeze({ color: Cesium.Color.WHITE.withAlpha(0.6), width: 1 });

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
 * Decodifica o payload de uma célula (delta encadeado, ver o build) em
 * trechos com graus planos [lon0, lat0, lon1, lat1, ...], agrupados por
 * índice de tensão.
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
export function nearestCells(lat, lon, index, limit = MAX_CELLS_PER_VIEW, rings = 2) {
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

export const datageoDistribuicaoLayer = (() => {
  let _viewer = null;
  let _index = null;
  let _root = null; // PrimitiveCollection em scene.groundPrimitives
  const _cells = new Map(); // key -> { collection, lines, lastSeen }
  const _inflight = new Set();
  let _enabled = false;
  let _visible = false;
  let _cameraListener = null;
  let _debounce = null;
  let _pump = null;
  let _lastUpdate = null;
  let _lastError = null;

  function requestFrame(reason) {
    governorRequestRender(`datageo-distribuicao:${reason}`);
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

  async function loadIndex() {
    if (_index) return _index;
    const resp = await fetch(`${BASE_URL}/index.json`);
    if (!resp.ok) throw new Error(`index.json HTTP ${resp.status}`);
    const index = await resp.json();
    if (!index?.cells || !index.cell_deg || !index.escala || !Array.isArray(index.tensoes)) {
      throw new Error('index.json da distribuição sem cells/cell_deg/escala/tensoes');
    }
    _index = index;
    return index;
  }

  async function loadCell(key) {
    if (_cells.has(key) || _inflight.has(key)) return;
    _inflight.add(key);
    try {
      const resp = await fetch(`${BASE_URL}/${key}.json`);
      if (!resp.ok) throw new Error(`célula ${key} HTTP ${resp.status}`);
      const payload = await resp.json();
      if (!_root || _root.isDestroyed?.()) return; // destruída durante o fetch
      const porTensao = decodeCell(payload, key, _index);
      const collection = new Cesium.PrimitiveCollection();
      let lines = 0;
      porTensao.forEach((flatLines, k) => {
        const style = KV_STYLES[_index.tensoes[k]] ?? FALLBACK_STYLE;
        const batch = createLineBatch(flatLines, style);
        if (batch) collection.add(batch);
        lines += flatLines.length;
      });
      _root.add(collection);
      _cells.set(key, { collection, lines, lastSeen: Date.now() });
      startPump();
      requestFrame('celula');
    } catch (err) {
      _lastError = err?.message || String(err);
      console.warn('[Data:datageo-distribuicao]', err);
    } finally {
      _inflight.delete(key);
    }
  }

  function evict(keep) {
    if (_cells.size <= MAX_LOADED_CELLS) return;
    const antigas = [..._cells.entries()]
      .filter(([key]) => !keep.has(key))
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key, cell] of antigas) {
      if (_cells.size <= MAX_LOADED_CELLS) break;
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
    const height = carto?.height ?? Infinity;
    setVisible(height < MAX_HEIGHT);
    if (!_visible) return;
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
        console.warn('[Data:datageo-distribuicao]', err);
      });
    }, 400);
  }

  return {
    id: 'datageo-distribuicao',
    name: 'Linhas de distribuição',
    category: 'Infraestrutura',
    icon: '🔗',
    source: 'ANEEL/BDGD (Copel)',
    updateInterval: 24 * 3600_000,

    init(viewer) {
      _viewer = viewer;
      console.log('[Data:datageo-distribuicao] Initialized');
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
        console.warn('[Data:datageo-distribuicao]', err);
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
})();
