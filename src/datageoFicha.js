// src/datageoFicha.js
//
// Ficha municipal detalhada — abre ao CLICAR num municipio (camada
// datageo-municipios) e consolida tudo que o ecossistema DataGeo tem sobre
// ele: risco IRTC por dominio, economia SEAB (VBP 24-25 + top-3 cadeias),
// dengue (serie + projecao do etl-dengue), focos, clima local, hidro,
// CEMADEN, qualidade do ar, anomalias, incidentes e mencoes no noticiario.
//
// EXTENSIVEL POR DESENHO: cada bloco e um builder em SECTIONS que recebe
// {ficha, info} e devolve HTML (ou null para omitir a secao). Integrar uma
// base nova = uma chave nova em fetchMunicipioFicha (datageoClient) + um
// builder aqui. Nada mais.

import { fetchMunicipioFicha } from './data/datageoClient.js';

const esc = (t) =>
  String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fmtBRL = (reais) => {
  if (reais >= 1e9) return `R$ ${(reais / 1e9).toFixed(2).replace('.', ',')} bi`;
  if (reais >= 1e6) return `R$ ${(reais / 1e6).toFixed(1).replace('.', ',')} mi`;
  return `R$ ${Math.round(reais).toLocaleString('pt-BR')}`;
};

const RISK_COLORS = {
  baixo: '#22c55e', medio: '#eab308', ['médio']: '#eab308',
  alto: '#f97316', critico: '#ef4444', ['crítico']: '#ef4444',
};

function bar(label, value, color) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    `<div class="fx-bar-row"><span class="fx-bar-label">${esc(label)}</span>` +
    `<span class="fx-bar-track"><span class="fx-bar-fill" style="width:${pct}%;background:${color}"></span></span>` +
    `<span class="fx-bar-val">${pct.toFixed(0)}</span></div>`
  );
}

function section(title, bodyHtml) {
  return `<section class="fx-section"><h3>${esc(title)}</h3>${bodyHtml}</section>`;
}

// --- builders (um por secao; retornar null omite) --------------------------

