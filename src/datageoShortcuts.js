// src/datageoShortcuts.js
//
// Atalhos de teclado do DGP Comando + sobreposição de ajuda (tecla "?").
// A lógica de teclas vive em data/shortcutsKeymap.js (pura, testada); aqui
// ficam só o listener, as ações padrão de DOM e o overlay.
//
// Ações padrão (sobrescrevíveis via `actions`):
//   toggleLayers     recolhe/abre #data-panel pelo botão de colapso do próprio GEV
//   openSearch       abre a barra LOCALIZAÇÃO e foca #location-search
//   toggleFullscreen Fullscreen API
//   toggleHelp/closeHelp overlay de ajuda
// Sem padrão (o orquestrador injeta): resetCamera, toggleWatch.

import {
  DEFAULT_KEYMAP,
  GEV_SHORTCUT_HELP,
  SHORTCUT_HELP,
  createShortcutDispatcher,
} from './data/shortcutsKeymap.js';

function injectStyles() {
  if (document.getElementById('datageo-shortcuts-style')) return;
  const style = document.createElement('style');
  style.id = 'datageo-shortcuts-style';
  style.textContent = `
    #datageo-shortcuts-help {
      position: fixed;
      inset: 0;
      z-index: 190;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(1, 5, 10, 0.55);
      font-family: 'JetBrains Mono', monospace;
      color: #cbd5e1;
    }
    #datageo-shortcuts-help.open { display: flex; }
    #datageo-shortcuts-help .sc-card {
      width: min(440px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      overflow-y: auto;
      padding: 14px 16px 12px;
      background: rgba(3, 10, 18, 0.94);
      border: 1px solid rgba(34, 211, 238, 0.35);
      border-radius: 10px;
      font-size: 11px;
      line-height: 1.55;
    }
    #datageo-shortcuts-help .sc-title {
      display: flex; justify-content: space-between; align-items: center;
      color: #22d3ee; letter-spacing: 0.12em; font-size: 12px; margin-bottom: 8px;
    }
    #datageo-shortcuts-help .sc-close {
      background: none; border: none; color: #64748b; font-size: 15px; cursor: pointer;
    }
    #datageo-shortcuts-help .sc-close:hover { color: #22d3ee; }
    #datageo-shortcuts-help h3 {
      color: #7dd3fc; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;
      border-bottom: 1px dashed rgba(125, 211, 252, 0.25); padding-bottom: 3px; margin: 10px 0 6px;
    }
    #datageo-shortcuts-help .sc-row { display: flex; gap: 10px; align-items: baseline; margin: 4px 0; }
    #datageo-shortcuts-help kbd {
      flex: 0 0 auto; min-width: 34px; text-align: center; padding: 1px 6px;
      font-family: inherit; font-size: 10px; color: #22d3ee;
      border: 1px solid rgba(34, 211, 238, 0.4); border-radius: 4px; background: rgba(34, 211, 238, 0.06);
    }
    #datageo-shortcuts-help .sc-gev kbd { color: #94a3b8; border-color: rgba(148, 163, 184, 0.35); background: none; }
    #datageo-shortcuts-help .sc-foot { color: #475569; font-size: 9px; margin-top: 10px; }
  `;
  document.head.appendChild(style);
}

function row(keyLabel, text, extraClass = '') {
  const div = document.createElement('div');
  div.className = `sc-row ${extraClass}`.trim();
  const kbd = document.createElement('kbd');
  kbd.textContent = keyLabel;
  const span = document.createElement('span');
  span.textContent = text;
  div.append(kbd, span);
  return div;
}

function buildHelp(onClose) {
  const overlay = document.createElement('div');
  overlay.id = 'datageo-shortcuts-help';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Atalhos de teclado');

  const card = document.createElement('div');
  card.className = 'sc-card';
  const title = document.createElement('div');
  title.className = 'sc-title';
  title.textContent = 'ATALHOS DE TECLADO';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sc-close';
  close.title = 'Fechar (Esc)';
  close.setAttribute('aria-label', 'Fechar ajuda');
  close.textContent = '✕';
  close.addEventListener('click', onClose);
  title.appendChild(close);

  const dgp = document.createElement('h3');
  dgp.textContent = 'DGP Comando';
  const gev = document.createElement('h3');
  gev.textContent = 'Globo e visualização';
  const foot = document.createElement('div');
  foot.className = 'sc-foot';
  foot.textContent = 'Atalhos não disparam enquanto você digita em um campo.';

  card.append(
    title,
    dgp,
    ...SHORTCUT_HELP.map((h) => row(h.key, h.label)),
    gev,
    ...GEV_SHORTCUT_HELP.map((h) => row(h.key, h.label, 'sc-gev')),
    foot,
  );
  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onClose();
  });
  return overlay;
}

