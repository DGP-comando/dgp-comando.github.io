import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from './fetchPool.js';
import { fetchFiresPayload, fetchPagesParallel } from './datageoClient.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('limite invalido lanca RangeError', () => {
  assert.throws(() => createPool(0), RangeError);
  assert.throws(() => createPool(-2), RangeError);
  assert.throws(() => createPool('abc'), RangeError);
  assert.doesNotThrow(() => createPool(1));
});

test('nunca excede o limite de concorrencia', async () => {
  const pool = createPool(2);
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 5 }, deferred);
  const results = gates.map((gate, i) => pool.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
    return i;
  }));

  await tick();
  assert.equal(pool.active(), 2);
  assert.equal(pool.pending(), 3);
  for (const gate of gates) {
    gate.resolve();
    await tick();
  }
  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(pool.active(), 0);
  assert.equal(pool.pending(), 0);
});

test('inicia na ordem de chegada', async () => {
  const pool = createPool(1);
  const started = [];
  await Promise.all([3, 1, 2].map((n) => pool.run(async () => {
    started.push(n);
    await tick();
  })));
  assert.deepEqual(started, [3, 1, 2]);
});

test('rejeicao propaga e libera a vaga', async () => {
  const pool = createPool(1);
  await assert.rejects(pool.run(async () => { throw new Error('falhou'); }), /falhou/);
  await assert.rejects(pool.run(() => { throw new Error('sync'); }), /sync/);
  assert.equal(await pool.run(() => 'depois'), 'depois');
  assert.equal(pool.active(), 0);
});

test('fn nao-funcao rejeita', async () => {
  const pool = createPool(3);
  await assert.rejects(pool.run(42), TypeError);
});

// ---------------------------------------------------------------------------
// Paginacao paralela do DataGeo (fetchPagesParallel / fetchFiresPayload)
// ---------------------------------------------------------------------------

function pagedSource(total) {
  const log = [];
  let active = 0;
  let peak = 0;
  const fetchPage = async (from, to) => {
    log.push(from);
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
    const rows = [];
    for (let i = from; i <= to && i < total; i++) rows.push({ i });
    return rows;
  };
  return { fetchPage, log, peak: () => peak };
}

async function sequentialReference(fetchPage, pageSize = 1000, maxRows = 20_000) {
  const rows = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const batch = await fetchPage(from, from + pageSize - 1);
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

test('fetchPagesParallel: pagina unica nao abre ondas', async () => {
  const src = pagedSource(10);
  const rows = await fetchPagesParallel(src.fetchPage);
  assert.equal(rows.length, 10);
  assert.deepEqual(src.log, [0]);
});

test('fetchPagesParallel: total exato de uma pagina busca a seguinte e para', async () => {
  const src = pagedSource(1000);
  const rows = await fetchPagesParallel(src.fetchPage);
  assert.equal(rows.length, 1000);
  assert.equal(src.log[0], 0);
  assert.ok(src.log.includes(1000));
});

test('fetchPagesParallel: mesma saida e ordem do laco sequencial, no maximo 4 simultaneas', async () => {
  for (const total of [0, 999, 1001, 4500, 5000, 5001, 12_345]) {
    const par = pagedSource(total);
    const seq = pagedSource(total);
    const got = await fetchPagesParallel(par.fetchPage);
    const want = await sequentialReference(seq.fetchPage);
    assert.deepEqual(got, want, `total=${total}`);
    assert.ok(par.peak() <= 4, `pico ${par.peak()} para total=${total}`);
  }
});

test('fetchPagesParallel: respeita o teto de 20k linhas', async () => {
  const src = pagedSource(50_000);
  const rows = await fetchPagesParallel(src.fetchPage);
  assert.equal(rows.length, 20_000);
  assert.equal(Math.max(...src.log), 19_000);
  assert.equal(new Set(src.log).size, 20);
  assert.deepEqual(rows.map((r) => r.i), Array.from({ length: 20_000 }, (_, i) => i));
});

test('fetchPagesParallel: erro em qualquer pagina rejeita', async () => {
  const fetchPage = async (from) => {
    if (from === 3000) throw new Error('HTTP 500');
    return Array.from({ length: 1000 }, () => ({}));
  };
  await assert.rejects(fetchPagesParallel(fetchPage), /HTTP 500/);
});

test('fetchFiresPayload: shape identico e paginas em paralelo via Range', async () => {
  const originalFetch = globalThis.fetch;
  const total = 2300;
  const today = new Date().toISOString().slice(0, 10);
  const ranges = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/rest\/v1\/fire_spots\?select=/);
    assert.equal(init.cache, 'no-store');
    const [from, to] = init.headers.Range.split('-').map(Number);
    ranges.push(from);
    const rows = [];
    for (let i = from; i <= to && i < total; i++) {
      rows.push({
        latitude: -25 - i / 10_000,
        longitude: -51,
        brightness: '330.5',
        acq_date: today,
        acq_time: '0',
        satellite: 'N20',
        instrument: 'VIIRS',
        confidence: 'n',
        municipality: i === 0 ? 'São José dos Pinhais' : 'Maringá',
      });
    }
    return { ok: true, status: 206, json: async () => rows };
  };
  try {
    const payload = await fetchFiresPayload({ windowHours: 48 });
    assert.deepEqual(Object.keys(payload), ['fetchedAt', 'stale', 'ttlMs', 'sources', 'count', 'fires']);
    assert.equal(payload.stale, false);
    assert.equal(payload.ttlMs, 600_000);
    assert.equal(payload.count, total);
    assert.equal(payload.fires.length, total);
    assert.deepEqual(payload.sources, [{ source: 'DATAGEO_PR_SUPABASE', count: total, ok: true }]);
    assert.deepEqual(Object.keys(payload.fires[0]), [
      'lat', 'lon', 'frp', 'confidence', 'brightness', 'brightnessTi5', 'daynight',
      'acqDate', 'acqTime', 'satellite', 'instrument', 'municipality',
    ]);
    assert.equal(payload.fires[0].municipality, 'São José dos Pinhais', 'UTF-8 preservado');
    assert.equal(payload.fires[0].brightness, 330.5);
    assert.equal(payload.fires[0].acqTime, '0');
    assert.ok(payload.fires.every((f, i) => f.lat === -25 - i / 10_000), 'ordem preservada');
    assert.deepEqual([...ranges].sort((a, b) => a - b).slice(0, 3), [0, 1000, 2000]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
