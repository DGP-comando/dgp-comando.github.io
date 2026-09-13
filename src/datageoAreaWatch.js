// src/datageoAreaWatch.js
//
// VIGILÂNCIA de municípios: o operador marca até 10 municípios (botão VIGIAR
// na ficha) e este painel acompanha focos de calor, alertas CEMADEN e
// incidentes ativos em cada um. A cada ciclo compara com a varredura anterior
// (motor em data/areaWatch.js) e publica eventos: "+2 focos em Guarapuava 14:32".
//
// Canto inferior DIREITO, espelhando o briefing (left:16px bottom:120px) e
// acima do ticker (26px) e do command dock (bottom 2vh, z 145).
//
// Eventos: window 'dgp:area-watch-event' (cada novo evento) e
// 'dgp:area-watch-changed' (lista de vigiados mudou; a ficha escuta).
// Notification só se a permissão JÁ foi concedida; nunca pede.

import {
  MAX_WATCHES,
  WATCH_SOURCES,
  addWatch,
  createAreaWatch,
  formatWatchEvent,
  loadWatches,
  normalizeIbge,
  removeWatch,
  saveWatches,
} from './data/areaWatch.js';
import {
  AREA_EXPORT_COLUMNS,
  buildAreaExportRows,
  downloadText,
  exportFilename,
  toCsv,
  toGeoJson,
} from './data/areaExport.js';

const FEED_MAX = 40;
const SOURCE_SHORT = { fires: 'focos', cemaden: 'CEMADEN', incidents: 'incid.' };
// Focos saem da janela de 48 h sozinhos: só anunciamos a SAÍDA de alertas e incidentes.
const ANNOUNCE_EXIT = new Set(['cemaden', 'incidents']);

/**
 * Um alerta CEMADEN some da consulta também quando o issued_at passa da
 * janela de 3 dias, ainda vigente. Só conta como encerrado se expirou.
 */
function reallyClosed(source, item, at) {
  if (source !== 'cemaden') return true;
  const expires = Date.parse(item?.expires_at ?? '');
  return Number.isFinite(expires) && expires <= at.getTime();
}

let _instance = null;

