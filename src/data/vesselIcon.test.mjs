import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOA_M, SHIP_ICON_URI, VESSEL_METERS_MAX_DISTANCE, farIconPixels, headingToRotation, shipDimensions,
} from './vesselIcon.js';

test('SVG é data URI válido com tamanho intrínseco (Cesium precisa)', () => {
  assert.match(SHIP_ICON_URI, /^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(SHIP_ICON_URI.split(',')[1]);
  assert.match(svg, /width="40" height="160"/);
  assert.match(svg, /<path d="M20 3/);
});

test('dimensões reais: LOA do line-up e boca proporcional; LOA inválido cai no padrão', () => {
  assert.deepEqual(shipDimensions(299.9), { lengthM: 299.9, beamM: 299.9 / 6.5 });
  assert.equal(shipDimensions(null).lengthM, DEFAULT_LOA_M);
  assert.equal(shipDimensions('abc').lengthM, DEFAULT_LOA_M);
  assert.equal(shipDimensions(5000).lengthM, DEFAULT_LOA_M, 'nenhum navio passa de ~460 m');
  assert.equal(shipDimensions(30).beamM, 10, 'boca mínima legível');
});

test('ícone longe acompanha o tamanho em metros na distância de troca', () => {
  assert.equal(VESSEL_METERS_MAX_DISTANCE, 12_000);
  // 300 m a 12 km ≈ 19 px; 150 m ≈ 10 px -> piso 12
  assert.equal(farIconPixels(300).height, 20);
  assert.equal(farIconPixels(150).height, 12);
  assert.equal(farIconPixels(400).height, 22, 'teto');
  const { width, height } = farIconPixels(300);
  assert.ok(height / width >= 3.5, 'mantém proporção de navio');
});

test('rumo vira rotação anti-horária em radianos', () => {
  assert.equal(headingToRotation(0), -0);
  assert.equal(headingToRotation(90), -Math.PI / 2);
  assert.equal(headingToRotation(450), -Math.PI / 2);
  assert.equal(headingToRotation(-90), -(270 * Math.PI) / 180);
  assert.equal(headingToRotation(null), -(45 * Math.PI) / 180, 'fundeio sem rumo usa o padrão');
});
