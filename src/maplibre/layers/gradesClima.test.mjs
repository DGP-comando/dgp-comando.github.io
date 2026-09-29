import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandBounds,
  imageCoordinates,
  latFromMercatorY,
  mercatorRowSource,
  mercatorY,
  precipPixels,
} from '../gridImage.js';
import {
  advect,
  latticeCell,
  libPixelSize,
  metersPerDegree,
  metersPerPixel,
  rampColor,
  speedRange,
  trailAlpha,
  windAt,
} from '../windParticles.js';
import { pintarPixels } from '../../data/climaHistoricoPixels.js';
import { indicador } from '../../data/climaHistoricoRamp.js';
import { WIND_PARTICLE_STYLE } from '../../data/ventosOptions.js';

const BOUNDS = { west: -55, south: -27, east: -48, north: -22.3 };

function gridOf(width, height, fu, fv, precip = () => 0) {
  const u = new Float32Array(width * height);
  const v = new Float32Array(width * height);
  const p = new Float32Array(width * height);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      u[j * width + i] = fu(i, j);
      v[j * width + i] = fv(i, j);
      p[j * width + i] = precip(i, j);
    }
  }
  return { u: { array: u }, v: { array: v }, precip: p, width, height, bounds: BOUNDS };
}

test('mercator: ida e volta e reamostragem de linhas', () => {
  for (const lat of [-27, -24.6, -22.3, 0, 45]) assert.ok(Math.abs(latFromMercatorY(mercatorY(lat)) - lat) < 1e-9);
  // Primeira e última linha caem perto das bordas; o meio da imagem Mercator
  // fica ao SUL do meio equirretangular (latitudes maiores em módulo esticam).
  const rows = 100;
  assert.ok(mercatorRowSource(0, rows, -27, -22.3) < 0.01);
  assert.ok(mercatorRowSource(rows - 1, rows, -27, -22.3) > 0.99);
  const mid = mercatorRowSource(49.5, rows, -27, -22.3);
  assert.ok(mid > 0.5 && mid < 0.52, `meio ${mid}`);
  // Monotônica.
  let prev = -1;
  for (let r = 0; r < rows; r += 1) {
    const s = mercatorRowSource(r, rows, -27, -22.3);
    assert.ok(s > prev);
    prev = s;
  }
});

test('retângulo da imagem casa com o fieldRectangle do app', () => {
  const g = { bounds: BOUNDS, width: 22, height: 15 };
  const stepLon = 7 / 21;
  const stepLat = 4.7 / 14;
  const one = expandBounds(g, 1);
  assert.ok(Math.abs(one.west - (-55 - stepLon)) < 1e-12);
  assert.ok(Math.abs(one.north - (-22.3 + stepLat)) < 1e-12);
  const c = imageCoordinates(one);
  assert.deepEqual(c[0], [one.west, one.north]);
  assert.deepEqual(c[2], [one.east, one.south]);
});

test('precipitação: linha 0 é o sul, anel transparente, seco é transparente', () => {
  const g = gridOf(3, 2, () => 0, () => 0, (i, j) => (i === 0 && j === 0 ? 30 : 0));
  const { data, w, h } = precipPixels(g);
  assert.equal(w, 5);
  assert.equal(h, 4);
  // Anel todo transparente.
  for (let x = 0; x < w; x += 1) {
    assert.equal(data[(0 * w + x) * 4 + 3], 0);
    assert.equal(data[((h - 1) * w + x) * 4 + 3], 0);
  }
  // Célula (0,0) = SO: coluna 1, penúltima linha da imagem.
  const k = ((h - 2) * w + 1) * 4;
  assert.ok(data[k + 3] > 150, 'chuva forte bem opaca');
  // Célula seca ao lado: transparente.
  assert.equal(data[((h - 2) * w + 2) * 4 + 3], 0);
});

