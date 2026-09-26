import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DATA_CREDITS,
  NATURAL_EARTH_CREDIT,
  TOMTOM_CREDIT,
  getDataCreditsHtml,
  registerDataCredits,
  registerDynamicCredit,
} from './dataCredits.js';

test('dataCredits no longer depends on Cesium', () => {
  const source = readFileSync(new URL('./dataCredits.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'cesium'/);
});

test('the control is added once per map, next to the MapLibre attribution', () => {
  const added = [];
  const map = { addControl: (control, position) => added.push({ control, position }) };
  assert.equal(registerDataCredits({ map }), true);
  assert.equal(registerDataCredits({ map }), true, 'idempotent');
  assert.equal(added.length, 1);
  assert.equal(added[0].position, 'bottom-right');
  assert.equal(typeof added[0].control.onAdd, 'function');
  assert.equal(registerDataCredits(null), false);
  assert.equal(registerDataCredits({}), false);
});

test('dynamic credits register with the engine and land after the static ones', () => {
  const engine = { kind: 'maplibre', map: {} };
  assert.equal(registerDynamicCredit(engine, NATURAL_EARTH_CREDIT), true);
  assert.equal(registerDynamicCredit(engine, NATURAL_EARTH_CREDIT), true, 'idempotent per key');
  assert.equal(registerDynamicCredit(undefined, TOMTOM_CREDIT), true, 'the engine argument is optional');
  assert.equal(registerDynamicCredit(engine, { key: 'x' }), false, 'a credit needs html');
  const map = { getStyle: () => ({ sources: { a: { attribution: 'Esri' }, b: { attribution: 'Esri' }, c: {} } }) };
  const html = getDataCreditsHtml(map);
  assert.equal(html[0], 'Esri', 'the base map attribution leads, deduplicated');
  assert.equal(html.filter((h) => h === 'Esri').length, 1);
  assert.equal(html[1], DATA_CREDITS[0].html);
  assert.deepEqual(html.slice(-2), [NATURAL_EARTH_CREDIT.html, TOMTOM_CREDIT.html]);
  assert.equal(html.length, 1 + DATA_CREDITS.length + 2);
});
