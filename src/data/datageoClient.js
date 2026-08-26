// src/data/datageoClient.js
//
// Cliente PostgREST do DataGeo PR (Supabase do c2-parana). Toda camada
// DataGeo passa por aqui — nenhuma fala com o Supabase por conta propria.
//
// Le direto do browser com a anon key (RLS anon-read, migration 008 do c2):
// sem proxy, sem dev-server, deployavel estatico. A anon key e client-exposed
// por design (a mesma vai no bundle do console React do DataGeo). Override
// via VITE_DATAGEO_SUPABASE_URL / VITE_DATAGEO_ANON_KEY quando o projeto
// Supabase mudar.

const SUPABASE_URL = (
  import.meta.env.VITE_DATAGEO_SUPABASE_URL || 'https://fialxjcsgywvvuxjxcly.supabase.co'
).replace(/\/+$/, '');

const ANON_KEY =
  import.meta.env.VITE_DATAGEO_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpYWx4amNzZ3l3dnZ1eGp4Y2x5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNjczNTMsImV4cCI6MjA4Nzk0MzM1M30.e3X-LSPVUbxl-P9KLB9TuGB0nkmZ4OrNyHL9SuxaRgM';

/**
 * GET numa tabela/view via PostgREST. `query` e a query string PostgREST
 * (sem o '?'), ja montada pelo chamador. Paginacao via Range quando `range`
 * e passado como [from, to].
 * @returns {Promise<Array<Object>>} linhas (nunca null; erro lanca).
 */
export async function dgSelect(table, query, { range = null, timeoutMs = 20_000 } = {}) {
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
  };
  if (range) {
    headers['Range-Unit'] = 'items';
    headers['Range'] = `${range[0]}-${range[1]}`;
  }
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`DataGeo ${table}: HTTP ${resp.status}`);
  }
  const rows = await resp.json();
  if (!Array.isArray(rows)) throw new Error(`DataGeo ${table}: resposta nao-array`);
  return rows;
}

/** Le o payload `data` de um cache_key do data_cache (null se ausente). */
export async function dgCache(cacheKey) {
  const rows = await dgSelect(
    'data_cache',
    `select=data,fetched_at&cache_key=eq.${encodeURIComponent(cacheKey)}&limit=1`,
  );
  return rows.length > 0 ? rows[0] : null;
}

const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Focos de calor das ultimas `windowHours` no shape que o firmsHeatmap
 * consome ({fetchedAt, stale, ttlMs, sources, count, fires}) — o mesmo
 * contrato do antigo proxy /api/firms, agora montado client-side a partir
 * de fire_spots. Janela default de 48 h: a fonte e o cron de 12 h do
 * DataGeo, e uma janela de 24 h estrita esvazia a camada logo apos cada
 * ciclo (a idade real de cada foco continua visivel no card).
 *
 * fire_spots nao persiste frp nem daynight — frp vai 0 (heat/tamanho
 * minimos) ate o ETL do c2 gravar o campo.
 */
export async function fetchFiresPayload({ windowHours = 48 } = {}) {
  const sinceDate = new Date(Date.now() - windowHours * 3600_000)
    .toISOString()
    .slice(0, 10);
  const select =
    'latitude,longitude,brightness,acq_date,acq_time,satellite,instrument,confidence,municipality';

  const rows = [];
  const page = 1000;
  for (let from = 0; from < 20_000; from += page) {
    const batch = await dgSelect(
      'fire_spots',
      `select=${select}&acq_date=gte.${sinceDate}&order=acq_date.desc,acq_time.desc`,
      { range: [from, from + page - 1] },
    );
    rows.push(...batch);
    if (batch.length < page) break;
  }

  const now = Date.now();
  const windowMs = windowHours * 3600_000;
  const forwardSlackMs = 2 * 3600_000;
  const fires = [];
  for (const row of rows) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const hhmm = String(row.acq_time ?? '').trim().padStart(4, '0');
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(row.acq_date ?? '') && /^\d{4}$/.test(hhmm)
      ? Date.parse(`${row.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`)
      : NaN;
    if (!Number.isFinite(ms) || ms < now - windowMs || ms > now + forwardSlackMs) continue;
    fires.push({
      lat,
      lon,
      frp: 0,
      confidence: typeof row.confidence === 'string' ? row.confidence : '',
      brightness: Number.isFinite(Number(row.brightness)) ? Number(row.brightness) : 0,
      brightnessTi5: 0,
      daynight: '',
      acqDate: row.acq_date,
      acqTime: String(row.acq_time ?? ''),
      satellite: typeof row.satellite === 'string' ? row.satellite : '',
      instrument: typeof row.instrument === 'string' ? row.instrument : 'VIIRS',
      municipality: typeof row.municipality === 'string' ? row.municipality : '',
    });
  }

  return {
    fetchedAt: now,
    stale: false,
    ttlMs: 10 * 60_000,
    sources: [{ source: 'DATAGEO_PR_SUPABASE', count: fires.length, ok: true }],
    count: fires.length,
    fires,
  };
}

