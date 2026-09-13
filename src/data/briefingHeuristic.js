// src/data/briefingHeuristic.js
//
// Briefing heurístico em pt-BR, montado client-side a partir dos dados ao
// vivo quando o situational_report do dia ainda não existe. Puro: recebe as
// saídas do datageoClient e devolve { title, summary, bullets, level }.
//
// Formatos esperados (datageoClient.js):
//  irtc      fetchIrtcScores()        [{ ibge_code, municipality, irtc_score, risk_level: baixo|médio|alto|crítico }]
//  cemaden   fetchCemadenAlerts()     [{ alert_code, alert_type, severity: observacao|atencao|alerta|alerta_maximo, municipality, ibge_code }]
//  fires     fetchFiresPayload()      { fires: [{ lat, lon, municipality, acqDate, acqTime }] } ou o array fires
//  incidents fetchActiveIncidents()   [{ id, title, type, severity: low|medium|high|critical, status, affected_municipalities }]
//  dengue    fetchDengueLatestWeek()  { year, week, rows: [{ ibge_code, municipality_name, cases, alert_level 1-4 }] }
// Qualquer entrada ausente, nula ou com erro é ignorada sem lançar.

import { centroidByIbge, centroidByName } from './prCentroids.js';

const fold = (t) => String(t ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().trim();

const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key];
  return null;
}

/** Nome canônico (com acento) do município a partir de código ou nome livre. */
export function municipioName(row) {
  if (!row || typeof row !== 'object') return '';
  const code = row.ibge_code ?? row.ibgeCode;
  const byCode = code !== undefined && code !== null ? centroidByIbge(code) : null;
  if (byCode) return byCode.name;
  const raw = row.municipality ?? row.municipality_name ?? row.name ?? '';
  return centroidByName(raw)?.name ?? String(raw).trim();
}

/** [[nome, contagem], ...] em ordem decrescente (empate: alfabética). */
export function countBy(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
}

function irtcBullet(irtc) {
  const rows = asArray(irtc);
  if (!rows) return null;
  const level = (r) => fold(r?.risk_level);
  const criticos = rows.filter((r) => level(r) === 'critico');
  const altos = rows.filter((r) => level(r) === 'alto');
  const total = criticos.length + altos.length;
  if (total === 0) {
    return rows.length ? { text: 'Nenhum município com IRTC alto ou crítico', weight: 0 } : null;
  }
  const top = [...criticos, ...altos].sort((a, b) => Number(b.irtc_score ?? 0) - Number(a.irtc_score ?? 0))[0];
  const topName = municipioName(top);
  const extra = criticos.length ? ` (${plural(criticos.length, 'crítico', 'críticos')})` : '';
  const lead = topName ? `, maior índice em ${topName} (${Number(top.irtc_score ?? 0).toFixed(0)})` : '';
  return {
    text: `${plural(total, 'município', 'municípios')} com IRTC alto${extra}${lead}`,
    weight: criticos.length ? 3 : 2,
  };
}

function cemadenBullet(cemaden) {
  const rows = asArray(cemaden);
  if (!rows) return null;
  if (rows.length === 0) return { text: 'Nenhum alerta CEMADEN ativo', weight: 0 };
  const maximos = rows.filter((r) => fold(r?.severity) === 'alerta_maximo').length;
  const [top] = countBy(rows, municipioName);
  const n = rows.length;
  const head = `${plural(n, 'alerta CEMADEN ativo', 'alertas CEMADEN ativos')}`;
  let where = '';
  if (top) where = n === 1 ? ` em ${top[0]}` : ` (${top[1]} em ${top[0]})`;
  const max = maximos ? `, ${plural(maximos, 'de alerta máximo', 'de alerta máximo')}` : '';
  return { text: `${head}${where}${max}`, weight: maximos ? 3 : 2 };
}

