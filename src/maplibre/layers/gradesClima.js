// src/maplibre/layers/gradesClima.js
//
// Grades de clima do protótipo, portadas de src/data/datageoClimaHistorico.js,
// datageoPrecipitacao.js e datageoVentos.js (mesmos ids, nomes, fontes, rampas,
// legendas, chips e intervalos):
//
//   datageo-clima-historico  normal BR-DWGD 0,1° (JSON estático), um indicador
//                            por vez nos chips; fonte `image` com classes
//                            discretas (sem suavização), por baixo da chuva.
//   datageo-precipitacao     grade Open-Meteo 22x15 (fetchWeatherGrid, 30 min),
//                            fonte `image` suavizada com anel transparente.
//   datageo-ventos           a mesma grade (u/v), partículas animadas num canvas
//                            sobreposto (../windParticles.js).
//
// As duas imagens são reamostradas para Mercator (ver ../gridImage.js), o que
// as deixa no lugar certo também no globo.

import { fetchWeatherGrid, fetchWindGrid } from '../../data/datageoClient.js';
import { loadClimaGrade } from '../../data/climaHistorico.js';
import { pintarPixels } from '../../data/climaHistoricoPixels.js';
import { INDICADORES, INDICADOR_PADRAO, indicador, legendaDe } from '../../data/climaHistoricoRamp.js';
import { PRECIP_FLOOR_MM, precipLegend, tallyPrecip } from '../../data/precipitacaoRamp.js';
import { defineLayer } from '../kit.js';
import {
  BLANK_PNG,
  expandBounds,
  gridImageUrl,
  imageCoordinates,
  precipPixels,
} from '../gridImage.js';
import { WindParticleField } from '../windParticles.js';

const TEXTURE_SCALE = 16; // o mesmo fator do app
const PR_PLACEHOLDER = imageCoordinates({ west: -55, south: -27, east: -48, north: -22.3 });

const CLIMA_LAYER = 'dg-clima-historico-field';
const PRECIP_LAYER = 'dg-precipitacao-field';

/** O normal fica SEMPRE abaixo da chuva ao vivo, qualquer que seja a ordem de ligar. */
function keepClimaBelowPrecip(map) {
  if (map.getLayer(CLIMA_LAYER) && map.getLayer(PRECIP_LAYER)) map.moveLayer(CLIMA_LAYER, PRECIP_LAYER);
}

// ------------------------------------------------------- clima histórico

const climaHistorico = (() => {
  let grade = null;
  let params = { indicador: INDICADOR_PADRAO };
  let legend = [];
  let cells = 0;

  function render(ctx) {
    if (!grade) return;
    const ind = indicador(params.indicador);
    const valores = grade.campos?.[ind.key] || [];
    const quebras = grade.classes?.[ind.key] || [];
    cells = valores.filter((v) => v !== null && v !== undefined).length;
    legend = legendaDe(valores, ind, quebras);
    const src = ctx.map.getSource('dg-clima-historico');
    if (!src) return;
    const box = expandBounds(grade, 1.5);
    if (cells === 0) {
      src.updateImage({ url: BLANK_PNG, coordinates: imageCoordinates(box) });
      return;
    }
    const url = gridImageUrl(pintarPixels(grade, valores, ind, quebras), {
      // Classes discretas: sem suavização a célula de 11 km fica visível como tal.
      scale: TEXTURE_SCALE, smooth: false, south: box.south, north: box.north,
    });
    src.updateImage({ url, coordinates: imageCoordinates(box) });
  }

  return defineLayer({
    id: 'datageo-clima-historico',
    name: 'Clima histórico (normal 1990–2019)',
    category: 'Clima',
    icon: '📈',
    source: 'BR-DWGD · Xavier et al. 2022',
    sources: {
      'dg-clima-historico': { type: 'image', url: BLANK_PNG, coordinates: PR_PLACEHOLDER },
    },
    layers: [
      {
        id: CLIMA_LAYER,
        type: 'raster',
        source: 'dg-clima-historico',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
      },
    ],
    // Série histórica: nada a atualizar na sessão (o app usa 24 h).
    refreshMs: 24 * 3600_000,
    onEnable: (ctx) => keepClimaBelowPrecip(ctx.map),
    async load(ctx) {
      if (!grade) {
        grade = await loadClimaGrade();
        render(ctx);
      }
      // O indicador ativo aparece no chip aceso (o `info` da linha só muda no
      // load, e trocar de chip não recarrega).
      return cells;
    },
    rowControls: () => ({
      chips: INDICADORES.map((ind) => ({ id: `ind-${ind.key}`, label: ind.chip, active: ind.key === params.indicador })),
      legend,
    }),
    onChip(chipId, ctx) {
      const key = String(chipId).replace(/^ind-/, '');
      if (!INDICADORES.some((i) => i.key === key) || key === params.indicador) return;
      params = { ...params, indicador: key };
      render(ctx);
    },
  });
})();

