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
//
// TOOLTIP: imagem e canvas não respondem a queryRenderedFeatures, então cada
// grade ganha uma fonte GeoJSON de células (um quadrado por nó, `id` = índice
// na grade, fill quase transparente) só para o pick; o tooltip lê o valor do
// índice nos arrays guardados aqui. Chuva: só as células molhadas (onde há
// desenho), para o resto do mapa seguir com o hover das outras camadas.

import { fetchWeatherGrid, fetchWindGrid } from '../../data/datageoClient.js';
import { loadClimaGrade } from '../../data/climaHistorico.js';
import { pintarPixels } from '../../data/climaHistoricoPixels.js';
import { INDICADORES, INDICADOR_PADRAO, indicador, legendaDe } from '../../data/climaHistoricoRamp.js';
import { PRECIP_CLASSES, PRECIP_FLOOR_MM, precipClassOf, precipLegend, tallyPrecip } from '../../data/precipitacaoRamp.js';
import { EMPTY_FC, defineLayer, fc, fmtCoord, fmtNum, tipCard } from '../kit.js';
import { cursorContext, trackCursor } from './transporte.js';
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

// ------------------------------------------------------- pick por célula

/** Fill de pick: invisível, mas consultável. */
const PICK_PAINT = Object.freeze({ 'fill-color': '#000000', 'fill-opacity': 0.01 });

/**
 * Um quadrado por nó da grade (bounds = CENTROS das células extremas, linha 0
 * = sul), com `id` e `properties.k` = índice j*width+i. `keep(k)` filtra.
 */
export function gridCellFeatures({ bounds, width, height }, keep = () => true) {
  const dLon = (bounds.east - bounds.west) / (width - 1);
  const dLat = (bounds.north - bounds.south) / (height - 1);
  const out = [];
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const k = j * width + i;
      if (!keep(k)) continue;
      const lon = bounds.west + i * dLon;
      const lat = bounds.south + j * dLat;
      const w = lon - dLon / 2;
      const e = lon + dLon / 2;
      const s = lat - dLat / 2;
      const n = lat + dLat / 2;
      out.push({
        type: 'Feature',
        id: k,
        properties: { k },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      });
    }
  }
  return out;
}

/** Centro {lat, lon} do nó k da grade. */
export function gridNode({ bounds, width, height }, k) {
  const i = k % width;
  const j = Math.floor(k / width);
  return {
    lon: bounds.west + (i * (bounds.east - bounds.west)) / (width - 1),
    lat: bounds.south + (j * (bounds.north - bounds.south)) / (height - 1),
  };
}

