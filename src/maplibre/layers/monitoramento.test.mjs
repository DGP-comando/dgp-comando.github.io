// Testes das feições do grupo MONITORAMENTO (src/data/datageoMonitoramento.js)
// com linhas de exemplo no formato que os fetchers de datageoClient.js devolvem.
//   node --test src/maplibre/layers/monitoramento.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LABEL_MAX_DISTANCE,
  SHIP_FAR_IMAGE_H,
  SHIP_NEAR_IMAGE_H,
  arrivals,
  buildAnomalias,
  buildAr,
  buildCemaden,
  buildClima,
  buildDengue,
  buildIncidentes,
  buildInfohidro,
  buildIrtc,
  buildMaritimo,
  buildRios,
  headingToIconRotate,
  irtcRadiusM,
  metersToPixelsAtZoom0,
} from '../../data/datageoMonitoramento.js';
import { vesselTooltipHtml } from '../../data/vesselTooltip.js';
import { zoomForHeight } from '../kit.js';

const fid = (f) => f.properties.fid;
const coords = (f) => f.geometry.coordinates;

test('clima: cor por temperatura, rótulo município + T · UR, id por estação', () => {
  const { features, count } = buildClima([
    { station_code: 'A807', station_name: 'CURITIBA', municipality: 'Curitiba', latitude: '-25.44', longitude: '-49.23', temperature: 36.2, humidity: 40, observed_at: '2026-09-25T12:00:00Z' },
    { station_code: 'A821', station_name: 'X', municipality: null, latitude: -24, longitude: -51, temperature: null, humidity: 81.4 },
    { station_code: 'A1', latitude: -24, longitude: -51, temperature: 20, humidity: null },
    { station_code: 'A2', latitude: -24, longitude: -51, temperature: 5, humidity: null },
  ]);
  assert.equal(count, 4);
  assert.equal(fid(features[0]), 'datageo-clima:A807');
  assert.deepEqual(coords(features[0]), [-49.23, -25.44]);
  assert.equal(features[0].properties.color, '#ff0000');
  assert.equal(features[0].properties.label, 'Curitiba\n36.2°C · 40%');
  assert.equal(features[0].properties.radius, 3.5);
  assert.equal(features[1].properties.color, '#808080');
  assert.equal(features[1].properties.label, 'X\n81%');
  assert.equal(features[2].properties.color, '#00ff00');
  assert.equal(features[3].properties.color, '#00bfff');
});

test('rios: disco de 9 km, cor por alert_level, estação sem coordenada descartada', () => {
  const { features } = buildRios([
    { station_code: '6', station_name: 'União da Vitória', river_name: 'Iguaçu', latitude: -26.23, longitude: -51.08, level_cm: 412.4, alert_level: 'alert' },
    { station_code: '7', latitude: null, longitude: 'x' },
    { station_code: '8', station_name: null, river_name: null, latitude: -25, longitude: -50, level_cm: null, alert_level: null },
  ]);
  assert.equal(features.length, 2);
  const [a, b] = features;
  assert.equal(a.properties.color, '#ffa500');
  assert.equal(a.properties.label, 'Iguaçu · União da Vitória\n412 cm · ALERT');
  assert.equal(b.properties.label, ' · 8\nNORMAL');
  // raio em pixels no zoom 10 ≈ 9000 m / (m/px no zoom 10 na latitude).
  const mpp10 = (40_075_016.686 * Math.cos((-26.23 * Math.PI) / 180)) / (512 * 2 ** 10);
  assert.ok(Math.abs(a.properties.r0 * 2 ** 10 - 9000 / mpp10) < 1e-6);
});

test('CEMADEN: ancora no centróide IBGE, rótulo com tipo e severidade', () => {
  const { features } = buildCemaden([
    { alert_code: 'X1', alert_type: 'hidrologico', severity: 'alerta_maximo', municipality: 'Curitiba', ibge_code: '4106902' },
    { alert_code: 'X2', ibge_code: '9999999' },
  ]);
  assert.equal(features.length, 1);
  assert.equal(fid(features[0]), 'datageo-cemaden:X1:4106902');
  assert.equal(features[0].properties.color, '#ff0000');
  assert.equal(features[0].properties.label, 'CEMADEN · HIDROLOGICO\nCuritiba · ALERTA MAXIMO');
  assert.equal(features[0].properties.radius, 6);
});

test('IRTC: raio 3-14 km pelo score, rótulo e contorno só em alto/crítico', () => {
  assert.equal(irtcRadiusM(0), 3000);
  assert.equal(irtcRadiusM(150), 14000);
  const { features } = buildIrtc([
    { ibge_code: '4106902', irtc_score: 82.4, risk_level: 'crítico', dominant_domain: 'hidro' },
    { ibge_code: '4113700', irtc_score: 40, risk_level: 'médio' },
  ]);
  const [crit, med] = features;
  assert.equal(crit.properties.label, 'Curitiba\nIRTC 82 · CRÍTICO · hidro');
  assert.equal(crit.properties.opacity, 0.45);
  assert.equal(crit.properties.strokeWidth, 2);
  assert.equal(med.properties.label, '');
  assert.equal(med.properties.opacity, 0.15);
  assert.equal(med.properties.strokeWidth, 0);
  assert.equal(med.properties.color, '#eab308');
});

