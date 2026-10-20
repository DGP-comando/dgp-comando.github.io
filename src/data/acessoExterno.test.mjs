import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMADAS_PRIVADAS, definirExterno, ehExterno } from './acessoExterno.js';
import { dgFetchData } from './datageoClient.js';
import { LAYERS } from '../maplibre/layers/index.js';

test('toda camada privada da lista existe no registro de camadas', () => {
  const ids = new Set(LAYERS.map((l) => l.id));
  assert.deepEqual([...CAMADAS_PRIVADAS].filter((id) => !ids.has(id)), []);
});

test('ehExterno só com a flag booleana do app_metadata', () => {
  assert.equal(ehExterno({ app_metadata: { datageo: true, datageo_externo: true } }), true);
  assert.equal(ehExterno({ app_metadata: { datageo: true, datageo_externo: 'true' } }), false);
  assert.equal(ehExterno({ user_metadata: { datageo_externo: true } }), false); // editável pelo usuário
  assert.equal(ehExterno(null), false);
});

test('externo: /privado/ vira 403 sem requisição; arquivo aberto segue normal', async () => {
  const chamadas = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { chamadas.push(String(url)); return new Response('{}'); };
  try {
    definirExterno(true);
    const r = await dgFetchData('/privado/caf-pontos.json');
    assert.equal(r.status, 403);
    assert.equal(chamadas.length, 0);
    await dgFetchData('/data/municipios.json');
    assert.deepEqual(chamadas, ['/data/municipios.json']);
  } finally {
    definirExterno(false);
    globalThis.fetch = real;
  }
});