// ---------------------------------------------------------- precipitação

const precipitacao = (() => {
  let legend = [];

  return defineLayer({
    id: 'datageo-precipitacao',
    name: 'Precipitação',
    category: 'Clima',
    icon: '🌧️',
    source: 'Open-Meteo',
    sources: {
      'dg-precipitacao': { type: 'image', url: BLANK_PNG, coordinates: PR_PLACEHOLDER },
    },
    layers: [
      {
        id: PRECIP_LAYER,
        type: 'raster',
        source: 'dg-precipitacao',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
      },
    ],
    refreshMs: 1_800_000,
    onEnable: (ctx) => keepClimaBelowPrecip(ctx.map),
    async load(ctx) {
      const grid = await fetchWeatherGrid();
      const tally = tallyPrecip(grid.precip);
      legend = precipLegend(tally.counts);
      const box = expandBounds(grid, 1);
      // Grade seca: nada desenhado (um véu roxo diria "chuva fraca em tudo").
      const url = tally.wet === 0
        ? BLANK_PNG
        : gridImageUrl(precipPixels(grid), { scale: TEXTURE_SCALE, smooth: true, south: box.south, north: box.north });
      ctx.map.getSource('dg-precipitacao')?.updateImage({ url, coordinates: imageCoordinates(box) });
      const fetchedAt = Number.isFinite(grid.fetchedAt) ? grid.fetchedAt : null;
      return {
        count: tally.wet,
        info: [
          grid.stale === true ? 'grade salva (API indisponível)' : null,
          fetchedAt && tally.wet === 0 ? `sem chuva ≥ ${String(PRECIP_FLOOR_MM).replace('.', ',')} mm/h` : null,
          fetchedAt ? `dado de ${new Date(fetchedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : null,
        ].filter(Boolean).join(' · ') || null,
      };
    },
    rowControls: () => ({ chips: [], legend }),
  });
})();

// ---------------------------------------------------------------- ventos

const ventos = (() => {
  let field = null;
  let enabled = false;
  let grid = null;

  return defineLayer({
    id: 'datageo-ventos',
    name: 'Ventos',
    category: 'Clima',
    icon: '💨',
    source: 'Open-Meteo',
    refreshMs: 1_800_000,
    onEnable(ctx) {
      enabled = true;
      field ??= new WindParticleField(ctx.map);
      if (grid) field.start();
    },
    onDisable() {
      enabled = false;
      field?.stop();
    },
    async load(ctx) {
      grid = await fetchWindGrid();
      field ??= new WindParticleField(ctx.map);
      field.setData(grid);
      if (enabled) field.start();
      return {
        count: grid.width * grid.height,
        info: grid.stale ? 'grade salva (API indisponível)' : null,
      };
    },
  });
})();

export default [climaHistorico, precipitacao, ventos];
