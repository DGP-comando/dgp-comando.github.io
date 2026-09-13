// src/data/datageoPrecipitacao.js
//
// Campo de precipitacao do PR, irmao da camada de ventos: as duas leem a MESMA
// grade Open-Meteo (fetchWeatherGrid, 22x15 sobre o estado, 30 min) na MESMA
// requisicao, e sao desenhadas para serem lidas juntas — a chuva como um manto
// continuo por baixo, o vento como riscos animados por cima.
//
// COMO E DESENHADO, E POR QUE NAO E UMA IMAGERY LAYER
//
// O caminho obvio (viewer.imageryLayers + SingleTileImageryProvider) esta MORTO
// neste app: no stack photoreal o globo e escondido (mapStackController) e o
// Cesium so desenha imagery dentro de Globe.render(), que retorna cedo quando
// `globe.show` e falso. A camada sumiria no stack padrao de quem tem chave
// Google.
//
// Por isso o campo e UMA entidade `rectangle` com textura de canvas, a uma
// altura absoluta fixa. Retangulo texturizado grudado no terreno
// (GroundPrimitive com material) e explicitamente desaconselhado pelo proprio
// Cesium e degrada em SILENCIO para cor chapada onde a extensao WebGL nao
// existe; um retangulo comum nao depende do globo, nem de classificacao, nem
// de extensao nenhuma, e na escala estadual em que esta camada e usada um
// plano e indistinguivel de um drape.
//
// A suavizacao sai de graca: um texel por celula num canvas 24x17 e o upscale
// do proprio browser (imageSmoothingEnabled) fazem a bilinear. O anel
// TRANSPARENTE de uma celula em volta e o que faz a borda do dado esmaecer ate
// zero, em vez de cortar um retangulo duro que se leria como frente fria.

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { fetchWeatherGrid } from './datageoClient.js';
import {
  PRECIP_FLOOR_MM,
  precipLegend,
  precipRgba,
  tallyPrecip,
} from './precipitacaoRamp.js';

/**
 * Altura absoluta do plano, em metros.
 *
 * Presa por baixo E por cima. Acima de zero para nao brigar com a superficie
 * do globo nos stacks com basemap 2D (o terreno do app e o elipsoide: o
 * Cesium World Terrain esta desligado de proposito, ver main.js), e ABAIXO do
 * `particleHeight: 120` da camada de ventos, para o vento passar por cima da
 * chuva e nao por baixo. Mexer em um dos dois sem o outro inverte a leitura.
 */
export const PRECIP_FIELD_HEIGHT_M = 90;

/** Fator de ampliacao do canvas da grade; so alimenta a bilinear do browser. */
const TEXTURE_SCALE = 16;

/**
 * Pinta a grade num canvas com um anel transparente de uma celula em volta.
 * @param {{precip: ArrayLike<number>, width: number, height: number}} grid
 * @returns {HTMLCanvasElement}
 */
function buildFieldCanvas({ precip, width, height }) {
  const pad = 1;
  const source = document.createElement('canvas');
  source.width = width + pad * 2;
  source.height = height + pad * 2;
  const sourceCtx = source.getContext('2d');
  // createImageData nasce toda zerada, ou seja, o anel ja e transparente.
  const image = sourceCtx.createImageData(source.width, source.height);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      // Linha 0 da grade e o SUL (convencao do cesium-wind-layer, flipY false);
      // canvas cresce para BAIXO. Sem inverter j, a chuva sairia espelhada em
      // relacao ao vento que ela acompanha.
      const target = ((height - 1 - j + pad) * source.width + (i + pad)) * 4;
      const [r, g, b, a] = precipRgba(precip[j * width + i]);
      image.data[target] = r;
      image.data[target + 1] = g;
      image.data[target + 2] = b;
      image.data[target + 3] = a;
    }
  }
  sourceCtx.putImageData(image, 0, 0);

  const scaled = document.createElement('canvas');
  scaled.width = source.width * TEXTURE_SCALE;
  scaled.height = source.height * TEXTURE_SCALE;
  const scaledCtx = scaled.getContext('2d');
  scaledCtx.imageSmoothingEnabled = true;
  scaledCtx.imageSmoothingQuality = 'high';
  scaledCtx.drawImage(source, 0, 0, scaled.width, scaled.height);
  return scaled;
}

