import assert from 'node:assert/strict';
import test from 'node:test';
import { classeDe, umidadeFeatures, umidadeTooltip } from './umidadeSolo.js';

// Grade 3x2 (linha 0 = sul); célula 2 fora do PR.
const d = {
  data: '2026-10-05', fonte: 'NASA SMAP L4', width: 3, height: 2,
  bounds: { west: -50, east: -49.82, south: -25, north: -24.91 },
  sup: [30, 20, null, 25, 40, 35], raiz: [32.5, 18, null, 28, 45, 30], perfil: [33, 19, null, 29, 44, 31],
  pctl: [55, 5, null, 25, 95, 75], anom: [1.2, -4.5, null, 0, 8.1, 3], molh: [70, 40, null, 60, 98, 80],
};

test('classes do percentil nas bordas', () => {
  assert.deepEqual([0, 9.9, 10, 29, 30, 69, 70, 89, 90, 100].map(classeDe), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('features: só células do PR, classe e contagem', () => {
  const { features, counts } = umidadeFeatures(d);
  assert.deepEqual(features.map((f) => [f.id, f.properties.c]), [[0, 2], [1, 0], [3, 1], [4, 4], [5, 3]]);
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
});

test('tooltip: todas as variáveis, data e sinal da anomalia', () => {
  const html = umidadeTooltip(1, d);
  for (const s of ['05/10/2026', 'Muito seco', '18,0%', '5 (de 0', '40,0%', '20,0%', '-4,5 p.p.', '19,0%', 'NASA SMAP L4']) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(umidadeTooltip(4, d).includes('+8,1 p.p.'));
  assert.equal(umidadeTooltip(2, d), '');
});
