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
  anomaliasTooltip,
  aqiCategoria,
  arTooltip,
  cardinal,
  cemadenTooltip,
  climaBadge,
  climaTooltip,
  dengueTooltip,
  incidentesTooltip,
  infohidroTooltip,
  irtcTooltip,
  maritimoTooltip,
  riosTooltip,
} from '../../data/datageoMonitoramento.js';
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
  // tooltip tipCard a partir das properties da feição
  const tipBerco = maritimoTooltip(berco.properties);
  assert.match(tipBerco, /tt-title">MAERSK LINS</);
  assert.match(tipBerco, /tt-badge tt-ok">ATRACADO</);
  assert.match(tipBerco, /Atracado · Berço 216/);
  assert.match(tipBerco, /<dt>IMO<\/dt><dd class="">9527025</);
  assert.match(tipBerco, /299,9 m/);
  assert.match(tipBerco, /CONTÊINERES/);
  assert.match(tipBerco, /Line-up APPA/);
  assert.match(maritimoTooltip(fundeio.properties), /Ao largo · aguarda berço 213/);
  const tipAis = maritimoTooltip(ais.properties);
  assert.match(tipAis, /tt-badge tt-info">UNDER WAY</); // rótulo fora da tabela passa como veio
  assert.match(tipAis, /12,3 nós \(23 km\/h\)/);
  assert.match(tipAis, /180°/);
  assert.match(tipAis, /AISStream/);
  assert.match(maritimoTooltip(parado.properties), /MMSI 710000002.*PARADO/s);
  assert.equal(maritimoTooltip(null), '');
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

// ------------------------------------------------------------------ tooltips

const NOW = Date.parse('2026-09-27T12:00:00Z');
const props = (build, rows) => build(rows).features[0].properties;
const row = (html, label) => {
  const m = html.match(new RegExp(`<dt>${label}</dt><dd class="([^"]*)">([^<]*)</dd>`));
  return m ? { tone: m[1], value: m[2] } : null;
};

test('cardinal e badge de clima', () => {
  assert.equal(cardinal(225), 'SO (225°)');
  assert.equal(cardinal(359), 'N (359°)');
  assert.equal(cardinal(null), '');
  assert.deepEqual(climaBadge(36, 50), { text: 'CALOR EXTREMO', tone: 'alert' });
  assert.equal(climaBadge(25, 10).text, 'UMIDADE · EMERGÊNCIA');
  assert.equal(climaBadge(25, 25).tone, 'warn');
  assert.equal(climaBadge(2, 80).text, 'RISCO DE GEADA');
  assert.equal(climaBadge(22, 60), null);
});

test('tooltip clima: leituras com unidade pt-BR, estação, IBGE, atualizado', () => {
  const p = props(buildClima, [{
    station_code: 'A807', station_name: 'CURITIBA', municipality: 'Curitiba', ibge_code: '4106902',
    latitude: -25.44, longitude: -49.23, temperature: 29.46, humidity: 25, precipitation: 1.2,
    wind_speed: 3.5, wind_direction: 90, pressure: 912.3, observed_at: '2026-09-27T11:48:00Z',
  }]);
  const html = climaTooltip(p);
  assert.match(html, /tt-title">Curitiba</);
  assert.match(html, /Estação INMET · A807 · CURITIBA/);
  assert.deepEqual(row(html, 'Temperatura'), { tone: 'tt-warn', value: '29,5 °C' });
  assert.deepEqual(row(html, 'Umidade relativa'), { tone: 'tt-warn', value: '25%' });
  assert.equal(row(html, 'Vento').value, '3,5 m/s (13 km/h)');
  assert.equal(row(html, 'Direção do vento').value, 'L (90°)');
  assert.equal(row(html, 'Pressão').value, '912,3 hPa');
  assert.equal(row(html, 'Código IBGE').value, '4106902');
  assert.match(html, /UMIDADE · ATENÇÃO/);
  assert.match(html, /INMET · DataGeo PR · atualizado/);
  // campos ausentes somem
  const vazio = climaTooltip(props(buildClima, [{ station_code: 'X1', latitude: -24, longitude: -51, temperature: null, humidity: null }]));
  assert.match(vazio, /tt-title">X1</);
  assert.equal(row(vazio, 'Temperatura'), null);
  assert.doesNotMatch(vazio, /tt-badge/);
});

test('tooltip rios: situação como badge, nível em cm e m, vazão, código ANA', () => {
  const html = riosTooltip(props(buildRios, [{
    station_code: '65310000', station_name: 'União da Vitória', river_name: 'Iguaçu', municipality: 'União da Vitória',
    latitude: -26.23, longitude: -51.08, level_cm: 412.4, flow_m3s: 1530.26, alert_level: 'alert', observed_at: '2026-09-27T11:00:00Z',
  }]));
  assert.match(html, /tt-badge tt-alert">ALERTA</);
  assert.match(html, /Rio Iguaçu · União da Vitória/);
  assert.deepEqual(row(html, 'Nível'), { tone: 'tt-alert', value: '412 cm (4,12 m)' });
  assert.equal(row(html, 'Vazão').value, '1.530,3 m³/s');
  assert.equal(row(html, 'Código ANA').value, '65310000');
  assert.match(riosTooltip(props(buildRios, [{ station_code: '1', latitude: -25, longitude: -50 }])), /tt-badge tt-ok">NORMAL</);
});

test('tooltip CEMADEN: severidade, validade, descrição', () => {
  const html = cemadenTooltip(props(buildCemaden, [{
    alert_code: 'X1', alert_type: 'hidrologico', severity: 'alerta_maximo', municipality: 'Curitiba', ibge_code: '4106902',
    description: 'Risco de inundação <b>alto</b>', issued_at: '2026-09-27T10:00:00Z', expires_at: null,
  }]));
  assert.match(html, /tt-title">Risco hidrológico · Curitiba</);
  assert.match(html, /tt-badge tt-alert">ALERTA MÁXIMO</);
  assert.equal(row(html, 'Válido até').value, 'sem prazo definido');
  assert.equal(row(html, 'Emitido em').value, '27/09/2026 07:00');
  assert.match(html, /tt-note">Risco de inundação &lt;b&gt;alto&lt;\/b&gt;</);
});

test('tooltip IRTC: nível, posição no estado, componentes com tom', () => {
  const { features } = buildIrtc([
    { ibge_code: '4106902', municipality: 'Curitiba', irtc_score: 82.44, risk_level: 'crítico', dominant_domain: 'hidro', data_coverage: 0.8, risk_hidro: 91, risk_clima: 55, risk_ar: 10, calculated_at: '2026-09-27T06:00:00Z' },
    { ibge_code: '4113700', irtc_score: 40, risk_level: 'médio' },
  ]);
  const html = irtcTooltip(features[0].properties);
  assert.match(html, /tt-badge tt-alert">CRÍTICO</);
  assert.equal(row(html, 'IRTC').value, '82,4 / 100');
  assert.equal(row(html, 'Posição no PR').value, '1º de 2 (1º = maior risco)');
  assert.equal(row(html, 'Domínio dominante').value, 'Hidrologia');
  assert.equal(row(html, 'Cobertura de dados').value, '80%');
  assert.deepEqual(row(html, 'Hidrologia'), { tone: 'tt-alert', value: '91 / 100' });
  assert.deepEqual(row(html, 'Clima'), { tone: 'tt-warn', value: '55 / 100' });
  assert.equal(row(html, 'Saúde'), null);
  const med = irtcTooltip(features[1].properties);
  assert.match(med, /tt-title">Londrina</);
  assert.match(med, /tt-badge tt-warn">MÉDIO</);
  assert.equal(row(med, 'Posição no PR').value, '2º de 2 (1º = maior risco)');
});

test('tooltip dengue: nível InfoDengue, casos, incidência, população', () => {
  const html = dengueTooltip(props(buildDengue, {
    year: 2026, week: 37,
    rows: [{ ibge_code: '4106902', municipality_name: 'Curitiba', cases: 1234, cases_est: 1500.7, alert_level: 3, incidence_rate: 64.25, population: 1963726, fetched_at: '2026-09-27T09:00:00Z' }],
  }));
  assert.match(html, /tt-badge tt-alert">NÍVEL 3 · LARANJA</);
  assert.match(html, /semana epidemiológica 37\/2026/);
  assert.equal(row(html, 'Casos notificados').value, '1.234');
  assert.equal(row(html, 'Casos estimados').value, '1.501');
  assert.equal(row(html, 'Incidência').value, '64,3 por 100 mil hab.');
  assert.equal(row(html, 'População').value, '1.963.726 hab.');
  assert.equal(row(html, 'Situação').value, 'Transmissão sustentada');
});

test('tooltip ar: categoria do AQI e subíndices', () => {
  assert.equal(aqiCategoria(40).text, 'BOA');
  assert.equal(aqiCategoria(120).text, 'RUIM P/ SENSÍVEIS');
  assert.equal(aqiCategoria(250).tone, 'alert');
  assert.equal(aqiCategoria(null), null);
  const html = arTooltip(props(buildAr, [{ city: 'curitiba', station_name: 'Curitiba - Boqueirão', aqi: 57.6, dominant_pollutant: 'pm25', pm25: 57, pm10: 20, o3: 8, observed_at: '2026-09-27T11:00:00Z' }]));
  assert.match(html, /tt-title">Curitiba</);
  assert.match(html, /tt-badge tt-warn">AR MODERADA</);
  assert.equal(row(html, 'Poluente dominante').value, 'PM2,5');
  assert.deepEqual(row(html, 'PM10'), { tone: '', value: '20' });
  assert.equal(row(html, 'SO₂'), null);
});

test('tooltip anomalias: valor, média, desvio, z com sinal e unidade', () => {
  const html = anomaliasTooltip(props(buildAnomalias, [{
    domain: 'clima', indicator: 'temperature', station_code: 'A807', municipality: 'CURITIBA',
    observed_value: 34.2, window_mean: 22.1, window_stddev: 2.5, window_size: 168, z_score: 4.84, detected_at: '2026-09-27T11:30:00Z',
  }]));
  assert.match(html, /tt-title">Anomalia · Temperatura</);
  assert.match(html, /Curitiba · Clima/);
  assert.match(html, /tt-badge tt-alert">SEVERA</);
  assert.equal(row(html, 'Valor observado').value, '34,2 °C');
  assert.equal(row(html, 'Desvio da média').value, '+12,1 °C');
  assert.equal(row(html, 'z-score').value, '+4,8 σ (acima do esperado)');
  assert.equal(row(html, 'Amostras na janela').value, '168');
});

test('tooltip incidentes: severidade, status, municípios achatados', () => {
  const html = incidentesTooltip(props(buildIncidentes, [{
    id: 7, title: 'Enchente no Iguaçu', type: 'hidro', severity: 'critical', status: 'monitoring', ooda_phase: 'decide',
    affected_municipalities: [{ ibge_code: '4106902', name: 'Curitiba' }, { ibge_code: '4113700' }],
    description: 'Cheia acima da cota.', detected_at: '2026-09-27T08:00:00Z', updated_at: '2026-09-27T11:00:00Z',
  }]));
  assert.match(html, /tt-badge tt-alert">SEVERIDADE CRÍTICA</);
  assert.equal(row(html, 'Status').value, 'Em monitoramento');
  assert.equal(row(html, 'Fase OODA').value, 'Decidir');
  assert.equal(row(html, 'Municípios \\(2\\)').value, 'Curitiba, Londrina');
  assert.match(html, /Cheia acima da cota\./);
});

test('tooltip InfoHidro: nome, código, coordenadas', () => {
  const html = infohidroTooltip(props(buildInfohidro, [{ codigo: 25334953, nome: 'Rio Negro', latitude: -26.1, longitude: -49.8, tipo_id: 2 }]));
  assert.match(html, /tt-title">Rio Negro</);
  assert.equal(row(html, 'Código').value, '25334953');
  assert.equal(row(html, 'Coordenadas').value, '-26,1000°, -49,8000°');
  assert.match(infohidroTooltip(props(buildInfohidro, [{ codigo: 1, latitude: -26, longitude: -49 }])), /tt-title">Estação 1</);
});

test('tooltip AIS: dimensões, calado, ETA e IMO zero omitido', () => {
  const p = buildMaritimo({ lineup: null, vessels: [{
    mmsi: 710000001, vessel_name: 'NAVIO', ship_type_label: 'Tanker', latitude: -25.6, longitude: -48.3, sog_knots: 0, cog_deg: 90,
    heading_deg: 511, imo: 0, callsign: 'PPXX', length_m: 183, width_m: 32, draught_m: 9.8, eta: '2026-09-28T10:00:00Z',
    nav_status_label: null, destination: 'PARANAGUA', observed_at: '2026-09-27T11:50:00Z',
  }] }, NOW).features[0].properties;
  const html = maritimoTooltip(p);
  assert.match(html, /tt-badge tt-muted">PARADO</);
  assert.equal(row(html, 'Dimensões').value, '183 × 32 m');
  assert.equal(row(html, 'Calado').value, '9,8 m');
  assert.equal(row(html, 'ETA').value, '28/09/2026 07:00');
  assert.equal(row(html, 'IMO'), null);
  assert.equal(row(html, 'Proa'), null);
  assert.equal(row(html, 'Indicativo').value, 'PPXX');
  assert.match(maritimoTooltip({ ...p, navStatus: 'Under way using engine', sog: 12 }), /tt-badge tt-info">NAVEGANDO A MOTOR</);
  assert.match(maritimoTooltip({ ...p, navStatus: 'At anchor' }), /tt-badge tt-muted">FUNDEADO</);
});
