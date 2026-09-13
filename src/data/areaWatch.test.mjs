import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_WATCHES,
  WATCH_STORAGE_KEY,
  SOURCE_ID_GETTERS,
  addWatch,
  belongsToMunicipio,
  createAreaWatch,
  foldName,
  formatWatchEvent,
  loadWatches,
  normalizeIbge,
  removeWatch,
  sameIbge,
  saveWatches,
} from './areaWatch.js';

const fire = (lat, lon, municipality, acqTime = '1432') => ({
  lat, lon, municipality, acqDate: '2026-09-13', acqTime, satellite: 'N20',
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    data,
  };
}

test('foldName is accent- and punctuation-insensitive (ã, ç, é)', () => {
  assert.equal(foldName('  São João do Ivaí '), 'sao joao do ivai');
  assert.equal(foldName("Pérola d'Oeste"), foldName('PEROLA D OESTE'));
  assert.equal(foldName('Foz do Iguaçu'), 'foz do iguacu');
  assert.equal(foldName(null), '');
});

test('normalizeIbge and sameIbge tolerate numbers and the 6-digit form', () => {
  assert.equal(normalizeIbge(4109401), '4109401');
  assert.equal(normalizeIbge('abc'), '');
  assert.ok(sameIbge('4109401', 410940));
  assert.ok(!sameIbge('4109401', '4106902'));
  assert.ok(!sameIbge('', ''));
});

test('belongsToMunicipio matches by ibge_code, by name and by affected_municipalities', () => {
  const inGuarapuava = belongsToMunicipio({ ibge: '4109401', nome: 'Guarapuava' });
  assert.ok(inGuarapuava({ ibge_code: '4109401', municipality: 'x' }));
  assert.ok(!inGuarapuava({ ibge_code: '4106902', municipality: 'Guarapuava' }), 'code wins over name');
  assert.ok(inGuarapuava({ municipality: 'GUARAPUAVA' }));
  assert.ok(inGuarapuava({ ibge_code: null, municipality: 'guarapuava' }));
  assert.ok(inGuarapuava({ affected_municipalities: [{ ibge_code: '4106902' }, { ibge_code: 4109401 }] }));
  assert.ok(!inGuarapuava({ affected_municipalities: [{ ibge_code: '4106902' }] }));
  assert.ok(inGuarapuava({ affected_municipalities: ['Guarapuava'] }));
  assert.ok(!inGuarapuava(null));

  const sjp = belongsToMunicipio({ ibge: '4125506', nome: 'São José dos Pinhais' });
  assert.ok(sjp({ municipality: 'Sao Jose dos Pinhais' }));
});

test('first sweep per source is a silent baseline, later sweeps report entered/exited', () => {
  const watch = createAreaWatch({ areaId: '4109401', label: 'Guarapuava', matchers: { ibge: '4109401', nome: 'Guarapuava' } });
  const a = fire(-25.39, -51.46, 'Guarapuava', '1200');
  const b = fire(-25.40, -51.47, 'Guarapuava', '1300');
  const other = fire(-25.43, -49.27, 'Curitiba');

  const first = watch.sweep([a, other], { source: 'fires' });
  assert.deepEqual(first.entered, []);
  assert.equal(first.baseline, true);
  assert.equal(first.count, 1);

  // Refresh returns fresh objects with the same content: ids must be stable.
  const second = watch.sweep([{ ...a }, { ...b }, other], { source: 'fires' });
  assert.equal(second.baseline, false);
  assert.equal(second.entered.length, 1);
  assert.equal(second.entered[0].acqTime, '1300');
  assert.deepEqual(second.exited, []);

  const third = watch.sweep([b], { source: 'fires' });
  assert.equal(third.entered.length, 0);
  assert.equal(third.exited.length, 1);
  assert.equal(watch.count('fires'), 1);
});

test('baselines are independent per source', () => {
  const watch = createAreaWatch({ matchers: { ibge: '4106902', nome: 'Curitiba' } });
  watch.sweep([fire(-25.4, -49.2, 'Curitiba')], { source: 'fires' });
  const cem = watch.sweep([{ alert_code: 'X1', ibge_code: '4106902' }], { source: 'cemaden' });
  assert.deepEqual(cem.entered, [], 'cemaden baseline is silent even after fires already swept');
  const cem2 = watch.sweep(
    [{ alert_code: 'X1', ibge_code: '4106902' }, { alert_code: 'X2', ibge_code: '4106902' }],
    { source: 'cemaden' },
  );
  assert.equal(cem2.entered.length, 1);
});

