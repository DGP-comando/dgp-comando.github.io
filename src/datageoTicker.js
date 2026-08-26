// src/datageoTicker.js
//
// Ticker de noticias do Parana (news_items do DataGeo) — faixa fixa no
// rodape, rolagem continua estilo sala de imprensa. Urgencia colore o
// marcador: urgent vermelho, important ambar, normal ciano.
// Fase 2 da fusao (PLANO_FUSAO.md §3): "ticker de noticias" nao e camada
// espacial; vive no chrome do HUD.

import { fetchNews } from './data/datageoClient.js';

const POLL_MS = 5 * 60_000;

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
      padding: 0 10px;
      color: #22d3ee;
      letter-spacing: 0.12em;
      border-right: 1px solid rgba(34, 211, 238, 0.25);
      background: rgba(3, 10, 18, 0.95);
      z-index: 1;
    }
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
    #datageo-ticker .ticker-item { margin-right: 42px; }
    #datageo-ticker .ticker-dot { margin-right: 6px; }
    #datageo-ticker .ticker-source { color: #64748b; margin-left: 6px; }
    @keyframes datageo-ticker-scroll {
      from { transform: translateX(0); }
      to { transform: translateX(-100%); }
    }
  `;
  document.head.appendChild(style);
}

function render(container, items) {
  const track = container.querySelector('.ticker-scroll');
  if (!track) return;
  track.innerHTML = '';
  for (const item of items) {
    const span = document.createElement('span');
    span.className = 'ticker-item';
    const dot = document.createElement('span');
    dot.className = 'ticker-dot';
    dot.textContent = '●';
    dot.style.color = URGENCY_COLORS[item.urgency ?? 'normal'] ?? URGENCY_COLORS.normal;
    const text = document.createElement('span');
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
    <span class="ticker-tag">PR AO VIVO</span>
    <div class="ticker-track"><div class="ticker-scroll"></div></div>
  `;
  document.body.appendChild(container);

  async function poll() {
    try {
      const items = await fetchNews(30);
      if (items.length > 0) render(container, items);
    } catch (err) {
      console.warn('[DataGeo:ticker]', err);
    }
  }
  poll();
  const interval = setInterval(poll, POLL_MS);

  return {
    destroy() {
      clearInterval(interval);
      container.remove();
    },
  };
}
