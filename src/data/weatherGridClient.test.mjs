import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEATHER_GRID_BOUNDS,
  WEATHER_GRID_HEIGHT,
  WEATHER_GRID_WIDTH,
  fetchWeatherGrid,
  resetWeatherGridMemo,
} from './datageoClient.js';
import { WEATHER_GRID_STORAGE_KEY, serializeWeatherGrid } from './weatherGridStore.js';

const N = WEATHER_GRID_WIDTH * WEATHER_GRID_HEIGHT;

function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
  return map;
}

function okPointsResponse(url) {
  const count = new URL(url).searchParams.get('latitude').split(',').length;
  const points = Array.from({ length: count }, () => ({
    current: { wind_speed_10m: 5, wind_direction_10m: 180, precipitation: 1.5 },
  }));
  return { ok: true, status: 200, json: async () => points };
}

function storedGrid(fetchedAt, speed = 7) {
  const arr = Array.from({ length: N }, () => speed);
  return serializeWeatherGrid({
    u: { array: arr }, v: { array: arr }, precip: arr,
    width: WEATHER_GRID_WIDTH, height: WEATHER_GRID_HEIGHT, bounds: WEATHER_GRID_BOUNDS,
  }, fetchedAt);
}

function serverRow(observedAt, { u = 2, width = WEATHER_GRID_WIDTH } = {}) {
  const arr = (v) => Array.from({ length: width * WEATHER_GRID_HEIGHT }, () => v);
  return [{
    data: {
      version: 1, width, height: WEATHER_GRID_HEIGHT, bounds: WEATHER_GRID_BOUNDS,
      observed_at: new Date(observedAt).toISOString(), fetched_at: new Date(observedAt).toISOString(),
      u: arr(u), v: arr(-1), precip: arr(0.4),
    },
    fetched_at: new Date(observedAt).toISOString(),
  }];
}

/** Roteia supabase (data_cache) e open-meteo; conta chamadas de cada um. */
function mockNetwork(t, { supabase, meteo }) {
  const calls = { supabase: 0, meteo: 0 };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    if (href.includes('/rest/v1/data_cache')) {
      calls.supabase += 1;
      return supabase(href);
    }
    if (href.includes('api.open-meteo.com')) {
      calls.meteo += 1;
      return meteo(href);
    }
    throw new Error(`url inesperada ${href}`);
  });
  return calls;
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('grade fresca no localStorage nao gasta rede nenhuma', async (t) => {
  resetWeatherGridMemo();
  const store = installStorage();
  store.set(WEATHER_GRID_STORAGE_KEY, storedGrid(Date.now() - 60_000));
  const calls = mockNetwork(t, {
    supabase: () => { throw new Error('nao deveria chamar'); },
    meteo: () => { throw new Error('nao deveria chamar'); },
  });
  const grid = await fetchWeatherGrid();
  assert.deepEqual(calls, { supabase: 0, meteo: 0 });
  assert.equal(grid.stale, false);
  assert.equal(grid.u.array.length, N);
});

test('caminho normal: le meteo_grade_pr do data_cache, zero chamadas a Open-Meteo', async (t) => {
  resetWeatherGridMemo();
  const store = installStorage();
  const observedAt = Date.now() - 10 * 60_000;
  const calls = mockNetwork(t, {
    supabase: (href) => {
      assert.match(href, /cache_key=eq\.meteo_grade_pr&/);
      return json(200, serverRow(observedAt, { u: 3.5 }));
    },
    meteo: () => { throw new Error('nao deveria chamar'); },
  });
  const grid = await fetchWeatherGrid();
  assert.deepEqual(calls, { supabase: 1, meteo: 0 });
  assert.equal(grid.stale, false);
  assert.equal(grid.fetchedAt, observedAt, 'hora do dado = slot observado');
  assert.equal(grid.u.array[0], 3.5);
  assert.ok(grid.precip instanceof Float32Array);
  assert.ok(store.has(WEATHER_GRID_STORAGE_KEY), 'persiste para a proxima recarga');
});

test('linha do servidor velha ou de outra grade cai na Open-Meteo direta', async (t) => {
  for (const row of [serverRow(Date.now() - 80 * 60_000), serverRow(Date.now(), { width: 21 }), []]) {
    resetWeatherGridMemo();
    installStorage();
    const calls = mockNetwork(t, { supabase: () => json(200, row), meteo: okPointsResponse });
    const grid = await fetchWeatherGrid();
    assert.equal(calls.meteo, 3, '330 pontos em lotes de 110');
    assert.equal(grid.precip[0], 1.5);
    t.mock.restoreAll();
  }
});

test('Supabase fora e Open-Meteo 503 com copia antiga: grade salva marcada stale', async (t) => {
  resetWeatherGridMemo();
  const store = installStorage();
  const savedAt = Date.now() - 2 * 3600_000;
  store.set(WEATHER_GRID_STORAGE_KEY, storedGrid(savedAt, 3));
  mockNetwork(t, { supabase: () => json(503, {}), meteo: () => json(503, {}) });
  const started = Date.now();
  const grid = await fetchWeatherGrid();
  assert.ok(Date.now() - started < 5_000, 'com copia nao espera o retry');
  assert.equal(grid.stale, true);
  assert.equal(grid.fetchedAt, savedAt);
  assert.equal(grid.u.array[0], 3);
});

test('404 da Open-Meteo sem copia nem servidor propaga o erro com status', async (t) => {
  resetWeatherGridMemo();
  installStorage();
  mockNetwork(t, { supabase: () => json(200, []), meteo: () => json(404, {}) });
  await assert.rejects(fetchWeatherGrid(), (err) => err.status === 404);
});
