// src/data/datageoClimaHistorico.js
//
// Clima historico do PR (BR-DWGD, 1961-2022): um campo estatico de 0,1 grau com
// um indicador por vez, escolhido nos chips da linha do painel (chuva, temperatura,
// geada, balanco hidrico, calor, tendencia de temperatura).
//
// E o CONTRAPONTO das camadas de precipitacao/ventos: aquelas dizem o que esta
// acontecendo agora (Open-Meteo), esta diz o que e normal ali. Ler as duas juntas
// e o uso pretendido, por isso o campo fica ABAIXO dos dois planos delas.
//
// Desenho: o mesmo retangulo texturizado de datageoPrecipitacao.js, e pelos
// mesmos motivos (imagery layer some no stack photoreal; GroundPrimitive
// texturizado degrada em silencio). Ver o cabecalho daquele arquivo antes de
// trocar a tecnica.

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { loadClimaGrade } from './climaHistorico.js';
import {
  INDICADORES,
  INDICADOR_PADRAO,
  corDe,
  indicador,
  legendaDe,
  maiorModulo,
} from './climaHistoricoRamp.js';

/**
 * Abaixo da precipitacao (90 m) e dos ventos (120 m): o normal e o fundo sobre o
 * qual o tempo presente e lido. Inverter a ordem esconde a chuva ao vivo.
 */
export const CLIMA_HIST_FIELD_HEIGHT_M = 60;

const TEXTURE_SCALE = 16;

/**
 * Pinta um indicador num canvas com anel transparente de uma celula. Linha 0 da
 * grade e o SUL (mesma convencao da grade Open-Meteo); o canvas cresce para
 * baixo, dai o `height - 1 - j`.
 * @param {{width: number, height: number}} grade
 * @param {Array<number|null>} valores
 * @param {object} ind
 * @param {number[]} quebras
 */
export function pintarPixels(grade, valores, ind, quebras) {
  const { width, height } = grade;
  const pad = 1;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  const maxAbs = maiorModulo(valores);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const target = ((height - 1 - j + pad) * w + (i + pad)) * 4;
      const [r, g, b, a] = corDe(valores[j * width + i], ind, quebras, maxAbs);
      data[target] = r;
      data[target + 1] = g;
      data[target + 2] = b;
      data[target + 3] = a;
    }
  }
  return { data, w, h };
}

function buildCanvas(grade, valores, ind, quebras) {
  const { data, w, h } = pintarPixels(grade, valores, ind, quebras);
  const source = document.createElement('canvas');
  source.width = w;
  source.height = h;
  source.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const scaled = document.createElement('canvas');
  scaled.width = w * TEXTURE_SCALE;
  scaled.height = h * TEXTURE_SCALE;
  const ctx = scaled.getContext('2d');
  // Classes discretas: sem suavizacao a celula de 11 km fica visivel como tal,
  // o que e honesto para uma grade interpolada de estacoes. So a borda do PR
  // perde o serrilhado, pelo anel transparente.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, scaled.width, scaled.height);
  return scaled;
}

function fieldRectangle({ bounds, width, height }) {
  const stepLon = (bounds.east - bounds.west) / (width - 1);
  const stepLat = (bounds.north - bounds.south) / (height - 1);
  // bounds sao CENTROS de celula: meia celula ate a borda da grade, mais uma
  // celula inteira do anel transparente.
  return Cesium.Rectangle.fromDegrees(
    bounds.west - 1.5 * stepLon,
    bounds.south - 1.5 * stepLat,
    bounds.east + 1.5 * stepLon,
    bounds.north + 1.5 * stepLat,
  );
}

export const datageoClimaHistoricoLayer = (() => {
  let _viewer = null;
  let _dataSource = null;
  let _grade = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _params = { indicador: INDICADOR_PADRAO };
  let _legend = [];
  let _cells = 0;

  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    if (!_grade) return;
    const ind = indicador(_params.indicador);
    const valores = _grade.campos?.[ind.key] || [];
    const quebras = _grade.classes?.[ind.key] || [];
    _cells = valores.filter((v) => v !== null && v !== undefined).length;
    _legend = legendaDe(valores, ind, quebras);
    if (_cells === 0) return;
    _dataSource.entities.add({
      id: 'datageo-clima-historico-field',
      rectangle: {
        coordinates: fieldRectangle(_grade),
        height: CLIMA_HIST_FIELD_HEIGHT_M,
        material: new Cesium.ImageMaterialProperty({
          image: buildCanvas(_grade, valores, ind, quebras),
          transparent: true,
        }),
      },
    });
    governorRequestRender('datageo-clima-historico');
  }

  return {
    id: 'datageo-clima-historico',
    name: 'Clima histórico (normal 1990–2019)',
    category: 'Clima',
    icon: '📈',
    source: 'BR-DWGD · Xavier et al. 2022',
    // Serie historica: nao ha o que atualizar em sessao.
    updateInterval: 24 * 3600_000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('datageo-clima-historico');
      _dataSource.show = _enabled;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:datageo-clima-historico] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      governorRequestRender('datageo-clima-historico');
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      governorRequestRender('datageo-clima-historico');
    },

    async update() {
      try {
        if (!_grade) {
          _grade = await loadClimaGrade();
          render();
        }
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-clima-historico]', err);
        return false;
      }
    },

    getParams() {
      return { ..._params };
    },

    setParams(params = {}) {
      if (params.indicador === undefined) return true;
      if (!INDICADORES.some((i) => i.key === params.indicador)) return false;
      if (params.indicador !== _params.indicador) {
        _params = { ..._params, indicador: params.indicador };
        render();
      }
      return true;
    },

    getRowControls() {
      return {
        chips: INDICADORES.map((ind) => ({
          id: `ind-${ind.key}`,
          label: ind.chip,
          active: ind.key === _params.indicador,
          title: ind.titulo,
          params: { indicador: ind.key },
        })),
        legend: _legend,
      };
    },

    destroy(viewer) {
      _enabled = false;
      if (_dataSource) viewer?.dataSources?.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _grade = null;
      _legend = [];
      _cells = 0;
    },

    getStats() {
      const ind = indicador(_params.indicador);
      return {
        count: _cells,
        lastUpdate: _lastUpdate,
        error: _lastError,
        source: `BR-DWGD · ${ind.titulo} (${ind.unidade})`,
      };
    },
  };
})();
