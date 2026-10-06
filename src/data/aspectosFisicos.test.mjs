import assert from 'node:assert/strict';
import test from 'node:test';
import { rotuloFaixa, resumirAspectos } from './aspectosFisicos.js';

const dados = {
  fonte: { altitude: 'MDE' },
  municipios: {
    1: {
      areaHa: 100, drenKm: 10, nascentes: 5,
      alt: { min: 300, med: 500, max: 900, faixas: [0, 40, 60, 0, 0, 0, 0] },
      decl: { '0 a 10': 70, '20 a 45': 30 },
      uso: { 'Agricultura Anual': 60, 'Floresta Nativa': 40 },
    },
    2: {
      areaHa: 300, drenKm: 20.5, nascentes: 7,
      alt: { min: 100, med: 300, max: 600, faixas: [100, 200, 0, 0, 0, 0, 0] },
      decl: { '0 a 10': 300 },
      uso: { 'Floresta Nativa': 250, 'Classe desconhecida': 50 },
    },
  },
};

test('regional: soma áreas, junta extremos e pondera a altitude média pela área', () => {
  const r = resumirAspectos(dados, ['1', 2]);
  assert.equal(r.n, 2);
  assert.equal(r.areaHa, 400);
  assert.deepEqual([r.alt.min, r.alt.max, r.alt.med], [100, 900, 350]);
  assert.deepEqual(r.alt.faixas.map((l) => [l.label, l.n]), [['até 200 m', 100], ['200-400 m', 240], ['400-600 m', 60]]);
  assert.equal(r.drenKm, 30.5);
  assert.equal(r.nascentes, 12);
  assert.deepEqual(r.decl.map((l) => [l.key, l.n]), [['0 a 10', 370], ['20 a 45', 30]]);
});

test('uso do solo ordenado por área; classe fora da legenda fica de fora', () => {
  const r = resumirAspectos(dados, ['2', '1']);
  assert.deepEqual(r.uso.map((l) => [l.label, l.n]), [['Floresta Nativa', 290], ['Agricultura Anual', 60]]);
});

test('rótulos das faixas nas pontas', () => {
  assert.equal(rotuloFaixa(0), 'até 200 m');
  assert.equal(rotuloFaixa(6), 'acima de 1200 m');
});

test('sem município conhecido devolve null', () => {
  assert.equal(resumirAspectos(dados, ['999']), null);
  assert.equal(resumirAspectos(null, ['1']), null);
});
