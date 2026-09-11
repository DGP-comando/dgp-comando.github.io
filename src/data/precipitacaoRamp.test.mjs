import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRECIP_CLASSES,
  PRECIP_FLOOR_MM,
  precipClassOf,
  precipLegend,
  precipRgba,
  tallyPrecip,
} from './precipitacaoRamp.js';
import { LAYER_STATE_REGISTRY, REGISTERED_LAYER_IDS, validateLayerStateRegistry } from './layerState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A camada de precipitação existe para ser lida SOBRE a de ventos, que desenha
 * partículas ciano. Essas duas coisas — a cor não colidir com o ciano e o
 * estado seco não pintar nada — são o contrato visual inteiro, e é o que esta
 * suíte trava.
 */

test('um estado seco não pinta nada, que é a leitura correta de "não choveu"', () => {
  for (const dry of [0, 0.0, 0.1, 0.19, PRECIP_FLOOR_MM - 0.001]) {
    assert.deepEqual(precipRgba(dry), [0, 0, 0, 0], `${dry} mm/h não é chuva mensurável`);
    assert.equal(precipClassOf(dry), null);
  }
  // Entrada suja da API não pode virar um véu roxo sobre o estado.
  for (const junk of [null, undefined, NaN, -3, 'chuva']) {
    assert.deepEqual(precipRgba(junk), [0, 0, 0, 0], `${String(junk)} tem que ser tratado como seco`);
    assert.equal(precipClassOf(junk), null);
  }
});

test('a escala sobe de forma monótona em opacidade, do chuvisco ao extremo', () => {
  const alphas = [0.2, 1, 4, 10, 25, 60].map((mm) => precipRgba(mm)[3]);
  for (let i = 1; i < alphas.length; i += 1) {
    assert.ok(alphas[i] >= alphas[i - 1],
      `opacidade não pode cair quando a chuva aumenta (${alphas[i - 1]} -> ${alphas[i]})`);
  }
  assert.ok(alphas[0] > 0, 'o piso da escala ainda tem que ser visível');
  assert.ok(alphas.at(-1) <= 255);
  // Acima da última classe a escala satura em vez de extrapolar para fora da faixa.
  assert.deepEqual(precipRgba(1000), precipRgba(25));
});

test('a escala nunca entra na família do ciano, que é a cor do vento', () => {
  // O vento desenha em #7dd3fc / #22d3ee / #a5f3fc / #e0f2fe. Uma escala de
  // chuva que chegasse perto disso tornaria as duas camadas ilegíveis juntas —
  // que é exatamente o caso de uso desta camada.
  for (const klass of PRECIP_CLASSES) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(klass.color.slice(i, i + 2), 16));
    assert.ok(r > g, `${klass.label} (${klass.color}) precisa ter mais vermelho que verde para fugir do ciano`);
    assert.ok(b > g, `${klass.label} (${klass.color}) precisa ter mais azul que verde`);
    // Ciano é justamente g e b altos com r baixo.
    assert.ok(!(g > 150 && b > 150 && r < g), `${klass.label} caiu na família ciano`);
  }
});

test('a escala para antes do violeta pálido, onde ela colapsaria sob daltonismo', () => {
  // Medido contra o ciano #22d3ee sob protanopia/deuteranopia: violetas claros
  // (#e9b8fb, #d8b4fe, #f0abfc) caem para ΔE ~3-4 e deixam de se distinguir dos
  // riscos de vento. O topo da escala é #e879f9 de propósito, e a magnitude
  // acima disso é carregada pelo alpha. Clarear o topo quebra a camada para
  // quem tem daltonismo — e colide com o roxo dos territórios quilombolas.
  const top = PRECIP_CLASSES.at(-1);
  assert.equal(top.color, '#e879f9', 'o teto da escala é um limite de acessibilidade, não uma preferência');
  assert.notEqual(top.color.toLowerCase(), '#c084fc', 'esse violeta já é o preenchimento dos territórios quilombolas');
  for (const klass of PRECIP_CLASSES) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(klass.color.slice(i, i + 2), 16));
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    assert.ok(max - min >= 60,
      `${klass.label} (${klass.color}) está pálido demais: saturação ${max - min}, mínimo 60`);
  }
});

