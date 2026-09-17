// src/datageoFicha.js
//
// Ficha municipal detalhada — abre ao CLICAR num municipio (camada
// datageo-municipios) e consolida tudo que o ecossistema DataGeo tem sobre
// ele: risco IRTC por dominio, economia SEAB (VBP 24-25 + top-3 cadeias),
// dengue (serie + projecao do etl-dengue), focos, clima local, hidro,
// CEMADEN, qualidade do ar, anomalias, incidentes e mencoes no noticiario.
//
// EXTENSIVEL POR DESENHO: cada bloco e um builder em SECTIONS que recebe
// {ficha, info, climaHist} e devolve HTML (ou null para omitir a secao).
// Integrar uma base nova = uma chave nova em fetchMunicipioFicha (datageoClient)
// + um builder aqui. Nada mais. Base ESTATICA (JSON em public/data, como o
// clima historico BR-DWGD ou a estrutura fundiaria do CAR) entra no
// Promise.all de openFicha.

import { fetchMunicipioFicha } from './data/datageoClient.js';
import { getClimaMunicipio } from './data/climaHistorico.js';
import { getCarMunicipio } from './data/carMunicipios.js';

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
    // Intensidade sobre o TERRITORIO. O denominador e a area total do
    // municipio (IBGE), nao a area plantada, porque metade do VBP vem de
    // criacoes que nao declaram area nenhuma. Como a area nao muda entre os
    // dois anos, esta variacao e por construcao igual a do valor acima — o que
    // esta linha acrescenta e o NIVEL, que e o que permite comparar
    // municipios de tamanhos diferentes. Por isso o R$/ha vem primeiro.
    if (info.vbpHa) {
      const { anoA, anoB, valB, deltaPct } = info.vbpHa;
      const up = deltaPct >= 0;
      const area = Number(info.areaKm2) > 0
        ? ` <span class="fx-dim">· ${Number(info.areaKm2).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} km²</span>`
        : '';
      rows.push(
        `<div>VBP/ha: <b>${fmtBRL(valB)}/ha</b> ` +
          `<b class="${up ? 'fx-up' : 'fx-down'}">${up ? '▲ +' : '▼ '}${String(deltaPct).replace('.', ',')}%</b> ` +
          `<span class="fx-dim">${esc(anoA)}→${esc(anoB)}</span>${area}</div>`,
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

  /**
   * Estrutura fundiaria declarada no CAR (imoveis ATIVOS), por classe de
   * modulos fiscais. Duas barras por classe: quantos imoveis e quanta area.
   *
   * As duas juntas sao o ponto — e a assimetria entre elas que diz alguma
   * coisa. "Metade dos imoveis em 8% da area" e um retrato de estrutura
   * fundiaria; so a contagem, ou so a area, nao e.
   */
  function fundiaria({ car }) {
    if (!car) return null;
    const nf = (v, casas = 0) => Number(v).toLocaleString('pt-BR', {
      minimumFractionDigits: casas, maximumFractionDigits: casas,
    });
    // Percentual com UMA casa abaixo de 10%: arredondar a classe ">50 MF" de
    // 0,1% para "0%" diria que não há imóvel grande nenhum, bem ao lado da
    // barra de área mostrando que eles ocupam 7% do município. A concentração
    // fundiária mora justamente nessa assimetria; ela não pode sumir no
    // arredondamento.
    const pct = (v) => nf(v, v > 0 && v < 10 ? 1 : 0);
    const linhas = car.linhas.map(({ classe, n, ha, pctN, pctHa }) => (
      `<div class="fx-car-row">` +
        `<span class="fx-car-label">${esc(classe)} MF</span>` +
        `<span class="fx-car-bars">` +
          `<span class="fx-car-track" title="${nf(n)} imóveis">` +
            `<span class="fx-car-fill" style="width:${pctN.toFixed(1)}%;background:#22d3ee"></span></span>` +
          `<span class="fx-car-track" title="${nf(ha)} ha">` +
            `<span class="fx-car-fill" style="width:${pctHa.toFixed(1)}%;background:#fbbf24"></span></span>` +
        `</span>` +
        `<span class="fx-car-val">${pct(pctN)}% · ${pct(pctHa)}%</span>` +
      `</div>`
    ));
    // A leitura que o operador levaria embora, dita em palavras: sem isto as
    // barras exigem que ele compare duas larguras de cabeca.
    const pequenos = car.linhas[0];
    const grandes = car.linhas[car.linhas.length - 1];
    const takeaway = pequenos.pctN >= 1
      ? `<div class="fx-sub">Até 4 MF: <b>${pct(pequenos.pctN)}%</b> dos imóveis em ` +
        `<b>${pct(pequenos.pctHa)}%</b> da área` +
        (grandes.n ? ` · acima de 50 MF: <b>${pct(grandes.pctN)}%</b> em <b>${pct(grandes.pctHa)}%</b>` : '') +
        `</div>`
      : '';
    return section(
      'Estrutura fundiária · CAR (ativos)',
      `<div>${nf(car.totalImoveis)} imóveis · ${nf(car.totalHa)} ha declarados</div>` +
      takeaway +
      `<div class="fx-car-legenda">` +
        `<span class="fx-car-chave" style="background:#22d3ee"></span>% dos imóveis · ` +
        `<span class="fx-car-chave" style="background:#fbbf24"></span>% da área` +
      `</div>` +
      linhas.join('') +
      `<div class="fx-dim">Módulos fiscais; CAR é declaratório, não cadastro fundiário.</div>`,
    );
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

  function climaHistorico({ climaHist }) {
    const c = climaHist?.resumo;
    if (!c) return null;
    const { normal: periodo = [1990, 2019] } = climaHist.meta || {};
    const n = (v, casas = 0) => (v === null || v === undefined
      ? '—'
      : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));
    const sinal = (v, casas) => (v > 0 ? `+${n(v, casas)}` : n(v, casas));
    const rows = [
      `<div class="fx-sub">Normal ${periodo[0]}–${periodo[1]}</div>`,
      `<div>Chuva <b>${n(c.pr)} mm/ano</b> · Tméd <b>${n(c.tmed, 1)} °C</b> · ETo ${n(c.eto)} mm</div>`,
      `<div>Balanço P−ETo: <b class="${c.balanco >= 0 ? 'fx-up' : 'fx-down'}">${sinal(c.balanco, 0)} mm/ano</b>` +
        (c.mesesDeficit ? ` <span class="fx-dim">· ${c.mesesDeficit} ${c.mesesDeficit === 1 ? 'mês' : 'meses'} com déficit</span>` : '') +
        '</div>',
      `<div>Geada (Tmín ≤ 3 °C): <b>${n(c.geada3)} dias/ano</b> <span class="fx-dim">· ≤ 0 °C: ${n(c.geada0)}</span></div>`,
      `<div>Tmáx ≥ 35 °C: <b>${n(c.calor35)} dias/ano</b> <span class="fx-dim">· chuva ≥ 50 mm: ${n(c.chuva50)} dias/ano</span></div>`,
    ];

    // Chuva mensal normal; mes em que a chuva nao cobre a ETo fica ambar.
    const pr = c.normal?.pr || [];
    const eto = c.normal?.eto || [];
    if (pr.length === 12) {
      const max = Math.max(1, ...pr.map((v) => Number(v) || 0), ...eto.map((v) => Number(v) || 0));
      const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
      const barras = pr.map((v, i) => {
        const h = Math.max(2, Math.round(((Number(v) || 0) / max) * 26));
        const deficit = eto[i] !== null && eto[i] !== undefined && v < eto[i];
        return `<span class="fx-spark-bar" style="height:${h}px;background:${deficit ? '#f59e0b' : '#7da2d6'}" ` +
          `title="${meses[i]}: chuva ${n(v)} mm · ETo ${n(eto[i])} mm"></span>`;
      }).join('');
      rows.push(`<div class="fx-spark">${barras}</div>`);
    }

    if (c.tendTmed !== null && c.tendTmed !== undefined) {
      const sig = (s) => (s ? '' : ' <span class="fx-dim">(n.s.)</span>');
      const anos = climaHist.meta?.serieTemperatura || [1961, 2019];
      rows.push(
        `<div>Tendência ${anos[0]}–${anos[1]}: <b class="${c.tendTmed > 0 ? 'fx-warn' : ''}">${sinal(c.tendTmed, 2)} °C/década</b>${sig(c.tendTmedSig)}` +
          (c.tendPrPct !== null && c.tendPrPct !== undefined
            ? ` · chuva ${sinal(c.tendPrPct, 1)}%/década${sig(c.tendPrSig)}`
            : '') +
          '</div>',
      );
    }

    const serie = climaHist.serie?.tmed;
    if (Array.isArray(serie) && serie.some((v) => v !== null)) {
      const validos = serie.filter((v) => v !== null);
      const lo = Math.min(...validos);
      const hi = Math.max(...validos);
      const ano0 = climaHist.serie.anos?.tmed?.[0] ?? 1961;
      const barras = serie.map((v, i) => {
        if (v === null) return '<span class="fx-spark-bar fx-spark-thin" style="height:0"></span>';
        const h = Math.max(2, Math.round(((v - lo) / Math.max(0.1, hi - lo)) * 26));
        return `<span class="fx-spark-bar fx-spark-thin" style="height:${h}px;background:#a39875" title="${ano0 + i}: ${n(v, 1)} °C"></span>`;
      }).join('');
      rows.push(`<div class="fx-sub">Tméd anual ${ano0}–${ano0 + serie.length - 1}</div><div class="fx-spark fx-spark-dense">${barras}</div>`);
    }

    rows.push('<div class="fx-dim">BR-DWGD · grade 0,1° (~11 km) · Xavier et al. 2022</div>');
    return section('Clima histórico · BR-DWGD', rows.join(''));
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
    #datageo-ficha .fx-header { padding-right: 116px; }
    #datageo-ficha .fx-watch {
      position: absolute; top: 10px; right: 36px;
      background: rgba(3, 10, 18, 0.85); border: 1px solid rgba(34, 211, 238, 0.3); border-radius: 6px;
      color: #22d3ee; font-family: inherit; font-size: 9px; letter-spacing: 0.12em;
      padding: 3px 8px; cursor: pointer;
    }
    #datageo-ficha .fx-watch:hover { border-color: rgba(34, 211, 238, 0.6); }
    #datageo-ficha .fx-watch[aria-pressed="true"] { color: #f59e0b; border-color: rgba(245, 158, 11, 0.55); }
    #datageo-ficha .fx-watch[hidden] { display: none; }
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
    #datageo-ficha .fx-spark-dense { gap: 1px; }
    #datageo-ficha .fx-spark-thin { width: auto; flex: 1; border-radius: 1px 1px 0 0; }
    /* Distribuicao fundiaria: duas barras EMPILHADAS por classe (imoveis em
       cima, area embaixo). Empilhar em vez de duas linhas separadas mantem as
       5 classes legiveis num cartao de 360px, e a posicao (cima/baixo) carrega
       a distincao junto com a cor, para nao depender so de matiz. */
    #datageo-ficha .fx-car-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
    #datageo-ficha .fx-car-label { flex: 0 0 62px; color: #94a3b8; white-space: nowrap; }
    #datageo-ficha .fx-car-bars { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    #datageo-ficha .fx-car-track { height: 5px; background: rgba(148,163,184,0.15); border-radius: 3px; overflow: hidden; }
    #datageo-ficha .fx-car-fill { display: block; height: 100%; border-radius: 3px; }
    #datageo-ficha .fx-car-val { flex: 0 0 66px; text-align: right; color: #94a3b8; white-space: nowrap; }
    #datageo-ficha .fx-car-legenda { color: #64748b; margin: 2px 0 6px; }
    #datageo-ficha .fx-car-chave { display: inline-block; width: 16px; height: 5px; border-radius: 3px; vertical-align: middle; margin-right: 3px; }
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
      #datageo-ficha .fx-watch { right: 50px; top: 12px; }
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
    <button class="fx-watch" type="button" aria-pressed="false" hidden>VIGIAR</button>
    <div class="fx-header"><div class="fx-nome"></div><div class="fx-meta"></div></div>
    <div class="fx-body"></div>
    <div class="fx-fontes">SEAB/DERAL · IBGE · SINESP · TSE 2024 · InfoDengue · FIRMS · INMET · BR-DWGD · ANA · CEMADEN · AQICN · SICAR/SFB · DataGeo PR</div>
  `;
  document.body.appendChild(_panel);
  _panel.querySelector('.fx-close').addEventListener('click', closeFicha);
  _panel.querySelector('.fx-watch').addEventListener('click', toggleWatch);
  // A lista de vigiados pode mudar pelo painel VIGILÂNCIA (botão ✕).
  window.addEventListener('dgp:area-watch-changed', syncWatchButton);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFicha();
  });
  return _panel;
}

// --- VIGIAR / VIGIANDO (window.__dgpAreaWatch, montado pelo orquestrador) ---

let _current = null;

function syncWatchButton() {
  const btn = _panel?.querySelector('.fx-watch');
  if (!btn) return;
  const watcher = window.__dgpAreaWatch;
  btn.hidden = !watcher || !_current;
  if (btn.hidden) return;
  const watching = Boolean(watcher.isWatched?.(_current.ibge));
  btn.textContent = watching ? 'VIGIANDO' : 'VIGIAR';
  btn.setAttribute('aria-pressed', String(watching));
  btn.title = watching
    ? 'Parar de vigiar este município'
    : 'Vigiar focos, alertas CEMADEN e incidentes deste município';
}

function toggleWatch() {
  const watcher = window.__dgpAreaWatch;
  if (!watcher || !_current) return;
  const { ibge, nome } = _current;
  if (watcher.isWatched?.(ibge)) {
    watcher.unwatch?.(ibge);
  } else {
    const result = watcher.watchMunicipio?.(ibge, nome);
    if (result && !result.ok && result.reason === 'limit') {
      const btn = _panel.querySelector('.fx-watch');
      btn.title = 'Limite de 10 municípios vigiados; remova um no painel VIGILÂNCIA';
    }
  }
  syncWatchButton();
}

/**
 * Nome do evento que anuncia qual municipio esta SELECIONADO agora — o da
 * ficha aberta, venha ela de um clique no mapa ou da busca por nome. O
 * `detail` e `{ibge, nome}` ou null quando a ficha fecha.
 *
 * E um CustomEvent no `document` de proposito: a ficha nao conhece a barra de
 * acoes nem as camadas, e um barramento proprio para um unico assinante seria
 * mais codigo do que a plataforma ja da de graca.
 */
export const MUNICIPIO_SELECIONADO_EVENT = 'datageo:municipio-selecionado';

function anunciarSelecao() {
  document.dispatchEvent(new CustomEvent(MUNICIPIO_SELECIONADO_EVENT, {
    detail: _current ? { ...(_current) } : null,
  }));
}

/**
 * Municipio da ficha aberta, ou null. E a resposta canonica a "qual municipio
 * esta selecionado".
 * @returns {{ibge: string, nome: string}|null}
 */
export function getMunicipioSelecionado() {
  return _current ? { ...(_current) } : null;
}

export function closeFicha() {
  if (_panel) _panel.classList.remove('open');
  if (!_current) return;
  _current = null;
  syncWatchButton();
  anunciarSelecao();
}

/**
 * Abre a ficha do municipio. `info` e a entrada de municipios-info.json
 * (prefeito/VBP/cadeias) que a camada ja tem em memoria.
 */
export async function openFicha({ ibge, nome, info }) {
  const panel = ensurePanel();
  const seq = ++_requestSeq;
  panel.classList.add('open');
  _current = { ibge: String(ibge), nome };
  syncWatchButton();
  anunciarSelecao();
  panel.querySelector('.fx-nome').textContent = nome;
  panel.querySelector('.fx-meta').textContent =
    `IBGE ${ibge}` + (info?.prefeito ? ` · Prefeito: ${info.prefeito} (${info.partido})` : '');
  panel.querySelector('.fx-body').innerHTML =
    '<div class="fx-loading">Consultando as bases do DataGeo…</div>';

  try {
    // Clima historico e estrutura fundiaria sao arquivos estaticos: em
    // paralelo com o Supabase, e sem poder derrubar a ficha (nem
    // getClimaMunicipio nem getCarMunicipio lancam).
    const [ficha, climaHist, car] = await Promise.all([
      fetchMunicipioFicha(ibge, nome),
      getClimaMunicipio(ibge),
      getCarMunicipio(ibge),
    ]);
    if (seq !== _requestSeq) return; // outro municipio foi clicado no meio
    const html = SECTIONS.map((build) => {
      try {
        return build({ ficha, info, climaHist, car });
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