function firesBullet(fires, windowHours) {
  const rows = asArray(fires, 'fires');
  if (!rows) return null;
  if (rows.length === 0) return { text: `Nenhum foco de calor nas últimas ${windowHours} h`, weight: 0 };
  const [top] = countBy(rows, municipioName);
  const where = top ? `, maior concentração em ${top[0]} (${top[1]})` : '';
  return {
    text: `${plural(rows.length, 'foco de calor', 'focos de calor')} nas últimas ${windowHours} h${where}`,
    weight: rows.length >= 100 ? 2 : 1,
  };
}

function incidentsBullet(incidents) {
  const rows = asArray(incidents);
  if (!rows) return null;
  if (rows.length === 0) return { text: 'Nenhum incidente ativo', weight: 0 };
  const sev = (r) => fold(r?.severity);
  const criticos = rows.filter((r) => sev(r) === 'critical' || sev(r) === 'critico').length;
  const altos = rows.filter((r) => sev(r) === 'high' || sev(r) === 'alto').length;
  const parts = [];
  if (criticos) parts.push(plural(criticos, 'crítico', 'críticos'));
  if (altos) parts.push(`${altos} de severidade alta`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  const recent = rows[0]?.title ? `; mais recente: ${String(rows[0].title).trim()}` : '';
  return {
    text: `${plural(rows.length, 'incidente ativo', 'incidentes ativos')}${detail}${recent}`,
    weight: criticos ? 3 : altos ? 2 : 1,
  };
}

function dengueBullet(dengue) {
  const rows = asArray(dengue, 'rows');
  if (!rows || rows.length === 0) return null;
  const lvl = (r) => Math.trunc(Number(r?.alert_level ?? 0)) || 0;
  const n3 = rows.filter((r) => lvl(r) >= 3).length;
  const n4 = rows.filter((r) => lvl(r) >= 4).length;
  const cases = rows.reduce((sum, r) => sum + (Number(r?.cases) || 0), 0);
  const se = dengue?.week && dengue?.year ? `SE ${dengue.week}/${dengue.year}: ` : '';
  const casos = plural(Math.round(cases), 'caso', 'casos');
  if (n3 === 0) return { text: `Dengue ${se}${casos}, nenhum município em nível 3 ou 4`, weight: 0 };
  const vermelho = n4 ? ` (${n4} em nível 4)` : '';
  return {
    text: `Dengue ${se}${plural(n3, 'município', 'municípios')} em alerta nível 3+${vermelho}, ${casos} no estado`,
    weight: n4 ? 2 : 1,
  };
}

function formatStamp(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'America/Sao_Paulo',
    }).format(date).replace(',', '');
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

const LEVEL_TEXT = {
  elevado: 'Situação de atenção elevada no Paraná.',
  atencao: 'Situação de atenção moderada no Paraná.',
  normal: 'Sem sinais relevantes de risco nas bases monitoradas.',
};

export function buildHeuristicBriefing({
  irtc, cemaden, fires, incidents, dengue, now = new Date(), firesWindowHours = 48,
} = {}) {
  const items = [
    irtcBullet(irtc),
    cemadenBullet(cemaden),
    firesBullet(fires, firesWindowHours),
    incidentsBullet(incidents),
    dengueBullet(dengue),
  ].filter(Boolean);

  const stamp = formatStamp(now);
  const title = `BRIEFING AUTOMÁTICO${stamp ? ` · ${stamp}` : ''}`;
  if (items.length === 0) {
    return {
      title,
      summary: 'Sem dados disponíveis no momento; as bases do DataGeo não responderam.',
      bullets: [],
      level: 'indisponivel',
    };
  }

  const maxWeight = Math.max(...items.map((i) => i.weight));
  const level = maxWeight >= 3 ? 'elevado' : maxWeight >= 2 ? 'atencao' : 'normal';
  const bullets = [...items].sort((a, b) => b.weight - a.weight).map((i) => i.text);
  return {
    title,
    summary: `${LEVEL_TEXT[level]} Síntese heurística dos dados ao vivo; o relatório situacional de hoje ainda não foi publicado.`,
    bullets,
    level,
  };
}