/**
 * Retangulo do campo, uma celula maior que a grade em cada lado para casar com
 * o anel transparente do canvas.
 * @param {{west: number, south: number, east: number, north: number}} bounds
 * @param {number} width
 * @param {number} height
 * @returns {Cesium.Rectangle}
 */
function fieldRectangle(bounds, width, height) {
  const stepLon = (bounds.east - bounds.west) / (width - 1);
  const stepLat = (bounds.north - bounds.south) / (height - 1);
  return Cesium.Rectangle.fromDegrees(
    bounds.west - stepLon,
    bounds.south - stepLat,
    bounds.east + stepLon,
    bounds.north + stepLat,
  );
}

export const datageoPrecipitacaoLayer = (() => {
  let _viewer = null;
  let _dataSource = null;
  let _entity = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _tally = { counts: {}, wet: 0, maxMm: 0 };
  // A linha do painel se repinta a cada segundo; a legenda tem que ser O(1).
  let _legend = [];

  function clearField() {
    if (_dataSource) _dataSource.entities.removeAll();
    _entity = null;
  }

  function renderField(grid) {
    if (!_viewer || !_dataSource) return;
    _tally = tallyPrecip(grid.precip);
    _legend = precipLegend(_tally.counts);
    clearField();
    // Grade seca: nao desenhar nada e a leitura correta. Um veu roxo sobre o
    // estado inteiro diria "chuva fraca em tudo" quando o dado diz "nada".
    if (_tally.wet === 0) return;
    _entity = _dataSource.entities.add({
      id: 'datageo-precipitacao-field',
      rectangle: {
        coordinates: fieldRectangle(grid.bounds, grid.width, grid.height),
        height: PRECIP_FIELD_HEIGHT_M,
        material: new Cesium.ImageMaterialProperty({
          image: buildFieldCanvas(grid),
          transparent: true,
        }),
      },
    });
  }

  return {
    id: 'datageo-precipitacao',
    name: 'Precipitação',
    category: 'Clima',
    icon: '🌧️',
    source: 'Open-Meteo',
    updateInterval: 1_800_000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('datageo-precipitacao');
      _dataSource.show = _enabled;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:datageo-precipitacao] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      // Campo ESTATICO: nunca segura o render governor como a camada de
      // ventos faz (la as particulas animam todo frame). Um pedido pontual
      // basta para a textura nova chegar a tela no modo ocioso.
      governorRequestRender('datageo-precipitacao');
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      governorRequestRender('datageo-precipitacao');
    },

    async update() {
      try {
        const grid = await fetchWeatherGrid();
        renderField(grid);
        // Hora do DADO, nao do poll: a grade pode vir do localStorage.
        _lastUpdate = Number.isFinite(grid.fetchedAt) ? grid.fetchedAt : Date.now();
        _stale = grid.stale === true;
        _lastError = null;
        governorRequestRender('datageo-precipitacao');
        console.log(
          `[Data:datageo-precipitacao] ${_tally.wet} celulas com chuva, max ${_tally.maxMm.toFixed(1)} mm/h`,
        );
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-precipitacao]', err);
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      clearField();
      if (_dataSource) viewer?.dataSources?.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _legend = [];
      _tally = { counts: {}, wet: 0, maxMm: 0 };
    },

    /** Legenda por classe de intensidade na linha do painel. */
    getRowControls() {
      return { chips: [], legend: _legend };
    },

    getStats() {
      return {
        count: _tally.wet,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Distingue "nao choveu" de "nao carregou" na propria linha do painel.
        source: [
          'Open-Meteo',
          _stale ? 'grade salva (API indisponível)' : null,
          _lastUpdate && _tally.wet === 0
            ? `sem chuva ≥ ${String(PRECIP_FLOOR_MM).replace('.', ',')} mm/h`
            : null,
        ].filter(Boolean).join(' · '),
      };
    },
  };
})();
