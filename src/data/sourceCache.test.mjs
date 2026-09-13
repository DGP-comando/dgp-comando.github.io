import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cachedSource,
  clearSources,
  createSourceCache,
  DEFAULT_FAILURE_RETRY_MS,
  invalidateSource,
  peekSource,
} from './sourceCache.js';
import { dgSelect } from './datageoClient.js';

function makeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('valor fresco dentro do TTL nao chama o fetcher de novo', async () => {
  const cache = createSourceCache();
  const now = makeClock();
  let calls = 0;
  const fetcher = async () => { calls += 1; return `v${calls}`; };

  assert.equal(await cache.cachedSource('a', fetcher, { ttlMs: 1000, now }), 'v1');
  now.advance(999);
  assert.equal(await cache.cachedSource('a', fetcher, { ttlMs: 1000, now }), 'v1');
  assert.equal(calls, 1);

  now.advance(1);
  assert.equal(await cache.cachedSource('a', fetcher, { ttlMs: 1000, now }), 'v2');
  assert.equal(calls, 2);
});

test('TTL e contado a partir da conclusao do fetch, nao do inicio', async () => {
  const cache = createSourceCache();
  const now = makeClock();
  const gate = deferred();
  let calls = 0;
  const fetcher = () => { calls += 1; return gate.promise; };

  const p = cache.cachedSource('slow', fetcher, { ttlMs: 1000, now });
  now.advance(5000);
  gate.resolve('x');
  assert.equal(await p, 'x');
  now.advance(999);
  assert.equal(await cache.cachedSource('slow', fetcher, { ttlMs: 1000, now }), 'x');
  assert.equal(calls, 1);
});

test('chamadas concorrentes compartilham o mesmo voo', async () => {
  const cache = createSourceCache();
  const gate = deferred();
  let calls = 0;
  const fetcher = () => { calls += 1; return gate.promise; };

  const p1 = cache.cachedSource('k', fetcher, { ttlMs: 60_000 });
  const p2 = cache.cachedSource('k', fetcher, { ttlMs: 60_000 });
  const p3 = cache.cachedSource('k', fetcher, { ttlMs: 0 });
  assert.equal(p1, p2, 'mesma promessa para chamadores concorrentes');
  assert.equal(p1, p3, 'ttl 0 tambem deduplica voo aberto');
  gate.resolve([1, 2, 3]);
  assert.deepEqual(await p1, [1, 2, 3]);
  assert.equal(calls, 1);
});

test('ttl 0 so deduplica: apos o voo, a proxima chamada busca de novo', async () => {
  const cache = createSourceCache();
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls; };
  assert.equal(await cache.cachedSource('z', fetcher), 1);
  assert.equal(await cache.cachedSource('z', fetcher), 2);
});

test('falha sem valor anterior rejeita e nao e cacheada', async () => {
  const cache = createSourceCache();
  const now = makeClock();
  let fail = true;
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (fail) throw new Error('boom');
    return 'ok';
  };

  await assert.rejects(cache.cachedSource('f', fetcher, { ttlMs: 10_000, now }), /boom/);
  assert.equal(cache.peekSource('f'), undefined);
  assert.equal(cache.size(), 0, 'falha sem stale nao ocupa chave');

  fail = false;
  assert.equal(await cache.cachedSource('f', fetcher, { ttlMs: 10_000, now }), 'ok');
  assert.equal(calls, 2, 'tenta de novo imediatamente, sem janela de retry');
});

test('fetcher que lanca sincronamente vira rejeicao', async () => {
  const cache = createSourceCache();
  await assert.rejects(
    cache.cachedSource('sync', () => { throw new Error('sync boom'); }),
    /sync boom/,
  );
  assert.equal(cache.size(), 0);
});

