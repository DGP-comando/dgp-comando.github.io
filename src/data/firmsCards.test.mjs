// Texto dos cards de foco de calor (ambiente, selecionado e célula agregada),
// agora gerado pela camada MapLibre (src/maplibre/layers/contextoGev.js:
// buildFireFeatures / buildFireCells) com os formatadores de firmsFormat.js.
//
// Migrado da camada Cesium (firmsHeatmap.js, removida). Saíram os testes do
// ancoramento do card no piso de terreno (groundFloor + FIRE_ANCHOR_LIFT_M),
// da política de coorte/fade do overlay de mundo e do ciclo de vida das
// entradas no host do overlay: no MapLibre o card é um symbol layer preso ao
// ponto, sem altura, e a colisão/limite é do próprio motor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFireCells, buildFireFeatures } from '../maplibre/layers/contextoGev.js';

const NOW = Date.UTC(2026, 6, 17, 4, 0);
const H = 3600000;

/** Minimal fire record in the layer's internal shape (post-adapt). */
function fire(overrides = {}) {
  return {
    index: 7,
    lat: 61.91435,
    lon: -122.94429,
    frp: 1520.27,
    confidence: 0.9,
    brightness: 340,
    night: false,
    acqMs: NOW - 2 * H,
    sensor: 'VIIRS',
    satellite: 'N20',
    ...overrides,
  };
}

const card = (f) => buildFireFeatures([f], NOW).features[0].properties;

test('ambient card: title carries FRP, detail carries conf/age/satellite', () => {
  const p = card(fire());
  assert.equal(p.title, '▲ 1520 MW');
  assert.equal(p.detail, 'high · 2h · N20');
  assert.equal(p.sev, 'red', 'FRP 1520 is red-hot');
});

test('ambient card: missing acquisition time omits the age segment', () => {
  assert.equal(card(fire({ acqMs: 0 })).detail, 'high · N20');
});

test('ambient card: SNPP satellite code renders as SNPP, weak fire is not red', () => {
  const p = card(fire({ satellite: 'N', frp: 0.8, confidence: 0.3 }));
  assert.match(p.detail, /SNPP$/);
  assert.equal(p.title, '▲ 0.8 MW');
  assert.notEqual(p.sev, 'red');
});

test('selected card: full detail with coords', () => {
  const p = card(fire());
  assert.equal(p.selTitle, 'FIRE · 1520 MW');
  const [meta, coords] = p.selDetail.split('\n');
  assert.equal(meta, 'high conf · 2h ago · VIIRS N20');
  assert.equal(coords, '61.914°N 122.944°W');
});

test('selected card: night detections are tagged', () => {
  assert.match(card(fire({ night: true })).selDetail, / · NIGHT$/);
});

test('cell card: plural noun, max FRP and newest age', () => {
  const fires = Array.from({ length: 14 }, (_, i) => fire({
    index: i, lat: 30.1 + i * 0.01, lon: -98.1, frp: i === 3 ? 210.4 : 5, acqMs: NOW - (3 + i) * H,
  }));
  const [cell] = buildFireCells(fires, 1, NOW).features;
  assert.equal(cell.properties.title, '14 FIRES');
  assert.equal(cell.properties.detail, 'max 210 MW · new 3h');
});

test('cell card: singular noun and missing-age omission', () => {
  const [cell] = buildFireCells([fire({ frp: 9.9, acqMs: 0 })], 1, NOW).features;
  assert.equal(cell.properties.title, '1 FIRE');
  assert.equal(cell.properties.detail, 'max 9.9 MW');
});
