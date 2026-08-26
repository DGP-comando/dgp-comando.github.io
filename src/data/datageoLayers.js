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
} from './datageoClient.js';
import { centroidByIbge } from './prCentroids.js';

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
function createDatageoLayer({ id, name, icon, source, updateInterval, fetcher, build }) {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  return {
    id,
    name,
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
  name: 'Clima (estações)',
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
  name: 'Rios (ANA)',
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
  name: 'Alertas CEMADEN',
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
  name: 'IRTC (risco territorial)',
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

export const DATAGEO_LAYERS = [
  datageoClimaLayer,
  datageoRiosLayer,
  datageoCemadenLayer,
  datageoIrtcLayer,
  datageoDengueLayer,
];