test('sweep honors custom getId/belongsToArea, dedupes ids and does not mutate input', () => {
  const watch = createAreaWatch({ areaId: 'x' });
  const items = Object.freeze([Object.freeze({ k: 1 }), Object.freeze({ k: 1 }), Object.freeze({ k: 2 })]);
  const opts = { source: 'custom', getId: (i) => i.k, belongsToArea: () => true };
  assert.equal(watch.sweep(items, opts).count, 2);
  assert.throws(() => watch.sweep([], { source: 'nope' }), /getId/);
});

test('incident ids are stable and use affected_municipalities', () => {
  const watch = createAreaWatch({ matchers: { ibge: '4113700', nome: 'Londrina' } });
  const inc = { id: 7, title: 'Enchente', affected_municipalities: [{ ibge_code: '4113700' }] };
  watch.sweep([inc], { source: 'incidents' });
  const r = watch.sweep([{ ...inc }, { id: 8, affected_municipalities: [{ ibge_code: '4113700' }] }], { source: 'incidents' });
  assert.equal(r.entered.length, 1);
  assert.equal(SOURCE_ID_GETTERS.incidents(inc), 'id:7');
});

test('formatWatchEvent writes pt-BR sentences with pluralization', () => {
  const at = new Date('2026-09-13T17:32:00Z'); // 14:32 BRT
  assert.equal(formatWatchEvent({ source: 'fires', count: 2, nome: 'Guarapuava', at }), '+2 focos em Guarapuava 14:32');
  assert.equal(formatWatchEvent({ source: 'fires', count: 1, nome: 'Guarapuava', at }), '+1 foco em Guarapuava 14:32');
  assert.equal(
    formatWatchEvent({ source: 'cemaden', kind: 'exited', count: 1, nome: 'União da Vitória', at }),
    '-1 alerta CEMADEN encerrado em União da Vitória 14:32',
  );
  assert.equal(formatWatchEvent({ source: 'incidents', count: 3, nome: 'Maringá', at }), '+3 incidentes em Maringá 14:32');
});

test('addWatch/removeWatch are immutable, dedupe and cap at MAX_WATCHES', () => {
  const empty = [];
  const r1 = addWatch(empty, { ibge: '4109401', nome: 'Guarapuava' }, 1);
  assert.equal(r1.added, true);
  assert.equal(empty.length, 0);
  assert.equal(addWatch(r1.list, { ibge: '4109401', nome: 'Guarapuava' }).reason, 'exists');
  assert.equal(addWatch(r1.list, { ibge: '12', nome: 'x' }).reason, 'invalid');

  let list = [];
  for (let i = 0; i < MAX_WATCHES; i += 1) list = addWatch(list, { ibge: String(4100000 + i), nome: `M${i}` }).list;
  assert.equal(list.length, MAX_WATCHES);
  assert.equal(addWatch(list, { ibge: '4199999', nome: 'Extra' }).reason, 'limit');
  const removed = removeWatch(list, 4100000);
  assert.equal(removed.length, MAX_WATCHES - 1);
  assert.equal(list.length, MAX_WATCHES);
});

test('loadWatches/saveWatches round-trip and never throw', () => {
  const storage = memoryStorage();
  assert.equal(saveWatches([{ ibge: '4125506', nome: 'São José dos Pinhais', addedAt: 5 }], storage), true);
  assert.deepEqual(loadWatches(storage), [{ ibge: '4125506', nome: 'São José dos Pinhais', addedAt: 5 }]);
  assert.ok(storage.data.get(WATCH_STORAGE_KEY).includes('São José'), 'UTF-8 accents preserved');

  assert.deepEqual(loadWatches(memoryStorage({ [WATCH_STORAGE_KEY]: '{not json' })), []);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadWatches(throwing), []);
  assert.equal(saveWatches([], throwing), false);
  assert.equal(saveWatches([], null), false);

  const big = Array.from({ length: 15 }, (_, i) => ({ ibge: String(4100000 + i), nome: `M${i}` }));
  assert.equal(loadWatches(memoryStorage({ [WATCH_STORAGE_KEY]: JSON.stringify(big) })).length, MAX_WATCHES);
});