/** Ultima leitura por estacao do INMET/Open-Meteo (janela de 24 h). */
export async function fetchClimateStations() {
  const since = isoZ(new Date(Date.now() - 24 * 3600_000));
  const rows = await dgSelect(
    'climate_data',
    'select=station_code,station_name,municipality,ibge_code,latitude,longitude,' +
      'temperature,humidity,precipitation,wind_speed,observed_at' +
      `&observed_at=gte.${since}&order=observed_at.desc&limit=2000`,
  );
  const byStation = new Map();
  for (const row of rows) {
    const code = row.station_code ?? '';
    if (!code || byStation.has(code)) continue;
    if (!Number.isFinite(Number(row.latitude)) || !Number.isFinite(Number(row.longitude))) continue;
    byStation.set(code, row);
  }
  return [...byStation.values()];
}

/** Estacoes fluviometricas (linha mais recente por estacao). */
export async function fetchRiverStations() {
  const rows = await dgSelect(
    'river_levels',
    'select=station_code,station_name,river_name,municipality,latitude,longitude,' +
      'level_cm,flow_m3s,alert_level,observed_at&order=observed_at.desc&limit=200',
  );
  const byStation = new Map();
  for (const row of rows) {
    const code = row.station_code ?? '';
    if (!code || byStation.has(code)) continue;
    byStation.set(code, row);
  }
  return [...byStation.values()];
}

/** Alertas CEMADEN ativos (ultimos 3 dias, nao expirados). */
export async function fetchCemadenAlerts() {
  const cutoff = isoZ(new Date(Date.now() - 3 * 86_400_000));
  const nowIso = isoZ(new Date());
  return dgSelect(
    'cemaden_alerts',
    'select=alert_code,alert_type,severity,municipality,ibge_code,description,' +
      `issued_at,expires_at&issued_at=gte.${cutoff}` +
      `&or=(expires_at.is.null,expires_at.gt.${nowIso})&order=issued_at.desc&limit=500`,
  );
}

/** IRTC dos 399 municipios. */
export async function fetchIrtcScores() {
  return dgSelect(
    'irtc_scores',
    'select=ibge_code,municipality,irtc_score,risk_level,dominant_domain,' +
      'data_coverage,risk_clima,risk_saude,risk_ambiente,risk_hidro,risk_ar,calculated_at' +
      '&order=irtc_score.desc&limit=500',
  );
}

/** Dengue: ultima semana epidemiologica disponivel, por municipio. */
export async function fetchDengueLatestWeek() {
  const latest = await dgSelect(
    'dengue_data',
    'select=year,epidemiological_week&order=year.desc,epidemiological_week.desc&limit=1',
  );
  if (latest.length === 0) return { year: null, week: null, rows: [] };
  const { year, epidemiological_week: week } = latest[0];
  const rows = await dgSelect(
    'dengue_data',
    'select=ibge_code,municipality_name,cases,cases_est,alert_level,incidence_rate' +
      `&year=eq.${year}&epidemiological_week=eq.${week}&limit=500`,
  );
  return { year, week, rows };
}
