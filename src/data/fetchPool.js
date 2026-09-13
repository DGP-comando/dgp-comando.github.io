// src/data/fetchPool.js
//
// Pool de concorrencia minimo: `createPool(limit)` devolve `run(fn)`, que
// executa `fn` assim que houver vaga (no maximo `limit` em paralelo) e
// resolve/rejeita com o resultado dela. Ordem de inicio = ordem de chegada.

/**
 * @param {number} limit maximo de tarefas simultaneas (>= 1)
 * @returns {{ run: <T>(fn: () => Promise<T>|T) => Promise<T>, active: () => number, pending: () => number }}
 */
export function createPool(limit) {
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max < 1) {
    throw new RangeError(`createPool: limit must be >= 1 (got ${limit})`);
  }
  let running = 0;
  const queue = [];

  function pump() {
    while (running < max && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      running += 1;
      let promise;
      try {
        promise = Promise.resolve(fn());
      } catch (err) {
        promise = Promise.reject(err);
      }
      // Libera a vaga ANTES de entregar o resultado: quem aguarda ja ve o
      // pool consistente (active() atualizado, proxima tarefa iniciada).
      const release = () => {
        running -= 1;
        pump();
      };
      promise.then(
        (value) => { release(); resolve(value); },
        (err) => { release(); reject(err); },
      );
    }
  }

  function run(fn) {
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('pool.run: fn must be a function'));
    }
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }

  return {
    run,
    active: () => running,
    pending: () => queue.length,
  };
}
