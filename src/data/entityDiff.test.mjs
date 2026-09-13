import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  diffById,
  sameGraphicValue,
  graphicsPatchKeys,
  patchEntity,
  applyIdRefresh,
  createCachedFactory,
  createReadyPump,
} from './entityDiff.js';

const byId = (row) => row.id;

test('diffById splits add, update and remove by stable id', () => {
  const plan = diffById(new Set(['a', 'b', 'c']), [{ id: 'b' }, { id: 'c' }, { id: 'd' }], byId);
  assert.deepEqual(plan.add.map((e) => e.id), ['d']);
  assert.deepEqual(plan.update.map((e) => e.id), ['b', 'c']);
  assert.deepEqual(plan.remove, ['a']);
  assert.deepEqual([...plan.nextIds], ['b', 'c', 'd']);
  assert.equal(plan.missingIds, 0);
  assert.equal(plan.duplicates, 0);
});

test('diffById from empty marks everything new, to empty removes everything', () => {
  const first = diffById(new Set(), [{ id: 1 }, { id: 2 }], byId);
  assert.deepEqual(first.add.map((e) => e.id), ['1', '2'], 'numeric ids are normalized to strings');
  assert.equal(first.update.length, 0);
  const last = diffById(['1', '2'], [], byId);
  assert.deepEqual(last.remove, ['1', '2']);
  assert.equal(last.add.length + last.update.length, 0);
});

test('diffById reports missing ids and keeps the first of duplicated ids', () => {
  const plan = diffById(null, [{ id: 'x', v: 1 }, { id: 'x', v: 2 }, { id: null }, { id: '' }, {}], byId);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.add[0].item.v, 1);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.missingIds, 3);
});

test('diffById keeps unicode ids intact (acentos)', () => {
  const plan = diffById(new Set(['São José']), [{ id: 'São José' }, { id: 'Maringá' }], byId);
  assert.deepEqual(plan.update.map((e) => e.id), ['São José']);
  assert.deepEqual(plan.add.map((e) => e.id), ['Maringá']);
});

test('diffById requires a getId function', () => {
  assert.throws(() => diffById(new Set(), [], null), TypeError);
});

test('sameGraphicValue compares primitives, equals() values and constant properties', () => {
  const constant = (value) => ({ isConstant: true, getValue: () => value });
  assert.equal(sameGraphicValue(constant(7), 7), true);
  assert.equal(sameGraphicValue(constant(7), 8), false);
  assert.equal(sameGraphicValue(undefined, undefined), true);
  assert.equal(sameGraphicValue(undefined, 1), false);
  assert.equal(sameGraphicValue(constant(1), undefined), false);
  const vec = (x) => ({ x, equals: (o) => o?.x === x });
  assert.equal(sameGraphicValue(constant(vec(1)), vec(1)), true);
  assert.equal(sameGraphicValue(constant(vec(1)), vec(2)), false);
  assert.equal(sameGraphicValue({ isConstant: false, getValue: () => 1 }, 1), false, 'time-varying is never equal');
  const material = { getValue: () => ({}), equals: (o) => o?.tag === 'same' };
  assert.equal(sameGraphicValue(material, { getValue: () => ({}), tag: 'same' }), true);
  assert.equal(sameGraphicValue({ isConstant: true, getValue: () => { throw new Error('x'); } }, 1), false);
});

test('graphicsPatchKeys lists only changed fields', () => {
  const constant = (value) => ({ isConstant: true, getValue: () => value });
  const graphics = { pixelSize: constant(7), text: constant('Curitiba\n21.0°C') };
  assert.deepEqual(graphicsPatchKeys(graphics, { pixelSize: 7, text: 'Curitiba\n22.5°C' }), ['text']);
  assert.deepEqual(graphicsPatchKeys(graphics, null), []);
});

