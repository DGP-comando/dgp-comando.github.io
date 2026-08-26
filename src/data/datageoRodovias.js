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

import * as Cesium from 'cesium';

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

// Altura de camera abaixo da qual "entrou no municipio" e as municipais
// carregam (~um municipio medio na tela).
const MUNICIPAL_MAX_HEIGHT = 90_000;
// Grade de cache das buscas municipais (graus). ~0.25° ≈ 27 km.
const CELL_DEG = 0.25;
// Bbox do PR — fora dele nao ha o que buscar.
const PR_BBOX = { south: -26.75, north: -22.5, west: -54.65, east: -48.0 };
const MAX_CELLS_PER_VIEW = 12;

export const datageoRodoviasLayer = (() => {
  let _viewer = null;
  let _staticSources = [];
  let _munSource = null; // CustomDataSource das municipais
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
        if (!_munSource) return;
        let added = 0;
        for (const el of osm.elements ?? []) {
          const ref = el.tags?.ref ?? '';
          if (/^(BR|PRC?)-/.test(ref)) continue; // ja coberta pelos estaticos
          const geom = el.geometry ?? [];
          if (geom.length < 2) continue;
          const positions = geom.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
          _munSource.entities.add({
            id: `rodovia-mun:${el.id}`,
            polyline: {
              positions,
              clampToGround: true,
              width: 1.4,
              material: new Cesium.ColorMaterialProperty(MUN_COLOR),
            },
          });
          added += 1;
        }
        _loadedCells.add(key);
        if (added) _viewer.scene.requestRender();
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

  function syncMunicipais() {
    if (!_enabled || !_viewer || !_munSource) return;
    const height = _viewer.camera.positionCartographic?.height ?? Infinity;
    const zoomedIn = height < MUNICIPAL_MAX_HEIGHT;
    if (zoomedIn !== _munVisible) {
      _munVisible = zoomedIn;
      _munSource.show = zoomedIn;
      _viewer.scene.requestRender();
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
      for (const ds of _staticSources) ds.show = true;
      if (!_cameraListener && _viewer) {
        _cameraListener = onCameraIdle;
        _viewer.camera.changed.addEventListener(_cameraListener);
      }
      syncMunicipais();
    },

    disable() {
      _enabled = false;
      for (const ds of _staticSources) ds.show = false;
      if (_munSource) {
        _munSource.show = false;
        _munVisible = false;
      }
      if (_cameraListener && _viewer) {
        _viewer.camera.changed.removeEventListener(_cameraListener);
        _cameraListener = null;
      }
    },

    async update(viewer) {
      try {
        if (_staticSources.length === 0) {
          const [fed, est] = await Promise.all([
            Cesium.GeoJsonDataSource.load(FED_URL, {
              clampToGround: true,
              stroke: FED_COLOR,
              strokeWidth: 2.4,
            }),
            Cesium.GeoJsonDataSource.load(EST_URL, {
              clampToGround: true,
              stroke: EST_COLOR,
              strokeWidth: 1.6,
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
        _count = _staticSources.reduce((n, ds) => n + ds.entities.values.length, 0)
          + (_munSource?.entities.values.length ?? 0);
        _lastUpdate = Date.now();
        _lastError = null;
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
      for (const ds of _staticSources) viewer.dataSources.remove(ds, true);
      _staticSources = [];
      if (_munSource) {
        viewer.dataSources.remove(_munSource, true);
        _munSource = null;
      }
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
