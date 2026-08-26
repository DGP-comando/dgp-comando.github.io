// src/datageoBriefing.js
//
// Briefing situacional diario (situational_reports do DataGeo) — card
// colapsavel no canto inferior esquerdo, acima da leitura MGRS. Mostra o
// resumo executivo e as recomendacoes do relatorio das 06:00 BRT gerado
// pelo etl-situational. Fase 2 da fusao (PLANO_FUSAO.md §3).

import { fetchLatestSituationalReport } from './data/datageoClient.js';

const POLL_MS = 30 * 60_000;

function injectStyles() {
  if (document.getElementById('datageo-briefing-style')) return;
  const style = document.createElement('style');
  style.id = 'datageo-briefing-style';
  style.textContent = `
    #datageo-briefing {
      position: fixed;
      left: 16px;
      bottom: 120px;
      width: 320px;
      font-family: 'JetBrains Mono', monospace;
      z-index: 55;
      color: #cbd5e1;
    }
    #datageo-briefing .brief-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(3, 10, 18, 0.85);
      border: 1px solid rgba(34, 211, 238, 0.3);
      border-radius: 6px;
      color: #22d3ee;
      font-size: 11px;
      letter-spacing: 0.12em;
      cursor: pointer;
      user-select: none;
    }
    #datageo-briefing .brief-card {
      margin-top: 8px;
      padding: 12px 14px;
      background: rgba(3, 10, 18, 0.9);
      border: 1px solid rgba(34, 211, 238, 0.25);
      border-radius: 8px;
      font-size: 11px;
      line-height: 1.55;
      max-height: 46vh;
      overflow-y: auto;
      display: none;
    }
    #datageo-briefing.open .brief-card { display: block; }
    #datageo-briefing .brief-date { color: #22d3ee; letter-spacing: 0.1em; margin-bottom: 8px; }
    #datageo-briefing .brief-recs { margin-top: 10px; color: #94a3b8; white-space: pre-wrap; }
    #datageo-briefing .brief-recs-title { color: #f59e0b; letter-spacing: 0.1em; margin-bottom: 4px; }
  `;
  document.head.appendChild(style);
}

export function initDatageoBriefing() {
  injectStyles();
  const container = document.createElement('div');
  container.id = 'datageo-briefing';
  container.innerHTML = `
    <div class="brief-toggle">▦ BRIEFING DIÁRIO</div>
    <div class="brief-card">
      <div class="brief-date"></div>
      <div class="brief-summary">Carregando relatório situacional…</div>
      <div class="brief-recs">
        <div class="brief-recs-title">RECOMENDAÇÕES</div>
        <div class="brief-recs-body"></div>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  container.querySelector('.brief-toggle').addEventListener('click', () => {
    container.classList.toggle('open');
  });

  async function poll() {
    try {
      const report = await fetchLatestSituationalReport();
      if (!report) return;
      container.querySelector('.brief-date').textContent =
        `RELATÓRIO ${report.report_date} · ${report.active_alerts_count ?? 0} ALERTAS 24H`;
      container.querySelector('.brief-summary').textContent = report.executive_summary ?? '';
      container.querySelector('.brief-recs-body').textContent = report.recommendations ?? '';
    } catch (err) {
      console.warn('[DataGeo:briefing]', err);
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
