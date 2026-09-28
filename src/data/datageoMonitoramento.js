// src/data/datageoMonitoramento.js
//
// Montagem PURA (sem Cesium, sem DOM) das feições GeoJSON das camadas de
// monitoramento do DataGeo PR para o protótipo MapLibre
// (src/maplibre/layers/monitoramento.js): clima, rios, CEMADEN, IRTC, dengue,
// qualidade do ar, anomalias, incidentes, InfoHidro e marítimo.
//
// ESPECIFICAÇÃO: os builders de src/data/datageoLayers.js (app Cesium). Mesmos
// ids estáveis, mesmas âncoras (centróides de prCentroids.js), mesmas cores
// (os nomes Cesium.Color.* são as cores CSS homônimas), mesmos textos de
// rótulo e mesmos tamanhos. Cada feição leva em `properties` o que o estilo
// precisa (cor, opacidade, tamanho, raio em metros convertido para pixels no
// zoom 0, texto do rótulo) e as mesmas properties das entidades do app.

import { centroidByIbge, centroidByName } from './prCentroids.js';
import { lineupEntityRows } from './portLineup.js';
import { farIconPixels, headingToRotation, shipDimensions } from './vesselIcon.js';
import { progressoOperacao } from './vesselTooltip.js';
import { fmtCoord, fmtDateTime, fmtInt, fmtNum, fmtPct, tipCard } from '../maplibre/tooltipCard.js';

/** Mesmo teto de rótulo por camada do app (datageoLayers.LABEL_MAX_DISTANCE), em metros de câmera. */
export const LABEL_MAX_DISTANCE = Object.freeze({
  clima: 250_000,
  rios: 250_000,
  cemaden: 3_000_000,
  irtc: 1_800_000,
  dengue: 600_000,
  ar: 1_200_000,
  anomalias: 2_500_000,
  incidentes: 4_000_000,
  infohidro: 80_000,
  maritimo: 250_000,
});
/** Rótulos do line-up (berços a ~180 m): só abaixo de 3,5 km de câmera. */
export const LINEUP_LABEL_MAX_DISTANCE = 3_500;

export const NEW_ARRIVAL_COLOR = '#22d3ee';

// Cesium.Color.* -> CSS.
export const C = Object.freeze({
  GRAY: '#808080',
  RED: '#ff0000',
  ORANGE: '#ffa500',
  LIME: '#00ff00',
  CYAN: '#00ffff',
  DEEPSKYBLUE: '#00bfff',
  YELLOW: '#ffff00',
  PURPLE: '#800080',
  MAGENTA: '#ff00ff',
  AQUA: '#00ffff',
  LIGHTSTEELBLUE: '#b0c4de',
  WHITE: '#ffffff',
  BLACK: '#000000',
});

// ---------------------------------------------------------------- geometria

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE_SIZE = 512;

/**
 * Pixels que `meters` ocupam no zoom 0 do MapLibre (tiles de 512 px) na
 * latitude dada. No zoom z o tamanho é esse valor × 2^z, então um
 * `interpolate exponential 2` entre dois zooms reproduz o raio em metros.
 */
export function metersToPixelsAtZoom0(meters, lat) {
  const cos = Math.cos((Number(lat) * Math.PI) / 180);
  return (Number(meters) * TILE_SIZE) / (EARTH_CIRCUMFERENCE_M * Math.max(1e-6, cos));
}

/** Number ou null (null/''/não numérico -> null). */
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Ponto com id estável em `properties.fid` (a fonte usa promoteId: 'fid'). */
function feature(id, lon, lat, properties) {
  const x = Number(lon);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { fid: id, ...properties } };
}

/** Ponto (Cesium point): pixelSize é o diâmetro, outline em pixels. */
function pointStyle(color, alpha, pixelSize, outlineColor, outlineAlpha, outlineWidth) {
  return { color, opacity: alpha, radius: pixelSize / 2, stroke: outlineColor, strokeOpacity: outlineAlpha, strokeWidth: outlineWidth };
}

// ---------------------------------------------------------------- clima

export function temperatureColor(t) {
  if (t === null || t === undefined) return C.GRAY;
  if (t >= 35) return C.RED;
  if (t >= 28) return C.ORANGE;
  if (t >= 18) return C.LIME;
  if (t >= 10) return C.CYAN;
  return C.DEEPSKYBLUE;
}