test('stale-on-error: refetch falho resolve com o valor velho e segura retry por 60 s', async () => {
  const cache = createSourceCache();
  const now = makeClock();
  let fail = false;
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (fail) throw new Error('down');
    return `v${calls}`;
  };
  const opts = { ttlMs: 1000, now };

  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v1');
  now.advance(1000);
  fail = true;
  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v1', 'stale em vez de rejeitar');
  assert.equal(calls, 2);

  // Dentro da janela de retry: nenhuma chamada nova ao fetcher.
  now.advance(DEFAULT_FAILURE_RETRY_MS - 1);
  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v1');
  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v1');
  assert.equal(calls, 2, 'nao martela a fonte durante a janela de retry');

  // Janela vencida: tenta de novo (e falha de novo, stale outra vez).
  now.advance(1);
  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v1');
  assert.equal(calls, 3);

  // Fonte volta: apos nova janela, valor fresco substitui o stale.
  fail = false;
  now.advance(DEFAULT_FAILURE_RETRY_MS);
  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v4');
  assert.equal(calls, 4);
  now.advance(500);
  assert.equal(await cache.cachedSource('s', fetcher, opts), 'v4', 'sucesso zera o retryAt e reinicia o TTL');
  assert.equal(calls, 4);
});

test('staleOnError=false rejeita o refetch falho, mantem o valor para peek e tenta de novo na proxima chamada', async () => {
  const cache = createSourceCache();
  const now = makeClock();
  let fail = false;
  let calls = 0;
  const fetcher = async () => { calls += 1; if (fail) throw new Error('fora'); return `v${calls}`; };
  const opts = { ttlMs: 1000, now, staleOnError: false };

  assert.equal(await cache.cachedSource('n', fetcher, opts), 'v1');
  now.advance(1000);
  fail = true;
  await assert.rejects(cache.cachedSource('n', fetcher, opts), /fora/);
  assert.equal(cache.peekSource('n'), 'v1');
  await assert.rejects(cache.cachedSource('n', fetcher, opts), /fora/);
  assert.equal(calls, 3, 'sem janela de retry: cada chamada tenta');
  fail = false;
  assert.equal(await cache.cachedSource('n', fetcher, opts), 'v4');
});

test('retryMs e configuravel na fabrica', async () => {
  const now = makeClock();
  const cache = createSourceCache({ retryMs: 10, now });
  let fail = false;
  let calls = 0;
  const fetcher = async () => { calls += 1; if (fail) throw new Error('x'); return calls; };
  assert.equal(await cache.cachedSource('r', fetcher, { ttlMs: 5 }), 1);
  fail = true;
  now.advance(5);
  assert.equal(await cache.cachedSource('r', fetcher, { ttlMs: 5 }), 1);
  now.advance(9);
  assert.equal(await cache.cachedSource('r', fetcher, { ttlMs: 5 }), 1);
  assert.equal(calls, 2);
  now.advance(1);
  assert.equal(await cache.cachedSource('r', fetcher, { ttlMs: 5 }), 1);
  assert.equal(calls, 3);
});

test('limite de chaves despeja a mais antiga', async () => {
  const cache = createSourceCache({ maxKeys: 3 });
  const fetcherFor = (v) => async () => v;
  for (const k of ['a', 'b', 'c', 'd']) {
    await cache.cachedSource(k, fetcherFor(k), { ttlMs: 60_000 });
  }
  assert.equal(cache.size(), 3);
  assert.equal(cache.peekSource('a'), undefined, 'a mais antiga saiu');
  assert.equal(cache.peekSource('d'), 'd');
});

test('limite default e 200 chaves', async () => {
  const cache = createSourceCache();
  for (let i = 0; i < 205; i++) {
    await cache.cachedSource(`k${i}`, async () => i, { ttlMs: 60_000 });
  }
  assert.equal(cache.size(), 200);
  assert.equal(cache.peekSource('k4'), undefined);
  assert.equal(cache.peekSource('k5'), 5);
});

test('invalidateSource forca refetch e um voo invalidado nao grava no cache', async () => {
  const cache = createSourceCache();
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls; };
  assert.equal(await cache.cachedSource('i', fetcher, { ttlMs: 60_000 }), 1);
  assert.equal(cache.invalidateSource('i'), true);
  assert.equal(cache.invalidateSource('i'), false);
  assert.equal(await cache.cachedSource('i', fetcher, { ttlMs: 60_000 }), 2);

  const gate = deferred();
  cache.invalidateSource('i');
  const flying = cache.cachedSource('i', () => gate.promise, { ttlMs: 60_000 });
  cache.invalidateSource('i');
  gate.resolve('orphan');
  assert.equal(await flying, 'orphan', 'quem ja esperava recebe o resultado');
  assert.equal(cache.peekSource('i'), undefined, 'mas o cache invalidado nao e repovoado');
});

