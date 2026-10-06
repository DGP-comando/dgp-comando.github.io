import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMunicipioQuery } from './municipioSearch.js';

const { buscarPessoas } = await import('./pessoaSearch.js');

const itens = ['JOÃO DA SILVA', 'MARIA JOANA SILVEIRA', 'SILVA JOÃOZINHO', 'ANTÔNIO CONCEIÇÃO']
  .map((nome) => ({ nome, chave: normalizeMunicipioQuery(nome) }));
const nomes = (q) => buscarPessoas(itens, q).map((i) => i.nome);

test('termos em qualquer ordem, sem acento, início de palavra', () => {
  assert.deepEqual(nomes('silva joao'), ['SILVA JOÃOZINHO', 'JOÃO DA SILVA']);
  assert.deepEqual(nomes('conceicao'), ['ANTÔNIO CONCEIÇÃO']);
  assert.deepEqual(nomes('ilva'), []);
});

test('quem começa pela consulta vem primeiro; consulta curta não lista', () => {
  assert.deepEqual(nomes('joa'), ['JOÃO DA SILVA', 'SILVA JOÃOZINHO', 'MARIA JOANA SILVEIRA']);
  assert.deepEqual(nomes('jo'), []);
});