test('clima histórico: pintarPixels respeita a orientação e as classes', () => {
  const ind = indicador('pr');
  const grade = { width: 2, height: 2 };
  const { data, w } = pintarPixels(grade, [100, null, null, 3000], ind, [1000, 1500, 2000, 2500]);
  const px = (x, y) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
  // (0,0) sul-oeste -> imagem linha 2, coluna 1: classe 0 (#1d2f5c).
  assert.deepEqual(px(1, 2).slice(0, 3), [0x1d, 0x2f, 0x5c]);
  // (1,1) norte-leste -> linha 1, coluna 2: classe 4 (#c9b86a).
  assert.deepEqual(px(2, 1).slice(0, 3), [0xc9, 0xb8, 0x6a]);
  assert.equal(px(2, 2)[3], 0, 'sem dado é transparente');
});

test('vento bilinear: nós exatos, meio da célula e fora da grade', () => {
  const g = gridOf(3, 3, (i) => i, (i, j) => j * 2);
  const stepLon = 3.5;
  const stepLat = 2.35;
  assert.deepEqual(windAt(g, -55, -27), [0, 0]);
  assert.deepEqual(windAt(g, -48, -22.3), [2, 4]);
  const [u, v] = windAt(g, -55 + stepLon / 2, -27 + stepLat / 2);
  assert.ok(Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 1) < 1e-6);
  assert.equal(windAt(g, -56, -25), null);
  assert.equal(windAt(g, -50, -20), null);
});

test('advecção: leste puro anda para leste com a escala da lib', () => {
  const g = gridOf(4, 4, () => 10, () => 0);
  const lat = -25;
  const scale = (1000 + 50) * WIND_PARTICLE_STYLE.speedFactor;
  const [lon1, lat1, speed] = advect(g, -52, lat, scale, 1);
  assert.equal(speed, 10);
  assert.ok(Math.abs(lat1 - lat) < 1e-12);
  const [mLon] = metersPerDegree(lat);
  // 0,5 · 10 m/s · 1260 m = 6.300 m por quadro.
  assert.ok(Math.abs((lon1 + 52) * mLon - 0.5 * 10 * scale) < 1e-6);
  // Dois quadros de uma vez andam o dobro.
  const [lon2] = advect(g, -52, lat, scale, 2);
  assert.ok(Math.abs((lon2 + 52) - 2 * (lon1 + 52)) < 1e-12);
  // Norte puro: v > 0 sobe a latitude.
  const gn = gridOf(4, 4, () => 0, () => 5);
  assert.ok(advect(gn, -52, lat, scale)[1] > lat);
  // Vento nulo e fora da grade: nada.
  assert.equal(advect(gridOf(4, 4, () => 0, () => 0), -52, lat, scale), null);
  assert.equal(advect(g, -60, lat, scale), null);
});

test('velocidade de tela ~ constante: m/px e domínio', () => {
  assert.ok(Math.abs(metersPerPixel(0, 0) - 78271.517) < 0.01);
  assert.ok(Math.abs(metersPerPixel(1, 0) * 2 - metersPerPixel(0, 0)) < 1e-9);
  const g = gridOf(2, 2, (i) => 3 * i, (i, j) => 4 * j);
  const r = speedRange(g);
  assert.equal(r.min, 0);
  assert.equal(r.max, Math.hypot(3, 4));
});

test('rampa e opacidade do traço seguem a lib', () => {
  const { colors } = WIND_PARTICLE_STYLE;
  assert.deepEqual(rampColor(colors, 0), [0x93, 0xc5, 0xfd]);
  assert.deepEqual(rampColor(colors, 1), [0xff, 0xff, 0xff]);
  // Centro do 2º texel = 2º cor exata.
  assert.deepEqual(rampColor(colors, 1.5 / 4), [0xbf, 0xdb, 0xfe]);
  assert.equal(trailAlpha(0), 0);
  assert.equal(trailAlpha(1), 1);
  assert.ok(trailAlpha(0.3) < trailAlpha(0.7));
});

