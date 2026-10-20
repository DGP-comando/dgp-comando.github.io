import test from 'node:test';
import assert from 'node:assert/strict';
import { FalhaTransitoria, criarFila, emPedacos } from './acessoLog.js';

const relogio = (t = 0) => ({ agora: () => t, avanca: (ms) => { t += ms; } });

test('fila: dedup de evento+alvo em < 2 s, alvo cortado e lote cheio dispara envio', async () => {
  const enviados = [];
  const r = relogio();
  const f = criarFila({ enviar: async (l) => enviados.push(l), sessaoId: 's1', agora: r.agora, lote: 3 });

  assert.equal(f.registrar('camada_on', 'datageo-caf'), true);
  assert.equal(f.registrar('camada_on', 'datageo-caf'), false);
  assert.equal(f.registrar('camada_on', 'datageo-car'), true);
  r.avanca(2_000);
  assert.equal(f.registrar('camada_on', 'datageo-caf'), true); // 3º: lote cheio
  await Promise.resolve();
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0].map((e) => e.alvo), ['datageo-caf', 'datageo-car', 'datageo-caf']);
  assert.equal(enviados[0][0].sessao_id, 's1');
  assert.equal(f.pendentes(), 0);

  f.registrar('busca_pessoa', 'x'.repeat(400), { consulta: 'joão' });
  await f.descarregar();
  assert.equal(enviados[1][0].alvo.length, 300);
  assert.deepEqual(enviados[1][0].detalhe, { consulta: 'joão' });
});

async function semAviso(fn) {
  const aviso = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = aviso; }
}

test('fila: falha transitória devolve o lote; recusa definitiva descarta; nunca lança', async () => {
  let erro = new FalhaTransitoria('offline');
  let chamadas = 0;
  const f = criarFila({ enviar: async () => { chamadas++; if (erro) throw erro; }, sessaoId: 's', agora: () => 0 });
  assert.equal(await f.descarregar(), 0);
  assert.equal(chamadas, 0); // fila vazia não envia
  f.registrar('busca_pessoa', '1');
  assert.equal(await semAviso(() => f.descarregar()), 0);
  assert.equal(f.pendentes(), 1); // volta para a fila
  erro = new Error('HTTP 400');
  assert.equal(await semAviso(() => f.descarregar()), 0);
  assert.equal(f.pendentes(), 0); // descartado
  erro = null;
  f.registrar('logout');
  assert.equal(await f.descarregar(), 1);
});

test('emPedacos: corpos keepalive abaixo do limite, sem perder linha', () => {
  const linhas = Array.from({ length: 60 }, (_, i) => ({ evento: 'x', detalhe: { t: 'ç'.repeat(1000), i } }));
  const pedacos = emPedacos(linhas, 10_000);
  assert.ok(pedacos.length > 1);
  assert.ok(pedacos.every((p) => JSON.stringify(p).length <= 10_000));
  assert.deepEqual(pedacos.flat(), linhas);
  assert.deepEqual(emPedacos([]), []);
});
