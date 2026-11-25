import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMADAS_PRIVADAS, definirExterno, ehExterno } from './acessoExterno.js';
import { dgFetchData, dgJsonPrivadoOuPublico } from './datageoClient.js';
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

test('dgJsonPrivadoOuPublico: interno lê o privado; externo, sem sessão ou falha cai no público', async () => {
  const real = globalThis.fetch;
  let chamadas = [];
  let privadoResp = () => new Response('{"v":"priv"}');
  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    return String(url).includes('datageo-privado') ? privadoResp() : new Response('{"v":"pub"}');
  };
  const ler = (sessao) => dgJsonPrivadoOuPublico('/privado/a.geojson', '/data/a.geojson', { sessao: async () => sessao });
  try {
    assert.deepEqual(await ler(true), { data: { v: 'priv' }, privado: true });

    chamadas = [];
    assert.deepEqual(await ler(false), { data: { v: 'pub' }, privado: false });
    assert.deepEqual(chamadas, ['/data/a.geojson']); // sem sessão: nem tenta o bucket

    chamadas = [];
    definirExterno(true);
    assert.deepEqual(await ler(true), { data: { v: 'pub' }, privado: false });
    assert.deepEqual(chamadas, ['/data/a.geojson']);
    definirExterno(false);

    for (const falha of [() => new Response(null, { status: 400 }), () => new Response('não é json'), () => { throw new Error('rede'); }]) {
      privadoResp = falha;
      assert.deepEqual(await ler(true), { data: { v: 'pub' }, privado: false });
    }
  } finally {
    definirExterno(false);
    globalThis.fetch = real;
  }
});
