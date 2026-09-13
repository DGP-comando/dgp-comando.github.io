import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_POLL_DELAY_MS,
  isDocumentHidden,
  nextPollDelay,
  shouldSkipPoll,
  startPollLoop,
} from './pollPolicy.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('sem falhas o atraso e o base', () => {
  assert.equal(nextPollDelay({ baseMs: 60_000 }), 60_000);
  assert.equal(nextPollDelay({ baseMs: 60_000, consecutiveFailures: 0 }), 60_000);
});

test('backoff exponencial dobra a cada falha ate o teto', () => {
  const base = 60_000;
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 1 }), 120_000);
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 2 }), 240_000);
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 4 }), 960_000);
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 5 }), DEFAULT_MAX_POLL_DELAY_MS);
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 1000 }), DEFAULT_MAX_POLL_DELAY_MS);
  assert.equal(DEFAULT_MAX_POLL_DELAY_MS, 30 * 60_000);
});

test('maxMs customizado limita, mas nunca abaixo do base', () => {
  assert.equal(nextPollDelay({ baseMs: 1000, consecutiveFailures: 10, maxMs: 5000 }), 5000);
  assert.equal(nextPollDelay({ baseMs: 3_600_000, consecutiveFailures: 3, maxMs: 60_000 }), 3_600_000,
    'intervalo base maior que o teto continua valendo');
});

test('entradas invalidas sao saneadas', () => {
  assert.equal(nextPollDelay({ baseMs: 0 }), 0);
  assert.equal(nextPollDelay({ baseMs: -5 }), 0);
  assert.equal(nextPollDelay({ baseMs: NaN }), 0);
  assert.equal(nextPollDelay(), 0);
  assert.equal(nextPollDelay({ baseMs: 1000, consecutiveFailures: -3 }), 1000);
  assert.equal(nextPollDelay({ baseMs: 1000, consecutiveFailures: 'x' }), 1000);
  assert.equal(nextPollDelay({ baseMs: 1000, consecutiveFailures: 1, maxMs: -1 }), 2000);
});

test('jitter injetavel espalha dentro de [base, teto]', () => {
  const base = 10_000;
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 2, jitter: 0.5, random: () => 0.5 }), 40_000);
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 2, jitter: 0.5, random: () => 0 }), 20_000);
  assert.equal(nextPollDelay({ baseMs: base, consecutiveFailures: 2, jitter: 0.5, random: () => 1 }), 60_000);
  assert.equal(nextPollDelay({ baseMs: base, jitter: 0.5, random: () => 0 }), base, 'nunca abaixo do base');
  assert.equal(
    nextPollDelay({ baseMs: base, consecutiveFailures: 20, maxMs: 50_000, jitter: 1, random: () => 1 }),
    50_000,
    'nunca acima do teto',
  );
  for (let i = 0; i < 50; i++) {
    const d = nextPollDelay({ baseMs: base, consecutiveFailures: 3, jitter: 0.3 });
    assert.ok(d >= base && d <= DEFAULT_MAX_POLL_DELAY_MS);
  }
});

test('shouldSkipPoll so pula com hidden === true', () => {
  assert.equal(shouldSkipPoll({ hidden: true }), true);
  assert.equal(shouldSkipPoll({ hidden: false }), false);
  assert.equal(shouldSkipPoll({}), false);
  assert.equal(shouldSkipPoll(), false);
});

