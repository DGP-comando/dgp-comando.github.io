// node --test src/maplibre/layers/contextoGev.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import layers, {
  applyFiresPayload,
  buildCableData,
  buildEarthquakeFeatures,
  buildFireCells,
  buildFireFeatures,
  buildLocalInfraFeatures,
  cableTooltip,
  EARTHQUAKE_LABEL_CAP,
  earthquakeTooltip,
  FIRMS_ZOOM,
  filtrosFirms,
  fireTooltip,
  lineLengthKm,
  localInfraTooltip,
  metricRadiusExpression,
  parseGeoJsonLines,
  radiusPxAtZ0,
} from './contextoGev.js';
import { adaptFirmsRecords } from '../../data/firmsAdapt.js';

test('ids, categorias e ordem do painel iguais ao app', () => {
  assert.deepEqual(
    layers.map((l) => [l.id, l.category]),
    [
      ['earthquakes', 'Contexto global'],
      ['local-datacenters', 'Contexto global'],
      ['local-dams', 'Contexto global'],
      ['telegeography-submarine-cables', 'Contexto global'],
      ['local-firms', 'Ambiente'],
    ],
  );
  assert.equal(layers[0].name, 'Terremotos (24h)');
  assert.equal(layers[0].refreshMs, 60000);
  assert.equal(layers[4].refreshMs, 600000);
});

test('estilo das camadas valida na spec do MapLibre', () => {
  const sources = {};
  const all = [];
  for (const l of layers) {
    Object.assign(sources, l.sources);
    all.push(...l.layers);
  }
  const errors = validateStyleMin({ version: 8, glyphs: 'https://x/{fontstack}/{range}.pbf', sources, layers: all });
  assert.deepEqual(errors.map((e) => e.message), []);
});

