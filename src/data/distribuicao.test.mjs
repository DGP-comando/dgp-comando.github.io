// Integridade das células da rede de distribuição (BDGD Copel) e da
// decodificação por delta encadeado usada pela camada.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cellKey,
  datageoDistribuicaoLayer,
  decodeCell,
  nearestCells,
} from './datageoDistribuicao.js';
import { DATAGEO_ENERGIA_LAYERS } from './datageoEnergia.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'public', 'data', 'distribuicao');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

test('index: células listadas existem em disco e somam os trechos', () => {
  const index = readJson('index.json');
  assert.equal(index.cell_deg, 0.25);
  assert.deepEqual(index.tensoes, [13.8, 34.5]);
  assert.match(index.fonte, /BDGD COPEL/);
  const keys = Object.keys(index.cells);
  assert.ok(keys.length > 300);
  for (const key of keys) assert.ok(fs.existsSync(path.join(DIR, `${key}.json`)), `${key} ausente`);
  const soma = Object.values(index.cells).reduce((a, b) => a + b, 0);
  assert.equal(soma, index.trechos);
  assert.ok(index.trechos > 700_000);
});

test('decodeCell: toda célula decodifica dentro da própria célula (folga de 0,3°)', () => {
  const index = readJson('index.json');
  let total = 0;
  for (const key of Object.keys(index.cells)) {
    const [i, j] = key.split('_').map(Number);
    const south = i * index.cell_deg - 0.3;
    const north = (i + 1) * index.cell_deg + 0.3;
    const west = j * index.cell_deg - 0.3;
    const east = (j + 1) * index.cell_deg + 0.3;
    const porTensao = decodeCell(readJson(`${key}.json`), key, index);
    assert.equal(porTensao.length, index.tensoes.length);
    let n = 0;
    for (const lines of porTensao) {
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

test('decodeCell: delta encadeado entre trechos a partir da origem SW', () => {
  const index = { cell_deg: 0.25, escala: 100_000 };
  const payload = { t: [[[10, 20, 5, 0], [1, 1, 0, 3]], [[0, 0, 7, 7]], ] };
  const [kv0, kv1] = decodeCell(payload, '-100_-200', index);
  // origem: lon -50, lat -25
  assert.deepEqual(kv0[0], [-49.9999, -24.9998, -49.99985, -24.9998]);
  assert.deepEqual(kv0[1], [-49.99984, -24.99979, -49.99984, -24.99976]);
  assert.deepEqual(kv1[0], [-50, -25, -49.99993, -24.99993]);
});

test('decodeCell ignora trechos malformados', () => {
  const index = { cell_deg: 0.25, escala: 100_000 };
  const [lines] = decodeCell({ t: [[[1, 2], [1, 2, 3], null, [0, 0, 1, 1]]] }, '0_0', index);
  assert.equal(lines.length, 1);
});

test('cellKey e nearestCells priorizam a célula do centro e respeitam o index', () => {
  const index = readJson('index.json');
  const curitiba = cellKey(-25.43, -49.27, 0.25);
  assert.equal(curitiba, '-102_-198');
  const keys = nearestCells(-25.43, -49.27, index, 9);
  assert.equal(keys[0], curitiba);
  assert.equal(keys.length, 9);
  assert.ok(keys.every((k) => index.cells[k]));
  assert.deepEqual(nearestCells(0, 0, index), [], 'oceano: nada a carregar');
});

test('camada registrada na classe Infraestrutura e no share link', () => {
  assert.equal(datageoDistribuicaoLayer.category, 'Infraestrutura');
  assert.ok(DATAGEO_ENERGIA_LAYERS.includes(datageoDistribuicaoLayer));
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-distribuicao');
  assert.ok(entry);
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'tokens duplicados');
});
