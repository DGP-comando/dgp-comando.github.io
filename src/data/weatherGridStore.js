// src/data/weatherGridStore.js
//
// Persistencia da grade Open-Meteo (vento + chuva) no localStorage.
//
// Por que existe: o plano gratuito da Open-Meteo conta CADA coordenada como
// uma chamada e limita por IP (ordem de 600/min, 5.000/h, 10.000/dia). A grade
// 22x15 custa 330 chamadas por carregamento; poucas recargas seguidas, ou
// varios usuarios atras do mesmo IP, estouram a cota e a API responde 429/503.
// Guardar a ultima grade boa faz (1) recarga dentro do TTL custar zero
// chamadas e (2) falha da API cair na ultima grade conhecida, rotulada como
// antiga, em vez de derrubar as duas camadas.
//
// Puro e sem dependencia de browser: o storage e injetavel.

export const WEATHER_GRID_STORAGE_KEY = 'dgp:weather-grid:v1';
/** Mais velha que isso a grade nao e usada nem como fallback. */
export const WEATHER_GRID_MAX_STALE_MS = 6 * 3600_000;

/**
 * @param {{u: {array: ArrayLike<number>}, v: {array: ArrayLike<number>}, precip: ArrayLike<number>,
 *   width: number, height: number, bounds: object}} grid
 * @param {number} fetchedAt epoch ms
 * @returns {string}
 */
export function serializeWeatherGrid(grid, fetchedAt) {
  const round = (arr) => Array.from(arr, (x) => Math.round(Number(x) * 100) / 100);
  return JSON.stringify({
    fetchedAt,
    width: grid.width,
    height: grid.height,
    bounds: grid.bounds,
    u: round(grid.u.array),
    v: round(grid.v.array),
    precip: round(grid.precip),
  });
}

/**
 * Reconstroi a grade no formato do cesium-wind-layer. Qualquer inconsistencia
 * (JSON quebrado, tamanhos que nao batem, grade de outro recorte) devolve null.
 * @param {string|null} text
 * @param {{width: number, height: number, bounds: object}} expected
 * @returns {{grid: object, fetchedAt: number}|null}
 */
export function deserializeWeatherGrid(text, expected) {
  if (!text) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const n = expected.width * expected.height;
  const sameBounds = raw?.bounds && ['west', 'south', 'east', 'north']
    .every((k) => Number(raw.bounds[k]) === Number(expected.bounds[k]));
  if (
    !raw || raw.width !== expected.width || raw.height !== expected.height || !sameBounds
    || !Number.isFinite(raw.fetchedAt)
    || ![raw.u, raw.v, raw.precip].every((a) => Array.isArray(a) && a.length === n)
  ) return null;
  const toF32 = (a) => Float32Array.from(a, (x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  return {
    fetchedAt: raw.fetchedAt,
    grid: {
      u: { array: toF32(raw.u) },
      v: { array: toF32(raw.v) },
      precip: toF32(raw.precip),
      width: raw.width,
      height: raw.height,
      bounds: { ...expected.bounds },
    },
  };
}

/**
 * Decide o que fazer com a copia persistida.
 * @returns {'fresh'|'stale'|'expired'|'none'}
 */
export function classifyStoredGrid(fetchedAt, now, ttlMs, maxStaleMs = WEATHER_GRID_MAX_STALE_MS) {
  if (!Number.isFinite(fetchedAt)) return 'none';
  const age = now - fetchedAt;
  if (age < 0) return 'expired'; // relogio do usuario voltou: nao confiar
  if (age < ttlMs) return 'fresh';
  if (age < maxStaleMs) return 'stale';
  return 'expired';
}

/** Linha do servidor mais velha que isso cai no fallback direto na Open-Meteo. */
export const SERVER_GRID_MAX_AGE_MS = 75 * 60_000;

/**
 * Converte o payload `meteo_grade_pr` do data_cache (job etl-meteo-grade do
 * c2-parana) na grade do cesium-wind-layer. O servidor ja entrega u/v em m/s.
 * Recorte diferente, tamanho errado ou horario invalido devolve null.
 * @param {object|null} payload `data` da linha
 * @param {{width: number, height: number, bounds: object}} expected
 * @returns {{grid: object, fetchedAt: number}|null}
 */
export function parseServerGrid(payload, expected) {
  if (!payload || payload.version !== 1) return null;
  const observedAt = Date.parse(payload.observed_at ?? '');
  if (!Number.isFinite(observedAt)) return null;
  // Mesmo contrato do storage local: reaproveita a validacao e a conversao.
  return deserializeWeatherGrid(JSON.stringify({ ...payload, fetchedAt: observedAt }), expected);
}

/** Status HTTP que valem uma nova tentativa (limite ou sobrecarga da API). */
export function isRetryableWeatherStatus(status) {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

export function readStoredGrid(storage, expected) {
  try {
    return deserializeWeatherGrid(storage?.getItem?.(WEATHER_GRID_STORAGE_KEY) ?? null, expected);
  } catch {
    return null;
  }
}

export function writeStoredGrid(storage, grid, fetchedAt) {
  try {
    storage?.setItem?.(WEATHER_GRID_STORAGE_KEY, serializeWeatherGrid(grid, fetchedAt));
    return true;
  } catch {
    return false; // quota cheia ou storage bloqueado: segue sem persistir
  }
}
