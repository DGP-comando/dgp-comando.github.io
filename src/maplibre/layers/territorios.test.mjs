// Territórios e CAR no protótipo MapLibre: feições, rótulos, tooltips e a
// escolha de células do CAR. Roda com `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTerritorioFeatures, cellFeatures, cellsInBbox, flatToCoords, wantedCells,
} from './territoriosFeatures.js';
import {
  centroidOf, fichaRegionalIdr, TERRITORIO_SPECS, tituloUc, tooltipHtml,
} from '../../data/territoriosSpec.js';
import { CAR_CLASSE_STYLES } from '../../data/carClasses.js';
import layers, { carLayer } from './territorios.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const square = (x, y, s = 1) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

test('camadas na ordem e com os ids/categorias do app', () => {
  assert.deepEqual(layers.map((l) => l.id), [
    'datageo-terras-indigenas', 'datageo-quilombolas', 'datageo-assentamentos', 'datageo-ucs-federais',
    'datageo-ucs-estaduais', 'datageo-regionais-idr', 'datageo-associacoes', 'datageo-car',
  ]);
  const cat = Object.fromEntries(layers.map((l) => [l.id, l.category]));
  assert.equal(cat['datageo-terras-indigenas'], 'Limites');
  assert.equal(cat['datageo-ucs-federais'], 'Ambiente');
  assert.equal(cat['datageo-car'], 'Território');
  // UCs não têm tooltip nem clique no app: não capturam o hover do município.
  for (const l of layers) {
    const hasTip = ['datageo-ucs-federais', 'datageo-ucs-estaduais', 'datageo-car'].includes(l.id);
    assert.equal(l.interactive.length > 0, !hasTip, l.id);
  }
  assert.ok(layers.find((l) => l.id === 'datageo-regionais-idr').click);
  assert.ok(carLayer.focusOn && carLayer.onEnable && carLayer.onDisable);
});

test('buildTerritorioFeatures: partes válidas, borda fechada pelo anel externo, rótulo no centroide', () => {
  const gj = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { nome: 'A' }, geometry: { type: 'Polygon', coordinates: [square(0, 0, 2), square(0.5, 0.5, 0.5)] } },
      { type: 'Feature', properties: { nome: 'B' }, geometry: null },
      {
        type: 'Feature',
        properties: { nome: 'C' },
        geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 1], [0, 0]]], [square(10, 10).slice(0, 4)]] },
      },
    ],
  };
  const out = buildTerritorioFeatures(gj, (p) => `R ${p.nome}`);
  assert.equal(out.count, 2, 'feição sem geometria não conta');
  assert.deepEqual(out.props.map((p) => p.nome), ['A', 'C']);
  assert.equal(out.fills.features.length, 2);
  assert.deepEqual(out.fills.features.map((f) => f.id), [0, 1]);
  // Parte degenerada (3 vértices) descartada.
  assert.equal(out.fills.features[1].geometry.coordinates.length, 1);
  // Borda só do anel externo, fechada mesmo quando o anel não vem fechado.
  const borderA = out.borders.features[0].geometry.coordinates;
  assert.equal(borderA.length, 1);
  const ringC = out.borders.features[1].geometry.coordinates[0];
  assert.deepEqual(ringC[0], ringC[ringC.length - 1]);
  assert.deepEqual(out.labels.features[0].geometry.coordinates, centroidOf([square(0, 0, 2)]));
  assert.equal(out.labels.features[1].properties.label, 'R C');
});