test('patchEntity with real Cesium entities touches only what changed', () => {
  const time = Cesium.JulianDate.now();
  const collection = new Cesium.EntityCollection();
  const options = (temp, color) => ({
    id: 'datageo-clima:A807',
    position: Cesium.Cartesian3.fromDegrees(-49.27, -25.43),
    point: { pixelSize: 7, color: color.withAlpha(0.9) },
    label: {
      text: `Curitiba\n${temp.toFixed(1)}°C`,
      pixelOffset: new Cesium.Cartesian2(0, -14),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 250_000),
    },
    ellipse: {
      semiMajorAxis: 9000,
      semiMinorAxis: 9000,
      material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
    },
    properties: { municipality: 'Curitiba', temperature: temp },
  });

  const entity = collection.add(options(21, Cesium.Color.LIME));
  let events = 0;
  entity.definitionChanged.addEventListener(() => { events += 1; });
  const labelProperty = entity.label.text;
  const ellipse = entity.ellipse;
  let ellipseEvents = 0;
  ellipse.definitionChanged.addEventListener(() => { ellipseEvents += 1; });

  assert.equal(patchEntity(entity, options(21, Cesium.Color.LIME), time), 0, 'identical snapshot is a no-op');
  assert.equal(events, 0);
  assert.equal(entity.label.text, labelProperty, 'unchanged label keeps its property');

  const changes = patchEntity(entity, options(22.5, Cesium.Color.LIME), time);
  assert.equal(changes, 2, 'label text + temperature property');
  assert.equal(entity.label.text.getValue(time), 'Curitiba\n22.5°C');
  assert.equal(entity.properties.temperature.getValue(time), 22.5);
  assert.equal(entity.properties.municipality.getValue(time), 'Curitiba');
  assert.equal(ellipseEvents, 0, 'clamped ellipse is not redefined when its values are equal');
  assert.equal(entity.ellipse, ellipse, 'graphics object is patched in place');

  patchEntity(entity, options(22.5, Cesium.Color.RED), time);
  assert.ok(entity.point.color.getValue(time).equals(Cesium.Color.RED.withAlpha(0.9)));
  assert.equal(ellipseEvents, 1, 'material change redefines the ellipse once');

  const withoutLabel = { ...options(22.5, Cesium.Color.RED), label: undefined };
  patchEntity(entity, withoutLabel, time);
  assert.equal(entity.label, undefined, 'label removed when the row stops being emphasized');
});

test('applyIdRefresh diffs a real EntityCollection and reports new ids', () => {
  const time = Cesium.JulianDate.now();
  const collection = new Cesium.EntityCollection();
  const entityById = new Map();
  const row = (id, text) => ({
    id,
    position: Cesium.Cartesian3.fromDegrees(-51, -24),
    point: { pixelSize: 4 },
    label: { text },
  });

  const first = applyIdRefresh({
    collection, entityById, nextOptions: [row('a', 'A'), row('b', 'B')], time,
  });
  assert.equal(first.mode, 'diff');
  assert.deepEqual([...first.newIds], ['a', 'b']);
  const entityA = collection.getById('a');

  const second = applyIdRefresh({
    collection, entityById, nextOptions: [row('a', 'A2'), row('c', 'C')], time,
  });
  assert.deepEqual([...second.newIds], ['c']);
  assert.equal(second.removed, 1);
  assert.equal(second.updated, 1);
  assert.equal(second.count, 2);
  assert.equal(collection.getById('a'), entityA, 'surviving entity is the same object');
  assert.equal(collection.getById('b'), undefined);
  assert.equal(collection.values.length, 2);
  assert.equal(entityA.label.text.getValue(time), 'A2');
});

test('applyIdRefresh falls back to a full rebuild when ids are missing', () => {
  const collection = new Cesium.EntityCollection();
  const entityById = new Map();
  applyIdRefresh({ collection, entityById, nextOptions: [{ id: 'a', point: { pixelSize: 1 } }] });
  const result = applyIdRefresh({
    collection,
    entityById,
    nextOptions: [{ point: { pixelSize: 1 } }, { id: 'z', point: { pixelSize: 2 } }],
  });
  assert.equal(result.mode, 'rebuild');
  assert.equal(result.newIds.size, 0);
  assert.equal(collection.values.length, 2);
  assert.equal(collection.getById('a'), undefined);
  assert.ok(entityById.has('z'));
});

test('createCachedFactory returns the same instance per key', () => {
  let created = 0;
  const color = createCachedFactory((css, alpha) => {
    created += 1;
    return Cesium.Color.fromCssColorString(css).withAlpha(alpha);
  });
  const a = color('#a3e635', 0.9);
  const b = color('#a3e635', 0.9);
  const c = color('#a3e635', 0.5);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(created, 2);
  assert.equal(color.size(), 2);
});

test('createReadyPump requests frames until ready, then stops', () => {
  let ready = false;
  let renders = 0;
  let readyCalls = 0;
  let tickFn = null;
  let cleared = false;
  const pump = createReadyPump({
    isReady: () => ready,
    requestRender: () => { renders += 1; },
    onReady: () => { readyCalls += 1; },
    setIntervalFn: (fn) => { tickFn = fn; return 1; },
    clearIntervalFn: () => { cleared = true; },
  });
  pump.start();
  assert.equal(pump.isRunning(), true);
  assert.equal(renders, 1, 'first frame is requested immediately');
  tickFn();
  assert.equal(renders, 2);
  ready = true;
  tickFn();
  assert.equal(pump.isRunning(), false);
  assert.equal(cleared, true);
  assert.equal(readyCalls, 1);
  assert.equal(renders, 3, 'one settling frame after ready');
});

test('createReadyPump gives up after the timeout', () => {
  let clock = 0;
  let tickFn = null;
  const pump = createReadyPump({
    isReady: () => false,
    requestRender: () => {},
    timeoutMs: 1000,
    now: () => clock,
    setIntervalFn: (fn) => { tickFn = fn; return 1; },
    clearIntervalFn: () => {},
  });
  pump.start();
  clock = 1500;
  tickFn();
  assert.equal(pump.isRunning(), false);
});
