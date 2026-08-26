// src/data/datageoLayers.js
//
// Camadas DataGeo PR (Fase 1 da fusao — ver PLANO_FUSAO.md §3): clima,
// rios, CEMADEN, IRTC e dengue, todas lendo o Supabase do c2-parana via
// datageoClient (anon key, sem proxy).
//
// Todas seguem o contrato de camada do GEV (earthquakes.js como referencia)
// e as regras de performance de la: geometria ESTATICA, redefinida somente
// quando um poll traz dados novos — nunca CallbackProperty por frame, que
// re-tessela primitivas clamped a cada frame (ver o cabecalho de
// earthquakes.js com as medicoes).
//
// Labels usam entity.label com distanceDisplayCondition (simples e
// suficiente na Fase 1; integracao com o label arbiter/overlay do GEV fica
// para a Fase 2 junto com os cards de clique).

import * as Cesium from 'cesium';
import {
  fetchClimateStations,
  fetchRiverStations,
  fetchCemadenAlerts,
  fetchIrtcScores,
  fetchDengueLatestWeek,
  fetchAirQuality,
  fetchAnomalies,
  fetchActiveIncidents,
  fetchInfohidroStations,
  fetchVessels,
} from './datageoClient.js';
import { centroidByIbge, centroidByName } from './prCentroids.js';
import { datageoMunicipiosLayer } from './datageoMunicipios.js';
import { datageoVentosLayer } from './datageoVentos.js';
import { datageoRodoviasLayer } from './datageoRodovias.js';

const LABEL_FONT = '12px "JetBrains Mono", monospace';

function labelGraphics(text, { maxDistance = 2_500_000, pixelOffsetY = -14 } = {}) {
  return {
    text,
    font: LABEL_FONT,
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 2,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, pixelOffsetY),
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, maxDistance),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

/**
 * Factory generica: uma camada DataGeo = fetcher + construtor de entidades.
 * `build(rows, entities)` popula o CustomDataSource e retorna a contagem
 * exibida em getStats/painel.
 */