const SECTIONS = [
  function economia({ info }) {
    if (!info) return null;
    const rows = [];
    if (info.vbp) {
      const { anoA, anoB, valB, deltaPct } = info.vbp;
      const up = deltaPct >= 0;
      rows.push(
        `<div>VBP ${esc(anoA)}→${esc(anoB)}: <b class="${up ? 'fx-up' : 'fx-down'}">` +
          `${up ? '▲ +' : '▼ '}${String(deltaPct).replace('.', ',')}%</b> ` +
          `<span class="fx-dim">(${fmtBRL(valB)})</span></div>`,
      );
    }
    if (Array.isArray(info.produtos) && info.produtos.length) {
      const maior = info.produtos[0].valor || 1;
      rows.push('<div class="fx-sub">Top 3 produtos (2025)</div>');
      for (const p of info.produtos) {
        // Nomes SEAB vem sem espaco antes do parentese ("Suíno(Para Corte)")
        const nome = String(p.nome).replace(/\(/g, ' (').replace(/\s+\(/g, ' (');
        rows.push(
          `<div class="fx-bar-row"><span class="fx-bar-label fx-bar-label-wide">${esc(nome)}</span>` +
            `<span class="fx-bar-track"><span class="fx-bar-fill" style="width:${Math.round((p.valor / maior) * 100)}%;background:#22d3ee"></span></span>` +
            `<span class="fx-bar-val fx-bar-val-wide">${esc(fmtBRL(p.valor))}</span></div>`,
        );
      }
    }
    return rows.length ? section('Economia agropecuária · SEAB/DERAL', rows.join('')) : null;
  },

  function demografia({ info }) {
    if (!info || (!info.pop && !info.nascidos && !info.obitos)) return null;
    const rows = [];
    if (info.pop) {
      rows.push(
        `<div>População (${esc(info.pop.ano)}): <b>${Number(info.pop.valor).toLocaleString('pt-BR')}</b> habitantes</div>`,
      );
    }
    if (info.nascidos || info.obitos) {
      const ano = info.nascidos?.ano || info.obitos?.ano;
      const partes = [];
      if (info.nascidos) partes.push(`<b class="fx-up">${Number(info.nascidos.valor).toLocaleString('pt-BR')}</b> nascimentos`);
      if (info.obitos) partes.push(`<b>${Number(info.obitos.valor).toLocaleString('pt-BR')}</b> óbitos`);
      rows.push(`<div>${partes.join(' · ')} <span class="fx-dim">(${esc(ano)})</span></div>`);
      if (info.nascidos && info.obitos) {
        const saldo = info.nascidos.valor - info.obitos.valor;
        rows.push(
          `<div class="fx-dim">Saldo vegetativo: <b class="${saldo >= 0 ? 'fx-up' : 'fx-down'}">${saldo >= 0 ? '+' : ''}${saldo.toLocaleString('pt-BR')}</b></div>`,
        );
      }
    }
    return section('População · IBGE', rows.join(''));
  },

  function seguranca({ info }) {
    const s = info?.seguranca;
    if (!s) return null;
    const rows = [
      `<div>Vítimas de crimes violentos em ${esc(s.ano)}: <b>${Number(s.vitimas).toLocaleString('pt-BR')}</b>` +
        (s.taxa100k != null ? ` <span class="fx-dim">· ${String(s.taxa100k).replace('.', ',')}/100 mil hab.</span>` : '') +
        '</div>',
    ];
    if (s.vitimasPrev != null) {
      const delta = s.vitimas - s.vitimasPrev;
      rows.push(
        `<div class="fx-dim">Ano anterior: ${Number(s.vitimasPrev).toLocaleString('pt-BR')} ` +
          `(<b class="${delta <= 0 ? 'fx-up' : 'fx-down'}">${delta > 0 ? '+' : ''}${delta}</b>)</div>`,
      );
    }
    rows.push('<div class="fx-dim">Última série municipal publicada pelo SINESP (2018-2022).</div>');
    return section('Segurança pública · SINESP', rows.join(''));
  },

  function risco({ ficha }) {
    const r = Array.isArray(ficha.irtc) ? ficha.irtc[0] : null;
    if (!r) return null;
    const nivel = String(r.risk_level ?? 'baixo');
    const cor = RISK_COLORS[nivel] ?? '#22c55e';
    return section(
      'Risco territorial · IRTC',
      `<div class="fx-irtc"><span class="fx-irtc-score" style="color:${cor}">${Number(r.irtc_score).toFixed(0)}</span>` +
        `<span class="fx-irtc-nivel" style="color:${cor}">${esc(nivel.toUpperCase())}</span>` +
        `<span class="fx-dim">dom.: ${esc(r.dominant_domain ?? '—')} · cobertura ${(Number(r.data_coverage) * 100).toFixed(0)}%</span></div>` +
        bar('Clima', r.risk_clima, '#38bdf8') +
        bar('Saúde', r.risk_saude, '#f472b6') +
        bar('Ambiente', r.risk_ambiente, '#fb923c') +
        bar('Hidro', r.risk_hidro, '#60a5fa') +
        bar('Ar', r.risk_ar, '#a3a3a3'),
    );
  },

  function saude({ ficha }) {
    const serie = Array.isArray(ficha.dengueSerie) ? ficha.dengueSerie : [];
    if (!serie.length) return null;
    const ultima = serie[0];
    const nivel = Math.trunc(Number(ultima.alert_level ?? 1)) || 1;
    const corNivel = ['', '#22c55e', '#eab308', '#f97316', '#ef4444'][nivel] ?? '#22c55e';
    const maxCasos = Math.max(1, ...serie.map((s) => Number(s.cases ?? 0)));
    const spark = [...serie]
      .reverse()
      .map((s) => {
        const h = Math.max(2, Math.round((Number(s.cases ?? 0) / maxCasos) * 26));
        return `<span class="fx-spark-bar" style="height:${h}px" title="SE ${s.epidemiological_week}/${s.year}: ${s.cases} casos"></span>`;
      })
      .join('');
    const proj = Array.isArray(ficha.dengueProj) && ficha.dengueProj.length
      ? ficha.dengueProj[ficha.dengueProj.length - 1]
      : null;
    return section(
      'Dengue · InfoDengue',
      `<div>SE ${ultima.epidemiological_week}/${ultima.year}: <b>${ultima.cases} casos</b> ` +
        `<span style="color:${corNivel}">· nível ${nivel}</span> ` +
        `<span class="fx-dim">· inc. ${Number(ultima.incidence_rate ?? 0).toFixed(1)}/100k</span></div>` +
        `<div class="fx-spark">${spark}</div>` +
        (proj
          ? `<div class="fx-dim">Projeção (etl-dengue): tendência <b>${esc(proj.trend)}</b>, ` +
            `~${Math.round(proj.projected_cases)} casos na SE ${proj.projected_week}/${proj.projected_year}</div>`
          : ''),
    );
  },

  function ambiente({ ficha }) {
    const focos = ficha.focos && !ficha.focos.error ? ficha.focos : null;
    const anomalias = Array.isArray(ficha.anomalias) ? ficha.anomalias : [];
    if (!focos && !anomalias.length) return null;
    const rows = [];
    if (focos) {
      rows.push(
        `<div>Focos de calor: <b>${focos.d7}</b> em 7 dias · <b>${focos.d30}</b> em 30 dias</div>`,
      );
    }
    for (const a of anomalias) {
      rows.push(
        `<div class="fx-warn">Anomalia ${esc(a.indicator)}: z=${Number(a.z_score).toFixed(1)} ` +
          `(obs. ${Number(a.observed_value).toFixed(1)})</div>`,
      );
    }
    return section('Ambiente · FIRMS + detector', rows.join(''));
  },

  function clima({ ficha }) {
    const c = Array.isArray(ficha.clima) ? ficha.clima[0] : null;
    if (!c) return null;
    const parts = [];
    if (c.temperature !== null) parts.push(`${Number(c.temperature).toFixed(1)}°C`);
    if (c.humidity !== null) parts.push(`UR ${Number(c.humidity).toFixed(0)}%`);
    if (c.precipitation !== null) parts.push(`precip. ${Number(c.precipitation).toFixed(1)} mm`);
    if (c.wind_speed !== null) parts.push(`vento ${Number(c.wind_speed).toFixed(1)} m/s`);
    return section(
      'Clima local · INMET',
      `<div>${parts.join(' · ') || '—'}</div>` +
        `<div class="fx-dim">${esc(c.station_name ?? '')} · ${esc(String(c.observed_at ?? '').slice(0, 16).replace('T', ' '))}</div>`,
    );
  },

  function hidro({ ficha }) {
    const rios = Array.isArray(ficha.rios) ? ficha.rios : [];
    const cemaden = Array.isArray(ficha.cemaden) ? ficha.cemaden : [];
    if (!rios.length && !cemaden.length) return null;
    const rows = [];
    for (const r of rios) {
      const cor = { normal: '#22c55e', attention: '#eab308', alert: '#f97316', emergency: '#ef4444' }[r.alert_level] ?? '#22c55e';
      rows.push(
        `<div>${esc(r.river_name ?? '')} · ${esc(r.station_name ?? '')}: ` +
          `<b>${r.level_cm !== null ? `${Number(r.level_cm).toFixed(0)} cm` : '—'}</b> ` +
          `<span style="color:${cor}">${esc(String(r.alert_level ?? 'normal').toUpperCase())}</span></div>`,
      );
    }
    for (const a of cemaden) {
      rows.push(
        `<div class="fx-warn">CEMADEN ${esc(a.alert_type ?? '')} · ${esc(String(a.severity ?? '').replace('_', ' '))}</div>`,
      );
    }
    return section('Hidrologia · ANA + CEMADEN', rows.join(''));
  },

  function ar({ ficha }) {
    const a = Array.isArray(ficha.ar) ? ficha.ar[0] : null;
    if (!a) return null;
    const aqi = Math.trunc(Number(a.aqi ?? 0));
    const cor = aqi <= 50 ? '#22c55e' : aqi <= 100 ? '#eab308' : aqi <= 150 ? '#f97316' : '#ef4444';
    return section(
      'Qualidade do ar · AQICN',
      `<div>AQI <b style="color:${cor}">${aqi}</b>` +
        `${a.dominant_pollutant ? ` <span class="fx-dim">· dominante ${esc(a.dominant_pollutant)}</span>` : ''}</div>`,
    );
  },

  function incidentes({ ficha }) {
    const list = Array.isArray(ficha.incidentes) ? ficha.incidentes : [];
    if (!list.length) return null;
    return section(
      'Incidentes ativos · OODA',
      list
        .map(
          (i) =>
            `<div class="fx-warn">${esc(i.title ?? '')} <span class="fx-dim">· ${esc(i.severity ?? '')} · ${esc(i.status ?? '')}</span></div>`,
        )
        .join(''),
    );
  },

  function noticias({ ficha }) {
    const list = Array.isArray(ficha.noticias) ? ficha.noticias : [];
    if (!list.length) return null;
    return section(
      'No noticiário',
      list
        .map(
          (n) =>
            `<div class="fx-news">• ${esc(n.title ?? '')} <span class="fx-dim">[${esc(n.source ?? '')}]</span></div>`,
        )
        .join(''),
    );
  },
];

// --- painel ---------------------------------------------------------------

function injectStyles() {
  if (document.getElementById('datageo-ficha-style')) return;
  const style = document.createElement('style');
  style.id = 'datageo-ficha-style';
  style.textContent = `
    #datageo-ficha {
      position: fixed;
      top: 90px;
      right: 16px;
      bottom: 110px;
      width: 360px;
      display: none;
      flex-direction: column;
      background: rgba(3, 10, 18, 0.94);
      border: 1px solid rgba(34, 211, 238, 0.35);
      border-radius: 10px;
      font-family: 'JetBrains Mono', monospace;
      color: #cbd5e1;
      /* Acima dos paineis da esquerda (z=100) e abaixo do dock (z=145):
         a ficha e quase-modal e nao pode ficar soterrada no celular. */
      z-index: 120;
      overflow: hidden;
    }
    #datageo-ficha.open { display: flex; }
    #datageo-ficha .fx-header {
      padding: 12px 14px 10px;
      border-bottom: 1px solid rgba(34, 211, 238, 0.2);
    }
    #datageo-ficha .fx-nome { color: #22d3ee; font-size: 15px; font-weight: 700; letter-spacing: 0.08em; }
    #datageo-ficha .fx-meta { color: #64748b; font-size: 10px; margin-top: 3px; }
    #datageo-ficha .fx-close {
      position: absolute; top: 8px; right: 10px;
      background: none; border: none; color: #64748b; font-size: 16px; cursor: pointer;
    }
    #datageo-ficha .fx-close:hover { color: #22d3ee; }
    #datageo-ficha .fx-body { flex: 1; overflow-y: auto; padding: 4px 14px 12px; font-size: 11px; line-height: 1.55; }
    #datageo-ficha .fx-section { margin-top: 12px; }
    #datageo-ficha .fx-section h3 {
      color: #7dd3fc; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      border-bottom: 1px dashed rgba(125, 211, 252, 0.25); padding-bottom: 3px; margin-bottom: 6px;
    }
    #datageo-ficha .fx-up { color: #22c55e; }
    #datageo-ficha .fx-down { color: #ef4444; }
    #datageo-ficha .fx-dim { color: #64748b; }
    #datageo-ficha .fx-warn { color: #fbbf24; }
    #datageo-ficha .fx-sub { color: #94a3b8; margin-top: 6px; }
    #datageo-ficha .fx-news { margin-bottom: 4px; }
    #datageo-ficha .fx-bar-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    #datageo-ficha .fx-bar-label { flex: 0 0 76px; color: #94a3b8; }
    #datageo-ficha .fx-bar-track { flex: 1; height: 6px; background: rgba(148,163,184,0.15); border-radius: 3px; overflow: hidden; }
    #datageo-ficha .fx-bar-fill { display: block; height: 100%; border-radius: 3px; }
    #datageo-ficha .fx-bar-val { flex: 0 0 26px; text-align: right; color: #94a3b8; }
    #datageo-ficha .fx-bar-label-wide { flex: 0 0 118px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #datageo-ficha .fx-bar-val-wide { flex: 0 0 74px; white-space: nowrap; }
    #datageo-ficha .fx-irtc { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
    #datageo-ficha .fx-irtc-score { font-size: 26px; font-weight: 700; }
    #datageo-ficha .fx-irtc-nivel { font-size: 12px; letter-spacing: 0.15em; }
    #datageo-ficha .fx-spark { display: flex; align-items: flex-end; gap: 3px; height: 28px; margin: 6px 0; }
    #datageo-ficha .fx-spark-bar { width: 12px; background: #f472b6; border-radius: 2px 2px 0 0; opacity: 0.85; }
    #datageo-ficha .fx-fontes { padding: 8px 14px; border-top: 1px solid rgba(34,211,238,0.2); color: #475569; font-size: 9px; letter-spacing: 0.04em; }
    #datageo-ficha .fx-loading { padding: 20px 14px; color: #64748b; }
    /* Celular: ficha em tela quase cheia (o cartao de 360px estourava). */
    @media (max-width: 700px) {
      #datageo-ficha {
        top: 64px;
        right: 8px;
        left: 8px;
        bottom: 76px;
        width: auto;
        font-size: 13px;
      }
      #datageo-ficha .fx-body { font-size: 12px; }
      #datageo-ficha .fx-close { font-size: 20px; padding: 6px; }
    }
  `;
  document.head.appendChild(style);
}

let _panel = null;
let _requestSeq = 0;

function ensurePanel() {
  injectStyles();
  if (_panel) return _panel;
  _panel = document.createElement('aside');
  _panel.id = 'datageo-ficha';
  _panel.innerHTML = `
    <button class="fx-close" title="Fechar (Esc)">✕</button>
    <div class="fx-header"><div class="fx-nome"></div><div class="fx-meta"></div></div>
    <div class="fx-body"></div>
    <div class="fx-fontes">SEAB/DERAL · IBGE · SINESP · TSE 2024 · InfoDengue · FIRMS · INMET · ANA · CEMADEN · AQICN · DataGeo PR</div>
  `;
  document.body.appendChild(_panel);
  _panel.querySelector('.fx-close').addEventListener('click', closeFicha);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFicha();
  });
  return _panel;
}