test('dengue: nível 1-4, destaque (11 px + rótulo) a partir do 3', () => {
  const { features } = buildDengue({
    year: 2026,
    week: 37,
    rows: [
      { ibge_code: '4106902', cases: 120, alert_level: 4 },
      { ibge_code: '4113700', cases: 3, alert_level: 1 },
      { ibge_code: '4115200', cases: '7.9', alert_level: 9 },
    ],
  });
  assert.equal(features[0].properties.label, 'Curitiba\nDengue nivel 4 · 120 casos · SE 37/2026');
  assert.equal(features[0].properties.radius, 5.5);
  assert.equal(features[1].properties.label, '');
  assert.equal(features[1].properties.opacity, 0.45);
  assert.equal(features[1].properties.radius, 3);
  assert.equal(features[2].properties.alertLevel, 4);
  assert.equal(features[2].properties.cases, 7);
  assert.equal(buildDengue({ year: null, week: null, rows: [] }).count, 0);
});

test('ar: coordenada pelo city id, cor AQI', () => {
  const { features } = buildAr([
    { city: 'curitiba', aqi: 57.6, dominant_pollutant: 'pm25' },
    { city: 'foz', aqi: null },
    { city: 'desconhecida', aqi: 10 },
  ]);
  assert.equal(features.length, 2);
  assert.deepEqual(coords(features[0]), [-49.27, -25.43]);
  assert.equal(features[0].properties.label, 'Curitiba\nAQI 57 · pm25');
  assert.equal(features[0].properties.color, '#ffff00');
  assert.equal(features[1].properties.label, 'Foz do Iguaçu\nAQI ?');
});

test('anomalias: âncora por nome sem acento, magenta se |z| >= 4', () => {
  const { features } = buildAnomalias([
    { domain: 'clima', indicator: 'temperature', station_code: 'A807', municipality: 'SAO JOSE DOS PINHAIS', observed_value: 38.12, z_score: -4.2, detected_at: 't1' },
    { domain: 'clima', indicator: 'humidity', station_code: 'Londrina', municipality: null, observed_value: null, z_score: 3, detected_at: 't2' },
  ]);
  assert.equal(features.length, 2);
  assert.equal(features[0].properties.color, '#ff00ff');
  assert.equal(features[0].properties.radius, 6);
  assert.equal(features[0].properties.label, 'ANOMALIA · temperature\nSão José dos Pinhais · z=-4.2 · obs 38.1');
  assert.equal(fid(features[0]), 'datageo-anomalias:clima:temperature:A807:t1');
  assert.equal(features[1].properties.color, '#ffa500');
});

test('incidentes: 1º município afetado, cor por severidade', () => {
  const { features } = buildIncidentes([
    { id: 7, title: 'Enchente', type: 'hidro', severity: 'critical', status: 'active', affected_municipalities: [{ ibge_code: '4106902', name: 'Curitiba' }] },
    { id: 8, title: 'Y', severity: 'weird', status: null, affected_municipalities: [{ name: 'Londrina' }] },
    { id: 9, affected_municipalities: null },
  ]);
  assert.equal(features.length, 2);
  assert.equal(features[0].properties.label, 'INCIDENTE · HIDRO\nEnchente · ACTIVE');
  assert.equal(features[0].properties.color, '#ff0000');
  assert.equal(features[1].properties.color, '#ffff00');
  assert.equal(features[1].properties.label, 'INCIDENTE · OUTRO\nY · ');
});

test('InfoHidro: ponto ciano de 4 px, rótulo nome ou código', () => {
  const { features } = buildInfohidro([
    { codigo: 25334953, nome: 'Rio Negro', latitude: -26.1, longitude: -49.8, tipo_id: 2 },
    { codigo: 1, latitude: -26, longitude: -49 },
    { codigo: 2 },
  ]);
  assert.equal(features.length, 2);
  assert.equal(features[0].properties.radius, 2);
  assert.equal(features[0].properties.opacity, 0.55);
  assert.equal(features[1].properties.label, '1');
});

test('tetos de rótulo viram minzoom crescente com a proximidade', () => {
  assert.ok(zoomForHeight(LABEL_MAX_DISTANCE.infohidro) > zoomForHeight(LABEL_MAX_DISTANCE.clima));
  assert.ok(Math.abs(zoomForHeight(LABEL_MAX_DISTANCE.clima) - 8.64) < 0.01);
});

