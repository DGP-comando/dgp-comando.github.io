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
        `\n${cm !== null && Number.isFinite(cm) ? `${cm.toFixed(0)} cm · ` : ''}${level.toUpperCase()}`,
      alertLevel: level,
      levelCm: cm,
      municipality: row.municipality,
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
      municipality: row.municipality,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
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
      label: `INCIDENTE · ${(row.type ?? 'outro').toUpperCase()}\n${row.title ?? ''} · ${(row.status ?? '').toUpperCase()}`,
      severity: row.severity,
      status: row.status,
      type: row.type,
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
