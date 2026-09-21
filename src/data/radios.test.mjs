import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { centroidByIbge } from './prCentroids.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { datageoRadiosLayer, dotSize, flattenStations } from './datageoRadios.js';

const data = JSON.parse(readFileSync(new URL('../../public/data/radios-pr.json', import.meta.url), 'utf8'));

test('todo lugar é um município do PR com ao menos uma estação', () => {
  assert.ok(data.places.length > 0);
  for (const place of data.places) {
    assert.ok(centroidByIbge(place.ibge), `${place.ibge} não é município do PR`);
    assert.ok(place.stations.length > 0, `${place.nome} sem estações`);
  }
});

test('toda estação toca em página HTTPS e tem id único', () => {
  const stations = flattenStations(data.places).map((e) => e.station);
  for (const s of stations) assert.match(s.url, /^https:\/\//, `${s.name} não é HTTPS`);
  assert.equal(new Set(stations.map((s) => s.id)).size, stations.length);
  assert.equal(new Set(stations.map((s) => s.url)).size, stations.length, 'stream duplicado');
});

test('o ponto cresce com a contagem, mas devagar', () => {
  assert.ok(dotSize(4) > dotSize(1));
  assert.ok(dotSize(4) - dotSize(1) < 4 * (dotSize(2) - dotSize(1)));
});

test('a camada está registrada no link compartilhável', () => {
  assert.equal(datageoRadiosLayer.id, 'datageo-radios');
  const entry = LAYER_STATE_REGISTRY.find((e) => e.id === 'datageo-radios');
  assert.ok(entry, 'datageo-radios fora do LAYER_STATE_REGISTRY');
  assert.equal(entry.disposition, 'enabled-only');
});