export function buildClima(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const t = row.temperature === null ? null : Number(row.temperature);
    const ur = row.humidity === null ? null : Number(row.humidity);
    const parts = [];
    if (t !== null && Number.isFinite(t)) parts.push(`${t.toFixed(1)}°C`);
    if (ur !== null && Number.isFinite(ur)) parts.push(`${ur.toFixed(0)}%`);
    const f = feature(`datageo-clima:${row.station_code}`, row.longitude, row.latitude, {
      ...pointStyle(temperatureColor(t), 0.9, 7, C.BLACK, 0.6, 1),
      label: `${row.municipality ?? row.station_name ?? row.station_code}\n${parts.join(' · ')}`,
      municipality: row.municipality,
      temperature: t,
      humidity: ur,
      observedAt: row.observed_at,
      // tooltip (climaTooltip)
      stationCode: row.station_code,
      stationName: row.station_name,
      ibgeCode: row.ibge_code,
      precipitation: numOrNull(row.precipitation),
      windSpeed: numOrNull(row.wind_speed),
      windDirection: numOrNull(row.wind_direction),
      pressure: numOrNull(row.pressure),
      lat: Number(row.latitude),
      lon: Number(row.longitude),
    });
    if (f) features.push(f);
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- rios

export const RIVER_COLORS = Object.freeze({ normal: C.LIME, attention: C.YELLOW, alert: C.ORANGE, emergency: C.RED });
export const RIVER_RADIUS_M = 9000;

export function buildRios(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const level = row.alert_level ?? 'normal';
    const color = RIVER_COLORS[level] ?? C.LIME;
    const cm = row.level_cm === null ? null : Number(row.level_cm);
    features.push(feature(`datageo-rios:${row.station_code}`, lon, lat, {
      color,
      opacity: 0.35,
      stroke: color,
      strokeOpacity: 0.9,
      strokeWidth: 2,
      r0: metersToPixelsAtZoom0(RIVER_RADIUS_M, lat),
      label:
        `${row.river_name ?? ''} · ${row.station_name ?? row.station_code}` +
        `\n${cm !== null && Number.isFinite(cm) ? `${cm.toFixed(0)} cm · ` : ''}${RIVER_SITUACAO[level]?.text ?? level.toUpperCase()}`,
      alertLevel: level,
      levelCm: cm,
      municipality: row.municipality,
      // tooltip (riosTooltip)
      stationCode: row.station_code,
      stationName: row.station_name,
      riverName: row.river_name,
      flowM3s: numOrNull(row.flow_m3s),
      observedAt: row.observed_at,
      lat,
      lon,
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- CEMADEN

export const CEMADEN_COLORS = Object.freeze({
  observacao: C.DEEPSKYBLUE,
  atencao: C.YELLOW,
  alerta: C.ORANGE,
  alerta_maximo: C.RED,
});

export function buildCemaden(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const anchor = centroidByIbge(row.ibge_code);
    if (!anchor) continue;
    const severity = row.severity ?? 'observacao';
    const color = CEMADEN_COLORS[severity] ?? C.DEEPSKYBLUE;
    features.push(feature(`datageo-cemaden:${row.alert_code}:${row.ibge_code}`, anchor.lon, anchor.lat, {
      ...pointStyle(color, 0.95, 12, C.WHITE, 0.8, 2),
      label: `CEMADEN · ${(row.alert_type ?? '').toUpperCase()}\n${anchor.name} · ${severity.replace('_', ' ').toUpperCase()}`,
      alertType: row.alert_type,
      severity,
      municipality: row.municipality ?? anchor.name,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      // tooltip (cemadenTooltip)
      alertCode: row.alert_code,
      ibgeCode: row.ibge_code,
      description: row.description,
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- IRTC

export const IRTC_COLORS = Object.freeze({
  baixo: '#22c55e',
  'médio': '#eab308',
  medio: '#eab308',
  alto: '#f97316',
  'crítico': '#ef4444',
  critico: '#ef4444',
});

/** Raio do disco IRTC: 3 km a 14 km, proporcional ao score (0-100). */
export const irtcRadiusM = (score) => 3000 + Math.min(100, Math.max(0, score)) * 110;

export function buildIrtc(rows) {
  const features = [];
  // posição no estado (1 = maior risco), calculada sobre todas as linhas
  const scores = (rows ?? []).map((r) => Number(r.irtc_score ?? 0)).filter(Number.isFinite);
  for (const row of rows ?? []) {
    const anchor = centroidByIbge(row.ibge_code);
    if (!anchor) continue;
    const level = row.risk_level ?? 'baixo';
    const color = IRTC_COLORS[level] ?? IRTC_COLORS.baixo;
    const score = Number(row.irtc_score ?? 0);
    const emphasized = level === 'alto' || level === 'crítico' || level === 'critico';
    features.push(feature(`datageo-irtc:${row.ibge_code}`, anchor.lon, anchor.lat, {
      color,
      opacity: emphasized ? 0.45 : 0.15,
      stroke: color,
      strokeOpacity: emphasized ? 0.9 : 0,
      strokeWidth: emphasized ? 2 : 0,
      r0: metersToPixelsAtZoom0(irtcRadiusM(score), anchor.lat),
      label: emphasized
        ? `${anchor.name}\nIRTC ${score.toFixed(0)} · ${String(level).toUpperCase()} · ${row.dominant_domain ?? ''}`
        : '',
      irtcScore: score,
      riskLevel: level,
      dominantDomain: row.dominant_domain,
      dataCoverage: row.data_coverage,
      // tooltip (irtcTooltip)
      municipality: row.municipality ?? anchor.name,
      ibgeCode: row.ibge_code,
      rank: 1 + scores.filter((x) => x > score).length,
      rankOf: scores.length,
      riskClima: numOrNull(row.risk_clima),
      riskSaude: numOrNull(row.risk_saude),
      riskAmbiente: numOrNull(row.risk_ambiente),
      riskHidro: numOrNull(row.risk_hidro),
      riskAr: numOrNull(row.risk_ar),
      calculatedAt: row.calculated_at,
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- dengue

export const DENGUE_COLORS = Object.freeze({ 1: '#22c55e', 2: '#eab308', 3: '#f97316', 4: '#ef4444' });

export function buildDengue(payload) {
  const { year, week, rows } = payload ?? {};
  const features = [];
  for (const row of rows ?? []) {
    const anchor = centroidByIbge(row.ibge_code);
    if (!anchor) continue;
    const level = Math.max(1, Math.min(4, Math.trunc(Number(row.alert_level ?? 1)) || 1));
    const cases = Math.trunc(Number(row.cases ?? 0)) || 0;
    const emphasized = level >= 3;
    features.push(feature(`datageo-dengue:${row.ibge_code}`, anchor.lon, anchor.lat, {
      ...pointStyle(DENGUE_COLORS[level], level === 1 ? 0.45 : 0.9, emphasized ? 11 : 6, C.BLACK, 0.5, 1),
      label: emphasized ? `${anchor.name}\nDengue nivel ${level} · ${cases} casos · SE ${week}/${year}` : '',
      alertLevel: level,
      cases,
      week,
      year,
      // tooltip (dengueTooltip)
      municipality: row.municipality_name ?? anchor.name,
      ibgeCode: row.ibge_code,
      casesEst: numOrNull(row.cases_est),
      incidence: numOrNull(row.incidence_rate),
      population: numOrNull(row.population),
      fetchedAt: row.fetched_at,
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- ar

// air_quality não guarda lat/lon; coordenadas por city id (mesmo mapa do app).
export const AQICN_CITY_GEO = Object.freeze({
  curitiba: { lat: -25.43, lon: -49.27, nome: 'Curitiba' },
  londrina: { lat: -23.31, lon: -51.16, nome: 'Londrina' },
  maringa: { lat: -23.42, lon: -51.94, nome: 'Maringá' },
  foz: { lat: -25.52, lon: -54.59, nome: 'Foz do Iguaçu' },
  cascavel: { lat: -24.9545, lon: -53.4596, nome: 'Cascavel' },
  'ponta-grossa': { lat: -25.0959, lon: -50.1647, nome: 'Ponta Grossa' },
  'sao-jose-dos-pinhais': { lat: -25.5307, lon: -49.2, nome: 'São José dos Pinhais' },
  guarapuava: { lat: -25.389, lon: -51.4638, nome: 'Guarapuava' },
  umuarama: { lat: -23.7652, lon: -53.3248, nome: 'Umuarama' },
  toledo: { lat: -24.7257, lon: -53.7406, nome: 'Toledo' },
  paranagua: { lat: -25.5169, lon: -48.7296, nome: 'Paranaguá' },
  apucarana: { lat: -23.5707, lon: -51.4635, nome: 'Apucarana' },
});

export function aqiColor(aqi) {
  if (aqi === null || aqi === undefined) return C.GRAY;
  if (aqi <= 50) return C.LIME;
  if (aqi <= 100) return C.YELLOW;
  if (aqi <= 150) return C.ORANGE;
  if (aqi <= 200) return C.RED;
  return C.PURPLE;
}

export function buildAr(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const geo = AQICN_CITY_GEO[row.city ?? ''];
    if (!geo) continue;
    const aqi = row.aqi === null ? null : Math.trunc(Number(row.aqi));
    features.push(feature(`datageo-ar:${row.city}`, geo.lon, geo.lat, {
      ...pointStyle(aqiColor(aqi), 0.9, 9, C.BLACK, 0.6, 1),
      label: `${geo.nome}\nAQI ${aqi ?? '?'}${row.dominant_pollutant ? ` · ${row.dominant_pollutant}` : ''}`,
      aqi,
      pollutant: row.dominant_pollutant,
      observedAt: row.observed_at,
      // tooltip (arTooltip)
      city: geo.nome,
      stationName: row.station_name,
      pm25: numOrNull(row.pm25),
      pm10: numOrNull(row.pm10),
      o3: numOrNull(row.o3),
      no2: numOrNull(row.no2),
      so2: numOrNull(row.so2),
      co: numOrNull(row.co),
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- anomalias

export function buildAnomalias(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const anchor = centroidByName(row.municipality) ?? centroidByName(row.station_code);
    if (!anchor) continue;
    const z = Number(row.z_score ?? 0);
    const severe = Math.abs(z) >= 4;
    features.push(feature(
      `datageo-anomalias:${row.domain}:${row.indicator}:${row.station_code}:${row.detected_at}`,
      anchor.lon,
      anchor.lat,
      {
        ...pointStyle(severe ? C.MAGENTA : C.ORANGE, 0.95, severe ? 12 : 9, C.WHITE, 0.7, 2),
        label: `ANOMALIA · ${row.indicator}\n${anchor.name} · z=${z.toFixed(1)} · obs ${Number(row.observed_value ?? 0).toFixed(1)}`,
        domain: row.domain,
        indicator: row.indicator,
        zScore: z,
        // tooltip (anomaliasTooltip)
        municipality: anchor.name,
        stationCode: row.station_code,
        observedValue: numOrNull(row.observed_value),
        windowMean: numOrNull(row.window_mean),
        windowStd: numOrNull(row.window_stddev),
        windowSize: numOrNull(row.window_size),
        detectedAt: row.detected_at,
      },
    ));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- incidentes

export const INCIDENT_SEVERITY_COLORS = Object.freeze({ low: C.LIME, medium: C.YELLOW, high: C.ORANGE, critical: C.RED });

export function buildIncidentes(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const munis = Array.isArray(row.affected_municipalities) ? row.affected_municipalities : [];
    const first = munis[0] ?? {};
    const anchor = centroidByIbge(first.ibge_code) ?? centroidByName(first.name);
    if (!anchor) continue;
    const color = INCIDENT_SEVERITY_COLORS[row.severity ?? 'medium'] ?? C.YELLOW;
    features.push(feature(`datageo-incidentes:${row.id}`, anchor.lon, anchor.lat, {
      ...pointStyle(color, 0.95, 14, C.WHITE, 1, 2),
      label: `INCIDENTE · ${(row.type ?? 'outro').toUpperCase()}\n${row.title ?? ''} · ${(INCIDENTE_STATUS[row.status] ?? row.status ?? '').toUpperCase()}`,
      severity: row.severity,
      status: row.status,
      type: row.type,
      // tooltip (incidentesTooltip): lista achatada (queryRenderedFeatures não preserva arrays)
      title: row.title,
      description: row.description,
      oodaPhase: row.ooda_phase,
      municipalities: munis.map((m) => m?.name ?? centroidByIbge(m?.ibge_code)?.name).filter(Boolean).join(', '),
      municipalityCount: munis.length,
      detectedAt: row.detected_at,
      updatedAt: row.updated_at,
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- InfoHidro

export function buildInfohidro(rows) {
  const features = [];
  for (const row of rows ?? []) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    features.push(feature(`datageo-infohidro:${row.codigo}`, lon, lat, {
      ...pointStyle(C.CYAN, 0.55, 4, C.BLACK, 0, 0),
      label: `${row.nome ?? row.codigo}`,
      codigo: row.codigo,
      tipoId: row.tipo_id,
      // tooltip (infohidroTooltip): campos escalares do cache, se houver
      nome: row.nome,
      municipio: row.municipio ?? row.municipality,
      rio: row.rio,
      bacia: row.bacia,
      altitude: numOrNull(row.altitude),
      responsavel: row.responsavel ?? row.orgao,
      lat,
      lon,
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- marítimo

export const SHIP_COLORS = Object.freeze({
  berco: { key: 'berco', rgb: [0xfb, 0xbf, 0x24], alpha: 0.95 }, // #fbbf24
  fundeio: { key: 'fundeio', rgb: [0x94, 0xa3, 0xb8], alpha: 0.9 }, // #94a3b8
  aisMoving: { key: 'ais-mov', rgb: [0x00, 0xff, 0xff], alpha: 0.95 }, // AQUA
  aisStopped: { key: 'ais-parado', rgb: [0xb0, 0xc4, 0xde], alpha: 0.95 }, // LIGHTSTEELBLUE
});

/** Altura lógica (px) das imagens de navio registradas no mapa. */
export const SHIP_FAR_IMAGE_H = 160; // 40 × 160, proporção do SVG
export const SHIP_NEAR_IMAGE_H = 260; // 40 × 260: boca = LOA / 6,5 (vesselIcon.js)

/** Rumo -> icon-rotate do MapLibre (graus horários a partir do norte), mesmo fallback de 45°. */
export function headingToIconRotate(headingDeg) {
  const deg = -headingToRotation(headingDeg) * (180 / Math.PI);
  return Math.round(deg * 1000) / 1000 + 0;
}

function shipFeature({ id, lon, lat, colorKey, loaM, headingDeg, label, labelKind, labelOffsetPx, labelSize, properties }) {
  const { lengthM } = shipDimensions(loaM);
  const far = farIconPixels(loaM);
  return feature(id, lon, lat, {
    ...properties,
    shipImage: colorKey,
    rotate: headingToIconRotate(headingDeg),
    farSize: far.height / SHIP_FAR_IMAGE_H,
    // tamanho do ícone "perto" no zoom 0; × 2^z no estilo.
    nearSize0: metersToPixelsAtZoom0(lengthM, lat) / SHIP_NEAR_IMAGE_H,
    label,
    labelKind,
    labelDy: labelOffsetPx / labelSize,
    labelSize,
  });
}

/** `{lineup, vessels}` de fetchMaritimo -> feições (1 por navio) e contagem. */
export function buildMaritimo({ lineup, vessels } = {}, now = Date.now()) {
  const features = [];
  for (const row of lineupEntityRows(lineup)) {
    const atracado = row.kind === 'berco';
    const f = shipFeature({
      id: `datageo-maritimo:${row.id}`,
      lon: row.lon,
      lat: row.lat,
      colorKey: atracado ? SHIP_COLORS.berco.key : SHIP_COLORS.fundeio.key,
      loaM: row.loaM,
      headingDeg: row.rumo,
      label: row.label,
      labelKind: 'lineup',
      labelOffsetPx: row.labelAbove ? -22 : 26,
      labelSize: 11,
      properties: row.props,
    });
    if (f) features.push(f);
  }
  for (const row of vessels ?? []) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const sog = row.sog_knots === null ? null : Number(row.sog_knots);
    const moving = sog !== null && sog >= 0.5;
    const ageMin = Math.max(0, Math.round((now - Date.parse(row.observed_at)) / 60_000));
    features.push(shipFeature({
      id: `datageo-maritimo:${row.mmsi}`,
      lon,
      lat,
      colorKey: moving ? SHIP_COLORS.aisMoving.key : SHIP_COLORS.aisStopped.key,
      loaM: null,
      headingDeg: row.cog_deg,
      label:
        `${row.vessel_name ?? `MMSI ${row.mmsi}`}` +
        `\n${sog !== null ? `${sog.toFixed(1)} kn · ` : ''}` +
        `${row.nav_status_label ?? ''} · ${ageMin}min`,
      labelKind: 'ais',
      labelOffsetPx: -14,
      labelSize: 12,
      properties: {
        mmsi: row.mmsi,
        vesselName: row.vessel_name,
        shipType: row.ship_type_label,
        navStatus: row.nav_status_label,
        sog,
        destination: row.destination,
        observedAt: row.observed_at,
        // tooltip (maritimoTooltip)
        imo: row.imo,
        callsign: row.callsign,
        lengthM: numOrNull(row.length_m),
        widthM: numOrNull(row.width_m),
        draughtM: numOrNull(row.draught_m),
        cog: numOrNull(row.cog_deg),
        headingDeg: numOrNull(row.heading_deg),
        eta: row.eta,
        lat,
        lon,
      },
    }));
  }
  return { features, count: features.length };
}

// ---------------------------------------------------------------- refresh

/**
 * Chegadas novas de um refresh (mesma regra de createDatageoLayer): ids que
 * não estavam no refresh anterior; no primeiro refresh tudo é novo, mas não
 * há destaque (`highlight` falso).
 * @returns {{ids: Set<string>, newIds: string[], highlight: boolean}}
 */
export function arrivals(prevIds, features, refreshIndex) {
  const ids = new Set(features.map((f) => f.properties.fid));
  const newIds = [...ids].filter((id) => !prevIds?.has(id) && !String(id).includes('#'));
  return { ids, newIds, highlight: refreshIndex > 1 && newIds.length > 0 };
}

// ---------------------------------------------------------------- tooltips
//
// Tooltips de hover (formato único tipCard) a partir das properties das
// feições acima. Tudo escalar: queryRenderedFeatures achata objetos/arrays.

const blank = (v) => v === null || v === undefined || v === '';
const up = (v) => String(v ?? '').toUpperCase();
const cap = (v) => {
  const s = String(v ?? '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};
/** Número com sinal: "+2,3" / "−1,0". */
const signed = (v, casas = 1, unit = '') => {
  if (blank(v) || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  const s = fmtNum(Math.abs(n), casas, unit);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
};

const PONTOS_CARDEAIS = ['N', 'NNE', 'NE', 'ENE', 'L', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
/** 225 -> "SO (225°)". */
export function cardinal(deg) {
  if (blank(deg) || !Number.isFinite(Number(deg))) return '';
  const d = ((Number(deg) % 360) + 360) % 360;
  return `${PONTOS_CARDEAIS[Math.round(d / 22.5) % 16]} (${fmtInt(d)}°)`;
}

// ------------------------------------------------ clima

/** Badge de severidade térmica/umidade (limiares INMET de umidade baixa). */
export function climaBadge(t, ur) {
  if (Number.isFinite(t) && t >= 35) return { text: 'CALOR EXTREMO', tone: 'alert' };
  if (Number.isFinite(ur) && ur <= 12) return { text: 'UMIDADE · EMERGÊNCIA', tone: 'alert' };
  if (Number.isFinite(ur) && ur < 20) return { text: 'UMIDADE · ALERTA', tone: 'alert' };
  if (Number.isFinite(ur) && ur < 30) return { text: 'UMIDADE · ATENÇÃO', tone: 'warn' };
  if (Number.isFinite(t) && t <= 3) return { text: 'RISCO DE GEADA', tone: 'info' };
  return null;
}

export function climaTooltip(p) {
  const t = blank(p.temperature) ? NaN : Number(p.temperature);
  const ur = blank(p.humidity) ? NaN : Number(p.humidity);
  const ws = blank(p.windSpeed) ? NaN : Number(p.windSpeed);
  const tTone = t >= 35 ? 'alert' : t >= 28 ? 'warn' : t <= 3 ? 'info' : undefined;
  const urTone = ur < 20 ? 'alert' : ur < 30 ? 'warn' : undefined;
  return tipCard({
    icon: '🌡️',
    title: p.municipality || p.stationName || p.stationCode || 'Estação meteorológica',
    subtitle: ['Estação INMET', p.stationCode, p.municipality && p.stationName ? p.stationName : null].filter(Boolean).join(' · '),
    badge: climaBadge(t, ur),
    rows: [
      ['Temperatura', fmtNum(t, 1, '°C'), tTone],
      ['Umidade relativa', fmtPct(ur, 0, true), urTone],
      ['Precipitação', fmtNum(p.precipitation, 1, 'mm')],
      ['Vento', Number.isFinite(ws) ? `${fmtNum(ws, 1, 'm/s')} (${fmtNum(ws * 3.6, 0, 'km/h')})` : ''],
      ['Direção do vento', cardinal(p.windDirection)],
      ['Pressão', fmtNum(p.pressure, 1, 'hPa')],
      ['Leitura', fmtDateTime(p.observedAt)],
      ['Código IBGE', p.ibgeCode],
      ['Coordenadas', fmtCoord(p.lat, p.lon)],
    ],
    source: 'INMET · DataGeo PR',
    updated: p.observedAt,
  });
}

// ------------------------------------------------ rios

export const RIVER_SITUACAO = Object.freeze({
  normal: { text: 'NORMAL', tone: 'ok' },
  attention: { text: 'ATENÇÃO', tone: 'warn' },
  alert: { text: 'ALERTA', tone: 'alert' },
  emergency: { text: 'EMERGÊNCIA', tone: 'alert' },
});

/** "Tibagi" → "Rio Tibagi"; nomes que já trazem o tipo ("Rio Tibagi", "Ribeirão X") ficam como estão. */
export function riverLabel(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  return /^(rio|ribeir[aã]o|arroio|c[oó]rrego|riacho|lago|represa|lagoa)(\s|$)/i.test(n) ? n : `Rio ${n}`;
}

export function riosTooltip(p) {
  const sit = RIVER_SITUACAO[p.alertLevel] ?? (p.alertLevel ? { text: up(p.alertLevel), tone: 'muted' } : null);
  const cm = blank(p.levelCm) ? NaN : Number(p.levelCm);
  return tipCard({
    icon: '🌊',
    title: p.stationName || `Estação ${p.stationCode ?? ''}`.trim(),
    subtitle: [riverLabel(p.riverName), p.municipality].filter(Boolean).join(' · '),
    badge: sit,
    rows: [
      ['Nível', Number.isFinite(cm) ? `${fmtInt(cm, 'cm')} (${fmtNum(cm / 100, 2, 'm')})` : '', sit && sit.tone !== 'ok' ? sit.tone : undefined],
      ['Vazão', fmtNum(p.flowM3s, 1, 'm³/s')],
      ['Situação', sit ? cap(sit.text.toLowerCase()) : ''],
      ['Município', p.municipality],
      ['Código ANA', p.stationCode],
      ['Leitura', fmtDateTime(p.observedAt)],
      ['Coordenadas', fmtCoord(p.lat, p.lon)],
    ],
    source: 'ANA · DataGeo PR',
    updated: p.observedAt,
  });
}

// ------------------------------------------------ CEMADEN

export const CEMADEN_SEVERIDADE = Object.freeze({
  observacao: { text: 'OBSERVAÇÃO', tone: 'info' },
  atencao: { text: 'ATENÇÃO', tone: 'warn' },
  alerta: { text: 'ALERTA', tone: 'alert' },
  alerta_maximo: { text: 'ALERTA MÁXIMO', tone: 'alert' },
});

const CEMADEN_TIPO = {
  hidrologico: 'Risco hidrológico',
  geologico: 'Risco geológico',
  meteorologico: 'Risco meteorológico',
  movimento_de_massa: 'Movimento de massa',
  inundacao: 'Inundação',
  enxurrada: 'Enxurrada',
  alagamento: 'Alagamento',
};

export function cemadenTooltip(p) {
  const tipo = CEMADEN_TIPO[p.alertType] ?? (cap(p.alertType) || 'Alerta');
  return tipCard({
    icon: '⚠️',
    title: `${tipo} · ${p.municipality ?? ''}`.replace(/ · $/, ''),
    subtitle: 'Alerta CEMADEN',
    badge: CEMADEN_SEVERIDADE[p.severity] ?? { text: up(p.severity).replace(/_/g, ' '), tone: 'warn' },
    rows: [
      ['Tipo', tipo],
      ['Município', p.municipality],
      ['Código IBGE', p.ibgeCode],
      ['Emitido em', fmtDateTime(p.issuedAt)],
      ['Válido até', p.expiresAt ? fmtDateTime(p.expiresAt) : 'sem prazo definido'],
      ['Código do alerta', p.alertCode],
    ],
    note: p.description,
    source: 'CEMADEN · DataGeo PR',
    updated: p.issuedAt,
  });
}

// ------------------------------------------------ IRTC

export const IRTC_NIVEL = Object.freeze({
  baixo: { text: 'BAIXO', tone: 'ok' },
  medio: { text: 'MÉDIO', tone: 'warn' },
  'médio': { text: 'MÉDIO', tone: 'warn' },
  alto: { text: 'ALTO', tone: 'alert' },
  critico: { text: 'CRÍTICO', tone: 'alert' },
  'crítico': { text: 'CRÍTICO', tone: 'alert' },
});

const DOMINIO = { clima: 'Clima', saude: 'Saúde', 'saúde': 'Saúde', ambiente: 'Ambiente', hidro: 'Hidrologia', ar: 'Qualidade do ar' };
const riskTone = (v) => (blank(v) ? undefined : Number(v) >= 75 ? 'alert' : Number(v) >= 50 ? 'warn' : undefined);
const riskRow = (label, v) => [label, blank(v) ? '' : `${fmtInt(v)} / 100`, riskTone(v)];

export function irtcTooltip(p) {
  const nivel = IRTC_NIVEL[p.riskLevel] ?? (p.riskLevel ? { text: up(p.riskLevel), tone: 'muted' } : null);
  return tipCard({
    icon: '🎯',
    title: p.municipality || 'Município',
    subtitle: 'Índice de risco territorial (IRTC)',
    badge: nivel,
    rows: [
      ['IRTC', blank(p.irtcScore) ? '' : `${fmtNum(p.irtcScore, 1)} / 100`, nivel?.tone === 'ok' ? undefined : nivel?.tone],
      ['Posição no PR', blank(p.rank) ? '' : `${fmtInt(p.rank)}º de ${fmtInt(p.rankOf)} (1º = maior risco)`],
      ['Domínio dominante', DOMINIO[p.dominantDomain] ?? cap(p.dominantDomain)],
      ['Cobertura de dados', fmtPct(p.dataCoverage, 0)],
      ['Código IBGE', p.ibgeCode],
      ['Calculado em', fmtDateTime(p.calculatedAt)],
    ],
    sections: [{
      title: 'Componentes do risco',
      rows: [
        riskRow('Clima', p.riskClima),
        riskRow('Saúde', p.riskSaude),
        riskRow('Ambiente', p.riskAmbiente),
        riskRow('Hidrologia', p.riskHidro),
        riskRow('Qualidade do ar', p.riskAr),
      ],
    }],
    source: 'IRTC · DataGeo PR',
    updated: p.calculatedAt,
  });
}

// ------------------------------------------------ dengue

/** Níveis de alerta do InfoDengue (1 verde … 4 vermelho). */
export const DENGUE_NIVEL = Object.freeze({
  1: { text: 'NÍVEL 1 · VERDE', tone: 'ok', desc: 'Condições desfavoráveis à transmissão' },
  2: { text: 'NÍVEL 2 · AMARELO', tone: 'warn', desc: 'Atenção: clima favorável à transmissão' },
  3: { text: 'NÍVEL 3 · LARANJA', tone: 'alert', desc: 'Transmissão sustentada' },
  4: { text: 'NÍVEL 4 · VERMELHO', tone: 'alert', desc: 'Incidência acima do limiar epidêmico' },
});

export function dengueTooltip(p) {
  const nivel = DENGUE_NIVEL[p.alertLevel] ?? DENGUE_NIVEL[1];
  return tipCard({
    icon: '🦟',
    title: p.municipality || 'Município',
    subtitle: blank(p.week) ? 'Dengue · InfoDengue' : `Dengue · semana epidemiológica ${p.week}/${p.year}`,
    badge: { text: nivel.text, tone: nivel.tone },
    rows: [
      ['Situação', nivel.desc, nivel.tone === 'ok' ? undefined : nivel.tone],
      ['Casos notificados', fmtInt(p.cases)],
      ['Casos estimados', fmtInt(p.casesEst)],
      ['Incidência', blank(p.incidence) ? '' : `${fmtNum(p.incidence, 1)} por 100 mil hab.`],
      ['População', fmtInt(p.population, 'hab.')],
      ['Código IBGE', p.ibgeCode],
    ],
    source: 'InfoDengue · DataGeo PR',
    updated: p.fetchedAt,
  });
}

// ------------------------------------------------ ar

/** Categoria do AQI (escala US EPA usada pelo AQICN). */
export function aqiCategoria(aqi) {
  if (blank(aqi) || !Number.isFinite(Number(aqi))) return null;
  const v = Number(aqi);
  if (v <= 50) return { text: 'BOA', tone: 'ok' };
  if (v <= 100) return { text: 'MODERADA', tone: 'warn' };
  if (v <= 150) return { text: 'RUIM P/ SENSÍVEIS', tone: 'warn' };
  if (v <= 200) return { text: 'RUIM', tone: 'alert' };
  if (v <= 300) return { text: 'MUITO RUIM', tone: 'alert' };
  return { text: 'PÉSSIMA', tone: 'alert' };
}

const POLUENTE = { pm25: 'PM2,5', pm10: 'PM10', o3: 'Ozônio (O₃)', no2: 'NO₂', so2: 'SO₂', co: 'CO' };
const subTone = (v) => aqiCategoria(v)?.tone === 'ok' ? undefined : aqiCategoria(v)?.tone;

export function arTooltip(p) {
  const cat = aqiCategoria(p.aqi);
  const sub = (k, label) => [label, fmtInt(p[k]), subTone(p[k])];
  return tipCard({
    icon: '🌫️',
    title: p.city || 'Qualidade do ar',
    subtitle: ['Qualidade do ar', p.stationName].filter(Boolean).join(' · '),
    badge: cat ? { text: `AR ${cat.text}`, tone: cat.tone } : null,
    rows: [
      ['AQI', fmtInt(p.aqi), cat?.tone === 'ok' ? undefined : cat?.tone],
      ['Poluente dominante', POLUENTE[p.pollutant] ?? up(p.pollutant)],
      ['Leitura', fmtDateTime(p.observedAt)],
    ],
    sections: [{
      title: 'Subíndices por poluente (AQI)',
      rows: [sub('pm25', 'PM2,5'), sub('pm10', 'PM10'), sub('o3', 'O₃'), sub('no2', 'NO₂'), sub('so2', 'SO₂'), sub('co', 'CO')],
    }],
    source: 'AQICN · DataGeo PR',
    updated: p.observedAt,
  });
}

// ------------------------------------------------ anomalias

const INDICADOR = {
  temperature: ['Temperatura', '°C', 1],
  humidity: ['Umidade relativa', '%', 0],
  precipitation: ['Precipitação', 'mm', 1],
  wind_speed: ['Velocidade do vento', 'm/s', 1],
  pressure: ['Pressão', 'hPa', 1],
  level_cm: ['Nível do rio', 'cm', 0],
  flow_m3s: ['Vazão', 'm³/s', 1],
  aqi: ['Qualidade do ar (AQI)', '', 0],
  pm25: ['PM2,5', '', 0],
  cases: ['Casos de dengue', 'casos', 0],
  incidence_rate: ['Incidência de dengue', 'por 100 mil', 1],
  fire_count: ['Focos de calor', 'focos', 0],
};
const DOMINIO_ANOMALIA = { clima: 'Clima', hidro: 'Hidrologia', saude: 'Saúde', ar: 'Qualidade do ar', ambiente: 'Ambiente', fogo: 'Focos de calor' };

export function anomaliasTooltip(p) {
  const [nome, unit, casas] = INDICADOR[p.indicator] ?? [cap(p.indicator) || 'Indicador', '', 1];
  const z = blank(p.zScore) ? NaN : Number(p.zScore);
  const severa = Math.abs(z) >= 4;
  const obs = blank(p.observedValue) ? NaN : Number(p.observedValue);
  const media = blank(p.windowMean) ? NaN : Number(p.windowMean);
  return tipCard({
    icon: '📈',
    title: `Anomalia · ${nome}`,
    subtitle: [p.municipality, DOMINIO_ANOMALIA[p.domain] ?? cap(p.domain)].filter(Boolean).join(' · '),
    badge: { text: severa ? 'SEVERA' : 'ANOMALIA', tone: severa ? 'alert' : 'warn' },
    rows: [
      ['Valor observado', fmtNum(obs, casas, unit), severa ? 'alert' : 'warn'],
      ['Média da janela', fmtNum(media, casas, unit)],
      ['Desvio da média', Number.isFinite(obs) && Number.isFinite(media) ? signed(obs - media, casas, unit) : ''],
      ['Desvio-padrão', fmtNum(p.windowStd, casas, unit)],
      ['z-score', Number.isFinite(z) ? `${signed(z, 1)} σ (${z >= 0 ? 'acima' : 'abaixo'} do esperado)` : ''],
      ['Amostras na janela', fmtInt(p.windowSize)],
      ['Estação', p.stationCode],
      ['Detectada em', fmtDateTime(p.detectedAt)],
    ],
    source: 'Detector DataGeo PR',
    updated: p.detectedAt,
  });
}

// ------------------------------------------------ incidentes

export const INCIDENTE_SEVERIDADE = Object.freeze({
  low: { text: 'BAIXA', tone: 'ok' },
  medium: { text: 'MÉDIA', tone: 'warn' },
  high: { text: 'ALTA', tone: 'alert' },
  critical: { text: 'CRÍTICA', tone: 'alert' },
});
const INCIDENTE_STATUS = {
  detected: 'Detectado', open: 'Aberto', new: 'Novo', active: 'Ativo', investigating: 'Em investigação', monitoring: 'Em monitoramento',
  responding: 'Em resposta', in_progress: 'Em andamento', contained: 'Contido', mitigated: 'Mitigado', escalated: 'Escalado',
  resolved: 'Resolvido', closed: 'Encerrado',
};
const OODA = { observe: 'Observar', orient: 'Orientar', decide: 'Decidir', act: 'Agir' };

export function incidentesTooltip(p) {
  const sev = INCIDENTE_SEVERIDADE[p.severity] ?? (p.severity ? { text: up(p.severity), tone: 'warn' } : null);
  return tipCard({
    icon: '🚨',
    title: p.title || 'Incidente',
    subtitle: [`Incidente${p.type ? ` · ${cap(p.type)}` : ''}`, p.municipalities?.split(', ')[0]].filter(Boolean).join(' · '),
    badge: sev ? { text: `SEVERIDADE ${sev.text}`, tone: sev.tone } : null,
    rows: [
      ['Status', INCIDENTE_STATUS[p.status] ?? cap(p.status)],
      ['Fase OODA', OODA[p.oodaPhase] ?? cap(p.oodaPhase)],
      [Number(p.municipalityCount) > 1 ? `Municípios (${p.municipalityCount})` : 'Município', p.municipalities],
      ['Detectado em', fmtDateTime(p.detectedAt)],
      ['Atualizado em', p.updatedAt && p.updatedAt !== p.detectedAt ? fmtDateTime(p.updatedAt) : ''],
    ],
    note: p.description,
    source: 'Incidentes · DataGeo PR',
    updated: p.updatedAt || p.detectedAt,
  });
}

// ------------------------------------------------ InfoHidro

export function infohidroTooltip(p) {
  return tipCard({
    icon: '📡',
    title: p.nome || `Estação ${p.codigo ?? ''}`.trim(),
    subtitle: ['Telemetria hídrica · SIMEPAR/InfoHidro', p.municipio].filter(Boolean).join(' · '),
    rows: [
      ['Código', p.codigo],
      ['Tipo (id InfoHidro)', p.tipoId],
      ['Município', p.municipio],
      ['Rio', p.rio],
      ['Bacia', p.bacia],
      ['Altitude', fmtInt(p.altitude, 'm')],
      ['Responsável', p.responsavel],
      ['Coordenadas', fmtCoord(p.lat, p.lon)],
    ],
    source: 'SIMEPAR · InfoHidro · DataGeo PR',
  });
}

// ------------------------------------------------ marítimo

const SECAO_LINEUP = { atracados: 'Atracado', ao_largo: 'Ao largo', ao_largo_reatracacao: 'Ao largo p/ reatracação' };
/** ETA do AIS: ISO vira data/hora; texto livre passa como veio. */
const etaText = (v) => (blank(v) ? '' : fmtDateTime(v) || String(v));

function lineupTooltip(p) {
  const atracado = p.kind === 'berco';
  const status = SECAO_LINEUP[p.secao] ?? (atracado ? 'Atracado' : 'Ao largo');
  return tipCard({
    icon: '🚢',
    title: p.embarcacao || 'Embarcação',
    subtitle: atracado ? `${status} · ${p.local ?? `Berço ${p.berco ?? '?'}`}` : `${status}${p.berco ? ` · aguarda berço ${p.berco}` : ''}`,
    badge: { text: up(status), tone: atracado ? 'ok' : 'muted' },
    rows: [
      ['IMO', p.imo],
      ['Comprimento (LOA)', fmtNum(p.loaM, 1, 'm')],
      ['Porte bruto (DWT)', fmtInt(p.dwtT, 't')],
      ['Carga', p.mercadorias],
      ['Sentido', p.sentido],
      ['Operador', p.operadores],
      ['Agência', p.agencia],
      ...(atracado
        ? [
            ['Atracação', fmtDateTime(p.atracacao)],
            ['Previsão de término', fmtDateTime(p.janelaFim)],
            ['Operação', progressoOperacao(p.previsto, p.realizado, p.unidade)],
          ]
        : [
            ['Berço previsto', p.berco],
            ['Chegada', fmtDateTime(p.chegada)],
            ['ETA', fmtDateTime(p.eta)],
          ]),
    ],
    note: atracado ? 'Posição aproximada do berço.' : (p.local ?? 'Área de fundeio'),
    source: 'Line-up APPA',
    updated: p.emitidoEm,
  });
}

/** Status de navegação AIS (rótulos ITU-R M.1371 em inglês) -> pt-BR. */
const NAV_STATUS = {
  'under way using engine': 'Navegando a motor',
  'at anchor': 'Fundeado',
  'not under command': 'Sem governo',
  'restricted manoeuvrability': 'Manobra restrita',
  'restricted maneuverability': 'Manobra restrita',
  'constrained by her draught': 'Restrito pelo calado',
  moored: 'Atracado',
  aground: 'Encalhado',
  'engaged in fishing': 'Em pesca',
  'under way sailing': 'Navegando a vela',
  'ais-sart': 'AIS-SART (emergência)',
  'not defined': '',
  undefined: '',
};
export const navStatusPt = (v) => {
  const k = String(v ?? '').trim().toLowerCase();
  return k in NAV_STATUS ? NAV_STATUS[k] : String(v ?? '').trim();
};

function aisTooltip(p) {
  const sog = blank(p.sog) ? NaN : Number(p.sog);
  const moving = Number.isFinite(sog) && sog >= 0.5;
  const dims = [p.lengthM, p.widthM].every((v) => !blank(v) && Number(v) > 0)
    ? `${fmtNum(p.lengthM, 0)} × ${fmtNum(p.widthM, 0)} m`
    : '';
  return tipCard({
    icon: '🚢',
    title: p.vesselName || `MMSI ${p.mmsi ?? '?'}`,
    subtitle: [p.shipType || 'Embarcação', 'AIS'].join(' · '),
    badge: navStatusPt(p.navStatus)
      ? { text: up(navStatusPt(p.navStatus)), tone: moving ? 'info' : 'muted' }
      : { text: moving ? 'EM MOVIMENTO' : 'PARADO', tone: moving ? 'info' : 'muted' },
    rows: [
      ['Velocidade', Number.isFinite(sog) ? `${fmtNum(sog, 1, 'nós')} (${fmtNum(sog * 1.852, 0, 'km/h')})` : ''],
      ['Rumo (COG)', blank(p.cog) ? '' : `${fmtInt(p.cog)}°`],
      ['Proa', blank(p.headingDeg) || Number(p.headingDeg) === 511 ? '' : `${fmtInt(p.headingDeg)}°`],
      ['Destino', p.destination],
      ['ETA', etaText(p.eta)],
      ['Dimensões', dims],
      ['Calado', blank(p.draughtM) || Number(p.draughtM) <= 0 ? '' : fmtNum(p.draughtM, 1, 'm')],
      ['MMSI', p.mmsi],
      ['IMO', blank(p.imo) || Number(p.imo) === 0 ? '' : p.imo],
      ['Indicativo', p.callsign],
      ['Posição', fmtCoord(p.lat, p.lon)],
      ['Posição em', fmtDateTime(p.observedAt)],
    ],
    source: 'AISStream',
    updated: p.observedAt,
  });
}

/** Tooltip de navio: line-up da APPA (atracado/ao largo) ou posição AIS. */
export function maritimoTooltip(p) {
  if (!p || typeof p !== 'object') return '';
  return p.fonte === 'APPA line-up' ? lineupTooltip(p) : aisTooltip(p);
}
