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

/** Qualidade do ar AQICN nas cidades monitoradas (linha mais recente por cidade). */
export async function fetchAirQuality() {
  const rows = await dgSelect(
    'air_quality',
    'select=city,station_name,aqi,dominant_pollutant,pm25,pm10,o3,no2,observed_at' +
      '&order=observed_at.desc&limit=200',
  );
  const byCity = new Map();
  for (const row of rows) {
    const city = row.city ?? '';
    if (!city || byCity.has(city)) continue;
    byCity.set(city, row);
  }
  return [...byCity.values()];
}

/** Anomalias estatisticas (z-score) dos ultimos 7 dias. */
export async function fetchAnomalies() {
  const cutoff = isoZ(new Date(Date.now() - 7 * 86_400_000));
  return dgSelect(
    'anomalies',
    'select=domain,indicator,station_code,municipality,observed_value,z_score,' +
      `window_mean,detected_at&detected_at=gte.${cutoff}&order=detected_at.desc&limit=200`,
  );
}

/** Incidentes OODA ativos (nao resolvidos/fechados). */
export async function fetchActiveIncidents() {
  return dgSelect(
    'incidents',
    'select=id,title,type,severity,status,detected_at,affected_municipalities' +
      '&status=not.in.(resolved,closed)&order=detected_at.desc&limit=200',
  );
}

/** Estacoes de telemetria InfoHidro/SIMEPAR (cache do scrape-infohidro). */
export async function fetchInfohidroStations() {
  const cached = await dgCache('infohidro_estacoes_pr');
  if (!cached) return [];
  const payload = cached.data;
  const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
  return Array.isArray(items) ? items : [];
}

/** Ultimas noticias do PR (ticker). */
export async function fetchNews(limit = 30) {
  return dgSelect(
    'news_items',
    `select=title,source,url,urgency,published_at&order=published_at.desc&limit=${limit}`,
  );
}

