// src/datageoTicker.js
//
// Ticker de noticias do Parana (news_items do DataGeo) — faixa fixa no
// rodape, rolagem continua estilo sala de imprensa. Urgencia colore o
// marcador: urgent vermelho, important ambar, normal ciano.
// Fase 2 da fusao (PLANO_FUSAO.md §3): "ticker de noticias" nao e camada
// espacial; vive no chrome do HUD.
//
// Cada manchete com URL http(s) e um link para a pagina fonte (nova aba).
// A faixa continua sem capturar o mouse (o mapa embaixo segue clicavel);
// so os links recebem ponteiro, e a rolagem pausa no hover/foco para dar
// tempo de clicar.

import { fetchNews } from './data/datageoClient.js';
import { startPollLoop } from './data/pollPolicy.js';

const POLL_MS = 5 * 60_000;

const TICKER_PAUSED_KEY = 'datageo:ticker-paused';

const URGENCY_COLORS = {
  urgent: '#ef4444',
  important: '#f59e0b',
  normal: '#22d3ee',
};

function injectStyles() {
  if (document.getElementById('datageo-ticker-style')) return;
  const style = document.createElement('style');
  style.id = 'datageo-ticker-style';
  style.textContent = `
    #datageo-ticker {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      height: 26px;
      display: flex;
      align-items: center;
      background: rgba(3, 10, 18, 0.85);
      border-top: 1px solid rgba(34, 211, 238, 0.25);
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #cbd5e1;
      overflow: hidden;
      z-index: 60;
      pointer-events: none;
    }
    #datageo-ticker .ticker-tag {
      flex: 0 0 auto;
      height: 100%;
      padding: 0 10px;
      font: inherit;
      color: #22d3ee;
      letter-spacing: 0.12em;
      border: 0;
      border-right: 1px solid rgba(34, 211, 238, 0.25);
      background: rgba(3, 10, 18, 0.95);
      z-index: 1;
      cursor: pointer;
      pointer-events: auto;
    }
    #datageo-ticker .ticker-tag:hover { color: #f8fafc; }
    #datageo-ticker .ticker-tag:focus-visible { outline: 1px solid #22d3ee; outline-offset: -2px; }
    /* Clique em PR AO VIVO: para a passagem (a tag esmaece para avisar). */
    #datageo-ticker.paused .ticker-tag { color: #64748b; }
    #datageo-ticker.paused .ticker-scroll { animation-play-state: paused; }
    #datageo-ticker .ticker-track {
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
    }
    #datageo-ticker .ticker-scroll {
      display: inline-block;
      white-space: nowrap;
      padding-left: 100%;
      animation: datageo-ticker-scroll var(--ticker-duration, 90s) linear infinite;
    }
    #datageo-ticker .ticker-item { margin-right: 42px; color: inherit; text-decoration: none; }
    #datageo-ticker a.ticker-item { pointer-events: auto; cursor: pointer; }
    #datageo-ticker a.ticker-item:hover .ticker-title,
    #datageo-ticker a.ticker-item:focus-visible .ticker-title { color: #f8fafc; text-decoration: underline; }
    #datageo-ticker a.ticker-item:focus-visible { outline: 1px solid #22d3ee; outline-offset: 2px; }
    /* O dock inferior (locais · voz · estilos) nasceu antes da faixa e
       descia sobre ela, cobrindo manchetes no centro: sobe a altura da faixa.
       So em telas largas; no celular a pilha inferior ja e apertada e subir
       o dock cobriria Briefing/Vigilancia. */
    @media (min-width: 700px) {
      body:has(#datageo-ticker) #command-dock { bottom: calc(26px + 2vh); }
    }
    #datageo-ticker .ticker-track:hover .ticker-scroll,
    #datageo-ticker .ticker-track:focus-within .ticker-scroll { animation-play-state: paused; }
    #datageo-ticker .ticker-dot { margin-right: 6px; }
    #datageo-ticker .ticker-source { color: #64748b; margin-left: 6px; }
    @keyframes datageo-ticker-scroll {
      from { transform: translateX(0); }
      to { transform: translateX(-100%); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Link da manchete para a pagina fonte, ou null se a URL nao for http(s)
 * (javascript:, data:, relativa, invalida). A URL vem do banco, preenchida
 * por scrapers: nunca vai para o href sem passar por aqui.
 * @param {{url?: string, source?: string}|null} item
 * @returns {{href: string, title: string}|null}
 */
export function newsLink(item) {
  if (typeof item?.url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(item.url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const source = typeof item.source === 'string' ? item.source.trim() : '';
  return {
    href: parsed.href,
    title: source ? `Abrir a notícia em ${source} (nova aba)` : 'Abrir a notícia na página fonte (nova aba)',
  };
}

function render(container, items) {
  const track = container.querySelector('.ticker-scroll');
  if (!track) return;
  track.innerHTML = '';
  for (const item of items) {
    const link = newsLink(item);
    const span = document.createElement(link ? 'a' : 'span');
    span.className = 'ticker-item';
    if (link) {
      span.href = link.href;
      span.target = '_blank';
      span.rel = 'noopener noreferrer';
      span.title = link.title;
    }
    const dot = document.createElement('span');
    dot.className = 'ticker-dot';
    dot.textContent = '●';
    dot.style.color = URGENCY_COLORS[item.urgency ?? 'normal'] ?? URGENCY_COLORS.normal;
    const text = document.createElement('span');
    text.className = 'ticker-title';
    text.textContent = item.title ?? '';
    const source = document.createElement('span');
    source.className = 'ticker-source';
    source.textContent = `[${item.source ?? ''}]`;
    span.append(dot, text, source);
    track.appendChild(span);
  }
  // Duracao proporcional ao conteudo (~6 s por manchete, piso de 60 s).
  track.style.setProperty('--ticker-duration', `${Math.max(60, items.length * 6)}s`);
}

export function initDatageoTicker() {
  injectStyles();
  const container = document.createElement('div');
  container.id = 'datageo-ticker';
  container.innerHTML = `
    <button type="button" class="ticker-tag" aria-pressed="false" title="Parar ou retomar a passagem das notícias">PR AO VIVO</button>
    <div class="ticker-track"><div class="ticker-scroll"></div></div>
  `;
  document.body.appendChild(container);

  // Clique em PR AO VIVO liga/desliga a passagem; a escolha fica no navegador.
  const tag = container.querySelector('.ticker-tag');
  const setPaused = (paused) => {
    container.classList.toggle('paused', paused);
    tag.setAttribute('aria-pressed', String(paused));
    try { localStorage.setItem(TICKER_PAUSED_KEY, paused ? '1' : '0'); } catch { /* sem storage */ }
  };
  let pausedInicial = false;
  try { pausedInicial = localStorage.getItem(TICKER_PAUSED_KEY) === '1'; } catch { /* sem storage */ }
  setPaused(pausedInicial);
  tag.addEventListener('click', () => setPaused(!container.classList.contains('paused')));

  // Loop com skip quando a aba esta oculta, backoff em erro e catch-up no
  // visibilitychange (pollPolicy). Erro lanca para o loop contar a falha.
  const loop = startPollLoop(async () => {
    const items = await fetchNews(30);
    if (items.length > 0) render(container, items);
  }, {
    baseMs: POLL_MS,
    onError: (err) => console.warn('[DataGeo:ticker]', err),
  });

  return {
    destroy() {
      loop.stop();
      container.remove();
    },
  };
}
