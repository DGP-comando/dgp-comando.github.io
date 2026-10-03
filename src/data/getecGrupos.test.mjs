import test from 'node:test';
import assert from 'node:assert/strict';
import { grupos, redeFeatures, resumo } from './getecGrupos.js';

const cli = (nome, ibge, lon, lat) => ({ nome, ibge, municipio: 'Araucária', categoria: 'Agricultor Familiar', ativo: true, caf: lon == null ? null : '1', lon, lat });

const DADOS = {
  ano: 2026,
  extensionistas: {
    7274: {
      nome: 'Fulano',
      grupos: [
        { nome: 'Olericultores', projeto: 'Olericultura', clientes: [cli('A', '4101804', -49.4, -25.5), cli('B', '4101804', null, null)] },
        { nome: 'Leite', projeto: 'Pecuária de Leite', clientes: [cli('A', '4101804', -49.4, -25.5), cli('C', '4106902', -49.3, -25.4)] },
      ],
    },
  },
};

test('grupos pelo id do SisPont, numérico ou texto', () => {
  assert.equal(grupos(DADOS, 7274).nome, 'Fulano');
  assert.equal(grupos(DADOS, '7274').nome, 'Fulano');
  assert.equal(grupos(DADOS, 1), null);
  assert.equal(grupos(null, 7274), null);
});

test('resumo conta clientes únicos entre grupos e os que têm ponto', () => {
  assert.deepEqual(resumo(grupos(DADOS, 7274)), { grupos: 2, clientes: 3, comPonto: 2 });
  assert.deepEqual(resumo(null), { grupos: 0, clientes: 0, comPonto: 0 });
});

test('rede: uma linha e um ponto por família com coordenada, sem repetir', () => {
  const feats = redeFeatures(grupos(DADOS, 7274), [-49.0, -25.0]);
  assert.equal(feats.length, 4);
  const linhas = feats.filter((f) => f.geometry.type === 'LineString');
  assert.deepEqual(linhas[0].geometry.coordinates, [[-49.0, -25.0], [-49.4, -25.5]]);
  assert.equal(linhas[0].properties.projeto, 'Olericultura');
  assert.equal(linhas[1].properties.nome, 'C');
});
