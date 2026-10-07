import assert from 'node:assert/strict';
import test from 'node:test';
import { pixelDe } from './aspectosFisicos.js';

const BBOX = [-50.4, -25.4, -49.6, -24.8];
const TAM = [800, 700];

test('cantos da imagem caem nos pixels das pontas', () => {
  assert.deepEqual(pixelDe([-50.4, -24.8], BBOX, TAM), [0, 0]);
  assert.deepEqual(pixelDe([-49.6001, -25.3999], BBOX, TAM), [799, 699]);
});

test('vertical em Web Mercator, não linear na latitude', () => {
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const latMeio = (2 * Math.atan(Math.exp((merc(-24.8) + merc(-25.4)) / 2)) - Math.PI / 2) * (180 / Math.PI);
  assert.deepEqual(pixelDe([-50.0, latMeio - 1e-9], BBOX, TAM), [400, 350]);
  assert.notEqual(pixelDe([-50.0, -25.1], BBOX, TAM)[1], 350);
});

test('fora da imagem devolve null', () => {
  assert.equal(pixelDe([-50.5, -25.0], BBOX, TAM), null);
  assert.equal(pixelDe([-50.0, -24.7], BBOX, TAM), null);
  assert.equal(pixelDe([-49.6, -25.0], BBOX, TAM), null);
});
