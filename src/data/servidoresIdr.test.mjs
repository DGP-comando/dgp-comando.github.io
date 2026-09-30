import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionistasDoMunicipio, normNome, servidoresDasUnidades } from './servidoresIdr.js';

// Nomes inventados.
const DADOS = {
  gerado_em: '2026-09-28T15:00:00Z',
  servidores: [
    { nome: 'CARLA B', municipio: 'Paranavaí', formacao: 'Engenharia Agronômica', extensionista: true, unidade: null },
    { nome: 'ANA A', municipio: 'PARANAVAI', formacao: 'Engenharia Agronômica', extensionista: true, unidade: null },
    { nome: 'BRUNO', municipio: 'Paranavaí', formacao: 'Zootecnia', extensionista: true, unidade: null },
    { nome: 'DIEGO', municipio: 'Paranavaí', formacao: '', extensionista: true, unidade: null },
    { nome: 'EVA', municipio: 'Paranavaí', formacao: 'Assist. Administrativo', extensionista: false, unidade: null },
    { nome: 'FABIO', municipio: 'Londrina', formacao: 'Pesquisador', extensionista: false, unidade: 'londrina-ibipora' },
    { nome: 'GIL', municipio: 'Ponta Grossa', formacao: 'Pesquisador', extensionista: false, unidade: 'uf-ponta-grossa' },
    { nome: 'HELIO', municipio: 'Ponta Grossa', formacao: 'Pesquisador', extensionista: false, unidade: 'polo-ponta-grossa' },
  ],
};

test('normNome casa grafias com e sem acento', () => {
  assert.equal(normNome(' Paranavaí '), normNome('PARANAVAI'));
});

test('extensionistas do município: só extensionistas, agrupados por formação', () => {
  const r = extensionistasDoMunicipio(DADOS, 'paranavai');
  assert.equal(r.total, 4);
  assert.deepEqual(r.grupos.map((g) => g.formacao), ['Engenharia Agronômica', 'Zootecnia', '']);
  assert.deepEqual(r.grupos[0].servidores.map((s) => s.nome), ['ANA A', 'CARLA B']);
  assert.equal(r.geradoEm, DADOS.gerado_em);
  assert.equal(r.rh, null);
  assert.equal(extensionistasDoMunicipio({ ...DADOS, fontes: { rh: 'RH, Setembro/2026' } }, 'paranavai').rh, 'RH, Setembro/2026');
  assert.equal(extensionistasDoMunicipio(DADOS, 'Curitiba'), null);
  assert.equal(extensionistasDoMunicipio(null, 'Curitiba'), null);
});

test('servidores das unidades: chave simples e ponto compartilhado', () => {
  assert.deepEqual(servidoresDasUnidades(DADOS, 'londrina-ibipora').map((s) => s.nome), ['FABIO']);
  assert.deepEqual(servidoresDasUnidades(DADOS, 'polo-ponta-grossa,uf-ponta-grossa').map((s) => s.nome), ['GIL', 'HELIO']);
  assert.deepEqual(servidoresDasUnidades(DADOS, ''), []);
});