test('peekSource devolve valor sem disparar fetch; clearSources zera tudo', async () => {
  const cache = createSourceCache();
  let calls = 0;
  assert.equal(cache.peekSource('p'), undefined);
  await cache.cachedSource('p', async () => { calls += 1; return { ok: true }; }, { ttlMs: 1 });
  assert.deepEqual(cache.peekSource('p'), { ok: true });
  assert.equal(calls, 1);
  cache.clearSources();
  assert.equal(cache.size(), 0);
  assert.equal(cache.peekSource('p'), undefined);
});

test('argumentos invalidos rejeitam', async () => {
  const cache = createSourceCache();
  await assert.rejects(cache.cachedSource('', async () => 1), TypeError);
  await assert.rejects(cache.cachedSource('k', null), TypeError);
});

test('instancia compartilhada exporta a mesma API', async () => {
  clearSources();
  const now = makeClock();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 'shared'; };
  assert.equal(await cachedSource('shared:key', fetcher, { ttlMs: 100, now }), 'shared');
  assert.equal(await cachedSource('shared:key', fetcher, { ttlMs: 100, now }), 'shared');
  assert.equal(calls, 1);
  assert.equal(peekSource('shared:key'), 'shared');
  assert.equal(invalidateSource('shared:key'), true);
  clearSources();
});

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const okJson = (rows) => ({ ok: true, status: 200, json: async () => rows });

test('dgSelect sem ttl mantem no-store e um fetch por chamada', async () => {
  clearSources();
  const stub = stubFetch(() => okJson([{ a: 1 }]));
  try {
    await dgSelect('t_nocache', 'select=a');
    await dgSelect('t_nocache', 'select=a');
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].init.cache, 'no-store');
  } finally {
    stub.restore();
  }
});

test('dgSelect com ttl deduplica e reaproveita; chave inclui query e range', async () => {
  clearSources();
  const stub = stubFetch(() => okJson([{ nome: 'Foz do Iguaçu' }]));
  try {
    const [a, b] = await Promise.all([
      dgSelect('t_cache', 'select=nome', { ttlMs: 60_000 }),
      dgSelect('t_cache', 'select=nome', { ttlMs: 60_000 }),
    ]);
    assert.equal(stub.calls.length, 1, 'concorrentes dividem o voo');
    assert.equal(a, b);
    assert.equal(a[0].nome, 'Foz do Iguaçu');
    await dgSelect('t_cache', 'select=nome', { ttlMs: 60_000 });
    assert.equal(stub.calls.length, 1, 'dentro do TTL nao busca');
    await dgSelect('t_cache', 'select=nome&limit=1', { ttlMs: 60_000 });
    await dgSelect('t_cache', 'select=nome', { ttlMs: 60_000, range: [0, 9] });
    assert.equal(stub.calls.length, 3, 'query/range diferentes sao chaves diferentes');
    assert.equal(peekSource('t_cache?select=nome|0-9')[0].nome, 'Foz do Iguaçu');
  } finally {
    stub.restore();
    clearSources();
  }
});

test('dgSelect cacheKey estabiliza queries com timestamp; erro sem stale rejeita', async () => {
  clearSources();
  let fail = false;
  const stub = stubFetch(() => (fail ? { ok: false, status: 503, json: async () => ({}) } : okJson([1])));
  try {
    await dgSelect('t_ts', 'since=2026-01-01T00:00:00Z', { ttlMs: 60_000, cacheKey: 'x' });
    await dgSelect('t_ts', 'since=2026-01-01T00:00:01Z', { ttlMs: 60_000, cacheKey: 'x' });
    assert.equal(stub.calls.length, 1);
    fail = true;
    await assert.rejects(dgSelect('t_err', 'q', { ttlMs: 60_000 }), /HTTP 503/);
    await assert.rejects(dgSelect('t_err', 'q', { ttlMs: 60_000 }), /HTTP 503/);
    assert.equal(stub.calls.length, 3, 'falha nao cacheada');
  } finally {
    stub.restore();
    clearSources();
  }
});

test('preserva texto UTF-8 com acentos', async () => {
  const cache = createSourceCache();
  const value = 'Previsão de chuva em São José dos Pinhais, Maringá e Paranaguá';
  assert.equal(await cache.cachedSource('utf8', async () => value, { ttlMs: 1000 }), value);
  assert.equal(cache.peekSource('utf8'), value);
});
