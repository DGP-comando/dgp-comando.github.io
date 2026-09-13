import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAYER_STATE_REGISTRY, REGISTERED_LAYER_IDS, validateLayerStateRegistry } from './layerState.js';
import {
  CAMPO_ALPHA,
  INDICADORES,
  corDe,
  indicador,
  legendaDe,
} from './climaHistoricoRamp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arquivo = (nome) => path.join(ROOT, 'public', 'data', nome);
const ler = (nome) => JSON.parse(fs.readFileSync(arquivo(nome), 'utf8'));
// Os JSONs saem de scripts/build_clima_brdwgd.py (Earth Engine). Enquanto nao
// foram gerados, as travas de contrato ficam puladas, nao verdes por engano.
const semDados = !fs.existsSync(arquivo('clima-historico-pr.json'))
  && 'rode scripts/build_clima_brdwgd.py para gerar os JSONs';

test('a camada esta registrada com token proprio e o registro segue valido', () => {
  assert.equal(validateLayerStateRegistry(), true);
  assert.ok(REGISTERED_LAYER_IDS.includes('datageo-clima-historico'));
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-clima-historico');
  assert.equal(entry.token, 'E');
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'token repetido quebra o share link');
});

test('as escalas nao invadem ciano, violeta nem verde de outras camadas', () => {
  for (const ind of INDICADORES) {
    for (const hex of ind.rampa) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      assert.ok(!(b > 150 && g > 140 && r < g - 40), `${hex} caiu na familia ciano`);
      assert.ok(!(r > 120 && b > 140 && g < r - 30), `${hex} caiu na familia violeta`);
      assert.ok(!(g > r + 30 && g > b + 30), `${hex} caiu na familia verde da conectividade`);
    }
  }
});

test('sequencial classifica pelas quebras e celula sem dado e transparente', () => {
  const ind = indicador('pr');
  const quebras = [1300, 1500, 1700, 1900];
  assert.deepEqual(corDe(null, ind, quebras), [0, 0, 0, 0]);
  const cor = (v) => corDe(v, ind, quebras).slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join('');
  assert.equal(`#${cor(1200)}`, ind.rampa[0]);
  assert.equal(`#${cor(1500)}`, ind.rampa[2]);
  assert.equal(`#${cor(2500)}`, ind.rampa[4]);
  assert.equal(corDe(1600, ind, quebras)[3], Math.round(255 * CAMPO_ALPHA));
});

test('divergente separa deficit de excedente pelo sinal, com zero neutro', () => {
  const ind = indicador('balanco');
  // Limiares relativos ao maior modulo (900): neutro < 90, extremo > 450.
  const valores = [-800, -100, 5, 150, 900];
  const legenda = legendaDe(valores, ind, []);
  assert.deepEqual(legenda.map((l) => l.label), ['DÉFICIT ALTO', 'DÉFICIT', '≈ 0', 'EXCEDENTE', 'EXCEDENTE ALTO']);
  assert.ok(legenda.every((l) => l.count === 1));
});

test('legenda omite classes vazias', () => {
  const ind = indicador('geada3');
  const legenda = legendaDe([0, 0, 1, null], ind, [2, 5, 10, 20]);
  assert.equal(legenda.length, 1);
  assert.equal(legenda[0].count, 3);
});

test('JSON municipal cobre os 399 municipios com climatologia plausivel', { skip: semDados }, () => {
  const d = ler('clima-historico-pr.json');
  assert.equal(d.doi, '10.1002/joc.7731');
  assert.deepEqual(d.normal, [1990, 2019]);
  const codigos = Object.keys(d.municipios);
  assert.equal(codigos.length, 399);
  for (const [ibge, m] of Object.entries(d.municipios)) {
    assert.match(ibge, /^41\d{5}$/);
    assert.ok(m.pr > 1000 && m.pr < 2600, `${ibge}: chuva ${m.pr}`);
    assert.ok(m.tmed > 13 && m.tmed < 24.5, `${ibge}: tmed ${m.tmed}`);
    assert.ok(m.geada3 >= 0 && m.geada3 < 80, `${ibge}: geada ${m.geada3}`);
    assert.equal(m.normal.pr.length, 12);
    const somaMensal = m.normal.pr.reduce((a, b) => a + b, 0);
    // A soma das normais mensais tem que fechar com a normal anual.
    assert.ok(Math.abs(somaMensal - m.pr) / m.pr < 0.03, `${ibge}: mensal ${somaMensal} x anual ${m.pr}`);
  }
});

test('grade e retangular, dentro do PR e com quebras por indicador', { skip: semDados }, () => {
  const g = ler('clima-historico-grade-pr.json');
  assert.ok(g.bounds.west >= -55 && g.bounds.east <= -47.5);
  assert.ok(g.bounds.south >= -27.2 && g.bounds.north <= -22.2);
  for (const ind of INDICADORES) {
    const campo = g.campos[ind.key];
    assert.equal(campo.length, g.width * g.height, `${ind.key}: tamanho`);
    const validos = campo.filter((v) => v !== null).length;
    // PR ocupa ~70% do retangulo envolvente; muito menos que isso = mascara quebrada.
    assert.ok(validos > 0.4 * campo.length, `${ind.key}: so ${validos} celulas`);
    assert.ok(Array.isArray(g.classes[ind.key]));
  }
});

test('series anuais alinham com os anos declarados', { skip: semDados }, () => {
  const s = ler('clima-historico-series-pr.json');
  const [a0, a1] = s.anos.tmed;
  for (const serie of Object.values(s.municipios)) {
    assert.equal(serie.tmed.length, a1 - a0 + 1);
    assert.equal(serie.pr.length, s.anos.pr[1] - s.anos.pr[0] + 1);
  }
});