function createDatageoLayer({ id, name, category, icon, source, updateInterval, fetcher, build }) {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  return {
    id,
    name,
    category,
    icon,
    source,
    updateInterval,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      console.log(`[Data:${id}] Initialized`);
    },

    enable() {
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_dataSource) return false;
      try {
        const rows = await fetcher();
        _dataSource.entities.removeAll();
        _count = build(rows, _dataSource.entities);
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:${id}] Updated: ${_count} registros`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn(`[Data:${id}]`, err);
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

// --------------------------------------------------------------------------
// Clima — estacoes INMET/Open-Meteo (ultima leitura por estacao, 24 h)
// --------------------------------------------------------------------------

function temperatureColor(t) {
  if (t === null || t === undefined) return Cesium.Color.GRAY;
  if (t >= 35) return Cesium.Color.RED;
  if (t >= 28) return Cesium.Color.ORANGE;
  if (t >= 18) return Cesium.Color.LIME;
  if (t >= 10) return Cesium.Color.CYAN;
  return Cesium.Color.DEEPSKYBLUE;
}

export const datageoClimaLayer = createDatageoLayer({
  id: 'datageo-clima',
  name: 'Estações de clima (INMET)',
  category: 'Clima',
  icon: '🌡️',
  source: 'INMET · DataGeo PR',
  updateInterval: 900_000,
  fetcher: fetchClimateStations,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const t = row.temperature === null ? null : Number(row.temperature);
      const ur = row.humidity === null ? null : Number(row.humidity);
      const color = temperatureColor(t);
      const parts = [];
      if (t !== null && Number.isFinite(t)) parts.push(`${t.toFixed(1)}°C`);
      if (ur !== null && Number.isFinite(ur)) parts.push(`${ur.toFixed(0)}%`);
      entities.add({
        id: `datageo-clima:${row.station_code}`,
        position: Cesium.Cartesian3.fromDegrees(Number(row.longitude), Number(row.latitude)),
        point: {
          pixelSize: 7,
          color: color.withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
          `${row.municipality ?? row.station_name ?? row.station_code}\n${parts.join(' · ')}`,
          { maxDistance: 1_200_000 },
        ),
        properties: {
          municipality: row.municipality,
          temperature: t,
          humidity: ur,
          observedAt: row.observed_at,
        },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Rios — estacoes fluviometricas ANA (cor por alert_level)
// --------------------------------------------------------------------------

const RIVER_COLORS = {
  normal: Cesium.Color.LIME,
  attention: Cesium.Color.YELLOW,
  alert: Cesium.Color.ORANGE,
  emergency: Cesium.Color.RED,
};

export const datageoRiosLayer = createDatageoLayer({
  id: 'datageo-rios',
  name: 'Nível dos rios (ANA)',
  category: 'Hidrologia',
  icon: '🌊',
  source: 'ANA · DataGeo PR',
  updateInterval: 900_000,
  fetcher: fetchRiverStations,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const level = row.alert_level ?? 'normal';
      const color = RIVER_COLORS[level] ?? Cesium.Color.LIME;
      const cm = row.level_cm === null ? null : Number(row.level_cm);
      entities.add({
        id: `datageo-rios:${row.station_code}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: 9000,
          semiMinorAxis: 9000,
          material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
          outline: true,
          outlineColor: color.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: labelGraphics(
          `${row.river_name ?? ''} · ${row.station_name ?? row.station_code}` +
            `\n${cm !== null && Number.isFinite(cm) ? `${cm.toFixed(0)} cm · ` : ''}${level.toUpperCase()}`,
          { maxDistance: 1_500_000 },
        ),
        properties: { alertLevel: level, levelCm: cm, municipality: row.municipality },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// CEMADEN — alertas geo-hidrologicos ativos
// --------------------------------------------------------------------------

const CEMADEN_COLORS = {
  observacao: Cesium.Color.DEEPSKYBLUE,
  atencao: Cesium.Color.YELLOW,
  alerta: Cesium.Color.ORANGE,
  alerta_maximo: Cesium.Color.RED,
};

export const datageoCemadenLayer = createDatageoLayer({
  id: 'datageo-cemaden',
  name: 'Alertas de desastre (CEMADEN)',
  category: 'Hidrologia',
  icon: '⚠️',
  source: 'CEMADEN · DataGeo PR',
  updateInterval: 300_000,
  fetcher: fetchCemadenAlerts,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const anchor = centroidByIbge(row.ibge_code);
      if (!anchor) continue;
      const severity = row.severity ?? 'observacao';
      const color = CEMADEN_COLORS[severity] ?? Cesium.Color.DEEPSKYBLUE;
      entities.add({
        id: `datageo-cemaden:${row.alert_code}:${row.ibge_code}`,
        position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        point: {
          pixelSize: 12,
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
          `CEMADEN · ${(row.alert_type ?? '').toUpperCase()}\n${anchor.name} · ${severity.replace('_', ' ').toUpperCase()}`,
          { maxDistance: 3_000_000 },
        ),
        properties: {
          alertType: row.alert_type,
          severity,
          municipality: row.municipality,
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
        },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// IRTC — Indice de Risco Territorial Composto (coropletico por centroide)
// --------------------------------------------------------------------------

const IRTC_COLORS = {
  baixo: Cesium.Color.fromCssColorString('#22c55e'),
  ['médio']: Cesium.Color.fromCssColorString('#eab308'),
  medio: Cesium.Color.fromCssColorString('#eab308'),
  alto: Cesium.Color.fromCssColorString('#f97316'),
  ['crítico']: Cesium.Color.fromCssColorString('#ef4444'),
  critico: Cesium.Color.fromCssColorString('#ef4444'),
};

export const datageoIrtcLayer = createDatageoLayer({
  id: 'datageo-irtc',
  name: 'Risco territorial (IRTC)',
  category: 'Riscos e alertas',
  icon: '🎯',
  source: 'IRTC · DataGeo PR',
  updateInterval: 1_800_000,
  fetcher: fetchIrtcScores,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const anchor = centroidByIbge(row.ibge_code);
      if (!anchor) continue;
      const level = row.risk_level ?? 'baixo';
      const color = IRTC_COLORS[level] ?? IRTC_COLORS.baixo;
      const score = Number(row.irtc_score ?? 0);
      // Raio proporcional ao score (3 km a 14 km) — discos ESTATICOS.
      const radius = 3000 + Math.min(100, Math.max(0, score)) * 110;
      // Destaque (label + outline) so para alto/critico: "medio" cobre a
      // maior parte do estado e 300+ labels viram ruido, nao informacao.
      const emphasized = level === 'alto' || level === 'crítico' || level === 'critico';
      entities.add({
        id: `datageo-irtc:${row.ibge_code}`,
        position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: new Cesium.ColorMaterialProperty(color.withAlpha(emphasized ? 0.45 : 0.15)),
          outline: emphasized,
          outlineColor: color.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: emphasized
          ? labelGraphics(
              `${anchor.name}\nIRTC ${score.toFixed(0)} · ${String(level).toUpperCase()} · ${row.dominant_domain ?? ''}`,
              { maxDistance: 1_800_000 },
            )
          : undefined,
        properties: {
          irtcScore: score,
          riskLevel: level,
          dominantDomain: row.dominant_domain,
          dataCoverage: row.data_coverage,
        },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Dengue — ultima semana epidemiologica InfoDengue (nivel 1-4 por municipio)
// --------------------------------------------------------------------------

const DENGUE_COLORS = {
  1: Cesium.Color.fromCssColorString('#22c55e'),
  2: Cesium.Color.fromCssColorString('#eab308'),
  3: Cesium.Color.fromCssColorString('#f97316'),
  4: Cesium.Color.fromCssColorString('#ef4444'),
};

export const datageoDengueLayer = createDatageoLayer({
  id: 'datageo-dengue',
  name: 'Dengue (InfoDengue)',
  category: 'Saúde e ar',
  icon: '🦟',
  source: 'InfoDengue · DataGeo PR',
  updateInterval: 3_600_000,
  fetcher: fetchDengueLatestWeek,
  build(payload, entities) {
    const { year, week, rows } = payload;
    let count = 0;
    for (const row of rows) {
      const anchor = centroidByIbge(row.ibge_code);
      if (!anchor) continue;
      const level = Math.max(1, Math.min(4, Math.trunc(Number(row.alert_level ?? 1)) || 1));
      const color = DENGUE_COLORS[level];
      const cases = Math.trunc(Number(row.cases ?? 0)) || 0;
      const emphasized = level >= 3;
      entities.add({
        id: `datageo-dengue:${row.ibge_code}`,
        position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        point: {
          pixelSize: emphasized ? 11 : 6,
          color: color.withAlpha(level === 1 ? 0.45 : 0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: emphasized
          ? labelGraphics(
              `${anchor.name}\nDengue nivel ${level} · ${cases} casos · SE ${week}/${year}`,
              { maxDistance: 2_000_000 },
            )
          : undefined,
        properties: { alertLevel: level, cases, week, year },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Qualidade do ar — AQICN nas cidades monitoradas
// --------------------------------------------------------------------------

// air_quality nao guarda lat/lon; coordenadas por city id (mesmo mapa do
// etl-ambiente do c2, CIDADES_AR_GEO).
const AQICN_CITY_GEO = {
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
};

function aqiColor(aqi) {
  if (aqi === null || aqi === undefined) return Cesium.Color.GRAY;
  if (aqi <= 50) return Cesium.Color.LIME;
  if (aqi <= 100) return Cesium.Color.YELLOW;
  if (aqi <= 150) return Cesium.Color.ORANGE;
  if (aqi <= 200) return Cesium.Color.RED;
  return Cesium.Color.PURPLE;
}

export const datageoArLayer = createDatageoLayer({
  id: 'datageo-ar',
  name: 'Qualidade do ar',
  category: 'Saúde e ar',
  icon: '🌫️',
  source: 'AQICN · DataGeo PR',
  updateInterval: 1_800_000,
  fetcher: fetchAirQuality,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const geo = AQICN_CITY_GEO[row.city ?? ''];
      if (!geo) continue;
      const aqi = row.aqi === null ? null : Math.trunc(Number(row.aqi));
      const color = aqiColor(aqi);
      entities.add({
        id: `datageo-ar:${row.city}`,
        position: Cesium.Cartesian3.fromDegrees(geo.lon, geo.lat),
        point: {
          pixelSize: 9,
          color: color.withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
          `${geo.nome}\nAQI ${aqi ?? '?'}${row.dominant_pollutant ? ` · ${row.dominant_pollutant}` : ''}`,
          { maxDistance: 1_200_000 },
        ),
        properties: { aqi, pollutant: row.dominant_pollutant, observedAt: row.observed_at },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Anomalias — z-score dos ultimos 7 dias (detector do c2)
// --------------------------------------------------------------------------

export const datageoAnomaliasLayer = createDatageoLayer({
  id: 'datageo-anomalias',
  name: 'Anomalias estatísticas',
  category: 'Riscos e alertas',
  icon: '📈',
  source: 'DataGeo PR',
  updateInterval: 900_000,
  fetcher: fetchAnomalies,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const anchor = centroidByName(row.municipality) ?? centroidByName(row.station_code);
      if (!anchor) continue;
      const z = Number(row.z_score ?? 0);
      const severe = Math.abs(z) >= 4;
      const color = severe ? Cesium.Color.MAGENTA : Cesium.Color.ORANGE;
      entities.add({
        id: `datageo-anomalias:${row.domain}:${row.indicator}:${row.station_code}:${row.detected_at}`,
        position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        point: {
          pixelSize: severe ? 12 : 9,
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
          `ANOMALIA · ${row.indicator}\n${anchor.name} · z=${z.toFixed(1)} · obs ${Number(row.observed_value ?? 0).toFixed(1)}`,
          { maxDistance: 2_500_000 },
        ),
        properties: { domain: row.domain, indicator: row.indicator, zScore: z },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Incidentes — OODA (Fase 4 do c2), ativos
// --------------------------------------------------------------------------

const INCIDENT_SEVERITY_COLORS = {
  low: Cesium.Color.LIME,
  medium: Cesium.Color.YELLOW,
  high: Cesium.Color.ORANGE,
  critical: Cesium.Color.RED,
};

export const datageoIncidentesLayer = createDatageoLayer({
  id: 'datageo-incidentes',
  name: 'Incidentes ativos',
  category: 'Riscos e alertas',
  icon: '🚨',
  source: 'DataGeo PR',
  updateInterval: 300_000,
  fetcher: fetchActiveIncidents,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const munis = Array.isArray(row.affected_municipalities) ? row.affected_municipalities : [];
      const first = munis[0] ?? {};
      const anchor = centroidByIbge(first.ibge_code) ?? centroidByName(first.name);
      if (!anchor) continue;
      const color = INCIDENT_SEVERITY_COLORS[row.severity ?? 'medium'] ?? Cesium.Color.YELLOW;
      entities.add({
        id: `datageo-incidentes:${row.id}`,
        position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        point: {
          pixelSize: 14,
          color: color.withAlpha(0.95),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
          `INCIDENTE · ${(row.type ?? 'outro').toUpperCase()}\n${row.title ?? ''} · ${(row.status ?? '').toUpperCase()}`,
          { maxDistance: 4_000_000 },
        ),
        properties: { severity: row.severity, status: row.status, type: row.type },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// InfoHidro — 1.300+ estacoes de telemetria SIMEPAR (contexto denso)
// --------------------------------------------------------------------------

export const datageoInfohidroLayer = createDatageoLayer({
  id: 'datageo-infohidro',
  name: 'Telemetria hídrica (InfoHidro)',
  category: 'Hidrologia',
  icon: '📡',
  source: 'SIMEPAR · DataGeo PR',
  updateInterval: 3_600_000,
  fetcher: fetchInfohidroStations,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      entities.add({
        id: `datageo-infohidro:${row.codigo}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 4,
          color: Cesium.Color.CYAN.withAlpha(0.55),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        // Label so bem de perto: 1.300 pontos sao contexto, nao leitura.
        label: labelGraphics(`${row.nome ?? row.codigo}`, {
          maxDistance: 120_000,
          pixelOffsetY: -10,
        }),
        properties: { codigo: row.codigo, tipoId: row.tipo_id },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Maritimo — AIS das ultimas 24 h (maritime_traffic do c2)
// --------------------------------------------------------------------------
//
// FONTE HOJE INATIVA: a conta AISStream do c2 esta cortada desde 2026-08-02
// (o etl-maritimo coleta zero com subscription aceita — diagnostico no plano
// de migracao do c2). A camada le maritime_traffic com janela ESTRITA de
// 24 h — plotar navio de dias atras como se fosse posicao atual seria
// desinformacao — entao ela mostra 0 ate a conta ser reativada
// (aisstream.io -> supabase secrets set AISSTREAM_API_KEY -> reagendar o
// cron do etl-maritimo). Quando a fonte voltar, os navios aparecem aqui
// sem mudanca de codigo.

export const datageoMaritimoLayer = createDatageoLayer({
  id: 'datageo-maritimo',
  name: 'Embarcações (AIS)',
  category: 'Infraestrutura',
  icon: '🚢',
  source: 'AISStream · DataGeo PR',
  updateInterval: 600_000,
  fetcher: fetchVessels,
  build(rows, entities) {
    let count = 0;
    for (const row of rows) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const sog = row.sog_knots === null ? null : Number(row.sog_knots);
      const moving = sog !== null && sog >= 0.5;
      const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(row.observed_at)) / 60_000));
      entities.add({
        id: `datageo-maritimo:${row.mmsi}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: moving ? 10 : 8,
          color: (moving ? Cesium.Color.AQUA : Cesium.Color.LIGHTSTEELBLUE).withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: labelGraphics(
          `${row.vessel_name ?? `MMSI ${row.mmsi}`}` +
            `
${sog !== null ? `${sog.toFixed(1)} kn · ` : ''}` +
            `${row.nav_status_label ?? ''} · ${ageMin}min`,
          { maxDistance: 1_500_000 },
        ),
        properties: {
          mmsi: row.mmsi,
          shipType: row.ship_type_label,
          destination: row.destination,
          observedAt: row.observed_at,
        },
      });
      count++;
    }
    return count;
  },
});

// --------------------------------------------------------------------------
// Ferrovias — malha ferroviaria (OSM, estatica)
// --------------------------------------------------------------------------
//
// CONTEXTO, nao fluxo: nao existe posicao de trem em tempo real publica no
// Brasil (Rumo/concessionarias nao expoem GPS). O que e publico e a MALHA
// (OSM railway=rail, gerada em public/data/ferrovias-pr.geojson) — por onde
// escoa a safra ate Paranagua. Se um dia houver telemetria publica, ela
// vira uma camada dinamica em cima deste traçado.

export const datageoFerroviasLayer = (() => {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  return {
    id: 'datageo-ferrovias',
    name: 'Ferrovias',
    category: 'Infraestrutura',
    icon: '🚆',
    source: 'OpenStreetMap',
    updateInterval: 24 * 3600_000,
    init() {
      console.log('[Data:datageo-ferrovias] Initialized');
    },
    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },
    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },
    async update(viewer) {
      try {
        if (!_dataSource) {
          _dataSource = await Cesium.GeoJsonDataSource.load('/data/ferrovias-pr.geojson', {
            clampToGround: true,
            stroke: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.65),
            strokeWidth: 2,
          });
          _dataSource.show = _enabled;
          await viewer.dataSources.add(_dataSource);
        }
        _count = _dataSource.entities.values.length;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-ferrovias]', err);
        return false;
      }
    },
    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },
    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
})();

export const DATAGEO_LAYERS = [
  datageoMunicipiosLayer,
  datageoClimaLayer,
  datageoRiosLayer,
  datageoCemadenLayer,
  datageoIrtcLayer,
  datageoDengueLayer,
  datageoArLayer,
  datageoAnomaliasLayer,
  datageoIncidentesLayer,
  datageoInfohidroLayer,
  datageoMaritimoLayer,
  datageoFerroviasLayer,
  datageoRodoviasLayer,
  datageoVentosLayer,
];