test('terremotos: corte M2.5, cor por profundidade, disco 2^mag km e rótulo nos maiores', () => {
  const feature = (id, mag, depth, lat = 0) => ({
    id,
    geometry: { coordinates: [10, lat, depth] },
    properties: { mag, place: `lugar ${id}`, time: 1700000000000 },
  });
  const out = buildEarthquakeFeatures({
    features: [feature('a', 2.4, 10), feature('b', 3, 10), feature('c', 5.1, 100), feature('d', 4, 400, 60)],
  });
  assert.deepEqual(out.features.map((f) => f.properties.id), ['b', 'c', 'd']);
  const [b, c, d] = out.features.map((f) => f.properties);
  assert.equal(b.color, '#ff0000');
  assert.equal(c.color, '#ffa500');
  assert.equal(d.color, '#ffff00');
  assert.deepEqual([b.band, c.band, d.band], ['red', 'orange', 'yellow'], 'faixa = chave da legenda');
  assert.equal(c.sig, true);
  assert.equal(b.sig, false);
  assert.equal(c.label, 'M5.1');
  // 2^3 km no equador, e o dobro de pixels a 60° de latitude.
  assert.ok(Math.abs(b.r0 - 8000 / (40075016.686 / 512)) < 1e-9);
  assert.ok(Math.abs(radiusPxAtZ0(1000, 60) / radiusPxAtZ0(1000, 0) - 2) < 1e-9);
  assert.ok(out.features.every((f) => f.properties.lab));
  const many = buildEarthquakeFeatures({
    features: Array.from({ length: 120 }, (_, i) => feature(`e${i}`, 2.5 + i * 0.01, 5)),
  });
  const labelled = many.features.filter((f) => f.properties.lab).map((f) => f.properties.mag);
  assert.equal(labelled.length, EARTHQUAKE_LABEL_CAP);
  assert.ok(Math.min(...labelled) > 2.5 + 23 * 0.01 - 1e-9);
  const tip = earthquakeTooltip(c, [10, 20]);
  assert.match(tip, /class="tt"/);
  assert.match(tip, /tt-title">lugar c</);
  assert.match(tip, /tt-badge tt-warn">M5,1</);
  assert.match(tip, /100,0 km · intermediária/);
  assert.match(tip, /20,000°, 10,000°/);
  assert.match(tip, /USGS · feed de 24 h/);
  const rich = buildEarthquakeFeatures({ features: [{ id: 'us1', geometry: { coordinates: [-70, -30, 20] }, properties: { mag: 6.4, place: 'Chile', time: Date.now() - 600_000, magType: 'mww', tsunami: 1, alert: 'orange', felt: 1234, status: 'reviewed' } }] }).features[0];
  const richTip = earthquakeTooltip(rich.properties, rich.geometry.coordinates);
  assert.match(richTip, /tt-badge tt-alert">M6,4</);
  assert.match(richTip, /6,4 \(mww\)/);
  assert.match(richTip, /alerta de tsunami emitido/);
  assert.match(richTip, /Alerta PAGER<\/dt><dd class="tt-alert">laranja/);
  assert.match(richTip, /1\.234/);
  assert.match(richTip, /revisado/);
  assert.match(richTip, /atualizado há 10 min/);
  assert.doesNotMatch(tip, /Tsunami|PAGER/);
});

test('raio métrico dobra por nível de zoom com piso em pixels', () => {
  const expr = metricRadiusExpression('r0', 2);
  assert.equal(expr[0], 'interpolate');
  assert.deepEqual(expr[1], ['exponential', 2]);
  assert.deepEqual(expr[4], ['max', 2, ['*', ['get', 'r0'], 1]]);
  assert.deepEqual(expr[6], ['max', 2, ['*', ['get', 'r0'], 4]]);
});

test('infraestrutura local: um ponto por ponto/polígono, card do app, linhas só contam', () => {
  const text = [
    JSON.stringify({ id: 1, type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { tags: { name: 'DC Um', operator: 'Op', capacity: '5 MW' } } }),
    '',
    JSON.stringify({ id: 2, type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]] }, properties: { osm_id: 77 } }),
    JSON.stringify({ id: 3, type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[10, 10], [12, 10], [12, 12], [10, 10]]], [[[20, 20], [22, 20], [22, 22], [20, 20]]]] }, properties: {} }),
    JSON.stringify({ id: 4, type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} }),
  ].join('\n');
  const features = parseGeoJsonLines(text);
  assert.equal(features.length, 4);
  const built = buildLocalInfraFeatures(features, 'local-datacenters');
  assert.equal(built.count, 5);
  assert.equal(built.points.features.length, 4);
  assert.equal(built.polygons.features.length, 2);
  const [one, two] = built.points.features;
  assert.equal(one.properties.title, 'DC Um');
  assert.equal(one.properties.detail, 'Op · 5 MW');
  assert.ok(one.properties.prio >= 1000);
  assert.deepEqual(two.geometry.coordinates, [1, 2]);
  assert.equal(two.properties.title, 'Datacenter 77');
  const dams = buildLocalInfraFeatures(
    [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'Itaipu', tags: { river: 'Paraná' } } }],
    'local-dams',
  );
  assert.equal(dams.points.features[0].properties.detail, 'Paraná');
});

test('infraestrutura local: tooltip com os campos úteis do OSM', () => {
  const itaipu = buildLocalInfraFeatures([{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-54.59, -25.41] },
    properties: {
      name: 'Usina Hidrelétrica de Itaipu', osm_id: -19685440, output: '14000 MW', source: 'hydro', source_layer: 'power_plant',
      tags: { power: 'plant', operator: 'Itaipú Binacional', 'plant:method': 'water-storage', start_date: '1984', wikipedia: 'es:Represa de Itaipú', river: 'Rio Paraná', height: '196' },
    },
  }], 'local-dams').points.features[0];
  const tip = localInfraTooltip('local-dams', itaipu.properties, itaipu.geometry.coordinates);
  assert.match(tip, /tt-title">Usina Hidrelétrica de Itaipu</);
  assert.match(tip, /Barragem · usina hidrelétrica/);
  assert.match(tip, /Itaipú Binacional/);
  assert.match(tip, /14\.000 MW/);
  assert.match(tip, /reservatório/);
  assert.match(tip, /Rio Paraná/);
  assert.match(tip, /196 m/);
  assert.match(tip, /-25,4100°, -54,5900°/);
  assert.match(tip, /OpenStreetMap/);
  const dc = buildLocalInfraFeatures([{
    type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { osm_id: 9, tags: { name: 'DC Um', operator: 'Op', capacity: '5 MW', website: 'https://dc.example', 'building:levels': '3' } },
  }], 'local-datacenters').points.features[0];
  const dtip = localInfraTooltip('local-datacenters', dc.properties, dc.geometry.coordinates);
  assert.match(dtip, /tt-sub">Datacenter</);
  assert.match(dtip, /Carga de TI<\/dt><dd class="">5 MW/);
  assert.match(dtip, /https:\/\/dc\.example/);
  assert.doesNotMatch(dtip, /Potência instalada/);
  // Tudo plano: nada de objeto/array nas propriedades (queryRenderedFeatures).
  for (const v of Object.values(dc.properties)) assert.ok(v === null || typeof v !== 'object');
  const lyr = layers.find((l) => l.id === 'local-dams');
  assert.equal(lyr.tooltip(itaipu.properties, itaipu), tip);
});

