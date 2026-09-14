// Tutorial de entrada (substitui o antigo launcher "Escolha a sua missão").
//
// Um card não modal, em passos, que explica a sala antes de o operador sair
// clicando: CAMADAS DE DADOS e PESQUISA DE LOCALIZAÇÃO têm o destaque, os
// ajustes da tela (estilos, HUD, atalhos) vêm por último e mais discretos.
// Ele NÃO liga camada nenhuma nem grava preferência: os dois botões de ação
// ("Abrir o painel de camadas", "Experimentar a busca") fazem exatamente o que
// o clique do operador faria no próprio painel.
//
// SHOW POLICY. O tutorial não é one-shot: volta a cada sessão nova até o
// operador dizer o contrário.
//
//   - um link compartilhado nunca o vê — o autor já escolheu a vista;
//   - `?welcome=0` suprime, `?welcome=1` reapresenta (vence as DUAS
//     supressões, para suporte e demonstração);
//   - "Não mostrar de novo" grava a supressão DURÁVEL — só essa marca impede
//     a volta;
//   - qualquer outro fechamento (Concluir, Pular, ESC) grava só a flag de
//     SESSÃO: some nesta aba e volta na próxima sessão.
//
// As chaves mudaram de `first-run-mission` para `first-run-tour`: quem
// suprimiu o card de missões ainda não viu este tutorial.

/** Supressão durável. Escrita SÓ pela caixa "Não mostrar de novo". */
export const FIRST_RUN_STORAGE_KEY = 'gev:first-run-tour:v1';
/** Dispensa por sessão. Escrita por todo fechamento; em sessionStorage. */
export const FIRST_RUN_SESSION_KEY = 'gev:first-run-tour-session:v1';

/**
 * Passos, na ordem. `targets` são os elementos da página realçados enquanto o
 * passo está na tela; `minor` marca o passo de menor ênfase.
 * @type {ReadonlyArray<{id: string, targets: ReadonlyArray<string>, minor?: boolean}>}
 */
export const FIRST_RUN_TOUR_STEPS = Object.freeze([
  Object.freeze({ id: 'inicio', targets: Object.freeze([]) }),
  Object.freeze({ id: 'camadas', targets: Object.freeze(['#data-panel']) }),
  Object.freeze({ id: 'localizacao', targets: Object.freeze(['#location-bar']) }),
  Object.freeze({ id: 'preferencias', targets: Object.freeze(['#control-panel', '#pp-toggles']), minor: true }),
]);

/** Classe posta nos alvos do passo atual. */
export const TOUR_HIGHLIGHT_CLASS = 'tour-highlight';

/**
 * Estado da navegação para um índice de passo (já limitado ao intervalo).
 * @param {number} index
 * @param {number} [total]
 * @returns {{index: number, canBack: boolean, isLast: boolean, counter: string, nextLabel: string}}
 */
export function tourNavState(index, total = FIRST_RUN_TOUR_STEPS.length) {
  const safeTotal = Math.max(1, Math.trunc(total) || 1);
  const raw = Number.isFinite(index) ? Math.trunc(index) : 0;
  const clamped = Math.min(Math.max(raw, 0), safeTotal - 1);
  const isLast = clamped === safeTotal - 1;
  return {
    index: clamped,
    canBack: clamped > 0,
    isLast,
    counter: `${clamped + 1} / ${safeTotal}`,
    nextLabel: clamped === 0 ? 'Começar' : isLast ? 'Concluir' : 'Próximo',
  };
}

/*
 * STORAGE ACCESS IS LAZY AND GUARDED — NEVER A DEFAULT PARAMETER.
 *
 * `globalThis.localStorage` is a GETTER, and in Safari's private mode (and under
 * some enterprise policies) reading it THROWS SecurityError. A default parameter
 * like `storage = globalThis.localStorage` evaluates that getter before the
 * function body starts, so it throws outside every try/catch this module has —
 * the exception escapes, initFirstRunExperience never runs, and the tutorial
 * silently never appears. That is the exact opposite of failing open.
 */

