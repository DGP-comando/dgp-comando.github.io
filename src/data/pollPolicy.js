// src/data/pollPolicy.js
//
// Politica pura de polling: backoff exponencial com teto e jitter opcional
// (injetavel), e a regra de pular ticks com a aba oculta. Sem timers, sem
// DOM: quem agenda e o chamador (manager, ticker, briefing).

export const DEFAULT_MAX_POLL_DELAY_MS = 30 * 60_000;

/**
 * Proximo atraso de poll.
 *  - 0 falhas: `baseMs`.
 *  - n falhas: `baseMs * 2^n`, limitado a `maxMs` (default 30 min).
 * Se `jitter` (0..1) for > 0, o atraso e espalhado em +-jitter usando
 * `random()` (default Math.random), mas nunca abaixo de `baseMs` nem acima
 * do teto.
 * @param {{baseMs: number, consecutiveFailures?: number, maxMs?: number, jitter?: number, random?: () => number}} options
 * @returns {number} atraso em ms
 */
export function nextPollDelay({
  baseMs,
  consecutiveFailures = 0,
  maxMs = DEFAULT_MAX_POLL_DELAY_MS,
  jitter = 0,
  random = Math.random,
} = {}) {
  const base = Number(baseMs);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const cap = Math.max(base, Number.isFinite(Number(maxMs)) && Number(maxMs) > 0 ? Number(maxMs) : DEFAULT_MAX_POLL_DELAY_MS);
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  // 2^31 ja estoura qualquer teto razoavel; evita Infinity em contagens grandes.
  const exp = Math.min(failures, 31);
  let delay = Math.min(cap, base * 2 ** exp);

  const spread = Math.min(1, Math.max(0, Number(jitter) || 0));
  if (spread > 0) {
    const r = Math.min(1, Math.max(0, Number(random()) || 0));
    delay = delay * (1 + spread * (2 * r - 1));
    delay = Math.min(cap, Math.max(base, delay));
  }
  return Math.round(delay);
}

/**
 * Pula o tick quando a aba esta oculta (economia de rede/bateria; ao voltar
 * a ficar visivel, o chamador faz catch-up se o dado estiver velho).
 * @param {{hidden?: boolean}} [options]
 */
export function shouldSkipPoll({ hidden = false } = {}) {
  return hidden === true;
}

/** Leitura segura de document.hidden (false fora do browser). */
export function isDocumentHidden() {
  return typeof document !== 'undefined' && document?.hidden === true;
}

/**
 * Loop de polling com backoff, skip quando oculto e catch-up no
 * visibilitychange. Usado pelo ticker e pelo briefing (chrome do HUD).
 * `task` deve resolver true/qualquer valor em sucesso e lancar em falha.
 * Timers e documento injetaveis para teste.
 * @param {() => Promise<unknown>} task
 * @param {{baseMs: number, maxMs?: number, now?: () => number, doc?: Document|null, setTimer?: Function, clearTimer?: Function, onError?: (err: unknown) => void}} options
 * @returns {{ stop: () => void, runNow: () => Promise<void> }}
 */
export function startPollLoop(task, {
  baseMs,
  maxMs = DEFAULT_MAX_POLL_DELAY_MS,
  now = Date.now,
  doc = typeof document !== 'undefined' ? document : null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
} = {}) {
  let stopped = false;
  let timer = null;
  let failures = 0;
  let lastAttemptAt = 0;
  let running = null;

  const hidden = () => doc?.hidden === true;

  function schedule() {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    const delay = nextPollDelay({ baseMs, consecutiveFailures: failures, maxMs });
    timer = setTimer(onTimer, delay);
  }

  function onTimer() {
    timer = null;
    if (stopped) return;
    if (shouldSkipPoll({ hidden: hidden() })) {
      // Oculta: nao busca; o visibilitychange faz o catch-up.
      schedule();
      return;
    }
    void runNow();
  }

  async function runNow() {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      try {
        await task();
        failures = 0;
      } catch (err) {
        failures += 1;
        onError(err);
      } finally {
        lastAttemptAt = now();
        running = null;
        schedule();
      }
    })();
    return running;
  }

  function onVisibility() {
    if (stopped || hidden()) return;
    // Catch-up so quando o ultimo ciclo ja venceu (respeita o backoff).
    const due = nextPollDelay({ baseMs, consecutiveFailures: failures, maxMs });
    if (now() - lastAttemptAt >= due) void runNow();
  }

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibility);
  }
  void runNow();

  return {
    runNow,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}