test('cabos: linhas com a cor do cabo, referências de cabo e de estação, rótulo cortado', () => {
  const cables = {
    features: [
      { type: 'Feature', properties: { id: 'c1', name: 'Cabo Muito Longo Com Um Nome Enorme Demais', color: '#ff00ff', coordinates: [-40, -20] }, geometry: { type: 'MultiLineString', coordinates: [[[-41, -21], [-39, -19]]] } },
      { type: 'Feature', properties: { id: 'c2', name: 'Sem Coord' }, geometry: { type: 'LineString', coordinates: [[0, 0], [2, 2]] } },
    ],
  };
  const landings = {
    features: [{ type: 'Feature', properties: { id: 'l1', name: 'Santos, Brazil', is_tbd: true }, geometry: { type: 'Point', coordinates: [-46.3, -23.9] } }],
  };
  const built = buildCableData(cables, landings);
  assert.equal(built.count, 3);
  assert.equal(built.lines.features.length, 2);
  assert.equal(built.lines.features[0].properties.color, '#ff00ff');
  assert.equal(built.lines.features[1].properties.color, '#39d5ff');
  const refs = built.refs.features.map((f) => [f.properties.kind, f.geometry.coordinates]);
  assert.deepEqual(refs, [['cable', [-40, -20]], ['cable', [1, 1]], ['landing-point', [-46.3, -23.9]]]);
  assert.equal(built.refs.features[0].properties.label.length, 34);
  assert.ok(built.refs.features[0].properties.label.endsWith('...'));
  assert.equal(built.refs.features[2].properties.tbd, true);
  // Extensão: ~310 km do trecho (-41,-21)->(-39,-19).
  const km = built.lines.features[0].properties.km;
  assert.ok(km > 290 && km < 320, `km ${km}`);
  assert.ok(Math.abs(lineLengthKm({ type: 'LineString', coordinates: [[0, 0], [1, 0]] }) - 111.2) < 0.2);
  const lineTip = cableTooltip(built.lines.features[0].properties);
  assert.match(lineTip, /Cabo submarino de telecomunicações/);
  assert.match(lineTip, new RegExp(`Extensão aprox\\.</dt><dd class="">${km.toLocaleString('pt-BR')} km`));
  assert.match(lineTip, /TeleGeography/);
  const landTip = cableTooltip(built.refs.features[2].properties);
  assert.match(landTip, /tt-title">Santos, Brazil</);
  assert.match(landTip, /Estação de ancoragem/);
  assert.match(landTip, /tt-badge tt-warn">A DEFINIR</);
  assert.match(landTip, /-23,900°, -46,300°/);
  const lyr = layers.find((l) => l.id === 'telegeography-submarine-cables');
  assert.ok(lyr.interactive.includes('dg-cables-hit'));
  const hit = lyr.layers.find((l) => l.id === 'dg-cables-hit');
  assert.ok(hit.paint['line-width'] >= 10 && hit.paint['line-opacity'] < 0.05);
});

const NOW = Date.UTC(2026, 8, 25, 12, 0);
const raw = [
  { lat: -24.5, lon: -51.5, frp: 0, confidence: 'h', brightness: 330, daynight: 'N', acqDate: '2026-09-25', acqTime: '0930', satellite: 'N20', instrument: 'VIIRS', municipality: 'Pitanga' },
  { lat: -24.6, lon: -51.4, frp: 200, confidence: 'n', brightness: 340, daynight: 'D', acqDate: '2026-09-24', acqTime: '1500', satellite: 'N', instrument: 'VIIRS', municipality: 'Ivaí' },
  { lat: 'x', lon: 1 },
  { lat: -10.5, lon: -55.5, frp: 40, confidence: 'l', brightness: 310, acqDate: '2026-09-25', acqTime: '1100', satellite: 'N21', instrument: 'VIIRS', municipality: '' },
];

test('focos: severidade, tamanho e cards do app', () => {
  const fires = adaptFirmsRecords(raw);
  const out = buildFireFeatures(fires, NOW).features.map((f) => f.properties);
  assert.equal(out.length, 3);
  const [a, b, c] = out;
  assert.equal(a.sev, 'yellow');
  assert.equal(a.size, 8);
  assert.equal(a.title, '▲ 0.0 MW');
  assert.equal(a.detail, 'high · 3h · N20');
  assert.equal(a.selTitle, 'FIRE · 0.0 MW');
  assert.equal(a.selDetail, 'high conf · 3h ago · VIIRS N20\n24.500°S 51.500°W · NIGHT');
  assert.equal(b.sev, 'red');
  assert.equal(b.color, 'rgb(224, 82, 82)');
  assert.equal(b.title, '▲ 200 MW');
  assert.equal(b.size, 28);
  assert.equal(c.sev, 'orange');
  assert.ok(a.w > 0 && a.w <= 1);
});

test('focos: células agregadas com o card "N FIRES"', () => {
  const fires = adaptFirmsRecords(raw);
  const cells = buildFireCells(fires, 1, NOW).features;
  assert.equal(cells.length, 2);
  const pr = cells.find((f) => f.properties.title === '2 FIRES');
  assert.deepEqual(pr.geometry.coordinates, [-51.5, -24.5]);
  assert.equal(pr.properties.detail, 'max 200 MW · new 3h');
  assert.equal(pr.properties.color, 'rgb(224, 82, 82)');
  const one = cells.find((f) => f.properties.title === '1 FIRE');
  assert.ok(one.properties.score < pr.properties.score);
});

test('focos: payload aplicado às fontes, município no tooltip, faixas de zoom do LOD', () => {
  const data = {};
  const ctx = { setData: (id, fcol) => { data[id] = fcol; }, map: { getLayer: () => null } };
  const st = applyFiresPayload(ctx, { fires: raw, stale: true }, NOW);
  assert.equal(st.count, 3);
  assert.deepEqual(st.sev, { red: 1, orange: 1, yellow: 1 });
  assert.equal(st.info, 'dado antigo (cache)');
  assert.equal(data['dg-firms'].features.length, 3);
  assert.equal(data['dg-firms-lbl'], data['dg-firms']);
  assert.ok(data['dg-firms-cells2'].features.length >= 1);
  const firmsLayer = layers.find((l) => l.id === 'local-firms');
  const f1 = data['dg-firms'].features[1];
  const tip = firmsLayer.tooltip(f1.properties, f1);
  assert.match(tip, /tt-title">Ivaí</);
  assert.match(tip, /tt-badge tt-alert">ALTA</, 'com FRP, selo = severidade');
  assert.match(tip, /200 MW/);
  assert.match(tip, /24\/09\/2026 12:00 \(Brasília\)/);
  assert.match(tip, /nominal/);
  assert.match(tip, /340,0 K/);
  assert.match(tip, /VIIRS · Suomi NPP/);
  assert.match(tip, /NASA FIRMS · DataGeo PR/);
  const fires = adaptFirmsRecords(raw);
  fires[0].municipality = 'Pitanga';
  const t0 = fireTooltip(fires[0], NOW);
  assert.match(t0, /tt-title">Pitanga</);
  assert.match(t0, /tt-badge tt-alert">ÚLTIMAS 6 H</, 'sem FRP, selo = recência');
  assert.doesNotMatch(t0, /Intensidade/);
  assert.match(t0, /VIIRS · NOAA-20/);
  assert.match(t0, /Confiança<\/dt><dd class="tt-ok">alta/);
  assert.doesNotMatch(t0, /Potência radiativa/, 'FRP 0 = não gravada, some');
  assert.match(t0, /atualizado há 2 h/);
  assert.match(fireTooltip(fires[2], NOW), /município não informado/);
  assert.equal(fireTooltip(undefined), '');
  assert.ok(FIRMS_ZOOM.global < FIRMS_ZOOM.regional && FIRMS_ZOOM.regional < FIRMS_ZOOM.detections);
  assert.ok(Math.abs(FIRMS_ZOOM.detections - Math.log2(1e8 / 750000)) < 1e-9);
});

test('legenda filtra terremotos e focos por chave', () => {
  const quake = layers.find((l) => l.id === 'earthquakes');
  assert.equal(quake.legendFilter, 'band');
  assert.deepEqual(quake.rowControls().legend.map((l) => l.key), ['red', 'orange', 'yellow']);

  assert.deepEqual(filtrosFirms(new Set()), { sev: null, label: null });
  assert.deepEqual(filtrosFirms(new Set(), 'k1').label, ['!=', ['get', 'key'], 'k1']);
  const fora = ['!', ['in', ['get', 'sev'], ['literal', ['yellow']]]];
  assert.deepEqual(filtrosFirms(new Set(['yellow'])).sev, fora);
  assert.deepEqual(filtrosFirms(new Set(['yellow']), 'k1').label, ['all', ['!=', ['get', 'key'], 'k1'], fora]);

  // Clique na legenda: filtros nos layers por severidade e células sem a classe escondida.
  const firmsLayer = layers.find((l) => l.id === 'local-firms');
  assert.deepEqual(firmsLayer.rowControls().legend.map((l) => l.key), ['red', 'orange', 'yellow']);
  const data = {};
  const filtros = {};
  let ocultos = new Set();
  const ctx = {
    setData: (id, fcol) => { data[id] = fcol; },
    legendHidden: () => new Set(ocultos),
    map: { getLayer: () => true, setFilter: (id, f) => { filtros[id] = f; } },
  };
  applyFiresPayload(ctx, { fires: raw }, NOW);
  assert.equal(data['dg-firms-cells1'].features.length, 2);
  ocultos = new Set(['yellow', 'orange']);
  firmsLayer.onLegend(ocultos, ctx);
  for (const id of ['dg-firms-heat', 'dg-firms-glow', 'dg-firms-core', 'dg-firms-label']) {
    assert.deepEqual(filtros[id], ['!', ['in', ['get', 'sev'], ['literal', ['yellow', 'orange']]]], id);
  }
  assert.deepEqual(data['dg-firms-cells1'].features.map((f) => f.properties.title), ['1 FIRE'], 'só o foco alto');
  // Recarga mantém o filtro nas células.
  applyFiresPayload(ctx, { fires: raw }, NOW);
  assert.equal(data['dg-firms-cells2'].features.length, 1);
  ocultos = new Set();
  firmsLayer.onLegend(ocultos, ctx);
  assert.equal(filtros['dg-firms-heat'], null);
});

test('nada de Cesium no módulo da camada', () => {
  const src = readFileSync(new URL('./contextoGev.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'cesium'/);
});

test('analista da voz: terremotos e focos voltam no formato da camada Cesium', async () => {
  const { quakeAnalystRecords, fireAnalystRecords } = await import('./contextoGev.js');
  const quakes = quakeAnalystRecords([
    { geometry: { coordinates: [-70.5, -33.4] }, properties: { id: 'us7000abc', mag: 5.2, depth: 110, time: 1700000000000, place: 'Chile' } },
    { geometry: { coordinates: [10, 20] }, properties: {} },
  ]);
  assert.deepEqual(quakes[0], { id: 'us7000abc', magnitude: 5.2, depthKm: 110, lat: -33.4, lon: -70.5, timeMs: 1700000000000, place: 'Chile' });
  assert.equal(quakes[1].id, 'QUAKE-0001');
  assert.equal(quakeAnalystRecords(new Array(5).fill({ properties: {}, geometry: { coordinates: [0, 0] } }), 2).length, 2);
  const [fire] = fireAnalystRecords([{ index: 7, lat: -25, lon: -50, frp: 12.5, confidence: 0.8, satellite: 'N20', acqMs: 1700000000000 }]);
  assert.deepEqual(fire, { id: 'FIRE-00007', lat: -25, lon: -50, frp: 12.5, confidence: 0.8, satellite: 'N20', acqTime: 1700000000000 });
});
