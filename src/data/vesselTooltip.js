// src/data/vesselTooltip.js
//
// HTML do tooltip de hover dos navios da camada marítima: line-up da APPA
// (atracado ou ao largo) e AIS. Puro, sem DOM nem Cesium.
//
// SEGURANÇA: nomes de navio, operadores, cargas e agências vêm de fonte
// externa (relatório da APPA, AISStream). Todo texto passa por escapeHtml
// antes de entrar no innerHTML.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const TZ = 'America/Sao_Paulo';

/** "13/09 08:50" em horário de Brasília; vazio se inválido. */
export function formatDataHora(iso) {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ,
  }).format(new Date(ms)).replace(',', '');
}

/** Número pt-BR com casas opcionais; vazio se não numérico. */
export function formatNumero(value, casas = 0) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

const UNIDADES = { tons: 't', movs: 'movs', unid: 'unid', cab: 'cab', m3: 'm³', t: 't' };

const SECAO_TITULO = {
  atracados: 'Atracado',
  ao_largo: 'Ao largo',
  ao_largo_reatracacao: 'Ao largo para reatracação',
};

const linha = (rotulo, valor) => (valor ? `<span class="vt-dim">${escapeHtml(rotulo)}</span> ${escapeHtml(valor)}` : '');

/** Progresso da operação: "1.234 / 26.000 t (5%)". */
export function progressoOperacao(previsto, realizado, unidade) {
  const p = Number(previsto);
  const r = Number(realizado);
  if (!Number.isFinite(p) || p <= 0 || previsto === null || realizado === null || !Number.isFinite(r)) return '';
  const u = UNIDADES[String(unidade ?? '').toLowerCase()] ?? '';
  const pct = Math.max(0, Math.min(100, Math.round((r / p) * 100)));
  return `${formatNumero(r)} / ${formatNumero(p)}${u ? ` ${u}` : ''} (${pct}%)`;
}

function lineupHtml(p) {
  const atracado = p.kind === 'berco';
  const partes = [`<div class="vt-nome">${escapeHtml(p.embarcacao || 'Embarcação')}</div>`];

  const status = SECAO_TITULO[p.secao] ?? (atracado ? 'Atracado' : 'Ao largo');
  const onde = atracado
    ? `${status} · ${p.local ?? `Berço ${p.berco ?? '?'}`}`
    : `${status}${p.berco ? ` · aguarda berço ${p.berco}` : ''}`;
  partes.push(`<div class="vt-status vt-${atracado ? 'berco' : 'fundeio'}">${escapeHtml(onde)}</div>`);

  const ficha = [
    p.imo ? `IMO ${p.imo}` : '',
    p.loaM ? `LOA ${formatNumero(p.loaM, 1)} m` : '',
    p.dwtT ? `DWT ${formatNumero(p.dwtT)} t` : '',
  ].filter(Boolean).join(' · ');
  if (ficha) partes.push(escapeHtml(ficha));

  partes.push(
    linha('Carga:', p.mercadorias),
    linha('Sentido:', p.sentido),
    linha('Operador:', p.operadores),
    linha('Agência:', p.agencia),
  );

  if (atracado) {
    partes.push(linha('Atracação:', formatDataHora(p.atracacao)));
    partes.push(linha('Previsão de término:', formatDataHora(p.janelaFim)));
    partes.push(linha('Operação:', progressoOperacao(p.previsto, p.realizado, p.unidade)));
  } else {
    partes.push(linha('Chegada:', formatDataHora(p.chegada)));
    partes.push(linha('ETA:', formatDataHora(p.eta)));
  }

  const aviso = atracado
    ? 'posição aproximada do berço'
    : `${p.local ?? 'área de fundeio'}`;
  const emitido = formatDataHora(p.emitidoEm);
  partes.push(
    `<div class="vt-fontes">Line-up APPA${emitido ? ` · emitido ${escapeHtml(emitido)}` : ''}<br/>${escapeHtml(aviso)}</div>`,
  );
  return partes.filter(Boolean).join('<br/>').replace(/<br\/>(<div)/g, '$1').replace(/(<\/div>)<br\/>/g, '$1');
}

function aisHtml(p) {
  const partes = [`<div class="vt-nome">${escapeHtml(p.vesselName || `MMSI ${p.mmsi ?? '?'}`)}</div>`];
  partes.push(`<div class="vt-status vt-ais">${escapeHtml(p.navStatus || 'Posição AIS')}</div>`);
  partes.push(
    linha('MMSI:', p.mmsi),
    linha('Tipo:', p.shipType),
    linha('Velocidade:', Number.isFinite(Number(p.sog)) && p.sog !== null ? `${formatNumero(p.sog, 1)} nós` : ''),
    linha('Destino:', p.destination),
    linha('Posição em:', formatDataHora(p.observedAt)),
  );
  partes.push('<div class="vt-fontes">AISStream</div>');
  return partes.filter(Boolean).join('<br/>').replace(/<br\/>(<div)/g, '$1').replace(/(<\/div>)<br\/>/g, '$1');
}

/** HTML do tooltip a partir das properties da entidade. */
export function vesselTooltipHtml(props) {
  if (!props || typeof props !== 'object') return '';
  return props.fonte === 'APPA line-up' ? lineupHtml(props) : aisHtml(props);
}