test('marítimo: line-up (berço/fundeio) + AIS, tamanhos, rumo e tooltip', () => {
  const now = Date.parse('2026-09-13T22:30:00Z');
  const lineup = {
    version: 1,
    fetched_at: '2026-09-13T22:20:00Z',
    emitted_at: '2026-09-13T21:00:00Z',
    navios: [
      {
        secao: 'atracados', programacao: '78891', embarcacao: 'MAERSK LINS', berco: '216', imo: '9527025', loa_m: 299.9,
        sentido: 'Imp/Exp', operadores: ['TCP'], mercadorias: ['CONTÊINERES'], atracacao: '2026-09-13T08:50:00-03:00',
        posicao: { lat: -25.50046, lon: -48.4985, tipo: 'berco', local: 'Berço 216', rumo: 72 },
      },
      {
        secao: 'ao_largo', programacao: '80499', embarcacao: 'TRIDENT STAR', berco: '213', operadores: [], mercadorias: [],
        chegada: '2026-09-12T00:01:00-03:00',
        posicao: { lat: -25.49939, lon: -48.46363, tipo: 'fundeio', local: 'Área de fundeio 5 (posição ilustrativa)' },
      },
    ],
  };
  const vessels = [
    { mmsi: 710000001, vessel_name: 'NAVIO AIS', ship_type_label: 'Cargo', latitude: -25.6, longitude: -48.3, sog_knots: 12.34, cog_deg: 180, nav_status_label: 'Under way', destination: 'PNG', observed_at: '2026-09-13T22:00:00Z' },
    { mmsi: 710000002, vessel_name: null, latitude: -25.6, longitude: -48.3, sog_knots: 0.1, cog_deg: null, nav_status_label: null, observed_at: '2026-09-13T22:30:00Z' },
    { mmsi: 3, latitude: 'x', longitude: undefined },
  ];
  const { features, count } = buildMaritimo({ lineup, vessels }, now);
  assert.equal(count, 4);
  const [berco, fundeio, ais, parado] = features;
  assert.equal(fid(berco), 'datageo-maritimo:appa:78891');
  assert.equal(berco.properties.shipImage, 'berco');
  assert.equal(berco.properties.rotate, 72);
  assert.equal(berco.properties.labelKind, 'lineup');
  assert.equal(berco.properties.labelDy, -2);
  assert.equal(berco.properties.label, 'MAERSK LINS\nBerço 216 · CONTÊINERES');
  // longe: 299,9 m × 0,065 = 19,5 -> 19 px
  assert.equal(berco.properties.farSize * SHIP_FAR_IMAGE_H, 19);
  // perto: tamanho em metros (LOA) -> pixels no zoom 0 na latitude.
  assert.ok(Math.abs(berco.properties.nearSize0 * SHIP_NEAR_IMAGE_H - metersToPixelsAtZoom0(299.9, -25.50046)) < 1e-12);
  assert.equal(fundeio.properties.shipImage, 'fundeio');
  assert.equal(fundeio.properties.rotate, 45); // sem rumo: 45°, como headingToRotation
  assert.ok(fundeio.properties.labelDy > 0);
  assert.equal(ais.properties.shipImage, 'ais-mov');
  assert.equal(ais.properties.label, 'NAVIO AIS\n12.3 kn · Under way · 30min');
  assert.equal(ais.properties.rotate, 180);
  assert.equal(parado.properties.shipImage, 'ais-parado');
  assert.equal(parado.properties.label, 'MMSI 710000002\n0.1 kn ·  · 0min');
  // tooltip igual ao do app, a partir das properties da feição
  const tipBerco = vesselTooltipHtml(berco.properties);
  assert.match(tipBerco, /vt-nome">MAERSK LINS</);
  assert.match(tipBerco, /Atracado · Berço 216/);
  assert.match(tipBerco, /IMO 9527025 · LOA 299,9 m/);
  assert.match(vesselTooltipHtml(fundeio.properties), /Ao largo · aguarda berço 213/);
  assert.match(vesselTooltipHtml(ais.properties), /vt-ais">Under way/);
  assert.equal(buildMaritimo({ lineup: null, vessels: [] }).count, 0);
});

test('rumo -> icon-rotate: horário a partir do norte, normalizado', () => {
  assert.equal(headingToIconRotate(0), 0);
  assert.equal(headingToIconRotate(-90), 270);
  assert.equal(headingToIconRotate(725), 5);
  assert.equal(headingToIconRotate(undefined), 45);
});

test('arrivals: sem destaque no 1º refresh, novos ids depois', () => {
  const mk = (ids) => ids.map((id) => ({ properties: { fid: id } }));
  const first = arrivals(new Set(), mk(['a', 'b']), 1);
  assert.equal(first.highlight, false);
  assert.deepEqual(first.newIds, ['a', 'b']);
  const second = arrivals(first.ids, mk(['b', 'c']), 2);
  assert.equal(second.highlight, true);
  assert.deepEqual(second.newIds, ['c']);
  const third = arrivals(second.ids, mk(['b', 'c']), 3);
  assert.equal(third.highlight, false);
});
