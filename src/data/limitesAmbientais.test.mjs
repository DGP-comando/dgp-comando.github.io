// Integridade dos GeoJSONs de assentamentos (INCRA) e UCs (MMA/CNUC) e das
// camadas que os desenham.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATAGEO_TERRITORIOS_LAYERS,
  datageoAssentamentosLayer,
  datageoUcsEstaduaisLayer,
  datageoUcsFederaisLayer,
  tituloUc,
} from './datageoTerritorios.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', name), 'utf8'));

function* coords(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) for (const ring of rings) for (const pt of ring) yield pt;
}

// Bbox folgado: UCs interestaduais (ex.: PR/SC/SP) passam da divisa.
const inRegion = ([lon, lat]) => lon > -58 && lon < -44 && lat > -30 && lat < -20;

test('assentamentos INCRA: 311 projetos com nome, município e geometria no PR', () => {
  const gj = read('assentamentos-incra-pr.geojson');
  assert.equal(gj.features.length, 311);
  assert.match(gj.fonte, /INCRA/);
  for (const f of gj.features) {
    assert.ok(f.properties.nome, 'sem nome');
    assert.ok(f.properties.municipio, 'sem município');
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
    for (const pt of coords(f.geometry)) {
      assert.ok(pt[0] > -54.7 && pt[0] < -48 && pt[1] > -26.8 && pt[1] < -22.4, `fora do PR: ${pt}`);
      assert.ok(String(pt[0]).split('.')[1]?.length <= 5, 'coordenada com mais de 5 casas');
    }
  }
  assert.ok(gj.features.some((f) => f.properties.nome === 'PA MANDAÇAIA'), 'acentos preservados');
  assert.ok(gj.features.every((f) => typeof f.properties.fase === 'string' && f.properties.fase));
});

test('UCs CNUC: federais e estaduais separadas, só esfera certa e com UF Paraná', () => {
  const fed = read('ucs-federais-pr.geojson');
  const est = read('ucs-estaduais-pr.geojson');
  assert.equal(fed.features.length, 39);
  assert.equal(est.features.length, 42);
  for (const [gj, esfera] of [[fed, 'Federal'], [est, 'Estadual']]) {
    for (const f of gj.features) {
      assert.equal(f.properties.esfera, esfera);
      assert.match(f.properties.uf, /PARANÁ/);
      assert.ok(f.properties.nome && f.properties.categoria);
      for (const pt of coords(f.geometry)) assert.ok(inRegion(pt), `fora da região: ${pt}`);
    }
  }
  assert.ok(fed.features.some((f) => f.properties.nome === 'RESERVA BIOLÓGICA DAS PEROBAS'));
  assert.ok(est.features.some((f) => f.properties.nome === 'PARQUE ESTADUAL DA ILHA DO MEL'));
});

test('tituloUc deixa o nome do CNUC legível no rótulo', () => {
  assert.equal(tituloUc('RESERVA BIOLÓGICA DAS PEROBAS'), 'Reserva Biológica das Perobas');
  assert.equal(tituloUc('ÁREA DE PROTEÇÃO AMBIENTAL ESTADUAL DA SERRA DA ESPERANÇA'),
    'Área de Proteção Ambiental Estadual da Serra da Esperança');
  assert.equal(tituloUc(''), '');
});

test('camadas nas categorias pedidas e registradas no share link', () => {
  assert.equal(datageoAssentamentosLayer.category, 'Limites');
  assert.equal(datageoUcsFederaisLayer.category, 'Ambiente');
  assert.equal(datageoUcsEstaduaisLayer.category, 'Ambiente');
  const ids = new Set(DATAGEO_TERRITORIOS_LAYERS.map((l) => l.id));
  for (const id of ['datageo-assentamentos', 'datageo-ucs-federais', 'datageo-ucs-estaduais']) {
    assert.ok(ids.has(id), `${id} fora da lista`);
    const entry = LAYER_STATE_REGISTRY.find((e) => e.id === id);
    assert.ok(entry, `${id} sem token`);
  }
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'tokens duplicados');
});
