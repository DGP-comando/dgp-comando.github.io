// src/data/areaExport.js
//
// Exportação dos dados operacionais de uma área vigiada (focos, CEMADEN,
// incidentes). CSV no formato que o Excel pt-BR abre direto: separador ';',
// vírgula decimal e BOM UTF-8 (sem o BOM o Excel lê "Guaíra" como "GuaÃ­ra").
// GeoJSON em WGS84 (EPSG:4326, [lon, lat]) conforme RFC 7946.
//
// toCsv/toGeoJson/buildAreaExportRows são puros; downloadText é o único
// helper de DOM. Dados públicos operacionais, sem dado pessoal (LGPD).

import { belongsToMunicipio, foldName } from './areaWatch.js';

export const UTF8_BOM = '﻿';

// Célula que começa com = + - @ (ou tab/CR), mesmo após espaços, vira fórmula
// no Excel/Sheets ("-1+cmd|..." é o formato clássico de DDE). Texto vindo de
// fonte externa recebe um apóstrofo; números reais são escritos como número
// por cellText e não passam por aqui.
const FORMULA_PREFIX = /^\s*[=+\-@\t\r]/;

function normalizeColumns(columns, rows) {
  const list = Array.isArray(columns) && columns.length
    ? columns
    : [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))];
  return list.map((col) => (typeof col === 'string' ? { key: col, label: col } : {
    key: col.key,
    label: col.label ?? col.key ?? '',
    value: col.value,
  }));
}

function cellText(value, { decimalComma }) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const text = String(value);
    return decimalComma ? text.replace('.', ',') : text;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function quote(text, separator) {
  const needs = text.includes(separator) || /["\r\n]/.test(text) || /^\s|\s$/.test(text);
  return needs ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV RFC 4180 (CRLF, aspas duplicadas). Opções:
 *  separator: ';' (Excel pt-BR) | ',' ; bom: true ; decimalComma: separator === ';'
 */
export function toCsv(rows, columns, { separator = ';', bom = true, decimalComma } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = normalizeColumns(columns, list);
  const opts = { decimalComma: decimalComma ?? separator === ';' };
  const header = cols.map((c) => quote(String(c.label), separator)).join(separator);
  const body = list.map((row) =>
    cols
      .map((c) => {
        const raw = typeof c.value === 'function' ? c.value(row) : row?.[c.key];
        return quote(cellText(raw, opts), separator);
      })
      .join(separator),
  );
  return (bom ? UTF8_BOM : '') + [header, ...body].join('\r\n') + '\r\n';
}

/** FeatureCollection de pontos; linhas sem coordenada válida são ignoradas. */
export function toGeoJson(rows, { latKey = 'lat', lonKey = 'lon', name } = {}) {
  const features = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const lat = Number(row[latKey]);
    const lon = Number(row[lonKey]);
    if (row[latKey] === null || row[lonKey] === null || row[latKey] === '' || row[lonKey] === '') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const properties = Object.fromEntries(
      Object.entries(row).filter(([k]) => k !== latKey && k !== lonKey),
    );
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
  }
  return { type: 'FeatureCollection', ...(name ? { name } : {}), features };
}

export const AREA_EXPORT_COLUMNS = Object.freeze([
  { key: 'fonte', label: 'fonte' },
  { key: 'municipio', label: 'municipio' },
  { key: 'ibge', label: 'ibge' },
  { key: 'data_hora', label: 'data_hora' },
  { key: 'tipo', label: 'tipo' },
  { key: 'severidade', label: 'severidade' },
  { key: 'status', label: 'status' },
  { key: 'descricao', label: 'descricao' },
  { key: 'lat', label: 'lat' },
  { key: 'lon', label: 'lon' },
]);

const fireTimestamp = (f) => {
  const hhmm = String(f.acqTime ?? f.acq_time ?? '').padStart(4, '0');
  const date = f.acqDate ?? f.acq_date ?? '';
  return date && /^\d{4}$/.test(hhmm) ? `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z` : date;
};

/**
 * Linhas unificadas (uma por foco/alerta/incidente) do município.
 * Fontes ausentes ou com erro são simplesmente omitidas.
 */
export function buildAreaExportRows({ ibge, nome, fires, cemaden, incidents } = {}) {
  const belongs = belongsToMunicipio({ ibge, nome });
  const arr = (v) => (Array.isArray(v) ? v : []);
  const base = { municipio: nome ?? '', ibge: String(ibge ?? '') };
  const rows = [];
  for (const f of arr(fires).filter(belongs)) {
    rows.push({
      fonte: 'FIRMS', ...base, data_hora: fireTimestamp(f),
      tipo: [f.satellite, f.instrument].filter(Boolean).join(' '),
      severidade: f.confidence ?? '', status: '', descricao: 'Foco de calor',
      lat: Number(f.lat ?? f.latitude), lon: Number(f.lon ?? f.longitude),
    });
  }
  for (const a of arr(cemaden).filter(belongs)) {
    rows.push({
      fonte: 'CEMADEN', ...base, data_hora: a.issued_at ?? '', tipo: a.alert_type ?? '',
      severidade: a.severity ?? '', status: a.expires_at ? `expira ${a.expires_at}` : 'ativo',
      descricao: a.description ?? '', lat: null, lon: null,
    });
  }
  for (const i of arr(incidents).filter(belongs)) {
    rows.push({
      fonte: 'INCIDENTE', ...base, data_hora: i.detected_at ?? '', tipo: i.type ?? '',
      severidade: i.severity ?? '', status: i.status ?? '', descricao: i.title ?? '',
      lat: null, lon: null,
    });
  }
  return rows;
}

/** "vigilancia-guarapuava-4109401-20260913-1432.csv" (ASCII, seguro em qualquer SO). */
export function exportFilename({ nome, ibge, ext = 'csv', now = new Date() } = {}) {
  const slug = foldName(nome).replace(/\s+/g, '-') || 'area';
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const code = String(ibge ?? '').replace(/\D/g, '');
  return `vigilancia-${slug}${code ? `-${code}` : ''}-${stamp}.${String(ext).replace(/[^a-z0-9]/gi, '')}`;
}

/** Dispara o download de um texto (Blob + <a download>). Retorna false se não houver DOM. */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8', doc = globalThis.document) {
  if (!doc?.createElement || typeof Blob === 'undefined' || !globalThis.URL?.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  return true;
}
