// src/data/sourceCache.js
//
// Cache de fontes remotas por chave: TTL + deduplicacao de voos concorrentes
// + stale-on-error. Padrao inspirado no osiris: a PROMESSA em voo e
// memoizada, entao N chamadores simultaneos (ticker, briefing, camadas)
// compartilham uma unica requisicao.
//
// Regras:
//  - Valor fresco (idade < ttlMs) volta direto, sem chamar o fetcher.
//  - Chamada concorrente com um voo aberto recebe a MESMA promessa.
//  - Refetch que falha com valor anterior disponivel resolve com o valor
//    velho (stale) e segura novas tentativas por `retryMs` (60 s default):
//    nesse intervalo as chamadas recebem o stale sem martelar a fonte.
//    Desligavel por chamada com `staleOnError: false` (rejeita a falha).
//  - Falha sem valor anterior rejeita e NAO e cacheada (a proxima chamada
//    tenta de novo).
//  - Maximo de `maxKeys` chaves (200); a mais antiga e despejada.
//
// Puro e testavel: relogio injetavel via `now`.

export const DEFAULT_FAILURE_RETRY_MS = 60_000;
export const DEFAULT_MAX_KEYS = 200;

/**
 * Cria um cache isolado. O modulo exporta uma instancia compartilhada
 * (cachedSource/invalidateSource/clearSources/peekSource); a fabrica existe
 * para testes e para quem precisar de um espaco de chaves proprio.
 * @param {{maxKeys?: number, retryMs?: number, now?: () => number}} [options]
 */
export function createSourceCache({
  maxKeys = DEFAULT_MAX_KEYS,
  retryMs = DEFAULT_FAILURE_RETRY_MS,
  now: defaultNow = Date.now,
} = {}) {
  // key -> { hasValue, value, fetchedAt, inflight, retryAt }
  const entries = new Map();

  function evictIfNeeded() {
    while (entries.size > maxKeys) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>|T} fetcher
   * @param {{ttlMs?: number, now?: () => number, staleOnError?: boolean}} [options]
   *   staleOnError=false: refetch falho rejeita mesmo com valor anterior (o
   *   valor antigo continua no cache para peek, sem janela de retry). Util
   *   para camadas cujo painel precisa enxergar a falha.
   * @returns {Promise<T>}
   */
  function cachedSource(key, fetcher, { ttlMs = 0, now, staleOnError = true } = {}) {
    if (typeof key !== 'string' || key === '') {
      return Promise.reject(new TypeError('cachedSource: key must be a non-empty string'));
    }
    if (typeof fetcher !== 'function') {
      return Promise.reject(new TypeError('cachedSource: fetcher must be a function'));
    }
    const clock = typeof now === 'function' ? now : defaultNow;
    const t = clock();
    const existing = entries.get(key);

    if (existing?.inflight) return existing.inflight;
    if (existing?.hasValue) {
      if (t - existing.fetchedAt < ttlMs) return Promise.resolve(existing.value);
      if (existing.retryAt && t < existing.retryAt) return Promise.resolve(existing.value);
    }

    const base = existing ?? { hasValue: false, value: undefined, fetchedAt: 0, inflight: null, retryAt: 0 };
    if (!existing) {
      entries.set(key, base);
      evictIfNeeded();
    }
    return launch(key, base, fetcher, clock, staleOnError !== false);
  }

  function launch(key, base, fetcher, clock, staleOnError) {
    const pending = { ...base, inflight: null };
    let promise;
    try {
      promise = Promise.resolve(fetcher());
    } catch (err) {
      promise = Promise.reject(err);
    }
    pending.inflight = promise.then(
      (value) => {
        if (entries.get(key) === pending) {
          entries.set(key, { hasValue: true, value, fetchedAt: clock(), inflight: null, retryAt: 0 });
        }
        return value;
      },
      (err) => {
        const stillCached = entries.get(key) === pending;
        if (pending.hasValue && !staleOnError) {
          if (stillCached) entries.set(key, { ...pending, inflight: null, retryAt: 0 });
          throw err;
        }
        if (pending.hasValue) {
          if (stillCached) {
            entries.set(key, { ...pending, inflight: null, retryAt: clock() + retryMs });
          }
          return pending.value;
        }
        if (stillCached) entries.delete(key);
        throw err;
      },
    );
    // Mantem a posicao de insercao (idade para despejo) da chave existente.
    entries.set(key, pending);
    return pending.inflight;
  }

  function invalidateSource(key) {
    return entries.delete(key);
  }

  function clearSources() {
    entries.clear();
  }

  /** Valor cacheado (fresco ou stale) sem disparar fetch; undefined se ausente. */
  function peekSource(key) {
    const entry = entries.get(key);
    return entry?.hasValue ? entry.value : undefined;
  }

  function size() {
    return entries.size;
  }

  return { cachedSource, invalidateSource, clearSources, peekSource, size };
}

const shared = createSourceCache();

export const cachedSource = shared.cachedSource;
export const invalidateSource = shared.invalidateSource;
export const clearSources = shared.clearSources;
export const peekSource = shared.peekSource;
export const sourceCacheSize = shared.size;
