import test from 'node:test';
import assert from 'node:assert/strict';
import { gerenteDaRegional } from './gerentesIdr.js';

// Nomes inventados.
const DADOS = { referencia: 'Setembro/2026', regionais: { 'União da Vitória': { nome: 'BELTRANA', cargo: 'CHEFE' } } };

test('gerenteDaRegional casa com e sem acento e traz a referência', () => {
  assert.deepEqual(gerenteDaRegional(DADOS, 'UNIAO DA VITORIA'), { nome: 'BELTRANA', cargo: 'CHEFE', referencia: 'Setembro/2026' });
  assert.equal(gerenteDaRegional(DADOS, 'Irati'), null);
  assert.equal(gerenteDaRegional(DADOS, ''), null);
  assert.equal(gerenteDaRegional(null, 'Irati'), null);
});