/**
 * Resolve a Web Storage area without letting a hostile getter escape.
 * @param {'local'|'session'} kind
 * @param {object|null|undefined} injected Explicit store; `undefined` means "use the global".
 */
function resolveStore(kind, injected) {
  if (injected !== undefined) return injected;
  try {
    return kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Read one key, treating every failure as "nothing stored". */
function readStored(kind, injected, key) {
  try {
    return resolveStore(kind, injected)?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one key, best-effort. Never throws; REPORTS whether the value landed.
 * @returns {boolean}
 */
function writeStored(kind, injected, key, value) {
  try {
    const store = resolveStore(kind, injected);
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove one key, best-effort. @returns {boolean} */
function removeStored(kind, injected, key) {
  try {
    const store = resolveStore(kind, injected);
    if (typeof store?.removeItem !== 'function') return false;
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the tutorial belongs in this page load.
 * @param {object} input
 * @param {boolean} [input.hasShareState]
 * @param {{getItem: Function}|null} [input.storage] Durable (localStorage).
 * @param {{getItem: Function}|null} [input.sessionStorageRef] Per-session.
 * @param {{search?: string}|null} [input.location]
 * @returns {boolean}
 */
export function shouldShowFirstRun({
  hasShareState = false,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  if (hasShareState) return false;
  const params = new URLSearchParams(location?.search || '');
  if (params.get('welcome') === '0') return false;
  if (params.get('welcome') === '1') return true;
  if (readStored('local', storage, FIRST_RUN_STORAGE_KEY) === 'suppressed') return false;
  if (readStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY) === 'dismissed') return false;
  return true;
}

/**
 * Write (or clear) the durable "não mostrar de novo" suppression.
 * @returns {boolean} true if the durable state now matches what was asked.
 */
export function setFirstRunSuppressed(suppressed, storage) {
  return suppressed
    ? writeStored('local', storage, FIRST_RUN_STORAGE_KEY, 'suppressed')
    : removeStored('local', storage, FIRST_RUN_STORAGE_KEY);
}

/** Record that this browser session has seen and closed the tutorial. */
export function rememberFirstRunSessionDismissed(sessionStorageRef) {
  writeStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY, 'dismissed');
}

/**
 * Body classes that mean "another surface owns the screen". Each of these also
 * hides the card in CSS, and the observer below turns that into a yield.
 */
export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([
  'cockpit-mode',
  'scene-playback-mode',
  'recording-mode',
  'ui-clean-view',
]);

/**
 * Is some other surface currently claiming the screen?
 * @param {Document} [documentRef]
 * @returns {boolean}
 */
export function exclusiveSurfaceActive(documentRef = globalThis.document) {
  const list = documentRef?.body?.classList;
  if (!list) return false;
  return EXCLUSIVE_SURFACE_CLASSES.some((name) => list.contains(name));
}

/**
 * Wire and reveal the tutorial.
 * @param {object} input
 * @param {object} [input.styleManager] Initialized StyleManager (share-state check).
 * @param {{openLayers?: Function, openSearch?: Function}} [input.actions]
 * @param {Document} [input.documentRef]
 * @param {Storage} [input.storage]
 * @param {Storage} [input.sessionStorageRef]
 * @param {Location} [input.location]
 * @returns {null|{dismiss: Function, isTopmost: Function, goTo: Function}}
 */
export function initFirstRunExperience({
  styleManager,
  actions = {},
  documentRef = globalThis.document,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  const root = documentRef?.getElementById?.('first-run-launcher');
  if (!root || root.dataset.initialized === 'true') return null;
  root.dataset.initialized = 'true';

  if (!shouldShowFirstRun({
    hasShareState: styleManager?.hasShareState,
    storage,
    sessionStorageRef,
    location,
  })) {
    root.remove();
    return null;
  }

  const status = root.querySelector('[data-first-run-status]');
  const suppressBox = root.querySelector('[data-first-run-suppress]');
  const counter = root.querySelector('[data-tour-counter]');
  const backBtn = root.querySelector('[data-tour-back]');
  const nextBtn = root.querySelector('[data-tour-next]');
  const skipBtn = root.querySelector('[data-tour-skip]');
  const dots = [...root.querySelectorAll('.tour-dots > span')];
  const sections = FIRST_RUN_TOUR_STEPS.map((step) => root.querySelector(`[data-tour-step="${step.id}"]`));
  const previouslyFocused = documentRef.activeElement;
  let current = 0;
  let highlighted = [];
  let closing = false;

  const focusables = () => [
    ...root.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])'),
  ].filter((node) => !node.hasAttribute('disabled') && node.getClientRects().length > 0);

  /**
   * Is something painted OVER the card? The attribution lightbox and the
   * shortcuts help are full-screen overlays above this card that announce
   * themselves with NO body class. Hit-testing the card's own centre answers it
   * for ANY overlay. Inconclusive answers count as UNCOVERED on purpose.
   */
  const coveredByOverlay = () => {
    if (typeof documentRef.elementFromPoint !== 'function') return false;
    const rect = root.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    try {
      const hit = documentRef.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return Boolean(hit) && !root.contains(hit);
    } catch {
      return false;
    }
  };

  const isTopmost = () => root.isConnected
    && root.classList.contains('visible')
    && root.getClientRects().length > 0
    && !coveredByOverlay();

  const clearHighlight = () => {
    for (const node of highlighted) node.classList?.remove(TOUR_HIGHLIGHT_CLASS);
    highlighted = [];
  };

  const applyHighlight = (step) => {
    clearHighlight();
    for (const selector of step.targets) {
      const node = documentRef.querySelector?.(selector);
      if (!node) continue;
      node.classList.add(TOUR_HIGHLIGHT_CLASS);
      highlighted.push(node);
    }
  };

  const goTo = (index, { focus = true } = {}) => {
    if (closing) return;
    const nav = tourNavState(index);
    current = nav.index;
    sections.forEach((section, i) => {
      if (section) section.hidden = i !== current;
    });
    const heading = sections[current]?.querySelector('h2');
    if (heading?.id) root.setAttribute('aria-labelledby', heading.id);
    root.dataset.step = FIRST_RUN_TOUR_STEPS[current].id;
    if (counter) counter.textContent = nav.counter;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === current));
    if (backBtn) backBtn.hidden = !nav.canBack;
    if (nextBtn) nextBtn.textContent = nav.nextLabel;
    if (status) status.textContent = '';
    if (root.classList.contains('visible')) applyHighlight(FIRST_RUN_TOUR_STEPS[current]);
    if (focus) nextBtn?.focus?.({ preventScroll: true });
  };

  const dismiss = ({ restoreFocus = true } = {}) => {
    if (closing) return;
    closing = true;
    clearHighlight();
    rememberFirstRunSessionDismissed(sessionStorageRef);
    root.classList.remove('visible');
    root.setAttribute('aria-hidden', 'true');
    documentRef.removeEventListener('keydown', onKeyDown, true);
    surfaceObserver?.disconnect();
    const remove = () => root.remove();
    root.addEventListener('transitionend', remove, { once: true });
    // `transitionend` never fires under prefers-reduced-motion (no transition),
    // so a bounded fallback is what actually removes the node there.
    globalThis.setTimeout?.(remove, 400);
    if (!restoreFocus) return;
    if (typeof previouslyFocused?.focus === 'function' && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    } else {
      documentRef.body?.focus?.({ preventScroll: true });
    }
  };

  const onNext = () => {
    if (tourNavState(current).isLast) dismiss();
    else goTo(current + 1);
  };

  const onAction = (event) => {
    const kind = event.currentTarget?.dataset?.tourAction;
    const run = kind === 'layers' ? actions.openLayers : kind === 'search' ? actions.openSearch : null;
    if (typeof run !== 'function') return;
    try {
      run();
    } catch (error) {
      console.warn('[Tutorial] ação falhou:', kind, error);
      if (status) status.textContent = 'Não foi possível abrir agora; use o painel diretamente.';
    }
  };

  const onSuppressChange = (event) => {
    const box = event.currentTarget;
    const wanted = Boolean(box?.checked);
    if (setFirstRunSuppressed(wanted, storage)) return;
    // A box left checked after a refused write promises "never again" about a
    // tutorial that is guaranteed to come back next session.
    if (box) box.checked = !wanted;
    if (status) status.textContent = 'Este navegador está bloqueando o armazenamento; a preferência não foi salva.';
  };

  function onKeyDown(event) {
    // THE ARBITRATION RULE: never consume input for a card nobody can see.
    if (closing || !isTopmost()) return;
    // A key another surface already handled is not ours.
    if (event.defaultPrevented) return;
    // Non-modal: while the operator is working on the page (the search field
    // the tutorial just opened, a layer row), keys belong to the page.
    const active = documentRef.activeElement;
    const focusInCard = root.contains(active);
    const focusIdle = !active || active === documentRef.body;
    if (!focusInCard && !focusIdle) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (active?.tagName === 'INPUT') return;
      event.preventDefault();
      if (event.key === 'ArrowRight') onNext();
      else goTo(current - 1);
      return;
    }
    if (event.key !== 'Tab' || !focusInCard) return;
    // Keep Tab cycling inside the card while focus is in it; the page stays
    // live to the mouse, so this stops short of aria-modal.
    const order = focusables();
    if (!order.length) return;
    const first = order[0];
    const last = order[order.length - 1];
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  nextBtn?.addEventListener('click', onNext);
  backBtn?.addEventListener('click', () => goTo(current - 1));
  skipBtn?.addEventListener('click', () => dismiss());
  for (const button of root.querySelectorAll('[data-tour-action]')) {
    button.addEventListener('click', onAction);
  }
  suppressBox?.addEventListener('change', onSuppressChange);
  // Capture phase: the app binds its own global hotkeys on document.
  documentRef.addEventListener('keydown', onKeyDown, true);

  goTo(0, { focus: false });

  let revealed = false;
  const reveal = () => {
    if (revealed || closing) return;
    revealed = true;
    root.hidden = false;
    globalThis.requestAnimationFrame?.(() => {
      if (closing) return;
      root.classList.add('visible');
      applyHighlight(FIRST_RUN_TOUR_STEPS[current]);
      nextBtn?.focus?.({ preventScroll: true });
    });
  };

  /*
   * ESC ARBITRATION — the tutorial never competes for the key. Every exclusive
   * surface announces itself with a body class that already hides this card,
   * so one observer turns "something else took the screen" into "step aside
   * for this session". If a surface is already up, the tutorial waits.
   */
  const yieldToExclusiveSurface = () => {
    if (closing) return;
    dismiss({ restoreFocus: false });
  };

  /*
   * ACCEPTED, DELIBERATELY NOT TIMED OUT: a surface class that never clears
   * means the tutorial never appears in that page load. None of the four
   * classes is restored at startup, so an already-blocked init is an error
   * path, while a long recording or clean-view session is ordinary; a "reveal
   * anyway" timer would punch through a recording. Documented in
   * docs/CURRENT-STATE.md.
   */
  const syncToExclusiveSurfaces = () => {
    if (closing) return;
    const blocked = exclusiveSurfaceActive(documentRef);
    if (revealed && blocked) yieldToExclusiveSurface();
    else if (!revealed && !blocked) reveal();
  };

  const surfaceObserver = typeof globalThis.MutationObserver === 'function'
    ? new globalThis.MutationObserver(syncToExclusiveSurfaces)
    : null;
  // Attributes only, no subtree: a class watch on one element.
  if (documentRef.body) {
    surfaceObserver?.observe(documentRef.body, { attributes: true, attributeFilter: ['class'] });
  }
  syncToExclusiveSurfaces();

  return { dismiss, isTopmost, goTo };
}
