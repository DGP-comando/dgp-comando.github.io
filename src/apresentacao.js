// Apresentação guiada do DataGeo: o tutorial de entrada transformado em roteiro
// de demonstração. Só a seta → avança; cada passo EXECUTA a funcionalidade que
// descreve (abre o painel, liga camadas, voa ao município, abre a ficha) e o
// roteiro fecha com um estudo situacional de um município.
//
// Liga com `?apresentacao=1` (município padrão) ou `?apresentacao=<IBGE>`.
// Reusa o card e o CSS do tutorial (#first-run-launcher); o tutorial em si
// não aparece nessa sessão. Não grava preferência nenhuma.

import { tourNavState, TOUR_HIGHLIGHT_CLASS } from './firstRunExperience.js';
import { municipioByIbge } from './municipioSearch.js';
import { closeFicha } from './datageoFicha.js';

/** Prudentópolis: faxinais, agricultura familiar forte, escritório do IDR. */
export const MUNICIPIO_PADRAO = '4120606';

/**
 * Código IBGE pedido na URL, ou null quando a apresentação não foi pedida.
 * @param {{search?: string}|null} [location]
 * @returns {string|null}
 */
export function apresentacaoPedida(location = globalThis.location) {
  const valor = new URLSearchParams(location?.search || '').get('apresentacao');
  if (valor === null) return null;
  return /^\d{7}$/.test(valor) ? valor : MUNICIPIO_PADRAO;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Roteiro. `camadas` é o conjunto EXATO de camadas gerenciadas que fica ligado
 * no passo (as outras do roteiro desligam), então voltar um passo também volta
 * o mapa. `entrar` roda ao chegar no passo; `alvos` ganham o realce do tutorial.
 * @param {{code: string, name: string}} municipio
 */
export function roteiro(municipio) {
  const nome = esc(municipio.name);
  const prefixo = esc(municipio.name.slice(0, 4));
  return Object.freeze([
    {
      id: 'inicio',
      titulo: 'DataGeo Paraná · sala de situação',
      html: `
        <p>Os 399 municípios do Paraná numa sala de comando. Dados públicos, pipelines próprios, tudo ao vivo.</p>
        <ol class="tour-agenda">
          <li><strong>Camadas de dados</strong><small>o que o mapa sabe mostrar</small></li>
          <li><strong>Visão do estado</strong><small>limites, tempo real, logística</small></li>
          <li><strong>Estudo situacional</strong><small>${nome}: ficha, território, agricultura familiar, água, riscos</small></li>
          <li><strong>Vigilância e compartilhamento</strong><small>o que fica rodando depois</small></li>
        </ol>`,
      camadas: [],
      entrar: ({ styleManager }) => { closeFicha(); styleManager.resetToParanaView?.(); },
    },
    {
      id: 'camadas',
      icone: 'layers',
      titulo: 'Camadas de dados',
      alvos: ['#data-panel'],
      html: `
        <p>Tudo o que aparece no mapa sai do painel <b>CAMADAS DE DADOS</b>, à esquerda.</p>
        <ul class="tour-points">
          <li>13 grupos temáticos: limites, territórios e povos, agricultura familiar e CAR, IDR, Defesa Agropecuária, logística, transporte, energia, saúde e proteção social, clima, água, ambiente, riscos.</li>
          <li>Cada linha mostra a fonte, a contagem e a última atualização.</li>
          <li>A caixa filtra pelo nome; os três botões mudam a exibição (grupos, lista, grade).</li>
        </ul>`,
      camadas: [],
      entrar: ({ openLayersPanel, dataManager }) => { openLayersPanel(); dataManager.setPanelView?.('grupos'); },
    },
    {
      id: 'estado',
      icone: 'map',
      titulo: 'Visão do estado · a rede no território',
      html: `
        <ul class="tour-points">
          <li>As <b>regionais do IDR</b> e as <b>unidades</b> (escritórios municipais e regionais) sobre a malha de municípios.</li>
          <li>Os <b>escritórios da ADAPAR</b> (22 regionais e 126 locais, com circunscrição e contato) e as <b>CEASAs</b>.</li>
          <li>Passe o mouse num município para o resumo; clique para abrir a ficha completa. Clique num escritório do IDR para ver os extensionistas lotados.</li>
        </ul>`,
      camadas: ['datageo-regionais-idr', 'datageo-unidades-idr', 'datageo-adapar-unidades', 'datageo-ceasas'],
    },
    {
      id: 'tempo-real',
      icone: 'sensors',
      titulo: 'Monitoramento em tempo real',
      html: `
        <ul class="tour-points">
          <li><b>Estações INMET</b> (temperatura e umidade agora), <b>nível dos rios</b> (ANA), <b>alertas CEMADEN</b>, <b>focos de calor</b> (FIRMS) e <b>incidentes ativos</b>.</li>
          <li>Pipelines próprios atualizam as bases sozinhos; o mapa recarrega sem intervenção.</li>
        </ul>`,
      camadas: ['datageo-clima', 'datageo-rios', 'datageo-cemaden', 'local-firms', 'datageo-incidentes'],
    },
    {
      id: 'logistica',
      icone: 'local_shipping',
      titulo: 'Logística do agro',
      html: `
        <ul class="tour-points">
          <li><b>Rodovias</b> e <b>ferrovias</b>, <b>armazéns</b> (CONAB), <b>CEASAs</b> e os <b>navios</b> no Porto de Paranaguá (posição ao vivo e line-up).</li>
          <li>Linhas de transmissão e distribuição, subestações e usinas ficam no grupo Energia.</li>
        </ul>`,
      camadas: ['datageo-rodovias', 'datageo-ferrovias', 'datageo-armazens', 'datageo-ceasas', 'datageo-maritimo'],
    },
    {
      id: 'localizacao',
      icone: 'travel_explore',
      titulo: 'Pesquisa de localização',
      alvos: ['#location-bar'],
      html: `
        <p>O botão <b>BUSCAR</b>, na barra inferior, leva a câmera a qualquer lugar e encontra produtores (CAF) e extensionistas.</p>
        <ul class="tour-points">
          <li>Digitando "${prefixo}" a lista já sugere os municípios do Paraná; <kbd>Enter</kbd> enquadra o escolhido e abre a ficha.</li>
          <li>Um endereço ou lugar fora da lista também funciona.</li>
          <li><kbd>P</kbd> devolve a câmera ao Paraná inteiro.</li>
        </ul>`,
      camadas: [],
      entrar: ({ openLocationSearch }) => {
        openLocationSearch();
        const input = document.getElementById('location-search');
        if (!input) return;
        input.value = municipio.name.slice(0, 4);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
    },
    {
      id: 'municipio',
      icone: 'description',
      titulo: `Estudo situacional · ${nome}`,
      alvos: ['#datageo-ficha'],
      html: `
        <p>A <b>ficha municipal</b>, à direita, cruza as bases num só lugar:</p>
        <ul class="tour-points">
          <li>Território (agroindústrias, estradas, convênios SEAB), extensionistas e grupos GETEC do IDR, SUSAF, módulo fiscal.</li>
          <li>Agricultura familiar (CAF), população, proteção social, segurança pública.</li>
          <li>Ambiente, clima histórico, outorgas de água, fontes protegidas, hidrologia.</li>
        </ul>`,
      camadas: [],
      entrar: ({ styleManager }) => { styleManager.flyToMunicipioIbge?.(municipio.code); },
    },
    {
      id: 'territorio',
      icone: 'route',
      titulo: 'Território e malha viária',
      html: `
        <ul class="tour-points">
          <li>O botão <b>aproximar</b> (topo) desce ao município e libera as camadas que só aparecem de perto.</li>
          <li><b>Estradas municipais</b>, <b>rurais conveniadas SEAB 2026</b>, rodovias e os <b>imóveis do CAR</b>.</li>
        </ul>`,
      camadas: ['datageo-rodovias', 'datageo-estradas', 'datageo-estradas-conveniadas', 'datageo-car'],
      entrar: ({ styleManager }) => { styleManager.focusSelectedMunicipio?.(); },
    },
    {
      id: 'agricultura-familiar',
      icone: 'agriculture',
      titulo: 'Agricultura familiar e assistência técnica',
      html: `
        <ul class="tour-points">
          <li><b>Famílias do CAF</b> (clique abre o cadastro, com CAR e grupos vinculados).</li>
          <li><b>Cooperativas e associações</b> (CAF PJ) com a rede de filiadas; <b>agroindústrias</b> do cadastro IDR.</li>
          <li>O <b>escritório do IDR</b>: clique num extensionista e a rede de produtores assistidos (GETEC) aparece.</li>
        </ul>`,
      camadas: ['datageo-caf', 'datageo-caf-pj', 'datageo-agroindustrias-idr', 'datageo-unidades-idr'],
    },
    {
      id: 'defesa-agua',
      icone: 'water_drop',
      titulo: 'Defesa agropecuária e água',
      html: `
        <ul class="tour-points">
          <li><b>Propriedades com exploração pecuária</b> e <b>comércio de agrotóxicos</b> (ADAPAR).</li>
          <li><b>Outorgas de uso da água</b> (IAT) e <b>fontes protegidas</b> pelo IDR.</li>
        </ul>`,
      camadas: ['datageo-adapar-exploracoes', 'datageo-adapar-agrotoxicos', 'datageo-outorgas', 'datageo-fontes-protegidas'],
    },
    {
      id: 'ambiente-riscos',
      icone: 'forest',
      titulo: 'Ambiente, clima e riscos',
      html: `
        <ul class="tour-points">
          <li><b>Faxinais</b>, <b>unidades de conservação</b> e <b>focos de calor</b>.</li>
          <li><b>Clima histórico</b> (normal 1990–2019), <b>alertas CEMADEN</b> e o <b>risco territorial</b> (IRTC).</li>
        </ul>`,
      camadas: ['datageo-faxinais', 'datageo-ucs-estaduais', 'local-firms', 'datageo-clima-historico', 'datageo-cemaden', 'datageo-irtc'],
    },
    {
      id: 'vigilancia',
      icone: 'visibility',
      titulo: 'Vigilância',
      alvos: ['#datageo-area-watch'],
      html: `
        <ul class="tour-points">
          <li><b>VIGIAR</b> na ficha põe o município na lista; a cada 5 minutos o sistema procura focos de calor, alertas CEMADEN e incidentes novos.</li>
          <li>Até 10 municípios; o painel exporta o histórico em CSV. Atalho <kbd>A</kbd>.</li>
        </ul>`,
      camadas: ['local-firms', 'datageo-cemaden', 'datageo-incidentes'],
      entrar: ({ areaWatch }) => { areaWatch?.watchMunicipio?.(municipio.code, municipio.name); areaWatch?.open?.(); },
    },
    {
      id: 'encerramento',
      icone: 'share',
      titulo: 'Compartilhar e continuar',
      alvos: ['#top-center-actions'],
      html: `
        <ul class="tour-points">
          <li>O botão de <b>link</b> (topo) copia um endereço com câmera e camadas: quem abre vê exatamente esta tela.</li>
          <li><kbd>?</kbd> lista os atalhos; <kbd>V</kbd> esconde os painéis; <kbd>M</kbd> tela cheia; <kbd>L</kbd> camadas; <kbd>B</kbd> busca.</li>
        </ul>
        <p class="tour-hint">Concluir fecha este roteiro e deixa a sala como está.</p>`,
      camadas: ['local-firms', 'datageo-cemaden', 'datageo-incidentes'],
    },
  ]);
}

/**
 * Monta e revela a apresentação no card do tutorial.
 * @param {object} deps
 * @param {string} deps.ibge
 * @param {object} deps.styleManager
 * @param {object} deps.dataManager
 * @param {object} [deps.areaWatch]
 * @param {Function} deps.openLayersPanel
 * @param {Function} deps.openLocationSearch
 * @returns {null|{goTo: Function, dismiss: Function}}
 */
export function initApresentacao(deps) {
  const root = document.getElementById('first-run-launcher');
  const municipio = municipioByIbge(deps.ibge) || municipioByIbge(MUNICIPIO_PADRAO);
  if (!root || !municipio) return null;

  const passos = roteiro(municipio);
  const gerenciadas = [...new Set(passos.flatMap((p) => p.camadas))];
  const ctx = { ...deps, municipio };

  document.body.classList.add('apresentacao-mode');
  root.querySelector('.first-run-kicker').textContent = 'APRESENTAÇÃO · DATAGEO PR';
  root.querySelector('[data-tour-skip]').textContent = 'Encerrar';
  root.querySelector('.tour-dots').innerHTML = passos.map(() => '<span></span>').join('');
  root.querySelector('.tour-steps').innerHTML = passos.map((p) => `
    <section class="tour-step" data-tour-step="${p.id}" hidden>
      <h2 id="tour-title-${p.id}">${p.icone ? `<span class="material-symbols-outlined" aria-hidden="true">${p.icone}</span>` : ''}${p.titulo}</h2>
      ${p.html}
    </section>`).join('');

  const sections = [...root.querySelectorAll('[data-tour-step]')];
  const dots = [...root.querySelectorAll('.tour-dots > span')];
  const counter = root.querySelector('[data-tour-counter]');
  const backBtn = root.querySelector('[data-tour-back]');
  const nextBtn = root.querySelector('[data-tour-next]');
  let current = 0;
  let highlighted = [];
  let closing = false;

  const realcar = (alvos = []) => {
    for (const node of highlighted) node.classList.remove(TOUR_HIGHLIGHT_CLASS);
    highlighted = alvos.map((sel) => document.querySelector(sel)).filter(Boolean);
    for (const node of highlighted) node.classList.add(TOUR_HIGHLIGHT_CLASS);
  };

  // ponytail: liga/desliga em paralelo e não espera; um passo que falha numa
  // camada (bucket privado sem login) não trava o roteiro.
  const aplicarCamadas = (ligadas) => {
    const on = new Set(ligadas);
    for (const id of gerenciadas) {
      if (!deps.dataManager.layers?.has?.(id)) continue;
      void Promise.resolve(deps.dataManager.setEnabled(id, on.has(id), { origin: 'user' }))
        .catch((err) => console.warn('[Apresentação] camada', id, err));
    }
  };

  const goTo = (index) => {
    if (closing) return;
    const nav = tourNavState(index, passos.length);
    current = nav.index;
    const passo = passos[current];
    sections.forEach((s, i) => { s.hidden = i !== current; });
    root.dataset.step = passo.id;
    root.setAttribute('aria-labelledby', `tour-title-${passo.id}`);
    if (counter) counter.textContent = nav.counter;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === current));
    if (backBtn) backBtn.hidden = !nav.canBack;
    if (nextBtn) nextBtn.textContent = nav.nextLabel;
    try {
      passo.entrar?.(ctx);
    } catch (err) {
      console.warn('[Apresentação] passo falhou:', passo.id, err);
    }
    aplicarCamadas(passo.camadas);
    // A ficha e o painel de vigilância só existem depois da ação do passo.
    requestAnimationFrame(() => realcar(passo.alvos));
  };

  const dismiss = () => {
    if (closing) return;
    closing = true;
    realcar([]);
    document.body.classList.remove('apresentacao-mode');
    document.removeEventListener('keydown', onKeyDown, true);
    root.classList.remove('visible');
    setTimeout(() => root.remove(), 400);
  };

  const onNext = () => (tourNavState(current, passos.length).isLast ? dismiss() : goTo(current + 1));

  function onKeyDown(event) {
    if (closing || event.defaultPrevented) return;
    if (event.key === 'ArrowRight') onNext();
    else if (event.key === 'ArrowLeft') goTo(current - 1);
    else if (event.key === 'Escape') dismiss();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  nextBtn?.addEventListener('click', onNext);
  backBtn?.addEventListener('click', () => goTo(current - 1));
  root.querySelector('[data-tour-skip]')?.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKeyDown, true);

  goTo(0);
  root.hidden = false;
  requestAnimationFrame(() => root.classList.add('visible'));
  return { goTo, dismiss };
}
