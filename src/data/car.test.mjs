// Integridade do CAR: a grade de divisas que a camada carrega por zoom e a
// distribuição por classe de módulos fiscais que a ficha municipal desenha.
// As duas saem do MESMO build (scripts/build_car.py) e precisam concordar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCell, nearestCells, cellKey } from './slicedLineLayer.js';
import { datageoCarLayer } from './datageoCar.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'public', 'data', 'car');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const cell = (name) => readJson(path.join(DIR, name));
const ficha = readJson(path.join(ROOT, 'public', 'data', 'car-municipios.json'));

const CLASSES = ['0-4', '4-10', '10-20', '20-50', '>50'];

test('car-municipios: 399 municípios, classes na ordem, estado bate com a soma', () => {
  assert.deepEqual(ficha.classes, CLASSES);
  assert.equal(ficha.status, 'AT', 'só imóveis ativos');
  assert.equal(Object.keys(ficha.municipios).length, 399);
  for (let k = 0; k < CLASSES.length; k += 1) {
    const somaN = Object.values(ficha.municipios).reduce((a, m) => a + m.n[k], 0);
    assert.equal(somaN, ficha.estado.n[k], `classe ${CLASSES[k]}: contagem do estado diverge`);
  }
  const total = ficha.estado.n.reduce((a, b) => a + b, 0);
  assert.ok(total > 400_000 && total < 600_000, `total de imóveis ativos fora do esperado: ${total}`);
});

test('car-municipios: toda contagem e área são finitas e não negativas', () => {
  for (const [ibge, m] of Object.entries(ficha.municipios)) {
    assert.equal(m.n.length, CLASSES.length, `${ibge}: contagem sem as 5 classes`);
    assert.equal(m.ha.length, CLASSES.length, `${ibge}: área sem as 5 classes`);
    for (let k = 0; k < CLASSES.length; k += 1) {
      assert.ok(Number.isInteger(m.n[k]) && m.n[k] >= 0, `${ibge}/${CLASSES[k]}: contagem inválida`);
      assert.ok(Number.isFinite(m.ha[k]) && m.ha[k] >= 0, `${ibge}/${CLASSES[k]}: área inválida`);
      // Uma classe sem imóvel não pode ter área, e vice-versa: é o sintoma de
      // um imóvel classificado numa faixa e somado noutra.
      if (m.n[k] === 0) assert.equal(m.ha[k], 0, `${ibge}/${CLASSES[k]}: área sem imóvel`);
    }
  }
});

test('car-municipios: as classes são monotônicas em área média por imóvel', () => {
  // Área média por imóvel TEM que crescer com a classe de módulos fiscais:
  // o módulo fiscal varia por município, mas dentro de um mesmo município ele
  // é constante, então no total do estado a ordem se mantém. Se inverter, a
  // função de classificação pegou a faixa errada.
  const medias = ficha.estado.n.map((n, k) => (n ? ficha.estado.ha[k] / n : 0));
  for (let k = 1; k < medias.length; k += 1) {
    assert.ok(medias[k] > medias[k - 1],
      `classe ${CLASSES[k]} (${medias[k].toFixed(1)} ha/imóvel) não é maior que ` +
      `${CLASSES[k - 1]} (${medias[k - 1].toFixed(1)} ha/imóvel)`);
  }
});

test('grade: index consistente e células em disco', () => {
  const index = readJson(path.join(DIR, 'index.json'));
  assert.equal(index.cell_deg, 0.25);
  assert.deepEqual(index.classes, CLASSES);
  assert.match(index.fonte, /SICAR/);
  const keys = Object.keys(index.cells);
  assert.ok(keys.length > 200, `poucas células: ${keys.length}`);
  for (const key of keys) assert.ok(fs.existsSync(path.join(DIR, `${key}.json`)), `${key} ausente`);
  assert.equal(Object.values(index.cells).reduce((a, b) => a + b, 0), index.trechos);
});

test('grade: toda célula decodifica dentro da própria célula', () => {
  const index = readJson(path.join(DIR, 'index.json'));
  let total = 0;
  for (const key of Object.keys(index.cells)) {
    const [i, j] = key.split('_').map(Number);
    // Folga de 0,5°: o anel vai para a célula do vértice central, e um imóvel
    // grande estende as pontas para fora da célula dona.
    const south = i * index.cell_deg - 0.5;
    const north = (i + 1) * index.cell_deg + 0.5;
    const west = j * index.cell_deg - 0.5;
    const east = (j + 1) * index.cell_deg + 0.5;
    const porClasse = decodeCell(cell(`${key}.json`), key, index);
    assert.equal(porClasse.length, CLASSES.length);
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

test('grade: nearestCells respeita o index e ignora o oceano', () => {
  const index = readJson(path.join(DIR, 'index.json'));
  const oeste = cellKey(-24.0, -53.5, index.cell_deg); // interior agrícola, sempre com CAR
  assert.ok(index.cells[oeste], 'oeste do PR sem célula de CAR');
  assert.ok(nearestCells(-24.0, -53.5, index, 9).every((k) => index.cells[k]));
  assert.deepEqual(nearestCells(0, 0, index), [], 'oceano: nada a carregar');
});

test('camada registrada na classe Território e no share link', () => {
  assert.equal(datageoCarLayer.id, 'datageo-car');
  assert.equal(datageoCarLayer.category, 'Território');
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-car');
  assert.ok(entry, 'sem entrada no registro de estado');
  const tokens = LAYER_STATE_REGISTRY.map((e) => e.token);
  assert.equal(new Set(tokens).size, tokens.length, 'tokens duplicados');
});