function injectStyles() {
  if (document.getElementById('datageo-area-watch-style')) return;
  const style = document.createElement('style');
  style.id = 'datageo-area-watch-style';
  style.textContent = `
    #datageo-area-watch {
      position: fixed;
      right: 16px;
      bottom: 120px;
      width: min(300px, calc(100vw - 32px));
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      font-family: 'JetBrains Mono', monospace;
      z-index: 56;
      color: #cbd5e1;
      pointer-events: none;
    }
    #datageo-area-watch > * { pointer-events: auto; }
    #datageo-area-watch .aw-toggle {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      background: rgba(3, 10, 18, 0.85);
      border: 1px solid rgba(34, 211, 238, 0.3);
      border-radius: 6px;
      color: #22d3ee; font: inherit; font-size: 11px; letter-spacing: 0.12em;
      cursor: pointer; user-select: none;
    }
    #datageo-area-watch .aw-toggle:hover, #datageo-area-watch .aw-toggle:focus-visible { border-color: rgba(34, 211, 238, 0.6); }
    #datageo-area-watch .aw-count { color: #64748b; }
    #datageo-area-watch .aw-badge {
      min-width: 16px; padding: 0 5px; border-radius: 8px;
      background: #ef4444; color: #fff; font-size: 10px; letter-spacing: 0; text-align: center;
    }
    #datageo-area-watch .aw-badge[hidden] { display: none; }
    #datageo-area-watch .aw-card {
      width: 100%;
      margin-bottom: 8px;
      padding: 10px 12px;
      background: rgba(3, 10, 18, 0.9);
      border: 1px solid rgba(34, 211, 238, 0.25);
      border-radius: 8px;
      font-size: 11px; line-height: 1.5;
      max-height: 46vh; overflow-y: auto;
      display: none;
      box-sizing: border-box;
    }
    #datageo-area-watch.open .aw-card { display: block; }
    #datageo-area-watch h3 {
      color: #7dd3fc; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;
      border-bottom: 1px dashed rgba(125, 211, 252, 0.25); padding-bottom: 3px; margin: 0 0 6px;
    }
    #datageo-area-watch .aw-feed-title { margin-top: 10px; }
    #datageo-area-watch .aw-area { padding: 5px 0; border-bottom: 1px solid rgba(148, 163, 184, 0.08); }
    #datageo-area-watch .aw-area-head { display: flex; align-items: center; gap: 6px; }
    #datageo-area-watch .aw-name { flex: 1; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #datageo-area-watch .aw-btn {
      background: none; border: 1px solid rgba(34, 211, 238, 0.3); border-radius: 4px;
      color: #7dd3fc; font: inherit; font-size: 9px; letter-spacing: 0.08em; padding: 1px 5px; cursor: pointer;
    }
    #datageo-area-watch .aw-btn:hover { color: #22d3ee; border-color: rgba(34, 211, 238, 0.6); }
    #datageo-area-watch .aw-remove { border-color: transparent; color: #64748b; font-size: 12px; padding: 0 4px; }
    #datageo-area-watch .aw-remove:hover { color: #ef4444; border-color: transparent; }
    #datageo-area-watch .aw-counts { color: #64748b; font-size: 10px; }
    #datageo-area-watch .aw-hot { color: #f59e0b; }
    #datageo-area-watch .aw-empty { color: #64748b; }
    #datageo-area-watch .aw-event { margin: 2px 0; }
    #datageo-area-watch .aw-event.aw-entered { color: #f59e0b; }
    #datageo-area-watch .aw-event.aw-exited { color: #94a3b8; }
    #datageo-area-watch .aw-status { color: #475569; font-size: 9px; margin-top: 8px; }
    @media (max-width: 700px) {
      #datageo-area-watch { right: 8px; bottom: 84px; }
    }
  `;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emit(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch (err) {
    console.warn('[DataGeo:vigilância] evento falhou:', err);
  }
}

function notifyIfGranted(text) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // eslint-disable-next-line no-new
    new Notification('DGP · Vigilância', { body: text, tag: 'dgp-area-watch' });
  } catch {
    // Alguns navegadores só aceitam Notification via service worker: ignore.
  }
}

/**
 * initDatageoAreaWatch({ fetchers: { fires, cemaden, incidents }, pollMs })
 * -> { destroy, watchMunicipio, unwatch, isWatched, exportArea, pollNow, open, close, toggle, getWatches }
 */
