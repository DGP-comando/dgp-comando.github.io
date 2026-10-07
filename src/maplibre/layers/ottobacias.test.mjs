import assert from 'node:assert/strict';
import test from 'node:test';
import { ringsParaGeojson } from './geoprVista.js';
import {
  MANANCIAL, areaFeature, areaTooltip, contaManancial, nivelOtto, ottobaciaIdrTooltip, ottobaciasIdrLayer,
} from './ottobacias.js';

// Anel horário (externo no ArcGIS) e anti-horário (buraco).
const EXT = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
const BURACO = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
const EXT2 = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]];

test('anéis do ArcGIS: externo abre polígono, buraco vai no anterior, dois externos viram MultiPolygon', () => {
  assert.deepEqual(ringsParaGeojson([EXT, BURACO]), { type: 'Polygon', coordinates: [EXT, BURACO] });
  assert.deepEqual(ringsParaGeojson([EXT, BURACO, EXT2]).type, 'MultiPolygon');
  assert.equal(ringsParaGeojson([EXT, BURACO, EXT2]).coordinates[1][0], EXT2);
  assert.equal(ringsParaGeojson([]), null);
  assert.equal(ringsParaGeojson([[[0, 0], [1, 1]]]), null);
});

test('área de contribuição do GeoPR vira feição com id e tooltip legível', () => {
  const f = areaFeature({
    attributes: { objectid: 7, cobacia: '864266428', nuareacont: 0.789, nunivotto: 9, cocursodag: '864266428', cotrecho: 604700 },
    geometry: { rings: [EXT] },
  });
  assert.equal(f.id, 7);
  assert.equal(f.properties.areaKm2, 0.789);
  const html = areaTooltip(f.properties);
  assert.match(html, /Ottobacia 864266428/);
  assert.match(html, /78,9 ha/);
  assert.match(html, /Nível Otto/);
  assert.equal(areaFeature({ attributes: {}, geometry: null }), null);
});

test('microbacias do IDR: nível Otto, contagem por manancial e tooltip', () => {
  assert.equal(nivelOtto('842111219'), 9);
  assert.equal(nivelOtto(''), null);
  const n = contaManancial([{ properties: { man: 'sanepar' } }, { properties: { man: 'idr' } }, { properties: { man: 'demais' } }, { properties: {} }]);
  assert.deepEqual(n, { sanepar: 1, idr: 1, demais: 2 });
  const html = ottobaciaIdrTooltip({ cod: '842111219', bacia: 'Iguaçu', ha: 3191, man: 'sanepar', manancial: 'Tamanduá' });
  assert.match(html, /Ottobacia 842111219/);
  assert.match(html, /bacia do Iguaçu/);
  assert.match(html, /Tamanduá \(Sanepar\)/);
});

test('legenda das microbacias é filtrável por manancial', () => {
  assert.equal(ottobaciasIdrLayer.legendFilter, 'man');
  const legenda = ottobaciasIdrLayer.rowControls().legend;
  assert.deepEqual(legenda.map((l) => l.key), MANANCIAL.map((m) => m.key));
});