function defaultToggleLayers() {
  const panel = document.getElementById('data-panel');
  if (!panel) return;
  // "F" do GEV esconde o painel inteiro (classe active); L sempre o traz de volta.
  if (!panel.classList.contains('active')) {
    panel.classList.add('active');
    if (!panel.classList.contains('collapsed')) return;
  }
  const btn = panel.querySelector('.panel-collapse-btn[data-collapse-target="data-panel"]');
  if (btn) btn.click();
  else panel.classList.toggle('collapsed');
  if (!panel.classList.contains('collapsed')) {
    panel.querySelector('#data-toggles button, #data-toggles [tabindex]')?.focus({ preventScroll: true });
  }
}

function defaultOpenSearch() {
  const input = document.getElementById('location-search');
  if (!input) return;
  const bar = document.getElementById('location-bar');
  if (!input.classList.contains('expanded')) {
    // O clique no toggle expande o input e borbulha até #location-bar, que abre a gaveta.
    const toggle = document.getElementById('search-toggle');
    if (toggle) toggle.click();
    else input.classList.add('expanded');
  } else if (bar?.classList.contains('collapsed')) {
    bar.click();
  }
  input.focus({ preventScroll: true });
  input.select?.();
}

function defaultToggleFullscreen() {
  const doc = document;
  if (doc.fullscreenElement) {
    doc.exitFullscreen?.().catch?.(() => {});
  } else {
    doc.documentElement.requestFullscreen?.().catch?.((err) => {
      console.warn('[DGP:atalhos] tela cheia recusada:', err?.message ?? err);
    });
  }
}

/**
 * initDatageoShortcuts({ actions, keymap }) -> { destroy, openHelp, closeHelp, isHelpOpen }
 * actions: { resetCamera, toggleWatch, ...overrides }
 */
export function initDatageoShortcuts({ actions = {}, keymap = DEFAULT_KEYMAP } = {}) {
  injectStyles();
  let helpOpen = false;
  let lastFocus = null;

  const overlay = buildHelp(() => closeHelp());
  document.body.appendChild(overlay);

  function openHelp() {
    helpOpen = true;
    lastFocus = document.activeElement;
    overlay.classList.add('open');
    overlay.querySelector('.sc-close')?.focus({ preventScroll: true });
  }

  function closeHelp() {
    if (!helpOpen) return;
    helpOpen = false;
    overlay.classList.remove('open');
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      lastFocus.focus({ preventScroll: true });
    }
    lastFocus = null;
  }

  const merged = {
    toggleLayers: defaultToggleLayers,
    openSearch: defaultOpenSearch,
    toggleFullscreen: defaultToggleFullscreen,
    toggleHelp: () => (helpOpen ? closeHelp() : openHelp()),
    closeHelp,
    ...actions,
  };

  const dispatchKey = createShortcutDispatcher({ actions: merged, keymap, isHelpOpen: () => helpOpen });
  // Com o launcher de missões aberto ele é a superfície do topo: os atalhos
  // não agem na página por trás dele.
  const dispatch = (event) => {
    const launcher = document.getElementById('first-run-launcher');
    if (launcher && !launcher.hidden && !helpOpen) return undefined;
    return dispatchKey(event);
  };
  // Captura na window: roda antes dos listeners do GEV em document, então
  // o Esc que fecha a ajuda não fecha também a ficha ou o launcher.
  window.addEventListener('keydown', dispatch, true);

  return {
    openHelp,
    closeHelp,
    isHelpOpen: () => helpOpen,
    destroy() {
      window.removeEventListener('keydown', dispatch, true);
      overlay.remove();
    },
  };
}