const RUMOS = ['N', 'NNE', 'NE', 'ENE', 'L', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

/**
 * Vento de (u, v) em m/s: velocidade (m/s e km/h), direção meteorológica (de
 * onde VEM, 0-360°) e rumo em 16 pontos (pt-BR: L = leste, O = oeste).
 */
export function ventoDe(u, v) {
  const U = Number(u);
  const V = Number(v);
  if (!Number.isFinite(U) || !Number.isFinite(V)) return null;
  const ms = Math.hypot(U, V);
  const deg = ms < 1e-6 ? null : ((Math.atan2(-U, -V) * 180) / Math.PI + 360) % 360;
  return { ms, kmh: ms * 3.6, deg, rumo: deg === null ? null : RUMOS[Math.round(deg / 22.5) % 16] };
}

/** Faixa (Beaufort agrupado) para o selo do vento. */
export function faixaVento(kmh) {
  if (!Number.isFinite(kmh)) return null;
  if (kmh < 2) return { text: 'CALMO', tone: 'muted' };
  if (kmh < 20) return { text: 'FRACO', tone: 'ok' };
  if (kmh < 39) return { text: 'MODERADO', tone: 'info' };
  if (kmh < 62) return { text: 'FORTE', tone: 'warn' };
  if (kmh < 89) return { text: 'VENDAVAL', tone: 'alert' };
  return { text: 'TEMPESTADE', tone: 'alert' };
}

const fmtVento = (w) => (w ? `${fmtNum(w.kmh, 0, 'km/h')} (${fmtNum(w.ms, 1, 'm/s')})` : '');
const fmtDirecao = (w) => (w?.deg === null || w?.deg === undefined ? '' : `de ${w.rumo} (${fmtNum(w.deg, 0)}°)`);

const PRECIP_TOM = Object.freeze({ chuvisco: 'info', fraca: 'info', moderada: 'warn', forte: 'alert', extrema: 'alert' });

function municipioRow(cur) {
  if (!cur?.municipio) return ['Município', null];
  return ['Município', cur.ibge ? `${cur.municipio} (IBGE ${cur.ibge})` : cur.municipio];
}

/** Resolução "0,33° × 0,34°" da grade Open-Meteo. */
const resolucao = ({ bounds, width, height }) =>
  `${fmtNum((bounds.east - bounds.west) / (width - 1), 2)}° × ${fmtNum((bounds.north - bounds.south) / (height - 1), 2)}° (${width} × ${height} pontos)`;

/**
 * Tooltip da chuva no nó k da grade Open-Meteo (mm na hora anterior), com o
 * vento do mesmo nó. `cur` = cursorContext (município).
 */
export function precipTooltip(grid, k, { cur = {}, now } = {}) {
  const mm = Number(grid?.precip?.[k]);
  if (!Number.isFinite(mm)) return '';
  const classe = PRECIP_CLASSES.find((c) => c.key === precipClassOf(mm));
  const node = gridNode(grid, k);
  const w = ventoDe(grid.u?.array?.[k], grid.v?.array?.[k]);
  return tipCard({
    icon: '🌧️',
    title: classe ? `Chuva ${classe.label.toLowerCase()}` : 'Sem chuva',
    subtitle: ['Precipitação na última hora', cur.municipio].filter(Boolean).join(' · '),
    badge: classe ? { text: classe.label, tone: PRECIP_TOM[classe.key] } : { text: 'SECO', tone: 'muted' },
    rows: [
      ['Chuva (1 h)', mm < 0.05 ? '0 mm' : fmtNum(mm, 1, 'mm'), classe ? PRECIP_TOM[classe.key] : null],
      ['Faixa', classe ? `${classe.label.toLowerCase()} · ${classe.blurb}` : `< ${fmtNum(PRECIP_FLOOR_MM, 1)} mm/h`],
      ['Vento (10 m)', w ? [fmtVento(w), fmtDirecao(w)].filter(Boolean).join(' ') : null],
      municipioRow(cur),
      ['Ponto da grade', fmtCoord(node.lat, node.lon, 2)],
      ['Resolução', resolucao(grid)],
    ],
    note: grid.stale ? 'Grade salva: a Open-Meteo não respondeu na última atualização.' : null,
    source: 'Open-Meteo (modelo) · DataGeo PR',
    updated: grid.fetchedAt,
    now,
  });
}

/** Tooltip do vento no nó k (u/v em m/s), com a chuva do mesmo nó. */
export function ventoTooltip(grid, k, { cur = {}, now } = {}) {
  const w = ventoDe(grid?.u?.array?.[k], grid?.v?.array?.[k]);
  if (!w) return '';
  const node = gridNode(grid, k);
  const mm = Number(grid.precip?.[k]);
  const faixa = faixaVento(w.kmh);
  return tipCard({
    icon: '💨',
    title: w.deg === null ? 'Vento calmo' : `Vento de ${w.rumo}`,
    subtitle: ['Vento a 10 m, agora', cur.municipio].filter(Boolean).join(' · '),
    badge: faixa,
    rows: [
      ['Velocidade', fmtVento(w), faixa?.tone === 'alert' || faixa?.tone === 'warn' ? faixa.tone : null],
      ['Direção (de onde vem)', w.deg === null ? null : `${w.rumo} · ${fmtNum(w.deg, 0)}°`],
      ['Chuva (1 h)', Number.isFinite(mm) ? (mm < 0.05 ? '0 mm' : fmtNum(mm, 1, 'mm')) : null],
      municipioRow(cur),
      ['Ponto da grade', fmtCoord(node.lat, node.lon, 2)],
      ['Resolução', resolucao(grid)],
    ],
    note: grid.stale ? 'Grade salva: a Open-Meteo não respondeu na última atualização.' : null,
    source: 'Open-Meteo (modelo) · DataGeo PR',
    updated: grid.fetchedAt,
    now,
  });
}

// Todos os campos da grade BR-DWGD, na ordem do tooltip.
export const CLIMA_CAMPOS = Object.freeze([
  Object.freeze({ key: 'pr', label: 'Chuva anual', unidade: 'mm/ano', casas: 0, sec: 'normal' }),
  Object.freeze({ key: 'tmed', label: 'Temperatura média', unidade: '°C', casas: 1, sec: 'normal' }),
  Object.freeze({ key: 'eto', label: 'Evapotranspiração (ETo)', unidade: 'mm/ano', casas: 0, sec: 'normal' }),
  Object.freeze({ key: 'balanco', label: 'Balanço hídrico (P − ETo)', unidade: 'mm/ano', casas: 0, sec: 'normal', sinal: true }),
  Object.freeze({ key: 'mesesDeficit', label: 'Meses com déficit hídrico', unidade: 'meses/ano', casas: 0, sec: 'normal' }),
  Object.freeze({ key: 'geada3', label: 'Geada provável (Tmín ≤ 3 °C)', unidade: 'dias/ano', casas: 0, sec: 'extremos' }),
  Object.freeze({ key: 'geada0', label: 'Geada forte (Tmín ≤ 0 °C)', unidade: 'dias/ano', casas: 0, sec: 'extremos' }),
  Object.freeze({ key: 'calor35', label: 'Calor (Tmáx ≥ 35 °C)', unidade: 'dias/ano', casas: 0, sec: 'extremos' }),
  Object.freeze({ key: 'chuva50', label: 'Chuva forte (≥ 50 mm/dia)', unidade: 'dias/ano', casas: 0, sec: 'extremos' }),
  Object.freeze({ key: 'tendTmed', label: 'Tendência da temperatura 1961–2019', unidade: '°C/década', casas: 2, sec: 'tendencia', sinal: true }),
]);

function fmtCampo(c, v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '';
  const s = fmtNum(n, c.casas, c.unidade);
  return c.sinal && n > 0 ? `+${s}` : s;
}

/**
 * Tooltip do clima histórico na célula k da grade BR-DWGD: o indicador ativo
 * (chip) em destaque e todos os outros campos da célula.
 */
export function climaTooltip(grade, k, { ativo = INDICADOR_PADRAO, cur = {} } = {}) {
  const campos = grade?.campos ?? {};
  if (!CLIMA_CAMPOS.some((c) => Number.isFinite(Number(campos[c.key]?.[k])) && campos[c.key]?.[k] !== null)) return '';
  const ind = indicador(ativo);
  const campoAtivo = CLIMA_CAMPOS.find((c) => c.key === ind.key);
  const valorAtivo = campos[ind.key]?.[k];
  const tomDe = (c, v) => (c.key === 'balanco' && Number(v) < 0 ? 'warn' : null);
  const rowsDa = (sec) => CLIMA_CAMPOS.filter((c) => c.sec === sec && c.key !== ind.key)
    .map((c) => [c.label, fmtCampo(c, campos[c.key]?.[k]), tomDe(c, campos[c.key]?.[k])]);
  const node = gridNode(grade, k);
  const [a, b] = grade.normal ?? [1990, 2019];
  return tipCard({
    icon: '📈',
    title: cur.municipio || 'Clima histórico',
    subtitle: `Normal climatológica ${a}–${b} · célula de 0,1° (~11 km)`,
    badge: { text: ind.chip, tone: 'info' },
    rows: [
      [campoAtivo?.label ?? ind.titulo, campoAtivo ? fmtCampo(campoAtivo, valorAtivo) : fmtNum(valorAtivo, ind.casas, ind.unidade), 'info'],
      ...rowsDa('normal'),
    ],
    sections: [
      { title: 'Extremos (média de dias por ano)', rows: rowsDa('extremos') },
      { title: 'Tendência', rows: rowsDa('tendencia') },
      { title: 'Local', rows: [['IBGE', cur.ibge], ['Centro da célula', fmtCoord(node.lat, node.lon, 2)]] },
    ],
    note: 'Grade interpolada de estações: serve para comparar regiões, não substitui a estação local.',
    source: 'BR-DWGD · Xavier et al. 2022 (CC BY 4.0)',
  });
}

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

  let pickReady = false;

  function render(ctx) {
    if (!grade) return;
    if (!pickReady) {
      // Máscara do PR: a chuva anual existe em toda célula dentro do estado.
      const mask = grade.campos?.pr ?? [];
      ctx.setData('dg-clima-historico-pick', fc(gridCellFeatures(grade, (k) => mask[k] !== null && mask[k] !== undefined)));
      pickReady = true;
    }
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
      'dg-clima-historico-pick': { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      {
        id: CLIMA_LAYER,
        type: 'raster',
        source: 'dg-clima-historico',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
      },
      { id: 'dg-clima-historico-pick', type: 'fill', source: 'dg-clima-historico-pick', paint: PICK_PAINT },
    ],
    interactive: ['dg-clima-historico-pick'],
    // Grade cobre o estado todo: cede o hover às camadas pontuais (layerHost).
    underlay: true,
    // Série histórica: nada a atualizar na sessão (o app usa 24 h).
    refreshMs: 24 * 3600_000,
    onEnable(ctx) {
      trackCursor(ctx.map);
      keepClimaBelowPrecip(ctx.map);
    },
    tooltip: (p, _f, ctx) => (grade ? climaTooltip(grade, Number(p.k), { ativo: params.indicador, cur: cursorContext(ctx) }) : ''),
    async load(ctx) {
      trackCursor(ctx.map);
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
  let grid = null;

  return defineLayer({
    id: 'datageo-precipitacao',
    name: 'Precipitação',
    category: 'Clima',
    icon: '🌧️',
    source: 'Open-Meteo',
    sources: {
      'dg-precipitacao': { type: 'image', url: BLANK_PNG, coordinates: PR_PLACEHOLDER },
      'dg-precipitacao-pick': { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      {
        id: PRECIP_LAYER,
        type: 'raster',
        source: 'dg-precipitacao',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
      },
      { id: 'dg-precipitacao-pick', type: 'fill', source: 'dg-precipitacao-pick', paint: PICK_PAINT },
    ],
    interactive: ['dg-precipitacao-pick'],
    // Grade cobre o estado todo: cede o hover às camadas pontuais (layerHost).
    underlay: true,
    refreshMs: 1_800_000,
    onEnable(ctx) {
      trackCursor(ctx.map);
      keepClimaBelowPrecip(ctx.map);
    },
    tooltip: (p, _f, ctx) => (grid ? precipTooltip(grid, Number(p.k), { cur: cursorContext(ctx) }) : ''),
    async load(ctx) {
      trackCursor(ctx.map);
      grid = await fetchWeatherGrid();
      // Pick só onde há chuva desenhada.
      ctx.setData('dg-precipitacao-pick', fc(gridCellFeatures(grid, (k) => Number(grid.precip[k]) >= PRECIP_FLOOR_MM)));
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
    sources: { 'dg-ventos-pick': { type: 'geojson', data: EMPTY_FC } },
    // As partículas são um canvas por cima do mapa (sem pick): o hover sai
    // desta grade de quadrados invisíveis, um por nó.
    layers: [{ id: 'dg-ventos-pick', type: 'fill', source: 'dg-ventos-pick', paint: PICK_PAINT }],
    interactive: ['dg-ventos-pick'],
    // Grade cobre o estado todo: cede o hover às camadas pontuais (layerHost).
    underlay: true,
    tooltip: (p, _f, ctx) => (grid ? ventoTooltip(grid, Number(p.k), { cur: cursorContext(ctx) }) : ''),
    refreshMs: 1_800_000,
    onEnable(ctx) {
      trackCursor(ctx.map);
      enabled = true;
      field ??= new WindParticleField(ctx.map);
      if (grid) field.start();
    },
    onDisable() {
      enabled = false;
      field?.stop();
    },
    async load(ctx) {
      trackCursor(ctx.map);
      grid = await fetchWindGrid();
      ctx.setData('dg-ventos-pick', fc(gridCellFeatures(grid)));
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
