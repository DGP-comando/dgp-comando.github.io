import assert from 'node:assert/strict';
import test from 'node:test';
import { resumirOttobacias } from './ottobacias.js';

const dados = {
  fonte: 'IDR',
  municipios: {
    1: { n: 10, mananciais: [{ nome: 'Pitangui', classe: 'sanepar', ottobacias: 2 }] },
    2: { n: 5, mananciais: [{ nome: 'Pitangui', classe: 'sanepar', ottobacias: 1 }, { nome: 'Alegre', classe: 'idr', ottobacias: 1 }] },
  },
};

test('município: contagem e mananciais', () => {
  const r = resumirOttobacias(dados, ['1']);
  assert.equal(r.n, 10);
  assert.deepEqual(r.mananciais.map((m) => m.nome), ['Pitangui']);
});

test('regional: sem contagem somada (divisa contaria duas vezes) e mananciais sem repetir', () => {
  const r = resumirOttobacias(dados, ['1', 2]);
  assert.equal(r.n, null);
  assert.deepEqual(r.mananciais.map((m) => [m.nome, m.ottobacias]), [['Alegre', 1], ['Pitangui', 3]]);
  assert.equal(resumirOttobacias(dados, ['9']), null);
});
