// src/maplibre/tooltipCard.js
//
// Formato ÚNICO dos tooltips de hover das camadas (#dg-tooltip, layerHost.js).
// Toda camada monta o HTML com `tipCard`, e o desenho mora só no style.css
// (bloco "#dg-tooltip .tt"). Nenhuma camada injeta CSS de tooltip.
//
//   tipCard({
//     icon: '🌡️',                        // opcional, antes do título
//     title: 'Curitiba',                  // obrigatório (texto, escapado aqui)
//     subtitle: 'Estação automática A807',// opcional, linha fina abaixo
//     badge: { text: 'ALERTA', tone: 'alert' },  // opcional; tons em TONES
//     rows: [                             // pares rótulo/valor; vazios somem
//       ['Temperatura', '23,4 °C'],
//       ['Umidade', { html: '<b>91%</b>' }],   // {html} = já escapado por quem chama
//       ['Rajada', '42 km/h', 'warn'],          // 3º item = tom do valor
//     ],
//     sections: [{ title: 'Previsão', rows: [...] }],  // blocos extras com título
//     note: 'Texto livre (escapado).',     // opcional, parágrafo em itálico
//     source: 'INMET · DataGeo PR',        // rodapé
//     updated: '2026-09-27T10:00:00Z',     // rodapé: "há 12 min" (Date, ISO ou ms)
//     wide: true,                          // até 460 px (tabelas largas)
//   })
//
// Os helpers de formatação (pt-BR) ficam aqui para todas as camadas usarem os
// mesmos: fmtNum, fmtInt, fmtPct, fmtDateTime, fmtDate, fmtAgo, fmtCoord.

export const TONES = Object.freeze(['ok', 'info', 'warn', 'alert', 'muted']);

export const escHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isBlank = (v) =>
  v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))
  || (typeof v === 'string' && (v.trim() === '' || v.trim() === '—'))
  || (typeof v === 'object' && !('html' in v));

const valueHtml = (v) => (typeof v === 'object' && v && 'html' in v ? String(v.html) : escHtml(v));
const toneClass = (tone) => (TONES.includes(tone) ? ` tt-${tone}` : '');

function rowsHtml(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!row) continue;
    const [label, value, tone] = row;
    if (isBlank(value) || (typeof value === 'object' && String(value.html).trim() === '')) continue;
    out.push(`<dt>${escHtml(label)}</dt><dd class="${toneClass(tone).trim()}">${valueHtml(value)}</dd>`);
  }
  return out.length ? `<dl class="tt-rows">${out.join('')}</dl>` : '';
}

/** HTML do cartão de tooltip (ver cabeçalho). */
export function tipCard({ icon, title, subtitle, badge, rows, sections, note, source, updated, wide, now = Date.now() } = {}) {
  const head = [
    icon ? `<span class="tt-icon">${escHtml(icon)}</span>` : '',
    `<span class="tt-title">${escHtml(title ?? '')}</span>`,
    badge?.text ? `<span class="tt-badge${toneClass(badge.tone)}">${escHtml(badge.text)}</span>` : '',
  ].join('');
  const secs = (sections ?? [])
    .map((s) => {
      const body = rowsHtml(s?.rows);
      return body ? `<div class="tt-sec"><div class="tt-sec-title">${escHtml(s.title ?? '')}</div>${body}</div>` : '';
    })
    .join('');
  const ago = updated ? fmtAgo(updated, now) : '';
  const foot = [source ? escHtml(source) : '', ago ? `atualizado ${escHtml(ago)}` : ''].filter(Boolean).join(' · ');
  return `<div class="tt${wide ? ' tt-wide' : ''}">`
    + `<div class="tt-head">${head}</div>`
    + (subtitle ? `<div class="tt-sub">${escHtml(subtitle)}</div>` : '')
    + rowsHtml(rows)
    + secs
    + (note ? `<div class="tt-note">${escHtml(note)}</div>` : '')
    + (foot ? `<div class="tt-foot">${foot}</div>` : '')
    + '</div>';
}

// ------------------------------------------------------------ formatação

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** 1234.5 -> "1.234,5" (casas fixas); '' se não for número. */
export function fmtNum(value, casas = 1, unit = '') {
  const n = num(value);
  if (!Number.isFinite(n)) return '';
  const s = n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  return unit ? `${s} ${unit}` : s;
}

export const fmtInt = (value, unit = '') => fmtNum(value, 0, unit);

/** 0.123 -> "12,3%" (fração) ou 12.3 -> "12,3%" com `jaPercentual`. */
export function fmtPct(value, casas = 1, jaPercentual = false) {
  const n = num(value);
  if (!Number.isFinite(n)) return '';
  return `${(jaPercentual ? n : n * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
}

const toDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return Number.isFinite(d.getTime()) ? d : null;
};

const TZ = 'America/Sao_Paulo';

/** "27/09/2026 07:05" no horário de Brasília. */
export function fmtDateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}

/** "27/09/2026". Datas só-dia ("2026-09-27") não andam um dia para trás. */
export function fmtDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias", ou a data para mais de 30 dias. */
export function fmtAgo(value, now = Date.now()) {
  const d = toDate(value);
  if (!d) return '';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) return fmtDateTime(d);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 30 * 86_400) {
    const dias = Math.floor(s / 86_400);
    return `há ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
  }
  return `em ${fmtDate(d)}`;
}

/** "-25,4284°, -49,2733°". */
export function fmtCoord(lat, lon, casas = 4) {
  const a = num(lat);
  const b = num(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  return `${fmtNum(a, casas)}°, ${fmtNum(b, casas)}°`;
}