export function closeFicha() {
  if (_panel) _panel.classList.remove('open');
}

/**
 * Abre a ficha do municipio. `info` e a entrada de municipios-info.json
 * (prefeito/VBP/cadeias) que a camada ja tem em memoria.
 */
export async function openFicha({ ibge, nome, info }) {
  const panel = ensurePanel();
  const seq = ++_requestSeq;
  panel.classList.add('open');
  panel.querySelector('.fx-nome').textContent = nome;
  panel.querySelector('.fx-meta').textContent =
    `IBGE ${ibge}` + (info?.prefeito ? ` · Prefeito: ${info.prefeito} (${info.partido})` : '');
  panel.querySelector('.fx-body').innerHTML =
    '<div class="fx-loading">Consultando as bases do DataGeo…</div>';

  try {
    const ficha = await fetchMunicipioFicha(ibge, nome);
    if (seq !== _requestSeq) return; // outro municipio foi clicado no meio
    const html = SECTIONS.map((build) => {
      try {
        return build({ ficha, info });
      } catch (err) {
        console.warn('[DataGeo:ficha] secao falhou:', err);
        return null;
      }
    })
      .filter(Boolean)
      .join('');
    panel.querySelector('.fx-body').innerHTML =
      html || '<div class="fx-loading">Sem dados quantificáveis para este município.</div>';
  } catch (err) {
    if (seq !== _requestSeq) return;
    panel.querySelector('.fx-body').innerHTML =
      `<div class="fx-loading">Falha ao consultar as bases: ${esc(err?.message)}</div>`;
  }
}
