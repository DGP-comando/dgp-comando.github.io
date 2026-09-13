// src/data/areaWatch.js
//
// Motor de "tripwire" por área (inspirado em osiris lib/watch.ts). A área
// vigiada é um município do Paraná (código IBGE de 7 dígitos + nome). A cada
// refresh das fontes (focos, CEMADEN, incidentes) o motor compara os ids que
// pertencem à área com os da varredura anterior e devolve o que ENTROU e o
// que SAIU. A primeira varredura de cada fonte é uma linha de base silenciosa:
// sem ela, abrir o painel dispararia "+40 focos" que já existiam.
//
// Puro (sem DOM, sem rede). O store de localStorage recebe o storage por
// parâmetro para ser testável e nunca lança.

export const MAX_WATCHES = 10;
export const WATCH_STORAGE_KEY = 'dgp:area-watches:v1';
export const WATCH_SOURCES = Object.freeze(['fires', 'cemaden', 'incidents']);

const SOURCE_NOUNS = Object.freeze({
  fires: ['foco', 'focos'],
  cemaden: ['alerta CEMADEN', 'alertas CEMADEN'],
  incidents: ['incidente', 'incidentes'],
});

const EXIT_VERBS = Object.freeze({
  fires: ['expirado', 'expirados'],
  cemaden: ['encerrado', 'encerrados'],
  incidents: ['encerrado', 'encerrados'],
});

// --- normalização -----------------------------------------------------------

/** Minúsculas, sem acento, só [a-z0-9] separados por um espaço. */
export function foldName(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Código IBGE como string de dígitos (7, ou 6 sem o dígito verificador). */
export function normalizeIbge(code) {
  const digits = String(code ?? '').trim().replace(/\.0+$/, '');
  return /^\d{6,7}$/.test(digits) ? digits : '';
}

/** Compara códigos tolerando a forma de 6 dígitos (sem DV) usada por algumas bases. */
export function sameIbge(a, b) {
  const x = normalizeIbge(a);
  const y = normalizeIbge(b);
  if (!x || !y) return false;
  if (x.length === y.length) return x === y;
  return x.slice(0, 6) === y.slice(0, 6);
}

const NAME_KEYS = ['municipality', 'municipality_name', 'municipio', 'nome', 'name'];
const CODE_KEYS = ['ibge_code', 'ibgeCode', 'ibge', 'cod_ibge', 'code'];

function firstValue(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

/**
 * Predicado "item pertence ao município". Aceita:
 *  - ibge_code (ou variações) igual ao código;
 *  - nome do município (municipality, municipality_name...) igual sem acento;
 *  - affected_municipalities: [{ ibge_code, name? }] ou ['4109401', 'Guarapuava'].
 */
export function belongsToMunicipio({ ibge, nome } = {}) {
  const code = normalizeIbge(ibge);
  const folded = foldName(nome);
  const matchesEntry = (entry) => {
    if (entry === null || entry === undefined) return false;
    if (typeof entry !== 'object') {
      return (code && sameIbge(entry, code)) || (folded && foldName(entry) === folded);
    }
    const entryCode = firstValue(entry, CODE_KEYS);
    if (code && entryCode !== undefined) return sameIbge(entryCode, code);
    const entryName = firstValue(entry, NAME_KEYS);
    return Boolean(folded && entryName !== undefined && foldName(entryName) === folded);
  };
  return (item) => {
    if (!item || typeof item !== 'object') return false;
    if (Array.isArray(item.affected_municipalities)) {
      return item.affected_municipalities.some(matchesEntry);
    }
    return matchesEntry(item);
  };
}

// --- ids estáveis entre refreshes -----------------------------------------------

const coord = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : '');

export const SOURCE_ID_GETTERS = Object.freeze({
  fires: (f) =>
    [f?.acqDate ?? f?.acq_date ?? '', f?.acqTime ?? f?.acq_time ?? '',
      coord(f?.lat ?? f?.latitude), coord(f?.lon ?? f?.longitude), f?.satellite ?? ''].join('|'),
  cemaden: (a) =>
    a?.alert_code
      ? `code:${a.alert_code}`
      : [a?.ibge_code ?? a?.municipality ?? '', a?.alert_type ?? '', a?.issued_at ?? ''].join('|'),
  incidents: (i) => (i?.id !== undefined && i?.id !== null ? `id:${i.id}` : `t:${i?.title ?? ''}|${i?.detected_at ?? ''}`),
});

// --- motor ----------------------------------------------------------------------

/**
 * createAreaWatch({ areaId, label, matchers: { ibge, nome } })
 * sweep(items, { source, getId, belongsToArea }) -> { entered, exited, baseline, count }
 */
export function createAreaWatch({ areaId, label, matchers = {} } = {}) {
  const ibge = normalizeIbge(matchers.ibge ?? matchers.ibge_code ?? areaId);
  const nome = String(matchers.nome ?? matchers.name ?? label ?? '');
  const defaultBelongs = belongsToMunicipio({ ibge, nome });
  /** @type {Map<string, Map<string, object>>} */
  const previous = new Map();

  function sweep(items, { source, getId, belongsToArea } = {}) {
    if (!source) throw new Error('areaWatch.sweep: source é obrigatório');
    const idOf = getId ?? SOURCE_ID_GETTERS[source];
    if (typeof idOf !== 'function') throw new Error(`areaWatch.sweep: sem getId para "${source}"`);
    const belongs = belongsToArea ?? defaultBelongs;

    const current = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!belongs(item)) continue;
      const id = String(idOf(item));
      if (id && !current.has(id)) current.set(id, item);
    }

    const prev = previous.get(source);
    previous.set(source, current);
    if (!prev) return { entered: [], exited: [], baseline: true, count: current.size };

    const entered = [...current].filter(([id]) => !prev.has(id)).map(([, item]) => item);
    const exited = [...prev].filter(([id]) => !current.has(id)).map(([, item]) => item);
    return { entered, exited, baseline: false, count: current.size };
  }

  return Object.freeze({
    areaId: ibge || String(areaId ?? ''),
    label: nome,
    belongsToArea: defaultBelongs,
    sweep,
    hasBaseline: (source) => previous.has(source),
    count: (source) => previous.get(source)?.size ?? 0,
    items: (source) => [...(previous.get(source)?.values() ?? [])],
    reset: (source) => (source ? previous.delete(source) : previous.clear()),
  });
}