test('rótulos e tooltips iguais aos do app', () => {
  const S = TERRITORIO_SPECS;
  assert.equal(S.terrasIndigenas.labelOf({ nome: 'TI Marrecas', area_ha: 16838.4 }), 'TI Marrecas · 16.838 ha');
  assert.equal(S.terrasIndigenas.labelOf({ nome: 'Apucaraninha' }), 'TI Apucaraninha');
  assert.equal(S.quilombolas.labelOf({ nome: 'Paiol de Telha', fase: 'RTID' }), 'TQ Paiol de Telha (RTID)');
  assert.equal(S.ucsFederais.labelOf({ nome: 'RESERVA BIOLÓGICA DAS PEROBAS' }), 'Reserva Biológica das Perobas');
  assert.equal(S.regionaisIdr.labelOf({ regional: 'Ponta Grossa' }), 'IDR Ponta Grossa');
  assert.equal(S.assentamentos.labelOf({ nome: 'PA X', familias: 12 }), 'PA X · 12 famílias');

  const tip = S.assentamentos.tooltipOf({
    nome: 'PA <X>', municipio: 'Rio Bonito', area_ha: 1234.5, familias: 10, capacidade: 12, fase: '', codigo: 'PR0001',
  });
  assert.match(tip, /<div class="vt-nome">PA &lt;X&gt;<\/div>/);
  assert.match(tip, /Área:<\/span> 1\.235 ha/);
  assert.match(tip, /Famílias:<\/span> 10 de 12 de capacidade/);
  assert.doesNotMatch(tip, /Fase/, 'linha vazia some');
  assert.match(tip, /<div class="vt-fontes">INCRA\/SIPRA<\/div>$/);

  const reg = S.regionaisIdr.tooltipOf({ regional: 'Irati', municipios: ['4110706', '4128500'] });
  assert.match(reg, /Regional Irati/);
  assert.match(reg, /Municípios:<\/span> 2/);
  assert.deepEqual(fichaRegionalIdr({ regional: 'Irati', municipios: ['1'] }), {
    nome: 'Regional Irati', meta: 'IDR-Paraná · 1 município', ibges: ['1'],
  });
  assert.equal(tooltipHtml('T', [['a', ' ']], 'F'), '<div class="vt-nome">T</div><div class="vt-fontes">F</div>');
  assert.equal(tituloUc('PARQUE ESTADUAL DE VILA VELHA'), 'Parque Estadual de Vila Velha');
});

test('GeoJSONs reais: toda feição rende rótulo e tooltip sem erro', () => {
  for (const spec of Object.values(TERRITORIO_SPECS)) {
    const gj = readJson(path.join('public', spec.url));
    const out = buildTerritorioFeatures(gj, spec.labelOf);
    assert.ok(out.count > 0, spec.id);
    assert.equal(out.labels.features.length, out.fills.features.length, `${spec.id}: rótulo por polígono`);
    for (const f of out.labels.features) assert.ok(f.properties.label.length > 0, `${spec.id}: rótulo vazio`);
    if (spec.tooltipOf) for (const p of out.props) assert.ok(spec.tooltipOf(p).includes('vt-nome'));
  }
});

test('CAR: célula real vira MultiLineString por classe, com todos os trechos', () => {
  const index = readJson('public/data/car/index.json');
  const key = Object.keys(index.cells)[0];
  const payload = readJson(`public/data/car/${key}.json`);
  const { features, lines } = cellFeatures(payload, key, index);
  assert.equal(lines, index.cells[key]);
  assert.equal(features.reduce((a, f) => a + f.geometry.coordinates.length, 0), lines);
  for (const f of features) {
    assert.ok(CAR_CLASSE_STYLES[f.properties.classe], `classe sem estilo: ${f.properties.classe}`);
    assert.equal(f.geometry.type, 'MultiLineString');
  }
  // Coordenadas dentro (ou na borda generalizada) da célula.
  const [i, j] = key.split('_').map(Number);
  const [lon, lat] = features[0].geometry.coordinates[0][0];
  assert.ok(Math.abs(lat - (i + 0.5) * index.cell_deg) < index.cell_deg);
  assert.ok(Math.abs(lon - (j + 0.5) * index.cell_deg) < index.cell_deg);
  assert.deepEqual(flatToCoords([1, 2, 3, 4]), [[1, 2], [3, 4]]);
});

test('CAR: células da vista e do município em foco', () => {
  const index = { cell_deg: 0.25, cells: {} };
  for (let i = -104; i <= -96; i++) for (let j = -212; j <= -200; j++) index.cells[`${i}_${j}`] = 1;
  // Sem foco: as 9 mais próximas do centro (nearestCells do app).
  const view = wantedCells({ lat: -25.1, lon: -51.1 }, index);
  assert.equal(view.length, 9);
  assert.equal(view[0], '-101_-205');
  // Com foco: todas as do bbox, até o teto, da mais próxima do centro.
  const bbox = [-51.6, -25.6, -50.4, -24.6];
  const all = cellsInBbox(bbox, index, 100);
  assert.equal(all.length, 5 * 6);
  assert.equal(wantedCells({ lat: -25.1, lon: -51.1 }, index, { focus: bbox, focusCap: 24 }).length, 24);
  assert.equal(wantedCells({ lat: -25.1, lon: -51.1 }, index, { focus: bbox })[0], '-101_-205');
  // Só células existentes.
  assert.deepEqual(cellsInBbox([0, 0, 1, 1], index), []);
});
