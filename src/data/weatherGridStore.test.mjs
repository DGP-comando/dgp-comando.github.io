import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEATHER_GRID_STORAGE_KEY,
  classifyStoredGrid,
  deserializeWeatherGrid,
  isRetryableWeatherStatus,
  parseServerGrid,
  readStoredGrid,
  serializeWeatherGrid,
  writeStoredGrid,
} from './weatherGridStore.js';

const bounds = { west: -55, south: -27, east: -48, north: -22.3 };
const expected = { width: 2, height: 2, bounds };
const grid = {
  u: { array: Float32Array.from([1.234, -2, 3, 4]) },
  v: { array: Float32Array.from([0, 0.5, -0.5, 9]) },
  precip: Float32Array.from([0, 0.7, 12.345, 0]),
  width: 2,
  height: 2,
  bounds,
};

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test('serializa e reconstroi a grade no formato do cesium-wind-layer', () => {
  const back = deserializeWeatherGrid(serializeWeatherGrid(grid, 1000), expected);
  assert.equal(back.fetchedAt, 1000);
  assert.ok(back.grid.u.array instanceof Float32Array);
  assert.ok(back.grid.precip instanceof Float32Array);
  assert.equal(back.grid.u.array[0].toFixed(2), '1.23');
  assert.equal(back.grid.precip[2].toFixed(2), '12.35');
  assert.deepEqual(back.grid.bounds, bounds);
});

test('rejeita JSON quebrado, tamanho ou recorte diferente', () => {
  assert.equal(deserializeWeatherGrid('{nope', expected), null);
  assert.equal(deserializeWeatherGrid(null, expected), null);
  const text = serializeWeatherGrid(grid, 1000);
  assert.equal(deserializeWeatherGrid(text, { ...expected, width: 3 }), null);
  assert.equal(deserializeWeatherGrid(text, { ...expected, bounds: { ...bounds, west: -56 } }), null);
  const broken = JSON.parse(text);
  broken.u = broken.u.slice(1);
  assert.equal(deserializeWeatherGrid(JSON.stringify(broken), expected), null);
});

test('classifica fresca, antiga, expirada e relogio invertido', () => {
  const ttl = 25 * 60_000;
  assert.equal(classifyStoredGrid(0, 10 * 60_000, ttl), 'fresh');
  assert.equal(classifyStoredGrid(0, 30 * 60_000, ttl), 'stale');
  assert.equal(classifyStoredGrid(0, 7 * 3600_000, ttl), 'expired');
  assert.equal(classifyStoredGrid(10_000, 0, ttl), 'expired');
  assert.equal(classifyStoredGrid(undefined, 0, ttl), 'none');
});

test('status de limite/sobrecarga sao retentaveis; 400 e 404 nao', () => {
  for (const s of [429, 502, 503, 504]) assert.equal(isRetryableWeatherStatus(s), true);
  for (const s of [400, 404, 500]) assert.equal(isRetryableWeatherStatus(s), false);
});

test('parseServerGrid aceita o payload do etl-meteo-grade e rejeita versao ou horario invalidos', () => {
  const payload = {
    version: 1, width: 2, height: 2, bounds,
    observed_at: '2026-09-13T13:45:00.000Z', fetched_at: '2026-09-13T13:05:00.000Z',
    u: [1, 2, 3, 4], v: [0, 0, 0, 0], precip: [0, 0.2, 0, 0],
  };
  const parsed = parseServerGrid(payload, expected);
  assert.equal(parsed.fetchedAt, Date.parse('2026-09-13T13:45:00.000Z'));
  assert.ok(parsed.grid.u.array instanceof Float32Array);
  assert.equal(parsed.grid.precip[1].toFixed(1), '0.2');
  assert.equal(parseServerGrid({ ...payload, version: 2 }, expected), null);
  assert.equal(parseServerGrid({ ...payload, observed_at: 'x' }, expected), null);
  assert.equal(parseServerGrid(null, expected), null);
});

test('read/write toleram storage ausente, cheio ou bloqueado', () => {
  const storage = memoryStorage();
  assert.equal(writeStoredGrid(storage, grid, 42), true);
  assert.ok(storage.map.has(WEATHER_GRID_STORAGE_KEY));
  assert.equal(readStoredGrid(storage, expected).fetchedAt, 42);
  assert.equal(readStoredGrid(null, expected), null);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.equal(readStoredGrid(throwing, expected), null);
  assert.equal(writeStoredGrid(throwing, grid, 1), false);
});