// --- texto dos eventos ----------------------------------------------------------

export function formatClock(at, timeZone = 'America/Sao_Paulo') {
  const date = at instanceof Date ? at : new Date(at ?? Date.now());
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
      .format(date);
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
}

/** "+2 focos em Guarapuava 14:32" / "-1 alerta CEMADEN encerrado em Curitiba 09:05" */
export function formatWatchEvent({ source, kind = 'entered', count, nome, at, timeZone } = {}) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const [one, many] = SOURCE_NOUNS[source] ?? ['evento', 'eventos'];
  const noun = n === 1 ? one : many;
  const clock = formatClock(at, timeZone);
  const tail = `em ${nome ?? ''}${clock ? ` ${clock}` : ''}`;
  if (kind === 'exited') {
    const [vOne, vMany] = EXIT_VERBS[source] ?? ['encerrado', 'encerrados'];
    return `-${n} ${noun} ${n === 1 ? vOne : vMany} ${tail}`;
  }
  return `+${n} ${noun} ${tail}`;
}

// --- lista de áreas vigiadas + store --------------------------------------------

function sanitizeEntry(entry) {
  const ibge = normalizeIbge(entry?.ibge);
  const nome = String(entry?.nome ?? '').trim().slice(0, 80);
  if (!ibge || ibge.length !== 7 || !nome) return null;
  const addedAt = Number.isFinite(Number(entry?.addedAt)) ? Number(entry.addedAt) : 0;
  return { ibge, nome, addedAt };
}

export function sanitizeWatches(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = sanitizeEntry(raw);
    if (!entry || seen.has(entry.ibge)) continue;
    seen.add(entry.ibge);
    out.push(entry);
    if (out.length >= MAX_WATCHES) break;
  }
  return out;
}

/** Retorna { list, added, reason } sem mutar a lista recebida. */
export function addWatch(list, { ibge, nome }, now = Date.now()) {
  const current = sanitizeWatches(list);
  const entry = sanitizeEntry({ ibge, nome, addedAt: now });
  if (!entry) return { list: current, added: false, reason: 'invalid' };
  if (current.some((w) => w.ibge === entry.ibge)) return { list: current, added: false, reason: 'exists' };
  if (current.length >= MAX_WATCHES) return { list: current, added: false, reason: 'limit' };
  return { list: [...current, entry], added: true, reason: null };
}

export function removeWatch(list, ibge) {
  const code = normalizeIbge(ibge);
  return sanitizeWatches(list).filter((w) => w.ibge !== code);
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadWatches(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(WATCH_STORAGE_KEY);
    return raw ? sanitizeWatches(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveWatches(list, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(WATCH_STORAGE_KEY, JSON.stringify(sanitizeWatches(list)));
    return true;
  } catch {
    return false;
  }
}
