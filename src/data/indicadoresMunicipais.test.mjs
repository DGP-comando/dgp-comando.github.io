import assert from 'node:assert/strict';
import test from 'node:test';
import { somarIndicadores } from './indicadoresMunicipais.js';

const dados = {
  associacoes: { AMOP: 'Oeste', CANTU: 'Cantuquiriguaçu' },
  municipios: {
    1: { agro_total: 10, agro_idr: 4, km_total: 100, km_rural: 80, km_conv: 2.5, associacoes: ['AMOP', 'CANTU'], regional: 'Cascavel' },
    2: { agro_total: 5, agro_idr: 5, km_total: 50, km_rural: 20, km_conv: 0, associacoes: ['AMOP'], regional: 'Cascavel' },
  },
};

test('soma os municípios e junta associações sem repetir', () => {
  const r = somarIndicadores(dados, ['1', 2]);
  assert.equal(r.n, 2);
  assert.equal(r.agro_total, 15);
  assert.equal(r.agro_idr, 9);
  assert.equal(r.km_rural, 100);
  assert.equal(r.km_conv, 2.5);
  assert.deepEqual(r.associacoes.map((a) => a.sigla), ['AMOP', 'CANTU']);
  assert.equal(r.associacoes[1].nome, 'Cantuquiriguaçu');
  assert.deepEqual(r.regionais, ['Cascavel']);
});

test('município com dupla filiação lista as duas', () => {
  assert.deepEqual(somarIndicadores(dados, ['1']).associacoes.map((a) => a.sigla), ['AMOP', 'CANTU']);
});

test('sem município conhecido devolve null', () => {
  assert.equal(somarIndicadores(dados, ['999']), null);
  assert.equal(somarIndicadores(null, ['1']), null);
});