test('célula da malha de projeção', () => {
  const c = latticeCell(-27, -55, 0.5, 0.5, 15, 10, -54.25, -26.9);
  assert.equal(c.i, 1);
  assert.equal(c.j, 0);
  assert.ok(Math.abs(c.s - 0.5) < 1e-9 && Math.abs(c.t - 0.2) < 1e-9);
  // Borda leste/norte fica na última célula.
  const e = latticeCell(-27, -55, 0.5, 0.5, 15, 10, -48, -22.5);
  assert.equal(e.i, 13);
  assert.equal(e.j, 8);
  assert.equal(latticeCell(-27, -55, 0.5, 0.5, 15, 10, -47, -25), null);
});

test('pixelSize da lib: 1000 com a grade inteira, proporcional à fração visível', () => {
  assert.equal(libPixelSize({ west: -80, south: -40, east: -30, north: 0 }, BOUNDS), 1000);
  // Um décimo da largura e da altura visível (+5% de folga de cada lado).
  const v = libPixelSize({ west: -52, south: -25, east: -51.3, north: -24.53 }, BOUNDS);
  assert.ok(Math.abs(v - 110) < 1e-6, `pixelSize ${v}`);
  assert.equal(libPixelSize({ west: 10, south: 10, east: 20, north: 20 }, BOUNDS), null);
});

// ------------------------------------------------------------- tooltips

import gradesClima, {
  climaTooltip, faixaVento, gridCellFeatures, gridNode, precipTooltip, ventoDe, ventoTooltip,
} from './gradesClima.js';

const text = (html) => html.replace(/<\/(dt|dd|div|span)>/g, '$& ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('células de pick: um quadrado por nó, id = índice, linha 0 no sul, filtro', () => {
  const g = { bounds: { west: -50, south: -26, east: -49, north: -25 }, width: 3, height: 2 };
  const all = gridCellFeatures(g);
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((f) => f.id), [0, 1, 2, 3, 4, 5]);
  assert.equal(all[4].properties.k, 4);
  // Nó 4 = (i 1, j 1): lon -49,5, lat -25; meio passo para cada lado.
  assert.deepEqual(all[4].geometry.coordinates[0], [[-49.75, -25.5], [-49.25, -25.5], [-49.25, -24.5], [-49.75, -24.5], [-49.75, -25.5]]);
  assert.deepEqual(gridNode(g, 4), { lon: -49.5, lat: -25 });
  assert.deepEqual(gridCellFeatures(g, (k) => k % 2 === 0).map((f) => f.id), [0, 2, 4]);
});

test('vento: direção meteorológica (de onde vem), rumo pt-BR e faixa', () => {
  // Vento que sopra PARA o norte (v > 0) vem do sul.
  assert.equal(ventoDe(0, 5).rumo, 'S');
  assert.equal(Math.round(ventoDe(0, 5).deg), 180);
  // Soprando para oeste (u < 0) vem de leste: "L".
  assert.equal(ventoDe(-3, 0).rumo, 'L');
  assert.equal(ventoDe(3, 3).rumo, 'SO');
  assert.ok(Math.abs(ventoDe(3, 4).kmh - 18) < 1e-9);
  assert.equal(ventoDe(0, 0).deg, null);
  assert.equal(ventoDe('x', 1), null);
  assert.deepEqual(faixaVento(1), { text: 'CALMO', tone: 'muted' });
  assert.equal(faixaVento(45).tone, 'warn');
  assert.equal(faixaVento(70).text, 'VENDAVAL');
});

