// Integridade das células das estradas municipais (OSM) e dos tetos de altura
// que decidem quando cada classe aparece.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCell, nearestCells, cellKey } from './slicedLineLayer.js';
import { datageoEstradasLayer } from './datageoEstradas.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'public', 'data', 'estradas');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

test('index: células listadas existem em disco e somam os trechos', () => {
  const index = readJson('index.json');
  assert.equal(index.cell_deg, 0.25);
  assert.deepEqual(index.classes, ['urbanas', 'rurais']);
  assert.match(index.fonte, /OpenStreetMap/);
  const keys = Object.keys(index.cells);
  assert.ok(keys.length > 300, `poucas células: ${keys.length}`);
  for (const key of keys) assert.ok(fs.existsSync(path.join(DIR, `${key}.json`)), `${key} ausente`);
  const soma = Object.values(index.cells).reduce((a, b) => a + b, 0);
  assert.equal(soma, index.trechos);
  assert.ok(index.trechos > 300_000, `poucos trechos: ${index.trechos}`);
});

test('decodeCell: toda célula decodifica dentro do bbox do PR e da própria célula', () => {
  const index = readJson('index.json');
  let total = 0;
  for (const key of Object.keys(index.cells)) {
    const [i, j] = key.split('_').map(Number);
    // Folga de 0,3°: o trecho vai para a célula do vértice CENTRAL, então as
    // pontas de uma via longa saem um pouco da célula dona.
    const south = i * index.cell_deg - 0.3;
    const north = (i + 1) * index.cell_deg + 0.3;
    const west = j * index.cell_deg - 0.3;
    const east = (j + 1) * index.cell_deg + 0.3;
    const porClasse = decodeCell(readJson(`${key}.json`), key, index);
    assert.equal(porClasse.length, index.classes.length);
    let n = 0;
    for (const lines of porClasse) {
      for (const flat of lines) {
        n += 1;
        assert.ok(flat.length >= 4);
        for (let k = 0; k < flat.length; k += 2) {
          const lon = flat[k];
          const lat = flat[k + 1];
          assert.ok(lon > west && lon < east && lat > south && lat < north,
            `${key}: vértice fora da célula ${lon},${lat}`);
        }
      }
    }
    assert.equal(n, index.cells[key], `${key}: contagem diverge do index`);
    total += n;
  }
  assert.equal(total, index.trechos);
});

test('as duas classes têm trechos e Curitiba é a célula mais densa', () => {
  const index = readJson('index.json');
  const curitiba = cellKey(-25.43, -49.27, index.cell_deg);
  assert.ok(index.cells[curitiba], 'Curitiba sem célula');
  const [urbanas, rurais] = decodeCell(readJson(`${curitiba}.json`), curitiba, index);
  assert.ok(urbanas.length > 1000, `poucas ruas urbanas em Curitiba: ${urbanas.length}`);
  assert.ok(rurais.length > 0);
});

test('nearestCells respeita o index e ignora o oceano', () => {
  const index = readJson('index.json');
  const curitiba = cellKey(-25.43, -49.27, index.cell_deg);
  const keys = nearestCells(-25.43, -49.27, index, 9);
  assert.equal(keys[0], curitiba);
  assert.ok(keys.every((k) => index.cells[k]));
  assert.deepEqual(nearestCells(0, 0, index), [], 'oceano: nada a carregar');
});

test('camada registrada na classe Infraestrutura e no share link', () => {
  assert.equal(datageoEstradasLayer.id, 'datageo-estradas');
  assert.equal(datageoEstradasLayer.category, 'Infraestrutura');
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-estradas');
  assert.ok(entry, 'sem entrada no registro de estado');
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'tokens duplicados');
});