/** Relatorio situacional mais recente. */
export async function fetchLatestSituationalReport() {
  const rows = await dgSelect(
    'situational_reports',
    'select=report_date,executive_summary,recommendations,active_alerts_count,' +
      'top_risks,generated_at&order=report_date.desc&limit=1',
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Grade de vento a 10 m sobre o PR (Open-Meteo, gratuito e sem chave) no
 * formato do cesium-wind-layer: componentes u/v em Float32Array row-major,
 * linha 0 = SUL (flipY false, convencao default da lib).
 * Grade 22x15 (~0,33 graus) e suficiente para o efeito nullschool estadual.
 */
export async function fetchWindGrid() {
  const bounds = { west: -55.0, south: -27.0, east: -48.0, north: -22.3 };
  const width = 22;
  const height = 15;
  const lats = [];
  const lons = [];
  for (let j = 0; j < height; j++) {
    const lat = bounds.south + ((bounds.north - bounds.south) * j) / (height - 1);
    for (let i = 0; i < width; i++) {
      const lon = bounds.west + ((bounds.east - bounds.west) * i) / (width - 1);
      lats.push(lat.toFixed(3));
      lons.push(lon.toFixed(3));
    }
  }

  const u = new Float32Array(width * height);
  const v = new Float32Array(width * height);
  const chunk = 110;
  for (let start = 0; start < lats.length; start += chunk) {
    const la = lats.slice(start, start + chunk).join(',');
    const lo = lons.slice(start, start + chunk).join(',');
    const resp = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
        '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms',
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
    const data = await resp.json();
    const points = Array.isArray(data) ? data : [data];
    points.forEach((pt, k) => {
      const idx = start + k;
      const speed = Number(pt?.current?.wind_speed_10m ?? 0);
      const dir = (Number(pt?.current?.wind_direction_10m ?? 0) * Math.PI) / 180;
      // Direcao meteorologica = de onde o vento VEM.
      u[idx] = -speed * Math.sin(dir);
      v[idx] = -speed * Math.cos(dir);
    });
  }

  return { u: { array: u }, v: { array: v }, width, height, bounds };
}

/** Embarcacoes AIS das ultimas 24 h (posicao mais recente por MMSI). */
export async function fetchVessels() {
  const since = isoZ(new Date(Date.now() - 24 * 3600_000));
  const rows = await dgSelect(
    'maritime_traffic',
    'select=mmsi,vessel_name,ship_type_label,latitude,longitude,sog_knots,' +
      `cog_deg,nav_status_label,destination,observed_at&observed_at=gte.${since}` +
      '&order=observed_at.desc&limit=2000',
  );
  const byMmsi = new Map();
  for (const row of rows) {
    const mmsi = row.mmsi;
    if (mmsi === null || mmsi === undefined || byMmsi.has(mmsi)) continue;
    byMmsi.set(mmsi, row);
  }
  return [...byMmsi.values()];
}

// --------------------------------------------------------------------------
// Ficha municipal (clique no poligono) — agrega tudo que o ecossistema tem
// por municipio. Cada chave e uma SECAO da ficha; novas bases = novas
// chaves aqui + um builder em datageoFicha.js. Promise.allSettled: uma
// fonte fora do ar nao derruba a ficha.
// --------------------------------------------------------------------------

const AQICN_IBGE_TO_CITY = {
  4106902: 'curitiba', 4113700: 'londrina', 4115200: 'maringa',
  4108304: 'foz', 4104808: 'cascavel', 4119905: 'ponta-grossa',
  4125506: 'sao-jose-dos-pinhais', 4109401: 'guarapuava',
  4128104: 'umuarama', 4127700: 'toledo', 4118204: 'paranagua',
  4101408: 'apucarana',
};

const stripAccents = (t) =>
  String(t ?? '').toLowerCase().trim().normalize('NFD').replace(/\p{Mn}/gu, '');

export async function fetchMunicipioFicha(ibge, nome) {
  const code = String(ibge);
  const iso7 = isoZ(new Date(Date.now() - 7 * 86_400_000));
  const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const nowIso = isoZ(new Date());

  const tasks = {
    irtc: dgSelect(
      'irtc_scores',
      'select=irtc_score,risk_level,dominant_domain,data_coverage,risk_clima,' +
        `risk_saude,risk_ambiente,risk_hidro,risk_ar,calculated_at&ibge_code=eq.${code}&limit=1`,
    ),
    dengueSerie: dgSelect(
      'dengue_data',
      'select=year,epidemiological_week,cases,cases_est,alert_level,incidence_rate' +
        `&ibge_code=eq.${code}&order=year.desc,epidemiological_week.desc&limit=8`,
    ),
    dengueProj: dgSelect(
      'dengue_projections',
      'select=projected_week,projected_year,projected_cases,trend,r_squared' +
        `&ibge_code=eq.${code}&order=projected_year.asc,projected_week.asc&limit=4`,
    ),
    focos: dgSelect(
      'fire_spots',
      `select=acq_date&municipality=eq.${encodeURIComponent(nome)}&acq_date=gte.${d30}&limit=1000`,
    ),
    clima: dgSelect(
      'climate_data',
      'select=station_name,temperature,humidity,precipitation,wind_speed,observed_at' +
        `&ibge_code=eq.${code}&order=observed_at.desc&limit=1`,
    ),
    rios: dgSelect(
      'river_levels',
      'select=station_name,river_name,level_cm,alert_level,observed_at' +
        `&municipality=eq.${encodeURIComponent(nome)}&order=observed_at.desc&limit=5`,
    ),
    cemaden: dgSelect(
      'cemaden_alerts',
      `select=alert_type,severity,issued_at,expires_at&ibge_code=eq.${code}` +
        `&issued_at=gte.${isoZ(new Date(Date.now() - 3 * 86_400_000))}` +
        `&or=(expires_at.is.null,expires_at.gt.${nowIso})&order=issued_at.desc&limit=5`,
    ),
    anomalias: dgSelect(
      'anomalies',
      'select=indicator,z_score,observed_value,municipality,detected_at' +
        `&detected_at=gte.${iso7}&order=detected_at.desc&limit=200`,
    ),
    ar: AQICN_IBGE_TO_CITY[code]
      ? dgSelect(
          'air_quality',
          'select=aqi,dominant_pollutant,pm25,observed_at' +
            `&city=eq.${AQICN_IBGE_TO_CITY[code]}&order=observed_at.desc&limit=1`,
        )
      : Promise.resolve([]),
    incidentes: dgSelect(
      'incidents',
      'select=title,type,severity,status,detected_at' +
        `&affected_municipalities=cs.${encodeURIComponent(
          JSON.stringify([{ ibge_code: code }]),
        )}&status=not.in.(resolved,closed)&order=detected_at.desc&limit=5`,
    ),
    noticias: dgSelect(
      'news_items',
      `select=title,source,url,urgency,published_at&title=ilike.${encodeURIComponent(
        `*${nome}*`,
      )}&order=published_at.desc&limit=3`,
    ),
  };

  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const out = {};
  keys.forEach((key, i) => {
    const r = settled[i];
    out[key] = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
  });

  // Anomalias: a tabela grava municipio sem padrao de acento (fonte INMET);
  // o filtro por nome normalizado acontece aqui, client-side.
  if (Array.isArray(out.anomalias)) {
    const alvo = stripAccents(nome);
    out.anomalias = out.anomalias
      .filter((a) => stripAccents(a.municipality) === alvo)
      .slice(0, 5);
  }
  // Focos: contagens 7d/30d a partir das datas.
  if (Array.isArray(out.focos)) {
    const corte7 = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    out.focos = {
      d30: out.focos.length,
      d7: out.focos.filter((f) => (f.acq_date ?? '') >= corte7).length,
    };
  }
  return out;
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