test('tooltips da grade Open-Meteo: chuva e vento no nó, município, hora do dado', () => {
  const grid = gridOf(3, 2, () => -5, () => 0, (i, j) => (i === 1 && j === 1 ? 12.34 : 0));
  grid.fetchedAt = Date.parse('2026-09-27T10:00:00Z');
  const now = grid.fetchedAt + 12 * 60_000;
  const cur = { municipio: 'Guarapuava', ibge: '4109401' };
  const p = text(precipTooltip(grid, 4, { cur, now }));
  assert.match(p, /Chuva forte FORTE Precipitação na última hora · Guarapuava/);
  assert.match(p, /Chuva \(1 h\) 12,3 mm Faixa forte · 10–25 mm\/h Vento \(10 m\) 18 km\/h \(5,0 m\/s\) de L \(90°\)/);
  assert.match(p, /Município Guarapuava \(IBGE 4109401\) Ponto da grade -22,30°, -51,50°/);
  assert.match(p, /Open-Meteo \(modelo\) · DataGeo PR · atualizado há 12 min/);
  assert.match(precipTooltip(grid, 4, { now }), /tt-badge tt-alert/);
  assert.match(text(precipTooltip(grid, 0, { now })), /Sem chuva SECO .*Chuva \(1 h\) 0 mm/);
  grid.stale = true;
  assert.match(text(precipTooltip(grid, 4, { now })), /Grade salva/);
  grid.stale = false;

  const v = text(ventoTooltip(grid, 0, { cur, now }));
  assert.match(v, /Vento de L FRACO Vento a 10 m, agora · Guarapuava/);
  assert.match(v, /Velocidade 18 km\/h \(5,0 m\/s\) Direção \(de onde vem\) L · 90° Chuva \(1 h\) 0 mm/);
  assert.match(v, /Resolução 3,50° × 4,70° \(3 × 2 pontos\)/);
  assert.equal(ventoTooltip({ u: { array: [] }, v: { array: [] } }, 0), '');
});

test('tooltip do clima histórico: indicador do chip em destaque e todos os campos', () => {
  const grade = {
    bounds: { west: -50, south: -26, east: -49.9, north: -25.9 }, width: 2, height: 2, normal: [1990, 2019],
    campos: {
      pr: [null, 1650.4, null, null], tmed: [null, 18.46, null, null], eto: [null, 1100, null, null],
      balanco: [null, -35, null, null], mesesDeficit: [null, 2, null, null], geada3: [null, 7.6, null, null],
      geada0: [null, 1.2, null, null], calor35: [null, 0, null, null], chuva50: [null, 3, null, null],
      tendTmed: [null, 0.234, null, null],
    },
  };
  const html = climaTooltip(grade, 1, { ativo: 'tmed', cur: { municipio: 'Palmas', ibge: '4117602' } });
  const t = text(html);
  assert.match(t, /^📈 Palmas TEMP Normal climatológica 1990–2019 · célula de 0,1° \(~11 km\)/);
  assert.match(t, /Temperatura média 18,5 °C Chuva anual 1.650 mm\/ano Evapotranspiração \(ETo\) 1.100 mm\/ano/);
  assert.match(t, /Balanço hídrico \(P − ETo\) -35 mm\/ano Meses com déficit hídrico 2 meses\/ano/);
  assert.match(t, /Extremos \(média de dias por ano\) Geada provável \(Tmín ≤ 3 °C\) 8 dias\/ano .*Calor \(Tmáx ≥ 35 °C\) 0 dias\/ano/);
  assert.match(t, /Tendência Tendência da temperatura 1961–2019 \+0,23 °C\/década/);
  assert.match(t, /IBGE 4117602 Centro da célula -26,00°, -49,90°/);
  assert.match(t, /BR-DWGD · Xavier et al\. 2022 \(CC BY 4\.0\)/);
  assert.match(html, /<dd class="tt-warn">-35 mm\/ano/, 'déficit em alerta');
  assert.match(html, /<dd class="tt-info">18,5 °C/, 'indicador ativo destacado');
  assert.equal(climaTooltip(grade, 0), '', 'célula fora do PR');
  assert.match(text(climaTooltip(grade, 1)), /^📈 Clima histórico CHUVA/);
});

test('as três grades têm pick e tooltip', () => {
  for (const l of gradesClima) {
    assert.equal(l.interactive.length, 1, l.id);
    assert.equal(typeof l.tooltip, 'function', l.id);
    const pick = l.layers.find((x) => x.id === l.interactive[0]);
    assert.equal(pick.type, 'fill');
  }
});