test('as classes seguem a convenção horária WMO/INMET e estão em ordem', () => {
  assert.deepEqual(PRECIP_CLASSES.map((c) => c.mm), [0.2, 1, 4, 10, 25]);
  assert.equal(PRECIP_CLASSES[0].mm, PRECIP_FLOOR_MM, 'o piso da escala é a primeira classe');
  assert.deepEqual(
    PRECIP_CLASSES.map((c) => c.key),
    ['chuvisco', 'fraca', 'moderada', 'forte', 'extrema'],
  );
  assert.equal(precipClassOf(0.2), 'chuvisco');
  assert.equal(precipClassOf(0.9), 'chuvisco');
  assert.equal(precipClassOf(1), 'fraca');
  assert.equal(precipClassOf(9.9), 'moderada');
  assert.equal(precipClassOf(10), 'forte');
  assert.equal(precipClassOf(200), 'extrema');
});

test('a contagem por classe e a legenda só falam do que está na tela', () => {
  const grid = new Float32Array([0, 0, 0.5, 2, 12, 30, 0, 0.3]);
  const { counts, wet, maxMm } = tallyPrecip(grid);
  assert.equal(wet, 5);
  assert.equal(maxMm, 30);
  assert.deepEqual(counts, { chuvisco: 2, fraca: 1, forte: 1, extrema: 1 });

  const legend = precipLegend(counts);
  assert.deepEqual(legend.map((item) => item.label), ['CHUVISCO', 'FRACA', 'FORTE', 'MUITO FORTE']);
  assert.ok(!legend.some((item) => item.label === 'MODERADA'),
    'uma classe sem nenhuma célula não pode aparecer na legenda');
  for (const item of legend) {
    assert.match(item.color, /^#[0-9a-f]{6}$/i, 'o swatch recebe o hex OPACO, não o composto com alpha');
    assert.equal(typeof item.count, 'number');
    assert.ok(item.count > 0);
  }
  // _formatCount(undefined) renderiza a string "undefined" na linha do painel.
  assert.ok(legend.every((item) => item.count !== undefined));

  assert.deepEqual(tallyPrecip(new Float32Array(10)), { counts: {}, wet: 0, maxMm: 0 });
  assert.deepEqual(precipLegend({}), []);
  assert.deepEqual(tallyPrecip(undefined).counts, {});
});

test('a camada está registrada, com token próprio, e o registro continua válido', () => {
  assert.equal(validateLayerStateRegistry(), true);
  assert.ok(REGISTERED_LAYER_IDS.includes('datageo-precipitacao'));
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-precipitacao');
  assert.equal(entry.disposition, 'enabled-only');
  assert.equal(entry.token, 'C');
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'dois tokens iguais quebram o share link');
});

test('a camada de chuva fica abaixo das partículas de vento, e as duas dividem uma requisição', () => {
  // Estas duas invariantes são o "associada à camada de vento" do pedido, e
  // cada uma mora num arquivo diferente — então elas são fixadas juntas, ou
  // mexer numa sozinha inverte a leitura (chuva por cima do vento) ou dobra o
  // tráfego contra a Open-Meteo.
  const precip = fs.readFileSync(path.join(ROOT, 'src', 'data', 'datageoPrecipitacao.js'), 'utf8');
  const ventos = fs.readFileSync(path.join(ROOT, 'src', 'data', 'datageoVentos.js'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'src', 'data', 'datageoClient.js'), 'utf8');

  const fieldHeight = Number(/PRECIP_FIELD_HEIGHT_M = (\d+)/.exec(precip)?.[1]);
  const particleHeight = Number(/particleHeight: (\d+)/.exec(ventos)?.[1]);
  assert.ok(Number.isFinite(fieldHeight) && Number.isFinite(particleHeight));
  assert.ok(fieldHeight > 0, 'o plano precisa ficar acima da superfície do globo');
  assert.ok(fieldHeight < particleHeight,
    `a chuva (${fieldHeight} m) tem que ficar abaixo do vento (${particleHeight} m)`);

  // Uma requisição para as duas: a precipitação viaja na mesma lista `current=`.
  assert.match(client, /current=wind_speed_10m,wind_direction_10m,precipitation/);
  assert.match(client, /export function fetchWeatherGrid\(\)/);
  assert.match(client, /_weatherGridCache/, 'sem memoização as duas camadas dobrariam o tráfego');
  assert.match(precip, /fetchWeatherGrid/);

  // E o campo é estático: segurar o render governor como o vento faz queimaria
  // bateria à toa.
  assert.doesNotMatch(precip, /holdContinuousRender/,
    'um campo estático não pode prender o render governor em contínuo');
  assert.match(precip, /governorRequestRender/);
});
