/**
 * Teclado virtual no celular: o navegador encolhe só a viewport visual, e o
 * que é position:fixed no rodapé (dock, bandeja BUSCAR) fica atrás do
 * teclado. Publica a altura coberta em --kb-inset no <html>; o CSS do celular
 * (style.css, bloco final) soma essa altura ao rodapé.
 *
 * Só conta como teclado com um campo do dock focado (as buscas da BUSCAR) e
 * sem zoom de pinça: a barra de ferramentas do navegador, um zoom ou o filtro
 * do painel de camadas (que fica no topo) não movem o rodapé.
 */

const EDITAVEL = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]';

/**
 * @param {Window} [win]
 * @returns {void}
 */
export function initKeyboardInset(win = globalThis.window) {
  const vv = win?.visualViewport;
  if (!vv) return;
  const doc = win.document;
  const root = doc.documentElement;
  let ultimo = -1;
  const atualizar = () => {
    const coberto = root.clientHeight - (vv.height + vv.offsetTop);
    const ativo = doc.activeElement;
    const digitando = ativo?.matches?.(EDITAVEL) && ativo.closest('#command-dock') && Math.abs(vv.scale - 1) < 0.01;
    const inset = digitando && coberto > 80 ? Math.round(coberto) : 0;
    if (inset === ultimo) return;
    ultimo = inset;
    root.style.setProperty('--kb-inset', `${inset}px`);
  };
  vv.addEventListener('resize', atualizar);
  vv.addEventListener('scroll', atualizar);
  doc.addEventListener('focusin', atualizar);
  doc.addEventListener('focusout', () => win.setTimeout(atualizar, 0));
  atualizar();
}
