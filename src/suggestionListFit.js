/**
 * Listas de sugestão da BUSCAR (município e produtor) abrem para CIMA a
 * partir do campo, no dock colado à base da tela. Num celular baixo (ou com o
 * teclado aberto) a altura fixa da lista passava do topo da tela. Limita a
 * altura ao espaço entre o topo útil e o campo; a lista rola por dentro.
 *
 * @param {HTMLElement|null} list - <ul> visível, ancorada acima do campo.
 * @param {{gap?: number, min?: number}} [opts]
 * @returns {void}
 */
export function fitSuggestionListAbove(list, { gap = 8, min = 96 } = {}) {
  if (!list || list.hidden) return;
  list.style.maxHeight = '';
  const anchor = list.parentElement;
  if (!anchor) return;
  const vv = globalThis.visualViewport;
  // Topo útil: o da viewport visual, e abaixo do título (que no celular já
  // desconta a barra de status / notch do PWA).
  const titleTop = globalThis.document?.getElementById('title-bar')?.getBoundingClientRect().top ?? 0;
  const topo = Math.max((vv?.offsetTop ?? 0) + gap, titleTop);
  const disponivel = anchor.getBoundingClientRect().top - gap - topo;
  const atual = list.getBoundingClientRect().height;
  if (atual > disponivel) list.style.maxHeight = `${Math.max(min, Math.floor(disponivel))}px`;
}