export function initDatageoAreaWatch({ fetchers = {}, pollMs = 5 * 60_000, storage } = {}) {
  if (_instance) _instance.destroy();
  injectStyles();

  const store = storage; // undefined = localStorage (default dos helpers)
  let watches = loadWatches(store);
  const engines = new Map();
  const snapshot = {}; // source -> última lista recebida (Paraná inteiro)
  let feed = [];
  let unread = 0;
  let lastPollAt = 0;
  let inflight = null;
  let lastError = '';
  let destroyed = false;

  const container = el('div');
  container.id = 'datageo-area-watch';
  const card = el('div', 'aw-card');
  card.id = 'datageo-area-watch-card';
  const toggleBtn = el('button', 'aw-toggle');
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-controls', card.id);
  toggleBtn.title = 'Vigilância de municípios (atalho A)';
  container.append(card, toggleBtn);
  document.body.appendChild(container);

  const engineFor = (w) => {
    if (!engines.has(w.ibge)) {
      engines.set(w.ibge, createAreaWatch({ areaId: w.ibge, label: w.nome, matchers: { ibge: w.ibge, nome: w.nome } }));
    }
    return engines.get(w.ibge);
  };

  function baselineFromSnapshot(w) {
    const engine = engineFor(w);
    for (const source of WATCH_SOURCES) {
      if (Array.isArray(snapshot[source]) && !engine.hasBaseline(source)) engine.sweep(snapshot[source], { source });
    }
  }

  function persistAndAnnounce(ibge, watched) {
    saveWatches(watches, store);
    emit('dgp:area-watch-changed', { ibge, watched, watches: watches.map((w) => ({ ...w })) });
    render();
  }

  function watchMunicipio(ibge, nome) {
    const result = addWatch(watches, { ibge, nome });
    if (!result.added) return { ok: result.reason === 'exists', reason: result.reason };
    watches = result.list;
    const entry = watches.find((w) => w.ibge === normalizeIbge(ibge));
    baselineFromSnapshot(entry);
    persistAndAnnounce(entry.ibge, true);
    if (!WATCH_SOURCES.some((s) => Array.isArray(snapshot[s]))) pollNow();
    return { ok: true, reason: null };
  }

  function unwatch(ibge) {
    const code = normalizeIbge(ibge);
    if (!watches.some((w) => w.ibge === code)) return false;
    watches = removeWatch(watches, code);
    engines.delete(code);
    feed = feed.filter((e) => e.ibge !== code);
    persistAndAnnounce(code, false);
    return true;
  }

  const isWatched = (ibge) => watches.some((w) => w.ibge === normalizeIbge(ibge));

  function exportArea(ibge, format = 'csv') {
    const w = watches.find((x) => x.ibge === normalizeIbge(ibge));
    if (!w) return false;
    const rows = buildAreaExportRows({ ibge: w.ibge, nome: w.nome, ...snapshot });
    const now = new Date();
    if (format === 'geojson') {
      const gj = toGeoJson(rows, { name: `Vigilância ${w.nome} (${w.ibge})` });
      return downloadText(exportFilename({ nome: w.nome, ibge: w.ibge, ext: 'geojson', now }),
        JSON.stringify(gj, null, 2), 'application/geo+json;charset=utf-8');
    }
    return downloadText(exportFilename({ nome: w.nome, ibge: w.ibge, ext: 'csv', now }),
      toCsv(rows, AREA_EXPORT_COLUMNS), 'text/csv;charset=utf-8');
  }

  function pushEvent(w, source, kind, items, at) {
    const text = formatWatchEvent({ source, kind, count: items.length, nome: w.nome, at });
    const event = { id: `${at.getTime()}-${w.ibge}-${source}-${kind}`, ibge: w.ibge, nome: w.nome, source, kind, count: items.length, text, at: at.getTime() };
    feed = [event, ...feed].slice(0, FEED_MAX);
    if (!container.classList.contains('open')) unread += 1;
    emit('dgp:area-watch-event', { ...event, items });
    if (kind === 'entered') notifyIfGranted(text);
  }

  async function pollNow({ force = false } = {}) {
    if (inflight) {
      // Uma varredura já está em curso: automáticas pegam carona nela; a
      // forçada espera terminar e roda de novo com dados frescos.
      await inflight;
      if (!force || inflight) return inflight ?? undefined;
    }
    if (destroyed) return undefined;
    if (!force && typeof document !== 'undefined' && document.hidden) return undefined;
    inflight = runPoll().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function runPoll() {
    // Sem município vigiado não há o que varrer; watchMunicipio força a
    // primeira varredura quando alguém é adicionado.
    if (watches.length === 0) {
      render();
      return;
    }
    try {
      const names = WATCH_SOURCES.filter((s) => typeof fetchers[s] === 'function');
      const settled = await Promise.allSettled(names.map((s) => fetchers[s]()));
      if (destroyed) return;
      const at = new Date();
      const errors = [];
      names.forEach((source, i) => {
        const r = settled[i];
        if (r.status !== 'fulfilled' || !Array.isArray(r.value)) {
          errors.push(SOURCE_SHORT[source]);
          return; // mantém a varredura anterior; falha de rede não vira "saída"
        }
        snapshot[source] = r.value;
        for (const w of watches) {
          const { entered, exited, baseline } = engineFor(w).sweep(r.value, { source });
          if (baseline) continue;
          if (entered.length) pushEvent(w, source, 'entered', entered, at);
          const closed = exited.filter((item) => reallyClosed(source, item, at));
          if (closed.length && ANNOUNCE_EXIT.has(source)) pushEvent(w, source, 'exited', closed, at);
        }
      });
      lastPollAt = at.getTime();
      lastError = errors.length ? `falha: ${errors.join(', ')}` : '';
    } finally {
      render();
    }
  }

  function setOpen(open) {
    container.classList.toggle('open', open);
    toggleBtn.setAttribute('aria-expanded', String(open));
    if (open) unread = 0;
    render();
  }

  function renderArea(w) {
    const engine = engines.get(w.ibge);
    const box = el('div', 'aw-area');
    const head = el('div', 'aw-area-head');
    const name = el('span', 'aw-name', w.nome);
    name.title = `IBGE ${w.ibge}`;
    const csv = el('button', 'aw-btn', 'CSV');
    csv.type = 'button';
    csv.title = `Exportar focos, alertas e incidentes de ${w.nome} (CSV)`;
    csv.addEventListener('click', () => exportArea(w.ibge, 'csv'));
    const geo = el('button', 'aw-btn', 'GEOJSON');
    geo.type = 'button';
    geo.title = `Exportar focos de ${w.nome} com coordenadas (GeoJSON)`;
    geo.addEventListener('click', () => exportArea(w.ibge, 'geojson'));
    const remove = el('button', 'aw-btn aw-remove', '✕');
    remove.type = 'button';
    remove.title = `Parar de vigiar ${w.nome}`;
    remove.setAttribute('aria-label', `Parar de vigiar ${w.nome}`);
    remove.addEventListener('click', () => unwatch(w.ibge));
    head.append(name, csv, geo, remove);

    const counts = el('div', 'aw-counts');
    WATCH_SOURCES.forEach((source, i) => {
      if (i) counts.append(' · ');
      const known = engine?.hasBaseline(source);
      const n = known ? engine.count(source) : null;
      const span = el('span', n ? 'aw-hot' : '', `${SOURCE_SHORT[source]} ${n ?? '-'}`);
      counts.append(span);
    });
    box.append(head, counts);
    return box;
  }

  function render() {
    if (destroyed) return;
    toggleBtn.replaceChildren(
      el('span', '', '◉ VIGILÂNCIA'),
      el('span', 'aw-count', `${watches.length}/${MAX_WATCHES}`),
    );
    const badge = el('span', 'aw-badge', String(unread > 99 ? '99+' : unread));
    badge.hidden = unread === 0;
    badge.setAttribute('aria-label', `${unread} eventos não lidos`);
    toggleBtn.append(badge);

    const parts = [el('h3', '', 'Municípios vigiados')];
    if (watches.length === 0) {
      parts.push(el('div', 'aw-empty', 'Nenhum município vigiado. Abra a ficha de um município e clique em VIGIAR.'));
    } else {
      parts.push(...watches.map(renderArea));
    }
    parts.push(el('h3', 'aw-feed-title', 'Eventos'));
    if (feed.length === 0) {
      parts.push(el('div', 'aw-empty', 'Sem mudanças desde a última varredura.'));
    } else {
      parts.push(...feed.map((e) => el('div', `aw-event aw-${e.kind}`, e.text)));
    }
    const status = lastPollAt
      ? `Atualizado ${new Date(lastPollAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · a cada ${Math.round(pollMs / 60_000)} min${lastError ? ` · ${lastError}` : ''}`
      : 'Aguardando primeira varredura';
    parts.push(el('div', 'aw-status', status));
    card.replaceChildren(...parts);
  }

  toggleBtn.addEventListener('click', () => setOpen(!container.classList.contains('open')));

  const onVisibility = () => {
    if (!document.hidden && Date.now() - lastPollAt >= pollMs) pollNow();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const interval = setInterval(() => pollNow(), pollMs);
  render();
  pollNow();

  const api = {
    watchMunicipio,
    unwatch,
    isWatched,
    exportArea,
    pollNow: () => pollNow({ force: true }),
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!container.classList.contains('open')),
    getWatches: () => watches.map((w) => ({ ...w })),
    destroy() {
      destroyed = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      container.remove();
      if (_instance === api) _instance = null;
    },
  };
  _instance = api;
  return api;
}

/** Exporta (CSV) os dados atuais do município vigiado. false se não houver painel/área. */
export function exportWatchedArea(ibge, format = 'csv') {
  return _instance ? _instance.exportArea(ibge, format) : false;
}

export function watchMunicipio(ibge, nome) {
  return _instance ? _instance.watchMunicipio(ibge, nome) : { ok: false, reason: 'not-initialized' };
}

export function unwatch(ibge) {
  return _instance ? _instance.unwatch(ibge) : false;
}

export function isWatched(ibge) {
  return _instance ? _instance.isWatched(ibge) : false;
}