test('isDocumentHidden e false fora do browser', () => {
  const original = globalThis.document;
  try {
    delete globalThis.document;
    assert.equal(isDocumentHidden(), false);
    globalThis.document = { hidden: true };
    assert.equal(isDocumentHidden(), true);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

function fakeEnv() {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  const listeners = new Map();
  const doc = {
    hidden: false,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  return {
    doc,
    listeners,
    timers,
    now: () => t,
    advance(ms) { t += ms; },
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    fireTimer() {
      const [id, timer] = [...timers.entries()].at(-1);
      timers.delete(id);
      t += timer.ms;
      timer.fn();
      return timer.ms;
    },
    lastDelay() { return [...timers.values()].at(-1)?.ms; },
  };
}

test('startPollLoop: roda na partida, agenda base, aplica backoff e reseta no sucesso', async () => {
  const env = fakeEnv();
  let calls = 0;
  let fail = false;
  const errors = [];
  const loop = startPollLoop(async () => {
    calls += 1;
    if (fail) throw new Error('rede');
  }, { baseMs: 1000, maxMs: 8000, ...env, onError: (e) => errors.push(e.message) });

  await flush();
  assert.equal(calls, 1);
  assert.equal(env.lastDelay(), 1000);
  assert.equal(env.timers.size, 1, 'um unico timer por vez');

  fail = true;
  env.fireTimer();
  await flush();
  assert.equal(calls, 2);
  assert.equal(env.lastDelay(), 2000);
  env.fireTimer();
  await flush();
  assert.equal(env.lastDelay(), 4000);
  env.fireTimer();
  await flush();
  env.fireTimer();
  await flush();
  assert.equal(env.lastDelay(), 8000, 'teto respeitado');
  assert.deepEqual(errors, ['rede', 'rede', 'rede', 'rede']);

  fail = false;
  env.fireTimer();
  await flush();
  assert.equal(env.lastDelay(), 1000, 'sucesso zera o backoff');
  loop.stop();
  assert.equal(env.timers.size, 0);
  assert.equal(env.listeners.size, 0, 'stop remove o listener de visibilidade');
});

test('startPollLoop: pula ticks com aba oculta e faz catch-up ao voltar se vencido', async () => {
  const env = fakeEnv();
  let calls = 0;
  const loop = startPollLoop(async () => { calls += 1; }, { baseMs: 1000, ...env });
  await flush();
  assert.equal(calls, 1);

  env.doc.hidden = true;
  env.fireTimer();
  await flush();
  env.fireTimer();
  await flush();
  assert.equal(calls, 1, 'oculta nao busca');
  assert.equal(env.timers.size, 1, 'continua agendado');

  // Visivel de novo e o ultimo ciclo ja venceu: busca imediatamente.
  env.doc.hidden = false;
  env.listeners.get('visibilitychange')();
  await flush();
  assert.equal(calls, 2);

  // Visivel de novo com dado fresco: nao busca.
  env.advance(100);
  env.listeners.get('visibilitychange')();
  await flush();
  assert.equal(calls, 2);
  loop.stop();
});

test('startPollLoop: visibilitychange para oculto nao dispara fetch e stop encerra tudo', async () => {
  const env = fakeEnv();
  let calls = 0;
  const loop = startPollLoop(async () => { calls += 1; }, { baseMs: 1000, ...env });
  await flush();
  env.advance(5000);
  env.doc.hidden = true;
  env.listeners.get('visibilitychange')();
  await flush();
  assert.equal(calls, 1);
  loop.stop();
  await loop.runNow();
  assert.equal(calls, 1, 'runNow apos stop e no-op');
});

test('startPollLoop funciona sem documento (node)', async () => {
  const env = fakeEnv();
  let calls = 0;
  const loop = startPollLoop(async () => { calls += 1; }, { baseMs: 1000, ...env, doc: null });
  await flush();
  assert.equal(calls, 1);
  loop.stop();
});

// ---------------------------------------------------------------------------
// Integracao com o DataLayerManager: skip oculto, backoff e catch-up
// ---------------------------------------------------------------------------

async function withManagerHarness(run) {
  const { DataLayerManager } = await import('./manager.js');
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalDocument = globalThis.document;
  const originalNow = Date.now;
  const intervals = new Map();
  let nextId = 1;
  let clock = 1_000_000;
  const listeners = new Map();
  globalThis.setInterval = (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => { intervals.delete(id); };
  Date.now = () => clock;
  globalThis.document = {
    hidden: false,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  try {
    await run({
      DataLayerManager,
      intervals,
      listeners,
      doc: globalThis.document,
      advance: (ms) => { clock += ms; },
      tickAll: async () => {
        for (const { fn } of [...intervals.values()]) fn();
        await flush();
      },
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Date.now = originalNow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

function pollingLayer(id, intervalMs) {
  const state = { updates: 0, fail: false };
  return {
    state,
    module: {
      id,
      name: id,
      icon: '',
      source: 'test',
      updateInterval: intervalMs,
      init() {},
      enable() {},
      disable() {},
      async update() {
        state.updates += 1;
        if (state.fail) throw new Error('fonte fora');
        return true;
      },
      getStats() { return { count: 1, lastUpdate: null }; },
    },
  };
}

test('manager: tick com aba oculta e pulado e o visibilitychange faz catch-up', async () => {
  await withManagerHarness(async ({ DataLayerManager, intervals, listeners, doc, advance, tickAll }) => {
    const mgr = new DataLayerManager({});
    const layer = pollingLayer('poll-hidden', 60_000);
    mgr.register(layer.module);
    assert.equal(await mgr.toggle('poll-hidden'), true);
    const afterEnable = layer.state.updates;
    const entry = mgr.layers.get('poll-hidden');
    assert.ok(entry.intervalId, 'contrato do setInterval preservado');
    assert.equal(intervals.size, 1);
    assert.equal(typeof listeners.get('visibilitychange'), 'function');

    doc.hidden = true;
    advance(60_000);
    await tickAll();
    assert.equal(layer.state.updates, afterEnable, 'oculta nao busca');

    // Visivel com dado vencido: catch-up imediato.
    doc.hidden = false;
    listeners.get('visibilitychange')();
    await flush();
    assert.equal(layer.state.updates, afterEnable + 1);

    // Visivel de novo com dado fresco: nada.
    advance(1000);
    listeners.get('visibilitychange')();
    await flush();
    assert.equal(layer.state.updates, afterEnable + 1);

    await mgr.destroyAll();
    assert.equal(listeners.size, 0, 'destroyAll remove o listener');
    assert.equal(intervals.size, 0);
  });
});

test('manager: falhas consecutivas aplicam backoff e sucesso reseta', async () => {
  await withManagerHarness(async ({ DataLayerManager, advance, tickAll }) => {
    const mgr = new DataLayerManager({});
    const layer = pollingLayer('poll-backoff', 60_000);
    mgr.register(layer.module);
    await mgr.toggle('poll-backoff');
    const entry = mgr.layers.get('poll-backoff');
    const base = layer.state.updates;

    layer.state.fail = true;
    advance(60_000);
    await tickAll();
    assert.equal(layer.state.updates, base + 1);
    assert.equal(entry.consecutiveFailures, 1);
    assert.match(entry.managerRefreshError, /fonte fora/);

    // 1 falha -> periodo efetivo 2x: o proximo tick e pulado, o seguinte roda.
    advance(60_000);
    await tickAll();
    assert.equal(layer.state.updates, base + 1, 'tick em backoff pulado');
    advance(60_000);
    await tickAll();
    assert.equal(layer.state.updates, base + 2);
    assert.equal(entry.consecutiveFailures, 2);

    // 2 falhas -> 4x: tres ticks pulados.
    for (let i = 0; i < 3; i++) {
      advance(60_000);
      await tickAll();
    }
    assert.equal(layer.state.updates, base + 2);
    layer.state.fail = false;
    advance(60_000);
    await tickAll();
    assert.equal(layer.state.updates, base + 3);
    assert.equal(entry.consecutiveFailures, 0);
    assert.equal(entry.backoffUntil, 0);
    assert.equal(entry.managerRefreshError, null);

    advance(60_000);
    await tickAll();
    assert.equal(layer.state.updates, base + 4, 'cadencia normal restaurada');
    await mgr.destroyAll();
  });
});

test('manager: sem document (node) arma o loop sem listener', async () => {
  const { DataLayerManager } = await import('./manager.js');
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  delete globalThis.document;
  globalThis.setInterval = () => 42;
  globalThis.clearInterval = () => {};
  try {
    const mgr = new DataLayerManager({});
    const layer = pollingLayer('poll-node', 60_000);
    mgr.register(layer.module);
    await mgr.toggle('poll-node');
    assert.equal(mgr.layers.get('poll-node').intervalId, 42);
    assert.equal(mgr._visibilityCatchUp ?? null, null);
    await mgr.destroyAll();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalDocument !== undefined) globalThis.document = originalDocument;
  }
});
