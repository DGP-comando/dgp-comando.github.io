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
  EARTHQUAKE_LABEL_CAP,
  earthquakeTooltip,
  FIRMS_ZOOM,
  fireTooltip,
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
  assert.match(earthquakeTooltip(c), /M5\.1 · lugar c/);
  assert.match(earthquakeTooltip(c), /100\.0 km/);
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
  const tip = fireTooltip(data['dg-firms'].features[1].properties);
  assert.match(tip, /FIRE · 200 MW/);
  assert.match(tip, /Ivaí/);
  assert.ok(FIRMS_ZOOM.global < FIRMS_ZOOM.regional && FIRMS_ZOOM.regional < FIRMS_ZOOM.detections);
  assert.ok(Math.abs(FIRMS_ZOOM.detections - Math.log2(1e8 / 750000)) < 1e-9);
});

test('nada de Cesium no módulo da camada', () => {
  const src = readFileSync(new URL('./contextoGev.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'cesium'/);
});
