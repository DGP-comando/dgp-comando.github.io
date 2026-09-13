import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AREA_EXPORT_COLUMNS,
  UTF8_BOM,
  buildAreaExportRows,
  downloadText,
  exportFilename,
  toCsv,
  toGeoJson,
} from './areaExport.js';

test('toCsv prefixes the UTF-8 BOM, uses ; and CRLF by default', () => {
  const csv = toCsv([{ nome: 'Guaíra', n: 3 }], ['nome', 'n']);
  assert.ok(csv.startsWith(UTF8_BOM));
  assert.equal(csv, `${UTF8_BOM}nome;n\r\nGuaíra;3\r\n`);
  const bytes = Buffer.from(csv, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM encodes as EF BB BF');
  assert.ok(bytes.toString('utf8').includes('Guaíra'), 'accents survive UTF-8 round-trip');
});

test('toCsv quotes per RFC 4180 (separator, quotes, newlines)', () => {
  const rows = [{ a: 'x;y', b: 'diz "oi"', c: 'linha1\nlinha2', d: 'ok' }];
  const csv = toCsv(rows, ['a', 'b', 'c', 'd'], { bom: false });
  assert.equal(csv, 'a;b;c;d\r\n"x;y";"diz ""oi""";"linha1\nlinha2";ok\r\n');
  const comma = toCsv([{ a: 'x,y', b: 'x;y' }], ['a', 'b'], { separator: ',', bom: false });
  assert.equal(comma, 'a,b\r\n"x,y",x;y\r\n');
});

test('toCsv writes decimal comma for ; and dot for , ; nulls are empty', () => {
  const rows = [{ lat: -25.4284, lon: -49.2733, v: null, w: undefined, x: NaN }];
  assert.equal(toCsv(rows, ['lat', 'lon', 'v', 'w', 'x'], { bom: false }), 'lat;lon;v;w;x\r\n-25,4284;-49,2733;;;\r\n');
  assert.equal(toCsv(rows, ['lat'], { separator: ',', bom: false }), 'lat\r\n-25.4284\r\n');
});

test('toCsv supports {key,label,value} columns and infers columns when omitted', () => {
  const csv = toCsv([{ a: 1, b: 2 }], [{ key: 'a', label: 'Município' }, { label: 'dobro', value: (r) => r.b * 2 }], { bom: false });
  assert.equal(csv, 'Município;dobro\r\n1;4\r\n');
  assert.equal(toCsv([{ a: 1 }, { b: 2 }], undefined, { bom: false }), 'a;b\r\n1;\r\n;2\r\n');
  assert.equal(toCsv(null, ['a'], { bom: false }), 'a\r\n');
});

test('toCsv neutralizes spreadsheet formula injection in strings but not negative numbers', () => {
  const csv = toCsv([{ t: '=HYPERLINK("x")', n: -12, m: '@cmd' }], ['t', 'n', 'm'], { bom: false });
  assert.equal(csv, 't;n;m\r\n"\'=HYPERLINK(""x"")";-12;\'@cmd\r\n');
});

test('toCsv neutralizes DDE payloads that start with minus and a digit, even after spaces', () => {
  const csv = toCsv([{ a: "-1+cmd|' /C calc'!A0", b: '  =1+1', c: '-12' }], ['a', 'b', 'c'], { bom: false });
  assert.equal(csv, "a;b;c\r\n'-1+cmd|' /C calc'!A0;'  =1+1;'-12\r\n");
});

test('toGeoJson builds [lon, lat] points and skips invalid coordinates', () => {
  const gj = toGeoJson([
    { lat: -25.39, lon: -51.46, municipio: 'Guarapuava' },
    { lat: null, lon: -51 },
    { lat: 'abc', lon: 1 },
    { lat: 95, lon: 1 },
  ]);
  assert.equal(gj.type, 'FeatureCollection');
  assert.equal(gj.features.length, 1);
  assert.deepEqual(gj.features[0].geometry, { type: 'Point', coordinates: [-51.46, -25.39] });
  assert.deepEqual(gj.features[0].properties, { municipio: 'Guarapuava' });
  const custom = toGeoJson([{ latitude: 1, longitude: 2 }], { latKey: 'latitude', lonKey: 'longitude', name: 'x' });
  assert.equal(custom.name, 'x');
  assert.deepEqual(custom.features[0].geometry.coordinates, [2, 1]);
});

test('buildAreaExportRows filters each source to the municipality', () => {
  const rows = buildAreaExportRows({
    ibge: '4109401',
    nome: 'Guarapuava',
    fires: [
      { lat: -25.39, lon: -51.46, municipality: 'Guarapuava', acqDate: '2026-09-13', acqTime: '432', satellite: 'N20', instrument: 'VIIRS', confidence: 'h' },
      { lat: -25.4, lon: -49.2, municipality: 'Curitiba' },
    ],
    cemaden: [{ ibge_code: '4109401', alert_type: 'hidrológico', severity: 'moderado', issued_at: '2026-09-13T10:00:00Z' }],
    incidents: [{ id: 1, title: 'Queimada', status: 'open', affected_municipalities: [{ ibge_code: '4109401' }] }],
  });
  assert.deepEqual(rows.map((r) => r.fonte), ['FIRMS', 'CEMADEN', 'INCIDENTE']);
  assert.equal(rows[0].data_hora, '2026-09-13T04:32:00Z');
  assert.equal(rows[1].tipo, 'hidrológico');
  assert.equal(rows[2].descricao, 'Queimada');
  const csv = toCsv(rows, AREA_EXPORT_COLUMNS);
  assert.equal(csv.split('\r\n').length, 5);
  assert.deepEqual(buildAreaExportRows({ ibge: '4109401', nome: 'Guarapuava', fires: { error: 'x' } }), []);
});

test('exportFilename is ASCII-safe', () => {
  const name = exportFilename({ nome: 'São José dos Pinhais', ibge: '4125506', ext: 'csv', now: new Date(2026, 8, 13, 14, 5) });
  assert.equal(name, 'vigilancia-sao-jose-dos-pinhais-4125506-20260913-1405.csv');
});

test('downloadText returns false without a DOM', () => {
  assert.equal(downloadText('a.txt', 'x', 'text/plain', null), false);
});
