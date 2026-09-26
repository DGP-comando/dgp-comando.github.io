// src/data/nearbyModelHandoff.test.mjs
//
// `getNearby()` é a costura de proximidade por trás das contagens de
// Contexto/Contatos e das ferramentas de voz; `getDetectableObjects()` alimenta
// os colchetes da detecção. No Cesium estes testes pinavam a troca
// billboard ↔ modelo 3D (um contato cujo modelo era o visual continuava
// "perto"). MIGRAÇÃO MAPLIBRE (2026-09): flights.js não tem modelo 3D — o
// ícone é sempre o visual —, então o que resta pinar é a regra de visibilidade
// (contato desenhado entra, contato escondido só com includeHidden, alvo
// rastreado sempre) e a posição NEUTRA devolvida ({lon, lat, height, x, y, z}),
// com a distância em linha reta igual à do antigo Cartesian3.distance.
// A cobertura equivalente da camada militar vive no teste da própria camada.
import test from 'node:test';
import assert from 'node:assert/strict';
import flightsLayer, { _setTrackedFlightRefreshStateForTest } from './flights.js';
import { geoPoint } from './geoPoint.js';

const ICAO = 'abc123';
const CONTACT = { lon: -97.71, lat: 30.21, alt: 10_668 };
/** ~10 km do contato — bem dentro do alcance. */
const CENTER = geoPoint(-97.7, 30.2, 200);
const RANGE_M = 250_000;

function seed({ show = true, tracked = false } = {}) {
  _setTrackedFlightRefreshStateForTest({
    icao24: ICAO,
    tracked,
    show,
    enabled: true,
    position: CONTACT,
    meta: { callsign: `${ICAO.toUpperCase()} `, altitude: 10_668, klass: 'airliner', onGround: false, rawLat: CONTACT.lat, rawLon: CONTACT.lon },
  });
}

const nearbyIcaos = (opts) => flightsLayer.getNearby(CENTER, RANGE_M, 50, opts).map((c) => c.icao24);

test('getNearby admits a drawn contact and drops one nothing is drawing', () => {
  seed({ show: true });
  assert.ok(nearbyIcaos().includes(ICAO), 'a shown icon is nearby');
  seed({ show: false });
  assert.ok(!nearbyIcaos().includes(ICAO), 'a hidden icon stays excluded');
  assert.ok(nearbyIcaos({ includeHidden: true }).includes(ICAO), 'includeHidden admits the loaded contact');
  seed({ show: false, tracked: true });
  assert.ok(nearbyIcaos().includes(ICAO), 'the tracked contact is always nearby');
});

test('getNearby returns the neutral point and straight-line distance for any center format', () => {
  seed({ show: true });
  const [hit] = flightsLayer.getNearby(CENTER, RANGE_M, 50);
  assert.equal(hit.icao24, ICAO);
  assert.equal(hit.id, 'ABC123');
  const p = hit.position;
  assert.ok(Math.abs(p.lon - CONTACT.lon) < 1e-9 && Math.abs(p.lat - CONTACT.lat) < 1e-9);
  assert.ok(Math.abs(p.height - CONTACT.alt) < 1e-6);
  const expected = Math.hypot(p.x - CENTER.x, p.y - CENTER.y, p.z - CENTER.z);
  assert.ok(Math.abs(hit.distance - expected) < 1e-6);
  // Centro legado em ECEF {x,y,z} (um Cesium.Cartesian3 antigo) dá a mesma resposta.
  const [legacy] = flightsLayer.getNearby({ x: CENTER.x, y: CENTER.y, z: CENTER.z }, RANGE_M, 50);
  assert.ok(Math.abs(legacy.distance - hit.distance) < 1e-3);
  // Fora do alcance.
  assert.equal(flightsLayer.getNearby(CENTER, 1000, 50).length, 0);
});

test('detection candidates stay welded to the drawn icon position', () => {
  seed({ show: true });
  const obj = flightsLayer.getDetectableObjects({ maxCount: 50 }).find((c) => c.sourceId === ICAO);
  assert.ok(obj, 'the icon publishes a detection candidate');
  assert.ok(Math.abs(obj.position.lon - CONTACT.lon) < 1e-9 && Math.abs(obj.position.lat - CONTACT.lat) < 1e-9);
  assert.equal(obj.skipLabel, false);
  assert.equal(obj.type, 'AIR');
  seed({ show: false });
  assert.equal(flightsLayer.getDetectableObjects({ maxCount: 50 }).length, 0, 'hidden icons publish nothing');
});
