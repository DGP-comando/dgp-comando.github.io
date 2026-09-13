// src/data/shortcutsKeymap.js
//
// Mapa de atalhos de teclado do DGP Comando + despachante puro. Sem DOM:
// recebe um objeto parecido com KeyboardEvent e decide qual ação disparar.
//
// Teclas JÁ OCUPADAS pelo God's Eye View (ui.js), que este mapa evita:
//   1-7 estilos · H HUD · O órbita · V visão limpa · F painel de dados
//   D detecção · C CCTV/cockpit · Espaço push-to-talk · Esc
//   Q W E R T pontos de interesse quando a fileira de uma cidade está aberta
// Por isso: tela cheia em M (F ocupado), vigilância em A (V ocupado) e
// câmera do Paraná em P (R colide com a fileira QWERT).

export const DEFAULT_KEYMAP = Object.freeze({
  l: 'toggleLayers',
  b: 'openSearch',
  p: 'resetCamera',
  m: 'toggleFullscreen',
  a: 'toggleWatch',
  '?': 'toggleHelp',
});

export const RESERVED_GEV_KEYS = Object.freeze([
  '1', '2', '3', '4', '5', '6', '7', 'h', 'o', 'v', 'f', 'd', 'c', 'q', 'w', 'e', 'r', 't', ' ', 'escape',
]);

export const SHORTCUT_HELP = Object.freeze([
  { key: 'L', action: 'toggleLayers', label: 'Abrir ou recolher o painel de camadas' },
  { key: 'B', action: 'openSearch', label: 'Buscar município (localização)' },
  { key: 'P', action: 'resetCamera', label: 'Voltar a câmera para o Paraná' },
  { key: 'M', action: 'toggleFullscreen', label: 'Tela cheia' },
  { key: 'A', action: 'toggleWatch', label: 'Painel de vigilância de áreas' },
  { key: '?', action: 'toggleHelp', label: 'Mostrar ou ocultar esta ajuda' },
  { key: 'Esc', action: 'closeHelp', label: 'Fechar a ajuda' },
]);

export const GEV_SHORTCUT_HELP = Object.freeze([
  { key: '1-7', label: 'Estilos visuais' },
  { key: 'H', label: 'HUD' },
  { key: 'O', label: 'Órbita' },
  { key: 'V', label: 'Visão limpa' },
  { key: 'F', label: 'Mostrar ou ocultar painel de dados' },
  { key: 'D', label: 'Modo de detecção' },
  { key: 'C', label: 'CCTV / cockpit' },
]);

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable], [contenteditable="true"]';

/** true quando o foco está num campo onde a tecla deve digitar, não disparar atalho. */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = String(target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (typeof target.closest === 'function') {
    try {
      const host = target.closest(EDITABLE_SELECTOR);
      if (host && host.getAttribute?.('contenteditable') !== 'false') return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Nome da ação para o evento, ou null.
 * Ignora: repeat, composição IME, evento já tratado, Ctrl/Alt/Meta,
 * Shift com letras (Shift só vale para "?"), alvo editável.
 */
export function resolveShortcut(event, { keymap = DEFAULT_KEYMAP, helpOpen = false } = {}) {
  if (!event || typeof event.key !== 'string') return null;
  if (event.isComposing || event.defaultPrevented) return null;
  if (event.key === 'Escape') return helpOpen ? 'closeHelp' : null;
  if (event.repeat) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (isEditableTarget(event.target)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.shiftKey && key !== '?') return null;
  return Object.prototype.hasOwnProperty.call(keymap, key) ? keymap[key] : null;
}

/**
 * Cria o handler de keydown. actions: { toggleLayers() {...}, ... }.
 * Só consome o evento (preventDefault + stopImmediatePropagation) quando há
 * callback para a ação; retorna o nome da ação tratada ou null.
 */
export function createShortcutDispatcher({ actions = {}, keymap = DEFAULT_KEYMAP, isHelpOpen = () => false } = {}) {
  return function dispatch(event) {
    const action = resolveShortcut(event, { keymap, helpOpen: Boolean(isHelpOpen()) });
    if (!action || typeof actions[action] !== 'function') return null;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    try {
      actions[action](event);
    } catch (err) {
      console.warn('[DGP:atalhos] ação falhou:', action, err);
    }
    return action;
  };
}
