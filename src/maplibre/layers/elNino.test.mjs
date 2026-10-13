import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VARIAVEIS, alinhados, classeDe, elNinoFeatures, elNinoTooltip, faseEnso, leituraAgro, rotuloMes, textoConfianca,
} from './elNino.js';

// Grade 2x2 com 3 células no PR (k = 0, 1, 3); 2 meses de previsão (out, nov).
const hist = {
  bounds: { west: -50, east: -49.9, south: -25.1, north: -25 },
  width: 2, height: 2, passoGraus: 0.1,
  meses: [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6],
  celulas: [0, 1, 3],
  rCritico: 0.29,
  fortes: [1982, 1997, 2015, 2023],
  gerado: '2026-10-13',
  escala: { incl: 10, r: 100, rT: 100, h50Normal: 100, h50Forte: 100, tNormal: 10, tForte: 100 },
  campos: Object.fromEntries(['normal', 'forteMed', 'forteP25', 'forteP75', 'forteAcima', 'r', 'incl', 'h50Normal', 'h50Forte', 'tForte']
    .map((c) => [c, Array.from({ length: 12 }, () => [0, 0, 0])])),
};
hist.campos.normal[3] = [150, 160, 170];
hist.campos.normal[4] = [140, 150, 160];
hist.campos.forteMed[4] = [40, -12, 5];
hist.campos.forteP25[4] = [10, -30, -5];
hist.campos.forteP75[4] = [80, 5, 20];
hist.campos.forteAcima[4] = [75, 25, 50];
hist.campos.r[4] = [61, 10, 35];
hist.campos.incl[4] = [200, 20, 100];
hist.campos.h50Normal[4] = [30, 20, 10];
hist.campos.h50Forte[4] = [120, 20, 40];
hist.campos.tForte[4] = [40, 40, null];

const prev = {
  meses: ['2026-10', '2026-11'],
  gerado: '2026-10-13T12:00Z',
  historico: { gerado: '2026-10-13', nCelulas: 3 },
  escala: { tAnom: 10 },
  enso: { oni: [{ tri: 'JAS', ano: 2026, valor: 2.16 }], roni: [{ tri: 'JAS', ano: 2026, valor: 1.69 }] },
  campos: {
    anom: [[71, 5, -30], [56, 8, -12]],
    esperado: [[257, 168, 119], [218, 162, 141]],
    p10: [[null, null, null], [114, 100, 90]],
    p50: [[null, null, null], [185, 160, 140]],
    p90: [[null, null, null], [277, 220, 190]],
    pAcima: [[null, null, null], [80, 30, 20]],
    pAbaixo: [[null, null, null], [5, 30, 50]],
    tAnom: [[11, 11, 11], [13, 12, null]],
    nmmeAcima: [[58, 40, 30], [56, 40, 30]],
    nmmeAbaixo: [[12, 30, 40], [16, 30, 45]],
    nmmeTAcima: [[70, 70, 70], [65, 60, null]],
    conf: [[3, 0, 2], [3, 0, 1]],
  },
};

test('classes: limites e sem dado', () => {
  const chuva = VARIAVEIS[0].classes;
  assert.equal(classeDe(chuva, -30), 0);
  assert.equal(classeDe(chuva, 0), 2);
  assert.equal(classeDe(chuva, 10), 3);
  assert.equal(classeDe(chuva, 80), 5);
  assert.equal(classeDe(chuva, 200), 6);
  assert.equal(classeDe(chuva, null), -1);
});

test('features: só células do PR, classe e véu de baixa confiança', () => {
  const { features, counts } = elNinoFeatures(prev, hist, { variavel: 'chuva', mes: 1 });
  assert.deepEqual(features.map((f) => [f.id, f.properties.n, f.properties.c, f.properties.v]), [[0, 0, 5, 0], [1, 1, 2, 1], [3, 2, 1, 1]]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 3);
});

test('features: excesso some no mês corrente (sem membros)', () => {
  assert.equal(elNinoFeatures(prev, hist, { variavel: 'excesso', mes: 0 }).features.length, 0);
  assert.equal(elNinoFeatures(prev, hist, { variavel: 'excesso', mes: 1 }).features.length, 3);
});

test('features: sinal histórico com véu onde r não é significativo', () => {
  const { features } = elNinoFeatures(prev, hist, { variavel: 'sinal', mes: 1 });
  assert.deepEqual(features.map((f) => f.properties.v), [0, 1, 0]);
});

test('fase do ENSO pelo ONI', () => {
  assert.equal(faseEnso(2.16).text, 'EL NIÑO MUITO FORTE');
  assert.equal(faseEnso(1.2).text, 'EL NIÑO MODERADO');
  assert.equal(faseEnso(0).text, 'NEUTRO');
  assert.equal(faseEnso(-0.7).text, 'LA NIÑA');
  assert.equal(faseEnso(null), null);
});

test('leitura agronômica por mês', () => {
  assert.match(leituraAgro(11, { anom: 56 })[0], /trigo/);
  assert.match(leituraAgro(1, { anom: 40 })[0], /ferrugem/);
  assert.match(leituraAgro(1, { anom: -20 })[0], /veranico/);
  assert.match(leituraAgro(4, { pAcima: 70 })[0], /safrinha/);
  assert.ok(leituraAgro(11, { anom: 5, tAnom: 1.3 }).some((t) => /Calor/.test(t)));
  assert.match(leituraAgro(11, { anom: 3 })[0], /ZARC/);
});

test('rótulos', () => {
  assert.equal(rotuloMes('2026-11'), 'NOV/26');
  assert.equal(textoConfianca(3), 'SEAS5, NMME e o histórico concordam');
});

test('tooltip: previsão, faixa, histórico e regressão', () => {
  const html = elNinoTooltip(prev, hist, 0, 1, { cur: { municipio: 'Curitiba' }, k: 0 });
  for (const s of ['Curitiba', 'novembro de 2026', 'EL NIÑO MUITO FORTE', '218 mm (+56% da normal)', '114 a 277 mm',
    '80% de chance', '56% / 16%', '+1,3 °C', '3/3', 'trigo', '+40%', '75% de 4 El Niños', '(significativa)',
    '+43% de chuva', '0,3 no normal · 1,2 nos El Niños', 'OUT/26', 'NOV/26', '+2,16 em JAS/2026', '+1,69']) {
    assert.ok(html.includes(s), s);
  }
});

test('tooltip: mês corrente sem faixa; r fraco sem regressão', () => {
  const html = elNinoTooltip(prev, hist, 1, 0, { k: 1 });
  assert.ok(html.includes('Perspectiva El Niño'));
  assert.ok(!html.includes('Faixa provável'));
  const nov = elNinoTooltip(prev, hist, 1, 1, { k: 1 });
  assert.ok(nov.includes('(fraca, não significativa)'));
  assert.ok(!nov.includes('Pela regressão'));
});

test('previsão e histórico precisam ser da mesma geração', () => {
  assert.equal(alinhados(prev, hist), true);
  assert.throws(() => alinhados({ ...prev, historico: { gerado: '2025-09-13', nCelulas: 3 } }, hist), /sincronia/);
  assert.throws(() => alinhados({ ...prev, historico: undefined }, hist), /sincronia/);
});

test('temperatura sem véu', () => {
  assert.deepEqual(elNinoFeatures(prev, hist, { variavel: 'temp', mes: 1 }).features.map((f) => f.properties.v), [0, 0]);
});
